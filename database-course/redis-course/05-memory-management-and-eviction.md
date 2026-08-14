# 第 05 章：記憶體、內部編碼與驅逐策略

> Redis 的記憶體是它最貴的資源，也是最容易被浪費的資源。
> 常見的兩種失敗長這樣：一種是「我只存了 2GB 的資料，為什麼 `used_memory` 是 5GB」；另一種更嚴重——記憶體滿了，新的寫入直接回 `OOM command not allowed`，而且沒人知道為什麼會這樣。
> 這章要回答三個問題：記憶體到底花在哪、怎麼用內部編碼省下數倍空間、以及記憶體滿了之後八種驅逐策略該怎麼選。

---

## 5.1 學習目標

完成本章後，你應該可以：

- 逐項解讀 `INFO memory`，說出資料、開銷、緩衝區各佔多少。
- 說明 Redis 的內部編碼機制，並用 `OBJECT ENCODING` 驗證。
- 記住五種型別的編碼切換閾值，並知道轉換是不可逆的。
- 用「分片 Hash」把大量小 key 的記憶體降低數倍，並解釋原理。
- 說出八種驅逐策略的差別，並為不同場景選出正確的一種。
- 說明為什麼預設的 `noeviction` 在快取場景是個危險的選擇。
- 解釋 LRU 的近似實作與 LFU 的計數衰減機制，並選出適合的一種。
- 判斷記憶體碎片是否需要處理，以及 `activedefrag` 的取捨。
- 為一個業務做記憶體容量規劃。

---

## 5.2 記憶體到哪裡去了

先建立一個關鍵認知：**`used_memory` 不只是你存的資料。**

```bash
INFO memory
```

重要欄位的解讀：

| 欄位 | 意義 |
|------|------|
| `used_memory` | Redis 認為自己用了多少（配置器回報的量） |
| `used_memory_human` | 同上，人類可讀格式 |
| `used_memory_rss` | 作業系統看到這個行程實際佔用的實體記憶體 |
| `used_memory_peak` | 歷史最高峰（很重要，見下） |
| `used_memory_dataset` | 純資料佔用 |
| `used_memory_overhead` | 各種開銷（緩衝區、資料結構元資料、複製積壓等） |
| `used_memory_lua` / `used_memory_scripts` | Lua 引擎與快取的腳本 |
| `mem_fragmentation_ratio` | `used_memory_rss / used_memory`，碎片率 |
| `mem_allocator` | 記憶體配置器，通常是 jemalloc |
| `maxmemory` / `maxmemory_policy` | 上限與驅逐策略 |
| `mem_clients_normal` | 普通客戶端的緩衝區總量 |
| `mem_clients_slaves` | 從節點連線的緩衝區 |
| `mem_replication_backlog` | 複製積壓緩衝區 |
| `mem_aof_buffer` | AOF 緩衝區 |

### 記憶體的組成

```text
used_memory
├── 資料本身（used_memory_dataset）
│   ├── key 字串
│   ├── value 資料
│   ├── 每個 key 的物件頭與 dict entry
│   └── 過期字典（有 TTL 的 key 額外一份 entry）
│
└── 開銷（used_memory_overhead）
    ├── 客戶端輸入 / 輸出緩衝區       <- 連線多或有大回應時會很可觀
    ├── 複製積壓緩衝區（repl-backlog）
    ├── 從節點連線的輸出緩衝區
    ├── AOF 緩衝區
    └── Lua 腳本快取
```

**兩個實務推論：**

**推論 1：`used_memory_peak` 比當前值更值得關注。** 因為 jemalloc 不會馬上把釋放的記憶體還給作業系統，所以 `used_memory_rss` 通常會停留在接近峰值的水位。做容量規劃時要用峰值算，不是當前值。

```bash
INFO memory | grep -E "used_memory_human|used_memory_peak_human|used_memory_rss_human"
# used_memory_human:2.15G
# used_memory_peak_human:4.87G       <- 曾經衝到 4.87G
# used_memory_rss_human:4.92G        <- 作業系統看到的仍是 4.92G
```

如果你按「當前 2.15G」規劃機器，某天流量回到峰值就會出事。

**推論 2：客戶端緩衝區可能吃掉大量記憶體，而且很容易被忽略。**

```bash
INFO clients
# connected_clients:3500
# client_recent_max_input_buffer:1024
# client_recent_max_output_buffer:8388608     <- 有客戶端的輸出緩衝區到了 8MB
```

三千五百個連線，每個連線光是基本結構就有幾十 KB；如果有客戶端在跑 `HGETALL` 大集合或訂閱大量 Pub/Sub 訊息，輸出緩衝區會膨脹。**這些記憶體算在 `used_memory` 裡，也會計入 `maxmemory` 的判斷**（7.0 之前的行為，見第 5.8 節）。

### `MEMORY STATS` 與 `MEMORY DOCTOR`

更詳細的分解：

```bash
MEMORY STATS
# 會列出 peak.allocated、total.allocated、startup.allocated、
# replication.backlog、clients.slaves、clients.normal、aof.buffer、
# overhead.total、keys.count、dataset.bytes、dataset.percentage、
# fragmentation 等數十項

MEMORY DOCTOR
# "Sam, I detected a few issues in this Redis instance memory implants:
#  * High allocator fragmentation: ..."
```

`MEMORY DOCTOR` 會用人話指出問題（碎片過高、峰值遠大於當前值、有大量客戶端緩衝區等），排查時值得先跑一次。

---

## 5.3 內部編碼：Redis 省記憶體的核心機制

**同一個型別，Redis 內部可能用完全不同的資料結構實作。** 小集合用緊湊但操作較慢的結構，大集合用快但佔空間的結構。

用 `OBJECT ENCODING` 可以看到當前用的是哪一種：

```bash
SET k1 12345
OBJECT ENCODING k1
# "int"

SET k2 "hello"
OBJECT ENCODING k2
# "embstr"

SET k3 "這是一段超過四十四個位元組的字串，長度足以讓 Redis 改用 raw 編碼來儲存它"
OBJECT ENCODING k3
# "raw"
```

### 各型別的編碼與切換閾值

| 型別 | 小資料編碼 | 大資料編碼 | 切換條件（預設值） |
|------|-----------|-----------|-----------------|
| String | `int` | — | value 是 64 位元有號整數 |
| String | `embstr` | `raw` | 長度 ≤ 44 bytes 用 embstr |
| Hash | `listpack` | `hashtable` | 欄位數 ≤ 128 **且** 每個值長度 ≤ 64 bytes |
| List | `listpack` | `quicklist` | 小 list 用 listpack；大的用 quicklist（listpack 節點串起來） |
| Set | `intset` | `listpack` / `hashtable` | 全是整數且數量 ≤ 512 用 intset；小的非整數集合用 listpack（7.2+）；否則 hashtable |
| Sorted Set | `listpack` | `skiplist` | 成員數 ≤ 128 **且** 每個成員長度 ≤ 64 bytes |

對應的設定參數：

```bash
CONFIG GET hash-max-listpack-entries    # 128
CONFIG GET hash-max-listpack-value      # 64
CONFIG GET list-max-listpack-size       # 128（或 -2 表示按 8KB 大小限制）
CONFIG GET set-max-intset-entries       # 512
CONFIG GET set-max-listpack-entries     # 128
CONFIG GET set-max-listpack-value       # 64
CONFIG GET zset-max-listpack-entries    # 128
CONFIG GET zset-max-listpack-value      # 64
```

（Redis 7.0 之前這些參數叫 `*-max-ziplist-*`，因為當時的緊湊結構是 ziplist。7.0 用 listpack 取代了 ziplist，舊名稱仍然可用作別名。）

### listpack 為什麼省記憶體

listpack 是一段**連續的記憶體**，元素一個接一個緊密排列：

```text
hashtable 編碼（大 Hash）：
  每個 field-value 都要一個 dictEntry（含指標、hash 值）
  加上 sds 字串頭、記憶體對齊的浪費
  => 每個欄位的額外開銷可能是 50-100 bytes

listpack 編碼（小 Hash）：
  [總長度][元素數][field1][value1][field2][value2]...[結束標記]
  每個元素只有幾 bytes 的長度前綴
  => 額外開銷可能只有幾 bytes
```

代價是**查找是 O(N)**——要找某個 field 得從頭掃過去。但因為元素數量有上限（128），而且連續記憶體對 CPU 快取極友善，實際上比 hashtable 還快。

**這就是 Redis 的設計哲學：小集合用 O(N) 但常數極小的結構，反而更快也更省。**

### 實測差距

```bash
FLUSHDB

# 128 個欄位（listpack 邊界內）
EVAL "for i=1,128 do redis.call('HSET', KEYS[1], 'f'..i, 'v'..i) end return 1" 1 h:small
OBJECT ENCODING h:small
# "listpack"
MEMORY USAGE h:small
# (integer) 1800 左右

# 129 個欄位（超過閾值一個）
EVAL "for i=1,129 do redis.call('HSET', KEYS[1], 'f'..i, 'v'..i) end return 1" 1 h:big
OBJECT ENCODING h:big
# "hashtable"
MEMORY USAGE h:big
# (integer) 10000 左右
```

**多存一個欄位，記憶體漲了五倍以上。** 這個懸崖式的變化是編碼切換造成的。

### 轉換是不可逆的

```bash
DEL h:test
EVAL "for i=1,200 do redis.call('HSET', KEYS[1], 'f'..i, 'v'..i) end return 1" 1 h:test
OBJECT ENCODING h:test
# "hashtable"

# 刪到只剩 5 個欄位
EVAL "for i=6,200 do redis.call('HDEL', KEYS[1], 'f'..i) end return 1" 1 h:test
HLEN h:test
# (integer) 5
OBJECT ENCODING h:test
# "hashtable"     <- 沒有轉回 listpack！
```

**一旦升級成 hashtable，就永遠是 hashtable。** 想要回到 listpack 只能刪掉 key 重建：

```bash
# 取出資料 -> DEL -> 重新寫入
```

實務影響：如果你有一批 Hash 曾經短暫超過閾值（例如某次批次匯入寫多了），它們會永久佔用較多記憶體。這也是為什麼「設計時就要控制集合大小」比「事後清理」重要。

### 該不該調大閾值

有人會想：把 `hash-max-listpack-entries` 調到 1000，不就更省記憶體了嗎？

可以，但要小心：

```text
調大的好處：更多 Hash 保持 listpack 編碼，記憶體下降
調大的代價：listpack 的查找是 O(N)，1000 個欄位的線性掃描明顯變慢
            而且 listpack 的插入可能觸發整塊記憶體重新配置與搬移
```

實務建議：

- **調到 512 通常還算安全**，很多團隊會這樣做。
- **不要調到幾千**，那會讓單次 `HGET` 的成本上升到可觀的程度。
- **更好的做法是控制你的資料設計**，讓集合天然落在預設閾值內（下一節的分片 Hash 就是這個思路）。

---

## 5.4 記憶體優化實戰

### 技巧 1：分片 Hash 取代大量小 key

這是收益最大的一招。第 02 章提過，這裡算清楚為什麼。

**場景：一千萬個使用者，每人存一個暱稱。**

**做法 A：一千萬個獨立 String**

```bash
SET user:name:1 "Alice"
SET user:name:2 "Bob"
...
```

每個 key 的成本：

```text
key 字串 "user:name:1234567"     ≈ 17 bytes + sds 頭
value "Alice"                    ≈ 5 bytes + 物件頭
dictEntry（指標 × 3）             ≈ 24 bytes
robj 物件頭                       ≈ 16 bytes
jemalloc 對齊浪費                 ≈ 若干

實測每個 key 大約 70-100 bytes
=> 一千萬個約 700MB - 1GB
```

**做法 B：分片 Hash**

```bash
# 按 id / 100 分片，每個 Hash 約 100 個欄位（在 listpack 閾值 128 內）
HSET user:name:shard:0 1 "Alice" 2 "Bob" ... 99 "..."
HSET user:name:shard:1 100 "..." ...
```

成本：

```text
key 數量從一千萬降到十萬（省下 990 萬份的 key 開銷）
每個 Hash 用 listpack 編碼，內部元素幾乎沒有額外開銷

實測總量可能降到 200-300MB
```

**省下 3-4 倍記憶體，而且單點讀寫仍然是一次命令。**

實作：

```javascript
const SHARDS = 100;

function shardKey(userId) {
  return `user:name:shard:${Math.floor(userId / SHARDS)}`;
}

async function setName(userId, name) {
  await redis.hset(shardKey(userId), userId, name);
}

async function getName(userId) {
  return await redis.hget(shardKey(userId), userId);
}

// 批次讀取同一分片的多個使用者，只要一次命令
async function getNames(userIds) {
  const byShard = new Map();
  for (const id of userIds) {
    const key = shardKey(id);
    if (!byShard.has(key)) byShard.set(key, []);
    byShard.get(key).push(id);
  }

  const pipeline = redis.pipeline();
  for (const [key, ids] of byShard) {
    pipeline.hmget(key, ...ids);
  }
  return await pipeline.exec();
}
```

**分片數怎麼選？** 目標是讓每個 Hash 的欄位數落在 listpack 閾值內：

```text
分片數 = 預期總元素數 / 目標每片欄位數

一千萬使用者，目標每片 100 個欄位
=> 需要 10 萬個分片
=> 分片鍵用 userId / 100，或 hash(userId) % 100000
```

注意如果 ID 不是連續整數（例如是 UUID），要用 hash 函式取模，而不是除法。

**這個技巧的三個限制：**

1. **無法對單一使用者設 TTL**（TTL 在整個 Hash 上）。7.4+ 的 `HEXPIRE` 解決了這點，但要確認版本。
2. **跨分片的批次操作變複雜**，要自己分組（如上面的 `getNames`）。
3. **在 Cluster 模式下**，不同分片可能落在不同節點，pipeline 要處理跨節點的情況。

所以它適合「大量小而固定的資料，且不需要個別 TTL」的場景。使用者暱稱、對照表、設定值都很合適。

### 技巧 2：善用整數編碼與共享整數

Redis 對 0 到 9999 的整數有**共享物件池**——這些值不會為每個 key 各存一份：

```bash
SET a 100
SET b 100
OBJECT REFCOUNT a
# (integer) 2147483647     <- 這是共享物件的標記值
```

所以存小整數比存字串省很多：

```bash
SET n1 100        # int 編碼，共享物件
SET n2 "100"      # 一樣是 int 編碼（Redis 會嘗試轉換）
SET n3 "100 "     # 有空格，無法轉整數 -> embstr
```

實務建議：**狀態、等級、類型這些能用數字表達的，就用數字，不要用字串。**

```bash
# 較差
HSET order:8888 status "PAID"

# 較好（配合應用層的枚舉對照）
HSET order:8888 status 2
```

**一個重要例外：設定了 `maxmemory` 且用 LRU / LFU 策略時，共享整數會被停用。** 因為 LRU / LFU 需要為每個物件記錄存取時間或頻率，共享物件無法做到這件事。所以在有驅逐策略的實例上，這個優化不生效。

### 技巧 3：控制 key 長度（但不要走極端）

第 01 章講過的取捨，這裡給量化參考：

```text
一千萬個 key，key 名從 25 bytes 縮到 12 bytes
=> 省 130MB
```

有價值，但代價是可讀性。折衷做法：

```text
保留語意，去掉冗餘詞
user:profile:1001  ->  usr:prof:1001     （省 4 bytes，還能看懂）

不要做到這種程度
user:profile:1001  ->  u:p:1001          （三個月後沒人知道 p 是什麼）
```

### 技巧 4：value 的序列化格式

如果你在 String 裡存序列化的物件，格式選擇有明顯影響：

```text
JSON            {"userId":1001,"userName":"Alice","level":3}   43 bytes
MessagePack     二進位，約省 20-40%
Protobuf        需要 schema，約省 40-60%
```

但要權衡：

- JSON 可以用 `redis-cli` 直接讀懂，除錯方便。
- 二進位格式看到的是亂碼，排查時很痛苦。
- 二進位格式需要序列化庫，跨語言時要維護 schema。

**建議：只在資料量真的很大（GB 級）且已確認是瓶頸時，才換二進位格式。** 大多數情況下，用 Hash 取代 JSON String 帶來的收益更大且不損失可讀性。

### 技巧 5：不要忘記最有效的一招

**刪掉不需要的資料。**

```bash
# 找出沒有 TTL 的 key（第 01 章的練習）
# 找出 big key（第 04 章）
# 檢查是否有已廢棄功能留下的 key
redis-cli --scan --pattern "old_feature:*" | wc -l
```

實務經驗：很多「記憶體不夠」的問題，根源是三個月前下線的功能還在留著幾 GB 的資料，或某處漏設 TTL。在做複雜優化前，先確認你存的每一份資料都還有人在用。

---

## 5.5 maxmemory 與八種驅逐策略

### 為什麼一定要設 `maxmemory`

**不設 `maxmemory`（預設值 0，代表無限制）的後果是：Redis 會一直吃記憶體，直到被作業系統的 OOM killer 殺掉。**

```bash
CONFIG GET maxmemory
# 1) "maxmemory"
# 2) "0"                <- 危險
```

被 OOM killer 殺掉是最糟的結局：行程直接消失、沒有優雅關閉、如果沒有持久化就全部資料遺失、如果是主節點還會觸發故障轉移。

設定：

```bash
CONFIG SET maxmemory 4gb
# 或寫進 redis.conf
maxmemory 4gb
maxmemory-policy allkeys-lru
```

**該設多少？** 建議不超過實體記憶體的 **60-70%**。為什麼要留這麼多餘裕：

```text
需要額外記憶體的地方：
  fork 時的 copy-on-write（寫入越頻繁，複製越多）
  客戶端緩衝區（連線數多時可觀）
  複製積壓緩衝區
  AOF 緩衝區與重寫期間的暫存
  jemalloc 的碎片

實體記憶體 16GB -> maxmemory 建議 8-10GB
```

### 八種策略

```bash
CONFIG SET maxmemory-policy <policy>
```

| 策略 | 選擇範圍 | 淘汰依據 |
|------|---------|---------|
| `noeviction` | 不淘汰 | 記憶體滿時，寫入命令回錯誤 |
| `allkeys-lru` | 所有 key | 最久未使用 |
| `allkeys-lfu` | 所有 key | 使用頻率最低 |
| `allkeys-random` | 所有 key | 隨機 |
| `volatile-lru` | **只有設了 TTL 的 key** | 最久未使用 |
| `volatile-lfu` | 只有設了 TTL 的 key | 使用頻率最低 |
| `volatile-random` | 只有設了 TTL 的 key | 隨機 |
| `volatile-ttl` | 只有設了 TTL 的 key | 剩餘 TTL 最短 |

### `noeviction` 是預設值，這是個陷阱

```bash
CONFIG GET maxmemory-policy
# "noeviction"      <- 預設
```

在 `noeviction` 下，記憶體滿了會發生什麼：

```bash
SET newkey "value"
# (error) OOM command not allowed when used memory > 'maxmemory'.
```

**注意：讀取命令仍然可用，只有可能增加記憶體的命令會失敗。**

這個行為在不同場景的意義完全不同：

```text
Redis 當「事實來源」（例如 MemoryDB 這類用法）：
  noeviction 是正確的。你絕對不想讓 Redis 自己刪掉你的資料。
  記憶體滿了應該報錯並告警，讓人來處理。

Redis 當「快取」（絕大多數情況）：
  noeviction 是災難。
  快取本來就該淘汰舊資料，結果它選擇拒絕新的寫入
  => 所有快取寫入都失敗
  => 快取命中率暴跌
  => 全部流量打到資料庫
  => 雪崩
```

**所以最重要的一條建議是：如果 Redis 是快取，一定要改掉 `noeviction`。**

### `volatile-*` 的隱藏陷阱

`volatile-lru` 看起來很合理：「只淘汰那些本來就會過期的 key，永久 key 不動。」

但它有一個嚴重的失效模式：

```text
如果你的 key 大部分都沒有設 TTL
=> volatile-lru 找不到可以淘汰的 key
=> 行為退化成 noeviction
=> 寫入開始報 OOM 錯誤
```

第 00 章的練習 2 就提過這件事。這是實務上很常見的誤設：設了 `volatile-lru` 以為安全了，結果程式碼裡大部分 `SET` 都沒帶 TTL，記憶體滿的時候一樣掛掉。

**檢查方式：**

```bash
INFO keyspace
# db0:keys=8234567,expires=125432,avg_ttl=0
#         ^^^^^^^^        ^^^^^^
#         總 key 數        有 TTL 的 key 數
```

上面這個例子：820 萬個 key 裡只有 12 萬個有 TTL（1.5%）。用 `volatile-lru` 幾乎等於沒有驅逐策略。

### 策略選擇建議

```text
Redis 是純快取，所有資料都可重建
  -> allkeys-lru（最常見的正確選擇）
  -> 或 allkeys-lfu（存取頻率差異大時更好，見下節）

Redis 混合用途：有些是快取（設 TTL），有些是重要狀態（不設 TTL，例如分散式鎖）
  -> volatile-lru
  -> 但必須確保「快取類 key 一定有 TTL」，並監控 expires 的比例

Redis 是事實來源，資料不可丟
  -> noeviction + 嚴格的記憶體監控告警
  -> 並且要有擴容預案

不知道該選什麼
  -> allkeys-lru。它在絕大多數情況下都是安全且合理的。
```

`allkeys-random` 和 `volatile-random` 幾乎沒有使用場景（除了「所有 key 的存取機率均等」這種罕見情況），`volatile-ttl` 適合「TTL 短的資料本來就比較不重要」的場景，但也不常見。

### 驅逐是怎麼發生的

理解時機很重要：

```text
每次執行命令之前，Redis 檢查 used_memory 是否超過 maxmemory
  超過 -> 按策略選出 key 並刪除，重複直到記憶體降到限制以下
       -> 然後才執行這個命令

所以驅逐是「在請求路徑上同步發生的」
```

推論：**如果被驅逐的是 big key，這次驅逐會阻塞這個請求。** 這就是第 04 章強調 `lazyfree-lazy-eviction yes` 的原因。

另外，驅逐會產生事件通知（如果開啟了 keyspace notification）與複製指令（發 `DEL` 給從節點），這些也有成本。**記憶體長期貼著 `maxmemory` 運行會讓 Redis 持續做驅逐工作，效能明顯下降。** 健康的水位應該有餘裕，驅逐應該是偶發的，不是常態。

監控驅逐量：

```bash
INFO stats | grep evicted
# evicted_keys:1523441        <- 累積驅逐了多少 key
```

**這個數字持續快速上升，代表你的記憶體不足，該擴容或減少資料量了。** 不要把它當成正常現象。

---

## 5.6 LRU 與 LFU：近似演算法與參數調校

### Redis 的 LRU 是近似的

標準 LRU 需要一個雙向鏈結串列來維護存取順序，每次存取都要把節點移到頭部。這需要為每個 key 額外存兩個指標，一千萬個 key 就是 160MB 的額外開銷——Redis 認為不值得。

**Redis 的做法是抽樣近似：**

```text
需要驅逐時：
  隨機抽 maxmemory-samples 個候選 key（預設 5）
  從中選出最久未使用的那個，刪掉
  （Redis 3.0+ 還維護一個候選池，讓結果更接近真實 LRU）
```

```bash
CONFIG GET maxmemory-samples
# "5"

CONFIG SET maxmemory-samples 10    # 更接近真實 LRU，但 CPU 開銷增加
```

抽樣數的取捨：

```text
5（預設）  -> 效果已經相當接近真實 LRU，CPU 開銷低
10        -> 明顯更準確，CPU 略增
超過 10   -> 邊際效益很低，不建議
```

每個 key 的物件頭裡有一個 24 位元的 `lru` 欄位記錄最後存取時間（秒級精度），這就是判斷依據。

### LFU：按頻率而非時間

LRU 有個弱點：**它會被「偶發的一次存取」騙到。**

```text
場景：一個冷門商品，昨天被爬蟲掃過一次
LRU 的判斷：它「最近」被存取過，所以保留
實際情況：它其實一整年只被存取一次，應該優先淘汰

反過來：
一個熱門商品，每秒被存取 100 次，但剛好在 10 秒前有個更新的存取
LRU 可能認為它比那個冷門商品「更久沒用」
```

LFU（Least Frequently Used）改用**存取頻率**判斷：

```bash
CONFIG SET maxmemory-policy allkeys-lfu
```

它用同樣的 24 位元欄位，但拆成兩部分：

```text
高 16 位：最後一次遞減的時間（分鐘級）
低 8 位：對數計數器（0-255）
```

### LFU 的兩個關鍵參數

```bash
CONFIG GET lfu-log-factor      # 10（預設）
CONFIG GET lfu-decay-time      # 1（預設，單位分鐘）
```

**`lfu-log-factor`：計數器的增長速度。**

計數器只有 8 位元（最大 255），不可能記錄真實的存取次數。所以它用**對數增長**：存取次數越多，計數器增加的機率越低。

```text
lfu-log-factor = 10 時，計數器達到某個值大約需要的存取次數：
  計數器 100  ≈ 存取 10 次
  計數器 200  ≈ 存取 100 次
  計數器 255  ≈ 存取 100 萬次以上

調小（例如 1）-> 計數器增長更快，能區分低頻存取的差異
調大（例如 100）-> 增長更慢，適合區分超高頻的熱點
```

**`lfu-decay-time`：計數器的衰減速度。**

如果只增不減，那麼「三個月前很熱門」的 key 會永遠保持高分。所以計數器會隨時間衰減：

```text
lfu-decay-time = 1 -> 每分鐘沒被存取，計數器減 1
lfu-decay-time = 10 -> 每 10 分鐘減 1（更看重長期熱度）
lfu-decay-time = 0 -> 特殊值，每次存取都衰減（幾乎不衰減歷史）
```

### 查看某個 key 的頻率

```bash
CONFIG SET maxmemory-policy allkeys-lfu
OBJECT FREQ mykey
# (integer) 5
```

**`OBJECT FREQ` 只在 LFU 策略下可用**，這也是第 04 章 `--hotkeys` 需要 LFU 的原因。

### 該用 LRU 還是 LFU

```text
用 LFU 的情況：
  存取頻率差異很大（有明顯的熱點與長尾）
  有掃描型流量（爬蟲、批次任務）會污染 LRU 的判斷
  需要用 --hotkeys 找熱點

用 LRU 的情況：
  存取模式較均勻
  資料有明顯的時間局部性（新的就是熱的，例如時間軸類資料）
  想要最簡單、最不需要調參的選擇
```

實務上 **LFU 通常表現更好**（這也是它在 4.0 被加入的原因），但差異在多數場景不大。如果你正在為快取命中率做優化，值得實測對比；否則 `allkeys-lru` 是完全合理的預設選擇。

---

## 5.7 記憶體碎片

### 什麼是碎片

```bash
INFO memory | grep frag
# mem_fragmentation_ratio:1.35
# allocator_frag_ratio:1.12
```

`mem_fragmentation_ratio = used_memory_rss / used_memory`，意思是「作業系統實際給的記憶體」除以「Redis 認為自己用的」。

判讀：

| 比率 | 意義 | 處理 |
|------|------|------|
| 1.0 - 1.5 | 正常 | 不用處理 |
| > 1.5 | 碎片偏高 | 考慮處理（見下） |
| < 1.0 | **有部分記憶體被 swap 出去了** | 緊急處理，這比碎片嚴重得多 |

**`< 1.0` 是最需要警覺的訊號**：它代表 `used_memory_rss` 小於 `used_memory`，也就是 Redis 認為在記憶體裡的資料，實際上有一部分在磁碟上。這對應第 04 章講的 swap 問題，延遲會惡化一萬倍。

### 碎片為什麼產生

jemalloc 按固定的大小分級配置記憶體（例如 8、16、32、48、64 bytes...）。你要 50 bytes，它給你 64 bytes——多出的 14 bytes 就是浪費。

更明顯的來源是「刪除大量資料後」：

```text
存了 10GB 資料 -> 刪掉 5GB
=> used_memory 降到 5GB
=> 但 used_memory_rss 可能還是 9GB
   因為 jemalloc 把釋放的記憶體留在自己的池子裡沒還給作業系統
=> 碎片率 = 9 / 5 = 1.8
```

這種「碎片」某種程度上是假的——那些記憶體 Redis 之後可以重用。但它確實佔著實體記憶體，會影響同機器上其他行程，也可能導致 swap。

### 處理方式

**方式 1：`activedefrag`（主動碎片整理）**

```bash
CONFIG SET activedefrag yes
```

Redis 會在背景逐步把資料搬到新的記憶體位置，讓碎片得以歸還。相關參數：

```bash
CONFIG GET active-defrag-ignore-bytes      # 100mb，碎片小於這個值就不整理
CONFIG GET active-defrag-threshold-lower   # 10，碎片率超過 10% 開始整理
CONFIG GET active-defrag-threshold-upper   # 100，碎片率 100% 時用最大力度
CONFIG GET active-defrag-cycle-min         # 整理時最少用多少 CPU 比例
CONFIG GET active-defrag-cycle-max         # 最多用多少 CPU 比例
```

**注意事項：**

- **需要 jemalloc 配置器**（Linux 上的官方編譯版預設就是）。用 libc 配置器的話這個功能無效。
- **它會消耗 CPU**，而且是在主執行緒上做（分小片段執行）。碎片整理期間延遲可能小幅上升。
- 建議先設 `activedefrag yes` 觀察一段時間，如果延遲有影響就調低 `active-defrag-cycle-max`。

**方式 2：重啟（最徹底）**

重啟後從 RDB / AOF 載入資料，記憶體是全新配置的，碎片歸零。

在有主從架構的情況下這是安全的操作：先重啟從節點，然後故障轉移，再重啟原主節點。第 11 章會講流程。

**方式 3：接受它**

如果碎片率是 1.3、記憶體還有餘裕、延遲正常，**什麼都不做是完全合理的選擇。** 不要為了讓一個數字好看而引入 CPU 開銷和操作風險。

---

## 5.8 客戶端緩衝區：容易忽略的記憶體黑洞

### 輸出緩衝區可以無限大

```bash
CONFIG GET client-output-buffer-limit
# 1) "client-output-buffer-limit"
# 2) "normal 0 0 0 slave 268435456 67108864 60 pubsub 33554432 8388608 60"
```

格式是 `<類型> <硬限制> <軟限制> <軟限制秒數>`：

| 類型 | 預設 | 意義 |
|------|------|------|
| `normal` | `0 0 0` | **普通客戶端無限制** |
| `slave` | `256mb 64mb 60` | 從節點：超過 256MB 立刻斷、超過 64MB 持續 60 秒斷 |
| `pubsub` | `32mb 8mb 60` | 訂閱者 |

**`normal 0 0 0` 意味著普通客戶端的輸出緩衝區沒有上限。** 危險場景：

```text
有人執行 KEYS * 或 LRANGE bigkey 0 -1
=> 回應有 500MB
=> 這 500MB 全部進入輸出緩衝區
=> 如果客戶端讀取很慢（或網路慢），這塊記憶體會一直佔著
=> 多個客戶端同時這樣做，記憶體直接被吃光
```

這是「`KEYS *` 會造成事故」的另一個面向——不只是阻塞，還會吃記憶體。

### `maxmemory-clients`（7.0+）

Redis 7.0 引入了客戶端記憶體的獨立限制：

```bash
CONFIG SET maxmemory-clients 1gb        # 所有客戶端緩衝區總和上限
CONFIG SET maxmemory-clients 10%        # 或用 maxmemory 的百分比
```

超過時 Redis 會斷開佔用最多的客戶端（client eviction），保護實例不被拖垮。

如果你在 7.0+，**建議設定這個值**（例如 `5%` 或 `10%`）。它是一道很有效的保護欄。

7.0 之前的緩解方式是為 `normal` 設一個硬限制：

```bash
CONFIG SET client-output-buffer-limit "normal 256mb 128mb 60 slave 268435456 67108864 60 pubsub 33554432 8388608 60"
```

代價是「合法的大回應」也會被截斷（客戶端會被斷線）。所以這個值要設得比你正常業務的最大回應大一些。

### 監控

```bash
INFO clients
# connected_clients:842
# cluster_connections:0
# maxclients:10000
# client_recent_max_input_buffer:20480
# client_recent_max_output_buffer:0
# blocked_clients:3

CLIENT LIST
# id=5 addr=10.0.1.5:52418 ... qbuf=26 qbuf-free=20448 obl=0 oll=0 omem=0 ...
```

`CLIENT LIST` 的 `omem` 欄位是該客戶端的輸出緩衝區記憶體。找出異常的客戶端：

```bash
redis-cli -a pass CLIENT LIST | awk '{for(i=1;i<=NF;i++) if($i ~ /^omem=/) print $i, $0}' | sort -t= -k2 -rn | head
```

必要時可以強制斷開：

```bash
CLIENT KILL ID 5
```

---

## 5.9 容量規劃

把前面的知識組合成一個可執行的估算方法。

### 步驟 1：估算純資料量

```text
對每一類 key：
  單個 key 的記憶體 × 預期數量

用 MEMORY USAGE 實測樣本，不要憑感覺估
```

```bash
# 建立一個真實樣本
HSET user:profile:sample name "Alice" level 3 city "Taipei" points 1200
MEMORY USAGE user:profile:sample
# (integer) 200

# 一千萬使用者 => 200 × 10,000,000 = 2GB
```

**一定要實測。** 憑感覺算出的數字通常會少估一倍以上，因為大家都會忘記 key 本身、物件頭、dict entry 的開銷。

### 步驟 2：加上各項開銷

```text
資料量                          2.0 GB
+ 過期字典（假設 50% 有 TTL）    約 +5%
+ 客戶端緩衝區（1000 連線）      約 +100MB
+ 複製積壓緩衝區                 repl-backlog-size（預設 1MB，高寫入建議調大到 64-256MB）
+ AOF 緩衝區                     取決於寫入量
+ 碎片（假設 1.3）               × 1.3
─────────────────────────────────────
估算 used_memory_rss ≈ 3.2 GB
```

### 步驟 3：設定 maxmemory 與機器規格

```text
maxmemory = 估算值 × 成長餘裕（例如 1.5 倍）= 4.8 GB，取 5GB
實體記憶體 = maxmemory / 0.65 ≈ 7.7 GB，選 8GB 的機器

檢查：單實例 5GB 的 fork 時間約 50-100ms
      如果 SLA 不能接受，就分成兩個 2.5GB 的實例
```

### 步驟 4：設定監控告警

| 指標 | 告警閾值 | 意義 |
|------|---------|------|
| `used_memory / maxmemory` | > 80% | 接近上限，準備擴容 |
| `evicted_keys` 增長率 | > 0 且持續 | 已經在驅逐，記憶體不足 |
| `mem_fragmentation_ratio` | > 1.5 或 < 1.0 | 碎片高 / 有 swap |
| `VmSwap` | > 0 | 有 swap，緊急 |
| `latest_fork_usec` | > 100000 | fork 太慢，實例可能太大 |
| `connected_clients` | 異常上升 | 可能連線洩漏 |
| `blocked_clients` | 持續大於 0 | 有客戶端在阻塞等待 |

**最重要的兩個是 `evicted_keys` 和 swap。** 前者說明容量不足，後者說明已經在出事了。

---

## 5.10 常見錯誤

### 錯誤 1：不設 `maxmemory`

會被 OOM killer 殺掉。一定要設。

### 錯誤 2：`maxmemory` 設得等於實體記憶體

沒有留給 fork 的 COW、緩衝區與碎片。建議 60-70%。

### 錯誤 3：快取場景用預設的 `noeviction`

記憶體滿時所有寫入失敗，快取命中率崩潰，引發雪崩。改成 `allkeys-lru`。

### 錯誤 4：用 `volatile-*` 但大部分 key 沒有 TTL

會退化成 `noeviction`。用 `INFO keyspace` 檢查 `expires` 佔 `keys` 的比例。

### 錯誤 5：以為刪了資料記憶體就會馬上還給作業系統

jemalloc 會保留在自己的池子裡，`used_memory_rss` 不會立刻下降。看 `used_memory` 判斷邏輯用量，看 `rss` 判斷實體佔用。

### 錯誤 6：把 `hash-max-listpack-entries` 調到幾千

listpack 的查找是 O(N)，調太大會讓單次操作明顯變慢。控制資料設計比調參數好。

### 錯誤 7：忘記編碼轉換不可逆

一個 Hash 曾經超過 128 個欄位，就永久是 hashtable。要控制的是「不要讓它超過」，不是「超過後刪回來」。

### 錯誤 8：看到碎片率 1.3 就急著開 `activedefrag`

1.0-1.5 是正常範圍。不要為了數字好看引入 CPU 開銷。

### 錯誤 9：忽略客戶端緩衝區

`normal 0 0 0` 是沒有上限的。7.0+ 請設定 `maxmemory-clients`。

### 錯誤 10：把 `evicted_keys` 持續上升當成正常

那代表容量不足，Redis 在被迫丟資料，快取命中率一定在惡化。

---

## 5.11 本章練習

### 練習 1：驗證編碼切換與記憶體懸崖

設計實驗，測量 Hash 從 listpack 轉成 hashtable 時的記憶體變化，並驗證轉換不可逆。

<details>
<summary>參考解答</summary>

```bash
docker compose exec redis sh
```

```sh
redis-cli -a mysecret FLUSHDB
redis-cli -a mysecret CONFIG GET hash-max-listpack-entries
# 1) "hash-max-listpack-entries"
# 2) "128"
```

**測量記憶體隨欄位數的變化：**

```sh
for n in 64 128 129 200 500; do
  redis-cli -a mysecret DEL h:$n > /dev/null
  redis-cli -a mysecret EVAL "
    for i=1,tonumber(ARGV[1]) do
      redis.call('HSET', KEYS[1], 'field'..i, 'value'..i)
    end
    return 1" 1 h:$n $n > /dev/null

  enc=$(redis-cli -a mysecret OBJECT ENCODING h:$n)
  mem=$(redis-cli -a mysecret MEMORY USAGE h:$n)
  echo "欄位數 $n: 編碼 $enc, 記憶體 $mem bytes"
done
```

預期輸出的形狀：

```text
欄位數 64:  編碼 listpack,  記憶體 ~1000 bytes     -> 每欄位約 16 bytes
欄位數 128: 編碼 listpack,  記憶體 ~1900 bytes     -> 每欄位約 15 bytes
欄位數 129: 編碼 hashtable, 記憶體 ~10000 bytes    -> 每欄位約 78 bytes
欄位數 200: 編碼 hashtable, 記憶體 ~15000 bytes
欄位數 500: 編碼 hashtable, 記憶體 ~37000 bytes
```

**關鍵觀察：128 到 129 之間記憶體跳了五倍。** 每欄位的成本從 15 bytes 變成 78 bytes。這個懸崖就是編碼切換。

**驗證另一個觸發條件（value 長度）：**

```sh
redis-cli -a mysecret DEL h:longval
redis-cli -a mysecret HSET h:longval f1 "$(head -c 60 /dev/zero | tr '\0' 'x')"
redis-cli -a mysecret OBJECT ENCODING h:longval
# "listpack"     <- 60 bytes，還在 64 的閾值內

redis-cli -a mysecret HSET h:longval f2 "$(head -c 70 /dev/zero | tr '\0' 'x')"
redis-cli -a mysecret OBJECT ENCODING h:longval
# "hashtable"    <- 一個 70 bytes 的值就讓整個 Hash 升級了
```

**注意：只要有任何一個 value 超過 `hash-max-listpack-value`，整個 Hash 就會轉換。** 不是那個欄位單獨處理。這在實務上很容易觸發——例如你的 Hash 大部分欄位都很短，但有一個欄位存了一段描述文字。

**驗證不可逆：**

```sh
redis-cli -a mysecret DEL h:revert
redis-cli -a mysecret EVAL "
  for i=1,200 do redis.call('HSET', KEYS[1], 'f'..i, 'v'..i) end
  return 1" 1 h:revert
redis-cli -a mysecret OBJECT ENCODING h:revert
# "hashtable"
redis-cli -a mysecret MEMORY USAGE h:revert

# 刪到只剩 10 個欄位
redis-cli -a mysecret EVAL "
  for i=11,200 do redis.call('HDEL', KEYS[1], 'f'..i) end
  return redis.call('HLEN', KEYS[1])" 1 h:revert
# (integer) 10

redis-cli -a mysecret OBJECT ENCODING h:revert
# "hashtable"     <- 沒有轉回 listpack
redis-cli -a mysecret MEMORY USAGE h:revert
# 比同樣 10 個欄位的新 Hash 大很多
```

**對比新建的：**

```sh
redis-cli -a mysecret DEL h:fresh
redis-cli -a mysecret EVAL "
  for i=1,10 do redis.call('HSET', KEYS[1], 'f'..i, 'v'..i) end
  return 1" 1 h:fresh
redis-cli -a mysecret OBJECT ENCODING h:fresh
# "listpack"
redis-cli -a mysecret MEMORY USAGE h:fresh
# 明顯小於 h:revert
```

**實務結論：** 如果你發現某批 Hash 的記憶體異常高，檢查它們的編碼。可能是曾經有一次批次操作寫超了，或有一個長 value 觸發了轉換。修復方式只能是「讀出來、`DEL`、重新寫入」。

</details>

### 練習 2：實測分片 Hash 的記憶體優化

用實驗驗證「一百萬個 String」和「分片 Hash」的記憶體差距。

<details>
<summary>參考解答</summary>

```sh
redis-cli -a mysecret FLUSHDB
redis-cli -a mysecret INFO memory | grep used_memory:
# 基準值，記下來（例如 900000）
```

**方案 A：一百萬個獨立 String**

```sh
redis-cli -a mysecret EVAL "
for i=1,1000000 do
  redis.call('SET', 'user:name:'..i, 'user_nickname_'..i)
end
return redis.call('DBSIZE')" 0
# (integer) 1000000

redis-cli -a mysecret INFO memory | grep -E "used_memory_human|used_memory:"
```

記下數字，然後清空：

```sh
redis-cli -a mysecret FLUSHDB ASYNC
sleep 3
```

**方案 B：分片 Hash（每片 100 個欄位）**

```sh
redis-cli -a mysecret EVAL "
for i=1,1000000 do
  local shard = math.floor(i / 100)
  redis.call('HSET', 'user:name:shard:'..shard, i, 'user_nickname_'..i)
end
return redis.call('DBSIZE')" 0
# (integer) 10001        <- key 數量從 100 萬降到 1 萬

redis-cli -a mysecret INFO memory | grep -E "used_memory_human|used_memory:"

# 確認編碼是 listpack
redis-cli -a mysecret OBJECT ENCODING user:name:shard:500
# "listpack"
redis-cli -a mysecret HLEN user:name:shard:500
# (integer) 100
```

**預期結果的量級：**

```text
方案 A（100 萬個 String）：  約 80-100 MB
方案 B（1 萬個分片 Hash）：  約 25-35 MB

省下約 3 倍
```

具體數字會因版本與平台而異，但比例應該接近。

**驗證讀寫效能沒有變差：**

```sh
# 讀取單個使用者：方案 B 仍然是一次命令
redis-cli -a mysecret HGET user:name:shard:500 50000
# "user_nickname_50000"

# 對比 benchmark
redis-benchmark -a mysecret -n 100000 -t get -q                      # 方案 A 的讀取
redis-benchmark -a mysecret -n 100000 -q \
  -- HGET user:name:shard:500 50000                                   # 方案 B 的讀取
```

兩者的 QPS 應該在同一個量級。listpack 雖然是 O(N) 查找，但 N 只有 100 且記憶體連續，實際上很快。

**試試分片過大會怎樣：**

```sh
redis-cli -a mysecret FLUSHDB ASYNC
sleep 3

# 每片 1000 個欄位（超過 listpack 閾值 128）
redis-cli -a mysecret EVAL "
for i=1,1000000 do
  local shard = math.floor(i / 1000)
  redis.call('HSET', 'user:name:shard:'..shard, i, 'user_nickname_'..i)
end
return redis.call('DBSIZE')" 0

redis-cli -a mysecret OBJECT ENCODING user:name:shard:500
# "hashtable"      <- 超過閾值，優化失效
redis-cli -a mysecret INFO memory | grep used_memory_human
```

**你會發現記憶體反而回升了。** 這證明分片 Hash 的收益**完全依賴於「每片保持在 listpack 閾值內」**——分片數選錯，優化就沒了。

**這題的三個結論：**

1. 分片 Hash 的記憶體優勢來自兩件事：省下大量 key 的固定開銷 + listpack 的緊湊儲存。
2. 每片的欄位數必須控制在 `hash-max-listpack-entries`（預設 128）以內，否則失效。
3. 單點讀寫效能不受影響，這是它相對其他優化手段的最大優點。

**清理：**

```sh
redis-cli -a mysecret FLUSHDB ASYNC
```

</details>

### 練習 3：驅逐策略的選擇與驗證

一個電商系統的 Redis 存了三類資料：

- 商品快取（有 TTL 300 秒），約佔 70% 記憶體。
- 分散式鎖（有 TTL 30 秒），數量少但絕對不能被誤刪。
- 全站設定與對照表（**沒有 TTL**），約佔 5% 記憶體，被誤刪會導致功能異常但可以從資料庫重建。

該用哪個驅逐策略？並設計實驗驗證你的選擇不會誤刪重要資料。

<details>
<summary>參考解答</summary>

**分析每個選項**

**`noeviction`：不行。** 70% 是快取，記憶體滿時所有快取寫入失敗，命中率崩潰導致雪崩。

**`allkeys-lru`：可行但有風險。** 它會淘汰包含分散式鎖和全站設定在內的所有 key。

- 誤刪分散式鎖的後果**很嚴重**：鎖被刪掉等於鎖失效，兩個行程可能同時進入臨界區，造成重複扣款或超賣。
- 但實際上鎖被誤刪的機率極低——鎖的 key 數量很少，而且正在被持有的鎖必然是「剛剛才存取過」，LRU 幾乎不會選中它。
- 全站設定被誤刪只是要重建，可以接受。

**`volatile-lru`：看起來最合適，但要驗證前提。**

- 只淘汰有 TTL 的 key，全站設定（沒 TTL）絕對安全。
- 但分散式鎖有 TTL，仍然在候選範圍內。
- **關鍵前提：有 TTL 的 key 必須佔絕大多數。** 這題裡快取（70%）+ 鎖都有 TTL，沒 TTL 的只有 5%，所以前提滿足，不會退化成 `noeviction`。

**`volatile-ttl`：這題其實是個不錯的選擇。** 它優先淘汰剩餘 TTL 最短的 key。但要小心：分散式鎖的 TTL 只有 30 秒，比商品快取的 300 秒短得多——**`volatile-ttl` 會優先淘汰鎖，這正好是最糟的結果。** 所以不能用。

**結論：選 `volatile-lru`，並且必須額外保護分散式鎖。**

```bash
CONFIG SET maxmemory 4gb
CONFIG SET maxmemory-policy volatile-lru
CONFIG SET lazyfree-lazy-eviction yes
```

**保護分散式鎖的三種做法**

**做法一（推薦）：把鎖放在獨立的 Redis 實例。**

```text
實例 A：商品快取，allkeys-lru，記憶體吃緊也沒關係
實例 B：分散式鎖 + 全站設定，noeviction，記憶體需求很小
```

這是最乾淨的方案。鎖的資料量極小，用一個小實例完全足夠，而且順便得到了故障隔離——快取實例出問題不會影響鎖。

**做法二：接受鎖可能被驅逐，但在應用層做防護。**

用 Lua 腳本做「檢查持有者再操作」，並且業務邏輯本身要冪等（第 07、10 章）。這樣即使鎖失效，重複執行也不會造成錯誤。**這其實是必要的設計，不論用哪個策略——因為鎖還有其他失效途徑（主從切換丟失、持有者 GC 停頓）。**

**做法三：確保記憶體不會滿。** 監控 `evicted_keys`，一旦開始驅逐就立刻擴容。驅逐應該是異常狀況，不是常態。

**驗證實驗**

```sh
# 用一個小的 maxmemory 方便觸發
redis-cli -a mysecret FLUSHDB
redis-cli -a mysecret CONFIG SET maxmemory 20mb
redis-cli -a mysecret CONFIG SET maxmemory-policy volatile-lru

# 寫入沒有 TTL 的「全站設定」
redis-cli -a mysecret EVAL "
for i=1,100 do
  redis.call('SET', 'config:global:'..i, string.rep('c', 1000))
end
return 1" 0

# 寫入一個「分散式鎖」
redis-cli -a mysecret SET lock:critical "worker-1" EX 30

# 大量寫入有 TTL 的快取，撐爆記憶體
redis-cli -a mysecret EVAL "
for i=1,50000 do
  redis.call('SET', 'cache:product:'..i, string.rep('x', 1000), 'EX', 300)
end
return 1" 0

# 檢查結果
redis-cli -a mysecret INFO stats | grep evicted_keys
# evicted_keys:12345         <- 確實有驅逐發生

redis-cli -a mysecret EVAL "
local n = 0
for i=1,100 do
  if redis.call('EXISTS', 'config:global:'..i) == 1 then n = n + 1 end
end
return n" 0
# (integer) 100              <- 全站設定 100 個全部存活，volatile-lru 生效

redis-cli -a mysecret EXISTS lock:critical
# (integer) 1 或 0           <- 鎖可能存活也可能被驅逐
```

**重複跑幾次，你會發現鎖有時會被驅逐。** 這正好驗證了「必須額外保護鎖」的結論。

**再驗證 `volatile-lru` 的失效模式：**

```sh
redis-cli -a mysecret FLUSHDB
redis-cli -a mysecret CONFIG SET maxmemory-policy volatile-lru

# 這次寫入的資料全部沒有 TTL
redis-cli -a mysecret EVAL "
for i=1,50000 do
  redis.call('SET', 'nottl:'..i, string.rep('x', 1000))
end
return 1" 0
# 應該會在中途報錯：OOM command not allowed...
```

**因為沒有任何帶 TTL 的 key 可以淘汰，`volatile-lru` 退化成了 `noeviction`。** 這就是前面強調「必須確認 `expires` 比例」的原因：

```sh
redis-cli -a mysecret INFO keyspace
# db0:keys=18000,expires=0,avg_ttl=0
#                ^^^^^^^^^ 這個 0 就是警訊
```

**恢復設定：**

```sh
redis-cli -a mysecret FLUSHDB
redis-cli -a mysecret CONFIG SET maxmemory 256mb
redis-cli -a mysecret CONFIG SET maxmemory-policy allkeys-lru
```

</details>

---

## 5.12 驗收清單

進入下一章前，確認你可以：

- [ ] 說出 `used_memory`、`used_memory_rss`、`used_memory_peak` 的差別與各自的用途。
- [ ] 說明記憶體除了資料還包含哪些開銷。
- [ ] 用 `OBJECT ENCODING` 檢查編碼，並說出五種型別的切換閾值。
- [ ] 解釋 listpack 為什麼比 hashtable 省記憶體，以及它的代價。
- [ ] 說明編碼轉換不可逆，以及這對設計的影響。
- [ ] 用分片 Hash 優化大量小 key，並說明分片數該怎麼選。
- [ ] 列出八種驅逐策略，並說明為什麼快取場景不能用 `noeviction`。
- [ ] 說明 `volatile-*` 策略的失效模式，以及怎麼用 `INFO keyspace` 檢查。
- [ ] 解釋 Redis 的 LRU 為什麼是近似的，以及 `maxmemory-samples` 的作用。
- [ ] 說明 LFU 的對數計數與衰減機制，以及它相對 LRU 的優勢。
- [ ] 判讀 `mem_fragmentation_ratio`，特別是小於 1 代表什麼。
- [ ] 說明客戶端輸出緩衝區的風險，以及 `maxmemory-clients` 的作用。
- [ ] 為一個業務做完整的記憶體容量規劃與監控告警設計。

---

下一章處理「重啟之後資料還在嗎」這個問題：[06-persistence-rdb-aof.md](./06-persistence-rdb-aof.md)，我們會拆開 RDB 與 AOF，算清楚每種設定的資料遺失窗口，並實際演練一次恢復。
