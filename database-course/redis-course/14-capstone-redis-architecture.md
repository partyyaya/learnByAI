# 第 14 章：Capstone — 電商直播平台的 Redis 架構

> 前面十三章各自解決一個問題。這章要把它們放在同一張圖上，因為真實系統的難處從來不是「單一技術怎麼用」，而是**十幾種需求擠在同一個 Redis 裡時，彼此的取捨會互相衝突**。
> 秒殺庫存不能被驅逐，商品快取巴不得被驅逐；Session 不能丟，彈幕丟了無所謂；排行榜要即時，訂單事件要可靠。把它們全塞進一個實例、設一組參數，等於同時做錯十件事。
> 這章要示範的不是「一個標準答案」，而是**一套推導的順序**：先分類資料、再決定每類的定位、才選結構與參數。走完之後，你手上會有一份可以直接拿去實作的設計文件。

---

## 14.1 學習目標

完成本章後，你應該可以：

- 用「資料定位」而不是「功能清單」作為架構設計的起點。
- 為六個典型場景選出正確的資料結構，並說出被淘汰的選項為什麼不合適。
- 設計一份完整、可執行的 key 命名與生命週期規範。
- 寫出秒殺場景的原子扣減腳本，並說明它為什麼不需要分散式鎖。
- 判斷哪些資料該拆到獨立實例，以及拆的依據是什麼。
- 為每一類資料訂出 RPO / RTO，並選擇對應的持久化與高可用方案。
- 估算記憶體、QPS 與網路頻寬，並規劃 12 個月的成長。
- 產出一份完整的架構設計文件與上線檢查表。

---

## 14.2 需求規格

### 業務背景

一個電商直播平台：主播開直播，觀眾在直播間裡看商品、搶限量優惠、下單。

### 功能需求

| 編號 | 功能 | 說明 |
|------|------|------|
| F1 | 登入與 Session | 多台應用伺服器共享登入狀態，閒置 30 分鐘登出 |
| F2 | 商品資訊 | 商品詳情頁，讀多寫少 |
| F3 | 購物車 | 加購、修改數量、刪除、結算；未登入也能用 |
| F4 | 直播間即時資料 | 線上人數、本場成交額、彈幕 |
| F5 | 限量秒殺 | 主播喊「三、二、一」開搶，限量 500 件，不能超賣 |
| F6 | 直播間排行榜 | 觀眾打賞金額 Top 20，即時更新 |
| F7 | 限流防刷 | 防止腳本刷單、API 濫用 |
| F8 | 訂單事件流 | 下單後觸發：扣庫存、發通知、更新統計、風控檢查 |

### 非功能需求

| 編號 | 需求 | 數值 |
|------|------|------|
| N1 | 尖峰同時在線 | 50 萬人（分布在 500 個直播間） |
| N2 | 秒殺瞬時 QPS | 20 萬（3 秒內湧入） |
| N3 | 平常 QPS | 讀 8 萬 / 寫 1 萬 |
| N4 | 商品詳情 P99 | < 50ms |
| N5 | 秒殺回應 P99 | < 200ms |
| N6 | 絕對不能超賣 | 硬性要求 |
| N7 | Session 不能大量遺失 | 大量登出會造成客訴尖峰 |
| N8 | 團隊規模 | 5 名後端，1 名兼職 SRE |

---

## 14.3 第一步：資料定位（最重要的一步）

**不要從「用什麼資料結構」開始。** 先問每一類資料三個問題：

```text
Q1. Redis 是它的「事實來源」，還是只是「加速層」？
Q2. 它掉了會怎樣？（決定持久化與高可用等級）
Q3. 它能不能被驅逐？（決定 maxmemory-policy 與實例歸屬）
```

把八項功能的資料攤開來回答：

| 資料 | 事實來源 | 掉了會怎樣 | 可驅逐 | RPO 目標 |
|------|---------|-----------|--------|---------|
| Session | **Redis** | 使用者被登出（N7 說不行） | **否** | < 1 分鐘 |
| 商品快取 | MySQL | 回源重建，變慢而已 | **是** | 不適用 |
| 購物車 | **Redis**（未登入）/ MySQL（已登入） | 未登入的購物車消失 | **否** | < 5 分鐘 |
| 直播間人數 | **Redis** | 數字歸零，可重算 | 是 | 不適用 |
| 彈幕 | **Redis**（短期） | 歷史彈幕消失 | 是 | 不適用 |
| **秒殺庫存** | **Redis**（活動期間） | **可能超賣或少賣** | **絕對否** | **≈ 0** |
| 打賞排行榜 | MySQL（流水）/ Redis（榜單） | 榜單重算即可 | 否 | < 1 分鐘 |
| 限流計數 | **Redis** | 限流短暫失效 | 是 | 不適用 |
| 訂單事件流 | **Redis Stream** | **訂單後續動作不執行** | **絕對否** | **≈ 0** |

**這張表已經決定了大部分架構。** 三個直接的結論：

**結論 1：秒殺庫存和訂單事件流不能和快取放在同一個實例。**

因為它們絕對不能被驅逐，而快取巴不得被驅逐。放在一起的話你只能選 `noeviction`（記憶體滿了寫入報錯）或 `allkeys-lru`（庫存可能被踢掉）——兩個都是災難。

**結論 2：Session 是「Redis 當事實來源」，但 N7 說它不能大量遺失。**

第 11 章講過，Redis 的非同步複製必然有 RPO。要滿足 N7，有兩條路：

```text
路徑 A：接受 Redis 的保證，用主從 + AOF everysec 把 RPO 壓到秒級
        故障轉移時仍會丟少量 Session（幾百到幾千個使用者要重新登入）

路徑 B：改架構讓 Session 不再是單點
        JWT 帶簽章存在客戶端 + Redis 只存「撤銷黑名單」
        Redis 全掛時使用者不會被登出，只是「登出功能」暫時失效
```

**路徑 B 才是真正的解法。** 這呼應第 11 章練習 3 的結論：**如果某份資料遺失的後果很嚴重，那架構上就不該讓它只存在 Redis 裡。** 本設計採用路徑 B。

**結論 3：訂單事件流用 Stream，不能用 Pub/Sub。**

第 08 章講得很清楚：Pub/Sub 即發即失。訂單後續動作（扣庫存、發通知）漏掉是不可接受的，必須要有確認與重試。

---

## 14.4 第二步：實例拆分

根據上一步的分類，**在設計任何 key 之前先決定實例劃分**——因為它決定了後面所有的參數設定。

```text
┌─────────────────────────────────────────────────────────────────┐
│ 實例 A：快取（cache）                                             │
│   資料：商品快取、直播間快照、其他可重建的資料                       │
│   maxmemory-policy: allkeys-lru        ← 樂於驅逐                 │
│   持久化：關閉（重啟後回源重建即可）                                 │
│   高可用：主從 + Sentinel（為了零中斷維運，不是為了資料）             │
│   規模：32GB × (1 主 + 2 從)                                      │
├─────────────────────────────────────────────────────────────────┤
│ 實例 B：狀態（state）                                             │
│   資料：購物車、Session 黑名單、直播間人數、排行榜                   │
│   maxmemory-policy: volatile-lru       ← 只驅逐有 TTL 的           │
│   持久化：AOF everysec                                            │
│   高可用：主從 + Sentinel，min-replicas-to-write 1                │
│   規模：16GB × (1 主 + 2 從)                                      │
├─────────────────────────────────────────────────────────────────┤
│ 實例 C：交易（transaction）★ 最重要                                │
│   資料：秒殺庫存、訂單事件 Stream、分散式鎖                          │
│   maxmemory-policy: noeviction         ← 絕對不驅逐               │
│   持久化：AOF everysec + 每小時 RDB                                │
│   高可用：主從 + Sentinel，min-replicas-to-write 1                │
│   規模：8GB × (1 主 + 2 從)（資料量小，但要最好的機器）              │
├─────────────────────────────────────────────────────────────────┤
│ 實例 D：限流（ratelimit）                                         │
│   資料：限流計數器、令牌桶                                          │
│   maxmemory-policy: allkeys-lru                                  │
│   持久化：關閉（重啟後限流重新計算，可接受）                          │
│   高可用：單機即可（掛了 fail-open + 本地兜底，第 10 章）             │
│   規模：8GB × 1                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**為什麼是四個實例而不是一個 Cluster**（呼應第 11 章）：

| 理由 | 說明 |
|------|------|
| 參數需求衝突 | 四種 `maxmemory-policy`、三種持久化設定，一個實例做不到 |
| 故障隔離 | 快取實例被 big key 拖慢，不能影響秒殺 |
| 團隊規模 | 5 個後端 + 0.5 個 SRE，Cluster 的維運複雜度太高 |
| 沒有命令限制 | 秒殺的 Lua 需要操作多個 key，Cluster 下要處理 hash tag |
| 用滿多核心 | 四個實例可以跑在同一台機器的不同核心（第 04 章） |

**什麼時候才需要 Cluster**：當**單一實例**的資料量或寫入量超過單機能力時。以本案的估算（14.10 節）距離還很遠。

---

## 14.5 第三步：Key 設計總表

第 01 章的規範在這裡落地。統一格式：

```text
<業務域>:<實體>:<識別碼>[:<子維度>]
```

| 實例 | Key | 型別 | TTL | 說明 |
|------|-----|------|-----|------|
| A | `cache:product:{pid}` | String(JSON) | 300s±20% | 商品詳情 |
| A | `cache:product:list:{cid}` | String(JSON) | 60s±20% | 分類列表 |
| A | `cache:live:{lid}:snapshot` | Hash | 30s | 直播間快照（給列表頁） |
| B | `cart:{uid}` | Hash | 30d | 已登入購物車（field = pid） |
| B | `cart:guest:{token}` | Hash | 7d | 未登入購物車 |
| B | `auth:revoked:{jti}` | String | = JWT 剩餘有效期 | JWT 撤銷黑名單 |
| B | `live:{lid}:online` | String(計數) | 12h | 直播間線上人數 |
| B | `live:{lid}:members` | Set | 12h | 去重用（誰在房間） |
| B | `live:{lid}:gmv` | String(計數) | 30d | 本場成交額（分） |
| B | `live:{lid}:gift:rank` | ZSet | 30d | 打賞排行榜 |
| B | `live:{lid}:danmaku` | Stream | 2h（MAXLEN 1000） | 彈幕 |
| B | `live:ranking:online` | ZSet | — | 全站直播間熱度榜 |
| **C** | `seckill:{aid}:stock` | String(計數) | 活動結束+24h | **秒殺庫存** |
| **C** | `seckill:{aid}:bought` | Set | 活動結束+24h | **已購買使用者（防重）** |
| **C** | `stream:order:events` | Stream | MAXLEN ~100000 | **訂單事件流** |
| C | `lock:order:{oid}` | String | 30s | 訂單處理鎖 |
| D | `rate:ip:{ip}` | Hash（令牌桶） | 自動 | IP 限流 |
| D | `rate:user:{uid}` | Hash（令牌桶） | 自動 | 使用者限流 |
| D | `rate:seckill:{aid}:{uid}` | String | 活動期間 | 秒殺專用限流 |

**四條規範，寫進團隊文件：**

1. **一律小寫，用 `:` 分隔，不用底線或駝峰。**
2. **每個 key 都必須有 TTL**，除非在上表中明確標註為 `—` 並說明理由。
3. **不允許在程式碼裡拼接 key 字串**，一律走集中的 key builder：

```javascript
// src/lib/keys.js —— 所有 key 的唯一來源
const keys = {
  cache: {
    product: (pid) => `cache:product:${pid}`,
    productList: (cid) => `cache:product:list:${cid}`,
    liveSnapshot: (lid) => `cache:live:${lid}:snapshot`,
  },
  cart: {
    user: (uid) => `cart:${uid}`,
    guest: (token) => `cart:guest:${token}`,
  },
  auth: {
    revoked: (jti) => `auth:revoked:${jti}`,
  },
  live: {
    online: (lid) => `live:${lid}:online`,
    members: (lid) => `live:${lid}:members`,
    gmv: (lid) => `live:${lid}:gmv`,
    giftRank: (lid) => `live:${lid}:gift:rank`,
    danmaku: (lid) => `live:${lid}:danmaku`,
    rankingOnline: () => `live:ranking:online`,
  },
  seckill: {
    stock: (aid) => `seckill:${aid}:stock`,
    bought: (aid) => `seckill:${aid}:bought`,
  },
  stream: {
    orderEvents: () => 'stream:order:events',
  },
  lock: {
    order: (oid) => `lock:order:${oid}`,
  },
  rate: {
    ip: (ip) => `rate:ip:${ip}`,
    user: (uid) => `rate:user:${uid}`,
    seckill: (aid, uid) => `rate:seckill:${aid}:${uid}`,
  },
};

module.exports = keys;
```

4. **key 前綴對應 ACL 權限邊界**（第 13 章）——這是為什麼前綴規範必須嚴格：權限是靠它來劃的。

---

## 14.6 第四步：Session（F1）

### 為什麼不用「Session 存 Redis」

傳統做法：

```javascript
// 傳統做法：Session 是 Redis 上的一個 key
await redis.setex(`session:${sessionId}`, 1800, JSON.stringify({ userId, role }));
```

問題在 N7：Redis 故障轉移會丟掉未複製的 Session，**那些使用者會被登出**。50 萬在線的話，這是一次可見的客訴尖峰。

### 採用的方案：JWT + 撤銷黑名單

```text
登入   -> 簽發 JWT（含 userId、role、jti、exp），存在客戶端
驗證   -> 驗簽 + 檢查 Redis 黑名單裡有沒有這個 jti
登出   -> 把 jti 寫進黑名單，TTL = JWT 的剩餘有效期
```

```javascript
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const keys = require('../lib/keys');

const ACCESS_TTL = 1800;        // 30 分鐘，對應「閒置 30 分鐘登出」
const REFRESH_TTL = 30 * 86400;

function issueToken(user) {
  const jti = crypto.randomUUID();
  return jwt.sign(
    { sub: user.id, role: user.role, jti },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TTL }
  );
}

async function verifyToken(token) {
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return null;                            // 簽章錯或已過期
  }

  // 檢查撤銷黑名單
  try {
    const revoked = await stateRedis.exists(keys.auth.revoked(payload.jti));
    if (revoked) return null;
  } catch (err) {
    // ★ 關鍵決策：Redis 掛掉時，選擇「放行」而不是「全部登出」
    metrics.increment('auth.revocation_check_degraded');
    logger.warn({ err }, 'revocation check unavailable, allowing token');
  }

  return payload;
}

async function logout(payload) {
  const remaining = payload.exp - Math.floor(Date.now() / 1000);
  if (remaining > 0) {
    await stateRedis.setex(keys.auth.revoked(payload.jti), remaining, '1');
  }
}
```

**那個 `catch` 裡的決策要說清楚**：Redis 不可用時，我們選擇讓 token 通過。這意味著**登出功能在 Redis 故障期間會失效**（已登出的 token 仍可用，最多到它自然過期為止）。

這是一個明確的取捨：

```text
選擇放行：Redis 掛掉時，50 萬人正常使用，但登出延遲生效
選擇拒絕：Redis 掛掉時，50 萬人全部被登出   ← 違反 N7
```

**對這個業務來說前者明顯更好。** 但如果是銀行系統，答案會相反——那時「登出必須立刻生效」是安全需求，寧可全部登出。

**這種取捨要寫進設計文件並讓業務方確認**，不能由工程師默默決定。

### 黑名單的記憶體估算

```text
只有「主動登出」的使用者才進黑名單
假設每日活躍 200 萬人，其中 5% 主動登出 = 10 萬個 jti
每個 jti key 約 80 bytes × 10 萬 = 8 MB
```

比存 200 萬個完整 Session（約 1.6GB）少了兩個數量級。

---

## 14.7 第五步：購物車（F3）

### 結構選擇

| 選項 | 評估 |
|------|------|
| String 存整份 JSON | ✗ 改一個商品數量要整份讀寫，且有併發覆蓋問題 |
| **Hash（field = 商品 ID）** | ✓ 單一商品增刪改都是 O(1) 原子操作 |
| ZSet（score = 加入時間） | 只有在需要「按加入順序排序」時才值得，多數 UI 不需要 |

**用 Hash**。這正是第 00 章那個 `HINCRBY` 例子的實際應用——「數量 +1」在伺服器端原子完成，不需要讀出來改再寫回。

```javascript
const CART_TTL_USER = 30 * 86400;
const CART_TTL_GUEST = 7 * 86400;
const MAX_CART_ITEMS = 100;

// 加入購物車（用 Lua 保證「檢查上限 + 加入」的原子性）
const ADD_TO_CART = `
local key = KEYS[1]
local pid = ARGV[1]
local qty = tonumber(ARGV[2])
local maxItems = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

-- 已存在的商品直接加數量，不受品項上限限制
if redis.call('HEXISTS', key, pid) == 0 then
  if redis.call('HLEN', key) >= maxItems then
    return -1                                  -- 超過品項上限
  end
end

local newQty = redis.call('HINCRBY', key, pid, qty)
if newQty <= 0 then
  redis.call('HDEL', key, pid)                 -- 數量歸零就移除
  newQty = 0
end
redis.call('EXPIRE', key, ttl)                 -- 每次操作都續期
return newQty`;

async function addToCart(userId, guestToken, productId, qty) {
  const key = userId ? keys.cart.user(userId) : keys.cart.guest(guestToken);
  const ttl = userId ? CART_TTL_USER : CART_TTL_GUEST;

  const result = await stateRedis.eval(
    ADD_TO_CART, 1, key, String(productId), String(qty),
    String(MAX_CART_ITEMS), String(ttl));

  if (result === -1) throw new CartFullError();
  return result;
}

// 讀取購物車：Redis 只存「商品 ID + 數量」，商品詳情從快取取
async function getCart(userId, guestToken) {
  const key = userId ? keys.cart.user(userId) : keys.cart.guest(guestToken);
  const items = await stateRedis.hgetall(key);       // 最多 100 個 field，安全

  const pids = Object.keys(items);
  if (pids.length === 0) return [];

  // 批次取商品詳情（走快取實例）
  const products = await getProductsBatch(pids);

  return pids.map(pid => ({
    product: products[pid],
    quantity: parseInt(items[pid], 10),
  })).filter(x => x.product);      // 商品已下架就不顯示
}
```

**三個設計決策：**

**購物車只存 ID 和數量，不存商品快照。** 否則價格變動時購物車會顯示舊價格，而且記憶體用量會膨脹幾十倍。代價是每次讀購物車要多一次批次查詢——但那走的是快取實例，很便宜。

**`HGETALL` 在這裡是安全的**，因為有 `MAX_CART_ITEMS = 100` 的硬上限。這正是第 04 章「big key」的反面示範：**只要你能保證 field 數量有界，`HGETALL` 就沒問題。** 危險的從來不是命令本身，是無界的資料。

**每次操作都 `EXPIRE` 續期**，所以「30 天」的語意是「最後一次操作後 30 天」，符合使用者直覺。

### 登入時的購物車合併

```javascript
const MERGE_CART = `
local guestKey = KEYS[1]
local userKey = KEYS[2]
local ttl = tonumber(ARGV[1])

local guestItems = redis.call('HGETALL', guestKey)
if #guestItems == 0 then return 0 end

for i = 1, #guestItems, 2 do
  redis.call('HINCRBY', userKey, guestItems[i], tonumber(guestItems[i+1]))
end
redis.call('EXPIRE', userKey, ttl)
redis.call('DEL', guestKey)
return #guestItems / 2`;
```

用 Lua 是因為「讀訪客車 + 逐項合併 + 刪訪客車」必須原子——否則在合併中途失敗會造成商品重複或遺失。

---

## 14.8 第六步：秒殺庫存（F5）★ 核心

這是整個系統最關鍵的部分，N6 說「絕對不能超賣」。

### 為什麼不用分散式鎖

第 10 章的結論在這裡直接適用：

```text
用鎖：20 萬個請求排隊搶同一把鎖
      -> 吞吐量崩潰，且鎖有失效邊界（主從切換、GC 停頓）

用 Lua：Redis 單執行緒 + 腳本原子執行，天然互斥
      -> 沒有等待、沒有 TTL、沒有續期，吞吐量高一個數量級
```

**Redis 的單執行緒模型本身就是最強的互斥機制**（第 04 章）。既然如此，把整段「檢查 + 扣減」邏輯放進一個 Lua 腳本就夠了。

### 核心腳本

```lua
-- KEYS[1] = seckill:{aid}:stock      庫存
-- KEYS[2] = seckill:{aid}:bought     已購買使用者 Set
-- ARGV[1] = userId
-- ARGV[2] = 購買數量
-- ARGV[3] = 每人限購

-- 1. 防重：同一使用者只能買一次
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1 then
  return -1
end

-- 2. 庫存檢查
local stock = tonumber(redis.call('GET', KEYS[1]))
if stock == nil then
  return -3                                    -- 活動不存在或已結束
end

local qty = tonumber(ARGV[2])
if qty > tonumber(ARGV[3]) then
  return -4                                    -- 超過限購
end
if stock < qty then
  return -2                                    -- 庫存不足
end

-- 3. 扣減 + 記錄（這兩步和上面的檢查在同一個原子執行單元裡）
redis.call('DECRBY', KEYS[1], qty)
redis.call('SADD', KEYS[2], ARGV[1])

return stock - qty                             -- 回傳剩餘庫存
```

```javascript
const SECKILL_SCRIPT = `...上面的腳本...`;

const SECKILL_RESULT = {
  DUPLICATE: -1,
  SOLD_OUT: -2,
  NOT_FOUND: -3,
  EXCEED_LIMIT: -4,
};

async function trySeckill(activityId, userId, qty = 1, limitPerUser = 1) {
  const remaining = await txRedis.eval(
    SECKILL_SCRIPT, 2,
    keys.seckill.stock(activityId),
    keys.seckill.bought(activityId),
    String(userId), String(qty), String(limitPerUser)
  );

  if (remaining === SECKILL_RESULT.DUPLICATE) throw new AlreadyBoughtError();
  if (remaining === SECKILL_RESULT.SOLD_OUT) throw new SoldOutError();
  if (remaining === SECKILL_RESULT.NOT_FOUND) throw new ActivityEndedError();
  if (remaining === SECKILL_RESULT.EXCEED_LIMIT) throw new ExceedLimitError();

  return remaining;
}
```

**為什麼這樣就不會超賣**：Redis 單執行緒逐個執行命令，而 `EVAL` 的整個腳本是**一個執行單元**。20 萬個請求排隊進來，但每一個都會看到前一個扣減後的結果。不存在「兩個請求同時讀到 stock=1」的可能。

### 完整的秒殺流程（五層防護）

只有 Lua 是不夠的——20 萬 QPS 全部打到 Redis 也是壓力。實務上要分層擋量：

```text
20 萬 QPS 湧入
   │
   ├─ 第 1 層：前端按鈕禁用 + 隨機延遲     -> 過濾約 30%
   │
   ├─ 第 2 層：網關限流（第 10 章）        -> 過濾約 50%
   │            rate:seckill:{aid}:{uid}
   │            每人每秒最多 1 次
   │
   ├─ 第 3 層：本地「已售罄」標記            -> 售罄後直接擋掉全部
   │            應用程序內的布林值，售罄後不再打 Redis
   │
   ├─ 第 4 層：Redis Lua 原子扣減 ★        -> 這裡決定誰搶到
   │            真正到達的可能只有 2～3 萬
   │
   └─ 第 5 層：MySQL 建立訂單（非同步）      -> 只有 500 個成功者
                透過 Stream 消費，不阻塞秒殺請求
```

第 3 層特別有效：

```javascript
// 程序內的售罄標記，售罄後不再打 Redis
const soldOutFlags = new Map();

async function seckill(activityId, userId) {
  // 第 3 層：本地售罄標記
  if (soldOutFlags.get(activityId)) {
    throw new SoldOutError();
  }

  // 第 2 層：限流（第 10 章的令牌桶）
  const allowed = await rateLimiter.allow(
    keys.rate.seckill(activityId, userId), 1, 1);
  if (!allowed) throw new TooManyRequestsError();

  try {
    // 第 4 層：原子扣減
    const remaining = await trySeckill(activityId, userId);

    // 第 5 層：發事件，讓下游非同步建單
    await txRedis.xadd(keys.stream.orderEvents(), 'MAXLEN', '~', 100000, '*',
      'type', 'seckill_success',
      'activityId', String(activityId),
      'userId', String(userId),
      'qty', '1',
      'ts', String(Date.now()));

    if (remaining === 0) soldOutFlags.set(activityId, true);
    return { success: true, remaining };

  } catch (err) {
    if (err instanceof SoldOutError) {
      soldOutFlags.set(activityId, true);      // 快取售罄狀態
    }
    throw err;
  }
}
```

**售罄標記讓後續所有請求連 Redis 都不用打**——這是第 09 章「本地快取」在秒殺場景的應用。500 件商品在幾百毫秒內售罄，之後 19 萬多個請求全部被本地標記擋在應用層。

### 資料一致性：Redis 扣減 vs MySQL 落單

**Redis 扣減成功但 MySQL 建單失敗怎麼辦？**

這是秒殺最難的部分。三種處理層次：

```javascript
// 消費者：從 Stream 讀事件建立訂單（第 08 章）
async function orderConsumer() {
  const group = 'order-creator';
  const consumer = `worker-${process.env.POD_NAME}`;

  while (running) {
    const messages = await txRedis.xreadgroup(
      'GROUP', group, consumer, 'COUNT', 50, 'BLOCK', 2000,
      'STREAMS', keys.stream.orderEvents(), '>');

    if (!messages) continue;

    for (const [, entries] of messages) {
      for (const [id, fields] of entries) {
        const evt = parseFields(fields);
        try {
          await createOrder(evt);
          await txRedis.xack(keys.stream.orderEvents(), group, id);
        } catch (err) {
          // ★ 不 XACK，訊息留在 PEL，之後由 XAUTOCLAIM 重試
          logger.error({ id, err }, 'create order failed');
        }
      }
    }
  }
}

async function createOrder(evt) {
  // 冪等：用 (activityId, userId) 的唯一約束防重（第 10 章的替代方案 1）
  try {
    await db.query(
      `INSERT INTO orders (activity_id, user_id, qty, status)
       VALUES ($1, $2, $3, 'pending')`,
      [evt.activityId, evt.userId, evt.qty]);
  } catch (err) {
    if (err.code === '23505') {          // unique_violation
      return;                            // 已經建過了，視為成功
    }
    throw err;
  }
}
```

**三層保證**：

1. **Stream + 消費者群組**：訊息不會遺失，失敗會重試（第 08 章）。
2. **資料庫唯一約束**：重試造成的重複插入會被擋掉（第 10 章）。
3. **對帳任務**：活動結束後比對「Redis 扣了多少」和「DB 建了幾單」，差異人工處理。

```javascript
// 活動結束後的對帳
async function reconcile(activityId, initialStock) {
  const remaining = parseInt(await txRedis.get(keys.seckill.stock(activityId)), 10);
  const redisSold = initialStock - remaining;
  const boughtCount = await txRedis.scard(keys.seckill.bought(activityId));
  const dbOrders = await db.count('orders', { activity_id: activityId });

  logger.info({ activityId, redisSold, boughtCount, dbOrders }, 'reconciliation');

  if (redisSold !== dbOrders) {
    // Redis 扣了但 DB 沒建單 -> 查 Stream 的 PEL，或補償退還庫存
    alerting.send(`秒殺對帳不符：activity=${activityId} redis=${redisSold} db=${dbOrders}`);
  }
}
```

**「絕對不能超賣」的最終保證不在 Redis，在資料庫。** Redis 負責快速擋量與大部分正確性，資料庫的唯一約束與庫存欄位負責最終正確——這正是 `database-course` 第 10 章 Capstone 的相同結論。

### 活動準備與結束

```javascript
// 開賣前：預熱庫存（絕不能在第一個請求進來時才初始化）
async function prepareSeckill(activityId, stock, endAt) {
  const ttl = Math.ceil((endAt - Date.now()) / 1000) + 86400;   // 結束後保留 24h 供對帳

  const pipe = txRedis.pipeline();
  pipe.set(keys.seckill.stock(activityId), stock, 'EX', ttl);
  pipe.del(keys.seckill.bought(activityId));
  pipe.expire(keys.seckill.bought(activityId), ttl);
  await pipe.exec();

  logger.info({ activityId, stock }, 'seckill prepared');
}

// 結束後：對帳完成才清理
async function cleanupSeckill(activityId) {
  await reconcile(activityId, await db.getInitialStock(activityId));
  const pipe = txRedis.pipeline();
  pipe.del(keys.seckill.stock(activityId));
  pipe.unlink(keys.seckill.bought(activityId));   // 可能有數萬個 member，用 UNLINK
  await pipe.exec();
}
```

`bought` Set 用 `UNLINK` 而不是 `DEL`——一場熱門秒殺可能有數十萬個參與者，`DEL` 會阻塞單執行緒（第 04 章）。

---

## 14.9 第七步：直播間即時資料（F4、F6）

### 線上人數

第 09 章練習 3 已經完整設計過，這裡直接沿用結論：

```javascript
async function joinRoom(liveId, userId) {
  const added = await stateRedis.sadd(keys.live.members(liveId), userId);
  if (added === 0) return;                       // 多分頁去重
  await stateRedis.expire(keys.live.members(liveId), 43200);
  await stateRedis.incr(keys.live.online(liveId));
}

async function leaveRoom(liveId, userId) {
  const removed = await stateRedis.srem(keys.live.members(liveId), userId);
  if (removed === 0) return;
  await stateRedis.decr(keys.live.online(liveId));
}
```

### 打賞排行榜

```javascript
// 打賞：更新排行榜 + 累加 GMV（要原子）
const GIFT_SCRIPT = `
redis.call('ZINCRBY', KEYS[1], ARGV[2], ARGV[1])
redis.call('INCRBY', KEYS[2], ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[3])
return redis.call('ZSCORE', KEYS[1], ARGV[1])`;

async function sendGift(liveId, userId, amountCents) {
  return await stateRedis.eval(GIFT_SCRIPT, 2,
    keys.live.giftRank(liveId), keys.live.gmv(liveId),
    String(userId), String(amountCents), '2592000');
}

// 讀取 Top 20（熱點讀取，加 3 秒本地快取）
const rankCache = new LRU({ max: 1000, ttl: 3000 });

async function getGiftRank(liveId, limit = 20) {
  const cached = rankCache.get(liveId);
  if (cached) return cached;

  const raw = await stateRedis.zrevrange(
    keys.live.giftRank(liveId), 0, limit - 1, 'WITHSCORES');

  const rank = [];
  for (let i = 0; i < raw.length; i += 2) {
    rank.push({ userId: raw[i], amount: parseInt(raw[i + 1], 10) });
  }
  rankCache.set(liveId, rank);
  return rank;
}
```

**注意排行榜的資料流是「Redis 即時 + MySQL 流水」的雙寫**：Redis 的 ZSet 是給前端即時顯示用的，真正的打賞流水（涉及金錢）必須寫進 MySQL。ZSet 掉了可以從流水重算，反過來不行。

### 彈幕

```javascript
// 用 Stream 而不是 List：需要「多個消費者各自從某個位置讀」
async function sendDanmaku(liveId, userId, text) {
  await stateRedis.xadd(
    keys.live.danmaku(liveId),
    'MAXLEN', '~', 1000,              // 只保留最近約 1000 條
    '*',
    'uid', String(userId), 'text', text, 'ts', String(Date.now()));
  await stateRedis.expire(keys.live.danmaku(liveId), 7200);
}

// 新進入的觀眾拉取最近 50 條
async function getRecentDanmaku(liveId, count = 50) {
  const entries = await stateRedis.xrevrange(
    keys.live.danmaku(liveId), '+', '-', 'COUNT', count);
  return entries.reverse().map(([id, fields]) => ({ id, ...parseFields(fields) }));
}
```

`MAXLEN ~ 1000` 的 `~` 是近似裁切——第 08 章講過，精確裁切在高頻寫入下效能較差，生產環境一律用 `~`。

**為什麼彈幕不用 Pub/Sub**：新進來的觀眾看不到剛剛的彈幕（Pub/Sub 沒有歷史）。Stream 能讓他們拉取最近 50 條，體驗完全不同。

### 全站直播間熱度榜

500 個直播間的人數每秒變動數千次，不能每次都更新全站榜。用定時批次（第 09 章練習 3 的做法）：

```javascript
// 每 3 秒執行一次
async function syncLiveRanking() {
  const liveIds = await stateRedis.smembers('live:active');
  if (liveIds.length === 0) return;

  const counts = await stateRedis.mget(...liveIds.map(id => keys.live.online(id)));

  const pipe = stateRedis.pipeline();
  liveIds.forEach((id, i) => {
    pipe.zadd(keys.live.rankingOnline(), parseInt(counts[i] || '0', 10), id);
  });
  await pipe.exec();
}
```

---

## 14.10 第八步：容量規劃

### 記憶體估算

**實例 B（狀態）**：

```text
購物車          50 萬活躍使用者 × 平均 8 品項 × 60 bytes  = 240 MB
                + Hash 本身開銷 50 萬 × 100 bytes         =  50 MB
JWT 黑名單      10 萬 × 80 bytes                          =   8 MB
直播間 members  50 萬個 userId × 40 bytes                 =  20 MB
直播間計數      500 × 3 個 key × 60 bytes                 = 0.1 MB
打賞排行榜      500 場 × 1000 人 × 70 bytes               =  35 MB
彈幕 Stream     500 場 × 1000 條 × 200 bytes              = 100 MB
全站熱度榜      500 member                                = 0.05 MB
──────────────────────────────────────────────────────────────────
資料小計                                                   ≈ 453 MB
key 固定開銷    約 110 萬 key × 80 bytes                   ≈  88 MB
緩衝區 + backlog                                          ≈ 100 MB
──────────────────────────────────────────────────────────────────
小計                                                       ≈ 641 MB
fork 餘裕 +30%                                            ≈ 833 MB
建議 maxmemory                                             = 4 GB（留大量成長空間）
建議機器記憶體                                              = 8 GB
```

**實例 C（交易）**：

```text
秒殺庫存        同時 10 場活動 × 2 個 key                  < 1 MB
已購買 Set      10 場 × 50 萬參與者 × 40 bytes            = 200 MB
訂單事件 Stream 10 萬條 × 300 bytes                       =  30 MB
分散式鎖        少量                                       < 1 MB
──────────────────────────────────────────────────────────────────
小計                                                       ≈ 231 MB
建議 maxmemory                                             = 2 GB
建議機器記憶體                                              = 8 GB（給 CPU 與網路餘裕）
```

`bought` Set 是最大的一塊。如果參與人數再大一個數量級，可以考慮改用 Bitmap（userId 當 offset，第 03 章）——50 萬人只要 62KB，但前提是 userId 是連續的整數。

**實例 A（快取）**：

```text
商品快取        100 萬 SKU × 4 KB                          = 4 GB
分類列表        1 萬個 × 20 KB                             = 200 MB
直播間快照      500 × 2 KB                                 = 1 MB
──────────────────────────────────────────────────────────────────
小計                                                       ≈ 4.2 GB
```

但快取不需要存下全部 SKU——**只存熱資料**。按 80/20 法則，20% 的商品貢獻 80% 的流量：

```text
熱門 20 萬 SKU × 4 KB = 800 MB
建議 maxmemory = 8 GB（讓 LRU 自然決定存什麼）
建議機器記憶體 = 16 GB
```

### QPS 與網路頻寬

```text
平常：讀 8 萬 QPS
  ├─ 實例 A（商品快取）：約 5 萬，平均回應 4 KB
  │    網路 = 50000 × 4KB = 200 MB/s = 1.6 Gbps  ← 千兆網卡會滿！
  ├─ 實例 B（狀態）：約 2.5 萬，回應小
  └─ 實例 D（限流）：約 8 萬（每個請求都要過）

秒殺瞬時：20 萬 QPS
  ├─ 第 1～3 層擋掉約 85%
  └─ 實際到 實例 C 的約 3 萬 QPS，回應極小（一個整數）
```

**發現一個關鍵問題：實例 A 的網路頻寬會打滿千兆網卡。**

三個處理方式，本設計三個都用：

```text
1. 加本地快取（第 09 章多級快取）
   熱門商品在應用程序記憶體裡，命中率 60% -> Redis 流量降到 2 萬 QPS

2. 減小 value
   商品詳情頁其實不需要完整 JSON，把「列表用」和「詳情用」拆成兩個 key
   列表用的精簡版只有 400 bytes

3. 用萬兆網卡的機型
```

**這個發現說明了為什麼容量規劃不能只算記憶體。** 記憶體算下來只要 8GB，但網路頻寬才是真正的瓶頸——第 13 章特別強調過這一點。

### 12 個月成長規劃

```text
假設月成長 8%：
  實例 A：8 GB × 1.08^12 = 20 GB    -> 16GB 機器不夠，規劃 32GB
  實例 B：4 GB × 1.08^12 = 10 GB    -> 8GB 機器不夠，規劃 16GB
  實例 C：2 GB × 1.08^12 = 5 GB     -> 8GB 足夠
  實例 D：小                        -> 8GB 足夠

擴容觸發條件：used_memory / maxmemory > 70% 時啟動規劃（不是等到 90%）
```

---

## 14.11 第九步：持久化、高可用與 RPO/RTO

把第 06、11 章的內容套用到四個實例：

| 實例 | 持久化 | RPO 目標 | RTO 目標 | 高可用 | 理由 |
|------|--------|---------|---------|--------|------|
| A 快取 | **關閉** | 不適用 | < 30s | 主從 + Sentinel | 資料可重建；關閉持久化避免 fork 影響延遲 |
| B 狀態 | AOF everysec | < 1s | < 30s | 主從 + Sentinel + `min-replicas-to-write 1` | 購物車遺失有感但不致命 |
| **C 交易** | **AOF everysec + 每小時 RDB** | **< 1s** | **< 15s** | 主從 + Sentinel + `min-replicas-to-write 1` | 庫存與訂單事件不能丟 |
| D 限流 | 關閉 | 不適用 | 不適用 | 單機 | 掛了 fail-open，不影響正確性 |

### 實例 A 為什麼關閉持久化

這是一個容易被質疑的決定，理由：

```text
1. 資料完全可從 MySQL 重建
2. 開啟持久化的代價是 fork 造成的延遲尖峰（第 06 章）
   —— 8GB 的實例 fork 約需 300～800ms，期間所有請求排隊
3. N4 要求商品詳情 P99 < 50ms，一次 fork 就會破壞這個目標
```

**代價是重啟後快取全空，會有一波回源尖峰。** 對應措施是預熱（第 09 章）：

```javascript
// 重啟後由排程觸發，限速預熱熱門商品
await warmup(await db.getTopProductIds(50000), 500);   // 每秒 500 個
```

### 實例 C 的特別處理

```bash
# redis-c.conf
appendonly yes
appendfsync everysec
auto-aof-rewrite-percentage 100
auto-aof-rewrite-min-size 256mb

save 3600 1                          # 每小時 RDB，作為 AOF 損壞時的兜底

maxmemory 2gb
maxmemory-policy noeviction          # ★ 絕對不驅逐

min-replicas-to-write 1              # ★ 沒有健康從節點就拒絕寫入
min-replicas-max-lag 10
```

**`noeviction` + `min-replicas-to-write` 的組合意味著**：記憶體滿了或從節點全掛時，秒殺會**直接失敗**而不是靜默出錯。

這是刻意的選擇（第 11 章的可用性 vs 一致性取捨）：

```text
選 noeviction：記憶體滿時秒殺報錯 -> 使用者看到「系統繁忙」
選 allkeys-lru：記憶體滿時庫存 key 可能被驅逐 -> 超賣或少賣

N6 說「絕對不能超賣」，所以只能選前者。
```

同時要有**記憶體告警**（第 12 章），確保永遠不會真的走到那一步。

### 故障預案

| 故障 | 影響 | 應對 |
|------|------|------|
| 實例 A 全掛 | 商品頁變慢 | 降級走 MySQL + 本地快取 + DB 限流（第 09 章）|
| 實例 B 全掛 | 購物車、排行榜不可用 | 購物車降級唯讀提示；排行榜隱藏；**登入不受影響**（JWT）|
| **實例 C 全掛** | **秒殺無法進行** | **暫停秒殺活動**，不要降級到 MySQL 直接扣（會被打垮）|
| 實例 D 全掛 | 限流失效 | fail-open + 本地限流兜底（第 10 章）|
| 實例 C 故障轉移 | 丟失最後 < 1s 的扣減 | 對帳任務會發現差異，人工補償 |

**實例 C 全掛時「暫停活動」而不是「降級」，是本設計最重要的決策之一。** 秒殺的 20 萬 QPS 如果降級到 MySQL，資料庫會在幾秒內崩潰，連帶影響整站——**寧可讓一個活動延後，不要讓整個平台掛掉。**

---

## 14.12 第十步：完整下單流程串接

把所有部分串起來，看一次秒殺下單走過哪些系統：

```text
使用者點擊「立即搶購」
    │
 ①  ├─> 前端：按鈕立即禁用，加 0～200ms 隨機延遲（削峰）
    │
 ②  ├─> 網關：JWT 驗簽（本地）+ 撤銷黑名單檢查（實例 B）
    │        失敗 -> 401
    │
 ③  ├─> 網關：令牌桶限流（實例 D）
    │        rate:ip:{ip} 與 rate:user:{uid} 兩個維度
    │        失敗 -> 429 + Retry-After
    │
 ④  ├─> 應用：本地售罄標記檢查（程序內記憶體）
    │        已售罄 -> 立即回「已售完」，不打 Redis
    │
 ⑤  ├─> 應用：秒殺專用限流（實例 D）每人每秒 1 次
    │
 ⑥  ├─> 實例 C：EVAL 原子扣減 ★
    │        SISMEMBER 防重 -> GET 庫存 -> DECRBY -> SADD
    │        失敗 -> 回對應錯誤碼（重複/售罄/超限）
    │        成功 -> 剩餘庫存
    │
 ⑦  ├─> 實例 C：XADD 訂單事件到 Stream
    │
 ⑧  ├─> 回應使用者「搶購成功，訂單處理中」（此時 P99 < 200ms ✓）
    │
    │   ── 以下非同步 ──
    │
 ⑨  ├─> Consumer：XREADGROUP 讀事件
 ⑩  ├─> MySQL：INSERT 訂單（唯一約束防重）
 ⑪  ├─> MySQL：扣減真實庫存（帶條件的 UPDATE，最終防線）
 ⑫  ├─> 實例 C：XACK 確認
 ⑬  ├─> 其他 Consumer 各自處理：
    │      通知服務（推播）、統計服務（更新 GMV）、風控服務（異常檢測）
    │
 ⑭  └─> 30 分鐘後未付款：定時任務取消訂單並歸還庫存
```

第 ⑪ 步的 SQL 是最終防線（呼應第 10 章的樂觀鎖）：

```sql
UPDATE seckill_activities
SET sold = sold + 1
WHERE id = $1 AND sold < total_stock;
-- 影響列數為 0 -> Redis 和 DB 不一致，記錄告警並退回 Redis 庫存
```

**注意第 ⑧ 步：回應使用者的時間點在 Redis 扣減成功之後、MySQL 建單之前。** 這是秒殺能達到 200ms P99 的關鍵——把慢的部分（資料庫寫入）移出同步路徑。

代價是使用者看到「搶購成功」時訂單還沒真的建立。前端要顯示「處理中」並輪詢訂單狀態，這是產品設計要配合的部分。

### 逾時歸還庫存

```javascript
// 每分鐘掃描逾時未付款的訂單
const RETURN_STOCK = `
-- 歸還庫存並移除購買記錄，讓使用者可以再搶
redis.call('INCRBY', KEYS[1], ARGV[2])
redis.call('SREM', KEYS[2], ARGV[1])
return redis.call('GET', KEYS[1])`;

async function returnStock(activityId, userId, qty) {
  return await txRedis.eval(RETURN_STOCK, 2,
    keys.seckill.stock(activityId), keys.seckill.bought(activityId),
    String(userId), String(qty));
}
```

**歸還時要同時移除 `bought` 記錄**，否則那個使用者永遠無法再參與——這是很容易漏掉的細節。

---

## 14.13 常見設計失誤（自我檢查）

寫完設計文件後，逐項檢查有沒有踩到這些：

| 失誤 | 為什麼錯 | 對應章節 |
|------|---------|---------|
| 所有資料放同一個實例 | 驅逐策略、持久化需求互相衝突 | 05、11 |
| 秒殺用分散式鎖 | 吞吐量崩潰，且鎖有失效邊界 | 10 |
| 秒殺庫存實例用 `allkeys-lru` | 庫存 key 可能被驅逐 -> 超賣 | 05 |
| Session 只存 Redis | 故障轉移會大量登出使用者 | 11 |
| 購物車存整份 JSON | 改數量要整份讀寫，有併發覆蓋 | 02 |
| 購物車存商品快照 | 價格變動時顯示舊價，記憶體膨脹 | 09 |
| 彈幕用 Pub/Sub | 新進觀眾看不到剛剛的彈幕 | 08 |
| 訂單事件用 Pub/Sub | 消費者重啟時訊息永久遺失 | 08 |
| 排行榜每次打賞都寫全站榜 | 寫入量爆炸，且沒人看得出差異 | 09 |
| 商品快取 TTL 固定 | 批次寫入的 key 同時過期 -> 雪崩 | 09 |
| 不快取空值 | 不存在的商品 ID 被穿透 | 09 |
| Stream 不設 `MAXLEN` | 記憶體無限成長 | 08 |
| `DEL` 大 Set | 阻塞單執行緒，用 `UNLINK` | 04 |
| 沒有本地售罄標記 | 售罄後 19 萬個請求仍打 Redis | 09 |
| 只算記憶體不算網路頻寬 | 千兆網卡會先被打滿 | 13 |
| 快取實例開啟持久化 | fork 造成延遲尖峰，破壞 P99 目標 | 06 |
| 沒有對帳任務 | Redis 和 MySQL 不一致時無人察覺 | — |
| 逾時歸還庫存忘了移除 `bought` | 使用者永遠無法再參與 | — |
| 沒有 ACL 分帳號 | 一個服務被入侵等於全部淪陷 | 13 |
| 客戶端沒設 `commandTimeout` | Redis 卡住時整個服務不回應 | 13 |

---

## 14.14 專題作業

### 交付項目

**1. 架構設計文件**

- 資料定位表（每類資料的事實來源、遺失後果、可否驅逐、RPO 目標）
- 實例劃分與各自的參數設定，含每個決策的理由
- 完整的 key 設計總表（型別、TTL、大小估算）
- 容量規劃（記憶體、QPS、網路頻寬，含 12 個月成長）
- RPO / RTO 目標表與對應的持久化/高可用方案

**2. 核心程式碼**

- 秒殺的 Lua 腳本與完整的五層防護流程
- 購物車的完整 CRUD（含合併邏輯）
- 訂單事件的生產者與消費者（含冪等、PEL 處理、死信）
- 至少一種限流器
- 快取讀取（含空值、抖動、併發收斂、降級）

**3. 可執行的環境**

- Docker Compose 定義四個實例 + Sentinel
- ACL 設定檔（各服務的最小權限）
- 預熱腳本與對帳腳本

**4. 演練報告**

- 實測秒殺在 N 個併發下不超賣（附測試方法與結果）
- 實測一次故障轉移，記錄 RPO / RTO
- 實測快取擊穿在有/無互斥鎖下的 DB 回源次數差異

**5. 維運文件**

- 監控指標與告警規則
- 四個排錯劇本的值班速查表
- 上線檢查表（逐項打勾）

### 評分標準（100 分）

| 項目 | 分數 | 評分重點 |
|------|------|---------|
| 資料定位與實例劃分 | 20 | 有沒有從「定位」而非「功能」出發；劃分理由是否成立 |
| 資料結構選型 | 15 | 選對結構，且能說出被淘汰選項的問題 |
| 秒殺正確性 | 20 | 不超賣、不重複；Redis 與 DB 的一致性處理；對帳機制 |
| 快取設計 | 10 | 三大災難的處理；降級路徑完整 |
| 容量與效能 | 10 | 估算合理；有發現網路頻寬瓶頸 |
| 高可用與持久化 | 10 | 每個實例的 RPO/RTO 明確且方案匹配 |
| 安全與客戶端設定 | 10 | ACL 最小權限；超時、連線池、降級設定完整 |
| 監控與排錯 | 5 | 告警可執行；有值班文件 |

### 加分挑戰

- **+5**：實作多級快取的失效廣播，並處理 Pub/Sub 遺失的兜底。
- **+5**：把秒殺改成支援「多規格商品」（同一活動多個 SKU 各自庫存），保持原子性。
- **+5**：設計一個能在 Redis 完全不可用時仍能運作的降級模式，並說明各功能的降級行為。
- **+10**：用 `redis-benchmark` 或自寫壓測工具，實測秒殺在 5 萬併發下的正確性與延遲分布。

---

## 14.15 課程總回顧

十四章的知識在這個 Capstone 裡的位置：

```text
第 0 篇  入門與環境
  00 定位     -> 14.3 資料定位表：Redis 是不是事實來源
                  這一章的「Redis 不適合什麼」直接決定了架構

第 1 篇  資料結構
  01 Key/TTL  -> 14.5 key 設計總表、生命週期規範
  02 核心結構 -> 購物車用 Hash、排行榜用 ZSet、去重用 Set
  03 進階結構 -> 彈幕用 Stream；大規模去重可改 Bitmap/HLL

第 2 篇  核心機制
  04 單執行緒 -> 秒殺不用鎖的根本原因；UNLINK 取代 DEL
  05 記憶體   -> 四個實例的 maxmemory-policy 各不相同
  06 持久化   -> 快取實例關閉持久化以避免 fork 影響 P99

第 3 篇  程式設計實務
  07 Lua      -> 秒殺扣減、購物車加入、打賞更新都是 Lua
  08 Stream   -> 訂單事件流、彈幕
  09 快取     -> 商品快取、多級快取、售罄標記、三大災難
  10 鎖與限流 -> 五層防護的第 2、3、5 層；為什麼秒殺不用鎖

第 4 篇  架構與維運
  11 高可用   -> 實例劃分、Sentinel、每個實例的 RPO/RTO
  12 監控排錯 -> 告警規則、值班速查表
  13 安全實務 -> ACL 分帳號、客戶端超時、容量規劃發現網路瓶頸
```

### 三個貫穿全課的觀念

**觀念 1：Redis 的效能不是它保證給你的，是你設計出來的。**

第 00 章練習 3 就讓你親手驗證過：一個 `HGETALL` 大 Hash 能卡住整個實例。之後每一章都在講同一件事的不同面向——big key、慢命令、fork 阻塞、驅逐風暴、跨 slot 查詢。**單執行緒模型讓 Redis 極快，也讓任何一個錯誤都會影響所有人。**

**觀念 2：先問「這份資料掉了會怎樣」，再決定技術方案。**

這個問題的答案決定了：要不要持久化、要哪種持久化、能不能被驅逐、要不要高可用、RPO 目標是多少、Redis 能不能當事實來源。**跳過這個問題直接選技術，是所有架構失誤的共同起點。**

**觀念 3：Redis 解決不了的問題，要在別的地方解決。**

- 分散式鎖有失效邊界 -> 用資料庫唯一約束做最終保證（第 10 章）
- 故障轉移必然丟資料 -> 改架構讓關鍵狀態不只存在 Redis（第 11、14 章的 JWT）
- 快取一致性做不到強一致 -> 縮小視窗並確保會收斂（第 09 章）
- 秒殺的最終正確性 -> 在 MySQL 的唯一約束與條件更新（本章 14.8 節）

**承認邊界，然後在正確的層次解決問題**——這比把 Redis 用得更複雜有價值得多。

---

## 14.16 驗收清單

完成本課程後，確認你可以：

**設計能力**

- [ ] 拿到需求時，先做資料定位表而不是直接選結構。
- [ ] 為每一類資料回答「事實來源、遺失後果、可否驅逐」三個問題。
- [ ] 依參數需求衝突與故障隔離劃分實例，而不是全部塞一起。
- [ ] 為六個典型場景選出正確的結構，並說出被淘汰選項的問題。
- [ ] 設計完整的 key 命名規範，並用集中的 key builder 落地。
- [ ] 讓 key 前綴對應 ACL 的權限邊界。

**實作能力**

- [ ] 寫出秒殺的原子扣減腳本，並說明為什麼不需要鎖。
- [ ] 設計五層防護，讓 20 萬 QPS 只有一小部分到達 Redis。
- [ ] 用 Stream + 消費者群組實作可靠的訂單事件處理，含冪等與死信。
- [ ] 寫出包含空值、抖動、併發收斂、降級的完整快取讀取。
- [ ] 實作至少一種限流器，並處理 fail-open 與本地兜底。
- [ ] 用 Lua 保證跨多個 key 的操作原子性。

**架構能力**

- [ ] 估算記憶體，包含 key 開銷、緩衝區與 fork 餘裕。
- [ ] 估算網路頻寬，並判斷它會不會先於記憶體成為瓶頸。
- [ ] 為每個實例訂出 RPO / RTO 並選擇匹配的持久化與高可用方案。
- [ ] 說明為什麼快取實例該關閉持久化。
- [ ] 說明 `noeviction` + `min-replicas-to-write` 的取捨。
- [ ] 為每種故障設計預案，包含「暫停功能」這個選項。

**維運能力**

- [ ] 設計 ACL 權限矩陣，讓每個服務只能碰自己的資料。
- [ ] 設定客戶端的連線、超時、重試、降級與優雅關閉。
- [ ] 建立三層監控與可執行的告警規則。
- [ ] 產出值班用的排錯速查表。
- [ ] 逐項走完上線檢查表。
- [ ] 實測並記錄 RPO / RTO，而不是假設它們是 0。

**判斷能力**

- [ ] 判斷一個需求該不該用 Redis。
- [ ] 判斷該用 Redis 鎖、資料庫約束、還是原子操作。
- [ ] 判斷該用單機、主從、垂直拆分、還是 Cluster。
- [ ] 判斷 Redis 能不能當某份資料的事實來源。
- [ ] 說出你的方案在什麼情況下會失效，以及那時該怎麼辦。

---

最後一項是這門課真正的目標。

會用 Redis 的人很多，能說清楚「我的方案在什麼情況下會壞掉」的人少得多。而後者才是能被託付生產系統的人——**因為所有系統最終都會遇到它的邊界，差別只在於你是事先知道，還是在事故當下才發現。**

---

課程到這裡結束。回頭看 [README.md](./README.md) 的目錄，你應該對每一章的內容都有具體的畫面了。

如果要繼續往下走，三個方向：

- **深入原始碼**：Redis 的 C 程式碼可讀性相當好，`t_string.c`、`t_hash.c`、`expire.c`、`evict.c` 是很好的起點。
- **周邊生態**：RedisJSON、RediSearch、RedisTimeSeries 等模組，把 Redis 往「多模型資料庫」推。
- **對照學習**：讀 Valkey 的變更、或看 Dragonfly、KeyDB 這些相容實作怎麼解決單執行緒的限制——理解別人的取捨，會讓你更清楚 Redis 的設計為什麼是現在這樣。
