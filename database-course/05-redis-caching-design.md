# 第 05 章：Redis 與快取設計

> 資料庫效能撐不住時，第一個被拿出來的工具通常是快取。
> 但快取用錯，會製造比「慢」更可怕的問題：資料不一致、快取被打穿、整個系統雪崩。
> 這章會把 Redis 的核心資料結構、快取模式、以及三大經典災難（穿透、擊穿、雪崩）講清楚，並附完整解法與練習解答。

---

## 5.1 學習目標

完成本章後，你應該可以：

- 說明快取為什麼能提升效能，以及它的代價。
- 使用 Redis 常見資料結構：String、Hash、List、Set、Sorted Set。
- 實作 Cache Aside 模式，並知道更新資料時該刪快取還是改快取。
- 辨識並解決快取穿透、擊穿、雪崩。
- 用 Redis 實作排行榜、計數器與分散式鎖。
- 知道快取一致性的取捨，選擇適合的失效策略。

---

## 5.2 快取的本質：用空間換時間

資料庫查詢慢，通常是因為：

- 資料量大，要掃描或走索引。
- 查詢複雜，牽涉 JOIN、聚合。
- 同一份熱門資料被大量重複查詢。

快取解決的是最後一項：**同一份資料被重複查很多次**。

心智模型：

```text
沒有快取：每個請求都問資料庫
有快取：  熱門資料放在記憶體，多數請求不必碰資料庫
```

Redis 之所以快，是因為：

- 資料放在記憶體，不是磁碟。
- 資料結構簡單，操作時間複雜度低。
- 單執行緒模型處理命令，避免大量鎖競爭。

但快取的代價是：

- 你現在有「兩份資料」（資料庫一份、快取一份），要處理它們的一致性。
- 快取可能過期、可能被驅逐、可能在重啟後消失。

**所以快取的正確心智是：快取是可重建的加速層，不是事實來源。**

---

## 5.3 取得與啟動 Redis

用 Docker 最快：

```bash
docker run --name course-redis -p 6379:6379 -d redis:7
```

進入 CLI：

```bash
docker exec -it course-redis redis-cli
```

測試：

```bash
SET hello world
GET hello
```

回傳 `"world"` 就代表可用。

---

## 5.4 Redis 核心資料結構

Redis 不是只有 key-value 字串。選對資料結構，程式會簡潔很多。

### String：最基本的鍵值

```bash
SET product:1001 "{\"id\":1001,\"name\":\"機械鍵盤\",\"price\":2990}"
GET product:1001
```

搭配 TTL：

```bash
SET product:1001 "..." EX 300
```

`EX 300` 代表 300 秒後自動過期。

也能當計數器：

```bash
INCR page:view:home
INCRBY page:view:home 5
```

`INCR` 是原子操作，高併發下也不會算錯。

### Hash：一個 key 存多個欄位

適合存物件，且只想更新部分欄位。

```bash
HSET user:1001 name "Alice" level "vip" points 1200
HGET user:1001 level
HINCRBY user:1001 points 50
```

比起把整個 JSON 字串取出、改完再寫回，Hash 可以只改 `points`，避免覆蓋競爭。

### List：有序、可當佇列

```bash
RPUSH queue:email "job1"
RPUSH queue:email "job2"
LPOP queue:email
```

可做簡單的任務佇列，但正式的消息隊列建議用專門的 MQ（第 04 章提過）。

### Set：不重複集合

```bash
SADD post:1:liked_users 1001
SADD post:1:liked_users 1002
SADD post:1:liked_users 1001
SCARD post:1:liked_users
```

`SADD` 重複加入同一個值不會變多，`SCARD` 回傳 2。適合「按讚使用者」「已讀集合」。

### Sorted Set：帶分數的排序集合

排行榜的最佳工具。

```bash
ZADD game:ranking 9800 user:1001
ZADD game:ranking 8750 user:1002
ZADD game:ranking 10200 user:1003
ZREVRANGE game:ranking 0 2 WITHSCORES
ZREVRANK game:ranking user:1001
```

- `ZADD`：加入或更新分數。
- `ZREVRANGE 0 2`：取分數最高的前 3 名。
- `ZREVRANK`：查某使用者排名。

這些操作是 log 級複雜度，非常適合高頻更新的排行榜。

---

## 5.5 Cache Aside：最常用的快取模式

Cache Aside（旁路快取）是最常見、最實用的模式。

### 讀取流程

```text
1. 先查快取
2. 命中（cache hit）：直接回傳
3. 未命中（cache miss）：查資料庫
4. 把資料寫回快取並設定 TTL
5. 回傳
```

虛擬碼：

```text
function getProduct(id):
    cacheKey = "product:" + id
    data = redis.get(cacheKey)
    if data is not null:
        return deserialize(data)

    product = db.query("SELECT ... FROM products WHERE id = ?", id)
    if product is not null:
        redis.set(cacheKey, serialize(product), EX=300)
    return product
```

### 更新流程：更新資料庫，然後刪快取

```text
function updateProduct(id, newData):
    db.update("UPDATE products SET ... WHERE id = ?", id)
    redis.delete("product:" + id)
```

這裡有個關鍵決策：**更新資料時，該「刪快取」還是「更新快取」？**

多數情況建議「刪快取」，原因：

- 刪除是冪等的，重試安全。
- 下次讀取自然會用最新資料重建快取。
- 避免「算好新值寫進快取，但那個值其實是舊交易算的」這種併發錯誤。

這個策略也叫 **Cache Aside + 失效（invalidate）**。

---

## 5.6 為什麼不建議「先刪快取再更新資料庫」

更新順序很重要。考慮兩種順序在併發下的差異。

### 順序 A：先更新 DB，再刪快取（建議）

```text
執行緒 1：UPDATE db (price = 200)
執行緒 1：DELETE cache
之後的讀取：cache miss -> 讀到 db 的 200 -> 回填快取
```

大多數情況正確。

### 順序 B：先刪快取，再更新 DB（不建議）

```text
執行緒 1：DELETE cache
執行緒 2：讀取 cache miss -> 讀 db 得到舊值 100 -> 回填快取 100
執行緒 1：UPDATE db (price = 200)
結果：db 是 200，但快取是 100，長期不一致
```

所以推薦順序是「**先改資料庫，再刪快取**」。

### 更嚴謹：延遲雙刪

即使先改 DB 再刪快取，仍有極小機率出現「舊讀取晚一步回填」。要求更嚴格時可用延遲雙刪：

```text
1. 更新資料庫
2. 刪快取
3. 等待一小段時間（例如 500ms）
4. 再刪一次快取
```

第二次刪除是為了清掉步驟 1~2 之間可能被回填的舊值。這增加複雜度，只在一致性要求高的場景使用。

---

## 5.7 快取穿透（Cache Penetration）

### 問題

「穿透」指的是：**查詢一個「資料庫裡也不存在」的資料**，導致每次都 cache miss、每次都打資料庫。

例子：攻擊者不斷請求 `product:-999`、`product:999999999`：

```text
查快取 -> miss（因為不存在）
查資料庫 -> 也沒有
不回填快取（因為沒東西可填）
下一次同樣的請求，又重來一遍
```

資料庫被大量「查無此物」的請求打爆。

### 解法 1：快取空值

即使查不到，也把「空」寫進快取，並給短 TTL。

```text
product = db.query(...)
if product is null:
    redis.set("product:999", "NULL_PLACEHOLDER", EX=60)
    return null
```

下次同樣請求會命中「空值快取」，不再打 DB。TTL 設短一點，避免資料之後真的建立了卻被空值擋住太久。

### 解法 2：布隆過濾器（Bloom Filter）

在快取前面放一個布隆過濾器，記錄「所有存在的 ID」。

```text
if not bloomFilter.mightContain(id):
    return null    # 一定不存在，直接擋掉，不查 DB 也不查快取
```

特性：

- 布隆過濾器說「不存在」時，一定不存在。
- 說「可能存在」時，才往下查。
- 有極小誤判率，但能擋掉絕大多數不存在的查詢。

適合 ID 集合龐大、又要擋惡意查詢的場景。

---

## 5.8 快取擊穿（Cache Breakdown / Hotspot Invalid）

### 問題

「擊穿」指的是：**某個熱門 key 剛好過期的瞬間**，大量請求同時 cache miss，全部湧向資料庫重建同一份資料。

例子：首頁熱門商品 `product:1001`，QPS 五萬。它的快取 TTL 到期那一刻：

```text
五萬個請求同時發現 cache miss
五萬個請求同時查資料庫
資料庫瞬間被同一個查詢打爆
```

和穿透的差別：擊穿的資料是「真實存在且熱門」的，只是剛好過期。

### 解法 1：互斥鎖（只讓一個請求去重建）

用 Redis 分散式鎖，保證同一時間只有一個請求查 DB、回填快取，其他請求稍等後重讀快取。

```text
function getHotProduct(id):
    data = redis.get(key)
    if data is not null:
        return data

    lockKey = "lock:" + key
    if redis.set(lockKey, "1", NX, EX=10):   # 搶到鎖
        try:
            product = db.query(...)
            redis.set(key, product, EX=300)
            return product
        finally:
            redis.delete(lockKey)
    else:
        sleep(50ms)          # 沒搶到鎖，稍等再重讀
        return getHotProduct(id)
```

只有搶到鎖的那個請求會打 DB，其餘等它回填後直接讀快取。

### 解法 2：熱點資料邏輯過期（不設實際 TTL）

熱點 key 不設 Redis TTL（永不自動過期），改在 value 裡存一個「邏輯過期時間」。讀到邏輯過期時，用背景執行緒去刷新，其他請求先拿舊值。

```json
{
  "value": { "id": 1001, "name": "機械鍵盤" },
  "logical_expire_at": 1751530000
}
```

```text
讀到資料，發現 logical_expire_at 已過：
  - 嘗試搶鎖
  - 搶到：開背景任務刷新快取
  - 沒搶到或還在刷新：先回傳舊值
```

好處是使用者永遠不會等「重建」，代價是短時間可能拿到稍舊的資料。

---

## 5.9 快取雪崩（Cache Avalanche）

### 問題

「雪崩」指的是：**大量 key 在同一時間一起過期**，或 **Redis 整個掛掉**，導致所有流量瞬間打到資料庫。

常見成因：

- 系統啟動時，一次性把大批資料寫進快取，還設了相同 TTL，於是它們同時到期。
- Redis 節點故障。

### 解法 1：TTL 加隨機抖動

不要讓所有 key 同時過期。

```text
ttl = baseTtl + random(0, 300)   # 例如 300 + 隨機 0~300 秒
redis.set(key, value, EX=ttl)
```

讓過期時間分散開，避免同一秒集體失效。

### 解法 2：Redis 高可用

- 使用主從 + Sentinel 或 Cluster，避免單點故障。
- 一個節點掛了還有其他節點頂住。

### 解法 3：多級快取與降級

- 應用內本地快取（如程序內的 LRU）當第二層，Redis 掛了還能擋一部分。
- 資料庫前加限流與熔斷，Redis 不可用時限制打向 DB 的流量，保護 DB 不被壓垮。

### 三大災難對照表

| 問題 | 成因 | 資料是否存在 | 核心解法 |
|------|------|------------|----------|
| 穿透 | 查不存在的資料，每次都 miss | 不存在 | 快取空值、布隆過濾器 |
| 擊穿 | 單一熱點 key 過期瞬間 | 存在且熱門 | 互斥鎖重建、邏輯過期 |
| 雪崩 | 大量 key 同時過期或 Redis 掛 | 存在 | TTL 抖動、高可用、降級限流 |

---

## 5.10 用 Redis 實作排行榜

需求：遊戲即時排行榜，要能更新分數、查前 100 名、查某玩家名次。

更新分數：

```bash
ZADD game:ranking 9800 user:1001
ZINCRBY game:ranking 200 user:1001
```

查前 100 名：

```bash
ZREVRANGE game:ranking 0 99 WITHSCORES
```

查某玩家名次（從 0 開始，所以要 +1）：

```bash
ZREVRANK game:ranking user:1001
```

查某玩家分數：

```bash
ZSCORE game:ranking user:1001
```

為什麼不用 SQL `ORDER BY score DESC LIMIT 100`？

- 分數高頻更新時，SQL 排序成本高。
- Sorted Set 的插入與排名查詢都是 log 級，天生適合。
- 長期紀錄仍可存在 MySQL/PostgreSQL，Redis 只負責即時榜。

---

## 5.11 用 Redis 實作分散式鎖

多台伺服器要搶同一個資源（例如避免同一個定時任務被跑兩次）時，需要跨行程的鎖。

### 基本加鎖

```bash
SET lock:report_job "worker-1" NX EX 30
```

- `NX`：只有 key 不存在時才設定成功（代表搶到鎖）。
- `EX 30`：30 秒自動過期，避免持鎖者掛掉造成死鎖。

### 解鎖要驗證持有者

不能直接 `DEL lock:report_job`，因為可能刪到別人的鎖（你的鎖已過期，別人搶到了新鎖）。

要用 Lua 保證「檢查是不是我的鎖 + 刪除」的原子性：

```lua
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
else
    return 0
end
```

`ARGV[1]` 是加鎖時寫入的唯一值（例如 `worker-1` 或隨機 UUID）。

### 分散式鎖的限制

- 業務執行時間可能超過鎖 TTL，需要「續租」機制（watchdog）。
- 極端一致性要求下，單 Redis 鎖不夠可靠，可考慮 Redlock 或改用資料庫層保證（唯一約束、`SELECT ... FOR UPDATE`）。

**心智模型**：分散式鎖是「盡力而為的互斥」，關鍵一致性仍要靠資料庫的唯一約束或交易兜底（呼應第 04 章）。

---

## 5.12 什麼資料適合放快取

適合：

- 讀多寫少：商品詳情、設定檔、分類樹。
- 重建成本高：複雜聚合結果、報表數字。
- 可容忍短暫不一致：熱門排行、瀏覽數。

不適合或要小心：

- 金額、庫存等強一致資料：可用 Redis 加速，但事實來源必須是資料庫（第 04 章）。
- 寫多讀少：快取命中率低，維護成本高於收益。
- 每個使用者都不同、幾乎不重複的資料：快取幫助有限。

---

## 5.13 常見錯誤

### 錯誤 1：把 Redis 當唯一資料庫

Redis 資料可能因記憶體不足被驅逐、因重啟遺失。核心業務資料一定要有資料庫這個事實來源，Redis 只是加速層。

### 錯誤 2：所有 key 都用同一個 TTL

會直接導致雪崩。務必加隨機抖動。

### 錯誤 3：更新資料只改快取，不動資料庫

快取遲早會過期或被驅逐，屆時「只存在快取的變更」就永久消失了。事實來源永遠是資料庫。

### 錯誤 4：快取粒度過大

把整個「首頁所有資料」塞進一個 key，任一小地方變動就得整包重建。應依變動頻率拆分 key。

### 錯誤 5：解鎖不驗證持有者

直接 `DEL` 可能刪掉別人的鎖，造成互斥失效。務必用 Lua 檢查唯一值再刪。

---

## 5.14 本章練習

### 練習 1：實作商品詳情的 Cache Aside

需求：`getProduct(id)` 先查 Redis，miss 時查資料庫並回填，TTL 300 秒；`updateProduct` 更新後要讓快取生效正確。請寫出讀取與更新的虛擬碼，並說明更新時為什麼刪快取而不是改快取。

#### 參考解答

讀取：

```text
function getProduct(id):
    key = "product:" + id
    cached = redis.get(key)
    if cached is not null:
        return deserialize(cached)

    product = db.query("SELECT id, name, price FROM products WHERE id = ?", id)
    if product is null:
        redis.set(key, "NULL", EX=60)     # 順便防穿透
        return null

    redis.set(key, serialize(product), EX=300)
    return product
```

更新：

```text
function updateProduct(id, data):
    db.update("UPDATE products SET name = ?, price = ? WHERE id = ?", data, id)
    redis.delete("product:" + id)
```

為什麼刪快取而不是改快取：

- 刪除是冪等的，重試安全。
- 避免併發下「用舊交易算出的值覆蓋快取」造成長期不一致。
- 下次讀取會用資料庫最新值自然重建快取。

### 練習 2：判斷是穿透、擊穿還是雪崩

分別判斷下列情況，並給對應解法：

1. 有人不斷用不存在的商品 ID 打你的 API，資料庫壓力暴增。
2. 半夜 12:00，昨天快取的大量商品同時過期，資料庫 QPS 瞬間飆高。
3. 首頁唯一一個爆款商品的快取到期瞬間，幾萬請求同時查資料庫。

#### 參考解答

1. 穿透。資料庫裡根本沒這些 ID，每次都 miss。解法：快取空值（短 TTL）+ 布隆過濾器擋掉不存在的 ID。

2. 雪崩。大量 key 同時過期。解法：TTL 加隨機抖動讓過期分散；並確保 Redis 高可用。

3. 擊穿。單一熱點 key 過期瞬間被打穿。解法：互斥鎖只讓一個請求重建快取，或熱點 key 用邏輯過期背景刷新。

### 練習 3：設計一個「文章瀏覽數」方案

需求：文章瀏覽數更新非常頻繁，但即時精確度可以容忍幾秒延遲。請設計一個不會把每次瀏覽都打進資料庫的方案。

#### 參考解答

```text
1. 每次瀏覽：redis.INCR("post:views:" + postId)
   - 原子操作，扛得住高併發，不碰資料庫。
2. 背景定時任務（例如每 30 秒）：
   - 讀出各文章的計數增量
   - 批次寫回資料庫：UPDATE posts SET views = views + ? WHERE id = ?
   - 或直接把 Redis 值同步到 DB
3. 讀取瀏覽數時：優先讀 Redis，沒有再從 DB 回填。
```

理由：

- 瀏覽數是「讀多寫多、可容忍短暫不一致」的典型資料。
- 用 Redis `INCR` 承接高頻寫入，資料庫只接收批次彙總，寫入壓力大幅下降。
- 這是「用 Redis 削寫入峰值」的常見手法。

### 練習 4：修正一段有 bug 的分散式鎖

以下解鎖程式有什麼風險？怎麼修？

```text
redis.set("lock:job", "1", NX, EX=30)
doJob()
redis.delete("lock:job")
```

#### 參考解答

風險：

1. 加鎖值是固定的 `"1"`，解鎖時無法分辨鎖是不是自己的。
2. 若 `doJob()` 執行超過 30 秒，鎖會先自動過期，別的 worker 搶到新鎖；此時原 worker 執行完直接 `DELETE`，會刪掉別人的鎖，導致兩個 worker 同時執行。

修正：

```text
token = uuid()
locked = redis.set("lock:job", token, NX, EX=30)
if not locked:
    return   # 沒搶到鎖

try:
    doJob()
finally:
    # 用 Lua 保證「比對 token + 刪除」原子執行
    redis.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
      keys=["lock:job"], args=[token])
```

更嚴謹時再加 watchdog 續租，避免任務比 TTL 長。

---

## 5.15 驗收清單

- [ ] 我能說明快取為什麼快，以及它帶來的一致性代價。
- [ ] 我會用 String、Hash、List、Set、Sorted Set 各自解決什麼問題。
- [ ] 我能實作 Cache Aside，並解釋為什麼更新時刪快取。
- [ ] 我能分辨穿透、擊穿、雪崩，並給對應解法。
- [ ] 我能用 Sorted Set 做排行榜。
- [ ] 我知道分散式鎖要用唯一值加 Lua 解鎖，且不能取代資料庫的強一致保證。

---

完成後請前往 [06-nosql-mongodb-document-modeling.md](./06-nosql-mongodb-document-modeling.md)。
