# 第 03 章：索引、查詢效能與資料庫優化

> 資料庫效能優化不是「看到慢就加索引」。
> 正確順序是：先理解查詢模式，再看執行計畫，最後用索引、SQL 改寫、快取、分頁策略或架構拆分來解決問題。
> 這章先從最常見、最有用的效能工具開始：索引與查詢設計。

---

## 3.1 學習目標

完成本章後，你應該可以：

- 說明索引為什麼能加速查詢。
- 設計單欄索引、複合索引、唯一索引、覆蓋索引。
- 理解複合索引的最左前綴原則。
- 使用 `EXPLAIN` 觀察查詢是否使用索引。
- 找出常見索引失效情境。
- 優化慢查詢、分頁、N+1 Query 與批次寫入。
- 知道快取、讀寫分離、分區、分片各自解決什麼問題。

---

## 3.2 為什麼需要索引

假設有一張 `orders` 表，有 1000 萬筆資料：

```sql
CREATE TABLE orders (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  status VARCHAR(30) NOT NULL,
  total_amount NUMERIC(12, 2) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

你要查某個使用者的訂單：

```sql
SELECT id, status, total_amount, created_at
FROM orders
WHERE user_id = 1001
ORDER BY created_at DESC
LIMIT 20;
```

如果沒有索引，資料庫可能要掃描整張表：

```text
看第 1 筆 user_id 是不是 1001
看第 2 筆 user_id 是不是 1001
...
看到第 10000000 筆
```

這叫 full table scan。

如果建立索引：

```sql
CREATE INDEX idx_orders_user_created
ON orders(user_id, created_at DESC);
```

資料庫可以像查字典一樣，快速定位 `user_id = 1001` 的訂單，且已接近需要的排序。

---

## 3.3 B-Tree 索引心智模型

多數關聯式資料庫預設使用 B-Tree 或 B+Tree 索引。

你可以把它想成一本按欄位排序的目錄：

```text
user_id = 1001 -> 對應到某些資料位置
user_id = 1002 -> 對應到某些資料位置
user_id = 1003 -> 對應到某些資料位置
```

索引適合：

- 等值查詢：`WHERE user_id = 1001`
- 範圍查詢：`WHERE created_at >= '2026-01-01'`
- 排序：`ORDER BY created_at`
- JOIN 條件：`ON orders.user_id = users.id`

索引不是免費的：

- 會占磁碟空間。
- 寫入、更新、刪除時也要維護索引。
- 太多索引會拖慢寫入。

所以索引設計要根據查詢模式，而不是每個欄位都加。

---

## 3.4 常見索引類型

### 單欄索引

```sql
CREATE INDEX idx_orders_user_id
ON orders(user_id);
```

適合常用條件：

```sql
SELECT *
FROM orders
WHERE user_id = 1001;
```

### 複合索引

```sql
CREATE INDEX idx_orders_user_status_created
ON orders(user_id, status, created_at DESC);
```

適合：

```sql
SELECT id, total_amount, created_at
FROM orders
WHERE user_id = 1001
  AND status = 'paid'
ORDER BY created_at DESC
LIMIT 20;
```

複合索引的欄位順序很重要，不是把欄位全部放進去就好。

### 唯一索引

```sql
CREATE UNIQUE INDEX idx_users_email_unique
ON users(email);
```

通常你會直接寫成：

```sql
email VARCHAR(255) NOT NULL UNIQUE
```

用途：

- 加速查詢。
- 保證資料唯一性。

### 覆蓋索引 Covering Index

如果查詢需要的欄位都在索引裡，資料庫可能不必回表查完整資料。

範例：

```sql
CREATE INDEX idx_orders_user_status_created_amount
ON orders(user_id, status, created_at DESC, total_amount);
```

查詢：

```sql
SELECT created_at, total_amount
FROM orders
WHERE user_id = 1001
  AND status = 'paid'
ORDER BY created_at DESC
LIMIT 20;
```

因為 `created_at` 與 `total_amount` 都在索引中，資料庫可能只掃索引就能回答。

注意：不要為了覆蓋索引把太多欄位塞進索引，索引會變大，寫入成本會上升。

---

## 3.5 複合索引與最左前綴

假設索引：

```sql
CREATE INDEX idx_orders_user_status_created
ON orders(user_id, status, created_at);
```

可以有效使用的查詢：

```sql
WHERE user_id = 1001
```

```sql
WHERE user_id = 1001
  AND status = 'paid'
```

```sql
WHERE user_id = 1001
  AND status = 'paid'
  AND created_at >= '2026-01-01'
```

不適合使用這個索引的查詢：

```sql
WHERE status = 'paid'
```

因為它跳過了最左邊的 `user_id`。

可以用電話簿理解：

```text
電話簿按照：姓氏 -> 名字 -> 生日 排序
```

你可以快速查：

- 姓王的人。
- 姓王且名字叫小明的人。

但你不能快速查：

- 名字叫小明的人。

因為電話簿不是先按名字排序。

---

## 3.6 索引欄位順序怎麼排

常見原則：

1. 等值條件放前面。
2. 範圍條件通常放後面。
3. 排序欄位要搭配查詢方向。
4. 選擇性高的欄位通常更適合放前面，但要以實際查詢為準。

範例查詢：

```sql
SELECT id, total_amount, created_at
FROM orders
WHERE user_id = 1001
  AND status = 'paid'
  AND created_at >= '2026-01-01'
ORDER BY created_at DESC
LIMIT 20;
```

建議索引：

```sql
CREATE INDEX idx_orders_user_status_created
ON orders(user_id, status, created_at DESC);
```

理由：

- `user_id` 是等值條件。
- `status` 是等值條件。
- `created_at` 是範圍與排序。

---

## 3.7 使用 EXPLAIN

不同資料庫語法略有差異。

PostgreSQL：

```sql
EXPLAIN ANALYZE
SELECT id, status, total_amount, created_at
FROM orders
WHERE user_id = 1001
ORDER BY created_at DESC
LIMIT 20;
```

MySQL：

```sql
EXPLAIN
SELECT id, status, total_amount, created_at
FROM orders
WHERE user_id = 1001
ORDER BY created_at DESC
LIMIT 20;
```

你要觀察：

- 是否 full table scan。
- 是否使用預期索引。
- 掃描多少 rows。
- 是否需要額外排序。
- 實際耗時。

PostgreSQL 可能看到：

```text
Index Scan using idx_orders_user_created on orders
```

這代表有使用索引。

如果看到：

```text
Seq Scan on orders
```

代表 sequence scan，也就是掃表。掃表不一定永遠錯，但在大表與高頻查詢上通常要警覺。

---

## 3.8 常見索引失效情境

### 情境 1：對欄位做函式運算

假設有索引：

```sql
CREATE INDEX idx_orders_created_at
ON orders(created_at);
```

不佳：

```sql
SELECT *
FROM orders
WHERE DATE(created_at) = '2026-07-03';
```

因為每筆資料都要先算 `DATE(created_at)`。

較好：

```sql
SELECT *
FROM orders
WHERE created_at >= '2026-07-03 00:00:00'
  AND created_at < '2026-07-04 00:00:00';
```

### 情境 2：LIKE 前綴萬用字元

有索引：

```sql
CREATE INDEX idx_users_email
ON users(email);
```

可能可用索引：

```sql
WHERE email LIKE 'alice%'
```

通常難以有效使用 B-Tree 索引：

```sql
WHERE email LIKE '%example.com'
```

如果需求是全文搜尋或任意字串搜尋，應考慮 full-text index 或搜尋引擎。

### 情境 3：型別不一致

欄位是字串：

```sql
phone VARCHAR(30)
```

查詢卻寫：

```sql
WHERE phone = 912345678
```

資料庫可能需要做型別轉換，影響索引使用。

較好：

```sql
WHERE phone = '0912345678'
```

### 情境 4：低選擇性欄位單獨建索引

例如：

```sql
published BOOLEAN
```

如果 99% 課程都是 `published = TRUE`，單獨對 `published` 建索引通常幫助有限。

更常見是放進複合索引：

```sql
CREATE INDEX idx_courses_published_created
ON courses(published, created_at DESC);
```

適合：

```sql
SELECT id, title
FROM courses
WHERE published = TRUE
ORDER BY created_at DESC
LIMIT 20;
```

---

## 3.9 慢查詢優化流程

不要一開始就改 SQL。建議流程：

```text
1. 確認慢在哪個查詢
2. 看資料量與查詢頻率
3. 使用 EXPLAIN / EXPLAIN ANALYZE
4. 判斷是否掃表、排序、JOIN 成本過高
5. 調整索引或改寫查詢
6. 壓測或觀察實際效果
7. 如果仍不足，再考慮快取、讀寫分離、分區、分片
```

### 範例：訂單列表很慢

原查詢：

```sql
SELECT id, status, total_amount, created_at
FROM orders
WHERE user_id = 1001
ORDER BY created_at DESC
LIMIT 20;
```

如果 EXPLAIN 顯示掃表，加入索引：

```sql
CREATE INDEX idx_orders_user_created
ON orders(user_id, created_at DESC);
```

改善點：

- `WHERE user_id = 1001` 能快速定位。
- `ORDER BY created_at DESC` 可利用索引順序。
- `LIMIT 20` 可以很快停止，不用排序整批資料。

---

## 3.10 分頁優化

### OFFSET 分頁問題

常見寫法：

```sql
SELECT id, title, created_at
FROM posts
ORDER BY created_at DESC
LIMIT 20 OFFSET 100000;
```

問題：

- 資料庫仍要跳過前 100000 筆。
- offset 越大越慢。
- 高頻列表查詢會造成壓力。

### 游標分頁 Cursor Pagination

改用上一頁最後一筆的排序鍵。

第一頁：

```sql
SELECT id, title, created_at
FROM posts
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

下一頁：

```sql
SELECT id, title, created_at
FROM posts
WHERE (created_at, id) < ('2026-07-03 10:00:00', 5000)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

建議索引：

```sql
CREATE INDEX idx_posts_created_id
ON posts(created_at DESC, id DESC);
```

優點：

- 深頁仍然穩定。
- 適合無限捲動、訂單列表、訊息列表。

缺點：

- 不適合「直接跳到第 500 頁」。
- 前端需要保存 cursor。

---

## 3.11 N+1 Query

假設要顯示 20 篇文章與作者名稱。

錯誤流程：

```text
SELECT * FROM posts LIMIT 20;

對每篇文章：
  SELECT * FROM users WHERE id = post.author_id;
```

總共 1 + 20 次查詢，這叫 N+1 Query。

如果列表 100 筆，就是 101 次查詢。

### 解法 1：JOIN

```sql
SELECT
  p.id,
  p.title,
  u.name AS author_name
FROM posts p
JOIN users u ON u.id = p.author_id
ORDER BY p.created_at DESC
LIMIT 20;
```

### 解法 2：批次查詢

先查文章：

```sql
SELECT id, title, author_id
FROM posts
ORDER BY created_at DESC
LIMIT 20;
```

再一次查所有作者：

```sql
SELECT id, name
FROM users
WHERE id IN (1, 2, 3, 4, 5);
```

適合：

- ORM 場景。
- 需要分開組裝資料。
- JOIN 會造成資料重複太多時。

---

## 3.12 批次寫入

逐筆寫入：

```sql
INSERT INTO events (user_id, event_name, created_at)
VALUES (1, 'click', CURRENT_TIMESTAMP);

INSERT INTO events (user_id, event_name, created_at)
VALUES (2, 'view', CURRENT_TIMESTAMP);
```

如果有 10000 筆，逐筆送 10000 次會很慢。

批次寫入：

```sql
INSERT INTO events (user_id, event_name, created_at)
VALUES
  (1, 'click', CURRENT_TIMESTAMP),
  (2, 'view', CURRENT_TIMESTAMP),
  (3, 'purchase', CURRENT_TIMESTAMP);
```

優點：

- 減少網路 round trip。
- 減少交易提交成本。
- 提高吞吐量。

注意：

- 單批不要無限大，避免 SQL 太長或鎖時間太久。
- 可依資料庫與業務測試，例如每批 500、1000、5000 筆。

---

## 3.13 寫入效能與索引數量

索引加速讀取，但拖慢寫入。

每新增一筆 `orders`：

```text
1. 寫入 orders 表資料
2. 更新 primary key index
3. 更新 user_id index
4. 更新 status index
5. 更新 created_at index
6. 更新其他索引
```

所以不要對每個欄位都建索引。

評估索引時問：

- 這個查詢是否高頻？
- 這個查詢是否慢？
- 這個欄位選擇性是否足夠？
- 是否已有複合索引可以支援？
- 這張表寫入是否很頻繁？

---

## 3.14 快取

快取用來降低資料庫讀取壓力。

最常見模式：Cache Aside。

```text
1. API 收到查商品詳情請求
2. 先查 Redis：product:1001
3. Redis 有資料：直接回傳
4. Redis 沒資料：查 DB
5. DB 查到後寫回 Redis，設定 TTL
6. 回傳結果
```

範例 key：

```text
product:1001
```

快取不是萬靈丹。它帶來新問題：

- 快取與資料庫不一致。
- 快取穿透。
- 快取擊穿。
- 快取雪崩。
- 資料更新時要刪快取還是更新快取。

本課後續會用獨立章節深入 Redis 與快取。

---

## 3.15 讀寫分離

當讀取壓力高於寫入時，可以使用主從架構：

```text
Primary DB：處理寫入
Replica DB：處理讀取
```

優點：

- 分散讀取壓力。
- 報表或後台查詢可以走 replica。

缺點：

- 主從有延遲。
- 剛寫入的資料不一定立刻在 replica 可見。
- 程式要知道哪些查詢可以接受延遲。

例子：

```text
使用者剛下訂單後的「訂單成功頁」應查 primary。
後台每日訂單列表可以查 replica。
```

---

## 3.16 分區與分片

### Partition：同一資料庫內分區

例如訂單表按月份分區：

```text
orders_2026_01
orders_2026_02
orders_2026_03
```

適合：

- 大表依時間查詢。
- 舊資料歸檔。
- 刪除整個月份資料。

### Sharding：分散到不同資料庫或節點

例如依照 `user_id`：

```text
shard = user_id % 16
```

適合：

- 單庫已無法承受資料量或寫入壓力。
- 需要水平擴展。

代價：

- 跨 shard 查詢困難。
- 交易變複雜。
- 分片鍵選錯會造成資料傾斜。
- 維運與程式複雜度大幅上升。

實務建議：

```text
先做好 schema、索引、SQL、快取、讀寫分離。
真的遇到單庫瓶頸，再仔細評估分片。
```

---

## 3.17 常見錯誤

### 錯誤 1：看到慢就加索引

加錯索引不但沒幫助，還會拖慢寫入。

正確做法：

```text
先 EXPLAIN，再根據查詢模式設計索引。
```

### 錯誤 2：建立很多單欄索引，卻忽略複合查詢

查詢：

```sql
WHERE user_id = 1001
  AND status = 'paid'
ORDER BY created_at DESC
```

比起分別建立：

```sql
CREATE INDEX idx_orders_user_id ON orders(user_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created_at ON orders(created_at);
```

通常更適合：

```sql
CREATE INDEX idx_orders_user_status_created
ON orders(user_id, status, created_at DESC);
```

### 錯誤 3：用 OFFSET 做深分頁

`OFFSET 1000000` 不會因為你只取 20 筆就便宜。資料庫仍要先跳過大量資料。

列表、訊息、訂單紀錄，優先考慮 cursor pagination。

### 錯誤 4：用報表查詢打主庫

大量 `GROUP BY`、大範圍掃描、複雜統計如果直接打主交易庫，可能影響正常下單與使用者操作。

解法：

- replica。
- ETL 到分析型資料庫。
- 預聚合表。
- 排程產出報表。

---

## 3.18 本章練習

### 練習 1：為訂單列表設計索引

查詢：

```sql
SELECT id, status, total_amount, created_at
FROM orders
WHERE user_id = 1001
  AND status = 'paid'
ORDER BY created_at DESC
LIMIT 20;
```

請設計索引。

#### 參考解答

```sql
CREATE INDEX idx_orders_user_status_created
ON orders(user_id, status, created_at DESC);
```

理由：

- `user_id` 是等值條件，且通常能大幅縮小範圍。
- `status` 也是等值條件。
- `created_at DESC` 支援排序與 `LIMIT 20`。
- 這個索引比單獨建立三個索引更貼近查詢模式。

### 練習 2：修正日期查詢

目前有索引：

```sql
CREATE INDEX idx_orders_created_at
ON orders(created_at);
```

慢查詢：

```sql
SELECT *
FROM orders
WHERE DATE(created_at) = '2026-07-03';
```

請改寫。

#### 參考解答

```sql
SELECT *
FROM orders
WHERE created_at >= '2026-07-03 00:00:00'
  AND created_at < '2026-07-04 00:00:00';
```

理由：

- 不對欄位做函式運算。
- 直接使用 `created_at` 範圍，較容易使用索引。
- 也能正確涵蓋當天所有時間。

### 練習 3：把 OFFSET 分頁改成游標分頁

原查詢：

```sql
SELECT id, title, created_at
FROM posts
ORDER BY created_at DESC
LIMIT 20 OFFSET 100000;
```

上一頁最後一筆資料：

```text
created_at = 2026-07-03 10:00:00
id = 5000
```

請改寫成 cursor pagination。

#### 參考解答

```sql
SELECT id, title, created_at
FROM posts
WHERE (created_at, id) < ('2026-07-03 10:00:00', 5000)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

建議索引：

```sql
CREATE INDEX idx_posts_created_id
ON posts(created_at DESC, id DESC);
```

理由：

- 用 `(created_at, id)` 避免多筆資料有相同 `created_at` 時排序不穩。
- 深頁不用跳過大量資料。

### 練習 4：解決 N+1 Query

需求：

顯示最新 20 篇文章與作者名稱。

目前流程：

```text
SELECT id, title, author_id FROM posts ORDER BY created_at DESC LIMIT 20;
對每篇文章執行 SELECT name FROM users WHERE id = ?
```

請改成一個 SQL。

#### 參考解答

```sql
SELECT
  p.id,
  p.title,
  u.name AS author_name,
  p.created_at
FROM posts p
JOIN users u ON u.id = p.author_id
ORDER BY p.created_at DESC
LIMIT 20;
```

建議索引：

```sql
CREATE INDEX idx_posts_created_at
ON posts(created_at DESC);
```

理由：

- 用 JOIN 一次查出文章與作者。
- 避免 1 + N 次資料庫 round trip。
- `posts.created_at` 索引支援最新文章排序。

### 練習 5：判斷是否該加索引

欄位：

```sql
published BOOLEAN NOT NULL DEFAULT FALSE
```

資料分布：

```text
100 萬門課程中，99 萬門 published = TRUE
```

查詢：

```sql
SELECT id, title
FROM courses
WHERE published = TRUE;
```

是否應該只對 `published` 建單欄索引？

#### 參考解答

通常不建議只對 `published` 建單欄索引。

理由：

- `published = TRUE` 命中 99% 資料，選擇性太低。
- 使用索引後仍要讀大量資料，不一定比掃表划算。

如果實際查詢是首頁最新上架課程：

```sql
SELECT id, title
FROM courses
WHERE published = TRUE
ORDER BY created_at DESC
LIMIT 20;
```

較適合：

```sql
CREATE INDEX idx_courses_published_created
ON courses(published, created_at DESC);
```

因為它支援條件、排序與 `LIMIT`。

---

## 3.19 驗收清單

- [ ] 我能說明索引加速查詢的原因與代價。
- [ ] 我能設計單欄索引與複合索引。
- [ ] 我理解最左前綴原則。
- [ ] 我知道 `EXPLAIN` 可以幫助判斷是否使用索引。
- [ ] 我能修正常見索引失效查詢。
- [ ] 我知道 OFFSET 深分頁的問題與 cursor pagination 的寫法。
- [ ] 我能辨識 N+1 Query。
- [ ] 我知道快取、讀寫分離、分區、分片各自解決不同層級的問題。

---

完成後請前往 [04-high-concurrency-ticketing-inventory.md](./04-high-concurrency-ticketing-inventory.md)。
