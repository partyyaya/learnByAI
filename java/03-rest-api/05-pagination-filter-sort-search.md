# 第 05 章：分頁、篩選與排序

> 這一章處理的是**「集合端點」**—— 也就是你系統裡流量最大、最容易在半年後炸掉的那幾支 API。
> 它的特殊之處在於：**設計錯了不會馬上出事**。
> 資料 1,000 筆時一切正常，10 萬筆時開始變慢，300 萬筆時某個管理後台的頁面直接逾時，
> 而那時候前端、App、三家廠商的 ERP 都已經照著你當初的參數格式寫死了。
> 所以這一章的主題不只是「怎麼分頁」，而是**「怎麼設計一個在資料長大 1000 倍後還活著的集合端點」**。

---

## 5.1 學習目標

完成本章後，你應該可以：

- 說出「沒有分頁上限」在資料庫、JVM、網路三個層面各造成什麼具體後果。
- 完整說明 offset 分頁的兩個致命問題：**深分頁**與**資料漂移**，並算出效能代價。
- 實作 cursor（keyset）分頁，包含**為什麼必須用複合鍵**與 cursor 的編碼／驗證設計。
- 在 offset 與 cursor 之間做出有理由的選擇，並知道怎麼在同一支 API 同時支援兩者。
- 說出 `totalElements` 的真實代價，並給出四種折衷方案。
- 設計篩選參數：範圍、多值、布林三態、null 篩選，以及**為什麼「靜默忽略未知參數」是嚴重缺陷**。
- 設計排序參數：格式、白名單、**tie-breaker**，以及排序與索引的關係。
- 區分「搜尋」與「篩選」，並知道 `LIKE '%x%'`、MySQL 全文索引、Elasticsearch 的分界在哪。
- 設計五層效能防護，讓集合端點不可能被單一請求打掛。
- 完成 shop-service 的分頁／篩選／排序完整規格與索引清單。

---

## 5.2 為什麼分頁是「會在半年後炸掉」的設計缺陷

### 5.2.1 先看事故

某電商的訂單列表端點，上線時是這樣：

```java
@GetMapping("/orders")
public List<OrderSummary> list(@RequestParam(required = false) String status) {
    return orderService.findAll(status);      // 沒有分頁
}
```

**上線第一個月**：資料庫有 3,000 筆訂單。回應 1.2 MB，780 ms。沒人抱怨。

**第八個月**：資料庫有 42 萬筆訂單。

```
14:02:11  財務部門的實習生打開「全部訂單」頁面（沒有篩選）
14:02:11  MySQL 開始執行 SELECT ... FROM orders（全表掃描）
14:02:19  8 秒後，420,000 筆資料開始傳回 JVM
14:02:23  Hibernate 開始把 420,000 筆組成 Entity 物件
14:02:26  JVM 老年代使用率 94%
14:02:27  Full GC，STW 2.1 秒
14:02:29  Full GC，STW 3.4 秒
14:02:31  java.lang.OutOfMemoryError: Java heap space
14:02:31  ⚠️ 整個 Pod 掛掉 —— 不只是這一個請求失敗
14:02:31  另外 340 個正在處理中的請求全部中斷
14:02:33  K8s 重啟 Pod，冷啟動 18 秒
14:02:33  流量全部湧向另一台 Pod
14:02:40  另一台 Pod 也因為流量倍增 + 有人重試 → 也掛了
14:02:40  🔴 全站不可用
14:05:12  值班工程師收到告警
14:18:40  服務恢復（手動擴容 + 暫時封鎖該端點）
```

**一個沒有分頁上限的端點，一個實習生點一下，全站掛 16 分鐘。**

### 5.2.2 三個層面的代價

| 層面 | 問題 | 具體數字（量級示意） |
|---|---|---|
| **資料庫** | 全表掃描、佔用連線、可能拖慢其他查詢 | 42 萬筆 × 每筆 300 bytes = 126 MB 從磁碟／buffer pool 讀出 |
| **資料庫連線** | 一個慢查詢佔住連線池的一格 8 秒 | HikariCP 預設 10 條連線 → 10 個這種請求就完全阻塞 |
| **JVM 記憶體** | Entity 物件 + DTO 物件 + JSON 字串**同時**存在 | 42 萬 Entity ≈ 400 MB；DTO ≈ 200 MB；JSON 字串 ≈ 150 MB → **750 MB 尖峰** |
| **序列化 CPU** | Jackson 要序列化 42 萬個物件 | 單執行緒約 3～8 秒，而且無法中斷 |
| **網路** | 回應 126 MB | 客戶端在 4G 下要下載 3 分鐘，而且瀏覽器解析 JSON 會凍結 UI |
| **可觀測性** | 這個請求在 APM 上是一個 20 秒的 span | 但它造成的 Full GC 影響了**其他 340 個請求**，因果關係很難看出來 |

**最重要的一點**：這不是「這個請求變慢」，而是**「這個請求把整台機器拖垮」**。
單一請求造成全域影響，這在架構上叫**吵鬧的鄰居（noisy neighbour）**。

### 5.2.3 「預設值」和「上限」是兩件事

這是最常被搞混的地方：

```java
// ❌ 只有預設值，沒有上限
@GetMapping("/orders")
public PageResponse<OrderSummary> list(
        @RequestParam(defaultValue = "0") int page,
        @RequestParam(defaultValue = "20") int size) {   // ← 預設 20
    ...
}
```

「加了分頁」的錯覺。但：

```
GET /orders?size=999999      → 還是把 42 萬筆撈出來
GET /orders?size=-1          → 某些 ORM 會當成「無限制」
GET /orders?page=0&size=0    → 某些實作會回全部
```

**必須三個都設**：

| 設定 | shop-service 的值 | 為什麼 |
|---|---|---|
| **預設值** | `size=20` | 沒帶參數時的行為，決定「一般使用」的成本 |
| **上限** | `size<=100` | 惡意或手滑時的**硬天花板**，超過一律 `400` |
| **最小值** | `size>=1` | `0` 或負數要拒絕，不能有「特殊語意」 |

```java
public record PageQuery(
    @Min(value = 0, message = "頁碼不可小於 0")
    int page,

    @Min(value = 1, message = "每頁至少 1 筆")
    @Max(value = 100, message = "每頁最多 100 筆")
    int size
) {
    public PageQuery {
        // ⚠️ 注意：這裡不要「自動夾到範圍內」（見下）
    }
}
```

### 5.2.4 超過上限：`400` 還是「靜默夾到 100」？

```
GET /orders?size=10000
```

| 做法 | 說明 | 評價 |
|---|---|---|
| **A. 回 `400`** | 明確拒絕 | ★ **推薦**。客戶端立刻知道自己錯了 |
| **B. 靜默夾到 100** | 當成 `size=100` 處理 | 🔴 危險，見下 |
| **C. 夾到 100 + 回 warning** | 回 `200` 但 body 有 `warnings[]` | ⚠️ 折衷，但客戶端通常不會讀 warning |

**為什麼 B 危險**：

```javascript
// 前端寫了一個「一次拉全部」的匯出功能
const all = [];
let page = 0;
while (true) {
  const res = await get(`/orders?page=${page}&size=10000`);
  all.push(...res.items);
  if (res.items.length < 10000) break;      // ← 用「不足一頁」判斷結束
  page++;
}
```

如果後端靜默夾到 100，第一次就回 100 筆 → `100 < 10000` → **迴圈立刻結束**
→ **只拿到 100 筆，但前端以為拿到全部了**。

然後這份「全部訂單」報表被送去財務，少了 41.99 萬筆。**而且沒有任何錯誤訊息。**

**shop-service 的決定：回 `400` + 明確的錯誤訊息。**

```jsonc
{
  "type": "https://api.shop.example/problems/malformed-request",
  "title": "請求格式錯誤",
  "status": 400,
  "code": "MALFORMED_REQUEST",
  "userMessage": "查詢參數有誤，請聯絡技術支援。",
  "errors": [
    {
      "field": "size",
      "code": "MAX",
      "message": "每頁最多 100 筆",
      "rejectedValue": 10000,
      "constraint": { "max": 100 }
    }
  ],
  "hint": "若需取得大量資料，請改用 POST /order-exports 建立匯出工作。",
  "traceId": "4f2c8a1e9b7d3f60"
}
```

**注意 `hint` 欄位**：它把「你不能這樣做」變成「你應該這樣做」。
這一句話會省掉大量的「那我要怎麼拉全部資料」的工單。

> ⚠️ **Spring Data 的預設上限是 2000**（`spring.data.web.pageable.max-page-size`），
> 而且**超過時是靜默夾到 2000，不是回 400**。
> 這是做法 B —— 所以如果你用 `Pageable` 自動綁定，**必須自己加驗證**（5.13.2）。

---

## 5.3 offset 分頁

### 5.3.1 基本設計

```http
GET /orders?page=0&size=20
```

```jsonc
{
  "items": [ /* 20 筆 */ ],
  "page": {
    "number": 0,
    "size": 20,
    "totalElements": 1523,
    "totalPages": 77
  }
}
```

對應的 SQL：

```sql
SELECT id, order_number, status, total_amount, created_at
FROM orders
WHERE customer_id = ?
ORDER BY created_at DESC, id DESC
LIMIT 20 OFFSET 0;

-- 總筆數（第二個查詢！見 5.6）
SELECT COUNT(*) FROM orders WHERE customer_id = ?;
```

### 5.3.2 參數命名

業界有四種主流，**選一個然後全站一致**（第 00 章判準 2）：

| 風格 | 參數 | 誰在用 |
|---|---|---|
| **page / size** | `?page=0&size=20` | ★ Spring Data、本課程 |
| pageNumber / pageSize | `?pageNumber=1&pageSize=20` | .NET 生態、部分企業 API |
| limit / offset | `?limit=20&offset=40` | SQL 直觀、PostgREST、部分 REST API |
| page[number] / page[size] | `?page[number]=1&page[size]=20` | JSON:API 規範 |

**`page/size` vs `limit/offset` 的取捨**：

| | `page/size` | `limit/offset` |
|---|---|---|
| 直觀度 | ★ 對前端（「第幾頁」） | ★ 對後端（直接對應 SQL） |
| 換頁計算 | `page++` | `offset += limit` |
| **危險** | — | 🔴 客戶端可以送 `offset=999999`（任意深度） |
| 換 size 的行為 | 頁碼語意跟著變（`page=2&size=20` ≠ `page=2&size=50` 的位置） | offset 不變，語意穩定 |

**shop-service 選 `page/size`**，理由：
- 前端最直觀（分頁元件就是「第幾頁」）。
- 和 Spring Data 的預設一致，少一層轉換。
- `page × size` 的乘積可以一起做上限檢查（5.3.5）。

### 5.3.3 0-based 還是 1-based ★ 這題有真實災難

```
GET /orders?page=0    第一頁（0-based，Spring Data 預設）
GET /orders?page=1    第一頁（1-based，人類直覺）
```

**這是一個必須在第一天決定、之後永遠不能改的參數。**

**改它的災難**（真實案例）：

某系統原本 0-based，後來有人覺得「1-based 比較直覺」，
在 Spring 加上 `spring.data.web.pageable.one-indexed-parameters=true` 就上線了。

```
改版前（0-based）                 改版後（1-based）
GET /orders?page=0 → 第 1～20 筆   GET /orders?page=0 → ⚠️ 被當成 page=1 → 第 1～20 筆
GET /orders?page=1 → 第 21～40 筆  GET /orders?page=1 → 第 1～20 筆   ← 🔴 重複！
GET /orders?page=2 → 第 41～60 筆  GET /orders?page=2 → 第 21～40 筆
```

結果：

| Consumer | 症狀 |
|---|---|
| Web 前端 | 同步改了，正常 ✅ |
| iOS App（舊版） | 第一頁和第二頁**顯示一樣的資料**（使用者覺得「卡住了」） |
| 廠商的 ERP 對帳批次 | 🔴 **第一頁的 20 筆被算了兩次** → 對帳金額多出約 20 筆訂單的金額 |
| 內部報表腳本 | 🔴 每次迴圈多算一頁 → 統計數字錯誤，**三週後才被發現** |

**最嚴重的是廠商的對帳**：他們的系統已經把錯誤的金額寫進帳務憑證了。

**判準與建議**：

| 選擇 | 理由 |
|---|---|
| **0-based** | ★ 和 `OFFSET = page × size` 的數學一致；和 Spring Data 預設一致；程式碼裡不會有 `page - 1` |
| 1-based | 對非工程師（PM、客服）友善；URL 貼給別人看比較直覺 |

**shop-service 選 0-based**，並且**在 OpenAPI 與每一份文件裡用粗體標明**：

```yaml
- name: page
  in: query
  schema: { type: integer, minimum: 0, default: 0 }
  description: |
    頁碼，**從 0 開始**（0 = 第一頁）。
    ⚠️ 此參數的基準永不變更。若您的系統採 1-based，請在呼叫端做 -1 轉換。
```

> **如果你已經上線且是 1-based，不要改。** 一致性 > 正確性。
> 真的要改，唯一安全的方式是**開新版本**（第 06 章），或**新增一個不同名字的參數**
> （例如保留 `page` 為 1-based，新增 `pageIndex` 為 0-based，並標記 `page` 為 deprecated）。

### 5.3.4 致命問題一：深分頁（deep pagination）

```sql
SELECT * FROM orders ORDER BY created_at DESC, id DESC LIMIT 20 OFFSET 400000;
```

**MySQL 實際做了什麼**：

```
① 依 (created_at DESC, id DESC) 走索引
② 讀出第 1 筆 → 丟棄
③ 讀出第 2 筆 → 丟棄
   ...
④ 讀出第 400,000 筆 → 丟棄
⑤ 讀出第 400,001 ～ 400,020 筆 → 回傳
```

**它必須讀取並丟棄 40 萬筆。** `OFFSET` 不是「跳過」，是「讀出來然後不要」。

**效能曲線（量級示意，實際數字取決於硬體、索引、buffer pool）**：

| `page` | `OFFSET` | 需掃描列數 | 典型耗時 |
|---|---|---|---|
| 0 | 0 | 20 | 2 ms |
| 10 | 200 | 220 | 3 ms |
| 100 | 2,000 | 2,020 | 12 ms |
| 1,000 | 20,000 | 20,020 | 95 ms |
| 10,000 | 200,000 | 200,020 | 850 ms |
| 20,000 | 400,000 | 400,020 | 1,900 ms |
| 50,000 | 1,000,000 | 1,000,020 | 5,200 ms → **逾時** |

**耗時和 `OFFSET` 成正比。** 這是 offset 分頁的數學本質，**沒有辦法用索引解決**。

**用 `EXPLAIN` 驗證**：

```sql
EXPLAIN ANALYZE
SELECT id, order_number FROM orders
ORDER BY created_at DESC, id DESC
LIMIT 20 OFFSET 400000;
```

```
-> Limit/Offset: 20/400000 row(s)  (actual time=1893..1894 rows=20 loops=1)
    -> Index scan on orders using idx_orders_created_id (reverse)
       (actual time=0.05..1750 rows=400020 loops=1)
                                       ↑↑↑↑↑↑
                          實際掃了 400,020 筆才拿到 20 筆
```

**覆蓋索引能不能救？** 只能減輕，不能解決：

```sql
-- 覆蓋索引：只讀索引不回表（index-only scan）
CREATE INDEX idx_cover ON orders (created_at DESC, id DESC, order_number, status, total_amount);

-- 或用「先取 ID 再 join」的技巧（deferred join）
SELECT o.* FROM orders o
JOIN (
    SELECT id FROM orders
    ORDER BY created_at DESC, id DESC
    LIMIT 20 OFFSET 400000            -- ← 這一段只掃索引，不回表
) t ON o.id = t.id;
```

**deferred join 的效果**：把「掃 40 萬筆完整列」變成「掃 40 萬筆索引項」。
索引項小很多（可能只有 1/10 大小），所以會快 3～10 倍。

**但它仍然是 O(offset)。** 40 萬變 400 萬時還是會逾時。
**這只是把牆推遠，不是拆掉牆。**

### 5.3.5 深分頁的三道防線

**防線 1：限制最大頁碼（最簡單有效）**

```java
public record PageQuery(
    @Min(0) @Max(500) int page,          // ← 硬上限
    @Min(1) @Max(100) int size
) {
    public PageQuery {
        if ((long) page * size > 10_000) {
            throw new DeepPaginationException(page, size, 10_000);
        }
    }
}
```

```jsonc
// GET /orders?page=1000&size=100
{
  "type": "https://api.shop.example/problems/deep-pagination-not-supported",
  "title": "不支援深分頁",
  "status": 400,
  "code": "DEEP_PAGINATION_NOT_SUPPORTED",
  "detail": "page × size must not exceed 10000. Requested offset is 100000.",
  "userMessage": "無法瀏覽這麼深的頁數，請縮小篩選條件。",
  "maxOffset": 10000,
  "requestedOffset": 100000,
  "hint": "若需完整資料請改用 cursor 分頁（?cursor=）或 POST /order-exports 匯出。",
  "traceId": "..."
}
```

**這不是「偷懶」—— 這是業界標準做法**：

| 服務 | 深分頁上限 |
|---|---|
| GitHub Search API | 前 **1,000** 筆結果 |
| Elasticsearch | `index.max_result_window` 預設 **10,000**（超過要用 `search_after`） |
| Google 搜尋 | 約 **400** 筆（第 40 頁左右就沒了） |
| Twitter/X API v2 | 不提供 offset，**只有 cursor** |
| Stripe | 不提供 offset，**只有 cursor** |

**理由**：**沒有人會真的翻到第 5,000 頁。** 想翻那麼深的一定是程式（爬蟲或匯出腳本），
而它們應該用 cursor 或匯出端點。

**防線 2：`sql_select_limit` 與查詢超時**

```sql
-- Session 層級的硬上限（防止任何查詢回傳超過 N 列）
SET SESSION sql_select_limit = 1000;

-- 單一查詢的執行時間上限（MySQL 5.7.8+，只對唯讀 SELECT 有效）
SELECT /*+ MAX_EXECUTION_TIME(2000) */ id, order_number FROM orders ...;
```

```yaml
# Spring 層級
spring:
  jpa:
    properties:
      jakarta.persistence.query.timeout: 3000     # ms
  datasource:
    hikari:
      connection-timeout: 3000
      validation-timeout: 2000
```

**防線 3：引導到正確的工具**

| 使用者真正想做的事 | 該用什麼 |
|---|---|
| 瀏覽最近的訂單 | offset 分頁（前幾頁） |
| 找特定訂單 | **篩選／搜尋**（`?orderNumber=`、`?q=`），不是翻頁 |
| 逐筆處理全部資料（同步、批次） | **cursor 分頁**（5.4） |
| 下載全部資料（報表、對帳） | **匯出工作**（第 02 章 2.10） |

**「翻到第 5000 頁」永遠是使用者用錯工具的訊號。**
你的錯誤訊息應該告訴他正確的工具（`hint` 欄位）。

### 5.3.6 致命問題二：資料漂移（unstable pagination）

**這個問題比深分頁更陰險，因為它不會變慢，只會給出錯誤的資料。**

情境：客服要逐頁檢視所有待處理訂單，同時新訂單持續進來。

```
資料庫初始狀態（按 created_at DESC 排序）：
  [O100, O99, O98, ..., O81]  ← 第 1 頁（page=0, size=20）
  [O80,  O79, O78, ..., O61]  ← 第 2 頁

T1  客服看第 1 頁 → 拿到 O100 ~ O81 ✅

T2  💥 有 3 筆新訂單進來：O101, O102, O103
    資料庫變成：
      [O103, O102, O101, O100, O99, ..., O84]  ← 現在的第 1 頁
      [O83,  O82,  O81,  O80,  O79, ..., O64]  ← 現在的第 2 頁

T3  客服點「下一頁」（page=1, size=20）
    → 拿到 O83 ~ O64
    → 🔴 O84 ~ O81 這 4 筆客服在第 1 頁已經看過了（重複）
    → 而且如果客服在第 1 頁「處理」了它們，現在又看到一次
```

**反過來也會發生（刪除／狀態變更導致漏掉）**：

```
T1  客服看第 1 頁 → O100 ~ O81
T2  💥 O95、O90、O85 被取消（篩選條件是 status=PENDING，所以它們離開了結果集）
    資料庫的 PENDING 訂單變成：
      [O100, O99, ..., O78]     ← 現在的第 1 頁（往前補了 3 筆）
T3  客服點「下一頁」（page=1）
    → 從第 21 筆開始 = O77
    → 🔴 O80、O79、O78 被跳過了，客服永遠不會看到這 3 筆
```

**「永遠不會看到」是最嚴重的**：這不是效能問題，是**資料正確性問題**，
而且**沒有任何錯誤訊息**。

**offset 分頁的數學本質**：`OFFSET` 是「位置」，而位置在資料變動時會漂移。

**四種緩解方式**：

| 方式 | 做法 | 評價 |
|---|---|---|
| **A. 用 cursor 分頁** | 記住「上一筆的值」而不是「位置」 | ★ 根本解法（5.4） |
| **B. 凍結時間點** | 加一個 `?asOf=2026-08-19T06:12:44Z` 參數，只查該時間點之前建立的 | ✅ 簡單有效，適合報表；但只解決「新增」不解決「刪除／狀態變更」 |
| **C. 快照查詢** | 第一次查詢時建立一個結果集快照（暫存表／Redis），後續分頁從快照讀 | ⚠️ 複雜、要清理、佔空間；只在「必須絕對一致」時用 |
| **D. 接受它** | 對「瀏覽最新資料」的場景，重複／漏掉幾筆通常無害 | ✅ 大部分 C 端場景的正確答案 |

**方式 B 的具體樣子**（很實用，成本很低）：

```http
GET /orders?status=PENDING_PAYMENT&page=0&size=20

→ 200 OK
{
  "items": [...],
  "page": { "number": 0, "size": 20, "totalElements": 1523, "totalPages": 77 },
  "asOf": "2026-08-19T06:12:44Z"          // ★ 伺服器回傳這次查詢的基準時間
}
```

```http
# 客戶端翻下一頁時把 asOf 帶回來
GET /orders?status=PENDING_PAYMENT&page=1&size=20&asOf=2026-08-19T06:12:44Z
```

```sql
-- 加一個條件，把 asOf 之後建立的資料排除
WHERE status = 'PENDING_PAYMENT'
  AND created_at <= '2026-08-19 06:12:44'      -- ← asOf
ORDER BY created_at DESC, id DESC
LIMIT 20 OFFSET 20;
```

**效果**：新增的資料不會插進來 → 不會重複。
**限制**：如果某筆訂單在翻頁期間被取消（離開 `status=PENDING_PAYMENT`），還是會漏。

**shop-service 的決定**：

| 端點 | 分頁方式 |
|---|---|
| `GET /orders`（顧客看自己的，通常 < 100 筆） | offset（`page/size`） |
| `GET /orders`（客服／管理後台，可能百萬筆） | offset **+ `asOf`** + 深分頁上限 10,000 |
| `GET /orders?cursor=`（同步、批次、App 無限滾動） | **cursor**（同一支端點，兩種模式，5.5.3） |
| 財務報表、完整匯出 | `POST /order-exports`（第 02 章 2.10） |

### 5.3.7 什麼時候 offset 仍然是正確答案

不要因為讀了 5.3.4 和 5.3.6 就覺得 offset 分頁是錯的。它在四種情況下是**最佳選擇**：

| 情況 | 為什麼 offset 更好 |
|---|---|
| **需要跳頁**（管理後台的「第 5 頁」「最後一頁」） | cursor **做不到**跳頁 |
| **需要顯示總頁數** | cursor 通常不給 total |
| 資料量小（< 幾萬筆，且有篩選收斂） | 深分頁根本不會發生 |
| 需要「隨機存取」某一頁（分享連結、書籤） | `?page=3` 可以貼給別人，cursor 通常會過期 |

**判準：使用者是「用眼睛瀏覽」還是「用程式遍歷」？**

```
用眼睛瀏覽 → offset（人不會翻到第 5000 頁）
用程式遍歷 → cursor（程式一定會走到最後一筆）
```

---

## 5.4 cursor（keyset）分頁

### 5.4.1 原理：記住「值」而不是「位置」

```
offset 分頁：「跳過前 400,000 筆，給我接下來 20 筆」   ← 位置
cursor 分頁：「給我 created_at 早於 X 的前 20 筆」      ← 值
```

```sql
-- 第一頁（沒有 cursor）
SELECT id, order_number, created_at
FROM orders
WHERE customer_id = ?
ORDER BY created_at DESC, id DESC
LIMIT 21;                                  -- ★ 多取 1 筆判斷 hasMore

-- 第二頁（cursor = 上一頁最後一筆的 (created_at, id)）
SELECT id, order_number, created_at
FROM orders
WHERE customer_id = ?
  AND (created_at, id) < ('2026-08-19 06:12:44', 48213)     -- ★ 關鍵
ORDER BY created_at DESC, id DESC
LIMIT 21;
```

**效能**：`WHERE (created_at, id) < (?, ?)` 可以直接用索引**定位**到起點，
不需要掃描前面的資料。

| `page` 等價位置 | offset 掃描列數 | cursor 掃描列數 |
|---|---|---|
| 第 1 頁 | 20 | 20 |
| 第 1,000 頁 | 20,020 | **20** |
| 第 50,000 頁 | 1,000,020 | **20** |

**cursor 分頁是 O(1)，和深度無關。** 這是它存在的唯一理由，也是壓倒性的理由。

**用 `EXPLAIN` 驗證**：

```sql
EXPLAIN ANALYZE
SELECT id, order_number FROM orders
WHERE (created_at, id) < ('2026-08-19 06:12:44', 48213)
ORDER BY created_at DESC, id DESC
LIMIT 21;
```

```
-> Limit: 21 row(s)  (actual time=0.08..0.31 rows=21 loops=1)
    -> Index range scan on orders using idx_orders_created_id
       over (created_at, id) < ('2026-08-19 06:12:44', 48213)
       (actual time=0.07..0.28 rows=21 loops=1)
                                  ↑↑↑↑↑↑
                    只掃了 21 筆 —— 不管在第幾「頁」都一樣
```

> ⚠️ **MySQL 版本注意**：row constructor 的範圍最佳化（把 `(a,b) < (?,?)` 轉成 index range scan）
> 在 MySQL 8.0 上運作良好。如果你的版本沒有做這個最佳化（`EXPLAIN` 顯示 `Using where` 但掃描列數很大），
> 就手動展開成 OR 形式：
>
> ```sql
> WHERE (created_at < ?
>        OR (created_at = ? AND id < ?))
> ```
>
> 兩者邏輯等價，但展開形式在某些版本／某些索引下才會走 range scan。
> **上線前一定要用 `EXPLAIN ANALYZE` 確認實際掃描列數。**

### 5.4.2 為什麼必須用複合鍵 ★ 這裡有真實 bug

**只用單一欄位的 cursor 會漏資料。**

```sql
-- ❌ 只用 created_at
WHERE created_at < '2026-08-19 06:12:44'
ORDER BY created_at DESC
LIMIT 20;
```

**問題情境**：批次匯入 50 筆訂單，它們的 `created_at` **完全相同**。

```
資料（created_at 相同的 50 筆，用 id 區分）：
  06:12:44 / id=100
  06:12:44 / id=99
  ...
  06:12:44 / id=51        ← 第 1 頁的最後一筆（size=50 剛好切在這）
  06:12:44 / id=50
  ...
  06:12:44 / id=1

第 1 頁：LIMIT 50 → 拿到 id=100 ~ 51
        最後一筆的 created_at = '06:12:44'
第 2 頁：WHERE created_at < '06:12:44'
        → 🔴 id=50 ~ 1 這 50 筆全部被跳過！
        → 因為它們的 created_at 「不小於」06:12:44
```

**50 筆訂單永遠不會出現在遍歷結果裡。** 而且：

- 不會有錯誤訊息。
- 不會變慢。
- 只在「排序值有重複且剛好切在頁邊界」時發生 → **極難重現**。
- 批次匯入、資料遷移、秒殺活動（同一秒大量下單）都會製造大量重複的 `created_at`。

**反過來，如果用 `<=` 呢？**

```sql
WHERE created_at <= '2026-08-19 06:12:44'    -- 改成 <=
```

→ 第 2 頁會**重複回傳** id=100 ~ 51（因為它們也滿足 `<=`）→ 無限迴圈。

**唯一正確的做法：cursor 必須包含一個「唯一的 tie-breaker」。**

```sql
-- ✅ (created_at, id) 的組合是唯一的
WHERE (created_at, id) < ('2026-08-19 06:12:44', 51)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

**tie-breaker 的選擇規則**：

| 排序欄位 | 需要 tie-breaker？ | 用什麼 |
|---|---|---|
| `created_at` | ✅ 必須（時間會重複） | 主鍵 `id` |
| `total_amount` | ✅ 必須（金額大量重複） | 主鍵 `id` |
| `status` | ✅ 必須（只有 7 種值，大量重複） | `created_at` + `id` |
| `id`（主鍵） | ❌ 不需要（本身唯一） | — |
| `order_number`（唯一索引） | ❌ 不需要 | — |

**鐵律：cursor 的排序鍵組合必須是全域唯一的（唯一索引或包含主鍵）。**

**排序方向也必須一致**：

```sql
-- ✅ 兩個欄位同方向
ORDER BY created_at DESC, id DESC
WHERE (created_at, id) < (?, ?)

-- ⚠️ 混合方向 —— row constructor 比較不能直接用
ORDER BY created_at DESC, id ASC
-- 必須展開，而且複合索引也要是 (created_at DESC, id ASC)
WHERE created_at < ?
   OR (created_at = ? AND id > ?)
```

**混合方向會讓索引設計變複雜**（需要 MySQL 8.0 的降序索引），
所以**shop-service 規定 tie-breaker 的方向必須跟隨主排序欄位**。

### 5.4.3 cursor 的編碼設計

**cursor 對客戶端必須是「不透明字串」（opaque token）。**

```jsonc
// ❌ 明文暴露內部結構
{ "nextCursor": "created_at=2026-08-19T06:12:44Z&id=48213" }

// ❌ 直接給主鍵（洩漏自增 ID，第 01 章 1.4.1）
{ "nextCursor": "48213" }

// ✅ 不透明
{ "nextCursor": "eyJrIjpbIjIwMjYtMDgtMTlUMDY6MTI6NDRaIiwiNDgyMTMiXSwicyI6ImNyZWF0ZWRBdDpkZXNjIiwiZiI6ImE5ZjNjMSJ9" }
```

**cursor 裡面該放什麼**：

```jsonc
// base64url 編碼前的內容
{
  "k": ["2026-08-19T06:12:44.000Z", "48213"],   // keys：排序鍵的值（依排序順序）
  "s": "createdAt:desc,id:desc",                 // sort：排序規格
  "f": "a9f3c1e8",                               // filterHash：篩選條件的指紋
  "d": "next",                                   // direction：next / prev
  "v": 1                                         // version：cursor 格式版本
}
```

**五個欄位各解決一個問題**：

| 欄位 | 解決什麼問題 |
|---|---|
| `k`（keys） | 分頁的核心：從哪裡繼續 |
| `s`（sort） | 🔴 **客戶端換了排序但沿用舊 cursor** → 結果完全錯亂。有這個欄位就能偵測並回 `400` |
| `f`（filterHash） | 🔴 **客戶端換了篩選條件但沿用舊 cursor** → 同上 |
| `d`（direction） | 支援雙向分頁（`before`/`after`） |
| `v`（version） | 未來要改 cursor 格式時，能識別舊格式並優雅處理 |

**沒有 `s` 和 `f` 會發生什麼**（真實 bug）：

```http
# 第 1 頁：按時間排序
GET /orders?sort=createdAt,desc&limit=20
→ { "items": [...], "nextCursor": "eyJrIjpbIjIwMjYtMDgtMTkuLi4=" }

# 使用者點了「按金額排序」，但前端沿用了 nextCursor
GET /orders?sort=totalAmount,desc&cursor=eyJrIjpbIjIwMjYtMDgtMTkuLi4=
→ SQL: WHERE (total_amount, id) < ('2026-08-19 06:12:44', 48213)
                                    ↑ 把時間字串當金額比較
→ 🔴 MySQL 會把 '2026-08-19...' 隱式轉成數字 2026 → 回傳所有金額 < 2026 的訂單
→ 結果看起來「有資料」，但完全不是使用者要的
```

**加上 `s` 和 `f` 之後**：

```jsonc
{
  "type": "https://api.shop.example/problems/cursor-query-mismatch",
  "title": "分頁游標與查詢條件不符",
  "status": 400,
  "detail": "The cursor was created with sort=createdAt:desc but the request specifies sort=totalAmount:desc.",
  "code": "CURSOR_QUERY_MISMATCH",
  "userMessage": "查詢條件已變更，請重新查詢。",
  "hint": "變更 sort 或篩選條件時，請不要沿用先前的 cursor（從第一頁重新開始）。",
  "traceId": "..."
}
```

**Java 實作草稿**：

```java
public record Cursor(
    List<String> keys,          // k
    String sortSpec,            // s
    String filterHash,          // f
    Direction direction,        // d
    int version                 // v
) {
    private static final int CURRENT_VERSION = 1;
    private static final ObjectMapper MAPPER = /* 注入容器的 */;

    public String encode() {
        try {
            byte[] json = MAPPER.writeValueAsBytes(Map.of(
                    "k", keys, "s", sortSpec, "f", filterHash,
                    "d", direction.code(), "v", CURRENT_VERSION));
            return Base64.getUrlEncoder().withoutPadding().encodeToString(json);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("cursor 編碼失敗", e);
        }
    }

    public static Cursor decode(String raw, String expectedSort, String expectedFilterHash) {
        // ★ 嚴格驗證：長度、字元集、格式、版本、一致性
        if (raw.length() > 512) throw new InvalidCursorException("cursor 過長");
        if (!raw.matches("[A-Za-z0-9_-]+")) throw new InvalidCursorException("cursor 格式錯誤");

        Map<String, Object> m;
        try {
            byte[] json = Base64.getUrlDecoder().decode(raw);
            m = MAPPER.readValue(json, new TypeReference<>() {});
        } catch (Exception e) {
            throw new InvalidCursorException("cursor 無法解析");
        }

        int v = ((Number) m.getOrDefault("v", 0)).intValue();
        if (v != CURRENT_VERSION) throw new InvalidCursorException("cursor 版本不支援");

        String sortSpec = (String) m.get("s");
        String filterHash = (String) m.get("f");
        if (!expectedSort.equals(sortSpec) || !expectedFilterHash.equals(filterHash)) {
            throw new CursorQueryMismatchException(sortSpec, expectedSort);   // → 400
        }

        @SuppressWarnings("unchecked")
        List<String> keys = (List<String>) m.get("k");
        if (keys == null || keys.size() > 4) throw new InvalidCursorException("cursor 鍵數異常");

        return new Cursor(keys, sortSpec, filterHash,
                          Direction.of((String) m.get("d")), v);
    }
}
```

**⚠️ 三個安全要點**：

| 要點 | 為什麼 |
|---|---|
| **嚴格驗證長度與字元集** | cursor 的內容會進 SQL 的參數。雖然用 PreparedStatement 綁定就安全，但**長度不限會讓人送 10 MB 的字串** |
| **`keys` 的數量與型別要檢查** | 攻擊者可以送 100 個 key → 你的 SQL 組出 100 個條件 → 效能問題 |
| **不要把敏感資訊放進 cursor** | base64 **不是加密**，任何人 30 秒就能解出來。不要放 `customerId`、內部 ID、密鑰 |

**要不要簽章（HMAC）？**

| | 不簽章 | 簽章 |
|---|---|---|
| 防篡改 | ❌ | ✅ |
| 實際風險 | ⚠️ 客戶端可以偽造 cursor 「跳到任意位置」 | — |
| 這個風險嚴重嗎 | **通常不嚴重** —— 篩選條件（含權限）仍然套用，他跳到的位置也只能看到自己有權看的資料 | — |
| 成本 | — | 每次分頁多一次 HMAC 計算；金鑰輪替要處理 |

**shop-service 的決定：不簽章。**
理由：cursor 只是「從哪裡繼續」，它**不繞過任何權限檢查**（權限在 `WHERE customer_id = ?`，
而 `customer_id` 來自 token，不來自 cursor）。

**但如果你的 cursor 裡有任何影響權限或範圍的欄位，就必須簽章。**
更好的做法是：**不要把那種欄位放進 cursor。**

### 5.4.4 API 契約

```http
GET /orders?limit=20&sort=createdAt,desc
```

```jsonc
{
  "items": [ /* 20 筆 */ ],
  "page": {
    "limit": 20,
    "hasMore": true,
    "nextCursor": "eyJrIjpbIjIwMjYtMDgtMTlUMDY6MTI6NDRaIiwiNDgyMTMiXS4uLg",
    "prevCursor": null
  }
}
```

```http
GET /orders?limit=20&sort=createdAt,desc&cursor=eyJrIjpbIjIwMjYtMDgtMTlUMDY6MTI6NDRaIiwiNDgyMTMiXS4uLg
```

```jsonc
{
  "items": [ /* 20 筆 */ ],
  "page": {
    "limit": 20,
    "hasMore": true,
    "nextCursor": "eyJrIjpbIjIwMjYtMDgtMThUMjM6MDE6MTJaIiwiNDgxOTMiXS4uLg",
    "prevCursor": "eyJrIjpbIjIwMjYtMDgtMTlUMDY6MTI6NDRaIiwiNDgyMTMiXSwiZCI6InByZXYi..."
  }
}
```

**最後一頁**：

```jsonc
{
  "items": [ /* 7 筆 */ ],
  "page": {
    "limit": 20,
    "hasMore": false,
    "nextCursor": null,
    "prevCursor": "eyJ..."
  }
}
```

**六條契約規則**：

| 規則 | 說明 |
|---|---|
| `hasMore` 必須有 | 客戶端**不能**用 `items.length < limit` 判斷結束（5.2.4 的災難） |
| `nextCursor` 在沒有下一頁時是 `null`（或省略） | 讓客戶端 `while (cursor)` 就能遍歷 |
| **不提供 `totalElements`** | 見 5.6；如果真的需要，用獨立的 `?include=totalCount` |
| **不提供 `page` / `totalPages`** | cursor 分頁沒有「頁碼」的概念 |
| cursor 是**不透明**的 | 文件要明確寫「請勿解析或建構 cursor」 |
| `limit` 也要有上限 | 和 offset 的 `size` 同樣的上限（100） |

**`hasMore` 的實作：多取一筆**

```java
public CursorPage<OrderSummary> list(OrderQuery q, Cursor cursor, int limit) {
    // ★ 取 limit + 1 筆
    List<Order> rows = repository.findByCursor(q, cursor, limit + 1);

    boolean hasMore = rows.size() > limit;
    if (hasMore) {
        rows = rows.subList(0, limit);        // 丟掉多取的那一筆
    }

    String nextCursor = hasMore && !rows.isEmpty()
            ? buildCursor(rows.get(rows.size() - 1), q, Direction.NEXT)
            : null;

    return new CursorPage<>(mapper.toSummaries(rows), limit, hasMore, nextCursor, ...);
}
```

**為什麼用「多取一筆」而不是「再查一次 COUNT」**：
多取一筆的成本是 1 列的 I/O，`COUNT(*)` 的成本可能是幾百萬列（5.6）。

### 5.4.5 雙向分頁

```http
GET /orders?limit=20&after=<cursor>      往後（較舊的資料）
GET /orders?limit=20&before=<cursor>     往前（較新的資料）
```

**Stripe 的做法**（`starting_after` / `ending_before`）值得參考：

```http
GET /v1/charges?limit=20&starting_after=ch_3MtwBw
GET /v1/charges?limit=20&ending_before=ch_3MtwBw
```

**`before` 的 SQL**：方向反轉，然後**結果要再反轉一次**。

```sql
-- before：找比 cursor 更新的 20 筆
SELECT * FROM orders
WHERE customer_id = ?
  AND (created_at, id) > ('2026-08-19 06:12:44', 48213)    -- ← 方向相反
ORDER BY created_at ASC, id ASC                             -- ← 排序也相反
LIMIT 21;

-- ⚠️ 拿到的順序是「由舊到新」，回傳給客戶端前必須 reverse()
--    否則客戶端會看到順序顛倒的資料
```

```java
if (cursor.direction() == Direction.PREV) {
    Collections.reverse(rows);      // ★ 很容易漏掉這一步
}
```

**這個 `reverse()` 是雙向 cursor 分頁最常見的 bug。**
症狀：往前翻頁時資料順序反了，而且「往前再往後」會回到不同的位置。

**shop-service 的決定**：

| 場景 | 支援方向 |
|---|---|
| App 的無限滾動 | 只需要 `after`（往下滑） |
| 即時列表（新訂單會插到最前面） | 需要 `before`（往上拉刷新） |
| 批次同步 | 只需要 `after` |

**先只做 `after`（單向）**，等真的有 `before` 的需求再加 —— 
雙向的複雜度（reverse、prevCursor 的維護、邊界情況）不是免費的。

### 5.4.6 cursor 分頁的四個限制（要誠實）

| 限制 | 說明 | 能不能繞過 |
|---|---|---|
| **不能跳頁** | 沒有「第 5 頁」的概念 | ❌ 這是數學上的限制，不可能 |
| **不能顯示總頁數** | 沒有 total 就沒有頁數 | ⚠️ 可以另外查 count（但那就付了 5.6 的代價） |
| **排序鍵必須唯一且可索引** | 5.4.2；而且不能排序「計算出來的欄位」 | ⚠️ 部分情況可以（見下） |
| **cursor 可能「過期」** | 如果 cursor 指向的那筆資料被刪除了呢？ | ✅ 可以（見下） |

**「排序鍵必須可索引」的實際影響**：

```
✅ 可以 cursor 分頁：createdAt、updatedAt、totalAmount、orderNumber、id
❌ 不能 cursor 分頁：
   - 相關度分數（搜尋，5.10.4）
   - 計算欄位（「距離現在幾天」、「毛利率」—— 除非有 generated column + 索引）
   - 隨機排序（`ORDER BY RAND()`）
   - 多表 join 後才能算出的排序值
```

**「cursor 指向的資料被刪除」怎麼辦**：

```
cursor = (created_at='2026-08-19 06:12:44', id=48213)
→ 訂單 48213 被刪除了（或不再符合篩選條件）
→ WHERE (created_at, id) < ('2026-08-19 06:12:44', 48213)
→ ✅ 這個查詢仍然完全正確！
```

**這是 cursor 分頁的一個優雅之處**：它比較的是**值**，不是「那一筆資料」。
即使那筆資料消失了，「比它小的資料」的定義還是清楚的。

（對照：offset 分頁在資料被刪除時會漂移 —— 5.3.6。）

**唯一會過期的情況**：你改了 cursor 的格式（所以要有 `v` 欄位），
或者你把排序欄位的值改了（例如 `updated_at` 排序時，某筆資料被更新了）。

> ⚠️ **用 `updated_at` 當 cursor 排序鍵要特別小心**：
> 資料被更新後，它的 `updated_at` 會變大 → **它會「跳」到還沒遍歷的位置**
> → 遍歷過程中可能**重複看到同一筆**。
> 這在「增量同步」場景反而是**想要的行為**（更新過的資料要重新同步），
> 但如果你要的是「精確遍歷一次」，就必須用**不會變的欄位**（`created_at` + `id`）。

---

## 5.5 兩種分頁的選擇

### 5.5.1 完整對照表

| 面向 | offset（`page`/`size`） | cursor（`cursor`/`limit`） |
|---|---|---|
| 深度效能 | 🔴 O(offset)，會逾時 | ✅ O(1) |
| 資料漂移 | 🔴 會重複／會漏 | ✅ 穩定 |
| 跳頁 | ✅ | ❌ 不可能 |
| 總頁數 | ✅（但要付 COUNT 代價） | ❌ |
| 總筆數 | ✅（同上） | ⚠️ 要額外查 |
| 可分享的連結 | ✅ `?page=3` | ⚠️ cursor 很長，且與查詢條件綁定 |
| 實作複雜度 | ★ 簡單 | 中（cursor 編碼、tie-breaker、方向） |
| 排序彈性 | ✅ 任意欄位（甚至計算欄位） | ⚠️ 必須唯一且可索引 |
| 索引要求 | 建議有 | **必須有**（複合索引，順序要對） |
| 適合 | 管理後台、資料量小、要跳頁 | App 滾動、批次同步、大資料量 |

### 5.5.2 決策流程

```
                這個集合端點的資料量可能超過 10 萬筆嗎？
                          │
              否 ─────────┴───────── 是
              │                       │
              ▼                       ▼
        ┌──────────┐      使用者需要「跳到第 N 頁」嗎？
        │  offset  │                  │
        │ （簡單） │        是 ────────┴──────── 否
        └──────────┘        │                    │
                            ▼                    ▼
              ┌──────────────────────┐    ┌──────────┐
              │ offset + 深分頁上限   │    │  cursor  │
              │ + 引導到搜尋／匯出    │    │          │
              └──────────────────────┘    └──────────┘
```

**額外的判準**：

| 訊號 | 選 |
|---|---|
| Consumer 是 App 的無限滾動 | cursor |
| Consumer 是廠商的每日同步批次 | cursor |
| Consumer 是管理後台的表格（有頁碼元件） | offset |
| 需要「最後一頁」按鈕 | offset |
| 資料是「持續有新增」的時間序列（訂單、日誌、訊息） | cursor |
| 資料是「相對靜態」的（商品分類、設定） | offset |

### 5.5.3 同一支端點支援兩種模式

**這是最實用的做法**：同一個 URL，靠參數決定模式。

```http
# 模式 A：offset（管理後台）
GET /orders?page=0&size=20&sort=createdAt,desc

# 模式 B：cursor（App / 批次）
GET /orders?cursor=&limit=20&sort=createdAt,desc
GET /orders?cursor=eyJ...&limit=20&sort=createdAt,desc
```

**規則**：

| 規則 | 說明 |
|---|---|
| `page` 與 `cursor` **互斥** | 同時出現 → `400`（不要猜使用者想要哪一種） |
| 都不給 → 預設 offset 第一頁 | 向下相容（既有客戶端不用改） |
| `size` 與 `limit` 是別名 | 兩個都接受，但同時給不同值 → `400` |
| 回應的 `page` 物件**結構不同** | offset 模式有 `number`/`totalElements`；cursor 模式有 `hasMore`/`nextCursor` |
| 深分頁上限只對 offset 模式生效 | cursor 模式沒有這個限制 |

**回應結構不同要在 OpenAPI 用 `oneOf` 描述**：

```yaml
components:
  schemas:
    OrderListResponse:
      type: object
      required: [items, page]
      properties:
        items:
          type: array
          items: { $ref: '#/components/schemas/OrderSummary' }
        page:
          oneOf:
            - $ref: '#/components/schemas/OffsetPageInfo'
            - $ref: '#/components/schemas/CursorPageInfo'
          discriminator:
            propertyName: mode          # ★ 加一個 mode 欄位讓客戶端好判斷
            mapping:
              OFFSET: '#/components/schemas/OffsetPageInfo'
              CURSOR: '#/components/schemas/CursorPageInfo'

    OffsetPageInfo:
      type: object
      required: [mode, number, size, totalElements, totalPages]
      properties:
        mode: { type: string, enum: [OFFSET] }
        number: { type: integer, minimum: 0 }
        size: { type: integer }
        totalElements: { type: integer, format: int64 }
        totalPages: { type: integer }

    CursorPageInfo:
      type: object
      required: [mode, limit, hasMore]
      properties:
        mode: { type: string, enum: [CURSOR] }
        limit: { type: integer }
        hasMore: { type: boolean }
        nextCursor: { type: string, nullable: true }
```

**`mode` 欄位是關鍵**（第 03 章 3.10.2 的同一個思路）：
讓客戶端用一個明確的 discriminator 判斷，而不是靠「有沒有 `nextCursor` 欄位」猜。

**互斥檢查的錯誤回應**：

```jsonc
{
  "type": "https://api.shop.example/problems/malformed-request",
  "title": "請求格式錯誤",
  "status": 400,
  "code": "MALFORMED_REQUEST",
  "detail": "Parameters 'page' and 'cursor' are mutually exclusive.",
  "userMessage": "查詢參數有誤，請聯絡技術支援。",
  "errors": [
    { "field": "cursor", "code": "INVALID_COMBINATION",
      "message": "不可與 page 同時使用",
      "constraint": { "conflictsWith": ["page"] } }
  ],
  "traceId": "..."
}
```

---

## 5.6 `totalElements` 的真實代價

### 5.6.1 為什麼 `COUNT(*)` 很貴

**很多人以為資料庫「知道」有幾筆。** InnoDB **不知道**。

| 儲存引擎 | `COUNT(*)` 的成本 |
|---|---|
| MyISAM（舊） | O(1) —— 表頭有精確的列數 |
| **InnoDB**（現代 MySQL 預設） | **O(n)** —— 必須掃描索引來數 |

**為什麼 InnoDB 不能快取列數**：因為 MVCC。
不同的交易在不同的時間點看到的列數**不一樣**（有未提交的插入、有其他交易剛刪除的），
所以「這張表有幾筆」這個問題沒有唯一答案 —— 必須在你的交易快照下實際數一遍。

**實際成本（量級示意）**：

```sql
-- 300 萬筆訂單的表
SELECT COUNT(*) FROM orders;
-- 約 400～1200 ms（掃描最小的那個二級索引）

SELECT COUNT(*) FROM orders WHERE status = 'PAID';
-- 有 idx_status 索引，PAID 佔 60% → 掃 180 萬筆索引項 → 約 600 ms

SELECT COUNT(*) FROM orders
WHERE created_at BETWEEN ? AND ? AND status = 'PAID' AND total_amount > 1000;
-- 🔴 複合條件，可能沒有完美的索引 → 掃 180 萬筆 + 回表過濾 → 3000 ms+
```

**最糟的情況：count 查詢比主查詢慢 10 倍。**

```
主查詢：  LIMIT 20  →  掃 20 筆索引 + 回表 20 次  →  8 ms
count： COUNT(*)   →  掃 1,800,000 筆索引        →  620 ms
                                                     ↑ 佔了總耗時的 98.7%
```

**這是真實案例的典型形狀**：管理後台的訂單列表「載入要 1 秒」，
profiling 後發現 98% 的時間花在「算出總共有 1,847,392 筆」——
而這個數字**使用者只是瞄一眼**。

### 5.6.2 常見的錯誤解法

**錯誤 1：`SQL_CALC_FOUND_ROWS`**

```sql
-- ❌ 已在 MySQL 8.0.17 標記為 deprecated
SELECT SQL_CALC_FOUND_ROWS * FROM orders WHERE ... LIMIT 20;
SELECT FOUND_ROWS();
```

MySQL 官方明確說明：**它通常比「分別執行兩個查詢」更慢**，
因為它會阻止某些 `LIMIT` 最佳化。已被 deprecated，不要用。

**錯誤 2：在 Java 端把全部撈出來再 `.size()`**

```java
// 🔴 這就是 5.2.1 的事故
List<Order> all = repository.findAll(spec);
int total = all.size();
List<Order> page = all.subList(offset, offset + size);
```

**錯誤 3：用 `information_schema.TABLES.TABLE_ROWS`**

```sql
SELECT TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_NAME = 'orders';
```

這是**統計資訊的估計值**，誤差可能 ±50%，而且**不能套用 WHERE 條件**。
只能用於「這張表大概多大」，不能當分頁的 total。

### 5.6.3 四種正確的折衷

**折衷 A：不給 total，只給 `hasMore`（★ 首選）**

```jsonc
{
  "items": [ /* 20 筆 */ ],
  "page": { "mode": "CURSOR", "limit": 20, "hasMore": true, "nextCursor": "..." }
}
```

**成本：0**（多取一筆，5.4.4）。

**業界都這樣做**：

| 服務 | 有 total 嗎 |
|---|---|
| **Stripe** | ❌ 只有 `has_more` |
| **Slack** | ❌ 只有 `response_metadata.next_cursor` |
| **Twitter/X API v2** | ⚠️ 只有 `meta.result_count`（**這一頁**的筆數，不是總數） |
| **GitHub**（列表 API） | ⚠️ `Link` header 有 `last` 頁（間接可算），但 Search API 上限 1000 |
| Elasticsearch | ⚠️ `hits.total.relation` = `"eq"` 或 **`"gte"`**（超過 `track_total_hits` 時只給下限） |

**前端真的需要 total 嗎？** 大部分時候不需要：

| UI 元件 | 需要 total？ |
|---|---|
| App 的無限滾動 | ❌ 只需要 `hasMore` |
| 「載入更多」按鈕 | ❌ 只需要 `hasMore` |
| 「上一頁／下一頁」按鈕 | ❌ 只需要 `hasMore` |
| 頁碼元件（1 2 3 … 77） | ✅ 需要 |
| 「共 1,523 筆」文字 | ✅ 需要（但可以是近似值） |
| 「跳到最後一頁」 | ✅ 需要 |

**折衷 B：上限計數（capped count）★ 很實用**

「你不需要知道是 1,847,392 筆，你只需要知道『很多』。」

```sql
-- 只數到 1001 就停
SELECT COUNT(*) FROM (
    SELECT 1 FROM orders
    WHERE status = 'PAID'
    LIMIT 1001                      -- ★ 關鍵
) t;
```

```jsonc
{
  "page": {
    "mode": "OFFSET",
    "number": 0,
    "size": 20,
    "totalElements": 1000,
    "totalElementsRelation": "GREATER_THAN_OR_EQUAL",   // ★ 明確標示這是下限
    "totalPages": 50,
    "totalPagesRelation": "GREATER_THAN_OR_EQUAL"
  }
}
```

前端顯示：**「共 1000+ 筆」**。

**成本**：最多掃 1001 筆 → **恆定成本**，不管表有多大。

**這是 Elasticsearch 的做法**（`track_total_hits: 10000`），也是 Google 搜尋的做法
（「約 12,400,000 項結果」是估計值，而且你翻不到那麼深）。

**`totalElementsRelation` 這個欄位很重要**：
沒有它，前端會把 `1000` 當成精確值顯示「共 1000 筆」——
使用者會困惑「為什麼一直翻都翻不完」。

**折衷 C：快取 count（適合篩選條件收斂的情況）**

```java
@Cacheable(value = "orderCount", key = "#q.cacheKey()",
           unless = "#result == null")
public long countCached(OrderQuery q) {
    return repository.count(q.toSpecification());
}
```

```yaml
spring:
  cache:
    caffeine:
      spec: maximumSize=1000,expireAfterWrite=60s
```

**適用條件**（三個都要滿足）：

| 條件 | 為什麼 |
|---|---|
| 篩選條件的組合數量有限 | 否則快取鍵爆炸（每個使用者的每個篩選都是一個 key） |
| 數字可以晚 60 秒 | 「共 1,523 筆」晚一分鐘沒人在意 |
| 使用者會反覆翻頁 | 第一頁付一次 count 成本，後面 76 頁都免費 |

**⚠️ 快取鍵一定要包含權限範圍**：

```java
// 🔴 漏了 customerId → A 使用者的 count 被 B 使用者拿到
key = "#q.status + ':' + #q.createdFrom"

// ✅
key = "#q.customerIdOrAll() + ':' + #q.status + ':' + #q.createdFrom"
```

這和第 00 章 0.4.2 約束 3 的「CDN 快取個資」是同一類錯誤 —— **快取鍵漏了身分**。

**折衷 D：把 count 變成獨立的、選加的端點／參數**

```http
# 預設不算 total（快）
GET /orders?status=PAID&page=0&size=20
→ { "items": [...], "page": { "mode": "OFFSET", "number": 0, "size": 20, "hasMore": true } }

# 客戶端明確要求才算（慢，但是它自己選的）
GET /orders?status=PAID&page=0&size=20&include=totalCount
→ { "items": [...], "page": { ..., "totalElements": 1847392, "totalPages": 92370 } }
```

**這個設計的價值**：**把成本的決定權交給客戶端，並且讓成本可見。**

- App 的滾動列表不帶 `include=totalCount` → 快。
- 管理後台的表格帶 → 慢，但那是它需要的。
- 而且你可以在監控上看「有多少比例的請求帶了 `totalCount`」，
  發現有人不必要地帶了就去溝通。

**shop-service 的最終決定**：

| 端點 | total 策略 |
|---|---|
| `GET /orders`（offset 模式，預設） | **上限計數**（cap = 10,000）+ `totalElementsRelation` |
| `GET /orders?include=totalCount`（offset 模式） | 精確 `COUNT(*)`，但**有查詢超時 3 秒**，超時回 `503` |
| `GET /orders?cursor=`（cursor 模式） | **不提供 total**，只有 `hasMore` |
| `GET /products`（資料量小，< 5 萬） | 精確 `COUNT(*)`（成本可接受） |

**「超時回 503」的錯誤回應**：

```jsonc
{
  "type": "https://api.shop.example/problems/count-query-timeout",
  "title": "計數查詢超時",
  "status": 503,
  "detail": "The count query exceeded the 3s budget. Narrow the filter or omit include=totalCount.",
  "code": "COUNT_QUERY_TIMEOUT",
  "userMessage": "資料量過大，無法計算總筆數。請縮小篩選範圍。",
  "retryable": false,
  "hint": "移除 include=totalCount 參數即可正常取得資料（會顯示為「10000+ 筆」）。",
  "traceId": "..."
}
```

⚠️ 注意這裡回 `503` 而不是 `500`（第 02 章 2.8.5）：這是**資源限制**，不是 bug。
但也要注意 —— 如果這個 `503` 頻繁發生，它會污染你的 5xx 錯誤率
（第 04 章 4.12.3），所以要在告警規則裡用 `exception` label 排除，
並用另一條較寬鬆的告警追蹤它的趨勢。

**另一個選項是回 `200` + `warnings`**：

```jsonc
{
  "items": [ /* 正常回傳 20 筆 */ ],
  "page": { "mode": "OFFSET", "number": 0, "size": 20, "hasMore": true },
  "warnings": [
    { "code": "TOTAL_COUNT_UNAVAILABLE",
      "message": "資料量過大，未計算總筆數。請縮小篩選範圍。" }
  ]
}
```

**這個做法更友善**（資料還是拿到了），但客戶端必須讀 `warnings`。
**shop-service 選這一種** —— 因為「拿不到 total」不該讓整個請求失敗。

---

## 5.7 `Link` header 還是 body？

### 5.7.1 `Link` header（RFC 8288）

GitHub 的做法：

```http
HTTP/1.1 200 OK
Link: <https://api.github.com/repos/spring-projects/spring-boot/issues?page=2>; rel="next",
      <https://api.github.com/repos/spring-projects/spring-boot/issues?page=34>; rel="last",
      <https://api.github.com/repos/spring-projects/spring-boot/issues?page=1>; rel="first",
      <https://api.github.com/repos/spring-projects/spring-boot/issues?page=1>; rel="prev"
Content-Type: application/json

[ /* 裸陣列 */ ]
```

**優點**：

| 優點 | 說明 |
|---|---|
| body 保持純淨 | 就是資源陣列，沒有包裝 |
| 標準化 | RFC 8288 定義的 `rel` 值 |
| 有 HATEOAS 精神 | 客戶端不用自己組 URL（第 00 章 0.4.2 子約束 4d） |
| 換頁邏輯在伺服器 | 客戶端只要跟連結走 |

**缺點**：

| 缺點 | 說明 |
|---|---|
| 🔴 **前端跨來源讀不到** | 必須設 `Access-Control-Expose-Headers: Link`（第 02 章 2.7.2），**這是最常見的坑** |
| 解析麻煩 | `Link` header 的格式要自己 parse（引號、逗號、分號、多個 rel） |
| header 有長度限制 | 5 個 URL × 每個 200 字元 = 1KB；某些代理的 header 上限是 8KB（通常夠，但要知道） |
| 放不下 metadata | `totalElements` 只能塞進另一個自訂 header（`X-Total-Count`），又要 expose 一次 |
| 工具支援差 | OpenAPI 描述 header 比描述 body schema 麻煩；產生的 client 通常不處理 |

### 5.7.2 body（本課程採用）

```jsonc
{
  "items": [ ... ],
  "page": {
    "mode": "OFFSET",
    "number": 0,
    "size": 20,
    "totalElements": 1523,
    "totalPages": 77,
    "hasMore": true
  }
}
```

**選 body 的四個理由**：

| 理由 | 說明 |
|---|---|
| 前端零障礙 | `res.page.hasMore`，不用碰 CORS、不用 parse header |
| OpenAPI 好描述 | 就是一個 schema，client 產生器會產出型別 |
| 可以放任意 metadata | `aggregates`、`warnings`、`asOf`（第 03 章 3.11.2） |
| 一致性 | 全站的集合回應長得一樣 |

### 5.7.3 兩者都給（最務實）

**這不是「選一個」的問題 —— 兩個都給幾乎沒有成本。**

```http
HTTP/1.1 200 OK
Content-Type: application/json
Link: </orders?status=PAID&page=1&size=20>; rel="next",
      </orders?status=PAID&page=76&size=20>; rel="last",
      </orders?status=PAID&page=0&size=20>; rel="first"
X-Total-Count: 1523
Access-Control-Expose-Headers: Link, X-Total-Count
```
```jsonc
{
  "items": [ ... ],
  "page": { "mode": "OFFSET", "number": 0, "size": 20, "totalElements": 1523, "totalPages": 77, "hasMore": true },
  "links": {
    "self":  "/orders?status=PAID&page=0&size=20",
    "next":  "/orders?status=PAID&page=1&size=20",
    "first": "/orders?status=PAID&page=0&size=20",
    "last":  "/orders?status=PAID&page=76&size=20"
  }
}
```

**誰用哪個**：

| Consumer | 用什麼 |
|---|---|
| 瀏覽器前端 | body 的 `page` / `links`（不受 CORS 影響） |
| 命令列工具、爬蟲、`curl` 腳本 | `Link` header（可以用 `curl -sI` 只看 header） |
| 標準化的 API client 函式庫 | `Link` header（很多都內建支援 RFC 8288） |
| 廠商的 ERP 對接 | body（比較好懂） |

**`links` 在 cursor 模式下的樣子**（把 cursor 藏在連結裡，客戶端不用組）：

```jsonc
{
  "items": [ ... ],
  "page": { "mode": "CURSOR", "limit": 20, "hasMore": true, "nextCursor": "eyJ..." },
  "links": {
    "self": "/orders?limit=20&sort=createdAt,desc",
    "next": "/orders?limit=20&sort=createdAt,desc&cursor=eyJ..."
  }
}
```

**這是 cursor 分頁最好的客戶端體驗**：

```typescript
// 客戶端完全不用知道 cursor 是什麼
let url = '/orders?limit=100&sort=createdAt,desc';
const all = [];
while (url) {
  const res = await get(url);
  all.push(...res.items);
  url = res.links.next ?? null;      // ★ 跟著連結走，不用組參數
}
```

**這就是 HATEOAS 真正有價值的地方**（第 00 章 0.4.2 子約束 4d）：
不是「所有欄位都要有連結」，而是**「換頁這種純機械的導航，讓伺服器來組」**。

**⚠️ `links` 的實作細節**：`next` 連結必須**保留原始的所有查詢參數**
（篩選、排序、`include`），否則客戶端跟著連結走會拿到不同的結果集。

```java
static String buildNextLink(HttpServletRequest req, String nextCursor) {
    UriComponentsBuilder b = ServletUriComponentsBuilder.fromRequest(req);
    return b.replaceQueryParam("cursor", nextCursor)
            .replaceQueryParam("page")            // ★ 移除互斥的參數
            .build().toUriString();
}
```

**shop-service 的決定**：body 的 `page` + `links` 為主，
同時附上 `Link` 與 `X-Total-Count` header 並加入 `Access-Control-Expose-Headers`。

---

## 5.8 篩選（filter）參數設計

### 5.8.1 五種篩選型別

| 型別 | 語法 | 例子 |
|---|---|---|
| **等於** | `?field=value` | `?status=PAID` |
| **多值（IN）** | `?field=a&field=b` | `?status=PAID&status=SHIPPED` |
| **範圍** | `?fieldFrom=&fieldTo=` | `?createdFrom=2026-08-01&createdTo=2026-08-31` |
| **存在／不存在** | `?field=null` 或專用參數 | `?assigneeId=null`（未指派的） |
| **模糊／搜尋** | `?q=` | `?q=耳機`（見 5.10） |

**shop-service 的命名規則**：

```
等於：      <欄位名>                    status, customerId, categoryId
多值：      <欄位名>（重複出現）         status=PAID&status=SHIPPED
範圍下界：  <欄位名>From                createdFrom, amountFrom
範圍上界：  <欄位名>To                  createdTo, amountTo
存在性：    has<欄位名>                 hasCoupon=true, hasShipment=false
布林：      is<欄位名> 或 <欄位名>       isPaid, isGift
搜尋：      q                          q=耳機
```

**❌ 不要用的命名**：

| ❌ | 為什麼 | ✅ |
|---|---|---|
| `?createdAtGte=` / `?createdAtLte=` | 對非工程師不友善 | `?createdFrom=` / `?createdTo=` |
| `?startDate=` / `?endDate=` | 「start/end」語意模糊（是訂單的開始日期嗎？） | `?createdFrom=` / `?createdTo=` |
| `?minAmount=` / `?maxAmount=` | ⚠️ 可以，但和 `From/To` 混用就不一致 | 全站選一組 |
| `?filter[status]=PAID` | JSON:API 風格，在 Java 端綁定麻煩 | `?status=PAID` |
| `?where=status:PAID` | 自訂 DSL，要自己 parse | `?status=PAID` |

### 5.8.2 範圍篩選：端點是開還是閉？★ 這裡有真實的「差一筆」bug

```http
GET /orders?createdFrom=2026-08-01&createdTo=2026-08-31
```

**問題**：`2026-08-31` 這一天的訂單算不算？

```sql
-- 解讀 A：閉區間（inclusive）
WHERE created_at >= '2026-08-01 00:00:00' AND created_at <= '2026-08-31 00:00:00'
--                                                          ↑ 🔴 只到 8/31 的 00:00
--                                                            8/31 一整天的訂單都被漏掉！

-- 解讀 B：日期展開成整天
WHERE created_at >= '2026-08-01 00:00:00' AND created_at < '2026-09-01 00:00:00'
--                                                          ↑ ✅ 包含 8/31 整天
```

**這是財務報表最常見的 bug**：「8 月營收」少了 8/31 一整天。
而且它**在月底才會被發現**，而且只差一天所以很難注意到。

**shop-service 的規則（要寫進文件與 OpenAPI）**：

| 參數 | 語意 | SQL |
|---|---|---|
| `createdFrom=2026-08-01`（純日期） | **包含**該日 00:00:00（營業時區） | `created_at >= '2026-07-31 16:00:00'`（UTC） |
| `createdTo=2026-08-31`（純日期） | **包含**該日整天（到 23:59:59.999） | `created_at < '2026-08-31 16:00:00'`（UTC，= 台北 9/1 00:00） |
| `createdFrom=2026-08-01T00:00:00Z`（時間點） | **包含**該時間點 | `created_at >= '2026-08-01 00:00:00'` |
| `createdTo=2026-08-31T23:59:59Z`（時間點） | **包含**該時間點 | `created_at <= '2026-08-31 23:59:59'` |

**兩個關鍵設計決定**：

1. **`To` 對「純日期」是「包含整天」，對「時間點」是「包含該點」。**
   這符合人類直覺（「到 8/31」就是包含 8/31），但**必須明確寫在文件裡**。

2. **純日期的時區是「營業時區」（`Asia/Taipei`），不是 UTC。**
   這是第 03 章 3.6.3 `businessDate` 的延伸：
   「8 月的訂單」對台灣的財務來說是**台北時間**的 8 月。

**Java 實作**：

```java
public record DateRangeFilter(String from, String to) {

    private static final ZoneId BUSINESS_ZONE = ZoneId.of("Asia/Taipei");

    /** 下界（含），轉成 UTC Instant */
    public Instant fromInstant() {
        if (from == null) return null;
        return parseAsLowerBound(from);
    }

    /** 上界（不含），轉成 UTC Instant —— 注意是 exclusive */
    public Instant toExclusive() {
        if (to == null) return null;
        return parseAsUpperBoundExclusive(to);
    }

    private static Instant parseAsLowerBound(String s) {
        if (s.length() == 10) {                                  // "2026-08-01"
            return LocalDate.parse(s).atStartOfDay(BUSINESS_ZONE).toInstant();
        }
        return Instant.parse(s);                                 // "2026-08-01T00:00:00Z"
    }

    private static Instant parseAsUpperBoundExclusive(String s) {
        if (s.length() == 10) {                                  // "2026-08-31"
            // ★ 關鍵：+1 天，然後用 < 比較（等價於「包含 8/31 整天」）
            return LocalDate.parse(s).plusDays(1)
                            .atStartOfDay(BUSINESS_ZONE).toInstant();
        }
        // 時間點：客戶端明確指定，用 <= 語意 → 這裡加 1 奈秒轉成 exclusive
        return Instant.parse(s).plusNanos(1);
    }
}
```

```sql
-- 產生的 SQL 一律是 [from, toExclusive)
WHERE created_at >= ? AND created_at < ?
```

**為什麼統一用 `[from, to)` 半開區間**：

| 好處 | 說明 |
|---|---|
| 連續區間不重疊 | `[8/1, 9/1)` 和 `[9/1, 10/1)` 剛好接上，不會有訂單被算兩次 |
| 不用處理「最後一奈秒」 | `<= 23:59:59.999999999` 這種寫法在不同精度的資料庫欄位上行為不同 |
| SQL 最佳化器友善 | 範圍掃描的邊界清楚 |

**驗證：`from > to` 要回 `422`**（第 04 章 4.6.3 情境 3）：

```jsonc
{
  "status": 422,
  "code": "VALIDATION_FAILED",
  "errors": [
    { "field": "createdTo", "code": "INVALID_COMBINATION",
      "message": "結束日期不可早於開始日期",
      "rejectedValue": "2026-08-01",
      "constraint": { "relatedField": "createdFrom", "relatedValue": "2026-08-31" } }
  ]
}
```

**另外要驗證「範圍不可過大」**（效能防護，5.11）：

```jsonc
{
  "status": 422,
  "code": "DATE_RANGE_TOO_LARGE",
  "title": "查詢區間過大",
  "detail": "The requested range spans 1095 days; the maximum is 366 days.",
  "userMessage": "查詢區間最多一年，請縮小範圍。",
  "maxDays": 366,
  "requestedDays": 1095,
  "hint": "若需跨年度的完整資料，請改用 POST /order-exports 匯出。"
}
```

**⚠️ 別忘了 `+` 的編碼問題**（第 01 章案例 7、第 03 章 3.6.2）：

```
❌ ?createdFrom=2026-08-01T00:00:00+08:00
   → 後端收到 "2026-08-01T00:00:00 08:00" → 解析失敗

✅ ?createdFrom=2026-08-01T00:00:00%2B08:00     （編碼）
✅ ?createdFrom=2026-07-31T16:00:00Z            （改用 UTC，★ 推薦）
✅ ?createdFrom=2026-08-01                      （純日期，最簡單）
```

**shop-service 的建議**：文件裡明確引導客戶端用**純日期**或**UTC `Z` 格式**，
並在錯誤訊息裡提示這個坑。

### 5.8.3 多值篩選：重複參數還是逗號分隔？

```http
# 風格 A：重複參數
GET /orders?status=PAID&status=SHIPPED&status=COMPLETED

# 風格 B：逗號分隔
GET /orders?status=PAID,SHIPPED,COMPLETED
```

| | A（重複） | B（逗號） |
|---|---|---|
| URL 長度 | 較長 | ★ 較短 |
| 值本身含逗號時 | ✅ 沒問題 | 🔴 **會爆**（例如 `?tag=A,B` 想找一個叫「A,B」的標籤） |
| HTML form 的天然行為 | ★ 是（多選 checkbox 就長這樣） | 需要前端組字串 |
| OpenAPI 描述 | `style: form, explode: true` | `style: form, explode: false` |
| Spring 綁定 | ✅ `List<String>` 自動 | ✅ `List<String>` 也自動（逗號會被拆） |

**⚠️ Spring 的一個陷阱**：`@RequestParam List<String> status` **兩種都會接受**。

```java
@GetMapping("/orders")
public PageResponse<OrderSummary> list(@RequestParam(required = false) List<String> status) {
    // ?status=PAID&status=SHIPPED   → ["PAID", "SHIPPED"]
    // ?status=PAID,SHIPPED          → ["PAID", "SHIPPED"]     ← 也會拆！
    // ?status=PAID%2CSHIPPED        → ["PAID", "SHIPPED"]     ← 🔴 連編碼後的逗號也拆
}
```

**最後一行是問題**：如果某個標籤的**值本身就含逗號**，
客戶端正確編碼成 `%2C` 之後，Spring **還是會把它拆開**。

**如果你的值可能含逗號**，就必須：

```java
// 用 String[] 而不是 List<String> —— String[] 不會做逗號拆分
@RequestParam(required = false) String[] tag

// 或明確關閉轉換（用 @RequestParam Map 自己處理）
```

**shop-service 的決定**：

| 情況 | 用 |
|---|---|
| 值是**列舉**（`status`、`paymentMethod`） | 兩種都接受（列舉值不可能含逗號） |
| 值是**使用者自訂字串**（`tag`、`label`） | **只接受重複參數**，並用 `String[]` 綁定 |
| 值是**ID**（`customerId`、`productId`） | 兩種都接受（ID 不含逗號） |

**多值篩選的數量上限**：

```jsonc
// GET /orders?customerId=<200 個 ID>
{
  "status": 422,
  "code": "TOO_MANY_FILTER_VALUES",
  "title": "篩選值數量過多",
  "detail": "Parameter 'customerId' accepts at most 50 values; 200 were provided.",
  "userMessage": "篩選條件過多，請減少選項。",
  "errors": [
    { "field": "customerId", "code": "MAX_SIZE",
      "message": "最多 50 個值", "constraint": { "max": 50, "actual": 200 } }
  ],
  "hint": "若需批次查詢大量 ID，請改用 POST /order-queries。"
}
```

**為什麼要限制**：`WHERE id IN (?, ?, ... 200 個)` 會讓
① SQL 變得很長（某些代理／log 有長度限制）
② MySQL 的 `IN` 列表過大時最佳化器可能放棄索引
③ URL 超長（第 01 章 1.12.1 做法 B）

### 5.8.4 布林參數的三態問題

```http
GET /orders?isGift=true       只要禮物訂單
GET /orders?isGift=false      只要非禮物訂單
GET /orders                   全部（不篩選）
```

**Java 端的正確型別**：

```java
// ❌ 用基本型別 boolean
@RequestParam(defaultValue = "false") boolean isGift
// → 不帶參數時是 false → 變成「只要非禮物訂單」🔴 完全不是使用者的意思

// ✅ 用包裝型別 Boolean（不帶 = null = 不篩選）
@RequestParam(required = false) Boolean isGift
```

**這是超級常見的 bug**：`boolean` 沒有「未指定」的狀態。
（這和第 02 章 2.5.4 的 `null` 三態是同一類問題。）

**篩選條件的組裝**：

```java
if (q.isGift() != null) {
    predicates.add(cb.equal(root.get("isGift"), q.isGift()));
}
// null 就完全不加這個條件
```

**⚠️ 布林篩選 + NULL 值欄位的陷阱**：

```sql
-- 資料庫的 is_gift 欄位可能是 NULL（舊資料沒有這個欄位）
WHERE is_gift = false
-- → 🔴 NULL 的那些筆「不會」被選中（SQL 的三值邏輯：NULL = false → UNKNOWN）
```

如果業務上「沒設定就是非禮物」，SQL 要寫成：

```sql
WHERE (is_gift = false OR is_gift IS NULL)
-- 或在資料庫層把 is_gift 設為 NOT NULL DEFAULT false（★ 更好，從根本解決）
```

**規則：布林欄位在資料庫層一律 `NOT NULL DEFAULT`。**
這讓 API 層不用處理三值邏輯。（07-mysql 會再談。）

### 5.8.5 篩選「不存在」的值

```http
GET /orders?assigneeId=null       找未指派客服的訂單
GET /orders?hasShipment=false     找還沒出貨的訂單
GET /orders?couponCode=            找沒用折扣碼的？（空字串很模糊）
```

**三種語法，選一種**：

| 語法 | 評價 |
|---|---|
| `?assigneeId=null`（字面字串 `"null"`） | ⚠️ 可用，但如果真的有一個 ID 就叫 `"null"` 就衝突了（實務上不會） |
| `?assigneeId=` （空值） | 🔴 **模糊**：是「找 null」還是「不篩選」？不同框架行為不同 |
| `?hasAssignee=false`（★ 推薦） | ✅ 語意最清楚，不會和值衝突 |

**shop-service 選 `has<欄位>` 形式**：

```http
GET /orders?hasAssignee=false      未指派
GET /orders?hasAssignee=true       已指派（任何人）
GET /orders?assigneeId=usr_123     指派給特定人
GET /orders                        不篩選
```

```sql
-- hasAssignee=false
WHERE assignee_id IS NULL
-- hasAssignee=true
WHERE assignee_id IS NOT NULL
-- assigneeId=usr_123
WHERE assignee_id = 'usr_123'
```

**互斥檢查**：`hasAssignee=false` 和 `assigneeId=usr_123` 同時出現 → `422`
（邏輯矛盾，不要猜使用者的意思）。

**⚠️ `IS NULL` 的索引問題**：MySQL 的 B+Tree 索引**可以**索引 NULL 值
（不像 Oracle），所以 `WHERE assignee_id IS NULL` 能走索引。
但如果 NULL 佔了 90% 的資料，最佳化器可能判斷「走索引不如全表掃描」——
這時要看 `EXPLAIN`，可能需要複合索引 `(assignee_id, created_at)`。

### 5.8.6 未知參數：靜默忽略是嚴重缺陷 ★

```http
GET /orders?stauts=PAID
              ↑ 打錯（status → stauts）
```

| 做法 | 結果 |
|---|---|
| **靜默忽略**（大部分框架的預設） | 回**全部**訂單，客戶端以為篩過了 🔴 |
| **回 `400`** | 客戶端立刻知道錯了 ✅ |

**為什麼「靜默忽略」是嚴重缺陷（真實案例）**：

```
客服的訂單管理頁面，「只看已付款」的篩選器
→ 前端因為改版，把 status 參數改名成 orderStatus，但後端沒同步改
→ 後端收到 ?orderStatus=PAID，不認識，忽略
→ 回傳「全部訂單」
→ 客服以為畫面上這 20 筆都是已付款的，開始逐筆處理「出貨」
→ 🔴 對未付款的訂單執行了出貨動作
```

**這比「404」危險得多**：`404` 會馬上被發現，「靜默回全部」不會。

**另一個真實案例（更常見）**：

```
廠商的 ERP 每天同步：GET /orders?updatedSince=2026-08-18T00:00:00Z
→ 我們的參數其實叫 updatedFrom
→ 後端忽略 updatedSince → 每天都回「全部 300 萬筆」的第一頁
→ 廠商以為「今天只有 20 筆更新」→ 資料同步了一年都是錯的
```

**shop-service 的決定：未知的查詢參數回 `400`。**

```jsonc
{
  "type": "https://api.shop.example/problems/unknown-query-parameter",
  "title": "未知的查詢參數",
  "status": 400,
  "detail": "Unknown query parameter(s): stauts. Did you mean 'status'?",
  "code": "UNKNOWN_QUERY_PARAMETER",
  "userMessage": "查詢參數有誤，請聯絡技術支援。",
  "errors": [
    { "field": "stauts", "code": "UNKNOWN_PARAMETER",
      "message": "未知的參數，是否要用 status？",
      "constraint": { "suggestion": "status",
                      "allowedParameters": ["status", "customerId", "createdFrom",
                                            "createdTo", "amountFrom", "amountTo",
                                            "hasCoupon", "hasShipment", "q",
                                            "page", "size", "cursor", "limit",
                                            "sort", "include", "asOf"] } }
  ],
  "traceId": "..."
}
```

**`suggestion` 欄位（用 Levenshtein 距離算最相近的合法參數名）非常實用** ——
它把「有錯」變成「這樣改」，省掉一次來回。

**實作（Interceptor 或 Filter 層）**：

```java
@Component
public class UnknownQueryParamInterceptor implements HandlerInterceptor {

    /** 每個端點的合法參數白名單（可以從 @RequestParam 反射產生，或手動維護） */
    private final QueryParamRegistry registry;

    @Override
    public boolean preHandle(HttpServletRequest req, HttpServletResponse res, Object handler) {
        if (!(handler instanceof HandlerMethod hm)) return true;

        Set<String> allowed = registry.allowedFor(hm);
        if (allowed.isEmpty()) return true;                 // 未註冊的端點不檢查

        List<FieldError> unknown = req.getParameterMap().keySet().stream()
                .filter(p -> !allowed.contains(p))
                .filter(p -> !GLOBAL_PARAMS.contains(p))    // _t 之類的 cache buster
                .map(p -> new FieldError(p, "UNKNOWN_PARAMETER",
                        suggest(p, allowed), Map.of("suggestion", closest(p, allowed),
                                                    "allowedParameters", allowed)))
                .toList();

        if (!unknown.isEmpty()) throw new UnknownQueryParameterException(unknown);
        return true;
    }
}
```

**⚠️ 三個實務注意點**：

| 注意點 | 說明 |
|---|---|
| **要有全域白名單** | `_`、`_t`、`t`、`v`（cache buster）、`utm_*`（行銷追蹤）不該被拒絕 |
| **導入時要漸進** | 突然開啟嚴格模式會讓既有客戶端全部壞掉。做法：先**記錄**（log + 指標）觀察兩週，看看有多少 consumer 在送未知參數、送的是什麼，通知他們後再開啟拒絕 |
| **要有緊急關閉開關** | 用設定檔控制（`api.strict-query-params=true`），出事能立刻關掉（02-spring-boot 第 03 章） |

**這個「先觀察再執行」的導入流程**適用於所有「從寬鬆變嚴格」的變更（第 06 章會再談）。

### 5.8.7 進階：要不要支援查詢 DSL

當篩選需求變複雜（「金額 > 1000 且（狀態=PAID 或 狀態=SHIPPED）且 客戶等級 in (GOLD, PLATINUM)」），
有人會想引入查詢語言：

| 方案 | 語法 | 評價 |
|---|---|---|
| **RSQL / FIQL** | `?filter=amount>1000;(status==PAID,status==SHIPPED)` | ⚠️ 表達力強，但要引入 parser（`rsql-parser`），且**安全風險高** |
| **OData** | `?$filter=amount gt 1000 and (status eq 'PAID')` | ⚠️ 規格龐大，Java 生態支援有限 |
| **JSON:API filter** | `?filter[status]=PAID&filter[amount][gt]=1000` | ⚠️ 語法一致但很囉唆 |
| **GraphQL** | 換一整套技術 | 見第 00 章 0.7 |
| **`POST /orders/searches`** | body 放結構化條件 | ★ 見下 |

**🔴 查詢 DSL 的三個真實風險**：

| 風險 | 說明 |
|---|---|
| **任意欄位存取** | 如果 parser 直接把欄位名映射到 Entity 屬性，客戶端可以查 `?filter=passwordHash==xxx` 或 `?filter=customer.idNumber=='A123456789'` → **當成 oracle 逐字元猜測個資** |
| **任意複雜度** | `?filter=(a==1,b==2);(c==3,d==4);...` 100 層嵌套 → 查詢計畫爆炸 → 資料庫掛掉 |
| **SQL injection** | 如果 parser 有漏洞或你自己組字串 → 直接淪陷 |

**第一個風險值得展開說**（這是真實的攻擊手法）：

```
攻擊者不需要「讀取」欄位，只需要「能篩選」它：
GET /customers?filter=idNumber=='A100000000'   → 0 筆
GET /customers?filter=idNumber=='A100000001'   → 0 筆
...
GET /customers?filter=idNumber=~'A12345*'      → 1 筆   ← 命中！
→ 逐字元縮小範圍，可以還原出完整的身分證號
```

**這叫「盲注（blind injection）」的變體 —— 回應的筆數本身就是資訊洩漏。**

**如果你一定要做，四個必要的防護**：

```java
// ① 欄位白名單（不是 Entity 屬性的反射！）
private static final Map<String, FilterableField> FILTERABLE = Map.of(
    "status",      FilterableField.of("status", EQ, IN),
    "amount",      FilterableField.of("totalAmount", EQ, GT, GTE, LT, LTE),
    "createdAt",   FilterableField.of("createdAt", GTE, LT),
    "customerId",  FilterableField.of("customer.id", EQ, IN)
    // idNumber、passwordHash、cost 等一律不在此表中 → 無法篩選
);

// ② 運算子白名單（每個欄位各自可用的運算子 —— 見上表的第二個參數）
//    例如 status 只允許 EQ / IN，不允許 LIKE（防止 5.8.7 的逐字元猜測）

// ③ 複雜度上限
if (ast.depth() > 3)      throw new FilterTooComplexException("巢狀深度上限 3");
if (ast.nodeCount() > 20) throw new FilterTooComplexException("條件數上限 20");

// ④ 一律用 PreparedStatement 參數綁定（Criteria API / QueryDSL 天然做到）
```

**shop-service 的決定：不做查詢 DSL。**

理由：
- 目前的具名參數（`?status=&amountFrom=&createdFrom=`）覆蓋了 95% 的需求。
- 剩下 5% 的複雜查詢用**專用端點**（`POST /orders/searches`，第 01 章 1.9.2 方案 A）。
- **省下的不只是實作成本，還有一整類資安風險。**

**這是一個「刻意不做」的決定**（第 03 章 3.8.3 的同一個思路）：
API 設計最常見的錯誤之一，就是把所有可能的彈性都做出來。

**如果未來真的需要**，`POST /orders/searches` 的樣子：

```http
POST /orders/searches
Content-Type: application/json

{
  "and": [
    { "field": "amount", "op": "GT", "value": "1000.00" },
    { "or": [
        { "field": "status", "op": "EQ", "value": "PAID" },
        { "field": "status", "op": "EQ", "value": "SHIPPED" }
    ]},
    { "field": "customerTier", "op": "IN", "value": ["GOLD", "PLATINUM"] }
  ],
  "sort": [{ "field": "createdAt", "direction": "DESC" }],
  "limit": 20
}
```

```http
→ 200 OK
Cache-Control: no-store          ← ★ 明確標示不可快取（第 00 章約束 3）
```

**它仍然要做上面四個防護。** 只是條件在 body 裡（可以有巢狀結構），
而且用 `POST` 所以不受 URL 長度限制。

⚠️ 代價：**失去 HTTP 快取、不能貼連結、不能用瀏覽器上一頁**（第 01 章案例 3）。
文件裡要明確標示。

---

## 5.9 排序（sort）設計

### 5.9.1 兩種語法

```http
# 風格 A：Spring Data 格式（欄位,方向）
GET /orders?sort=createdAt,desc
GET /orders?sort=status,asc&sort=createdAt,desc          （多重排序）

# 風格 B：JSON:API 格式（前綴 - 表示降序）
GET /orders?sort=-createdAt
GET /orders?sort=status,-createdAt                        （多重排序，逗號分隔）
```

| | A（Spring Data） | B（JSON:API） |
|---|---|---|
| 可讀性 | ★ 明確（`desc` 一看就懂） | 需要知道 `-` 的慣例 |
| 多重排序 | 重複參數，順序即優先序 | 逗號分隔 |
| Spring 綁定 | ★ 自動（`Pageable` 直接支援） | 要自己 parse |
| URL 長度 | 較長 | ★ 較短 |
| 歧義 | ⚠️ `?sort=createdAt,status` 是「兩個欄位」還是「欄位+方向」？ | 沒有歧義 |

**風格 A 的歧義要注意**：Spring Data 的解析規則是
「最後一段如果是 `asc`/`desc` 就當方向，否則整串都是欄位名」。
所以 `?sort=createdAt,status` 會被解讀成**兩個欄位**（`createdAt` 和 `status`）都用預設方向。
這通常是使用者想要的，但要知道規則。

**shop-service 選風格 A**，理由：和 Spring Data 的 `Pageable` 自動綁定一致，少一層轉換。

### 5.9.2 白名單：不只是效能問題，是資安問題 ★

```java
// 🔴 直接把使用者的字串塞進 ORDER BY
String sql = "SELECT * FROM orders ORDER BY " + sortField + " " + direction;
// ?sort=id;DROP TABLE orders;--
// → SQL injection
```

**「我用 JPA 所以安全」—— 不一定**：

```java
// ⚠️ Spring Data 的 Sort 會把字串當「屬性名」，找不到會拋 PropertyReferenceException
//    → 這是 500，不是 400（而且錯誤訊息會洩漏 Entity 結構）
Sort sort = Sort.by(Sort.Direction.DESC, userInput);

// 🔴 JpaSort.unsafe() 明確允許原生 SQL 片段
Sort sort = JpaSort.unsafe("(SELECT ...)");    // ← 這個真的會執行你給的 SQL 片段
```

**而且還有「非 injection 但同樣嚴重」的問題**：

| 問題 | 說明 |
|---|---|
| **排序未索引的欄位** | `ORDER BY internal_note` → filesort → 300 萬筆排序 → 記憶體／磁碟暫存 → 幾十秒 |
| **排序不該暴露的欄位** | `?sort=cost,desc` → **攻擊者可以用排序推出成本排名**（即使回應裡沒有 `cost` 欄位！） |
| **排序關聯欄位** | `?sort=customer.lifetimeValue,desc` → 觸發 join → N+1 或全表掃描 |

**「用排序推出隱藏欄位」值得展開**（這是很少人想到的攻擊面）：

```
回應的 DTO 裡沒有 cost 欄位（第 03 章 3.2 做對了）
但如果允許 ?sort=cost,desc：
  → 客戶端拿到「按成本從高到低」的商品列表
  → 雖然看不到具體數字，但知道了完整的成本排名
  → 對競爭對手來說，這幾乎和知道數字一樣有價值
```

**規則：可排序欄位的白名單，必須是「可回應欄位」的子集。**

**shop-service 的實作**：

```java
public enum OrderSortField {
    CREATED_AT("createdAt",   "created_at",   true),    // 有索引
    UPDATED_AT("updatedAt",   "updated_at",   true),
    TOTAL_AMOUNT("totalAmount","total_amount", true),
    ORDER_NUMBER("orderNumber","order_number", true),
    STATUS("status",          "status",       true);
    // internalNote、cost、margin、riskScore 一律不在此列
    // → 客戶端無法排序，也無法藉排序推測

    private final String apiName;      // API 參數用的名字（camelCase）
    private final String columnName;   // 資料庫欄位（給 native query 用）
    private final boolean indexed;     // 是否有索引（沒索引的不該開放）

    public static OrderSortField of(String apiName) {
        return Arrays.stream(values())
                .filter(f -> f.apiName.equals(apiName))
                .findFirst()
                .orElseThrow(() -> new InvalidSortFieldException(apiName, allowedNames()));
    }

    public static List<String> allowedNames() {
        return Arrays.stream(values()).map(f -> f.apiName).toList();
    }
}
```

**錯誤回應**：

```jsonc
{
  "type": "https://api.shop.example/problems/malformed-request",
  "title": "請求格式錯誤",
  "status": 400,
  "code": "MALFORMED_REQUEST",
  "errors": [
    {
      "field": "sort",
      "code": "INVALID_ENUM_VALUE",
      "message": "不支援此排序欄位",
      "rejectedValue": "cost",
      "constraint": {
        "allowedValues": ["createdAt", "updatedAt", "totalAmount", "orderNumber", "status"]
      }
    }
  ],
  "traceId": "..."
}
```

**⚠️ 注意錯誤訊息只列出「允許的欄位」，不解釋「為什麼 cost 不行」。**
說「cost 是內部欄位」等於確認了這個欄位的存在（第 04 章 4.7.3）。

### 5.9.3 穩定排序：一定要有 tie-breaker ★

**這和 5.4.2 是同一個問題，但它影響 offset 分頁**：

```sql
-- ❌ 沒有 tie-breaker
SELECT * FROM orders ORDER BY created_at DESC LIMIT 20 OFFSET 0;
SELECT * FROM orders ORDER BY created_at DESC LIMIT 20 OFFSET 20;
```

**如果有 50 筆訂單的 `created_at` 完全相同**（批次匯入、秒殺），
那麼「第 21～40 筆是哪 20 筆」**在 SQL 層面是未定義的**。

MySQL 不保證兩次查詢的順序一致 —— 它可能因為
buffer pool 狀態、並行度、最佳化器選了不同的索引，而給出不同的順序。

**結果**：

```
第 1 頁：O100, O99, O98, ..., O81    （created_at 都相同）
第 2 頁：O95, O87, O80, ...          ← 🔴 O95、O87 在第 1 頁出現過
                                       而且某些訂單永遠不會出現
```

**這個 bug 的特徵**：
- 只在「排序值有重複」時發生。
- 不會每次都發生（取決於資料庫的執行計畫）。
- 開發環境（資料少）幾乎不會遇到。
- **測試很難抓到**（因為它不是 deterministic 的）。

**修法：ORDER BY 的最後一個欄位必須是唯一的。**

```sql
-- ✅
ORDER BY created_at DESC, id DESC
```

**shop-service 的實作：自動附加 tie-breaker**

```java
public Sort toSort(List<String> sortParams) {
    List<Sort.Order> orders = new ArrayList<>();

    for (String p : sortParams) {
        String[] parts = p.split(",");
        OrderSortField field = OrderSortField.of(parts[0].trim());
        Sort.Direction dir = parts.length > 1 && "desc".equalsIgnoreCase(parts[1].trim())
                ? Sort.Direction.DESC : Sort.Direction.ASC;
        orders.add(new Sort.Order(dir, field.apiName()));
    }

    if (orders.isEmpty()) {
        orders.add(new Sort.Order(Sort.Direction.DESC, "createdAt"));   // 預設排序
    }

    // ★ 一律附加唯一的 tie-breaker（方向跟隨最後一個排序欄位，5.4.2）
    boolean hasUniqueKey = orders.stream()
            .anyMatch(o -> o.getProperty().equals("id") || o.getProperty().equals("orderNumber"));
    if (!hasUniqueKey) {
        orders.add(new Sort.Order(orders.get(orders.size() - 1).getDirection(), "id"));
    }

    return Sort.by(orders);
}
```

**這 6 行程式碼消滅了一整類極難除錯的 bug。**

**⚠️ 不要忘記「預設排序」也要有 tie-breaker**：
沒有 `?sort=` 參數時的預設排序，同樣會有這個問題。

### 5.9.4 排序與索引

**排序要走索引，必須滿足三個條件**：

```sql
CREATE INDEX idx_orders_customer_created ON orders (customer_id, created_at DESC, id DESC);

-- ✅ 能用索引排序（Using index condition，沒有 Using filesort）
SELECT * FROM orders
WHERE customer_id = 'cus_1'
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

| 條件 | 說明 |
|---|---|
| ① WHERE 的等值條件在索引最左側 | `customer_id = ?` 用掉索引第 1 欄 |
| ② ORDER BY 的欄位緊接在後，順序一致 | `created_at, id` 對應索引第 2、3 欄 |
| ③ **排序方向一致**（全 ASC 或全 DESC，或用降序索引） | MySQL 8.0 支援索引裡的 `DESC`；5.7 不支援（只能反向掃描全部同方向的） |

**違反的後果**：

```sql
-- ❌ ORDER BY 的欄位不在索引裡 → filesort
SELECT * FROM orders WHERE customer_id = ? ORDER BY total_amount DESC LIMIT 20;
```

```
EXPLAIN 會顯示：
  Extra: Using where; Using filesort       ← ★ 看到 filesort 就要警覺
```

**`Using filesort` 的實際成本**：
MySQL 必須把**所有符合 WHERE 的列**讀出來排序，才能取前 20 筆。

```
customer_id = 'cus_1' 有 50 筆   → filesort 50 筆    → 快（無感）
customer_id = 'cus_1' 有 50 萬筆 → filesort 50 萬筆  → 慢（幾秒）+ 可能用磁碟暫存
沒有 WHERE 條件（客服看全部）    → filesort 300 萬筆 → 🔴 逾時
```

⚠️ `Using filesort` **不一定**代表用磁碟（名字有誤導性）——
資料量小時是在記憶體排序（`sort_buffer_size` 內）。但資料量大時會溢出到磁碟暫存檔。

**每一個開放的排序欄位，都需要一個對應的索引。**

這是為什麼「可排序欄位」要收斂：

```
5 個可排序欄位 × 3 個常用篩選條件 = 最多 15 個複合索引
每個索引都要：佔磁碟空間、拖慢寫入、佔 buffer pool
```

**shop-service 的取捨**：

| 排序欄位 | 索引 | 說明 |
|---|---|---|
| `createdAt`（預設） | ✅ `(customer_id, created_at, id)`、`(status, created_at, id)` | 最常用，必須有 |
| `totalAmount` | ✅ `(status, total_amount, id)` | 客服「找大額訂單」 |
| `updatedAt` | ✅ `(updated_at, id)` | 廠商增量同步用 |
| `orderNumber` | ✅ 唯一索引本身 | — |
| `status` | ⚠️ 只允許**搭配其他條件**時排序 | 單獨 `ORDER BY status` 沒有意義（只有 7 種值） |

**「排序欄位需要搭配條件」的驗證**：

```jsonc
// GET /orders?sort=totalAmount,desc （沒有任何篩選條件）
{
  "status": 400,
  "code": "SORT_REQUIRES_FILTER",
  "title": "此排序需搭配篩選條件",
  "detail": "Sorting by 'totalAmount' requires at least one of: status, customerId, createdFrom.",
  "userMessage": "請先選擇篩選條件（狀態或日期範圍）再排序。",
  "requiredFilters": ["status", "customerId", "createdFrom"],
  "hint": "無篩選條件的全表排序會超時。"
}
```

**這種「參數之間有依賴」的驗證很少見，但在效能敏感的端點上很有價值** ——
它把「查詢會逾時」變成「立刻告訴你要加什麼條件」。

### 5.9.5 不能排序的三類欄位

| 類型 | 例子 | 為什麼 |
|---|---|---|
| **計算欄位** | `marginRate`（毛利率）、`daysSinceOrder` | 沒有索引可用 → filesort。除非做 generated column + 索引 |
| **敏感欄位** | `cost`、`riskScore`、`lifetimeValue` | 5.9.2 的資訊洩漏 |
| **關聯欄位** | `customer.displayName`、`items[0].productName` | 需要 join；`items` 是一對多，排序語意本身就不明確 |

**如果真的需要按關聯欄位排序**（例如管理後台要「按客戶名稱排序」）：

| 方案 | 說明 |
|---|---|
| **A. 反正規化（denormalize）** | 在 `orders` 表加一個 `customer_display_name` 快照欄位 + 索引 ★ 推薦 |
| **B. 限制範圍後 join** | 先用其他條件把結果集縮到幾百筆，再 join 排序（要有 `SORT_REQUIRES_FILTER` 檢查） |
| **C. 搜尋引擎** | 把資料同步到 Elasticsearch，在那裡排序（5.10.3） |

**方案 A 值得展開**：訂單本來就該快照客戶名稱（第 01 章 1.2.2 的「快照 vs 參照」）——
所以這個欄位**應該存在**，順便加個索引就能排序了。
**「排序需求」常常是在提醒你「這個欄位該反正規化」。**

---

## 5.10 搜尋端點

### 5.10.1 搜尋 vs 篩選：本質不同

| | 篩選（filter） | 搜尋（search） |
|---|---|---|
| 語意 | **精確**：欄位等於／大於某值 | **模糊**：相關就好 |
| 結果 | 布林（符合／不符合） | **有相關度分數** |
| 排序 | 使用者指定 | **預設按相關度** |
| 使用者輸入 | 從選單挑（狀態、日期） | 自由打字 |
| 索引 | B+Tree | 倒排索引（inverted index） |
| 參數 | `?status=PAID` | `?q=無線耳機` |

**混淆兩者的後果**：

```
把搜尋當篩選做：?productName=無線耳機
→ WHERE product_name = '無線耳機'
→ 使用者打「無線 耳機」（多一個空白）→ 0 筆
→ 使用者打「藍牙耳機」→ 0 筆（但他其實想找耳機）
→ 使用者放棄
```

### 5.10.2 `LIKE '%x%'` 的問題

**最常見的實作**：

```sql
SELECT * FROM products WHERE name LIKE '%耳機%' LIMIT 20;
```

**三個問題**：

**問題 1：不能用索引（前綴通配符）**

```sql
-- ✅ 能用索引（前綴匹配）
WHERE name LIKE '耳機%'          → 索引範圍掃描

-- 🔴 不能用索引（前後都有通配符）
WHERE name LIKE '%耳機%'         → 全表掃描
```

```
EXPLAIN 顯示：
  type: ALL                       ← 全表掃描
  rows: 2847391                   ← 掃了 284 萬筆
  Extra: Using where
```

**問題 2：搜尋品質差**

| 使用者輸入 | `LIKE '%x%'` 的結果 |
|---|---|
| `無線耳機` | ✅ 找到「無線耳機 Pro」 |
| `耳機 無線` | ❌ 0 筆（順序不對） |
| `無線 耳機`（中間空白） | ❌ 0 筆 |
| `藍牙耳機` | ❌ 找不到「無線耳機」（沒有語意理解） |
| `耳机`（簡體） | ❌ 0 筆 |
| `Airpods` vs `AirPods` | ⚠️ 看 collation 的大小寫敏感度 |
| `無線耳機 Pro` | ❌ 0 筆（如果商品名是「無線降噪耳機 Pro」） |

**問題 3：沒有相關度排序**

`LIKE` 只有「符合／不符合」，所以你只能按 `createdAt` 排 —— 
使用者搜「耳機」，最相關的商品可能在第 5 頁。

**問題 4（安全）：`%` 和 `_` 要轉義**

```
使用者輸入：%
→ WHERE name LIKE '%%%'
→ 匹配所有商品 → 全表掃描 + 回傳全部

使用者輸入：_
→ WHERE name LIKE '%_%'
→ 匹配任何至少 1 字元的 → 同上
```

```java
// ★ 一定要轉義
static String escapeLike(String input) {
    return input.replace("\\", "\\\\")
                .replace("%", "\\%")
                .replace("_", "\\_");
}
// SQL: WHERE name LIKE CONCAT('%', ?, '%') ESCAPE '\\'
```

### 5.10.3 三個層次的搜尋方案

| 層次 | 方案 | 適合的資料量 | 成本 |
|---|---|---|---|
| **L1** | `LIKE 'x%'`（前綴，走索引） | 任意（有索引） | ★ 零額外成本 |
| **L2** | MySQL 全文索引（`MATCH ... AGAINST`） | < 幾百萬筆 | 低（一個索引） |
| **L3** | Elasticsearch / OpenSearch | 任意 | 高（一整套系統 + 同步機制） |

**L1：前綴搜尋（別小看它）**

```sql
CREATE INDEX idx_products_name ON products (name);

SELECT * FROM products WHERE name LIKE ? LIMIT 20;    -- 參數：'無線%'
```

**適合的場景比你想的多**：
- 自動完成（autocomplete）—— 使用者打「無線」就要出建議，本來就是前綴語意。
- 訂單編號搜尋（`ORD-20260819%`）。
- 使用者名稱／Email 搜尋。

**L2：MySQL 全文索引**

```sql
-- ⚠️ 中文必須用 ngram parser（預設的 parser 靠空白斷詞，對中文完全無效）
ALTER TABLE products
  ADD FULLTEXT INDEX ft_products_name_desc (name, description) WITH PARSER ngram;

-- 查詢
SELECT id, name,
       MATCH(name, description) AGAINST('無線耳機' IN NATURAL LANGUAGE MODE) AS score
FROM products
WHERE MATCH(name, description) AGAINST('無線耳機' IN NATURAL LANGUAGE MODE)
ORDER BY score DESC, id DESC
LIMIT 20;
```

**中文的關鍵設定**：

```ini
# my.cnf —— 這個參數只能在啟動時設，改了要重建全文索引
[mysqld]
ngram_token_size = 2        # 預設 2（二元分詞：「無線耳機」→ 無線/線耳/耳機）
```

**`ngram_token_size` 的取捨**：

| 值 | 效果 |
|---|---|
| 1 | 單字元切分 → 索引巨大、噪音多 |
| **2**（預設） | ★ 中文最常用；「耳機」這種二字詞能精確命中 |
| 3 | 索引較小，但無法搜尋兩字詞（搜「耳機」會找不到） |

**MySQL 全文索引的限制（要誠實）**：

| 限制 | 說明 |
|---|---|
| 沒有同義詞 | 搜「藍牙耳機」找不到「無線耳機」 |
| 沒有拼字糾正 | 打錯字就 0 筆 |
| 相關度演算法簡單 | 只有 TF-IDF 變體，不能自訂權重（「商品名比描述重要」做不到，除非分兩個索引） |
| 簡繁不通 | 「耳机」找不到「耳機」（要自己在寫入時做正規化） |
| `ngram` 對短查詢噪音大 | 搜「的」會命中大量商品 |
| 效能隨資料量下降 | 幾百萬筆以上就要考慮 L3 |

**L3：Elasticsearch**

```jsonc
// 索引設定（IK 分詞器，中文效果比 ngram 好很多）
{
  "settings": { "analysis": { "analyzer": { "default": { "type": "ik_max_word" } } } },
  "mappings": {
    "properties": {
      "name":        { "type": "text", "analyzer": "ik_max_word", "boost": 3 },
      "description": { "type": "text", "analyzer": "ik_max_word" },
      "categoryId":  { "type": "keyword" },
      "price":       { "type": "scaled_float", "scaling_factor": 100 },
      "status":      { "type": "keyword" }
    }
  }
}
```

**什麼時候值得引入 L3**（三個都成立才值得）：

| 條件 | 說明 |
|---|---|
| 搜尋是**核心功能** | 電商的商品搜尋 = 主要的商品發現途徑 → 值得。管理後台的訂單搜尋 → 不值得 |
| 需要同義詞／拼字糾正／權重／facet 聚合 | L2 做不到 |
| 有人維護它 | ES 需要：容量規劃、分片設計、同步機制、監控、版本升級 |

**⚠️ L3 的隱藏成本：資料同步**

```
MySQL（真相來源） → ? → Elasticsearch（搜尋用）
                     ↑
              這一段是整個方案最難的部分
```

| 同步方式 | 問題 |
|---|---|
| 應用程式雙寫 | 🔴 沒有交易保證：MySQL 成功但 ES 失敗 → 資料不一致 |
| 定時全量同步 | 延遲高（幾分鐘～幾小時） |
| CDC（Debezium 讀 binlog） | ★ 最可靠，但要多一套基礎設施（Kafka + Connect） |
| 領域事件 + 非同步 | ✅ 折衷（02-spring-boot 第 06 章的 `@TransactionalEventListener`）；要處理失敗重試與順序 |

**shop-service 的決定**：

| 端點 | 方案 |
|---|---|
| `GET /products?q=` | **L2**（MySQL `ngram` 全文索引）—— 商品數 < 50 萬，夠用 |
| `GET /products?namePrefix=`（自動完成） | **L1**（前綴索引）—— 延遲要求 < 50ms |
| `GET /orders?q=` | **L1**（只搜訂單編號、收件人姓名、電話的前綴）—— 客服的實際使用情境就是這樣 |
| 未來（商品數 > 100 萬或要做搜尋排名優化） | 升級到 **L3**，用領域事件同步 |

**`GET /orders?q=` 的設計值得說明**：

```
客服搜訂單時，實際會輸入什麼？
  ✅ 訂單編號：ORD-20260819-0001 或 20260819
  ✅ 收件人姓名：王小明
  ✅ 電話：0912345678 或 2345678（記得後幾碼）
  ✅ Email：wang@
  ❌ 幾乎不會搜「商品描述裡的關鍵字」
```

**所以 `q` 不需要全文搜尋，只需要「多欄位前綴／後綴匹配」**：

```sql
SELECT * FROM orders
WHERE customer_id = ? OR ? IS NULL                     -- 權限範圍
  AND (order_number LIKE CONCAT(?, '%')                -- 前綴，走索引
    OR recipient_name = ?                              -- 精確，走索引
    OR recipient_phone LIKE CONCAT('%', ?)             -- ⚠️ 後綴，不走索引
    OR customer_email LIKE CONCAT(?, '%'))             -- 前綴，走索引
ORDER BY created_at DESC, id DESC
LIMIT 21;
```

⚠️ 電話的「後幾碼」搜尋不走索引。**解法：加一個反轉欄位。**

```sql
-- generated column + 索引
ALTER TABLE orders
  ADD COLUMN recipient_phone_reversed VARCHAR(20)
    GENERATED ALWAYS AS (REVERSE(recipient_phone)) STORED,
  ADD INDEX idx_phone_rev (recipient_phone_reversed);

-- 「後 7 碼是 2345678」變成「前綴是 8765432」→ 走索引 ✅
WHERE recipient_phone_reversed LIKE CONCAT(REVERSE(?), '%')
```

**這是一個很實用的技巧**：把「後綴搜尋」轉成「前綴搜尋」。

**更好的做法（如果 `q` 的格式可以判斷）：先分派再查**

```java
public OrderSearchStrategy dispatch(String q) {
    if (q.matches("ORD-\\d{8}-\\d{4}"))  return exactOrderNumber(q);      // 完整編號 → 唯一索引
    if (q.matches("ORD-\\d{8}.*"))       return orderNumberPrefix(q);     // 編號前綴
    if (q.matches("09\\d{8}"))           return exactPhone(q);            // 完整手機
    if (q.matches("\\d{3,8}"))           return phoneSuffix(q);           // 電話後幾碼
    if (q.contains("@"))                 return emailPrefix(q);           // Email
    return recipientName(q);                                              // 其餘視為姓名
}
```

**好處**：每一種都走最適合的索引，而不是「一個 OR 查詢打天下」。
`OR` 條件很容易讓 MySQL 放棄索引（index merge 不一定會發生）。

### 5.10.4 搜尋的分頁問題 ★

**搜尋和 cursor 分頁天生衝突**：

```
cursor 分頁需要：排序鍵是「穩定且唯一」的欄位（5.4.2）
搜尋預設排序：  相關度分數（score）
                ↓
score 不穩定（索引更新、資料變動都會讓分數變）
score 不唯一（大量文件可能同分）
score 不是資料庫欄位（無法索引，無法用 WHERE 過濾）
```

**三種解法**：

| 解法 | 說明 |
|---|---|
| **A. 搜尋只用 offset 分頁 + 硬上限** | ★ 業界標準（GitHub Search 上限 1000、ES 預設 10000） |
| **B. 搜尋改按「穩定欄位」排序** | 使用者選「按時間排序」時可以用 cursor |
| **C. 用搜尋引擎的專用機制** | ES 的 `search_after` + PIT（point-in-time）；MySQL 沒有對應機制 |

**shop-service 的決定**：

```http
GET /products?q=耳機&page=0&size=20&sort=relevance
→ offset 分頁，硬上限 page × size <= 1000

GET /products?q=耳機&page=0&size=20&sort=createdAt,desc
→ 也是 offset（因為有 q 就不支援 cursor，避免混淆）

GET /products?categoryId=cat_1&cursor=&limit=20
→ 沒有 q → 可以 cursor
```

**規則：`q` 與 `cursor` 互斥。**

```jsonc
{
  "status": 400,
  "code": "MALFORMED_REQUEST",
  "detail": "Parameters 'q' and 'cursor' are mutually exclusive; search results support offset pagination only.",
  "userMessage": "搜尋結果不支援此分頁方式。",
  "errors": [
    { "field": "cursor", "code": "INVALID_COMBINATION",
      "message": "不可與 q 同時使用",
      "constraint": { "conflictsWith": ["q"] } }
  ],
  "hint": "搜尋請使用 page/size 分頁（最多前 1000 筆結果）。"
}
```

**搜尋結果的 total 更貴**：

```
一般篩選的 COUNT：掃索引
搜尋的 COUNT：    要算出「有多少文件相關」→ 幾乎等於執行完整搜尋
```

**所以搜尋結果的 total 一定要用上限計數**（5.6.3 折衷 B）：

```jsonc
{
  "items": [ /* 20 筆 */ ],
  "page": {
    "mode": "OFFSET",
    "number": 0,
    "size": 20,
    "totalElements": 1000,
    "totalElementsRelation": "GREATER_THAN_OR_EQUAL",
    "maxAccessibleElements": 1000          // ★ 明確告知「你最多只能翻到這裡」
  },
  "searchMeta": {
    "query": "耳機",
    "tookMs": 34,
    "corrected": null                       // 拼字糾正（L3 才有）
  }
}
```

**`maxAccessibleElements` 這個欄位很重要**：
它讓前端可以顯示「顯示前 1000 筆結果（共 1000+ 筆）」，
而不是讓使用者一直翻到第 51 頁才撞牆。

### 5.10.5 搜尋端點的形狀

```http
# 方案 A：列表端點加 q 參數（★ shop-service 採用）
GET /products?q=耳機&categoryId=cat_1&page=0&size=20

# 方案 B：專用搜尋端點
GET /products/search?q=耳機&categoryId=cat_1&page=0&size=20

# 方案 C：獨立的搜尋資源
GET /search?q=耳機&types=product,order
```

| | A | B | C |
|---|---|---|---|
| 端點數量 | ★ 1 個 | 2 個（要維護兩份篩選邏輯） | 1 個但跨資源 |
| 篩選能否組合 | ★ 可以（`q` + `categoryId` + `priceFrom`） | 可以但要複製參數定義 | 難（不同資源的篩選不同） |
| 快取策略 | 一致 | 可以分開設（搜尋 60s、列表 300s） | — |
| 適合 | ★ 大部分情況 | 搜尋的參數／回應差異很大時 | 全站搜尋（跨商品／訂單／說明文件） |

**shop-service 選 A**，理由：
- 使用者的實際行為是「先篩分類，再搜關鍵字」—— 兩者要能組合。
- 少一支端點 = 少一份文件、測試、權限設定（第 01 章案例 10）。

**但要注意「有 `q` 時行為會變」，並在文件寫清楚**：

| | 沒有 `q` | 有 `q` |
|---|---|---|
| 預設排序 | `createdAt,desc` | `relevance` |
| 支援 cursor | ✅ | ❌ |
| 深分頁上限 | 10,000 | **1,000** |
| total | 精確（商品數少） | 上限計數 |
| 快取 | `max-age=300` | `max-age=60` |
| 回應多的欄位 | — | `searchMeta`、`highlight` |

**「同一個端點兩種行為」是有代價的**（OpenAPI 要用 `oneOf`、文件要分兩段寫），
但比維護兩支端點好。

---

## 5.11 效能防護：五層

**集合端點是最容易被單一請求打掛的地方（5.2.1）。** 五層防護缺一不可。

### 5.11.1 第 1 層：參數上限

| 參數 | 上限 | 超過時 |
|---|---|---|
| `size` / `limit` | 100 | `400` |
| `page × size`（offset 深度） | 10,000 | `400` + hint 引導到 cursor／匯出 |
| 搜尋的 `page × size` | 1,000 | `400` + `maxAccessibleElements` |
| 日期範圍 | 366 天 | `422` + hint 引導到匯出 |
| 多值參數的值數量 | 50 | `422` |
| `expand` 的項目數 | 3 | `400` |
| `expand` 時的 `size` | 20 | `400`（第 03 章 3.8.2） |
| `q` 的長度 | 100 字元 | `422` |
| `sort` 的欄位數 | 3 | `400` |

**這些數字要寫進一個地方統一管理**（設定檔），而不是散在各個 Controller：

```yaml
api:
  pagination:
    default-size: 20
    max-size: 100
    max-offset: 10000
    max-search-offset: 1000
  filter:
    max-date-range-days: 366
    max-multi-values: 50
    max-query-length: 100
  sort:
    max-fields: 3
  expand:
    max-items: 3
    max-size-with-expand: 20
```

**好處**：出事時可以**用設定檔緊急收緊**（不用發版）。
（02-spring-boot 第 03 章的外部化設定。）

### 5.11.2 第 2 層：索引

**每一個「可篩選 × 可排序」的組合都需要考慮索引。**

**shop-service 的訂單表索引清單**：

```sql
-- 主鍵
PRIMARY KEY (id)

-- 唯一：對外編號查詢
UNIQUE KEY uk_orders_order_number (order_number)

-- 顧客的訂單列表（最高頻）
KEY idx_orders_customer_created (customer_id, created_at DESC, id DESC)

-- 客服按狀態篩選 + 時間排序
KEY idx_orders_status_created (status, created_at DESC, id DESC)

-- 客服按狀態篩選 + 金額排序
KEY idx_orders_status_amount (status, total_amount DESC, id DESC)

-- 廠商增量同步（updated_at cursor）
KEY idx_orders_updated (updated_at, id)

-- 客服搜尋：收件人姓名
KEY idx_orders_recipient_name (recipient_name)

-- 客服搜尋：電話後幾碼（generated column，5.10.3）
KEY idx_orders_phone_rev (recipient_phone_reversed)

-- 未指派的訂單（工作佇列）
KEY idx_orders_assignee_created (assignee_id, created_at DESC, id DESC)
```

**9 個索引。這不是隨便加的 —— 每一個都對應一個具體的查詢。**

**索引的代價（要誠實）**：

| 代價 | 說明 |
|---|---|
| 磁碟空間 | 9 個索引可能是資料本身的 1～2 倍 |
| 寫入變慢 | 每次 `INSERT` 要更新 9 個 B+Tree |
| buffer pool 競爭 | 索引也要佔記憶體，太多索引會互相擠掉 |
| 最佳化器困擾 | 索引太多時，MySQL 可能選錯（要用 `FORCE INDEX` 或調統計資訊） |

**索引檢核流程**（每次新增可篩選／可排序欄位時做）：

```
□ 這個查詢的 EXPLAIN 有 Using filesort 嗎？        → 有就要加索引
□ EXPLAIN 的 rows 估計值是多少？                   → 遠大於 LIMIT 就有問題
□ type 是 ALL（全表掃描）嗎？                       → 是就必須加索引
□ 這個索引和現有的某個索引重複嗎？                  → (a) 和 (a,b) 重複，留 (a,b)
□ 這個查詢的實際 QPS 是多少？                       → 很低的話，可能不值得加索引
□ 加了索引後，寫入的 P99 有變差嗎？                 → 要實測
```

### 5.11.3 第 3 層：查詢超時

```yaml
spring:
  datasource:
    hikari:
      connection-timeout: 3000        # 拿不到連線就放棄（不要排隊等）
      max-lifetime: 1800000
      maximum-pool-size: 20
  jpa:
    properties:
      jakarta.persistence.query.timeout: 3000     # 單一查詢上限（ms）
```

```java
// 針對特定查詢設更短的超時
@QueryHints(@QueryHint(name = "jakarta.persistence.query.timeout", value = "1000"))
List<Order> findByCustomerIdAndStatus(String customerId, OrderStatus status, Pageable pageable);
```

**超時的錯誤處理**（第 04 章 4.10.2）：

```java
@ExceptionHandler(QueryTimeoutException.class)      // Spring 的 DataAccessException 子類
public ResponseEntity<ApiProblem> handle(QueryTimeoutException ex, HttpServletRequest req) {
    log.warn("查詢超時 traceId={} path={} query={}",
             traceId(), req.getRequestURI(), req.getQueryString());
    return problem(ErrorCode.QUERY_TIMEOUT, ...);   // → 503 + Retry-After
}
```

```jsonc
{
  "type": "https://api.shop.example/problems/query-timeout",
  "title": "查詢超時",
  "status": 503,
  "detail": "The query exceeded the 3s budget.",
  "code": "QUERY_TIMEOUT",
  "userMessage": "查詢範圍過大，請縮小篩選條件後再試。",
  "retryable": true,
  "retryStrategy": "MODIFY_REQUEST",
  "retryAfterSeconds": 5,
  "hint": "建議縮小日期範圍，或加上狀態篩選。",
  "traceId": "..."
}
```

⚠️ 注意 `retryable: true` 但 `retryStrategy: MODIFY_REQUEST` ——
「重試同樣的查詢」不會成功，要改條件（第 04 章 4.9.2）。

### 5.11.4 第 4 層：慢查詢監控

```ini
# my.cnf
slow_query_log = 1
long_query_time = 1                    # 超過 1 秒就記錄
log_queries_not_using_indexes = 1      # ★ 沒用索引的也記（開發／測試環境）
log_throttle_queries_not_using_indexes = 60   # 每分鐘最多記 60 筆（避免灌爆）
```

**應用層也要記錄**（更容易對應到 API 端點）：

```java
@Component
public class SlowQueryMetrics {

    @EventListener
    public void onQueryComplete(QueryCompletedEvent e) {
        if (e.durationMs() > 500) {
            log.warn("慢查詢 traceId={} endpoint={} durationMs={} rowsExamined={} sql={}",
                     MDC.get("traceId"), e.endpoint(), e.durationMs(),
                     e.rowsExamined(), e.sqlFingerprint());
        }
        Timer.builder("api.query.duration")
             .tag("endpoint", e.endpoint())        // ★ 低基數（第 04 章 4.12.5）
             .register(registry)
             .record(e.durationMs(), MILLISECONDS);
    }
}
```

**告警規則**：

```yaml
# 集合端點的 P99 延遲
- alert: ListEndpointSlow
  expr: |
    histogram_quantile(0.99,
      rate(http_server_requests_seconds_bucket{uri=~"/orders|/products"}[10m])) > 2
  for: 10m
  labels: { severity: warning }
  annotations:
    summary: "集合端點 P99 延遲超過 2 秒 —— 檢查是否有人在深分頁或大範圍查詢"

# 深分頁被拒絕的次數（如果暴增，表示有 consumer 在用錯的方式拉資料）
- alert: DeepPaginationRejectedSpike
  expr: rate(api_errors_total{code="DEEP_PAGINATION_NOT_SUPPORTED"}[10m]) > 5
  for: 15m
  labels: { severity: info }
  annotations:
    summary: "有 consumer 在嘗試深分頁 —— 主動聯絡他們改用 cursor 或匯出"
```

**最後一條告警很有價值**：它讓你**主動發現**「有人在用錯的方式」，
而不是等到他們把資料庫拖垮。

### 5.11.5 第 5 層：限流與快取

**限流**（第 08 章會詳談）：

```
一般查詢：      每個使用者每分鐘 300 次
帶 include=totalCount： 每個使用者每分鐘 30 次    ← 貴的操作，限得更嚴
搜尋（有 q）：   每個使用者每分鐘 60 次
匯出：          每個使用者同時最多 3 個進行中的工作
```

**「按操作成本分級限流」是很實用的做法** ——
它讓便宜的操作不受影響，貴的操作被保護。

**快取**：

```http
# 商品列表（公開、變動少）
GET /products?categoryId=cat_1&page=0&size=20
→ 200 OK
  Cache-Control: public, max-age=300, stale-while-revalidate=60
  ETag: "list-a3f5c9e1"
  Vary: Accept, Accept-Language

# 訂單列表（私有、每人不同）
GET /orders?page=0&size=20
→ 200 OK
  Cache-Control: private, no-store        ← ★ 絕對不能共享（第 00 章約束 3）
```

**⚠️ 集合端點的 `ETag` 要小心**：

```
ETag 是「整個回應」的指紋。
集合的內容變動很頻繁（任何一筆訂單更新都會讓列表的 ETag 變）
→ 命中率可能很低
→ 但成本也很低（Spring 的 ShallowEtagHeaderFilter 只是多算一次 MD5）
```

**判準**：

| 集合 | 快取策略 |
|---|---|
| 商品分類樹（幾乎不變） | `public, max-age=3600` + `ETag` |
| 商品列表（每天更新幾次） | `public, max-age=300` + `ETag` |
| 搜尋結果（熱門關鍵字重複度高） | `public, max-age=60` |
| 訂單列表（私有、頻繁變動） | `private, no-store`（不快取） |
| 未讀通知數（每秒都在變） | `no-store` |

---

## 5.12 shop-service 完整規格

這是本章的產出。第 07 章會寫進 `orders-api.yaml`。

### 5.12.1 全域分頁參數

| 參數 | 型別 | 預設 | 範圍 | 說明 |
|---|---|---|---|---|
| `page` | integer | `0` | 0～500 | **0-based**。與 `cursor` 互斥 |
| `size` | integer | `20` | 1～100 | 每頁筆數 |
| `cursor` | string | — | ≤ 512 字元 | 不透明游標。與 `page`、`q` 互斥 |
| `limit` | integer | `20` | 1～100 | cursor 模式的每頁筆數（`size` 的別名） |
| `sort` | string[] | 依端點 | ≤ 3 個 | `<field>,<asc\|desc>`，可重複 |
| `include` | string[] | — | 白名單 | `totalCount`、`aggregates` |
| `expand` | string[] | — | ≤ 3 個 | 展開關聯（第 03 章 3.8.2） |
| `asOf` | string | — | ISO-8601 | 凍結查詢基準時間（offset 模式，5.3.6） |

**全域約束**：

```
page × size            <= 10,000
page × size（有 q 時）  <= 1,000
size × expand 項數      <= 60
```

### 5.12.2 `GET /orders`

**篩選參數**

| 參數 | 型別 | 多值 | 說明 |
|---|---|---|---|
| `status` | enum | ✅ | `PENDING_PAYMENT`/`PAID`/`PARTIALLY_SHIPPED`/`SHIPPED`/`COMPLETED`/`CANCELLED`/`RETURNED` |
| `statusCategory` | enum | ✅ | `IN_PROGRESS`/`DONE`/`CANCELLED`（粗粒度，第 03 章 3.10.2） |
| `customerId` | string | ✅（≤50） | ⚠️ 需 `SUPPORT` 權限，否則 `403 FORBIDDEN_PARAMETER` |
| `orderNumber` | string | ❌ | 精確匹配（走唯一索引） |
| `createdFrom` / `createdTo` | date \| datetime | ❌ | `[from, to)`，純日期按 `Asia/Taipei` 展開整天（5.8.2） |
| `updatedFrom` / `updatedTo` | datetime | ❌ | 增量同步用 |
| `amountFrom` / `amountTo` | decimal string | ❌ | `[from, to)` |
| `hasCoupon` | boolean | ❌ | 三態（不帶 = 不篩選，5.8.4） |
| `hasShipment` | boolean | ❌ | 同上 |
| `hasAssignee` | boolean | ❌ | `false` = 未指派（5.8.5）。與 `assigneeId` 互斥 |
| `assigneeId` | string | ✅ | 需 `SUPPORT` 權限 |
| `paymentMethod` | enum | ✅ | — |
| `q` | string | ❌ | ≤100 字元。搜訂單編號前綴／收件人姓名／電話後綴／Email 前綴（5.10.3）。與 `cursor` 互斥 |

**可排序欄位**

| 欄位 | 需搭配篩選？ | 索引 |
|---|---|---|
| `createdAt`（**預設** `desc`） | ❌ | `idx_orders_customer_created` / `idx_orders_status_created` |
| `updatedAt` | ❌ | `idx_orders_updated` |
| `totalAmount` | ✅ 需 `status` 或 `createdFrom` | `idx_orders_status_amount` |
| `orderNumber` | ❌ | `uk_orders_order_number` |
| `status` | ✅ 需其他條件 | — |

**tie-breaker**：一律自動附加 `id`，方向跟隨最後一個排序欄位（5.9.3）。

**分頁模式**

| 角色 / 用途 | 模式 | total |
|---|---|---|
| 顧客（自己的訂單，通常 < 100 筆） | offset | 精確 |
| 客服 / 管理後台 | offset + `asOf` + 深度上限 10,000 | 上限計數（cap 10,000） |
| 客服 + `include=totalCount` | offset | 精確（超時則 `warnings`） |
| App 無限滾動 | cursor | 無（`hasMore`） |
| 廠商增量同步 | cursor（`sort=updatedAt,asc`） | 無 |

**回應範例（offset 模式）**

```http
GET /orders?status=PAID&status=SHIPPED&createdFrom=2026-08-01&createdTo=2026-08-31&sort=totalAmount,desc&page=0&size=20
Authorization: Bearer <SUPPORT token>
```

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: private, no-store
Link: </orders?status=PAID&status=SHIPPED&createdFrom=2026-08-01&createdTo=2026-08-31&sort=totalAmount,desc&page=1&size=20>; rel="next"
X-Total-Count: 10000
Access-Control-Expose-Headers: Link, X-Total-Count
```
```jsonc
{
  "items": [ /* 20 筆 OrderSummary，第 03 章 3.14.2 */ ],
  "page": {
    "mode": "OFFSET",
    "number": 0,
    "size": 20,
    "totalElements": 10000,
    "totalElementsRelation": "GREATER_THAN_OR_EQUAL",
    "totalPages": 500,
    "totalPagesRelation": "GREATER_THAN_OR_EQUAL",
    "hasMore": true,
    "maxAccessibleElements": 10000
  },
  "links": {
    "self": "/orders?status=PAID&status=SHIPPED&createdFrom=2026-08-01&createdTo=2026-08-31&sort=totalAmount,desc&page=0&size=20",
    "next": "/orders?status=PAID&status=SHIPPED&createdFrom=2026-08-01&createdTo=2026-08-31&sort=totalAmount,desc&page=1&size=20",
    "first": "/orders?...&page=0&size=20"
  },
  "asOf": "2026-08-19T06:12:44Z",
  "appliedFilters": {
    "status": ["PAID", "SHIPPED"],
    "createdFrom": "2026-07-31T16:00:00Z",
    "createdTo": "2026-08-31T16:00:00Z"
  },
  "warnings": [
    { "code": "TOTAL_COUNT_CAPPED",
      "message": "符合條件的資料超過 10,000 筆，總數僅顯示下限。" }
  ]
}
```

**`appliedFilters` 是很有價值的欄位** —— 它回報**伺服器實際套用的條件**：

| 價值 | 說明 |
|---|---|
| 客戶端可以驗證「我的篩選有生效嗎」 | 對照 5.8.6 的靜默忽略問題，這是第二道保險 |
| 明確顯示日期的實際解讀 | 客戶端送 `2026-08-31`，回應顯示實際是 `2026-08-31T16:00:00Z`（exclusive）→ 5.8.2 的歧義一目了然 |
| 除錯時省掉一輪來回 | 「為什麼結果不對」→ 看 `appliedFilters` 就知道 |

**回應範例（cursor 模式）**

```http
GET /orders?sort=updatedAt,asc&limit=100&cursor=eyJrIjpbIjIwMjYtMDgtMTlUMDY6MTI6NDRaIiwiNDgyMTMiXSwicyI6InVwZGF0ZWRBdDphc2MsaWQ6YXNjIiwiZiI6ImE5ZjNjMSIsImQiOiJuZXh0IiwidiI6MX0
Authorization: Bearer <廠商 API key>
```
```jsonc
{
  "items": [ /* 100 筆 */ ],
  "page": {
    "mode": "CURSOR",
    "limit": 100,
    "hasMore": true,
    "nextCursor": "eyJrIjpbIjIwMjYtMDgtMTlUMDg6MzE6MDJaIiwiNDgzMTMiXSwicyI6InVwZGF0ZWRBdDphc2MsaWQ6YXNjIiwiZiI6ImE5ZjNjMSIsImQiOiJuZXh0IiwidiI6MX0",
    "prevCursor": null
  },
  "links": {
    "self": "/orders?sort=updatedAt,asc&limit=100&cursor=eyJrIjpb...",
    "next": "/orders?sort=updatedAt,asc&limit=100&cursor=eyJrIjpbIjIwMjYtMDgtMTlUMDg6MzE6MDJa..."
  }
}
```

### 5.12.3 `GET /products`

| 參數 | 說明 |
|---|---|
| `q` | 全文搜尋（MySQL `ngram`，5.10.3）。與 `cursor` 互斥；深度上限 1,000 |
| `namePrefix` | 前綴搜尋（自動完成用，走索引，`size` 上限 10） |
| `categoryId` | 多值（≤20） |
| `status` | `ACTIVE`/`DRAFT`/`DISCONTINUED`（非 ADMIN 只能看 `ACTIVE`） |
| `priceFrom` / `priceTo` | `[from, to)` |
| `inStock` | boolean 三態 |
| `featured` | boolean 三態 |
| `sort` | `relevance`（有 `q` 時預設）／`price`／`createdAt`／`ratingAvg`／`salesCount` |

**排序白名單刻意不含**：`cost`、`margin`、`viewCount`（5.9.2 的資訊洩漏）。

**快取**：

```http
GET /products?categoryId=cat_1&page=0&size=20
→ Cache-Control: public, max-age=300, stale-while-revalidate=60
  ETag: "..."
  Vary: Accept, Accept-Language

GET /products?q=耳機&page=0&size=20
→ Cache-Control: public, max-age=60
```

### 5.12.4 其他集合端點

| 端點 | 分頁 | 預設排序 | 主要篩選 |
|---|---|---|---|
| `GET /orders/{id}/items` | ❌ 不分頁（上限 50 筆，第 03 章） | 明細順序 | — |
| `GET /orders/{id}/payments` | ❌ 不分頁（通常 1～3 筆） | `createdAt,desc` | — |
| `GET /orders/{id}/shipments` | ❌ 不分頁 | `createdAt,desc` | — |
| `GET /payments` | offset + cursor | `createdAt,desc` | `status`、`method`、`createdFrom/To`、`orderId` |
| `GET /shipments` | offset + cursor | `createdAt,desc` | `status`、`carrier`、`createdFrom/To` |
| `GET /returns` | offset | `createdAt,desc` | `status`、`createdFrom/To` |
| `GET /reviews` | offset + cursor | `createdAt,desc` | `productId`、`customerId`、`rating` |
| `GET /customers` | offset | `createdAt,desc` | `q`（姓名/Email/電話）、`tier`、`createdFrom/To` |
| `GET /me/addresses` | ❌ 不分頁（上限 20 筆） | `isDefault,desc`、`createdAt,desc` | — |
| `GET /order-exports` | offset | `createdAt,desc` | `status` |
| `GET /order-import-jobs/{id}/errors` | offset | `row,asc` | `code` |

**「不分頁」的規則**：如果資源在業務上有**硬性數量上限**（訂單明細最多 50 項、
地址最多 20 個），就不需要分頁 —— **但要在業務層強制那個上限**，
而且回應時仍然用 `{ items: [...] }` 的外殼（結構一致，未來要加分頁不算破壞性變更）。

```jsonc
// GET /orders/{id}/items
{
  "items": [ /* 最多 50 筆 */ ],
  "page": { "mode": "NONE", "totalElements": 3 }     // ★ 明確標示不分頁
}
```

**`mode: "NONE"` 讓客戶端的分頁處理程式碼可以統一** ——
不用為「有些端點有 page 有些沒有」寫特例。

### 5.12.5 新增的錯誤碼（補充第 04 章 4.13）

| `code` | 狀態碼 | `title` | 擴充欄位 |
|---|---|---|---|
| `DEEP_PAGINATION_NOT_SUPPORTED` | 400 | 不支援深分頁 | `maxOffset`, `requestedOffset` |
| `CURSOR_QUERY_MISMATCH` | 400 | 分頁游標與查詢條件不符 | `cursorSort`, `requestedSort` |
| `INVALID_CURSOR` | 400 | 分頁游標無效 | — |
| `UNKNOWN_QUERY_PARAMETER` | 400 | 未知的查詢參數 | `suggestion`, `allowedParameters[]` |
| `SORT_REQUIRES_FILTER` | 400 | 此排序需搭配篩選條件 | `requiredFilters[]` |
| `DATE_RANGE_TOO_LARGE` | 422 | 查詢區間過大 | `maxDays`, `requestedDays` |
| `TOO_MANY_FILTER_VALUES` | 422 | 篩選值數量過多 | `parameter`, `max`, `actual` |
| `QUERY_TIMEOUT` | 503 | 查詢超時 | `retryAfterSeconds` |
| `COUNT_QUERY_TIMEOUT` | 503 | 計數查詢超時 | — |

**新增的 `warnings` 代碼**：

| `code` | 說明 |
|---|---|
| `TOTAL_COUNT_CAPPED` | 總數超過上限，只顯示下限 |
| `TOTAL_COUNT_UNAVAILABLE` | 計數查詢超時，未提供總數 |
| `RESULT_TRUNCATED` | 結果集被截斷（搜尋上限） |
| `FILTER_PARTIALLY_APPLIED` | 部分篩選因權限未套用（並列出哪些） |

**最後一個值得說明**：

```jsonc
// 顧客送了 ?customerId=cus_other（想看別人的訂單）
// 選項 A：回 403（shop-service 的選擇，第 04 章 4.13.1）
// 選項 B：忽略該參數 + warning
{
  "items": [ /* 只有自己的訂單 */ ],
  "warnings": [
    { "code": "FILTER_PARTIALLY_APPLIED",
      "message": "參數 customerId 因權限不足未套用。",
      "ignoredParameters": ["customerId"] }
  ]
}
```

**shop-service 選 A（回 403）**，理由：5.8.6 的「靜默忽略」問題 ——
選項 B 雖然有 warning，但客戶端很可能不讀，然後以為篩選生效了。
**權限相關的參數被忽略，一定要是錯誤，不能是警告。**

---

## 5.13 Spring 實作要點（預告）

完整實作在 04-controller 與 06-repository，這裡只點出**必須自己處理的地方**。

### 5.13.1 `Pageable` 自動綁定

```java
@GetMapping("/orders")
public PageResponse<OrderSummary> list(
        @Valid OrderFilter filter,
        @PageableDefault(size = 20, sort = "createdAt", direction = Sort.Direction.DESC)
        Pageable pageable) {
    ...
}
```

```yaml
spring:
  data:
    web:
      pageable:
        default-page-size: 20
        max-page-size: 100              # ⚠️ 預設 2000，一定要改
        one-indexed-parameters: false    # 0-based（5.3.3）
        page-parameter: page
        size-parameter: size
      sort:
        sort-parameter: sort
```

### 5.13.2 `Pageable` 的三個坑 ★

| 坑 | 說明 | 解法 |
|---|---|---|
| **`max-page-size` 是靜默夾取，不是 `400`** | `?size=10000` → 變成 100，不報錯（5.2.4 的災難） | 自己加 `HandlerMethodArgumentResolver` 或 Interceptor 驗證原始參數 |
| **`sort` 沒有白名單** | `?sort=cost,desc` → Spring 會嘗試當 Entity 屬性；找不到會拋 `PropertyReferenceException`（`500`），找到了就洩漏（5.9.2） | 不要直接用 `Pageable` 的 `Sort`，先過白名單轉換 |
| **`Page<T>` 會自動執行 `COUNT`** | 每次查詢都付 5.6 的代價 | 需要時用 `Slice<T>`（不 count）或自己控制 |

**驗證原始參數的做法**：

```java
@Component
public class PageableValidationInterceptor implements HandlerInterceptor {

    private final ApiLimitProperties limits;

    @Override
    public boolean preHandle(HttpServletRequest req, HttpServletResponse res, Object handler) {
        List<FieldError> errors = new ArrayList<>();

        // ★ 讀「原始」參數，而不是 Spring 夾取後的 Pageable
        Integer size = parseInt(req.getParameter("size"), errors, "size");
        Integer page = parseInt(req.getParameter("page"), errors, "page");

        if (size != null && size > limits.maxSize()) {
            errors.add(FieldError.max("size", size, limits.maxSize()));
        }
        if (size != null && size < 1) {
            errors.add(FieldError.min("size", size, 1));
        }
        if (page != null && page < 0) {
            errors.add(FieldError.min("page", page, 0));
        }
        if (page != null && size != null
                && (long) page * size > limits.maxOffset()) {
            throw new DeepPaginationException(page, size, limits.maxOffset());
        }
        if (req.getParameter("page") != null && req.getParameter("cursor") != null) {
            errors.add(FieldError.conflict("cursor", "page"));
        }

        if (!errors.isEmpty()) throw new ValidationFailedException(errors);
        return true;
    }
}
```

**注意：這個檢查必須在 `Pageable` 綁定「之前」** ——
`HandlerInterceptor.preHandle` 在參數解析前執行，所以讀得到原始值。

### 5.13.3 Spring Data 3.1+ 的 keyset 分頁

Spring Data 3.1 起有原生的 keyset（cursor）分頁支援：

```java
public interface OrderRepository extends JpaRepository<Order, String> {

    Window<Order> findByCustomerIdOrderByCreatedAtDescIdDesc(
            String customerId, ScrollPosition position, Limit limit);
}
```

```java
// 第一頁
ScrollPosition pos = ScrollPosition.keyset();
Window<Order> w = repo.findByCustomerIdOrderByCreatedAtDescIdDesc(
        customerId, pos, Limit.of(21));

// 下一頁
if (w.hasNext()) {
    ScrollPosition next = w.positionAt(w.size() - 1);
    Window<Order> w2 = repo.findByCustomerIdOrderByCreatedAtDescIdDesc(
            customerId, next, Limit.of(21));
}
```

**它幫你處理的**：
- ✅ 產生 `WHERE (created_at, id) < (?, ?)` 的條件（含 tie-breaker）。
- ✅ `hasNext()` 判斷。

**它「不」幫你處理的（你還是要自己做）**：
- ❌ cursor 的**編碼／解碼**（`ScrollPosition` 是 Java 物件，不是字串）。
- ❌ cursor 裡的 `sortSpec` / `filterHash` 驗證（5.4.3）。
- ❌ 排序欄位白名單。
- ❌ 雙向分頁的 reverse。

**所以你仍然需要 5.4.3 的 `Cursor` 型別** —— 
`ScrollPosition` 是「內部表示」，`Cursor` 是「API 契約」。兩者之間要有轉換層。

### 5.13.4 動態篩選：三種做法

| 做法 | 適合 |
|---|---|
| **`Specification<T>`**（JPA Criteria） | ★ 篩選條件多且可組合；型別安全 |
| **QueryDSL** | 更好的 DSL 體驗；需要 annotation processor 產生 Q 類別 |
| **MyBatis 動態 SQL** | 需要完全掌控 SQL；複雜 join |

```java
// Specification 的樣子（06-repository / 08-jpa-mybatis 會完整實作）
public static Specification<Order> from(OrderFilter f, Authentication auth) {
    return (root, query, cb) -> {
        List<Predicate> ps = new ArrayList<>();

        // ★ 權限範圍永遠第一個，而且不可被客戶端覆寫（第 01 章 1.4.1）
        if (!hasRole(auth, "SUPPORT")) {
            ps.add(cb.equal(root.get("customerId"), currentCustomerId(auth)));
        } else if (f.customerId() != null && !f.customerId().isEmpty()) {
            ps.add(root.get("customerId").in(f.customerId()));
        }

        if (f.status() != null && !f.status().isEmpty()) {
            ps.add(root.get("status").in(f.status()));
        }
        if (f.createdFrom() != null) {
            ps.add(cb.greaterThanOrEqualTo(root.get("createdAt"), f.createdFrom()));
        }
        if (f.createdTo() != null) {
            ps.add(cb.lessThan(root.get("createdAt"), f.createdTo()));   // ★ exclusive（5.8.2）
        }
        if (f.hasAssignee() != null) {
            ps.add(f.hasAssignee()
                    ? cb.isNotNull(root.get("assigneeId"))
                    : cb.isNull(root.get("assigneeId")));
        }
        // ...

        // ★ count query 不需要 fetch join，避免無效的 SQL
        if (query.getResultType() != Long.class) {
            root.fetch("customer", JoinType.LEFT);
        }

        return cb.and(ps.toArray(Predicate[]::new));
    };
}
```

**最後那個 `if (query.getResultType() != Long.class)` 是一個很容易踩到的坑**：
`Page<T>` 會執行 count query，而 count query 帶 `fetch join` 會產生
`org.hibernate.QueryException: query specified join fetching, but the owner of the fetched association was not present in the select list`。

---

## 5.14 常見誤區

**誤區 1：「加了 `size` 的預設值就等於有分頁保護」**
5.2.3：預設值、上限、最小值是三件事。沒有上限 = 沒有保護。

**誤區 2：「超過上限就靜默夾到上限比較友善」**
5.2.4：客戶端用「不足一頁」判斷結束時，會靜默拿到不完整的資料。回 `400`。

**誤區 3：「offset 分頁加了索引就不會慢」**
5.3.4：`OFFSET 400000` 必須讀取並丟棄 40 萬筆。索引只能減輕（deferred join），不能改變 O(offset)。

**誤區 4：「深分頁上限是偷懶」**
5.3.5：GitHub 1000、Elasticsearch 10000、Google 400。**沒有人會真的翻到第 5000 頁** —— 
會的一定是程式，而它應該用 cursor 或匯出。

**誤區 5：「cursor 分頁只要記住最後一筆的 ID 就好」**
5.4.2：只用單一非唯一欄位會**漏資料**。必須是「排序欄位 + 唯一 tie-breaker」的複合鍵。

**誤區 6：「cursor 是內部細節，客戶端不會亂改」**
5.4.3：客戶端**一定會**在換了排序或篩選後沿用舊 cursor。要在 cursor 裡放 `sortSpec` + `filterHash` 並驗證。

**誤區 7：「`totalElements` 是免費的」**
5.6.1：InnoDB 的 `COUNT(*)` 是 O(n)。count 查詢可能比主查詢慢 10 倍，佔總耗時 98%。

**誤區 8：「`SQL_CALC_FOUND_ROWS` 比兩個查詢快」**
5.6.2：MySQL 官方說通常**更慢**，且已在 8.0.17 deprecated。

**誤區 9：「`?createdTo=2026-08-31` 當然包含 8/31」**
5.8.2：如果實作寫成 `created_at <= '2026-08-31'`，那 8/31 一整天都被漏掉。
這是財務報表最常見的「差一天」bug。

**誤區 10：「布林篩選用 `boolean` 就好」**
5.8.4：`boolean` 沒有「未指定」狀態。`?isGift` 不帶時會變成「只要非禮物訂單」。用 `Boolean`。

**誤區 11：「未知參數忽略掉比較寬容」**
5.8.6：🔴 這會讓「篩選沒生效」變成靜默錯誤 —— 客服對未付款訂單執行出貨、廠商同步錯一年。

**誤區 12：「排序欄位只是效能問題」**
5.9.2：允許排序隱藏欄位（`cost`）等於洩漏該欄位的完整排名，即使回應裡沒有這個欄位。

**誤區 13：「`ORDER BY createdAt DESC` 就夠了」**
5.9.3：排序值重複時，「第 21～40 筆是哪些」在 SQL 層面**未定義**。一定要加唯一的 tie-breaker。

**誤區 14：「`LIKE '%關鍵字%'` 就是搜尋」**
5.10.2：不走索引（全表掃描）、搜尋品質差（換順序就 0 筆）、沒有相關度排序、`%`/`_` 要轉義。

**誤區 15：「MySQL 全文索引可以搜中文」**
5.10.3：**預設的 parser 靠空白斷詞，對中文完全無效。** 必須用 `WITH PARSER ngram`。

**誤區 16：「搜尋結果也可以用 cursor 分頁」**
5.10.4：相關度分數不穩定、不唯一、不是資料庫欄位 → 無法當 cursor 的排序鍵。

**誤區 17：「`Page<T>` 直接回出去就好」**
第 03 章 3.11.1 + 5.13.2：洩漏 Spring Data 內部結構，而且會自動執行 count 查詢。

**誤區 18：「Spring 的 `max-page-size` 已經保護我了」**
5.13.2：它是**靜默夾取**，不是 `400`。而且 `sort` 完全沒有白名單。

---

## 5.15 本章練習

### 練習 1：判斷分頁方式

以下情境各該用 offset 還是 cursor？為什麼？

```
1.  電商 App 的「我的訂單」列表（下拉載入更多，一般使用者 < 100 筆）
2.  客服後台的訂單表格（有頁碼元件、可跳頁、300 萬筆資料）
3.  廠商 ERP 每 15 分鐘同步一次「有更新的訂單」
4.  資料分析團隊要一次匯出上一季所有訂單（約 40 萬筆）
5.  首頁的「熱銷商品 Top 20」
6.  管理後台的「未指派客服的訂單」工作佇列（通常 < 500 筆，要能跳到最後一頁）
7.  App 的商品搜尋結果（無限滾動）
8.  即時的「新訂單通知」列表（新訂單會插到最前面，使用者下拉刷新）
```

<details>
<summary>參考解答</summary>

| # | 選擇 | 理由 |
|---|---|---|
| 1 | **cursor** | 無限滾動天生是 cursor 語意（「從上次的位置繼續」）。<br>而且新訂單進來時 offset 會漂移（5.3.6）→ 使用者滑到底看到重複的訂單。<br>⚠️ 雖然 < 100 筆效能無所謂，但**穩定性**才是理由 |
| 2 | **offset** | 要跳頁 → cursor 做不到（5.4.6）。<br>必要配套：深分頁上限 10,000 + `asOf` 凍結 + 上限計數（cap 10,000） |
| 3 | **cursor**（`sort=updatedAt,asc`） | 批次遍歷 → 一定會走到最後一筆 → 不能有深分頁問題。<br>⚠️ 注意 5.4.6 的警告：用 `updatedAt` 當 cursor，資料被更新後會「跳」到後面 → 可能重複看到。<br>**但這在增量同步場景正是想要的**（更新過的要重新同步） |
| 4 | **都不用** —— 用匯出工作 | 40 萬筆不該用分頁 API 拉（就算用 cursor，4000 次請求也是浪費）。<br>`POST /order-exports` → `202` → 輪詢 → 下載 CSV（第 02 章 2.10） |
| 5 | **都不用** —— 固定 20 筆的端點 | `GET /products/top-sellers?limit=20`，不需要分頁參數。<br>✅ 快取 `public, max-age=300`（第 08 章）<br>⚠️ 但回應仍用 `{ items: [...], page: { mode: "NONE" } }` 保持結構一致（5.12.4） |
| 6 | **offset** | 要跳到最後一頁 → 必須 offset。<br>資料量小（< 500）→ 深分頁不會發生。<br>而且工作佇列的「總共還有幾筆」對使用者很重要 → 精確 count 可接受 |
| 7 | **offset**（不是 cursor！） | 🔴 這題是陷阱。<br>搜尋按相關度排序 → 相關度不能當 cursor 的排序鍵（5.10.4）。<br>所以即使是無限滾動，搜尋也只能用 offset + 硬上限 1,000。<br>**這是「無限滾動 ≠ 一定用 cursor」的反例** |
| 8 | **cursor 雙向** | 新資料插在最前面 → 需要 `before`（往前拉刷新）。<br>這是 5.4.5 雙向分頁的典型場景，而且**必須記得 `reverse()`** |

**這題的三個核心洞察**：

1. **選擇的關鍵不是「資料量」而是「使用模式」**：
   ```
   用眼睛瀏覽 + 要跳頁      → offset（第 2、6 題）
   用程式遍歷 / 無限滾動     → cursor（第 1、3 題）
   要拉全部                 → 匯出（第 4 題）
   固定筆數                 → 不分頁（第 5 題）
   ```

2. **第 7 題最容易答錯**：無限滾動的 UI 不代表可以用 cursor。
   **排序鍵能不能當 cursor，才是決定因素。**

3. **第 1 題的理由是「穩定性」不是「效能」**：
   100 筆資料用 offset 完全不會慢，但**會重複**。
   很多人以為 cursor 只是為了效能 —— 它同時解決了資料漂移，而後者是正確性問題。

</details>

### 練習 2：找出分頁實作的問題

```java
@GetMapping("/orders")
public List<OrderSummary> list(
        @RequestParam(defaultValue = "1") int page,
        @RequestParam(defaultValue = "20") int size,
        @RequestParam(required = false) String status,
        @RequestParam(required = false) String startDate,
        @RequestParam(required = false) String endDate,
        @RequestParam(defaultValue = "createdAt") String sortBy,
        @RequestParam(defaultValue = "desc") String direction,
        @RequestParam(defaultValue = "false") boolean isGift) {

    String sql = "SELECT * FROM orders WHERE 1=1";
    if (status != null)    sql += " AND status = '" + status + "'";
    if (startDate != null) sql += " AND created_at >= '" + startDate + "'";
    if (endDate != null)   sql += " AND created_at <= '" + endDate + "'";
    sql += " AND is_gift = " + isGift;
    sql += " ORDER BY " + sortBy + " " + direction;
    sql += " LIMIT " + size + " OFFSET " + (page - 1) * size;

    return jdbcTemplate.query(sql, new OrderSummaryRowMapper());
}
```

找出所有問題並排序嚴重度。

<details>
<summary>參考解答</summary>

**🔴 資安（4 個，全部是 SQL injection）**

| # | 問題 | 攻擊範例 |
|---|---|---|
| 1 | `status` 直接串接 | `?status=' OR 1=1 --` → 忽略所有條件<br>`?status=' UNION SELECT password_hash,1,1,1 FROM customers --` → **拖庫** |
| 2 | `startDate` / `endDate` 直接串接 | 同上 |
| 3 | **`sortBy` 直接串接** | `?sortBy=(SELECT CASE WHEN (SELECT COUNT(*) FROM customers)>0 THEN id ELSE order_number END)` → 盲注 |
| 4 | **`direction` 直接串接** | `?direction=desc; DROP TABLE orders --`（依驅動是否允許多語句） |

**注意第 3、4 個特別危險**：很多人知道要用 PreparedStatement 綁值，
但**`ORDER BY` 的欄位名不能用參數綁定** → 只能用白名單（5.9.2）。
這是最容易被忽略的 injection 點。

**🔴 沒有權限範圍（1 個）**

| # | 問題 |
|---|---|
| 5 | **完全沒有 `customer_id` 條件** → 任何登入的顧客都能看到**全站所有訂單**（第 01 章 1.4.1 的 IDOR）。<br>而且是「批量」IDOR —— 一次拿走全部，比逐筆猜 ID 嚴重得多 |

**🔴 效能（4 個）**

| # | 問題 | 說明 |
|---|---|---|
| 6 | **`size` 沒有上限** | `?size=999999` → 5.2.1 的 OOM 事故 |
| 7 | **`page` 沒有上限** | `?page=50000` → `OFFSET 1000000` → 逾時（5.3.4） |
| 8 | **`SELECT *`** | 撈出所有欄位（含 `internal_note`、`cost`），無法用覆蓋索引 |
| 9 | **`sortBy` 沒有白名單 → 可能 filesort** | `?sortBy=internal_note` → 300 萬筆 filesort（5.9.4） |

**🟠 正確性（4 個）**

| # | 問題 | 說明 |
|---|---|---|
| 10 | **`ORDER BY` 沒有 tie-breaker** | 排序值重複時第 21～40 筆未定義 → 重複／漏（5.9.3） |
| 11 | **`isGift` 用 `boolean`** | 不帶參數時是 `false` → 變成「只看非禮物訂單」🔴 使用者完全沒要求這個篩選（5.8.4） |
| 12 | **`endDate` 用 `<=`** | `?endDate=2026-08-31` → `created_at <= '2026-08-31'` → **8/31 一整天被漏掉**（5.8.2） |
| 13 | **`page` 是 1-based 但沒有文件說明** | `?page=0` → `OFFSET -20` → MySQL 語法錯誤 → `500`（而不是 `400`） |

**🟠 API 設計（5 個）**

| # | 問題 | 說明 |
|---|---|---|
| 14 | **回傳裸陣列** | 無法加分頁資訊；未來要加 = 破壞性變更（第 03 章 3.11.1） |
| 15 | **沒有任何分頁 metadata** | 客戶端不知道有沒有下一頁 → 只能用 `items.length < size` 猜（5.2.4） |
| 16 | `startDate`/`endDate` 命名模糊 | 是訂單的哪個日期？（5.8.1） |
| 17 | `sortBy` + `direction` 是兩個參數 | 無法多重排序；和 Spring Data 慣例不一致（5.9.1） |
| 18 | 未知參數靜默忽略 | `?stauts=PAID` → 回全部（5.8.6） |

**🟡 其他（3 個）**

| # | 問題 |
|---|---|
| 19 | 沒有查詢超時 → 慢查詢會佔住連線池 |
| 20 | 沒有 `Cache-Control` → 訂單列表可能被共享快取（第 00 章約束 3 的個資洩漏） |
| 21 | 沒有記錄慢查詢的指標 |

**總計 21 個問題**（5 個 🔴 極高、8 個 🟠 高、3 個 🟡 中，加上 5 個設計問題）。

**修正後的版本**

```java
@GetMapping("/orders")
public PageResponse<OrderSummary> list(
        @Valid OrderFilter filter,                          // ★ 具名 record，有驗證
        @Valid PageQuery pageQuery,                          // ★ 含上限檢查
        Authentication auth) {

    // ★ 權限範圍在 Specification 裡強制加上（5.13.4），不可能忘記
    Specification<Order> spec = OrderSpecifications.from(filter, auth);
    Sort sort = orderSortResolver.resolve(filter.sort());   // ★ 白名單 + tie-breaker

    Page<Order> page = repository.findAll(spec,
            PageRequest.of(pageQuery.page(), pageQuery.size(), sort));

    return PageResponse.of(page, mapper.toSummaries(page.getContent()),
                           filter.appliedFilters());
}
```

```java
public record OrderFilter(
    List<OrderStatus> status,                                // ★ 列舉，不是 String
    List<@Size(max = 64) String> customerId,                 // 需 SUPPORT 權限，在 Spec 檢查
    @Size(max = 30) String createdFrom,                      // 在 record 內轉 Instant
    @Size(max = 30) String createdTo,
    Boolean isGift,                                          // ★ Boolean 三態
    Boolean hasCoupon,
    @Size(max = 3) List<@Pattern(regexp = "[a-zA-Z]+(,(asc|desc))?") String> sort,
    @Size(max = 100) String q
) {
    public Instant createdFromInstant() { /* 5.8.2 */ }
    public Instant createdToExclusive() { /* 5.8.2，+1 天 */ }

    @AssertTrue(message = "結束日期不可早於開始日期")
    public boolean isDateRangeValid() { /* ... */ }

    @AssertTrue(message = "查詢區間最多 366 天")
    public boolean isDateRangeWithinLimit() { /* ... */ }
}
```

```java
public record PageQuery(
    @Min(0) @Max(500) int page,
    @Min(1) @Max(100) int size
) {
    public PageQuery {
        if ((long) page * size > 10_000) {
            throw new DeepPaginationException(page, size, 10_000);
        }
    }
}
```

```java
@Component
public class OrderSortResolver {

    public Sort resolve(List<String> sortParams) {
        List<Sort.Order> orders = new ArrayList<>();
        for (String p : sortParams == null ? List.<String>of() : sortParams) {
            String[] parts = p.split(",");
            OrderSortField f = OrderSortField.of(parts[0].trim());     // ★ 白名單，找不到 → 400
            Sort.Direction d = parts.length > 1 && "desc".equalsIgnoreCase(parts[1])
                    ? Sort.Direction.DESC : Sort.Direction.ASC;
            orders.add(new Sort.Order(d, f.apiName()));
        }
        if (orders.isEmpty()) orders.add(new Sort.Order(Sort.Direction.DESC, "createdAt"));

        // ★ tie-breaker（5.9.3）
        if (orders.stream().noneMatch(o -> "id".equals(o.getProperty()))) {
            orders.add(new Sort.Order(orders.get(orders.size() - 1).getDirection(), "id"));
        }
        return Sort.by(orders);
    }
}
```

**這一題的核心教訓**：

> **原本的 15 行程式碼有 21 個問題，其中 5 個可以直接拖庫或看到全站訂單。**
> 而它「看起來」是很正常的 Spring Boot 程式碼 —— 這正是集合端點危險的地方：
> **它的 bug 不會讓功能壞掉，只會讓資料錯、讓資料庫掛、讓資料外洩。**

</details>

### 練習 3：設計 cursor 分頁

為「廠商 ERP 增量同步訂單」設計 cursor 分頁。需求：

- 廠商每 15 分鐘呼叫一次，同步「上次同步後有變更的訂單」。
- 一次最多 500 筆。
- 必須保證「不漏」（漏了會導致廠商的庫存對不上）。
- 廠商可能中斷後重跑（斷點續傳）。
- 廠商有 3 家，各自只能看到自己的訂單。

寫出完整的 API 契約、cursor 設計、SQL、以及會遇到的三個陷阱。

<details>
<summary>參考解答</summary>

**API 契約**

```http
GET /orders?updatedFrom=2026-08-19T06:00:00Z&sort=updatedAt,asc&limit=500
Authorization: Bearer <廠商 API key>
Accept: application/json
```

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: private, no-store
```
```jsonc
{
  "items": [ /* 500 筆 OrderSummary */ ],
  "page": {
    "mode": "CURSOR",
    "limit": 500,
    "hasMore": true,
    "nextCursor": "eyJrIjpbIjIwMjYtMDgtMTlUMDY6MTQ6MDIuMTIzWiIsIm9yZF8wMUo1R0siXSwicyI6InVwZGF0ZWRBdDphc2MsaWQ6YXNjIiwiZiI6ImE5ZjNjMWU4IiwiZCI6Im5leHQiLCJ2IjoxfQ"
  },
  "links": {
    "self": "/orders?updatedFrom=2026-08-19T06:00:00Z&sort=updatedAt,asc&limit=500",
    "next": "/orders?updatedFrom=2026-08-19T06:00:00Z&sort=updatedAt,asc&limit=500&cursor=eyJrIjpb..."
  },
  "syncMeta": {
    "serverTime": "2026-08-19T06:15:00.000Z",
    "safeWatermark": "2026-08-19T06:14:55.000Z"
  }
}
```

**廠商的同步迴圈**

```python
# 廠商端的正確做法
watermark = load_last_watermark()          # 上次的 safeWatermark
url = f"/orders?updatedFrom={watermark}&sort=updatedAt,asc&limit=500"

while url:
    res = get(url)
    for order in res["items"]:
        upsert_order(order)                # ★ 必須是 upsert（見陷阱 1）
    url = res["links"].get("next")

save_watermark(res["syncMeta"]["safeWatermark"])    # ★ 只在整輪跑完才更新
```

**cursor 設計**

```jsonc
// base64url 編碼前
{
  "k": ["2026-08-19T06:14:02.123Z", "ord_01J5GKQ8Z4W9V2X3Y6N7M8P0QR"],
  "s": "updatedAt:asc,id:asc",
  "f": "a9f3c1e8",                 // SHA-256("updatedFrom=2026-08-19T06:00:00Z|vendorId=v_001")[:8]
  "d": "next",
  "v": 1
}
```

**⚠️ `f`（filterHash）必須包含 `vendorId`**：
這樣廠商 A 的 cursor 拿去給廠商 B 用會被拒絕（`400 CURSOR_QUERY_MISMATCH`）。
雖然 `WHERE vendor_id = ?` 的條件來自 token（不來自 cursor），所以不會有資料洩漏，
但**明確拒絕比靜默給出奇怪的結果好**。

**SQL**

```sql
-- 索引
CREATE INDEX idx_orders_vendor_updated ON orders (vendor_id, updated_at, id);

-- 第一頁
SELECT id, order_number, status, total_amount, updated_at, ...
FROM orders
WHERE vendor_id = ?                              -- ★ 來自 token，不來自參數
  AND updated_at >= ?                            -- updatedFrom
ORDER BY updated_at ASC, id ASC
LIMIT 501;                                       -- ★ limit + 1

-- 後續頁（cursor）
SELECT id, order_number, status, total_amount, updated_at, ...
FROM orders
WHERE vendor_id = ?
  AND updated_at >= ?                            -- updatedFrom（保留，作為外層邊界）
  AND (updated_at, id) > (?, ?)                  -- ★ cursor
ORDER BY updated_at ASC, id ASC
LIMIT 501;
```

**`EXPLAIN` 應該長這樣**：

```
-> Limit: 501 row(s)
    -> Index range scan on orders using idx_orders_vendor_updated
       over (vendor_id = 'v_001' AND (updated_at, id) > (...))
       (actual rows=501 loops=1)        ← 只掃 501 筆 ✅
```

---

**三個陷阱**

### 陷阱 1：`updated_at` 會變 → 資料可能重複出現

```
T1  同步到 cursor = (06:14:02, ord_A)
T2  訂單 ord_X（updated_at = 06:10:00，已經同步過了）被客服修改
    → updated_at 變成 06:20:00
T3  廠商繼續同步 → ord_X 又出現了（因為 06:20 > 06:14）
```

**這在增量同步場景是「正確的行為」**（更新過的資料要重新同步），
但廠商端**必須用 upsert 而不是 insert**：

```sql
-- 廠商端
INSERT INTO vendor_orders (order_id, status, ...) VALUES (?, ?, ...)
ON DUPLICATE KEY UPDATE status = VALUES(status), ...;
```

**要在 API 文件裡明確警告**：

```yaml
description: |
  ⚠️ 增量同步的重要注意事項：
  1. 本端點可能「重複」回傳同一筆訂單（訂單被更新時 updatedAt 會變）。
     消費端必須以 orderId 做 **upsert**，不可用 insert。
  2. 本端點保證「不漏」（at-least-once），不保證「不重複」（not exactly-once）。
  3. 訂單的處理必須是**冪等**的。
```

**這是分散式系統的標準語意：at-least-once delivery。**

### 陷阱 2：🔴 同一毫秒的寫入會漏 —— `safeWatermark` 的必要性

**這是最嚴重、最難發現的陷阱。**

```
T=06:14:55.000  交易 A 開始：UPDATE orders SET updated_at='06:14:55.000' WHERE id='ord_X'
                （尚未 COMMIT）
T=06:14:55.010  交易 B 開始並 COMMIT：ord_Y 的 updated_at = '06:14:55.005'
T=06:15:00.000  廠商同步：WHERE updated_at >= '06:00:00'
                → 看到 ord_Y（已 commit）
                → 🔴 看不到 ord_X（還沒 commit）
                → 廠商把 watermark 存成 '06:14:55.005'（最後一筆的 updated_at）
T=06:15:00.100  交易 A COMMIT → ord_X 現在可見，updated_at = '06:14:55.000'
T=06:30:00.000  下一輪同步：WHERE updated_at >= '06:14:55.005'
                → 🔴 ord_X 的 updated_at 是 '06:14:55.000' < '06:14:55.005'
                → ord_X 永遠不會被同步！
```

**根因**：`updated_at` 是在**交易開始時**（或 SQL 執行時）決定的，
但資料是在**交易提交時**才可見。**兩者之間有時間差。**

**解法：`safeWatermark` —— 留一個安全邊界**

```java
public SyncMeta buildSyncMeta() {
    Instant now = clock.instant();
    // ★ 保守地往回退，確保所有「可能還沒 commit」的交易都已經完成
    Instant safeWatermark = now.minusSeconds(MAX_TRANSACTION_DURATION_SECONDS);
    return new SyncMeta(now, safeWatermark);
}
```

`MAX_TRANSACTION_DURATION_SECONDS` 要設成**大於你系統最長交易的時間**。
如果你的交易超時設 3 秒，那設 5～10 秒。

**廠商端的規則**：

```
❌ 用「最後一筆的 updatedAt」當下次的 updatedFrom
✅ 用回應裡的 safeWatermark 當下次的 updatedFrom
```

**代價**：每次同步會**重複拉取**最後 5～10 秒的資料。
→ 這就是為什麼陷阱 1 的 upsert 是必要的（兩個陷阱的解法互相支援）。

**更嚴謹的替代方案**（如果 `safeWatermark` 的重複量太大）：

| 方案 | 說明 |
|---|---|
| **用單調遞增的序號**（`change_seq BIGINT AUTO_INCREMENT`） | ⚠️ AUTO_INCREMENT **也有同樣的問題**（序號在交易開始時取得，commit 後才可見） |
| **CDC（讀 binlog）** | ★ 最正確 —— binlog 的順序**就是** commit 的順序，不存在這個問題 |
| **outbox 模式** | 在同一個交易裡寫一筆 `order_change_events`，同步時讀那張表 ✅ 有交易保證 |

**shop-service 的決定**：先用 `safeWatermark`（成本低、夠用），
如果廠商反映重複量太大，再升級到 outbox 模式。

### 陷阱 3：cursor 過期與 `updatedFrom` 的關係

```
廠商中斷 3 天後，拿著 3 天前的 cursor 重新開始
→ cursor 的 filterHash 包含 updatedFrom=2026-08-16T...
→ 廠商這次送的 updatedFrom=2026-08-19T...（他自己算的）
→ filterHash 不符 → 400 CURSOR_QUERY_MISMATCH ✅ 正確拒絕
```

**這是 `filterHash` 發揮作用的地方**（5.4.3）：
它防止「舊 cursor + 新篩選條件」的組合產生無聲的錯誤結果。

**但要給廠商清楚的恢復指引**：

```jsonc
{
  "type": "https://api.shop.example/problems/cursor-query-mismatch",
  "title": "分頁游標與查詢條件不符",
  "status": 400,
  "code": "CURSOR_QUERY_MISMATCH",
  "detail": "The cursor was created with a different updatedFrom value.",
  "userMessage": "查詢條件已變更，請從第一頁重新開始。",
  "hint": "同步中斷後恢復，請丟棄舊 cursor，用您上次成功儲存的 safeWatermark 當作 updatedFrom 重新開始（不帶 cursor 參數）。",
  "traceId": "..."
}
```

**`hint` 這一句話會省掉一封來回三天的 email。**

---

**完整的設計檢核**

```
□ cursor 包含 (updatedAt, id) 複合鍵 —— 有唯一 tie-breaker（5.4.2）
□ cursor 包含 sortSpec + filterHash（含 vendorId）—— 防錯用（5.4.3）
□ 權限（vendor_id）來自 token，不來自 cursor 或參數
□ 索引 (vendor_id, updated_at, id) —— 順序正確
□ EXPLAIN 確認掃描列數 = limit + 1
□ limit 上限 500，超過回 400
□ hasMore 用「多取一筆」判斷，不用 COUNT
□ 不提供 totalElements（廠商不需要）
□ 提供 safeWatermark —— 解決陷阱 2 🔴
□ 文件明確標示 at-least-once 語意，要求 upsert —— 解決陷阱 1
□ CURSOR_QUERY_MISMATCH 的 hint 給出恢復步驟 —— 解決陷阱 3
□ Cache-Control: private, no-store
□ 針對廠商 API key 的限流（每分鐘 20 次，足夠 15 分鐘同步一次 + 分頁）
□ 監控：每家廠商的「最後成功同步時間」—— 超過 1 小時沒同步就告警
```

**最後一項很重要**：廠商的同步壞掉時，**你要比廠商先知道**。
「廠商三天沒同步」通常是廠商那邊出問題，但等他發現時已經對不上帳了。

</details>

### 練習 4：`totalElements` 的取捨

管理後台的訂單列表頁面，需求：

- 表格有頁碼元件（1 2 3 … 最後一頁）。
- 上方要顯示「共 N 筆」和四個統計卡片（總金額、平均客單價、已付款筆數、待出貨筆數）。
- 訂單表有 320 萬筆。
- 常用篩選：狀態、日期範圍、客戶。
- 產品經理說「載入時間不能超過 1 秒」。

設計方案。說明每個決定的取捨。

<details>
<summary>參考解答</summary>

**先量測，再設計**

```sql
-- 假設篩選：status='PAID' AND created_at IN [2026-08-01, 2026-09-01)
-- 符合的資料約 18 萬筆

-- ① 主查詢（20 筆）
SELECT id, order_number, status, total_amount, created_at, recipient_name
FROM orders
WHERE status='PAID' AND created_at >= ? AND created_at < ?
ORDER BY created_at DESC, id DESC
LIMIT 20;
-- 走 idx_orders_status_created → 掃 20 筆 → 約 6 ms ✅

-- ② 精確 count
SELECT COUNT(*) FROM orders
WHERE status='PAID' AND created_at >= ? AND created_at < ?;
-- 走同一個索引，但要掃 180,000 筆索引項 → 約 180 ms ⚠️

-- ③ 統計卡片
SELECT SUM(total_amount), AVG(total_amount), COUNT(*)
FROM orders
WHERE status='PAID' AND created_at >= ? AND created_at < ?;
-- 🔴 需要 total_amount → 索引 idx_orders_status_created 不含這個欄位
--    → 180,000 次回表 → 約 2,400 ms 🔴

-- ④ 待出貨筆數（不同的 status 條件！）
SELECT COUNT(*) FROM orders
WHERE status='PAID' AND created_at >= ? AND created_at < ?
  AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.order_id = orders.id);
-- 🔴 相關子查詢 180,000 次 → 約 4,000 ms 🔴🔴
```

**總計：6 + 180 + 2400 + 4000 = 6,586 ms。遠超 1 秒。**

**瓶頸排序**：④ 待出貨（61%）> ③ 統計（36%）> ② count（3%）> ① 主查詢（0.1%）

**注意：主查詢只佔 0.1%。** 「列表很慢」的原因幾乎全在 count 和統計上。

---

**方案設計：把四件事拆開，各自最佳化**

### 決定 1：主查詢與統計**分離成兩個請求**

```http
# 請求 1：列表（快，優先渲染）
GET /orders?status=PAID&createdFrom=2026-08-01&createdTo=2026-08-31&page=0&size=20
→ 6 ms

# 請求 2：統計（慢，非阻塞，前端顯示骨架屏後再填入）
GET /orders/statistics?status=PAID&createdFrom=2026-08-01&createdTo=2026-08-31
→ 可以慢，因為不阻塞列表渲染
```

**取捨**：

| 好處 | 代價 |
|---|---|
| ✅ 列表 6ms 就渲染出來，使用者立刻看到資料 | ⚠️ 兩個請求（但可以並行發） |
| ✅ 統計慢也不影響列表 | ⚠️ 篩選條件要在兩邊保持同步（前端要小心） |
| ✅ 可以分別快取（列表 no-store、統計 60s） | ⚠️ 多一支端點要維護 |
| ✅ 統計可以獨立限流（5.11.5） | — |

**為什麼不用 `?include=aggregates`（第 03 章 3.11.2）**：
因為那樣統計會**阻塞**列表的回應 —— 使用者要等 6.5 秒才看到任何東西。
**「慢的東西要拆出去」比「一次拿全部」重要。**

### 決定 2：count 用上限計數（cap 10,000）

```sql
SELECT COUNT(*) FROM (
    SELECT 1 FROM orders
    WHERE status='PAID' AND created_at >= ? AND created_at < ?
    LIMIT 10001
) t;
-- 最多掃 10,001 筆 → 約 12 ms ✅（原本 180 ms）
```

```jsonc
{
  "page": {
    "mode": "OFFSET",
    "number": 0,
    "size": 20,
    "totalElements": 10000,
    "totalElementsRelation": "GREATER_THAN_OR_EQUAL",
    "totalPages": 500,
    "totalPagesRelation": "GREATER_THAN_OR_EQUAL",
    "maxAccessibleElements": 10000
  }
}
```

前端顯示：**「共 10,000+ 筆，顯示前 500 頁」**

**取捨**：

| 好處 | 代價 |
|---|---|
| ✅ 180ms → 12ms，而且**恆定**（不管表多大） | ⚠️ 使用者看不到精確總數 |
| ✅ 和深分頁上限（10,000）**天然一致** —— 反正你也翻不到第 501 頁 | ⚠️ 頁碼元件要能顯示「500+」 |

**「和深分頁上限一致」是這個方案最漂亮的地方**：
既然使用者最多只能翻到第 500 頁，那告訴他「總共有 18 萬筆」有什麼意義？
**上限計數不是妥協，是和分頁能力對齊。**

**如果使用者真的要精確總數**：

```http
GET /orders?...&include=totalCount
→ 精確 COUNT，但有 3 秒超時 + 獨立限流（每分鐘 30 次）
→ 超時則回 200 + warnings（5.6.3）
```

### 決定 3：統計端點用「預先聚合」

**問題**：③ 和 ④ 慢的根因是「要對 18 萬筆做聚合」。

**解法：建立每日聚合表**

```sql
CREATE TABLE order_daily_stats (
    business_date  DATE         NOT NULL,
    status         VARCHAR(32)  NOT NULL,
    order_count    INT          NOT NULL,
    total_amount   DECIMAL(19,4) NOT NULL,
    unshipped_count INT         NOT NULL,
    updated_at     DATETIME(3)  NOT NULL,
    PRIMARY KEY (business_date, status)
) ENGINE=InnoDB;

-- 由排程每 5 分鐘更新「今天」，每天凌晨更新「昨天」（02-spring-boot 第 06 章）
```

```sql
-- 統計查詢變成
SELECT SUM(order_count), SUM(total_amount), SUM(unshipped_count)
FROM order_daily_stats
WHERE status = 'PAID'
  AND business_date >= '2026-08-01' AND business_date < '2026-09-01';
-- 掃 31 筆 → 約 2 ms ✅✅（原本 6,400 ms）
```

**取捨**：

| 好處 | 代價 |
|---|---|
| ✅ 6,400ms → 2ms（**3200 倍**） | 🔴 資料有延遲（最多 5 分鐘） |
| ✅ 成本和資料量無關（一天一列） | ⚠️ 要維護聚合表（排程、失敗重跑、補資料） |
| ✅ 可以支援更多維度的統計 | ⚠️ 篩選維度必須**預先決定**（不能任意組合） |
| — | 🔴 **無法支援 `customerId` 篩選**（除非把 customer 也加進聚合的維度 → 列數爆炸） |

**最後一項是關鍵限制。** 所以要分兩種情況：

```java
public OrderStatistics statistics(OrderFilter f) {
    if (f.canUsePreAggregated()) {          // 只有 status + 日期範圍
        return fromDailyStats(f);           // 2 ms
    }
    // 有 customerId 等細粒度條件 → 即時算，但結果集通常很小
    return computeRealtime(f);              // 單一客戶通常 < 100 筆 → 快
}
```

**這個分派很合理**：
- 「全站統計」→ 維度粗、資料量大 → 預聚合。
- 「單一客戶統計」→ 維度細、資料量小 → 即時算也很快。

**回應要標示資料的新鮮度**：

```jsonc
{
  "filters": { "status": ["PAID"], "createdFrom": "2026-08-01", "createdTo": "2026-08-31" },
  "orderCount": 182451,
  "totalAmount": "234891250.00",
  "averageOrderValue": "1287.15",
  "unshippedCount": 3421,
  "currency": "TWD",
  "dataFreshness": {
    "source": "PRE_AGGREGATED",
    "asOf": "2026-08-19T06:10:00Z",
    "maxStalenessSeconds": 300
  }
}
```

**`dataFreshness` 是很重要的誠實聲明**：
使用者看到「已付款 182,451 筆」但列表顯示「10,000+ 筆」時會困惑 ——
有了 `asOf` 和 `source`，前端可以顯示「統計資料更新於 14:10」。

### 決定 4：加上必要的索引

```sql
-- ③ 的問題是 total_amount 不在索引裡 → 覆蓋索引
CREATE INDEX idx_orders_status_created_amount
    ON orders (status, created_at DESC, id DESC, total_amount);
--                                              ↑ 加上這個欄位 → 不用回表

-- ④ 的問題是相關子查詢 → 反正規化一個旗標
ALTER TABLE orders ADD COLUMN is_fully_shipped TINYINT(1) NOT NULL DEFAULT 0;
CREATE INDEX idx_orders_status_shipped_created
    ON orders (status, is_fully_shipped, created_at DESC, id DESC);
-- 由出貨流程維護這個旗標（在同一個交易裡更新）
```

**「反正規化 `is_fully_shipped`」的取捨**：

| 好處 | 代價 |
|---|---|
| ✅ ④ 從相關子查詢變成索引欄位 → 4000ms → 幾 ms | ⚠️ 要在出貨／取消出貨時維護（漏了就不一致） |
| ✅ 也能當篩選條件（`?hasShipment=false`，5.8.5） | ⚠️ 需要一次性的資料回填（migration） |
| — | ⚠️ 需要對帳機制（定期檢查旗標和實際 shipments 是否一致） |

**「需要對帳機制」不是可選的** —— 任何反正規化的欄位都會漂移，
要有一個排程定期比對並修正（02-spring-boot 第 06 章）。

---

**最終方案總結**

| 項目 | 原本 | 改後 | 手法 |
|---|---|---|---|
| ① 主查詢 | 6 ms | 6 ms | — |
| ② count | 180 ms | **12 ms** | 上限計數（cap 10,000） |
| **列表端點總計** | **186 ms** | **18 ms** | ✅ 遠低於 1 秒 |
| ③ 金額統計 | 2,400 ms | **2 ms** | 預聚合表 + 覆蓋索引 |
| ④ 待出貨統計 | 4,000 ms | **2 ms** | 預聚合表 + 反正規化旗標 |
| **統計端點總計** | **6,400 ms** | **4 ms** | ✅ 而且可快取 60s |
| 前端感知的載入時間 | 6,586 ms | **18 ms**（列表先出來） | 拆成兩個並行請求 |

**達成 1 秒目標，而且有 50 倍的餘裕。**

**⚠️ 但要誠實列出付出的代價**：

| 代價 | 說明 |
|---|---|
| 總筆數變成「10,000+」 | 使用者看不到精確數字（除非帶 `include=totalCount`） |
| 統計資料延遲最多 5 分鐘 | 要在 UI 上標示 `asOf` |
| 多一張聚合表 | 排程、失敗處理、補資料、監控 |
| 多一個反正規化欄位 | 維護 + 對帳機制 |
| 多一支端點 | 文件、測試、權限、限流 |
| 前端要處理兩個非同步請求 | 骨架屏、錯誤處理（統計失敗不該讓列表也失敗） |

**這一題的核心教訓**：

> **「列表端點很慢」幾乎從來不是主查詢的問題。**
> 先量測每一段的耗時，你會發現 99% 的時間花在
> 「使用者只瞄一眼的總筆數」和「不阻塞也沒關係的統計」上。
>
> **最有效的最佳化往往是「把慢的東西拆出去」和「降低精確度的要求」，
> 而不是「把慢的查詢調快」。**

</details>

### 練習 5：設計搜尋端點

為客服後台設計「訂單搜尋」。需求：

- 客服拿到的資訊很雜：可能是訂單編號、可能是姓名、可能是電話後 4 碼、
  可能是 Email、可能是物流單號、可能是發票號碼。
- 客服希望「貼上什麼都能找到」。
- 300 萬筆訂單，回應要在 500ms 內。
- 一定要有權限控管（客服只能看自己負責的區域，用 `regionId` 區分）。

<details>
<summary>參考解答</summary>

**設計原則：不要做「全文搜尋」，要做「智慧分派」**

客服輸入的每一種都是**結構化的識別碼**，不是自然語言。
所以正確的做法是**辨識輸入格式，走專用的索引**。

**API 契約**

```http
GET /orders?q=0912345678&limit=20
Authorization: Bearer <SUPPORT token>
```

```jsonc
{
  "items": [ /* 最多 20 筆 */ ],
  "page": { "mode": "OFFSET", "number": 0, "size": 20,
            "totalElements": 3, "hasMore": false },
  "searchMeta": {
    "query": "0912345678",
    "detectedType": "PHONE_FULL",              // ★ 告訴客服「我用什麼方式找的」
    "matchedField": "recipientPhone",
    "strategy": "EXACT_INDEX",
    "tookMs": 8,
    "alternativeSearches": [                    // ★ 找不到時的替代建議
      { "label": "改用客戶電話搜尋", "url": "/orders?customerPhone=0912345678" }
    ]
  }
}
```

**`detectedType` 是很重要的 UX 欄位**：
客服貼了 `0912345678` 但找不到訂單時，他需要知道
「系統把這個當成**收件人電話**在找」—— 也許他要找的是**下單人電話**（可能不同）。

**輸入格式辨識**

```java
public enum QueryType {
    ORDER_NUMBER_FULL   ("^ORD-\\d{8}-\\d{4}$",       Strategy.EXACT_UNIQUE),
    ORDER_NUMBER_PREFIX ("^ORD-\\d{4,8}",             Strategy.PREFIX_INDEX),
    ORDER_NUMBER_DATE   ("^\\d{8}$",                  Strategy.PREFIX_INDEX),   // 20260819
    RMA_NUMBER          ("^RMA-\\d{8}-\\d{4}$",       Strategy.JOIN_RETURNS),
    INVOICE_NUMBER      ("^[A-Z]{2}-?\\d{8}$",        Strategy.JOIN_INVOICES),
    TRACKING_NUMBER     ("^[A-Z0-9]{10,20}$",         Strategy.JOIN_SHIPMENTS),
    PHONE_FULL          ("^09\\d{8}$",                Strategy.EXACT_INDEX),
    PHONE_SUFFIX        ("^\\d{3,7}$",                Strategy.REVERSED_PREFIX),
    EMAIL               ("^[^@\\s]+@[^@\\s]+$",       Strategy.EXACT_INDEX),
    EMAIL_PREFIX        ("^[^@\\s]{2,}@$",            Strategy.PREFIX_INDEX),
    CUSTOMER_ID         ("^cus_[0-9A-Z]{26}$",        Strategy.EXACT_INDEX),
    ORDER_ID            ("^ord_[0-9A-Z]{26}$",        Strategy.EXACT_UNIQUE),
    RECIPIENT_NAME      (".*",                        Strategy.NAME_INDEX);      // fallback

    private final Pattern pattern;
    private final Strategy strategy;

    public static QueryType detect(String q) {
        String normalized = q.trim();
        return Arrays.stream(values())
                .filter(t -> t.pattern.matcher(normalized).matches()
                          || t.pattern.matcher(normalized).lookingAt())
                .findFirst()
                .orElse(RECIPIENT_NAME);
    }
}
```

**每種策略的 SQL 與索引**

```sql
-- ① ORDER_NUMBER_FULL → 唯一索引，最快
SELECT ... FROM orders
WHERE region_id IN (?, ?, ?)                    -- ★ 權限，來自 token
  AND order_number = ?
LIMIT 1;
-- uk_orders_order_number → 約 1 ms

-- ② ORDER_NUMBER_PREFIX / ORDER_NUMBER_DATE → 前綴，走索引
SELECT ... FROM orders
WHERE region_id IN (?, ?, ?)
  AND order_number LIKE CONCAT(?, '%')          -- 'ORD-20260819%'
ORDER BY created_at DESC, id DESC
LIMIT 21;
-- idx_orders_region_number (region_id, order_number) → 約 5 ms

-- ③ PHONE_FULL → 精確
SELECT ... FROM orders
WHERE region_id IN (?, ?, ?)
  AND recipient_phone = ?
ORDER BY created_at DESC, id DESC
LIMIT 21;
-- idx_orders_region_phone (region_id, recipient_phone, created_at) → 約 3 ms

-- ④ PHONE_SUFFIX → 反轉欄位 + 前綴（5.10.3）
ALTER TABLE orders
  ADD COLUMN recipient_phone_rev VARCHAR(20)
    GENERATED ALWAYS AS (REVERSE(recipient_phone)) STORED,
  ADD INDEX idx_orders_region_phone_rev (region_id, recipient_phone_rev, created_at);

SELECT ... FROM orders
WHERE region_id IN (?, ?, ?)
  AND recipient_phone_rev LIKE CONCAT(REVERSE(?), '%')     -- '2345678' → '8765432%'
ORDER BY created_at DESC, id DESC
LIMIT 21;
-- 約 8 ms ✅（原本 LIKE '%2345678' 是全表掃描，約 4000 ms）

-- ⑤ EMAIL → 精確
-- idx_orders_region_email (region_id, customer_email, created_at) → 約 3 ms

-- ⑥ TRACKING_NUMBER → 反查 shipments
SELECT o.... FROM orders o
JOIN shipments s ON s.order_id = o.id
WHERE o.region_id IN (?, ?, ?)
  AND s.tracking_number = ?
LIMIT 21;
-- shipments.uk_tracking_number → 約 4 ms

-- ⑦ INVOICE_NUMBER → 反查 invoices
-- invoices.uk_invoice_number → 約 4 ms

-- ⑧ RECIPIENT_NAME → 姓名索引（fallback）
SELECT ... FROM orders
WHERE region_id IN (?, ?, ?)
  AND recipient_name = ?                        -- ★ 精確匹配，不是 LIKE
ORDER BY created_at DESC, id DESC
LIMIT 21;
-- idx_orders_region_name (region_id, recipient_name, created_at) → 約 6 ms
```

**⑧ 為什麼用精確匹配而不是 `LIKE '%王小明%'`**：

| | `= '王小明'` | `LIKE '%王小明%'` |
|---|---|---|
| 索引 | ✅ 走索引 | 🔴 全表掃描 300 萬筆 |
| 耗時 | 6 ms | 約 4,000 ms |
| 找到「王小明明」 | ❌ | ✅ |

**取捨**：客服搜姓名時，通常是**完整姓名**（從電話裡問到的）。
「找不到就請客服確認姓名」比「每次搜尋等 4 秒」好。

**如果真的需要姓名的模糊匹配**，用前綴：

```sql
AND recipient_name LIKE CONCAT(?, '%')          -- '王%' → 走索引 ✅
```

這覆蓋了「只記得姓」的情況，而且仍然走索引。

**回應「找不到」時要給替代方案**

```jsonc
{
  "items": [],
  "page": { "mode": "OFFSET", "number": 0, "size": 20, "totalElements": 0, "hasMore": false },
  "searchMeta": {
    "query": "王小明",
    "detectedType": "RECIPIENT_NAME",
    "matchedField": "recipientName",
    "strategy": "NAME_INDEX",
    "tookMs": 6,
    "alternativeSearches": [
      { "label": "改用姓名開頭搜尋（王…）",
        "url": "/orders?recipientNamePrefix=王&limit=20" },
      { "label": "改搜下單人姓名（而非收件人）",
        "url": "/orders?customerName=王小明&limit=20" },
      { "label": "跨區域搜尋（需主管權限）",
        "url": "/orders?q=王小明&allRegions=true&limit=20",
        "requiresRole": "SUPPORT_MANAGER" }
    ],
    "hint": "找不到符合的訂單。可能是收件人姓名與下單人不同，或訂單不在您負責的區域。"
  }
}
```

**這個「找不到時的引導」是客服工具最有價值的部分** ——
它把「找不到」從死路變成三個下一步。

**權限設計（關鍵）**

```java
// ★ region 範圍永遠來自 token，且在查詢條件裡（第 01 章 1.4.1）
List<String> allowedRegions = auth.getRegionIds();

// 主管可以跨區搜尋，但要明確要求
if (Boolean.TRUE.equals(filter.allRegions())) {
    if (!hasRole(auth, "SUPPORT_MANAGER")) {
        throw new ForbiddenParameterException("allRegions", "SUPPORT_MANAGER");   // → 403
    }
    allowedRegions = null;      // 不限制
}
```

**⚠️ 一個容易漏掉的資安問題：搜尋的「筆數」本身就是資訊洩漏（5.8.7）**

```
客服 A 只負責北區。他搜 0912345678：
  → 回 0 筆
客服 A 改用 ?allRegions=true：
  → 403（沒有主管權限）✅ 正確

但如果 allRegions 是「靜默忽略」：
  → 回 0 筆
  → 客服無法區分「這個人沒下過單」和「他在別的區域下過單」
  → ⚠️ 這其實是「好的」—— 不洩漏跨區資訊
```

**所以這裡的設計是刻意的**：跨區搜尋必須明確要求且有權限，
而不是「搜尋範圍自動擴大」。

**效能總結**

| 輸入類型 | 策略 | 耗時 |
|---|---|---|
| 完整訂單編號 | 唯一索引 | 1 ms |
| 訂單編號前綴／日期 | 前綴索引 | 5 ms |
| 完整手機 | 精確索引 | 3 ms |
| 手機後幾碼 | **反轉欄位 + 前綴** | 8 ms |
| Email | 精確索引 | 3 ms |
| 物流單號 | join + 唯一索引 | 4 ms |
| 發票號碼 | join + 唯一索引 | 4 ms |
| 收件人姓名 | 精確索引 | 6 ms |

**全部在 10ms 內，遠低於 500ms 目標。**

**⚠️ 而如果用「一個 OR 查詢打天下」**：

```sql
-- 🔴 不要這樣做
WHERE region_id IN (?, ?, ?)
  AND (order_number LIKE CONCAT('%', ?, '%')
    OR recipient_name LIKE CONCAT('%', ?, '%')
    OR recipient_phone LIKE CONCAT('%', ?, '%')
    OR customer_email LIKE CONCAT('%', ?, '%'))
```

MySQL 面對這種 `OR` + 前後通配符，幾乎一定會選**全表掃描**
（index merge 對 `LIKE '%x%'` 完全無效）→ 掃 300 萬筆 → **約 8 秒**。

**「智慧分派」和「一個 OR 打天下」的差距是 800 倍。**

**需要的索引清單**

```sql
UNIQUE KEY uk_orders_order_number     (order_number)
KEY idx_orders_region_number          (region_id, order_number)
KEY idx_orders_region_phone           (region_id, recipient_phone, created_at DESC, id DESC)
KEY idx_orders_region_phone_rev       (region_id, recipient_phone_rev, created_at DESC, id DESC)
KEY idx_orders_region_email           (region_id, customer_email, created_at DESC, id DESC)
KEY idx_orders_region_name            (region_id, recipient_name, created_at DESC, id DESC)
-- shipments
UNIQUE KEY uk_shipments_tracking      (tracking_number)
KEY idx_shipments_order               (order_id)
-- invoices
UNIQUE KEY uk_invoices_number         (invoice_number)
```

**8 個索引。代價要誠實列出**：

| 代價 | 說明 |
|---|---|
| 磁碟空間 | 訂單表的索引可能是資料的 1.5 倍 |
| 寫入變慢 | 每筆訂單建立要更新 8 個 B+Tree（實測 P99 可能增加 10～20%） |
| `recipient_phone_rev` 是 STORED generated column | 佔額外空間；MySQL 8.0 才支援 |
| buffer pool 壓力 | 8 個索引都要記憶體 |

**但這是值得的**：客服搜尋是每天幾千次的高頻操作，
從 8 秒變 10ms 直接影響客服的工作效率和客戶的等待時間。

**這一題的核心教訓**：

> **「使用者希望貼上什麼都能找到」不代表你要做全文搜尋。**
> 先看使用者實際會貼什麼 —— 如果都是**結構化的識別碼**，
> 那正確的答案是「辨識格式 + 走專用索引」，而不是「一個 `LIKE '%x%'` 打天下」。
>
> **搜尋設計的第一步是「觀察使用者實際輸入什麼」，不是「選一個搜尋引擎」。**

</details>

---

## 5.16 驗收清單

- [ ] 我能說出「沒有分頁上限」在資料庫、連線池、JVM、序列化、網路五個層面的具體後果。
- [ ] 我知道預設值、上限、最小值是三件不同的事，缺任何一個都沒有保護。
- [ ] 我知道「靜默夾到上限」會讓客戶端的「不足一頁 = 結束」判斷靜默失敗，所以要回 `400`。
- [ ] 我會在錯誤回應裡加 `hint` 引導到正確的工具（cursor／匯出）。
- [ ] 我能解釋 `OFFSET 400000` 為什麼必須讀取並丟棄 40 萬筆，也知道 deferred join 只能減輕不能解決。
- [ ] 我知道 0-based / 1-based 是永不能改的決定，也能說出改它造成的對帳災難。
- [ ] 我知道深分頁上限是業界標準（GitHub 1000、ES 10000、Google 400），不是偷懶。
- [ ] 我能重現「資料漂移」造成的重複與漏資料，並知道 `asOf` 凍結是低成本的緩解。
- [ ] 我知道 offset 分頁在「要跳頁」「要總頁數」「資料量小」時仍是正確選擇。
- [ ] 我能實作 cursor 分頁，並解釋它為什麼是 O(1)。
- [ ] 我知道 cursor **必須**用「排序欄位 + 唯一 tie-breaker」的複合鍵，也能說出只用單欄位會漏 50 筆的情境。
- [ ] 我知道 cursor 要放 `sortSpec` 與 `filterHash`，也能說出不放會產生什麼靜默錯誤。
- [ ] 我知道 cursor 要嚴格驗證長度與字元集，不放敏感資訊，且 base64 不是加密。
- [ ] 我知道 `hasMore` 要用「多取一筆」實作，不用 `COUNT`。
- [ ] 我知道雙向 cursor 分頁的 `before` 要 `reverse()`，這是最常見的 bug。
- [ ] 我知道 cursor 分頁的四個限制，也知道「cursor 指向的資料被刪除」其實不會壞。
- [ ] 我知道用 `updatedAt` 當 cursor 排序鍵會讓更新過的資料「跳」到後面。
- [ ] 我能設計「同一支端點同時支援兩種分頁」，並用 `mode` 欄位當 discriminator。
- [ ] 我能解釋 InnoDB 的 `COUNT(*)` 為什麼是 O(n)（MVCC），也知道 `SQL_CALC_FOUND_ROWS` 已 deprecated。
- [ ] 我知道 count 可能佔總耗時 98%，也能列出四種折衷（`hasMore`／上限計數／快取／選加）。
- [ ] 我知道上限計數要回 `totalElementsRelation`，否則前端會把下限當精確值。
- [ ] 我知道 count 的快取鍵**必須**包含權限範圍。
- [ ] 我知道 `Link` header 的最大坑是 CORS `Expose-Headers`，也知道 body + header 兩者都給幾乎沒成本。
- [ ] 我知道 `links.next` 讓客戶端「跟著連結走」是 HATEOAS 最實用的應用。
- [ ] 我能設計五種篩選型別，並說出 `createdFrom/To` 為什麼比 `startDate/endDate` 好。
- [ ] 我知道 `?createdTo=2026-08-31` 必須包含 8/31 整天，也知道統一用 `[from, to)` 半開區間的三個好處。
- [ ] 我知道純日期的時區是「營業時區」不是 UTC。
- [ ] 我知道多值篩選的兩種語法，也知道 Spring 會把 `%2C` 也拆開（值含逗號時要用 `String[]`）。
- [ ] 我知道布林篩選必須用 `Boolean` 而不是 `boolean`，也知道資料庫欄位該 `NOT NULL DEFAULT`。
- [ ] 我知道用 `has<欄位>=false` 比 `?field=null` 好。
- [ ] 我知道「靜默忽略未知參數」會造成客服對未付款訂單出貨、廠商同步錯一年。
- [ ] 我知道嚴格模式要漸進導入（先記錄兩週 → 通知 → 開啟），並有緊急關閉開關。
- [ ] 我能說出查詢 DSL 的三個風險，特別是「用篩選筆數逐字元猜出身分證號」。
- [ ] 我知道 `ORDER BY` 的欄位名**不能**用參數綁定，只能用白名單。
- [ ] 我知道允許排序 `cost` 等於洩漏成本排名，即使回應裡沒有這個欄位。
- [ ] 我知道排序必須有唯一 tie-breaker，也知道少了它的 bug 是非 deterministic 的。
- [ ] 我知道 `Using filesort` 的成本，也知道每個開放的排序欄位都需要對應的索引。
- [ ] 我知道「排序需求」常常是在提醒你「這個欄位該反正規化」。
- [ ] 我能區分搜尋與篩選，也知道 `LIKE '%x%'` 的四個問題（含 `%`/`_` 要轉義）。
- [ ] 我知道 MySQL 全文索引搜中文**必須**用 `WITH PARSER ngram`，也知道 `ngram_token_size` 的取捨。
- [ ] 我知道引入 Elasticsearch 的隱藏成本是「資料同步」，也知道四種同步方式的取捨。
- [ ] 我知道「後綴搜尋」可以用反轉欄位轉成「前綴搜尋」。
- [ ] 我知道相關度排序不能當 cursor 的排序鍵，所以搜尋只能用 offset + 硬上限。
- [ ] 我知道搜尋要回 `maxAccessibleElements`，避免使用者翻到第 51 頁才撞牆。
- [ ] 我能設計五層效能防護，並知道上限值要放在設定檔以便緊急收緊。
- [ ] 我知道 `Pageable` 的三個坑（靜默夾取、`sort` 無白名單、`Page<T>` 自動 count）。
- [ ] 我知道要在 `HandlerInterceptor.preHandle` 讀原始參數驗證（在 `Pageable` 綁定之前）。
- [ ] 我知道 Spring Data 3.1 的 `Window`/`ScrollPosition` 幫我做什麼、不幫我做什麼。
- [ ] 我知道 `Specification` 的 count query 不能帶 fetch join。
- [ ] 我完成了 shop-service 的分頁／篩選／排序完整規格、索引清單與 9 個新錯誤碼。

---

完成後請前往 [06-versioning-and-compatibility.md](./06-versioning-and-compatibility.md)。
