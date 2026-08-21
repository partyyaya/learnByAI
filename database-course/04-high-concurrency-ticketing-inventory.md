# 第 04 章：高併發搶票、秒殺與庫存扣減設計

> 高併發不是「資料庫跑快一點」而已。
> 搶票、秒殺、限量商品的核心難題是：大量請求同時進來，但庫存有限，系統必須快速回應、不能超賣、不能重複下單，還要能在失敗時恢復一致。
> 這章會用演唱會搶票系統完整拆解。

---

## 4.1 學習目標

完成本章後，你應該可以：

- 說明高併發搶票系統的主要風險。
- 用資料庫條件更新避免基本超賣。
- 用 `RETURNING` 在條件更新的同一句話裡拿到扣後庫存與 affected rows。
- 用 `ON CONFLICT DO NOTHING` 取代「先查再插」，並用 UPSERT 實作冪等建單。
- 理解悲觀鎖、樂觀鎖、唯一約束的角色。
- 用 `NOWAIT` 與 `SKIP LOCKED` 控制鎖等待行為，並用 `SKIP LOCKED` 實作任務佇列。
- 說明 InnoDB 的行鎖加在索引上，以及走不到索引為什麼等於鎖表。
- 說明間隙鎖與 next-key lock，並判斷一個查詢會鎖住多大範圍。
- 找出死鎖的三種成因，用統一加鎖順序修掉它，並寫出正確的重試邏輯。
- 讀懂 `SHOW ENGINE INNODB STATUS` 的死鎖區塊。
- 使用 Redis 原子扣減做熱庫存預扣。
- 用消息隊列削峰，避免資料庫被瞬間打爆。
- 設計防重複下單、限流、排隊與超時釋放庫存。
- 說明最終一致性與補償機制。

---

## 4.2 場景：演唱會搶票

需求：

- 一場演唱會有 10000 張票。
- 開賣瞬間可能有 100 萬人同時請求。
- 每位使用者最多買 1 張。
- 不能超賣。
- 成功搶到票後要建立訂單。
- 使用者需在 10 分鐘內付款，逾時釋放票。

如果只用最直覺的流程：

```text
1. 使用者點搶票
2. API 查 DB 剩餘票數
3. 如果 stock > 0，就建立訂單
4. 再把 stock - 1
```

這在高併發下會出事。

---

## 4.3 超賣是怎麼發生的

假設目前只剩 1 張票。

兩個請求同時進來：

```text
請求 A：SELECT stock，看到 1
請求 B：SELECT stock，看到 1
請求 A：建立訂單
請求 B：建立訂單
請求 A：stock - 1
請求 B：stock - 1
```

結果：

```text
只有 1 張票，卻賣出 2 張
```

問題根源：

- 查庫存與扣庫存不是同一個原子操作。
- 多個請求看到同一個舊狀態。

---

## 4.4 最基本防線：資料庫條件更新

資料表：

```sql
CREATE TABLE ticket_events (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  stock INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (stock >= 0)
);

CREATE TABLE ticket_orders (
  id BIGSERIAL PRIMARY KEY,
  event_id BIGINT NOT NULL REFERENCES ticket_events(id),
  user_id BIGINT NOT NULL,
  status VARCHAR(30) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at TIMESTAMP,
  UNIQUE (event_id, user_id)
);
```

扣庫存：

```sql
UPDATE ticket_events
SET stock = stock - 1
WHERE id = 1
  AND stock > 0;
```

重點是 `AND stock > 0`。

應用程式要檢查 affected rows：

```text
affected_rows = 1：扣庫存成功，可以建立訂單
affected_rows = 0：庫存不足，回傳售完
```

完整交易：

```text
BEGIN
  UPDATE ticket_events
  SET stock = stock - 1
  WHERE id = 1 AND stock > 0

  if affected_rows != 1:
    ROLLBACK
    return "sold out"

  INSERT INTO ticket_orders (event_id, user_id, status)
  VALUES (1, user_id, 'pending_payment')

COMMIT
```

### 用 `RETURNING` 一次拿到扣後庫存

上面的流程靠 affected rows 判斷成功與否。但前端通常還想知道「還剩幾張」。如果補一句 `SELECT stock`，查到的值可能已經被別人扣過好幾次——那不是你這次扣完的結果。

PostgreSQL 用 `RETURNING` 一次解決：

```sql
UPDATE ticket_events
SET stock = stock - 1
WHERE id = 1
  AND stock > 0
RETURNING id, stock;
```

一句話三個答案：

```text
回傳 0 列        → 售完，不要建訂單
回傳 1 列        → 扣成功
回傳的 stock 值  → 這次扣完後的剩餘張數
```

回傳的列數就是 affected rows，所以連 affected rows 都不用另外問。完整交易變成：

```text
BEGIN
  rows = UPDATE ticket_events
         SET stock = stock - 1
         WHERE id = 1 AND stock > 0
         RETURNING stock

  if len(rows) != 1:
    ROLLBACK
    return "sold out"

  INSERT INTO ticket_orders (event_id, user_id, status)
  VALUES (1, user_id, 'pending_payment')

COMMIT
return { ok: true, remaining: rows[0].stock }
```

MySQL 8 沒有 `RETURNING`，要在同一個交易裡補查：

```sql
BEGIN;

UPDATE ticket_events
SET stock = stock - 1
WHERE id = 1 AND stock > 0;
-- 檢查 affected rows，是 0 就 ROLLBACK

SELECT stock FROM ticket_events WHERE id = 1;

COMMIT;
```

這樣是安全的，因為那一列還被自己的交易鎖著，別人的扣減進不來。代價是多一次往返，而且交易持鎖時間變長——開賣瞬間這件事有感（第 02 章 2.16 節有完整比較）。

### 這樣就夠了嗎？

對中小流量可能夠。

但搶票開賣瞬間，如果 100 萬請求全部打到同一張 `ticket_events` row：

- 大量交易競爭同一行。
- 資料庫連線池被塞爆。
- API 延遲升高。
- 即使不超賣，也可能整個系統不可用。

所以高併發設計通常會把「瞬間流量」擋在資料庫前面。

---

## 4.5 防重複下單：唯一約束

需求：每位使用者每場活動最多一張票。

資料庫層一定要加：

```sql
ALTER TABLE ticket_orders
ADD CONSTRAINT uq_ticket_orders_event_user UNIQUE (event_id, user_id);
```

為什麼不能只靠後端判斷？

危險流程：

```text
請求 A：查 user 1001 沒買過
請求 B：查 user 1001 沒買過
請求 A：建立訂單
請求 B：建立訂單
```

後端檢查在併發下會失效。唯一約束是最後防線。

### 用 `ON CONFLICT DO NOTHING` 取代「先查再插」

知道要靠唯一約束之後，很多人會寫成「先查、沒有才插、撞到就當例外處理」：

```text
row = SELECT 1 FROM ticket_orders WHERE event_id = 1 AND user_id = 1001

if row is None:
    try:
        INSERT INTO ticket_orders (event_id, user_id, status)
        VALUES (1, 1001, 'pending_payment')
    except UniqueViolation:
        return "already bought"
```

這是正確的，但有兩個代價。

第一，正常路徑要兩次往返。第二，開賣瞬間會產生大量唯一約束例外——例外在多數語言和 ORM 裡都不便宜，而且在 PostgreSQL 裡，一個失敗的敘述會讓整個交易進入 aborted 狀態（`25P02`），後面的敘述全部被拒絕，你必須 rollback 或事先開 savepoint 才能繼續。

直接讓資料庫處理衝突：

```sql
INSERT INTO ticket_orders (event_id, user_id, status)
VALUES (1, 1001, 'pending_payment')
ON CONFLICT (event_id, user_id) DO NOTHING;
```

判斷結果看 affected rows：

```text
affected_rows = 1：這是新訂單
affected_rows = 0：使用者已經有訂單，回「已購買」
```

一次往返、沒有例外、交易不會被打斷。

MySQL 的等價寫法：

```sql
INSERT INTO ticket_orders (event_id, user_id, status)
VALUES (1, 1001, 'pending_payment')
ON DUPLICATE KEY UPDATE event_id = event_id;    -- 值不變，只是為了不拋錯
```

注意 MySQL 的 `ON DUPLICATE KEY` 不能指定要看哪個唯一鍵。`ticket_orders` 如果同時有 `UNIQUE (event_id, user_id)` 和 `UNIQUE (request_id)`（4.18 節的冪等鍵），撞到哪一個都走同一個分支，你分不出來是「重複下單」還是「queue 重送」。這種時候要嘛拆成兩次寫入，要嘛回頭用例外處理去讀錯誤訊息裡的索引名。

**但別誤會：唯一約束仍然是最終防線。** `ON CONFLICT DO NOTHING` 只是換一種面對衝突的方式，它靠的還是那個 `UNIQUE (event_id, user_id)`。沒有約束的話，這句話什麼都擋不住。UPSERT 的完整語法與跨資料庫差異在第 02 章 2.16 節。

---

## 4.6 悲觀鎖

悲觀鎖的想法是：「我先鎖住資料，別人等我做完。」

範例：

```sql
BEGIN;

SELECT stock
FROM ticket_events
WHERE id = 1
FOR UPDATE;

-- 應用程式檢查 stock > 0

UPDATE ticket_events
SET stock = stock - 1
WHERE id = 1;

INSERT INTO ticket_orders (event_id, user_id, status)
VALUES (1, 1001, 'pending_payment');

COMMIT;
```

`FOR UPDATE` 會鎖住這一行，其他交易想鎖同一行就要等待。

優點：

- 邏輯直覺。
- 適合競爭不太激烈的關鍵流程。

缺點：

- 高併發下大量等待。
- 容易造成鎖競爭。
- 交易時間越長，吞吐越差。

搶票這類極熱 row 場景，不建議只依賴悲觀鎖硬扛。

### 鎖不到的時候：NOWAIT 與 SKIP LOCKED

`FOR UPDATE` 的預設行為是「等」。等到對方 commit 釋放鎖，或等到超時：

- MySQL：`innodb_lock_wait_timeout`，預設 50 秒，超時報 1205（Lock wait timeout exceeded）。
- PostgreSQL：`lock_timeout` 預設是 0，也就是**無限等**。生產環境應該明確設一個值。

搶票場景讓使用者等 50 秒再回失敗是不可接受的。兩個修飾字可以改變等待行為（MySQL 8.0+、PostgreSQL 9.5+）：

```sql
-- 鎖不到就立刻報錯，不等
SELECT stock
FROM ticket_events
WHERE id = 1
FOR UPDATE NOWAIT;

-- 鎖不到就跳過這一列
SELECT stock
FROM ticket_events
WHERE id = 1
FOR UPDATE SKIP LOCKED;
```

- `NOWAIT`：立刻回錯誤（MySQL 3572、PostgreSQL 55P03）。適合「搶不到就告訴使用者稍後再試」，把等待壓力還給前端而不是壓在資料庫連線上。
- `SKIP LOCKED`：把被鎖住的列當成不存在。對單列查詢沒意義，但它是實作**資料庫佇列**的關鍵。

`SKIP LOCKED` 領任務的標準寫法，多個 worker 同時跑也不會拿到同一筆：

```sql
BEGIN;

SELECT id, event_id, user_id
FROM ticket_orders
WHERE status = 'pending_payment'
  AND expire_at < NOW()
ORDER BY expire_at
LIMIT 10
FOR UPDATE SKIP LOCKED;

-- 處理這 10 筆：標記過期、回補庫存（見 4.15 節）

COMMIT;
```

沒有 `SKIP LOCKED` 的話，10 個 worker 會全部卡在同一批列上排隊，實際上只有一個在做事。

**注意 `SKIP LOCKED` 不能用在需要精確結果的查詢上。** 它會跳過資料，所以任何「算總數」、「對帳」、「報表」都不能用它。它只適合「這批我拿不到，別人會處理」的任務分發場景。

---

## 4.7 樂觀鎖

樂觀鎖的想法是：「先不鎖，更新時檢查版本是否還是我讀到的版本。」

資料表加 `version`：

```sql
ALTER TABLE ticket_events
ADD COLUMN version INT NOT NULL DEFAULT 0;
```

先查：

```sql
SELECT stock, version
FROM ticket_events
WHERE id = 1;
```

假設讀到：

```text
stock = 10
version = 5
```

更新：

```sql
UPDATE ticket_events
SET stock = stock - 1,
    version = version + 1
WHERE id = 1
  AND stock > 0
  AND version = 5;
```

如果 affected rows = 0，代表期間有人更新過，應用程式可以重試。

優點：

- 不會先鎖住資料。
- 適合衝突較低的場景。

缺點：

- 高衝突時大量重試，反而浪費資源。
- 搶最後幾張票時競爭激烈。

對高併發搶票來說，樂觀鎖可作為資料庫層方案，但通常仍要搭配限流、Redis、Queue。

---

## 4.8 鎖的粒度：行鎖、間隙鎖與 next-key lock

前面兩節講了怎麼加鎖，這節講一件更重要的事：**你以為你鎖了一列，其實可能鎖了一整片。**

這節的內容以 MySQL InnoDB 為主，因為間隙鎖是 InnoDB 特有的機制。PostgreSQL 的差異放在本節最後。

### 行鎖鎖的是索引記錄，不是資料列

這是所有誤解的源頭。InnoDB 的行鎖實際上加在**索引記錄**上，不是加在「資料列」這個抽象概念上。

推論很嚴重：**如果 `WHERE` 條件走不到索引，InnoDB 就只能全表掃描，然後把掃到的每一列都鎖住。**

看搶票系統的訂單表（完整定義見 4.19 節）：

```sql
CREATE TABLE ticket_orders (
  id BIGSERIAL PRIMARY KEY,
  request_id VARCHAR(100) NOT NULL UNIQUE,
  event_id BIGINT NOT NULL REFERENCES ticket_events(id),
  user_id BIGINT NOT NULL,
  status VARCHAR(30) NOT NULL,
  expire_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at TIMESTAMP,
  UNIQUE (event_id, user_id)
);

CREATE INDEX idx_ticket_orders_event_status
ON ticket_orders(event_id, status);

CREATE INDEX idx_ticket_orders_expire_status
ON ticket_orders(status, expire_at);
```

這張表上，`user_id` 只出現在 `UNIQUE (event_id, user_id)` 的**第二個位置**，不是最左欄位，所以單獨用 `user_id` 查詢走不到這個索引。

```sql
-- 危險：user_id 走不到索引
BEGIN;

UPDATE ticket_orders
SET status = 'cancelled'
WHERE user_id = 1001;

-- 這裡先不 COMMIT
```

這條 `UPDATE` 會全表掃描，然後鎖住掃到的每一列——實際效果接近**鎖表**。在開賣期間下這麼一條語句，整個搶票流程會停擺。

先用 `EXPLAIN` 確認有沒有走索引：

```sql
EXPLAIN
SELECT id FROM ticket_orders WHERE user_id = 1001;
```

看 `key` 欄位是不是 NULL、`rows` 是不是接近全表。如果是，加索引：

```sql
CREATE INDEX idx_ticket_orders_user ON ticket_orders(user_id);
```

**紀律：任何會加鎖的語句（`UPDATE`、`DELETE`、`SELECT ... FOR UPDATE`），它的 `WHERE` 條件都必須走索引。** 這不只是效能問題，是鎖範圍問題。

### 間隙鎖：鎖住「還不存在的資料」

回到第 02 章 2.12 節那個問題：幻讀是「筆數變了」，要防它就得阻止別人插入新列。但新列還不存在，沒有列可以鎖——怎麼辦？

InnoDB 的答案是鎖住**索引記錄之間的空隙**。這叫 gap lock（間隙鎖）。

假設 `ticket_events` 目前有 id 為 1、5、10 三筆。索引把整個 id 空間切成這些區間：

```text
(-∞, 1)   [1]   (1, 5)   [5]   (5, 10)   [10]   (10, +∞)
 間隙      列    間隙      列    間隙       列     間隙
```

現在下一個範圍查詢的當前讀：

```sql
BEGIN;

SELECT * FROM ticket_events
WHERE id > 5 AND id < 10
FOR UPDATE;
```

InnoDB 會鎖住 `(5, 10)` 這個間隙。**任何人想在這個範圍插入資料都會被卡住**，包含 id = 7、8、9。所以你重複執行這個查詢，筆數保證不變——幻讀被擋掉了。

用搶票表看一個更真實的例子：

```sql
-- 交易 A
BEGIN;

SELECT id, user_id
FROM ticket_orders
WHERE event_id = 1
  AND status = 'pending_payment'
FOR UPDATE;
```

這會用到 `idx_ticket_orders_event_status(event_id, status)`，並鎖住這個索引上符合條件的記錄與它們周圍的間隙。

```sql
-- 交易 B，同時執行
BEGIN;

INSERT INTO ticket_orders (request_id, event_id, user_id, status, expire_at)
VALUES ('req-999', 1, 2002, 'pending_payment', NOW() + INTERVAL 10 MINUTE);
-- 卡住，等交易 A 提交
```

交易 B 插入的是一筆**全新的**訂單，跟交易 A 讀到的任何一列都不衝突，卻被卡住了。這是間隙鎖最讓人意外的地方，也是生產環境很多「莫名超時」的原因。

### next-key lock：行鎖 + 間隙鎖

InnoDB 在 Repeatable Read 下的預設鎖不是純行鎖，而是 **next-key lock = 索引記錄的行鎖 + 這筆記錄前面那個間隙的間隙鎖**。

```text
next-key lock on [5]  =  行鎖 [5]  +  間隙鎖 (1, 5)
                         鎖住這一列    鎖住它前面的空隙
```

所以「鎖一列」實際上鎖住的是一個左開右閉的區間 `(1, 5]`。

鎖範圍取決於你怎麼查，這是最需要記住的對照表：

| 查詢方式 | 鎖的範圍 | 備註 |
|----------|----------|------|
| 唯一索引等值查詢，命中 | 只鎖那一列（退化成純行鎖） | 最理想，沒有間隙鎖 |
| 唯一索引等值查詢，沒命中 | 鎖住該值所在的間隙 | 防止別人插進來 |
| 非唯一索引等值查詢 | 鎖住所有相同值的記錄 + 兩側間隙 | 範圍比你想的大 |
| 範圍查詢 | 鎖住整個掃描區間 | `id > 5` 會鎖到 `+∞` |
| 走不到索引 | 掃到的每一列 + 每個間隙 | 等於鎖表 |

第四列要特別小心：

```sql
-- 這會鎖住 (10, +∞)，之後任何 id 更大的插入都會被卡住
SELECT * FROM ticket_events WHERE id > 10 FOR UPDATE;
```

第一列是你應該努力達成的狀態。**用主鍵或唯一索引做等值查詢，鎖範圍最小。** 這也是為什麼搶票要用 `WHERE id = 1` 而不是 `WHERE name = '五月天演唱會'`。

### 怎麼看目前有哪些鎖

MySQL 8.0：

```sql
-- 目前持有與等待中的鎖
SELECT ENGINE_TRANSACTION_ID AS trx_id,
       OBJECT_NAME AS tbl,
       INDEX_NAME,
       LOCK_TYPE,
       LOCK_MODE,
       LOCK_STATUS,
       LOCK_DATA
FROM performance_schema.data_locks;

-- 誰在等誰
SELECT * FROM performance_schema.data_lock_waits;
```

`LOCK_MODE` 讀法：

```text
X,REC_NOT_GAP   純行鎖，沒有間隙鎖（最理想）
X               next-key lock：行鎖 + 前面的間隙鎖
X,GAP           純間隙鎖，只鎖空隙不鎖列
X,INSERT_INTENTION  插入意向鎖，等間隙鎖釋放
S               共享的 next-key lock
```

看到一堆 `X`（沒有 `REC_NOT_GAP`）就代表間隙鎖大量存在，通常意味著查詢條件不夠精準。

PostgreSQL：

```sql
SELECT l.pid,
       l.locktype,
       l.mode,
       l.granted,
       c.relname,
       a.query
FROM pg_locks l
LEFT JOIN pg_class c ON c.oid = l.relation
LEFT JOIN pg_stat_activity a ON a.pid = l.pid
WHERE NOT l.granted
   OR l.locktype = 'tuple';
```

### 怎麼縮小鎖範圍

四個手段，按優先順序：

1. **`WHERE` 走索引，而且盡量用主鍵或唯一索引等值查詢。** 這是唯一能讓間隙鎖完全消失的做法。
2. **交易越短越好。** 鎖從加上到 commit 一直持有。交易裡不要有外部 API 呼叫。
3. **需要時降到 Read Committed。** InnoDB 在 RC 下基本不用間隙鎖（除了外鍵檢查與唯一鍵檢查），鎖範圍大幅縮小。代價是接受不可重複讀與幻讀——搶票流程其實不在意這兩件事，因為它靠的是條件更新與唯一約束，不是靠隔離級別。
4. **用 `NOWAIT` / `SKIP LOCKED` 控制等待行為**（見 4.6 節），避免等待堆積成雪崩。

### PostgreSQL 的差異

PostgreSQL **沒有間隙鎖**。它的做法完全不同：

- **Repeatable Read** 是 snapshot isolation。它不阻止別人插入，而是在你的交易嘗試做出「基於過期快照的寫入」時，直接報 `40001` serialization failure。你負責重試。
- **Serializable** 用 SSI，會建立 predicate lock（在 `pg_locks` 裡看到 `locktype = 'page'` 或 SIReadLock），偵測讀寫依賴環路後讓其中一個交易失敗。

實務上的差別：

```text
MySQL InnoDB  → 用鎖擋住你，你會「等」（可能超時 1205）
PostgreSQL    → 讓你先跑，衝突了才「失敗」（40001，要重試）
```

所以跨資料庫的程式碼要同時處理兩種情況：鎖等待超時要重試，序列化失敗也要重試。

**心智模型**：InnoDB 的鎖是加在索引上的區間鎖，不是加在資料列上的點鎖。你的 `WHERE` 條件有多精準，鎖範圍就有多小。

---

## 4.9 死鎖：偵測、成因與避免

### 死鎖是什麼

兩個交易各自持有對方要的鎖，互相等到永遠：

```text
交易 A                                  交易 B
------------------------------------    ------------------------------------
BEGIN                                   BEGIN

UPDATE ticket_events                    UPDATE ticket_events
SET stock = stock - 1 WHERE id = 1      SET stock = stock - 1 WHERE id = 2
→ 取得 id = 1 的行鎖                     → 取得 id = 2 的行鎖

UPDATE ticket_events                    UPDATE ticket_events
SET stock = stock - 1 WHERE id = 2      SET stock = stock - 1 WHERE id = 1
→ 等 B 放掉 id = 2                       → 等 A 放掉 id = 1

              ↑ 兩邊都不會放手，形成環路
```

資料庫不會讓它們永遠等下去，會主動打破環路：

- **MySQL InnoDB**：有主動死鎖偵測（wait-for graph）。發現環路就挑一個「回滾成本較小」的交易犧牲，讓它報 1213 `ER_LOCK_DEADLOCK`（SQLSTATE 40001），另一個繼續跑。通常是毫秒級偵測到。
- **PostgreSQL**：不主動偵測。等鎖超過 `deadlock_timeout`（預設 1 秒）才去檢查有沒有環路，有就報 `40P01` deadlock detected。所以 PostgreSQL 的死鎖至少會卡 1 秒。

### 死鎖不等於鎖等待超時

這兩個很容易搞混，但排查方向完全不同：

| | 死鎖 | 鎖等待超時 |
|---|------|------------|
| MySQL 錯誤 | 1213 Deadlock found | 1205 Lock wait timeout exceeded |
| PostgreSQL | 40P01 deadlock detected | 55P03 / `lock_timeout` 觸發 |
| 成因 | 互相等待，形成環路 | 單向等待，對方太慢 |
| 發生時間 | 立刻（MySQL）/ 1 秒後（PostgreSQL） | 等到超時設定值 |
| 怎麼修 | 統一加鎖順序、縮短交易 | 縮短交易、找出長交易、加索引 |

看到 1205 不要去找死鎖，要去找「誰持鎖不放」——通常是一個忘記 commit 的長交易（查法見第 02 章 2.13 節）。

### 三種常見成因

**成因 1：加鎖順序不一致。** 上面那個例子就是。最常出現在轉帳、批次更新、一個請求要動多筆資料的場景。

**成因 2：間隙鎖互相卡住。** 這個最陰險，因為兩邊看起來完全沒碰到同一筆資料：

```text
交易 A                              交易 B
--------------------------------    --------------------------------
BEGIN                               BEGIN
SELECT ... WHERE event_id = 1       SELECT ... WHERE event_id = 1
  AND status = 'pending' FOR UPDATE   AND status = 'pending' FOR UPDATE
→ 取得這段區間的間隙鎖               → 也取得同一段間隙鎖，兩邊都成功

INSERT INTO ticket_orders ...       INSERT INTO ticket_orders ...
→ 需要插入意向鎖，等 B 的間隙鎖      → 需要插入意向鎖，等 A 的間隙鎖
                                       ↑ 死鎖
```

**間隙鎖彼此相容，插入意向鎖跟間隙鎖不相容。** 所以「兩個交易先查同一個範圍、再各自插入」是死鎖的經典配方。

同一個配方的另一個版本是**兩個交易插入同一個唯一鍵**：

```text
交易 A：INSERT ticket_orders (event_id=1, user_id=1001)  → 成功，持有唯一鍵的鎖
交易 B：INSERT ticket_orders (event_id=1, user_id=1001)  → 唯一鍵衝突，等 A
交易 A：ROLLBACK 或再插另一筆 → 有機會跟 B 形成環路
```

搶票系統靠 `UNIQUE (event_id, user_id)` 防重（見 4.5 節），所以這種死鎖在開賣瞬間是**預期會發生的**，不是 bug。

**成因 3：先讀後寫造成鎖升級。**

```sql
BEGIN;
SELECT stock FROM ticket_events WHERE id = 1;        -- 快照讀，不加鎖
-- 兩個交易都走到這裡
UPDATE ticket_events SET stock = stock - 1 WHERE id = 1;  -- 現在才要鎖
COMMIT;
```

多個交易同時從「不持鎖」升級到「要 X 鎖」，容易撞在一起。這也是第 02 章 2.13 節講的更新丟失的同一個根源：讀跟寫之間有空窗。

### 怎麼避免

**手段 1：統一加鎖順序。** 這是最有效的一招。應用程式先排序再更新：

```text
# 錯誤：順序取決於使用者輸入
for id in [2, 1]:
    UPDATE ticket_events SET stock = stock - 1 WHERE id = id

# 正確：一律由小到大
for id in sorted([2, 1]):     # → [1, 2]
    UPDATE ticket_events SET stock = stock - 1 WHERE id = id
```

轉帳更要注意，第 02 章 2.14 節那段轉帳如果 A→B 與 B→A 同時發生就會死鎖。改成一律先鎖 id 小的帳戶：

```sql
BEGIN;

-- 一律按 id 由小到大鎖，不管誰轉給誰
SELECT id, balance FROM accounts
WHERE id IN (1, 2)
ORDER BY id
FOR UPDATE;

UPDATE accounts SET balance = balance - 100 WHERE id = 1 AND balance >= 100;
-- 檢查 affected rows，是 0 就 ROLLBACK
UPDATE accounts SET balance = balance + 100 WHERE id = 2;

COMMIT;
```

**手段 2：一句 SQL 搞定，不要拆成多句。**

```sql
-- 一句話更新兩筆，鎖的取得順序由索引決定，是確定的
UPDATE ticket_events
SET stock = stock - 1
WHERE id IN (1, 2)
  AND stock > 0;
```

單一語句內部的加鎖順序跟著索引掃描順序走，兩個併發交易的順序一致，不會形成環路。

**手段 3：交易越短越好。** 鎖持有時間越短，撞上的機率越低。交易裡絕對不要有外部 API 呼叫、檔案 IO、等待使用者輸入。

**手段 4：需要時降到 Read Committed。** RC 下沒有間隙鎖，成因 2 那類死鎖大幅減少。

**手段 5：熱點資料不要在同一個交易裡鎖多筆。** 搶票的正解是第 4.4 節的條件更新——一句 `UPDATE ... WHERE stock > 0`，鎖一筆、立刻放掉，根本沒有形成環路的機會。

### 應用程式必須能重試

**死鎖不是 bug，是併發系統的正常現象。** 高併發下不可能完全消除，所以應用程式一定要處理。

```text
attempt = 0
loop:
  attempt += 1
  try:
    BEGIN
      ... 業務邏輯 ...
    COMMIT
    return success
  catch error:
    ROLLBACK
    if error is deadlock (MySQL 1213 / PostgreSQL 40P01) and attempt < 3:
      sleep random(10ms ~ 100ms)    # 隨機退避，避免同步重撞
      continue
    else:
      raise
```

三個重點：

- **只重試死鎖與序列化失敗。** 業務錯誤（庫存不足、重複下單）重試一百次也一樣，要直接回給使用者。
- **退避時間要隨機。** 固定退避會讓兩個交易同步重試、同步再撞。
- **重試要有上限。** 連續 3 次都死鎖代表設計有問題，該去修加鎖順序，不是無限重試。

死鎖率也應該進監控。偶發幾筆正常，持續上升代表某個新上的功能加鎖順序寫錯了。

### 怎麼查死鎖現場

MySQL 看最近一次死鎖：

```sql
SHOW ENGINE INNODB STATUS;
```

在輸出裡找 `LATEST DETECTED DEADLOCK` 段落：

```text
------------------------
LATEST DETECTED DEADLOCK
------------------------
2026-08-21 14:03:11 0x7f2a
*** (1) TRANSACTION:
TRANSACTION 84213, ACTIVE 0 sec starting index read
mysql tables in use 1, locked 1
LOCK WAIT 3 lock struct(s), heap size 1136, 2 row lock(s)
UPDATE ticket_events SET stock = stock - 1 WHERE id = 2

*** (1) HOLDS THE LOCK(S):
RECORD LOCKS space id 42 page no 4 n bits 72 index PRIMARY of table
`ticketing`.`ticket_events` trx id 84213 lock_mode X locks rec but not gap

*** (1) WAITING FOR THIS LOCK TO BE GRANTED:
RECORD LOCKS space id 42 page no 4 n bits 72 index PRIMARY of table
`ticketing`.`ticket_events` trx id 84213 lock_mode X locks rec but not gap waiting

*** (2) TRANSACTION:
TRANSACTION 84214, ACTIVE 0 sec starting index read
UPDATE ticket_events SET stock = stock - 1 WHERE id = 1

*** WE ROLL BACK TRANSACTION (1)
```

讀法：

```text
(1) HOLDS THE LOCK(S)            → 交易 1 已經拿到什麼
(1) WAITING FOR THIS LOCK        → 交易 1 卡在等什麼
index PRIMARY                    → 卡在哪個索引上（間隙鎖問題常出現在二級索引）
lock_mode X locks rec but not gap → 純行鎖，沒有間隙鎖
lock_mode X locks gap before rec  → 間隙鎖，成因 2 的訊號
WE ROLL BACK TRANSACTION (1)     → 哪個交易被犧牲了
```

把兩個交易的 SQL 抓出來對照，看它們的加鎖順序是不是相反的——通常一眼就看出來。

`SHOW ENGINE INNODB STATUS` 只留**最近一次**死鎖。生產環境要把全部死鎖寫進 error log：

```sql
SET GLOBAL innodb_print_all_deadlocks = ON;
```

或寫進設定檔讓它重啟後仍生效：

```text
[mysqld]
innodb_print_all_deadlocks = ON
```

PostgreSQL 的死鎖預設就會寫進 log。要看得更清楚，再打開鎖等待記錄：

```sql
-- 等鎖超過 deadlock_timeout 就記一筆到 log
ALTER SYSTEM SET log_lock_waits = on;
ALTER SYSTEM SET deadlock_timeout = '1s';
SELECT pg_reload_conf();
```

log 裡會看到：

```text
ERROR:  deadlock detected
DETAIL:  Process 12345 waits for ShareLock on transaction 84213;
         blocked by process 12346.
         Process 12346 waits for ShareLock on transaction 84214;
         blocked by process 12345.
HINT:  See server log for query details.
```

**心智模型**：死鎖是「加鎖順序不一致」的症狀。修法不是加大超時或無限重試，是讓所有交易用同一個順序碰資料。

---

## 4.10 Redis 熱庫存預扣

搶票開賣瞬間，最大問題是請求量太大。Redis 的角色是：

```text
在資料庫前面，先用非常快的原子操作擋掉大部分失敗請求。
```

開賣前，把票數載入 Redis：

```bash
SET ticket:event:1:stock 10000
```

使用者搶票時，不先打 DB，而是先在 Redis 扣庫存。

### 不安全寫法

```text
GET stock
if stock > 0:
  DECR stock
```

問題：

- `GET` 與 `DECR` 是兩步。
- 高併發下仍可能有競態。

### 使用 Lua 保證原子性

Redis 執行 Lua script 時，整段 script 是原子的。

```lua
local stock = tonumber(redis.call('GET', KEYS[1]))

if stock == nil then
  return -1
end

if stock <= 0 then
  return 0
end

redis.call('DECR', KEYS[1])
return 1
```

回傳值：

```text
1：預扣成功
0：售完
-1：庫存 key 不存在，代表系統尚未初始化或設定錯誤
```

流程：

```text
1. API 執行 Redis Lua
2. 回傳 0：直接告知售完，不進 DB
3. 回傳 1：取得預扣資格，進入後續建立訂單流程
```

---

## 4.11 為什麼 Redis 扣成功後不能直接算完成

Redis 預扣成功，只代表「你暫時拿到一個名額」。

真正的事實來源仍然應該是資料庫訂單。

可能失敗的地方：

- Redis 扣成功，但寫 DB 失敗。
- Redis 扣成功，但消息隊列發送失敗。
- Redis 扣成功，使用者沒付款。
- Worker 建訂單時發現使用者已經買過。

所以需要補償機制：

```text
如果後續流程失敗，要把 Redis 庫存加回去，或透過對帳修正。
```

---

## 4.12 消息隊列削峰

如果 Redis 預扣成功的 10000 個請求全部立刻打 DB，DB 仍可能有壓力。

Queue 的角色是削峰：

```text
瞬間 10000 個成功請求
  -> 先放進 Queue
  -> Worker 用資料庫可承受的速度慢慢建立訂單
```

架構：

```text
Client
  -> API Gateway / Load Balancer
  -> API Service
  -> Redis Lua 預扣庫存
  -> Message Queue
  -> Order Worker
  -> MySQL/PostgreSQL
```

Queue message 範例：

```json
{
  "request_id": "req_abc123",
  "event_id": 1,
  "user_id": 1001,
  "reserved_at": "2026-07-03T10:00:00Z"
}
```

Worker 處理：

```text
1. 從 queue 取出 message
2. 開 transaction
3. 建立 ticket_orders
4. 若 unique constraint 衝突，代表重複下單
5. commit
6. 更新搶票結果
```

---

## 4.13 完整高併發流程

### 開賣前

```text
1. DB 建立 ticket_events，stock = 10000
2. 將 stock 同步到 Redis：ticket:event:1:stock = 10000
3. 預熱活動頁、快取活動資訊
4. 設定 API 限流規則
5. 準備 Queue 與 Worker
```

### 開賣中

```text
1. 使用者送出搶票請求
2. API Gateway 限流，擋掉異常流量
3. API 檢查使用者登入與基本資格
4. Redis 檢查防重 key，例如 ticket:event:1:user:1001
5. Redis Lua 原子扣減庫存
6. 預扣成功後，寫入防重 key
7. 發 message 到 queue
8. API 回傳「排隊中」或「搶票資格已取得」
9. Worker 非同步建立訂單
10. 使用者輪詢或透過 WebSocket/SSE 查詢結果
```

### 建立訂單

```text
BEGIN
  INSERT INTO ticket_orders (event_id, user_id, status)
  VALUES (?, ?, 'pending_payment')

  如果 unique constraint 衝突：
    ROLLBACK
    補償 Redis 庫存
    標記重複請求

COMMIT
```

注意：如果 Redis 已預扣，DB 的 `ticket_events.stock` 可以有兩種設計：

1. 開賣中不即時扣 DB stock，只以 Redis 為熱庫存，事後對帳同步。
2. Worker 建訂單時也扣 DB stock，使用 DB 作最終防線。

較保守設計會在 Worker 仍做 DB 條件扣減：

```sql
UPDATE ticket_events
SET stock = stock - 1
WHERE id = 1
  AND stock > 0;
```

然後再建立訂單。這樣即使 Redis 邏輯有問題，DB 仍能擋超賣。

---

## 4.14 防重設計

高併發下，使用者可能重複點擊，或惡意重送請求。

需要多層防重：

### 第 1 層：前端防重

按下後禁用按鈕。

```text
使用者體驗層，不能當安全保證。
```

### 第 2 層：Redis 防重

```bash
SET ticket:event:1:user:1001 1 NX EX 600
```

意思：

- `NX`：key 不存在才設定。
- `EX 600`：10 分鐘過期。

如果設定失敗，代表使用者已經搶過或正在處理。

### 第 3 層：DB unique constraint

```sql
UNIQUE (event_id, user_id)
```

這是最終防線。

### 第 4 層：Idempotency Key

API 可要求每次搶票請求帶 `request_id`。

資料表：

```sql
CREATE TABLE ticket_requests (
  request_id VARCHAR(100) PRIMARY KEY,
  event_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  status VARCHAR(30) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

同一個 `request_id` 重送時，回傳同一個結果，而不是再次執行。

---

## 4.15 付款逾時與釋放庫存

需求：搶到票後 10 分鐘內付款，逾時釋放。

訂單狀態：

```text
pending_payment
paid
expired
cancelled
```

建立訂單時：

```sql
CREATE TABLE ticket_orders (
  id BIGSERIAL PRIMARY KEY,
  event_id BIGINT NOT NULL REFERENCES ticket_events(id),
  user_id BIGINT NOT NULL,
  status VARCHAR(30) NOT NULL,
  expire_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at TIMESTAMP,
  UNIQUE (event_id, user_id)
);
```

逾時處理方式：

```text
1. 建立訂單時設定 expire_at = now + 10 minutes
2. 發送延遲消息到 queue
3. 10 分鐘後 worker 檢查訂單狀態
4. 如果仍是 pending_payment，更新為 expired 並釋放庫存
5. 如果已 paid，不做事
```

釋放庫存：

```sql
BEGIN;

UPDATE ticket_orders
SET status = 'expired'
WHERE id = 123
  AND status = 'pending_payment'
  AND expire_at < CURRENT_TIMESTAMP;

-- 如果 affected_rows = 1，代表真的逾期成功，才釋放庫存

UPDATE ticket_events
SET stock = stock + 1
WHERE id = 1;

COMMIT;
```

應用程式仍要檢查第一個 update 的 affected rows。只有訂單從 `pending_payment` 變成 `expired`，才可以加回庫存。

---

## 4.16 限流與排隊

如果 100 萬人同時進來，但只有 10000 張票，系統不應該讓所有請求都進核心流程。

常見策略：

### IP 限流

```text
同一 IP 每秒最多 N 次
```

用途：

- 擋掉簡單爬蟲或惡意重送。

限制：

- 大量使用者可能共用 NAT。
- 攻擊者可以使用多 IP。

### 使用者限流

```text
同一 user_id 每秒最多 1 次搶票請求
```

比 IP 更接近業務。

### 排隊室 Waiting Room

開賣前或開賣瞬間，把使用者導入排隊室：

```text
1. 使用者進入等待頁
2. 系統發放排隊 token
3. 按節奏釋放一批使用者進入搶票 API
```

好處：

- 平滑流量。
- 保護核心 API 與 DB。
- 可搭配 CAPTCHA、風控、登入驗證。

### 隨機化與公平性

如果完全先到先得，最接近伺服器或用機器人的人有優勢。

常見做法：

- 開賣前進入等待室。
- 開賣時對符合資格者隨機排序。
- 分批釋放。

公平性是產品規則，不只是技術問題。

---

## 4.17 最終一致性

在單一資料庫交易中，我們追求強一致性。

但高併發搶票使用 Redis、Queue、DB，多個系統之間無法永遠同時一致。

例子：

```text
Redis stock 已扣
Queue message 已送
DB order 尚未建立
```

這段時間資料處於中間狀態。

我們接受短時間不一致，但要保證最終會收斂：

```text
成功：DB 訂單建立
失敗：Redis 庫存補回，防重 key 清理，狀態標記失敗
```

需要的機制：

- message retry。
- dead letter queue。
- idempotent worker。
- 對帳任務。
- 補償交易。

---

## 4.18 Worker 必須冪等

冪等 idempotent 的意思是：同一件事重做多次，結果仍然一樣。

Queue 可能重送 message：

- Worker 處理成功，但 ack 失敗。
- Queue 以為沒成功，又投遞一次。
- Worker 重啟後重試。

所以 Worker 不能假設每個 message 只會處理一次。

做法：

```sql
CREATE TABLE ticket_orders (
  id BIGSERIAL PRIMARY KEY,
  event_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  request_id VARCHAR(100) NOT NULL UNIQUE,
  status VARCHAR(30) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (event_id, user_id)
);
```

Worker 建單時：

```text
1. 用 request_id 建立訂單
2. 如果 request_id 已存在，查既有結果並返回成功
3. 如果 event_id + user_id 衝突，代表使用者已經有訂單
```

### 用 UPSERT 實作冪等建單

上面三步如果照字面用「先查再插」實作，就會回到 4.5 節的問題：兩個重送的 message 同時進來，兩邊都查到沒有。

用 `request_id` 當冪等鍵，寫成一句：

```sql
INSERT INTO ticket_orders (event_id, user_id, request_id, status)
VALUES (1, 1001, 'req-abc-123', 'pending_payment')
ON CONFLICT (request_id) DO NOTHING
RETURNING id;
```

- 回傳 1 列：這是第一次處理，繼續往下走。
- 回傳 0 列：這個 message 處理過了，直接 ack，不要重做任何有副作用的動作。

`DO NOTHING` 配 `RETURNING` 在衝突時回傳 0 列，剛好就是我們要的訊號。如果還需要把既有訂單的內容回給呼叫端，補一句查詢：

```sql
SELECT id, status FROM ticket_orders WHERE request_id = 'req-abc-123';
```

Worker 完整流程：

```text
BEGIN
  1. rows = INSERT INTO ticket_orders (...) VALUES (...)
            ON CONFLICT (request_id) DO NOTHING
            RETURNING id

  2. 回傳 0 列 → 已處理過，COMMIT、ack、結束

  3. 回傳 1 列 → UPDATE ticket_events
                 SET stock = stock - 1
                 WHERE id = 1 AND stock > 0

  4. 扣不到庫存 → ROLLBACK，補償 Redis 庫存，通知使用者失敗

  5. 扣到了 → COMMIT，ack
```

**第 1 步和第 3 步必須在同一個交易裡。** 分成兩個交易的話，訂單插進去了、扣庫存前 Worker 掛掉，重送的 message 會在第 2 步被判定為「已處理」而直接 ack——那張訂單就永遠卡在 `pending_payment`、庫存也沒扣，變成一筆對不起來的帳。放在同一個交易裡，`ROLLBACK` 會把 `request_id` 那一列也一起收回，重送時就能正確地重跑。

還有一個細節：這張表上有兩個唯一約束。

```sql
request_id VARCHAR(100) NOT NULL UNIQUE,
UNIQUE (event_id, user_id)
```

`ON CONFLICT (request_id)` 只處理 `request_id` 的衝突。如果同一個使用者用不同的 `request_id` 重送（例如前端重整後產生了新的 id），這句會撞到 `UNIQUE (event_id, user_id)` 而拋錯——**這是對的**，因為那不是 queue 重送，是重複下單，兩件事該有不同的回應。想用 `ON CONFLICT DO NOTHING`（不指定欄位）在一句話裡吞掉兩種衝突當然可以，但那樣你就分不出來使用者該看到「處理中」還是「你已經買過了」。**寧可讓不同的錯誤走不同的路。**

---

## 4.19 搶票系統完整資料表範例

```sql
CREATE TABLE ticket_events (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  stock INT NOT NULL,
  sale_starts_at TIMESTAMP NOT NULL,
  sale_ends_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (stock >= 0)
);

CREATE TABLE ticket_orders (
  id BIGSERIAL PRIMARY KEY,
  request_id VARCHAR(100) NOT NULL UNIQUE,
  event_id BIGINT NOT NULL REFERENCES ticket_events(id),
  user_id BIGINT NOT NULL,
  status VARCHAR(30) NOT NULL,
  expire_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at TIMESTAMP,
  UNIQUE (event_id, user_id)
);

CREATE INDEX idx_ticket_orders_event_status
ON ticket_orders(event_id, status);

CREATE INDEX idx_ticket_orders_expire_status
ON ticket_orders(status, expire_at);
```

索引說明：

- `UNIQUE (event_id, user_id)`：防止同一使用者重複買同一活動。
- `request_id UNIQUE`：支援冪等請求。
- `idx_ticket_orders_event_status`：查某活動不同狀態訂單。
- `idx_ticket_orders_expire_status`：掃描逾期待付款訂單。

---

## 4.20 Redis Lua 完整範例

需求：

- 同一使用者不能重複預扣。
- 庫存不足回傳售完。
- 預扣成功要寫入使用者防重 key。

Key：

```text
KEYS[1] = ticket:event:1:stock
KEYS[2] = ticket:event:1:user:1001
```

Arg：

```text
ARGV[1] = 防重 key TTL 秒數，例如 600
```

Lua：

```lua
local exists = redis.call('EXISTS', KEYS[2])
if exists == 1 then
  return 2
end

local stock = tonumber(redis.call('GET', KEYS[1]))
if stock == nil then
  return -1
end

if stock <= 0 then
  return 0
end

redis.call('DECR', KEYS[1])
redis.call('SET', KEYS[2], '1', 'EX', ARGV[1])
return 1
```

回傳：

```text
1：預扣成功
0：售完
2：重複請求
-1：庫存未初始化
```

注意：

- 如果後續發 queue 失敗，應補償 `INCR stock` 並刪除防重 key。
- 如果訂單建立失敗且確定不是重複下單，也應補償庫存。

---

## 4.21 不同方案比較

| 方案 | 優點 | 缺點 | 適合場景 |
|------|------|------|----------|
| DB 條件更新 | 簡單、強一致、可靠、鎖範圍最小 | 極熱 row 壓力大 | 中小流量、最後防線 |
| 悲觀鎖 | 邏輯直覺 | 高併發等待嚴重、間隙鎖範圍易失控 | 低衝突強一致流程 |
| 樂觀鎖 | 不先鎖資料 | 高衝突重試多 | 中低衝突更新 |
| `SKIP LOCKED` 佇列 | 多 worker 不搶同一筆 | 會跳過資料，不能用於對帳 | 逾時釋放、非同步任務分發 |
| Redis 預扣 | 快、可擋大流量 | 需補償與對帳 | 秒殺、搶票熱庫存 |
| Queue 削峰 | 保護 DB、平滑流量 | 非同步、結果延遲 | 高流量下單 |
| Waiting Room | 保護入口、改善公平性 | 系統複雜 | 超大規模開賣 |

實務上不是七選一，而是組合：

```text
限流 + Redis 預扣 + Queue + DB 唯一約束 + DB 條件更新 + 補償對帳
```

---

## 4.22 本章練習

### 練習 1：找出超賣問題

某工程師設計扣庫存流程：

```text
1. SELECT stock FROM ticket_events WHERE id = 1
2. 如果 stock > 0
3. INSERT ticket_orders
4. UPDATE ticket_events SET stock = stock - 1 WHERE id = 1
```

請問問題在哪？如何修正？

#### 參考解答

問題：

- `SELECT stock` 與 `UPDATE stock` 不是同一個原子操作。
- 多個請求可能同時看到 `stock > 0`。
- `UPDATE` 沒有 `stock > 0` 條件，可能扣成負數。

修正：

```sql
BEGIN;

UPDATE ticket_events
SET stock = stock - 1
WHERE id = 1
  AND stock > 0;

-- 應用程式檢查 affected rows
-- 若不是 1，ROLLBACK 並回傳售完

INSERT INTO ticket_orders (event_id, user_id, status, expire_at)
VALUES (1, 1001, 'pending_payment', CURRENT_TIMESTAMP + INTERVAL '10 minutes');

COMMIT;
```

並且在 `ticket_orders` 加：

```sql
UNIQUE (event_id, user_id)
```

防止重複下單。

### 練習 2：設計防重

需求：同一使用者同一活動最多只能搶一次。請列出至少三層防重。

#### 參考解答

1. 前端防重：

使用者按下搶票後禁用按鈕，避免重複點擊。

2. Redis 防重：

```bash
SET ticket:event:1:user:1001 1 NX EX 600
```

如果 key 已存在，代表已經搶過或正在處理。

3. DB unique constraint：

```sql
ALTER TABLE ticket_orders
ADD CONSTRAINT uq_ticket_orders_event_user UNIQUE (event_id, user_id);
```

這是最終防線。

4. Idempotency key：

```sql
CREATE TABLE ticket_requests (
  request_id VARCHAR(100) PRIMARY KEY,
  event_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  status VARCHAR(30) NOT NULL
);
```

同一 request 重送時回傳同一結果。

### 練習 3：Redis 預扣庫存 Lua

需求：

- Redis key `ticket:event:1:stock` 保存庫存。
- 如果庫存不存在，回傳 -1。
- 如果庫存小於等於 0，回傳 0。
- 如果成功扣減，回傳 1。

請寫 Lua。

#### 參考解答

```lua
local stock = tonumber(redis.call('GET', KEYS[1]))

if stock == nil then
  return -1
end

if stock <= 0 then
  return 0
end

redis.call('DECR', KEYS[1])
return 1
```

執行時：

```text
KEYS[1] = ticket:event:1:stock
```

為什麼不用 `GET` 後由應用程式判斷再 `DECR`？

因為那是兩次 Redis 操作，中間可能被其他請求插入。Lua 可以保證整段邏輯在 Redis 中原子執行。

### 練習 4：付款逾時釋放庫存

需求：

訂單 10 分鐘未付款要過期，且只有真的從 `pending_payment` 變成 `expired` 時才釋放庫存。請寫流程。

#### 參考解答

```text
1. 建立訂單時設定 expire_at = now + 10 minutes
2. 發送延遲消息，10 分鐘後處理
3. Worker 收到消息後開 transaction
4. UPDATE ticket_orders
   SET status = 'expired'
   WHERE id = ?
     AND status = 'pending_payment'
     AND expire_at < now
5. 檢查 affected_rows
6. 如果 affected_rows = 1，UPDATE ticket_events SET stock = stock + 1
7. COMMIT
8. 如果 affected_rows = 0，代表已付款或已處理，不釋放庫存
```

SQL：

```sql
BEGIN;

UPDATE ticket_orders
SET status = 'expired'
WHERE id = 123
  AND status = 'pending_payment'
  AND expire_at < CURRENT_TIMESTAMP;

-- 如果 affected_rows = 1 才執行
UPDATE ticket_events
SET stock = stock + 1
WHERE id = 1;

COMMIT;
```

重點：

- 不可無條件加回庫存。
- 過期 worker 可能重複執行，所以流程要冪等。

### 練習 5：設計完整架構

需求：

10000 張票，100 萬人同時搶。請設計資料流，避免 DB 被打爆且不能超賣。

#### 參考解答

建議架構：

```text
Client
  -> CDN / Waiting Room
  -> API Gateway 限流
  -> API Service
  -> Redis Lua 預扣庫存 + 防重
  -> Message Queue
  -> Order Worker
  -> MySQL/PostgreSQL 建訂單與最終扣庫存
  -> Result Store / Redis
  -> Client 輪詢或 WebSocket 查結果
```

關鍵設計：

- Waiting Room 或 Gateway 限流，避免所有流量直接進 API。
- Redis Lua 原子扣庫存，快速擋掉售完請求。
- Redis 防重 key 阻止同一使用者反覆進入流程。
- Queue 削峰，讓 Worker 用 DB 可承受速度建立訂單。
- DB unique constraint 防止重複下單。
- DB 條件更新 `stock > 0` 作最終防超賣。
- Worker 必須冪等，能處理 queue 重送。
- 失敗時補償 Redis 庫存與防重 key。
- 定期對帳 Redis、DB 訂單、活動庫存。

### 練習 6：判斷鎖範圍

需求：

`ticket_events` 目前有 id 為 1、5、10 三筆資料，隔離級別是 MySQL InnoDB 的預設 Repeatable Read。以下四條語句各自會鎖住什麼？哪些會擋掉別人的 `INSERT`？

```sql
-- (a)
SELECT * FROM ticket_events WHERE id = 5 FOR UPDATE;

-- (b)
SELECT * FROM ticket_events WHERE id = 7 FOR UPDATE;

-- (c)
SELECT * FROM ticket_events WHERE id > 5 FOR UPDATE;

-- (d)
SELECT * FROM ticket_events WHERE name = '五月天演唱會' FOR UPDATE;
```

#### 參考解答

(a) **只鎖 id = 5 這一列。** 主鍵是唯一索引，等值查詢又命中了，next-key lock 退化成純行鎖（`LOCK_MODE` 會顯示 `X,REC_NOT_GAP`）。不擋 `INSERT`。這是鎖範圍最小的寫法。

(b) **鎖住 `(5, 10)` 這個間隙。** 等值查詢沒命中，InnoDB 改鎖住該值所在的間隙，防止別人插入 id = 7 讓你的查詢結果變掉。**會擋掉 id 為 6、7、8、9 的 `INSERT`。**

(c) **鎖住 `(5, 10]` 與 `(10, +∞)`。** 範圍查詢會鎖住整個掃描區間，包含開放的上界。**任何 id 大於 5 的 `INSERT` 都會被卡住。** 這是最容易在生產環境造成大範圍阻塞的寫法。

(d) **鎖住整張表。** `name` 沒有索引，InnoDB 只能全表掃描，把掃到的每一列與每個間隙都鎖住。**所有 `INSERT` 都會被卡住。**

排查方式：

```sql
SELECT OBJECT_NAME, INDEX_NAME, LOCK_TYPE, LOCK_MODE, LOCK_DATA
FROM performance_schema.data_locks;
```

結論：搶票要用 `WHERE id = ?`（主鍵等值），不要用名稱、不要用範圍。

### 練習 7：修掉死鎖

需求：

以下是「一個訂單同時扣兩場活動庫存」的程式碼，上線後 error log 一直出現 1213 Deadlock found。請找出成因並提出兩種修法。

```text
# 目前的寫法
def create_combo_order(event_ids, user_id):
    BEGIN
    for event_id in event_ids:          # event_ids 順序來自使用者選擇
        UPDATE ticket_events
        SET stock = stock - 1
        WHERE id = event_id AND stock > 0
        if affected_rows == 0:
            ROLLBACK
            return 'sold out'
    INSERT INTO ticket_orders ...
    COMMIT
```

#### 參考解答

成因是**加鎖順序不一致**。`event_ids` 的順序來自使用者在前端的選擇順序，所以：

```text
使用者甲選 [1, 2] → 先鎖 1，再要 2
使用者乙選 [2, 1] → 先鎖 2，再要 1
                     ↑ 環路，死鎖
```

修法 1：統一加鎖順序。

```text
def create_combo_order(event_ids, user_id):
    BEGIN
    for event_id in sorted(event_ids):   # 一律由小到大
        UPDATE ticket_events
        SET stock = stock - 1
        WHERE id = event_id AND stock > 0
        if affected_rows == 0:
            ROLLBACK
            return 'sold out'
    INSERT INTO ticket_orders ...
    COMMIT
```

只要所有交易都用同一個順序碰資料，就不可能形成環路。這是最根本的修法。

修法 2：一句 SQL 更新完，並檢查 affected rows。

```sql
UPDATE ticket_events
SET stock = stock - 1
WHERE id IN (1, 2)
  AND stock > 0;
```

單一語句內部的加鎖順序跟著索引掃描順序走，對所有併發交易都一致。

但這裡有個陷阱：**如果只有一場有票，這條 SQL 的 affected rows 會是 1 而不是 2，你必須把它當成失敗並 rollback**，否則使用者付了兩場的錢只拿到一張票。

```text
BEGIN
  UPDATE ticket_events SET stock = stock - 1
  WHERE id IN (1, 2) AND stock > 0
  if affected_rows != 2:
    ROLLBACK
    return 'sold out'
  INSERT INTO ticket_orders ...
COMMIT
```

不管用哪一種修法，**外層都還是要有重試**：

```text
attempt = 0
loop:
  attempt += 1
  try:
    create_combo_order(event_ids, user_id)
    return
  catch deadlock (1213):
    if attempt < 3:
      sleep random(10ms ~ 100ms)
      continue
    raise
```

死鎖率要進監控。修完之後如果還持續出現，就到 `SHOW ENGINE INNODB STATUS` 撈死鎖現場，看兩條 SQL 卡在哪個索引上——如果 `LOCK_MODE` 顯示 `locks gap before rec`，那是間隙鎖造成的死鎖，要往「先查範圍再插入」這個方向找。

---

## 4.23 驗收清單

- [ ] 我能說明超賣是如何發生的。
- [ ] 我能用 `UPDATE ... WHERE stock > 0` 避免基本超賣。
- [ ] 我知道 unique constraint 是防重複下單的最終防線。
- [ ] 我會用 `UPDATE ... WHERE stock > 0 RETURNING stock` 一次拿到成功與否和剩餘庫存，也知道 MySQL 要在同一交易裡補查。
- [ ] 我知道「先查再插」在開賣瞬間會產生大量唯一約束例外，而 PostgreSQL 的失敗敘述會讓整個交易 aborted。
- [ ] 我會用 `ON CONFLICT (request_id) DO NOTHING RETURNING id` 實作冪等建單，並知道建單與扣庫存必須在同一個交易裡。
- [ ] 我知道一張表有多個唯一約束時，`ON CONFLICT` 指定欄位才能區分「queue 重送」與「重複下單」。
- [ ] 我能比較悲觀鎖與樂觀鎖。
- [ ] 我知道 `NOWAIT` 與 `SKIP LOCKED` 的差別，也知道 `SKIP LOCKED` 不能用在對帳查詢上。
- [ ] 我能解釋為什麼 `WHERE` 走不到索引時，`UPDATE` 的鎖範圍會接近鎖表。
- [ ] 我能說明間隙鎖在防什麼，以及 next-key lock 是行鎖加間隙鎖。
- [ ] 我能判斷「唯一索引等值查詢」與「範圍查詢」的鎖範圍差多少。
- [ ] 我知道 PostgreSQL 沒有間隙鎖，改用 40001 序列化失敗要求我重試。
- [ ] 我能分辨死鎖（1213 / 40P01）與鎖等待超時（1205 / lock_timeout）。
- [ ] 我能說出死鎖的三種成因，並用統一加鎖順序或單句 SQL 修掉它。
- [ ] 我知道死鎖是正常現象，應用程式必須用隨機退避重試，且只重試死鎖不重試業務錯誤。
- [ ] 我能從 `SHOW ENGINE INNODB STATUS` 或 PostgreSQL log 找出死鎖現場的兩條 SQL。
- [ ] 我能寫 Redis Lua 原子扣庫存。
- [ ] 我知道 Queue 的角色是削峰，而不是取代資料庫。
- [ ] 我能設計付款逾時釋放庫存流程。
- [ ] 我知道高併發系統需要補償、重試、冪等與對帳。

---

完成後請前往 [05-redis-caching-design.md](./05-redis-caching-design.md)。
