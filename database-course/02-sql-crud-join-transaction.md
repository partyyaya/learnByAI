# 第 02 章：SQL CRUD、JOIN、聚合與交易

> SQL 是你跟關聯式資料庫溝通的語言。
> 但 SQL 不只是 `SELECT * FROM table`，它同時承載了查詢、寫入、資料約束、交易與一致性。
> 這章會用線上課程平台的資料表，帶你從基本 CRUD 走到 JOIN、聚合與交易。

---

## 2.1 學習目標

完成本章後，你應該可以：

- 使用 `INSERT`、`SELECT`、`UPDATE`、`DELETE` 操作資料。
- 寫出 `WHERE`、`ORDER BY`、`LIMIT`。
- 使用 `INNER JOIN` 與 `LEFT JOIN` 查詢跨表資料。
- 使用 `GROUP BY` 與聚合函式做統計。
- 理解交易的 `BEGIN`、`COMMIT`、`ROLLBACK`。
- 說明 ACID 與隔離級別。
- 用交易保護下單、扣庫存、轉帳等流程。

---

## 2.2 本章使用的資料表

我們使用一個簡化版線上課程平台：

```sql
CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE courses (
  id BIGSERIAL PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  price NUMERIC(10, 2) NOT NULL,
  published BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (price >= 0)
);

CREATE TABLE purchases (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  course_id BIGINT NOT NULL REFERENCES courses(id),
  amount NUMERIC(10, 2) NOT NULL,
  status VARCHAR(30) NOT NULL,
  purchased_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, course_id),
  CHECK (amount >= 0)
);

CREATE TABLE lessons (
  id BIGSERIAL PRIMARY KEY,
  course_id BIGINT NOT NULL REFERENCES courses(id),
  title VARCHAR(200) NOT NULL,
  position INT NOT NULL,
  UNIQUE (course_id, position)
);

CREATE TABLE lesson_progress (
  user_id BIGINT NOT NULL REFERENCES users(id),
  lesson_id BIGINT NOT NULL REFERENCES lessons(id),
  completed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, lesson_id)
);
```

關係圖：

```text
users 1 --- N purchases N --- 1 courses
courses 1 --- N lessons
users 1 --- N lesson_progress N --- 1 lessons
```

---

## 2.3 INSERT：新增資料

新增使用者：

```sql
INSERT INTO users (email, name)
VALUES ('alice@example.com', 'Alice');
```

新增課程：

```sql
INSERT INTO courses (title, price, published)
VALUES
  ('SQL 入門', 1200.00, TRUE),
  ('資料庫效能優化', 1800.00, TRUE),
  ('高併發系統設計', 2500.00, FALSE);
```

PostgreSQL 可以用 `RETURNING` 取得新增後的 ID：

```sql
INSERT INTO users (email, name)
VALUES ('bob@example.com', 'Bob')
RETURNING id, email, name;
```

這對後端 API 很常用，因為建立成功後通常要回傳新資料。

---

## 2.4 SELECT：查詢資料

查詢所有課程：

```sql
SELECT id, title, price, published
FROM courses;
```

查詢已上架課程：

```sql
SELECT id, title, price
FROM courses
WHERE published = TRUE;
```

排序：

```sql
SELECT id, title, price
FROM courses
WHERE published = TRUE
ORDER BY price DESC;
```

限制筆數：

```sql
SELECT id, title, price
FROM courses
WHERE published = TRUE
ORDER BY created_at DESC
LIMIT 10;
```

### 不要濫用 `SELECT *`

開發測試時可以用 `SELECT *`，但正式 API 盡量明確列出欄位：

```sql
SELECT id, title, price
FROM courses;
```

原因：

- 減少不必要資料傳輸。
- 避免未來新增敏感欄位時被 API 意外回傳。
- 查詢意圖更清楚。

---

## 2.5 UPDATE：更新資料

將課程上架：

```sql
UPDATE courses
SET published = TRUE
WHERE id = 3;
```

調整價格：

```sql
UPDATE courses
SET price = 1990.00
WHERE id = 2;
```

PostgreSQL 可以用 `RETURNING` 看更新後結果：

```sql
UPDATE courses
SET price = 1990.00
WHERE id = 2
RETURNING id, title, price;
```

### UPDATE 一定要小心 WHERE

危險：

```sql
UPDATE courses
SET published = FALSE;
```

這會把所有課程都下架。

實務建議：

- 更新前先寫 `SELECT` 確認範圍。
- 後台批次更新要特別小心。
- 重要更新包在交易內。

---

## 2.6 DELETE：刪除資料

刪除一筆觀看進度：

```sql
DELETE FROM lesson_progress
WHERE user_id = 1 AND lesson_id = 10;
```

### 軟刪除 Soft Delete

正式系統常常不真的刪資料，而是加欄位標記刪除。

```sql
ALTER TABLE courses ADD COLUMN deleted_at TIMESTAMP;
```

刪除時：

```sql
UPDATE courses
SET deleted_at = CURRENT_TIMESTAMP
WHERE id = 3;
```

查詢時：

```sql
SELECT id, title, price
FROM courses
WHERE deleted_at IS NULL;
```

適合軟刪除的情境：

- 需要審計紀錄。
- 刪除後可能復原。
- 訂單、付款、課程等重要業務資料。

不適合濫用：

- Log、暫存資料、過期 token 可能直接刪除更合理。
- 所有查詢都要記得加 `deleted_at IS NULL`，否則容易查到已刪資料。

---

## 2.7 JOIN：跨表查詢

單表查詢通常不夠。真正的業務資料分散在多張表，需要 JOIN。

### INNER JOIN

查詢每筆購買紀錄，帶出使用者與課程名稱：

```sql
SELECT
  p.id AS purchase_id,
  u.email,
  u.name AS user_name,
  c.title AS course_title,
  p.amount,
  p.status,
  p.purchased_at
FROM purchases p
INNER JOIN users u ON u.id = p.user_id
INNER JOIN courses c ON c.id = p.course_id;
```

`INNER JOIN` 的意思是：兩邊都對得上的資料才出現。

如果 `purchases.user_id` 找不到對應 user，這筆就不會出現。不過因為 foreign key 存在，正常情況不會發生。

### LEFT JOIN

查詢所有課程，以及購買人數。即使沒人購買也要顯示。

```sql
SELECT
  c.id,
  c.title,
  COUNT(p.id) AS purchase_count
FROM courses c
LEFT JOIN purchases p ON p.course_id = c.id
GROUP BY c.id, c.title
ORDER BY c.id;
```

`LEFT JOIN` 的意思是：左邊資料全部保留，右邊有對到才補上。

如果用 `INNER JOIN`，沒人購買的課程會消失。

### JOIN 常見錯誤：忘記 ON 條件

錯誤：

```sql
SELECT *
FROM users u
JOIN purchases p;
```

這可能造成 Cartesian product，每個 user 都跟每筆 purchase 配一次，資料量爆炸。

正確：

```sql
SELECT *
FROM users u
JOIN purchases p ON p.user_id = u.id;
```

---

## 2.8 GROUP BY 與聚合

常用聚合函式：

- `COUNT`
- `SUM`
- `AVG`
- `MIN`
- `MAX`

### 統計每門課銷售額

```sql
SELECT
  c.id,
  c.title,
  COUNT(p.id) AS purchase_count,
  SUM(p.amount) AS revenue
FROM courses c
LEFT JOIN purchases p
  ON p.course_id = c.id
 AND p.status = 'paid'
GROUP BY c.id, c.title
ORDER BY revenue DESC NULLS LAST;
```

這裡把 `p.status = 'paid'` 放在 `ON` 裡，而不是 `WHERE` 裡，是為了保留沒有銷售的課程。

如果寫成：

```sql
WHERE p.status = 'paid'
```

那沒有購買紀錄的課程會被過濾掉，`LEFT JOIN` 會變得像 `INNER JOIN`。

### 統計每日營收

```sql
SELECT
  DATE(purchased_at) AS purchase_date,
  SUM(amount) AS revenue
FROM purchases
WHERE status = 'paid'
GROUP BY DATE(purchased_at)
ORDER BY purchase_date;
```

這是報表查詢。資料量大後，應考慮同步到分析型資料庫，不要讓報表壓垮主庫。

---

## 2.9 子查詢與 CTE

### 子查詢：找出有購買過課程的使用者

```sql
SELECT id, email, name
FROM users
WHERE id IN (
  SELECT user_id
  FROM purchases
  WHERE status = 'paid'
);
```

### CTE：讓複雜查詢可讀

CTE 是 Common Table Expression，用 `WITH` 宣告暫時結果。

範例：找出每門課的付費人數，再篩選出超過 100 人的課。

```sql
WITH course_sales AS (
  SELECT
    course_id,
    COUNT(*) AS paid_count
  FROM purchases
  WHERE status = 'paid'
  GROUP BY course_id
)
SELECT
  c.id,
  c.title,
  cs.paid_count
FROM course_sales cs
JOIN courses c ON c.id = cs.course_id
WHERE cs.paid_count >= 100
ORDER BY cs.paid_count DESC;
```

CTE 的好處：

- 把複雜查詢拆成步驟。
- 可讀性高。
- 適合報表與分析查詢。

---

## 2.10 交易 Transaction

交易用來保證一組操作要嘛全部成功，要嘛全部失敗。

基本語法：

```sql
BEGIN;

-- 多個 SQL 操作

COMMIT;
```

如果中間出錯：

```sql
ROLLBACK;
```

### 例子：購買課程

需求：

- 建立購買紀錄。
- 金額必須等於課程目前價格。
- 同一使用者不能重複購買同一門課。

```sql
BEGIN;

INSERT INTO purchases (user_id, course_id, amount, status)
SELECT
  1,
  c.id,
  c.price,
  'paid'
FROM courses c
WHERE c.id = 2
  AND c.published = TRUE;

COMMIT;
```

這裡用 `INSERT INTO ... SELECT` 的好處是：

- amount 直接取課程價格，避免後端先查價格再插入時中間價格被改。
- 可加入 `published = TRUE` 保證只能購買已上架課程。

`UNIQUE (user_id, course_id)` 會防止重複購買。

---

## 2.11 ACID

交易的四個特性：

### Atomicity：原子性

一組操作要嘛全部成功，要嘛全部失敗。

轉帳就是典型例子：

```text
A 扣款成功，但 B 沒加款
```

這是不可接受的。

### Consistency：一致性

交易前後資料必須符合規則。

例如：

- 帳戶餘額不能小於 0。
- 訂單總金額不能小於 0。
- 外鍵不能指向不存在的資料。

### Isolation：隔離性

多個交易同時執行時，彼此不能造成不合理干擾。

例如兩個人同時買最後一張票，不能都成功。

### Durability：持久性

交易提交後，即使資料庫重啟，資料也應該保留。

---

## 2.12 隔離級別

交易隔離級別決定「同時執行的交易能看到彼此多少中間狀態」。

常見級別：

- Read Uncommitted
- Read Committed
- Repeatable Read
- Serializable

### Dirty Read：髒讀

讀到別人尚未提交的資料。

例子：

```text
交易 A 把課程價格改成 100，但尚未 commit
交易 B 讀到 100
交易 A rollback
```

交易 B 讀到的是不存在的結果。

### Non-repeatable Read：不可重複讀

同一個交易中，同一筆資料讀兩次結果不同。

```text
交易 A 第一次讀課程價格：1200
交易 B 把價格改成 1500 並 commit
交易 A 第二次讀課程價格：1500
```

### Phantom Read：幻讀

同一個交易中，同一個條件查詢兩次，筆數不同。

```text
交易 A 查 price > 1000 的課程，有 5 筆
交易 B 新增一門 price = 1500 的課程並 commit
交易 A 再查一次，變 6 筆
```

### 實務建議

多數系統使用資料庫預設隔離級別即可：

- PostgreSQL 預設：Read Committed。
- MySQL InnoDB 預設：Repeatable Read。

遇到庫存、搶票、金流這種高風險場景，不要只靠預設，要明確使用：

- 條件更新，例如 `WHERE stock > 0`。
- row lock，例如 `SELECT ... FOR UPDATE`。
- unique constraint 防重。
- 交易包住關鍵流程。

---

## 2.13 交易範例：轉帳

資料表：

```sql
CREATE TABLE accounts (
  id BIGSERIAL PRIMARY KEY,
  owner_name VARCHAR(100) NOT NULL,
  balance NUMERIC(12, 2) NOT NULL,
  CHECK (balance >= 0)
);
```

轉帳 100 元：

```sql
BEGIN;

UPDATE accounts
SET balance = balance - 100
WHERE id = 1
  AND balance >= 100;

UPDATE accounts
SET balance = balance + 100
WHERE id = 2;

COMMIT;
```

這段還缺一個重要檢查：第一個 `UPDATE` 是否真的更新到 1 筆。

如果帳戶 1 餘額不足，第一個 update 會更新 0 筆，但第二個 update 仍可能執行，造成憑空加錢。

後端程式必須檢查 affected rows：

```text
BEGIN
  debit account 1 where balance >= 100
  if affected_rows != 1:
    ROLLBACK
    return "insufficient balance"
  credit account 2
  COMMIT
```

資料庫保護一部分規則，應用程式也要檢查執行結果。

---

## 2.14 交易範例：扣庫存建立訂單

資料表：

```sql
CREATE TABLE products (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  stock INT NOT NULL,
  price NUMERIC(12, 2) NOT NULL,
  CHECK (stock >= 0)
);

CREATE TABLE orders (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  total_amount NUMERIC(12, 2) NOT NULL,
  status VARCHAR(30) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  product_name VARCHAR(200) NOT NULL,
  unit_price NUMERIC(12, 2) NOT NULL,
  quantity INT NOT NULL,
  subtotal NUMERIC(12, 2) NOT NULL
);
```

核心扣庫存 SQL：

```sql
UPDATE products
SET stock = stock - 1
WHERE id = 1001
  AND stock >= 1;
```

這個寫法的關鍵是 `AND stock >= 1`。

如果庫存已經是 0，這個 update 會更新 0 筆，不會扣成 -1。

完整流程：

```text
BEGIN
  UPDATE products SET stock = stock - 1 WHERE id = ? AND stock >= 1
  if affected_rows != 1:
    ROLLBACK
    return "out of stock"

  INSERT INTO orders (...)
  INSERT INTO order_items (...)
COMMIT
```

這是避免超賣的基本資料庫層防線。

第 04 章會在這個基礎上加入 Redis、Queue 與高併發設計。

---

## 2.15 常見錯誤

### 錯誤 1：查詢價格後，在程式碼中相信它永遠不變

危險流程：

```text
1. SELECT price FROM courses WHERE id = 1
2. 後端拿到 price = 1200
3. 管理員把價格改成 1500
4. 後端 INSERT purchase amount = 1200
```

更好的做法：

- 在同一個交易中處理。
- 或用 `INSERT INTO ... SELECT` 直接從資料庫取當下價格。
- 對重要資料使用鎖或版本號。

### 錯誤 2：只靠後端檢查唯一性

危險流程：

```text
1. 請求 A 查 email 沒存在
2. 請求 B 查 email 沒存在
3. A 插入成功
4. B 也插入成功
```

解法：

```sql
email VARCHAR(255) NOT NULL UNIQUE
```

唯一性必須由資料庫保證。

### 錯誤 3：忘記檢查 affected rows

扣庫存：

```sql
UPDATE products
SET stock = stock - 1
WHERE id = 1001
  AND stock >= 1;
```

如果更新 0 筆，代表庫存不足或商品不存在。應用程式不能繼續建立訂單。

---

## 2.16 本章練習

### 練習 1：查詢使用者購買過的課程

需求：

查詢 `user_id = 1` 已付款購買的課程，回傳課程名稱、金額、購買時間。

#### 參考解答

```sql
SELECT
  c.title,
  p.amount,
  p.purchased_at
FROM purchases p
JOIN courses c ON c.id = p.course_id
WHERE p.user_id = 1
  AND p.status = 'paid'
ORDER BY p.purchased_at DESC;
```

解釋：

- `purchases` 有購買紀錄。
- `courses` 有課程名稱。
- 用 `course_id` JOIN。
- `status = 'paid'` 排除失敗或待付款訂單。

### 練習 2：統計每位使用者購買總金額

需求：

列出每位使用者的 email、購買次數、總金額。沒有購買也要出現，金額顯示 0。

#### 參考解答

```sql
SELECT
  u.email,
  COUNT(p.id) AS purchase_count,
  COALESCE(SUM(p.amount), 0) AS total_amount
FROM users u
LEFT JOIN purchases p
  ON p.user_id = u.id
 AND p.status = 'paid'
GROUP BY u.id, u.email
ORDER BY total_amount DESC;
```

解釋：

- 用 `LEFT JOIN` 保留沒有購買的使用者。
- `p.status = 'paid'` 放在 `ON`，避免把沒有購買的使用者過濾掉。
- `SUM` 沒資料會是 `NULL`，用 `COALESCE` 轉成 0。

### 練習 3：設計購買課程交易

需求：

- 使用者只能購買已上架課程。
- 金額使用課程目前價格。
- 同一使用者不能重複購買同一門課。

#### 參考解答

先確保資料表有唯一約束：

```sql
ALTER TABLE purchases
ADD CONSTRAINT uq_purchases_user_course UNIQUE (user_id, course_id);
```

交易：

```sql
BEGIN;

INSERT INTO purchases (user_id, course_id, amount, status)
SELECT
  1,
  c.id,
  c.price,
  'paid'
FROM courses c
WHERE c.id = 2
  AND c.published = TRUE;

COMMIT;
```

後端要檢查：

- 如果 insert 0 筆，代表課程不存在或未上架。
- 如果違反 unique constraint，代表已購買過。

### 練習 4：扣庫存

需求：

商品 `id = 1001` 庫存至少有 2 件時，扣 2 件。若不足，不可扣成負數。

#### 參考解答

```sql
UPDATE products
SET stock = stock - 2
WHERE id = 1001
  AND stock >= 2;
```

後端必須檢查 affected rows：

```text
affected_rows = 1：扣庫存成功
affected_rows = 0：庫存不足或商品不存在
```

不要先 `SELECT stock` 再無條件 `UPDATE`。在高併發下，查到的庫存可能已經被其他交易改掉。

---

## 2.17 驗收清單

- [ ] 我能寫基本 `INSERT`、`SELECT`、`UPDATE`、`DELETE`。
- [ ] 我知道 `WHERE` 對 `UPDATE` 與 `DELETE` 很重要。
- [ ] 我能使用 `JOIN` 查跨表資料。
- [ ] 我知道 `LEFT JOIN` 與 `INNER JOIN` 的差異。
- [ ] 我能使用 `GROUP BY` 做統計。
- [ ] 我能說明交易與 ACID。
- [ ] 我知道扣庫存要使用條件更新並檢查 affected rows。

---

完成後請前往 [03-index-query-performance-optimization.md](./03-index-query-performance-optimization.md)。
