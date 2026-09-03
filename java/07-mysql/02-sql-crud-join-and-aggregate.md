# 第 02 章：SQL 核心 —— JOIN 與聚合

> 01 章結束時你有了七張表。這一章開始查它們。
>
> ⚠️ 但這一章**不是 SQL 語法教學**。
> 如果你需要「`SELECT` 怎麼寫」，任何一份教學文件都比這一章適合。
>
> 這一章要處理的是另一種東西：
>
> > **那些會跑、不會報錯、而且回傳一個看起來很合理的錯答案的 SQL。**
>
> 先看一個。這一句是「本月營業額」：
>
> ```sql
> SELECT SUM(o.total_amount) FROM orders o JOIN order_item i ON i.order_id = o.id;
> ```
>
> ```
> 23210.0000
> ```
>
> **真正的答案是 11380。它多報了 104%。**
>
> 這一句沒有語法錯誤、沒有警告、`EXPLAIN` 看起來很正常，
> 而且它會出現在你的營運後台首頁上，每天。
>
> 📌 **本章有 12 個這種形狀的實測**：
> `LEFT JOIN` 悄悄變回 `INNER JOIN`、
> `NOT IN` 回傳零列、
> 累計金額在並列處出現重複值、
> `GROUP_CONCAT` 靜默截斷、
> `REPLACE INTO` 把你的欄位清成 `NULL`、
> 以及一句 `WHERE phone = 912345678` 查出**三個不同的電話號碼**。

---

## 2.1 學習目標

完成本章後，你應該可以：

- 說出一句 `SELECT` 的**邏輯執行順序**，並用它解釋為什麼 `WHERE` 不能用 `SELECT` 的別名、`HAVING` 卻可以。
- 分辨 `INNER` / `LEFT` / `RIGHT` / `CROSS` JOIN，並解釋 MySQL 為什麼**沒有** `FULL OUTER JOIN`（以及怎麼模擬）。
- 判斷一個條件該放 `ON` 還是 `WHERE` ——
  並用實測說明：**同一個條件換一個位置，`LEFT JOIN` 就變回 `INNER JOIN`**。
- 認出**列數膨脹**：一對多 JOIN 之後 `SUM` / `COUNT` / `AVG` 全部會重複計算
  （實測：營業額從 11380 變成 **23210**）。
- 說出 `COUNT(*)` / `COUNT(col)` / `COUNT(DISTINCT col)` / `COUNT(1)` 的差別與各自的用途。
- 解釋 `ONLY_FULL_GROUP_BY` 檢查的其實是**函式依賴**，而不是「欄位有沒有出現在 GROUP BY」。
- 說出 `GROUP_CONCAT` 的預設上限（**1024 位元組**）與它**靜默截斷**的行為。
- 判斷 `IN` / `EXISTS` / `JOIN` / `LEFT JOIN ... IS NULL` 四種寫法什麼時候**答案不同**，
  並解釋一個實測：**`NOT EXISTS` 回傳 3 列，而「修好 NULL 之後的 `NOT IN`」只回傳 1 列**。
- 用視窗函式解決 `GROUP BY` 做不到的三類問題（明細+總和並列、每組前 N 名、跟上一列比較）。
- 說出視窗函式的**預設框架是 `RANGE`**，並示範它在有並列值時算出的累計金額是錯的。
- 在 `INSERT ... ON DUPLICATE KEY UPDATE` / `REPLACE INTO` / `INSERT IGNORE` 之間做出有理由的選擇，
  並說出 `ROW_COUNT()` 的三種回傳值（**1 / 2 / 0**）分別代表什麼。
- 認出**隱式轉型**，並解釋為什麼它是 03 章「索引失效」的第一名。

---

## 2.2 一句 SQL 的執行順序

**這一節是本章的地基。** 本章大約一半的陷阱，都可以用這張圖解釋。

### 2.2.1 書寫順序 ≠ 邏輯執行順序

```
你【寫】的順序                       資料庫【想】的順序
─────────────────────           ──────────────────────────────
SELECT      ①                    ①  FROM / JOIN     ← 先決定「有哪些列」
FROM        ②                    ②  ON              ← JOIN 的配對條件
JOIN        ③                    ③  WHERE           ← 過濾【單列】
ON          ④                    ④  GROUP BY        ← 分組
WHERE       ⑤                    ⑤  聚合函式         ← COUNT / SUM / AVG
GROUP BY    ⑥                    ⑥  HAVING          ← 過濾【分組】
HAVING      ⑦                    ⑦  視窗函式         ← OVER (...)  ★ 在 HAVING 之後
ORDER BY    ⑧                    ⑧  SELECT          ← 算出要輸出的欄位、建立別名
LIMIT       ⑨                    ⑨  DISTINCT
                                 ⑩  ORDER BY        ← 這裡才看得到 SELECT 的別名
                                 ⑪  LIMIT / OFFSET  ← 最後才切
```

📌 **三個馬上有用的推論**：

```
① WHERE 在 SELECT 【之前】執行 → WHERE 看不到 SELECT 建立的別名
② 視窗函式在 HAVING 【之後】  → 不能在 WHERE / HAVING 裡過濾視窗函式的結果
③ LIMIT 在最後               → LIMIT 不會讓前面的 JOIN / 排序變少工作
```

### 2.2.2 實測：別名在哪裡能用、在哪裡不能用

```sql
SELECT total_amount - discount_amount AS net FROM orders WHERE net > 2000;
```

```
ERROR 1054 (42S22): Unknown column 'net' in 'where clause'
```

**因為 `WHERE`（③）比 `SELECT`（⑧）早執行，`net` 這個名字還不存在。**

```sql
SELECT order_no, total_amount - discount_amount AS net FROM orders HAVING net > 2000 ORDER BY order_no;
```

```
order_no             net
SO-2026-00000001     4450.0000
SO-2026-00000005     2430.0000
```

⚠️ **`HAVING` 可以** —— 這是 MySQL 對標準 SQL 的一個擴充
（標準 SQL 的 `HAVING` 只能用於聚合結果）。

```sql
SELECT order_no, total_amount - discount_amount AS net FROM orders ORDER BY net DESC LIMIT 3;   -- ✅
SELECT status AS st, COUNT(*) c FROM orders GROUP BY st ORDER BY st;                            -- ✅
```

```
st           c
CANCELLED    1
DELIVERED    2
PAID         1
PENDING      1
```

⚠️ **`GROUP BY` 也可以用別名** —— 這也是 MySQL 的擴充，**不要依賴它**：
換到 PostgreSQL 或 SQL Server 就不能用了。

**四個位置的總表**：

| 子句 | 能用 `SELECT` 的別名？ | 為什麼 |
|---|---|---|
| `ON` | 🔴 不能 | ② 在 ⑧ 之前 |
| `WHERE` | 🔴 不能 | ③ 在 ⑧ 之前 |
| `GROUP BY` | 🟡 **MySQL 可以**（非標準） | — |
| `HAVING` | 🟡 **MySQL 可以**（非標準） | — |
| `ORDER BY` | ✅ 可以（標準行為） | ⑩ 在 ⑧ 之後 |

> 📌 **兩種寫法，選可攜的那一種**：
>
> ```sql
> -- 🟡 依賴 MySQL 擴充
> SELECT total_amount - discount_amount AS net FROM orders HAVING net > 2000;
>
> -- ✅ 到哪都能跑，而且【走得到索引】（03 章：函式包住欄位會讓索引失效，
> --    但這裡是把常數移到右邊，欄位本身沒被包住）
> SELECT total_amount - discount_amount AS net FROM orders WHERE total_amount - discount_amount > 2000;
>
> -- ✅✅ 更好：用衍生表 / CTE，只寫一次運算式
> WITH x AS (SELECT order_no, total_amount - discount_amount AS net FROM orders)
> SELECT * FROM x WHERE net > 2000;
> ```

### 2.2.3 `WHERE` 與 `HAVING` 的真正差別

**不是「`HAVING` 用來過濾聚合」** —— 那只是最常見的用法。真正的差別是**執行時機**：

```sql
-- ① WHERE：先丟掉 CANCELLED 的列，再分組
SELECT status, COUNT(*) c, SUM(total_amount) s FROM orders
WHERE status <> 'CANCELLED' GROUP BY status ORDER BY status;

-- ② HAVING：先全部分組，再丟掉 CANCELLED 那一組
SELECT status, COUNT(*) c, SUM(total_amount) s FROM orders
GROUP BY status HAVING status <> 'CANCELLED' ORDER BY status;
```

**兩個結果完全相同**：

```
status       c   s
DELIVERED    2   7130.0000
PAID         1   1980.0000
PENDING      1   290.0000
```

⚠️ **結果相同，但代價不同**：② 要先把 `CANCELLED` 那一列也讀進來、分組、聚合，然後丟掉。
在 5 列的表上看不出差別；在一億列的表上，② 會多做**一億列的工作**。

📌 **而且 ① 走得到索引**（`WHERE status <> 'CANCELLED'` 可以用 `idx_orders_status_placed`），
② 一定是全表掃描。**03 章會用 `EXPLAIN` 看這件事。**

> ✅ **規則：能放 `WHERE` 的就放 `WHERE`。**
> `HAVING` 只留給**真的需要聚合結果**的條件：
>
> ```sql
> -- 這一個非 HAVING 不可：COUNT(*) 要等分組完才算得出來
> SELECT customer_id, COUNT(*) c FROM orders GROUP BY customer_id HAVING c >= 3;
> ```

**一個冷知識**：`HAVING` 可以不搭 `GROUP BY`（整張表視為一組）：

```sql
SELECT COUNT(*) c FROM orders HAVING COUNT(*) > 3;     -- 回傳 5
SELECT COUNT(*) c FROM orders HAVING COUNT(*) > 99;    -- 回傳【零列】，不是 0
```

⚠️ **注意第二句回傳的是「零列」而不是「一列，值 0」** ——
在 Java 這一側，`jdbc.queryForObject(...)` 會拋 `EmptyResultDataAccessException`
而不是回傳 0。這是 06 站 0.6 判準 4「誰決定『找不到』是不是錯誤」的一個具體案例。

---

## 2.3 JOIN ★★

**本章的實驗資料**（延續 01 章的 schema，`shop2` 資料庫）：

```
customer   4 位：alice、bob、carol、dave
             ★ carol 與 dave 【沒有任何訂單】
product    4 個 SKU：SHOE-BLK-M、SHOE-RED-L、SOCK-WHT-3P、BOTTLE-500
stock      3 列：BLK-M 42、RED-L 0、WHT-3P 500
             ★ BOTTLE-500 【沒有庫存列】（不是庫存 0，是連那一列都不存在）
orders     5 筆：alice 2 筆、bob 3 筆（其中一筆 CANCELLED）
order_item 8 列：SO-1 有 3 列、SO-5 有 2 列、其他各 1 列
```

⚠️ **這三個「刻意的空缺」**（carol/dave 沒訂單、BOTTLE-500 沒庫存列）
**是本節每一個實測的關鍵** —— 它們就是真實資料裡一定會有的那種空缺。

### 2.3.1 五種 JOIN

```
       A                B
   ┌───────┐        ┌───────┐
   │   1   │   2    │   3   │
   └───────┘        └───────┘
     只在 A   both     只在 B

INNER JOIN        →  ②           兩邊都有的
LEFT  JOIN        →  ① + ②       A 全部，B 配得上就填、配不上填 NULL
RIGHT JOIN        →  ② + ③       B 全部（= 把 A/B 對調的 LEFT JOIN）
CROSS JOIN        →  A × B        笛卡兒積，每一列配每一列
FULL OUTER JOIN   →  ① + ② + ③   🔴 MySQL 沒有這個
```

**實測 A：`INNER JOIN`**

```sql
SELECT p.sku, s.qty FROM product p JOIN stock s ON s.product_id = p.id ORDER BY p.sku;
```

```
sku            qty
SHOE-BLK-M     42
SHOE-RED-L     0
SOCK-WHT-3P    500
```

🔴 **`BOTTLE-500` 不見了。** 它是一個真實存在、正在賣的商品 ——
只是**沒有庫存列**。而「商品列表」用 `INNER JOIN` 寫的話，它就從網站上消失了。

📌 **這是 06 站 04 章 4.6.6「加了商品篩選之後，有些訂單就從列表裡消失了」的根因。**

**實測 B：`LEFT JOIN`**

```sql
SELECT p.sku, s.qty FROM product p LEFT JOIN stock s ON s.product_id = p.id ORDER BY p.sku;
```

```
sku            qty
BOTTLE-500     NULL      ← ✅ 回來了
SHOE-BLK-M     42
SHOE-RED-L     0
SOCK-WHT-3P    500
```

⚠️ **注意 `BOTTLE-500` 的 `qty` 是 `NULL` 而不是 `0`** ——
「沒有庫存資料」與「庫存是 0」是兩件事（01 章 1.7.3）。
要在 SQL 裡合併它們就用 `IFNULL(s.qty, 0)`，
**但要先確定業務上它們真的該合併**（`SHOE-RED-L` 是「確定賣完了」，`BOTTLE-500` 是「不知道」）。

### 2.3.2 實測：條件放 `ON` 還是 `WHERE` ★★

**同一個條件 `s.qty > 0`，換一個位置，結果完全不同。**

```sql
-- C：條件放 ON
SELECT p.sku, s.qty FROM product p LEFT JOIN stock s ON s.product_id = p.id AND s.qty > 0 ORDER BY p.sku;
```

```
sku            qty
BOTTLE-500     NULL
SHOE-BLK-M     42
SHOE-RED-L     NULL      ← 庫存 0，配對失敗 → 填 NULL，但【列還在】
SOCK-WHT-3P    500
                         ★ 4 列
```

```sql
-- D：條件放 WHERE
SELECT p.sku, s.qty FROM product p LEFT JOIN stock s ON s.product_id = p.id WHERE s.qty > 0 ORDER BY p.sku;
```

```
sku            qty
SHOE-BLK-M     42
SOCK-WHT-3P    500
                         ★ 只剩 2 列 —— BOTTLE-500 與 SHOE-RED-L 都不見了
```

🔴 **D 的 `LEFT JOIN` 已經變回 `INNER JOIN` 了。**

**用 2.2.1 的執行順序解釋**：

```
①② FROM + ON      →  LEFT JOIN 產出 4 列，其中兩列的 s.* 全是 NULL
③  WHERE          →  s.qty > 0 對 NULL 求值 = NULL（01 章 1.7.1：不是假，是 NULL）
                      而 WHERE 只保留【真】的列
                      → 那兩列被丟掉
                      → 🔴 LEFT JOIN 的「保留左表全部」被 WHERE 撤銷了
```

> 📌 **規則（記這一條就夠）**：
>
> ```
> 用來【配對】右表的條件  →  放 ON
> 用來【過濾結果】的條件  →  放 WHERE
>
> 而在 LEFT JOIN 上，任何對【右表欄位】的 WHERE 條件
> （除了 IS NULL）都會把它變回 INNER JOIN。
> ```
>
> ⚠️ **這一條在 `INNER JOIN` 上不成立** —— `INNER JOIN` 的 `ON` 與 `WHERE` 是等價的
> （優化器會自己搬動）。**所以這個 bug 只在 `LEFT JOIN` 上出現，
> 而它常常是「本來是 INNER JOIN，後來改成 LEFT JOIN，但 WHERE 沒跟著改」造成的。**

**唯一該把右表條件放 `WHERE` 的情況：反連接**

```sql
-- E：找出「沒有庫存列」的商品
SELECT p.sku FROM product p LEFT JOIN stock s ON s.product_id = p.id WHERE s.product_id IS NULL;
```

```
sku
BOTTLE-500
```

📌 **這個 `IS NULL` 是刻意的**：它問的是「配對失敗了嗎」。
`LEFT JOIN ... WHERE 右表主鍵 IS NULL` 是 SQL 裡表達「**差集**」的標準手法。

⚠️ **要用右表的【主鍵或 NOT NULL 欄位】做這個判斷**：

```sql
WHERE s.product_id IS NULL   -- ✅ product_id 是 stock 的主鍵，只有配對失敗才會是 NULL
WHERE s.qty IS NULL          -- 🔴 如果 qty 本身可以是 NULL，這一句會多抓到「有列但 qty 是 NULL」的
```

### 2.3.3 實測：列數膨脹 —— 本章開場那個 104% ★★

```sql
SELECT COUNT(*) FROM orders;                                              -- 5
SELECT COUNT(*) FROM orders o JOIN order_item i ON i.order_id = o.id;     -- 8
```

**5 筆訂單，JOIN 明細之後變成 8 列。** 因為 `SO-1` 有 3 列明細、`SO-5` 有 2 列：

```sql
SELECT o.order_no, i.product_name, i.qty FROM orders o JOIN order_item i ON i.order_id = o.id
WHERE o.order_no = 'SO-2026-00000001';
```

```
order_no             product_name           qty
SO-2026-00000001     慢跑鞋 黑 M              2
SO-2026-00000001     運動襪 白 3雙            1
SO-2026-00000001     water bottle 500ml     1
                     ★ 同一張訂單出現三次，o.total_amount 也跟著出現三次
```

**於是**：

```sql
SELECT SUM(total_amount) AS 正確 FROM orders;                                        -- 11380.0000
SELECT SUM(o.total_amount) AS 錯 FROM orders o JOIN order_item i ON i.order_id=o.id; -- 23210.0000
```

🔴 **多報 104%。**

⚠️ **而它為什麼特別危險**：

```
① 沒有語法錯誤、沒有警告
② 數字看起來合理（不是負數、不是 0、量級沒有離譜）
③ 只有【有多列明細的訂單】會被重複算
   → 平均一張訂單的明細數越多，錯得越多
   → 🔴 而這個比例會隨著業務成長【慢慢變化】
   → 於是報表數字「一直都有點怪，但說不出哪裡怪」
④ 加一個 WHERE 篩選（例如只看某個商品）會讓錯誤【變小】
   → 於是「單一商品的數字對得上，總計對不上」
```

**這種 JOIN 是怎麼來的**（真實的演化路徑）：

```sql
-- 第一版：只要營業額
SELECT SUM(total_amount) FROM orders WHERE placed_at >= ?;

-- 有人說「要能按商品篩選」→ 加一個 JOIN
SELECT SUM(o.total_amount) FROM orders o
JOIN order_item i ON i.order_id = o.id
WHERE o.placed_at >= ? AND (? IS NULL OR i.product_id = ?);
--                                       ↑ 這個 JOIN 是為了 WHERE 加的，
--                                         但它同時破壞了 SUM
```

📌 **三種修法**：

```sql
-- ✅ ① 需要的是「篩選」而不是「資料」→ 用 EXISTS，不要 JOIN
SELECT SUM(o.total_amount) FROM orders o
WHERE o.placed_at >= ?
  AND EXISTS (SELECT 1 FROM order_item i WHERE i.order_id = o.id AND i.product_id = ?);

-- ✅ ② 真的要 JOIN → 先去重再聚合
SELECT SUM(total_amount) FROM (
  SELECT DISTINCT o.id, o.total_amount FROM orders o
  JOIN order_item i ON i.order_id = o.id WHERE i.product_id = ?) t;

-- ✅ ③ 改成聚合明細（通常這才是業務真正要的）
SELECT SUM(i.line_amount) FROM orders o
JOIN order_item i ON i.order_id = o.id WHERE i.product_id = ?;
--     ↑ 「這個商品貢獻了多少營業額」—— 跟「含這個商品的訂單總額」是不同的問題
```

**三種修法的實測**（篩選 `SHOE-BLK-M`）：

```
修法 ① EXISTS            9110.0000
修法 ② DISTINCT 再聚合    9110.0000
修法 ③ SUM(line_amount)   7920.0000      ← ★ 不一樣
```

> ⚠️ **③ 的數字不一樣，而它不是錯的 —— 它回答的是另一個問題。**
>
> ```
> 9110 = 「有買 SHOE-BLK-M 的那三張訂單，總金額是多少」
>        （4700 + 1980 + 2430，含那些訂單裡的襪子與水壺）
> 7920 = 「SHOE-BLK-M 這個商品賣了多少錢」
>        （1980 × 4 雙）
> ```
>
> 📌 **很多時候「JOIN 之後 SUM 錯了」的真正原因，是問題本身沒問清楚。**
> 需求文件上寫的是「A 商品的營業額」，而這五個字有**兩個**合理的解讀，
> 差 15%。**寫這句 SQL 之前，先去問清楚要的是哪一個。**

### 2.3.4 實測：`COUNT` 也會被膨脹

```sql
SELECT c.username,
       COUNT(o.id)          AS 訂單數_錯,
       COUNT(DISTINCT o.id) AS 訂單數_對,
       COUNT(i.id)          AS 明細數
FROM customer c
LEFT JOIN orders o     ON o.customer_id = c.id
LEFT JOIN order_item i ON i.order_id = o.id
GROUP BY c.username ORDER BY c.username;
```

```
username   訂單數_錯   訂單數_對   明細數
alice      4          2          4
bob        4          3          4
carol      0          0          0
dave       0          0          0
```

📌 **三件事要一起看**：

```
① alice 有 2 筆訂單、4 列明細 → COUNT(o.id) 算出 4（每列明細都算一次訂單）
② COUNT(DISTINCT o.id) 才是對的
③ carol / dave 的 COUNT 是 0 而不是 NULL
   → 因為 COUNT(col) 不算 NULL（01 章 1.7.1），而 LEFT JOIN 讓 o.id 是 NULL
   → 🔴 但如果寫 COUNT(*) 就會變成 1（那一列存在，只是內容是 NULL）
```

**驗證 ③**：

```sql
SELECT c.username, COUNT(*) AS count_star, COUNT(o.id) AS count_col
FROM customer c LEFT JOIN orders o ON o.customer_id = c.id
GROUP BY c.username ORDER BY c.username;
```

```
username   count_star   count_col
alice      2            2
bob        3            3
carol      1            0        ← 🔴 COUNT(*) 說 carol 有 1 筆訂單
dave       1            0        ← 🔴 dave 也是
```

> ⚠️ **`LEFT JOIN` + `COUNT(*)` 是一個經典錯誤**：
> 「沒有訂單的客戶」會被算成「有 1 筆訂單」。
> **在 `LEFT JOIN` 之後，一律用 `COUNT(右表的主鍵)`，不要用 `COUNT(*)`。**

**兩層一對多的「正確」寫法：分別聚合再 JOIN**

```sql
SELECT c.username,
       IFNULL(oc.order_count, 0) AS 訂單數,
       IFNULL(ic.item_count, 0)  AS 明細數
FROM customer c
LEFT JOIN (SELECT customer_id, COUNT(*) order_count FROM orders GROUP BY customer_id) oc
       ON oc.customer_id = c.id
LEFT JOIN (SELECT o.customer_id, COUNT(*) item_count
           FROM orders o JOIN order_item i ON i.order_id = o.id
           GROUP BY o.customer_id) ic
       ON ic.customer_id = c.id
ORDER BY c.username;
```

📌 **規則：一句查詢裡最多只能有【一條】一對多的 JOIN 路徑。**
第二條開始，就必須先各自聚合成一對一，再 JOIN。

### 2.3.5 MySQL 沒有 `FULL OUTER JOIN`

```sql
SELECT ... FROM a FULL OUTER JOIN b ON ...;      -- 🔴 ERROR 1064（語法錯誤）
```

**模擬方式**：

```sql
-- ✅ LEFT JOIN UNION RIGHT JOIN
SELECT p.sku, s.qty FROM product p LEFT  JOIN stock s ON s.product_id = p.id
UNION
SELECT p.sku, s.qty FROM product p RIGHT JOIN stock s ON s.product_id = p.id;
```

⚠️ **一定要用 `UNION` 而不是 `UNION ALL`** —— `UNION` 會去重，
否則兩邊都有的列會出現兩次。

📌 **而「需要 `FULL OUTER JOIN`」通常是一個訊號**，
表示你其實想做的是「兩份清單的對帳」（哪些只在 A、哪些只在 B、哪些兩邊都有但值不同）。
那種查詢用三句分開寫，會比一句 `FULL OUTER JOIN` 清楚得多。

### 2.3.6 逗號 JOIN：不要用

```sql
-- 🔴 舊式寫法
SELECT * FROM orders o, order_item i WHERE i.order_id = o.id;

-- ✅ 現代寫法
SELECT * FROM orders o JOIN order_item i ON i.order_id = o.id;
```

**兩個理由**：

```
① 忘記寫 WHERE 就是【笛卡兒積】，而且不會報錯
   5 筆訂單 × 8 列明細 = 40 列；一萬 × 一萬 = 一億列
② 混用逗號與 JOIN 時，運算優先順序會咬人
   MySQL 5.0 之後 JOIN 的優先順序高於逗號 → 舊 SQL 升級後行為改變
```

⚠️ **`CROSS JOIN` 本身不是壞事**，只是要**明確寫出來**：

```sql
-- ✅ 明確的意圖：產生「每個商品 × 每個月」的完整格子，用來補報表的空洞
SELECT p.sku, m.month FROM product p CROSS JOIN (SELECT 1 month UNION SELECT 2 UNION SELECT 3) m;
```

### 2.3.7 自連接

```sql
-- 找出「同一個客戶在 7 天內下的兩筆訂單」
SELECT a.order_no AS 前, b.order_no AS 後,
       TIMESTAMPDIFF(DAY, a.placed_at, b.placed_at) AS 間隔天數
FROM orders a
JOIN orders b ON b.customer_id = a.customer_id
             AND b.placed_at > a.placed_at
             AND b.placed_at < a.placed_at + INTERVAL 7 DAY;
```

⚠️ **自連接的三個注意事項**：

```
① 一定要有【方向】條件（b.placed_at > a.placed_at），
   否則每一對會出現兩次（正反各一次），加上自己配自己
② 它的成本是 O(n²) 級別 —— 2.6.7 會用實測比較它與視窗函式
③ 兩個別名一定要取得清楚（a/b 不算清楚，用 prev/next 之類的）
```

### 2.3.8 多表 JOIN：`ON` 只能引用「已經 JOIN 進來」的表

```sql
-- ✅ 
SELECT ... FROM customer c
JOIN orders o     ON o.customer_id = c.id
JOIN order_item i ON i.order_id = o.id          -- 可以用 o，因為 o 已經在上一行進來了
JOIN product p    ON p.id = i.product_id;

-- 🔴 
SELECT ... FROM customer c
JOIN order_item i ON i.order_id = o.id          -- ERROR 1054：o 還不存在
JOIN orders o     ON o.customer_id = c.id;
```

⚠️ **一旦鏈上出現一個 `LEFT JOIN`，後面的每一個都要跟著是 `LEFT JOIN`**：

```sql
-- 🔴 第二個 JOIN 是 INNER，於是「沒有明細的訂單」連同它的客戶一起消失
FROM customer c LEFT JOIN orders o ON ... JOIN order_item i ON ...

-- ✅
FROM customer c LEFT JOIN orders o ON ... LEFT JOIN order_item i ON ...
```

📌 **這是「`LEFT JOIN` 悄悄變成 `INNER JOIN`」的第二種形式**（第一種是 2.3.2 的 `WHERE`）。
**兩種都不會報錯。**

---

## 2.4 `GROUP BY` 與聚合 ★

### 2.4.1 `ONLY_FULL_GROUP_BY` 檢查的是函式依賴

00 章 0.8.2 ④ 示範過關掉它的後果。這一節說明它**到底在檢查什麼**。

```sql
SELECT cat, id, SUM(amt) FROM sm GROUP BY cat;
```

```
ERROR 1055 (42000): Expression #2 of SELECT list is not in GROUP BY clause and
                    contains nonaggregated column 'shop.sm.id' which is not
                    functionally dependent on columns in GROUP BY clause
```

⚠️ **關鍵字是 `functionally dependent`（函式依賴），不是「有沒有出現在 GROUP BY」。**

**所以這一句是合法的**：

```sql
-- ✅ 合法：id 是主鍵，所以 order_no / status / total_amount 都【函式依賴於】id
SELECT o.id, o.order_no, o.status, o.total_amount, COUNT(i.id) AS item_count
FROM orders o LEFT JOIN order_item i ON i.order_id = o.id
GROUP BY o.id;
```

**`GROUP BY o.id` 一個欄位，`SELECT` 卻列了四個** —— 而 MySQL 接受它，
因為 `o.id` 是主鍵：**一個 id 只對應一組值，不可能有歧義。**

📌 **這讓查詢乾淨很多**。對照一下：

```sql
-- 🔴 不必要地把所有欄位都列進 GROUP BY（很多人被 ERROR 1055 逼出來的習慣）
GROUP BY o.id, o.order_no, o.status, o.total_amount, o.placed_at, o.paid_at, ...

-- ✅ 只要 GROUP BY 主鍵
GROUP BY o.id
```

**MySQL 8 的依賴推導比多數人以為的聰明。實測五種情況**：

```sql
-- ① GROUP BY 主鍵，SELECT 同表的其他欄位            ✅ 通過
SELECT o.order_no, o.status, o.total_amount, COUNT(i.id)
FROM orders o LEFT JOIN order_item i ON i.order_id=o.id GROUP BY o.id;

-- ② GROUP BY 主鍵，SELECT【另一張表】的欄位          ✅ 通過（！）
SELECT o.order_no, c.username, COUNT(*)
FROM orders o JOIN customer c ON c.id = o.customer_id GROUP BY o.id;
```

⚠️ **② 竟然通過了。** 因為 MySQL 能**沿著 JOIN 的等值條件傳遞依賴**：

```
o.id （GROUP BY 的鍵）
  → o.customer_id 依賴 o.id           （同表，主鍵決定一切）
  → c.id = o.customer_id              （JOIN 的等值條件）
  → c.username 依賴 c.id              （c.id 是 customer 的主鍵）
  ∴ c.username 依賴 o.id              ✅
```

**而這三種會失敗**：

```sql
-- ③ JOIN 的另一側【不是唯一的】
SELECT o.order_no, i.product_name, COUNT(*)
FROM orders o JOIN order_item i ON i.order_id = o.id GROUP BY o.id;
```

```
ERROR 1055: ... 'shop2.i.product_name' which is not functionally dependent ...
              ★ 一張訂單有多列明細，product_name 真的有歧義
```

```sql
-- ④ GROUP BY 一個【非唯一】欄位
SELECT status, order_no, COUNT(*) FROM orders GROUP BY status;      -- 🔴 ERROR 1055
```

```sql
-- ⑤ GROUP BY 一個【可為 NULL】的唯一欄位
SELECT phone, username FROM customer GROUP BY phone;                -- 🔴 ERROR 1055
```

📌 **⑤ 為什麼失敗，是一個很漂亮的推理**：
`phone` 上有唯一索引，看起來應該可以決定 `username`。
**但 `phone` 可以是 `NULL`，而唯一索引允許多個 `NULL`（01 章 1.7.2）** ——
所以 `phone IS NULL` 那一組裡有 carol 與 dave 兩個人，`username` 真的有歧義。

> ✅ **能建立函式依賴的只有：主鍵，或 `NOT NULL` 的唯一索引。**
> **實測 ④ 那一句（`GROUP BY status` 卻 `SELECT order_no`）就是 00 章 0.8.2 ④ 的那個
> 「答案是隨機的」查詢** —— 而 `ONLY_FULL_GROUP_BY` 幫你把它擋在門外。

**真的需要繞過它的時候：`ANY_VALUE()`**

```sql
SELECT o.customer_id, ANY_VALUE(c.username) AS username, COUNT(*)
FROM orders o JOIN customer c ON c.id = o.customer_id GROUP BY o.customer_id;
```

```
customer_id   username   COUNT(*)
（binary）     alice      2
（binary）     bob        3
```

⚠️ **`ANY_VALUE()` 的意思是「我保證這一組裡這個欄位只有一個值」。**
如果你保證錯了，MySQL 會**隨便挑一個**，而且不會告訴你 ——
它把一個編譯期的錯誤換成一個執行期的隨機答案。

> ✅ **只在你能證明「一組一值」時用它，而且要留註解寫下證明。**
> 上面那一句的證明是：`GROUP BY o.customer_id`，而 `c.id = o.customer_id`，
> 所以一組裡 `c` 只會是同一列 —— **這個證明應該寫成註解，而不是留給下一個人重推一次。**

### 2.4.2 `COUNT` 的五種寫法

```sql
SELECT COUNT(*)                    AS star,
       COUNT(paid_at)              AS col,
       COUNT(DISTINCT status)      AS dist_status,
       COUNT(DISTINCT customer_id) AS dist_cust,
       COUNT(1)                    AS one,
       COUNT('x')                  AS lit
FROM orders;
```

```
star   col   dist_status   dist_cust   one   lit
5      3     4             2           5     5
```

| 寫法 | 算什麼 | 用在哪 |
|---|---|---|
| `COUNT(*)` | **列數**（不看內容） | ✅ 「有幾列」 |
| `COUNT(col)` | `col` **不是 NULL** 的列數 | 「有幾列真的有填這一欄」 |
| `COUNT(DISTINCT col)` | `col` 的**不同值個數**（不含 NULL） | 「有幾個不同的客戶」 |
| `COUNT(1)` / `COUNT('x')` | 與 `COUNT(*)` 完全相同 | — |

📌 **`COUNT(1)` 沒有比 `COUNT(*)` 快。**
這是一個流傳很廣的說法，但 MySQL 的優化器對兩者的處理是一樣的
（`EXPLAIN` 產生的計畫完全相同）。**寫 `COUNT(*)`，它的意圖最清楚。**

⚠️ **`COUNT(paid_at) = 3`：這是「已付款的訂單數」嗎？**

不一定。它是「`paid_at` 不是 NULL 的訂單數」。
`SO-4` 是 `CANCELLED` 但如果它曾經付過款再退款，`paid_at` 可能有值。
**「欄位有值」與「業務狀態」是兩件事** —— 要問業務狀態就查 `status`。

### 2.4.3 `GROUP BY` 在 MySQL 8 沒有隱含排序了

```sql
SELECT status, COUNT(*) FROM orders GROUP BY status;
```

```
status       COUNT(*)
CANCELLED    1
DELIVERED    2
PAID         1
PENDING      1
                    ← 看起來是排序好的
```

⚠️ **它看起來排序好了，但這是巧合。** `EXPLAIN` 說明了原因：

```
key: idx_orders_status_placed
Extra: Using index
```

**MySQL 用 `(status, placed_at)` 這個索引來分組，而索引本身是有序的** ——
所以輸出「順便」是有序的。

📌 **但這不是保證**：

```
MySQL 5.7 及之前：GROUP BY 有【隱含的 ORDER BY】（文件明確寫的行為）
MySQL 8.0：      移除了這個隱含排序（因為它讓 GROUP BY 無法用 hash 聚合）
                 → 換一個執行計畫（例如加一個 WHERE、資料量變大、索引改變）
                   順序就會不一樣
```

> ✅ **規則：要排序就明確寫 `ORDER BY`。**
> 這是「從 5.7 升 8.0 之後報表順序變了」的頭號原因 —— 而且是**靜默的**。
>
> ⚠️ 順便：`GROUP BY col DESC` 這個語法在 8.0 **也被移除了**
> （5.7 可以寫 `GROUP BY status DESC`）。要降序就寫 `ORDER BY status DESC`。

### 2.4.4 `WITH ROLLUP`：一句拿到小計與總計

```sql
SELECT status, COUNT(*) c, SUM(total_amount) s FROM orders GROUP BY status WITH ROLLUP;
```

```
status       c   s
CANCELLED    1   1980.0000
DELIVERED    2   7130.0000
PAID         1   1980.0000
PENDING      1   290.0000
NULL         5   11380.0000      ← ★ 總計列，status 是 NULL
```

⚠️ **總計列用 `NULL` 來標記** —— 這造成兩個問題：

```
① 如果 status 本身可以是 NULL，你分不出「總計列」與「status 是 NULL 的那一組」
② Java 這一側讀到 status = null，很容易被當成資料錯誤
```

**解法**：用 `GROUPING()`（MySQL 8.0.12+）明確標記：

```sql
SELECT IF(GROUPING(status), '── 總計 ──', status) AS status,
       COUNT(*) c, SUM(total_amount) s
FROM orders GROUP BY status WITH ROLLUP;
```

📌 **多欄 `ROLLUP` 會產生多層小計**：

```sql
-- 每個客戶 × 每個狀態的小計，加上每個客戶的小計，加上總計
SELECT customer_id, status, COUNT(*) FROM orders GROUP BY customer_id, status WITH ROLLUP;
```

⚠️ **`WITH ROLLUP` 不能跟 `ORDER BY` 一起用**（8.0 起可以，但小計列的位置會被打亂）。
**實務上通常在應用層算小計比較好** ——
因為報表的呈現需求（小計放哪、要不要縮排、格式）本來就屬於呈現層（06 站 0.11.9）。

### 2.4.5 實測：`GROUP_CONCAT` 的靜默截斷 ★★

```sql
SELECT o.order_no,
       GROUP_CONCAT(i.product_name ORDER BY i.line_amount DESC SEPARATOR ' | ') AS items
FROM orders o JOIN order_item i ON i.order_id = o.id
GROUP BY o.order_no ORDER BY o.order_no;
```

```
order_no             items
SO-2026-00000001     慢跑鞋 黑 M | water bottle 500ml | 運動襪 白 3雙
SO-2026-00000002     慢跑鞋 黑 M
SO-2026-00000003     運動襪 白 3雙
SO-2026-00000004     慢跑鞋 紅 L
SO-2026-00000005     慢跑鞋 黑 M | water bottle 500ml
```

**很方便。而它有一個上限**：

```sql
SELECT @@group_concat_max_len;
```

```
1024        ← 位元組，不是字元
```

⚠️ **1024 位元組在 utf8mb4 下大約是 340 個中文字。**
一張有 30 項明細的訂單，商品名稱平均 12 個中文字 —— **就超過了**。

**實測（把上限設成 20 讓它現形）**：

```sql
SET SESSION group_concat_max_len = 20;
SELECT GROUP_CONCAT(i.product_name SEPARATOR '|') FROM order_item i;
```

```
慢跑鞋 黑 M|運
                ← 🔴 從中間切掉了
```

```sql
SHOW WARNINGS;
```

```
Level     Code   Message
Warning   1260   Row 2 was cut by GROUP_CONCAT()
```

📌 **它有警告 —— 而這個警告幾乎不可能被看到**：

```sql
SET SESSION group_concat_max_len = 20;
SELECT o.order_no, GROUP_CONCAT(i.product_name SEPARATOR ' | ') AS items, @@warning_count
FROM orders o JOIN order_item i ON i.order_id=o.id WHERE o.order_no='SO-2026-00000001' GROUP BY o.order_no;
```

```
order_no             items          @@warning_count
SO-2026-00000001     慢跑鞋 黑 M |    0
                                    ^^^
                                    🔴 同一句裡讀 @@warning_count 是 0
```

⚠️ **因為 `@@warning_count` 反映的是【上一句】SQL 的警告數**。
而 JDBC 這一側要主動呼叫 `getWarnings()`（00 章 0.5.3 講過同一件事）。

> ✅ **兩個處理方式**：
>
> ```sql
> -- ① 把上限拉高（session 層，不要改全域）
> SET SESSION group_concat_max_len = 1048576;      -- 1 MB
>
> -- ② ★ 更好的做法：加一個守門條件，讓截斷變成【可偵測】的
> SELECT o.order_no,
>        GROUP_CONCAT(i.product_name SEPARATOR ' | ') AS items,
>        COUNT(*)                                     AS item_count,
>        SUM(CHAR_LENGTH(i.product_name) + 3)         AS approx_len
> FROM orders o JOIN order_item i ON i.order_id=o.id GROUP BY o.order_no;
> --     ↑ 應用層比對 item_count 與 items 裡的分隔符數量，不符就代表被截斷了
> ```
>
> 📌 **③ 最好的做法：不要用 `GROUP_CONCAT` 做這件事。**
> 「訂單 + 它的明細清單」本來就是**兩次查詢**（或一次 JOIN 後在 Java 組裝）——
> 06 站 0.7.1 說過：列表查詢與明細查詢的形狀不同。
> `GROUP_CONCAT` 是一個「把資料結構壓成字串」的技巧，
> **而任何把結構壓成字串的地方，都需要一個上限，而上限總有一天會到。**

### 2.4.6 條件聚合：用一句話做出樞紐表

這是最實用、也最被低估的一個技巧。

```sql
SELECT c.username,
       COUNT(*)                                                    AS 全部,
       SUM(o.status = 'DELIVERED')                                 AS 已送達,
       SUM(CASE WHEN o.status='CANCELLED' THEN 1 ELSE 0 END)        AS 已取消,
       SUM(CASE WHEN o.status<>'CANCELLED' THEN o.total_amount END) AS 有效金額
FROM customer c JOIN orders o ON o.customer_id = c.id
GROUP BY c.username ORDER BY c.username;
```

```
username   全部   已送達   已取消   有效金額
alice      2      1       0       6680.0000
bob        3      1       1       2720.0000
```

📌 **三個寫法要看懂**：

```sql
SUM(o.status = 'DELIVERED')                              -- 布林運算式回傳 1/0，直接加
SUM(CASE WHEN cond THEN 1 ELSE 0 END)                    -- 同上，較長但可攜（PostgreSQL 沒有前一種）
SUM(CASE WHEN cond THEN col END)                         -- ★ 沒有 ELSE → 不符條件時是 NULL → 不被 SUM 計入
```

⚠️ **第三種與 `SUM(CASE ... ELSE 0 END)` 的差別**：

```
SUM(CASE WHEN c THEN col END)         → 一組全部不符時結果是 NULL
SUM(CASE WHEN c THEN col ELSE 0 END)  → 一組全部不符時結果是 0
```

**這正是 06 站 02 章 2.5.5「『沒有折扣』與『折扣 0 元』分不出來」的 SQL 版本** ——
選哪一個，取決於業務上「這一組沒有符合的資料」該顯示什麼。

**條件聚合能取代三種常見的糟糕做法**：

```sql
-- 🔴 ① 跑三次查詢，在 Java 裡組起來
-- 🔴 ② 三個子查詢
SELECT (SELECT COUNT(*) FROM orders WHERE status='PAID')      AS paid,
       (SELECT COUNT(*) FROM orders WHERE status='SHIPPED')   AS shipped,
       (SELECT COUNT(*) FROM orders WHERE status='DELIVERED') AS delivered;
--     ↑ 掃三次表

-- ✅ 一次掃描
SELECT SUM(status='PAID')      AS paid,
       SUM(status='SHIPPED')   AS shipped,
       SUM(status='DELIVERED') AS delivered
FROM orders;
```

---

## 2.5 子查詢 ★

### 2.5.1 四種子查詢

```
① 純量子查詢     出現在 SELECT / WHERE 的運算式位置，回傳【一個值】
                 SELECT (SELECT COUNT(*) FROM orders) AS n;
                 ⚠️ 回傳超過一列會 ERROR 1242

② IN 子查詢      回傳【一欄多列】
                 WHERE id IN (SELECT customer_id FROM orders)

③ EXISTS 子查詢  只問「有沒有」，不看回傳什麼
                 WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)

④ 衍生表         出現在 FROM 位置，回傳【一張表】
                 FROM (SELECT ... ) AS t          ← 一定要取別名
```

### 2.5.2 實測：`NOT IN` 的 NULL 陷阱，比你以為的更深 ★★

01 章 1.7.1 講過 `2 NOT IN (1, NULL)` 是 `NULL`。這一節看它在真實查詢裡的樣子。

**情境**：`phone_blacklist` 是一張從舊系統匯入的黑名單。匯入時有一列的來源欄位是空的，
於是變成 `NULL`：

```sql
CREATE TABLE phone_blacklist (phone VARCHAR(20) NULL, reason VARCHAR(50));
INSERT INTO phone_blacklist VALUES ('0912000002','詐騙申訴'), (NULL,'匯入時來源欄位是空的');
```

**客戶資料**：

```
username   phone
alice      0912000001
bob        0912000002        ← 在黑名單上
carol      NULL              ← 沒填電話
dave       NULL              ← 沒填電話
```

**寫法 ①：`NOT IN`**

```sql
SELECT username, phone FROM customer WHERE phone NOT IN (SELECT phone FROM phone_blacklist);
```

```
（零列）
```

🔴 **一列都沒有。** 因為黑名單裡有一個 `NULL`，任何 `x NOT IN (..., NULL)` 都是 `NULL`。

**寫法 ②：`NOT EXISTS`**

```sql
SELECT username, phone FROM customer c
WHERE NOT EXISTS (SELECT 1 FROM phone_blacklist b WHERE b.phone = c.phone) ORDER BY username;
```

```
username   phone
alice      0912000001
carol      NULL
dave       NULL
                       ★ 3 列
```

**寫法 ③：`NOT IN` + 過濾掉 NULL**（最常見的「修法」）

```sql
SELECT username, phone FROM customer
WHERE phone NOT IN (SELECT phone FROM phone_blacklist WHERE phone IS NOT NULL) ORDER BY username;
```

```
username   phone
alice      0912000001
                       ★ 只有 1 列 🔴
```

⚠️ **`NOT EXISTS` 給 3 列，「修好」的 `NOT IN` 給 1 列。兩個都沒有語法錯誤。**

**為什麼**：NULL 的問題**有兩側**。

```
子查詢那一側的 NULL  →  寫法 ① 的問題（已經被 ③ 修掉了）
外層【欄位】的 NULL  →  🔴 ③ 沒有修
                        carol 的 phone 是 NULL
                        → NULL NOT IN ('0912000002')  →  結果是 NULL  →  被 WHERE 濾掉
```

**寫法 ④：`LEFT JOIN ... IS NULL`**

```sql
SELECT c.username, c.phone FROM customer c
LEFT JOIN phone_blacklist b ON b.phone = c.phone WHERE b.phone IS NULL ORDER BY c.username;
```

```
username   phone
alice      0912000001
carol      NULL
dave       NULL
                       ★ 3 列（與 NOT EXISTS 一致）
```

**四種寫法的總表**：

| 寫法 | 結果 | 語意 |
|---|---|---|
| ① `NOT IN` | **0 列** 🔴 | 「黑名單裡有 NULL，所以我什麼都不敢說」 |
| ② `NOT EXISTS` | **3 列** | 「找不到一筆黑名單能配上這個人的電話」 |
| ③ `NOT IN` + `IS NOT NULL` | **1 列** | 「這個人的電話，確定不在黑名單的已知電話裡」 |
| ④ `LEFT JOIN ... IS NULL` | **3 列** | 同 ② |

> 📌 **哪一個是對的？取決於業務**：
>
> ```
> 「沒填電話的人」算不算「不在黑名單上」？
>     算  → ② 或 ④（3 列）  ← 幾乎總是這個
>     不算 → ③（1 列）
> ```
>
> ⚠️ **但關鍵不是「選哪一個」，是「你有沒有意識到要選」。**
> ① 那個零列的結果，會讓一個「篩掉黑名單客戶」的行銷名單**變成空的**，
> 而執行的人只會覺得「今天沒有符合條件的客戶」。
>
> ✅ **實務規則：反向查詢一律用 `NOT EXISTS`。**
> 它是四種寫法裡**唯一不會被任何一側的 NULL 影響語意**的，
> 而且它的意思（「找不到符合的」）跟你想問的問題一字不差。

### 2.5.3 `IN` / `EXISTS` / `JOIN`：什麼時候答案不同

```sql
SELECT COUNT(*) FROM customer c WHERE c.id IN (SELECT customer_id FROM orders);        -- 2
SELECT COUNT(*) FROM customer c WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id=c.id);  -- 2
SELECT COUNT(*) FROM customer c JOIN orders o ON o.customer_id = c.id;                 -- 5  🔴
SELECT COUNT(DISTINCT c.id) FROM customer c JOIN orders o ON o.customer_id = c.id;     -- 2
```

📌 **`IN` 與 `EXISTS` 天生就是「存在性」查詢，不會膨脹列數。**
`JOIN` 會（2.3.3），所以要配 `DISTINCT` —— 而 `DISTINCT` 有它自己的成本。

**三者的選擇**：

| 你要的是 | 用 |
|---|---|
| 「有沒有」——**不需要**右表的欄位 | ✅ `EXISTS`（或 `IN`） |
| 「有沒有」——**而且是反向的**（沒有） | ✅ `NOT EXISTS`（2.5.2） |
| **需要**右表的欄位（要顯示訂單編號、金額……） | `JOIN` |
| 需要右表的**聚合值**（訂單數、總金額） | `JOIN` + `GROUP BY`，或先聚合再 `JOIN`（2.3.4） |

⚠️ **「`IN` 比 `EXISTS` 慢」這個說法在 MySQL 8 上已經過期了。**
MySQL 5.6 起優化器會把 `IN` 子查詢轉成半連接（semi-join），
5.7 之後兩者的執行計畫通常相同。**選可讀性高的那一個。**

📌 **但有一個 `IN` 真的比較慢的情況**：`IN` 後面接一個**很長的常數列表**。

```sql
WHERE id IN (?, ?, ?, ... )      -- 一萬個問號
```

**05 章 5.6 會處理這件事**（它同時是一個效能問題與一個 `max_allowed_packet` 問題）。

### 2.5.4 相關子查詢的代價

**相關子查詢**（correlated subquery）= 子查詢引用了外層的欄位：

```sql
SELECT o.order_no,
       (SELECT COUNT(*) FROM order_item i WHERE i.order_id = o.id) AS item_count   -- ← 引用 o.id
FROM orders o;
```

⚠️ **它的語意是「對外層的每一列，各跑一次子查詢」** ——
5 列訂單就跑 5 次；一百萬列訂單就跑一百萬次。

📌 **這是 SQL 版的 N+1**（06 站 03 章 3.9.4）。

**MySQL 8 的優化器有時會把它改寫掉**，有時不會。**不要賭。**

```sql
-- ✅ 改成先聚合再 JOIN
SELECT o.order_no, IFNULL(ic.item_count, 0) AS item_count
FROM orders o
LEFT JOIN (SELECT order_id, COUNT(*) item_count FROM order_item GROUP BY order_id) ic
       ON ic.order_id = o.id;
```

**2.6.7 會用 10 萬列的實測，量出相關子查詢與其他三種寫法的差距**
（劇透：**135 倍**）。

### 2.5.5 衍生表與 CTE

```sql
-- 衍生表（所有版本都支援）
SELECT * FROM (SELECT customer_id, COUNT(*) c FROM orders GROUP BY customer_id) AS agg WHERE agg.c >= 2;

-- CTE（MySQL 8.0+）
WITH agg AS (SELECT customer_id, COUNT(*) c FROM orders GROUP BY customer_id)
SELECT * FROM agg WHERE agg.c >= 2;
```

**兩者的差別**：

| | 衍生表 | CTE |
|---|---|---|
| 版本 | 全部 | MySQL **8.0+** |
| 可讀性 | 🔴 巢狀三層之後就沒救了 | ✅ 由上而下，像讀程式 |
| 同一份結果**用兩次** | 🔴 要寫兩遍，**執行兩次** | ✅ 寫一次，**只物化一次** |
| 遞迴 | 🔴 不行 | ✅ `WITH RECURSIVE` |

**實測：CTE 被引用兩次時只物化一次**

```sql
EXPLAIN WITH agg AS (SELECT customer_id, COUNT(*) c FROM orders GROUP BY customer_id)
SELECT a1.customer_id, a1.c, a2.c FROM agg a1 JOIN agg a2 ON a1.customer_id = a2.customer_id;
```

```
id   select_type   table          key
1    PRIMARY       <derived2>     NULL
1    PRIMARY       <derived2>     <auto_key0>
2    DERIVED       orders         idx_orders_customer_placed
     ^^^^^^^^^^^
     ★ DERIVED 只出現【一次】—— 兩個引用共用同一份物化結果
```

📌 **`<auto_key0>` 也值得注意**：MySQL 會**自動為物化的衍生表建一個索引**，
讓外層的 JOIN 能走索引查找而不是全掃。這是 8.0 的一個很有用的優化。

⚠️ **CTE 不是「效能優化」**：
它在 MySQL 裡通常會被**物化成一張暫存表**
（不像 PostgreSQL 12+ ——  那裡 CTE 預設可以 inline，只有 `MATERIALIZED` 才強制物化），
所以「把子查詢改成 CTE」不會讓它變快，有時還會變慢
（因為物化的成本 + 失去了把 `WHERE` 下推進去的機會）。

> ✅ **用 CTE 的理由是【可讀性】與【重複引用】，不是效能。**

### 2.5.6 遞迴 CTE：補齊報表的空洞

**問題**：「過去 8 天每天的營業額」—— 沒有訂單的那幾天要顯示 0，而 `orders` 表裡沒有那幾天。

```sql
WITH RECURSIVE d AS (
  SELECT DATE('2026-08-19') AS day                          -- ① 種子
  UNION ALL
  SELECT day + INTERVAL 1 DAY FROM d WHERE day < '2026-08-26'   -- ② 遞迴：引用自己
)
SELECT d.day, COUNT(o.id) AS 訂單數, IFNULL(SUM(o.total_amount), 0) AS 營業額
FROM d LEFT JOIN orders o ON DATE(o.placed_at) = d.day
GROUP BY d.day ORDER BY d.day;
```

```
day          訂單數   營業額
2026-08-19   0       0.0000        ← ✅ 空洞被補上了
2026-08-20   1       290.0000
2026-08-21   1       1980.0000
2026-08-22   0       0.0000
2026-08-23   0       0.0000
2026-08-24   0       0.0000
2026-08-25   1       2430.0000
2026-08-26   0       0.0000
```

⚠️ **兩個一定要知道的限制**：

**① 遞迴深度上限**

```sql
SELECT @@cte_max_recursion_depth;      -- 1000
```

```sql
WITH RECURSIVE n AS (SELECT 1 x UNION ALL SELECT x+1 FROM n WHERE x < 2000) SELECT COUNT(*) FROM n;
```

```
ERROR 3636 (HY000): Recursive query aborted after 1001 iterations.
                    Try increasing @@cte_max_recursion_depth to a larger value.
```

📌 **1000 這個上限在真實報表上會撞到**：
「過去三年每一天」= **1095 天** > 1000。
「過去五年每一天」= 1826 天。

```sql
SET SESSION cte_max_recursion_depth = 4000;    -- ← session 層，不要改全域
```

**② `DATE(o.placed_at) = d.day` 這個 JOIN 條件用不到索引**

`placed_at` 被 `DATE()` 包住了 —— **03 章 3.7 的索引失效第一種情境**。
在大表上要改成半開區間：

```sql
LEFT JOIN orders o ON o.placed_at >= d.day AND o.placed_at < d.day + INTERVAL 1 DAY
```

⚠️ **而且要記得 00 章 0.6.6**：如果 `placed_at` 存的是 UTC，
`d.day` 必須是**業務時區的一天換算成 UTC 的區間**，不是 UTC 的一天。

> 📌 **一個實務建議：用一張實體的「日期維度表」取代遞迴 CTE。**
>
> ```sql
> CREATE TABLE dim_date (
>   day DATE PRIMARY KEY,
>   year SMALLINT NOT NULL, month TINYINT NOT NULL,
>   is_weekend BOOLEAN NOT NULL, is_holiday BOOLEAN NOT NULL,
>   fiscal_quarter TINYINT NOT NULL
> );
> -- 一次填 20 年 = 7300 列，不到 1 MB
> ```
>
> **好處**：沒有遞迴深度限制、可以放假日與會計期間、可以建索引、
> 而且「這一天是不是營業日」這種業務知識有地方放。
> **代價**：要記得填未來的日期（設一個排程，或一次填 20 年）。

---

## 2.6 視窗函式 ★★

MySQL 8.0 才有視窗函式。**它解決的是三類 `GROUP BY` 做不到的問題。**

### 2.6.1 `GROUP BY` 做不到的事

```
GROUP BY 的本質：把 N 列【壓成】1 列
視窗函式的本質：保留 N 列，但每一列多一個【看得到同組其他列】的欄位
```

**問題**：列出每一筆訂單，同時顯示「這個客戶的總消費」與「這一筆佔多少比例」。

```sql
-- 🔴 GROUP BY 做不到：一旦 GROUP BY customer_id，就看不到單筆訂單了
-- 🟡 老做法：JOIN 一個聚合的子查詢
SELECT c.username, o.order_no, o.total_amount, agg.s AS 該客戶總額
FROM customer c
JOIN orders o ON o.customer_id = c.id
JOIN (SELECT customer_id, SUM(total_amount) s FROM orders GROUP BY customer_id) agg
  ON agg.customer_id = c.id;

-- ✅ 視窗函式
SELECT c.username, o.order_no, o.total_amount,
       SUM(o.total_amount) OVER (PARTITION BY c.username)  AS 該客戶總額,
       ROUND(o.total_amount / SUM(o.total_amount) OVER (PARTITION BY c.username) * 100, 1) AS 佔比,
       SUM(o.total_amount) OVER ()                         AS 全站總額
FROM customer c JOIN orders o ON o.customer_id = c.id
ORDER BY c.username, o.order_no;
```

```
username   order_no             total_amount   該客戶總額    佔比   全站總額
alice      SO-2026-00000001     4700.0000      6680.0000    70.4   11380.0000
alice      SO-2026-00000002     1980.0000      6680.0000    29.6   11380.0000
bob        SO-2026-00000003     290.0000       4700.0000     6.2   11380.0000
bob        SO-2026-00000004     1980.0000      4700.0000    42.1   11380.0000
bob        SO-2026-00000005     2430.0000      4700.0000    51.7   11380.0000
```

📌 **注意 `SUM(...) OVER ()`（空的 `OVER`）**：沒有 `PARTITION BY` = 整個結果集是一組。
一句查詢裡可以有**多個不同範圍的視窗**，這是子查詢做不到的
（要三個不同範圍的總計，就要三個子查詢）。

### 2.6.2 `OVER` 的三個部分

```sql
函式() OVER (
    PARTITION BY  欄位...      -- ① 分組（像 GROUP BY，但不壓縮列）
    ORDER BY      欄位...      -- ② 組內的順序（決定「之前」「之後」的意義）
    框架                       -- ③ 這一列能看到組內的哪一段
)
```

**框架的兩種單位**：

```
ROWS  BETWEEN a PRECEDING AND b FOLLOWING     ← 按【列數】算
RANGE BETWEEN a PRECEDING AND b FOLLOWING     ← 按【ORDER BY 欄位的值】算
```

**四個常用的框架**：

```sql
ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW    -- 從頭到現在（累計）
ROWS BETWEEN 2 PRECEDING AND CURRENT ROW            -- 最近三列（移動平均）
ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING    -- 從現在到最後
ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING  -- 整組（= 不寫 ORDER BY 時的預設）
```

### 2.6.3 實測：預設框架是 `RANGE`，而它在有並列值時是錯的 ★★

**這是視窗函式最容易踩的坑。**

```sql
SELECT order_no, total_amount,
       SUM(total_amount) OVER (ORDER BY total_amount)                          AS 預設_RANGE,
       SUM(total_amount) OVER (ORDER BY total_amount ROWS UNBOUNDED PRECEDING) AS 明確_ROWS
FROM orders ORDER BY total_amount;
```

```
order_no             total_amount   預設_RANGE     明確_ROWS
SO-2026-00000003     290.0000       290.0000      290.0000
SO-2026-00000002     1980.0000      4250.0000     2270.0000      ← 🔴 差 1980
SO-2026-00000004     1980.0000      4250.0000     4250.0000
SO-2026-00000005     2430.0000      6680.0000     6680.0000
SO-2026-00000001     4700.0000      11380.0000    11380.0000
```

⚠️ **看第 2、3 列：兩筆訂單金額都是 1980，而 `RANGE` 給它們相同的累計值 4250。**

**為什麼**：

```
寫了 ORDER BY 但沒寫框架時，預設是
    RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW

而 RANGE 的「CURRENT ROW」不是「這一列」，是
    「所有 ORDER BY 欄位的值 = 這一列的值 的列」
        ↓
    兩筆 1980 互相包含彼此
        ↓
    290 + 1980 + 1980 = 4250   ← 兩列都得到 4250
```

📌 **這造成的具體事故**：

```
「累計營業額」報表：金額相同的兩天，累計值一樣
    → 使用者看到「昨天累計 4250、今天累計 4250」，以為今天沒有營業額
「累計庫存變動」對帳：兩筆同金額的變動被算成一筆
「排行榜的累積分數」：同分的人分數一樣（這個反而可能是對的）
```

> ✅ **規則：只要寫了 `ORDER BY`，就【明確寫出框架】。**
>
> ```sql
> -- 累計：一律加 ROWS
> SUM(x) OVER (ORDER BY d ROWS UNBOUNDED PRECEDING)
> -- 完整寫法（等價，但意圖更清楚）
> SUM(x) OVER (ORDER BY d ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
> ```
>
> ⚠️ **而如果 `ORDER BY` 的欄位真的唯一（例如主鍵或有唯一索引的時間戳），
> `RANGE` 與 `ROWS` 結果相同** —— 但**不要靠這個**：
> 01 章 1.5.2 說過，`DATETIME(0)` 的精度只到秒，同一秒內就會並列。
>
> 📌 **`RANK()` / `DENSE_RANK()` / `ROW_NUMBER()` 不受框架影響**，
> 因為它們的定義只用到 `PARTITION BY` 與 `ORDER BY`。框架只影響**聚合類**的視窗函式
> （`SUM` / `AVG` / `COUNT` / `MIN` / `MAX` / `FIRST_VALUE` / `LAST_VALUE`…）。

### 2.6.4 `ROW_NUMBER` / `RANK` / `DENSE_RANK` / `PERCENT_RANK`

```sql
SELECT order_no, total_amount,
       ROW_NUMBER()   OVER (ORDER BY total_amount DESC) rn,
       RANK()         OVER (ORDER BY total_amount DESC) rk,
       DENSE_RANK()   OVER (ORDER BY total_amount DESC) dr,
       PERCENT_RANK() OVER (ORDER BY total_amount DESC) pr
FROM orders ORDER BY total_amount DESC;
```

```
order_no             total_amount   rn   rk   dr   pr
SO-2026-00000001     4700.0000      1    1    1    0
SO-2026-00000005     2430.0000      2    2    2    0.25
SO-2026-00000002     1980.0000      3    3    3    0.5
SO-2026-00000004     1980.0000      4    3    3    0.5      ← 並列
SO-2026-00000003     290.0000       5    5    4    1
                                    ^    ^    ^
                                    │    │    └─ 並列後【不跳號】：1,2,3,3,4
                                    │    └────── 並列後【跳號】：1,2,3,3,5
                                    └─────────── 永遠不並列：1,2,3,4,5
```

| 函式 | 並列時 | 用在哪 |
|---|---|---|
| `ROW_NUMBER()` | 強制分出高下（**哪一列拿 3、哪一列拿 4 是不確定的**） | ✅ 「每組取一筆」、分頁 |
| `RANK()` | 並列同號，後面跳號 | 名次（奧運式） |
| `DENSE_RANK()` | 並列同號，後面不跳號 | 「有幾種不同的等級」 |
| `PERCENT_RANK()` | `(rk - 1) / (總列數 - 1)` | 百分位 |

⚠️ **`ROW_NUMBER()` 在並列時的順序是【不確定的】。**
如果你用它取「每組第一筆」，而排序欄位有並列 —— **取到哪一筆會隨執行計畫改變**。

```sql
-- 🔴 placed_at 如果是 DATETIME(0)，同一秒的兩筆訂單順序不確定
ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY placed_at DESC)

-- ✅ 加一個唯一的決勝欄位（tie-breaker）
ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY placed_at DESC, id DESC)
```

📌 **這與 06 站 04 章 4.4.1「列表裡有一筆重複，而我的訂單不見了」是同一個原理** ——
**任何依賴順序的操作（分頁、取第一筆、`LIMIT`）都需要一個唯一的決勝欄位。**

### 2.6.5 每組前 N 名

```sql
WITH ranked AS (
  SELECT c.username, o.order_no, o.placed_at, o.total_amount,
         ROW_NUMBER() OVER (PARTITION BY c.id ORDER BY o.placed_at DESC, o.id DESC) rn
  FROM customer c JOIN orders o ON o.customer_id = c.id
)
SELECT username, order_no, placed_at, total_amount FROM ranked WHERE rn = 1 ORDER BY username;
```

```
username   order_no             placed_at                  total_amount
alice      SO-2026-00000002     2026-08-15 06:00:00.000    1980.0000
bob        SO-2026-00000005     2026-08-25 03:00:00.000    2430.0000
```

⚠️ **`WHERE rn = 1` 一定要在外層**（CTE 或衍生表之外）。
因為 2.2.1：**視窗函式在 `WHERE` 之後才算**，所以不能寫：

```sql
-- 🔴 用別名：ERROR 1054 Unknown column 'rn' in 'where clause'
SELECT order_no, ROW_NUMBER() OVER (ORDER BY placed_at) rn FROM orders WHERE rn = 1;

-- 🔴 直接寫運算式：ERROR 3593 You cannot use the window function 'row_number' in this context
SELECT order_no FROM orders WHERE ROW_NUMBER() OVER (ORDER BY placed_at) = 1;

-- 🔴 HAVING 也不行（視窗函式在 HAVING 之後才算）：同樣是 ERROR 3593
SELECT status, COUNT(*) FROM orders GROUP BY status
HAVING ROW_NUMBER() OVER (ORDER BY status) = 1;
```

📌 **兩個不同的錯誤碼指向同一個原因**（2.2.1 的執行順序）：
別名版是「這個名字還不存在」（`WHERE` 在 `SELECT` 之前），
運算式版是「這個位置不能有視窗函式」（`WHERE` / `HAVING` 都在視窗函式之前）。

**「每組前 3 名」只要改一個字**：

```sql
... WHERE rn <= 3
```

📌 **`RANK()` 與 `ROW_NUMBER()` 在這裡的差別很重要**：

```
WHERE rn <= 3  用 ROW_NUMBER  → 一定拿到【剛好 3 筆】（並列時隨機挑）
WHERE rk <= 3  用 RANK        → 並列時可能拿到【4 筆或更多】
```

**「前三名（並列都算）」與「前三筆」是不同的需求** —— 選錯函式就是選錯需求。

### 2.6.6 `LAG` / `LEAD`：跟前後列比較

```sql
SELECT c.username, o.order_no, o.placed_at,
       LAG(o.placed_at) OVER (PARTITION BY c.id ORDER BY o.placed_at) AS 上一筆,
       TIMESTAMPDIFF(DAY,
           LAG(o.placed_at) OVER (PARTITION BY c.id ORDER BY o.placed_at),
           o.placed_at) AS 間隔天數
FROM customer c JOIN orders o ON o.customer_id = c.id
ORDER BY c.username, o.placed_at;
```

```
username   order_no             placed_at                  上一筆                       間隔天數
alice      SO-2026-00000001     2026-08-01 02:15:00.000    NULL                       NULL
alice      SO-2026-00000002     2026-08-15 06:00:00.000    2026-08-01 02:15:00.000    14
bob        SO-2026-00000003     2026-08-20 09:30:00.000    NULL                       NULL
bob        SO-2026-00000004     2026-08-21 10:00:00.000    2026-08-20 09:30:00.000    1
bob        SO-2026-00000005     2026-08-25 03:00:00.000    2026-08-21 10:00:00.000    3
```

📌 **`LAG` / `LEAD` 取代了「自連接」這個古老而昂貴的技巧**（2.3.7）。

**`LAG` 的第二、三個參數**：

```sql
LAG(col)                  -- 前 1 列，沒有就 NULL
LAG(col, 3)               -- 前 3 列
LAG(col, 1, 0)            -- 前 1 列，沒有就用 0（省掉外層的 IFNULL）
```

**常見用途**：

```sql
-- 環比成長率
(amount - LAG(amount) OVER (ORDER BY month)) / LAG(amount) OVER (ORDER BY month)
-- 偵測狀態變化（找出「狀態跟上一筆不同」的那幾列）
WHERE status <> LAG(status) OVER (PARTITION BY order_id ORDER BY changed_at)
-- 找出時間序列的斷點（前後兩列間隔超過閾值）
WHERE TIMESTAMPDIFF(MINUTE, LAG(ts) OVER (ORDER BY ts), ts) > 30
```

⚠️ **最後兩個要注意**：那個 `WHERE` **不能直接寫**（視窗函式在 `WHERE` 之後算）。
要包一層：

```sql
SELECT * FROM (
  SELECT *, LAG(status) OVER (PARTITION BY order_id ORDER BY changed_at) prev_status
  FROM order_history) t
WHERE t.status <> t.prev_status OR t.prev_status IS NULL;
```

### 2.6.7 累計與移動平均

```sql
SELECT order_no, placed_at, total_amount,
       SUM(total_amount) OVER (ORDER BY placed_at ROWS UNBOUNDED PRECEDING) AS 累計,
       ROUND(AVG(total_amount) OVER (ORDER BY placed_at
             ROWS BETWEEN 2 PRECEDING AND CURRENT ROW), 1) AS 三筆移動平均
FROM orders ORDER BY placed_at;
```

```
order_no             placed_at                  total_amount   累計          三筆移動平均
SO-2026-00000001     2026-08-01 02:15:00.000    4700.0000      4700.0000    4700.0
SO-2026-00000002     2026-08-15 06:00:00.000    1980.0000      6680.0000    3340.0
SO-2026-00000003     2026-08-20 09:30:00.000    290.0000       6970.0000    2323.3
SO-2026-00000004     2026-08-21 10:00:00.000    1980.0000      8950.0000    1416.7
SO-2026-00000005     2026-08-25 03:00:00.000    2430.0000      11380.0000   1566.7
```

⚠️ **注意前兩列的「三筆移動平均」其實是一筆與兩筆的平均**（框架不足三列時只算現有的）。
如果業務上「不滿三筆就不該顯示」，要自己加條件：

```sql
CASE WHEN COUNT(*) OVER (ORDER BY placed_at ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) = 3
     THEN AVG(total_amount) OVER (ORDER BY placed_at ROWS BETWEEN 2 PRECEDING AND CURRENT ROW)
END AS 三筆移動平均
```

📌 **可以用 `WINDOW` 子句避免重複寫同一個視窗定義**：

```sql
SELECT order_no, total_amount,
       SUM(total_amount) OVER w3 AS 三筆總和,
       AVG(total_amount) OVER w3 AS 三筆平均,
       COUNT(*)          OVER w3 AS 三筆列數
FROM orders
WINDOW w3 AS (ORDER BY placed_at ROWS BETWEEN 2 PRECEDING AND CURRENT ROW)
ORDER BY placed_at;
```

### 2.6.8 實測：視窗函式**不一定**比較快 ★★

「每個客戶最近一筆訂單」有四種寫法。**用 10 萬列 / 2000 個客戶的表實測**
（表上有 `KEY idx_cust_placed (cust_id, placed_at)`）：

```sql
-- ① 視窗函式
SELECT COUNT(*) FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY cust_id ORDER BY placed_at DESC) rn
  FROM big_order) t WHERE rn = 1;

-- ② 相關子查詢
SELECT COUNT(*) FROM big_order o
WHERE o.placed_at = (SELECT MAX(o2.placed_at) FROM big_order o2 WHERE o2.cust_id = o.cust_id);

-- ③ 先聚合再 JOIN
SELECT COUNT(*) FROM big_order o
JOIN (SELECT cust_id, MAX(placed_at) mx FROM big_order GROUP BY cust_id) m
  ON m.cust_id = o.cust_id AND m.mx = o.placed_at;

-- ④ 反連接
SELECT COUNT(*) FROM big_order o
LEFT JOIN big_order o2 ON o2.cust_id = o.cust_id AND o2.placed_at > o.placed_at
WHERE o2.id IS NULL;
```

**四個都回傳 2000。耗時**：

```
③ 先聚合再 JOIN        5.4 ms      1.0x     ★ 最快
① 視窗函式            81.0 ms     15.0x
④ 反連接             492.1 ms     91.1x
② 相關子查詢         732.1 ms    135.6x     🔴 最慢
```

⚠️ **視窗函式比「先聚合再 JOIN」慢 15 倍。**

**`EXPLAIN FORMAT=TREE` 說明了原因**：

```
① 視窗函式
-> Aggregate: count(0)
    -> Index lookup on t using <auto_key0> (rn=1)
        -> Materialize                                   ← 🔴 把 10 萬列全部物化
            -> Window aggregate: row_number() OVER (...)
                -> Sort: cust_id, placed_at DESC  (rows=100082)   ← 🔴 排序 10 萬列
                    -> Index scan on big_order using idx_cust_placed  (rows=100082)

③ 先聚合再 JOIN
-> Aggregate: count(0)
    -> Nested loop inner join
        -> Table scan on m  (rows=2021)
            -> Materialize  (rows=2021)                  ← ✅ 只物化 2021 列
                -> Covering index skip scan for grouping on big_order
                   using idx_cust_placed  (rows=2021)    ← ★ 跳掃：只讀每組的邊界
        -> Covering index lookup on o using idx_cust_placed (cust_id=..., placed_at=...)
```

📌 **關鍵是 `Covering index skip scan for grouping`（鬆散索引掃描）**：
`GROUP BY cust_id` + `MAX(placed_at)` 在 `(cust_id, placed_at)` 索引上，
只需要跳到每個 `cust_id` 的最後一項 —— **2000 次跳躍，不是 10 萬次讀取**。

**而視窗函式做不到這個優化。實測兩個「應該可以省掉排序」的嘗試**：

```sql
-- 嘗試 1：把 ORDER BY 改成 ASC，跟索引同方向
ROW_NUMBER() OVER (PARTITION BY cust_id ORDER BY placed_at ASC)
```

```
-> Sort: cust_id, placed_at  (rows=100082)      ← 🔴 排序還在
71.7 ms（DESC 是 63.2 ms，沒有變快）
```

```sql
-- 嘗試 2：加一個降序索引（MySQL 8 的新功能）
ALTER TABLE big_order ADD KEY idx_cust_placed_desc (cust_id, placed_at DESC);
```

```
-> Sort: cust_id, placed_at DESC  (rows=100082)  ← 🔴 排序還在，而且沒有用新索引
63.3 ms（完全沒變）
```

⚠️ **MySQL 8.0.46 的視窗函式【總是】會加一個 Sort，即使索引順序已經符合。**
這與普通的 `ORDER BY`（優化器會消除排序）不同。

> 📌 **這一節的結論不是「不要用視窗函式」。** 而是：
>
> ```
> 視窗函式的價值是【表達力】：
>     它讓 2.6.1、2.6.6、2.6.7 那些查詢從「三個子查詢 + Java 組裝」變成一句話
>     它的可讀性與可維護性遠勝於自連接
>
> 它【不是】效能優化：
>     在大表上，一個能走鬆散索引掃描的 GROUP BY 可以快它一個數量級
>     而它總是要排序整個分區
>
> 所以：
>     ✅ 報表、分析、資料量可控（幾萬列以內）→ 視窗函式，優先可讀性
>     ✅ 線上查詢、大表、走得到索引 → 先聚合再 JOIN，並用 EXPLAIN 確認 skip scan
>     🔴 相關子查詢 → 幾乎沒有理由用（135 倍）
> ```
>
> ⚠️ **而 ② 那個 135 倍要特別記住** ——
> 它是 2.5.4 說的「SQL 版的 N+1」，而它是四種寫法裡**最直覺、最容易寫出來**的那一種。

---

## 2.7 UPSERT 與批次寫入 ★

### 2.7.1 三種寫法，兩種是陷阱

```sql
INSERT ... ON DUPLICATE KEY UPDATE      -- ✅ 唯一推薦的
REPLACE INTO ...                        -- 🔴 它是 DELETE + INSERT
INSERT IGNORE INTO ...                  -- 🔴 它忽略的不只是重複
```

### 2.7.2 `INSERT ... ON DUPLICATE KEY UPDATE`

**情境**：每日商品銷售統計，同一天同一個 SKU 要累加。

```sql
CREATE TABLE daily_stat (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  stat_date  DATE NOT NULL,
  sku        VARCHAR(32) NOT NULL,
  qty        INT NOT NULL DEFAULT 0,
  amount     DECIMAL(19,4) NOT NULL DEFAULT 0,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_day_sku (stat_date, sku)
);

INSERT INTO daily_stat (stat_date, sku, qty, amount) VALUES ('2026-08-01','SHOE-BLK-M',2,3960);
```

```
id   stat_date    sku           qty   amount
1    2026-08-01   SHOE-BLK-M    2     3960.0000
```

```sql
INSERT INTO daily_stat (stat_date, sku, qty, amount) VALUES ('2026-08-01','SHOE-BLK-M',1,1980)
ON DUPLICATE KEY UPDATE qty = qty + VALUES(qty), amount = amount + VALUES(amount);
```

```
id   stat_date    sku           qty   amount
1    2026-08-01   SHOE-BLK-M    3     5940.0000      ← ✅ 累加成功，id 沒變
```

📌 **`VALUES(col)` 指的是「這次 `INSERT` 想寫的值」**，
而裸寫 `col` 指的是「資料庫裡現有的值」。

⚠️ **MySQL 8.0.20 起 `VALUES()` 被標記 deprecated**，新語法是別名：

```sql
INSERT INTO daily_stat (stat_date, sku, qty, amount) VALUES ('2026-08-01','SHOE-BLK-M',1,1980) AS new
ON DUPLICATE KEY UPDATE qty = daily_stat.qty + new.qty, amount = daily_stat.amount + new.amount;
--                          ^^^^^^^^^^^^^^^          ^^^^^^^
--                          現有的值                   要寫的值   ← 意圖清楚多了
```

📌 **`VALUES()` 目前還能用（8.0.46 上實測正常），但新專案用別名語法。**

### 2.7.3 實測：`ROW_COUNT()` 的三種值 ★★

```sql
-- ① 新插入一列
INSERT INTO daily_stat (stat_date,sku,qty,amount) VALUES ('2026-08-03','X',1,1)
  ON DUPLICATE KEY UPDATE qty = qty + VALUES(qty);
SELECT ROW_COUNT();
```

```
1
```

```sql
-- ② 更新，而且值真的變了
INSERT INTO daily_stat (stat_date,sku,qty,amount) VALUES ('2026-08-03','X',1,1)
  ON DUPLICATE KEY UPDATE qty = qty + VALUES(qty);
SELECT ROW_COUNT();
```

```
2        ← 🔴 不是 1
```

```sql
-- ③ 更新，但值【沒有變】（qty + 0）
INSERT INTO daily_stat (stat_date,sku,qty,amount) VALUES ('2026-08-03','X',0,0)
  ON DUPLICATE KEY UPDATE qty = qty + VALUES(qty);
SELECT ROW_COUNT();
```

```
0        ← 🔴 不是 1，也不是 2
```

**總表**：

| 發生了什麼 | `ROW_COUNT()` | JDBC 的 `executeUpdate()` |
|---|---|---|
| 新插入一列 | **1** | 1 |
| 更新，且值有變 | **2** | 2 |
| 更新，但值完全相同 | **0** | 0 |

⚠️ **這對 06 站的一個核心慣用法是直接的威脅**：

```java
// 06 站 0.8.3 的原子 UPDATE 慣用法
int rows = jdbc.update("UPDATE stock SET qty = qty - ? WHERE product_id = ? AND qty >= ?", ...);
if (rows == 0) throw new InsufficientStockException();   // ✅ 對 UPDATE 是對的
```

```java
// 🔴 同樣的判斷用在 UPSERT 上就錯了
int rows = jdbc.update("INSERT ... ON DUPLICATE KEY UPDATE ...");
if (rows == 0) throw new SomethingFailedException();     // 🔴 rows==0 代表「成功，但值沒變」
if (rows == 1) { /* 新增 */ } else { /* 更新 */ }          // 🔴 rows==2 才是更新
```

> ✅ **兩個處理方式**：
>
> ```java
> // ① 不要用回傳值判斷成功。UPSERT 沒有例外就是成功
> jdbc.update("INSERT ... ON DUPLICATE KEY UPDATE ...");
>
> // ② 真的需要知道「新增還是更新」→ 用 ROW_COUNT 的三值，並寫成一個具名的東西
> enum UpsertResult {
>     INSERTED,        // 1
>     UPDATED,         // 2
>     UNCHANGED;       // 0
>     static UpsertResult of(int affectedRows) {
>         return switch (affectedRows) {
>             case 1 -> INSERTED;
>             case 2 -> UPDATED;
>             case 0 -> UNCHANGED;
>             default -> throw new IllegalStateException(
>                     "UPSERT 影響列數只會是 0/1/2，實際是 " + affectedRows);
>         };
>     }
> }
> ```
>
> ⚠️ **注意 ② 的 `default` 分支**：批次 UPSERT 時影響列數會是各列相加，
> 所以那個 `switch` 只適用於單列 UPSERT。
> **這個限制要寫在方法的 javadoc 上，不要靠讀者自己發現。**

### 2.7.4 實測：UPSERT 會消耗 `AUTO_INCREMENT`

```sql
SELECT AUTO_INCREMENT FROM information_schema.TABLES
WHERE TABLE_SCHEMA='shop2' AND TABLE_NAME='daily_stat';
```

```
3        ← 表裡只有 1 列（id=1），但計數器已經到 3
```

```sql
INSERT INTO daily_stat (stat_date, sku, qty, amount) VALUES ('2026-08-02','SOCK-WHT-3P',1,290);
SELECT id, stat_date, sku FROM daily_stat ORDER BY id;
```

```
id   stat_date    sku
1    2026-08-01   SHOE-BLK-M
3    2026-08-02   SOCK-WHT-3P      ← id 2 被上一次的 UPSERT 吃掉了
```

📌 **這是 01 章 1.8.5「`AUTO_INCREMENT` 的洞」的第三種來源**
（前兩種是 `ROLLBACK` 與 `INSERT IGNORE`）。

⚠️ **在高頻 UPSERT 的表上，這個消耗速度會很快**：
一張每分鐘 UPSERT 一萬次的統計表，一天消耗 **1440 萬**個 id，
`INT` 的 21 億在 **146 天**就用完了 —— **而表裡可能只有幾千列**。

> ✅ **兩個解法**：
> ```
> ① 主鍵用 BIGINT（01 章 1.3.10 的規則，這裡多一個理由）
> ② ★ 更好：這種「天然有複合唯一鍵」的統計表，
>    不需要代理主鍵 —— 直接用 (stat_date, sku) 當主鍵
>    → 沒有 AUTO_INCREMENT，沒有這個問題，還少一個索引
> ```
>
> ```sql
> CREATE TABLE daily_stat (
>   stat_date  DATE NOT NULL,
>   sku        VARCHAR(32) NOT NULL,
>   qty        INT NOT NULL DEFAULT 0,
>   amount     DECIMAL(19,4) NOT NULL DEFAULT 0,
>   updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
>                          ON UPDATE CURRENT_TIMESTAMP(3),
>   PRIMARY KEY (stat_date, sku)      -- ★ 順序很重要（03 章最左前綴）：
> );                                  --   按日期範圍查詢是主要用途，所以 date 在前
> ```
>
> ⚠️ **這是 01 章 1.8.7「一律用代理鍵」的一個例外** ——
> 而例外的理由是：**這張表沒有自己的業務身分，它是一個聚合結果。**

### 2.7.5 實測：`REPLACE INTO` 為什麼危險 ★★

```sql
CREATE TABLE profile (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  username   VARCHAR(32) NOT NULL UNIQUE,
  nickname   VARCHAR(32) NOT NULL,
  avatar_url VARCHAR(200) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);
INSERT INTO profile (username, nickname, avatar_url) VALUES ('alice','艾莉絲','https://cdn/a.png');
```

```
id   username   nickname   avatar_url           created_at
1    alice      艾莉絲      https://cdn/a.png    2026-09-02 08:55:41.144
```

**現在只想改暱稱**：

```sql
REPLACE INTO profile (username, nickname) VALUES ('alice','Alice 改名');
```

```
id   username   nickname      avatar_url   created_at
2    alice      Alice 改名     NULL         2026-09-02 08:55:41.202
^^^                            ^^^^         ^^^^^^^^^^^^^^^^^^^^^^^
🔴 id 變了                      🔴 頭像沒了   🔴 建立時間被重設
```

**`ROW_COUNT()` 回傳 2** —— 因為它真的做了兩件事：`DELETE` 一列，`INSERT` 一列。

⚠️ **`REPLACE INTO` 的四個災難**：

| 災難 | 後果 |
|---|---|
| **主鍵改變** | 所有指向它的外鍵、快取 key、外部系統的參照**全部指到不存在的東西** |
| **沒指定的欄位被重設** | 頭像、備註、設定、任何「這次沒有要改」的欄位變成 `DEFAULT` 或 `NULL` |
| **`ON DELETE CASCADE` 會觸發** | 子表資料**真的被刪掉**（01 章 1.10.3 的另一個理由） |
| **觸發器 / binlog** | 是 `DELETE` + `INSERT` 兩個事件，而不是一個 `UPDATE` —— 下游的 CDC / 資料同步會看到「刪除」 |

**對照：`ON DUPLICATE KEY UPDATE` 只改你指定的欄位**

```sql
INSERT INTO profile2 (username, nickname) VALUES ('alice','Alice 改名')
ON DUPLICATE KEY UPDATE nickname = VALUES(nickname);
```

```
id   username   nickname      avatar_url
1    alice      Alice 改名     https://cdn/a.png      ← ✅ id 沒變、頭像還在
```

> 🔴 **規則：不要用 `REPLACE INTO`。一次都不要。**
> 它唯一「合理」的用途是「這一列的所有欄位我都要覆蓋，而且我不在乎 id」——
> 而那個情境用 `DELETE` + `INSERT` 明確寫出來會更清楚，
> 至少下一個讀程式碼的人看得出來會發生什麼。

### 2.7.6 實測：`INSERT IGNORE` 忽略的不只是重複 ★★

```sql
CREATE TABLE ig (id INT PRIMARY KEY, v INT NOT NULL, w VARCHAR(3) NOT NULL);
INSERT INTO ig VALUES (1, 10, 'abc');

INSERT IGNORE INTO ig VALUES (1, 99, 'xyz'),        -- 主鍵重複
                             (2, 20, 'toolong'),    -- 字串過長
                             (3, NULL, 'ok'),       -- NOT NULL 欄位給 NULL
                             (4, 40, 'ok');         -- 正常
SELECT * FROM ig ORDER BY id;
```

```
id   v    w
1    10   abc      ← 第一列被忽略了（預期行為）
2    20   too      ← 🔴 'toolong' 被【靜默截斷】成 'too'
3    0    ok       ← 🔴 NULL 被【靜默改成】 0
4    40   ok
```

```sql
SHOW WARNINGS;
```

```
Level     Code   Message
Warning   1062   Duplicate entry '1' for key 'ig.PRIMARY'
Warning   1265   Data truncated for column 'w' at row 2
Warning   1048   Column 'v' cannot be null
```

**沒有 `IGNORE` 的話，這三個各是什麼**：

```sql
INSERT INTO ig VALUES (1,99,'xyz');        -- ERROR 1062 (23000): Duplicate entry
INSERT INTO ig VALUES (5,20,'toolong');    -- ERROR 1406 (22001): Data too long for column 'w'
INSERT INTO ig VALUES (6,NULL,'ok');       -- ERROR 1048 (23000): Column 'v' cannot be null
```

⚠️ **`INSERT IGNORE` 把【所有】錯誤降級成警告，不只是重複鍵。**

它甚至讓 `sql_mode = STRICT_TRANS_TABLES`（00 章 0.8 那條底線）**在這一句上失效** ——
你花了一整章確保資料不會被靜默截斷，然後一個 `IGNORE` 就繞過去了。

> 🔴 **規則：不要用 `INSERT IGNORE`。**
>
> **你想做的事，幾乎都有一個更精確的寫法**：
>
> ```sql
> -- 「重複就跳過，其他錯誤要報」
> INSERT INTO t (a,b) VALUES (?,?) ON DUPLICATE KEY UPDATE a = a;
> --                                                       ^^^^^^^
> --   把自己更新成自己 = 什麼都不做。ROW_COUNT() 回傳 0（2.7.3 的第三種）
> --   ⚠️ 但它【仍然會消耗 AUTO_INCREMENT】，而且會在該列上加鎖（04 章）
>
> -- 「重複就跳過」而且要知道跳過了幾筆
> INSERT INTO t (a,b) SELECT ?, ? FROM DUAL
>   WHERE NOT EXISTS (SELECT 1 FROM t WHERE a = ?);
> --   ⚠️ 這【不是原子的】—— 併發下仍需唯一索引把關（06 站 0.8.4）
> ```
>
> 📌 **最重要的一句**：如果你需要「重複就跳過」，
> **那個「重複」的判斷應該由唯一索引來做，而例外應該被【接住並轉譯】，不是被忽略**：
>
> ```java
> try {
>     repository.insert(record);
>     return InsertResult.INSERTED;
> } catch (DuplicateKeyException e) {      // Spring 已經把 ERROR 1062 轉成這個
>     return InsertResult.ALREADY_EXISTS;  // ← 這是一個【業務結果】，不是錯誤
> }
> ```
> **這樣 1406 與 1048 仍然會炸出來** —— 而它們本來就該炸。

### 2.7.7 多表 `UPDATE` 與一個 MySQL 的限制

**多表 `UPDATE`：把聚合結果寫回統計表**

```sql
UPDATE cust_stat cs
JOIN (SELECT customer_id, COUNT(*) c, SUM(total_amount) s FROM orders
      WHERE status <> 'CANCELLED' GROUP BY customer_id) agg
  ON agg.customer_id = cs.customer_id
SET cs.order_count = agg.c, cs.total_spent = agg.s;
SELECT ROW_COUNT();
```

```
2        ← 只有 alice 與 bob 被更新（carol/dave 沒有訂單，JOIN 不到）
```

```
username   order_count   total_spent
alice      2             6680.0000
bob        2             2720.0000      ← CANCELLED 那筆被排除了
carol      0             0.0000
dave       0             0.0000
```

⚠️ **注意 `carol` / `dave` 保持 0** —— 因為 `JOIN` 配不上。
如果業務上需要「把不再有訂單的客戶歸零」，要**另外一句** `UPDATE`（或改成 `LEFT JOIN`）。

📌 **多表 `UPDATE` 的三個注意事項**：

```
① 不能有 ORDER BY 或 LIMIT（單表 UPDATE 可以）
② 更新順序不確定 —— 不要依賴它
③ 🔴 它會鎖住 JOIN 到的所有表的相關列（04 章）
   → 在一張大表上跑這種 UPDATE，等於一次大範圍加鎖
   → 實務上要分批（05 章 5.9）
```

**MySQL 的限制：不能在子查詢裡引用要修改的表**

```sql
DELETE FROM orders WHERE id IN (SELECT id FROM orders WHERE status = 'CANCELLED');
```

```
ERROR 1093 (HY000): You can't specify target table 'orders' for update in FROM clause
```

**解法：多包一層衍生表**（強迫 MySQL 先物化）

```sql
DELETE FROM del_t WHERE id IN (SELECT id FROM (SELECT id FROM del_t WHERE st = 'A') t);
SELECT ROW_COUNT();     -- 2   ✅ 成功
```

⚠️ **但這通常是一個訊號**，表示那一句可以寫得更簡單：

```sql
-- ✅ 這個例子根本不需要子查詢
DELETE FROM orders WHERE status = 'CANCELLED';
```

📌 **真的需要子查詢的情況**（例如「刪掉每個客戶最舊的那一筆」），
包一層衍生表是標準做法 —— 但要知道它**會把子查詢的結果全部物化到記憶體/暫存表**，
所以**不要用在會選出幾百萬列的子查詢上**（05 章 5.9 會給分批的做法）。

### 2.7.8 `UNION` 與 `UNION ALL`

```sql
SELECT status FROM orders WHERE status='DELIVERED'
UNION
SELECT status FROM orders WHERE status='DELIVERED';
```

```
status
DELIVERED        ← 1 列（UNION 去重）
```

```sql
SELECT status FROM orders WHERE status='DELIVERED'
UNION ALL
SELECT status FROM orders WHERE status='DELIVERED';
```

```
status
DELIVERED
DELIVERED
DELIVERED
DELIVERED        ← 4 列（2 筆 × 2 個分支）
```

> ✅ **預設用 `UNION ALL`。**
> `UNION` 的去重要**排序或雜湊整個結果集**，成本很高 ——
> 而多數時候你已經知道兩個分支不會重複（例如 `status='PAID'` 與 `status='SHIPPED'`）。
> **只有在真的需要去重時才用 `UNION`。**

⚠️ **`ORDER BY` 與 `LIMIT` 在 `UNION` 裡的規則**：

```sql
-- ✅ 放最後 → 套用在【合併後的整體】
(SELECT order_no, total_amount FROM orders WHERE status='PAID')
UNION ALL
(SELECT order_no, total_amount FROM orders WHERE status='DELIVERED')
ORDER BY total_amount DESC;
```

```
order_no             total_amount
SO-2026-00000001     4700.0000
SO-2026-00000005     2430.0000
SO-2026-00000002     1980.0000
```

```sql
-- ✅ 要對【單一分支】排序/限制 → 用括號包起來
(SELECT order_no FROM orders WHERE status='PAID'      ORDER BY placed_at DESC LIMIT 3)
UNION ALL
(SELECT order_no FROM orders WHERE status='DELIVERED' ORDER BY placed_at DESC LIMIT 3);
```

📌 **`UNION` 的欄位名取自【第一個】分支** ——
所以 `ORDER BY` 要用第一個分支的欄位名（或用欄位序號 `ORDER BY 2`）。

---

## 2.8 隱式轉型 ★★

**這一節是 03 章的前奏，也是本章最後一個「不會報錯的錯」。**

### 2.8.1 實測：字串與數字比較

```sql
SELECT '1' = 1 AS a, '01' = 1 AS b, ' 1' = 1 AS c, '1.0' = 1 AS d,
       '1abc' = 1 AS e, 'abc' = 0 AS f, '' = 0 AS g;
```

```
a   b   c   d   e   f   g
1   1   1   1   1   1   1
                ^   ^   ^
                🔴 '1abc' = 1 是【真】
                    🔴 'abc' = 0 是【真】
                        🔴 '' = 0 是【真】
```

**七個比較，全部是真。**

**規則**：`字串 = 數字` 時，**字串被轉成數字**（不是數字轉字串）。
轉換方式是「從左邊開始讀能讀到的數字，讀不到就是 0」：

```
'1'     → 1
'01'    → 1
' 1'    → 1        （前導空白被忽略）
'1.0'   → 1.0
'1abc'  → 1        （讀到 'a' 就停）
'abc'   → 0        （一個數字都沒讀到）
''      → 0
```

**而字串之間的比較是另一回事**：

```sql
SELECT '1' = '01' AS a, '1' = '1.0' AS b, '10' > '9' AS c, 10 > 9 AS d;
```

```
a   b   c   d
0   0   0   1
^   ^   ^
🔴 '1' ≠ '01'（字串比較，逐字元）
    🔴 '1' ≠ '1.0'
        🔴 '10' < '9'（字串序：'1' < '9'）
```

⚠️ **所以同一組值，比較方式取決於【兩邊的型別】**：

```
'1' = '01'   →  假（字串 vs 字串）
'1' = 1      →  真
'01' = 1     →  真
∴  '1' ≠ '01'，但兩者都等於 1        ← 相等失去了傳遞性
```

📌 **「相等沒有傳遞性」是一個很深的問題** ——
它代表你不能把 SQL 的 `=` 當成數學上的等於來推理。

### 2.8.2 實測：一句 `WHERE` 查出三個不同的電話號碼 ★★

**這是隱式轉型在真實世界的樣子。**

```sql
CREATE TABLE ph (id INT PRIMARY KEY, phone VARCHAR(20), KEY idx_phone (phone));
INSERT INTO ph VALUES (1,'0912345678'),
                      (2,'912345678'),
                      (3,'0912345678 '),        -- ← 尾端有一個空白（CSV 匯入很常見）
                      (4,'+886912345678');
```

```sql
-- ✅ 用字串查
SELECT * FROM ph WHERE phone = '0912345678';
```

```
id   phone
1    0912345678
```

```sql
-- 🔴 用數字查（例如前端傳來的是 JSON number，或 Java 用了 setLong）
SELECT * FROM ph WHERE phone = 912345678;
```

```
id   phone
1    0912345678
3    0912345678       ← 尾端有空白的那一列
2    912345678
                      ★ 三列 —— 三個字面上不同的電話號碼
```

**為什麼**：`phone` 是 `VARCHAR`，右邊是數字 → **整欄被轉成數字**：

```
'0912345678'   → 912345678      （前導 0 消失）
'912345678'    → 912345678
'0912345678 '  → 912345678      （尾端空白被忽略）
'+886912345678'→ 0              （'+' 不是數字開頭，讀不到 → 0）
                 ↑ 所以它沒有被選中（0 ≠ 912345678）
```

⚠️ **這一句的三個後果**：

```
① 查出別人的資料 🔴 —— 「查詢某支手機的訂單」查到三個不同號碼的訂單
② 索引失效
③ 而且它【永遠不會報錯】
```

**② 的證據**：

```sql
EXPLAIN SELECT * FROM ph WHERE phone = '0912345678';
```

```
type: ref                    ← ✅ 索引查找
key:  idx_phone
rows: 1                      ← 只讀 1 列
Extra: Using index
```

```sql
EXPLAIN SELECT * FROM ph WHERE phone = 912345678;
```

```
type: index                  ← 🔴 全索引掃描
key:  idx_phone
rows: 4                      ← 讀了全部 4 列
filtered: 25.00
Extra: Using where; Using index
```

📌 **`type: ref` → `type: index`** —— 從「索引查找」變成「掃完整個索引」。
在 4 列的表上是 4 列；在一千萬列的表上是一千萬列。
**03 章 3.7 會把這件事講完，並給出全部八種索引失效情境。**

### 2.8.3 反過來是安全的

```sql
CREATE TABLE nm (id BIGINT PRIMARY KEY, v INT);
INSERT INTO nm VALUES (100,1),(200,2);
SELECT * FROM nm WHERE id = '100';
```

```
id    v
100   1        ← ✅ 對的，而且走得到索引
```

**為什麼安全**：`id` 是數字欄位，`'100'` 是字串 → **常數被轉成數字**（只轉一個值），
欄位本身沒被碰到 → **索引還在**。

> 📌 **一句話記住方向**：
>
> ```
> 數字欄位 = 字串常數   →  ✅ 安全（轉常數，索引還在）
> 字串欄位 = 數字常數   →  🔴 危險（轉整欄，索引失效，而且結果可能是錯的）
> ```
>
> ⚠️ **這個方向是由 MySQL 的型別優先順序決定的**：
> 比較時**數字的優先權高於字串**，所以永遠是「字串那一邊被轉成數字」。

### 2.8.4 有警告，但看不到

```sql
SELECT 'abc' = 0 AS r;
SHOW WARNINGS;
```

```
r
1

Level     Code   Message
Warning   1292   Truncated incorrect DOUBLE value: 'abc'
```

**有警告。** 但：

```sql
SELECT COUNT(*) FROM ph WHERE phone = 912345678;
```

```
COUNT(*)
3            ← 這一句【沒有】警告，因為 '0912345678' 是可以完整轉成數字的
```

⚠️ **警告只在「轉換失敗」時出現，而「轉換成功但語意錯了」的情況沒有任何提示。**

而 2.8.2 那個查出三列的例子，**正好是「轉換成功」的那一種** ——
所以它連警告都沒有。

### 2.8.5 Java 這一側怎麼避免

**根因通常在這裡**：

```java
// 🔴 phone 在資料庫是 VARCHAR，這裡傳 long
jdbc.query("SELECT * FROM ph WHERE phone = ?", ps -> ps.setLong(1, phone), mapper);

// 🔴 DTO 的欄位型別選錯，於是 Jackson 把 "0912345678" 反序列化成 912345678L
record SearchRequest(Long phone) { }          // ← 前導 0 在這裡就已經沒了

// ✅ 電話號碼是【識別字】不是【數量】，一律用 String
record SearchRequest(@NotBlank @Pattern(regexp = "\\d{9,15}") String phone) { }
jdbc.query("SELECT * FROM ph WHERE phone = ?", ps -> ps.setString(1, phone), mapper);
```

> 📌 **判準（01 章 1.2.3 的第 ② 個問題的另一面）**：
>
> ```
> 這個值會被拿去【加減乘除】嗎？
>     會   → 數字型別（Java 與資料庫都是）
>     不會 → 字串型別（Java 與資料庫都是）
>
> 電話、身分證、統編、郵遞區號、訂單編號、銀行帳號、發票號碼
>     → 全部都是【識別字】，全部用 String
> ```
>
> ⚠️ **而且要兩邊一致。** 最危險的組合是「資料庫是 `VARCHAR`、Java 是 `Long`」——
> 因為那個轉換發生在 JDBC 邊界，**編譯器不會抱怨，測試通常也不會抓到**
> （測試資料很少有前導 0 或尾端空白）。

**一條可以放進 CI 的守門測試**：

```java
package com.example.shop.infra.db;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 守門：抓出「字串欄位被拿去跟數字比較」的隱式轉型。
 *
 * ★ 這一條抓不到所有情況（它只檢查資料，不檢查程式碼裡的 SQL），
 *   但它抓得到最常見的那一種：資料裡有前導 0 或尾端空白的識別字欄位。
 */
@SpringBootTest
class ImplicitConversionGuardTest {

    @Autowired JdbcTemplate jdbc;

    /**
     * 對每一個「識別字型」的字串欄位，確認它沒有被當成數字查詢過的痕跡：
     * 同一個邏輯值出現多種字面形式（前導 0、尾端空白）就是警訊。
     */
    @Test
    void 識別字欄位沒有前導零或尾端空白的重複值() {
        var offenders = jdbc.queryForList("""
                SELECT CONCAT('customer.phone 有 ', COUNT(*), ' 組可被數字比較混淆的值') AS c
                FROM (SELECT CAST(phone AS DECIMAL(20,0)) AS n
                      FROM customer
                      WHERE phone IS NOT NULL AND phone REGEXP '^[0-9 ]+$'
                      GROUP BY n HAVING COUNT(DISTINCT phone) > 1) t
                HAVING COUNT(*) > 0
                """, String.class);

        assertThat(offenders)
                .as("同一個數字對應多個不同的 phone 字面值 —— "
                  + "一旦有人寫 WHERE phone = <數字>，就會一次查出全部（本章 2.8.2）")
                .isEmpty();
    }

    /** 更直接的一條：資料裡不該有尾端空白（通常來自 CSV 匯入） */
    @Test
    void 識別字欄位沒有尾端空白() {
        Integer bad = jdbc.queryForObject("""
                SELECT COUNT(*) FROM customer
                WHERE phone IS NOT NULL AND phone <> TRIM(phone)
                """, Integer.class);

        assertThat(bad)
                .as("尾端空白在 utf8mb4_0900_ai_ci（NO PAD，00 章 0.5.9）之下"
                  + "會讓 WHERE phone = '0912...' 查不到，"
                  + "而 WHERE phone = 912345678 反而查得到 —— 最糟的組合")
                .isZero();
    }
}
```

---

## 2.9 shop-service 的查詢清單

把本章的每一個結論落到具體的查詢上。**這九句（Q1～Q8 + W1）會在 03 章被拿去做索引設計。**

```sql
-- ═══════════════════════════════════════════════════════════════
-- Q1 訂單列表（我的訂單）
--    ★ 沒有 JOIN 明細 —— 列表不需要明細（06 站 0.7.1：列表與明細是兩條路）
-- ═══════════════════════════════════════════════════════════════
SELECT o.id, o.order_no, o.status, o.total_amount, o.discount_amount, o.placed_at
FROM orders o
WHERE o.customer_id = ?
  AND o.placed_at >= ? AND o.placed_at < ?        -- ★ 半開區間（00 章 0.6.6）
ORDER BY o.placed_at DESC, o.id DESC              -- ★ 決勝欄位（2.6.4）
LIMIT ? OFFSET ?;

-- ═══════════════════════════════════════════════════════════════
-- Q2 訂單詳情（一筆訂單 + 它的明細）
--    ★ 兩句，不是一句 JOIN —— 避免主訂單欄位重複傳輸
-- ═══════════════════════════════════════════════════════════════
SELECT o.id, o.order_no, o.status, o.total_amount, o.discount_amount,
       o.placed_at, o.paid_at, o.shipped_at, o.version,
       c.username, c.display_name
FROM orders o JOIN customer c ON c.id = o.customer_id
WHERE o.id = ?;

SELECT i.id, i.product_id, i.product_name, i.unit_price, i.qty, i.line_amount
FROM order_item i WHERE i.order_id = ? ORDER BY i.id;

-- ═══════════════════════════════════════════════════════════════
-- Q3 訂單列表 + 明細數（一對多的正確聚合，2.3.4）
-- ═══════════════════════════════════════════════════════════════
SELECT o.id, o.order_no, o.status, o.total_amount, o.placed_at,
       COUNT(i.id) AS item_count                  -- ★ COUNT(右表主鍵)，不是 COUNT(*)
FROM orders o
LEFT JOIN order_item i ON i.order_id = o.id       -- ★ LEFT，不然沒明細的訂單會消失
WHERE o.customer_id = ?
GROUP BY o.id                                     -- ★ 只 GROUP BY 主鍵（2.4.1 的函式依賴）
ORDER BY o.placed_at DESC, o.id DESC
LIMIT ?;

-- ═══════════════════════════════════════════════════════════════
-- Q4 「買過某商品的訂單」（2.3.3：用 EXISTS 不要 JOIN）
-- ═══════════════════════════════════════════════════════════════
SELECT o.id, o.order_no, o.total_amount, o.placed_at
FROM orders o
WHERE o.customer_id = ?
  AND EXISTS (SELECT 1 FROM order_item i
              WHERE i.order_id = o.id AND i.product_id = ?)
ORDER BY o.placed_at DESC, o.id DESC LIMIT ?;

-- ═══════════════════════════════════════════════════════════════
-- Q5 營運儀表板：狀態分布 + 有效營業額（2.4.6 條件聚合，一次掃描）
-- ═══════════════════════════════════════════════════════════════
SELECT COUNT(*)                                                   AS total_orders,
       SUM(o.status = 'PENDING')                                  AS pending,
       SUM(o.status = 'PAID')                                     AS paid,
       SUM(o.status = 'SHIPPED')                                  AS shipped,
       SUM(o.status = 'DELIVERED')                                AS delivered,
       SUM(o.status = 'CANCELLED')                                AS cancelled,
       SUM(CASE WHEN o.status <> 'CANCELLED' THEN o.total_amount END) AS net_revenue
FROM orders o
WHERE o.placed_at >= ? AND o.placed_at < ?;

-- ═══════════════════════════════════════════════════════════════
-- Q6 每日營業額（含沒有訂單的日子，2.5.6）
--    ★ 用 dim_date 實體表，不用遞迴 CTE（1000 層上限）
--    ★ dim_date 直接存好「這個業務日在 UTC 的半開區間」
--      → SQL 裡不需要任何時區運算，欄位也沒被函式包住（03 章：索引還在）
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE dim_date (
  day        DATE        NOT NULL PRIMARY KEY,
  utc_start  DATETIME(3) NOT NULL COMMENT '該業務日的起點（UTC），含',
  utc_end    DATETIME(3) NOT NULL COMMENT '該業務日的終點（UTC），不含',
  year       SMALLINT    NOT NULL,
  month      TINYINT     NOT NULL,
  is_weekend BOOLEAN     NOT NULL,
  KEY idx_utc_start (utc_start)
) ENGINE=InnoDB COMMENT='日期維度；一次填 20 年約 7300 列';

-- 填資料（Asia/Taipei 沒有日光節約，所以固定 -8 小時是對的）
-- ⚠️ 有 DST 的業務時區（美東、歐洲）不能這樣填 —— 要用 Java 的 ZoneId 算好再匯入
INSERT INTO dim_date (day, utc_start, utc_end, year, month, is_weekend)
WITH RECURSIVE d AS (
  SELECT DATE('2026-07-01') day UNION ALL SELECT day + INTERVAL 1 DAY FROM d WHERE day < '2026-09-30')
SELECT day,
       CAST(day AS DATETIME(3))                - INTERVAL 8 HOUR,
       CAST(day + INTERVAL 1 DAY AS DATETIME(3)) - INTERVAL 8 HOUR,
       YEAR(day), MONTH(day), DAYOFWEEK(day) IN (1,7)
FROM d;

-- 查詢本身：沒有任何時區運算、沒有任何函式包住欄位
SELECT d.day,
       COUNT(o.id)                     AS order_count,
       IFNULL(SUM(o.total_amount), 0)  AS revenue
FROM dim_date d
LEFT JOIN orders o ON o.placed_at >= d.utc_start
                  AND o.placed_at <  d.utc_end
                  AND o.status <> 'CANCELLED'     -- ★ 條件放 ON，不是 WHERE（2.3.2）
WHERE d.day >= ? AND d.day < ?
GROUP BY d.day ORDER BY d.day;

-- ═══════════════════════════════════════════════════════════════
-- Q7 商品列表 + 庫存（2.3.1：LEFT JOIN，不然沒庫存列的商品會消失）
-- ═══════════════════════════════════════════════════════════════
SELECT p.id, p.sku, p.name, p.unit_price, p.is_active,
       s.qty, s.reserved_qty,
       IFNULL(s.qty, 0) - IFNULL(s.reserved_qty, 0) AS available
FROM product p LEFT JOIN stock s ON s.product_id = p.id
WHERE p.is_active = 1
ORDER BY p.sku LIMIT ?;

-- ═══════════════════════════════════════════════════════════════
-- Q8 每個客戶最近一筆訂單（2.6.8：不用視窗函式，快 15 倍）
-- ═══════════════════════════════════════════════════════════════
SELECT o.id, o.customer_id, o.order_no, o.total_amount, o.placed_at
FROM orders o
JOIN (SELECT customer_id, MAX(placed_at) AS mx FROM orders GROUP BY customer_id) m
  ON m.customer_id = o.customer_id AND m.mx = o.placed_at;
-- ⚠️ 這一句在 placed_at 有並列時會回傳多筆（同一客戶同一毫秒兩筆訂單）
--    → 01 章 1.5.2 用 DATETIME(3) 已經讓機率極低，但不是零
--    → 真的要保證一筆，用 2.6.5 的視窗函式版本，並接受 15 倍的成本

-- ═══════════════════════════════════════════════════════════════
-- W1 每日統計的 UPSERT（2.7.2、2.7.4：複合主鍵，沒有 AUTO_INCREMENT）
-- ═══════════════════════════════════════════════════════════════
INSERT INTO daily_stat (stat_date, sku, qty, amount) VALUES (?, ?, ?, ?) AS new
ON DUPLICATE KEY UPDATE qty    = daily_stat.qty    + new.qty,
                        amount = daily_stat.amount + new.amount;
-- ⚠️ 不要用回傳值判斷成功（2.7.3：0/1/2 三種值）
```

### 2.9.1 實測：這九句真的跑過

**全部在本章的種子資料上執行過。** 幾個值得看的輸出：

```sql
-- Q3（訂單列表 + 明細數）
order_no             status      total_amount   placed_at                  item_count
SO-2026-00000002     PAID        1980.0000      2026-08-15 06:00:00.000    1
SO-2026-00000001     DELIVERED   4700.0000      2026-08-01 02:15:00.000    3
```

```sql
-- Q5（營運儀表板，一次掃描）
total_orders   pending   paid   shipped   delivered   cancelled   net_revenue
5              1         1      0         2           1           9400.0000
                                                                  ^^^^^^^^^
                          ★ 11380 − 1980（CANCELLED 那筆）= 9400
```

```sql
-- Q7（商品列表 + 庫存）
sku            name                 unit_price   qty     reserved_qty   available
BOTTLE-500     water bottle 500ml   450.0000     NULL    NULL           0
SHOE-BLK-M     慢跑鞋 黑 M            1980.0000    42      3              39
SHOE-RED-L     慢跑鞋 紅 L            1980.0000    0       0              0
SOCK-WHT-3P    運動襪 白 3雙          290.0000     500     12             488
               ★ BOTTLE-500 在（因為 LEFT JOIN），而它的 qty 是 NULL 不是 0
```

```sql
-- Q6（每日營業額，2026-08-19 ～ 08-26）
day          order_count   revenue
2026-08-19   0             0.0000        ← ✅ 空洞被 dim_date 補上
2026-08-20   1             290.0000
2026-08-21   0             0.0000        ← ★ 這一天有一筆訂單，但它是 CANCELLED
2026-08-22   0             0.0000
2026-08-23   0             0.0000
2026-08-24   0             0.0000
2026-08-25   1             2430.0000
2026-08-26   0             0.0000
```

📌 **`2026-08-21` 那一列同時驗證了兩件事**：

```
① 那一天確實有一筆訂單（SO-4，台北時間 08-21 18:00），但它是 CANCELLED
② status <> 'CANCELLED' 放在【ON】裡
   → 該筆訂單配對失敗 → o.id 是 NULL → COUNT(o.id) = 0
   → 但【那一天的列還在】✅

```

**把那個條件搬到 `WHERE` 的實測**：

```sql
LEFT JOIN orders o ON o.placed_at >= d.utc_start AND o.placed_at < d.utc_end
WHERE d.day >= ? AND d.day < ? AND o.status <> 'CANCELLED'    -- ← 只搬了這一個條件
```

```
day          order_count   revenue
2026-08-20   1             290.0000
2026-08-25   1             2430.0000
                                        ★ 8 列變成 2 列
```

🔴 **整份報表塌掉了。** 不只是 08-21 消失 ——
**所有「沒有訂單的日子」全部消失**（08-19、08-21～08-24、08-26）。

因為 `LEFT JOIN` 配不上時 `o.status` 是 `NULL`，
而 `NULL <> 'CANCELLED'` 的結果是 `NULL`（01 章 1.7.1）→ 被 `WHERE` 濾掉。
**`dim_date` 這張表存在的唯一理由（補空洞）被一個 `WHERE` 完全抵銷了。**

⚠️ **而它不會報錯，數字也都是對的** ——
只是報表從「八天，其中六天是 0」變成「兩天」。
使用者看到的是一張**只有兩根柱子的長條圖**，而不是一張有六個缺口的圖。

**Q6 也順便驗證了時區的正確性**：

```sql
SELECT order_no, placed_at, placed_at + INTERVAL 8 HOUR AS 台北時間, status FROM orders ORDER BY placed_at;
```

```
order_no             placed_at                  台北時間                     status
SO-2026-00000001     2026-08-01 02:15:00.000    2026-08-01 10:15:00.000    DELIVERED
SO-2026-00000002     2026-08-15 06:00:00.000    2026-08-15 14:00:00.000    PAID
SO-2026-00000003     2026-08-20 09:30:00.000    2026-08-20 17:30:00.000    PENDING
SO-2026-00000004     2026-08-21 10:00:00.000    2026-08-21 18:00:00.000    CANCELLED
SO-2026-00000005     2026-08-25 03:00:00.000    2026-08-25 11:00:00.000    DELIVERED
```

```sql
SELECT day, utc_start, utc_end FROM dim_date WHERE day BETWEEN '2026-08-19' AND '2026-08-21';
```

```
day          utc_start                  utc_end
2026-08-19   2026-08-18 16:00:00.000    2026-08-19 16:00:00.000
2026-08-20   2026-08-19 16:00:00.000    2026-08-20 16:00:00.000
2026-08-21   2026-08-20 16:00:00.000    2026-08-21 16:00:00.000
```

📌 **`utc_start` 是前一天的 16:00** —— 這正是 00 章 0.6.6 那個「台北的一天 =
UTC 的 16:00 到隔天 16:00」的區間，**只是把它預先算好存進表裡**。
於是查詢裡一個時區函式都不需要，而 `placed_at` 上的索引完好無損。

---

📌 **這九句刻意避開的東西**：

| 沒有用 | 為什麼 | 節 |
|---|---|---|
| `SELECT *` | 有 `JSON` / `TEXT` 欄位時代價一個數量級 | 01 章 1.4.3 |
| `REPLACE INTO` / `INSERT IGNORE` | 2.7.5、2.7.6 | 2.7 |
| 相關子查詢 | 135 倍 | 2.6.8 |
| 一句裡兩條一對多 JOIN | 列數膨脹 | 2.3.4 |
| `DATE(placed_at) = ?` | 索引失效 | 2.5.6、03 章 |
| `LEFT JOIN` + 右表欄位放 `WHERE` | 悄悄變回 `INNER JOIN` | 2.3.2 |
| `GROUP_CONCAT` | 1024 位元組的靜默截斷 | 2.4.5 |
| 沒有決勝欄位的 `ORDER BY` + `LIMIT` | 順序不確定 | 2.6.4 |
| 遞迴 CTE 做日期序列 | 1000 層上限 | 2.5.6 |

---

## 2.10 常見誤區

**誤區 1：「`ON` 跟 `WHERE` 放哪裡都一樣」**

→ 2.3.2 實測：`LEFT JOIN` 上同一個條件放 `ON` 得到 **4 列**、放 `WHERE` 得到 **2 列**。
放 `WHERE` 會讓 `LEFT JOIN` **變回 `INNER JOIN`**。
（在 `INNER JOIN` 上兩者確實等價 —— 所以這個 bug 只在 `LEFT JOIN` 出現。）

**誤區 2：「JOIN 只是把資料接起來，不影響聚合」**

→ 2.3.3 實測：`SUM(o.total_amount)` 從 **11380 變成 23210**（多報 104%）。
一對多 JOIN 會讓左表的每一列**重複出現右表列數那麼多次**。

**誤區 3：「`LEFT JOIN` 之後用 `COUNT(*)` 算筆數」**

→ 2.3.4 實測：沒有訂單的 carol 與 dave，`COUNT(*)` 說他們**各有 1 筆訂單**。
`LEFT JOIN` 之後一律用 `COUNT(右表主鍵)`。

**誤區 4：「`WHERE` 裡可以用 `SELECT` 的別名」**

→ 2.2.2：`ERROR 1054`。`WHERE`（③）比 `SELECT`（⑧）早執行。
`HAVING` 與 `GROUP BY` 可以，但那是 MySQL 的**非標準擴充**。

**誤區 5：「`HAVING` 就是用來過濾聚合的」**

→ 2.2.3：真正的差別是**執行時機**。同一個條件放 `WHERE` 與 `HAVING` 結果相同，
但 `HAVING` 要先把整張表分組聚合完再丟掉 —— 而且**用不到索引**。

**誤區 6：「`ONLY_FULL_GROUP_BY` 要求每個 `SELECT` 的欄位都出現在 `GROUP BY`」**

→ 2.4.1 實測：它檢查的是**函式依賴**。`GROUP BY o.id`（主鍵）之後可以 `SELECT` 同表的任何欄位，
**甚至可以 `SELECT` 另一張表的欄位**（沿 JOIN 等值條件傳遞）。
而 `GROUP BY` 一個**可為 NULL 的唯一欄位**會失敗 —— 因為唯一索引允許多個 `NULL`。

**誤區 7：「`COUNT(1)` 比 `COUNT(*)` 快」**

→ 2.4.2 實測：`EXPLAIN FORMAT=TREE` 對兩者都是 `-> Count rows in orders`，**完全相同**。

**誤區 8：「`GROUP BY` 的結果是排序好的」**

→ 2.4.3：MySQL **8.0 移除了隱含排序**（5.7 有）。
它看起來有序是因為剛好用了索引來分組 —— 換一個執行計畫就變了。
**這是「從 5.7 升 8.0 之後報表順序變了」的頭號原因，而且是靜默的。**

**誤區 9：「`GROUP_CONCAT` 可以把明細清單組起來」**

→ 2.4.5 實測：預設上限 **1024 位元組**（utf8mb4 約 340 個中文字），
超過就**靜默截斷**。有警告（1260），但同一句裡讀 `@@warning_count` 是 0，
而 JDBC 要主動呼叫 `getWarnings()`。

**誤區 10：「`NOT IN` 加個 `IS NOT NULL` 就修好了」**

→ 2.5.2 實測：`NOT EXISTS` 回傳 **3 列**，「修好」的 `NOT IN` 回傳 **1 列**。
NULL 的問題**有兩側** —— 過濾子查詢的 NULL 沒有處理外層欄位的 NULL。
**反向查詢一律用 `NOT EXISTS`。**

**誤區 11：「`IN` 子查詢比 `EXISTS` 慢」**

→ 2.5.3：MySQL 5.6 起優化器會把 `IN` 轉成半連接，8.0 上兩者的計畫通常相同。
**選可讀性高的那一個。**

**誤區 12：「CTE 比子查詢快」**

→ 2.5.5：CTE 在 MySQL 裡通常會**物化成暫存表**，不會變快，有時更慢
（失去了把 `WHERE` 下推的機會）。
**用 CTE 的理由是可讀性與「同一份結果引用兩次只算一次」。**

**誤區 13：「遞迴 CTE 可以產生任意長的日期序列」**

→ 2.5.6 實測：`cte_max_recursion_depth` 預設 **1000**，超過就 `ERROR 3636`。
「過去三年每一天」= 1095 天，**已經超過了**。

**誤區 14：「累計金額用 `SUM(x) OVER (ORDER BY d)` 就好」**

→ 2.6.3 實測：預設框架是 **`RANGE`**，兩筆金額相同的列會**互相包含**，
累計值變成 4250 / 4250 而不是 2270 / 4250。
**寫了 `ORDER BY` 就要明確寫 `ROWS`。**

**誤區 15：「`ROW_NUMBER()` 取每組第一筆就對了」**

→ 2.6.4：排序欄位有並列時，**取到哪一筆是不確定的**。
一定要加一個唯一的決勝欄位（`ORDER BY placed_at DESC, id DESC`）。

**誤區 16：「視窗函式是現代寫法，比較快」**

→ 2.6.8 實測（10 萬列）：**「先聚合再 JOIN」5.4 ms，視窗函式 81 ms（慢 15 倍）**。
因為 `GROUP BY` 能走**鬆散索引掃描**（只讀 2021 列），
而視窗函式**總是要排序整個分區**（10 萬列）——
即使把 `ORDER BY` 改成跟索引同方向、即使加一個降序索引，那個 `Sort` **都不會消失**。

**誤區 17：「相關子查詢很直覺，應該不慢」**

→ 2.6.8 實測：**慢 135 倍**。它是 SQL 版的 N+1。

**誤區 18：「UPSERT 成功會回傳 1」**

→ 2.7.3 實測：新增回 **1**、更新且值有變回 **2**、更新但值沒變回 **0**。
06 站那個 `if (rows == 0) throw ...` 的慣用法**用在 UPSERT 上是錯的**。

**誤區 19：「UPSERT 更新時不會浪費 id」**

→ 2.7.4 實測：`AUTO_INCREMENT` **仍然被消耗**（id 從 1 跳到 3）。
高頻 UPSERT 的表用 `INT` 主鍵，可能 146 天就把 21 億用完 —— **而表裡只有幾千列**。

**誤區 20：「`REPLACE INTO` 是方便的 UPSERT」**

→ 2.7.5 實測：它是 `DELETE` + `INSERT`。
**id 從 1 變成 2、`avatar_url` 變成 `NULL`、`created_at` 被重設**，
而且會觸發 `ON DELETE CASCADE`、在 binlog 裡是「刪除 + 新增」。

**誤區 21：「`INSERT IGNORE` 就是忽略重複」**

→ 2.7.6 實測：它把**所有錯誤**降級成警告。
`'toolong'` 被截斷成 `'too'`、`NULL` 被改成 `0` ——
**它讓 `STRICT_TRANS_TABLES`（00 章 0.8 那條底線）在這一句上失效。**

**誤區 22：「`UNION` 跟 `UNION ALL` 差不多，用 `UNION` 比較安全」**

→ 2.7.8：`UNION` 要**排序或雜湊整個結果集**來去重。
**預設用 `UNION ALL`**，只在真的需要去重時用 `UNION`。

**誤區 23：「型別不合 MySQL 會幫我轉，沒差」**

→ 2.8.1 實測：`'1abc' = 1`、`'abc' = 0`、`'' = 0` **全部是真**。
而 `'1' = '01'` 是假 —— **相等失去了傳遞性**。

**誤區 24：「隱式轉型只是效能問題」**

→ 2.8.2 實測：`WHERE phone = 912345678` 在一個 `VARCHAR` 欄位上
**查出三個字面上不同的電話號碼**（`'0912345678'`、`'0912345678 '`、`'912345678'`）。
它同時是**正確性問題**（查到別人的資料）與**效能問題**（`type: ref` → `type: index`）。

**誤區 25：「型別不合會有警告」**

→ 2.8.4 實測：警告只在**轉換失敗**時出現（`'abc'` → 1292）。
「轉換成功但語意錯了」的情況（`'0912345678'` → 912345678）**連警告都沒有**。

---

## 2.11 本章練習

### 練習 1：找出這五句的錯

以下五句都會執行、都不會報錯。**每一句都有一個會回傳錯答案的問題。**

```sql
-- (a) 「每個客戶的訂單數與消費總額」
SELECT c.username, COUNT(*) AS 訂單數, SUM(o.total_amount) AS 總消費
FROM customer c
LEFT JOIN orders o     ON o.customer_id = c.id
LEFT JOIN order_item i ON i.order_id = o.id
GROUP BY c.id;

-- (b) 「還沒付款的訂單，以及它們的客戶」
SELECT o.order_no, c.username
FROM orders o
LEFT JOIN customer c ON c.id = o.customer_id
WHERE o.paid_at IS NULL AND c.deleted_at IS NULL;

-- (c) 「沒有下過訂單的客戶」
SELECT username FROM customer
WHERE id NOT IN (SELECT customer_id FROM orders WHERE status <> 'CANCELLED');

-- (d) 「每天的累計營業額」
SELECT DATE(placed_at) AS day, SUM(total_amount) AS 當日,
       SUM(SUM(total_amount)) OVER (ORDER BY DATE(placed_at)) AS 累計
FROM orders GROUP BY DATE(placed_at) ORDER BY day;

-- (e) 「每筆訂單的商品清單」
SELECT o.order_no, GROUP_CONCAT(i.product_name) AS 商品
FROM orders o JOIN order_item i ON i.order_id = o.id
GROUP BY o.order_no;
```

**對每一句回答**：

1. 錯在哪？會回傳什麼樣的錯答案？
2. 在什麼資料條件下這個錯誤**不會**出現？（這解釋了它為什麼能上線）
3. 寫出修正版。

**額外**：

**(f)** (b) 那一句有**兩個**問題，其中一個是 2.3.2 講過的。另一個是什麼？
**(g)** (d) 那一句的 `SUM(SUM(...)) OVER (...)` 能跑嗎？如果能，它的答案對嗎？為什麼？
**(h)** (e) 那一句在什麼情況下會出事？寫出一個能偵測它出事的查詢。

### 練習 2：一句 SQL 的三個版本

需求：**「列出每個客戶的：使用者名稱、訂單數、消費總額、最近一筆訂單的編號與日期、
最常買的商品名稱」** —— 只算非 `CANCELLED` 的訂單，沒有訂單的客戶也要列出來。

**(a)** 先寫一個「能跑就好」的版本。
**(b)** 找出你的版本裡所有本章講過的陷阱（至少會有三個）。
**(c)** 寫一個「正確」的版本。
**(d)** 寫一個「正確且能走索引」的版本，並用 `EXPLAIN FORMAT=TREE` 說明差別。
**(e)** 「最常買的商品」有並列時怎麼辦？你的答案有幾種合理的解讀？

### 練習 3：UPSERT 的併發

一個「每日商品統計」的批次任務，每五分鐘跑一次，用 2.7.2 的 UPSERT 累加。

```sql
INSERT INTO daily_stat (stat_date, sku, qty, amount) VALUES (?, ?, ?, ?) AS new
ON DUPLICATE KEY UPDATE qty = daily_stat.qty + new.qty, amount = daily_stat.amount + new.amount;
```

**(a)** 這一句是原子的嗎？兩個批次同時跑同一個 `(date, sku)` 會發生什麼？
**(b)** 如果批次任務因為超時被重試，會發生什麼？寫出時序圖。
**(c)** 怎麼讓它變成**冪等**的？（提示：累加不是冪等的，那什麼是？）
**(d)** 改成 `qty = new.qty`（覆蓋而非累加）會讓它冪等嗎？代價是什麼？
**(e)** 這張表的主鍵你會選 `(stat_date, sku)` 還是 `(sku, stat_date)`？取決於什麼？

### 練習 4：把 2.6.8 的實驗做完

**(a)** 重現 2.6.8 的四種寫法與四個數字。你的機器上比例一樣嗎？

**(b)** 把資料量從 10 萬列加到 100 萬列，四個數字怎麼變？
  哪一種寫法的成長是**線性**的、哪一種是**超線性**的？

**(c)** 把客戶數從 2000 改成 20（每個客戶 5000 筆訂單），重跑一次。
  排名有變嗎？為什麼？

**(d)** 2.6.8 的實測顯示視窗函式**總是**加一個 `Sort`。
  設計一個實驗確認：這個 `Sort` 是「排序整個表」還是「每個分區各排一次」？
  （提示：看 `Sort` 節點的 `rows`、以及改變分區數量）

**(e)** 如果 `big_order` 上**沒有** `(cust_id, placed_at)` 索引，四個數字會怎麼變？
  這告訴你什麼？

### 練習 5：隱式轉型的搜捕 ★

你接手一個系統，懷疑有隱式轉型的問題。

**(a)** 寫一句查詢，列出資料庫裡所有**字串型別**的欄位，
  並標出哪些「看起來像數字」（值全部由數字組成）。這些是高風險欄位。

**(b)** 對每一個高風險欄位，寫一句查詢偵測「同一個數字對應多個字面值」的情況
  （2.8.5 那條守門測試的通用版）。

**(c)** 上面兩題只檢查**資料**。要檢查**程式碼裡的 SQL**，你會怎麼做？
  列出至少三種方法，並說明各自抓得到與抓不到什麼。

**(d)** MySQL 有一個現成的工具可以幫你找出「這一句查詢發生了隱式轉型」。
  找出它是什麼，並示範用法。（提示：跟 `EXPLAIN` 的一個變體有關）

---

## 2.12 完成本章後，請確認你有

```
✅ 一份專案的查詢清單（2.9 的格式）
     ├─ 每一句都標出它避開了哪一個陷阱
     ├─ 沒有 SELECT *
     ├─ 沒有 REPLACE INTO / INSERT IGNORE
     ├─ 沒有相關子查詢
     ├─ 每一個 ORDER BY + LIMIT 都有決勝欄位
     └─ 每一個 LEFT JOIN 的右表條件都在 ON 裡（除了刻意的 IS NULL 反連接）

✅ 一條檢查清單，能在 code review 時用（建議印出來貼在螢幕旁）
     ├─ 這句有 JOIN 嗎？有的話，是一對多嗎？有聚合嗎？→ 2.3.3
     ├─ 這句有 LEFT JOIN 嗎？右表的條件在哪裡？→ 2.3.2
     ├─ 這句有 COUNT 嗎？COUNT 什麼？→ 2.4.2
     ├─ 這句有 NOT IN 嗎？→ 改 NOT EXISTS
     ├─ 這句有視窗函式的 ORDER BY 嗎？框架寫了嗎？→ 2.6.3
     ├─ 這句有 ORDER BY + LIMIT 嗎？決勝欄位呢？→ 2.6.4
     └─ 這句的每一個 = 兩邊型別一樣嗎？→ 2.8

✅ 一組隱式轉型的守門測試（2.8.5）

✅ 你能回答這七個問題（不查資料）
     ├─ 為什麼 LEFT JOIN 的條件放 WHERE 會變回 INNER JOIN？
     ├─ 為什麼 JOIN 明細之後 SUM 會多報一倍？
     ├─ 為什麼 NOT EXISTS 與「修好的 NOT IN」答案不同？
     ├─ 為什麼累計金額在並列處會出現重複值？
     ├─ 為什麼視窗函式可能比 GROUP BY 慢 15 倍？
     ├─ UPSERT 的 ROW_COUNT() 為什麼有三種值？
     └─ 為什麼 WHERE phone = 912345678 會查出三個電話號碼？
```

---

## 2.13 本章的實驗環境與結果

**環境**：

| 項目 | 版本 |
|---|---|
| 資料庫 | **MySQL 8.0.46**（官方映像，預設 buffer pool 128 MB） |
| 連線 | `mysql` client，`--default-character-set=utf8mb4`（00 章 0.10.1） |
| 資料 | 01 章 1.12 的完整 schema + 本章的種子資料 |
| 小資料集 | 4 客戶 / 4 商品 / 3 庫存列 / 5 訂單 / 8 明細 |
| 大資料集 | `big_order` 10 萬列、2000 個客戶、`KEY (cust_id, placed_at)` |
| 平台 | macOS 14.2.1 / Apple Silicon |

⚠️ **種子資料裡的三個「刻意的空缺」**：
`BOTTLE-500` 沒有庫存列、`carol` 與 `dave` 沒有訂單、`phone_blacklist` 有一個 `NULL`。
**本章有 9 個實測依賴這三個空缺** —— 而它們就是真實資料裡一定會有的那種空缺。

**跑過的實驗（33 組）**：

| 組 | 實驗 | 結果 |
|---|---|---|
| **G1** | 別名的可用位置 | ✅ `WHERE` → `ERROR 1054`；`HAVING` / `GROUP BY` / `ORDER BY` **都可以**（前兩者是 MySQL 擴充） |
| **G2** | `WHERE` vs `HAVING` | ✅ 結果相同（3 組）；`HAVING` 可以不搭 `GROUP BY`，且 `HAVING COUNT(*) > 99` 回傳**零列**而非「一列 0」 |
| **G3** | 五種 JOIN | ✅ `INNER` 3 列（**`BOTTLE-500` 消失**）／`LEFT` 4 列（`qty` 是 `NULL` 不是 0）；**`FULL OUTER JOIN` → `ERROR 1064`**，`UNION` 模擬有效 |
| **G4** | `ON` vs `WHERE` ★ | 🔴 **同一個 `s.qty > 0`：放 `ON` 得 4 列、放 `WHERE` 得 2 列**；`WHERE s.product_id IS NULL` 反連接得 1 列 |
| **G5** | 列數膨脹 ★ | 🔴 5 筆訂單 JOIN 明細 → **8 列**；`SUM(total_amount)` 從 **11380 → 23210（+104%）** |
| **G6** | 三種修法 | ✅ `EXISTS` 9110 ／ `DISTINCT` 9110 ／ `SUM(line_amount)` **7920** —— **第三種回答的是另一個問題（差 15%）** |
| **G7** | `COUNT` 在 `LEFT JOIN` 之後 | 🔴 alice `COUNT(o.id)=4` vs `COUNT(DISTINCT o.id)=2`；**carol/dave 的 `COUNT(*)=1`、`COUNT(o.id)=0`** |
| **G8** | 逗號 JOIN | ✅ `FROM orders o, order_item i`（無 WHERE）→ **40 列**笛卡兒積，不報錯 |
| **G9** | 自連接 | ✅ 「7 天內兩筆訂單」找到 3 對；需要方向條件否則會重複 |
| **G10** | 函式依賴 ★ | ✅ `GROUP BY o.id` + 同表欄位 **通過**；+ **另一張表的欄位也通過**（沿 JOIN 等值傳遞）<br>🔴 JOIN 非唯一側 → `ERROR 1055`；`GROUP BY` 非唯一欄位 → `1055`；**`GROUP BY` 可為 NULL 的唯一欄位 → `1055`** |
| **G11** | `COUNT` 五種 | ✅ `*`=5、`paid_at`=3、`DISTINCT status`=4、`DISTINCT customer_id`=2、`1`=5、`'x'`=5；**`COUNT(*)` 與 `COUNT(1)` 的 `EXPLAIN FORMAT=TREE` 完全相同（`Count rows in orders`）** |
| **G12** | `GROUP BY` 排序 | ✅ 輸出看起來有序，但 `EXPLAIN` 顯示原因是**走了索引**；**`GROUP BY status DESC` → `ERROR 1064`（8.0 移除）** |
| **G13** | `WITH ROLLUP` | ✅ 總計列的 `status` 是 **`NULL`**；`GROUPING(status)` 可以正確標記出來 |
| **G14** | `GROUP_CONCAT` ★ | ✅ 預設 `group_concat_max_len` = **1024** 位元組；設成 20 後**靜默截斷**（`慢跑鞋 黑 M|運`），警告 **1260** 存在但**同一句裡 `@@warning_count` 是 0** |
| **G15** | 條件聚合 | ✅ `SUM(status='X')`、`SUM(CASE...ELSE 0 END)`、`SUM(CASE...END)`（無 `ELSE`）三種寫法；一次掃描取代三個子查詢 |
| **G16** | `NOT IN` × NULL ★★ | 🔴 `NOT IN` → **0 列**；`NOT EXISTS` → **3 列**；**`NOT IN` + `IS NOT NULL` → 只有 1 列**；`LEFT JOIN ... IS NULL` → 3 列。**四種寫法三個答案** |
| **G17** | `IN`/`EXISTS`/`JOIN` | ✅ `IN` 2、`EXISTS` 2、`JOIN` **5**、`JOIN` + `COUNT(DISTINCT)` 2 |
| **G18** | CTE 物化 | ✅ 同一個 CTE 引用兩次，`EXPLAIN` 裡 **`DERIVED` 只出現一次**；MySQL 自動建 `<auto_key0>` 讓外層走索引 |
| **G19** | 遞迴 CTE | ✅ 補齊 8 天的空洞；**`cte_max_recursion_depth` 預設 1000，2000 層 → `ERROR 3636`**；`SET SESSION` 調到 4000 後可以 |
| **G20** | 視窗框架 ★★ | 🔴 **預設 `RANGE`：兩筆 1980 的累計值都是 4250**；明確 `ROWS` 才得到 2270 / 4250 |
| **G21** | 四種排名函式 | ✅ 並列時 `ROW_NUMBER` 3,4 ／ `RANK` 3,3 → 5 ／ `DENSE_RANK` 3,3 → 4 ／ `PERCENT_RANK` 0.5, 0.5 |
| **G22** | 視窗函式 vs 三種替代 ★★ | 🔴 **先聚合再 JOIN 5.4 ms（1.0x）／視窗函式 81 ms（15x）／反連接 492 ms（91x）／相關子查詢 732 ms（136x）**<br>`EXPLAIN`：前者走 **`Covering index skip scan for grouping`（2021 列）**，後者 **`Sort` 10 萬列**<br>⚠️ 把視窗的 `ORDER BY` 改成 ASC（63→72 ms）或加降序索引（63→63 ms），**`Sort` 都不會消失** |
| **G23** | `LAG` / 累計 / `WINDOW` 子句 | ✅ `LAG` 算出間隔天數；`WINDOW w3 AS (...)` 可重複引用；`COUNT(*) OVER` 可用來擋「不滿三筆」 |
| **G24** | UPSERT 的 `ROW_COUNT()` ★★ | ✅ 新增 **1** ／ 更新且值有變 **2** ／ 更新但值沒變 **0**；`ON DUPLICATE KEY UPDATE a = a` 回 **0**<br>✅ 8.0.20+ 的 `VALUES(...) AS new` 別名語法實測正常 |
| **G25** | UPSERT × `AUTO_INCREMENT` | 🔴 表裡只有 1 列，計數器已到 **3**；下一次插入拿到 **id 3**（id 2 被吃掉） |
| **G26** | `REPLACE INTO` ★★ | 🔴 **id 1 → 2、`avatar_url` → `NULL`、`created_at` 被重設**，`ROW_COUNT()` = 2<br>✅ 對照 `ON DUPLICATE KEY UPDATE`：id 不變、`avatar_url` 保留 |
| **G27** | `INSERT IGNORE` ★★ | 🔴 **三種錯誤全部降級成警告**：1062（重複）、**1265（`'toolong'` → `'too'`）**、**1048（`NULL` → `0`）**；不加 `IGNORE` 時分別是 `ERROR 1062` / `1406` / `1048` |
| **G28** | 多表 `UPDATE` | ✅ `UPDATE ... JOIN (聚合) SET ...` 更新 2 列，carol/dave 保持 0（JOIN 配不上）；**加 `LIMIT` → `ERROR 1221`** |
| **G29** | 自我參照的子查詢 | 🔴 `DELETE FROM t WHERE id IN (SELECT id FROM t ...)` → **`ERROR 1093`**；多包一層衍生表後成功刪 2 列 |
| **G30** | `UNION` vs `UNION ALL` | ✅ 去重 1 列 vs 4 列；`ORDER BY` 放最後套用整體，單一分支要用括號包 |
| **G31** | 隱式轉型 ★★ | 🔴 `'1'=1`、`'01'=1`、`' 1'=1`、`'1.0'=1`、**`'1abc'=1`**、**`'abc'=0`**、**`''=0`** 全部為真<br>而 `'1'='01'`、`'1'='1.0'`、`'10'>'9'` 全部為**假** —— **相等失去傳遞性** |
| **G32** | `WHERE 字串欄位 = 數字` ★★ | 🔴 **一句查出三個不同的電話號碼**（`'0912345678'`、`'0912345678 '`、`'912345678'`）；`'+886...'` 轉成 0 所以沒被選中<br>`EXPLAIN`：**`type: ref` / `rows: 1` → `type: index` / `rows: 4`** |
| **G33** | 反方向與警告 | ✅ `WHERE 數字欄位 = '100'` **安全**（轉常數，索引還在）<br>🔴 `'abc' = 0` 有警告 1292，但 **`phone = 912345678` 那一句完全沒有警告**（轉換「成功」了） |

🔴 **本章沒有驗證到的**：

| 沒驗證的 | 影響哪一節 | 哪一章會補 |
|---|---|---|
| **`EXPLAIN` 的完整讀法**（本章只用了 `type` / `rows` / `Sort`） | 2.8.2、2.6.8 | **03 章**（整章） |
| **八種索引失效情境的完整清單** | 2.8 | 03 章 3.7 |
| **`IN` 接一萬個常數的行為** | 2.5.3 | 05 章 5.6 |
| **UPSERT 的併發與鎖**（練習 3） | 2.7.2 | **04 章** |
| **多表 `UPDATE` 造成的鎖範圍** | 2.7.7 | 04 章 |
| **千萬列規模的 JOIN 演算法**（hash join vs nested loop） | 2.3 | 05 章 |
| **分批 `DELETE` / `UPDATE` 的做法** | 2.7.7 | 05 章 5.9 |
| **`dim_date` 表的實際建立與維護** | 2.5.6、Q6 | 06 章 |
| **`Covering index skip scan` 的觸發條件** | 2.6.8 | 03 章 |

> 📌 **最後一句話**：
>
> 這一章有**四個實測結果，跟「大家都這樣說」不一樣**：
>
> **①「視窗函式是現代寫法，該優先用」** ——
> G22 顯示它比「先聚合再 JOIN」**慢 15 倍**，
> 而且那個 `Sort` **無論怎麼調索引都消不掉**。
> 視窗函式的價值是**表達力**，不是效能。
>
> **②「`NOT IN` 的 NULL 問題，加個 `IS NOT NULL` 就修好了」** ——
> G16 顯示這樣「修好」之後的答案是 **1 列**，而 `NOT EXISTS` 是 **3 列**。
> **NULL 的問題有兩側，而多數人只知道一側。**
>
> **③「`ONLY_FULL_GROUP_BY` 很囉唆，要把所有欄位都寫進 `GROUP BY`」** ——
> G10 顯示 MySQL 8 能沿著 JOIN 的等值條件推導函式依賴，
> `GROUP BY o.id` 之後**連另一張表的欄位都可以 SELECT**。
> 它不囉唆，是你沒給它主鍵。
>
> **④「型別不合，MySQL 會幫我轉，最多是慢一點」** ——
> G32 顯示一句 `WHERE phone = 912345678` **查出三個不同的電話號碼**，
> 而且**沒有任何警告**。它不是效能問題，是**查到別人資料**的問題。
>
> ⚠️ **這一章 33 組實驗裡，有 21 組的「錯答案」是不會報錯的。**
> 而它們有一個共同的形狀：
>
> > **SQL 從來不會拒絕一個「文法正確但問錯了問題」的查詢。**
> > 它會很快、很有禮貌地，給你一個錯的數字。
>
> **下一章開始看 `EXPLAIN`。** 03 章會回答本章留下的兩個問題：
> **為什麼 `type: ref` 比 `type: index` 好一個數量級？**
> 以及 **那個 `Covering index skip scan for grouping` 到底做了什麼，
> 讓一句查詢只讀 2021 列而不是 10 萬列？**

---

**上一章**：[01-schema-design-and-data-types.md](./01-schema-design-and-data-types.md) — Schema 設計與資料型別
**下一章**：[03-index-and-explain.md](./03-index-and-explain.md) — 索引與執行計畫
