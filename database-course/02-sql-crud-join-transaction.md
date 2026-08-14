# 第 02 章：SQL CRUD、JOIN、聚合與交易

> SQL 是你跟關聯式資料庫溝通的語言。
> 但 SQL 不只是 `SELECT * FROM table`，它同時承載了查詢、寫入、資料約束、交易與一致性。
> 這章會用線上課程平台的資料表，帶你從基本 CRUD 走到 JOIN、聚合與交易。

---

## 2.1 學習目標

完成本章後，你應該可以：

- 使用 `INSERT`、`SELECT`、`UPDATE`、`DELETE` 操作資料。
- 寫出 `WHERE`、`ORDER BY`、`LIMIT`。
- 從需求描述判斷該用 `INNER JOIN`、`LEFT JOIN`、`FULL OUTER JOIN` 還是自連接。
- 用 `LEFT JOIN` + `IS NULL` 找出「沒有 X 的 Y」，並知道 `NOT EXISTS` 是更好的寫法。
- 說明為什麼過濾條件放 `ON` 和放 `WHERE` 會讓 `LEFT JOIN` 有完全不同的結果。
- 察覺一對多 JOIN 造成的列數放大，並用「先聚合再 JOIN」修正。
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

### 先問一個問題，就能決定用哪一種

多數人記不住 JOIN 的差別，是因為背了定義卻沒有判斷依據。實際上只要回答一個問題：

```text
「左表（FROM 後面那張）的資料，
  即使在右表找不到對應，也要出現在結果裡嗎？」

  不用出現  ->  INNER JOIN     （只要兩邊都對得上的）
  一定要出現 ->  LEFT JOIN      （左邊全留，右邊沒有就補 NULL）
```

九成的情況這個問題就夠了。剩下的一成：

```text
「兩邊都要全留，誰對不上都要出現？」   -> FULL OUTER JOIN
「要每一種組合，不需要對應關係？」      -> CROSS JOIN
「要拿同一張表的兩筆資料互相比對？」    -> 自連接（self join）
```

換成業務語言更好記：

| 需求描述裡出現這種字 | 該用 |
|---|---|
| 「**每筆**訂單的使用者名稱」 | INNER JOIN（訂單一定有使用者） |
| 「**所有**課程的銷售額，**沒賣過的顯示 0**」 | LEFT JOIN |
| 「**還沒**購買任何課程的使用者」 | LEFT JOIN + `IS NULL` |
| 「兩邊的資料**對不上的都列出來**」 | FULL OUTER JOIN |
| 「每個課程 × 每種方案的**組合**」 | CROSS JOIN |

**看到「所有」、「即使沒有」、「包含 0 筆」、「還沒」這些字，就要停下來想 LEFT JOIN。**

### 用一組小資料看清差別

定義背不起來，看實際結果就懂了。假設資料只有這些：

```text
courses                          purchases
┌────┬──────────────┐            ┌────┬───────────┬────────┐
│ id │ title        │            │ id │ course_id │ amount │
├────┼──────────────┤            ├────┼───────────┼────────┤
│  1 │ SQL 入門      │            │ 91 │     1     │  1200  │
│  2 │ Redis 實戰    │            │ 92 │     1     │  1200  │
│  3 │ 尚未有人買的課 │            │ 93 │     2     │   900  │
└────┴──────────────┘            │ 94 │    999    │   500  │ ← 孤兒資料
                                 └────┴───────────┴────────┘
```

（`course_id = 999` 這筆在正常情況下會被 foreign key 擋掉，這裡刻意加進來，方便看出各種 JOIN 的差別。）

```sql
-- INNER JOIN：只有兩邊都對得上的
SELECT c.title, p.id AS purchase_id
FROM courses c
INNER JOIN purchases p ON p.course_id = c.id;
```

```text
 title        │ purchase_id
──────────────┼─────────────
 SQL 入門      │ 91
 SQL 入門      │ 92
 Redis 實戰    │ 93
（3 列。「尚未有人買的課」不見了，孤兒的 94 也不見了）
```

```sql
-- LEFT JOIN：左表（courses）全部保留
SELECT c.title, p.id AS purchase_id
FROM courses c
LEFT JOIN purchases p ON p.course_id = c.id;
```

```text
 title        │ purchase_id
──────────────┼─────────────
 SQL 入門      │ 91
 SQL 入門      │ 92
 Redis 實戰    │ 93
 尚未有人買的課 │ NULL          ← 差別在這一列
（4 列。右邊沒對到就補 NULL）
```

```sql
-- RIGHT JOIN：右表（purchases）全部保留
SELECT c.title, p.id AS purchase_id
FROM courses c
RIGHT JOIN purchases p ON p.course_id = c.id;
```

```text
 title        │ purchase_id
──────────────┼─────────────
 SQL 入門      │ 91
 SQL 入門      │ 92
 Redis 實戰    │ 93
 NULL         │ 94            ← 孤兒資料出現了
（4 列）
```

```sql
-- FULL OUTER JOIN：兩邊都全部保留
SELECT c.title, p.id AS purchase_id
FROM courses c
FULL OUTER JOIN purchases p ON p.course_id = c.id;
```

```text
 title        │ purchase_id
──────────────┼─────────────
 SQL 入門      │ 91
 SQL 入門      │ 92
 Redis 實戰    │ 93
 尚未有人買的課 │ NULL
 NULL         │ 94
（5 列）
```

**四種 JOIN 差別的一句話總結：差別只在「對不上的資料要不要留」。**

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

這裡用 INNER JOIN 是對的，因為**每筆購買紀錄一定有對應的使用者與課程**（有 foreign key 保證）。如果 `purchases.user_id` 找不到對應 user，這筆就不會出現，但正常情況不會發生。

> `JOIN` 是 `INNER JOIN` 的縮寫，兩者完全等價。建議寫完整的 `INNER JOIN`，讓讀者一眼看出你是刻意選了 INNER，而不是忘了加 LEFT。

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

如果用 `INNER JOIN`，沒人購買的課程會消失——而那正是報表最需要被看到的資料（「這門課賣了 0 筆」比「這門課不存在」有用得多）。

注意這裡用 `COUNT(p.id)` 而不是 `COUNT(*)`：

```text
COUNT(*)     -> 數「列數」，沒購買的課程那一列也算，會得到 1（錯）
COUNT(p.id)  -> 只數 p.id 不是 NULL 的，沒購買的課程得到 0（對）
```

**`LEFT JOIN` 配聚合時，一律 `COUNT(右表的欄位)`，不要 `COUNT(*)`。** 這是很常見的錯誤，而且它不會報錯，只會讓你的報表把 0 顯示成 1。

### RIGHT JOIN：存在，但建議一律改寫成 LEFT

`RIGHT JOIN` 保留右表的全部資料。它和 `LEFT JOIN` 是完全對稱的：

```sql
-- 這兩句的結果完全相同
SELECT ... FROM courses c RIGHT JOIN purchases p ON p.course_id = c.id;
SELECT ... FROM purchases p LEFT JOIN courses c ON c.id = p.course_id;
```

**實務上幾乎沒有人用 RIGHT JOIN**，原因是可讀性：

```text
SQL 是從上往下讀的。用 LEFT JOIN 時，「要保留的主表」寫在最前面的 FROM，
讀者一眼就知道這個查詢是「以什麼為主體」。

用 RIGHT JOIN 時，主體藏在下面第二張表 —— 而如果 JOIN 了三四張表，
還要往下翻才知道誰是主角，非常容易看錯。
```

所以建議：

- **自己寫的時候一律用 LEFT JOIN**，把要保留的表放在 `FROM`。
- **但要看得懂 RIGHT JOIN**，因為你會在別人的舊程式碼、面試題、教科書裡遇到它。看到時就在心裡把兩張表對調成 LEFT JOIN 來理解。

### FULL OUTER JOIN

兩邊都保留，任一邊對不上都會出現（另一邊補 NULL）。

典型用途是**對帳與資料稽核**——找出兩份資料的所有差異：

```sql
-- 比對「系統訂單」與「金流商回傳的交易」，找出雙邊不一致
SELECT
  o.id          AS order_id,
  o.amount      AS order_amount,
  t.txn_id,
  t.amount      AS txn_amount,
  CASE
    WHEN t.txn_id IS NULL THEN '系統有訂單，金流無交易'
    WHEN o.id IS NULL     THEN '金流有交易，系統無訂單'
    ELSE '金額不符'
  END AS issue
FROM orders o
FULL OUTER JOIN payment_txns t ON t.order_id = o.id
WHERE t.txn_id IS NULL
   OR o.id IS NULL
   OR o.amount <> t.amount;
```

日常業務查詢很少用到它。**MySQL 不支援 `FULL OUTER JOIN`**，要用 `LEFT JOIN` 加 `UNION` 加 `RIGHT JOIN` 模擬；PostgreSQL 原生支援。

### CROSS JOIN 與「忘記 ON」的意外

`CROSS JOIN` 產生兩張表的所有組合（笛卡兒積）。3 列 × 4 列 = 12 列。

刻意使用的場景不多，主要是「產生完整的組合矩陣」：

```sql
-- 每門課 × 每種方案，產生完整的定價表骨架（即使還沒設價）
SELECT c.title, pl.name AS plan_name
FROM courses c
CROSS JOIN plans pl;
```

比較常見的是**不小心產生它**：

```sql
-- 錯誤：忘了 ON 條件
SELECT *
FROM users u
JOIN purchases p;
```

這會讓每個 user 都跟每筆 purchase 配一次。1 萬個使用者 × 5 萬筆購買 = **5 億列**，查詢會直接把資料庫拖垮。

正確：

```sql
SELECT *
FROM users u
JOIN purchases p ON p.user_id = u.id;
```

還有一種更隱蔽的版本——ON 條件寫錯欄位：

```sql
-- 語法完全正確，但 ON 條件永遠成立，等於 CROSS JOIN
FROM users u
JOIN purchases p ON 1 = 1

-- 或 JOIN 了三張表，卻漏掉其中一組關聯
FROM users u
JOIN purchases p ON p.user_id = u.id
JOIN courses c ON c.id = c.id          -- 打錯了！應該是 c.id = p.course_id
```

**自我檢查的習慣：JOIN 了 N 張表，就應該有 N-1 個 ON 條件。** 少一個就代表某處是笛卡兒積。

### 自連接（Self Join）：同一張表 JOIN 自己

當你要拿同一張表的兩筆資料互相比對時使用。關鍵是**取兩個不同的別名**，讓資料庫把它們當成兩張表。

例 1：找出每個單元和它的下一個單元（`lessons` 有 `position` 欄位）：

```sql
SELECT
  cur.title  AS current_lesson,
  nxt.title  AS next_lesson
FROM lessons cur
LEFT JOIN lessons nxt
  ON nxt.course_id = cur.course_id
 AND nxt.position = cur.position + 1
WHERE cur.course_id = 1
ORDER BY cur.position;
```

用 `LEFT JOIN` 是因為**最後一個單元沒有下一個**，我們仍要讓它出現（`next_lesson` 顯示 NULL）——這正是前面那個判斷問句的應用。

例 2：員工與主管在同一張表（經典的 self join 題目）：

```sql
SELECT
  e.name       AS employee,
  m.name       AS manager
FROM employees e
LEFT JOIN employees m ON m.id = e.manager_id;
```

同樣用 LEFT JOIN——**最高層的老闆沒有主管**，用 INNER JOIN 會讓他從結果裡消失。

### 高價值模式：`LEFT JOIN` + `IS NULL`，找出「沒有 X 的 Y」

這是實務上使用頻率極高的一個模式，也是 LEFT JOIN 最重要的應用之一。

需求：**找出從未購買任何課程的使用者**（可以拿來做行銷名單）。

```sql
SELECT u.id, u.email, u.name
FROM users u
LEFT JOIN purchases p ON p.user_id = u.id
WHERE p.id IS NULL;
```

原理很直觀：`LEFT JOIN` 讓所有使用者都留下，沒有購買紀錄的那些，右表欄位會是 `NULL`。用 `WHERE p.id IS NULL` 就只留下那些人。

```text
LEFT JOIN 之後：
 email          │ p.id
────────────────┼──────
 alice@x.com    │ 91      ← 有買，被 WHERE 過濾掉
 bob@x.com      │ NULL    ← 沒買，留下 ✓
 carol@x.com    │ NULL    ← 沒買，留下 ✓
```

同一個模式的其他用法：

```sql
-- 沒有任何單元的課程（資料異常檢查）
SELECT c.id, c.title
FROM courses c
LEFT JOIN lessons l ON l.course_id = c.id
WHERE l.id IS NULL;

-- 買了課但完全沒開始上的使用者（可以推送提醒）
SELECT DISTINCT u.email, c.title
FROM purchases p
INNER JOIN users u ON u.id = p.user_id
INNER JOIN courses c ON c.id = p.course_id
INNER JOIN lessons l ON l.course_id = c.id
LEFT JOIN lesson_progress lp
  ON lp.lesson_id = l.id
 AND lp.user_id = p.user_id
WHERE p.status = 'paid'
GROUP BY u.email, c.title, p.user_id, p.course_id
HAVING COUNT(lp.lesson_id) = 0;
```

**`IS NULL` 一定要用右表「不可能為 NULL 的欄位」來判斷**——主鍵最保險。如果拿一個本身就允許 NULL 的欄位來判斷（例如 `WHERE p.note IS NULL`），你會同時抓到「沒有購買紀錄」和「有購買但備註是空的」兩種人，結果是錯的。

#### 三種寫法的比較

同樣的需求也可以用 `NOT EXISTS` 或 `NOT IN`：

```sql
-- 寫法 A：LEFT JOIN + IS NULL
SELECT u.id, u.email FROM users u
LEFT JOIN purchases p ON p.user_id = u.id
WHERE p.id IS NULL;

-- 寫法 B：NOT EXISTS（語意最清楚，多數情況效能也最好）
SELECT u.id, u.email FROM users u
WHERE NOT EXISTS (
  SELECT 1 FROM purchases p WHERE p.user_id = u.id
);

-- 寫法 C：NOT IN（有 NULL 陷阱，不建議）
SELECT u.id, u.email FROM users u
WHERE u.id NOT IN (SELECT user_id FROM purchases);
```

| 寫法 | 可讀性 | 效能 | 風險 |
|---|---|---|---|
| A `LEFT JOIN` + `IS NULL` | 中 | 好 | 忘記 `IS NULL` 判斷欄位選錯 |
| B `NOT EXISTS` | **最好** | **好**（能提早中斷） | 無 |
| C `NOT IN` | 好 | 較差 | **子查詢有任何 NULL，整個結果就變成空** |

**寫法 C 的 NULL 陷阱值得記一下**：如果 `purchases.user_id` 裡有任何一筆是 `NULL`，`NOT IN` 的結果會是空集合（因為 `x <> NULL` 的結果是 unknown，不是 true）。這個 bug 極難察覺——查詢不報錯，只是安靜地回傳 0 列。

**建議預設用 `NOT EXISTS`**，語意最直白。本節之所以先教 `LEFT JOIN + IS NULL`，是因為它能幫你真正理解 LEFT JOIN 補 NULL 這件事，而且你一定會在別人的程式碼裡看到它。

### 陷阱：一對多 JOIN 會放大列數，把聚合算錯

**這是實務上最常見、也最難發現的 JOIN bug**，因為它不會報錯，只會給你錯誤的數字。

問題出在：JOIN 兩張「一對多」的表時，列數會相乘。

需求：想同時知道每門課的「購買筆數」和「單元數」。直覺會這樣寫：

```sql
-- ❌ 錯誤：金額和數量都被放大了
SELECT
  c.title,
  COUNT(p.id)  AS purchase_count,
  SUM(p.amount) AS revenue,
  COUNT(l.id)  AS lesson_count
FROM courses c
LEFT JOIN purchases p ON p.course_id = c.id
LEFT JOIN lessons   l ON l.course_id = c.id
GROUP BY c.id, c.title;
```

假設「SQL 入門」有 **2 筆購買**（各 1200 元）和 **3 個單元**：

```text
JOIN 之後這門課變成 2 × 3 = 6 列：

 title    │ p.id │ p.amount │ l.id
──────────┼──────┼──────────┼──────
 SQL 入門  │  91  │   1200   │  1
 SQL 入門  │  91  │   1200   │  2
 SQL 入門  │  91  │   1200   │  3
 SQL 入門  │  92  │   1200   │  1
 SQL 入門  │  92  │   1200   │  2
 SQL 入門  │  92  │   1200   │  3

於是：
  COUNT(p.id)   = 6      （真實是 2，被放大 3 倍）
  SUM(p.amount) = 7200   （真實是 2400，被放大 3 倍）
  COUNT(l.id)   = 6      （真實是 3，被放大 2 倍）
```

**每個數字都錯了，而查詢完全不會報錯。** 如果這是財報，你會對外公布一個三倍的營收。

三種正確的做法：

```sql
-- ✅ 解法 1：COUNT(DISTINCT ...)（最小改動，但 SUM 仍然錯！）
SELECT
  c.title,
  COUNT(DISTINCT p.id) AS purchase_count,
  COUNT(DISTINCT l.id) AS lesson_count
FROM courses c
LEFT JOIN purchases p ON p.course_id = c.id
LEFT JOIN lessons   l ON l.course_id = c.id
GROUP BY c.id, c.title;
```

`COUNT(DISTINCT ...)` 能救 `COUNT`，**但救不了 `SUM` 和 `AVG`**——重複的 1200 是同一個值，`SUM(DISTINCT amount)` 會把兩筆真實的 1200 元併成一筆，答案還是錯的。這是解法 1 最大的限制。

```sql
-- ✅ 解法 2：先各自聚合再 JOIN（最推薦，SUM 也正確）
WITH purchase_stats AS (
  SELECT course_id,
         COUNT(*)    AS purchase_count,
         SUM(amount) AS revenue
  FROM purchases
  WHERE status = 'paid'
  GROUP BY course_id
),
lesson_stats AS (
  SELECT course_id, COUNT(*) AS lesson_count
  FROM lessons
  GROUP BY course_id
)
SELECT
  c.title,
  COALESCE(ps.purchase_count, 0) AS purchase_count,
  COALESCE(ps.revenue, 0)        AS revenue,
  COALESCE(ls.lesson_count, 0)   AS lesson_count
FROM courses c
LEFT JOIN purchase_stats ps ON ps.course_id = c.id
LEFT JOIN lesson_stats   ls ON ls.course_id = c.id
ORDER BY revenue DESC;
```

**每個子查詢都先聚合成「一課一列」，再 JOIN 就不會相乘。** 這是處理多個一對多關係的標準做法（CTE 的寫法見 2.9 節）。

```sql
-- ✅ 解法 3：用純量子查詢（表少、需求簡單時很直觀）
SELECT
  c.title,
  (SELECT COUNT(*) FROM purchases p
    WHERE p.course_id = c.id AND p.status = 'paid') AS purchase_count,
  (SELECT COALESCE(SUM(amount), 0) FROM purchases p
    WHERE p.course_id = c.id AND p.status = 'paid') AS revenue,
  (SELECT COUNT(*) FROM lessons l WHERE l.course_id = c.id) AS lesson_count
FROM courses c;
```

**怎麼提早發現這個 bug**：JOIN 之後先不要急著加 `GROUP BY`，先跑一次看列數。

```sql
-- 先確認列數合理
SELECT COUNT(*) FROM courses c
LEFT JOIN purchases p ON p.course_id = c.id
LEFT JOIN lessons   l ON l.course_id = c.id;
-- 如果這個數字遠大於你預期的「課程數 + 購買數」，就是被放大了
```

**判斷規則：一個查詢裡只要 JOIN 了兩個以上的「一對多」關係，就一定要停下來檢查列數。**

### `ON` 還是 `WHERE`：一個決定 LEFT JOIN 生死的選擇

同樣的條件放在 `ON` 或 `WHERE`，對 `INNER JOIN` 沒差，但對 `LEFT JOIN` 結果完全不同。

需求：列出課程 1 的**所有單元**，以及使用者 42 是否完成了每一個。

```sql
-- ✅ 正確：條件放在 ON
SELECT
  l.position,
  l.title,
  lp.completed_at
FROM lessons l
LEFT JOIN lesson_progress lp
  ON lp.lesson_id = l.id
 AND lp.user_id = 42          -- 放在 ON
WHERE l.course_id = 1
ORDER BY l.position;
```

```text
 position │ title      │ completed_at
──────────┼────────────┼──────────────
    1     │ 環境安裝    │ 2026-08-01     ← 完成了
    2     │ 基本語法    │ 2026-08-03     ← 完成了
    3     │ JOIN 實作   │ NULL           ← 還沒完成，但仍然出現 ✓
```

```sql
-- ❌ 錯誤：條件放在 WHERE
SELECT l.position, l.title, lp.completed_at
FROM lessons l
LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id
WHERE l.course_id = 1
  AND lp.user_id = 42          -- 放在 WHERE
ORDER BY l.position;
```

```text
 position │ title      │ completed_at
──────────┼────────────┼──────────────
    1     │ 環境安裝    │ 2026-08-01
    2     │ 基本語法    │ 2026-08-03
（第 3 個單元消失了！因為它 JOIN 後 lp.user_id 是 NULL，
  而 NULL = 42 不成立，被 WHERE 過濾掉）
```

**原因是執行順序**：

```text
1. FROM / JOIN  ->  依 ON 條件組合出結果（LEFT JOIN 在此補 NULL）
2. WHERE        ->  過濾上一步的結果
3. GROUP BY
4. HAVING
5. SELECT
6. ORDER BY
```

`ON` 在「組合」階段生效，`WHERE` 在「已經組合完」之後才生效。所以任何寫在 `WHERE` 裡、針對右表欄位的條件，都會把補 NULL 的那些列刪掉——**`LEFT JOIN` 就退化成 `INNER JOIN` 了**。

記成一條規則：

```text
針對「右表」的過濾條件  ->  放 ON
針對「左表」的過濾條件  ->  放 WHERE（放 ON 也對，但放 WHERE 語意更清楚）
唯一的例外：刻意用 WHERE 右表欄位 IS NULL 來做反查（見前面的模式）
```

上面那個 `WHERE l.course_id = 1` 就是針對左表的條件，放 `WHERE` 是正確的。

### JOIN 的效能取決於 ON 欄位有沒有索引

JOIN 寫對了不代表跑得快。資料庫執行 JOIN 時要反覆用左表的值去右表查找，**如果 ON 條件的欄位沒有索引，每一次查找都是全表掃描**。

```sql
-- purchases.course_id 沒有索引時，這個 JOIN 會很慢
SELECT c.title, COUNT(p.id)
FROM courses c
LEFT JOIN purchases p ON p.course_id = c.id
GROUP BY c.id, c.title;
```

```sql
-- 加上索引
CREATE INDEX idx_purchases_course_id ON purchases (course_id);
```

**一個實用的檢查習慣：外鍵欄位要建索引。** 很多資料庫（包含 PostgreSQL 與 MySQL 的 InnoDB）建立 foreign key 時**不會**自動為子表的欄位建索引，而那個欄位正是 JOIN 最常用到的。

用 `EXPLAIN` 確認 JOIN 走的是索引還是全表掃描——這是第 03 章的主題。

### 情境對照總表

寫查詢時可以直接查這張表：

| 情境 | JOIN 類型 | 關鍵注意事項 |
|---|---|---|
| 每筆訂單帶出使用者/商品名稱 | `INNER JOIN` | 有 FK 保證對得上 |
| 所有課程的銷售統計（含 0 筆） | `LEFT JOIN` | 用 `COUNT(右表欄位)` 不是 `COUNT(*)` |
| 課程 + 某使用者的完成進度 | `LEFT JOIN` | 使用者條件放 `ON`，不是 `WHERE` |
| 找出從未購買的使用者 | `LEFT JOIN` + `IS NULL` | 或用更清楚的 `NOT EXISTS` |
| 找出沒有單元的課程（資料稽核） | `LEFT JOIN` + `IS NULL` | `IS NULL` 判斷用主鍵 |
| 同時統計購買數與單元數 | **先各自聚合再 JOIN** | 直接雙 LEFT JOIN 會相乘算錯 |
| 單元與它的下一個單元 | 自連接 + `LEFT JOIN` | 兩個別名；最後一筆要留下 |
| 員工與主管 | 自連接 + `LEFT JOIN` | 最上層沒有主管 |
| 系統訂單 vs 金流交易對帳 | `FULL OUTER JOIN` | MySQL 不支援，要用 UNION 模擬 |
| 課程 × 方案的組合矩陣 | `CROSS JOIN` | 確認列數是刻意的 |
| 看到別人寫 `RIGHT JOIN` | 心裡對調成 `LEFT JOIN` | 自己寫時不要用 |

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

那沒有購買紀錄的課程會被過濾掉，`LEFT JOIN` 會變得像 `INNER JOIN`（原因見 2.7 節的執行順序說明）。

同樣地，`COUNT(p.id)` 不能寫成 `COUNT(*)`——後者會把「沒有購買」的那一列也算成 1。`SUM` 在沒有資料時會是 `NULL`，報表要顯示 0 的話記得用 `COALESCE(SUM(p.amount), 0)`。

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
- `COUNT(p.id)` 而不是 `COUNT(*)`，否則沒購買的使用者會顯示 1 筆。

### 練習 3：選對 JOIN

以下五個需求，各自該用哪一種 JOIN？寫出 SQL 並說明理由。

1. 列出每筆已付款購買紀錄的使用者 email 與課程名稱。
2. 列出所有已上架課程的購買人數，沒人買的顯示 0。
3. 找出註冊超過 30 天、但從未購買任何課程的使用者。
4. 找出沒有任何單元的課程（資料異常檢查）。
5. 列出每個單元，以及它在同一課程中的前一個單元名稱。

#### 參考解答

**1. `INNER JOIN`**

```sql
SELECT u.email, c.title, p.amount, p.purchased_at
FROM purchases p
INNER JOIN users u ON u.id = p.user_id
INNER JOIN courses c ON c.id = p.course_id
WHERE p.status = 'paid';
```

判斷依據：主體是「購買紀錄」，而每筆購買一定有對應的使用者與課程（有 foreign key）。不需要保留對不上的資料，所以用 INNER。

`p.status = 'paid'` 放 `WHERE` 是對的——它過濾的是左表（主體）自己的欄位，不是被 JOIN 進來的表。

**2. `LEFT JOIN`**

```sql
SELECT
  c.id,
  c.title,
  COUNT(p.id) AS buyer_count
FROM courses c
LEFT JOIN purchases p
  ON p.course_id = c.id
 AND p.status = 'paid'
WHERE c.published = TRUE
GROUP BY c.id, c.title
ORDER BY buyer_count DESC;
```

三個關鍵：

- 需求說「沒人買的顯示 0」→ 必須 `LEFT JOIN`。
- `p.status = 'paid'` 放 `ON`（針對右表），放 `WHERE` 會讓沒人買的課程消失。
- `c.published = TRUE` 放 `WHERE`（針對左表）。
- `COUNT(p.id)` 不能用 `COUNT(*)`，否則 0 會變成 1。

**3. `LEFT JOIN` + `IS NULL`（或 `NOT EXISTS`）**

```sql
-- 寫法 A
SELECT u.id, u.email, u.created_at
FROM users u
LEFT JOIN purchases p ON p.user_id = u.id
WHERE p.id IS NULL
  AND u.created_at < CURRENT_DATE - INTERVAL '30 days';

-- 寫法 B（建議，語意更直接）
SELECT u.id, u.email, u.created_at
FROM users u
WHERE u.created_at < CURRENT_DATE - INTERVAL '30 days'
  AND NOT EXISTS (
    SELECT 1 FROM purchases p WHERE p.user_id = u.id
  );
```

注意這題**不能用 `NOT IN`**：

```sql
-- ✗ 如果 purchases.user_id 有任何 NULL，整個結果會是空集合
WHERE u.id NOT IN (SELECT user_id FROM purchases)
```

雖然本例的 `user_id` 有 `NOT NULL` 約束所以不會出事，但這個習慣在其他表上會踩雷。

另外要想清楚一個業務問題：這題是「從未購買」還是「從未成功付款」？

```sql
-- 如果要排除「下單但付款失敗」的人，條件要進 EXISTS 裡面
AND NOT EXISTS (
  SELECT 1 FROM purchases p
  WHERE p.user_id = u.id AND p.status = 'paid'
)
```

兩者的名單差很多。**需求裡的「購買」到底指哪一個，要問清楚再寫。**

**4. `LEFT JOIN` + `IS NULL`**

```sql
SELECT c.id, c.title, c.published
FROM courses c
LEFT JOIN lessons l ON l.course_id = c.id
WHERE l.id IS NULL;
```

`IS NULL` 判斷用 `l.id`（主鍵）最保險。如果拿 `l.title` 來判斷，理論上會混進「有單元但標題是 NULL」的情況——雖然本表的 `title` 有 `NOT NULL`，但養成用主鍵判斷的習慣比較安全。

這種查詢適合做成定期的資料稽核任務：已上架卻沒有任何單元的課程，是應該立刻被抓出來的異常。

**5. 自連接 + `LEFT JOIN`**

```sql
SELECT
  cur.course_id,
  cur.position,
  cur.title       AS current_lesson,
  prv.title       AS previous_lesson
FROM lessons cur
LEFT JOIN lessons prv
  ON prv.course_id = cur.course_id
 AND prv.position = cur.position - 1
ORDER BY cur.course_id, cur.position;
```

兩個要點：

- 同一張表要取兩個不同別名（`cur` / `prv`），資料庫才知道是兩份。
- ON 條件必須包含 `course_id`，否則會跨課程配對——第 3 課的前一課變成別的課程的第 2 課。
- 用 `LEFT JOIN` 因為**每個課程的第一個單元沒有前一個**，用 INNER JOIN 會讓所有課程的第一課消失。

（如果你的資料庫支援窗口函式，`LAG(title) OVER (PARTITION BY course_id ORDER BY position)` 更簡潔，但自連接是必須先理解的基礎。）

### 練習 4：除錯——為什麼營收多了三倍

某同事寫了這份課程營收報表，上線後財務反映數字明顯偏高。請找出原因並修正。

```sql
SELECT
  c.title,
  COUNT(p.id)   AS purchase_count,
  SUM(p.amount) AS revenue,
  COUNT(l.id)   AS lesson_count
FROM courses c
LEFT JOIN purchases p ON p.course_id = c.id AND p.status = 'paid'
LEFT JOIN lessons   l ON l.course_id = c.id
GROUP BY c.id, c.title
ORDER BY revenue DESC;
```

#### 參考解答

**原因：兩個「一對多」的 JOIN 造成列數相乘。**

`courses` 對 `purchases` 是一對多，`courses` 對 `lessons` 也是一對多。兩者 JOIN 在一起時，同一門課的每一筆購買會和每一個單元配對一次。

以一門有 2 筆購買（各 1200 元）、3 個單元的課程為例：

```text
JOIN 後變成 2 × 3 = 6 列：

 title    │ p.id │ p.amount │ l.id
──────────┼──────┼──────────┼──────
 SQL 入門  │  91  │   1200   │  1
 SQL 入門  │  91  │   1200   │  2
 SQL 入門  │  91  │   1200   │  3
 SQL 入門  │  92  │   1200   │  1
 SQL 入門  │  92  │   1200   │  2
 SQL 入門  │  92  │   1200   │  3

purchase_count = 6      正確答案是 2   （× 單元數 3）
revenue        = 7200   正確答案是 2400（× 單元數 3）
lesson_count   = 6      正確答案是 3   （× 購買數 2）
```

**三個數字全錯，而 SQL 不會報任何錯。** 這就是這類 bug 最危險的地方——它只在你去核對真實數字時才會被發現。

放大倍數還會隨資料變化：單元多的課程營收被放大得更嚴重，所以你甚至看不出一個固定的倍率。

**修正方式（推薦）：先各自聚合成「一課一列」，再 JOIN。**

```sql
WITH purchase_stats AS (
  SELECT
    course_id,
    COUNT(*)    AS purchase_count,
    SUM(amount) AS revenue
  FROM purchases
  WHERE status = 'paid'
  GROUP BY course_id
),
lesson_stats AS (
  SELECT course_id, COUNT(*) AS lesson_count
  FROM lessons
  GROUP BY course_id
)
SELECT
  c.title,
  COALESCE(ps.purchase_count, 0) AS purchase_count,
  COALESCE(ps.revenue, 0)        AS revenue,
  COALESCE(ls.lesson_count, 0)   AS lesson_count
FROM courses c
LEFT JOIN purchase_stats ps ON ps.course_id = c.id
LEFT JOIN lesson_stats   ls ON ls.course_id = c.id
ORDER BY revenue DESC;
```

因為兩個 CTE 都已經是「一個 course_id 一列」，JOIN 回 `courses` 是一對一，不會相乘。

**為什麼不用 `COUNT(DISTINCT ...)` 就好？**

```sql
-- 只能修好 COUNT，修不好 SUM
COUNT(DISTINCT p.id)  AS purchase_count,   -- ✓ 2，正確
SUM(p.amount)         AS revenue,          -- ✗ 7200，還是錯
SUM(DISTINCT p.amount) AS revenue2         -- ✗ 1200，更錯
```

`SUM(DISTINCT amount)` 會把兩筆真實存在的 1200 元當成重複值合併掉，答案變成 1200——比原本的 7200 錯得更難察覺。

**所以規則是：`COUNT` 可以靠 `DISTINCT` 補救，`SUM` / `AVG` 只能靠「先聚合再 JOIN」。**

**怎麼在寫的時候就避免：**

```sql
-- 加 GROUP BY 之前，先看一次列數
SELECT COUNT(*)
FROM courses c
LEFT JOIN purchases p ON p.course_id = c.id AND p.status = 'paid'
LEFT JOIN lessons   l ON l.course_id = c.id;
```

如果這個數字明顯大於「課程數 + 購買數」的量級，就是被放大了。

**檢查習慣：一個查詢裡出現兩個以上針對同一張主表的一對多 JOIN，就要停下來檢查列數。**

### 練習 5：設計購買課程交易

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

### 練習 6：扣庫存

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
- [ ] 我能用「左表對不上的資料要不要留」這個問題決定 JOIN 類型。
- [ ] 我知道 `LEFT JOIN` 與 `INNER JOIN` 的差異，也知道 `RIGHT JOIN` 該改寫成 `LEFT JOIN`。
- [ ] 我會用 `LEFT JOIN` + `IS NULL` 找出「沒有 X 的 Y」，也知道 `NOT EXISTS` 更好、`NOT IN` 有 NULL 陷阱。
- [ ] 我能說明為什麼右表的過濾條件要放 `ON` 而不是 `WHERE`。
- [ ] 我知道 `LEFT JOIN` 配聚合要用 `COUNT(右表欄位)` 而不是 `COUNT(*)`。
- [ ] 我會察覺一對多 JOIN 造成的列數放大，並知道 `SUM` 只能用「先聚合再 JOIN」修正。
- [ ] 我會寫自連接，並知道為什麼通常要搭配 `LEFT JOIN`。
- [ ] 我知道 JOIN 的效能取決於 ON 欄位有沒有索引，外鍵欄位要自己建索引。
- [ ] 我能使用 `GROUP BY` 做統計。
- [ ] 我能說明交易與 ACID。
- [ ] 我知道扣庫存要使用條件更新並檢查 affected rows。

---

完成後請前往 [03-index-query-performance-optimization.md](./03-index-query-performance-optimization.md)。
