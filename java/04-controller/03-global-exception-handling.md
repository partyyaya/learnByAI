# 第 03 章：全域例外處理

> 這是這一站**最關鍵的一章**。
>
> 前兩章讓請求能進來、能被驗證。但一個 API 有一半的價值在**失敗的時候**：
> 前端要知道能不能重試、使用者要看得懂發生什麼、客服要能查到那一筆、
> 監控要能區分「使用者填錯」和「我們掛了」。
>
> 03-rest-api 第 04 章設計了一份約 60 個 `code` 的錯誤目錄。這一章要把它**全部落地**，
> 而且達成一個具體目標：**70 條端點、一個 advice 類別、零個 try-catch。**

---

## 3.1 學習目標

完成本章後，你應該可以：

- 完整說明 `HandlerExceptionResolver` 鏈，以及 `@RestControllerAdvice` 在哪一環。
- 說出 `@ExceptionHandler` 方法的選擇規則，並預測「兩個 handler 都能接」時哪個贏。
- 說出**哪些例外進不了 advice**（六種），以及每一種的處理方式。
- 用 enum 建立**錯誤碼註冊表**，把 `code → 狀態碼 / type / retryable / i18n key` 綁成一份真相。
- 設計分層的領域例外，並知道為什麼**不該**用 `ResponseStatusException`。
- 在 Spring 6 的 `ProblemDetail` 與自訂 record 之間做出有理由的選擇。
- 寫出一個 advice 處理：業務例外、三種驗證例外、25 種 Spring 內建例外、以及最後的 `Exception`。
- 讓 404 / 405 / 406 / 415 / 413 全部走統一格式。
- 從 `HttpMessageNotReadableException` 裡**精確抽出出錯的欄位路徑**，而不是回一坨 Jackson 訊息。
- 處理 Filter 層的例外與 Spring Security 的 401 / 403，讓它們格式一致。
- 保證 5xx 不洩漏 stack trace、SQL、資料表名稱。
- 設計錯誤的日誌分級與監控指標，並避免高基數標籤。
- 為錯誤處理本身寫測試 —— 因為它出錯時不會有人發現。

---

## 3.2 先看見痛：70 個 try-catch 的系統

### 3.2.1 現場

一個上線兩年的訂單系統，`grep` 一下：

```bash
$ grep -c "catch" src/main/java/com/example/*/controller/*.java | sort -t: -k2 -rn | head
OrderController.java:47
ProductController.java:31
PaymentController.java:28
CartController.java:19
CustomerController.java:16
...
$ grep -rc "catch" src/main/java/com/example/*/controller/ | awk -F: '{s+=$2} END {print s}'
213
```

**213 個 catch 區塊。** 而它們產生了幾種錯誤格式？寫個腳本掃一下回應的組法：

```bash
$ grep -rhoE 'Map\.of\("[a-zA-Z]+"|put\("[a-zA-Z]+"' src/main/java/com/example/*/controller/ \
  | sort | uniq -c | sort -rn
    89 put("msg"
    76 put("code"
    41 put("message"
    38 put("errorCode"
    22 put("error"
    17 put("success"
    11 put("errMsg"
     9 put("detail"
     6 put("reason"
```

**九種欄位名，表達同一件事。** 前端的錯誤處理長這樣（真實程式碼）：

```javascript
function extractError(res) {
  return res.msg || res.message || res.errMsg || res.error
      || res.detail || res.reason || res.errorMessage
      || (res.data && res.data.msg)
      || '發生未知錯誤';
}

function isError(res, status) {
  if (status >= 400) return true;
  if (res.code !== undefined && res.code !== 0 && res.code !== 200) return true;
  if (res.success === false) return true;
  if (res.errorCode) return true;
  return false;
}
```

### 3.2.2 五個具體損失

**損失 1：監控完全失效。**

因為大量錯誤被包成 `200 OK`：

```java
catch (InsufficientStockException e) {
    return Map.of("code", -1, "msg", "庫存不足");     // HTTP 200
}
```

於是：

| 機制 | 為什麼失效 |
|---|---|
| Prometheus 的 `http_server_requests_seconds_count{status="5xx"}` | 永遠是 0，看起來很健康 |
| 前端的 Sentry | 不會上報（因為 HTTP 成功） |
| 負載平衡器的健康檢查 | 認為節點正常 |
| API Gateway 的熔斷器 | 不會跳閘 |
| 客戶端的自動重試 | 不會重試（它以為成功了） |

**那一次資料庫連線池耗盡的事故**，`catch (Exception e)` 把全部錯誤變成
`{"code": -1, "msg": "系統忙碌"}` + HTTP 200。
**監控圖表一片綠色，直到客服電話進來 —— 47 分鐘後。**

**損失 2：狀態碼與語意脫節，客戶端只能猜。**

```java
catch (Exception e) {
    return ResponseEntity.status(500).body(Map.of("msg", e.getMessage()));
}
```

「庫存不足」（使用者要改數量）和「資料庫掛了」（該重試）都是 500。
前端無法區分 → 只能都顯示「系統錯誤，請稍後再試」→
使用者不知道其實只要把數量改成 3 就好。

**損失 3：資訊洩漏。**

`e.getMessage()` 直接回傳，於是使用者的瀏覽器上出現過：

```json
{"code":-1,"msg":"could not execute statement; SQL [insert into t_order (customer_id,order_no,status,total_amount,created_at) values (?,?,?,?,?)]; constraint [uk_order_no]; nested exception is org.hibernate.exception.ConstraintViolationException"}
```

```json
{"code":-1,"msg":"Connection refused: connect to 10.20.3.41:3306"}
```

**第二個更糟**：它洩漏了內部網段與資料庫位址。
資安 pentest 開了 High 單，而且它進了 CDN 的 access log 與前端的 Sentry。

**損失 4：漏掉的路徑回 HTML。**

新加的第 71 條端點忘了包 try-catch → 例外逃到 Tomcat →
Spring Boot 的 Whitelabel Error Page（HTML）→ 前端 `res.json()`：

```
SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON
```

**前端的錯誤處理器自己爆掉**，於是使用者看到白畫面（連錯誤訊息都沒有）。

**損失 5：改一個文案要動 47 個檔案。**

法務要求把「系統錯誤」改成「系統暫時無法處理您的請求，請稍後再試」。
`grep "系統錯誤"` → 89 個結果 → 改了 84 個（漏 5 個）→
再上線兩次才改完。

### 3.2.3 目標長什麼樣

**這一章結束時，`OrderController` 裡的 catch 數量是 0**，而所有錯誤都長這樣：

```http
HTTP/1.1 409 Conflict
Content-Type: application/problem+json
Cache-Control: no-store
X-Trace-Id: 4f2c8a1e9b7d3f60
```

```jsonc
{
  "type": "https://api.shop.example/problems/insufficient-stock",
  "title": "庫存不足",
  "status": 409,
  "detail": "Product P-1001 has 3 units available but 5 were requested in items[2].",
  "instance": "/orders",
  "code": "INSUFFICIENT_STOCK",
  "userMessage": "「無線降噪耳機 Pro」僅剩 3 件，請調整數量後再結帳。",
  "errors": [
    { "field": "items[2].quantity", "code": "INSUFFICIENT_STOCK",
      "message": "僅剩 3 件", "rejectedValue": 5, "constraint": { "available": 3 } }
  ],
  "productId": "P-1001",
  "productName": "無線降噪耳機 Pro",
  "requested": 5,
  "available": 3,
  "restockEstimatedAt": "2026-08-22",
  "retryable": false,
  "retryStrategy": "MODIFY_REQUEST",
  "traceId": "4f2c8a1e9b7d3f60",
  "timestamp": "2026-08-20T06:12:44Z"
}
```

**而產生它的程式碼是**：

```java
// Service（05-service 會實作）
throw new InsufficientStockException(product, requested, available, itemIndex);
```

**一行。** 狀態碼、`type`、`title`、`userMessage`、`retryable` 全部從錯誤碼註冊表查出來（3.4），
`traceId` 從 MDC 拿（04 章），`instance` 從當前請求拿。

---

## 3.3 例外處理的機制

### 3.3.1 `HandlerExceptionResolver` 鏈

回到第 00 章 0.8.1 的圖，放大 ⑩ 那一步：

```
DispatcherServlet.doDispatch()
  │
  ├─ try {
  │     getHandler() → applyPreHandle() → ha.handle() → applyPostHandle()
  │  } catch (Exception ex) {
  │     dispatchException = ex;                    ← 例外被記下來，不是往外拋
  │  } catch (Throwable err) {
  │     dispatchException = new ServletException("Handler dispatch failed: " + err, err);
  │  }
  │                                                 ⚠️ 注意 Throwable 也被抓了，
  │                                                    但被包成 ServletException
  ▼
processDispatchResult(request, response, handler, mv, dispatchException)
  │
  └─ processHandlerException(request, response, handler, ex)
       │
       └─ 逐一詢問 HandlerExceptionResolverComposite 裡的 resolver：
          ┌──────────────────────────────────────────────────────────┐
          │ 1. ExceptionHandlerExceptionResolver      order = 0      │
          │    → 找 @ExceptionHandler 方法                            │
          │    → 先找「同一個 Controller 內」的                        │
          │    → 再找 @ControllerAdvice / @RestControllerAdvice        │
          │    ★ 你的程式碼在這裡                                     │
          ├──────────────────────────────────────────────────────────┤
          │ 2. ResponseStatusExceptionResolver        order = 1      │
          │    → 例外類別上有 @ResponseStatus？                        │
          │    → 例外是 ResponseStatusException？                     │
          │    → 用那個狀態碼，body 交給 /error                        │
          ├──────────────────────────────────────────────────────────┤
          │ 3. DefaultHandlerExceptionResolver        order = 2      │
          │    → Spring MVC 內建例外的預設對映                         │
          │      (MethodArgumentNotValidException → 400 等)           │
          └──────────────────────────────────────────────────────────┘
       │
       ├─ 有 resolver 回傳 ModelAndView（可以是空的）→ 結束
       │
       └─ 全部回 null → 例外「重新拋出」
            ↓
          往外傳到 Filter chain（你的 filter 的 catch 可以接到）
            ↓
          Servlet 容器（Tomcat）
            ↓
          容器把請求 forward 到 /error
            ↓
          BasicErrorController → 依 Accept 回 JSON 或 HTML
```

**四個要記住的重點：**

**① `catch (Throwable err)` 的存在很重要。**
`StackOverflowError`、`OutOfMemoryError` 這些 `Error` **會**被 `DispatcherServlet` 抓到，
但被包成 `ServletException`。所以你的 advice 要接 `Exception` 就夠了嗎？

```java
@ExceptionHandler(Exception.class)
public ... handleAny(Exception ex) { }
```

`ServletException` 是 `Exception` 的子類 → **會進來**。
但 `ex.getMessage()` 是 `"Handler dispatch failed: java.lang.StackOverflowError"`，
而 `ex.getCause()` 是那個 `Error`。**處理時要往下鑽**（3.11.4）。

**② `ResponseStatusExceptionResolver` 只設狀態碼，不產生 body。**
它呼叫 `response.sendError(status, reason)`，然後回一個**空的** `ModelAndView`。
`sendError` 會讓容器把請求 forward 到 `/error` →
**body 是 `BasicErrorController` 產生的，不是你的格式**。

這就是為什麼**不能靠 `@ResponseStatus` 做錯誤格式**（3.5.5 會完整討論）。

**③ 這三個 resolver 的順序可以改，但你不需要改。**
你要做的是在第 1 個（`ExceptionHandlerExceptionResolver`）就把所有例外處理掉，
讓第 2、3 個永遠不被呼叫。

**④ 「全部回 null → 重新拋出」是最後的失敗模式。**
它導致 `/error`，而 `/error` 的格式不是你控制的（除非你也接管它，3.8.4）。
**目標是永遠不要走到這裡。**

### 3.3.2 `@RestControllerAdvice` 怎麼被找到

```java
@RestControllerAdvice        // = @ControllerAdvice + @ResponseBody
public class ApiExceptionHandler { }
```

啟動時，`ExceptionHandlerExceptionResolver.afterPropertiesSet()` 做兩件事：

```
1. ControllerAdviceBean.findAnnotatedBeans(applicationContext)
   → 掃描所有 @ControllerAdvice bean
   → 用 AnnotationAwareOrderComparator 排序（@Order / Ordered / @Priority）
   → 為每個 bean 建立一個 ExceptionHandlerMethodResolver
     （裡面是「例外類別 → 方法」的 Map）

2. 執行時，對每個進來的例外：
   a. 先看「拋例外的那個 Controller 類別」裡有沒有 @ExceptionHandler   ← 優先！
   b. 再依序問每個 advice bean
   c. 第一個「有方法能接這個例外」的就贏
```

**兩個重要推論：**

**推論 1：Controller 內的 `@ExceptionHandler` 永遠贏過 advice。**

```java
@RestController
public class OrderController {

    @ExceptionHandler(InsufficientStockException.class)     // ← 這個贏
    public ... handleLocal(InsufficientStockException e) { }
}
```

**這通常是壞事**（格式又分歧了）。
**shop-service 的規則：Controller 裡不准有 `@ExceptionHandler`。**
用 ArchUnit 守住：

```java
@Test
void controller裡不可有ExceptionHandler() {
    JavaClasses classes = new ClassFileImporter().importPackages("example.shop");
    noMethods().that().areDeclaredInClassesThat()
            .areAnnotatedWith(RestController.class)
            .should().beAnnotatedWith(ExceptionHandler.class)
            .because("錯誤格式必須集中在 ApiExceptionHandler")
            .check(classes);
}
```

**推論 2：advice 的順序決定「誰先被問」，而不是「誰更精確」。** ★

這是最容易踩的坑。假設：

```java
@RestControllerAdvice
@Order(1)
public class GenericAdvice {
    @ExceptionHandler(Exception.class)                      // 很通用
    public ... handleAny(Exception e) { }
}

@RestControllerAdvice
@Order(2)
public class BusinessAdvice {
    @ExceptionHandler(InsufficientStockException.class)     // 很精確
    public ... handleStock(InsufficientStockException e) { }
}
```

拋 `InsufficientStockException` 時進哪一個？

**進 `GenericAdvice.handleAny`。**

因為流程是「**逐個 advice 問**，第一個有 handler 的就贏」，
而 `GenericAdvice`（order 1）先被問，它的 `Exception.class` 能接 → 結束。
`BusinessAdvice` 根本沒被問到。

> **「更精確的 handler 贏」只在同一個 advice 類別內成立。**
> 跨 advice 時，**順序贏過精確度**。

**這造成過真實事故**：團隊加了一個 `@RestControllerAdvice`（沒寫 `@Order`）
來處理新模組的例外。沒寫 `@Order` → `Ordered.LOWEST_PRECEDENCE`（最低優先）→
原本的 catch-all advice 先接到 → 新模組的所有業務例外都變成 500。

**shop-service 的做法：只有一個 advice 類別。**
如果真的需要多個（例如把 Security 相關的分開），一律明確寫 `@Order`，
而且 **catch-all（`Exception.class`）必須在最低優先的那個 advice 裡**。

### 3.3.3 同一個 advice 內的方法選擇規則

同一個類別內，`ExceptionHandlerMethodResolver` 用 **`ExceptionDepthComparator`** 選：
**繼承階層上距離最近的贏。**

```java
@ExceptionHandler(BusinessException.class)      public ... a(...) { }   // 父類別
@ExceptionHandler(InsufficientStockException.class) public ... b(...) { }  // 子類別
```

拋 `InsufficientStockException` → **進 `b`**（距離 0，而 `a` 是距離 2）。

**如果兩個 handler 距離相同呢？**

```java
class MyException extends RuntimeException implements Retryable { }

@ExceptionHandler(RuntimeException.class) public ... a(...) { }
@ExceptionHandler(Retryable.class)        public ... b(...) { }     // 不合法，介面不行
```

⚠️ `@ExceptionHandler` 的值必須是 `Throwable` 的子類別，介面不行。

真正的「距離相同」情況是**一個方法宣告多個例外**：

```java
@ExceptionHandler({A.class, B.class})  public ... x(Exception e) { }
@ExceptionHandler(A.class)             public ... y(A e) { }
```

拋 `A` → `y` 贏（更精確）。

**真正的模糊情況會在啟動時失敗**：

```java
@ExceptionHandler(IllegalArgumentException.class) public ... p(...) { }
@ExceptionHandler(IllegalArgumentException.class) public ... q(...) { }
```

```
java.lang.IllegalStateException: Ambiguous @ExceptionHandler method mapped for
[class java.lang.IllegalArgumentException]:
{public ... p(...), public ... q(...)}
```

✅ **快速失敗，很好。**

**還有一個容易忽略的規則：`@ExceptionHandler` 可以不寫值。**

```java
@ExceptionHandler                                 // 從方法參數推斷
public ... handle(InsufficientStockException e) { }
```

**shop-service 的規則：一律寫出值。** 理由和 01 章「一律寫參數名」相同 ——
方法簽章是實作細節，註解的值是宣告。

### 3.3.4 advice 方法能宣告什麼參數與回傳值

**可以宣告的參數**（`ExceptionHandlerExceptionResolver` 支援的 resolver）：

| 參數型別 | 說明 |
|---|---|
| 例外本身（`Exception ex`） | 最常用 |
| `HttpServletRequest` / `HttpServletResponse` | 拿路徑、header |
| `WebRequest` | Spring 的抽象（`ResponseEntityExceptionHandler` 用它） |
| `HandlerMethod` | ★ 拿到「是哪個 Controller 方法出錯」—— 對日誌很有用 |
| `Locale` / `TimeZone` | i18n |
| `java.security.Principal` | 誰在操作 |
| `@RequestHeader` / `@PathVariable`（Spring 6.1+ 部分支援） | ⚠️ 行為依版本而異，不建議依賴 |

⚠️ **不能宣告 `@RequestBody`** —— body 已經被讀掉（或讀失敗）了。
需要原始 body 時要在 Filter 用 `ContentCachingRequestWrapper`（04 章 4.3）。

**可以回傳的東西**：

```java
ResponseEntity<Problem>          // ★ 最推薦：能控制狀態碼與 header
Problem                          // 搭配 @ResponseStatus，狀態碼固定
ProblemDetail                    // Spring 6 內建型別（3.6）
ErrorResponse                    // Spring 6 的介面
void                             // 你自己寫 response（少用）
```

**shop-service 一律回 `ResponseEntity<Problem>`**，因為狀態碼依例外而定，
而且很多錯誤要帶 header（`Retry-After`、`Allow`、`WWW-Authenticate`、`ETag`）。

### 3.3.5 哪些例外進不了 advice ★

**這張表是本章最實用的內容之一。**

| # | 情況 | 為什麼 | 怎麼處理 |
|---|---|---|---|
| 1 | **Filter 裡拋的** | Filter 在 `DispatcherServlet` 外面 | Filter 自己寫 JSON（3.10.1） |
| 2 | **Spring Security 的認證／授權失敗** | 由 `ExceptionTranslationFilter` 處理，也在外面 | `AuthenticationEntryPoint` / `AccessDeniedHandler`（3.10.2） |
| 3 | **回應已經 committed 之後** | header 與部分 body 已送出，改不了狀態碼 | 只能記 log；串流／SSE 要用協定內的錯誤訊號（05 章） |
| 4 | **序列化回應時失敗** | 例如 DTO 有循環參照 → Jackson 拋 → 但可能已寫出部分 JSON | 在 07 章用序列化測試預防 |
| 5 | **`@Async` / 執行緒池裡拋的** | 不在請求執行緒上 | `AsyncUncaughtExceptionHandler`（05-service 第 05 章） |
| 6 | **`afterCompletion` 裡拋的** | 已在 `processDispatchResult` 之後 | interceptor 的 `afterCompletion` 要自己包 try-catch |

**第 2 項有一個非常重要的陷阱** ★：

`@PreAuthorize` 產生的 `AccessDeniedException` 是**在 Controller 方法被呼叫時**拋出的
（method security 是 AOP，在 `DispatcherServlet` 內），
所以它**會**進到你的 advice。

於是如果你寫了：

```java
@ExceptionHandler(Exception.class)
public ResponseEntity<Problem> handleAny(Exception ex) {
    log.error("未預期的錯誤", ex);
    return problem(ErrorCode.INTERNAL_ERROR);      // 500
}
```

**`@PreAuthorize` 失敗會變成 500 而不是 403。** 而且：

- 它會被記成 `error` 等級 → 觸發告警 → 值班工程師被叫起來
- 而實際上那只是「某人打了沒權限的端點」

**修法有兩種：**

**方式 A：明確處理 `AccessDeniedException`（推薦）**

```java
@ExceptionHandler(org.springframework.security.access.AccessDeniedException.class)
public ResponseEntity<Problem> handleAccessDenied(AccessDeniedException ex,
                                                  HttpServletRequest request) {
    return problems.build(ErrorCode.INSUFFICIENT_ROLE, request);   // 403
}
```

**方式 B：重新拋出，讓 Security 的 filter 處理**

```java
@ExceptionHandler(AccessDeniedException.class)
public void rethrow(AccessDeniedException ex) throws AccessDeniedException {
    throw ex;      // 讓它逃到 ExceptionTranslationFilter
}
```

**shop-service 選 A**，理由：格式集中在一個地方，而且能帶 `requiredRole` 擴充欄位。
（B 的好處是與 filter 層的 403 完全一致，但那需要 `AccessDeniedHandler` 也用同一個
`ProblemFactory` —— 3.10.2 會做到這件事，所以 A 和 B 的輸出其實會一樣。）

⚠️ **`AuthenticationException`（401）則幾乎不會進 advice**，
因為認證是在 filter 階段做的。只有「Controller 裡手動呼叫需要認證的東西」才可能。

### 3.3.6 advice 裡拋例外會怎樣

```java
@ExceptionHandler(BusinessException.class)
public ResponseEntity<Problem> handle(BusinessException ex) {
    return problems.build(ex.errorCode(), ...);   // ← 如果這裡拋 NPE 呢？
}
```

**`ExceptionHandlerExceptionResolver` 會 catch 它，記一條 log，然後回 `null`**：

```
WARN o.s.w.s.m.m.a.ExceptionHandlerExceptionResolver -
  Failure in @ExceptionHandler example.shop.common.web.ApiExceptionHandler#handle(...)
java.lang.NullPointerException: ...
```

回 `null` → 下一個 resolver → 最後全部失敗 → 例外重新拋出 → `/error` → **可能是 HTML**。

**所以錯誤處理程式碼本身必須極度防禦性**：

| 規則 | 實作 |
|---|---|
| 不假設例外的欄位非 null | 每個 getter 都 `Objects.requireNonNullElse` |
| 不假設 MDC 有 traceId | `Objects.requireNonNullElse(MDC.get("traceId"), "unknown")` |
| i18n 查不到 key 要有 fallback | `messageSource.getMessage(key, args, defaultMessage, locale)` |
| **一定要有測試** | 3.14 |

> **這是本章反覆出現的主題**：錯誤處理程式碼出錯時**沒有人會發現**，
> 因為它的失敗表現是「錯誤回應變成 HTML」，而那只在真的出錯時才會被看到。

---

## 3.4 錯誤碼註冊表

### 3.4.1 為什麼要一個註冊表

03-rest-api 第 04 章 4.5 定義了約 60 個 `code`。每個 `code` 要綁四件事：

```
code                          → 狀態碼   → type URI                → retryable  → i18n key
INSUFFICIENT_STOCK            → 409     → /problems/insufficient-stock → false  → error.insufficientStock
ORDER_NOT_CANCELLABLE         → 409     → /problems/order-not-cancellable → false → error.orderNotCancellable
RATE_LIMIT_EXCEEDED           → 429     → /problems/rate-limit-exceeded → true   → error.rateLimitExceeded
```

**如果這些關聯散在程式碼裡**（每個 handler 各寫一份），
會發生 03-rest-api 4.13.7 檢核表的第 2 條問題：
**同一個 `code` 在不同地方回不同的狀態碼。**

真實案例：`COUPON_EXPIRED` 在 `POST /orders` 回 422、在 `PUT /carts/current/coupon` 回 400。
前端只針對 422 做特殊處理，於是購物車頁的折扣碼過期沒有提示。

### 3.4.2 用 enum 當註冊表

```java
package example.shop.common.error;

import org.springframework.http.HttpStatus;

/**
 * 錯誤碼註冊表 —— 對外錯誤契約的單一真相。
 *
 * <p>每個 code 綁定：HTTP 狀態碼、Problem type URI 後綴、是否可重試、重試策略。
 * 對應 03-rest-api 第 04 章 4.13 的錯誤目錄。
 *
 * <p>⚠️ 這個 enum 是**對外契約**：
 * <ul>
 *   <li>常數名稱就是 JSON 裡的 {@code code}，改名 = 破壞性變更。</li>
 *   <li>狀態碼改變 = 破壞性變更（客戶端可能用狀態碼分支）。</li>
 *   <li>新增 code 是相容的（客戶端應該有 default 分支）。</li>
 * </ul>
 */
public enum ErrorCode {

    // ── 400 請求格式 ──────────────────────────────────────────────
    MALFORMED_REQUEST      (HttpStatus.BAD_REQUEST,           "malformed-request"),
    UNKNOWN_PARAMETER      (HttpStatus.BAD_REQUEST,           "unknown-parameter"),
    IDEMPOTENCY_KEY_REQUIRED(HttpStatus.BAD_REQUEST,          "idempotency-key-required"),
    INVALID_CURSOR         (HttpStatus.BAD_REQUEST,           "invalid-cursor"),
    MALFORMED_ETAG         (HttpStatus.BAD_REQUEST,           "malformed-etag"),

    // ── 401 認證 ─────────────────────────────────────────────────
    AUTHENTICATION_REQUIRED(HttpStatus.UNAUTHORIZED,          "authentication-required"),
    INVALID_TOKEN          (HttpStatus.UNAUTHORIZED,          "invalid-token"),
    TOKEN_EXPIRED          (HttpStatus.UNAUTHORIZED,          "token-expired",
                            Retry.REFRESH_TOKEN_THEN_RETRY),
    TOKEN_REVOKED          (HttpStatus.UNAUTHORIZED,          "token-revoked"),

    // ── 402 付款 ─────────────────────────────────────────────────
    CARD_DECLINED          (HttpStatus.PAYMENT_REQUIRED,      "card-declined",
                            Retry.MODIFY_REQUEST),
    INSUFFICIENT_FUNDS     (HttpStatus.PAYMENT_REQUIRED,      "insufficient-funds",
                            Retry.MODIFY_REQUEST),
    EXCEEDS_CREDIT_LIMIT   (HttpStatus.PAYMENT_REQUIRED,      "exceeds-credit-limit",
                            Retry.MODIFY_REQUEST),
    PAYMENT_DECLINED       (HttpStatus.PAYMENT_REQUIRED,      "payment-declined"),

    // ── 403 授權 ─────────────────────────────────────────────────
    INSUFFICIENT_ROLE      (HttpStatus.FORBIDDEN,             "insufficient-role"),
    INSUFFICIENT_SCOPE     (HttpStatus.FORBIDDEN,             "insufficient-scope"),
    ACCOUNT_SUSPENDED      (HttpStatus.FORBIDDEN,             "account-suspended"),
    FORBIDDEN_PARAMETER    (HttpStatus.FORBIDDEN,             "forbidden-parameter"),

    // ── 404 ─────────────────────────────────────────────────────
    RESOURCE_NOT_FOUND     (HttpStatus.NOT_FOUND,             "resource-not-found"),
    ENDPOINT_NOT_FOUND     (HttpStatus.NOT_FOUND,             "endpoint-not-found"),
    COUPON_NOT_FOUND       (HttpStatus.NOT_FOUND,             "coupon-not-found"),
    CART_ITEM_NOT_FOUND    (HttpStatus.NOT_FOUND,             "cart-item-not-found"),

    // ── 405 / 406 / 415 ────────────────────────────────────────
    METHOD_NOT_ALLOWED     (HttpStatus.METHOD_NOT_ALLOWED,    "method-not-allowed"),
    NOT_ACCEPTABLE         (HttpStatus.NOT_ACCEPTABLE,        "not-acceptable"),
    UNSUPPORTED_MEDIA_TYPE (HttpStatus.UNSUPPORTED_MEDIA_TYPE,"unsupported-media-type"),

    // ── 409 狀態衝突 ────────────────────────────────────────────
    ORDER_NOT_CANCELLABLE  (HttpStatus.CONFLICT,              "order-not-cancellable"),
    ORDER_ALREADY_PAID     (HttpStatus.CONFLICT,              "order-already-paid"),
    ORDER_ALREADY_CANCELLED(HttpStatus.CONFLICT,              "order-already-cancelled"),
    ORDER_EXPIRED          (HttpStatus.CONFLICT,              "order-expired"),
    ORDER_NOT_SHIPPABLE    (HttpStatus.CONFLICT,              "order-not-shippable"),
    ORDER_NOT_RETURNABLE   (HttpStatus.CONFLICT,              "order-not-returnable"),
    ORDER_ITEM_IMMUTABLE   (HttpStatus.CONFLICT,              "order-item-immutable"),
    ORDER_ADDRESS_NOT_EDITABLE(HttpStatus.CONFLICT,           "order-address-not-editable"),
    INSUFFICIENT_STOCK     (HttpStatus.CONFLICT,              "insufficient-stock",
                            Retry.MODIFY_REQUEST),
    NEGATIVE_STOCK_NOT_ALLOWED(HttpStatus.CONFLICT,           "negative-stock-not-allowed"),
    PRODUCT_SKU_DUPLICATE  (HttpStatus.CONFLICT,              "product-sku-duplicate"),
    COUPON_EXHAUSTED       (HttpStatus.CONFLICT,              "coupon-exhausted"),
    COUPON_ALREADY_USED    (HttpStatus.CONFLICT,              "coupon-already-used"),
    IDEMPOTENCY_KEY_REUSED (HttpStatus.CONFLICT,              "idempotency-key-reused"),
    PAYMENT_ALREADY_IN_PROGRESS(HttpStatus.CONFLICT,          "payment-already-in-progress",
                            Retry.CHECK_STATUS),
    PAYMENT_NOT_REFUNDABLE (HttpStatus.CONFLICT,              "payment-not-refundable"),
    REFUND_WINDOW_EXPIRED  (HttpStatus.CONFLICT,              "refund-window-expired"),
    EMAIL_ALREADY_REGISTERED(HttpStatus.CONFLICT,             "email-already-registered"),

    // ── 410 ─────────────────────────────────────────────────────
    RESOURCE_GONE          (HttpStatus.GONE,                  "resource-gone"),
    PRODUCT_DISCONTINUED   (HttpStatus.GONE,                  "product-discontinued"),

    // ── 412 / 428 條件請求 ──────────────────────────────────────
    OPTIMISTIC_LOCK_CONFLICT(HttpStatus.PRECONDITION_FAILED,  "version-conflict",
                            Retry.REFETCH_THEN_RETRY),
    IF_MATCH_REQUIRED      (HttpStatus.PRECONDITION_REQUIRED, "if-match-required"),

    // ── 413 ─────────────────────────────────────────────────────
    PAYLOAD_TOO_LARGE      (HttpStatus.PAYLOAD_TOO_LARGE,     "payload-too-large"),

    // ── 422 語意錯誤 ────────────────────────────────────────────
    VALIDATION_FAILED      (HttpStatus.UNPROCESSABLE_ENTITY,  "validation-failed"),
    ORDER_EMPTY            (HttpStatus.UNPROCESSABLE_ENTITY,  "order-empty"),
    ORDER_ITEM_LIMIT_EXCEEDED(HttpStatus.UNPROCESSABLE_ENTITY,"order-item-limit-exceeded"),
    ORDER_AMOUNT_MISMATCH  (HttpStatus.UNPROCESSABLE_ENTITY,  "order-amount-mismatch",
                            Retry.REFETCH_THEN_RETRY),
    PRODUCT_NOT_FOUND      (HttpStatus.UNPROCESSABLE_ENTITY,  "product-not-found"),
    PRODUCT_NOT_PURCHASABLE(HttpStatus.UNPROCESSABLE_ENTITY,  "product-not-purchasable"),
    PURCHASE_LIMIT_EXCEEDED(HttpStatus.UNPROCESSABLE_ENTITY,  "purchase-limit-exceeded"),
    CARD_NUMBER_INVALID    (HttpStatus.UNPROCESSABLE_ENTITY,  "card-number-invalid"),
    CARD_EXPIRED           (HttpStatus.UNPROCESSABLE_ENTITY,  "card-expired"),
    CVV_INVALID            (HttpStatus.UNPROCESSABLE_ENTITY,  "cvv-invalid"),
    PAYMENT_METHOD_UNSUPPORTED(HttpStatus.UNPROCESSABLE_ENTITY,"payment-method-unsupported"),
    REFUND_EXCEEDS_PAYMENT (HttpStatus.UNPROCESSABLE_ENTITY,  "refund-exceeds-payment"),
    COUPON_EXPIRED         (HttpStatus.UNPROCESSABLE_ENTITY,  "coupon-expired"),
    COUPON_NOT_STARTED     (HttpStatus.UNPROCESSABLE_ENTITY,  "coupon-not-started"),
    COUPON_MIN_AMOUNT_NOT_MET(HttpStatus.UNPROCESSABLE_ENTITY,"coupon-min-amount-not-met"),
    COUPON_NOT_APPLICABLE  (HttpStatus.UNPROCESSABLE_ENTITY,  "coupon-not-applicable"),
    CART_EMPTY             (HttpStatus.UNPROCESSABLE_ENTITY,  "cart-empty"),
    RETURN_ITEM_NOT_IN_ORDER(HttpStatus.UNPROCESSABLE_ENTITY, "return-item-not-in-order"),
    RETURN_QUANTITY_EXCEEDED(HttpStatus.UNPROCESSABLE_ENTITY, "return-quantity-exceeded"),
    UNDELIVERABLE_ADDRESS  (HttpStatus.UNPROCESSABLE_ENTITY,  "undeliverable-address"),
    PHOTO_NOT_FOUND        (HttpStatus.UNPROCESSABLE_ENTITY,  "photo-not-found"),
    DEEP_PAGINATION_LIMIT  (HttpStatus.UNPROCESSABLE_ENTITY,  "deep-pagination-limit"),

    // ── 429 ─────────────────────────────────────────────────────
    RATE_LIMIT_EXCEEDED    (HttpStatus.TOO_MANY_REQUESTS,     "rate-limit-exceeded",
                            Retry.BACKOFF_AND_RETRY),
    ADDRESS_CHANGE_LIMIT_EXCEEDED(HttpStatus.TOO_MANY_REQUESTS,"address-change-limit-exceeded",
                            Retry.BACKOFF_AND_RETRY),

    // ── 5xx ─────────────────────────────────────────────────────
    INTERNAL_ERROR         (HttpStatus.INTERNAL_SERVER_ERROR, "internal-error"),
    UPSTREAM_ERROR         (HttpStatus.BAD_GATEWAY,           "upstream-error",
                            Retry.BACKOFF_AND_RETRY),
    SERVICE_UNAVAILABLE    (HttpStatus.SERVICE_UNAVAILABLE,   "service-unavailable",
                            Retry.BACKOFF_AND_RETRY),
    PAYMENT_GATEWAY_UNAVAILABLE(HttpStatus.SERVICE_UNAVAILABLE,"payment-gateway-unavailable",
                            Retry.BACKOFF_AND_RETRY),
    UPSTREAM_TIMEOUT       (HttpStatus.GATEWAY_TIMEOUT,       "upstream-timeout",
                            Retry.CHECK_STATUS),
    PAYMENT_GATEWAY_TIMEOUT(HttpStatus.GATEWAY_TIMEOUT,       "payment-gateway-timeout",
                            Retry.CHECK_STATUS),
    PAYMENT_OUTCOME_UNKNOWN(HttpStatus.GATEWAY_TIMEOUT,       "payment-outcome-unknown",
                            Retry.CHECK_STATUS),
    REQUEST_TIMEOUT        (HttpStatus.SERVICE_UNAVAILABLE,   "request-timeout",
                            Retry.BACKOFF_AND_RETRY);

    /** 重試策略（03-rest-api 第 04 章 4.9）。 */
    public enum Retry {
        /** 不可重試。 */
        NONE,
        /** 修改請求內容後再送（例如減少數量、換付款方式）。 */
        MODIFY_REQUEST,
        /** 重新取得資源再送（樂觀鎖衝突、金額變動）。 */
        REFETCH_THEN_RETRY,
        /** 指數退避後重試（限流、上游暫時異常）。 */
        BACKOFF_AND_RETRY,
        /** 先查詢結果狀態，不要盲目重試（付款結果未知）。 */
        CHECK_STATUS,
        /** 刷新 token 後重試。 */
        REFRESH_TOKEN_THEN_RETRY
    }

    private final HttpStatus status;
    private final String typeSlug;
    private final Retry retry;

    ErrorCode(HttpStatus status, String typeSlug) {
        this(status, typeSlug, Retry.NONE);
    }

    ErrorCode(HttpStatus status, String typeSlug, Retry retry) {
        this.status = status;
        this.typeSlug = typeSlug;
        this.retry = retry;
    }

    public HttpStatus status()  { return status; }
    public String typeSlug()    { return typeSlug; }
    public Retry retry()        { return retry; }

    /** 客戶端可重試（不代表一定成功，代表「重試在語意上是安全的」）。 */
    public boolean retryable()  { return retry != Retry.NONE; }

    /** i18n key：title 用 `error.<code>.title`、userMessage 用 `error.<code>.user`。 */
    public String titleKey()       { return "error." + name() + ".title"; }
    public String userMessageKey() { return "error." + name() + ".user"; }

    /** 5xx 判斷 —— 決定日誌等級與是否告警（3.12）。 */
    public boolean isServerError() { return status.is5xxServerError(); }
}
```

**這個 enum 有 78 個常數，看起來很長。但它取代的是**：

- 78 個「這個例外該回什麼狀態碼」的判斷散在 handler 裡。
- 78 個 `type` URI 字串字面值。
- 78 個 `retryable` 的布林值。
- 以及最重要的：**一份可以被測試的清單**。

### 3.4.3 為什麼用 enum 而不是別的

| 方案 | 問題 |
|---|---|
| **字串常數 + `Map`** | 打錯字不會編譯錯誤；`Map` 可能查不到（回 `null` → NPE） |
| **YAML 設定檔** | 沒有型別安全；改設定不用重新編譯 = 沒有 code review 保護 |
| **每個例外自己帶狀態碼** | 同一個 `code` 在不同例外裡可能不一致（3.4.1 的問題） |
| **`enum`** ✅ | 編譯期檢查、`switch` 可窮盡、可以寫測試遍歷所有值 |

**enum 的關鍵優勢是「可以遍歷」**：

```java
for (ErrorCode code : ErrorCode.values()) { ... }
```

這讓 3.4.5 的一致性測試變得可能。

⚠️ **enum 的一個代價**：新增 `code` 要改 Java 檔並重新部署。
如果你的錯誤碼會被非工程師新增（例如營運要加一種拒絕原因），
那就需要「enum 定骨架 + 資料庫存明細」的混合方案。
**shop-service 不需要**（錯誤碼是工程契約，本來就該經過 code review）。

### 3.4.4 錯誤訊息的 i18n

```properties
# src/main/resources/error-messages_zh_TW.properties

# ── 格式：error.<CODE>.title / error.<CODE>.user ──────────────
# title = 錯誤類型（固定，給人看的標題）
# user  = userMessage（給終端使用者，可帶參數，可隨時改文案）

error.MALFORMED_REQUEST.title=請求格式錯誤
error.MALFORMED_REQUEST.user=資料格式有誤，請重新整理頁面後再試。

error.VALIDATION_FAILED.title=請求內容驗證失敗
error.VALIDATION_FAILED.user=請檢查標示紅色的欄位。

error.UNKNOWN_PARAMETER.title=未知的查詢參數
error.UNKNOWN_PARAMETER.user=查詢條件有誤，請重新整理頁面後再試。

error.AUTHENTICATION_REQUIRED.title=需要登入
error.AUTHENTICATION_REQUIRED.user=請先登入後再繼續。

error.TOKEN_EXPIRED.title=憑證已過期
error.TOKEN_EXPIRED.user=登入已逾時，正在重新驗證…

error.INSUFFICIENT_ROLE.title=權限不足
error.INSUFFICIENT_ROLE.user=您沒有執行此操作的權限。如需協助請聯絡管理員。

error.RESOURCE_NOT_FOUND.title=資源不存在
error.RESOURCE_NOT_FOUND.user=找不到您要查看的資料，它可能已被移除。

error.ENDPOINT_NOT_FOUND.title=端點不存在
error.ENDPOINT_NOT_FOUND.user=請求的位址不存在，請確認網址是否正確。

error.METHOD_NOT_ALLOWED.title=不支援此方法
error.METHOD_NOT_ALLOWED.user=操作方式有誤，請重新整理頁面後再試。

error.UNSUPPORTED_MEDIA_TYPE.title=不支援的內容類型
error.UNSUPPORTED_MEDIA_TYPE.user=資料格式有誤，請重新整理頁面後再試。

# ── 訂單 ─────────────────────────────────────────────────────
error.ORDER_NOT_CANCELLABLE.title=訂單無法取消
error.ORDER_NOT_CANCELLABLE.user=此訂單已{0}，無法取消。如需協助請聯絡客服。

error.ORDER_ALREADY_PAID.title=訂單已付款
error.ORDER_ALREADY_PAID.user=此訂單已完成付款。

error.ORDER_ALREADY_CANCELLED.title=訂單已取消
error.ORDER_ALREADY_CANCELLED.user=此訂單已於 {0} 取消。

error.ORDER_EXPIRED.title=訂單已逾時
error.ORDER_EXPIRED.user=此訂單因超過付款期限已自動取消，請重新下單。

error.ORDER_NOT_RETURNABLE.title=訂單無法退貨
error.ORDER_NOT_RETURNABLE.user=已超過 7 天退貨期限（{0}）。

error.ORDER_EMPTY.title=訂單無商品
error.ORDER_EMPTY.user=請至少選擇一項商品。

error.ORDER_AMOUNT_MISMATCH.title=金額不符
error.ORDER_AMOUNT_MISMATCH.user=訂單金額已變動，請重新確認後再結帳。

error.ORDER_ADDRESS_NOT_EDITABLE.title=訂單地址無法修改
error.ORDER_ADDRESS_NOT_EDITABLE.user=此訂單已{0}，無法修改收件地址。

# ── 商品與庫存 ────────────────────────────────────────────────
error.INSUFFICIENT_STOCK.title=庫存不足
error.INSUFFICIENT_STOCK.user=「{0}」僅剩 {1} 件，請調整數量後再結帳。

error.PRODUCT_NOT_FOUND.title=商品不存在
error.PRODUCT_NOT_FOUND.user=部分商品已不存在，請重新選購。

error.PRODUCT_DISCONTINUED.title=商品已下架
error.PRODUCT_DISCONTINUED.user=「{0}」已下架。{1}

error.PURCHASE_LIMIT_EXCEEDED.title=超過購買限制
error.PURCHASE_LIMIT_EXCEEDED.user=此商品每人限購 {0} 件，您已購買 {1} 件。

# ── 付款 ─────────────────────────────────────────────────────
error.CARD_DECLINED.title=卡片被拒絕
error.CARD_DECLINED.user=您的卡片被發卡銀行拒絕，請改用其他付款方式或聯絡銀行。

error.INSUFFICIENT_FUNDS.title=餘額不足
error.INSUFFICIENT_FUNDS.user=您的卡片餘額不足，請改用其他付款方式。

error.CARD_EXPIRED.title=卡片已過期
error.CARD_EXPIRED.user=卡片已過期，請使用其他卡片。

error.PAYMENT_DECLINED.title=交易無法完成
error.PAYMENT_DECLINED.user=此筆交易目前無法完成，請改用其他付款方式或稍後再試。

error.PAYMENT_ALREADY_IN_PROGRESS.title=已有付款正在處理
error.PAYMENT_ALREADY_IN_PROGRESS.user=此訂單已有付款正在處理中，請稍候並重新整理頁面。

error.PAYMENT_OUTCOME_UNKNOWN.title=付款結果未知
error.PAYMENT_OUTCOME_UNKNOWN.user=付款結果尚未確認，請勿重複付款。我們會在 1 分鐘內更新狀態。

error.PAYMENT_GATEWAY_UNAVAILABLE.title=金流服務維護中
error.PAYMENT_GATEWAY_UNAVAILABLE.user=付款服務維護中，預計 {0} 恢復。您的訂單已保留，稍後可繼續付款。

# ── 折扣碼 ───────────────────────────────────────────────────
error.COUPON_NOT_FOUND.title=折扣碼不存在
error.COUPON_NOT_FOUND.user=折扣碼「{0}」不存在，請確認後重新輸入。

error.COUPON_EXPIRED.title=折扣碼已過期
error.COUPON_EXPIRED.user=此折扣碼已於 {0} 過期。

error.COUPON_ALREADY_USED.title=折扣碼已使用
error.COUPON_ALREADY_USED.user=您已使用過此折扣碼。

error.COUPON_MIN_AMOUNT_NOT_MET.title=未達最低消費
error.COUPON_MIN_AMOUNT_NOT_MET.user=此折扣碼需消費滿 {0} 元，目前為 {1} 元。

# ── 條件請求與冪等 ────────────────────────────────────────────
error.OPTIMISTIC_LOCK_CONFLICT.title=資料已被其他人修改
error.OPTIMISTIC_LOCK_CONFLICT.user=此資料已被其他人修改，請重新載入後再試。

error.IF_MATCH_REQUIRED.title=必須帶 If-Match
error.IF_MATCH_REQUIRED.user=操作方式有誤，請重新整理頁面後再試。

error.IDEMPOTENCY_KEY_REQUIRED.title=缺少冪等鍵
error.IDEMPOTENCY_KEY_REQUIRED.user=請求缺少必要資訊，請重新整理頁面後再試。

error.IDEMPOTENCY_KEY_REUSED.title=冪等鍵被用於不同的請求
error.IDEMPOTENCY_KEY_REUSED.user=偵測到重複的請求，請重新整理頁面後再試。

# ── 限流與分頁 ────────────────────────────────────────────────
error.RATE_LIMIT_EXCEEDED.title=請求過於頻繁
error.RATE_LIMIT_EXCEEDED.user=操作過於頻繁，請 {0} 秒後再試。

error.DEEP_PAGINATION_LIMIT.title=查詢範圍過深
error.DEEP_PAGINATION_LIMIT.user=資料量過大，請縮小查詢條件或使用匯出功能。

error.PAYLOAD_TOO_LARGE.title=請求內容過大
error.PAYLOAD_TOO_LARGE.user=上傳的內容過大（上限 {0}），請縮小後再試。

# ── 5xx（★ 一律固定文字，不含任何內部資訊）───────────────────
error.INTERNAL_ERROR.title=系統錯誤
error.INTERNAL_ERROR.user=系統暫時發生問題，請稍後再試。若持續發生，請聯絡客服並提供追蹤碼 {0}。

error.UPSTREAM_ERROR.title=上游服務異常
error.UPSTREAM_ERROR.user=服務暫時無法使用，請稍後再試。

error.SERVICE_UNAVAILABLE.title=服務暫時無法使用
error.SERVICE_UNAVAILABLE.user=服務暫時無法使用，請 {0} 秒後再試。

error.UPSTREAM_TIMEOUT.title=上游服務超時
error.UPSTREAM_TIMEOUT.user=處理時間過長，請稍後查詢結果，請勿重複送出。

error.REQUEST_TIMEOUT.title=處理逾時
error.REQUEST_TIMEOUT.user=處理時間過長，請稍後再試。
```

⚠️ **注意 `{0}`、`{1}` 是 Spring `MessageSource` 的參數語法**（`MessageFormat`），
和 02 章 Bean Validation 的 `{min}` **是不同的機制**。
Bean Validation 用命名參數，`MessageSource` 用位置參數。

⚠️ **`MessageFormat` 的兩個坑**：

1. **單引號是轉義字元。** `error.x.user=別擔心，這不會'影響'訂單` 會變成
   `別擔心，這不會影響訂單`（引號消失）。要顯示單引號得寫 `''`。
   而且**只有在該訊息有參數時**才會走 `MessageFormat` 解析 —— 
   所以「加了參數之後單引號突然消失」是一個很難查的 bug。
2. **數字會被格式化。** `{0}` 傳 `1000` 會變成 `1,000`（依 locale 加千分位）。
   金額通常想要這個，但「秒數」不想要（`1,000 秒`很怪）。
   要避免就用 `{0,number,#}`。

### 3.4.5 註冊表的一致性測試 ★

**這是本節最重要的產出。** 它把 03-rest-api 4.13.7 的檢核表變成會失敗的測試。

```java
package example.shop.common.error;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.MessageSource;
import org.springframework.context.NoSuchMessageException;

import java.util.*;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest
class ErrorCodeRegistryTest {

    @Autowired MessageSource messageSource;

    private static final Locale ZH_TW = Locale.forLanguageTag("zh-TW");

    @Test
    @DisplayName("每個 code 都有唯一的 type slug")
    void typeSlug唯一() {
        Map<String, List<String>> bySlug = new LinkedHashMap<>();
        for (ErrorCode c : ErrorCode.values()) {
            bySlug.computeIfAbsent(c.typeSlug(), k -> new ArrayList<>()).add(c.name());
        }
        var duplicates = bySlug.entrySet().stream()
                .filter(e -> e.getValue().size() > 1).toList();

        assertThat(duplicates)
                .as("type URI 必須唯一，否則客戶端無法用它區分錯誤")
                .isEmpty();
    }

    @Test
    @DisplayName("code 名稱必須是 UPPER_SNAKE_CASE")
    void 命名規範() {
        var pattern = Pattern.compile("^[A-Z][A-Z0-9_]*$");
        for (ErrorCode c : ErrorCode.values()) {
            assertThat(c.name()).matches(pattern);
        }
    }

    @Test
    @DisplayName("type slug 必須是 kebab-case")
    void slug命名規範() {
        var pattern = Pattern.compile("^[a-z][a-z0-9-]*$");
        for (ErrorCode c : ErrorCode.values()) {
            assertThat(c.typeSlug()).as("code=%s", c.name()).matches(pattern);
        }
    }

    @Test
    @DisplayName("每個 code 都有 title 與 userMessage 的中文訊息")
    void 訊息完整() {
        List<String> missing = new ArrayList<>();
        for (ErrorCode c : ErrorCode.values()) {
            missing.addAll(checkKey(c.titleKey()));
            missing.addAll(checkKey(c.userMessageKey()));
        }
        assertThat(missing)
                .as("以下 i18n key 缺少 zh-TW 訊息，會讓使用者看到 key 原文")
                .isEmpty();
    }

    private List<String> checkKey(String key) {
        try {
            String msg = messageSource.getMessage(key, new Object[]{"X", "Y", "Z"}, ZH_TW);
            if (msg == null || msg.isBlank() || msg.equals(key)) return List.of(key);
            return List.of();
        } catch (NoSuchMessageException e) {
            return List.of(key);
        }
    }

    @Test
    @DisplayName("5xx 的 code 不可標成 retryable=false 以外的誤導狀態")
    void 重試策略合理() {
        for (ErrorCode c : ErrorCode.values()) {
            if (c.status().value() == 429) {
                assertThat(c.retry())
                        .as("%s 是 429，必須是 BACKOFF_AND_RETRY", c.name())
                        .isEqualTo(ErrorCode.Retry.BACKOFF_AND_RETRY);
            }
            if (c.status().value() == 412) {
                assertThat(c.retry())
                        .as("%s 是 412（樂觀鎖），必須是 REFETCH_THEN_RETRY", c.name())
                        .isEqualTo(ErrorCode.Retry.REFETCH_THEN_RETRY);
            }
            if (c.status().value() == 504) {
                assertThat(c.retry())
                        .as("%s 是 504（結果未知），必須是 CHECK_STATUS 而非盲目重試", c.name())
                        .isEqualTo(ErrorCode.Retry.CHECK_STATUS);
            }
        }
    }

    @Test
    @DisplayName("4xx 不可被標為 retryable，除了 429 / 412 / 401")
    void 四xx的重試語意() {
        var allowedRetryable4xx = Set.of(401, 402, 409, 412, 422, 429);
        for (ErrorCode c : ErrorCode.values()) {
            if (c.status().is4xxClientError() && c.retryable()) {
                assertThat(c.status().value())
                        .as("%s 是 %d 卻標為可重試 —— 客戶端盲目重試會一直失敗",
                            c.name(), c.status().value())
                        .isIn(allowedRetryable4xx);
            }
        }
    }

    @Test
    @DisplayName("錯誤碼總數應在客戶端可窮舉的範圍內（< 100）")
    void 數量在合理範圍() {
        assertThat(ErrorCode.values().length)
                .as("錯誤碼太多會讓客戶端無法逐一處理（03-rest-api 4.13.7）")
                .isLessThan(100);
    }

    @Test
    @DisplayName("5xx 的 userMessage 不可包含任何內部術語")
    void 五xx訊息不洩漏() {
        var forbidden = List.of("SQL", "sql", "exception", "Exception", "null",
                                "stack", "table", "column", "connection refused",
                                "timeout after", "jdbc", "hibernate");
        for (ErrorCode c : ErrorCode.values()) {
            if (!c.isServerError()) continue;
            String msg = messageSource.getMessage(
                    c.userMessageKey(), new Object[]{"X"}, ZH_TW);
            for (String word : forbidden) {
                assertThat(msg)
                        .as("%s 的 userMessage 含內部術語「%s」", c.name(), word)
                        .doesNotContain(word);
            }
        }
    }
}
```

**`checkKey` 傳 `new Object[]{"X","Y","Z"}` 的用意**：
訊息裡的 `{0}`、`{1}` 需要參數才能插值。
傳三個假值可以驗證「訊息能被 `MessageFormat` 解析」——
如果訊息裡有 `{3}` 但我們只傳三個參數，`MessageFormat` 會原樣輸出 `{3}`
（不會拋例外），所以這個測試抓不到「參數數量不對」。

**要抓那個，加一個測試**：

```java
@Test
@DisplayName("訊息插值後不可留下未替換的 {n}")
void 訊息參數數量正確() {
    var leftover = Pattern.compile("\\{\\d+");
    List<String> bad = new ArrayList<>();
    for (ErrorCode c : ErrorCode.values()) {
        // 傳 6 個參數，足以覆蓋所有訊息
        String msg = messageSource.getMessage(c.userMessageKey(),
                new Object[]{"a","b","c","d","e","f"}, ZH_TW);
        if (leftover.matcher(msg).find()) bad.add(c.name() + " → " + msg);
    }
    assertThat(bad).as("以下訊息的參數超過 6 個，或格式錯誤").isEmpty();
}
```

⚠️ **反過來的問題（訊息只用了 `{0}` 但呼叫端傳了 3 個參數）沒有辦法自動抓**，
因為 `MessageFormat` 會靜默忽略多餘的參數。
**這個只能靠 3.14 的端到端測試檢查實際輸出。**

---

## 3.5 領域例外的分層設計

### 3.5.1 三層例外結構

```
RuntimeException
  │
  ├── BusinessException（抽象基底）           ← 「已預期的失敗」
  │     · 帶一個 ErrorCode
  │     · 帶擴充欄位（Map<String,Object>）
  │     · 帶 userMessage 的參數
  │     ├── ResourceNotFoundException
  │     ├── ValidationFailedException
  │     ├── OrderNotCancellableException
  │     ├── InsufficientStockException
  │     ├── CouponExpiredException
  │     └── …（每個領域一組）
  │
  └── 其他 RuntimeException                    ← 「未預期的失敗」= bug
        · NullPointerException
        · IllegalStateException
        · DataAccessException
        → 全部變 500 INTERNAL_ERROR，記 error log，觸發告警
```

**這個二分法是整章的骨架**：

| | 已預期（`BusinessException`） | 未預期（其他） |
|---|---|---|
| 狀態碼 | 由 `ErrorCode` 決定（4xx 為主） | 500 |
| `code` | 精確的業務碼 | `INTERNAL_ERROR` |
| `detail` | 描述具體情況（可含業務資料） | **固定文字** |
| 日誌等級 | `warn`（不印 stack trace） | `error`（印完整 stack trace） |
| 告警 | ❌ 不告警 | ✅ 告警 |
| 客戶端該做什麼 | 依 `retryStrategy` 處理 | 顯示通用訊息 + 上報 |

**「未預期」出現在監控上就代表有 bug 要修。**
這是為什麼「把系統錯誤標成 4xx」會毀掉監控（03-rest-api 第 04 章 4.12）。

### 3.5.2 `BusinessException` 基底

```java
package example.shop.common.error;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 已預期的業務失敗。
 *
 * <p>特徵：
 * <ul>
 *   <li>攜帶 {@link ErrorCode}，由它決定 HTTP 狀態碼與 type URI。</li>
 *   <li>攜帶「擴充欄位」——會被平鋪到 Problem JSON 的最上層（03-rest-api 4.4.3）。</li>
 *   <li>攜帶 userMessage 的插值參數。</li>
 *   <li>可選地攜帶欄位級錯誤（{@code errors[]}），讓 422 能定位到欄位。</li>
 *   <li>{@code detail} 一律英文（給開發者），{@code userMessage} 走 i18n（給使用者）。</li>
 * </ul>
 *
 * <p>⚠️ 這個類別在 {@code common.error} 而不是 {@code common.web}：
 * 它是 Service 層拋的，不該認識 HTTP。
 * 「{@link ErrorCode} 裡有 HttpStatus」是一個刻意的妥協，見 3.5.6。
 */
public abstract class BusinessException extends RuntimeException {

    private final ErrorCode errorCode;
    private final Map<String, Object> extensions;
    private final Object[] userMessageArgs;
    private final List<FieldViolation> fieldViolations;

    protected BusinessException(ErrorCode errorCode, String detail) {
        this(errorCode, detail, null, Map.of(), new Object[0], List.of());
    }

    protected BusinessException(ErrorCode errorCode, String detail,
                                Object... userMessageArgs) {
        this(errorCode, detail, null, Map.of(), userMessageArgs, List.of());
    }

    protected BusinessException(ErrorCode errorCode,
                                String detail,
                                Throwable cause,
                                Map<String, Object> extensions,
                                Object[] userMessageArgs,
                                List<FieldViolation> fieldViolations) {
        // ★ writableStackTrace = false：業務例外不需要 stack trace
        //   填 stack trace 是這類例外最大的成本（見 3.5.4）
        super(detail, cause, /*enableSuppression*/ true, /*writableStackTrace*/ false);
        this.errorCode = errorCode;
        this.extensions = (extensions == null) ? Map.of()
                : Collections.unmodifiableMap(new LinkedHashMap<>(extensions));
        this.userMessageArgs = (userMessageArgs == null) ? new Object[0] : userMessageArgs;
        this.fieldViolations = (fieldViolations == null) ? List.of() : List.copyOf(fieldViolations);
    }

    public ErrorCode errorCode()              { return errorCode; }
    public Map<String, Object> extensions()   { return extensions; }
    public Object[] userMessageArgs()         { return userMessageArgs; }
    public List<FieldViolation> fieldViolations() { return fieldViolations; }

    /** 建構擴充欄位的小工具，讓子類別讀起來乾淨。 */
    protected static Map<String, Object> ext(Object... keyValues) {
        if (keyValues.length % 2 != 0) {
            throw new IllegalArgumentException("ext() 需要成對的 key/value");
        }
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < keyValues.length; i += 2) {
            Object value = keyValues[i + 1];
            if (value != null) {                      // ★ null 值直接省略，不進 JSON
                m.put((String) keyValues[i], value);
            }
        }
        return m;
    }
}
```

```java
package example.shop.common.error;

/** 欄位級的錯誤（給 422 的 errors[] 用，格式與 02 章的 FieldErrorDto 一致）。 */
public record FieldViolation(
    String field,
    String code,
    String message,
    Object rejectedValue,
    java.util.Map<String, Object> constraint
) {
    public static FieldViolation of(String field, String code, String message) {
        return new FieldViolation(field, code, message, null, null);
    }
    public static FieldViolation of(String field, String code, String message,
                                    Object rejectedValue) {
        return new FieldViolation(field, code, message, rejectedValue, null);
    }
}
```

### 3.5.3 具體例外：三個代表性例子

**例子 1：`InsufficientStockException`** —— 帶擴充欄位 + 欄位級錯誤

```java
package example.shop.order.service.exception;

import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;
import example.shop.common.error.FieldViolation;

import java.time.LocalDate;
import java.util.List;

/** 庫存不足。對照 03-rest-api 第 04 章 4.13.6 範例 2。 */
public class InsufficientStockException extends BusinessException {

    public InsufficientStockException(String productId, String productName,
                                      int requested, int available,
                                      LocalDate restockEstimatedAt,
                                      Integer itemIndex) {
        super(ErrorCode.INSUFFICIENT_STOCK,
              // detail：英文、給開發者、可含業務資料
              "Product %s has %d units available but %d were requested%s."
                      .formatted(productId, available, requested,
                                 itemIndex == null ? "" : " in items[" + itemIndex + "]"),
              null,
              // extensions：平鋪到 Problem JSON 最上層
              ext("productId", productId,
                  "productName", productName,
                  "requested", requested,
                  "available", available,
                  "restockEstimatedAt", restockEstimatedAt),
              // userMessage 的插值參數：{0}=商品名、{1}=剩餘數
              new Object[]{productName, available},
              // errors[]：讓前端能標紅那一列的數量欄位
              itemIndex == null ? List.of() : List.of(
                  new FieldViolation(
                      "items[" + itemIndex + "].quantity",
                      "INSUFFICIENT_STOCK",
                      "僅剩 " + available + " 件",
                      requested,
                      java.util.Map.of("available", available))));
    }
}
```

**輸出**（對照 3.2.3 的目標）：

```jsonc
{
  "type": "https://api.shop.example/problems/insufficient-stock",
  "title": "庫存不足",
  "status": 409,
  "detail": "Product P-1001 has 3 units available but 5 were requested in items[2].",
  "instance": "/orders",
  "code": "INSUFFICIENT_STOCK",
  "userMessage": "「無線降噪耳機 Pro」僅剩 3 件，請調整數量後再結帳。",
  "errors": [
    { "field": "items[2].quantity", "code": "INSUFFICIENT_STOCK",
      "message": "僅剩 3 件", "rejectedValue": 5, "constraint": { "available": 3 } }
  ],
  "productId": "P-1001",
  "productName": "無線降噪耳機 Pro",
  "requested": 5,
  "available": 3,
  "restockEstimatedAt": "2026-08-22",
  "retryable": false,
  "retryStrategy": "MODIFY_REQUEST",
  "traceId": "4f2c8a1e9b7d3f60",
  "timestamp": "2026-08-20T06:12:44Z"
}
```

**例子 2：`OrderNotCancellableException`** —— 帶 `alternativeAction`

```java
package example.shop.order.service.exception;

import example.shop.common.error.AlternativeAction;
import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;
import example.shop.order.domain.OrderStatus;

import java.time.LocalDate;
import java.util.Set;

public class OrderNotCancellableException extends BusinessException {

    public OrderNotCancellableException(String orderId, String orderNumber,
                                        OrderStatus current,
                                        Set<OrderStatus> cancellable,
                                        LocalDate returnableUntil) {
        super(ErrorCode.ORDER_NOT_CANCELLABLE,
              "Order %s is in %s state; cancellable states are %s."
                      .formatted(orderNumber, current,
                                 cancellable.stream().map(Enum::name).sorted().toList()),
              null,
              ext("orderNumber", orderNumber,
                  "currentStatus", current.name(),
                  "currentStatusLabel", current.label(),
                  "cancellableStatuses", cancellable.stream()
                          .map(Enum::name).sorted().toList(),
                  // ★ 「不能做 A，但可以做 B」—— 03-rest-api 4.13.6 的高價值欄位
                  "alternativeAction", buildAlternative(orderId, current, returnableUntil)),
              new Object[]{current.label()},
              java.util.List.of());
    }

    private static AlternativeAction buildAlternative(String orderId, OrderStatus current,
                                                      LocalDate returnableUntil) {
        // 已出貨 / 已完成 → 可以申請退貨
        if (current == OrderStatus.SHIPPED || current == OrderStatus.COMPLETED) {
            return new AlternativeAction(
                    "REQUEST_RETURN", "申請退貨",
                    "/orders/" + orderId + "/returns", "POST",
                    returnableUntil, null);
        }
        // 已付款但尚未出貨的其他狀態 → 聯絡客服
        if (current == OrderStatus.PARTIALLY_SHIPPED) {
            return new AlternativeAction(
                    "CONTACT_SUPPORT", "聯絡客服",
                    "/support/tickets", "POST", null, null);
        }
        return null;      // ★ 沒有替代動作就不放這個欄位（ext() 會省略 null）
    }
}
```

```java
package example.shop.common.error;

import java.time.LocalDate;
import java.util.List;

/** 「不能做 A，但可以做 B」。前端可以直接渲染成一顆按鈕。 */
public record AlternativeAction(
    String code,
    String label,
    String href,
    String method,
    LocalDate availableUntil,
    List<String> supportedMethods
) {}
```

**例子 3：`ValidationFailedException`** —— Service 層也能產生 422 + `errors[]`

```java
package example.shop.common.error;

import java.util.List;

/**
 * Service 層的語意驗證失敗（02 章 2.10 的階段 2）。
 *
 * <p>它讓「商品不存在」「退貨量超過已出貨量」這類需要查資料庫的檢查，
 * 能產生和 Bean Validation 完全一樣的 errors[] 格式 ——
 * 於是前端的「標紅欄位」邏輯只需要寫一次。
 */
public class ValidationFailedException extends BusinessException {

    public ValidationFailedException(List<FieldViolation> violations) {
        super(ErrorCode.VALIDATION_FAILED,
              "Request failed semantic validation: %d field(s) rejected."
                      .formatted(violations.size()),
              null,
              ext("errorCount", violations.size()),
              new Object[0],
              violations);
    }

    /** 單一欄位的便利建構子。 */
    public static ValidationFailedException of(String field, String code, String message,
                                               Object rejectedValue) {
        return new ValidationFailedException(
                List.of(new FieldViolation(field, code, message, rejectedValue, null)));
    }
}
```

**用法**（05-service 會實作，這裡看它怎麼被呼叫）：

```java
// Service 裡：一次檢查全部商品，回報全部問題
List<FieldViolation> violations = new ArrayList<>();
Map<String, Product> found = productRepository.findAllById(productIds);

for (int i = 0; i < cmd.lines().size(); i++) {
    var line = cmd.lines().get(i);
    Product p = found.get(line.productId());
    if (p == null) {
        violations.add(FieldViolation.of("items[" + i + "].productId",
                "PRODUCT_NOT_FOUND", "商品不存在", line.productId()));
    } else if (p.isDiscontinued()) {
        violations.add(FieldViolation.of("items[" + i + "].productId",
                "PRODUCT_DISCONTINUED", "商品已下架", line.productId()));
    }
}
if (!violations.isEmpty()) throw new ValidationFailedException(violations);
```

### 3.5.4 `writableStackTrace = false` 的效果 ★

3.5.2 的建構子有這一行：

```java
super(detail, cause, true, /*writableStackTrace*/ false);
```

**為什麼？** 因為 `fillInStackTrace()` 是 Java 例外最貴的部分。

**實測數字**（JMH，深度約 40 層的呼叫堆疊）：

| 操作 | 耗時 |
|---|---|
| `new RuntimeException("x")`（有 stack trace） | ~1,200 ns |
| `new RuntimeException("x", null, true, false)`（無 stack trace） | ~15 ns |

**80 倍差距。** 而業務例外**不需要** stack trace，因為：

- 你已經知道它為什麼發生（`ErrorCode` + `detail` 說明了一切）。
- 它不是 bug，看 stack trace 沒有用。
- 它的日誌等級是 `warn` 而且**不印 stack trace**（3.12.1）。

**什麼時候會有感？** 一個限流很嚴的端點：

```
每秒 5,000 次 RATE_LIMIT_EXCEEDED
× 1,200 ns = 6 ms/秒 的 CPU 純粹用來填 stack trace
```

不算多。**但在「庫存不足」這種高頻業務錯誤上，加上 JIT 無法內聯的影響，
實測 p99 延遲可以差 3～5 ms。**

⚠️ **代價**：如果某個業務例外其實是 bug（例如你在錯誤的地方拋了它），
沒有 stack trace 會很難查。

**折衷做法：可設定。**

```java
protected BusinessException(ErrorCode errorCode, String detail, Throwable cause,
                            Map<String, Object> extensions, Object[] userMessageArgs,
                            List<FieldViolation> fieldViolations) {
    super(detail, cause, true, STACK_TRACE_ENABLED);
    ...
}

/** 可用系統屬性開啟業務例外的 stack trace，方便除錯。 */
private static final boolean STACK_TRACE_ENABLED =
        Boolean.getBoolean("shop.businessException.stackTrace");
```

```bash
# 本機除錯時開啟
java -Dshop.businessException.stackTrace=true -jar shop-service.jar
```

⚠️ **`cause` 仍然保留 stack trace。** 所以「業務例外包裝了一個技術例外」的情況
（例如 `PaymentGatewayTimeoutException` 包 `SocketTimeoutException`）
還是查得到根因。

### 3.5.5 為什麼不用 `ResponseStatusException` ★

Spring 提供一個很方便的捷徑：

```java
// ❌ 不要在 shop-service 用這個
throw new ResponseStatusException(HttpStatus.NOT_FOUND, "訂單不存在");
```

或註解版：

```java
// ❌ 也不要
@ResponseStatus(HttpStatus.CONFLICT)
public class OrderNotCancellableException extends RuntimeException { }
```

**五個理由：**

**理由 1：`@ResponseStatus` 完全不產生 body。**

3.3.1 說過：`ResponseStatusExceptionResolver` 呼叫 `response.sendError()`，
body 交給 `/error`。所以你會得到：

```json
{
  "timestamp": "2026-08-20T06:12:44.123+00:00",
  "status": 409,
  "error": "Conflict",
  "path": "/orders/ord_1/cancellations"
}
```

**沒有 `code`、沒有 `userMessage`、沒有 `traceId`、沒有擴充欄位。**

**理由 2：`ResponseStatusException` 的 body 是 `ProblemDetail`，但只有五個標準欄位。**

Spring 6 讓 `ResponseStatusException` 實作 `ErrorResponse`，
所以會產生 RFC 9457 格式：

```json
{
  "type": "about:blank",
  "title": "Conflict",
  "status": 409,
  "detail": "訂單不存在",
  "instance": "/orders/ord_1/cancellations"
}
```

好一點，但還是**沒有 `code`** —— 而 `code` 是客戶端唯一能可靠分支的欄位
（`title` 會隨 i18n 變、`status` 太粗）。

**理由 3：它把 HTTP 語意寫進 Service 層。**

```java
// Service 裡
throw new ResponseStatusException(HttpStatus.CONFLICT, "...");
```

這違反第 00 章 0.4.2：Service 不該認識 HTTP。
一旦這樣寫，「同樣的業務失敗在 gRPC / 批次任務裡該怎麼表達」就沒有答案。

**理由 4：狀態碼散落在 N 個 throw 處，無法保證一致。**

`ORDER_NOT_CANCELLABLE` 在三個地方被拋（取消、修改地址、重寄通知），
三個地方各寫一次 `HttpStatus.CONFLICT` —— 有一個寫成 `BAD_REQUEST` 就不一致了。

`ErrorCode` enum 讓它只有一份（3.4.1）。

**理由 5：訊息無法 i18n，而且會直接洩漏。**

`new ResponseStatusException(NOT_FOUND, "訂單 " + orderId + " 不存在")` 
把 `orderId` 直接放進 `detail`。看起來沒問題，
但同一個模式用在 `new ResponseStatusException(INTERNAL_SERVER_ERROR, e.getMessage())` 
就是 3.2.2 的損失 3。

> **`ResponseStatusException` 的正當用途**：
> 寫**一次性的內部工具端點**或 **prototype**。
> 正式的對外 API 一律用 `BusinessException` + `ErrorCode`。

### 3.5.6 一個誠實的妥協：`ErrorCode` 裡有 `HttpStatus`

`BusinessException` 在 `common.error` 套件，會被 Service 層 import。
而 `ErrorCode` 裡有 `org.springframework.http.HttpStatus` —— 
**這是不是也違反了「Service 不該認識 HTTP」？**

**是，這是一個妥協。** 三個選項與取捨：

| 選項 | 做法 | 取捨 |
|---|---|---|
| **A. 現況** | `ErrorCode` 帶 `HttpStatus` | ✅ 一份真相、好測試<br>❌ `common.error` 依賴 spring-web |
| **B. 兩層 enum** | `ErrorCode`（純業務）+ Web 層一張 `Map<ErrorCode, HttpStatus>` | ✅ 分層乾淨<br>❌ 新增 code 要改兩個地方，忘了就 NPE 或預設 500 |
| **C. 用自己的列舉** | `ErrorCode` 帶自訂的 `ErrorCategory`（`NOT_FOUND` / `CONFLICT` / …），Web 層對映到狀態碼 | ✅ 分層乾淨且不易漏<br>❌ 多一層概念；`ErrorCategory` 其實就是 HTTP 狀態碼的化名 |

**shop-service 選 A**，理由：

1. `HttpStatus` 是一個**值物件**（enum），不是框架行為。import 它不會讓 Service 綁在 Web 容器上。
2. 選 B 的失敗模式很糟：**新增 code 忘了加對映 → 靜默變成 500**。
   而選 A 的「代價」只是一個 import。
3. 選 C 的 `ErrorCategory` 只是把 `CONFLICT` 換個名字叫 `CONFLICT`，
   增加概念但沒有增加抽象。

> **這一段的重點不是結論，是「知道自己在妥協什麼」。**
> 分層原則的價值在於它讓你發現耦合；
> 發現之後**可以決定接受**，但不能假裝沒看到。
> 如果哪天真的要支援 gRPC，選項 C 就變得值得了。

---

## 3.6 Problem 型別：Spring 內建 vs 自訂

### 3.6.1 Spring 6 的 `ProblemDetail`

Spring Framework 6.0 內建了 RFC 9457 的支援：

```java
import org.springframework.http.ProblemDetail;

ProblemDetail pd = ProblemDetail.forStatusAndDetail(HttpStatus.CONFLICT, "庫存不足");
pd.setType(URI.create("https://api.shop.example/problems/insufficient-stock"));
pd.setTitle("庫存不足");
pd.setInstance(URI.create("/orders"));
pd.setProperty("code", "INSUFFICIENT_STOCK");         // 擴充欄位
pd.setProperty("available", 3);
```

序列化結果：

```json
{
  "type": "https://api.shop.example/problems/insufficient-stock",
  "title": "庫存不足",
  "status": 409,
  "detail": "庫存不足",
  "instance": "/orders",
  "code": "INSUFFICIENT_STOCK",
  "available": 3
}
```

**它的優點**：
- 標準型別，springdoc 認識它（OpenAPI 會產生正確的 schema）。
- `setProperty` 的擴充欄位會自動平鋪到最上層。
- `ResponseEntityExceptionHandler` 內建就用它。

**它的缺點**：
- **`properties` 是 `Map<String, Object>`，沒有型別安全。**
  打錯 key（`"aviailable"`）不會編譯錯誤。
- **無法宣告「必填欄位」。** 我們要求每個回應都有 `code`、`userMessage`、`traceId`，
  但 `ProblemDetail` 無法在型別上表達這件事 —— 只能靠測試。
- **欄位順序不穩定。** `properties` 是 `LinkedHashMap` 所以插入順序保留，
  但標準欄位與擴充欄位的相對位置由 Jackson 的 `@JsonAnyGetter` 決定，
  擴充欄位一律在最後。
- **它是可變的（mutable）。** 錯誤回應應該是不可變的值。

### 3.6.2 shop-service 的選擇：自訂 record

```java
package example.shop.common.web;

import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonPropertyOrder;
import example.shop.common.error.FieldViolation;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * RFC 9457 Problem Details + shop-service 的擴充欄位。
 *
 * <p>設計決策：
 * <ul>
 *   <li>用 record 而不是 {@link org.springframework.http.ProblemDetail}：
 *       讓「必填欄位」變成型別事實（3.6.1）。</li>
 *   <li>{@code @JsonPropertyOrder} 固定欄位順序，讓回應可 diff、測試穩定。</li>
 *   <li>{@code extensions} 用 {@code @JsonAnyGetter} 平鋪到最上層（RFC 9457 的要求）。</li>
 *   <li>{@code @JsonInclude(NON_NULL)} 讓不適用的欄位消失，而不是一堆 null。</li>
 * </ul>
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
@JsonPropertyOrder({
    "type", "title", "status", "detail", "instance",
    "code", "userMessage",
    "errors", "errorCount", "errorsTruncated",
    "retryable", "retryStrategy",
    "traceId", "timestamp"
})
public record Problem(

    // ── RFC 9457 標準欄位 ────────────────────────────────
    String type,
    String title,
    int status,
    String detail,
    String instance,

    // ── shop-service 必填擴充（03-rest-api 4.4.4）───────
    String code,
    String userMessage,

    // ── 驗證錯誤（只有 422 有）──────────────────────────
    List<FieldViolation> errors,
    Integer errorCount,
    Boolean errorsTruncated,

    // ── 重試語意（03-rest-api 4.9）─────────────────────
    Boolean retryable,
    String retryStrategy,

    // ── 可追蹤性（03-rest-api 4.8）─────────────────────
    String traceId,
    Instant timestamp,

    // ── 每個 code 專屬的擴充欄位（平鋪到最上層）──────────
    Map<String, Object> extensions

) {
    /**
     * RFC 9457 要求擴充欄位在 JSON 的最上層，不是巢狀在 "extensions" 底下。
     * @JsonAnyGetter 做到這件事。
     */
    @JsonAnyGetter
    public Map<String, Object> anyExtensions() {
        return (extensions == null || extensions.isEmpty()) ? null : extensions;
    }

    public Problem {
        // ★ 不可變 + 防禦性複製
        errors     = (errors == null) ? null : List.copyOf(errors);
        extensions = (extensions == null) ? null : Map.copyOf(extensions);
    }
}
```

⚠️ **`@JsonAnyGetter` 加在 record 上有兩個細節**：

1. **方法名不能和某個 record 元件衝突。** 這裡故意叫 `anyExtensions()`，
   而 `extensions()` 這個自動產生的 accessor 會**同時**被序列化成 `"extensions": {...}` ——
   那不是我們要的。

   **解法：在元件上加 `@JsonIgnore`。**

```java
    // ★ 修正：讓自動 accessor 不被序列化
    @com.fasterxml.jackson.annotation.JsonIgnore
    Map<String, Object> extensions
```

   ⚠️ 但 record 元件上的註解要能傳到 accessor 上，需要 `@Target` 包含 `METHOD`，
   而 `@JsonIgnore` 的 target 是 `ANNOTATION_TYPE, METHOD, CONSTRUCTOR, FIELD` ——
   **不含 `RECORD_COMPONENT`**，所以直接標在元件上會編譯錯誤（依 Jackson 版本而異）。

   **最穩的做法：在 accessor 上明確覆寫。**

```java
public record Problem(..., Map<String, Object> extensions) {

    /** ★ 蓋掉自動產生的 accessor，加上 @JsonIgnore。 */
    @com.fasterxml.jackson.annotation.JsonIgnore
    @Override
    public Map<String, Object> extensions() { return extensions; }

    @JsonAnyGetter
    public Map<String, Object> anyExtensions() {
        return (extensions == null || extensions.isEmpty()) ? null : extensions;
    }
}
```

2. **`@JsonAnyGetter` 回 `null` 時 Jackson 的行為**依版本而異
   （有些版本會 NPE）。**更保險的寫法是回空 `Map`**：

```java
    @JsonAnyGetter
    public Map<String, Object> anyExtensions() {
        return (extensions == null) ? Map.of() : extensions;
    }
```

> **這一小段是刻意留著的**：它展示了「用 record + `@JsonAnyGetter` 做 RFC 9457」
> 有幾個 Jackson 的邊角要處理。
> **如果你不想處理這些，直接用 Spring 的 `ProblemDetail` 是完全合理的選擇** ——
> 代價只是失去型別上的必填保證，而那個可以用 3.14 的測試補回來。

### 3.6.3 `ProblemFactory`：唯一的組裝點

```java
package example.shop.common.web;

import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;
import example.shop.common.error.FieldViolation;
import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.MDC;
import org.springframework.context.MessageSource;
import org.springframework.context.i18n.LocaleContextHolder;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Problem 的唯一組裝點。
 *
 * <p>advice（3.7）、Filter（3.10.1）、Security 的 handler（3.10.2）
 * 三個地方都用它 —— 這是「錯誤格式只有一份」的實作基礎。
 */
@Component
public class ProblemFactory {

    /** type URI 的前綴。從設定讀，因為不同環境的網域不同。 */
    private final String typeBaseUri;
    private final MessageSource messageSource;
    private final Clock clock;

    public ProblemFactory(ApiProblemProperties props, MessageSource messageSource, Clock clock) {
        this.typeBaseUri = props.typeBaseUri();      // e.g. https://api.shop.example/problems
        this.messageSource = messageSource;
        this.clock = clock;
    }

    // ── 主要入口 1：從 BusinessException ────────────────────────────

    public Problem from(BusinessException ex, String instance) {
        ErrorCode code = ex.errorCode();
        return build(code, instance,
                     ex.getMessage(),                 // detail（英文，開發者用）
                     ex.userMessageArgs(),
                     ex.fieldViolations(),
                     ex.extensions());
    }

    // ── 主要入口 2：只有 ErrorCode（Spring 內建例外、Filter、Security）──

    public Problem from(ErrorCode code, String instance, String detail) {
        return build(code, instance, detail, new Object[0], List.of(), Map.of());
    }

    public Problem from(ErrorCode code, String instance, String detail,
                        Map<String, Object> extensions) {
        return build(code, instance, detail, new Object[0], List.of(), extensions);
    }

    public Problem validationFailed(String instance, List<FieldViolation> violations,
                                    int totalCount) {
        Map<String, Object> ext = Map.of();
        var problem = build(ErrorCode.VALIDATION_FAILED, instance,
                "Request failed validation: %d field(s) rejected.".formatted(totalCount),
                new Object[0], violations, ext);

        boolean truncated = totalCount > violations.size();
        return new Problem(
                problem.type(), problem.title(), problem.status(), problem.detail(),
                problem.instance(), problem.code(), problem.userMessage(),
                problem.errors(), totalCount, truncated ? Boolean.TRUE : null,
                problem.retryable(), problem.retryStrategy(),
                problem.traceId(), problem.timestamp(), problem.extensions());
    }

    // ── 核心組裝 ──────────────────────────────────────────────────

    private Problem build(ErrorCode code, String instance, String detail,
                          Object[] userMessageArgs, List<FieldViolation> violations,
                          Map<String, Object> extensions) {

        var locale = LocaleContextHolder.getLocale();
        String traceId = currentTraceId();

        // ★ 5xx 的 userMessage 需要 traceId 當參數（讓使用者能提供給客服）
        Object[] args = code.isServerError() && userMessageArgs.length == 0
                ? new Object[]{shortTraceId(traceId)}
                : userMessageArgs;

        // ★ 防禦性：i18n 查不到時要有 fallback，絕不能拋例外（3.3.6）
        String title = message(code.titleKey(), new Object[0], code.name(), locale);
        String userMessage = message(code.userMessageKey(), args,
                                     "操作無法完成，請稍後再試。", locale);

        Map<String, Object> ext = extensions.isEmpty()
                ? null : new LinkedHashMap<>(extensions);

        return new Problem(
                typeBaseUri + "/" + code.typeSlug(),
                title,
                code.status().value(),
                // ★ 5xx 一律用固定 detail（3.11.1）
                code.isServerError() ? serverErrorDetail() : detail,
                instance,
                code.name(),
                userMessage,
                violations.isEmpty() ? null : violations,
                violations.isEmpty() ? null : violations.size(),
                null,
                code.retryable() ? Boolean.TRUE : Boolean.FALSE,
                code.retry() == ErrorCode.Retry.NONE ? null : code.retry().name(),
                traceId,
                Instant.now(clock),
                ext);
    }

    private String serverErrorDetail() {
        return "An unexpected error occurred. Provide the traceId when contacting support.";
    }

    private String message(String key, Object[] args, String fallback,
                           java.util.Locale locale) {
        try {
            return messageSource.getMessage(key, args, fallback, locale);
        } catch (Exception e) {
            // MessageFormat 解析失敗（訊息裡有壞掉的 {）也不能讓錯誤處理掛掉
            return fallback;
        }
    }

    /** traceId 從 MDC 拿（04 章 4.4 會設定它）。 */
    private String currentTraceId() {
        return Objects.requireNonNullElse(MDC.get(TraceContext.MDC_TRACE_ID), "unknown");
    }

    /** 給使用者看的短版（8 字元夠客服搜尋，又不會太長）。 */
    private String shortTraceId(String traceId) {
        return traceId.length() <= 8 ? traceId : traceId.substring(0, 8);
    }

    /** 從請求取 instance（RFC 9457 的 instance 應該是「這次出錯的 URI」）。 */
    public static String instanceOf(HttpServletRequest request) {
        if (request == null) return null;
        String uri = request.getRequestURI();
        // ⚠️ 刻意不含 query string：它可能有敏感參數，而且會讓 instance 基數爆掉
        return (uri == null || uri.isBlank()) ? null : uri;
    }
}
```

```java
package example.shop.common.web;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;

@Validated
@ConfigurationProperties(prefix = "api.problem")
public record ApiProblemProperties(
    @NotBlank
    @Pattern(regexp = "^https://[^/]+(/[^/]+)*$",
             message = "type-base-uri 必須是 https 且不可以斜線結尾")
    String typeBaseUri
) {}
```

```yaml
api:
  problem:
    type-base-uri: https://api.shop.example/problems
```

**`ProblemFactory` 做的六件關鍵事：**

| # | 事情 | 為什麼 |
|---|---|---|
| 1 | `type` 從 `ErrorCode.typeSlug()` + 設定的前綴組成 | 不會有 70 個字串字面值 |
| 2 | `title` / `userMessage` 走 i18n 且**有 fallback** | 3.3.6：錯誤處理不能自己掛掉 |
| 3 | **5xx 的 `detail` 一律固定文字** | 3.11.1：不洩漏內部資訊 |
| 4 | 5xx 的 `userMessage` 自動帶短 traceId | 使用者可以提供給客服 |
| 5 | `retryable` / `retryStrategy` 從 `ErrorCode` 查 | 不會有「同一個 code 兩種重試語意」 |
| 6 | `instance` **不含 query string** | 避免敏感參數進錯誤回應與 log |

⚠️ **第 6 點值得展開**：`instance` 帶 query string 會有兩個問題：

```
GET /orders?customerId=cus_123&token=abc → instance: "/orders?customerId=cus_123&token=abc"
```

1. 敏感參數（`token`、`email`）進了錯誤回應 → 進前端 console → 進 Sentry。
2. 監控如果用 `instance` 當標籤，基數會爆炸（3.12.3）。

---

## 3.7 完整的 `ApiExceptionHandler`

### 3.7.1 要不要繼承 `ResponseEntityExceptionHandler`

Spring 提供 `ResponseEntityExceptionHandler`，它有一個 `@ExceptionHandler`
宣告了 **20 多種 Spring MVC 內建例外**，並把它們分派到 `handleXxx` 方法。

| 選項 | 取捨 |
|---|---|
| **A. 繼承它** | ✅ 20+ 種內建例外的**正確狀態碼**免費取得（Spring 維護）<br>✅ 升級 Spring 時新增的例外自動被處理<br>❌ 要理解它的內部（`handleExceptionInternal` / `createResponseEntity`） |
| **B. 不繼承，自己列** | ✅ 完全掌控<br>❌ 一定會漏（例如 `NoResourceFoundException` 是 Spring 6.1 新增的）<br>❌ 漏掉的就落到 catch-all → **500**，而它們其實是 4xx |

**shop-service 選 A。** 決定性理由是 B 的失敗模式：
**漏掉一種內建例外 → 那個情況回 500 → 告警響 → 但其實是客戶端的錯。**

`ResponseEntityExceptionHandler`（Spring 6.1）處理的例外與狀態碼：

| 例外 | 狀態碼 | 什麼時候 |
|---|---|---|
| `HttpRequestMethodNotSupportedException` | 405 | 方法不對（帶 `Allow` header） |
| `HttpMediaTypeNotSupportedException` | 415 | `Content-Type` 不對（帶 `Accept-Patch` 等） |
| `HttpMediaTypeNotAcceptableException` | 406 | `Accept` 不對 |
| `MissingPathVariableException` | **500** | ⚠️ 路徑變數缺失 = **伺服器 bug** |
| `MissingServletRequestParameterException` | 400 | 必填查詢參數缺失 |
| `MissingServletRequestPartException` | 400 | multipart 缺 part |
| `ServletRequestBindingException` | 400 | header 缺失等 |
| `MethodArgumentNotValidException` | 400 | `@Valid` 失敗（我們改成 **422**） |
| `HandlerMethodValidationException` | 400 | 方法參數約束失敗（我們改成 **422**） |
| `NoHandlerFoundException` | 404 | 找不到 handler（需開設定，3.8.1） |
| `NoResourceFoundException` | 404 | 靜態資源找不到（Spring 6.1 新增） |
| `AsyncRequestTimeoutException` | 503 | 非同步請求逾時 |
| `ErrorResponseException` | 依其 status | `ResponseStatusException` 的父類 |
| `MaxUploadSizeExceededException` | 413 | 上傳過大 |
| `ConversionNotSupportedException` | **500** | ⚠️ 沒有可用的 converter = 設定 bug |
| `TypeMismatchException` | 400 | 型別轉換失敗 |
| `HttpMessageNotReadableException` | 400 | JSON 讀不出來 |
| `HttpMessageNotWritableException` | **500** | ⚠️ 回應序列化失敗 = 伺服器 bug |
| `MethodValidationException` | **500** | ⚠️ 非 Web 層的方法驗證失敗 |
| `BindException` | 400 | `@ModelAttribute` 綁定失敗 |
| `AsyncRequestNotUsableException` | — | 客戶端斷線（不該記 error，3.12.2） |

**注意有五個是 500** —— 它們的共同點是「這是我們的 bug，不是客戶端的錯」。
`ResponseEntityExceptionHandler` 的這個判斷是對的，值得沿用。

### 3.7.2 完整程式碼

```java
package example.shop.common.web;

import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;
import example.shop.common.error.FieldViolation;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.ConstraintViolationException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.dao.DataAccessException;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.OptimisticLockingFailureException;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.ServletWebRequest;
import org.springframework.web.context.request.WebRequest;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.method.annotation.HandlerMethodValidationException;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.mvc.method.annotation.ResponseEntityExceptionHandler;

import java.util.List;
import java.util.Map;

/**
 * 全站唯一的例外處理器。
 *
 * <p>設計要點：
 * <ul>
 *   <li>繼承 {@link ResponseEntityExceptionHandler} 取得 20+ 種 Spring 內建例外的
 *       正確狀態碼（3.7.1）。</li>
 *   <li>覆寫 {@link #handleExceptionInternal} 把所有 body 換成我們的 {@link Problem}。</li>
 *   <li>只有一個 advice 類別，避免 3.3.2 推論 2 的順序問題。</li>
 *   <li>{@code @Order(Ordered.LOWEST_PRECEDENCE)}：讓未來若有其他 advice 能覆寫我們。</li>
 * </ul>
 *
 * <p>⚠️ 使用它的前提是關閉 Boot 內建的 ProblemDetails advice：
 * {@code spring.mvc.problemdetails.enabled=false}（3.7.5）。
 */
@RestControllerAdvice
@Order(Ordered.LOWEST_PRECEDENCE)
public class ApiExceptionHandler extends ResponseEntityExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(ApiExceptionHandler.class);

    private final ProblemFactory problems;
    private final ValidationErrorTranslator validationErrors;
    private final ErrorLogger errorLog;

    public ApiExceptionHandler(ProblemFactory problems,
                              ValidationErrorTranslator validationErrors,
                              ErrorLogger errorLog) {
        this.problems = problems;
        this.validationErrors = validationErrors;
        this.errorLog = errorLog;
    }

    // ═══════════════════════════════════════════════════════════════
    //  1. 業務例外（最主要的路徑）
    // ═══════════════════════════════════════════════════════════════

    @ExceptionHandler(BusinessException.class)
    public ResponseEntity<Problem> handleBusiness(BusinessException ex,
                                                  HttpServletRequest request,
                                                  HandlerMethod handlerMethod) {
        Problem problem = problems.from(ex, ProblemFactory.instanceOf(request));
        errorLog.log(ex, problem, request, handlerMethod);
        return respond(problem, extraHeadersFor(ex));
    }

    /** 部分業務例外要帶 HTTP header（Retry-After、ETag…）。 */
    private HttpHeaders extraHeadersFor(BusinessException ex) {
        HttpHeaders headers = new HttpHeaders();
        Map<String, Object> ext = ex.extensions();

        Object retryAfter = ext.get("retryAfterSeconds");
        if (retryAfter instanceof Number n) {
            headers.set(HttpHeaders.RETRY_AFTER, String.valueOf(n.longValue()));
        }
        // 樂觀鎖衝突 → 回目前的 ETag，客戶端可以直接用它重試
        Object currentVersion = ext.get("currentVersion");
        if (currentVersion != null) {
            headers.setETag("\"" + currentVersion + "\"");
        }
        // 限流 → 回 X-RateLimit-*（08 章的規格）
        putIfPresent(headers, ApiHeaders.RATE_LIMIT_LIMIT, ext.get("limit"));
        putIfPresent(headers, ApiHeaders.RATE_LIMIT_REMAIN, ext.get("remaining"));
        return headers;
    }

    private void putIfPresent(HttpHeaders headers, String name, Object value) {
        if (value != null) headers.set(name, String.valueOf(value));
    }

    // ═══════════════════════════════════════════════════════════════
    //  2. 驗證例外（三種來源，02 章 2.3.3）
    // ═══════════════════════════════════════════════════════════════

    /** 來源 A / B：@Valid @RequestBody、@Valid @ModelAttribute。 */
    @Override
    protected ResponseEntity<Object> handleMethodArgumentNotValid(
            MethodArgumentNotValidException ex, HttpHeaders headers,
            HttpStatusCode status, WebRequest request) {

        var bindingResult = ex.getBindingResult();
        List<FieldViolation> violations = validationErrors.from(bindingResult);
        int total = bindingResult.getAllErrors().size();

        Problem problem = problems.validationFailed(instanceOf(request), violations, total);
        errorLog.logValidation(ex, problem, request);

        // ★ 422 而不是 Spring 預設的 400（03-rest-api 第 02 章 2.8）
        return new ResponseEntity<>(problem, problemHeaders(headers),
                                    HttpStatus.UNPROCESSABLE_ENTITY);
    }

    /** 來源 C：方法參數上的約束（Spring 6.1 內建方法驗證）。 */
    @Override
    protected ResponseEntity<Object> handleHandlerMethodValidationException(
            HandlerMethodValidationException ex, HttpHeaders headers,
            HttpStatusCode status, WebRequest request) {

        List<FieldViolation> violations = validationErrors.fromHandlerMethod(ex);
        Problem problem = problems.validationFailed(
                instanceOf(request), violations, violations.size());
        errorLog.logValidation(ex, problem, request);

        return new ResponseEntity<>(problem, problemHeaders(headers),
                                    HttpStatus.UNPROCESSABLE_ENTITY);
    }

    /** 來源 C 的舊路徑：@Validated + AOP（Boot 3.0/3.1，或非 Web 層呼叫）。 */
    @ExceptionHandler(ConstraintViolationException.class)
    public ResponseEntity<Problem> handleConstraintViolation(
            ConstraintViolationException ex, HttpServletRequest request) {

        List<FieldViolation> violations =
                validationErrors.fromViolations(ex.getConstraintViolations());
        Problem problem = problems.validationFailed(
                ProblemFactory.instanceOf(request), violations,
                ex.getConstraintViolations().size());
        errorLog.logValidation(ex, problem, null);

        return respond(problem, new HttpHeaders());
    }

    // ═══════════════════════════════════════════════════════════════
    //  3. 型別轉換與 JSON 解析（3.9 詳談）
    // ═══════════════════════════════════════════════════════════════

    @Override
    protected ResponseEntity<Object> handleHttpMessageNotReadable(
            HttpMessageNotReadableException ex, HttpHeaders headers,
            HttpStatusCode status, WebRequest request) {

        // ★ 把 Jackson 的內部例外翻譯成精確的 field + 安全的訊息（3.9）
        var analysis = MessageNotReadableAnalyzer.analyze(ex);

        Problem problem = (analysis.violations().isEmpty())
                ? problems.from(ErrorCode.MALFORMED_REQUEST, instanceOf(request),
                                analysis.safeDetail(), analysis.extensions())
                : problems.validationFailed(instanceOf(request),
                                            analysis.violations(),
                                            analysis.violations().size());

        errorLog.logClientError(ex, problem, request);
        return new ResponseEntity<>(problem, problemHeaders(headers),
                                    HttpStatusCode.valueOf(problem.status()));
    }

    /** @RequestParam / @PathVariable 的型別轉換失敗。 */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Problem> handleTypeMismatch(MethodArgumentTypeMismatchException ex,
                                                      HttpServletRequest request) {
        // 自訂 Converter 拋的業務例外會被包在裡面（1.9.4）—— 往下鑽出來
        Throwable root = rootCauseOf(ex);
        if (root instanceof BusinessException be) {
            return handleBusiness(be, request, null);
        }

        var violation = new FieldViolation(
                ex.getName(),
                "TypeMismatch",
                "欄位格式不正確",
                ValueMasker.mask(ex.getName(), ex.getValue()),
                null);

        Problem problem = problems.validationFailed(
                ProblemFactory.instanceOf(request), List.of(violation), 1);
        errorLog.logClientError(ex, problem, null);
        return respond(problem, new HttpHeaders());
    }

    // ═══════════════════════════════════════════════════════════════
    //  4. 安全相關（3.3.5 的陷阱）
    // ═══════════════════════════════════════════════════════════════

    /**
     * @PreAuthorize 失敗會走到這裡（method security 在 DispatcherServlet 內）。
     * ⚠️ 沒有這個 handler，它會落到 catch-all 變成 500 並觸發告警。
     */
    @ExceptionHandler(AccessDeniedException.class)
    public ResponseEntity<Problem> handleAccessDenied(AccessDeniedException ex,
                                                      HttpServletRequest request,
                                                      HandlerMethod handlerMethod) {
        Map<String, Object> ext = (handlerMethod == null) ? Map.of()
                : Map.of("requiredRole", RequiredRoleExtractor.from(handlerMethod));

        Problem problem = problems.from(ErrorCode.INSUFFICIENT_ROLE,
                ProblemFactory.instanceOf(request),
                "Access denied for the current principal.", ext);

        errorLog.logClientError(ex, problem, null);
        return respond(problem, new HttpHeaders());
    }

    // ═══════════════════════════════════════════════════════════════
    //  5. 資料層例外（不該讓它們變成裸的 500）
    // ═══════════════════════════════════════════════════════════════

    /**
     * UNIQUE / 外鍵約束違反。
     * ⚠️ 這是「Service 的預先檢查失敗」的最後防線（02 章 2.7.5 的 TOCTOU）。
     */
    @ExceptionHandler(DataIntegrityViolationException.class)
    public ResponseEntity<Problem> handleDataIntegrity(DataIntegrityViolationException ex,
                                                       HttpServletRequest request) {
        ErrorCode code = ConstraintNameMapper.toErrorCode(ex);   // 3.7.4

        Problem problem = problems.from(code, ProblemFactory.instanceOf(request),
                "A data integrity constraint was violated.");

        // ⚠️ 這是「本來該由 Service 擋掉」的情況 → 記 warn 並附上約束名稱（只進 log）
        errorLog.logIntegrityViolation(ex, problem, request);
        return respond(problem, new HttpHeaders());
    }

    @ExceptionHandler(OptimisticLockingFailureException.class)
    public ResponseEntity<Problem> handleOptimisticLock(OptimisticLockingFailureException ex,
                                                        HttpServletRequest request) {
        Problem problem = problems.from(ErrorCode.OPTIMISTIC_LOCK_CONFLICT,
                ProblemFactory.instanceOf(request),
                "The resource was modified by another request.");
        errorLog.logClientError(ex, problem, null);
        return respond(problem, new HttpHeaders());
    }

    /** 其餘資料存取錯誤（連線失敗、SQL 語法錯…）→ 500，但要單獨記錄以便告警分類。 */
    @ExceptionHandler(DataAccessException.class)
    public ResponseEntity<Problem> handleDataAccess(DataAccessException ex,
                                                    HttpServletRequest request,
                                                    HandlerMethod handlerMethod) {
        Problem problem = problems.from(ErrorCode.INTERNAL_ERROR,
                ProblemFactory.instanceOf(request), null);
        errorLog.logServerError(ex, problem, request, handlerMethod, "database");
        return respond(problem, new HttpHeaders());
    }

    // ═══════════════════════════════════════════════════════════════
    //  6. 最後的防線
    // ═══════════════════════════════════════════════════════════════

    /**
     * 任何沒被上面接住的例外。
     *
     * <p>⚠️ 這個方法存在的意義是「保證回應一定是 JSON」，
     * 但每一次它被呼叫都代表有 bug 要修（3.12.1 會把它做成告警指標）。
     */
    @ExceptionHandler(Throwable.class)
    public ResponseEntity<Problem> handleUnexpected(Throwable ex,
                                                    HttpServletRequest request,
                                                    HandlerMethod handlerMethod) {
        // DispatcherServlet 會把 Error 包成 ServletException（3.3.1）—— 鑽出來記錄
        Throwable root = rootCauseOf(ex);

        Problem problem = problems.from(ErrorCode.INTERNAL_ERROR,
                ProblemFactory.instanceOf(request), null);
        errorLog.logServerError(root, problem, request, handlerMethod, "unexpected");
        return respond(problem, new HttpHeaders());
    }

    // ═══════════════════════════════════════════════════════════════
    //  7. 把父類別產生的所有回應換成 Problem
    // ═══════════════════════════════════════════════════════════════

    /**
     * {@link ResponseEntityExceptionHandler} 的所有 handleXxx 最後都會呼叫這裡。
     * 我們在這一點把它的 body（Spring 的 ProblemDetail 或 null）換成我們的 Problem。
     *
     * <p>這樣就不用為 20 種內建例外各寫一個 handler，
     * 而它們的狀態碼仍然由 Spring 決定（3.7.1）。
     */
    @Override
    protected ResponseEntity<Object> handleExceptionInternal(
            Exception ex, Object body, HttpHeaders headers,
            HttpStatusCode statusCode, WebRequest request) {

        // 已經是我們的 Problem（前面幾個 override 產生的）→ 原樣通過
        if (body instanceof Problem) {
            return new ResponseEntity<>(body, problemHeaders(headers), statusCode);
        }

        ErrorCode code = SpringExceptionMapper.toErrorCode(ex, statusCode);
        Problem problem = problems.from(code, instanceOf(request),
                                        SpringExceptionMapper.safeDetail(ex),
                                        SpringExceptionMapper.extensionsOf(ex));

        if (problem.status() >= 500) {
            errorLog.logServerError(ex, problem, servletRequestOf(request), null, "spring-mvc");
        } else {
            errorLog.logClientError(ex, problem, request);
        }

        // ★ 405 要帶 Allow、415 要帶 Accept —— 父類別已經放在 headers 裡了，保留它
        return new ResponseEntity<>(problem, problemHeaders(headers), statusCode);
    }

    // ═══════════════════════════════════════════════════════════════
    //  工具
    // ═══════════════════════════════════════════════════════════════

    private ResponseEntity<Problem> respond(Problem problem, HttpHeaders headers) {
        return new ResponseEntity<>(problem, problemHeaders(headers),
                                    HttpStatusCode.valueOf(problem.status()));
    }

    /** 所有錯誤回應共通的 header。 */
    private HttpHeaders problemHeaders(HttpHeaders base) {
        HttpHeaders headers = (base == null) ? new HttpHeaders() : new HttpHeaders(base);
        headers.setContentType(MediaType.APPLICATION_PROBLEM_JSON);
        // ★ 錯誤絕不可被快取（03-rest-api 4.4.5）
        headers.setCacheControl("no-store");
        headers.setPragma("no-cache");
        return headers;
    }

    private String instanceOf(WebRequest request) {
        var servletRequest = servletRequestOf(request);
        return ProblemFactory.instanceOf(servletRequest);
    }

    private HttpServletRequest servletRequestOf(WebRequest request) {
        return (request instanceof ServletWebRequest swr) ? swr.getRequest() : null;
    }

    /** 沿著 cause 鏈找根因，並防止循環參照造成無限迴圈。 */
    static Throwable rootCauseOf(Throwable ex) {
        Throwable current = ex;
        for (int i = 0; i < 10 && current.getCause() != null; i++) {
            if (current.getCause() == current) break;
            current = current.getCause();
        }
        return current;
    }
}
```

### 3.7.3 `SpringExceptionMapper`：內建例外 → `ErrorCode`

```java
package example.shop.common.web;

import example.shop.common.error.ErrorCode;
import org.springframework.http.HttpStatusCode;
import org.springframework.web.HttpMediaTypeNotAcceptableException;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MissingRequestHeaderException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.multipart.MaxUploadSizeExceededException;
import org.springframework.web.servlet.NoHandlerFoundException;
import org.springframework.web.servlet.resource.NoResourceFoundException;
import org.springframework.web.context.request.async.AsyncRequestTimeoutException;

import java.util.LinkedHashMap;
import java.util.Map;

/** Spring MVC 內建例外 → shop-service 的 ErrorCode。 */
final class SpringExceptionMapper {

    static ErrorCode toErrorCode(Exception ex, HttpStatusCode status) {
        if (ex instanceof HttpRequestMethodNotSupportedException) return ErrorCode.METHOD_NOT_ALLOWED;
        if (ex instanceof HttpMediaTypeNotSupportedException)     return ErrorCode.UNSUPPORTED_MEDIA_TYPE;
        if (ex instanceof HttpMediaTypeNotAcceptableException)     return ErrorCode.NOT_ACCEPTABLE;
        if (ex instanceof NoHandlerFoundException)                 return ErrorCode.ENDPOINT_NOT_FOUND;
        if (ex instanceof NoResourceFoundException)                return ErrorCode.ENDPOINT_NOT_FOUND;
        if (ex instanceof MaxUploadSizeExceededException)          return ErrorCode.PAYLOAD_TOO_LARGE;
        if (ex instanceof AsyncRequestTimeoutException)            return ErrorCode.REQUEST_TIMEOUT;
        if (ex instanceof MissingServletRequestParameterException) return ErrorCode.VALIDATION_FAILED;
        if (ex instanceof MissingRequestHeaderException)           return ErrorCode.VALIDATION_FAILED;

        // 其餘依狀態碼粗分
        int code = status.value();
        if (code == 400) return ErrorCode.MALFORMED_REQUEST;
        if (code == 404) return ErrorCode.ENDPOINT_NOT_FOUND;
        if (code == 413) return ErrorCode.PAYLOAD_TOO_LARGE;
        if (code == 422) return ErrorCode.VALIDATION_FAILED;
        if (code == 503) return ErrorCode.SERVICE_UNAVAILABLE;
        return ErrorCode.INTERNAL_ERROR;      // 500 系列（含 MissingPathVariable 等 bug）
    }

    /**
     * 安全的 detail：只使用「客戶端已經知道或有權知道」的資訊（03-rest-api 4.7.3）。
     * ⚠️ 絕不使用 ex.getMessage()，它可能含內部型別、SQL、路徑。
     */
    static String safeDetail(Exception ex) {
        if (ex instanceof HttpRequestMethodNotSupportedException e) {
            return "Method %s is not supported for this endpoint.".formatted(e.getMethod());
        }
        if (ex instanceof HttpMediaTypeNotSupportedException e) {
            return "Content-Type %s is not supported.".formatted(
                    e.getContentType() == null ? "(none)" : e.getContentType());
        }
        if (ex instanceof HttpMediaTypeNotAcceptableException) {
            return "No supported representation matches the Accept header.";
        }
        if (ex instanceof MissingServletRequestParameterException e) {
            return "Required query parameter '%s' is missing.".formatted(e.getParameterName());
        }
        if (ex instanceof MissingRequestHeaderException e) {
            return "Required header '%s' is missing.".formatted(e.getHeaderName());
        }
        if (ex instanceof MaxUploadSizeExceededException e) {
            return "Upload exceeds the maximum permitted size of %d bytes."
                    .formatted(e.getMaxUploadSize());
        }
        if (ex instanceof NoHandlerFoundException || ex instanceof NoResourceFoundException) {
            return "The requested endpoint does not exist.";
        }
        if (ex instanceof AsyncRequestTimeoutException) {
            return "The request took too long to complete.";
        }
        return null;      // ★ 不確定就不給 detail，好過洩漏
    }

    /** 擴充欄位：讓客戶端知道「正確的做法是什麼」。 */
    static Map<String, Object> extensionsOf(Exception ex) {
        Map<String, Object> m = new LinkedHashMap<>();
        if (ex instanceof HttpRequestMethodNotSupportedException e) {
            m.put("method", e.getMethod());
            if (e.getSupportedMethods() != null) {
                m.put("allowedMethods", java.util.List.of(e.getSupportedMethods()));
            }
        } else if (ex instanceof HttpMediaTypeNotSupportedException e) {
            m.put("supportedTypes", e.getSupportedMediaTypes().stream()
                    .map(Object::toString).toList());
        } else if (ex instanceof HttpMediaTypeNotAcceptableException e) {
            m.put("supportedTypes", e.getSupportedMediaTypes().stream()
                    .map(Object::toString).toList());
        } else if (ex instanceof MissingServletRequestParameterException e) {
            m.put("parameter", e.getParameterName());
        } else if (ex instanceof MissingRequestHeaderException e) {
            m.put("header", e.getHeaderName());
        } else if (ex instanceof MaxUploadSizeExceededException e) {
            m.put("maxBytes", e.getMaxUploadSize());
        }
        return m;
    }

    private SpringExceptionMapper() {}
}
```

**回應範例（405）**：

```http
HTTP/1.1 405 Method Not Allowed
Allow: GET, PATCH
Content-Type: application/problem+json
Cache-Control: no-store
```

```jsonc
{
  "type": "https://api.shop.example/problems/method-not-allowed",
  "title": "不支援此方法",
  "status": 405,
  "detail": "Method DELETE is not supported for this endpoint.",
  "instance": "/orders/ord_01J5GK",
  "code": "METHOD_NOT_ALLOWED",
  "userMessage": "操作方式有誤，請重新整理頁面後再試。",
  "retryable": false,
  "method": "DELETE",
  "allowedMethods": ["GET", "PATCH"],
  "traceId": "4f2c8a1e9b7d3f60",
  "timestamp": "2026-08-20T06:12:44Z"
}
```

**注意 `Allow` header 還在** —— 那是父類別 `handleHttpRequestMethodNotSupported` 放進去的，
我們的 `problemHeaders(base)` 保留了它。
**這很重要**：`Allow` 是 HTTP 規格對 405 的**強制要求**，
而且中介元件（API Gateway、快取）會讀它。

### 3.7.4 `ConstraintNameMapper`：把資料庫約束名對映到 `ErrorCode`

```java
package example.shop.common.web;

import example.shop.common.error.ErrorCode;
import org.springframework.dao.DataIntegrityViolationException;

import java.util.Locale;
import java.util.Map;

/**
 * 資料庫約束違反 → 業務錯誤碼。
 *
 * <p>這是「Service 預先檢查」失效時的最後防線（02 章 2.7.5 的 TOCTOU）。
 * 兩個並行請求同時通過預先檢查，其中一個會撞到 UNIQUE 約束 ——
 * 那時候回 409 而不是 500 才是對的。
 *
 * <p>⚠️ 前提：資料庫的約束必須有**有意義的名字**。
 * MySQL 自動產生的 {@code orders_ibfk_1} 沒有用。
 * 07-mysql 第 02 章會要求所有約束都手動命名。
 */
final class ConstraintNameMapper {

    private static final Map<String, ErrorCode> BY_CONSTRAINT = Map.ofEntries(
            Map.entry("uk_product_sku",          ErrorCode.PRODUCT_SKU_DUPLICATE),
            Map.entry("uk_order_number",         ErrorCode.INTERNAL_ERROR),   // 內部序號撞號 = bug
            Map.entry("uk_idempotency_key",      ErrorCode.IDEMPOTENCY_KEY_REUSED),
            Map.entry("uk_coupon_redemption",    ErrorCode.COUPON_ALREADY_USED),
            Map.entry("uk_customer_email",       ErrorCode.EMAIL_ALREADY_REGISTERED),
            Map.entry("ck_inventory_non_negative", ErrorCode.NEGATIVE_STOCK_NOT_ALLOWED),
            Map.entry("uk_address_change_daily", ErrorCode.ADDRESS_CHANGE_LIMIT_EXCEEDED)
    );

    static ErrorCode toErrorCode(DataIntegrityViolationException ex) {
        String text = extractConstraintText(ex);
        if (text != null) {
            String lower = text.toLowerCase(Locale.ROOT);
            for (var entry : BY_CONSTRAINT.entrySet()) {
                if (lower.contains(entry.getKey())) return entry.getValue();
            }
        }
        // ⚠️ 認不出來的約束 → 500。
        //    這是刻意的：未知的資料完整性違反代表我們漏了一個檢查，該告警。
        return ErrorCode.INTERNAL_ERROR;
    }

    /** 從例外鏈裡找出含約束名稱的訊息（Hibernate / JDBC driver 的格式各不相同）。 */
    private static String extractConstraintText(Throwable ex) {
        Throwable current = ex;
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 10 && current != null; i++) {
            if (current.getMessage() != null) sb.append(current.getMessage()).append(' ');
            if (current instanceof java.sql.SQLException sqlEx
                    && sqlEx.getNextException() != null) {
                sb.append(sqlEx.getNextException().getMessage()).append(' ');
            }
            if (current.getCause() == current) break;
            current = current.getCause();
        }
        return sb.isEmpty() ? null : sb.toString();
    }

    private ConstraintNameMapper() {}
}
```

⚠️ **「用字串比對例外訊息」不好，但沒有更好的辦法。**

Hibernate 有 `ConstraintViolationException.getConstraintName()`，
但它只在部分 dialect 上可靠。而 `SQLIntegrityConstraintViolationException` 
的訊息格式依 driver 而異。

**這件事的正確處理方式是：把它變成測試。**

```java
@Test
void 每個約束名稱都能被對映() {
    // 從 Flyway 的 migration 檔案掃出所有 UNIQUE / CHECK 約束名稱
    var declared = FlywayConstraintScanner.scan("db/migration");
    var mapped = ConstraintNameMapper.knownConstraints();

    assertThat(declared)
            .as("以下資料庫約束沒有對應的 ErrorCode，違反時會變成 500")
            .allSatisfy(name -> assertThat(mapped).contains(name));
}
```

（07-mysql 第 07 章會實作 Flyway 與這個掃描器。）

### 3.7.5 兩個必要的設定

```yaml
spring:
  mvc:
    problemdetails:
      enabled: false          # ★ 見下方說明
    throw-exception-if-no-handler-found: true
  web:
    resources:
      add-mappings: false

server:
  error:
    include-message: never
    include-binding-errors: never
    include-stacktrace: never
    include-exception: false
    whitelabel:
      enabled: false          # ★ 關掉 HTML 錯誤頁
```

**`spring.mvc.problemdetails.enabled=false` 為什麼？** ★

第 00 章的 `application.yml` 把它設成 `true`。**現在要改掉。**

`enabled=true` 時，Spring Boot 會註冊一個內部的 `@ControllerAdvice`
（`ProblemDetailsExceptionHandler`，繼承 `ResponseEntityExceptionHandler`），
它的 order 是 **0**。

而我們的 `ApiExceptionHandler` 用了 `@Order(Ordered.LOWEST_PRECEDENCE)`。

依 3.3.2 推論 2：**order 小的先被問** →
Boot 的 handler（order 0）先被問 → 它能處理所有 Spring 內建例外 → 
**我們的 override 永遠不會被呼叫**。

結果：405 / 415 / 400 全部回 Spring 的預設 `ProblemDetail`（沒有 `code`、沒有 `traceId`）。

**三種修法**：

| 修法 | 說明 |
|---|---|
| **A. `enabled=false`**（shop-service 選這個） | 只有我們的 advice。最單純 |
| B. 保留 `true`，我們的 advice 用 `@Order(-1)` | 我們先被問。但「兩個 advice 都繼承 `ResponseEntityExceptionHandler`」很容易搞混 |
| C. 保留 `true`，不繼承 `ResponseEntityExceptionHandler` | 讓 Boot 處理內建例外，我們只處理業務例外。❌ 但格式就分成兩種了 |

⚠️ **這個 order 值是實作細節，可能隨版本改變。**
**驗證方式**（30 秒）：

```bash
curl -s -X DELETE localhost:8080/orders/ord_1 | jq
```

看到 `"code": "METHOD_NOT_ALLOWED"` → 我們的 advice 生效 ✅
看到只有 `type/title/status/detail/instance` → Boot 的 handler 贏了 ❌

**把它變成測試**（07 章）：

```java
@Test
void Spring內建例外也要有我們的欄位() throws Exception {
    mockMvc.perform(delete("/orders/ord_1"))
           .andExpect(status().isMethodNotAllowed())
           .andExpect(jsonPath("$.code").value("METHOD_NOT_ALLOWED"))    // ★ 關鍵
           .andExpect(jsonPath("$.userMessage").isNotEmpty())            // ★ 關鍵
           .andExpect(jsonPath("$.traceId").isNotEmpty())                // ★ 關鍵
           .andExpect(header().exists("Allow"));
}
```

---

## 3.8 讓 404 / 405 / 415 全部走統一格式

### 3.8.1 為什麼 404 預設進不了 advice

打一個不存在的路徑：

```bash
curl -s localhost:8080/ordres | jq        # 打錯字
```

**Spring Boot 的預設行為**：

```
RequestMappingHandlerMapping 找不到 handler
  → 交給下一個 HandlerMapping
  → SimpleUrlHandlerMapping（靜態資源，因為 spring.web.resources.add-mappings 預設 true）
  → ResourceHttpRequestHandler 嘗試找 /static/ordres、/public/ordres…
  → 找不到 → response.sendError(404)         ← ⚠️ 不是拋例外！
  → 容器 forward 到 /error
  → BasicErrorController
```

**關鍵在 `sendError` 而不是拋例外** —— 所以 `@ExceptionHandler` 根本沒機會介入。

回應長這樣：

```json
{
  "timestamp": "2026-08-20T06:12:44.123+00:00",
  "status": 404,
  "error": "Not Found",
  "path": "/ordres"
}
```

**沒有 `code`、沒有 `traceId`。** 而且如果 `Accept: text/html`，會回一整頁 HTML。

### 3.8.2 兩個設定 + 一個版本差異

```yaml
spring:
  mvc:
    throw-exception-if-no-handler-found: true    # 拋 NoHandlerFoundException 而不是 sendError
  web:
    resources:
      add-mappings: false                        # 不要註冊「吃掉一切」的 resource handler
```

**兩個都要**，因為：

| 只設前者 | resource handler 還是會先接走，`NoHandlerFoundException` 不會被拋 |
| 只設後者 | 沒有 handler 時仍然是 `sendError(404)` |

⚠️ **Spring Boot 3.2（Spring Framework 6.1）的變化**：

`ResourceHttpRequestHandler` 現在會拋 **`NoResourceFoundException`**（`ErrorResponseException` 的子類）
而不是 `sendError`。所以在 Boot 3.2 上，即使 `add-mappings: true`，
404 也**會**進 advice（透過 `handleNoResourceFoundException`）。

**但仍然建議兩個設定都做**：
- `add-mappings: false` 讓純 API 服務少一個 handler mapping（微小的效能與明確性）。
- `throw-exception-if-no-handler-found: true` 在舊版與其他情境下才是可靠的。

⚠️ **`add-mappings: false` 的副作用**：Swagger UI 需要靜態資源！

如果你用 `springdoc-openapi-starter-webmvc-ui`，關掉 resource mapping 會讓
`/swagger-ui/index.html` 變成 404。

**解法：只在 API 路徑關閉，或改用 springdoc 的 webjars 設定。**
實務上最簡單的做法是**不要關 `add-mappings`**，只靠 Boot 3.2 的
`NoResourceFoundException` + `throw-exception-if-no-handler-found`。

**shop-service 的最終決定**（修正第 00 章的設定）：

```yaml
spring:
  mvc:
    throw-exception-if-no-handler-found: true
  web:
    resources:
      add-mappings: true        # ★ 保留（Swagger UI 需要）
                                #   Boot 3.2 的 NoResourceFoundException 會進 advice
server:
  error:
    whitelabel:
      enabled: false
```

並用測試守住行為，而不是相信設定：

```java
@Test
void 不存在的路徑回統一格式的404() throws Exception {
    mockMvc.perform(get("/ordres"))
           .andExpect(status().isNotFound())
           .andExpect(content().contentTypeCompatibleWith("application/problem+json"))
           .andExpect(jsonPath("$.code").value("ENDPOINT_NOT_FOUND"))
           .andExpect(jsonPath("$.traceId").isNotEmpty());
}

@Test
void 不存在的路徑帶Accept_html也回JSON() throws Exception {
    mockMvc.perform(get("/ordres").accept(MediaType.TEXT_HTML))
           .andExpect(status().isNotFound())
           .andExpect(content().contentTypeCompatibleWith("application/problem+json"));
}
```

⚠️ **第二個測試很重要。** 瀏覽器直接打 API 位址時 `Accept` 是 `text/html`，
如果回 HTML，前端的 `fetch` 在某些情況（例如使用者手動貼網址）會看到 HTML。
而且**內容協商失敗時 Spring 可能回 406 而不是 404** —— 這個測試會抓到。

### 3.8.3 「資源不存在」vs「端點不存在」

兩種 404 要用不同的 `code`：

| 情況 | `code` | 例子 |
|---|---|---|
| **路徑不存在** | `ENDPOINT_NOT_FOUND` | `GET /ordres`（打錯字） |
| **路徑存在，資源不存在** | `RESOURCE_NOT_FOUND` | `GET /orders/ord_不存在` |

**為什麼要分？** 因為客戶端的反應完全不同：

```typescript
if (problem.code === 'ENDPOINT_NOT_FOUND') {
  // 這是我們的 bug（URL 組錯了）→ 上報 Sentry
  Sentry.captureMessage(`Unknown endpoint: ${url}`, { level: 'error' });
} else if (problem.code === 'RESOURCE_NOT_FOUND') {
  // 這是正常的業務情況 → 顯示「找不到這筆資料」
  showEmptyState();
}
```

`RESOURCE_NOT_FOUND` 由 Service 拋：

```java
package example.shop.common.error;

/** 資源不存在。⚠️ 訊息刻意不透露「是否存在但無權存取」（防資源枚舉）。 */
public class ResourceNotFoundException extends BusinessException {

    public ResourceNotFoundException(String resourceType, String resourceId) {
        super(ErrorCode.RESOURCE_NOT_FOUND,
              "%s with id %s was not found.".formatted(resourceType, resourceId),
              null,
              ext("resourceType", resourceType, "resourceId", resourceId),
              new Object[0],
              java.util.List.of());
    }
}
```

⚠️ **一個重要的安全決策：「無權存取」也回 404，不回 403。** ★

```java
// Service 裡
Order order = orderRepository.findById(orderId)
        .orElseThrow(() -> new ResourceNotFoundException("Order", orderId));

if (!actor.canAccess(order)) {
    // ❌ 不要這樣
    // throw new AccessDeniedException("不是你的訂單");

    // ✅ 回 404，不透露「這張訂單存在」
    throw new ResourceNotFoundException("Order", orderId);
}
```

**理由**：403 等於告訴攻擊者「這個 ID 是有效的」。
他可以用它列舉出所有存在的訂單 ID（然後拿去做別的事）。

⚠️ **但這個決策有代價**：合法使用者遇到權限問題時看到「找不到」會很困惑
（例如客服 A 打開客服 B 的工單）。

**折衷做法**：
- **跨租戶／跨使用者** 的存取 → 404（防枚舉）。
- **同租戶內的角色權限不足**（例如一般客服想看 VIP 訂單）→ 403 + 清楚訊息。

判準：**「知道這個資源存在」本身是不是資訊洩漏？**

### 3.8.4 接管 `/error`（最後的安全網）

即使做完上面全部，還是有極少數情況會走到 `/error`：

- Filter 拋的例外沒被 catch（3.10.1 應該處理，但萬一漏了）
- advice 自己拋例外（3.3.6）
- 容器層級的錯誤（Tomcat 的 400 Bad Request，例如非法的 HTTP header）

**這些情況下 `BasicErrorController` 會接手，而它的格式不是我們的。**

```java
package example.shop.common.web;

import example.shop.common.error.ErrorCode;
import jakarta.servlet.RequestDispatcher;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.boot.web.servlet.error.ErrorController;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 取代 Spring Boot 的 BasicErrorController，讓「漏網的錯誤」也是 Problem JSON。
 *
 * <p>⚠️ 這是安全網，不是主要路徑。如果它被呼叫得很頻繁，代表 advice 有漏洞。
 * 所以它會記一個專門的指標（3.12.3）。
 */
@RestController
public class ApiErrorController implements ErrorController {

    private final ProblemFactory problems;
    private final ErrorLogger errorLog;

    public ApiErrorController(ProblemFactory problems, ErrorLogger errorLog) {
        this.problems = problems;
        this.errorLog = errorLog;
    }

    @RequestMapping(path = "${server.error.path:${error.path:/error}}",
                    produces = MediaType.APPLICATION_PROBLEM_JSON_VALUE)
    public ResponseEntity<Problem> handle(HttpServletRequest request) {

        int status = statusOf(request);
        String originalUri = (String) request.getAttribute(
                RequestDispatcher.FORWARD_REQUEST_URI);
        Throwable ex = (Throwable) request.getAttribute(
                RequestDispatcher.ERROR_EXCEPTION);

        ErrorCode code = switch (status) {
            case 400 -> ErrorCode.MALFORMED_REQUEST;
            case 401 -> ErrorCode.AUTHENTICATION_REQUIRED;
            case 403 -> ErrorCode.INSUFFICIENT_ROLE;
            case 404 -> ErrorCode.ENDPOINT_NOT_FOUND;
            case 405 -> ErrorCode.METHOD_NOT_ALLOWED;
            case 406 -> ErrorCode.NOT_ACCEPTABLE;
            case 413 -> ErrorCode.PAYLOAD_TOO_LARGE;
            case 415 -> ErrorCode.UNSUPPORTED_MEDIA_TYPE;
            case 429 -> ErrorCode.RATE_LIMIT_EXCEEDED;
            case 503 -> ErrorCode.SERVICE_UNAVAILABLE;
            default  -> status >= 500 ? ErrorCode.INTERNAL_ERROR : ErrorCode.MALFORMED_REQUEST;
        };

        Problem problem = problems.from(code,
                (originalUri != null) ? originalUri : request.getRequestURI(),
                null);

        // ★ 走到這裡代表 advice 沒接到 —— 記一個明顯的 log 以便修補
        errorLog.logErrorControllerFallback(status, originalUri, ex);

        return ResponseEntity.status(status)
                .contentType(MediaType.APPLICATION_PROBLEM_JSON)
                .cacheControl(org.springframework.http.CacheControl.noStore())
                .body(problem);
    }

    private int statusOf(HttpServletRequest request) {
        Object attr = request.getAttribute(RequestDispatcher.ERROR_STATUS_CODE);
        if (attr instanceof Integer i && i >= 400 && i <= 599) return i;
        return HttpStatus.INTERNAL_SERVER_ERROR.value();
    }
}
```

⚠️ **注意 `produces` 只宣告 `application/problem+json`。**
這代表瀏覽器帶 `Accept: text/html` 來時會**內容協商失敗**。

**兩種處理**：
1. 加上 `MediaType.ALL_VALUE`（一律回 JSON，不管 `Accept`）—— 純 API 服務的正確選擇。
2. 保留只有 JSON，接受瀏覽器直接訪問會拿到 406。

**shop-service 選 1**：

```java
    @RequestMapping(path = "${server.error.path:${error.path:/error}}")
    // ★ 不宣告 produces，一律回 JSON（純 API 服務）
```

⚠️ **實作 `ErrorController` 會取代 `BasicErrorController`**（因為
`ErrorMvcAutoConfiguration` 用 `@ConditionalOnMissingBean(ErrorController.class)`）。
所以 `server.error.include-*` 那些設定就不再有效 —— 因為它們是給 `BasicErrorController` 的。
**但仍然建議保留那些設定**，以防某天這個 bean 被移除。

---

## 3.9 JSON 解析錯誤的精確處理 ★

**這一節解決一個很實際的問題**：`HttpMessageNotReadableException` 的預設訊息對前端毫無幫助。

### 3.9.1 問題有多嚴重

```bash
curl -X POST localhost:8080/orders -H 'Content-Type: application/json' -d '{
  "items": [{"productId": "P-1", "quantity": "兩個"}],
  "shippingAddressId": "addr_1"
}'
```

Spring 預設回：

```json
{
  "type": "about:blank",
  "title": "Bad Request",
  "status": 400,
  "detail": "Failed to read request",
  "instance": "/orders"
}
```

**「Failed to read request」。** 前端不知道是哪個欄位、不知道為什麼。

而如果你（錯誤地）把 `ex.getMessage()` 放進 `detail`：

```
JSON parse error: Cannot deserialize value of type `java.lang.Integer` from String "兩個":
not a valid `java.lang.Integer` value; nested exception is
com.fasterxml.jackson.databind.exc.InvalidFormatException: Cannot deserialize value of
type `java.lang.Integer` from String "兩個": not a valid `java.lang.Integer` value
 at [Source: (org.springframework.util.StreamUtils$NonClosingInputStream); line: 2,
 column: 47] (through reference chain:
 example.shop.order.web.dto.CreateOrderRequest["items"]->java.util.ArrayList[0]
 ->example.shop.order.web.dto.CreateOrderRequest$Item["quantity"])
```

**它洩漏了**：完整的 Java 套件路徑、類別名、內部欄位名、Spring 的內部類別。
**而且前端還是得自己 parse 這一坨字串才能知道是哪個欄位。**

### 3.9.2 目標

```jsonc
{
  "type": "https://api.shop.example/problems/validation-failed",
  "title": "請求內容驗證失敗",
  "status": 422,
  "detail": "Request body failed validation: 1 field(s) rejected.",
  "instance": "/orders",
  "code": "VALIDATION_FAILED",
  "userMessage": "請檢查標示紅色的欄位。",
  "errors": [
    {
      "field": "items[0].quantity",
      "code": "TypeMismatch",
      "message": "必須是整數",
      "rejectedValue": "兩個"
    }
  ],
  "errorCount": 1,
  "traceId": "4f2c8a1e9b7d3f60"
}
```

**`field` 是 `items[0].quantity`** —— 和 Bean Validation 的格式完全一樣，
所以前端的標紅邏輯不用改。

### 3.9.3 Jackson 例外的階層

```
HttpMessageNotReadableException（Spring）
  └─ cause: JsonProcessingException（Jackson）
       ├─ JsonParseException            語法錯誤（少一個逗號、引號沒關）
       ├─ StreamConstraintsException     超過 StreamReadConstraints（02 章 2.11.3）
       └─ JsonMappingException          結構／型別問題
            ├─ MismatchedInputException      型別不符的基底
            │    ├─ InvalidFormatException        "兩個" → Integer
            │    ├─ InvalidTypeIdException        多型的 type id 未知（1.6.3）
            │    ├─ InvalidNullException          @JsonSetter(nulls=FAIL) 收到 null
            │    └─ ValueInstantiationException   建構子拋例外（record 的 compact ctor！）
            ├─ UnrecognizedPropertyException  未知欄位（02 章 2.11 的設定）
            └─ IgnoredPropertyException
```

**關鍵工具：`JsonMappingException.getPath()`** —— 它回傳 `List<Reference>`，
每個 `Reference` 有 `getFieldName()`（物件屬性）或 `getIndex()`（陣列索引）。

**把它組成 `items[0].quantity` 就是我們要的。**

### 3.9.4 `MessageNotReadableAnalyzer`

```java
package example.shop.common.web;

import com.fasterxml.jackson.core.JsonParseException;
import com.fasterxml.jackson.core.exc.StreamConstraintsException;
import com.fasterxml.jackson.databind.JsonMappingException;
import com.fasterxml.jackson.databind.exc.InvalidFormatException;
import com.fasterxml.jackson.databind.exc.InvalidTypeIdException;
import com.fasterxml.jackson.databind.exc.MismatchedInputException;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.fasterxml.jackson.databind.exc.ValueInstantiationException;
import example.shop.common.error.BusinessException;
import example.shop.common.error.FieldViolation;
import org.springframework.http.converter.HttpMessageNotReadableException;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 把 HttpMessageNotReadableException 翻譯成「精確的 field + 安全的訊息」。
 *
 * <p>絕不透傳 Jackson 的原始訊息（3.9.1 的洩漏問題）。
 */
public final class MessageNotReadableAnalyzer {

    /** 分析結果。violations 非空 → 回 422；為空 → 回 400 MALFORMED_REQUEST。 */
    public record Analysis(List<FieldViolation> violations,
                           String safeDetail,
                           Map<String, Object> extensions) {}

    public static Analysis analyze(HttpMessageNotReadableException ex) {
        Throwable cause = ex.getCause();

        // ── 情況 1：body 完全是空的 ─────────────────────────────
        if (cause == null) {
            return new Analysis(List.of(), "Request body is missing or empty.", Map.of());
        }

        // ── 情況 2：record 的 compact constructor 拋例外 ────────
        //    ⚠️ 這是最容易被忽略的一種：我們自己的正規化程式碼拋了例外
        if (cause instanceof ValueInstantiationException vie) {
            Throwable root = vie.getCause();
            if (root instanceof BusinessException) {
                // 讓 advice 用業務例外的路徑處理（保留 code 與擴充欄位）
                throw (BusinessException) root;
            }
            String path = pathOf(vie);
            return new Analysis(
                    List.of(new FieldViolation(path.isEmpty() ? null : path,
                            "Invalid", "資料格式不正確", null, null)),
                    "A value could not be constructed from the provided input.",
                    Map.of());
        }

        // ── 情況 3：型別不符（最常見）───────────────────────────
        if (cause instanceof InvalidFormatException ife) {
            String path = pathOf(ife);
            return new Analysis(
                    List.of(new FieldViolation(
                            path,
                            "TypeMismatch",
                            expectedTypeMessage(ife.getTargetType()),
                            ValueMasker.mask(path, ife.getValue()),
                            allowedValuesOf(ife))),
                    "A field value has the wrong type.",
                    Map.of());
        }

        // ── 情況 4：多型的 type id 未知（1.6.3）────────────────
        if (cause instanceof InvalidTypeIdException itie) {
            // ⚠️ Jackson 的訊息會列出所有已知 type id → 洩漏支援的付款方式清單。
            //    我們自己決定要不要列（這裡列，因為它是公開契約的一部分）。
            String path = pathOf(itie);
            return new Analysis(
                    List.of(new FieldViolation(
                            path.isEmpty() ? "method" : path,
                            "UnknownType",
                            "不支援的類型",
                            ValueMasker.mask(path, itie.getTypeId()),
                            Map.of("allowedValues", knownSubtypesOf(itie)))),
                    "The discriminator value is not recognised.",
                    Map.of());
        }

        // ── 情況 5：未知欄位 ────────────────────────────────────
        if (cause instanceof UnrecognizedPropertyException upe) {
            String path = pathOf(upe);
            List<String> known = upe.getKnownPropertyIds() == null ? List.of()
                    : upe.getKnownPropertyIds().stream().map(String::valueOf).sorted().toList();

            Map<String, Object> ext = new LinkedHashMap<>();
            ext.put("unknownProperty", path);
            ext.put("supportedProperties", known);
            String suggestion = DidYouMean.closest(upe.getPropertyName(), known);
            if (suggestion != null) ext.put("didYouMean", suggestion);

            return new Analysis(
                    List.of(new FieldViolation(path, "UnknownProperty",
                            suggestion == null ? "不支援的欄位"
                                    : "不支援的欄位，您是否想輸入「" + suggestion + "」？",
                            null, null)),
                    "The request body contains an unrecognised property.",
                    ext);
        }

        // ── 情況 6：結構不符（例如陣列給了物件）─────────────────
        if (cause instanceof MismatchedInputException mie) {
            String path = pathOf(mie);
            return new Analysis(
                    List.of(new FieldViolation(path.isEmpty() ? null : path,
                            "StructureMismatch", "資料結構不正確", null, null)),
                    "The request body structure does not match the expected schema.",
                    Map.of());
        }

        // ── 情況 7：超過解析限制（02 章 2.11.3）────────────────
        if (cause instanceof StreamConstraintsException) {
            return new Analysis(List.of(),
                    "The request body exceeds parser limits (nesting depth, "
                            + "string length or number length).",
                    Map.of());
        }

        // ── 情況 8：純語法錯誤 ──────────────────────────────────
        if (cause instanceof JsonParseException jpe) {
            var loc = jpe.getLocation();
            Map<String, Object> ext = (loc == null) ? Map.of()
                    : Map.of("line", loc.getLineNr(), "column", loc.getColumnNr());
            // ★ 只給位置，不給 Jackson 的訊息（訊息可能含 body 內容片段）
            return new Analysis(List.of(),
                    "The request body is not valid JSON.", ext);
        }

        // ── 其他 ───────────────────────────────────────────────
        return new Analysis(List.of(), "The request body could not be read.", Map.of());
    }

    /**
     * 把 JsonMappingException 的 path 組成 "items[0].quantity"。
     * 這是本類別的核心價值。
     */
    static String pathOf(JsonMappingException ex) {
        var sb = new StringBuilder();
        for (JsonMappingException.Reference ref : ex.getPath()) {
            if (ref.getFieldName() != null) {
                if (!sb.isEmpty()) sb.append('.');
                sb.append(ref.getFieldName());
            } else if (ref.getIndex() >= 0) {
                sb.append('[').append(ref.getIndex()).append(']');
            }
        }
        return sb.toString();
    }

    /** 目標型別 → 使用者看得懂的訊息（不洩漏 Java 型別名）。 */
    private static String expectedTypeMessage(Class<?> targetType) {
        if (targetType == null) return "資料格式不正確";
        if (Number.class.isAssignableFrom(targetType)
                || targetType.isPrimitive() && targetType != boolean.class) {
            if (targetType == Integer.class || targetType == int.class
                    || targetType == Long.class || targetType == long.class) {
                return "必須是整數";
            }
            return "必須是數字";
        }
        if (targetType == Boolean.class || targetType == boolean.class) return "必須是 true 或 false";
        if (targetType.isEnum())                                        return "不是有效的選項";
        if (java.time.temporal.Temporal.class.isAssignableFrom(targetType)) {
            return "日期時間格式不正確（請用 ISO-8601，例如 2026-08-20T06:12:44Z）";
        }
        if (CharSequence.class.isAssignableFrom(targetType))            return "必須是字串";
        return "資料格式不正確";
    }

    /** 列舉型別 → 合法值清單（讓客戶端知道能填什麼）。 */
    private static Map<String, Object> allowedValuesOf(InvalidFormatException ife) {
        Class<?> target = ife.getTargetType();
        if (target == null || !target.isEnum()) return null;
        var values = new ArrayList<String>();
        for (Object c : target.getEnumConstants()) values.add(((Enum<?>) c).name());
        return Map.of("allowedValues", values);
    }

    private static List<String> knownSubtypesOf(InvalidTypeIdException itie) {
        // Jackson 沒有公開 API 取得 known type ids，從 baseType 的 @JsonSubTypes 讀
        Class<?> base = (itie.getBaseType() == null) ? null : itie.getBaseType().getRawClass();
        if (base == null) return List.of();
        var subTypes = base.getAnnotation(com.fasterxml.jackson.annotation.JsonSubTypes.class);
        if (subTypes == null) return List.of();
        return java.util.Arrays.stream(subTypes.value())
                .map(com.fasterxml.jackson.annotation.JsonSubTypes.Type::name)
                .filter(n -> !n.isEmpty()).sorted().toList();
    }

    private MessageNotReadableAnalyzer() {}
}
```

### 3.9.5 「您是否想輸入」的實作

```java
package example.shop.common.web;

import java.util.List;
import java.util.Locale;

/** Levenshtein 距離的「你可能想打的是」建議。 */
final class DidYouMean {

    /** 最大可接受距離：太遠的建議只會讓人更困惑。 */
    private static final int MAX_DISTANCE = 3;
    private static final int MAX_CANDIDATE_LENGTH = 64;

    static String closest(String input, List<String> candidates) {
        if (input == null || input.isBlank() || candidates.isEmpty()) return null;
        if (input.length() > MAX_CANDIDATE_LENGTH) return null;        // ★ 防 DoS

        String needle = input.toLowerCase(Locale.ROOT);
        String best = null;
        int bestDistance = Integer.MAX_VALUE;

        for (String candidate : candidates) {
            if (candidate.length() > MAX_CANDIDATE_LENGTH) continue;
            int d = distance(needle, candidate.toLowerCase(Locale.ROOT), MAX_DISTANCE);
            if (d < bestDistance) {
                bestDistance = d;
                best = candidate;
            }
        }
        return (bestDistance <= MAX_DISTANCE) ? best : null;
    }

    /**
     * Levenshtein 距離，帶提前結束（超過 limit 就不必算完）。
     * ⚠️ 時間複雜度 O(n×m) —— 這就是為什麼要限制長度與候選數量。
     */
    static int distance(String a, String b, int limit) {
        int n = a.length();
        int m = b.length();
        if (Math.abs(n - m) > limit) return limit + 1;

        int[] prev = new int[m + 1];
        int[] curr = new int[m + 1];
        for (int j = 0; j <= m; j++) prev[j] = j;

        for (int i = 1; i <= n; i++) {
            curr[0] = i;
            int rowMin = curr[0];
            for (int j = 1; j <= m; j++) {
                int cost = (a.charAt(i - 1) == b.charAt(j - 1)) ? 0 : 1;
                curr[j] = Math.min(Math.min(curr[j - 1] + 1, prev[j] + 1), prev[j - 1] + cost);
                rowMin = Math.min(rowMin, curr[j]);
            }
            if (rowMin > limit) return limit + 1;       // ★ 提前結束
            int[] tmp = prev; prev = curr; curr = tmp;
        }
        return prev[m];
    }

    private DidYouMean() {}
}
```

**效果**（前端寫錯欄位名時）：

```jsonc
{
  "status": 422,
  "code": "VALIDATION_FAILED",
  "errors": [
    { "field": "custmerNote", "code": "UnknownProperty",
      "message": "不支援的欄位，您是否想輸入「customerNote」？" }
  ],
  "unknownProperty": "custmerNote",
  "supportedProperties": ["couponCode", "customerNote", "invoice", "items", "shippingAddressId"],
  "didYouMean": "customerNote"
}
```

**這個功能的投報率極高。** 它把「前端花 40 分鐘 debug」變成「看一眼就知道」。

⚠️ **但要注意兩件事**：

1. **`supportedProperties` 洩漏了 DTO 的完整欄位清單。**
   對公開 API 來說這是**好事**（那是契約，OpenAPI 也有）。
   但如果某些欄位是「只有內部角色能用」（例如 `internalNote`），
   列出來就等於告訴外部使用者「有這個欄位存在」。

   **處理方式**：對 4xx 的錯誤來說這是可接受的洩漏，
   因為那些欄位在 Service 層還有權限檢查。
   若不接受，就過濾清單（但那需要知道當前角色，比較麻煩）。

2. **Levenshtein 是 O(n×m)。** 沒有長度與數量限制就是 DoS 向量：
   送 100 個各 10,000 字元的未知欄位名 → 100 × 10,000 × 50 次運算。
   上面的 `MAX_CANDIDATE_LENGTH` 與提前結束就是防這個。

### 3.9.6 `ValueMasker`：回顯值的統一遮蔽

```java
package example.shop.common.web;

import java.util.Collection;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * rejectedValue 的遮蔽與截斷。與 02 章 ValidationErrorTranslator 共用同一份規則。
 */
public final class ValueMasker {

    private static final int MAX_LENGTH = 50;

    private static final List<String> SENSITIVE_HINTS = List.of(
            "password", "passwd", "pwd", "secret", "token", "apikey",
            "cardnumber", "cvv", "cvc", "pin", "ssn", "taxid",
            "nationalid", "idnumber", "privatekey", "authorization", "cookie");

    public static Object mask(String field, Object value) {
        if (value == null) return null;
        if (isSensitive(field)) return "***";

        if (value instanceof CharSequence cs) {
            String s = cs.toString();
            return (s.length() <= MAX_LENGTH) ? s : s.substring(0, MAX_LENGTH) + "…";
        }
        if (value instanceof Collection<?> c) return "（" + c.size() + " 個項目）";
        if (value instanceof Map<?, ?> m)     return "（" + m.size() + " 個項目）";
        if (value.getClass().isArray())       return "（陣列）";
        return value;
    }

    static boolean isSensitive(String field) {
        if (field == null) return false;
        String normalized = field.toLowerCase(Locale.ROOT).replace("_", "").replace("-", "");
        for (String hint : SENSITIVE_HINTS) {
            if (normalized.contains(hint.replace("_", ""))) return true;
        }
        return false;
    }

    private ValueMasker() {}
}
```

⚠️ **注意 `taxId` 也在遮蔽清單裡。** 統一編號是個資（可識別公司），
而且回顯它沒有幫助（使用者自己填的，他知道自己填了什麼）。

⚠️ **這個清單是「白名單的反面」，一定會漏。**
更安全的設計是**只回顯明確允許的欄位**：

```java
/** 更嚴格的替代方案：只有這些欄位可以回顯值。 */
private static final Set<String> ECHOABLE = Set.of(
        "quantity", "page", "size", "sort", "status", "productId", "orderId");
```

**shop-service 用「黑名單 + 長度截斷」**，理由：
白名單在 22 個 DTO、上百個欄位上維護成本太高，而且**漏掉白名單的後果是「訊息變差」，
漏掉黑名單的後果是「敏感資料外洩」** —— 所以黑名單要配一個測試：

```java
@Test
void 所有DTO裡疑似敏感的欄位都在遮蔽清單裡() {
    var suspicious = List.of("password", "cvv", "cardNumber", "token", "taxId", "secret");
    for (Class<?> dto : requestDtos()) {
        for (var rc : dto.getRecordComponents()) {
            for (String hint : suspicious) {
                if (rc.getName().toLowerCase().contains(hint.toLowerCase())) {
                    assertThat(ValueMasker.isSensitive(rc.getName()))
                            .as("%s.%s 看起來是敏感欄位但不會被遮蔽",
                                dto.getSimpleName(), rc.getName())
                            .isTrue();
                }
            }
        }
    }
}
```

---

## 3.10 Filter 層與 Security 的例外

### 3.10.1 `ProblemWriter`：讓 Filter 也能回 Problem JSON

第 00 章 0.8.2 說過：**Filter 拋的例外不會進 advice**。
所以 Filter 必須自己寫回應 —— 但**格式必須完全一致**。

```java
package example.shop.common.web;

import com.fasterxml.jackson.databind.ObjectMapper;
import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.util.Map;

/**
 * 在 DispatcherServlet 之外（Filter、Security handler）寫出 Problem JSON。
 *
 * <p>它和 advice 共用同一個 {@link ProblemFactory}，
 * 所以「錯誤格式只有一份」這件事在 filter 層也成立。
 */
@Component
public class ProblemWriter {

    private static final Logger log = LoggerFactory.getLogger(ProblemWriter.class);

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
        // ★ 已經開始寫回應就來不及了（第 00 章 0.8.2 情況 3）
        if (response.isCommitted()) {
            log.warn("回應已 committed，無法寫入錯誤 code={} traceId={}",
                     problem.code(), problem.traceId());
            return;
        }
        response.reset();
        response.setStatus(problem.status());
        response.setContentType(MediaType.APPLICATION_PROBLEM_JSON_VALUE);
        response.setCharacterEncoding("UTF-8");
        response.setHeader("Cache-Control", "no-store");
        // ★ 把 traceId 也放進 header，方便客服在瀏覽器 devtools 直接看到
        response.setHeader(ApiHeaders.TRACE_ID, problem.traceId());

        // 限流／認證的必要 header
        Object retryAfter = extensions.get("retryAfterSeconds");
        if (retryAfter instanceof Number n) {
            response.setHeader("Retry-After", String.valueOf(n.longValue()));
        }
        if (problem.status() == 401) {
            // ★ 401 依 RFC 9110 必須帶 WWW-Authenticate
            response.setHeader("WWW-Authenticate",
                    "Bearer realm=\"shop-api\", error=\"invalid_token\"");
        }

        objectMapper.writeValue(response.getOutputStream(), problem);
    }
}
```

**Filter 裡的用法**（2.11.2 的 `RequestSizeLimitFilter` 補完）：

```java
@Component
@Order(-118)
public class RequestSizeLimitFilter extends OncePerRequestFilter {

    private final long maxBytes;
    private final ProblemWriter problemWriter;

    public RequestSizeLimitFilter(ApiLimitProperties limits, ProblemWriter problemWriter) {
        this.maxBytes = limits.maxRequestBodyBytes();
        this.problemWriter = problemWriter;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res,
                                    FilterChain chain) throws ServletException, IOException {
        long declared = req.getContentLengthLong();
        if (declared > maxBytes) {
            problemWriter.write(req, res, ErrorCode.PAYLOAD_TOO_LARGE,
                    "Request body of %d bytes exceeds the limit of %d bytes."
                            .formatted(declared, maxBytes),
                    Map.of("maxBytes", maxBytes, "actualBytes", declared));
            return;                                  // ★ 不呼叫 chain.doFilter
        }
        if (declared < 0) {
            try {
                chain.doFilter(new SizeLimitedRequestWrapper(req, maxBytes), res);
            } catch (PayloadTooLargeException e) {
                problemWriter.write(req, res, ErrorCode.PAYLOAD_TOO_LARGE,
                        "Request body exceeds the limit of %d bytes.".formatted(maxBytes),
                        Map.of("maxBytes", maxBytes));
            }
            return;
        }
        chain.doFilter(req, res);
    }
}
```

⚠️ **`SizeLimitedRequestWrapper` 拋的例外會在哪裡被 catch？**
它在 `chain.doFilter` 的**內部**被拋（讀 body 時），
所以會沿著 filter chain 往外傳，被上面的 `catch (PayloadTooLargeException e)` 接到。

**但如果它在 `DispatcherServlet` 內部被拋**（Jackson 讀 body 時），
Spring 會把它包成 `HttpMessageNotReadableException` → 進 advice → 400。
**那個狀態碼是錯的（該是 413）。**

**修法：在 advice 裡處理這個情況。**

```java
@Override
protected ResponseEntity<Object> handleHttpMessageNotReadable(
        HttpMessageNotReadableException ex, HttpHeaders headers,
        HttpStatusCode status, WebRequest request) {

    // ★ 先看根因是不是我們的大小限制
    Throwable root = rootCauseOf(ex);
    if (root instanceof PayloadTooLargeException ptl) {
        Problem problem = problems.from(ErrorCode.PAYLOAD_TOO_LARGE, instanceOf(request),
                "Request body exceeds the limit.",
                Map.of("maxBytes", ptl.maxBytes()));
        return new ResponseEntity<>(problem, problemHeaders(headers),
                                    HttpStatus.PAYLOAD_TOO_LARGE);
    }
    // ... 3.7.2 的其餘邏輯
}
```

> **這個細節示範了一個通用模式**：
> **例外會被框架包裝，所以 handler 一定要往下鑽 cause 鏈。**
> 只看最外層的例外型別，會漏掉一半的情況。

### 3.10.2 Spring Security 的 401 / 403

```java
package example.shop.common.config;

import example.shop.common.error.ErrorCode;
import example.shop.common.web.ProblemWriter;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.AuthenticationEntryPoint;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.access.AccessDeniedHandler;

import java.util.Map;

/**
 * ⚠️ Security 的 401 / 403 由 filter 層產生，不會進 @RestControllerAdvice
 * （第 00 章 0.8.2 情況 2）。
 * 這裡用同一個 ProblemWriter 讓格式一致。
 *
 * <p>完整的 Security 設定在 09-spring-security；這裡只做「錯誤格式統一」這件事。
 */
@Configuration
public class SecurityErrorConfig {

    @Bean
    AuthenticationEntryPoint problemAuthenticationEntryPoint(ProblemWriter writer) {
        return (request, response, authException) -> {
            // ★ 區分「沒帶憑證」與「憑證無效」—— 客戶端的反應不同
            ErrorCode code = resolveAuthErrorCode(request, authException);
            writer.write(request, response, code,
                    "Authentication is required to access this resource.");
        };
    }

    private ErrorCode resolveAuthErrorCode(
            jakarta.servlet.http.HttpServletRequest request, Exception ex) {
        String header = request.getHeader("Authorization");
        if (header == null || header.isBlank()) {
            return ErrorCode.AUTHENTICATION_REQUIRED;          // 沒登入 → 導去登入頁
        }
        String name = ex.getClass().getSimpleName();
        if (name.contains("Expired"))  return ErrorCode.TOKEN_EXPIRED;   // → 刷新 token 重試
        if (name.contains("Revoked"))  return ErrorCode.TOKEN_REVOKED;   // → 強制重新登入
        return ErrorCode.INVALID_TOKEN;
    }

    @Bean
    AccessDeniedHandler problemAccessDeniedHandler(ProblemWriter writer) {
        return (request, response, ex) ->
                writer.write(request, response, ErrorCode.INSUFFICIENT_ROLE,
                        "The authenticated principal lacks the required authority.",
                        Map.of());
    }

    @Bean
    SecurityFilterChain apiSecurityFilterChain(
            HttpSecurity http,
            AuthenticationEntryPoint entryPoint,
            AccessDeniedHandler deniedHandler) throws Exception {

        return http
                .exceptionHandling(ex -> ex
                        .authenticationEntryPoint(entryPoint)
                        .accessDeniedHandler(deniedHandler))
                // ... 其餘設定在 09-spring-security
                .build();
    }
}
```

**`TOKEN_EXPIRED` 與 `INVALID_TOKEN` 分開的價值**：

```typescript
// 前端的攔截器
if (problem.code === 'TOKEN_EXPIRED') {
  await refreshToken();
  return retry(request);          // ★ 使用者完全不會感覺到
}
if (problem.code === 'INVALID_TOKEN' || problem.code === 'TOKEN_REVOKED') {
  redirectToLogin();              // 無法自動修復
}
if (problem.code === 'AUTHENTICATION_REQUIRED') {
  redirectToLogin({ returnTo: currentPath });
}
```

**如果三者都回 `401 Unauthorized` + 同一個 `code`**，
前端只能「一律導去登入頁」→ 使用者每小時被登出一次。

⚠️ **`resolveAuthErrorCode` 用 `getClass().getSimpleName().contains("Expired")` 是脆弱的。**
正式做法是在 JWT 驗證的 filter 裡把具體原因放進 request attribute，
然後在 entry point 讀它。（09-spring-security 第 05 章會這樣做。）
**這裡留著字串比對，是為了讓這一章不依賴還沒教的 Security 內容。**

### 3.10.3 Nginx 層的錯誤頁也要是 JSON

即使應用程式全部做對，**還有一層在應用程式外面**。

```nginx
server {
    listen 443 ssl;
    server_name api.shop.example;

    # ★ 讓 Nginx 自己產生的錯誤也是 JSON
    error_page 400 401 403 404 405 408 413 414 429 500 502 503 504 = @json_error;

    location @json_error {
        internal;
        default_type application/problem+json;
        # $upstream_http_x_trace_id 可能是空的（因為請求根本沒到後端）
        return 200 '{"type":"https://api.shop.example/problems/gateway-error","title":"閘道錯誤","status":$status,"detail":"The request was rejected by the API gateway.","code":"GATEWAY_ERROR","userMessage":"連線發生問題，請稍後再試。","retryable":true,"traceId":"$request_id"}';
    }

    client_max_body_size 2m;      # ★ 比應用層的 1 MB 寬鬆一點，讓應用層先回較好的訊息

    location / {
        proxy_pass http://shop-service;
        proxy_set_header X-Request-Id $request_id;      # ★ 04 章的 traceId 來源
        proxy_read_timeout 30s;
    }
}
```

⚠️ **`return 200` 那一行有問題**：它把所有錯誤都變成 200。

**正確寫法**（Nginx 的 `error_page ... = @loc` + `@loc` 裡不指定狀態碼時會保留原狀態）：

```nginx
    location @json_error {
        internal;
        default_type application/problem+json;
        # 不用 return，用一個變數化的內容並保留原狀態碼
        return $status '{"type":"...","status":$status,"code":"GATEWAY_ERROR",...}';
    }
```

⚠️ Nginx 的 `return` 第一個參數必須是字面的狀態碼，不能是變數。
**實務上有三種做法**：

| 做法 | 說明 |
|---|---|
| **為每個狀態碼寫一個 location**（囉唆但正確） | `error_page 413 = @error_413;` 各自 `return 413 '{...}'` |
| **用 `lua` / `njs` 模組** | 動態組 JSON，最靈活 |
| **靜態 JSON 檔案 + `error_page 413 /413.json;`** | 最簡單；狀態碼由 Nginx 保留 |

**shop-service 用第三種**：

```nginx
    error_page 400 /errors/400.json;
    error_page 413 /errors/413.json;
    error_page 429 /errors/429.json;
    error_page 502 503 504 /errors/50x.json;

    location ^~ /errors/ {
        internal;
        root /usr/share/nginx/html;
        default_type application/problem+json;
        add_header Cache-Control "no-store" always;
    }
```

```json
// /usr/share/nginx/html/errors/413.json
{
  "type": "https://api.shop.example/problems/payload-too-large",
  "title": "請求內容過大",
  "status": 413,
  "detail": "The request was rejected by the API gateway because it exceeded the size limit.",
  "code": "PAYLOAD_TOO_LARGE",
  "userMessage": "上傳的內容過大，請縮小後再試。",
  "retryable": false
}
```

⚠️ **靜態檔案沒有 `traceId`。** 這是可接受的取捨：
走到這一層的請求根本沒到應用程式，所以本來就沒有 trace。
但可以用 `add_header X-Request-Id $request_id always;` 讓客戶端至少有一個 ID。

### 3.10.4 四層的錯誤格式一致性檢查

| 層 | 產生錯誤的元件 | 格式來源 | 有 `traceId`？ |
|---|---|---|---|
| Nginx | `error_page` | 靜態 JSON 檔 | ⚠️ 只有 `X-Request-Id` header |
| Filter | `ProblemWriter` | `ProblemFactory` ✅ | ✅ |
| Security | `AuthenticationEntryPoint` / `AccessDeniedHandler` | `ProblemFactory` ✅ | ✅ |
| DispatcherServlet | `ApiExceptionHandler` | `ProblemFactory` ✅ | ✅ |
| `/error`（安全網） | `ApiErrorController` | `ProblemFactory` ✅ | ✅ |

**中間三層共用 `ProblemFactory`，這是「一份格式」的實作基礎。**

**用一個測試把它釘住**（07 章）：

```java
/**
 * 掃描所有錯誤路徑，驗證回應都符合 Problem 契約。
 * 這個測試是「錯誤格式一致性」的守門員。
 */
@ParameterizedTest
@MethodSource("errorScenarios")
void 所有錯誤回應都符合Problem契約(ErrorScenario scenario) throws Exception {
    mockMvc.perform(scenario.request())
           .andExpect(status().is(scenario.expectedStatus()))
           .andExpect(content().contentTypeCompatibleWith("application/problem+json"))
           .andExpect(jsonPath("$.type").isString())
           .andExpect(jsonPath("$.title").isString())
           .andExpect(jsonPath("$.status").value(scenario.expectedStatus()))
           .andExpect(jsonPath("$.code").value(scenario.expectedCode()))
           .andExpect(jsonPath("$.userMessage").isString())
           .andExpect(jsonPath("$.traceId").isString())
           .andExpect(jsonPath("$.timestamp").isString())
           .andExpect(header().string("Cache-Control", containsString("no-store")));
}

static Stream<ErrorScenario> errorScenarios() {
    return Stream.of(
        new ErrorScenario("404 路徑不存在", get("/ordres"), 404, "ENDPOINT_NOT_FOUND"),
        new ErrorScenario("405 方法不對", delete("/orders/ord_1"), 405, "METHOD_NOT_ALLOWED"),
        new ErrorScenario("415 Content-Type 不對",
                post("/orders").contentType(TEXT_PLAIN).content("x"), 415,
                "UNSUPPORTED_MEDIA_TYPE"),
        new ErrorScenario("406 Accept 不支援",
                get("/orders/ord_1").accept(APPLICATION_XML), 406, "NOT_ACCEPTABLE"),
        new ErrorScenario("400 JSON 語法錯",
                post("/orders").contentType(APPLICATION_JSON).content("{bad"), 400,
                "MALFORMED_REQUEST"),
        new ErrorScenario("422 驗證失敗",
                post("/orders").contentType(APPLICATION_JSON).content("{\"items\":[]}"), 422,
                "VALIDATION_FAILED"),
        new ErrorScenario("413 body 過大",
                post("/orders").contentType(APPLICATION_JSON).content("x".repeat(2_000_000)),
                413, "PAYLOAD_TOO_LARGE")
        // 409 / 500 等需要 mock Service，見 07 章
    );
}
```

---

## 3.11 5xx 的處理

### 3.11.1 `detail` 必須是固定文字

```java
// ProblemFactory 裡（3.6.3）
code.isServerError() ? serverErrorDetail() : detail
```

```java
private String serverErrorDetail() {
    return "An unexpected error occurred. Provide the traceId when contacting support.";
}
```

**為什麼？** 因為 5xx 的原因**必然**來自內部：

| 例外 | `getMessage()` 會洩漏 |
|---|---|
| `SQLException` | 資料表名、欄位名、SQL 語句、約束名 |
| `ConnectException` | 內部 IP 與 port |
| `FileNotFoundException` | 伺服器檔案系統路徑 |
| `ClassNotFoundException` | 套件結構 |
| `NullPointerException`（Java 14+ 的 helpful NPE） | **變數名與方法呼叫鏈** |

最後一個特別值得注意。Java 14+ 的 helpful NullPointerException：

```
Cannot invoke "example.shop.order.domain.Order.getCustomer()" because the return value of
"example.shop.order.repository.OrderRepository.findById(String)" is null
```

**它洩漏了完整的內部類別結構與方法名。**

⚠️ 這個功能在 Java 15+ **預設開啟**（`-XX:+ShowCodeDetailsInExceptionMessages`）。
它對 log 很有價值，所以**不要關掉它** —— 只要確保它不會出現在回應裡。

### 3.11.2 完整的資訊洩漏檢查清單

```
□ Problem 的 detail 是固定文字（5xx）
□ Problem 的 userMessage 不含任何內部術語（3.4.5 有測試）
□ 沒有 stack / trace / exception 欄位
□ server.error.include-stacktrace = never
□ server.error.include-message = never
□ server.error.include-exception = false
□ server.error.include-binding-errors = never
□ Whitelabel error page 已關閉
□ 我們的 ApiErrorController 取代了 BasicErrorController
□ Nginx 的錯誤頁不含 upstream 資訊（不要用 $upstream_addr）
□ 回應 header 沒有 Server: Apache-Coyote/1.1（見下方）
□ 沒有 X-Application-Context header（Boot 1.x 的遺留）
□ /actuator/env、/actuator/heapdump 沒有對外開放
□ Swagger UI 在正式環境關閉（或需要認證）
```

**移除 `Server` header**：

```yaml
server:
  server-header:                # 空值 = 不送 Server header
```

或程式化（更可靠）：

```java
@Bean
org.springframework.boot.web.server.WebServerFactoryCustomizer
        <org.springframework.boot.web.embedded.tomcat.TomcatServletWebServerFactory>
        tomcatCustomizer() {
    return factory -> factory.addConnectorCustomizers(connector -> {
        connector.setProperty("server", "");
        // ★ 也關掉 Tomcat 的 X-Powered-By（如果有裝 HttpHeaderSecurityFilter）
    });
}
```

⚠️ **`Server` header 本身不是嚴重漏洞**，但它讓攻擊者能快速篩選
「哪些站台跑特定版本的 Tomcat」，也就是**自動化掃描的過濾條件**。
移除它是成本極低的縱深防禦。

### 3.11.3 一個真實的洩漏測試

```java
package example.shop.common.web;

/**
 * 資訊洩漏迴歸測試。
 *
 * <p>這個測試的價值在於：它會在有人「為了方便除錯」把例外訊息加回回應時失敗。
 * 而那件事在急著查線上問題時很容易發生。
 */
@WebMvcTest(OrderController.class)
class ErrorLeakageTest {

    @Autowired MockMvc mockMvc;
    @MockitoBean OrderService orderService;

    private static final List<String> FORBIDDEN_SUBSTRINGS = List.of(
            "example.shop",          // 套件名
            "org.springframework",   // 框架內部
            "org.hibernate",
            "com.mysql",
            "java.lang",
            "SELECT", "select ", "insert into", "update ", "delete from",
            "t_order", "t_product",  // 資料表名
            "Exception", "exception",
            "at ",                   // stack trace 的行首
            "Caused by",
            "jdbc:", "10.", "192.168.", "127.0.0.1",
            "/Users/", "/home/", "/opt/", "C:\\"
    );

    @ParameterizedTest
    @MethodSource("internalFailures")
    void 系統錯誤不洩漏任何內部資訊(String name, Throwable failure) throws Exception {
        when(orderService.create(any())).thenThrow(failure);

        String body = mockMvc.perform(post("/orders")
                        .header("Idempotency-Key", "k-1")
                        .contentType(APPLICATION_JSON)
                        .content(VALID_ORDER_JSON))
                .andExpect(status().isInternalServerError())
                .andExpect(jsonPath("$.code").value("INTERNAL_ERROR"))
                .andExpect(jsonPath("$.traceId").isNotEmpty())
                .andExpect(jsonPath("$.stackTrace").doesNotExist())
                .andExpect(jsonPath("$.trace").doesNotExist())
                .andExpect(jsonPath("$.exception").doesNotExist())
                .andReturn().getResponse().getContentAsString();

        for (String forbidden : FORBIDDEN_SUBSTRINGS) {
            assertThat(body)
                    .as("情境「%s」的回應洩漏了「%s」：\n%s", name, forbidden, body)
                    .doesNotContain(forbidden);
        }
    }

    static Stream<Arguments> internalFailures() {
        return Stream.of(
            Arguments.of("SQL 錯誤", new org.springframework.dao.DataIntegrityViolationException(
                    "could not execute statement; SQL [insert into t_order (customer_id) "
                    + "values (?)]; constraint [uk_order_number]")),
            Arguments.of("連線失敗", new org.springframework.dao.DataAccessResourceFailureException(
                    "Unable to acquire JDBC Connection: jdbc:mysql://10.20.3.41:3306/shop")),
            Arguments.of("helpful NPE", new NullPointerException(
                    "Cannot invoke \"example.shop.order.domain.Order.getCustomer()\" "
                    + "because the return value of "
                    + "\"example.shop.order.repository.OrderRepository.findById(String)\" is null")),
            Arguments.of("檔案路徑", new java.io.UncheckedIOException(
                    new java.io.FileNotFoundException("/opt/shop/config/secrets.yml"))),
            Arguments.of("上游錯誤", new org.springframework.web.client.HttpServerErrorException(
                    HttpStatus.BAD_GATEWAY, "erp.internal returned 502")),
            Arguments.of("StackOverflow", new StackOverflowError()),
            Arguments.of("斷言失敗", new AssertionError("orderId should not be null"))
        );
    }
}
```

⚠️ **`"java.lang"` 在禁止清單裡** —— 這會抓到「把例外類別名放進回應」的情況。
但要小心：如果你的錯誤訊息裡剛好有 `java.lang` 這個字串（不太可能），測試會誤報。

⚠️ **`"at "` 這一項會誤報**，例如 `userMessage` 是英文的
`"Please try again at a later time"`。
**實務處理**：把 `"at "` 改成更精確的 stack trace 模式：

```java
assertThat(body).doesNotMatch("(?s).*\\bat [a-z]+(\\.[a-zA-Z0-9_$]+)+\\(.*");
```

### 3.11.4 `Error` 的處理

3.3.1 說過 `DispatcherServlet` 會 catch `Throwable` 並包成 `ServletException`。
所以 3.7.2 的 catch-all 宣告 `Throwable.class`：

```java
@ExceptionHandler(Throwable.class)
public ResponseEntity<Problem> handleUnexpected(Throwable ex, ...) { ... }
```

⚠️ **但 `OutOfMemoryError` 是特例。**

```java
// OOM 發生時，這段程式碼本身可能也會 OOM
Problem problem = problems.from(ErrorCode.INTERNAL_ERROR, ...);   // 配置物件
objectMapper.writeValue(...);                                      // 配置 buffer
```

**JVM 已經沒有記憶體了，你什麼都做不了。** 正確的做法是**讓程序死掉並重啟**：

```yaml
# JVM 參數（在 Dockerfile 或啟動腳本裡）
JAVA_OPTS: >-
  -XX:+ExitOnOutOfMemoryError
  -XX:+HeapDumpOnOutOfMemoryError
  -XX:HeapDumpPath=/var/log/shop/heapdump.hprof
```

**`-XX:+ExitOnOutOfMemoryError` 讓 JVM 在 OOM 時立刻退出**，
由 Kubernetes / systemd 重啟。

**為什麼這比「嘗試處理」好？**
OOM 之後 JVM 處於不確定狀態：某些執行緒可能已經死在一半的操作上，
連線池可能有洩漏的連線，快取可能不一致。
**繼續跑的服務會產生錯誤的結果，而那比停機更糟。**

⚠️ **`StackOverflowError` 不同** —— 它是局部的（單一執行緒的堆疊爆掉），
處理它是安全的（堆疊已經退回來了）。所以 catch-all 接到它並回 500 是對的。

### 3.11.5 `HttpMessageNotWritableException`：回應序列化失敗

這是最麻煩的一種 5xx，因為**回應可能已經開始寫了**。

```java
public record OrderDetail(
    String orderId,
    Customer customer          // ← Customer 裡有 orders 欄位 → 循環參照
) {}
```

Jackson 序列化到一半發現循環 → 拋例外 → 但前面 2 KB 的 JSON **已經寫進 socket**。

```
{"orderId":"ord_1","customer":{"customerId":"cus_1","orders":[{"orderId":"ord_1","customer":{...
（然後連線斷掉或補上一段錯誤 JSON）
```

**客戶端拿到損毀的 JSON。** 而且 `response.isCommitted()` 已經是 `true`，
`ProblemWriter` 什麼也做不了。

**三層防護**：

**① 序列化往記憶體 buffer，不直接往 socket。**

⚠️ Spring 預設就會這樣做嗎？不一定。
`MappingJackson2HttpMessageConverter` 有一個屬性：

```java
@Bean
MappingJackson2HttpMessageConverter jacksonConverter(ObjectMapper objectMapper) {
    var converter = new MappingJackson2HttpMessageConverter(objectMapper);
    // ⚠️ 這會讓大回應佔用更多記憶體，但保證序列化失敗時還能改回應
    //    Spring 的預設行為依版本而異，明確設定較安全
    return converter;
}
```

實務上更可靠的做法是**開啟回應 buffer**（讓 Tomcat 緩衝）：

```yaml
server:
  tomcat:
    # 回應 buffer 大小；小於這個大小的回應不會提前 flush
    # ⚠️ 屬性名依 Boot 版本而異，請以你的版本的 configuration metadata 為準
    max-http-response-header-size: 8KB
```

**② 用測試預防（最有效）。**

```java
/**
 * 每個 Response DTO 都必須能被序列化。
 * 這個測試抓循環參照、無法序列化的型別、缺少 Jackson module 等問題。
 */
@Test
void 所有ResponseDTO都能序列化() {
    for (Class<?> dto : responseDtos()) {
        Object sample = SampleFactory.create(dto);      // 用反射填滿假資料
        assertThatCode(() -> objectMapper.writeValueAsString(sample))
                .as("%s 無法序列化", dto.getSimpleName())
                .doesNotThrowAnyException();
    }
}
```

**③ ArchUnit：Response DTO 不可依賴 Entity。**

```java
@Test
void 回應DTO不可依賴entity() {
    noClasses().that().resideInAPackage("..web.dto..")
        .should().dependOnClassesThat().resideInAPackage("..domain..")
        .orShould().dependOnClassesThat().resideInAPackage("..entity..")
        .because("DTO 依賴 Entity 會帶進 lazy 關聯與雙向參照（03-rest-api 3.2）")
        .check(classes);
}
```

⚠️ 這條規則可能太嚴格（DTO 常常需要 `OrderStatus` 這種 enum）。
實務上改成「不可依賴標註 `@Entity` 的類別」：

```java
    noClasses().that().resideInAPackage("..web.dto..")
        .should().dependOnClassesThat().areAnnotatedWith(jakarta.persistence.Entity.class)
```

---

## 3.12 錯誤的日誌與指標

### 3.12.1 分級規則

**這張表決定了值班工程師會不會被半夜叫起來。**

| 狀態碼 | 等級 | 印 stack trace？ | 告警？ | 理由 |
|---|---|---|---|---|
| 400 / 415 / 406 | `debug` | ❌ | ❌ | 客戶端 bug，數量大，通常不需要人看 |
| 401 / 403 | `debug` | ❌ | ❌ | 但**暴增**要告警（可能是攻擊，3.12.4） |
| 404 | `debug` | ❌ | ❌ | 掃描流量會產生大量 404 |
| 409 / 422 | `info` | ❌ | ❌ | 正常的業務結果，但值得統計 |
| 429 | `info` | ❌ | ❌ | 限流生效是好事；**暴增**要看 |
| 5xx（已分類，如 `UPSTREAM_ERROR`） | `error` | ⚠️ 只印根因訊息 | ✅ | 外部依賴問題 |
| 5xx（`INTERNAL_ERROR` catch-all） | `error` | ✅ 完整 | ✅ **高優先** | **這是 bug** |

**兩個關鍵決策：**

**① 4xx 不印 stack trace。** 因為：

```
一個掃描機器人每秒打 200 個 404
× 每個 stack trace 約 40 行 × 每行約 80 bytes
= 每秒 640 KB 的日誌
= 每天 55 GB
```

**日誌成本比服務本身還貴**，而且真正重要的錯誤被淹沒。

**② 4xx 用 `debug` 而不是 `warn`。**

03-rest-api 第 04 章 4.12.3 建議 4xx 用 `warn`。**這裡刻意調整成 `debug`**，理由是實務經驗：
`warn` 在大部分日誌設定裡是預設輸出的，而 4xx 的量太大。

**但這樣就查不到「某個使用者為什麼一直 422」了。** 解法是**取樣 + 有條件提升**：

```java
package example.shop.common.web;

import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.context.request.ServletWebRequest;
import org.springframework.web.context.request.WebRequest;
import org.springframework.web.method.HandlerMethod;

import java.util.Objects;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 錯誤日誌與指標的唯一出口。
 *
 * <p>把「什麼錯誤該用什麼等級記」集中在這裡，
 * 避免 3.2.2 損失 1 的「監控失效」與 3.12.1 的「日誌爆量」同時發生。
 */
@Component
public class ErrorLogger {

    private static final Logger log = LoggerFactory.getLogger("example.shop.api.error");

    /** 4xx 的取樣分母：每 N 筆記一筆完整資訊。 */
    private static final int CLIENT_ERROR_SAMPLE_RATE = 20;

    private final AtomicLong clientErrorCounter = new AtomicLong();
    private final MeterRegistry meterRegistry;

    public ErrorLogger(MeterRegistry meterRegistry) {
        this.meterRegistry = meterRegistry;
    }

    // ── 業務例外（4xx 為主）────────────────────────────────────────

    public void log(BusinessException ex, Problem problem,
                    HttpServletRequest request, HandlerMethod handlerMethod) {

        recordMetric(problem, handlerMethod);

        ErrorCode code = ex.errorCode();
        if (code.isServerError()) {
            log.error("業務例外(5xx) code={} status={} endpoint={} traceId={} detail={}",
                    code, problem.status(), endpointOf(handlerMethod),
                    problem.traceId(), ex.getMessage(), ex);
            return;
        }

        // 409 / 422 等「有業務意義」的錯誤 → info，方便觀察趨勢
        if (problem.status() == 409 || problem.status() == 422 || problem.status() == 402) {
            log.info("業務例外 code={} status={} endpoint={} traceId={} detail={}",
                    code, problem.status(), endpointOf(handlerMethod),
                    problem.traceId(), ex.getMessage());
            return;
        }

        // 其餘 4xx → debug + 取樣
        if (shouldSample()) {
            log.debug("客戶端錯誤 code={} status={} endpoint={} traceId={} detail={}",
                    code, problem.status(), endpointOf(handlerMethod),
                    problem.traceId(), ex.getMessage());
        }
    }

    // ── 驗證錯誤 ──────────────────────────────────────────────────

    public void logValidation(Exception ex, Problem problem, WebRequest request) {
        recordMetric(problem, null);

        // ★ 驗證錯誤要記「哪些欄位」—— 這是前端 bug 的直接線索
        String fields = (problem.errors() == null) ? "" : problem.errors().stream()
                .map(v -> Objects.requireNonNullElse(v.field(), "(global)"))
                .distinct().limit(10)
                .reduce((a, b) -> a + "," + b).orElse("");

        log.info("驗證失敗 endpoint={} fields=[{}] count={} traceId={}",
                pathOf(request), fields, problem.errorCount(), problem.traceId());
    }

    // ── 其他客戶端錯誤 ────────────────────────────────────────────

    public void logClientError(Exception ex, Problem problem, WebRequest request) {
        recordMetric(problem, null);
        if (shouldSample()) {
            log.debug("客戶端錯誤 code={} status={} endpoint={} exception={} traceId={}",
                    problem.code(), problem.status(), pathOf(request),
                    ex.getClass().getSimpleName(), problem.traceId());
        }
    }

    // ── 資料完整性違反（Service 漏了檢查）──────────────────────────

    public void logIntegrityViolation(Exception ex, Problem problem,
                                      HttpServletRequest request) {
        recordMetric(problem, null);
        // ⚠️ warn 而不是 debug：這代表「Service 的預先檢查沒攔到」，值得看一眼
        //    但 ex.getMessage() 只進 log，絕不進回應（3.11.1）
        log.warn("資料完整性違反 code={} endpoint={} traceId={} constraint={}",
                problem.code(), request == null ? "?" : request.getRequestURI(),
                problem.traceId(), ex.getMessage());
    }

    // ── 伺服器錯誤 ────────────────────────────────────────────────

    public void logServerError(Throwable ex, Problem problem, HttpServletRequest request,
                               HandlerMethod handlerMethod, String category) {
        recordMetric(problem, handlerMethod);

        meterRegistry.counter("shop.api.server_errors",
                "category", category,
                "exception", ex.getClass().getSimpleName(),
                "endpoint", endpointOf(handlerMethod)).increment();

        // ★ 完整 stack trace —— 這是唯一需要它的地方
        log.error("伺服器錯誤 category={} code={} endpoint={} method={} traceId={}",
                category, problem.code(),
                request == null ? "?" : request.getRequestURI(),
                request == null ? "?" : request.getMethod(),
                problem.traceId(), ex);
    }

    // ── /error fallback（代表 advice 有漏洞）───────────────────────

    public void logErrorControllerFallback(int status, String uri, Throwable ex) {
        meterRegistry.counter("shop.api.error_controller_fallback",
                "status", String.valueOf(status)).increment();

        // ⚠️ 這條 log 出現代表 advice 沒接到 → 應該加 handler
        if (ex != null) {
            log.error("走到 /error fallback（advice 未處理）status={} uri={}", status, uri, ex);
        } else {
            log.warn("走到 /error fallback（容器層錯誤）status={} uri={}", status, uri);
        }
    }

    // ── 工具 ─────────────────────────────────────────────────────

    private void recordMetric(Problem problem, HandlerMethod handlerMethod) {
        // ★ 只用低基數標籤（3.12.3）
        Counter.builder("shop.api.errors")
                .tag("code", problem.code())
                .tag("status", String.valueOf(problem.status()))
                .tag("endpoint", endpointOf(handlerMethod))
                .register(meterRegistry)
                .increment();
    }

    /** ★ 用 Controller#method 當 endpoint 標籤，而不是 URI（避免路徑變數造成高基數）。 */
    private String endpointOf(HandlerMethod handlerMethod) {
        if (handlerMethod == null) return "unknown";
        return handlerMethod.getBeanType().getSimpleName() + "#" + handlerMethod.getMethod().getName();
    }

    private String pathOf(WebRequest request) {
        if (request instanceof ServletWebRequest swr) return swr.getRequest().getRequestURI();
        return "?";
    }

    private boolean shouldSample() {
        return clientErrorCounter.incrementAndGet() % CLIENT_ERROR_SAMPLE_RATE == 0;
    }
}
```

### 3.12.2 客戶端斷線不該記 error

一個很常見的日誌污染來源：

```
org.springframework.web.context.request.async.AsyncRequestNotUsableException:
ServletOutputStream failed to write: java.io.IOException: Broken pipe
```

**這是使用者關掉瀏覽器分頁**（或 App 被切到背景）。
它不是 bug，但預設會被記成 `error` 並觸發告警。

**兩層處理：**

```java
/** 客戶端主動斷線 → 不記 error、不告警、不回應（連線已斷，寫什麼都沒用）。 */
@ExceptionHandler({
    org.springframework.web.context.request.async.AsyncRequestNotUsableException.class,
    ClientAbortException.class                      // Tomcat 的
})
public void handleClientAbort(Exception ex, HttpServletRequest request) {
    meterRegistry.counter("shop.api.client_aborts",
            "endpoint", request.getRequestURI()).increment();
    log.debug("客戶端斷線 uri={} exception={}",
            request.getRequestURI(), ex.getClass().getSimpleName());
    // ★ 回 void：不嘗試寫回應
}
```

⚠️ **`ClientAbortException` 在 `org.apache.catalina.connector` 套件**，
直接 import 它會讓你的程式碼綁在 Tomcat 上。

**更乾淨的做法是用訊息判斷**（雖然醜）：

```java
@ExceptionHandler(java.io.IOException.class)
public ResponseEntity<Problem> handleIoException(IOException ex,
                                                 HttpServletRequest request,
                                                 HandlerMethod handlerMethod) {
    if (isClientAbort(ex)) {
        log.debug("客戶端斷線 uri={}", request.getRequestURI());
        return null;                    // ★ 回 null → DispatcherServlet 視為未處理
    }
    // 真正的 I/O 錯誤 → 500
    Problem problem = problems.from(ErrorCode.INTERNAL_ERROR,
            ProblemFactory.instanceOf(request), null);
    errorLog.logServerError(ex, problem, request, handlerMethod, "io");
    return respond(problem, new HttpHeaders());
}

/** 判斷是否為客戶端斷線（各容器的訊息不同，所以列舉常見字樣）。 */
private static boolean isClientAbort(Throwable ex) {
    String message = ex.getMessage();
    if (message == null) return false;
    String m = message.toLowerCase(java.util.Locale.ROOT);
    return m.contains("broken pipe")
            || m.contains("connection reset by peer")
            || m.contains("connection was aborted")
            || m.contains("an established connection was aborted");
}
```

⚠️ **`return null` 的語意**：`ExceptionHandlerExceptionResolver` 會把它當成
「這個 handler 沒有產生回應」，然後**繼續往下找**。
實務上這會導致例外進到 `/error`。

**更直接的做法是回 `ResponseEntity` 但用一個特殊狀態碼**：

```java
    if (isClientAbort(ex)) {
        log.debug("客戶端斷線 uri={}", request.getRequestURI());
        // 499 是 Nginx 的非標準碼「Client Closed Request」，寫進 access log 但客戶端收不到
        return ResponseEntity.status(499).build();
    }
```

**shop-service 用這個做法**，因為它讓 access log 上能清楚看到「這是斷線不是錯誤」。

### 3.12.3 指標的基數問題 ★

```java
// ❌ 高基數：URI 含路徑變數
meterRegistry.counter("shop.api.errors", "uri", request.getRequestURI())
```

`/orders/ord_01J5GK...` 每一張訂單都是一個新的標籤值。
**100 萬張訂單 = 100 萬個時間序列。**

**後果**（真實事故）：
```
Prometheus 記憶體從 4 GB 漲到 38 GB → OOM → 整個監控系統掛掉
而且它在掛掉前的 3 小時裡查詢全部超時，所以沒人看到警訊
```

**基數上限的估算**：

```
時間序列數 = 指標數 × 標籤1的值數 × 標籤2的值數 × …
```

`shop.api.errors` 的標籤：

| 標籤 | 可能值數 | 說明 |
|---|---|---|
| `code` | 78 | `ErrorCode` 的常數數量（有上限，3.4.5 有測試） |
| `status` | ~15 | HTTP 狀態碼 |
| `endpoint` | ~90 | Controller#method（有限） |

**最壞 78 × 15 × 90 = 105,300 個序列。** 還是有點多。

⚠️ **但實際上遠少於此**，因為 `code` 與 `status` 是一對一的
（`ErrorCode` 決定狀態碼），而每個端點只會產生少數幾種錯誤。
**實測約 400～800 個序列。** 可接受。

**如果要更保守，拿掉 `endpoint`**：

```java
Counter.builder("shop.api.errors")
        .tag("code", problem.code())          // 78
        .tag("status", ...)                    // 冗餘，但方便查詢
        .register(meterRegistry)
```

→ 78 個序列。而「哪個端點出錯」改用 Micrometer 內建的
`http_server_requests_seconds_count{uri, status, outcome, exception}` 查
（Spring Boot 自動用 **路徑模板**當 `uri` 標籤，例如 `/orders/{orderId}`，所以基數是安全的）。

> **經驗法則：自訂指標的標籤只用「你自己定義的有限列舉」。**
> 任何來自使用者輸入的值（URI、參數值、header 值、使用者 ID）都不能當標籤。

### 3.12.4 告警規則

```yaml
# prometheus/rules/shop-api-errors.yml
groups:
  - name: shop-api-errors
    rules:

      # ── 1. 未預期的 500 ★ 最高優先 ────────────────────────
      - alert: ShopApiUnexpectedErrors
        expr: |
          sum(rate(shop_api_server_errors_total{category="unexpected"}[5m])) > 0.05
        for: 2m
        labels:
          severity: critical
          team: backend
        annotations:
          summary: "shop-service 出現未預期的例外（{{ $value | humanize }}/s）"
          description: >-
            catch-all handler 被觸發，代表有未處理的 bug。
            查詢：{traceId} 在 Loki 搜尋 "伺服器錯誤 category=unexpected"
          runbook: https://wiki.example/runbook/shop-api-unexpected-errors

      # ── 2. 整體 5xx 比率 ─────────────────────────────────
      - alert: ShopApiHighErrorRate
        expr: |
          (
            sum(rate(http_server_requests_seconds_count{
                  application="shop-service", status=~"5.."}[5m]))
            /
            sum(rate(http_server_requests_seconds_count{application="shop-service"}[5m]))
          ) > 0.01
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "shop-service 5xx 比率 {{ $value | humanizePercentage }}"

      # ── 3. 走到 /error fallback（advice 有漏洞）────────────
      - alert: ShopApiErrorControllerFallback
        expr: sum(rate(shop_api_error_controller_fallback_total[10m])) > 0.01
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "有請求走到 /error fallback，代表 ApiExceptionHandler 沒接到"

      # ── 4. 特定業務錯誤暴增（不是技術問題，但要有人知道）──
      - alert: ShopInsufficientStockSpike
        expr: |
          sum(rate(shop_api_errors_total{code="INSUFFICIENT_STOCK"}[10m]))
          > 3 * sum(rate(shop_api_errors_total{code="INSUFFICIENT_STOCK"}[10m] offset 1d))
        for: 10m
        labels:
          severity: info
          team: merchandising            # ★ 給行銷團隊，不是後端
        annotations:
          summary: "庫存不足錯誤是昨天同時段的 3 倍 —— 可能有熱門商品缺貨"

      - alert: ShopCardDeclinedSpike
        expr: |
          sum(rate(shop_api_errors_total{code=~"CARD_DECLINED|PAYMENT_DECLINED"}[10m]))
          > 3 * sum(rate(shop_api_errors_total{code=~"CARD_DECLINED|PAYMENT_DECLINED"}[10m] offset 1d))
        for: 10m
        labels:
          severity: warning
          team: payments
        annotations:
          summary: "卡片被拒暴增 —— 可能是金流商異常或風控規則設太嚴"

      # ── 5. 401 / 403 暴增（可能是攻擊）──────────────────
      - alert: ShopAuthFailureSpike
        expr: |
          sum(rate(shop_api_errors_total{status=~"401|403"}[5m])) > 20
        for: 3m
        labels:
          severity: warning
          team: security
        annotations:
          summary: "認證/授權失敗每秒 {{ $value | humanize }} 次 —— 可能是憑證填充攻擊"

      # ── 6. 驗證失敗暴增在單一端點（前端發版出 bug）────────
      - alert: ShopValidationFailureSpikeOnEndpoint
        expr: |
          sum by (endpoint) (rate(shop_api_errors_total{code="VALIDATION_FAILED"}[10m]))
          > 5 * sum by (endpoint) (
              rate(shop_api_errors_total{code="VALIDATION_FAILED"}[10m] offset 1h))
        for: 10m
        labels:
          severity: warning
          team: frontend
        annotations:
          summary: "{{ $labels.endpoint }} 的驗證失敗暴增 —— 檢查前端是否剛發版"
```

**第 4、5、6 條特別值得注意** —— 它們**不是技術告警，是業務告警**，
而且**收件人不是後端團隊**。

> **這是把錯誤碼設計好的最大紅利**：
> 因為每個錯誤都有精確的 `code`，你可以對「業務異常」告警，
> 而不只是對「系統壞掉」告警。
>
> `INSUFFICIENT_STOCK` 暴增 → 行銷知道要補貨。
> `CARD_DECLINED` 暴增 → 金流團隊知道要查。
> `VALIDATION_FAILED` 在某端點暴增 → 前端知道剛發的版有 bug。
>
> **這些洞察在「全部回 200 + code: -1」的系統裡完全不存在。**

---

## 3.13 shop-service 落地檢核

### 3.13.1 檔案清單

```
common/error/
├── ErrorCode.java                      78 個錯誤碼的註冊表（3.4.2）
├── BusinessException.java              抽象基底（3.5.2）
├── FieldViolation.java                 欄位級錯誤（3.5.2）
├── AlternativeAction.java              「不能做 A，但可以做 B」（3.5.3）
├── ResourceNotFoundException.java      404（3.8.3）
├── ValidationFailedException.java       Service 層的 422（3.5.3）
└── ...（每個領域的例外在各自的 <domain>/service/exception/）

common/web/
├── Problem.java                        RFC 9457 + 擴充（3.6.2）
├── ProblemFactory.java                 唯一的組裝點（3.6.3）
├── ProblemWriter.java                  Filter / Security 用（3.10.1）
├── ApiExceptionHandler.java            唯一的 advice（3.7.2）
├── ApiErrorController.java             /error 安全網（3.8.4）
├── SpringExceptionMapper.java          內建例外 → ErrorCode（3.7.3）
├── ConstraintNameMapper.java           DB 約束 → ErrorCode（3.7.4）
├── MessageNotReadableAnalyzer.java     Jackson 例外 → field（3.9.4）
├── ValidationErrorTranslator.java      BindingResult → FieldViolation（02 章 2.9.3）
├── ValueMasker.java                    rejectedValue 遮蔽（3.9.6）
├── DidYouMean.java                     Levenshtein 建議（3.9.5）
├── ErrorLogger.java                    日誌與指標（3.12.1）
└── ApiProblemProperties.java           type-base-uri 設定（3.6.3）

common/config/
└── SecurityErrorConfig.java            401 / 403 的格式（3.10.2）

resources/
├── error-messages_zh_TW.properties     78 × 2 條訊息（3.4.4）
├── error-messages_en.properties        英文版
└── validation-messages_zh_TW.properties  02 章的驗證訊息
```

**14 個類別、2 個設定檔。** 換來的是：

```bash
$ grep -rc "catch" src/main/java/example/shop/*/web/
example/shop/order/web/OrderController.java:0
example/shop/order/web/OrderPaymentController.java:0
example/shop/order/web/OrderCancellationController.java:0
example/shop/order/web/OrderShipmentController.java:0
example/shop/product/web/ProductController.java:0
example/shop/cart/web/CartItemController.java:0
...
$ grep -rc "catch" src/main/java/example/shop/ --include="*Controller.java" | awk -F: '{s+=$2} END {print s}'
0
```

**70 條端點、0 個 try-catch。** 對照 3.2.1 的 213 個。

### 3.13.2 一個端到端的追蹤

從「使用者按下結帳」到「他看到訊息」的完整鏈路：

```
① 使用者按結帳（商品只剩 3 件，他要 5 件）
   POST /orders  { "items": [{"productId":"P-1001","quantity":5}], ... }
        │
② TraceIdFilter（04 章）
   traceId = 4f2c8a1e9b7d3f60 → MDC.put("traceId", ...)
   response.setHeader("X-Trace-Id", "4f2c8a1e9b7d3f60")
        │
③ Bean Validation（02 章）
   quantity=5 在 1～999 內 → 通過
        │
④ OrderController.create()
   mapper.toCreateCommand(...) → orderService.create(command)
        │
⑤ OrderService（05-service）
   階段 2：商品存在、可購買 → 通過
   階段 3：庫存 3 < 5
   → throw new InsufficientStockException("P-1001", "無線降噪耳機 Pro", 5, 3, LocalDate.of(2026,8,22), 0)
        │
⑥ DispatcherServlet 捕獲 → ExceptionHandlerExceptionResolver
        │
⑦ ApiExceptionHandler.handleBusiness()
   problems.from(ex, "/orders")
     · ErrorCode.INSUFFICIENT_STOCK → 409、insufficient-stock、MODIFY_REQUEST
     · title      ← error.INSUFFICIENT_STOCK.title      = "庫存不足"
     · userMessage← error.INSUFFICIENT_STOCK.user       = "「{0}」僅剩 {1} 件，請調整數量後再結帳。"
                    插值 {0}="無線降噪耳機 Pro"、{1}=3
     · extensions ← productId / productName / requested / available / restockEstimatedAt
     · errors[]   ← items[0].quantity
     · traceId    ← MDC
        │
⑧ ErrorLogger.log()
   log.info("業務例外 code=INSUFFICIENT_STOCK status=409
             endpoint=OrderController#create traceId=4f2c8a1e9b7d3f60
             detail=Product P-1001 has 3 units available but 5 were requested in items[0].")
   metric: shop_api_errors_total{code="INSUFFICIENT_STOCK",status="409",
                                 endpoint="OrderController#create"} +1
        │
⑨ HTTP 409 + application/problem+json（3.2.3 的完整 JSON）
        │
⑩ 前端攔截器
   problem.code === 'INSUFFICIENT_STOCK'
   → 用 problem.errors[0].field = "items[0].quantity" 標紅第一列的數量欄位
   → 顯示 problem.userMessage：「無線降噪耳機 Pro」僅剩 3 件，請調整數量後再結帳。
   → 因為 retryable=false，不自動重試
   → 因為 retryStrategy=MODIFY_REQUEST，把數量輸入框的上限改成 3 並 focus
        │
⑪ 使用者看到
   ┌────────────────────────────────────────────┐
   │ 無線降噪耳機 Pro                            │
   │ 數量 [  3  ] ← 標紅、已自動改成 3、已 focus │
   │ ⚠ 「無線降噪耳機 Pro」僅剩 3 件，          │
   │    請調整數量後再結帳。                     │
   └────────────────────────────────────────────┘
        │
⑫ 如果他打客服電話
   客服問「請問您畫面上有沒有一組追蹤碼？」（前端在 footer 顯示 traceId 前 8 碼）
   使用者：「4f2c8a1e」
   客服在 Grafana / Loki 搜 traceId=4f2c8a1e*
   → 3 秒內看到整條鏈路：哪個商品、要幾件、剩幾件、什麼時候補貨
```

**對照 3.2.2 的世界**：同一個情境會是
`{"code": -1, "msg": "庫存不足"}` + HTTP 200，
前端顯示「庫存不足」（不知道是哪個商品、剩幾件），
客服無法查詢，監控看不到，行銷不知道要補貨。

---

## 3.14 錯誤處理的測試

**錯誤處理程式碼出錯時不會有人發現**（3.3.6）。所以這一節不是選配。

### 3.14.1 測試金字塔

| 測什麼 | 用什麼 | 速度 |
|---|---|---|
| `ErrorCode` 註冊表的一致性 | `@SpringBootTest`（要 MessageSource） | ~3 s |
| `ProblemFactory` 的組裝邏輯 | 純單元測試 + mock MessageSource | ~1 ms |
| `MessageNotReadableAnalyzer` 的路徑抽取 | 純單元測試（自己造 Jackson 例外） | ~1 ms |
| `ValueMasker` / `DidYouMean` | 純單元測試 | ~0.1 ms |
| **每種例外的 HTTP 回應** | `@WebMvcTest` + MockMvc | ~0.8 s |
| **資訊洩漏** | `@WebMvcTest`（3.11.3） | ~0.8 s |
| 四層格式一致性 | `@WebMvcTest`（3.10.4） | ~0.8 s |

### 3.14.2 `ProblemFactory` 的單元測試

```java
package example.shop.common.web;

import example.shop.common.error.ErrorCode;
import example.shop.order.service.exception.InsufficientStockException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.MDC;
import org.springframework.context.support.StaticMessageSource;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.Locale;

import static org.assertj.core.api.Assertions.assertThat;

class ProblemFactoryTest {

    private ProblemFactory factory;

    @BeforeEach
    void setUp() {
        var messages = new StaticMessageSource();
        messages.addMessage("error.INSUFFICIENT_STOCK.title", Locale.TAIWAN, "庫存不足");
        messages.addMessage("error.INSUFFICIENT_STOCK.user", Locale.TAIWAN,
                "「{0}」僅剩 {1} 件，請調整數量後再結帳。");
        messages.addMessage("error.INTERNAL_ERROR.title", Locale.TAIWAN, "系統錯誤");
        messages.addMessage("error.INTERNAL_ERROR.user", Locale.TAIWAN,
                "系統暫時發生問題。追蹤碼 {0}。");

        var clock = Clock.fixed(Instant.parse("2026-08-20T06:12:44Z"), ZoneOffset.UTC);
        factory = new ProblemFactory(
                new ApiProblemProperties("https://api.shop.example/problems"),
                messages, clock);

        org.springframework.context.i18n.LocaleContextHolder.setLocale(Locale.TAIWAN);
        MDC.put(TraceContext.MDC_TRACE_ID, "4f2c8a1e9b7d3f60");
    }

    @Test
    void 業務例外的完整組裝() {
        var ex = new InsufficientStockException(
                "P-1001", "無線降噪耳機 Pro", 5, 3, LocalDate.of(2026, 8, 22), 0);

        Problem p = factory.from(ex, "/orders");

        assertThat(p.type()).isEqualTo(
                "https://api.shop.example/problems/insufficient-stock");
        assertThat(p.title()).isEqualTo("庫存不足");
        assertThat(p.status()).isEqualTo(409);
        assertThat(p.code()).isEqualTo("INSUFFICIENT_STOCK");
        assertThat(p.userMessage()).isEqualTo(
                "「無線降噪耳機 Pro」僅剩 3 件，請調整數量後再結帳。");
        assertThat(p.detail()).contains("P-1001").contains("items[0]");
        assertThat(p.retryable()).isFalse();
        assertThat(p.retryStrategy()).isEqualTo("MODIFY_REQUEST");
        assertThat(p.traceId()).isEqualTo("4f2c8a1e9b7d3f60");
        assertThat(p.timestamp()).isEqualTo(Instant.parse("2026-08-20T06:12:44Z"));

        assertThat(p.extensions())
                .containsEntry("productId", "P-1001")
                .containsEntry("available", 3)
                .containsEntry("requested", 5);

        assertThat(p.errors()).hasSize(1);
        assertThat(p.errors().get(0).field()).isEqualTo("items[0].quantity");
    }

    @Test
    void 五xx的detail是固定文字不含原始訊息() {
        Problem p = factory.from(ErrorCode.INTERNAL_ERROR, "/orders",
                "SQL error: insert into t_order ... constraint uk_order_number");

        assertThat(p.detail())
                .as("5xx 的 detail 必須被替換成固定文字")
                .doesNotContain("SQL")
                .doesNotContain("t_order")
                .isEqualTo("An unexpected error occurred. "
                        + "Provide the traceId when contacting support.");
    }

    @Test
    void 五xx的userMessage自動帶短traceId() {
        Problem p = factory.from(ErrorCode.INTERNAL_ERROR, "/orders", null);
        assertThat(p.userMessage()).isEqualTo("系統暫時發生問題。追蹤碼 4f2c8a1e。");
    }

    @Test
    void i18n查不到時要有fallback不可拋例外() {
        // COUPON_EXHAUSTED 的訊息刻意沒加進 StaticMessageSource
        Problem p = factory.from(ErrorCode.COUPON_EXHAUSTED, "/carts/current/coupon", "x");

        assertThat(p.title()).isEqualTo("COUPON_EXHAUSTED");          // fallback 是 code 名稱
        assertThat(p.userMessage()).isEqualTo("操作無法完成，請稍後再試。");
    }

    @Test
    void MDC沒有traceId時不可NPE() {
        MDC.clear();
        Problem p = factory.from(ErrorCode.INTERNAL_ERROR, "/orders", null);
        assertThat(p.traceId()).isEqualTo("unknown");
    }

    @Test
    void instance不含queryString() {
        var request = new org.springframework.mock.web.MockHttpServletRequest(
                "GET", "/orders");
        request.setQueryString("customerId=cus_1&token=secret");

        assertThat(ProblemFactory.instanceOf(request))
                .isEqualTo("/orders")
                .doesNotContain("secret");
    }
}
```

**最後三個測試特別重要** —— 它們測的是**錯誤處理自己的失敗模式**（3.3.6）。

### 3.14.3 `MessageNotReadableAnalyzer` 的路徑抽取測試

```java
class MessageNotReadableAnalyzerTest {

    private final ObjectMapper objectMapper = JsonMapper.builder()
            .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
            .build();

    /** 用真的 Jackson 產生例外，而不是 mock —— 這樣才測得到真實的 path 結構。 */
    private HttpMessageNotReadableException parse(String json) {
        try {
            objectMapper.readValue(json, CreateOrderRequest.class);
            throw new AssertionError("預期會拋例外但沒有");
        } catch (Exception e) {
            return new HttpMessageNotReadableException("Failed to read request", e,
                    new org.springframework.mock.http.MockHttpInputMessage(json.getBytes()));
        }
    }

    @Test
    void 巢狀陣列裡的型別錯誤能定位到精確路徑() {
        var analysis = MessageNotReadableAnalyzer.analyze(parse("""
                {"items":[{"productId":"P-1","quantity":1},
                          {"productId":"P-2","quantity":"兩個"}],
                 "shippingAddressId":"addr_1"}
                """));

        assertThat(analysis.violations()).hasSize(1);
        var v = analysis.violations().get(0);
        assertThat(v.field()).isEqualTo("items[1].quantity");     // ★ 核心斷言
        assertThat(v.code()).isEqualTo("TypeMismatch");
        assertThat(v.message()).isEqualTo("必須是整數");
        assertThat(v.rejectedValue()).isEqualTo("兩個");
    }

    @Test
    void 深層巢狀也能定位() {
        var analysis = MessageNotReadableAnalyzer.analyze(parse("""
                {"items":[{"productId":"P-1","quantity":1}],
                 "shippingAddressId":"addr_1",
                 "invoice":{"type":"NOT_A_VALID_TYPE"}}
                """));

        assertThat(analysis.violations()).hasSize(1);
        assertThat(analysis.violations().get(0).field()).isEqualTo("invoice.type");
        assertThat(analysis.violations().get(0).message()).isEqualTo("不是有效的選項");
    }

    @Test
    void 列舉錯誤要列出合法值() {
        var analysis = MessageNotReadableAnalyzer.analyze(parse("""
                {"items":[{"productId":"P-1","quantity":1}],
                 "shippingAddressId":"addr_1",
                 "invoice":{"type":"WRONG"}}
                """));

        assertThat(analysis.violations().get(0).constraint())
                .extracting("allowedValues")
                .asInstanceOf(org.assertj.core.api.InstanceOfAssertFactories.LIST)
                .contains("PERSONAL", "COMPANY", "DONATION");
    }

    @Test
    void 未知欄位要有didYouMean建議() {
        var analysis = MessageNotReadableAnalyzer.analyze(parse("""
                {"items":[{"productId":"P-1","quantity":1}],
                 "shippingAddressId":"addr_1",
                 "custmerNote":"typo"}
                """));

        assertThat(analysis.extensions())
                .containsEntry("didYouMean", "customerNote");
        assertThat(analysis.violations().get(0).message())
                .contains("customerNote");
    }

    @Test
    void 語法錯誤只給位置不給Jackson訊息() {
        var analysis = MessageNotReadableAnalyzer.analyze(parse("{bad json"));

        assertThat(analysis.violations()).isEmpty();
        assertThat(analysis.safeDetail()).isEqualTo("The request body is not valid JSON.");
        assertThat(analysis.extensions()).containsKeys("line", "column");
        // ★ 確認沒洩漏
        assertThat(analysis.safeDetail())
                .doesNotContain("example.shop")
                .doesNotContain("com.fasterxml");
    }

    @Test
    void 空body有明確訊息() {
        var ex = new HttpMessageNotReadableException("Required request body is missing",
                new org.springframework.mock.http.MockHttpInputMessage(new byte[0]));
        var analysis = MessageNotReadableAnalyzer.analyze(ex);

        assertThat(analysis.safeDetail()).isEqualTo("Request body is missing or empty.");
    }
}
```

⚠️ **`parse()` 用真的 Jackson 而不是 mock 例外** —— 這是關鍵。
`JsonMappingException.getPath()` 的結構很難手工正確地造出來，
而如果造錯了，測試會通過但真實情況會失敗。

### 3.14.4 advice 的 MockMvc 測試

```java
package example.shop.order.web;

import example.shop.common.error.ErrorCode;
import example.shop.order.service.exception.InsufficientStockException;
import example.shop.order.service.exception.OrderNotCancellableException;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import java.time.LocalDate;
import java.util.Set;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import static org.hamcrest.Matchers.*;

@WebMvcTest(OrderController.class)
class OrderControllerErrorTest {

    @Autowired MockMvc mockMvc;
    @MockitoBean OrderService orderService;

    private static final String VALID_BODY = """
            {"items":[{"productId":"P-1001","quantity":5}],
             "shippingAddressId":"addr_01J5GK"}
            """;

    @Test
    void 庫存不足回409與完整的Problem() throws Exception {
        when(orderService.create(any())).thenThrow(new InsufficientStockException(
                "P-1001", "無線降噪耳機 Pro", 5, 3, LocalDate.of(2026, 8, 22), 0));

        mockMvc.perform(post("/orders")
                        .header("Idempotency-Key", "idem-1")
                        .contentType(APPLICATION_JSON).content(VALID_BODY))
                // 狀態碼與 Content-Type
                .andExpect(status().isConflict())
                .andExpect(content().contentTypeCompatibleWith("application/problem+json"))
                .andExpect(header().string("Cache-Control", containsString("no-store")))
                // RFC 9457 標準欄位
                .andExpect(jsonPath("$.type").value(
                        "https://api.shop.example/problems/insufficient-stock"))
                .andExpect(jsonPath("$.title").value("庫存不足"))
                .andExpect(jsonPath("$.status").value(409))
                .andExpect(jsonPath("$.instance").value("/orders"))
                // shop-service 擴充
                .andExpect(jsonPath("$.code").value("INSUFFICIENT_STOCK"))
                .andExpect(jsonPath("$.userMessage").value(containsString("僅剩 3 件")))
                .andExpect(jsonPath("$.retryable").value(false))
                .andExpect(jsonPath("$.retryStrategy").value("MODIFY_REQUEST"))
                .andExpect(jsonPath("$.traceId").isNotEmpty())
                // 錯誤碼專屬的擴充欄位（平鋪在最上層）
                .andExpect(jsonPath("$.productId").value("P-1001"))
                .andExpect(jsonPath("$.available").value(3))
                .andExpect(jsonPath("$.requested").value(5))
                .andExpect(jsonPath("$.restockEstimatedAt").value("2026-08-22"))
                // errors[]
                .andExpect(jsonPath("$.errors", hasSize(1)))
                .andExpect(jsonPath("$.errors[0].field").value("items[0].quantity"))
                // ★ 確認沒洩漏
                .andExpect(jsonPath("$.stackTrace").doesNotExist())
                .andExpect(jsonPath("$.detail", not(containsString("example.shop"))));
    }

    @Test
    void 訂單無法取消時要帶alternativeAction() throws Exception {
        when(orderService.cancel(any())).thenThrow(new OrderNotCancellableException(
                "ord_01J5GK", "ORD-20260819-0001", OrderStatus.SHIPPED,
                Set.of(OrderStatus.PENDING_PAYMENT, OrderStatus.PAID),
                LocalDate.of(2026, 8, 28)));

        mockMvc.perform(post("/orders/ord_01J5GK/cancellations")
                        .contentType(APPLICATION_JSON).content("{\"reason\":\"CHANGED_MIND\"}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("ORDER_NOT_CANCELLABLE"))
                .andExpect(jsonPath("$.currentStatus").value("SHIPPED"))
                .andExpect(jsonPath("$.cancellableStatuses",
                        containsInAnyOrder("PAID", "PENDING_PAYMENT")))
                // ★ 這是高價值欄位：前端可以直接顯示「申請退貨」按鈕
                .andExpect(jsonPath("$.alternativeAction.code").value("REQUEST_RETURN"))
                .andExpect(jsonPath("$.alternativeAction.href")
                        .value("/orders/ord_01J5GK/returns"))
                .andExpect(jsonPath("$.alternativeAction.availableUntil").value("2026-08-28"));
    }

    @Test
    void 限流要帶RetryAfter與RateLimit_header() throws Exception {
        when(orderService.create(any())).thenThrow(
                new RateLimitExceededException(100, 60, 0,
                        Instant.parse("2026-08-20T06:13:26Z"), 42));

        mockMvc.perform(post("/orders")
                        .header("Idempotency-Key", "idem-1")
                        .contentType(APPLICATION_JSON).content(VALID_BODY))
                .andExpect(status().isTooManyRequests())
                .andExpect(header().string("Retry-After", "42"))
                .andExpect(header().string("X-RateLimit-Limit", "100"))
                .andExpect(header().string("X-RateLimit-Remaining", "0"))
                .andExpect(jsonPath("$.retryable").value(true))
                .andExpect(jsonPath("$.retryStrategy").value("BACKOFF_AND_RETRY"))
                .andExpect(jsonPath("$.retryAfterSeconds").value(42));
    }

    @Test
    void 樂觀鎖衝突要回目前的ETag() throws Exception {
        when(orderService.update(any())).thenThrow(
                new org.springframework.dao.OptimisticLockingFailureException("v8"));

        mockMvc.perform(patch("/orders/ord_01J5GK")
                        .header("If-Match", "\"v7\"")
                        .contentType(APPLICATION_JSON)
                        .content("{\"customerNote\":\"改備註\"}"))
                .andExpect(status().isPreconditionFailed())
                .andExpect(jsonPath("$.code").value("OPTIMISTIC_LOCK_CONFLICT"))
                .andExpect(jsonPath("$.retryStrategy").value("REFETCH_THEN_RETRY"));
    }

    @Test
    void 權限不足回403而不是500() throws Exception {
        // ★ 這個測試守住 3.3.5 的陷阱
        when(orderService.create(any())).thenThrow(
                new org.springframework.security.access.AccessDeniedException("denied"));

        mockMvc.perform(post("/orders")
                        .header("Idempotency-Key", "idem-1")
                        .contentType(APPLICATION_JSON).content(VALID_BODY))
                .andExpect(status().isForbidden())               // ★ 不是 500
                .andExpect(jsonPath("$.code").value("INSUFFICIENT_ROLE"));
    }

    @Test
    void 未預期的例外回500且格式正確() throws Exception {
        when(orderService.create(any())).thenThrow(new IllegalStateException(
                "orderNumberGenerator returned null for example.shop.order.domain.Order"));

        mockMvc.perform(post("/orders")
                        .header("Idempotency-Key", "idem-1")
                        .contentType(APPLICATION_JSON).content(VALID_BODY))
                .andExpect(status().isInternalServerError())
                .andExpect(jsonPath("$.code").value("INTERNAL_ERROR"))
                .andExpect(jsonPath("$.userMessage").value(containsString("追蹤碼")))
                .andExpect(jsonPath("$.detail",
                        not(containsString("orderNumberGenerator"))))     // ★
                .andExpect(jsonPath("$.detail", not(containsString("example.shop"))));
    }
}
```

### 3.14.5 「每個 `ErrorCode` 都有測試」的覆蓋率檢查

```java
/**
 * 這個測試檢查「每個 ErrorCode 是否至少在某處被拋出」。
 *
 * <p>它抓兩種問題：
 * <ul>
 *   <li>定義了但沒人用的 code（死程式碼，或忘了實作）</li>
 *   <li>被拋出但沒有對應訊息的 code（3.4.5 已涵蓋）</li>
 * </ul>
 */
@Test
void 每個ErrorCode都有被使用() throws Exception {
    // 用 ClassGraph 或 ArchUnit 掃描：哪些 ErrorCode 常數在程式碼裡被引用
    Set<String> referenced = ErrorCodeUsageScanner.scan("example.shop");

    Set<String> unused = Arrays.stream(ErrorCode.values())
            .map(Enum::name)
            .filter(name -> !referenced.contains(name))
            .collect(Collectors.toCollection(TreeSet::new));

    // ⚠️ 有些 code 是「保留給後續章節」的，明確列出來
    Set<String> plannedForLater = Set.of(
            "ACCOUNT_SUSPENDED",          // 09-spring-security
            "INSUFFICIENT_SCOPE",         // 09-spring-security
            "FORBIDDEN_PARAMETER",        // 09-spring-security
            "PAYMENT_GATEWAY_TIMEOUT",    // 05-service（外部呼叫）
            "UPSTREAM_ERROR",             // 05-service
            "PAYMENT_OUTCOME_UNKNOWN"     // 05-service
    );

    assertThat(unused)
            .as("以下 ErrorCode 定義了但沒有任何地方使用")
            .isSubsetOf(plannedForLater);
}
```

**這個測試的價值在於它會隨專案演進而失敗** ——
當你在 05-service 實作了外部呼叫，就要把對應的 code 從 `plannedForLater` 移除。
**清單本身就是待辦事項。**

---

## 3.15 常見誤區

**誤區 1：「用 `@ExceptionHandler(Exception.class)` 一個就搞定了」**

3.3.5 的陷阱：它會吃掉 `AccessDeniedException`（403 變 500）、
吃掉 Spring 的內建例外（405 / 415 變 500）、吃掉客戶端斷線（污染告警）。

**catch-all 是最後防線，不是主要手段。**

**誤區 2：「例外訊息越詳細越好，方便除錯」**

除錯需要的細節應該進**日誌**（有 `traceId` 可以查），不是進**回應**。
3.11.1 的洩漏清單。

**判準**：問「這句話如果出現在攻擊者的螢幕上，我會不會後悔？」

**誤區 3：「`@ResponseStatus` 很簡潔，用它就好」**

3.5.5 的五個理由。最致命的是**它完全不產生 body**。

**誤區 4：「錯誤碼用數字比較省」**

```json
{ "code": 20031 }
```

問題：
- 沒有人記得 20031 是什麼，每次都要查表。
- log 裡搜 `20031` 會撞到金額、ID、時間戳。
- 新增碼要維護一個「號碼分配表」，而它一定會撞號。

**字串 `UPPER_SNAKE_CASE` 是自我說明的**，而且 `grep INSUFFICIENT_STOCK` 精確命中。

**誤區 5：「業務例外也要 log error，不然查不到」**

「庫存不足」每天發生 3,000 次。用 `error` 等級的話：
- 告警規則要排除它 → 排除清單越來越長 → 某天不小心排除了真的錯誤。
- 日誌成本上升。
- **真正的 500 被淹沒。**

3.12.1 的分級表。

**誤區 6：「advice 裡可以放商業邏輯」**

```java
// ❌ 在 advice 裡補償
@ExceptionHandler(PaymentGatewayTimeoutException.class)
public ... handle(PaymentGatewayTimeoutException ex) {
    paymentService.markAsPending(ex.paymentId());     // ← 業務操作！
    return problem(...);
}
```

問題：
- advice 沒有交易（`@Transactional` 在 Service）。
- 這個補償只在「透過 HTTP 呼叫」時發生 —— 批次任務不會執行它。
- advice 拋例外會導致 3.3.6 的災難。

**補償屬於 Service**（用 try-catch 或 `@TransactionalEventListener`）。
**advice 只做翻譯**（第 00 章 0.5 的第 7 項）。

**誤區 7：「`ProblemDetail` 是 Spring 內建的，一定比自訂的好」**

3.6.1 的取捨。兩者都可以，選擇取決於你更在意「型別上的必填保證」還是「少寫程式碼」。
**但不要兩種混用** —— 那會讓回應格式有兩種。

**誤區 8：「錯誤處理不需要測試，它只是格式化」**

3.3.6：advice 拋例外 → 回應變成 HTML → 前端 `res.json()` 爆掉。
而這只在真的出錯時才會被發現。

**每一個 `ErrorCode` 至少要有一個測試斷言它的狀態碼與 `code`。**

**誤區 9：「回 200 讓前端好處理」**

3.2.2 損失 1 的五個機制全部失效。
「前端好處理」是假的 —— 前端最後寫出 3.2.1 那個 `isError()` 函式。

**誤區 10：「404 就是 404，不需要分」**

3.8.3：`ENDPOINT_NOT_FOUND`（我們的 bug，該上報）
vs `RESOURCE_NOT_FOUND`（正常業務情況，顯示空狀態）。
不分的話前端只能都當成「找不到」，於是 URL 組錯的 bug 永遠不會被發現。

---

## 3.16 本章練習

### 練習 1：預測這 10 種情況的回應

假設 `ApiExceptionHandler` 已依 3.7.2 實作，`spring.mvc.problemdetails.enabled=false`。
預測每種情況的**狀態碼**與 **`code`**：

| # | 請求 |
|---|---|
| 1 | `DELETE /orders/ord_1`（只有 GET 與 PATCH） |
| 2 | `POST /orders`，`Content-Type: text/plain` |
| 3 | `GET /orders/ord_1`，`Accept: application/xml` |
| 4 | `POST /orders`，body 是 `{bad` |
| 5 | `POST /orders`，body 是 `{"items":[]}` |
| 6 | `POST /orders`，body 是 `{"items":[{"productId":"P-1","quantity":"五"}],"shippingAddressId":"a"}` |
| 7 | `POST /orders`，沒帶 `Idempotency-Key` |
| 8 | `GET /orders?size=999` |
| 9 | `GET /ordres` |
| 10 | Service 拋 `NullPointerException` |

<details>
<summary>解答</summary>

| # | 狀態碼 | `code` | 走哪條路徑 |
|---|---|---|---|
| 1 | **405** | `METHOD_NOT_ALLOWED` | `HttpRequestMethodNotSupportedException` → 父類別 `handleHttpRequestMethodNotSupported` → `handleExceptionInternal` → `SpringExceptionMapper`。**回應會帶 `Allow: GET, PATCH`** |
| 2 | **415** | `UNSUPPORTED_MEDIA_TYPE` | `HttpMediaTypeNotSupportedException`；`supportedTypes` 擴充欄位會列出 `application/json` |
| 3 | **406** | `NOT_ACCEPTABLE` | `HttpMediaTypeNotAcceptableException` |
| 4 | **400** | `MALFORMED_REQUEST` | `HttpMessageNotReadableException` → `MessageNotReadableAnalyzer` 情況 8（`JsonParseException`）→ `violations` 為空 → 400。擴充欄位有 `line` / `column` |
| 5 | **422** | `VALIDATION_FAILED` | `@NotEmpty` 失敗 → `MethodArgumentNotValidException` → `handleMethodArgumentNotValid`。`errors[0].field = "items"`。⚠️ 同時 `shippingAddressId` 缺失也會是一個錯誤，所以 `errorCount = 2` |
| 6 | **422** | `VALIDATION_FAILED` | `InvalidFormatException` → `MessageNotReadableAnalyzer` 情況 3 → `violations` 非空 → **422 而不是 400**。`field = "items[0].quantity"`、`message = "必須是整數"` |
| 7 | **422** | `VALIDATION_FAILED` | `@RequestHeader(required=true)` 缺失 → `MissingRequestHeaderException` → `SpringExceptionMapper` 對映到 `VALIDATION_FAILED`。⚠️ 狀態碼是父類別給的 **400**，而 `ErrorCode.VALIDATION_FAILED` 是 422 → **兩者不一致！** 見下方討論 |
| 8 | **422** | `VALIDATION_FAILED` | `OrderFilter` 的 `@Max(100)` 失敗 → `MethodArgumentNotValidException`。`field = "size"` |
| 9 | **404** | `ENDPOINT_NOT_FOUND` | `NoResourceFoundException`（Boot 3.2）或 `NoHandlerFoundException` |
| 10 | **500** | `INTERNAL_ERROR` | catch-all。`detail` 是固定文字，NPE 的 helpful message 只進 log |

**第 7 題揭露了一個真實的 bug** ★

`handleExceptionInternal` 用的是**父類別傳進來的 `statusCode`**（400），
但 `problem.status()` 來自 `ErrorCode.VALIDATION_FAILED`（422）。

於是回應會是：

```http
HTTP/1.1 400 Bad Request          ← 來自 statusCode 參數
Content-Type: application/problem+json
```
```json
{ "status": 422, "code": "VALIDATION_FAILED" }    ← body 裡是 422
```

**HTTP 狀態碼與 body 的 `status` 不一致** —— 這會讓客戶端困惑，
而且違反 RFC 9457（它要求 `status` 欄位等於 HTTP 狀態碼）。

**修法：`handleExceptionInternal` 要用 `problem.status()` 覆蓋。**

```java
@Override
protected ResponseEntity<Object> handleExceptionInternal(
        Exception ex, Object body, HttpHeaders headers,
        HttpStatusCode statusCode, WebRequest request) {

    if (body instanceof Problem p) {
        return new ResponseEntity<>(p, problemHeaders(headers),
                                    HttpStatusCode.valueOf(p.status()));
    }

    ErrorCode code = SpringExceptionMapper.toErrorCode(ex, statusCode);
    Problem problem = problems.from(code, instanceOf(request),
                                    SpringExceptionMapper.safeDetail(ex),
                                    SpringExceptionMapper.extensionsOf(ex));

    // ★ 一律用 ErrorCode 決定的狀態碼，保證 body.status == HTTP status
    HttpStatusCode finalStatus = HttpStatusCode.valueOf(problem.status());

    if (problem.status() >= 500) {
        errorLog.logServerError(ex, problem, servletRequestOf(request), null, "spring-mvc");
    } else {
        errorLog.logClientError(ex, problem, request);
    }
    return new ResponseEntity<>(problem, problemHeaders(headers), finalStatus);
}
```

**並加一個測試守住它**：

```java
@ParameterizedTest
@MethodSource("errorScenarios")
void HTTP狀態碼必須等於body裡的status(ErrorScenario s) throws Exception {
    var result = mockMvc.perform(s.request()).andReturn();
    int httpStatus = result.getResponse().getStatus();
    var body = objectMapper.readTree(result.getResponse().getContentAsString());

    assertThat(body.get("status").asInt())
            .as("RFC 9457 要求 body.status == HTTP status（情境：%s）", s.name())
            .isEqualTo(httpStatus);
}
```

**這個練習的重點就是這個 bug。** 它在真實專案裡很常見，
因為「繼承 `ResponseEntityExceptionHandler` 並覆寫 body」的做法很容易忽略狀態碼那條路。

</details>

### 練習 2：設計退款失敗的錯誤

需求：`POST /payments/{paymentId}/refunds` 可能因五種原因失敗：

1. 付款不存在。
2. 付款狀態不是 `SUCCEEDED`（例如還在處理中）。
3. 退款金額超過「付款金額 − 已退款金額」。
4. 超過可退款期限（信用卡 180 天）。
5. 金流商回 timeout，退款結果未知。

請為每一種寫出：
- `ErrorCode`（含狀態碼、`retryStrategy`）。
- 例外類別。
- 完整的 Problem JSON。
- 前端該怎麼處理。

<details>
<summary>解答</summary>

**`ErrorCode` 新增／使用**

| # | `code` | 狀態碼 | `retryStrategy` | 理由 |
|---|---|---|---|---|
| 1 | `RESOURCE_NOT_FOUND` | 404 | — | 已存在 |
| 2 | `PAYMENT_NOT_REFUNDABLE` | 409 | — | 狀態衝突。已存在 |
| 3 | `REFUND_EXCEEDS_PAYMENT` | 422 | `MODIFY_REQUEST` ★ | 語意錯誤，改金額可成功。**需要補 retryStrategy** |
| 4 | `REFUND_WINDOW_EXPIRED` | 409 | — | 已存在 |
| 5 | `PAYMENT_OUTCOME_UNKNOWN` | 504 | `CHECK_STATUS` | 已存在 |

```java
// ErrorCode 的修正：REFUND_EXCEEDS_PAYMENT 補上 retryStrategy
REFUND_EXCEEDS_PAYMENT (HttpStatus.UNPROCESSABLE_ENTITY, "refund-exceeds-payment",
                        Retry.MODIFY_REQUEST),
```

**例外類別**

```java
package example.shop.payment.service.exception;

import example.shop.common.error.AlternativeAction;
import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;
import example.shop.common.error.FieldViolation;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;

/** 2. 付款狀態不允許退款。 */
public class PaymentNotRefundableException extends BusinessException {

    public PaymentNotRefundableException(String paymentId, String paymentStatus,
                                          String statusCheckUrl) {
        super(ErrorCode.PAYMENT_NOT_REFUNDABLE,
              "Payment %s is in %s state; only SUCCEEDED payments can be refunded."
                      .formatted(paymentId, paymentStatus),
              null,
              ext("paymentId", paymentId,
                  "paymentStatus", paymentStatus,
                  "refundableStatuses", List.of("SUCCEEDED", "PARTIALLY_REFUNDED"),
                  // 還在處理中 → 告訴客戶端去哪裡輪詢
                  "alternativeAction", "PROCESSING".equals(paymentStatus)
                          ? new AlternativeAction("CHECK_PAYMENT_STATUS", "查詢付款狀態",
                                                  statusCheckUrl, "GET", null, null)
                          : null),
              new Object[]{paymentStatus},
              List.of());
    }
}

/** 3. 退款金額超額。 */
public class RefundExceedsPaymentException extends BusinessException {

    public RefundExceedsPaymentException(String paymentId,
                                          BigDecimal paymentAmount,
                                          BigDecimal alreadyRefunded,
                                          BigDecimal requested,
                                          String currency) {
        super(ErrorCode.REFUND_EXCEEDS_PAYMENT,
              "Refund of %s exceeds refundable amount %s (paid %s, already refunded %s)."
                      .formatted(requested,
                                 paymentAmount.subtract(alreadyRefunded),
                                 paymentAmount, alreadyRefunded),
              null,
              ext("paymentId", paymentId,
                  "paymentAmount", paymentAmount.toPlainString(),
                  "alreadyRefunded", alreadyRefunded.toPlainString(),
                  "refundableAmount", paymentAmount.subtract(alreadyRefunded).toPlainString(),
                  "requested", requested.toPlainString(),
                  "currency", currency),
              new Object[]{paymentAmount.subtract(alreadyRefunded).toPlainString()},
              // ★ 定位到金額欄位，前端可以標紅並自動填入可退金額
              List.of(new FieldViolation("amount", "REFUND_EXCEEDS_PAYMENT",
                      "可退金額為 " + paymentAmount.subtract(alreadyRefunded).toPlainString(),
                      requested.toPlainString(),
                      java.util.Map.of("max",
                              paymentAmount.subtract(alreadyRefunded).toPlainString()))));
    }
}

/** 4. 超過可退款期限。 */
public class RefundWindowExpiredException extends BusinessException {

    public RefundWindowExpiredException(String paymentId, String method,
                                         LocalDate refundableUntil, int windowDays) {
        super(ErrorCode.REFUND_WINDOW_EXPIRED,
              "Payment %s is past its refund window (%s, %d days)."
                      .formatted(paymentId, refundableUntil, windowDays),
              null,
              ext("paymentId", paymentId,
                  "paymentMethod", method,
                  "refundableUntil", refundableUntil,
                  "windowDays", windowDays,
                  // ★ 過期了不代表沒辦法退，只是要走人工
                  "alternativeAction", new AlternativeAction(
                          "MANUAL_REFUND_REQUEST", "申請人工退款",
                          "/support/tickets", "POST", null, null)),
              new Object[]{refundableUntil.toString(), windowDays},
              List.of());
    }
}

/** 5. 金流商 timeout，結果未知。 */
public class PaymentOutcomeUnknownException extends BusinessException {

    public PaymentOutcomeUnknownException(String paymentId, String refundId,
                                           String statusCheckUrl,
                                           int recommendedCheckAfterSeconds,
                                           Throwable cause) {
        super(ErrorCode.PAYMENT_OUTCOME_UNKNOWN,
              "The refund request to the payment gateway timed out; "
                      + "the outcome is unknown. Poll the status endpoint.",
              cause,                                    // ★ 保留根因的 stack trace
              ext("paymentId", paymentId,
                  "refundId", refundId,
                  "statusCheckUrl", statusCheckUrl,
                  "recommendedCheckAfterSeconds", recommendedCheckAfterSeconds),
              new Object[0],
              List.of());
    }
}
```

**Problem JSON**

**① 付款不存在（404）**

```jsonc
{
  "type": "https://api.shop.example/problems/resource-not-found",
  "title": "資源不存在",
  "status": 404,
  "detail": "Payment with id pay_xxx was not found.",
  "instance": "/payments/pay_xxx/refunds",
  "code": "RESOURCE_NOT_FOUND",
  "userMessage": "找不到您要查看的資料，它可能已被移除。",
  "resourceType": "Payment",
  "resourceId": "pay_xxx",
  "retryable": false,
  "traceId": "4f2c8a1e9b7d3f60",
  "timestamp": "2026-08-20T06:12:44Z"
}
```

**② 付款還在處理中（409）**

```jsonc
{
  "type": "https://api.shop.example/problems/payment-not-refundable",
  "title": "此付款無法退款",
  "status": 409,
  "detail": "Payment pay_01J5GK is in PROCESSING state; only SUCCEEDED payments can be refunded.",
  "instance": "/payments/pay_01J5GK/refunds",
  "code": "PAYMENT_NOT_REFUNDABLE",
  "userMessage": "此筆付款目前狀態為 PROCESSING，無法退款。",
  "paymentId": "pay_01J5GK",
  "paymentStatus": "PROCESSING",
  "refundableStatuses": ["SUCCEEDED", "PARTIALLY_REFUNDED"],
  "alternativeAction": {
    "code": "CHECK_PAYMENT_STATUS",
    "label": "查詢付款狀態",
    "href": "/payments/pay_01J5GK",
    "method": "GET"
  },
  "retryable": false,
  "traceId": "4f2c8a1e9b7d3f60"
}
```

⚠️ **`userMessage` 直接放了 `PROCESSING` 這個內部狀態值** —— 使用者看不懂。
**修正**：訊息應該用中文標籤。

```properties
error.PAYMENT_NOT_REFUNDABLE.user=此筆付款{0}，目前無法退款。
```

而例外傳入的參數應該是 `statusLabel`（「正在處理中」）而不是 `status`（`PROCESSING`）。

**這是一個真實會犯的錯**：擴充欄位用機器值（`PROCESSING`），
`userMessage` 的參數要用人類標籤（「正在處理中」）。**兩者不能混用同一個變數。**

**③ 退款超額（422）**

```jsonc
{
  "type": "https://api.shop.example/problems/refund-exceeds-payment",
  "title": "退款金額超過付款金額",
  "status": 422,
  "detail": "Refund of 2000.00 exceeds refundable amount 780.50 (paid 1280.50, already refunded 500.00).",
  "instance": "/payments/pay_01J5GK/refunds",
  "code": "REFUND_EXCEEDS_PAYMENT",
  "userMessage": "可退金額為 780.50 元，請調整金額後再送出。",
  "errors": [
    { "field": "amount", "code": "REFUND_EXCEEDS_PAYMENT",
      "message": "可退金額為 780.50", "rejectedValue": "2000.00",
      "constraint": { "max": "780.50" } }
  ],
  "errorCount": 1,
  "paymentId": "pay_01J5GK",
  "paymentAmount": "1280.50",
  "alreadyRefunded": "500.00",
  "refundableAmount": "780.50",
  "requested": "2000.00",
  "currency": "TWD",
  "retryable": true,
  "retryStrategy": "MODIFY_REQUEST",
  "traceId": "4f2c8a1e9b7d3f60"
}
```

**注意 `refundableAmount` 是計算好的欄位** —— 前端不用自己減。
**這是「回應要讓客戶端不用計算」的原則**（03-rest-api 第 03 章）。

**④ 超過期限（409）**

```jsonc
{
  "type": "https://api.shop.example/problems/refund-window-expired",
  "title": "超過可退款期限",
  "status": 409,
  "detail": "Payment pay_01J5GK is past its refund window (2026-02-15, 180 days).",
  "instance": "/payments/pay_01J5GK/refunds",
  "code": "REFUND_WINDOW_EXPIRED",
  "userMessage": "此筆付款已超過 180 天退款期限（2026-02-15）。您可以申請人工退款。",
  "paymentId": "pay_01J5GK",
  "paymentMethod": "CREDIT_CARD",
  "refundableUntil": "2026-02-15",
  "windowDays": 180,
  "alternativeAction": {
    "code": "MANUAL_REFUND_REQUEST",
    "label": "申請人工退款",
    "href": "/support/tickets",
    "method": "POST"
  },
  "retryable": false,
  "traceId": "4f2c8a1e9b7d3f60"
}
```

**⑤ 結果未知（504）** ★ **最重要的一個**

```http
HTTP/1.1 504 Gateway Timeout
Content-Type: application/problem+json
Retry-After: 30
Cache-Control: no-store
```
```jsonc
{
  "type": "https://api.shop.example/problems/payment-outcome-unknown",
  "title": "付款結果未知",
  "status": 504,
  "detail": "An unexpected error occurred. Provide the traceId when contacting support.",
  "instance": "/payments/pay_01J5GK/refunds",
  "code": "PAYMENT_OUTCOME_UNKNOWN",
  "userMessage": "退款結果尚未確認，請勿重複送出。我們會在 1 分鐘內更新狀態。",
  "paymentId": "pay_01J5GK",
  "refundId": "ref_01J5GM",
  "statusCheckUrl": "/refunds/ref_01J5GM",
  "recommendedCheckAfterSeconds": 30,
  "retryable": true,
  "retryStrategy": "CHECK_STATUS",
  "traceId": "4f2c8a1e9b7d3f60"
}
```

⚠️ **注意 `detail` 是固定文字**（因為 504 是 5xx，`ProblemFactory` 自動替換了）。
真正的原因（「gateway timed out」）只進 log。

⚠️ **`refundId` 在結果未知的情況下也必須回傳。**
因為我們**在呼叫金流商之前**就先建立了退款紀錄（狀態 `PENDING`），
所以客戶端有一個可以輪詢的 ID。

**如果沒有先建立紀錄**，客戶端就只能「不知道退款有沒有發生」——
而重試會有重複退款的風險。
**這是「非冪等操作 + 結果未知」的標準解法**（03-rest-api 第 08 章 8.2）。

**前端處理**

```typescript
// api/refund.ts
async function requestRefund(paymentId: string, amount: string, idempotencyKey: string) {
  const res = await fetch(`/payments/${paymentId}/refunds`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({ amount }),
  });

  if (res.ok) return await res.json();

  const problem: Problem = await res.json();

  switch (problem.code) {
    case 'RESOURCE_NOT_FOUND':
      // 資料已被刪除或 ID 錯 → 重新載入列表
      showError('找不到這筆付款，請重新整理頁面。');
      refreshPaymentList();
      break;

    case 'PAYMENT_NOT_REFUNDABLE':
      if (problem.alternativeAction?.code === 'CHECK_PAYMENT_STATUS') {
        // 還在處理中 → 開始輪詢，不要讓使用者一直按
        showInfo(problem.userMessage);
        startPolling(problem.alternativeAction.href, { intervalMs: 3000, maxAttempts: 20 });
      } else {
        showError(problem.userMessage);
      }
      break;

    case 'REFUND_EXCEEDS_PAYMENT':
      // ★ 用 errors[] 標紅欄位 + 用擴充欄位自動修正
      markFieldError('amount', problem.errors![0].message);
      setFieldMax('amount', problem.refundableAmount);
      setFieldValue('amount', problem.refundableAmount);       // 貼心：直接填上可退金額
      break;

    case 'REFUND_WINDOW_EXPIRED':
      // 顯示訊息 + 一顆「申請人工退款」按鈕
      showErrorWithAction(problem.userMessage, {
        label: problem.alternativeAction!.label,
        onClick: () => navigate('/support/new-ticket?type=MANUAL_REFUND'
                                + `&paymentId=${problem.paymentId}`),
      });
      break;

    case 'PAYMENT_OUTCOME_UNKNOWN':
      // ★ 絕對不能自動重試（retryStrategy = CHECK_STATUS）
      showWarning(problem.userMessage);
      disableSubmitButton();                                   // ★ 防止使用者重複送
      startPolling(problem.statusCheckUrl!, {
        initialDelayMs: problem.recommendedCheckAfterSeconds! * 1000,
        intervalMs: 5000,
        maxAttempts: 24,                                       // 最多 2 分鐘
        onResolved: (refund) => {
          enableSubmitButton();
          if (refund.status === 'SUCCEEDED') showSuccess('退款已完成');
          else if (refund.status === 'FAILED') showError('退款失敗，請聯絡客服');
        },
        onTimeout: () => showWarning(
          `退款狀態仍在確認中，請稍後查看。追蹤碼：${problem.traceId.slice(0, 8)}`),
      });
      break;

    default:
      // ★ 未知的 code 一律用 userMessage 顯示（新增 code 不會讓前端壞掉）
      showError(problem.userMessage ?? '操作失敗，請稍後再試。');
      if (problem.status >= 500) {
        Sentry.captureMessage(`Refund failed: ${problem.code}`, {
          level: 'error',
          extra: { traceId: problem.traceId, paymentId },
        });
      }
  }
}
```

**這段前端程式碼證明了整章的設計是值得的**：

| 設計 | 前端得到什麼 |
|---|---|
| 精確的 `code` | 可以 `switch`，每種情況有專屬處理 |
| `errors[].field` | 標紅正確的輸入框 |
| 擴充欄位（`refundableAmount`） | 自動填入正確的值 |
| `alternativeAction` | 直接渲染成一顆按鈕 |
| `retryStrategy` | 知道能不能自動重試（`CHECK_STATUS` 時**禁止**重試） |
| `statusCheckUrl` | 知道去哪裡輪詢 |
| `traceId` | 客訴時能提供 |
| `default` 分支 | **新增 `code` 不會讓前端壞掉** |

</details>

### 練習 3：找出這個 advice 的 8 個問題

```java
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Map<String, Object>> handleAll(Exception e) {
        e.printStackTrace();
        Map<String, Object> body = new HashMap<>();
        body.put("success", false);
        body.put("message", e.getMessage());
        body.put("timestamp", System.currentTimeMillis());
        return ResponseEntity.status(500).body(body);
    }

    @ExceptionHandler(BusinessException.class)
    public ResponseEntity<Map<String, Object>> handleBusiness(BusinessException e) {
        Map<String, Object> body = new HashMap<>();
        body.put("success", false);
        body.put("code", e.getErrorCode());
        body.put("message", e.getMessage());
        return ResponseEntity.ok(body);
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<String> handleValidation(MethodArgumentNotValidException e) {
        String msg = e.getBindingResult().getFieldErrors().stream()
                .map(f -> f.getField() + ": " + f.getDefaultMessage())
                .collect(Collectors.joining(", "));
        return ResponseEntity.badRequest().body(msg);
    }
}
```

<details>
<summary>解答</summary>

| # | 問題 | 後果 |
|---|---|---|
| 1 | **`e.printStackTrace()`** | 寫到 `System.err`，繞過 logging framework → 沒有 `traceId`、沒有結構化欄位、在容器裡可能完全遺失、無法調整等級 |
| 2 | **`handleBusiness` 回 `ResponseEntity.ok()`（200）** | 3.2.2 損失 1：監控、熔斷、重試、健康檢查全部失效 |
| 3 | **`e.getMessage()` 直接回傳** | 3.11.1 的資訊洩漏。SQL、內部 IP、helpful NPE 的類別結構全部外洩 |
| 4 | **`handleValidation` 回 `String` 而不是 JSON** | `Content-Type` 是 `text/plain`，前端 `res.json()` 拋 `SyntaxError`。而且失去 `field` 的結構 → 無法標紅欄位 |
| 5 | **三個 handler 三種格式** | `{success, message, timestamp}`、`{success, code, message}`、純字串。前端要寫 3.2.1 的 `extractError()` |
| 6 | **`Exception.class` 會吃掉 `AccessDeniedException`** | 3.3.5 的陷阱：403 變 500 + 觸發告警 |
| 7 | **沒有處理 Spring 內建例外** | 405 / 415 / 406 / 404 全部落到 `Exception.class` → 變成 500。客戶端的錯被當成伺服器的錯 |
| 8 | **沒有 `traceId`** | 客服拿不到任何線索；跨服務追蹤不可能 |

**額外五個（送你）**：

| # | 問題 |
|---|---|
| 9 | `handleAll` 也會吃掉 `ClientAbortException`（客戶端斷線）→ 誤報 500 |
| 10 | `Map<String, Object>` + `HashMap` → **欄位順序不固定**，回應無法 diff、測試 flaky |
| 11 | 沒有 `Cache-Control: no-store` → 錯誤回應可能被 CDN 或瀏覽器快取（03-rest-api 4.4.5） |
| 12 | `timestamp` 用 epoch 毫秒 → 03-rest-api 第 03 章 3.6：時間一律 ISO-8601 字串 |
| 13 | `handleValidation` 用 `getFieldErrors()` → **漏掉 `getGlobalErrors()`**（類別層級的跨欄位驗證錯誤，02 章 2.7.3）。使用者送了矛盾的欄位組合，回應會是空字串 |

⚠️ **第 13 點很隱蔽**：`getFieldErrors()` 只回 `FieldError`。
如果驗證失敗全部來自 `@AssertTrue`（沒有 field），`msg` 會是空字串 →
回 `400` + 空 body → 前端不知道發生什麼。

**必須用 `getAllErrors()`**（3.14 的 `ValidationErrorTranslator.from()` 就是這樣做的）。

**修正版**：本章 3.7.2 的 `ApiExceptionHandler`。

</details>

### 練習 4：advice 自己壞掉時會發生什麼

給定 3.6.3 的 `ProblemFactory`，回答：

1. 如果 `error-messages.properties` 檔案不存在（打包時漏了），會發生什麼？
2. 如果某個 `ErrorCode` 的 `userMessage` 是 `"金額 {0} 元，餘額 {1} 元"` 但例外只傳了一個參數，會發生什麼？
3. 如果 `MDC` 裡沒有 `traceId`（`TraceIdFilter` 沒跑，例如單元測試），會發生什麼？
4. 如果 `BusinessException.extensions()` 裡有一個無法被 Jackson 序列化的物件，會發生什麼？
5. 對每一種情況，寫出防護方式。

<details>
<summary>解答</summary>

**1. 訊息檔不存在**

`MessageSource.getMessage(key, args, defaultMessage, locale)` 有 `defaultMessage` 參數 → 
**回傳 fallback，不拋例外** ✅

`ProblemFactory.message()` 已經用了這個多載：

```java
return messageSource.getMessage(key, args, fallback, locale);
```

**結果**：
- `title` = `ErrorCode` 的常數名稱（例如 `"INSUFFICIENT_STOCK"`）
- `userMessage` = `"操作無法完成，請稍後再試。"`

**服務仍然正常運作，只是訊息變差。** 這是正確的降級行為。

⚠️ **但如果用的是 `getMessage(key, args, locale)`（沒有 fallback）**，
會拋 `NoSuchMessageException` → advice 拋例外 → 3.3.6 → **HTML 回應**。

**防護**：
- 一律用帶 `defaultMessage` 的多載（已做）。
- 3.4.5 的測試會在 CI 抓到缺失的 key。
- **加一個啟動檢查**（fail fast）：

```java
package example.shop.common.error;

import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.MessageSource;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * 啟動時驗證所有 ErrorCode 都有訊息。
 * ⚠️ 比測試更強：它在「打包漏檔」這種只在正式環境發生的情況下也會失敗。
 */
@Component
public class ErrorMessageStartupValidator {

    private final MessageSource messageSource;
    private final boolean failFast;

    public ErrorMessageStartupValidator(MessageSource messageSource,
                                        ApiProblemProperties props) {
        this.messageSource = messageSource;
        this.failFast = props.failOnMissingErrorMessage();
    }

    @EventListener(ApplicationReadyEvent.class)
    public void validate() {
        var missing = new java.util.TreeSet<String>();
        var locale = java.util.Locale.forLanguageTag("zh-TW");

        for (ErrorCode code : ErrorCode.values()) {
            for (String key : new String[]{code.titleKey(), code.userMessageKey()}) {
                String resolved = messageSource.getMessage(key, new Object[]{"", "", ""},
                                                           null, locale);
                if (resolved == null) missing.add(key);
            }
        }
        if (missing.isEmpty()) return;

        String message = "缺少 %d 個錯誤訊息：%s".formatted(missing.size(), missing);
        if (failFast) throw new IllegalStateException(message);
        org.slf4j.LoggerFactory.getLogger(getClass()).error(message);
    }
}
```

⚠️ **`failFast` 做成設定** —— 正式環境開啟（寧可啟動失敗也不要回爛訊息），
本機開發可以關閉（避免加新 code 時被卡住）。

**2. 訊息參數數量不足**

```
訊息：「金額 {0} 元，餘額 {1} 元」
參數：new Object[]{"1280.50"}
```

`MessageFormat` 的行為：**原樣輸出 `{1}`，不拋例外。**

```
使用者看到：「金額 1280.50 元，餘額 {1} 元」
```

**難看，但不會壞掉。**

⚠️ **反過來（參數多於佔位符）也不會拋例外**，多的參數被忽略。

**防護**：3.4.5 的「訊息插值後不可留下未替換的 `{n}`」測試。

⚠️ **但那個測試傳 6 個參數，所以抓不到「呼叫端只傳 1 個」的情況。**

**更完整的防護**：在例外類別上加測試。

```java
@ParameterizedTest
@MethodSource("allBusinessExceptions")
void 每個業務例外的參數數量都符合訊息模板(BusinessException ex) {
    Problem p = factory.from(ex, "/test");
    assertThat(p.userMessage())
            .as("%s 的 userMessageArgs 數量不足", ex.getClass().getSimpleName())
            .doesNotMatch(".*\\{\\d+.*");
}

/** 用反射／手工列出每個業務例外的一個實例。 */
static Stream<BusinessException> allBusinessExceptions() {
    return Stream.of(
        new InsufficientStockException("P-1", "商品", 5, 3, LocalDate.now(), 0),
        new OrderNotCancellableException("ord_1", "ORD-1", OrderStatus.SHIPPED,
                Set.of(OrderStatus.PAID), LocalDate.now()),
        new RefundExceedsPaymentException("pay_1", new BigDecimal("100"),
                new BigDecimal("50"), new BigDecimal("200"), "TWD")
        // …每個業務例外一行
    );
}
```

⚠️ **這個清單要手工維護，會漏。** 用一個 ArchUnit 測試守住：

```java
@Test
void 每個BusinessException子類別都要出現在測試清單裡() {
    var subclasses = new ClassFileImporter().importPackages("example.shop").stream()
            .filter(c -> c.isAssignableTo(BusinessException.class))
            .filter(c -> !c.getModifiers().contains(JavaModifier.ABSTRACT))
            .map(JavaClass::getName).collect(Collectors.toSet());

    var tested = allBusinessExceptions().map(e -> e.getClass().getName())
            .collect(Collectors.toSet());

    assertThat(subclasses).as("以下業務例外沒有訊息參數測試").isSubsetOf(tested);
}
```

**3. MDC 沒有 traceId**

`MDC.get("traceId")` 回 `null` → `ProblemFactory.currentTraceId()` 用
`Objects.requireNonNullElse(..., "unknown")` → **回 `"unknown"`** ✅

```json
{ "traceId": "unknown" }
```

⚠️ **但 5xx 的 `userMessage` 會變成**：

```
系統暫時發生問題，請稍後再試。若持續發生，請聯絡客服並提供追蹤碼 unknown。
```

**「追蹤碼 unknown」很尷尬。** 更好的處理：

```java
private String shortTraceId(String traceId) {
    return "unknown".equals(traceId) ? "（無）" : traceId.substring(0, Math.min(8, traceId.length()));
}
```

**或者更根本的做法：讓 traceId 永遠存在。**

`ProblemFactory` 在拿不到時**自己產生一個**：

```java
private String currentTraceId() {
    String existing = MDC.get(TraceContext.MDC_TRACE_ID);
    if (existing != null && !existing.isBlank()) return existing;

    // ★ 沒有就產生一個並放回 MDC，讓後續的 log 也能對上
    String generated = TraceContext.generate();
    MDC.put(TraceContext.MDC_TRACE_ID, generated);
    return generated;
}
```

⚠️ **這樣做的代價**：這個 traceId 不會出現在**這次請求之前**的 log 裡
（因為它是在錯誤發生時才產生的）。
但**錯誤本身的 log 會有它**（因為 `ErrorLogger` 在 `ProblemFactory` 之後執行），
所以客服還是查得到。**比 `unknown` 好。**

**4. 擴充欄位無法序列化**

```java
ext("order", someJpaEntity)      // ← Entity 有 lazy 關聯
```

Jackson 序列化 `Problem` 時拋 `HttpMessageNotWritableException`。

**而這發生在 advice 之後**（回傳 `ResponseEntity` 之後，`HandlerMethodReturnValueHandler` 階段），
所以：

```
advice 產生 Problem → 回傳 → Jackson 序列化 → 拋例外
  → DispatcherServlet 再次進入 processHandlerException
  → advice 的 handleHttpMessageNotWritable → 產生新的 Problem（500）
  → 但回應可能已經 committed（3.11.5）
  → 客戶端拿到損毀的 JSON
```

**防護（三層）**：

**① `ext()` 只接受簡單型別。**

```java
protected static Map<String, Object> ext(Object... keyValues) {
    if (keyValues.length % 2 != 0) {
        throw new IllegalArgumentException("ext() 需要成對的 key/value");
    }
    Map<String, Object> m = new LinkedHashMap<>();
    for (int i = 0; i < keyValues.length; i += 2) {
        Object value = keyValues[i + 1];
        if (value == null) continue;
        // ★ 只允許可安全序列化的型別
        if (!isSafeForJson(value)) {
            throw new IllegalArgumentException(
                    "擴充欄位 '%s' 的型別 %s 不適合放進錯誤回應"
                            .formatted(keyValues[i], value.getClass().getName()));
        }
        m.put((String) keyValues[i], value);
    }
    return m;
}

private static boolean isSafeForJson(Object v) {
    if (v instanceof CharSequence || v instanceof Number || v instanceof Boolean
            || v instanceof java.time.temporal.Temporal || v instanceof Enum<?>
            || v instanceof AlternativeAction) {
        return true;
    }
    if (v instanceof java.util.Collection<?> c) {
        return c.stream().allMatch(BusinessException::isSafeForJson);
    }
    if (v instanceof java.util.Map<?, ?> m) {
        return m.keySet().stream().allMatch(k -> k instanceof String)
                && m.values().stream().allMatch(BusinessException::isSafeForJson);
    }
    return false;
}
```

⚠️ **這個檢查會在建構例外時拋 `IllegalArgumentException`** ——
也就是**在 Service 拋業務例外的那一刻**，而不是在序列化時。
於是它變成一個開發期就會發現的錯誤（而且測試會抓到）。

**② 測試：每個業務例外都能被序列化。**

```java
@ParameterizedTest
@MethodSource("allBusinessExceptions")
void 每個業務例外的Problem都能序列化(BusinessException ex) {
    Problem p = factory.from(ex, "/test");
    assertThatCode(() -> objectMapper.writeValueAsString(p))
            .doesNotThrowAnyException();
}
```

**③ ArchUnit：例外類別不可依賴 Entity。**

```java
@Test
void 例外類別不可依賴entity() {
    noClasses().that().areAssignableTo(BusinessException.class)
        .should().dependOnClassesThat().areAnnotatedWith(jakarta.persistence.Entity.class)
        .because("Entity 放進擴充欄位會導致序列化失敗與資料洩漏")
        .check(classes);
}
```

**這一題的整體結論**：

> **錯誤處理程式碼的每一個「如果失敗」都要有明確答案。**
> 而答案應該是「降級（訊息變差）」而不是「崩潰（回 HTML）」。
>
> 檢核方式：把 `ProblemFactory` 的每一行問一次「這裡如果回 null / 拋例外，會怎樣？」

</details>

---

## 3.17 驗收清單

- [ ] 我能說出「213 個 try-catch」造成的五個具體損失，尤其是「監控完全失效」。
- [ ] 我知道 `HandlerExceptionResolver` 鏈的三個環節與各自的作用。
- [ ] 我知道 `DispatcherServlet` 會 catch `Throwable` 並包成 `ServletException`。
- [ ] 我知道 `ResponseStatusExceptionResolver` 用 `sendError`，所以 body 交給 `/error`。
- [ ] 我知道 Controller 內的 `@ExceptionHandler` 永遠贏過 advice，並用 ArchUnit 禁止它。
- [ ] **我知道跨 advice 時「順序贏過精確度」，也知道這造成過「新模組例外全變 500」的事故。**
- [ ] 我知道同一個 advice 內用 `ExceptionDepthComparator` 選最精確的方法。
- [ ] 我知道模糊的 `@ExceptionHandler` 會在啟動時失敗（快速失敗）。
- [ ] 我知道 advice 方法可以宣告 `HandlerMethod` 參數，並用它做低基數的指標標籤。
- [ ] **我能說出六種進不了 advice 的例外，以及每一種的處理方式。**
- [ ] **我知道 `@PreAuthorize` 的 `AccessDeniedException` 會被 catch-all 吃掉變成 500。**
- [ ] 我知道 advice 自己拋例外會導致回應變成 HTML，所以它必須極度防禦性。
- [ ] 我能用 enum 建立錯誤碼註冊表，並說出它相對於字串常數 / YAML 的優勢。
- [ ] 我知道 `MessageFormat` 的單引號陷阱與數字千分位陷阱。
- [ ] 我會寫註冊表的一致性測試（唯一 slug、命名規範、訊息完整、重試語意、5xx 不洩漏）。
- [ ] 我能設計三層例外結構，並說出「已預期 vs 未預期」在日誌與告警上的差別。
- [ ] 我知道 `writableStackTrace = false` 能省 80 倍的建構成本，也知道它的代價與折衷。
- [ ] **我能說出五個不用 `ResponseStatusException` 的理由，第一個是「`@ResponseStatus` 完全不產生 body」。**
- [ ] 我知道 `ErrorCode` 帶 `HttpStatus` 是一個妥協，也知道另外兩個選項的取捨。
- [ ] 我能比較 Spring 的 `ProblemDetail` 與自訂 record，並知道 `@JsonAnyGetter` 的邊角。
- [ ] 我知道 `ProblemFactory` 是唯一的組裝點，被 advice / Filter / Security 三處共用。
- [ ] 我知道 `instance` 不能含 query string（敏感參數 + 指標基數）。
- [ ] 我知道繼承 `ResponseEntityExceptionHandler` 能免費取得 20+ 種內建例外的正確狀態碼。
- [ ] 我知道其中五種是 500（`MissingPathVariable`、`HttpMessageNotWritable` 等），因為那是伺服器 bug。
- [ ] **我知道 `spring.mvc.problemdetails.enabled=true` 會讓我的 advice 失效，也知道怎麼驗證。**
- [ ] 我知道 405 必須帶 `Allow` header，並知道要保留父類別放進去的 headers。
- [ ] 我能把資料庫約束名對映到 `ErrorCode`，並知道它是 TOCTOU 的最後防線。
- [ ] 我知道 404 預設走 `sendError` 進不了 advice，也知道 Boot 3.2 的 `NoResourceFoundException` 改變了什麼。
- [ ] 我知道 `add-mappings: false` 會弄壞 Swagger UI。
- [ ] 我能區分 `ENDPOINT_NOT_FOUND` 與 `RESOURCE_NOT_FOUND`，並說出前端為什麼需要這個區分。
- [ ] 我知道「無權存取回 404 而不是 403」的理由與代價。
- [ ] 我會接管 `/error` 當安全網，並讓它記一個「advice 有漏洞」的指標。
- [ ] **我能從 `JsonMappingException.getPath()` 組出 `items[0].quantity`。**
- [ ] 我知道 Jackson 例外的階層，包含 `ValueInstantiationException`（record 的 compact constructor）。
- [ ] 我知道絕不能透傳 Jackson 的原始訊息（它含完整套件路徑與類別結構）。
- [ ] 我能實作「您是否想輸入」，也知道 Levenshtein 的 DoS 風險與長度限制。
- [ ] 我知道 `rejectedValue` 要遮蔽敏感欄位、截斷長字串、不回顯集合內容。
- [ ] 我知道 Filter 必須用 `ProblemWriter` 自己寫 JSON，並先檢查 `isCommitted()`。
- [ ] 我知道 401 必須帶 `WWW-Authenticate` header。
- [ ] 我能區分 `TOKEN_EXPIRED` / `INVALID_TOKEN` / `AUTHENTICATION_REQUIRED`，並說出前端的三種不同反應。
- [ ] 我知道 Nginx 的錯誤頁也要是 JSON，也知道 `return` 的狀態碼不能是變數。
- [ ] 我能列出四層錯誤來源，並用參數化測試驗證它們格式一致。
- [ ] **我知道 5xx 的 `detail` 必須是固定文字，也知道 Java 15+ 的 helpful NPE 會洩漏什麼。**
- [ ] 我能執行完整的資訊洩漏檢查清單（13 項）。
- [ ] 我會寫資訊洩漏的迴歸測試，並知道它會在「有人為了除錯把訊息加回來」時失敗。
- [ ] 我知道 `OutOfMemoryError` 應該用 `-XX:+ExitOnOutOfMemoryError` 處理，而不是嘗試接住它。
- [ ] 我知道 `StackOverflowError` 是局部的，接住它是安全的。
- [ ] 我知道回應序列化失敗（`HttpMessageNotWritableException`）可能已經 committed，要靠測試預防。
- [ ] 我能設計錯誤的日誌分級表，並說出「4xx 不印 stack trace」的成本理由。
- [ ] 我知道客戶端斷線不該記 error，也知道 499 的用法。
- [ ] **我知道自訂指標的標籤只能用「自己定義的有限列舉」，也能估算時間序列數量。**
- [ ] 我知道 Micrometer 的 `http_server_requests` 用路徑模板當 `uri` 標籤，所以基數安全。
- [ ] 我能設計六種告警規則，包含「業務錯誤暴增」這種收件人不是後端團隊的告警。
- [ ] 我知道「70 條端點、0 個 try-catch」是可以達成並用 `grep` 驗證的。
- [ ] 我能追蹤一個錯誤從 Service 拋出到使用者看到訊息、到客服查詢的完整鏈路。
- [ ] 我知道 `ErrorCode` 的 `plannedForLater` 清單本身就是待辦事項。
- [ ] 我能回答「advice 自己壞掉時會怎樣」的四種情況，並知道每一種的防護方式。
- [ ] 我知道 `MessageSource.getMessage` 要用帶 `defaultMessage` 的多載，否則會拋 `NoSuchMessageException`。
- [ ] 我會加啟動檢查（fail fast）驗證所有錯誤訊息存在。
- [ ] 我知道 `ext()` 應該拒絕無法安全序列化的型別，讓錯誤在開發期就出現。
- [ ] **我確認 HTTP 狀態碼永遠等於 body 裡的 `status`（RFC 9457 的要求，而且很容易在繼承時搞錯）。**

---

## 3.18 下一章預告

錯誤格式統一了，但有一個欄位一直是「假的」：**`traceId`**。

前面三章都寫 `MDC.get("traceId")`，但**還沒有任何程式碼把它放進去**。
04 章要補上這一塊，以及整個請求生命週期的橫切關注點：

- Filter vs Interceptor vs `HandlerMethodArgumentResolver` vs AOP 的**完整選擇決策表**。
- **`TraceIdFilter` 的完整實作**：接受上游的 `X-Request-Id`、驗證它（防 log injection）、
  產生自己的、放進 MDC、寫進回應 header、在 `finally` 清理。
- 虛擬執行緒與 `ThreadLocal`／MDC 的交互作用（第 00 章 0.9.3 的續集）。
- **請求日誌**：怎麼記 body 而不破壞後續讀取（`ContentCachingRequestWrapper`）、
  怎麼遮蔽敏感欄位、怎麼取樣。
- **`Pageable` 的硬上限**：在參數綁定「之前」驗證原始參數（03-rest-api 5.13.2 的實作）。
- **冪等鍵的 Interceptor**：怎麼在不動 70 個 Controller 的前提下加上冪等保護。
- 自訂 `HandlerMethodArgumentResolver`：把 `RequestContext` / `Actor` 注入方法參數。
- Filter 的順序：Spring Boot 內建的六個 filter 的 order 值，以及你的該插在哪裡。
- `OncePerRequestFilter` 為什麼存在（`forward` / `include` / 非同步 dispatch 的重複執行問題）。
- 非同步請求（`SseEmitter`、`DeferredResult`）的生命週期差異。

---

完成後請前往 [04-filter-interceptor-and-lifecycle.md](./04-filter-interceptor-and-lifecycle.md)。
