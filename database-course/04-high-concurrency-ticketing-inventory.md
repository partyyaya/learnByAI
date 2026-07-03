# 第 04 章：高併發搶票、秒殺與庫存扣減設計

> 高併發不是「資料庫跑快一點」而已。
> 搶票、秒殺、限量商品的核心難題是：大量請求同時進來，但庫存有限，系統必須快速回應、不能超賣、不能重複下單，還要能在失敗時恢復一致。
> 這章會用演唱會搶票系統完整拆解。

---

## 4.1 學習目標

完成本章後，你應該可以：

- 說明高併發搶票系統的主要風險。
- 用資料庫條件更新避免基本超賣。
- 理解悲觀鎖、樂觀鎖、唯一約束的角色。
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

## 4.8 Redis 熱庫存預扣

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

## 4.9 為什麼 Redis 扣成功後不能直接算完成

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

## 4.10 消息隊列削峰

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

## 4.11 完整高併發流程

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

## 4.12 防重設計

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

## 4.13 付款逾時與釋放庫存

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

## 4.14 限流與排隊

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

## 4.15 最終一致性

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

## 4.16 Worker 必須冪等

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

---

## 4.17 搶票系統完整資料表範例

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

## 4.18 Redis Lua 完整範例

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

## 4.19 不同方案比較

| 方案 | 優點 | 缺點 | 適合場景 |
|------|------|------|----------|
| DB 條件更新 | 簡單、強一致、可靠 | 極熱 row 壓力大 | 中小流量、最後防線 |
| 悲觀鎖 | 邏輯直覺 | 高併發等待嚴重 | 低衝突強一致流程 |
| 樂觀鎖 | 不先鎖資料 | 高衝突重試多 | 中低衝突更新 |
| Redis 預扣 | 快、可擋大流量 | 需補償與對帳 | 秒殺、搶票熱庫存 |
| Queue 削峰 | 保護 DB、平滑流量 | 非同步、結果延遲 | 高流量下單 |
| Waiting Room | 保護入口、改善公平性 | 系統複雜 | 超大規模開賣 |

實務上不是六選一，而是組合：

```text
限流 + Redis 預扣 + Queue + DB 唯一約束 + DB 條件更新 + 補償對帳
```

---

## 4.20 本章練習

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

---

## 4.21 驗收清單

- [ ] 我能說明超賣是如何發生的。
- [ ] 我能用 `UPDATE ... WHERE stock > 0` 避免基本超賣。
- [ ] 我知道 unique constraint 是防重複下單的最終防線。
- [ ] 我能比較悲觀鎖與樂觀鎖。
- [ ] 我能寫 Redis Lua 原子扣庫存。
- [ ] 我知道 Queue 的角色是削峰，而不是取代資料庫。
- [ ] 我能設計付款逾時釋放庫存流程。
- [ ] 我知道高併發系統需要補償、重試、冪等與對帳。

---

完成後請前往 [05-redis-caching-design.md](./05-redis-caching-design.md)。
