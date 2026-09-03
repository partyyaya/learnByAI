# 第 04 章：交易、隔離與鎖

> 03 章結尾留了兩個問題：
>
> > **「20 個人怎麼搶到 10 個庫存，而 `CHECK (qty >= 0)` 一次都沒觸發？」**
> > **「這些索引，在有併發寫入的時候，鎖住的到底是『那一列』還是『那一段』？」**
>
> 這一章要回答它們。而在回答之前，先看一個數字。
>
> 一張表、一列資料、`qty = 10`。20 個執行緒同時執行下面這段再標準不過的程式碼：
>
> ```java
> int qty = jdbc.queryForObject("SELECT qty FROM stock WHERE product_id = 1", Integer.class);
> if (qty <= 0) return false;
> jdbc.update("UPDATE stock SET qty = ? WHERE product_id = 1", qty - 1);
> ```
>
> 資料表上有 `CONSTRAINT ck_stock_qty CHECK (qty >= 0)`。
> 交易是 `REPEATABLE READ`。每一筆都在 `@Transactional` 裡。
>
> 實測結果：
>
> ```
> 成功 = 20    剩餘 = 9    超賣 = 19 個    CHECK 觸發 = 0 次    耗時 = 116 ms
> ```
>
> **20 個人都拿到了貨。庫存從 10 變成 9。**
> **沒有例外、沒有錯誤日誌、沒有任何一個約束被觸發。**
>
> ⚠️ **這一章與前三章有一個關鍵差別**：
>
> ```
> 01 章的錯 → 資料是錯的（型別、約束）      → 一插進去就看得到
> 02 章的錯 → 答案是錯的（JOIN、NULL、聚合） → 對一次資料就看得到
> 03 章的錯 → 答案是對的，只是慢了三個數量級 → 資料長大才看得到
> 04 章的錯 → 【只有兩個人同時做同一件事的那一瞬間】才存在
> ```
>
> **而那一瞬間，在你的開發機上永遠不會發生。**
> 單元測試不會、Postman 不會、QA 手動點也不會。
> 它只在促銷開始的第一秒、在對帳日的批次跑完的那一刻、
> 在你上線三個月之後某天財務跑來問「為什麼庫存是負的」的時候發生。
>
> 📌 **所以這一章的主軸不是「怎麼加鎖」，而是**：
>
> > **怎麼在寫完程式碼的當下，就知道它在兩個人同時打的時候會不會壞。**
>
> 而那個工具，是**把兩個 session 排在同一張時間軸上跑一次**。
> 本章的每一個實測都是這樣做出來的 —— 而且你可以自己重跑。

---

## 4.1 學習目標

完成本章後，你應該可以：

- 說出 ACID 四個字母**各自由誰保證**，並解釋為什麼 C（一致性）其實是**你的責任**而不是資料庫的。
- 用實測說明「**一句 SQL 失敗**」和「**整個交易回滾**」是兩件事 —— 以及這個差別怎麼讓你 `COMMIT` 出半個交易。
- 說出交易是**什麼時候真的開始**的，以及哪些語句會**隱式提交**你正在跑的交易。
- 量化持久性的價格：`innodb_flush_log_at_trx_commit` 與 `sync_binlog` 的四種組合，實測 **2691 → 9610 TPS（3.6 倍）**。
- 畫出 InnoDB 的**版本鏈**（`DB_TRX_ID` / `DB_ROLL_PTR` / undo log），並用 **ReadView 的四個欄位**判斷一列對某個交易可不可見。
- 說明 RR 與 RC 的差別**只在於什麼時候建立 ReadView**，並用實測驗證「ReadView 是在**第一次讀**的時候建的，不是 `BEGIN` 的時候」。
- 分辨**快照讀**與**當前讀**，並解釋為什麼 `SELECT` 說 1000、下一句 `UPDATE ... balance + 1` 卻算出 1501。
- 量化長交易的代價：實測同一句 `SELECT` 從 **6.4 ms 變成 127.4 ms（20 倍）**，而旁邊的新交易只要 **2.6 ms（49 倍差距）**。
- 實測**四種隔離級別**擋得住與擋不住的五種異常，包含 **RR 擋不住的寫偏斜**（實測總和從 2000 掉到 400）。
- 讀懂 `performance_schema.data_locks`，並認出 **`X` / `X,REC_NOT_GAP` / `X,GAP` / `X,GAP,INSERT_INTENTION`** 四種 `LOCK_MODE` 的差別。
- 用**七組實測**說出「等值命中 / 等值不命中 / 範圍 / 非唯一索引 / 唯一索引 / 無索引」各自鎖住什麼。
- 回答 03 章的問題：**沒有索引的 `UPDATE` 會鎖住整張表**，實測併發吞吐量從 **1758 掉到 162 TPS（10.8 倍）**。
- 說明 **MDL（中繼資料鎖）** 為什麼能讓一個「只是忘了 commit 的 `SELECT`」癱瘓整張表 —— 含實測的三層阻塞鏈。
- 讀懂 `SHOW ENGINE INNODB STATUS` 的**死鎖區段**，逐行解釋每一個欄位。
- 認出**五種常見死鎖模式**，並說出各自的修法。
- 解釋 **`1205`（逾時）和 `1213`（死鎖）的行為完全不同** —— 以及為什麼前者比後者危險。
- 說出 `@Transactional` 的**八個坑**，每一個都有實測輸出。
- 在**原子 UPDATE / 悲觀鎖 / 樂觀鎖**之間做出有理由的選擇（實測六種寫法）。
- 說明為什麼「交易裡呼叫外部 API」會讓 **20% 的請求連資料庫都連不上**（實測 `CannotCreateTransactionException` × 8）。
- 交出 shop-service 的交易邊界設計與一組可以放進 CI 的併發守門測試。

---

## 4.2 交易：ACID 的四個字母，各自由誰負責

### 4.2.1 先把實驗環境搭起來

本章所有實測都跑在這個 schema 上。**請你自己也建一份** —— 這一章的東西用讀的看不出來。

```sql
CREATE DATABASE shop5 CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE shop5;

-- 帳戶：轉帳 / ACID / 樂觀鎖悲觀鎖
CREATE TABLE acct (
  id      INT PRIMARY KEY,
  owner   VARCHAR(16) NOT NULL,
  balance DECIMAL(19,4) NOT NULL,
  version BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT ck_acct_bal CHECK (balance >= 0)
) ENGINE=InnoDB;
INSERT INTO acct VALUES (1,'Alice',1000,0),(2,'Bob',1000,0),(3,'Carol',1000,0);

-- 加鎖範圍實驗表：id 刻意留間隔，方便觀察「間隙」
CREATE TABLE lk (
  id     INT PRIMARY KEY,
  c      INT NOT NULL,         -- 二級【非唯一】索引
  u      INT NOT NULL,         -- 二級【唯一】索引
  d      INT NOT NULL,         -- 【沒有】索引
  KEY k_c (c),
  UNIQUE KEY uk_u (u)
) ENGINE=InnoDB;
INSERT INTO lk VALUES (5,50,500,5000),(10,100,1000,10000),(15,150,1500,15000),
                      (20,200,2000,20000),(25,250,2500,25000);

-- 庫存：搶購
CREATE TABLE stock (
  product_id INT PRIMARY KEY,
  qty        INT NOT NULL,
  version    BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT ck_stock_qty CHECK (qty >= 0)
) ENGINE=InnoDB;
INSERT INTO stock VALUES (1,10,0);
```

再建一個**看鎖用的視圖**，後面會用幾十次：

```sql
CREATE VIEW locks_now AS
SELECT t.PROCESSLIST_ID           AS conn,
       dl.ENGINE_TRANSACTION_ID   AS trx,
       dl.OBJECT_NAME             AS tbl,
       IFNULL(dl.INDEX_NAME,'-')  AS idx,
       dl.LOCK_TYPE               AS typ,
       dl.LOCK_MODE               AS mode,
       dl.LOCK_STATUS             AS status,
       IFNULL(dl.LOCK_DATA,'-')   AS data
FROM performance_schema.data_locks dl
JOIN performance_schema.threads t USING (THREAD_ID)
WHERE dl.OBJECT_SCHEMA = 'shop5';
```

⚠️ **這個視圖有一個陷阱，4.5.11 會回來處理**：
`conn` 這一欄（來自 `THREAD_ID`）**有時候會騙你**，`trx` 那一欄才是真的。

📌 **本章的實測輸出為了版面，有時會略掉 `trx` 或 `status` 欄**；
需要區分「誰持有」的地方一定會把 `trx` 印出來。

**本章的表記法**：`A>` `B>` `M>` 代表三個不同的連線。
`A!` 代表「送出這一句，但它會被擋住，先不等它」。

### 4.2.2 A：原子性 —— 但「語句失敗」不等於「交易回滾」★★

先看教科書版本。A 要從 Alice 轉 300 給 Bob，但中途違反了 `CHECK`：

```
A> BEGIN
A> UPDATE acct SET balance = balance - 300 WHERE id = 1
   OK, 1 rows affected

A> SELECT id, owner, balance FROM acct WHERE id IN (1,2)
   +----+-------+-----------+
   | 1  | Alice | 700.0000  |     ← 已經扣了
   | 2  | Bob   | 1000.0000 |
   +----+-------+-----------+

A> UPDATE acct SET balance = balance - 99999 WHERE id = 2
   🔴 ERROR 3819 (HY000): Check constraint 'ck_acct_bal' is violated.
```

**這裡是分岔點。** 大多數人會以為：既然報錯了，交易就死了。
我們看一下：

```
A> SELECT id, owner, balance FROM acct WHERE id IN (1,2)
   +----+-------+-----------+
   | 1  | Alice | 700.0000  |     ← 🔴 還在！
   | 2  | Bob   | 1000.0000 |
   +----+-------+-----------+
```

🔴 **`ERROR 3819` 只回滾了【那一句】，交易還活著，前一句的 700 還在。**

如果這時候有人（或某段 `catch` 之後照常往下走的程式碼）下了 `COMMIT`：

> **Alice 的 300 塊就這樣憑空消失了。**

正確的收尾是明確地 `ROLLBACK`：

```
A> ROLLBACK
A> SELECT id, owner, balance FROM acct WHERE id IN (1,2)
   +----+-------+-----------+
   | 1  | Alice | 1000.0000 |     ✅ 回來了
   | 2  | Bob   | 1000.0000 |
   +----+-------+-----------+
```

📌 **記住這條分界線，本章會回來三次**：

```
語句失敗（3819 CHECK / 1062 重複鍵 / 1205 鎖逾時）
    → 只回滾【那一句】，交易還活著，還在持有它已經拿到的鎖

交易失敗（1213 死鎖 / 連線斷 / 明確 ROLLBACK）
    → 整個交易被丟掉，鎖全部釋放
```

⚠️ **這正是 Spring 的 `@Transactional` 為什麼會出事**：
你在 service 裡 `catch (DataAccessException e) { log.warn(...); }`，
Spring 不知道出過事，交易照常 commit —— 4.7.1 的 P1 會實測給你看。

### 4.2.3 C：一致性是【你】的責任

四個字母裡，只有 C 不是資料庫幫你做的。

| 字母 | 誰保證 | 靠什麼機制 |
|---|---|---|
| **A** 原子性 | InnoDB | **undo log**（要回滾就照著 undo 反著做一遍） |
| **C** 一致性 | 🔴 **你** | 約束（01 章）+ **正確的交易邊界**（本章） |
| **I** 隔離性 | InnoDB | **MVCC + 鎖**（本章 4.3 / 4.5） |
| **D** 持久性 | InnoDB | **redo log + WAL**（4.2.5 有它的價格） |

📌 **「一致性」指的是【業務規則】不被破壞**，例如：

- 轉帳前後，兩個帳戶的總和不變。
- 庫存扣掉的數量，等於訂單明細的數量總和。
- 一張訂單的 `total_amount`，等於它所有明細的金額加總。

**這些規則資料庫一個都不知道。**
你可以用 `CHECK`（01 章）表達其中一小部分，
但像「轉帳前後總和不變」這種**跨列**的規則，`CHECK` 表達不了 ——
它只能靠「把這兩個 `UPDATE` 放進同一個交易」來達成。

而 4.4.5 會給你看：**就算放進同一個交易，在 `REPEATABLE READ` 下它還是會壞掉。**

### 4.2.4 I：隔離性 —— 本章其餘部分都在講它

一句話：**隔離性就是「別人做到一半的東西，我看得到多少」。**

```
完全不隔離  →  最快    →  但你會讀到別人等一下要回滾的資料
完全隔離    →  最正確  →  但所有交易只能排隊，一次跑一個
```

SQL 標準把中間切成四格（`READ UNCOMMITTED` / `READ COMMITTED` / `REPEATABLE READ` / `SERIALIZABLE`），
MySQL 的預設是 **`REPEATABLE READ`** —— 這在主流資料庫裡是**少數派**
（PostgreSQL、Oracle、SQL Server 預設都是 `READ COMMITTED`）。

4.4.8 會討論這個預設值該不該改。

### 4.2.5 D：持久性的價格（實測）

`COMMIT` 回來的那一刻，資料真的落到磁碟了嗎？取決於兩個參數：

| 參數 | 值 | 意思 |
|---|---|---|
| `innodb_flush_log_at_trx_commit` | **1**（預設） | 每次 commit 都把 redo log **寫檔 + fsync** |
| | 2 | 每次 commit **寫檔**，但每秒才 fsync 一次 |
| | 0 | 每秒才寫檔 + fsync（commit 完全不碰磁碟） |
| `sync_binlog` | **1**（預設） | 每次 commit 都 fsync binlog |
| | 0 | 交給作業系統決定什麼時候刷 |

**實測**：4 個執行緒，每個 500 筆 `INSERT`（一筆一個交易），共 2000 筆。

```
flush_log_at_trx_commit=1  sync_binlog=1      743 ms     2691 TPS   ← 預設
flush_log_at_trx_commit=1  sync_binlog=0      484 ms     4128 TPS   ← 1.5 倍
flush_log_at_trx_commit=2  sync_binlog=0      232 ms     8612 TPS   ← 3.2 倍
flush_log_at_trx_commit=0  sync_binlog=0      208 ms     9610 TPS   ← 3.6 倍
```

**這 3.6 倍買的是什麼？**

| 設定 | 主機當掉（作業系統崩潰 / 斷電） | MySQL 行程被 kill |
|---|---|---|
| `1` + `1` | ✅ **一筆都不會掉** | ✅ 一筆都不會掉 |
| `1` + `0` | 🟡 資料在，但 **binlog 可能少最後幾筆** → 從庫會跟主庫不一致 | ✅ 不會掉 |
| `2` + `0` | 🔴 **最多掉 1 秒**的交易 | ✅ 不會掉（資料已在 OS page cache） |
| `0` + `0` | 🔴 **最多掉 1 秒** | 🔴 **最多掉 1 秒** |

📌 **怎麼選**：

```
金流、訂單、任何「掉了要賠錢」的資料 → 1 + 1，不要動它
日誌、埋點、可以重跑的批次匯入        → 2 + 0 可以考慮
測試環境 / 一次性的資料載入            → 0 + 0，跑完再改回來
```

⚠️ **這兩個參數是 `GLOBAL` 的，改了影響整台機器上的所有資料庫。**
想只加速一次匯入，正確做法是 4.2.8 的「一個交易包多筆」，不是改這個。

### 4.2.6 交易是什麼時候真的「開始」的

```
A> SELECT COUNT(*) AS trx_cnt FROM information_schema.innodb_trx
   0

A> BEGIN
A> SELECT COUNT(*) AS trx_cnt_after_begin FROM information_schema.innodb_trx
   0                                        ← 🔴 BEGIN 之後還是 0
```

`BEGIN` **不會**在 InnoDB 裡開一個交易，它只是把 session 標記成「接下來別自動提交」。
真正的交易是在**第一次碰到資料**的時候才開的。

從另一個 session 觀察就看得清楚：

```
A> BEGIN
A> SELECT balance FROM acct WHERE id = 1     ← 第一次讀

M> SELECT trx_id, trx_state, trx_isolation_level FROM information_schema.innodb_trx
   +-----------------+-----------+-----------------+
   | 562947581611224 | RUNNING   | REPEATABLE READ |    ← 出現了
   +-----------------+-----------+-----------------+
```

⚠️ **注意那個 `trx_id` 有 15 位數。** 這是 InnoDB 的**唯讀交易**：
它還沒寫過任何東西，所以拿到的是一個**臨時的假 ID**（用記憶體位址湊出來的），
不佔用真正的交易 ID 序號。等它第一次執行 `UPDATE` / `INSERT` / `DELETE`
或 `SELECT ... FOR UPDATE`，才會拿到一個像 `7735` 這樣的**真 ID**。

🔴 **而這裡有一個實測出來、文件上不會寫的行為**：

```
A> BEGIN
A> INSERT INTO lk VALUES (18,180,1800,18000)
A> SELECT trx_id FROM information_schema.innodb_trx WHERE trx_mysql_thread_id = CONNECTION_ID()
   (0 rows)                                 ← 🔴 A 看不到自己

M> SELECT trx_id, trx_mysql_thread_id AS conn, trx_state FROM information_schema.innodb_trx
   +--------+------+-----------+
   | 7735   | 453  | RUNNING   |            ← 但 M 看得到 A
   +--------+------+-----------+
```

📌 **`information_schema.innodb_trx` 查不到你自己的交易。**
排查的時候一定要**開另一條連線**看，不然你會以為「明明沒有交易在跑」。

### 4.2.7 隱式提交：DDL 會把你的交易切一半 ★

```
A> BEGIN
A> UPDATE acct SET balance = 1 WHERE id = 3       -- Carol 的錢從 1000 變 1
A> CREATE TABLE ddl_probe (i INT)                 -- 隨手建個暫存表
A> ROLLBACK
A> SELECT id, owner, balance FROM acct WHERE id = 3
   +----+-------+---------+
   | 3  | Carol | 1.0000  |                       ← 🔴 沒有回滾！
   +----+-------+---------+
```

**`CREATE TABLE` 觸發了隱式提交。**
在它執行之前，MySQL 先把當前交易 `COMMIT` 掉了 —— 所以 `ROLLBACK` 已經沒東西可回滾。

⚠️ **會觸發隱式提交的常見語句**：

```
DDL：CREATE / ALTER / DROP / RENAME / TRUNCATE（TABLE、INDEX、DATABASE、VIEW…）
權限：GRANT / REVOKE / SET PASSWORD / CREATE USER / DROP USER
交易：BEGIN / START TRANSACTION（會先提交上一個！）
其他：LOCK TABLES / UNLOCK TABLES / LOAD DATA / ANALYZE / OPTIMIZE / REPAIR
```

📌 **最常踩到的兩個場景**：

1. **`TRUNCATE` 不是 `DELETE`**。
   在交易裡寫 `TRUNCATE t` 想著「反正等一下會 rollback」—— 資料已經沒了。
   要能回滾就用 `DELETE FROM t`。
2. **遷移腳本混了 DML 和 DDL**（06 章 Flyway 會再講一次）。
   `ALTER TABLE ... ; UPDATE ... ; ALTER TABLE ...` 中間那個 `UPDATE`
   會被兩邊的 DDL 各自提交一次，**沒有任何一段是原子的**。

### 4.2.8 一個交易包 500 筆，vs 500 個交易

```
500 個交易（每筆各自 commit）    500 筆    483 ms    →  1035 筆/秒
1 個交易包 500 筆（executeBatch） 500 筆     76 ms    →  6579 筆/秒（6.4 倍）
```

原因就是 4.2.5 那張表：**每一次 `COMMIT` 都要 fsync 兩次**（redo + binlog）。
500 個交易就是 1000 次 fsync；一個交易只有 2 次。

⚠️ **但別無限放大。** 一個交易包 100 萬筆會有四個後果：

```
① undo log 撐爆 → 4.3.8 會量給你看它讓別人的查詢慢多少
② 鎖持有時間變成整段匯入的長度 → 別人全部卡住
③ 失敗要回滾 100 萬筆，回滾時間【比寫入還久】
④ binlog 單一事件過大，從庫延遲爆炸（07 章）
```

📌 **經驗值：每個交易 500 ～ 5000 筆，中間 commit 一次。**

---
## 4.3 MVCC：讀為什麼不會被寫擋住

### 4.3.1 每一列其實有三個隱藏欄位

你 `CREATE TABLE` 寫了 4 個欄位，InnoDB 實際上存了 7 個：

```
┌──────────┬──────────────┬──────────────┬──────┬──────┬──────┬──────┐
│ DB_ROW_ID│  DB_TRX_ID   │ DB_ROLL_PTR  │  id  │  c   │  u   │  d   │
│  6 bytes │   6 bytes    │   7 bytes    │      │      │      │      │
└──────────┴──────────────┴──────────────┴──────┴──────┴──────┴──────┘
      ↑            ↑              ↑
      │            │              └─ 指向 undo log 裡的【上一個版本】
      │            └──────────────── 最後一次修改這一列的【交易 ID】
      └───────────────────────────── 沒有主鍵時自動生成的隱藏主鍵（有主鍵就沒有它）
```

📌 **03 章 3.4.3 算 `key_len` 的時候，這三個欄位不算在裡面** ——
但它們**佔的是實體空間**。這就是 01 章實測「`pk_auto` 300 萬列佔 17.5 MB」
比你手算的欄位大小還大的一部分原因。

### 4.3.2 undo log 與版本鏈

假設一列 `balance` 被三個交易先後改過：

```
                                        undo log（回滾段）
  聚簇索引裡的【最新版】                   ┌────────────────────┐
┌───────────┬──────────┬────┐            │ trx 100            │
│ trx_id=102│ roll_ptr │2000│ ─────────► │ balance = 1500     │
└───────────┴──────────┴────┘            │ roll_ptr ──────────┼──┐
   ↑ 表裡實際存的只有這一列                └────────────────────┘  │
                                         ┌────────────────────┐  │
                                         │ trx 98             │ ◄┘
                                         │ balance = 1000     │
                                         │ roll_ptr = NULL    │
                                         └────────────────────┘
```

**兩個用途，一個結構**：

| 用途 | 怎麼用 |
|---|---|
| **回滾（A）** | 交易失敗 → 照著 undo 把值寫回去 |
| **MVCC 讀（I）** | 讀到的版本太新 → 沿著 `roll_ptr` 往回走，直到找到「我看得到」的那一版 |

⚠️ **所以 undo log 不能在交易 commit 之後馬上刪** ——
只要還有任何一個交易的快照可能需要某個舊版本，它就得留著。
**這就是長交易為什麼危險**（4.3.8 會量給你看）。

### 4.3.3 ReadView：四個欄位決定「我看得到哪一版」

一個交易第一次做**快照讀**的時候，InnoDB 幫它拍一張「當下有誰還沒 commit」的照片：

```
ReadView {
  m_ids        : [ 102, 105, 107 ]   ← 建立此刻【還在跑】的交易 ID 清單
  min_trx_id   : 102                 ← m_ids 裡最小的
  max_trx_id   : 108                 ← 下一個【即將分配】的交易 ID
  creator_trx_id : 106               ← 我自己的交易 ID
}
```

**可見性演算法**（拿到一列，看它的 `DB_TRX_ID`，簡稱 `trx_id`）：

```
① trx_id == creator_trx_id     → ✅ 看得到  （這是我自己改的）
② trx_id <  min_trx_id         → ✅ 看得到  （我建 ReadView 之前就 commit 了）
③ trx_id >= max_trx_id         → ❌ 看不到  （我建 ReadView 之後才開始的交易）
④ min_trx_id <= trx_id < max_trx_id：
       trx_id 在 m_ids 裡       → ❌ 看不到  （建 ReadView 那一刻它還沒 commit）
       trx_id 不在 m_ids 裡     → ✅ 看得到  （已經 commit 了）

看不到 → 沿著 roll_ptr 走到上一版，重新跑一次 ①～④
一路走到 roll_ptr = NULL 都不可見 → 這一列對我來說【不存在】
```

📌 **用上面的例子套一次**（`creator_trx_id = 106`）：

| 這一列的 `trx_id` | 判斷 | 結果 |
|---|---|---|
| `98` | `98 < 102` → 規則② | ✅ 看得到 |
| `102` | 在 `m_ids` 裡 → 規則④ | ❌ 往前找 |
| `106` | `= creator_trx_id` → 規則① | ✅ 看得到（自己改的） |
| `109` | `109 >= 108` → 規則③ | ❌ 往前找 |

### 4.3.4 RR 與 RC 的差別，只在「什麼時候建 ReadView」★★

```
READ COMMITTED    →  【每一句】快照讀，都重新建一個 ReadView
REPEATABLE READ   →  整個交易【只在第一次】快照讀時建一個，之後一直用它
```

**就這樣。整個 RR / RC 的差別就是這一句話。**
其他所有現象（不可重複讀、幻讀）都是它的推論。

實測 —— **完全一樣的劇本，只換隔離級別**：

```
【READ COMMITTED】
A> BEGIN
A> SELECT balance AS read1 FROM acct WHERE id = 1      →  1000.0000
B> UPDATE acct SET balance = 1500 WHERE id = 1         （B 是 autocommit，馬上 commit）
A> SELECT balance AS read2 FROM acct WHERE id = 1      →  1500.0000   🔴 變了
A> COMMIT

【REPEATABLE READ】
A> BEGIN
A> SELECT balance AS read1 FROM acct WHERE id = 1      →  1500.0000
B> UPDATE acct SET balance = 1000 WHERE id = 1
A> SELECT balance AS read2 FROM acct WHERE id = 1      →  1500.0000   ✅ 沒變
A> COMMIT
A> SELECT balance AS read3 FROM acct WHERE id = 1      →  1000.0000   （交易結束才看到新值）
```

### 4.3.5 實測：ReadView 是在第一次【讀】的時候建立，不是 `BEGIN`

這是一個很多人以為自己知道、但其實搞反的細節。

```
起始值 balance = 1000

A> BEGIN                                       ← ⚠️ 這裡【還沒有】 ReadView
B> UPDATE acct SET balance = 2000 WHERE id = 1 （已 commit）

A> SELECT balance FROM acct WHERE id = 1
   → 2000.0000     🔴 A 看到了 BEGIN 【之後】才 commit 的資料！

B> UPDATE acct SET balance = 3000 WHERE id = 1 （已 commit）
A> SELECT balance FROM acct WHERE id = 1
   → 2000.0000     ✅ 這次才「重複讀」得到
A> COMMIT
```

📌 **`BEGIN` 不建立快照，第一句 `SELECT` 才建立。**
中間這段空窗期，別人 commit 的東西你**看得到**。

想在 `BEGIN` 的那一刻就凍結，要用另一個語法：

```
A> START TRANSACTION WITH CONSISTENT SNAPSHOT     ← 立刻建 ReadView
B> UPDATE acct SET balance = 4000 WHERE id = 1   （已 commit）
A> SELECT balance FROM acct WHERE id = 1
   → 3000.0000     ✅ 看到的是 START TRANSACTION 那一刻的值
A> COMMIT
A> SELECT balance FROM acct WHERE id = 1
   → 4000.0000
```

⚠️ **`WITH CONSISTENT SNAPSHOT` 只在 `REPEATABLE READ` 有意義。**
在 `READ COMMITTED` 下它**語法會過、但被靜默忽略**，只留一個警告：

```
A> SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED
A> START TRANSACTION WITH CONSISTENT SNAPSHOT
A> SHOW WARNINGS
   +---------+------+---------------------------------------------------------------+
   | Warning | 138  | InnoDB: WITH CONSISTENT SNAPSHOT was ignored because this      |
   |         |      | phrase can only be used with REPEATABLE READ isolation level.  |
   +---------+------+---------------------------------------------------------------+
```

🔴 **又一個「只有警告、查詢照跑」的靜默失敗** ——
和 03 章 3.9.3 的索引提示是同一類問題。

### 4.3.6 快照讀 vs 當前讀 ★★

MVCC 只服務**快照讀**。有一整類語句它管不到：

| 類型 | 語句 | 讀到什麼 |
|---|---|---|
| **快照讀** | 普通 `SELECT` | ReadView 決定的**歷史版本**，**不加鎖** |
| **當前讀** | `SELECT ... FOR UPDATE` | **最新已提交版本**，加 **X 鎖** |
| | `SELECT ... FOR SHARE`（`LOCK IN SHARE MODE`） | 最新版本，加 **S 鎖** |
| | `UPDATE` / `DELETE` | 最新版本，加 **X 鎖** |
| | `INSERT` | —（但會加插入意向鎖，見 4.5.10） |

**同一個交易裡，兩種讀會給你兩個不同的答案**：

```
A> BEGIN
A> SELECT balance FROM acct WHERE id = 1                        →  4000.0000  （快照）
B> UPDATE acct SET balance = 5000 WHERE id = 1                 （已 commit）
A> SELECT balance FROM acct WHERE id = 1                        →  4000.0000  （快照，沒變）
A> SELECT balance FROM acct WHERE id = 1 LOCK IN SHARE MODE     →  5000.0000  🔴 當前讀
A> SELECT balance FROM acct WHERE id = 1 FOR UPDATE             →  5000.0000  🔴 當前讀
A> COMMIT
```

🔴 **而下面這個，是本章最重要的一個實測**：

```
起始值 balance = 1000

A> BEGIN
A> SELECT balance FROM acct WHERE id = 1        →  1000.0000     ← A 以為是 1000
B> UPDATE acct SET balance = balance + 500 WHERE id = 1          （已 commit → 1500）

A> UPDATE acct SET balance = balance + 1 WHERE id = 1
A> SELECT balance FROM acct WHERE id = 1        →  1501.0000     🔴 不是 1001！
A> COMMIT
A> SELECT balance FROM acct WHERE id = 1        →  1501.0000
```

📌 **`UPDATE ... SET balance = balance + 1` 裡的那個 `balance`，是【當前讀】。**
它讀的是 1500，不是 A 的快照 1000。

⚠️ **這個行為本身是【好事】** —— 它讓 `UPDATE x = x + 1` 這種寫法在併發下是安全的。
**危險的是「一半快照一半當前」**：

```java
// 🔴 錯：讀是快照（1000），寫是絕對值 → 把 B 的 +500 直接蓋掉
int qty = jdbc.queryForObject("SELECT qty FROM stock WHERE product_id=1", Integer.class);
jdbc.update("UPDATE stock SET qty = ? WHERE product_id=1", qty - 1);

// ✅ 對：讀寫都在同一句裡，全是當前讀
jdbc.update("UPDATE stock SET qty = qty - 1 WHERE product_id=1 AND qty >= 1");
```

**開場那個「20 個人搶到 20 份庫存」，原因就是上面那個 🔴。**
4.7.2 會把六種寫法全部量一遍。

### 4.3.7 一個更微妙的：自己改過的列會「憑空出現」

```
lk 表原本有 5 列（id = 5,10,15,20,25）

A> BEGIN
A> SELECT COUNT(*) FROM lk WHERE id BETWEEN 1 AND 30        →  5     （快照）
B> INSERT INTO lk VALUES (13,130,1300,13000)                （已 commit）
A> SELECT COUNT(*) FROM lk WHERE id BETWEEN 1 AND 30        →  5     ✅ 沒有幻讀

A> UPDATE lk SET d = d + 1 WHERE id BETWEEN 1 AND 30
   OK, 6 rows affected                                       🔴 改到 6 列！

A> SELECT COUNT(*) FROM lk WHERE id BETWEEN 1 AND 30        →  6     🔴 現在看得到了
A> SELECT id, d FROM lk WHERE id BETWEEN 1 AND 30
   +----+-------+
   | 5  | 5001  |
   | 10 | 10001 |
   | 13 | 13001 |    ← 這一列，A 兩秒前還宣稱它不存在
   | 15 | 15001 |
   ...
```

📌 **為什麼？** 回到 4.3.3 的規則①：
`UPDATE` 是當前讀，它改到了 id=13；改完之後那一列的 `DB_TRX_ID` **變成 A 自己**，
於是規則①「這是我自己改的」讓它變成可見。

⚠️ **這叫「半幻讀」。** 它不是 bug，是 MVCC + 當前讀混用的必然結果。
**實務上的意義**：任何「先 `SELECT COUNT(*)` 判斷、再 `UPDATE`」的邏輯，
兩個數字可能對不上。要嘛全部用當前讀（`FOR UPDATE`），要嘛不要依賴那個 count。

### 4.3.8 長交易的代價：同一句 SELECT 從 6.4 ms 變 127 ms ★★

前面說「undo 不能馬上刪」。這一節量它。

**實驗**：`seat` 表 20000 列。
A 開一個 `START TRANSACTION WITH CONSISTENT SNAPSHOT` 之後**什麼都不做**，
B 在旁邊反覆 `UPDATE seat SET taken_by = ? WHERE id <= 20000`（每輪改 20000 列）。
每隔幾輪，讓 **A 重跑同一句 `SELECT COUNT(*) FROM seat WHERE taken_by IS NULL`**。

```
輪次   B 累計改了幾列   A 看到的   A 的 SELECT   history_len
0      -                20000      6.4 ms        0
1      20000            20000      12.9 ms       1
4      80000            20000      35.5 ms       4
8      160000           20000      54.5 ms       8
12     240000           20000      79.3 ms       12
16     320000           20000      102.3 ms      16
20     400000           20000      127.4 ms      20

對照：一個【全新】的交易讀同一張表 → 2.6 ms
```

🔴 **A 的查詢慢了 20 倍（6.4 → 127.4 ms），而它一個字都沒改。**
🔴 **同一時刻，旁邊的新交易只要 2.6 ms —— 差距 49 倍。**

**原因**：A 的 ReadView 停在第 0 輪。它每讀一列，都得沿著 `roll_ptr`
往回走 20 個版本才找得到「A 看得到的那一版」。
B 改得越多，A 每一列要走的鏈就越長。

⚠️ **而受害的不只是 A**：

```
A 的快照活著
    ↓
purge 執行緒不能回收那 400000 個舊版本
    ↓
undo 表空間持續長大（history list length 一路往上）
    ↓
【所有】掃到這些列的查詢都變慢，不只是 A
    ↓
極端情況：undo 表空間長到磁碟滿
```

### 4.3.9 怎麼抓長交易

**① 找出跑最久的交易**：

```sql
SELECT trx_id,
       trx_state,
       trx_started,
       TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS age_sec,
       trx_mysql_thread_id AS conn_id,
       trx_rows_locked,
       trx_rows_modified,
       LEFT(trx_query, 60) AS current_query
FROM information_schema.innodb_trx
ORDER BY trx_started
LIMIT 10;
```

⚠️ **`trx_query` 是 `NULL` 的交易最危險** —— 那代表它**現在什麼都沒在做**，
就只是開著、佔著快照和鎖。八成是應用程式忘了 `commit`，或是交易裡在等一個 HTTP 回應（4.7.6）。

**② 看 purge 落後多少**：

```sql
SELECT COUNT AS history_list_length
FROM information_schema.INNODB_METRICS
WHERE NAME = 'trx_rseg_history_len';
```

```
正常          < 1000
需要注意      1000 ～ 100000
出事了        > 1000000     ← 幾乎一定有一個長交易沒關
```

**③ 直接砍掉**（先確認它是什麼再砍）：

```sql
SELECT CONCAT('KILL ', trx_mysql_thread_id, ';') AS cmd
FROM information_schema.innodb_trx
WHERE TIMESTAMPDIFF(SECOND, trx_started, NOW()) > 600;
```

📌 **預防勝於治療，三條規則**：

```
① 交易裡【不要】呼叫外部 API、不要 sleep、不要等使用者輸入   → 4.7.6 有實測
② 唯讀查詢用 @Transactional(readOnly = true) 或乾脆不要交易   → 4.7.7
③ 監控 innodb_trx 的 age_sec，超過 60 秒就告警
```

---
## 4.4 四種隔離級別與它們擋不住的東西

### 4.4.1 髒讀：讀到別人等一下要回滾的資料

只有 `READ UNCOMMITTED` 會發生。實測：

```
兩邊都 SET SESSION TRANSACTION ISOLATION LEVEL READ UNCOMMITTED

B> BEGIN
B> UPDATE acct SET balance = 999999 WHERE id = 1      （還沒 commit！）

A> BEGIN
A> SELECT balance FROM acct WHERE id = 1
   →  999999.0000     🔴 讀到了 B 還沒提交的資料

B> ROLLBACK
A> SELECT balance FROM acct WHERE id = 1
   →  1000.0000       🔴 剛剛那個 999999 從來沒存在過
```

📌 **`READ UNCOMMITTED` 在 MySQL 幾乎沒有使用場景。**
它不加鎖、不建 ReadView、直接讀最新的髒資料。
唯一勉強說得過去的用途是「跑一個統計，慢一點沒關係但別擋人」——
但 MVCC 本來就不擋人，所以連這個理由都不成立。

### 4.4.2 不可重複讀：同一句 SELECT 兩個答案

`READ UNCOMMITTED` 和 `READ COMMITTED` 會發生（4.3.4 已經實測過，這裡不重複）。

⚠️ **「不可重複讀是 bug」是一個常見誤解。**
它是 `READ COMMITTED` 的**設計目標**，不是缺陷 ——
PostgreSQL / Oracle / SQL Server 預設就是這樣。
問題不在於它會發生，而在於**你的程式碼有沒有假設它不會發生**：

```java
// 🔴 在 READ COMMITTED 下，這兩句之間 status 可能已經變了
if (jdbc.queryForObject("SELECT status FROM orders WHERE id=?", String.class, id).equals("PENDING")) {
    jdbc.update("UPDATE orders SET status='PAID' WHERE id=?", id);
}

// ✅ 把判斷放進 UPDATE：一句話，一個原子動作
int n = jdbc.update("UPDATE orders SET status='PAID' WHERE id=? AND status='PENDING'", id);
if (n == 0) throw new IllegalStateException("訂單狀態已改變");
```

📌 **這個「把 `if` 塞進 `WHERE`」的手法，本章會出現五次。**
它是併發程式碼裡最便宜、最有效的一招。

### 4.4.3 幻讀：三個層次 ★★

「幻讀」這個詞被用得很亂。MySQL 裡它其實有**三個不同的東西**：

```
① 快照讀之間的幻讀     →  RR 用 MVCC 擋住了      （4.3.7 實測：cnt1=5, cnt2=5）
② 當前讀之間的幻讀     →  RR 用【間隙鎖】擋住了   （↓ 這一節）
③ 快照讀 + 當前讀混用  →  🔴【擋不住】           （4.3.7 的「半幻讀」）
```

**② 的實測** —— A 用 `FOR UPDATE` 鎖住一個範圍，B 想往裡面插一列：

```
lk 表：id = 5, 10, 15, 20, 25

A> BEGIN
A> SELECT id FROM lk WHERE id >= 15 AND id < 21 FOR UPDATE
   →  15, 20

B> INSERT INTO lk VALUES (17,170,1700,17000)
   ⏳ 阻塞中…                                    ✅ 被擋住了
```

擋住它的是什麼？看鎖：

```
M> SELECT * FROM locks_now ORDER BY typ DESC, idx, data
+------+-----+---------+--------+------------------------+---------+------+
| conn | tbl | idx     | typ    | mode                   | status  | data |
+------+-----+---------+--------+------------------------+---------+------+
| 449  | lk  | -       | TABLE  | IX                     | GRANTED | -    |
| 450  | lk  | -       | TABLE  | IX                     | GRANTED | -    |
| 449  | lk  | PRIMARY | RECORD | X,REC_NOT_GAP          | GRANTED | 15   |   ← 記錄鎖
| 449  | lk  | PRIMARY | RECORD | X                      | GRANTED | 20   |   ← next-key 鎖
| 450  | lk  | PRIMARY | RECORD | X,GAP,INSERT_INTENTION | WAITING | 20   |   ← B 卡在這
| 449  | lk  | PRIMARY | RECORD | X,GAP                  | GRANTED | 25   |   ← 純間隙鎖
+------+-----+---------+--------+------------------------+---------+------+
```

📌 **A 鎖的不只是 15 和 20 這兩列，還有它們之間與後面的【空隙】。**
`(15, 20]` 和 `(20, 25)` 都被鎖住了，所以 17 插不進去。
這就是 **next-key 鎖**，4.5 會完整拆解。

⚠️ **但 A `COMMIT` 之後**：

```
A> COMMIT
B  ← 解除阻塞：OK, 1 rows affected（B 一共等了 2,909 ms）
B  （autocommit，所以 17 立刻提交）

A> SELECT id FROM lk WHERE id BETWEEN 1 AND 30
   →  5, 10, 15, 17, 20, 25
                ↑ 🔴 17 進來了
```

**間隙鎖只在交易活著的時候有效。** 它保證的是「**在我這個交易裡**，
同一個範圍的當前讀不會多出東西」，不是「這個範圍永遠不准插入」。

### 4.4.4 更新遺失：兩個 read-modify-write

```
起始值 balance = 1000。A 要扣 100，B 要扣 200，正確答案是 700。

A> BEGIN                       B> BEGIN
A> SELECT balance → 1000       B> SELECT balance → 1000
A> UPDATE ... SET balance = 1000 - 100
                               B> UPDATE ... SET balance = 1000 - 200
                                  ⏳ 阻塞中…（等 A 的行鎖）
A> COMMIT
                               B  ← 解除阻塞：OK, 1 rows affected
                               B> COMMIT

最終 balance = 800     🔴 應該是 700，A 的 100 不見了
```

📌 **注意 B 是【被擋住】的** —— 行鎖確實生效了，B 排隊等到了 A 提交。
**但排隊沒有用**，因為 B 手上那個 `1000` 是它排隊【之前】讀到的。

⚠️ **這就是為什麼「加了交易」不等於「安全」。**
交易保證的是原子性和隔離性，**不保證你的計算是拿最新的值算的**。

**三種修法**（4.7.2 會全部實測）：

```sql
-- ① 把計算放進 SQL（當前讀）
UPDATE acct SET balance = balance - 100 WHERE id = 1 AND balance >= 100;

-- ② 悲觀鎖：讀的時候就鎖住
SELECT balance FROM acct WHERE id = 1 FOR UPDATE;

-- ③ 樂觀鎖：用 version 檢查有沒有人插隊
UPDATE acct SET balance = ?, version = version + 1 WHERE id = 1 AND version = ?;
```

### 4.4.5 寫偏斜：`REPEATABLE READ` 擋不住的那一個 ★★

前面四種異常，`REPEATABLE READ` 都處理了。這一種它處理不了。

**業務規則**：Alice 和 Bob 兩個帳戶的**總和**不得低於 1000。
兩人各有 1000，總和 2000。A 想幫 Alice 領 800，B 想幫 Bob 領 800。
**各自單獨看都合法**（領完還剩 200，總和 1200 > 1000）。

```
A> BEGIN                                      B> BEGIN
A> SELECT SUM(balance) FROM acct WHERE id IN (1,2)
   →  2000.0000  ✅ 檢查通過
                                              B> SELECT SUM(balance) FROM acct WHERE id IN (1,2)
                                                 →  2000.0000  ✅ 檢查通過
A> UPDATE acct SET balance = balance - 800 WHERE id = 1
                                              B> UPDATE acct SET balance = balance - 800 WHERE id = 2
A> COMMIT
                                              B> COMMIT

SELECT id, balance FROM acct WHERE id IN (1,2)
   +----+----------+
   | 1  | 200.0000 |
   | 2  | 200.0000 |
   +----+----------+
SELECT SUM(balance) FROM acct WHERE id IN (1,2)
   →  400.0000     🔴 業務規則被破壞了，而且【沒有任何一個交易做錯事】
```

📌 **為什麼 `REPEATABLE READ` 擋不住？**

```
A 改的是 id=1，B 改的是 id=2  →  【沒有任何一列被兩個交易同時改】
                              →  行鎖不衝突
A 和 B 讀的是【快照】          →  不加鎖
                              →  兩邊都看到「還沒扣」的世界
```

**兩個交易寫的是不同的列，但讀的是同一組列。** 這叫**寫偏斜（write skew）**。
它是 `SERIALIZABLE` 才擋得住的異常 —— 而 MySQL 的 `SERIALIZABLE` 代價很高（4.4.6）。

✅ **實務上的修法：把「檢查」也變成當前讀。**

```
A> BEGIN                                      B> BEGIN
A> SELECT SUM(balance) FROM acct WHERE id IN (1,2) FOR UPDATE
   →  2000.0000
                                              B> SELECT SUM(balance) FROM acct WHERE id IN (1,2) FOR UPDATE
                                                 ⏳ 阻塞中…                    ✅ 被擋住了
A> UPDATE acct SET balance = balance - 800 WHERE id = 1
A> COMMIT
                                              B  ← 解除阻塞：1200.0000
                                              B  現在會發現 1200 - 800 = 400 < 1000 → 拒絕
```

⚠️ **代價**：這條路上的所有交易都排隊了。
如果這是一個高頻操作，你會需要**縮小鎖的範圍**（只鎖真正相關的列），
或者把規則改成**每列各自可檢查**（例如「每個帳戶不得低於 500」，那就用 `CHECK` 就好）。

📌 **一句話判斷你會不會踩到寫偏斜**：

> **「我讀了 A 才決定要不要寫 B」** —— 只要 A ≠ B，`REPEATABLE READ` 就擋不住你。

常見場景：

```
醫院排班：至少要有一個醫生值班 →  兩個醫生同時請假，各自看到「還有另一個人在」
會議室預約：時段不得重疊       →  兩個人同時訂同一個時段（沒有現成的列可以鎖）
帳戶總額上限                   →  上面那個例子
唯一使用者名稱（沒有唯一索引）   →  兩個人同時註冊同一個名字
```

⚠️ **最後那個有一個更好的解法：加唯一索引。**
讓資料庫用**唯一鍵衝突**（`1062`）幫你擋，比任何鎖都便宜。

### 4.4.6 `SERIALIZABLE`：連 `SELECT` 都會加鎖

MySQL 的 `SERIALIZABLE` 實作方式很直接：
**把所有普通 `SELECT` 都偷偷變成 `SELECT ... FOR SHARE`。**

```
A> SET SESSION TRANSACTION ISOLATION LEVEL SERIALIZABLE
A> BEGIN
A> SELECT balance FROM acct WHERE id = 1     ← 一句再普通不過的 SELECT

M> SELECT * FROM locks_now WHERE tbl='acct'
+------+------+---------+--------+---------------+---------+------+
| conn | trx  | tbl     | typ    | mode          | status  | data |
+------+------+---------+--------+---------------+---------+------+
| 1079 | ...  | acct    | TABLE  | IS            | GRANTED | -    |
| 1079 | ...  | PRIMARY | RECORD | S,REC_NOT_GAP | GRANTED | 1    |   ← 🔴 S 鎖
+------+------+---------+--------+---------------+---------+------+

B> UPDATE acct SET balance = 1 WHERE id = 1
   ⏳ 阻塞中…                                 🔴 一句 SELECT 擋住了別人的 UPDATE
```

**把 4.4.5 的寫偏斜劇本放進 `SERIALIZABLE`**：

```
A> BEGIN                                      B> BEGIN
A> SELECT SUM(balance) ... WHERE id IN (1,2)  →  2000    （拿到 id=1,2 的 S 鎖）
                                              B> SELECT SUM(balance) ... →  2000    （也拿到 S 鎖，S 和 S 不衝突）
A> UPDATE acct SET balance = balance - 800 WHERE id = 1
   ⏳ 阻塞中…                                  （要把 S 升級成 X，但 B 也持有 S）
                                              B> UPDATE acct SET balance = balance - 800 WHERE id = 2
                                                 🔴 ERROR 1213: Deadlock found
```

📌 **`SERIALIZABLE` 擋住了寫偏斜，但它的擋法是【製造死鎖】。**
這不是 bug —— 這正是「可序列化」的定義：
如果兩個交易沒辦法排成一個等價的序列，那就必須有一個死掉。

⚠️ **所以用 `SERIALIZABLE` 的前提是：你的程式碼有完整的重試機制**（4.7.5）。
沒有重試就開 `SERIALIZABLE`，等於把「偶爾算錯」換成「隨機報 500」。

### 4.4.7 總表：五種異常 × 四種級別

| | 髒讀 | 不可重複讀 | 幻讀<br>（快照讀） | 幻讀<br>（當前讀） | 更新遺失<br>（read-modify-write） | 寫偏斜 |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `READ UNCOMMITTED` | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 |
| `READ COMMITTED` | ✅ | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 |
| `REPEATABLE READ` | ✅ | ✅ | ✅ | ✅ *間隙鎖* | 🔴 | 🔴 |
| `SERIALIZABLE` | ✅ | ✅ | ✅ | ✅ | ✅ *排隊/死鎖* | ✅ *死鎖* |

⚠️ **這張表有兩欄是 SQL 標準【沒有】列出來的**：更新遺失與寫偏斜。
標準只定義了前三種。而實務上壞掉的系統，**九成是壞在後兩種**。

📌 **所以請把這張表看成兩半**：

```
左邊三欄（髒讀 / 不可重複讀 / 幻讀）
    → 「我讀到了不該讀的東西」
    → 選對隔離級別就解決了，程式碼不用改

右邊兩欄（更新遺失 / 寫偏斜）
    → 「我根據舊資料做了決定」
    → 🔴 隔離級別解決不了，【只能改程式碼】
    → 這就是 4.7 整節在講的東西
```

### 4.4.8 該用 `REPEATABLE READ` 還是 `READ COMMITTED`

MySQL 預設 `REPEATABLE READ`，而全世界其他資料庫幾乎都預設 `READ COMMITTED`。
這個預設值是歷史因素（早期的 statement-based binlog 需要 RR 才能保證主從一致），
今天用 row-based binlog 已經沒有這個限制了。

| | `REPEATABLE READ` | `READ COMMITTED` |
|---|---|---|
| 一致性快照 | ✅ 整個交易同一個視角 | 🔴 每一句都可能不同 |
| 間隙鎖 | 🔴 **有** → 鎖範圍大、死鎖多 | ✅ **沒有** → 鎖範圍小 |
| 併發吞吐量（實測 4.5.7） | 1758 TPS | **7515 TPS** |
| 半一致性讀（4.5.9） | 🔴 沒有 | ✅ 有，非索引更新只鎖命中列 |
| 長交易的影響 | 🔴 大（快照一直不放） | ✅ 小（每句重建快照） |
| 主流做法 | MySQL 預設 | PostgreSQL / Oracle / **多數大型 MySQL 部署** |

📌 **我的建議**：

```
新專案、以 OLTP 為主、有完整的樂觀鎖/原子 UPDATE  →  READ COMMITTED
    理由：鎖範圍小、死鎖少、吞吐量高
    代價：你必須假設「同一個交易裡讀兩次會不一樣」

報表 / 對帳 / 需要「一整個交易看同一個世界」的批次  →  REPEATABLE READ
    但要用 @Transactional(readOnly = true) 且【交易要短】

已上線的系統                                      →  🔴 不要為了效能去改它
    改隔離級別會改變【現有程式碼的正確性假設】，
    比你想的危險得多。要改就一個 service 一個 service 地改。
```

**怎麼改**（三個層次，範圍由大到小）：

```sql
-- ① 整台伺服器（重啟後失效，要寫進 my.cnf 才是永久的）
SET GLOBAL transaction_isolation = 'READ-COMMITTED';

-- ② 這條連線
SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;

-- ③ 下一個交易（只影響一次）
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
```

```java
// Spring：單一方法
@Transactional(isolation = Isolation.READ_COMMITTED)
public void placeOrder(...) { ... }
```

```properties
# Spring Boot：整個資料來源的預設
spring.datasource.hikari.transaction-isolation=TRANSACTION_READ_COMMITTED
```

---
## 4.5 InnoDB 的鎖

### 4.5.1 兩個維度

InnoDB 的鎖看起來很多，其實只有兩個維度的組合：

```
             【模式】                          【範圍】
      ┌──────────────────┐          ┌──────────────────────────┐
      │  S  共享鎖（讀）  │          │  記錄鎖   只鎖那一列       │
      │  X  排他鎖（寫）  │    ×     │  間隙鎖   只鎖列之間的空隙 │
      └──────────────────┘          │  next-key 記錄 + 前面的空隙│
                                     └──────────────────────────┘
```

**相容矩陣**（同一列上，我要拿的 vs 別人已經拿到的）：

| 我要 ↓ ／ 別人有 → | **S** | **X** |
|---|:---:|:---:|
| **S** | ✅ 可以 | 🔴 等 |
| **X** | 🔴 等 | 🔴 等 |

📌 **一句話：只有「讀 + 讀」不衝突。**

⚠️ **但間隙鎖是例外，它有自己的規則**（4.5.10 會實測）：

```
間隙鎖 vs 間隙鎖          →  ✅ 完全不衝突（兩邊可以同時鎖同一個間隙）
間隙鎖 vs 插入意向鎖      →  🔴 衝突（這才是它存在的意義）
```

### 4.5.2 `LOCK_MODE` 到底在說什麼

`performance_schema.data_locks` 的 `LOCK_MODE` 有五種值，
**每一種對應一個具體的鎖範圍**。看懂這五個字串，就看懂 InnoDB 的鎖了：

| `LOCK_MODE` | 中文 | 鎖住的範圍（假設列是 …10, **15**, 20…） |
|---|---|---|
| `X,REC_NOT_GAP` | 記錄鎖 | **只有 15 這一列** |
| `X,GAP` | 間隙鎖 | **(10, 15) 這段空隙**，不含 15 |
| `X` | **next-key 鎖** | **(10, 15]** —— 空隙 + 15 這一列 |
| `X,GAP,INSERT_INTENTION` | 插入意向鎖 | 「我想往這個間隙插東西」（等待用） |
| `S` / `S,REC_NOT_GAP` / … | 同上，但是共享模式 | |

⚠️ **最容易搞錯的是「`X` 沒有後綴」** ——
沒有後綴的 `X` **不是**「普通記錄鎖」，它是**範圍最大的 next-key 鎖**。

```
LOCK_DATA 顯示 20  +  LOCK_MODE 是 X            →  鎖住 (15, 20]
LOCK_DATA 顯示 20  +  LOCK_MODE 是 X,REC_NOT_GAP →  只鎖 20
LOCK_DATA 顯示 20  +  LOCK_MODE 是 X,GAP         →  只鎖 (15, 20)，20 本身沒鎖
```

📌 **`LOCK_DATA` 是「範圍的【右】端點」**，範圍往**左**延伸到前一列。
還有一個特別的值 **`supremum pseudo-record`**，
代表「最後一列到正無限大」那一段。**看到它就代表整張表的尾巴被鎖住了。**

### 4.5.3 表級鎖：意向鎖與 MDL

在動任何一列之前，InnoDB 會先在**表**上放一個「意向鎖」：

```
IS（意向共享）  →  「我等一下要在這張表的某些列上加 S 鎖」
IX（意向排他）  →  「我等一下要在這張表的某些列上加 X 鎖」
```

**它的用途只有一個**：讓 `LOCK TABLES ... WRITE` 這種**表級鎖**可以
「不用掃描每一列」就知道「這張表現在有沒有人在鎖列」。

📌 **`IS` 和 `IX` 彼此完全相容** —— 你在實測輸出裡會一直看到兩三個 session
同時 `GRANTED` 一個 `IX`。**那不代表衝突，可以直接略過。**

**另一種表級鎖是 MDL（metadata lock，中繼資料鎖）**，它不歸 InnoDB 管，
歸 MySQL Server 層管。它保護的是「表結構」：

```
任何 DML（SELECT / INSERT / UPDATE / DELETE）  →  拿 MDL 的 SHARED_READ / SHARED_WRITE
任何 DDL（ALTER / DROP / RENAME）             →  拿 MDL 的 EXCLUSIVE
```

**MDL 在交易結束時才釋放。** 下一節會告訴你這句話有多可怕。

📌 **還有第三種表級鎖：`AUTO-INC` 鎖**（自增值的分配鎖）。
本章看不到它，因為 MySQL 8.0 的 `innodb_autoinc_lock_mode` **預設是 2（interleaved）**
—— 這個模式下自增值用的是一個很短的 mutex，**不是「持有到語句結束」的表鎖**。

```
mode 0（traditional）   → 🔴 整句 INSERT 期間持有 AUTO-INC 表鎖
mode 1（consecutive）   → 🔴 INSERT ... SELECT 這類「列數未知」的語句仍持有表鎖
mode 2（interleaved）★  → ✅ 只在分配的瞬間鎖，但同一句的 id 可能不連續
```

⚠️ **所以「批次 INSERT 互相卡住」這個症狀，在 8.0 上通常【不是】自增鎖造成的**
（是 4.5.5 ～ 4.5.8 的那些列鎖／間隙鎖）。
🔴 **但 mode 2 與 `binlog_format = STATEMENT` 是不相容的組合。**
實測：`SET GLOBAL binlog_format='STATEMENT'` 之後 `innodb_autoinc_lock_mode`
**仍然是 2** —— MySQL **不會**幫你降級，它只是讓你處在一個
「id 交錯 + 語句複製」會讓主從分岔的狀態（07 章 7.3.1 實測過那個分岔）。
✅ 8.0 的預設 `binlog_format` 是 `ROW`，所以預設組合是安全的。

### 4.5.4 MDL 實測：一個沒關的 `SELECT` 讓整張表癱瘓 ★★

```
A> BEGIN
A> SELECT COUNT(*) FROM seat        ← 一句唯讀查詢，跑完了，但【交易沒關】
   20000

M> SELECT OBJECT_TYPE, OBJECT_NAME, LOCK_TYPE, LOCK_DURATION, LOCK_STATUS
   FROM performance_schema.metadata_locks WHERE OBJECT_SCHEMA='shop5'
   +-------------+-------------+-------------+---------------+-------------+
   | TABLE       | seat        | SHARED_READ | TRANSACTION   | GRANTED     |
   +-------------+-------------+-------------+---------------+-------------+
                                              ↑ 這個 TRANSACTION 是關鍵：
                                                交易不結束，它就不放
```

**現在有人要加一個欄位**：

```
B> ALTER TABLE seat ADD COLUMN tmp_col INT NULL
   ⏳ 阻塞中…

M> SELECT OBJECT_TYPE, OBJECT_NAME, LOCK_TYPE, LOCK_STATUS FROM performance_schema.metadata_locks ...
   +-------------+-------------+---------------------+-------------+
   | TABLE       | seat        | SHARED_READ         | GRANTED     |   ← A
   | SCHEMA      | null        | INTENTION_EXCLUSIVE | GRANTED     |   ← B
   | TABLE       | seat        | SHARED_UPGRADABLE   | GRANTED     |   ← B
   | TABLE       | #sql-1_43e  | EXCLUSIVE           | GRANTED     |   ← B 的暫存表
   | TABLE       | seat        | EXCLUSIVE           | PENDING     |   ← 🔴 B 卡在這
   +-------------+-------------+---------------------+-------------+
```

**到這裡都還好** —— 只是一個 DDL 在等。**真正的災難是下一步**：

```
C> SELECT COUNT(*) FROM seat        ← 一句最普通的查詢
   ⏳ 阻塞中…                        🔴🔴 連【讀】都進不去了
```

```
M> SELECT ID, COMMAND, STATE, LEFT(INFO,40) FROM information_schema.processlist WHERE DB='shop5'
   +------+---------+---------------------------------+------------------------------------------+
   | 1086 | Query   | Waiting for table metadata lock | ALTER TABLE seat ADD COLUMN tmp_col INT  |
   | 1087 | Query   | Waiting for table metadata lock | SELECT COUNT(*) AS n FROM seat           |
   +------+---------+---------------------------------+------------------------------------------+
```

🔴 **這就是「一個小小的 `ALTER` 把整個網站打掛」的完整機制**：

```
① A 開了交易讀了一下 seat，忘了 commit（或是在等一個 HTTP 回應）
        ↓  A 持有 SHARED_READ MDL，且不放
② B 執行 ALTER TABLE seat
        ↓  B 要 EXCLUSIVE MDL，被 A 擋住 → PENDING
③ C、D、E…… 所有【新來的】查詢
        ↓  MDL 是【先進先出】的：C 排在 B 後面，B 又在等 A
        ↓  🔴 於是 C 也卡住 —— 即使 C 只是想讀一列
④ 連線池被塞滿 → 整個服務 502
```

📌 **注意第 ③ 步的「先進先出」** —— 這是最反直覺的一點。
**C 和 A 明明都只是讀，本來完全不衝突**，但因為 B 排在中間，C 就得等。

**排查與處理 SOP**：

```sql
-- ① 誰在等 MDL
SELECT ID, USER, TIME, STATE, LEFT(INFO, 80) AS query
FROM information_schema.processlist
WHERE STATE LIKE '%metadata lock%';

-- ② 誰持有它（找那個【最老的、沒有在跑查詢的】交易）
SELECT t.PROCESSLIST_ID AS conn_id, t.PROCESSLIST_TIME AS age_sec,
       t.PROCESSLIST_COMMAND AS cmd, ml.OBJECT_NAME, ml.LOCK_TYPE
FROM performance_schema.metadata_locks ml
JOIN performance_schema.threads t USING (OWNER_THREAD_ID)
WHERE ml.LOCK_STATUS = 'GRANTED'
  AND ml.OBJECT_NAME = 'seat';

-- ③ 先砍【DDL】（它是排隊的頭），後面的查詢就會通
KILL <ddl_conn_id>;
-- ④ 再處理那個忘了 commit 的長交易
KILL <holder_conn_id>;
```

⚠️ **順序很重要：先砍 DDL，不要先砍持有者。**
砍了持有者，DDL 會立刻開始跑，`ALTER` 大表可能要幾分鐘 ——
那幾分鐘裡所有查詢還是卡著。先砍 DDL 可以馬上恢復服務。

📌 **預防**：DDL 一律加上逾時，讓它自己放棄而不是無限排隊。

```sql
SET SESSION lock_wait_timeout = 5;     -- 這個管 MDL（預設 31536000 秒 = 一年！）
ALTER TABLE seat ADD COLUMN tmp_col INT NULL;
```

⚠️ **注意這是 `lock_wait_timeout`，不是 `innodb_lock_wait_timeout`。**
兩個完全不同的東西：

```
lock_wait_timeout          → MDL（表結構鎖），預設 31536000 秒
innodb_lock_wait_timeout   → InnoDB 行鎖，   預設 50 秒
```

線上大表變更的完整做法（`gh-ost` / `pt-online-schema-change`）在 06 章。

### 4.5.5 七組實測：到底鎖了什麼 ★★

**實驗表**（4.2.1 的 `lk`）：

```
id:  5    10    15    20    25          ← 主鍵
c:   50   100   150   200   250         ← 非唯一索引 k_c
u:   500  1000  1500  2000  2500        ← 唯一索引 uk_u
d:   5000 10000 15000 20000 25000       ← 沒有索引
```

隔離級別 `REPEATABLE READ`。每一組都是 `BEGIN` → 一句 `FOR UPDATE` → 看 `locks_now`。

---

#### L1 主鍵等值，**命中**

```sql
SELECT * FROM lk WHERE id = 15 FOR UPDATE;
```

```
+------+---------+--------+---------------+---------+------+
| conn | idx     | typ    | mode          | status  | data |
+------+---------+--------+---------------+---------+------+
| 442  | -       | TABLE  | IX            | GRANTED | -    |
| 442  | PRIMARY | RECORD | X,REC_NOT_GAP | GRANTED | 15   |
+------+---------+--------+---------------+---------+------+
```

✅ **只鎖 15 這一列。** 唯一索引（主鍵也是唯一索引）等值命中時，
next-key 鎖會**退化成記錄鎖** —— 因為「唯一」保證了不會有第二個 15，
所以不需要鎖住旁邊的間隙。

**別人可以做什麼**：改 5/10/20/25 ✅、插入 12/17/22 ✅、改 15 🔴。

---

#### L2 主鍵等值，**不命中**

```sql
SELECT * FROM lk WHERE id = 17 FOR UPDATE;      -- 17 不存在
```

```
+------+---------+--------+-------+---------+------+
| 442  | PRIMARY | RECORD | X,GAP | GRANTED | 20   |
+------+---------+--------+-------+---------+------+
```

🔴 **查不到東西，一樣加了鎖** —— 而且是**間隙鎖 `(15, 20)`**。

📌 **這是最反直覺的一點：`SELECT` 回傳 0 列，卻鎖住了一整段。**
理由是「防幻讀」：如果不鎖，別人插入 17 之後你再查一次就會多出東西。

**別人可以做什麼**：插入 16/17/18/19 🔴、插入 21 ✅、改 15 或 20 ✅。

---

#### L3 主鍵**範圍**

```sql
SELECT * FROM lk WHERE id >= 15 AND id < 21 FOR UPDATE;
```

```
+------+---------+--------+---------------+---------+------+
| 442  | PRIMARY | RECORD | X,REC_NOT_GAP | GRANTED | 15   |   ← 只有 15
| 442  | PRIMARY | RECORD | X             | GRANTED | 20   |   ← (15, 20]
| 442  | PRIMARY | RECORD | X,GAP         | GRANTED | 25   |   ← (20, 25)
+------+---------+--------+---------------+---------+------+
```

🔴 **注意最後一行：你的條件寫的是 `< 21`，但 `(20, 25)` 整段都被鎖了。**

**為什麼？** InnoDB 是掃到「第一個不滿足條件的列」才停 ——
它掃到 25 才知道「超過 21 了」，而掃描的過程中就已經鎖住了 `(20, 25)`。

📌 **這是範圍查詢最常見的「鎖比你以為的多」的來源。**
`WHERE id < 21` 實際鎖到 25。如果你的表是 `id` 稀疏的（例如刪過很多資料），
`(20, 25)` 可能其實是 `(20, 5000000)`。

✅ **改法**：範圍盡量對齊實際存在的值，或改用 `IN` 列舉：

```sql
-- 鎖到 25
SELECT * FROM lk WHERE id >= 15 AND id < 21 FOR UPDATE;
-- 只鎖 15 和 20 兩列（各自退化成記錄鎖）
SELECT * FROM lk WHERE id IN (15, 20) FOR UPDATE;
```

---

#### L4 **非唯一**二級索引等值，命中

```sql
SELECT * FROM lk WHERE c = 150 FOR UPDATE;
```

```
+------+---------+--------+---------------+---------+---------+
| 442  | k_c     | RECORD | X             | GRANTED | 150, 15 |   ← (100,150] on k_c
| 442  | k_c     | RECORD | X,GAP         | GRANTED | 200, 20 |   ← (150,200) on k_c
| 442  | PRIMARY | RECORD | X,REC_NOT_GAP | GRANTED | 15      |   ← 回表鎖主鍵
+------+---------+--------+---------------+---------+---------+
```

🔴 **一句話鎖了三個東西**：

```
① k_c 上的 next-key 鎖 (100, 150]
② k_c 上往右的間隙鎖 (150, 200)   ← 因為 c 不唯一，可能還有第二個 150
③ 主鍵上的記錄鎖 15               ← 回表（03 章 3.3.3）
```

📌 **`LOCK_DATA` 顯示的是 `150, 15`** ——
這正好驗證 03 章 3.3.2 的那句話：**二級索引隱含以主鍵結尾**。
`k_c` 的實際鍵值是 `(c, id)`，所以鎖的粒度也是 `(c, id)`。

**別人可以做什麼**：插入 `c = 120` 🔴、插入 `c = 180` 🔴、插入 `c = 300` ✅。

---

#### L5 **唯一**二級索引等值，命中

```sql
SELECT * FROM lk WHERE u = 1500 FOR UPDATE;
```

```
+------+---------+--------+---------------+---------+----------+
| 442  | uk_u    | RECORD | X,REC_NOT_GAP | GRANTED | 1500, 15 |
| 442  | PRIMARY | RECORD | X,REC_NOT_GAP | GRANTED | 15       |
+------+---------+--------+---------------+---------+----------+
```

✅ **兩個記錄鎖，沒有間隙鎖。**
和 L1 一樣，唯一索引等值命中 → 退化成記錄鎖。

📌 **對照 L4 和 L5**：同樣是「用二級索引找一列」，
**唯一索引鎖 2 個點，非唯一索引鎖 2 個點 + 2 段間隙。**

> **這是「該不該把索引設成 UNIQUE」的一個常被忽略的理由 ——
> 它不只是約束，還會顯著縮小鎖的範圍。**

---

#### L6 **唯一**二級索引等值，**不命中**

```sql
SELECT * FROM lk WHERE u = 1600 FOR UPDATE;      -- 1600 不存在
```

```
+------+------+--------+-------+---------+----------+
| 442  | uk_u | RECORD | X,GAP | GRANTED | 2000, 20 |
+------+------+--------+-------+---------+----------+
```

🔴 **和 L2 一樣：查不到，還是鎖住了 `(1500, 2000)` 這段間隙。**

⚠️ **這是「先查再插」寫法最大的陷阱**，而且它會直接造成死鎖（4.6.3 的模式二）：

```java
// 🔴 高危險寫法
var existing = jdbc.query("SELECT * FROM lk WHERE u = ? FOR UPDATE", ...);
if (existing.isEmpty()) {
    jdbc.update("INSERT INTO lk VALUES (?, ?, ?, ?)", ...);   // ← 兩個執行緒同時走到這，死鎖
}

// ✅ 正確寫法：讓唯一索引擋，捕捉 1062
try {
    jdbc.update("INSERT INTO lk VALUES (?, ?, ?, ?)", ...);
} catch (DuplicateKeyException e) {
    // 已存在
}
```

---

#### L7 **沒有索引**的欄位 ★★

```sql
SELECT * FROM lk WHERE d = 15000 FOR UPDATE;     -- d 沒有索引，只命中 1 列
```

```
+------+---------+--------+------+---------+------------------------+
| 442  | PRIMARY | RECORD | X    | GRANTED | 5                      |
| 442  | PRIMARY | RECORD | X    | GRANTED | 10                     |
| 442  | PRIMARY | RECORD | X    | GRANTED | 15                     |
| 442  | PRIMARY | RECORD | X    | GRANTED | 20                     |
| 442  | PRIMARY | RECORD | X    | GRANTED | 25                     |
| 442  | PRIMARY | RECORD | X    | GRANTED | supremum pseudo-record |
+------+---------+--------+------+---------+------------------------+
```

🔴🔴 **回傳 1 列，鎖住 6 個 next-key ——【整張表，含尾巴那一段】。**

**這就是 03 章結尾那個問題的答案**：

> **沒有索引的 `WHERE`，鎖住的不是「那一列」，也不是「那一段」，是【全部】。**

**為什麼？** InnoDB 的鎖是**加在索引項上**的。
沒有索引可用時它只能全表掃描，而掃描過程中**每一列都要先鎖住才能判斷**
（不然判斷完鬆手，別人改掉了怎麼辦）。
所以「掃了幾列」就是「鎖了幾列」—— 而不是「回傳了幾列」。

📌 **記住這條公式，它比任何規則都好用**：

> **鎖的數量 = `EXPLAIN` 的 `rows`（掃描列數），不是結果的列數。**

⚠️ **`rows` 這個欄位你在 03 章 3.4.5 已經學會怎麼看了 ——
現在它多了第二個用途：它同時是「這句話大概會鎖幾列」的估計。**

---

### 4.5.6 沒有索引的代價：實測併發吞吐量差 10.8 倍 ★★

L7 的「鎖全表」不是理論。量它：

**實驗**：`seat` 表 20000 列，其中 `seat_no` 有唯一索引，`code` 內容完全相同但**沒有索引**。
8 個執行緒，每個做 50 次 `UPDATE`，每次都只改**一列**（各自不同的列，理論上互不衝突）。

```sql
UPDATE seat SET taken_by = ? WHERE seat_no = ?;    -- 有索引
UPDATE seat SET taken_by = ? WHERE code    = ?;    -- 沒索引，內容一樣
```

```
                                      隔離級別            耗時       TPS      倍數
UPDATE ... WHERE seat_no=?（唯一索引）  REPEATABLE READ    227.6 ms   1758
UPDATE ... WHERE code=?（無索引）       REPEATABLE READ   2473.8 ms    162     🔴 10.8 倍

UPDATE ... WHERE seat_no=?（唯一索引）  READ COMMITTED      53.2 ms   7515
UPDATE ... WHERE code=?（無索引）       READ COMMITTED    1556.0 ms    257     🔴 29.2 倍
```

📌 **三個結論**：

```
① 少一個索引 → 併發吞吐量掉 10 ～ 29 倍
   —— 而【單執行緒】跑同一句，差距只有 3 ～ 5 倍
   —— 🔴 索引對併發的影響，比對單次查詢的影響大得多

② READ COMMITTED 全面比 REPEATABLE READ 快（1758 → 7515，4.3 倍）
   —— 因為 RC 沒有間隙鎖，8 個執行緒真的可以平行跑

③ 但在【沒有索引】的情況下，RC 也只有 257 TPS
   —— 🔴 換隔離級別救不了「鎖全表」，只有索引救得了
```

⚠️ **03 章 3.10.5 有一份「刻意沒建的索引」清單。**
現在你有了新的判斷依據：**那些欄位會不會出現在 `UPDATE` / `DELETE` 的 `WHERE` 裡？**
如果會，那它就不只是「查詢慢一點」的問題了。

### 4.5.7 鎖跟著【優化器選的索引】走，不是跟著你寫的 `WHERE` ★★

這一組實測是本章最容易讓人措手不及的。

**兩句 SQL，`WHERE` 一模一樣，只差在 `SELECT` 什麼**：

```sql
SELECT id FROM lk WHERE id BETWEEN 1 AND 30 FOR UPDATE;      -- ①
SELECT *  FROM lk WHERE id BETWEEN 1 AND 30 FOR UPDATE;      -- ②
```

**① 的執行計畫**：

```
+-------+---------------+------+---------+------+----------+--------------------------+
| type  | possible_keys | key  | key_len | ref  | rows     | Extra                    |
+-------+---------------+------+---------+------+----------+--------------------------+
| index | PRIMARY,k_c   | uk_u | 4       | null | 5        | Using where; Using index |
+-------+---------------+------+---------+------+----------+--------------------------+
                          ↑
              🔴 走的是 uk_u，不是 PRIMARY
```

（`SELECT id` 是覆蓋查詢 —— 03 章 3.6 —— 而 `uk_u` 比 `PRIMARY` 小，所以優化器選了它。）

**① 鎖了什麼**：

```
| PRIMARY | X,REC_NOT_GAP | 5, 10, 15, 20, 25                     ← 5 個
| uk_u    | X             | 500,5 / 1000,10 / 1500,15 / 2000,20 /
|         |               | 2500,25 / supremum pseudo-record      ← 6 個 next-key
                                                                     總共 12 筆鎖
```

**② 鎖了什麼**：

```
| PRIMARY | X | 5, 10, 15, 20, 25, supremum pseudo-record         ← 6 個 next-key
                                                                     總共 7 筆鎖
```

🔴 **同一個 `WHERE`，因為 `SELECT` 的欄位不同，鎖住的索引不同、鎖的筆數也不同。**

📌 **這件事的實務意義**：

```
① 你不能只看 WHERE 就推斷鎖範圍 —— 一定要看 EXPLAIN 的 key 那一欄
② 「加一個覆蓋索引讓查詢變快」（03 章 3.6.2 的 6.9 倍）
   可能【同時】改變了當前讀的加鎖範圍
   → 🔴 一個純粹為了效能加的索引，可能製造出新的死鎖
③ 優化器換索引，鎖就換位置 —— 而優化器會隨統計資訊變（03 章 3.9）
   → 🔴 同一份程式碼，上週不死鎖，這週死鎖
```

⚠️ **這也是為什麼「加索引」不能算純粹的優化動作。**
03 章教你評估它的空間與寫入成本；這一章告訴你它還有第三個成本：**它會改變鎖。**

### 4.5.8 二級索引會鎖兩個地方

```sql
UPDATE lk SET d = d + 1 WHERE c = 150;
```

```
| k_c     | X             | 150, 15   ← ① 二級索引的 next-key
| k_c     | X,GAP         | 200, 20   ← ② 二級索引往右的間隙
| PRIMARY | X,REC_NOT_GAP | 15        ← ③ 回表之後的主鍵記錄鎖
```

**畫成圖**：

```
     二級索引 k_c                              聚簇索引 PRIMARY
  ┌──────────────────┐                       ┌────────────────────┐
  │ (100,10) ────────│                       │  5  → 全部欄位      │
  │ ████ (150,15) ███│ ── 回表 ──────────►    │ 10  → 全部欄位      │
  │ ░░░░ 間隙 ░░░░░░░│                       │ ██ 15 → 全部欄位 ██ │
  │ (200,20) ────────│                       │ 20  → 全部欄位      │
  └──────────────────┘                       └────────────────────┘
     ██ = next-key 鎖   ░░ = 間隙鎖              ██ = 記錄鎖
```

📌 **為什麼要鎖主鍵？** 因為別人可能**直接用主鍵**來改同一列：

```
A> UPDATE lk SET d = d + 1 WHERE c  = 150     ← 走 k_c
B> UPDATE lk SET d = d + 1 WHERE id = 15      ← 走 PRIMARY
```

兩句改的是同一列。如果 A 只鎖 `k_c`，B 完全感覺不到 A 的存在。
**所以只要回表，就一定會在主鍵上補一個鎖。**

⚠️ **而這正是 4.6.3 死鎖模式三的成因**：兩句話**加鎖的順序相反**
（A 是 `k_c → PRIMARY`，B 是 `PRIMARY` 直接下手），撞在一起就死鎖。

**那覆蓋索引呢？不用回表，會不會少鎖一個？**

```sql
SELECT c FROM lk WHERE c = 150 FOR UPDATE;     -- 只查 c，理論上不用回表
```

```
| k_c     | X             | 150, 15
| k_c     | X,GAP         | 200, 20
| PRIMARY | X,REC_NOT_GAP | 15            ← 🔴 還是鎖了
```

📌 **不會。** 03 章的覆蓋索引省的是**讀取**的回表，
但**當前讀一定要鎖住實際的那一列**，否則上面 A/B 的問題還是存在。

> **覆蓋索引能省 I/O，省不了鎖。**

### 4.5.9 `READ COMMITTED` 沒有間隙鎖（實測）

把 L3（主鍵範圍）和 L7（無索引）搬到 `READ COMMITTED`：

**L3 在 RC**：

```sql
SELECT * FROM lk WHERE id >= 15 AND id < 21 FOR UPDATE;
```

```
| PRIMARY | X,REC_NOT_GAP | 15
| PRIMARY | X,REC_NOT_GAP | 20
```

✅ **只有兩個記錄鎖，沒有間隙鎖、沒有 `(20,25)`。**

```
B> INSERT INTO lk VALUES (17,170,1700,17000)
   ✅ (沒有被擋住) OK, 1 rows affected
```

**L7 在 RC**：

```sql
SELECT * FROM lk WHERE d = 15000 FOR UPDATE;     -- d 沒有索引
```

```
| PRIMARY | X,REC_NOT_GAP | 15         ← 🔴 只有一個！不是六個
```

⚠️ **等等 —— RC 下不是也要全表掃描嗎？為什麼只鎖了一列？**

因為 RC 有一個 RR 沒有的優化叫**半一致性讀（semi-consistent read）**：

```
掃描每一列 → 先讀【最新已提交版本】判斷 WHERE
    不符合 → 立刻放掉鎖，繼續下一列
    符合   → 保留鎖
```

📌 **注意這個優化只對 `UPDATE` / `DELETE` 生效**，
`SELECT ... FOR UPDATE` 嚴格來說不吃這個優化 ——
但實測顯示 MySQL 8.0.46 對兩者都做了鎖釋放。**別依賴這個細節。**

⚠️ **半一致性讀是「掃描時暫時鎖了又放」，不是「沒鎖」。**
所以 4.5.6 的實測裡，RC 的無索引更新還是只有 257 TPS ——
鎖是放了，但**每一列還是都要摸一次**。

### 4.5.10 插入意向鎖：間隙鎖之間互不衝突

**兩個交易同時往【同一個間隙】插入不同的值，會互擋嗎？**

```
A> BEGIN
A> INSERT INTO lk VALUES (16,160,1600,16000)
B> BEGIN
B> INSERT INTO lk VALUES (17,170,1700,17000)
   ✅ (沒有被擋住) OK, 1 rows affected
```

✅ **不會。** `(15, 20)` 這個間隙裡插 16 和 17，兩邊都成功。
如果插入要「鎖住整個間隙」，那自增主鍵的表就完全沒有併發可言了。

**那間隙鎖到底擋誰？** 只擋一種東西：**已經存在的間隙鎖**。

```
A> BEGIN
A> SELECT * FROM lk WHERE id >= 15 AND id < 21 FOR UPDATE     ← A 鎖住 (20,25)
B> INSERT INTO lk VALUES (17,170,1700,17000)
   ⏳ 阻塞中…

M> SELECT * FROM locks_now ...
| 449 | PRIMARY | X,GAP                  | GRANTED | 25 |   ← A 的間隙鎖
| 450 | PRIMARY | X,GAP,INSERT_INTENTION | WAITING | 20 |   ← 🔴 B 的插入意向鎖
```

📌 **完整的相容規則**：

| | 別人的**間隙鎖** | 別人的**插入意向鎖** |
|---|:---:|:---:|
| 我的**間隙鎖** | ✅ 相容 | ✅ 相容 |
| 我的**插入意向鎖** | 🔴 **衝突** | ✅ 相容 |

⚠️ **「間隙鎖彼此相容」這件事，是 4.6.3 死鎖模式二的全部成因** ——
兩邊都拿到同一個間隙鎖（不衝突 ✅），然後兩邊都想插入（互相衝突 🔴）。
**這是 MySQL 最常見的死鎖，而且完全不需要「兩個人改同一列」。**

### 4.5.11 唯一鍵衝突的插入，會拿一個 S 鎖 ★

```
A> BEGIN
A> INSERT INTO lk VALUES (18,180,1800,18000)      -- u = 1800

B> BEGIN
B> INSERT INTO lk VALUES (19,190,1800,19000)      -- 🔴 u 也是 1800
   ⏳ 阻塞中…
```

```
M> SELECT * FROM locks_now ORDER BY typ DESC, idx, data
+------+-------+------+---------------+---------+----------+
| conn | trx   | idx  | mode          | status  | data     |
+------+-------+------+---------------+---------+----------+
| 454  | 7735  | uk_u | X,REC_NOT_GAP | GRANTED | 1800, 18 |   ← A（trx 7735）持有
| 454  | 7736  | uk_u | S             | WAITING | 1800, 18 |   ← 🔴 B 在等【S】鎖
+------+-------+------+---------------+---------+----------+
```

📌 **B 要的是 `S` 鎖，不是 `X` 鎖。**
因為 B 只是想「檢查這個唯一值存不存在」，還沒到要改它的地步。

⚠️ **這裡有一個【會讓你看錯排查結果】的陷阱**：

```
兩行的 conn 都是 454（B 的連線），但 trx 一個是 7735、一個是 7736
```

🔴 **`data_locks.THREAD_ID` 記錄的是「誰【建立】了這筆鎖紀錄」，不是「誰持有它」。**

A 插入的時候用的是**隱式鎖**（implicit lock）—— InnoDB 不真的建鎖結構，
只靠「這一列的 `DB_TRX_ID` 是我」來表達「我鎖著它」，**省下建鎖的開銷**。
直到 B 撞上來，才由 **B 出手**把 A 的隱式鎖「轉正」成一筆真的鎖紀錄 ——
於是那筆紀錄的 `THREAD_ID` 是 B 的。

📌 **排查時的規則：看 `ENGINE_TRANSACTION_ID`，不要看 `THREAD_ID`。**

要把 trx 對回連線，用這句：

```sql
SELECT dl.ENGINE_TRANSACTION_ID AS trx,
       trx.trx_mysql_thread_id  AS real_conn,
       dl.OBJECT_NAME, dl.INDEX_NAME, dl.LOCK_MODE, dl.LOCK_STATUS, dl.LOCK_DATA
FROM performance_schema.data_locks dl
LEFT JOIN information_schema.innodb_trx trx
       ON trx.trx_id = dl.ENGINE_TRANSACTION_ID
WHERE dl.OBJECT_SCHEMA = 'shop5';
```

### 4.5.12 外鍵的隱藏鎖 ★

01 章教你加外鍵保證參照完整性。它有一個沒說的代價。

```
ord 表：id = 1, 2（父）    ord_item 表：order_id 外鍵指向 ord.id（子）

A> BEGIN
A> INSERT INTO ord_item (order_id, product_id, qty) VALUES (1, 100, 1)

M> SELECT * FROM locks_now WHERE tbl IN ('ord','ord_item')
+------+----------+---------+--------+---------------+---------+------+
| conn | tbl      | idx     | typ    | mode          | status  | data |
+------+----------+---------+--------+---------------+---------+------+
| 1102 | ord      | -       | TABLE  | IS            | GRANTED | -    |
| 1102 | ord      | PRIMARY | RECORD | S,REC_NOT_GAP | GRANTED | 1    |   ← 🔴 鎖了父表
| 1102 | ord_item | -       | TABLE  | IX            | GRANTED | -    |
+------+----------+---------+--------+---------------+---------+------+
```

🔴 **只是往子表插一列，卻在父表那一列上加了 `S` 鎖。**
（合理：不鎖的話，別人可能在你插完之前把父列刪掉。）

**後果一：父表刪不掉**（這是預期的）

```
B> DELETE FROM ord WHERE id = 1
   ⏳ 阻塞中…                        → X 鎖 vs A 的 S 鎖，衝突
```

**後果二：改父表的【無關欄位】也被擋住**（這才是意外的）

```
A> BEGIN
A> INSERT INTO ord_item (order_id, ...) VALUES (2, ...)
B> UPDATE ord SET status = 'PAID' WHERE id = 2        ← status 跟外鍵一點關係都沒有
   ⏳ 阻塞中…                        🔴
```

📌 **因為行鎖鎖的是【整列】，不是「某幾個欄位」。**

⚠️ **這在訂單系統裡是一個真實的熱點**：

```
使用者不斷地往一張訂單加明細（INSERT ord_item）
    ↓ 每一次都在 ord 那一列上放 S 鎖
背景服務要更新這張訂單的狀態（UPDATE ord SET status = ...）
    ↓ 要 X 鎖
    🔴 排隊
```

**三種處理方向**：

```
① 接受它 —— 大多數系統的訂單明細寫入量沒有大到出問題
② 拆掉外鍵，用應用層 + 對帳批次保證參照完整性
   （很多大型系統的做法，但你要有對帳）
③ 縮短交易 —— 把「加明細」和「改狀態」分開成兩個短交易
```

📌 **不管選哪個，先知道有這回事**，不然你會在 `SHOW ENGINE INNODB STATUS`
裡看到一堆「明明沒人改同一列」的鎖等待，卻找不到原因。

### 4.5.13 `SKIP LOCKED` / `NOWAIT` / `FOR UPDATE OF`

MySQL 8 給了三個很實用、但很多人不知道的語法。

```
A> BEGIN
A> SELECT id FROM lk WHERE id >= 5 ORDER BY id LIMIT 2 FOR UPDATE
   →  5, 10        （A 鎖住了這兩列）

B> SELECT id FROM lk WHERE id >= 5 ORDER BY id LIMIT 2 FOR UPDATE SKIP LOCKED
   →  15, 20       ✅ 跳過被鎖的，拿下兩列

B> SELECT id FROM lk WHERE id >= 5 ORDER BY id LIMIT 2 FOR UPDATE NOWAIT
   🔴 ERROR 3572 (HY000): Statement aborted because lock(s) could not be
      acquired immediately and NOWAIT is set.
```

| 語法 | 行為 | 用途 |
|---|---|---|
| `FOR UPDATE` | 等到拿到為止（最多 `innodb_lock_wait_timeout`） | 一般情況 |
| `FOR UPDATE NOWAIT` | 拿不到 → **立刻報 `3572`** | 想快速失敗、不要卡使用者的介面 |
| `FOR UPDATE SKIP LOCKED` | 拿不到 → **跳過那幾列** | 🔥 **任務佇列**（多個 worker 各領各的） |

📌 **`SKIP LOCKED` 是用資料庫做輕量任務佇列的關鍵**：

```sql
-- 每個 worker 都跑這一句，彼此不會搶到同一批
START TRANSACTION;
SELECT id, payload FROM outbox_message
WHERE status = 'PENDING'
ORDER BY id
LIMIT 20
FOR UPDATE SKIP LOCKED;
-- … 處理 …
UPDATE outbox_message SET status = 'SENT' WHERE id IN (...);
COMMIT;
```

⚠️ **`SKIP LOCKED` 會讓你的查詢變成「不確定的」** ——
同一句話在不同時刻回傳不同的列。**不要用在需要精確結果的地方**
（例如報表、對帳）。它只適合「誰處理都可以」的場景。

**`FOR UPDATE OF`：JOIN 時只鎖其中一張表**

```sql
SELECT a.id FROM acct a JOIN lk l ON l.id = 5 WHERE a.id = 1 FOR UPDATE OF a;
```

```
| conn | tbl  | idx     | mode          | status  | data |
| 1084 | acct | -       | TABLE  IX     | GRANTED | -    |
| 1084 | acct | PRIMARY | X,REC_NOT_GAP | GRANTED | 1    |
                                                            ← lk 完全沒鎖 ✅
```

📌 **沒有 `OF a` 的話，`lk` 的那一列也會被鎖住。**
JOIN 查詢加 `FOR UPDATE` 的時候，**幾乎總是應該加 `OF`**。

### 4.5.14 加鎖規則總表

**`REPEATABLE READ`，`SELECT ... FOR UPDATE` / `UPDATE` / `DELETE`**：

| 情況 | 索引 | 命中？ | 鎖住什麼 | 實測 |
|---|---|:---:|---|:---:|
| 主鍵 / 唯一索引等值 | 唯一 | ✅ | **只有那一列**（記錄鎖） | L1 / L5 |
| 主鍵 / 唯一索引等值 | 唯一 | 🔴 | **左右兩列之間的間隙** | L2 / L6 |
| 非唯一二級索引等值 | 非唯一 | ✅ | next-key + **往右一個間隙** + 主鍵記錄鎖 | L4 |
| 範圍 | 任何 | — | 掃到的**每一個** next-key，**含第一個不滿足條件的那一個** | L3 |
| 無索引 | — | — | 🔴 **整張表的所有 next-key + supremum** | L7 |
| 覆蓋索引的當前讀 | — | ✅ | 二級索引 **+ 主鍵**（省不掉） | 4.5.8 |

**`READ COMMITTED` 的差別**：

```
① 完全沒有間隙鎖 → 上表所有「間隙」那一欄都消失
② 等值不命中 → 【完全不加鎖】
③ 非索引 UPDATE/DELETE → 半一致性讀，只保留命中列的鎖
④ 🔴 但「掃描列數」不變 → 效能問題還在（4.5.6 實測 257 TPS）
```

📌 **一句話總結整節**：

> **鎖加在「掃描路徑」上，不是加在「結果」上。
> 想知道會鎖什麼，先跑 `EXPLAIN` 看它走哪個索引、掃幾列。**

---
## 4.6 死鎖

### 4.6.1 造一個死鎖

最經典的形狀：**兩個交易，兩列，順序相反**。

```
A> BEGIN                                      B> BEGIN
A> UPDATE acct SET balance = balance - 1 WHERE id = 1      （A 拿到 id=1 的 X 鎖）
                                              B> UPDATE acct SET balance = balance - 1 WHERE id = 2
                                                 （B 拿到 id=2 的 X 鎖）
A> UPDATE acct SET balance = balance + 1 WHERE id = 2
   ⏳ 阻塞中…（A 要 id=2，但 B 拿著）
                                              B> UPDATE acct SET balance = balance + 1 WHERE id = 1
                                                 🔴 ERROR 1213 (40001): Deadlock found when
                                                    trying to get lock; try restarting transaction

A  ← 解除阻塞：OK, 1 rows affected
```

```
      A ──要 id=2──►  B
      ▲               │
      └──要 id=1──────┘        ← 環
```

📌 **InnoDB 偵測到環，選一個「回滾成本最小」的交易砍掉**（這裡是 B），
另一個立刻繼續。**偵測是即時的** —— 從 B 送出第二句到報錯，實測 **42.8 ms**。

### 4.6.2 死鎖日誌逐行解讀 ★★

```sql
SHOW ENGINE INNODB STATUS\G
```

在輸出裡找 `LATEST DETECTED DEADLOCK` 這一段（**只保留最近一次**）：

```
------------------------
LATEST DETECTED DEADLOCK
------------------------
2026-09-02 10:09:54 281472129482496                                       ← ①
*** (1) TRANSACTION:
TRANSACTION 7751, ACTIVE 0 sec starting index read                        ← ②
mysql tables in use 1, locked 1
LOCK WAIT 3 lock struct(s), heap size 1128, 2 row lock(s), undo log entries 1   ← ③
MySQL thread id 457, OS thread handle 281472434499328, query id 6370      ← ④
  192.168.65.1 root updating
UPDATE acct SET balance = balance + 1 WHERE id = 2                        ← ⑤

*** (1) HOLDS THE LOCK(S):                                                ← ⑥
RECORD LOCKS space id 137 page no 4 n bits 72 index PRIMARY
  of table `shop5`.`acct` trx id 7751 lock_mode X locks rec but not gap
Record lock, heap no 2 PHYSICAL RECORD: n_fields 6; compact format; info bits 0
 0: len 4; hex 80000001; asc     ;;                                       ← ⑦
 1: len 6; hex 000000001e47; asc      G;;
 2: len 7; hex 01000002230c90; asc     #  ;;
 3: len 5; hex 416c696365; asc Alice;;                                    ← ⑧
 4: len 9; hex 800000000003e70000; asc          ;;
 5: len 8; hex 8000000000000000; asc         ;;

*** (1) WAITING FOR THIS LOCK TO BE GRANTED:                              ← ⑨
RECORD LOCKS space id 137 page no 4 n bits 72 index PRIMARY
  of table `shop5`.`acct` trx id 7751 lock_mode X locks rec but not gap waiting
 0: len 4; hex 80000002; asc     ;;                                       ← id = 2
 3: len 3; hex 426f62; asc Bob;;

*** (2) TRANSACTION:
TRANSACTION 7752, ACTIVE 0 sec starting index read
MySQL thread id 458, ...
UPDATE acct SET balance = balance + 1 WHERE id = 1
*** (2) HOLDS THE LOCK(S):   … id = 2（Bob）
*** (2) WAITING FOR THIS LOCK TO BE GRANTED:  … id = 1（Alice）

*** WE ROLL BACK TRANSACTION (2)                                          ← ⑩
```

**逐項對照**：

| # | 欄位 | 怎麼讀 |
|---|---|---|
| ① | 時間戳 | 🔴 **只有最近一次**。要留全部，開 `innodb_print_all_deadlocks=ON`（寫到 error log） |
| ② | `ACTIVE n sec` | 這個交易活了多久。**> 1 秒就代表交易太長** |
| ③ | `lock struct(s)` / `row lock(s)` | 鎖結構數 / 鎖了幾列。`row lock(s)` **很大**（上千）就是 4.5.6 的「鎖全表」 |
| ④ | `MySQL thread id` | = `CONNECTION_ID()`，可以拿去 `processlist` 對 |
| ⑤ | SQL | 🔴 **只有【正在等】的那一句**，看不到交易前面做了什麼 |
| ⑥ | `HOLDS THE LOCK(S)` | 已經拿到的鎖。`index PRIMARY` 告訴你走的是哪個索引 |
| ⑦ | `0: len 4; hex 80000001` | 第 0 欄的值。`80000001` 減去符號位 `0x80000000` = **1**（`id = 1`） |
| ⑧ | `asc Alice` | 字串欄位直接看得懂，**最快的定位方式** |
| ⑨ | `WAITING FOR` | 在等的鎖。**⑥ 和 ⑨ 交叉比對就是環** |
| ⑩ | `WE ROLL BACK` | 誰被犧牲了 |

📌 **解讀 `hex` 的規則**：

```
整數      →  第一個 byte 減 0x80（符號位）。80000001 → 1，80000002 → 2
字串      →  直接看 asc 欄
時間      →  DATETIME 是壓縮格式，很難手算 —— 用 asc 旁邊的其他欄位定位
第 1 欄   →  通常是 DB_TRX_ID（6 bytes）
第 2 欄   →  通常是 DB_ROLL_PTR（7 bytes）
```

⚠️ **`heap no` 是「這一列在頁面裡的實體位置」**，不是列號。
`heap no 2` 是**這一頁的第一筆真實資料**（heap no 0 是 infimum、1 是 supremum）。

**排查 SOP**：

```
① 找出【兩個】交易各自 HOLDS 什麼、WAITING 什麼
       → 畫出那個環
② 看 index 那一欄
       → PRIMARY？二級索引？兩邊【不一樣】就是 4.6.3 模式三
③ 看 lock_mode
       → 有 gap / insert intention → 4.6.3 模式二（間隙鎖）
       → 只有 rec but not gap      → 4.6.3 模式一（順序）
④ 看 row lock(s) 的數字
       → 幾千、幾萬 → 4.5.6 的「沒有索引」，先去補索引
⑤ 🔴 日誌只有【最後一句】SQL
       → 一定要回去看應用程式的日誌，還原整個交易做了哪些事
```

📌 **第 ⑤ 步是實務上最花時間的一步。**
建議在 service 層加一行結構化日誌，把「這個交易依序碰了哪些 key」記下來 ——
出事的時候它比死鎖日誌本身更有用。

### 4.6.3 五種常見死鎖模式（全部實測）

---

#### 模式一：加鎖順序相反 ★★★（最常見）

**成因**：兩段程式碼碰同一組資料，但順序不同。

```
A：先鎖 id=1，再鎖 id=2
B：先鎖 id=2，再鎖 id=1
```

**真實場景**：一張訂單有多個商品，扣庫存的時候按「訂單明細的順序」跑。
兩張訂單商品重疊、順序相反 → 死鎖。

```
訂單 X：[商品 2, 商品 3]      訂單 Y：[商品 3, 商品 2]

A> UPDATE stock SET qty = qty-1 WHERE product_id = 2 AND qty >= 1
                                  B> UPDATE stock SET qty = qty-1 WHERE product_id = 3 AND qty >= 1
A> UPDATE stock SET qty = qty-1 WHERE product_id = 3 AND qty >= 1
   ⏳ 阻塞中…
                                  B> UPDATE stock SET qty = qty-1 WHERE product_id = 2 AND qty >= 1
                                     🔴 ERROR 1213: Deadlock found
```

✅ **修法：全域固定一個加鎖順序。** 實測同樣兩筆訂單，改成一律按 `product_id` 由小到大：

```
A> UPDATE ... product_id = 2      B> UPDATE ... product_id = 2
                                     ⏳ 阻塞中…（只是排隊，不是死鎖）
A> UPDATE ... product_id = 3
A> COMMIT
                                  B  ← 解除阻塞：OK
                                  B> UPDATE ... product_id = 3
                                  B> COMMIT
✅ 兩筆都成功，一次死鎖都沒有
```

```java
// ✅ 在 service 層強制排序
List<OrderLine> lines = order.getLines().stream()
        .sorted(Comparator.comparing(OrderLine::getProductId))
        .toList();
for (OrderLine line : lines) {
    stockRepo.deduct(line.getProductId(), line.getQty());
}
```

📌 **這一招對「多列更新」型的死鎖，成功率接近 100%，而且成本幾乎是零。**
排序的鍵要選**穩定且全域一致**的（主鍵最好，不要用 `name` 這種會變的）。

---

#### 模式二：間隙鎖互等 ★★★（最難懂）

**兩邊都不碰同一列，一樣死鎖**：

```
lk 表：id = 5, 10, 15, 20, 25（12～19 之間是空的）

A> BEGIN                                      B> BEGIN
A> SELECT * FROM lk WHERE id = 17 FOR UPDATE  →  0 rows
                                              B> SELECT * FROM lk WHERE id = 18 FOR UPDATE  →  0 rows

M> SELECT * FROM locks_now ...
   | 461 | 7759 | PRIMARY | X,GAP | GRANTED | 20 |    ← A 的間隙鎖 (15,20)
   | 462 | 7760 | PRIMARY | X,GAP | GRANTED | 20 |    ← 🔴 B 也拿到了【同一個】間隙鎖

A> INSERT INTO lk VALUES (17,...)
   ⏳ 阻塞中…
                                              B> INSERT INTO lk VALUES (18,...)
                                                 🔴 ERROR 1213: Deadlock found
```

**死鎖日誌長這樣**：

```
*** (1) HOLDS THE LOCK(S):
   index PRIMARY ... lock_mode X locks gap before rec                 ← 間隙鎖
*** (1) WAITING FOR THIS LOCK TO BE GRANTED:
   index PRIMARY ... lock_mode X locks gap before rec insert intention waiting
                                                        ↑↑↑ 插入意向鎖
*** (2) HOLDS THE LOCK(S):
   index PRIMARY ... lock_mode X locks gap before rec                 ← 同一個間隙
*** (2) WAITING FOR THIS LOCK TO BE GRANTED:
   index PRIMARY ... lock_mode X locks gap before rec insert intention waiting
```

📌 **機制**（回顧 4.5.10 的相容表）：

```
間隙鎖 vs 間隙鎖    →  ✅ 相容  →  兩邊【都拿到】
插入意向鎖 vs 間隙鎖 →  🔴 衝突  →  兩邊【都要等對方放】
                                    → 環 → 死鎖
```

⚠️ **這個模式的可怕之處在於「程式碼看起來完全正確」**：

```java
// 🔴 每一個字都合理，但兩個執行緒同時跑就死鎖
var existing = repo.findByOrderNoForUpdate(orderNo);   // SELECT ... FOR UPDATE
if (existing.isEmpty()) {
    repo.insert(newOrder);                              // INSERT
}
```

✅ **三種修法**（由好到差）：

```sql
-- ① 最好：加唯一索引，直接插，讓 1062 幫你擋
INSERT INTO lk VALUES (17, ...);        -- catch DuplicateKeyException

-- ② 次好：用 INSERT ... ON DUPLICATE KEY UPDATE 或 INSERT IGNORE
INSERT INTO lk VALUES (17, ...) ON DUPLICATE KEY UPDATE d = VALUES(d);

-- ③ 換隔離級別：READ COMMITTED 沒有間隙鎖，這個模式直接消失
SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;
```

📌 **這是「`READ COMMITTED` 死鎖比較少」最具體的一個理由。**

---

#### 模式三：同一列，不同索引路徑

```
A 走主鍵：  UPDATE lk SET d = d+1 WHERE id = 5      →  PRIMARY 5
B 走二級索引：UPDATE lk SET d = d+1 WHERE c  = 250   →  k_c (250,25) → PRIMARY 25
```

實測：

```
A> UPDATE lk SET d = d + 1 WHERE id = 5       （鎖 PRIMARY 5）
                              B> UPDATE lk SET d = d + 1 WHERE c = 250    （鎖 k_c, 再鎖 PRIMARY 25）
A> UPDATE lk SET d = d + 1 WHERE id = 25
   ⏳ 阻塞中…（要 PRIMARY 25）
                              B> UPDATE lk SET d = d + 1 WHERE c = 50     （要 PRIMARY 5）
A  🔴 ERROR 1213: Deadlock found
```

📌 **成因**：A 的加鎖順序是「主鍵 5 → 主鍵 25」，
B 的順序是「`k_c` 50/250 → 主鍵 25 → 主鍵 5」。**主鍵的順序反了。**

⚠️ **模式一的修法（排序）在這裡不夠用**，因為「按什麼排序」在兩條路徑上不一樣。

✅ **修法**：

```
① 統一走同一個索引（例如都改成用主鍵更新）
② 先用一次 SELECT 把要改的主鍵撈出來、排序，再逐一按主鍵更新
③ 檢查那個二級索引是不是可以刪掉（4.5.7：索引會改變鎖）
```

---

#### 模式四：`INSERT ... ON DUPLICATE KEY UPDATE` 的三方死鎖

```
三個 session 同時對【同一個唯一鍵】做 upsert

A> INSERT INTO lk VALUES (30,...) ON DUPLICATE KEY UPDATE d = d + 1    ✅ 成功
B> 同一句
   ⏳ 阻塞中…
C> 同一句
   ⏳ 阻塞中…

M> SELECT * FROM locks_now WHERE tbl='lk'
   | 1095 | 34093 | PRIMARY | X,REC_NOT_GAP | GRANTED | 30 |   ← A（隱式鎖被轉正）
   | 1095 | 34094 | PRIMARY | X,REC_NOT_GAP | WAITING | 30 |   ← B
   | 1096 | 34095 | PRIMARY | X,REC_NOT_GAP | WAITING | 30 |   ← C

A> ROLLBACK
B  ← 解除阻塞：OK, 1 rows affected
C  🔴 ERROR 1213: Deadlock found
```

📌 **兩個等待者 + 一個回滾，就會出現死鎖。**
機制是：A 回滾後 B 拿到鎖並插入新列，C 手上還握著「A 那一列」的等待，
於是 C 的等待鏈變成了環。

✅ **修法**：`UPSERT` 高併發時**用重試**（4.7.5），不要想著「消滅」它。
另一個做法是先 `UPDATE`，`affected = 0` 才 `INSERT`：

```java
int n = jdbc.update("UPDATE lk SET d = d + 1 WHERE id = ?", 30);
if (n == 0) {
    try { jdbc.update("INSERT INTO lk VALUES (?,?,?,?)", 30, 300, 3000, 30000); }
    catch (DuplicateKeyException e) { jdbc.update("UPDATE lk SET d = d + 1 WHERE id = ?", 30); }
}
```

---

#### 模式五：`SERIALIZABLE` 的鎖升級

4.4.6 已經實測過：兩個交易各自拿到同一列的 `S` 鎖（相容），
然後兩邊都想升級成 `X` 鎖 → 環。

📌 **同樣的形狀也會出現在 `LOCK IN SHARE MODE`** ——
只要你寫了「先 `FOR SHARE` 讀、再 `UPDATE` 同一列」，就是這個模式。

```sql
-- 🔴 危險
SELECT balance FROM acct WHERE id = 1 LOCK IN SHARE MODE;
UPDATE acct SET balance = ? WHERE id = 1;

-- ✅ 一開始就拿 X 鎖
SELECT balance FROM acct WHERE id = 1 FOR UPDATE;
UPDATE acct SET balance = ? WHERE id = 1;
```

⚠️ **`LOCK IN SHARE MODE` 幾乎沒有正確的使用場景。**
如果你等一下要改它，就用 `FOR UPDATE`；如果不改，就用普通 `SELECT`。

---

### 4.6.4 死鎖偵測 vs 逾時：關掉會怎樣

InnoDB 預設 `innodb_deadlock_detect = ON`，每次有交易要等鎖，就走一次等待圖找環。

**關掉它會怎樣？** 實測（同樣的模式一劇本，`innodb_lock_wait_timeout = 5`）：

```
【偵測開啟】
B  🔴 ERROR 1213: Deadlock found ... [42.8 ms]     ← 42 毫秒，B 被砍
A  ← 解除阻塞：OK                                   ← A 立刻繼續

【偵測關閉】
B  🔴 ERROR 1205: Lock wait timeout exceeded [5010.8 ms]
A  🔴 ERROR 1205: Lock wait timeout exceeded [5416.7 ms]
   🔴🔴 兩個【都】死了，而且各等了 5 秒
```

| | `innodb_deadlock_detect = ON`（預設） | `OFF` |
|---|---|---|
| 發現死鎖要多久 | **42 ms** | `innodb_lock_wait_timeout`（預設 **50 秒**） |
| 死幾個 | **1 個**（挑成本小的） | 🔴 **全部**（互等的都逾時） |
| 偵測的成本 | 每次等鎖 O(等待圖大小) | 0 |
| 什麼時候該關 | 🔴 **幾乎不該關** | 極端熱點（同一列上千個等待者）且已有完整重試 |

📌 **`innodb_lock_wait_timeout` 的預設值 50 秒對 Web 服務太長了。**
使用者早就重整了、HTTP 也逾時了，你的連線還在那邊等。

```sql
-- 建議值：Web 請求 3～10 秒；批次作業可以長一點
SET SESSION innodb_lock_wait_timeout = 5;
```

```properties
# Spring Boot：連線建立時就設好
spring.datasource.hikari.connection-init-sql=SET SESSION innodb_lock_wait_timeout = 5
```

### 4.6.5 `1205` 和 `1213` 完全不一樣 ★★（本章最危險的一節）

大部分人把這兩個錯誤當成同一類（「就鎖住了嘛」）。**它們的行為天差地遠。**

```
【1205 鎖逾時】只回滾【最後那一句】，交易還活著

A> BEGIN
A> UPDATE acct SET balance = 111 WHERE id = 1      OK
A> UPDATE acct SET balance = 222 WHERE id = 2      🔴 ERROR 1205 (2042 ms)
A> SELECT id, balance FROM acct WHERE id IN (1,2)
   +----+-----------+
   | 1  | 111.0000  |     ← 🔴 第一句還在！
   | 2  | 1000.0000 |
   +----+-----------+
A> COMMIT
A> SELECT id, balance FROM acct WHERE id IN (1,2)
   +----+-----------+
   | 1  | 111.0000  |     🔴🔴 半個交易被提交了
   | 2  | 1000.0000 |
   +----+-----------+
```

```
【1213 死鎖】整個交易被回滾

B> BEGIN
B> UPDATE acct SET balance = 444 WHERE id = 2      OK
B> UPDATE acct SET balance = 666 WHERE id = 1      🔴 ERROR 1213
B> SELECT id, balance FROM acct WHERE id IN (1,2)
   +----+-----------+
   | 1  | 1000.0000 |
   | 2  | 1000.0000 |     ← ✅ 444 也被回滾了
   +----+-----------+
B> COMMIT                 （commit 一個空的交易，沒事）
```

| | `1205` 鎖逾時 | `1213` 死鎖 |
|---|---|---|
| 回滾範圍 | 🔴 **只有那一句** | ✅ 整個交易 |
| 交易還在嗎 | 🔴 **還在，還持有鎖** | ✅ 沒了，鎖全放了 |
| 如果你 `COMMIT` | 🔴🔴 **半個交易被提交** | ✅ 空 commit，無害 |
| 誰被犧牲 | 等的那一個 | InnoDB 挑成本小的 |
| 多久 | `innodb_lock_wait_timeout`（預設 50 秒） | ~40 ms |
| 常見成因 | 有人交易開太久（4.3.9） | 加鎖順序 / 間隙鎖 |

🔴 **`1205` 比 `1213` 危險，因為它會【安靜地】留下半個交易。**

✅ **Spring 幫你擋掉了大部分**：`@Transactional` 遇到任何 `RuntimeException`
（`DataAccessException` 是它的子類）都會 `rollback`。
**但前提是你沒有 `catch` 掉它** —— 4.7.1 的 P1 會實測那個後果。

⚠️ **手寫 JDBC 一定要注意**：

```java
// 🔴 錯：catch 之後照常 commit
try {
    stmt.executeUpdate("UPDATE ...");
} catch (SQLException e) {
    log.warn("更新失敗，略過", e);     // 1205 → 交易還活著
}
conn.commit();                        // 🔴 半個交易被提交

// ✅ 對：任何 SQLException 都要 rollback
try {
    stmt.executeUpdate("UPDATE ...");
    conn.commit();
} catch (SQLException e) {
    conn.rollback();
    throw e;
}
```

📌 **一個好用的區分**：

```java
public static boolean isRetryable(SQLException e) {
    return e.getErrorCode() == 1213    // Deadlock found
        || e.getErrorCode() == 1205;   // Lock wait timeout
}
// 兩者都可以重試，但 1205 之前【一定要先 rollback】
```

### 4.6.6 六條避免死鎖的規則

```
① 交易要短
     交易裡不要有 HTTP 呼叫、不要有 sleep、不要等使用者
     → 4.7.6 實測：150 ms 的 API 讓 20% 的請求連不上資料庫

② 加鎖順序全域一致
     多列更新一律按主鍵排序 → 消滅模式一

③ WHERE 的欄位一定要有索引
     → 4.5.6 實測：沒索引 = 鎖全表 = 吞吐量掉 10～29 倍

④ 「先查再插」改成「直接插，接 1062」
     → 消滅模式二（間隙鎖死鎖）

⑤ 不要用 LOCK IN SHARE MODE 之後再 UPDATE
     → 消滅模式五（鎖升級）

⑥ 🔴 接受死鎖會發生，寫重試
     前五條能大幅降低機率，但降不到零。
     高併發系統【一定】要有重試 → 4.7.5
```

📌 **另外三個「監控」的動作**：

```sql
-- ① 目前的鎖等待（正在發生的）
SELECT r.trx_id AS waiting_trx, r.trx_mysql_thread_id AS waiting_conn,
       LEFT(r.trx_query, 50) AS waiting_query,
       b.trx_id AS blocking_trx, b.trx_mysql_thread_id AS blocking_conn,
       LEFT(b.trx_query, 50) AS blocking_query,
       TIMESTAMPDIFF(SECOND, r.trx_wait_started, NOW()) AS wait_sec
FROM performance_schema.data_lock_waits w
JOIN information_schema.innodb_trx r ON r.trx_id = w.REQUESTING_ENGINE_TRANSACTION_ID
JOIN information_schema.innodb_trx b ON b.trx_id = w.BLOCKING_ENGINE_TRANSACTION_ID;

-- ② 累計死鎖次數（拿來畫監控圖）
--    ⚠️ MySQL 8.0.46 實測【沒有】 Innodb_deadlocks 這個狀態變數，網路上很多文章寫錯了
SELECT NAME, COUNT, STATUS FROM information_schema.INNODB_METRICS WHERE NAME LIKE '%deadlock%';
--    +-------------------------------+-------+---------+
--    | lock_deadlocks                | 7     | enabled |   ← 累計死鎖次數
--    | lock_deadlock_false_positives | 0     | enabled |
--    | lock_deadlock_rounds          | 38790 | enabled |   ← 偵測跑了幾輪（成本指標）
--    +-------------------------------+-------+---------+

-- ③ 把每一次死鎖都寫進 error log（預設只留最後一次！）
SET GLOBAL innodb_print_all_deadlocks = ON;
```

⚠️ **`innodb_print_all_deadlocks` 強烈建議在正式環境開啟。**
它的成本幾乎是零，而「只留最後一次」代表你永遠在調查**最新的**那一次，
而不是**最重要的**那一次。

---
## 4.7 Java / Spring 端

前面六節講的是資料庫。這一節講**你的程式碼**怎麼把它用壞。

### 4.7.1 `@Transactional` 的八個坑（全部實測）★★

**實驗環境**：Spring Boot 3.5.0 + JdbcTemplate + MySQL 8.0.46。
`acct` 三列，每次實驗前重置成 `balance = 1000`。

---

#### P1 `catch` 掉例外 → 交易**不會**回滾 🔴

```java
@Transactional
public void swallow() {
    jdbc.update("UPDATE acct SET balance = balance - 100 WHERE id = 1");
    try {
        jdbc.update("UPDATE acct SET balance = balance - 99999 WHERE id = 2");   // 違反 CHECK
    } catch (DataAccessException e) {
        System.out.println("內層吃掉了：" + e.getClass().getSimpleName());
    }
}
```

```
內層吃掉了：UncategorizedSQLException
結果：[{id=1, balance=900.0000}, {id=2, balance=1000.0000}, {id=3, balance=1000.0000}]
        🔴 id=1 少了 100，而且【已經 commit】
```

📌 **這就是 4.2.2 那條分界線在 Java 世界的樣子。**
`CHECK` 失敗（`3819`）只回滾那一句，交易還活著；
你 `catch` 掉了，Spring 不知道出過事，方法正常返回 → `commit`。

✅ **修法**：

```java
// 方法 A：不要 catch，讓它往上拋
// 方法 B：真的要 catch，就手動標記回滾
@Transactional
public void fixed() {
    jdbc.update("UPDATE acct SET balance = balance - 100 WHERE id = 1");
    try {
        jdbc.update("UPDATE acct SET balance = balance - 99999 WHERE id = 2");
    } catch (DataAccessException e) {
        TransactionAspectSupport.currentTransactionStatus().setRollbackOnly();
        // 或直接 throw
    }
}
```

---

#### P2 Checked exception → 預設**不**回滾 🔴

```java
@Transactional
public void checkedEx() throws IOException {
    jdbc.update("UPDATE acct SET balance = balance - 100 WHERE id = 1");
    throw new IOException("寄信失敗");
}
```

```
外層看到：IOException
結果：[{id=1, balance=900.0000}, ...]      🔴 沒有回滾
```

📌 **Spring 的預設規則**：

```
RuntimeException 及其子類  →  回滾 ✅
Error                      →  回滾 ✅
Exception（checked）       →  🔴【不】回滾
```

⚠️ **這是 Spring 從 2003 年沿用至今的設計**（理由是「checked exception 是可預期的業務情況」），
但它幾乎總是不符合直覺。

---

#### P3 `rollbackFor = Exception.class` ✅

```java
@Transactional(rollbackFor = Exception.class)
public void checkedExFixed() throws IOException {
    jdbc.update("UPDATE acct SET balance = balance - 100 WHERE id = 1");
    throw new IOException("寄信失敗");
}
```

```
外層看到：IOException
結果：[{id=1, balance=1000.0000}, ...]     ✅ 回滾了
```

📌 **建議把它設成專案的預設**，用 meta-annotation：

```java
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
@Transactional(rollbackFor = Exception.class)
public @interface TxRequired {}
```

---

#### P4 自我呼叫 → `@Transactional` 完全沒生效 🔴🔴

```java
public void selfInvoke() {
    inner();                    // ← this.inner()，不經過 Spring 的代理
}

@Transactional
public void inner() {
    jdbc.update("UPDATE acct SET balance = balance - 100 WHERE id = 1");
    throw new IllegalStateException("內層炸了");
}
```

```
外層看到：IllegalStateException
結果：[{id=1, balance=900.0000}, ...]      🔴 沒有回滾 —— 因為【根本沒有交易】
```

📌 **`@Transactional` 是靠動態代理實作的。**
`selfInvoke()` 呼叫 `inner()` 的時候是 `this.inner()`，
**沒有經過代理物件**，所以那個註解完全沒有作用。

```
外部呼叫： caller → [Proxy] → OrderService.inner()      ✅ 代理攔得到
自我呼叫：          OrderService.selfInvoke()
                        └─ this.inner()                  🔴 代理看不到
```

⚠️ **同樣沒效的還有**：

```
private 方法上的 @Transactional        →  🔴 代理不了
final 方法上的 @Transactional          →  🔴 CGLIB 不能覆寫
static 方法上的 @Transactional         →  🔴 完全無效
被 @Async 或新執行緒呼叫                →  🔴 交易不會傳遞（ThreadLocal）
```

✅ **修法：注入自己（要加 `@Lazy`）或抽成另一個 Bean。**

```java
@Service
class OrderService {
    // 🔴 Spring Boot 3 預設【禁止循環依賴】，不加 @Lazy 會啟動失敗：
    //    "The dependencies of some of the beans in the application context form a cycle"
    @Autowired @Lazy OrderService self;

    public void selfInvoke() {
        self.inner();       // ✅ 走代理
    }
}
```

📌 **更乾淨的做法是抽一個 Bean 出來** ——
需要自我注入通常代表這個 service 做了兩件事，該拆了。

---

#### P5 沒有交易時，Spring **不會**報錯 🔴

```java
public void noTx() {            // ← 沒有 @Transactional
    System.out.println("目前有交易嗎？" + TransactionSynchronizationManager.isActualTransactionActive());
    jdbc.update("UPDATE acct SET balance = balance - 100 WHERE id = 1");
    System.out.println("這一句已經自動 commit 了");
}
```

```
目前有交易嗎？false
這一句已經自動 commit 了
結果：[{id=1, balance=900.0000}, ...]
```

📌 **忘了加 `@Transactional`，程式碼會【正常執行】，只是每一句各自 autocommit。**
單筆操作沒差；多筆操作就是「做到一半掛掉，留下一半資料」。

✅ **加一道防線**：在關鍵方法開頭斷言。

```java
Assert.state(TransactionSynchronizationManager.isActualTransactionActive(), "必須在交易中執行");
```

---

#### P6 `readOnly = true` 會擋寫入 ✅

```java
@Transactional(readOnly = true)
public void readOnlyWrite() {
    System.out.println("readOnly？" + TransactionSynchronizationManager.isCurrentTransactionReadOnly());
    jdbc.update("UPDATE acct SET balance = balance - 100 WHERE id = 1");
}
```

```
readOnly？true
外層看到：TransientDataAccessResourceException /
         StatementCallback; SQL [UPDATE acct SET ...];
         Connection is read-only. Queries leading to data modification are not allowed.
結果：[{id=1, balance=1000.0000}, ...]     ✅ 沒寫進去
```

📌 **`readOnly = true` 做了三件事**：

```
① JDBC Connection.setReadOnly(true) → MySQL 拒絕任何寫入
② Hibernate 會關掉 dirty checking（不做髒檢查、不 flush）
③ 讀寫分離的路由（07 章）可以靠它決定走從庫
```

⚠️ **但它【不會】縮短交易。** 一個 `readOnly = true` 但跑了 5 分鐘的報表查詢，
一樣會撐大 undo（4.3.8）、一樣會擋住 DDL（4.5.4）。

---

#### P7 `REQUIRES_NEW`：外層回滾，內層留下

```java
@Transactional
public void outerWithRequiresNew() {
    jdbc.update("UPDATE acct SET balance = balance - 100 WHERE id = 1");
    self.auditNew();                            // REQUIRES_NEW
    throw new IllegalStateException("外層炸了");
}

@Transactional(propagation = Propagation.REQUIRES_NEW)
public void auditNew() {
    jdbc.update("UPDATE acct SET balance = balance - 1 WHERE id = 3");
}
```

```
外層看到：IllegalStateException
結果：[{id=1, balance=1000.0000}, {id=2, balance=1000.0000}, {id=3, balance=999.0000}]
        ↑ 外層回滾了                                          ↑ 🔴 內層留下來了
```

📌 **這正是 `REQUIRES_NEW` 的用途**：稽核日誌、操作紀錄 ——
「就算主流程失敗，我也要留下紀錄」。

⚠️ **兩個代價**：

```
① 它會【借用第二條連線】 → 連線池要夠大，否則自己等自己（死結）
② 外層持有的鎖，內層看不到 → 內層碰到同一列會【卡住直到 timeout】
```

---

#### P8 巢狀 `REQUIRED`：內層 `catch` 了，外層還是死 🔴🔴

```java
@Transactional
public void outerWithRequired() {
    jdbc.update("UPDATE acct SET balance = balance - 100 WHERE id = 1");
    try {
        self.innerRequired();
    } catch (RuntimeException e) {
        System.out.println("外層以為自己接住了：" + e.getClass().getSimpleName());
    }
}

@Transactional(propagation = Propagation.REQUIRED)      // 預設值
public void innerRequired() {
    jdbc.update("UPDATE acct SET balance = balance - 1 WHERE id = 3");
    throw new IllegalStateException("內層炸了");
}
```

```
外層以為自己接住了：IllegalStateException
外層看到：UnexpectedRollbackException /
         Transaction rolled back because it has been marked as rollback-only
結果：[{id=1, balance=1000.0000}, {id=2, balance=1000.0000}, {id=3, balance=1000.0000}]
```

📌 **機制**：

```
REQUIRED 的內層【不是新交易】，它加入外層那一個
    ↓
內層拋例外 → Spring 在【同一個】交易上打了 rollback-only 標記
    ↓
外層 catch 住了，以為沒事，正常返回
    ↓
🔴 Spring 要 commit 的時候發現標記還在 → 丟 UnexpectedRollbackException
```

⚠️ **這個錯誤訊息是 Spring 交易最常見的線上例外之一**，
而它的成因幾乎總是「某個地方 `catch` 了一個內層交易方法的例外」。

✅ **修法**：

```
① 內層改成 REQUIRES_NEW（真的希望它獨立失敗）
② 外層不要 catch（讓整個交易一起死）
③ 內層不要標 @Transactional（純粹是外層的一部分）
```

---

**八個坑總表**：

| # | 情境 | 會怎樣 | 修法 |
|---|---|---|---|
| P1 | `catch` 掉 `DataAccessException` | 🔴 交易照樣 commit | `setRollbackOnly()` 或不要 catch |
| P2 | 拋 checked exception | 🔴 不回滾 | `rollbackFor = Exception.class` |
| P3 | `rollbackFor = Exception.class` | ✅ 回滾 | 設成專案預設 |
| P4 | 自我呼叫 / private / final / static | 🔴 註解完全無效 | `@Lazy` 自我注入或拆 Bean |
| P5 | 忘了加 `@Transactional` | 🔴 每句各自 autocommit | 開頭 `Assert.state(...)` |
| P6 | `readOnly = true` | ✅ 擋寫入 | 唯讀方法都加上 |
| P7 | `REQUIRES_NEW` | 內層獨立 commit | 稽核日誌用；注意連線數 |
| P8 | 巢狀 `REQUIRED` + 外層 catch | 🔴 `UnexpectedRollbackException` | 改 `REQUIRES_NEW` 或不 catch |

### 4.7.2 20 個人搶 10 個庫存：六種寫法實測 ★★

**實驗**：`stock` 一列，`qty = 10`，`CHECK (qty >= 0)`。
20 個執行緒同時搶，每個搶 1 個。**正確答案：10 個成功、10 個失敗、剩餘 0。**

---

**① 讀-改-寫（寫絕對值）** —— 開場那一段

```java
int qty = query("SELECT qty FROM stock WHERE product_id = 1");
if (qty <= 0) return false;
update("UPDATE stock SET qty = ? WHERE product_id = 1", qty - 1);
```

```
成功=20  失敗=0   剩餘=9   🔴 超賣 19 個   CHECK=0   耗時=116 ms
```

---

**② 原子 `UPDATE`，但沒有 `qty >= 1` 條件**

```java
update("UPDATE stock SET qty = qty - 1 WHERE product_id = 1");
```

```
成功=10  失敗=10  剩餘=0   ✅ 沒有超賣   🔴 CHECK 觸發 10 次   耗時=64 ms
```

📌 **結果是對的，但方式是錯的** ——
它靠 `CHECK` 丟例外來擋，等於**用錯誤處理當流程控制**。
每一次失敗都是一個 `SQLException`（堆疊追蹤 + 日誌 + 回滾），成本高得多。

---

**③ 原子 `UPDATE` + 條件** ✅

```java
int n = update("UPDATE stock SET qty = qty - 1 WHERE product_id = 1 AND qty >= 1");
return n == 1;
```

```
成功=10  失敗=10  剩餘=0   ✅ 沒有超賣   CHECK=0   耗時=34 ms   ← 🏆 最快
```

---

**④ 悲觀鎖 `SELECT ... FOR UPDATE`** ✅

```java
int qty = query("SELECT qty FROM stock WHERE product_id = 1 FOR UPDATE");
if (qty <= 0) return false;
update("UPDATE stock SET qty = ? WHERE product_id = 1", qty - 1);
```

```
成功=10  失敗=10  剩餘=0   ✅ 沒有超賣   CHECK=0   耗時=37 ms
```

---

**⑤ 樂觀鎖 `version`（不重試）** 🔴

```java
var row = query("SELECT qty, version FROM stock WHERE product_id = 1");
if (row.qty <= 0) return false;
int n = update("UPDATE stock SET qty = ?, version = version + 1 " +
               "WHERE product_id = 1 AND version = ?", row.qty - 1, row.version);
return n == 1;
```

```
成功=2   失敗=18  剩餘=8   🔴 只賣掉 2 個   耗時=27 ms
```

📌 **樂觀鎖不重試，等於「20 個人搶，18 個直接放棄」。**
熱點資料上的樂觀鎖，**衝突率極高**。

---

**⑥ 樂觀鎖 + 重試 10 次** ✅

```java
for (int attempt = 0; attempt < 10; attempt++) {
    var row = query("SELECT qty, version FROM stock WHERE product_id = 1");
    if (row.qty <= 0) return false;
    int n = update("UPDATE stock SET qty = ?, version = version + 1 " +
                   "WHERE product_id = 1 AND version = ?", row.qty - 1, row.version);
    if (n == 1) return true;
    conn.commit();      // 🔴 關鍵：重試前【必須結束舊交易】
}
return false;
```

```
成功=10  失敗=10  剩餘=0   ✅ 沒有超賣   CHECK=0   耗時=78 ms
```

⚠️ **注意那行 `conn.commit()`。** 沒有它，在 `REPEATABLE READ` 下
你每次重讀 `version` 都會拿到**同一個快照**（4.3.4），
於是 10 次重試全部用同一個過期的 `version` —— **重試變成純粹的浪費**。

📌 **這是樂觀鎖在 MySQL RR 下最常見的實作錯誤。**
在 Spring 裡對應的是：**重試必須在 `@Transactional` 的【外面】**（4.7.5）。

---

**六種寫法總表**（`REPEATABLE READ`，重跑三次結果穩定）：

| # | 寫法 | 成功 | 剩餘 | 超賣 | CHECK | 耗時 | 評價 |
|---|---|:---:|:---:|:---:|:---:|:---:|---|
| ① | 讀-改-寫（絕對值） | 20 | 9 | 🔴 **19** | 0 | 116 ms | 🔴 **絕對不行** |
| ② | `qty = qty - 1`（無條件） | 10 | 0 | 無 | 🔴 10 | 64 ms | 🟡 對但浪費 |
| ③ | `qty = qty - 1 AND qty >= 1` | 10 | 0 | 無 | 0 | **34 ms** | ✅ **首選** |
| ④ | `FOR UPDATE` | 10 | 0 | 無 | 0 | 37 ms | ✅ 邏輯複雜時用 |
| ⑤ | 樂觀鎖不重試 | 🔴 2 | 8 | 無 | 0 | 27 ms | 🔴 賣不完 |
| ⑥ | 樂觀鎖 + 重試 | 10 | 0 | 無 | 0 | 78 ms | ✅ 衝突少時用 |

**`READ COMMITTED` 下重跑，結論完全一樣**：

```
① 成功=20 剩餘=9 超賣=19    ← 🔴 換隔離級別救不了它
③ 成功=10 剩餘=0            ← ✅
⑤ 成功=2  剩餘=8            ← 🔴
```

📌 **這是本章最重要的一張表。它說的是**：

> **超賣不是「隔離級別不夠高」造成的，是【程式碼結構】造成的。
> 把 `RR` 換成 `SERIALIZABLE` 也救不了 ①，把 ① 改成 ③ 只要五分鐘。**

### 4.7.3 為什麼 `CHECK (qty >= 0)` 一次都沒觸發

回到開場那個問題。答案在寫法 ① 和 ② 的對照裡：

```
①  UPDATE stock SET qty = ? WHERE product_id = 1        -- ? = 9（每個執行緒都算出 9）
        ↓
    每一個執行緒寫進去的都是【9】
        ↓
    9 >= 0  ✅ CHECK 通過
        ↓
    🔴 CHECK 永遠不會被觸發，因為【從來沒有人試圖寫入負數】

②  UPDATE stock SET qty = qty - 1 WHERE product_id = 1  -- 當前讀
        ↓
    第 11 個執行緒讀到 qty = 0，算出 -1
        ↓
    -1 >= 0  🔴 CHECK 觸發
```

📌 **`CHECK` 檢查的是「你寫進去的值」，不是「你的業務邏輯」。**
寫法 ① 每一次寫入單獨看都合法，
**錯的是「20 個人都以為自己是第一個」** —— 而這件事資料庫看不到。

⚠️ **這是 01 章「約束是最後一道防線」那句話的反面**：

> **約束擋得住「錯的值」，擋不住「對的值在錯的時候被寫進去」。**
> 前者是資料完整性問題，後者是併發問題 —— **是兩件不同的事。**

📌 **同樣的道理適用於**：

```
唯一索引  →  擋得住「兩筆一樣的資料」，擋不住「先查再插」的競態（4.6.3 模式二）
外鍵      →  擋得住「指向不存在的父列」，擋不住「父列在你插完之後被刪」（除非它加鎖，4.5.12）
NOT NULL  →  擋得住 NULL，擋不住「應該是 A 卻寫成 B」
```

### 4.7.4 悲觀鎖 vs 樂觀鎖怎麼選

| | 悲觀鎖（`FOR UPDATE`） | 樂觀鎖（`version`） |
|---|---|---|
| 機制 | **先鎖再改** | **改的時候檢查有沒有人插隊** |
| 衝突時 | 排隊等 | 失敗 → 重試 |
| 適合 | **衝突機率高**（熱門商品、帳戶餘額） | **衝突機率低**（使用者資料、設定） |
| 不適合 | 交易長、鎖持有久 → 拖垮全站 | 熱點資料 → 實測成功率 **10%**（⑤） |
| 死鎖風險 | 🔴 有（4.6.3 模式一） | ✅ 沒有（不加鎖） |
| 對 DB 的壓力 | 鎖等待佇列 | 失敗的 `UPDATE` 也要跑一次 |
| 分散式友善 | 🔴 綁在一個 DB 交易裡 | ✅ 可以跨請求（把 version 帶到前端） |

📌 **決策流程**：

```
這個更新可以寫成【一句原子 UPDATE】嗎？
    ├─ 可以  →  ✅ 用 ③（UPDATE ... WHERE 條件），不要用鎖
    └─ 不行（要讀出來做複雜計算 / 呼叫別的服務）
            ↓
        這一列的併發衝突多嗎？
            ├─ 多（秒殺、熱門商品）  →  悲觀鎖 FOR UPDATE
            │                          （或乾脆別用 DB，用 Redis —— 10 章）
            └─ 少（一般 CRUD）       →  樂觀鎖 version + 重試
```

⚠️ **樂觀鎖有一個「假的實作」要避免**：

```java
// 🔴 假樂觀鎖：用 updated_at 當版本
UPDATE t SET ..., updated_at = NOW(3) WHERE id = ? AND updated_at = ?
```

`DATETIME(3)` 只到毫秒（01 章）。同一毫秒內的兩次更新會**看起來版本相同** ——
高併發下這個「樂觀鎖」形同虛設。**一定要用單調遞增的整數 `version`。**

### 4.7.5 重試模板

**重試必須在交易【外面】。** 這是最常見的錯誤：

```java
// 🔴 錯：重試在交易裡面
@Transactional
public void placeOrder(Order o) {
    for (int i = 0; i < 3; i++) {
        try { doPlace(o); return; }
        catch (DeadlockLoserDataAccessException e) { /* 重試 */ }
    }
}
```

**為什麼錯**：死鎖（`1213`）已經把**整個交易**回滾了（4.6.5）。
你在同一個 `@Transactional` 裡重試，等於在一個**已經死掉的交易**裡繼續寫 ——
Spring 最後會丟 `UnexpectedRollbackException`（就是 P8）。

✅ **正確的分層**：

```java
@Service
public class OrderFacade {
    private static final Logger log = LoggerFactory.getLogger(OrderFacade.class);
    private final OrderService orderService;      // 這一層才有 @Transactional

    public OrderFacade(OrderService orderService) { this.orderService = orderService; }

    /** 重試在交易【外】：每一次重試都是一個全新的交易 */
    public void placeOrder(Order order) {
        int maxAttempts = 3;
        for (int attempt = 1; ; attempt++) {
            try {
                orderService.placeOrderTx(order);      // ← 走代理，開新交易
                return;
            } catch (DeadlockLoserDataAccessException
                   | CannotAcquireLockException
                   | OptimisticLockingFailureException e) {
                if (attempt >= maxAttempts) {
                    log.error("下單重試 {} 次仍失敗 orderNo={}", maxAttempts, order.getOrderNo(), e);
                    throw e;
                }
                long backoffMs = (1L << (attempt - 1)) * 20 + ThreadLocalRandom.current().nextInt(20);
                log.warn("下單第 {} 次衝突，{} ms 後重試 orderNo={}", attempt, backoffMs, order.getOrderNo());
                try { Thread.sleep(backoffMs); }
                catch (InterruptedException ie) { Thread.currentThread().interrupt(); throw e; }
            }
        }
    }
}

@Service
class OrderService {
    @Transactional(rollbackFor = Exception.class)
    public void placeOrderTx(Order order) { /* … 真正的下單邏輯 … */ }
}
```

📌 **Spring 例外對照表**：

| MySQL 錯誤 | Spring 例外 | 可以重試？ |
|---|---|:---:|
| `1213` Deadlock found | `DeadlockLoserDataAccessException` | ✅ |
| `1205` Lock wait timeout | `CannotAcquireLockException` | ✅（見下方 ⚠️） |
| 樂觀鎖 `version` 不符（你自己丟） | `OptimisticLockingFailureException` | ✅ |
| `1062` Duplicate entry | `DuplicateKeyException` | 🔴 **不要重試**（重試幾次都一樣） |
| `3819` Check constraint violated | `DataIntegrityViolationException` | 🔴 不要重試 |
| `1452` FK constraint fails | `DataIntegrityViolationException` | 🔴 不要重試 |

⚠️ **`1205` 可以重試，但要小心**：它代表「有人的交易開太久」，
盲目重試只會**加劇**擁塞。看到大量 `1205` 應該先去查 4.3.9 的長交易，而不是加大重試次數。

**用 `spring-retry` 的版本**（比較簡潔，但要記得放在**外層** Bean）：

```java
@Retryable(
    retryFor = { DeadlockLoserDataAccessException.class, CannotAcquireLockException.class },
    maxAttempts = 3,
    backoff = @Backoff(delay = 20, multiplier = 2, random = true))
public void placeOrder(Order order) {
    orderService.placeOrderTx(order);
}
```

📌 **`random = true` 很重要**（jitter）。
沒有它，兩個死鎖的交易會在同一時刻同時重試 —— **再死一次**。

### 4.7.6 交易邊界：150 ms 的 API 讓 20% 的請求連不上資料庫 ★★

**這是本章「交易要短」最具體的證據。**

```java
/** ✅ 正確：外部呼叫在交易【外面】 */
public void apiOutside(int pid) {
    callExternalApi();          // 150 ms
    deduct(pid);                // @Transactional
}

/** 🔴 錯誤：外部呼叫在交易【裡面】 */
@Transactional
public void apiInside(int pid) {
    jdbc.update("UPDATE stock SET qty = qty - 1 WHERE product_id = ? AND qty >= 1", pid);
    callExternalApi();          // 150 ms —— 這 150 ms 裡，連線和行鎖都被綁著
}
```

**實測**：HikariCP 連線池 20 條，`connection-timeout = 2000 ms`，40 個並行請求。

```
A 交易【外】呼叫 API，各自不同列    40 個請求  成功=40  失敗=0    186 ms   {}
B 交易【內】呼叫 API，各自不同列    40 個請求  成功=40  失敗=0    616 ms   {}       ← 3.3 倍
C 交易【內】呼叫 API，全部搶同一列  40 個請求  成功=32  失敗=8   5071 ms
                                                     🔴 {CannotCreateTransactionException=8}
```

📌 **三段的差別**：

```
A：交易只有一句 UPDATE（< 1 ms）→ 20 條連線輪流用，40 個請求兩批就跑完
    186 ms ≈ 150 ms（API）+ 一點點

B：每個交易佔用連線 150 ms → 40 個請求 / 20 條連線 = 2 批 × 150 ms
    616 ms ≈ 交易【外】的 3.3 倍，純粹是連線池排隊

C：加上熱點列的行鎖 → 40 個請求【完全序列化】，每個佔 150 ms
    理論上 40 × 150 ms = 6000 ms
    🔴 但 connection-timeout 只有 2000 ms
    → 8 個請求【連連線都拿不到】就直接失敗
```

🔴 **注意 C 的失敗型態：`CannotCreateTransactionException`。**
它不是「SQL 執行失敗」，是**根本沒能開始**。
在監控上它長得像「資料庫掛了」，但資料庫其實好好的 ——
**是你的交易把連線池佔光了。**

⚠️ **這個錯誤有一個很惡毒的特性：它會傳染。**

```
商品服務的下單交易裡呼叫了金流 API（150 ms）
        ↓
連線池被佔滿
        ↓
🔴 同一個服務裡【完全無關】的查詢（例如「查我的訂單列表」）也拿不到連線
        ↓
整個服務 503，而慢的只有下單那一條路徑
```

✅ **交易邊界的四條規則**：

```
① 交易裡【只有】資料庫操作
     不呼叫 HTTP / gRPC / 訊息佇列 / 檔案 I/O / Thread.sleep

② 需要「DB 改完之後發訊息」→ 用 Outbox 模式（11 章）
     交易裡只寫一列 outbox_message，另一個 worker 負責送出

③ 需要「外部呼叫成功才改 DB」→ 拆成兩個交易
     交易1：寫入 PENDING
     外部呼叫（交易外）
     交易2：改成 SUCCESS / FAILED

④ 交易開始前把要用的資料都準備好
     🔴 for (item : items) { callApi(item); update(item); }
     ✅ var results = items.map(this::callApi);   // 交易外
        tx(() -> results.forEach(this::update));  // 交易內
```

📌 **怎麼發現既有程式碼裡的違規**：

```bash
# 找出 @Transactional 方法裡有 RestTemplate / WebClient / FeignClient 的
grep -rn -A 40 "@Transactional" src/main/java \
  | grep -E "restTemplate|webClient|feignClient|HttpClient|Thread.sleep"
```

更可靠的做法是加一個 AOP 切面，在交易活躍時偵測到 HTTP 呼叫就**記警告**：

```java
@Aspect @Component
public class TxHttpGuard {
    private static final Logger log = LoggerFactory.getLogger(TxHttpGuard.class);

    @Before("execution(* org.springframework.web.client.RestTemplate.*(..)) " +
            "|| execution(* org.springframework.web.reactive.function.client.WebClient.*(..))")
    public void warnIfInTransaction(JoinPoint jp) {
        if (TransactionSynchronizationManager.isActualTransactionActive()) {
            log.warn("🔴 在交易中呼叫外部 API：{}", jp.getSignature());
        }
    }
}
```

### 4.7.7 只讀交易

```java
@Transactional(readOnly = true)
public List<OrderDto> findMyOrders(UUID customerId) { ... }
```

📌 **加上它有四個好處**：

```
① MySQL 端：連線標記為唯讀，寫入會被擋（P6 實測）
② InnoDB：唯讀交易不分配真的 trx_id（4.2.6），省下交易 ID 序號與部分開銷
③ Hibernate/JPA：關掉 dirty checking，省下每次 flush 的比對成本
④ 讀寫分離：路由層可以據此把查詢送去從庫（07 章）
```

⚠️ **但唯讀交易一樣有 4.3.8 的長交易問題。**
真正的規則是：

```
單筆查詢          →  🟡 不加 @Transactional 也可以（每句自己 autocommit）
多筆查詢要一致視角 →  ✅ @Transactional(readOnly = true)，而且【要快】
報表 / 大範圍掃描  →  🔴 不要放在跟線上流量同一個 DB 上（07 章：讀寫分離 / 專用副本）
```

### 4.7.8 JDBC 與連線池的三個設定

```properties
# ① 行鎖等待：預設 50 秒對 Web 太長
spring.datasource.hikari.connection-init-sql=SET SESSION innodb_lock_wait_timeout=5

# ② 拿不到連線就快速失敗（別讓請求無限排隊）
spring.datasource.hikari.connection-timeout=3000

# ③ 連線最長壽命，避免長連線累積問題（要小於 MySQL 的 wait_timeout）
spring.datasource.hikari.max-lifetime=1740000
spring.datasource.hikari.maximum-pool-size=20
```

📌 **`maximum-pool-size` 的常見迷思：不是越大越好。**

```
連線池 = 200，MySQL 只有 8 核
    ↓
200 個查詢同時進去，CPU 排程開銷 + 鎖競爭爆炸
    ↓
🔴 吞吐量【比 20 條連線還低】
```

**經驗公式**（HikariCP 官方建議）：

```
連線數 ≈ CPU 核心數 × 2 + 有效磁碟數
8 核 + SSD → 大約 17 ～ 20 條
```

⚠️ **如果 20 條不夠用，答案通常不是「加到 100」，而是「找出誰佔著連線不放」**
—— 而那個答案，八成就在 4.7.6。

---
## 4.8 shop-service 的交易設計

把前面所有東西套到一個真實的下單流程上。

### 4.8.1 實驗：30 張並行訂單，四種設計

**情境**：30 個使用者同時下單，每張訂單 2 個商品，
**商品池只有 3 個**（`product_id` 1/2/3，各 100 件）——
所以商品必然重疊，這是最壞情況。

**交易內容**：

```
INSERT INTO ord (order_no, customer_id, status, total, idempotency_key)   -- 有兩個唯一索引
FOR each 明細：
    扣庫存
    INSERT INTO ord_item
COMMIT
```

**四種設計的差別只有兩個開關**：扣庫存用「讀-改-寫」還是「原子 UPDATE」，
明細要不要**按 `product_id` 排序**。

```
                                     成功  死鎖  | 扣掉的庫存  明細筆數   一致？
① 讀-改-寫 + 明細順序不固定            24     6   |      3        48      🔴
① 讀-改-寫 + 明細順序不固定            26     4   |      7        52      🔴
② 讀-改-寫 + 按 product_id 排序        30     0   |      5        60      🔴
② 讀-改-寫 + 按 product_id 排序        30     0   |      3        60      🔴
③ 原子 UPDATE + 順序不固定             26     4   |     52        52      ✅
③ 原子 UPDATE + 順序不固定             19    11   |     38        38      ✅
④ 原子 UPDATE + 按 product_id 排序     30     0   |     60        60      ✅
④ 原子 UPDATE + 按 product_id 排序     24     6   |     48        48      ✅
```

📌 **這張表要橫著看，也要豎著看**：

```
【死鎖】那一欄  →  由「有沒有排序」決定    （② 和 ④ 明顯比 ① 和 ③ 少）
【一致】那一欄  →  由「原子 UPDATE」決定  （③ 和 ④ 全對，① 和 ② 全錯）
```

🔴 **② 是最值得看的一組**：

> **它把死鎖降到 0，資料卻是錯的 ——
> 60 筆明細只扣了 3～5 件庫存。**

**「沒有死鎖」不代表「正確」。** 如果你的監控只盯著 `1213` 的次數，
② 這種設計看起來會是四種裡面最健康的一種。

⚠️ **而 ③ 反過來：資料永遠正確，但死鎖率高達 13～37%。**
在有重試（4.7.5）的前提下 ③ 是可以接受的；沒有重試就會變成「三成的使用者下單失敗」。

### 4.8.2 ④ 為什麼還是會死鎖：不是庫存的錯

④ 已經「按 `product_id` 排序」了，為什麼還會出現 6 次死鎖？

**用控制變因的方式拆開來量**（每組跑 20 次）：

```
① 只有 stock 的原子 UPDATE（已排序）        20 次執行共  0 次死鎖
② + INSERT INTO ord（兩個唯一索引）        20 次執行共 16 次死鎖   🔴
③ + INSERT INTO ord_item                  20 次執行共 22 次死鎖
```

🔴 **死鎖的來源是 `INSERT INTO ord`，不是庫存扣減。** 死鎖日誌：

```
*** (1) TRANSACTION: 45464   INSERT INTO ord (...) VALUES ('SO-7', 7, ...)
*** (1) HOLDS THE LOCK(S):
   index uk_ord_no of table `shop5`.`ord`  lock mode S locks gap before rec
*** (1) WAITING FOR THIS LOCK TO BE GRANTED:
   index uk_ord_no of table `shop5`.`ord`  lock_mode X locks gap before rec insert intention waiting

*** (2) TRANSACTION: 45452   INSERT INTO ord (...) VALUES ('SO-8', 8, ...)
*** (2) HOLDS THE LOCK(S):
   index uk_ord_no ... lock mode S locks gap before rec          ← 同一個間隙
*** (2) WAITING FOR THIS LOCK TO BE GRANTED:
   index uk_ord_no ... lock_mode X locks gap before rec insert intention waiting
```

📌 **這是 4.6.3 的模式二，只是換了一個地方發生**：

```
INSERT 進唯一索引 → 要先檢查「這個值存不存在」→ 拿一個【S 間隙鎖】（4.5.11）
    ↓
兩個交易插入【不同的值】，但落在【同一個間隙】→ 兩邊都拿到 S 間隙鎖（相容 ✅）
    ↓
兩邊接著要真的插進去 → 都要插入意向鎖 → 🔴 互相衝突 → 環
```

⚠️ **「落在同一個間隙」比你想的容易發生。**
這裡的 `order_no` 是 `SO-0` ～ `SO-29` 的字串，
而字串排序是 `SO-1 < SO-10 < SO-11 < … < SO-19 < SO-2 < SO-20 < …` ——
**新插入的值大量集中在少數幾個間隙裡。**

📌 **這推翻了一個常見的想法**：

> **「我的訂單號都不一樣，插入不會衝突」—— 錯。
> 唯一索引上的插入，衝突的是【間隙】，不是【值】。**

**四種緩解方向**：

| 做法 | 效果 | 代價 |
|---|---|---|
| **`READ COMMITTED`** | ✅ 沒有間隙鎖 → 這個死鎖直接消失 | 要重新檢視程式碼對快照的假設（4.4.8） |
| **主鍵用單調遞增值** | ✅ 插入永遠落在**最右邊**那個間隙 | `order_no` 是業務欄位，不好改 |
| **`order_no` 補零成定長** | 🟡 `SO-00000007` → 字典序 = 數值序，插入集中在尾端 | 只是把衝突集中，不是消滅 |
| **重試**（4.7.5） | ✅ **一定要有** | 少量的延遲 |

📌 **注意第三行剛好對應 01 章的決定**：
`order_no` 用 `SO-YYYY-NNNNNNNN`（定長補零）而不是 `SO-{流水號}`。
當時的理由是「排序與可讀性」；**現在多了一個理由：它讓插入集中在索引尾端，減少間隙鎖衝突。**

### 4.8.3 最終的下單交易設計

```java
@Service
public class PlaceOrderService {

    private final JdbcTemplate jdbc;

    /**
     * 下單交易。設計決策：
     *  1. 交易【只包】資料庫操作 —— 金流、通知都在交易外（4.7.6）
     *  2. 明細一律按 productId 排序後處理 —— 消滅加鎖順序死鎖（4.6.3 模式一）
     *  3. 扣庫存用【原子 UPDATE + 條件】—— 消滅更新遺失（4.7.2 寫法 ③）
     *  4. 冪等鍵用唯一索引擋重複 —— 不做「先查再插」（4.6.3 模式二）
     *  5. 不用 SELECT ... FOR UPDATE —— 沒有需要「讀出來算」的邏輯
     *  6. 交易外層一定有重試 —— 4.8.2 證明死鎖消不掉
     */
    @Transactional(rollbackFor = Exception.class, timeout = 5)
    public long placeOrderTx(PlaceOrderCommand cmd) {

        // ① 冪等：直接插，撞到唯一索引就代表重複請求
        long orderId;
        try {
            orderId = insertOrder(cmd);
        } catch (DuplicateKeyException e) {
            // 已經下過這張單 → 回傳既有的 orderId（不是錯誤）
            return findOrderIdByIdempotencyKey(cmd.idempotencyKey());
        }

        // ② 明細排序：全域一致的加鎖順序
        List<OrderLine> lines = cmd.lines().stream()
                .sorted(Comparator.comparing(OrderLine::productId))
                .toList();

        // ③ 逐筆扣庫存：一句話完成「檢查 + 扣減」
        for (OrderLine line : lines) {
            int affected = jdbc.update("""
                    UPDATE stock
                       SET qty = qty - ?, version = version + 1
                     WHERE product_id = ?
                       AND qty >= ?
                    """, line.qty(), line.productId(), line.qty());
            if (affected == 0) {
                // 不是例外情況，是正常的業務結果 → 用明確的業務例外
                throw new InsufficientStockException(line.productId());
            }
            insertOrderItem(orderId, line);
        }
        return orderId;
    }
}
```

**外層（重試 + 交易外的動作）**：

```java
@Service
public class PlaceOrderFacade {

    public OrderResult placeOrder(PlaceOrderCommand cmd) {
        // 🔴 交易【外】：所有外部呼叫
        PricingResult pricing = pricingClient.quote(cmd);        // HTTP
        PlaceOrderCommand priced = cmd.withPricing(pricing);     // 🔴 不能改 cmd：lambda 要求 effectively final

        long orderId = retryOnConflict(() -> placeOrderService.placeOrderTx(priced));

        // 🔴 交易【外】：付款、通知（用 Outbox 模式更好 —— 11 章）
        paymentClient.authorize(orderId, pricing.total());
        return new OrderResult(orderId);
    }

    private <T> T retryOnConflict(Supplier<T> action) {
        for (int attempt = 1; ; attempt++) {
            try { return action.get(); }
            catch (DeadlockLoserDataAccessException | CannotAcquireLockException e) {
                if (attempt >= 3) throw e;
                sleepWithJitter(attempt);
            }
        }
    }
}
```

📌 **這段程式碼裡的每一個決定，都對應本章的一個實測**：

| 決定 | 為什麼 | 實測依據 |
|---|---|---|
| 交易只包 DB 操作 | 150 ms 的 API 讓 20% 的請求連不上 DB | 4.7.6 |
| 明細按 `productId` 排序 | 死鎖從 4～11 次降到 0 | 4.8.1 ①→② |
| 原子 `UPDATE ... AND qty >= ?` | 讀-改-寫扣 60 件只扣掉 3 件 | 4.8.1 ②→④ |
| 冪等鍵直接插、接 `1062` | 「先查再插」= 間隙鎖死鎖 | 4.6.3 模式二 |
| `timeout = 5` | 預設 `innodb_lock_wait_timeout` 是 50 秒 | 4.6.4 |
| `rollbackFor = Exception.class` | checked exception 預設不回滾 | 4.7.1 P2 |
| 重試在交易【外】 | 死鎖已經回滾了整個交易 | 4.6.5 / 4.7.5 |
| 一定要有重試 | ④ 排序過了還是 6/30 死鎖 | 4.8.2 |

### 4.8.4 一組可以放進 CI 的併發守門測試

03 章 3.10.6 給了執行計畫的守門測試。這一章的守門測試要跑**真的併發**。

```java
@SpringBootTest
class ConcurrencyGateTest {

    @Autowired PlaceOrderFacade facade;
    @Autowired JdbcTemplate jdbc;

    private static final int THREADS = 30;

    /** 硬斷言 ①：不能超賣 —— 扣掉的庫存必須等於明細筆數 */
    @Test
    void 併發下單不會超賣() throws Exception {
        jdbc.update("UPDATE stock SET qty = 100 WHERE product_id IN (1,2,3)");
        jdbc.update("DELETE FROM ord_item"); jdbc.update("DELETE FROM ord");

        runConcurrently(THREADS, i -> facade.placeOrder(sampleOrder(i)));

        Integer deducted = jdbc.queryForObject(
                "SELECT 300 - SUM(qty) FROM stock WHERE product_id IN (1,2,3)", Integer.class);
        Integer items = jdbc.queryForObject("SELECT COUNT(*) FROM ord_item", Integer.class);

        assertThat(deducted)
            .as("扣掉的庫存必須等於成功建立的明細筆數（4.7.2 寫法 ③）")
            .isEqualTo(items);
    }

    /** 硬斷言 ②：庫存不可以是負的（就算 CHECK 沒觸發也要驗） */
    @Test
    void 庫存不會變成負數() throws Exception {
        jdbc.update("UPDATE stock SET qty = 5 WHERE product_id = 1");   // 刻意設得比執行緒數少
        runConcurrently(THREADS, i -> {
            try { facade.placeOrder(singleItemOrder(i, 1)); }
            catch (InsufficientStockException ignored) { /* 預期內 */ }
        });
        Integer qty = jdbc.queryForObject("SELECT qty FROM stock WHERE product_id = 1", Integer.class);
        assertThat(qty).isGreaterThanOrEqualTo(0);
    }

    /** 硬斷言 ③：冪等 —— 同一個 idempotency_key 打 20 次，只能有一張訂單 */
    @Test
    void 重複請求只會建立一張訂單() throws Exception {
        String key = UUID.randomUUID().toString();
        runConcurrently(20, i -> facade.placeOrder(sampleOrder(1).withIdempotencyKey(key)));
        Integer n = jdbc.queryForObject(
                "SELECT COUNT(*) FROM ord WHERE idempotency_key = ?", Integer.class, key);
        assertThat(n).isEqualTo(1);
    }

    /** 軟斷言：死鎖率 —— 會隨版本 / 機器變動，超標【記警告】不要讓 CI 紅 */
    @Test
    void 死鎖率不應該太高() throws Exception {
        long before = deadlockCount();
        runConcurrently(THREADS, i -> facade.placeOrder(sampleOrder(i)));
        long delta = deadlockCount() - before;
        if (delta > THREADS * 0.3) {
            System.out.printf("⚠️ 死鎖率 %d/%d 偏高，請檢查加鎖順序（4.6.3）%n", delta, THREADS);
        }
    }

    /** 硬斷言 ④：交易裡不可以有外部呼叫（靜態掃描，比執行期偵測可靠） */
    @Test
    void 交易方法裡沒有外部呼叫() {
        // 用 ArchUnit：@Transactional 的方法不得依賴 RestTemplate / WebClient / FeignClient
        ArchRule rule = noClasses()
                .that().areAnnotatedWith(Transactional.class)
                .should().dependOnClassesThat().haveSimpleNameEndingWith("Client");
        rule.check(new ClassFileImporter().importPackages("com.example.shop"));
    }

    private long deadlockCount() {
        return jdbc.queryForObject(
                "SELECT COUNT FROM information_schema.INNODB_METRICS WHERE NAME = 'lock_deadlocks'",
                Long.class);
    }

    private void runConcurrently(int n, IntConsumer body) throws Exception {
        var gate = new CountDownLatch(1);
        var done = new CountDownLatch(n);
        var pool = Executors.newFixedThreadPool(n);
        for (int i = 0; i < n; i++) {
            final int no = i;
            pool.submit(() -> {
                try { gate.await(); body.accept(no); }
                catch (Exception ignored) { }
                finally { done.countDown(); }
            });
        }
        gate.countDown();
        assertThat(done.await(60, TimeUnit.SECONDS)).as("60 秒內要跑完").isTrue();
        pool.shutdownNow();
    }
}
```

📌 **硬斷言 vs 軟斷言的分界**（沿用 03 章 3.10.6 的原則）：

```
硬斷言（CI 紅燈）  →  【結果的正確性】：不超賣、不負數、冪等
                       這些跟版本、機器、時序無關，錯了就是錯了

軟斷言（只記警告）  →  【效能與機率】：死鎖率、耗時
                       會隨 MySQL 版本、CPU 核心數、其他測試干擾而變
                       設成硬斷言只會讓大家習慣性 rerun
```

⚠️ **併發測試最常見的三個寫錯的地方**：

```
🔴 用 @Transactional 標測試方法
     → 整個測試在一個交易裡跑，所有執行緒都看不到彼此 → 永遠 pass

🔴 用 @DirtiesContext + H2
     → H2 的鎖模型跟 InnoDB【完全不同】，測不出間隙鎖、測不出死鎖
     → 併發測試一定要跑真的 MySQL（Testcontainers 或共用的測試 DB）

🔴 只跑一次就下結論
     → 4.8.1 的 ④ 有兩次 0 死鎖、兩次 6～8 次死鎖
     → 併發測試至少跑 5 次取最壞值
```

---
## 4.9 常見誤區

**誤區 1：「SQL 報錯了，交易就會回滾」**

→ 4.2.2 實測：`CHECK` 失敗（`3819`）之後，前一句的 `UPDATE` **還在**，
交易還活著。4.6.5 實測 `1205`（鎖逾時）也一樣 —— 而且 `COMMIT` 下去
會**提交半個交易**。**只有 `1213`（死鎖）會回滾整個交易。**

**誤區 2：「`BEGIN` 之後就有一致性快照了」**

→ 4.3.5 實測：`BEGIN` 之後 B 提交的資料，A 的第一句 `SELECT` **看得到**。
ReadView 是在**第一次快照讀**時才建的。要在 `BEGIN` 那一刻凍結，
用 `START TRANSACTION WITH CONSISTENT SNAPSHOT`——
而它在 `READ COMMITTED` 下**只會給你一個 `Warning 138`，靜默失效**。

**誤區 3：「`REPEATABLE READ` 保證我讀到的一直是同一個值」**

→ 4.3.6 實測：`SELECT` 說 1000，下一句 `UPDATE ... balance + 1` 算出來是 **1501**。
**快照讀和當前讀是兩套機制**，`UPDATE` / `DELETE` / `FOR UPDATE` 一律讀最新版。

**誤區 4：「`REPEATABLE READ` 擋住了幻讀，所以我的併發程式碼是安全的」**

→ 4.4.5 實測：兩個帳戶總和從 2000 掉到 **400**，而兩個交易**都沒有做錯事**。
寫偏斜是 `SERIALIZABLE` 才擋得住的異常。
**而更新遺失（4.4.4，實測 800 而不是 700）連 `SERIALIZABLE` 都要靠排隊才擋得住。**

**誤區 5：「加了 `CHECK` 約束就不會超賣」**

→ 4.7.3 實測：20 個執行緒搶 10 件庫存，超賣 **19 件**，`CHECK` **一次都沒觸發**。
因為每一個執行緒寫進去的都是合法的 `9`。
**約束擋得住「錯的值」，擋不住「對的值在錯的時候被寫進去」。**

**誤區 6：「`WHERE` 只命中一列，就只會鎖一列」**

→ 4.5.5 的 L7 實測：`WHERE d = 15000`（`d` 沒有索引）回傳 1 列，
鎖住了**整張表的 6 個 next-key，含 `supremum`**。
**鎖的數量 = `EXPLAIN` 的 `rows`（掃描列數），不是結果列數。**

**誤區 7：「`SELECT` 查不到東西就不會加鎖」**

→ 4.5.5 的 L2 / L6 實測：`WHERE id = 17 FOR UPDATE` 回傳 0 列，
但鎖住了 `(15, 20)` 這整段間隙。
**這就是「先查再插」會死鎖的全部原因**（4.6.3 模式二）。

**誤區 8：「我的訂單號都不一樣，插入不會互相衝突」**

→ 4.8.2 實測：30 筆**互不相同**的 `order_no` 插入同一個唯一索引，
20 次執行出現 **16 次死鎖**。
**唯一索引上的插入，衝突的是【間隙】不是【值】** ——
而字串排序讓 `SO-1 … SO-19` 全部擠在同一個間隙裡。

**誤區 9：「間隙鎖之間會互相排斥」**

→ 4.5.10 實測：兩個交易**同時**持有 `(15,20)` 的間隙鎖，`GRANTED` 兩筆。
間隙鎖彼此完全相容；它只擋**插入意向鎖**。
**而這正是模式二死鎖的成因** —— 兩邊都拿到，然後兩邊都想插。

**誤區 10：「加索引只影響查詢效能」**

→ 4.5.7 實測：同一個 `WHERE`，只因為 `SELECT` 的欄位不同，
優化器換了索引（`PRIMARY` → `uk_u`），**鎖的位置和筆數（7 → 12）都變了**。
**索引會改變加鎖範圍 —— 一個純為效能加的索引可能製造出新的死鎖。**

**誤區 11：「覆蓋索引不用回表，所以也不用鎖主鍵」**

→ 4.5.8 實測：`SELECT c FROM lk WHERE c = 150 FOR UPDATE`（完全覆蓋）
**還是在 `PRIMARY` 上加了記錄鎖**。
**覆蓋索引省 I/O，省不了鎖。**

**誤區 12：「`1205` 和 `1213` 都是鎖問題，處理方式一樣」**

→ 4.6.5 實測：`1213` 回滾整個交易；`1205` **只回滾那一句、交易還持有鎖**。
`1205` 之後如果 `COMMIT`，你會提交半個交易。
**兩者都可重試，但 `1205` 之前一定要先 `ROLLBACK`。**

**誤區 13：「加了 `@Transactional` 就有交易了」**

→ 4.7.1 實測四種失效情況：**自我呼叫**（P4）、`private`、`final`、`static`。
P4 的輸出證明「拋了 `RuntimeException` 卻沒有回滾」——
因為**根本沒有交易**。而 P5 證明：忘了加 `@Transactional`，
程式碼會**正常執行**，只是每一句各自 autocommit。

**誤區 14：「我 `catch` 住了，所以交易沒事」**

→ 4.7.1 的 P1 實測：`catch` 掉 `DataAccessException` 之後，交易照樣 **commit**。
P8 更慘：巢狀 `REQUIRED` 的內層拋例外、外層 `catch` 住，
最後拿到 `UnexpectedRollbackException` —— **例外接住了，交易還是死了。**

**誤區 15：「樂觀鎖比悲觀鎖好，因為不用加鎖」**

→ 4.7.2 實測：樂觀鎖不重試，20 個人搶 10 件，**只賣掉 2 件**。
熱點資料上的樂觀鎖衝突率極高。
**而且在 `REPEATABLE READ` 下，重試前不 `commit` 舊交易，
你每次重讀到的都是同一個過期的 `version`** —— 重試完全無效。

**誤區 16：「交易裡呼叫個 API 而已，最多慢一點」**

→ 4.7.6 實測：150 ms 的 API 放進交易，40 個並行請求裡有 **8 個
連資料庫連線都拿不到**（`CannotCreateTransactionException`）。
**而且它會傳染** —— 同一個服務裡完全無關的查詢也一起 503。

**誤區 17：「唯讀交易沒有副作用，開多久都沒關係」**

→ 4.3.8 實測：一個什麼都沒做的唯讀交易，讓自己的同一句 `SELECT`
從 **6.4 ms 變成 127.4 ms**，而旁邊的新交易只要 2.6 ms。
4.5.4 更狠：一個沒 `commit` 的 `SELECT` + 一個 `ALTER`
= **整張表連讀都讀不了**。

**誤區 18：「排好加鎖順序就不會死鎖了」**

→ 4.8.2 實測：庫存扣減完全按 `product_id` 排序之後，
**單看庫存表 20 次執行 0 死鎖**；
但加上 `INSERT INTO ord` 之後，**20 次執行 16 次死鎖**。
**你只排序了你想到的那張表。死鎖率降得下去，但降不到零 ——
所以重試不是可選項。**

**誤區 19：「用 H2 跑併發測試就夠了」**

→ H2 的鎖模型跟 InnoDB **完全不同**：沒有間隙鎖、沒有 MVCC 版本鏈、
死鎖偵測行為也不一樣。本章 90% 的現象在 H2 上**測不出來**。
**併發測試一定要跑真的 MySQL。**

**誤區 20：「死鎖多就把 `innodb_deadlock_detect` 關掉」**

→ 4.6.4 實測：關掉之後，同一個死鎖從「**42 ms，死 1 個**」
變成「**5 秒，兩個都死**」。
**關掉偵測不會減少死鎖，只會讓你更晚知道、而且死更多。**

---

## 4.10 本章練習

### 練習 1：讀鎖

在你自己的 `lk` 表上跑下面五句，**先寫下你的預測**，再看 `locks_now`：

```sql
-- ① SELECT * FROM lk WHERE id > 20 FOR UPDATE;
-- ② SELECT * FROM lk WHERE c >= 150 AND c < 250 FOR UPDATE;
-- ③ SELECT * FROM lk WHERE u > 3000 FOR UPDATE;
-- ④ DELETE FROM lk WHERE c = 150;
-- ⑤ UPDATE lk SET c = 999 WHERE id = 15;
```

每一句都要回答三件事：

```
(a) 鎖在哪個索引上？（提示：先跑 EXPLAIN）
(b) LOCK_MODE 是哪一種？鎖住的實際區間是什麼？
(c) 別人現在可以插入 id = 17 嗎？可以插入 c = 175 嗎？
```

⚠️ **⑤ 特別注意**：更新一個**有索引的欄位**，
InnoDB 是「改值」還是「刪掉舊的 + 插入新的」？這對鎖有什麼影響？

### 練習 2：找出你自己專案裡的長交易

```sql
SELECT trx_id, trx_state,
       TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS age_sec,
       trx_mysql_thread_id AS conn_id,
       trx_rows_locked, trx_rows_modified,
       IFNULL(LEFT(trx_query, 60), '(閒置中！)') AS q
FROM information_schema.innodb_trx
ORDER BY trx_started;
```

在你的**測試環境**跑一次壓測，同時每秒跑一次上面這句。

```
① 有沒有 q = '(閒置中！)' 的交易？它是哪一段程式碼開的？
② 最長的 age_sec 是多少？超過 1 秒嗎？
③ trx_rows_locked 最大是多少？如果是幾千，去看那句 SQL 的 EXPLAIN
```

### 練習 3：重現本章的每一個死鎖模式

用兩個 MySQL client（或本章的劇本執行器），依序重現：

```
模式一（順序相反）      → 然後改成排序，驗證死鎖消失
模式二（間隙鎖）        → 然後改成 READ COMMITTED，驗證死鎖消失
模式三（不同索引路徑）  → 然後把二級索引設成 INVISIBLE（03 章 3.8.4），看死鎖還在不在
模式五（S 鎖升級）      → 然後改成一開始就 FOR UPDATE
```

每一個都要把 `SHOW ENGINE INNODB STATUS` 的死鎖區段存下來，
**並在上面圈出「誰持有什麼、誰在等什麼」**。

### 練習 4：把 4.7.2 的六種寫法全部跑一次 ★

用 20 個執行緒搶 10 件庫存，六種寫法各跑三次，填完這張表：

| 寫法 | 成功 | 剩餘 | 超賣 | CHECK | 耗時 |
|---|---|---|---|---|---|
| ① 讀-改-寫 | | | | | |
| ② `qty = qty - 1` | | | | | |
| ③ `qty = qty - 1 AND qty >= 1` | | | | | |
| ④ `FOR UPDATE` | | | | | |
| ⑤ 樂觀鎖不重試 | | | | | |
| ⑥ 樂觀鎖 + 重試 | | | | | |

然後**把 ⑥ 裡面重試前的 `conn.commit()` 拿掉**，再跑一次。

```
問題：成功數變成多少？為什麼？
（提示：4.3.4 —— RR 的 ReadView 什麼時候重建？）
```

### 練習 5：`READ COMMITTED` 會讓你的程式碼壞掉嗎 ★

把你專案的隔離級別從 `REPEATABLE READ` 改成 `READ COMMITTED`，
然後回答：

```
① 有沒有哪個 @Transactional 方法裡讀了同一筆資料【兩次】？
     → 在 RC 下這兩次可能不一樣，你的邏輯撐得住嗎？

② 有沒有「SELECT COUNT(*) 判斷 → 再 INSERT」的地方？
     → RC 沒有間隙鎖，這個競態會【更容易】發生

③ 有沒有依賴「先查再插會被間隙鎖擋住」的程式碼？
     → 它在 RR 下是靠死鎖擋住的，在 RC 下會【兩筆都插進去】
```

⚠️ **這一題沒有標準答案，它的目的是讓你發現「隔離級別是程式碼的一部分」。**

### 練習 6：加一個索引，然後看它改變了什麼鎖 ★

```sql
-- 現在的鎖
BEGIN;
SELECT * FROM lk WHERE d = 15000 FOR UPDATE;
SELECT * FROM locks_now;
ROLLBACK;

-- 加索引
ALTER TABLE lk ADD INDEX k_d (d);

-- 再看一次
BEGIN;
SELECT * FROM lk WHERE d = 15000 FOR UPDATE;
SELECT * FROM locks_now;
ROLLBACK;
```

```
① 鎖從幾筆變成幾筆？
② 用 4.5.6 的方法量一次併發吞吐量，差幾倍？
③ 現在把索引設成 INVISIBLE（03 章 3.8.4），鎖會變回去嗎？
   —— 這一題的答案會告訴你「不可見索引」到底藏了什麼、沒藏什麼
```

---

## 4.11 完成本章後，請確認你有

```
✅ 一份交易邊界檢查清單
     ├─ 每一個 @Transactional 方法都列出「它碰了哪些表、哪些列」
     ├─ ★ 交易裡【沒有】HTTP / gRPC / MQ / 檔案 I/O / sleep（4.7.6）
     ├─ 每一個交易的預期執行時間 < 100 ms（超過的要有理由）
     └─ rollbackFor = Exception.class（或專案層級的 meta-annotation）

✅ 一份加鎖順序約定
     ├─ 多列更新一律按【主鍵】排序（4.6.3 模式一）
     ├─ 寫成 code review checklist，不是寫在 wiki 裡
     └─ ★ 但要知道它降不到零（4.8.2：16/20 次死鎖來自唯一索引插入）

✅ 一個重試機制
     ├─ 位置在 @Transactional 的【外面】（4.7.5）
     ├─ 只重試 1213 / 1205 / OptimisticLockingFailureException
     ├─ 🔴 不要重試 1062 / 3819 / 1452
     ├─ 指數退避 + jitter（random = true）
     └─ 重試耗盡要記 ERROR 並帶上業務識別碼

✅ 一組併發守門測試（4.8.4）
     ├─ 硬斷言：不超賣、不負數、冪等
     ├─ 軟斷言：死鎖率（只記警告）
     ├─ ArchUnit：@Transactional 的類別不得依賴 *Client
     ├─ 🔴 跑真的 MySQL，不要用 H2
     └─ 至少跑 5 次取最壞值

✅ 一組監控與告警
     ├─ innodb_trx 的 max(age_sec) > 60 秒 → 告警
     ├─ trx_rseg_history_len > 100000 → 告警
     ├─ INNODB_METRICS 的 lock_deadlocks 增量 → 畫圖
     ├─ data_lock_waits 有列 → 記錄等待者與阻塞者的 SQL
     └─ ★ innodb_print_all_deadlocks = ON（預設只留最後一次！）

✅ 一份設定檢查
     ├─ innodb_lock_wait_timeout：Web 服務 3～10 秒（預設 50 太長）
     ├─ lock_wait_timeout（MDL）：DDL 前 SET SESSION 成 5 秒（預設一年！）
     ├─ HikariCP connection-timeout：3 秒
     ├─ maximum-pool-size：CPU × 2 + 磁碟數，不是越大越好
     └─ innodb_flush_log_at_trx_commit + sync_binlog：金流資料保持 1 + 1

✅ 一份排查 SOP
     ├─ ① 卡住了 → information_schema.processlist 看 STATE
     │      「Waiting for table metadata lock」→ 4.5.4（MDL）
     │      「statistics」/「updating」        → 4.6.6 的鎖等待查詢
     ├─ ② 死鎖 → SHOW ENGINE INNODB STATUS 的 LATEST DETECTED DEADLOCK
     │      看 index 那一欄 → 兩邊不一樣？模式三
     │      看 lock_mode  → 有 gap / insert intention？模式二
     │      看 row lock(s) → 上千？先去補索引（4.5.6）
     ├─ ③ 變慢 → innodb_trx 的 age_sec + trx_rseg_history_len（4.3.9）
     └─ ④ 連不上 DB → 先看是不是 CannotCreateTransactionException（4.7.6）

✅ 你能回答這十個問題（不查資料）
     ├─ CHECK 約束為什麼擋不住超賣？
     ├─ ReadView 是什麼時候建立的？RR 和 RC 差在哪？
     ├─ 為什麼 SELECT 說 1000，UPDATE ... +1 卻算出 1501？
     ├─ 一個「什麼都沒做」的唯讀交易，能造成多大的傷害？（兩種）
     ├─ 為什麼 WHERE 只命中一列，卻可能鎖住整張表？
     ├─ 為什麼查不到資料的 SELECT 也會加鎖？
     ├─ 為什麼兩個插入【不同值】的 INSERT 會死鎖？
     ├─ 1205 和 1213 的行為差在哪？哪一個比較危險？
     ├─ @Transactional 有哪四種「完全失效」的寫法？
     └─ 為什麼重試一定要在交易外面？
```

---

## 4.12 本章的實驗環境與結果

**環境**：

| 項目 | 版本 / 規模 |
|---|---|
| 資料庫 | **MySQL 8.0.46**（Docker），預設 `REPEATABLE READ`，`autocommit = 1` |
| 預設參數 | `innodb_lock_wait_timeout = 50`、`innodb_deadlock_detect = ON`、`innodb_flush_log_at_trx_commit = 1`、`sync_binlog = 1`、`log_bin = 1` |
| 應用程式 | **JDK 21**、mysql-connector-j **8.3.0**、Spring Boot **3.5.0** + JdbcTemplate + HikariCP |
| 實驗表 | `acct` 3 列、`lk` 5 列（id 有間隔）、`stock` 1～3 列、`seat` 20000 列、`ord` / `ord_item` |
| 平台 | macOS 14.2.1 / Apple Silicon |
| 執行方式 | 自製的多 session 劇本執行器（`A>` 同步 / `A!` 非同步 / `JOIN`），所有交錯時序都是**真的併發** |

⚠️ **「`lk` 的 id 刻意留間隔（5,10,15,20,25）」是本章大量實測的關鍵** ——
連續的 id 會讓間隙變成空的，你就看不到間隙鎖。

**跑過的實驗（59 組）**：

| 組 | 實驗 | 結果 |
|---|---|---|
| **A1** | 原子性 / 語句失敗 ★ | 🔴 `CHECK` 失敗（`3819`）之後**前一句的 700 還在**，交易還活著；`COMMIT` 會提交半個交易 |
| **A2** | DDL 隱式提交 | 🔴 `BEGIN` → `UPDATE` → `CREATE TABLE` → `ROLLBACK`，值**沒有回滾**（Carol = 1.0000） |
| **A3** | 交易何時開始 | ✅ `BEGIN` 之後 `innodb_trx` 仍是 0 列；第一次讀才出現，`trx_id` 是 15 位的**唯讀假 ID**（`562947581611224`）；寫入後才變成真 ID（`7735`） |
| **A4** | `innodb_trx` 看不到自己 🔴 | 🔴 從 A 自己查 `innodb_trx` **0 列**，從 M 查得到 A 的交易 —— 排查一定要開另一條連線 |
| **A5** | 持久性 TPS | ✅ `1+1` **2691 TPS** / `1+0` 4128 / `2+0` 8612 / `0+0` **9610（3.6 倍）** |
| **A6** | 批次 vs 逐筆 | ✅ 500 個交易 483 ms（1035 筆/秒）vs 1 個交易 500 筆 **76 ms（6579 筆/秒，6.4 倍）** |
| **M1** | RC 不可重複讀 | ✅ read1 = 1000 → B commit → read2 = **1500** |
| **M2** | RR 可重複讀 | ✅ read1 = 1500 → B commit → read2 = **1500**；交易結束後才看到 1000 |
| **M3** | ReadView 建立時機 ★★ | 🔴 `BEGIN` 之後 B commit 的 2000 **A 讀得到**；第二次才凍結在 2000 |
| **M4** | `WITH CONSISTENT SNAPSHOT` | ✅ RR 下立即凍結（讀到 3000 而非 4000）<br>🔴 RC 下**靜默失效**，只有 `Warning 138` |
| **M5** | 快照讀 vs 當前讀 | ✅ 同一交易裡：普通 `SELECT` **4000**、`LOCK IN SHARE MODE` **5000**、`FOR UPDATE` **5000** |
| **M6** | `UPDATE` 用當前讀 ★★ | 🔴 A 快照讀 **1000**，B commit +500，A 執行 `balance + 1` → **1501**（不是 1001） |
| **M7** | 半幻讀 ★ | ✅ 快照 count 5 → 5（沒有幻讀）<br>🔴 `UPDATE ... BETWEEN` **改到 6 列**，之後 count 變 **6** —— 自己改過的列變可見 |
| **M8** | 長交易的代價 ★★ | 🔴 同一句 `SELECT`：0 輪 **6.4 ms** → 20 輪（B 累計改 40 萬列）**127.4 ms（20 倍）**<br>✅ 對照：全新交易同一句 **2.6 ms（差 49 倍）**；`history_len` 每輪 +1 |
| **I1** | 髒讀（RU） | 🔴 A 讀到 B 未提交的 **999999**，B 回滾後變回 1000 |
| **I2** | 更新遺失 | 🔴 A 扣 100、B 扣 200，B 被行鎖擋住並排隊，最終 **800**（應為 700） |
| **I3** | 寫偏斜（RR 擋不住）★★ | 🔴 兩帳戶各 1000、各領 800，總和從 **2000 掉到 400**，兩個交易都沒做錯事 |
| **I4** | 寫偏斜的修法 | ✅ `SELECT SUM(...) FOR UPDATE` → B 被擋住，解除後看到 **1200** 可以正確拒絕 |
| **I5** | `SERIALIZABLE` 的 S 鎖 | 🔴 一句普通 `SELECT` 產生 `S,REC_NOT_GAP`，擋住別人的 `UPDATE` |
| **I6** | `SERIALIZABLE` 擋寫偏斜 | ✅ 擋住了 —— **但方式是製造死鎖**（`1213`），兩邊都拿到 S 鎖後互相升級 |
| **L1** | 主鍵等值命中 | ✅ 只有 `X,REC_NOT_GAP` on 15（唯一索引退化成記錄鎖） |
| **L2** | 主鍵等值**不命中** ★ | 🔴 回傳 0 列，仍加 `X,GAP` on 20 → 鎖住 `(15,20)` |
| **L3** | 主鍵範圍 `>=15 AND <21` ★ | 🔴 鎖到 `X,GAP on 25` —— **條件寫 `<21`，實際鎖到 25** |
| **L4** | 非唯一二級索引等值 | 🔴 三個鎖：`k_c` next-key `(100,150]` + `k_c` gap `(150,200)` + `PRIMARY` 記錄鎖 15 |
| **L5** | 唯一二級索引等值命中 | ✅ 兩個記錄鎖（`uk_u` + `PRIMARY`），**沒有間隙鎖** |
| **L6** | 唯一二級索引**不命中** | 🔴 `X,GAP on (2000,20)` —— 一樣鎖間隙 |
| **L7** | **無索引欄位** ★★ | 🔴🔴 回傳 **1 列**，鎖住 **6 個 next-key 含 `supremum`** = 整張表 |
| **L8** | 索引 vs 無索引的併發 ★★ | 🔴 RR：**1758 → 162 TPS（10.8 倍）**；RC：**7515 → 257 TPS（29.2 倍）** |
| **L9** | 鎖跟著優化器選的索引 ★★ | 🔴 `SELECT id`（覆蓋）走 `uk_u` → **12 筆鎖**；`SELECT *` 走 `PRIMARY` → **7 筆鎖**。同一個 `WHERE` |
| **L10** | 二級索引鎖兩處 | ✅ `UPDATE ... WHERE c = 150` → `k_c` 兩筆 + `PRIMARY` 一筆 |
| **L11** | 覆蓋索引**省不了鎖** | 🔴 `SELECT c FROM lk WHERE c = 150 FOR UPDATE`（完全覆蓋）**仍然鎖 `PRIMARY` 15** |
| **L12** | RC 無間隙鎖 | ✅ 同一句範圍查詢只剩兩個 `X,REC_NOT_GAP`；B 插入 17 **不被擋** |
| **L13** | RC 半一致性讀 | ✅ 無索引的 `UPDATE` / `FOR UPDATE` 只保留**命中列**的鎖（1 筆 vs RR 的 6 筆） |
| **L14** | 插入意向鎖相容性 ★ | ✅ 同一間隙插 16 和 17 **互不阻塞**；但 A 持有間隙鎖時，B 的 `X,GAP,INSERT_INTENTION` **WAITING** |
| **L15** | 唯一鍵衝突拿 S 鎖 ★ | ✅ B 撞重複值時要的是 **`S`** 不是 `X`<br>🔴 `data_locks.THREAD_ID` 顯示的是**建立鎖紀錄的執行緒**（B），不是持有者 —— 要看 `ENGINE_TRANSACTION_ID` |
| **L16** | 外鍵的隱藏鎖 ★ | 🔴 插入子表 → 父表那一列 `S,REC_NOT_GAP`；`DELETE` 父列被擋（預期）<br>🔴 **`UPDATE ord SET status`（跟外鍵無關的欄位）也被擋** |
| **L17** | MDL 三層阻塞 ★★ | 🔴 A 的 `SELECT`（未 commit）→ B 的 `ALTER` PENDING → **C 的 `SELECT` 也卡住**；`STATE = Waiting for table metadata lock` |
| **L18** | `SKIP LOCKED` / `NOWAIT` | ✅ `SKIP LOCKED` 跳過被鎖的兩列拿到 15/20；`NOWAIT` 立刻回 **`ERROR 3572`** |
| **L19** | `FOR UPDATE OF` | ✅ JOIN 兩張表只鎖 `acct`，`lk` 完全沒鎖 |
| **D1** | 經典死鎖（順序相反） | ✅ **42.8 ms** 偵測，`WE ROLL BACK TRANSACTION (2)`；日誌顯示雙方 HOLDS / WAITING |
| **D2** | 間隙鎖死鎖 ★★ | 🔴 兩邊**同時**持有 `(15,20)` 的 `X,GAP`（`GRANTED` 兩筆）→ 兩邊都要 insert intention → 環 |
| **D3** | 不同索引路徑死鎖 | 🔴 A 走 `PRIMARY`、B 走 `k_c`，主鍵加鎖順序相反 → `1213` |
| **D4** | upsert 三方死鎖 | 🔴 A 回滾後 B 拿到鎖，**C 得到 `1213`** |
| **D5** | 關掉死鎖偵測 ★ | 🔴 `42.8 ms 死 1 個` → **`5010 ms` + `5416 ms`，兩個都死** |
| **D6** | `1205` vs `1213` ★★ | 🔴 `1205`：第一句的 111 **還在**，`COMMIT` 之後**半個交易被提交**<br>✅ `1213`：444 一起被回滾，`COMMIT` 是空的 |
| **D7** | `AUTO_INCREMENT` 空洞 | ✅ 回滾之後 id 從 1 跳到 3，`AUTO_INCREMENT = 4` —— **序號不還你** |
| **D8** | 加鎖順序的效果 | 🔴 順序相反 → `1213`；✅ 一律按 `product_id` 由小到大 → 只是排隊，**兩筆都成功** |
| **P1~P8** | `@Transactional` 八個坑 ★★ | 🔴 P1 `catch` 掉 → 照樣 commit（900）<br>🔴 P2 checked exception → 不回滾（900）<br>✅ P3 `rollbackFor = Exception.class` → 回滾（1000）<br>🔴 P4 自我呼叫 → 註解完全無效（900）；Boot 3 自我注入不加 `@Lazy` **啟動就失敗**<br>🔴 P5 沒交易也不報錯（`isActualTransactionActive() = false`）<br>✅ P6 `readOnly` 擋寫入（`Connection is read-only`）<br>✅ P7 `REQUIRES_NEW` 外層回滾、內層留下（999）<br>🔴 P8 巢狀 `REQUIRED` + 外層 catch → **`UnexpectedRollbackException`** |
| **K1** | 20 人搶 10 庫存（六種）★★ | 🔴 ① 讀-改-寫：**成功 20、剩 9、超賣 19、CHECK 0 次**<br>🟡 ② 無條件 `qty-1`：對，但 **CHECK 觸發 10 次**<br>✅ ③ `AND qty >= 1`：**34 ms 最快**<br>✅ ④ `FOR UPDATE`：37 ms<br>🔴 ⑤ 樂觀鎖不重試：**只成功 2 個**<br>✅ ⑥ 樂觀鎖 + 重試：78 ms<br>**RC 下重跑結論完全相同** |
| **K2** | 連線池被 API 打爆 ★★ | ✅ 交易外呼叫 **186 ms / 0 失敗**<br>🟡 交易內、不同列 **616 ms（3.3 倍）**<br>🔴 交易內、同一列 **5071 ms，8 個 `CannotCreateTransactionException`** |
| **O1** | 30 張並行訂單（四種）★★ | 🔴 ① 讀-改-寫 + 不排序：死鎖 4～10，扣庫存 3～7 vs 明細 40～52<br>🔴 ② 讀-改-寫 + 排序：**死鎖 0，但扣庫存只有 3～8 vs 明細 60** —— 沒有死鎖 ≠ 正確<br>✅ ③ 原子 + 不排序：資料一致，但死鎖 3～11<br>✅ ④ 原子 + 排序：資料一致，死鎖 0～8 |
| **O2** | 死鎖來源拆解 ★★ | ✅ 只有 stock 原子 UPDATE（已排序）：**20 次 0 死鎖**<br>🔴 加上 `INSERT INTO ord`（兩個唯一索引）：**20 次 16 死鎖**<br>🔴 再加 `ord_item`：20 次 22 死鎖<br>→ 日誌證明是 `uk_ord_no` 上的 **S 間隙鎖 + 插入意向鎖**（模式二） |

🔴 **本章沒有驗證到的**：

| 沒驗證的 | 影響哪一節 | 哪一章會補 |
|---|---|---|
| **XA / 兩階段提交**與分散式交易 | 4.2 | 13 章（分散式系統） |
| **Saga / TCC** 等最終一致性模式 | 4.8 | 13 章 |
| **Outbox 模式**的實作與投遞保證 | 4.7.6 | 11 章（訊息） |
| **Redis 分散式鎖** vs DB 悲觀鎖 | 4.7.4 | 10 章（Redis） |
| **主從複製下的交易可見性**（從庫延遲、`read-your-writes`） | 4.4 / 4.7.7 | 07 章 |
| **JPA / Hibernate 的樂觀鎖**（`@Version`）與一級快取交互 | 4.7.4 | 08 章 |
| **`innodb_autoinc_lock_mode`** 0 / 1 的表鎖行為 | 4.5.3 | —（本章預設 mode 2，只在分配瞬間鎖，量不到 mode 0/1 的停頓） |
| **`buffer pool` 不足時的鎖行為** | 4.5.6 | 05 章 |
| **超過 1000 個並行連線**的鎖競爭曲線 | 4.5.6 / 4.7.8 | 05 章 |
| **`gh-ost` / `pt-osc`** 線上變更如何繞開 MDL | 4.5.4 | 06 章 |

> 📌 **最後一句話**：
>
> 這一章有**五個實測結果，跟「大家都這樣說」不一樣**：
>
> **①「加了約束就安全了」** ——
> K1 顯示 `CHECK (qty >= 0)` 在超賣 19 件的過程中**一次都沒觸發**。
> **約束檢查的是「你寫進去的值」，不是「你的業務邏輯」。**
> 每一次寫入單獨看都合法，錯的是「20 個人都以為自己是第一個」。
>
> **②「沒有死鎖就是健康的」** ——
> O1 的第 ② 組把死鎖降到 **0**，而它是四組裡**資料錯得最徹底**的一組
> （60 筆明細只扣了 3 件庫存）。
> **監控死鎖率會讓你對這種設計毫無警覺。**
>
> **③「排好加鎖順序就不會死鎖」** ——
> O2 顯示庫存表排序之後 20 次執行 **0 死鎖**，
> 但加上一句 `INSERT INTO ord` 就變成 **20 次 16 死鎖** ——
> 而那 30 個 `order_no` **每一個都不一樣**。
> **唯一索引上的插入，衝突的是【間隙】不是【值】。**
>
> **④「`SELECT` 不會加鎖 / 查不到就不會加鎖」** ——
> L2、L6 顯示回傳 0 列的 `FOR UPDATE` 鎖住了一整段間隙；
> L7 顯示回傳 1 列的查詢鎖住了整張表；
> I5 顯示 `SERIALIZABLE` 下**一句普通 `SELECT`** 就能擋住別人的 `UPDATE`；
> M8 顯示一個**什麼都沒做**的唯讀交易讓查詢慢 20 倍；
> L17 顯示一個**忘了 commit 的 `SELECT`** 能讓整張表讀不了。
>
> **⑤「錯誤處理都一樣，catch 起來就好」** ——
> D6 顯示 `1205` 之後 `COMMIT` 會**提交半個交易**；
> P1 顯示 `catch` 掉 `DataAccessException` 之後 Spring **照樣 commit**；
> P8 顯示例外**接住了**、交易還是死了。
>
> ⚠️ **這五個有一個共同點**：
>
> > **它們都不會報錯。**
> > 沒有例外、沒有紅色的日誌、沒有失敗的測試。
> > 錯誤只存在於「兩個人同時做同一件事」的那一瞬間，
> > 而那一瞬間留下的痕跡，是三個月後財務對不上的那幾筆帳。
>
> **唯一的解藥是同一個動作：把兩個 session 排在同一張時間軸上，真的跑一次。**
> 本章的 59 組實驗，每一組都可以在你自己的機器上重現 ——
> **而重現它們的成本，遠低於在正式環境發現它們的成本。**
>
> **下一章開始講效能調校。** 05 章會回答一個本章刻意迴避的問題：
> **「這些鎖等待，在慢查詢日誌裡長什麼樣子？」** ——
> 以及 03 章欠的兩筆帳：**buffer pool 不夠大的時候，索引還有用嗎？
> hash join 和 nested loop 的交叉點在哪裡？**

---

**上一章**：[03-index-and-explain.md](./03-index-and-explain.md) — 索引與執行計畫
**下一章**：[05-query-performance-tuning.md](./05-query-performance-tuning.md) — 效能調校
