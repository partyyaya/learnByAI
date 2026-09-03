# 第 00 章：課程地圖與 REST 本質

> 前面兩站你學會了「怎麼讓程式跑起來」。這一站要學的是**別人怎麼用你寫的東西**。
> API 是你和外界唯一的接觸面：前端、App、第三方廠商、其他微服務、還有三個月後的你自己，
> 全部只看得到你暴露出來的那幾條 URL 和那幾個 JSON 欄位。
> 這一章不寫 Spring —— 我們先把「REST 到底是什麼」講清楚，
> 因為 90% 的「REST API 爭吵」都源自兩邊對 REST 的定義不一樣。

---

## 0.1 學習目標

完成本章後，你應該可以：

- 說出一組沒設計過的 API 會造成哪些**具體、可量化**的成本（不是「不夠優雅」而已）。
- 完整說明 REST 的六大約束，並指出哪一條是「大家幾乎都沒做」的那一條。
- 用 Richardson 成熟度模型判斷「你們公司的 API 其實在第幾級」。
- 從一份需求文件裡的**動詞清單**，翻譯成一份**資源清單**。
- 說明 REST / RPC / GraphQL / gRPC 各自的取捨，並判斷什麼場景其實不該用 REST。
- 說出「API 是契約」的實際含意：哪些 consumer 是你改不動的、破壞相容的代價是什麼。
- 用一份可檢核的清單評估任何一組 API 的品質。
- 用 `curl` + `jq` + REST Client 檔案建立自己的 API 測試工作流。

---

## 0.2 這一站在整條路線的位置

```
           01-java-core     語言 + JVM + 建置 + 測試（已完成）
                ↓
           02-spring-boot   IoC / DI / 自動組態 / AOP / 設定 / 部署（已完成）
                ↓
[你在這裡] 03-rest-api      介面契約設計（刻意不綁框架）
                ↓
           04-controller    把契約實作出來：參數綁定、驗證、例外處理
                ↓
           05 / 06          Service / Repository
                ↓
           07 / 08          MySQL / JPA / MyBatis
                ↓
           09 / 10          Spring Security / 期末專題
```

### 為什麼順序是「設計」在「實作」前面

因為**實作可以改，介面很難改**。

| 你改的東西 | 誰會痛 | 需要協調幾方 |
|---|---|---|
| 把 `OrderServiceImpl` 整個重寫 | 沒人 | 0 —— 只要測試還綠 |
| 把 MySQL 換成 PostgreSQL | 你自己 | 1 |
| 把 `GET /orders` 的回應從陣列改成物件 | 前端、App、3 個第三方 | 5 個團隊 + App 商店審核 7 天 |
| 把 `amount` 從數字改成字串 | 同上，而且會**靜默算錯錢** | 同上 + 財務對帳 |

第 3 列和第 4 列的差別在於：**內部實作是你的，介面是大家的。**

一個很殘酷的事實：**你 3 天寫出來的 API，可能要維護 5 年。**
而且只要有一個 App 版本還在線上用舊 API，你就不能刪掉它 —— 因為使用者不會升級 App。

> 這就是為什麼這一站刻意不綁框架。
> `@GetMapping` 怎麼寫是 20 分鐘就能查到的事；
> 「這個端點該長什麼樣」是要想 2 小時、而且想錯要付 2 年代價的事。

### 這一站的產出

本站結束時會有一份完整的 **訂單系統 OpenAPI 契約** `orders-api.yaml`，
04-controller 會拿它當實作目標，12-capstone 會把它變成可上線的服務。

```
第 00 章  領域盤點：把需求動詞翻成資源清單
第 01 章  資源地圖與 URL 表（30+ 條路由定案）
第 02 章  每條路由的方法 + 狀態碼契約
第 03 章  DTO 全家族（Request / Response 定案）
第 04 章  錯誤目錄（error catalog）與 Problem Details 格式
第 05 章  分頁 / 篩選 / 排序參數規格
第 06 章  版本策略與相容性規則
第 07 章  把上面全部寫成 orders-api.yaml ← 產出在這裡
第 08 章  冪等鍵、ETag、Cache-Control、限流的契約
第 09 章  契約測試與前後端協作流程
```

---

## 0.3 先看見痛：一組沒設計過的 API

以下是一份**真實存在過**的訂單後台 API 清單（已改名去識別化）。
它能動、上線跑了兩年、公司靠它賺錢。但它每一條都在漏血。

```
POST /api/getOrderList
POST /api/getOrderDetail
POST /api/order/add
POST /api/order/update
GET  /api/order/delete?id=1001
POST /api/orderCancel
POST /api/order_pay
POST /api/OrderRefund
GET  /api/getOrderListByUserId
GET  /api/getOrderListByStatus
GET  /api/getOrderListByDateRange
GET  /api/getOrderListByUserIdAndStatus
POST /api/exportOrderExcel
POST /api/order/items/get
POST /api/order/item/add
```

### 0.3.1 前端拿到這份清單以後發生了什麼

**症狀一：一個列表頁要打 7 支 API。**

訂單列表要顯示「訂單編號 / 客戶名 / 商品縮圖 / 金額 / 狀態 / 物流單號」，
但 `getOrderList` 只回訂單本體。於是前端這樣寫：

```javascript
// 前端真實寫出來的程式
const orders = await post('/api/getOrderList', { page: 1 });   // 1 支
for (const o of orders.data) {
  o.items    = await post('/api/order/items/get', { orderId: o.id });  // N 支
  o.customer = await post('/api/getUserDetail',   { userId: o.userId });// N 支
  o.shipping = await post('/api/getShipping',     { orderId: o.id });  // N 支
}
```

一頁 20 筆 → **61 次 HTTP 往返**。手機 4G 下列表頁載入 8 秒。
（這叫 **N+1 API 問題**，是後端 N+1 查詢的網路版，而且更貴 —— 網路 RTT 比 SQL 慢兩個數量級。）

**症狀二：沒人知道哪支 API 是安全的。**

`GET /api/order/delete?id=1001` 是 `GET`。結果：

- 瀏覽器**預取（prefetch）**、公司內部的**連結檢查爬蟲**、Slack 展開連結預覽 —— 全部都可能刪資料。
- 使用者按「上一頁」再「重新整理」，訂單又被刪一次。
- 這條 URL 進了 Nginx 的 `access.log`，也進了公司 APM 的 trace 名稱，變成永久紀錄。

這不是理論。歷史上最有名的案例是 **Google Web Accelerator（2005）**：
它會預取頁面上的連結，結果把一堆用 `GET` 實作「刪除」「登出」的網站資料掃光。
Google 沒有錯 —— **`GET` 依定義是安全的（safe），是那些網站違約了。**

**症狀三：錯誤處理全站不一致。**

同一個系統裡三種錯誤格式：

```jsonc
// getOrderList 的錯誤
{ "code": -1, "msg": "系統錯誤" }

// order/add 的錯誤
{ "success": false, "errorMessage": "庫存不足", "errorCode": "E20031" }

// order_pay 的錯誤（HTTP 500 + Tomcat 預設頁）
// <html><head><title>HTTP Status 500 – Internal Server Error</title>...
// 而且 body 裡有完整 stack trace，包含 SQL 和資料表名稱
```

前端的錯誤處理只能寫成這樣：

```javascript
function isError(res) {
  return res.code === -1 || res.success === false
      || res.errorCode || res.status === 'FAIL'
      || (typeof res === 'string' && res.includes('Error'));   // ← 這行是真的
}
```

**症狀四：查詢組合爆炸。**

`getOrderListByUserId`、`getOrderListByStatus`、`getOrderListByDateRange`、`getOrderListByUserIdAndStatus`…

三個條件的所有組合是 2³ − 1 = 7 支 API。加第四個條件變 15 支。
產品又說「要能同時篩狀態和金額範圍」→ 再開一支。
最後這個 Controller 有 2,000 行，每支的分頁邏輯都複製貼上（其中兩支的 `offset` 算錯 1）。

**正確答案只需要一支**：`GET /orders?customerId=..&status=..&createdFrom=..&createdTo=..`
（第 05 章會把這個參數設計講透。）

### 0.3.2 把成本算成錢

工程師常說「這樣寫不夠優雅」，主管聽不懂。換個說法：

| 問題 | 可量化代價 |
|---|---|
| N+1 API 導致列表頁 8 秒 | 電商每 1 秒延遲約掉 7% 轉換率（Akamai/Amazon 的公開研究） |
| `GET` 做刪除 | 一次爬蟲事故 = 資料復原 + 客服補償 + 事後檢討，人力數十小時 |
| 錯誤格式不一致 | 每個新前端功能都要重寫錯誤處理；線上問題定位時間從 5 分鐘變 2 小時 |
| 查詢組合爆炸 | 15 支 API × 每支都要寫測試、寫文件、改版時全部要動 |
| 回應直接丟 Entity | 一次資料庫欄位改名 = 前端 App 全炸 = 緊急發版 |
| stack trace 外洩 | 資安通報事件，攻擊者拿到資料表結構 |
| 全部回 200 | 監控無法用狀態碼算錯誤率，SLO 形同虛設；APM 面板全綠但使用者在罵 |

**最後一項是最容易被忽略、也最致命的。**
你的監控系統（Nginx / ALB / Prometheus / Datadog）是用 HTTP 狀態碼算錯誤率的。
如果所有錯誤都回 200，那麼「錯誤率 0%」的儀表板是假的，
半夜付款全掛你也不會收到告警 —— 因為從基礎設施的角度看，一切正常。

> **本章要記住的第一件事：狀態碼不是給人看的，是給機器看的。**
> 給人看的訊息放 body（第 04 章），給機器判斷的訊號放狀態碼（第 02 章）。

---

## 0.4 REST 到底是什麼

### 0.4.1 它的出身

REST = **RE**presentational **S**tate **T**ransfer，
出自 Roy Fielding 2000 年的博士論文《Architectural Styles and the Design of Network-based Software Architectures》第 5 章。

三個容易誤解的點：

1. **REST 不是規格（specification），是架構風格（architectural style）。**
   沒有「REST 標準文件」可以拿去做符規檢查。HTTP 有 RFC，JSON 有 RFC，REST 沒有。
   所以「這樣算不算 REST」永遠會吵，而**吵這個通常沒有生產力**。

2. **REST 不等於 HTTP + JSON + CRUD。**
   這是業界的通俗用法（本課程也會沿用，因為溝通成本最低），但和論文的定義有落差。
   Fielding 自己在 2008 年寫過一篇很不客氣的文章
   〈REST APIs must be hypertext-driven〉，抱怨大家都在誤用這個詞。

3. **Fielding 是在描述「Web 為什麼會成功」，不是在設計 API 規範。**
   六大約束是他從 HTTP/1.1 的設計裡「反推」出來的原則。
   所以每一條約束的目的都是：**可擴展（scalability）、可演進（evolvability）、元件獨立部署**。

### 0.4.2 六大約束

以下每一條都用同一個格式講：**是什麼 → 為什麼 → 違反的後果 → 實務上大家做到什麼程度**。

---

#### 約束 1：Client–Server（客戶端／伺服器分離）

**是什麼**：把使用者介面的關注點和資料儲存的關注點分開，兩邊透過統一介面通訊。

**為什麼**：兩邊可以**獨立演進、獨立部署、獨立擴容**。
前端改版不用重啟後端；後端換資料庫前端不用知道。

**違反的後果**：後端回傳 HTML 片段給前端塞進 DOM（早年的 AJAX 寫法），
或後端 API 的回應結構完全照著某一個頁面的排版設計 ——
結果那個頁面改版，API 就得改，另外三個用同一支 API 的地方一起壞。

**實務程度**：✅ 幾乎所有人都做到了。這是最沒爭議的一條。

> ⚠️ 但有個灰色地帶：**BFF（Backend For Frontend）**故意讓 API 貼合特定前端。
> 這不是違反約束，而是有意識地在「通用性」和「效率」之間做交換 —— 前提是你**知道**你在交換什麼。

---

#### 約束 2：Stateless（無狀態）

**是什麼**：**每個請求都必須自帶所有必要資訊**，伺服器不保存客戶端的會談狀態（session state）。

注意區分兩種狀態：

| 狀態種類 | 存在哪 | 無狀態約束怎麼說 |
|---|---|---|
| **資源狀態**（訂單目前是 PAID） | 伺服器（資料庫） | ✅ 本來就該在伺服器 |
| **會談狀態**（這個使用者是誰、購物車走到第幾步） | 應該在客戶端（或共享儲存） | ❌ 不該存在單一伺服器的記憶體裡 |

**為什麼**：

1. **可水平擴容**：任何一台機器都能處理任何一個請求 → 加機器就能加吞吐。
2. **容錯**：一台機器掛掉，請求打到別台照樣能處理。
3. **可觀測**：每個請求都能獨立理解，log 看一行就知道發生什麼事。

**違反的後果（真實故事）**：

某系統把購物車放在 Tomcat 的 `HttpSession`（記憶體）裡。單機時代沒問題。
上線兩台機器 + 負載平衡後：

```
使用者 → LB → 機器 A：加入商品，session 存在 A 的記憶體
使用者 → LB → 機器 B：查看購物車，B 沒有這個 session → 購物車空了
```

急救方案是在 LB 上開 **sticky session**（同一個使用者固定打同一台）。
於是換來三個新問題：

- 機器 A 掛掉 → 上面所有使用者的購物車全部消失。
- 部署時滾動更新 → 每次上線都清空一批人的購物車。
- 流量不均 → A 機器 CPU 90%，B 機器 20%，加機器也沒用（新機器沒有舊使用者）。

**正確做法**：把 session 移到 Redis（Spring Session），或用 token（JWT）讓請求自帶身分。
09-spring-security 會完整比較 Session vs Token。

**實務程度**：⚠️ 部分做到。大部分團隊用 Redis 存 session ——
嚴格說這仍不是「無狀態」（狀態只是搬家了），但已達成「任一台機器可處理任一請求」的實質目的。
**這是很典型的實務取捨：抓住約束想達成的目標，而不是死守字面。**

> 無狀態的代價要誠實說：**每個請求都要重新驗證身分**（多一次 Redis 查詢或 JWT 驗簽），
> 而且請求變大（要帶 token）。這是拿「一點延遲」換「可擴容 + 容錯」，絕大多數情況值得。

---

#### 約束 3：Cache（可快取）

**是什麼**：回應必須（隱含或明確地）標示自己**可不可以被快取、可以快取多久**。

**為什麼**：**最快的請求是沒發生的請求。** 快取可以完全消除一部分往返。

**違反的後果**：

- **沒標可快取** → 商品圖片、分類清單這種一天改一次的資料，每次都打到你的資料庫。
- **標錯成可快取** → 更慘。`GET /me` 回應被 CDN 快取了，
  結果**下一個使用者拿到上一個使用者的個人資料**。這是真實發生過很多次的資安事故
  （2017 年 Cloudflare、以及多家電商都出過類似的「CDN 快取污染個資」事件）。

**實務程度**：❌ 大部分後端工程師完全沒設。
`Cache-Control`、`ETag`、`Last-Modified` 這三個 header 是「免費效能」，但通常沒人管。
第 08 章會專門處理。

先記住一條保命規則：

```http
# 任何「跟登入者有關」的回應，都要明確禁止共享快取
Cache-Control: private, no-store
```

---

#### 約束 4：Uniform Interface（統一介面）★ 最重要的一條

這是 REST 的核心，而且它自己還有**四個子約束**。
你之後所有的設計爭論，幾乎都落在這一條裡。

**子約束 4a：資源的識別（identification of resources）**

每個「東西」都有自己的 URI。URI 識別的是**資源（概念）**，不是回傳的位元組。

```
✅ /orders/1001            這是「1001 號訂單」這個概念
✅ /orders/1001/items      這是「1001 號訂單的明細集合」
❌ /getOrder?id=1001       這是「一個動作」，不是一個東西
❌ /api?action=getOrder    整個 API 只有一個 URI，等於沒有識別
```

**子約束 4b：透過表述操作資源（manipulation through representations）**

客戶端拿到的不是資源本身，是資源的**表述（representation）**：
同一筆訂單可以有 JSON 表述、XML 表述、PDF 表述、CSV 表述。

客戶端要修改資源時，是**送一份修改過的表述回去**，而不是呼叫伺服器上的方法。

```
GET  /orders/1001            → 拿到 JSON 表述
                                （改一改 status 欄位）
PUT  /orders/1001            → 送回修改後的表述
```

這解釋了一件常讓人困惑的事：**為什麼是 `PUT /orders/1001` 而不是 `POST /updateOrder`？**
因為 REST 的模型是「你在編輯一份文件」，不是「你在呼叫一個函式」。

**子約束 4c：自我描述的訊息（self-descriptive messages）**

**每個訊息都要包含足夠資訊，讓接收者知道怎麼處理它** —— 不能依賴帶外的知識（out-of-band knowledge）。

```http
POST /orders HTTP/1.1
Content-Type: application/json          ← 我送的是 JSON（不用猜）
Accept: application/json                ← 我想收 JSON
Content-Length: 152
Idempotency-Key: 8f14e45f-ea36-4a1b     ← 這是重試，不是新單
```

回應同理：

```http
HTTP/1.1 201 Created
Content-Type: application/json          ← 這是 JSON
Location: /orders/1001                  ← 建立出來的東西在這
Cache-Control: no-store                 ← 不要快取
ETag: "a3f5c9"                          ← 版本指紋
```

違反的例子：`Content-Type: text/html` 但 body 其實是 JSON。
或者回應 body 是 JSON、狀態碼 200，但裡面寫 `{"code": 500}` ——
**中介元件（代理、CDN、閘道、監控）看不懂你的自訂約定，只看得懂 HTTP。**

> 這就是「全部回 200」為什麼在架構上是錯的：
> 它把訊息從「自我描述」變成「要讀我們公司的 Wiki 才懂」。

**子約束 4d：HATEOAS（Hypermedia As The Engine Of Application State）**

回應裡要附上**接下來可以做什麼**的連結，客戶端靠連結導航，而不是把 URL 寫死。

```jsonc
{
  "orderNumber": "ORD-20260819-0001",
  "status": "PENDING_PAYMENT",
  "totalAmount": "1280.00",
  "_links": {
    "self":   { "href": "/orders/1001" },
    "pay":    { "href": "/orders/1001/payments", "method": "POST" },
    "cancel": { "href": "/orders/1001/cancellations", "method": "POST" }
  }
}
```

理想很美好：訂單付款後再查，`_links` 裡的 `pay` 和 `cancel` 就消失了，換成 `refund` 和 `shipment`。
前端不需要知道「PAID 狀態不能取消」這條業務規則 —— **規則在後端，前端只要看有沒有那個連結。**
按鈕要不要顯示，直接看 `_links` 有沒有那個 key。

**實務程度**：❌❌ 幾乎沒人做。這是六大約束裡唯一「大家公開承認沒做」的一條。

為什麼？誠實的理由：

| 理由 | 說明 |
|---|---|
| 前端框架不吃這套 | React / Vue 的路由是在前端寫死的，拿到 `href` 也不知道要導去哪個畫面 |
| 增加 payload | 每筆資料多 3～10 個連結，列表 100 筆就多幾十 KB |
| 沒有共通格式 | HAL、JSON:API、Siren、Collection+JSON… 四種以上互不相容，工具生態分散 |
| 開發者體驗差 | 前端寧願看 OpenAPI 文件寫死 URL，也不想每次多打一次請求探索連結 |
| 投報率不明 | 「客戶端可以不改就適應後端變化」這個好處，在**你同時擁有前後端**的情況下價值很低 |

**什麼時候 HATEOAS 真的有價值？**

- 你的 API 有**大量你控制不了的 consumer**（公開平台、開放銀行、政府 API）。
- 客戶端**無法快速升版**（IoT 裝置、車機、電視 App、Android TV）。
- 業務規則**變動頻繁**，而且你不想每次都通知所有前端改判斷邏輯。

**折衷做法（強烈推薦，本課程採用）**：不做完整 HATEOAS，但回傳**能力清單**。

```jsonc
{
  "orderNumber": "ORD-20260819-0001",
  "status": "PENDING_PAYMENT",
  "allowedActions": ["PAY", "CANCEL", "EDIT_ADDRESS"]
}
```

好處：
- 前端 `allowedActions.includes('CANCEL')` 就決定按鈕要不要 disable —— **業務規則留在後端一份**。
- 不用引入 HAL 那一整套格式和工具鏈。
- payload 增加很少，而且是可讀的字串。

壞處：前端還是要把 `"CANCEL"` 對應到自己的按鈕與 URL（沒有真正解耦）。
但它解決了實務上最痛的那一個問題 ——
**「業務規則同時寫在前後端，兩邊不同步」**。
（第 03 章 3.10 會講這種欄位怎麼演進。）

---

#### 約束 5：Layered System（分層系統）

**是什麼**：客戶端只知道「下一跳」，不知道整條鏈路後面有幾層。
每一層只能看見相鄰的層。

```
Client → CDN → WAF → API Gateway → Load Balancer → 你的服務 → 快取 → 資料庫
         └───────── 客戶端完全不知道這些存在 ─────────┘
```

**為什麼**：可以在不動客戶端的前提下，插入 CDN、快取、WAF、限流、灰度發布、金絲雀部署。

**違反的後果**：

- 回應裡塞了**內部主機名或內部 IP**（`"server": "app-node-3.internal"`）→ 洩漏拓樸，也讓客戶端可能依賴它。
- API 直接回傳**內部服務的錯誤原文**（`Connection refused to inventory-svc:9090`）→ 洩漏內部架構。
- 前端把 URL 寫死成 `https://10.0.3.17:8080/orders` → 完全無法插入任何一層。

**這條約束和 Stateless 是搭配的**：正因為無狀態，中間才可以隨便加一層負載平衡器。

**實務程度**：✅ 做到了，而且通常是**運維團隊幫你做到的**，後端工程師常常沒意識到。
你要做的是「不要破壞它」：不洩漏內部細節、不假設自己直接面對客戶端
（`request.getRemoteAddr()` 拿到的是 LB 的 IP，真實 IP 在 `X-Forwarded-For`）。

---

#### 約束 6：Code-On-Demand（按需程式碼）— 可選

**是什麼**：伺服器可以傳送可執行程式碼給客戶端執行（JavaScript、早年的 Java Applet）。

**為什麼是可選的**：因為它會降低「可見性」——中介元件無法理解你傳的程式碼在幹什麼。

**實務**：網頁本身就是最大的 Code-On-Demand 實例（HTML 帶 `<script>`）。
但**純資料 API 幾乎不會用**，也不需要。

> ⚠️ 有一種變形要小心：後端下發「規則字串」讓前端 `eval()`
> （例如把折扣公式當字串回傳）。這技術上是 Code-On-Demand，
> 但等於開了一個遠端程式碼執行（RCE）的門。不要做。

---

### 0.4.3 六大約束速查表

| # | 約束 | 一句話 | 業界達成度 | 違反時最痛的症狀 |
|---|---|---|---|---|
| 1 | Client–Server | 介面與儲存分離 | ✅ 幾乎都有 | API 綁死某個頁面排版 |
| 2 | Stateless | 請求自帶所需資訊 | ⚠️ 半套（session 搬到 Redis） | 無法水平擴容、部署就掉登入 |
| 3 | Cache | 明確標示可否快取 | ❌ 常被忽略 | 白花效能／個資被 CDN 快取外洩 |
| 4 | Uniform Interface | URI + 表述 + 自我描述 + 超媒體 | ⚠️ 前三項有，HATEOAS 沒有 | 全部回 200、監控失效 |
| 5 | Layered System | 客戶端只知下一跳 | ✅ 運維幫你做到 | 洩漏內部拓樸、無法插中介層 |
| 6 | Code-On-Demand | 可下發程式碼（可選） | — 不適用 | （硬做會變成 RCE 風險） |

**如果只能記一件事**：真正決定你的 API 好不好用的是**約束 4（統一介面）**。
第 01～04 章基本上就是在把約束 4 的前三個子約束做到底。

---

## 0.5 Richardson 成熟度模型：你們公司在第幾級

Leonard Richardson 提出的四級模型，是判斷「這組 API 有多 REST」最實用的尺。
我們用**同一個需求**（取消訂單）跑一遍四級。

### Level 0：一個 URI，一個方法（RPC over HTTP / 「POX」）

```http
POST /api HTTP/1.1
Content-Type: application/json

{ "action": "cancelOrder", "orderId": 1001, "reason": "客戶改變主意" }
```

回應：

```http
HTTP/1.1 200 OK

{ "code": 0, "data": { "ok": true } }
```

**特徵**：HTTP 只被當成傳輸管線（tunnel），所有語意都在 body 裡。
早年的 SOAP、XML-RPC 都是這一級。

**代價**：
- 無法用 URL 做路由層面的權限控管、限流、快取（所有請求都是 `POST /api`）。
- 監控只看得到「`/api` 這支 QPS 5000」，不知道哪個動作慢。
- 任何中介元件都幫不上忙。

### Level 1：引入資源（多個 URI，還是只有一個方法）

```http
POST /orders/1001 HTTP/1.1

{ "action": "cancel", "reason": "客戶改變主意" }
```

**進步**：URL 開始有意義了，可以按資源做權限與監控。
**還缺**：所有操作都用 `POST`，HTTP 方法的語意沒用上。

很多「內部管理後台 API」停在這一級。老實說，**在完全內部、只有一個前端的場景，這一級的實際傷害有限** ——
但你會失去下面 Level 2 帶來的所有免費好處。

### Level 2：使用 HTTP 方法與狀態碼 ★ 業界主流，也是本課程的目標

```http
POST /orders/1001/cancellations HTTP/1.1
Content-Type: application/json
Idempotency-Key: 8f14e45f-ea36-4a1b-9c2e-77e8f1a3b0c1

{ "reason": "CUSTOMER_CHANGED_MIND", "comment": "客戶改變主意" }
```

```http
HTTP/1.1 201 Created
Location: /orders/1001/cancellations/7f3a
Content-Type: application/json

{
  "cancellationId": "7f3a",
  "orderNumber": "ORD-20260819-0001",
  "status": "CANCELLED",
  "cancelledAt": "2026-08-19T06:12:44Z",
  "refund": { "status": "PROCESSING", "amount": "1280.00" }
}
```

失敗時（訂單已出貨，不能取消）：

```http
HTTP/1.1 409 Conflict
Content-Type: application/problem+json

{
  "type": "https://api.shop.example/problems/order-not-cancellable",
  "title": "訂單目前狀態不允許取消",
  "status": 409,
  "detail": "Order ORD-20260819-0001 is in SHIPPED state; cancellable states are PENDING_PAYMENT, PAID.",
  "instance": "/orders/1001/cancellations",
  "code": "ORDER_NOT_CANCELLABLE",
  "currentStatus": "SHIPPED",
  "traceId": "4f2c8a1e9b7d3f60"
}
```

**你免費得到了什麼**：

| 免費好處 | 怎麼來的 |
|---|---|
| `GET` 可以被 CDN / 瀏覽器快取 | 方法語意 |
| 網路超時可以安全重試 `PUT` / `DELETE` | 冪等性 |
| ALB / Nginx / Prometheus 自動算出錯誤率 | 狀態碼 |
| 客戶端 HTTP 函式庫自動處理 401 → 刷新 token | 狀態碼 |
| API Gateway 可以「只讓管理員做 `DELETE`」 | 方法 + URL |
| 監控面板自動按端點分組 | URL 有結構 |
| 前端可以用 `if (res.status === 409)` 分支 | 狀態碼 |

**這些好處全部是「不用寫程式就有」的。** Level 0/1 全部放棄。

### Level 3：超媒體控制（HATEOAS）

在 Level 2 的回應上加 `_links`（見 0.4.2 子約束 4d）。

**實務結論**：**把 Level 2 做到 100 分，遠比勉強做到 Level 3 有價值。**
本課程的目標是「Level 2 + 能力清單」——
拿到 Level 3 最實用的那一份好處（業務規則單一來源），不背 Level 3 的全部成本。

### 0.5.1 自我檢測：跑一遍你們公司的 API

| 檢查 | 若是「否」，你可能在 Level 0/1 |
|---|---|
| URL 裡有動詞嗎（`getXxx` / `doXxx` / `xxxAction`）？ | 有 → Level 0/1 |
| 讀取資料用 `GET` 嗎？還是全部 `POST`？ | 全 POST → Level 1 |
| 失敗時 HTTP 狀態碼會變嗎？ | 不變 → Level 1（最嚴重的一種） |
| 建立資源會回 `201` + `Location` 嗎？ | 不會 → Level 1.5 |
| 有超過一種錯誤格式嗎？ | 有 → 連 Level 2 都不算做完 |

---

## 0.6 資源導向思維：從動詞清單到資源清單

這是本站最重要的**思考習慣轉換**，也是最難的一步。

### 0.6.1 為什麼你會自然地寫出 `getOrderList`

因為你的大腦在寫 Java：

```java
public interface OrderService {
    List<Order> getOrderList(Long userId);
    Order       getOrderDetail(Long id);
    Long        createOrder(CreateOrderCommand cmd);
    void        cancelOrder(Long id, String reason);
}
```

然後你「把 Service 介面一比一搬到 URL 上」：

```
POST /getOrderList
POST /getOrderDetail
POST /createOrder
POST /cancelOrder
```

**這是最常見的錯誤，而且它感覺很自然。**

問題在於：Java 的方法是**動作導向**的（呼叫一個函式），
HTTP 是**資源導向**的（操作一份文件）。直接搬會丟掉整個 HTTP 語意層。

> Service 介面用動詞是**對的**（那是 05-service 的事）。
> URL 用名詞也是**對的**（這是 03/04 的事）。
> **Controller 的職責就是做這個翻譯。** 不要讓 URL 長得像 Java 方法。

### 0.6.2 三步翻譯法

**步驟 1：把需求裡的動詞全部列出來**

假設 PM 給你這份需求（電商訂單模組）：

```
1.  使用者可以瀏覽商品
2.  使用者可以搜尋商品
3.  使用者可以把商品加入購物車
4.  使用者可以修改購物車中商品的數量
5.  使用者可以移除購物車中的商品
6.  使用者可以清空購物車
7.  使用者可以套用折扣碼
8.  使用者可以結帳建立訂單
9.  使用者可以查詢自己的訂單列表
10. 使用者可以查看單筆訂單明細
11. 使用者可以付款
12. 使用者可以取消未出貨的訂單
13. 使用者可以申請退貨
14. 使用者可以查詢物流狀態
15. 客服可以代客戶取消訂單並填寫原因
16. 客服可以查詢所有訂單
17. 倉管可以標記訂單為已出貨並輸入物流單號
18. 財務可以匯出上個月的訂單報表
19. 系統每天凌晨對帳一次
20. 使用者可以重寄訂單確認信
```

**步驟 2：從動詞裡萃取名詞（資源），而不是把動詞變成 URL**

| # | 需求動詞 | ❌ 直覺寫法 | 名詞（資源） | ✅ 資源導向寫法 |
|---|---|---|---|---|
| 1 | 瀏覽商品 | `getProductList` | 商品集合 | `GET /products` |
| 2 | 搜尋商品 | `searchProduct` | 商品集合（加篩選） | `GET /products?q=耳機` |
| 3 | 加入購物車 | `addToCart` | **購物車項目** | `POST /carts/current/items` |
| 4 | 修改數量 | `updateCartItem` | 某一個購物車項目 | `PATCH /carts/current/items/{itemId}` |
| 5 | 移除商品 | `removeFromCart` | 同上 | `DELETE /carts/current/items/{itemId}` |
| 6 | 清空購物車 | `clearCart` | 購物車項目集合 | `DELETE /carts/current/items` |
| 7 | 套用折扣碼 | `applyCoupon` | **購物車上的折扣** | `PUT /carts/current/coupon` |
| 8 | 結帳建立訂單 | `checkout` | 訂單集合 | `POST /orders` |
| 9 | 查自己的訂單 | `getMyOrders` | 訂單集合（範圍限定） | `GET /orders?scope=me` 或 `GET /me/orders` |
| 10 | 查訂單明細 | `getOrderDetail` | 單筆訂單 | `GET /orders/{id}` |
| 11 | 付款 | `payOrder` | **付款**（本身是資源！） | `POST /orders/{id}/payments` |
| 12 | 取消訂單 | `cancelOrder` | **取消單** | `POST /orders/{id}/cancellations` |
| 13 | 申請退貨 | `applyReturn` | **退貨單** | `POST /orders/{id}/returns` |
| 14 | 查物流 | `getShippingStatus` | 出貨單 | `GET /orders/{id}/shipments` |
| 15 | 客服代取消 | `adminCancelOrder` | 同 12（差在權限與欄位） | `POST /orders/{id}/cancellations` |
| 16 | 客服查全部 | `getAllOrders` | 同 9（差在權限與預設範圍） | `GET /orders` |
| 17 | 標記已出貨 | `markShipped` | **出貨單** | `POST /orders/{id}/shipments` |
| 18 | 匯出報表 | `exportOrderExcel` | **匯出工作** | `POST /order-report-exports` → `GET /order-report-exports/{id}` |
| 19 | 每日對帳 | `dailyReconcile` | — | **不是 API**，是排程（02-spring-boot 第 06 章） |
| 20 | 重寄確認信 | `resendEmail` | **通知** | `POST /orders/{id}/notifications` |

**步驟 3：對每個資源定義生命週期與允許的方法**（第 01、02 章的工作）

### 0.6.3 三個關鍵洞察

**洞察 1：很多「動作」其實是一個被你忽略的名詞。**

「付款」看起來是動作，但業務上真正存在的東西是**一筆付款紀錄**：
它有金額、有時間、有付款方式、有交易序號、有狀態（成功／失敗／處理中）、
會被財務對帳、會被退款引用、可能一筆訂單付兩次（分期、補款）。

**它完全符合「資源」的定義。**

```http
POST /orders/1001/payments     建立一筆付款
GET  /orders/1001/payments     這張訂單付過幾次款（分期、失敗重試都看得到）
GET  /payments/{paymentId}     單看一筆付款（財務對帳用）
POST /payments/{paymentId}/refunds  對這筆付款退款
```

比較一下 `POST /payOrder`：它**不會留下任何可查詢的東西**。
使用者付了兩次款要查證的時候，你只能翻 log。

**這是資源導向最大的實際好處：它逼你把業務事實建模出來，而不是只寫一個 void 方法。**

**判斷法**：問自己「這個動作發生後，有沒有產生一個**值得被查詢、被列表、被引用**的紀錄？」
有 → 它是資源。

| 動作 | 有紀錄嗎 | 結論 |
|---|---|---|
| 付款 | 有（付款紀錄，財務要對帳） | ✅ 資源 `payments` |
| 取消訂單 | 有（誰取消、何時、原因，會被客訴調閱） | ✅ 資源 `cancellations` |
| 出貨 | 有（物流單號、出貨時間，可能分批出貨） | ✅ 資源 `shipments` |
| 退貨 | 有（退貨單，有自己的審核流程） | ✅ 資源 `returns` |
| 寄確認信 | 有（寄送紀錄，客服要查「到底寄了沒」） | ✅ 資源 `notifications` |
| 匯出報表 | 有（工作狀態、產出檔案、有效期限） | ✅ 資源 `exports` |
| 清空購物車 | 沒有 | ❌ 就是刪除集合 `DELETE .../items` |
| 把商品標為精選 | 沒有（只是改一個欄位） | ❌ 就是改狀態 `PATCH /products/{id}` |

**洞察 2：權限差異不該產生新端點。**

需求 15（客服代取消）和 12（使用者自己取消）**是同一個端點**。
差別是：

- **誰可以呼叫** → 授權層的事（09-spring-security）
- **可以填哪些欄位** → 客服可以填 `internalNote`、`waiveFee`，使用者不行（04-controller 的驗證群組）
- **預設看到什麼範圍** → `GET /orders` 對使用者預設只回自己的，對客服回全部

❌ 不要開 `/admin/cancelOrder` 和 `/user/cancelOrder` 兩支。
你會有兩份業務邏輯，然後其中一份忘記加「已出貨不能取消」的檢查。

> **例外**：如果管理端和使用者端的**資源模型真的不同**（欄位差 80%、流程完全不同），
> 那分成 `/admin/orders` 和 `/orders` 是合理的 —— 這是有意識的 BFF 決策，不是偷懶。
> 判準：**如果兩邊 90% 欄位相同，就是同一個資源。**

**洞察 3：不是所有需求都是 API。**

需求 19（每日對帳）沒有 consumer 呼叫它，它是排程任務。
硬做成 `POST /reconcile` 然後用 crontab 打 curl，會有兩個問題：

- 這支 API 被外部呼叫了怎麼辦？（要加驗證、要防重複執行）
- 對帳跑 20 分鐘，HTTP 會超時（Nginx 預設 60 秒）。

**但有個例外值得做**：給運維一個**手動觸發**的端點，方便補跑。
這時它應該是「建立一個對帳工作」：

```http
POST /reconciliation-jobs
{ "date": "2026-08-18" }

HTTP/1.1 202 Accepted
Location: /reconciliation-jobs/9f2a
{ "jobId": "9f2a", "status": "QUEUED" }
```

**注意這裡的關鍵**：不是「同步跑完再回」，而是「建立一個工作資源，馬上回 202，讓對方輪詢」。
這是所有長時間操作的標準解法（第 02 章 2.10 會詳講）。

---

## 0.7 REST 不是唯一選擇：四種風格的取捨

盲目「什麼都用 REST」和「REST 已死要用 GraphQL」一樣不專業。

### 0.7.1 四種風格對照

| 面向 | REST | RPC（含 JSON-RPC） | GraphQL | gRPC |
|---|---|---|---|---|
| 核心思維 | 操作資源 | 呼叫遠端函式 | 查詢一張圖 | 呼叫遠端函式（強型別） |
| 傳輸 | HTTP/1.1、HTTP/2 | HTTP / TCP | 通常 HTTP POST 單一端點 | HTTP/2 必須 |
| 格式 | JSON / XML / 任意 | JSON / XML | JSON | Protobuf（二進位） |
| 型別契約 | OpenAPI（後補、可能不同步） | 各家不同 | Schema（語言內建、強制） | `.proto`（強制、可產碼） |
| 端點數量 | 多（每個資源一組） | 多（每個方法一支） | **1**（`/graphql`） | 多（service.method） |
| HTTP 快取 | ✅ 天然支援 | ⚠️ 難（多為 POST） | ❌ 幾乎無法（單一 POST 端點） | ❌ 需自己做 |
| 瀏覽器直接可用 | ✅ | ✅ | ✅ | ❌ 需 gRPC-Web + 代理 |
| Over-fetching | ⚠️ 常見（回太多欄位） | ⚠️ 同 | ✅ 客戶端指定欄位 | ⚠️ 同 REST |
| Under-fetching（N+1 API） | ⚠️ 常見 | ⚠️ 同 | ✅ 一次查完整棵樹 | ⚠️ 同 |
| 效能（延遲／頻寬） | 中 | 中 | 中（省頻寬、伺服器較重） | ★ 最好 |
| 串流 | ⚠️ SSE / WebSocket 另外處理 | ❌ | ⚠️ Subscription | ✅ 原生雙向串流 |
| 學習與工具成本 | ★ 最低 | 低 | 高（DataLoader、複雜度控制、快取） | 中高（需編譯工具鏈） |
| 除錯難度 | ★ 最易（`curl` 就夠） | 易 | 中（要看 query） | 難（二進位、需 `grpcurl`） |
| 適合誰用 | 公開 API、CRUD、前後端分離 | 內部工具、老系統 | 前端需求多變、多裝置 BFF | 服務間高頻通訊 |

### 0.7.2 決策指引

**用 REST，當：**
- 你的資源是名詞導向的 CRUD（訂單、商品、使用者）—— 這佔了業務系統的 80%。
- 你要開放給**外部**使用（第三方最熟悉 REST，門檻最低）。
- 你想要 HTTP 快取、CDN、標準狀態碼、瀏覽器 devtools 直接可讀。
- 你的團隊人手有限（REST 的維護成本最低，這是很實際的理由）。

**用 GraphQL，當：**
- 前端有 **Web / iOS / Android / 智慧電視** 多種，各自要的欄位差很多。
- 畫面經常改版，每次改版都要後端配合加欄位（GraphQL 讓前端自助）。
- 你願意付出：查詢複雜度限制、深度限制、N+1 需要 DataLoader、快取要自己做、
  監控要另外處理（所有請求都是 `POST /graphql`，狀態碼永遠 200）。

  > ⚠️ GraphQL 有個常被忽略的坑：**它把「全部回 200」變成規格的一部分**。
  > 錯誤在 `errors` 陣列裡，狀態碼是 200。
  > 所以 0.3.2 提到的監控問題，在 GraphQL 裡你**必須**另外解。

**用 gRPC，當：**
- **服務對服務**的內部通訊，QPS 高、延遲敏感。
- 需要雙向串流（即時通知、日誌串流、大檔傳輸）。
- 團隊接受 `.proto` 為單一契約來源，並用它產生多語言 client。

**用 RPC 風格（`POST /api/doSomething`），當：**
- 操作**真的**不是資源，強行資源化只會讓人看不懂。
  例如 Slack 的 `POST /api/chat.postMessage`、`POST /api/auth.test`。
- 你在包裝一個既有的老系統（SOAP、AS/400、主機），資源模型根本不存在。

> 這裡值得替 RPC 說句公道話：**Slack、Stripe 早期、Twilio 的部分 API 都有 RPC 味道，
> 而它們的開發者體驗被公認很好。** 一致性 + 好文件 > 教條式的純 REST。

### 0.7.3 混用是常態（真實架構）

不要選邊站。一個成熟系統長這樣：

```
     瀏覽器 / App
          │
          ▼
   ┌──────────────┐
   │ BFF / Gateway│  ← 對前端提供 GraphQL 或聚合後的 REST
   └──────┬───────┘
          │ gRPC（內部，高效能）
   ┌──────┼──────────┬──────────────┐
   ▼      ▼          ▼              ▼
訂單服務  庫存服務   付款服務      通知服務
   │                  │
   │                  └─ REST → 第三方金流（人家只給 REST + Webhook）
   │
   └─ REST（對外開放平台，給廠商 ERP 對接）
```

同一個「訂單服務」可以同時暴露：

| 介面 | 給誰 | 為什麼 |
|---|---|---|
| REST `/orders` | 公開平台、廠商 ERP | 最通用、最好接、有 OpenAPI |
| gRPC `OrderService.GetOrder` | 內部其他服務 | 快、強型別 |
| Webhook（你打別人） | 廠商系統 | 不用讓對方輪詢 |
| SSE `/orders/{id}/events` | 前端訂單追蹤頁 | 單向即時，比 WebSocket 簡單 |

**本課程專注 REST**，因為它是 80% 場景的正確答案，也是其他風格的比較基準。

### 0.7.4 REST 明確不擅長的六件事（要誠實）

| 場景 | REST 的問題 | 務實解法 |
|---|---|---|
| 大檔上傳／下載 | JSON 塞 base64 會膨脹 33%，還吃記憶體 | `multipart/form-data`，或發**預簽名 URL** 讓客戶端直傳 S3 |
| 即時推播 | HTTP 是請求／回應，輪詢很浪費 | SSE（單向，最簡單）／WebSocket（雙向）／Webhook（伺服器對伺服器） |
| 複雜巢狀查詢 | 要嘛 over-fetch 要嘛打 N 次 | 設計專用的「查詢視圖」端點，或改用 GraphQL |
| 批次操作 | 一次改 1000 筆不好表達 | 建立「批次工作」資源 + 202 + 輪詢（第 02 章） |
| 多步驟交易 | HTTP 無狀態，跨請求沒有交易 | 把流程本身變資源（`checkout-sessions`），或用 Saga |
| 報表／分析查詢 | 十幾個維度組合，參數會爆炸 | 專用分析端點，或直接給 SQL 介面 / BI 工具 |

**看到「這個需求用 REST 很彆扭」的時候，先問是不是資源沒建對，再考慮換工具。**
80% 的彆扭是資源建模的問題（0.6.3 的三個洞察），不是 REST 的問題。

---

## 0.8 API 是契約：你的 consumer 是誰

### 0.8.1 六種 consumer，六種痛

| Consumer | 你能強制他升版嗎 | 舊版要撐多久 | 出事時誰被罵 |
|---|---|---|---|
| 自家 Web 前端（SPA） | ✅ 可以（改完部署就生效） | 幾分鐘 | 你們自己 |
| 自家 iOS / Android App | ❌ **不行** | **1～3 年**（有人永遠不升級） | 你 |
| 第三方廠商 ERP | ❌ 完全不行 | 合約規定，可能 5 年 | 你 + 法務 |
| 內部其他微服務 | ⚠️ 要協調排程 | 幾週～幾個月 | 兩個團隊互相 |
| 自動化腳本 / 排程 | ❌ 通常沒人記得它存在 | 直到某天半夜炸掉 | 你（而且是凌晨 3 點） |
| **三個月後的你自己** | — | — | 你 |

**最關鍵的一列是 App。** 具體時間軸：

```
Day 0    你改了 API，把 status 從 "PAID" 改成 "PAYMENT_COMPLETED"
Day 0    Web 前端同步改好，測試通過，上線 ✅
Day 0    iOS App 送審
Day 3    App Store 審核通過
Day 3    使用者開始收到更新通知
Day 30   約 70% 使用者升級完成
Day 90   約 90% 使用者升級完成
Day 365  還有 2% 停在舊版（公司配發的舊機、關閉自動更新的人）
```

**在 Day 0 到 Day 365 這段期間，你的舊 API 必須活著。**
如果你在 Day 0 就把舊行為砍掉，Day 0 當天所有 App 使用者的訂單頁面全部空白。

這就是為什麼第 06 章（版本控管與相容性）在這一站的地位這麼高。
先預告一條鐵律：

> **只能加，不能改，不能減。**
> 新增欄位 / 新增端點 / 新增選填參數 = 安全。
> 改名 / 改型別 / 改語意 / 刪除 / 把選填變必填 = 破壞性變更。

### 0.8.2 「靜默破壞」比「大聲壞掉」危險一百倍

| 變更 | 症狀 | 嚴重度 |
|---|---|---|
| 刪掉 `GET /orders` | 前端立刻 404，5 分鐘內有人回報 | 🟡 痛，但看得見 |
| 把 `amount: 1280.00`（數字）改成 `"1280.00"`（字串） | 前端 `total + amount` 變成 `"01280.00"` 字串拼接，**畫面顯示錯誤金額但不報錯** | 🔴 災難 |
| 把 `amount` 從「元」改成「分」 | 所有金額顯示變成 100 倍。財務三天後才發現 | 🔴 災難 |
| 新增一個列舉值 `PARTIALLY_REFUNDED` | 前端 `switch` 沒有 `default`，該筆訂單狀態欄位空白 | 🟠 中（第 03 章 3.10） |
| 把 `items` 從 `[]` 改成 `null`（沒有明細時） | 前端 `items.map()` → `Cannot read property 'map' of null`，整頁白畫面 | 🔴 高 |
| 分頁 `page` 從 0-based 改成 1-based | 第一頁資料重複或漏一筆，**沒人會注意到** | 🔴 災難（安靜的資料錯誤） |

**規律：型別與語意的變更比結構變更危險，因為它不會拋錯。**

第 03 章會用整章處理「怎麼定義欄位語意，讓它不容易被誤用」。

### 0.8.3 一個真實的血淚案例

某電商把訂單狀態從 5 個值擴充到 8 個，加了 `PARTIALLY_SHIPPED`（部分出貨）。
後端覺得「這只是新增列舉值，是相容的變更」，直接上線。

結果：

```javascript
// App 裡的程式（三年前寫的）
function statusText(status) {
  switch (status) {
    case 'PENDING_PAYMENT': return '待付款';
    case 'PAID':            return '已付款';
    case 'SHIPPED':         return '已出貨';
    case 'COMPLETED':       return '已完成';
    case 'CANCELLED':       return '已取消';
    // 沒有 default
  }
}
```

`statusText('PARTIALLY_SHIPPED')` 回傳 `undefined`。
App 的訂單卡片上狀態文字消失，而且「查看物流」按鈕的顯示條件是
`status === 'SHIPPED'`，所以部分出貨的訂單**看不到物流按鈕**。

客服接到 400 通「我的訂單不見了」（其實只是狀態欄空白，使用者以為訂單壞了）。
修復要等 App 送審，**7 天**。

**這件事的三個教訓**：

1. **新增列舉值對「有 default 的客戶端」是相容的，對「沒有 default 的客戶端」是破壞性的。**
   所以列舉的擴充必須當成需要溝通的變更（第 06 章）。
2. **要在 API 文件裡明確寫「這個欄位未來會新增值，客戶端必須處理未知值」。**
   契約要包含「演進承諾」，不只是當下的欄位清單。
3. **更好的設計**：不要讓前端用 `status` 判斷按鈕。回傳 `allowedActions`（0.4.2 的折衷做法）
   或 `statusLabel`（後端直接給顯示文字）。**把易變的判斷邏輯留在你能當天上線的那一側。**

---

## 0.9 好 API 的六個判準

拿這六條去審查任何一組 API，包含你自己昨天寫的。

### 判準 1：可預測（Predictable）

**看過三個端點，就能猜到第四個長什麼樣。**

```
✅ 可預測
GET    /orders            GET    /products            GET    /customers
GET    /orders/{id}       GET    /products/{id}       GET    /customers/{id}
POST   /orders            POST   /products            POST   /customers
DELETE /orders/{id}       DELETE /products/{id}       DELETE /customers/{id}

❌ 不可預測（每個資源都不一樣）
GET    /orders            GET    /product/list        POST   /getCustomers
GET    /order?id={id}     GET    /products/{id}       GET    /customer/detail/{id}
POST   /order/create      PUT    /product             POST   /customers/new
```

不可預測的代價：前端**每一支 API 都要查文件**。一天問你 20 次。

### 判準 2：一致（Consistent）

同一件事在全站永遠用同樣的方式表達：

| 一致性項目 | 決定一次，全站遵守 |
|---|---|
| JSON 命名 | 全站 `camelCase`（或全站 `snake_case`，但不能混） |
| 分頁參數 | 全站 `page` + `size`（不要有的用 `pageNum` / `pageSize` / `limit` / `offset`） |
| 時間格式 | 全站 ISO-8601 UTC（`2026-08-19T06:12:44Z`） |
| 時間欄位命名 | 全站 `createdAt` / `updatedAt`（不要有的叫 `createTime`、`gmtCreate`） |
| 布林命名 | 全站 `isXxx` 或全站 `xxx`（挑一個） |
| ID 型別 | 全站字串（或全站數字，但不能混） |
| 錯誤格式 | 全站一種（第 04 章） |
| 集合回應外殼 | 全站一種（第 03、05 章） |

> **一致性比「正確性」重要。**
> 一個全站統一用 `pageNum` 的 API，比一半用 `page`、一半用 `pageNum` 的 API 好用得多，
> 即使 `page` 才是慣例。所以**早期就要定好風格指南**（style guide），寫在 repo 裡。

### 判準 3：最小驚訝（Least Surprise）

- `GET` 不會改資料。
- `DELETE` 呼叫兩次不會第二次爆掉。
- 回 `201` 就一定有 `Location`。
- 集合永遠回陣列（沒資料回 `[]`，不是 `null`，也不是把單筆直接回一個物件）。
- 分頁的 `total` 是符合篩選條件的總數，不是全表筆數。
- 錯誤的狀態碼真的反映責任歸屬（你的錯 5xx，對方的錯 4xx）。

### 判準 4：可演進（Evolvable）

- 新增欄位不會讓舊客戶端壞掉（→ 客戶端必須忽略未知欄位）。
- 有版本策略，而不是「出事再說」。
- 列舉值可以擴充，且文件明說客戶端要處理未知值。
- 有棄用（deprecation）流程：`Deprecation` / `Sunset` header + 公告期 + 用量監控。

### 判準 5：可觀測（Observable）

- 狀態碼正確 → 監控自動算出錯誤率。
- 每個回應都有 `traceId`（含錯誤回應）→ 使用者截圖給你就能查。
- URL 有結構 → APM 能按端點分組（`/orders/{id}` 而不是 5 萬個 `/orders/1001`）。
- 錯誤有機器可讀的 `code` → 可以做「`INSUFFICIENT_STOCK` 這個錯誤今天暴增」的告警。

### 判準 6：可測試（Testable）

- 有 OpenAPI 契約 → 可以產生 mock server，前端不用等後端。
- 端點職責單一 → 可以獨立測試。
- 沒有隱含順序依賴（不需要「先打 A 再打 B 才會成功」的暗規則）。
- 錯誤路徑也在契約裡（不只寫成功回應）。

### 0.9.1 十分鐘 API 審查清單

給你 code review 別人的 API 設計時用：

```
□ URL 裡有動詞嗎？                              → 有就要改
□ 讀取用 GET 嗎？                                → 全 POST 要改
□ 建立回 201 + Location 嗎？
□ 錯誤的 HTTP 狀態碼會變嗎？                     → 全 200 是最嚴重的問題
□ 全站錯誤格式只有一種嗎？
□ 集合沒資料時回 [] 而不是 null 嗎？
□ 分頁參數全站一致嗎？
□ 時間是 ISO-8601 UTC 嗎？
□ 金額用什麼型別？會不會有浮點誤差？
□ 回應是 DTO 還是直接把 Entity 丟出去？          → Entity 要改
□ 有沒有欄位不該給前端看（passwordHash、internalCost）？
□ 錯誤訊息會不會洩漏內部細節（SQL、路徑、stack trace）？
□ 有沒有可能被人改別人的資料（IDOR）？
□ 這個變更對現有 App 是破壞性的嗎？
□ 有 traceId 可以追嗎？
```

---

## 0.10 貫穿全站的案例：shop-service 訂單系統

02-spring-boot 的練習專案是 `shop-service`。這一站繼續用它，但只做**設計**。

### 0.10.1 領域範圍

我們做一個**中小型 B2C 電商的訂單模組**。刻意不做太大，但要有足夠的真實複雜度：

```
商品 Product ──┬── 庫存 Inventory
               │
購物車 Cart ────┤（結帳時快照商品資訊）
               │
訂單 Order ────┼── 訂單明細 OrderItem
               ├── 付款 Payment ── 退款 Refund
               ├── 出貨 Shipment
               ├── 取消單 Cancellation
               ├── 退貨單 Return
               └── 通知 Notification

客戶 Customer ── 收件地址 Address
折扣碼 Coupon
```

### 0.10.2 三種角色

| 角色 | 能做什麼 | 對 API 設計的影響 |
|---|---|---|
| 顧客 `CUSTOMER` | 買東西、看自己的訂單、取消、退貨 | `GET /orders` 預設只回自己的 |
| 客服 `SUPPORT` | 查所有訂單、代客取消、加內部備註 | 同端點但可填更多欄位、看得到內部欄位 |
| 倉管 `WAREHOUSE` | 出貨、列印揀貨單 | 只能碰 `shipments` |

### 0.10.3 訂單狀態機（這張圖後面每章都會用到）

```
                  ┌──────────────────┐
   POST /orders → │ PENDING_PAYMENT  │ 待付款
                  └────┬────────┬────┘
   POST payments       │        │  POST cancellations / 逾時自動取消
                       ▼        ▼
                  ┌────────┐  ┌───────────┐
                  │  PAID  │  │ CANCELLED │ 已取消（終態）
                  └───┬────┘  └───────────┘
   POST shipments     │  └────────► POST cancellations（要退款）
                      ▼
              ┌───────────────────┐
              │ PARTIALLY_SHIPPED │ 部分出貨（分批出貨時）
              └────────┬──────────┘
                       ▼
                  ┌─────────┐
                  │ SHIPPED │ 已出貨
                  └────┬────┘
     簽收 / 7 天自動    │
                       ▼
                 ┌───────────┐
                 │ COMPLETED │ 已完成
                 └─────┬─────┘
     POST returns      │
                       ▼
                 ┌──────────┐
                 │ RETURNED │ 已退貨（終態）
                 └──────────┘
```

**這張狀態機決定了大量 API 設計細節**，例如：

| 設計問題 | 答案來自狀態機 |
|---|---|
| `POST /orders/{id}/cancellations` 什麼時候回 409？ | 狀態不在 `{PENDING_PAYMENT, PAID}` 時 |
| 取消已付款訂單和未付款訂單一樣嗎？ | 不一樣 —— 已付款要建立退款，回應要帶 `refund` |
| `PARTIALLY_SHIPPED` 是新增的狀態嗎？ | 是，而且 0.8.3 的災難就是它造成的 |
| `GET /orders/{id}` 的 `allowedActions` 怎麼算？ | 直接查狀態機的出邊 |

> **設計 API 前先畫狀態機。** 這是本站最有價值的一個工作習慣：
> 大部分「這個 API 該回什麼狀態碼」的爭論，畫完狀態機就自動有答案了。

### 0.10.4 本站每章對這個案例做什麼

| 章 | 產出 |
|---|---|
| 00 | 領域盤點、狀態機、動詞→資源對照表（本章 0.6.2） |
| 01 | 完整 URL 表（30+ 條），巢狀深度定案，非 CRUD 動作定案 |
| 02 | 每條路由的方法 + 完整狀態碼契約表 |
| 03 | DTO 全家族：`CreateOrderRequest`、`OrderSummary`、`OrderDetail`… |
| 04 | 錯誤目錄：每個業務錯誤的 `code`、狀態碼、訊息、前端該怎麼處理 |
| 05 | 分頁 / 篩選 / 排序參數規格 |
| 06 | 版本策略、破壞性變更檢查表、棄用流程 |
| 07 | `orders-api.yaml`（OpenAPI 3.1 完整契約） |
| 08 | 冪等鍵、ETag、快取、限流的契約 |
| 09 | 契約測試、REST Client 集合、前後端協作流程 |

---

## 0.11 工具準備

這一站不寫 Java，但要大量**發請求、讀回應**。先把工具備好。

### 0.11.1 `curl`：底線工具

```bash
# -i 連 header 一起印（設計 API 時 header 比 body 重要，這個旗標最常用）
curl -i https://api.github.com/repos/spring-projects/spring-boot

# -s 安靜模式 + jq 美化（最常用的組合）
curl -s https://api.github.com/repos/spring-projects/spring-boot | jq '.name, .stargazers_count'

# -D - 只看 header，body 丟掉（檢查快取、ETag、限流 header 時用）
curl -s -o /dev/null -D - https://api.github.com/repos/spring-projects/spring-boot

# POST JSON
curl -i -X POST http://localhost:8080/orders \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 8f14e45f-ea36-4a1b-9c2e-77e8f1a3b0c1' \
  -d '{"items":[{"productId":"P-1001","quantity":2}]}'

# 從檔案讀 body（body 一長就一定要這樣，不然引號會逼死你）
curl -i -X POST http://localhost:8080/orders \
  -H 'Content-Type: application/json' \
  -d @create-order.json

# 只印狀態碼（寫測試腳本時很有用）
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/orders/999

# 印詳細時間分解（診斷慢在哪一段）
curl -s -o /dev/null -w 'dns=%{time_namelookup} connect=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total}\n' \
  https://api.github.com

# 看完整的 TLS + header 協商過程（-v 是除錯時的第一手段）
curl -v https://api.github.com/rate_limit 2>&1 | head -30
```

### 0.11.2 `jq`：JSON 生存工具

```bash
brew install jq          # macOS
# apt install jq         # Debian/Ubuntu

# 取欄位
echo '{"orderNumber":"ORD-1","totalAmount":"1280.00"}' | jq -r '.orderNumber'

# 陣列取每一筆的某幾個欄位（檢查列表回應最常用）
curl -s localhost:8080/orders | jq '.items[] | {orderNumber, status, totalAmount}'

# 過濾
curl -s localhost:8080/orders | jq '.items[] | select(.status == "PAID")'

# 算數量（驗證分頁對不對）
curl -s localhost:8080/orders | jq '.items | length'

# 列出所有 key（檢查回應有沒有多出不該有的欄位 ★ 資安檢查必用）
curl -s localhost:8080/orders/1001 | jq 'keys'

# 遞迴列出所有 key（找出巢狀裡藏的敏感欄位）
curl -s localhost:8080/orders/1001 | jq -r '[paths | join(".")] | .[]'

# 檢查有沒有 null（找出該回 [] 卻回 null 的欄位）
curl -s localhost:8080/orders/1001 | jq '[paths(. == null) | join(".")]'
```

最後兩個技巧在**資安審查**時特別有用：
一行指令就能看出回應有沒有不小心把 `passwordHash`、`internalCost`、`customer.idNumber` 漏出去。

### 0.11.3 VS Code REST Client：把請求存進版控 ★ 推薦

比 Postman 好的地方：**它是純文字檔，可以進 Git、可以 code review、可以跟著 PR 走。**

安裝擴充套件 `humao.rest-client`，然後建立 `api/orders.http`：

```http
@host = http://localhost:8080
@token = eyJhbGciOiJIUzI1NiJ9.PLACEHOLDER

### 查詢訂單列表
GET {{host}}/orders?status=PAID&page=0&size=20
Authorization: Bearer {{token}}
Accept: application/json

### 建立訂單
# @name createOrder
POST {{host}}/orders
Content-Type: application/json
Authorization: Bearer {{token}}
Idempotency-Key: 8f14e45f-ea36-4a1b-9c2e-77e8f1a3b0c1

{
  "items": [
    { "productId": "P-1001", "quantity": 2 },
    { "productId": "P-2003", "quantity": 1 }
  ],
  "shippingAddress": {
    "recipient": "王小明",
    "phone": "0912345678",
    "postalCode": "10491",
    "line1": "台北市中山區民生東路三段 10 號 5 樓"
  }
}

### 用上一個請求的回應當變數（★ 這是 Postman 要寫腳本才能做到的事）
GET {{host}}/orders/{{createOrder.response.body.$.orderId}}
Authorization: Bearer {{token}}

### 付款
POST {{host}}/orders/{{createOrder.response.body.$.orderId}}/payments
Content-Type: application/json
Authorization: Bearer {{token}}

{ "method": "CREDIT_CARD", "cardToken": "tok_test_visa" }

### 錯誤路徑：查不存在的訂單（★ 錯誤路徑也要存進版控）
GET {{host}}/orders/99999999
Authorization: Bearer {{token}}

### 錯誤路徑：驗證失敗
POST {{host}}/orders
Content-Type: application/json
Authorization: Bearer {{token}}

{ "items": [] }
```

> **實務做法**：`api/*.http` 放進 repo，和程式一起 review。
> 新人來的第一天就能打通所有端點，不用去 Slack 要 Postman 分享連結。
> 敏感值（真 token）用 `.env` 或 `http-client.env.json` 並加進 `.gitignore`。

### 0.11.4 其他值得知道的工具

| 工具 | 用途 |
|---|---|
| `httpie`（`http` 指令） | 比 curl 好讀的語法：`http POST :8080/orders items:='[]'` |
| `hurl` | 用純文字檔寫 API 測試 + 斷言，適合放進 CI |
| Postman / Insomnia / Bruno | 圖形化。Bruno 的檔案格式是純文字，可進版控 |
| `ngrok` / `cloudflared` | 把 localhost 暴露到外網，測 Webhook 必備 |
| `websocat` | 測 WebSocket |
| `grpcurl` | 測 gRPC |
| Swagger UI / Redoc | 讀 OpenAPI（第 07 章） |
| Prism / WireMock | 用 OpenAPI 起 mock server（第 07、09 章） |

---

## 0.12 常見誤區

**誤區 1：「我們的 API 是 RESTful 的」**
大部分人說這句話時，意思是「我們用 HTTP 和 JSON」。
按 Fielding 的定義，沒有 HATEOAS 就不是 REST（只到 Level 2）。
**務實態度**：不要爭這個詞。把 Level 2 做滿，需要時加能力清單。
真正該問的是「這組 API 好不好用、好不好改」，不是「這算不算 REST」。

**誤區 2：「REST 就是 CRUD」**
CRUD 只是最簡單的一類資源。真實系統大量操作不是 CRUD
（取消、退款、審核、出貨、重寄、匯出）——第 01 章 1.7 會給五種手法處理它們。
「不是 CRUD」不代表「不能用 REST」，而是代表「你要多找一個名詞」。

**誤區 3：「一個資源必須對應一張資料表」**
完全沒有這個關係。
- 一個資源可以由多張表組成（`OrderDetail` 聚合訂單 + 明細 + 出貨 + 付款）。
- 一張表可以有多個資源視圖（`/orders` 摘要 vs `/orders/{id}` 完整 vs `/orders/{id}/summary`）。
- 有的資源根本沒有表（`/carts/current/summary` 是即時算出來的）。

**把資料表結構直接暴露成 API，是所有 API 設計問題的共同源頭。**（第 03 章 3.2）

**誤區 4：「URL 要設計得越短越好」**
清楚 > 短。`/orders/{id}/cancellations` 比 `/oc/{id}` 好得多。
URL 是給人讀的（工程師、文件、log），多幾個字元不花錢。

**誤區 5：「先做完功能，文件之後再補」**
「之後」等於「永遠不會」，而且補出來的文件永遠和實作不一致。
第 07 章會講怎麼讓文件從程式碼自動長出來（Code-first），
或先寫契約再實作（Design-first）—— 兩種都比手寫 Word 好。

**誤區 6：「內部 API 不用設計」**
內部 API 的 consumer 是**你的同事**，而且內部服務的存活期常常比前端更長。
更重要的是：今天的內部 API，三年後可能變成對外開放平台的基礎。
「內部」不是不設計的理由，只是可以少做版本控管而已。

**誤區 7：「照著大公司的 API 抄就對了」**
可以參考，但要知道它們的取捨背景：
- **Stripe** 的 API 極好，但它有一整個團隊在維護向後相容（每個帳號釘住一個日期版本）。
- **GitHub** 有完整 HATEOAS 風格的 `url` 欄位，因為它的 consumer 是全世界的工具。
- **Slack** 是 RPC 風格且全回 200，因為它從 2013 年就這樣、改不動了。

**抄設計要連「他們為什麼這樣做」一起抄。**

---

## 0.13 本章練習

### 練習 1：判斷 REST 約束

以下情境各違反了哪一條約束？後果是什麼？

1. 把使用者的購物車放在 Tomcat 的 `HttpSession` 裡，部署兩台機器 + 輪詢式負載平衡。
2. `GET /me` 的回應沒有任何 `Cache-Control`，前面有一層公司自建的 Nginx 代理快取（預設會快取 200 的 GET）。
3. 錯誤時回 `HTTP 200` + `{"code": 500, "msg": "database connection failed to 10.0.3.22:3306"}`。
4. 整個系統只有一個端點 `POST /gateway`，用 body 裡的 `service` + `method` 決定要做什麼。
5. 回應裡有 `"handledBy": "order-app-node-7.prod.internal"`，而某個前端開始用它做問題回報。

<details>
<summary>參考解答</summary>

| # | 違反的約束 | 後果 |
|---|---|---|
| 1 | **Stateless** | 使用者被導到另一台機器就看到空購物車。開 sticky session 只是把問題換成「機器掛掉 = 購物車消失」「部署 = 清空購物車」「流量不均」 |
| 2 | **Cache**（標錯／沒標） | 🔴 **資安事故**：A 使用者的 `/me` 被 Nginx 快取，B 使用者拿到 A 的個資。這是實際發生過多次的事故類型。修法：`Cache-Control: private, no-store` |
| 3 | **Uniform Interface（自我描述訊息）** + **Layered System** | ① 狀態碼 200 讓所有中介元件與監控以為成功，錯誤率永遠 0%，SLO 失效、告警不會響。② 錯誤訊息洩漏內部 IP 與埠號，違反分層系統的封裝 |
| 4 | **Uniform Interface（資源識別）** | Richardson Level 0。無法按端點做限流、權限、快取、監控分組。APM 只看得到「`/gateway` QPS 8000」 |
| 5 | **Layered System** | 洩漏內部拓樸；更糟的是前端一旦依賴這個欄位，你就不能改機器命名或改成 K8s Pod 名稱了 —— **任何欄位一旦被使用就變成契約** |

</details>

### 練習 2：Richardson 級別判定

判斷以下四組 API 各在第幾級，並說出「升到 Level 2 最少要改什麼」。

```
A)  POST /api/v1/invoke     body: {"cmd":"user.list","args":{"page":1}}

B)  POST /users/list
    POST /users/create
    POST /users/123/update
    POST /users/123/delete

C)  GET    /users?page=0&size=20        → 200
    POST   /users                       → 200 {"id":123}
    PUT    /users/123                   → 200
    DELETE /users/123                   → 200
    （所有錯誤都回 200 + {"code":-1}）

D)  GET    /users?page=0&size=20        → 200
    POST   /users                       → 201 + Location: /users/123
    PATCH  /users/123                   → 200
    DELETE /users/123                   → 204
    錯誤 → 400 / 404 / 409 + application/problem+json
```

<details>
<summary>參考解答</summary>

| | 級別 | 理由 | 升 Level 2 最少要改 |
|---|---|---|---|
| **A** | **Level 0** | 單一 URI + 單一方法，語意全在 body | 拆出資源 URI、用對方法、用對狀態碼（等於重寫） |
| **B** | **Level 1** | 有資源 URI（`/users/123`），但全部 `POST`，動詞還在路徑裡 | `POST /users/list` → `GET /users`；`/users/create` → `POST /users`；`/123/update` → `PATCH /users/123`；`/123/delete` → `DELETE /users/123`；加上正確狀態碼 |
| **C** | **Level 1.5** | 方法用對了 ✅，但**狀態碼沒用**（全 200） | ① 錯誤回真正的 4xx/5xx ② `POST` 回 `201` + `Location` ③ `DELETE` 回 `204` |
| **D** | **Level 2** ✅ | 方法、狀態碼、Problem Details 都到位 | 已達標。要往 Level 3 就加 `_links` 或 `allowedActions` |

**重點**：C 是最常見的狀況 —— **工程師以為自己在做 REST，因為方法用對了；
但真正讓監控、重試、客戶端函式庫失效的是「狀態碼全 200」。**
如果只能改一件事，改狀態碼比改 URL 重要。

</details>

### 練習 3：動詞 → 資源翻譯

把以下需求翻譯成資源導向的端點。標出哪些「動作其實是名詞」。

```
1. 使用者可以把文章存成草稿
2. 使用者可以發布草稿
3. 使用者可以把已發布的文章下架
4. 使用者可以按讚 / 取消按讚
5. 使用者可以檢舉文章
6. 管理員可以審核檢舉並決定是否下架
7. 使用者可以訂閱作者，也可以取消訂閱
8. 使用者可以把文章加入稍後閱讀清單
9. 系統可以重新計算某篇文章的熱度分數
10. 使用者可以匯出自己所有文章為 ZIP
```

<details>
<summary>參考解答</summary>

| # | 端點 | 說明 |
|---|---|---|
| 1 | `POST /articles`（body 含 `"status": "DRAFT"`） | 草稿和文章是**同一個資源的不同狀態**，不要開 `/drafts` 另一組（否則發布時要跨資源搬資料） |
| 2 | `PUT /articles/{id}/status` body `{"status":"PUBLISHED"}`<br>或 `POST /articles/{id}/publications` | 若「發布」需要紀錄（誰發、何時發、可排程、可重新發布）→ 用 `publications` 資源；若只是改一個欄位 → 改狀態 |
| 3 | `PUT /articles/{id}/status` body `{"status":"UNLISTED"}` | 同上。注意這**不是** `DELETE` —— 下架 ≠ 刪除 |
| 4 | `PUT /articles/{id}/like`（讚）／`DELETE /articles/{id}/like`（取消） | ★ **關鍵題**：用 `PUT`/`DELETE` 而不是 `POST /like` + `POST /unlike`，因為讚是**冪等**的 —— 連點五次還是一個讚。`/like` 是一個「單例子資源」（第 01 章 1.8） |
| 5 | `POST /articles/{id}/reports` | ✅ 名詞：檢舉單有檢舉人、理由、時間、處理狀態，管理員要能列表 |
| 6 | `PATCH /reports/{reportId}` body `{"resolution":"TAKEN_DOWN"}` | ✅ 檢舉單本身是頂層可查的資源（管理後台要跨文章看所有檢舉） |
| 7 | `PUT /authors/{id}/subscription`／`DELETE /authors/{id}/subscription`<br>或 `POST /me/subscriptions` + `DELETE /me/subscriptions/{authorId}` | 兩種都可以。第二種讓「我訂閱的作者清單」有天然的端點 `GET /me/subscriptions` |
| 8 | `PUT /me/reading-list/{articleId}`／`DELETE /me/reading-list/{articleId}` | 用 `PUT` 因為冪等（重複加入不該變兩筆） |
| 9 | ⚠️ 通常**不是 API**（排程或事件觸發）。若要給運維手動觸發：`POST /articles/{id}/score-recalculations` → `202 Accepted` | 內部維運操作。若一定要做，別做成同步端點 |
| 10 | `POST /me/article-exports` → `202` + `Location: /me/article-exports/{jobId}`<br>然後 `GET /me/article-exports/{jobId}` 輪詢，完成後回 `downloadUrl` | ✅ **匯出工作是資源**。同步做會超時（Nginx 60 秒），而且沒有進度、不能重試、不能重新下載 |

**這題的三個核心**：

1. **第 4、7、8 題用 `PUT`/`DELETE` 而不是 `POST /like` + `POST /unlike`**。
   因為「按讚」在業務上是冪等的 —— 手機網路不穩重送三次，結果應該一樣。
   （這是第 02 章 2.2 冪等性的實際應用。）
2. **第 5、6 題的「檢舉」是完整的資源**，有自己的生命週期（待處理 → 已處理），
   而且需要**跨文章**查詢（管理後台看所有待處理檢舉）→ 所以它同時有巢狀路徑（建立）和頂層路徑（管理）。
3. **第 10 題的匯出必須非同步**。這是新手最常做錯的一類端點。

</details>

### 練習 4：估算破壞性變更的代價

你的 API 有以下 consumer：Web SPA、iOS App（12 萬使用者）、Android App（30 萬使用者）、
3 家廠商的 ERP、公司內部 5 個微服務、2 個排程腳本。

你想把 `GET /orders` 回應中的 `amount`（數字，單位「元」）改成 `amountMinor`（整數，單位「分」），
因為浮點誤差造成對帳差幾分錢。

請回答：
1. 這是破壞性變更嗎？
2. 如果直接上線，各 consumer 會發生什麼？
3. 正確的做法是什麼？時程要多久？

<details>
<summary>參考解答</summary>

**1. 是，而且是最危險的一種 —— 靜默破壞（silent breakage）。**

不是 404、不是 500、不會拋錯。所有客戶端都會「成功地顯示錯誤的金額」（100 倍）。

**2. 各 consumer 的下場**

| Consumer | 症狀 | 發現時間 |
|---|---|---|
| Web SPA | `amount` 變 `undefined` → 顯示 `NaN` 或空白 | 幾分鐘（QA 或使用者回報） |
| iOS App | 若用 Swift `Codable` 且 `amount` 非 optional → **解析失敗，整頁空白或 crash** | 幾分鐘～幾小時 |
| Android App | Gson 遇缺欄位給 0 → **所有訂單顯示 0 元**（不會 crash，最可怕） | 可能好幾天 |
| 廠商 ERP | 對帳批次跑出金額全 0 或欄位缺失 → 可能直接寫進他們的帳務系統 | 🔴 **對帳日才發現，可能已產生錯誤帳務憑證** |
| 內部微服務 | 各自不同，可能 NPE、可能算錯促銷金額 | 不一定 |
| 排程腳本 | 靜默寫入錯誤資料到報表 | 🔴 **可能永遠不會發現** |

**最嚴重的不是 crash，是「不 crash 但數字錯」。** 錯誤金額一旦進了廠商的帳務或你的報表，
清理成本遠高於一次當機。

**3. 正確做法：加欄位，不改欄位（Expand–Contract 模式）**

```jsonc
// 階段 1：新舊並存（今天就可以上線，零風險）
{
  "amount": 1280.00,        // 保留舊欄位，標記 deprecated（文件上）
  "amountMinor": 128000,    // 新增，型別明確：整數分
  "currency": "TWD"         // 順手補上幣別（原本隱含 TWD 也是個坑）
}
```

完整時程：

| 階段 | 動作 | 時間 |
|---|---|---|
| 1 | 回應同時給 `amount` 與 `amountMinor`；OpenAPI 標 `deprecated: true`；文件寫清楚 | Day 0 |
| 2 | 通知所有 consumer（Web / App / 3 家廠商 / 5 個內部服務 / 2 個腳本）；給遷移指引 | Day 0～7 |
| 3 | Web 前端改用 `amountMinor` | Day 1～7 |
| 4 | App 改用 `amountMinor` 並送審發版 | Day 7～14 |
| 5 | **監控 `amount` 欄位的實際使用者**：在回應時記錄 consumer 的 `User-Agent` / API key，或用 `Deprecation` header + 觀察誰還在用舊版 App | 持續 |
| 6 | 等舊版 App 用量降到可接受（例如 < 0.5%），發 `Sunset` header 公告 | Day 90～365 |
| 7 | 移除 `amount` | 通常 **6～12 個月後**，或**永遠不移除**（保留一個欄位的成本其實很低） |

**額外要做的三件事**：

- **對帳誤差的即時止血**：真正的浮點誤差問題在「後端計算」，不是「API 欄位型別」。
  後端立刻改用 `BigDecimal`（Java）與 `DECIMAL`（MySQL），這件事**不需要動 API 就能做**。
  API 欄位型別是為了防止**客戶端**用 JS 的 `Number` 算錯（第 03 章 3.5）。
- **不要用同一個名字改語意**：❌ 絕對不要保留 `amount` 這個名字但把單位改成分。
  這會讓「已經改好的客戶端」和「還沒改的客戶端」都是壞的，而且沒有任何方法能偵測。
  **改語意必須改名字。**
- **這次的教訓要寫進 style guide**：從今天起，所有金額欄位一律 `xxxMinor`（整數分）+ `currency`，
  或一律用字串 decimal。第 03 章會定案。

</details>

### 練習 5：審查一組真實 API

以下是某內部系統的端點清單。找出至少 10 個問題，並給出修正版。

```
GET  /api/v1/getUserOrders?userId=123
POST /api/v1/order/create
GET  /api/v1/order/get/{id}
POST /api/v1/order/update
GET  /api/v1/order/delete/{id}
POST /api/v1/order/cancel
GET  /api/v1/Order/ExportExcel?startDate=2026/08/01&endDate=2026/08/31
POST /api/v1/order/items/batch_add
GET  /api/v1/orders/{id}/getItems

回應範例（GET /api/v1/order/get/1001）：
HTTP/1.1 200 OK
Content-Type: text/html

{
  "code": 0,
  "msg": "success",
  "data": {
    "ID": 1001,
    "user_id": 123,
    "userName": "王小明",
    "passwordHash": "$2a$10$N9qo8uLOickgx2ZMRZoMy...",
    "amount": 1280.5,
    "createTime": "2026-08-19 14:12:44",
    "items": null,
    "status": 2
  }
}
```

<details>
<summary>參考解答</summary>

**URL 層面的問題**

| # | 問題 | 修正 |
|---|---|---|
| 1 | URL 裡有動詞：`getUserOrders`、`create`、`get`、`update`、`delete`、`cancel`、`ExportExcel` | 全部改成名詞 + HTTP 方法 |
| 2 | `GET /order/delete/{id}` 用 `GET` 做刪除 | `DELETE /orders/{id}`（0.3.1 的爬蟲事故） |
| 3 | 單複數不一致：`/order/...` 和 `/orders/{id}/...` 混用 | 一律複數 `/orders` |
| 4 | 大小寫不一致：`/Order/ExportExcel` | 一律小寫 |
| 5 | 命名風格混用：`batch_add` 是 snake_case，其他是 camelCase | 一律 kebab-case（第 01 章 1.3） |
| 6 | `getUserOrders?userId=123` 有 **IDOR 風險**：改成別人的 `userId` 就能看別人的訂單 | 用 `GET /orders`（從 token 取得身分）；管理端才允許 `?customerId=` 並檢查權限 |
| 7 | 日期格式 `2026/08/01` 不是 ISO-8601 | `2026-08-01` |
| 8 | 匯出用同步 `GET` → 資料量大會超時 | `POST /order-report-exports` → `202` + 輪詢 |
| 9 | `update` 用 `POST` 且 id 在 body 裡 | `PATCH /orders/{id}`（id 在路徑） |
| 10 | `cancel` 沒有 id 在路徑上 | `POST /orders/{id}/cancellations` |
| 11 | `/orders/{id}/getItems` 動詞 + 巢狀重複 | `GET /orders/{id}/items` |

**回應層面的問題**

| # | 問題 | 修正 |
|---|---|---|
| 12 | 🔴 **`passwordHash` 外洩** | 用 DTO，絕不回 Entity（第 03 章 3.2） |
| 13 | `Content-Type: text/html` 但 body 是 JSON | `application/json` |
| 14 | 錯誤與成功都回 200，靠 `code` 判斷 | 用 HTTP 狀態碼；錯誤用 `application/problem+json`（第 04 章） |
| 15 | 欄位命名三種風格：`ID`（全大寫）、`user_id`（snake）、`userName`（camel） | 全站 `camelCase`：`id`、`customerId`、`customerName` |
| 16 | `amount: 1280.5` 是浮點數 | `"amount": "1280.50"`（字串 decimal）或 `amountMinor: 128050` + `currency` |
| 17 | `createTime: "2026-08-19 14:12:44"` 沒有時區、格式非標準 | `"createdAt": "2026-08-19T06:12:44Z"` |
| 18 | `items: null` —— 集合回 null | 回 `[]`；或這個端點本來就不該帶 items（讓客戶端打 `/orders/{id}/items`） |
| 19 | `status: 2` 是魔術數字 | `"status": "PAID"`（字串列舉，可讀、可擴充、log 看得懂） |
| 20 | 沒有 `traceId` | 加上 `traceId`，客服對答案用（第 04 章 4.8） |

**修正後的端點清單**

```
GET    /orders?customerId=123&status=PAID&page=0&size=20   # 客服；顧客不帶 customerId
GET    /orders/{orderId}
POST   /orders
PATCH  /orders/{orderId}
DELETE /orders/{orderId}                                   # 或不提供，改用 cancellations
POST   /orders/{orderId}/cancellations
GET    /orders/{orderId}/items
POST   /orders/{orderId}/items                             # 支援單筆或陣列
POST   /order-report-exports                               # 202 + 輪詢
GET    /order-report-exports/{exportId}
```

**修正後的回應**

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: private, no-store
ETag: "a3f5c9e1"

{
  "orderId": "1001",
  "orderNumber": "ORD-20260819-0001",
  "customer": { "customerId": "123", "displayName": "王小明" },
  "status": "PAID",
  "statusLabel": "已付款",
  "totalAmount": "1280.50",
  "currency": "TWD",
  "createdAt": "2026-08-19T06:12:44Z",
  "updatedAt": "2026-08-19T06:15:02Z",
  "allowedActions": ["CANCEL", "REQUEST_INVOICE"],
  "itemCount": 3,
  "traceId": "4f2c8a1e9b7d3f60"
}
```

注意幾個刻意的設計決定（後面章節會逐一解釋）：
- `orderId` 是**字串**（避免 JS 大數字精度問題，第 03 章 3.5）
- 有 `orderNumber`（對外可讀）也有 `orderId`（系統識別），兩者不同（第 01 章 1.4）
- `statusLabel` 讓前端不用維護對照表（0.8.3 的教訓）
- `allowedActions` 讓業務規則只有一份（0.4.2 的折衷做法）
- 沒有 `items` —— 列表和明細分開，避免 over-fetching（第 03 章 3.8）
- 有 `ETag` 可做條件請求與樂觀鎖（第 02 章 2.11、第 08 章）

</details>

---

## 0.14 驗收清單

- [ ] 我能舉出至少五個「沒設計過的 API」造成的**可量化**代價，包含「全回 200 讓監控失效」這一項。
- [ ] 我能說出 REST 六大約束，並指出 HATEOAS 是唯一大家普遍沒做的那一條，也能說出為什麼。
- [ ] 我知道 Stateless 講的是**會談狀態**不該在伺服器，而**資源狀態**本來就在伺服器。
- [ ] 我知道沒設 `Cache-Control` 可能導致**個資被共享快取外洩**，也知道保命寫法是 `private, no-store`。
- [ ] 我能說出「自我描述訊息」為什麼讓「全部回 200」在架構上是錯的。
- [ ] 我能判斷一組 API 在 Richardson 第幾級，也知道「方法對了但狀態碼全 200」是最常見的 Level 1.5。
- [ ] 我能用「這個動作有沒有產生值得查詢的紀錄」判斷它該不該變成資源。
- [ ] 我知道權限差異**不該**產生兩套端點（`/admin/xxx` 與 `/user/xxx`），除非資源模型真的不同。
- [ ] 我能說出 REST / RPC / GraphQL / gRPC 各自的適用場景，也知道 GraphQL 天生有「全回 200」的監控問題。
- [ ] 我能列出六種 consumer，並說明為什麼 **App 讓舊 API 必須活 1～3 年**。
- [ ] 我知道「靜默破壞」（改型別、改單位、改語意）比「大聲壞掉」（刪端點）危險得多。
- [ ] 我知道改語意**必須改名字**，以及 Expand–Contract（先加新欄位、再退場舊欄位）的流程。
- [ ] 我能用六個判準（可預測 / 一致 / 最小驚訝 / 可演進 / 可觀測 / 可測試）審查一組 API。
- [ ] 我知道**一致性比正確性重要**，也知道 style guide 要早期就定並寫進 repo。
- [ ] 我會用 `curl -i`、`jq keys`、`jq paths` 檢查回應有沒有洩漏不該有的欄位。
- [ ] 我能寫 `.http` 檔並把它放進版控，包含錯誤路徑的請求。
- [ ] 我能畫出 shop-service 的訂單狀態機，並理解「設計 API 前先畫狀態機」為什麼能省下大量爭論。

---

完成後請前往 [01-resource-modeling-and-url-design.md](./01-resource-modeling-and-url-design.md)。
