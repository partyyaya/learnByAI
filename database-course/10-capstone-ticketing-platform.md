# 第 10 章：Capstone —— 設計一個演唱會搶票平台

> 這是總複習。我們要把前面九章——選型、建模、SQL、交易、索引、高併發、快取、NoSQL、搜尋分析、擴展、備份安全——全部縫進一個真實系統。
> 這章的價值不在「背出標準答案」，而在**練習把需求拆成資料決策，並說得出每個決策的理由與取捨**。
> 後半段是一份完整的專題規格與評分標準，你可以自己動手做一遍。

---

## 10.1 學習目標

完成本章後，你應該可以：

- 把一個複雜產品需求，拆解成資料庫選型 + 建模 + 效能 + 高併發 + 維運的完整方案。
- 說明每個技術決策「為什麼這樣選」與「代價是什麼」。
- 獨立產出一份可被 review 的資料庫設計文件。

---

## 10.2 需求規格

我們要設計「售票平台」的資料層，核心場景是**熱門演唱會開賣**。

### 功能需求

- 使用者可註冊、登入。
- 主辦方建立活動（演唱會），設定多種票種（VIP、搖滾區、看台），每種票有價格與數量。
- 使用者可搜尋活動（依歌手、場地、日期、關鍵字）。
- 熱門活動開賣瞬間，大量使用者同時搶票。
- 每人每場限購張數（例如 4 張）。
- 搶到票後 10 分鐘內付款，逾時釋放。
- 付款成功後產生電子票券。
- 主辦方與營運要看銷售報表（即時售出、營收、各票種佔比）。

### 非功能需求

- 開賣瞬間可能 50 萬人同時湧入，票只有 2 萬張。
- **絕不超賣。**
- **不重複售票給同一請求。**
- 搜尋要快、要能容錯字與斷詞。
- 報表不能拖垮購票主流程。
- 資料要能備份與恢復，個資與金流要安全。

---

## 10.3 第一步：資料庫選型（呼應第 00、05、06、07 章）

先別急著畫表，先決定「哪種資料放哪裡」。

| 資料/場景 | 選用 | 理由 |
|-----------|------|------|
| 使用者、活動、票種、訂單、票券 | PostgreSQL（事實來源） | 強關係、需交易與強一致，金流與庫存絕不能錯（第 00、02 章） |
| 熱庫存預扣、防重、分散式鎖 | Redis | 開賣瞬間高併發，需原子操作與極低延遲（第 04、05 章） |
| 開賣削峰、非同步建單 | 消息隊列（Kafka/RabbitMQ/SQS） | 把 50 萬瞬時請求，變成 DB 可消化的速度（第 04 章） |
| 活動搜尋 | Elasticsearch | 斷詞、容錯、相關度排序、多條件過濾（第 07 章） |
| 銷售報表分析 | ClickHouse（或 replica） | 大範圍聚合不打主庫（第 03、07、08 章） |
| 頁面/結果查詢加速 | Redis | 快取活動資訊、搶票結果（第 05 章） |

**核心心智（第 00 章）**：PostgreSQL 是唯一事實來源，Redis / ES / ClickHouse 都是可重建的衍生副本，走最終一致。

---

## 10.4 第二步：關聯式建模（呼應第 01 章）

### ER 關係

```text
users 1 ── N orders 1 ── N tickets
events 1 ── N ticket_types 1 ── N tickets
orders N ── 1 events
```

### 資料表

```sql
CREATE TABLE users (
    id            BIGSERIAL PRIMARY KEY,
    email         VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,        -- bcrypt/argon2（第 09 章）
    name          VARCHAR(100) NOT NULL,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE events (
    id             BIGSERIAL PRIMARY KEY,
    title          VARCHAR(200) NOT NULL,
    artist         VARCHAR(200) NOT NULL,
    venue          VARCHAR(200) NOT NULL,
    show_time      TIMESTAMP NOT NULL,
    sale_starts_at TIMESTAMP NOT NULL,
    status         VARCHAR(30) NOT NULL,        -- draft/on_sale/sold_out/closed
    created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ticket_types (
    id          BIGSERIAL PRIMARY KEY,
    event_id    BIGINT NOT NULL REFERENCES events(id),
    name        VARCHAR(50) NOT NULL,           -- VIP/搖滾區/看台
    price       NUMERIC(12,2) NOT NULL,
    total_stock INT NOT NULL,                   -- 原始總量
    stock       INT NOT NULL,                   -- 目前剩餘（DB 最終防線）
    CHECK (price >= 0),
    CHECK (stock >= 0),
    CHECK (stock <= total_stock)
);

CREATE TABLE orders (
    id           BIGSERIAL PRIMARY KEY,
    request_id   VARCHAR(100) NOT NULL UNIQUE,  -- 冪等鍵（第 04 章）
    user_id      BIGINT NOT NULL REFERENCES users(id),
    event_id     BIGINT NOT NULL REFERENCES events(id),
    status       VARCHAR(30) NOT NULL,          -- pending_payment/paid/expired/cancelled
    total_amount NUMERIC(12,2) NOT NULL,
    expire_at    TIMESTAMP NOT NULL,
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    paid_at      TIMESTAMP
);

CREATE TABLE tickets (
    id             BIGSERIAL PRIMARY KEY,
    order_id       BIGINT NOT NULL REFERENCES orders(id),
    ticket_type_id BIGINT NOT NULL REFERENCES ticket_types(id),
    event_id       BIGINT NOT NULL REFERENCES events(id),
    -- 反正規化下單當下的票種名與價格（第 01 章）
    type_name      VARCHAR(50) NOT NULL,
    price          NUMERIC(12,2) NOT NULL,
    seat_label     VARCHAR(50),
    ticket_code    VARCHAR(64) NOT NULL UNIQUE, -- 電子票券碼
    created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### 設計決策說明

- `orders.request_id UNIQUE`：支援冪等，queue 重送不會重複建單（第 04 章）。
- 每人限購用「應用檢查 + 唯一約束/計數」雙保險。若「每人每場限一張」，可對 `orders(event_id, user_id)` 加唯一約束；限購多張則在建單交易內檢查已購數量。
- `tickets` 冗餘 `type_name`、`price`：票種日後改名改價，舊票券仍顯示購買當下的資訊（第 01 章反正規化）。
- `ticket_types` 同時有 `total_stock` 與 `stock`：`stock` 是 DB 最終防線，Redis 是熱庫存。

---

## 10.5 第三步：索引設計（呼應第 03 章）

依「最高頻查詢」設計索引：

```sql
-- 查某使用者的訂單列表（個人頁）
CREATE INDEX idx_orders_user_created ON orders(user_id, created_at DESC);

-- 掃描逾期未付款訂單（釋放庫存的排程）
CREATE INDEX idx_orders_status_expire ON orders(status, expire_at);

-- 查某活動的票種
CREATE INDEX idx_ticket_types_event ON ticket_types(event_id);

-- 查某訂單的票券
CREATE INDEX idx_tickets_order ON tickets(order_id);

-- 報表：某活動各票種售出（若報表走主庫 replica 時用）
CREATE INDEX idx_tickets_event_type ON tickets(event_id, ticket_type_id);
```

決策說明：

- `idx_orders_status_expire` 讓「找出所有 `pending_payment` 且 `expire_at < now`」的排程掃描走索引，不掃全表（第 03、04 章）。
- 索引不是越多越好，寫入頻繁的 `orders`/`tickets` 只建高頻查詢需要的（第 03 章）。

---

## 10.6 第四步：搜尋設計（呼應第 07 章）

活動資料在 PostgreSQL，搜尋走 Elasticsearch。

mapping：

```json
PUT /events
{
  "mappings": {
    "properties": {
      "title":     { "type": "text" },
      "artist":    { "type": "text" },
      "venue":     { "type": "keyword" },
      "show_time": { "type": "date" },
      "status":    { "type": "keyword" }
    }
  }
}
```

- `title`、`artist` 用 `text`：全文搜尋、斷詞、容錯。
- `venue`、`status` 用 `keyword`：精確過濾與聚合。
- 同步方式：CDC 或 MQ，把 PostgreSQL 的活動變更同步到 ES，走**最終一致**（搜尋結果晚幾秒更新可接受）。

---

## 10.7 第五步：高併發搶票流程（呼應第 04、05 章）

這是整個系統的心臟。完整資料流：

```text
使用者
  │  ①
  ▼
Waiting Room / API Gateway 限流 ──── 擋掉超量與機器人流量
  │  ②
  ▼
搶票 API
  │  ③ Redis Lua：檢查防重 + 原子扣熱庫存
  ▼
Redis（stock、防重 key）
  │  ④ 預扣成功
  ▼
Message Queue（削峰）
  │  ⑤
  ▼
Order Worker（冪等）
  │  ⑥ DB 交易：條件扣 stock + 建 order + 建 tickets
  ▼
PostgreSQL（最終防線）
  │  ⑦ 結果寫回 Redis
  ▼
使用者輪詢 / WebSocket 取得結果
```

### 開賣前準備

```text
1. PostgreSQL 建 event、ticket_types，stock = total_stock
2. 把各票種 stock 載入 Redis：SET ticket:type:{id}:stock 20000
3. 預熱活動頁快取
4. 設定限流規則、啟動 worker、確認 queue
```

### Redis Lua：防重 + 原子扣庫存（第 04、05 章）

```lua
-- KEYS[1] = ticket:type:{id}:stock
-- KEYS[2] = ticket:type:{id}:user:{userId}
-- ARGV[1] = 購買張數
-- ARGV[2] = 防重 key TTL 秒數
local bought = tonumber(redis.call('GET', KEYS[2]) or '0')
if bought + tonumber(ARGV[1]) > 4 then
  return 2                       -- 超過限購
end

local stock = tonumber(redis.call('GET', KEYS[1]))
if stock == nil then
  return -1                      -- 未初始化
end
if stock < tonumber(ARGV[1]) then
  return 0                       -- 售完/不足
end

redis.call('DECRBY', KEYS[1], ARGV[1])
redis.call('INCRBY', KEYS[2], ARGV[1])
redis.call('EXPIRE', KEYS[2], ARGV[2])
return 1                         -- 預扣成功
```

### Order Worker：DB 最終防線（第 02、04 章）

```text
收到 queue 訊息 { request_id, user_id, event_id, ticket_type_id, qty }
BEGIN
  -- 冪等：request_id 已存在就回既有結果
  if order with request_id exists: return existing

  -- DB 條件扣庫存（即使 Redis 有 bug 也不會超賣）
  UPDATE ticket_types SET stock = stock - :qty
    WHERE id = :ticket_type_id AND stock >= :qty
  if affected_rows != 1:
    ROLLBACK; 補償 Redis（INCRBY 回庫存、扣回限購計數）; return sold_out

  INSERT INTO orders (request_id, user_id, event_id, status, total_amount, expire_at)
    VALUES (..., 'pending_payment', ..., now + 10min)
  INSERT INTO tickets (...) x qty
COMMIT
把結果寫回 Redis 供前端查詢
```

### 為什麼要「Redis 預扣 + DB 再扣」兩層

- Redis 擋住 50 萬瞬時流量，讓 99% 的失敗請求根本不碰 DB（第 05 章削峰）。
- DB 的 `WHERE stock >= qty` 是最終防線：就算 Redis 邏輯或補償出錯，也絕不超賣（第 04 章）。
- 兩層之間用補償與對帳維持最終一致。

---

## 10.8 第六步：付款逾時與釋放（呼應第 04 章）

```text
建單時：expire_at = now + 10min，發一則 10 分鐘延遲訊息
到期處理（冪等）：
BEGIN
  UPDATE orders SET status = 'expired'
    WHERE id = :id AND status = 'pending_payment' AND expire_at < now
  if affected_rows = 1:                 -- 只有真的從待付款轉逾期才釋放
      UPDATE ticket_types SET stock = stock + :qty WHERE id = :type_id
      同步把庫存加回 Redis
COMMIT
```

關鍵：只有 `affected_rows = 1` 才釋放庫存，避免「已付款」或「重複處理」時錯誤加回庫存。

---

## 10.9 第七步：報表（呼應第 03、07、08 章）

需求：營運看即時售出、營收、各票種佔比。

方案：

- **不要**直接在購票主庫跑大聚合（會拖垮搶票）。
- 把 `orders`/`tickets` 透過 CDC 同步到 ClickHouse，報表查 ClickHouse。
- 「即時售出數」這類高頻小數字，可直接用 Redis 計數器（搶票時已在扣庫存，順帶可得已售 = total - 剩餘）。

ClickHouse 報表範例：

```sql
SELECT
    type_name,
    count() AS sold,
    sum(price) AS revenue
FROM tickets
WHERE event_id = 1001
GROUP BY type_name
ORDER BY revenue DESC;
```

---

## 10.10 第八步：擴展與維運（呼應第 08、09 章）

### 擴展

```text
讀取壓力（看活動、查訂單）→ 讀寫分離，加從庫
活動/訂單資料量大         → 訂單按 show_time 或月份分區
真的到單機瓶頸           → 考慮分片或 NewSQL（謹慎，別過早）
```

### 備份與安全

```text
備份：全量 + WAL 歸檔，支援 PITR；3-2-1；定期恢復演練（第 09 章）
權限：app 帳號最小權限，不用 superuser
注入：全程參數化查詢
個資：password 用 bcrypt；金流走合規第三方
審計：退款、改價、釋放庫存等敏感操作寫 audit_logs
```

---

## 10.11 常見設計失誤（自我檢查）

- 只用 DB 硬扛開賣瞬間，沒有 Redis/queue → 主庫被打爆。
- 用 Redis 當事實來源，沒有 DB 最終防線 → Redis 一出問題就超賣。
- 忘了冪等，queue 重送 → 重複建單、重複出票。
- 逾時釋放不檢查 `affected_rows` → 庫存被錯誤加回，又超賣。
- 搜尋用 `LIKE`、報表打主庫 → 慢且互相拖累。
- 有複製當作有備份 → 誤刪無法回溯。

---

## 10.12 專題作業與評分標準

請獨立產出一份「售票平台資料庫設計文件」，內容至少包含：

### 交付項目

1. **選型表**：每種資料放哪個資料庫，附理由（對照 10.3）。
2. **ER 圖與建表 SQL**：含主鍵、外鍵、唯一約束、CHECK、反正規化欄位。
3. **索引設計**：列出每個索引對應的高頻查詢。
4. **高併發流程圖**：限流 → Redis 預扣 → queue → worker → DB，含防超賣與防重複的每一道防線。
5. **付款逾時釋放**流程，說明冪等如何保證。
6. **搜尋方案**：ES mapping 與同步/一致性說明。
7. **報表方案**：為何不打主庫、怎麼同步。
8. **擴展路線**：目前規模用什麼、未來瓶頸怎麼演進。
9. **備份與安全**：備份策略、PITR、權限、注入防禦、個資保護。

### 評分標準（100 分）

| 面向 | 配分 | 檢查重點 |
|------|------|----------|
| 選型合理性 | 15 | 每種資料放對地方，說得出理由與取捨 |
| 資料建模 | 15 | 關係正確、約束完整、反正規化用得恰當 |
| 索引設計 | 10 | 對齊高頻查詢，不亂加 |
| 防超賣 | 15 | Redis + DB 雙層，最終防線可靠 |
| 防重複/冪等 | 10 | request_id、唯一約束、worker 冪等 |
| 逾時釋放 | 10 | 檢查 affected_rows，流程冪等 |
| 搜尋與報表分流 | 10 | 不拖垮主庫，一致性取捨清楚 |
| 擴展規劃 | 5 | 循序漸進，不過早分片 |
| 備份與安全 | 10 | 備份可恢復、最小權限、參數化、個資保護 |

### 加分挑戰

- 設計「候補（waitlist）」機制：售完後有人退票，自動補位給候補者。
- 設計「防黃牛」：同一裝置/IP/付款方式的風控規則。
- 設計「開賣公平性」：等待室隨機排序而非純先到先得（第 04 章）。

---

## 10.13 課程總回顧

你已經走完這門課的完整心智地圖：

```text
第 00 章  選型與取得      → 先判斷需求，再選資料庫，別什麼都塞一種
第 01 章  關聯式建模      → 關係、約束、正規化與有意識的反正規化
第 02 章  SQL 與交易      → CRUD/JOIN/聚合，ACID 保護金流與庫存
第 03 章  索引與效能      → 依查詢模式建索引，EXPLAIN、分頁、N+1
第 04 章  高併發搶票      → 條件更新、鎖、Redis 預扣、queue、冪等、補償
第 05 章  快取設計        → Cache Aside、穿透/擊穿/雪崩、排行榜、分散式鎖
第 06 章  NoSQL 文件建模  → 查詢驅動、內嵌 vs 引用
第 07 章  搜尋與分析      → 倒排索引、列式儲存、主庫 + 衍生副本
第 08 章  架構擴展        → 讀寫分離、分區、分片，循序漸進
第 09 章  備份與安全      → PITR、最小權限、SQL Injection、個資保護
第 10 章  Capstone        → 把以上全部縫進一個真實系統
```

貫穿全課的三個核心觀念：

1. **先判斷、再動手**：資料決策的起點永遠是「需求與查詢模式」，不是「哪個技術潮」。
2. **事實來源只有一個**：資料庫是真相，Redis/ES/ClickHouse 都是可重建的加速副本，該最終一致就最終一致。
3. **強一致靠資料庫兜底**：快取、隊列、鎖能提升效能與擴展性，但金流與庫存的最後防線永遠是資料庫的約束與交易。

把這三點內化，你面對任何新系統，都能做出站得住腳的資料庫設計。

---

## 10.14 驗收清單

- [ ] 我能把一個複雜需求拆成選型、建模、效能、高併發、維運的完整方案。
- [ ] 我能說明搶票系統防超賣與防重複的每一道防線。
- [ ] 我能解釋每個技術決策的理由與代價。
- [ ] 我完成了專題設計文件，並能通過評分標準的自我檢查。
- [ ] 我能講清楚「事實來源、衍生副本、最終一致、強一致兜底」這組核心觀念。

---

恭喜你完成整門課。回到 [課程首頁](./README.md) 可以複習任何章節，或直接開始你的專題設計。
