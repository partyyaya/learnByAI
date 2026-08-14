# 第 00 章：課程地圖、Redis 定位與環境建置

> 大部分人第一次接觸 Redis，是因為某個 API 太慢，前輩說「加個 Redis 吧」。
> 於是 Redis 在很多人腦中被歸類成「一個讓查詢變快的東西」，這個理解不算錯，但太小了——它會讓你錯過 Redis 一半以上的能力，也會讓你在記憶體爆掉、主從切換掉資料時完全不知道發生什麼事。
> 這章先建立正確定位：Redis 是**記憶體資料結構伺服器**，快取只是它最常見的一種用法。定位對了，後面 14 章才有地方掛。

---

## 0.1 學習目標

完成本章後，你應該可以：

- 用一句話說清楚 Redis 是什麼，以及它和「快取」的關係。
- 說出 Redis 快的三個真正原因，而不是只講「因為在記憶體」。
- 判斷一個需求適合 Redis、還是該用關聯式資料庫、Memcached、本地快取或訊息佇列。
- 說明 Redis 不適合的場景，以及硬用會付什麼代價。
- 用 Docker 啟動一個帶密碼與持久化的 Redis，並連上 `redis-cli`。
- 知道 Redis / Valkey 的授權變動，以及選版本時該注意什麼。
- 完成第一個「查詢加上快取」的最小實作。

---

## 0.2 Redis 是什麼：不是快取軟體，是資料結構伺服器

Redis 的官方定位是 **in-memory data structure store**，中文可以理解成「跑在記憶體裡、透過網路提供資料結構操作的伺服器」。

這個定義有三個關鍵字，每個都很重要：

**in-memory（記憶體）**
資料主要放在 RAM，不是磁碟。所以讀寫延遲是微秒級，但也意味著容量受記憶體大小限制、成本比磁碟高、且需要額外機制才能在重啟後保住資料。

**data structure（資料結構）**
這是 Redis 和 Memcached 最大的差別。Memcached 給你的是「一個 key 對一個 byte 陣列」，你想改其中一個欄位，只能整份取出、改完、整份寫回。Redis 給你的是**伺服器端就懂的資料結構**：

```bash
# Memcached 式思維：value 是不透明的字串
SET user:1001 "{\"name\":\"Alice\",\"points\":1200}"
# 想加 50 點，要 GET 出來、在應用層解析、改完、SET 回去（三步，且有競爭風險）

# Redis 式思維：伺服器懂這是 Hash，可以只動一個欄位
HSET user:1001 name "Alice" points 1200
HINCRBY user:1001 points 50
# 一步，且是原子操作
```

`HINCRBY` 這行是重點：運算在**伺服器端**完成，所以它是原子的。兩個請求同時加 50 點，結果一定是加了 100，不會互相覆蓋。這件事在應用層用「讀出來改再寫回去」永遠做不到，除非你自己加鎖。

**store / server（伺服器）**
Redis 是獨立行程，透過 TCP 提供服務。這代表多台應用伺服器可以共享同一份資料——這是它能做 Session 共享、分散式鎖、跨機器計數的前提，也是它和「行程內本地快取」的根本差別。

把三個關鍵字合起來，Redis 的心智模型是：

```text
一個所有服務都能連上的、超快的、懂資料結構的共享記憶體
```

快取只是這個能力最常見的一種應用。當你需要「多台機器共享一份高速變動的狀態」，答案通常都是 Redis。

---

## 0.3 Redis 為什麼快

面試很愛問，但多數人只答得出第一點。完整答案有三層，第 04 章會深入，這裡先建立框架。

### 原因 1：資料在記憶體

記憶體的隨機存取延遲大約是 100 奈秒級，SSD 是幾十微秒，機械硬碟是毫秒級。差距是好幾個數量級。這是最直觀的原因，但如果只有這一點，Redis 不會比其他記憶體快取特別快。

### 原因 2：資料結構與演算法都是為 O(1) / O(log N) 設計的

Redis 的每個命令都標註了時間複雜度，而且核心命令幾乎都是常數或對數時間：

| 操作 | 命令 | 複雜度 |
|------|------|--------|
| 取一個字串 | `GET` | O(1) |
| 改 Hash 一個欄位 | `HSET` | O(1) |
| 排行榜加分 | `ZADD` | O(log N) |
| 取排行榜前 10 名 | `ZREVRANGE key 0 9` | O(log N + 10) |
| 判斷元素是否存在 | `SISMEMBER` | O(1) |

注意這裡的反面：**Redis 也有 O(N) 命令**，例如 `KEYS *`、`HGETALL` 一個十萬欄位的 Hash、`SMEMBERS` 一個巨大 Set。這些命令在單執行緒模型下會卡住整個實例。所以「Redis 很快」是有條件的，條件就是你沒有亂用 O(N) 命令——這是第 04 章的主題。

### 原因 3：單執行緒 + I/O 多工，避開了鎖與 context switch

Redis 處理命令的主邏輯是單執行緒的。聽起來像缺點，實際上在這個場景是優勢：

- **不需要鎖**：沒有多執行緒競爭同一份資料，省下加鎖、解鎖的開銷，也不會死鎖。
- **沒有 context switch**：不會因為執行緒切換浪費 CPU。
- **命令天然原子**：一個命令執行到底才會處理下一個，這是 `INCR`、`HINCRBY` 能保證正確的根本原因。

至於「單執行緒不是很浪費多核心嗎」——Redis 的瓶頸通常在網路 I/O 和記憶體頻寬，不在 CPU 運算。而且它用 epoll / kqueue 這類 I/O 多工機制，單執行緒就能同時處理上萬個連線。Redis 6.0 之後加入了 I/O threads，把網路讀寫的部分交給多執行緒，但**命令執行仍然是單執行緒**。想用滿多核心，標準做法是在一台機器上跑多個 Redis 實例。

心智模型：

```text
Redis = 一個非常勤勞、絕不分心的單一員工
      + 一張隨時知道誰在排隊的名單（I/O 多工）
      + 一套設計成幾乎不用思考的辦事流程（O(1) 資料結構）

它快的前提是：你不要丟一件要做十分鐘的事給他（O(N) 大命令）
因為他一次只做一件事，卡住就是全部卡住
```

---

## 0.4 Redis 適合什麼：八個典型場景

這一節是選型的正面清單。共同特徵是：**資料變動快、要被多方共享、能容忍遺失或可重建、查詢模式簡單**。

### 場景 1：快取（Cache）

最經典的用法。擋住對資料庫的大量重複讀取。

```bash
SET product:1001 "{\"id\":1001,\"name\":\"機械鍵盤\",\"price\":2990}" EX 300
```

適合快取的資料：讀多寫少、允許短暫舊資料、重建成本高（例如要 JOIN 五張表）。第 09 章會完整處理一致性與三大災難。

### 場景 2：Session 與登入狀態

多台應用伺服器要共享登入狀態。放在單機記憶體會導致換一台就要重新登入。

```bash
SETEX session:abc123 1800 "{\"userId\":1001,\"role\":\"admin\"}"
```

TTL 天然對應「閒置 30 分鐘自動登出」，這是 Redis 特別合適的原因——過期邏輯不用自己寫。

### 場景 3：排行榜與即時排名

Sorted Set 是為這件事生的。分數變動與取 Top N 都是對數時間。

```bash
ZINCRBY leaderboard:weekly 10 "user:1001"
ZREVRANGE leaderboard:weekly 0 9 WITHSCORES   # 前 10 名
ZREVRANK leaderboard:weekly "user:1001"        # 我排第幾
```

用 SQL 做同樣的事，每次都要 `ORDER BY score DESC LIMIT 10`，資料量大時是持續的排序成本。

### 場景 4：計數器

瀏覽數、按讚數、庫存餘量、API 呼叫次數。`INCR` 是原子的，高併發下不會少算。

```bash
INCR article:2024:views
INCRBY article:2024:views 5
```

實務上常見的做法是先在 Redis 累加，再定期批次寫回資料庫。用資料庫的 `UPDATE ... SET views = views + 1` 在高流量下會產生嚴重的行鎖競爭。

### 場景 5：限流（Rate Limiting）

「每個 IP 每分鐘最多 60 次請求」。計數 + TTL 就是一個最簡單的固定窗口限流器。

```bash
INCR rate:ip:1.2.3.4
EXPIRE rate:ip:1.2.3.4 60
```

（這個寫法有邊界問題與競爭風險，第 10 章會用 Lua 修好，並實作滑動窗口與令牌桶。）

### 場景 6：分散式鎖

多個服務實例要搶同一個資源的執行權，例如避免同一筆訂單被兩台機器同時處理。

```bash
SET lock:order:8888 "worker-3" NX EX 30
```

`NX` 保證只有一個請求能成功。第 10 章會處理續期、誤刪別人的鎖、以及 Redlock 的爭議。

### 場景 7：訊息佇列與事件流

List 可以當簡易佇列，Stream 提供消費者群組、確認機制與訊息回溯。

```bash
XADD orders:events "*" type "created" orderId "8888"
```

適合輕量的異步任務與事件廣播。第 08 章會說清楚它和 Kafka、RabbitMQ 的分界在哪。

### 場景 8：去重、簽到與地理位置

這些是「用對資料結構就省超多記憶體」的例子：

```bash
SETBIT signin:2026:08:u1001 12 1        # Bitmap：使用者當月第 13 天簽到
PFADD uv:2026-08-13 "u1001" "u1002"     # HyperLogLog：估算 UV，固定 12KB
GEOADD stores 121.5654 25.0330 "taipei-101"  # GEO：找附近的店
```

HyperLogLog 用約 12KB 就能估算上億個不重複元素的數量（有約 0.81% 的標準誤差）。用 Set 存一億個 ID 會吃掉好幾 GB。第 03 章會詳談這個取捨。

---

## 0.5 Redis 不適合什麼

反面清單同樣重要。看到這些訊號，要停下來想想。

### 不適合：當唯一的事實來源（Source of Truth）

Redis 有持久化，但它的持久化設計目標是「快速恢復」，不是「絕不遺失」。預設的 AOF `everysec` 策略在斷電時可能丟掉最後一秒的寫入；RDB 更可能丟掉幾分鐘。

如果你把訂單、金額、餘額只存在 Redis，某次意外重啟就是真實的資料損失。**核心業務資料放在關聯式資料庫，Redis 存可重建的加速層或短生命週期狀態。**

第 06 章會完整討論持久化的保證邊界。

### 不適合：複雜查詢與多條件篩選

Redis 沒有查詢優化器，也沒有二級索引（模組除外）。你只能用你事先設計好的 key 去找資料。

```sql
-- 這種查詢在 Redis 原生是做不到的
SELECT * FROM orders
WHERE status = 'paid' AND amount > 1000 AND created_at > '2026-08-01'
ORDER BY amount DESC LIMIT 20;
```

要在 Redis 支援這種查詢，你得為每個查詢維度自己建 Sorted Set 或 Set 當索引，然後手動做交集——寫起來痛苦，還要負責維護一致性。這種需求就用資料庫或 Elasticsearch。

### 不適合：資料量遠超記憶體預算

記憶體比磁碟貴一個數量級以上。如果你有 2TB 的歷史訂單要存，放 Redis 的成本會非常不合理。Redis 適合存的是**熱資料**，冷資料放磁碟型資料庫。

### 不適合：需要跨 key 強交易的場景

Redis 的 `MULTI`/`EXEC` 常被誤稱為交易，但它**沒有回滾**。如果第三個命令因為型別錯誤失敗了，前兩個已經執行的命令不會被撤銷。這和關聯式資料庫的 ACID 交易完全不是同一回事，第 07 章會拆解。

### 不適合：大 value 與大集合

單一 value 存幾 MB 的資料（例如整份商品列表 JSON），或一個 Hash 存幾十萬個欄位，都會造成：網路傳輸變慢、記憶體分布不均、以及最致命的——操作它的命令變成慢命令，卡住單執行緒。這叫 big key 問題，是線上事故的常客。

---

## 0.6 選型對照：Redis 和它的鄰居

| | Redis | Memcached | 本地快取（如 Caffeine） | 關聯式資料庫 | Kafka / RabbitMQ |
|---|---|---|---|---|---|
| 資料結構 | 豐富（9 種以上） | 只有字串 | 依語言而定 | 表格關聯 | 訊息 |
| 跨機器共享 | 是 | 是 | 否 | 是 | 是 |
| 延遲 | 微秒（含網路） | 微秒 | 奈秒 | 毫秒 | 毫秒 |
| 持久化 | 有（非強保證） | 無 | 無 | 強保證 | 強保證 |
| 複雜查詢 | 弱 | 無 | 無 | 強 | 無 |
| 訊息保序與回溯 | Stream 有限支援 | 無 | 無 | 無 | 完整支援 |
| 典型用途 | 快取、狀態、鎖、排行榜 | 純快取 | 極熱資料的第一層 | 事實來源 | 解耦與削峰 |

三個實務判斷：

**Redis vs Memcached**：現在幾乎沒有選 Memcached 的理由，除非你只需要純字串快取、且已有成熟的 Memcached 維運經驗。Redis 的資料結構、持久化與高可用方案都更完整。

**Redis vs 本地快取**：不是二選一，而是搭配。本地快取更快（不用過網路）但每台機器一份、容量小、失效難同步。標準做法是「本地快取 + Redis」的多級快取，用本地擋住最熱的少數 key，Redis 擋住其餘的。第 09 章會設計這個架構。

**Redis vs 訊息佇列**：小規模異步任務、不需要嚴格保序與長期保存，Redis Stream 夠用且少一套系統要維護。一旦你需要高吞吐、多消費者組、長期訊息保存與重放，就該用 Kafka。第 08 章會給明確的分界線。

---

## 0.7 如何取得 Redis

### 方式 1：Docker（本課推薦）

最快、最乾淨、不污染本機環境，也方便之後模擬主從與叢集。

```bash
docker run --name redis-course -p 6379:6379 -d redis:7.2
```

### 方式 2：套件管理器安裝

macOS：

```bash
brew install redis
brew services start redis
```

Ubuntu / Debian：

```bash
sudo apt update && sudo apt install redis-server
sudo systemctl enable --now redis-server
```

Windows 沒有官方原生支援，請使用 WSL2 或 Docker。

### 方式 3：雲端託管

生產環境的常見選擇，把備份、監控、故障轉移交給雲廠商：

- **AWS ElastiCache / MemoryDB**：MemoryDB 提供更強的持久化保證，適合當半個事實來源。
- **GCP Memorystore**、**Azure Cache for Redis**。
- **Upstash**：按請求計費的 Serverless 模式，適合流量不穩定或無伺服器架構。
- **Redis Cloud**：官方託管，模組（Search、JSON、Bloom）支援最完整。

託管服務通常會**封鎖部分命令**（例如 `CONFIG SET`、`FLUSHALL`、`DEBUG`），架構設計時要先確認，不要等到上線才發現腳本跑不動。

### 方式 4：自建叢集

多節點分片與高可用，用 Kubernetes Operator 或手動部署。第 11 章會實作。

### 關於授權與 Valkey：選版本前該知道的事

這幾年 Redis 生態有個不小的變動，會影響你的選型，簡單說明：

- Redis 長期採用 BSD 授權。2024 年 3 月，Redis Ltd. 宣布從 Redis 7.4 起改為 RSALv2 / SSPLv1 雙授權，這對「把 Redis 當服務賣」的雲廠商有限制。
- 社群隨即在 Linux Foundation 下從 Redis 7.2.4 分支出 **Valkey**，維持 BSD 授權，AWS、Google、Oracle 等都有參與。
- 2025 年 Redis 8.0 又加入 AGPLv3 作為可選授權，算是部分回應了社群反彈。

對這門課的實際影響很小：**Valkey 與 Redis 7.2 的命令與協定高度相容**，本課所有指令在兩者上都能跑。你只需要知道：

- 自用、內部服務：Redis 或 Valkey 都可以，差異幾乎感受不到。
- 你的公司是要對外提供 Redis 託管服務的雲廠商：授權條款要請法務看。
- 看雲端服務文件時，有些廠商的「Redis 相容服務」實際跑的是 Valkey。

本課以 `redis:7.2` 為基準撰寫，需要時會標註版本差異。

---

## 0.8 實作：建立本課的練習環境

### 最小啟動

```bash
docker run --name redis-course -p 6379:6379 -d redis:7.2
docker exec -it redis-course redis-cli
```

在 CLI 裡驗證：

```bash
127.0.0.1:6379> PING
PONG
127.0.0.1:6379> SET hello world
OK
127.0.0.1:6379> GET hello
"world"
```

看到 `"world"` 就代表環境可用。

### 加上密碼與持久化

上面那個容器一停掉，資料就沒了，而且沒有密碼。練習後面幾章（尤其第 06 章持久化）會需要更完整的設定，建議直接用 Docker Compose：

```yaml
# docker-compose.yml
services:
  redis:
    image: redis:7.2
    container_name: redis-course
    ports:
      - "6379:6379"
    command:
      - redis-server
      - --requirepass
      - coursepass
      - --appendonly
      - "yes"
      - --maxmemory
      - 256mb
      - --maxmemory-policy
      - allkeys-lru
    volumes:
      - redis-data:/data

volumes:
  redis-data:
```

啟動與連線：

```bash
docker compose up -d
docker compose exec redis redis-cli -a coursepass
```

四個參數的意義，都會在後面章節展開：

| 參數 | 作用 | 詳見 |
|------|------|------|
| `--requirepass` | 設定密碼 | 第 13 章（並會說明為何 ACL 更好） |
| `--appendonly yes` | 開啟 AOF 持久化 | 第 06 章 |
| `--maxmemory 256mb` | 記憶體上限 | 第 05 章 |
| `--maxmemory-policy allkeys-lru` | 到上限時驅逐最久未用的 key | 第 05 章 |

`-a coursepass` 會出現一行警告說用命令列帶密碼不安全，這是正常的；練習環境可以忽略，生產環境請用 ACL 或環境變數。

### 必學的 redis-cli 用法

這幾個之後每章都會用到，先熟悉：

```bash
# 直接執行單一命令，不進互動模式
redis-cli -a coursepass GET hello

# 看伺服器狀態（第 12 章會逐項解讀）
redis-cli -a coursepass INFO memory

# 掃出佔記憶體最大的 key（big key 排查神器，第 04 章）
redis-cli -a coursepass --bigkeys

# 持續量測延遲
redis-cli -a coursepass --latency

# 即時看所有進來的命令（除錯用，生產環境慎用，有效能影響）
redis-cli -a coursepass MONITOR

# 壓測
redis-benchmark -a coursepass -q -n 10000
```

`MONITOR` 要特別提醒：它會把每個命令都推給你的連線，在高流量的生產環境開啟可能明顯影響效能，除錯完請立刻關掉。

### 視覺化工具

指令熟悉之後，視覺化工具能幫你更快看懂資料分布：

- **RedisInsight**：官方免費 GUI，能看 key 的樹狀結構、記憶體分析、慢查詢日誌、還內建 CLI。
- **Another Redis Desktop Manager**：開源輕量替代品。

建議兩者都不要取代 `redis-cli`——面試、上線排錯、SSH 進機器時，你只有 CLI。

---

## 0.9 第一個實作：把一次查詢包上快取

這是 Redis 最常見的第一個應用，也是第 09 章的起點。先看完整流程長什麼樣（Node.js 示意，其他語言邏輯相同）：

```javascript
const CACHE_TTL = 300; // 秒

async function getProduct(id) {
  const cacheKey = `product:${id}`;

  // 1. 先查快取
  const cached = await redis.get(cacheKey);
  if (cached !== null) {
    return JSON.parse(cached);
  }

  // 2. 快取沒有，查資料庫
  const product = await db.query('SELECT * FROM products WHERE id = $1', [id]);
  if (!product) {
    return null;
  }

  // 3. 寫回快取，並設定過期時間
  await redis.set(cacheKey, JSON.stringify(product), 'EX', CACHE_TTL);

  return product;
}
```

這段程式碼看起來很簡單，但它至少有四個問題，正好對應本課後面的章節：

| 問題 | 會發生什麼 | 解在哪一章 |
|------|-----------|-----------|
| 查不到的 id 不會被快取 | 惡意請求不存在的 id，每次都打到資料庫（快取穿透） | 第 09 章 |
| 所有 key 的 TTL 都是 300 秒 | 同時大量寫入的 key 會同時過期，瞬間全打到資料庫（雪崩） | 第 09 章 |
| 熱門 key 過期瞬間，大量請求同時重建 | 資料庫被同一個查詢打爆（擊穿） | 第 09 章 |
| 商品資料更新時沒有處理快取 | 使用者看到最多 300 秒的舊價格 | 第 09 章 |

現在不用急著解，先讓它跑起來，感受一下快取命中和沒命中的延遲差別。**知道這段程式碼有問題，比會寫這段程式碼更重要。**

---

## 0.10 常見錯誤

### 錯誤 1：把 Redis 當資料庫用

「反正 Redis 有持久化」是很危險的想法。持久化能救你重啟，但救不了斷電那一秒、也救不了主從切換時未同步的資料。核心資料要有磁碟型資料庫當事實來源。

### 錯誤 2：認為 Redis 一定快，所以不需要在意命令複雜度

單執行緒的意思是「一個慢命令會卡住所有人」。`KEYS *`、`HGETALL` 一個巨大 Hash、`FLUSHALL` 一個大實例，都可能造成整個服務的請求堆積。

### 錯誤 3：不設 TTL

沒有 TTL 的 key 會永久佔用記憶體。等到記憶體滿，你的驅逐策略如果是預設的 `noeviction`，新的寫入就會直接報錯。第 05 章會詳談。

### 錯誤 4：把整個大物件塞進一個 String

例如把整份商品列表序列化成 5MB 的 JSON 存一個 key。這會同時觸發 big key、網路頻寬與序列化成本三個問題。該拆成 Hash 或多個 key。

### 錯誤 5：以為 `MULTI`/`EXEC` 是有回滾的交易

它沒有回滾，也不會因為前面失敗就中止後面。想要真正的原子邏輯，用 Lua（第 07 章）。

### 錯誤 6：在生產環境開著 `MONITOR` 或 `--bigkeys` 忘記關

`MONITOR` 有明顯效能影響；`--bigkeys` 雖然底層用 `SCAN` 是安全的，但在超大實例上仍會產生持續負載。除錯完就關掉。

---

## 0.11 本章練習

### 練習 1：判斷選型

以下六個需求，各自最適合用 Redis、關聯式資料庫、還是兩者搭配？說明理由。

1. 電商的訂單與付款紀錄。
2. 首頁「熱門商品 Top 20」，每分鐘依成交量更新。
3. 使用者登入 Session，需要閒置 30 分鐘自動失效。
4. 後台查詢「上個月所有金額大於 5000 且狀態為已付款的訂單」。
5. 直播間的即時觀看人數。
6. 秒殺活動的庫存扣減，商品只有 100 件。

<details>
<summary>參考解答</summary>

**1. 訂單與付款紀錄 → 關聯式資料庫**

這是金流核心，需要 ACID 交易、外鍵約束、以及絕對不能遺失。Redis 的持久化保證不足以承擔。真的要用 Redis，只能是「訂單詳情頁的讀取快取」，事實來源仍在資料庫。

**2. 熱門商品 Top 20 → Redis（Sorted Set）**

`ZINCRBY` 加分、`ZREVRANGE 0 19` 取榜，都是對數時間。用 SQL 每分鐘 `ORDER BY sales DESC LIMIT 20` 也能做，但資料量大時是重複的排序成本，而且這份資料允許短暫不精確。

**3. 登入 Session → Redis（String 或 Hash + TTL）**

三個理由都指向 Redis：需要多台伺服器共享、讀取頻率極高（每個請求都要驗）、且「閒置自動失效」正好對應 TTL，續期只要 `EXPIRE` 一次。Session 遺失的後果是重新登入，可以接受。

**4. 後台複雜條件查詢 → 關聯式資料庫**

多條件篩選 + 範圍查詢 + 排序，這是關聯式資料庫加上合適索引的主場。Redis 沒有查詢優化器，硬做要自己維護多個索引 Set 再做交集，複雜度高且容易不一致。

**5. 直播即時觀看人數 → Redis**

高頻變動、允許誤差、不需要永久保存，全部符合 Redis 特徵。精確人數可用 Set 存 userId（`SCARD` 取數量），量體極大時改用 HyperLogLog 換記憶體。這種每秒變動數千次的計數，寫資料庫會直接打爆。

**6. 秒殺庫存扣減 → Redis 扣減 + 關聯式資料庫落帳（兩者搭配）**

這是最需要拆兩層的場景。用 `DECR` 或 Lua 腳本在 Redis 做原子預扣，先擋掉絕大多數請求；只有預扣成功的請求才進到資料庫建立訂單並做最終確認。

只用資料庫：`SELECT FOR UPDATE` 的行鎖會讓瞬時流量全部排隊。
只用 Redis：Redis 掛掉或資料遺失時，你不知道到底賣了幾件。

所以 Redis 負責「快速擋量」，資料庫負責「最終正確」。第 14 章會完整設計這個流程。

</details>

### 練習 2：啟動環境並驗證

用 Docker Compose 啟動一個符合以下條件的 Redis，並用 `redis-cli` 驗證每一項：

- 密碼為 `mysecret`
- 記憶體上限 128MB
- 驅逐策略為 `volatile-lru`
- 開啟 AOF

<details>
<summary>參考解答</summary>

```yaml
services:
  redis:
    image: redis:7.2
    ports:
      - "6379:6379"
    command:
      - redis-server
      - --requirepass
      - mysecret
      - --maxmemory
      - 128mb
      - --maxmemory-policy
      - volatile-lru
      - --appendonly
      - "yes"
    volumes:
      - redis-data:/data

volumes:
  redis-data:
```

驗證：

```bash
docker compose up -d

# 沒帶密碼應該被拒絕，回 NOAUTH 錯誤
docker compose exec redis redis-cli PING

# 帶密碼應該回 PONG
docker compose exec redis redis-cli -a mysecret PING

# 逐項確認設定生效
docker compose exec redis redis-cli -a mysecret CONFIG GET maxmemory
# 1) "maxmemory"  2) "134217728"        （128 * 1024 * 1024）

docker compose exec redis redis-cli -a mysecret CONFIG GET maxmemory-policy
# 1) "maxmemory-policy"  2) "volatile-lru"

docker compose exec redis redis-cli -a mysecret CONFIG GET appendonly
# 1) "appendonly"  2) "yes"
```

順手觀察一個重點：`maxmemory` 回傳的是 bytes（`134217728`）而不是 `128mb`。Redis 的設定值在讀取時常做單位轉換，之後看 `INFO` 或寫監控時要注意。

補充：`volatile-lru` 只驅逐**有設 TTL** 的 key。如果你的資料都沒設 TTL，記憶體滿了會無 key 可驅逐，行為等同 `noeviction`——新的寫入直接報錯。這是實務上很常見的誤設，第 05 章會展開。

</details>

### 練習 3：感受單執行緒的代價

在你的練習環境裡，先寫入一個有 50 萬個欄位的 Hash，然後比較 `HGET` 單一欄位和 `HGETALL` 整份的耗時差異。

<details>
<summary>參考解答</summary>

先灌資料。用一段 Lua 在伺服器端一次做完，避免 50 萬次網路往返（第 07 章會正式介紹 Lua）：

```bash
docker compose exec redis redis-cli -a mysecret EVAL \
  "for i=1,500000 do redis.call('HSET', KEYS[1], 'field'..i, 'value'..i) end return redis.call('HLEN', KEYS[1])" \
  1 big:hash
```

回傳 `(integer) 500000` 就代表灌好了。順帶一提，這段腳本本身跑起來就要一兩秒，而在這段時間內 Redis 同樣是卡住的——這已經是本練習要展示的現象之一。

比較兩個命令。先進到容器內操作，避免把 `docker exec` 的啟動開銷算進去：

```bash
docker compose exec redis sh
```

在容器內執行：

```sh
# O(1)：取單一欄位，幾乎沒有延遲
time redis-cli -a mysecret HGET big:hash field1 > /dev/null

# O(N)：要序列化並傳輸 100 萬個回傳元素（50 萬個 field + 50 萬個 value）
time redis-cli -a mysecret HGETALL big:hash > /dev/null
```

你會看到 `HGETALL` 明顯慢得多。更重要的是，在它執行的那段時間內，**這個 Redis 實例無法處理任何其他請求**——所有其他客戶端都在排隊。這就是單執行緒的代價。

想直接看到「卡住別人」這件事，開兩個終端：一個持續量測延遲，另一個去跑 `HGETALL`，然後觀察延遲數字跳高。

```sh
# 終端 A：持續量測
redis-cli -a mysecret --latency-history -i 1

# 終端 B：在 A 跑著的時候執行
redis-cli -a mysecret HGETALL big:hash > /dev/null
```

也可以事後從慢查詢日誌確認它被記錄下來（第 12 章會詳談）：

```sh
redis-cli -a mysecret SLOWLOG GET 1
```

用 `MEMORY USAGE` 看它有多大：

```sh
redis-cli -a mysecret MEMORY USAGE big:hash
```

正確做法是用 `HSCAN` 分批取，或一開始就把資料拆成多個 key：

```sh
redis-cli -a mysecret HSCAN big:hash 0 COUNT 100
```

記得清掉這個練習資料。注意用 `UNLINK` 而不是 `DEL`——`DEL` 刪除大 key 是阻塞的，`UNLINK` 會把記憶體回收交給背景執行緒：

```sh
redis-cli -a mysecret UNLINK big:hash
```

這個練習的結論會貫穿整門課：**Redis 的效能不是它保證給你的，是你設計出來的。**

</details>

---

## 0.12 驗收清單

進入下一章前，確認你可以：

- [ ] 用一句話說明 Redis 是什麼，並解釋它為什麼不只是快取。
- [ ] 說出 Redis 快的三個原因，以及「快」的前提條件是什麼。
- [ ] 舉出至少五個適合 Redis 的場景，以及三個不適合的場景。
- [ ] 說明 Redis 和 Memcached、本地快取、訊息佇列的差別。
- [ ] 用 Docker Compose 啟動一個帶密碼、AOF 與記憶體上限的 Redis。
- [ ] 熟練使用 `redis-cli` 的 `INFO`、`--bigkeys`、`--latency`。
- [ ] 解釋為什麼 `KEYS *` 和 `HGETALL` 一個大 Hash 是危險操作。
- [ ] 說明為什麼核心業務資料不該只存在 Redis。

---

下一章開始進入實作核心：[01-keys-ttl-and-basic-commands.md](./01-keys-ttl-and-basic-commands.md)，我們會處理一個很少人認真設計、但線上出事時最痛的東西——key 的命名與生命週期。
