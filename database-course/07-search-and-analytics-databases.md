# 第 07 章：搜尋與分析資料庫（Elasticsearch 與 ClickHouse）

> 兩件事關聯式資料庫做得很痛苦：**全文搜尋**與**海量分析**。
> `LIKE '%關鍵字%'` 撐不起商品搜尋，`GROUP BY` 掃十億筆會拖垮主庫。
> 這章介紹兩種專用資料庫：Elasticsearch（搜尋）與 ClickHouse（分析），並講清楚它們如何與主庫分工、資料怎麼同步。

---

## 7.1 學習目標

完成本章後，你應該可以：

- 說明為什麼全文搜尋不該用 `LIKE`，該用搜尋引擎。
- 理解倒排索引（inverted index）為什麼快。
- 用 Elasticsearch 建立索引、寫入與查詢文件。
- 說明 OLTP 與 OLAP 的差異，以及列式儲存為什麼適合分析。
- 用 ClickHouse 思維設計分析表。
- 設計「主庫 + 搜尋/分析庫」的資料同步流程，並理解其一致性取捨。

---

## 7.2 為什麼不用 `LIKE` 做搜尋

假設商品搜尋用：

```sql
SELECT * FROM products WHERE name LIKE '%無線 鍵盤%';
```

問題：

1. **前置萬用字元無法走索引**：`%關鍵字` 開頭的模糊查詢，B-Tree 索引幫不上忙，等於全表掃描（第 03 章講過）。
2. **不懂語意**：搜「鍵盤」找不到「keyboard」；搜「無線 鍵盤」不會自動拆成兩個詞去匹配。
3. **不會排相關度**：`LIKE` 只有「有沒有包含」，沒有「哪一筆最相關」。
4. **不支援錯字容忍、同義詞、權重**：使用者打錯字就搜不到。

搜尋引擎（Elasticsearch、OpenSearch、Meilisearch）專門解決這些問題。

---

## 7.3 倒排索引：搜尋引擎快的原因

關聯式索引是「文件 → 內容」。搜尋引擎用的是**倒排索引（inverted index）**：「詞 → 哪些文件包含它」。

流程分兩步：

### 1. 分詞（Analysis / Tokenization）

寫入時把文字拆成詞：

```text
"無線機械鍵盤" → ["無線", "機械", "鍵盤"]
"Wireless Keyboard" → ["wireless", "keyboard"]
```

### 2. 建倒排索引

```text
"鍵盤"   → [doc1, doc5, doc9]
"無線"   → [doc1, doc3]
"機械"   → [doc1, doc7]
```

查「無線 鍵盤」時，引擎去查這兩個詞各自的文件清單，取交集或並集，再依相關度（例如 BM25 演算法）排序。

這就是為什麼搜尋引擎能在幾百萬文件裡毫秒級找到最相關結果——它不掃全部資料，而是查「詞的清單」。

---

## 7.4 取得與啟動 Elasticsearch

```bash
docker run --name course-es -p 9200:9200 \
  -e "discovery.type=single-node" \
  -e "xpack.security.enabled=false" \
  -d docker.elastic.co/elasticsearch/elasticsearch:8.13.0
```

測試：

```bash
curl http://localhost:9200
```

回傳叢集資訊 JSON 即代表可用。

---

## 7.5 Elasticsearch 基本操作

### 建立索引與 mapping

mapping 類似 schema，定義欄位型別與分詞方式。

```json
PUT /products
{
  "mappings": {
    "properties": {
      "name":        { "type": "text" },
      "description": { "type": "text" },
      "category":    { "type": "keyword" },
      "price":       { "type": "integer" },
      "created_at":  { "type": "date" }
    }
  }
}
```

`text` vs `keyword` 的關鍵差別：

- `text`：會分詞，用於**全文搜尋**（`name`、`description`）。
- `keyword`：不分詞，整個值當一個 token，用於**精確過濾、排序、聚合**（`category`、狀態、標籤）。

搞混這兩個是新手最常見的錯誤：把 `category` 設成 `text` 會導致無法精確過濾與聚合。

### 寫入文件

```json
POST /products/_doc/1001
{
  "name": "無線機械鍵盤",
  "description": "藍牙連線，茶軸，75% 配列",
  "category": "keyboard",
  "price": 2990,
  "created_at": "2026-07-01"
}
```

### 全文搜尋

```json
GET /products/_search
{
  "query": {
    "multi_match": {
      "query": "無線 鍵盤",
      "fields": ["name^3", "description"]
    }
  }
}
```

`name^3` 代表 name 欄位權重是 description 的 3 倍——命中標題比命中內文更相關。

### 全文搜尋 + 過濾 + 排序（電商常見）

```json
GET /products/_search
{
  "query": {
    "bool": {
      "must":   [ { "match": { "name": "鍵盤" } } ],
      "filter": [
        { "term":  { "category": "keyboard" } },
        { "range": { "price": { "gte": 1000, "lte": 3000 } } }
      ]
    }
  },
  "sort": [ { "price": "asc" } ]
}
```

重點：

- `must`：影響相關度評分的查詢（全文搜尋放這）。
- `filter`：只做「符不符合」的布林判斷，不算分，且可被快取，效能好（分類、價格區間、狀態放這）。

**心智模型**：`must` 回答「多相關」，`filter` 回答「符不符合」。

### 聚合（做搜尋結果的分面統計）

```json
GET /products/_search
{
  "size": 0,
  "aggs": {
    "by_category": {
      "terms": { "field": "category" }
    }
  }
}
```

這會回傳「每個分類各有幾件商品」，就是電商左側「分類 (128)、品牌 (56)」那種 facet。

---

## 7.6 主庫 + 搜尋庫的分工與同步

**Elasticsearch 不該當事實來源。** 商品的權威資料在 MySQL/PostgreSQL，Elasticsearch 只是「可搜尋的副本」。

典型架構：

```text
寫入：後台修改商品 → 寫入 MySQL（事實來源）→ 同步到 Elasticsearch（可搜尋副本）
查詢：搜尋走 Elasticsearch → 拿到商品 ID → 詳情可再回 MySQL 或直接用 ES 的資料
```

### 同步方式

1. **雙寫（Dual Write）**：應用程式寫 DB 後，同步呼叫 ES 寫入。
   - 簡單，但兩邊可能不一致（寫 DB 成功、寫 ES 失敗）。需要重試與補償。

2. **非同步隊列**：寫 DB 後發一則訊息到 MQ，消費者去更新 ES。
   - 解耦、可重試，但有延遲（最終一致）。

3. **CDC（Change Data Capture）**：監聽資料庫 binlog（如 Debezium），自動把變更同步到 ES。
   - 對應用程式最無侵入，是大型系統常見做法。

### 一致性取捨

搜尋結果本來就允許「幾秒延遲」——商品剛改價，搜尋結果晚幾秒更新通常可接受。所以搜尋庫走**最終一致**是合理的，不需要強一致。這點和第 05 章快取、第 06 章冗餘的思路一致：**能接受延遲的地方，用最終一致換效能與擴展性。**

---

## 7.7 OLTP vs OLAP：分析為什麼要另一種資料庫

第 00 章提過 OLTP 與 OLAP，這裡深入「為什麼儲存方式不同」。

| 面向 | OLTP（MySQL/PostgreSQL） | OLAP（ClickHouse/BigQuery） |
|------|--------------------------|------------------------------|
| 典型操作 | 查/改單筆或少量列 | 掃描海量列做聚合 |
| 查詢範例 | 查這張訂單 | 統計過去一年每月營收 |
| 儲存方式 | 列式（row-based） | 列欄式（columnar） |
| 寫入 | 高頻單筆 | 批次大量匯入 |
| 索引 | B-Tree | 稀疏索引、排序鍵 |

### 行式儲存 vs 列式儲存

假設 `events` 有 20 個欄位、10 億筆。你要算「過去一年每天的事件數」，只需要 `created_at` 一個欄位。

**行式儲存（OLTP）**：資料一列一列連續存放。要讀 `created_at`，硬碟得把每一列的全部 20 個欄位都讀進來再丟掉 19 個。浪費大量 I/O。

```text
[id,ts,type,user,...20欄] [id,ts,type,user,...20欄] ...
```

**列式儲存（OLAP）**：同一欄的資料連續存放。要算 `created_at`，只讀 `created_at` 這一整欄，其他欄完全不碰。而且同一欄型別相同、值相近，壓縮率極高。

```text
所有 id 連續 | 所有 ts 連續 | 所有 type 連續 | ...
```

這就是 ClickHouse 掃十億筆還能很快的根本原因：**分析查詢通常只碰少數欄位，列式儲存讓它只讀需要的欄。**

---

## 7.8 ClickHouse 思維與範例

### 取得

```bash
docker run --name course-ch -p 8123:8123 -p 9000:9000 -d clickhouse/clickhouse-server:24.3
docker exec -it course-ch clickhouse-client
```

### 建立分析表

```sql
CREATE TABLE events
(
    event_date  Date,
    event_time  DateTime,
    user_id     UInt64,
    event_type  LowCardinality(String),
    page        String,
    duration_ms UInt32
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(event_date)
ORDER BY (event_date, event_type, user_id);
```

幾個 OLAP 特有的設計點：

- `MergeTree`：ClickHouse 主力引擎，為大量寫入與掃描優化。
- `PARTITION BY toYYYYMM(event_date)`：按月分區，查某月資料時只掃該分區，也方便刪整月舊資料（呼應第 03 章的分區概念）。
- `ORDER BY (...)`：決定資料在磁碟的物理排序，也是稀疏索引依據。查詢條件貼合排序鍵時掃描量最小。
- `LowCardinality(String)`：欄位不同值很少（如 event_type 只有數十種）時，用字典編碼大幅節省空間、加速。

### 分析查詢

```sql
-- 過去一年每月事件數與獨立使用者數
SELECT
    toYYYYMM(event_date) AS month,
    count() AS events,
    uniq(user_id) AS unique_users
FROM events
WHERE event_date >= '2025-07-01'
GROUP BY month
ORDER BY month;
```

`uniq()` 是近似去重計數，用極少記憶體估算基數——這是 OLAP 的典型取捨：**用可接受的近似換巨大的效能提升**。要精確可用 `uniqExact()`，但更貴。

### 為什麼不要在 ClickHouse 做 OLTP

ClickHouse 不擅長：

- 高頻單筆 `UPDATE`/`DELETE`（改一筆代價高）。
- 逐筆即時寫入（適合批次匯入）。
- 強一致交易。

所以它不是拿來取代 MySQL，而是**接收 MySQL 同步過來的資料，專門跑報表與分析**。

---

## 7.9 完整資料架構：一個電商的資料流

把前面幾章串起來，一個成熟電商可能長這樣：

```text
                    ┌─────────────┐
      寫入/交易 ───▶ │ PostgreSQL  │  事實來源：訂單、庫存、使用者（第 01~04 章）
                    └──────┬──────┘
                           │ CDC / MQ 同步
             ┌─────────────┼─────────────┐
             ▼             ▼             ▼
      ┌───────────┐ ┌───────────┐ ┌────────────┐
      │   Redis   │ │Elasticsearch│ │ ClickHouse │
      │ 快取/熱點 │ │  商品搜尋   │ │  報表分析  │
      │ （第05章）│ │ （本章）    │ │ （本章）   │
      └───────────┘ └───────────┘ └────────────┘
```

- 每種資料庫做它最擅長的事。
- PostgreSQL 是唯一事實來源，其他都是可重建的衍生副本。
- 衍生副本走最終一致，換取搜尋與分析的效能與擴展性。

這就是第 00 章「不要什麼都塞進一種資料庫」的完整體現。

---

## 7.10 常見錯誤

### 錯誤 1：把 Elasticsearch 當主資料庫

ES 擅長搜尋，但不適合當事實來源：它的一致性模型、資料持久保證都不是為交易設計的。訂單金額不能只存 ES。

### 錯誤 2：搜尋欄位型別設錯

把要精確過濾/聚合的欄位（分類、狀態）設成 `text`，或把要全文搜尋的欄位設成 `keyword`。動手前先想清楚每個欄位是「搜尋」還是「過濾」。

### 錯誤 3：在 OLTP 主庫跑大報表

大範圍 `GROUP BY`、掃全表的統計直接打主庫，拖慢正常下單。報表應走 replica、預聚合表，或同步到 ClickHouse（呼應第 03 章）。

### 錯誤 4：在 ClickHouse 上做頻繁 UPDATE

想在 ClickHouse 上像 MySQL 一樣改單筆資料，會發現又慢又彆扭。ClickHouse 的資料應該是「寫入後基本不改」的分析資料。

### 錯誤 5：忘了同步會延遲，就當它強一致

用 CDC/MQ 同步的搜尋庫、分析庫都是最終一致。「使用者剛下的訂單，報表要立刻出現」這種需求不該依賴分析庫即時性。

---

## 7.11 本章練習

### 練習 1：為什麼商品搜尋不用 LIKE

用自己的話說明，`WHERE name LIKE '%機械鍵盤%'` 做商品搜尋有哪些問題，Elasticsearch 如何解決。

#### 參考解答

`LIKE` 的問題：

- 前置 `%` 無法走索引，等於全表掃描，資料一多就慢。
- 只做字面包含，不分詞、不懂同義詞、不容錯字（打錯就搜不到）。
- 沒有相關度排序，無法把「最相關」的排前面。

Elasticsearch 的解法：

- 用倒排索引（詞 → 文件清單），查詞的清單而非掃全表，毫秒級回應。
- 寫入時分詞，查詢時也分詞，能匹配「無線 鍵盤」拆詞、同義詞、容錯。
- 用 BM25 等演算法對結果排相關度，可對欄位設權重（標題比內文重要）。

### 練習 2：設計商品搜尋的 mapping

商品要支援：對 `title`、`description` 全文搜尋；對 `brand`、`category` 精確過濾與統計數量；對 `price` 做區間過濾與排序；記錄 `created_at`。請寫出 mapping 並說明型別選擇。

#### 參考解答

```json
PUT /products
{
  "mappings": {
    "properties": {
      "title":       { "type": "text" },
      "description": { "type": "text" },
      "brand":       { "type": "keyword" },
      "category":    { "type": "keyword" },
      "price":       { "type": "integer" },
      "created_at":  { "type": "date" }
    }
  }
}
```

型別選擇：

- `title`、`description` → `text`：需要分詞做全文搜尋。
- `brand`、`category` → `keyword`：需要精確過濾（`term`）和聚合統計數量（分面），不能分詞。
- `price` → `integer`：支援 `range` 區間過濾與排序。
- `created_at` → `date`：時間範圍查詢與排序。

### 練習 3：判斷 OLTP 還是 OLAP，該用哪個庫

1. 使用者點進商品頁，查這個商品的即時庫存。
2. 營運每天早上看昨天各分類的銷售額與獨立買家數。
3. 使用者查自己的歷史訂單列表。
4. 分析過去兩年、每個小時的網站流量趨勢。

#### 參考解答

1. OLTP，用 PostgreSQL/MySQL。單筆即時查詢、要最新值。

2. OLAP，用 ClickHouse/BigQuery。大範圍聚合、可接受隔天資料、不影響主庫。

3. OLTP，用 PostgreSQL/MySQL（配合第 03 章的索引與 cursor 分頁）。針對單一使用者的少量資料查詢。

4. OLAP，用 ClickHouse。掃描海量歷史事件、按時間聚合，列式儲存最適合。

### 練習 4：設計同步方案並說明一致性

商品資料在 PostgreSQL，要讓搜尋走 Elasticsearch。請設計同步方式，並說明搜尋結果一致性如何取捨。

#### 參考解答

同步方案（擇一或組合）：

- **CDC**：用 Debezium 監聽 PostgreSQL 的 WAL/binlog，商品一有變更就自動推送到 ES。對應用最無侵入，推薦大型系統採用。
- **MQ 非同步**：應用寫完 DB 發一則「商品變更」訊息，消費者更新 ES。解耦、可重試。
- **雙寫**：寫 DB 後直接寫 ES。最簡單，但要處理「DB 成功、ES 失敗」的補償與重試，否則會不一致。

一致性取捨：

- PostgreSQL 是事實來源，ES 是可重建的搜尋副本。
- 採**最終一致**即可：商品改價後，搜尋結果晚幾秒更新是可接受的。
- 不需要為搜尋庫追求強一致，那會犧牲效能與擴展性，且沒有業務必要。
- 需要「絕對最新」的地方（例如結帳當下的價格與庫存）應回 PostgreSQL 查，不依賴 ES。

---

## 7.12 驗收清單

- [ ] 我能說明為什麼全文搜尋不該用 `LIKE`。
- [ ] 我理解倒排索引「詞 → 文件」的運作方式。
- [ ] 我會用 Elasticsearch 建 mapping、寫入、做 `must`/`filter` 查詢與聚合。
- [ ] 我知道 `text` 與 `keyword` 的差別與用途。
- [ ] 我能解釋列式儲存為什麼適合分析查詢。
- [ ] 我知道搜尋庫、分析庫都是主庫的衍生副本，走最終一致。

---

完成後請前往 [08-scaling-replication-partition-sharding.md](./08-scaling-replication-partition-sharding.md)。
