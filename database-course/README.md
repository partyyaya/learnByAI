# 資料庫設計與實戰完整課程

> 這門課不是只教你背 SQL 語法，而是訓練你成為「能替系統做資料決策」的工程師。
> 真實產品裡，資料庫選錯會讓功能難做、成本變高、查詢變慢，甚至在高併發時賣超、扣錯庫存、產生髒資料。
> 本課會從資料庫選型、資料建模、SQL、交易、索引、效能、高併發一路講到備份、安全與期末專題。

---

## 課程目標

完成本課後，你應該可以：

- 判斷一個需求適合使用 MySQL、PostgreSQL、MongoDB、Redis、Elasticsearch、ClickHouse 或 NewSQL。
- 說明「如何取得資料庫」：本機安裝、Docker、雲端託管、自建叢集各自適用的情境。
- 設計基本 ERD、主鍵、外鍵、一對多、多對多與索引。
- 寫出常用 SQL，並能用 `EXPLAIN` 觀察查詢是否合理。
- 理解交易、ACID、四種隔離級別、MVCC、行鎖與間隙鎖、死鎖排查與資料一致性。
- 處理效能優化：慢查詢、索引、分頁、批次寫入、快取、讀寫分離、分區與分片。
- 設計高併發場景，例如搶票、秒殺、限量庫存扣減，避免超賣與重複下單。

## 適合對象

- 會寫後端 API，但資料庫設計常靠直覺的工程師。
- 想從「會查資料」進階到「會設計資料系統」的前端、全端或後端工程師。
- 準備面試，需要能講清楚索引、交易、高併發與資料庫選型的人。
- 想把資料庫基礎補完整的自學者。

## 前置知識

- 會使用基本命令列。
- 知道 HTTP API 與後端服務大致如何運作。
- 有任一程式語言基礎即可，不限定 JavaScript、Python、Java 或 Go。

## 建議練習環境

本課範例會以 PostgreSQL、MySQL 與 Redis 為主，並在特定章節介紹 MongoDB、Elasticsearch、ClickHouse。

建議工具：

- Docker Desktop：快速啟動資料庫，不污染本機環境。
- DBeaver、DataGrip 或 pgAdmin：視覺化查資料與看 schema。
- PostgreSQL 16+ 或 MySQL 8+：主要關聯式資料庫。
- Redis 7+：快取、排行榜、分散式鎖與高併發庫存範例。

---

## 課程目錄

### 第 0 篇：資料庫選型與環境

| 章節 | 檔案 | 主題 |
|------|------|------|
| 00 | [00-course-map-database-selection-and-setup.md](./00-course-map-database-selection-and-setup.md) | 課程地圖、資料庫分類、如何判斷用哪種資料庫、如何取得 |

### 第 1 篇：關聯式資料庫核心

| 章節 | 檔案 | 主題 |
|------|------|------|
| 01 | [01-relational-modeling-erd-normalization.md](./01-relational-modeling-erd-normalization.md) | 關聯式建模、ERD、主鍵外鍵、正規化與反正規化 |
| 02 | [02-sql-crud-join-transaction.md](./02-sql-crud-join-transaction.md) | SQL CRUD、JOIN、聚合、交易、ACID、四種隔離級別、MVCC、UPSERT 與 RETURNING |

### 第 2 篇：效能與高併發

| 章節 | 檔案 | 主題 |
|------|------|------|
| 03 | [03-index-query-performance-optimization.md](./03-index-query-performance-optimization.md) | 索引、慢查詢、分頁、N+1、批次寫入與效能優化 |
| 04 | [04-high-concurrency-ticketing-inventory.md](./04-high-concurrency-ticketing-inventory.md) | 高併發搶票、秒殺、庫存扣減、悲觀鎖/樂觀鎖、間隙鎖與死鎖、Redis、MQ 與最終一致性 |

### 第 3 篇：多元資料系統

| 章節 | 檔案 | 主題 |
|------|------|------|
| 05 | [05-redis-caching-design.md](./05-redis-caching-design.md) | Redis 與快取設計：資料結構、Cache Aside、穿透/擊穿/雪崩、排行榜、分散式鎖 |
| 06 | [06-nosql-mongodb-document-modeling.md](./06-nosql-mongodb-document-modeling.md) | NoSQL 設計：MongoDB 文件模型、查詢驅動設計、內嵌 vs 引用、聚合 |
| 07 | [07-search-and-analytics-databases.md](./07-search-and-analytics-databases.md) | 搜尋與分析：Elasticsearch 倒排索引、ClickHouse 列式儲存、OLTP vs OLAP |

### 第 4 篇：架構、維運與專題

| 章節 | 檔案 | 主題 |
|------|------|------|
| 08 | [08-scaling-replication-partition-sharding.md](./08-scaling-replication-partition-sharding.md) | 架構擴展：讀寫分離、Replication、Partition、Sharding |
| 09 | [09-backup-recovery-security.md](./09-backup-recovery-security.md) | 備份、恢復、安全與權限：PITR、RPO/RTO、最小權限、SQL Injection 防護、加密與審計 |
| 10 | [10-capstone-ticketing-platform.md](./10-capstone-ticketing-platform.md) | Capstone：設計一個演唱會搶票平台 |

---

## 延伸課程

本課的第 05 章只介紹 Redis 在「快取」這個用途上的設計。如果你想把 Redis 當成一個完整的資料系統來掌握，可以接著上這門獨立課程：

| 課程 | 內容 |
|------|------|
| [Redis 完整課程](./redis-course/README.md) | 15 章，涵蓋資料結構選型、單執行緒模型與效能、記憶體與驅逐、持久化、Lua 原子操作、Stream 訊息流、Cluster 架構、監控排錯與生產實踐 |

建議讀完本課第 05 章、建立快取的基本心智模型之後再進入。

---

## 本課教學方式

每章都會包含：

- **學習目標**：先知道這章要解決什麼問題。
- **觀念講解**：用產品場景解釋資料庫概念。
- **實作範例**：給出 schema、SQL、架構或流程。
- **常見錯誤**：說明新手最容易踩到的坑。
- **練習題**：讓你自己設計或查詢。
- **參考解答**：每題都附解法與理由。

## 建議學習路線

第一次學習請照順序：

```text
00 選型與取得
  -> 01 關聯式建模
  -> 02 SQL 與交易
  -> 03 效能優化
  -> 04 高併發搶票
  -> 05 快取
  -> 06 NoSQL
  -> 07 搜尋與分析
  -> 08 擴展架構
  -> 09 備份與安全
  -> 10 期末專題
```

如果你已經會基本 SQL，可以直接從第 01 章的建模開始，再補第 03 與第 04 章。

---

完成後請前往 [00-course-map-database-selection-and-setup.md](./00-course-map-database-selection-and-setup.md)。
