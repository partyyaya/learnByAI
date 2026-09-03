# 第 01 章：Schema 設計與資料型別

> 00 章結束時，你有一個設定正確的 MySQL：字元集對了、時區對了、`sql_mode` 對了。
> **現在要在上面建第一張表。**
>
> 這一章要問的問題聽起來像新手問題：
>
> > **「金額這一欄，你為什麼選這個型別？」**
>
> ⚠️ 但它其實是這一站最貴的一個問題。因為：
>
> - 一句 SQL 寫錯，改一行就好。
> - 一個索引建錯，`DROP INDEX` 再建就好。
> - **一個欄位的型別選錯，你要改的是一張已經有五千萬列資料、
>   十七個服務在讀、而且沒有維護窗口的表。**
>
> 本章有一個實測會告訴你這句話的份量：
>
> ```sql
> INSERT INTO fp VALUES (1234567.89), (12345678.9), (99999999);
> SELECT f FROM fp;   -- f 是 FLOAT
> ```
>
> ```
> 1234570        ← 存進去的是 1234567.89
> 12345700       ← 存進去的是 12345678.9
> 100000000      ← 存進去的是 99999999   🔴 差了整整 1 元
> ```
>
> **這三列不是「精度誤差」，是「資料錯了」。**
> 而且它們在 `INSERT` 的時候沒有任何警告。

---

## 1.1 學習目標

完成本章後，你應該可以：

- 說出型別選錯為什麼是**最貴**的錯誤，並用實測數字說明 `ALTER TABLE` 的三種演算法差多少。
- 用**五個問題**評審任何一個欄位的型別選擇。
- 說明為什麼金額**永遠不能**用 `FLOAT` / `DOUBLE`，並展示一個實測：
  **1000 筆 19.99 用 `FLOAT` 加起來是 19989.999771118164，用 `DOUBLE` 是 19990.000000000135，兩個都不等於 19990。**
- 在 `DECIMAL(19,4)` 與 `BIGINT`（存「分」）之間做出有理由的選擇，並說出各自在 Java 側的代價。
- 解釋 `DECIMAL` 運算時 scale 會怎麼變化，以及「什麼時候該 `ROUND`」。
- 分辨 `CHAR` / `VARCHAR` / `TEXT`，並用實測回答一個爭論了二十年的問題：
  **「`VARCHAR(255)` 跟 `VARCHAR(20)` 到底有沒有差？」**（答案在 MySQL 8 上跟以前不一樣）
- 列出 `ENUM` 的**四個陷阱**，並說明狀態欄位的三種存法各自的代價（實測：`VARCHAR` 的索引比 `ENUM` 大 **67%**）。
- 說明 `DATETIME` 的預設小數位是 `0`，而且轉換時是**四捨五入不是截斷** ——
  實測：`23:59:59.6` 存進 `DATETIME` 會變成**隔天的 `00:00:00`**。
- 說出 `NULL` 的三值邏輯在六種情境下的行為，並判斷一個欄位該不該 `NOT NULL`。
- 用實測比較四種主鍵策略的**空間與時間**，並解釋一個關鍵現象：
  **UUID 主鍵的代價在資料量小的時候幾乎看不到（1.25 倍），
  一旦超過 buffer pool 就變成 10 倍。**
- 判斷一條不變量該用 `NOT NULL`、`UNIQUE`、`CHECK`、`FOREIGN KEY` 還是應用層來守 ——
  並解釋**軟刪除 + 唯一索引**這個經典組合為什麼**擋不住重複**（實測）。
- 交出 shop-service 的完整 schema，每一個欄位的型別都能講出理由。

---

## 1.2 為什麼型別選錯是最貴的錯誤

### 1.2.1 三個「改不動」的層次

```
好改    ── SQL 寫錯          → 改一行，重新部署
        ── 索引建錯          → DROP INDEX / CREATE INDEX（線上可做，06 章）
        ── 欄位加長          → 部分情況可 INPLACE（見 1.2.2）
        ── 欄位型別改變      → 🔴 整張表重建（ALGORITHM=COPY），要停機或用 gh-ost
難改    ── 主鍵策略改變      → 🔴 所有二級索引、所有外鍵、所有快取 key 一起變
```

⚠️ **而「改不動」還不是最糟的**。最糟的是這一種：

```
🔴 型別選錯，但【還沒有人發現】
    → 資料已經錯了三年
    → 就算現在改對型別，那三年的資料也回不來
```

本章的 `FLOAT` 實測就是這一種：資料庫沒有報錯、應用沒有例外、
報表上的數字**看起來完全合理** —— 只是每一筆都差了一點點。

### 1.2.2 實測：`ALTER TABLE` 的三種演算法

MySQL 8 的 `ALTER TABLE` 有三種演算法，代價差非常多：

| 演算法 | 做什麼 | 鎖 | 適合 |
|---|---|---|---|
| `INSTANT` | **只改中繼資料**，不碰資料 | 幾乎不鎖 | 8.0.12+ 支援的少數操作 |
| `INPLACE` | 在原表上就地改（可能要重建索引） | 允許並行讀寫（多數情況） | 加索引、部分型別放寬 |
| `COPY` | **建一張新表，一列一列複製過去** | 🔴 整段期間**唯讀** | 其他全部 |

**實測**（100,000 列、6 欄、3 個二級索引的表）：

```sql
-- ① 加一個可為 NULL 的欄位
ALTER TABLE ix3 ADD COLUMN memo VARCHAR(100) NULL, ALGORITHM=INSTANT;
```

```
04:53:14.827  →  04:53:14.843      ★ 16 毫秒（只改中繼資料）
```

```sql
-- ② VARCHAR(16) → VARCHAR(32)
ALTER TABLE ix3 MODIFY status VARCHAR(32) NOT NULL, ALGORITHM=INSTANT;
```

```
ERROR 1845 (0A000): ALGORITHM=INSTANT is not supported for this operation.
                    Try ALGORITHM=COPY/INPLACE.
```

```sql
ALTER TABLE ix3 MODIFY status VARCHAR(32) NOT NULL, ALGORITHM=INPLACE;   -- ✅ 成功
```

```sql
-- ③ VARCHAR(32) → VARCHAR(300)   ★ 跨過一條看不見的線
ALTER TABLE ix3 MODIFY status VARCHAR(300) NOT NULL, ALGORITHM=INPLACE;
```

```
ERROR 1846 (0A000): ALGORITHM=INPLACE is not supported.
                    Reason: Cannot change column type INPLACE. Try ALGORITHM=COPY.
```

⚠️ **② 可以 INPLACE、③ 不行 —— 兩個都只是「把 VARCHAR 加長」。**

**為什麼**：`VARCHAR` 的每一列都有一個「長度前綴」。
當**最大位元組數 ≤ 255** 時用 **1 個位元組**，超過就要 **2 個位元組**。

```
VARCHAR(16)  utf8mb4 →  16 × 4 =   64 bytes ≤ 255  → 長度前綴 1 byte
VARCHAR(32)  utf8mb4 →  32 × 4 =  128 bytes ≤ 255  → 長度前綴 1 byte   ✅ 沒變，可以 INPLACE
VARCHAR(300) utf8mb4 → 300 × 4 = 1200 bytes > 255  → 長度前綴 2 bytes  🔴 每一列的實體格式都變了
```

**這條線在 utf8mb4 下正好落在 `VARCHAR(63)` 與 `VARCHAR(64)` 之間**
（`63 × 4 = 252 ≤ 255`，`64 × 4 = 256 > 255`）。**實測**：

```sql
ALTER TABLE vb MODIFY v VARCHAR(63), ALGORITHM=INPLACE;   -- ✅ 成功
ALTER TABLE vb MODIFY v VARCHAR(64), ALGORITHM=INPLACE;   -- 🔴 ERROR 1846，要 COPY
```

⚠️ **而「縮短」永遠是 COPY**，不管跨不跨那條線：

```sql
ALTER TABLE vb MODIFY v VARCHAR(30), ALGORITHM=INPLACE;   -- 🔴 ERROR 1846（從 64 縮回 30）
```

📌 **所以 `VARCHAR` 的長度是「只能變大、而且只能在同一個前綴級距裡免費變大」** ——
這是 1.4.2 討論「宣告長度該給多少」時的一個關鍵前提。

```sql
-- ④ INT → BIGINT
ALTER TABLE ix3 MODIFY qty BIGINT NOT NULL DEFAULT 0, ALGORITHM=INPLACE;
```

```
ERROR 1846: ALGORITHM=INPLACE is not supported.
            Reason: Cannot change column type INPLACE. Try ALGORITHM=COPY.
```

```sql
-- ⑤ 實際跑一次 COPY
SELECT NOW(3); ALTER TABLE ix3 MODIFY qty BIGINT ..., ALGORITHM=COPY, LOCK=SHARED; SELECT NOW(3);
```

```
04:53:16.120  →  04:53:16.692      ★ 572 毫秒（100,000 列）
```

📌 **把 572 毫秒 / 10 萬列拿去外推**：

| 表的大小 | 粗估 COPY 時間 | 這段期間 |
|---|---|---|
| 10 萬列 | **0.57 秒**（實測） | 唯讀 |
| 1,000 萬列 | 約 1 分鐘 | 🔴 **唯讀 1 分鐘** |
| 1 億列 | 約 10 分鐘 | 🔴 **唯讀 10 分鐘** |

⚠️ **而且這是本機 SSD、資料全在 buffer pool、沒有其他負載的理想數字。**
正式環境（更多欄位、更多索引、有寫入競爭、要等 metadata lock）通常是這個數字的**三到十倍**。

> 📌 **「唯讀 10 分鐘」在多數電商是不可接受的。**
> 所以真實世界的做法是 `gh-ost` / `pt-online-schema-change`（06 章 6.7），
> 那是一套「建影子表 → 追 binlog → 原子改名」的流程 ——
> **它能做，但它是一場需要規劃、需要監控、可能要回滾的變更。**
>
> **這一切的起點，就是三年前有人在 `CREATE TABLE` 裡寫了 `INT` 而不是 `BIGINT`。**

### 1.2.3 本章的判準：五個問題

每一個欄位，問這五個問題。**答不出來就不要建那張表。**

```
① 它的【值域】是什麼？        最大會到多少？會不會是負的？未來十年呢？
② 它需要【精確】嗎？          會不會被拿去加減乘除？會不會被拿去對帳？
③ 它會不會被【比較】？        =、範圍、排序、GROUP BY、JOIN —— 用哪一種語意？
④ 它可以是【未知】的嗎？      NULL 對這一欄有沒有意義？跟「空值」「零」差在哪？
⑤ 它會不會被【索引】？        會的話，它有多大？（每個二級索引還要再存一份主鍵）
```

⚠️ **第 ⑤ 個問題最常被忽略，但它與主鍵策略綁在一起** ——
1.8.1 會說明為什麼「主鍵大 8 個位元組」會讓**每一個二級索引**都變大。

---

## 1.3 數字型別 ★★

### 1.3.1 整數家族

| 型別 | 位元組 | 有號範圍 | 無號範圍 | 什麼時候用 |
|---|---|---|---|---|
| `TINYINT` | 1 | −128 ～ 127 | 0 ～ 255 | 狀態碼、旗標、小計數 |
| `SMALLINT` | 2 | −32,768 ～ 32,767 | 0 ～ 65,535 | 年份、數量上限明確的欄位 |
| `MEDIUMINT` | 3 | −8,388,608 ～ 8,388,607 | 0 ～ 16,777,215 | 很少用（省 1 byte 通常不值得） |
| `INT` | 4 | −2,147,483,648 ～ **2,147,483,647** | 0 ～ 4,294,967,295 | 一般計數 |
| `BIGINT` | 8 | ±9.22 × 10¹⁸ | 0 ～ 1.8 × 10¹⁹ | **主鍵、金額（存分）、任何會成長的 id** |

**實測**（存入各型別的最大值）：

```sql
CREATE TABLE t_int (a TINYINT, b SMALLINT, c MEDIUMINT, d INT, e BIGINT, f INT UNSIGNED);
INSERT INTO t_int VALUES (127, 32767, 8388607, 2147483647, 9223372036854775807, 4294967295);
```

```
a    b      c        d           e                    f
127  32767  8388607  2147483647  9223372036854775807  4294967295
```

⚠️ **`INT` 的上限 21 億，看起來很大 —— 直到它不夠。**

真實世界踩過這個坑的例子：

```
訂單明細表         一天 300 萬列 → 兩年就滿了
日誌 / 事件表      一天 5000 萬列 → 43 天就滿了
自增主鍵           ★ 而且 1.8.5 會告訴你「洞」會讓它比你想的更快用完
```

📌 **本課的規則：任何 `AUTO_INCREMENT` 主鍵一律 `BIGINT`。**
省下來的 4 個位元組（一億列 = 400 MB）**不值得那場停機遷移**。

### 1.3.2 `UNSIGNED` 的兩個坑

`UNSIGNED` 讓正數的範圍加倍，聽起來是免費的好處。**它不是。**

**坑一：`UNSIGNED` 相減變負數會直接拋錯 —— 連 `SELECT` 都會**

```sql
CREATE TABLE us (qty INT UNSIGNED NOT NULL);
INSERT INTO us VALUES (3);

SELECT qty - 5 FROM us;                 -- ?
```

```
ERROR 1690 (22003): BIGINT UNSIGNED value is out of range in '(`shop`.`us`.`qty` - 5)'
```

⚠️ **這是一句純粹的 `SELECT`，它報錯了。**

實測顯示這個行為**與 `sql_mode` 的嚴格程度無關** ——
`SET SESSION sql_mode=''` 之後仍然是同一個錯誤。
要讓它回傳 `-2`，必須明確加上 `NO_UNSIGNED_SUBTRACTION` 這個模式：

```sql
SET SESSION sql_mode = 'NO_UNSIGNED_SUBTRACTION';
SELECT CAST(3 AS UNSIGNED) - CAST(5 AS UNSIGNED);   -- -2
```

📌 **這對 06 站 00 章 0.8.3 那個「原子 UPDATE 守庫存」的寫法有直接影響**：

```sql
-- 06 站的 tryReserve
UPDATE stock SET qty = qty - ? WHERE sku = ? AND qty >= ?;
```

```
qty 是 INT（有號）        → 條件不成立時【更新 0 列】，程式判斷 rowsAffected == 0 → 庫存不足
qty 是 INT UNSIGNED      → 🔴 MySQL 會先算 qty - ?，超出範圍就【拋 ERROR 1690】
```

⚠️ **兩者的錯誤處理路徑完全不同**：
一個是「回傳 0，走業務例外」，另一個是「拋 `SQLException`，走技術例外」——
而 05 站 05 章的例外分層會把後者當成 500，而不是 409。

**所以 `UNSIGNED` 不只是「範圍加倍」，它改變了你的錯誤語意。**

**坑二：Java 沒有 unsigned**

```java
// MySQL 的 BIGINT UNSIGNED 最大值 18446744073709551615
// Java 的 long 最大值            9223372036854775807      ← 只有一半
```

JDBC 讀 `BIGINT UNSIGNED` 時會回 `BigInteger`（或在超出範圍時出錯），
於是你的 entity 欄位型別、DTO、JSON 序列化全部要跟著特別處理。

> 📌 **本課的規則：只在「值域明確、且絕不參與減法」的欄位用 `UNSIGNED`。**
> 實務上這幾乎只剩 `TINYINT UNSIGNED` 的狀態碼。
> **主鍵用 `BIGINT`（有號）就好** —— 9.2 × 10¹⁸ 這個數字，
> 就算每秒插一億列也要跑 29 億年。

### 1.3.3 `int(11)` 的顯示寬度已經沒有意義

```sql
CREATE TABLE t (id INT(11));
```

那個 `11` **從來就不限制存的值**（`INT(1)` 一樣可以存 2147483647），
它只是「顯示時補幾個空白」的提示，而且只在 `ZEROFILL` 時才有作用。

**MySQL 8.0.17 起，整數的顯示寬度已經 deprecated**，
`SHOW CREATE TABLE` 不再顯示它（`TINYINT(1)` 是唯一的例外，見 1.6.1）。

📌 **所以：寫 `INT`，不要寫 `INT(11)`。**
看到舊 schema 裡的 `INT(11)` 也不用改 —— 它本來就沒有作用。

### 1.3.4 實測：`FLOAT` 的有效位數 ★★

```sql
CREATE TABLE fp (f FLOAT, d DOUBLE, de DECIMAL(20,2));
INSERT INTO fp VALUES (1234567.89, 1234567.89, 1234567.89),
                      (12345678.9, 12345678.9, 12345678.9),
                      (99999999,   99999999,   99999999);
SELECT f, d, de FROM fp;
```

```
f            d            de
1234570      1234567.89   1234567.89        ← 🔴 FLOAT 差 2.11
12345700     12345678.9   12345678.90       ← 🔴 FLOAT 差 21.1
100000000    99999999     99999999.00       ← 🔴 FLOAT 差 1（而且變成一個「整齊」的數字）
```

**`FLOAT` 是 32 位元 IEEE 754，只有約 7 位十進位有效數字。**

⚠️ **看第三列**：`99999999` 存進去變成 `100000000`。
一個「9999 萬 9999 元」的交易，變成「1 億元」。
**而且它變成一個看起來非常合理、非常整齊的數字** ——
沒有任何人會在報表上覺得「1 億」這個數字有問題。

**相等比較**：

```sql
SELECT f = 1234567.89 AS f_eq, d = 1234567.89 AS d_eq, de = 1234567.89 AS de_eq FROM fp LIMIT 1;
```

```
f_eq   d_eq   de_eq
0      1      1        ← 🔴 FLOAT 存進去的值，跟你存的那個值不相等
```

📌 **`WHERE amount = 1234567.89` 在 `FLOAT` 欄位上永遠查不到那一列。**
於是「這筆訂單在資料庫裡明明有，程式就是查不到」——
而 log 裡的 SQL 看起來完全正常。

### 1.3.5 實測：1000 筆 19.99 加起來 ★★

這是 00 章 README 承諾的「對帳永遠差幾分錢」的實測。

```sql
CREATE TABLE acc (id INT PRIMARY KEY AUTO_INCREMENT,
                  f FLOAT, d DOUBLE, dec2 DECIMAL(10,2), cents BIGINT);
INSERT INTO acc (f,d,dec2,cents) SELECT 19.99, 19.99, 19.99, 1999 FROM v_short LIMIT 1000;

SELECT COUNT(*) n, SUM(f) sum_float, SUM(d) sum_double,
       SUM(dec2) sum_decimal, SUM(cents)/100 sum_cents FROM acc;
```

```
n     sum_float             sum_double             sum_decimal   sum_cents
1000  19989.999771118164    19990.000000000135     19990.00      19990.0000
      ^^^^^^^^^^^^^^^^^^    ^^^^^^^^^^^^^^^^^^     ^^^^^^^^      ^^^^^^^^^
      🔴 少了 0.000229      🔴 多了 0.000000000135  ✅ 正確       ✅ 正確
```

```sql
SELECT SUM(f) = 19990 AS float_eq, SUM(d) = 19990 AS double_eq, SUM(dec2) = 19990 AS dec_eq FROM acc;
```

```
float_eq   double_eq   dec_eq
0          0           1
```

⚠️ **`DOUBLE` 也錯。** 很多人以為「`FLOAT` 不行，用 `DOUBLE` 就好了」——
`DOUBLE` 有 15～17 位有效數字，比 `FLOAT` 好很多，但它**仍然是二進位浮點數**，
而 **0.01 在二進位裡是無限循環小數**，跟十進位的 1/3 一樣。

📌 **1000 筆只差 1.35 × 10⁻¹⁰，聽起來可以忽略。問題在於它會累積**：

```
一天 100 萬筆交易 × 一年 365 天 = 3.65 億筆
誤差不是線性累積（正負會抵銷一部分），但也不會消失
        ↓
真正的問題不是「總額差多少」，是：
🔴 SUM(amount) = 19990 這個條件永遠是 false
🔴 兩個系統各自算出來的總額【不相等】，而你無法判斷誰是對的
🔴 財務要求「對到分」的時候，你沒有辦法證明任何事
```

> 📌 **這就是「金額不能用浮點數」的真正原因**：
> 不是「誤差太大」，是 **「你失去了『相等』這個概念」**。
> 而對帳這件事，本質上就是在問「這兩個數字相不相等」。

### 1.3.6 `DECIMAL`：怎麼用

```sql
DECIMAL(M, D)
        │  └── scale：小數點後幾位
        └───── precision：總共幾位數字（含小數）
```

```
DECIMAL(10,2)   最大 99999999.99          （8 位整數 + 2 位小數）
DECIMAL(19,4)   最大 999999999999999.9999 （15 位整數 + 4 位小數）
DECIMAL(65,30)  MySQL 的上限：precision 最大 65、scale 最大 30
```

**`DECIMAL` 是精確的十進位數**，MySQL 用「每 9 位十進位數字打包成 4 個位元組」的方式儲存。

⚠️ **它有一個容易忽略的行為：寫入時會依 scale 四捨五入。**

```sql
CREATE TABLE m (amt DECIMAL(10,2));
INSERT INTO m VALUES (0.615);
SELECT amt FROM m;      -- 0.62      ★ 存進去的當下就被四捨五入了，原值回不來
```

📌 **這通常是好事**（它強迫你在寫入時就決定精度），
但要知道它發生在**寫入**，不是讀取 —— 所以「先存原值、之後再決定要幾位」是做不到的。

### 1.3.7 `DECIMAL` 運算時 scale 會長大

```sql
SELECT 10.00 / 3                                      AS 除法;      -- 3.333333    ← scale 變 6
SELECT 10.00 * 3                                      AS 乘法;      -- 30.00       ← scale 不變
SELECT CAST(19.99 AS DECIMAL(10,2)) * 3
       * CAST(0.85 AS DECIMAL(5,4))                   AS 連乘;      -- 50.974500   ← scale 變 6
SELECT ROUND(CAST(19.99 AS DECIMAL(10,2)) * 3
       * CAST(0.85 AS DECIMAL(5,4)), 2)               AS 四捨五入;  -- 50.97
```

**規則**：

```
加減：  scale = max(兩邊的 scale)
乘法：  scale = 兩邊的 scale 相加
除法：  scale = 左邊的 scale + div_precision_increment（預設 4）
```

⚠️ **這代表「訂單金額 × 數量 × 折扣」的結果，scale 會比你的欄位大。**
如果直接寫回一個 `DECIMAL(10,2)` 欄位，MySQL 會**幫你四捨五入** ——
而**四捨五入的時機**正是對帳差錢的第二大來源（第一大是浮點數）。

📌 **本課的規則：四捨五入只在一個地方做，而且是明確做的。**

```
🔴 錯的：在 SQL 裡計算金額，讓資料庫決定什麼時候捨入
✅ 對的：金額計算全部在 Java 的 Money 值物件裡（05 站 0.5.3），
        每一步的捨入規則寫死在程式碼裡、有測試，
        SQL 只負責【存已經算好的結果】與【把已經算好的結果加起來】
```

> ⚠️ **例外**：報表的 `SUM()` 是可以（也應該）在 SQL 做的 ——
> 因為加法不改變 scale，不會有捨入問題。
> **危險的是乘法與除法。**

### 1.3.8 金額：`DECIMAL(19,4)` 還是 `BIGINT` 存「分」

兩種做法都是對的，選一個然後**整個系統一致**。

| | `DECIMAL(19,4)` | `BIGINT`（存最小單位） |
|---|---|---|
| 儲存 | 9 bytes | **8 bytes** |
| SQL 可讀性 | ✅ `SELECT amount` 直接是 `19.99` | 🔴 `SELECT amount/100`，而且 `/100` 會變成 `DECIMAL` |
| 精確 | ✅ | ✅ |
| 除法 / 分攤 | 有 scale 規則要注意 | ✅ 整數除法，餘數明確 |
| Java 對應 | `BigDecimal` | `long`（包在 `Money` 值物件裡） |
| 多幣別 | 🟡 不同幣別小數位不同（JPY 0 位、KWD 3 位），`(19,4)` 要涵蓋最大的 | 🟡 一樣要記「這個幣別的最小單位是多少」 |
| 誤用的風險 | 🔴 有人直接 `amount + 1`，以為是加 1 元（對）| 🔴 有人直接 `amount + 1`，以為是加 1 元（**錯，是加 1 分**） |
| 溢位 | precision 用完會報錯 | 🔴 `long` 溢位**不會報錯**，會繞回去 |

📌 **本課採用 `DECIMAL(19,4)`**，理由是：

```
① SQL 的可讀性。DBA、報表工程師、資料分析師都會直接讀這張表 ——
   讓他們看到 19.99 而不是 1999，能省下大量誤會。
② scale 給 4 位（不是 2 位），是為了容納【單價 × 折扣】這種中間結果，
   以及 KWD / BHD 這種 3 位小數的幣別。
③ 05 站 0.5.3 的 Money 值物件已經處理了 Java 這一側的所有捨入 ——
   資料庫這一層只需要「存得下、加得對」。
```

⚠️ **但「用哪一種」不是重點，重點是**：

> **不管選哪一種，都要用一個值物件包起來，讓「原始數字」不會漏到業務程式碼裡。**
> 05 站 0.5.3 講過這件事；本章只是確認資料庫這一側的型別能支撐它。

### 1.3.9 Java 這一側：`BigDecimal` 的三個坑

**坑一：`new BigDecimal(double)` 會把浮點數的誤差帶進來**

```java
new BigDecimal(0.1)      // 0.1000000000000000055511151231257827021181583404541015625  🔴
new BigDecimal("0.1")    // 0.1                                                        ✅
BigDecimal.valueOf(0.1)  // 0.1  （內部走 Double.toString，安全）                        ✅
```

**坑二：`equals()` 比 scale，`compareTo()` 不比**

```java
new BigDecimal("1.0").equals(new BigDecimal("1.00"))       // false  🔴
new BigDecimal("1.0").compareTo(new BigDecimal("1.00"))    // 0      ✅
```

⚠️ 這代表 **`BigDecimal` 不能直接當 `HashMap` 的 key，也不能直接放進 `Set` 去重** ——
因為 `hashCode()` 也含 scale。
而從資料庫讀出來的 `DECIMAL(19,4)` 一律是 scale 4，
**你在 Java 裡 `new BigDecimal("19.99")` 建的是 scale 2**：

```java
BigDecimal fromDb   = rs.getBigDecimal("amount");   // 19.9900  (scale 4)
BigDecimal expected = new BigDecimal("19.99");      // 19.99    (scale 2)

assertThat(fromDb).isEqualTo(expected);              // 🔴 失敗
assertThat(fromDb).isEqualByComparingTo(expected);   // ✅ 通過
```

📌 **這是資料層測試裡最常見的一種「明明是對的卻紅了」**（06 站 06 章的探針之一）。

**坑三：除法沒指定 scale 會拋例外**

```java
new BigDecimal("10").divide(new BigDecimal("3"));
// java.lang.ArithmeticException: Non-terminating decimal expansion;
//                                no exact representable decimal result.

new BigDecimal("10").divide(new BigDecimal("3"), 2, RoundingMode.HALF_UP);   // ✅ 3.33
```

⚠️ **`RoundingMode` 要選對，而且要跟財務確認**：

| Mode | 0.5 會變成 | 適合 |
|---|---|---|
| `HALF_UP` | 1 | 一般商業計算（台灣、多數場景） |
| `HALF_EVEN` | 0（銀行家捨入） | **金融**；大量捨入時無系統性偏差 |
| `DOWN` | 0 | 對己方不利時保守（例如算給客戶的回饋點數） |

### 1.3.10 數字型別決策表

| 這一欄是 | 用 | 不要用 | 為什麼 |
|---|---|---|---|
| 主鍵（自增） | `BIGINT AUTO_INCREMENT` | `INT` | 1.3.1：21 億不夠，而且 1.8.5 的「洞」會加速消耗 |
| 金額 | `DECIMAL(19,4)` | 🔴 `FLOAT` / `DOUBLE` | 1.3.4、1.3.5 |
| 數量 | `INT`（或 `SMALLINT` 若值域明確） | `DECIMAL` | 數量是整數；用 `DECIMAL` 會邀請別人存 1.5 個 |
| 折扣率 / 稅率 | `DECIMAL(5,4)`（0.0000～9.9999） | `FLOAT` | 會被拿去乘 |
| 百分比（顯示用） | `DECIMAL(5,2)` | — | 85.00 表示 85% |
| 版本號（樂觀鎖） | `BIGINT`（或 `INT`） | — | 06 站 0.14.1 的 `version` |
| 狀態碼 | `TINYINT UNSIGNED` 或 `VARCHAR` | — | 見 1.4.5 的三種存法比較 |
| 座標 / 距離 | `DECIMAL(10,7)` 或空間型別 | `FLOAT` | 緯度需要 7 位小數才到公分級 |
| 科學量測值 | ✅ `DOUBLE` 是**對的** | — | 這是浮點數**該用**的地方：值域大、精度相對、不做相等比較 |

> 📌 **最後一列很重要**：`DOUBLE` 不是壞型別，它只是**不適合金額**。
> 溫度、重量、感測器讀數、機率、統計值 —— 這些本來就是近似的量，用 `DOUBLE` 是對的。
> **判準是 1.2.3 的第 ② 個問題：「它會不會被拿去對帳？」**

---

## 1.4 字串型別 ★

### 1.4.1 `CHAR` vs `VARCHAR`：尾端空白

```sql
CREATE TABLE t_str (c CHAR(10), v VARCHAR(10)) CHARSET=utf8mb4;
INSERT INTO t_str VALUES ('abc  ', 'abc  ');       -- 兩欄都存「abc」加兩個空白
SELECT CONCAT('[',c,']') ch, CONCAT('[',v,']') va, LENGTH(c) lc, LENGTH(v) lv FROM t_str;
```

```
ch       va         lc   lv
[abc]    [abc  ]    3    5
^^^^^                     ← 🔴 CHAR 把尾端空白吃掉了
```

**`CHAR(n)` 的行為**：儲存時右補空白到 n 個字元，**讀取時把尾端空白全部去掉**。
於是 `CHAR` 欄位**存不住尾端空白**。

```sql
SELECT 'abc' = 'abc  ' AS eq, 'abc' LIKE 'abc  ' AS lk, STRCMP('abc','abc  ') AS cmp;
```

```
eq   lk   cmp
0    0    -1        ← 在 utf8mb4_0900_ai_ci（NO PAD）之下
```

📌 **注意這跟 00 章 0.5.9 是同一件事的另一面**：
`NO PAD` 定序下 `'abc' <> 'abc  '`，而 `CHAR` 欄位又存不住尾端空白 ——
**所以「用 `CHAR` 就不用擔心尾端空白」這句話在 MySQL 8 上是對的，但理由跟大部分人想的不同。**

| | `CHAR(n)` | `VARCHAR(n)` |
|---|---|---|
| 儲存 | 固定 n 個字元的空間 | 實際長度 + 1～2 bytes 前綴 |
| 尾端空白 | 🔴 **存不住** | ✅ 保留 |
| 更新時 | 長度固定，不會造成列變長 → 不會頁分裂 | 變長時可能造成列搬移 |
| 適合 | **長度真的固定**的東西 | 其他全部 |

**真的長度固定的東西不多**：

```
✅ 性別代碼 'M'/'F'、幣別 'TWD'/'USD'（ISO 4217 三碼）、國碼 'TW'（ISO 3166 兩碼）
✅ 固定格式的雜湊：MD5 CHAR(32)、SHA-256 CHAR(64)   ← 但更好的是 BINARY(16)/(32)，見 1.6.4
🔴 手機號碼        —— 各國長度不同，還有 +886 前綴
🔴 身分證字號      —— 台灣是 10 碼，但外籍居留證是別的格式
🔴 郵遞區號        —— 3 碼 / 5 碼 / 6 碼都有
```

### 1.4.2 實測：宣告長度到底有沒有代價 ★★

這是一個吵了二十年的問題：**`VARCHAR(255)` 跟 `VARCHAR(20)` 存同樣的資料，有沒有差別？**

**傳統答案**：「儲存沒差（都是實際長度），但排序 / 暫存表會按**宣告長度**配置記憶體，所以有差。」

**MySQL 8 上實測**：

```sql
CREATE TABLE v_short (id INT PRIMARY KEY, v VARCHAR(20))   CHARSET=utf8mb4;   -- 10 萬列
CREATE TABLE v_long  (id INT PRIMARY KEY, v VARCHAR(2000)) CHARSET=utf8mb4;   -- 同樣的 10 萬列
```

**實驗 A：MySQL 8 的預設暫存表引擎（`TempTable`）**

```sql
SELECT @@internal_tmp_mem_storage_engine;    -- TempTable
SELECT COUNT(*) FROM (SELECT v FROM v_short ORDER BY v LIMIT 100000) t;
SELECT COUNT(*) FROM (SELECT v FROM v_long  ORDER BY v LIMIT 100000) t;
```

```
Query_ID   Duration      Query
1          0.03167725    ... v_short ...
2          0.03114400    ... v_long  ...
3          0.03054200    ... v_short ...
4          0.03211325    ... v_long  ...
```

⚠️ **沒有差別。** 31 毫秒 vs 31 毫秒。

**實驗 B：換成舊的 `MEMORY` 引擎**

```sql
SET SESSION internal_tmp_mem_storage_engine = MEMORY;
SELECT COUNT(*) FROM (SELECT v, COUNT(*) FROM v_short GROUP BY v) t;
SELECT COUNT(*) FROM (SELECT v, COUNT(*) FROM v_long  GROUP BY v) t;
```

```
Query_ID   Duration      Query
1          0.04220475    ... v_short ...      ← 42 ms
2          0.17477050    ... v_long  ...      ← 🔴 174 ms（4.1 倍）
3          0.04220475    ... v_short ...
4          0.17186275    ... v_long  ...

SHOW SESSION STATUS LIKE 'Created_tmp%';
Created_tmp_disk_tables    4          ← 🔴 溢出到磁碟了
Created_tmp_tables        10
```

**`MEMORY` 引擎把 `VARCHAR(2000)` 當成固定 8000 位元組配置**，
於是 10 萬列的暫存表撐爆 `tmp_table_size`，**溢出到磁碟**。

📌 **所以那個「傳統答案」不是錯的，它是【過期的】**：

```
MySQL 5.6 及以前      → 暫存表用 MEMORY 引擎 → 宣告長度【有】代價
MySQL 5.7             → 同上
MySQL 8.0 預設        → 暫存表用 TempTable 引擎（變長儲存）→ 宣告長度【幾乎沒有】代價
MySQL 8.0 但有人改了  → internal_tmp_mem_storage_engine=MEMORY → 代價回來了
```

⚠️ **但這不代表「宣告長度可以隨便給」。它仍然有四個代價**：

| 代價 | 說明 |
|---|---|
| **① 索引長度上限** | 00 章 0.5.11：`utf8mb4` 下建索引最多 768 字元；複合索引共用 3072 bytes 的額度 |
| **② 一列的 65535 位元組上限** | 實測：`VARCHAR(16383)` 可以，`VARCHAR(16384)` 報 `ERROR 1074`；五個 `VARCHAR(16000)` 一起報 `ERROR 1118` |
| **③ 前綴 1 vs 2 bytes 的 ALTER 界線** | 1.2.2：`VARCHAR(63)` ↔ `VARCHAR(64)` 之間要 COPY |
| **④ 它是一份文件** | `VARCHAR(255)` 對讀 schema 的人**什麼都沒說**；`VARCHAR(32)` 說了「這是一個編號」 |

> 📌 **本課的規則**：
> **依照業務上的真實上限來給，再往上留一點餘裕，並在註解裡寫下理由。**
>
> ```sql
> order_no    VARCHAR(32)  NOT NULL COMMENT '格式 SO-YYYY-NNNNNNNN，目前 16 碼，留餘裕',
> email       VARCHAR(255) NOT NULL COMMENT 'RFC 5321 的上限是 254',
> product_name VARCHAR(200) NOT NULL COMMENT '前端輸入框限制 100 字，留兩倍',
> ```
>
> ⚠️ **不要因為「反正沒有代價」就一律 `VARCHAR(255)`** ——
> ④ 那個代價是永久的，而且它每天都在發生。

### 1.4.3 `TEXT` / `BLOB`：行外儲存

| 型別 | 上限 | 長度前綴 |
|---|---|---|
| `TINYTEXT` / `TINYBLOB` | 255 bytes | 1 |
| `TEXT` / `BLOB` | 65,535 bytes（64 KB） | 2 |
| `MEDIUMTEXT` / `MEDIUMBLOB` | 16 MB | 3 |
| `LONGTEXT` / `LONGBLOB` | 4 GB | 4 |

⚠️ **注意上限的單位是 `bytes` 不是字元。**
而「幾個字」取決於**是哪一種字**，因為 utf8mb4 是變長編碼：

| 內容 | 每字 bytes | `TEXT`（65,535 bytes）能存 | 實測 |
|---|---|---|---|
| ASCII | 1 | 65,535 | |
| 常見中文（BMP，如「中」） | **3** | **21,845** | ✅ 21,845 OK、21,846 → `ERROR 1406` |
| emoji / CJK 擴充區（如 😀、𠀋） | **4** | **16,383** | ✅ 16,383 OK（65,532 bytes）、16,384 → `ERROR 1406` |

🔴 **所以「TEXT 能存 16,383 個中文字」是錯的** ——
那是 4-byte 字元的數字。常見中文是 3 bytes，答案是 **21,845**。
（02 章 2.4.5 算 `group_concat_max_len` 時用的也是 3 bytes，兩章一致。）

⚠️ **但容量規劃要用 16,383 那一行**：使用者可以在任何欄位貼 emoji，
而你不能假設「這個欄位只會有中文」。

**它們不佔一列的 65535 位元組額度**：

```sql
-- 🔴 五個 VARCHAR(16000)
CREATE TABLE t_row (a VARCHAR(16000), b VARCHAR(16000), c VARCHAR(16000),
                    d VARCHAR(16000), e VARCHAR(16000)) CHARSET=utf8mb4;
```

```
ERROR 1118 (42000): Row size too large. The maximum row size for the used table type,
                    not counting BLOBs, is 65535.
```

```sql
-- ✅ 八個 TEXT
CREATE TABLE t_row4 (a TEXT, b TEXT, c TEXT, d TEXT,
                     e TEXT, f TEXT, g TEXT, h TEXT) CHARSET=utf8mb4;   -- 成功
```

因為在 `DYNAMIC` 列格式下（MySQL 5.7.7+ 的預設），**大欄位的值存在「行外頁」，
列本身只留一個 20 位元組的指標**。

**實測：這代表「不碰那一欄」是真的省事**

```sql
CREATE TABLE blobt (id INT AUTO_INCREMENT PRIMARY KEY, small_v VARCHAR(100), big_t TEXT) CHARSET=utf8mb4;
INSERT INTO blobt (small_v, big_t) SELECT 'x', REPEAT('a', 60000) FROM v_short LIMIT 500;
-- 500 列 × 60 KB = 31.5 MB
```

```
Query_ID   Duration      Query
1          0.00023300    SELECT COUNT(small_v) FROM blobt      ← 0.23 ms
2          0.00205675    SELECT COUNT(big_t)   FROM blobt      ← 2.06 ms（9 倍）
3          0.00194075    SELECT SUM(LENGTH(big_t)) FROM blobt  ← 1.94 ms
```

📌 **`SELECT *` 在一張有 `TEXT` 的表上，比 `SELECT id, name` 貴一個數量級** ——
而且這個代價**不會出現在 `EXPLAIN` 裡**（03 章）。

**四條規則**：

```
① 大內容（文章、HTML、JSON 快照）→ TEXT，但【永遠不要 SELECT *】
② 檔案（圖片、PDF）→ 🔴 不要放資料庫。放物件儲存，資料庫只存 URL 與中繼資料
③ TEXT / BLOB 欄位不能有 DEFAULT 值
④ 如果那張表很常被掃描，把 TEXT 拆到另一張「附屬表」，用主鍵一對一關聯
```

### 1.4.4 `ENUM` 的四個陷阱 ★

`ENUM` 看起來很吸引人：型別安全、省空間、資料庫幫你擋錯值。**它有四個陷阱。**

**陷阱一：排序按「內部序號」，不是字母序**

```sql
CREATE TABLE t_enum (id INT PRIMARY KEY, st ENUM('PENDING','PAID','SHIPPED','CANCELLED'));
INSERT INTO t_enum VALUES (1,'SHIPPED'),(2,'PAID'),(3,'CANCELLED'),(4,'PENDING');
SELECT id, st, st+0 AS 內部序號 FROM t_enum ORDER BY st;
```

```
id   st          內部序號
4    PENDING     1
2    PAID        2
1    SHIPPED     3
3    CANCELLED   4          ← 按【宣告順序】排，不是按字母
```

```sql
SELECT id, st FROM t_enum ORDER BY CAST(st AS CHAR);    -- 這樣才是字母序
```

⚠️ **這有時候是優點**（訂單狀態按流程排序很合理），
但它是一個**隱藏在 `CREATE TABLE` 裡的排序規則**，而讀查詢的人看不到它。

**陷阱二：寫入不存在的值，在非嚴格模式下變成空字串**

```sql
INSERT INTO t_enum VALUES (5,'REFUNDED');       -- 嚴格模式
```

```
ERROR 1265 (01000): Data truncated for column 'st' at row 1
```

```sql
SET SESSION sql_mode='';
INSERT INTO t_enum VALUES (5,'REFUNDED');
SELECT id, st, st+0 FROM t_enum WHERE id=5;
```

```
id   st        st+0
5    （空的）   0        ← 🔴 一個不在列舉裡的「第 0 個值」
```

📌 **`ENUM` 的 0 號值是一個特殊的「錯誤值」**，它是空字串，而且不等於任何一個合法值。
**這是 00 章 0.8 那個「保持嚴格模式」規則的又一個理由。**

**陷阱三：加值可能要重建整張表**

```sql
-- ✅ 加在【最後面】
ALTER TABLE t_enum MODIFY st ENUM('PENDING','PAID','SHIPPED','CANCELLED','REFUNDED'),
      ALGORITHM=INSTANT;       -- 成功，毫秒級
```

```sql
-- 🔴 插在【中間】（例如在 SHIPPED 前面加 PACKED）
ALTER TABLE t_enum MODIFY st ENUM('PENDING','PAID','PACKED','SHIPPED','CANCELLED','REFUNDED'),
      ALGORITHM=INSTANT;
```

```
ERROR 1846 (0A000): ALGORITHM=INSTANT is not supported.
                    Reason: Need to rebuild the table to change column type.
                    Try ALGORITHM=COPY/INPLACE.
```

⚠️ **因為插在中間會改變後面所有值的內部序號** —— 每一列的實體資料都要改。
在一張大表上，這是 1.2.2 說的那種「唯讀 10 分鐘」的變更。

**陷阱四：Java 的 enum 與資料庫的 ENUM 是兩份，而且會不同步**

```java
public enum OrderStatus { PENDING, PAID, SHIPPED, CANCELLED }
```

```sql
st ENUM('PENDING','PAID','SHIPPED','CANCELLED')
```

⚠️ **這兩份要靠人維持一致。** 而真實世界的順序是：

```
① 開發者在 Java 加了 REFUNDED
② 部署上去
③ 第一筆退款訂單寫入 → ERROR 1265（如果嚴格）或變成空字串（如果不嚴格）
④ 才發現忘了改資料庫
```

📌 **這是 04 站 06 章「新增一個列舉值就讓 App 大量閃退」的資料庫版本。**

### 1.4.5 狀態欄位：三種存法的實測比較

```sql
CREATE TABLE s_enum    (id INT PRIMARY KEY, st ENUM('PENDING','PAID','SHIPPED','CANCELLED'));
CREATE TABLE s_varchar (id INT PRIMARY KEY, st VARCHAR(16));
CREATE TABLE s_tiny    (id INT PRIMARY KEY, st TINYINT UNSIGNED);
-- 各插入同樣的 10 萬列，然後各加一個索引 KEY (st)
```

```
TABLE_NAME   data_mb   idx_mb
s_enum       3.5156    1.5156
s_tiny       3.5156    1.5156
s_varchar    3.5156    2.5156      ← 🔴 索引大 67%
```

📌 **兩個要讀懂的地方**：

**① 資料大小三者相同（3.52 MB）。**
在 10 萬列這個規模，`VARCHAR(16)` 存 `'PENDING'`（7 bytes + 1 byte 前綴 = 8 bytes）
與 `TINYINT`（1 byte）的差異被**頁的粒度**吃掉了。

**② 索引大小差 67%。**
因為二級索引的每一項都是 `(欄位值, 主鍵值)`，而欄位值變大就是每一項都變大。
**這才是狀態欄位型別選擇的真正成本，而且它會隨著資料量線性放大。**

**三種存法的完整比較**：

| | `ENUM` | `VARCHAR` | `TINYINT` + 常數 |
|---|---|---|---|
| 空間（索引） | ✅ 小 | 🔴 大 67% | ✅ 小 |
| 加一個值 | 🟡 加在最後是 INSTANT，插中間要重建 | ✅ 免費 | ✅ 免費 |
| 直接查資料庫看得懂 | ✅ | ✅ | 🔴 `SELECT st` 看到 `2`，要去查程式碼 |
| 資料庫幫你擋錯值 | ✅ | 🔴 不擋（要加 `CHECK`） | 🔴 不擋（要加 `CHECK`） |
| 排序 | 🟡 按宣告順序（1.4.4 陷阱一） | 字母序 | 按數字 |
| 與 Java enum 同步 | 🔴 兩份要人工同步 | 🟡 一份（Java）+ 一個 `CHECK` | 🔴 兩份，而且對應關係是隱含的 |

> 📌 **本課採用 `VARCHAR(16)` + `CHECK` 約束**：
>
> ```sql
> status VARCHAR(16) NOT NULL
>        COMMENT '對應 com.example.shop.domain.OrderStatus',
> CONSTRAINT ck_order_status CHECK (status IN
>        ('PENDING','PAID','PACKED','SHIPPED','DELIVERED','CANCELLED','REFUNDED')),
> ```
>
> **理由**：
> ```
> ① 唯一的真相在 Java 的 enum（05 站 0.5：領域模型是唯一的真相）
> ② CHECK 約束擋掉錯值（1.10.2 會實測它真的有效），
>    而且加一個值只要改 CHECK（ALTER 很快，因為不改欄位型別）
> ③ 直接查資料庫看得懂 —— 這對「半夜排查」的價值大於省下的索引空間
> ④ 67% 的索引成本，在狀態欄位這種【低基數】欄位上通常不重要
>    （03 章會說明：低基數欄位的單欄索引本來就很少被用到）
> ```
>
> ⚠️ **如果那張表有十億列、而且 `status` 是複合索引的第一欄**，
> 那 67% 就重要了 —— **那時候再改成 `TINYINT`，並在 `COMMENT` 裡寫對應表。**
> 這是一個「等你真的需要時再付」的優化。

### 1.4.6 不要用字串存的六種東西

| 這種東西 | 常見的錯誤存法 | 應該用 | 為什麼 |
|---|---|---|---|
| 日期時間 | `VARCHAR(20)` `'2026-09-02 10:00:00'` | `DATETIME(3)` | 不能比較大小、不能用日期函式、佔 3～4 倍空間 |
| 金額 | `VARCHAR(20)` `'19.99'` | `DECIMAL(19,4)` | 不能 `SUM`、排序是字串序（`'9' > '10'`） |
| 布林 | `VARCHAR(5)` `'true'`/`'Y'`/`'1'`/`'是'` | `TINYINT(1)` | 一張表裡最後會同時出現四種寫法 |
| IP 位址 | `VARCHAR(45)` | `VARBINARY(16)` + `INET6_ATON` | 不能做範圍查詢（「這個網段的所有請求」） |
| UUID | `CHAR(36)` | `BINARY(16)` | 1.8.3 實測：`CHAR(36)` 比 `BINARY(16)` **合計空間多 40%**（119.4 vs 85.2 MB）、**寫入慢 15%**（65.3 vs 57.0 s）<br>⚠️ 那份表裡的 **2.25x／10.35x 是對 `BIGINT AUTO_INCREMENT`** 的倍數，不是對 `BINARY(16)` |
| 雜湊 / token | `CHAR(64)`（十六進位） | `BINARY(32)` | 一半的空間；而且十六進位字串在 `ai_ci` 定序下 `'ABC' = 'abc'` 🔴 |

⚠️ **最後一列要特別注意**：

```sql
-- 🔴 危險
api_token CHAR(64) NOT NULL,        -- 跟著表走 utf8mb4_0900_ai_ci
UNIQUE KEY uk_token (api_token)
```

在 `ai_ci` 定序下，token `'A3F5...'` 與 `'a3f5...'` 是**同一個 token**。
如果你的 token 產生器輸出小寫、驗證時有人傳大寫 —— **它會通過**。
這在安全上是一個真實的問題（雖然不是直接的漏洞，但它擴大了碰撞空間）。

```sql
-- ✅
api_token BINARY(32) NOT NULL,      -- 位元組比較，沒有定序的問題
-- 或者
api_token CHAR(64) COLLATE utf8mb4_bin NOT NULL,
```

---

## 1.5 時間型別 ★★

00 章 0.6.2 已經處理了 `DATETIME` vs `TIMESTAMP` 的時區語意。這一節處理其他的。

### 1.5.1 五種型別

| 型別 | 大小 | 範圍 | 有時區語意 | Java |
|---|---|---|---|---|
| `DATE` | 3 bytes | 1000-01-01 ～ 9999-12-31 | ❌ | `LocalDate` |
| `TIME` | 3 bytes（+小數） | −838:59:59 ～ 838:59:59 | ❌ | `LocalTime` / `Duration` |
| `DATETIME` | 5 bytes（+小數） | 1000-01-01 ～ 9999-12-31 | ❌ | `LocalDateTime` |
| `TIMESTAMP` | 4 bytes（+小數） | 1970-01-01 ～ **2038-01-19** | ✅ 存取時換算 | `Instant` |
| `YEAR` | 1 byte | 1901 ～ 2155 | ❌ | — |

**小數秒的額外成本**：

| 小數位 | 額外 bytes |
|---|---|
| (0) | 0 |
| (1) / (2) | 1 |
| (3) — 毫秒 | 2 |
| (4) / (5) | 3 |
| (6) — 微秒 | 3 |

📌 **`TIME` 的範圍是 ±838 小時，不是 0～24 小時** ——
它可以表示「一段時間長度」，不只是「一天中的時刻」。
但用它表示長度是個壞主意（上限只有 35 天），**用 `INT` 存秒數比較好**。

### 1.5.2 實測：`DATETIME` 的預設小數位是 0，而且是四捨五入 ★★

**這是本章最容易踩到、後果最詭異的一個坑。**

```sql
CREATE TABLE t_time (id INT AUTO_INCREMENT PRIMARY KEY,
                     d0 DATETIME, d3 DATETIME(3), d6 DATETIME(6));
INSERT INTO t_time (d0, d3, d6) VALUES
  ('2026-09-02 23:59:59.6', '2026-09-02 23:59:59.6789', '2026-09-02 23:59:59.678901');
SELECT id, d0, d3, d6 FROM t_time;
```

```
id   d0                      d3                          d6
1    2026-09-03 00:00:00     2026-09-02 23:59:59.679     2026-09-02 23:59:59.678901
     ^^^^^^^^^^^^^^^^^^^^
     🔴 日期跳到隔天了
```

⚠️ **`DATETIME` 不寫小數位時就是 `DATETIME(0)`，而多餘的小數是【四捨五入】不是截斷。**

```sql
SELECT CAST('2026-09-02 23:59:59.5' AS DATETIME) AS r1,      -- 2026-09-03 00:00:00
       CAST('2026-09-02 23:59:59.4' AS DATETIME) AS r2;      -- 2026-09-02 23:59:59
```

**這造成什麼**：

```
① Java 的 Instant.now() 有奈秒精度，寫進 DATETIME(0) 時
   → 有【一半的機率】被進位到下一秒
② 如果那一刻是 23:59:59.5 以後 → 日期跳到隔天
   → 「今天的訂單」報表少一筆、「明天的訂單」多一筆
③ 而且它【只在晚上最後半秒】發生 —— 一天 86400 秒裡的 0.5 秒
   → 約 0.0006% 的訂單。一天 10 萬筆訂單 = 平均每 1.7 天一筆
   → 🔴 頻率剛好低到「查不出規律」，又高到「財務每個月都會問」
```

📌 **另一個後果：排序不穩定。**
`DATETIME(0)` 只有秒的精度，同一秒內的 10 筆訂單**沒有順序** ——
`ORDER BY created_at` 的結果每次可能不同（03 章會說明為什麼跟執行計畫有關）。

> ✅ **本課的規則：所有時間欄位一律 `DATETIME(3)`。**
>
> ```
> ① (3) 是毫秒，對應 Java 的 Instant / System.currentTimeMillis() 的自然精度
> ② 額外成本只有 2 bytes
> ③ 排序穩定得多（同一毫秒內才會並列）
> ④ (6) 微秒通常沒必要，而且很多工具、很多序列化格式只到毫秒
> ```
>
> ⚠️ **而且要記得同步改 Java 這一側**：
> ```java
> // 🔴 Instant.now() 有奈秒精度，寫進 DATETIME(3) 時多的部分會被四捨五入
> //    → 存進去的值與記憶體裡的值不同 → 「存完再讀出來比對」的測試會紅
> Instant now = Instant.now();
>
> // ✅ 明確截到毫秒，讓 Java 與資料庫的精度一致
> Instant now = Instant.now().truncatedTo(ChronoUnit.MILLIS);
> ```
> 📌 **注意 Java 用 `truncatedTo`（截斷），MySQL 用四捨五入 —— 兩邊規則不同。**
> 所以要在 Java 這一側先截，而不是依賴資料庫。

### 1.5.3 `DEFAULT` 與 `ON UPDATE`

```sql
created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                ON UPDATE CURRENT_TIMESTAMP(3),
```

⚠️ **小數位要一致**：`DATETIME(3)` 配 `CURRENT_TIMESTAMP(3)`。
寫成 `DATETIME(3) DEFAULT CURRENT_TIMESTAMP` 會報錯
（`Invalid default value for 'created_at'`）。

**`ON UPDATE CURRENT_TIMESTAMP` 有三個要知道的行為**：

```
① 只有【值真的改變】時才更新。UPDATE t SET a = a 不會動 updated_at
② 應用明確寫 updated_at 時，以應用的值為準
③ 🔴 它是資料庫的時鐘（NOW()），不是應用的時鐘
   → 00 章 0.6.5 的實測：時區設錯的話，它跟 created_at 差 8 小時
```

📌 **`created_at` / `updated_at` 該由誰寫？**

| | 資料庫（`DEFAULT` / `ON UPDATE`） | 應用（Java 的 `Clock`） |
|---|---|---|
| 一致性 | ✅ 所有寫入路徑都有（含手動 SQL、資料修補） | 🔴 有人繞過應用就沒有 |
| 可測試 | 🔴 測試裡沒辦法固定時間 | ✅ 注入 `Clock.fixed()` |
| 時區風險 | 🔴 依賴資料庫的 `time_zone` | ✅ 由應用完全控制 |

> ✅ **本課的做法：兩個都做。**
> - 資料庫給 `DEFAULT` / `ON UPDATE` —— 當作**最後一道防線**，讓「有人手動下 SQL」也留下痕跡。
> - 應用（05 站 04 章的 `Clock` 注入）**明確寫入** —— 這是正常路徑，可測試、時區可控。
>
> **兩者一致的前提是 00 章 0.6.8 的守門測試**（app 寫的時間與 `NOW()` 落在同一個時間軸上）。

### 1.5.4 三種「不是時間點」的時間

**① 只有日期（生日、國定假日、合約起始日）**

```sql
birth_date DATE NOT NULL,
```

⚠️ **不要用 `DATETIME` 存生日。** 因為：

```
生日「1990-05-20」是一組日曆數字，不是一個時刻
用 DATETIME 存 → 變成 1990-05-20 00:00:00 → 「哪一個時區的午夜？」
                → 跨時區顯示時會變成 1990-05-19
```

**② 只有時間（營業時間、提醒時刻）**

```sql
open_time  TIME NOT NULL,      -- 09:00:00
close_time TIME NOT NULL,      -- 18:00:00
```

⚠️ 跨午夜的營業時間（22:00 ～ 02:00）用這兩欄表示不了 ——
要嘛加一個 `crosses_midnight BOOLEAN`，要嘛存「從午夜起算的分鐘數」（`INT`，可以 > 1440）。

**③ 一段長度（處理耗時、有效期間）**

```sql
-- 🔴 不要用 TIME（上限 838 小時 = 35 天）
duration TIME,

-- ✅ 存最小單位的整數，單位寫在欄位名裡
duration_ms   INT UNSIGNED NOT NULL,
valid_days    SMALLINT UNSIGNED NOT NULL,
```

📌 **單位寫在欄位名裡** —— `duration_ms` 而不是 `duration`。
這是 01 站教過的原則（讓型別系統與命名一起攜帶資訊），在 schema 上同樣適用。

### 1.5.5 Java ↔ MySQL 的時間型別對應

| MySQL | Java（JDBC） | Java（JPA / 08 章） |
|---|---|---|
| `DATE` | `java.time.LocalDate` | `LocalDate` |
| `TIME` | `java.time.LocalTime` | `LocalTime` |
| `DATETIME(3)`（本課當 UTC 用） | `java.time.Instant` ✅ | `Instant` |
| `DATETIME(3)`（當日曆數字用） | `java.time.LocalDateTime` | `LocalDateTime` |
| `TIMESTAMP(3)` | `java.time.Instant` | `Instant` |

⚠️ **不要用 `java.util.Date` / `java.sql.Timestamp` 當 domain 型別。**
它們是可變的、沒有時區語意、`Date` 的月份還是從 0 開始。
**只在 JDBC 邊界出現，進到 domain 之前就轉成 `java.time`。**

```java
// Repository 的邊界（06 站 0.6 判準 1：用領域的語言）
Instant createdAt = rs.getObject("created_at", java.time.LocalDateTime.class)
                      .toInstant(ZoneOffset.UTC);       // ★ 明確宣告「這一欄是 UTC」

// 或者，如果 JDBC 時區設定正確（00 章 0.6.8），可以直接：
Instant createdAt = rs.getTimestamp("created_at").toInstant();
```

📌 **第一種寫法更好**，因為它**把「這一欄是 UTC」這個約定寫在程式碼裡**，
而不是藏在 JDBC URL 的參數裡。00 章 0.6.2 說過：
`DATETIME` 不知道自己是 UTC，這是一個靠約定維持的不變量 —— 讓約定**出現在程式碼裡**。

---

## 1.6 布林、JSON 與二進位

### 1.6.1 實測：`BOOLEAN` 就是 `TINYINT(1)`，而且可以存 5

```sql
CREATE TABLE b1 (a BOOLEAN, b BOOL, c TINYINT(1));
SHOW CREATE TABLE b1\G
```

```sql
CREATE TABLE `b1` (
  `a` tinyint(1) DEFAULT NULL,       ← BOOLEAN
  `b` tinyint(1) DEFAULT NULL,       ← BOOL
  `c` tinyint(1) DEFAULT NULL        ← TINYINT(1)
)
```

**三個是同一個型別。MySQL 沒有真正的布林型別**，`BOOLEAN` 只是 `TINYINT(1)` 的別名。

⚠️ **而 `TINYINT(1)` 的 `(1)` 只是顯示寬度（1.3.3），不限制值**：

```sql
INSERT INTO b1 VALUES (TRUE, FALSE, 5);
SELECT a, b, c, c = TRUE AS c_is_true, c IS TRUE AS c_is_true2 FROM b1;
```

```
a   b   c   c_is_true   c_is_true2
1   0   5   0           1
                ^^^     ^^^
                🔴 同一欄，兩種「是不是 true」的答案
```

**`c = TRUE`** → `5 = 1` → **假**
**`c IS TRUE`** → 「5 是不是真值」（非 0 即真）→ **真**

```sql
SELECT TRUE + TRUE;    -- 2
```

📌 **三條規則**：

```
① 一律用 BOOLEAN 這個名字寫（可讀性），但知道它是 TINYINT(1)
② 加 CHECK (col IN (0,1)) 或 CHECK (col BETWEEN 0 AND 1)，讓資料庫真的擋住
③ 查詢一律寫 WHERE is_active = 1 或 WHERE is_active IS TRUE，二選一並全專案一致
   —— 不要混用，因為它們在有髒資料時給不同答案
```

⚠️ **JDBC 這一側**：驅動看到 `TINYINT(1)` 會回傳 `Boolean`（`tinyInt1isBit=true` 是預設）。
如果那一欄真的想當「−128～127 的小整數」用，
要嘛不要宣告成 `TINYINT(1)`，要嘛在 URL 加 `tinyInt1isBit=false`。
**這是「顯示寬度沒有意義」的唯一例外。**

### 1.6.2 `JSON`：三個判準

MySQL 5.7+ 有原生 `JSON` 型別（二進位格式，解析過一次，支援路徑查詢與索引）。

```sql
CREATE TABLE t_json (
  id INT AUTO_INCREMENT PRIMARY KEY,
  attrs JSON
);
INSERT INTO t_json (attrs) VALUES
  ('{"color":"red","size":"M","tags":["new","hot"]}'),
  ('{"color":"blue","size":"L"}');

SELECT id, attrs->>'$.color' c, attrs->'$.tags[0]' t0, JSON_LENGTH(attrs) len FROM t_json;
```

```
id   c      t0       len
1    red    "new"    3
2    blue   NULL     2
```

📌 **`->` 與 `->>` 的差別**：`->` 回傳 JSON（字串會帶引號），`->>` 回傳文字（不帶引號）。
**九成的時候你要的是 `->>`。**

⚠️ **什麼時候可以用 JSON —— 三個判準，要三個都成立**：

```
① 這些欄位【不會被 WHERE / JOIN / ORDER BY 用到】
   （或者只有極少數幾個會，而那幾個可以拉出來做生成欄位）
② 它們的結構【真的是不固定的】
   —— 不同商品類別有不同屬性、第三方回傳的原始 payload、審計快照
③ 你【不需要】資料庫幫你驗證它們
```

🔴 **三個常見的誤用**：

```
🔴 「反正欄位可能會增加，先用 JSON 比較有彈性」
    → 半年後所有查詢都是 attrs->>'$.xxx'，沒有一個走得到索引
🔴 用 JSON 存一對多關係（訂單明細塞在訂單的 JSON 裡）
    → 沒辦法 JOIN、沒辦法用外鍵、沒辦法對單一明細做原子更新
🔴 用 JSON 存需要 SUM 的數字
    → attrs->>'$.amount' 出來是字串，SUM 會做隱式轉型（03 章：索引失效 + 精度問題）
```

### 1.6.3 實測：生成欄位 + 索引（JSON 的正確用法）

如果 JSON 裡有**一兩個**欄位真的需要查詢，把它拉出來：

```sql
CREATE TABLE t_json (
  id    INT AUTO_INCREMENT PRIMARY KEY,
  attrs JSON,
  -- ★ 生成欄位：值由 attrs 算出來，不能自己寫
  color VARCHAR(20) GENERATED ALWAYS AS (attrs->>'$.color') STORED,
  KEY idx_color (color)
);
INSERT INTO t_json (attrs) VALUES ('{"color":"red","size":"M","tags":["new","hot"]}'),
                                  ('{"color":"blue","size":"L"}');
SELECT id, attrs->>'$.color' c, color FROM t_json;
```

```
id   c      color
1    red    red         ← 自動同步
2    blue   blue
```

**`STORED` vs `VIRTUAL`**：

| | `VIRTUAL`（預設） | `STORED` |
|---|---|---|
| 佔空間 | ❌ 不存，讀取時算 | ✅ 存下來 |
| 可以建索引 | ✅ 可以（索引裡存算好的值） | ✅ 可以 |
| `ALTER` 加欄位 | ✅ **INSTANT** | 🔴 要重建表 |
| 讀取成本 | 每次算一次 | 直接讀 |

📌 **預設用 `VIRTUAL`** —— 它可以建索引（索引本身就是「存下來的值」），
而且加欄位是 INSTANT。只有在「算的成本很高、而且沒建索引」時才用 `STORED`。

### 1.6.4 IP、UUID 與二進位

**IP 位址**：

```sql
SELECT INET6_ATON('192.168.1.1')                     AS v4_bin,      -- 4 bytes
       HEX(INET6_ATON('192.168.1.1'))                AS v4_hex,      -- C0A80101
       LENGTH(INET6_ATON('2001:db8::1'))             AS v6_len,      -- 16
       INET6_NTOA(INET6_ATON('2001:db8::1'))         AS back;        -- 2001:db8::1
```

```sql
client_ip VARBINARY(16) NULL COMMENT 'INET6_ATON()；IPv4 是 4 bytes、IPv6 是 16',
```

📌 **為什麼要這樣存**：因為 `VARBINARY` 是按位元組排序的，
所以 **「這個網段的所有請求」可以用範圍查詢**：

```sql
WHERE client_ip BETWEEN INET6_ATON('10.0.0.0') AND INET6_ATON('10.0.255.255')
```

用 `VARCHAR(45)` 存的話，`'10.0.9.1' > '10.0.10.1'`（字串序），範圍查詢完全不能用。

**UUID**：

```sql
SET @u := '018f5c2a-1234-7abc-8def-0123456789ab';
SELECT LENGTH(@u)                    AS char36,      -- 36
       LENGTH(UUID_TO_BIN(@u))       AS bin16,       -- 16
       HEX(UUID_TO_BIN(@u))          AS 直接轉,       -- 018F5C2A12347ABC8DEF0123456789AB
       HEX(UUID_TO_BIN(@u, 1))       AS 交換前綴,     -- 7ABC1234018F5C2A8DEF0123456789AB
       BIN_TO_UUID(UUID_TO_BIN(@u,1), 1) AS 轉回來;
```

⚠️ **第二個參數 `swap_flag` 要看你用的是哪一版 UUID**：

```
UUIDv1（MySQL 的 UUID() 函式產生的）
    時間戳是【低位在前】的 → swap_flag=1 把它換到前面，變成時間有序   ✅ 要用 1

UUIDv7（本課採用，1.8.4）
    時間戳本來就在【最前面】48 bit → 已經是有序的                     ✅ 要用 0（或省略）
    🔴 用 1 反而會把有序性打亂
```

**其他二進位欄位**：

```sql
password_hash  VARBINARY(60)  NOT NULL COMMENT 'bcrypt，60 bytes；用 VARBINARY 避開定序',
api_token      BINARY(32)     NOT NULL COMMENT 'SHA-256 原始位元組，不是十六進位字串',
idempotency_key BINARY(16)    NOT NULL COMMENT 'UUIDv7 的位元組',
```

📌 **`BINARY(n)` 與 `VARBINARY(n)` 的差別跟 `CHAR`/`VARCHAR` 一樣**，
但 `BINARY` 補的是 **`0x00`** 而不是空白，而且**讀出來時不會去掉**。
所以只有在長度**真的固定**時才用 `BINARY`。

---

## 1.7 `NULL` ★

06 站 02 章 2.5.5 講過「報表上『沒有折扣』與『折扣 0 元』分不出來」。
這一節處理資料庫這一側。

### 1.7.1 實測：三值邏輯的六個結果

```sql
SELECT NULL = NULL AS eq, NULL <> NULL AS ne, NULL <=> NULL AS spaceship, ISNULL(NULL) AS isnull_;
```

```
eq      ne      spaceship   isnull_
NULL    NULL    1           1
^^^^    ^^^^
🔴 不是 false，是 NULL
```

**這是關鍵**：`NULL = NULL` 的結果**不是假，是 `NULL`**。
而 `WHERE` 只保留結果為**真**的列 —— `NULL` 與假一樣被過濾掉。

```sql
SELECT 1 IN (1, NULL) AS in1, 2 IN (1, NULL) AS in2, 2 NOT IN (1, NULL) AS notin2;
```

```
in1   in2    notin2
1     NULL   NULL       ← 🔴 2 NOT IN (1, NULL) 不是 true
```

⚠️ **`NOT IN` 配上含 `NULL` 的子查詢，永遠回傳空結果集**：

```sql
-- 🔴 如果 orders.customer_id 有任何一個 NULL，這一句永遠是空的
SELECT * FROM customers WHERE id NOT IN (SELECT customer_id FROM orders);

-- ✅ 用 NOT EXISTS
SELECT * FROM customers c WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id);
```

📌 **這是實務上最常見、也最難察覺的 `NULL` 陷阱** ——
查詢不會報錯，它只是**回傳零列**，而「零列」在很多情境下看起來是一個合理的答案。

```sql
CREATE TABLE t_null (id INT PRIMARY KEY, disc DECIMAL(10,2) NULL, tag VARCHAR(10) NULL);
INSERT INTO t_null VALUES (1, 0.00, 'a'), (2, NULL, NULL), (3, 5.00, 'b');

SELECT COUNT(*) c_star, COUNT(disc) c_col, SUM(disc) s, AVG(disc) a, MAX(disc) m FROM t_null;
```

```
c_star   c_col   s      a          m
3        2       5.00   2.500000   5.00
^^^      ^^^            ^^^^^^^^
3 列     只有 2 個非 NULL   ← AVG 是 5.00/2，不是 5.00/3
```

⚠️ **`AVG()` 的分母是「非 NULL 的個數」。**
「平均折扣」如果沒有折扣的訂單存 `NULL`，算出來的是「**有折扣的訂單的平均折扣**」，
而不是「所有訂單的平均折扣」—— 兩個是完全不同的商業指標。

```sql
SELECT id FROM t_null WHERE disc <> 5.00;
```

```
id
1        ← 🔴 只有 1。id=2（disc IS NULL）沒有被選中
```

```sql
SELECT CONCAT('tag=', tag) c, CONCAT_WS('-', 'tag', tag) cw FROM t_null WHERE id = 2;
```

```
c       cw
NULL    tag        ← CONCAT 遇到 NULL 整個變 NULL；CONCAT_WS 會跳過 NULL
```

```sql
SELECT id, disc FROM t_null ORDER BY disc ASC;
```

```
id   disc
2    NULL      ← MySQL 把 NULL 排在最前面（ASC 時）
1    0.00
3    5.00
```

📌 **`NULL` 的排序位置是方言差異**：MySQL 的 `ASC` 把 `NULL` 排前面、`DESC` 排後面；
PostgreSQL 預設相反（且支援 `NULLS FIRST/LAST`，MySQL 不支援）。
**要明確控制就用 `ORDER BY (disc IS NULL), disc`。**

### 1.7.2 實測：唯一索引允許多個 `NULL`

```sql
CREATE TABLE t_unull (email VARCHAR(50) UNIQUE);
INSERT INTO t_unull VALUES (NULL), (NULL), (NULL);
SELECT COUNT(*) FROM t_unull;
```

```
3        ← 🔴 三個 NULL 都進去了
```

**因為 `NULL <> NULL`，所以唯一索引認為它們「不重複」。**

⚠️ **這是 1.10.4 那個「軟刪除 + 唯一索引」陷阱的根源**，而且它有一個好用的一面：

```sql
-- ✅ 「一個使用者最多一個【預設】地址，但可以有很多非預設地址」
CREATE TABLE address (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT NOT NULL,
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  -- ★ 只在 is_default 為真時才有值，否則 NULL
  default_marker BIGINT GENERATED ALWAYS AS (IF(is_default, user_id, NULL)) VIRTUAL,
  UNIQUE KEY uk_one_default (default_marker)
);
```

**這是「部分唯一索引」在 MySQL 上的做法**（PostgreSQL 有 `CREATE UNIQUE INDEX ... WHERE`，MySQL 沒有）。

### 1.7.3 `NOT NULL` 的三個理由，與一個反對意見

**贊成 `NOT NULL`**：

```
① 查詢語意變簡單 —— 不用每次都想「這一欄可能是 NULL 嗎」
② 索引更有效率 —— InnoDB 的 NULL 值在索引裡仍佔位置，而且改變統計
③ 它是一條【資料庫幫你守】的不變量（06 站 0.8 的第四個位置）
```

**反對「一律 `NOT NULL` + 預設值」**：

⚠️ **用 `''` 或 `0` 或 `'1970-01-01'` 當「沒有值」，等於發明一個假的 `NULL`** ——
而且是一個**資料庫不知道是假的** `NULL`：

```sql
-- 🔴 用 0 表示「沒有折扣」
discount DECIMAL(10,2) NOT NULL DEFAULT 0.00
    → AVG(discount) 把「沒有折扣」也算進分母 → 平均值被稀釋
    → 「有折扣的訂單有幾筆」寫成 WHERE discount > 0 —— 那折扣 0 元的促銷券呢？

-- 🔴 用 '' 表示「沒有填手機」
phone VARCHAR(20) NOT NULL DEFAULT ''
    → UNIQUE KEY (phone) 會擋掉第二個「沒填手機」的人
    → 而 NULL 版本不會（1.7.2）
```

> 📌 **判準：`NULL` 表示「不知道 / 不適用」，不表示「零 / 空 / 預設」。**
>
> | 欄位 | 該不該 NULL | 理由 |
> |---|---|---|
> | `order.customer_id` | 🔴 `NOT NULL` | 每一張訂單一定有客戶 |
> | `order.paid_at` | ✅ 可 `NULL` | 「還沒付款」是一個真實的狀態，不是「1970 年付的」 |
> | `order.discount_amount` | 🟡 看業務 | 若「沒套用優惠」與「優惠 0 元」要分開 → `NULL`；否則 `NOT NULL DEFAULT 0` |
> | `user.deleted_at` | ✅ 可 `NULL` | 但這會製造 1.10.4 的陷阱 |
> | `user.email` | 🔴 `NOT NULL` | 註冊時就必填 |
> | `user.phone` | ✅ 可 `NULL` | 選填，而且要唯一 → 必須是 `NULL` 不能是 `''` |
>
> ⚠️ **本課的預設立場：先寫 `NOT NULL`，要放寬時必須說得出「不知道」與「零」的差別。**
> 這與 05 站 0.5 的「不變量優先」是同一個原則。

---

## 1.8 主鍵策略 ★★

### 1.8.1 聚簇索引：主鍵不只是主鍵

**InnoDB 的表本身就是一棵以主鍵排序的 B+Tree**（03 章會畫圖）。這帶來三個後果：

```
① 資料是【按主鍵順序】實體存放的
   → 主鍵遞增 = 一直往最後一頁塞（順序寫）
   → 主鍵隨機 = 每次插入都要找到中間某一頁（隨機寫 + 頁分裂）

② 每一個【二級索引】的葉節點都存著【主鍵的值】
   → 主鍵大 8 bytes，每個二級索引的每一項都大 8 bytes
   → 三個二級索引 × 一億列 × 8 bytes = 2.4 GB

③ 沒有宣告主鍵時，InnoDB 會偷偷造一個
   → 先找第一個「NOT NULL 的唯一索引」當主鍵
   → 都沒有的話，造一個 6 bytes 的隱藏 row_id（而且是【全域】計數器，會成為競爭點）
   → 🔴 所以「不建主鍵」不是「省下主鍵」，是「拿到一個你看不到也用不到的主鍵」
```

📌 **② 是 1.2.3 第 ⑤ 個問題的來源，也是下面實測的主軸。**

### 1.8.2 實測：四種主鍵的空間與時間（資料放得進 buffer pool）

**環境**：MySQL 8.0，預設 buffer pool（128 MB），插入 300,000 列，
每 1000 列一個 batch + commit，`rewriteBatchedStatements=true`。

```
主鍵策略                       插入(ms)    資料(MB)   索引(MB)   合計(MB)
① AUTO_INCREMENT BIGINT         3585       17.5       9.5       27.1    1.00x 時間  1.00x 空間
② UUIDv4 CHAR(36)               4482       42.6      17.6       60.2    1.25x 時間  2.22x 空間
③ UUIDv4 BINARY(16)             3797       33.6      11.6       45.1    1.06x 時間  1.67x 空間
④ UUIDv7 BINARY(16)（時間有序）   3385       24.6      11.6       36.1    0.94x 時間  1.33x 空間
```

⚠️ **看「時間」那一欄：差異很小（1.25 倍以內），④ 甚至比 ① 快一點。**

如果你只做到這裡，會得到一個結論：「UUID 主鍵只是多花點空間，效能沒差」。
**這個結論是錯的。**

### 1.8.3 實測：同樣的實驗，把 buffer pool 縮到 16 MB ★★

```bash
docker run ... mysql:8.0 --innodb-buffer-pool-size=16M
```

插入 **600,000** 列（讓索引明顯放不進 16 MB）：

```
主鍵策略                       插入(ms)    資料(MB)   索引(MB)   合計(MB)
① AUTO_INCREMENT BIGINT         6317       34.6      18.6       53.1    1.00x 時間  1.00x 空間
② UUIDv4 CHAR(36)              65351       84.8      34.7      119.4   🔴 10.35x    2.25x
③ UUIDv4 BINARY(16)            56993       62.6      22.6       85.2   🔴  9.02x    1.60x
④ UUIDv7 BINARY(16)（時間有序）   7083       47.6      22.6       70.2       1.12x    1.32x
```

**同樣的四種策略，同樣的程式碼，只是 buffer pool 從 128 MB 變成 16 MB：**

```
UUIDv4 從 1.25 倍慢  →  10.35 倍慢
UUIDv7 從 0.94 倍     →   1.12 倍（幾乎沒變）
```

📌 **為什麼**：

```
主鍵遞增（① ④）
    新的一列永遠插在 B+Tree 的【最右邊那一頁】
    → 那一頁一直在 buffer pool 裡（剛用過）
    → 每次插入 0 次磁碟讀取

主鍵隨機（② ③）
    新的一列要插在 B+Tree 的【任意一頁】
    → 資料量小時：整棵樹都在 buffer pool，還是 0 次磁碟讀取  ← 這就是 1.8.2 看不出差異的原因
    → 資料量大時：那一頁很可能不在記憶體 → 【先讀進來】才能插
    → 而且插入後那一頁變髒，要寫回去
    → 還可能造成【頁分裂】（一頁滿了，要拆成兩頁，搬一半的資料）
```

> ⚠️ **這個實測的教訓，比「UUID 主鍵不好」更重要**：
>
> **「在我的機器上測起來沒差」這句話，在資料庫的世界裡幾乎沒有意義。**
>
> 因為你的測試資料量通常小於 buffer pool，
> 而正式環境的資料量通常大於 buffer pool ——
> **這兩個環境的效能特性是質的不同，不是量的不同。**
>
> 📌 **05 章 5.2 會把這件事變成一個可以事先判斷的規則**：
> 「這張表的熱資料集有多大？它放得進 buffer pool 嗎？」

### 1.8.4 UUIDv7：拿到 UUID 的好處而不付代價

**四種 id 的比較**：

| | `AUTO_INCREMENT` | UUIDv4 | **UUIDv7** | 雪花 / Snowflake |
|---|---|---|---|---|
| 時間有序 | ✅ | 🔴 | ✅ | ✅ |
| 可在應用端產生（不用先問資料庫） | 🔴 | ✅ | ✅ | ✅ |
| 洩漏業務量 | 🔴 **會**（訂單 #10234 → 你有一萬單） | ✅ 不會 | 🟡 洩漏時間 | 🟡 洩漏時間 |
| 分散式唯一 | 🔴 要靠資料庫協調 | ✅ | ✅ | ✅ 要分配 worker id |
| 大小 | 8 bytes | 16 bytes | 16 bytes | 8 bytes |
| 需要額外基礎設施 | ❌ | ❌ | ❌ | ✅ worker id 的分配與回收 |

**UUIDv7 的結構**（RFC 9562）：

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
┌───────────────────────────────────────────────────────────────┐
│                    unix_ts_ms（48 bit）                        │  ← 前 6 個 byte 是毫秒時間戳
├───────────────┬───────────────────────────────────────────────┤
│  ver（4 bit）  │              rand_a（12 bit）                  │
├──┬────────────┴───────────────────────────────────────────────┤
│var│                    rand_b（62 bit）                        │
└──┴────────────────────────────────────────────────────────────┘
```

**因為時間戳在最前面，UUIDv7 的位元組序 = 時間序** —— 這就是 1.8.3 裡它表現得像自增主鍵的原因。

**Java 這一側**（本課的實作，實測用的就是這一份）：

```java
package com.example.shop.domain.support;

import java.security.SecureRandom;
import java.time.Clock;
import java.util.UUID;

/**
 * UUIDv7 產生器（RFC 9562）。
 *
 * ★ 為什麼要自己寫：Java 21 的 UUID.randomUUID() 只產生 v4（純隨機）。
 *   JDK 目前沒有內建 v7；社群套件（uuid-creator、java-uuid-generator）有，
 *   但這個實作只有 30 行，而且可以注入 Clock（05 站 04 章：時間要可測試）。
 */
public final class UuidV7 {

    private static final SecureRandom RANDOM = new SecureRandom();

    private final Clock clock;

    public UuidV7(Clock clock) {
        this.clock = clock;
    }

    /** 產生一個 UUIDv7 的 16 個位元組 —— 直接餵給 PreparedStatement.setBytes() */
    public byte[] nextBytes() {
        long millis = clock.millis();
        byte[] b = new byte[16];

        // ① 前 48 bit：毫秒時間戳（大端序）—— 這是「時間有序」的來源
        for (int i = 0; i < 6; i++) {
            b[i] = (byte) (millis >>> (8 * (5 - i)));
        }

        // ② 後面 10 個 byte 填隨機
        byte[] rest = new byte[10];
        RANDOM.nextBytes(rest);
        System.arraycopy(rest, 0, b, 6, 10);

        // ③ 蓋上版本號（第 6 個 byte 的高 4 bit = 0111 = 7）
        b[6] = (byte) ((b[6] & 0x0F) | 0x70);
        // ④ 蓋上 variant（第 8 個 byte 的高 2 bit = 10）
        b[8] = (byte) ((b[8] & 0x3F) | 0x80);

        return b;
    }

    /** 給需要字串形式的地方用（API 回應、日誌） */
    public UUID next() {
        byte[] b = nextBytes();
        long hi = 0, lo = 0;
        for (int i = 0; i < 8; i++) hi = (hi << 8) | (b[i] & 0xFFL);
        for (int i = 8; i < 16; i++) lo = (lo << 8) | (b[i] & 0xFFL);
        return new UUID(hi, lo);
    }

    /** 把 java.util.UUID 轉成資料庫用的 16 bytes */
    public static byte[] toBytes(UUID u) {
        byte[] b = new byte[16];
        long hi = u.getMostSignificantBits(), lo = u.getLeastSignificantBits();
        for (int i = 0; i < 8; i++) {
            b[i]     = (byte) (hi >>> (8 * (7 - i)));
            b[8 + i] = (byte) (lo >>> (8 * (7 - i)));
        }
        return b;
    }

    /** 從資料庫的 16 bytes 轉回 UUID */
    public static UUID fromBytes(byte[] b) {
        if (b == null || b.length != 16) {
            throw new IllegalArgumentException("UUID 必須是 16 個位元組，實際是 "
                    + (b == null ? "null" : b.length));
        }
        long hi = 0, lo = 0;
        for (int i = 0; i < 8; i++) hi = (hi << 8) | (b[i] & 0xFFL);
        for (int i = 8; i < 16; i++) lo = (lo << 8) | (b[i] & 0xFFL);
        return new UUID(hi, lo);
    }
}
```

⚠️ **在 SQL 裡不要用 `UUID_TO_BIN(uuid, 1)` 轉 UUIDv7**：

```sql
SET @u := '018f5c2a-1234-7abc-8def-0123456789ab';
SELECT HEX(UUID_TO_BIN(@u))    AS 直接轉;      -- 018F5C2A12347ABC8DEF0123456789AB  ✅ 保持有序
SELECT HEX(UUID_TO_BIN(@u, 1)) AS 交換前綴;    -- 7ABC1234018F5C2A8DEF0123456789AB  🔴 有序性被打亂
```

`swap_flag=1` 是為 **UUIDv1** 設計的（v1 的時間戳低位在前）。
**對 v7 用它，會把「時間有序」這個唯一的好處毀掉** —— 而且不會有任何錯誤訊息。

### 1.8.5 實測：`AUTO_INCREMENT` 的洞

```sql
CREATE TABLE ai_gap (id BIGINT AUTO_INCREMENT PRIMARY KEY, v VARCHAR(10) UNIQUE);
INSERT INTO ai_gap (v) VALUES ('a'),('b'),('c');          -- id 1,2,3

START TRANSACTION; INSERT INTO ai_gap (v) VALUES ('d'); ROLLBACK;   -- 消耗 4
INSERT INTO ai_gap (v) VALUES ('e');                                -- id 5

INSERT IGNORE INTO ai_gap (v) VALUES ('a');                         -- 唯一鍵衝突，消耗 6
INSERT INTO ai_gap (v) VALUES ('f');                                -- id 7

INSERT IGNORE INTO ai_gap (v) VALUES ('g'),('a'),('h');             -- 一次三列，中間那列衝突
SELECT * FROM ai_gap ORDER BY id;
```

```
id   v
1    a
2    b
3    c
5    e      ← 4 被 ROLLBACK 吃掉了
7    f      ← 6 被 INSERT IGNORE 吃掉了
8    g
9    h      ← 10 被中間那個衝突吃掉了
```

⚠️ **`AUTO_INCREMENT` 保證「遞增且唯一」，不保證「連續」。**

**四個會製造洞的地方**：

```
① 交易 ROLLBACK        —— 計數器不會退回（因為它在交易之外）
② 唯一鍵 / 約束衝突      —— 值已經取出來了
③ INSERT ... ON DUPLICATE KEY UPDATE  —— 走到 UPDATE 分支時仍然消耗了一個值
④ 批次插入的預先配置     —— innodb_autoinc_lock_mode=2 時會一次配一批，用不完就丟掉
```

📌 **所以這幾件事是錯的**：

```
🔴 用 MAX(id) 當「總筆數」
🔴 用 id 的差值算「這段期間有幾筆」
🔴 對外暴露 id，然後假設它是連續的
🔴 用 id 做分頁的「總頁數」估算
```

### 1.8.6 實測：重啟之後計數器會不會退回（8.0 vs 5.7）

```sql
-- 目前 id 最大是 9，計數器指向 10
DELETE FROM ai_gap WHERE id >= 5;
SELECT MAX(id) FROM ai_gap;                         -- 3
```

```bash
docker restart mysql-learn
```

```sql
INSERT INTO ai_gap (v) VALUES ('z');
SELECT id, v FROM ai_gap ORDER BY id;
```

```
id   v
1    a
2    b
3    c
10   z        ← ✅ 重啟後【沒有】退回到 4
```

📌 **這是 MySQL 8.0 的改進**（計數器持久化到 redo log）。
**在 MySQL 5.7 上，重啟後計數器會被重設成 `MAX(id) + 1 = 4`**，
於是接下來會產生 id 4、5、6…… —— **與剛剛被刪掉的那些 id 重複**。

⚠️ **這在 5.7 上造成過真實事故**：

```
① 訂單 id 5～9 被軟刪除（或被歸檔到另一張表）
② MySQL 重啟
③ 新訂單拿到 id 5
④ 而某個外部系統（金流、物流、報表）還記著「訂單 5」是舊的那一筆
    🔴 兩筆完全不同的訂單，共用同一個 id
```

> 📌 **這是「不要對外暴露自增 id」的另一個理由** ——
> 而 UUIDv7（1.8.4）從結構上就不可能有這個問題。

### 1.8.7 業務主鍵 vs 代理鍵

**問題**：訂單編號 `SO-2026-00001234` 已經是唯一的，可以直接當主鍵嗎？

```sql
-- 方案 A：業務主鍵
CREATE TABLE orders (order_no VARCHAR(32) PRIMARY KEY, ...);

-- 方案 B：代理鍵 + 業務唯一索引（本課採用）
CREATE TABLE orders (
  id       BINARY(16)  NOT NULL PRIMARY KEY COMMENT 'UUIDv7',
  order_no VARCHAR(32) NOT NULL,
  ...
  UNIQUE KEY uk_order_no (order_no)
);
```

| | 業務主鍵 | 代理鍵 + 唯一索引 |
|---|---|---|
| 少一個欄位 / 少一個索引 | ✅ | 🔴 |
| 少一次 JOIN 的查找 | ✅ | 🔴 |
| **業務規則改變時** | 🔴 **改主鍵 = 改所有二級索引 + 所有外鍵 + 所有快取 key** | ✅ 改一個唯一索引 |
| 主鍵大小 | 🔴 32 bytes（每個二級索引都要存一份） | ✅ 16 bytes |
| 主鍵有序 | 🟡 `SO-2026-…` 是有序的（1.8.1） | ✅ UUIDv7 有序 |

⚠️ **決定性的是第三列。** 而「業務規則會不會改」的答案，實務上是：

```
「訂單編號永遠不會重複」            → 直到有人做了「訂單複製」功能
「統一編號可以識別一家公司」          → 直到公司合併、統編變更
「Email 可以識別一個使用者」         → 直到有人要換 email
「身分證字號是唯一的」               → 直到出現外籍居留證、直到有人補發
```

> 📌 **本課的規則：一律用代理鍵。**
> **例外**：純粹的關聯表（多對多的中間表）可以用複合主鍵 `(a_id, b_id)` ——
> 因為它沒有自己的業務身分。

### 1.8.8 主鍵決策表

| 情境 | 選 | 為什麼 |
|---|---|---|
| **單體服務、id 不對外暴露** | `BIGINT AUTO_INCREMENT` | 最小、最快、最簡單 |
| **id 會出現在 URL / API** | `BINARY(16)` + UUIDv7 | 不洩漏業務量，1.8.3 的效能代價只有 1.12 倍 |
| **要在應用端先產生 id（Outbox、事件溯源）** | UUIDv7 | 不用先問資料庫（05 站 07 章的 outbox） |
| **多資料中心 / 多主寫入** | UUIDv7 或雪花 | 自增會衝突 |
| **關聯表（多對多）** | 複合主鍵 `(a_id, b_id)` | 沒有自己的身分；順序要配合查詢方向（03 章最左前綴） |
| **超大量寫入的日誌表** | `BIGINT AUTO_INCREMENT` | 順序寫最快；而且日誌 id 不對外 |

⚠️ **本課的 shop-service 採用 UUIDv7 `BINARY(16)`**，理由是：

```
① 訂單 id 會出現在 API 與前端 URL（03 站 orders-api.yaml）
② 05 站的 outbox 需要在寫資料庫【之前】就有 id
③ 1.8.3 實測：時間有序的 UUIDv7 只比自增慢 1.12 倍、空間多 32%
   —— 這個代價換得「id 可以在應用端產生」與「不洩漏業務量」，是划算的
```

📌 **但要記得 06 站 0.14.2 的 `OrderRepository.nextId()`** ——
它就是為了這件事存在的：**id 由資料層決定怎麼產生，但在資料寫入之前就交給領域層。**

---

## 1.9 索引的代價（結論先給，03 章展開）

03 章會完整處理索引。但**建表的時候就要決定建哪些索引**，所以這裡先給兩個實測數字。

### 1.9.1 實測：空間

```sql
-- 同一張表（6 欄、10 萬列），只差在索引數量
CREATE TABLE ix0 (...);                                   -- 只有主鍵
CREATE TABLE ix1 (...) ; ALTER TABLE ix1 ADD KEY k1 (order_no);
CREATE TABLE ix3 (...) ; ALTER TABLE ix3 ADD KEY k1 (order_no),
                                        ADD KEY k2 (cust_id, created_at),
                                        ADD KEY k3 (status, created_at);
```

```
TABLE_NAME   data_mb   index_mb   total_mb
ix0          7.5156     0.0000     7.5156      1.00x
ix1          7.5156     3.5156    11.0313      1.47x
ix3          7.5156    12.5469    20.0625      2.67x       ← 🔴 三個索引 = 表大 167%
```

### 1.9.2 實測：寫入

插入 300,000 列（大 buffer pool，所以這是**最樂觀**的數字）：

```
0 個二級索引    3043 ms   1.00x
1 個二級索引    3362 ms   1.10x
3 個二級索引    3921 ms   1.29x
6 個二級索引    4880 ms   1.60x
```

📌 **兩個結論**：

```
① 空間的代價比時間的代價大很多（2.67x vs 1.29x）
② 而且 1.8.3 已經示範過：時間的代價會在【資料超過 buffer pool】時放大
   —— 因為索引也要進 buffer pool，索引越多，能放的資料越少
```

⚠️ **所以「每個欄位都建索引」不只是浪費空間，它會讓所有查詢一起變慢**
（因為 buffer pool 被索引佔滿了）。

> 📌 **建表時的規則**：
> ```
> ① 主鍵（一定有）
> ② 唯一約束需要的唯一索引（一定有，1.10）
> ③ 外鍵欄位（InnoDB 會自動建，1.10.3）
> ④ 【已知的】查詢路徑 —— 03 章 3.8 會給複合索引的設計方法
> ⑤ 其他的：等 05 章的慢查詢日誌告訴你
> ```
> **④ 與 ⑤ 的分界很重要**：不要憑想像建索引，也不要一個都不建。

---

## 1.10 約束：不變量的第四道防線 ★

06 站 00 章 0.8 講過「不變量的四個位置」，並且用實測證明了：
**應用層的 `if` 在併發下守不住，`CHECK (qty >= 0)` 也守不住，
原子 `UPDATE` 與唯一索引才守得住。**

這一節處理資料庫這一側的細節。

### 1.10.1 四種約束的能力邊界

| 約束 | 守得住什麼 | 守不住什麼 |
|---|---|---|
| `NOT NULL` | 這一欄一定有值 | 值有沒有意義 |
| `UNIQUE` | **跨列**：這個值只能出現一次 | `NULL` 不算（1.7.2） |
| `CHECK` | **單列內**：這一列自己的欄位之間的關係 | 🔴 跨列、跨表；🔴 **併發下的「先讀再寫」** |
| `FOREIGN KEY` | **跨表**：指到的東西一定存在 | 業務規則（例如「已出貨的訂單不能刪」） |

⚠️ **`CHECK` 的邊界最常被誤解。** 它是**單列的**：

```sql
-- ✅ CHECK 做得到：同一列的兩個欄位之間的關係
CHECK (discount_amount <= total_amount)
CHECK (end_date >= start_date)
CHECK (status IN ('PENDING','PAID','SHIPPED'))
CHECK (qty >= 0)

-- 🔴 CHECK 做不到：
CHECK ((SELECT SUM(qty) FROM order_item WHERE order_id = id) = total_qty)   -- 不能有子查詢
CHECK (created_at <= NOW())                                                -- 不能有非確定性函式
```

```sql
CREATE TABLE t (created_at DATETIME(3), CHECK (created_at <= NOW()));
```

```
ERROR 3814 (HY000): An expression of a check constraint 'xxx' contains
                    disallowed function: now.
```

### 1.10.2 實測：`CHECK` 在 MySQL 8.0.16+ 真的生效

```sql
CREATE TABLE t_chk (id INT PRIMARY KEY, qty INT NOT NULL,
                    CONSTRAINT ck_qty CHECK (qty >= 0));
INSERT INTO t_chk VALUES (1, 5);       -- ✅
INSERT INTO t_chk VALUES (2, -1);      -- ?
```

```
ERROR 3819 (HY000): Check constraint 'ck_qty' is violated.
```

```sql
UPDATE t_chk SET qty = qty - 10 WHERE id = 1;    -- 5 - 10 = -5
```

```
ERROR 3819 (HY000): Check constraint 'ck_qty' is violated.
```

⚠️ **這在 MySQL 8.0.16 之前是【完全被忽略】的** ——
5.7 會接受 `CHECK` 語法、寫進 `SHOW CREATE TABLE`、**然後什麼都不做**。

📌 **這是 06 站 06 章 6.3.2「約束測試在 H2 上是綠的，正式環境卻擋不住」的一個變形**：
不只是 H2 vs MySQL，**MySQL 8.0.15 vs 8.0.16 的行為也不同**。
所以 00 章 0.11.3 那條「資料庫是預期的大版本」測試，其實應該再嚴格一點：

```java
@Test
void CHECK_約束真的會被執行() {
    jdbc.execute("DROP TEMPORARY TABLE IF EXISTS chk_probe");
    jdbc.execute("CREATE TEMPORARY TABLE chk_probe (qty INT NOT NULL CHECK (qty >= 0))");
    assertThatThrownBy(() -> jdbc.update("INSERT INTO chk_probe VALUES (-1)"))
            .as("MySQL 8.0.16 之前的 CHECK 是【語法上接受、執行時忽略】")
            .hasMessageContaining("Check constraint");
}
```

⚠️ **但要記得 06 站 0.8.2 的實測結論**：
`CHECK (qty >= 0)` **擋不住超賣**，因為超賣的機制是「讀到舊值 → 算出新值 → 寫回去」，
而每一個併發交易算出來的新值**都 >= 0**。約束只檢查「寫進去的值」，不檢查「讀的時候是不是最新的」。

> 📌 **`CHECK` 的正確定位：它是【最後一道防線】，不是【第一道】。**
> 它擋的是「程式有 bug」「有人手動下 SQL」「資料匯入的檔案有問題」，
> **不是併發**。併發要靠原子 `UPDATE`、唯一索引，或 04 章的鎖。

### 1.10.3 實測：外鍵擋得住什麼、代價是什麼

```sql
CREATE TABLE fk_parent (id BIGINT PRIMARY KEY) ENGINE=InnoDB;
INSERT INTO fk_parent SELECT id FROM v_short LIMIT 5000;

CREATE TABLE fk_child (
  id  BIGINT AUTO_INCREMENT PRIMARY KEY,
  pid BIGINT NOT NULL,
  KEY (pid),
  CONSTRAINT fk_p FOREIGN KEY (pid) REFERENCES fk_parent(id)
) ENGINE=InnoDB;

INSERT INTO fk_child (pid) VALUES (999999);      -- 父不存在
```

```
ERROR 1452 (23000): Cannot add or update a child row: a foreign key constraint fails
                    (`shop`.`fk_child`, CONSTRAINT `fk_p` FOREIGN KEY (`pid`)
                     REFERENCES `fk_parent` (`id`))
```

```sql
INSERT INTO fk_child (pid) VALUES (1);
DELETE FROM fk_parent WHERE id = 1;              -- 還有小孩指著它
```

```
ERROR 1451 (23000): Cannot delete or update a parent row: a foreign key constraint fails
```

**外鍵會自動建索引**：

```sql
CREATE TABLE fk_c2 (id BIGINT AUTO_INCREMENT PRIMARY KEY, pid BIGINT NOT NULL,
                    CONSTRAINT fk_p2 FOREIGN KEY (pid) REFERENCES fk_parent(id));
SHOW INDEX FROM fk_c2;
```

```
Key_name    Column_name
PRIMARY     id
fk_p2       pid          ← ★ 你沒有寫 KEY(pid)，InnoDB 自己建了
```

📌 **這解釋了一個常見的困惑**：「我沒建索引，為什麼 `SHOW INDEX` 多一個？」

**外鍵的四個代價**：

```
① 每次寫入子表都要【查一次父表】—— 而且會在父表那一列上加鎖（04 章）
② 刪父表資料時要【檢查所有子表】—— 子表越多越慢
③ 🔴 它會製造【跨表的鎖等待】—— 兩個交易改不同的子表，卻因為同一個父列而互等
④ 資料遷移、批次匯入時很麻煩（要 SET FOREIGN_KEY_CHECKS=0，然後承擔風險）
```

⚠️ **所以大型系統常常不用外鍵**（Facebook、GitHub 都公開說過）。**這是一個真實的取捨**：

| | 用外鍵 | 不用外鍵 |
|---|---|---|
| 孤兒資料 | ✅ 不可能發生 | 🔴 一定會發生（總有一天） |
| 寫入效能 | 🟡 慢一點，且有鎖競爭 | ✅ |
| 分庫分表 | 🔴 跨庫時完全不能用 | ✅ |
| 資料修補 / 遷移 | 🔴 麻煩 | ✅ |

> 📌 **本課的規則：中小型單體服務【用】外鍵。**
> ```
> ① 孤兒資料的清理成本，遠高於外鍵的效能成本
> ② 06 站 0.8 說過：能讓資料庫守的不變量，就讓資料庫守
> ③ 而「效能成本」在 shop-service 的量級（尖峰數百 TPS）是可忽略的
> ```
> ⚠️ **但要知道退場條件**：當你開始分庫分表（那是 database-course 的主題），
> 外鍵會是第一個要拆掉的東西 —— **所以不要讓業務邏輯依賴 `ON DELETE CASCADE`。**

**`ON DELETE` / `ON UPDATE` 的四個選項**：

| | 行為 | 建議 |
|---|---|---|
| `RESTRICT`（預設） | 有子資料就拒絕刪除 | ✅ **預設用這個** |
| `NO ACTION` | 在 InnoDB 等同 `RESTRICT` | — |
| `CASCADE` | 連帶刪除子資料 | 🔴 **不要用**（見下） |
| `SET NULL` | 把子資料的外鍵設成 NULL | 🟡 只在「父可選」時 |

🔴 **為什麼不要用 `ON DELETE CASCADE`**：

```
① 它讓「刪一列」變成「刪未知列數」—— 一句 DELETE 可能鎖住十萬列
② 它繞過應用層 —— 05 站的領域事件、outbox、稽核日誌【全部不會觸發】
③ 它是隱形的 —— 讀 Java 程式碼完全看不出來會發生連帶刪除
④ 而且真實世界極少「真的要刪」—— 通常要的是軟刪除或歸檔
```

### 1.10.4 實測：軟刪除 + 唯一索引的陷阱 ★★

**需求**：`email` 要唯一，但已刪除的使用者不算。

**最常見的做法**（而且是錯的）：

```sql
CREATE TABLE t_soft (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  email      VARCHAR(100) NOT NULL,
  deleted_at DATETIME NULL,
  UNIQUE KEY uk_email (email, deleted_at)          -- ← 把 deleted_at 加進唯一索引
);
```

**測試 A：刪掉之後可以重新註冊嗎？**

```sql
INSERT INTO t_soft (email) VALUES ('a@x.com');                       -- id 1
UPDATE t_soft SET deleted_at = '2026-01-01 00:00:00' WHERE id = 1;   -- 軟刪除
INSERT INTO t_soft (email) VALUES ('a@x.com');                       -- id 2
```

```
✅ 成功
id   email      deleted_at
2    a@x.com    NULL
1    a@x.com    2026-01-01 00:00:00
```

**測試 B：同一秒內第二次軟刪除**

```sql
UPDATE t_soft SET deleted_at = '2026-01-01 00:00:00' WHERE id = 2;
```

```
ERROR 1062 (23000): Duplicate entry 'a@x.com-2026-01-01 00:00:00' for key 't_soft.uk_email'
```

🔴 **軟刪除失敗了** —— 因為 `(email, deleted_at)` 撞到第一筆。
在 `DATETIME(0)` 精度下，**同一秒內刪兩次同 email 的帳號就會發生**。

**測試 C（致命的那一個）：兩筆都沒刪除，唯一索引擋得住嗎？**

```sql
SELECT * FROM t_soft;
-- id 2: a@x.com, deleted_at = NULL
INSERT INTO t_soft (email) VALUES ('a@x.com');       -- 再插一筆未刪除的
SELECT * FROM t_soft;
```

```
id   email      deleted_at
2    a@x.com    NULL          ← 🔴
3    a@x.com    NULL          ← 🔴 兩筆都是「未刪除」，唯一索引【完全沒有擋住】
1    a@x.com    2026-01-01 00:00:00
```

⚠️ **這就是這個做法的致命傷**：**`NULL <> NULL`（1.7.2）**，
所以兩筆 `deleted_at IS NULL` 的列在唯一索引看來是**不重複的**。

**這個約束什麼都沒有守住。** 而它看起來非常合理，出現在無數的教學文章與生產環境裡。

**正確做法一：哨兵值（本課採用）**

```sql
CREATE TABLE t_soft2 (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  email      VARCHAR(100) NOT NULL,
  -- ★ NOT NULL + 哨兵值，讓「未刪除」也是一個【具體的值】
  deleted_at DATETIME(3) NOT NULL DEFAULT '1970-01-01 00:00:00.000',
  UNIQUE KEY uk_email (email, deleted_at)
);
```

```sql
INSERT INTO t_soft2 (email) VALUES ('a@x.com');    -- ✅
INSERT INTO t_soft2 (email) VALUES ('a@x.com');    -- ?
```

```
ERROR 1062 (23000): Duplicate entry 'a@x.com-1970-01-01 00:00:00.000' for key 't_soft2.uk_email'
✅ 擋住了
```

```sql
UPDATE t_soft2 SET deleted_at = NOW(3) WHERE id = 1;    -- 軟刪除
INSERT INTO t_soft2 (email) VALUES ('a@x.com');         -- ✅ 可以重新註冊
```

📌 **而且 `DATETIME(3)` 的毫秒精度讓測試 B 的問題也幾乎消失**
（同一毫秒內刪兩次同一個 email 才會撞）。

**正確做法二：生成欄位**

```sql
CREATE TABLE t_soft3 (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  email        VARCHAR(100) NOT NULL,
  deleted_at   DATETIME(3) NULL,
  -- ★ 只有「未刪除」時才有值
  email_active VARCHAR(100) GENERATED ALWAYS AS (IF(deleted_at IS NULL, email, NULL)) VIRTUAL,
  UNIQUE KEY uk_email_active (email_active)
);
```

```sql
INSERT INTO t_soft3 (email) VALUES ('a@x.com');
UPDATE t_soft3 SET deleted_at = NOW(3) WHERE id = 1;
INSERT INTO t_soft3 (email) VALUES ('a@x.com');       -- ✅ 重新註冊 OK
SELECT id, email, deleted_at, email_active FROM t_soft3;
```

```
id   email     deleted_at                 email_active
1    a@x.com   2026-09-02 04:25:33.872    NULL          ← 已刪除，不參與唯一性
2    a@x.com   NULL                       a@x.com
```

```sql
INSERT INTO t_soft3 (email) VALUES ('a@x.com');       -- 第三個未刪除的
```

```
ERROR 1062 (23000): Duplicate entry 'a@x.com' for key 't_soft3.uk_email_active'
✅ 擋住了
```

**兩種做法的比較**：

| | 哨兵值 | 生成欄位 |
|---|---|---|
| 唯一索引大小 | 🟡 `email + 8 bytes` | ✅ 只有 `email`，而且已刪除的列不進索引 |
| 可讀性 | 🔴 `1970-01-01` 是一個要解釋的魔術值 | ✅ 意圖明確 |
| 查詢「未刪除」 | `WHERE deleted_at = '1970-01-01'` 🔴 醜 | `WHERE deleted_at IS NULL` ✅ 自然 |
| 相容性 | ✅ 所有版本 | MySQL 5.7+ |
| `ALTER` 加上去 | 要改欄位型別 → COPY | `VIRTUAL` 生成欄位 → INSTANT |

> 📌 **本課採用生成欄位**（做法二），因為它讓**業務查詢維持 `deleted_at IS NULL` 的自然寫法**，
> 而把「唯一性」的技巧藏在一個純粹是為了索引而存在的欄位裡。
>
> ⚠️ **兩種做法都要記得的一件事**：
> **它們守的是「同時最多一筆未刪除」，不是「email 全域唯一」。**
> 也就是說 —— 「這個 email 曾經被誰用過」需要另外查。
> **這是軟刪除的本質代價，換哪一種索引技巧都躲不掉。**

### 1.10.5 回到 06 站：11 條不變量守在哪

06 站 00 章 0.8.7 給了一張「11 條不變量 × 守在哪一層」的表，
但當時的結論是「等 07 站驗證」。**現在可以填上了**：

| # | 不變量 | 06 站的判斷 | 07 站實測後 |
|---|---|---|---|
| 1 | 訂單編號唯一 | 唯一索引 | ✅ `UNIQUE KEY uk_order_no`（1.10.4 的技巧不需要，因為訂單不軟刪除） |
| 2 | 訂單一定屬於一個客戶 | 外鍵 | ✅ `FOREIGN KEY ... ON DELETE RESTRICT`（1.10.3） |
| 3 | 訂單金額 = 明細總和 | 應用層 | 🔴 **`CHECK` 做不到**（不能有子查詢，1.10.1）→ 仍在應用層 + 一條對帳批次 |
| 4 | 庫存不為負 | 原子 UPDATE | ✅ 原子 UPDATE（**不是** `CHECK`，1.10.2）；⚠️ 欄位**不能**用 `UNSIGNED`（1.3.2 坑一） |
| 5 | 已付款的訂單不可修改金額 | 應用層 | 🟡 `CHECK` 做不到（跨列狀態轉移）→ 應用層 + 04 章的鎖 |
| 6 | 折扣不超過總額 | `CHECK` | ✅ `CHECK (discount_amount <= total_amount)`（單列內，1.10.1） |
| 7 | 一個使用者一個 email | 唯一索引 | ✅ 但要用 1.10.4 的生成欄位（因為使用者會軟刪除） |
| 8 | 出貨日 >= 下單日 | `CHECK` | ✅ `CHECK (shipped_at IS NULL OR shipped_at >= created_at)` |
| 9 | 冪等鍵不重複 | 唯一索引 | ✅ `UNIQUE KEY uk_idempotency (idempotency_key)` |
| 10 | outbox 訊息不重送 | 唯一索引 + 狀態 | ✅ 唯一索引 + 04 章的 `SELECT ... FOR UPDATE SKIP LOCKED` |
| 11 | 訂單狀態只能單向轉移 | 應用層 | 🔴 資料庫守不住（需要「舊值 → 新值」的知識）→ 應用層 + 樂觀鎖 `version` |

📌 **11 條裡，資料庫能守的是 6 條（1、2、4、6、8、9、10），應用層仍要守 5 條。**

⚠️ **而 06 站 0.8 那個關鍵結論仍然成立**：

> **能被資料庫守住的，都是「單列內」或「跨列的存在性 / 唯一性」。**
> **凡是需要「知道舊值是什麼」的規則（狀態轉移、金額不可變、餘額一致），
> 資料庫都守不住 —— 那是交易與鎖的範圍（04 章）。**

---

## 1.11 命名慣例

命名不影響效能，但它是**你每天都要付的成本**。本課的規則：

```
① 表名：小寫 + 底線 + 【單數】          order, order_item, product, stock
   → 為什麼單數：一列就是一個 order；而且避開 "s" 的英文複數不規則（person/people）
   → 🔴 但 order 是 MySQL 保留字！本課用 `orders`（見下方例外）

② 欄位名：小寫 + 底線               created_at, customer_id, total_amount
   → 00 章 0.9.3：這樣在 lower_case_table_names 的 0/1/2 三種設定下行為都一樣

③ 主鍵一律叫 id                      不要叫 order_id、oid、pk
④ 外鍵 = 目標表名(單數) + _id        customer_id, product_id
⑤ 布林欄位加 is_ / has_ 前綴          is_active, has_shipped
⑥ 時間欄位加 _at 後綴（時刻）
              _date 後綴（只有日期）   created_at, paid_at, birth_date
⑦ 金額欄位加 _amount 後綴             total_amount, discount_amount
⑧ 有單位的數字，單位寫進欄位名        duration_ms, weight_g, valid_days

⑨ 索引命名：
   主鍵         PRIMARY（MySQL 固定）
   唯一索引     uk_<表>_<欄位>          uk_orders_order_no
   一般索引     idx_<表>_<欄位>         idx_orders_customer_created
   外鍵         fk_<子表>_<父表>        fk_order_item_orders
   CHECK        ck_<表>_<規則>          ck_orders_discount_le_total
```

⚠️ **保留字的問題**：MySQL 8 有 **262 個保留字**。這些常見的表 / 欄位名是保留字：

```
🔴 order, group, key, index, rank, system, range, lead, lag, first, last,
   status（不是保留字，可以用）, desc, asc, read, write, condition, interval
```

**兩種處理方式**：

```sql
-- ✅ ① 換一個名字（本課採用）
CREATE TABLE orders (...);          -- 而不是 order
CREATE TABLE user_group (...);      -- 而不是 group

-- 🟡 ② 用反引號包起來
CREATE TABLE `order` (...);
    → 🔴 之後每一句 SQL 都要記得加反引號
    → 🔴 ORM 產生的 SQL 通常會加，手寫的常常忘記
    → 🔴 換到別的資料庫（PostgreSQL 用雙引號）就要全改
```

📌 **查一個名字是不是保留字**：

```sql
SELECT WORD, RESERVED FROM information_schema.KEYWORDS WHERE WORD IN ('ORDER','STATUS','RANK','GROUPS');
```

**每一欄都要有 `COMMENT`**：

```sql
status VARCHAR(16) NOT NULL COMMENT '對應 com.example.shop.domain.OrderStatus',
```

⚠️ **`COMMENT` 是唯一一個「跟著 schema 走」的文件**。
Confluence 上的文件會過期，程式碼裡的註解只有 Java 工程師看得到，
但**任何人 `SHOW CREATE TABLE` 都會看到 `COMMENT`** ——
包含三年後的你、DBA、資料分析師、以及正在半夜排查的那個人。

---

## 1.12 shop-service 的完整 schema

把本章的每一個決定合起來。**這份 schema 在 06 章會被搬進 Flyway 的第一個遷移腳本。**

```sql
-- =====================================================================
-- shop-service schema  v1
-- 字元集 / 定序 / sql_mode 由 00 章的 conf/shop.cnf 決定，這裡不重複宣告
-- 主鍵一律 BINARY(16) 的 UUIDv7（1.8.4、1.8.8）
-- 時間一律 DATETIME(3)，語意上是 UTC（1.5.2、00 章 0.6.2）
-- 金額一律 DECIMAL(19,4)（1.3.8）
-- =====================================================================

-- ── 客戶 ──────────────────────────────────────────────────────────
CREATE TABLE customer (
  id              BINARY(16)   NOT NULL                   COMMENT 'UUIDv7',
  email           VARCHAR(255) NOT NULL                   COMMENT 'RFC 5321 上限 254',
  -- ★ username 單獨用 as_cs：登入帳號區分大小寫（00 章 0.5.8）
  username        VARCHAR(64)  NOT NULL COLLATE utf8mb4_0900_as_cs,
  display_name    VARCHAR(64)  NOT NULL                   COMMENT '跟表走 ai_ci，可含 emoji',
  phone           VARCHAR(20)  NULL                       COMMENT '選填；用 NULL 不是 ''''（1.7.3）',
  password_hash   VARBINARY(60) NOT NULL                  COMMENT 'bcrypt；VARBINARY 避開定序（1.4.6）',
  deleted_at      DATETIME(3)  NULL,
  -- ★ 部分唯一索引：只有未刪除的列參與唯一性（1.10.4 做法二）
  email_active    VARCHAR(255) GENERATED ALWAYS AS (IF(deleted_at IS NULL, email, NULL)) VIRTUAL,
  username_active VARCHAR(64)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, username, NULL)) VIRTUAL
                               COLLATE utf8mb4_0900_as_cs,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                        ON UPDATE CURRENT_TIMESTAMP(3),
  version         BIGINT       NOT NULL DEFAULT 0         COMMENT '樂觀鎖（06 站 0.14.1）',

  PRIMARY KEY (id),
  UNIQUE KEY uk_customer_email    (email_active),
  UNIQUE KEY uk_customer_username (username_active),
  UNIQUE KEY uk_customer_phone    (phone)                 COMMENT 'NULL 可重複（1.7.2），正是我們要的'
) ENGINE=InnoDB COMMENT='客戶';

-- ── 商品 ──────────────────────────────────────────────────────────
CREATE TABLE product (
  id           BINARY(16)     NOT NULL                    COMMENT 'UUIDv7',
  sku          VARCHAR(32)    NOT NULL COLLATE utf8mb4_bin COMMENT 'SKU 區分大小寫',
  name         VARCHAR(200)   NOT NULL                    COMMENT '前端限 100 字，留兩倍',
  unit_price   DECIMAL(19,4)  NOT NULL,
  currency     CHAR(3)        NOT NULL DEFAULT 'TWD'      COMMENT 'ISO 4217；長度真的固定（1.4.1）',
  attrs        JSON           NULL                        COMMENT '各類別不同的屬性（1.6.2）',
  -- ★ 只有 color 需要被查詢，拉出來做生成欄位（1.6.3）
  color        VARCHAR(20)    GENERATED ALWAYS AS (attrs->>'$.color') VIRTUAL,
  is_active    BOOLEAN        NOT NULL DEFAULT TRUE,
  created_at   DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                       ON UPDATE CURRENT_TIMESTAMP(3),
  version      BIGINT         NOT NULL DEFAULT 0,

  PRIMARY KEY (id),
  UNIQUE KEY uk_product_sku (sku),
  KEY idx_product_color (color),
  CONSTRAINT ck_product_price     CHECK (unit_price >= 0),
  CONSTRAINT ck_product_is_active CHECK (is_active IN (0,1))    -- 1.6.1：TINYINT(1) 可以存 5
) ENGINE=InnoDB COMMENT='商品';

-- ── 庫存 ──────────────────────────────────────────────────────────
CREATE TABLE stock (
  product_id   BINARY(16) NOT NULL,
  -- ★ 刻意【不用】 UNSIGNED：原子 UPDATE 減到負數時要回傳 0 列，不是拋 ERROR 1690（1.3.2 坑一）
  qty          INT        NOT NULL DEFAULT 0,
  reserved_qty INT        NOT NULL DEFAULT 0             COMMENT '已預扣未出貨',
  updated_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                    ON UPDATE CURRENT_TIMESTAMP(3),
  version      BIGINT     NOT NULL DEFAULT 0,

  PRIMARY KEY (product_id),
  CONSTRAINT fk_stock_product FOREIGN KEY (product_id) REFERENCES product(id),
  -- ⚠️ 這兩條 CHECK 是【最後一道防線】，不是併發的防線（1.10.2、06 站 0.8.2）
  CONSTRAINT ck_stock_qty          CHECK (qty >= 0),
  CONSTRAINT ck_stock_reserved     CHECK (reserved_qty >= 0),
  CONSTRAINT ck_stock_reserved_le  CHECK (reserved_qty <= qty)
) ENGINE=InnoDB COMMENT='庫存；不變量 #4 靠原子 UPDATE 守';

-- ── 訂單 ──────────────────────────────────────────────────────────
CREATE TABLE orders (                                     -- ★ 不叫 order：保留字（1.11）
  id               BINARY(16)    NOT NULL                 COMMENT 'UUIDv7',
  order_no         VARCHAR(32)   NOT NULL                 COMMENT 'SO-YYYY-NNNNNNNN',
  customer_id      BINARY(16)    NOT NULL,
  status           VARCHAR(16)   NOT NULL                 COMMENT '對應 OrderStatus enum',
  total_amount     DECIMAL(19,4) NOT NULL,
  discount_amount  DECIMAL(19,4) NOT NULL DEFAULT 0.0000,
  currency         CHAR(3)       NOT NULL DEFAULT 'TWD',
  idempotency_key  BINARY(16)    NULL                     COMMENT '建單的冪等鍵（不變量 #9）',
  placed_at        DATETIME(3)   NOT NULL                 COMMENT '下單時刻（UTC）',
  paid_at          DATETIME(3)   NULL                     COMMENT 'NULL = 還沒付（1.7.3）',
  shipped_at       DATETIME(3)   NULL,
  cancelled_at     DATETIME(3)   NULL,
  created_at       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                          ON UPDATE CURRENT_TIMESTAMP(3),
  version          BIGINT        NOT NULL DEFAULT 0,

  PRIMARY KEY (id),
  UNIQUE KEY uk_orders_order_no        (order_no),                    -- 不變量 #1
  UNIQUE KEY uk_orders_idempotency     (idempotency_key),             -- 不變量 #9（NULL 可重複）
  -- ★ 已知的查詢路徑：「某客戶的訂單，按時間倒序」（03 章 3.8 會解釋欄位順序）
  KEY idx_orders_customer_placed       (customer_id, placed_at),
  -- ★ 已知的查詢路徑：「待出貨的訂單」
  KEY idx_orders_status_placed         (status, placed_at),

  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customer(id),
  CONSTRAINT ck_orders_status   CHECK (status IN
      ('PENDING','PAID','PACKED','SHIPPED','DELIVERED','CANCELLED','REFUNDED')),
  CONSTRAINT ck_orders_amount   CHECK (total_amount >= 0),
  CONSTRAINT ck_orders_discount CHECK (discount_amount >= 0
                                       AND discount_amount <= total_amount),   -- 不變量 #6
  CONSTRAINT ck_orders_shipped  CHECK (shipped_at IS NULL
                                       OR shipped_at >= placed_at)             -- 不變量 #8
) ENGINE=InnoDB COMMENT='訂單';

-- ── 訂單明細 ──────────────────────────────────────────────────────
CREATE TABLE order_item (
  id           BINARY(16)    NOT NULL,
  order_id     BINARY(16)    NOT NULL,
  product_id   BINARY(16)    NOT NULL,
  -- ★ 快照：商品名稱與單價要【存下來】，不能 JOIN 商品表拿現在的值
  --   否則商品改價之後，歷史訂單的金額會跟著變（05 站 0.5 的不變量）
  product_name VARCHAR(200)  NOT NULL COMMENT '下單當下的快照',
  unit_price   DECIMAL(19,4) NOT NULL COMMENT '下單當下的快照',
  qty          INT           NOT NULL,
  line_amount  DECIMAL(19,4) NOT NULL COMMENT '= unit_price × qty，由應用算好（1.3.7）',
  created_at   DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  KEY idx_order_item_order (order_id),
  CONSTRAINT fk_order_item_orders  FOREIGN KEY (order_id)   REFERENCES orders(id),
  CONSTRAINT fk_order_item_product FOREIGN KEY (product_id) REFERENCES product(id),
  CONSTRAINT ck_order_item_qty     CHECK (qty > 0),
  CONSTRAINT ck_order_item_price   CHECK (unit_price >= 0)
) ENGINE=InnoDB COMMENT='訂單明細；不變量 #3（總額=明細和）資料庫守不住，見 1.10.5';

-- ── Outbox（05 站 07 章、11 站 02 章）────────────────────────────
CREATE TABLE outbox_message (
  id            BINARY(16)   NOT NULL                     COMMENT 'UUIDv7；應用端先產生',
  aggregate_id  BINARY(16)   NOT NULL,
  event_type    VARCHAR(64)  NOT NULL,
  payload       JSON         NOT NULL,
  status        VARCHAR(16)  NOT NULL DEFAULT 'PENDING',
  attempts      SMALLINT UNSIGNED NOT NULL DEFAULT 0      COMMENT '只增不減，可以 UNSIGNED（1.3.2）',
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  published_at  DATETIME(3)  NULL,

  PRIMARY KEY (id),
  -- ★ 投遞器的查詢路徑：「待發送的，按建立時間」（04 章會加 FOR UPDATE SKIP LOCKED）
  KEY idx_outbox_status_created (status, created_at),
  CONSTRAINT ck_outbox_status CHECK (status IN ('PENDING','PUBLISHED','FAILED'))
) ENGINE=InnoDB COMMENT='交易性發件匣';

-- ── 客戶地址（1.7.2 的部分唯一索引示範）──────────────────────────
CREATE TABLE address (
  id             BINARY(16)   NOT NULL,
  customer_id    BINARY(16)   NOT NULL,
  recipient      VARCHAR(64)  NOT NULL,
  phone          VARCHAR(20)  NOT NULL,
  postal_code    VARCHAR(10)  NOT NULL COMMENT '各國長度不同，不用 CHAR（1.4.1）',
  line1          VARCHAR(200) NOT NULL,
  line2          VARCHAR(200) NULL,
  is_default     BOOLEAN      NOT NULL DEFAULT FALSE,
  -- ★ 一個客戶最多一個預設地址（1.7.2）
  default_marker BINARY(16)   GENERATED ALWAYS AS (IF(is_default, customer_id, NULL)) VIRTUAL,
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  UNIQUE KEY uk_address_one_default (default_marker),
  KEY idx_address_customer (customer_id),
  CONSTRAINT fk_address_customer FOREIGN KEY (customer_id) REFERENCES customer(id),
  CONSTRAINT ck_address_is_default CHECK (is_default IN (0,1))
) ENGINE=InnoDB COMMENT='收件地址';
```

⚠️ **這份 schema 刻意留下的四個問題**，會在後面的章節處理：

| 留下的問題 | 哪一章 |
|---|---|
| `idx_orders_customer_placed` 的欄位順序為什麼是這樣？覆蓋索引要不要加欄位？ | 03 章 |
| 三個 `stock` 的 `CHECK` 擋不住超賣，那 `tryReserve` 到底怎麼寫才對？ | 04 章 |
| `outbox_message` 的 `payload JSON` 會不會讓那張表變成掃描地獄？ | **05 章 5.11.8**（會：碰到它就多 58 倍的頁面請求） |
| 這份 `CREATE TABLE` 要怎麼變成可重複執行、可回滾的遷移腳本？ | 06 章 |

---

### 1.12.1 實測：這份 schema 真的守得住那些不變量嗎

把上面那份 `CREATE TABLE` 原封不動跑進一個乾淨的資料庫，然後逐條戳它：

```sql
SET @c1 := UNHEX('01a06080e75474119d0ff5d982d76b2d');   -- 一個 UUIDv7
SET @c2 := UNHEX('01a06080e7597bbca0d6b987143cae3f');
SET @p1 := UNHEX('01a06080e75c73818b28ee977ce7f04b');
SET @o1 := UNHEX('01a06080e75f7a3f905510dbe7d39b99');

INSERT INTO customer (id,email,username,display_name,password_hash) VALUES
  (@c1,'a@x.com','Gary','小明🎉',UNHEX('00')),
  (@c2,'b@x.com','gary','小華',  UNHEX('00'));
```

```
① Gary 與 gary 都能註冊（username 是 as_cs）    n = 2      ✅
② 生成欄位 color 自動填好                       color=red  ✅
③ 訂單建立                                      SO-2026-00000001 / PENDING  ✅
```

**八條不變量的探針**：

```
✅ #7  email 重複        → ERROR 1062  Duplicate entry 'a@x.com' for key 'customer.uk_customer_email'
✅ #6  折扣 > 總額       → ERROR 3819  Check constraint 'ck_orders_discount' is violated.
✅ #11 非法狀態          → ERROR 3819  Check constraint 'ck_orders_status' is violated.
✅ #8  出貨早於下單      → ERROR 3819  Check constraint 'ck_orders_shipped' is violated.
✅ #4  庫存變負          → ERROR 3819  Check constraint 'ck_stock_qty' is violated.
✅ #4b 預扣 > 庫存       → ERROR 3819  Check constraint 'ck_stock_reserved_le' is violated.
✅ #2  刪掉有訂單的客戶  → ERROR 1451  Cannot delete or update a parent row
✅     明細數量必須 > 0  → ERROR 3819  Check constraint 'ck_order_item_qty' is violated.
```

**軟刪除的完整流程**（1.10.4 的做法二在真實 schema 上）：

```sql
UPDATE customer SET deleted_at = NOW(3) WHERE username = 'gary';
INSERT INTO customer (...) VALUES (..., 'b@x.com', 'gary', '新的小華', ...);   -- ✅ 可以重新註冊
```

```
username  email      deleted_at                 email_active   username_active
Gary      a@x.com    NULL                       a@x.com        Gary
gary      b@x.com    2026-09-02 05:08:24.810    NULL           NULL        ← 不參與唯一性
gary      b@x.com    NULL                       b@x.com        gary
```

```sql
INSERT INTO customer (...) VALUES (..., 'c@x.com', 'gary', '第三個', ...);   -- 第三個未刪除的 gary
```

```
ERROR 1062 (23000): Duplicate entry 'gary' for key 'customer.uk_customer_username'
✅ 擋住了
```

> ⚠️ **注意 #4 那一條被 `CHECK` 擋住了，但這【不代表】它守得住超賣。**
> 這個測試是「一句 `UPDATE` 直接把庫存減到 −90」——
> 而超賣的機制是「20 個交易各自讀到 10、各自減 1、各自寫回 9」，
> **每一筆寫進去的值都是 9，`CHECK (qty >= 0)` 一次都不會觸發。**
>
> 📌 **這正是 06 站 00 章 0.8.2 的實測結論**，而 04 章會用 InnoDB 的鎖把它講完。
> **本章能做的，是確保 schema 沒有【擋掉正確做法】** ——
> 例如 `qty` 刻意不用 `UNSIGNED`（1.3.2 坑一），
> 就是為了讓 04 章的 `UPDATE stock SET qty = qty - ? WHERE qty >= ?` 能回傳 0 列，
> 而不是拋出一個技術例外。

---

## 1.13 常見誤區

**誤區 1：「金額用 `DOUBLE` 就夠精確了」**

→ 1.3.5 實測：1000 筆 19.99 用 `DOUBLE` 加起來是 **19990.000000000135**，`= 19990` 是 **false**。
問題不是「誤差大小」，是**你失去了「相等」這個概念** —— 而對帳就是在問相不相等。

**誤區 2：「`FLOAT` 只是精度低一點」**

→ 1.3.4 實測：`FLOAT` 存 `99999999` 讀出來是 **`100000000`**，
存 `1234567.89` 讀出來是 **`1234570`**。
**那不是精度低，是資料錯了** —— 而且錯成一個看起來很合理的整數。

**誤區 3：「`INT` 的 21 億夠用了」**

→ 1.3.1：訂單明細表一天 300 萬列，兩年就滿。而且 1.8.5 的「洞」會加速消耗。
**主鍵一律 `BIGINT`。** 那 4 個位元組不值得一次停機遷移。

**誤區 4：「`UNSIGNED` 可以讓範圍加倍，沒有壞處」**

→ 1.3.2 實測：`SELECT qty - 5` 在 `qty=3` 的 `UNSIGNED` 欄位上**直接 `ERROR 1690`** ——
連純 `SELECT` 都會炸，而且**與 `sql_mode` 的嚴格程度無關**。
這會把 `UPDATE ... WHERE qty >= ?` 的「回傳 0 列」變成「拋例外」，**改變你的錯誤語意**。

**誤區 5：「`VARCHAR(255)` 跟 `VARCHAR(20)` 沒差，反正只存實際長度」**

→ 1.4.2 實測：**在 MySQL 8 的預設 `TempTable` 引擎上真的沒差**（31 ms vs 31 ms），
**但換成 `MEMORY` 引擎就差 4.1 倍**（42 ms vs 174 ms，而且溢出到磁碟）。
而且它仍然有四個代價：索引長度上限、一列 65535 的額度、
`VARCHAR(63)↔(64)` 的 ALTER 界線（實測），以及「它是一份文件」。

**誤區 6：「`VARCHAR` 加長是免費的」**

→ 1.2.2 實測：`VARCHAR(63) → VARCHAR(64)` 要 **COPY 整張表**（跨過長度前綴 1→2 bytes 的界線），
而 `VARCHAR(20) → VARCHAR(63)` 可以 INPLACE。**縮短則永遠是 COPY。**

**誤區 7：「`ENUM` 型別安全又省空間，狀態欄位就用它」**

→ 1.4.4 的四個陷阱：排序按宣告順序、非嚴格模式下錯值變成空字串、
**插在中間的新值要重建整張表**（實測 `ERROR 1846`）、與 Java enum 是兩份要人工同步。

**誤區 8：「狀態用 `VARCHAR` 太浪費空間了」**

→ 1.4.5 實測：10 萬列的**資料**大小三者完全相同（3.52 MB），
差的是**索引**（`VARCHAR` 大 67%）。
在低基數的狀態欄位上，那 67% 通常不重要 —— **可讀性的價值更大**。

**誤區 9：「`DATETIME` 就是 `DATETIME`，加不加 `(3)` 差不多」**

→ 1.5.2 實測：`DATETIME` 就是 `DATETIME(0)`，而且轉換是**四捨五入不是截斷** ——
`2026-09-02 23:59:59.6` 存進去變成 **`2026-09-03 00:00:00`**，**日期跳到隔天**。
這會讓約 0.0006% 的訂單被算進錯的一天，頻率低到查不出規律、高到財務每個月都會問。

**誤區 10：「`Instant.now()` 直接存就好」**

→ 1.5.2：`Instant.now()` 有奈秒精度，存進 `DATETIME(3)` 時多的部分被**四捨五入**，
而 Java 的 `truncatedTo` 是**截斷** —— 兩邊規則不同。
要在 Java 這一側先 `truncatedTo(ChronoUnit.MILLIS)`。

**誤區 11：「`BOOLEAN` 欄位只會是 0 或 1」**

→ 1.6.1 實測：`BOOLEAN` = `TINYINT(1)`，而 `(1)` 只是顯示寬度，**可以存 5**。
而且 `c = TRUE` 是 **假**、`c IS TRUE` 是 **真** —— 同一欄兩種答案。
要加 `CHECK (col IN (0,1))`。

**誤區 12：「欄位可能會變，先用 JSON 比較有彈性」**

→ 1.6.2：半年後所有查詢都是 `attrs->>'$.xxx'`，**沒有一個走得到索引**。
JSON 的三個判準要**同時成立**：不被 WHERE/JOIN/ORDER BY 用到、結構真的不固定、不需要驗證。

**誤區 13：「`NOT IN (子查詢)` 跟 `NOT EXISTS` 一樣」**

→ 1.7.1 實測：`2 NOT IN (1, NULL)` 的結果是 **`NULL`**，不是真。
所以子查詢只要回傳過一個 `NULL`，`NOT IN` 就**永遠回傳空結果集** ——
而且不會報錯，「零列」看起來像一個合理的答案。

**誤區 14：「一律 `NOT NULL DEFAULT ''` 比較乾淨」**

→ 1.7.3：用 `''` / `0` 表示「沒有值」，等於發明一個**資料庫不知道是假的 `NULL`**。
`UNIQUE KEY (phone)` 會擋掉第二個「沒填手機」的人；
`AVG(discount)` 會把「沒有折扣」也算進分母。

**誤區 15：「UUID 主鍵在我的環境測起來沒有變慢」**

→ 1.8.2 / 1.8.3 實測：
**buffer pool 128 MB / 30 萬列 → UUIDv4 只慢 1.25 倍**；
**buffer pool 16 MB / 60 萬列 → 慢 10.35 倍**。
**「在我的機器上測起來沒差」在資料庫的世界裡幾乎沒有意義**，
因為測試資料量通常小於 buffer pool，正式環境通常大於。

**誤區 16：「要用 UUID 就得接受它慢」**

→ 1.8.3：**UUIDv7（時間有序）在同樣的壓力下只慢 1.12 倍**，空間多 32%。
代價來自「隨機」，不是來自「UUID」。

**誤區 17：「UUID 存 `CHAR(36)` 比較好讀」**

→ 1.8.3 實測，**兩者要跟同一個基準線比才有意義**：

```
                          合計空間      對 BIGINT      插入時間      對 BIGINT
② UUIDv4 CHAR(36)         119.4 MB       2.25x        65,351 ms      10.35x
③ UUIDv4 BINARY(16)        85.2 MB       1.60x        56,993 ms       9.02x
───────────────────────────────────────────────────────────────────────────
   ② 相對於 ③               +40%                         +15%
```

🔴 **所以「`CHAR(36)` 比 `BINARY(16)` 慢 10 倍」是誤讀** ——
10.35x 是「相對自增主鍵」的倍數，`CHAR(36)` 對 `BINARY(16)` 只慢 **15%**。
**真正的 9 倍代價來自「主鍵隨機」，不是來自「存成字串」。**
存成字串多付的是 **40% 空間 + 15% 時間** —— 仍然不值得，
要好讀就在查詢時 `BIN_TO_UUID(id)`，不要在儲存時付這個代價。

**誤區 18：「`UUID_TO_BIN(u, 1)` 可以讓 UUID 有序」**

→ 1.6.4 / 1.8.4：`swap_flag=1` 是為 **UUIDv1** 設計的。
**對 UUIDv7 用它會把「時間有序」這個唯一的好處毀掉** —— 而且沒有任何錯誤訊息。

**誤區 19：「`AUTO_INCREMENT` 是連續的」**

→ 1.8.5 實測：`ROLLBACK`、唯一鍵衝突、`INSERT IGNORE`、`ON DUPLICATE KEY UPDATE`
都會製造洞。所以 `MAX(id)` 不是筆數、id 差值不是「這段期間的筆數」。

**誤區 20：「重啟資料庫，自增 id 會從 `MAX(id)+1` 開始」**

→ 1.8.6 實測：**MySQL 8.0 會持久化計數器**，重啟後仍是 10 而不是 4。
**但 MySQL 5.7 會退回** —— 於是新訂單可能拿到一個「剛剛被刪掉的舊訂單的 id」。

**誤區 21：「加了 `CHECK (qty >= 0)` 就不會超賣了」**

→ 1.10.2 + 06 站 0.8.2：`CHECK` 只檢查「寫進去的值」，不檢查「讀的時候是不是最新的」。
20 個併發交易各自算出 9 並寫回 9，**`CHECK` 一次都不會觸發**。
`CHECK` 是最後一道防線，不是併發的防線。

**誤區 22：「`CHECK` 可以寫任何條件」**

→ 1.10.1 實測：不能有子查詢、不能有非確定性函式。
`CHECK (created_at <= NOW())` 會直接 `ERROR 3814`。

**誤區 23：「軟刪除的唯一性用 `UNIQUE (email, deleted_at)` 就好」**

→ 1.10.4 實測：**它完全擋不住兩筆 `deleted_at IS NULL` 的重複**（因為 `NULL <> NULL`），
而且**同一秒內第二次軟刪除會失敗**。
要用哨兵值或生成欄位。

**誤區 24：「`ON DELETE CASCADE` 很方便」**

→ 1.10.3：它讓「刪一列」變成「刪未知列數」、
**繞過應用層的領域事件與 outbox**、而且讀 Java 程式碼完全看不出來。

**誤區 25：「每個欄位都建索引比較保險」**

→ 1.9 實測：三個索引讓表大 **167%**、寫入慢 **1.29 倍**（六個索引慢 1.6 倍）。
而且索引也要進 buffer pool —— **索引越多，能放的資料越少，所有查詢一起變慢**。

---

## 1.14 本章練習

### 練習 1：型別評審

以下是一個真實專案的建表語句（去識別化）。找出所有問題並改寫。

```sql
CREATE TABLE `Order` (
  id           INT(11) UNSIGNED NOT NULL AUTO_INCREMENT,
  order_no     VARCHAR(255) NOT NULL,
  user_id      INT(11) NOT NULL,
  amount       FLOAT NOT NULL DEFAULT 0,
  discount     DOUBLE DEFAULT NULL,
  status       VARCHAR(255) NOT NULL DEFAULT 'new',
  is_paid      VARCHAR(5) NOT NULL DEFAULT 'false',
  pay_time     VARCHAR(20) DEFAULT NULL,
  create_time  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expire_time  TIMESTAMP NULL,
  remark       TEXT,
  ext_data     VARCHAR(4000) DEFAULT '',
  client_ip    VARCHAR(50) DEFAULT '',
  deleted      TINYINT DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_user (user_id),
  KEY idx_status (status),
  KEY idx_create (create_time),
  KEY idx_amount (amount),
  KEY idx_order_no (order_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
```

**(a)** 列出所有問題，並標上：🔴 會造成資料錯誤 / 🟡 會造成效能或維運問題 / 🟢 風格。
**(b)** 其中有 **四個**問題會造成「資料看起來正常，但實際上是錯的」。是哪四個？
**(c)** `expire_time` 這一欄有一個**現在就會爆**的問題（不是 2038）。是什麼？
**(d)** `KEY idx_order_no (order_no)` 有兩個問題。是哪兩個？
**(e)** 寫出修正版，每一個改動都加一行註解說明理由。
**(f)** 假設這張表已經有 8000 萬列、線上服務中。
  你的修正版裡哪些改動可以 `INSTANT`／哪些要 `INPLACE`／哪些要 `COPY`？
  排出一個「先做哪些、後做哪些」的順序，並說明理由。

### 練習 2：主鍵決策

為以下六個場景各選一種主鍵策略，並說明理由與代價。

| # | 場景 | 你的選擇 |
|---|---|---|
| 1 | 內部後台的操作日誌表，一天 2000 萬列，只在後台查詢 | |
| 2 | 電商訂單，id 會出現在使用者的 URL 上 | |
| 3 | 商品分類（大約 500 筆，很少變動） | |
| 4 | 使用者與角色的多對多關聯表 | |
| 5 | 從三個不同的資料中心同時寫入的事件表 | |
| 6 | 一張要跟外部系統對接、對方指定用他們的編號當 key 的表 | |

**接著回答**：

**(g)** 第 1 題如果改成「一天 2000 萬列，而且保留三年」，你的答案會變嗎？算一下總列數。
**(h)** 第 4 題你用複合主鍵 `(user_id, role_id)` 還是 `(role_id, user_id)`？取決於什麼？
**(i)** 第 6 題如果對方的編號是 `VARCHAR(64)`，你會直接拿來當主鍵嗎？為什麼？

### 練習 3：不變量落地 ★

以下是六條業務規則。對每一條，決定它該守在哪一層
（`NOT NULL` / `UNIQUE` / `CHECK` / `FOREIGN KEY` / 原子 UPDATE / 應用層 + 鎖），
寫出對應的 DDL 或 SQL，**並說明「如果選錯層，會發生什麼具體事故」**。

```
① 一張優惠券只能被使用一次
② 優惠券的折扣金額不能超過它的面額
③ 已核銷的優惠券不能再被修改折扣金額
④ 一個活動期間內，同一個使用者最多領三張同款優惠券
⑤ 優惠券一定屬於一個已存在的活動
⑥ 活動的結束時間必須晚於開始時間
```

**接著回答**：

**(j)** 其中有 **兩條**是資料庫**完全守不住**的。是哪兩條？為什麼？
**(k)** 第 ④ 條看起來像 `CHECK`，但它不是。它應該怎麼實作？
  （提示：想想 1.7.2 與 1.10.4 的技巧，以及 04 章的鎖）
**(l)** 如果第 ① 條你選了「應用層 `if`」，寫出一個會讓它失效的併發時序圖。

### 練習 4：時間欄位的設計

一個訂閱制服務有以下需求：

```
· 訂閱起始時刻（精確到毫秒，要跟金流對帳）
· 訂閱到期日（只有日期，使用者看到的是「2027-09-02 到期」）
· 每個月的扣款日（1～28 號）
· 使用者所在時區（扣款要在當地時間早上 9 點）
· 上次扣款成功的時刻
· 試用期天數
· 每次扣款的處理耗時（用來監控）
```

**(a)** 為每一項選一個 MySQL 型別 + Java 型別，並說明理由。
**(b)** 「到期日」用 `DATE` 的話，「2027-09-02 到期」是指哪一個時刻結束？
  這個問題在跨時區的使用者身上會怎麼表現？
**(c)** 「每個月的扣款日」如果使用者選了 31 號，二月怎麼辦？
  這是資料庫的問題還是應用的問題？
**(d)** 寫出「找出今天要扣款的訂閱」這句查詢。
  注意：使用者分布在 UTC−8 到 UTC+13 之間。
  你的查詢要走得到索引嗎？（回到 00 章 0.6.6）

### 練習 5：實測重現 ★

**(a)** 用你自己的環境重現 1.8.2 與 1.8.3 的實驗
  （提示：`docker run ... --innodb-buffer-pool-size=16M`）。
  你的數字跟課程的數字差多少？為什麼？

**(b)** 把 1.8.3 的實驗再做一次，但這次**在每種主鍵策略下都插入到 300 萬列**，
  每 50 萬列記錄一次累積耗時。畫出四條曲線。
  哪一條在什麼時候開始「翹起來」？那個轉折點跟 buffer pool 大小有什麼關係？

**(c)** 設計一個實驗，量出「六個二級索引」對**查詢**的影響
  （1.9.2 只量了寫入）。你要控制哪些變因？

**(d)** 1.4.2 的實驗顯示 MySQL 8 的 `TempTable` 引擎讓宣告長度不再有代價。
  設計一個實驗，找出「什麼情況下 `TempTable` 會失效、退回到磁碟」。
  （提示：`temptable_max_ram`、`Created_tmp_disk_tables`）

---

## 1.15 完成本章後，請確認你有

```
✅ 一份完整的 schema.sql，而且【真的跑過】
     ├─ 所有主鍵 BINARY(16) UUIDv7（或你有理由選的其他策略）
     ├─ 所有金額 DECIMAL(19,4)              ★ 沒有任何 FLOAT / DOUBLE
     ├─ 所有時間 DATETIME(3)                ★ 不是 DATETIME、不是 TIMESTAMP
     ├─ 所有布林 BOOLEAN + CHECK (col IN (0,1))
     ├─ 所有表名避開保留字（orders 不是 order）
     ├─ 所有欄位有 COMMENT
     └─ 軟刪除的唯一性用生成欄位，不是 (col, deleted_at)

✅ 一份「不變量 × 守在哪一層」的表（1.10.5 的格式）
     ├─ 每一條都標出是 NOT NULL / UNIQUE / CHECK / FK / 原子 UPDATE / 應用層
     └─ 資料庫守不住的那幾條，寫出它們為什麼守不住

✅ 一組 schema 的煙霧測試（1.12.1）
     └─ 每一條資料庫層的不變量，都有一個「故意違反它」的測試

✅ 一份 UuidV7.java（如果你選了 UUIDv7）
     └─ 而且測過：產生順序 == 位元組序、version=7、往返正確

✅ 你能回答這六個問題（不查資料）
     ├─ 為什麼 DOUBLE 也不能存金額？
     ├─ 為什麼 DATETIME 會讓日期跳到隔天？
     ├─ 為什麼 UNIQUE (email, deleted_at) 擋不住重複？
     ├─ 為什麼 UUID 主鍵「在我的機器上測起來沒差」？
     ├─ 為什麼 CHECK (qty >= 0) 擋不住超賣？
     └─ 為什麼 stock.qty 刻意不用 UNSIGNED？
```

---

## 1.16 本章的實驗環境與結果

**環境**（與 00 章相同，另加一個小記憶體實例）：

| 項目 | 版本 |
|---|---|
| JDK | Temurin **21.0.5** |
| JDBC 驅動 | **mysql-connector-j 8.3.0** |
| 資料庫 | **MySQL 8.0.46**（預設 buffer pool 128 MB） |
| 對照實例 | 同一個映像，`--innodb-buffer-pool-size=16M` |
| Docker | **29.1.3** |
| 平台 | macOS 14.2.1 / Apple Silicon |

**跑過的實驗（22 組）**：

| 組 | 實驗 | 結果 |
|---|---|---|
| **F1** | `ALTER` 的三種演算法 | ✅ `ADD COLUMN` INSTANT **16 ms**／`VARCHAR(20)→(63)` INPLACE ✅／**`(63)→(64)` 需要 COPY**（長度前綴 1→2 bytes）／**縮短永遠 COPY**／`INT→BIGINT` COPY／COPY 10 萬列 **572 ms** |
| **F2** | `FLOAT` 的有效位數 | 🔴 `1234567.89` → **`1234570`**；`12345678.9` → **`12345700`**；**`99999999` → `100000000`**；`f = 1234567.89` 為 **假** |
| **F3** | 1000 筆 19.99 累加 | 🔴 FLOAT **19989.999771118164**／DOUBLE **19990.000000000135**／DECIMAL **19990.00** ✅／BIGINT 分 ✅。**FLOAT 與 DOUBLE 的 `= 19990` 都是假** |
| **F4** | `DECIMAL` 的 scale | ✅ `10.00/3` → scale 6；`19.99 × 3 × 0.85` → **50.974500**；寫入 `DECIMAL(10,2)` 時 `0.615` → **`0.62`**（寫入當下就四捨五入） |
| **F5** | `UNSIGNED` 相減 | 🔴 **`SELECT qty - 5`（qty=3）直接 `ERROR 1690`**，與 `sql_mode` 嚴格度**無關**；要 `NO_UNSIGNED_SUBTRACTION` 才回 `-2` |
| **F6** | `CHAR` vs `VARCHAR` | ✅ `CHAR(10)` 存 `'abc  '` 讀出 `LENGTH=3`，`VARCHAR(10)` 是 **5**；`'abc'='abc  '` 在 `_0900_` 定序下為 **假** |
| **F7** | 宣告長度的代價 | ✅ **`TempTable`（MySQL 8 預設）：`VARCHAR(20)` 31 ms vs `VARCHAR(2000)` 31 ms —— 沒有差別**<br>🔴 **`MEMORY` 引擎：42 ms vs 174 ms（4.1 倍），且 `Created_tmp_disk_tables=4`** |
| **F8** | 一列的上限 | ✅ `VARCHAR(16383)` OK、`(16384)` → `ERROR 1074`；五個 `VARCHAR(16000)` → `ERROR 1118`；**八個 `TEXT` 沒問題**（行外儲存） |
| **F9** | `TEXT` 的行外儲存 | ✅ 500 列 × 60 KB = 31.5 MB；`COUNT(small_v)` **0.23 ms** vs `COUNT(big_t)` **2.06 ms（9 倍）** |
| **F10** | `ENUM` 的四個陷阱 | ✅ 排序按**宣告順序**（`st+0` = 1,2,3,4）；非嚴格模式下錯值 → **空字串、序號 0**；**加在最後 INSTANT ✅，插在中間 `ERROR 1846`** |
| **F11** | 狀態欄位三種存法 | ✅ 10 萬列**資料**大小三者相同（3.52 MB）；**索引**：`ENUM`/`TINYINT` 1.52 MB vs `VARCHAR(16)` **2.52 MB（大 67%）** |
| **F12** | 時間型別 | 🔴 **`DATETIME` 存 `23:59:59.6` → `2026-09-03 00:00:00`（日期跳隔天）**；`.5` 進位、`.4` 不進位（**四捨五入不是截斷**）；`TIMESTAMP` 上限 `2038-01-19 03:14:07`，+1 秒 `ERROR 1292`；**`DATETIME(3) DEFAULT CURRENT_TIMESTAMP`（沒有 `(3)`）→ `ERROR 1067`**；`UPDATE SET v=v`（值沒變）**不會**動 `ON UPDATE` 欄位 |
| **F13** | `BOOLEAN` | ✅ `BOOLEAN`/`BOOL`/`TINYINT(1)` 都是 `tinyint(1)`；**可以存 5**，而 `c = TRUE` 為 **0**、`c IS TRUE` 為 **1**；`TRUE+TRUE = 2` |
| **F14** | `NULL` 的三值邏輯 | ✅ `NULL=NULL` → **`NULL`**（不是假）；`2 NOT IN (1,NULL)` → **`NULL`**；`COUNT(*)=3` vs `COUNT(disc)=2`；`AVG` 分母是非 NULL 個數；`WHERE disc <> 5` **漏掉 NULL 那列**；`CONCAT` 遇 NULL 整個變 NULL；**唯一索引接受三個 NULL** |
| **F15** | 四種主鍵（大 pool） | ✅ 30 萬列：自增 3585 ms / 27.1 MB；UUIDv4 `CHAR(36)` **1.25x 時間、2.22x 空間**；UUIDv4 `BINARY(16)` 1.06x / 1.67x；**UUIDv7 `BINARY(16)` 0.94x / 1.33x** |
| **F16** | 四種主鍵（16 MB pool） | 🔴 60 萬列：自增 6317 ms；**UUIDv4 `CHAR(36)` 65351 ms（10.35x）**；UUIDv4 `BINARY(16)` 56993 ms（9.02x）；**UUIDv7 只有 7083 ms（1.12x）** |
| **F17** | `AUTO_INCREMENT` | ✅ `ROLLBACK` / `INSERT IGNORE` 衝突 / 多列插入中間衝突**都會製造洞**（id 序列 1,2,3,5,7,8,9）；**MySQL 8 重啟後計數器不退回**（DELETE 到 MAX=3 後重啟，新列拿到 id **10**） |
| **F18** | 索引的代價 | ✅ 空間：0 索引 7.5 MB → 1 個 11.0 MB（1.47x）→ 3 個 **20.1 MB（2.67x）**<br>寫入 30 萬列：0 個 3043 ms → 1 個 1.10x → 3 個 1.29x → **6 個 1.60x** |
| **F19** | 約束 | ✅ `CHECK` 在 8.0.46 上**真的生效**（`ERROR 3819`）；**`CHECK` 不能有子查詢或 `NOW()`（`ERROR 3814`）**；外鍵 `ERROR 1452`/`1451`；**外鍵欄位會被自動建索引** |
| **F20** | 軟刪除 + 唯一索引 | 🔴 **`UNIQUE (email, deleted_at)` 完全擋不住兩筆 `deleted_at IS NULL` 的重複**；同一秒第二次軟刪除 `ERROR 1062`<br>✅ 哨兵值與生成欄位**兩種修法都實測有效** |
| **F21** | 完整 schema | ✅ 7 張表建立成功；**8 條不變量探針全部被擋下**（1062 × 1、3819 × 6、1451 × 1）；軟刪除後可重新註冊，第三個未刪除的同名帳號被擋 |
| **F22** | `UuidV7.java` | ✅ 課程裡那份程式碼**編譯並執行過**：產生順序 == 位元組序（時間有序）、`version=7`、`variant=2`、`toBytes`/`fromBytes` 往返正確、長度檢查有效；對照 UUIDv4 的位元組序是隨機的 |

🔴 **本章沒有驗證到的**：

| 沒驗證的 | 影響哪一節 | 哪一章會補 |
|---|---|---|
| **大表 `ALTER` 的真實耗時**（只做了 10 萬列外推） | 1.2.2 | 06 章 6.7（`gh-ost`） |
| **`CHECK` 擋不住超賣的併發實測**（06 站已做過 H2 版） | 1.10.2、1.12.1 | **04 章** |
| **外鍵造成的跨表鎖等待** | 1.10.3 | 04 章 |
| **索引對【查詢】的影響**（只量了寫入與空間） | 1.9 | **03 章** |
| **`TempTable` 退回磁碟的觸發條件** | 1.4.2 | **05 章 5.7.3**（實測 `tmp_table_size` 4 MB → 128 MB，5.9 倍） |
| **UUIDv7 在千萬列規模的表現** | 1.8.3 | —（本章已在 300 萬列量過；05 章 5.2.5 給的是「熱資料集 vs buffer pool」的通用判斷法） |
| **`ENUM` 插在中間的 `ALTER` 實際耗時** | 1.4.4 | 06 章 |
| **多幣別（JPY 0 位、KWD 3 位）的實際處理** | 1.3.8 | 12-capstone |

> 📌 **最後一句話**：
>
> 這一章有**四個實測結果，跟「大家都這樣說」不一樣**：
>
> **①「`VARCHAR(255)` 有代價」** ——
> F7 顯示在 MySQL 8 的預設 `TempTable` 引擎上**完全沒有差別**（31 ms vs 31 ms）。
> 那個「傳統答案」不是錯的，它是**過期的** ——
> 而換成 `MEMORY` 引擎，4.1 倍的差距立刻回來。
> **技術傳說的保存期限，比技術本身短。**
>
> **②「UUID 主鍵比較慢」** ——
> F15 顯示在資料放得進 buffer pool 時，UUIDv7 甚至**比自增快 6%**。
> F16 顯示同樣的實驗換一個記憶體設定，UUIDv4 慢 **10.35 倍**而 UUIDv7 只慢 **1.12 倍**。
> **代價來自「隨機」，不是來自「UUID」；而它只在特定條件下現形。**
>
> **③「加約束就安全了」** ——
> F20 顯示那個到處都看得到的 `UNIQUE (email, deleted_at)`，
> **一筆重複都擋不住**。它看起來很合理、它出現在無數生產環境裡、它什麼都沒守住。
>
> **④「`DATETIME` 就是 `DATETIME`」** ——
> F12 顯示不寫 `(3)` 時，`23:59:59.6` 會變成**隔天的 `00:00:00`**。
> 一天 86400 秒裡有 0.5 秒會觸發它 —— **頻率剛好低到查不出規律，高到財務每個月都會問。**
>
> ⚠️ **這四個有一個共同點**：
> **它們都不會在你建表的那一天出事。**
> 它們會在資料量長大、在版本升級、在有人做了一次軟刪除、在某個晚上 23:59:59.6 出事 ——
> 而那時候，`ALTER TABLE` 已經是 1.2.2 那個「唯讀 10 分鐘」的變更了。
>
> **下一章開始寫查詢。** 02 章會處理 JOIN、`GROUP BY`、子查詢與視窗函式 ——
> 而它的第一個實測會問：**「`LEFT JOIN` 之後在 `WHERE` 裡加一個條件，
> 為什麼它就變回 `INNER JOIN` 了？」**

---

**上一章**：[00-course-map-install-and-connect.md](./00-course-map-install-and-connect.md) — 課程地圖、環境與連線
**下一章**：[02-sql-crud-join-and-aggregate.md](./02-sql-crud-join-and-aggregate.md) — SQL 核心：JOIN 與聚合
