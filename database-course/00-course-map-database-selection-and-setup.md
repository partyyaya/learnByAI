# 第 00 章：資料庫選型與取得

> 學資料庫最常見的錯誤，是一開始就問「MySQL 指令怎麼寫」。
> 真實專案裡，第一個問題應該是：**這份資料的形狀、查詢方式、一致性要求、成長速度，適合哪一種資料庫？**
> 這章先建立全局地圖，之後再深入 SQL、索引、交易與高併發。

---

## 0.1 學習目標

完成本章後，你應該可以：

- 說明常見資料庫類型：關聯式、文件型、Key-Value、搜尋型、分析型、NewSQL。
- 依照需求判斷應該使用哪種資料庫。
- 分辨 OLTP 與 OLAP 的不同。
- 知道資料庫可以怎麼取得：本機安裝、Docker、雲端託管、Serverless、自建叢集。
- 為一個簡單產品提出合理的資料庫組合。

---

## 0.2 資料庫不是只有一種

資料庫的本質是「讓資料能被可靠地儲存與查詢」。但不同系統的資料差異很大：

- 銀行轉帳：最重要的是不能多扣、不能少扣，需要強一致性。
- 商品搜尋：最重要的是關鍵字、排序、篩選、模糊查詢。
- 直播聊天室：最重要的是大量寫入與按時間拉取訊息。
- 熱門文章排行：最重要的是快速更新分數與快速取 Top N。
- BI 報表：最重要的是掃描大量歷史資料並做聚合。

所以沒有一個資料庫能在所有場景都最佳。工程師要做的是：**先理解需求，再選擇資料庫。**

---

## 0.3 常見資料庫類型

### 關聯式資料庫：MySQL、PostgreSQL、SQL Server、Oracle

關聯式資料庫把資料放在表格中，用 row 與 column 表示。

適合：

- 使用者、訂單、付款、庫存、會員權限等結構化資料。
- 需要交易 ACID 的場景。
- 需要複雜 JOIN、報表查詢、資料完整性約束。

不適合：

- 極度彈性的文件資料，例如每筆商品欄位都差很多。
- 單純需要極高吞吐量的快取。
- 大規模全文搜尋。

範例：電商訂單資料

```sql
CREATE TABLE orders (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  status VARCHAR(30) NOT NULL,
  total_amount NUMERIC(12, 2) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

為什麼適合放關聯式資料庫？

- 訂單欄位固定。
- 訂單與使用者、付款、出貨有明確關係。
- 建立訂單與扣庫存常常需要交易。

### 文件型資料庫：MongoDB、CouchDB

文件型資料庫通常用 JSON-like document 儲存資料。

適合：

- 欄位彈性高的資料。
- 一筆資料常常整份讀出，而不是頻繁 JOIN。
- 內容管理、商品規格、事件紀錄、聊天訊息。

不適合：

- 高度依賴跨表交易的核心金流。
- 關聯複雜且需要大量 JOIN 的系統。

範例：商品規格

```json
{
  "product_id": "p_1001",
  "name": "機械鍵盤",
  "category": "keyboard",
  "attributes": {
    "switch": "brown",
    "layout": "75%",
    "bluetooth": true,
    "battery_mah": 4000
  }
}
```

為什麼商品規格可以考慮 MongoDB？

- 不同商品的屬性差異很大。
- 鍵盤有軸體、配置，衣服有尺寸、材質，手機有容量、鏡頭。
- 若硬塞進關聯式資料庫，可能會出現大量 nullable column 或 EAV 設計，查詢與維護都變複雜。

### Key-Value 資料庫：Redis、Memcached

Key-Value 資料庫用一個 key 對應一份 value，通常非常快。

適合：

- 快取。
- Session。
- 排行榜。
- 限流計數器。
- 搶票、秒殺時的庫存預扣。

不適合：

- 作為唯一的長期核心資料庫。
- 複雜查詢與多表關聯。

範例：商品快取

```text
Key: product:1001
Value: {"id":1001,"name":"機械鍵盤","price":2990}
TTL: 300 seconds
```

Redis 的核心角色通常不是取代 MySQL，而是幫 MySQL 擋住大量重複讀取。

### 搜尋型資料庫：Elasticsearch、OpenSearch、Meilisearch

搜尋型資料庫擅長全文搜尋、模糊查詢、排序與條件篩選。

適合：

- 商品搜尋。
- 文章搜尋。
- 日誌搜尋。
- 多條件篩選，例如品牌、價格、分類、關鍵字。

不適合：

- 當交易主庫。
- 需要強一致性的金流、庫存、訂單。

範例：搜尋「無線 鍵盤」

```json
{
  "query": {
    "multi_match": {
      "query": "無線 鍵盤",
      "fields": ["name", "description"]
    }
  }
}
```

實務上常見做法：

```text
MySQL/PostgreSQL：保存商品主資料
Elasticsearch：保存可搜尋的商品索引
```

商品更新時，先更新主庫，再同步到搜尋索引。

### 分析型資料庫：ClickHouse、BigQuery、Snowflake、Redshift

分析型資料庫擅長掃描大量資料並聚合。

適合：

- 每日營收報表。
- 使用者行為分析。
- 廣告點擊統計。
- 大量 log 分析。

不適合：

- 高頻單筆更新。
- 建立訂單這類 OLTP 寫入。

範例：統計每日營收

```sql
SELECT
  DATE(created_at) AS order_date,
  SUM(total_amount) AS revenue
FROM orders
WHERE created_at >= '2026-01-01'
GROUP BY DATE(created_at)
ORDER BY order_date;
```

如果 `orders` 有 30 億筆，傳統 OLTP 資料庫可能吃力。這種報表更適合把資料同步到 ClickHouse 或 BigQuery。

### NewSQL：TiDB、CockroachDB、YugabyteDB

NewSQL 想解決的是：「我想要 SQL 與交易，又想要像分散式系統一樣水平擴展。」

適合：

- 資料量大到單機關聯式資料庫壓力很高。
- 仍然需要 SQL 與交易。
- 跨區、多節點、高可用需求。

不適合：

- 小型專案一開始就導入。
- 團隊沒有分散式資料庫維運能力。

---

## 0.4 選型的核心判斷問題

看到一個需求時，不要先背產品名。先問下面這些問題。

### 問題 1：資料是否高度結構化？

如果欄位固定，例如使用者、訂單、付款，通常優先考慮關聯式資料庫。

如果每筆資料欄位差異很大，例如不同分類商品規格，文件型資料庫可能更自然。

### 問題 2：是否需要強一致性與交易？

如果是金流、庫存、訂單狀態，通常需要關聯式資料庫。

例如轉帳：

```text
A 帳戶扣 100
B 帳戶加 100
```

這兩件事必須一起成功或一起失敗。這就是交易。

### 問題 3：主要查詢模式是什麼？

查詢模式比資料庫品牌更重要。

例如：

- 根據 `user_id` 查使用者訂單：關聯式資料庫 + 索引。
- 根據關鍵字搜尋商品：Elasticsearch。
- 取得排行榜 Top 100：Redis Sorted Set。
- 每天掃描 10 億筆事件做報表：ClickHouse。

### 問題 4：讀多還是寫多？

讀多：

- 可以用快取。
- 可以做讀寫分離。
- 可以用 CDN 或 search index 分擔讀取。

寫多：

- 要注意索引數量。
- 要批次寫入。
- 要考慮分區、分片或 queue 削峰。

### 問題 5：資料量與流量會怎麼成長？

小型內部系統：

- 單一 PostgreSQL 或 MySQL 通常足夠。

大型電商：

- 主庫、從庫、Redis、Elasticsearch、消息隊列、資料倉儲可能都需要。

不要一開始就過度設計，但要知道未來擴展方向。

### 問題 6：團隊熟悉什麼？

技術選型不是只看性能，也要看團隊能力。

如果團隊熟 PostgreSQL，不熟 MongoDB，且需求沒有非 MongoDB 不可，那 PostgreSQL 可能是更好的選擇。

---

## 0.5 OLTP 與 OLAP

這兩個詞非常重要。

### OLTP：Online Transaction Processing

OLTP 是線上交易處理，重點是「大量短小請求」。

常見操作：

- 新增訂單。
- 扣庫存。
- 更新付款狀態。
- 查某個使用者的資料。

特性：

- 單次查詢資料量通常小。
- 很在意交易與一致性。
- 很在意低延遲。

常用資料庫：

- MySQL
- PostgreSQL
- SQL Server
- TiDB

### OLAP：Online Analytical Processing

OLAP 是線上分析處理，重點是「大量資料掃描與聚合」。

常見操作：

- 統計每月營收。
- 分析使用者留存。
- 計算廣告轉換率。
- 查詢大量 log。

特性：

- 單次查詢可能掃描百萬、千萬、上億筆。
- 不一定需要毫秒級回應。
- 重點是聚合效率。

常用資料庫：

- ClickHouse
- BigQuery
- Snowflake
- Redshift

### 範例：同一份訂單資料的兩種用途

建立訂單是 OLTP：

```sql
INSERT INTO orders (user_id, status, total_amount)
VALUES (1001, 'pending', 1290.00);
```

統計年度營收是 OLAP：

```sql
SELECT
  DATE_TRUNC('month', created_at) AS month,
  SUM(total_amount) AS revenue
FROM orders
WHERE created_at >= '2026-01-01'
GROUP BY DATE_TRUNC('month', created_at);
```

同一份資料可能先進 OLTP 主庫，再同步到 OLAP 系統做分析。

---

## 0.6 如何取得資料庫

### 方式 1：本機安裝

適合：

- 剛入門。
- 想快速用 GUI 工具連線。
- 不想先學 Docker。

例子：

```bash
# macOS 使用 Homebrew 安裝 PostgreSQL
brew install postgresql@16
brew services start postgresql@16
```

優點：

- 操作直覺。
- 學習成本低。

缺點：

- 本機環境容易變髒。
- 多版本切換麻煩。
- 團隊很難保證每個人環境一致。

### 方式 2：Docker

適合：

- 課程練習。
- 團隊開發。
- 想快速建立可重現環境。

PostgreSQL 範例：

```bash
docker run --name course-postgres \
  -e POSTGRES_USER=course \
  -e POSTGRES_PASSWORD=coursepass \
  -e POSTGRES_DB=course_db \
  -p 5432:5432 \
  -d postgres:16
```

MySQL 範例：

```bash
docker run --name course-mysql \
  -e MYSQL_ROOT_PASSWORD=rootpass \
  -e MYSQL_DATABASE=course_db \
  -p 3306:3306 \
  -d mysql:8
```

Redis 範例：

```bash
docker run --name course-redis \
  -p 6379:6379 \
  -d redis:7
```

優點：

- 環境容易重建。
- 多個資料庫可以並存。
- 適合寫成 `docker-compose.yml`。

缺點：

- 需要理解 container、volume、port mapping。
- 如果 volume 沒設好，刪 container 可能連資料一起刪掉。

### 方式 3：雲端託管資料庫

常見選項：

- AWS RDS / Aurora
- Google Cloud SQL / AlloyDB
- Azure Database
- Supabase
- Neon
- MongoDB Atlas
- PlanetScale

適合：

- 正式上線產品。
- 團隊不想自己維運備份、升級與高可用。
- 需要快速擴展。

優點：

- 自動備份。
- 監控與告警整合。
- 高可用選項成熟。

缺點：

- 成本可能隨流量快速增加。
- 需要理解雲端網路、安全群組、連線池。
- 部分 Serverless DB 有冷啟動或連線限制。

### 方式 4：自建叢集

適合：

- 大型公司。
- 有專職 DBA / SRE。
- 對成本、法規、網路、資料落地位置有特殊要求。

優點：

- 控制權高。
- 可深度客製。

缺點：

- 維運成本高。
- 備份、升級、故障轉移都要自己處理。
- 不適合多數新手與小團隊一開始採用。

---

## 0.7 選型範例

### 範例 1：個人部落格

需求：

- 文章、作者、分類、留言。
- 查詢文章列表。
- 後台新增與編輯文章。
- 初期流量小。

建議：

```text
主資料庫：PostgreSQL 或 MySQL
搜尋：初期用 SQL LIKE 或 full-text search，長大後再導入 Elasticsearch
快取：初期不需要，流量上來再加 Redis
取得方式：Docker 或 Supabase/Neon
```

理由：

- 資料結構清楚。
- 需要基本關聯，例如文章與作者、文章與分類。
- 不需要一開始就導入太多系統。

### 範例 2：電商平台

需求：

- 使用者、商品、購物車、訂單、付款、庫存。
- 商品關鍵字搜尋。
- 熱門商品快取。
- 營收報表。

建議：

```text
主資料庫：MySQL 或 PostgreSQL
快取：Redis
搜尋：Elasticsearch 或 OpenSearch
分析：ClickHouse 或 BigQuery
取得方式：正式環境使用雲端託管資料庫，開發環境使用 Docker
```

理由：

- 訂單、付款、庫存需要交易。
- 商品搜尋不適合只靠 SQL LIKE。
- 報表查詢不應該壓垮主交易資料庫。

### 範例 3：即時排行榜

需求：

- 使用者分數頻繁更新。
- 快速取得 Top 100。
- 查某個使用者排名。

建議：

```text
排行榜即時資料：Redis Sorted Set
長期紀錄：PostgreSQL 或 MySQL
取得方式：Docker 練習，正式環境可用雲端 Redis
```

Redis Sorted Set 範例：

```bash
ZADD game:ranking 9800 user:1001
ZADD game:ranking 8750 user:1002
ZREVRANGE game:ranking 0 99 WITHSCORES
```

理由：

- Sorted Set 天生適合排序分數。
- 關聯式資料庫也能做排行榜，但高頻更新與 Top N 查詢用 Redis 更簡潔。

### 範例 4：搶票系統

需求：

- 同一時間大量使用者搶有限票券。
- 不能超賣。
- 成功者要建立訂單。
- 失敗者要快速得到結果。

建議：

```text
主資料庫：MySQL 或 PostgreSQL
熱庫存：Redis
削峰：消息隊列，例如 Kafka、RabbitMQ、SQS
防重：Redis / DB unique constraint
取得方式：開發用 Docker，正式用託管 DB + 託管 Redis + 託管 MQ
```

理由：

- MySQL/PostgreSQL 保存最終訂單與庫存。
- Redis 承受瞬間流量與原子扣減。
- Queue 把瞬間流量變成後端可消化的速度。

第 04 章會完整設計這個場景。

---

## 0.8 常見錯誤

### 錯誤 1：所有資料都塞進同一種資料庫

新手常說：「我們就全部用 MySQL。」

小系統可以，但當商品搜尋、排行榜、即時統計、搶票都出現時，只靠 MySQL 會讓設計變得痛苦。

更好的做法：

```text
核心交易資料放 MySQL/PostgreSQL
高頻快取放 Redis
全文搜尋放 Elasticsearch
大量分析放 ClickHouse/BigQuery
```

### 錯誤 2：一開始就上分散式資料庫

另一個極端是：「聽說分散式比較厲害，我們直接用 NewSQL。」

如果團隊沒有維運經驗，需求也還沒到那個規模，分散式資料庫會增加故障排查與學習成本。

### 錯誤 3：只看 benchmark，不看查詢模式

資料庫 A 每秒寫入比資料庫 B 高，不代表它適合你的產品。

你要先問：

- 你的查詢是單筆查詢還是全文搜尋？
- 是否需要交易？
- 是否需要 JOIN？
- 是否要做大量聚合？
- 是否能接受最終一致性？

### 錯誤 4：把 Redis 當唯一資料庫

Redis 很快，但通常不應該承擔唯一真相來源。

正確心智模型：

```text
MySQL/PostgreSQL：事實來源，保存最終正確資料
Redis：加速器，保存可重建、可過期、可預扣的資料
```

---

## 0.9 本章練習

### 練習 1：替線上課程平台選資料庫

需求：

- 使用者註冊與登入。
- 課程、章節、影片。
- 學生購買課程。
- 學生觀看進度。
- 課程關鍵字搜尋。
- 後台統計每日銷售額。

請回答：

1. 主資料庫選什麼？
2. 是否需要 Redis？
3. 搜尋功能用什麼？
4. 銷售報表適合放在哪類資料庫？

#### 參考解答

1. 主資料庫建議 PostgreSQL 或 MySQL。

理由：

- 使用者、課程、購買紀錄、觀看進度都是結構化資料。
- 購買課程涉及付款與訂單，需要交易。
- 課程與章節、學生與購買紀錄有清楚關聯。

2. Redis 初期不一定需要，但中後期建議加入。

可用場景：

- 快取熱門課程詳情。
- 保存登入 session。
- 限制登入嘗試次數。
- 快取首頁推薦課程。

3. 搜尋功能初期可用 PostgreSQL full-text search 或 MySQL full-text index，需求變複雜後導入 Elasticsearch / OpenSearch。

理由：

- 如果只是課程標題搜尋，SQL 可能足夠。
- 如果要支援斷詞、權重、模糊查詢、同義詞、篩選排序，搜尋引擎更適合。

4. 銷售報表可以先從主庫查詢，但資料量大後應同步到 ClickHouse、BigQuery 或資料倉儲。

理由：

- 每日銷售額是分析查詢。
- 報表掃描大量訂單時，不應影響使用者購買流程。

### 練習 2：判斷資料庫類型

請為下列需求選擇適合資料庫：

1. 電商訂單與付款。
2. 熱門文章排行榜。
3. 商品全文搜尋。
4. 每日 5 億筆行為事件分析。
5. 欄位非常彈性的商品規格。

#### 參考解答

1. 電商訂單與付款：MySQL 或 PostgreSQL。

原因：需要交易、一致性與結構化關聯。

2. 熱門文章排行榜：Redis Sorted Set。

原因：分數更新與 Top N 查詢非常適合 Sorted Set。

3. 商品全文搜尋：Elasticsearch 或 OpenSearch。

原因：需要斷詞、全文索引、相關度排序與多條件查詢。

4. 每日 5 億筆行為事件分析：ClickHouse、BigQuery、Snowflake。

原因：這是 OLAP，需要大量掃描與聚合。

5. 欄位非常彈性的商品規格：MongoDB，或 PostgreSQL JSONB。

原因：如果欄位差異很大，文件模型較自然。若團隊已使用 PostgreSQL，也可以先用 JSONB 避免過早引入新系統。

### 練習 3：本機練習環境選擇

你要在自己的電腦練習本課，並且希望之後可以很容易刪掉重建。你會選本機安裝還是 Docker？

#### 參考解答

建議選 Docker。

理由：

- 每個資料庫都能用 container 隔離。
- PostgreSQL、MySQL、Redis 可以同時存在，不容易互相干擾。
- 出錯時可以刪掉 container 重新建立。
- 未來可以把環境寫成 `docker-compose.yml`，讓同學或團隊使用同一套設定。

但如果你完全沒用過 Docker，也可以先本機安裝 PostgreSQL，等第 01、02 章熟悉後再回來補 Docker。

---

## 0.10 驗收清單

- [ ] 我能說明關聯式、文件型、Key-Value、搜尋型、分析型資料庫的差異。
- [ ] 我知道什麼是 OLTP 與 OLAP。
- [ ] 我能根據需求判斷要用哪種資料庫，而不是只背產品名稱。
- [ ] 我知道本機安裝、Docker、雲端託管、自建叢集的取捨。
- [ ] 我能替一個小型產品提出資料庫組合與理由。

---

完成後請前往 [01-relational-modeling-erd-normalization.md](./01-relational-modeling-erd-normalization.md)。
