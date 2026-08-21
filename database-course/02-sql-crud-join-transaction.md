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
- 說明 ACID，並用「級別 × 異常」對照表講清楚四種隔離級別。
- 查詢與設定隔離級別，並知道 `SET SESSION` 配連線池的陷阱。
- 說明 MVCC 怎麼做到「讀不阻塞寫」，以及 RC 與 RR 的差別只在快照時機。
- 區分快照讀與當前讀，並說明 MVCC 為什麼擋不住更新丟失。
- 用條件更新、`FOR UPDATE` 或版本號修掉更新丟失。
- 用 UPSERT 把「有就更新，沒有就新增」壓成一句原子寫入，並知道它必須有唯一約束才成立。
- 用 `RETURNING` 讓寫入直接帶回結果，不用再查一次。
- 說明長交易對 PostgreSQL bloat 與 MySQL undo log 的傷害，並查出最久的交易。
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

SQL 標準定義四個級別，從最寬鬆到最嚴格：

- Read Uncommitted
- Read Committed
- Repeatable Read
- Serializable

級別越嚴格，異常越少，但併發能力通常越差。理解它們的正確方式不是背名字，而是先認識三種異常現象，再看每個級別擋掉哪些。

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

不可重複讀與幻讀的差別值得講清楚：

```text
不可重複讀 → 同一筆資料的「內容」變了
幻讀       → 符合條件的「筆數」變了（有人新增或刪除）
```

這個差別會影響修法。防不可重複讀只要鎖住已存在的那幾列就夠；防幻讀必須鎖住「還不存在的資料」——這就是間隙鎖要解決的問題（第 04 章 4.8 節）。

### 級別與異常對照表

| 隔離級別 | 髒讀 | 不可重複讀 | 幻讀 |
|----------|------|------------|------|
| Read Uncommitted | 可能 | 可能 | 可能 |
| Read Committed | 不會 | 可能 | 可能 |
| Repeatable Read | 不會 | 不會 | 標準允許 / InnoDB 不會 |
| Serializable | 不會 | 不會 | 不會 |

這張表是 SQL 標準的說法，但真實資料庫有兩個一定要知道的偏差：

- **PostgreSQL 沒有真正的 Read Uncommitted。** 你可以寫 `SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED`，語法會成功，但行為等同 Read Committed。PostgreSQL 的架構上不存在「讀到未提交版本」這條路徑，所以它永遠不會髒讀。
- **MySQL InnoDB 的 Repeatable Read 擋掉了幻讀。** 標準允許 RR 出現幻讀，但 InnoDB 用間隙鎖與 next-key lock（第 04 章 4.8 節）讓當前讀也看不到別人新增的列。所以「RR 會幻讀」這句話對 InnoDB 並不成立，面試時講出來要補上這個前提。

換句話說，**「隔離級別」是標準，各家實作各有加料**。看文件比背表格重要。

### 怎麼查目前的級別

```sql
-- MySQL
SELECT @@transaction_isolation;

-- PostgreSQL
SHOW transaction_isolation;
```

### 怎麼設定級別

設定的作用範圍有三種：只影響下一個交易、影響這條連線、影響全域。

MySQL：

```sql
-- 只影響「下一個」交易，用完就恢復
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;

BEGIN;
SELECT stock FROM products WHERE id = 1001;
COMMIT;

-- 影響這條連線之後的所有交易
SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;

-- 影響全域，只對「之後建立的新連線」生效，重啟後失效
SET GLOBAL TRANSACTION ISOLATION LEVEL READ COMMITTED;
```

PostgreSQL 的寫法要放在交易「裡面」，而且必須在第一個查詢之前：

```sql
BEGIN;
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;

SELECT price FROM courses WHERE id = 1;
-- 其他操作

COMMIT;
```

也可以在 `BEGIN` 一次寫完：

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ;

SELECT price FROM courses WHERE id = 1;

COMMIT;
```

要改整條連線的預設值：

```sql
-- PostgreSQL
SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ;
```

**最常見的錯誤是設定太晚。** 交易已經跑過第一個 `SELECT` 才設級別，PostgreSQL 會直接報錯（`SET TRANSACTION ISOLATION LEVEL must be called before any query`），MySQL 的 `SET TRANSACTION`（不加 `SESSION`）在交易中也不允許。級別要在交易的第一行就決定。

另一個實務陷阱是 **ORM 與連線池**。連線池會把連線回收再借給別人，如果你用 `SET SESSION` 改了級別卻沒改回來，下一個借到這條連線的請求會莫名其妙跑在不同級別下。所以：

- 要改級別，優先用「只影響下一個交易」的寫法，或框架提供的交易級設定（例如 Spring 的 `@Transactional(isolation = ...)`）。
- 不要在應用程式的隨機位置下 `SET SESSION`。

### Serializable 的代價

Serializable 保證「結果等同於這些交易一個接一個跑」。兩家的實作機制不同，代價也不同：

- **PostgreSQL** 用 SSI（Serializable Snapshot Isolation）。它不加額外的讀鎖，而是追蹤交易之間的讀寫依賴，發現可能違反序列化就讓其中一個交易失敗，回傳 SQLSTATE `40001`（serialization failure）。
- **MySQL InnoDB** 把所有普通 `SELECT` 都隱式升級成 `SELECT ... FOR SHARE`（加共享鎖），靠鎖來達成序列化。代價是等待變長、死鎖變多。

兩者的共同結論：**用 Serializable 就必須寫重試迴圈。**

```text
attempt = 0
loop:
  attempt += 1
  BEGIN ISOLATION LEVEL SERIALIZABLE
    ... 業務邏輯 ...
  COMMIT
  if success: return
  if error is serialization_failure (SQLSTATE 40001) and attempt < 3:
    ROLLBACK
    sleep a short random time
    continue
  else:
    ROLLBACK
    raise
```

重試前要 sleep 一小段隨機時間，避免兩個交易同步重試、同步再撞一次。

沒有重試的 Serializable 只是把併發問題換成「偶發的 500 錯誤」，而且更難查。

### 實務建議

多數系統使用資料庫預設隔離級別即可：

- PostgreSQL 預設：Read Committed。
- MySQL InnoDB 預設：Repeatable Read。

遇到庫存、搶票、金流這種高風險場景，**不要靠調高隔離級別解決**。原因下一節會講清楚：隔離級別管的是「你讀到什麼」，它擋得住讀異常，但擋不住「更新丟失」。真正的保護來自：

- 條件更新，例如 `WHERE stock > 0`（見 2.15）。
- row lock，例如 `SELECT ... FOR UPDATE`。
- unique constraint 防重。
- 交易包住關鍵流程。

**心智模型**：隔離級別決定「你讀到什麼」，鎖與條件更新決定「你能不能安全地寫」。前者調不出後者。

---

## 2.13 MVCC：為什麼讀不用等寫

上一節說 Read Committed 不會髒讀。但資料庫是怎麼做到的？

最直覺的想法是加讀鎖：寫的人鎖住資料，讀的人等它 commit。這樣確實不會髒讀，但代價很大——只要有人在寫，所有讀都要排隊。讀多寫少的系統會被這件事拖死。

PostgreSQL 與 MySQL InnoDB 都不這樣做。它們用 **MVCC（Multi-Version Concurrency Control，多版本併發控制）**：

```text
同一筆資料同時存在多個版本。
寫入時建立新版本，不覆蓋舊版本。
讀取時根據自己的「快照」決定該看哪個版本。
```

結論就是那句最重要的話：**讀不阻塞寫，寫不阻塞讀。**

### 一筆資料的多個版本

以課程價格為例。原價 1200，交易 A 把它改成 1500 但還沒 commit：

```text
courses id = 1 的版本鏈：

  [price = 1500]  ← 交易 A 建立，尚未提交
        ↓
  [price = 1200]  ← 已提交的版本
```

這時交易 B 來讀。它從自己的快照判斷出「交易 A 還沒提交」，於是跳過 1500 這個版本，往下讀到 1200。**不用等，也不會髒讀。**

兩家的實作細節不同，但這個差異會直接影響你的維運工作：

- **PostgreSQL**：新版本直接寫在資料頁裡，每一列都有 `xmin`（哪個交易建立的）與 `xmax`（哪個交易刪除的）。舊版本留在原地變成死列（dead tuple），由 `VACUUM` 事後清掉。所以 PostgreSQL 的表會膨脹（bloat），需要 autovacuum 照顧。
- **MySQL InnoDB**：資料頁只放最新版本，舊版本寫進 undo log，用列上的回滾指標串成版本鏈。要讀舊版本就沿著鏈往回找。長交易會讓 undo log 一直清不掉，撐大 undo tablespace，也讓版本鏈越來越長、讀越來越慢。

在 PostgreSQL 可以直接看到版本欄位：

```sql
SELECT xmin, xmax, id, title, price
FROM courses
WHERE id = 1;
```

### 快照什麼時候建立：RC 與 RR 的真正差別

理解 MVCC 之後，Read Committed 與 Repeatable Read 的差別就只剩一句話：**快照建立的時機不同。**

```text
Read Committed   → 每個 SELECT 各自建一個新快照
Repeatable Read  → 交易第一次讀的時候建一個快照，之後整個交易共用
```

這就解釋了為什麼 RC 會不可重複讀、RR 不會。

Read Committed：

```text
交易 A（Read Committed）           交易 B
-------------------------------    ---------------------------
BEGIN
SELECT price → 1200
                                   UPDATE price = 1500
                                   COMMIT
SELECT price → 1500   ← 新快照，看到新值
COMMIT
```

Repeatable Read：

```text
交易 A（Repeatable Read）          交易 B
-------------------------------    ---------------------------
BEGIN
SELECT price → 1200   ← 建立快照
                                   UPDATE price = 1500
                                   COMMIT
SELECT price → 1200   ← 沿用同一個快照
COMMIT
```

注意第二段：交易 A 第二次讀到的 1200 **已經不是資料庫的現況了**。這是 RR 的設計取捨——它保證你在一個交易裡看到的世界是一致的，代價是這個世界可能是舊的。

一個推論：**RR 下的報表查詢很安全，RR 下的「讀了再寫」很危險。** 前者要的正是一致快照；後者基於舊值做決定，會出事，往下看。

### 快照讀與當前讀

MVCC 只作用在「快照讀」上。同一個交易裡有兩種讀法，走的是完全不同的路徑：

| 類型 | 語法 | 讀到什麼 | 會不會加鎖 |
|------|------|----------|------------|
| 快照讀 | 普通 `SELECT` | 快照版本，可能是舊的 | 不加鎖 |
| 當前讀 | `SELECT ... FOR UPDATE`、`SELECT ... FOR SHARE`、`UPDATE`、`DELETE`、`INSERT` | 最新已提交版本 | 加鎖 |

**`UPDATE` 本身是當前讀**，這點最容易被忽略，也正是下一段那個 bug 的解法所在。

### MVCC 擋不住的：更新丟失

這是本節最重要的結論。

假設兩個管理員同時要幫同一門課加價 100 元，隔離級別是 Repeatable Read：

```sql
-- 交易 A
BEGIN;

SELECT price FROM courses WHERE id = 1;   -- 快照讀，讀到 1200
-- 應用程式算出 1200 + 100 = 1300
UPDATE courses SET price = 1300 WHERE id = 1;

COMMIT;
```

```sql
-- 交易 B，同時執行
BEGIN;

SELECT price FROM courses WHERE id = 1;   -- 也讀到 1200
-- 應用程式算出 1200 + 100 = 1300
UPDATE courses SET price = 1300 WHERE id = 1;

COMMIT;
```

結果：**加了兩次價，價格卻只變成 1300。** 有一次更新憑空消失了，這叫 Lost Update（更新丟失）。

隔離級別在這裡完全沒幫上忙，因為兩個交易「各自都沒讀到不一致的資料」——它們讀的都是合法快照。MVCC 防的是讀異常，不是這種「讀出來 → 在應用程式裡算 → 寫回去」的流程。

兩家的行為還不一樣，這讓問題更陰險：

- **PostgreSQL 的 Repeatable Read**：交易 B 的 `UPDATE` 會偵測到這一列已被別人改過，直接報 `40001` serialization failure。你會看到錯誤，至少知道出事了。
- **MySQL InnoDB 的 Repeatable Read**：不會報錯。交易 B 的 `UPDATE` 是當前讀，會等交易 A 提交，然後把 1300 寫上去。**靜靜地丟掉一次更新。**

所以不能依賴隔離級別，要靠寫法。三種修法：

**修法 1：讓資料庫算，不要在應用程式算。**

```sql
UPDATE courses
SET price = price + 100
WHERE id = 1;
```

`UPDATE` 是當前讀，`price + 100` 會基於最新已提交值計算。兩個交易一前一後執行，結果是 1400，正確。

這是最簡單也最該優先考慮的做法。**能寫成一句 SQL 的更新，就不要拆成讀 + 算 + 寫。**

**修法 2：當前讀 + 鎖住。** 讀出來之後真的要在應用程式做複雜判斷時用這招：

```sql
BEGIN;

SELECT price FROM courses WHERE id = 1 FOR UPDATE;   -- 當前讀，鎖住這一列

-- 應用程式做判斷、算出新價格 1300

UPDATE courses SET price = 1300 WHERE id = 1;

COMMIT;
```

`FOR UPDATE` 讓交易 B 卡在 `SELECT` 這一行等待，直到 A 提交後才讀到 1300，於是算出 1400。

**修法 3：版本號條件更新（樂觀鎖）。** 不想在讀的時候就鎖住資料時用這招：

```sql
-- courses 加一個版本欄位
ALTER TABLE courses ADD COLUMN version INT NOT NULL DEFAULT 0;
```

```sql
-- 先讀出 price 與 version
SELECT price, version FROM courses WHERE id = 1;
-- 假設讀到 price = 1200, version = 5

-- 更新時檢查版本還是不是我讀到的那個
UPDATE courses
SET price = 1300,
    version = version + 1
WHERE id = 1
  AND version = 5;
```

如果 affected rows = 0，代表期間有人改過，重讀重算再試。完整討論見第 04 章 4.7 節。

**心智模型**：MVCC 給你「一致的視角」，不給你「安全的寫入」。任何「讀出來 → 在程式裡算 → 寫回去」的流程，都必須自己補上鎖、條件更新或版本號。

### 長交易的代價

MVCC 有一個實務上很容易踩的副作用：**只要有一個交易還沒結束，資料庫就不能清掉它可能還需要讀的舊版本。**

一個忘記 commit 的交易掛在那裡幾小時，會造成：

- PostgreSQL：autovacuum 清不掉死列，表與索引持續膨脹，全表掃描要讀的頁越來越多，查詢越來越慢。極端情況還會逼近 transaction ID 耗盡。
- MySQL：undo log 無法回收，磁碟被吃掉；別人的快照讀要沿著超長的版本鏈往回找，讀取變慢。

所以有兩條紀律：

- **交易要短。** 不要在交易裡呼叫外部 API、等使用者輸入、寄信、跑報表。
- **不要開了交易就忘記關。** 連線池把連線還回去時如果交易還開著，這條連線之後的行為會非常難查。

查目前最久的交易：

```sql
-- PostgreSQL
SELECT pid,
       now() - xact_start AS duration,
       state,
       query
FROM pg_stat_activity
WHERE xact_start IS NOT NULL
ORDER BY duration DESC
LIMIT 5;
```

```sql
-- MySQL
SELECT trx_id,
       trx_started,
       TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS seconds,
       trx_state,
       trx_query
FROM information_schema.innodb_trx
ORDER BY trx_started
LIMIT 5;
```

看到一個 `state = 'idle in transaction'`（PostgreSQL）或 `trx_state = 'RUNNING'` 但 `trx_query` 是 NULL（MySQL）而且已經跑了幾十分鐘的交易，幾乎可以確定是應用程式忘記 commit 或 rollback。

---

## 2.14 交易範例：轉帳

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

## 2.15 交易範例：扣庫存建立訂單

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

## 2.16 UPSERT 與 RETURNING：把兩次往返變成一次原子寫入

到目前為止的寫入都有一個共同前提：**你已經知道那一列存不存在。**

實務上很多需求不是這樣，而是「有就更新，沒有就新增」：

- 記錄單元學習進度：第一次要 `INSERT`，之後要 `UPDATE`。
- 每日統計計數器：當天第一筆要建列，後續要累加。
- 匯入外部資料：同一批可能重跑，不能因為重複就整批失敗。

這節處理兩件事：怎麼把這種流程壓成一句原子的 SQL（UPSERT），以及怎麼讓寫入順手把結果帶回來（`RETURNING`），不用再多查一次。

### 反例：先查再決定 INSERT 還是 UPDATE

最直覺的寫法：

```text
row = SELECT id FROM purchases WHERE user_id = 1 AND course_id = 10

if row is None:
    INSERT INTO purchases (user_id, course_id, amount, status)
    VALUES (1, 10, 1200.00, 'paid')
else:
    UPDATE purchases SET amount = 1200.00, status = 'paid' WHERE id = row.id
```

單一請求下完全正確，併發下有兩種壞法。

壞法一：兩個請求都查到不存在。

```text
請求 A：SELECT → 沒有
請求 B：SELECT → 沒有
請求 A：INSERT → 成功
請求 B：INSERT → 撞到 UNIQUE (user_id, course_id)，拋錯
```

使用者看到 500。這其實就是 2.17 節錯誤 2（只靠後端檢查唯一性）的同一個問題，只是多了一個 UPDATE 分支包裝。

壞法二：沒有唯一約束時更安靜。

```text
請求 A：SELECT → 沒有
請求 B：SELECT → 沒有
請求 A：INSERT → 成功
請求 B：INSERT → 也成功
```

現在有兩列重複資料，沒有任何錯誤訊息。這比拋 500 難查得多。

**根因跟 2.13 節的更新丟失一樣：`SELECT` 的結果在你拿去用之前就過期了。** 修法也一樣——讓資料庫在一句話裡把「判斷」和「寫入」一起做完。

### PostgreSQL：`INSERT ... ON CONFLICT DO UPDATE`

```sql
INSERT INTO purchases (user_id, course_id, amount, status)
VALUES (1, 10, 1200.00, 'paid')
ON CONFLICT (user_id, course_id)
DO UPDATE SET amount = EXCLUDED.amount,
              status = EXCLUDED.status;
```

讀法：

- `ON CONFLICT (user_id, course_id)`：如果這組欄位撞到既有列。
- `DO UPDATE SET ...`：那就改成更新，不要拋錯。
- `EXCLUDED`：一張虛擬表，裝的是**這次沒插進去的那筆值**，也就是 `VALUES` 裡的 `1200.00` 和 `'paid'`。

整句是一個敘述，資料庫會在對應的唯一索引上加鎖，兩個請求不可能同時通過檢查。

想在更新分支裡混用新舊值也可以：

```sql
INSERT INTO purchases (user_id, course_id, amount, status)
VALUES (1, 10, 1200.00, 'paid')
ON CONFLICT (user_id, course_id)
DO UPDATE SET amount = EXCLUDED.amount,
              status = EXCLUDED.status,
              purchased_at = purchases.purchased_at;   -- 保留原本的購買時間
```

`EXCLUDED.欄位` 是新值，`purchases.欄位`（表名開頭）是舊值。

也能加條件，只在某些情況下才更新：

```sql
INSERT INTO purchases (user_id, course_id, amount, status)
VALUES (1, 10, 1200.00, 'paid')
ON CONFLICT (user_id, course_id)
DO UPDATE SET amount = EXCLUDED.amount,
              status = EXCLUDED.status
WHERE purchases.status <> 'paid';       -- 已經付款成功的不要覆蓋
```

`WHERE` 不成立時，這句既不新增也不更新，affected rows = 0。

### 累加型 UPSERT：這才是原子更新的重點

前面的例子是「用新值覆蓋舊值」，覆蓋誰先誰後其實差別不大。真正非原子不可的是**基於舊值計算新值**——也就是計數器。

加一張每日統計表：

```sql
CREATE TABLE course_daily_stats (
  course_id BIGINT NOT NULL REFERENCES courses(id),
  stat_date DATE NOT NULL,
  view_count BIGINT NOT NULL DEFAULT 0,
  purchase_count BIGINT NOT NULL DEFAULT 0,
  revenue NUMERIC(14, 2) NOT NULL DEFAULT 0,
  PRIMARY KEY (course_id, stat_date)
);
```

錯誤寫法（讀出來、加一、寫回去）：

```text
row = SELECT view_count FROM course_daily_stats
      WHERE course_id = 10 AND stat_date = CURRENT_DATE

if row is None:
    INSERT INTO course_daily_stats (course_id, stat_date, view_count)
    VALUES (10, CURRENT_DATE, 1)
else:
    UPDATE course_daily_stats SET view_count = row.view_count + 1
    WHERE course_id = 10 AND stat_date = CURRENT_DATE
```

這同時中了兩個雷：第一筆的競態（兩個請求都想 `INSERT`），以及 2.13 節的更新丟失（兩個請求都讀到 100，都寫回 101）。

正確寫法：

```sql
INSERT INTO course_daily_stats (course_id, stat_date, view_count)
VALUES (10, CURRENT_DATE, 1)
ON CONFLICT (course_id, stat_date)
DO UPDATE SET view_count = course_daily_stats.view_count + EXCLUDED.view_count;
```

關鍵是 `course_daily_stats.view_count + EXCLUDED.view_count`：

- 舊值來自資料庫的最新已提交值，不是應用程式手上那個過期的讀取。
- `EXCLUDED.view_count` 是這次要加的量。寫死 `+ 1` 也行，但用 `EXCLUDED` 才能支援批次——`VALUES (10, CURRENT_DATE, 50)` 就是一次加 50。

一次 upsert 多列也沒問題：

```sql
INSERT INTO course_daily_stats (course_id, stat_date, view_count)
VALUES
  (10, CURRENT_DATE, 3),
  (11, CURRENT_DATE, 7),
  (12, CURRENT_DATE, 1)
ON CONFLICT (course_id, stat_date)
DO UPDATE SET view_count = course_daily_stats.view_count + EXCLUDED.view_count;
```

### `ON CONFLICT DO NOTHING`：只要「不要重複」

有些需求根本不需要更新，重複時安靜跳過就好。標記單元完成就是典型：

```sql
INSERT INTO lesson_progress (user_id, lesson_id)
VALUES (1, 42)
ON CONFLICT (user_id, lesson_id) DO NOTHING;
```

使用者連點三下、前端重送、背景任務重跑，都只會有一列，而且不會拋錯。

不寫衝突欄位也可以，意思是「任何唯一約束衝突都跳過」：

```sql
INSERT INTO lesson_progress (user_id, lesson_id)
VALUES (1, 42)
ON CONFLICT DO NOTHING;
```

但**建議明確寫出欄位**。不寫的話，未來這張表多加一個唯一約束，這句會把那個衝突也一起吞掉，變成靜默失敗。

判斷有沒有真的插進去，靠 affected rows：

```text
affected_rows = 1：新插入的
affected_rows = 0：已經存在，這次沒動
```

### MySQL：`INSERT ... ON DUPLICATE KEY UPDATE`

MySQL 的語法不同，行為接近：

```sql
INSERT INTO course_daily_stats (course_id, stat_date, view_count)
VALUES (10, CURRENT_DATE, 1)
ON DUPLICATE KEY UPDATE view_count = view_count + VALUES(view_count);
```

MySQL 8.0.20 起 `VALUES()` 已標記為 deprecated，改用列別名：

```sql
INSERT INTO course_daily_stats (course_id, stat_date, view_count)
VALUES (10, CURRENT_DATE, 1) AS new
ON DUPLICATE KEY UPDATE view_count = view_count + new.view_count;
```

四個必須記住的差異：

| | PostgreSQL | MySQL |
|---|---|---|
| 指定衝突欄位 | `ON CONFLICT (a, b)`，可以指定 | `ON DUPLICATE KEY`，**不能指定**，任何唯一鍵衝突都算 |
| 新值怎麼取 | `EXCLUDED.col` | `new.col`（舊寫法 `VALUES(col)`） |
| 加條件 | 支援 `DO UPDATE ... WHERE` | 不支援，只能在 `SET` 裡用 `IF()` 繞 |
| 跳過重複 | `ON CONFLICT DO NOTHING` | `INSERT IGNORE`，或 `ON DUPLICATE KEY UPDATE id = id` |

「不能指定衝突欄位」是最容易踩的。假設 `purchases` 除了 `UNIQUE (user_id, course_id)` 之外，還有一個 `UNIQUE (external_ref)`，MySQL 的 `ON DUPLICATE KEY UPDATE` 撞到哪一個都會走同一個更新分支——可能改到一列完全不是你要改的資料。

另外 MySQL 的 affected rows 語意跟其他資料庫不一樣：

```text
1：新插入
2：更新了既有列（不是 1）
0：既有列的值跟要寫入的值完全相同，沒有實際變動
```

想用 affected rows 判斷「這是新的還是舊的」時，一定要記得這個 2。

至於 `INSERT IGNORE`，它會把型別轉換錯誤、`NOT NULL` 違反之類的錯誤也一起降級成 warning，範圍比 `ON CONFLICT DO NOTHING` 大得多。能用 `ON DUPLICATE KEY UPDATE` 就不要用它。

### 前提：一定要有 UNIQUE 或 PRIMARY KEY

UPSERT 是靠唯一索引偵測衝突的。沒有對應的約束，就沒有衝突可言。

假設 `purchases` 上沒有 `UNIQUE (user_id, course_id)`：

```sql
INSERT INTO purchases (user_id, course_id, amount, status)
VALUES (1, 10, 1200.00, 'paid')
ON CONFLICT (user_id, course_id) DO UPDATE SET amount = EXCLUDED.amount;
```

PostgreSQL 會直接報錯：

```text
ERROR:  there is no unique or exclusion constraint matching the ON CONFLICT specification
```

MySQL 更危險——沒有唯一鍵時 `ON DUPLICATE KEY UPDATE` 永遠不會觸發，每次都是純 `INSERT`，於是安靜地累積重複列。

**所以順序是：先設計唯一約束，才有 UPSERT。** 這回頭印證了第 01 章的建模結論——唯一性是資料模型的一部分，不是應用層的檢查。

### `RETURNING`：寫入完順手把結果帶回來

2.3 與 2.5 節提過 `RETURNING` 可以拿到新增或更新後的資料。放到原子更新的場景，它解決一個具體問題：**寫完之後想知道現在的值，不用也不該再查一次。**

錯誤示範：

```text
UPDATE course_daily_stats SET view_count = view_count + 1
WHERE course_id = 10 AND stat_date = CURRENT_DATE

SELECT view_count FROM course_daily_stats
WHERE course_id = 10 AND stat_date = CURRENT_DATE
```

第二句查到的不一定是第一句的結果——中間可能有別的請求又加了好幾次。你拿到的是「某個時刻的值」，不是「我這次加完的值」。

`RETURNING` 讓 `UPDATE` 自己回答：

```sql
UPDATE course_daily_stats
SET view_count = view_count + 1
WHERE course_id = 10
  AND stat_date = CURRENT_DATE
RETURNING view_count;
```

回傳的就是這次加完的那個值，因為它來自 `UPDATE` 自己寫下的那個版本。少一次往返，也沒有中間狀態的問題。

UPSERT 一樣可以接：

```sql
INSERT INTO course_daily_stats (course_id, stat_date, view_count)
VALUES (10, CURRENT_DATE, 1)
ON CONFLICT (course_id, stat_date)
DO UPDATE SET view_count = course_daily_stats.view_count + EXCLUDED.view_count
RETURNING view_count;
```

`DELETE` 也可以，常用來「取出並刪除」：

```sql
DELETE FROM lesson_progress
WHERE user_id = 1 AND lesson_id = 42
RETURNING completed_at;
```

`RETURNING` 是 PostgreSQL 的功能，MySQL 8 沒有（MariaDB 10.5+ 有部分支援）。MySQL 要在同一個交易裡補一句 `SELECT`：

```sql
BEGIN;

UPDATE course_daily_stats
SET view_count = view_count + 1
WHERE course_id = 10 AND stat_date = CURRENT_DATE;

SELECT view_count FROM course_daily_stats
WHERE course_id = 10 AND stat_date = CURRENT_DATE;

COMMIT;
```

這樣是安全的：`SELECT` 讀得到自己剛寫的值，而那一列還被自己的交易鎖著，別人的更新進不來。代價是多一次往返，而且交易持鎖時間變長。

### 條件更新 + `RETURNING`：扣庫存同時知道剩幾件

2.15 節的扣庫存靠 affected rows 判斷成功失敗：

```sql
UPDATE products
SET stock = stock - 1
WHERE id = 1001
  AND stock >= 1;
```

扣成功了，但還剩幾件？再 `SELECT` 一次就回到剛才那個問題——查到的可能已經被別人扣過。

加上 `RETURNING`：

```sql
UPDATE products
SET stock = stock - 1
WHERE id = 1001
  AND stock >= 1
RETURNING id, stock;
```

一句話同時給你三個答案：

```text
回傳 0 列        → 庫存不足或商品不存在，不要建訂單
回傳 1 列        → 扣成功
回傳的 stock 值  → 扣完後還剩幾件（可以直接回給前端，或觸發補貨通知）
```

`RETURNING` 回傳的列數就是 affected rows，所以連 affected rows 都不用另外問。這是條件更新最完整的寫法，第 04 章的搶票會直接用它。

### UPSERT 不是萬靈丹

三個實務上會咬人的地方。

**一：高併發下 UPSERT 也會死鎖。** 一句 UPSERT 是原子的，但它仍然要在唯一索引上加鎖。批次 upsert 多列時，如果兩個交易送進來的列順序不同，就是典型的交叉鎖等待：

```text
交易 A：upsert (course 10, course 11)
交易 B：upsert (course 11, course 10)
```

修法跟第 04 章講死鎖時一樣——**在應用程式端先把批次資料依主鍵排序**，讓所有交易用同一個順序加鎖。

**二：`ON CONFLICT DO NOTHING` 配 `RETURNING` 會回傳 0 列。** 因為沒有列被寫入，就沒有列可以回傳：

```sql
INSERT INTO lesson_progress (user_id, lesson_id)
VALUES (1, 42)
ON CONFLICT (user_id, lesson_id) DO NOTHING
RETURNING completed_at;      -- 已存在時：0 列，不是既有那一列
```

如果需要「不管新舊都要拿到那一列」，改用 `DO UPDATE` 寫一個無害的更新：

```sql
INSERT INTO lesson_progress (user_id, lesson_id)
VALUES (1, 42)
ON CONFLICT (user_id, lesson_id)
DO UPDATE SET user_id = lesson_progress.user_id   -- 值沒變，但這列算被更新
RETURNING completed_at;
```

**三：PostgreSQL 的 UPSERT 走到更新分支也會消耗序號。** `BIGSERIAL` 的序號在嘗試插入時就取走了，走到 `DO UPDATE` 不會還回去。所以 id 會出現空洞，這是正常的——**不要把自增 id 當成筆數用**。

最後一個判斷原則：UPSERT 適合「這筆資料應該存在，內容以最新一次為準」或「累加」。如果業務上真的要區分「這是第一次還是第 N 次」並走完全不同的流程（例如第一次要寄歡迎信、之後不要），就不要把這個判斷藏在 UPSERT 裡，要把「是新增還是更新」明確帶回應用程式再分流。MySQL 看 affected rows 是 1 還是 2 就知道；PostgreSQL 沒有直接的辦法，實務上常用系統欄位 `xmax` 判斷：

```sql
INSERT INTO purchases (user_id, course_id, amount, status)
VALUES (1, 10, 1200.00, 'paid')
ON CONFLICT (user_id, course_id)
DO UPDATE SET amount = EXCLUDED.amount
RETURNING id, (xmax = 0) AS is_insert;
```

`xmax = 0` 代表這列是這次新插入的，非 0 代表走了更新分支。這是依賴實作細節的技巧，能用就用，但別把關鍵業務邏輯建在它上面——真正重要的分流，寧可拆成兩句 SQL 寫清楚。

---

## 2.17 常見錯誤

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

### 錯誤 4：想用調高隔離級別解決併發寫入問題

危險想法：

```text
「扣庫存會出錯？那我把隔離級別調到 Serializable 就好了。」
```

兩個問題：

- Serializable 會讓吞吐大幅下降，而且會冒出你沒處理的 `40001` 錯誤（PostgreSQL）或大量鎖等待與死鎖（MySQL）。沒有重試迴圈的話，使用者看到的是偶發 500。
- 就算調到 Serializable，「讀出來 → 在程式裡算 → 寫回去」這種流程仍然要靠鎖或條件更新才安全。級別不是萬能開關。

正確順序是：先把 SQL 寫對（條件更新、`price = price + 100`、唯一約束），再考慮要不要動級別。

### 錯誤 5：以為 Repeatable Read 讀到的就是現況

危險流程：

```text
1. BEGIN（Repeatable Read）
2. SELECT stock FROM products WHERE id = 1001  → 讀到 5
3. 別的交易把 stock 扣到 0 並 commit
4. 應用程式相信 stock 還是 5，建立 5 筆訂單
5. COMMIT
```

RR 保證的是「這個交易裡看到的世界一致」，不是「看到的是最新的」。要拿最新值就得用當前讀：

```sql
SELECT stock FROM products WHERE id = 1001 FOR UPDATE;
```

或者根本不要讀，直接條件更新。

### 錯誤 6：用 `SET SESSION` 改隔離級別卻沒改回來

危險流程：

```text
1. 從連線池借到連線 C
2. SET SESSION TRANSACTION ISOLATION LEVEL SERIALIZABLE
3. 跑完業務，把連線 C 還回連線池
4. 另一個請求借到連線 C，在不知情的情況下跑在 Serializable 下
```

症狀是「同一段程式碼有時候正常、有時候噴 40001」，而且完全無法穩定重現。

解法：用只影響下一個交易的寫法，或交給框架的交易註解管理，不要手動下 `SET SESSION`。

### 錯誤 7：在交易裡呼叫外部 API

危險流程：

```text
BEGIN
  UPDATE orders SET status = 'paid' WHERE id = 1
  呼叫金流 API（可能耗時 3 秒，也可能超時 30 秒）
  UPDATE accounts SET balance = balance - 100 WHERE id = 1
COMMIT
```

這條交易的存活時間變成外部服務的響應時間。後果是鎖被長時間持有、MVCC 舊版本無法回收、連線池被占滿。

解法：交易只包資料庫操作。外部呼叫拆到交易之外，用狀態機加冪等鍵串起來（見第 04 章 4.14、4.18 節）。

---

## 2.18 本章練習

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

### 練習 7：判斷會出現哪種異常

需求：

以下三段時序，各自在 Read Committed 與 Repeatable Read 下會發生什麼？請說出異常名稱，或說明為什麼沒有異常。

情境 A：

```text
交易 X                          交易 Y
------------------------------  ---------------------------
BEGIN
SELECT price WHERE id=1 → 1200
                                BEGIN
                                UPDATE price=1500 WHERE id=1
                                COMMIT
SELECT price WHERE id=1 → ?
COMMIT
```

情境 B：

```text
交易 X                          交易 Y
------------------------------  ---------------------------
BEGIN
SELECT COUNT(*) WHERE price>1000 → 5
                                BEGIN
                                INSERT price=1500
                                COMMIT
SELECT COUNT(*) WHERE price>1000 → ?
COMMIT
```

情境 C：

```text
交易 X                          交易 Y
------------------------------  ---------------------------
                                BEGIN
                                UPDATE price=100 WHERE id=1
BEGIN
SELECT price WHERE id=1 → ?
                                ROLLBACK
COMMIT
```

#### 參考解答

情境 A：不可重複讀。

- Read Committed：第二次讀到 **1500**。每個 `SELECT` 建立新快照，看得到 Y 提交後的值。這就是不可重複讀。
- Repeatable Read：第二次讀到 **1200**。整個交易共用第一次讀取時建立的快照。沒有異常。

情境 B：幻讀。

- Read Committed：第二次是 **6**，出現幻讀。
- PostgreSQL Repeatable Read：**5**。快照固定，看不到新增的列。
- MySQL Repeatable Read：**5**。`COUNT(*)` 是快照讀，同樣看不到。但如果改成 `SELECT ... FOR UPDATE`（當前讀），InnoDB 會用間隙鎖直接把交易 Y 的 `INSERT` 卡住，所以也不會幻讀。

情境 C：髒讀，但實際上讀不到。

- 這段時序想製造髒讀：交易 X 在 Y 尚未提交時讀取。
- MySQL 與 PostgreSQL 的預設級別都不會髒讀，X 讀到的是 **1200**（Y 修改前的已提交版本）。
- 只有 MySQL 明確設成 Read Uncommitted 才會讀到 100，然後 Y rollback，X 手上就是一個從未存在過的值。
- PostgreSQL 就算你設成 Read Uncommitted 也一樣讀到 1200——它沒有真正的 Read Uncommitted。

### 練習 8：修掉更新丟失

需求：

以下程式碼要把使用者購買紀錄的金額打九折。目前的寫法在兩個請求同時執行時會出錯，請找出問題並提出兩種修法。

```text
# 目前的寫法
row = SELECT amount FROM purchases WHERE id = 500
new_amount = row.amount * 0.9
UPDATE purchases SET amount = new_amount WHERE id = 500
```

#### 參考解答

問題是更新丟失。兩個請求都讀到原始金額 1000，各自算出 900，最後結果是 900——只打了一次九折，另一次憑空消失。

調高隔離級別修不掉它：兩個交易讀的都是合法快照，Repeatable Read 在 MySQL 下不會報錯，只會靜靜地讓一次更新消失。

修法 1：讓資料庫算。

```sql
UPDATE purchases
SET amount = amount * 0.9
WHERE id = 500;
```

`UPDATE` 是當前讀，`amount * 0.9` 基於最新已提交值計算。兩個請求一前一後跑，結果是 810，正確。

修法 2：當前讀加鎖。

```sql
BEGIN;

SELECT amount FROM purchases WHERE id = 500 FOR UPDATE;

-- 應用程式算出 new_amount

UPDATE purchases SET amount = 900 WHERE id = 500;

COMMIT;
```

`FOR UPDATE` 讓第二個請求卡在 `SELECT` 等待，直到第一個提交後才讀到 900，於是算出 810。

修法 3（也可以）：加版本號做條件更新，affected rows = 0 就重讀重試。

哪一種比較好？**只要能寫成一句 SQL 就用修法 1。** 修法 2 適合「讀出來之後真的要做複雜判斷」的情況，代價是持鎖時間變長。

---

### 練習 9：把「先查再寫」改成原子寫入

需求：

以下是「使用者觀看課程時累加當日觀看次數，並回傳累加後的總數」的實作。請找出兩個併發問題，改寫成一句 SQL，並讓它直接回傳累加後的值。

資料表：

```sql
CREATE TABLE course_daily_stats (
  course_id BIGINT NOT NULL REFERENCES courses(id),
  stat_date DATE NOT NULL,
  view_count BIGINT NOT NULL DEFAULT 0,
  purchase_count BIGINT NOT NULL DEFAULT 0,
  revenue NUMERIC(14, 2) NOT NULL DEFAULT 0,
  PRIMARY KEY (course_id, stat_date)
);
```

目前的寫法：

```text
row = SELECT view_count FROM course_daily_stats
      WHERE course_id = 10 AND stat_date = CURRENT_DATE

if row is None:
    INSERT INTO course_daily_stats (course_id, stat_date, view_count)
    VALUES (10, CURRENT_DATE, 1)
    new_count = 1
else:
    UPDATE course_daily_stats SET view_count = row.view_count + 1
    WHERE course_id = 10 AND stat_date = CURRENT_DATE
    new_count = row.view_count + 1

return new_count
```

#### 參考解答

**問題 1：當天第一筆的競態。** 兩個請求同時進來、都查到 `None`，於是都走 `INSERT` 分支。因為 `PRIMARY KEY (course_id, stat_date)` 存在，第二個請求會撞主鍵衝突拋錯，使用者看到 500。

**問題 2：後續每一筆都可能更新丟失。** 兩個請求都讀到 `view_count = 100`，各自算出 101，各自寫回 101。實際看了兩次，帳上只加了一次。這是 2.13 節的更新丟失，調高隔離級別修不掉——MySQL 的 RR 不會報錯，只會靜靜地讓一次更新消失。

順便一個第三個問題：`new_count` 是應用程式自己算的，就算寫入成功，這個數字也不保證等於資料庫裡的現值。

改寫成一句累加型 UPSERT 配 `RETURNING`：

```sql
INSERT INTO course_daily_stats (course_id, stat_date, view_count)
VALUES (10, CURRENT_DATE, 1)
ON CONFLICT (course_id, stat_date)
DO UPDATE SET view_count = course_daily_stats.view_count + EXCLUDED.view_count
RETURNING view_count;
```

三個問題一起解決：

- 第一筆走 `INSERT`、後續走 `DO UPDATE`，判斷在資料庫裡完成，沒有競態。
- 累加寫成 `course_daily_stats.view_count + EXCLUDED.view_count`，舊值取自最新已提交值，不是應用程式手上的過期讀取。
- `RETURNING view_count` 回傳的就是這次加完的值，不需要應用程式自己算，也不需要再查一次。

MySQL 版本（沒有 `RETURNING`，要在同一個交易裡補查）：

```sql
BEGIN;

INSERT INTO course_daily_stats (course_id, stat_date, view_count)
VALUES (10, CURRENT_DATE, 1) AS new
ON DUPLICATE KEY UPDATE view_count = view_count + new.view_count;

SELECT view_count FROM course_daily_stats
WHERE course_id = 10 AND stat_date = CURRENT_DATE;

COMMIT;
```

進階問題：如果需求改成「一次批次寫入多門課的觀看數」，還要注意什麼？

答：多列 upsert 要**先依主鍵排序再送**。否則兩個交易用不同順序碰同一批列，會在唯一索引上形成交叉鎖等待，變成死鎖。

---

## 2.19 驗收清單

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
- [ ] 我能畫出四種隔離級別與三種異常的對照表，並說出 PostgreSQL 無 Read Uncommitted、InnoDB 的 RR 不幻讀這兩個實作偏差。
- [ ] 我知道怎麼查與設定隔離級別，也知道級別必須在交易第一行就決定。
- [ ] 我知道用 Serializable 一定要寫重試迴圈處理 SQLSTATE 40001。
- [ ] 我能用 MVCC 解釋為什麼讀不用等寫，以及 RC 與 RR 的差別只在快照建立時機。
- [ ] 我能分辨快照讀與當前讀，並知道 `UPDATE` 是當前讀。
- [ ] 我能舉出更新丟失的例子，並說明為什麼調高隔離級別修不掉它。
- [ ] 我知道 MySQL 的 RR 遇到更新丟失不會報錯，PostgreSQL 的 RR 會報 40001。
- [ ] 我知道長交易會造成 PostgreSQL 表膨脹與 MySQL undo log 堆積，也知道怎麼查出它。
- [ ] 我知道扣庫存要使用條件更新並檢查 affected rows。
- [ ] 我知道「先查再決定 INSERT 或 UPDATE」在併發下會撞唯一約束，或安靜地產生重複列。
- [ ] 我能寫 PostgreSQL 的 `ON CONFLICT DO UPDATE` / `DO NOTHING`，也能寫 MySQL 的 `ON DUPLICATE KEY UPDATE`，並說出兩者的差異。
- [ ] 我知道 UPSERT 必須有 `UNIQUE` 或 `PRIMARY KEY` 才會觸發，MySQL 少了唯一鍵會安靜地累積重複列。
- [ ] 我會用累加型 UPSERT（`EXCLUDED`）做計數器，而不是讀出來加一再寫回去。
- [ ] 我知道 MySQL 的 affected rows 在更新既有列時是 2 而不是 1。
- [ ] 我會用 `RETURNING` 在條件更新的同一句話裡拿到扣後的值與 affected rows。
- [ ] 我知道 `ON CONFLICT DO NOTHING` 配 `RETURNING` 在衝突時回傳 0 列。

---

完成後請前往 [03-index-query-performance-optimization.md](./03-index-query-performance-optimization.md)。
