# 第 07 章：Pipeline、交易與 Lua 腳本

> 這章處理兩個經常被搞混的問題。
> 第一個是**效能問題**：「我要發 100 個命令，怎麼不要花 100 次網路往返？」答案是 Pipeline。
> 第二個是**正確性問題**：「我要先判斷庫存再扣減，怎麼保證中間沒有別人插隊？」答案是 Lua。
> 很多人以為 `MULTI`/`EXEC` 是「交易」所以能解決第二個問題，於是寫出看起來安全、實際上有競爭 bug 的程式碼。這章會把三者的能力邊界講清楚。

---

## 7.1 學習目標

完成本章後，你應該可以：

- 說明 Pipeline 解決什麼問題、不解決什麼問題。
- 算出往返次數對總延遲的影響，並選擇合適的批次大小。
- 說明 `MULTI`/`EXEC` 的真實語意，以及它為什麼**沒有回滾**。
- 區分「入隊錯誤」與「執行時錯誤」的不同處理方式。
- 用 `WATCH` 實作樂觀鎖，並寫出正確的重試迴圈。
- 用 Lua 實作真正原子的複合邏輯，例如判斷後扣減。
- 說明為什麼 Lua 腳本必須把 key 宣告在 `KEYS` 裡。
- 說出 Lua 的三個關鍵陷阱：數值轉換、長腳本阻塞、以及 Cluster 的 slot 限制。
- 為一個需求正確選出 Pipeline、`MULTI`、還是 Lua。

---

## 7.2 先分清楚：往返次數 vs 原子性

這兩個維度是獨立的：

| | 減少往返 | 保證原子 |
|---|---------|---------|
| 多個獨立命令一起發 | Pipeline ✓ | ✗ |
| `MULTI` / `EXEC` | ✓（順便） | 部分（見 7.4） |
| Lua 腳本 | ✓ | ✓ |
| `WATCH` + `MULTI` | ✓ | 樂觀鎖（會失敗要重試） |

**判斷你需要哪一個，先問一個問題：後面的命令需不需要依賴前面命令的結果？**

```text
不需要（例如：一次寫入 100 個獨立的 key）
  -> Pipeline

需要，而且要保證中間沒人插隊（例如：先讀庫存、判斷、再扣減）
  -> Lua

需要，但可以接受「衝突時重試」
  -> WATCH + MULTI（樂觀鎖）
```

**Pipeline 不提供原子性**，這是最重要的一點。你把 100 個命令一起送出去，Redis 會依序執行它們，但**其他客戶端的命令可能穿插在中間**。

---

## 7.3 Pipeline：把 N 次往返變成 1 次

### 問題的數學

一個 Redis 命令的總耗時是：

```text
總耗時 = 網路往返時間（RTT） + Redis 執行時間

典型數值：
  同機房 RTT        ≈ 0.1 - 0.5 ms
  跨可用區 RTT      ≈ 1 - 2 ms
  Redis 執行 GET    ≈ 0.001 ms（1 微秒）
```

**注意這個比例：網路往返比命令執行慢了幾百倍。** 所以優化的重點不是讓 Redis 跑更快，而是**減少往返次數**。

```text
100 個 GET，每個一次往返（RTT = 0.5ms）：
  100 × (0.5 + 0.001) ≈ 50 ms

100 個 GET，用 Pipeline 一次送出：
  1 × 0.5 + 100 × 0.001 ≈ 0.6 ms

差了約 80 倍
```

### 實作

```javascript
// 慢：100 次往返
const results = [];
for (const id of ids) {
  results.push(await redis.get(`product:${id}`));
}

// 快：1 次往返
const pipeline = redis.pipeline();
for (const id of ids) {
  pipeline.get(`product:${id}`);
}
const results = await pipeline.exec();
// ioredis 的 exec 回傳 [[err, result], [err, result], ...]
```

Python（redis-py）：

```python
pipe = r.pipeline(transaction=False)   # transaction=False 表示純 pipeline，不用 MULTI
for id in ids:
    pipe.get(f'product:{id}')
results = pipe.execute()
```

**注意 redis-py 的預設行為**：`r.pipeline()` 預設 `transaction=True`，會自動包上 `MULTI`/`EXEC`。如果你只是要減少往返、不需要交易語意，明確傳 `transaction=False` 能少一點開銷。

### Pipeline vs `MGET`

```javascript
// 這兩個都是一次往返
await redis.mget(keys);                        // 只能用在 String
await pipeline.get(k1).get(k2).exec();         // 任何命令都可以
```

`MGET` / `MSET` / `HMGET` 這類批次命令的優勢是**它們是單一命令，所以是原子的**；Pipeline 的優勢是**可以混合不同命令**。

```javascript
// Pipeline 的真正價值：混合命令
const pipeline = redis.pipeline();
pipeline.hgetall('user:1001');
pipeline.zscore('rank:global', 'user:1001');
pipeline.scard('user:1001:followers');
pipeline.lrange('user:1001:timeline', 0, 9);
const [profile, score, followers, timeline] = await pipeline.exec();
```

原本要 4 次往返，現在 1 次。**這是最常見也最有價值的用法**——組裝一個頁面需要的多份資料。

### 批次大小的取捨

不要把一百萬個命令塞進一個 Pipeline：

```text
批次太小（如 10）    -> 往返次數還是多，優化效果有限
批次太大（如 100000）-> 三個問題：
  1. 客戶端要在記憶體裡緩衝所有命令與所有回應
  2. Redis 的輸出緩衝區膨脹（第 05 章的記憶體風險）
  3. Redis 執行這一批的期間會持續佔用單執行緒，其他客戶端被拖慢
```

**實務建議：每批 100 到 1000 個命令。**

```javascript
async function batchSet(entries, batchSize = 500) {
  for (let i = 0; i < entries.length; i += batchSize) {
    const chunk = entries.slice(i, i + batchSize);
    const pipeline = redis.pipeline();
    for (const [key, value] of chunk) {
      pipeline.set(key, value, 'EX', 3600);
    }
    await pipeline.exec();
  }
}
```

### Pipeline 不是原子的

這點值得重複強調，因為它是 bug 的來源：

```javascript
// 錯誤的想法：以為這是原子的
const pipeline = redis.pipeline();
pipeline.get('stock:1001');       // 假設回傳 5
pipeline.decr('stock:1001');      // 減到 4
await pipeline.exec();

// 實際上，其他客戶端的命令可能穿插進來：
// 你的 GET -> 別人的 DECR -> 你的 DECR
// 你以為庫存是 5，但你的 DECR 執行時它已經是 4 了
```

更根本的問題是：**Pipeline 是「一次送出全部命令」，所以你無法根據第一個命令的結果決定第二個命令。** 所有命令在送出時就已經決定了。

需要「根據結果決定下一步」就用 Lua。

### `redis-cli --pipe`：大量資料匯入

需要一次灌入幾百萬筆資料時，`--pipe` 模式比逐條執行快幾個數量級：

```bash
# 產生命令檔
for i in $(seq 1 1000000); do
  echo "SET key:$i value:$i"
done > commands.txt

# 用 pipe 模式灌入
redis-cli -a pass --pipe < commands.txt
# All data transferred. Waiting for the last reply...
# Last reply received from server.
# errors: 0, replies: 1000000
```

它的原理是「不等每個回應就繼續送下一個」，最後統一檢查。**注意它會顯示 `errors` 數量，一定要確認是 0**，否則可能有部分命令失敗了而你沒發現。

---

## 7.4 `MULTI` / `EXEC`：它不是你想的交易

### 基本用法

```bash
MULTI
# OK
SET account:A 100
# QUEUED       <- 注意：命令沒有執行，只是排隊
SET account:B 200
# QUEUED
EXEC
# 1) OK
# 2) OK        <- 到這一刻才一次性執行
```

`DISCARD` 可以放棄整個佇列：

```bash
MULTI
SET foo bar
# QUEUED
DISCARD
# OK           <- 佇列清空，什麼都沒執行
```

### 它提供什麼保證

**保證 1：隔離性。** `EXEC` 執行期間，這些命令會**連續執行完**，不會有其他客戶端的命令穿插。這是單執行緒模型自然給的。

**保證 2：全部執行或全部不執行——只在「入隊階段就發現錯誤」的情況下成立。**

### 它不提供什麼：回滾

**這是最重要的一點：Redis 的 `MULTI`/`EXEC` 沒有回滾機制。**

```bash
SET mystr "hello"
# OK

MULTI
SET k1 "v1"
# QUEUED
INCR mystr          # 對字串做 INCR，型別錯誤
# QUEUED            <- 注意：入隊時沒有報錯！
SET k2 "v2"
# QUEUED
EXEC
# 1) OK                                                          <- 執行了
# 2) (error) ERR value is not an integer or out of range          <- 失敗了
# 3) OK                                                          <- 還是執行了

GET k1
# "v1"        <- 沒有被回滾
GET k2
# "v2"        <- 也執行了
```

**第二個命令失敗，但第一個和第三個都成功了，而且不會回滾。**

這和關聯式資料庫的交易完全不同：

```sql
BEGIN;
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
UPDATE accounts SET balance = balance + 100 WHERE id = 999;   -- 失敗
COMMIT;
-- 整個交易回滾，第一個 UPDATE 也被撤銷
```

**Redis 為什麼不做回滾？** 官方文件的說法大致是：Redis 命令失敗只可能是**程式設計錯誤**（型別用錯、參數錯誤），這種錯誤應該在開發階段就發現，而不是在生產環境靠回滾兜著。支援回滾會增加複雜度並降低效能，代價不值得。

你可以不同意這個設計哲學，但必須知道它的行為。

### 兩類錯誤的不同處理

**類型 1：入隊時就能發現的錯誤（語法錯誤、命令不存在）**

```bash
MULTI
# OK
SETT k1 v1              # 拼錯的命令
# (error) ERR unknown command 'SETT'
SET k2 v2
# QUEUED
EXEC
# (error) EXECABORT Transaction discarded because of previous errors.
```

**這種情況 `EXEC` 會直接中止，一個命令都不執行。** 這是「全部或全無」成立的唯一情況。

**類型 2：只有執行時才會發現的錯誤（型別錯誤等）**

就是前面那個例子：`EXEC` 照樣執行，失敗的那個回錯誤，其他的正常執行，不回滾。

### 實務結論

```text
如果你需要「多個操作要嘛全成功要嘛全失敗」
  -> MULTI/EXEC 給不了你
  -> 用 Lua（它至少能讓你自己寫判斷邏輯）
  -> 或把這個需求放回關聯式資料庫

MULTI/EXEC 適合的場景其實很窄：
  「我要把幾個彼此獨立的寫入打包，確保它們之間不被插隊」
  而且這通常也能用 Lua 做，還更清楚
```

**所以實務上 `MULTI`/`EXEC` 的使用頻率遠低於 Lua。** 它主要的價值在下一節——配合 `WATCH` 做樂觀鎖。

---

## 7.5 `WATCH`：樂觀鎖

`WATCH` 讓 `MULTI`/`EXEC` 具備 CAS（compare-and-swap）的能力。

### 語意

```bash
WATCH mykey          # 開始監視這個 key
# ... 讀取它、在應用層做判斷 ...
MULTI
# ... 排隊命令 ...
EXEC
# 如果 mykey 在 WATCH 之後被任何客戶端修改過，EXEC 回傳 nil，所有命令都不執行
```

**關鍵：`EXEC` 回傳 `nil` 代表「衝突了，請重試」，不是錯誤。**

### 實作範例：安全的餘額扣減

```javascript
async function deductBalance(userId, amount, maxRetries = 5) {
  const key = `user:balance:${userId}`;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // 1. 監視這個 key
    await redis.watch(key);

    // 2. 讀取當前值並在應用層判斷
    const current = parseInt(await redis.get(key) || '0', 10);

    if (current < amount) {
      await redis.unwatch();     // 記得取消監視，否則連線會一直持有它
      return { ok: false, reason: 'insufficient' };
    }

    // 3. 在交易裡寫入
    const result = await redis.multi()
      .set(key, current - amount)
      .exec();

    // 4. result 為 null 代表 key 被別人改過，重試
    if (result !== null) {
      return { ok: true, balance: current - amount };
    }

    // 指數退避，避免多個請求同時重試造成活鎖
    await sleep(Math.min(10 * 2 ** attempt, 200) * Math.random());
  }

  return { ok: false, reason: 'conflict-retry-exhausted' };
}
```

### 三個必須注意的細節

**細節 1：不衝突的路徑也要 `UNWATCH`。**

如果你 `WATCH` 之後決定不執行交易（例如餘額不足直接返回），必須呼叫 `UNWATCH`。否則這個連線會持續監視那個 key，影響它之後的交易。

`EXEC` 和 `DISCARD` 都會自動清除所有 `WATCH`，所以只有「提前 return」的路徑需要手動處理。

**細節 2：連線池會讓 `WATCH` 出錯。**

`WATCH` 是**連線層級的狀態**。如果你的客戶端庫從連線池取連線，`WATCH` 和 `EXEC` 可能跑在不同的連線上——那 `WATCH` 就完全沒有作用。

大部分成熟的客戶端庫會處理這件事（例如 ioredis 的 `multi()` 會綁定同一個連線，redis-py 的 `pipeline()` 也是），但**如果你自己封裝連線管理，這是一個很隱蔽的 bug**。

**細節 3：`WATCH` 在高衝突下會活鎖。**

樂觀鎖的假設是「衝突很少」。如果一千個請求同時搶同一個 key，大部分都會失敗重試，然後再衝突——整體吞吐可能比悲觀鎖更差。

```text
低衝突（例如「使用者改自己的資料」）  -> WATCH 很合適
高衝突（例如「一萬人搶同一個庫存」）  -> WATCH 會活鎖，用 Lua
```

**這就是為什麼秒殺場景要用 Lua 而不是 `WATCH`。**

### `WATCH` 在 Cluster 的限制

`MULTI` 裡的所有 key 必須在**同一個 slot**，否則會回 `CROSSSLOT` 錯誤。這對「監視 A 然後修改 B」的需求是個硬限制，除非你用 hash tag 讓它們落在同一個 slot（第 11 章）。

---

## 7.6 Lua：真正的原子邏輯

**Lua 腳本是 Redis 提供原子性的最強工具。** 因為 Redis 執行腳本時，整個腳本從頭到尾**不會被任何其他命令打斷**——這是單執行緒模型的直接推論。

### 基本用法

```bash
EVAL "return redis.call('SET', KEYS[1], ARGV[1])" 1 mykey myvalue
#                                                 ^ key 的數量
```

語法是 `EVAL script numkeys key [key ...] arg [arg ...]`：

```bash
EVAL "return {KEYS[1], KEYS[2], ARGV[1], ARGV[2]}" 2 k1 k2 a1 a2
# 1) "k1"
# 2) "k2"
# 3) "a1"
# 4) "a2"
```

### 為什麼 key 一定要放在 `KEYS` 裡

技術上你可以把 key 寫死在腳本裡：

```lua
-- 不要這樣寫
return redis.call('GET', 'product:1001')
```

**但這在 Cluster 模式下會壞掉。** Redis Cluster 需要在執行前知道這個腳本會碰哪些 key，才能判斷該把請求路由到哪個節點，以及所有 key 是否在同一個 slot。

```text
把 key 放在 KEYS  -> Cluster 能正確路由，也能檢查 slot 一致性
把 key 寫死在腳本 -> Cluster 無法判斷，可能路由到錯誤的節點
```

**所以這是硬規則：所有腳本會存取的 key，都必須透過 `KEYS` 傳入。** 即使你現在是單機，未來遷移到 Cluster 時會感謝自己。

### `EVALSHA`：不要每次都傳整份腳本

每次 `EVAL` 都把腳本內容傳過去很浪費頻寬。正確做法是先載入、之後用 SHA1 引用：

```bash
SCRIPT LOAD "return redis.call('GET', KEYS[1])"
# "4e6d8fc8bb01276962cce5371fa795a7763657ae"

EVALSHA 4e6d8fc8bb01276962cce5371fa795a7763657ae 1 mykey
```

```bash
SCRIPT EXISTS <sha1>      # 檢查腳本是否已載入
SCRIPT FLUSH              # 清空腳本快取（謹慎，會讓所有 EVALSHA 失效）
```

**實務上要處理 `NOSCRIPT` 錯誤**：Redis 重啟或執行 `SCRIPT FLUSH` 後，腳本快取會清空。標準做法是「先試 `EVALSHA`，失敗就退回 `EVAL`」：

```javascript
class LuaScript {
  constructor(redis, source) {
    this.redis = redis;
    this.source = source;
    this.sha = null;
  }

  async run(keys, args) {
    if (this.sha) {
      try {
        return await this.redis.evalsha(this.sha, keys.length, ...keys, ...args);
      } catch (err) {
        if (!String(err.message).includes('NOSCRIPT')) throw err;
        // 腳本快取失效了，往下走 EVAL 重新載入
      }
    }
    const result = await this.redis.eval(this.source, keys.length, ...keys, ...args);
    this.sha = await this.redis.script('LOAD', this.source);
    return result;
  }
}
```

好消息是**多數成熟的客戶端庫已經內建這個機制**（ioredis 的 `defineCommand`、redis-py 的 `register_script`），優先用它們：

```javascript
redis.defineCommand('deductStock', {
  numberOfKeys: 1,
  lua: `...腳本內容...`,
});

await redis.deductStock('stock:1001', 2);   // 自動處理 EVALSHA / NOSCRIPT
```

### 實例 1：原子扣庫存（防超賣）

這是 Lua 最經典的用途。用普通命令做不到：

```javascript
// 錯誤做法：有競爭
const stock = await redis.get('stock:1001');     // 讀到 1
if (stock >= 1) {                                 // 判斷通過
  await redis.decr('stock:1001');                 // 但這中間別人也扣了，變成 -1
}
```

`DECR` 本身是原子的，但它**不會阻止扣成負數**。而「先判斷再扣」這兩步之間有空隙。

Lua 版本：

```lua
-- KEYS[1] = 庫存 key
-- ARGV[1] = 要扣的數量
local stock = tonumber(redis.call('GET', KEYS[1]))

if stock == nil then
  return -1          -- key 不存在
end

local qty = tonumber(ARGV[1])
if stock < qty then
  return -2          -- 庫存不足
end

redis.call('DECRBY', KEYS[1], qty)
return stock - qty   -- 回傳剩餘庫存
```

```javascript
const DEDUCT_STOCK = `
local stock = tonumber(redis.call('GET', KEYS[1]))
if stock == nil then return -1 end
local qty = tonumber(ARGV[1])
if stock < qty then return -2 end
redis.call('DECRBY', KEYS[1], qty)
return stock - qty
`;

async function deductStock(productId, qty) {
  const result = await redis.eval(DEDUCT_STOCK, 1, `stock:${productId}`, qty);
  if (result === -1) return { ok: false, reason: 'not_found' };
  if (result === -2) return { ok: false, reason: 'insufficient' };
  return { ok: true, remaining: result };
}
```

**「讀取、判斷、寫入」三步在一個腳本裡，中間絕對不會有其他命令插入。** 這就是 Lua 的核心價值。

### 實例 2：安全解鎖

第 10 章會詳談分散式鎖，這裡先看為什麼解鎖需要 Lua：

```javascript
// 錯誤做法
const owner = await redis.get('lock:order:8888');
if (owner === myId) {
  await redis.del('lock:order:8888');    // 危險
}
```

問題在於：如果在 `GET` 和 `DEL` 之間，你的鎖剛好過期了，然後別人拿到了這個鎖——**你的 `DEL` 就會刪掉別人的鎖。**

Lua 版本：

```lua
-- KEYS[1] = 鎖的 key，ARGV[1] = 我的識別碼
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
```

### 實例 3：滑動窗口限流

```lua
-- KEYS[1] = 限流 key（ZSet）
-- ARGV[1] = 當前時間戳（毫秒）
-- ARGV[2] = 窗口大小（毫秒）
-- ARGV[3] = 窗口內允許的最大請求數
-- ARGV[4] = 本次請求的唯一 ID
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])

-- 移除窗口外的舊記錄
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - window)

local count = redis.call('ZCARD', KEYS[1])
if count >= limit then
  return 0        -- 拒絕
end

redis.call('ZADD', KEYS[1], now, ARGV[4])
redis.call('PEXPIRE', KEYS[1], window)
return 1          -- 允許
```

清理、計數、判斷、寫入四步全部原子完成。用普通命令做這件事必然有競爭。

### 實例 4：帶 TTL 的原子操作組合

第 02 章練習提過的問題：`HINCRBY` 加 `EXPIRE` 是兩個命令，中間崩潰會留下無 TTL 的 key。

```lua
-- KEYS[1] = 購物車 key，ARGV[1] = 商品 ID，ARGV[2] = 數量，ARGV[3] = TTL
local newQty = redis.call('HINCRBY', KEYS[1], ARGV[1], ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
if newQty <= 0 then
  redis.call('HDEL', KEYS[1], ARGV[1])
  return 0
end
return newQty
```

順便處理了「數量減到 0 或負數就移除該商品」的邏輯。

### Lua 的三個關鍵陷阱

**陷阱 1：數值轉換會截斷小數。**

Lua 只有一種數字型別（雙精度浮點），而 Redis 協定的整數回覆是整數。**Redis 會把 Lua 的 number 轉成整數，小數部分直接截斷（不是四捨五入）。**

```bash
EVAL "return 3.9" 0
# (integer) 3        <- 不是 4！

EVAL "return 3.2" 0
# (integer) 3
```

想回傳小數，必須轉成字串：

```bash
EVAL "return tostring(3.9)" 0
# "3.9"
```

**這個陷阱在計算金額、比例、平均值時會造成錯誤。** 規則：任何非整數的回傳值，都用 `tostring()` 包起來，讓應用層自己解析。

其他型別轉換規則：

| Lua 回傳 | Redis 收到 |
|---------|-----------|
| number | 整數（截斷小數） |
| string | 字串 |
| `true` | `1` |
| `false` | `nil`（不是 0！） |
| table（陣列） | 陣列，**遇到 `nil` 元素會截斷後面的內容** |
| `{err = "msg"}` | 錯誤回覆 |
| `{ok = "msg"}` | 狀態回覆 |

`false` 變成 `nil` 這點很容易出錯。要明確表達「否」，回傳 `0` 而不是 `false`。

table 遇到 `nil` 就截斷也是個坑：

```bash
EVAL "return {1, 2, nil, 4}" 0
# 1) (integer) 1
# 2) (integer) 2       <- 4 不見了
```

**陷阱 2：長腳本會阻塞整個 Redis。**

腳本執行期間沒有其他命令能執行。所以一個跑 10 秒的腳本 = 10 秒的服務中斷。

```bash
CONFIG GET busy-reply-threshold    # 7.0 的名稱，舊版叫 lua-time-limit
# "5000"                            <- 5 秒
```

**注意這個參數的語意常被誤解：超過這個時間後，Redis 開始對其他客戶端回覆 `BUSY` 錯誤，但腳本本身仍然繼續執行。** 它不是超時中止。

```bash
# 其他客戶端會看到：
GET foo
# (error) BUSY Redis is busy running a script. You can only call SCRIPT KILL or SHUTDOWN NOSAVE.
```

處理方式：

```bash
SCRIPT KILL         # 只能殺「還沒執行過寫入命令」的腳本
```

**如果腳本已經寫入過資料，`SCRIPT KILL` 會失敗**——因為殺掉它會留下寫了一半的狀態，破壞原子性。這時唯一的選擇是 `SHUTDOWN NOSAVE`，也就是**強制重啟並放棄未持久化的資料**。

這是很嚴重的後果，所以規則是：

```text
腳本必須短小。不要在 Lua 裡：
  - 做大迴圈（例如遍歷十萬個元素）
  - 呼叫 KEYS、SMEMBERS、HGETALL 等 O(N) 命令
  - 做複雜的字串處理或計算

Lua 的用途是「把幾個命令原子地組合起來」，不是「在 Redis 裡跑業務邏輯」
```

**陷阱 3：Cluster 模式下所有 key 必須同 slot。**

```bash
EVAL "return {redis.call('GET', KEYS[1]), redis.call('GET', KEYS[2])}" 2 key1 key2
# 在 Cluster 上可能回：
# (error) CROSSSLOT Keys in request don't hash to the same slot
```

解法是用 hash tag 強制它們落在同一個 slot：

```bash
EVAL "..." 2 "{user1001}:profile" "{user1001}:cart"
```

大括號內的部分決定 slot，所以這兩個 key 保證在同一個節點。第 11 章會詳談。

### 關於非確定性命令（時間、隨機數）

歷史上 Redis 禁止在腳本裡用 `TIME`、`SRANDMEMBER` 等非確定性命令，因為當時腳本是「以腳本本身」複製到從節點的——主從各自執行一次，結果可能不同。

Redis 5.0 之後預設改成 **effect replication**（複製腳本產生的實際寫入命令，而不是腳本本身），所以這個限制解除了。

**但實務上仍然建議把時間戳從外面傳進來**：

```javascript
// 建議
await redis.eval(script, 1, key, Date.now(), windowMs, limit);

// 而不是在 Lua 裡呼叫 redis.call('TIME')
```

理由不再是複製問題，而是：

- **可測試性**：能傳入固定時間戳寫單元測試。
- **行為可預測**：重試時用同一個時間戳，語意更明確。
- **多節點時間一致**：如果邏輯依賴時間，用客戶端統一的時間比各節點的本機時間更可控。

### 錯誤處理：`redis.call` vs `redis.pcall`

```lua
-- redis.call：命令失敗會直接拋出錯誤，中止整個腳本
redis.call('INCR', KEYS[1])

-- redis.pcall：回傳錯誤表，讓你自己處理
local ok = redis.pcall('INCR', KEYS[1])
if type(ok) == 'table' and ok.err then
  return {err = '無法遞增：' .. ok.err}
end
```

**多數情況用 `redis.call` 就好**——命令失敗通常代表程式有 bug，讓它拋出來比默默吞掉好。`pcall` 適合「預期某些操作可能失敗，且要做補償」的情況。

回傳自訂錯誤給客戶端：

```lua
if stock < qty then
  return redis.error_reply('INSUFFICIENT_STOCK')
end
```

客戶端會收到一個錯誤回覆。**這比回傳魔術數字（-1、-2）更清楚**，但要注意大部分客戶端庫會把它變成 exception，要接住它。實務上兩種風格都常見，選一種並保持一致。

### 可用的 Lua 函式庫

Redis 內建了幾個常用的庫：

```lua
cjson.encode({a = 1})          -- JSON 序列化
cjson.decode('{"a":1}')
cmsgpack.pack(...)             -- MessagePack
bit.band(a, b)                 -- 位元運算
redis.sha1hex('string')        -- SHA1
redis.log(redis.LOG_WARNING, "訊息")   -- 寫入 Redis 日誌
```

`cjson` 很實用，但要注意：**在 Lua 裡解析大 JSON 會消耗執行時間**，而執行時間就是阻塞時間。小物件沒問題，不要拿它處理幾 MB 的 JSON。

### `EVAL_RO`：唯讀腳本可以走從節點

7.0 加入了唯讀版本：

```bash
EVAL_RO "return redis.call('GET', KEYS[1])" 1 mykey
EVALSHA_RO <sha> 1 mykey
```

好處是**這類腳本可以在從節點執行**，能分擔讀流量。如果腳本裡有寫入命令，會直接報錯——這也是一種保護，避免不小心在唯讀路徑寫入資料。

---

## 7.7 Redis Functions（7.0+）

Lua 腳本有個維運上的痛點：**它不會被持久化。** Redis 重啟後腳本快取清空，所有 `EVALSHA` 都會回 `NOSCRIPT`，要靠客戶端重新載入。

Redis 7.0 的 Functions 解決了這件事：函式庫**會被存進 RDB / AOF，並複製到從節點**。

```lua
#!lua name=mylib

local function deduct_stock(keys, args)
  local stock = tonumber(redis.call('GET', keys[1]))
  if stock == nil then return -1 end
  local qty = tonumber(args[1])
  if stock < qty then return -2 end
  redis.call('DECRBY', keys[1], qty)
  return stock - qty
end

redis.register_function('deduct_stock', deduct_stock)
```

載入與呼叫：

```bash
FUNCTION LOAD "#!lua name=mylib\n..."      # 載入（或 FUNCTION LOAD REPLACE 覆蓋）
FCALL deduct_stock 1 stock:1001 2          # 呼叫
FCALL_RO some_read_fn 1 mykey              # 唯讀版本

FUNCTION LIST                               # 列出已載入的函式庫
FUNCTION STATS                              # 執行狀態
FUNCTION DUMP / FUNCTION RESTORE           # 匯出 / 匯入
FUNCTION DELETE mylib
```

**該不該用？**

```text
用 Functions 的理由：
  持久化，不必處理 NOSCRIPT
  能組織成函式庫，多個函式共用輔助程式碼
  部署與應用程式碼解耦（函式庫可以獨立更新）

暫時不用的理由：
  需要 Redis 7.0+
  客戶端庫的支援程度不一
  部署流程要多管一個「函式庫版本」的東西
  多數客戶端庫已經幫你處理好 EVALSHA/NOSCRIPT，痛點沒那麼痛
```

**建議：新專案如果確定用 7.0+ 可以評估；既有專案用 `EVALSHA` 配合客戶端庫的自動處理就足夠。** 這章的其他範例都用 Lua 腳本形式，因為它適用範圍更廣。

---

## 7.8 三者的選擇

```text
需求：發送多個彼此獨立的命令，只想減少往返
  -> Pipeline

需求：批次讀寫同型別的多個 key
  -> MGET / MSET / HMGET（單一命令，順便是原子的）

需求：讀取、判斷、寫入，且不能被插隊
  -> Lua

需求：讀取、在應用層做複雜判斷（例如要呼叫外部 API）、再寫入
  -> WATCH + MULTI（因為 Lua 裡不能呼叫外部服務）
  -> 但要接受衝突重試，且只適合低衝突場景

需求：多個寫入要打包，中間不被插隊，不需要根據結果決策
  -> MULTI/EXEC 或 Lua 都可以，Lua 通常更清楚
```

一個實用的判斷：**如果你發現自己在寫「先 GET 再判斷再 SET」，停下來改用 Lua。**

---

## 7.9 常見錯誤

### 錯誤 1：以為 Pipeline 是原子的

其他客戶端的命令可以穿插。要原子性用 Lua。

### 錯誤 2：以為 `MULTI`/`EXEC` 有回滾

沒有。執行時錯誤不會撤銷已執行的命令。

### 錯誤 3：把一百萬個命令塞進一個 Pipeline

會撐爆客戶端與 Redis 的緩衝區，也會長時間佔用單執行緒。分批 100-1000。

### 錯誤 4：`WATCH` 後提前 return 忘記 `UNWATCH`

連線會持續持有監視狀態，影響後續交易。

### 錯誤 5：在高衝突場景用 `WATCH`

會活鎖，整體吞吐比用 Lua 更差。

### 錯誤 6：在 Lua 裡把 key 寫死

Cluster 模式無法正確路由。所有 key 都要透過 `KEYS` 傳入。

### 錯誤 7：在 Lua 裡回傳小數

會被截斷成整數。用 `tostring()`。

### 錯誤 8：在 Lua 裡回傳 `false` 期待收到 `0`

`false` 會變成 `nil`。要回 `0` 就明確寫 `0`。

### 錯誤 9：在 Lua 裡跑大迴圈或 O(N) 命令

會阻塞整個實例，而且寫入過的腳本無法用 `SCRIPT KILL` 中止，只能 `SHUTDOWN NOSAVE`。

### 錯誤 10：沒處理 `NOSCRIPT` 錯誤

Redis 重啟後 `EVALSHA` 會失敗。用客戶端庫的封裝，或自己實作退回 `EVAL` 的邏輯。

### 錯誤 11：在 Lua 裡試圖呼叫外部服務

Lua 沙盒不能做網路 I/O。需要外部呼叫的邏輯只能放在應用層（然後用 `WATCH` 或分散式鎖保護）。

---

## 7.10 本章練習

### 練習 1：選出正確的工具

以下五個需求，各該用 Pipeline、`MULTI`/`EXEC`、`WATCH`、還是 Lua？說明理由。

1. 組裝使用者個人頁：讀取 profile（Hash）、粉絲數（Set）、積分排名（ZSet）、最近動態（List）。
2. 秒殺扣庫存：庫存足夠才扣，一萬人同時搶。
3. 修改使用者暱稱：需要檢查新暱稱是否已被占用，佔用檢查要查一個 Set。
4. 匯入 50 萬筆商品快取。
5. 使用者提現：檢查餘額 → 呼叫第三方支付 API → 成功後扣款。

<details>
<summary>參考解答</summary>

**1. 組裝個人頁 → Pipeline**

四個命令彼此獨立，不需要原子性（頁面資料稍有不一致可以接受），只是想省往返。

```javascript
const pipeline = redis.pipeline();
pipeline.hgetall(`user:profile:${uid}`);
pipeline.scard(`user:followers:${uid}`);
pipeline.zrevrank('rank:global', `user:${uid}`);
pipeline.lrange(`user:timeline:${uid}`, 0, 9);
const [profile, followers, rank, timeline] = await pipeline.exec();
```

4 次往返變 1 次。這是 Pipeline 最典型的用法。

**2. 秒殺扣庫存 → Lua**

需要「讀取、判斷、扣減」原子完成，而且是**高衝突**場景。

不能用 `WATCH`：一萬個請求同時衝突，絕大多數會失敗重試，重試又衝突，形成活鎖。吞吐會很差。

不能用 `MULTI`/`EXEC`：它無法根據 `GET` 的結果決定要不要 `DECR`——所有命令在 `EXEC` 前就決定了。

```javascript
const result = await redis.eval(DEDUCT_STOCK, 1, `stock:${pid}`, qty);
```

**3. 修改暱稱（要檢查佔用）→ Lua**

「檢查是否被佔用 → 佔用它 → 釋放舊的」需要原子完成，否則兩個人可能同時搶到同一個暱稱。

```lua
-- KEYS[1] = 暱稱佔用表（Set 或 Hash）
-- KEYS[2] = 使用者 profile
-- ARGV[1] = 新暱稱, ARGV[2] = 舊暱稱
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then
  return 0        -- 已被佔用
end
redis.call('SADD', KEYS[1], ARGV[1])
redis.call('SREM', KEYS[1], ARGV[2])
redis.call('HSET', KEYS[2], 'nickname', ARGV[1])
return 1
```

注意 Cluster 模式下這兩個 key 必須同 slot，需要 hash tag。

也可以用 `WATCH`（衝突機率低，因為很少有人同時搶同一個暱稱），但 Lua 更直接且沒有重試邏輯要寫。

**補充：這個做法只保證 Redis 內部一致，資料庫那邊還要有唯一索引兜底。** Redis 是加速層，不是約束的最終保證。

**4. 匯入 50 萬筆 → Pipeline 分批，或 `redis-cli --pipe`**

```javascript
// 應用程式裡分批
for (let i = 0; i < products.length; i += 500) {
  const pipeline = redis.pipeline();
  for (const p of products.slice(i, i + 500)) {
    pipeline.set(`product:${p.id}`, JSON.stringify(p), 'EX', 3600);
  }
  await pipeline.exec();
}
```

或用 CLI 工具（更快，適合一次性遷移）：

```bash
node generate-commands.js > commands.txt
redis-cli -a pass --pipe < commands.txt
```

**關鍵是分批**，不要一次 50 萬。而且建議在批次之間加一點延遲，避免這個匯入任務把線上服務的延遲拖高。

**5. 提現（含第三方 API）→ `WATCH` + `MULTI`，或分散式鎖**

**這題的關鍵是：Lua 裡不能呼叫外部服務。** Lua 沙盒沒有網路能力，而且就算有也絕對不該這樣做——一個等待 HTTP 回應的腳本會阻塞整個 Redis 好幾秒。

所以流程必須拆開：

```javascript
async function withdraw(userId, amount) {
  const key = `user:balance:${userId}`;

  // 1. 用 WATCH 保護「檢查餘額並預扣」
  await redis.watch(key);
  const balance = parseInt(await redis.get(key) || '0', 10);
  if (balance < amount) {
    await redis.unwatch();
    return { ok: false, reason: 'insufficient' };
  }

  // 2. 先預扣（凍結），避免併發重複提現
  const frozen = await redis.multi()
    .decrby(key, amount)
    .hset(`withdraw:pending:${userId}`, requestId, amount)
    .exec();

  if (frozen === null) {
    return { ok: false, reason: 'conflict' };   // 重試
  }

  // 3. 呼叫第三方（這一步在 Redis 之外，可能耗時數秒）
  try {
    await paymentGateway.transfer(userId, amount, requestId);
    await redis.hdel(`withdraw:pending:${userId}`, requestId);
    return { ok: true };
  } catch (err) {
    // 4. 失敗要補償：把錢還回去
    await redis.multi()
      .incrby(key, amount)
      .hdel(`withdraw:pending:${userId}`, requestId)
      .exec();
    return { ok: false, reason: 'gateway_error' };
  }
}
```

**但這個實作在真實金流場景仍然不夠。** 三個問題：

1. **補償步驟本身可能失敗**（Redis 掛了、行程崩潰）。錢被凍結但沒退回，需要對帳任務修復。
2. **第三方 API 的結果可能不確定**（超時，但實際上成功了）。必須靠 `requestId` 做幂等，並主動查詢對方的最終狀態。
3. **餘額不該只存在 Redis。** 這是本課反覆強調的原則。

**真實的提現流程應該是：關聯式資料庫的交易負責餘額變動與流水記錄，Redis 最多用來做「防重複提交」的分散式鎖與限流。** 這題的重點是理解「有外部呼叫時 Lua 不適用」，而不是把這段程式碼拿去用在真的金流系統。

</details>

### 練習 2：找出並修正競爭問題

以下三段程式碼各有競爭問題，用 Lua 改寫。

```javascript
// (a) 限流：每分鐘最多 60 次
async function rateLimit(ip) {
  const key = `rate:${ip}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, 60);
  }
  return count <= 60;
}

// (b) 只在分數更高時更新排行榜
async function updateScore(userId, score) {
  const current = await redis.zscore('rank', userId);
  if (current === null || score > Number(current)) {
    await redis.zadd('rank', score, userId);
  }
}

// (c) 從等待佇列取出一人並加入房間，房間上限 100 人
async function admitOne(roomId) {
  const size = await redis.scard(`room:${roomId}`);
  if (size >= 100) return null;
  const userId = await redis.lpop(`queue:${roomId}`);
  if (!userId) return null;
  await redis.sadd(`room:${roomId}`, userId);
  return userId;
}
```

<details>
<summary>參考解答</summary>

**(a) 的問題：`INCR` 和 `EXPIRE` 之間可能崩潰，留下永不過期的 key。**

一旦 TTL 沒設上，這個 IP 的計數就永遠不會重置——使用者被永久封鎖了。而且這個 key 會永久佔記憶體（第 01 章的問題）。

```javascript
const RATE_LIMIT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`;

async function rateLimit(ip, limit = 60, window = 60) {
  const count = await redis.eval(RATE_LIMIT, 1, `rate:${ip}`, window);
  return count <= limit;
}
```

**更保險的版本**：處理「key 已存在但不知為何沒有 TTL」的情況：

```lua
local count = redis.call('INCR', KEYS[1])
if count == 1 or redis.call('TTL', KEYS[1]) == -1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
```

`TTL == -1` 代表存在但沒有過期時間，這時補設一個。這讓函式具備自我修復能力，即使歷史上有髒資料也能恢復正常。

**注意這仍是「固定窗口」限流，有邊界突刺問題**：窗口交界處的兩秒內可能通過兩倍的請求量。要更精確就用第 7.6 節的滑動窗口版本，第 10 章會完整比較各種限流演算法。

**(b) 的問題：`ZSCORE` 和 `ZADD` 之間別人可能寫入更高的分數，然後被你較低的分數覆蓋。**

```text
當前分數 100
請求 A（分數 150）：讀到 100，判斷 150 > 100，準備寫
請求 B（分數 200）：讀到 100，判斷 200 > 100，寫入 200
請求 A：寫入 150     <- 覆蓋掉了 200！
```

**最好的解法根本不需要 Lua——用 `ZADD` 的 `GT` 選項（Redis 6.2+）：**

```javascript
async function updateScore(userId, score) {
  await redis.zadd('rank', 'GT', 'CH', score, userId);
}
```

`GT` 表示「只在新分數大於現有分數時更新」，而且 key 不存在時也會插入。這是原子的單一命令，比 Lua 更簡潔也更快。

**這題想說明一個重要的習慣：寫 Lua 之前，先確認有沒有現成的原子命令能做這件事。** 常見的原子選項：

| 需求 | 原子命令 |
|------|---------|
| 只在分數更高時更新 | `ZADD key GT score member` |
| 只在 key 不存在時設定 | `SET key val NX` |
| 只在 field 不存在時設定 | `HSETNX` |
| 只延長不縮短 TTL | `EXPIRE key sec GT` |
| 取舊值並設新值 | `SET key val GET` |

如果你的 Redis 是 6.2 以前的版本，才需要 Lua：

```lua
local current = redis.call('ZSCORE', KEYS[1], ARGV[2])
if current == false or tonumber(ARGV[1]) > tonumber(current) then
  redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
  return 1
end
return 0
```

注意 `ZSCORE` 對不存在的 member 回傳的是 Lua 的 `false`（不是 `nil`），這是很容易寫錯的地方。

**(c) 的問題：三個命令之間都有空隙，會造成兩種錯誤。**

```text
錯誤 1：超過上限
  房間 99 人，兩個請求同時檢查（都看到 99），都通過，都加入 -> 101 人

錯誤 2：使用者遺失（更嚴重）
  LPOP 成功取出使用者，但接下來 SADD 之前行程崩潰
  -> 這個人從佇列裡消失了，也沒進到房間
  -> 資料永久遺失，使用者會發現自己「排隊排到不見了」
```

```lua
-- KEYS[1] = 房間 Set, KEYS[2] = 等待佇列 List
-- ARGV[1] = 房間上限
local size = redis.call('SCARD', KEYS[1])
if size >= tonumber(ARGV[1]) then
  return {0, 'room_full'}
end

local userId = redis.call('LPOP', KEYS[2])
if not userId then
  return {0, 'queue_empty'}
end

redis.call('SADD', KEYS[1], userId)
return {1, userId}
```

```javascript
const ADMIT_ONE = `...上面的腳本...`;

async function admitOne(roomId, limit = 100) {
  const [ok, value] = await redis.eval(
    ADMIT_ONE, 2, `room:${roomId}`, `queue:${roomId}`, limit
  );
  return ok === 1 ? { ok: true, userId: value } : { ok: false, reason: value };
}
```

**三個實作細節：**

**細節一：`LPOP` 對空 List 回傳 `false`，不是 `nil`。** 所以判斷要用 `if not userId`。這和 (b) 的 `ZSCORE` 是同一類陷阱——Redis 的「空回覆」在 Lua 裡是 `false`。

**細節二：回傳 table 帶上原因。** 比只回傳 0/1 更好除錯，呼叫方能區分「房滿」和「佇列空」這兩種完全不同的情況。

**細節三：Cluster 模式下 `room:{id}` 和 `queue:{id}` 必須同 slot。** 要寫成 `room:{room123}` 和 `queue:{room123}`，用 hash tag 綁定。

**如果房間上限的判斷可以放寬呢？** 值得提一下取捨：如果業務允許「偶爾多一兩個人」，那用 `SADD` 加上定期修正也可以，程式更簡單。但「使用者從佇列消失」這個問題**不能放寬**——那是資料遺失。所以即使放寬上限，`LPOP` + `SADD` 這兩步仍然必須原子。

</details>

### 練習 3：實測 Pipeline 的效果，並驗證 Lua 的原子性

<details>
<summary>參考解答</summary>

**實驗 1：測量 Pipeline 的效能差異**

```bash
docker compose exec redis sh
```

用 `redis-benchmark` 內建的 pipeline 參數對比：

```sh
# 不用 pipeline
redis-cli -a mysecret FLUSHDB
redis-benchmark -a mysecret -t set -n 100000 -q
# SET: 45000 requests per second

# pipeline 深度 16
redis-benchmark -a mysecret -t set -n 100000 -P 16 -q
# SET: 400000 requests per second

# pipeline 深度 100
redis-benchmark -a mysecret -t set -n 100000 -P 100 -q
# SET: 700000 requests per second

# pipeline 深度 1000
redis-benchmark -a mysecret -t set -n 100000 -P 1000 -q
# 提升幅度明顯變小，甚至可能下降
```

**觀察兩件事：**

1. 從 1 到 16 的提升最大（可能 10 倍），這是「消除往返」的收益。
2. 從 100 到 1000 的提升很小甚至變差——**因為此時瓶頸已經不是網路往返，而是 Redis 的實際處理能力和緩衝區管理。**

這驗證了「批次 100-1000」的建議：再往上沒有收益，只增加記憶體風險。

注意這是在容器內測（loopback 網路，RTT 極低）。**在真實的跨機器環境，Pipeline 的收益會更大**，因為 RTT 更高。可以從容器外測一次對比：

```bash
# 從宿主機測（多了一層 Docker 網路）
redis-benchmark -h 127.0.0.1 -p 6379 -a mysecret -t set -n 20000 -q
redis-benchmark -h 127.0.0.1 -p 6379 -a mysecret -t set -n 20000 -P 50 -q
```

**實驗 2：驗證「先判斷再扣」的競爭問題確實存在**

先寫一個有 bug 的版本，用併發驗證它會超賣：

```sh
redis-cli -a mysecret SET stock:test 100

# 用 50 個並發連線，每個嘗試扣 1，共 200 次（庫存只有 100）
# 模擬「先 GET 判斷再 DECR」的錯誤做法
for i in $(seq 1 200); do
  (
    stock=$(redis-cli -a mysecret --no-auth-warning GET stock:test)
    if [ "$stock" -gt 0 ]; then
      redis-cli -a mysecret --no-auth-warning DECR stock:test > /dev/null
    fi
  ) &
  # 控制併發數
  if [ $((i % 50)) -eq 0 ]; then wait; fi
done
wait

redis-cli -a mysecret GET stock:test
```

**結果應該是負數**（例如 `-15`），也就是超賣了。因為多個行程同時讀到正數，然後都執行了扣減。

**實驗 3：驗證 Lua 版本不會超賣**

```sh
redis-cli -a mysecret SET stock:test 100

# 把腳本存起來
SHA=$(redis-cli -a mysecret --no-auth-warning SCRIPT LOAD "
local stock = tonumber(redis.call('GET', KEYS[1]))
if stock == nil then return -1 end
local qty = tonumber(ARGV[1])
if stock < qty then return -2 end
redis.call('DECRBY', KEYS[1], qty)
return stock - qty
")
echo "SHA: $SHA"

# 同樣 200 次併發
for i in $(seq 1 200); do
  redis-cli -a mysecret --no-auth-warning EVALSHA "$SHA" 1 stock:test 1 > /dev/null &
  if [ $((i % 50)) -eq 0 ]; then wait; fi
done
wait

redis-cli -a mysecret GET stock:test
# "0"        <- 精確扣到 0，不會變負數
```

**庫存精確停在 0，多出的 100 次請求全部被正確拒絕（回傳 -2）。** 這就是 Lua 原子性的直接證明。

想看清楚拒絕的次數：

```sh
redis-cli -a mysecret SET stock:test 100
SUCCESS=0
FAIL=0
for i in $(seq 1 200); do
  r=$(redis-cli -a mysecret --no-auth-warning EVALSHA "$SHA" 1 stock:test 1)
  if [ "$r" = "-2" ]; then FAIL=$((FAIL+1)); else SUCCESS=$((SUCCESS+1)); fi
done
echo "成功 $SUCCESS 次，拒絕 $FAIL 次"
# 成功 100 次，拒絕 100 次
```

（這個版本是循序執行的，所以慢，但數字最清楚。）

**實驗 4：體驗長腳本的阻塞與 `SCRIPT KILL`**

```sh
redis-cli -a mysecret CONFIG GET busy-reply-threshold
# "5000"

# 終端 A：跑一個純讀取的無窮迴圈腳本
redis-cli -a mysecret EVAL "while true do end" 0
```

終端 B 嘗試任何命令：

```sh
redis-cli -a mysecret GET foo
# (error) BUSY Redis is busy running a script. You can only call SCRIPT KILL or SHUTDOWN NOSAVE.
```

**整個 Redis 都不能用了。** 因為這個腳本沒有執行過寫入，可以殺掉：

```sh
redis-cli -a mysecret SCRIPT KILL
# OK
```

終端 A 會收到腳本被中止的錯誤。

**再試一個「已經寫入過」的腳本：**

```sh
# 終端 A
redis-cli -a mysecret EVAL "redis.call('SET', KEYS[1], 'x') while true do end" 1 tmp:key
```

```sh
# 終端 B
redis-cli -a mysecret SCRIPT KILL
# (error) UNKILLABLE Sorry the script already executed write commands against
# the dataset. You can either wait the script termination or kill the server in
# a hard way using the SHUTDOWN NOSAVE command.
```

**殺不掉了。** 唯一的出路是 `SHUTDOWN NOSAVE`——強制重啟並放棄未持久化的資料。

```sh
redis-cli -a mysecret SHUTDOWN NOSAVE
# 容器會退出，需要重啟
```

```bash
docker compose up -d
```

**這個實驗的結論很直接：一個寫死迴圈的 Lua 腳本，可以讓你的整個 Redis 服務必須強制重啟並遺失資料。** 這就是為什麼「腳本必須短小」不是建議，而是硬要求。

實務上的防護：

- Code review 時特別檢查 Lua 腳本裡的迴圈與 O(N) 命令。
- 腳本的迴圈次數要有明確上限，且由 `ARGV` 控制而非資料量決定。
- 測試環境用大資料量壓過一遍，量測腳本的實際執行時間。

</details>

---

## 7.11 驗收清單

進入下一章前，確認你可以：

- [ ] 說明 Pipeline 解決往返問題但不提供原子性。
- [ ] 算出往返次數對總延遲的影響，並說出建議的批次大小與理由。
- [ ] 說明 `MULTI`/`EXEC` 沒有回滾，以及兩類錯誤的不同處理。
- [ ] 寫出一個正確的 `WATCH` 重試迴圈，包含 `UNWATCH` 的處理。
- [ ] 說明 `WATCH` 在高衝突場景為什麼會活鎖。
- [ ] 用 Lua 實作「判斷後扣減」，並解釋它的原子性從何而來。
- [ ] 說明為什麼所有 key 都必須透過 `KEYS` 傳入。
- [ ] 說出 Lua 的型別轉換陷阱：小數截斷、`false` 變 `nil`、table 遇 `nil` 截斷。
- [ ] 說明 `busy-reply-threshold` 的真實語意，以及寫入過的腳本為什麼殺不掉。
- [ ] 處理 `NOSCRIPT` 錯誤，或說明客戶端庫怎麼幫你處理。
- [ ] 在寫 Lua 之前，先檢查有沒有現成的原子命令（`ZADD GT`、`SET NX`、`EXPIRE GT` 等）。

---

下一章處理訊息傳遞：[08-pubsub-and-streams.md](./08-pubsub-and-streams.md)，我們會看 Pub/Sub 為什麼「即發即失」不可靠，以及 Stream 的消費者群組如何提供真正的可靠消費。
