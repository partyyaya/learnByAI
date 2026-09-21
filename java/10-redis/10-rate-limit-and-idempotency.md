# 第 10 章：限流與冪等

> 09 章解決的是「**同一時間只有一個人能做某件事**」。
> 這一章是它的兩個近親，而它們在 08 章 8.8 的決策表上**同樣被標成「不可以降級」**：
>
> **「同一段時間裡，一個人最多能做幾次？」** ——**限流**
> **「同一個請求送了兩次，會不會做兩次？」** ——**冪等**
>
> 兩張表先擺在這裡。第一張是四種限流演算法，**同一組流量**（跨越窗邊界的 300 個請求，上限 100/秒）：
>
> | 演算法 | 節 | 任意連續一秒最多放進去幾個 | 一個使用者佔多少記憶體 | 每請求幾個 Redis 命令 |
> |---|---|---|---|---|
> | 固定窗 | 10.2 | ⚠️ **200 個（2.00 倍）** | 56 B | **2.0** |
> | 滑動窗（log / ZSet） | 10.3.1 | **100 個（1.00 倍）** | ⚠️ **128,992 B** | 4.5 |
> | 滑動窗（計數器） | 10.3.4 | 105 個（1.05 倍） | **56 B** | 4.0 |
> | 令牌桶 | 10.4 | 114 個（1.14 倍） | 104 B | 4.0 |
>
> 📌 **注意第三欄**：滑動窗 log 版是**最準**的，
> 但上限 1000/分的話，**100 萬個使用者要 123 GB**。
> 「最準的那個」通常不是你要的那個——10.5 會給一張選法。
>
> 第二張表是冪等（100 個不同的請求，每個送兩次，模擬客戶端逾時重試）：
>
> | 做法 | 節 | 建立了幾張訂單 | 重複 |
> |---|---|---|---|
> | 沒有冪等 | 10.8.2 | **200 張**（10 次全都是） | **+100** |
> | ⚠️ 「先查有沒有做過，再做」 | 10.9.2 | **148 ～ 200 張**（10 次的範圍） | **+48 ～ +100** |
> | Lua 冪等鍵 | 10.9.4 | **100 張**（10 次全都是） | **0** |
>
> ⚠️ **請看第二列，尤其是那個範圍。** 那是幾乎每個人第一次寫冪等時會寫的東西，
> 而它**跑十次有十種結果**——因為 `if (查到了) return;` 這兩行之間，
> **又是 09 章 9.2.1 那道縫。**
>
> 📌 **而「有時候會對」比「一定是錯」危險得多**：
> 我在跑完整套測試（JVM 已經熱好）的那一次，它**一張重複都沒有**。
> **這就是這個寫法能通過 code review 的原因。**
>
> 而這一章的起點，是 09 章 9.11.2 留下的那個發現：
> **「逾時了不代表沒執行。」** 客戶端的每一次重試，都建立在那個錯誤的假設上。

---

## 10.1 學習目標

完成本章後，你應該可以：

- 說出固定窗為什麼在窗口交界可以放進**兩倍**流量，並實測出那個 2.00 倍（10.2）。
- 用 ZSet 寫出滑動窗，並算出它在你的使用者規模下**要吃多少記憶體**（10.3）。
- 寫出令牌桶的 Lua，說明它跟窗的根本差別（**它允許 burst**），並畫出它的流量形狀（10.4）。
- 在準確度、記憶體、命令數三個維度上選出適合你的演算法（10.5）。
- 決定限流器要放在 `Filter` 還是 `Interceptor`，並說出兩者**看到的請求數不一樣**（10.6）。
- 實作多維度限流（IP／使用者／API key），並避開「**邊查邊寫**」那個陷阱（10.6.5）。
- 回出一組讓客戶端有辦法退讓的 `429`：`Retry-After` 與 `RateLimit-*`（10.7）。
- 說明冪等與去重的差別，並指出「先查再做」為什麼**完全無效**（10.9.2）。
- 實作有三個狀態的冪等鍵，並決定「第二個請求同時到達時」該回什麼（10.9）。
- ⚠️ 決定限流器與冪等鍵在 Redis 故障時 **fail-open 還是 fail-closed**，並說出兩者錯的方向不同（10.11）。

---

## 10.2 固定窗：最簡單的那個

### 10.2.1 它長什麼樣子

```
把時間切成固定的格子，每格數一個數字。

  第 10000 窗        第 10001 窗        第 10002 窗
  ├──────────────────┼──────────────────┼──────────────────┤
  0                 1s                 2s                 3s
  計數 0→100         計數重新從 0 開始     ...
```

key 裡面就帶著窗號：

```
rl:fixed:<使用者>:<現在毫秒 / 窗長>
```

```lua
-- scripts/rate-fixed-window.lua
-- KEYS[1] = rl:fixed:<id>:<窗號>，ARGV[1] = 上限，ARGV[2] = 窗長（毫秒）
local current = redis.call('INCR', KEYS[1])
if current == 1 then
    redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
if current > tonumber(ARGV[1]) then
    return 0
end
return 1
```

```java
public Decision fixedWindow(String id, int limit, long windowMillis, long now) {
    long slot = now / windowMillis;
    String key = "rl:fixed:" + id + ":" + slot;
    Long ok = redis.execute(fixedWindow, List.of(key),
            String.valueOf(limit), String.valueOf(windowMillis));
    ...
}
```

**優點很實在**：一個 String、兩個命令、56 bytes，而且是四種裡面最省的。

### 10.2.2 ⚠️ 為什麼這三行一定要在 Lua 裡

寫成兩行 Java 的話：

```java
// ⚠️ 錯的
Long current = redis.opsForValue().increment(key);
if (current == 1) redis.expire(key, window, MILLISECONDS);
```

**這就是 09 章 9.3.2 那個坑的複製品**：兩個命令中間掛掉 → **key 永遠沒有 TTL**。

而它在限流器上的後果比在鎖上更難發現：
那個計數器會一直累加，**這個使用者從此永遠被限流**，
而你在監控上只會看到「某幾個使用者的 429 比例是 100%」。

> 📌 **這一整章的每一段邏輯都會是 Lua**，理由跟 05 章 5.6 一樣：
> 只要邏輯裡有 `if`，就只有 Lua 是原子的。

### 10.2.3 實測：邊界那一秒放進 2 倍流量

實驗用的是「假時間」——直接餵時間戳給限流器，這樣邊界可以精準對齊，不用 `sleep`：

```java
long base = 10_000_000L;          // 一個對齊到窗邊界的假時間（% 1000 == 0）

// 在第 1 個窗的最後 100 毫秒送 150 個
for (int i = 0; i < 150; i++) {
    long now = base + 900 + i / 2;          // 900ms ~ 974ms
    if (limiter.fixedWindow("u1", 100, 1000, now).allowed()) allowedAt.add(now);
}
// 在第 2 個窗的前 100 毫秒送 150 個
for (int i = 0; i < 150; i++) {
    long now = base + 1000 + i / 2;         // 1000ms ~ 1074ms
    if (limiter.fixedWindow("u1", 100, 1000, now).allowed()) allowedAt.add(now);
}
```

然後掃出「**任意連續 1000 毫秒**裡最多放進去幾個」：

```
═══ 10.2.3 固定窗的邊界：上限 100/秒，看任意連續一秒內實際放進去幾個 ═══
  總共放行 200 個
  ⚠️ 任意連續一秒內最多放行 200 個（上限說好是 100）→ 2.0 倍
     最糟的那一秒：900 ms ~ 1900 ms（跨越窗邊界 1000 ms）
```

```
        │  第 10000 窗（上限 100）    │  第 10001 窗（上限 100）
        ├─────────────────────────────┼─────────────────────────────┤
        0                           900ms  1000ms                  2000ms
                                      ████████████
                                      100 個      100 個
                                      └──────┬──────┘
                                    這一段是 200 個/秒
                                    而且兩個窗各自都「合法」
```

### 10.2.4 這 2 倍代表什麼

> ⚠️ **「上限 100 QPS」在固定窗下的真正意思是「上限 200 QPS」。**
>
> 而且這不是理論上的邊界情況——**它是攻擊者最容易做到的事**：
> 對著整秒的時間點送兩波，就能穩定拿到兩倍。
>
> 📌 **兩個推論**：
>
> 1. 如果你的下游只能扛 100 QPS，**固定窗的上限要設 50**。
> 2. **窗越長，這件事越嚴重**：上限 1000/分的話，
>    邊界那一分鐘可以塞進 2000 個請求——而下游要在**幾秒鐘內**吃掉它們。

---

## 10.3 滑動窗

### 10.3.1 log 版：把每一次請求都記下來（ZSet）

```
用一個 ZSet，member = 這次請求的唯一識別，score = 時間戳

  ZREMRANGEBYSCORE  丟掉「現在 - 窗長」以前的
  ZCARD             數還剩幾個
  < 上限 ?          → ZADD 記一筆，放行
                    → 否則拒絕
```

```lua
-- scripts/rate-sliding-log.lua
-- ARGV[1] = 現在（毫秒），ARGV[2] = 窗長，ARGV[3] = 上限，ARGV[4] = 這次請求的唯一 member
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit  = tonumber(ARGV[3])

redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - window)   -- 丟掉窗外的
local count = redis.call('ZCARD', KEYS[1])
if count < limit then
    redis.call('ZADD', KEYS[1], now, ARGV[4])
    redis.call('PEXPIRE', KEYS[1], window)
    return {1, limit - count - 1, 0}
end
-- 被擋：算出最舊那一筆什麼時候會滑出窗，那就是可以重試的時間
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
return {0, 0, math.ceil(tonumber(oldest[2]) + window - now)}
```

> 📌 **注意它回傳三個值**：放行與否、還剩幾次、幾毫秒後可以重試。
> 10.7 要回的 `RateLimit-Remaining` 與 `Retry-After` 就是這兩個——
> **限流器必須在同一次 round-trip 裡把它們算出來**，不然你得再查一次。
>
> ⚠️ `ARGV[4]` 的 member 必須**唯一**。用「時間戳」當 member 的話，
> 同一毫秒的兩個請求會 `ZADD` 成同一個 member（覆蓋），**計數就少算了一次**。
> 這裡用 `now + "-" + UUID`。

### 10.3.2 實測：1.00 倍

同一組流量（那 300 個跨邊界的請求）：

```
  演算法        | 總放行 | 任意一秒最多 | 超出上限
  --------------+--------+--------------+---------
  固定窗          |   200  |        200   | +100 (2.00 倍)
  滑動窗(log)     |   100  |        100   | +0   (1.00 倍)
```

**剛好 100，一個都不多。** 它就是「最近一秒」的定義本身，所以不可能不準。

### 10.3.3 ⚠️ 但它的記憶體

**它記下了每一次請求。** 所以上限是多少，ZSet 就存多少筆：

```
═══ 10.3.3 一個使用者的限流狀態，在 Redis 裡佔多少記憶體 ═══
  上限      | 演算法        | key 型態 | MEMORY USAGE | 100 萬個使用者
  ----------+---------------+----------+--------------+----------------
    100/分  | 固定窗          | string   |        56 B  |       53.4 MB
    100/分  | 滑動窗(log)     | zset     |     6,200 B  |    5,912.8 MB
    100/分  | 滑動窗(計數)      | string   |        56 B  |       53.4 MB
    100/分  | 令牌桶          | hash     |       104 B  |       99.2 MB
   1000/分  | 固定窗          | string   |        56 B  |       53.4 MB
   1000/分  | 滑動窗(log)     | zset     |   128,992 B  |  123,016.4 MB
   1000/分  | 滑動窗(計數)      | string   |        56 B  |       53.4 MB
   1000/分  | 令牌桶          | hash     |       104 B  |       99.2 MB
```

> ⚠️ **上限 1000/分 × 100 萬個使用者 = 123 GB。**
>
> 而且注意 **6,200 B → 128,992 B 那一跳**（上限 100 → 1000，記憶體變 20.8 倍）。
> 這是 02 章 2.6 的 **listpack → skiplist** 轉換：
> ZSet 元素超過 `zset-max-listpack-entries`（預設 128）就換編碼，每個元素的開銷跳一級。
>
> 📌 **固定窗與滑動窗計數器都是 56 B，而且跟上限無關**——
> 因為它們只存一個數字。
>
> 而令牌桶是 104 B（一個兩欄位的 Hash），**也跟上限無關**。

**另外兩個容易忽略的成本**：

- `ZREMRANGEBYSCORE` 是 **O(log N + M)**（03 章 3.5）。上限 10 萬的話，每次請求都在清一堆元素。
- ⚠️ **上限不能讓使用者決定。** 有人拿到一個「上限 100 萬」的方案，
  那個 ZSet 就是一個 big key（02 章、03 章的每一個問題都會回來）。

### 10.3.4 計數器版：只存兩個數字，用權重估

```
                       上一個窗          這一個窗
                  ┌──────────────┬──────────────────┐
                  │     80 個     │      30 個        │
                  └──────────────┴──────────────────┘
                                 │       │
                                 │   已經走了 40%
                                 │
   「最近一個窗」估計值 = 80 × (1 - 0.4) + 30 = 48 + 30 = 78
                          └──── 上一個窗還有 60% 落在「最近一個窗」裡
```

```lua
-- scripts/rate-sliding-counter.lua
-- KEYS[1] = 這個窗，KEYS[2] = 上一個窗
-- ARGV[1] = 上限，ARGV[2] = 窗長，ARGV[3] = 已經走過這個窗的幾毫秒
local prev = tonumber(redis.call('GET', KEYS[2]) or '0')
local curr = tonumber(redis.call('GET', KEYS[1]) or '0')
local weight = 1 - (tonumber(ARGV[3]) / tonumber(ARGV[2]))
local estimated = prev * weight + curr

if estimated >= tonumber(ARGV[1]) then
    return {0, 0, math.ceil(tonumber(ARGV[2]) - tonumber(ARGV[3]))}
end
redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]) * 2)     -- ⚠️ 兩倍窗長：下一個窗還要讀到它
return {1, math.floor(tonumber(ARGV[1]) - estimated - 1), 0}
```

> ⚠️ **`PEXPIRE` 是兩倍窗長**，因為下一個窗還要把這個窗當作「上一個窗」來讀。
> 設成一倍的話，每個窗的第一毫秒都會讀到 0——**邊界問題又回來了**。

### 10.3.5 實測：1.05 倍

```
  滑動窗(計數)      |   105  |        105   | +5 (1.05 倍)
```

**它是一個估計值，所以會有誤差**，而誤差的方向取決於流量的形狀：

```
上一個窗的流量集中在「後半段」  →  加權低估  →  ⚠️ 放行得比上限多（我們量到的 1.05）
上一個窗的流量集中在「前半段」  →  加權高估  →  放行得比上限少（對使用者比較不利）
```

> 📌 **Cloudflare 公布過一個數字**：在他們的實際流量上，這個演算法的誤差約 **0.003%**。
> 真實流量比實驗室的「邊界集中爆量」平順很多。
>
> **用 56 bytes 換 5% 的誤差，這通常是這一章最划算的一筆交易。**

---

## 10.4 令牌桶

### 10.4.1 它跟「窗」的根本差別：它允許 burst

```
        ┌─────────────┐
        │  ○ ○ ○ ○ ○  │ ← 每秒往桶裡丟 rate 個令牌，最多累積到 capacity 個
        │  ○ ○ ○ ○ ○  │
        └──────┬──────┘
               │ 每個請求拿走一個令牌
               ▼           沒有令牌 → 429
```

**兩個參數各自管一件事**：

| 參數 | 管什麼 |
|---|---|
| `rate`（每秒補幾個） | **長期平均速率** |
| `capacity`（桶多大） | ⚠️ **允許多大的瞬間爆量** |

窗的世界裡只有一個上限，所以「平均速率」跟「瞬間爆量」是綁在一起的。
令牌桶把它們拆開了——**這是它最大的價值**。

> 📌 一個很常見的需求：
> 「這個 API 平均每秒 10 次就好，**但使用者剛打開頁面時可以連續打 20 次**。」
> 窗做不到（不是放太寬就是擋到正常使用者），令牌桶就是 `rate=10, capacity=20`。

### 10.4.2 Lua 實作

```lua
-- scripts/rate-token-bucket.lua
-- KEYS[1] = rl:tb:<id>（Hash：tokens、ts）
-- ARGV[1] = 桶容量，ARGV[2] = 每秒補幾個，ARGV[3] = 現在（毫秒），ARGV[4] = 這次要幾個
local capacity, rate = tonumber(ARGV[1]), tonumber(ARGV[2])
local now, requested = tonumber(ARGV[3]), tonumber(ARGV[4])

local data   = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts     = tonumber(data[2])
if tokens == nil then tokens = capacity; ts = now end       -- 第一次來：桶是滿的

-- 補令牌：不用背景任務，用「上次到現在經過多久」算出來
tokens = math.min(capacity, tokens + (math.max(0, now - ts) / 1000.0) * rate)

local allowed, retryAfter = 0, 0
if tokens >= requested then
    tokens = tokens - requested
    allowed = 1
else
    retryAfter = math.ceil((requested - tokens) / rate * 1000)
end

redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / rate * 1000) * 2)
-- ⚠️ Lua 回傳小數會被截成整數（05 章 5.6.4），所以剩餘量自己先 floor
return {allowed, math.floor(tokens), retryAfter}
```

> 📌 **三個設計重點**：
>
> 1. **沒有背景任務在「補令牌」。** 令牌是**用時間算出來的**（lazy refill）——
>    不然 100 萬個桶需要 100 萬個定時器。
> 2. `PEXPIRE` 設成「補滿一整桶所需時間的兩倍」。
>    ⚠️ 設太短的話，key 過期 → 下次來又是滿桶 → **等於沒限流**。
> 3. `math.floor(tokens)` ——**05 章 5.6.4 的坑**：Lua 回傳 4.7 到 Java 會變成 4，
>    但如果你回的是一個 table，裡面每個小數都會被默默截斷。**先自己 floor，意圖才明確。**

### 10.4.3 實測：它的形狀

容量 20、每秒補 10 個，用 **100 req/s** 連續打 3 秒：

```
═══ 10.4.3 令牌桶的形狀：容量 20、每秒補 10 個，連續打 3 秒 ═══
  每 100 毫秒放行幾個（送進來的是 10 個/100ms）：
   0.0 秒 | ██████████             10
   0.1 秒 | ██████████             10
   0.2 秒 | ██                     2
   0.3 秒 | █                      1
   0.4 秒 | █                      1
   ...
   2.9 秒 | █                      1
  總放行 49 個（送出 300 個）
```

```
  放行數
   10 ┤██ ██
      ┤██ ██
    5 ┤██ ██
      ┤██ ██ ██
    0 ┤██ ██ ██ ██ ██ ██ ██ ██ ██ ██ ██ ██ ...
      └────────────────────────────────────────▶
       0  0.2                              3.0 秒
       └─burst─┘└──────── 穩定在 10/秒 ────────┘
```

**前 200 毫秒放行 20 個**（把整桶喝乾），**之後穩定在每秒 10 個**。
這就是 `capacity=20, rate=10` 的意思，一眼就看得出來。

### 10.4.4 漏桶：它跟令牌桶不一樣

```
令牌桶：  允許爆量 ──▶ 輸出是不平滑的（前 200ms 20 個）
漏桶：    請求先排隊 ──▶ 輸出永遠是平滑的（固定速率流出）
```

**漏桶的輸出速率是恆定的**，所以它保護的是「**下游一次只能吃這麼多**」的場景
（例如呼叫一個有嚴格 QPS 限制的第三方 API）。

⚠️ 但它需要一個**佇列**，而佇列在分散式環境裡很麻煩：

- 排隊的請求要佔著一條 HTTP 執行緒（08 章 8.2.4 的災難）。
- 或是改成非同步，但那樣使用者就拿不到同步的回應了。

> 📌 **建議**：Web API 的入口用**令牌桶**（超過就 429，讓客戶端自己退讓），
> 呼叫下游的地方用**漏桶 / 併發閘**（08 章 8.5.6 那個 `Semaphore` 就是一種）。
> **不要在 HTTP 入口做排隊。**

---

## 10.5 四選一

### 10.5.1 三個維度的實測總表

```
═══ 10.5.1 每個請求要敲 Redis 幾個命令 ═══
  演算法        | 1000 個請求的 Redis 命令數 | 每請求
  --------------+----------------------------+--------
  固定窗          |                  2,002 次 |   2.00
  滑動窗(log)     |                  4,501 次 |   4.50
  滑動窗(計數)      |                  4,001 次 |   4.00
  令牌桶          |                  4,001 次 |   4.00
```

| | 準確度 | 記憶體（上限 1000） | 命令數 | 允許 burst |
|---|---|---|---|---|
| **固定窗** | ⚠️ **2.00 倍** | **56 B** | **2.0** | ⚠️ 不受控（就是那 2 倍） |
| **滑動窗（log）** | ✅ **1.00 倍** | ⚠️ **128,992 B** | 4.5 | ❌ |
| **滑動窗（計數器）** | 1.05 倍 | **56 B** | 4.0 | ❌ |
| **令牌桶** | 1.14 倍 | 104 B | 4.0 | ✅ **可設定** |

### 10.5.2 選法

```
① 你需要「允許爆量」嗎（例如頁面初始化會連打幾個 API）？
      需要  ──▶ 令牌桶
      不需要 ──▶ ②

② 你的使用者數 × 上限，記憶體吃得下嗎？
      吃得下（內部服務、上限小、使用者少）──▶ 滑動窗 log（最準）
      吃不下                            ──▶ 滑動窗計數器

③ 上限很低（每分鐘 3 次的簡訊驗證碼）而且必須精準？
      ──▶ 滑動窗 log（上限 3 的 ZSet 只有幾百 bytes，完全不是問題）
```

> 📌 **預設選「滑動窗計數器」或「令牌桶」。**
> **不要**選固定窗——它省下來的那 2 個命令，換來的是 2 倍的流量。
>
> ⚠️ **唯一可以用固定窗的場合**：上限本身就是個很粗的保護
> （「每個 IP 每天最多 100 萬次」這種），2 倍完全無所謂。

### 10.5.3 或者：Bucket4j

令牌桶不想自己寫的話，`Bucket4j` 是 Java 生態裡最成熟的一個：

```xml
<dependency>
  <groupId>com.bucket4j</groupId>
  <artifactId>bucket4j-redis</artifactId>
  <version>8.10.1</version>
</dependency>
```

```java
RedisClient client = RedisClient.create("redis://localhost:16379");
ProxyManager<byte[]> proxyManager = LettuceBasedProxyManager
        .builderFor(client)
        .withExpirationStrategy(ExpirationAfterWriteStrategy
                .basedOnTimeForRefillingBucketUpToMax(Duration.ofSeconds(10)))
        .build();

BucketConfiguration cfg = BucketConfiguration.builder()
        .addLimit(Bandwidth.builder().capacity(5).refillGreedy(5, Duration.ofSeconds(1)).build())
        .build();

BucketProxy bucket = proxyManager.builder().build("rl:b4j:alice".getBytes(UTF_8), () -> cfg);
ConsumptionProbe probe = bucket.tryConsumeAndReturnRemaining(1);
```

```
═══ 10.5.3 Bucket4j：同一個令牌桶，不用自己寫 Lua ═══
  第 1 個 → 放行，剩 4 個令牌，0 ms 後補滿一個
  ...
  第 5 個 → 放行，剩 0 個令牌，0 ms 後補滿一個
  第 6 個 → 429，剩 0 個令牌，185 ms 後補滿一個
  第 7 個 → 429，剩 0 個令牌，184 ms 後補滿一個
```

`ConsumptionProbe` 直接給你 `getRemainingTokens()` 與 `getNanosToWaitForRefill()`——
**正好就是 10.7 要回的那兩個標頭。**

| | 自己寫 Lua | Bucket4j |
|---|---|---|
| 演算法 | 你要自己選、自己寫 | 令牌桶（多層 bandwidth） |
| 回應資訊 | 自己從 Lua 回傳 | ✅ `ConsumptionProbe` |
| 多層限制（10/秒 **且** 100/分） | 自己疊 | ✅ `addLimit` 兩次 |
| ⚠️ 它用自己的連線 | —— | ⚠️ **另一個 `RedisClient`**（跟 09 章 9.7.1 的 Redisson 一樣的問題） |
| 換演算法 | 改 Lua | ❌ 只有令牌桶 |

> 📌 **建議**：**需要「多層限制」就用 Bucket4j，其他情況自己寫 Lua。**
> 這一章的 Lua 全部不到 20 行，而且出事的時候你看得懂。

---

## 10.6 限流器放在哪裡

### 10.6.1 三個位置，看到的東西不一樣

```
  請求
   │
   ├─ ① Servlet Filter ────────── 看得到：所有請求（含 404、靜態資源、錯誤轉派）
   │                              看不到：這個請求對應到哪個 Controller、登入的是誰
   │
   ├─ ② Spring Security 的 Filter ── 看得到：認證後的使用者
   │                              ⚠️ 但攻擊流量已經跑完整條認證鏈了
   │
   ├─ ③ HandlerInterceptor ──────── 看得到：handler、路徑變數、使用者
   │                              ⚠️ 看不到：找不到 handler 的請求
   │
   └─ Controller
```

### 10.6.2 實測：Filter 看到 15 個，Interceptor 看到 10 個

送三種請求各 5 個：正常的 `GET /api/ping`、不存在的 `GET /api/does-not-exist`（404）、
以及 `POST /api/ping`（405）：

```
═══ 10.6.2 Filter 與 Interceptor 看到的請求不一樣 ═══
  送 3 種請求各 5 個：
  Filter      看到 15 個請求
  Interceptor 看到 10 個請求
  ⚠️ 差的那幾個，是「找不到 handler」的請求——限流放在 Interceptor 的話，它們不受限制
```

> ⚠️ **差的那 5 個是 404。**
>
> 而 404 正是**掃描器最常打的東西**——
> 一個在掃你網站的機器人送出的請求，有 90% 以上會是 404。
> **限流放在 `Interceptor` 的話，這些請求完全不受限制。**
>
> 📌 **這一節的結論**：
> **限流放 `Filter`**（或更前面的 API Gateway / Nginx）。
> `Interceptor` 只適合做「**每個 API 各自的細部配額**」，不適合做入口保護。

### 10.6.3 ⚠️ 認證前還是認證後

這是一個沒有標準答案、但必須**明確決定**的問題：

| | 認證**前**限流（Filter，`@Order` 小） | 認證**後**限流（Security 之後） |
|---|---|---|
| 限流的維度 | 只有 IP / API key | 可以用使用者 ID |
| 攻擊者的成本 | **低**（換 IP 就好） | 低（但至少要有帳號） |
| **你的成本** | **低**（擋在最外面） | ⚠️ **高**——每個被擋的請求都已經驗過 JWT、查過資料庫 |
| NAT 後面的辦公室 | ⚠️ 會被當成同一個人 | 分得開 |

> 📌 **實務上兩層都要**：
>
> ```
> ① Filter（認證前）：IP 維度，上限設寬（例如 1000/分）──── 擋掉明顯的攻擊
> ② 認證後：使用者 / API key 維度，上限設準（例如 60/分）── 管正常使用者的配額
> ```
>
> ⚠️ 第一層的上限**一定要設寬**，因為 NAT——
> 一整間公司共用一個對外 IP 是很常見的事。

### 10.6.4 多維度限流：一次 round-trip 檢查三個

```java
LinkedHashMap<String, String> dims = new LinkedHashMap<>();
dims.put("rl:ip:1.2.3.4", "60000,100");     // IP：每分鐘 100
dims.put("rl:user:alice", "60000,20");      // 使用者：每分鐘 20
dims.put("rl:key:abc123", "1000,5");        // API key：每秒 5
RateLimiter.MultiDecision d = limiter.multi(dims, now);
```

```
═══ 10.6.4 多維度限流：IP 100/分、使用者 20/分、API key 5/秒 ═══
   第  1 個（   0 ms）→ 放行
   ...
   第  5 個（ 200 ms）→ 放行
   第  6 個（ 250 ms）→ 429（被 rl:key:abc123 擋下，750 ms 後可再試）
   第  7 個（ 300 ms）→ 429（被 rl:key:abc123 擋下，700 ms 後可再試）
   ...
   第 21 個（1000 ms）→ 放行
  30 個請求放行 10 個，最後擋下它的維度是 rl:key:abc123
  Redis 命令數 = 295（每請求 9.9 個，⚠️ 三個維度只用一次 round-trip）
```

> 📌 **兩件事值得注意**：
>
> 1. **知道是哪一個維度擋下來的**——這是給告警與客服用的。
>    「你被限流了」跟「你的 API key 每秒只能 5 次」是完全不同的訊息。
> 2. **一次 round-trip**。三個維度 9.9 個命令，但只有一次網路往返（03 章 3.8）。
>    寫成三次 `limiter.check()` 的話，就是三次往返。

### 10.6.5 ⚠️ 多維度的原子性陷阱：不能邊查邊寫

最容易寫錯的版本：

```lua
-- ⚠️ 錯的
for i = 1, #KEYS do
    if 超過上限 then return 0 end
    ZADD KEYS[i] ...          -- ← 邊檢查邊記
end
```

```
維度 ①（IP）      檢查 OK → 記了一筆
維度 ②（使用者）   檢查 OK → 記了一筆
維度 ③（API key） 超過上限 → 拒絕
                              ↑
              ⚠️ 但 ① 和 ② 的配額已經被扣掉了
              這個請求根本沒被放行，卻消耗了兩個維度的配額
```

**後果**：被限流的使用者會把自己所在 IP 的配額也吃光，**連累同一個 NAT 後面的所有人**。

正確的寫法是**兩段**：

```lua
-- ① 先「只看不寫」地檢查每一個維度
for i = 1, #KEYS do
    redis.call('ZREMRANGEBYSCORE', KEYS[i], 0, now - window)
    if redis.call('ZCARD', KEYS[i]) >= limit then
        local oldest = redis.call('ZRANGE', KEYS[i], 0, 0, 'WITHSCORES')
        return {0, i, math.ceil(tonumber(oldest[2]) + window - now)}
    end
end

-- ② 全部通過才一起記一筆
for i = 1, #KEYS do
    redis.call('ZADD', KEYS[i], now, now .. '-' .. i .. '-' .. math.random(1000000))
    redis.call('PEXPIRE', KEYS[i], window)
end
return {1, 0, 0}
```

> ⚠️ **注意 `math.random`**。05 章 5.6.4 說過 Redis 的 Lua 有一個**有種子的** `math.random`，
> 在同一個腳本裡是確定性的——**這是為了讓複製與 AOF 的重放結果一致**。
> Redis 5 之後腳本預設就是「effect replication」（複製的是結果不是腳本），所以這樣用是安全的。
> ⚠️ 但**不要**用它產生「必須全域唯一」的東西（例如訂單編號）。

⚠️ **另一個陷阱：Cluster 上跨槽**。
三個維度的 key（`rl:ip:...`、`rl:user:...`、`rl:key:...`）落在不同的 slot，
**Lua 會直接回 `CROSSSLOT`**（05 章 5.6.2、13 章）。
在 Cluster 上要嘛加 hash tag 把它們綁在一起（會造成熱點），要嘛**拆成三次呼叫**。

---

## 10.7 `429` 該怎麼回

### 10.7.1 三個狀態碼，三種意思

| 情況 | 狀態碼 | 語意 | 客戶端該做什麼 |
|---|---|---|---|
| **超過配額** | **429** Too Many Requests | 你太快了 | 等 `Retry-After` 再試 |
| 服務過載（不是針對你） | **503** Service Unavailable | 我撐不住 | 退避後重試 |
| 需要付費才能提高配額 | **402** / **403** | 這是方案限制 | ⚠️ **不要重試** |

> ⚠️ **最常見的錯誤是全部回 429。**
> 「這個月的額度用完了」回 429 + `Retry-After: 60` 的話，
> **客戶端會每分鐘重試一次，直到月底。**

### 10.7.2 實測：被限流的那個請求收到什麼

上限 5/秒，連送 7 個：

```
═══ 10.7.2 被限流的那個請求，實際收到什麼 ═══
  第 1 個請求 → 200 OK  RateLimit-Limit=5 Remaining=4 Reset=1 Retry-After=—
  第 2 個請求 → 200 OK  RateLimit-Limit=5 Remaining=3 Reset=1 Retry-After=—
  第 3 個請求 → 200 OK  RateLimit-Limit=5 Remaining=2 Reset=1 Retry-After=—
  第 4 個請求 → 200 OK  RateLimit-Limit=5 Remaining=1 Reset=1 Retry-After=—
  第 5 個請求 → 200 OK  RateLimit-Limit=5 Remaining=0 Reset=1 Retry-After=—
  第 6 個請求 → 429 TOO_MANY_REQUESTS  RateLimit-Limit=5 Remaining=0 Reset=1 Retry-After=1
           body = {"error":"rate_limited","retryAfterMillis":798}
  第 7 個請求 → 429 TOO_MANY_REQUESTS  RateLimit-Limit=5 Remaining=0 Reset=1 Retry-After=1
           body = {"error":"rate_limited","retryAfterMillis":795}
  真正進到 Controller 的請求數 = 5 / 7
```

```java
@Component
@Order(1)
public class RateLimitFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {

        RateLimiter.Decision d = limiter.slidingLog("ip:" + clientId(req), LIMIT, WINDOW,
                System.currentTimeMillis());

        // ⚠️ 不論放行或拒絕，都回這三個標頭
        res.setHeader("RateLimit-Limit", String.valueOf(LIMIT));
        res.setHeader("RateLimit-Remaining", String.valueOf(Math.max(0, d.remaining())));
        res.setHeader("RateLimit-Reset", String.valueOf((long) Math.ceil(WINDOW / 1000.0)));

        if (!d.allowed()) {
            long retrySeconds = Math.max(1, (long) Math.ceil(d.retryAfterMillis() / 1000.0));
            res.setStatus(429);
            res.setHeader("Retry-After", String.valueOf(retrySeconds));      // RFC 9110：單位是「秒」
            res.setContentType("application/json;charset=UTF-8");
            res.getWriter().write("{\"error\":\"rate_limited\",\"retryAfterMillis\":"
                    + d.retryAfterMillis() + "}");
            return;
        }
        chain.doFilter(req, res);
    }
}
```

> 📌 **`RateLimit-*` 要在 `200` 的時候就回。**
> 只在 429 才回的話，客戶端**沒有辦法提前減速**——
> 它只能一路打到被擋，然後再退讓。
>
> 📌 **`Retry-After` 的單位是秒（整數）**，所以 798 毫秒要進位成 1。
> ⚠️ 用 `Math.floor` 的話會變成 0，**客戶端會立刻重打**。
> 而 body 裡可以放毫秒，讓有心的客戶端退讓得更精準。

### 10.7.3 `Retry-After` 的兩種格式

```
Retry-After: 120                                   ← 秒數（推薦）
Retry-After: Fri, 18 Sep 2026 03:00:00 GMT         ← HTTP date
```

⚠️ **用秒數**。HTTP date 需要雙方時鐘一致（09 章 9.3.3 的老問題），
而且很多 HTTP 客戶端只實作了秒數那一種。

### 10.7.4 ⚠️ 沒有 `Retry-After` 的話，客戶端會做什麼

**它會立刻重試。**

```
  沒有 Retry-After
  ────────────────
  429 → 立刻重試 → 429 → 立刻重試 → 429 → ...
        └── 你的限流器現在要處理「原本的流量 + 無限的重試流量」
            而每一次重試都是一次完整的 Redis round-trip
```

> 📌 **限流器被自己擋掉的流量打爆，是一件真的會發生的事。**
> 08 章 8.7 的「恢復第二波」是同一個模式：
> **拒絕一個請求，不代表這個請求消失了。**
>
> 所以 429 的回應必須同時做到三件事：
> ① 告訴客戶端**等多久**（`Retry-After`）；
> ② 告訴客戶端**還剩多少**（`RateLimit-Remaining`），讓它提前減速；
> ③ **便宜**——429 的路徑不應該再去查資料庫或做任何 I/O。

### 10.7.5 `RateLimit-*` 標頭的現況

IETF 有一份 draft（`draft-ietf-httpapi-ratelimit-headers`）在標準化這組標頭，
但**還沒有正式的 RFC**，所以你會在不同的服務上看到不同的寫法：

```
RateLimit-Limit: 5                  ← draft 現在的寫法（本章用這個）
X-RateLimit-Limit: 5                ← GitHub、Twitter 等的舊寫法（仍然最常見）
RateLimit: limit=5, remaining=0, reset=1     ← draft 後期的單行寫法
```

> 📌 **建議**：**兩組都回**（`RateLimit-*` 和 `X-RateLimit-*`），
> 反正只是多幾個 bytes，而你的客戶端可能是任何一種函式庫。
> 然後在 API 文件裡寫清楚你回的是哪一組。

---

## 10.8 冪等：從 09 章那個發現開始

### 10.8.1 「逾時了不代表沒執行」

09 章 9.11.2 實測過：

```
業務做完了要放鎖 → 等了 535 ms，結果：QueryTimeoutException → Command timed out after 500 ms
⚠️ unpause 一秒後回頭看：EXISTS lock:failure-demo = 0  ← 那個「逾時」的 unlock 其實還是跑了
```

**同樣的事情發生在你的 API 上**：

```
   客戶端                          你的服務                      資料庫
     │  POST /orders                  │                          │
     ├───────────────────────────────▶│  建立訂單 ───────────────▶│  ✅ 寫進去了
     │                                │                          │
     │        ⏱ 3 秒逾時，放棄          │  ... 還在處理            │
     │◀─ ─ ─ ─（沒有回應）─ ─ ─ ─ ─ ─ ─┤                          │
     │                                │
     │  POST /orders（重試）           │
     ├───────────────────────────────▶│  又建立一張訂單 ─────────▶│  ⚠️ 第二張
```

> 📌 **客戶端唯一知道的事情是「我沒收到回應」。**
> 它**不可能**分辨「請求沒送到」跟「回應沒收到」——
> 這是網路的基本性質（兩軍問題），不是你的程式寫得不夠好。
>
> **所以：只要有重試，就必須有冪等。而重試一定會發生**——
> 使用者會按第二次、App 會自動重試、負載平衡器會重送、訊息佇列保證的是 at-least-once。

### 10.8.2 實測：沒有冪等

100 個不同的請求，每個送兩次：

```
═══ 10.8.2 沒有冪等：同一個請求送兩次（模擬客戶端逾時重試） ═══
  沒有冪等   送出 200 個請求（100 個不同的訂單 × 2 次）→ 建立 200 張訂單，重複 +100 張，例外 0，耗時 46 ms
```

**200 張訂單。** 如果這是扣款，就是 100 筆重複扣款。

### 10.8.3 冪等 ≠ 去重，也 ≠ 加鎖

三個很像但不一樣的東西：

| | 保證什麼 | 這一章 |
|---|---|---|
| **鎖**（09 章） | 同一時間只有一個人在做 | 做完之後，**下一個人還是會做一次** |
| **去重** | 一段時間內相同的東西只留一份 | 通常是**盡力而為**，而且會丟掉合法的重複 |
| **冪等** | **同一個請求做幾次，結果都跟做一次一樣** | ✅ |

⚠️ **「加鎖就好了吧？」不行。**

```java
// ⚠️ 這不是冪等
lock.tryLock("order:" + userId);
try { createOrder(...); } finally { lock.unlock(); }
```

鎖只保證**兩次不會同時發生**。第一次做完、放鎖，第二次進來——**它照樣會做一次。**
**冪等需要「記得做過了」，而鎖不記得任何事。**

---

## 10.9 冪等鍵

### 10.9.1 誰產生它

```
❌ 伺服器產生：伺服器沒辦法知道「這兩個請求是同一個」
✅ 客戶端產生：客戶端在「第一次送出前」產生一個 UUID，重試時用同一個
```

```
POST /api/orders
Idempotency-Key: 7f3e9a1c-...          ← 客戶端產生，重試時不變
Content-Type: application/json

{"productId": 1, "qty": 1}
```

⚠️ **客戶端必須在「使用者按下按鈕的那一刻」產生它，而不是在「送出請求時」**——
不然重試的時候會產生一個新的 key，等於沒有冪等。

**如果客戶端不配合怎麼辦**（例如第三方 webhook）：
用「**請求內容的雜湊 + 使用者 + 時間窗**」自己算一個。
⚠️ 這是有損的——使用者「真的」想下兩張一樣的訂單時會被擋掉，
所以時間窗要短（幾秒），而且要在 API 文件裡寫清楚。

### 10.9.2 ⚠️ 「先查有沒有做過，再做」——實測還是 200 張

```java
// ⚠️ 錯的
String done = redis.opsForHash().get(k, "response");
if (done != null) return done;          // ← 查
String result = body.get();             // ← 做
redis.opsForHash().put(k, "response", result);
```

```
═══ 10.9.2 「先查有沒有做過，再做」 ═══
  先查再做   送出 200 個請求（100 個不同的訂單 × 2 次）→ 建立 200 張訂單，重複 +100 張，例外 0，耗時 241 ms
```

**單獨跑 10 次的結果**（⚠️ 請注意這一欄不是一個數字，是一個範圍）：

```
  第 1 次  +100        第 6 次  +100
  第 2 次   +57        第 7 次  +100
  第 3 次   +48        第 8 次   +96
  第 4 次   +77        第 9 次  +100
  第 5 次   +83        第10 次   +77
                      ────────────────
                      範圍 +48 ～ +100，中位數約 +90
```

> ⚠️ **最多 100 張重複——跟完全不做冪等一模一樣。**
>
> 因為兩個重試如果**同時**到達（而它們通常就是同時到達的——
> 客戶端逾時重試、負載平衡器重送、使用者連按兩下），
> 它們會同時查到「沒做過」。
>
> 📌 **這是 09 章 9.2.1 那道縫的第三次出現**：
> 9.2.1 是「讀庫存→寫庫存」，9.3.1 是「GET→SET」，這裡是「查冪等鍵→做事」。
> **每一次都是同一個形狀，每一次的解法都是同一個：把 `if` 放進 Lua。**

**而那個範圍才是這一節最需要講的東西。**

我在「跑完整套測試之後」再跑一次這個實驗（JVM 已經熱好、連線池已經暖過），
拿到的是 **100 張訂單、0 張重複**——**看起來完全正確。**

```
  先查再做   送出 200 個請求 → 建立 100 張訂單，重複 +0 張，例外 0，耗時 25 ms
```

> ⚠️ **同一段程式，同一組輸入，在同一台機器上，有時候對、有時候錯。**
>
> 📌 這就是為什麼這個寫法會活著上線：
> 寫的人測過（那次剛好對了）、reviewer 看過（邏輯讀起來很合理）、
> QA 點過兩次（手點的兩次不可能真的同時）。
> **只有正式環境的真實併發會把它打開。**
>
> ⚠️ **推論**：測併發 bug 的時候，**跑一次通過不算通過**。
> 09 章 9.8.2 的「超賣 3 件」與這裡的「+0」是同一種東西——
> **併發測試必須跑很多次，而且要看範圍不是看單點。**

⚠️ 另外注意它**比完全不做慢了 5 倍**（241 ms vs 46 ms）——**付出了成本，什麼也沒買到。**

### 10.9.3 三個狀態

冪等鍵不能只有「做過 / 沒做過」兩個狀態，因為還有**第三種**：

```
  （不存在）  ──▶  我搶到了，開始做
  IN_PROGRESS ──▶  別人正在做 ── ⚠️ 這個狀態是關鍵
  DONE        ──▶  做完了，把當初的回應原封不動回給你
```

⚠️ 還要一個第四種檢查：**同一個 key、不同的請求內容**。
那代表客戶端有 bug（或是有人在攻擊），**必須拒絕**，不能回一個不相干的回應。

### 10.9.4 Lua 實作

```lua
-- scripts/idempotency-begin.lua
-- KEYS[1] = idem:<key>，ARGV[1] = 請求指紋，ARGV[2] = 處理中的存活毫秒
-- 回傳 {狀態, 內容}
--   {0, ''}      → 我搶到了，可以開始做
--   {1, 回應}     → 已經做完了，直接回這個
--   {2, ''}      → 別人正在做（處理中）
--   {3, 舊指紋}   → 同一個 key 但請求內容不一樣（⚠️ 客戶端有 bug）
local existing = redis.call('HMGET', KEYS[1], 'state', 'fingerprint', 'response')
local state = existing[1]

if state == false then
    redis.call('HSET', KEYS[1], 'state', 'IN_PROGRESS', 'fingerprint', ARGV[1])
    redis.call('PEXPIRE', KEYS[1], ARGV[2])
    return {0, ''}
end
if existing[2] ~= ARGV[1] then return {3, existing[2]} end
if state == 'DONE'       then return {1, existing[3]} end
return {2, ''}
```

```java
public String execute(String key, String fingerprint, Supplier<String> body) {
    String k = "idem:" + key;
    List<?> r = redis.execute(begin, List.of(k), fingerprint,
            String.valueOf(IN_PROGRESS_TTL.toMillis()));

    switch (((Number) r.get(0)).intValue()) {
        case 1 -> { replayed.increment(); return String.valueOf(r.get(1)); }      // 已完成 → 重放
        case 2 -> { inFlight.increment(); throw new InProgressException(key); }   // 處理中 → 409
        case 3 -> { mismatch.increment(); throw new FingerprintMismatchException(key); }  // → 422
    }

    // state == 0：我搶到了
    executed.increment();
    try {
        String result = body.get();
        redis.opsForHash().putAll(k, Map.of("state", "DONE",
                "fingerprint", fingerprint, "response", result));
        redis.expire(k, DONE_TTL);
        return result;
    } catch (RuntimeException e) {
        redis.delete(k);      // ⚠️ 失敗就把 key 刪掉，讓客戶端可以用同一個 key 重試
        throw e;
    }
}
```

```
═══ 10.9.4 Lua 版：搶到的人才做，其他人拿狀態 ═══
  Lua 冪等鍵   送出 200 個請求（100 個不同的訂單 × 2 次）→ 建立 100 張訂單，重複 +0 張，例外 0，耗時 273 ms
  指標：executed=100 replayed=44 inFlight(409)=56 mismatch=0
```

**單獨跑 5 次**（對照 10.9.2 那個會飄的版本）：

```
        訂單   executed   replayed   inFlight(409)
  第1次  100      100         44           56
  第2次  100      100         68           32
  第3次  100      100         41           59
  第4次  100      100         71           29
  第5次  100      100         65           35
        ────    ────────   ─────────   ─────────────
        永遠     永遠 100    41 ～ 71     29 ～ 59
        100 張
```

> 📌 **左邊兩欄完全不動，右邊兩欄每次都不一樣——而這正是它對的證明。**
>
> 「訂單數」與「執行次數」是**正確性**，它們必須是常數。
> `replayed` 跟 `inFlight` 的分布是**時序**，它本來就會隨著兩份重試到達的間隔而變。
>
> ⚠️ **寫併發測試的時候要斷言的是左邊那兩欄。**
> 斷言 `replayed == 82` 的測試會在 CI 上隨機失敗，然後被某個人加上 `@Disabled`。

那 29 ～ 59 個 409 就是「**兩份重試真的同時到達**」的比例——
它們沒有拿到重複的訂單（✅），但也沒拿到成功的回應。**10.9.8 會處理它們。**

### 10.9.5 重放：第二次拿到的必須是同一個回應

```
═══ 10.9.5 先後送兩次（不是同時）：第二次拿到什麼 ═══
  第一次回應 = {"orderId":777}
  第二次回應 = {"orderId":777}   ← 完全一樣，而且業務沒有再跑一次
  Redis 裡的內容 → state / DONE / fingerprint / fp-A / response / {"orderId":777}
  TTL = 86400 秒

  ⚠️ 同一個 key、不同的請求內容：
     同一個冪等鍵，不同的請求內容：req-X → 422
```

> ⚠️ **「不重複建立」還不夠，必須「回同一個回應」。**
>
> 只回 `200 OK` 而不帶訂單編號的話，客戶端**拿不到它需要的東西**——
> 它會以為失敗了，然後用新的 key 再送一次。**冪等就白做了。**
>
> 📌 這代表你必須**把回應存起來**。所以：
> - ⚠️ 回應不能太大（存 JSON 全文的話，02 章的記憶體問題會找上門）。
>   只存「識別碼 + 狀態」，讓客戶端再查一次細節，通常比較好。
> - ⚠️ 回應裡不要有時間戳之類**每次都會變**的東西，不然它跟「重新算一次」就不一致了。

### 10.9.6 失敗要能重試

```
═══ 10.9.6 業務失敗時，同一個 key 要能重試 ═══
  第一次：資料庫爆了
  失敗後 Redis 裡還有 key 嗎 → 0（0 ＝ 可以重試）
  用同一個 key 重試 → {"orderId":1234}
```

⚠️ **這一段是最容易寫錯的**：業務丟例外時，如果冪等鍵留著 `IN_PROGRESS`，
客戶端用同一個 key 重試會拿到 409，**而且要等 30 秒（`IN_PROGRESS_TTL`）才能重來。**

但也不是所有失敗都該刪掉：

| 失敗類型 | 冪等鍵怎麼處理 |
|---|---|
| 系統錯誤（資料庫掛了、逾時） | ✅ **刪掉**，讓同一個 key 可以重試 |
| 業務錯誤（庫存不足、餘額不夠） | ⚠️ **記成 `DONE` + 那個錯誤回應**——不然客戶端會一直重試一個注定失敗的請求 |
| ⚠️ **不確定**（下游逾時，不知道成功沒） | ⚠️ **留著 `IN_PROGRESS` 讓它自然過期**，並且**告警** |

第三種是最麻煩的，而它正是 09 章 9.11.2 那個場景。
**這種時候沒有自動化的正確答案，只有「不要讓它悄悄過去」。**

### 10.9.7 TTL 該設多久

```java
public static final Duration IN_PROGRESS_TTL = Duration.ofSeconds(30);   // ≒ 你的請求逾時
public static final Duration DONE_TTL        = Duration.ofHours(24);     // ≒ 客戶端最長的重試窗
```

| | 設太短 | 設太長 |
|---|---|---|
| `IN_PROGRESS` | ⚠️ 第一個還在跑，第二個就搶到了 → **重複執行** | 客戶端要等很久才能重試 |
| `DONE` | ⚠️ **重複執行**（客戶端隔天重試時 key 已經沒了） | 記憶體 |

> 📌 **`IN_PROGRESS_TTL` 必須大於「業務最壞情況耗時」**——這句話跟 09 章 9.5.5 一模一樣，
> 因為它就是同一件事（一把有 TTL 的鎖）。
>
> ⚠️ **`DONE_TTL` 要問的是「客戶端最晚會在什麼時候重試」。**
> 訊息佇列的死信重投可能是**幾小時後**，
> 人工客服的「幫我重送一次」可能是**隔天**。**24 小時是一個安全的起點。**

**記憶體估算**：每個 key 一個小 Hash（狀態 + 指紋 + 回應）。
回應 200 bytes 的話，一天 100 萬筆訂單 ≒ **300 MB 左右**。⚠️ 記得算進 `maxmemory`（04 章）。

### 10.9.8 ⚠️ 那 18 個 409 怎麼辦

回 409 是**安全**的（不會重複），但對使用者不友善：他的訂單其實正在建立，卻收到一個錯誤。

三個選項：

| 做法 | 優點 | ⚠️ |
|---|---|---|
| **直接回 409 + `Retry-After: 1`** | 簡單、便宜 | 客戶端要自己重試 |
| **等一下再查一次**（最多等 N 毫秒） | 使用者體驗好 | ⚠️ **佔著執行緒**（08 章 8.2.4） |
| **回 202 Accepted + 一個查詢 URL** | 最正確 | 客戶端要改 |

```java
// 折衷：短暫等待 + 一次重查
for (int i = 0; i < 3 && 還是 IN_PROGRESS; i++) {
    Thread.sleep(100);            // ⚠️ 總共最多 300 毫秒，而且要有上限
    重查一次;
}
if (還是 IN_PROGRESS) return 409 + Retry-After: 1;
```

> 📌 **建議**：**預設回 409**，只有在「使用者一定會盯著螢幕等」的介面（例如結帳）
> 才加上那個 300 毫秒的短暫等待。
>
> ⚠️ **不要無限等**。08 章 8.4.1 的 Little's Law：
> 每個請求多佔 300 毫秒，50 條執行緒的吞吐量上限就是 166 QPS。

### 10.9.9 ⚠️ 冪等鍵與交易的順序

**跟 09 章 9.8 完全一樣的問題，完全一樣的答案：**

```
✅ 對的：  搶冪等鍵 ──▶ [ 開交易 ── 做事 ── 提交 ] ──▶ 寫入 DONE
⚠️ 錯的：  [ 開交易 ── 搶冪等鍵 ── 做事 ── 寫入 DONE ── 提交 ]
                                              ↑
                            Redis 上已經 DONE，但資料庫還沒提交。
                            這時候第二個請求進來 → 拿到「做過了」的回應
                            → 但資料庫裡什麼都沒有（而且交易還可能回滾）
```

> ⚠️ **這個 bug 比 09 章那個更難發現**：
> 它不會造成重複，它造成的是**「客戶端收到成功回應，但訂單不存在」**——
> 而這在日誌裡看起來完全正常。

---

## 10.10 HTTP 這一側

### 10.10.1 `Idempotency-Key` 標頭

IETF 有一份 draft（`draft-ietf-httpapi-idempotency-key-header`），
而 Stripe、PayPal、Shopify 等等實務上已經用了很多年：

```
POST /api/orders HTTP/1.1
Idempotency-Key: 7f3e9a1c-4b2d-4e8a-9f1c-2d3e4f5a6b7c
Content-Type: application/json

{"productId": 1, "qty": 1}
```

```java
@PostMapping("/orders")
public ResponseEntity<String> create(
        @RequestHeader(value = "Idempotency-Key", required = false) String key,
        @RequestBody String body) {

    if (key == null || key.isBlank()) {
        return ResponseEntity.badRequest().body("{\"error\":\"missing Idempotency-Key\"}");
    }
    try {
        String result = idem.execute(key, fingerprint(body), () -> {
            dao.createOrder(1L, "web");
            return "{\"orderId\":" + newOrderId() + "}";
        });
        return ResponseEntity.ok(result);
    } catch (IdempotencyService.InProgressException e) {
        return ResponseEntity.status(HttpStatus.CONFLICT)
                .header("Retry-After", "1")
                .body("{\"error\":\"in_progress\"}");
    } catch (IdempotencyService.FingerprintMismatchException e) {
        return ResponseEntity.unprocessableEntity()
                .body("{\"error\":\"idempotency_key_reused_with_different_body\"}");
    }
}

static String fingerprint(String body) {
    MessageDigest md = MessageDigest.getInstance("SHA-256");
    return HexFormat.of().formatHex(md.digest(body.getBytes(UTF_8))).substring(0, 16);
}
```

> 📌 **`required = false` 然後回 400**，不要用 `required = true`。
> 前者可以回一個看得懂的錯誤訊息，後者只會是一個 Spring 的預設 400。
>
> ⚠️ **指紋只取 SHA-256 的前 16 個十六進位字元**（64 bits）是刻意的：
> 它不是安全用途（不怕碰撞攻擊），只是要分辨「同一個 key 的內容變了沒」，
> 而存 64 個字元 × 每天 100 萬筆是沒必要的記憶體。

### 10.10.2 實測

```
═══ 10.10.2 HTTP 這一側：同一個 Idempotency-Key 送兩次 ═══
  第一次 → 200 OK  {"orderId":80083}
  第二次 → 200 OK  {"orderId":80083}   ← 一模一樣
  同 key 不同 body → 422 UNPROCESSABLE_ENTITY  {"error":"idempotency_key_reused_with_different_body"}
```

### 10.10.3 十個一模一樣的 POST 同時到達

```
═══ 10.10.3 十個一模一樣的 POST 同時到達 ═══
  10 個同時送出的相同請求：
     200 OK                   1 個
     409 CONFLICT             9 個
  回應內容（去重）：
     200 OK {"orderId":47166}
     409 CONFLICT {"error":"in_progress"}
```

**1 個 200 ＋ 9 個 409，訂單只建立了一張。**（跑三次都是 1 / 9。）

> ⚠️ **請注意 409 佔了九成。**
>
> 這跟 10.9.4 那個實驗（29 ～ 59 個 409）是同一件事的兩個極端：
>
> ```
>  10 個請求「真的同時」到達 ──▶ 只有 1 個搶到，其他 9 個都還沒有 DONE 可以重放
>  兩份重試「差幾毫秒」到達  ──▶ 第二份通常等得到 DONE，拿到重放（200）
> ```
>
> 📌 **一句話**：**409 的比例 ≒ 「業務耗時」÷「重試間隔」。**
> 業務跑 500 毫秒的話，這 500 毫秒內到達的重試**全部**會拿到 409。
>
> ⚠️ **所以 409 不是例外情況，是常態**——
> 如果你的客戶端沒有處理 409（例如把它當成「失敗」顯示給使用者），
> **冪等做對了，使用者體驗還是壞的。** 這就是 10.9.8 要處理的事。

### 10.10.4 哪些方法需要冪等

| 方法 | 本身冪等？ | 要做冪等鍵嗎 |
|---|---|---|
| `GET` / `HEAD` | ✅ | ❌ 不用 |
| `PUT` | ✅ **理論上**（同一份內容覆寫幾次都一樣） | ⚠️ **要**——如果它有副作用（發通知、寫流水帳） |
| `DELETE` | ✅ 理論上 | ⚠️ 要——「刪第二次要回 404 還是 204」是個要決定的問題 |
| **`POST`** | ❌ | ✅ **一定要** |
| `PATCH` | ❌（`{"count": {"$inc": 1}}` 這種） | ✅ 要 |

> ⚠️ **「`PUT` 是冪等的」是 HTTP 語意上的說法，不是你的實作的保證。**
> `PUT /users/1` 如果順便寄了一封「資料已更新」的信，**它就不冪等了。**

---

## 10.11 ⚠️ 限流器與冪等鍵自己壞掉的時候

### 10.11.1 fail-open 還是 fail-closed

```
═══ 10.11.1 限流器自己壞掉：Redis 不回話時該放行還是該擋 ═══
  limiter 呼叫等了 511 ms → QueryTimeoutException: Redis command timed out
  📌 預設行為是「丟例外」——你必須自己決定 fail-open 還是 fail-closed
```

**預設什麼都不是——它就只是丟例外，變成 500。** 那通常是最糟的選項。

```java
RateLimiter.Decision d;
try {
    d = limiter.check(...);
} catch (RedisSystemException | QueryTimeoutException e) {
    // ⚠️ 這一行是一個產品決策，不是技術決策
    d = FAIL_OPEN ? Decision.ALLOW : Decision.DENY;
}
```

| | fail-**open**（放行） | fail-**closed**（拒絕） |
|---|---|---|
| 意思 | 限流器壞了 → 大家都不受限 | 限流器壞了 → 大家都被擋 |
| 風險 | ⚠️ **下游被打爆**（限流原本保護的東西） | ⚠️ **服務等於下線** |
| 適合 | 內部服務、限流是「品質保護」 | 對外 API、限流是「安全邊界」 |

> 📌 **08 章 8.8 的決策表上，限流那一行寫的是「看服務」——這就是原因。**
> 它跟鎖不一樣：**鎖只有一個正確答案（失敗），限流有兩個都說得通的答案。**
>
> ⚠️ 而**冪等鍵沒有這個選擇**：
>
> ```
> | 冪等鍵 | 10 | ❌ 直接失敗 | 「查不到就當作沒做過」＝ 重複扣款 |
> ```
>
> 冪等鍵 fail-open 的意思是「**Redis 掛掉的那 60 秒，所有重試都會重複執行**」。
> **這跟 09 章 9.11 的鎖是同一件事：它是正確性機制，不是效能機制。**

### 10.11.2 一個實務上的折衷：本地兜底

限流器 fail-open 的風險是下游被打爆，但你可以**退回一個粗糙的本地限流**：

```java
// Redis 掛掉時，改用「這一台機器」的本地限流器
private final Map<String, AtomicInteger> localFallback = ...;   // 或 Guava RateLimiter

catch (RedisSystemException e) {
    degradedCount.increment();
    return localLimiter.tryAcquire(id);     // 上限 = 全域上限 / 機器數
}
```

> ⚠️ **兩個限制**（跟 08 章 8.5.5 的本地快取兜底一樣）：
>
> 1. **機器數會變**（自動擴縮容），所以「全域上限 / 機器數」是個會飄的數字。
> 2. **負載不一定平均**，所以有些機器會比較早擋人。
>
> 📌 但它仍然遠遠好過 fail-open：**你至少有一個上限。**

### 10.11.3 ⚠️ 限流器不能讓請求變慢

```
限流器是「每一個請求都會經過」的東西。
   │
   └─ 它慢 10 毫秒 ──▶ 你的每一個 API 都慢 10 毫秒
      它卡住     ──▶ 你的整個服務卡住（08 章 8.2.4）
```

所以它的逾時**必須比一般的 Redis 操作更短**：

```yaml
lab10:
  rate-limit:
    timeout: 50ms          # ⚠️ 不是 06 章那個 500ms
    fail-open: true
```

用一個獨立的、逾時很短的 `RedisTemplate`：

```java
@Bean
public StringRedisTemplate rateLimitRedisTemplate(RedisConnectionFactory base) {
    LettuceConnectionFactory f = new LettuceConnectionFactory(
            ((LettuceConnectionFactory) base).getStandaloneConfiguration(),
            LettuceClientConfiguration.builder()
                    .commandTimeout(Duration.ofMillis(50))      // ⚠️ 50ms
                    .clientName("shop-service-ratelimit")
                    .build());
    f.afterPropertiesSet();
    return new StringRedisTemplate(f);
}
```

> 📌 **50 毫秒的理由**：限流是一個「本來就應該只花 1 毫秒」的操作。
> 它花到 50 毫秒就代表 Redis 有問題了——**這時候繼續等下去沒有任何好處**。
>
> ⚠️ **冪等鍵不能這樣設。** 它保護的是正確性，
> 逾時短只會讓它更常失敗，而失敗必須變成 503（不能 fail-open）。

---

## 10.12 落地：shop-service

### 10.12.1 三層限流

```
   請求
    │
    ├─ ① Nginx / API Gateway      IP 維度，1000/分   ← 擋明顯的攻擊，不進 Java
    │
    ├─ ② RateLimitFilter（10.6）   IP + API key，滑動窗計數器，fail-open + 本地兜底
    │
    ├─ ③ @RateLimit 註解           每個 API 各自的配額，使用者維度，令牌桶
    │
    └─ Controller
         └─ IdempotencyService（10.9）  ⚠️ fail-closed
              └─ LockTemplate（09 章 9.12）   ⚠️ fail-closed
                   └─ @Transactional
```

⚠️ **注意最裡面那三層的順序**——它是 09 章 9.8 那條規則的延伸：

```
冪等鍵  ──▶  鎖  ──▶  交易
  └─ 最外面：連「要不要做」都還沒決定
                └─ 中間：決定了要做，確保只有一個人在做
                        └─ 最裡面：真正動資料
```

### 10.12.2 設定

```yaml
lab10:
  rate-limit:
    enabled: true
    timeout: 50ms                    # ⚠️ 10.11.3：比一般操作短得多
    fail-open: true                  # ⚠️ 10.11.1：對外 API 要改成 false
    local-fallback: true             # 10.11.2
    tiers:
      - dimension: ip
        window: 60s
        limit: 1000                  # 10.6.3：第一層要寬（NAT）
        algorithm: sliding-counter
      - dimension: api-key
        window: 1s
        limit: 20
        algorithm: token-bucket
        burst: 40                    # 10.4.1：capacity ≠ rate
  idempotency:
    in-progress-ttl: 30s             # 10.9.7 ≒ 請求逾時
    done-ttl: 24h                    # 10.9.7 ≒ 客戶端最長重試窗
    wait-on-conflict: 300ms          # 10.9.8：只有結帳這類介面才開
    fail-open: false                 # ⚠️ 絕對不要改成 true
```

### 10.12.3 驗收

```
① 上限 5/秒，連送 7 個 → 5 個 200 + 2 個 429，且 429 帶 Retry-After     ✅ 10.7.2
② 跨窗邊界送 300 個（上限 100/秒）→ 任意一秒 ≤ 105 個                  ✅ 10.3.5
③ 同一個 Idempotency-Key 送兩次 → 兩次拿到同一個 orderId              ✅ 10.10.2
④ 10 個相同的 POST 同時送 → 訂單只有 1 張（1 個 200 ＋ 9 個 409）        ✅ 10.10.3
⑤ 同 key 不同 body → 422                                            ✅ 10.10.2
⑥ 業務丟例外 → 冪等鍵被刪掉，同一個 key 可以重試                       ✅ 10.9.6
⑦ docker pause redis-lab → 限流 fail-open（有本地兜底），冪等回 503     ✅ 10.11
```

### 10.12.4 四條規約（接續 09 章 9.12.4 的第 25 條）

26. **限流與冪等的每一段判斷邏輯都必須在 Lua 裡。**
    ⚠️ 專案裡不可以出現「先 `GET` 再 `SET`」形狀的限流／冪等程式碼（10.2.2、10.9.2）。
27. **`429` 一定要帶 `Retry-After`，`200` 一定要帶 `RateLimit-Remaining`**（10.7.4）。
28. **所有 `POST` 端點都要接受 `Idempotency-Key`**，缺少時回 400；
    ⚠️ 內部服務之間的呼叫也一樣（訊息佇列是 at-least-once）。
29. ⚠️ **`fail-open` 只能出現在限流的設定裡。**
    冪等與鎖的程式碼中，`catch` 區塊不可以有「當作沒問題」的分支（10.11.1）。

### 10.12.5 五個該接告警的指標（接續 09 章 9.12.5）

| 指標 | 告警條件 | 代表什麼 |
|---|---|---|
| `ratelimit.rejected`（429 數） | 某個維度突然 > 10 倍 | 攻擊、或某個客戶端的重試風暴 |
| **`ratelimit.degraded`** | **> 0** | **限流器正在 fail-open / 本地兜底**（10.11.2） |
| `ratelimit.latency.p99` | **> 20 ms** | 限流器本身變成瓶頸（10.11.3） |
| **`idempotency.replayed`** | 佔比突然上升 | **客戶端在大量重試**——去看它為什麼收不到回應 |
| **`idempotency.mismatch`** | **> 0 就看** | **客戶端有 bug**（同一個 key 送不同內容），或是有人在試探 |

> 📌 **`idempotency.replayed` 是一個很好的「客戶端健康度」指標。**
> 它平常應該接近 0。突然上升代表**有人收不到你的回應**——
> 那通常是你的 p99 延遲超過了對方的逾時設定，**而你的錯誤率圖表上什麼都看不到。**

---

## 10.13 常見誤區

**① 「固定窗簡單又省，先用它」**

10.2.3：邊界那一秒可以放進 **2.00 倍**流量，而且這是攻擊者最容易做到的事。

**② 「`INCR` 之後再 `EXPIRE` 就好」**

10.2.2：兩個命令中間掛掉 → 計數器永遠沒有 TTL → **那個使用者從此永遠被限流**。

**③ 「滑動窗最準，就用它」**

10.3.3：上限 1000/分 × 100 萬使用者 = **123 GB**。而且 ZSet 超過 128 個元素會換編碼（02 章）。

**④ 「令牌桶跟滑動窗差不多」**

10.4.1：**令牌桶把「平均速率」和「瞬間爆量」拆成兩個參數**，窗做不到。

**⑤ 「限流放 `Interceptor` 比較好寫，可以拿到使用者」**

10.6.2：Filter 看到 15 個請求，Interceptor 只看到 10 個。**404 不受限制**，而掃描器打的幾乎都是 404。

**⑥ 「多維度就是每個維度各檢查一次」**

10.6.5：邊查邊寫的話，**被拒絕的請求會把前面幾個維度的配額吃掉**，連累同一個 IP 的所有人。

**⑦ 「回 429 就好了」**

10.7.4：沒有 `Retry-After` 的話客戶端會**立刻重試**，
於是你的限流器被自己擋掉的流量打爆。

**⑧ 「用鎖就可以避免重複下單」**

10.8.3：鎖只保證「不同時」。第一個做完放鎖，第二個進來**照樣做一次**。

**⑨ 「先查有沒有做過，再做」**

10.9.2 實測 10 次：**重複 +48 ～ +100 張**，最糟的時候跟完全不做一模一樣，而且慢了 5 倍。
⚠️ 而它**偶爾會完全正確**——這正是它能通過 code review 的原因。
這是 09 章 9.2.1 那道縫的第三次出現。

**⑩ 「冪等鍵只要兩個狀態就夠」**

10.9.3：少了 `IN_PROGRESS`，同時到達的重試會**同時搶到**。

**⑪ 「第二次回 200 就好，不用回一樣的內容」**

10.9.5：客戶端拿不到訂單編號，**會用新的 key 再送一次**。冪等白做了。

**⑫ 「業務失敗了就讓冪等鍵留著」**

10.9.6：客戶端用同一個 key 重試會拿到 409，而且要等 30 秒。
⚠️ 系統錯誤要刪掉，業務錯誤要記成 `DONE`——**這兩種不一樣**。

**⑬ 「冪等鍵寫在交易裡面比較安全」**

10.9.9：Redis 上已經 `DONE`、資料庫還沒提交 →
**客戶端收到成功回應，但訂單不存在**。跟 09 章 9.8 同一個錯。

**⑭ 「Redis 掛了就先放行，限流又不是什麼重要的東西」**

10.11.1：限流可以 fail-open（**但要有本地兜底**），
⚠️ **冪等鍵絕對不行**——那等於「Redis 掛掉的 60 秒內，所有重試都重複執行」。

**⑮ 「限流器用跟其他操作一樣的逾時就好」**

10.11.3：它是**每一個請求都會經過**的東西。500 毫秒的逾時代表你的所有 API 都可能慢 500 毫秒。

---

## 10.14 本章小結

**限流：四個演算法，一句話選完**

```
要允許爆量 ──▶ 令牌桶（capacity 跟 rate 分開設）
記憶體吃得下 ──▶ 滑動窗 log（1.00 倍，最準）
其他       ──▶ 滑動窗計數器（1.05 倍，56 bytes）
⚠️ 不要用固定窗（2.00 倍）
```

**冪等：三個狀態，四件事情要做對**

```
① 客戶端產生 key，重試時不變
② 搶 key 的動作在 Lua 裡（不是「先查再做」）
③ 存回應，重放時回同一份
④ 冪等鍵在交易外面
```

**而這一章跟 09 章其實是同一章：**

| | 09 章 鎖 | 10 章 限流 | 10 章 冪等 |
|---|---|---|---|
| 那道縫 | 讀庫存→寫庫存 | `INCR`→`EXPIRE` | 查 key→做事 |
| 解法 | Lua | Lua | Lua |
| 跟交易的順序 | 鎖在外 | —— | 冪等鍵在外 |
| Redis 掛掉 | ❌ 失敗 | ⚠️ 看服務 | ❌ 失敗 |
| 壞掉時你會看到 | 超賣 | 下游被打爆 | 重複扣款 |
| **壞掉時監控會看到** | **什麼都沒有** | 下游的告警 | **什麼都沒有** |

> 📌 **最後那一列是這兩章真正的重點。**
> 這些機制壞掉的時候，**錯誤率是 0%、延遲是正常的、日誌是乾淨的。**
> 所以它們的正確性必須在**寫下第一行的時候**就確保，
> 而不是靠監控事後發現——**因為監控看不到。**

### 10.14.1 驗收清單

- [ ] 畫得出固定窗的邊界問題，並說出 2 倍那個數字怎麼來的。
- [ ] 說得出為什麼 `INCR` 和 `EXPIRE` 必須在同一段 Lua 裡。
- [ ] 算得出「上限 1000/分、100 萬使用者」用滑動窗 log 要多少記憶體。
- [ ] 說得出令牌桶的 `capacity` 跟 `rate` 分別控制什麼。
- [ ] 說得出為什麼令牌桶不需要背景任務去「補令牌」。
- [ ] 說得出 Filter 與 Interceptor 看到的請求差在哪，以及為什麼那個差很重要。
- [ ] ⚠️ 說得出多維度限流「邊查邊寫」會造成什麼後果。
- [ ] 說得出 429 至少要帶哪兩個標頭，以及少了它們客戶端會做什麼。
- [ ] 說得出「鎖」跟「冪等」的差別（提示：鎖不記得任何事）。
- [ ] 說得出為什麼「先查有沒有做過，再做」完全無效。
- [ ] 說得出冪等鍵的三個狀態，以及少了 `IN_PROGRESS` 會怎樣。
- [ ] 說得出業務失敗時，系統錯誤與業務錯誤對冪等鍵的處理**為什麼不一樣**。
- [ ] ⚠️ 說得出限流可以 fail-open 但冪等不行的理由。

### 10.14.2 本章練習

**練習一（15 分鐘）**：把 10.2.3 的實驗跑起來，**把窗長從 1 秒改成 60 秒**。
邊界那一分鐘可以塞進幾個請求？**用你自己下游的容量算一次，那些請求會在幾秒內打進去。**

**練習二（20 分鐘）**：實作 10.3.4 的滑動窗計數器，然後把 `PEXPIRE` 從 `window * 2`
改成 `window`。用 10.2.3 的流量量一次——**邊界問題回來了嗎？解釋為什麼。**

**練習三（25 分鐘）**：實作 10.4.2 的令牌桶，畫出 10.4.3 那張圖，然後：
① 把 `capacity` 從 20 改成 100，形狀變成什麼樣子？
② 把 `PEXPIRE` 改成 1 秒（很短），用「每 2 秒送 50 個」的流量打——
⚠️ **它還有限流的效果嗎？** 解釋為什麼。

**練習四（30 分鐘）**：實作 10.6.4 的多維度限流，然後**故意寫成「邊查邊寫」的版本**。
設計一個實驗證明「被拒絕的請求吃掉了其他維度的配額」——
提示：讓 API key 維度先爆掉，然後看 IP 維度的剩餘量。

**練習五（30 分鐘，核心）**：實作 10.9.4 的冪等鍵，然後：
① 把 `IN_PROGRESS` 狀態拿掉（只有「有 / 沒有」兩個狀態）；
② 用 10.10.3 的方式送 10 個同時的請求；
③ **量一次建立了幾張訂單**，並解釋那個數字。

**練習六（進階，40 分鐘）**：實作 10.9.8 的「短暫等待」版本（最多等 300 毫秒）。
然後用 08 章 8.4.1 的 Little's Law 算一次：
⚠️ **如果有 30% 的請求都要等這 300 毫秒，你的服務吞吐量上限掉到多少？**
用 50 條執行緒的壓測驗證你的計算。

**練習七（進階，40 分鐘）**：把限流器改成 10.11.3 的獨立 `RedisTemplate`（逾時 50 毫秒），
然後 `docker pause redis-lab`，用 08 章的壓測骨架量一次：
① fail-open 沒有本地兜底 → 下游 QPS 漲到幾倍？
② fail-open + 本地兜底 → 幾倍？
③ fail-closed → 錯誤率多少？
**把三個數字放進一張表，然後決定你的服務要用哪一個。**

---

## 10.15 下一章預告

09 章的鎖、10 章的限流與冪等，都用 Redis 存了一份「**只有一份、而且必須是對的**」的狀態。

11 章要存的是另一種：**使用者的登入狀態**。

- 為什麼服務跑兩台之後，使用者會「**登入了又沒登入**」——
  而這個症狀在單機測試環境下**永遠不會出現**。
- Spring Session Redis：它到底把什麼東西寫進了 Redis，
  以及 ⚠️ **那個序列化器踩到的是 06 章 6.4 的哪一個坑**。
- Session 的 TTL 與「活躍就續期」，以及 ⚠️ **沒設 TTL 時記憶體怎麼長爆**——
  04 章的 `maxmemory` 開始驅逐時，**被驅逐掉的是別人的購物車**。
- JWT 的「無狀態」換來什麼、失去什麼：**你沒辦法讓一個已經發出去的 token 失效**。
- token 黑名單與 refresh token 撤銷、登出與「強制所有裝置下線」。

> 📌 **而 08 章 8.8 的決策表上，Session 那一行寫的是「直接失敗（401/503）」**——
> 理由跟這兩章一樣：
> **「Redis 查不到，就當作已登入」是一個安全漏洞，不是一個降級策略。**
