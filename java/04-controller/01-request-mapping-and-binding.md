# 第 01 章：路由與參數綁定

> 這一章要做的事很具體：把 03-rest-api 定案的 **70 條 URL** 變成 Java 方法簽章。
>
> 聽起來像是「查一下 `@GetMapping` 怎麼寫」就結束了。
> 但參數綁定是 Web 層**最多陷阱**的地方 ——
> 而且它的陷阱有一個共同特徵：**在開發環境不會出現，在正式環境才出現**。
> `@RequestParam(required = false) int page` 這一行會回 500，但只在客戶端不送 `page` 時；
> `?status=paid` 會回 400 而不是 422（連 `field` 都沒有），但只在客戶端用小寫時；
> `/orders/` 多一個斜線會 404，但只在某些前端框架自動加斜線時。
>
> 這一章把這些坑一次挖完。

---

## 1.1 學習目標

完成本章後，你應該可以：

- 說出 `@Controller` 與 `@RestController` 的差別，以及 `@ResponseBody` 到底做了什麼。
- 熟練使用 `@RequestMapping` 家族，包含 `consumes` / `produces` / `params` / `headers` 的用途。
- 說出兩條路由衝突時 Spring 用什麼規則選擇，並能預測結果。
- 知道 Spring Boot 3 的**尾斜線行為改變**，並選一種處理方式。
- 完整說明 `@PathVariable` / `@RequestParam` / `@RequestBody` / `@RequestHeader` / `@CookieValue` 的行為與陷阱。
- 解釋 `required`、`defaultValue`、`Optional` 三者的交互作用，並知道哪三種組合是 bug。
- 把 14 個查詢參數綁成**一個物件**（`OrderFilter`），而不是 14 個方法參數。
- 處理列舉綁定：大小寫、未知值、以及「怎麼回 422 而不是 500」。
- 用 `JsonNullable` 表達 `PATCH` 的三態語意（缺欄位 / `null` / 有值）。
- 註冊自訂 `Converter` 處理 API 專屬的型別（`Cursor`、`SortSpec`、`Money`）。
- 在「直接回 DTO」、「`@ResponseStatus`」、「`ResponseEntity`」之間做出有理由的選擇。
- 排查「我的端點回 404 / 400 / 415」的問題。

---

## 1.2 `@RestController` 到底是什麼

### 1.2.1 三個註解的關係

```java
@RestController                  // = @Controller + @ResponseBody
@Controller                      // = @Component + 「我是 Web handler」的語意標記
@ResponseBody                    // 「回傳值直接寫進 response body，不要當 view 名稱」
```

`@RestController` 的定義就這麼簡單：

```java
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
@Documented
@Controller
@ResponseBody
public @interface RestController {
    @AliasFor(annotation = Controller.class)
    String value() default "";
}
```

**`@ResponseBody` 沒有加會發生什麼？** 這是新手最迷惑的錯誤之一：

```java
@Controller                                   // ← 忘了用 @RestController
@RequestMapping("/orders")
public class OrderController {
    @GetMapping("/{id}")
    public OrderDetail get(@PathVariable String id) { ... }
}
```

Spring 會把回傳值當成 **view 名稱**（因為沒有 `@ResponseBody`）。
`OrderDetail` 不是 `String`，所以會走 `ModelAndViewMethodReturnValueHandler` / 
`ModelAttributeMethodProcessor` 的路徑，最後嘗試用**方法名稱推斷 view**，
結果通常是：

```
500 Internal Server Error
javax.servlet.ServletException: Circular view path [get]:
would dispatch back to the current handler URL again.
```

或者（在沒有 view resolver 時）：

```
404 Not Found   ← 更迷惑，因為端點明明存在
```

> **排查口訣**：端點回 404 或「Circular view path」但你確定路徑對，
> 第一件事就是檢查類別上是 `@Controller` 還是 `@RestController`。

### 1.2.2 什麼時候該用 `@Controller`

只有一種情況：**這個類別要回傳 view**（Thymeleaf / JSP 模板）。

純 API 服務一律 `@RestController`。混合型專案（有頁面也有 API）建議**分開兩個類別**，
不要在同一個類別裡用 `@Controller` + 方法上加 `@ResponseBody`——
因為那樣「哪些方法回 JSON」要逐一檢查，很容易漏。

### 1.2.3 一個 Controller 該有多大

shop-service 的 70 條端點不會放在一個類別裡。切分規則：

| 切法 | 例子 | 何時用 |
|---|---|---|
| **一個資源一個 Controller** | `OrderController`（`/orders` 的 CRUD） | 預設做法 |
| **子資源獨立** | `OrderPaymentController`（`/orders/{id}/payments`） | 子資源有 3 條以上端點，或權限不同 |
| **依角色切** | `OrderSupportController`（`/support/orders/…`） | 客服／後台的端點與顧客差異大 |

shop-service 訂單相關的切法：

```
OrderController                 GET/POST /orders, GET/PATCH /orders/{id}
OrderItemController             GET /orders/{id}/items
OrderInvoiceController          GET/PUT /orders/{id}/invoice
OrderPaymentController          GET/POST /orders/{id}/payments
OrderCancellationController     GET/POST /orders/{id}/cancellations
OrderShipmentController         GET/POST /orders/{id}/shipments
OrderReturnController           GET/POST /orders/{id}/returns
OrderStatusChangeController     GET /orders/{id}/status-changes
OrderShippingAddressController  PATCH /orders/{id}/shipping-address
OrderExportController           POST/GET /order-exports
OrderEventStreamController      GET /orders/{id}/events （SSE）
```

**11 個類別，平均 2～3 個方法。** 這比一個 800 行的 `OrderController` 好，理由：

- PR 的 diff 範圍小，review 看得懂。
- 兩個人同時改「付款」和「出貨」不會有 merge conflict。
- 測試檔案也是 1:1（`OrderPaymentControllerTest` 只測付款）。

⚠️ **但不要走極端**：一個端點一個類別會讓「訂單有哪些端點」變得看不出來。
判準：**同一個資源、同一組權限、會一起改的端點放一起。**

---

## 1.3 `@RequestMapping` 家族

### 1.3.1 六個 shortcut 與完整形式

```java
@GetMapping     = @RequestMapping(method = RequestMethod.GET)
@PostMapping    = @RequestMapping(method = RequestMethod.POST)
@PutMapping     = @RequestMapping(method = RequestMethod.PUT)
@PatchMapping   = @RequestMapping(method = RequestMethod.PATCH)
@DeleteMapping  = @RequestMapping(method = RequestMethod.DELETE)
```

⚠️ **沒有 `@HeadMapping` 與 `@OptionsMapping`** —— 因為 Spring 自動處理它們：

| 方法 | Spring 的自動行為 |
|---|---|
| `HEAD` | 自動對映到同路徑的 `@GetMapping`，執行後**丟掉 body 只回 header**（含正確的 `Content-Length`） |
| `OPTIONS` | 自動回 `Allow: GET, HEAD, POST`（列出該路徑支援的方法）。CORS 預檢由 Security / CORS filter 處理 |
| `TRACE` | 預設不支援，回 405 |

**`HEAD` 的自動支援有一個代價**：它會真的執行你的方法（包含查資料庫），
只是不寫 body。所以如果 `GET /order-exports/{id}/file` 是一個 200 MB 的檔案，
`HEAD` 請求也會把它產生出來。需要優化時要自己宣告 `@RequestMapping(method = HEAD)`。

### 1.3.2 完整屬性表

```java
@RequestMapping(
    path     = "/orders/{orderId}",              // 路徑（value 的別名）
    method   = RequestMethod.POST,               // HTTP 方法
    consumes = "application/json",               // 我吃什麼 → 不符回 415
    produces = "application/json",               // 我吐什麼 → 不符回 406
    params   = "type=urgent",                    // 必須有這個查詢參數
    headers  = "X-Api-Version=2"                 // 必須有這個 header
)
```

| 屬性 | 不符合時 | 用途 |
|---|---|---|
| `path` | 404 | 路由 |
| `method` | **405** + `Allow` header | 路由 |
| `consumes` | **415** Unsupported Media Type | 比對請求的 `Content-Type` |
| `produces` | **406** Not Acceptable | 比對請求的 `Accept` |
| `params` | **400** `UnsatisfiedServletRequestParameterException` | 同路徑不同參數分派到不同方法 |
| `headers` | 404 | header 版本控管（03-rest-api 第 06 章） |

⚠️ **`params` 與 `headers` 不符合時的行為【不一樣】，而這個差別很少有人知道**：

```java
@GetMapping(params = "cursor")     public ... byCursor(...) { }
@GetMapping(params = "page")       public ... byPage(...) { }
```

客戶端送 `GET /orders`（兩個參數都沒帶）→ **400**，而不是 404，也不是
「請提供 page 或 cursor」。

**機制**：`RequestMappingInfoHandlerMapping.handleNoMatch()` 會做「部分比對」——

```java
// RequestMappingInfoHandlerMapping.handleNoMatch()（節錄、簡化）
PartialMatchHelper helper = new PartialMatchHelper(infos, request);
if (helper.isEmpty()) return null;                       // → 404

if (helper.hasMethodsMismatch())  throw new HttpRequestMethodNotSupportedException(...);   // 405
if (helper.hasConsumesMismatch()) throw new HttpMediaTypeNotSupportedException(...);       // 415
if (helper.hasProducesMismatch()) throw new HttpMediaTypeNotAcceptableException(...);      // 406
if (helper.hasParamsMismatch()) {
    throw new UnsatisfiedServletRequestParameterException(                                 // ★ 400
            helper.getParamConditions(), request.getParameterMap());
}
return null;                                             // 其他（含 headers 不符）→ 404
```

**所以**：

| 只有這一項不符 | 結果 |
|---|---|
| `method` | 405 |
| `consumes` | 415 |
| `produces` | 406 |
| **`params`** | **400** ★ `handleNoMatch` 有專門的分支 |
| **`headers`** | **404** ★ `handleNoMatch` **沒有** headers 的分支，落到 `return null` |

⚠️ **`UnsatisfiedServletRequestParameterException` 是一個很容易漏掉的例外**：
它是 `ServletRequestBindingException` 的子類別，所以
`ResponseEntityExceptionHandler` 會處理它（回 400）——
但**它的預設回應沒有告訴客戶端「缺哪一個參數」**。
03 章 3.5.2 有它的專屬 handler（會把 `getParamConditions()` 放進 `errors[]`）。

👉 **解法**：一定要有一個「不帶 params 條件」的 fallback 方法，或不要用 `params` 分派。
shop-service 的選擇是**不用 `params` 分派**，改成一個方法內部判斷（見 1.7.4）。

### 1.3.3 `consumes` 與 `produces` 一定要寫

```java
@RestController
@RequestMapping(path = "/orders", produces = MediaType.APPLICATION_JSON_VALUE)
public class OrderController {

    @PostMapping(consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<CreateOrderResponse> create(@Valid @RequestBody CreateOrderRequest r) { }
}
```

**為什麼要明確寫，不能靠預設？**

不寫 `consumes` 時，Spring 會嘗試用任何可用的 `HttpMessageConverter` 解析 body。
如果客戶端送 `Content-Type: text/plain` 加一段 JSON 文字：

```
不寫 consumes → Jackson converter 不接受 text/plain
              → 找不到 converter
              → HttpMediaTypeNotSupportedException → 415（結果一樣）
```

看起來一樣，但差別在**文件**與**明確性**：

| 好處 | 說明 |
|---|---|
| **OpenAPI 正確** | springdoc 讀 `consumes` / `produces` 產生文件。不寫的話文件會列出所有 converter 支援的型別（包含你不想支援的） |
| **路由分派** | 同路徑可依 `Content-Type` 分派（例如 `application/json` 和 `multipart/form-data` 兩個 handler） |
| **415 發生得更早** | 在找 handler 階段就決定，不用等到解析 body |
| **防止意外支援** | 專案加了 XML converter 後，你的端點會突然開始接受 XML。這是攻擊面（XXE） |

⚠️ 最後一條是真的資安問題。加了 `jackson-dataformat-xml` 之後，
所有沒寫 `consumes` 的端點都會自動接受 `application/xml`。

**shop-service 的規則**：`produces` 寫在**類別**上（整個 Controller 都回 JSON），
`consumes` 寫在**有 body 的方法**上。

### 1.3.4 路由衝突時 Spring 怎麼選 ★

這一節解答「為什麼我的請求被送到另一個方法」。

```java
@GetMapping("/orders/{orderId}")     public ... a(...) { }
@GetMapping("/orders/summary")       public ... b(...) { }
```

`GET /orders/summary` 會進哪一個？

**答案是 `b`。** Spring 會蒐集所有「符合」的 handler，然後排序取第一名。
排序規則（`RequestMappingInfo.compareTo`）依序比較：

```
1. patterns   ← 路徑的「具體程度」，最重要
2. params     ← params 條件多的贏
3. headers    ← headers 條件多的贏
4. consumes   ← 更具體的 media type 贏
5. produces   ← 同上
6. methods    ← 方法條件較少的（也就是更通用的）排後面
7. 最後：custom condition
```

**路徑具體程度的排序（`PathPattern.SPECIFICITY_COMPARATOR`）**：

```
字面值            /orders/summary        最具體
  ↓
單一捕捉變數      /orders/{orderId}
  ↓
單段通用符        /orders/*
  ↓
多段通用符        /orders/**             最不具體
```

所以：

| 請求 | 候選 | 選中 |
|---|---|---|
| `GET /orders/summary` | `/orders/{orderId}`、`/orders/summary` | `/orders/summary`（字面值贏） |
| `GET /orders/ord_123` | `/orders/{orderId}` | `/orders/{orderId}` |

⚠️ **這個機制救了你，但也可能咬你。** 真實案例：

```java
@GetMapping("/orders/{orderId}")  public OrderDetail get(@PathVariable String orderId) { }
```

某天前端呼叫 `GET /orders/undefined`（JS 的 `undefined` 被字串化了）。
Spring 開心地把 `orderId = "undefined"` 傳進來 → 查不到 → 404 → 沒問題。

但如果你有：

```java
@GetMapping("/orders/export")     // 新加的
```

而前端呼叫 `GET /orders/Export`（大寫 E）→ 字面值不符 → 
落到 `/orders/{orderId}`，`orderId = "Export"` → 查不到 → 404。
**訊息會是「訂單 Export 不存在」而不是「路徑錯誤」**，除錯時容易誤導。

👉 這是 03-rest-api 第 01 章「不要在資源路徑上混用動作字面值」的實作層理由。
shop-service 用 `POST /order-exports`（頂層資源）而不是 `GET /orders/export`，就避開了整類問題。

**兩個路由完全一樣時會怎樣？**

```java
@GetMapping("/orders/{id}")   public ... a(@PathVariable String id) { }
@GetMapping("/orders/{oid}")  public ... b(@PathVariable String oid) { }
```

**啟動就失敗**（快速失敗，很好）：

```
java.lang.IllegalStateException: Ambiguous mapping.
Cannot map 'orderController' method
example.shop.order.web.OrderController#b(String)
to {GET [/orders/{oid}]}: There is already 'orderController' bean method
example.shop.order.web.OrderController#a(String) mapped.
```

⚠️ 但「幾乎一樣」不會失敗，只會在執行時選一個 —— 那才是難查的。

### 1.3.5 Spring Boot 3 的尾斜線 breaking change ★

**Spring Framework 6.0（Boot 3.0）起，尾斜線不再自動比對。**

```java
@GetMapping("/orders")
public PageResponse<OrderSummary> list() { }
```

| 請求 | Spring Boot 2.x | Spring Boot 3.x |
|---|---|---|
| `GET /orders` | ✅ 200 | ✅ 200 |
| `GET /orders/` | ✅ 200 | ❌ **404** |

**這是升級 Boot 3 最常見的線上事故之一**，因為：

- 有些前端 HTTP client（或反向代理設定）會自動補尾斜線。
- 有些 API 文件範例被人手工複製時多帶了斜線。
- 有些第三方 webhook 註冊的 URL 帶尾斜線，你改不了。

**三種處理方式：**

**方式 A：在反向代理層做 301 重導向（Spring 官方推薦）**

```nginx
# Nginx：把 /orders/ 重導到 /orders
location ~ ^(.+)/$ {
    return 301 $1$is_args$args;
}
```

- ✅ 應用程式碼乾淨，符合「一個資源一個 URL」（03-rest-api 第 01 章）。
- ❌ 需要動基礎設施；`POST` 的 301 重導在部分客戶端會變成 `GET`（要用 **308** 才保留方法）。

**方式 B：用 Filter 在應用內做重導向**

```java
package example.shop.common.web;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * Spring Boot 3 起尾斜線不再自動比對（Spring Framework 6.0 breaking change）。
 * 這個 filter 把 /orders/ 用 308 重導到 /orders，保留 HTTP 方法與 body。
 */
@Component
@Order(-120)                             // 早於 Security（-100），晚於 traceId（-121）
public class TrailingSlashRedirectFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res,
                                    FilterChain chain) throws ServletException, IOException {
        String path = req.getRequestURI();

        if (path.length() > 1 && path.endsWith("/")) {
            String target = path.substring(0, path.length() - 1);
            String query = req.getQueryString();
            if (query != null) target = target + "?" + query;

            // ★ 308 Permanent Redirect：保留方法與 body（301 會讓 POST 變成 GET）
            res.setStatus(HttpServletResponse.SC_PERMANENT_REDIRECT);   // 308
            res.setHeader("Location", target);
            return;
        }
        chain.doFilter(req, res);
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest req) {
        // 不動 actuator 與 swagger 的路徑
        String p = req.getRequestURI();
        return p.startsWith("/actuator") || p.startsWith("/swagger-ui")
                || p.startsWith("/v3/api-docs");
    }
}
```

⚠️ `HttpServletResponse` 沒有 `SC_PERMANENT_REDIRECT` 常數（Servlet API 只到 307）。
實務上寫 `res.setStatus(308)` 或用 `HttpStatus.PERMANENT_REDIRECT.value()`。

- ✅ 不用動基礎設施，行為明確可測試。
- ❌ 多一次往返（客戶端要跟著重導）。

**方式 C：兩個路徑都宣告（不推薦）**

```java
@GetMapping({"/orders", "/orders/"})
```

- ❌ 70 條端點要寫 140 個路徑，一定會漏。
- ❌ 違反「一個資源一個 URL」—— 兩個 URL 回同樣的東西，SEO 與快取都會分裂。

**shop-service 的選擇：方式 B（Filter + 308）**，並在 07 章寫一個測試守住它：

```java
@Test
void 尾斜線用308重導到無斜線版本() throws Exception {
    mockMvc.perform(get("/orders/"))
           .andExpect(status().is(308))
           .andExpect(header().string("Location", "/orders"));
}
```

> ⚠️ 你可能會查到 `configurer.setUseTrailingSlashMatch(true)` 這個做法。
> 它在 Spring Framework 6.0 就標記為 **deprecated**，未來會移除。
> 短期救火可以用，但不要當長期方案。

### 1.3.6 `PathPatternParser` 與 `**` 的限制

Spring Boot 3 預設用 `PathPatternParser`（不是舊的 `AntPathMatcher`）解析路徑模式。
它更快（預先解析成樹狀結構）但有一個限制：

```java
@GetMapping("/files/**/thumb")        // ❌ PathPatternParser 不支援 ** 在中間
@GetMapping("/files/**")             // ✅ ** 只能在最後
```

啟動時會拋：

```
java.lang.IllegalArgumentException: No more pattern data allowed after '**' pattern element
```

如果你真的需要，可以切回舊實作（**但不建議**，因為它有 suffix pattern 的安全問題）：

```yaml
spring:
  mvc:
    pathmatch:
      matching-strategy: ant-path-matcher    # ⚠️ 舊行為，僅為了相容
```

### 1.3.7 路徑前綴：不要寫在每個 Controller 上

如果所有端點都要 `/api/v1` 前綴，**不要**在 70 個 Controller 上各寫一次：

```java
// ❌ 70 個檔案都要改
@RequestMapping("/api/v1/orders")
```

```java
// ✅ 集中設定
@Configuration
public class WebMvcConfig implements WebMvcConfigurer {
    @Override
    public void configurePathMatch(PathMatchConfigurer configurer) {
        configurer.addPathPrefix("/api/v1",
                c -> c.isAnnotationPresent(RestController.class)
                     && c.getPackageName().startsWith("example.shop"));
    }
}
```

或更簡單（但比較粗糙）：

```yaml
server:
  servlet:
    context-path: /api/v1      # ⚠️ 會影響 /actuator 與 /swagger-ui 也加前綴
```

**shop-service 的選擇**：兩個都不用。
版本放在 header 或不放（03-rest-api 第 06 章的結論：優先用相容性演進，不開 v2），
所以路徑就是 `/orders`。這也讓 URL 更乾淨。

---

## 1.4 `@PathVariable`

### 1.4.1 基本用法與名稱推斷

```java
@GetMapping("/orders/{orderId}")
public OrderDetail get(@PathVariable String orderId) { }          // 名稱推斷

@GetMapping("/orders/{orderId}")
public OrderDetail get(@PathVariable("orderId") String id) { }    // 明確指定
```

⚠️ **名稱推斷需要編譯時保留參數名稱。** Spring Framework 6.1 起，
如果 class 檔案沒有 `MethodParameters` 屬性，**啟動或第一次呼叫時會直接失敗**：

```
java.lang.IllegalArgumentException: Name for argument of type [java.lang.String]
not specified, and parameter name information not found in class file either.
```

（Spring 6.0 之前會用 debug 資訊裡的 `LocalVariableTable` 猜；6.1 移除了那個 fallback。）

```xml
<!-- spring-boot-starter-parent 已經設好；不用它當 parent 時要自己加 -->
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-compiler-plugin</artifactId>
  <configuration><parameters>true</parameters></configuration>
</plugin>
```

> **經驗建議：一律明確寫名稱。** 
> 多打 10 個字元，換掉一整類「本機好、CI 壞」的問題
> （因為 IDE 和 Maven 的編譯設定可能不同）。
> shop-service 的規則是所有 `@PathVariable` / `@RequestParam` 都寫出名稱。

### 1.4.2 型別轉換與失敗時的行為

```java
@GetMapping("/orders/{orderId}/items/{seq}")
public OrderItemResponse item(@PathVariable("orderId") String orderId,
                              @PathVariable("seq") int seq) { }
```

`seq` 不是數字時（`/orders/ord_1/items/abc`）：

```
MethodArgumentTypeMismatchException
  → DefaultHandlerExceptionResolver
  → 400 Bad Request
```

**這是 400，不是 404。** 值得討論一下對不對：

| 立場 | 論點 |
|---|---|
| **400** | 客戶端送了語法上無效的識別碼 → 是請求的錯 |
| **404** | 「`/items/abc` 這個資源不存在」也說得通，而且不洩漏「seq 是數字」這個資訊 |

03-rest-api 第 02 章的結論：**識別碼一律用字串型別**（`String`），
所以這個問題根本不會發生 —— 格式檢查交給 1.4.3 的正規表示式，
「找不到」統一回 404。

```java
// ✅ shop-service 的做法：ID 一律 String
@PathVariable("orderId") String orderId
```

### 1.4.3 用正規表示式約束路徑變數

```java
// ULID：26 個 Crockford Base32 字元
@GetMapping("/orders/{orderId:ord_[0-9A-HJKMNP-TV-Z]{26}}")
public OrderDetail get(@PathVariable("orderId") String orderId) { }
```

**好處**：格式不對的請求直接 404，不會進到你的方法、不會查資料庫。
這擋掉了大量掃描流量（`/orders/1`、`/orders/admin`、`/orders/../../etc/passwd`）。

**壞處與取捨** ★：

| 問題 | 說明 |
|---|---|
| **錯誤訊息變差** | 格式錯誤回 404「路徑不存在」，而不是 422「識別碼格式錯誤」。客戶端不知道自己哪裡錯 |
| **模式散落在 70 個地方** | ID 格式改了要改 70 處 |
| **不容易測試** | 正規表示式寫錯（少一個 `-`）只會在特定 ID 上失敗 |
| **可讀性差** | `@GetMapping("/orders/{orderId:ord_[0-9A-HJKMNP-TV-Z]{26}}")` 這行沒人想讀 |

**shop-service 的折衷**：路由層只做**最寬鬆**的長度與字元檢查（擋掉明顯的攻擊），
精確格式交給 Service（回 422 或 404，訊息清楚）：

```java
package example.shop.common.web;

/** 路徑變數的正規表示式常數，集中管理。 */
public final class PathPatterns {
    /** 寬鬆的識別碼：字母、數字、底線、連字號，長度 1～64。 */
    public static final String ID = "[A-Za-z0-9_-]{1,64}";
    private PathPatterns() {}
}
```

```java
@GetMapping("/orders/{orderId:" + PathPatterns.ID + "}")
public OrderDetail get(@PathVariable("orderId") String orderId) { }
```

⚠️ **注意這裡必須是編譯期常數**（`static final String` 的字串串接），
因為註解的值只能是常數表達式。

### 1.4.4 路徑變數含點的問題（Boot 3 已修好，但要知道）

**Spring Boot 2.x 以前**（`AntPathMatcher` + `useSuffixPatternMatch=true`）：

```
GET /products/P-1001.json
@GetMapping("/products/{productId}")
→ productId = "P-1001"        ← ⚠️ .json 被當成「格式後綴」吃掉了
```

這造成過真實的資料錯誤：SKU 是 `ABC.v2` 的商品，`productId` 變成 `ABC`。

**Spring Framework 5.3 起 suffix pattern matching 預設關閉，
Spring Boot 3 用 `PathPatternParser` 完全移除了這個行為**：

```
GET /products/P-1001.json
→ productId = "P-1001.json"   ✅ 完整
```

⚠️ **但另一個問題還在**：路徑變數**不能包含 `/`**（因為 `/` 是路徑分隔符）。

```
GET /files/docs/2026/report.pdf
@GetMapping("/files/{path}")     → 404（因為 {path} 只匹配一段）
```

解法：

```java
@GetMapping("/files/**")
public ResponseEntity<Resource> download(HttpServletRequest request) {
    String path = new org.springframework.web.util.UrlPathHelper()
            .getPathWithinApplication(request);          // 或用 PathPattern 抽取
    String relative = path.substring("/files/".length());
    // ⚠️ 一定要做路徑穿越（path traversal）檢查！見 05 章 5.4.2
}
```

**這是一個危險的模式**，因為 `**` 會吃進 `../../etc/passwd`。
05 章會給完整的安全下載實作。shop-service 的檔案下載改用**不含路徑的識別碼**：
`GET /order-exports/{exportId}/file`，徹底避開這個問題。

### 1.4.5 `Map<String, String>` 接全部路徑變數

```java
@GetMapping("/orders/{orderId}/items/{itemId}")
public ... get(@PathVariable Map<String, String> vars) {
    String orderId = vars.get("orderId");
}
```

**幾乎沒有正當用途。** 它讓方法簽章看不出需要什麼參數，OpenAPI 也產不出文件。
唯一的例外是寫通用的框架程式碼（例如一個代理 Controller）。

### 1.4.6 可選的路徑變數

```java
@GetMapping({"/orders", "/orders/{orderId}"})
public Object list(@PathVariable(required = false) String orderId) { }
```

**不要這樣寫。** 「列表」和「單筆」是兩件不同的事：回應型別不同、權限可能不同、
OpenAPI 也無法描述。分成兩個方法。

---

## 1.5 `@RequestParam`

這是陷阱最多的註解。

### 1.5.1 `required` / `defaultValue` / `Optional` 的三角關係 ★

先看完整規則表：

| 宣告 | 客戶端沒送 | 客戶端送 `?x=` （空值） | 客戶端送 `?x=5` |
|---|---|---|---|
| `@RequestParam("x") Integer x` | **400** `MissingServletRequestParameterException` | **400** ★ 見下方 ⑤ | `5` |
| `@RequestParam(name="x", required=false) Integer x` | `null` | `null` ⚠️ | `5` |
| `@RequestParam(name="x", defaultValue="20") Integer x` | `20` | **`20`** ★ 見下方 ③ | `5` |
| `@RequestParam("x") Optional<Integer> x` | `Optional.empty()` | `Optional.empty()` | `Optional.of(5)` |
| `@RequestParam(name="x", required=false) String x` | `null` | **`""`** ⚠️ 見下方 ③ | `"5"` |
| `@RequestParam(name="x", required=false) int x` | 💥 **500** | 💥 **500** | `5` |
| `@RequestParam(name="x", required=false) boolean x` | **`false`** ★ 見下方 ② | 💥 **500** | — |
| `@RequestParam(name="x", defaultValue="20") int x` | `20` | `20` | `5` |

**六個要記住的點：**

**① `defaultValue` 隱含 `required = false`。** 寫了 `defaultValue` 就不用寫 `required=false`
（寫了也沒用，`defaultValue` 優先）。

**② `required = false` + 原生型別 = 500 —— 但 `boolean` 是例外。** ★★

```java
@RequestParam(name = "page", required = false) int page      // 💥 500
```

```
java.lang.IllegalStateException: Optional int parameter 'page' is present but
cannot be translated into a null value due to being declared as a primitive type.
Consider declaring it as object wrapper for the corresponding primitive type.
```

**這是 500，不是 400。** 也就是說：客戶端一個很正常的請求（沒帶可選參數）
會讓你的服務噴 500、進 error log、觸發告警。
而且**它在開發時看不出來** —— 因為你測試時一定會帶 `?page=0`。

⚠️ **但 `boolean` 不會 500，它會安靜地變成 `false`**：

```java
// AbstractNamedValueMethodArgumentResolver.handleNullValue()
private Object handleNullValue(String name, Object value, Class<?> paramType) {
    if (value == null) {
        if (Boolean.TYPE.equals(paramType)) {
            return Boolean.FALSE;                 // ★★ boolean 有特例
        }
        else if (paramType.isPrimitive()) {
            throw new IllegalStateException("Optional " + paramType.getSimpleName() + ...);
        }
    }
    return value;
}
```

**而「安靜地變成 `false`」比 500 更危險**：

```java
// 🔴 客戶端沒送 includeCancelled → false → 使用者以為看到全部訂單
@RequestParam(name = "includeCancelled", required = false) boolean includeCancelled
```

`false` 是一個**看起來合理的預設值**，所以沒有人會發現「這個參數其實沒生效」。
這是 4.2.3「靜默篩選」那一類災難的同一個形狀。

⚠️⚠️ **而 `?x=`（空字串）+ `boolean` 反而會 500** ——
因為那條路徑不經過 `handleNullValue`：`""` 先進 `ConversionService`
（回 `null`），然後在反射呼叫時因為原始型別不接受 `null` 而拋
`IllegalStateException`。
**所以同一個宣告，「沒送」是 `false`、「送空的」是 500。**

👉 **規則：`@RequestParam` 一律用包裝型別（`Integer` / `Long` / `Boolean`）
並明確給 `defaultValue`。原始型別（含 `boolean`）不要用。**

**③ 空字串的處理有三種結果，取決於「有沒有 `defaultValue`」與「型別」。** ★★

先看解析器的原始碼 —— 這一段解釋了表格裡所有的空字串欄位：

```java
// AbstractNamedValueMethodArgumentResolver.resolveArgument()（節錄）
Object arg = resolveName(resolvedName.toString(), nestedParameter, webRequest);
if (arg == null) {
    if (namedValueInfo.defaultValue != null) {                     // ① 參數缺席 + 有預設值
        arg = resolveEmbeddedValuesAndExpressions(namedValueInfo.defaultValue);
    }
    else if (namedValueInfo.required && !nestedParameter.isOptional()) {
        handleMissingValue(namedValueInfo.name, nestedParameter, webRequest);   // → 400
    }
    arg = handleNullValue(namedValueInfo.name, arg, nestedParameter.getNestedParameterType());
}
else if ("".equals(arg) && namedValueInfo.defaultValue != null) {   // ★★ ② 空字串 + 有預設值
    arg = resolveEmbeddedValuesAndExpressions(namedValueInfo.defaultValue);
}

// ── 之後才做型別轉換 ──────────────────────────────────────────
arg = binder.convertIfNecessary(arg, parameter.getParameterType(), parameter);

// ★ 轉換後【又】檢查一次 required —— 這是「?x= 對 required 參數回 400」的原因
if (arg == null && namedValueInfo.defaultValue == null
        && namedValueInfo.required && !nestedParameter.isOptional()) {
    handleMissingValueAfterConversion(namedValueInfo.name, nestedParameter, webRequest);
}
```

**三種結果**：

| 情況 | 結果 | 為什麼 |
|---|---|---|
| `?size=` + `defaultValue="20"` | **`20`** | 走上面的分支 ②，**在轉型之前**就被換成 `"20"` |
| `?size=` + `required=false` `Integer` | `null` | `StringToNumberConverterFactory` 對空字串回 `null` |
| **`?keyword=` + `required=false` `String`** | **`""`** ⚠️ | **字串不需要轉換，所以 `""` 原封不動地傳進來** |

⚠️⚠️ **最後一列是實務上最常出錯的一個**：

```java
// 🔴 ?keyword= 會讓 keyword 是 ""，而不是 null
@RequestParam(name = "keyword", required = false) String keyword
...
if (keyword != null) {                       // 🔴 "" != null → 條件成立
    sql.append(" AND name LIKE '%").append(keyword).append("%'");
}
// → WHERE name LIKE '%%' → 全表掃描，而且看起來「有在篩選」
```

👉 **所以 shop-service 的字串參數一律綁成物件，並在 compact constructor 裡
`trimToNull()`（1.7.2）** —— 那讓「空字串」與「沒送」在進入業務邏輯前就統一。

**④ 自訂 Converter 必須自己處理空字串。**

內建的 converter（`StringToNumber`、`StringToEnum`…）都對空字串回 `null`，
所以通常沒事。**但你自己寫的不會自動有這個行為**：

```java
// 🔴 ?cursor= 會拋例外 → 500
@Override
public Cursor convert(String source) {
    return Cursor.decode(source);            // Base64 解碼空字串 → 例外
}

// ✅ 第一行就處理
@Override
public Cursor convert(String source) {
    if (source == null || source.isBlank()) return null;
    return Cursor.decode(source);
}
```

見 1.9.4 的完整版。

**⑤ `required = true` 遇到空字串是 400，但錯誤訊息會誤導。**

`?x=` + `@RequestParam("x") Integer x` → 空字串轉成 `null` →
**轉換後的第二次 `required` 檢查**拋 `MissingServletRequestParameterException` →
訊息是「**Required parameter 'x' is not present**」。

⚠️ **而客戶端明明送了 `x`。** 這個訊息會讓對方一直檢查「我有沒有送」，
而真正的問題是「送了空的」。
👉 03 章 3.5.2 的 handler 會在 `errors[]` 裡補上
`"rejectedValue": ""`，讓這件事看得出來。

**⑥ `Optional<T>` 是最安全但最囉唆的寫法。**

```java
@RequestParam("keyword") Optional<String> keyword
```

它同時表達了「可選」與「不會是 null」，但方法內每次都要 `.orElse(...)`。
**shop-service 的規則：Controller 方法參數不用 `Optional`**，
改用「綁成一個物件」（1.7），在物件裡用預設值處理。

### 1.5.2 陣列與多值參數

```
GET /orders?status=PAID&status=SHIPPED           ← 重複的 key
GET /orders?status=PAID,SHIPPED                  ← 逗號分隔
```

Spring 對兩種都支援，但行為不同：

```java
@RequestParam("status") List<String> status
```

| 請求 | 結果 |
|---|---|
| `?status=PAID&status=SHIPPED` | `["PAID", "SHIPPED"]` |
| `?status=PAID,SHIPPED` | `["PAID", "SHIPPED"]` ← Spring 會自動用逗號切 |
| `?status=PAID` | `["PAID"]` |
| （沒送） | `required=true` → 400；`required=false` → `null`（⚠️ 不是空 list） |

⚠️ **逗號自動切割有一個坑**：如果參數值本身可能含逗號（例如 `?keyword=筆記型電腦,滑鼠`），
它會被錯誤切成兩個值。

```java
// ✅ 明確關閉逗號切割：用 String[] 然後自己處理，或用 @RequestParam 搭配自訂 Converter
@RequestParam("keyword") String keyword          // 單值，不切
```

或者用一個包裝型別讓意圖明確（1.9.5 的 `CsvList`）。

⚠️ **另一個坑：沒送時是 `null` 而不是空 list。**

```java
// ❌ 會 NPE
for (String s : status) { }

// ✅
@RequestParam(name = "status", required = false, defaultValue = "") List<String> status
// defaultValue = "" → 空字串 → 切割後得到 [] （空 list）
```

實測行為：`defaultValue = ""` 時，Spring 得到空字串，
`StringToCollectionConverter` 對空字串回傳**空集合**。所以這招可行，但很不直觀。

👉 **更好的做法是綁成物件**（1.7），在 record 的建構子裡做正規化：

```java
public record OrderFilter(List<String> status, ...) {
    public OrderFilter {
        status = (status == null) ? List.of() : List.copyOf(status);   // ★ 永遠不是 null
    }
}
```

### 1.5.3 `Map` 與 `MultiValueMap` 接全部參數

```java
@RequestParam Map<String, String> all              // 每個 key 取第一個值
@RequestParam MultiValueMap<String, String> all    // 保留所有值
```

**⚠️ 這是一個安全與可維護性的反模式。** 三個問題：

1. **OpenAPI 產不出參數清單** —— 文件變成空的。
2. **沒有驗證** —— `@Valid` 對 `Map` 無效。
3. **「未知參數靜默忽略」變成必然** —— 03-rest-api 第 05 章 5.11 說過，
   `?statuss=PAID`（打錯字）會被忽略，篩選沒生效但沒人知道，使用者以為看到的是篩選後的結果。

唯一的合理用途：**做「未知參數檢查」**（見 1.7.5）。

### 1.5.4 `POST` 的 form 參數

```java
@PostMapping(consumes = MediaType.APPLICATION_FORM_URLENCODED_VALUE)
public ... login(@RequestParam("username") String u, @RequestParam("password") String p) { }
```

`@RequestParam` 同時讀查詢字串**和** form body（`application/x-www-form-urlencoded`）。

⚠️ **`PUT` / `PATCH` 的 form body 預設讀不到！**
因為 Servlet 規格只要求容器解析 `POST` 的 form body。
Spring 提供 `FormContentFilter`（Boot 自動註冊，order `-9900`）來補這個洞
—— 這就是 0.8.1 那張圖裡它存在的理由。

**但 shop-service 全部用 JSON**，所以這一段只是知識點。
⚠️ 唯一要注意的是：`FormContentFilter` 會**讀取 request body**，
如果你的 Filter 也想讀 body，順序要放在它前面或用 `ContentCachingRequestWrapper`（04 章 4.3）。

---

## 1.6 `@RequestBody`

### 1.6.1 完整流程

```
@RequestBody CreateOrderRequest request
   │
   ▼
RequestResponseBodyMethodProcessor.resolveArgument()
   │
   ├─ 找 HttpMessageConverter：看 Content-Type 與目標型別
   │   MappingJackson2HttpMessageConverter 接受 application/json
   │   找不到 → HttpMediaTypeNotSupportedException → 415
   │
   ├─ converter.read() → ObjectMapper.readValue(inputStream, CreateOrderRequest.class)
   │   JSON 語法錯 / 型別不符 → HttpMessageNotReadableException → 400
   │
   ├─ 有 @Valid / @Validated → validator.validate()
   │   失敗 → MethodArgumentNotValidException → 400（02、03 章會改成 422）
   │
   └─ 回傳物件
```

**兩個例外要分清楚**（03 章會分別處理）：

| 例外 | 什麼時候 | 語意 | shop-service 的對映 |
|---|---|---|---|
| `HttpMessageNotReadableException` | JSON 壞掉、型別對不上、未知欄位 | **語法**錯誤 | 400 `MALFORMED_REQUEST` |
| `MethodArgumentNotValidException` | JSON 解得開，但違反 Bean Validation | **語意**錯誤 | 422 `VALIDATION_FAILED` |

> 這個區分不是吹毛求疵。前端對它們的反應不同：
> 400 通常是**程式 bug**（該上報 Sentry）；
> 422 是**使用者輸入問題**（該標紅欄位）。

### 1.6.2 `record` + Jackson

```java
package example.shop.order.web.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;

import java.util.List;

public record CreateOrderRequest(
    @NotEmpty(message = "訂單至少需要一項商品")
    @Size(max = 50, message = "單筆訂單最多 50 項商品")
    List<@Valid Item> items,

    @NotBlank(message = "收件地址為必填")
    @Size(max = 64)
    String shippingAddressId,

    @Size(max = 32)
    @Pattern(regexp = "^[A-Z0-9]{4,32}$", message = "折扣碼格式錯誤")
    String couponCode,

    @Size(max = 200)
    String customerNote,

    @Valid
    InvoiceRequest invoice
) {
    public record Item(
        @NotBlank @Size(max = 64) String productId,
        @NotNull @Min(1) @Max(999) Integer quantity
    ) {}

    public record InvoiceRequest(
        @NotNull InvoiceType type,
        @Pattern(regexp = "\\d{8}", message = "統一編號須為 8 位數字") String taxId,
        @Size(max = 60) String companyName,
        @Pattern(regexp = "/[0-9A-Z+\\-.]{7}", message = "載具號碼格式錯誤") String carrierId,
        @Size(max = 10) String donationCode
    ) {}
}
```

**Jackson 對 `record` 的支援細節（要知道的四件事）**：

| 細節 | 說明 |
|---|---|
| **不需要 `@JsonCreator`** | Jackson 2.12+ 原生支援 `record`，用 canonical constructor 反序列化 |
| **不需要 `-parameters`** | `record` 的元件名稱在 class 檔案裡是 `Record` attribute，Jackson 直接讀得到（和 1.4.1 的 `@RequestParam` 不同） |
| **缺欄位 → `null`（物件）或 `0`/`false`（原生）** | ⚠️ `int quantity` 缺欄位會變 `0`，`@Min(1)` 才擋得住。所以 DTO 用 `Integer` |
| **`compact constructor` 可做正規化** | 見下方 |

**用 compact constructor 做正規化**（非常實用）：

```java
public record CreateOrderRequest(
    List<Item> items,
    String shippingAddressId,
    String couponCode,
    String customerNote,
    InvoiceRequest invoice
) {
    public CreateOrderRequest {                     // ★ compact constructor
        items      = (items == null) ? List.of() : List.copyOf(items);   // 不可變、不為 null
        couponCode = normalize(couponCode);                               // trim + 轉大寫
        customerNote = trimToNull(customerNote);                          // 空字串→null
    }

    private static String normalize(String s) {
        if (s == null) return null;
        String t = s.trim().toUpperCase();
        return t.isEmpty() ? null : t;
    }
    private static String trimToNull(String s) {
        if (s == null) return null;
        String t = s.trim();
        return t.isEmpty() ? null : t;
    }
}
```

⚠️ **但正規化和驗證的順序要小心**：
compact constructor 在**反序列化時**執行，`@Valid` 在**之後**執行。
所以 `@Pattern(regexp="^[A-Z0-9]{4,32}$")` 看到的是**已經轉大寫的值** —— 這正是我們要的
（使用者輸入 `summer20`，正規化成 `SUMMER20`，驗證通過）。

如果順序相反（先驗證再正規化），使用者輸入小寫就會被拒絕。
**這個順序讓「寬容輸入、嚴格儲存」變得容易實作。**

### 1.6.3 `record` 不適合的三種情況

| 情況 | 為什麼 | 改用 |
|---|---|---|
| **需要 `PATCH` 的三態語意** | `record` 的欄位無法區分「沒送」與「送了 null」 | `JsonNullable<T>`（1.6.4）—— 仍可用 record |
| **繼承 / 多型** | `record` 是 final，不能被繼承 | `sealed interface` + `record` 實作 + `@JsonTypeInfo` |
| **超過 ~12 個欄位** | canonical constructor 的參數列太長，呼叫端容易傳錯順序 | class + builder，或拆成巢狀結構 |

**多型 DTO 的寫法**（付款方式是最典型的例子）：

```java
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, property = "method", visible = true)
@JsonSubTypes({
    @JsonSubTypes.Type(value = CardPayment.class,          name = "CREDIT_CARD"),
    @JsonSubTypes.Type(value = AtmTransferPayment.class,   name = "ATM_TRANSFER"),
    @JsonSubTypes.Type(value = ConvenienceStorePayment.class, name = "CONVENIENCE_STORE"),
    @JsonSubTypes.Type(value = LinePayPayment.class,       name = "LINE_PAY")
})
public sealed interface CreatePaymentRequest {

    record CardPayment(
        @NotBlank @Pattern(regexp = "\\d{13,19}", message = "卡號格式錯誤") String cardNumber,
        @NotNull @Min(1) @Max(12) Integer expiryMonth,
        @NotNull @Min(2026) @Max(2050) Integer expiryYear,
        @NotBlank @Pattern(regexp = "\\d{3,4}", message = "安全碼格式錯誤") String cvv,
        @NotBlank @Size(max = 60) String holderName
    ) implements CreatePaymentRequest {}

    record AtmTransferPayment(
        @Size(max = 4) String preferredBankCode
    ) implements CreatePaymentRequest {}

    record ConvenienceStorePayment(
        @NotNull StoreBrand brand
    ) implements CreatePaymentRequest {}

    record LinePayPayment(
        @NotBlank @Size(max = 500) String returnUrl
    ) implements CreatePaymentRequest {}
}
```

**`visible = true` 是關鍵**：它讓 `method` 欄位除了用來選型別之外，
也能被綁定到子型別的欄位上（如果你需要在 DTO 裡看到它）。

**`sealed interface` 的好處**：`switch` 可以窮盡檢查，
新增付款方式時**編譯器會提醒你所有需要處理的地方**（01-java-core 第 04 章）：

```java
// 少處理一種就編譯失敗
String describe(CreatePaymentRequest r) {
    return switch (r) {
        case CardPayment c            -> "卡號末四碼 " + last4(c.cardNumber());
        case AtmTransferPayment a     -> "ATM 轉帳";
        case ConvenienceStorePayment s -> "超商代碼繳費（" + s.brand() + "）";
        case LinePayPayment l         -> "LINE Pay";
    };
}
```

⚠️ **多型 DTO 的三個坑**：

1. **`@Valid` 在多型上的行為**：驗證會對**實際的子型別**進行 —— 這是對的。
2. **未知的 `method` 值** → Jackson 拋 `InvalidTypeIdException`（`HttpMessageNotReadableException` 的子孫）→ 400。
   ⚠️ 錯誤訊息會**列出所有已知的型別 id**，等於洩漏你支援的付款方式清單。
   03 章會處理（不要把 Jackson 的原始訊息回給客戶端）。
3. **OpenAPI 表達**：springdoc 會產生 `oneOf` + `discriminator`
   （03-rest-api 第 07 章 7.5 講過這個結構）。

### 1.6.4 `PATCH` 的三態語意與 `JsonNullable` ★

`PATCH /orders/{id}` 允許只改部分欄位。這帶來三種狀態：

```jsonc
// A. 欄位不存在 → 「不要改這個欄位」
{ "customerNote": "改成這樣" }

// B. 欄位存在但是 null → 「清空這個欄位」
{ "customerNote": null }

// C. 欄位有值 → 「設成這個值」
{ "customerNote": "新的備註" }
```

**普通的 `record` 分不出 A 和 B** —— 兩者都會得到 `null`。

**後果**：客戶端只想改 `invoice`，但你的程式把 `customerNote` 也清空了。
這是 03-rest-api 第 02 章 2.6 說的「`PUT` 的靜默資料遺失」，
只是這次發生在 `PATCH` 上，更難察覺。

**解法：`JsonNullable<T>`**（`org.openapitools:jackson-databind-nullable`）

```java
package example.shop.order.web.dto;

import org.openapitools.jackson.nullable.JsonNullable;

public record UpdateOrderRequest(
    @Size(max = 200)
    JsonNullable<String> customerNote,

    @Valid
    JsonNullable<CreateOrderRequest.InvoiceRequest> invoice,

    @Size(max = 500)
    JsonNullable<String> internalNote          // 只有客服能用
) {
    public UpdateOrderRequest {
        // ★ 反序列化時 Jackson 對「缺欄位」不會呼叫建構子參數 → 是 null 而不是 undefined
        customerNote = orUndefined(customerNote);
        invoice      = orUndefined(invoice);
        internalNote = orUndefined(internalNote);
    }

    private static <T> JsonNullable<T> orUndefined(JsonNullable<T> v) {
        return (v == null) ? JsonNullable.undefined() : v;
    }
}
```

**必要的註冊**（不註冊的話 `JsonNullable` 會被當成普通 POJO 序列化成 `{"present":true,...}`）：

```java
package example.shop.common.config;

import com.fasterxml.jackson.databind.Module;
import org.openapitools.jackson.nullable.JsonNullableModule;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class JacksonConfig {
    @Bean
    Module jsonNullableModule() {
        return new JsonNullableModule();
    }
}
```

**三態的讀法**：

```java
public UpdateOrderCommand toCommand(String orderId, UpdateOrderRequest req, Actor actor) {
    var b = UpdateOrderCommand.builder().orderId(orderId).actor(actor);

    if (req.customerNote().isPresent()) {                  // A：沒送 → isPresent() = false
        b.customerNote(req.customerNote().get());          // B：送 null → get() = null（清空）
    }                                                       // C：送值 → get() = 值
    if (req.invoice().isPresent()) {
        b.invoice(toInvoiceSpec(req.invoice().get()));
    }
    return b.build();
}
```

⚠️ **`JsonNullable` 的四個注意事項**：

| 注意 | 說明 |
|---|---|
| **`isPresent()` 的語意** | 它問「欄位有出現在 JSON 裡嗎」，**不是**「值不是 null 嗎」。名字容易誤導（和 `Optional` 相反） |
| **Bean Validation 對它有效嗎** | ✅ 有。`@Size(max=200) JsonNullable<String>` 會驗證裡面的值（`JsonNullableModule` 之外還需要 Hibernate Validator 認得 `ValueExtractor` —— jackson-databind-nullable 有提供） |
| **只用在 `PATCH`** | `POST` / `PUT` 不需要三態（`PUT` 是完整替換，缺欄位就是清空） |
| **OpenAPI 表達** | springdoc 會把它產生成 `nullable: true`。「有沒有送」這件事 OpenAPI 3.1 沒有直接語法，要在 `description` 說明 |

> **如果你不想引入這個依賴**，替代方案是「用 `Map<String, Object>` 接 patch」
> 或「用 `JsonPatch`（RFC 6902）」。
> 但前者失去型別與驗證，後者對前端太複雜。
> `JsonNullable` 是實務上最划算的方案 —— 而且它是 OpenAPI Generator 產生 client 時的預設型別。

### 1.6.5 未知欄位要不要報錯

```yaml
spring:
  jackson:
    deserialization:
      fail-on-unknown-properties: true      # shop-service 選 true
```

| 設定 | 客戶端送 `{"customerNote":"x", "totalAmount":1}` |
|---|---|
| `false`（Spring Boot 預設） | 靜默忽略 `totalAmount` |
| `true` | 400 `UnrecognizedPropertyException` |

**為什麼選 `true`？**（03-rest-api 第 03 章 3.13.4 的完整論證，這裡摘要）

- 靜默忽略會讓「打錯欄位名」的 bug 藏很久：
  前端寫 `custmerNote`（少一個 o），送出成功回 200，備註沒存進去，沒人知道。
- 它是 **mass assignment 攻擊的偵測器**：有人試著送 `"status":"PAID"` 時你會知道。

⚠️ **但 `true` 也有代價**：

| 代價 | 處理 |
|---|---|
| 前端多送一個欄位就整個請求失敗 | 在 API 文件明確寫「不接受未知欄位」，並在 Consumer Contract 裡列出（03-rest-api 第 06 章） |
| 前端 debug 用的欄位（`_timestamp`）會被拒 | 約定 `_` 開頭的欄位一律忽略：用 `@JsonIgnoreProperties(ignoreUnknown = false)` 加自訂 `PropertyNamingStrategy`，或直接請前端不要送 |
| **回應方向不受影響** | 這個設定只影響反序列化。前端收到未知欄位時**必須**忽略（相容性的基礎） |

**折衷做法**：對「內部客戶端」嚴格，對「第三方 webhook 回拋」寬鬆。
可以在特定 DTO 上覆寫：

```java
@JsonIgnoreProperties(ignoreUnknown = true)      // 這個 DTO 例外：寬鬆
public record ShippingWebhookPayload(...) {}
```

### 1.6.6 `@RequestBody` 的其他細節

**`required = false`**：body 可以是空的。

```java
@PostMapping("/orders/{id}/notifications")
public ... resend(@PathVariable("id") String id,
                  @RequestBody(required = false) ResendRequest body) {
    var r = (body == null) ? ResendRequest.defaults() : body;
}
```

⚠️ 空 body 時是 `null`，不是空物件。要處理。

**不要用 `Optional<T>` 在 `@RequestBody` 上**：

```java
@RequestBody Optional<CreateOrderRequest> request      // ❌
```

Jackson 會嘗試把整個 body 反序列化成 `Optional`，行為依 `Jdk8Module` 的註冊狀況而異，
而且 `@Valid` 對它無效。用 `required = false` + null 檢查。

**`byte[]` / `String` / `InputStream` 接原始 body**：

```java
@PostMapping(path = "/webhooks/payment", consumes = "*/*")
public void webhook(@RequestBody String rawBody,
                    @RequestHeader("X-Signature") String signature) {
    // ★ 驗簽必須用「原始 bytes」，不能先反序列化再重新序列化
    //   因為 JSON 的欄位順序與空白會改變，簽章就不對了
    if (!signatureVerifier.verify(rawBody, signature)) {
        throw new InvalidWebhookSignatureException();
    }
    var payload = objectMapper.readValue(rawBody, PaymentWebhookPayload.class);
}
```

**這是一個重要的實務細節**：webhook 驗簽一定要用原始 body。
很多人先用 `@RequestBody PaymentWebhookPayload`，再 `objectMapper.writeValueAsString()` 去驗簽，
結果永遠驗不過。

---

## 1.7 把查詢參數綁成一個物件 ★

這一節解決 `GET /orders` 的實際問題。

### 1.7.1 問題：12 個參數的方法簽章

依 03-rest-api 第 05 章 5.12 的規格，`GET /orders` 有這些參數：

```
page, size, cursor, sort,
status, customerId, createdFrom, createdTo, minAmount, maxAmount,
hasAssignee, keyword, paymentMethod, includeCancelled
```

**14 個。** 直接寫成方法參數：

```java
// ❌ 沒人想維護這個
@GetMapping
public PageResponse<OrderSummary> list(
        @RequestParam(name = "page", defaultValue = "0") Integer page,
        @RequestParam(name = "size", defaultValue = "20") Integer size,
        @RequestParam(name = "cursor", required = false) String cursor,
        @RequestParam(name = "sort", defaultValue = "createdAt,desc") String sort,
        @RequestParam(name = "status", required = false) List<String> status,
        @RequestParam(name = "customerId", required = false) List<String> customerId,
        @RequestParam(name = "createdFrom", required = false) Instant createdFrom,
        @RequestParam(name = "createdTo", required = false) Instant createdTo,
        @RequestParam(name = "minAmount", required = false) BigDecimal minAmount,
        @RequestParam(name = "maxAmount", required = false) BigDecimal maxAmount,
        @RequestParam(name = "hasAssignee", required = false) Boolean hasAssignee,
        @RequestParam(name = "keyword", required = false) String keyword,
        @RequestParam(name = "paymentMethod", required = false) List<String> paymentMethod,
        @RequestParam(name = "includeCancelled", defaultValue = "false") Boolean includeCancelled) {
    ...
}
```

問題不只是醜：

| 問題 | 說明 |
|---|---|
| **不能做跨欄位驗證** | 「`minAmount` 不能大於 `maxAmount`」沒地方寫 |
| **不能重用** | `GET /customers/{id}/orders` 也要同一組參數 → 複製 14 行 |
| **不能做正規化** | `status` 沒送時是 `null`，每個用到的地方都要判斷 |
| **測試麻煩** | 要測「日期範圍互斥」得發 HTTP 請求 |

### 1.7.2 解法：綁成 record（Spring 6.1 起可行）★

```java
package example.shop.order.web.dto;

import example.shop.common.validation.SortWhitelist;
import jakarta.validation.constraints.*;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.Set;

/**
 * GET /orders 的查詢參數。對照 03-rest-api 第 05 章 5.12 的規格。
 *
 * <p>綁定方式：直接宣告為 Controller 方法參數（不需要 @ModelAttribute），
 * Spring 會用「非簡單型別 → ModelAttributeMethodProcessor」的規則處理。
 * record 的 constructor binding 需要 Spring Framework 6.1+（Boot 3.2+）。
 */
public record OrderFilter(

    // ── 分頁 ──────────────────────────────────────────
    @Min(value = 0, message = "page 不可小於 0")
    Integer page,

    @Min(value = 1, message = "size 最小為 1")
    @Max(value = 100, message = "size 最大為 100")
    Integer size,

    @Size(max = 512)
    String cursor,

    @SortWhitelist({"createdAt", "updatedAt", "totalAmount", "orderNumber", "status"})
    String sort,

    // ── 篩選 ──────────────────────────────────────────
    List<@Pattern(regexp = "^[A-Z_]{1,32}$") String> status,

    List<@Size(max = 64) String> customerId,

    // ⚠️ 刻意【沒有】@DateTimeFormat —— 它對 Instant 完全無效（1.9.3）。
    //    Instant 的解析由 06 章 6.6.1 的 StringToInstantConverter 負責。
    Instant createdFrom,

    Instant createdTo,

    @DecimalMin(value = "0", message = "金額不可為負") 
    @Digits(integer = 12, fraction = 2)
    BigDecimal minAmount,

    @DecimalMin(value = "0") 
    @Digits(integer = 12, fraction = 2)
    BigDecimal maxAmount,

    Boolean hasAssignee,

    @Size(max = 100, message = "關鍵字最長 100 字")
    String keyword,

    List<@Pattern(regexp = "^[A-Z_]{1,32}$") String> paymentMethod,

    Boolean includeCancelled

) {
    /** 集中管理預設值與正規化，讓後續程式碼永遠不用判斷 null。 */
    public OrderFilter {
        page = (page == null) ? 0 : page;
        size = (size == null) ? 20 : size;
        sort = (sort == null || sort.isBlank()) ? "createdAt,desc" : sort.trim();

        status        = normalizeUpper(status);
        customerId    = normalize(customerId);
        paymentMethod = normalizeUpper(paymentMethod);
        keyword       = blankToNull(keyword);
        includeCancelled = (includeCancelled != null) && includeCancelled;
    }

    // ── 跨欄位驗證：用 @AssertTrue 是最輕量的做法 ─────────────

    @AssertTrue(message = "minAmount 不可大於 maxAmount")
    public boolean isAmountRangeValid() {
        return minAmount == null || maxAmount == null
                || minAmount.compareTo(maxAmount) <= 0;
    }

    @AssertTrue(message = "createdFrom 不可晚於 createdTo")
    public boolean isDateRangeValid() {
        return createdFrom == null || createdTo == null
                || !createdFrom.isAfter(createdTo);
    }

    @AssertTrue(message = "page 與 cursor 不可同時使用")
    public boolean isPaginationModeValid() {
        return cursor == null || page == 0;      // page 有預設值 0，所以用 0 當「沒指定」
    }

    @AssertTrue(message = "查詢區間不可超過 366 天")
    public boolean isDateRangeWithinLimit() {
        if (createdFrom == null || createdTo == null) return true;
        return createdFrom.plus(java.time.Duration.ofDays(366)).isAfter(createdTo);
    }

    // ── 便利方法 ─────────────────────────────────────

    public boolean usesCursor() { return cursor != null; }

    private static List<String> normalize(List<String> v) {
        return (v == null) ? List.of()
                : v.stream().filter(s -> s != null && !s.isBlank()).map(String::trim).distinct().toList();
    }
    private static List<String> normalizeUpper(List<String> v) {
        return normalize(v).stream().map(s -> s.toUpperCase(java.util.Locale.ROOT)).toList();
    }
    private static String blankToNull(String s) {
        return (s == null || s.isBlank()) ? null : s.trim();
    }
}
```

```java
// Controller：從 14 個參數變成 1 個
@GetMapping
public PageResponse<OrderSummary> list(@Valid OrderFilter filter,
                                       @AuthenticationPrincipal CurrentUser user) {
    var query = mapper.toQuery(filter, user.actor());
    return mapper.toPageResponse(orderService.search(query));
}
```

**注意 `@AssertTrue` 的錯誤訊息定位問題** ★：
`@AssertTrue` 放在方法上時，Bean Validation 產生的 `field` 是**方法名去掉 `is`/`get` 後的屬性名**
（`isAmountRangeValid` → `amountRangeValid`）。
前端拿到 `field: "amountRangeValid"` 完全不知道要標哪個輸入框。

02 章 2.7 會用自訂 class-level validator + `addPropertyNode()` 把它修正成 `minAmount`。
**現在先知道這個限制存在。**

### 1.7.3 綁定規則：什麼時候需要 `@ModelAttribute`

Spring 對「沒有註解的方法參數」用這個規則決定怎麼處理：

```
參數型別是「簡單型別」（String、Integer、enum、Date、URI…）？
  ├─ 是 → 當成 @RequestParam
  └─ 否 → 當成 @ModelAttribute（從所有請求參數綁定屬性）
```

（判斷依據是 `BeanUtils.isSimpleProperty()`。）

所以 `OrderFilter filter` **不需要**寫 `@ModelAttribute`，Spring 自動當它是。
寫出來也可以，而且更明確：

```java
public PageResponse<OrderSummary> list(@Valid @ModelAttribute OrderFilter filter, ...)
```

⚠️ **shop-service 的規則：明確寫 `@ModelAttribute`。**
理由是「靠推斷」在這裡會出問題：如果哪天有人把 `OrderFilter` 從 record 改成
只有一個 `String` 欄位的 wrapper，推斷結果就變了。

**`record` 的 constructor binding 需要 Spring Framework 6.1（Boot 3.2）+。**

| 版本 | `@ModelAttribute` + record |
|---|---|
| Spring 6.0（Boot 3.0/3.1） | ❌ 需要無參建構子 + setter；record 不行 |
| **Spring 6.1（Boot 3.2）+** | ✅ `DataBinder.construct()` 支援建構子綁定 |

**Boot 3.0/3.1 的替代方案**（如果你還在舊版）：

```java
// 用 class + setter（可變，但可行）
public class OrderFilter {
    private Integer page = 0;
    private Integer size = 20;
    // ... getter / setter
}
```

或者用 `@ConstructorProperties`：

```java
public class OrderFilter {
    private final Integer page;
    @ConstructorProperties({"page", "size"})
    public OrderFilter(Integer page, Integer size) { ... }
}
```

⚠️ **一個容易忽略的 constructor binding 行為**：
建構子綁定失敗（例如 `?page=abc`）時，Spring 6.1 會把該參數設為 `null`（物件型別）
並在 `BindingResult` 裡記一個錯誤，**然後繼續建構物件**。
所以 compact constructor 裡的 `page == null ? 0 : page` 會把它變成 0 —— 
**驗證錯誤還在 `BindingResult` 裡，但值已經被「修好」了**。

這代表：`@Valid` 的驗證結果**仍然會拋** `MethodArgumentNotValidException`，
所以請求會失敗（正確）。但如果你自己讀 `BindingResult` 而不拋例外，
就要記得檢查它 —— 不要以為值是 0 就代表客戶端送了 0。

### 1.7.4 `page` 與 `cursor` 兩種分頁的分派

03-rest-api 第 05 章的規格：`GET /orders` 同時支援 offset 與 cursor 分頁。

**不要用 `params` 分派**（1.3.2 說過會回 **400** `UnsatisfiedServletRequestParameterException`）：

```java
// ❌
@GetMapping(params = "cursor") public ... byCursor(...) { }
@GetMapping(params = "page")   public ... byPage(...) { }
```

**用一個方法 + 內部分派**：

```java
@GetMapping
public PageResponse<OrderSummary> list(@Valid @ModelAttribute OrderFilter filter,
                                       @AuthenticationPrincipal CurrentUser user) {
    var query = mapper.toQuery(filter, user.actor());

    // OrderFilter 的 @AssertTrue 已經保證兩者不會同時出現
    return filter.usesCursor()
            ? mapper.toCursorPage(orderService.scroll(query))
            : mapper.toOffsetPage(orderService.search(query));
}
```

⚠️ 兩種分頁的回應**外殼不同**（cursor 版沒有 `totalElements`，有 `nextCursor`）。
03-rest-api 第 05 章 5.7 的決定是用同一個 `PageResponse<T>`，
裡面的 `page` 物件依模式帶不同欄位：

```java
public record PageResponse<T>(List<T> items, PageInfo page) {

    /** 依分頁模式帶不同欄位；null 的欄位由 Jackson 的 non_null 省略。 */
    public record PageInfo(
        Integer number,          // offset 模式
        Integer size,
        Long totalElements,      // offset 模式且未關閉 count 時
        Integer totalPages,
        String nextCursor,       // cursor 模式
        String prevCursor,
        Boolean hasNext
    ) {
        public static PageInfo offset(int number, int size, Long total) {
            Integer pages = (total == null) ? null : (int) Math.ceil((double) total / size);
            return new PageInfo(number, size, total, pages, null, null, null);
        }
        public static PageInfo cursor(int size, String next, String prev, boolean hasNext) {
            return new PageInfo(null, size, null, null, next, prev, hasNext);
        }
    }
}
```

### 1.7.5 偵測未知的查詢參數

03-rest-api 第 05 章 5.11 的原則：**靜默忽略是最貴的「寬容」**。
`?statuss=PAID`（打錯字）被忽略 → 使用者看到的是**未篩選**的全部訂單，
但他以為那就是 `PAID` 的訂單。

Spring **不會**幫你檢查未知的查詢參數（不像 `fail-on-unknown-properties` 之於 body）。
要自己做：

```java
package example.shop.common.web;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.core.MethodParameter;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ModelAttribute;

import java.beans.PropertyDescriptor;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 拒絕未知的查詢參數，避免「打錯參數名 → 篩選靜默失效」。
 * 只作用於 @RestController 的 handler method。
 */
public class UnknownQueryParamInterceptor implements HandlerInterceptor {

    /** 全域允許的參數（追蹤、快取破壞用）。 */
    private static final Set<String> GLOBAL_ALLOWED =
            Set.of("_t", "utm_source", "utm_medium", "utm_campaign");

    private final Map<HandlerMethod, Set<String>> cache = new ConcurrentHashMap<>();

    @Override
    public boolean preHandle(HttpServletRequest req, jakarta.servlet.http.HttpServletResponse res,
                            Object handler) {
        if (!(handler instanceof HandlerMethod hm)) return true;

        Set<String> allowed = cache.computeIfAbsent(hm, this::collectAllowedNames);

        List<String> unknown = req.getParameterMap().keySet().stream()
                .filter(k -> !allowed.contains(k))
                .filter(k -> !GLOBAL_ALLOWED.contains(k))
                .sorted()
                .toList();

        if (!unknown.isEmpty()) {
            throw new UnknownParameterException(unknown, new TreeSet<>(allowed));
        }
        return true;
    }

    /** 從方法簽章推導出「這條端點合法的參數名」。 */
    private Set<String> collectAllowedNames(HandlerMethod hm) {
        Set<String> names = new HashSet<>();
        for (MethodParameter p : hm.getMethodParameters()) {
            RequestParam rp = p.getParameterAnnotation(RequestParam.class);
            if (rp != null) {
                names.add(rp.name().isEmpty() ? Objects.requireNonNull(p.getParameterName()) : rp.name());
                continue;
            }
            // @ModelAttribute 或推斷成 model attribute 的參數：把它的屬性名全部加進來
            boolean isModelAttribute = p.hasParameterAnnotation(ModelAttribute.class)
                    || !org.springframework.beans.BeanUtils.isSimpleProperty(p.getParameterType());
            if (isModelAttribute) {
                Class<?> type = p.getParameterType();
                if (type.isRecord()) {
                    for (var c : type.getRecordComponents()) names.add(c.getName());
                } else {
                    for (PropertyDescriptor pd :
                            org.springframework.beans.BeanUtils.getPropertyDescriptors(type)) {
                        if (pd.getWriteMethod() != null) names.add(pd.getName());
                    }
                }
            }
        }
        return names;
    }
}
```

```java
// 註冊
@Configuration
public class WebMvcConfig implements WebMvcConfigurer {
    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(new UnknownQueryParamInterceptor())
                .addPathPatterns("/**")
                .excludePathPatterns("/actuator/**", "/swagger-ui/**", "/v3/api-docs/**");
    }
}
```

**回應**（對照 03-rest-api 第 04 章的錯誤目錄，新增一個 code）：

```jsonc
{
  "type": "https://api.shop.example/problems/unknown-parameter",
  "title": "未知的查詢參數",
  "status": 400,
  "detail": "Unknown query parameters: statuss. Did you mean: status?",
  "code": "UNKNOWN_PARAMETER",
  "userMessage": "查詢條件有誤，請重新整理頁面後再試。",
  "unknownParameters": ["statuss"],
  "supportedParameters": ["createdFrom", "createdTo", "cursor", "customerId",
                          "hasAssignee", "includeCancelled", "keyword", "maxAmount",
                          "minAmount", "page", "paymentMethod", "size", "sort", "status"],
  "traceId": "4f2c8a1e9b7d3f60"
}
```

**`supportedParameters` 和「你可能想打的是」讓這個錯誤變得非常好用。**
加一個 Levenshtein 距離計算就能給建議（03 章 3.9 會實作）。

⚠️ **上線這個功能要小心**：如果現有客戶端一直在送某個你不知道的參數
（例如 App 送了 `?v=3.2.1` 當快取破壞），開了這個檢查會讓他們**全部失敗**。

**安全的上線流程**：
1. 先只記 log（`warn`），不拋例外，跑兩週。
2. 從 log 裡蒐集實際出現的未知參數，加進 `GLOBAL_ALLOWED`。
3. 才切換成拋例外。

（這個「先觀察再強制」的流程，03-rest-api 第 06 章講版本演進時用的是同一個模式。）

---

## 1.8 `@RequestHeader`、`@CookieValue`、`@RequestAttribute`

### 1.8.1 `@RequestHeader`

```java
@PostMapping
public ResponseEntity<CreateOrderResponse> create(
        @Valid @RequestBody CreateOrderRequest request,
        @RequestHeader(ApiHeaders.IDEMPOTENCY_KEY) @NotBlank @Size(max = 64) String idempotencyKey,
        @RequestHeader(name = "Accept-Language", required = false) Locale locale,
        @RequestHeader(name = "User-Agent", required = false) String userAgent) { }
```

| 行為 | 說明 |
|---|---|
| header 名稱**不分大小寫** | HTTP 規格如此；`idempotency-key` 也會匹配 |
| 沒送且 `required=true` | **400** `MissingRequestHeaderException` |
| 型別轉換 | 支援 `String`、數字、`Locale`、`MediaType`、`List<String>`、`ZonedDateTime`… |
| `HttpHeaders` 型別 | 拿到全部 header（同 1.5.3 的 `Map`，同樣不推薦） |

**⚠️ Bean Validation 在 `@RequestHeader` 上需要 `@Validated`。**

```java
@RestController
@Validated                                     // ★ 沒有這個，@NotBlank 在方法參數上不生效
public class OrderController {
    public ... create(..., @RequestHeader("Idempotency-Key") @NotBlank String key) { }
}
```

原因：`@Valid` 在 `@RequestBody` 上是 `RequestResponseBodyMethodProcessor` 主動觸發的；
而**直接放在方法參數上的**約束註解（`@NotBlank`、`@Size`）需要 **method validation**，
由 `MethodValidationPostProcessor` 透過 AOP proxy 實作 —— 必須有 `@Validated` 在類別上。

⚠️ **而且它拋的例外不一樣**：

| 觸發方式 | 例外 | 預設狀態碼 |
|---|---|---|
| `@Valid @RequestBody` | `MethodArgumentNotValidException` | 400 |
| `@Validated` + 方法參數約束（Spring < 6.1） | `ConstraintViolationException` | **500** ⚠️ |
| `@Validated` + 方法參數約束（Spring 6.1+） | `HandlerMethodValidationException` | 400 |

**Spring Framework 6.1 修好了這個坑**（以前 `ConstraintViolationException` 不被
`DefaultHandlerExceptionResolver` 認識，直接變 500）。
03 章會為兩種例外都寫 handler，確保錯誤格式一致。

> ⚠️ **這裡先給你「一定會生效」的寫法（加 `@Validated`），但它不是 Boot 3.2 的最佳做法。**
> Spring 6.1 起方法參數驗證是 `RequestMappingHandlerAdapter` **內建**的，
> 不需要 `@Validated`，而且拋的是資訊更完整的 `HandlerMethodValidationException`。
> 更關鍵的是：**類別上有 `@Validated` 會讓內建機制失效**，退回 AOP 路徑。
> 完整說明與 shop-service 的最終決定（**拿掉 `@Validated`**）在
> [02 章 2.3.2](./02-validation-and-binding-errors.md)。
> 本章後面的範例仍寫著 `@Validated`，讀 02 章時會一併修正。

**header 名稱要用常數**：

```java
package example.shop.common.web;

public final class ApiHeaders {
    public static final String IDEMPOTENCY_KEY   = "Idempotency-Key";
    public static final String REQUEST_ID        = "X-Request-Id";
    public static final String TRACE_ID          = "X-Trace-Id";
    public static final String API_VERSION       = "X-Api-Version";
    public static final String RATE_LIMIT_LIMIT  = "X-RateLimit-Limit";
    public static final String RATE_LIMIT_REMAIN = "X-RateLimit-Remaining";
    public static final String RATE_LIMIT_RESET  = "X-RateLimit-Reset";
    public static final String TOTAL_COUNT       = "X-Total-Count";
    private ApiHeaders() {}
}
```

理由：拼錯字（`Idempotency-key` vs `Idempotency-Key`）在**讀取端不會出錯**（不分大小寫），
但在**寫入端**（`response.setHeader`）就會產生兩個不同的 header 名稱，
而前端只認一種。用常數就不會有這個問題。

### 1.8.2 `@CookieValue`

```java
@GetMapping("/carts/current")
public CartResponse current(@CookieValue(name = "cart_id", required = false) String cartId) { }
```

**shop-service 幾乎不用 cookie**（用 Bearer token）。
但購物車有一個例外：未登入使用者的購物車需要一個匿名識別碼。

⚠️ **設 cookie 要注意的四件事**：

```java
ResponseCookie cookie = ResponseCookie.from("cart_id", cartId)
        .httpOnly(true)                    // ★ JS 讀不到，防 XSS 竊取
        .secure(true)                      // ★ 只走 HTTPS
        .sameSite("Lax")                   // ★ 防 CSRF（Strict 會讓外部連結進來時失去購物車）
        .path("/")
        .maxAge(Duration.ofDays(30))
        .build();
return ResponseEntity.ok().header(HttpHeaders.SET_COOKIE, cookie.toString()).body(cart);
```

`SameSite` 的選擇很關鍵：`Strict` 時，使用者從 Google 點進商品頁會**看不到自己的購物車**
（因為 cookie 不會被送出），這是真實發生過的轉換率事故。

### 1.8.3 `@RequestAttribute`：讀 Filter 放進來的東西

```java
// Filter 裡
request.setAttribute(RequestAttributes.TRACE_ID, traceId);

// Controller 裡
@GetMapping("/{orderId}")
public OrderDetail get(@PathVariable("orderId") String orderId,
                       @RequestAttribute(RequestAttributes.TRACE_ID) String traceId) { }
```

**但這不是好做法。** 兩個問題：

1. 每個需要 `traceId` 的方法都要多一個參數（70 條端點 × 1 個參數）。
2. 「這個 attribute 一定存在」是隱含契約，Filter 沒跑（測試時）就 400。

👉 **更好的做法**：`traceId` 放進 **MDC**（04 章 4.4），
需要時用 `MDC.get("traceId")` 取，或用自訂 `ArgumentResolver`（04 章 4.6）
把整個 `RequestContext` 注入。

---

## 1.9 型別轉換

### 1.9.1 轉換發生在哪裡

```
查詢參數 / 路徑變數 / header（String）
   │
   ▼  WebDataBinder → ConversionService
   ├─ 內建 Converter（String→Integer、String→Enum、String→LocalDate…）
   ├─ @DateTimeFormat / @NumberFormat（Formatter）
   └─ 你註冊的 Converter / Formatter
   │
   ▼  失敗 → MethodArgumentTypeMismatchException → 400
```

```
Request body（JSON）
   │
   ▼  Jackson ObjectMapper（完全不經過 ConversionService！）
   ├─ 內建 deserializer
   ├─ JavaTimeModule（Instant、LocalDate…）
   └─ 你註冊的 JsonDeserializer / Module
   │
   ▼  失敗 → HttpMessageNotReadableException → 400
```

⚠️ **這是一個很重要但常被忽略的事實：查詢參數與 body 用完全不同的轉換機制。**

所以「我註冊了一個 `Converter<String, Money>`，為什麼 body 裡的金額還是轉不了？」
—— 因為 body 走 Jackson，要註冊 `JsonDeserializer`。

**兩邊都要註冊的型別**：`Cursor`、`Money`、自訂 ID 型別…

### 1.9.2 列舉綁定：三個問題 ★

**問題 1：大小寫。**

```java
@RequestParam("status") OrderStatus status
```

| 請求 | 結果 |
|---|---|
| `?status=PAID` | ✅ `OrderStatus.PAID` |
| `?status=paid` | ❌ **400** `MethodArgumentTypeMismatchException` |
| `?status=Paid` | ❌ 400 |

Spring 內建的 `StringToEnumConverterFactory` 用 `Enum.valueOf(trim(source))`，**大小寫敏感**。

**該不該接受小寫？** 這是設計決策：

| 立場 | 論點 |
|---|---|
| **只接受大寫（嚴格）** | 契約明確，錯誤早發現。文件寫 `PAID` 就是 `PAID` |
| **接受任何大小寫（寬容）** | 前端傳 `paid` 也能用，少一個客服問題 |

03-rest-api 第 03 章 3.10.3 的決定：**列舉值一律 `UPPER_SNAKE_CASE`，API 只接受精確值。**
理由是「寬容輸入」在列舉上會反咬：
如果今天接受 `paid`，明天有人送 `Paid`，你就得永遠支援全部大小寫組合，
而 OpenAPI 的 `enum` 清單無法表達這件事。

**但要把錯誤訊息做好。** 預設訊息是這樣的：

```
Failed to convert value of type 'java.lang.String' to required type
'example.shop.order.domain.OrderStatus'; Failed to convert from type
[java.lang.String] to type [@RequestParam OrderStatus] for value 'paid'
```

**這對前端完全沒有幫助。** 而且它會回 400 而不是 422。
03 章 3.7 會把它變成：

```jsonc
{
  "status": 422,
  "code": "VALIDATION_FAILED",
  "errors": [{
    "field": "status",
    "code": "INVALID_ENUM_VALUE",
    "message": "不是有效的訂單狀態",
    "rejectedValue": "paid",
    "constraint": { "allowedValues": ["PENDING_PAYMENT", "PAID", "PARTIALLY_SHIPPED",
                                      "SHIPPED", "COMPLETED", "CANCELLED", "RETURNED"] }
  }]
}
```

**問題 2：未知值 → 你不希望是 500。**

```java
@RequestBody 裡的列舉未知值
→ Jackson InvalidFormatException
→ HttpMessageNotReadableException
→ 400（沒有欄位資訊！）
```

⚠️ Jackson 的預設訊息會**列出全部合法值**，等於洩漏內部狀態清單。
而且錯誤位置資訊在 `HttpMessageNotReadableException` 裡不好抽（03 章 3.5.3 會處理）。

**折衷方案：用 `String` 收，在 Service 轉。**

```java
// DTO 用 String + @Pattern
List<@Pattern(regexp = "^[A-Z_]{1,32}$") String> status,
```

好處：
- 未知值不會在綁定階段炸掉，可以在驗證階段給精確的 `field` 與 `allowedValues`。
- **新增列舉值時舊客戶端不會壞**（03-rest-api 第 03 章 3.10.2 的三層防護）。

壞處：失去型別安全，Service 要自己轉。

**shop-service 的決定**：
- **請求方向用 `String`**（寬容接收，精確報錯），Service 邊界轉成 enum。
- **回應方向用 `String`**（`status` 欄位是字串），因為前端不該對未知值崩潰。

```java
// 在 mapper 裡集中轉換，錯誤訊息可控
public OrderStatus toStatus(String raw) {
    try {
        return OrderStatus.valueOf(raw);
    } catch (IllegalArgumentException e) {
        throw new InvalidEnumValueException("status", raw, OrderStatus.class);
    }
}
```

**問題 3：如果你真的要用 enum 直接綁定，怎麼做得好。**

```java
package example.shop.common.config;

import org.springframework.core.convert.converter.Converter;
import org.springframework.core.convert.converter.ConverterFactory;
import org.springframework.stereotype.Component;

/**
 * 大小寫不敏感的列舉轉換：把 "paid" / "Paid" 都轉成 PAID。
 * ⚠️ shop-service 不啟用這個（見 1.9.2 的決定），這裡示範怎麼寫。
 */
@Component
public class CaseInsensitiveEnumConverterFactory implements ConverterFactory<String, Enum> {

    @Override
    public <T extends Enum> Converter<String, T> getConverter(Class<T> targetType) {
        return source -> {
            if (source == null || source.isBlank()) return null;      // ★ 空字串→null
            String normalized = source.trim().toUpperCase(java.util.Locale.ROOT);
            for (T c : targetType.getEnumConstants()) {
                if (c.name().equals(normalized)) return c;
            }
            throw new InvalidEnumValueException(targetType.getSimpleName(), source, targetType);
        };
    }
}
```

```java
@Configuration
public class WebMvcConfig implements WebMvcConfigurer {
    private final CaseInsensitiveEnumConverterFactory enumFactory;
    // ...
    @Override
    public void addFormatters(FormatterRegistry registry) {
        registry.addConverterFactory(enumFactory);
    }
}
```

### 1.9.3 日期與時間

```java
@RequestParam(name = "createdFrom", required = false)
Instant createdFrom                                  // ★ 不需要 @DateTimeFormat
```

| `ISO` 值 | 格式 | 例子 | 適用型別 |
|---|---|---|---|
| `DATE` | `yyyy-MM-dd` | `2026-08-20` | `LocalDate`、`java.util.Date` |
| `TIME` | `HH:mm:ss.SSSXXX` | `06:12:44Z` | `LocalTime`、`OffsetTime` |
| `DATE_TIME` | ISO-8601 完整 | `2026-08-20T06:12:44Z` | `LocalDateTime`、`OffsetDateTime`、`ZonedDateTime` |

> ### ⚠️⚠️ `@DateTimeFormat` 對 `Instant` 是**沒有作用**的 ★★
>
> 這是一個很多人（包含本課程早期的版本）寫錯的地方。
>
> `@DateTimeFormat` 由 `Jsr310DateTimeFormatAnnotationFormatterFactory` 處理，
> 而它的 `getFieldTypes()` 明確列出支援的型別：
>
> ```java
> // Jsr310DateTimeFormatAnnotationFormatterFactory
> private static final Set<Class<?>> FIELD_TYPES = Set.of(
>         LocalDate.class, LocalTime.class, LocalDateTime.class,
>         ZonedDateTime.class, OffsetDateTime.class, OffsetTime.class,
>         YearMonth.class, MonthDay.class);
> //  ★★ 沒有 Instant.class
> ```
>
> **所以 `@DateTimeFormat` 標在 `Instant` 上會被完全忽略** ——
> 不會報錯、不會警告，`iso = ISO.DATE` 也一樣沒效果。
>
> 真正處理 `Instant` 的是 `DateTimeFormatterRegistrar` 註冊的
> **`InstantFormatter`**，它的規則是固定的：
>
> ```java
> // org.springframework.format.datetime.standard.InstantFormatter
> public Instant parse(String text, Locale locale) {
>     if (text.length() > 0 && Character.isAlphabetic(text.charAt(0))) {
>         // 支援 RFC-1123（"Tue, 3 Jun 2008 11:05:30 GMT"）—— HTTP header 用的格式
>         return Instant.from(DateTimeFormatter.RFC_1123_DATE_TIME.parse(text));
>     }
>     return Instant.parse(text);              // ★ 其餘一律 Instant.parse（嚴格 ISO-8601）
> }
> ```
>
> **三個實務結論**：
>
> | | |
> |---|---|
> | `Instant` 參數**不要**標 `@DateTimeFormat` | 它是噪音，會讓讀者以為格式可以調 |
> | `Instant` 的可接受格式**不可調整** | 想要寬容（接受 `+08:00`、epoch 秒）就要**自己註冊 Converter** —— 見 06 章 6.6.1 的 `StringToInstantConverter` |
> | 想用 `@DateTimeFormat` 控制格式 | 型別要改成 `OffsetDateTime` 或 `LocalDateTime` |

⚠️ **`Instant.parse()` 需要帶時區資訊。**
`?createdFrom=2026-08-20T06:12:44`（沒有 `Z`）會拋
`DateTimeParseException` → `MethodArgumentTypeMismatchException` → **400**。

⚠️ **而 `Instant.parse()` 也不接受 `2026-08-20T14:12:44+08:00`**（JDK 11 之前）。
JDK 12+ 開始 `Instant.parse` 接受帶偏移的寫法並轉成 UTC，
**但 `2026-08-20`（只有日期）永遠不接受** ——
而那正是前端最常送的東西。
👉 **所以 shop-service 註冊了 06 章 6.6.1 的 `StringToInstantConverter`**，
它同時接受 `2026-08-20`、`2026-08-20T06:12:44Z`、`+08:00` 與 epoch 毫秒，
並且**與 Jackson 的反序列化共用同一個解析函式**（那是 6.6.1 的重點）。

如果要接受「本地時間」，用 `LocalDateTime` 然後在程式裡明確指定時區
（03-rest-api 第 03 章 3.6：**時間一律 UTC ISO-8601**）。

**日期範圍參數的一個實務決定**（03-rest-api 第 05 章 5.8.2）：

```java
// createdTo 是「不含」還是「含」？
?createdFrom=2026-08-01&createdTo=2026-08-31
```

如果 `createdTo` 是 `LocalDate` 並解讀成 `2026-08-31T00:00:00Z`，
**8/31 當天的訂單會全部漏掉**。這是一個非常常見的報表 bug。

shop-service 的規則：**`createdTo` 是 exclusive（不含）**，並在文件寫清楚。
若客戶端送 `LocalDate`，mapper 自動 `+1 天`：

```java
public Instant toExclusiveEnd(LocalDate date) {
    return date.plusDays(1).atStartOfDay(ZoneOffset.UTC).toInstant();
}
```

**全域設定 Jackson 的時間格式**（body 方向，06 章會完整處理）：

```yaml
spring:
  jackson:
    serialization:
      write-dates-as-timestamps: false      # ★ 用 ISO 字串而不是 epoch 毫秒
    time-zone: UTC
```

### 1.9.4 自訂 `Converter`：`Cursor`

03-rest-api 第 05 章 5.4.3 定義了 cursor 是一個 Base64URL 編碼的複合結構。
Controller 應該拿到**已解析、已驗證**的 `Cursor` 物件，而不是字串。

```java
package example.shop.common.web;

import java.time.Instant;
import java.util.Base64;
import java.util.Map;

/**
 * cursor 分頁的游標。格式（Base64URL 編碼的 JSON）：
 * {"v":1,"k":["2026-08-19T06:12:44Z","ord_01J5..."],"s":"createdAt,desc","f":"a3f9c1"}
 *   v = 版本、k = keyset 值、s = 排序規格、f = 篩選條件的 hash
 */
public record Cursor(int version, java.util.List<String> keys, String sortSpec, String filterHash) {

    public static final int CURRENT_VERSION = 1;

    public String encode(com.fasterxml.jackson.databind.ObjectMapper om) {
        try {
            var payload = Map.of("v", version, "k", keys, "s", sortSpec, "f", filterHash);
            return Base64.getUrlEncoder().withoutPadding()
                    .encodeToString(om.writeValueAsBytes(payload));
        } catch (Exception e) {
            throw new IllegalStateException("cursor 編碼失敗", e);
        }
    }
}
```

```java
package example.shop.common.config;

import example.shop.common.web.Cursor;
import example.shop.common.web.InvalidCursorException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.core.convert.converter.Converter;
import org.springframework.stereotype.Component;

import java.util.Base64;
import java.util.List;
import java.util.Map;

@Component
public class StringToCursorConverter implements Converter<String, Cursor> {

    private final ObjectMapper objectMapper;

    public StringToCursorConverter(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @Override
    public Cursor convert(String source) {
        // ★ 一定要處理空字串：?cursor= 會走到這裡，不處理就變 500
        if (source == null || source.isBlank()) return null;

        // ★ 長度上限：擋掉「送 10 MB 的 cursor 塞爆 Base64 解碼」
        if (source.length() > 512) {
            throw new InvalidCursorException("cursor 長度超過上限");
        }
        try {
            byte[] json = Base64.getUrlDecoder().decode(source);
            Map<String, Object> m = objectMapper.readValue(json, Map.class);

            int version = ((Number) m.get("v")).intValue();
            if (version != Cursor.CURRENT_VERSION) {
                // ★ 版本不符要明確拒絕，不要嘗試相容 —— 舊 cursor 的 keyset 語意可能不同
                throw new InvalidCursorException("cursor 版本不支援：" + version);
            }
            @SuppressWarnings("unchecked")
            List<String> keys = (List<String>) m.get("k");
            if (keys == null || keys.isEmpty() || keys.size() > 4) {
                throw new InvalidCursorException("cursor 內容不完整");
            }
            return new Cursor(version, List.copyOf(keys),
                              (String) m.get("s"), (String) m.get("f"));

        } catch (InvalidCursorException e) {
            throw e;
        } catch (Exception e) {
            // ⚠️ 絕對不要把原始例外訊息回給客戶端（可能含解碼後的內容）
            throw new InvalidCursorException("cursor 格式無效");
        }
    }
}
```

**這個 Converter 示範了四個實務要點**：

| 要點 | 為什麼 |
|---|---|
| 處理空字串回 `null` | `?cursor=` 是很常見的請求（前端狀態初始化） |
| 長度上限 | Base64 解碼會配置記憶體；沒上限就是 DoS 向量 |
| 版本檢查 | cursor 的結構會演進，舊 cursor 必須明確拒絕而不是誤解 |
| 例外訊息不透傳 | 解碼失敗的細節可能包含輸入內容，回傳等於 reflected XSS 的素材 |

⚠️ **`Converter` 拋出的例外會被包成 `ConversionFailedException`
再包成 `MethodArgumentTypeMismatchException`。**
要在 advice 裡取出你的原始例外，得走 `getRootCause()`（03 章 3.5.4 會處理）。

### 1.9.5 為什麼 `@InitBinder` 用得越來越少

老教材會教 `@InitBinder`：

```java
@InitBinder
public void initBinder(WebDataBinder binder) {
    binder.registerCustomEditor(Date.class,
            new CustomDateEditor(new SimpleDateFormat("yyyy-MM-dd"), true));
}
```

**不要用這個。** 三個理由：

1. `PropertyEditor` 是 Java Beans 時代的 API，**不是執行緒安全的**，
   而且 Spring 必須為每個請求建新的 binder。
2. 它只作用在**這個 Controller**，70 個 Controller 要寫 70 次。
3. `Converter` / `Formatter`（Spring 3 起）功能更強、可測試、可全域註冊。

**`@InitBinder` 剩下的正當用途只有一個**：`setDisallowedFields`。

```java
@InitBinder
void restrictBinding(WebDataBinder binder) {
    // 防止 @ModelAttribute 綁定意外的屬性（mass assignment 的最後防線）
    binder.setDisallowedFields("id", "createdAt", "createdBy", "version");
}
```

⚠️ 但 shop-service 用 record DTO，欄位本來就只有該有的那些，
所以連這個也不需要。**「用 record 當 DTO」本身就是最好的 mass assignment 防護。**

---

## 1.10 `Pageable`：用還是不用

### 1.10.1 `Pageable` 的自動綁定

```java
@GetMapping
public PageResponse<OrderSummary> list(
        @PageableDefault(size = 20, sort = "createdAt", direction = Sort.Direction.DESC)
        Pageable pageable) { }
```

⚠️ **第一個問題：這需要 `spring-data-commons` 在 classpath 上。**
04-controller 的專案還沒加 `spring-boot-starter-data-jpa`，所以 `Pageable` **不會被解析**：

```
java.lang.IllegalStateException: No primary or single unique constructor found for
interface org.springframework.data.domain.Pageable
```

（Spring 會把它當成 `@ModelAttribute` 處理，然後失敗。）

要用的話得加：

```xml
<dependency>
  <groupId>org.springframework.data</groupId>
  <artifactId>spring-data-commons</artifactId>
</dependency>
```

### 1.10.2 `Pageable` 的三個坑（03-rest-api 第 05 章 5.13.2 的實作視角）

| 坑 | 具體行為 | 後果 |
|---|---|---|
| **`max-page-size` 是靜默夾取** | `?size=100000` → 變成 100，**回 200，不報錯** | 匯出功能少了 41 萬筆而沒人知道（真實事故） |
| **`sort` 沒有白名單** | `?sort=cost,desc` → 直接變成 `ORDER BY cost DESC` | 洩漏內部欄位；找不到欄位時拋 `PropertyReferenceException` → **500** |
| **`Page<T>` 自動 `COUNT(*)`** | 每次查詢多一次 count | 大表上 count 要 8 秒（03-rest-api 5.6） |

**第一個坑的嚴重性值得再說一次**：靜默夾取意味著

```
客戶端要求 100,000 筆 → 收到 100 筆 → HTTP 200 → 「成功」
```

沒有任何訊號告訴客戶端「你要的和你拿到的不一樣」。
匯出報表的人以為資料就是這麼多。

### 1.10.3 shop-service 的選擇：自己的 `PageQuery`

```java
package example.shop.common.web;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;

/**
 * API 邊界的分頁參數。刻意「不」用 Spring Data 的 Pageable：
 *  · size 超限要回 422，不是靜默夾取（03-rest-api 5.2.4）
 *  · sort 必須過白名單（03-rest-api 5.9.2）
 *  · 深分頁要有上限
 * Repository 層再把它轉成 Pageable / Window（06-repository）。
 */
public record PageQuery(
    @Min(value = 0, message = "page 不可小於 0") int page,
    @Min(value = 1, message = "size 最小為 1")
    @Max(value = 100, message = "size 最大為 100") int size,
    SortSpec sort
) {
    public static final int MAX_OFFSET = 10_000;

    public PageQuery {
        // ★ 這裡「不」夾取，只驗證。夾取會製造靜默錯誤
        if ((long) page * size > MAX_OFFSET) {
            throw new DeepPaginationException(page, size, MAX_OFFSET);
        }
    }

    public int offset() { return page * size; }
}
```

```java
package example.shop.common.web;

import java.util.List;
import java.util.Set;

/** 已經過白名單驗證的排序規格。 */
public record SortSpec(List<Order> orders) {

    public record Order(String field, Direction direction) {}
    public enum Direction { ASC, DESC }

    /**
     * 解析 "createdAt,desc;totalAmount,asc" 並比對白名單。
     * @throws InvalidSortFieldException 欄位不在白名單
     */
    public static SortSpec parse(String raw, Set<String> whitelist, String defaultSpec) {
        String s = (raw == null || raw.isBlank()) ? defaultSpec : raw;

        var orders = java.util.Arrays.stream(s.split(";"))
                .map(String::trim).filter(t -> !t.isEmpty())
                .map(token -> {
                    String[] parts = token.split(",");
                    String field = parts[0].trim();
                    if (!whitelist.contains(field)) {
                        throw new InvalidSortFieldException(field, whitelist);
                    }
                    Direction dir = (parts.length > 1 && parts[1].trim().equalsIgnoreCase("desc"))
                            ? Direction.DESC : Direction.ASC;
                    return new Order(field, dir);
                })
                .toList();

        if (orders.isEmpty()) throw new InvalidSortFieldException(s, whitelist);
        if (orders.size() > 3) {
            throw new InvalidSortFieldException("排序欄位最多 3 個", whitelist);
        }
        return new SortSpec(orders);
    }

    /** 序列化回字串，用於 cursor 的 sortSpec 欄位與 Link header。 */
    public String toParam() {
        return orders.stream()
                .map(o -> o.field() + "," + o.direction().name().toLowerCase())
                .reduce((a, b) -> a + ";" + b).orElse("");
    }
}
```

**排序欄位上限 3 個** 的理由：每多一個排序欄位就需要一個複合索引欄位，
而且 cursor 分頁的 keyset 條件會變成 `(a,b,c,d) < (?,?,?,?)`，超過 3 個實務上查詢計畫會崩。

**白名單在哪裡宣告？** 在 `OrderFilter` 上用自訂註解（02 章 2.8 實作 `@SortWhitelist`），
或在 mapper 裡：

```java
public final class OrderSortFields {
    public static final Set<String> ALLOWED = Set.of(
            "createdAt", "updatedAt", "totalAmount", "orderNumber", "status");
    public static final String DEFAULT = "createdAt,desc";
    private OrderSortFields() {}
}
```

⚠️ **白名單裡的名稱是「API 欄位名」，不是「資料庫欄位名」。**
`createdAt` → `created_at`，`totalAmount` → `total_amount`。
這層對映在 Repository（06 章），Controller 完全不知道資料庫長什麼樣。

**這個設計避免了三件事**：
- 客戶端排序 `?sort=internalRiskScore` 洩漏內部欄位存在。
- `?sort=(select...)` 的 SQL injection（雖然 JPA 會擋，但 MyBatis 的 `${}` 不會）。
- 排序一個沒有索引的欄位讓資料庫 full scan。

---

## 1.11 回應：三種寫法與選擇

### 1.11.1 三種寫法

**寫法 A：直接回 DTO（狀態碼固定 200）**

```java
@GetMapping("/{orderId}")
public OrderDetail get(@PathVariable("orderId") String orderId) {
    return mapper.toDetail(orderService.findById(orderId));
}
```

**寫法 B：DTO + `@ResponseStatus`（狀態碼固定但不是 200）**

```java
@PostMapping("/{orderId}/cancellations")
@ResponseStatus(HttpStatus.CREATED)
public CancellationResponse cancel(...) { }
```

**寫法 C：`ResponseEntity`（狀態碼或 header 依執行結果變化）**

```java
@PostMapping
public ResponseEntity<CreateOrderResponse> create(...) {
    var result = orderService.create(command);

    // ★ 冪等鍵命中時回 200 而不是 201（03-rest-api 第 08 章 8.2）
    var status = result.wasCreated() ? HttpStatus.CREATED : HttpStatus.OK;

    var location = ServletUriComponentsBuilder.fromCurrentRequest()
            .path("/{orderId}").buildAndExpand(result.order().getId()).toUri();

    return ResponseEntity.status(status)
            .location(location)
            .eTag("\"v" + result.order().getVersion() + "\"")
            .body(mapper.toCreateResponse(result.order()));
}
```

### 1.11.2 決策表

| 情況 | 用 | 理由 |
|---|---|---|
| `GET` 單筆／列表，固定 200 | **A** | 最短，OpenAPI 也最清楚 |
| `POST` 固定 201，不需要 `Location` | **B** | 一個註解就好 |
| `DELETE` 固定 204 | **B**（`@ResponseStatus(NO_CONTENT)` + `void`） | — |
| `POST` 要回 `Location` | **C** | `Location` 的值要在執行後才知道 |
| 冪等鍵命中要回 200，否則 201 | **C** | 狀態碼依結果變化 |
| 要回 `ETag` / `Cache-Control` | **C** 或用 `HttpServletResponse`／filter | — |
| 可能回 304（`If-None-Match` 命中） | **C** | `ResponseEntity.status(NOT_MODIFIED).build()` |
| 202 + `Location` 指向工作狀態 | **C** | 匯出工作（05 章） |

**shop-service 的規則：能用 A / B 就用，只在必要時用 C。**
理由是 `ResponseEntity<T>` 讓 OpenAPI 的回應型別多一層包裝，
springdoc 大多能處理但偶爾要加 `@ApiResponse` 補說明。

### 1.11.3 `204 No Content` 的兩個坑

```java
@DeleteMapping("/{addressId}")
@ResponseStatus(HttpStatus.NO_CONTENT)
public void delete(@PathVariable("addressId") String addressId) {
    addressService.delete(addressId);
}
```

⚠️ **坑 1：回傳 `void` + `@ResponseStatus(204)` 是對的；
回傳 `null` + 期待 204 是錯的。**

```java
// ❌ 這會回 200，body 是空的（不是 204）
@DeleteMapping("/{id}")
public Object delete(...) { return null; }
```

⚠️ **坑 2：`204` 不能有 body。**

```java
// ❌ Spring 會忽略 body（或某些客戶端會報錯）
return ResponseEntity.status(HttpStatus.NO_CONTENT).body(someDto);
```

如果你想回「刪除成功，這是剩下的狀態」，就該回 **200 + body**，不是 204。
（03-rest-api 第 02 章 2.5 討論過這個選擇。shop-service 的 `DELETE /carts/current/coupon`
回 **200 + 更新後的購物車**，因為前端需要新的金額。）

### 1.11.4 `Location` header 的正確產生方式

```java
// ❌ 手工組字串：忘記 context-path、忘記 URL encode
URI.create("/orders/" + orderId)

// ⚠️ 好一點，但假設了路徑結構
ServletUriComponentsBuilder.fromCurrentRequest().path("/{id}").buildAndExpand(orderId).toUri()

// ✅ 最穩：從 Controller 方法反推
URI location = MvcUriComponentsBuilder
        .fromMethodCall(on(OrderController.class).get(orderId, null))
        .build().toUri();
```

實務上第二種就夠用，也最好讀。第三種的好處是**改路徑時編譯期就會發現**，
但它需要 `on(...)` 這種 proxy 技巧，可讀性差，而且對有 `@AuthenticationPrincipal`
參數的方法要傳 `null` 佔位（如上）。

⚠️ **`fromCurrentRequest()` 在有反向代理時會產生錯誤的 host。**
如果 Nginx 在前面且外部是 `https://api.shop.example`，
`fromCurrentRequest()` 會拿到 `http://localhost:8080`。

**修法**：加 `ForwardedHeaderFilter`，並確保代理有送 `X-Forwarded-*`：

```java
@Bean
ForwardedHeaderFilter forwardedHeaderFilter() {
    return new ForwardedHeaderFilter();
}
```

```yaml
server:
  forward-headers-strategy: framework      # ★ 讓 Boot 自動註冊上面那個 filter
```

⚠️ **安全提醒**：`X-Forwarded-Host` 是客戶端可控的。
只有在**確定前面有可信代理會覆寫它**時才開啟，否則會有 host header injection
（攻擊者讓你的 `Location` 指向他的網域，用在密碼重設信件上就是接管帳號）。

### 1.11.5 回傳集合永遠包一層外殼

```java
// ❌ 直接回陣列
@GetMapping
public List<OrderSummary> list() { }
```

```jsonc
[{...}, {...}]
```

**問題**：想加 `page` 資訊時，回應根型別要從陣列變成物件 —— **這是破壞性變更**
（03-rest-api 第 06 章的判定表裡是「災難級」）。

```java
// ✅ 一開始就包外殼
@GetMapping
public PageResponse<OrderSummary> list(@Valid @ModelAttribute OrderFilter filter) { }
```

```jsonc
{ "items": [...], "page": { "number": 0, "size": 20, "totalElements": 1523 } }
```

⚠️ 順便：**JSON 根層級是陣列曾經是一個 CSRF 向量**（JSON hijacking，
利用 `Array` 建構子覆寫）。現代瀏覽器已經不受影響，但外殼仍然是好習慣。

---

## 1.12 shop-service：把 URL 表變成方法簽章

### 1.12.1 訂單相關端點的完整對照

| 方法 | 路徑 | Controller#method | 回傳 | 狀態碼 |
|---|---|---|---|---|
| `GET` | `/orders` | `OrderController#list` | `PageResponse<OrderSummary>` | 200 |
| `POST` | `/orders` | `OrderController#create` | `ResponseEntity<CreateOrderResponse>` | 201 / 200（冪等命中） |
| `GET` | `/orders/{orderId}` | `OrderController#get` | `ResponseEntity<OrderDetail>` | 200 / 304 |
| `PATCH` | `/orders/{orderId}` | `OrderController#patch` | `OrderDetail` | 200 |
| `GET` | `/orders/{orderId}/items` | `OrderItemController#list` | `PageResponse<OrderItemResponse>` | 200 |
| `GET` | `/orders/{orderId}/status-changes` | `OrderStatusChangeController#list` | `PageResponse<StatusChangeResponse>` | 200 |
| `GET` | `/orders/{orderId}/invoice` | `OrderInvoiceController#get` | `InvoiceResponse` | 200 |
| `PUT` | `/orders/{orderId}/invoice` | `OrderInvoiceController#put` | `InvoiceResponse` | 200 |
| `POST` | `/orders/{orderId}/payments` | `OrderPaymentController#create` | `ResponseEntity<PaymentResponse>` | 201 / 202（3DS） |
| `GET` | `/orders/{orderId}/payments` | `OrderPaymentController#list` | `PageResponse<PaymentResponse>` | 200 |
| `POST` | `/orders/{orderId}/cancellations` | `OrderCancellationController#create` | `ResponseEntity<CancellationResponse>` | 201 |
| `GET` | `/orders/{orderId}/cancellations` | `OrderCancellationController#list` | `PageResponse<CancellationResponse>` | 200 |
| `POST` | `/orders/{orderId}/shipments` | `OrderShipmentController#create` | `ResponseEntity<ShipmentResponse>` | 201 |
| `GET` | `/orders/{orderId}/shipments` | `OrderShipmentController#list` | `PageResponse<ShipmentResponse>` | 200 |
| `PATCH` | `/orders/{orderId}/shipping-address` | `OrderShippingAddressController#update` | `ShippingAddressChangeResponse` | 200 |

### 1.12.2 `OrderController` 完整程式碼

```java
package example.shop.order.web;

import example.shop.common.web.ApiHeaders;
import example.shop.common.web.PageResponse;
import example.shop.order.service.OrderService;
import example.shop.order.web.dto.*;
import example.shop.security.CurrentUser;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.support.ServletUriComponentsBuilder;

import java.net.URI;

@RestController
@RequestMapping(path = "/orders", produces = MediaType.APPLICATION_JSON_VALUE)
@Validated                                   // ★ 讓方法參數上的 @NotBlank / @Size 生效（1.8.1）
public class OrderController {

    private final OrderService orderService;
    private final OrderWebMapper mapper;

    public OrderController(OrderService orderService, OrderWebMapper mapper) {
        this.orderService = orderService;
        this.mapper = mapper;
    }

    // ── GET /orders ────────────────────────────────────────────────
    @GetMapping
    public PageResponse<OrderSummary> list(
            @Valid @ModelAttribute OrderFilter filter,
            @AuthenticationPrincipal CurrentUser user) {

        var query = mapper.toSearchQuery(filter, user.actor());

        return filter.usesCursor()
                ? mapper.toCursorPage(orderService.scroll(query), filter)
                : mapper.toOffsetPage(orderService.search(query), filter);
    }

    // ── POST /orders ───────────────────────────────────────────────
    @PostMapping(consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<CreateOrderResponse> create(
            @Valid @RequestBody CreateOrderRequest request,
            @RequestHeader(ApiHeaders.IDEMPOTENCY_KEY)
            @NotBlank(message = "缺少冪等鍵") @Size(max = 64) String idempotencyKey,
            @AuthenticationPrincipal CurrentUser user) {

        var result = orderService.create(
                mapper.toCreateCommand(request, user.actor(), idempotencyKey));

        var body = mapper.toCreateResponse(result.order());
        URI location = ServletUriComponentsBuilder.fromCurrentRequest()
                .path("/{orderId}")
                .buildAndExpand(body.orderId())
                .toUri();

        // 冪等鍵命中 → 200（不是重複建立）；否則 201
        HttpStatus status = result.wasCreated() ? HttpStatus.CREATED : HttpStatus.OK;

        return ResponseEntity.status(status).location(location).body(body);
    }

    // ── GET /orders/{orderId} ──────────────────────────────────────
    @GetMapping("/{orderId}")
    public ResponseEntity<OrderDetail> get(
            @PathVariable("orderId") String orderId,
            @RequestHeader(name = "If-None-Match", required = false) String ifNoneMatch,
            @AuthenticationPrincipal CurrentUser user) {

        var order = orderService.findById(orderId, user.actor());
        String etag = "\"v" + order.getVersion() + "\"";

        // 條件請求命中 → 304，不用序列化整個 body（06 章 6.6 會改用更通用的機制）
        if (etag.equals(ifNoneMatch)) {
            return ResponseEntity.status(HttpStatus.NOT_MODIFIED).eTag(etag).build();
        }
        return ResponseEntity.ok()
                .eTag(etag)
                .cacheControl(org.springframework.http.CacheControl.noStore())
                .body(mapper.toDetail(order, user.role()));
    }

    // ── PATCH /orders/{orderId} ────────────────────────────────────
    @PatchMapping(path = "/{orderId}", consumes = MediaType.APPLICATION_JSON_VALUE)
    public OrderDetail patch(
            @PathVariable("orderId") String orderId,
            @Valid @RequestBody UpdateOrderRequest request,
            @RequestHeader(name = "If-Match", required = false) String ifMatch,
            @AuthenticationPrincipal CurrentUser user) {

        var order = orderService.update(
                mapper.toUpdateCommand(orderId, request, user.actor(), parseVersion(ifMatch)));
        return mapper.toDetail(order, user.role());
    }

    /** If-Match: "v7" → 7；沒帶就是 null（樂觀鎖檢查交給 Service 決定要不要強制）。 */
    private Long parseVersion(String ifMatch) {
        if (ifMatch == null || ifMatch.isBlank()) return null;
        String v = ifMatch.replace("\"", "").replace("W/", "").trim();
        if (!v.startsWith("v")) throw new MalformedETagException(ifMatch);
        try {
            return Long.parseLong(v.substring(1));
        } catch (NumberFormatException e) {
            throw new MalformedETagException(ifMatch);
        }
    }
}
```

**這個類別的四個觀察點**：

1. **`parseVersion` 是唯一的私有方法，而且它在做「HTTP 翻譯」** —— 
   `If-Match: "v7"` 是 HTTP 語意，`7L` 是 Java 語意。這正是 Controller 該做的事（0.5 的第 7 項）。
2. **沒有一個 try-catch。** `MalformedETagException` 交給 advice。
3. **沒有一個業務 `if`。** 唯一的 `if` 是「ETag 相符 → 304」（HTTP 語意）
   與「冪等命中 → 200」（也是 HTTP 語意）。
4. **`@Validated` 在類別上**，因為 `idempotencyKey` 的 `@NotBlank` 是方法參數約束。
   ⚠️ 在 Boot 3.2（Spring 6.1）上這一行其實該**拿掉** —— 見 1.8.1 的警告與
   [02 章 2.3.2](./02-validation-and-binding-errors.md)。

### 1.12.3 `OrderPaymentController`：多型 body 的實作

```java
package example.shop.order.web;

import example.shop.common.web.ApiHeaders;
import example.shop.common.web.PageResponse;
import example.shop.order.service.PaymentService;
import example.shop.order.web.dto.CreatePaymentRequest;
import example.shop.order.web.dto.PaymentResponse;
import example.shop.security.CurrentUser;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.http.*;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping(path = "/orders/{orderId}/payments", produces = MediaType.APPLICATION_JSON_VALUE)
@Validated
public class OrderPaymentController {

    private final PaymentService paymentService;
    private final PaymentWebMapper mapper;

    public OrderPaymentController(PaymentService paymentService, PaymentWebMapper mapper) {
        this.paymentService = paymentService;
        this.mapper = mapper;
    }

    @PostMapping(consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<PaymentResponse> create(
            @PathVariable("orderId") String orderId,
            @Valid @RequestBody CreatePaymentRequest request,     // ★ sealed interface，多型
            @RequestHeader(ApiHeaders.IDEMPOTENCY_KEY) @NotBlank String idempotencyKey,
            @AuthenticationPrincipal CurrentUser user) {

        var result = paymentService.pay(
                mapper.toPayCommand(orderId, request, user.actor(), idempotencyKey));

        var body = mapper.toResponse(result.payment());

        // 需要 3D 驗證 → 202 Accepted + nextAction（03-rest-api 第 04 章 4.13.4）
        if (result.requiresAction()) {
            return ResponseEntity.accepted()
                    .header(HttpHeaders.LOCATION, "/payments/" + body.paymentId())
                    .body(body);
        }
        return ResponseEntity.status(HttpStatus.CREATED)
                .header(HttpHeaders.LOCATION, "/payments/" + body.paymentId())
                .body(body);
    }

    @GetMapping
    public PageResponse<PaymentResponse> list(@PathVariable("orderId") String orderId,
                                              @AuthenticationPrincipal CurrentUser user) {
        return mapper.toPage(paymentService.findByOrder(orderId, user.actor()));
    }
}
```

⚠️ **注意 `Location` 指向 `/payments/{id}`（頂層資源）而不是
`/orders/{orderId}/payments/{id}`。**
因為 03-rest-api 第 01 章 1.14.5 決定付款有頂層資源（財務對帳要從金流商報表反查）。
**`Location` 應該指向該資源的「正規 URL」**，不是你剛好用來建立它的那條路徑。

### 1.12.4 一個常被忽略的細節：`@PathVariable` 的驗證

```java
@GetMapping("/{orderId}")
public ResponseEntity<OrderDetail> get(@PathVariable("orderId") String orderId, ...) { }
```

`orderId` 如果是 5,000 個字元的字串會怎樣？

- 進入你的方法 → 傳給 Service → 變成 SQL 參數 → MySQL 的 `varchar(64)` 比對 → 查不到 → 404。

**能動，但浪費了一次資料庫查詢。** 而且如果有人用 10 萬個這種請求打你，
每一個都會消耗一條連線。

```java
@GetMapping("/{orderId}")
public ResponseEntity<OrderDetail> get(
        @PathVariable("orderId") @Size(max = 64) @Pattern(regexp = "[A-Za-z0-9_-]+") String orderId,
        ...) { }
```

搭配類別上的 `@Validated`，格式不對的請求在**進方法前**就被拒絕。

⚠️ **但要注意它拋的例外**（1.8.1 的表）：Spring 6.1 起是 `HandlerMethodValidationException` → 400。
03 章會把它轉成 422 + 精確的 `field`。

**shop-service 的規則**：所有 `@PathVariable` 加 `@Size(max = 64)`。
用 1.4.3 的路徑正規表示式也可以，但註解版的錯誤訊息更好（422 而不是 404）。

### 1.12.5 支援型別：前面用到但還沒定義的東西

這一節補上前面幾節出現過、但還沒給出完整定義的型別。
**它們會被 02～07 章一路用下去**，所以放在這裡而不是散在各節。

**① `CreateOrderResponse`：`POST /orders` 的回應**

```java
package example.shop.order.web.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;
import java.util.List;

/**
 * 下單成功的回應。
 *
 * <p>★★ 一個重要的設計決定：**它不等於 {@code OrderDetail}**。
 *
 * <p>三個理由：
 * <ol>
 *   <li><b>剛建立的訂單沒有 {@code shippedAt}、{@code cancelledAt}</b> ——
 *       把它們放進來只會是一堆 null。</li>
 *   <li><b>建立的回應要小</b> —— 客戶端拿到 201 之後通常會轉頁，
 *       完整明細由 {@code GET /orders/&#123;id&#125;} 取得
 *       （而那一次可以被 ETag 快取，06 章 6.8）。</li>
 *   <li><b>兩者的演化速度不同</b> —— {@code OrderDetail} 會一直加欄位，
 *       而建立的回應應該保持穩定。共用一個 record 會讓
 *       「加一個明細欄位」變成「改了建立的契約」。</li>
 * </ol>
 *
 * <p>⚠️ 反例：很多專案讓 POST 直接回傳完整的 detail。
 *    那在第一年很方便，第三年會變成「不敢改 OrderDetail」——
 *    因為它同時是三個端點的回應。
 */
public record CreateOrderResponse(

    /** 訂單 ID（ULID，1.4.3）。也在 {@code Location} 標頭裡。 */
    String orderId,

    /** 給人看的訂單編號，格式 {@code ORD-yyyyMMdd-NNNN}。 */
    String orderNumber,

    /** 建立後的狀態。永遠是 {@code PENDING_PAYMENT}，但明確回傳讓客戶端不用假設。 */
    OrderStatus status,

    /** ★ 狀態的顯示文字 —— 讓「新增 enum 值」不是破壞性變更（06 章 6.5.8）。 */
    String statusLabel,

    /** ★ 金額用字串（06 章 6.5.7）。 */
    String totalAmount,

    /** ISO 4217。 */
    String currency,

    /** ★ 付款期限 —— 客戶端要用它顯示倒數計時。 */
    Instant paymentDueAt,

    /**
     * ★ 下一步該做什麼（03-rest-api 4.10 的 action 設計）。
     *
     * <p>它讓客戶端不需要自己判斷「建立後要導去哪裡」——
     * 而那個判斷會隨著付款方式增加而變複雜。
     */
    NextAction nextAction,

    Instant createdAt

) {
    /** @param href 相對路徑；@param method HTTP 方法。 */
    public record NextAction(String code, String href, String method) {

        public static NextAction pay(String orderId) {
            return new NextAction("PAY", "/orders/" + orderId + "/payments", "POST");
        }
    }

    public CreateOrderResponse {
        // ⚠️ 不做防禦性複製 —— 這個 record 沒有可變的元件。
        //    如果之後加了 List 欄位，記得補 List.copyOf（3.6.2 的教訓）。
    }
}
```

⚠️ **`paymentDueAt` 用 `Instant` 而不是「剩餘秒數」**，
理由是 06 章 6.5.6 的同一個：**絕對時間可以被快取、被重送、被記錄；
相對時間一離開產生它的那一刻就錯了。**

**② `CreateOrderCommand` / `CancelOrderCommand`：往下傳的命令**

```java
package example.shop.order.service.command;

import example.shop.order.domain.Actor;
import example.shop.order.domain.InvoiceType;

import java.util.List;

/**
 * 下單的命令物件。
 *
 * <p>★★ 它與 {@code CreateOrderRequest}（02 章 2.12.1）的差別，
 *    就是「Controller 到底做了什麼翻譯」的完整答案：
 *
 * <table>
 *   <tr><th></th><th>CreateOrderRequest（HTTP）</th><th>CreateOrderCommand（Service）</th></tr>
 *   <tr><td>巢狀型別</td><td>{@code Item} / {@code InvoiceRequest}（web.dto 套件）</td>
 *       <td><b>{@code Line} / {@code InvoiceSpec}</b>（service.command 套件）</td></tr>
 *   <tr><td>「誰在操作」</td><td>不在 body 裡（在 token 裡）</td><td><b>{@code Actor}</b>（04 章 4.10）</td></tr>
 *   <tr><td>冪等鍵</td><td>在標頭裡</td><td><b>是一個欄位</b>（04 章 4.9）</td></tr>
 *   <tr><td>數量</td><td>{@code Integer}（可為 null，讓 {@code @NotNull} 報錯）</td>
 *       <td><b>{@code int}</b> —— 到這裡不可能是 null</td></tr>
 *   <tr><td>驗證註解</td><td>有（02 章）</td><td><b>沒有</b> —— 進到這裡就代表格式已經對了</td></tr>
 * </table>
 *
 * <p>★ 最後一列是關鍵：<b>Command 上不放 Bean Validation 註解</b>。
 *    放了的話會有兩份規則，而它們一定會分岔。
 *    Service 的前置條件用 {@code Objects.requireNonNull} 這種
 *    「程式錯誤才會觸發」的斷言表達，不是用驗證。
 *
 * <p>⚠️ 為什麼不直接把 {@code CreateOrderRequest} 傳給 Service：
 *    那會讓 Service 依賴 Web 層的型別 ——
 *    於是排程、批次匯入、gRPC 入口都得先組一個「假的 HTTP 請求」。
 *    （00 章 0.6.2 的完整論證。）
 *
 * <h3>★★ 這裡刻意「沒有」的三樣東西，每一個都是一個安全或正確性決定</h3>
 *
 * <table>
 *   <tr><th>沒有</th><th>為什麼</th></tr>
 *   <tr><td><b>任何金額欄位</b>（{@code unitPrice}、{@code totalAmount}）</td>
 *       <td>★★ 價格<b>只能</b>由伺服器查商品目錄決定。讓客戶端送價格 =
 *           把「我要用 1 元買 iPhone」變成一個合法的請求（00 章 0.6.2）。
 *           <b>Command 上沒有這個欄位，那個漏洞就在型別上不可能存在。</b></td></tr>
 *   <tr><td><b>展開的 {@code ShippingAddress} 物件</b></td>
 *       <td>只有 {@code shippingAddressId}。Web 層<b>不查資料庫</b>（00 章 0.4），
 *           所以它不可能把 ID 換成地址；而「這個地址是不是這個客戶的」
 *           本身就是一個授權判斷，屬於 Service（07 章 7.9.5）。</td></tr>
 *   <tr><td><b>{@code requestedDeliveryAt}</b></td>
 *       <td>shop-service 的到貨日由物流方案決定，不由客戶端指定。
 *           ⚠️ 如果哪天要加，它要同時出現在 Request、Command 與
 *           {@code orders-api.yaml} —— 而 07 章 7.10.2 的契約測試會強迫這件事。</td></tr>
 * </table>
 *
 * @param lines 訂單項目，至少一筆（{@code @NotEmpty} 已在 Request 上驗證過）
 */
public record CreateOrderCommand(
    Actor actor,                       // ★★ 授權判斷的依據（07 章 7.2.1）
    String idempotencyKey,             // ★ 04 章 4.9
    List<Line> lines,
    String shippingAddressId,          // ★ 只有 ID —— 見上方說明
    String couponCode,                 // 可為 null
    String customerNote,               // 可為 null
    InvoiceSpec invoice                // 可為 null（沒開發票）
) {
    /**
     * 一筆訂單項目。
     *
     * <p>★★ 只有「買什麼、買幾個」——<b>沒有價格</b>。
     */
    public record Line(String productId, int quantity) {}

    /** 發票資訊。與 {@code CreateOrderRequest.InvoiceRequest} 一對一，只是換了套件。 */
    public record InvoiceSpec(InvoiceType type, String taxId, String companyName,
                              String carrierId, String donationCode) {}

    public CreateOrderCommand {
        lines = List.copyOf(lines);    // ★ 不可變
    }
}
```

⚠️ **這個 record 的欄位順序與 00 章 0.10.3 的 `OrderWebMapper.toCommand()` 一致**
（`actor, idempotencyKey, lines, shippingAddressId, couponCode, customerNote, invoice`）。
**七章之中只要有一處對不上，07 章 7.6.5 的 `ArgumentCaptor` 測試就編譯不過** ——
那個測試存在的理由之一就是把這件事釘住。

```java
package example.shop.order.service.command;

import example.shop.order.domain.Actor;

/**
 * 取消訂單的命令。
 *
 * <p>★ 注意它有 {@code actor} 但**沒有** {@code orderId} 以外的識別 ——
 *    「這個 actor 有沒有資格取消這張訂單」是 Service 的判斷，
 *    Controller 只負責把兩者都傳下去（07 章 7.9.5 的資源層級授權）。
 */
public record CancelOrderCommand(
    String orderId,
    CancelReason reason,
    String note,                       // 可為 null，客服填的備註
    Actor actor,
    String idempotencyKey
) {
    /**
     * ★ 取消原因是 enum 而不是自由文字。
     *
     * <p>理由：它會進報表（「這個月有多少人因為運費太貴取消」）。
     *    自由文字的欄位在報表上只能做字串比對，而那永遠是錯的。
     *
     * <p>⚠️ 而 {@code OTHER} + {@code note} 是必要的逃生門 ——
     *    沒有它的話，使用者會被迫在 8 個不符的選項裡亂選一個，
     *    於是報表的數字比「沒有這個欄位」更糟（它看起來很精確）。
     */
    public enum CancelReason {
        CHANGED_MIND, FOUND_CHEAPER, SHIPPING_TOO_SLOW, SHIPPING_FEE_TOO_HIGH,
        WRONG_ITEM, DUPLICATE_ORDER, PAYMENT_ISSUE, OTHER
    }
}
```

**③ `InvalidSortFieldException`：排序白名單（1.10.3）**

```java
package example.shop.common.web;

import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;
import example.shop.common.web.DidYouMean;
import example.shop.common.web.ValueMasker;

import java.util.List;
import java.util.Set;

/**
 * 排序欄位不在白名單裡。
 *
 * <p>★★ 為什麼它是 {@code FORBIDDEN_PARAMETER}（403）而不是 400：
 *
 * <p>因為「白名單」的語意是「這個欄位存在，但你不可以用它排序」——
 * 例如 {@code internalCostPrice} 是一個真的欄位，
 * 而讓客戶端用它排序等於**洩漏了成本的相對大小**
 * （排序後就能二分搜尋出每個商品的成本排名）。
 *
 * <p>⚠️ 這是一個容易被忽略的資訊洩漏：
 *    你沒有回傳那個欄位，但「允許用它排序」等價於回傳了它的順序。
 *
 * <p>而對「根本不存在的欄位」（打錯字），回 400 比較合理 ——
 * 所以這個例外帶一個 {@code known} 旗標讓 advice 分辨。
 */
public class InvalidSortFieldException extends BusinessException {

    public InvalidSortFieldException(String field, Set<String> allowed) {
        super(knownButForbidden(field) ? ErrorCode.FORBIDDEN_PARAMETER
                                       : ErrorCode.UNKNOWN_PARAMETER,
              "Sort field is not allowed.",          // ★ detail 不含使用者輸入
              null,
              // ★ 用父類別的 ext() 建構擴充欄位 —— 03 章 3.5.2 的統一範式。
              //   ⚠️ 不要覆寫 extensions()：那個 accessor 讀的是 final 欄位，
              //      整個 codebase 一律走建構子這條路。
              ext("parameter", "sort",
                  // ★★ 一定要遮蔽 —— field 直接來自查詢參數（3.11.2、4.5.4）
                  "value", ValueMasker.mask("sort", field),
                  // ⚠️ 刻意**不**回傳完整白名單給匿名使用者 ——
                  //    那等於免費告訴攻擊者有哪些欄位可以探測。
                  //    只給「你打的這個字最接近哪一個」（03 章 3.9.4）。
                  "didYouMean", DidYouMean.closest(field, List.copyOf(allowed))),
              new Object[0],
              List.of());
    }

    /** ★ 已知但禁止排序的欄位 —— 見上方 javadoc。 */
    private static boolean knownButForbidden(String field) {
        return SENSITIVE_SORT_FIELDS.contains(field);
    }

    private static final Set<String> SENSITIVE_SORT_FIELDS = Set.of(
            "internalCostPrice", "margin", "supplierId", "customerLifetimeValue");
}
```

⚠️ **`ValueMasker.mask("sort", field)` 這一層不可以省。**
`field` 直接來自查詢參數，把它原封不動放進回應就是
03 章 3.11.2 的反射式資訊洩漏（也可能是 log injection，04 章 4.5.4）。
`ValueMasker.mask` 會截斷過長的值並對敏感欄位名回傳 `***`（3.9.5）。

⚠️ **而 `detail` 裡刻意完全不含 `field`** ——
03 章 3.11.2 的規則是「`detail` 給開發者看，但仍然會進日誌與 APM」，
所以使用者輸入只放在**被遮蔽過的 extensions** 裡。

**④ `InvalidWebhookSignatureException`：webhook 驗簽（1.6.6）**

```java
package example.shop.common.web;

import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;

/**
 * webhook 的簽章驗證失敗。
 *
 * <p>★★ 三個刻意的設計：
 *
 * <p><b>① 沒有任何 extensions。</b>
 * 不告訴對方「簽章長度不對」還是「時間戳過期」——
 * 那是在幫攻擊者除錯。
 *
 * <p><b>② 用 {@code INVALID_TOKEN}（401）而不是 403。</b>
 * 401 的語意是「你沒有提供有效的憑證」，而簽章就是憑證。
 * 403 的語意是「憑證有效但權限不足」—— 不適用。
 *
 * <p><b>③ ⚠️ 它是 06 章 6.5.8「webhook 不要回 4xx」的一個例外。</b>
 * 那一節說的是「**內容**看不懂時不要回 4xx，
 * 否則對方（金流商）會停用整個 endpoint」。
 * 但**簽章錯誤**必須回 401 —— 因為那代表
 * 「這個請求不是對方送的」，而讓它靜默通過才是真正的危險。
 *
 * <p>判準：<b>「這個請求是不是對方送的」→ 4xx；
 * 「對方送的東西我看不懂」→ 200 + 記錄 + 告警。</b>
 */
public class InvalidWebhookSignatureException extends BusinessException {

    public InvalidWebhookSignatureException() {
        // ⚠️ detail 是固定字串，不含任何請求內容
        super(ErrorCode.INVALID_TOKEN, "Webhook signature verification failed.");
    }
}
```

⚠️ **驗簽的兩個必要條件，比例外本身重要**：

| 條件 | 為什麼 |
|---|---|
| **用原始 bytes 比對**（1.6.6） | 反序列化再重新序列化會改變欄位順序與空白 |
| **用 `MessageDigest.isEqual` 而不是 `equals`** | 常數時間比較，避免時序攻擊 |

```java
// 🔴 錯：String.equals 會在第一個不同的字元就返回 → 可以用時間差逐字元猜出簽章
if (!expectedSignature.equals(providedSignature)) { ... }

// ✅ 對：常數時間比較
if (!java.security.MessageDigest.isEqual(
        expectedSignature.getBytes(StandardCharsets.UTF_8),
        providedSignature.getBytes(StandardCharsets.UTF_8))) { ... }
```

---

## 1.13 常見誤區

**誤區 1：「`@RequestParam` 不寫名稱比較簡潔」**

```java
@RequestParam Integer page       // 依賴 -parameters 編譯選項
```

Spring 6.1 起這在缺少編譯選項時**直接失敗**。而且 IDE 重構改參數名時，
API 的參數名會**跟著改** —— 你只是想把 `page` 改成 `pageNumber` 讓程式碼好讀，
結果破壞了 API 契約。

👉 一律寫名稱。**方法參數名是實作細節，API 參數名是契約，兩者不該綁在一起。**

**誤區 2：「`required = false` 就安全了」**

`required = false` + 原生型別 = 500（1.5.1）。而且 `null` 會往下傳，
Service 裡就要處理 null。
👉 用 `defaultValue`，或綁成物件在 compact constructor 裡給預設值。

**誤區 3：「查詢參數的驗證交給 Service 就好」**

Service 當然要驗（0.7 問題 3：兩層都要）。
但 Controller 不驗的代價是：`?size=999999999` 會一路走到 Repository 才失敗，
中間佔用了連線池。**便宜的驗證要放在便宜的地方。**

**誤區 4：「Jackson 會自動處理所有型別」**

Jackson 對 `record`、`Optional`（需 `Jdk8Module`）、`java.time`（需 `JavaTimeModule`）
的支援都需要對應的 module。Spring Boot 的自動組態幫你註冊了大部分，
但 `JsonNullable` 要自己註冊（1.6.4），自訂型別也要。

👉 **驗證方式**：寫一個測試把每個 DTO 序列化再反序列化，比對是否相等（07 章 7.9）。

**誤區 5：「路徑越 RESTful 越好，所以要巢狀很深」**

```
❌ /customers/{cid}/orders/{oid}/items/{iid}/reviews/{rid}
```

03-rest-api 第 01 章 1.6 的規則：**巢狀最多兩層**。
更深的用頂層資源 + 查詢參數。實作層的理由也很實在：
四個 `@PathVariable` 意味著四個都要驗證、四個都要檢查歸屬關係
（這個 item 真的屬於這個 order 嗎？這個 order 真的屬於這個 customer 嗎？）
—— 而漏掉任何一個就是 IDOR 漏洞。

**誤區 6：「`@RequestBody Map<String,Object>` 比較靈活」**

它「靈活」的代價是：沒有驗證、沒有文件、沒有型別安全、
mass assignment 全開、每個欄位都要手動轉型（而轉型失敗是 `ClassCastException` → 500）。
0.3 那段程式碼的第一個問題就是這個。

**誤區 7：「回應直接回 `Map.of(...)` 很方便」**

```java
return Map.of("orderId", id, "status", "PAID");     // ❌
```

- OpenAPI 產不出 schema。
- 打錯 key（`orderid`）不會編譯錯誤。
- `Map.of` 不接受 `null` 值 —— **`Map.of("cancelledAt", null)` 會拋 NPE**，
  而「這個欄位有時是 null」是很常見的需求。
- 欄位順序不固定（`Map.of` 是無序的），造成回應的 diff 難讀、快取的 ETag 不穩定。

**誤區 8：「`@ResponseStatus` 和 `ResponseEntity` 可以混用」**

```java
@ResponseStatus(HttpStatus.CREATED)                      // ← 被忽略
public ResponseEntity<Foo> create() {
    return ResponseEntity.ok(foo);                       // ← 這個贏，回 200
}
```

`ResponseEntity` 裡的狀態碼**覆蓋** `@ResponseStatus`。
混用只會讓讀程式碼的人搞錯。二選一。

---

## 1.14 本章練習

### 練習 1：預測綁定結果

給定這個方法，預測 8 種請求的結果（值或錯誤）：

```java
@RestController
@RequestMapping("/items")
public class ItemController {

    @GetMapping("/{sku}")
    public String get(@PathVariable("sku") String sku,
                      @RequestParam(name = "qty", required = false) int qty,
                      @RequestParam(name = "tags", required = false) List<String> tags,
                      @RequestParam(name = "size", defaultValue = "20") Integer size,
                      @RequestParam(name = "type") ItemType type) {
        return sku + "/" + qty + "/" + tags + "/" + size + "/" + type;
    }
}

enum ItemType { PHYSICAL, DIGITAL }
```

| # | 請求 |
|---|---|
| 1 | `GET /items/ABC?type=PHYSICAL` |
| 2 | `GET /items/ABC?type=PHYSICAL&qty=3` |
| 3 | `GET /items/ABC?type=physical&qty=3` |
| 4 | `GET /items/ABC?type=PHYSICAL&qty=3&tags=a,b` |
| 5 | `GET /items/ABC?type=PHYSICAL&qty=3&tags=a&tags=b` |
| 6 | `GET /items/ABC?type=PHYSICAL&qty=3&size=` |
| 7 | `GET /items/ABC.json?type=PHYSICAL&qty=3` |
| 8 | `GET /items/ABC/?type=PHYSICAL&qty=3` |

<details>
<summary>解答</summary>

| # | 結果 | 說明 |
|---|---|---|
| 1 | **500** | `required=false` + `int qty` → `IllegalStateException`（1.5.1 的坑 ②）。**這是本題重點** |
| 2 | `ABC/3/null/20/PHYSICAL` | `tags` 沒送 → `null`（不是空 list） |
| 3 | **400** | 列舉大小寫敏感 → `MethodArgumentTypeMismatchException`（1.9.2） |
| 4 | `ABC/3/[a, b]/20/PHYSICAL` | 逗號自動切割 |
| 5 | `ABC/3/[a, b]/20/PHYSICAL` | 重複 key 也是兩個值。**注意 4 和 5 結果相同** |
| 6 | `ABC/3/null/20/PHYSICAL` | `?size=` 空字串 → **`defaultValue` 仍然生效** → `size = 20`。<br>★ 見下方說明：`AbstractNamedValueMethodArgumentResolver` 對「空字串 + 有 defaultValue」有一個專門的分支 |
| 7 | `ABC.json/3/null/20/PHYSICAL` | Boot 3 不再截斷後綴（1.4.4） |
| 8 | **404** | 尾斜線不再自動比對（1.3.5） |

**第 6 題是最容易答錯的**，而**答錯的方向通常是「以為 `defaultValue` 不涵蓋空字串」**。
實際上 `AbstractNamedValueMethodArgumentResolver.resolveArgument()` 有**兩個**分支：

```java
// AbstractNamedValueMethodArgumentResolver.resolveArgument()（節錄）
Object arg = resolveName(resolvedName.toString(), nestedParameter, webRequest);
if (arg == null) {
    if (namedValueInfo.defaultValue != null) {                     // ① 參數缺席
        arg = resolveEmbeddedValuesAndExpressions(namedValueInfo.defaultValue);
    }
    else if (namedValueInfo.required && !nestedParameter.isOptional()) {
        handleMissingValue(namedValueInfo.name, nestedParameter, webRequest);
    }
    arg = handleNullValue(namedValueInfo.name, arg, nestedParameter.getNestedParameterType());
}
else if ("".equals(arg) && namedValueInfo.defaultValue != null) {   // ★★ ② 參數存在但是空字串
    arg = resolveEmbeddedValuesAndExpressions(namedValueInfo.defaultValue);
}
// ↑ 兩個分支都在【轉型之前】就把值換成 defaultValue，所以 ConversionService 收到的是 "20"
```

**所以 `?size=` 得到 `20`，`?size` 也得到 `20`（`getParameter` 回 `""`）。**

⚠️ **但這只涵蓋「有寫 `defaultValue`」的情況。** 沒寫的話：

| 宣告 | `?size=`（空字串） |
|---|---|
| `@RequestParam(defaultValue = "20") Integer size` | **`20`** ★ |
| `@RequestParam(required = false) Integer size` | **`null`**（`""` 進 `ConversionService` → `StringToNumber` 對空字串回 `null`） |
| `@RequestParam(required = false) int size` | **500** —— `handleNullValue` 對原始型別拋 `IllegalStateException`（坑 ②） |
| `@RequestParam(required = false) String size` | **`""`**（不是 `null`！字串不需要轉換） |

★ **最後一列是實務上最常出錯的**：一個 `required=false` 的 `String` 參數，
「沒送」是 `null`、「送了空的」是 `""` ——
而 `if (keyword != null)` 這種檢查會讓 `?keyword=` 進到 `WHERE name LIKE '%%'`。
👉 **所以 shop-service 的字串參數一律綁成物件，並在 compact constructor 裡
`trimToNull()`（1.7.2）。**

**修正版**：

```java
@GetMapping("/{sku}")
public String get(@PathVariable("sku") @Size(max = 64) String sku,
                  @RequestParam(name = "qty", defaultValue = "1") Integer qty,
                  @RequestParam(name = "tags", required = false) List<String> tags,
                  @RequestParam(name = "size", defaultValue = "20") Integer size,
                  @RequestParam(name = "type") @NotBlank String type) {
    var safeTags = (tags == null) ? List.<String>of() : tags;
    var safeSize = (size == null) ? 20 : size;
    // type 用 String 收，在 mapper 轉 enum（1.9.2 的決定）
}
```

**更好的版本**：全部綁成一個 record（1.7.2）。

</details>

### 練習 2：修正路由

以下 6 條路由宣告各有問題，請指出並修正：

```java
// (1)
@RequestMapping("/orders/create")
public ... create(@RequestBody CreateOrderRequest r) { }

// (2)
@GetMapping("/orders/{orderId}")
public ... get(@PathVariable String orderId) { }
@GetMapping("/orders/export")
public ... export() { }

// (3)
@PostMapping("/orders")
public ... create(@RequestBody Order order) { }

// (4)
@GetMapping(value = "/orders", params = "status")
public ... byStatus(@RequestParam String status) { }

// (5)
@DeleteMapping("/orders/{orderId}")
@ResponseStatus(HttpStatus.NO_CONTENT)
public ResponseEntity<Map<String,String>> delete(@PathVariable String orderId) {
    return ResponseEntity.ok(Map.of("msg", "deleted"));
}

// (6)
@GetMapping("/orders/{orderId}/items/{itemId}")
public ... item(@PathVariable String orderId, @PathVariable String itemId) {
    return itemRepository.findById(itemId);
}
```

<details>
<summary>解答</summary>

**(1) 三個問題**

- `@RequestMapping` 沒指定 method → **接受所有方法**（`GET /orders/create` 也會進來，
  而它有 `@RequestBody` → `GET` 沒 body → 400）。
- URL 有動詞 `create`（03-rest-api 第 01 章）。
- 沒有 `consumes`。

```java
@PostMapping(path = "/orders", consumes = MediaType.APPLICATION_JSON_VALUE)
public ResponseEntity<CreateOrderResponse> create(@Valid @RequestBody CreateOrderRequest r) { }
```

**(2) 路由「碰巧」正確但很脆弱**

`/orders/export` 是字面值，比 `/orders/{orderId}` 具體，所以能正常工作。
但（1.3.4）`GET /orders/Export` 會落到 `{orderId}`，錯誤訊息變成「訂單 Export 不存在」。

而且 `export` 是動詞。改成頂層資源：

```java
@PostMapping("/order-exports")                       // 建立匯出工作 → 202
public ResponseEntity<ExportJobResponse> create(...) { }

@GetMapping("/order-exports/{exportId}")             // 查進度
public ExportJobResponse get(@PathVariable("exportId") String exportId) { }
```

**(3) mass assignment**

`@RequestBody Order`（Entity）→ 客戶端可以送 `status`、`totalAmount`、`customerId`。
改用 `CreateOrderRequest`（1.6.2）。

**(4) `params` 分派會讓沒帶參數的請求回 400**

```
GET /orders          → 400 UnsatisfiedServletRequestParameterException（1.3.2）
                       ⚠️ 而它的訊息是「Parameter conditions "cursor" OR "page" not met」——
                          客戶端看不出「所以我到底該送什麼」
```

改成一個方法 + 可選參數（或綁成 `OrderFilter`）：

```java
@GetMapping("/orders")
public PageResponse<OrderSummary> list(@Valid @ModelAttribute OrderFilter filter) { }
```

**(5) `@ResponseStatus` 被忽略 + 204 帶 body**

`ResponseEntity.ok(...)` 覆蓋了 `@ResponseStatus(NO_CONTENT)` → 實際回 **200**。
而且如果真的回 204 就不能有 body。

而且更根本的問題：**shop-service 沒有 `DELETE /orders/{id}`**
（03-rest-api 第 01 章 1.14.3：訂單永不刪除）。取消訂單是 `POST /orders/{id}/cancellations`。

如果真的要一個 delete 端點（例如刪地址）：

```java
@DeleteMapping("/me/addresses/{addressId}")
@ResponseStatus(HttpStatus.NO_CONTENT)
public void delete(@PathVariable("addressId") @Size(max = 64) String addressId,
                   @AuthenticationPrincipal CurrentUser user) {
    addressService.delete(addressId, user.actor());
}
```

**(6) 兩個嚴重問題**

**問題 A：`orderId` 完全沒被使用 → IDOR 漏洞。**

```java
GET /orders/我的訂單/items/別人的itemId
→ itemRepository.findById(別人的itemId) → 回傳別人的訂單明細
```

路徑上的 `orderId` 只是裝飾。**巢狀路徑必須驗證歸屬關係。**

**問題 B：直接注入 Repository 並回傳 Entity**（0.6.3、0.6.8）。

```java
@RestController
@RequestMapping(path = "/orders/{orderId}/items", produces = APPLICATION_JSON_VALUE)
@Validated
public class OrderItemController {

    private final OrderService orderService;
    private final OrderWebMapper mapper;
    // 建構子…

    @GetMapping("/{itemId}")
    public OrderItemResponse item(@PathVariable("orderId") @Size(max = 64) String orderId,
                                  @PathVariable("itemId") @Size(max = 64) String itemId,
                                  @AuthenticationPrincipal CurrentUser user) {
        // ★ Service 內部驗證：item 屬於 order，且 order 屬於（或可被）actor 存取
        return mapper.toItemResponse(orderService.findItem(orderId, itemId, user.actor()));
    }
}
```

**Service 的簽章把 `orderId` 變成必要參數**，於是「忘記驗證歸屬」在編譯期就不可能發生。
**這是分層帶來的安全性，不只是整潔。**

</details>

### 練習 3：設計 `GET /products` 的參數綁定

需求（依 03-rest-api 第 05 章的規格）：

```
GET /products
  ?q=耳機                      全文搜尋
  &categoryId=cat_1,cat_2      多選分類
  &minPrice=500&maxPrice=2000  價格區間
  &inStock=true                只看有庫存
  &brand=SONY&brand=BOSE       多選品牌
  &tag=noise-cancelling        標籤（可多個）
  &sort=price,asc              排序（白名單：price、rating、salesCount、createdAt）
  &page=0&size=24
  &lang=zh-TW                  回應語言
```

規則：
- `size` 上限 48（商品列表一頁最多 48 個）。
- `minPrice` 不可大於 `maxPrice`。
- `q` 最短 2 個字（1 個字的搜尋會掃全表）。
- `q` 與 `categoryId` 至少要有一個（避免無條件掃全表）。
- 價格是 `BigDecimal`，最多 2 位小數。

請寫出 `ProductFilter` record（含全部驗證），以及 Controller 方法。

<details>
<summary>解答</summary>

```java
package example.shop.product.web.dto;

import example.shop.common.validation.SortWhitelist;
import jakarta.validation.constraints.*;

import java.math.BigDecimal;
import java.util.List;
import java.util.Locale;

public record ProductFilter(

    @Size(min = 2, max = 100, message = "搜尋關鍵字須為 2～100 字")
    String q,

    List<@Size(max = 64) @Pattern(regexp = "^[A-Za-z0-9_-]+$") String> categoryId,

    @DecimalMin(value = "0", message = "價格不可為負")
    @Digits(integer = 10, fraction = 2, message = "價格最多 2 位小數")
    BigDecimal minPrice,

    @DecimalMin(value = "0", message = "價格不可為負")
    @Digits(integer = 10, fraction = 2, message = "價格最多 2 位小數")
    BigDecimal maxPrice,

    Boolean inStock,

    List<@Size(max = 32) @Pattern(regexp = "^[A-Z0-9_-]+$") String> brand,

    List<@Size(max = 48) @Pattern(regexp = "^[a-z0-9-]+$") String> tag,

    @SortWhitelist({"price", "rating", "salesCount", "createdAt"})
    String sort,

    @Min(value = 0, message = "page 不可小於 0") Integer page,

    @Min(value = 1, message = "size 最小為 1")
    @Max(value = 48, message = "商品列表一頁最多 48 筆") Integer size,

    @Pattern(regexp = "^[a-z]{2}(-[A-Z]{2})?$", message = "語言代碼格式錯誤")
    String lang

) {
    public static final String DEFAULT_SORT = "salesCount,desc";
    public static final int DEFAULT_SIZE = 24;
    public static final int MAX_OFFSET = 10_000;

    public ProductFilter {
        q          = blankToNull(q);
        categoryId = normalize(categoryId);
        brand      = normalizeUpper(brand);
        tag        = normalizeLower(tag);
        sort       = (sort == null || sort.isBlank()) ? DEFAULT_SORT : sort.trim();
        page       = (page == null) ? 0 : page;
        size       = (size == null) ? DEFAULT_SIZE : size;
        inStock    = (inStock != null) && inStock;
        lang       = (lang == null || lang.isBlank()) ? "zh-TW" : lang.trim();
    }

    // ── 跨欄位驗證 ────────────────────────────────────

    @AssertTrue(message = "minPrice 不可大於 maxPrice")
    public boolean isPriceRangeValid() {
        return minPrice == null || maxPrice == null || minPrice.compareTo(maxPrice) <= 0;
    }

    @AssertTrue(message = "請提供搜尋關鍵字或選擇分類")
    public boolean isScopeProvided() {
        return q != null || !categoryId.isEmpty();
    }

    @AssertTrue(message = "查詢範圍過深，請縮小條件")
    public boolean isOffsetWithinLimit() {
        return (long) page * size <= MAX_OFFSET;
    }

    // ── 便利方法 ─────────────────────────────────────

    public java.util.Locale locale() { return Locale.forLanguageTag(lang); }
    public int offset() { return page * size; }

    private static List<String> normalize(List<String> v) {
        return (v == null) ? List.of()
                : v.stream().filter(s -> s != null && !s.isBlank())
                   .map(String::trim).distinct().limit(20).toList();     // ★ 上限 20 個
    }
    private static List<String> normalizeUpper(List<String> v) {
        return normalize(v).stream().map(s -> s.toUpperCase(Locale.ROOT)).toList();
    }
    private static List<String> normalizeLower(List<String> v) {
        return normalize(v).stream().map(s -> s.toLowerCase(Locale.ROOT)).toList();
    }
    private static String blankToNull(String s) {
        return (s == null || s.isBlank()) ? null : s.trim();
    }
}
```

```java
package example.shop.product.web;

@RestController
@RequestMapping(path = "/products", produces = MediaType.APPLICATION_JSON_VALUE)
@Validated
public class ProductController {

    private final ProductService productService;
    private final ProductWebMapper mapper;

    public ProductController(ProductService productService, ProductWebMapper mapper) {
        this.productService = productService;
        this.mapper = mapper;
    }

    @GetMapping
    public PageResponse<ProductSummary> list(@Valid @ModelAttribute ProductFilter filter,
                                             @AuthenticationPrincipal CurrentUser user) {
        return mapper.toPage(productService.search(mapper.toSearchQuery(filter, user.actor())),
                             filter);
    }
}
```

**五個設計決策的理由**：

| 決策 | 理由 |
|---|---|
| **`.limit(20)` 在正規化裡** | `?brand=A&brand=B&…`（送 5,000 個）會產生 `IN (5000 個值)` 的 SQL，MySQL 的查詢計畫會崩。上限要在 Controller 擋（03-rest-api 5.11 的第一層防護） |
| **`isScopeProvided()`** | 「無條件列出全部商品」在 100 萬筆的表上就是一次全表掃描。這條規則把它變成 422 而不是 30 秒的逾時 |
| **`q` 最短 2 字** | 單字搜尋（如「機」）幾乎等於全表掃描，而且結果對使用者也沒用 |
| **`lang` 用 `@Pattern` 而不是 `Locale`** | `Locale` 綁定對無效值不會報錯（`Locale.forLanguageTag("xxx")` 回 `Locale("xxx")` 不拋例外），會靜默變成錯誤的語言。用 `String` + `@Pattern` 才擋得住 |
| **`tag` 限制 `^[a-z0-9-]+$`** | tag 用在 URL 與 CSS class 上，限制字元集避免注入 |

⚠️ **`isOffsetWithinLimit()` 放在 `@AssertTrue` 而不是 compact constructor 拋例外**（對照 1.10.3 的 `PageQuery`）。
兩種做法都可以，差別是：
- compact constructor 拋例外 → 綁定階段失敗，錯誤訊息由你的例外決定。
- `@AssertTrue` → 進入驗證階段，會和其他驗證錯誤**一起回報**（前端可以一次看到全部問題）。

**shop-service 偏好 `@AssertTrue`**，因為「一次回全部錯誤」對前端更友善
（03-rest-api 第 04 章 4.6 的原則）。

</details>

### 練習 4：找出這個 Controller 的 9 個問題

```java
@Controller
@RequestMapping("/api/v1/cart")
public class CartController {

    @Autowired
    private CartRepository cartRepository;

    @RequestMapping("/items/add")
    public Map<String, Object> add(@RequestBody Map<String, Object> body,
                                   HttpSession session) {
        String customerId = (String) session.getAttribute("cid");
        String productId = (String) body.get("productId");
        int qty = (int) body.get("qty");

        Cart cart = cartRepository.findByCustomerId(customerId);
        cart.addItem(productId, qty);
        cartRepository.save(cart);

        Map<String, Object> r = new HashMap<>();
        r.put("code", 0);
        r.put("data", cart);
        return r;
    }

    @GetMapping("/items")
    public List<CartItem> items(@RequestParam(required = false) int page,
                                @RequestParam String sort,
                                HttpSession session) {
        return cartRepository.findByCustomerId((String) session.getAttribute("cid"))
                             .getItems();
    }
}
```

<details>
<summary>解答</summary>

| # | 問題 | 後果 | 修正 |
|---|---|---|---|
| 1 | `@Controller` 而非 `@RestController` | 回傳值被當 view 名稱 → 500「Circular view path」或 404 | `@RestController` |
| 2 | `@RequestMapping("/items/add")` 沒指定 method | `GET` 也能進來，但有 `@RequestBody` → 400；URL 有動詞 | `@PostMapping("/carts/current/items")` |
| 3 | `@Autowired` 注入 Repository 到 Controller | 0.6.3、0.6.8 | 注入 `CartService` 介面，建構子注入 |
| 4 | `@RequestBody Map<String,Object>` | 無驗證、無文件、`(int) body.get("qty")` 在值是 `"3"`（字串）或 `3.0`（double）時拋 `ClassCastException` → **500** | `AddCartItemRequest` record + `@Valid` |
| 5 | 從 `HttpSession` 取登入者 | 0.6.7；且 `session.getAttribute` 回 `null` 時 → `findByCustomerId(null)` → 行為未定義 | `@AuthenticationPrincipal CurrentUser user` |
| 6 | `cart` 可能是 `null` | 第一次加入購物車的使用者 → `cart.addItem()` → **NPE → 500** | Service 負責「沒有就建立」 |
| 7 | 回 `Map` + `code: 0` 包裝 | 03-rest-api 第 03 章 3.9：狀態碼在 HTTP 層，不在 body | 回 `CartResponse`，狀態碼用 `@ResponseStatus` / `ResponseEntity` |
| 8 | 回傳 Entity（`Cart`、`List<CartItem>`） | 洩漏欄位、lazy 載入例外、欄位改名炸前端 | `CartResponse` / `PageResponse<CartItemResponse>` |
| 9 | `@RequestParam(required=false) int page` | **500**（1.5.1 的坑 ②）；而且 `page` 和 `sort` 根本沒被使用 | 移除，或綁成 `PageQuery` 並真的用它 |

**額外三個（送你）**：

| # | 問題 |
|---|---|
| 10 | `@RequestParam String sort` 是 `required=true` → 前端不帶 `sort` 就 **400**，但這是個列表端點，`sort` 應該有預設值 |
| 11 | 沒有 `@Transactional` 也沒在 Service 裡 → `findByCustomerId` 與 `save` 之間有 race condition（兩個 tab 同時加入商品 → 一個被覆蓋） |
| 12 | `/api/v1` 前綴寫在 Controller 上（1.3.7） |

**修正後**：

```java
package example.shop.cart.web;

import example.shop.cart.service.CartService;
import example.shop.cart.web.dto.*;
import example.shop.common.web.PageResponse;
import example.shop.security.CurrentUser;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping(path = "/carts/current/items", produces = MediaType.APPLICATION_JSON_VALUE)
@Validated
public class CartItemController {

    private final CartService cartService;
    private final CartWebMapper mapper;

    public CartItemController(CartService cartService, CartWebMapper mapper) {
        this.cartService = cartService;
        this.mapper = mapper;
    }

    /** 加入商品；同商品則累加數量（冪等性見 03-rest-api 1.14.2）。 */
    @PostMapping(consumes = MediaType.APPLICATION_JSON_VALUE)
    @ResponseStatus(HttpStatus.CREATED)
    public CartResponse add(@Valid @RequestBody AddCartItemRequest request,
                            @AuthenticationPrincipal CurrentUser user) {
        return mapper.toResponse(
                cartService.addItem(mapper.toAddItemCommand(request, user.actor())));
    }

    @GetMapping
    public PageResponse<CartItemResponse> list(@Valid @ModelAttribute CartItemFilter filter,
                                               @AuthenticationPrincipal CurrentUser user) {
        return mapper.toItemPage(cartService.findItems(
                mapper.toItemQuery(filter, user.actor())));
    }

    @PatchMapping(path = "/{itemId}", consumes = MediaType.APPLICATION_JSON_VALUE)
    public CartResponse updateQuantity(@PathVariable("itemId") @Size(max = 64) String itemId,
                                       @Valid @RequestBody UpdateCartItemRequest request,
                                       @AuthenticationPrincipal CurrentUser user) {
        return mapper.toResponse(cartService.updateItemQuantity(
                mapper.toUpdateItemCommand(itemId, request, user.actor())));
    }

    @DeleteMapping("/{itemId}")
    public CartResponse remove(@PathVariable("itemId") @Size(max = 64) String itemId,
                               @AuthenticationPrincipal CurrentUser user) {
        // ★ 回 200 + 更新後的購物車（不是 204），因為前端需要新的金額
        return mapper.toResponse(cartService.removeItem(itemId, user.actor()));
    }

    /** 清空所有項目（保留購物車本體）。 */
    @DeleteMapping
    public CartResponse clear(@AuthenticationPrincipal CurrentUser user) {
        return mapper.toResponse(cartService.clearItems(user.actor()));
    }
}
```

```java
public record AddCartItemRequest(
    @NotBlank(message = "請指定商品")
    @Size(max = 64)
    @Pattern(regexp = "^[A-Za-z0-9_-]+$", message = "商品識別碼格式錯誤")
    String productId,

    @NotNull(message = "請指定數量")
    @Min(value = 1, message = "數量最少 1")
    @Max(value = 999, message = "單項數量最多 999")
    Integer quantity
) {}
```

</details>

---

## 1.15 驗收清單

- [ ] 我知道 `@RestController` = `@Controller` + `@ResponseBody`，也知道漏掉 `@ResponseBody` 會出現「Circular view path」或 404。
- [ ] 我知道 Spring 自動處理 `HEAD` 與 `OPTIONS`，也知道 `HEAD` 會真的執行方法。
- [ ] 我能說出 `consumes` 不符回 415、`produces` 不符回 406、**`params` 不符回 400**（`UnsatisfiedServletRequestParameterException`）、**`headers` 不符回 404**，也知道為什麼這兩個不一樣（`handleNoMatch` 只有 params 的分支）。
- [ ] 我知道為什麼要明確寫 `consumes` / `produces`（文件、分派、以及「加了 XML converter 就意外支援 XML」的安全問題）。
- [ ] 我能說出路由衝突的排序規則，並知道字面值比路徑變數具體。
- [ ] 我知道 Spring Boot 3 的尾斜線不再自動比對，並選定了一種處理方式。
- [ ] 我知道 `PathPatternParser` 不支援 `**` 在模式中間。
- [ ] 我一律明確寫 `@PathVariable("name")` / `@RequestParam("name")`，並知道 Spring 6.1 移除了參數名稱推斷的 fallback。
- [ ] 我知道 `@RequestParam(required = false) int` 會回 **500**，而且開發時測不出來。
- [ ] 我知道 `defaultValue` 對「參數缺席」與「值是空字串」**兩種情況都生效**，也知道沒寫 `defaultValue` 時空字串會變成 `null`（包裝型別）、`""`（字串）或 500（原始型別）。
- [ ] 我知道 `@RequestParam List<String>` 沒送時是 `null` 而不是空 list。
- [ ] 我知道逗號會被自動切割，也知道這對「值含逗號」的參數是 bug。
- [ ] 我知道 `@RequestParam Map<String,String>` 是反模式，唯一用途是做未知參數檢查。
- [ ] 我能區分 `HttpMessageNotReadableException`（語法，400）與 `MethodArgumentNotValidException`（語意，422）。
- [ ] 我知道 Jackson 對 `record` 的四個支援細節，包含「不需要 `-parameters`」。
- [ ] 我會用 compact constructor 做正規化，也知道它在驗證**之前**執行。
- [ ] 我知道 `record` 不適合三種情況，並會用 `sealed interface` + `@JsonTypeInfo` 做多型 DTO。
- [ ] 我能用 `JsonNullable` 表達 `PATCH` 的三態，也知道 `isPresent()` 問的是「有沒有出現」。
- [ ] 我知道 `fail-on-unknown-properties: true` 的好處與三個代價。
- [ ] 我知道 webhook 驗簽必須用**原始 body**，不能反序列化再重新序列化。
- [ ] 我能把 14 個查詢參數綁成一個 record，並在裡面做正規化與跨欄位驗證。
- [ ] 我知道 record 的 constructor binding 需要 Spring 6.1（Boot 3.2）+。
- [ ] 我知道 `@AssertTrue` 產生的 `field` 是屬性名，前端無法定位，02 章要修。
- [ ] 我知道 Spring 不檢查未知的查詢參數，也知道自己做的方式與「先觀察再強制」的上線流程。
- [ ] 我知道方法參數上的 `@NotBlank` 需要類別上有 `@Validated`。
- [ ] 我知道 Spring 6.1 起方法參數驗證失敗是 `HandlerMethodValidationException`（400），不再是 500。
- [ ] 我用常數管理 header 名稱，並知道讀取不分大小寫但寫入會。
- [ ] 我知道設 cookie 要有 `HttpOnly` / `Secure` / `SameSite`，也知道 `SameSite=Strict` 會弄丟購物車。
- [ ] 我知道查詢參數走 `ConversionService`、body 走 Jackson，**兩者完全獨立**。
- [ ] 我知道列舉綁定大小寫敏感，也知道 shop-service 為什麼「請求方向用 String 收」。
- [ ] 我知道自訂 `Converter` 必須處理空字串、必須有長度上限、不能透傳原始例外訊息。
- [ ] 我知道 `@InitBinder` 幾乎已被 `Converter` 取代，剩下的用途是 `setDisallowedFields`。
- [ ] 我知道 `Pageable` 需要 spring-data-commons，也知道它的三個坑（靜默夾取、無白名單、自動 count）。
- [ ] 我能寫出自己的 `PageQuery` + `SortSpec`，並知道白名單裡是 API 欄位名而非資料庫欄位名。
- [ ] 我能在「直接回 DTO」、「`@ResponseStatus`」、「`ResponseEntity`」之間做選擇。
- [ ] 我知道 `ResponseEntity` 的狀態碼會覆蓋 `@ResponseStatus`。
- [ ] 我知道 204 不能帶 body，也知道 `return null` 不會變成 204。
- [ ] 我知道 `fromCurrentRequest()` 在反向代理後會產生錯的 host，也知道 `ForwardedHeaderFilter` 與它的安全前提。
- [ ] 我知道回應集合一定要包外殼，因為「陣列 → 物件」是破壞性變更。
- [ ] 我知道巢狀路徑上的每一個 `@PathVariable` 都必須參與歸屬驗證，否則就是 IDOR。

---

## 1.16 下一章預告

參數已經綁進來了，但綁進來的東西**還沒被驗證過**。
02 章要處理輸入驗證，包括：

- Bean Validation 的完整註解清單，以及**每個註解對 `null` 的行為**（這是最多 bug 的地方）。
- 巢狀驗證、集合元素驗證、`Map` 的 key/value 驗證。
- 驗證群組（`@Validated(OnCreate.class)`）：同一個 DTO 在 `POST` 與 `PATCH` 有不同必填欄位。
- 自訂驗證器：`@SortWhitelist`、`@ValidInvoice`、`@ValidTaiwanId`。
- **類別層級驗證怎麼產生正確的 `field`**（`addPropertyNode()`）—— 修正 1.7.2 的問題。
- `BindingResult` 的完整結構，以及怎麼把它變成 03-rest-api 第 04 章的 `errors[]` 格式。
- 驗證訊息的 i18n 與參數插值。
- **驗證的分階段策略**：便宜的先做，需要查資料庫的後做。
- 為什麼「驗證要有測試」，以及怎麼用參數化測試涵蓋 200 個邊界值。

---

完成後請前往 [02-validation-and-binding-errors.md](./02-validation-and-binding-errors.md)。
