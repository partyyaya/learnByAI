# 第 02 章：HTTP 方法與狀態碼

> 這一章的內容是**免費效能與免費可靠性**。
> 方法選對，網路超時就可以安全重試、CDN 就會幫你擋流量；
> 狀態碼選對，監控就自動算出錯誤率、客戶端函式庫就自動幫你刷新 token、重試、退避。
> 全部不用寫程式。
> 選錯呢？你會親手把這些好處丟掉，然後花三個月自己重建一個更爛的版本。

---

## 2.1 學習目標

完成本章後，你應該可以：

- 精確定義「安全（safe）」與「冪等（idempotent）」，並說出它們各自保護了誰。
- 說出九個 HTTP 方法的語意，以及每一個常見的誤用。
- 完整解釋 `PUT` 與 `PATCH` 的差別，包含 `PATCH` 的三種格式與 `null` 三態問題。
- 決定 `DELETE` 第二次呼叫該回 `204` 還是 `404`，並說出理由。
- 用一張決策樹在 10 秒內選出正確的狀態碼。
- 分辨最容易搞錯的六組狀態碼：401/403、400/422、404/403、409/422、200/204、502/503/504。
- 設計長時間操作的 `202 Accepted` + 輪詢契約。
- 用 `ETag` + `If-Match` 實作樂觀鎖，避免兩個人同時改資料互相覆蓋。
- 說出「全部回 200」在架構上造成的五個具體損失。
- 完成 shop-service 每個端點的方法 + 狀態碼契約表。

---

## 2.2 兩個關鍵屬性：安全性與冪等性

這兩個詞是本章的地基。搞清楚它們，後面所有決定都會變得顯而易見。

### 2.2.1 定義

| 屬性 | 定義 | 白話 |
|---|---|---|
| **安全（safe）** | 不會改變伺服器狀態（唯讀） | 「我只是看看，不會動到任何東西」 |
| **冪等（idempotent）** | 執行一次和執行 N 次，對伺服器狀態的**結果相同** | 「重送不會有副作用」 |

**兩個常見的誤解要先破除**：

**誤解 1：「冪等 = 每次回傳一樣的內容」**

❌ 錯。冪等講的是**伺服器狀態**，不是**回應內容**。

```
DELETE /orders/1001   第一次 → 204（訂單被刪了）
DELETE /orders/1001   第二次 → 404（訂單已經不在了）
```

回應不同，但**伺服器狀態相同**（訂單不存在）→ **它是冪等的**。

```
GET /orders           第一次 → 5 筆
GET /orders           第二次 → 6 筆（別人剛下單）
```

回應不同，但**這個請求本身沒有改變任何狀態** → **它是安全且冪等的**。

**誤解 2：「安全的方法一定冪等」**

✅ 這個方向是對的（安全 ⟹ 冪等），因為「什麼都不改」當然重複做也不改。
但反過來不成立：`PUT` 和 `DELETE` 冪等但不安全。

### 2.2.2 九個方法的屬性表

| 方法 | 安全 | 冪等 | 可快取 | 有請求 body | 用途 |
|---|---|---|---|---|---|
| `GET` | ✅ | ✅ | ✅ | ❌（語意未定義） | 讀取 |
| `HEAD` | ✅ | ✅ | ✅ | ❌ | 只要 header |
| `OPTIONS` | ✅ | ✅ | ❌ | ⚠️ 可以但少用 | 查詢支援的方法 / CORS preflight |
| `TRACE` | ✅ | ✅ | ❌ | ❌ | 診斷（實務上應**關閉**） |
| `POST` | ❌ | ❌ | ⚠️ 極少（需明確 `Cache-Control`） | ✅ | 建立 / 非冪等動作 |
| `PUT` | ❌ | ✅ | ❌ | ✅ | 全量替換 |
| `PATCH` | ❌ | ❌ ※ | ❌ | ✅ | 部分更新 |
| `DELETE` | ❌ | ✅ | ❌ | ⚠️ 可以但少用 | 刪除 |
| `CONNECT` | ❌ | ❌ | ❌ | — | 建立通道（代理用，API 不用） |

※ `PATCH` **依規範不保證冪等**，但**你可以把它設計成冪等**（見 2.5.5）。
這是最容易被誤解的一格。

> ⚠️ **`TRACE` 要關閉。** 它會把請求原樣回傳，歷史上有 **Cross-Site Tracing（XST）**
> 攻擊可以用它繞過 `HttpOnly` cookie 保護。現代瀏覽器已封鎖，但伺服器層面關掉更保險。

### 2.2.3 這兩個屬性保護了誰

這是本節最重要的部分。**安全性與冪等性不是學術定義，它們是實際的行為契約，而且有很多角色依賴它。**

| 誰 | 依賴什麼 | 你違約的後果 |
|---|---|---|
| **瀏覽器** | `GET` 安全 → 可以預取（prefetch）、可以在「上一頁」時重播 | `GET /deleteOrder` 被預取 → 資料被刪 |
| **搜尋引擎爬蟲** | `GET` 安全 → 可以隨意抓取所有連結 | 爬蟲把後台資料掃光（第 00 章 0.3.1 的 Google Web Accelerator 事故） |
| **CDN / 代理快取** | `GET` 安全且可快取 | 快取了會變動的資料 → 使用者看到舊資料，或看到別人的資料 |
| **HTTP 客戶端函式庫** | `GET`/`PUT`/`DELETE` 冪等 → **超時後自動重試** | `POST` 被重試 → 重複下單、重複扣款 |
| **反向代理（Nginx）** | 同上，`proxy_next_upstream` 預設會重試冪等方法 | 同上 |
| **服務網格（Istio/Envoy）** | 同上，retry policy 預設只重試冪等方法 | 同上 |
| **手機 App 的網路層** | 同上（iOS `URLSession`、Android OkHttp 都有重試邏輯） | 同上 |
| **API Gateway** | 方法 + URL → 做權限與限流 | 全部 `POST /api` 就無法區分讀寫權限 |
| **使用者** | `GET` 安全 → 可以按 F5 重新整理、可以加書籤 | 重新整理就多下一張單 |
| **監控系統** | 方法 + 狀態碼 → 算錯誤率 | 見 2.12 |

### 2.2.4 真實事故：非冪等的重試

這是最常見的生產事故類型之一，值得完整走一遍。

```
時間軸：
T+0.0s  App 送出 POST /orders（建立訂單）
T+0.5s  後端收到，開始處理
T+2.0s  訂單建立成功，扣款成功，寫入資料庫
T+2.1s  後端開始回傳 201 Created
        ↓
T+2.1s  💥 手機從 Wi-Fi 切到 4G，TCP 連線斷掉
        ↓
T+2.1s  App 的網路層：「我沒收到回應，超時了」
T+2.2s  App 自動重試 POST /orders
T+4.0s  後端又建立了一張訂單，又扣了一次款
        ↓
結果：使用者被扣兩次錢，收到兩張訂單，客服接到投訴
```

**注意這裡沒有任何一方有 bug。** App 的重試是合理的（網路不穩就該重試），
後端的處理也是正確的（收到請求就建單）。
問題出在**`POST` 不冪等，但被重試了**。

**三種解法**：

| 解法 | 做法 | 適用 |
|---|---|---|
| **A. 冪等鍵**（★ 推薦） | 客戶端產生 `Idempotency-Key`，伺服器記住「這個 key 處理過了，直接回上次的結果」 | 所有非冪等的關鍵操作（下單、付款、退款） |
| **B. 改用 `PUT` + 客戶端決定 ID** | `PUT /orders/{clientGeneratedUlid}` → 天生冪等 | 客戶端能產生唯一 ID 時 |
| **C. 業務層去重** | 「同一使用者 5 秒內同金額同商品的訂單視為重複」 | ⚠️ 治標，會誤殺（有人真的想買兩份） |

冪等鍵的完整實作在第 08 章，這裡先看契約長什麼樣：

```http
POST /orders
Idempotency-Key: 8f14e45f-ea36-4a1b-9c2e-77e8f1a3b0c1
Content-Type: application/json

{ "items": [{"productId":"P-1001","quantity":2}] }
```

```http
第一次 → 201 Created
         Location: /orders/ord_01J5GK...

重試   → 200 OK                                    ← 注意不是 201
         Idempotent-Replay: true
         Location: /orders/ord_01J5GK...            ← 同一張訂單
         （body 與第一次相同）
```

**規則**：任何「執行兩次會出事」的 `POST` 都必須支援冪等鍵。
shop-service 的清單：

```
POST /orders                          下單 → 重複 = 多一張訂單
POST /orders/{id}/payments            付款 → 重複 = 多扣一次錢 🔴
POST /payments/{id}/refunds           退款 → 重複 = 多退一次錢 🔴
POST /orders/{id}/cancellations       取消 → 重複 = 可能多退一次款
POST /orders/{id}/shipments           出貨 → 重複 = 多一張物流單、多付運費
POST /enrollments                     購買 → 重複 = 多買一次

不需要冪等鍵：
POST /orders/{id}/notifications       重寄通知（本來就是「再寄一次」，重複是預期行為）
POST /carts/current/items             加購物車（同商品累加是可接受的；且金額低、可修正）
POST /products/{id}/reviews           寫評價（重複會被業務規則擋掉：一人一則）
```

---

## 2.3 `GET`

### 2.3.1 語意與規則

```http
GET /orders/1001
GET /orders?status=PAID&page=0&size=20
```

**鐵律：`GET` 絕對不能改變狀態。**

「絕對」的意思是包含這些看起來無害的例子：

| 看起來無害的副作用 | 為什麼還是不行 |
|---|---|
| 「順手」把訂單標記為已讀 | 爬蟲一掃，全部變已讀 |
| 記錄「這個商品被瀏覽了幾次」 | ⚠️ 灰色地帶，見下 |
| 「順手」建立一筆不存在的資料（lazy init） | 爬蟲一掃，資料庫多出幾萬筆垃圾 |
| 「順手」延長 session 有效期 | 較無害，但仍要注意快取 |
| 「順手」消耗一次「免費試用額度」 | 使用者重新整理就少一次額度 🔴 |

**「瀏覽次數」的灰色地帶要說清楚**：

RFC 9110 對 safe 的定義是「不預期造成**客戶端要為之負責**的狀態改變」。
統計計數這種**與請求語意無關的副作用**通常被接受（實務上大家都這樣做），
但要注意：

- 這個計數會被爬蟲、預取、快取穿透污染 → 數字不準。
- 更好的做法：**非同步**送事件（打點），而不是在請求處理中同步 `UPDATE`。
  這樣既不影響回應時間，也可以在事件層面過濾機器流量。

```java
// ❌ 在 GET 處理中同步更新（拖慢回應、被爬蟲污染、可能造成熱點行鎖競爭）
@GetMapping("/products/{id}")
public ProductDetail get(@PathVariable String id) {
    productRepo.incrementViewCount(id);      // 每次 GET 都一次 UPDATE
    return service.findById(id);
}

// ✅ 非同步打點（02-spring-boot 第 06 章的事件機制）
@GetMapping("/products/{id}")
public ProductDetail get(@PathVariable String id) {
    events.publishEvent(new ProductViewed(id, currentUserOrNull(), clock.instant()));
    return service.findById(id);
}
```

### 2.3.2 `GET` 不要有 body

第 01 章 1.9.2 已詳述。複習關鍵原因：

- `fetch()` / `XMLHttpRequest` **規範層面禁止**。
- 快取鍵不含 body → 不同條件拿到同一份快取（**錯誤資料**）。
- 部分代理會丟掉 body。

### 2.3.3 回應狀態碼

| 狀態碼 | 情境 |
|---|---|
| `200 OK` | 成功（集合為空也是 `200` + `[]`，**不是 `204`，不是 `404`**） |
| `206 Partial Content` | 回應 `Range` 請求（大檔下載、影片串流） |
| `304 Not Modified` | 客戶端帶了 `If-None-Match`/`If-Modified-Since` 且資料沒變 |
| `400 Bad Request` | 查詢參數格式錯（`?page=abc`） |
| `401 Unauthorized` | 沒帶憑證或憑證無效 |
| `403 Forbidden` | 有身分但無權限 |
| `404 Not Found` | 資源不存在 |
| `406 Not Acceptable` | 客戶端要求 `Accept: application/xml` 但你只有 JSON |
| `410 Gone` | 資源曾經存在但已永久移除（軟刪除的資源） |
| `429 Too Many Requests` | 超過限流 |

**「空集合回什麼」是高頻錯誤**：

```jsonc
// ✅ 正確：200 + 空陣列
HTTP/1.1 200 OK
{ "items": [], "page": { "number": 0, "size": 20, "totalElements": 0 } }

// ❌ 404 —— 集合本身存在，只是沒有成員。前端要多寫一個 catch
// ❌ 204 No Content —— 前端拿不到分頁資訊，而且要多一個分支
// ❌ 200 + null —— 前端 items.map() 直接爆掉
```

**判準**：`GET /orders/9999`（單一資源不存在）→ `404`。
`GET /orders?status=CANCELLED`（沒有符合的）→ `200` + `[]`。
**集合端點永遠回 200**，因為「集合」這個資源存在。

---

## 2.4 `POST`

### 2.4.1 三種用途

`POST` 是最萬用也最容易被濫用的方法。它有三種正當用途：

**用途 1：往集合新增成員（最常見）**

```http
POST /orders
Content-Type: application/json
Idempotency-Key: 8f14e45f-ea36-4a1b-9c2e-77e8f1a3b0c1

{ "items": [{"productId":"P-1001","quantity":2}], "shippingAddressId": "addr_1" }
```

```http
HTTP/1.1 201 Created
Location: /orders/ord_01J5GKQ8Z4W9V2X3Y6N7M8P0QR
Content-Type: application/json

{
  "orderId": "ord_01J5GKQ8Z4W9V2X3Y6N7M8P0QR",
  "orderNumber": "ORD-20260819-0001",
  "status": "PENDING_PAYMENT",
  "totalAmount": "1280.50",
  "currency": "TWD",
  "createdAt": "2026-08-19T06:12:44Z",
  "expiresAt": "2026-08-19T06:42:44Z",
  "allowedActions": ["PAY", "CANCEL"]
}
```

**`201` 的三條規則**：

| 規則 | 說明 |
|---|---|
| 必須有 `Location` header | 指向新建立資源的 URI。這是 RFC 9110 的規定，也是客戶端拿到 ID 最可靠的方式 |
| body 應該回傳建立的資源 | 省掉客戶端再打一次 `GET`。⚠️ 除非資源很大，那就只回 `Location` + 最小識別 |
| `Location` 用**絕對路徑或完整 URL** | `/orders/ord_1`（絕對路徑）✅；`orders/ord_1`（相對）⚠️ 容易解析錯 |

**用途 2：執行非冪等的動作（第 01 章手法 2、手法 3）**

```http
POST /orders/1001/cancellations
POST /orders/1001/payments
POST /caches/products/purge
```

**用途 3：安全地傳送不該進 URL 的資料**

```http
POST /auth/tokens
{ "email": "a@b.com", "password": "..." }        ← 絕不能用 GET（第 01 章 1.9.2 規則 1）
```

### 2.4.2 `POST` 的回應狀態碼

| 狀態碼 | 情境 |
|---|---|
| `201 Created` | 建立了新資源（**必須**帶 `Location`） |
| `200 OK` | 動作執行完成但沒有建立新資源；或冪等重播 |
| `202 Accepted` | 已接受但尚未完成（非同步，見 2.10） |
| `204 No Content` | 動作完成且沒有東西要回（少見；通常還是回 `200` + 結果比較好用） |
| `303 See Other` | 傳統網頁的 POST-Redirect-GET 模式（API 少用） |
| `400 Bad Request` | body 格式錯（不是合法 JSON、缺必填欄位） |
| `401 / 403` | 認證 / 授權 |
| `404 Not Found` | 父資源不存在（`POST /orders/9999/payments`） |
| `409 Conflict` | 與當前狀態衝突（訂單已出貨不能取消） |
| `415 Unsupported Media Type` | `Content-Type` 不支援 |
| `422 Unprocessable Content` | 格式對但業務驗證失敗（見 2.9.2） |
| `429 Too Many Requests` | 限流 |

### 2.4.3 常見錯誤

**錯誤 1：`POST` 成功卻回 `200` 而不是 `201`**

不算大錯，但失去了「是否建立了新資源」這個訊號。
而且 `Location` header 通常也就跟著漏掉了 → 客戶端只能從 body 挖 ID（如果有的話）。

**錯誤 2：`201` 但沒有 `Location`**

```http
HTTP/1.1 201 Created
{ "id": "ord_1" }        ← 客戶端要自己拼 URL：'/orders/' + id
```

問題：客戶端把 URL 拼接規則寫死了。如果哪天路徑改成 `/v2/orders/{id}`，客戶端全要改。

**錯誤 3：用 `POST` 做讀取**

```
❌ POST /orders/search    body: { "status": "PAID" }
```

失去快取、失去可分享連結、失去瀏覽器前後頁。第 01 章案例 3 已詳述。

**錯誤 4：`POST` 用於本該冪等的操作**

```
❌ POST /articles/{id}/like       按讚
❌ POST /articles/{id}/unlike     取消讚
```

```
✅ PUT    /articles/{id}/like     冪等：按幾次都是一個讚
✅ DELETE /articles/{id}/like     冪等：取消幾次都是沒讚
```

網路不穩重送三次，`POST` 版本可能變成三個讚（如果沒做去重），`PUT` 版本永遠是一個。

---

## 2.5 `PUT` vs `PATCH` ★ 本章最容易出錯的地方

### 2.5.1 `PUT` 是「全量替換」

```http
PUT /me/addresses/addr_1
Content-Type: application/json

{
  "recipient": "王小明",
  "phone": "0912345678",
  "postalCode": "10491",
  "line1": "台北市中山區民生東路三段 10 號 5 樓"
}
```

**`PUT` 的語意是「把這個 URI 的資源替換成我送的這份表述」。**

所以：**沒送的欄位會被清空。**

```
資料庫原本：
  recipient  = "王小明"
  phone      = "0912345678"
  postalCode = "10491"
  line1      = "台北市中山區民生東路三段 10 號 5 樓"
  line2      = "請放管理室"          ← 客戶原本填的
  note       = "假日不在"            ← 客戶原本填的

送出上面那個 PUT（沒有 line2 和 note）後：
  line2 = null      ← 被清空了 🔴
  note  = null      ← 被清空了 🔴
```

**這是 `PUT` 最常造成的生產事故。** 典型的觸發路徑：

```
1. 前端做「編輯地址」表單，只顯示 4 個欄位（漏了 line2、note）
2. 使用者只改了電話號碼
3. 前端把表單的 4 個欄位 PUT 上去
4. line2 和 note 靜默消失
5. 出貨時「請放管理室」的備註不見了 → 包裹被退回
```

**兩種正確做法**：

| 做法 | 說明 |
|---|---|
| **A. 前端先 `GET` 再 `PUT`** | 拿完整資源 → 改動要改的欄位 → 把**完整**資源送回。⚠️ 要配合 `If-Match` 防止覆蓋別人的修改（2.11） |
| **B. 改用 `PATCH`** | 只送要改的欄位 ✅ 推薦 |

### 2.5.2 `PUT` 的正當用途

`PUT` 不是「不要用」，它在四種情境下是最佳選擇：

**用途 1：單例子資源（第 01 章 1.8）**

```http
PUT /orders/1001/invoice           發票資訊只有一份，整份替換很自然
PUT /me/preferences                偏好設定整份替換
PUT /carts/current/coupon          一個折扣碼
```

**用途 2：關聯的建立（冪等）**

```http
PUT    /orders/1001/tags/vip       貼標籤（冪等）
PUT    /articles/{id}/like         按讚（冪等）
PUT    /me/addresses/{id}/default  設為預設（冪等）
```

**用途 3：客戶端決定 ID 的 upsert**

```http
PUT /products/P-1001
{ "name": "無線耳機", "price": "1280.00", ... }

不存在 → 201 Created（建立）
已存在 → 200 OK（替換）
```

**這是同步／匯入場景的最佳做法**。
廠商的 ERP 每小時同步一次商品，用 `PUT /products/{sku}`：
重跑一百次結果一樣，中斷後可以整批重跑，不用先查「這個 SKU 存在嗎」。

**⚠️ 注意 upsert 的權限陷阱**：`PUT /products/P-9999`（不存在）會建立資源。
如果權限檢查寫成「只能改自己的商品」，而檢查邏輯是「查出來看 ownerId」，
那不存在的資源查不到 → 檢查跳過 → **任何人都能建立任意 SKU 的商品**。
必須明確區分「建立權限」和「修改權限」。

**用途 4：狀態轉換（第 01 章手法 1）**

```http
PUT /products/P-1001/status
{ "status": "ACTIVE" }
```

### 2.5.3 `PATCH` 的三種格式

`PATCH` 的 RFC（5789）只定義了「送一份**修改指示**」，**沒有定義格式**。
所以你必須用 `Content-Type` 說清楚你送的是哪一種。

#### 格式 A：JSON Merge Patch（RFC 7396）★ 最常用

`Content-Type: application/merge-patch+json`

```http
PATCH /me/addresses/addr_1
Content-Type: application/merge-patch+json

{ "phone": "0987654321" }        ← 只改電話，其他欄位不動
```

**清空欄位用 `null`**：

```http
PATCH /me/addresses/addr_1
Content-Type: application/merge-patch+json

{ "note": null }                 ← 明確清空 note
```

**規則**：

| 送的內容 | 效果 |
|---|---|
| 欄位不出現 | 不動 |
| 欄位 = 值 | 設成該值 |
| 欄位 = `null` | **刪除該欄位** |
| 巢狀物件 | **遞迴合併** |
| 陣列 | **整個替換**（無法「只加一個元素」）⚠️ |

**陣列不能部分修改是 Merge Patch 最大的限制**：

```http
# 原本 tags 是 ["vip", "urgent"]
PATCH /orders/1001
Content-Type: application/merge-patch+json

{ "tags": ["vip"] }              ← 結果是 ["vip"]，urgent 被移除
                                    無法表達「只移除 urgent」
```

解法：要嘛用格式 B，要嘛把陣列元素變成子資源（`DELETE /orders/1001/tags/urgent`）。
**第二種通常更好**（第 01 章 1.6.1）。

#### 格式 B：JSON Patch（RFC 6902）

`Content-Type: application/json-patch+json`

```http
PATCH /orders/1001
Content-Type: application/json-patch+json

[
  { "op": "replace", "path": "/internalNote", "value": "客戶要求提前出貨" },
  { "op": "add",     "path": "/tags/-",       "value": "urgent" },
  { "op": "remove",  "path": "/couponCode" },
  { "op": "test",    "path": "/status",       "value": "PAID" }
]
```

六種操作：`add`、`remove`、`replace`、`move`、`copy`、`test`。

**`test` 操作很有用**：它是斷言。如果 `/status` 不是 `PAID`，整個 patch 失敗（回 `409`）。
這是一種**輕量的樂觀鎖**。

**優點**：表達力最強（可以精確操作陣列元素）。
**缺點**：
- 客戶端要組出這個結構，前端不喜歡。
- 後端要實作完整的 JSON Pointer 解析（Java 有 `zjsonpatch`、`json-patch` 等函式庫）。
- **極難驗證**：Bean Validation 是針對「物件」的，不是針對「操作序列」的。
  你必須先套用 patch 得到結果物件，再驗證那個物件。
- 錯誤訊息很難對應回使用者的表單欄位。

**判斷**：只有在需要精確操作大型陣列時才用。**shop-service 不用它。**

#### 格式 C：自訂部分更新（實務最常見，但要誠實標示）

```http
PATCH /orders/1001
Content-Type: application/json         ← ⚠️ 沒說是哪種 patch

{ "internalNote": "客戶要求提前出貨" }
```

大部分團隊實際上在做這個：**行為和 Merge Patch 幾乎一樣，但 `Content-Type` 用 `application/json`**。

**問題**：`null` 的語意沒有定義。

```http
PATCH /me/addresses/addr_1
Content-Type: application/json

{ "note": null }
```

這是「清空 note」還是「不要動 note」？**沒有標準答案，取決於你的實作。**
而且 Java 的 Jackson 預設會把「沒出現的欄位」和「`null`」都變成 Java 的 `null` ——
**兩者無法區分**（見 2.5.4）。

**建議**：
- 如果你的 `PATCH` 行為就是 Merge Patch，**就宣告 `Content-Type: application/merge-patch+json`**，
  同時也接受 `application/json`（向下相容）。這讓契約明確。
- 在 OpenAPI 裡把它寫清楚。

### 2.5.4 `null` 三態問題（Java 實作的核心難題）

這是後端最實際的痛點。三種輸入，Java 收到的都可能是 `null`：

| 客戶端送的 | 意圖 | Jackson 反序列化後 |
|---|---|---|
| `{}` | 不要動 `note` | `note == null` |
| `{"note": null}` | 清空 `note` | `note == null` ← **一樣！** |
| `{"note": ""}` | 設成空字串 | `note == ""` |

前兩者你**分不出來**，所以你無法正確實作 Merge Patch。

**解法 1：`JsonNullable`（OpenAPI 生態的標準做法）★**

```xml
<dependency>
    <groupId>org.openapitools</groupId>
    <artifactId>jackson-databind-nullable</artifactId>
    <version>0.2.6</version>
</dependency>
```

```java
import org.openapitools.jackson.nullable.JsonNullable;

public class UpdateAddressRequest {
    // 三態：未出現 / null / 有值
    private JsonNullable<String> note = JsonNullable.undefined();
    private JsonNullable<String> phone = JsonNullable.undefined();

    // getter / setter 略
}
```

```java
// Service 層套用
public void apply(UpdateAddressRequest req, Address entity) {
    if (req.getNote().isPresent()) {              // 欄位出現在 JSON 裡
        entity.setNote(req.getNote().get());      // 可能是 null（清空）或有值
    }
    // 沒出現 → isPresent() == false → 完全不動
}
```

需要註冊模組：

```java
@Bean
JsonNullableModule jsonNullableModule() {
    return new JsonNullableModule();
}
```

**解法 2：`Optional<Optional<T>>`（不推薦）**

語意正確但難讀到不行，而且 Jackson 需要額外設定。看過一次就會知道為什麼不要。

**解法 3：直接用 `JsonNode` / `Map` 手動處理**

```java
@PatchMapping(value = "/me/addresses/{id}",
              consumes = "application/merge-patch+json")
public AddressResponse patch(@PathVariable String id,
                             @RequestBody ObjectNode patch) {
    Address entity = repo.findByIdAndCustomerId(id, currentCustomerId())
                         .orElseThrow(() -> new ResourceNotFoundException("address", id));

    if (patch.has("note")) {                              // 明確區分「有出現」
        JsonNode v = patch.get("note");
        entity.setNote(v.isNull() ? null : v.asText());    // 和「值是 null」
    }
    if (patch.has("phone")) {
        JsonNode v = patch.get("phone");
        if (v.isNull()) throw new ValidationException("phone", "電話為必填，不可清空");
        entity.setPhone(v.asText());
    }
    return mapper.toResponse(repo.save(entity));
}
```

**優點**：完全掌控、真正符合 Merge Patch 語意、可以逐欄位判斷「可不可以清空」。
**缺點**：失去 Bean Validation 的自動驗證（要自己寫），程式較囉唆。

**解法 4：迴避問題（務實派，也是很多團隊的選擇）**

**規定「`null` 一律視為『不要動』，清空欄位用專用端點或空字串」。**

```http
PATCH  /me/addresses/addr_1  {"note": ""}      ← 用空字串表示清空
DELETE /me/addresses/addr_1/note                ← 或用專用端點清空
```

**把限制寫進文件**，然後在 code review 時確認前端知道。
這犧牲了一點語意純度，但省下大量實作複雜度。

**shop-service 的決定**：

| 情境 | 選擇 |
|---|---|
| 可為 `null` 的選填欄位（`note`、`internalNote`、`line2`） | 解法 1（`JsonNullable`） |
| 不可為 `null` 的欄位（`phone`、`recipient`） | 普通型別 + `@NotBlank`（送 `null` 就是驗證錯誤，回 `422`） |
| 複雜的巢狀 patch | 解法 3（`ObjectNode` 手動） |

並在 OpenAPI 裡對每個可清空的欄位標 `nullable: true`。

### 2.5.5 `PATCH` 可以做成冪等的

規範說 `PATCH` **不保證**冪等，但這不代表你的 `PATCH` 一定不冪等。

```http
# 冪等：送幾次結果都一樣
PATCH /orders/1001
{ "internalNote": "客戶要求提前出貨" }

# 不冪等：每次都 +1
PATCH /products/P-1001
{ "stockDelta": -5 }              ← 這種相對運算不冪等
```

**建議：把 `PATCH` 設計成冪等的**（用絕對值而不是相對值）。
需要相對運算時，用 `POST` + 專用子資源（第 01 章的 `inventory-adjustments`）+ 冪等鍵。

### 2.5.6 `PUT` vs `PATCH` 決策表

| 情境 | 用 | 理由 |
|---|---|---|
| 表單有全部欄位，使用者可能清空任一個 | `PUT` | 全量替換語意正確；配合 `If-Match` |
| 只改一兩個欄位（「改電話」「加備註」） | `PATCH` | 不會誤清其他欄位 |
| 單例子資源（發票、偏好設定） | `PUT` | 概念上就是「設定這一份」 |
| 關聯建立／解除（標籤、按讚、設預設） | `PUT`/`DELETE` | 冪等 |
| 客戶端決定 ID 的匯入／同步 | `PUT` | upsert 冪等，可整批重跑 |
| 狀態轉換（單純改狀態，無副作用） | `PUT .../status` | 冪等 |
| 狀態轉換（有副作用：退款、通知、還庫存） | `POST .../動作s` | 第 01 章手法 2 |
| 相對運算（`+5`、`-3`） | `POST .../adjustments` | 不冪等，要冪等鍵與紀錄 |

**一句話**：**改「整份」用 `PUT`，改「幾個欄位」用 `PATCH`，改「狀態且有副作用」用 `POST` 子資源。**

---

## 2.6 `DELETE`

### 2.6.1 第二次呼叫回什麼

```http
DELETE /orders/1001    第一次 → 204 No Content
DELETE /orders/1001    第二次 → ???
```

三種選擇，各有支持者：

| 回應 | 論點 | 缺點 |
|---|---|---|
| `204 No Content` | 「你想要的最終狀態達成了（它不存在）」；對重試最友善 | 客戶端無法分辨「我剛刪的」和「本來就不存在」 |
| `404 Not Found` | ★ 語意最精確：這個 URI 現在沒有資源 | 重試時客戶端會看到「錯誤」，需要特別處理 |
| `410 Gone` | 「它存在過但已永久移除」 | 需要保留刪除紀錄（tombstone）才知道「存在過」 |

**兩者都符合冪等性**（伺服器狀態相同：資源不存在）。

**shop-service 的決定**：回 `404`，理由：

1. 語意最精確，和 `GET /orders/1001` 一致（同一個 URI，同樣的「不存在」）。
2. 客戶端要處理重試很簡單：`if (status === 404 || status === 204) → 視為成功`。
3. `204` 會掩蓋真正的問題：如果客戶端因為 bug 一直刪錯的 ID，回 `204` 就永遠發現不了。

**在 API 文件裡明確寫出來，並告訴客戶端怎麼處理**：

```yaml
# orders-api.yaml 片段
delete:
  responses:
    '204':
      description: 刪除成功
    '404':
      description: |
        資源不存在。可能原因：
        (a) ID 錯誤
        (b) 已被刪除（含本次請求的重試）
        客戶端在重試場景下應將 404 視同成功。
```

### 2.6.2 軟刪除與 `410 Gone`

軟刪除（`deleted_at` 欄位）在 API 上有兩種呈現：

**呈現 A：對客戶端來說就是不存在**

```http
DELETE /products/P-1001    → 204（實際上只設了 deleted_at）
GET    /products/P-1001    → 404
GET    /products           → 不含 P-1001
```

簡單、對客戶端沒有額外負擔。**適合客戶端不需要知道差別的情境。**

**呈現 B：用 `410 Gone` 告訴客戶端「它存在過」**

```http
GET /products/P-1001

→ 410 Gone
Content-Type: application/problem+json
{
  "type": "https://api.shop.example/problems/resource-gone",
  "title": "商品已下架",
  "status": 410,
  "detail": "Product P-1001 was discontinued on 2026-07-01.",
  "code": "PRODUCT_DISCONTINUED",
  "discontinuedAt": "2026-07-01T00:00:00Z",
  "replacementProductId": "P-1042"
}
```

**`410` 的實際價值**：

| 場景 | `404` 的問題 | `410` 的好處 |
|---|---|---|
| 搜尋引擎索引了舊商品頁 | 爬蟲會持續重試 `404` 幾週 | `410` 讓 Google **立即**移除索引 |
| 使用者的舊書籤 | 「找不到」很困惑 | 可以顯示「此商品已下架，推薦 P-1042」 |
| 歷史訂單引用了下架商品 | 前端不知道要顯示什麼 | 可以顯示「已下架」而不是「錯誤」 |

**shop-service 的決定**：

| 資源 | 刪除後 `GET` 回什麼 | 理由 |
|---|---|---|
| `Product` | `410 Gone` + 替代商品建議 | SEO 重要，且歷史訂單會引用 |
| `Address` | `404` | 沒有 SEO 需求，客戶端不需知道差別 |
| `Review` | `410 Gone` | 可能有外部連結指向它 |
| `Order` | 不提供刪除 | 永不刪除（第 01 章 1.2.2） |

### 2.6.3 `DELETE` 要不要帶 body

**技術上可以**（RFC 9110 沒禁止），**實務上不要**：

- 部分代理與客戶端函式庫會丟掉 `DELETE` 的 body。
- OpenAPI 3.0 描述得很勉強。
- 有些框架預設不解析。

**如果刪除需要參數怎麼辦？**

```http
# ❌ 帶 body
DELETE /orders/1001
{ "reason": "客戶要求" }

# ✅ 選項 1：用查詢參數（簡單參數）
DELETE /orders/1001?reason=CUSTOMER_REQUEST

# ✅ 選項 2：改用動作子資源（有複雜參數或需要紀錄時）★
POST /orders/1001/cancellations
{ "reason": "CUSTOMER_CHANGED_MIND", "comment": "..." }
```

**「刪除需要理由」本身就是「這件事需要紀錄」的訊號**（第 01 章 1.7.1 決策流程圖第一問）
→ 應該用手法 2。

### 2.6.4 級聯刪除要在契約裡寫清楚

```http
DELETE /orders/1001
```

這會刪掉訂單明細、付款紀錄、出貨紀錄嗎？

**必須在文件裡明說**，而且要考慮：

| 問題 | 說明 |
|---|---|
| 級聯範圍 | 刪訂單會不會連帶刪掉付款紀錄？（通常**不該**：金流紀錄要保留） |
| 外部副作用 | 會不會呼叫金流商退款？會不會通知倉庫？ |
| 不可逆性 | 有沒有「還原」的方法？ |
| 稽核 | 刪除本身有紀錄嗎？誰刪的？ |

**危險的預設**：JPA 的 `cascade = CascadeType.ALL` + `orphanRemoval = true`
會在你不知道的情況下刪掉一大片資料。08-jpa-mybatis 會詳談。

**shop-service 的原則**：**任何有金錢或法規意義的資源都不提供 `DELETE`。**

```
❌ DELETE /orders/{id}                    → 用 POST /orders/{id}/cancellations
❌ DELETE /payments/{id}                  → 用 POST /payments/{id}/refunds
❌ DELETE /invoices/{id}                  → 用 POST /invoices/{id}/voidings
✅ DELETE /me/addresses/{id}              → 可以（軟刪除，訂單存的是快照）
✅ DELETE /carts/current/items/{id}       → 可以（硬刪除，購物車是暫時的）
✅ DELETE /products/{id}                  → 可以（軟刪除 + 410）
```

### 2.6.5 回應狀態碼

| 狀態碼 | 情境 |
|---|---|
| `204 No Content` | 刪除成功（**不要帶 body**） |
| `200 OK` | 刪除成功且要回東西（例如回傳被刪除的資源，或回一個工作 ID） |
| `202 Accepted` | 非同步刪除（大量資料、需要外部系統配合） |
| `404 Not Found` | 資源不存在（含重試場景） |
| `409 Conflict` | 有依賴而不能刪（「此地址正被進行中的訂單使用」） |
| `423 Locked` | 資源被鎖定（少見） |

---

## 2.7 `HEAD` 與 `OPTIONS`

### 2.7.1 `HEAD`

和 `GET` 完全相同，但**不回 body**。回應的 header 必須和 `GET` 一致。

**實際用途**：

```bash
# 1. 檢查資源是否存在（不想下載整份）
curl -I https://api.shop.example/orders/1001
# HTTP/1.1 200 OK   → 存在
# HTTP/1.1 404      → 不存在

# 2. 取得檔案大小（決定要不要下載、顯示進度條）
curl -I https://cdn.shop.example/exports/report.csv
# Content-Length: 48213913

# 3. 檢查是否有更新（不下載內容）
curl -I -H 'If-None-Match: "a3f5c9"' https://api.shop.example/orders/1001
# HTTP/1.1 304 Not Modified

# 4. 取得集合總數（不下載資料）★ 實用
curl -I https://api.shop.example/orders?status=PAID
# X-Total-Count: 1523
```

**Spring MVC 自動支援 `HEAD`**：任何 `@GetMapping` 都會自動處理 `HEAD`
（`HiddenHttpMethodFilter` 與 `HttpEntityMethodProcessor` 會處理，body 被丟棄）。
你不需要寫額外的方法 —— 但要注意 **body 仍然會被計算**，所以效能上沒有省到後端運算。

### 2.7.2 `OPTIONS`

**用途 1：查詢資源支援哪些方法**

```bash
curl -X OPTIONS -i https://api.shop.example/orders/1001
```

```http
HTTP/1.1 200 OK
Allow: GET, HEAD, PATCH, OPTIONS
```

實務上很少人主動用（大家都看文件）。

**用途 2：CORS Preflight（★ 這個很重要）**

瀏覽器在發送「非簡單請求」前會自動先發一個 `OPTIONS`：

```http
OPTIONS /orders HTTP/1.1
Origin: https://shop.example
Access-Control-Request-Method: POST
Access-Control-Request-Headers: content-type,authorization,idempotency-key
```

```http
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: https://shop.example
Access-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization, Idempotency-Key
Access-Control-Allow-Credentials: true
Access-Control-Expose-Headers: Location, ETag, X-Total-Count
Access-Control-Max-Age: 3600
```

**觸發 preflight 的條件**（任一成立）：

| 條件 | 說明 |
|---|---|
| 方法不是 `GET`/`HEAD`/`POST` | `PUT`、`PATCH`、`DELETE` 都會觸發 |
| `Content-Type` 不是三種簡單值 | `application/json` **會觸發**（簡單值只有 `text/plain`、`multipart/form-data`、`application/x-www-form-urlencoded`） |
| 有自訂 header | `Authorization`、`Idempotency-Key`、`X-Request-Id` 都會觸發 |

**所以幾乎所有 JSON API 請求都會 preflight。** 這帶來三個實務問題：

**問題 1：每個請求變兩個往返**

解法：設 `Access-Control-Max-Age`（瀏覽器快取 preflight 結果）。
⚠️ 上限依瀏覽器而異（Chrome 上限 2 小時 = 7200 秒，Safari 更短），設太大無效。

**問題 2：`Access-Control-Expose-Headers` 忘記設 → 前端讀不到 header**

這是超級常見的坑：

```javascript
// 後端明明回了 Location
const res = await fetch('/orders', { method: 'POST', ... });
console.log(res.headers.get('Location'));   // → null 🔴
```

原因：**跨來源請求中，JavaScript 預設只能讀到六個「安全」header**
（`Cache-Control`、`Content-Language`、`Content-Type`、`Expires`、`Last-Modified`、`Pragma`）。
其他都要在 `Access-Control-Expose-Headers` 裡明確列出。

**你設計 API 時用到的 header 幾乎都要列**：

```
Access-Control-Expose-Headers: Location, ETag, X-Total-Count, Retry-After,
                               X-RateLimit-Remaining, X-Request-Id, Deprecation, Sunset
```

**問題 3：`Access-Control-Allow-Origin: *` 不能和 `Allow-Credentials: true` 併用**

規範明文禁止。如果要帶 cookie，必須回**具體的 origin**（動態從請求的 `Origin` 回填，
並且**驗證它在白名單裡** —— 直接回填任意 `Origin` 等於開放全世界）。

```java
// ❌ 危險：等於 Allow-Origin: *，但可以帶 cookie
response.setHeader("Access-Control-Allow-Origin", request.getHeader("Origin"));
response.setHeader("Access-Control-Allow-Credentials", "true");

// ✅ 白名單驗證
String origin = request.getHeader("Origin");
if (ALLOWED_ORIGINS.contains(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");            // ★ 別忘了 Vary，否則快取會錯亂
    response.setHeader("Access-Control-Allow-Credentials", "true");
}
```

⚠️ `Vary: Origin` 很重要：沒有它，CDN 可能把「給 A 網站的 CORS 回應」快取後給 B 網站。

（Spring 的 CORS 設定在 04-controller 會實作。）

---

## 2.8 狀態碼完整指南

### 2.8.1 五大類

| 類別 | 意義 | 誰的責任 | 要不要告警 |
|---|---|---|---|
| `1xx` Informational | 中間訊息 | — | — |
| `2xx` Success | 成功 | — | ❌ |
| `3xx` Redirection | 需要進一步動作 | — | ❌ |
| `4xx` Client Error | **客戶端**的錯 | 對方 | ❌（但要看趨勢） |
| `5xx` Server Error | **伺服器**的錯 | 你 | ✅ **必須告警** |

**「4xx / 5xx 的責任歸屬」是狀態碼最重要的資訊**，因為它直接決定：

| 決定 | 4xx | 5xx |
|---|---|---|
| 要不要告警值班工程師 | ❌ | ✅ |
| 客戶端該不該重試 | ❌ 通常不該（除 `408`/`429`） | ✅ 通常可以（配合退避） |
| 算不算進 SLO 的錯誤預算 | 通常不算 | 算 |
| 誰要修 | 呼叫方 | 你 |

**選錯類別的實際代價**（2.12 會再談）：
把資料庫連線失敗回成 `400`，值班工程師的告警永遠不會響，服務掛了三小時沒人知道。

### 2.8.2 `2xx` 詳解

| 碼 | 名稱 | 何時用 | 常見誤用 |
|---|---|---|---|
| `200` | OK | `GET` 成功；`PUT`/`PATCH` 成功且回內容；動作完成 | 🔴 用來包裝錯誤（2.12） |
| `201` | Created | 建立了新資源 | 忘記 `Location`；或 `POST` 一律回 `200` |
| `202` | Accepted | 已接受，尚未完成（非同步） | 用在同步完成的操作上（誤導客戶端去輪詢） |
| `204` | No Content | 成功且**沒有 body**（`DELETE`、`PUT` 關聯） | 🔴 帶了 body（違反規範，某些客戶端會出錯）；用在 `GET` 空集合 |
| `206` | Partial Content | 回應 `Range` 請求 | — |
| `207` | Multi-Status | 批次操作的逐筆結果（來自 WebDAV，但可借用） | 用在單一操作上 |

**`204` 一定不能有 body**。RFC 9110 明確規定。
某些 HTTP 客戶端（含部分瀏覽器 `fetch`）遇到 `204` + body 會拋錯或行為異常。

**`200` vs `204` 的判斷**：

```
DELETE /orders/1001              → 204（沒有東西要回）
DELETE /order-exports/{id}       → 200 { "deletedFiles": 3 }（有資訊要回）
PUT /articles/{id}/like          → 204（按讚，沒東西要回）
PUT /me/preferences              → 200 + 更新後的完整設定（讓前端不用再 GET）
PATCH /orders/1001               → 200 + 更新後的資源（★ 推薦，省一次往返）
```

**建議：`PATCH`/`PUT` 回 `200` + 更新後的完整資源。**
理由：客戶端常常需要知道「伺服器算出來的衍生欄位」（`updatedAt`、`totalAmount`、`allowedActions`、新的 `ETag`）。
回 `204` 逼客戶端再打一次 `GET`，多一個往返而且中間可能有別人改動。

### 2.8.3 `3xx` 詳解

| 碼 | 名稱 | 方法會不會變 | 用途 |
|---|---|---|---|
| `301` | Moved Permanently | ⚠️ 歷史上會（`POST`→`GET`） | 永久搬家；SEO 會轉移權重 |
| `302` | Found | ⚠️ 歷史上會 | 臨時（語意模糊，**避免使用**） |
| `303` | See Other | ✅ **一定變成 `GET`** | POST-Redirect-GET；非同步工作完成後導向結果 |
| `304` | Not Modified | — | 條件請求，快取仍有效（**不能有 body**） |
| `307` | Temporary Redirect | ❌ **保持原方法** | 臨時導向且要保留 `POST` |
| `308` | Permanent Redirect | ❌ **保持原方法** | 永久導向且要保留 `POST` |

**`301`/`302` 的方法變更是歷史包袱**：規範說不該變，但瀏覽器實際上會把 `POST` 變成 `GET`，
所以 RFC 7231 新增了 `307`/`308` 來明確表達「不要變」。

**API 的實務建議**：

```
需要導向且要保留方法      → 307 / 308
非同步工作完成，導向結果  → 303（明確變成 GET）
路徑永久搬家（含尾斜線）  → 308
避免使用                  → 302（語意模糊）
```

**`304` 的實際價值（免費效能）**：

```http
# 第一次
GET /products/P-1001
→ 200 OK
  ETag: "a3f5c9e1"
  Cache-Control: public, max-age=60
  Content-Length: 4821
  { ... 完整商品資料 ... }

# 60 秒後再打
GET /products/P-1001
If-None-Match: "a3f5c9e1"
→ 304 Not Modified            ← body 是 0 bytes！
  ETag: "a3f5c9e1"
  Cache-Control: public, max-age=60
```

**效果**：省下整個 body 的傳輸。對商品目錄、分類樹這種「大而少變」的資料，
可以省掉 90%+ 的頻寬。第 08 章會完整實作。

### 2.8.4 `4xx` 詳解

| 碼 | 名稱 | 何時用 | 必要的 header |
|---|---|---|---|
| `400` | Bad Request | **語法**錯誤：JSON 壞了、參數型別錯、缺必填 | — |
| `401` | Unauthorized | 沒帶憑證 / 憑證無效或過期 | `WWW-Authenticate` |
| `403` | Forbidden | 有身分但**無權限** | — |
| `404` | Not Found | 資源不存在 | — |
| `405` | Method Not Allowed | 路徑存在但不支援這個方法 | **`Allow`**（必須） |
| `406` | Not Acceptable | 無法滿足 `Accept` | — |
| `408` | Request Timeout | 客戶端送太慢 | — |
| `409` | Conflict | 與**當前狀態**衝突 | — |
| `410` | Gone | 曾存在、已永久移除 | — |
| `412` | Precondition Failed | `If-Match` 不符（樂觀鎖，見 2.11） | — |
| `413` | Content Too Large | body 太大 | — |
| `414` | URI Too Long | URL 太長 | — |
| `415` | Unsupported Media Type | `Content-Type` 不支援 | `Accept-Post`（可選） |
| `422` | Unprocessable Content | 語法對但**語意/業務驗證**失敗 | — |
| `423` | Locked | 資源被鎖定 | — |
| `428` | Precondition Required | 要求客戶端必須帶 `If-Match` | — |
| `429` | Too Many Requests | 限流 | **`Retry-After`**（強烈建議） |
| `431` | Request Header Fields Too Large | header 太大 | — |
| `451` | Unavailable For Legal Reasons | 法律原因（下架、地區封鎖） | — |

> 註：`422` 在 RFC 9110 中的正式名稱從 `Unprocessable Entity` 改為 **`Unprocessable Content`**。
> 兩個名稱指同一個碼，看到舊名稱不用緊張。

### 2.8.5 `5xx` 詳解

| 碼 | 名稱 | 何時用 | 客戶端該重試？ |
|---|---|---|---|
| `500` | Internal Server Error | 未預期的例外（NPE、未捕捉的錯誤） | ⚠️ 謹慎（可能是 bug，重試也會失敗） |
| `501` | Not Implemented | 這個方法根本沒實作 | ❌ |
| `502` | Bad Gateway | **上游**回了無效回應 | ✅ |
| `503` | Service Unavailable | 暫時無法服務（維護、過載、熔斷） | ✅ **配合 `Retry-After`** |
| `504` | Gateway Timeout | 等上游**超時** | ✅ |
| `507` | Insufficient Storage | 空間不足 | ❌ |

**`502` / `503` / `504` 的區別**（值班時最需要分清楚）：

| 碼 | 意思 | 典型原因 | 該查哪裡 |
|---|---|---|---|
| `502` | 「我聯絡到上游了，但它給我垃圾」 | 上游 crash、回了非 HTTP 資料、應用程式沒起來 | 上游的錯誤日誌、Pod 有沒有 CrashLoop |
| `503` | 「我知道我現在不行」 | 執行緒池滿、連線池耗盡、熔斷器打開、正在滾動更新 | 你自己的資源指標（執行緒、連線池、記憶體） |
| `504` | 「我等上游等到超時」 | 上游太慢、資料庫慢查詢、外部 API 掛了 | 上游的延遲指標、慢查詢日誌 |

這三個碼**是免費的第一層診斷資訊**。如果你的服務全部回 `500`，值班的人要從零開始查。

**`503` 一定要帶 `Retry-After`**：

```http
HTTP/1.1 503 Service Unavailable
Retry-After: 30
Content-Type: application/problem+json

{
  "type": "https://api.shop.example/problems/service-unavailable",
  "title": "服務暫時無法使用",
  "status": 503,
  "detail": "Payment gateway is under maintenance until 2026-08-19T08:00:00Z.",
  "code": "PAYMENT_GATEWAY_MAINTENANCE",
  "retryAfterSeconds": 30
}
```

`Retry-After` 可以是秒數（`30`）或 HTTP 日期（`Wed, 19 Aug 2026 08:00:00 GMT`）。
它讓客戶端**不用瞎猜退避時間**，也避免所有客戶端同時重試造成二次雪崩。

### 2.8.6 狀態碼決策樹

```
請求進來
   │
   ├─ 格式／協議層面有問題嗎？
   │    ├─ JSON 壞了 / 參數型別錯 / 缺必填 ──────────→ 400
   │    ├─ Content-Type 不支援 ──────────────────────→ 415
   │    ├─ 無法滿足 Accept ──────────────────────────→ 406
   │    ├─ body 太大 ───────────────────────────────→ 413
   │    └─ URL 太長 ────────────────────────────────→ 414
   │
   ├─ 認證／授權有問題嗎？
   │    ├─ 沒帶 token / token 過期或無效 ────────────→ 401 + WWW-Authenticate
   │    ├─ 有身分但沒權限 ──────────────────────────→ 403
   │    └─ 有身分但不該知道資源存在（見 2.9.3）─────→ 404
   │
   ├─ 資源存在嗎？
   │    ├─ 從來沒有 ────────────────────────────────→ 404
   │    ├─ 曾經有，已永久移除 ──────────────────────→ 410
   │    └─ 路徑對但方法不支援 ──────────────────────→ 405 + Allow
   │
   ├─ 超過限流了嗎？ ──────────────────────────────→ 429 + Retry-After
   │
   ├─ 條件請求不符？
   │    ├─ If-Match 不符（別人先改了）──────────────→ 412
   │    ├─ If-None-Match 相符（沒變）───────────────→ 304
   │    └─ 要求必須帶 If-Match 但沒帶 ──────────────→ 428
   │
   ├─ 業務規則檢查
   │    ├─ 欄位值不合法（email 格式、數量 ≤ 0）─────→ 422（或 400，見 2.9.2）
   │    ├─ 與當前狀態衝突（已出貨不能取消）─────────→ 409
   │    ├─ 唯一性衝突（email 已註冊）───────────────→ 409
   │    └─ 依賴不存在（productId 查不到）───────────→ 422
   │
   ├─ 執行
   │    ├─ 建立了新資源 ────────────────────────────→ 201 + Location
   │    ├─ 非同步接受了 ────────────────────────────→ 202 + Location（工作資源）
   │    ├─ 成功且有內容要回 ────────────────────────→ 200
   │    └─ 成功且沒東西要回 ────────────────────────→ 204（不可有 body）
   │
   └─ 出錯了
        ├─ 我的 bug（未預期例外）───────────────────→ 500
        ├─ 上游回了無效回應 ────────────────────────→ 502
        ├─ 等上游超時 ─────────────────────────────→ 504
        └─ 我自己過載／維護／熔斷 ──────────────────→ 503 + Retry-After
```

**把這張圖印出來貼在螢幕旁邊。** 90% 的狀態碼爭論用它可以在 10 秒內解決。

---

## 2.9 最容易搞錯的六組

### 2.9.1 `401` vs `403`

**這兩個的名字取反了，是 HTTP 最大的命名災難。**

| 碼 | 名稱 | **實際語意** |
|---|---|---|
| `401` | Unauthorized（未授權） | 實際是 **Unauthenticated（未認證）**：我不知道你是誰 |
| `403` | Forbidden（禁止） | 實際是 **Unauthorized（未授權）**：我知道你是誰，但你不能做這件事 |

**記法**：

```
401 = 「你是誰？」  → 客戶端該做的事：登入 / 刷新 token
403 = 「你不行。」  → 客戶端該做的事：放棄（重試沒用，換帳號才有用）
```

**這個區分為什麼實際重要**：客戶端的 HTTP 攔截器依賴它。

```typescript
// 前端的統一攔截器（真實會這樣寫）
axios.interceptors.response.use(null, async (error) => {
  if (error.response?.status === 401) {
    // 嘗試刷新 token，然後重試原請求
    await refreshToken();
    return axios.request(error.config);
  }
  if (error.response?.status === 403) {
    // 不要重試！顯示「權限不足」
    showToast('您沒有權限執行此操作');
    return Promise.reject(error);
  }
  return Promise.reject(error);
});
```

**如果你把「token 過期」回成 `403`**：前端不會刷新 token，使用者被登出，
然後重新登入 → 又過期 → 又被登出。**體驗徹底崩壞。**

**如果你把「權限不足」回成 `401`**：前端無限迴圈刷新 token
（刷新成功 → 重試 → 又 401 → 又刷新 → …），**打爆你的認證服務**。

**`401` 必須帶 `WWW-Authenticate`**（RFC 9110 規定）：

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="shop-api", error="invalid_token",
                  error_description="The access token expired at 2026-08-19T06:00:00Z"
Content-Type: application/problem+json

{
  "type": "https://api.shop.example/problems/token-expired",
  "title": "存取權杖已過期",
  "status": 401,
  "code": "TOKEN_EXPIRED",
  "expiredAt": "2026-08-19T06:00:00Z"
}
```

`error="invalid_token"` 這個值來自 RFC 6750（OAuth 2.0 Bearer Token）。
它讓客戶端能區分「token 格式錯」`invalid_request`、「token 無效／過期」`invalid_token`、
「權限不足」`insufficient_scope`。

**shop-service 的對照表**：

| 情境 | 碼 | `code` |
|---|---|---|
| 完全沒帶 `Authorization` | `401` | `AUTHENTICATION_REQUIRED` |
| token 格式錯（不是合法 JWT） | `401` | `INVALID_TOKEN` |
| token 簽章驗證失敗 | `401` | `INVALID_TOKEN` |
| token 過期 | `401` | `TOKEN_EXPIRED` |
| token 已被撤銷（登出） | `401` | `TOKEN_REVOKED` |
| 顧客想用客服端點 | `403` | `INSUFFICIENT_ROLE` |
| 顧客想改別人的訂單 | `403` 或 `404`（見 2.9.3） | `FORBIDDEN_RESOURCE` |
| token 的 scope 不足 | `403` | `INSUFFICIENT_SCOPE` |
| 帳號被停權 | `403` | `ACCOUNT_SUSPENDED` |

### 2.9.2 `400` vs `422`

這一組沒有絕對正確答案，重點是**全站一致**。

| | `400 Bad Request` | `422 Unprocessable Content` |
|---|---|---|
| 語意 | **語法**錯誤：我看不懂你的請求 | **語意**錯誤：我看懂了，但內容不合理 |
| 典型 | JSON 括號沒閉合、`?page=abc`、`Content-Length` 不符 | `email` 格式錯、`quantity: -5`、`endDate < startDate` |
| 判斷 | 「我連解析都失敗」 | 「我解析成功了，欄位型別也對，但值不合規則」 |

**兩種流派**：

**流派 A：只用 `400`（很多大公司這樣，例如 Google、部分 AWS API）**

```
優點：簡單，客戶端只要處理一種「你的請求有問題」
缺點：無法區分「格式壞掉」和「業務驗證失敗」
```

**流派 B：`400` 給語法、`422` 給驗證（★ 本課程採用，也是 Spring 生態的主流）**

```
優點：客戶端可以分別處理 ——
      400 → 「這是程式 bug，回報給開發者」（正常使用者不該遇到）
      422 → 「這是使用者輸入問題，顯示在表單上」
缺點：要教會團隊區分；邊界情況會爭論
```

**流派 B 的實際好處**：前端的錯誤處理可以這樣寫：

```typescript
if (status === 400) {
  // 這不該發生 —— 前端組錯了請求
  logToSentry('Malformed request', { url, body });
  showToast('系統錯誤，請稍後再試');
} else if (status === 422) {
  // 正常的使用者輸入問題 —— 標在表單欄位上
  problem.errors.forEach(e => form.setFieldError(e.field, e.message));
}
```

**如果全部都是 `400`，前端無法知道要不要送 Sentry 告警**，
於是要嘛全部告警（噪音爆炸），要嘛全部不告警（漏掉真的 bug）。

**shop-service 的分界（要寫進 style guide）**：

| 情境 | 碼 |
|---|---|
| body 不是合法 JSON | `400` |
| `Content-Type` 缺少或不對 | `415` |
| 查詢參數型別錯（`?page=abc`、`?size=-1`） | `400` |
| 路徑參數格式錯（`/orders/abc` 但 ID 必須是 ULID） | `400` |
| 必填欄位缺少 | `422` ⚠️ 有爭議（有人認為是 `400`） |
| 欄位型別錯（`quantity: "two"`） | `400`（Jackson 反序列化就失敗了） |
| 欄位值不合規則（`quantity: -5`、email 格式） | `422` |
| 跨欄位規則（`createdTo < createdFrom`） | `422` |
| 參照的資源不存在（`productId` 查不到） | `422` |
| 業務規則不滿足（庫存不足、折扣碼過期） | `422` |
| 與資源當前狀態衝突（已出貨不能取消） | `409` |
| 唯一性衝突（email 已被註冊） | `409` |

**「必填欄位缺少」為什麼放 `422`**：因為它和「值不合法」對前端來說是同一類 ——
都是要標在表單欄位上的錯誤，都要用同一份 `errors` 陣列格式回傳（第 04 章 4.6）。
把它們拆成兩個狀態碼會讓前端寫兩套處理。

**Spring 的實際行為要注意**：

| 例外 | Spring Boot 預設狀態碼 |
|---|---|
| `HttpMessageNotReadableException`（JSON 壞掉） | `400` |
| `MethodArgumentNotValidException`（`@Valid` 失敗） | **`400`** ⚠️ 不是 `422` |
| `MethodArgumentTypeMismatchException`（型別錯） | `400` |
| `HttpMediaTypeNotSupportedException` | `415` |
| `HttpRequestMethodNotSupportedException` | `405` |

**所以要用 `422` 就必須自己覆寫**（04-controller 第 03 章會實作）：

```java
@RestControllerAdvice
public class ValidationExceptionHandler {

    @ExceptionHandler(MethodArgumentNotValidException.class)
    @ResponseStatus(HttpStatus.UNPROCESSABLE_ENTITY)     // ← 改成 422
    public ProblemDetail handle(MethodArgumentNotValidException ex) {
        // 組 Problem Details + errors 陣列（第 04 章 4.6）
        ...
    }
}
```

### 2.9.3 `404` vs `403`：存在性洩漏

```http
GET /orders/ord_someoneElsesOrder
Authorization: Bearer <顧客 A 的 token>
```

這張訂單存在，但屬於顧客 B。回什麼？

| 回應 | 洩漏了什麼 | 適合 |
|---|---|---|
| `403 Forbidden` | 🔴 「這張訂單存在」 | 內部系統、資源存在性不敏感時 |
| `404 Not Found` | 什麼都沒洩漏 | ★ 對外 API、資源存在性敏感時 |

**存在性洩漏的實際危害**：

```bash
# 攻擊者用 403/404 的差異列舉出所有有效 ID
for id in $(cat guessed-ids.txt); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $MY_TOKEN" \
         https://api.shop.example/orders/$id)
  [ "$code" = "403" ] && echo "$id 存在！"
done
```

拿到有效 ID 清單後，攻擊者就可以：
- 估算業務量（第 01 章 1.4.1 風險 2）。
- 針對這些 ID 嘗試其他漏洞（有些端點可能忘記檢查權限）。
- 社交工程（「我是客服，關於您的訂單 ORD-xxx」）。

**更敏感的例子：使用者列舉**

```http
POST /auth/tokens
{ "email": "victim@example.com", "password": "wrong" }

→ 401 { "code": "INVALID_PASSWORD" }       🔴 洩漏「這個 email 有註冊」
→ 401 { "code": "USER_NOT_FOUND" }         🔴 洩漏「這個 email 沒註冊」
```

**正確做法**：一律回同一個錯誤，且**回應時間也要一致**
（否則可以用時間差判斷 —— 找不到使用者時不會做 bcrypt 驗算，回應明顯更快）。

```http
→ 401
{
  "type": "https://api.shop.example/problems/invalid-credentials",
  "title": "帳號或密碼錯誤",
  "status": 401,
  "code": "INVALID_CREDENTIALS"
}
```

實作要點：使用者不存在時，**仍然執行一次假的密碼雜湊運算**，讓回應時間一致
（Spring Security 的 `DaoAuthenticationProvider` 有 `hideUserNotFoundExceptions`，
且會做 dummy password check —— 09-spring-security 會詳談）。

**註冊端點的兩難**：

```http
POST /customers
{ "email": "existing@example.com", ... }
```

- 回 `409 EMAIL_ALREADY_EXISTS` → 使用者體驗好，但可以列舉 email。
- 回 `201` + 寄信「這個 email 已註冊，要重設密碼嗎」→ 不洩漏，但使用者困惑。

**實務選擇**：大部分 B2C 服務選第一種（可用性優先），
但加上**限流**（第 08 章）讓大規模列舉不可行。
高敏感服務（醫療、金融）選第二種。

**shop-service 的規則**：

| 情境 | 回應 |
|---|---|
| 顧客存取別人的訂單／地址／評價 | `404`（不洩漏存在性） |
| 顧客呼叫客服專屬端點（`GET /customers`） | `403`（端點的存在本來就是公開的，寫在文件裡） |
| 顧客帶了 `?customerId=` 但沒有 SUPPORT 權限 | `403 FORBIDDEN_PARAMETER` |
| 登入失敗（不論原因） | `401 INVALID_CREDENTIALS` + 一致的回應時間 |
| 註冊 email 已存在 | `409 EMAIL_ALREADY_EXISTS` + 限流 |

**實作技巧**：把權限放進查詢條件（第 01 章 1.4.1），
`404` 就會**自然而然**發生，不需要「先查出來再判斷要回 403 還是 404」：

```java
// 查不到就是查不到 —— 不管是「不存在」還是「不是你的」
Order order = repo.findByIdAndCustomerId(orderId, currentCustomerId())
                  .orElseThrow(() -> new ResourceNotFoundException("order", orderId));
```

### 2.9.4 `409` vs `422`

兩者都是「我看得懂，但不能做」。差別在**原因在哪裡**：

| | `409 Conflict` | `422 Unprocessable Content` |
|---|---|---|
| 原因 | **資源當前狀態**與請求衝突 | **請求內容**本身不合規則 |
| 客戶端該做什麼 | 重新讀取資源，看看現在的狀態 | 修改請求內容再送 |
| 重送同樣的請求會成功嗎 | ⚠️ 有可能（狀態改變後） | ❌ 不會（內容不變就一直錯） |

**判斷法**：**「如果我一個字都不改，等一下再送，有可能成功嗎？」**
有可能 → `409`。不可能 → `422`。

**對照表**：

| 情境 | 碼 | 理由 |
|---|---|---|
| 取消已出貨的訂單 | `409` | 狀態問題。（雖然實際上不會變回可取消，但問題在資源狀態） |
| 付款金額和訂單金額不符 | `422` | 請求內容錯 |
| 折扣碼已過期 | `422` | 請求帶的 coupon 不合用；換一個碼就對了 |
| 折扣碼庫存已用完 | `409` | 資源（coupon）的狀態衝突 |
| email 已被註冊 | `409` | 唯一性衝突 —— 系統當前狀態與請求衝突 |
| 商品庫存不足 | `409` | 庫存是資源狀態，補貨後重送會成功 |
| `quantity` 是 `-5` | `422` | 內容不合法 |
| `productId` 不存在 | `422` | 參照的東西不存在 → 請求內容錯 |
| `If-Match` ETag 不符 | `412` | 專用碼，比 `409` 精確 |
| 同一張訂單重複建立取消單 | `409` | 已經有一張了 |
| 匯出工作已在執行中 | `409` | 狀態衝突 |

**⚠️「庫存不足」的爭議**：有人認為是 `422`（請求的數量不合理），
有人認為是 `409`（庫存狀態衝突）。

**shop-service 選 `409`**，理由：客戶端的正確反應是「重新查商品頁看現在還有多少」，
這正是 `409` 的語意（去看看現在的狀態）。而且補貨後同樣的請求會成功。
**把這個決定寫進 style guide，避免每次都吵。**

**`409` 的回應要幫助客戶端恢復**（這是它和 `422` 最實際的差別）：

```http
HTTP/1.1 409 Conflict
Content-Type: application/problem+json

{
  "type": "https://api.shop.example/problems/insufficient-stock",
  "title": "庫存不足",
  "status": 409,
  "detail": "Product P-1001 has 3 units available but 5 were requested.",
  "code": "INSUFFICIENT_STOCK",
  "productId": "P-1001",
  "requested": 5,
  "available": 3,                 ← ★ 讓前端可以直接改成 3
  "restockEstimatedAt": "2026-08-22",
  "traceId": "4f2c8a1e9b7d3f60"
}
```

有 `available: 3` 前端就能顯示「僅剩 3 件，是否改為 3 件？」，
而不是「庫存不足」然後讓使用者自己試。

### 2.9.5 `200` vs `204`

已在 2.8.2 討論。摘要規則：

```
有東西要回 → 200
沒東西要回 → 204（且絕對不能有 body）
不確定     → 200 + 更新後的資源（對客戶端最友善）
```

**唯一要小心的**：`204` 不能有 body。有些框架會「順手」回一個空的 `{}` 或 `""` ——
那已經違反規範了。

### 2.9.6 `429` vs `503`

| | `429 Too Many Requests` | `503 Service Unavailable` |
|---|---|---|
| 意思 | **你**送太多了 | **我**現在不行 |
| 誰的問題 | 客戶端 | 伺服器 |
| 算不算 SLO 錯誤 | ❌（是保護機制正常運作） | ✅ |
| 要不要告警 | ⚠️ 趨勢告警（可能有人在攻擊） | ✅ 立即告警 |
| `Retry-After` | ✅ 該有 | ✅ 該有 |

**常見錯誤**：過載時回 `429`。

過載是**你的**問題（容量不足），不是某個客戶端超量。
回 `429` 會讓 SLO 儀表板看起來很健康（因為 `429` 通常不算錯誤），
**但使用者確實無法使用你的服務**。

**正確做法**：

```
單一客戶端超過它的配額     → 429
所有客戶端都在正常範圍但我撐不住 → 503（並且要告警、要擴容）
熔斷器打開（下游掛了）      → 503
正在維護                    → 503 + Retry-After
```

---

## 2.10 長時間操作：`202 Accepted` + 輪詢

### 2.10.1 什麼時候必須非同步

| 訊號 | 說明 |
|---|---|
| 處理時間 > 5 秒 | 使用者會以為壞了、會重新整理 |
| 處理時間可能 > 30 秒 | 各種超時開始出現（Nginx 60s、ALB 60s、瀏覽器 fetch 預設無限但使用者沒耐心） |
| 需要外部系統配合 | 對方的時間你控制不了 |
| 需要顯示進度 | HTTP 請求／回應無法漸進回報（除非用串流） |
| 失敗要能重試 | 同步失敗只能整個重來 |
| 結果要能重複取得 | 同步的結果收不到就沒了 |

### 2.10.2 完整契約

**步驟 1：建立工作**

```http
POST /order-exports
Content-Type: application/json
Idempotency-Key: 8f14e45f-ea36-4a1b-9c2e-77e8f1a3b0c1

{
  "createdFrom": "2026-08-01",
  "createdTo": "2026-08-31",
  "status": ["PAID", "SHIPPED", "COMPLETED"],
  "format": "CSV",
  "columns": ["orderNumber", "customerName", "totalAmount", "createdAt"]
}
```

```http
HTTP/1.1 202 Accepted
Location: /order-exports/exp_01J5GKQ8Z4W9V2X3Y6N7M8P0QR
Retry-After: 5
Content-Type: application/json

{
  "exportId": "exp_01J5GKQ8Z4W9V2X3Y6N7M8P0QR",
  "status": "QUEUED",
  "createdAt": "2026-08-19T06:12:44Z",
  "estimatedRows": 48213,
  "pollUrl": "/order-exports/exp_01J5GKQ8Z4W9V2X3Y6N7M8P0QR",
  "pollIntervalSeconds": 5
}
```

**三個 header 的作用**：

| Header | 作用 |
|---|---|
| `202 Accepted` | 「我收下了，但還沒做完」 |
| `Location` | ★ **指向工作資源**，不是結果資源（這是關鍵區別） |
| `Retry-After: 5` | 建議 5 秒後再來查（避免客戶端每 100ms 輪詢） |

> ⚠️ `202` 的 `Location` 指向**工作**（`/order-exports/{id}`），
> `201` 的 `Location` 指向**建立好的資源**。
> 搞混會讓客戶端拿到 404（因為結果還不存在）。

**步驟 2：輪詢進度**

```http
GET /order-exports/exp_01J5GK...
```

```http
HTTP/1.1 200 OK
Retry-After: 5

{
  "exportId": "exp_01J5GK...",
  "status": "RUNNING",
  "progress": {
    "processed": 12000,
    "total": 48213,
    "percent": 24.9
  },
  "startedAt": "2026-08-19T06:12:46Z",
  "estimatedCompletionAt": "2026-08-19T06:15:20Z"
}
```

**注意輪詢用 `200` 而不是 `202`。**
工作資源本身是存在的、讀取成功，所以是 `200`。它的 `status` 欄位才是工作狀態。

（也有人主張未完成時回 `202`，這樣客戶端可以只看狀態碼。兩種都有人用 —— 
**shop-service 選 `200`**，因為「讀取工作資源」確實成功了，而且 `200` 可以被條件請求快取。）

**步驟 3：完成**

```http
GET /order-exports/exp_01J5GK...

→ 200 OK
{
  "exportId": "exp_01J5GK...",
  "status": "SUCCEEDED",
  "progress": { "processed": 48213, "total": 48213, "percent": 100 },
  "startedAt": "2026-08-19T06:12:46Z",
  "completedAt": "2026-08-19T06:15:18Z",
  "result": {
    "rowCount": 48213,
    "sizeBytes": 8421334,
    "format": "CSV",
    "downloadUrl": "https://s3.../exports/exp_01J5GK.csv?X-Amz-Signature=...",
    "downloadUrlExpiresAt": "2026-08-19T07:15:18Z"
  },
  "expiresAt": "2026-08-26T06:15:18Z"
}
```

**步驟 4：失敗**

```http
→ 200 OK
{
  "exportId": "exp_01J5GK...",
  "status": "FAILED",
  "failedAt": "2026-08-19T06:14:02Z",
  "error": {
    "code": "EXPORT_ROW_LIMIT_EXCEEDED",
    "title": "資料量超過單次匯出上限",
    "detail": "Query matched 1,204,338 rows; the limit is 500,000. Narrow the date range.",
    "retryable": false
  },
  "traceId": "4f2c8a1e9b7d3f60"
}
```

**注意：工作失敗時，HTTP 狀態碼仍是 `200`。**
因為「讀取工作狀態」這個請求成功了。工作本身的失敗在 body 的 `status`/`error` 裡。

**這不是「全部回 200」的反例** —— 區別在於：
「讀取工作資源」和「工作本身」是**兩件不同的事**。
如果你在讀取工作時發生錯誤（工作 ID 不存在），那就要回 `404`。

**步驟 5：取消（可選但很實用）**

```http
DELETE /order-exports/exp_01J5GK...

→ 202 Accepted        （已請求取消，正在停止）
→ 200 OK              （已停止）
→ 409 Conflict        （已完成，無法取消）
```

### 2.10.3 三種進度通知方式

輪詢不是唯一選擇：

| 方式 | 實作 | 適合 |
|---|---|---|
| **輪詢** | 客戶端每 N 秒 `GET` | ★ 最簡單、最通用、防火牆友善 |
| **Webhook** | 完成時你去打客戶端的 URL | 伺服器對伺服器（廠商 ERP） |
| **SSE** | `GET /order-exports/{id}/events` 保持連線推送 | 前端要即時進度條 |

**SSE 的樣子**（單向推送，比 WebSocket 簡單得多）：

```http
GET /order-exports/exp_01J5GK.../events
Accept: text/event-stream

→ 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive

event: progress
data: {"processed":12000,"total":48213}

event: progress
data: {"processed":24000,"total":48213}

event: completed
data: {"downloadUrl":"https://s3..."}
```

**shop-service 的選擇**：以輪詢為主（最可靠），
匯出完成額外寄一封 email（使用者可以關掉頁面去做別的事）。
SSE 列為後續優化項。

### 2.10.4 輪詢的三個實務細節

**細節 1：`Retry-After` 要動態調整**

```
QUEUED（排隊中，可能等很久）  → Retry-After: 10
RUNNING（已開始，快了）        → Retry-After: 3
接近完成（percent > 90）       → Retry-After: 1
```

**細節 2：輪詢端點要能承受高頻請求**

1000 個使用者同時匯出 × 每 5 秒輪詢 = 200 QPS 全打在同一個端點上。
所以：
- 工作狀態放 Redis 而不是每次查資料庫。
- 加 `ETag`，沒變就回 `304`（幾乎零成本）。
- 對輪詢端點的限流要放寬（否則使用者會被自己的輪詢限流）。

**細節 3：工作要有 TTL 與清理**

```
工作紀錄保留：30 天（可查歷史）
產出檔案保留：7 天（S3 lifecycle 自動刪）
簽名 URL 有效：1 小時（要就重新 GET 工作資源拿新的）
```

---

## 2.11 條件請求與樂觀鎖

### 2.11.1 問題：兩個客服同時改同一張訂單

```
時間  客服 A                          客服 B
────────────────────────────────────────────────────────
T1    GET /orders/1001
      → note: "客戶要求包裝"
T2                                    GET /orders/1001
                                      → note: "客戶要求包裝"
T3    改成 "客戶要求包裝 + 附贈品"
      PATCH /orders/1001
      → 200 ✅
T4                                    改成 "客戶要求包裝 + 加急"
                                      PATCH /orders/1001
                                      → 200 ✅
────────────────────────────────────────────────────────
結果：A 的「附贈品」消失了。而且沒有任何人知道。
```

這叫 **lost update**（更新遺失）。**在任何有多人協作的後台系統裡，這一定會發生。**

### 2.11.2 解法：`ETag` + `If-Match`

**步驟 1：`GET` 時回 `ETag`**

```http
GET /orders/1001

→ 200 OK
ETag: "v7"
Cache-Control: private, no-cache
{
  "orderId": "1001",
  "note": "客戶要求包裝",
  "version": 7
}
```

`ETag` 是這份表述的「指紋」。可以是：

| 來源 | 例子 | 優點 | 缺點 |
|---|---|---|---|
| 版本號 | `"v7"` | 簡單、和 JPA `@Version` 天然對應 | 需要資料庫欄位 |
| `updatedAt` 時間戳 | `"1755583964000"` | 不用新欄位 | 同一毫秒內的兩次更新無法區分 |
| 內容雜湊 | `"a3f5c9e1"`（body 的 SHA-256 前 8 碼） | 最精確（內容一樣就一樣） | 要算雜湊；欄位順序要穩定 |

**shop-service 用 JPA 的 `@Version`**（08-jpa-mybatis 會實作），因為它同時解決了資料庫層的樂觀鎖。

**步驟 2：`PATCH` 時帶 `If-Match`**

```http
PATCH /orders/1001
If-Match: "v7"
Content-Type: application/merge-patch+json

{ "note": "客戶要求包裝 + 附贈品" }
```

```http
→ 200 OK
ETag: "v8"                    ← 版本遞增
{ "note": "客戶要求包裝 + 附贈品", "version": 8 }
```

**步驟 3：衝突時回 `412`**

```http
PATCH /orders/1001
If-Match: "v7"                ← B 手上的還是舊版本

→ 412 Precondition Failed
Content-Type: application/problem+json
ETag: "v8"                    ← ★ 告訴客戶端現在的版本

{
  "type": "https://api.shop.example/problems/version-conflict",
  "title": "資料已被其他人修改",
  "status": 412,
  "detail": "The order was modified by another user at 2026-08-19T06:14:02Z. Expected version v7 but current is v8.",
  "code": "OPTIMISTIC_LOCK_CONFLICT",
  "expectedVersion": "v7",
  "currentVersion": "v8",
  "modifiedBy": { "type": "SUPPORT", "displayName": "李客服" },
  "modifiedAt": "2026-08-19T06:14:02Z"
}
```

**前端該怎麼處理 `412`**（這決定了這個設計有沒有價值）：

```typescript
if (res.status === 412) {
  const problem = await res.json();
  const latest = await fetch(`/orders/${id}`).then(r => r.json());

  // 選項 1：顯示衝突對話框，讓使用者選（最好，但要寫 UI）
  showConflictDialog({
    yours: myChanges,
    theirs: latest,
    modifiedBy: problem.modifiedBy.displayName,
    onKeepMine: () => retryWith(latest.version),       // 用新版本號重送
    onKeepTheirs: () => reloadForm(latest),
    onMerge: () => showMergeEditor(myChanges, latest),
  });

  // 選項 2：直接提示重載（簡單，但使用者的輸入會丟掉）
  // toast(`此訂單已被 ${problem.modifiedBy.displayName} 修改，請重新載入`);
}
```

**回應裡的 `modifiedBy` 是很實用的細節**：
「此訂單已被李客服修改」比「資料衝突」有用一百倍 —— 使用者可以直接去問李客服。

### 2.11.3 `428 Precondition Required`：強制要求 `If-Match`

如果客戶端沒帶 `If-Match` 就直接改，你可以：

| 選擇 | 說明 |
|---|---|
| 允許（不檢查） | 向下相容，但失去保護 |
| 回 `428 Precondition Required` | ★ 強制所有客戶端都用樂觀鎖 |

```http
PATCH /orders/1001
（沒有 If-Match）

→ 428 Precondition Required
{
  "type": "https://api.shop.example/problems/if-match-required",
  "title": "此操作必須帶 If-Match",
  "status": 428,
  "detail": "Concurrent modification protection is mandatory for this resource. Send If-Match with the ETag from a prior GET.",
  "code": "IF_MATCH_REQUIRED"
}
```

**shop-service 的決定**：

| 資源 | `If-Match` |
|---|---|
| `PATCH /orders/{id}`（多人協作） | **必填** → `428` |
| `PUT /orders/{id}/invoice` | **必填** → `428` |
| `PATCH /returns/{id}`（審核，多人） | **必填** → `428` |
| `PATCH /me`（只有自己會改） | 選填 |
| `PATCH /carts/current/items/{id}` | 不需要（購物車是自己的，且改錯無傷） |

**判準**：**這份資料會不會有兩個人同時改？** 會 → 強制 `If-Match`。

### 2.11.4 `ETag` 的另一個用途：省頻寬（`If-None-Match`）

同一個 `ETag` 機制，換一個 header，變成快取驗證：

```http
GET /products/P-1001
If-None-Match: "a3f5c9e1"

→ 304 Not Modified          ← body 0 bytes
  ETag: "a3f5c9e1"
```

| Header | 用途 | 成功時 | 失敗時 |
|---|---|---|---|
| `If-None-Match` | 快取驗證（**讀**） | 有變 → `200` + 內容 | 沒變 → `304`（省頻寬） |
| `If-Match` | 樂觀鎖（**寫**） | 相符 → 執行 | 不符 → `412`（防覆蓋） |

一個 `ETag` 同時買到「省頻寬」和「防覆蓋」。第 08 章會完整實作。

### 2.11.5 弱 ETag 與強 ETag

```http
ETag: "a3f5c9e1"           強 ETag：位元組層級完全相同
ETag: W/"a3f5c9e1"         弱 ETag：語意相同（可能格式化差異、可能壓縮不同）
```

**規則**：
- `If-None-Match`（快取驗證）**接受弱 ETag**。
- `If-Match`（樂觀鎖）**必須用強 ETag**（規範要求）。

**實務注意**：Spring 的 `ShallowEtagHeaderFilter` 產生的是**強 ETag**（body 的 MD5），
但它有代價 —— 要把整個回應緩衝在記憶體裡才能算雜湊，所以省了頻寬但沒省 CPU 與記憶體。
用 `@Version` 自己產生 ETag 通常更好（第 08 章詳談）。

---

## 2.12 反模式：全部回 200

這是本課程最強調的一件事，值得單獨一節。

### 2.12.1 它長什麼樣

```http
HTTP/1.1 200 OK
Content-Type: application/json

{ "code": 40001, "message": "庫存不足", "data": null }
```

```http
HTTP/1.1 200 OK

{ "success": false, "errorCode": "E5001", "errorMessage": "資料庫連線失敗" }
```

### 2.12.2 為什麼會這樣（先理解，才能說服人改）

| 理由 | 是否合理 |
|---|---|
| 「早期某些前端框架遇到 4xx/5xx 會直接進 catch，拿不到 body」 | ⚠️ 十年前的 jQuery 有這個困擾。現在 `fetch`/`axios` 都能讀錯誤 body |
| 「行動 App 的 SDK 遇到非 200 會吃掉回應」 | ⚠️ 某些老 SDK 確實如此。現在都不是問題 |
| 「公司的 API Gateway 遇到 5xx 會攔截並改成自己的錯誤頁」 | ✅ **這是真實問題**，但正確解法是改閘道設定，不是全站回 200 |
| 「前端說這樣比較好處理」 | ❌ 通常是因為前端只想寫一套處理邏輯。但正確的做法是統一錯誤格式（第 04 章），不是統一狀態碼 |
| 「我們一直都這樣」 | ❌ 這是最常見的真實原因 |

**要公平地說**：如果你們已經全站這樣做了三年，全部改掉的成本很高。
**這一節的目的不是要你立刻大改**，而是讓你知道你付了什麼代價，
以及**新的端點不要再這樣做**。

### 2.12.3 五個具體損失

**損失 1：監控與告警失效（最嚴重）**

你的錯誤率是這樣算的：

```promql
# Prometheus / Grafana 的標準查詢
sum(rate(http_server_requests_seconds_count{status=~"5.."}[5m]))
  / sum(rate(http_server_requests_seconds_count[5m]))
```

全回 200 → 這個查詢永遠是 **0%**。

**實際後果**：
- SLO 儀表板全綠，但使用者在罵。
- 告警規則 `error_rate > 1% for 5m` 永遠不會觸發。
- 半夜資料庫掛掉，沒有人被叫起來。
- 事後檢討時「我們的監控顯示服務正常」。

**要重建這個能力，你必須**：解析每個回應的 body，抽出自訂 `code`，
轉成指標。這需要在每個服務、每個閘道、每個監控工具裡各做一次 —— 而狀態碼是免費的。

**損失 2：客戶端函式庫的自動行為失效**

| 自動行為 | 依賴 | 全回 200 的後果 |
|---|---|---|
| 401 → 自動刷新 token | 狀態碼 | 要自己解析 body 判斷 |
| 5xx → 自動重試 + 指數退避 | 狀態碼 | 要自己實作 |
| 429 → 讀 `Retry-After` 等待 | 狀態碼 | 要自己實作 |
| axios / fetch 的 `ok` 屬性 | 狀態碼 | 永遠 `true`，每個呼叫都要手動檢查 |
| OpenAPI 產生的 client 拋錯 | 狀態碼 | 產生的 client 不會拋錯，全部要手動判斷 |

**損失 3：中介元件失效**

| 元件 | 依賴 |
|---|---|
| CDN / 快取 | 4xx/5xx 不該被快取 → 全 200 會把錯誤回應快取起來 🔴 |
| 負載平衡器健康檢查 | 5xx → 移出輪詢。全 200 → **壞掉的機器繼續收流量** 🔴 |
| 熔斷器（Resilience4j / Istio） | 5xx 比例 → 開熔斷。全 200 → 熔斷永不觸發 |
| 重試機制（Envoy `retry_on: 5xx`） | 狀態碼 |
| WAF / 異常偵測 | 4xx 暴增 → 可能有攻擊。全 200 → 看不到 |

**損失 3 的第二項最致命**：K8s 的 `livenessProbe`/`readinessProbe` 靠狀態碼判斷。
如果你的健康檢查端點在資料庫掛掉時仍然回 200，K8s 不會重啟 Pod，
LB 不會把它移出輪詢，**壞掉的機器會繼續收流量**。

**損失 4：可讀性與除錯**

```bash
# 全回 200 時，你不能這樣快速篩出問題
grep ' 500 ' access.log
awk '$9 >= 400' access.log

# 只能寫成
cat access.log | jq 'select(.body.code != 0)'    # ← 但 access.log 通常不記 body
```

而且 `access.log` **通常不記錄 body**（記了會爆掉、會有個資問題），
所以錯誤資訊完全不在你的 log 裡。

**損失 5：新人與外部整合的認知成本**

第三方廠商拿到你的 API：

```
「為什麼我收到 200 但沒有資料？」
「哦，你要看 body 裡的 code。」
「code 的清單在哪？」
「在我們的 Wiki，第三頁的第二個表格，可能有點舊。」
```

而 HTTP 狀態碼是**全世界共通的知識**，不需要教。

### 2.12.4 如果一定要包裝，怎麼做傷害最小

有時候你無法改變組織的既有規範。折衷方案：

**方案 A：狀態碼正確 + 包裝層保留（推薦）**

```http
HTTP/1.1 409 Conflict                    ← 狀態碼正確 ✅
Content-Type: application/json

{
  "code": 40901,                          ← 保留原有的自訂碼 ✅
  "message": "庫存不足",
  "data": null,
  "traceId": "4f2c8a1e9b7d3f60"
}
```

**兩邊都拿到**：監控靠狀態碼，既有的客戶端靠 `code`。
**這是最實用的漸進遷移路徑** —— 舊客戶端不用改一行程式。

**方案 B：新端點用標準做法，舊端點不動**

```
/v1/*        舊：全回 200 + code
/v2/*        新：正確狀態碼 + Problem Details
```

代價是兩套並存的複雜度，但至少止血了。

**方案 C：閘道層轉換（謹慎）**

在 API Gateway 讀 body 的 `code`，轉成對應的 HTTP 狀態碼。
✅ 後端不用改。
❌ 閘道要解析每個回應的 body（效能成本、複雜度、串流回應無法處理）。

**最不該做的**：什麼都不做，然後在事故檢討會上說「我們的監控有盲點」。

---

## 2.13 shop-service 方法與狀態碼契約表

這是本章的產出。第 04 章會為每個錯誤補上 `code` 與訊息。

### 2.13.1 訂單

| 方法 | 路徑 | 成功 | 可能的錯誤 |
|---|---|---|---|
| `GET` | `/orders` | `200`（空集合也是 `200` + `[]`） | `400` 參數錯、`401`、`403` 帶了 `customerId` 但無權限 |
| `POST` | `/orders` | `201` + `Location`<br>`200` + `Idempotent-Replay`（重播） | `400`、`401`、`409` 庫存不足、`422` 驗證失敗／商品不存在、`429` |
| `GET` | `/orders/{id}` | `200`<br>`304`（帶 `If-None-Match`） | `401`、`404`（不存在或不是你的） |
| `PATCH` | `/orders/{id}` | `200` + 更新後資源 + 新 `ETag` | `400`、`401`、`404`、`409` 狀態不允許改、`412` `If-Match` 不符、`422`、`428` 未帶 `If-Match` |
| `GET` | `/orders/{id}/items` | `200` | `401`、`404` |
| `GET` | `/orders/{id}/status-changes` | `200` | `401`、`404` |
| `GET` | `/orders/{id}/invoice` | `200`、`404` 未開票 | `401` |
| `PUT` | `/orders/{id}/invoice` | `200`／`201` 首次 | `400`、`401`、`404`、`409` 已開票不可改、`412`、`422` 統編格式錯、`428` |

**沒有 `DELETE /orders/{id}`**（第 01 章 1.2.2）。

### 2.13.2 訂單動作

| 方法 | 路徑 | 成功 | 可能的錯誤 |
|---|---|---|---|
| `POST` | `/orders/{id}/payments` | `201` + `Location`<br>`202` 需 3DS 驗證<br>`200` 重播 | `401`、`404`、`409` 已付款／狀態不允許、`422` 金額不符／卡片資料錯、`402` 付款被拒（見下）、`429`、`502` 金流商異常、`504` 金流商超時 |
| `GET` | `/orders/{id}/payments` | `200` | `401`、`404` |
| `POST` | `/orders/{id}/cancellations` | `201` + `Location` | `401`、`404`、`409` 已出貨不可取消／已有取消單、`422` 原因無效 |
| `POST` | `/orders/{id}/shipments` | `201` + `Location` | `401`、`403` 非倉管、`404`、`409` 未付款／已全部出貨、`422` 物流單號格式錯 |
| `POST` | `/orders/{id}/returns` | `201` + `Location` | `401`、`404`、`409` 超過 7 天／未完成、`422` |
| `POST` | `/orders/{id}/notifications` | `201` | `401`、`404`、`422` 通知類型無效、`429` 重寄太頻繁 |

**`402 Payment Required` 值得特別說明**：

它原本在 RFC 中是「保留給未來使用」，但 **Stripe 用它表示「卡片被拒」**，
現在已經成為金流領域的事實慣例。

```http
HTTP/1.1 402 Payment Required
Content-Type: application/problem+json

{
  "type": "https://api.shop.example/problems/payment-declined",
  "title": "付款被拒絕",
  "status": 402,
  "detail": "The card was declined by the issuing bank.",
  "code": "CARD_DECLINED",
  "declineCode": "insufficient_funds",
  "userMessage": "您的卡片餘額不足，請更換其他付款方式。",
  "retryable": false,
  "traceId": "4f2c8a1e9b7d3f60"
}
```

**為什麼不用 `422`？** 因為請求內容完全正確（卡號有效、金額對），
是**外部系統拒絕**了。`402` 讓客戶端可以專門處理「付款失敗」這個高頻且需要特殊 UI 的情境。

**shop-service 的付款狀態碼分工**：

| 情境 | 碼 |
|---|---|
| 卡號格式錯、CVV 位數錯 | `422` |
| 金額和訂單不符 | `422` |
| 訂單已付款 | `409` |
| 訂單狀態不允許付款（已取消） | `409` |
| 卡片被銀行拒絕（餘額不足、風控） | `402` |
| 需要 3DS 驗證 | `202` + `nextAction` |
| 金流商回了無效資料 | `502` |
| 金流商超時 | `504` |
| 金流商維護中 | `503` + `Retry-After` |

### 2.13.3 購物車

| 方法 | 路徑 | 成功 | 錯誤 |
|---|---|---|---|
| `GET` | `/carts/current` | `200`（沒有也回空購物車，**不是 `404`**） | `401` |
| `DELETE` | `/carts/current` | `204` | `401` |
| `POST` | `/carts/current/items` | `201` + `Location`<br>`200` 若同商品累加 | `401`、`409` 庫存不足、`422` 商品不存在／下架 |
| `PATCH` | `/carts/current/items/{id}` | `200` | `401`、`404`、`409` 庫存不足、`422` 數量 ≤ 0 |
| `DELETE` | `/carts/current/items/{id}` | `204` | `401`、`404` |
| `DELETE` | `/carts/current/items` | `204` | `401` |
| `PUT` | `/carts/current/coupon` | `200` + 重算後的購物車 | `401`、`404` 折扣碼不存在、`409` 已用完、`422` 已過期／不符使用條件 |
| `DELETE` | `/carts/current/coupon` | `204`／`404` 本來就沒有 | `401` |
| `POST` | `/carts/current/recalculate` | `200` + 重算後的購物車 | `401` |

### 2.13.4 商品

| 方法 | 路徑 | 成功 | 錯誤 |
|---|---|---|---|
| `GET` | `/products` | `200`、`304` | `400` 參數錯 |
| `GET` | `/products/{id}` | `200`、`304` | `404`、`410` 已下架 + 替代品建議 |
| `POST` | `/products` | `201` + `Location` | `400`、`401`、`403`、`409` SKU 重複、`422` |
| `PATCH` | `/products/{id}` | `200` | `400`、`401`、`403`、`404`、`412`、`422` |
| `PUT` | `/products/{id}/status` | `200` | `401`、`403`、`404`、`422` 無效狀態轉換 |
| `DELETE` | `/products/{id}` | `204` | `401`、`403`、`404`、`409` 有進行中訂單引用 |
| `GET` | `/products/{id}/inventory` | `200`（無庫存回 `{"available":0}`） | `404` |
| `POST` | `/products/{id}/inventory-adjustments` | `201` | `401`、`403`、`404`、`422` delta 為 0、`409` 會導致負庫存 |
| `POST` | `/products/{id}/images` | `201` + `Location` | `401`、`403`、`404`、`413` 檔案太大、`415` 非圖片格式、`422` 尺寸不符 |

**注意 `GET /products` 沒有 `401`**：商品列表是公開的（不需登入）。
**這種「哪些端點需要驗證」的資訊也是契約的一部分**，要寫進 OpenAPI 的 `security`。

### 2.13.5 工作型資源

| 方法 | 路徑 | 成功 | 錯誤 |
|---|---|---|---|
| `POST` | `/order-exports` | `202` + `Location` + `Retry-After` | `401`、`422` 條件無效、`429` 同時太多匯出 |
| `GET` | `/order-exports/{id}` | `200`（含 `status`：`QUEUED`/`RUNNING`/`SUCCEEDED`/`FAILED`） | `401`、`404`、`410` 已過期清理 |
| `DELETE` | `/order-exports/{id}` | `202` 正在取消／`200` 已停止 | `401`、`404`、`409` 已完成不可取消 |
| `POST` | `/order-import-jobs` | `202` + `Location` | `401`、`403`、`422` 檔案格式錯 |
| `GET` | `/order-import-jobs/{id}/errors` | `200` | `401`、`404`、`409` 工作還在跑（錯誤清單未完整） |

### 2.13.6 全域規則（寫進 style guide）

```
□ 集合端點永遠回 200 + 陣列（空集合是 [], 不是 null, 不是 404, 不是 204）
□ POST 建立成功一律 201 + Location
□ 非同步操作一律 202 + Location（指向工作資源）+ Retry-After
□ DELETE 成功回 204（無 body）；第二次回 404
□ PATCH / PUT 成功回 200 + 更新後的完整資源 + 新的 ETag
□ 401 一律附 WWW-Authenticate
□ 405 一律附 Allow
□ 429 / 503 一律附 Retry-After
□ 所有錯誤回應用 application/problem+json（第 04 章）
□ 所有錯誤回應含 traceId
□ 存在性敏感的資源，未授權存取回 404 而非 403
□ 多人協作的資源，寫入必須帶 If-Match，否則 428
□ 5xx 一定是「我們的錯」；業務規則失敗絕不用 5xx
□ 過載回 503（不是 429）；單一客戶端超量回 429
□ 任何跨來源 API 都要設 Access-Control-Expose-Headers
```

---

## 2.14 用 curl 實測

### 2.14.1 觀察狀態碼與 header

```bash
# 只看狀態碼（寫測試腳本最常用）
curl -s -o /dev/null -w '%{http_code}\n' https://api.github.com/repos/spring-projects/spring-boot
# 200

# 看完整 header（設計 API 時最常用）
curl -s -o /dev/null -D - https://api.github.com/repos/spring-projects/spring-boot

# 觀察 405 + Allow
curl -s -o /dev/null -D - -X DELETE https://api.github.com/repos/spring-projects/spring-boot | grep -i 'HTTP/\|allow'

# 觀察 401 + WWW-Authenticate（用一個需要驗證的端點）
curl -s -o /dev/null -D - https://api.github.com/user | grep -i 'HTTP/\|www-authenticate'
```

### 2.14.2 實測 `ETag` 與 `304`

```bash
URL=https://api.github.com/repos/spring-projects/spring-boot

# 第一次：拿到 ETag
ETAG=$(curl -s -o /dev/null -D - "$URL" | awk -F': ' 'tolower($1)=="etag"{print $2}' | tr -d '\r')
echo "ETag = $ETAG"

# 第二次：帶 If-None-Match
curl -s -o /dev/null -w 'status=%{http_code} downloaded=%{size_download} bytes\n' \
  -H "If-None-Match: $ETAG" "$URL"
# status=304 downloaded=0 bytes    ← 省下整個 body
```

**這個實驗值得自己跑一次**：親眼看到 `downloaded=0` 會比讀十遍規範更有感。

### 2.14.3 實測限流 header

```bash
curl -s -o /dev/null -D - https://api.github.com/rate_limit \
  | grep -i 'x-ratelimit'
# x-ratelimit-limit: 60
# x-ratelimit-remaining: 57
# x-ratelimit-reset: 1755587564
# x-ratelimit-resource: core
# x-ratelimit-used: 3
```

GitHub 的限流 header 是很好的參考範本（第 08 章會詳談）。

### 2.14.4 用 `httpbin` 測各種狀態碼

```bash
# 產生任意狀態碼（測前端錯誤處理很好用）
curl -s -o /dev/null -w '%{http_code}\n' https://httpbin.org/status/418
curl -s -o /dev/null -w '%{http_code}\n' https://httpbin.org/status/503

# 測導向（觀察方法是否保留）
curl -s -o /dev/null -w '%{http_code} → %{redirect_url}\n' https://httpbin.org/redirect/1

# 跟隨導向並觀察最終方法
curl -s -L -X POST -w '\nfinal_method=%{method}\n' https://httpbin.org/redirect-to?url=/post\&status_code=307

# 測慢回應（測超時設定）
time curl -s -o /dev/null --max-time 3 https://httpbin.org/delay/5
```

### 2.14.5 寫一個狀態碼契約測試腳本

把 2.13 的契約表變成可執行的檢查（第 09 章會擴充成完整的契約測試）：

```bash
#!/usr/bin/env bash
# api/contract-smoke.sh —— 放進 repo，CI 也可以跑
set -u
HOST=${HOST:-http://localhost:8080}
TOKEN=${TOKEN:?請設定 TOKEN}
FAILED=0

check() {
  local desc="$1" expected="$2"; shift 2
  local actual
  actual=$(curl -s -o /dev/null -w '%{http_code}' "$@")
  if [ "$actual" = "$expected" ]; then
    printf '  ✅ %-50s %s\n' "$desc" "$actual"
  else
    printf '  ❌ %-50s expected=%s actual=%s\n' "$desc" "$expected" "$actual"
    FAILED=$((FAILED + 1))
  fi
}

echo "── 讀取 ────────────────────────────────"
check "GET /orders 需要驗證"          401 "$HOST/orders"
check "GET /orders 已驗證"            200 -H "Authorization: Bearer $TOKEN" "$HOST/orders"
check "GET /orders/{不存在}"          404 -H "Authorization: Bearer $TOKEN" "$HOST/orders/ord_nonexistent"
check "GET /products 公開"            200 "$HOST/products"

echo "── 方法與格式 ──────────────────────────"
check "DELETE /orders/{id} 不支援"    405 -X DELETE -H "Authorization: Bearer $TOKEN" "$HOST/orders/ord_1"
check "POST /orders 缺 Content-Type"  415 -X POST -H "Authorization: Bearer $TOKEN" -d '{}' "$HOST/orders"
check "POST /orders JSON 壞掉"        400 -X POST -H "Authorization: Bearer $TOKEN" \
      -H 'Content-Type: application/json' -d '{"items":[' "$HOST/orders"
check "POST /orders items 空陣列"     422 -X POST -H "Authorization: Bearer $TOKEN" \
      -H 'Content-Type: application/json' -d '{"items":[]}' "$HOST/orders"

echo "── 併發保護 ────────────────────────────"
check "PATCH 未帶 If-Match"           428 -X PATCH -H "Authorization: Bearer $TOKEN" \
      -H 'Content-Type: application/merge-patch+json' -d '{"internalNote":"x"}' "$HOST/orders/ord_1"
check "PATCH If-Match 過期"           412 -X PATCH -H "Authorization: Bearer $TOKEN" \
      -H 'If-Match: "v0"' -H 'Content-Type: application/merge-patch+json' \
      -d '{"internalNote":"x"}' "$HOST/orders/ord_1"

echo
[ "$FAILED" -eq 0 ] && { echo "全部通過 ✅"; exit 0; } || { echo "$FAILED 項失敗 ❌"; exit 1; }
```

---

## 2.15 常見誤區

**誤區 1：「冪等就是每次回傳一樣」**
2.2.1 已破解。冪等講**伺服器狀態**，不是回應內容。
`DELETE` 第一次 `204`、第二次 `404`，仍然是冪等的。

**誤區 2：「`PUT` 和 `PATCH` 差不多，隨便用」**
`PUT` 沒送的欄位會被**清空**。這是最常見的資料遺失原因（2.5.1）。

**誤區 3：「`PATCH` 一定不冪等」**
規範說「不保證」，不是「不能」。用絕對值的 `PATCH` 是冪等的（2.5.5）。

**誤區 4：「空集合要回 404」**
集合資源存在，只是沒有成員 → `200` + `[]`。
`404` 是「這個 URI 沒有對應的資源」。

**誤區 5：「`201` 只要回 body 就好，`Location` 可以省」**
省了 `Location`，客戶端就得自己拼 URL → 把你的路由規則寫死在客戶端。

**誤區 6：「業務錯誤用 `500` 比較簡單」**
🔴 這會讓值班工程師被無意義的告警轟炸，最後所有人都關掉告警 —— 
然後真的事故發生時沒人知道。**5xx 是「我們的錯」的專用訊號，不能污染。**

**誤區 7：「404 比 403 不友善，所以一律用 403」**
403 會洩漏資源存在性（2.9.3）。對外 API 應該用 404。
「友善」要靠錯誤訊息（第 04 章），不是靠狀態碼。

**誤區 8：「反正前端會看 body，狀態碼不重要」**
2.12.3 列了五個具體損失。狀態碼不是給前端看的，是給**基礎設施**看的。

**誤區 9：「`202` 之後客戶端會自己知道要輪詢」**
不會。要給 `Location`（指向工作資源）、`Retry-After`（多久後再來），
以及明確的 `status` 欄位設計。

**誤區 10：「有 `@Version` 就有樂觀鎖保護了」**
資料庫層有，但**API 層沒有**。如果客戶端不帶 `If-Match`，
它送上來的就是「用舊資料算出來的完整物件」，資料庫的版本檢查也擋不住
（因為你是用讀出來的 entity 更新，版本是新的）。
**`ETag` + `If-Match` 才是 API 層的樂觀鎖。**

---

## 2.16 本章練習

### 練習 1：判斷安全性與冪等性

以下操作各是否安全？是否冪等？如果不冪等，網路重試會發生什麼？

```
1. GET  /orders?status=PAID
2. PUT  /orders/1001/status         { "status": "CANCELLED" }
3. POST /orders/1001/payments       { "amount": "1280.50" }
4. DELETE /me/addresses/addr_1
5. PATCH /products/P-1001           { "price": "999.00" }
6. PATCH /products/P-1001           { "stockDelta": -5 }
7. POST /orders/1001/notifications  { "type": "ORDER_CONFIRMATION" }
8. PUT  /articles/{id}/like
9. POST /order-exports              { "createdFrom": "2026-08-01" }
10. GET /products/P-1001            （會 UPDATE view_count）
```

<details>
<summary>參考解答</summary>

| # | 安全 | 冪等 | 重試的後果 |
|---|---|---|---|
| 1 | ✅ | ✅ | 無害 |
| 2 | ❌ | ✅ | 無害（狀態已經是 CANCELLED，再設一次還是 CANCELLED） |
| 3 | ❌ | ❌ | 🔴 **重複扣款**。必須用冪等鍵 |
| 4 | ❌ | ✅ | 無害（第二次回 404，但狀態相同） |
| 5 | ❌ | ✅ | 無害（絕對值，設幾次都是 999） |
| 6 | ❌ | ❌ | 🔴 **庫存被多扣**。相對運算不冪等 → 應改為 `POST /products/{id}/inventory-adjustments` + 冪等鍵 |
| 7 | ❌ | ❌ | ⚠️ 使用者收到兩封信。傷害小，但仍應加冪等鍵或短期去重 |
| 8 | ❌ | ✅ | 無害（按幾次都是一個讚）—— 這就是為什麼用 `PUT` 不用 `POST` |
| 9 | ❌ | ❌ | ⚠️ 產生兩個匯出工作，浪費資源、使用者困惑。應加冪等鍵 |
| 10 | ⚠️ **技術上不安全** | ⚠️ | `view_count` 被多加。<br>實務上被接受，但正確做法是非同步打點（2.3.1） |

**第 6 題是最重要的一題。** 「`PATCH` + 相對值」看起來很方便，
但它同時犯了三個錯：不冪等、無紀錄、併發不安全（第 01 章 1.7.2）。

**第 10 題的細節**：如果 `view_count` 是一個熱門商品的欄位，
每次 `GET` 都 `UPDATE` 同一行 → **所有請求排隊等同一個行鎖**，
在雙 11 這種流量下會直接把資料庫拖垮。這不只是「語意不純」，是實際的效能地雷。

</details>

### 練習 2：選狀態碼

以下情境該回什麼狀態碼？

```
1.  GET /orders?status=CANCELLED，但沒有任何已取消的訂單
2.  GET /orders/ord_abc，這張訂單屬於別人（對外 API）
3.  POST /orders，body 是 { "items": [] }
4.  POST /orders，body 是 { "items": [{ "productId": "P-9999" }] }，P-9999 不存在
5.  POST /orders，商品存在但庫存只有 3，客戶要 5 個
6.  POST /orders/{id}/cancellations，訂單已出貨
7.  POST /orders/{id}/cancellations，這張訂單已經有一張取消單了
8.  PATCH /orders/{id}，帶了 If-Match: "v3"，但目前是 v5
9.  PATCH /orders/{id}，完全沒帶 If-Match（且此資源要求必帶）
10. GET /orders/{id}，token 已過期
11. GET /customers（客服端點），呼叫者是普通顧客
12. POST /orders/{id}/payments，卡片被銀行拒絕（餘額不足）
13. POST /orders/{id}/payments，金流商 30 秒沒回應
14. POST /orders/{id}/payments，金流商回了一段 HTML 錯誤頁
15. POST /order-exports，這個使用者已經有 5 個進行中的匯出（上限 3）
16. GET /products/P-1001，這個商品上個月已下架
17. POST /products/{id}/images，上傳 50MB 的檔案（上限 10MB）
18. POST /products/{id}/images，上傳一個 .exe 檔
19. DELETE /me/addresses/addr_1，這個地址正被一張進行中的訂單使用
20. GET /orders，資料庫連線池耗盡
21. GET /orders，你的程式有 NullPointerException
22. GET /orders，正在滾動更新，這台機器準備關閉
23. PUT /orders/{id}/invoice，統一編號填了 7 位數字（應為 8 位）
24. PUT /orders/{id}/invoice，這張訂單已經開過發票了
```

<details>
<summary>參考解答</summary>

| # | 碼 | 理由 |
|---|---|---|
| 1 | `200` + `[]` | 集合存在，只是空的（2.3.3） |
| 2 | `404` | 不洩漏存在性（2.9.3） |
| 3 | `422` | 語意錯誤：訂單至少要一項商品 |
| 4 | `422` | 參照的資源不存在 → 請求內容錯（2.9.4） |
| 5 | `409` | 庫存狀態衝突；回應要帶 `available: 3`（2.9.4） |
| 6 | `409` | 資源當前狀態不允許 |
| 7 | `409` | 已存在，衝突 |
| 8 | `412` | `If-Match` 不符（2.11.2） |
| 9 | `428` | Precondition Required（2.11.3） |
| 10 | `401` + `WWW-Authenticate: Bearer error="invalid_token"` | 認證問題，前端要刷新 token |
| 11 | `403` | 有身分但無權限。端點存在性本來就公開（2.9.3） |
| 12 | `402` | 付款被拒（2.13.2）。body 要帶 `declineCode` |
| 13 | `504` | 等上游超時（2.8.5） |
| 14 | `502` | 上游回了無效回應 |
| 15 | `429` + `Retry-After` | 超過配額。也可用 `409`（狀態衝突），但 `429` 更精確 |
| 16 | `410` + 替代商品建議 | 曾存在、已永久移除（2.6.2） |
| 17 | `413 Content Too Large` | body 太大 |
| 18 | `415 Unsupported Media Type` | Content-Type 不支援。⚠️ **也要檢查實際 magic bytes**，不能只信 Content-Type |
| 19 | `409` | 有依賴不能刪。回應要說明是哪張訂單 |
| 20 | `503` + `Retry-After` | 我自己的資源耗盡（不是 `500`，因為這是暫時的、可重試的） |
| 21 | `500` | 未預期的 bug（要告警、要修） |
| 22 | `503` + `Retry-After` | 正在關閉，客戶端可重試（優雅關閉，02-spring-boot 第 08 章） |
| 23 | `422` | 格式驗證失敗 |
| 24 | `409` | 已存在／狀態不允許修改 |

**第 20 vs 21 的區別是本題重點**：

```
連線池耗盡 → 503：暫時性、重試可能成功、要擴容或調參數
NPE       → 500：程式 bug、重試也會失敗、要改程式
```

如果兩者都回 `500`，值班工程師無法從告警判斷「要不要立刻擴容」還是「要不要 rollback」。

**第 22 也很重要**：優雅關閉期間回 `503` 讓 LB 知道要把流量導到別台。
如果回 `500`，客戶端可能不重試，使用者就看到錯誤了。

</details>

### 練習 3：`PUT` 造成的資料遺失

某系統的「編輯商品」功能：

```java
@PutMapping("/products/{id}")
public ProductResponse update(@PathVariable String id,
                              @RequestBody @Valid ProductRequest req) {
    Product p = repo.findById(id).orElseThrow();
    p.setName(req.name());
    p.setPrice(req.price());
    p.setDescription(req.description());
    p.setCategoryId(req.categoryId());
    return mapper.toResponse(repo.save(p));
}
```

前端的編輯表單有 `name`、`price`、`categoryId`，**沒有 `description`**
（因為描述是在另一個「編輯描述」的 rich text 頁面改的）。

1. 使用者在編輯表單改了價格，按儲存。發生什麼事？
2. 有幾種修法？各自的取捨？
3. 如果加上「兩個管理員同時編輯」，還會有什麼問題？

<details>
<summary>參考解答</summary>

**1. 發生什麼事**

前端送出：
```json
{ "name": "無線耳機", "price": "999.00", "categoryId": "cat_1" }
```

`req.description()` 是 `null` → `p.setDescription(null)` → **整段商品描述被清空**。

而且：
- 沒有任何錯誤訊息（`description` 是選填欄位，`@Valid` 通過）。
- 前端顯示「儲存成功」。
- 要等到有人瀏覽商品頁，才會發現描述不見了。
- 如果描述是 SEO 內容，可能幾週後才從搜尋流量下滑發現。

**這是靜默資料遺失，最難發現的一類 bug。**

**2. 五種修法**

| 修法 | 做法 | 取捨 |
|---|---|---|
| **A. 改用 `PATCH`** ★ | `PATCH` + Merge Patch，只送有變的欄位 | ✅ 最正確<br>⚠️ 要處理 `null` 三態（2.5.4） |
| **B. 前端先 `GET` 再 `PUT` 完整物件** | 前端拿完整資源，只改該改的，全部送回 | ✅ 保持 `PUT` 語意<br>❌ 多一次往返；⚠️ 併發問題更嚴重（見第 3 題） |
| **C. 後端只更新非 `null` 的欄位** | `if (req.description() != null) p.setDescription(...)` | ⚠️ **這讓 `PUT` 變成 `PATCH`，但 `Content-Type` 還是 `PUT`** —— 語意騙人。<br>而且從此**無法清空任何欄位** |
| **D. 拆分端點** | `PUT /products/{id}/basic-info`、`PUT /products/{id}/description` | ✅ 每個端點語意清楚、權限可分開<br>❌ 端點變多 |
| **E. 用 `ProductRequest` 的 `JsonNullable`** | 明確區分「未送」與「送 null」 | ✅ 語意最精確<br>❌ 但這時你其實就是在做 `PATCH` 了，不如用 A |

**推薦：A（改用 `PATCH`）**。理由：

- 前端表單本來就只有部分欄位 → `PATCH` 的語意完全吻合。
- 修法 C 是最常見的錯誤選擇：它讓 API 的行為和方法語意不一致，
  下一個接手的人看到 `PUT` 會以為是全量替換，然後又寫出 bug。

**但如果表單真的有全部欄位**（例如一個完整的商品編輯頁），那 `PUT` + 修法 B 是正確的。
**方法要跟著前端的實際行為選。**

**3. 併發問題**

```
時間  管理員 A（改價格）              管理員 B（改分類）
─────────────────────────────────────────────────────────
T1    GET /products/P-1001
      price=1280, categoryId=cat_1
T2                                    GET /products/P-1001
                                      price=1280, categoryId=cat_1
T3    PUT { price: 999, categoryId: cat_1 }
      → 200 ✅（price=999, cat_1）
T4                                    PUT { price: 1280, categoryId: cat_2 }
                                      → 200 ✅（price=1280, cat_2）
─────────────────────────────────────────────────────────
結果：A 的降價被 B 覆蓋回去了。
      B 完全不知道自己改掉了價格 —— 他只想改分類。
```

**注意修法 B 反而讓這個問題更嚴重**：因為 `PUT` 送的是完整物件，
B 把「他 T2 讀到的舊價格」也一起送上去了。

**用 `PATCH` 會好一些**（B 只送 `categoryId`，不會覆蓋 `price`），
但**仍然不安全**：如果兩人都改同一個欄位，還是會後蓋前。

**完整解法：`ETag` + `If-Match`**（2.11）

```http
# A
GET /products/P-1001          → ETag: "v7"
PATCH /products/P-1001
If-Match: "v7"
{ "price": "999.00" }         → 200, ETag: "v8"

# B
GET /products/P-1001          → ETag: "v7"（T2 讀的）
PATCH /products/P-1001
If-Match: "v7"
{ "categoryId": "cat_2" }     → 412 Precondition Failed ✅
                                 「此商品已被王管理員修改，請重新載入」
```

**這一題的完整答案是三層防護**：

```
第 1 層：用對方法（PATCH 而非 PUT）        → 避免誤清未送的欄位
第 2 層：ETag + If-Match（428 強制）       → 避免併發覆蓋
第 3 層：資料庫 @Version 樂觀鎖            → 避免 API 層漏掉時的最後防線
```

三層都要有。少任何一層都會在某個情境下出事。

</details>

### 練習 4：設計非同步端點

設計「批次調整商品價格」的 API。需求：

- 一次可能調整 5,000 個商品。
- 要支援「預覽」（dry-run，看會影響哪些商品但不真的改）。
- 要能看進度、能取消。
- 要有審核：調價超過 ±30% 需要主管核准。
- 要能查歷史（誰在什麼時候調了什麼）。

<details>
<summary>參考解答</summary>

**資源設計**

```
PriceAdjustmentBatch    調價批次（工作 + 審核 + 歷史三合一）
```

一個資源同時承擔三個角色是刻意的：它本來就是「一次調價作業」這個業務事實。

**端點設計**

```http
# ── 1. 建立（預覽模式） ──────────────────────────────
POST /price-adjustment-batches
Content-Type: application/json
Idempotency-Key: 8f14e45f-...

{
  "mode": "DRY_RUN",
  "filter": { "categoryId": "cat_electronics", "priceMin": "1000.00" },
  "adjustment": { "type": "PERCENTAGE", "value": -15 },
  "effectiveAt": "2026-09-01T00:00:00Z",
  "reason": "換季促銷"
}

→ 202 Accepted
Location: /price-adjustment-batches/pab_01J5GK...
Retry-After: 3
{ "batchId": "pab_01J5GK...", "mode": "DRY_RUN", "status": "QUEUED" }

# ── 2. 看預覽結果 ────────────────────────────────────
GET /price-adjustment-batches/pab_01J5GK...

→ 200 OK
{
  "batchId": "pab_01J5GK...",
  "mode": "DRY_RUN",
  "status": "SUCCEEDED",
  "summary": {
    "affectedCount": 4821,
    "skippedCount": 12,
    "requiresApprovalCount": 340,        ← 超過 ±30% 的
    "totalRevenueImpact": "-1284000.00"
  },
  "approval": { "required": true, "reason": "340 items exceed ±30% threshold" },
  "createdBy": { "type": "ADMIN", "displayName": "陳採購" },
  "createdAt": "2026-08-19T06:12:44Z"
}

GET /price-adjustment-batches/pab_01J5GK.../items?page=0&size=50&requiresApproval=true
→ 200 OK
{
  "items": [
    { "productId": "P-1001", "name": "無線耳機",
      "currentPrice": "1280.00", "newPrice": "1088.00",
      "changePercent": -15.0, "requiresApproval": false },
    { "productId": "P-2003", "name": "藍牙喇叭",
      "currentPrice": "3200.00", "newPrice": "1920.00",
      "changePercent": -40.0, "requiresApproval": true,
      "approvalReason": "EXCEEDS_THRESHOLD" }
  ],
  "page": { "number": 0, "size": 50, "totalElements": 340 }
}

# ── 3. 送出審核 ──────────────────────────────────────
POST /price-adjustment-batches/pab_01J5GK.../submissions

→ 201 Created
{ "status": "PENDING_APPROVAL", "submittedAt": "...", "approvers": ["林經理"] }

錯誤：
  409  status 不是 SUCCEEDED（預覽還沒跑完）
  409  已經送審過了
  422  預覽結果為空（沒有任何商品符合）

# ── 4. 主管核准 / 駁回 ───────────────────────────────
POST /price-adjustment-batches/pab_01J5GK.../approvals
If-Match: "v3"
{ "comment": "同意，但 P-2003 請維持原價" , "excludedProductIds": ["P-2003"] }

→ 201 Created
{ "status": "APPROVED", "approvedBy": {...}, "approvedAt": "...",
  "excludedCount": 1 }

POST /price-adjustment-batches/pab_01J5GK.../rejections
{ "reason": "TOO_AGGRESSIVE", "comment": "降幅過大，請重新評估" }
→ 201 Created  { "status": "REJECTED" }

錯誤：
  403  呼叫者不是 approver
  409  status 不是 PENDING_APPROVAL
  409  自己送審的自己核准（如果業務禁止）
  412  If-Match 不符（別人先處理了）

# ── 5. 執行 ──────────────────────────────────────────
POST /price-adjustment-batches/pab_01J5GK.../executions
Idempotency-Key: 9a25f56g-...

→ 202 Accepted
Location: /price-adjustment-batches/pab_01J5GK...
Retry-After: 5
{ "status": "EXECUTING", "startedAt": "..." }

錯誤：
  409  status 不是 APPROVED
  409  已經執行過了
  409  effectiveAt 已過期（預覽結果太舊，價格可能已變）

# ── 6. 看執行進度 ────────────────────────────────────
GET /price-adjustment-batches/pab_01J5GK...

→ 200 OK
Retry-After: 5
{
  "status": "EXECUTING",
  "progress": { "processed": 2400, "succeeded": 2395, "failed": 5, "total": 4820 },
  "estimatedCompletionAt": "2026-08-19T06:18:00Z"
}

完成後：
{
  "status": "COMPLETED",
  "progress": { "processed": 4820, "succeeded": 4810, "failed": 10, "total": 4820 },
  "completedAt": "...",
  "rollbackAvailableUntil": "2026-08-26T06:18:00Z"      ← ★ 很實用
}

# ── 7. 取消 ──────────────────────────────────────────
DELETE /price-adjustment-batches/pab_01J5GK...

→ 202 Accepted   （正在停止；已處理的不會回復）
→ 200 OK          （尚未開始，直接取消）
→ 409 Conflict    （已完成，不能取消 → 請用 rollback）

# ── 8. 回復（★ 大量寫入操作一定要有） ───────────────
POST /price-adjustment-batches/pab_01J5GK.../rollbacks
Idempotency-Key: ...

→ 202 Accepted
Location: /price-adjustment-batches/pab_rollback_01J5GK...
（回復本身也是一個批次，有自己的進度與紀錄）

錯誤：
  409  status 不是 COMPLETED
  409  超過 rollbackAvailableUntil
  409  已經回復過了
  422  部分商品在此之後又被改過（要不要強制覆蓋？→ 提供 ?force=true）

# ── 9. 歷史查詢 ──────────────────────────────────────
GET /price-adjustment-batches?status=COMPLETED&createdFrom=2026-08-01&page=0&size=20
GET /price-adjustment-batches?createdBy=me
GET /products/P-1001/price-changes           ← 從商品的角度看歷史
```

**狀態機**

```
DRY_RUN 建立
    ↓
  QUEUED → RUNNING → SUCCEEDED ─────┐
                   ↘ FAILED         │
                                    ↓
                            PENDING_APPROVAL
                                 ↙      ↘
                          APPROVED    REJECTED（終態）
                              ↓
                          EXECUTING
                          ↙        ↘
                   COMPLETED      FAILED
                       ↓
                  ROLLED_BACK（終態）
```

**這題的六個關鍵設計決策**

| 決策 | 理由 |
|---|---|
| 用**一個** batch 資源，`mode` 區分 dry-run／實際 | 預覽和執行用同一份參數 → 保證「你看到的就是會發生的」。<br>拆成兩個資源會有「預覽的參數和執行的參數不一致」的漏洞 |
| 審核用**手法 2**（`approvals` / `rejections` 子資源） | 稽核要求：誰核准、何時、意見。而且核准與駁回的欄位不同 |
| 執行也是**子資源** `executions` | 「執行」是一次動作，有開始時間、有結果，而且可能重試 |
| 全程用**一個** batch ID 貫穿 | 預覽 → 審核 → 執行 → 回復 都指向同一個 `pab_01J5GK...`，<br>整條軌跡在一個資源上查得到（稽核最需要這個） |
| 提供 `rollbacks` | 🔴 **任何影響 5000 筆資料的操作都必須可回復**。<br>沒有回復機制的批次操作是定時炸彈 |
| 核准要帶 `If-Match` | 兩個主管同時處理同一批 → `412`（2.11.3） |

**⚠️ 一個容易漏掉的點：`effectiveAt` 過期檢查**

預覽是在 T1 算的，執行在 T5。如果中間有商品被單獨調價了，
執行時就會用**過期的 newPrice** 覆蓋掉。

所以執行時要：
- 檢查 `SUCCEEDED` 到 `EXECUTING` 的時間差，超過閾值（例如 24 小時）→ `409` 要求重新預覽。
- 或執行時逐筆比對 `currentPrice` 是否還等於預覽時的值，不等就 skip 並記錄。

**shop-service 選第二種**（逐筆比對），並在結果裡回報 `skippedDueToConcurrentChange` 的清單。
這比直接拒絕整批更實用。

</details>

### 練習 5：檢查一個真實 API 的方法與狀態碼

用 `curl` 探測一個公開 API，回答問題。

```bash
# GitHub API（不需 token 就能做這些）
BASE=https://api.github.com/repos/spring-projects/spring-boot
```

1. `GET` 這個 repo，記下 `ETag`，然後帶 `If-None-Match` 再打一次。狀態碼？下載了幾 bytes？
2. 對它發 `DELETE`。狀態碼？有沒有 `Allow` header？
3. 對它發 `OPTIONS`。回什麼？
4. 打 `GET https://api.github.com/repos/spring-projects/definitely-not-exist`。狀態碼？
5. 打 `GET https://api.github.com/user`（不帶 token）。狀態碼？有 `WWW-Authenticate` 嗎？
6. 找出 GitHub 的限流 header，說明它們的語意。
7. GitHub 建立 issue 是 `POST /repos/{o}/{r}/issues`，回 `201` 且有 `Location`。
   從本章的角度評價 GitHub API 在 Richardson 第幾級、做對了哪些事。

<details>
<summary>參考解答</summary>

**1. `ETag` 與 `304`**

```bash
BASE=https://api.github.com/repos/spring-projects/spring-boot
ETAG=$(curl -s -o /dev/null -D - "$BASE" | awk -F': ' 'tolower($1)=="etag"{print $2}' | tr -d '\r')
curl -s -o /dev/null -w 'status=%{http_code} size=%{size_download}\n' -H "If-None-Match: $ETAG" "$BASE"
```

結果：`status=304 size=0`。

GitHub 回的是**弱 ETag**（`W/"..."`），因為它的回應內容可能因為壓縮或欄位順序有位元組差異，
但語意相同。這對 `If-None-Match` 是允許的（2.11.5）。

**重點**：GitHub 的文件明確說明 **`304` 不計入限流額度**。
所以正確使用 `If-None-Match` 可以讓你的輪詢幾乎免費 —— 這是 `ETag` 最實際的價值。

**2. `DELETE`**

```bash
curl -s -o /dev/null -D - -X DELETE "$BASE" | head -5
```

會得到 `404`（因為未認證，GitHub 不洩漏「這個操作存在」）
或 `403`／`401`，取決於端點。

⚠️ 注意：GitHub 對未認證的寫入操作常回 `404` 而不是 `401`/`405` ——
這是刻意的**存在性保護**（2.9.3）。

**3. `OPTIONS`**

```bash
curl -s -o /dev/null -D - -X OPTIONS "$BASE" | head -10
```

GitHub 通常回 `204` + CORS header。它不提供「查詢支援哪些方法」的 `Allow` ——
因為它的文件就是契約（多數 API 都這樣，2.7.2）。

**4. 不存在的 repo**

`404`。而且回應 body 是標準格式：

```json
{
  "message": "Not Found",
  "documentation_url": "https://docs.github.com/rest/repos/repos#get-a-repository",
  "status": "404"
}
```

**`documentation_url` 是很好的設計**（第 04 章 4.4 的 `type` 欄位概念）：
錯誤直接告訴你去哪看文件。

**5. 未認證的 `/user`**

```bash
curl -s -o /dev/null -D - https://api.github.com/user | grep -i 'HTTP/\|www-authenticate'
```

```
HTTP/2 401
www-authenticate: Bearer realm="octocat at github", error="invalid_request",
                  error_description="No credentials were supplied..."
```

✅ 正確：`401` + `WWW-Authenticate`，而且用了 RFC 6750 的 `error` 參數（2.9.1）。

**6. 限流 header**

| Header | 語意 |
|---|---|
| `x-ratelimit-limit` | 這個時間窗內的總配額（未認證 60，認證後 5000） |
| `x-ratelimit-remaining` | 還剩幾次 |
| `x-ratelimit-used` | 已用幾次 |
| `x-ratelimit-reset` | 重置時間（**Unix 秒數**，不是相對秒數） |
| `x-ratelimit-resource` | 哪一個配額桶（`core`／`search`／`graphql` 各自獨立） |
| `retry-after` | 只在被限流時出現 |

**`x-ratelimit-resource` 是很好的設計**：它揭露了「不同端點有不同配額桶」，
讓客戶端知道「搜尋額度用完了但一般查詢還可以」。第 08 章會參考這個設計。

**7. 評價 GitHub API**

| 面向 | 評價 |
|---|---|
| Richardson 級別 | **Level 2 + 部分 Level 3**。回應裡有大量 `*_url` 欄位（`issues_url`、`commits_url`），<br>是 HATEOAS 的一種實作（URI Template 形式） |
| 方法語意 | ✅ 正確。`GET`/`POST`/`PATCH`/`PUT`/`DELETE` 各司其職 |
| 狀態碼 | ✅ 正確且細緻。`201`+`Location`、`304`、`401`+`WWW-Authenticate`、`403` vs `404` 的存在性保護、`422` 給驗證錯誤 |
| 條件請求 | ✅ 完整支援 `ETag`／`If-None-Match`，且 `304` 不計費 |
| 限流 | ✅ 業界最佳範例之一，多桶設計 + 完整 header |
| 分頁 | ✅ 用 `Link` header（RFC 8288），支援 `next`/`prev`/`first`/`last`（第 05 章會詳談） |
| 版本控管 | ✅ `X-GitHub-Api-Version: 2022-11-28`（日期版本，第 06 章） |
| 錯誤格式 | ⚠️ 自訂格式（`message` + `documentation_url` + `errors`），不是 RFC 9457。<br>但**全站一致**，所以實用性沒問題（第 00 章判準 2） |
| 命名 | ⚠️ `snake_case`（`created_at`、`full_name`）—— 和多數 Java 生態的 `camelCase` 不同，<br>但**全站一致**，所以沒問題 |
| 值得學的 | `documentation_url`、`*_url` 超媒體欄位、多桶限流、`304` 不計費、日期版本 |

**最值得抄的一點**：**`304` 不計入限流**。
這個設計把「正確使用快取」和「拿到更多額度」綁在一起，
用經濟誘因讓客戶端做對的事 —— 比寫在文件裡拜託大家有效得多。

</details>

---

## 2.17 驗收清單

- [ ] 我能精確定義安全與冪等，並知道冪等講的是**伺服器狀態**不是回應內容。
- [ ] 我能說出至少五個「依賴冪等性」的角色（瀏覽器、CDN、客戶端函式庫、反向代理、服務網格）。
- [ ] 我能重現「非冪等 + 自動重試 = 重複扣款」的時間軸，並說出三種解法。
- [ ] 我知道哪些 `POST` 端點必須支援 `Idempotency-Key`，並能說出判準。
- [ ] 我知道 `GET` 絕不能有副作用，也知道「瀏覽計數」該用非同步打點而不是同步 `UPDATE`。
- [ ] 我知道 `201` 必須帶 `Location`，也知道漏掉的代價是「客戶端寫死 URL 規則」。
- [ ] 我能說出 `PUT` 全量替換的陷阱，並重現「漏欄位導致資料被清空」的情境。
- [ ] 我知道 `PUT` 的四個正當用途，包含「客戶端決定 ID 的 upsert」與它的權限陷阱。
- [ ] 我能說出 `PATCH` 的三種格式，並知道 Merge Patch 無法部分修改陣列。
- [ ] 我理解 `null` 三態問題，並知道 `JsonNullable` 與 `ObjectNode` 兩種解法。
- [ ] 我知道 `PATCH` 可以被設計成冪等，而相對運算應該改用 `POST` + 子資源。
- [ ] 我能決定 `DELETE` 第二次該回什麼，並知道要寫進文件教客戶端怎麼處理。
- [ ] 我知道 `410 Gone` 對 SEO 與「已下架商品」的實際價值。
- [ ] 我知道 CORS preflight 幾乎一定會發生，也知道漏設 `Access-Control-Expose-Headers` 會讓前端讀不到 `Location`。
- [ ] 我知道 `Allow-Origin: *` 不能和 `Allow-Credentials: true` 併用，也知道要加 `Vary: Origin`。
- [ ] 我能用決策樹在 10 秒內選出狀態碼。
- [ ] 我能解釋 `401` vs `403`，並說出搞錯會造成「無限刷新 token」或「使用者被登出迴圈」。
- [ ] 我知道 `401` 必須帶 `WWW-Authenticate`，也知道 RFC 6750 的 `error` 參數。
- [ ] 我能說出 `400` vs `422` 的分界，也知道 Spring 預設 `@Valid` 失敗是 `400` 要自己改。
- [ ] 我知道 `403` 會洩漏存在性，也知道登入失敗要回一致的錯誤**與一致的回應時間**。
- [ ] 我能用「一個字都不改重送有可能成功嗎」判斷 `409` vs `422`。
- [ ] 我知道 `409` 的回應應該帶上幫助客戶端恢復的資訊（如 `available`）。
- [ ] 我知道過載要回 `503` 而不是 `429`，並能說出理由。
- [ ] 我能區分 `502`／`503`／`504`，並說出各自該查哪裡。
- [ ] 我能設計完整的 `202` + 輪詢契約，包含 `Location` 指向工作資源、`Retry-After`、工作失敗仍回 `200`。
- [ ] 我知道輪詢端點要加 `ETag`、要放寬限流、狀態要放 Redis。
- [ ] 我能用 `ETag` + `If-Match` 實作樂觀鎖，並知道 `428` 可以強制客戶端使用。
- [ ] 我知道「用對方法 + `If-Match` + 資料庫 `@Version`」是三層防護，缺一不可。
- [ ] 我能說出「全部回 200」的五個具體損失，特別是健康檢查與熔斷器失效。
- [ ] 我知道如果組織無法立刻改，可以用「狀態碼正確 + 保留包裝層」漸進遷移。
- [ ] 我完成了 shop-service 的方法／狀態碼契約表與全域規則清單。

---

完成後請前往 [03-request-response-and-dto-design.md](./03-request-response-and-dto-design.md)。
