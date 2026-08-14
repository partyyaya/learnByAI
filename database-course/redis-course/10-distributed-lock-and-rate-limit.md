# 第 10 章：分散式鎖與限流

> 分散式鎖是 Redis 最多人用、也最多人用錯的功能。`SET key value NX EX 30` 這一行看起來就是全部了，但它在生產環境至少有五個失效點，其中兩個**沒有任何辦法用 Redis 本身修好**。
> 更麻煩的是，鎖失效通常不會報錯。它只是安靜地讓兩個程序同時進入臨界區，然後你在對帳時發現庫存少了 3 件、或某個使用者被扣了兩次款——而日誌裡什麼異常都沒有。
> 這章要做兩件事：把鎖從 `SETNX` 一路推到生產可用的版本，並且**誠實說清楚它修不好的地方**；然後實作四種限流演算法，講清楚各自的邊界效應與適用場景。

---

## 10.1 學習目標

完成本章後，你應該可以：

- 說明分散式鎖要解決什麼問題，以及單機鎖為什麼不夠。
- 從 `SETNX` 推導到生產可用的鎖，並說出每一次演進修掉了什麼失效點。
- 說明為什麼釋放鎖必須用 Lua，以及不用會發生什麼。
- 實作看門狗續期，並說明它的代價。
- 用 Hash + Lua 實作可重入鎖。
- 說出分散式鎖在主從切換與 GC 停頓下的失效邊界，以及 fencing token 的作用。
- 說明 Redlock 的演算法、Kleppmann 的批評與 antirez 的回應，並形成自己的判斷。
- 判斷什麼時候該用分散式鎖、什麼時候該用資料庫的唯一約束或樂觀鎖。
- 實作固定窗口、滑動窗口、令牌桶、漏桶四種限流器，並說出各自的邊界效應。
- 處理限流在 Cluster、時鐘偏移、Redis 故障下的實務問題。

---

## 10.2 分散式鎖要解決什麼問題

單機的鎖（`synchronized`、`Mutex`、`threading.Lock`）只在**同一個程序內**有效。一旦你的服務跑了三個實例：

```text
      ┌─────────┐  ┌─────────┐  ┌─────────┐
      │ 服務 A   │  │ 服務 B   │  │ 服務 C   │
      │ Mutex   │  │ Mutex   │  │ Mutex   │   三個各自獨立的鎖
      └────┬────┘  └────┬────┘  └────┬────┘   互相看不見
           └────────────┼────────────┘
                        ▼
                  同一筆訂單 / 同一個庫存
```

三個實例各自持有自己的 Mutex，同時進入臨界區，單機鎖完全沒有作用。

需要跨程序協調時，你需要一個**所有實例都看得見的共享狀態**——這正是第 00 章講的「Redis 是共享記憶體」的直接應用。

### 典型場景

| 場景 | 不加鎖會怎樣 |
|------|------------|
| 定時任務多實例部署 | 每台都跑一次，發了三封相同的帳單郵件 |
| 訂單狀態流轉 | 支付回調與超時取消同時執行，訂單變成「已取消但已付款」 |
| 庫存扣減 | 超賣 |
| 快取重建 | 擊穿（第 09 章的 `loadWithLock`） |
| 帳戶餘額變更 | 兩次提現同時通過餘額檢查 |

**但先講一個重要的前提**：上表中有些場景其實**不該用分散式鎖**——庫存扣減用 Lua 原子操作更好，訂單狀態流轉用資料庫的樂觀鎖更可靠。10.8 節會回來處理這個判斷。先把鎖本身講清楚。

---

## 10.3 鎖的五次演進

### v1：`SETNX`（有死鎖風險）

```bash
SETNX lock:order:8888 1
# (integer) 1   <- 拿到鎖
# (integer) 0   <- 沒拿到

# 用完刪除
DEL lock:order:8888
```

**失效點：持有鎖的程序崩潰、被 OOM kill、或機器斷電，`DEL` 永遠不會執行。這個鎖會永久存在，該資源再也沒人能處理。**

這不是理論風險。部署重啟、容器被驅逐、程式拋出未捕獲的例外，都會造成同樣結果。

### v2：`SETNX` + `EXPIRE`（非原子）

既然崩潰會死鎖，那加個過期時間：

```bash
SETNX lock:order:8888 1
EXPIRE lock:order:8888 30
```

**失效點：這是兩個命令。** 如果程序在 `SETNX` 成功後、`EXPIRE` 執行前崩潰，鎖就沒有過期時間——回到 v1 的死鎖。

視窗很短，但在高頻場景下一定會發生。「機率低」不等於「不會發生」，而且這種 bug 一年出現一次、每次都查不出原因，是最消耗人的。

### v3：`SET ... NX EX`（原子，但會誤刪別人的鎖）

Redis 2.6.12 起，`SET` 支援把兩件事合成一個原子命令：

```bash
SET lock:order:8888 1 NX EX 30
# OK    <- 拿到鎖
# (nil) <- 沒拿到
```

這解決了原子性，但引入了新問題：

```text
時間 →
程序 A：拿到鎖(TTL 30s) ── 業務執行 35 秒（比預期久）──> DEL 鎖
                                    ▲                      ▲
                            30 秒時鎖自動過期        刪掉的是 B 的鎖！
程序 B：                            拿到鎖 ─── 業務執行中 ───> 臨界區被闖入
```

A 的業務跑太久，鎖已經自動過期並被 B 拿走。A 完成後執行 `DEL`，**刪掉的是 B 正在持有的鎖**。接著 C 又能拿到鎖，於是 B 和 C 同時在臨界區。

### v4：唯一 value + Lua 釋放

要避免誤刪，鎖的 value 必須能識別持有者：

```bash
SET lock:order:8888 "uuid-abc-123" NX EX 30
```

釋放時先比對再刪：

```bash
# 錯誤做法：這是兩個命令，不是原子的
GET lock:order:8888          # 確認是自己的
DEL lock:order:8888          # 刪掉
```

**為什麼分兩步不行？** 因為在 `GET` 和 `DEL` 之間，鎖可能剛好過期並被別人拿走：

```text
程序 A：GET(是我的 uuid-abc) ─────────────> DEL（刪掉了 B 的鎖）
                              ▲
                        鎖在這一刻過期，B 拿到鎖
```

視窗只有微秒級，但這是**必然會發生**的競爭條件，不是「機率很低」。

必須用 Lua 讓「比對 + 刪除」變成一個原子操作（第 07 章）：

```lua
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
```

```bash
redis-cli -a mysecret EVAL "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end" 1 lock:order:8888 "uuid-abc-123"
```

### v5：看門狗續期（處理業務比 TTL 久）

v4 解決了誤刪，但沒解決根本問題：**業務執行時間可能超過 TTL，鎖提前被別人拿走。**

兩個直覺但錯誤的做法：

- **把 TTL 設很長（例如 5 分鐘）**：那麼程序崩潰時，這個資源要卡 5 分鐘沒人能處理。
- **TTL 設成業務最長耗時**：你根本不知道最長是多少，而且一次網路抖動就會超過。

正解是**自動續期**：起一個背景計時器，只要業務還在跑，就定期把 TTL 延長。這就是 Redisson 的「看門狗（watchdog）」。

續期同樣必須驗證持有者，否則會延長別人的鎖：

```lua
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("EXPIRE", KEYS[1], ARGV[2])
else
  return 0
end
```

續期間隔的慣例是 **TTL / 3**（Redisson 用 TTL 30 秒、每 10 秒續一次）。留兩次重試的餘裕，一次續期失敗還有機會補上。

### 五次演進總結

| 版本 | 做法 | 修掉的問題 | 剩下的問題 |
|------|------|-----------|-----------|
| v1 | `SETNX` | — | 崩潰即死鎖 |
| v2 | `SETNX` + `EXPIRE` | 死鎖 | 兩命令間崩潰仍死鎖 |
| v3 | `SET NX EX` | 原子性 | 誤刪別人的鎖 |
| v4 | 唯一 value + Lua 釋放 | 誤刪 | 業務超時鎖被搶走 |
| v5 | + 看門狗續期 | 業務超時 | **主從切換、GC 停頓**（10.6 節） |

v5 是「單 Redis 節點下能做到的最好版本」。剩下的兩個問題需要不同層次的解法。

---

## 10.4 生產可用的實作

把 v5 完整寫出來：

```javascript
const crypto = require('crypto');

const ACQUIRE_SCRIPT = `
if redis.call("SET", KEYS[1], ARGV[1], "NX", "PX", ARGV[2]) then
  return 1
else
  return 0
end`;

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end`;

const RENEW_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
else
  return 0
end`;

class RedisLock {
  /**
   * @param {string} key       鎖的 key
   * @param {number} ttlMs     鎖的存活時間
   * @param {boolean} autoRenew 是否啟用看門狗
   */
  constructor(redis, key, { ttlMs = 30000, autoRenew = true } = {}) {
    this.redis = redis;
    this.key = `lock:${key}`;
    this.ttlMs = ttlMs;
    this.autoRenew = autoRenew;
    this.value = crypto.randomUUID();
    this.renewTimer = null;
    this.held = false;
  }

  /**
   * 嘗試取得鎖
   * @param {number} waitMs 最多等多久（0 表示不等，拿不到就回 false）
   */
  async acquire(waitMs = 0) {
    const deadline = Date.now() + waitMs;

    do {
      const ok = await this.redis.eval(
        ACQUIRE_SCRIPT, 1, this.key, this.value, String(this.ttlMs));

      if (ok === 1) {
        this.held = true;
        if (this.autoRenew) this._startRenew();
        return true;
      }

      if (waitMs === 0) return false;
      // 隨機退避，避免所有等待者同時重試造成驚群
      await sleep(30 + Math.floor(Math.random() * 50));
    } while (Date.now() < deadline);

    return false;
  }

  async release() {
    this._stopRenew();
    if (!this.held) return false;
    this.held = false;

    const result = await this.redis.eval(
      RELEASE_SCRIPT, 1, this.key, this.value);

    if (result === 0) {
      // 鎖已經不是自己的了 —— 代表業務執行期間鎖曾經失效
      // 這是嚴重訊號，必須告警，因為臨界區可能已被其他程序進入
      logger.error({ key: this.key }, 'lock was lost before release');
    }
    return result === 1;
  }

  _startRenew() {
    const interval = Math.floor(this.ttlMs / 3);
    this.renewTimer = setInterval(async () => {
      try {
        const ok = await this.redis.eval(
          RENEW_SCRIPT, 1, this.key, this.value, String(this.ttlMs));
        if (ok === 0) {
          // 續期失敗代表鎖已經不是自己的，立刻停止續期並告警
          logger.error({ key: this.key }, 'renew failed, lock lost');
          this._stopRenew();
          this.held = false;
        }
      } catch (err) {
        logger.warn({ key: this.key, err }, 'renew error');
        // 網路錯誤不立刻放棄，下一次還會再試
      }
    }, interval);

    // Node.js：避免這個計時器讓程序無法正常結束
    if (this.renewTimer.unref) this.renewTimer.unref();
  }

  _stopRenew() {
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// 建議都用這個包裝，確保一定會釋放
async function withLock(redis, key, fn, opts = {}) {
  const lock = new RedisLock(redis, key, opts);
  const got = await lock.acquire(opts.waitMs ?? 0);
  if (!got) {
    throw new LockAcquireError(`failed to acquire lock: ${key}`);
  }
  try {
    return await fn(lock);
  } finally {
    await lock.release();   // 無論成功失敗都釋放
  }
}
```

使用：

```javascript
await withLock(redis, `order:${orderId}`, async () => {
  const order = await db.getOrder(orderId);
  if (order.status !== 'pending') return;
  await db.updateOrder(orderId, { status: 'paid' });
}, { ttlMs: 30000, waitMs: 3000 });
```

四個實作要點：

**用 `PX`（毫秒）而不是 `EX`（秒）。** 秒級精度在鎖這種場景太粗，而且續期間隔算起來會有捨入誤差。

**釋放失敗要告警，不要靜默忽略。** `release` 回傳 0 代表「這個鎖在你持有期間曾經失效」，意味著臨界區可能已經被別人進入過。這是排查資料異常時最重要的線索，一定要記錄。

**續期失敗要立刻停止並標記失去鎖。** 繼續執行業務邏輯是危險的，理想上應該讓業務中止。實務上很難真的中斷，所以至少要讓後續的寫入操作能檢查 `lock.held`。

**`withLock` 的 `finally` 不能省。** 業務拋錯時如果不釋放鎖，就要等 TTL 到期，這段時間該資源會被阻塞。

---

## 10.5 可重入鎖

問題：同一個執行緒/請求在持有鎖的情況下，又進入了另一段需要同一把鎖的程式碼。

```javascript
async function processOrder(id) {
  await withLock(redis, `order:${id}`, async () => {
    await updateStatus(id);      // 這裡面又要拿同一把鎖 -> 卡死
  });
}

async function updateStatus(id) {
  await withLock(redis, `order:${id}`, async () => { /* ... */ });
}
```

第二次 `acquire` 拿不到鎖，而第一次的鎖要等這段執行完才釋放——**自己把自己鎖死了**。

解法是記錄「持有者 + 重入次數」，用 Hash 儲存：

```lua
-- 加鎖：如果沒人持有，或持有者就是自己，計數 +1
if redis.call('EXISTS', KEYS[1]) == 0 or redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then
  redis.call('HINCRBY', KEYS[1], ARGV[1], 1)
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0
```

```lua
-- 解鎖：計數 -1，減到 0 才真的刪除
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 then
  return nil                                    -- 不是自己的鎖
end
local counter = redis.call('HINCRBY', KEYS[1], ARGV[1], -1)
if counter > 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])       -- 還有外層持有，續命
  return 0
else
  redis.call('DEL', KEYS[1])                    -- 完全釋放
  return 1
end
```

```javascript
const REENTRANT_ACQUIRE = `
if redis.call('EXISTS', KEYS[1]) == 0 or redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then
  redis.call('HINCRBY', KEYS[1], ARGV[1], 1)
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0`;

const REENTRANT_RELEASE = `
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 then return -1 end
local counter = redis.call('HINCRBY', KEYS[1], ARGV[1], -1)
if counter > 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 0
end
redis.call('DEL', KEYS[1])
return 1`;
```

**關鍵是「持有者標識」要怎麼定。** 在 Java 裡是 `UUID + 執行緒 ID`；在 Node.js 這種單執行緒非同步的環境裡，要用**請求層級的唯一 ID**（例如從 AsyncLocalStorage 取得的 trace id），不能用程序 ID——同一個程序內的兩個併發請求會誤判成同一個持有者，那就完全失去互斥效果了。

```javascript
const { AsyncLocalStorage } = require('async_hooks');
const requestContext = new AsyncLocalStorage();

function currentHolderId() {
  const ctx = requestContext.getStore();
  if (!ctx) throw new Error('no request context; cannot use reentrant lock');
  return ctx.traceId;   // 每個請求一個，同一請求內的巢狀呼叫共用
}
```

實務建議：**可重入鎖不是必需品。** 更好的做法通常是重構程式碼，讓加鎖只發生在最外層（把 `updateStatus` 拆成「需要鎖的版本」和「假設已持有鎖的版本」）。可重入會讓鎖的持有範圍變得難以推理。

---

## 10.6 鎖的失效邊界：兩個修不好的問題

前面五次演進都是在單一 Redis 節點的假設下。現在把假設放寬到真實的生產環境。

### 失效點 1：主從切換會丟鎖

Redis 的主從複製是**非同步**的（第 11 章詳談）。這意味著：

```text
1. 程序 A 在 master 上成功取得鎖
2. master 還沒把這個寫入同步給 replica 就掛了
3. Sentinel 把 replica 提升為新 master
4. 新 master 上「沒有這把鎖」
5. 程序 B 來取鎖 —— 成功
6. A 和 B 同時持有鎖，同時在臨界區
```

**這個問題無法用「寫更好的 Lua」解決**，它是架構層面的：非同步複製 + 故障轉移，必然存在已確認寫入遺失的可能。

把複製改成同步（`WAIT` 命令）可以降低機率，但代價是每次加鎖都要等複製確認，效能大幅下降，而且 `WAIT` 也不保證絕對——它只保證「有 N 個 replica 收到了」，不保證持久化。

### 失效點 2：GC 停頓 / 程序暫停

即使 Redis 只有一個節點、絕不故障，仍然有這個問題：

```text
時間 →
程序 A：取得鎖(TTL 30s) ─> [ Full GC 停頓 40 秒 ] ─> 繼續執行，寫入資料
                                    ▲                        ▲
                          30 秒時鎖過期，B 取得鎖      A 以為自己還持有鎖
程序 B：                            取得鎖 ─> 寫入資料
```

A 在 GC 停頓期間完全不知道自己的鎖已經過期了。醒來之後它會繼續執行，**以為自己還在臨界區裡**。看門狗也救不了——看門狗的計時器同樣被 GC 停住了。

造成長停頓的原因不只 GC：虛擬機遷移、CPU 資源被壓縮（K8s 的 CPU throttling）、缺頁中斷、SSD 的寫入延遲尖峰、甚至一次很長的網路超時，都會有相同效果。

### fencing token：唯一真正的解法

Martin Kleppmann 提出的解法是：鎖不只回傳「你拿到了」，還回傳一個**單調遞增的 token**，下游的資源負責拒絕舊 token。

```text
程序 A 取得鎖 -> token = 33
程序 A GC 停頓...
程序 B 取得鎖 -> token = 34
程序 B 寫入儲存，附帶 token 34 -> 儲存記下 last_token = 34
程序 A 醒來，寫入儲存，附帶 token 33 -> 儲存看到 33 < 34，拒絕！
```

在 Redis 上實作 token 很簡單：

```lua
-- 取鎖並取得遞增 token
if redis.call("SET", KEYS[1], ARGV[1], "NX", "PX", ARGV[2]) then
  return redis.call("INCR", KEYS[2])    -- KEYS[2] 是 token 計數器
else
  return -1
end
```

```javascript
const ACQUIRE_WITH_TOKEN = `
if redis.call("SET", KEYS[1], ARGV[1], "NX", "PX", ARGV[2]) then
  return redis.call("INCR", KEYS[2])
else
  return -1
end`;

async function acquireWithToken(redis, key, value, ttlMs) {
  const token = await redis.eval(ACQUIRE_WITH_TOKEN, 2,
    `lock:${key}`, `lock:token:${key}`, value, String(ttlMs));
  return token === -1 ? null : token;
}
```

**但真正的難點不在 Redis 這一側，在下游。** 你的資料庫、檔案系統、外部 API 必須支援「檢查並拒絕舊 token」。實務上這通常意味著：

```sql
-- 資料庫層面用條件更新實現 fencing
UPDATE orders
SET status = 'paid', fence_token = $1
WHERE id = $2 AND (fence_token IS NULL OR fence_token < $1);
-- 影響列數為 0 表示有更新的 token 已經寫過了，本次操作要放棄
```

看到這裡你可能會發現一件事：**如果資料庫已經能做這種條件更新，那它本身就提供了互斥，你還需要 Redis 鎖嗎？**

這正是下一節要處理的問題。

---

## 10.7 Redlock 與那場著名的爭論

### Redlock 演算法

antirez（Redis 作者）提出 Redlock 來解決「單點 Redis 掛掉導致鎖失效」的問題。它需要 **N 個互相獨立的 Redis master**（通常 N=5，注意是獨立的 master，不是主從）：

```text
1. 記錄目前時間 T1
2. 依序向 N 個節點請求鎖，每個請求都設一個很短的超時（例如 50ms）
3. 記錄目前時間 T2，計算耗時 = T2 - T1
4. 當且僅當：
     (a) 在超過半數（N/2 + 1）的節點上取得鎖
     (b) 且 耗時 < 鎖的 TTL
   才算取得鎖成功
5. 鎖的有效時間 = 原始 TTL - 耗時 - 時鐘漂移補償
6. 失敗的話，向「所有」節點發送釋放（包含那些以為沒拿到的，因為回應可能只是丟失了）
```

### Kleppmann 的批評

2016 年，分散式系統研究者 Martin Kleppmann 發表〈How to do distributed locking〉，核心論點是：

**論點 1：先分清楚你要的是「效率」還是「正確性」。**

```text
效率（efficiency）：加鎖只是為了避免重複做同一件工作
  -> 偶爾兩個程序同時做，結果只是浪費資源，沒有正確性問題
  -> 用最簡單的單節點 Redis 鎖就夠了，Redlock 是過度設計

正確性（correctness）：兩個程序同時進入會導致資料損毀
  -> 那麼 Redlock 也不夠，因為它依然無法防止 GC 停頓造成的問題
  -> 你需要 fencing token，或根本不該用這種鎖
```

**論點 2：Redlock 依賴系統時鐘，這是危險的假設。** 演算法用「經過的時間」來判斷鎖是否仍然有效，但 NTP 校時、閏秒、虛擬機遷移都可能讓時鐘跳躍。時鐘往前跳一大步，鎖就會被誤判為過期。

**論點 3：GC 停頓的問題 Redlock 完全沒有解決。** 無論有幾個節點，程序在停頓期間都不知道自己的鎖已經失效。

### antirez 的回應

antirez 隨後發文回應，主要幾點：

- Redlock 不假設時鐘完全準確，只假設**時鐘漂移的速率有上界**（這和多數分散式演算法的假設類似）。
- 關於 GC 停頓：任何基於租約（lease）的鎖都有這個問題，不是 Redlock 獨有；ZooKeeper 的 session 機制同樣會受長停頓影響。
- fencing token 的前提是「下游支援 token 檢查」，而多數實際系統不支援；在那些系統上，Redlock 提供的機率保證仍然是有價值的。

### 這場爭論該怎麼用

雙方其實沒有真正的分歧——他們在講不同的東西。可以這樣收斂：

```text
問題 1：兩個程序同時進入臨界區，會造成不可接受的後果嗎？

  不會（只是重複工作、浪費資源）
    -> 用單節點 Redis 鎖（10.4 節的 v5）就夠了
    -> Redlock 帶來的複雜度不值得

  會（資料會錯、錢會算錯）
    -> Redis 鎖（含 Redlock）都不足以保證正確性
    -> 必須在「真正儲存資料的地方」做互斥：
       資料庫唯一約束、樂觀鎖版本號、fencing token、
       或用 ZooKeeper/etcd 這類為一致性設計的系統
    -> Redis 鎖此時的角色降級為「減少無謂競爭的最佳化」，不是正確性保證
```

**實務上絕大多數場景屬於第一類。** 而屬於第二類的場景，正確做法通常不是把鎖做得更複雜，是換一個根本不需要鎖的設計——下一節就講這個。

至於 Redlock 本身：它需要 5 個獨立的 Redis 節點（成本高、維運複雜），而它換來的保證仍然不足以支撐正確性場景。**多數團隊的合理選擇是：不用 Redlock，用單節點鎖 + 資料庫層的最終保護。**

---

## 10.8 什麼時候不該用分散式鎖

這是本章最重要的一節。很多用鎖的場景，其實有更簡單也更可靠的做法。

### 替代方案 1：資料庫唯一約束

需求：「同一個使用者不能重複建立訂單」。

```javascript
// 用鎖：有失效邊界，且要處理鎖的所有問題
await withLock(redis, `create-order:${userId}`, async () => {
  const exists = await db.findPendingOrder(userId);
  if (exists) throw new Error('duplicate');
  await db.createOrder(userId);
});
```

```sql
-- 用唯一約束：資料庫保證，不可能被繞過
CREATE UNIQUE INDEX idx_pending_order
  ON orders (user_id) WHERE status = 'pending';
```

```javascript
try {
  await db.createOrder(userId);
} catch (err) {
  if (err.code === '23505') {          // PostgreSQL unique_violation
    throw new DuplicateOrderError();
  }
  throw err;
}
```

**唯一約束是資料庫層的強保證，任何路徑（包含手動 SQL）都繞不過。** 而鎖只保護「走了加鎖那段程式碼」的路徑。

### 替代方案 2：樂觀鎖（版本號 / CAS）

需求：「訂單狀態流轉不能被併發破壞」。

```sql
-- 條件更新：只有狀態符合預期時才更新
UPDATE orders
SET status = 'paid', version = version + 1
WHERE id = $1 AND status = 'pending' AND version = $2;
```

```javascript
const result = await db.query(sql, [orderId, expectedVersion]);
if (result.rowCount === 0) {
  // 狀態已被別人改過，本次操作放棄或重試
  throw new ConcurrentModificationError();
}
```

沒有鎖、沒有等待、沒有失效邊界。適合衝突機率低的場景（絕大多數業務都是）。

### 替代方案 3：Redis 原子操作（Lua）

需求：「秒殺庫存扣減，不能超賣」。

用鎖是常見但錯誤的直覺——它會讓所有請求排隊，吞吐量崩潰。正確做法是把整段邏輯做成一個原子操作（第 07 章）：

```lua
-- KEYS[1] = 庫存 key, KEYS[2] = 已購買使用者 Set
-- ARGV[1] = userId, ARGV[2] = 購買數量
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1 then
  return -1                                    -- 重複購買
end
local stock = tonumber(redis.call('GET', KEYS[1]) or '0')
local qty = tonumber(ARGV[2])
if stock < qty then
  return -2                                    -- 庫存不足
end
redis.call('DECRBY', KEYS[1], qty)
redis.call('SADD', KEYS[2], ARGV[1])
return stock - qty                             -- 回傳剩餘庫存
```

**Redis 單執行緒 + Lua 原子執行，天然就是互斥的，完全不需要鎖。** 而且沒有等待、沒有 TTL、沒有續期，吞吐量比加鎖高一個數量級以上。

### 替代方案 4：讓任務天然單實例

需求：「定時任務不要多實例重複執行」。

用鎖可以做，但更好的做法通常是在**排程層**解決：

- K8s CronJob（`concurrencyPolicy: Forbid`）
- 帶分散式協調的排程框架（Quartz 叢集、XXL-JOB、Temporal）
- 依 shard key 分片，讓每個實例只處理自己那一份（例如 `id % 實例數 == 實例編號`）

分片的做法特別值得推薦：它不只避免重複，還讓任務**能水平擴展**。用鎖的話，永遠只有一個實例在做事，其他都在空等。

### 決策表

| 需求 | 建議做法 | 為什麼不用鎖 |
|------|---------|-------------|
| 避免重複建立 | 資料庫唯一約束 | 約束是強保證，繞不過 |
| 狀態流轉 | 樂觀鎖（條件更新） | 無等待、無失效邊界 |
| 計數 / 庫存扣減 | Redis Lua 原子操作 | 天然互斥，吞吐量高得多 |
| 定時任務去重 | 排程層或分片 | 分片還能水平擴展 |
| 快取重建收斂 | **Redis 鎖**（效率型） | 偶爾多重建一次沒關係 |
| 外部 API 的呼叫節流 | **Redis 鎖**（效率型） | 重複呼叫只是浪費配額 |
| 長時間的批次任務互斥 | **Redis 鎖 + 冪等設計** | 鎖降低衝突，冪等保證正確 |

**最後一列是實務上最健康的心態：把 Redis 鎖當成「減少衝突的最佳化」，同時讓業務邏輯本身是冪等的。** 這樣即使鎖失效，重複執行也不會造成損害。

---

## 10.9 限流：先分清楚四種演算法

限流（Rate Limiting）要回答的問題是：**在一段時間內，允許某個主體做多少次操作？**

四種主流演算法，差別在於「怎麼定義那段時間」：

```text
固定窗口  │████████│        │████████│        │
          0        60       120      180      （每 60 秒重置計數）

滑動窗口  │──────[████████████]──────────────│
          （視窗跟著現在的時間往前滑動）

令牌桶    桶裡持續以固定速率加令牌，來一個請求取一個
          → 桶滿了就不再加，所以允許「攢起來的突發」

漏桶      請求進入佇列，以固定速率流出
          → 輸出速率絕對均勻，不允許突發
```

| | 實作難度 | 記憶體 | 允許突發 | 邊界問題 | 典型用途 |
|---|---------|-------|---------|---------|---------|
| 固定窗口 | 最簡單 | 最省 | 是（邊界處雙倍） | **有** | 粗略防護 |
| 滑動窗口日誌 | 中 | **高**（存每次請求） | 否 | 無 | 精確限流、量小 |
| 滑動窗口計數 | 中 | 低 | 略有 | 幾乎無 | **通用推薦** |
| 令牌桶 | 中 | 低 | **是（可控）** | 無 | API 配額、允許突發 |
| 漏桶 | 中 | 低 | 否 | 無 | 保護下游、平滑輸出 |

---

## 10.10 固定窗口

### 最簡單的版本（有兩個 bug）

第 00 章提過這個寫法：

```bash
INCR rate:ip:1.2.3.4
EXPIRE rate:ip:1.2.3.4 60
```

**bug 1：非原子。** `INCR` 成功後、`EXPIRE` 前崩潰，這個 key 就永不過期，該 IP 被永久封鎖。

**bug 2：每次都執行 `EXPIRE`。** 如果每次請求都重設 60 秒，那麼只要請求持續不斷，這個窗口永遠不會重置——限流變成了「總量限制」。

### 正確版本

```lua
-- KEYS[1] = 限流 key
-- ARGV[1] = 限制次數, ARGV[2] = 窗口秒數
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])   -- 只在第一次設過期
end
if current > tonumber(ARGV[1]) then
  return 0                                  -- 拒絕
end
return 1                                    -- 放行
```

```javascript
const FIXED_WINDOW = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
if current > tonumber(ARGV[1]) then
  return 0
end
return 1`;

async function allowFixedWindow(key, limit, windowSec) {
  const allowed = await redis.eval(FIXED_WINDOW, 1,
    `rate:${key}`, String(limit), String(windowSec));
  return allowed === 1;
}
```

一個常見的變體是把時間戳直接編進 key，這樣連 `EXPIRE` 的判斷都省了：

```javascript
async function allowFixedWindowV2(key, limit, windowSec) {
  const bucket = Math.floor(Date.now() / 1000 / windowSec);
  const rateKey = `rate:${key}:${bucket}`;

  const pipe = redis.pipeline();
  pipe.incr(rateKey);
  pipe.expire(rateKey, windowSec * 2);   // 留一倍餘裕
  const [[, current]] = await pipe.exec();

  return current <= limit;
}
```

這個版本用 pipeline 就夠了（不需要 Lua），因為 `EXPIRE` 設在一個「反正也會被下個窗口取代」的 key 上，重複設定無害。

### 固定窗口的邊界問題

這是它最大的缺陷，一定要理解：

```text
限制：每分鐘 100 次

12:00:59  ████████████████ 100 次   ← 第一個窗口的尾巴
12:01:00  ████████████████ 100 次   ← 第二個窗口的開頭
          ─────────────────────────
          在這 2 秒內實際通過了 200 次 —— 是限制的兩倍
```

對「防止惡意刷量」來說這通常可以接受；但對「保護下游服務」來說，瞬間雙倍流量可能就是壓垮的那一下。

需要避免這個問題就用滑動窗口。

---

## 10.11 滑動窗口

### 做法 1：滑動窗口日誌（ZSET）

把每次請求的時間戳存進 Sorted Set，score 就是時間戳。判斷時先刪掉窗口外的，再數剩下幾個。

```lua
-- KEYS[1] = 限流 key
-- ARGV[1] = 現在的時間戳（毫秒）
-- ARGV[2] = 窗口長度（毫秒）
-- ARGV[3] = 限制次數
-- ARGV[4] = 本次請求的唯一 member

local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])

-- 1. 移除窗口外的舊記錄
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - window)

-- 2. 數目前窗口內有幾筆
local count = redis.call('ZCARD', KEYS[1])
if count >= limit then
  return 0
end

-- 3. 記錄本次請求
redis.call('ZADD', KEYS[1], now, ARGV[4])
redis.call('PEXPIRE', KEYS[1], window)
return 1
```

```javascript
const SLIDING_LOG = `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - window)
local count = redis.call('ZCARD', KEYS[1])
if count >= limit then return 0 end
redis.call('ZADD', KEYS[1], now, ARGV[4])
redis.call('PEXPIRE', KEYS[1], window)
return 1`;

async function allowSlidingLog(key, limit, windowMs) {
  const now = Date.now();
  const member = `${now}-${Math.random()}`;   // 保證唯一，避免同毫秒的請求覆蓋
  const allowed = await redis.eval(SLIDING_LOG, 1,
    `rate:${key}`, String(now), String(windowMs), String(limit), member);
  return allowed === 1;
}
```

**優點**：完全精確，沒有邊界問題。

**缺點**：記憶體與限制次數成正比。限制「每分鐘 10000 次」的話，每個 key 的 ZSET 會有多達一萬個 member。如果限流主體是 IP，一百萬個 IP 就是一百萬個 ZSET——這個記憶體量通常不可接受。

`member` 必須唯一。用純時間戳的話，同一毫秒進來的兩個請求會因為 member 相同而只算一次（`ZADD` 是覆蓋語意），限流就漏了。

### 做法 2：滑動窗口計數（推薦）

用「當前窗口的計數 + 前一個窗口的計數 × 重疊比例」來估算，記憶體是常數。

```text
限制：每分鐘 100 次，現在是 12:01:15（當前窗口過了 25%）

前一窗口（12:00~12:01）：80 次
當前窗口（12:01~12:02）：30 次

估算值 = 80 × (1 - 0.25) + 30 = 60 + 30 = 90 < 100 -> 放行
```

```lua
-- KEYS[1] = 前一窗口 key, KEYS[2] = 當前窗口 key
-- ARGV[1] = 限制次數
-- ARGV[2] = 當前窗口已經過去的比例（0~1）
-- ARGV[3] = 窗口秒數

local limit = tonumber(ARGV[1])
local elapsed = tonumber(ARGV[2])
local windowSec = tonumber(ARGV[3])

local prev = tonumber(redis.call('GET', KEYS[1]) or '0')
local curr = tonumber(redis.call('GET', KEYS[2]) or '0')

local estimated = prev * (1 - elapsed) + curr
if estimated >= limit then
  return 0
end

redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], windowSec * 2)
return 1
```

```javascript
const SLIDING_COUNTER = `
local limit = tonumber(ARGV[1])
local elapsed = tonumber(ARGV[2])
local windowSec = tonumber(ARGV[3])
local prev = tonumber(redis.call('GET', KEYS[1]) or '0')
local curr = tonumber(redis.call('GET', KEYS[2]) or '0')
local estimated = prev * (1 - elapsed) + curr
if estimated >= limit then return 0 end
redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], windowSec * 2)
return 1`;

async function allowSlidingCounter(key, limit, windowSec) {
  const nowSec = Date.now() / 1000;
  const currBucket = Math.floor(nowSec / windowSec);
  const elapsed = (nowSec % windowSec) / windowSec;   // 當前窗口過了多少比例

  const allowed = await redis.eval(SLIDING_COUNTER, 2,
    `rate:${key}:${currBucket - 1}`,
    `rate:${key}:${currBucket}`,
    String(limit), elapsed.toFixed(4), String(windowSec));
  return allowed === 1;
}
```

**它是估算，不是精確值**——假設前一個窗口的請求是均勻分布的。如果前一個窗口的 80 次全部集中在最後一秒，估算就會低估。但誤差在實務上很小（研究顯示大約 0.003% 的請求會被錯誤放行），換來的是常數記憶體。

**這是最推薦的通用方案。**

---

## 10.12 令牌桶

令牌桶允許**受控的突發**：桶裡以固定速率補充令牌，請求消耗令牌；桶有上限，所以閒置時攢下來的令牌可以支撐一波突發。

```text
補充速率 10 個/秒，桶容量 50

閒置 5 秒 -> 桶裡攢了 50 個令牌（達到上限）
突然來 50 個請求 -> 全部放行（用掉所有令牌）
接下來 -> 只能以 10 個/秒的速度通過
```

這正是多數 API 配額的行為：平時可以爆發，長期平均受限。

實作的關鍵是**惰性補充**——不需要真的用計時器去加令牌，而是在每次請求時根據「距離上次補充過了多久」算出應該補多少：

```lua
-- KEYS[1] = 桶的 key（Hash：tokens, timestamp）
-- ARGV[1] = 桶容量
-- ARGV[2] = 補充速率（每秒幾個）
-- ARGV[3] = 現在時間（毫秒）
-- ARGV[4] = 本次要消耗幾個令牌

local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])

local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(bucket[1])
local lastTs = tonumber(bucket[2])

if tokens == nil then
  tokens = capacity          -- 第一次使用，桶是滿的
  lastTs = now
end

-- 惰性補充：算出這段時間該補多少令牌
local delta = math.max(0, now - lastTs) / 1000
tokens = math.min(capacity, tokens + delta * rate)

local allowed = 0
if tokens >= requested then
  tokens = tokens - requested
  allowed = 1
end

redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
-- 過期時間設為「桶從空到滿所需的時間」，閒置夠久就自動清掉
redis.call('EXPIRE', KEYS[1], math.ceil(capacity / rate) + 60)

-- 回傳：是否放行、剩餘令牌數
return { allowed, math.floor(tokens) }
```

```javascript
const TOKEN_BUCKET = `
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])
local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(bucket[1])
local lastTs = tonumber(bucket[2])
if tokens == nil then
  tokens = capacity
  lastTs = now
end
local delta = math.max(0, now - lastTs) / 1000
tokens = math.min(capacity, tokens + delta * rate)
local allowed = 0
if tokens >= requested then
  tokens = tokens - requested
  allowed = 1
end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('EXPIRE', KEYS[1], math.ceil(capacity / rate) + 60)
return { allowed, math.floor(tokens) }`;

async function allowTokenBucket(key, capacity, ratePerSec, cost = 1) {
  const [allowed, remaining] = await redis.eval(TOKEN_BUCKET, 1,
    `bucket:${key}`, String(capacity), String(ratePerSec),
    String(Date.now()), String(cost));

  return { allowed: allowed === 1, remaining };
}
```

三個實作要點：

**時間戳由客戶端傳入（`ARGV[3]`），而不是在 Lua 裡呼叫 `redis.call('TIME')`。** 原因見 10.14 節（複製與確定性）。代價是不同應用伺服器的時鐘要大致同步。

**`cost` 參數很有用。** 不同 API 消耗不同權重（查詢消耗 1，匯出報表消耗 20），這比為每個 API 各做一個限流器簡單得多。

**回傳剩餘令牌數。** 這讓你能回應標準的限流標頭：

```javascript
const { allowed, remaining } = await allowTokenBucket(`user:${userId}`, 100, 10);

res.set('X-RateLimit-Limit', '100');
res.set('X-RateLimit-Remaining', String(remaining));
if (!allowed) {
  res.set('Retry-After', '1');
  return res.status(429).json({ error: 'rate limit exceeded' });
}
```

---

## 10.13 漏桶與四種演算法的總結

漏桶（Leaky Bucket）的行為是：請求以任意速率進入，但**以固定速率流出**。它和令牌桶最大的差別是**不允許突發**。

實作上可以看成「令牌桶的容量 = 1 個請求的量」，或者用一個「下一次可執行時間」的變體：

```lua
-- 漏桶（GCRA 風格）：維護一個「理論到達時間」
-- ARGV[1] = 每個請求的間隔（毫秒），ARGV[2] = 允許的突發量（毫秒）
-- ARGV[3] = 現在時間（毫秒）

local interval = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local tat = tonumber(redis.call('GET', KEYS[1]) or '0')
if tat < now then tat = now end

if tat - now > burst then
  return { 0, math.ceil(tat - now - burst) }   -- 拒絕，並告知還要等多久
end

local newTat = tat + interval
redis.call('SET', KEYS[1], newTat, 'PX', math.ceil(newTat - now + interval))
return { 1, 0 }
```

`tat`（theoretical arrival time）是「下一個請求理論上該到達的時間」。每放行一個請求就把它往後推 `interval`。當它超前現在時間太多（超過 `burst`）就代表來得太快，拒絕。

這個做法的好處是只需要一個 String，而且回傳「還要等多久」可以直接給客戶端做退避。

### 四種演算法怎麼選

```text
你想限制的是什麼？

「單位時間內的總量」，且能接受邊界處雙倍
   -> 固定窗口（最簡單，適合粗略防刷）

「單位時間內的總量」，且不能接受邊界問題
   -> 滑動窗口計數（通用推薦）
   -> 需要絕對精確且量體小 -> 滑動窗口日誌

「平均速率，但允許攢起來的突發」
   -> 令牌桶（API 配額的標準選擇）

「輸出必須絕對平滑，保護脆弱的下游」
   -> 漏桶
```

實務上的預設建議：**對外 API 用令牌桶（使用者體驗好，允許正常的突發），對內保護下游用滑動窗口計數或漏桶。**

---

## 10.14 分散式限流的實務問題

### 問題 1：時間從哪來

Lua 腳本裡有兩種取得時間的方式：

```lua
-- 方式 A：Redis 的時間
local t = redis.call('TIME')      -- 回傳 { 秒, 微秒 }

-- 方式 B：客戶端傳進來
local now = tonumber(ARGV[1])
```

**方式 A 在 Redis 7 之前會讓腳本無法被複製到 replica 或寫入 AOF**（因為結果不確定，重放時會得到不同的值）。Redis 3.2～6.x 會直接拒絕在呼叫 `TIME` 之後再執行寫入命令：

```text
(error) ERR Write commands not allowed after non deterministic commands.
```

Redis 7.0 改用「effect replication」（複製實際產生的效果，而非腳本本身），這個限制解除了。但為了相容性與可預期性，**建議仍然由客戶端傳入時間戳**。

代價是所有應用伺服器的時鐘要大致同步（NTP 就夠了，誤差在幾十毫秒內對限流沒有實質影響）。

### 問題 2：Cluster 下的 key 分布

限流 key 通常天然分散（每個使用者/IP 一個 key），這在 Cluster 下是好事——負載自然分攤。

但**滑動窗口計數需要同時操作兩個 key**（前一窗口和當前窗口），它們必須在同一個 slot，否則 Lua 腳本會報錯：

```text
(error) CROSSSLOT Keys in request don't hash to the same slot
```

用 hash tag 把它們綁在一起（第 11 章詳談）：

```javascript
// 用 {} 包住共同部分，Redis 只用大括號內的內容計算 slot
`rate:{${key}}:${currBucket - 1}`
`rate:{${key}}:${currBucket}`
```

### 問題 3：Redis 掛掉時該放行還是拒絕

這是一個**業務決策**，沒有標準答案：

```javascript
async function allow(key, limit, windowSec) {
  try {
    return await allowSlidingCounter(key, limit, windowSec);
  } catch (err) {
    logger.error({ err, key }, 'rate limiter unavailable');

    // fail-open：Redis 掛了就全部放行
    return true;

    // fail-closed：Redis 掛了就全部拒絕
    // return false;
  }
}
```

| | fail-open（放行） | fail-closed（拒絕） |
|---|-----------------|-------------------|
| 風險 | 下游可能被打垮 | 服務直接不可用 |
| 適合 | 一般 API 防刷、防爬蟲 | 付費配額、防止資損的場景 |

**多數情況選 fail-open**——限流器故障不該造成服務中斷。但要搭配下游本身的保護（連線池上限、單機限流），否則 fail-open 等於完全沒有防護。

比較穩健的折衷是**本地限流兜底**：Redis 可用時用分散式限流，不可用時退回單機限流（把總配額除以實例數）。

### 問題 4：限流的維度設計

實務上很少只用單一維度，通常是多層：

```javascript
const RULES = [
  { key: `ip:${ip}`,            limit: 1000, window: 60 },   // 防單一 IP 刷
  { key: `user:${userId}`,      limit: 100,  window: 60 },   // 使用者配額
  { key: `api:${endpoint}`,     limit: 50000, window: 60 },  // 保護單一介面
  { key: 'global',              limit: 200000, window: 60 }, // 全站總量
];

async function checkAll(rules) {
  // 用 pipeline 一次檢查所有維度（第 07 章）
  const pipe = redis.pipeline();
  for (const r of rules) {
    pipe.eval(SLIDING_COUNTER, 2, /* ... */);
  }
  const results = await pipe.exec();

  for (let i = 0; i < results.length; i++) {
    if (results[i][1] !== 1) {
      return { allowed: false, rule: rules[i].key };   // 回報是哪一條擋的
    }
  }
  return { allowed: true };
}
```

兩個設計要點：

**回報是哪一條規則擋的。** 否則客戶回報「被限流了」時你完全無法診斷。這個資訊也該放進回應標頭或錯誤訊息。

**注意「檢查了但被別的維度擋下」的計數污染。** 上面的實作中，即使第 4 條規則拒絕了，前 3 條規則的計數已經被加上去了。嚴格來說應該先全部檢查、都通過才一起增加計數——但那需要一個更複雜的 Lua 腳本，且會犧牲一些精確度。實務上多數系統接受這個誤差。

---

## 10.15 常見錯誤

### 錯誤 1：`SETNX` 之後才 `EXPIRE`

兩個命令之間崩潰就永久死鎖。用 `SET key value NX PX ttl`。

### 錯誤 2：鎖不設過期時間

「反正 `finally` 一定會執行」——程序被 `kill -9`、OOM kill、機器斷電時不會。鎖必須有 TTL。

### 錯誤 3：釋放鎖不驗證持有者

業務超時後鎖已被別人拿走，你的 `DEL` 會刪掉別人的鎖，造成連鎖失效。

### 錯誤 4：驗證持有者用「先 GET 再 DEL」

兩個命令之間鎖可能過期並被搶走。必須用 Lua 原子執行。

### 錯誤 5：鎖的 value 用固定值

`SET lock 1 NX EX 30` 這種寫法無法識別持有者，等於沒有辦法安全釋放。用 UUID。

### 錯誤 6：看門狗續期不驗證持有者

會把別人的鎖續命，讓失效狀態持續更久。續期的 Lua 也要比對 value。

### 錯誤 7：續期失敗時繼續執行業務

續期失敗代表鎖已經失去，此時繼續寫入資料是危險的。至少要告警，理想上要中止。

### 錯誤 8：可重入鎖用程序 ID 當持有者標識

Node.js / Go 這類單程序多併發的環境裡，同一程序的兩個請求會被誤判為同一持有者，互斥完全失效。要用請求層級的唯一 ID。

### 錯誤 9：以為 Redlock 能保證正確性

Redlock 解決的是單點故障，不是 GC 停頓。需要正確性保證時，要在資料層做 fencing 或用唯一約束。

### 錯誤 10：該用唯一約束的地方用鎖

鎖只保護「走了加鎖程式碼」的路徑，手動 SQL、其他服務、資料修復腳本都繞得過。資料庫約束才是強保證。

### 錯誤 11：庫存扣減用鎖

會讓所有請求排隊，吞吐量崩潰。用 Lua 原子操作，Redis 單執行緒本身就提供互斥。

### 錯誤 12：限流的 `EXPIRE` 每次都重設

窗口永遠不會重置，限流變成總量限制。只在計數為 1 時設過期，或把時間戳編進 key。

### 錯誤 13：滑動窗口日誌的 member 不唯一

同毫秒的多個請求會因為 `ZADD` 的覆蓋語意只算一次。member 要加隨機值。

### 錯誤 14：在 Lua 裡用 `redis.call('TIME')` 後又執行寫入

Redis 7 之前會直接報錯。時間戳由客戶端傳入。

### 錯誤 15：Cluster 下滑動窗口計數的兩個 key 沒用 hash tag

會收到 `CROSSSLOT` 錯誤。用 `{}` 綁定 slot。

### 錯誤 16：限流器故障時沒有決定 fail-open 還是 fail-closed

沒想過這件事，通常意味著程式碼會直接拋錯，變成「Redis 掛了整個 API 就 500」——最糟的組合。

---

## 10.16 本章練習

### 練習 1：找出這個鎖實作的所有問題

```javascript
async function processPayment(orderId) {
  const lockKey = 'lock:' + orderId;

  const got = await redis.setnx(lockKey, 1);
  if (!got) {
    throw new Error('order is being processed');
  }
  await redis.expire(lockKey, 10);

  const order = await db.getOrder(orderId);
  await callPaymentGateway(order);        // 可能耗時 30 秒以上
  await db.updateOrder(orderId, { status: 'paid' });

  await redis.del(lockKey);
}
```

<details>
<summary>參考解答</summary>

**問題 1：`SETNX` + `EXPIRE` 不是原子的。** 兩者之間崩潰，鎖永不過期，這筆訂單再也無法處理。

**問題 2：鎖的 value 是固定值 `1`。** 無法識別持有者，導致問題 4 無解。

**問題 3：TTL 10 秒，但業務可能跑 30 秒以上。** 支付閘道回應慢的時候，鎖會在業務跑完前過期，另一個請求可以進來——**同一筆訂單可能被支付兩次**。這是本題最嚴重的問題。

**問題 4：`DEL` 不驗證持有者。** 承上，鎖過期後被別人拿走，這裡的 `DEL` 會刪掉別人的鎖，造成第三個請求也能進來。

**問題 5：業務拋錯時鎖不會被釋放。** `callPaymentGateway` 失敗會讓函式直接拋出，`redis.del` 永遠不執行。要等 10 秒 TTL，這段時間訂單被卡住。

**問題 6：沒有等待機制。** 拿不到鎖直接拋錯。對「支付」這種操作，稍等一下再試通常比直接失敗好（但要看業務決定）。

**問題 7（設計層面，最重要）：整段邏輯不是冪等的。** 就算鎖完全正確，你也應該假設它可能失效——支付這種涉及金錢的操作，必須在**業務層**有防重機制。

**改寫版本：**

```javascript
async function processPayment(orderId) {
  return withLock(redis, `payment:${orderId}`, async (lock) => {
    const order = await db.getOrder(orderId);

    // 防重 1：狀態檢查
    if (order.status !== 'pending') {
      logger.info({ orderId, status: order.status }, 'already processed');
      return { skipped: true };
    }

    // 防重 2：帶冪等鍵呼叫支付閘道
    // 即使鎖失效導致重複呼叫，閘道也會回傳同一筆交易而不是扣兩次款
    const result = await callPaymentGateway(order, {
      idempotencyKey: `pay-${orderId}`,
    });

    // 防重 3：條件更新（樂觀鎖）
    const updated = await db.query(
      `UPDATE orders SET status = 'paid', paid_at = NOW(), txn_id = $1
       WHERE id = $2 AND status = 'pending'`,
      [result.txnId, orderId]);

    if (updated.rowCount === 0) {
      // 鎖失效期間被別人改過了
      logger.error({ orderId }, 'concurrent modification detected');
      throw new ConcurrentModificationError();
    }

    return { txnId: result.txnId };
  }, {
    ttlMs: 30000,      // 給看門狗一個合理的基礎值
    autoRenew: true,   // 業務可能超過 30 秒，靠續期
    waitMs: 5000,      // 拿不到鎖時等 5 秒
  });
}
```

**這題的核心結論：鎖是第一道防線，不是唯一防線。** 三層防重（狀態檢查、閘道冪等鍵、條件更新）中的任何一層都能單獨擋住重複支付，鎖只是讓它們比較少被觸發。

如果只能選一個，選閘道的冪等鍵——那是唯一能防止「真的扣兩次錢」的機制。

</details>

### 練習 2：實測鎖在業務超時下的失效

用真實環境驗證「業務比 TTL 久」會發生什麼，以及看門狗如何修好它。

<details>
<summary>參考解答</summary>

**第 1 步：模擬無續期的鎖，業務超時**

開兩個終端。

終端 A（模擬慢業務，TTL 5 秒但跑 8 秒）：

```bash
docker compose exec redis sh -c '
  VAL="worker-A"
  GOT=$(redis-cli -a mysecret --no-auth-warning SET lock:demo "$VAL" NX EX 5)
  echo "A 取鎖：$GOT"

  echo "A 開始執行業務（8 秒）..."
  sleep 8

  echo "A 業務完成，準備釋放鎖"
  echo "A 釋放前，鎖的持有者是：$(redis-cli -a mysecret --no-auth-warning GET lock:demo)"

  # 不驗證持有者的錯誤釋放方式
  redis-cli -a mysecret --no-auth-warning DEL lock:demo
  echo "A 已 DEL"
'
```

終端 B（在 A 跑到第 6 秒時執行）：

```bash
docker compose exec redis sh -c '
  sleep 6
  VAL="worker-B"
  GOT=$(redis-cli -a mysecret --no-auth-warning SET lock:demo "$VAL" NX EX 5)
  echo "B 取鎖：$GOT"           # OK —— B 也拿到了鎖！
  redis-cli -a mysecret --no-auth-warning GET lock:demo
'
```

你會看到：

```text
A 取鎖：OK
（5 秒後鎖自動過期）
B 取鎖：OK                          <- 兩個 worker 同時持有
A 釋放前，鎖的持有者是：worker-B     <- A 看到的已經是 B 的鎖
A 已 DEL                            <- A 刪掉了 B 的鎖
```

**兩個 worker 同時在臨界區，而且 A 還把 B 的鎖刪了。**

**第 2 步：加上驗證持有者的釋放**

把 A 的釋放改成 Lua：

```bash
docker compose exec redis redis-cli -a mysecret EVAL \
  "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end" \
  1 lock:demo "worker-A"
# (integer) 0    <- 沒有誤刪，但也告訴你「你的鎖已經沒了」
```

回傳 0 就是那個重要訊號——**它證明臨界區在你不知情的狀況下被別人進入過**。生產環境看到這個必須告警。

**第 3 步：加上看門狗**

```bash
cat > /tmp/watchdog.sh <<'EOF'
#!/bin/sh
KEY=lock:demo
VAL="worker-A"
TTL=5

GOT=$(redis-cli -a mysecret --no-auth-warning SET $KEY "$VAL" NX EX $TTL)
echo "A 取鎖：$GOT"
[ "$GOT" != "OK" ] && exit 1

# 背景續期：每 TTL/3 秒續一次
(
  while true; do
    sleep 1
    OK=$(redis-cli -a mysecret --no-auth-warning EVAL \
      "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('EXPIRE',KEYS[1],ARGV[2]) else return 0 end" \
      1 $KEY "$VAL" $TTL)
    [ "$OK" = "0" ] && echo "續期失敗，鎖已失去" && exit 1
    echo "  [watchdog] 續期成功，TTL 重設為 $TTL"
  done
) &
WATCHDOG=$!

echo "A 執行業務（8 秒）..."
sleep 8

kill $WATCHDOG 2>/dev/null
RESULT=$(redis-cli -a mysecret --no-auth-warning EVAL \
  "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end" \
  1 $KEY "$VAL")
echo "A 釋放結果：$RESULT （1 = 正常釋放自己的鎖）"
EOF
chmod +x /tmp/watchdog.sh
```

```bash
docker compose exec redis redis-cli -a mysecret DEL lock:demo
docker compose exec redis /tmp/watchdog.sh
```

輸出：

```text
A 取鎖：OK
A 執行業務（8 秒）...
  [watchdog] 續期成功，TTL 重設為 5
  [watchdog] 續期成功，TTL 重設為 5
  ...
A 釋放結果：1
```

這次 B 在整個 8 秒內都拿不到鎖，因為 TTL 一直被續。

**第 4 步：驗證看門狗在崩潰時不會造成死鎖**

```bash
docker compose exec redis sh -c '
  redis-cli -a mysecret --no-auth-warning DEL lock:demo
  /tmp/watchdog.sh &
  PID=$!
  sleep 3
  kill -9 $PID                       # 模擬程序被強制殺掉
  pkill -f "redis-cli.*EXPIRE" 2>/dev/null
  echo "已強制終止，觀察鎖的 TTL："
  sleep 1
  redis-cli -a mysecret --no-auth-warning TTL lock:demo
  sleep 6
  echo "6 秒後："
  redis-cli -a mysecret --no-auth-warning TTL lock:demo   # -2 = 已經不存在
'
```

看門狗一起被殺掉，沒有人再續期，鎖在 TTL 到期後自動釋放。**這正是 TTL 存在的意義——它是崩潰時的保險。**

**清理**

```bash
docker compose exec redis redis-cli -a mysecret DEL lock:demo
```

</details>

### 練習 3：設計一個開放平台的 API 限流方案

需求：

- 開放平台有三種方案：免費（每分鐘 60 次）、專業（每分鐘 600 次）、企業（每分鐘 6000 次）。
- 允許短時間突發（例如免費方案可以瞬間打 60 次，然後等一分鐘）。
- 不同 API 消耗不同權重：一般查詢 1 點，批次查詢 5 點，報表匯出 50 點。
- 要回傳標準的限流標頭讓客戶端能自我調節。
- 同時要防止單一 IP 惡意攻擊（不論用哪個方案的 key）。
- Redis 掛掉時服務不能中斷。

請選擇演算法、設計 key、寫出實作，並說明取捨。

<details>
<summary>參考解答</summary>

**演算法選擇：令牌桶**

理由直接對應需求：

- 「允許短時間突發」→ 令牌桶的桶容量就是突發上限，滑動窗口做不到這種可控突發。
- 「不同 API 消耗不同權重」→ 令牌桶的 `cost` 參數天然支援，滑動窗口要記多次計數才能模擬。
- 「回傳限流標頭」→ 令牌桶能直接算出剩餘令牌與恢復時間。

**參數設計**

| 方案 | 補充速率 | 桶容量 | 意義 |
|------|---------|--------|------|
| free | 1 點/秒 | 60 | 長期 60/分鐘，可瞬間爆發 60 |
| pro | 10 點/秒 | 600 | 長期 600/分鐘，可瞬間爆發 600 |
| enterprise | 100 點/秒 | 6000 | 長期 6000/分鐘 |

桶容量設成「一分鐘的量」而不是更大，避免長期閒置後累積出過大的突發（例如閒置一小時後可以瞬間打 3600 次，那會打垮下游）。

**Key 設計**

```text
bucket:api:{apiKey}      令牌桶（Hash: tokens, ts）— 主要配額
bucket:ip:{ip}           IP 層防護，固定為 pro 級別，不分方案
```

用 `{}` 是為了 Cluster 的 hash tag——這裡每個限流只操作單一 key，其實不需要，但保留這個習慣可以避免之後加入多 key 邏輯時踩到 `CROSSSLOT`。

**實作**

```javascript
const TOKEN_BUCKET = `
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])

local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(bucket[1])
local lastTs = tonumber(bucket[2])
if tokens == nil then
  tokens = capacity
  lastTs = now
end

local delta = math.max(0, now - lastTs) / 1000
tokens = math.min(capacity, tokens + delta * rate)

local allowed = 0
local retryAfterMs = 0
if tokens >= requested then
  tokens = tokens - requested
  allowed = 1
else
  retryAfterMs = math.ceil((requested - tokens) / rate * 1000)
end

redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('EXPIRE', KEYS[1], math.ceil(capacity / rate) + 60)
return { allowed, math.floor(tokens), retryAfterMs }`;

const PLANS = {
  free:       { rate: 1,   capacity: 60,   limitPerMin: 60 },
  pro:        { rate: 10,  capacity: 600,  limitPerMin: 600 },
  enterprise: { rate: 100, capacity: 6000, limitPerMin: 6000 },
};

const COSTS = { query: 1, batch: 5, export: 50 };

async function checkQuota(bucketKey, plan, cost, now) {
  const [allowed, remaining, retryAfterMs] = await redis.eval(
    TOKEN_BUCKET, 1, bucketKey,
    String(plan.capacity), String(plan.rate), String(now), String(cost));
  return { allowed: allowed === 1, remaining, retryAfterMs };
}
```

**中介層**

```javascript
async function rateLimitMiddleware(req, res, next) {
  const apiKey = req.header('X-API-Key');
  const ip = req.ip;
  const plan = PLANS[await getPlanOf(apiKey)] ?? PLANS.free;
  const cost = COSTS[classifyEndpoint(req.path)] ?? 1;
  const now = Date.now();

  let apiResult, ipResult;

  try {
    // 兩個維度用 pipeline 一次送出，減少往返（第 07 章）
    const pipe = redis.pipeline();
    pipe.eval(TOKEN_BUCKET, 1, `bucket:api:{${apiKey}}`,
      String(plan.capacity), String(plan.rate), String(now), String(cost));
    pipe.eval(TOKEN_BUCKET, 1, `bucket:ip:{${ip}}`,
      String(PLANS.pro.capacity), String(PLANS.pro.rate), String(now), String(cost));

    const results = await pipe.exec();
    apiResult = parseResult(results[0]);
    ipResult = parseResult(results[1]);
  } catch (err) {
    logger.error({ err }, 'rate limiter unavailable, fallback to local');
    // fail-open + 本地兜底（見下方說明）
    if (!localLimiter.allow(apiKey, plan)) {
      return res.status(429).json({ error: 'rate limit exceeded (local)' });
    }
    return next();
  }

  // 標準限流標頭（依 IETF draft 的常見實作）
  res.set('X-RateLimit-Limit', String(plan.limitPerMin));
  res.set('X-RateLimit-Remaining', String(Math.max(0, apiResult.remaining)));
  res.set('X-RateLimit-Cost', String(cost));

  if (!ipResult.allowed) {
    res.set('Retry-After', String(Math.ceil(ipResult.retryAfterMs / 1000)));
    return res.status(429).json({
      error: 'rate limit exceeded',
      scope: 'ip',                    // 告訴客戶端是哪一層擋的
    });
  }

  if (!apiResult.allowed) {
    res.set('Retry-After', String(Math.ceil(apiResult.retryAfterMs / 1000)));
    return res.status(429).json({
      error: 'rate limit exceeded',
      scope: 'api_key',
      upgradeUrl: 'https://example.com/pricing',
    });
  }

  next();
}

function parseResult([err, value]) {
  if (err) throw err;
  return { allowed: value[0] === 1, remaining: value[1], retryAfterMs: value[2] };
}
```

**Redis 掛掉的處理：fail-open + 本地兜底**

單純 fail-open 等於完全沒有防護。加一層單機限流：

```javascript
// 本地限流：把配額除以實例數，寧可嚴格一點
const INSTANCE_COUNT = parseInt(process.env.INSTANCE_COUNT || '3', 10);

const localLimiter = {
  buckets: new Map(),

  allow(key, plan) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: plan.capacity / INSTANCE_COUNT, ts: now };
      this.buckets.set(key, b);
    }
    const rate = plan.rate / INSTANCE_COUNT;
    b.tokens = Math.min(plan.capacity / INSTANCE_COUNT,
                        b.tokens + (now - b.ts) / 1000 * rate);
    b.ts = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return true;
    }
    return false;
  },
};
```

這個 Map 需要定期清理（用 LRU 或定時掃描），否則 key 會無限成長——這是本地兜底最容易被忽略的部分。

**取捨說明**

**取捨 1：兩個維度的計數污染。** IP 被擋下時，API Key 的令牌已經扣掉了。嚴格做法是寫一個同時檢查兩個桶、都通過才扣的 Lua 腳本。但那需要兩個 key 在同一 slot（不同的 apiKey 和 ip 無法保證），在 Cluster 下不可行。實務上接受這個誤差——被 IP 擋下的通常是攻擊流量，多扣它的配額不是問題。

**取捨 2：桶容量 = 一分鐘的量。** 這限制了突發規模。如果業務上需要「平常不用，月底一次跑完」，就要把容量調大，但要同時確認下游扛得住那個突發量。

**取捨 3：本地兜底會偏嚴。** 把配額除以實例數，在流量不均勻時會誤擋。但限流器故障期間寧可嚴一點，這是可接受的降級。

**取捨 4：沒有做「全站總量」限制。** 需求沒提，但生產環境建議加一層，作為最後的防線防止下游被打垮。它只需要一個全域 key，但要注意那會變成熱 key（10.14 節提過的問題，可以用打散或本地預扣的方式緩解）。

</details>

---

## 10.17 驗收清單

進入下一章前，確認你可以：

- [ ] 說明單機鎖為什麼無法跨程序，以及分散式鎖的本質是什麼。
- [ ] 從 `SETNX` 推導到 v5，並說出每次演進修掉了什麼。
- [ ] 說明為什麼 `SETNX` + `EXPIRE` 分兩步是錯的。
- [ ] 說明為什麼「先 GET 再 DEL」不能安全釋放鎖，必須用 Lua。
- [ ] 實作看門狗續期，並說明續期間隔為什麼是 TTL/3。
- [ ] 說明續期失敗與釋放回傳 0 各代表什麼，以及為什麼必須告警。
- [ ] 用 Hash + Lua 實作可重入鎖，並說出持有者標識該怎麼定。
- [ ] 說明主從切換為什麼會丟鎖，且無法用更好的 Lua 解決。
- [ ] 說明 GC 停頓造成的失效，以及為什麼看門狗救不了。
- [ ] 說明 fencing token 的原理，以及它的落地難點在下游。
- [ ] 描述 Redlock 演算法，並說出 Kleppmann 的三個批評與 antirez 的回應。
- [ ] 判斷一個場景是「效率型」還是「正確性型」，並選對方案。
- [ ] 舉出四個「不該用分散式鎖」的場景與各自的替代方案。
- [ ] 說明為什麼庫存扣減該用 Lua 而不是鎖。
- [ ] 實作四種限流演算法，並說出各自的邊界效應。
- [ ] 說明固定窗口的邊界問題，並畫出雙倍流量的時序。
- [ ] 說明滑動窗口日誌的記憶體代價，以及計數法如何用估算換取常數記憶體。
- [ ] 實作令牌桶的惰性補充，並說明為什麼不需要計時器。
- [ ] 說明為什麼 Lua 裡的時間戳該由客戶端傳入。
- [ ] 說明 Cluster 下多 key 限流需要 hash tag 的原因。
- [ ] 判斷限流器故障時該 fail-open 還是 fail-closed，並設計本地兜底。

---

下一章進入架構層：[11-replication-sentinel-cluster.md](./11-replication-sentinel-cluster.md)，我們會實際搭起主從、Sentinel 與 Cluster，並回答這章留下的問題——故障轉移時到底會丟多少資料。
