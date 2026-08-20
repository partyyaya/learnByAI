# 第 01 章：資源建模與 URL 設計

> URL 是你的 API 唯一「所有人都會看到、而且改不掉」的部分。
> 欄位可以加、狀態碼可以修、錯誤格式可以統一，但 URL 一旦被寫進 App、寫進廠商的 ERP、寫進別人的排程腳本，
> 它就變成一份你單方面無法解除的合約。
> 這一章要把 shop-service 的 30 幾條路由**一次定案**，並且把最難的那件事講透：
> **「不是 CRUD 的動作，該怎麼變成名詞？」**

---

## 1.1 學習目標

完成本章後，你應該可以：

- 用「找名詞 → 定生命週期 → 定關係」三步法，把一份需求變成資源清單。
- 說出 URL 命名的十條規則，並在 code review 時一眼看出違規。
- 設計識別碼：說明自增 ID 的三個實際風險，並區分「內部 ID」與「對外編號」。
- 判斷什麼時候該用巢狀資源、什麼時候不該，以及為什麼深度要控制在 2 層。
- 用**五種手法**表達非 CRUD 動作，並用決策流程圖選出該用哪一種。
- 說明路徑參數 / 查詢參數 / Header / Body 各自該放什麼，不再憑感覺。
- 處理單例子資源、`/me` 別名、多租戶、檔案上傳、批次操作。
- 完成 shop-service 的完整 URL 表，並解釋每一條的設計理由。

## 1.2 從領域到資源：三步法

第 00 章 0.6 已經做了「動詞 → 名詞」的翻譯。這一節要把它系統化。

### 1.2.1 步驟 1：找名詞（資源盤點）

三個來源可以挖出資源：

| 來源 | 怎麼挖 | shop-service 的例子 |
|---|---|---|
| **需求文件裡的名詞** | 直接圈出來 | 商品、購物車、訂單、明細、付款、出貨、退貨、客戶、地址、折扣碼 |
| **動詞的產物**（第 00 章 0.6.3 洞察 1） | 「這動作發生後留下什麼紀錄？」 | 付款 → **付款紀錄**；取消 → **取消單**；出貨 → **出貨單**；匯出 → **匯出工作** |
| **UI 畫面上的「一塊東西」** | 每個列表、每張卡片、每個 tab | 訂單列表、訂單摘要卡、物流追蹤時間軸、發票資訊 |

第三個來源要小心使用：**UI 是資源的線索，不是資源的定義。**
如果直接照 UI 設計 API，改版就要改 API（第 00 章 0.4.2 約束 1 的反例）。

正確用法是：UI 幫你**發現**遺漏的資源，但資源的邊界要按**業務語意**畫。

**shop-service 的資源盤點結果**

```
核心實體（有自己的生命週期，可獨立存在）
├── Product        商品
├── Customer       客戶
├── Cart           購物車
├── Order          訂單
├── Coupon         折扣碼
└── Category       商品分類

從屬實體（沒有父就沒有意義）
├── OrderItem      訂單明細   → 屬於 Order
├── CartItem       購物車項目 → 屬於 Cart
├── Address        收件地址   → 屬於 Customer
└── Review         商品評價   → 屬於 Product（也屬於 Customer，見 1.6）

事件／紀錄型資源（動詞的產物）
├── Payment        付款
├── Refund         退款       → 屬於 Payment
├── Shipment       出貨
├── Cancellation   取消單
├── Return         退貨單
└── Notification   通知紀錄

工作型資源（非同步任務）
├── OrderExport            訂單匯出工作
└── ReconciliationJob      對帳工作

值物件（不是資源，是欄位的一部分）
├── Money          金額 + 幣別  → 巢狀在 DTO 裡，不需要自己的 URL
├── Inventory      庫存        → 是 Product 的一個欄位／子資源，不是頂層資源
└── OrderStatus    訂單狀態    → 是欄位，但可能有子資源（見 1.7）
```

**「值物件不是資源」是很重要的區分。**
`Money` 不需要 `/monies/123` 這個端點 —— 沒有人會想單獨查一筆金額。
判準：**這東西有沒有自己的身分（identity）？** 沒有 → 是值物件，當欄位處理。

### 1.2.2 步驟 2：定生命週期

對每個資源問四個問題：

1. **誰建立它？** 客戶？系統？管理員？
2. **它會經過哪些狀態？**（畫狀態機）
3. **它會被刪除嗎？** 硬刪還是軟刪？
4. **它的欄位哪些可改、哪些不可改？**

shop-service 的答案：

| 資源 | 誰建立 | 狀態 | 可刪除？ | 不可改欄位 |
|---|---|---|---|---|
| `Order` | 客戶（結帳）／客服（代客下單） | 7 個狀態（第 00 章 0.10.3） | ❌ 永不刪除（法規：帳務憑證要保留 5 年） | `orderNumber`、`items`（成立後鎖定）、`totalAmount` |
| `OrderItem` | 隨 Order 一起建立 | 無獨立狀態 | ❌ 訂單成立後不可改 | 全部（含 `unitPrice` 快照） |
| `Payment` | 客戶 | `PENDING` → `SUCCEEDED` / `FAILED` | ❌ | 全部（金流紀錄不可改） |
| `Cart` | 系統（首次加購物車時） | `ACTIVE` → `CONVERTED` / `ABANDONED` | ✅ 可清空，30 天後系統自動清理 | — |
| `Product` | 管理員 | `DRAFT` → `ACTIVE` → `DISCONTINUED` | ⚠️ **軟刪除**（已被訂單引用，硬刪會破壞歷史） | `productId` |
| `Address` | 客戶 | 無 | ✅ 軟刪除（訂單引用的是**快照**，不是關聯） | — |
| `OrderExport` | 客戶／財務 | `QUEUED` → `RUNNING` → `SUCCEEDED` / `FAILED` | ✅ 7 天後自動過期 | — |

**這張表直接產生 API 設計決策**：

| 表格內容 | 產生的 API 決策 |
|---|---|
| Order 永不刪除 | ❌ 不提供 `DELETE /orders/{id}`；改用 `POST /orders/{id}/cancellations` |
| OrderItem 成立後不可改 | ❌ 不提供 `PATCH /orders/{id}/items/{itemId}`；要改只能取消重下 |
| Product 軟刪除 | `DELETE /products/{id}` 回 `204`，但 `GET /products/{id}` 之後回 `410 Gone` 而不是 `404` |
| Address 是快照 | 訂單的 `shippingAddress` 是**內嵌物件**，不是 `addressId` 參照（客戶改地址不該改動歷史訂單） |
| OrderItem 有 `unitPrice` 快照 | 商品調價不影響已成立的訂單 |

> ⚠️ **「快照 vs 參照」是新手最常做錯的建模決策。**
> 如果訂單存的是 `addressId`，那客戶編輯地址後，**三年前的訂單收件地址也變了**。
> 出貨紀錄、發票、客訴調閱全部對不上。
> **凡是「當時的事實」都要快照**：收件地址、商品名稱、單價、折扣規則、稅率。

### 1.2.3 步驟 3：定關係

三種關係，對應三種 URL 結構：

| 關係 | 判斷 | URL 結構 | 例子 |
|---|---|---|---|
| **組合（composition）**<br>子沒有父不能存在 | 刪父就要刪子 | 巢狀 | `/orders/{id}/items` |
| **聚合（aggregation）**<br>子可以獨立存在 | 刪父不刪子 | 兩者都是頂層，用查詢參數關聯 | `/reviews?productId=P-1001` |
| **參照（reference）**<br>只是指向另一個資源 | 只存 ID | 欄位裡放 ID 或 URL | `order.customerId` |

**shop-service 的關係圖**

```
Customer ──(1:N 聚合)── Address        /customers/{id}/addresses  ← 巢狀（地址不會獨立查）
Customer ──(1:N 聚合)── Order          /orders?customerId=...     ← 頂層（訂單要跨客戶查）
Customer ──(1:1)────── Cart            /carts/current             ← 單例子資源

Order ──(1:N 組合)──── OrderItem       /orders/{id}/items         ← 巢狀（明細不會獨立查）
Order ──(1:N 聚合)──── Payment         /orders/{id}/payments      ← 巢狀建立
                                       /payments/{id}             ← 也有頂層（財務對帳跨訂單查）
Order ──(1:N 聚合)──── Shipment        /orders/{id}/shipments
                                       /shipments/{id}            ← 倉管要跨訂單查
Order ──(0:N)───────── Cancellation    /orders/{id}/cancellations
Order ──(0:N)───────── Return          /orders/{id}/returns
                                       /returns/{id}              ← 客服要跨訂單查退貨

Payment ──(0:N 組合)── Refund          /payments/{id}/refunds

Product ──(N:1 參照)── Category        product.categoryId
Product ──(1:N 聚合)── Review          /products/{id}/reviews     ← 商品頁用
                                       /reviews?customerId=...    ← 「我的評價」用
```

**注意有幾個資源同時有巢狀路徑和頂層路徑。** 這不是矛盾，是刻意的（見 1.5.4）：

- **巢狀路徑**用於「在父資源的脈絡下操作」：`POST /orders/1001/payments`（對這張訂單付款）
- **頂層路徑**用於「跨父資源查詢」：`GET /payments?status=FAILED&from=2026-08-01`（今天所有失敗的付款）

---

## 1.3 URL 命名的十條規則

### 規則 1：用名詞，不用動詞

```
❌ GET  /getOrders           ✅ GET    /orders
❌ POST /createOrder         ✅ POST   /orders
❌ POST /updateOrder         ✅ PATCH  /orders/1001
❌ POST /deleteOrder         ✅ DELETE /orders/1001
❌ POST /orderSearch         ✅ GET    /orders?q=...
```

**動詞由 HTTP 方法承擔**。URL 只回答「操作什麼」，方法回答「怎麼操作」。

> **唯一例外**：控制器資源（controller resource），見 1.7.3。
> 那是「真的沒有合適名詞」時的逃生門，不是常態。

### 規則 2：集合用複數

```
✅ /orders          /orders/1001
✅ /products        /products/P-1001
❌ /order           /order/1001         ← 單數
❌ /orderList       /orders/list        ← 「List」是多餘的
```

理由不是文法潔癖，而是**一致性讓 URL 可預測**（第 00 章判準 1）。

```
/orders           ← 一群訂單
/orders/1001      ← 這群裡的一個
/orders/1001/items ← 這一個裡面的一群
```

單複數混用的實際代價：前端每次都要查文件「這支是 `/order` 還是 `/orders`」。

**不可數名詞怎麼辦？**

```
✅ /inventory              庫存（不可數，用單數合理）
✅ /products/{id}/stock    某商品的庫存量
✅ /audit-logs             日誌（可數，用複數）
✅ /settings               設定（英文習慣複數）
✅ /health                 健康檢查（狀態，單數）
```

原則：**能複數就複數；不可數或概念性的用單數，但要在 style guide 記下來。**

### 規則 3：全小寫

```
✅ /order-report-exports
❌ /OrderReportExports
❌ /orderReportExports
```

三個理由：

1. **URL 路徑是大小寫敏感的**（RFC 3986）。`/Orders` 和 `/orders` 是兩個不同的資源。
   （只有 host 部分不分大小寫。）
2. 混用大小寫會產生「到底哪個才對」的問題，然後有人兩個都註冊，然後其中一個忘了加權限檢查。
3. 有些代理、CDN、路由器的設定會做大小寫正規化，行為不一致。

### 規則 4：多字用 kebab-case

```
✅ /order-report-exports
✅ /shipping-addresses
✅ /payment-methods
❌ /order_report_exports    ← snake_case 留給 JSON 欄位（如果你用 snake）
❌ /orderreportexports      ← 不可讀
```

一個好記的規則：

| 位置 | 慣例 |
|---|---|
| URL 路徑 | `kebab-case` |
| 查詢參數 | 跟 JSON 欄位一致（本課程用 `camelCase`） |
| JSON 欄位 | 全站一致（本課程用 `camelCase`） |
| Header | `Kebab-Case`（HTTP header 不分大小寫，但慣例首字母大寫） |

> ⚠️ 查詢參數要不要 kebab-case 有爭議。
> 本課程選 `camelCase`（例如 `?createdFrom=`），理由是**它和 JSON 欄位名一致**，
> 前端可以直接 `{ createdFrom: x }` 轉成 query string，不用做名稱轉換。
> 這是一個「一致性 > 慣例」的取捨（第 00 章判準 2）。

### 規則 5：不要副檔名

```
❌ /orders/1001.json
❌ /orders/1001.xml
✅ /orders/1001  +  Accept: application/json
```

格式協商用 `Accept` header（第 03 章 3.12）。
副檔名把「表述格式」混進了「資源識別」—— 同一筆訂單不該有兩個 URI。

> **實務例外**：如果 consumer 是「只能貼 URL 的工具」（Excel 的 Web 查詢、某些 BI 工具），
> 給一個 `?format=csv` 是務實的。但**不要**用副檔名做主要機制。

### 規則 6：不要尾斜線

```
✅ /orders
❌ /orders/
```

`/orders` 和 `/orders/` 技術上是不同 URI。挑一個（建議無尾斜線），然後**另一個 301 導向過去**。

Spring Boot 3 的行為變更（第 02 章 02-spring-boot 09 也有提）：
`spring.mvc.pathmatch.matching-strategy` 預設改為 `PATH_PATTERN_PARSER` 後，
**尾斜線不再自動匹配**，Boot 2 能通的 `/orders/` 在 Boot 3 會 404。這是升版常見的雷。

### 規則 7：URL 裡不放實作細節

```
❌ /api/v1/mysql/orders
❌ /orders?tableName=t_order_2026
❌ /orders/getByIndexIdx01
❌ /OrderServiceImpl/queryOrders
```

URL 是契約，不是你的類別名稱或資料表名稱。
資料表叫 `t_order_master`，API 還是 `/orders`。

### 規則 8：層級要反映真實的從屬關係

```
✅ /orders/1001/items/5        訂單 1001 的第 5 筆明細
❌ /orders/items/1001/5        層級沒有意義
❌ /order/1001/item/5          單數 + 層級混亂
```

讀 URL 就應該讀得出資料結構。

### 規則 9：不要在路徑裡表達篩選

```
❌ /orders/status/paid
❌ /orders/paid
❌ /orders/customer/123
❌ /orders/2026/08

✅ /orders?status=PAID
✅ /orders?customerId=123
✅ /orders?createdFrom=2026-08-01&createdTo=2026-08-31
```

理由：

- 路徑表示**識別**（哪一個資源），查詢參數表示**篩選／變體**（這個集合的哪些成員）。
- 路徑篩選無法組合。`/orders/status/paid` 要再加客戶條件？`/orders/status/paid/customer/123`？
  然後順序反過來也要支援嗎？→ **組合爆炸**（第 00 章 0.3.1 症狀四）。
- 查詢參數天生可組合、可省略、可有預設值。

**判斷法**：如果這個東西可以「不指定」，它是查詢參數；如果不指定就不知道在講哪個資源，它是路徑。

```
/orders/1001            不給 1001 就不知道要哪張訂單 → 路徑 ✅
/orders?status=PAID     不給 status 就是「全部狀態」  → 查詢參數 ✅
```

### 規則 10：URL 是穩定的公開介面 —— 一開始就想清楚

```
一旦上線，這些都改不動了：
  /api/v1/orders          ← v1 前綴要不要？（第 06 章）
  /orders                 ← 還是 /order-service/orders？
  /orders/{orderId}        ← 用內部 ID 還是 orderNumber？（1.4）
  /orders/{id}/items       ← 還是 /order-items?orderId=？
```

**改 URL 的成本 = 通知所有 consumer + 維護新舊兩套 + 等 App 升版（第 00 章 0.8.1）。**

所以本章的工作方式是：**先把整張表列出來，一起 review，再開始寫程式。**

### 1.3.1 ✅ / ❌ 對照大表

拿這張表去掃你們公司的 API：

| ❌ 常見寫法 | ✅ 正確寫法 | 違反的規則 |
|---|---|---|
| `GET /getAllOrders` | `GET /orders` | 1 |
| `POST /order/new` | `POST /orders` | 1, 2 |
| `POST /orders/create` | `POST /orders` | 1 |
| `GET /order/detail?id=1` | `GET /orders/1` | 1, 2, 9 |
| `POST /orders/1/update` | `PATCH /orders/1` | 1 |
| `GET /orders/delete/1` | `DELETE /orders/1` | 1（且用錯方法，危險） |
| `GET /orderList` | `GET /orders` | 1, 2 |
| `GET /orders/list/page/2` | `GET /orders?page=2` | 9 |
| `GET /orders/status/paid` | `GET /orders?status=PAID` | 9 |
| `GET /orders/count` | `GET /orders?size=0`（看 `page.totalElements`）<br>或 `HEAD /orders` 看 `X-Total-Count` | 1（`count` 是動詞化的名詞） |
| `GET /searchOrders?kw=x` | `GET /orders?q=x` | 1 |
| `GET /Orders/1001` | `GET /orders/1001` | 3 |
| `GET /order_items` | `GET /orders/1001/items` | 4, 8 |
| `GET /orders/1001.json` | `GET /orders/1001` + `Accept:` | 5 |
| `GET /orders/` | `GET /orders` | 6 |
| `GET /v1/mysql/orders` | `GET /v1/orders` | 7 |
| `GET /orders/items/1001` | `GET /orders/1001/items` | 8 |
| `POST /order/cancel` | `POST /orders/1001/cancellations` | 1（且 id 不在路徑） |
| `POST /batchDeleteOrders` | `POST /order-deletions`（批次工作）<br>或 `DELETE /orders?ids=1,2,3` | 1（見 1.12） |
| `GET /users/me/profile/get` | `GET /me` | 1 |
| `POST /login` | ⚠️ 見 1.14.10 —— 這個可以接受 | — |

---

## 1.4 識別碼設計

### 1.4.1 自增 ID 的三個實際風險

```
GET /orders/1001
GET /orders/1002
GET /orders/1003
```

**風險 1：IDOR（Insecure Direct Object Reference）**

這是 OWASP API Security Top 10 的**第一名**（API1:2023 Broken Object Level Authorization）。

```bash
# 攻擊者登入自己的帳號，發現自己的訂單是 /orders/1001
# 然後試試看：
for i in $(seq 1000 2000); do
  curl -s -H "Authorization: Bearer $MY_TOKEN" https://api.shop.example/orders/$i
done
# 如果後端只檢查「有登入」而沒檢查「這張訂單是不是你的」→ 全站訂單外洩
```

**要澄清一件重要的事**：**換 UUID 不能修好 IDOR。**
IDOR 的根因是**缺少物件層級的授權檢查**，不是 ID 好不好猜。
UUID 只是讓「大規模枚舉」變難（從「跑 1000 次迴圈」變成「不可能猜中」）。

**正確修法**（09-spring-security 會實作）：

```java
// ❌ 只檢查登入
@GetMapping("/orders/{id}")
public OrderDetail get(@PathVariable Long id) {
    return service.findById(id);       // 誰都能查任何一張
}

// ✅ 檢查所有權
@GetMapping("/orders/{id}")
@PreAuthorize("hasRole('SUPPORT') or @orderGuard.isOwner(#id, principal)")
public OrderDetail get(@PathVariable Long id) { ... }

// ✅✅ 更好：在查詢條件裡就帶上所有權（不可能忘記）
Order order = repo.findByIdAndCustomerId(id, currentCustomerId())
                  .orElseThrow(OrderNotFoundException::new);
```

第三種寫法最好：**它讓「忘記檢查權限」變成不可能，而不是靠人記得加註解。**

**風險 2：資訊洩漏（German tank problem）**

競爭對手註冊你的服務，下兩張單，中間隔一週：

```
2026-08-12 下單 → orderNumber 內含 id = 48213
2026-08-19 下單 → orderNumber 內含 id = 52907
```

`(52907 − 48213) / 7 天` = **一天約 670 張訂單**。
再乘上客單價（他從商品頁就知道），營收就被算出來了。

這在二戰時被用來估算德軍坦克產量（統計學上叫 German tank problem），
現代版是**每次有新創公司用自增 ID 當對外編號，記者就能算出它的成長率**。

**風險 3：分散式環境下的協調成本**

自增 ID 需要單一協調點（資料庫的 AUTO_INCREMENT）。
分庫分表、多寫入節點、離線建立（App 離線下單）時都會有問題。

### 1.4.2 五種識別碼方案

| 方案 | 例子 | 長度 | 可猜測 | 有序 | 索引效能 | 適用 |
|---|---|---|---|---|---|---|
| 自增 BIGINT | `1001` | 短 | 🔴 高 | ✅ | ★ 最好 | 內部 ID（不對外） |
| UUIDv4 | `f47ac10b-58cc-4372-a567-0e02b2c3d479` | 36 字元 | ✅ 不可猜 | ❌ | ⚠️ 差（隨機寫入導致 B+Tree 頁分裂） | 需要離線產生時 |
| UUIDv7 / ULID | `01J5GKQ8Z4W9V2X3Y6N7M8P0QR` | 26～36 | ✅ 不可猜 | ✅ 時間有序 | ✅ 好 | ★ 現代首選 |
| Snowflake | `1725088331234567890` | 19 位數字 | ⚠️ 部分可推 | ✅ | ✅ 好 | 高併發、需要有序 |
| 業務編號 | `ORD-20260819-0001` | 中 | ⚠️ 可推 | ✅ | 中 | ★ 給人看的對外編號 |

**UUIDv7 / ULID 值得特別說明**：它們把時間戳放在前段、隨機值放在後段，
所以「按時間近似有序」→ 資料庫索引的插入是**追加式**的，避免了 UUIDv4 隨機插入造成的頁分裂與快取失效。
Java 21 之前需要第三方庫（`com.github.f4b6a3:uuid-creator`、`ulid-creator`），
JDK 的 `UUID.randomUUID()` 目前只產生 v4。

### 1.4.3 內部 ID vs 對外編號（★ 重要）

**很多系統需要兩個識別碼**，因為它們的需求互相衝突：

| | 內部 ID | 對外編號 |
|---|---|---|
| 目的 | 資料庫主鍵、外鍵、join | 給人講、貼在包裝上、客服對答案 |
| 使用者 | 程式 | 人類 |
| 需求 | 短、索引快、不可變 | 可讀、可唸出來、可手抄、含資訊 |
| 例子 | `48213`（BIGINT） | `ORD-20260819-0001` |
| 對外暴露 | ❌ 不暴露 | ✅ 暴露 |

**shop-service 的決定**：

```jsonc
{
  "orderId": "01J5GKQ8Z4W9V2X3Y6N7M8P0QR",   // ULID，URL 用這個
  "orderNumber": "ORD-20260819-0001",          // 給人看的，客服/包裝/發票用
  "..." : "..."
}
```

URL 用哪一個？**兩個都支援，但只有一個是正規（canonical）的**：

```http
GET /orders/01J5GKQ8Z4W9V2X3Y6N7M8P0QR    ← 正規路徑
GET /orders?orderNumber=ORD-20260819-0001  ← 查詢（客服輸入單號）
```

**不要**讓 `GET /orders/{x}` 同時接受兩種格式然後自己判斷。原因：

- 判斷邏輯很脆弱（如果哪天編號規則變了呢）。
- 同一個資源有兩個 URI，違反「資源識別」子約束，破壞快取（同一筆資料有兩份快取）。
- OpenAPI 無法描述「這個參數可能是兩種格式之一」。

> **實務折衷**：如果一定要，讓 `GET /orders/{orderNumber}` **回 `301`／`302` 導向正規 URI**，
> 而不是直接回內容。這樣快取和文件都能正確處理。

### 1.4.4 對外編號的設計

```
ORD-20260819-0001
│    │        └── 當天流水號（4 位，一天最多 9999 張；不夠就 6 位）
│    └── 日期（可讀，客服「請問您 8/19 那張訂單」）
└── 類型前綴（ORD 訂單 / PAY 付款 / RMA 退貨 / SHP 出貨）
```

**類型前綴的實際價值**（Stripe 的做法，很值得抄）：

```
cus_NffrFeUfNV2Hib      客戶
ch_3MtwBwLkdIwHu7ix     收費
pi_3MtwBwLkdIwHu7ix     付款意向
re_3MtwBwLkdIwHu7ix     退款
```

好處：**貼錯 ID 的時候立刻看出來。**

```java
// 有前綴時，這種錯誤在 log 裡一眼可見
refundService.refund("cus_NffrFe...");   // ← 一看就知道傳錯了，這是客戶 ID

// 沒前綴時
refundService.refund("48213");           // ← 48213 是訂單？付款？客戶？只能查
```

**shop-service 的決定**：

| 資源 | 內部 ID 格式 | 對外編號 |
|---|---|---|
| Order | `ord_` + ULID | `ORD-20260819-0001` |
| Payment | `pay_` + ULID | — |
| Refund | `ref_` + ULID | — |
| Shipment | `shp_` + ULID | 物流商單號（外部給的） |
| Return | `ret_` + ULID | `RMA-20260820-0007` |
| Customer | `cus_` + ULID | 會員編號 `M00048213` |
| Product | 人工設定 `P-1001` | 同（SKU） |

> ⚠️ **對外編號不要包含可推算的連號**，否則 1.4.1 風險 2 又回來了。
> `ORD-20260819-0001` 洩漏「當天第幾張」。
> 如果這件事敏感（B2B、營收機密），改成 `ORD-20260819-7F3A9C`（隨機後綴）。
> **這是「可讀性」與「保密性」的取捨，要有意識地選。**

### 1.4.5 ID 在 JSON 裡一律用字串

```jsonc
// ❌ 危險
{ "orderId": 1725088331234567890 }

// ✅ 安全
{ "orderId": "1725088331234567890" }
```

原因：JavaScript 的 `Number` 是 IEEE 754 雙精度浮點，安全整數上限是
`Number.MAX_SAFE_INTEGER = 9007199254740991`（約 9×10¹⁵）。

```javascript
JSON.parse('{"id": 1725088331234567890}').id
// → 1725088331234567900   ← 最後幾位被改掉了！而且不會報錯
```

**這是真實發生過的事故**：Twitter 的 snowflake ID 超過安全範圍，
導致所有 JavaScript 客戶端拿到錯誤的 tweet ID。
Twitter 的解法是在 API 回應裡**同時提供 `id`（數字）和 `id_str`（字串）**，
並在文件裡明確要求所有 JS client 用 `id_str`。

**規則**：**所有 ID 在 JSON 裡都是字串，不管內部是什麼型別。**
反正你不會對 ID 做算術運算。（第 03 章 3.5 會再講一次。）

### 1.4.6 `/me` 別名

```http
GET /customers/cus_01J5GK.../orders      ← 客戶要先知道自己的 ID
GET /me/orders                            ← ✅ 好多了
GET /orders                                ← ✅ 更好（範圍從 token 推導）
```

三種都可以，各有取捨：

| 寫法 | 優點 | 缺點 |
|---|---|---|
| `GET /orders` | 最簡潔；客服和客戶用同一支端點（第 00 章洞察 2） | 「回什麼」取決於 token，OpenAPI 不好描述 |
| `GET /me/orders` | 語意明確，一看就知道是「我的」 | 多一層；`/me` 和 `/customers/{id}` 是兩條路徑指向同一資源 |
| `GET /customers/{id}/orders` | 最一致；管理端可直接用 | 客戶端要先查自己的 ID（多一次請求） |

**shop-service 的決定**：

```
GET /orders                    顧客：只回自己的；客服：回全部（可 ?customerId= 篩選）
GET /me                        我的個人資料（等同 /customers/{我的 id}）
GET /me/addresses              我的收件地址
GET /carts/current             我的購物車（見 1.8）
GET /customers/{id}            客服查特定客戶（顧客呼叫自己以外的 id → 403）
GET /customers/{id}/orders     客服查特定客戶的訂單
```

理由：
- 訂單是**高頻**端點，讓它最短（`GET /orders`）。
- 個資類的用 `/me`，語意清楚且避免客戶端到處拼自己的 ID。
- 管理端保留 `/customers/{id}/...` 的完整形式。

> ⚠️ **`GET /orders` 的預設範圍必須在文件裡寫得非常明確。**
> 「同一個 URL 對不同角色回不同資料」是威力強大但容易誤解的設計。
> 也要小心快取：這種回應**必須** `Cache-Control: private, no-store`
> （第 00 章 0.4.2 約束 3 的事故就是這樣發生的）。

---

## 1.5 巢狀資源

### 1.5.1 什麼時候該巢狀

判斷式：

```
子資源沒有父資源就毫無意義嗎？
├─ 是 → 巢狀   /orders/{id}/items
└─ 否 → 頂層 + 查詢參數   /reviews?productId=...
```

補充判斷：

| 問題 | 巢狀 | 頂層 |
|---|---|---|
| 會需要「跨父資源」查詢嗎？ | 不會 | 會 → 至少要有頂層路徑 |
| 子資源的 ID 在全系統唯一嗎？ | 不一定（可以是父內序號） | 一定唯一 |
| 刪除父資源時子資源怎麼辦？ | 一起刪 | 保留或改為孤兒 |
| 子資源有自己的管理後台頁面嗎？ | 沒有 | 有 → 需要頂層 |

**shop-service 的判斷結果**

| 子資源 | 巢狀？ | 理由 |
|---|---|---|
| `OrderItem` | ✅ 只有巢狀 | 沒有訂單就沒有明細；沒人會問「系統裡所有的訂單明細」 |
| `CartItem` | ✅ 只有巢狀 | 同上 |
| `Address` | ✅ 只有巢狀 `/me/addresses` | 沒有客戶就沒有地址 |
| `Payment` | ✅ 巢狀 + 頂層 | 建立時在訂單脈絡下；財務要查「今天所有失敗的付款」→ 需要 `/payments` |
| `Shipment` | ✅ 巢狀 + 頂層 | 同上，倉管要看「今天要出的所有貨」 |
| `Cancellation` | ✅ 只有巢狀 | 客服查取消都是從訂單進去的 |
| `Return` | ✅ 巢狀 + 頂層 | 退貨有自己的審核佇列 → `/returns?status=PENDING_APPROVAL` |
| `Review` | ✅ 巢狀 + 頂層 | 商品頁看 `/products/{id}/reviews`；「我的評價」看 `/reviews?customerId=me` |
| `Refund` | ✅ 巢狀在 payment 下 | 退款一定針對某筆付款 |

### 1.5.2 深度不要超過 2

```
✅ /orders/1001/items                          深度 2，可以
⚠️ /orders/1001/items/5/discounts              深度 3，開始難讀
❌ /customers/9/orders/1001/items/5/discounts/2  深度 5，災難
```

深度過深的四個實際問題：

1. **URL 太長**：某些代理、瀏覽器、log 系統有長度限制（實務上 2000 字元內較安全）。
2. **參數過多**：`@PathVariable` 四五個，Controller 方法簽名醜到不行。
3. **資訊冗餘**：`/customers/9/orders/1001` 裡的 `9` 是多餘的 —— 訂單 1001 只屬於一個客戶。
   而且如果有人送 `/customers/8/orders/1001`（客戶不匹配）你要回 404 還是 400？（→ 又多一種錯誤情境）
4. **難以演進**：如果哪天訂單可以屬於「公司帳號」而不只是「個人客戶」，整條 URL 都要改。

**修正手法**：**用最短的唯一路徑。**

```
❌ /customers/9/orders/1001/items/5
✅ /orders/1001/items/5           ← 訂單 ID 已經唯一，不需要客戶
✅ /order-items/oi_5              ← 如果明細有全域唯一 ID，甚至可以更短
```

> **規則**：**只要子資源的 ID 在全系統唯一，就不需要完整的父路徑。**
> 巢狀路徑的價值是「在父的脈絡下建立／列表」，不是「當作定位路徑」。

### 1.5.3 巢狀路徑的參數要不要驗證一致性

```http
GET /orders/1001/items/5
```

如果 `items/5` 其實屬於訂單 `1002`，要回什麼？

| 回應 | 說明 |
|---|---|
| `404 Not Found` | ✅ **推薦**。語意是「訂單 1001 下沒有 id=5 的明細」，完全正確 |
| `400 Bad Request` | ⚠️ 可以，但沒必要 —— 這不是格式錯誤 |
| `200` + 回傳 item 5 | ❌ **絕對不行**。這是 IDOR 的一種，也是最常被忽略的一種 |

實作上務必**用複合條件查詢**：

```java
// ❌ 危險：只用 itemId 查
OrderItem item = itemRepo.findById(itemId).orElseThrow();

// ✅ 安全：orderId 也是查詢條件
OrderItem item = itemRepo.findByIdAndOrderId(itemId, orderId)
        .orElseThrow(() -> new ResourceNotFoundException("orderItem", itemId));
```

這和 1.4.1 的教訓一樣：**把權限／範圍檢查放進查詢條件，而不是靠事後 if。**

### 1.5.4 巢狀與頂層並存的規則

```
POST /orders/1001/payments        ← 建立：一定在訂單脈絡下（要知道付哪張）
GET  /orders/1001/payments        ← 列表：這張訂單的付款紀錄
GET  /payments/pay_01J5GK...      ← 單筆：財務對帳、客服查證
GET  /payments?status=FAILED      ← 跨訂單查詢：今天失敗的付款
```

**規則**：

| 操作 | 用哪種路徑 |
|---|---|
| 建立子資源 | **巢狀**（父 ID 是必要的上下文） |
| 列出某個父的子資源 | **巢狀** |
| 讀取／更新／刪除單一子資源 | **頂層**（如果子資源 ID 全域唯一） |
| 跨父資源查詢／篩選 | **頂層 + 查詢參數** |

**不要重複提供同樣功能的兩條路徑**：

```
❌ 兩條都能列出訂單 1001 的付款
GET /orders/1001/payments
GET /payments?orderId=1001
```

這會造成：兩份實作、兩份測試、兩份文件、兩套快取，而且遲早行為會不一致
（例如其中一條忘記加權限檢查 —— 這在真實專案發生過非常多次）。

**shop-service 的決定**：巢狀路徑用於**建立與列表**，頂層路徑用於**單筆與跨父查詢**。
`GET /payments?orderId=` 不提供（要就用 `GET /orders/{id}/payments`）。

---

## 1.6 多對多與關聯資源

### 1.6.1 關聯本身是資源

「訂單可以貼多個標籤，標籤可以貼在多個訂單上」—— 多對多。

```http
# 讀取
GET    /orders/1001/tags                 這張訂單的所有標籤
GET    /tags/vip/orders                  貼了 vip 標籤的所有訂單（或 GET /orders?tag=vip）

# 建立關聯（用 PUT 因為冪等 —— 貼兩次還是一個標籤）
PUT    /orders/1001/tags/vip             → 204（已存在也回 204）

# 解除關聯
DELETE /orders/1001/tags/vip             → 204

# 一次設定全部（全量替換）
PUT    /orders/1001/tags
Content-Type: application/json
["vip", "urgent"]                        → 200，結果就是這兩個，其他都移除
```

**為什麼是 `PUT /orders/1001/tags/vip` 而不是 `POST /orders/1001/tags`？**

因為關聯的建立是**冪等**的（第 02 章 2.2）。
手機網路不穩，請求重送三次，結果應該還是「貼了一個 vip 標籤」。
用 `POST` 的話語意是「新增一筆」，重送三次語意上應該產生三筆。

### 1.6.2 關聯有屬性時，它就是完整的資源

如果「訂單–標籤」關聯本身有屬性（誰貼的、何時貼的、備註）：

```http
POST /order-tags
{ "orderId": "1001", "tag": "vip", "note": "大客戶，優先處理" }
→ 201 Created
  Location: /order-tags/ot_01J5GK...

GET    /order-tags?orderId=1001
GET    /order-tags/ot_01J5GK...
DELETE /order-tags/ot_01J5GK...
```

**判準**：關聯有沒有自己的欄位／生命週期？
沒有 → 用 `PUT`／`DELETE` 子路徑。
有 → 它是頂層資源。

### 1.6.3 Review 的雙父問題

`Review` 同時屬於 `Product`（評價哪個商品）和 `Customer`（誰寫的）。

**❌ 不要做**：
```
/products/P-1001/customers/cus_9/reviews    ← 兩個父都塞進路徑，深度 4
```

**✅ 做法**：選一個「主要脈絡」放巢狀，另一個用查詢參數。

```http
POST /products/P-1001/reviews          建立（主脈絡是商品；作者從 token 取得）
GET  /products/P-1001/reviews          商品頁的評價列表
GET  /reviews/rev_01J5GK...            單筆（分享連結用）
GET  /reviews?customerId=me            我寫過的評價（「我的評價」頁面）
GET  /reviews?productId=P-1001&rating=5  管理後台的複合查詢
PATCH  /reviews/rev_01J5GK...          編輯自己的評價
DELETE /reviews/rev_01J5GK...          刪除
```

主脈絡怎麼選？**看「建立時哪個父是必要的」**。
寫評價一定要指定商品（`productId` 必填），作者則從 token 推導 → 商品是主脈絡。

---

## 1.7 非 CRUD 動作：五種手法 ★ 本章核心

這是實務上最常卡住的地方。以「取消訂單」為例，看五種手法。

### 手法 1：狀態子資源（`PUT /orders/{id}/status`）

```http
PUT /orders/1001/status
Content-Type: application/json

{ "status": "CANCELLED", "reason": "CUSTOMER_CHANGED_MIND" }
```

**適合**：狀態轉換單純、不需要額外資料、不需要留紀錄。

**優點**：
- 冪等（重送兩次結果一樣）。
- 一個端點處理所有狀態轉換，端點數量少。

**缺點**：
- **無法表達「不同轉換需要不同資料」**。取消要 `reason`，出貨要 `trackingNumber`，
  付款要 `cardToken` —— 全部塞在同一個 body 裡，變成「一堆選填欄位 + 執行期才檢查」的爛設計。
- **無法留紀錄**。誰取消的？何時？只能靠 audit log，客服查不到。
- **允許客戶端指定任意狀態** → 要在後端做完整的狀態機檢查，
  而且客戶端有可能送出 `{"status": "COMPLETED"}` 直接跳過付款（**這是真實的漏洞類型**）。

**判斷**：只有在狀態轉換真的只是「改一個欄位」時才用。

### 手法 2：動作子資源（`POST /orders/{id}/cancellations`）★ 推薦

```http
POST /orders/1001/cancellations
Content-Type: application/json
Idempotency-Key: 8f14e45f-ea36-4a1b-9c2e-77e8f1a3b0c1

{
  "reason": "CUSTOMER_CHANGED_MIND",
  "comment": "客戶說想改買別的顏色",
  "refundToOriginalMethod": true
}
```

```http
HTTP/1.1 201 Created
Location: /orders/1001/cancellations/can_01J5GK...

{
  "cancellationId": "can_01J5GK...",
  "orderNumber": "ORD-20260819-0001",
  "reason": "CUSTOMER_CHANGED_MIND",
  "cancelledBy": { "type": "CUSTOMER", "id": "cus_01J5GK..." },
  "cancelledAt": "2026-08-19T06:12:44Z",
  "orderStatus": "CANCELLED",
  "refund": {
    "refundId": "ref_01J5GK...",
    "status": "PROCESSING",
    "amount": "1280.50",
    "estimatedArrival": "2026-08-26"
  }
}
```

**優點**（這是為什麼推薦它）：
- **動作有了紀錄**，可查詢、可列表、可統計（「這個月取消原因分布」）。
- **每種動作有自己的 request/response schema**，驗證清楚，OpenAPI 好描述。
- 回應可以帶**動作的產物**（這裡是退款資訊）。
- 客戶端不能亂指定狀態 —— 它只能「建立一張取消單」，最終狀態由後端決定。
- 天然支援「一個訂單多次嘗試」（付款失敗重試 → 多筆 `payments`）。

**缺點**：
- 端點變多（但每個都很清楚，這個代價值得）。
- `POST` 非冪等 → **需要冪等鍵**（第 08 章）。

**這個手法的關鍵洞察**：`cancellations` 這個名詞不是硬掰出來的，
它是業務上**真實存在的東西**（取消單）。你只是把它顯性化了（第 00 章洞察 1）。

### 手法 3：控制器資源（`POST /orders/{id}/cancel`）

```http
POST /orders/1001/cancel
{ "reason": "CUSTOMER_CHANGED_MIND" }
```

**這是路徑裡有動詞的逃生門。** 什麼時候可以用？

當**真的**找不到合適的名詞，而且動作**不需要留紀錄**時：

```http
POST /carts/current/recalculate      重算購物車金額（沒有「重算單」這種東西）
POST /orders/1001/notifications/resend   重寄通知（雖然也可以是 POST /notifications）
POST /caches/product-catalog/purge   清空快取
POST /search-index/rebuild           重建搜尋索引
```

**如何降低它的傷害**：

1. 用**祈使動詞**且放在路徑**最後一段**：`/orders/{id}/cancel` ✅，`/cancelOrder/{id}` ❌。
2. 一定用 `POST`（因為非冪等且有副作用）。
3. 在 style guide 裡**列出白名單** —— 只有清單上的動詞可以出現在路徑裡。
   這防止它從「例外」變成「常態」。
4. code review 時要求「為什麼不能用手法 2」的說明。

**真實案例**：Google Cloud 的 API 設計指南（AIP-136）稱這類為 **custom method**，
格式是 `POST /v1/resources/{id}:cancel`（用 `:` 分隔而不是 `/`）。
用 `:` 的好處是**一眼看出這不是子資源**，路由上也不會和 `/orders/{id}/{subresource}` 衝突。

```http
POST /orders/1001:cancel        ← Google AIP 風格
POST /orders/1001/cancel        ← 較常見的寫法
```

本課程選 `/cancel` 形式（更常見、工具支援更好），但知道 `:` 這個選項。

### 手法 4：把動作變成「意圖」資源

某些流程需要跨多次請求，把流程本身變成資源：

```http
# 建立結帳工作階段（不是直接建訂單）
POST /checkout-sessions
{ "cartId": "cart_current", "couponCode": "SUMMER20" }

→ 201 Created
{
  "sessionId": "cs_01J5GK...",
  "status": "REQUIRES_PAYMENT_METHOD",
  "amountDue": "1280.50",
  "expiresAt": "2026-08-19T06:42:44Z",
  "breakdown": {
    "subtotal": "1500.00",
    "discount": "-300.00",
    "shipping": "80.50",
    "tax": "0.00"
  }
}

# 選付款方式
PUT /checkout-sessions/cs_01J5GK.../payment-method
{ "type": "CREDIT_CARD", "cardToken": "tok_visa" }

# 確認（這一步才真正建立訂單）
POST /checkout-sessions/cs_01J5GK.../confirmations

→ 201 Created
Location: /orders/ord_01J5GK...
{ "orderId": "ord_01J5GK...", "orderNumber": "ORD-20260819-0001" }
```

**這是 Stripe 的 Payment Intent 模式**，解決了三個真實問題：

1. **多步驟流程需要中間狀態**（選地址 → 選運送 → 算稅 → 選付款 → 確認），
   但 HTTP 無狀態，狀態要放某個地方 → 放在 session 資源裡。
2. **金額必須在確認前鎖定**。如果每一步都重算，使用者可能在最後一步看到不同金額。
3. **3DS / OTP 等外部驗證需要回來繼續**。有 session ID 才能接續。

**什麼時候用**：流程超過兩步、有中間狀態、需要防止使用者中途改東西影響金額。
**什麼時候不用**：單一步驟就能完成的操作（用手法 2 就好）。

### 手法 5：用 `PATCH` 改欄位

```http
PATCH /orders/1001
Content-Type: application/merge-patch+json

{ "internalNote": "客戶要求提前出貨" }
```

**適合**：真的只是改一個屬性，沒有業務流程。

**不適合**：任何有副作用的操作。
❌ `PATCH /orders/1001 {"status":"CANCELLED"}` —— 取消訂單要退款、要還庫存、要寄信，
把這些藏在一個 `PATCH` 後面，讀 API 的人完全看不出來。

> **原則：`PATCH` 是「編輯資料」，不是「觸發流程」。**
> 如果改一個欄位會引發五件事，那它不是 PATCH，是手法 2。

### 1.7.1 決策流程圖

```
                  我有一個非 CRUD 的動作
                            │
        ┌───────────────────┴───────────────────┐
        │  這個動作需要留下可查詢的紀錄嗎？        │
        │  （誰做的、何時、原因、產物、要對帳）    │
        └───────────────────┬───────────────────┘
              是 │                    │ 否
                 ▼                    ▼
      ┌────────────────────┐   ┌──────────────────────────┐
      │ 手法 2             │   │ 它只是改一個屬性嗎？       │
      │ POST /x/{id}/動作s │   └────┬─────────────┬───────┘
      │ ★ 預設選這個       │     是 │             │ 否
      └────────────────────┘        ▼             ▼
                          ┌──────────────┐  ┌────────────────────┐
                          │ 手法 5       │  │ 是單純的狀態轉換嗎？│
                          │ PATCH /x/{id}│  └──┬──────────┬──────┘
                          └──────────────┘  是 │          │ 否
                                              ▼          ▼
                                   ┌──────────────┐  ┌───────────────┐
                                   │ 手法 1       │  │ 流程超過兩步？ │
                                   │ PUT /x/{id}/ │  └──┬───────┬────┘
                                   │     status   │  是 │       │ 否
                                   └──────────────┘     ▼       ▼
                                              ┌──────────┐ ┌──────────┐
                                              │ 手法 4   │ │ 手法 3   │
                                              │ session  │ │ /動作    │
                                              │ 資源     │ │（白名單）│
                                              └──────────┘ └──────────┘
```

**實務比例**：手法 2 大約覆蓋 70% 的情況，手法 5 覆蓋 15%，
手法 1 覆蓋 10%，手法 3 和 4 各 2～3%。

**如果你發現自己一直在用手法 3，那是資源建模沒做好的訊號。**

### 1.7.2 shop-service 的非 CRUD 動作全表

| 業務動作 | 手法 | 端點 | 理由 |
|---|---|---|---|
| 付款 | 2 | `POST /orders/{id}/payments` | 要紀錄、要對帳、可能多次 |
| 退款 | 2 | `POST /payments/{id}/refunds` | 要紀錄、可部分退、可多次 |
| 取消訂單 | 2 | `POST /orders/{id}/cancellations` | 要紀錄原因、要退款 |
| 出貨 | 2 | `POST /orders/{id}/shipments` | 要物流單號、可分批出貨 |
| 退貨 | 2 | `POST /orders/{id}/returns` | 有自己的審核流程 |
| 審核退貨 | 5 | `PATCH /returns/{id}` `{"resolution":"APPROVED"}` | 只是改退貨單的欄位 |
| 加入購物車 | — | `POST /carts/current/items` | 就是建立子資源，不是特殊動作 |
| 套用折扣碼 | 1 | `PUT /carts/current/coupon` | 冪等、單一值、不需紀錄 |
| 移除折扣碼 | 1 | `DELETE /carts/current/coupon` | 同上 |
| 清空購物車 | — | `DELETE /carts/current/items` | 刪除集合 |
| 結帳 | 4 或 2 | `POST /checkout-sessions` → `POST .../confirmations`<br>（簡化版：`POST /orders`） | 多步驟且要鎖金額 |
| 重寄確認信 | 2 | `POST /orders/{id}/notifications` | 要紀錄「寄了幾次」，客服會查 |
| 匯出訂單報表 | 2 | `POST /order-exports` → `202` | 長時間工作，要有進度與重下載 |
| 上架商品 | 1 | `PUT /products/{id}/status` `{"status":"ACTIVE"}` | 單純狀態轉換 |
| 調整庫存 | 2 | `POST /products/{id}/inventory-adjustments` | 要紀錄誰調的、原因（盤盈虧要對帳） |
| 標記精選商品 | 5 | `PATCH /products/{id}` `{"featured":true}` | 就是一個布林欄位 |
| 重算購物車 | 3 | `POST /carts/current/recalculate` | 沒有合適名詞，不留紀錄 |
| 清商品快取 | 3 | `POST /caches/products/purge` | 維運操作 |
| 手動觸發對帳 | 2 | `POST /reconciliation-jobs` → `202` | 是一個工作，要看結果 |

**注意「調整庫存」為什麼用手法 2 而不是 `PATCH /products/{id}` 改 `stock` 欄位**：

```
❌ PATCH /products/P-1001  {"stock": 95}
   問題：① 併發時後蓋前（兩個倉管同時盤點 → 一個人的結果消失）
        ② 不知道為什麼從 100 變 95（盤損？出貨？退貨？）
        ③ 財務要對帳時完全查不到

✅ POST /products/P-1001/inventory-adjustments
   { "delta": -5, "reason": "DAMAGED", "note": "淹水損毀 5 件", "referenceNo": "IA-20260819-01" }
   → ① delta 是相對值，併發安全（資料庫層 stock = stock - 5）
     ② 有原因、有備註、有紀錄
     ③ 庫存可以由調整紀錄重算出來（可稽核）
```

**這是本章最值得帶走的一個例子**：
「改一個數字」和「記錄一次調整」在 API 上是天差地別的兩種設計，
而後者才是業務真正需要的。

---

## 1.8 單例子資源（Singleton Sub-resource）

有些子資源在父資源下**只有一個**：

```http
GET    /orders/1001/invoice          這張訂單的發票（最多一張）
PUT    /orders/1001/invoice          設定發票資訊
DELETE /orders/1001/invoice          作廢發票

GET    /carts/current                我的購物車（每人一個）
GET    /products/P-1001/inventory    這個商品的庫存（一份）
PUT    /carts/current/coupon         購物車的折扣碼（一個）
GET    /me                           我的個人資料（一個）
GET    /me/preferences               我的偏好設定（一份）
```

**特徵與規則**：

| 特徵 | 說明 |
|---|---|
| 用**單數** | `invoice` 不是 `invoices`（因為它不是集合） |
| **沒有 ID 段** | `/orders/1001/invoice` 而不是 `/orders/1001/invoice/{invoiceId}` |
| 用 `PUT` 建立／替換 | 不用 `POST`（`POST` 語意是「往集合裡新增」，但這裡沒有集合） |
| `GET` 在不存在時回 `404` | 或回 `200` + 預設值（見下） |
| 冪等 | `PUT` 兩次結果相同 |

**「不存在時回什麼」的取捨**：

| 情境 | 建議 |
|---|---|
| `/orders/1001/invoice`（還沒開發票） | `404` —— 發票是「有或沒有」 |
| `/me/preferences`（沒設過偏好） | `200` + 全預設值 —— 偏好設定「概念上一定存在」 |
| `/carts/current`（沒加過東西） | `200` + 空購物車 —— 購物車概念上一定存在 |
| `/products/P-1001/inventory` | `200` + `{"available": 0}` —— 庫存一定有值 |

**判準**：這東西「概念上一定存在，只是可能是空的」→ 回 200 + 空／預設值。
「可能根本不存在」→ 回 404。

> ⚠️ 常見錯誤：`GET /carts/current` 在使用者沒加過任何商品時回 `404`。
> 前端要為此寫特殊處理（`if (err.status === 404) cart = emptyCart()`）。
> 直接回空購物車讓前端程式少一個分支。**能讓客戶端少寫 if 的設計就是好設計。**

### 1.8.1 為什麼是 `/carts/current` 而不是 `/cart`

```
/cart                 ← 看起來更簡潔
/carts/current        ← 但這個更好
```

理由：**未來可能有多個購物車**。

- 「稍後再買」清單其實是第二個購物車。
- B2B 場景：一個帳號下多個採購清單。
- 「已儲存的購物車」功能（把當前購物車存起來，之後叫回）。

用 `/carts/current` 的話，未來擴充只要加：

```
GET  /carts                    我的所有購物車
GET  /carts/current            當前使用中的
GET  /carts/cart_01J5GK...     某一個已儲存的
PUT  /carts/current            切換 current 指向哪一個
POST /carts                    另存一個新的
```

用 `/cart` 的話，你只能開一條新路徑 `/carts`，然後兩套並存 —— 又回到第 00 章 0.8 的問題。

> **這是「為可能的演進留空間」的實例。**
> 但要小心不要過度設計 —— 判準是「這個擴充有具體的業務可能性嗎」。
> 購物車有（上面三個場景都很常見），所以值得。

---

## 1.9 路徑 / 查詢 / Header / Body 的分工

這是實務上第二常搞混的事（第一是非 CRUD 動作）。

### 1.9.1 決策表

| 資訊種類 | 放哪 | 例子 | 為什麼 |
|---|---|---|---|
| **哪一個資源** | 路徑 | `/orders/1001` | 資源識別，必填，不可省略 |
| **集合的篩選／排序／分頁** | 查詢參數 | `?status=PAID&page=0&sort=createdAt,desc` | 可選、可組合、可有預設值 |
| **回應的變體**（欄位、展開、語言） | 查詢參數 | `?fields=id,status&expand=items` | 同一資源的不同表述 |
| **要建立／更新的資料** | Body | `{"items":[...]}` | 可能很大、有結構、有巢狀 |
| **身分憑證** | Header | `Authorization: Bearer ...` | 不該進 log、不該進瀏覽器歷史 |
| **內容格式協商** | Header | `Content-Type` / `Accept` | HTTP 標準機制 |
| **快取／條件請求** | Header | `If-None-Match` / `If-Match` | HTTP 標準機制 |
| **冪等鍵** | Header | `Idempotency-Key` | 是傳輸層語意，不是業務資料 |
| **追蹤 ID** | Header | `X-Request-Id` / `traceparent` | 橫切關注點 |
| **API 版本** | 路徑或 Header | `/v1/orders` 或 `X-Api-Version` | 第 06 章詳論 |
| **租戶識別** | 路徑或 Header 或 token | 見 1.10 | 看架構 |

### 1.9.2 三條保命規則

**規則 1：敏感資料絕對不進 URL**

```
❌ GET /orders?token=eyJhbGciOi...
❌ GET /login?username=admin&password=123456
❌ GET /reset-password?email=a@b.com&code=482913
```

URL 會出現在：

| 地方 | 存多久 |
|---|---|
| Nginx / ALB `access.log` | 通常 30～90 天，而且可能送到第三方日誌服務 |
| 瀏覽器歷史紀錄 | 永久（除了無痕） |
| `Referer` header | **會被送到你連出去的任何第三方網站** 🔴 |
| APM / trace 系統的 span name | 依保留政策 |
| 分享連結（使用者複製貼上給別人） | 永久，而且失控 |
| 瀏覽器書籤同步 | 上傳到 Google/Apple 帳號 |

`Referer` 那一項最容易被忽略：如果你的頁面 URL 帶了 reset code，
頁面上又有一張第三方 CDN 的圖片，那個 code 就送到第三方去了。

**規則 2：`GET` 不要有 body**

技術上 HTTP 沒禁止（RFC 9110 說 `GET` 的 body「沒有定義的語意」），
但實際上會出事：

- 部分代理、CDN、負載平衡器會**丟掉** `GET` 的 body。
- `fetch()` 和 `XMLHttpRequest` **不允許** `GET` 帶 body（規範層面禁止）。
- 快取鍵不包含 body → 不同 body 的請求會拿到同一份快取（**錯誤資料**）。
- OpenAPI 3.0 不支援描述 `GET` 的 requestBody（3.1 技術上可以但工具不支援）。

**如果查詢條件真的太複雜怎麼辦？**（例如 20 個篩選條件、巢狀邏輯）

| 方案 | 說明 | 取捨 |
|---|---|---|
| A. 用 `POST /orders/searches` | 把「搜尋」變成資源，body 放條件 | ✅ 語意清楚，可以有巢狀條件<br>❌ 失去快取、不能貼連結 |
| B. `POST /order-search-queries` → 回 `queryId`，再 `GET /orders?queryId=xxx` | 兩段式 | ✅ 兼顧快取與複雜條件<br>❌ 兩次往返、要存查詢 |
| C. 把條件壓縮成一個參數 `?filter=<base64 或 RSQL>` | `?filter=status==PAID;amount>1000` | ✅ 仍是 GET，可快取<br>❌ 可讀性差、URL 長度限制 |
| D. 減少篩選條件 | 檢視是不是真的需要 20 個 | ✅ 常常是正確答案 |

**shop-service 的決定**：一般查詢用 `GET /orders?...`；
如果哪天真的需要複雜搜尋，用方案 A（`POST /orders/searches`）並在文件裡註明它不可快取。

**規則 3：路徑參數必填，查詢參數要有合理預設值**

```
GET /orders                      → 預設 page=0, size=20, sort=createdAt,desc
GET /orders?size=10000           → 要拒絕（回 400，max size = 100）
GET /orders/{id}                 → id 缺少就是 404（路由都對不上）
```

**沒有預設值的查詢參數是設計缺陷**：如果 `GET /orders` 不給 `page` 就回全部資料，
那你的 API 有一天會因為某人忘記帶參數而把資料庫拖垮（第 05 章會處理）。

---

## 1.10 多租戶（Multi-tenancy）

如果你的系統要服務多個商家（SaaS），租戶 ID 放哪？

| 方案 | 例子 | 優點 | 缺點 |
|---|---|---|---|
| **A. 路徑** | `/tenants/t_abc/orders` | 明確、可讀、路由層可分流、log 一看就知道 | 每條 URL 都變長；換租戶要改 URL |
| **B. Header** | `X-Tenant-Id: t_abc` | URL 乾淨 | 🔴 **可被偽造**（除非用 token 驗證）；不可貼連結；容易忘記帶 |
| **C. Token claim** | JWT 裡 `"tenant": "t_abc"` | ★ 最安全（簽章保護，不可偽造） | 換租戶要重新登入；log 要解 token 才知道 |
| **D. 子網域** | `abc.api.shop.example/orders` | 完全隔離，可分流到不同叢集，可獨立限流 | DNS + TLS 憑證管理（要 wildcard cert） |

**實務組合（推薦）**：

```
主要來源：C（token claim）—— 因為它不可偽造
輔助：A 或 D 用於路由與可觀測性
規則：如果同時出現，必須一致，不一致回 403
```

```java
// 概念示意（09-spring-security 會實作）
String tenantFromToken = jwt.getClaim("tenant");     // 可信
String tenantFromPath  = pathVariable("tenantId");   // 不可信，只是方便
if (!tenantFromToken.equals(tenantFromPath)) {
    throw new TenantMismatchException();   // → 403
}
```

**最重要的一條**：**永遠不要只用 Header 或路徑決定租戶。**
那等於讓任何人改一個字就能讀別人的資料 —— 這是 SaaS 最嚴重的資安漏洞類型
（OWASP API1:2023 的租戶版）。

> 進一步的隔離手段（每租戶一個 schema、資料庫 row-level security、
> 連線池按租戶分）在 07-mysql 與 09-spring-security 會談。

---

## 1.11 檔案與二進位

### 1.11.1 上傳

**方案 A：`multipart/form-data`（最通用）**

```http
POST /products/P-1001/images
Content-Type: multipart/form-data; boundary=----abc123

------abc123
Content-Disposition: form-data; name="file"; filename="main.jpg"
Content-Type: image/jpeg

<二進位資料>
------abc123
Content-Disposition: form-data; name="metadata"
Content-Type: application/json

{"alt": "商品主圖", "position": 1}
------abc123--
```

```http
HTTP/1.1 201 Created
Location: /products/P-1001/images/img_01J5GK...

{
  "imageId": "img_01J5GK...",
  "url": "https://cdn.shop.example/products/P-1001/img_01J5GK.jpg",
  "width": 1200, "height": 1200,
  "sizeBytes": 245113,
  "contentType": "image/jpeg"
}
```

**方案 B：預簽名 URL（大檔的正解）★**

```http
# 1. 向 API 要一個上傳許可
POST /product-image-uploads
{ "productId": "P-1001", "filename": "main.jpg", "contentType": "image/jpeg", "sizeBytes": 245113 }

→ 201 Created
{
  "uploadId": "up_01J5GK...",
  "uploadUrl": "https://s3.ap-northeast-1.amazonaws.com/bucket/tmp/up_01J5GK...?X-Amz-Signature=...",
  "expiresAt": "2026-08-19T06:27:44Z",
  "method": "PUT",
  "requiredHeaders": { "Content-Type": "image/jpeg" }
}

# 2. 客戶端「直接」PUT 到 S3（完全不經過你的伺服器）
PUT https://s3.../tmp/up_01J5GK...?X-Amz-Signature=...

# 3. 通知 API 上傳完成
POST /product-image-uploads/up_01J5GK.../completions
→ 201 Created
Location: /products/P-1001/images/img_01J5GK...
```

**為什麼大檔一定要用 B**：

| 問題 | multipart | 預簽名 URL |
|---|---|---|
| 佔用你的頻寬 | ✅ 全部經過你 | ❌ 完全不經過 |
| 佔用應用伺服器執行緒 | ✅ 上傳 5 分鐘就佔 5 分鐘 | ❌ 不佔 |
| 記憶體壓力 | ⚠️ 要串流處理才不會 OOM | ❌ 無 |
| Nginx / ALB body 大小限制 | ⚠️ 常見 1MB 預設值要調 | ❌ 不受限 |
| 斷點續傳 | ❌ 難 | ✅ S3 multipart upload 原生支援 |
| 適合大小 | < 10 MB | 任意 |

**❌ 絕對不要做的事：把檔案 base64 塞進 JSON。**

```jsonc
{ "filename": "main.jpg", "content": "iVBORw0KGgoAAAANSUhEUg..." }
```

- base64 讓體積**膨脹 33%**。
- 整個字串要在記憶體裡（無法串流）→ 上傳 100MB 檔案讓 JVM heap 爆掉。
- JSON 解析器要處理超長字串，效能差。
- log 會被灌爆（有人開 request logging 就完蛋了）。

> **唯一可接受的例外**：非常小的檔案（< 100KB，例如頭像縮圖、簽名圖），
> 而且你確定有大小上限的驗證。

### 1.11.2 下載

```http
GET /orders/1001/invoice/pdf
Accept: application/pdf

→ 200 OK
Content-Type: application/pdf
Content-Disposition: attachment; filename="invoice-ORD-20260819-0001.pdf"
Content-Length: 48213
```

或用「內容協商」讓同一個 URI 給不同格式（更 REST，但工具支援較差）：

```http
GET /orders/1001/invoice
Accept: application/pdf        → PDF
Accept: application/json       → JSON
```

**大檔下載或需要權限控管時，同樣用預簽名 URL**：

```http
GET /order-exports/exp_01J5GK...

→ 200 OK
{
  "exportId": "exp_01J5GK...",
  "status": "SUCCEEDED",
  "rowCount": 48213,
  "downloadUrl": "https://s3.../exports/exp_01J5GK.csv?X-Amz-Signature=...",
  "downloadUrlExpiresAt": "2026-08-19T07:12:44Z",
  "expiresAt": "2026-08-26T06:12:44Z"
}
```

注意有**兩個過期時間**：
`downloadUrlExpiresAt`（簽名連結的短期有效，1 小時）
和 `expiresAt`（整份匯出檔案的保留期，7 天）。
使用者可以在 7 天內回來重新取得新的簽名連結。這是很實用的一個細節。

---

## 1.12 批次操作

### 1.12.1 四種做法

**做法 A：集合端點接受陣列**

```http
POST /orders/1001/items
Content-Type: application/json

[ { "productId": "P-1001", "quantity": 2 },
  { "productId": "P-2003", "quantity": 1 } ]

→ 201 Created
[ { "itemId": "oi_1", ... }, { "itemId": "oi_2", ... } ]
```

**問題**：**部分成功怎麼辦？** 第一筆成功、第二筆庫存不足 → 回 201 還是 400？
（第 04 章 4.11 會處理，簡短答案：用 `207` 或 `200` + 每筆結果）

**適合**：小批量（< 50 筆）、且「全成功或全失敗」（在一個交易裡）是可接受的語意。

**做法 B：查詢參數指定多個 ID**

```http
GET    /orders?ids=1001,1002,1003          批次讀取
DELETE /orders?ids=1001,1002,1003          批次刪除（⚠️ 見下）
```

**問題**：
- URL 長度限制（實務上 2000 字元 → 約 60 個 ULID）。
- `DELETE` 帶查詢參數很危險：**少打一個參數就刪掉全部**。

```
DELETE /orders?ids=1001,1002    ← 想刪兩筆
DELETE /orders                   ← 手滑，刪光整個表 🔴
```

**保護措施**：`DELETE /orders` 沒有 `ids` 參數時**一定回 400**，絕不當成「刪全部」。
更好的做法：不提供批次 `DELETE`，用做法 D。

**做法 C：專用批次端點**

```http
POST /orders/batch-status-updates
{
  "orderIds": ["1001", "1002", "1003"],
  "status": "SHIPPED"
}

→ 200 OK
{
  "succeeded": ["1001", "1003"],
  "failed": [
    { "orderId": "1002", "code": "ORDER_NOT_SHIPPABLE", "message": "訂單狀態為 CANCELLED" }
  ]
}
```

**適合**：中等批量（50～500 筆）、需要回報每一筆的結果、可以在一個 HTTP 請求內跑完。

**做法 D：批次工作資源（大批量的正解）★**

```http
POST /order-import-jobs
Content-Type: application/json

{ "sourceFileUrl": "https://s3.../uploads/orders-20260819.csv", "dryRun": false }

→ 202 Accepted
Location: /order-import-jobs/job_01J5GK...
{ "jobId": "job_01J5GK...", "status": "QUEUED", "totalRows": 48213 }
```

輪詢進度：

```http
GET /order-import-jobs/job_01J5GK...

→ 200 OK
{
  "jobId": "job_01J5GK...",
  "status": "RUNNING",
  "progress": { "processed": 12000, "succeeded": 11940, "failed": 60, "total": 48213 },
  "startedAt": "2026-08-19T06:12:44Z",
  "estimatedCompletionAt": "2026-08-19T06:24:00Z"
}
```

完成後拿錯誤報告：

```http
GET /order-import-jobs/job_01J5GK.../errors?page=0&size=50

→ 200 OK
{
  "items": [
    { "row": 42, "code": "PRODUCT_NOT_FOUND", "field": "productId",
      "value": "P-9999", "message": "商品不存在" },
    { "row": 108, "code": "INVALID_QUANTITY", "field": "quantity",
      "value": "-3", "message": "數量必須大於 0" }
  ],
  "page": { "number": 0, "size": 50, "totalElements": 60 }
}
```

### 1.12.2 選擇指引

| 批量 | 做法 | 回應 |
|---|---|---|
| 1～50，可全有全無 | A（陣列） | `201` 或 `207` |
| 50～500，要逐筆結果 | C（專用端點） | `200` + `succeeded`/`failed` |
| > 500，或耗時 > 5 秒 | D（工作資源） | `202` + 輪詢 |
| 讀取多筆 | B（`?ids=`）或 A | `200` |

**判準：如果處理時間可能超過 HTTP 超時（Nginx 預設 60 秒），就必須用 D。**

> ⚠️ 很多團隊在做法 A 或 C 上撐到極限：
> 「批次匯入 5000 筆，用 `POST /orders/batch`，然後把 Nginx 超時調到 600 秒」。
> 這會導致：使用者按 F5 重送、看不到進度、失敗要整批重來、佔住一個執行緒 10 分鐘。
> **超時設定不是解法，非同步才是。**

---

## 1.13 十個 URL 設計審查案例（Before / After）

這一節是實戰。每個案例都來自真實專案。

### 案例 1：「取得使用者訂單」

```
❌ GET /getUserOrders?userId=123
```

**三個問題**：動詞、IDOR 風險、無分頁。

```
✅ GET /orders?page=0&size=20                     顧客：自動限定自己
✅ GET /orders?customerId=cus_123&page=0&size=20  客服：明確指定（需 SUPPORT 權限）
```

**額外要做的事**：如果 `customerId` 參數存在但呼叫者不是客服 → 回 `403`，
而不是「忽略這個參數」。忽略參數會讓客戶端誤以為篩選生效了（靜默錯誤）。

### 案例 2：「取消訂單」

```
❌ POST /order/cancel        body: { "orderId": 1001, "reason": "..." }
```

**問題**：動詞在路徑、單數、資源 ID 在 body（無法用 URL 做權限與監控分組）。

```
✅ POST /orders/1001/cancellations    body: { "reason": "CUSTOMER_CHANGED_MIND" }
```

**為什麼「ID 在 body」是問題**：

| 影響 | 說明 |
|---|---|
| API Gateway 無法做權限 | 閘道通常只看 URL 和 method，看不進 body |
| APM 無法分組 | 所有取消都是同一個 span name，看不出哪張訂單慢 |
| 無法用 URL 做限流 | 「每張訂單每分鐘最多取消 1 次」做不到 |
| 快取／CDN 無效 | body 不進快取鍵 |
| log 分析困難 | `access.log` 看不到訂單 ID |

### 案例 3：「商品搜尋」

```
❌ POST /product/search    body: { "keyword": "耳機", "minPrice": 1000, "page": 1 }
```

```
✅ GET /products?q=耳機&minPrice=1000&page=0&size=20
```

**改成 `GET` 換來的好處**：

- 可快取（搜尋結果快取 60 秒 → 熱門關鍵字的 QPS 直接歸零）。
- 可貼連結分享（「你看這個搜尋結果」）。
- 瀏覽器的上一頁／下一頁正常運作。
- CDN 可以幫你擋掉大部分流量。

**但注意**：如果搜尋條件真的很複雜（巢狀 AND/OR、20 個欄位），用 1.9.2 規則 2 的方案 A。
**不要為了「純 REST」把複雜搜尋硬塞進 query string。**

### 案例 4：「巢狀太深」

```
❌ GET /companies/9/departments/3/employees/42/salaries/2026/08
```

```
✅ GET /employees/42/salaries?year=2026&month=8
   或 GET /salaries?employeeId=42&period=2026-08
```

員工 ID 已經唯一，公司和部門是多餘的。年月是篩選，不是識別。

### 案例 5：「動作變成集合」

```
❌ GET /orders/1001/getStatus
❌ GET /orders/1001/statusHistory
```

```
✅ GET /orders/1001                  status 就是回應的一個欄位，不需要專用端點
✅ GET /orders/1001/status-changes    狀態變更歷史（如果真的要）
```

**注意**：`GET /orders/1001/status` 這種「只取一個欄位」的端點通常不需要 ——
用 `?fields=status`（第 03 章 3.8）或直接取整筆。
多開一個端點就多一份文件、測試、權限設定。

### 案例 6：「動詞偽裝成名詞」

```
❌ POST /orderCancellation          （camelCase 且沒有父資源）
❌ POST /cancellation?orderId=1001  （ID 在查詢參數）
```

```
✅ POST /orders/1001/cancellations
```

### 案例 7：「用路徑做篩選」

```
❌ GET /orders/pending
❌ GET /orders/status/pending
❌ GET /orders/today
❌ GET /orders/customer/123/status/paid
```

```
✅ GET /orders?status=PENDING_PAYMENT
✅ GET /orders?createdFrom=2026-08-19T00:00:00%2B08:00
✅ GET /orders?customerId=cus_123&status=PAID
```

⚠️ 注意 `%2B` —— **`+` 在 query string 裡會被解讀成空白**，
所以時區偏移 `+08:00` 必須編碼成 `%2B08:00`。
這是超級常見的 bug：`2026-08-19T00:00:00+08:00` 傳到後端變成 `2026-08-19T00:00:00 08:00` → 解析失敗。
（第 03 章 3.6 會建議一律用 UTC `Z` 避開這個坑。）

### 案例 8：「複數／單數混用」

```
❌ GET /order/1001/items          （order 單數，items 複數）
❌ GET /orders/1001/item/5        （orders 複數，item 單數）
```

```
✅ GET /orders/1001/items/5
```

### 案例 9：「把技術細節放進 URL」

```
❌ GET /api/v1/orderService/queryOrderListByPage
❌ GET /rest/json/orders
❌ GET /orders?sql=SELECT...      🔴 這不只是設計問題，是 SQL injection
```

```
✅ GET /v1/orders?page=0&size=20
```

### 案例 10：「同一件事兩條路」

```
❌ 同時存在（而且行為不完全一致）：
   GET /orders/1001/items
   GET /order-items?orderId=1001
   GET /orders/1001?expand=items
```

三條路都能拿到訂單明細。實務後果：

- 三份實作、三份測試、三份文件。
- 三份權限檢查 —— 而且**其中一份忘記檢查訂單所有權**（真實案例，這就是 IDOR 的來源）。
- 前端不知道該用哪個，各自選一個，改動時漏改。
- 效能特性不同（有的有 N+1），使用者抱怨「有時候很慢」。

```
✅ 只留一條主要路徑：
   GET /orders/1001/items                  ← 正規路徑
   GET /orders/1001?expand=items            ← 可選：效能最佳化（減少往返）
   （不提供 /order-items）
```

如果要提供 `?expand=`，它必須是「同一份資料的另一種傳輸方式」，而不是另一套實作。
**同一個 Service 方法，兩種組裝方式。**

---

## 1.14 shop-service 完整 URL 表（定案）

這是本章的產出。第 02 章會為每一條補上完整的方法／狀態碼契約。

### 1.14.1 商品與分類

| 方法 | 路徑 | 說明 | 角色 |
|---|---|---|---|
| `GET` | `/products` | 商品列表（可篩選、搜尋、分頁） | 全部 |
| `GET` | `/products/{productId}` | 商品詳情 | 全部 |
| `POST` | `/products` | 建立商品 | ADMIN |
| `PATCH` | `/products/{productId}` | 部分更新 | ADMIN |
| `PUT` | `/products/{productId}/status` | 上架／下架 | ADMIN |
| `DELETE` | `/products/{productId}` | 軟刪除 | ADMIN |
| `GET` | `/products/{productId}/inventory` | 庫存（單例子資源） | 全部 |
| `POST` | `/products/{productId}/inventory-adjustments` | 庫存調整（有紀錄） | WAREHOUSE |
| `GET` | `/products/{productId}/inventory-adjustments` | 調整紀錄 | WAREHOUSE, ADMIN |
| `GET` | `/products/{productId}/images` | 圖片列表 | 全部 |
| `POST` | `/products/{productId}/images` | 上傳圖片 | ADMIN |
| `DELETE` | `/products/{productId}/images/{imageId}` | 刪圖 | ADMIN |
| `GET` | `/products/{productId}/reviews` | 評價列表 | 全部 |
| `POST` | `/products/{productId}/reviews` | 寫評價 | CUSTOMER |
| `GET` | `/categories` | 分類樹 | 全部 |
| `GET` | `/categories/{categoryId}/products` | 分類下的商品 | 全部 |

### 1.14.2 購物車

| 方法 | 路徑 | 說明 |
|---|---|---|
| `GET` | `/carts/current` | 我的購物車（沒有也回 200 + 空） |
| `DELETE` | `/carts/current` | 放棄整個購物車 |
| `GET` | `/carts/current/items` | 項目列表 |
| `POST` | `/carts/current/items` | 加入商品（同商品則累加數量） |
| `PATCH` | `/carts/current/items/{itemId}` | 改數量 |
| `DELETE` | `/carts/current/items/{itemId}` | 移除一項 |
| `DELETE` | `/carts/current/items` | 清空（保留購物車本體） |
| `PUT` | `/carts/current/coupon` | 套用折扣碼（單例，冪等） |
| `DELETE` | `/carts/current/coupon` | 移除折扣碼 |
| `POST` | `/carts/current/recalculate` | 重算（手法 3，白名單動詞） |

### 1.14.3 訂單

| 方法 | 路徑 | 說明 |
|---|---|---|
| `GET` | `/orders` | 訂單列表（顧客看自己，客服看全部） |
| `POST` | `/orders` | 建立訂單（需 `Idempotency-Key`） |
| `GET` | `/orders/{orderId}` | 訂單詳情 |
| `PATCH` | `/orders/{orderId}` | 改可改的欄位（備註、收件人電話） |
| `GET` | `/orders/{orderId}/items` | 訂單明細 |
| `GET` | `/orders/{orderId}/status-changes` | 狀態變更歷史 |
| `GET` | `/orders/{orderId}/invoice` | 發票資訊（單例子資源） |
| `PUT` | `/orders/{orderId}/invoice` | 設定發票資訊 |

**注意沒有 `DELETE /orders/{orderId}`** —— 訂單永不刪除（1.2.2）。

### 1.14.4 訂單的動作型子資源

| 方法 | 路徑 | 說明 |
|---|---|---|
| `POST` | `/orders/{orderId}/payments` | 付款（需 `Idempotency-Key`） |
| `GET` | `/orders/{orderId}/payments` | 這張訂單的付款紀錄 |
| `POST` | `/orders/{orderId}/cancellations` | 取消訂單 |
| `GET` | `/orders/{orderId}/cancellations` | 取消紀錄（通常 0 或 1 筆） |
| `POST` | `/orders/{orderId}/shipments` | 出貨（WAREHOUSE） |
| `GET` | `/orders/{orderId}/shipments` | 出貨紀錄（可能多筆＝分批出貨） |
| `POST` | `/orders/{orderId}/returns` | 申請退貨 |
| `GET` | `/orders/{orderId}/returns` | 退貨紀錄 |
| `POST` | `/orders/{orderId}/notifications` | 重寄通知 |
| `GET` | `/orders/{orderId}/notifications` | 通知寄送紀錄 |

### 1.14.5 跨訂單的頂層資源

| 方法 | 路徑 | 說明 | 為什麼要頂層 |
|---|---|---|---|
| `GET` | `/payments/{paymentId}` | 單筆付款 | 財務對帳從金流商的報表反查 |
| `GET` | `/payments?status=FAILED&from=...` | 付款查詢 | 「今天所有失敗的付款」 |
| `POST` | `/payments/{paymentId}/refunds` | 退款 | 退款針對付款，不是訂單 |
| `GET` | `/payments/{paymentId}/refunds` | 退款紀錄 | 一筆付款可多次部分退 |
| `GET` | `/shipments/{shipmentId}` | 單筆出貨 | 物流商 webhook 回拋單號 |
| `GET` | `/shipments?status=PENDING` | 待出貨清單 | 倉管的工作佇列 |
| `GET` | `/returns/{returnId}` | 單筆退貨 | — |
| `GET` | `/returns?status=PENDING_APPROVAL` | 待審核退貨 | 客服的工作佇列 |
| `PATCH` | `/returns/{returnId}` | 審核退貨 | 手法 5 |
| `GET` | `/reviews/{reviewId}` | 單筆評價 | 分享連結 |
| `GET` | `/reviews?customerId=me` | 我的評價 | 「我的評價」頁面 |
| `PATCH` | `/reviews/{reviewId}` | 編輯評價 | — |
| `DELETE` | `/reviews/{reviewId}` | 刪除評價 | — |

### 1.14.6 客戶與我

| 方法 | 路徑 | 說明 |
|---|---|---|
| `GET` | `/me` | 我的個人資料（單例） |
| `PATCH` | `/me` | 更新個人資料 |
| `GET` | `/me/addresses` | 我的收件地址 |
| `POST` | `/me/addresses` | 新增地址 |
| `PATCH` | `/me/addresses/{addressId}` | 修改地址 |
| `DELETE` | `/me/addresses/{addressId}` | 刪除地址（軟刪） |
| `PUT` | `/me/addresses/{addressId}/default` | 設為預設（單例，冪等） |
| `GET` | `/me/preferences` | 偏好設定（單例，沒設過回預設值） |
| `PUT` | `/me/preferences` | 更新偏好 |
| `GET` | `/customers` | 客戶列表（SUPPORT） |
| `GET` | `/customers/{customerId}` | 客戶詳情（SUPPORT；或自己） |
| `GET` | `/customers/{customerId}/orders` | 某客戶的訂單（SUPPORT） |

### 1.14.7 工作型資源

| 方法 | 路徑 | 說明 |
|---|---|---|
| `POST` | `/order-exports` | 建立匯出工作 → `202` |
| `GET` | `/order-exports/{exportId}` | 查進度／取下載連結 |
| `GET` | `/order-exports` | 我的匯出歷史 |
| `POST` | `/order-import-jobs` | 建立匯入工作 → `202` |
| `GET` | `/order-import-jobs/{jobId}` | 查進度 |
| `GET` | `/order-import-jobs/{jobId}/errors` | 錯誤明細（分頁） |
| `POST` | `/reconciliation-jobs` | 手動觸發對帳（ADMIN） → `202` |
| `GET` | `/reconciliation-jobs/{jobId}` | 對帳結果 |

### 1.14.8 其他

| 方法 | 路徑 | 說明 |
|---|---|---|
| `POST` | `/auth/tokens` | 登入（見 1.14.10 討論） |
| `DELETE` | `/auth/tokens/current` | 登出 |
| `POST` | `/auth/tokens/refresh` | 刷新 token |
| `GET` | `/coupons/{code}` | 查折扣碼（驗證是否有效） |
| `POST` | `/caches/products/purge` | 清商品快取（ADMIN，手法 3） |
| `GET` | `/actuator/health` | 健康檢查（02-spring-boot 第 05 章） |

### 1.14.9 統計與檢查

```
資源總數：19 個
端點總數：70 條
巢狀最深：2 層（/orders/{id}/items/{itemId}、/me/addresses/{id}/default）
路徑動詞（手法 3）：2 個 —— recalculate、purge  ← 白名單，code review 時要求說明
單例子資源：7 個 —— /carts/current、/carts/current/coupon、/me、/me/preferences、
                    /orders/{id}/invoice、/products/{id}/inventory、
                    /me/addresses/{id}/default
命名檢查：全小寫 ✅、複數 ✅、kebab-case ✅、無副檔名 ✅、無尾斜線 ✅
```

**用第 00 章 0.9.1 的清單自檢**：

```
✅ URL 裡沒有 get/create/update/delete
✅ 讀取全部用 GET
✅ 單複數一致
✅ 沒有 GET 做刪除
✅ 沒有兩條路徑做同一件事
✅ 沒有把 ID 放 body（除了批次端點）
✅ 篩選全部用查詢參數
✅ 深度不超過 2
⚠️ recalculate / purge 是路徑動詞 → 已列入白名單並記錄理由
```

### 1.14.10 補充：`POST /auth/tokens` 還是 `POST /login`？

先前 1.3.1 的表格裡把 `POST /login` 標為「可以接受」，這裡把理由說完。

| 寫法 | 評價 |
|---|---|
| `POST /login` | ⚠️ 路徑是動詞，但**全世界都這樣寫**，consumer 一看就懂。一致性 > 教條 |
| `POST /auth/tokens` | ✅ 資源導向：登入 = **建立一個 token**；登出 = `DELETE /auth/tokens/current` |
| `POST /sessions` | ✅ 資源導向：登入 = 建立一個 session |

**shop-service 選 `/auth/tokens`**，理由：

- 它讓「刷新 token」有自然的位置（`POST /auth/tokens/refresh`）。
- 它讓「列出我的所有登入裝置」有自然的位置（`GET /auth/tokens` → 可以逐一登出）。
- 「登出」變成 `DELETE`，語意正確（`POST /logout` 的語意是「建立一個登出」，很怪）。

但如果你的團隊已經用 `/login` 且全站一致，**不要為了這個改**。
第 00 章判準 2 說得很清楚：一致性比正確性重要。

---

## 1.15 常見誤區

**誤區 1：「一個資源對應一張表」**
第 00 章 0.12 已提，這裡補實例：

```
/orders/{id}          → 讀 orders + order_items + shipments + payments 四張表
/products/{id}        → 讀 products + inventory + product_images + 算平均評分
/carts/current/summary → 完全不讀表，即時算（含促銷規則）
```

**API 的資源邊界應該按「consumer 需要什麼」畫，不是按「資料表怎麼分」畫。**

**誤區 2：「巢狀越多越 RESTful」**
巢狀是為了表達從屬關係，不是為了「看起來很有層次」。
`/customers/9/orders/1001/items/5` 不比 `/orders/1001/items/5` 更 REST，只是更長更脆弱。

**誤區 3：「路徑裡有動詞就一定是錯的」**
90% 是錯的，但有 10% 是合理的逃生門（手法 3）。
重點是**有意識地選擇**，並且列入白名單控制數量。
「零動詞」的教條可能逼你發明 `POST /cart-recalculations` 這種沒人看得懂的名詞 ——
**為了純粹而犧牲可讀性是不划算的。**

**誤區 4：「用 UUID 就安全了」**
1.4.1 已詳述。**UUID 防枚舉，不防未授權存取。**
授權檢查必須存在，而且最好放在查詢條件裡。

**誤區 5：「先做 v1，改壞了再出 v2」**
版本不是免費的。多一個版本 = 多一套程式、測試、文件、監控，而且要維護 N 年。
第 06 章會講：**大部分變更可以用「加欄位」達成，根本不需要 v2。**

**誤區 6：「內部服務的 URL 隨便取就好」**
內部 API 的 consumer 是同事，而且今天的內部 API 常常是明天的對外 API。
更實際的理由：**你三個月後也是自己 API 的 consumer**。

**誤區 7：「批次端點就是把單筆端點的 body 換成陣列」**
批次的難點不是格式，是**部分失敗**（第 04 章 4.11）、**交易邊界**（05-service）、
**超時**（1.12.2）。這三件事都要在設計時就想清楚。

**誤區 8：「`GET /orders` 回全部資料就好，前端自己分頁」**
資料 1,000 筆時能動，100 萬筆時把資料庫和 JVM 一起拖垮。
**任何回集合的端點都必須有預設分頁上限**（第 05 章）。
這是最容易在半年後炸掉的設計缺陷之一。

---

## 1.16 本章練習

### 練習 1：資源盤點

以下是「線上課程平台」的需求。請完成資源盤點（核心／從屬／事件型／工作型／值物件），
並標出哪些「動作其實是名詞」。

```
1.  學生可以瀏覽課程、看課程大綱
2.  學生可以購買課程（可用折扣碼）
3.  學生可以觀看影片，系統要記錄看到第幾秒
4.  學生看完一章可以標記完成
5.  學生可以對課程評分與寫心得
6.  學生可以提問，講師可以回答
7.  學生完成全部章節後可以領取證書
8.  學生可以在 7 天內申請退費
9.  講師可以上傳影片
10. 講師可以看到自己課程的銷售報表
11. 平台可以把課程加入促銷活動
12. 系統每月結算講師分潤
```

<details>
<summary>參考解答</summary>

**核心實體**
```
Course       課程
Student      學生（Customer 的一種）
Instructor   講師
Chapter      章節（可能是核心也可能從屬，見下）
Promotion    促銷活動
Coupon       折扣碼
```

**從屬實體**
```
Lesson       單元／影片   → 屬於 Chapter
Chapter      章節         → 屬於 Course（所以其實是從屬）
```

**事件／紀錄型資源（★ 動詞的產物）**
```
Enrollment       ← 「購買課程」的產物（報名紀錄：何時買、多少錢、有效期）
Payment          ← 「購買」的金流紀錄
Refund           ← 「退費」的產物（有審核流程）
WatchProgress    ← 「記錄看到第幾秒」（每個 lesson 一筆，是單例子資源）
LessonCompletion ← 「標記完成」的產物（何時完成）
Review           ← 「評分寫心得」
Question         ← 「提問」
Answer           ← 「回答」（屬於 Question）
Certificate      ← 「領取證書」的產物（有證書編號、發放時間、可驗證）
VideoUpload      ← 「上傳影片」的產物（有轉檔狀態）
Payout           ← 「結算分潤」的產物（每月一筆，財務要對帳）
```

**工作型資源**
```
SalesReportExport      銷售報表匯出（長時間）
VideoTranscodingJob    影片轉檔工作（很慢，一定非同步）
MonthlyPayoutRun       月結算工作
```

**值物件（不是資源）**
```
Money      金額 + 幣別
Duration   影片長度
Progress   進度百分比（可由 WatchProgress 算出）
```

**「動作其實是名詞」的關鍵題**

| 動作 | 名詞 | 為什麼是資源 |
|---|---|---|
| 購買課程 | `Enrollment` | 有效期、購買價格、是否退費過 —— 全部要查 |
| 領取證書 | `Certificate` | 有證書編號、要能被第三方驗證（`GET /certificates/{id}/verify`） |
| 申請退費 | `Refund` | 有審核狀態、原因、金額、處理人 |
| 上傳影片 | `VideoUpload` | 有轉檔狀態、失敗要重試、要看進度 |
| 結算分潤 | `Payout` | 財務憑證，講師要看明細、要對帳 |
| 標記完成 | `LessonCompletion` | 要算「完課率」，要判斷能不能發證書 |
| 記錄進度 | `WatchProgress` | 續播功能要用；但它是**單例**（每 lesson 一筆） |

**⚠️ 最容易被漏掉的是 `Enrollment`。**
新手會做 `POST /courses/{id}/purchase` 然後在 `student_courses` 表插一筆，
但 API 上沒有這個資源 → 結果「我買過哪些課」「這門課有效期到什麼時候」
「我退費過嗎」全部沒有端點可查，只能硬塞進 `GET /courses?purchased=true` 這種彆扭的設計。

正確做法：
```
POST /enrollments                    購買（body: courseId, couponCode）
GET  /enrollments                    我買過的課
GET  /enrollments/{id}               單筆報名詳情（含有效期、進度）
GET  /enrollments/{id}/progress      這門課的學習進度
```

</details>

### 練習 2：URL 設計

為練習 1 的需求設計完整 URL 表。特別注意：

- 影片進度（單例子資源）
- 提問與回答（雙層巢狀？）
- 證書（要能被外部驗證）
- 退費（審核流程）

<details>
<summary>參考解答</summary>

```http
# ── 課程瀏覽 ─────────────────────────────
GET    /courses?q=java&category=backend&page=0&size=20
GET    /courses/{courseId}
GET    /courses/{courseId}/chapters              大綱（含 lessons，但不含影片 URL）
GET    /courses/{courseId}/reviews
POST   /courses/{courseId}/reviews               寫評價（要先報名，否則 403）

# ── 購買 ─────────────────────────────────
POST   /enrollments                              body: {courseId, couponCode}
                                                 需 Idempotency-Key
GET    /enrollments                              我的報名（?status=ACTIVE）
GET    /enrollments/{enrollmentId}
GET    /enrollments/{enrollmentId}/payments
POST   /enrollments/{enrollmentId}/refunds       申請退費 → 201
GET    /refunds/{refundId}                       查退費狀態
GET    /refunds?status=PENDING_APPROVAL          客服的審核佇列
PATCH  /refunds/{refundId}                       審核 {resolution: APPROVED}（手法 5）

# ── 學習 ─────────────────────────────────
GET    /lessons/{lessonId}                       單元資訊（lessonId 全域唯一 → 不需巢狀）
GET    /lessons/{lessonId}/playback              取得播放憑證（簽名 URL、有效期短）
GET    /lessons/{lessonId}/progress              ★ 單例子資源：我看到第幾秒
PUT    /lessons/{lessonId}/progress              body: {positionSeconds: 421}
                                                 用 PUT 因為冪等（每 10 秒回報一次）
PUT    /lessons/{lessonId}/completion            ★ 標記完成（單例、冪等）
DELETE /lessons/{lessonId}/completion            取消標記
GET    /enrollments/{enrollmentId}/progress      整門課的進度總覽（算出來的）

# ── 問答 ─────────────────────────────────
GET    /lessons/{lessonId}/questions             這個單元的提問
POST   /lessons/{lessonId}/questions             提問
GET    /questions/{questionId}                   單筆（可分享連結）
GET    /questions?instructorId=me&answered=false 講師的待回答佇列 ★
POST   /questions/{questionId}/answers           回答
PATCH  /answers/{answerId}                       修改回答
PUT    /questions/{questionId}/accepted-answer   標記最佳答案（單例、冪等）

# ── 證書 ─────────────────────────────────
POST   /enrollments/{enrollmentId}/certificates  領取證書 → 201
                                                 未完課則 409 Conflict
GET    /certificates/{certificateId}             查證書（需登入）
GET    /certificates/{certificateId}/verification  ★ 公開驗證端點（不需登入）
                                                   回：課程名、學生名、發放日、是否有效
GET    /me/certificates                          我的所有證書

# ── 講師 ─────────────────────────────────
GET    /instructor/courses                       我教的課
POST   /courses                                  建立課程
PATCH  /courses/{courseId}
PUT    /courses/{courseId}/status                上架／下架
POST   /courses/{courseId}/chapters
POST   /chapters/{chapterId}/lessons
POST   /video-uploads                            ★ 要預簽名 URL
POST   /video-uploads/{uploadId}/completions     通知上傳完成 → 觸發轉檔
GET    /video-uploads/{uploadId}                 看轉檔進度
POST   /sales-report-exports                     匯出銷售報表 → 202
GET    /sales-report-exports/{exportId}
GET    /payouts?instructorId=me                  我的分潤紀錄
GET    /payouts/{payoutId}                       單筆分潤明細

# ── 促銷（平台管理） ─────────────────────
GET    /promotions
POST   /promotions
PUT    /promotions/{promotionId}/courses/{courseId}    ★ 加入促銷（關聯，冪等）
DELETE /promotions/{promotionId}/courses/{courseId}    移出促銷
GET    /promotions/{promotionId}/courses               這個促銷有哪些課

# ── 系統 ─────────────────────────────────
POST   /monthly-payout-runs                      手動觸發月結（ADMIN） → 202
GET    /monthly-payout-runs/{runId}
```

**六個設計決策的理由**

| 決策 | 理由 |
|---|---|
| `/lessons/{id}` 不巢狀在 course 下 | `lessonId` 全域唯一（1.5.2）。播放頁只有 lessonId，不需要 courseId |
| 進度用 `PUT /lessons/{id}/progress` | 單例 + 冪等。前端每 10 秒回報一次，`PUT` 重送安全（`POST` 會產生 N 筆） |
| 完成用 `PUT`/`DELETE .../completion` | 冪等。點兩次「標記完成」不該有兩筆紀錄 |
| 證書驗證用獨立的 `/verification` 子資源 | 這是**公開端點**（雇主要驗證），權限和 `GET /certificates/{id}` 完全不同。<br>拆開才能讓一個需要登入、一個不需要，而且回傳的欄位不同（驗證端點不回個資） |
| `GET /questions?instructorId=me&answered=false` 是頂層 | 講師要跨課程看待回答佇列。巢狀路徑做不到 |
| 促銷關聯用 `PUT /promotions/{id}/courses/{id}` | 多對多且無屬性 → 1.6.1 |

**特別注意「證書」的兩個端點**：

```http
GET /certificates/cert_01J5GK...
Authorization: Bearer ...
→ 完整資料（含學生 email、購買金額、完課明細）

GET /certificates/cert_01J5GK.../verification
（不需登入）
→ { "valid": true, "courseName": "Java 後端工程師", "recipientName": "王小明",
     "issuedAt": "2026-08-19", "revoked": false }
   ← 只有驗證需要的最少欄位，不含 email、不含金額
```

**同一個資源、兩種表述、兩種權限。** 這是很實用的一個模式。

</details>

### 練習 3：非 CRUD 動作

以下動作各該用哪一種手法（1～5）？寫出端點並說明理由。

```
1.  把文章置頂
2.  批准一筆 500 萬的採購單（需要簽核意見、可能被駁回）
3.  重設使用者密碼（管理員操作，寄重設信給使用者）
4.  把 5000 個帳號批次停用
5.  合併兩個重複的客戶資料
6.  把訂單的收件地址改掉（未出貨才可以）
7.  觸發一次全站搜尋索引重建
8.  把購物車轉成訂單
9.  延長會員資格 30 天（客服補償用，要留紀錄）
10. 把商品的價格改成 999
```

<details>
<summary>參考解答</summary>

| # | 手法 | 端點 | 理由 |
|---|---|---|---|
| 1 | **5** | `PATCH /articles/{id}` `{"pinned": true}` | 就是一個布林欄位，不需紀錄。<br>⚠️ 但如果需要「置頂到什麼時候」「誰置頂的」→ 升級為手法 2：`POST /articles/{id}/pins` |
| 2 | **2** | `POST /purchase-orders/{id}/approvals`<br>`POST /purchase-orders/{id}/rejections` | 🔴 **必須留紀錄**：誰批的、何時、意見、金額 —— 這是稽核與法遵要求。<br>批准與駁回是**兩個不同的資源**（欄位不同：駁回必填原因）。<br>多級簽核時 `GET /purchase-orders/{id}/approvals` 就是簽核歷程 |
| 3 | **2** | `POST /customers/{id}/password-reset-requests` | 要紀錄（誰重設的、何時、寄到哪個 email、有沒有被使用、幾次）。<br>❌ 不要做 `PUT /customers/{id}/password` —— 管理員不該能直接設定別人的密碼 |
| 4 | **4→D** | `POST /account-deactivation-jobs`<br>body: `{"accountIds": [...]}` 或 `{"filter": {...}}`<br>→ `202` + 輪詢 | 5000 筆一定超時（1.12.2）。<br>而且這是**高風險操作**，需要：進度、可中止、錯誤明細、可能需要 dry-run 預覽 |
| 5 | **2** | `POST /customer-merges`<br>body: `{"primaryId": "cus_1", "duplicateId": "cus_2", "fieldResolutions": {...}}` | 🔴 **極高風險且不可逆**。必須有紀錄（誰合的、合了什麼、原始資料快照），<br>而且要能查詢「這個客戶是被合併掉的，主帳號是誰」。<br>不是巢狀在任一客戶下 —— 它跨兩個客戶，所以是頂層資源 |
| 6 | **5** | `PATCH /orders/{id}` `{"shippingAddress": {...}}`<br>或 `PUT /orders/{id}/shipping-address` | 邊界情況。<br>如果只是改地址 → 手法 5。<br>如果改地址要重算運費、可能改變配送時間、需要通知倉庫 → 已經是流程了，用 `POST /orders/{id}/address-changes`（手法 2） |
| 7 | **3** | `POST /search-index/rebuild` → `202` | 沒有合適名詞（「重建單」很怪）。<br>維運操作，列入動詞白名單。<br>⚠️ 但要防重複觸發：已在跑時回 `409 Conflict` |
| 8 | **2** | `POST /orders` body: `{"cartId": "cart_current"}`<br>（或手法 4 的 `checkout-sessions`） | 「轉成訂單」= 建立訂單。<br>❌ 不要做 `POST /carts/current/convert` —— 產物是訂單，就用建立訂單的端點 |
| 9 | **2** | `POST /memberships/{id}/extensions`<br>body: `{"days": 30, "reason": "SERVICE_ISSUE_COMPENSATION", "ticketId": "T-1234"}` | 🔴 必須留紀錄：這是**送錢**（免費會員時間）。<br>財務要對帳、稽核要查濫用、客服主管要看誰送最多。<br>❌ `PATCH /memberships/{id}` `{"expiresAt": "..."}` 完全查不到原因 |
| 10 | **5 或 2** | 看情境 | 一般改價：`PATCH /products/{id}` `{"price": "999.00"}`（手法 5）。<br>但如果要**歷史價格追溯**（促銷合規、爭議處理、「這件商品上週多少錢」）<br>→ `POST /products/{id}/price-changes`（手法 2），現價由最新一筆決定 |

**這題的核心判準（回到 1.7.1 的流程圖第一問）**：

> **「這個動作需要留下可查詢的紀錄嗎？」**

而「需要紀錄」的四個具體訊號：

1. **涉及錢**（第 9、10 題）→ 財務要對帳
2. **涉及權限或身分**（第 3、5 題）→ 稽核要查
3. **不可逆**（第 5 題）→ 出事要能追溯原始狀態
4. **有審核流程**（第 2 題）→ 流程本身就是資料

**只要命中任一個，就用手法 2。** 這個判準比「它看起來像不像名詞」可靠得多。

</details>

### 練習 4：找出設計問題

以下是某系統的端點清單。找出所有問題並修正。

```
GET    /api/v2/user/{userId}/order/list?status=1
POST   /api/v2/order/submit
GET    /api/v2/order/{id}/detail
POST   /api/v2/order/{id}/pay
POST   /api/v2/order/pay/callback
GET    /api/v2/order/export?start=2026/08/01
POST   /api/v2/order/batchCancel
GET    /api/v2/orders?ids=1,2,3,4,5,...(共 800 個)
DELETE /api/v2/orders
PUT    /api/v2/order/{id}/items/{itemId}/quantity/{qty}
GET    /api/v2/getOrderCount
POST   /api/v2/order/{id}/uploadReceipt   （body 是 base64 圖片，可能 5MB）
```

<details>
<summary>參考解答</summary>

| # | 端點 | 問題 | 修正 |
|---|---|---|---|
| 1 | `/user/{userId}/order/list?status=1` | ① 單數 `user`/`order` ② `list` 多餘 ③ 巢狀 `userId` 多餘且有 IDOR 風險 ④ `status=1` 是魔術數字 ⑤ 無分頁 | `GET /orders?status=PAID&page=0&size=20`（顧客自動限定自己） |
| 2 | `POST /order/submit` | 動詞、單數 | `POST /orders` + `Idempotency-Key` |
| 3 | `GET /order/{id}/detail` | `detail` 多餘、單數 | `GET /orders/{orderId}` |
| 4 | `POST /order/{id}/pay` | 動詞，且付款需要紀錄 | `POST /orders/{orderId}/payments`（手法 2） |
| 5 | `POST /order/pay/callback` | 🔴 **這是金流商的 webhook，混在業務 API 裡** | 移到 `POST /webhooks/payments/{provider}`。<br>它的驗證方式（簽章驗證，非 JWT）、限流、監控、重試策略**完全不同**，<br>必須和業務 API 分開。而且不該有版本前綴（webhook 的版本由對方決定） |
| 6 | `GET /order/export?start=2026/08/01` | ① 同步匯出會超時 ② 日期格式非 ISO ③ 動詞 | `POST /order-exports` body `{"createdFrom":"2026-08-01"}` → `202` + 輪詢 |
| 7 | `POST /order/batchCancel` | 動詞、camelCase 混 kebab | 小批量：`POST /order-cancellation-batches` → `200` + 逐筆結果<br>大批量：`POST /order-cancellation-jobs` → `202` |
| 8 | `?ids=` 800 個 | 🔴 URL 長度爆炸（800 × 20 字元 ≈ 16KB，超過大多數限制） | 改用篩選條件 `GET /orders?status=PAID&createdFrom=...`；<br>或 `POST /order-queries` body 放 ID 陣列（並註明不可快取） |
| 9 | `DELETE /orders`（無參數） | 🔴🔴 **刪除整個集合** —— 手滑就是災難 | 移除這個端點。<br>如果真的需要，強制要求參數且加二次確認：<br>`DELETE /orders?ids=...&confirm=DELETE_3_ORDERS`，<br>無 `ids` 一律 `400` |
| 10 | `PUT /order/{id}/items/{itemId}/quantity/{qty}` | 🔴 **把「值」放在路徑裡** —— 深度 5，而且值變成路徑的一部分 | `PATCH /orders/{orderId}/items/{itemId}` body `{"quantity": 3}`<br>（但訂單成立後明細通常不可改，見 1.2.2 —— 這端點可能根本不該存在） |
| 11 | `GET /getOrderCount` | 動詞、而且「數量」不是資源 | `GET /orders?size=1` 看回應的 `page.totalElements`；<br>或 `HEAD /orders` + `X-Total-Count` header；<br>或（如果真的很需要）`GET /orders/statistics` 回一組統計數字 |
| 12 | `POST /order/{id}/uploadReceipt`（base64 5MB） | ① 動詞 ② base64 膨脹到 6.7MB ③ 記憶體壓力 ④ 可能超過 body 限制 | `POST /orders/{orderId}/receipts` 用 `multipart/form-data`；<br>或預簽名 URL（1.11.1 方案 B） |

**額外的整體問題**

| 問題 | 說明 |
|---|---|
| `/api/v2/` 前綴 | `/api` 是多餘的（如果整個網域都是 API）。版本策略要一致（第 06 章） |
| 單複數全面混用 | `user`/`order`（單數）和 `orders`（複數）並存 |
| 命名風格混用 | `batchCancel`（camel）、`uploadReceipt`（camel）、`order/list`（路徑分隔） |
| webhook 混在業務 API | 第 5 項，這是架構層面的問題 |
| 沒有一條端點有分頁參數 | 全部都會在資料長大後炸掉 |

**修正後的完整清單**

```http
# 業務 API
GET    /v2/orders?status=PAID&page=0&size=20
POST   /v2/orders                                    + Idempotency-Key
GET    /v2/orders/{orderId}
POST   /v2/orders/{orderId}/payments                 + Idempotency-Key
POST   /v2/orders/{orderId}/receipts                 multipart
GET    /v2/orders/{orderId}/items
PATCH  /v2/orders/{orderId}/items/{itemId}           （若業務允許）
POST   /v2/order-exports                             → 202
GET    /v2/order-exports/{exportId}
POST   /v2/order-cancellation-jobs                   → 202
GET    /v2/order-cancellation-jobs/{jobId}
GET    /v2/orders/statistics                         （若真的需要）

# Webhook（獨立路徑、獨立驗證、無版本前綴、獨立監控）
POST   /webhooks/payments/newebpay
POST   /webhooks/payments/ecpay
POST   /webhooks/logistics/{carrier}
```

**為什麼 webhook 要獨立出來（這題最有價值的一點）**

| 面向 | 業務 API | Webhook |
|---|---|---|
| 誰呼叫 | 你的前端／App | **第三方伺服器** |
| 驗證 | JWT / Session | **HMAC 簽章 / IP 白名單** |
| 冪等 | 你要求對方帶 `Idempotency-Key` | **對方會重送，你必須自己去重** |
| 失敗處理 | 回 4xx 讓前端顯示錯誤 | **回非 2xx 對方就重試 —— 所以業務錯誤也要回 200** ⚠️ |
| 限流 | 按使用者 | 不能限流（會漏通知） |
| 監控 | 錯誤率告警 | 「一小時沒收到通知」也要告警 |
| 版本 | 你決定 | **對方決定** |

最關鍵的是「失敗處理」那一列：**webhook 的錯誤語意和一般 API 相反**。
如果你因為「訂單找不到」回 `404`，金流商會認為是傳輸失敗而**不斷重試**（有些會重試 24 小時）。
正確做法是：**收到就回 `200`，把處理丟進佇列**，處理失敗自己記錄與告警。
（這是第 04 章 4.12「不要把系統錯誤標成 4xx」的鏡像情境。）

把它和業務 API 混在一起，這些差異全部會出事。

</details>

### 練習 5：識別碼設計

你要為一個「電子發票系統」設計識別碼。需求：

- 發票號碼必須符合台灣財政部規定：2 個英文字母 + 8 位數字（例如 `AB-12345678`），
  而且**號碼是政府配發的區段，必須連號使用**。
- 系統內部要能高效 join。
- API 對外要能用發票號碼查詢。
- 不能讓競爭對手算出開票量。

請設計識別碼方案並說明。

<details>
<summary>參考解答</summary>

**這題的難點：法規要求「連號」，但連號會洩漏開票量（1.4.1 風險 2）。**
所以必須用**雙識別碼**（1.4.3），而且要理解「連號洩漏」是無法避免的 —— 只能限制誰看得到。

```jsonc
{
  "invoiceId": "inv_01J5GKQ8Z4W9V2X3Y6N7M8P0QR",   // 內部 ID（ULID + 前綴）→ URL 用
  "invoiceNumber": "AB-12345678",                    // 法定發票號碼 → 顯示、查詢用
  "randomCode": "4821",                              // 財政部要求的 4 位隨機碼
  "issuedAt": "2026-08-19T06:12:44Z"
}
```

**端點設計**

```http
GET  /invoices/inv_01J5GK...                    ← 正規路徑（用內部 ID）
GET  /invoices?invoiceNumber=AB-12345678        ← 查詢（客服／使用者輸入發票號碼）
POST /invoices                                   ← 開票（號碼由系統從配號區段取，客戶端不能指定）
```

**為什麼不用 `GET /invoices/AB-12345678`？**（1.4.3 已說明，這裡具體化）

1. 發票號碼有**格式規則**且可能因法規變更（例如未來改成 3 字母），
   把它當 URL 主鍵等於把法規綁進 API 契約。
2. 🔴 **可枚舉**：`AB-12345678` → `AB-12345679` → … 攻擊者可以逐一嘗試。
   如果權限檢查有漏，全站發票外洩。用不可猜的 ULID 當 URL 路徑，降低這個風險面。
3. 一張發票可能被作廢後重開（新號碼），但**內部 ID 應該保持穩定**以維持關聯。

**發票號碼的配號實作（重點）**

```
政府配發區段：AB-12340000 ~ AB-12349999（10000 張）
   ↓
系統維護一個「配號池」資源：
GET  /invoice-number-ranges                     目前有哪些配號區段、用了多少
POST /invoice-number-ranges                     登記新配發的區段（ADMIN）
GET  /invoice-number-ranges/{id}/usage          使用率（快用完要告警）
```

取號必須是**原子操作**（07-mysql 會講）：

```sql
-- ❌ 錯：先讀再寫，併發時會發出重複號碼（重複發票號是稅務違規！）
SELECT next_number FROM invoice_ranges WHERE id = 1;
UPDATE invoice_ranges SET next_number = next_number + 1 WHERE id = 1;

-- ✅ 對：一句 SQL 原子遞增
UPDATE invoice_ranges SET next_number = next_number + 1
WHERE id = 1 AND next_number <= end_number;
-- 檢查 affected rows = 1，然後讀回來（或用 MySQL 8 的 RETURNING 替代方案）
```

**「不讓競爭對手算出開票量」怎麼處理？**

⚠️ 要誠實：**只要對外顯示連號的法定發票號碼，開票量就是可推算的。** 這是法規的必然結果。

能做的是**限制暴露面**：

| 措施 | 說明 |
|---|---|
| API 回應**不包含**未使用的號碼區段資訊 | `/invoice-number-ranges` 只給 ADMIN |
| 發票號碼**只回給該筆交易的當事人** | 別人的發票用內部 ID 也查不到（授權檢查） |
| 對外統計端點**不提供**發票號碼的最大／最小值 | 避免一次請求就算出區間 |
| 使用**多個配號區段輪替**開票 | 讓連號不連續（法規允許同時持有多個區段），大幅增加推算難度 |
| 公開頁面（發票查詢、電子發票載具）加**限流** | 防止大量枚舉（第 08 章） |

**最後一個實務細節**：發票是**法定憑證**，所以：

```
❌ DELETE /invoices/{id}                作廢不是刪除
✅ POST /invoices/{id}/voidings          作廢（手法 2：要紀錄原因、時間、經辦人）
✅ POST /invoices/{id}/allowances        折讓（部分退貨時開折讓單，不是改發票）
```

發票一旦開出就**不可修改、不可刪除**（1.2.2 的「不可改欄位」）。
要改只能作廢重開或開折讓單 —— 這是稅法要求，直接決定了 API 設計。

**這題的總結**：好的識別碼設計不只是技術選擇，
它同時受到**法規**、**資安**、**效能**、**可讀性**四方面約束，而且這些約束會互相衝突。
專業的做法是把衝突攤開來、明確說出「哪一項我們選擇不完全滿足」，而不是假裝沒有衝突。

</details>

---

## 1.17 驗收清單

- [ ] 我能用「找名詞 → 定生命週期 → 定關係」三步法完成資源盤點。
- [ ] 我知道「值物件」（金額、時間長度）不需要自己的 URL，判準是「有沒有自己的身分」。
- [ ] 我知道「快照 vs 參照」的差別，也知道訂單的收件地址必須是快照。
- [ ] 我能背出 URL 命名十條規則，並在 code review 時一眼看出違規。
- [ ] 我知道「路徑做篩選」會造成組合爆炸，也知道判斷法是「這個能不指定嗎」。
- [ ] 我能說出自增 ID 的三個風險，並且知道 **UUID 不能修好 IDOR**。
- [ ] 我知道授權檢查應該放進**查詢條件**（`findByIdAndCustomerId`），而不是事後 if。
- [ ] 我能區分內部 ID 與對外編號，並說出各自的需求為什麼衝突。
- [ ] 我知道 ID 在 JSON 裡一律用字串，並能說出 `MAX_SAFE_INTEGER` 的問題。
- [ ] 我知道巢狀深度不超過 2，也知道「子資源 ID 全域唯一就不需要完整父路徑」。
- [ ] 我知道巢狀路徑用於「建立與列表」，頂層路徑用於「單筆與跨父查詢」，且不重複提供同功能。
- [ ] 我能說出非 CRUD 動作的五種手法，並用決策流程圖選出該用哪一種。
- [ ] 我知道判斷「要不要留紀錄」的四個訊號：涉及錢、涉及權限、不可逆、有審核流程。
- [ ] 我能解釋為什麼「調整庫存」要用 `inventory-adjustments` 而不是 `PATCH` 改 `stock`。
- [ ] 我知道單例子資源用單數、用 `PUT`、沒有 ID 段，也知道什麼時候該回 200 + 預設值而不是 404。
- [ ] 我能說出路徑／查詢／Header／Body 各放什麼，也知道敏感資料絕不進 URL（含 `Referer` 洩漏）。
- [ ] 我知道 `GET` 不該有 body，也知道複雜查詢的四種替代方案。
- [ ] 我知道多租戶的租戶識別**必須以 token claim 為權威**，路徑／Header 只是輔助。
- [ ] 我知道大檔上傳要用預簽名 URL，也知道 base64 塞 JSON 會膨脹 33% 且無法串流。
- [ ] 我能按批量選擇批次操作的四種做法，並知道「超時設定不是解法，非同步才是」。
- [ ] 我知道 webhook 必須和業務 API 分開，因為它的驗證、冪等、失敗語意完全相反。
- [ ] 我完成了 shop-service 的 70 條端點表，並能解釋每一條的設計理由。

---

完成後請前往 [02-http-methods-and-status-codes.md](./02-http-methods-and-status-codes.md)。
