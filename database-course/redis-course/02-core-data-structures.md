# 第 02 章：五大核心資料結構與選型

> 判斷一個人 Redis 用得好不好，最快的方法是看他的 key 裡放了什麼。
> 用得不好的樣子很一致：所有東西都是 `SET key JSON字串`，需要改一個欄位就整份讀出來、解析、改完、寫回去。這樣用 Redis，你其實只是在用一個「比較快的 Memcached」，還額外承擔了競爭覆蓋的風險。
> 這章把五大結構的操作、時間複雜度、適用場景一次講完，重點不是背命令，而是建立**看到需求就知道該用哪個結構**的判斷力。

---

## 2.1 學習目標

完成本章後，你應該可以：

- 說明 String、Hash、List、Set、Sorted Set 各自的能力邊界與典型場景。
- 記住核心命令的時間複雜度，並指認出哪些是危險的 O(N) 操作。
- 用 `HINCRBY`、`ZINCRBY` 這類伺服器端運算取代「讀出來改再寫回去」。
- 說明為什麼 Sorted Set 的深度分頁不像 SQL 的 `OFFSET` 那樣越翻越慢。
- 知道 Sorted Set 的 score 是浮點數，以及它會在什麼情況失去精度。
- 面對一個新需求時，能用決策樹選出合適的結構並說出理由。

---

## 2.2 同一個需求，四種做法

先用一個具體需求體會差異。需求是：**記錄使用者的積分，支援加分、查詢、以及取全站前 10 名。**

### 做法 A：String 存 JSON（最常見，也最糟）

```bash
SET user:1001 "{\"name\":\"Alice\",\"points\":1200}"
```

加 50 分要三步：`GET` → 應用層解析並修改 → `SET` 回去。

問題：
- **有競爭覆蓋。** 兩個請求同時加 50，兩邊都讀到 1200，各自算出 1250，寫回去的結果是 1250 而不是 1300。少算了 50 分。
- **三次操作、兩次網路往返。**
- 要取前 10 名，你得把所有使用者都撈出來在應用層排序。完全不可行。

### 做法 B：String 存單一數值

```bash
SET user:points:1001 1200
INCRBY user:points:1001 50      # 原子操作，不會算錯
```

改善了競爭問題，但取前 10 名仍然做不到——你得掃所有 key。

### 做法 C：Hash

```bash
HSET user:1001 name "Alice" points 1200
HINCRBY user:1001 points 50     # 原子，且只動一個欄位
HGET user:1001 points
```

比 B 好的地方是：使用者的多個屬性收在一個 key 裡（key 數量少、記憶體省），而且能只更新其中一個欄位。但排名依然做不到。

### 做法 D：Sorted Set（正解）

```bash
ZADD user:points 1200 "user:1001"
ZINCRBY user:points 50 "user:1001"          # 原子加分
ZSCORE user:points "user:1001"               # 查自己的分數
ZREVRANK user:points "user:1001"             # 查自己排第幾
ZREVRANGE user:points 0 9 WITHSCORES         # 前 10 名
```

四個需求全部滿足，每個操作都是 O(1) 或 O(log N)。

**這就是選對結構的差別：不是「快一點」，是「原本做不到的事變成一行命令」。**

實務上通常會 C + D 併用：Hash 存使用者屬性，Sorted Set 專門負責排名。這不是重複儲存，是因為兩者回答的是不同問題。

---

## 2.3 String：最基本，也最容易被濫用

String 是 Redis 最基礎的型別，value 可以是文字、序列化物件、數字，甚至二進位資料（圖片、Protobuf）。上限是 512MB——但你永遠不該接近這個數字。

### 核心命令

```bash
SET key value [EX s] [NX|XX] [KEEPTTL] [GET]
GET key
MSET k1 v1 k2 v2          # 批次設定（一次往返）
MGET k1 k2 k3             # 批次讀取
STRLEN key
APPEND key "more"         # 追加，回傳新長度
GETRANGE key 0 9          # 取子字串（支援負索引）
SETRANGE key 5 "xyz"      # 從位移 5 開始覆寫
```

`MGET` 值得特別強調。以下兩段的效能差距非常大：

```javascript
// 慢：100 次網路往返
for (const id of ids) {
  results.push(await redis.get(`product:${id}`));
}

// 快：1 次網路往返
const keys = ids.map(id => `product:${id}`);
const results = await redis.mget(keys);
```

在跨機房或雲端環境，單次往返可能是 1ms 以上。100 次就是 100ms，而 `MGET` 是 1ms 多。這是 Redis 使用上最容易拿到的效能提升之一。

（更一般化的解法是 pipeline，第 07 章會講。`MGET` 的限制是只能用在 String 上，且不能混不同命令。）

### 計數器：原子性是重點

```bash
INCR counter:views              # +1
INCRBY counter:views 10        # +10
DECR counter:stock             # -1
DECRBY counter:stock 5
INCRBYFLOAT price:btc 0.5      # 浮點版
```

三個要知道的細節：

**`INCR` 對「不存在的 key」的處理是當成 0。** 所以你不需要先初始化：

```bash
DEL counter:new
INCR counter:new     # (integer) 1
```

**value 必須是能解析成 64 位元有號整數的字串。** 否則報錯：

```bash
SET counter:bad "abc"
INCR counter:bad
# (error) ERR value is not an integer or out of range
```

**`INCRBYFLOAT` 沒有對應的 `DECRBYFLOAT`。** 要減就傳負數：`INCRBYFLOAT key -0.5`。

### 位元操作

String 也能當位元陣列用，這是第 03 章 Bitmap 的基礎：

```bash
SETBIT online:20260813 1001 1     # 標記使用者 1001 上線
GETBIT online:20260813 1001
BITCOUNT online:20260813          # 有幾個 1（幾人上線）
```

### String 的適用與不適用

**適合：**
- 快取整份物件（讀取時總是整份取用，不需要局部更新）。
- 計數器。
- 分散式鎖（`SET ... NX EX`）。
- Session（如果總是整份讀寫）。
- 簡單的旗標與設定值。

**不適合：**
- 需要頻繁更新其中一個欄位 → 用 Hash。
- 存很大的物件（超過幾十 KB 就要警覺）→ 拆開。
- 需要排序、範圍查詢、集合運算 → 用對應的結構。

### 一個判斷準則

```text
問自己：我會不會只想改這份資料的一小部分？

會   -> 用 Hash（或其他結構）
不會 -> String 存序列化資料沒問題
```

---

## 2.4 Hash：一個 key 存多個欄位

Hash 是 key 底下再掛一層 field-value 的映射，很自然地對應「一個物件」。

### 核心命令

```bash
HSET user:1001 name "Alice" level "vip" points 1200   # 可一次設多組
HGET user:1001 level
HMGET user:1001 name points          # 批次取指定欄位
HDEL user:1001 level
HEXISTS user:1001 name
HLEN user:1001
HINCRBY user:1001 points 50          # 原子加減（整數）
HINCRBYFLOAT user:1001 balance 9.9
HSETNX user:1001 created_at "..."    # 只在 field 不存在時設定

HKEYS user:1001                      # 所有 field    O(N) 注意
HVALS user:1001                      # 所有 value    O(N) 注意
HGETALL user:1001                    # 全部          O(N) 注意
HSCAN user:1001 0 COUNT 100          # 安全的漸進遍歷
HRANDFIELD user:1001 2 WITHVALUES    # 隨機取 field（6.2+）
```

`HMSET` 已被標記為 deprecated，用 `HSET` 帶多組參數即可（4.0+）。

### Hash 的兩個真正優勢

**優勢 1：局部更新是原子的。**

```bash
# String 做法：三步，有競爭風險
GET user:1001                                  # {"points":1200,...}
# 應用層改 points 為 1250
SET user:1001 "{\"points\":1250,...}"          # 可能覆蓋掉別人剛改的 level 欄位

# Hash 做法：一步，只動 points，不影響其他欄位
HINCRBY user:1001 points 50
```

注意 String 做法的隱藏危害：它不只可能算錯 points，還會**把別人同時修改的其他欄位覆蓋掉**。這種 bug 在測試環境幾乎測不出來，只在生產環境的併發下偶發，而且極難重現。

**優勢 2：省記憶體。**

當 Hash 的欄位數少於 `hash-max-listpack-entries`（預設 128）、且每個值長度小於 `hash-max-listpack-value`（預設 64 bytes）時，Redis 用 **listpack** 這種緊湊的連續記憶體結構儲存，而不是 hashtable。

```bash
HSET small:hash f1 v1 f2 v2
OBJECT ENCODING small:hash
# "listpack"
```

超過閾值就會轉成 hashtable，且**這個轉換是不可逆的**（即使後來刪到只剩幾個欄位也不會轉回來）。

這帶出一個經典的記憶體優化技巧：**把大量小 key 合併成分片的 Hash。**

```bash
# 原本：一千萬個獨立 key，每個都有幾十 bytes 的固定開銷
user:name:1  user:name:2  ...  user:name:10000000

# 優化：按 id 除以 100 分片，每個 Hash 約 100 個 field（在 listpack 閾值內）
HSET user:name:shard:0 1 "Alice" 2 "Bob" ... 99 "..."
HSET user:name:shard:1 100 "..." 101 "..." ...
```

記憶體可能省下數倍。第 05 章會實測這個差異並說明為什麼有效。

### Hash 的危險操作

`HGETALL` 是最容易被誤用的命令。它是 O(N)，N 是欄位數：

```bash
HGETALL user:1001         # 10 個欄位，沒問題
HGETALL big:hash          # 50 萬個欄位，會卡住整個 Redis
```

第 00 章的練習 3 就是在體驗這件事。原則：

```text
欄位數固定且很少（幾十個）      -> HGETALL 可以
欄位數會隨業務成長（可能上千）   -> 只用 HMGET 取需要的，或用 HSCAN
```

### 適用場景

- 使用者資料、商品屬性等「物件型」資料，且需要局部更新。
- 購物車（field 是商品 ID、value 是數量，`HINCRBY` 加減）。
- 需要對某個欄位做原子計數的場景。
- 大量小 key 的記憶體優化（分片 Hash）。

### 不適用

- 欄位數會無限成長（例如「每次操作 append 一個 field」）→ 這會養出 big key。
- 需要對 value 排序或做範圍查詢 → Hash 的 field 是無序的，用 Sorted Set。
- 需要為每個欄位設定不同的過期時間 → 7.4 以前做不到（7.4 有 `HEXPIRE`，見第 01 章），否則拆成獨立 key。

---

## 2.5 List：有序序列，適合當佇列與時間軸

List 是雙向連結序列，兩端的插入刪除都是 O(1)。

### 核心命令

```bash
LPUSH queue "a" "b"       # 從左邊推入（可多個）
RPUSH queue "c"           # 從右邊推入
LPOP queue [count]        # 從左邊彈出（count 是 6.2+）
RPOP queue [count]
LLEN queue

LRANGE queue 0 -1         # 取範圍（0 到 -1 = 全部）O(S+N) 注意
LINDEX queue 5            # 取指定位置 O(N)
LSET queue 0 "new"
LINSERT queue BEFORE "b" "x"
LREM queue 2 "a"          # 移除 2 個值為 "a" 的元素
LTRIM queue 0 99          # 只保留前 100 個，其餘刪除

LPOS queue "b"            # 找元素位置（6.0.6+）
LMOVE src dst LEFT RIGHT  # 原子搬移（6.2+，取代 RPOPLPUSH）

BLPOP queue 5             # 阻塞式彈出，最多等 5 秒（0 = 無限等）
BRPOP queue 0
BLMOVE src dst LEFT RIGHT 0
LMPOP 2 q1 q2 LEFT COUNT 10    # 從多個 list 彈出（7.0+）
```

### 兩個經典用法

**用法 1：訊息佇列**

```bash
# 生產者
LPUSH task:queue "{\"jobId\":1,\"type\":\"email\"}"

# 消費者：阻塞等待，有任務立刻拿到，不必輪詢
BRPOP task:queue 0
```

`BRPOP` 的價值在於避免忙輪詢。用 `RPOP` 加 sleep 的話，要嘛延遲高（sleep 久），要嘛浪費 CPU 和網路（sleep 短）；`BRPOP` 是有任務就立刻返回。

但 List 佇列有個致命限制：**沒有確認機制（ack）。** 消費者拿到任務後崩潰，這個任務就永遠消失了。緩解方式是用 `LMOVE` 把任務搬到「處理中」列表：

```bash
LMOVE task:queue task:processing RIGHT LEFT
# 處理完成後才從 task:processing 移除
# 崩潰的話，任務還在 task:processing，可以由監控補償
```

這已經是在手工實作 ack 了。**如果你發現自己在做這件事，該換用 Stream**（第 08 章），它原生提供消費者群組、ack、pending 清單與訊息認領。

**用法 2：固定長度的時間軸 / 最新 N 筆**

```bash
LPUSH user:timeline:1001 "post:9999"
LTRIM user:timeline:1001 0 99      # 只保留最新 100 筆
```

`LPUSH` + `LTRIM` 的組合是 Redis 的經典模式：每次寫入後裁切，讓 List 長度有上限。這同時解決了「取最新 N 筆」和「防止 List 無限成長」兩個問題。

適用於：使用者動態、最近瀏覽紀錄、最新評論、操作日誌。

### List 的效能陷阱

**`LRANGE key 0 -1` 是 O(N)。** 取一個十萬元素的 List 全部內容，會同時造成阻塞和大量網路傳輸。

**`LINDEX` 和 `LINSERT` 是 O(N)。** List 底層是連結結構（7.x 用 listpack + quicklist），要存取中間的元素必須從一端走過去。所以 List **不適合當「隨機存取的陣列」用**。

```text
List 該用的地方：兩端操作（push/pop）、取靠近頭部的一小段
List 不該用的地方：頻繁存取中間位置、需要排序、需要去重
```

### 適用與不適用

**適合：**
- 簡單的任務佇列（可容忍無 ack，或自行補償）。
- 最新 N 筆的時間軸（配 `LTRIM`）。
- 需要保序、允許重複的序列。
- 生產者消費者模式（配 `BRPOP`）。

**不適合：**
- 需要可靠消費的訊息系統 → Stream 或專門的 MQ。
- 需要按內容查詢或去重 → Set。
- 需要排序 → Sorted Set。
- 隨機存取中間元素 → 重新設計資料結構。

---

## 2.6 Set：無序不重複集合

Set 的兩個核心能力是**去重**和**集合運算**。

### 核心命令

```bash
SADD tags:post:1 "redis" "database" "cache"
SREM tags:post:1 "cache"
SCARD tags:post:1                  # 元素數量 O(1)
SISMEMBER tags:post:1 "redis"      # 是否存在 O(1)
SMISMEMBER tags:post:1 "redis" "sql"   # 批次判斷（6.2+）

SMEMBERS tags:post:1               # 全部元素 O(N) 注意
SSCAN tags:post:1 0 COUNT 100      # 安全的漸進遍歷

SPOP tags:post:1 [count]           # 隨機彈出並移除
SRANDMEMBER tags:post:1 [count]    # 隨機取但不移除
SMOVE src dst "redis"              # 原子搬移

# 集合運算
SINTER set1 set2                   # 交集
SUNION set1 set2                   # 聯集
SDIFF set1 set2                    # 差集（在 set1 但不在 set2）
SINTERSTORE dst set1 set2          # 交集結果存到 dst
SINTERCARD 2 set1 set2 [LIMIT n]   # 只要交集數量，不要內容（7.0+）
```

`SINTERCARD` 是很實用的 7.0 新命令。想知道「兩個使用者有幾個共同好友」，以前得 `SINTERSTORE` 到一個臨時 key 再 `SCARD`，現在一步搞定，而且 `LIMIT` 可以提前中斷（例如只需要知道「是否超過 100 個」）。

### 典型用法

**用法 1：去重與存在判斷**

```bash
# 文章瀏覽去重（同一使用者只算一次）
SADD article:1:viewers "user:1001"
SCARD article:1:viewers              # 不重複瀏覽人數

# 判斷是否已投票
SISMEMBER poll:1:voted "user:1001"
```

`SISMEMBER` 是 O(1)，這是 Set 相對 List 的關鍵優勢（List 判斷元素存在是 O(N)）。

**用法 2：標籤與共同好友**

```bash
SADD user:1001:follows "user:2001" "user:2002" "user:2003"
SADD user:1002:follows "user:2002" "user:2003" "user:2004"

SINTER user:1001:follows user:1002:follows      # 共同關注
SDIFF user:1001:follows user:1002:follows       # 我關注但他沒關注（推薦來源）
```

這種「多維度篩選」用 SQL 要寫 JOIN 加 `GROUP BY`，用 Set 是一行。

**用法 3：抽獎**

```bash
SADD lottery:2026 "user:1001" "user:1002" ...
SPOP lottery:2026 3            # 抽 3 個中獎者，且不會重複中獎
SRANDMEMBER lottery:2026 3     # 抽 3 個但保留在池子裡（可重複中獎）
```

`SRANDMEMBER` 有個少見但有用的行為：**count 傳負數時允許重複**。

```bash
SRANDMEMBER lottery:2026 -5    # 回 5 個，可能重複（有放回抽樣）
SRANDMEMBER lottery:2026 5     # 回最多 5 個，不重複（無放回抽樣）
```

### Set 的效能陷阱

**`SMEMBERS` 是 O(N)。** 和 `HGETALL`、`LRANGE 0 -1` 同一類問題。大集合請用 `SSCAN`。

**集合運算的複雜度要算清楚。** `SINTER` 是 O(N*M)（N 是最小集合的大小，M 是集合數量），`SUNION` 是所有元素總數。對兩個各一百萬元素的 Set 做 `SUNIONSTORE`，這是一個實實在在的慢命令，會阻塞整個實例。

實務建議：**大集合運算不要在線上請求路徑做。** 改成定時任務算好結果存起來，或在從節點上算（但要注意從節點也服務讀流量）。

### 適用與不適用

**適合：**
- 去重（UV 統計、投票、瀏覽記錄）。
- 存在性判斷（黑白名單、權限、是否已讀）。
- 標籤系統。
- 關係運算（共同好友、推薦）。
- 抽獎。

**不適合：**
- 需要排序或排名 → Sorted Set。
- 需要保序 → List。
- 元素數量極大且只需要基數（不需要精確、不需要成員內容）→ HyperLogLog 能用 12KB 解決（第 03 章）。
- 需要儲存 field-value 對應 → Hash。

---

## 2.7 Sorted Set：Redis 最強的結構

Sorted Set（ZSet）在 Set 的基礎上，給每個成員一個 `score`（分數），並按 score 排序。它是 Redis 裡最強大也最常被低估的結構。

底層是 **skiplist（跳表）+ hashtable** 的組合：skiplist 提供按 score 的有序存取（O(log N)），hashtable 提供按 member 查 score（O(1)）。所以它能同時高效回答「這個人幾分」和「第 N 名是誰」。

### 核心命令

```bash
ZADD rank 1200 "user:1001" 980 "user:1002"
ZADD rank GT 1500 "user:1001"      # 只在新分數更大時更新（7.0 之前無此選項）
ZADD rank INCR 50 "user:1001"      # 加分並回傳新分數
ZINCRBY rank 50 "user:1001"        # 加分（等價於上面）

ZSCORE rank "user:1001"            # 查分數 O(1)
ZMSCORE rank "user:1001" "user:1002"   # 批次查（6.2+）
ZCARD rank                          # 成員數 O(1)
ZCOUNT rank 1000 2000               # score 在區間內的數量 O(log N)

ZRANK rank "user:1001"              # 排名（從小到大，0 起算）
ZREVRANK rank "user:1001"           # 排名（從大到小）

# 6.2 統一後的 ZRANGE，建議一律用這個
ZRANGE rank 0 9                          # 按索引取前 10（升序）
ZRANGE rank 0 9 REV WITHSCORES            # 按索引取前 10（降序）+ 分數
ZRANGE rank 1000 2000 BYSCORE             # 按 score 區間取
ZRANGE rank "(1000" "+inf" BYSCORE LIMIT 0 10   # 開區間 + 分頁
ZRANGESTORE dst rank 0 9 REV              # 結果直接存到另一個 key（6.2+）

ZREM rank "user:1002"
ZREMRANGEBYRANK rank 0 -101         # 只保留最後 100 名之外的都刪（裁切榜單）
ZREMRANGEBYSCORE rank "-inf" 100    # 刪掉分數低於 100 的

ZPOPMIN rank [count]                # 彈出最小的（優先佇列用）
ZPOPMAX rank [count]
BZPOPMIN rank 0                     # 阻塞版
ZMPOP 2 z1 z2 MIN COUNT 5           # 多 key 彈出（7.0+）

ZUNIONSTORE dst 2 z1 z2 WEIGHTS 1 2   # 聯集，可加權
ZINTERSTORE dst 2 z1 z2
ZDIFF 2 z1 z2 WITHSCORES              # 6.2+
ZINTERCARD 2 z1 z2                    # 7.0+
```

`ZRANGEBYSCORE`、`ZREVRANGE`、`ZREVRANGEBYSCORE` 在 6.2 之後都被 `ZRANGE` 的選項統一了，舊命令仍可用但已 deprecated。**新專案建議一律用 `ZRANGE` 加 `REV` / `BYSCORE` / `BYLEX` / `LIMIT`**，少記三個命令。

### 用法 1：排行榜（含分頁）

```bash
ZINCRBY rank:sales:daily:2026-08-13 1 "product:1001"

# 第 1 頁（前 20 名）
ZRANGE rank:sales:daily:2026-08-13 0 19 REV WITHSCORES
# 第 2 頁
ZRANGE rank:sales:daily:2026-08-13 20 39 REV WITHSCORES
# 第 5000 頁
ZRANGE rank:sales:daily:2026-08-13 99980 99999 REV WITHSCORES
```

**這裡有個重要的效能特性：按索引的深度分頁不會變慢。**

```text
SQL:  SELECT ... ORDER BY score DESC LIMIT 20 OFFSET 99980
      -> 資料庫必須實際掃過並丟棄前 99980 筆，OFFSET 越大越慢

ZSet: ZRANGE key 99980 99999 REV
      -> skiplist 支援按 rank 直接定位，是 O(log N + 20)
      -> 第 5000 頁和第 1 頁的成本幾乎一樣
```

這是 Redis 做排行榜的殺手級優勢。SQL 的深度分頁需要用「游標分頁」等技巧繞過，ZSet 天生就沒這個問題。

**但要注意一個例外**：`BYSCORE` 配大 `LIMIT offset` 就沒有這個好處了。

```bash
ZRANGE rank 0 "+inf" BYSCORE LIMIT 99980 20    # 這個 offset 需要實際走過去，是 O(N)
```

所以深度分頁要用**索引**（`ZRANGE key start stop`），不要用 `BYSCORE` 加大 offset。

### 用法 2：延遲佇列 / 定時任務

把「執行時間戳」當 score：

```bash
# 排程一個 5 分鐘後執行的任務
ZADD delay:queue 1786000300 "job:8888"

# 工作者定期撈出「已到時間」的任務
ZRANGE delay:queue 0 1786000300 BYSCORE LIMIT 0 10
# 取到後移除（實務上要用 Lua 保證原子，見第 07 章）
```

這是 Redis 實作延遲任務最常見的做法。注意撈出和移除必須原子，否則多個工作者會重複拿到同一個任務。

### 用法 3：範圍查詢與滑動窗口

```bash
# 一小時內的操作記錄（score = 時間戳）
ZADD user:1001:actions 1786000000 "login" 1786000100 "view:product:1"

# 清掉一小時前的
ZREMRANGEBYSCORE user:1001:actions "-inf" 1785996400
# 數一數窗口內有幾次操作 -> 這就是滑動窗口限流的核心（第 10 章）
ZCARD user:1001:actions
```

### 用法 4：字典序範圍查詢（`BYLEX`）

當**所有成員的 score 都相同**時，Sorted Set 會按成員的字典序排列，這時可以做前綴查詢：

```bash
ZADD autocomplete 0 "redis" 0 "redisearch" 0 "redis-cli" 0 "mysql"
ZRANGE autocomplete "[redis" "[redis\xff" BYLEX
# 1) "redis"  2) "redis-cli"  3) "redisearch"
```

這可以做簡單的自動補全。但要注意：**這只在所有 score 相同時才有意義**，score 不同時結果會很奇怪。而且真正的搜尋需求（模糊匹配、多語言分詞、相關性排序）該用 Elasticsearch 或 RediSearch 模組。

### score 的精度陷阱

**score 是 IEEE 754 雙精度浮點數。** 它能精確表示的整數上限是 2^53（約 9×10^15）。

這通常沒問題：

```bash
ZADD ts 1786000000000 "event:1"     # 毫秒時間戳，13 位數，安全
```

但這會出事：

```bash
ZADD ids 1234567890123456789 "member"   # 19 位數的雪花 ID
ZSCORE ids "member"
# "1234567890123456800"      <- 精度丟失了！
```

所以：**不要把長整數 ID（雪花 ID、UUID 轉數字）當 score。** 如果需要，把 ID 放在 member，score 用時間戳或其他可安全表示的數值。

另一個相關細節：`ZINCRBY` 對浮點數累加會有累積誤差。如果你在做金額計算，**不要用 ZSet 的 score 存金額**——用整數的「分」為單位，或者根本不要在 Redis 做金額累加。

### 適用與不適用

**適合：**
- 排行榜（含深度分頁）。
- 延遲佇列、定時任務。
- 滑動窗口限流。
- 需要按分數範圍查詢的場景。
- 優先佇列（`ZPOPMIN`）。
- 帶時間維度的記錄（score = 時間戳）。

**不適合：**
- 不需要排序的去重 → Set 更省記憶體。
- score 需要超過 2^53 的精度 → 重新設計。
- 金額等要求精確小數的累加 → 用資料庫。
- 成員數量極大且要做集合運算 → 注意 `ZUNIONSTORE` 的複雜度。

---

## 2.8 選型決策樹與複雜度總表

### 決策樹

```text
這份資料需要排序或排名嗎？
├─ 是 -> Sorted Set
└─ 否 -> 需要去重 / 判斷是否存在嗎？
         ├─ 是 -> Set
         └─ 否 -> 需要保持插入順序、或當佇列用嗎？
                  ├─ 是 -> List（可靠消費需求 -> Stream）
                  └─ 否 -> 是一個物件、且會只改部分欄位嗎？
                           ├─ 是 -> Hash
                           └─ 否 -> String
```

補充三個常見的追加判斷：

```text
只需要「有多少個不重複的」，不需要成員內容，且量極大？
  -> HyperLogLog（12KB 搞定上億，誤差約 0.81%）

只需要標記「是 / 否」，且 ID 是連續整數？
  -> Bitmap（一千萬使用者的簽到只需 1.25MB）

需要多消費者、確認機制、訊息回溯？
  -> Stream
```

（這三個是第 03 章與第 08 章的主題。）

### 複雜度總表

把危險操作標出來，這張表值得記住：

| 結構 | 常用 O(1) 操作 | O(log N) 操作 | 危險的 O(N) 操作 |
|------|---------------|--------------|-----------------|
| String | `GET` `SET` `INCR` `STRLEN` | — | `GETRANGE` 大範圍 |
| Hash | `HGET` `HSET` `HDEL` `HLEN` `HINCRBY` `HEXISTS` | — | **`HGETALL` `HKEYS` `HVALS`** |
| List | `LPUSH` `RPUSH` `LPOP` `RPOP` `LLEN` | — | **`LRANGE` 大範圍** `LINDEX` `LINSERT` `LREM` |
| Set | `SADD` `SREM` `SISMEMBER` `SCARD` `SPOP` | — | **`SMEMBERS`** `SINTER` `SUNION` `SDIFF` |
| Sorted Set | `ZSCORE` `ZCARD` | `ZADD` `ZINCRBY` `ZRANK` `ZRANGE`（按索引）`ZCOUNT` | **`ZRANGE 0 -1`** `ZUNIONSTORE` `ZINTERSTORE` |

一個好記的規律：

```text
「取全部」的命令幾乎都是 O(N)，都有對應的安全替代品：

HGETALL  -> HSCAN 或 HMGET
SMEMBERS -> SSCAN 或 SISMEMBER
LRANGE 0 -1 -> LRANGE 0 99（限制範圍）
ZRANGE 0 -1 -> ZRANGE 0 99 或 ZSCAN
KEYS *   -> SCAN
```

---

## 2.9 常見錯誤

### 錯誤 1：所有東西都用 String 存 JSON

前面說過的競爭覆蓋與效率問題。只要你會「只想改一個欄位」，就該用 Hash。

### 錯誤 2：用「讀出來、改、寫回去」取代原子命令

```bash
# 錯
GET counter        # 100
SET counter 101    # 併發時會少算

# 對
INCR counter
```

同理，`HINCRBY`、`ZINCRBY`、`SADD` 都是原子的，優先用它們。

### 錯誤 3：在生產環境用 `HGETALL` / `SMEMBERS` / `LRANGE 0 -1`

小集合沒問題，但「小」是會隨業務長大的。設計時就要問：這個集合最大會到多少？如果答案是「不確定」，就用 `SCAN` 系列。

### 錯誤 4：用 List 做需要可靠消費的佇列

沒有 ack，消費者崩潰就丟訊息。用 Stream。

### 錯誤 5：用 List 判斷元素是否存在

`LPOS` 或遍歷都是 O(N)。這是 Set 的工作。

### 錯誤 6：把大整數 ID 當 ZSet 的 score

超過 2^53 會丟精度。ID 放 member，score 放時間戳或分數。

### 錯誤 7：ZSet 深度分頁用 `BYSCORE LIMIT offset`

大 offset 是 O(N)。用按索引的 `ZRANGE key start stop`。

### 錯誤 8：讓集合無限成長

沒有 `LTRIM`、沒有 `ZREMRANGEBYRANK`、沒有清理策略的集合，遲早變成 big key。**設計每個集合時，都要同時設計它的裁切策略。**

---

## 2.10 本章練習

### 練習 1：為六個需求選結構

說明你選的結構、key 設計與關鍵命令：

1. 記錄每篇文章的按讚使用者，需要顯示按讚數、判斷「我是否按過」。
2. 直播間彈幕，只需顯示最新 200 條。
3. 電商商品的多規格庫存（顏色 × 尺寸），需要單獨扣減某個規格。
4. 「本週熱搜關鍵字 Top 10」。
5. 使用者的未讀通知，需要知道總數、標記已讀、列出最新 20 筆。
6. 訂單超時未付款，30 分鐘後自動取消。

<details>
<summary>參考解答</summary>

**1. 文章按讚 → Set**

```bash
SADD article:1:likes "user:1001"
SCARD article:1:likes                    # 按讚數 O(1)
SISMEMBER article:1:likes "user:1001"    # 我按過嗎 O(1)
SREM article:1:likes "user:1001"         # 取消按讚
```

三個需求（計數、去重、判斷存在）全部是 O(1)。若按讚數極大（百萬級）且不需要「誰按過」的名單，可以改成 String 計數器加 Bitmap 判斷，記憶體會小很多。

**2. 直播彈幕 → List + LTRIM**

```bash
LPUSH room:888:danmaku "{\"user\":\"Alice\",\"text\":\"讚\"}"
LTRIM room:888:danmaku 0 199        # 每次寫入後裁切
LRANGE room:888:danmaku 0 49        # 取最新 50 條
```

關鍵是 `LTRIM`——沒有它，熱門直播間的 List 會漲到幾百萬條變成 big key。

**3. 多規格庫存 → Hash**

```bash
HSET stock:product:1001 "red:M" 50 "red:L" 30 "blue:M" 20
HINCRBY stock:product:1001 "red:M" -1     # 原子扣減單一規格
HGET stock:product:1001 "red:M"
```

Hash 的 field 天然對應規格組合，`HINCRBY` 保證扣減原子。用 String 存整份 JSON 會有併發覆蓋問題。

注意 `HINCRBY` **不會阻止扣成負數**，防超賣要用 Lua 先判斷再扣（第 07 章）。

**4. 本週熱搜 Top 10 → Sorted Set**

```bash
ZINCRBY search:hot:weekly:2026-W33 1 "redis 教學"
ZRANGE search:hot:weekly:2026-W33 0 9 REV WITHSCORES
EXPIRE search:hot:weekly:2026-W33 1209600     # 兩週後自動清
```

把週次編進 key，換週就是換 key，舊資料靠 TTL 自動清理。

**5. 未讀通知 → Sorted Set（或 List + String 計數）**

推薦 Sorted Set，score 用時間戳：

```bash
ZADD notify:unread:1001 1786000000 "notify:9001"
ZCARD notify:unread:1001                              # 未讀總數 O(1)
ZRANGE notify:unread:1001 0 19 REV                    # 最新 20 筆
ZREM notify:unread:1001 "notify:9001"                 # 標記單筆已讀
ZREMRANGEBYRANK notify:unread:1001 0 -1               # 全部已讀
```

比 List 好的原因：可以按 ID 精準移除單筆（List 的 `LREM` 是 O(N)），而且能按時間範圍查詢。

**6. 訂單超時取消 → Sorted Set 當延遲佇列**

```bash
# 下單時，score = 應取消的時間戳
ZADD order:timeout 1786001800 "order:8888"

# 背景工作者每秒撈一次
ZRANGE order:timeout 0 <現在的時間戳> BYSCORE LIMIT 0 100
# 處理後移除（要用 Lua 保證原子，避免多個工作者重複處理）
```

也有人用「Redis key 過期事件通知」來做，但**過期事件不可靠**（Redis 的 keyspace notification 是 fire-and-forget，訂閱者離線就丟失），不建議用在會影響金流的場景。ZSet 輪詢雖然土，但可靠且可重試。

</details>

### 練習 2：找出並修正競爭 bug

以下程式碼在壓測時發現「購物車數量偶爾算錯」。找出原因並用 Redis 命令修好。

```javascript
async function addToCart(userId, productId, qty) {
  const key = `user:cart:${userId}`;
  const raw = await redis.get(key);
  const cart = raw ? JSON.parse(raw) : {};

  cart[productId] = (cart[productId] || 0) + qty;

  await redis.set(key, JSON.stringify(cart), 'EX', 604800);
}
```

<details>
<summary>參考解答</summary>

**問題：這是典型的 read-modify-write 競爭。**

兩個請求同時把同一件商品加入購物車（各加 1 件）：

```text
時間  請求 A                        請求 B
t1    GET -> {"p1": 5}
t2                                  GET -> {"p1": 5}
t3    算出 {"p1": 6}
t4                                  算出 {"p1": 6}
t5    SET {"p1": 6}
t6                                  SET {"p1": 6}       <- 覆蓋

結果：數量是 6，但應該是 7。少算了一件。
```

更糟的情況是同時加入**不同**商品：

```text
請求 A：加入 p1  -> 讀到 {"p2": 3}，寫回 {"p2": 3, "p1": 1}
請求 B：加入 p2  -> 讀到 {"p2": 3}，寫回 {"p2": 4}         <- p1 整個消失了
```

不只算錯數量，還會**整筆丟失商品**。這種 bug 在單執行緒測試永遠測不出來。

**修法：用 Hash + `HINCRBY`**

```javascript
const CART_TTL = 604800;

async function addToCart(userId, productId, qty) {
  const key = `user:cart:${userId}`;
  await redis.hincrby(key, productId, qty);
  await redis.expire(key, CART_TTL);
}

async function getCart(userId) {
  return await redis.hgetall(`user:cart:${userId}`);
}

async function removeFromCart(userId, productId) {
  await redis.hdel(`user:cart:${userId}`, productId);
}

async function updateQty(userId, productId, qty) {
  const key = `user:cart:${userId}`;
  if (qty <= 0) {
    await redis.hdel(key, productId);
  } else {
    await redis.hset(key, productId, qty);   // 絕對數量，直接覆寫這個 field 即可
  }
}
```

`HINCRBY` 在伺服器端完成加法，且只碰指定的 field，兩個問題一次解決。

**三個要注意的細節：**

**細節一：`HINCRBY` 和 `EXPIRE` 是兩個命令。** 中間崩潰會留下沒有 TTL 的 key（第 01 章的問題）。要嘛接受這個風險（購物車通常也允許長期存在），要嘛用 pipeline 一起送（第 07 章），或用 Lua 保證原子。

**細節二：`HGETALL` 在購物車場景通常安全**，因為購物車的商品數有天然上限（幾十件）。但如果你的業務允許加入上千件商品，就要改用 `HSCAN` 或限制購物車大小。

**細節三：這裡用 `HINCRBY` 而不是 `HSET`，語意是「相對增加」。** 前端的「加入購物車」按鈕適合這個語意；但「把數量直接改成 3」要用 `HSET`，不要混淆。這是兩個不同的 API。

</details>

### 練習 3：實作一個完整的排行榜

實作一個遊戲週排行榜，需求：

- 玩家得分可累加。
- 顯示 Top 10（含分數）。
- 顯示某玩家的排名與分數，以及「距離上一名差幾分」。
- 只保留前 10000 名，超出的定期清理。
- 每週自動換榜。

<details>
<summary>參考解答</summary>

**key 設計**

```text
rank:game:weekly:2026-W33      Sorted Set
  member = playerId
  score  = 累積得分
  TTL    = 兩週（保留上週資料供查詢，之後自動清）
```

**實作**

```javascript
function weekKey(date = new Date()) {
  // ISO 週次，實務上建議用 date-fns 或 dayjs 的 ISO week 函式，這裡示意
  const year = date.getUTCFullYear();
  const week = getISOWeek(date);
  return `rank:game:weekly:${year}-W${String(week).padStart(2, '0')}`;
}

const RANK_TTL = 14 * 24 * 3600;
const MAX_RANK = 10000;

// 加分
async function addScore(playerId, points) {
  const key = weekKey();
  const newScore = await redis.zincrby(key, points, playerId);
  await redis.expire(key, RANK_TTL, 'GT');   // GT：只延長不縮短（7.0+）
  return Number(newScore);
}

// Top 10
async function topPlayers(n = 10) {
  const key = weekKey();
  const raw = await redis.zrange(key, 0, n - 1, 'REV', 'WITHSCORES');
  const result = [];
  for (let i = 0; i < raw.length; i += 2) {
    result.push({ rank: i / 2 + 1, playerId: raw[i], score: Number(raw[i + 1]) });
  }
  return result;
}

// 某玩家的排名資訊
async function playerRank(playerId) {
  const key = weekKey();
  const [rank, score] = await Promise.all([
    redis.zrevrank(key, playerId),
    redis.zscore(key, playerId),
  ]);

  if (rank === null) return null;   // 這週還沒得分

  const result = {
    rank: rank + 1,                 // ZREVRANK 從 0 起算
    score: Number(score),
    gapToNext: null,
  };

  // 距離上一名差幾分
  if (rank > 0) {
    const above = await redis.zrange(key, rank - 1, rank - 1, 'REV', 'WITHSCORES');
    result.gapToNext = Number(above[1]) - result.score;
  }

  return result;
}

// 裁切榜單（定時任務，例如每小時一次）
async function trimRank() {
  const key = weekKey();
  // 保留降序前 MAX_RANK 名 = 刪除升序的第 0 到 (總數 - MAX_RANK - 1) 名
  await redis.zremrangebyrank(key, 0, -MAX_RANK - 1);
}
```

**四個設計要點**

**要點一：週次編進 key，換週自動換榜。** 不需要任何「歸檔」邏輯，也不需要在半夜跑遷移。查上週榜就用上週的 key。

**要點二：`EXPIRE ... GT` 避免 TTL 被縮短。** 每次加分都續期，用 `GT` 保證只會往後延。沒有 `GT`（7.0 以前）就得先 `TTL` 讀出來比較，或改成只在第一次建榜時設 TTL。

**要點三：裁切用 `ZREMRANGEBYRANK` 的負索引。** `ZREMRANGEBYRANK key 0 -10001` 的意思是「刪掉升序的最前面那些，只留最後 10000 個」——也就是保留分數最高的 10000 名。負索引在這裡很好用，但很容易寫錯，建議寫測試驗證。

**要點四：`playerRank` 用了兩次往返（rank 和 score）。** 這裡用 `Promise.all` 併發送出已經不錯，更好的做法是 7.2+ 支援 `ZREVRANK key member WITHSCORE` 一次拿到兩者，或用 pipeline / Lua 合併（第 07 章）。

**進階：如果要「同分時按達成時間先後排序」怎麼辦？**

Sorted Set 同分時是按 member 的字典序排，不是時間。標準技巧是**把時間資訊編進 score 的小數部分**：

```javascript
// score = 分數 + (1 - 正規化時間戳)，讓先達成的人分數略高
const MAX_TS = 2 ** 41;   // 足夠涵蓋毫秒時間戳，且保持在安全精度內
function compositeScore(points, timestampMs) {
  return points + (1 - timestampMs / MAX_TS);
}
```

但要小心第 2.7 節講的精度問題：分數的整數部分越大，能留給小數部分的精度就越少。如果你的分數會超過幾百萬，這招會失準。更穩的做法是把「分數」和「時間」分成兩個維度，用 Lua 在讀取時做二次排序，或直接在應用層處理同分的少數情況。

</details>

---

## 2.11 驗收清單

進入下一章前，確認你可以：

- [ ] 說明「String 存 JSON」在併發下的兩種錯誤（算錯數值、覆蓋其他欄位）。
- [ ] 用 `MGET` 取代迴圈裡的多次 `GET`，並說明為什麼快。
- [ ] 說出 Hash 相對 String 的兩個優勢（原子局部更新、listpack 省記憶體）。
- [ ] 用 `LPUSH` + `LTRIM` 實作固定長度的時間軸。
- [ ] 說明 List 佇列缺少什麼機制，以及什麼時候該換 Stream。
- [ ] 說明 Set 的 `SISMEMBER` 為什麼比 List 的查找有優勢。
- [ ] 用 Sorted Set 實作排行榜，並說明為什麼它的深度分頁不像 SQL 的 `OFFSET` 那樣越翻越慢。
- [ ] 說出 `BYSCORE LIMIT offset` 這個例外，以及該怎麼避開。
- [ ] 說明 Sorted Set 的 score 精度上限，以及不能把雪花 ID 當 score 的原因。
- [ ] 背出每個結構的「危險 O(N) 命令」和它的安全替代品。
- [ ] 用決策樹為一個新需求選出結構並說出理由。

---

下一章我們處理三個「用對了省超多記憶體」的特殊結構：[03-advanced-data-structures.md](./03-advanced-data-structures.md)，包含 Bitmap、HyperLogLog、GEO 與 Bloom Filter。
