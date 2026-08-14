# Redis 完整課程：從資料結構到生產架構

> 很多人學 Redis 只學到「`SET` 一個 key、加個 TTL 當快取」，然後在生產環境被 big key、記憶體爆掉、主從切換掉資料、分散式鎖失效輪流教訓一遍。
> 這門課要把 Redis 當成一個**資料系統**來教：它的資料結構怎麼選、單執行緒為什麼快也為什麼會卡、記憶體與持久化怎麼權衡、叢集怎麼擴、線上出事時怎麼查。
> 每章都有可直接跑的指令、真實場景設計、常見錯誤與練習解答。

---

## 課程目標

完成本課後，你應該可以：

- 判斷一個需求該不該用 Redis，以及該用哪個資料結構（而不是所有東西都塞 JSON 字串）。
- 設計合理的 key 命名、TTL 策略與資料生命週期，避免 key 爆炸與記憶體無上限成長。
- 說明 Redis 單執行緒模型、慢命令、big key、hot key 為什麼會拖垮整個實例。
- 選擇 RDB / AOF / 混合持久化，並說明各自的資料遺失風險與恢復流程。
- 用 Pipeline、Lua Script 把多次往返變成一次原子操作。
- 用 Stream 與 Consumer Group 做可靠的訊息消費，知道它和 Pub/Sub 的差別。
- 落地快取模式與一致性策略，處理穿透、擊穿、雪崩。
- 實作正確的分散式鎖與限流器，並說清楚它們的失效邊界。
- 部署主從、Sentinel 與 Cluster，理解 slot 分配、擴縮容與故障轉移的代價。
- 用 `INFO`、`SLOWLOG`、`LATENCY`、`MEMORY` 等工具做效能診斷與線上排錯。

## 適合對象

- 已經在用 Redis 當快取，但說不清楚它為什麼快、什麼時候會慢的工程師。
- 需要設計高併發功能（秒殺、限流、排行榜、Session、訊息）的後端與全端工程師。
- 要負責 Redis 上線與維運，得處理記憶體、持久化、高可用的 DevOps / SRE。
- 準備面試，需要能講清楚驅逐策略、持久化、Cluster 與分散式鎖的人。

## 前置知識

- 會使用基本命令列與 Docker。
- 知道後端 API 與資料庫大致如何互動。
- 有任一程式語言基礎即可；範例以指令為主，程式片段以 Node.js 與 Python 示意。

## 這門課和 `database-course` 第 05 章的關係

| | 第 05 章 [Redis 與快取設計](../05-redis-caching-design.md) | 本課程 |
|---|---|---|
| 定位 | 資料庫課程中的一章，聚焦「快取」這個用途 | 獨立課程，把 Redis 當資料系統完整教 |
| 深度 | 資料結構速覽、Cache Aside、三大災難、排行榜與鎖入門 | 加上核心機制、記憶體編碼、持久化、Stream、Cluster、維運與排錯 |
| 建議 | 先讀，建立快取心智模型 | 再讀，補齊機制與生產環境能力 |

已經讀過第 05 章的人，第 09、10 章會有部分觀念重疊，但會往「一致性方案取捨」與「鎖的失效邊界」更深一層。

## 建議練習環境

- Docker Desktop：用容器起 Redis，方便反覆重建與測試叢集。
- Redis 7.2+：本課語法以 7.x 為準，會標註和 6.x 的差異。
- `redis-cli`：主要操作介面，含 `--bigkeys`、`--latency`、`--hotkeys`。
- RedisInsight：視覺化看 key、記憶體分布與慢查詢。
- `redis-benchmark`：壓測與效能驗證。

快速啟動：

```bash
docker run --name redis-course -p 6379:6379 -d redis:7.2
docker exec -it redis-course redis-cli
```

---

## 課程目錄

### 第 0 篇：入門與環境

| 章節 | 檔案 | 主題 |
|------|------|------|
| 00 | [00-course-map-and-setup.md](./00-course-map-and-setup.md) | 課程地圖、Redis 是什麼與不是什麼、適用與不適用場景、安裝與工具鏈 |

### 第 1 篇：資料結構與命令

| 章節 | 檔案 | 主題 |
|------|------|------|
| 01 | [01-keys-ttl-and-basic-commands.md](./01-keys-ttl-and-basic-commands.md) | Key 命名設計、`SCAN` 取代 `KEYS`、TTL 與三種過期機制、`SETNX`/`SETEX` 語意 |
| 02 | [02-core-data-structures.md](./02-core-data-structures.md) | String、Hash、List、Set、Sorted Set 深入，時間複雜度與選型決策樹 |
| 03 | [03-advanced-data-structures.md](./03-advanced-data-structures.md) | Bitmap 簽到、HyperLogLog 去重計數、GEO 附近搜尋、Stream、Bloom Filter 模組 |

### 第 2 篇：核心機制

| 章節 | 檔案 | 主題 |
|------|------|------|
| 04 | [04-single-thread-model-and-performance.md](./04-single-thread-model-and-performance.md) | 單執行緒與事件循環、I/O 多工、6.0 後的 I/O threads、慢命令、big key 與 hot key |
| 05 | [05-memory-management-and-eviction.md](./05-memory-management-and-eviction.md) | 內部編碼（listpack / intset / skiplist）、`maxmemory`、8 種驅逐策略、記憶體優化與碎片 |
| 06 | [06-persistence-rdb-aof.md](./06-persistence-rdb-aof.md) | RDB 快照、AOF 與三種 fsync、AOF 重寫、混合持久化、fork 阻塞與恢復演練 |

### 第 3 篇：程式設計實務

| 章節 | 檔案 | 主題 |
|------|------|------|
| 07 | [07-pipeline-transaction-lua.md](./07-pipeline-transaction-lua.md) | Pipeline 減少 RTT、`MULTI`/`EXEC`/`WATCH` 的真實保證、Lua 腳本原子性與陷阱 |
| 08 | [08-pubsub-and-streams.md](./08-pubsub-and-streams.md) | Pub/Sub 的即發即失、Stream 與 Consumer Group、`XACK`、`XPENDING`、重複消費與冪等 |
| 09 | [09-caching-patterns-in-practice.md](./09-caching-patterns-in-practice.md) | Cache Aside / Read Through / Write Behind、延遲雙刪、多級快取、穿透擊穿雪崩的完整解法 |
| 10 | [10-distributed-lock-and-rate-limit.md](./10-distributed-lock-and-rate-limit.md) | 分散式鎖從 `SETNX` 到 Redlock 的爭議、看門狗續期、固定窗口/滑動窗口/令牌桶限流 |

### 第 4 篇：架構與維運

| 章節 | 檔案 | 主題 |
|------|------|------|
| 11 | [11-replication-sentinel-cluster.md](./11-replication-sentinel-cluster.md) | 主從複製與 psync、Sentinel 故障轉移、Cluster 16384 slot、擴縮容與跨 slot 限制 |
| 12 | [12-monitoring-and-troubleshooting.md](./12-monitoring-and-troubleshooting.md) | `INFO` 關鍵指標、`SLOWLOG`、`LATENCY`、`MEMORY DOCTOR`、`redis-benchmark`、線上排錯流程 |
| 13 | [13-security-and-production-best-practices.md](./13-security-and-production-best-practices.md) | ACL 權限、TLS、危險命令封鎖、連線池與超時、容量規劃與成本、上線檢查表 |

### 第 5 篇：專題

| 章節 | 檔案 | 主題 |
|------|------|------|
| 14 | [14-capstone-redis-architecture.md](./14-capstone-redis-architecture.md) | Capstone：為電商直播平台設計 Redis 架構（Session、購物車、秒殺庫存、排行榜、限流、事件流） |

---

## 本課教學方式

每章都會包含：

- **學習目標**：先說清楚這章要解決哪個真實問題。
- **觀念講解**：用產品場景與心智模型解釋機制，不只列命令。
- **實作範例**：可直接複製執行的 `redis-cli` 指令與程式片段。
- **常見錯誤**：新手與線上事故最常見的踩坑點。
- **練習題 + 參考解答**：每題都附解法與理由。
- **驗收清單**：自我檢查是否真的掌握。

## 建議學習路線

第一次學習請照順序：

```text
00 環境與定位
  -> 01 Key 與 TTL
  -> 02 核心資料結構
  -> 03 進階資料結構
  -> 04 單執行緒與效能
  -> 05 記憶體與驅逐
  -> 06 持久化
  -> 07 Pipeline 與 Lua
  -> 08 Pub/Sub 與 Stream
  -> 09 快取實戰
  -> 10 分散式鎖與限流
  -> 11 高可用架構
  -> 12 監控與排錯
  -> 13 安全與生產實踐
  -> 14 期末專題
```

依角色的加速路線：

- **只想把快取做對**：00 → 01 → 02 → 09 → 05 → 12
- **要做高併發功能**：02 → 03 → 07 → 10 → 08 → 14
- **要負責上線維運**：04 → 05 → 06 → 11 → 12 → 13

---

準備好了嗎？從 [00-course-map-and-setup.md](./00-course-map-and-setup.md) 開始。
