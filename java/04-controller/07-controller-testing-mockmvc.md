# 第 07 章：Web 層測試 —— MockMvc、切片與契約

> 前六章把 shop-service 的 Web 層做完了：路由、綁定、驗證、錯誤格式、
> 追蹤、檔案、串流、CORS、序列化。
>
> **這一章回答一個問題：你怎麼知道它們都是對的？**
>
> 而更精確的問題是：**你怎麼知道它們「明天」還是對的？**
>
> 因為 Web 層的程式碼有一個討厭的特性 ——
> 它的行為由**大量你沒寫的東西**決定：
> Jackson 的設定、filter 的順序、Security 的規則、內容協商的演算法、
> Servlet 容器的緩衝區大小。
>
> 這些東西沒有一個會在你改壞它的時候編譯失敗。
>
> ```
> 06 章 6.5.10：把 default-property-inclusion 從 non_null 改成 always
>               → 編譯通過、啟動成功、所有測試綠燈
>               → 三個 App 版本的欄位判斷邏輯全部失效
> ```
>
> **這一章要建立的，就是「讓那種改動變成紅燈」的一套測試。**

---

## 7.1 學習目標

完成本章後，你應該可以：

- 說出 Web 層測試的**四個層級**、各自的成本，以及**每一個 shop-service 元件該用哪一級**。
- 說明為什麼 Web 層的測試金字塔是**梯形**而不是三角形。
- 說出 `@WebMvcTest` **載入了什麼、沒載入什麼**，並用一個測試把它印出來驗證。
- **說明 `@WebMvcTest` 裡的 Security 行為與正式環境的差異**，以及 `addFilters = false` 造成的假綠燈 ★★
- 說明為什麼 `@WithMockUser` 設好了 `SecurityContext`，`CurrentActorArgumentResolver` 卻拿到 `null`。
- 解釋 Spring 的 **context 快取鍵**，並說出「測試突然變慢 10 倍」的三個原因。
- 熟練 MockMvc 的三段結構與完整的 matcher 地圖，包含 `jsonPath` 的六個陷阱。
- 用 `asyncDispatch` 測試 `StreamingResponseBody` 與 `CompletableFuture`（05 章）。
- **說出 MockMvc 與真實 Servlet 容器的 12 個行為差異**，以及每一個差異對應「要改用整合測試」的哪一類測試。
- 知道 **Spring 6.2 的 `MockMvcTester`**（AssertJ 風格），以及它在 Boot 3.2 基準上還不能用。
- **說出 `@MockBean` → `@MockitoBean` 的遷移**（Boot 3.4 起），以及本課程前幾章的一處需要修正的地方 ★
- 說出 mock 的三個陷阱，尤其是 **「沒 stub 就回 `null`」讓測試在測一件你沒想測的事**。
- 用 `ArgumentCaptor` 驗證「Controller 真的把 HTTP 翻譯對了」——**這是 Controller 測試的核心價值**。
- 說出「一個 `createOrder()` 輔助方法」為什麼會在第 40 個測試時崩塌，以及 Object Mother 與 Test Data Builder 的取捨。
- 用一個 `@MethodSource` 覆蓋 **83 個 `ErrorCode`**、所有 enum 值、所有端點。
- **設計授權矩陣測試**（70 個端點 × 5 種角色），並說明為什麼那是最值得寫的一組測試 ★★
- 寫一個「新端點忘記加授權就紅燈」的守門測試。
- 說明資源層級授權（IDOR）為什麼**不能**用授權矩陣涵蓋，以及要怎麼補。
- 用 `orders-api.yaml` 自動驗證實作（03-rest-api 第 07 章的落地）。
- 用 **Spring REST Docs** 讓「文件與測試是同一份東西」，並說出它與 springdoc 的分工。
- 列出**哪些東西 `@WebMvcTest` 測不到**，並為每一個給出整合測試的寫法。
- 指出 12 個測試反模式，尤其是**在測試裡重新實作被測邏輯**。
- 設計 CI 的測試分層，讓 3,000 個測試在 4 分鐘內跑完。
- 說出覆蓋率的正確用法，以及**突變測試**補的是什麼。

---

## 7.2 先看見痛：五個「測試全綠但線上壞掉」的事故

這五個事故有一個共同特徵：**它們都有測試**。
而且測試都是綠的。

### 7.2.1 事故一：350 個測試全綠，客戶看到別人的訂單

**時間**：上線後第 11 天。
**回報者**：一位客戶在客服信裡附了截圖 —— 訂單明細裡是別人的姓名、電話、地址。

**復現**：

```bash
# 客戶 A 的 token
TOKEN_A="eyJhbGci...customerA"

# 客戶 A 查自己的訂單 → 200，正確
curl -H "Authorization: Bearer $TOKEN_A" \
     https://api.shop.example/orders/ord_01J5GKA1

# 客戶 A 查別人的訂單 → 🔴 200，完整資料
curl -H "Authorization: Bearer $TOKEN_A" \
     https://api.shop.example/orders/ord_01J5GKB9
```

**當事人的第一反應**：「不可能，這個端點有測試。」

而測試確實有，還很完整：

```java
@WebMvcTest(OrderController.class)
@AutoConfigureMockMvc(addFilters = false)      // 🔴🔴 兇手在這一行
class OrderControllerTest {

    @Autowired MockMvc mockMvc;
    @MockBean OrderQueryService orderQueryService;

    @Test
    void 查詢訂單明細() throws Exception {
        when(orderQueryService.findDetail(eq("ord_01J5GKA1"), any()))
                .thenReturn(sampleDetail());

        mockMvc.perform(get("/orders/ord_01J5GKA1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.orderId").value("ord_01J5GKA1"))
                .andExpect(jsonPath("$.status").value("PAID"));
    }
    // ... 另外 349 個測試
}
```

**`addFilters = false` 是怎麼加上去的？**

翻 git log，那一行的 commit message 是：

```
commit 8a3f21c
    fix: 修掉測試的 401

    @WebMvcTest 會套用 Spring Security，所有測試都變成 401。
    加 addFilters = false 之後全部恢復綠燈。
```

**這個 commit 的每一句話都是事實。**
`@WebMvcTest` 會把 `springSecurityFilterChain` 套到 MockMvc 上，
沒有認證的請求就是 401，而 `addFilters = false` 確實會讓它們全部變綠。

**問題是它把「所有 filter」都關掉了**：

```
addFilters = false 關掉了：
  ✗ springSecurityFilterChain    ← 認證與授權，完全不測
  ✗ CorsFilter          (-200)   ← 06 章
  ✗ TraceIdFilter       (-121)   ← 04 章
  ✗ IpRateLimitFilter   (-119)   ← 04 章
  ✗ RequestSizeLimitFilter (-118)
  ✗ CachedBodyFilter    (-117)
  ✗ RequestLoggingFilter (-116)
  ✗ AuditFilter         (-115)
  ✗ IdempotencyFilter    (-99)
```

**於是 350 個測試測的是「一個沒有認證、沒有授權、沒有追蹤、沒有限流的 Controller」。**

而真正的 bug 在哪？在 Controller 裡：

```java
@GetMapping("/{orderId}")
public OrderDetail get(@PathVariable String orderId) {
    // 🔴 沒有把 actor 傳下去 —— Service 無從判斷「這是誰的訂單」
    return orderQueryService.findDetail(orderId);
}
```

**正確的版本**（04 章 4.10.2 的 `CurrentActorArgumentResolver` 就是為此存在的）：

```java
@GetMapping("/{orderId}")
public OrderDetail get(@PathVariable String orderId, @CurrentActor Actor actor) {
    return orderQueryService.findDetail(orderId, actor);   // ★
}
```

⚠️ **注意這個 bug 的性質**：它不是「授權規則寫錯了」，
而是**「授權所需的資訊根本沒有傳到能判斷的地方」**。

這種 bug 有兩個特徵讓它特別危險：

1. **`@WebMvcTest` + `addFilters = false` 永遠測不到它** ——
   因為 mock 的 `OrderQueryService` 對任何 `orderId` 都回傳 `sampleDetail()`。
2. **它是 OWASP API Security Top 10 的第一名**（API1:2023 Broken Object Level
   Authorization，也就是 IDOR）—— 不是罕見的 corner case，而是**最常見的 API 漏洞**。

**這一章的 7.9 節就是為了這個事故存在的。**

### 7.2.2 事故二：CI 從 4 分鐘變成 47 分鐘

**時間**：專案第 5 個月。
**症狀**：沒有人願意在本機跑完整測試了，大家直接 push 讓 CI 跑，
然後等 47 分鐘，然後發現紅燈，然後再 push。

**測試數量**：2,840 個。
**看起來的結論**：「測試太多了，要刪一些。」

**實際的量測** —— 在 `application-test.yml` 加一行：

```yaml
logging:
  level:
    org.springframework.test.context.cache: DEBUG
```

輸出：

```
Spring test ApplicationContext cache statistics:
  [DefaultContextCache@1a2b3c size = 32, maxSize = 32, parentContextCount = 0,
   hitCount = 2808, missCount = 89]
                                     ↑↑↑
```

**89 次 miss** = 建了 89 次 Spring context。
**而快取上限是 32** —— 超過就淘汰最舊的，被淘汰的下次還要再建。

```
89 次 × 平均 3.1 秒 = 276 秒  ≈ 4.6 分鐘（只算建 context）
```

那還不到 47 分鐘。真正的問題是**淘汰造成的連鎖重建**：

```
測試類別執行順序（Maven 預設是檔名順序）：
  A1Test  @WebMvcTest(OrderController)   + @MockBean OrderService              → context #1
  A2Test  @SpringBootTest                                                       → context #2
  A3Test  @WebMvcTest(OrderController)   + @MockBean OrderService, CartService  → context #3  ← 只多一個 mock
  A4Test  @SpringBootTest(properties = "api.export.max-sync-rows=5")            → context #4  ← 一個 property
  ...
  A40Test @WebMvcTest(OrderController)   + @MockBean OrderService              → context #1 已被淘汰 → 重建
```

**Spring 的 context 快取鍵包含 `@MockBean` 的定義集合**（7.4.5 有完整清單）。
所以：

```
@MockBean OrderService                        ← 一個 context
@MockBean OrderService + @MockBean CartService ← 另一個 context
```

**兩個 mock bean 的差異就是一個全新的 context。**

而 89 個 context 是怎麼長出來的？統計後的分布：

| 原因 | 數量 |
|---|---|
| `@MockBean` 組合不同 | 41 |
| `@SpringBootTest(properties = ...)` 各寫各的 | 23 |
| `@TestPropertySource` 各寫各的 | 11 |
| `@DirtiesContext` | 7 |
| `@ActiveProfiles` 組合不同 | 5 |
| 真的需要不同 context | 2 |

**87 / 89 是可以合併掉的。**

7.13.3 會把這 47 分鐘壓回 4 分鐘 —— **靠的不是刪測試，是讓 context 數量從 89 降到 6**。

### 7.2.3 事故三：測試斷言 200，但回應是空的

**時間**：新增稀疏欄位集功能（06 章 6.6.4）之後。
**症狀**：App 的訂單列表全部空白。

**這個功能有測試**：

```java
@Test
void 稀疏欄位集() throws Exception {
    when(orderQueryService.list(any())).thenReturn(samplePage());

    mockMvc.perform(get("/orders?fields=orderId,status"))
            .andExpect(status().isOk());        // 🔴 只有這一行
}
```

**這個測試永遠不會失敗。**

因為 `SparseFieldsetAdvice` 就算把 body 整個弄成 `{}`，
狀態碼還是 200。

**實際發生的事**：`?fields=orderId,status` 這個參數作用在 `PageResponse<OrderSummary>` 上，
而 `SparseFieldsetAdvice` 的欄位篩選是套在**最上層物件**上 ——
`PageResponse` 的欄位是 `content` / `pageInfo`，
它們都不叫 `orderId` 也不叫 `status`：

```json
{}
```

**200。Content-Type 正確。body 是空物件。**

⚠️ **`status().isOk()` 是「有值得斷言的東西」的最低標準，不是斷言。**

7.12.1 會把這一類反模式列成清單，並給出一個可以在 CI 抓出它們的檢查。

### 7.2.4 事故四：`@Transactional` 讓測試看不到真實行為

**時間**：地址變更通知信功能上線後。
**症狀**：客服改了地址、系統顯示成功、**通知信永遠沒寄出**。

**測試**：

```java
@SpringBootTest
@AutoConfigureMockMvc
@Transactional                              // 🔴 兇手
class OrderShippingAddressIntegrationTest {

    @Autowired MockMvc mockMvc;
    @Autowired OrderRepository orders;
    @MockBean MailSender mailSender;

    @Test
    void 修改地址會寄通知信() throws Exception {
        Order order = orders.save(anOrder().status(PAID).build());

        mockMvc.perform(patch("/orders/" + order.getId() + "/shipping-address")
                        .contentType(APPLICATION_JSON)
                        .content("""
                                {"recipientName":"王小明","phone":"0912345678",
                                 "postalCode":"10041","line1":"台北市中正區重慶南路一段 122 號"}
                                """))
                .andExpect(status().isOk());

        // 🔴 這個 verify 為什麼會過？
        verify(mailSender).send(argThat(m -> m.getTo().contains("customer@example.com")));
    }
}
```

**這個測試綠燈。而正式環境不寄信。**

原因在 00 章 0.6.6 的設計：通知信是用 `AFTER_COMMIT` 的事件監聽器寄的。

```java
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
public void onAddressChanged(AddressChangedEvent event) {
    mailSender.send(buildMail(event));
}
```

**而 `@Transactional` 的測試永遠不 commit** —— 它在測試方法結束時 rollback。
`AFTER_COMMIT` 的監聽器永遠不會被觸發。

**那 `verify(mailSender).send(...)` 為什麼會過？**

因為那個測試類別裡還有另一個測試方法先跑過，
而 `@MockBean` 的重設發生在**每個測試方法之後**（`MockitoTestExecutionListener`）——
不是之前。在某些 JUnit 執行順序下，前一個測試留下的呼叫紀錄被這個測試看到了。

⚠️ 換句話說：**這個綠燈是兩個 bug 疊在一起的結果**。

- bug A：`@Transactional` 讓 `AFTER_COMMIT` 不執行 → 應該紅燈。
- bug B：測試之間的 mock 狀態洩漏 → 讓它變綠燈。

**而正式環境的真正 bug 是第三個**：
`AddressChangedEvent` 是用 `applicationEventPublisher.publishEvent()` 發的，
但發布的位置在 `@Transactional` 方法**外面** ——
所以 `@TransactionalEventListener` 收到的是「沒有交易的事件」，
而它的預設行為是**靜默忽略**（`fallbackExecution = false`）。

三個 bug，一個綠燈。7.12.4 會處理這一類。

### 7.2.5 事故五：在測試裡重新實作被測邏輯

**時間**：Code review 時被發現，沒有上線。
**但它值得放進這個清單，因為它是最難察覺的一種。**

06 章 6.5.7 定義了 `MoneyFormat` —— 金額格式化的唯一入口：

```java
public final class MoneyFormat {

    private static final Map<String, Integer> FRACTION_DIGITS = Map.of(
            "TWD", 2, "USD", 2, "EUR", 2,
            "JPY", 0, "KRW", 0,          // ⚠️ 日圓與韓元沒有小數
            "HKD", 2, "CNY", 2, "KWD", 3);

    public static String format(BigDecimal value, String currency) {
        Integer digits = FRACTION_DIGITS.get(currency);
        if (digits == null) throw new IllegalArgumentException("不支援的幣別：" + currency);
        return value.setScale(digits, RoundingMode.HALF_UP).toPlainString();
    }
}
```

⚠️ **注意三件事**（下面的反模式建立在它們之上）：
**TWD 是 2 位小數**（不是 0）、**`format()` 用 `HALF_UP`**（`parse()` 才用
`UNNECESSARY`）、**未註冊的幣別會拋例外**。

**測試**：

```java
@Test
void 訂單明細的金額格式() throws Exception {
    when(orderQueryService.findDetail(any(), any())).thenReturn(
            sampleDetail(new BigDecimal("1280.50"), "TWD"));

    mockMvc.perform(get("/orders/ord_1"))
            .andExpect(status().isOk())
            // 🔴 用被測的那個類別，算出期望值
            .andExpect(jsonPath("$.totalAmount")
                    .value(MoneyFormat.format(new BigDecimal("1280.50"), "TWD")));
}
```

**這個測試斷言的是「`MoneyFormat` 等於 `MoneyFormat`」。**

它會通過。**而且不管 `MoneyFormat` 寫成什麼樣它都會通過** ——
即使有人把它改成 `return "0";`。

⚠️ **而這個寫法還讓一整類 bug 變得看不見。** 三個例子：

| 有人把 `MoneyFormat` 改成 | 正確的測試會 | 這個測試會 |
|---|---|---|
| `HALF_UP` → `HALF_DOWN` | 🔴 紅燈 | ✅ 綠燈 |
| `FRACTION_DIGITS` 的 `TWD` 從 2 改成 0 | 🔴 紅燈 | ✅ 綠燈 |
| 整個方法 `return "0";` | 🔴 紅燈 | ✅ 綠燈 |

**正確的寫法：期望值是寫死的字面值。**

```java
            // ★ 明確、可爭論、可被 review
            //   TWD 是 2 位小數（06 章 6.5.7 的 FRACTION_DIGITS），
            //   所以 1280.50 就是 "1280.50" —— 不是 "1281"、不是 1280.5
            .andExpect(jsonPath("$.totalAmount").value("1280.50"))
```

⚠️ **而「寫死」也要寫對。** 如果你憑印象寫 `"1281"`（以為台幣沒有小數），
測試會紅燈，然後很容易「修」成用 `MoneyFormat.format(...)` 算 ——
**於是繞回了同一個反模式**。
👉 **寫死的值要去查 `FRACTION_DIGITS` 那張表，而不是憑印象。**

**「期望值必須是人寫下來的」** —— 這是測試的第一原則。
如果期望值是算出來的，那你測的是「兩段相同的邏輯是否一致」，
而不是「邏輯是否正確」。

### 7.2.6 五個痛的共同點

| 事故 | 表面原因 | 真正的原因 |
|---|---|---|
| 1. 看到別人的訂單 | `addFilters = false` | **不知道 `@WebMvcTest` 的邊界在哪** |
| 2. CI 47 分鐘 | 測試太多 | **不知道 context 快取鍵是什麼** |
| 3. 空的 body | 只斷言 200 | **不知道「值得斷言的東西」是什麼** |
| 4. 信沒寄出 | `@Transactional` | **測試的環境與正式環境行為不同** |
| 5. 假的期望值 | 圖方便 | **搞錯了測試在證明什麼** |

**這五個原因都不是「測試技巧不足」，而是「不知道測試環境跟正式環境差在哪」。**

所以這一章的順序刻意不是「先教語法」：

```
7.3  先搞清楚「哪一種測試該測什麼」        ← 事故 3、5
7.4  再搞清楚「@WebMvcTest 的邊界」        ← 事故 1、2
7.5  然後才是 MockMvc 的語法
7.6  mock 的正確用法                       ← 事故 4
7.7  測試資料
7.8  參數化：讓覆蓋變得便宜
7.9  授權矩陣                              ← 事故 1 的系統性解法
7.10 契約測試
7.11 那些「必須」整合測試的東西            ← 事故 4
7.12 反模式清單                            ← 事故 3、5
7.13 CI 的組織                             ← 事故 2 的系統性解法
```

---

## 7.3 Web 層的測試金字塔

### 7.3.1 四個層級與它們的真實成本

這些數字是在一台 M2 MacBook Pro 上、shop-service 的實測值。
**你的數字會不同，但比例通常差不多。**

| 層級 | 啟動什麼 | 首次 | 之後每個測試 | 能測到什麼 |
|---|---|---|---|---|
| **① 純單元測試** | 什麼都不啟動 | 0 ms | **0.05～2 ms** | 純函式、值物件、驗證器、格式化 |
| **② MockMvc standalone** | 只有 MVC 的最小組裝 | ~120 ms | **3～10 ms** | 路由、綁定、advice（**但沒有你的設定**） |
| **③ `@WebMvcTest` 切片** | Web 層的 Spring context | **0.8～2.5 s** | **8～40 ms** | ②＋Jackson 設定＋Converter＋interceptor＋advice |
| **④ `@SpringBootTest`** | 整個應用程式 | **3～25 s** | 15～120 ms | 全部（filter 順序、Security、真實 bean） |
| **④′ `@SpringBootTest(RANDOM_PORT)`** | ④＋真的 Tomcat | **4～28 s** | 30～400 ms | ④＋真實 HTTP（CORS、壓縮、chunked、SSE） |

⚠️ **「首次」那一欄才是重點。**
`@WebMvcTest` 的「每個測試 8～40 ms」看起來很便宜 ——
但如果你有 60 個 `@WebMvcTest` 類別、每個都是不同的 context，
那是 60 × 1.5 s = **90 秒純啟動時間**。

**這就是為什麼 7.4.5（context 快取）比 MockMvc 的語法重要。**

### 7.3.2 為什麼 Web 層的金字塔是「梯形」

教科書的測試金字塔：

```
        ╱╲          少量 E2E
       ╱  ╲
      ╱────╲        一些整合測試
     ╱      ╲
    ╱────────╲      大量單元測試
```

**Web 層不是這個形狀。** 原因很簡單：

> **Web 層的程式碼裡「你自己寫的邏輯」極少 ——
> 大部分行為是「你設定的框架」產生的。**

具體地看 shop-service 的 Controller：

```java
@PostMapping
@Idempotent
@RateLimit(limit = 10, windowSeconds = 60, bucket = "order-write")
public ResponseEntity<CreateOrderResponse> create(
        @Valid @RequestBody CreateOrderRequest request,
        @CurrentActor Actor actor) {

    CreateOrderCommand command = mapper.toCommand(request, actor);   // ← 你寫的（3 行）
    Order order = orderService.create(command);                       // ← 別人的事
    return ResponseEntity
            .created(URI.create("/orders/" + order.id()))              // ← 你寫的（2 行）
            .body(mapper.toResponse(order));
}
```

**「你寫的」是 5 行。而這個端點的行為由這些東西決定**：

| 行為 | 誰決定 | 純單元測試能測到嗎 |
|---|---|---|
| `POST /orders` 路由到這裡 | `RequestMappingHandlerMapping` | ✗ |
| `Idempotency-Key` 缺了要回 400 | `IdempotencyFilter`（04 章） | ✗ |
| 超過 10 次/分鐘回 429 | `RateLimitInterceptor`（04 章） | ✗ |
| `Actor` 從哪來 | `CurrentActorArgumentResolver`（04 章） | ✗ |
| JSON 的 `unit_price` 綁不到 `unitPrice` | Jackson 命名策略（06 章） | ✗ |
| `@Valid` 失敗回 422 + `errors[]` | advice（03 章）+ `ValidationErrorTranslator`（02 章） | ✗ |
| `INSUFFICIENT_STOCK` 回 409 + Problem JSON | advice（03 章） | ✗ |
| 回應的 `totalAmount` 是 `"1280.50"` 而不是 `1280.5` | `MoneyFormat` + Jackson（06 章） | 部分 |
| 回應有 `Location` 標頭 | 你寫的那 2 行 | ✗（需要 MockMvc） |
| 錯誤回應有 CORS 標頭 | `CorsFilter` + `ProblemWriter`（06 章） | ✗ |

**十件事裡有九件需要至少 `@WebMvcTest`。**

所以 Web 層的形狀是：

```
    ┌──────────┐        ④  整合測試（20～40 個）
    │          │            filter 順序、CORS、SSE、壓縮、Range
    ├──────────┴───┐
    │              │    ③  @WebMvcTest（大部分在這裡）★
    │              │        每個 Controller 的端點行為
    ├──────────────┤
    │              │    ①  純單元測試
    └──────────────┘        SafeFilename、CsvWriter、ETags、MoneyFormat、
                            ProblemFactory、DidYouMean、ValueMasker...
```

⚠️ **注意 ② standalone 不在圖上。** 它的位置很尷尬（7.4.6 會說明）。

**而「①的底座不小」是刻意的** ——
前六章一直在把邏輯**抽成可以純單元測試的類別**：

| 抽出來的類別 | 章節 | 如果不抽出來 |
|---|---|---|
| `SafeFilename` | 5.4.2 | 四種檔名攻擊要用 multipart 測試才能覆蓋 |
| `ContentTypeDetector` | 5.5.2 | 每個 magic number 要造一個上傳請求 |
| `CsvWriter` | 5.9.2 | 公式注入防護要靠字串比對整份 CSV |
| `ETags` | 6.8.2 | weak/strong 比對要用真的 HTTP 來回 |
| `MoneyFormat` | 6.5.7 | 每個幣別要一個端點測試 |
| `ProblemFactory` | 3.6 | 83 個 code 要 83 個 MockMvc 測試 |
| `InstantParsing` | 6.6.1 | 邊界值（`.000`、`Z` vs `+08:00`）要走 HTTP |
| `DidYouMean` | 3.9.4 | 拼字建議要靠錯誤訊息比對 |

> **「這段邏輯能不能純單元測試」是一個設計訊號。**
> 不能的時候，通常代表它跟 HTTP 綁太緊了 —— 那多半可以抽。

### 7.3.3 shop-service 的完整分配表

這張表是這一章的**核心產出**。它為每一個前六章做出來的東西指定測試層級。

**共用元件（`common/`）**

| 元件 | 章節 | 層級 | 理由 |
|---|---|---|---|
| `ErrorCode` 註冊表一致性 | 3.4 | ① + `MessageSource` | 需要真的 messages（用 `StaticMessageSource` 或 ③） |
| `ProblemFactory` | 3.6 | **①** | 純組裝邏輯，mock `MessageSource` |
| `ProblemWriter` | 3.10.1 | **①** + ④ | ①測 JSON 內容；④測「reset 後 CORS 標頭還在」 |
| `MessageNotReadableAnalyzer` | 3.9 | **①** | 自己造 Jackson 例外 |
| `ValueMasker` / `DidYouMean` | 3.9 | **①** | 純函式 |
| `ErrorLogger` 分級 | 3.12 | **①** | 用 `ListAppender` 捕捉 log |
| `TraceIdFilter` | 4.4 | **①** + ④ | ①用 `MockHttpServletRequest`；④測順序 |
| `ClientIpResolver` | 4.5 | **①** | 純函式（一堆 XFF 的邊界） |
| `BodyMasker` | 4.6 | **①** | 純函式 |
| `CachedBodyFilter` | 4.4.6 | ① + **③** | ③才能測「Controller 真的讀到 body」 |
| `IpRateLimitFilter` | 4.8 | ① + **④** | ④才能測「429 有 CORS 標頭」 |
| `IdempotencyFilter` + Interceptor | 4.9 | **④** | 跨 filter/interceptor 的協作 |
| `CurrentActorArgumentResolver` | 4.10 | **③** | 需要 MVC 的參數解析機制 |
| `PageableGuardInterceptor` | 4.7 | **③** | 需要 handler method |
| `SafeFilename` / `StorageKeys` | 5.4 | **①** | 純函式（攻擊字串表） |
| `ContentTypeDetector` | 5.5.2 | **①** | 位元組陣列 → 型別 |
| `ImageReencoder` | 5.5.3 | **①** | 真的圖檔 fixture |
| `SafeZip` | 5.5.4 | **①** | ZIP bomb fixture |
| `UploadValidator` | 5.5.7 | **①** | 組合前面幾個 |
| `ContentDispositions` | 5.8.1 | **①** | 中文檔名編碼（一堆邊界） |
| `CsvWriter` | 5.9.2 | **①** | 公式注入、引號轉義 |
| `DownloadTokenService` | 5.10.6 | ① | 一次性語意 |
| `SseEmitterRegistry` | 5.11.6 | ① + **④′** | ④′才能測真的斷線 |
| `CorsConfig` | 6.3.5 | **④′** | MockMvc 不跑真的 preflight（7.5.9） |
| `CsvHttpMessageConverter` | 6.4.4 | ① + **③** | ③測內容協商真的選到它 |
| `MessageConverterConfig` | 6.4.5 | **③** | 守住 Range 支援 |
| Jackson 設定 | 6.5 | **③** | 需要真的 `ObjectMapper` bean |
| `MoneyFormat` | 6.5.7 | **①** | 純函式（幣別 × scale 的表） |
| `StatusLabelResolver` | 6.5.8 | ① + **③** | ③需要 `MessageSource` |
| `MaskingSerializer` | 6.6.2 | **①** | `ObjectMapper` 直接寫 |
| `SparseFieldsetAdvice` | 6.6.4 | **③** | 需要 advice 機制 |
| `ETags` | 6.8.2 | **①** | 純函式 |
| `SecurityConfig` 的規則 | 6.3.4 | **④** ★★ | 見 7.9 |

**Controller（每一個都是 ③，加上少數 ④）**

| Controller | 端點數 | ③ 測什麼 | ④ 額外測什麼 |
|---|---|---|---|
| `OrderController` | 6 | 路由、綁定、驗證、錯誤、Location | 授權矩陣 |
| `OrderItemController` | 3 | 巢狀路徑、409 | — |
| `OrderPaymentController` | 2 | 多型 body（6.7.1） | 冪等 |
| `OrderShippingAddressController` | 1 | `JsonNullable` 三態（1.7） | `AFTER_COMMIT` 事件 |
| `OrderUpdateController` | 1 | `If-Match`、412、428 | ETag 真的來回 |
| `OrderReceiptController` | 2 | `Content-Disposition`、Range | Range 真的分段 |
| `OrderCsvExportController` | 1 | `asyncDispatch` | 壓縮、chunked |
| `OrderExportController` | 3 | 202 + `Location`、輪詢 | 一次性 token |
| `OrderEventStreamController` | 1 | 只能測「開始了」 | **④′ 才是真測試** |
| `ProductController` | 5 | 分頁、排序白名單 | — |
| `ProductImageController` | 4 | multipart、壞檔案 | 掃毒（stub） |
| `CartController` 等 | 8 | — | — |

### 7.3.4 「這東西該用哪一級」的決策流程

```
                        要測的東西
                             │
              ┌──────────────┴──────────────┐
              │ 它需要 HTTP 的語意嗎？        │
              │（狀態碼、標頭、序列化的結果） │
              └──────────────┬──────────────┘
                       否 ───┴─── 是
                        │          │
                   ┌────▼────┐     │
                   │ ① 純單元 │     │
                   └─────────┘     │
                                   │
              ┌────────────────────▼────────────────────┐
              │ 它的行為依賴「你的 Spring 設定」嗎？       │
              │ （Jackson 設定、Converter、interceptor、  │
              │   advice、MessageSource）                 │
              └────────────────────┬────────────────────┘
                             否 ───┴─── 是
                              │          │
                   ┌──────────▼──────┐   │
                   │ ② standalone    │   │
                   │ ⚠️ 幾乎不用      │   │
                   └─────────────────┘   │
                                         │
              ┌──────────────────────────▼──────────────────────────┐
              │ 它的行為依賴「filter 的順序」或「真實的 HTTP 行為」嗎？│
              │  · filter 之間的互動（CORS ×  ProblemWriter）        │
              │  · 認證與授權                                        │
              │  · preflight / 壓縮 / chunked / Range / 真的斷線      │
              │  · 交易的 commit 時機                                │
              └──────────────────────────┬──────────────────────────┘
                                   否 ───┴─── 是
                                    │          │
                        ┌───────────▼───┐  ┌───▼──────────────────┐
                        │ ③ @WebMvcTest │  │ ④ @SpringBootTest    │
                        │   ★ 預設答案   │  │ ④′ + RANDOM_PORT     │
                        └───────────────┘  │   （真的 HTTP 才要）  │
                                           └──────────────────────┘
```

**三個實用的判斷句**：

1. **「我在斷言一個 HTTP 標頭或狀態碼」→ 至少 ③。**
2. **「我需要知道兩個 filter 誰先跑」→ ④。**
3. **「我在斷言一個字串的格式」→ 大概可以抽出來變 ①。**

**一個常見的誤判**：

> 「我要測 `POST /orders` 在庫存不足時回 409」——
> 這需要 Service、需要資料庫，所以要 `@SpringBootTest`？

**不需要。** 庫存不足是 Service 的判斷，Web 層的責任只是
「**當 Service 拋 `InsufficientStockException` 時，回 409 + 正確的 Problem JSON**」。

```java
@WebMvcTest(OrderController.class)      // ③ 就夠
class OrderControllerErrorTest {
    @MockitoBean OrderService orderService;

    @Test
    void 庫存不足回409() throws Exception {
        when(orderService.create(any()))
                .thenThrow(new InsufficientStockException(...));
        // ...
    }
}
```

**「庫存真的不足時 Service 會不會拋這個例外」是 05-service 的測試。**
兩層各測自己的一半，接縫由**例外型別**保證 ——
而「接縫有沒有對上」由 7.10 的契約測試守住。

---
## 7.4 `@WebMvcTest` 的切片邊界

這一節是整章最重要的一節。
**7.2.1 的資料洩漏事故，根源就是「不知道這條線畫在哪」。**

### 7.4.1 不要背清單，寫一個測試把它印出來

網路上有很多「`@WebMvcTest` 載入什麼」的清單，
但它們**隨 Spring Boot 版本改變**，而且跟你的 classpath 有關
（有沒有 security、有沒有 hateoas、有沒有 thymeleaf）。

**所以第一件事不是背清單，是寫一個能回答這個問題的測試。**

```java
package example.shop.arch;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.context.ApplicationContext;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

import java.util.Arrays;
import java.util.Comparator;
import java.util.stream.Collectors;

/**
 * 「@WebMvcTest 到底載入了什麼」的診斷測試。
 *
 * <p>★ 這不是一個斷言測試，是一個**探測工具**。
 * 它刻意用 @Test 而不是 main()，因為它需要 Spring 的測試環境。
 *
 * <p>用法：跑它，把輸出貼到 PR 裡當作「這個版本的切片邊界」的紀錄。
 * 升級 Spring Boot 之後再跑一次，diff 就是「切片邊界的變化」。
 */
@WebMvcTest(example.shop.order.web.OrderController.class)
class WebMvcSliceInventoryTest {

    @Autowired ApplicationContext context;

    // ★ OrderController 的依賴一定要 mock，否則 context 起不來
    @MockitoBean example.shop.order.service.OrderService orderService;
    @MockitoBean example.shop.order.service.OrderQueryService orderQueryService;

    @Test
    void 印出切片裡的所有應用程式bean() {
        String report = Arrays.stream(context.getBeanDefinitionNames())
                .map(name -> {
                    Class<?> type = context.getType(name);
                    return type == null ? null : type;
                })
                .filter(t -> t != null)
                .map(Class::getName)
                // ★ 只看「我們自己的」與 Spring MVC 的，過濾掉幾百個 autoconfig
                .filter(n -> n.startsWith("example.shop")
                          || n.startsWith("org.springframework.web")
                          || n.startsWith("org.springframework.security.web")
                          || n.startsWith("org.springframework.boot.autoconfigure.web"))
                .sorted(Comparator.naturalOrder())
                .collect(Collectors.joining("\n"));

        System.out.println("──────── @WebMvcTest 切片內容 ────────");
        System.out.println(report);
        System.out.println("──────── 共 " + context.getBeanDefinitionCount() + " 個 bean ────────");
    }

    @Test
    void 印出實際生效的filter鏈() {
        // ★ 這是 7.4.4 的關鍵：MockMvc 上到底掛了哪些 filter
        //   （這裡用 MockMvc 內部的欄位，比較 hacky，所以另外提供 7.4.4 的正式做法）
        context.getBeansOfType(jakarta.servlet.Filter.class)
                .forEach((name, filter) ->
                        System.out.printf("Filter bean: %-45s %s%n",
                                name, filter.getClass().getName()));
    }
}
```

**shop-service 在 Boot 3.2.5 上的實際輸出（節錄、分類過）**：

```
──────── @WebMvcTest 切片內容 ────────

【✅ 有：你指定的 Controller】
example.shop.order.web.OrderController

【✅ 有：所有 @ControllerAdvice —— 不管你有沒有指定】
example.shop.common.web.ApiExceptionHandler          ← 03 章
example.shop.common.web.BusinessAdvice               ← 03 章
example.shop.common.web.GenericAdvice                ← 03 章
example.shop.common.web.SparseFieldsetAdvice         ← 06 章（ResponseBodyAdvice）

【✅ 有：WebMvcConfigurer —— 所以 interceptor / resolver / converter 的註冊都生效】
example.shop.common.config.WebMvcConfig               ← 04 章
example.shop.common.config.ContentNegotiationConfig   ← 06 章
example.shop.common.config.MessageConverterConfig     ← 06 章
example.shop.common.config.AsyncMvcConfig             ← 05 章

【✅ 有：Converter / GenericConverter】
example.shop.common.web.convert.StringToCursorConverter          ← 01 章
example.shop.common.web.convert.StringToInstantConverter         ← 06 章
example.shop.common.web.convert.StrictStringToEnumConverterFactory

【✅ 有：HandlerInterceptor（bean 形式）】
example.shop.common.web.UnknownQueryParamInterceptor
example.shop.common.web.PageableGuardInterceptor
example.shop.common.web.ratelimit.RateLimitInterceptor
example.shop.common.web.IdempotencyInterceptor
example.shop.common.web.ReadOnlyFieldInterceptor
example.shop.common.web.StreamingUnsupportedParamInterceptor
example.shop.common.web.ActorMdcInterceptor

【✅ 有：HandlerMethodArgumentResolver】
example.shop.common.web.CurrentActorArgumentResolver
example.shop.common.web.RequestContextArgumentResolver

【✅ 有：Filter bean —— ★ 這一點很多人不知道】
example.shop.common.web.TraceIdFilter
example.shop.common.web.CachedBodyFilter
example.shop.common.web.RequestLoggingFilter
example.shop.common.web.AuditFilter
example.shop.common.web.ratelimit.IpRateLimitFilter
example.shop.common.web.RequestSizeLimitFilter
example.shop.common.web.IdempotencyFilter
example.shop.common.web.TrailingSlashRedirectFilter
example.shop.common.web.JsonCharsetFilter
example.shop.common.web.VaryOriginOptimizationFilter
org.springframework.web.filter.CharacterEncodingFilter
org.springframework.web.filter.FormContentFilter
org.springframework.web.filter.RequestContextFilter

【✅ 有：HttpMessageConverter】
example.shop.common.web.converter.CsvHttpMessageConverter

【⚠️ 有：ErrorAttributes（但【沒有】我們的 ApiErrorController）★★】
example.shop.common.web.ApiErrorAttributes              ← 03 章 3.10.2（實作 ErrorAttributes）
org.springframework.boot.autoconfigure.web.servlet.error.BasicErrorController
  ★★ 注意這一列：@WebMvcTest(OrderController.class) 的 TypeExcludeFilter
     只保留【指定的那個 controller】，而 ApiErrorController 也是一個
     @RestController → 它【不會】被載入。
     於是 ErrorMvcAutoConfiguration 沒有偵測到自訂的 ErrorController，
     就註冊了 Boot 的 BasicErrorController。
  ⚠️ 後果：切片測試裡 forward 到 /error 的回應是【Boot 的預設 JSON】
     （{"timestamp":...,"status":500,"error":"Internal Server Error"}），
     而不是我們的 Problem —— 03 章 3.10.3 的行為在 ③ 層【測不到】。
     👉 那一節的測試必須是 ④（見 7.11.1 的表格）。

【✅ 有：JacksonAutoConfiguration → 真的 ObjectMapper（含你所有的設定）】
（在 org.springframework.boot.autoconfigure.jackson 底下）

【🔴 沒有：@Service / @Component / @Repository】
（找不到 OrderServiceImpl、OrderReceiptServiceImpl、RedisRateLimiter、
  ClamAvScanner、SseEmitterRegistry、DownloadTokenService、AuditRepository...）
──────── 共 218 個 bean ────────
```

**三個最容易誤判的點**：

| 以為 | 實際 |
|---|---|
| 「`@WebMvcTest(OrderController.class)` 只載入那一個 Controller，所以 advice 也不會載入」 | ❌ **所有 `@ControllerAdvice` 都會載入**（03 章的錯誤格式在 ③ 就測得到） |
| 「advice 會載入，所以 `ApiErrorController` 也會」 | ❌ **它是 `@RestController`，會被 `TypeExcludeFilter` 排除** —— 切片裡是 Boot 的 `BasicErrorController`（見上方輸出）|
| 「Filter 是 Servlet 層的東西，`@WebMvcTest` 不管它」 | ❌ **`Filter` bean 會被載入並掛到 MockMvc 上**（7.4.4） |
| 「`@WebMvcTest` 用的是預設的 `ObjectMapper`」 | ❌ **`JacksonAutoConfiguration` 有跑，你的 `spring.jackson.*` 與 `JacksonConfig` 全部生效**（所以 06 章的設定在 ③ 測得到） |

### 7.4.2 它沒載入什麼 —— 以及那造成的假綠燈

**明確的排除清單（這部分跨版本很穩定）**：

| 沒載入 | 具體例子（shop-service） | 造成的假綠燈 |
|---|---|---|
| `@Service` | `OrderServiceImpl`、`OrderReceiptServiceImpl` | 無（本來就要 mock） |
| `@Repository` | `OrderRepository`、`AuditRepository` | 無 |
| 一般 `@Component` | `RedisRateLimiter`、`ClamAvScanner`、`SseEmitterRegistry`、`DownloadTokenService`、`MdcTaskDecorator` | ⚠️ **filter 需要它們 → context 起不來**（7.4.4） |
| `@Component` 的 `@ConfigurationProperties` | 若你用 `@Component` 註冊 | 啟動失敗（訊息還算清楚） |
| `@Aspect` | `ServiceTimingAspect`（4.11.2） | 無（那是 Service 層） |
| `@Scheduled` 的任務 | `SseHeartbeat`、`ExportRetentionSweeper`、`MultipartTempSweeper` | 無（測試不該跑排程） |
| `@TransactionalEventListener` | `AuditEventListener` | 🔴 **事故 7.2.4** |
| **真的 Servlet 容器** | Tomcat | 🔴 **見下方「六個 server.* 設定完全無效」** |
| **`spring.main.*` / 啟動時的驗證器** | `CorsConfigurationValidator`（6.3.6）、`ErrorMessageStartupValidator`（3.4.5） | ⚠️ 這些是 `ApplicationRunner` / `@PostConstruct`，行為依註冊方式而異 |

**★ 六個在 `@WebMvcTest` 裡完全無效的設定**（因為它們是 Servlet 容器的職責）：

```yaml
server:
  compression:
    enabled: true                  # 🔴 MockMvc 永遠不壓縮 → 測不到 gzip
  tomcat:
    max-connections: 20000         # 🔴 沒有 Tomcat
    max-swallow-size: 2MB          # 🔴 5.3.7 的行為完全測不到
    connection-timeout: 20s        # 🔴
  max-http-request-header-size: 8KB # 🔴 標頭超長的行為測不到
  servlet:
    context-path: /api             # 🔴 MockMvc 的路徑不含它（除非明確設定）
```

⚠️ **這解釋了一個常見的困惑**：

> 「我在 `@WebMvcTest` 裡斷言 `Content-Encoding: gzip`，永遠失敗。」

**不是你的設定錯，是 MockMvc 根本沒有壓縮這個階段。**
壓縮測試必須是 ④′（7.11.5）。

**`spring.servlet.multipart.max-file-size` 呢？**
這個**部分有效** —— `@WebMvcTest` 有 `MultipartAutoConfiguration`，
`StandardServletMultipartResolver` 會被建起來，
但**真正執行大小檢查的是 Tomcat 的 `Request.parseParts()`**。
MockMvc 的 `MockMultipartHttpServletRequest` 是你自己組的，**不會觸發那個檢查**。

```java
// ⚠️ 這個測試在 @WebMvcTest 裡不會回 413
@Test
void 檔案超過10MB要回413() throws Exception {
    byte[] big = new byte[11 * 1024 * 1024];
    mockMvc.perform(multipart("/products/P-1001/images")
                    .file(new MockMultipartFile("file", "a.jpg", "image/jpeg", big)))
            .andExpect(status().isPayloadTooLarge());     // 🔴 實際上是 200 或 422
}
```

**05 章 5.5.7 的 `UploadValidator` 有自己的大小檢查，所以會回 422（`UploadRejectedException`）。**
而「Tomcat 層的 413」要用 ④′ 測 —— 這是一個**兩層防護，兩種測試**的例子：

| 防線 | 誰擋 | 狀態碼 | 測試層級 |
|---|---|---|---|
| Tomcat multipart 上限 | `spring.servlet.multipart.max-file-size` | 413 `MaxUploadSizeExceededException` | **④′** |
| 應用層驗證 | `UploadValidator`（5.5.7） | 422 `UPLOAD_REJECTED` | **③** |

⚠️ 而 05 章 5.6.3 的 `UploadPropertiesConsistencyTest` 就是為了保證這兩個數字一致 ——
**它是 ① 純單元測試，因為它只比較兩個設定值。**

### 7.4.3 `@WebMvcTest` 裡的 Security：完整真相 ★★

這是 7.2.1 的核心。**請把這一節讀兩遍。**

**事實一：`@WebMvcTest` 會套用 Spring Security。**

`@WebMvcTest` 的自動設定清單包含 `SecurityAutoConfiguration` 與
`SecurityFilterAutoConfiguration`；`spring-security-test` 在 classpath 上時，
`MockMvcSecurityConfiguration` 會把 `springSecurityFilterChain` 掛到 MockMvc。

**所以**：

```java
@WebMvcTest(OrderController.class)
class OrderControllerTest {
    @Autowired MockMvc mockMvc;
    @MockitoBean OrderQueryService orderQueryService;

    @Test
    void 查詢訂單() throws Exception {
        mockMvc.perform(get("/orders/ord_1"))
                .andExpect(status().isOk());     // 🔴 實際是 401
    }
}
```

**事實二：套用的可能不是你的 `SecurityConfig`。**

這一點是所有混淆的來源。有兩種情況：

```
情況 A：你的 SecurityConfig 被載入了
        → 套用你真正的規則（.requestMatchers(...).hasRole(...)）
        → 測試行為接近正式環境 ✅

情況 B：你的 SecurityConfig 沒被載入
        → SecurityAutoConfiguration 的預設：
          「所有請求都要認證，帳號 user，密碼開機時隨機產生」
        → 所有請求 401，不管你的規則寫什麼 ⚠️
```

**哪一種？取決於你的 Boot 版本與 `SecurityConfig` 的形態。**
不要猜 —— **用測試問它**：

```java
package example.shop.arch;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.context.ApplicationContext;
import org.springframework.security.web.SecurityFilterChain;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 回答一個問題：@WebMvcTest 裡的 SecurityFilterChain 是我寫的那個，
 * 還是 SecurityAutoConfiguration 的預設？
 *
 * <p>★ 這個測試的價值不在「它斷言了什麼」，
 *    而在「它把一個假設變成了一個會紅燈的事實」。
 */
@WebMvcTest(example.shop.order.web.OrderController.class)
class SecuritySliceRealityCheckTest {

    @Autowired ApplicationContext context;
    @org.springframework.test.context.bean.override.mockito.MockitoBean
    example.shop.order.service.OrderQueryService orderQueryService;

    @Test
    void 切片裡的SecurityFilterChain來自我們的SecurityConfig() {
        var chains = context.getBeansOfType(SecurityFilterChain.class);

        System.out.println("SecurityFilterChain bean 數量：" + chains.size());
        chains.forEach((name, chain) -> {
            System.out.println("  bean 名稱：" + name);
            chain.getFilters().forEach(f ->
                    System.out.println("      " + f.getClass().getSimpleName()));
        });

        // ★ SecurityAutoConfiguration 的預設 chain 的 bean 名稱是
        //   "defaultSecurityFilterChain"；我們自己的是 "filterChain"（方法名）。
        assertThat(chains.keySet())
                .as("""
                    切片裡的 SecurityFilterChain 是自動設定的預設值，不是 SecurityConfig。
                    → 這代表這個 @WebMvcTest 測不到任何真實的授權規則。
                    → 解法：@Import(SecurityConfig.class)，或改用 @SpringBootTest（7.9.6）。
                    """)
                .contains("filterChain")
                .doesNotContain("defaultSecurityFilterChain");
    }
}
```

**事實三：`addFilters = false` 是一個「把問題藏起來」的按鈕。**

```java
@AutoConfigureMockMvc(addFilters = false)
```

它做的事很單純：**建 MockMvc 時不掛任何 filter**。

```
關掉的不只 security：
  CorsFilter (-200)  TraceIdFilter (-121)  TrailingSlashRedirectFilter (-120)
  IpRateLimitFilter (-119)  RequestSizeLimitFilter (-118)  CachedBodyFilter (-117)
  RequestLoggingFilter (-116)  AuditFilter (-115)  JsonCharsetFilter
  VaryOriginOptimizationFilter  springSecurityFilterChain  IdempotencyFilter (-99)
  CharacterEncodingFilter  FormContentFilter  RequestContextFilter
```

**這造成四類靜默失效**：

| 你以為在測 | 實際上 | 症狀 |
|---|---|---|
| 授權 | 沒有認證，也沒有授權 | 🔴 **7.2.1** |
| `X-Trace-Id` 在回應裡 | `TraceIdFilter` 沒跑 → MDC 空的 | Problem JSON 的 `traceId` 是 `null` 或測試 assert 失敗 |
| `@RequestBody` + `RequestLoggingFilter` 同時運作 | `CachedBodyFilter` 沒跑 | ⚠️ 反而「更容易過」，因為少了一層 wrapper |
| 限流回 429 | `IpRateLimitFilter` 沒跑 | 那個測試永遠測不到 filter 層的限流 |

**所以 shop-service 的規則**：

> **`addFilters = false` 只能用在「明確要測 filter 以外的東西」的測試上，
> 而且必須寫下理由。**

用一個 ArchUnit 測試守住它：

```java
package example.shop.arch;

import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.core.importer.ImportOption;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;

import java.util.Set;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 守門：不可以隨便用 addFilters = false。
 *
 * <p>★ 這個測試會掃描 test source set —— 也就是「測試在測試測試」。
 *    這聽起來奇怪，但 7.2.1 的損失是「350 個測試同時失效」，
 *    值得一個這樣的守門。
 */
class NoBlanketFilterDisablingTest {

    /** 明確允許的名單 —— 加進來要在 PR 說明理由。 */
    private static final Set<String> ALLOWED = Set.of(
            // 這個測試在測「Jackson 反序列化失敗時 advice 的行為」，
            // filter 與它完全無關，關掉可以少 40 ms × 32 個案例。
            "example.shop.common.web.MessageNotReadableAdviceTest",
            // 這個測試在測 CsvHttpMessageConverter 的內容協商，同上。
            "example.shop.common.web.converter.CsvContentNegotiationTest"
    );

    @Test
    void 沒有未經核准的addFilters_false() {
        JavaClasses testClasses = new ClassFileImporter()
                .withImportOption(ImportOption.Predefined.ONLY_INCLUDE_TESTS)
                .importPackages("example.shop");

        Set<String> offenders = testClasses.stream()
                .filter(c -> {
                    var ann = c.tryGetAnnotationOfType(AutoConfigureMockMvc.class);
                    return ann.isPresent() && !ann.get().addFilters();
                })
                .map(c -> c.getFullName())
                .filter(name -> !ALLOWED.contains(name))
                .collect(Collectors.toCollection(java.util.TreeSet::new));

        assertThat(offenders)
                .as("""
                    這些測試用了 @AutoConfigureMockMvc(addFilters = false)。

                    那會關掉「所有」filter，包含 Spring Security ——
                    於是這些測試完全測不到認證與授權（見 07 章 7.2.1）。

                    如果你確定這個測試與 filter 無關，把它加進 ALLOWED，
                    並在 PR 裡說明為什麼。
                    """)
                .isEmpty();
    }
}
```

**事實四：`@WithMockUser` 會讓 `@CurrentActor` 的參數解析拋 500。**

這是 shop-service 特有的一個坑，來自 04 章 4.10 的設計。

```java
@Test
@WithMockUser(username = "cust_01J5GK", roles = "CUSTOMER")
void 客戶查自己的訂單() throws Exception {
    mockMvc.perform(get("/orders/ord_1"))
            .andExpect(status().isOk());        // 🔴 實際是 500
}
```

**回顧 04 章 4.10.2 的 `CurrentActorArgumentResolver`**：

```java
    Authentication auth = SecurityContextHolder.getContext().getAuthentication();

    boolean authenticated = auth != null && auth.isAuthenticated()
            && !(auth instanceof AnonymousAuthenticationToken);

    if (!authenticated) {
        if (allowAnonymous) return Actor.ANONYMOUS;
        throw new AuthenticationRequiredException();      // → 401
    }

    if (auth.getPrincipal() instanceof CurrentUser user) {
        return user.actor();                              // ★ 只有這條路會成功
    }

    // ⚠️ 走到這裡代表 Security 的設定與這個 resolver 不同步
    throw new IllegalStateException(...);                 // → 500
```

**關鍵在最後兩行。**

`@WithMockUser` 建立的是一個 `UsernamePasswordAuthenticationToken`，
它的 **principal 是一個 `String`（或 Spring Security 內建的 `User`）**，
**不是 shop-service 的 `CurrentUser`**（04 章 4.13.6）。

```
@WithMockUser  →  auth.getPrincipal() 是 String "cust_01J5GK"
                        ↓
                  instanceof CurrentUser → false
                        ↓
                  throw new IllegalStateException  →  500
```

⚠️ **注意這個失敗模式有多好**：它是一個**大聲的 500**，
而不是「`actor` 靜默地是 `null`」。

那是 04 章 4.10.2 刻意的設計 ——
`IllegalStateException` 的訊息明說「Security 的設定與 resolver 不同步」，
**因為那確實是設定錯誤，而不是使用者的錯**。

> **★ 這裡值得停一下**：一個「拋 500」的設計看起來很糟，
> 但它比「回傳 `null`」好得多 ——
> `null` 會一路往下傳到 Service，變成一個授權判斷的漏洞（7.2.1）。
> **「設定錯誤要在第一時間爆炸」是一條好規則。**

**修法：讓測試放進一個真的 `CurrentUser`。**

`spring-security-test` 的 `@WithSecurityContext` 就是為此存在的：

```java
package example.shop.test;

import example.shop.order.domain.Actor;
import example.shop.security.CurrentUser;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.test.context.support.WithSecurityContext;
import org.springframework.security.test.context.support.WithSecurityContextFactory;

import java.lang.annotation.*;
import java.util.Arrays;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * 以某個 {@link Actor} 的身分執行測試。
 *
 * <p>★★ 為什麼不能直接用 {@code @WithMockUser}：
 *    它放進 SecurityContext 的 principal 是 {@code String}，
 *    而 {@code CurrentActorArgumentResolver}（04 章 4.10.2）
 *    需要一個 {@link CurrentUser} —— 型別不符時它會拋
 *    {@code IllegalStateException} → 500。
 *
 * <p>★ 為什麼用 {@code @WithSecurityContext} 而不是自己寫
 *    {@code BeforeEachCallback}：
 * <ul>
 *   <li>{@code WithSecurityContextTestExecutionListener} 會**自動清理**
 *       SecurityContext —— 不用自己寫 {@code @AfterEach}，
 *       也就不會有「忘了清 → 洩漏到下一個測試」的問題。</li>
 *   <li>它與 {@code MockMvc} 的 {@code SecurityContextPersistenceFilter}
 *       正確整合（自己 set 的話，filter 可能會覆蓋掉它）。</li>
 *   <li>它可以標在類別上，被所有方法繼承。</li>
 * </ul>
 */
@Target({ElementType.TYPE, ElementType.METHOD})
@Retention(RetentionPolicy.RUNTIME)
@Documented
@WithSecurityContext(factory = WithActor.Factory.class)
public @interface WithActor {

    Actor.ActorType type() default Actor.ActorType.CUSTOMER;

    String id() default "cust_01J5GKTESTCUST01";

    String displayName() default "測試客戶";

    /** 額外的 scope（09-spring-security 會用到）。 */
    String[] scopes() default {};

    class Factory implements WithSecurityContextFactory<WithActor> {

        @Override
        public SecurityContext createSecurityContext(WithActor ann) {
            // ★★ 關鍵一：principal 是真的 CurrentUser，不是 String
            //
            // ★★ 關鍵二：roles 放【裸的】角色名，不加 ROLE_ 前綴。
            //    CurrentUser.getAuthorities()（04 章 4.13.6）自己會加：
            //        roles.stream().map(r -> new SimpleGrantedAuthority("ROLE_" + r))
            //    ⚠️ 傳 "ROLE_CUSTOMER" 進來會變成 ROLE_ROLE_CUSTOMER
            //       → hasRole("CUSTOMER") 全部失敗
            //       → 7.9.3 的 350 個授權斷言【每一格都是 403】
            //    而症狀看起來像「SecurityConfig 壞了」，其實是多了三個字。
            var principal = new CurrentUser(
                    ann.id(),
                    ann.displayName(),
                    ann.type(),
                    Set.of(ann.type().name()),                 // ★ 不加 ROLE_
                    Arrays.stream(ann.scopes()).collect(Collectors.toSet()),
                    "tok_test_" + ann.id());

            // ★★ 關鍵三：authorities 一律走 principal.getAuthorities()，
            //    不要自己組。自己組的話「測試用的權限」與
            //    「正式環境用的權限」是兩份程式碼 —— 而它們一定會分岔
            //    （7.4.6 理由一的同一個道理）。
            var authentication = new UsernamePasswordAuthenticationToken(
                    principal, "n/a", principal.getAuthorities());

            var context = SecurityContextHolder.createEmptyContext();
            context.setAuthentication(authentication);
            return context;
        }
    }
}
```

**用法**：

```java
@WithActor(type = ActorType.CUSTOMER, id = "cust_A")
@Test
void 客戶只能看自己的訂單() throws Exception { ... }
```

⚠️ **一個常見的誤解要澄清**：
`CurrentActorHolder`（04 章 4.13.6）**沒有 setter** ——
它是一個唯讀的門面，`actor()` 直接讀 `SecurityContextHolder`。

```java
public final class CurrentActorHolder {
    public static Actor actor() { /* 讀 SecurityContextHolder */ }
    public static String actorIdOrAnonymous() { return actor().id(); }
    private CurrentActorHolder() {}
}
```

**所以「兩個真相來源」這個擔心是不存在的** ——
`SecurityContextHolder` 就是唯一的來源，
`CurrentActorHolder` 只是一個讀取的便利方法。
**你只需要把 `SecurityContext` 設對，兩條路徑就都對了。**

> ★ 這也解釋了為什麼 09-spring-security 不需要「合併兩個來源」——
> 它們本來就是同一個。要做的只是「把 JWT 轉成 `CurrentUser`」。

### 7.4.4 Filter 在 `@WebMvcTest` 裡的行為

`Filter` bean 會被載入 —— **但這帶來一個立刻會遇到的問題**：

```
example.shop.common.web.ratelimit.IpRateLimitFilter
      需要 RateLimiter  →  RedisRateLimiter 是 @Component  →  🔴 沒有被載入
```

**啟動失敗**：

```
Parameter 0 of constructor in example.shop.common.web.ratelimit.IpRateLimitFilter
required a bean of type 'example.shop.common.web.ratelimit.RateLimiter'
that could not be found.
```

**四個選項**：

| 選項 | 做法 | 適用 |
|---|---|---|
| A. 每個測試 `@MockitoBean RateLimiter` | 一行 | ⚠️ 每個測試類別都要寫 → 而且 mock 沒 stub 就回 `null` → NPE |
| B. `@MockitoBean` 掉那個 **filter** | `@MockitoBean IpRateLimitFilter` | 🔴 mock 的 filter 什麼都不做，連 `chain.doFilter()` 都不呼叫 → **所有請求回 200 空 body** |
| **C. 一個共用的 `@TestConfiguration` 提供真的輕量實作** ★ | `InMemoryRateLimiter` | ✅ 行為真實、可控、context 只有一個 |
| D. `@WebMvcTest(excludeFilters = ...)` | 明確排除 | 適合真的不相關的 filter |

⚠️ **選項 B 是一個特別惡毒的陷阱**：

```java
@MockitoBean IpRateLimitFilter ipRateLimitFilter;    // 🔴🔴
```

Mockito 的預設行為是「所有方法回傳預設值、什麼都不做」。
`Filter.doFilter(req, res, chain)` 回傳 `void`，於是它**不呼叫 `chain.doFilter()`**。
**請求在這個 filter 就停住了** —— 回應是 200 加空 body。

**症狀**：所有測試變成
`java.lang.AssertionError: JSON path "$.orderId" ... No value at JSON path`，
而狀態碼是 200。**很難聯想到是 mock 的 filter 造成的。**

**shop-service 的做法（選項 C）**：

```java
package example.shop.test;

import example.shop.common.upload.MalwareScanner;
import example.shop.common.web.ratelimit.InMemoryRateLimiter;
import example.shop.common.web.ratelimit.RateLimiter;
import example.shop.order.service.IdempotencyStore;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;

/**
 * 所有 @WebMvcTest 共用的基礎設施替身。
 *
 * <p>★ 設計原則：**用真的輕量實作，不用 mock**。
 *
 * <p>理由：
 * <ul>
 *   <li>mock 沒 stub 就回 null → NPE 或「測到不是你想測的東西」（7.6.3）</li>
 *   <li>真的實作有真的行為 → 「第 11 次請求回 429」在切片裡就測得到</li>
 *   <li>只有一份 → context 快取鍵一致 → 只建一個 context（7.4.5）</li>
 * </ul>
 *
 * <p>⚠️ 這裡的每一個 bean 都必須是「行為與正式版一致、只是沒有外部依賴」。
 *    不是「什麼都不做的空殼」—— 那等於 addFilters = false。
 */
@TestConfiguration(proxyBeanMethods = false)
public class WebSliceInfraConfig {

    /**
     * 固定時鐘。
     *
     * <p>★ 這是整個測試套件裡最有價值的一個 bean ——
     *    它讓 Problem 的 timestamp、ETag、限流的 resetAt、
     *    download token 的過期時間全部變成可斷言的固定值。
     */
    public static final Instant FIXED_NOW = Instant.parse("2026-08-24T02:30:00Z");

    @Bean
    @Primary
    Clock testClock() {
        return Clock.fixed(FIXED_NOW, ZoneOffset.UTC);
    }

    /** 04 章 4.8 的記憶體版限流器 —— 行為與 Redis 版一致。 */
    @Bean
    RateLimiter rateLimiter(Clock clock) {
        return new InMemoryRateLimiter(clock);
    }

    /** 04 章 4.9 的冪等儲存 —— 記憶體版。 */
    @Bean
    IdempotencyStore idempotencyStore(Clock clock) {
        return new InMemoryIdempotencyStore(clock);
    }

    /** 05 章 5.5.6 的 no-op 掃毒 —— 與 local profile 的行為一致。 */
    @Bean
    MalwareScanner malwareScanner() {
        return (name, bytes) -> MalwareScanner.Result.clean();
    }

    /** 05 章 5.4.3：物件儲存的記憶體實作。 */
    @Bean
    example.shop.common.upload.ObjectStorage objectStorage() {
        return new example.shop.common.upload.InMemoryObjectStorage();
    }

    /** 04 章 4.6：稽核紀錄丟進一個可斷言的 list。 */
    @Bean
    example.shop.common.audit.AuditRepository auditRepository() {
        return new RecordingAuditRepository();
    }
}
```

**在測試裡引入**：

```java
@WebMvcTest(OrderController.class)
@Import(WebSliceInfraConfig.class)          // ★
class OrderControllerTest { ... }
```

⚠️ **`@TestConfiguration` 與 `@Configuration` 的差別**：
`@TestConfiguration` **不會**被元件掃描撿到（它帶著 `@TestComponent`，
被 `TypeExcludeFilter` 排除），所以放在 test source 裡也不會意外汙染正式 context。
**一定要用 `@TestConfiguration`，不要用 `@Configuration`。**

**驗證 filter 真的掛上去了**（7.4.1 第二個測試的正式版）：

```java
package example.shop.arch;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

/**
 * 驗證「@WebMvcTest 裡的請求真的經過了我們的 filter」。
 *
 * <p>★ 做法：不去反射 MockMvc 的內部結構，而是**觀察 filter 的效果**。
 *    TraceIdFilter 的效果是「回應有 X-Trace-Id 標頭」——
 *    那個標頭存在，就證明 filter 跑了。
 *
 * <p>這是一個通用技巧：**用可觀察的效果代替內部結構的斷言**。
 */
@WebMvcTest(example.shop.order.web.OrderController.class)
@Import(example.shop.test.WebSliceInfraConfig.class)
class FiltersAppliedInSliceTest {

    @Autowired MockMvc mockMvc;
    @MockitoBean example.shop.order.service.OrderQueryService orderQueryService;

    @Test
    void TraceIdFilter在切片裡有跑() throws Exception {
        var result = mockMvc.perform(get("/orders/ord_1")).andReturn();

        assertThat(result.getResponse().getHeader("X-Trace-Id"))
                .as("""
                    回應沒有 X-Trace-Id ——
                    代表 TraceIdFilter 沒有掛到 MockMvc 上。
                    檢查：是不是有人加了 @AutoConfigureMockMvc(addFilters = false)？
                    """)
                .isNotNull()
                .hasSize(16);       // 04 章 4.4.3：16 個 hex 字元
    }

    @Test
    void CorsFilter在切片裡有跑() throws Exception {
        var result = mockMvc.perform(get("/orders/ord_1")
                        .header("Origin", "https://shop.example"))
                .andReturn();

        // ⚠️ 注意：MockMvc 可以測「有 Origin 的簡單請求」的 CORS 標頭，
        //    但**測不到 preflight**（7.5.9 第 3 點）。
        assertThat(result.getResponse().getHeader("Access-Control-Allow-Origin"))
                .isEqualTo("https://shop.example");
        assertThat(result.getResponse().getHeaders("Vary"))
                .contains("Origin");                    // 06 章 6.3.7
    }
}
```

### 7.4.5 context 快取：測試從 4 分鐘變 47 分鐘的機制 ★

**Spring 的測試框架會快取 `ApplicationContext`。** 快取鍵是由這些東西組成的：

| 快取鍵的組成 | 對應的註解 |
|---|---|
| 設定類別 / 位置 | `@ContextConfiguration`、`@SpringBootTest(classes = ...)` |
| **啟用的 profile** | `@ActiveProfiles`（★ **順序無關**，會排序後比較） |
| **property source 的位置** | `@TestPropertySource(locations = ...)` |
| **inline property** | `@TestPropertySource(properties = ...)`、`@SpringBootTest(properties = ...)` |
| context initializer | `@ContextConfiguration(initializers = ...)` |
| context loader | 通常是 `SpringBootContextLoader` |
| parent context | 少見 |
| **`@WebMvcTest` 的自動設定切片** | `@WebMvcTest` vs `@DataJpaTest` vs `@SpringBootTest` |
| **`@WebMvcTest(controllers = ...)` 的值** | ★ **不同的 controller 清單 = 不同的 context** |
| **bean override 的定義集合** | ★★ **`@MockitoBean` / `@MockBean` / `@MockitoSpyBean`** |

**最後兩項是實務上 90% 的 context 爆炸來源。**

**具體示範**：

```java
@WebMvcTest(OrderController.class)
@MockitoBean OrderService orderService;                       // → context #1

@WebMvcTest(OrderController.class)
@MockitoBean OrderService orderService;
@MockitoBean OrderQueryService orderQueryService;             // → context #2 ★ 多一個 mock

@WebMvcTest(OrderController.class)
@MockitoBean OrderQueryService orderQueryService;
@MockitoBean OrderService orderService;                       // → context #2（順序無關，是 Set）

@WebMvcTest({OrderController.class, OrderItemController.class})
@MockitoBean OrderService orderService;                       // → context #3 ★ controller 清單不同
```

**shop-service 的解法：一個基底類別，固定一組 mock。**

```java
package example.shop.test;

import example.shop.order.service.OrderQueryService;
import example.shop.order.service.OrderService;
import example.shop.product.service.ProductImageService;
import example.shop.order.service.OrderReceiptService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

/**
 * 所有 Web 層切片測試的基底。
 *
 * <p>★★ 這個類別的設計目標只有一個：**讓所有切片測試共用同一個 context**。
 *
 * <p>做法：
 * <ol>
 *   <li>不寫 @WebMvcTest(controllers = ...) —— 載入**全部** Controller。
 *       這讓「controller 清單」這一項快取鍵永遠一樣。</li>
 *   <li>把**所有** Controller 需要的 Service 一次全部 @MockitoBean 在這裡。
 *       這讓「mock 定義集合」這一項永遠一樣。</li>
 *   <li>固定 profile 與 property。</li>
 * </ol>
 *
 * <p>成本：context 大一點（218 → 260 個 bean），啟動 1.5 s → 1.9 s。
 * <p>效益：**60 個 context → 1 個**。60 × 1.5 s = 90 s 變成 1.9 s。
 *
 * <p>⚠️ 取捨：載入全部 Controller 意味著「別的 Controller 的 bug 會讓你的測試
 *    啟動失敗」。這在小團隊是可接受的（而且那本來就該修）；
 *    在幾百個 Controller 的專案裡，改成「一個模組一個基底類別」。
 */
@WebMvcTest                                  // ★ 沒有 controllers 參數 = 全部
@AutoConfigureMockMvc                        // ★ 明確寫出來（addFilters 預設 true）
@Import(WebSliceInfraConfig.class)
@ActiveProfiles("test")
public abstract class WebSliceTest {

    @Autowired protected MockMvc mockMvc;
    @Autowired protected com.fasterxml.jackson.databind.ObjectMapper objectMapper;

    // ── 所有 Controller 的 Service 依賴（依模組分組）────────────────
    @MockitoBean protected OrderService orderService;
    @MockitoBean protected OrderQueryService orderQueryService;
    @MockitoBean protected OrderReceiptService orderReceiptService;
    @MockitoBean protected example.shop.order.service.OrderExportService orderExportService;
    @MockitoBean protected example.shop.order.service.DownloadTokenService downloadTokenService;
    @MockitoBean protected example.shop.order.service.SseEmitterRegistry sseEmitterRegistry;
    @MockitoBean protected example.shop.order.service.OrderEventReplayService replayService;
    @MockitoBean protected example.shop.order.service.ReturnService returnService;
    @MockitoBean protected example.shop.product.service.ProductService productService;
    @MockitoBean protected ProductImageService productImageService;
    @MockitoBean protected example.shop.product.service.PresignedUploadService presignedUploadService;
    @MockitoBean protected example.shop.cart.service.CartService cartService;
    @MockitoBean protected example.shop.payment.service.PaymentService paymentService;
    @MockitoBean protected example.shop.coupon.service.CouponService couponService;

    /** 06 章 6.5.8 的 label 解析需要 MessageSource —— 那個是真的 bean，不 mock。 */
}
```

⚠️ **這個基底類別有一個常見的反對意見**：

> 「我的測試只用到 `OrderService`，為什麼要背 13 個 mock？」

因為 **mock 的成本是「建一個 proxy」，大約 0.1 ms；
而多一個 context 的成本是 1,500 ms。差 15,000 倍。**

**驗證效果的測試**（把 context 數量本身變成一個斷言）：

```java
package example.shop.arch;

import org.junit.jupiter.api.Test;
import org.springframework.test.context.cache.ContextCacheUtils;

/**
 * ⚠️ 這個測試比較特別：它只在「跑完整套測試」時有意義，
 *    所以標記 @Tag("ci-only") 並排在最後（7.13.1）。
 *
 * <p>怎麼取得 context 數量：Spring 沒有公開 API，
 *    但 DEBUG 等級的 log 有。所以正式做法是在 CI 解析 log ——
 *    見 scripts/check-context-count.sh（7.13.3）。
 */
class ContextCountBudgetTest {
    // 實作見 7.13.3
}
```

**更實用的做法：在 CI 加一個 log 檢查。**

```bash
#!/usr/bin/env bash
# scripts/check-context-count.sh
#
# 從測試的 log 裡抽出 Spring context 的 miss 次數，超過預算就失敗。
#
# ★ 為什麼是「預算」而不是「固定值」：
#   新增測試類別時難免會多一兩個 context，
#   但從 6 變成 30 一定是有人不小心加了 @MockBean 或 @TestPropertySource。
set -euo pipefail

BUDGET="${CONTEXT_BUDGET:-8}"
LOG="${1:-target/surefire-reports/context-cache.log}"

if [[ ! -f "$LOG" ]]; then
  echo "找不到 $LOG —— 確認 logging.level.org.springframework.test.context.cache=DEBUG"
  exit 1
fi

# 取最後一次列印的統計
MISS=$(grep -o 'missCount = [0-9]*' "$LOG" | tail -1 | grep -o '[0-9]*')
HIT=$(grep -o 'hitCount = [0-9]*' "$LOG" | tail -1 | grep -o '[0-9]*')

echo "Spring context：建立 ${MISS} 次，快取命中 ${HIT} 次"

if (( MISS > BUDGET )); then
  cat <<MSG

🔴 建立了 ${MISS} 個 Spring context，預算是 ${BUDGET}。

每個 context 約 1.5～3 秒。常見原因（依可能性排序）：
  1. 某個測試類別自己加了 @MockitoBean，沒有繼承 WebSliceTest
  2. @SpringBootTest(properties = ...) 各寫各的 —— 合併成一個 profile
  3. @TestPropertySource 用了不同的 locations
  4. @DirtiesContext —— 幾乎總是有更好的做法（7.13.4）
  5. @ActiveProfiles 的組合不同

查出兇手：
  grep -rlE '@(MockitoBean|MockBean|TestPropertySource|DirtiesContext)' src/test/java \\
    | xargs grep -l -v 'extends WebSliceTest'
MSG
  exit 1
fi
```

**三個「不要為了省 context 而做」的事**：

| 不要 | 為什麼 |
|---|---|
| 把 ④ `@SpringBootTest` 也合併進基底類別 | 整合測試本來就該少（20～40 個），而它們的差異（真的 port、真的 Redis）是本質的 |
| 為了共用 context 而把 `@MockitoBean` 換成 `@TestConfiguration` 裡的 mock | 那樣 mock 不會在每個測試方法後重設 → 7.2.4 的狀態洩漏 |
| 用 `@DirtiesContext` 解決「測試互相影響」 | 那是把成本從「找出真正的洩漏」轉移到「每次重建 context」 |

### 7.4.6 ② standalone 的定位：一個「幾乎不用」的工具

`MockMvcBuilders.standaloneSetup()` 不啟動 Spring context：

```java
MockMvc mockMvc = MockMvcBuilders
        .standaloneSetup(new OrderController(orderService, mapper))
        .setControllerAdvice(new ApiExceptionHandler(problemFactory, errorLogger))
        .setCustomArgumentResolvers(new CurrentActorArgumentResolver())
        .setMessageConverters(new MappingJackson2HttpMessageConverter(objectMapper))
        .addInterceptors(new PageableGuardInterceptor())
        .build();
```

**優點**：3 ms 一個測試，沒有 context 快取問題。

**而 shop-service 幾乎不用它。三個理由**：

**理由一：你必須手動重建你的設定，而那份設定會腐化。**

```java
// 正式環境（06 章 MessageConverterConfig）
@Override
public void extendMessageConverters(List<HttpMessageConverter<?>> converters) {
    converters.add(0, csvConverter);
    // ... 還有 4 個調整
}

// standalone 測試裡
.setMessageConverters(new MappingJackson2HttpMessageConverter(objectMapper))
//  🔴 沒有 CSV converter、沒有 ResourceRegion（Range）、順序也不同
```

**「測試裡的組裝」與「正式環境的組裝」是兩份程式碼，它們一定會分岔。**
而分岔的時候測試不會紅 —— 它會**繼續綠，但測的是別的東西**。

**理由二：`@WebMvcTest` 加上 7.4.5 的基底類別之後，成本差異縮小到不重要。**

```
standalone：            3 ms/test，0 ms 啟動
@WebMvcTest（共用 context）：25 ms/test，1.9 s 一次

800 個切片測試：
  standalone：  2.4 s
  @WebMvcTest： 20 s + 1.9 s = 21.9 s
```

**差 19 秒。** 而那 19 秒買到的是「測的是真的設定」。

**理由三：它測不到 03～06 章一半的內容。**

| 前六章的成果 | standalone 測得到？ |
|---|---|
| `spring.jackson.*` 的 20 項設定 | ✗（除非手動組 `ObjectMapper` —— 那就是理由一） |
| `MessageSource` 的錯誤訊息 i18n | ✗ |
| `Converter` 的註冊 | 部分（要手動加） |
| filter | ✗（完全沒有） |
| CORS | ✗ |
| 內容協商的完整演算法 | 部分 |

**那 standalone 什麼時候有用？**

**一種情況：測試一個「與設定無關的 MVC 機制本身」。**

```java
/**
 * 測試 PageableGuardInterceptor 的行為（04 章 4.7）。
 *
 * <p>★ 這裡用 standalone 是對的，因為：
 *    - 這個 interceptor 的行為與 Jackson、filter、CORS 都無關
 *    - 但它需要「有 handler method」才能運作（所以不能用純單元測試）
 *    - 需要覆蓋 22 種參數組合 → 3 ms × 22 比 25 ms × 22 有意義
 *
 * <p>並且刻意用一個**測試專用的 controller** ——
 * 這讓測試不會因為 OrderController 改簽名而壞掉。
 */
class PageableGuardInterceptorTest {

    @RestController
    static class ProbeController {
        @GetMapping("/probe")
        String probe(@ModelAttribute PageQuery query) { return "ok"; }
    }

    private final MockMvc mockMvc = MockMvcBuilders
            .standaloneSetup(new ProbeController())
            .addInterceptors(new PageableGuardInterceptor(new ApiLimitProperties(100, 10_000)))
            .setControllerAdvice(new TestOnlyProblemAdvice())
            .build();

    @ParameterizedTest
    @CsvSource({
            "  1,  20, 200",
            "  1, 100, 200",
            "  1, 101, 422",      // 硬上限
            "500,  20, 200",
            "501,  20, 422",      // 深分頁上限
            "  0,  20, 422",
            " -1,  20, 422",
    })
    void 分頁參數的邊界(int page, int size, int expectedStatus) throws Exception {
        mockMvc.perform(get("/probe").param("page", String.valueOf(page))
                        .param("size", String.valueOf(size)))
                .andExpect(status().is(expectedStatus));
    }
}
```

⚠️ **注意 `TestOnlyProblemAdvice`** —— standalone 裡沒有你的 advice，
所以例外會變成 500 或直接拋出。你得自己提供一個最小的 advice，
**而那又是一份「與正式環境不同的組裝」**。這就是理由一的具體形狀。

> **結論：`@WebMvcTest` 是預設答案。standalone 是一個特例工具，
> 用它的時候要在註解裡寫下「為什麼這裡不需要真的設定」。**

---
## 7.5 MockMvc 完整語法地圖

### 7.5.1 三段結構

```java
mockMvc.perform( 請求 )            // ① MockHttpServletRequestBuilder
       .andExpect( 斷言 )          // ② ResultMatcher（可以串很多個）
       .andExpect( 斷言 )
       .andDo( 副作用 )            // ③ ResultHandler（印出、寫文件）
       .andReturn();               // ④ MvcResult（要做複雜斷言時）
```

**四段各自的職責與「什麼時候該跳到下一段」**：

| 段 | 用來 | 什麼時候不夠用 |
|---|---|---|
| `perform` | 組請求 | —— |
| `andExpect` | **95% 的斷言** | 需要「先解析 body 再算」的斷言 |
| `andDo` | 印出、產文件 | —— |
| `andReturn` | 拿到 `MvcResult` 做任意斷言 | —— |

⚠️ **一個常見的錯誤選擇**：一律 `andReturn()` 然後用 AssertJ 斷言。

```java
// ⚠️ 可以，但失去了 MockMvc 的錯誤訊息
String json = mockMvc.perform(get("/orders/ord_1")).andReturn()
        .getResponse().getContentAsString();
assertThat(json).contains("\"status\":\"PAID\"");
```

失敗時的訊息：

```
Expecting actual:
  "{"type":"https://api.shop.example/problems/resource-not-found","title":...
to contain:
  ""status":"PAID""
```

**而用 `andExpect` 的話**：

```
java.lang.AssertionError: Status expected:<200> but was:<404>
MockHttpServletResponse:
           Status = 404
    Error message = null
          Headers = [Content-Type:"application/problem+json", X-Trace-Id:"4f2c..."]
     Content type = application/problem+json
             Body = {"type":"...resource-not-found","status":404,"code":"RESOURCE_NOT_FOUND",...}
    Forwarded URL = null
   Redirected URL = null
          Cookies = []
```

**MockMvc 的失敗訊息會把整個請求與回應印出來。** 那通常直接告訴你原因。

> **原則：能用 `andExpect` 表達的就用它。`andReturn()` 留給「需要計算」的斷言。**

### 7.5.2 `MockMvcRequestBuilders` 全覽

```java
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;

get("/orders")
get("/orders/{orderId}", "ord_01J5GK")            // ★ URI template（變數會被編碼）
post("/orders")
put("/orders/ord_1")
patch("/orders/ord_1")
delete("/orders/ord_1")
head("/orders/ord_1")
options("/orders")
request(HttpMethod.valueOf("PURGE"), "/cache")     // 非標準方法
multipart("/products/P-1001/images")               // 05 章
multipart(HttpMethod.PUT, "/products/P-1001/images/img_1")   // ★ PUT 的 multipart
asyncDispatch(mvcResult)                           // 05 章、7.5.6
```

**`MockHttpServletRequestBuilder` 的設定方法**（按使用頻率排序）：

```java
post("/orders")
    // ── body ────────────────────────────────────────────────
    .contentType(MediaType.APPLICATION_JSON)
    .content(jsonString)                   // String 或 byte[]
    .characterEncoding(StandardCharsets.UTF_8)   // ★ 中文 body 建議明寫

    // ── 標頭 ────────────────────────────────────────────────
    .accept(MediaType.APPLICATION_JSON, MediaType.parseMediaType("text/csv;q=0.8"))
    .header("Idempotency-Key", "idem-01J5GK")
    .header("If-Match", "\"v7\"")
    .headers(httpHeaders)                  // 一次給一批

    // ── 參數 ────────────────────────────────────────────────
    .param("page", "1")                    // ⚠️ 見下方陷阱
    .params(multiValueMap)
    .queryParam("status", "PAID", "SHIPPED")   // ★ 也會寫進 query string

    // ── cookie / session / locale ──────────────────────────
    .cookie(new Cookie("theme", "dark"))
    .locale(Locale.TAIWAN)                 // ★ 測 i18n 訊息時必要
    .sessionAttr("key", value)

    // ── 更底層的調整 ────────────────────────────────────────
    .with(request -> {                     // ★ RequestPostProcessor：任意修改
        request.setRemoteAddr("203.0.113.7");
        return request;
    })
```

**★ 陷阱一：`.param()` 不會產生 query string。**

```java
mockMvc.perform(get("/orders").param("status", "PAID"))
```

```java
request.getParameter("status")   // → "PAID"   ✅
request.getQueryString()          // → null     🔴
```

**這會讓兩個 shop-service 的元件靜默失效**：

| 元件 | 章節 | 它讀什麼 | 後果 |
|---|---|---|---|
| `QueryMasker` | 5.10.6 | `request.getQueryString()` | 遮蔽測試看到的是 `null`，測試「通過」但什麼都沒測 |
| `RequestLoggingFilter` 的 URL 欄位 | 4.6 | `getQueryString()` | log 裡沒有參數，斷言 log 內容的測試失敗且原因難找 |

**兩個修法**：

```java
// 修法 A（推薦）：把參數寫在 URI 裡
mockMvc.perform(get("/orders?status=PAID&page=2"))

// 修法 B：用 queryParam（它同時填參數 map 與 query string）
mockMvc.perform(get("/orders").queryParam("status", "PAID"))
```

⚠️ **修法 A 有一個副作用**：URI 裡的值**不會**被自動編碼。
中文或特殊字元要自己編：

```java
// 🔴 錯：空白讓 URI 解析出問題
mockMvc.perform(get("/products?q=無線 滑鼠"))

// ✅ 用 URI template —— 變數會被編碼
mockMvc.perform(get("/products?q={q}", "無線 滑鼠"))
//  → /products?q=%E7%84%A1%E7%B7%9A%20%E6%BB%91%E9%A0%A0
```

**而這正好是測試「參數編碼」的正確工具**：

```java
@Test
void 查詢字串的中文與特殊字元() throws Exception {
    // ★ 一次覆蓋 URL 編碼、Jackson、以及 06 章的 StringToInstantConverter
    mockMvc.perform(get("/products?q={q}&createdAfter={t}",
                    "無線滑鼠 & 鍵盤 100%", "2026-08-01T00:00:00Z"))
            .andExpect(status().isOk());

    var captor = ArgumentCaptor.forClass(ProductFilter.class);
    verify(productService).search(captor.capture());
    assertThat(captor.getValue().q()).isEqualTo("無線滑鼠 & 鍵盤 100%");   // ★
}
```

**★ 陷阱二：`.param()` 對 `POST` 表單與 query 不分。**

真實的 Servlet 容器對 `POST` + `application/x-www-form-urlencoded` 會把 body
解析進 parameter map；MockMvc 的 `.param()` 直接放進 map，
**所以你分不出「這個參數來自 query 還是 body」**。

這對 shop-service 影響不大（API 不收表單），
但如果你有一個「只接受 query 不接受 body 參數」的規則，那個規則測不到。

**★ 陷阱三：`.with()` 是修改 request 的萬用逃生門。**

```java
/**
 * 04 章 4.5 的 ClientIpResolver 需要 remoteAddr 與 X-Forwarded-For。
 * MockMvc 的預設 remoteAddr 是 "127.0.0.1"。
 */
static RequestPostProcessor fromIp(String ip) {
    return request -> {
        request.setRemoteAddr(ip);
        return request;
    };
}

@Test
void 限流依IP計算() throws Exception {
    for (int i = 0; i < 100; i++) {
        mockMvc.perform(get("/products").with(fromIp("203.0.113.7")))
                .andExpect(status().isOk());
    }
    // 第 101 次
    mockMvc.perform(get("/products").with(fromIp("203.0.113.7")))
            .andExpect(status().isTooManyRequests())
            .andExpect(header().string("Retry-After", notNullValue()));

    // ★ 另一個 IP 不受影響 —— 這個斷言證明「桶是依 IP 分的」
    mockMvc.perform(get("/products").with(fromIp("203.0.113.8")))
            .andExpect(status().isOk());
}
```

⚠️ 這個測試需要 7.4.4 的 `InMemoryRateLimiter`（真的實作）——
如果 `RateLimiter` 是 mock，`tryConsume` 回傳 `null` → NPE。**7.6.3 的主題。**

### 7.5.3 `MockMvcResultMatchers` 全覽

```java
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

// ── 狀態碼 ──────────────────────────────────────────────────
status().isOk()                       // 200
status().isCreated()                  // 201
status().isNoContent()                // 204
status().isBadRequest()               // 400
status().isUnauthorized()             // 401
status().isForbidden()                // 403
status().isNotFound()                 // 404
status().isConflict()                 // 409
status().isPreconditionFailed()       // 412
status().isPayloadTooLarge()          // 413
status().isUnsupportedMediaType()     // 415
status().isUnprocessableEntity()      // 422
status().isTooManyRequests()          // 429
status().isInternalServerError()      // 500
status().is(428)                      // ★ 沒有專用方法的（Precondition Required）
status().is2xxSuccessful()
status().is4xxClientError()
status().is5xxServerError()
status().isNotModified()              // 304
status().reason("...")                // ⚠️ 只有 sendError 才有 reason

// ── 標頭 ────────────────────────────────────────────────────
header().string("Location", "/orders/ord_01J5GK")
header().string("Cache-Control", containsString("no-store"))    // ★ 可以用 hamcrest
header().exists("ETag")
header().doesNotExist("X-Powered-By")                           // ★ 資訊洩漏
header().longValue("Content-Length", 1234L)
header().dateValue("Last-Modified", epochMillis)
header().stringValues("Vary", "Origin", "Accept-Encoding")      // ★ 多值標頭

// ── 內容 ────────────────────────────────────────────────────
content().contentType("application/problem+json")
content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON) // ★ 忽略 charset
content().encoding("UTF-8")
content().string("ok")
content().string(containsString("PAID"))
content().bytes(expectedBytes)
content().json(expectedJson)                                     // ★ 見下方
content().json(expectedJson, true)                               // strict
content().xml(expectedXml)

// ── JSON path ───────────────────────────────────────────────
jsonPath("$.orderId").value("ord_01J5GK")
jsonPath("$.items", hasSize(2))
jsonPath("$.total").exists()
jsonPath("$.password").doesNotExist()                            // ⚠️ 見 7.5.4
jsonPath("$.items[*].productId", containsInAnyOrder("P-1", "P-2"))

// ── 例外（★ 03 章的 advice 測試很有用）─────────────────────
// 這不是 matcher，而是從 MvcResult 拿
result -> assertThat(result.getResolvedException())
              .isInstanceOf(InsufficientStockException.class)

// ── 非同步 ──────────────────────────────────────────────────
request().asyncStarted()
request().asyncNotStarted()
request().asyncResult(expectedValue)

// ── handler（★ 測「路由對了嗎」）──────────────────────────
handler().handlerType(OrderController.class)
handler().methodName("create")

// ── cookie / redirect / forward ─────────────────────────────
cookie().value("SESSION", "abc")
cookie().httpOnly("SESSION", true)
redirectedUrl("/orders/")
redirectedUrlPattern("/orders/*")
forwardedUrl("/error")                                           // ★ 03 章 ApiErrorController
```

**`handler()` 的實用價值：測試路由衝突（01 章 1.3）。**

```java
/**
 * 01 章 1.3 的路由優先順序：
 *   /orders/summary  應該進 summary()，不是 get(@PathVariable orderId)
 *
 * <p>★ 如果沒有 handler() 這個 matcher，這個測試要靠
 *    「回應內容看起來像 summary」來判斷 —— 那是間接證據。
 */
@Test
void 靜態路徑贏過路徑變數() throws Exception {
    mockMvc.perform(get("/orders/summary"))
            .andExpect(handler().handlerType(OrderController.class))
            .andExpect(handler().methodName("summary"));          // ★ 直接證據
}
```

**`content().json()` 的兩種模式**：

```java
String expected = """
        {"orderId":"ord_01J5GK","status":"PAID","totalAmount":"1280.50"}
        """;

// 模式 1（預設）：LENIENT —— 「期望的欄位都在且相符」，多的欄位不管
content().json(expected)

// 模式 2：STRICT —— 「欄位必須完全一致」，多一個就失敗
content().json(expected, true)
```

**兩者的用途完全不同**：

| 模式 | 用在 | 理由 |
|---|---|---|
| LENIENT | 大部分測試 | 新增欄位不會弄壞一堆測試 |
| **STRICT** | **「回應不可以多欄位」的測試** ★ | 06 章 6.7.5 的資訊洩漏防護 —— 多一個 `internalCostPrice` 就要紅燈 |

```java
/**
 * ★ 這個測試的價值在 STRICT。
 *
 * <p>它守住的是「有人在 OrderDetail 加了一個欄位，
 *    而那個欄位不該給客戶看」——
 *    06 章 6.7.5 的資訊洩漏清單的可執行版本。
 */
@Test
void 客戶看到的訂單明細只有這些欄位() throws Exception {
    when(orderQueryService.findDetail(any(), any())).thenReturn(fullDetail());

    mockMvc.perform(get("/orders/ord_01J5GK"))
            .andExpect(content().json("""
                    {
                      "orderId": "ord_01J5GK",
                      "orderNumber": "ORD-20260824-0001",
                      "status": "PAID",
                      "statusLabel": "已付款",
                      "totalAmount": "1280.50",
                      "currency": "TWD",
                      "items": [ { "productId":"P-1001","name":"無線滑鼠",
                                   "quantity":1,"unitPrice":"1280.50" } ],
                      "shippingAddress": { "recipientName":"王小明",
                                           "maskedPhone":"0912****78",
                                           "line1":"台北市中正區重慶南路一段 122 號" },
                      "createdAt": "2026-08-24T02:30:00.000Z"
                    }
                    """, true));       // ★★ STRICT
}
```

⚠️ **STRICT 的代價**：新增一個正當的欄位時，這個測試會紅。
**那是刻意的** —— 它強迫你在 PR 裡明確說「這個欄位可以給客戶看」。

⚠️ **`content().json()` 用的是 JSONAssert**，需要
`org.skyscreamer:jsonassert` 在 test classpath 上
（`spring-boot-starter-test` 已包含）。

> Spring 6.2 起 `content().json(expected, JsonCompareMode.STRICT)` 取代布林參數 ——
> 語意一樣，只是可讀性更好。

---
### 7.5.4 `jsonPath` 的六個陷阱

**陷阱一：`.value(1)` 的型別。**

```json
{ "errorCount": 3, "totalAmount": "1280.50", "weight": 0.5 }
```

```java
jsonPath("$.errorCount").value(3)      // ✅ Integer
jsonPath("$.errorCount").value(3L)     // 🔴 失敗！expected Long, actual Integer
jsonPath("$.errorCount").value(3.0)    // 🔴 失敗
```

**原因**：Jayway JsonPath 把 JSON 數字解析成 `Integer`（塞得進去的話）或
`Long` / `Double` / `BigDecimal`（依 `use-big-decimal-for-floats`）。
`value(Object)` 用 `equals` 比較，而 `Integer.valueOf(3).equals(3L)` 是 `false`。

**三個安全的寫法**：

```java
jsonPath("$.errorCount").value(3)                      // 讓型別自然匹配
jsonPath("$.errorCount", is(3))                        // hamcrest，同樣要對型別
jsonPath("$.errorCount").value(Matchers.comparesEqualTo(3))   // ★ 忽略型別的比較
```

⚠️ **06 章 6.5.7 的決定讓這個陷阱少了一大半**：
**金額是字串**，所以 `jsonPath("$.totalAmount").value("1280.50")` ——
字串比較不會有型別問題。**那個決定的一個附帶好處。**

**陷阱二：`doesNotExist()` 分不出「沒有這個欄位」與「值是 null」。**

```java
// 回應 A：{"couponCode": null}
// 回應 B：{}

jsonPath("$.couponCode").doesNotExist()   // A 通過、B 通過   ← 分不出來
jsonPath("$.couponCode").exists()          // A 失敗、B 失敗   ← 也分不出來
```

**這對 06 章 6.5.9 是致命的**：
`default-property-inclusion: non_null` 的整個決定就是
「**沒送的欄位不出現**，而不是出現成 `null`」——
而上面那兩個 matcher 都驗證不了這件事。

**正確的做法：斷言原始的 JSON 結構。**

```java
package example.shop.test;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.test.web.servlet.MvcResult;

import java.nio.charset.StandardCharsets;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

public final class JsonAssertions {

    private JsonAssertions() {}

    /**
     * 把回應解析成 Map，用來斷言「欄位存在性」。
     *
     * <p>★ 為什麼需要這個：jsonPath 的 exists/doesNotExist
     *    分不出「缺欄位」與「值為 null」（07 章 7.5.4）。
     */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> asMap(MvcResult result, ObjectMapper mapper)
            throws Exception {
        // ★★ 一定要指定 UTF-8 —— 見 7.5.4 陷阱五
        String body = result.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return mapper.readValue(body, Map.class);
    }

    /** 斷言 JSON 裡「完全沒有」這個 key。 */
    public static void assertKeyAbsent(Map<String, Object> json, String key) {
        assertThat(json)
                .as("JSON 應該完全沒有 '%s' 這個 key（non_null 的意義），"
                    + "但它存在，值是 %s", key, json.get(key))
                .doesNotContainKey(key);
    }

    /** 斷言 JSON 裡「有這個 key 且值是 null」。 */
    public static void assertKeyPresentAndNull(Map<String, Object> json, String key) {
        assertThat(json).containsKey(key);
        assertThat(json.get(key))
                .as("'%s' 應該是明確的 null（@JsonInclude(ALWAYS) 的意義）", key)
                .isNull();
    }
}
```

```java
/**
 * 06 章 6.5.9 的三種狀態，一個測試分清楚。
 */
@Test
void 選填欄位沒值時不出現_但關鍵欄位一定出現() throws Exception {
    when(orderQueryService.findDetail(any(), any()))
            .thenReturn(detailWithoutCoupon());

    MvcResult result = mockMvc.perform(get("/orders/ord_1"))
            .andExpect(status().isOk())
            .andReturn();

    var json = JsonAssertions.asMap(result, objectMapper);

    // ① 選填欄位沒值 → 完全不出現（non_null）
    JsonAssertions.assertKeyAbsent(json, "couponCode");
    JsonAssertions.assertKeyAbsent(json, "cancelledAt");

    // ② 關鍵欄位即使是 null 也要出現（@JsonInclude(ALWAYS)，6.5.9）
    JsonAssertions.assertKeyPresentAndNull(json, "shippedAt");

    // ③ 集合永不為 null（6.5.9）—— 是 []，不是 null，也不是缺欄位
    assertThat(json).containsKey("items");
    assertThat((java.util.List<?>) json.get("items")).isEmpty();
}
```

**陷阱三：`hasSize()` 的來源是 hamcrest，不是 AssertJ。**

```java
import static org.hamcrest.Matchers.hasSize;        // ✅ 對的
import static org.assertj.core.api.Assertions.*;    // AssertJ 沒有 hasSize matcher
```

```java
jsonPath("$.items", hasSize(2))       // ✅
jsonPath("$.items.length()").value(2) // ✅ 另一種寫法（JsonPath 的函式）
jsonPath("$.items").value(hasSize(2)) // ✅ 也可以
```

**陷阱四：陣列的順序。**

```java
// 🔴 依賴順序 —— 02 章的 errors[] 排序規則改了就壞
jsonPath("$.errors[0].field").value("items[0].quantity")
jsonPath("$.errors[1].field").value("shippingAddressId")

// ✅ 不依賴順序
jsonPath("$.errors[*].field",
         containsInAnyOrder("items[0].quantity", "shippingAddressId"))

// ✅ 依賴順序，但明確說出為什麼
// 02 章 2.9.4：errors[] 依「欄位在 DTO 的宣告順序」排序，這是契約的一部分
jsonPath("$.errors[*].field",
         contains("items[0].quantity", "shippingAddressId"))  // contains = 有序
```

⚠️ **`containsInAnyOrder` 是「剛好這些、不管順序」，
`contains` 是「剛好這些、依這個順序」，
`hasItems` 是「至少包含這些」。三個都要會分。**

**用 filter 表達式做「找出那一筆」的斷言**：

```java
// ★ 這個寫法對「一次回報多個錯誤」特別好用（02 章 2.9）
jsonPath("$.errors[?(@.field=='items[0].quantity')].code")
        .value(hasItem("Min"))
jsonPath("$.errors[?(@.field=='shippingAddress')]", hasSize(1))
```

**陷阱五：中文亂碼。**

```java
String body = result.getResponse().getContentAsString();     // 🔴 可能亂碼
```

`MockHttpServletResponse.getContentAsString()` 用**回應的 character encoding**；
沒設定時預設是 `ISO-8859-1`（Servlet 規範）。

```java
String body = result.getResponse().getContentAsString(StandardCharsets.UTF_8);  // ✅
```

**實務上通常不會出事，因為 Jackson 的 converter 會把
`Content-Type: application/json` 連 charset 一起設進回應。**

**會出事的三種情況**：

| 情況 | 為什麼 |
|---|---|
| 你自訂的 converter 沒設 charset | 06 章 6.4.4 的 `CsvHttpMessageConverter` —— **必須設** |
| 用 `response.getWriter().write(...)` 手寫（03 章 `ProblemWriter`） | 要自己 `setCharacterEncoding("UTF-8")` |
| 回應是 `byte[]` 或 `Resource` | 本來就沒有 charset |

**所以 shop-service 有一個守門測試**：

```java
/**
 * ★ 所有文字類的回應都必須明確宣告 charset=UTF-8。
 *
 * <p>漏掉的症狀：Windows 上的客戶端看到亂碼、Mac 上正常
 *    （因為兩邊 JVM 的預設編碼不同）—— 一個很難查的 bug。
 */
@ParameterizedTest
@MethodSource("textEndpoints")
void 所有文字回應都宣告UTF8(String method, String uri) throws Exception {
    var result = mockMvc.perform(request(HttpMethod.valueOf(method), uri))
            .andReturn();

    String contentType = result.getResponse().getContentType();
    assertThat(contentType).isNotNull();

    if (contentType.startsWith("text/") || contentType.contains("json")
            || contentType.contains("xml")) {
        assertThat(result.getResponse().getCharacterEncoding())
                .as("%s %s 的 Content-Type 是 %s，但沒有宣告 UTF-8", method, uri, contentType)
                .isEqualToIgnoringCase("UTF-8");
    }
}
```

**陷阱六：`jsonPath` 對「不存在的路徑」的錯誤訊息很難讀。**

```
java.lang.AssertionError: No value at JSON path "$.data.orderId"
```

**這句話有兩種可能**：`data` 不存在，或 `data` 存在但沒有 `orderId`。

**做法一：先斷言外層。**

```java
.andExpect(jsonPath("$.data").exists())              // ★ 先確認外層
.andExpect(jsonPath("$.data.orderId").value("ord_1"))
```

**做法二（更重要）：`status()` 永遠放第一個 `andExpect`。**

MockMvc 只有在 **`status()` 失敗時**才會把完整的請求與回應印出來。
而實務上「jsonPath 找不到」的原因有 90% 是狀態碼不對
（回了 Problem JSON，於是 `$.orderId` 當然不存在）。

```java
mockMvc.perform(get("/orders/ord_1"))
        .andExpect(status().isOk())                        // ★ 第一個
        .andExpect(jsonPath("$.orderId").value("ord_1"));
```

⚠️ **MockMvc 沒有內建「只在失敗時 print」。**
`andDo(print())` 是無條件的 —— 3,000 個測試會產生幾十 MB 的輸出，
CI 的 log 被截斷之後**真正失敗的那一個反而看不到**。

**三個實用的替代方案**：

| 方案 | 做法 |
|---|---|
| **A（推薦）** | `status()` 放第一個 + 用 `as()` 把關鍵資訊寫進訊息 |
| B | 本機除錯時臨時加 `andDo(print())`，**不要 commit** |
| C | 升級到 Boot 3.4 後改用 `MockMvcTester`（7.5.10）—— 它每個斷言失敗都印全部 |

**方案 A 的具體形狀**：

```java
mockMvc.perform(get("/orders/{id}", orderId))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.statusLabel").value("已付款"));
```

如果 `statusLabel` 失敗，訊息只有一句
`JSON path "$.statusLabel" expected:<已付款> but was:<null>` ——
**而那一句已經足夠**：`null` 代表 `StatusLabelResolver` 沒找到 label
（06 章 6.5.8），去看 `error-messages_zh_TW.properties` 就對了。

> **教訓：斷言的粒度要細到「失敗訊息本身就是診斷」。**
> 一個斷言檢查十件事的話，失敗訊息只會說「不一樣」。

### 7.5.5 `andDo`：印出、記錄、產文件

```java
import static org.springframework.test.web.servlet.result.MockMvcResultHandlers.*;

.andDo(print())                          // 印到 System.out
.andDo(print(System.err))                // 印到別的地方
.andDo(log())                            // 用 Commons Logging 的 DEBUG
.andDo(result -> { /* 任意程式碼 */ })
.andDo(document("orders-create"))        // ★ Spring REST Docs（7.10.3）
```

**`andDo` 的一個實用場景：讓文件的 example 由測試產生。**

03-rest-api 的 `orders-api.yaml` 需要每個端點的 example，
而手寫的 example 一定會跟實作分岔。

```java
/**
 * ★ 產生「文件用的範例回應」。
 *
 * <p>用 @Tag 隔開，平常不跑（7.13.1）。
 */
@Test
@Tag("generate-examples")
void 產生訂單明細的範例回應() throws Exception {
    when(orderQueryService.findDetail(any(), any())).thenReturn(fullDetail());

    mockMvc.perform(get("/orders/ord_01J5GK"))
            .andExpect(status().isOk())
            .andDo(result -> {
                String pretty = objectMapper
                        .writerWithDefaultPrettyPrinter()
                        .writeValueAsString(objectMapper.readTree(
                                result.getResponse()
                                      .getContentAsString(StandardCharsets.UTF_8)));
                java.nio.file.Files.createDirectories(
                        java.nio.file.Path.of("target/examples"));
                java.nio.file.Files.writeString(
                        java.nio.file.Path.of("target/examples/order-detail.json"), pretty);
            });
}
```

然後在 CI 比較 `target/examples/` 與 `docs/examples/` ——
**不一致就代表「文件的 example 過期了」**。

```bash
# scripts/check-doc-examples.sh
set -euo pipefail
./mvnw -q test -Dgroups=generate-examples
if ! diff -ru docs/examples target/examples; then
  cat <<'MSG'

🔴 文件裡的範例回應與實際回應不一致。

修法：
  cp -r target/examples/* docs/examples/
  git add docs/examples && git commit -m "docs: 更新範例回應"

⚠️ 在複製之前先看 diff —— 如果差異是「多了一個敏感欄位」，
   那不是文件過期，是實作洩漏了東西（06 章 6.7.5）。
MSG
  exit 1
fi
```

### 7.5.6 非同步：`asyncDispatch` 的完整流程

05 章已經用過它，這裡把**機制**講清楚。

**真實容器的非同步請求生命週期**（04 章 4.12.2）：

```
① 請求進來 → Tomcat 工作執行緒
② Controller 回傳 StreamingResponseBody / Callable / CompletableFuture / SseEmitter
③ Spring 呼叫 request.startAsync() → ★ 工作執行緒被釋放
④ 結果在別的執行緒產生
⑤ 結果好了 → 派發一個「ASYNC dispatch」→ 又佔一個工作執行緒
⑥ 這次 dispatch 走完 filter chain（★ 所以 filter 會跑第二次）→ 寫出回應
```

**MockMvc 把 ③ 和 ⑤ 之間切開了，要你自己接上**：

```java
// ── 第一次 perform：走到 ③ ──────────────────────────────
MvcResult started = mockMvc.perform(get("/orders.csv").accept("text/csv"))
        .andExpect(request().asyncStarted())     // ★ 斷言真的走了非同步
        .andReturn();

// ★ 這個時候：
//   started.getResponse().getContentAsString()  → ""（還沒有內容）
//   started.getResponse().getStatus()           → 200（狀態已定）

// ── 等結果（④）─────────────────────────────────────────
Object asyncResult  = started.getAsyncResult();          // 預設等 1 秒
Object asyncResult2 = started.getAsyncResult(5_000);     // 自訂逾時（毫秒）

// ── 第二次 perform：走 ⑤⑥ ──────────────────────────────
mockMvc.perform(asyncDispatch(started))
        .andExpect(status().isOk())
        .andExpect(content().contentTypeCompatibleWith("text/csv"))
        .andExpect(content().string(containsString("訂單編號,狀態,金額")));
```

**六種非同步回傳型別在 MockMvc 裡的差異**：

| 回傳型別 | `asyncStarted()` | `getAsyncResult()` 回傳 | `asyncDispatch` 後的 body |
|---|---|---|---|
| `Callable<T>` | ✅ | `T` | 序列化後的 `T` |
| `CompletableFuture<T>` | ✅ | `T` | 序列化後的 `T` |
| `DeferredResult<T>` | ✅ | `T`（要有人 `setResult`，否則逾時） | 序列化後的 `T` |
| **`StreamingResponseBody`** | ✅ | ⚠️ **它自己**（不是內容） | ✅ 完整的串流內容 |
| **`SseEmitter`** | ✅ | ⚠️ **它自己** | 已經送出的事件（7.5.8） |
| `ResponseEntity<StreamingResponseBody>` | ✅ | `ResponseEntity` | 完整內容 |

⚠️ **`StreamingResponseBody` 的 `getAsyncResult()` 回傳的是那個 lambda 本身**，
所以不要試著斷言它的內容 —— **要 `asyncDispatch` 之後看 body**。

**★ 一個 05 章沒細講的重點：filter 會跑兩次。**

```java
/**
 * 04 章 4.12.4 的「非同步破壞了哪些假設」的可執行版本。
 *
 * <p>⚠️ 它守住一個真實的 bug：
 *    TraceIdFilter 如果在 ASYNC dispatch 時又產生一個新的 traceId，
 *    同一個請求的 log 就會有兩個 traceId —— 追蹤斷掉。
 */
@Test
void 非同步的第二次dispatch不會產生新的traceId() throws Exception {
    MvcResult started = mockMvc.perform(get("/orders.csv").accept("text/csv"))
            .andExpect(request().asyncStarted())
            .andReturn();

    String traceIdAfterFirst = started.getResponse().getHeader("X-Trace-Id");
    assertThat(traceIdAfterFirst).isNotNull();

    MvcResult finished = mockMvc.perform(asyncDispatch(started)).andReturn();

    assertThat(finished.getResponse().getHeader("X-Trace-Id"))
            .as("""
                ASYNC dispatch 產生了新的 traceId。

                原因：OncePerRequestFilter 預設**會**在 ASYNC dispatch 時再跑一次
                機制（04 章 4.4.6）：
                  · shouldNotFilterAsyncDispatch() 【預設 true】（不在 ASYNC dispatch 執行）
                  · 但 TraceIdFilter 覆寫成 false（它要重建 MDC）
                  · 而 OncePerRequestFilter 的「已執行過」attribute
                    是在 finally 裡【移除】的 —— 所以它擋不住這次重跑

                修法（04 章 4.5.4）：
                  doFilterInternal 必須冪等 —— TraceIdFilter 用 resolveOnce()
                  把 traceId 存在 request attribute 上，重跑時沿用同一個值。
                """)
            .isEqualTo(traceIdAfterFirst);
}
```

> ### ⚠️⚠️ 這裡有兩層，很容易只記到一半 ★★
>
> **① `shouldNotFilterAsyncDispatch()` 預設回傳 `true`** ——
> 「**不要**在 ASYNC dispatch 執行 `doFilterInternal`」。
> 名字是雙重否定，很容易讀反。
>
> **② 但覆寫成 `false` 的 filter 真的會再跑一次，而且「已執行過」擋不住它。**
> `OncePerRequestFilter` 是在 `finally` 裡 `removeAttribute` 的（04 章 4.4.6），
> 而那個 `finally` 在請求進入非同步模式之前就跑完了。
>
> | filter | `shouldNotFilterAsyncDispatch()` | ASYNC dispatch 時 |
> |---|---|---|
> | 大部分（沒覆寫） | `true`（預設） | 跳過 |
> | `TraceIdFilter`（04 章 4.5.4） | **覆寫成 `false`** | ★ **會再跑一次** |
> | `CachedBodyFilter`（04 章 4.4.6） | **覆寫成 `false`** | ★ 會再跑一次（但它是冪等的） |
>
> **所以上面那個測試守住的是「`TraceIdFilter` 的 `resolveOnce()` 有沒有被拿掉」** ——
> 而不是「Spring 的預設值是什麼」。

**逾時的測試**：

```java
/**
 * 05 章 5.9.5：串流逾時的行為。
 *
 * ⚠️ 這個測試在不同 Spring 版本上的行為不完全一致 ——
 *    MockMvc 不會自己觸發逾時，是「你 dispatch 的時候它才判斷」。
 *    真正的逾時行為建議用 ④′ 整合測試驗證（7.11.5）。
 */
@Test
void 非同步逾時的處理() throws Exception {
    when(orderExportService.stream(any())).thenAnswer(inv -> {
        Thread.sleep(10_000);       // 永遠不回
        return null;
    });

    MvcResult started = mockMvc.perform(get("/orders.csv").accept("text/csv"))
            .andExpect(request().asyncStarted())
            .andReturn();

    started.getRequest().getAsyncContext().setTimeout(100);

    mockMvc.perform(asyncDispatch(started))
            .andExpect(status().is5xxServerError());
}
```

---
### 7.5.7 multipart

05 章用過，這裡補三個容易踩到的細節。

```java
MockMultipartFile image = new MockMultipartFile(
        "file",                      // ① 表單欄位名（要對得上 @RequestPart / @RequestParam）
        "產品照片.jpg",                // ② 原始檔名（★ 攻擊測試的入口）
        "image/jpeg",                // ③ 客戶端聲稱的 Content-Type（不可信）
        jpegBytes);                  // ④ 內容（★ magic number 要對）

mockMvc.perform(multipart("/products/P-1001/images")
                .file(image)
                .file(new MockMultipartFile("thumbnail", "t.jpg", "image/jpeg", thumbBytes))
                .param("altText", "產品主圖")        // ★ 一般表單欄位
                .header("Idempotency-Key", "idem-1"))
        .andExpect(status().isCreated());
```

**細節一：`@RequestPart` 的 JSON 部分要自己設 Content-Type。**

```java
// Controller（05 章 5.6.2 的變體）
@PostMapping(consumes = MULTIPART_FORM_DATA_VALUE)
public ResponseEntity<ProductImageResponse> upload(
        @RequestPart("metadata") @Valid ImageMetadata metadata,   // ★ JSON
        @RequestPart("file") MultipartFile file) { ... }
```

```java
// ✅ metadata 這一 part 必須宣告 application/json，否則 415
mockMvc.perform(multipart("/products/P-1001/images")
        .file(new MockMultipartFile("metadata", "", "application/json",
                """
                {"altText":"產品主圖","position":1}
                """.getBytes(StandardCharsets.UTF_8)))    // ★ 第二個參數（檔名）給空字串
        .file(image))
```

⚠️ **檔名給空字串是刻意的** —— 那讓這一 part 沒有 `filename`，
比較接近瀏覽器送 JSON part 的樣子。

**細節二：測試用的檔案位元組不能是隨便的內容。**

```java
package example.shop.test;

/**
 * 測試用的「真的」檔案位元組。
 *
 * <p>★ 為什麼不能用 "fake-image".getBytes()：
 *    05 章 5.5.2 的 ContentTypeDetector 檢查 magic number ——
 *    假的位元組會被擋在 UploadValidator，
 *    於是所有上傳測試都變成「測到了驗證器」而不是「測到了 Controller」。
 *
 * <p>⚠️ 這正是 7.6.3 的變體：**測試通過了，但測的不是你想的那件事**。
 */
public final class FileFixtures {

    private FileFixtures() {}

    /** 最小的合法 JPEG（SOI + APP0 + EOI）。 */
    public static byte[] minimalJpeg() {
        return new byte[] {
                (byte) 0xFF, (byte) 0xD8,                      // SOI
                (byte) 0xFF, (byte) 0xE0, 0x00, 0x10,          // APP0, length 16
                'J', 'F', 'I', 'F', 0x00,
                0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
                (byte) 0xFF, (byte) 0xD9                       // EOI
        };
    }

    /** 最小的合法 PNG（signature + IHDR + IEND）。 */
    public static byte[] minimalPng() {
        return new byte[] {
                (byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A,
                0x00, 0x00, 0x00, 0x0D, 'I', 'H', 'D', 'R',
                0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
                0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, (byte) 0xC4,
                (byte) 0x89,
                0x00, 0x00, 0x00, 0x00, 'I', 'E', 'N', 'D',
                (byte) 0xAE, 0x42, 0x60, (byte) 0x82
        };
    }

    /** ★ 「聲稱是 JPEG 但其實是 PHP」—— 05 章 5.5.2 的核心攻擊。 */
    public static byte[] phpDisguisedAsJpeg() {
        return "<?php system($_GET['c']); ?>"
                .getBytes(java.nio.charset.StandardCharsets.US_ASCII);
    }

    /**
     * ★ 「有正確 magic number 但夾帶 PHP」——
     *    magic number 檢查擋不住，要靠二次編碼（5.5.3）。
     */
    public static byte[] jpegWithEmbeddedPhp() {
        byte[] header = minimalJpeg();
        byte[] payload = "<?php system($_GET['c']); ?>"
                .getBytes(java.nio.charset.StandardCharsets.US_ASCII);
        byte[] combined = new byte[header.length + payload.length];
        System.arraycopy(header, 0, combined, 0, header.length);
        System.arraycopy(payload, 0, combined, header.length, payload.length);
        return combined;
    }

    /**
     * 讀一個真的圖檔 fixture（需要真的像素時用）。
     *
     * <p>⚠️ ImageReencoder（5.5.3）需要 ImageIO 能真的解碼 ——
     * 上面的 minimalJpeg 沒有影像資料，ImageIO.read() 會回傳 null。
     */
    public static byte[] realJpeg1x1() throws java.io.IOException {
        try (var in = FileFixtures.class.getResourceAsStream("/fixtures/1x1.jpg")) {
            return java.util.Objects.requireNonNull(in, "缺少 /fixtures/1x1.jpg")
                    .readAllBytes();
        }
    }
}
```

⚠️ **`minimalJpeg()` 與 `realJpeg1x1()` 的分工**：

| 要測 | 用哪個 | 為什麼 |
|---|---|---|
| `ContentTypeDetector` 認得 JPEG | `minimalJpeg()` | 只看前幾個位元組 |
| `UploadValidator` 的完整流程 | `minimalJpeg()` | 同上 |
| `ImageReencoder` 真的重畫一次 | **`realJpeg1x1()`** | `ImageIO.read()` 需要真的影像資料 |
| 尺寸限制（5.5.3） | 真的大圖 fixture | 需要真的寬高 |

**細節三：惡意檔名要用「組出來的」常數，不要直接貼字元。**

```java
package example.shop.test;

/**
 * 05 章 5.4.2 的惡意檔名目錄。
 *
 * <p>★★ 為什麼看不見的字元一律用 {@code (char) 0x...} 組出來，
 *    而不是直接貼進原始碼：
 *
 * <ul>
 *   <li>NUL、CR、LF、RTL override 這些字元在編輯器裡**看不見**。</li>
 *   <li>{@code git diff}、GitHub 的 code review、以及複製貼上
 *       都可能把它們吃掉或正規化。</li>
 *   <li>被吃掉之後，那個案例**靜默消失，而測試仍然是綠的** ——
 *       正好是這一章最想避免的那種失敗。</li>
 * </ul>
 *
 * <p>⚠️ 寫成 {@code (char) 0x00} 的話，「它被改壞了」在 diff 裡看得見；
 *    而且 code review 的人知道那裡有一個看不見的字元。
 */
public final class MaliciousFilenames {

    private MaliciousFilenames() {}

    /** NUL —— C 字串截斷攻擊。 */
    private static final String NUL = String.valueOf((char) 0x00);
    /** CR + LF —— 標頭注入（5.8.1）。 */
    private static final String CRLF = String.valueOf((char) 0x0D)
                                     + String.valueOf((char) 0x0A);
    /** RIGHT-TO-LEFT OVERRIDE —— 讓 "php.gpj" 顯示成 "jpg.php"。 */
    private static final String RLO = String.valueOf((char) 0x202E);
    /** 零寬空白 —— 繞過「以 .jpg 結尾」的字串比對。 */
    private static final String ZWSP = String.valueOf((char) 0x200B);

    public static java.util.List<String> all() {
        return java.util.List.of(
                "../../../../etc/passwd",                    // 路徑穿越
                "..\\..\\windows\\system32\\a.jpg",          // Windows 路徑穿越
                "a.jpg" + NUL + ".php",                      // ★ NUL 截斷
                "很長的檔名".repeat(200) + ".jpg",             // 超長
                ".htaccess",                                 // 特殊檔名
                "a.jpg.php",                                 // 雙擴充名
                "COM1.jpg",                                  // Windows 保留名
                "．．/etc/passwd",                   // 全形點（U+FF0E）
                "a" + CRLF + "X-Injected: 1.jpg",            // ★ 標頭注入
                RLO + "gpj.php",                             // ★ RTL override
                "a.php" + ZWSP + ".jpg",                     // ★ 零寬空白
                NUL,                                         // 只有 NUL
                "",                                          // 空字串
                "   ",                                       // 只有空白
                "a".repeat(300) + ".jpg"                     // 邊界：超過檔名長度上限
        );
    }
}
```

```java
/**
 * 05 章 5.4.2 的檔名攻擊，在 Web 層的端到端驗證。
 *
 * <p>★ 注意分工：SafeFilename 的單元測試（①）已經覆蓋了字串處理。
 *    這個測試要驗證的是**不同的事**：
 *    「Controller 真的呼叫了 SafeFilename，而不是直接用 getOriginalFilename()」。
 *
 * <p>這是「同一件事在兩層各測一半」的正確形狀：
 *    ① 測「函式對不對」、③ 測「有沒有被呼叫」。
 */
@ParameterizedTest
@MethodSource("example.shop.test.MaliciousFilenames#all")
void 惡意檔名不會出現在儲存的key裡(String maliciousName) throws Exception {
    // ★ 寫法 B（7.6.5）：stub 用 any()，capture 放在 verify 裡
    when(productImageService.add(any())).thenReturn(sampleImageResponse());
    var captor = ArgumentCaptor.forClass(AddProductImageCommand.class);

    mockMvc.perform(multipart("/products/P-1001/images")
                    .file(new MockMultipartFile("file", maliciousName,
                            "image/jpeg", FileFixtures.minimalJpeg()))
                    .header("Idempotency-Key", "idem-" + maliciousName.hashCode()))
            // ★ 接受（201）或拒絕（422）都可以 —— 不可以的是「接受了危險的 key」
            .andExpect(status().is(anyOf(is(201), is(422))));

    // ★ atMost(1)：被拒絕（422）時 Service 完全不會被呼叫
    verify(productImageService, atMost(1)).add(captor.capture());

    if (!captor.getAllValues().isEmpty()) {
        String key = captor.getValue().storageKey();
        assertThat(key)
                .as("儲存 key 含有原始檔名的危險部分：%s", key)
                .doesNotContain("..")
                .doesNotContain("/etc/")
                .matches("^[A-Za-z0-9/_.-]+$")     // ★ 05 章 5.4.3 的 key 格式
                .hasSizeLessThan(256);
    }
}
```

⚠️ **`@MethodSource("example.shop.test.MaliciousFilenames#all")` 的完整類別名寫法**
讓多個測試類別共用同一份攻擊目錄 ——
**攻擊目錄應該只有一份**，否則新發現的手法只會被加進其中一份。

⚠️ **`.matches("^[A-Za-z0-9/_.-]+$")` 這個斷言比前面幾個 `doesNotContain` 都強**：
它是**白名單**。`doesNotContain` 是黑名單，而黑名單永遠列不完
（RTL override 不含 `..` 也不含 `/etc/`）。

> **這是 02 章 2.5「白名單優於黑名單」在測試裡的同一個道理。**

### 7.5.8 SSE 在 MockMvc 裡能測到什麼

**能測到的**：

```java
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/**
 * 05 章 5.11.3 的 SSE 端點在切片裡能驗證的部分。
 */
@Test
void SSE端點的標頭與線路格式() throws Exception {
    // ★★ 關鍵：拿到 Controller 建立的那個 SseEmitter。
    //
    // ⚠️ SseEmitterRegistry.register(...) 的簽名是
    //      void register(String subscriptionId, String orderId, String actorId,
    //                    SseEmitter emitter)
    //    —— 4 個參數、【沒有回傳值】。所以不能用
    //      when(registry.register(any(), any(), any())).thenReturn(emitter)
    //    （那既是參數個數不對，也是「對 void 方法 stub 回傳值」）。
    //
    // ★ 正確的做法：用 ArgumentCaptor 把 Controller 傳進去的那個 emitter 抓出來。
    //   這也順便驗證了「Controller 真的有註冊」（7.6.4 的 verify 用法）。
    var emitterCaptor = ArgumentCaptor.forClass(SseEmitter.class);

    MvcResult started = mockMvc.perform(get("/orders/ord_1/events")
                    .accept(MediaType.TEXT_EVENT_STREAM))
            .andExpect(request().asyncStarted())
            .andExpect(status().isOk())
            // ★ 05 章 5.11.7 的三個必要標頭
            .andExpect(header().string("Content-Type",
                    containsString("text/event-stream")))
            .andExpect(header().string("Cache-Control", containsString("no-store")))
            .andExpect(header().string("X-Accel-Buffering", "no"))
            .andReturn();

    verify(sseEmitterRegistry).register(
            anyString(), eq("ord_1"), anyString(), emitterCaptor.capture());
    SseEmitter emitter = emitterCaptor.getValue();

    String body;
    try {
        // ★★ 送幾個事件
        emitter.send(SseEmitter.event()
                .id("evt_1").name("order.status.changed")
                .data("{\"status\":\"SHIPPED\"}", MediaType.APPLICATION_JSON));
        emitter.send(SseEmitter.event().comment("heartbeat"));
    } finally {
        // ★★ 一定要 complete()，即使上面斷言失敗
        emitter.complete();
    }

    body = mockMvc.perform(asyncDispatch(started))
            .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);

    assertThat(body)
            .contains("id:evt_1")
            .contains("event:order.status.changed")
            .contains("data:{\"status\":\"SHIPPED\"}")
            .contains(":heartbeat");        // ★ comment 的線路格式
}
```

⚠️ **`emitter.complete()` 是這個測試的生死線。**
沒有它，`asyncDispatch` 會一直等到逾時 ——
而且失敗方式不是紅燈，是**卡一秒然後給你一個看不懂的 `IllegalStateException`**。
所以它一定要放在 `finally` 裡。

**測不到的（要 ④′，見 7.11.4）**：

| 測不到 | 為什麼 | 影響哪一個 05 章的設計 |
|---|---|---|
| 心跳真的每 20 秒送一次 | 沒有時間流動 | `SseHeartbeat`（5.11.4） |
| 客戶端斷線 → `onError` / `onCompletion` | 沒有真的 socket | `SseEmitterRegistry` 的清理（5.11.6） |
| `Last-Event-ID` 的重連補送 | 需要兩次真的連線 | `OrderEventReplayService`（5.11.5） |
| Nginx 緩衝 | 沒有 Nginx | 5.11.7 的三個坑 |
| 連線數上限 | 需要真的並行連線 | `max-total-connections`（5.11.6） |
| 壓縮把 SSE 弄壞 | MockMvc 不壓縮 | 5.11.7 |
| **關機時主動送 `stream.reconnect` 並結束連線** | 需要真的 `ContextClosedEvent` 與真的連線 | **5.11.10** |

> **SSE 的 MockMvc 測試只能證明「線路格式對」。
> 「它在真的網路上能用」必須 ④′。**

### 7.5.9 MockMvc 與真實容器的 12 個行為差異 ★★

這張表是「什麼時候必須升級到 ④′」的判斷依據。

| # | 差異 | MockMvc | 真實容器 | 受影響的測試 |
|---|---|---|---|---|
| 1 | **壓縮** | 從不壓縮 | `server.compression` 生效 | gzip、`Content-Encoding`、SSE 不可壓縮（5.11.7） |
| 2 | **chunked / `Content-Length`** | 一律有 `Content-Length` | 串流是 chunked | 串流的傳輸方式（5.9） |
| 3 | **preflight `OPTIONS`** | 走 filter chain，但沒有容器層的 OPTIONS 處理 | 完整 | CORS preflight（6.3.2、6.10.4） |
| 4 | **multipart 的大小上限** | request 是你組的，不觸發解析器的檢查 | Tomcat 擋 → 413 | `max-file-size`（5.3.2） |
| 5 | **路徑正規化** | 幾乎照字面用 | Tomcat 拒絕 `%2F`、正規化 `//` 與 `..`、去掉 `;jsessionid` | 路徑穿越、`PathPatterns`（1.3） |
| 6 | **回應的字元編碼** | 沒設時是 `ISO-8859-1` | 依 Content-Type | 中文（7.5.4 陷阱五） |
| 7 | **回應緩衝區** | 沒有 8 KB 的 flush 分界 | Tomcat 8 KB 就把標頭送出 | **「200 + 截斷的 JSON」（6.7.4）測不到** |
| 8 | **未處理的例外** | 重新拋到測試方法 | 容器回 500 | advice 覆蓋率的測試要小心（見下） |
| 9 | **`sendError` vs `setStatus`** | forward 行為不同 | 會 forward 到 `/error` | `ApiErrorController`（3.10.3） |
| 10 | **非同步逾時** | 不會自己觸發 | 容器計時 | 串流逾時（5.9.5） |
| 11 | **真的斷線** | 不存在 | `ClientAbortException` | 串流中途失敗（5.9.4）、SSE 清理（5.11.6） |
| 12 | **HTTP 語法檢查** | 幾乎不檢查（標頭可以放任何字元） | 拒絕非法與超長標頭 | **log injection 的防護（4.4.4）要用 ④′ 驗證** |

**★ 第 8 點值得展開**，因為它會誤導你對 advice 覆蓋率的判斷：

```java
@Test
void 沒有被任何advice處理的例外() throws Exception {
    when(orderService.create(any())).thenThrow(new SomeWeirdError());

    // 情況 A：GenericAdvice 有 @ExceptionHandler(Exception.class)
    //   → 回 500 + Problem JSON ✅
    // 情況 B：沒有那個 handler
    //   → 🔴 MockMvc 把例外重新拋出來（包在 ServletException 裡）
    //   → 測試方法收到例外，而失敗訊息是堆疊，不是「狀態碼不符」
}
```

**這造成一個實務問題**：失敗的方式看起來像「被測程式碼壞了」，
實際上是「advice 沒覆蓋到」。

**shop-service 的做法：直接問 `HandlerExceptionResolver`，繞開 MockMvc。**

```java
/**
 * ★ 03 章 3.5.4「六種進不了 advice 的例外」的守門測試。
 */
@Test
void 每一種業務例外都有advice接得到() {
    var resolver = context.getBean(
            org.springframework.web.servlet.HandlerExceptionResolver.class);

    for (Class<? extends Exception> type : allBusinessExceptionTypes()) {
        Exception ex = instantiate(type);
        var request  = new MockHttpServletRequest("POST", "/orders");
        var response = new MockHttpServletResponse();

        var mav = resolver.resolveException(request, response, someHandlerMethod(), ex);

        assertThat(mav)
                .as("""
                    %s 沒有任何 @ExceptionHandler 接得到。

                    它在正式環境會變成 Tomcat 的 HTML 錯誤頁（03 章 3.3.4），
                    而不是我們的 Problem JSON。
                    """, type.getSimpleName())
                .isNotNull();
        assertThat(response.getStatus()).isNotEqualTo(200);
    }
}
```

**第 7 點也值得一句話**：
06 章 6.7.4 的「200 + 截斷的 JSON」是序列化中途失敗造成的 ——
`MockHttpServletResponse` 把內容全部存在記憶體裡，沒有「已經送出標頭」的狀態，
**所以那個 bug 在任何 MockMvc 測試裡都不會出現**。
它的守門測試（`DtoSerializabilityTest`）刻意做成 ① 純單元測試
（直接呼叫 `ObjectMapper.writeValueAsString`）—— 那是對的選擇。

### 7.5.10 Spring 6.2 的 `MockMvcTester`

**Spring Framework 6.2（Boot 3.4）新增了一套 AssertJ 風格的 API。**

⚠️ **shop-service 的基準是 Boot 3.2.5 / Spring 6.1，所以現在還不能用。**
這一節是為升級做準備 —— **而且它值得成為升級的理由之一**。

**傳統寫法**：

```java
mockMvc.perform(get("/orders/ord_1"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.orderId").value("ord_01J5GK"))
        .andExpect(jsonPath("$.items", hasSize(2)));
```

**`MockMvcTester`**：

```java
@Autowired MockMvcTester mvc;      // ★ 直接注入（Boot 3.4 起）

assertThat(mvc.get().uri("/orders/ord_1"))
        .hasStatusOk()
        .bodyJson()
        .extractingPath("$.orderId").isEqualTo("ord_01J5GK");
```

**四個實質改善**：

**① 每一個斷言失敗都印出完整的請求與回應。** 這直接解決 7.5.4 陷阱六。

**② 例外的斷言變自然。**

```java
assertThat(mvc.post().uri("/orders").content(badJson))
        .hasFailed()
        .failure()
        .isInstanceOf(HttpMessageNotReadableException.class);
```

**③ body 可以直接轉成型別。**

```java
assertThat(mvc.get().uri("/orders/ord_1"))
        .hasStatusOk()
        .bodyJson()
        .convertTo(OrderDetail.class)          // ★ 用 context 裡的 ObjectMapper
        .satisfies(detail -> {
            assertThat(detail.status()).isEqualTo(OrderStatus.PAID);
            assertThat(detail.totalAmount()).isEqualTo("1280.50");
        });
```

⚠️ **`convertTo` 會再走一次反序列化** ——
如果 DTO 是「只輸出不輸入」的（沒有 creator）會失敗。
06 章 6.10.5 的往返測試就是專門處理這件事的。

**④ 不用 `throws Exception`。**

```java
@Test void 查詢訂單() { ... }      // ★ perform 不再拋 checked exception
```

**遷移策略（升級到 Boot 3.4 之後）**：

| 情況 | 做法 |
|---|---|
| 現有的 3,000 個測試 | **不動**。兩套 API 可共存（`MockMvcTester.create(mockMvc)`） |
| 新寫的測試 | 用 `MockMvcTester` |
| 「失敗訊息看不懂」的測試 | 優先遷移 |

⚠️ **不要為了統一而大改** —— 那是一個高風險、零功能價值的 PR。

---
## 7.6 mock 的正確用法

### 7.6.1 `@MockBean` / `@MockitoBean` / `@TestConfiguration`：版本的真相 ★

**先把版本講清楚，因為這件事在網路上的資料很混亂。**

| 註解 | 出現在 | 狀態 |
|---|---|---|
| `@MockBean` / `@SpyBean` | Spring Boot 1.4 起 | **Boot 3.4 起標記為 deprecated** |
| `@MockitoBean` / `@MockitoSpyBean` | **Spring Framework 6.2 / Boot 3.4** | 取代上面兩個 |
| `@TestBean` | Spring Framework 6.2 | 用靜態工廠方法提供替身（不是 mock） |

**兩者的差別不只是名字**：

| | `@MockBean`（Boot） | `@MockitoBean`（Framework） |
|---|---|---|
| 提供者 | Spring Boot 的測試模組 | **Spring Framework 核心測試模組** |
| 需要 Boot 嗎 | 是 | 不需要（純 Spring 專案也能用） |
| bean 覆寫機制 | Boot 自己的 `MockitoPostProcessor` | Framework 的 `BeanOverride` 機制 |
| 可以標在欄位以外的地方嗎 | 不行 | 可以（`@MockitoBean` 可以標在測試類別上並指定 `types`） |

> ### ⚠️ 修正：前幾章的一處版本錯誤
>
> **03 章 3.13（4032 行附近）與 3.14.4（5403 行附近）用了 `@MockitoBean`**：
>
> ```java
> @WebMvcTest(OrderController.class)
> class OrderControllerErrorTest {
>     @Autowired MockMvc mockMvc;
>     @MockitoBean OrderService orderService;      // 🔴 Boot 3.2.5 上不存在
> }
> ```
>
> **本課程的基準是 Spring Boot 3.2.5 / Spring Framework 6.1，
> 而 `@MockitoBean` 是 Spring Framework 6.2（Boot 3.4）才有的。**
>
> 在 3.2.5 上那一行會編譯失敗：
>
> ```
> package org.springframework.test.context.bean.override.mockito does not exist
> ```
>
> **修正：在 Boot 3.2.x / 3.3.x 上請用 `@MockBean`**：
>
> ```java
> import org.springframework.boot.test.mock.mockito.MockBean;
>
> @WebMvcTest(OrderController.class)
> class OrderControllerErrorTest {
>     @Autowired MockMvc mockMvc;
>     @MockBean OrderService orderService;         // ✅ Boot 3.2.5
> }
> ```
>
> **這一站接下來的程式碼一律寫 `@MockitoBean`，並在每一個檔案的開頭註明**：
>
> ```java
> // ⚠️ Boot 3.4+ 用 @MockitoBean；Boot 3.2/3.3 請改成 @MockBean
> //    （兩者的語意相同，只有 import 與類別名不同）
> ```
>
> **為什麼這一站選擇寫新的那個**：
> `@MockBean` 已經 deprecated，寫在教材裡會教出「一上線就要改」的程式碼。
> **而「新的那個在你的版本上不存在」這件事本身就值得知道** ——
> 這一節就是為此存在的。
>
> 07 章 7.14.3 有一個 `mvn` 的 profile，讓兩個版本都能編譯。
>
> ⚠️⚠️ **而下一站（05-service）刻意選了相反的做法** ——
> 它全站直接寫 `@MockBean`（05-service 07 章 7.3.6），基準版本一樣是 Boot 3.2.5。
>
> **不是其中一個錯了，是兩站要教的東西不同**：
>
> | 站 | 寫哪一個 | 那一站在教什麼 |
> |---|---|---|
> | **04-controller（本站）** | `@MockitoBean` + 逐處註記 + `mvn` profile | ✅ **版本遷移本身**：一個註解改名，會讓 72 處測試在你的版本上編不過 |
> | **05-service** | `@MockBean` | 那一站在教 Mockito 與測試分層，不想讓版本問題佔用注意力 → 寫**在基準上直接能編譯**的那個 |
>
> 🔴 **實務上的意思**：如果你把兩站的測試放進同一個專案，**挑一個統一**。
> 兩者語意完全相同，只有 import 與類別名不同 ——
> 而「哪一個」取決於你的 Boot 版本，不取決於課程。

**第三種：`@TestConfiguration` 提供真的實作。**

7.4.4 已經介紹過。**三者的選擇標準**：

```
                需要一個替身
                     │
     ┌───────────────┴───────────────┐
     │ 這個依賴有「輕量但行為正確」   │
     │ 的實作嗎？                     │
     │ （InMemoryRateLimiter、        │
     │   InMemoryObjectStorage）      │
     └───────────────┬───────────────┘
                是 ──┴── 否
                 │        │
    ┌────────────▼──┐     │
    │@TestConfiguration│   │
    │  ★ 首選         │   │
    └─────────────────┘   │
                          │
     ┌────────────────────▼────────────────────┐
     │ 這個測試需要「控制它的回傳值」嗎？        │
     │ （Service 回傳特定的 OrderDetail、       │
     │   或拋出特定的例外）                     │
     └────────────────────┬────────────────────┘
                     是 ──┴── 否
                      │        │
         ┌────────────▼──┐  ┌──▼────────────────┐
         │ @MockitoBean  │  │ 為什麼要替身？     │
         │  ★ 正確用法   │  │ 也許它可以是真的   │
         └───────────────┘  └───────────────────┘
```

**shop-service 的實際分配**：

| 依賴 | 用什麼 | 理由 |
|---|---|---|
| `OrderService`、`OrderQueryService` 等所有 Service | `@MockitoBean` | 測試要控制「Service 回什麼、拋什麼」 |
| `RateLimiter` | `@TestConfiguration`（真的記憶體版） | 要測「第 11 次回 429」的真實行為 |
| `IdempotencyStore` | `@TestConfiguration` | 同上 |
| `ObjectStorage` | `@TestConfiguration` | 上傳測試要能讀回來驗證 |
| `MalwareScanner` | `@TestConfiguration`（no-op） | 與 local profile 一致 |
| `Clock` | `@TestConfiguration`（固定） | **讓時間可斷言** |
| `MessageSource` | **不替換**（用真的） | 錯誤訊息的 i18n 是測試的目標之一 |
| `ObjectMapper` | **不替換** | 06 章的所有設定要生效 |
| `AuditRepository` | `@TestConfiguration`（記錄到 list） | 要斷言「稽核有寫」 |

### 7.6.2 三個陷阱

**陷阱一：mock 會讓 context 增生（7.4.5 已詳述）。**

**陷阱二：mock 是「整個 context 共用」的，但每個測試方法後會重設。**

```java
@WebMvcTest
class SomeTest {
    @MockitoBean OrderService orderService;      // ★ 這個 mock 屬於 context

    @Test void a() {
        when(orderService.create(any())).thenReturn(sampleOrder());
        // ...
    }

    @Test void b() {
        // ★ orderService 已經被 Mockito.reset() 過了
        //   → create(any()) 回傳 null
    }
}
```

**「每個測試方法後重設」是 `MockitoTestExecutionListener` 做的**，
所以測試之間不會互相污染。**這是好事。**

⚠️ **但它同時是一個陷阱**：如果你在 `@BeforeAll`（static）裡 stub，
第一個測試之後就失效了。**要用 `@BeforeEach`。**

```java
// 🔴 錯
@BeforeAll
static void setup() { when(orderService...).thenReturn(...); }   // 不能，orderService 不是 static

// ✅ 對
@BeforeEach
void setup() { when(orderService.create(any())).thenReturn(sampleOrder()); }
```

**陷阱三：`@TestConfiguration` 裡的 bean **不會**被重設。**

```java
@TestConfiguration
public class WebSliceInfraConfig {
    @Bean RateLimiter rateLimiter(Clock clock) {
        return new InMemoryRateLimiter(clock);       // ★ 整個 context 共用一份，永不重設
    }
}
```

**於是 7.5.2 的限流測試會污染後面的測試**：

```
測試 A：打 101 次 /products  → InMemoryRateLimiter 記住「這個 IP 用完了」
測試 B：打 1 次 /products    → 🔴 429（而它期望 200）
```

**四個修法，選一個**：

| 修法 | 做法 | 評價 |
|---|---|---|
| **A（推薦）** | 每個測試用不同的 IP / actor | ✅ 簡單、不需要重設機制、可以並行 |
| B | `@BeforeEach` 呼叫 `rateLimiter.reset()` | 需要在介面上開一個「只有測試用」的方法 ⚠️ |
| C | 用 `@DirtiesContext` | 🔴 每次重建 context（7.4.5） |
| D | 把限流測試獨立成一個類別 | 只是把問題縮小，沒有解決 |

**修法 A 的具體形狀**：

```java
/**
 * ★ 每個測試用自己的 IP —— 讓有狀態的替身不需要重設。
 *
 * <p>做法：用測試方法名產生一個穩定但唯一的 IP。
 * <p>好處：測試可以並行執行（7.13.3），因為它們的桶不互相干擾。
 */
private static String ipFor(TestInfo testInfo) {
    int hash = Math.abs(testInfo.getTestMethod().orElseThrow().getName().hashCode());
    return "198.51.100." + (hash % 254 + 1);      // TEST-NET-2，保留給文件用
}

@Test
void 限流依IP計算(TestInfo testInfo) throws Exception {
    String ip = ipFor(testInfo);
    // ...
}
```

⚠️ **`198.51.100.0/24` 是 RFC 5737 保留給文件用的網段** ——
用它可以確保「這個 IP 不是任何真實的東西」，
而且在 log 裡一看就知道是測試流量。

### 7.6.3 「沒 stub 就回 `null`」：測試在測一件你沒想測的事 ★

**這是 mock 最常見、也最難察覺的問題。**

```java
@Test
void 查詢訂單列表() throws Exception {
    // ⚠️ 忘了 stub orderQueryService.list(...)

    mockMvc.perform(get("/orders?page=1&size=20"))
            .andExpect(status().isOk());          // ← 這個居然過了？
}
```

**Mockito 的預設回傳值**：

| 回傳型別 | 預設值 |
|---|---|
| 物件 | **`null`** |
| `int` / `long` | `0` |
| `boolean` | `false` |
| `Optional<T>` | **`Optional.empty()`**（Mockito 2+ 的 `RETURNS_DEFAULTS`） |
| `List<T>` / `Set<T>` / `Map<K,V>` | **空集合** |
| `Stream<T>` | 空 stream |

**於是上面那個測試發生了什麼**：

```java
// Controller
@GetMapping
public PageResponse<OrderSummary> list(@ModelAttribute OrderFilter filter) {
    return orderQueryService.list(filter);        // → null
}
```

回傳 `null` → Spring 的 `RequestResponseBodyMethodProcessor` 看到 `null`
→ **不寫任何 body，狀態碼 200**。

```
狀態 200，body 空的，測試通過。
```

**而這個測試「測到」的是**：路由對了、`@ModelAttribute` 綁定沒拋例外。
**它沒測到**：回應的內容、分頁的結構、序列化、`statusLabel`……

⚠️ **更糟的變體：`null` 讓 Controller 拋 NPE。**

```java
@GetMapping
public PageResponse<OrderSummary> list(@ModelAttribute OrderFilter filter) {
    var page = orderQueryService.list(filter);
    return new PageResponse<>(page.content(), page.pageInfo());   // 🔴 NPE
}
```

**於是測試失敗，訊息是**：

```
java.lang.NullPointerException: Cannot invoke "PageResponse.content()"
because the return value of "OrderQueryService.list(OrderFilter)" is null
```

**Java 21 的 helpful NullPointerException 訊息在這裡救了你** ——
它明確說了「是 `OrderQueryService.list` 回傳 null」。
**在 Java 14 之前，你只會看到一行 `NullPointerException`。**

**三道防線**：

**防線一：`Mockito.RETURNS_SMART_NULLS`。**

```java
@MockitoBean(answers = org.mockito.Answers.RETURNS_SMART_NULLS)
OrderQueryService orderQueryService;
```

`SmartNull` 的行為：回傳一個特殊的物件，**用到它的時候拋出一個有幫助的例外**：

```
org.mockito.exceptions.misusing.SmartNullPointerException:
You have a NullPointerException here:
-> at example.shop.order.web.OrderController.list(OrderController.java:87)
because this method was *not* stubbed correctly:
-> at OrderQueryService.list(OrderFilter)
```

⚠️ **`RETURNS_SMART_NULLS` 的兩個限制**：
- 只對「未 stub 的方法」有效。
- **對 `final` 類別與 record 無效**（無法建代理）——
  而 shop-service 的 DTO 全是 record，所以 `SmartNull` 用不上。

**防線二：`strictness = Strictness.STRICT_STUBS`。**

```java
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.STRICT_STUBS)
class SomeUnitTest { ... }
```

它抓的是**反向的問題**：「你 stub 了但沒用到」。

```
org.mockito.exceptions.misusing.UnnecessaryStubbingException:
Unnecessary stubbings detected:
  1. -> at SomeTest.setup(SomeTest.java:42)
```

**這對 `@BeforeEach` 裡的共用 stub 特別有價值** ——
它會告訴你「這個 stub 對某些測試是多餘的」，
而那通常代表測試的分組不對。

⚠️ **`@MockitoBean` 不吃 `@MockitoSettings`**（那是 `MockitoExtension` 的東西）。
Spring 的 bean override 機制沒有 strict stubs。
**所以這道防線只在 ① 純單元測試裡有效。**

**防線三（★ 最有效）：讓「回應為空」變成一個明確的失敗。**

```java
package example.shop.test;

import org.springframework.test.web.servlet.ResultMatcher;

import static org.assertj.core.api.Assertions.assertThat;

public final class ResponseMatchers {

    private ResponseMatchers() {}

    /**
     * ★★ 「回應必須有內容」。
     *
     * <p>為什麼需要它：Mockito 沒 stub 就回 null，
     * 而 Controller 回傳 null 的結果是「200 + 空 body」——
     * 那讓 status().isOk() 這個斷言完全失去意義（07 章 7.2.3、7.6.3）。
     *
     * <p>把它加進每一個「應該有 body」的測試，
     * 「忘記 stub」就會從綠燈變成紅燈。
     */
    public static ResultMatcher hasNonEmptyBody() {
        return result -> {
            byte[] body = result.getResponse().getContentAsByteArray();
            assertThat(body)
                    .as("""
                        回應的 body 是空的，而狀態碼是 %d。

                        最可能的原因（依機率排序）：
                          1. 忘了 stub mock —— Mockito 回傳 null，
                             Controller 回傳 null，Spring 不寫 body（7.6.3）
                          2. ResponseBodyAdvice 把內容濾掉了（06 章 6.6.4）
                          3. Controller 真的回傳了 null / Optional.empty()

                        檢查：這個測試有 when(...).thenReturn(...) 嗎？
                        """, result.getResponse().getStatus())
                    .isNotEmpty();
        };
    }

    /** 「回應必須是 JSON 物件，而且至少有一個欄位」。 */
    public static ResultMatcher hasNonEmptyJsonObject() {
        return result -> {
            String body = result.getResponse()
                    .getContentAsString(java.nio.charset.StandardCharsets.UTF_8);
            assertThat(body).as("body 是空的（見 hasNonEmptyBody 的說明）").isNotBlank();
            assertThat(body.replaceAll("\\s", ""))
                    .as("body 是空的 JSON 物件 —— 檢查 ?fields= 或 @JsonView（7.2.3）")
                    .isNotEqualTo("{}");
        };
    }
}
```

**用法**：

```java
mockMvc.perform(get("/orders?page=1&size=20"))
        .andExpect(status().isOk())
        .andExpect(ResponseMatchers.hasNonEmptyJsonObject())    // ★
        .andExpect(jsonPath("$.content", hasSize(2)));
```

**而 shop-service 更進一步：把它做成基底類別的預設行為。**

```java
/**
 * 在 WebSliceTest 裡提供一個「一定會檢查 body」的 perform 包裝。
 *
 * <p>★ 這是「讓正確的事情更容易做」的設計 ——
 *    比寫在文件裡「請記得加 hasNonEmptyBody」有效得多。
 */
protected ResultActions performExpectingBody(RequestBuilder request) throws Exception {
    return mockMvc.perform(request)
            .andExpect(ResponseMatchers.hasNonEmptyBody());
}
```

⚠️ **不要做成「所有 perform 都檢查」** ——
204 No Content、304 Not Modified、HEAD 請求的 body **本來就是空的**。

### 7.6.4 `verify`：什麼時候該用、什麼時候是過度指定

**`verify` 驗證的是「互動」，不是「結果」。**

```java
verify(orderService).create(any());                 // 呼叫過至少一次（預設 times(1)）
verify(orderService, times(2)).create(any());
verify(orderService, never()).delete(any());        // ★ 很有價值
verify(orderService, atLeastOnce()).create(any());
verifyNoInteractions(paymentService);               // ★ 很有價值
verifyNoMoreInteractions(orderService);             // ⚠️ 幾乎總是過度指定
```

**判斷標準：這個互動本身是不是契約的一部分？**

| 情況 | 用 verify？ | 理由 |
|---|---|---|
| **「Controller 有把 actor 傳下去」** | ✅ **必須** | 7.2.1 的 bug 就是這個。而回應看不出差別 → 只能 verify |
| **「這個端點不會呼叫付款服務」** | ✅ | `verifyNoInteractions` 表達「不該發生的事」 |
| **「取消訂單只呼叫一次」（冪等）** | ✅ | 次數是契約 |
| 「回應的 `orderId` 是對的」 | ❌ | 用 `jsonPath` 斷言結果，不要 verify |
| 「Service 被呼叫了」（回應已經證明了） | ❌ | 冗餘。回應對了就代表呼叫過了 |
| `verifyNoMoreInteractions` | ❌ | 綁死了實作細節。加一個 log 或快取查詢就紅燈 |

**一個「該用 verify」的完整例子**：

```java
/**
 * ★★ 7.2.1 的守門測試。
 *
 * <p>這個測試斷言的不是「回應對不對」，而是
 * **「Controller 有沒有把授權所需的資訊傳給 Service」**。
 *
 * <p>⚠️ 這件事**無法**從回應觀察到 ——
 *    因為 mock 對任何參數都回傳同一個結果。
 *    所以這是 verify / ArgumentCaptor 唯一能做的事。
 */
@Test
@WithActor(type = ActorType.CUSTOMER, id = "cust_01J5GKA")
void 查詢訂單一定會把actor傳給Service() throws Exception {
    when(orderQueryService.findDetail(eq("ord_1"), any(Actor.class)))
            .thenReturn(sampleDetail());

    mockMvc.perform(get("/orders/ord_1"))
            .andExpect(status().isOk());

    // ★ 核心斷言：有一個 Actor 參數，而且它是對的那個 actor
    verify(orderQueryService).findDetail(eq("ord_1"), argThat(actor ->
            actor != null
                && actor.type() == ActorType.CUSTOMER
                && actor.id().equals("cust_01J5GKA")));

    // ★ 而且**沒有**呼叫「不帶 actor」的多載
    //   （如果那個多載還存在的話 —— 見下方的 ArchUnit 測試）
}
```

⚠️ **更好的做法是讓那個 bug 不可能發生**：

```java
/**
 * ★ ArchUnit：OrderQueryService 不可以有「不帶 Actor」的查詢方法。
 *
 * <p>這比測試更強 —— 它讓 7.2.1 的 bug 在編譯期就不存在，
 *    因為呼叫端沒有那個選項可以選。
 */
@Test
void 查詢服務的每個方法都要收Actor() {
    var methods = com.tngtech.archunit.core.domain.JavaClasses
            /* ... 掃描 example.shop..service ... */;

    // 規則：介面名稱以 QueryService 結尾的，每個 public 方法都要有一個 Actor 參數
    ArchRuleDefinition.methods()
            .that().areDeclaredInClassesThat().haveSimpleNameEndingWith("QueryService")
            .and().arePublic()
            .should(haveAParameterOfType(Actor.class))
            .because("""
                查詢服務必須知道「是誰在查」，否則授權判斷無從進行。
                07 章 7.2.1 的資料洩漏事故就是因為 Controller
                呼叫了一個「不需要 actor」的多載。
                """)
            .check(methods);
}
```

> **測試能抓到 bug，型別能讓 bug 不存在。優先選型別。**

**`verifyNoInteractions` 的一個高價值用法**：

```java
/**
 * 06 章 6.8.3：If-Match 不符時回 412，而且**不可以碰資料**。
 *
 * <p>★ 這個測試的價值在第二個斷言 ——
 *    如果實作先更新再檢查版本，回應仍然是 412，
 *    但資料已經被改壞了。**回應看不出差別。**
 */
@Test
void IfMatch不符時不會呼叫更新() throws Exception {
    when(orderQueryService.currentVersion("ord_1")).thenReturn("v8");

    mockMvc.perform(patch("/orders/ord_1")
                    .header("If-Match", "\"v7\"")
                    .contentType(APPLICATION_JSON)
                    .content("{\"customerNote\":\"改備註\"}"))
            .andExpect(status().isPreconditionFailed())
            .andExpect(jsonPath("$.code").value("OPTIMISTIC_LOCK_CONFLICT"));

    // ★★ 核心：完全沒有嘗試更新
    verify(orderService, never()).update(any());
}
```

### 7.6.5 `ArgumentCaptor`：Controller 測試的核心價值 ★

**回到 7.3.2 的觀察：Controller 只做「翻譯」。**

```
HTTP 請求  ──翻譯──→  Command 物件  ──→ Service
Service 回傳 ──翻譯──→  Response DTO ──→ HTTP 回應
```

**第二個箭頭可以用 `jsonPath` 驗證。第一個箭頭只能用 `ArgumentCaptor`。**

```java
/**
 * ★★ 這是「Controller 測試」最核心的一種：
 *     驗證 HTTP → Command 的翻譯完全正確。
 *
 * <p>它涵蓋的東西非常多：
 * <ul>
 *   <li>Jackson 的反序列化（06 章的所有設定）</li>
 *   <li>命名策略（camelCase）</li>
 *   <li>BigDecimal 的精度（6.5.7）</li>
 *   <li>Instant 的解析（6.5.6）</li>
 *   <li>enum 的轉換（6.5.8）</li>
 *   <li>OrderWebMapper 的欄位對應</li>
 *   <li>Actor 的注入（04 章 4.10）</li>
 *   <li>Idempotency-Key 的傳遞（04 章 4.9）</li>
 * </ul>
 *
 * <p>⚠️ 而其中任何一項出錯，如果只斷言回應是 201，你都看不出來 ——
 *    因為 mock 對任何 command 都回傳同一個 order。
 */
@Test
@WithActor(type = ActorType.CUSTOMER, id = "cust_01J5GKA")
void 下單請求被正確翻譯成Command() throws Exception {
    // ★ 寫法 B：stub 用 any()，capture 放在 verify 裡（理由見本節結尾）
    when(orderService.create(any())).thenReturn(sampleOrder());

    mockMvc.perform(post("/orders")
                    .header("Idempotency-Key", "idem-01J5GKTEST")
                    .contentType(MediaType.APPLICATION_JSON)
                    .characterEncoding(StandardCharsets.UTF_8)
                    .content("""
                            {
                              "items": [
                                { "productId": "P-1001", "quantity": 2 },
                                { "productId": "P-2002", "quantity": 1 }
                              ],
                              "shippingAddressId": "adr_01J5GKA1B2C3D4E5F6G7H8",
                              "couponCode": "summer2026",
                              "customerNote": "  請放門口  ",
                              "invoice": {
                                "type": "COMPANY",
                                "taxId": "12345678",
                                "companyName": "測試股份有限公司"
                              }
                            }
                            """))
            .andExpect(status().isCreated());

    var captor = ArgumentCaptor.forClass(CreateOrderCommand.class);
    verify(orderService).create(captor.capture());
    CreateOrderCommand command = captor.getValue();

    // ── ① 基本欄位與巢狀型別的翻譯 ──────────────────────────
    //   ★ Request 的 Item → Command 的 Line（01 章 1.12.5）
    assertThat(command.lines()).hasSize(2);
    assertThat(command.lines().get(0).productId()).isEqualTo("P-1001");
    assertThat(command.lines().get(0).quantity()).isEqualTo(2);

    // ── ② ★★★ Command 上【沒有】價格 —— 這是一個型別層級的斷言 ──
    //   00 章 0.6.2：價格只能由伺服器查商品目錄決定。
    //   如果有人在 CreateOrderCommand.Line 上加了 unitPrice，
    //   下面這一行會【編譯失敗】—— 而那正是我們要的守門方式。
    //
    //   ⚠️ 這個測試刻意用「編譯失敗」而不是「斷言失敗」：
    //      斷言只能檢查值，而我們要禁止的是【欄位存在】。
    assertThat(CreateOrderCommand.Line.class.getRecordComponents())
            .as("""
                CreateOrderCommand.Line 多了欄位。

                ⚠️ 如果新增的是價格類的欄位（unitPrice / amount / price），
                   那就是把「客戶端可以決定價格」變成了一個合法的請求 ——
                   00 章 0.6.2 的價格篡改漏洞。

                如果是別的欄位，更新這個斷言並在 PR 說明它為什麼該由客戶端提供。
                """)
            .extracting(java.lang.reflect.RecordComponent::getName)
            .containsExactly("productId", "quantity");

    // ── ③ ★ 只有 ID，沒有展開的地址（00 章 0.4：Web 層不查資料庫）──
    assertThat(command.shippingAddressId()).isEqualTo("adr_01J5GKA1B2C3D4E5F6G7H8");

    // ── ④ ★ compact constructor 的正規化真的跑了（02 章 2.12.1）──
    assertThat(command.couponCode())
            .as("couponCode 沒有被正規化成大寫 —— 檢查 CreateOrderRequest 的 compact constructor")
            .isEqualTo("SUMMER2026");
    assertThat(command.customerNote())
            .as("customerNote 沒有被 trim")
            .isEqualTo("請放門口");

    // ── ⑤ ★ enum 的轉換（06 章 6.5.8）────────────────────
    assertThat(command.invoice().type()).isEqualTo(InvoiceType.COMPANY);
    assertThat(command.invoice().taxId()).isEqualTo("12345678");

    // ── ⑥ ★★ Actor（7.2.1 的守門）────────────────────────
    assertThat(command.actor()).isNotNull();
    assertThat(command.actor().type()).isEqualTo(ActorType.CUSTOMER);
    assertThat(command.actor().id()).isEqualTo("cust_01J5GKA");

    // ── ⑦ ★ 冪等鍵（04 章 4.9）───────────────────────────
    assertThat(command.idempotencyKey()).isEqualTo("idem-01J5GKTEST");

    // ── ⑧ ★ 中文沒有亂碼（7.5.4 陷阱五的反向）────────────
    assertThat(command.invoice().companyName()).isEqualTo("測試股份有限公司");
}
```

> ### ⚠️ 為什麼這個 body 裡「沒有」`unitPrice`、`shippingAddress`、
> ### `requestedDeliveryAt`？★★
>
> 本課程的 `CreateOrderRequest`（02 章 2.12.1）刻意只有五個欄位：
> `items`（只有 `productId` + `quantity`）、`shippingAddressId`、
> `couponCode`、`customerNote`、`invoice`。
>
> **這個測試的 body 必須與那份 DTO 完全一致** —— 而這件事很容易寫錯：
>
> | 憑印象寫成 | 實際結果 |
> |---|---|
> | `"unitPrice": "1280.50"` | 🔴 `fail-on-unknown-properties: true`（6.5.5）→ **400**，測試紅燈 |
> | `"shippingAddress": { … }` | 🔴 同上 → 400 |
> | `"invoiceType": "PERSONAL"`（扁平） | 🔴 同上（正確的是巢狀的 `invoice.type`） |
>
> ★ **而「400 而不是 201」這個失敗方式其實是好的** ——
> 它證明 6.5.5 的嚴格設定在運作。
> **真正危險的是反過來**：如果 DTO 上真的有 `unitPrice`，
> 這個測試就會通過，而它斷言的正是 00 章 0.6.2 的價格篡改漏洞。
> 👉 所以上面第 ② 段用 `getRecordComponents()` 把「欄位不存在」也測了。

**這一個測試覆蓋了 06 章一整章的設定。**
而它的失敗訊息會直接指到「哪一項設定壞了」。

⚠️ **`captor.capture()` 放在 `when()` 裡與放在 `verify()` 裡的差別**：

```java
// 寫法 A：在 when 裡 capture
when(orderService.create(captor.capture())).thenReturn(sampleOrder());
// ★ 優點：stub 與 capture 一次寫完
// ⚠️ 缺點：如果 Controller 拋例外在呼叫 Service 之前，captor 是空的
//         → captor.getValue() 拋 「No argument value was captured」

// 寫法 B：在 verify 裡 capture
when(orderService.create(any())).thenReturn(sampleOrder());
// ... perform ...
verify(orderService).create(captor.capture());
// ★ 優點：verify 失敗時的訊息更清楚（「沒有呼叫過」vs「參數不對」）
// ★ 推薦這一種
```

**shop-service 統一用寫法 B**，理由是失敗訊息：

```
寫法 A 失敗：
  java.lang.IllegalStateException: No argument value was captured!
  → 完全看不出原因

寫法 B 失敗：
  Wanted but not invoked:
  orderService.create(<Capturing argument>);
  -> at OrderControllerTest.下單請求被正確翻譯成Command(...)

  However, there were other interactions with this mock:
  orderService.validate(...)
  -> at OrderController.create(OrderController.java:64)
  → ★ 直接告訴你「有呼叫別的方法」
```

### 7.6.6 什麼時候不要 mock

**四種「不該 mock」的東西**：

**① 值物件與純函式。**

```java
// 🔴 荒謬但真的有人寫
@Test
void 金額格式化() {
    MoneyFormat format = mock(MoneyFormat.class);
    when(format.format(any(), any())).thenReturn("1280.50");
    assertThat(format.format(new BigDecimal("1280.50"), "TWD")).isEqualTo("1280.50");
}
```

**這個測試斷言的是 Mockito 有沒有壞掉。**

**② `ObjectMapper`。**

06 章 6.5.2 的整節（「永不 `new ObjectMapper()`」）在測試裡同樣成立 ——
**mock 或自己 new 一個 `ObjectMapper` 會讓你的測試用一套設定、
正式環境用另一套**。

```java
// 🔴 錯
private final ObjectMapper mapper = new ObjectMapper();

// ✅ 對
@Autowired ObjectMapper objectMapper;      // 從 context 拿
```

⚠️ **例外**：測試 `JacksonConfig` 本身時，你需要「一個沒有設定的 mapper」
來對照 —— 那時 `new ObjectMapper()` 是正確的（而且要註明理由）。

**③ 驗證器（`jakarta.validation.Validator`）。**

02 章的所有驗證邏輯要真的跑。mock 掉 `Validator` 等於關掉 `@Valid`。

**④ 你自己寫的 mapper（`OrderWebMapper`）。**

```java
// 🔴 錯：mock 掉 mapper，於是「翻譯對不對」完全沒測到
@MockitoBean OrderWebMapper mapper;
```

**這個 mock 讓 7.6.5 的那個測試變成空的** ——
mapper 是「翻譯」本身，mock 掉它就沒有東西可測了。

⚠️ 而它是 `@Component`，所以 `@WebMvcTest` **不會**載入它 ——
於是「我先把它 mock 掉讓 context 起得來」是一個非常自然的動作。
**那正是這個反模式最常見的成因。**

**shop-service 的做法：`@Component` + 在 `WebSliceInfraConfig` 裡明確 `@Import`。**

```java
package example.shop.order.web;

/**
 * HTTP DTO 與 Command / Domain 之間的翻譯（00 章 0.10.3）。
 *
 * <p>★ 它是 {@code @Component} 而不是靜態工具，因為
 * {@code toDetailResponse(...)} 需要 {@code StatusLabelResolver}（06 章 6.5.8）。
 *
 * <p>⚠️⚠️ 而 {@code @WebMvcTest} <b>不載入 {@code @Component}</b>（7.4.2）——
 * 所以它<b>必須</b>在 {@code WebSliceInfraConfig} 裡有一個 bean。
 * <b>絕對不要 mock 它。</b>
 */
@Component
public class OrderWebMapper {

    private final StatusLabelResolver statusLabels;

    public OrderWebMapper(StatusLabelResolver statusLabels) {
        this.statusLabels = statusLabels;
    }

    /** ★ 欄位順序與 01 章 1.12.5 的 record 宣告一致（也與 00 章 0.10.3 相同）。 */
    public CreateOrderCommand toCommand(CreateOrderRequest request,
                                        Actor actor,
                                        String idempotencyKey) {
        return new CreateOrderCommand(
                actor,
                idempotencyKey,
                request.items().stream().map(OrderWebMapper::toLine).toList(),
                request.shippingAddressId(),      // ★ 只有 ID —— Web 層不查資料庫
                request.couponCode(),
                request.customerNote(),
                toInvoiceSpec(request.invoice()));
    }

    /** ★ 只有 productId 與 quantity —— 刻意沒有價格（00 章 0.6.2）。 */
    private static CreateOrderCommand.Line toLine(CreateOrderRequest.Item item) {
        return new CreateOrderCommand.Line(item.productId(), item.quantity());
    }

    // ... 其餘略
}
```

```java
// WebSliceInfraConfig（7.4.4）
/**
 * ★★ mapper 與它的依賴 —— <b>用真的實作</b>。
 *
 * <p>它們是「會影響回應內容」的元件，所以照 7.6.1 那張表的判準：
 * <b>一律用真的</b>。
 */
@Bean StatusLabelResolver statusLabelResolver(MessageSource messageSource) {
    return new StatusLabelResolver(messageSource);
}

@Bean OrderWebMapper orderWebMapper(StatusLabelResolver statusLabels) {
    return new OrderWebMapper(statusLabels);
}
```

⚠️ **一般規則**：`@WebMvcTest` 不載入 `@Component`，
所以 **Controller 依賴的每一個 `@Component` 都必須在
`WebSliceInfraConfig` 裡有一個 bean** ——
而「真的實作還是 mock」的判準是 7.6.1 那張表
（**會影響回應內容的一律用真的**）。

★ 而「忘記加」的失敗方式很清楚：
```
Parameter 0 of constructor in example.shop.order.web.OrderController
required a bean of type 'example.shop.order.web.OrderWebMapper' that could not be found.
```
**那是一個好的失敗** —— 大聲、而且訊息直接告訴你缺什麼。

⚠️ **`statusLabel` 確實需要 `MessageSource`（06 章 6.5.8）**，
所以 `OrderDetail` 的組裝**不能**是 static —— 那部分需要 `StatusLabelResolver`。

⚠️ **`StatusLabelResolver` 也是 `@Component`**，所以它同樣要在
`WebSliceInfraConfig` 裡（見上方的 `@Bean`）。
用真的實作 + 真的 `MessageSource`（切片有 `MessageSourceAutoConfiguration`），
所以「label 對不對」在 ③ 就測得到 —— 那是 06 章 6.5.8 那一整節的價值所在。

**一張「該不該 mock」的速查表**：

| 東西 | mock？ |
|---|---|
| Service 介面 | ✅ |
| Repository | ✅（但 Web 層不該直接碰它 —— 00 章） |
| 外部 HTTP 客戶端 | ✅ |
| `Clock` | ❌ 用 `Clock.fixed()` |
| `ObjectMapper` | ❌ 用 context 的 |
| `MessageSource` | ❌ 用真的（訊息是測試目標） |
| `Validator` | ❌ 用真的 |
| 純函式 / 值物件 | ❌ |
| 你的 mapper | ❌ |
| `Filter` | ❌ **絕對不要**（7.4.4） |
| `RateLimiter` / `IdempotencyStore` | ❌ 用記憶體實作 |
| `MalwareScanner` | ❌ 用 no-op 實作 |

---
## 7.7 測試資料的建構

### 7.7.1 「一個 `createOrder()` 輔助方法」在第 40 個測試時的崩塌

**這是每個專案都會走一遍的路。讓我們把它走完。**

**第 1 個測試**：

```java
private OrderDetail sampleDetail() {
    return new OrderDetail("ord_1", "ORD-20260824-0001", OrderStatus.PAID, ...);
}
```

**第 5 個測試**：需要一個已出貨的訂單。

```java
private OrderDetail sampleDetail() { ... }
private OrderDetail shippedDetail() { ... }        // 複製貼上，改一個欄位
```

**第 12 個測試**：需要「已出貨、有優惠券、兩個項目」的訂單。

```java
private OrderDetail sampleDetail() { ... }
private OrderDetail shippedDetail() { ... }
private OrderDetail shippedWithCouponDetail() { ... }
private OrderDetail twoItemsDetail() { ... }
private OrderDetail shippedWithCouponAndTwoItemsDetail() { ... }   // 🔴 組合爆炸
```

**第 20 個測試**：有人改了 `OrderDetail`，加了一個欄位。

```
🔴 12 個工廠方法全部編譯失敗。
```

**第 25 個測試**：於是有人改成「一個方法帶參數」。

```java
private OrderDetail detail(String id, OrderStatus status, int itemCount,
                           String couponCode, BigDecimal total) { ... }
```

**呼叫的地方**：

```java
when(orderQueryService.findDetail(any(), any()))
        .thenReturn(detail("ord_1", OrderStatus.PAID, 2, null, new BigDecimal("1280.50")));
//                                                        ↑↑↑↑
//                                         這個 null 是什麼？讀者要跳去看簽名
```

**第 32 個測試**：需要控制 `createdAt`。參數變 6 個。
**第 38 個測試**：需要控制 `shippingAddress` 的某個欄位。參數變 8 個。

```java
.thenReturn(detail("ord_1", OrderStatus.PAID, 2, null,
        new BigDecimal("1280.50"), Instant.parse("2026-08-24T02:30:00Z"),
        null, false, null, "TWD"));
//                     ↑↑↑↑↑ 🔴 完全不可讀
```

**第 40 個測試：崩塌。**
沒有人知道那些參數是什麼，於是大家開始複製貼上整行，
**而測試的意圖（「這個測試在測已出貨的訂單」）完全消失在參數列裡**。

**崩塌的三個症狀**：

| 症狀 | 具體表現 |
|---|---|
| **意圖被淹沒** | 讀測試看不出「這個資料為什麼是這樣」 |
| **改 DTO 就大爆炸** | 加一個欄位改 40 個地方 |
| **測試之間耦合** | 改了 `sampleDetail()` 的一個欄位，17 個測試紅燈 |

### 7.7.2 Object Mother

**核心想法：為「有名字的情境」提供工廠方法。**

```java
package example.shop.test.mother;

import example.shop.order.web.dto.OrderDetail;
import example.shop.order.domain.OrderStatus;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;

/**
 * 訂單的 Object Mother。
 *
 * <p>★ 命名規則：方法名是「業務情境」，不是「欄位組合」。
 *    `已付款的單品訂單()` 是好名字。
 *    `detailWithStatusPaidAndOneItem()` 是壞名字（那是欄位組合）。
 *
 * <p>⚠️ Object Mother 的界線：**它只提供「有名字的情境」**。
 *    一旦有人想要「已出貨、有優惠券、但金額是 0」這種沒有名字的組合，
 *    那就不該加一個方法 —— 該用 Test Data Builder（7.7.3）。
 */
public final class Orders {

    private Orders() {}

    public static final Instant FIXED_CREATED_AT =
            Instant.parse("2026-08-24T02:30:00.000Z");

    /** 最常見的情境：已付款、單一品項、無優惠券。 */
    public static OrderDetail 已付款的單品訂單() {
        return new OrderDetail(
                "ord_01J5GKA1", "ORD-20260824-0001",
                OrderStatus.PAID, "已付款",
                List.of(Items.無線滑鼠(1)),
                new BigDecimal("1280.50"), "TWD",
                Addresses.台北市中正區(),
                null,                       // couponCode
                FIXED_CREATED_AT,
                null,                       // shippedAt
                null);                      // cancelledAt
    }

    /** ★ 已出貨 —— 用來測「不可取消」（03 章 ORDER_NOT_CANCELLABLE）。 */
    public static OrderDetail 已出貨的訂單() {
        return 已付款的單品訂單().withStatus(OrderStatus.SHIPPED)
                .withShippedAt(FIXED_CREATED_AT.plusSeconds(86_400));
    }

    /** ★ 空訂單 —— 用來測 022 章的 ORDER_EMPTY 與集合序列化（6.5.9）。 */
    public static OrderDetail 沒有品項的訂單() {
        return 已付款的單品訂單().withItems(List.of())
                .withTotalAmount(BigDecimal.ZERO);
    }

    /** ★ 全 null —— 06 章 6.7.4 的 DtoSerializabilityTest 用。 */
    public static OrderDetail 所有選填欄位都是null的訂單() {
        return new OrderDetail(
                "ord_01J5GKA1", "ORD-20260824-0001",
                OrderStatus.PENDING_PAYMENT, "待付款",
                List.of(), BigDecimal.ZERO, "TWD",
                null, null, FIXED_CREATED_AT, null, null);
    }

    /** ★ 「每一個欄位都有值」—— 用來測 STRICT 的 content().json()（7.5.3）。 */
    public static OrderDetail 所有欄位都有值的訂單() { ... }
}
```

**Object Mother 的優點與界線**：

| | |
|---|---|
| ✅ 測試的意圖非常清楚 | `when(...).thenReturn(Orders.已出貨的訂單())` |
| ✅ 加欄位只改一個地方 | 所有情境都從 `已付款的單品訂單()` 衍生 |
| 🔴 **不處理「一次性的組合」** | 「已出貨 + 折扣 100% + 兩個品項」不值得一個名字 |
| 🔴 情境數量會增長 | 15 個以上就開始難找 |

### 7.7.3 Test Data Builder

**核心想法：從一個合法的預設值開始，只覆寫你在意的欄位。**

```java
package example.shop.test.builder;

/**
 * OrderDetail 的 builder。
 *
 * <p>★ 三個設計決定：
 * <ol>
 *   <li><b>預設值必須是「合法且最常見」的</b> ——
 *       這樣測試只需要寫出「與預設不同的部分」，
 *       而那部分正好就是測試的意圖。</li>
 *   <li><b>不提供 build() 之外的驗證</b> ——
 *       builder 要能造出「不合法」的資料（那是很多測試的目的）。</li>
 *   <li><b>方法名與欄位名一致</b> —— 不要 setXxx，直接 xxx()。</li>
 * </ol>
 */
public final class OrderDetailBuilder {

    // ★ 預設值：一個合法、最常見的訂單
    private String orderId       = "ord_01J5GKA1";
    private String orderNumber   = "ORD-20260824-0001";
    private OrderStatus status   = OrderStatus.PAID;
    private List<OrderItemDto> items = new ArrayList<>(List.of(Items.無線滑鼠(1)));
    private BigDecimal totalAmount   = new BigDecimal("1280.50");
    private String currency          = "TWD";
    private ShippingAddressDto address = Addresses.台北市中正區();
    private String couponCode        = null;
    private Instant createdAt        = Orders.FIXED_CREATED_AT;
    private Instant shippedAt        = null;
    private Instant cancelledAt      = null;

    public static OrderDetailBuilder anOrderDetail() {
        return new OrderDetailBuilder();
    }

    public OrderDetailBuilder orderId(String v)        { this.orderId = v;     return this; }
    public OrderDetailBuilder status(OrderStatus v)    { this.status = v;      return this; }
    public OrderDetailBuilder items(OrderItemDto... v) {
        this.items = new ArrayList<>(List.of(v));                             return this; }
    public OrderDetailBuilder noItems()                { this.items.clear();   return this; }
    public OrderDetailBuilder totalAmount(String v)    {
        this.totalAmount = new BigDecimal(v);                                 return this; }
    public OrderDetailBuilder couponCode(String v)     { this.couponCode = v;  return this; }
    public OrderDetailBuilder shippedAt(Instant v)     { this.shippedAt = v;   return this; }
    public OrderDetailBuilder currency(String v)       { this.currency = v;    return this; }

    /** ★ 「情境」的捷徑 —— 讓 builder 也能表達意圖。 */
    public OrderDetailBuilder 已出貨() {
        return status(OrderStatus.SHIPPED)
                .shippedAt(Orders.FIXED_CREATED_AT.plusSeconds(86_400));
    }

    public OrderDetail build() {
        return new OrderDetail(orderId, orderNumber, status,
                StatusLabels.of(status),        // ★ label 要跟 status 一致
                List.copyOf(items), totalAmount, currency,
                address, couponCode, createdAt, shippedAt, cancelledAt);
    }
}
```

**使用**：

```java
// ★ 讀者一眼看出「這個測試在意的是 status 與 shippedAt」
when(orderQueryService.findDetail(any(), any()))
        .thenReturn(anOrderDetail().已出貨().build());

// ★ 一次性的組合，不需要在 Object Mother 加方法
when(orderQueryService.findDetail(any(), any()))
        .thenReturn(anOrderDetail()
                .已出貨()
                .couponCode("SUMMER2026")
                .totalAmount("0")
                .currency("USD")
                .build());
```

⚠️ **`StatusLabels.of(status)` 這一行很重要。**
如果 builder 讓 `status` 與 `statusLabel` 可以獨立設定，
就會造出「`status=SHIPPED` 但 `statusLabel=已付款`」的不可能資料 ——
而基於那種資料的測試，**通過與否都沒有意義**。

> **Builder 的預設值與衍生規則，本身就是「什麼樣的資料是合法的」的文件。**

### 7.7.4 shop-service 的選擇：`record` + `withXxx`

**Java 的 record 沒有內建 `with` 方法**，但可以手寫。
而對「只改一兩個欄位」的情境，這比 builder 更輕。

```java
public record OrderDetail(
        String orderId,
        String orderNumber,
        OrderStatus status,
        String statusLabel,
        List<OrderItemDto> items,
        BigDecimal totalAmount,
        String currency,
        ShippingAddressDto shippingAddress,
        String couponCode,
        Instant createdAt,
        Instant shippedAt,
        Instant cancelledAt
) {
    // ⚠️ 這些 withXxx 該放在**正式碼**還是**測試碼**？
    //
    //   放正式碼：所有人都能用，但 DTO 多了 12 個沒人在正式流程用的方法。
    //   放測試碼：需要一個 OrderDetailTestExtensions（Java 沒有 extension method）。
    //
    // ★ shop-service 的決定：放測試碼的 builder 裡（7.7.3），
    //   正式的 record 保持乾淨。
    //
    // 理由：06 章 6.7.5 的資訊洩漏檢查會掃描 DTO 的所有 accessor ——
    //      多 12 個方法會讓那個檢查變吵。
}
```

**所以最終的分工是三層**：

```
Orders（Object Mother）           ← 「有名字的情境」，最常用的 8～12 個
   ↓ 內部用
OrderDetailBuilder（Builder）      ← 一次性的組合
   ↓ 內部用
new OrderDetail(...)              ← 只有 builder 呼叫
```

**一張選擇表**：

| 情況 | 用什麼 |
|---|---|
| 這個情境會用在 3 個以上的測試 | **Object Mother** 加一個有名字的方法 |
| 這個測試需要一個奇怪的組合 | **Builder** |
| 這個測試需要「除了 X 以外都跟預設一樣」 | **Builder**（只寫 X） |
| 這個測試需要「全部欄位都有值」 | Object Mother 的 `所有欄位都有值的訂單()` |
| 這個測試需要「全部選填欄位都 null」 | Object Mother 的 `所有選填欄位都是null的訂單()` |

⚠️ **最後兩個是刻意放在 Object Mother 而不是 builder 的** ——
它們是**契約層級的 fixture**（06 章 6.7.4 的 `DtoSerializabilityTest`、
7.5.3 的 STRICT `content().json()` 都用它們），
所以「這兩個長什麼樣」應該只有一個答案。

### 7.7.5 JSON 測試資料：字串常數 vs 檔案 vs builder

**三種寫法，各有適用場合。**

**寫法一：inline text block（★ 預設選擇）**

```java
mockMvc.perform(post("/orders")
        .contentType(APPLICATION_JSON)
        .content("""
                {"items":[{"productId":"P-1001","quantity":2}],
                 "shippingAddressId":"adr_01J5GKA1B2C3D4E5F6G7H8"}
                """))
```

| ✅ | 🔴 |
|---|---|
| 測試自足，看得到完整的請求 | 長的 JSON 會淹沒測試 |
| **可以刻意寫「不合法」的 JSON**（缺欄位、多欄位、型別錯） | 改契約要改很多地方 |
| 不需要跳檔案 | 沒有語法檢查（`{` 少一個，錯誤訊息很怪） |

**★ 這是「測反序列化」的唯一正確做法。**
因為 builder 造出的物件**已經是合法的 Java 物件了** ——
你要測的正是「這串不合法的字元會怎樣」。

**寫法二：`src/test/resources` 的檔案**

```java
private String json(String name) throws IOException {
    try (var in = getClass().getResourceAsStream("/requests/" + name)) {
        return new String(Objects.requireNonNull(in, name).readAllBytes(), UTF_8);
    }
}

mockMvc.perform(post("/orders").contentType(APPLICATION_JSON)
        .content(json("create-order-full.json")))
```

| ✅ | 🔴 |
|---|---|
| 大的 payload 不淹沒測試 | **測試不再自足** —— 要跳檔案才知道在測什麼 |
| 可以被 JSON schema 驗證 | 檔案容易變成「沒人敢改的孤兒」 |
| 可以跟 API 文件共用同一份 | 檔名與測試的對應關係要自己維護 |

**★ 適用時機：payload 超過 30 行，或需要與文件共用。**

⚠️ **一個實用的折衷**：檔案 + 一句話註解說明它的特徵。

```java
// 一個「41 個欄位全部有值」的完整下單請求（與 docs/examples 共用同一份）
.content(json("create-order-full.json"))
```

**寫法三：物件 → `objectMapper.writeValueAsString`**

```java
mockMvc.perform(post("/orders").contentType(APPLICATION_JSON)
        .content(objectMapper.writeValueAsString(
                aCreateOrderRequest().couponCode("SUMMER2026").build())))
```

| ✅ | 🔴 |
|---|---|
| 改 DTO 會編譯失敗（好事） | **🔴🔴 序列化與反序列化用同一套設定 → 測不到不對稱的問題** |
| 不會寫出語法錯的 JSON | 造不出「不合法」的請求 |

⚠️ **這個寫法有一個嚴重的盲點**：

```java
// CreateOrderRequest 有一個欄位叫 shippingAddressId，
// 而 Jackson 的命名策略被人改成 snake_case（06 章 6.5.4）

// writeValueAsString → {"shipping_address_id": "adr_1"}
// 反序列化           → 讀 "shipping_address_id" → ✅ 成功
// 測試通過 ✅

// 而真實的客戶端送的是 {"shippingAddressId": "adr_1"} → 🔴 400
```

**「往返測試一定會通過」正是它的問題** ——
它證明的是「序列化與反序列化互為反函式」，
**而不是「我們的線路格式與客戶端一致」**。

> **所以請求的 JSON 一律寫死（寫法一或二）。
> 寫法三只用在「不在意線路格式」的地方**（例如產生大量隨機資料做壓力測試）。

**shop-service 的規則**：

| 測什麼 | 用哪一種 |
|---|---|
| 反序列化、驗證、錯誤格式 | **寫法一**（inline） |
| 完整的 happy path（大 payload） | **寫法二**（檔案，與文件共用） |
| 隨機/大量資料 | 寫法三 |
| **絕不** | 用寫法三測「欄位命名」或「格式」 |

### 7.7.6 「壞資料」的目錄化

**02 章 2.9 與 03 章 3.9 花了很多篇幅講「輸入錯誤的分類」。
那份分類應該變成一份可以被參數化測試消費的目錄。**

```java
package example.shop.test;

import java.util.List;

/**
 * 「壞的 JSON 請求」目錄。
 *
 * <p>★★ 這份目錄是 02 章與 03 章的可執行版本。
 *
 * <p>它的價值不在「每一個案例」，而在**它是一份清單** ——
 * 新增一個端點時，把這整份目錄跑一遍，
 * 就知道「有沒有哪一類壞輸入的處理不對」。
 *
 * <p>⚠️ 每一筆都要標明期望的狀態碼與 code ——
 *    否則測試會退化成「反正不是 500 就好」，
 *    而那漏掉了 400 vs 422 這個重要的區分（03 章 3.2）。
 */
public final class BadRequests {

    private BadRequests() {}

    public record Case(String name, String body, int expectedStatus, String expectedCode) {
        /** ★ 讓 @ParameterizedTest 的名字只印 name，不印整個 body（7.8.5）。 */
        @Override public String toString() { return name; }
    }

    // ═══════════════════════════════════════════════════════════════
    //  第一組：universal —— 對【任何】接收 JSON body 的端點都成立
    //
    //  ★★ 為什麼要分成兩組（這是「把目錄套到第二個端點」時才發現的問題，
    //     見 7.16 練習 3）：
    //
    //  下面 forCreateOrder() 的案例用的是 CreateOrderRequest 的欄位。
    //  把它們套到別的端點（例如 POST /orders/{id}/merges）時，
    //  {"items":[...]} 對那個端點來說是【未知欄位】——
    //  於是期望的 422 VALIDATION_FAILED 實際會是 400 MALFORMED_REQUEST。
    //
    //  ⚠️ 而「修法」很容易變成「把期望值改成 400」——
    //     那樣就再也測不到那個端點的驗證規則了。
    //
    //  👉 所以：universal() 給所有端點跑，forXxx() 只給對應的端點跑。
    // ═══════════════════════════════════════════════════════════════

    /** JSON 語法 —— 與 DTO 完全無關。 */
    public static List<Case> jsonSyntax() {
        return List.of(
                new Case("完全不是 JSON", "not json at all", 400, "MALFORMED_REQUEST"),
                new Case("空字串", "", 400, "MALFORMED_REQUEST"),
                new Case("只有空白", "   ", 400, "MALFORMED_REQUEST"),
                new Case("缺右大括號", "{\"items\":[]", 400, "MALFORMED_REQUEST"),
                new Case("多一個逗號", "{\"items\":[],}", 400, "MALFORMED_REQUEST"),
                new Case("單引號", "{'items':[]}", 400, "MALFORMED_REQUEST"),
                new Case("JSON 陣列而不是物件", "[]", 400, "MALFORMED_REQUEST"),
                new Case("JSON null", "null", 400, "MALFORMED_REQUEST"),
                new Case("JSON 純數字", "42", 400, "MALFORMED_REQUEST")
        );
    }

    /**
     * 安全 —— 與 DTO 無關的部分。
     *
     * <p>★ 「未知欄位」對任何端點都是 400（06 章 6.5.5 的
     * {@code fail-on-unknown-properties: true}），所以它是 universal。
     *
     * <p>⚠️ 注意這幾個案例的 body 刻意<b>只有一個欄位</b>。
     * 第一版寫成
     * {@code {"items":[...],"shippingAddress":{...},"@class":"java.lang.Runtime"}}，
     * 而那個 body 有<b>兩個</b>問題（`shippingAddress` 也是未知欄位）——
     * 於是它得到 400 的原因不是我們想測的那一個。
     * <b>那正是 7.6.3「測試在測一件你沒想測的事」的同一個形狀。</b>
     */
    public static List<Case> security() {
        return List.of(
                new Case("★ 未知欄位（06 章 6.5.5 的嚴格決定）",
                        "{\"__definitelyNotAField\":true}", 400, "MALFORMED_REQUEST"),
                new Case("★ mass assignment：想塞一個伺服器決定的欄位（6.7.2）",
                        "{\"totalAmount\":\"1\"}", 400, "MALFORMED_REQUEST"),
                new Case("★ 想塞 Jackson 的 type id（6.7.1 的 RCE 前哨）",
                        "{\"@class\":\"java.lang.Runtime\"}", 400, "MALFORMED_REQUEST"),
                new Case("★ 原型汙染的保留字（6.7.2）",
                        "{\"__proto__\":{\"admin\":true}}", 400, "MALFORMED_REQUEST")
        );
    }

    /** 深度炸彈與大字串（06 章 6.7.3 的 StreamReadConstraints）—— 與 DTO 無關。 */
    public static List<Case> bombs() {
        return List.of(
                new Case("巢狀 2000 層",
                        "{\"a\":".repeat(2000) + "1" + "}".repeat(2000),
                        400, "MALFORMED_REQUEST"),
                new Case("6 MB 的字串",
                        "{\"couponCode\":\"" + "A".repeat(6_000_000) + "\"}",
                        413, "PAYLOAD_TOO_LARGE"),
                new Case("超長數字（1 萬位）",
                        "{\"quantity\":" + "9".repeat(10_000) + "}",
                        400, "MALFORMED_REQUEST")
        );
    }

    /** ★ 對所有接收 JSON 的端點都成立的那一組。 */
    public static List<Case> universal() {
        var all = new java.util.ArrayList<Case>();
        all.addAll(jsonSyntax());
        all.addAll(security());
        all.addAll(bombs());
        return all;
    }

    // ═══════════════════════════════════════════════════════════════
    //  第二組：只給 POST /orders 用
    //  （欄位來自 CreateOrderRequest —— 02 章 2.12.1 的正式版）
    // ═══════════════════════════════════════════════════════════════

    /** ★ 把合法 body 的一個地方換掉 —— 讓每個案例只有「一處不同」。 */
    private static String withItems(String itemsJson) {
        return """
               {"items":%s,"shippingAddressId":"adr_01J5GKA1B2C3D4E5F6G7H8"}
               """.formatted(itemsJson);
    }

    public static List<Case> typeMismatchForCreateOrder() {
        return List.of(
                new Case("quantity 是字串",
                        withItems("[{\"productId\":\"P-1001\",\"quantity\":\"兩個\"}]"),
                        400, "MALFORMED_REQUEST"),
                new Case("items 是物件而不是陣列",
                        withItems("{\"productId\":\"P-1001\"}"),
                        400, "MALFORMED_REQUEST"),
                new Case("★ 未知的 enum 值（06 章 6.5.8）",
                        """
                        {"items":[{"productId":"P-1001","quantity":1}],
                         "shippingAddressId":"adr_01J5GKA1B2C3D4E5F6G7H8",
                         "invoice":{"type":"BITCOIN"}}
                        """, 400, "MALFORMED_REQUEST")
        );
    }

    public static List<Case> validationForCreateOrder() {
        return List.of(
                new Case("★ 缺必填欄位 → 422 而不是 400（06 章 6.5.3）",
                        "{\"items\":[{\"productId\":\"P-1001\",\"quantity\":1}]}",
                        422, "VALIDATION_FAILED"),
                new Case("items 是空陣列", withItems("[]"), 422, "VALIDATION_FAILED"),
                new Case("quantity 是 0",
                        withItems("[{\"productId\":\"P-1001\",\"quantity\":0}]"),
                        422, "VALIDATION_FAILED"),
                new Case("quantity 是負數",
                        withItems("[{\"productId\":\"P-1001\",\"quantity\":-1}]"),
                        422, "VALIDATION_FAILED"),
                new Case("★ quantity 超過單品上限 999（02 章 2.12.1 的 @Max）",
                        withItems("[{\"productId\":\"P-1001\",\"quantity\":1000}]"),
                        422, "VALIDATION_FAILED"),
                new Case("★ items 超過 50 筆（02 章 2.12.1 的 @Size(max=50)）",
                        withItems("[" + "{\"productId\":\"P-1001\",\"quantity\":1},"
                                .repeat(50) + "{\"productId\":\"P-9999\",\"quantity\":1}]"),
                        422, "VALIDATION_FAILED"),
                new Case("★ 總件數超過 1000（@AssertTrue 的跨欄位驗證）",
                        withItems("[{\"productId\":\"P-1001\",\"quantity\":999},"
                                + "{\"productId\":\"P-2002\",\"quantity\":999}]"),
                        422, "VALIDATION_FAILED"),
                new Case("★ 重複的 productId（@AssertTrue 的跨欄位驗證）",
                        withItems("[{\"productId\":\"P-1001\",\"quantity\":1},"
                                + "{\"productId\":\"P-1001\",\"quantity\":1}]"),
                        422, "VALIDATION_FAILED"),
                new Case("超長的 customerNote（10 萬字元）",
                        """
                        {"items":[{"productId":"P-1001","quantity":1}],
                         "shippingAddressId":"adr_01J5GKA1B2C3D4E5F6G7H8",
                         "customerNote":"%s"}
                        """.formatted("字".repeat(100_000)),
                        422, "VALIDATION_FAILED"),
                new Case("★ 公司發票缺統編（@ValidInvoice 的跨欄位規則）",
                        """
                        {"items":[{"productId":"P-1001","quantity":1}],
                         "shippingAddressId":"adr_01J5GKA1B2C3D4E5F6G7H8",
                         "invoice":{"type":"COMPANY"}}
                        """, 422, "VALIDATION_FAILED")
        );
    }

    /** ★ POST /orders 的完整目錄 = universal + 這個端點特有的。 */
    public static List<Case> forCreateOrder() {
        var all = new java.util.ArrayList<>(universal());
        all.addAll(typeMismatchForCreateOrder());
        all.addAll(validationForCreateOrder());
        return all;
    }
}
```

**消費它**：

```java
/**
 * ★★ 一個測試方法，覆蓋 30 幾種壞輸入。
 *
 * <p>它的價值：新增一個「壞輸入的分類」時，
 *    只要加進 BadRequests，**所有端點的測試自動涵蓋它**。
 */
@ParameterizedTest(name = "[{index}] {0} → {2} {3}")
@MethodSource("example.shop.test.BadRequests#forCreateOrder")
void 下單端點對每一種壞輸入的回應(BadRequests.Case c) throws Exception {
    mockMvc.perform(post("/orders")
                    .header("Idempotency-Key", "idem-bad-" + c.name().hashCode())
                    .contentType(MediaType.APPLICATION_JSON)
                    .characterEncoding(StandardCharsets.UTF_8)
                    .content(c.body()))
            .andExpect(status().is(c.expectedStatus()))
            .andExpect(jsonPath("$.code").value(c.expectedCode()))
            // ★★ 三個「不管哪一種壞輸入都必須成立」的斷言
            .andExpect(content().contentTypeCompatibleWith("application/problem+json"))
            .andExpect(jsonPath("$.traceId").isNotEmpty())
            .andExpect(jsonPath("$.detail", not(containsString("example.shop"))));
}
```

⚠️ **最後三個斷言是這個測試最有價值的部分**：

| 斷言 | 守住什麼 |
|---|---|
| `contentTypeCompatibleWith("application/problem+json")` | 03 章 3.10.4 的「四層格式一致」 |
| `traceId` 不為空 | 04 章 4.4 的追蹤 —— **每一個錯誤都要能查** |
| `detail` 不含 `example.shop` | 03 章 3.11 的資訊洩漏防護 |

**這三件事在 30 幾種壞輸入下都成立，是一個很強的保證** ——
而它只需要三行。

---
## 7.8 參數化測試：讓覆蓋變得便宜

**參數化測試的價值不是「少打字」，而是改變成本結構**：

```
沒有參數化：覆蓋 83 個 ErrorCode = 寫 83 個測試方法
            → 沒有人會做 → 實際只測了 6 個常見的

有參數化：  覆蓋 83 個 ErrorCode = 寫 1 個測試方法 + 1 個 @MethodSource
            → 而且**新增第 84 個 code 時自動被涵蓋**
```

**★ 最後那一句是重點。** 參數化測試真正買到的是
「**新增資料時測試自動跟上**」——
那讓「忘記為新東西寫測試」變成不可能。

### 7.8.1 五種 source 與它們的適用場合

```java
// ① @ValueSource：單一參數的簡單清單
@ParameterizedTest
@ValueSource(strings = {"PAID", "SHIPPED", "DELIVERED"})
void 這些狀態不可取消(String status) { ... }

@ParameterizedTest
@ValueSource(ints = {0, -1, -100, Integer.MIN_VALUE})
void 非正數的數量被拒絕(int quantity) { ... }

// ② @CsvSource：多參數，寫在註解裡
@ParameterizedTest
@CsvSource({
        "  1,  20, 200",
        "  1, 101, 422",
        "501,  20, 422",
})
void 分頁參數(int page, int size, int expectedStatus) { ... }

// ③ @CsvFileSource：多參數，寫在檔案裡
@ParameterizedTest
@CsvFileSource(resources = "/authz-matrix.csv", numLinesToSkip = 1)
void 授權矩陣(String method, String uri, String role, int expectedStatus) { ... }

// ④ @EnumSource：★ 覆蓋一個 enum 的所有值
@ParameterizedTest
@EnumSource(OrderStatus.class)
void 每個狀態都有顯示文字(OrderStatus status) { ... }

@ParameterizedTest
@EnumSource(value = OrderStatus.class,
            names = {"PENDING_PAYMENT", "PAID"})              // 只要這些
void 可修改地址的狀態(OrderStatus status) { ... }

@ParameterizedTest
@EnumSource(value = OrderStatus.class,
            names = {"PENDING_PAYMENT", "PAID"},
            mode = EnumSource.Mode.EXCLUDE)                   // ★ 排除這些
void 不可修改地址的狀態(OrderStatus status) { ... }

// ⑤ @MethodSource：★★ 最強大，回傳任意型別
@ParameterizedTest
@MethodSource("errorCodes")
void 每個ErrorCode都有訊息(ErrorCode code) { ... }

static Stream<ErrorCode> errorCodes() {
    return Arrays.stream(ErrorCode.values());
}
```

**選擇表**：

| source | 用在 | 界線 |
|---|---|---|
| `@ValueSource` | 一個參數、5～15 個值 | 只支援基本型別與 `String`、`Class` |
| `@CsvSource` | 2～4 個參數、10～30 列 | 超過 30 列就該搬去檔案 |
| `@CsvFileSource` | 大表格（授權矩陣） | ⚠️ 測試不再自足 |
| **`@EnumSource`** | **enum 的完整覆蓋** ★ | 這是它的殺手級用途（7.8.3） |
| **`@MethodSource`** | **任意物件、需要計算的資料** ★ | 幾乎萬用 |

**★ 一個常被忽略的 source：`@ArgumentsSource`。**

```java
/**
 * 當「資料來源本身需要依賴」時用它。
 *
 * <p>例：授權矩陣需要從 RequestMappingHandlerMapping 取得所有端點 ——
 *    而 @MethodSource 的方法必須是 static，拿不到 Spring 的 bean。
 */
public class AllEndpointsProvider implements ArgumentsProvider {
    @Override
    public Stream<? extends Arguments> provideArguments(ExtensionContext ctx) {
        var appContext = SpringExtension.getApplicationContext(ctx);   // ★ 拿得到 context
        var mapping = appContext.getBean(RequestMappingHandlerMapping.class);
        return mapping.getHandlerMethods().entrySet().stream()
                .flatMap(AllEndpointsProvider::toEndpoints)
                .map(Arguments::of);
    }
    // ...
}
```

⚠️ **`SpringExtension.getApplicationContext(ctx)` 是這裡的關鍵** ——
它讓 `ArgumentsProvider` 能存取 Spring context，
**而 `@MethodSource` 的 static 方法做不到**。7.9.2 會完整用到它。

### 7.8.2 用一個測試覆蓋 83 個 `ErrorCode`

03 章 3.4.5 已經有一個「每個 code 都有訊息」的測試。
**這裡把它擴充成「每個 code 的完整契約」。**

```java
package example.shop.contract;

import example.shop.common.error.ErrorCode;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.MessageSource;
import org.springframework.context.NoSuchMessageException;

import java.util.Locale;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;

/**
 * 83 個 ErrorCode 的完整契約測試。
 *
 * <p>★ 為什麼是 @SpringBootTest 而不是 @WebMvcTest：
 *    它需要真的 MessageSource（含所有 properties 檔），
 *    而不需要 MVC —— 所以用 @SpringBootTest 但不 @AutoConfigureMockMvc。
 *
 * <p>★★ 這個測試的真正價值：**新增第 84 個 code 時，
 *    它會立刻紅燈並告訴你「還缺什麼」** ——
 *    而不是等到那個錯誤真的在正式環境發生時，前端看到一句 i18n key。
 */
@SpringBootTest
@DisplayName("ErrorCode 註冊表的完整契約")
class ErrorCodeContractTest {

    @Autowired MessageSource messageSource;

    /**
     * 保留給後續章節的 code —— 加進來要在 PR 說明。
     *
     * <p>⚠️ <b>這份清單必須與 03 章 3.14.5 的 {@code PLANNED_FOR_LATER} 一致</b>
     * （那裡有 15 個）。兩份清單分岔的話：
     * <ul>
     *   <li>這裡多了 → 某個 code 的 OpenAPI 檢查被跳過（漏測）</li>
     *   <li>這裡少了 → 那個 code 因為「還沒寫進 orders-api.yaml」而紅燈（假警報）</li>
     * </ul>
     *
     * <p>★ 所以<b>不要複製清單，直接引用</b>：
     * <pre>
     * private static final Set&lt;ErrorCode&gt; PLANNED_FOR_LATER =
     *         ErrorCodeUsageTest.PLANNED_FOR_LATER;   // ★ 03 章 3.14.5 的那一份
     * </pre>
     *
     * <p>⚠️⚠️ 而 {@code FORBIDDEN_PARAMETER} <b>不在</b>這份清單裡 ——
     * 它在 06 章 6.5.5（{@code @ReadOnlyField} + {@code ReadOnlyFieldInterceptor}）
     * 就已經在用了（403）。第一版把它列進來，那是錯的。
     */
    private static final Set<ErrorCode> PLANNED_FOR_LATER =
            example.shop.contract.ErrorCodeUsageTest.PLANNED_FOR_LATER;

    @ParameterizedTest(name = "{0}")
    @EnumSource(ErrorCode.class)
    void 每個code都有正體中文的title與userMessage(ErrorCode code) {
        assertThatCode(() -> messageSource.getMessage(
                        code.titleKey(), null, Locale.TAIWAN))
                .as("""
                    %s 缺少 title。

                    請在 src/main/resources/error-messages_zh_TW.properties 加上：
                      %s=（一句名詞短語，例如「庫存不足」）

                    ⚠️ 沒有它的話，前端會看到 "error.%s.title" 這串 key。
                    """, code, code.titleKey(), code.name())
                .doesNotThrowAnyException();

        assertThatCode(() -> messageSource.getMessage(
                        code.userMessageKey(), null, Locale.TAIWAN))
                .as("%s 缺少 userMessage（key：%s）", code, code.userMessageKey())
                .doesNotThrowAnyException();
    }

    @ParameterizedTest(name = "{0}")
    @EnumSource(ErrorCode.class)
    void title與userMessage的格式規則(ErrorCode code) {
        String title = messageSource.getMessage(code.titleKey(), null, Locale.TAIWAN);
        String userMessage = messageSource.getMessage(
                code.userMessageKey(), null, Locale.TAIWAN);

        // ★ title 是「名詞短語」，不該有句號（03-rest-api 4.4.2）
        assertThat(title)
                .as("%s 的 title 不該以句號結尾（它是標題不是句子）", code)
                .doesNotEndWith("。")
                .hasSizeBetween(2, 20);

        // ★ userMessage 是「給人看的完整句子」
        assertThat(userMessage)
                .as("%s 的 userMessage 太短，可能只是 title 的複製", code)
                .hasSizeGreaterThan(6);

        // ★★ userMessage 不可以含技術詞彙（03 章 3.11.2）
        assertThat(userMessage)
                .as("""
                    %s 的 userMessage 含有技術詞彙：「%s」

                    userMessage 是要直接顯示給終端使用者的 ——
                    「Constraint violation」「NullPointerException」「SQL」
                    這種字對他們沒有意義，而且洩漏了實作。
                    """, code, userMessage)
                .doesNotContainIgnoringCase("exception")
                .doesNotContainIgnoringCase("null")
                .doesNotContainIgnoringCase("sql")
                .doesNotContainIgnoringCase("constraint")
                .doesNotContain("example.shop");
    }

    @ParameterizedTest(name = "{0}")
    @EnumSource(ErrorCode.class)
    void typeSlug的格式(ErrorCode code) {
        // ★ 它會變成 URI 的一部分：https://api.shop.example/problems/{slug}
        assertThat(code.typeSlug())
                .as("%s 的 typeSlug 必須是 kebab-case（它會出現在 URI 裡）", code)
                .matches("^[a-z][a-z0-9]*(-[a-z0-9]+)*$")
                .hasSizeLessThan(60);
    }

    @ParameterizedTest(name = "{0}")
    @EnumSource(ErrorCode.class)
    void retry策略與狀態碼一致(ErrorCode code) {
        // ★★ 這是一個「跨欄位的一致性」規則，
        //    而它是 03-rest-api 4.9 的核心約定。

        if (code.status().is5xxServerError()
                && code.status() != org.springframework.http.HttpStatus.NOT_IMPLEMENTED) {
            assertThat(code.retryable())
                    .as("""
                        %s 是 5xx 但標記為不可重試。

                        5xx 代表「伺服器端的問題」——
                        客戶端重試在語意上通常是安全的。
                        如果這個 code 真的不該重試（例如「請求本身永遠會失敗」），
                        那它可能不該是 5xx。
                        """, code)
                    .isTrue();
        }

        if (code.status().value() == 422 || code.status().value() == 400) {
            // ⚠️ 400/422 通常不可重試（重送一樣的請求還是一樣的結果），
            //    但 MODIFY_REQUEST 與 REFETCH_THEN_RETRY 是合理的例外
            assertThat(code.retry())
                    .as("""
                        %s 是 %s，但重試策略是 %s。

                        400/422 代表「請求本身有問題」——
                        重送同樣的請求不會成功。合理的策略只有：
                          NONE               —— 完全不可重試
                          MODIFY_REQUEST     —— 改了請求內容再送
                          REFETCH_THEN_RETRY —— 重新取得資料再送
                        """, code, code.status(), code.retry())
                    .isIn(ErrorCode.Retry.NONE,
                          ErrorCode.Retry.MODIFY_REQUEST,
                          ErrorCode.Retry.REFETCH_THEN_RETRY);
        }
    }

    @ParameterizedTest(name = "{0}")
    @EnumSource(ErrorCode.class)
    void 每個code都在OpenAPI的錯誤列表裡(ErrorCode code) throws Exception {
        // ★ 03-rest-api 第 07 章的 orders-api.yaml 有一份 code 的 enum
        Set<String> documented = OpenApiErrorCodes.readFrom("orders-api.yaml");

        if (PLANNED_FOR_LATER.contains(code)) return;

        assertThat(documented)
                .as("""
                    %s 沒有出現在 orders-api.yaml 的錯誤碼清單裡。

                    客戶端是依那份清單寫 switch 的（03-rest-api 4.4.4）——
                    沒有記錄的 code 會落到客戶端的 default 分支，
                    而那通常顯示「未知錯誤」。
                    """, code)
                .contains(code.name());
    }
}
```

**這五個測試方法 × 83 個 code = 415 個測試案例，總共約 0.6 秒。**

**而它們抓到的問題類型**：

| 測試 | 抓到過的真實問題 |
|---|---|
| 有 title/userMessage | 新增 code 時忘了加訊息（**最常見**） |
| 格式規則 | userMessage 直接複製了 exception message |
| typeSlug 格式 | 有人寫 `order_not_cancellable`（底線）→ URI 不一致 |
| retry 一致性 | `PAYMENT_GATEWAY_TIMEOUT` 被標成不可重試 → 客戶端不重試 → 訂單卡住 |
| OpenAPI 一致 | 後端加了 code 但沒更新契約 → 客戶端顯示「未知錯誤」 |

### 7.8.3 覆蓋所有 enum 值：`@EnumSource` 的殺手級用途

**06 章 6.5.8 的核心結論**：
「新增一個 enum 值不再是破壞性變更」的前提是
**每個 enum 值都有 `statusLabel`**。

```java
/**
 * 06 章 6.5.8 的 StatusLabelCompletenessTest 的完整版。
 *
 * <p>★★ 這個測試的關鍵斷言是 isNotEqualTo(status.name()) ——
 *    見下方說明。
 */
@ParameterizedTest(name = "{0}")
@EnumSource(OrderStatus.class)
void 每個訂單狀態都有顯示文字(OrderStatus status) {
    // ★ 06 章 6.5.8 的 API 是 label(...)，而 locale 走 LocaleContextHolder
    //   （不是一個參數）—— 所以測試要自己設 locale
    LocaleContextHolder.setLocale(Locale.TAIWAN);
    String label = statusLabelResolver.label(status);

    assertThat(label).isNotNull().isNotBlank();

    // ★★ 核心斷言：label 不可以等於 enum 的名字
    //
    // 為什麼：StatusLabelResolver 的實作通常是
    //     messageSource.getMessage(key, null, status.name(), locale)
    //                                          ↑ 找不到時的預設值
    // 所以「忘記加 label」的症狀是「label 剛好等於 enum 名字」——
    // 那不會拋例外，前端會看到 "PARTIALLY_SHIPPED" 而不是「部分出貨」。
    assertThat(label)
            .as("""
                %s 沒有正體中文的顯示文字，resolver 退回了 enum 的名字。

                請在 messages_zh_TW.properties 加上：
                  orderStatus.%s=（例如「部分出貨」）
                ★ 注意是 messages_*.properties（顯示文字）而不是
                  error-messages_*.properties（錯誤訊息）——
                  06 章 6.5.8 用的是 OrderStatus.labelKey()，
                  它回傳 "orderStatus." + name()。

                ⚠️ 這是 06 章 6.5.8 的核心 ——
                   statusLabel 是「新增 enum 值不再是破壞性變更」的關鍵，
                   而它只在「每個值都有 label」時成立。
                """, status, status.name())
            .isNotEqualTo(status.name());

    // ★ 而且不可以是英文（正體中文的 locale）
    assertThat(label)
            .as("%s 的顯示文字 '%s' 看起來是英文", status, label)
            .matches(".*[\\u4e00-\\u9fff].*");      // 至少含一個漢字
}
```

**同樣的模式適用於所有「值會增加」的 enum**：

```java
@ParameterizedTest @EnumSource(OrderStatus.class)      void 訂單狀態(OrderStatus s) {}
@ParameterizedTest @EnumSource(ExportStatus.class)     void 匯出狀態(ExportStatus s) {}
@ParameterizedTest @EnumSource(InvoiceType.class)      void 發票類型(InvoiceType t) {}
@ParameterizedTest @EnumSource(ErrorCode.Retry.class)  void 重試策略(Retry r) {}
@ParameterizedTest @EnumSource(ActorType.class)        void 角色(ActorType t) {}
@ParameterizedTest @EnumSource(ReceiptScanStatus.class) void 收據掃描狀態(...) {}
```

**shop-service 把它抽成一個共用的測試**：

```java
package example.shop.contract;

/**
 * 「每一個對外可見的 enum，每一個值都有顯示文字」。
 *
 * <p>★ 為什麼要一個「所有 enum」的測試而不是每個 enum 一個：
 *    因為新增一個 **enum 型別** 時（不只是新增值），
 *    這個測試會自動涵蓋它 ——
 *    而「每個 enum 一個測試」需要有人記得去新增測試類別。
 */
@SpringBootTest        // ★ 需要真的 MessageSource；不需要 MVC
class AllExposedEnumsHaveLabelsTest {

    @Autowired StatusLabelResolver resolver;

    /**
     * 掃描所有「出現在 DTO 欄位上」的 enum 型別。
     *
     * <p>★ 用「出現在 DTO 上」當判準，而不是「在某個 package 裡」——
     *    因為前者才是「對外可見」的真正定義。
     */
    static Stream<Arguments> allExposedEnumValues() {
        return DtoScanner.scan("example.shop")
                .stream()
                .flatMap(dto -> Arrays.stream(dto.getRecordComponents()))
                .map(java.lang.reflect.RecordComponent::getType)
                .filter(Class::isEnum)
                .distinct()
                .flatMap(enumType -> Arrays.stream(enumType.getEnumConstants()))
                .map(constant -> Arguments.of(
                        constant.getClass().getSimpleName(), constant));
    }

    @ParameterizedTest(name = "{0}.{1}")
    @MethodSource("allExposedEnumValues")
    void 每個對外的enum值都有顯示文字(String typeName, Enum<?> value) {
        LocaleContextHolder.setLocale(Locale.TAIWAN);
        String label = resolver.label(value);
        assertThat(label)
                .as("%s.%s 沒有顯示文字（key：%s）",
                    typeName, value.name(), LabeledEnum.labelKeyOf(value))
                .isNotBlank()
                .isNotEqualTo(value.name());
    }
}
```

> ### ⚠️ 這個測試逼出了 06 章的一個 API 缺口 ★★
>
> 06 章 6.5.8 的 `StatusLabelResolver` 第一版只有一個方法：
>
> ```java
> public String label(OrderStatus status) { ... }   // ★ 只吃 OrderStatus
> ```
>
> **而「所有對外的 enum」需要一個泛型的入口** —— `resolver.label(value)`
> 對 `Enum<?>` 是編譯不過的。
>
> **修法（已套用在 06 章 6.5.8）**：一個 `LabeledEnum` 介面
> （`labelKey()` + `static labelKeyOf(Enum<?>)`）+ 一個
> `label(Enum<?>)` 的泛型入口。
>
> ★ **「測試需要一個泛型 API」不是測試的問題，而是設計的訊號**：
> 06 章 6.5.8 的結論是「**每一個**對外的 enum 都要有 statusLabel」，
> 而一個只吃 `OrderStatus` 的 resolver **沒有辦法表達那個結論**。
> 👉 **測試逼出了一個真正的缺口。**（與練習 4 的 `countFor` 是同一件事。）

⚠️ **`.distinct()` 那一行很重要** ——
同一個 enum 出現在 12 個 DTO 上，不需要測 12 次。

### 7.8.4 `@TestFactory`：測試數量由資料決定

**`@ParameterizedTest` 與 `@TestFactory` 的差別**：

| | `@ParameterizedTest` | `@TestFactory` |
|---|---|---|
| 每個案例是一個 | 「invocation」 | **真正的動態測試** |
| 可以巢狀嗎 | 不行 | ✅ `DynamicContainer` |
| 名字 | 由 `name` 樣板產生 | 你自己給每一個 |
| 適合 | 同一個測試邏輯、不同資料 | **結構本身由資料決定** |

**shop-service 的一個好用途：授權矩陣的巢狀呈現。**

```java
/**
 * 授權矩陣的動態測試 —— 用 DynamicContainer 讓報表可讀。
 *
 * <p>輸出的結構：
 * <pre>
 * 授權矩陣
 *  ├─ POST /orders
 *  │   ├─ ANONYMOUS → 401 ✅
 *  │   ├─ CUSTOMER  → 201 ✅
 *  │   ├─ SUPPORT   → 403 ✅
 *  │   ├─ WAREHOUSE → 403 ✅
 *  │   └─ ADMIN     → 201 ✅
 *  ├─ GET /orders/{orderId}
 *  │   ├─ ANONYMOUS → 401 ✅
 *  ...
 * </pre>
 *
 * <p>★ 為什麼這個結構有價值：CI 的測試報表會照這個結構呈現，
 *    於是「哪一個端點的哪一個角色壞了」一眼就看得到。
 *    用 @ParameterizedTest 的話是 350 筆平坦的清單。
 */
@TestFactory
Stream<DynamicNode> 授權矩陣() {
    return AuthzMatrix.load().endpoints().stream()
            .map(endpoint -> DynamicContainer.dynamicContainer(
                    endpoint.method() + " " + endpoint.uriTemplate(),
                    endpoint.expectations().entrySet().stream()
                            .map(e -> DynamicTest.dynamicTest(
                                    "%s → %d".formatted(e.getKey(), e.getValue()),
                                    () -> assertAuthz(endpoint, e.getKey(), e.getValue())))
            ));
}
```

⚠️ **`@TestFactory` 的兩個代價**：
- **不能用 `@MockitoBean` 的 per-test 重設** ——
  一個 `@TestFactory` 方法在 Spring 眼中是**一個**測試方法，
  所以裡面的 350 個動態測試共用同一份 mock 狀態。
- IDE 對它的支援比 `@ParameterizedTest` 差（不能單獨重跑一個案例）。

**所以 shop-service 的授權矩陣用 `@ParameterizedTest`**（7.9.3），
`@TestFactory` 只用在「不需要 mock」的純資料檢查上。

### 7.8.5 失敗訊息的可讀性

**參數化測試最常見的抱怨：「350 個案例，我不知道是哪一個失敗」。**

**三個層次的解法。**

**層次一：`@ParameterizedTest(name = ...)`。**

```java
// 🔴 預設名字：[1], [2], [3]...
@ParameterizedTest
@MethodSource("cases")
void 測試(Case c) { }

// ✅ 有意義的名字
@ParameterizedTest(name = "[{index}] {0}")
@MethodSource("cases")
void 測試(Case c) { }
// → [1] 完全不是 JSON
// → [2] 空字串

// ✅★ 多參數的完整樣板
@ParameterizedTest(name = "{0} {1} 以 {2} 身分 → 期望 {3}")
@MethodSource("authzCases")
void 授權(String method, String uri, ActorType role, int expected) { }
// → GET /orders/{orderId} 以 SUPPORT 身分 → 期望 200
```

⚠️ **`{0}` 用的是參數的 `toString()`。**
所以 `record Case(...)` 的自動 `toString()` 會印出所有欄位 ——
**對長的 body 來說那很吵**。

**解法：覆寫 `toString()`。**

```java
public record Case(String name, String body, int expectedStatus, String expectedCode) {
    /** ★ 讓 @ParameterizedTest 的名字只印 name，不印整個 body。 */
    @Override
    public String toString() {
        return name;
    }
}
```

**層次二：`as()` 訊息裡放診斷資訊。**

```java
assertThat(actual)
        .as("""
            %s %s 以 %s 身分存取，期望 %d 但得到 %d。

            回應內容：
            %s

            檢查清單：
              1. SecurityConfig 有這條規則嗎？
              2. 規則的順序對嗎？（Spring Security 的規則是「先中先贏」）
              3. 這個角色的權限名稱對嗎？（ROLE_ 前綴）
            """, method, uri, role, expected, actual, body)
        .isEqualTo(expected);
```

**層次三（★ 最有價值）：失敗時輸出「一整張表」。**

```java
/**
 * ★★ 對「矩陣型」的測試，逐一失敗的資訊價值有限 ——
 *    你真正想知道的是「哪一片區域壞了」。
 *
 * <p>做法：用一個 @Test（不是 @ParameterizedTest）跑完整張表，
 *    收集所有不符，最後一次印出來。
 *
 * <p>取捨：
 *   ✅ 一次看到全貌，能看出「所有 SUPPORT 的規則都壞了」這種模式
 *   🔴 只會有一個測試（一紅一綠），CI 的報表沒有 350 筆
 *
 * <p>shop-service 的做法：**兩個都留** ——
 *   @ParameterizedTest 給 CI 的報表，這一個給人看。
 */
@Test
void 授權矩陣的全貌() {
    var failures = new ArrayList<String>();
    var table = new StringBuilder();

    // ★ 跳過刻意不納入矩陣的 ActorType（例如 SYSTEM，見 AuthzMatrix）
    var roles = Arrays.stream(ActorType.values())
            .filter(t -> !AuthzMatrix.EXCLUDED_ACTOR_TYPES.contains(t))
            .toList();

    table.append("%-8s %-38s".formatted("METHOD", "URI"));
    for (ActorType role : roles) {
        table.append(" %-10s".formatted(role.name().substring(0, Math.min(9, role.name().length()))));
    }
    table.append("\n");

    for (var endpoint : AuthzMatrix.load().endpoints()) {
        table.append("%-8s %-38s".formatted(endpoint.method(), endpoint.uriTemplate()));
        for (ActorType role : roles) {
            int expected = endpoint.expectationFor(role);
            int actual   = perform(endpoint, role);
            boolean ok   = expected == actual;
            table.append(" %-10s".formatted(
                    ok ? String.valueOf(actual) : expected + "/" + actual + " X"));
            if (!ok) {
                failures.add("%s %s [%s] 期望 %d 得到 %d"
                        .formatted(endpoint.method(), endpoint.uriTemplate(),
                                   role, expected, actual));
            }
        }
        table.append("\n");
    }

    assertThat(failures)
            .as("""
                授權矩陣有 %d 個不符。

                完整的矩陣（「期望/實際 X」= 不符）：
                %s
                """, failures.size(), table)
            .isEmpty();
}
```

**失敗時的輸出**：

```
授權矩陣有 5 個不符。

完整的矩陣（「期望/實際 X」= 不符）：
METHOD   URI                                    ANONYMOUS  CUSTOMER   SUPPORT    WAREHOUSE  ADMIN
POST     /orders                                401        201        403        403        201
GET      /orders                                401        200        200        403        200
GET      /orders/{orderId}                      401        200        200        200        200
PATCH    /orders/{orderId}                      401        200        403/200 X  403        200
DELETE   /orders/{orderId}                      401        403/200 X  403/200 X  403        204
GET      /orders/{orderId}/receipts             401        200        200        403/200 X  200
POST     /orders/{orderId}/refunds              401        403        403/200 X  403        200
```

**一眼看出模式：SUPPORT 拿到了太多權限。**
那通常是 `SecurityConfig` 裡某一條 `hasAnyRole("SUPPORT", ...)` 放太寬。

> **「一次印出全貌」對矩陣型的測試比「逐一失敗」有用得多 ——
> 因為它讓你看到的是「模式」而不是「症狀」。**

---

## 7.9 授權矩陣測試 ★★

### 7.9.1 為什麼這是最值得寫的一組測試

**三個理由。**

**理由一：它是最常見的 API 漏洞。**

OWASP API Security Top 10（2023）的第一名與第五名：

```
API1:2023  Broken Object Level Authorization      ← 7.2.1 的事故
API5:2023  Broken Function Level Authorization    ← 「客戶能呼叫客服的端點」
```

**兩個都是授權問題。**

**理由二：它的失敗是靜默的。**

| bug 類型 | 怎麼發現 |
|---|---|
| 路由寫錯 | 404，立刻發現 |
| JSON 欄位名寫錯 | 前端壞掉，立刻發現 |
| 金額算錯 | 對帳發現（幾天） |
| **授權漏了** | **可能永遠不會發現，直到有人利用它** |

**理由三：它的組合數大到「手寫測試」不可行，但參數化之後很便宜。**

```
shop-service：70 個端點 × 5 種角色 = 350 個組合

手寫：350 個測試方法 → 沒有人會做
參數化：1 個測試方法 + 1 個 CSV → 350 個案例，約 8 秒
```

**而且新增一個端點時**，7.9.4 的守門測試會強迫你在矩陣裡加一列 ——
**「忘記加授權」變成不可能**。

### 7.9.2 端點清單的自動取得

**第一步：從 Spring 拿到所有端點。**

```java
package example.shop.test.authz;

import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.mvc.method.RequestMappingInfo;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;

import java.util.Comparator;
import java.util.List;
import java.util.Set;
import java.util.stream.Stream;

/**
 * 從 Spring 的 RequestMappingHandlerMapping 取得所有端點。
 *
 * <p>★★ 為什麼不手寫清單：手寫的清單會過期，
 *    而「過期」的方向永遠是「少了新端點」——
 *    也就是「新端點沒有被授權測試涵蓋」。
 */
public final class EndpointInventory {

    private EndpointInventory() {}

    /** 一個端點 = 一個 (HTTP 方法, URI 樣板) 的組合。 */
    public record Endpoint(String method, String uriTemplate,
                           String handlerClass, String handlerMethod) {

        public String key() { return method + " " + uriTemplate; }

        @Override public String toString() { return key(); }
    }

    /** 這些路徑不需要授權測試。 */
    private static final Set<String> EXCLUDED_PREFIXES = Set.of(
            "/actuator",        // 由 management.endpoints 另外保護（08 章）
            "/error",           // 03 章 3.10.3 的 ApiErrorController
            "/v3/api-docs",     // springdoc
            "/swagger-ui"
    );

    public static List<Endpoint> from(RequestMappingHandlerMapping mapping) {
        return mapping.getHandlerMethods().entrySet().stream()
                .flatMap(e -> expand(e.getKey(), e.getValue()))
                .filter(ep -> EXCLUDED_PREFIXES.stream()
                        .noneMatch(p -> ep.uriTemplate().startsWith(p)))
                .sorted(Comparator.comparing(Endpoint::uriTemplate)
                        .thenComparing(Endpoint::method))
                .distinct()
                .toList();
    }

    /**
     * 一個 @RequestMapping 可能對應多個 (method, path) 組合。
     *
     * <p>⚠️ 三個要處理的情況：
     * <ul>
     *   <li>{@code @RequestMapping(path = {"/a", "/b"})} → 兩個路徑</li>
     *   <li>沒寫 method（等於所有 method）→ 展開成常見的六個</li>
     *   <li>Boot 3 用 PathPatternParser，所以取 pattern 要用
     *       {@code getPathPatternsCondition()}，不是舊的
     *       {@code getPatternsCondition()}（01 章 1.3.5）</li>
     * </ul>
     */
    private static Stream<Endpoint> expand(RequestMappingInfo info, HandlerMethod handler) {
        // ★ Boot 3 的預設是 PathPatternParser
        var patternsCondition = info.getPathPatternsCondition();
        Set<String> paths = patternsCondition == null
                ? Set.of()
                : patternsCondition.getPatternValues();

        Set<org.springframework.web.bind.annotation.RequestMethod> methods =
                info.getMethodsCondition().getMethods();

        var effectiveMethods = methods.isEmpty()
                // ⚠️ 沒宣告 method 的 mapping —— 這本身就是一個問題
                //    （01 章 1.3.1：一律用 @GetMapping 等 shortcut，不要用裸的 @RequestMapping）
                ? Set.of(org.springframework.web.bind.annotation.RequestMethod.GET,
                         org.springframework.web.bind.annotation.RequestMethod.POST,
                         org.springframework.web.bind.annotation.RequestMethod.PUT,
                         org.springframework.web.bind.annotation.RequestMethod.PATCH,
                         org.springframework.web.bind.annotation.RequestMethod.DELETE)
                : methods;

        return paths.stream().flatMap(path ->
                effectiveMethods.stream().map(m -> new Endpoint(
                        m.name(), path,
                        handler.getBeanType().getName(),
                        handler.getMethod().getName())));
    }
}
```

**第二步：把清單印出來當作起點。**

```java
/**
 * 產生授權矩陣的初始 CSV —— 一個「一次性」的工具測試。
 *
 * <p>★ 用法：跑它一次，把輸出貼進
 *    src/test/resources/authz-matrix.csv，然後**逐列填上期望值**。
 *
 * <p>⚠️ 預設值刻意全部填 403（最保守）——
 *    這樣「忘記想清楚的那一列」會是紅燈，而不是靜默放行。
 *    ★ 這個「預設值的方向」是整個機制的安全性基礎。
 */
@Test
@Tag("generate-examples")
void 產生授權矩陣的骨架() {
    var endpoints = EndpointInventory.from(handlerMapping);

    System.out.println("method,uri,anonymous,customer,support,warehouse,admin,note");
    for (var ep : endpoints) {
        System.out.printf("%s,%s,401,403,403,403,403,TODO %s.%s%n",
                ep.method(), ep.uriTemplate(),
                ep.handlerClass().substring(ep.handlerClass().lastIndexOf('.') + 1),
                ep.handlerMethod());
    }
    System.out.printf("%n共 %d 個端點 × 5 種角色 = %d 個組合%n",
            endpoints.size(), endpoints.size() * 5);
}
```

### 7.9.3 一張表覆蓋 70 × 5

**`src/test/resources/authz-matrix.csv`**（節錄）：

```csv
method,uri,anonymous,customer,support,warehouse,admin,note
# ─── 訂單（客戶自己的）────────────────────────────────────────────
POST,/orders,401,201,403,403,201,客服不可代客下單（要走另一個端點）
GET,/orders,401,200,200,403,200,客服看得到列表（但只有自己負責的客戶 → 資源層級）
GET,/orders/{orderId},401,200,200,200,200,倉庫要看出貨資訊
PATCH,/orders/{orderId},401,200,403,403,200,只有客戶能改備註
DELETE,/orders/{orderId},401,403,403,403,204,★ 訂單不可刪除，只有 admin 能軟刪
POST,/orders/{orderId}/cancellations,401,201,201,403,201,客服可代客取消
# ─── 訂單項目 ─────────────────────────────────────────────────
POST,/orders/{orderId}/items,401,201,403,403,201,
PATCH,/orders/{orderId}/items/{itemId},401,200,403,403,200,
DELETE,/orders/{orderId}/items/{itemId},401,204,403,403,204,
# ─── 地址（00 章的情境：客服代客修改）──────────────────────────
PATCH,/orders/{orderId}/shipping-address,401,403,200,403,200,★ 只有客服能改（00 章 0.14）
# ─── 付款 ─────────────────────────────────────────────────────
POST,/orders/{orderId}/payments,401,201,403,403,201,
POST,/orders/{orderId}/refunds,401,403,403,403,201,★ 只有 admin 能退款
# ─── 收據與匯出 ───────────────────────────────────────────────
GET,/orders/{orderId}/receipts/{receiptId},401,200,200,403,200,
POST,/orders/{orderId}/receipts,401,201,201,403,201,
GET,/orders.csv,401,403,200,403,200,★ 客戶不可批次匯出（資料外洩風險）
POST,/orders/exports,401,403,202,403,202,
GET,/orders/exports/{exportId},401,403,200,403,200,
GET,/orders/exports/{exportId}/download,401,403,200,403,200,
# ─── SSE ──────────────────────────────────────────────────────
GET,/orders/{orderId}/events,401,200,200,200,200,
# ─── 商品（公開讀、管理寫）────────────────────────────────────
GET,/products,200,200,200,200,200,★ 公開（06 章 6.3.7 的 Allow-Origin: *）
GET,/products/{productId},200,200,200,200,200,★ 公開
POST,/products,401,403,403,403,201,
PATCH,/products/{productId},401,403,403,403,200,
POST,/products/{productId}/images,401,403,403,403,201,
DELETE,/products/{productId}/images/{imageId},401,403,403,403,204,
PATCH,/products/{productId}/price,401,403,403,403,200,★ 只有 admin 能改價
# ─── 購物車（只有自己的）──────────────────────────────────────
GET,/cart,401,200,403,403,403,★ 連 admin 都不該看別人的購物車
POST,/cart/items,401,201,403,403,403,
DELETE,/cart/items/{itemId},401,204,403,403,403,
POST,/cart/coupons,401,201,403,403,403,
# ─── 倉庫 ─────────────────────────────────────────────────────
POST,/orders/{orderId}/shipments,401,403,403,201,201,★ 只有倉庫能出貨
PATCH,/shipments/{shipmentId},401,403,403,200,200,
# ─── webhook（★ 特例）─────────────────────────────────────────
POST,/webhooks/shipping,200,200,200,200,200,★ 用簽章驗證不是角色（06 章 6.5.8）
POST,/webhooks/payment,200,200,200,200,200,★ 同上
```

⚠️ **`note` 那一欄不是裝飾。**
它記錄「**為什麼**是這個值」——
而那是這張表最容易腐化的部分。
一年後有人問「為什麼客服不能下單」，答案在這裡。

**消費它**：

```java
package example.shop.security;

import example.shop.order.domain.Actor;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvFileSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpMethod;
import org.springframework.test.web.servlet.MockMvc;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 授權矩陣測試。
 *
 * <p>★★ 為什麼是 @SpringBootTest 而不是 @WebMvcTest：見 7.9.6。
 *
 * <p>★ 為什麼不 mock 掉所有 Service：
 *    因為這個測試要區分 403 與 200 ——
 *    而 200 的路徑必須真的能走完（不然會是 500）。
 *    所以 Service 要 mock，但要 stub 成「什麼都成功」。
 *
 * <p>⚠️ 這個測試**不驗證業務邏輯**，只驗證「有沒有被授權擋下」。
 *    所以所有 mock 一律回傳成功 —— 那是刻意的。
 */
@SpringBootTest
@AutoConfigureMockMvc
class AuthorizationMatrixTest {

    @Autowired MockMvc mockMvc;

    /** ★ 所有 Service 都 mock 並 stub 成「成功」—— 見上方說明。 */
    @Autowired AllServicesStubbedToSucceed stubs;

    @ParameterizedTest(name = "{2} {0} {1} → {3}")
    @CsvFileSource(resources = "/authz-matrix.csv", numLinesToSkip = 1)
    void 授權矩陣(String method, String uri,
                  int anonymous, int customer, int support, int warehouse, int admin,
                  String note) throws Exception {

        check(method, uri, null,                   anonymous, note);
        check(method, uri, Actors.客戶(),           customer,  note);
        check(method, uri, Actors.客服(),           support,   note);
        check(method, uri, Actors.倉管(),           warehouse, note);
        check(method, uri, Actors.管理員(),         admin,     note);
    }

    private void check(String method, String uriTemplate, Actor actor,
                       int expected, String note) throws Exception {
        // ★ 把 {orderId} 之類的樣板換成固定的測試 ID
        String uri = UriTemplates.fill(uriTemplate);

        var request = org.springframework.test.web.servlet.request
                .MockMvcRequestBuilders.request(HttpMethod.valueOf(method), uri);

        // ★ 寫入類的方法要給一個合法的 body 與 Idempotency-Key，
        //   否則會被 400/422 擋在授權之後 —— 那讓測試無法區分 403 與 422
        if (Methods.isWrite(method)) {
            request.contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                   .characterEncoding(java.nio.charset.StandardCharsets.UTF_8)
                   .content(ValidBodies.forEndpoint(method, uriTemplate))
                   .header("Idempotency-Key",
                           "idem-authz-" + (method + uriTemplate).hashCode());
        }
        if ("PATCH".equals(method) || "PUT".equals(method)) {
            request.header("If-Match", "\"v1\"");     // 06 章 6.8.3
        }
        if (actor != null) {
            request.with(Auth.as(actor));             // ★ 見下方
        }

        var result = mockMvc.perform(request).andReturn();

        assertThat(result.getResponse().getStatus())
                .as("""
                    %s %s 以 %s 身分存取，期望 %d 但得到 %d。

                    矩陣的說明：%s

                    回應內容：
                    %s

                    檢查清單：
                      1. SecurityConfig 有涵蓋這個路徑嗎？
                      2. 規則的順序對嗎？（Spring Security 是「先中先贏」）
                      3. 期望值是不是該改？（如果是，同時更新 authz-matrix.csv 的 note）
                      4. ⚠️ 如果得到 422/400，代表請求被驗證擋在授權之後 ——
                         去修 ValidBodies.forEndpoint，不要改期望值
                    """,
                    method, uri, actor == null ? "ANONYMOUS" : actor.type(),
                    expected, result.getResponse().getStatus(),
                    note == null ? "（無）" : note,
                    result.getResponse().getContentAsString(
                            java.nio.charset.StandardCharsets.UTF_8))
                .isEqualTo(expected);
    }
}
```

**兩個支援類別**：

```java
package example.shop.test.authz;

/**
 * 把 URI 樣板填成具體的路徑。
 *
 * <p>★ 用固定的 ID，讓 mock 的 stub 可以對得上。
 */
public final class UriTemplates {

    private UriTemplates() {}

    private static final java.util.Map<String, String> VALUES =
            java.util.Map.ofEntries(
                    java.util.Map.entry("{orderId}",    "ord_01J5GKAUTHZ01"),
                    java.util.Map.entry("{itemId}",     "itm_01J5GKAUTHZ01"),
                    java.util.Map.entry("{productId}",  "P-1001"),
                    java.util.Map.entry("{imageId}",    "img_01J5GKAUTHZ01"),
                    java.util.Map.entry("{receiptId}",  "rcp_01J5GKAUTHZ01"),
                    java.util.Map.entry("{exportId}",   "exp_01J5GKAUTHZ01"),
                    java.util.Map.entry("{shipmentId}", "shp_01J5GKAUTHZ01"),
                    java.util.Map.entry("{paymentId}",  "pay_01J5GKAUTHZ01"),
                    java.util.Map.entry("{couponId}",   "cpn_01J5GKAUTHZ01"));

    public static String fill(String template) {
        String result = template;
        for (var e : VALUES.entrySet()) {
            result = result.replace(e.getKey(), e.getValue());
        }
        // ★★ 守門：如果還有沒填的樣板，立刻失敗
        //    否則那個端點會 404，而 404 不等於 403 —— 測試會給出誤導的結果
        if (result.contains("{")) {
            throw new IllegalStateException("""
                    URI 樣板 '%s' 有未填的變數：'%s'

                    請在 UriTemplates.VALUES 加上它。
                    ⚠️ 不加的話那個端點會回 404，
                       而 404 會被誤讀成「授權有生效」。
                    """.formatted(template, result));
        }
        return result;
    }
}
```

```java
package example.shop.test.authz;

import example.shop.order.domain.Actor;
import example.shop.security.CurrentUser;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

import java.util.Set;

import static org.springframework.security.test.web.servlet.request
        .SecurityMockMvcRequestPostProcessors.user;

/**
 * 以某個 Actor 的身分發請求。
 *
 * <p>★★ 關鍵：principal 必須是 {@link CurrentUser}，不是 String ——
 *    否則 {@code CurrentActorArgumentResolver}（04 章 4.10.2）
 *    會拋 {@code IllegalStateException} → 500，
 *    而那會被誤讀成「授權沒生效」（7.4.3 事實四）。
 *
 * <p>★ 用 {@code SecurityMockMvcRequestPostProcessors.user(UserDetails)}
 *    而不是自己 {@code SecurityContextHolder.setContext()}：
 *    前者由 {@code TestSecurityContextHolderPostProcessor} 在請求結束時
 *    自動清理，後者要自己寫 {@code @AfterEach}——
 *    而忘了寫的症狀是「單獨跑會過、一起跑會壞」（7.13.4）。
 */
public final class Auth {

    private Auth() {}

    public static RequestPostProcessor as(Actor actor) {
        var principal = new CurrentUser(
                actor.id(),
                actor.displayName(),
                actor.type(),
                // ★★ 裸的角色名 —— CurrentUser.getAuthorities() 會自己加 ROLE_ 前綴。
                //    傳 "ROLE_CUSTOMER" 會變成 ROLE_ROLE_CUSTOMER → 全部 403。
                //    ⚠️ 這一行與 7.4.3 的 WithActor.Factory 必須一致 ——
                //       兩個 helper 對同一個 actor 產生不同權限是一個很難查的 bug。
                Set.of(actor.type().name()),
                Set.of(),
                "tok_test_" + actor.id());

        // ★ user(UserDetails) 會用 principal 自己的 getAuthorities()
        return user(principal);
    }

    /** 匿名 —— 明確表達「刻意不帶身分」，比「什麼都不加」清楚。 */
    public static RequestPostProcessor anonymous() {
        return org.springframework.security.test.web.servlet.request
                .SecurityMockMvcRequestPostProcessors.anonymous();
    }
}
```

⚠️ **`Auth.anonymous()` 比「什麼都不加」好**，理由是
`@WithActor` 可能標在**類別**上（7.4.3）——
那時候「什麼都不加」的方法仍然有身分。
**明確的 `anonymous()` 才能覆蓋掉類別層級的設定。**

**不需要 `@AfterEach` 清理。** `spring-security-test` 的
`WithSecurityContextTestExecutionListener` 與
`TestSecurityContextHolderPostProcessor` 會處理 ——
這正是「用框架提供的機制而不是自己 set」的價值。


### 7.9.4 「新端點忘記加授權」的守門測試

**授權矩陣的最大弱點：它是一份「手寫的清單」。**
新增一個端點時，沒有任何機制強迫你去加一列。

**解法：一個「清單必須完整」的測試。**

```java
package example.shop.security;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;

import java.util.Set;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * ★★ 這是整套授權測試的**守門人**。
 *
 * <p>它比 350 個授權斷言更重要 ——
 * 因為它保證「那 350 個斷言涵蓋了所有端點」。
 *
 * <p>沒有它的話，7.9.3 的測試會永遠是綠的，
 * 而新增的端點永遠不在裡面。
 */
@SpringBootTest
class AuthzMatrixCompletenessTest {

    @Autowired RequestMappingHandlerMapping handlerMapping;

    @Test
    void 每個端點都在授權矩陣裡() {
        Set<String> actual = EndpointInventory.from(handlerMapping).stream()
                .map(EndpointInventory.Endpoint::key)
                .collect(Collectors.toCollection(java.util.TreeSet::new));

        Set<String> documented = AuthzMatrix.load().keys();

        Set<String> missing = new java.util.TreeSet<>(actual);
        missing.removeAll(documented);

        assertThat(missing)
                .as("""
                    這些端點不在 authz-matrix.csv 裡：

                    %s

                    ★ 這代表它們的授權**完全沒有被測試**。

                    請在 src/test/resources/authz-matrix.csv 加上對應的列。
                    格式：method,uri,anonymous,customer,support,warehouse,admin,note

                    ⚠️ 每一個角色都要想清楚，不要複製上一列。
                       特別是：
                         · 這個端點會回傳別人的資料嗎？（→ 7.9.5 的資源層級授權）
                         · 匿名可以嗎？（公開商品可以，其他一律 401）
                         · 客服需要嗎？（客服的權限是最容易給太寬的）

                    ⚠️ note 欄位一定要填 —— 一年後你會需要它。
                    """, missing.stream().collect(Collectors.joining("\n  ", "  ", "")))
                .isEmpty();
    }

    @Test
    void 授權矩陣裡沒有已刪除的端點() {
        Set<String> actual = EndpointInventory.from(handlerMapping).stream()
                .map(EndpointInventory.Endpoint::key)
                .collect(Collectors.toSet());

        Set<String> stale = AuthzMatrix.load().keys().stream()
                .filter(k -> !actual.contains(k))
                .collect(Collectors.toCollection(java.util.TreeSet::new));

        assertThat(stale)
                .as("""
                    authz-matrix.csv 裡有已經不存在的端點：%s

                    ⚠️ 這不只是清理問題 —— 那些列對應的測試案例
                       會因為 404 而「通過」（404 != 期望的 200，所以會失敗；
                       但如果期望值是 401/403，404 也不等於它們 → 會失敗）。
                       總之：不一致的清單會產生令人困惑的失敗。
                    """, stale)
                .isEmpty();
    }

    /**
     * ★★ 「每一個 {@code ActorType} 都被涵蓋，或被明確排除」。
     *
     * <p>沒有這個測試的話，新增一個 {@code ActorType}
     * （例如未來的 {@code PARTNER}）不會有任何提醒 ——
     * 而那個角色的權限<b>完全沒有被測試</b>。
     *
     * <p>★ 它與 {@code 每個端點都在授權矩陣裡()} 是同一個精神，
     * 只是換一個維度：那個守「端點」，這個守「角色」。
     */
    @Test
    void 每個ActorType都被涵蓋或明確排除() {
        var covered = AuthzMatrix.load().roleColumns().stream()
                .map(c -> Actor.ActorType.valueOf(c.toUpperCase(Locale.ROOT)))
                .collect(Collectors.toSet());

        var uncovered = Arrays.stream(Actor.ActorType.values())
                .filter(t -> !covered.contains(t))
                .filter(t -> !AuthzMatrix.EXCLUDED_ACTOR_TYPES.contains(t))
                .toList();

        assertThat(uncovered)
                .as("""
                    這些 ActorType 既不在 authz-matrix.csv 的欄位裡，
                    也不在 AuthzMatrix.EXCLUDED_ACTOR_TYPES 裡：%s

                    ★ 這代表那個角色的授權【完全沒有被測試】。

                    兩個選擇：
                      1. 在 authz-matrix.csv 加一欄，並為【每一個端點】填上期望值
                         （70 列 —— 但那正是「新增一種角色」該付的代價）
                      2. 加進 EXCLUDED_ACTOR_TYPES，並在 PR 說明
                         「為什麼這個角色不需要授權矩陣」
                    """, uncovered)
                .isEmpty();
    }

    @Test
    void 沒有端點對匿名開放_除了明確的白名單() {
        var publicEndpoints = AuthzMatrix.load().endpoints().stream()
                .filter(e -> e.expectationFor(null) < 400)      // 匿名可以存取
                .map(e -> e.method() + " " + e.uriTemplate())
                .collect(Collectors.toCollection(java.util.TreeSet::new));

        assertThat(publicEndpoints)
                .as("""
                    這些端點對匿名使用者開放：%s

                    ★ 請確認每一個都是刻意的。
                    shop-service 刻意公開的只有：
                      · GET /products、GET /products/{id}   —— 商品目錄
                      · POST /webhooks/*                    —— 用簽章驗證（不是角色）
                      · GET /actuator/health                —— 已排除在清單外

                    如果多了別的，那可能是一個資料洩漏。
                    """)
                .containsExactlyInAnyOrder(
                        "GET /products",
                        "GET /products/{productId}",
                        "POST /webhooks/shipping",
                        "POST /webhooks/payment");
    }
}
```

⚠️ **第三個測試（`沒有端點對匿名開放`）用 `containsExactlyInAnyOrder`
而不是 `isEmpty`** ——
它不是「不可以有公開端點」，而是「**公開端點的清單必須是這幾個**」。
**新增一個公開端點會紅燈，而那正是我們想要的**：
「把一個端點開放給匿名」應該是一個需要明確決定的動作。

### 7.9.5 資源層級的授權：矩陣涵蓋不到的那一半

**7.9.3 的矩陣回答的是**：
「**CUSTOMER 這個角色**可以呼叫 `GET /orders/{orderId}` 嗎？」→ 可以。

**它沒有回答**：
「**客戶 A** 可以看 **客戶 B 的**訂單嗎？」→ 🔴 **這就是 7.2.1 的事故。**

**兩者的差別**：

| | 功能層級（Function Level） | 資源層級（Object Level） |
|---|---|---|
| 問題 | 這個**角色**能呼叫這個**端點**嗎 | 這個**人**能存取這個**資源**嗎 |
| OWASP | API5:2023 | **API1:2023**（第一名） |
| 由誰判斷 | `SecurityConfig` 的規則 | **Service 層**（要查資料庫） |
| 測試 | 7.9.3 的矩陣 | **必須另外做** |

**為什麼資源層級不能用矩陣涵蓋**：
矩陣的每一列是 `(method, uri, role)`，
而資源層級需要 `(method, uri, actor, resource_owner)` ——
**多了一個維度，而且需要真的資料**。

**shop-service 的做法：一個獨立的 IDOR 測試套件。**

```java
package example.shop.security;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * IDOR（Insecure Direct Object Reference）測試。
 *
 * <p>★★ 這一組測試與授權矩陣的分工：
 * <ul>
 *   <li>矩陣：「CUSTOMER 能呼叫這個端點嗎」</li>
 *   <li>這裡：「客戶 A 能存取客戶 B 的東西嗎」</li>
 * </ul>
 *
 * <p>⚠️ 這一定是 @SpringBootTest + 真的資料 ——
 *    因為判斷發生在 Service 層，而 mock 的 Service 不會做那個判斷。
 *    所以這一組測試需要真的資料庫（Testcontainers，7.11.6）。
 *
 * <p>★ 而 Web 層在這件事上的責任只有一個：
 *    **把 actor 傳下去**（7.6.5 的 ArgumentCaptor 測試守住這件事）。
 *    所以 Web 層測試與這裡的測試合起來才是完整的防護：
 *
 * <pre>
 *   Web 層測試（③）：Controller 有把 actor 傳給 Service     ← 7.6.5
 *   這裡（④）：      Service 拿到 actor 後真的做了判斷      ← 本節
 *   ArchUnit：       Service 的方法簽名一定有 Actor         ← 7.6.4
 * </pre>
 */
@SpringBootTest
@AutoConfigureMockMvc
@Testcontainers
class ObjectLevelAuthorizationTest {

    /** 三個測試資料：兩個客戶，各有一張訂單；第三張是已刪除的。 */
    static final String CUSTOMER_A = "cust_01J5GKIDORAAA";
    static final String CUSTOMER_B = "cust_01J5GKIDORBBB";
    static String orderOfA;
    static String orderOfB;

    /**
     * ★★ 所有「帶資源 ID 的端點」都要跑這個測試。
     *
     * <p>清單從 EndpointInventory 自動產生 ——
     * 判準是「URI 樣板含 {orderId}」。
     */
    static Stream<Arguments> endpointsWithOrderId() {
        return EndpointInventory.from(handlerMapping).stream()
                .filter(e -> e.uriTemplate().contains("{orderId}"))
                .map(Arguments::of);
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("endpointsWithOrderId")
    void 客戶A不可存取客戶B的訂單(EndpointInventory.Endpoint endpoint) throws Exception {
        String uri = endpoint.uriTemplate().replace("{orderId}", orderOfB);
        uri = UriTemplates.fill(uri);

        var result = mockMvc.perform(
                        request(HttpMethod.valueOf(endpoint.method()), uri)
                                .with(user(CUSTOMER_A).roles("CUSTOMER"))
                                .contentType(APPLICATION_JSON)
                                .content(ValidBodies.forEndpoint(
                                        endpoint.method(), endpoint.uriTemplate()))
                                .header("Idempotency-Key", "idem-idor-" + uri.hashCode()))
                .andReturn();

        int status = result.getResponse().getStatus();

        assertThat(status)
                .as("""
                    🔴🔴 IDOR：客戶 A 對「客戶 B 的訂單」發了 %s %s，得到 %d。

                    回應內容：
                    %s

                    期望：403（明確拒絕）或 404（不透露存在）。

                    ★ 兩者的選擇：
                      · 404 更安全（不透露「這個 ID 存在」）
                      · 403 對客服/管理員的除錯更友善
                      shop-service 的決定：對 CUSTOMER 一律 404，
                      對 SUPPORT/ADMIN 用 403（03-rest-api 4.5.3）。

                    ★ 修法的位置：**Service 層**，不是 Controller。
                      Controller 的責任只是把 actor 傳下去（07 章 7.6.5）。
                    """,
                    endpoint.method(), uri, status,
                    result.getResponse().getContentAsString(UTF_8))
                .isIn(403, 404);
    }

    @Test
    void 客服可以存取任何客戶的訂單_但會留下稽核紀錄() throws Exception {
        mockMvc.perform(get("/orders/" + orderOfB)
                        .with(user("supp_01J5GK").roles("SUPPORT")))
                .andExpect(status().isOk());

        // ★★ 這個斷言與授權同等重要：
        //    「客服能看所有訂單」是刻意的設計，
        //    而它的配套控制是「每一次存取都留紀錄」（04 章 4.6 的 AuditFilter）。
        assertThat(auditRepository.findAll())
                .as("""
                    客服存取了別人的訂單，但沒有稽核紀錄。

                    ⚠️ 「客服能看所有資料」這個權限，
                       它的正當性完全建立在「有紀錄可查」上。
                       沒有紀錄的話，那個權限就是一個無法審計的後門。
                    """)
                .anySatisfy(event -> {
                    assertThat(event.actorId()).isEqualTo("supp_01J5GK");
                    assertThat(event.resourceId()).isEqualTo(orderOfB);
                    assertThat(event.action()).isEqualTo("ORDER_VIEW");
                });
    }

    @Test
    void 猜測其他人的訂單ID不可行() throws Exception {
        // ★ 一個「設計層面」的檢查：訂單 ID 不可以是連續的
        //   （如果是 1, 2, 3...，那攻擊者不需要猜）
        assertThat(orderOfA)
                .as("""
                    訂單 ID 看起來是遞增的整數。

                    ⚠️ 這讓 IDOR 從「需要知道 ID」變成「數到就有」——
                       授權漏洞的影響從「洩漏一筆」變成「洩漏全部」。

                    shop-service 用 ULID（01 章 1.4.3）：
                       ord_01J5GKA1B2C3D4E5F6G7H8
                    """)
                .matches("^ord_[0-9A-HJKMNP-TV-Z]{26}$");
    }
}
```

⚠️ **`猜測其他人的訂單ID不可行` 這個測試很特別**：
它測的不是行為，是**設計決定**。
**這類「把設計決定變成測試」的做法，在安全性相關的地方特別有價值** ——
因為那些決定容易在重構時被無意破壞。

### 7.9.6 為什麼授權矩陣必須用 `@SpringBootTest`

**四個理由，每一個都足以否決 `@WebMvcTest`。**

**理由一：`@WebMvcTest` 裡的 `SecurityFilterChain` 可能不是你的**（7.4.3 事實二）。

如果是自動設定的預設 chain，那 350 個斷言測的是「Boot 的預設值」，
**與你的 `SecurityConfig` 完全無關**。

**理由二：filter 的順序在切片裡不保證與正式環境一致。**

06 章 6.3.5 的整節都在講 `CorsFilter` 的 order。
而授權的結果（401 vs 403 vs 200）**受 filter 順序影響**：

```
order -119  IpRateLimitFilter    → 如果它先跑，可能回 429 而不是 401
order -100  springSecurityFilterChain
order  -99  IdempotencyFilter    → 如果它先跑，可能回 400（缺 Idempotency-Key）
```

**在切片裡驗證的順序，不能推論到正式環境。**

**理由三：`@WebMvcTest` 不載入 `@Component`，
而 Security 的規則常常依賴它們。**

```java
@Bean
SecurityFilterChain filterChain(HttpSecurity http,
                                 JwtDecoder jwtDecoder,          // @Component
                                 CustomAuthoritiesMapper mapper) // @Component
```

**理由四（最實際的）：一個 context 跑 350 個案例，比什麼都快。**

```
@SpringBootTest：一次啟動 4.2 s + 350 × 12 ms = 8.4 s
@WebMvcTest：    如果每個 Controller 一個 context，14 個 context × 1.9 s = 26.6 s
```

**⚠️ 唯一的例外：「單一端點的授權」可以在 `@WebMvcTest` 裡測**，
前提是明確 `@Import(SecurityConfig.class)` 並用 7.4.3 的
`SecuritySliceRealityCheckTest` 確認它真的生效了。

> **結論：授權是「整個系統的性質」，不是「某個 Controller 的性質」。
> 所以它的測試層級是 ④。**

---
## 7.10 契約測試

### 7.10.1 三種契約測試，解決三個不同的問題

03-rest-api 第 07 章產出了 `orders-api.yaml`。
**這一節回答：那份 YAML 要怎麼變成一個「會紅燈」的東西？**

| 方式 | 驗證什麼 | 誰受益 | 成本 |
|---|---|---|---|
| **① OpenAPI 驗證** | 實際回應**符合** YAML 的 schema | 客戶端（拿到的資料跟文件一致） | 低（一個 matcher） |
| **② REST Docs** | YAML / 文件**由測試產生** | 文件永不過期 | 中（每個端點要寫 descriptor） |
| **③ 消費者驅動契約（Pact）** | 客戶端**真正用到**的部分沒有壞 | 後端（可以安心改沒人用的欄位） | 高（要跨團隊協作） |

**三者不是替代關係，而是回答不同的問題**：

```
① 「我的回應符合我宣稱的 schema 嗎？」
     → 抓「實作偏離文件」

② 「我的文件描述的是真的實作嗎？」
     → 抓「文件偏離實作」（① 的反向）

③ 「我改的這個欄位，有人在用嗎？」
     → 抓「破壞了某個客戶端」
```

**shop-service 的選擇**：

| 方式 | 採用？ | 理由 |
|---|---|---|
| ① OpenAPI 驗證 | ✅ **全部端點** | 成本最低、價值最高 |
| ② REST Docs | ✅ **核心端點（12 個）** | 全部做太貴；核心端點的文件品質值得 |
| ③ Pact | ❌ **暫不採用** | 只有兩個內部客戶端（Web、App），而它們的團隊在同一個 repo → 用 ① + ② 已足夠。⚠️ 一旦有外部客戶端就要重新評估 |

### 7.10.2 用 `orders-api.yaml` 驗證實際回應

**工具：`swagger-request-validator-mockmvc`**（Atlassian）。

```xml
<dependency>
    <groupId>com.atlassian.oai</groupId>
    <artifactId>swagger-request-validator-mockmvc</artifactId>
    <version>2.40.0</version>
    <scope>test</scope>
</dependency>
```

```java
package example.shop.contract;

import com.atlassian.oai.validator.OpenApiInteractionValidator;
import com.atlassian.oai.validator.mockmvc.OpenApiValidationMatchers;
import org.junit.jupiter.api.Test;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/**
 * OpenAPI 契約驗證。
 *
 * <p>★ 一個 matcher 就同時檢查了：
 * <ul>
 *   <li>回應的狀態碼在 YAML 裡有定義</li>
 *   <li>回應的 Content-Type 相符</li>
 *   <li>回應的 body 符合 schema（必填欄位、型別、format、enum 值）</li>
 *   <li>★ **沒有多出 schema 沒定義的欄位**（若 additionalProperties: false）</li>
 *   <li>請求的 body 也符合 schema</li>
 * </ul>
 *
 * <p>★★ 第四項是最有價值的 ——
 *    它是 06 章 6.7.5 資訊洩漏防護的自動化版本，
 *    而且不需要為每個端點手寫 STRICT 的 content().json()。
 */
class OpenApiContractTest extends WebSliceTest {

    /**
     * ★ 這個 validator 建一次就好（解析 YAML 要 200～800 ms）。
     *    做成 static final 讓所有測試共用。
     */
    private static final OpenApiValidationMatchers OPEN_API =
            OpenApiValidationMatchers.openApi();

    @Test
    void 訂單明細符合契約() throws Exception {
        when(orderQueryService.findDetail(any(), any()))
                .thenReturn(Orders.所有欄位都有值的訂單());

        mockMvc.perform(get("/orders/ord_01J5GKA1")
                        .with(Auth.as(Actors.客戶())))
                .andExpect(status().isOk())
                .andExpect(OPEN_API.isValid("orders-api.yaml"));      // ★ 一行
    }

    @Test
    void 錯誤回應也符合契約() throws Exception {
        when(orderQueryService.findDetail(any(), any()))
                .thenThrow(new ResourceNotFoundException("Order", "ord_missing"));

        mockMvc.perform(get("/orders/ord_missing").with(Auth.as(Actors.客戶())))
                .andExpect(status().isNotFound())
                // ★★ 這個斷言的價值：Problem JSON 的 schema 也在 YAML 裡，
                //    所以「錯誤格式偏離契約」也會被抓到（03 章 3.10.4）
                .andExpect(OPEN_API.isValid("orders-api.yaml"));
    }
}
```

**★ 更進一步：讓「所有測試」都自動驗證契約。**

```java
package example.shop.test;

import org.springframework.boot.test.web.servlet.MockMvcBuilderCustomizer;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;

/**
 * ★★ 讓每一個 MockMvc 請求自動驗證 OpenAPI 契約。
 *
 * <p>做法：MockMvcBuilders 的 alwaysExpect ——
 *    它會對「這個 MockMvc 發出的所有請求」套用一個 matcher。
 *
 * <p>好處：契約驗證從「每個測試要記得加一行」變成「不可能漏掉」。
 *
 * <p>⚠️ 三個要處理的例外：
 * <ol>
 *   <li>不在契約裡的端點（/actuator、除錯用的 probe controller）</li>
 *   <li>串流端點（05 章：CSV、SSE —— schema 描述不了）</li>
 *   <li>刻意測「不合契約」的測試（例如 7.7.6 的壞輸入目錄裡，
 *       400 MALFORMED_REQUEST 的請求 body 本身就不合 schema）</li>
 * </ol>
 *
 * <p>★ 所以它不是無條件套用，而是「符合條件才驗證」。
 */
@TestConfiguration(proxyBeanMethods = false)
public class ContractValidationConfig {

    @Bean
    MockMvcBuilderCustomizer alwaysValidateContract() {
        return builder -> builder.alwaysExpect(result -> {
            if (!shouldValidate(result)) return;
            OpenApiValidationMatchers.openApi()
                    .isValid("orders-api.yaml")
                    .match(result);
        });
    }

    private static boolean shouldValidate(
            org.springframework.test.web.servlet.MvcResult result) {
        String uri = result.getRequest().getRequestURI();
        String contentType = result.getResponse().getContentType();

        // ① 不在契約裡的路徑
        if (uri.startsWith("/actuator") || uri.startsWith("/internal")) return false;

        // ② 串流回應（05 章）
        if (contentType != null
                && (contentType.startsWith("text/event-stream")
                 || contentType.startsWith("text/csv")
                 || contentType.startsWith("application/octet-stream")
                 || contentType.startsWith("application/pdf"))) return false;

        // ③ 400 —— 請求本身不合 schema 是刻意的（7.7.6）
        //    ⚠️ 但**回應**仍然要合 schema，所以這裡只跳過「請求」的驗證。
        //       swagger-request-validator 沒有分開的開關，
        //       所以整筆跳過 —— 由 7.7.6 的三個通用斷言補上。
        if (result.getResponse().getStatus() == 400) return false;

        return true;
    }
}
```

⚠️ **第 ③ 個例外是一個真實的取捨**，值得寫下來：

| 選項 | 後果 |
|---|---|
| 400 也驗證 | 7.7.6 的 30 幾個壞輸入測試全部失敗（請求 body 本來就不合 schema） |
| **400 整筆跳過** ✅ | 400 的**回應格式**不受契約保護 —— 由 7.7.6 的三個通用斷言補 |
| 只驗證回應不驗證請求 | 工具不支援 |

**而「400 的回應格式」其實是最需要保護的** ——
所以 7.7.6 那三個斷言（`problem+json`、`traceId`、不洩漏）
在這個取捨下變得**不可或缺**。

**★ 契約驗證抓到過的真實問題**：

```
Response body does not match schema:
  [ERROR] Object instance has properties which are not allowed by the schema:
          ["internalNote"]
     at /orders/{orderId} response 200
```

**`internalNote` 是有人在 `OrderDetail` 加的欄位** ——
它不在 YAML 裡，於是被抓到。
**這正是 06 章 6.7.5 想防的事，而且不需要手寫任何斷言。**

```
Response body does not match schema:
  [ERROR] Instance type (integer) does not match any allowed primitive type
          (allowed: ["string"])
     at /orders/{orderId} response 200, field: totalAmount
```

**有人把金額從 `String` 改回 `BigDecimal`**（06 章 6.5.7 的反向）。

### 7.10.3 Spring REST Docs：文件與測試是同一份東西

**核心想法**：文件的每一個片段，**由一個通過的測試產生**。
測試失敗 → 文件產不出來 → 建置失敗。

```xml
<dependency>
    <groupId>org.springframework.restdocs</groupId>
    <artifactId>spring-restdocs-mockmvc</artifactId>
    <scope>test</scope>
</dependency>
```

```java
package example.shop.docs;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.autoconfigure.restdocs.AutoConfigureRestDocs;

import static org.springframework.restdocs.mockmvc.RestDocumentationRequestBuilders.get;
import static org.springframework.restdocs.mockmvc.MockMvcRestDocumentation.document;
import static org.springframework.restdocs.operation.preprocess.Preprocessors.*;
import static org.springframework.restdocs.payload.PayloadDocumentation.*;
import static org.springframework.restdocs.request.RequestDocumentation.*;
import static org.springframework.restdocs.headers.HeaderDocumentation.*;

/**
 * 訂單 API 的文件測試。
 *
 * <p>★★ REST Docs 的關鍵性質：**responseFields 必須描述「每一個」欄位**。
 *    漏掉一個，測試就失敗：
 *
 * <pre>
 *   org.springframework.restdocs.payload.PayloadHandlingException:
 *   The following parts of the payload were not documented:
 *   {
 *     "internalNote" : "客戶很難搞"
 *   }
 * </pre>
 *
 * <p>⚠️ **這是一個資訊洩漏的防護**，而且比 06 章 6.7.5 的掃描更強 ——
 *    因為它強迫你為每一個欄位「寫一句給客戶看的說明」。
 *    寫不出來的欄位，通常就是不該回傳的欄位。
 */
@AutoConfigureRestDocs(outputDir = "target/generated-snippets")
class OrderDocumentationTest extends WebSliceTest {

    @Test
    void 查詢訂單明細() throws Exception {
        when(orderQueryService.findDetail(any(), any()))
                .thenReturn(Orders.所有欄位都有值的訂單());

        mockMvc.perform(get("/orders/{orderId}", "ord_01J5GKA1")
                        .header("Authorization", "Bearer {token}")
                        .with(Auth.as(Actors.客戶())))
                .andExpect(status().isOk())
                .andDo(document("orders-get",
                        // ★ 讓文件裡的 JSON 是排版過的
                        preprocessRequest(prettyPrint()),
                        preprocessResponse(prettyPrint(),
                                // ★★ 遮蔽敏感值 —— 文件會被貼到 wiki
                                replacePattern(
                                        java.util.regex.Pattern.compile(
                                                "\"phone\"\\s*:\\s*\"[^\"]*\""),
                                        "\"phone\" : \"09********\"")),

                        pathParameters(
                                parameterWithName("orderId")
                                        .description("訂單 ID（ULID，格式 `ord_` + 26 字元）")),

                        requestHeaders(
                                headerWithName("Authorization")
                                        .description("Bearer token。客戶只能查自己的訂單；"
                                                   + "客服與管理員可查任何訂單（會留稽核紀錄）")),

                        responseHeaders(
                                headerWithName("ETag")
                                        .description("用於 `If-Match` 的樂觀鎖（見 PATCH /orders/{orderId}）"),
                                headerWithName("X-Trace-Id")
                                        .description("這次請求的追蹤 ID —— 回報問題時請附上"),
                                headerWithName("Cache-Control")
                                        .description("一律 `private, no-store`（訂單含個資）")),

                        responseFields(
                                fieldWithPath("orderId")
                                        .description("訂單 ID"),
                                fieldWithPath("orderNumber")
                                        .description("訂單編號（給人看的，格式 `ORD-yyyyMMdd-NNNN`）"),
                                fieldWithPath("status")
                                        .description("""
                                                訂單狀態。**這是一個可擴充的 enum** ——
                                                未來會新增值，客戶端遇到未知值時
                                                請顯示 `statusLabel` 並停用狀態相關的動作
                                                （見 06 章 6.5.8）"""),
                                fieldWithPath("statusLabel")
                                        .description("狀態的顯示文字（已本地化）。**遇到未知的 status 時顯示這個**"),
                                fieldWithPath("items[]")
                                        .description("訂單項目。**永不為 null**，最少 0 筆"),
                                fieldWithPath("items[].productId").description("商品 ID"),
                                fieldWithPath("items[].name")
                                        .description("下單當時的商品名稱（**不是**目前的名稱）"),
                                fieldWithPath("items[].quantity").description("數量（1～999）"),
                                fieldWithPath("items[].unitPrice")
                                        .description("下單當時的單價。**字串**，見 `totalAmount`"),
                                fieldWithPath("totalAmount")
                                        .description("""
                                                總金額。**型別是字串而不是數字** ——
                                                因為 JavaScript 的 `Number` 無法精確表示
                                                所有十進位小數（見 06 章 6.5.7）。
                                                小數位數依 `currency` 而異（TWD / USD 是 2 位、
                                                JPY / KRW 是 0 位、KWD 是 3 位）"""),
                                fieldWithPath("currency").description("ISO 4217 幣別代碼"),
                                fieldWithPath("shippingAddress").description("收件地址"),
                                fieldWithPath("shippingAddress.recipientName").description("收件人"),
                                fieldWithPath("shippingAddress.maskedPhone")
                                        .description("★ 遮蔽後的電話（`0912****78`）。完整電話不透過 API 提供"),
                                fieldWithPath("shippingAddress.postalCode").description("郵遞區號"),
                                fieldWithPath("shippingAddress.line1").description("地址"),
                                fieldWithPath("couponCode")
                                        .description("使用的優惠券代碼。**沒使用時這個欄位不會出現**")
                                        .optional(),                       // ★ non_null（6.5.9）
                                fieldWithPath("createdAt")
                                        .description("建立時間。ISO-8601，UTC，**固定毫秒精度**（6.5.6）"),
                                fieldWithPath("shippedAt")
                                        .description("出貨時間。**未出貨時為 `null`（欄位仍然存在）**")
                                        .optional(),
                                fieldWithPath("cancelledAt")
                                        .description("取消時間。未取消時這個欄位不會出現")
                                        .optional())));
    }
}
```

**產出**（`target/generated-snippets/orders-get/`）：

```
curl-request.adoc          可以直接複製執行的 curl
http-request.adoc          完整的 HTTP 請求
http-response.adoc         完整的 HTTP 回應
httpie-request.adoc
path-parameters.adoc       路徑參數的表格
request-headers.adoc
response-headers.adoc
response-fields.adoc       ★ 欄位表格
```

**組成文件**（`src/docs/asciidoc/index.adoc`）：

```asciidoc
= shop-service 訂單 API
:toc: left
:sectnums:
:snippets: {snippets}

== 查詢訂單明細

`GET /orders/{orderId}`

回傳一張訂單的完整資訊。

=== 請求

include::{snippets}/orders-get/http-request.adoc[]

==== 路徑參數
include::{snippets}/orders-get/path-parameters.adoc[]

==== 標頭
include::{snippets}/orders-get/request-headers.adoc[]

=== 回應

include::{snippets}/orders-get/http-response.adoc[]

==== 欄位
include::{snippets}/orders-get/response-fields.adoc[]

=== 錯誤

include::{snippets}/orders-get-404/http-response.adoc[]
```

**Maven 設定**：

```xml
<plugin>
    <groupId>org.asciidoctor</groupId>
    <artifactId>asciidoctor-maven-plugin</artifactId>
    <version>2.2.4</version>
    <executions>
        <execution>
            <id>generate-docs</id>
            <!-- ★ 綁在 prepare-package：確保 test 已經跑過 -->
            <phase>prepare-package</phase>
            <goals><goal>process-asciidoc</goal></goals>
            <configuration>
                <backend>html5</backend>
                <sourceDirectory>src/docs/asciidoc</sourceDirectory>
                <attributes>
                    <snippets>${project.build.directory}/generated-snippets</snippets>
                </attributes>
            </configuration>
        </execution>
    </executions>
</plugin>
```

**★ REST Docs 的四個真實優點**：

| 優點 | 具體 |
|---|---|
| **文件不可能過期** | snippet 由通過的測試產生。測試壞了 → snippet 是舊的 → 但 `include::` 找不到新的 snippet 就會警告 |
| **強迫描述每個欄位** | 漏一個就失敗 → 資訊洩漏防護 |
| **範例是真的** | curl 可以直接複製執行 |
| **不汙染正式碼** | 不需要在 Controller 上加 `@Operation`、`@ApiResponse` 等註解 |

**★ 而它的四個真實缺點**（誠實地說）：

| 缺點 | 影響 |
|---|---|
| **每個端點要寫 30～60 行 descriptor** | 70 個端點 = 3,000 行文件測試 → **所以只做核心的 12 個** |
| 產出的是 HTML 而不是 OpenAPI | 客戶端產生器要 OpenAPI → 需要 `restdocs-api-spec` 這個第三方套件 |
| `.optional()` 忘了加就失敗 | 而失敗訊息是「payload 沒有這個欄位」，不太直覺 |
| 學習曲線比 springdoc 陡 | 團隊要願意投入 |

### 7.10.4 REST Docs vs springdoc-openapi：不是二選一

| | **springdoc-openapi** | **REST Docs** |
|---|---|---|
| 來源 | 掃描程式碼與註解 | **測試的執行結果** |
| 產出 | OpenAPI JSON/YAML + Swagger UI | HTML（或用外掛產 OpenAPI） |
| 會過期嗎 | ⚠️ 註解會過期（`@Schema(description=...)` 沒人維護） | ✅ 不會 |
| 汙染正式碼 | ⚠️ 是（`@Operation`、`@ApiResponse`…） | ✅ 不會 |
| 覆蓋率 | ✅ 自動涵蓋所有端點 | 🔴 只涵蓋你寫了測試的 |
| 「可以試打」 | ✅ Swagger UI | 🔴 沒有 |
| 範例是真的嗎 | 🔴 手寫的 `example =` | ✅ 是 |

**shop-service 的組合用法**：

```
orders-api.yaml（手寫，03-rest-api 第 07 章）
      ↓ 是唯一的真相來源（contract-first）
      │
      ├─→ ① OpenApiContractTest 驗證「實作符合它」       ← 7.10.2（全部端點）
      │
      ├─→ ② springdoc 產生 Swagger UI 供人試打
      │       ⚠️ 但用 `springdoc.api-docs.enabled=false`，
      │          改成直接餵手寫的 YAML —— 不讓 springdoc 從程式碼掃描
      │          （否則會有兩份互相矛盾的 OpenAPI）
      │
      └─→ ③ REST Docs 為核心的 12 個端點產生「有敘述的文件」  ← 7.10.3
              ★ 那些敘述（「為什麼金額是字串」）是 YAML 的 description
                 放不進去的東西
```

⚠️ **「兩份互相矛盾的 OpenAPI」是一個真實的陷阱。**
`springdoc` 預設會從程式碼產生 `/v3/api-docs`，
而如果你同時有手寫的 `orders-api.yaml`，
**客戶端團隊會不知道該相信哪一份**。

**shop-service 的設定**：

```yaml
springdoc:
  api-docs:
    enabled: false          # ★ 不從程式碼產生
  swagger-ui:
    enabled: true
    url: /openapi/orders-api.yaml   # ★ 直接餵手寫的那一份
```

並用 06 章 6.10.3 的 `OpenApiConsistencyTest` 守住「契約本身」的規則
（★ 它讀的是手寫的 `orders-api.yaml`，不是 `/v3/api-docs` —— 因為後者被關掉了）。

### 7.10.5 消費者驅動契約（Pact）：什麼時候值得

**Pact 解決的問題**：
「我想刪掉 `OrderDetail` 的 `internalNote` 欄位，但不知道有沒有人在用。」

**OpenAPI 驗證回答不了這個問題** ——
它只說「回應符合 schema」，不說「誰用了哪些欄位」。

**Pact 的做法**：

```
① 客戶端（App 團隊）寫一個測試，宣告「我需要這些欄位」
       ↓ 產生一份 pact 檔案
② 上傳到 Pact Broker
       ↓
③ 後端的 CI 抓下所有 pact，逐一驗證「我的實作滿足它們」
       ↓
④ 後端刪掉一個欄位 → 如果有客戶端宣告需要它 → 🔴 紅燈
```

**後端的驗證測試**：

```java
@Provider("shop-service")
@PactBroker(url = "https://pact.shop.example")
@SpringBootTest(webEnvironment = RANDOM_PORT)
class ShopServiceContractVerificationTest {

    @LocalServerPort int port;

    @BeforeEach
    void setTarget(PactVerificationContext context) {
        context.setTarget(new HttpTestTarget("localhost", port));
    }

    @TestTemplate
    @ExtendWith(PactVerificationInvocationContextProvider.class)
    void 驗證所有消費者的契約(PactVerificationContext context) {
        context.verifyInteraction();
    }

    /** ★ 「provider state」：讓後端準備出契約需要的資料。 */
    @State("有一張已付款的訂單 ord_01J5GKA1")
    void 準備已付款的訂單() {
        orders.save(Orders.已付款的單品訂單());
    }
}
```

**什麼時候值得（三個判準，要同時成立）**：

| 判準 | shop-service 的情況 |
|---|---|
| 有 3 個以上的客戶端 | 🔴 只有 2 個（Web、App） |
| 客戶端由**不同團隊**維護，且不同 repo | 🔴 同一個 repo |
| **無法**協調部署（客戶端不能與後端同時上線） | ⚠️ App 確實不能（審核要 3 天） |

**第三個判準成立，但前兩個不成立** ——
所以 shop-service 用一個**便宜得多的替代方案**：

```java
/**
 * ★ Pact 的窮人版：一份手寫的「客戶端用到的欄位」清單。
 *
 * <p>它做不到 Pact 的自動化，但成本是 1/20，
 * 而且解決了同一個核心問題：**刪欄位之前知道有沒有人用**。
 *
 * <p>維護方式：客戶端團隊改用到的欄位時，在同一個 PR 更新這裡。
 * ⚠️ 這依賴紀律。一旦紀律鬆掉（開始有人不更新），就是該上 Pact 的訊號。
 */
class ConsumerFieldUsageTest extends WebSliceTest {

    /** Web 前端用到的欄位（2026-08 盤點）。 */
    private static final Set<String> WEB_USES = Set.of(
            "orderId", "orderNumber", "status", "statusLabel",
            "items[].productId", "items[].name", "items[].quantity",
            "items[].unitPrice", "totalAmount", "currency", "createdAt");

    /** iOS / Android App 用到的欄位（2026-08 盤點，App 版本 4.2.0）。 */
    private static final Set<String> APP_USES = Set.of(
            "orderId", "orderNumber", "status", "statusLabel",
            "totalAmount", "currency", "createdAt", "shippedAt",
            "shippingAddress.recipientName", "shippingAddress.line1");

    @ParameterizedTest(name = "{0} 需要 {1}")
    @MethodSource("consumerFields")
    void 客戶端需要的欄位都還存在(String consumer, String jsonPath) throws Exception {
        when(orderQueryService.findDetail(any(), any()))
                .thenReturn(Orders.所有欄位都有值的訂單());

        mockMvc.perform(get("/orders/ord_1").with(Auth.as(Actors.客戶())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$." + jsonPath)
                        .as("""
                            %s 需要的欄位 '%s' 不見了。

                            ★ 如果這是刻意的移除，流程是：
                              1. 通知 %s 的團隊
                              2. 等他們發布不再使用該欄位的版本
                              3. ⚠️ App 還要等使用者更新（我們的政策是 90 天）
                              4. 然後才移除，並更新這份清單

                            這份清單最後盤點的時間見類別的 javadoc ——
                            如果超過 6 個月，先去重新盤點。
                            """, consumer, jsonPath, consumer)
                        .exists());
    }
}
```

⚠️ **`jsonPath(...).as(...)`** —— `JsonPathResultMatchers` 沒有 `as()`。
實際上要包一層：

```java
.andExpect(result -> assertThat(
                com.jayway.jsonpath.JsonPath.<Object>read(
                        result.getResponse().getContentAsString(UTF_8), "$." + jsonPath))
        .as(""" ... """)
        .isNotNull())
```

**這是一個「範例程式碼要能真的編譯」的提醒** ——
API 的細節要查，不要憑印象寫。

---

## 7.11 那些「必須」用整合測試的東西

### 7.11.1 一張表：`@WebMvcTest` 測不到什麼

這張表是 7.5.9 的「差異」轉成「該怎麼辦」。

| 要驗證的 | 為什麼切片不行 | 用什麼 | 這一章的哪一節 |
|---|---|---|---|
| **filter 的順序** | 切片的 filter chain 不保證與正式環境一致 | ④ | 7.11.2 |
| **filter 產生的錯誤有 CORS 標頭** | 需要真的 filter 順序 | ④ | 06 章 6.3.5 |
| **CORS preflight** | MockMvc 沒有容器層的 OPTIONS 處理 | ④′ | 06 章 6.10.4 |
| **認證與授權** | 切片裡的 SecurityFilterChain 可能是預設值 | ④ | 7.9 |
| **資源層級授權（IDOR）** | 需要真的資料 | ④ + Testcontainers | 7.9.5 |
| **gzip 壓縮** | MockMvc 不壓縮 | ④′ | 7.11.5 |
| **chunked 傳輸** | MockMvc 一律有 Content-Length | ④′ | 7.11.5 |
| **`Range` 請求的真實分段** | ⚠️ MockMvc 部分可以（見 7.11.5） | ④′ | 7.11.5 |
| **SSE 的心跳、斷線、重連** | 沒有時間與 socket | ④′ | 7.11.4 |
| **multipart 的 Tomcat 413** | request 是你組的 | ④′ | 7.4.2 |
| **超長/非法標頭** | MockMvc 不檢查 | ④′ | 7.11.5 |
| **路徑穿越（`%2F`、`..`）** | MockMvc 不正規化 | ④′ | 7.11.5 |
| **`AFTER_COMMIT` 的事件** | 需要真的交易 | ④ + 真的 DB | 7.11.6 |
| **關機時 SSE 主動結束連線** | 切片沒有 `ContextClosedEvent` 的完整流程 | ④ | 05 章 5.11.10 |
| **關機時串流寫出 sentinel** | 同上 | ④ | 05 章 5.11.10 |
| **啟動時的驗證器** | `@WebMvcTest` 不一定會跑 | ④ | 7.11.6 |
| **`@Scheduled` 的任務** | 切片不載入 | ④ + 手動觸發 | 7.11.6 |
| **`ObjectMapper` 的完整組裝** | ⚠️ 切片其實可以 | ③ | 06 章 |

**注意最後一列**：很多人以為「Jackson 設定要整合測試」——
**不需要**，`@WebMvcTest` 有 `JacksonAutoConfiguration`（7.4.1）。

### 7.11.2 filter 順序：一個真正需要 ④ 的例子

04 章 4.13.1 與 06 章 6.9.4 有一張 filter 順序表。
**那張表需要一個測試守著。**

```java
package example.shop.common.web;

import jakarta.servlet.Filter;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.ApplicationContext;
import org.springframework.core.annotation.AnnotationAwareOrderComparator;
import org.springframework.core.annotation.Order;

import java.util.Comparator;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * filter 順序的守門測試。
 *
 * <p>★★ 為什麼這是最值得寫的整合測試之一：
 * <ul>
 *   <li>06 章 6.2.1 的事故（錯誤回應沒有 CORS 標頭）**完全**是順序問題。</li>
 *   <li>順序錯了沒有任何症狀，直到某個特定的錯誤發生。</li>
 *   <li>而 order 是一個數字 —— 新增 filter 的人很容易挑一個「看起來沒被用」的。</li>
 * </ul>
 *
 * <p>★ 這個測試不啟動 web server（用 MOCK environment），
 *    因為它只檢查 bean 的順序，不發請求 ——
 *    所以它可以與其他 @SpringBootTest 共用 context。
 */
@SpringBootTest
class FilterOrderTest {

    @Autowired ApplicationContext context;

    /**
     * ★ 期望的順序。這份清單就是 06 章 6.9.4 那張表的可執行版本。
     *
     * <p>⚠️ 改這份清單時，一定要在 PR 說明「為什麼這個 filter 要移位置」。
     */
    private static final List<String> EXPECTED_ORDER = List.of(
            "corsFilter",                       // -200 ★ 早於所有【自訂】filter（06 章 6.3.5）
            "varyOriginOptimizationFilter",     // -199（6.3.7）
            "traceIdFilter",                    // -121
            "trailingSlashRedirectFilter",      // -120
            "ipRateLimitFilter",                // -119
            "requestSizeLimitFilter",           // -118  只看 Content-Length
            "jsonCharsetFilter",                // -117  只看 Content-Type ★ 06 章 6.4.2
            "cachedBodyFilter",                 // -116  ★ 開始讀 body
            "requestLoggingFilter",             // -115
            "auditFilter",                      // -114
            "shallowEtagHeaderFilter",          // -110（6.8.1）
            "requestContextFilter",             // -105（Boot 內建）
            "springSecurityFilterChain",        // -100
            "idempotencyFilter"                 //  -99
    );

    /**
     * ★ Boot 自動註冊、而且 order 比 -200 更小的 filter。
     *
     * <p>它們一定排在 {@code corsFilter} 之前，而那<b>沒有問題</b> ——
     * 它們不產生錯誤回應（只設編碼、記指標、處理 {@code X-Forwarded-*}）。
     *
     * <p>⚠️ 沒有這份排除清單的話，下面的
     * {@code CorsFilter排在所有自訂filter之前()} 會<b>永遠失敗</b>：
     * {@code OrderedCharacterEncodingFilter} 的 order 是
     * {@code Integer.MIN_VALUE}，它一定是第一個。
     */
    private static final Set<String> BOOT_FILTERS_BEFORE_CORS = Set.of(
            "characterEncodingFilter",          // Integer.MIN_VALUE
            "forwardedHeaderFilter",            // Integer.MIN_VALUE
            "webMvcObservationFilter",          // MIN_VALUE + 1
            "formContentFilter");               // -9900（★ 比 -200 小！）

    @Test
    void filter的順序符合設計() {
        List<String> actual = orderedFilterNames();

        assertThat(actual)
                .as("""
                    filter 的順序與設計不符（見 04 章 4.13.1、06 章 6.9.4）。

                    期望：
                    %s

                    實際：
                    %s

                    ⚠️ 順序錯誤的後果不是「壞掉」而是「靜默地不對」：
                      · CorsFilter 不在最前面 → 429/413 的回應沒有 CORS 標頭
                        → 前端只看到 Network Error（06 章 6.2.1）
                      · CachedBodyFilter 在 RequestLoggingFilter 之後
                        → @RequestBody 綁到空的（04 章 4.4.6）
                      · IdempotencyFilter 在 Security 之前
                        → 未認證的請求也會消耗冪等鍵
                    """,
                    String.join("\n  ", EXPECTED_ORDER),
                    String.join("\n  ", actual))
                .containsSubsequence(EXPECTED_ORDER.toArray(String[]::new));
    }

    @Test
    void 沒有兩個filter用相同的order() {
        var byOrder = new java.util.TreeMap<Integer, List<String>>();

        context.getBeansOfType(Filter.class).forEach((name, filter) -> {
            Integer order = orderOf(name, filter);
            if (order != null) {
                byOrder.computeIfAbsent(order, k -> new java.util.ArrayList<>()).add(name);
            }
        });

        var duplicates = byOrder.entrySet().stream()
                .filter(e -> e.getValue().size() > 1)
                .toList();

        assertThat(duplicates)
                .as("""
                    有 filter 使用了相同的 order：%s

                    ⚠️ **相同 order 的兩個 filter，執行順序是未定義的**
                       —— 它取決於 bean 的註冊順序，而那可能隨
                       classpath 掃描的順序改變（06 章 6.9.4）。

                    症狀：本機正常、CI 正常、正式環境某次重新部署後壞掉。

                    修法：給每一個 filter 一個唯一的 order。
                    shop-service 的慣例是每個相差 1，並在
                    04 章 4.13.1 的表格裡登記。
                    """, duplicates)
                .isEmpty();
    }

    /**
     * ★★ 這個測試單獨存在（而不是只依賴 {@code containsSubsequence}），
     * 因為它是 06 章整章的核心結論，值得一個專屬的紅燈。
     *
     * <p>⚠️⚠️ 注意它斷言的是「早於所有<b>自訂</b> filter」而不是「全場第一」——
     * `-200` 比 Boot 的 `MIN_VALUE` / `-9900` 都大（06 章 6.9.4）。
     * 第一版寫成 {@code .first().isEqualTo("corsFilter")}，那是<b>永遠紅燈</b>的。
     */
    @Test
    void CorsFilter排在所有自訂filter之前() {
        var names = orderedFilterNames().stream()
                .filter(name -> !BOOT_FILTERS_BEFORE_CORS.contains(name))
                .toList();

        assertThat(names)
                .as("""
                    CorsFilter 不是第一個【自訂】filter。

                    後果（06 章 6.2.1）：在它之前的任何 filter
                    如果自己寫完回應就 return（限流的 429、
                    大小限制的 413、冪等的 409），
                    那個回應就**沒有 CORS 標頭** ——
                    而瀏覽器會拒絕讓 JavaScript 讀它。

                    使用者看到的是「系統發生問題」而不是「請求過於頻繁」。

                    ⚠️ 如果失敗訊息裡「排在前面的」是一個 Boot 內建的 filter，
                       那不是 bug —— 把它加進 BOOT_FILTERS_BEFORE_CORS，
                       並確認它【不會產生錯誤回應】。
                    """)
                .first()
                .isEqualTo("corsFilter");
    }

    /** 依實際生效的順序列出 filter 的 bean 名稱。 */
    private List<String> orderedFilterNames() {
        Map<String, Filter> filters = context.getBeansOfType(Filter.class);
        return filters.entrySet().stream()
                .sorted(Comparator.comparing(e -> {
                    Integer o = orderOf(e.getKey(), e.getValue());
                    return o == null ? Integer.MAX_VALUE : o;
                }))
                .map(Map.Entry::getKey)
                .toList();
    }

    /**
     * 取得一個 filter 的 order。
     *
     * <p>⚠️ 三個來源，要都檢查：
     * <ol>
     *   <li>{@code FilterRegistrationBean.getOrder()}</li>
     *   <li>類別上的 {@code @Order}</li>
     *   <li>實作 {@code Ordered} 介面</li>
     * </ol>
     */
    private Integer orderOf(String name, Filter filter) {
        // ① FilterRegistrationBean
        var registrations = context.getBeansOfType(FilterRegistrationBean.class);
        for (var reg : registrations.values()) {
            if (reg.getFilter() == filter) return reg.getOrder();
        }
        // ② @Order
        Order annotation = filter.getClass().getAnnotation(Order.class);
        if (annotation != null) return annotation.value();
        // ③ Ordered
        if (filter instanceof org.springframework.core.Ordered ordered) {
            return ordered.getOrder();
        }
        return null;
    }
}
```

⚠️ **`containsSubsequence` 而不是 `containsExactly`** ——
因為 Boot 會自動註冊一些 filter（`characterEncodingFilter`、
`formContentFilter`、`ShallowEtagHeaderFilter`…），
而它們的位置我們不在意。**只在意「我們的那些」的相對順序。**

### 7.11.3 CORS

06 章 6.10.4 已經有完整的整合測試（`CorsIntegrationTest`）。
**這裡只補一件那一節沒說的事：怎麼確保「新增 filter 時不破壞它」。**

```java
/**
 * ★ 一個「涵蓋所有錯誤路徑」的 CORS 測試。
 *
 * <p>06 章 6.3.5 的 CorsOnErrorResponsesTest 列舉了七種錯誤。
 * 這裡把它改成「從授權矩陣自動產生」——
 * 於是新增端點時自動涵蓋。
 */
@SpringBootTest(webEnvironment = RANDOM_PORT)
class CorsOnAllErrorPathsTest {

    @Autowired TestRestTemplate rest;

    /**
     * ★ 產生「每一種會產生錯誤的情境」。
     */
    static Stream<Arguments> errorScenarios() {
        return Stream.of(
                // (情境, 請求, 期望的狀態碼, 由哪一層產生)
                Arguments.of("401 未認證",       req("GET", "/orders"), 401, "Security"),
                Arguments.of("403 權限不足",     req("POST", "/products").as(Actors.客戶()),
                                                403, "Security"),
                Arguments.of("404 端點不存在",   req("GET", "/nonexistent"), 404, "DispatcherServlet"),
                Arguments.of("405 方法不允許",   req("DELETE", "/products"), 405, "DispatcherServlet"),
                Arguments.of("400 JSON 壞掉",   req("POST", "/orders").body("{"), 400, "advice"),
                Arguments.of("422 驗證失敗",     req("POST", "/orders").body("{}"), 422, "advice"),
                Arguments.of("413 請求太大",     req("POST", "/orders").body("x".repeat(3_000_000)),
                                                413, "RequestSizeLimitFilter"),
                Arguments.of("429 限流",         req("GET", "/products").repeat(400),
                                                429, "IpRateLimitFilter"),
                Arguments.of("409 冪等衝突",     req("POST", "/orders").sameIdempotencyKeyTwice(),
                                                409, "IdempotencyFilter"),
                Arguments.of("415 型別不支援",   req("POST", "/orders").contentType("text/plain"),
                                                415, "advice"),
                Arguments.of("406 無法產生",     req("GET", "/orders").accept("application/pdf"),
                                                406, "advice"),
                Arguments.of("500 未預期",       req("GET", "/internal/boom"), 500, "GenericAdvice"),
                Arguments.of("428 缺 If-Match",  req("PATCH", "/orders/ord_1"), 428, "advice"));
    }

    @ParameterizedTest(name = "{0}（由 {3} 產生）")
    @MethodSource("errorScenarios")
    void 每一種錯誤回應都有CORS標頭(String scenario, RequestSpec spec,
                                     int expectedStatus, String producedBy) {
        var response = spec.withOrigin("https://shop.example").execute(rest);

        assertThat(response.getStatusCode().value()).isEqualTo(expectedStatus);

        assertThat(response.getHeaders().getAccessControlAllowOrigin())
                .as("""
                    「%s」的回應沒有 Access-Control-Allow-Origin。

                    這個回應是由 %s 產生的。

                    ★ 檢查（06 章 6.3.5）：
                      · 如果是某個 filter：它的 order 在 CorsFilter(-200) 之後嗎？
                      · 如果它用 ProblemWriter：那個 reset() 保留 CORS 標頭了嗎？
                      · 如果是 Security：SecurityConfig 有 .cors() 嗎？

                    後果：前端拿不到這個錯誤的內容，只看到 Network Error。
                    對 %d 這個狀態碼來說，那代表使用者看不到
                    「%s」該顯示的訊息。
                    """, scenario, producedBy, expectedStatus, scenario)
                .isEqualTo("https://shop.example");

        // ★ 而且 X-Trace-Id 要被 expose（06 章 6.3.3）
        assertThat(response.getHeaders().getAccessControlExposeHeaders())
                .as("X-Trace-Id 沒有被 expose —— 前端無法在回報問題時附上追蹤碼")
                .contains("X-Trace-Id");
    }
}
```

### 7.11.4 SSE：真的 HTTP 才測得到的六件事

```java
package example.shop.order.web;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.MediaType;
import org.springframework.web.reactive.function.client.WebClient;

import java.time.Duration;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * SSE 的整合測試。
 *
 * <p>★ 用 WebClient 而不是 TestRestTemplate ——
 *    因為 SSE 是一個「持續開著的串流」，
 *    RestTemplate 的阻塞模型處理不了「邊收邊斷言」。
 *
 * <p>⚠️ 這需要 spring-webflux 在 test classpath 上：
 * <pre>
 *   &lt;dependency&gt;
 *     &lt;groupId&gt;org.springframework.boot&lt;/groupId&gt;
 *     &lt;artifactId&gt;spring-boot-starter-webflux&lt;/artifactId&gt;
 *     &lt;scope&gt;test&lt;/scope&gt;
 *   &lt;/dependency&gt;
 * </pre>
 * ★ 只在 test scope —— 不要讓 webflux 進正式的 classpath
 *   （它會與 spring-webmvc 打架，Boot 會選 WebFlux 當 web 型別）。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
                properties = {
                        // ★ 把心跳間隔縮短，讓測試不用等 20 秒
                        "api.sse.heartbeat-interval=200ms",
                        "api.sse.connection-timeout=5s",
                        "api.sse.max-total-connections=3",
                        "api.sse.max-connections-per-actor=2"
                })
class OrderEventStreamIntegrationTest {

    @LocalServerPort int port;
    @Autowired SseEmitterRegistry registry;
    @Autowired OrderEventPublisher publisher;      // 測試用的事件注入點

    private WebClient client() {
        return WebClient.builder()
                .baseUrl("http://localhost:" + port)
                .defaultHeader("Authorization", "Bearer " + TestTokens.customer())
                .build();
    }

    /** ① 心跳真的會定期送出（5.11.4）。 */
    @Test
    void 心跳會定期送出() {
        List<String> received = new CopyOnWriteArrayList<>();

        var subscription = client().get()
                .uri("/orders/ord_1/events")
                .accept(MediaType.TEXT_EVENT_STREAM)
                .retrieve()          // ⚠️ 實際 API 見下方註記
                .bodyToFlux(String.class)
                .subscribe(received::add);

        try {
            // 等 1 秒 —— 心跳間隔 200 ms，應該收到 4～5 個
            await().atMost(Duration.ofSeconds(2))
                    .until(() -> received.stream()
                            .filter(s -> s.contains("heartbeat")).count() >= 3);
        } finally {
            subscription.dispose();
        }
    }

    /** ② 客戶端斷線時 registry 會清理（5.11.6）。 */
    @Test
    void 客戶端斷線會被清理() {
        int before = registry.size();

        var subscription = client().get().uri("/orders/ord_1/events")
                .accept(MediaType.TEXT_EVENT_STREAM)
                .retrieve().bodyToFlux(String.class).subscribe();

        await().atMost(Duration.ofSeconds(2))
                .until(() -> registry.size() == before + 1);

        // ★★ 真的斷線 —— 這是 MockMvc 完全做不到的事
        subscription.dispose();

        await().atMost(Duration.ofSeconds(5))
                .as("""
                    客戶端斷線後，registry 沒有清理那個 emitter。

                    後果（05 章 5.11.6）：每一個斷線的連線都留下一個
                    SseEmitter 物件與它引用的所有東西 ——
                    這是一個記憶體洩漏，而它的速度與使用者的網路品質成正比
                    （手機在電梯裡斷線最頻繁）。

                    檢查：SseEmitterRegistry 有註冊
                      onCompletion / onTimeout / onError 三個 callback 嗎？
                    ⚠️ 三個都要 —— 只註冊 onCompletion 會漏掉逾時與錯誤。
                    """)
                .until(() -> registry.size() == before);
    }

    /**
     * ③ 連線數上限（5.11.6）。
     *
     * <p>⚠️⚠️ <b>期望的是 503，不是 429。</b>
     * 05 章的 {@code TooManySseConnectionsException} 用的是
     * {@code ErrorCode.SERVICE_UNAVAILABLE}，而那一節有明確的理由：
     * 「這是<b>伺服器容量</b>問題而不是<b>你請求太快</b>」，
     * 而且 SSE 在瀏覽器裡的錯誤處理很受限，所以兩種 scope 統一用 503
     * 讓前端只有一套處理邏輯。
     *
     * <p>★ 這個測試會抓到「有人把它改成 429」——
     * 那個改動看起來很合理（「限流不是都用 429 嗎」），
     * 但它會讓前端的重試邏輯走錯分支。
     *
     * <p>★ 而上限能被 {@code @SpringBootTest(properties = ...)} 調低，
     * 是因為 5.11.6 的 {@code SseEmitterRegistry} 讀的是
     * {@code SseProperties}（而不是寫死的常數）——
     * <b>「可設定」是「可測試」的前提</b>。
     */
    @Test
    void 超過連線上限回503() {
        var subs = new java.util.ArrayList<reactor.core.Disposable>();
        try {
            // ★ 這個類別的 properties 設了 max-connections-per-actor = 2
            subs.add(subscribe("/orders/ord_1/events"));
            subs.add(subscribe("/orders/ord_2/events"));

            assertThatThrownBy(() -> subscribeAndWait("/orders/ord_3/events"))
                    .as("""
                        第三條連線沒有被拒絕，或回了錯的狀態碼。

                        期望：503 SERVICE_UNAVAILABLE（05 章 5.11.6 的決定）
                        ⚠️ 不是 429 —— 那是「請求太快」，這是「容量已滿」。

                        如果它根本沒被拒絕，檢查：
                          · SseEmitterRegistry 讀的是 SseProperties 還是寫死的常數？
                            （寫死的話這個 @SpringBootTest(properties=...) 完全無效）
                          · maxPerActor 的檢查在 register() 裡嗎？
                        """)
                    .hasMessageContaining("503");
        } finally {
            subs.forEach(reactor.core.Disposable::dispose);
        }
    }

    /** ④ Last-Event-ID 的重連補送（5.11.5）。 */
    @Test
    void 重連時用LastEventID補送遺漏的事件() {
        // 第一次連線，收到 evt_1、evt_2
        var received1 = new CopyOnWriteArrayList<String>();
        var sub1 = subscribeCollecting("/orders/ord_1/events", null, received1);
        publisher.publish("ord_1", "evt_1", "PAID");
        publisher.publish("ord_1", "evt_2", "SHIPPED");
        await().until(() -> received1.size() >= 2);
        sub1.dispose();

        // ★ 斷線期間發生的事件
        publisher.publish("ord_1", "evt_3", "DELIVERED");

        // 重連，帶 Last-Event-ID: evt_2
        var received2 = new CopyOnWriteArrayList<String>();
        var sub2 = subscribeCollecting("/orders/ord_1/events", "evt_2", received2);
        try {
            await().atMost(Duration.ofSeconds(3))
                    .as("""
                        重連時沒有補送 evt_3。

                        後果：使用者的訂單狀態卡在 SHIPPED，
                        直到下一次事件或重新整理頁面。

                        檢查：OrderEventReplayService 有被呼叫嗎？
                        （05 章 5.11.5 —— Last-Event-ID 標頭由
                          EventSource 自動帶上，後端一定要處理它）
                        """)
                    .until(() -> received2.stream().anyMatch(s -> s.contains("evt_3")));

            // ★ 而且不可以重送 evt_1、evt_2
            assertThat(received2)
                    .as("補送時重複送了已經收到的事件 —— 客戶端會看到重複的通知")
                    .noneMatch(s -> s.contains("evt_1"));
        } finally {
            sub2.dispose();
        }
    }

    /** ⑤ SSE 沒有被壓縮（5.11.7）。 */
    @Test
    void SSE的回應沒有被壓縮() {
        // ★ 明確要求壓縮
        var headers = client().get().uri("/orders/ord_1/events")
                .header("Accept-Encoding", "gzip")
                .accept(MediaType.TEXT_EVENT_STREAM)
                .exchangeToMono(r -> reactor.core.publisher.Mono.just(r.headers()))
                .block(Duration.ofSeconds(5));

        assertThat(headers.header("Content-Encoding"))
                .as("""
                    SSE 的回應被 gzip 壓縮了。

                    後果（05 章 5.11.7）：gzip 會緩衝資料直到累積足夠 ——
                    於是事件不會即時到達，SSE 變成「幾秒後才收到」。
                    而使用者看到的是「即時通知有時候會延遲」，
                    一個非常難查的問題。

                    修法：server.compression.mime-types 不要包含
                          text/event-stream（05 章 5.12.2）。
                    """)
                .isEmpty();
    }

    /** ⑥ X-Accel-Buffering 標頭真的送出（5.11.7）。 */
    @Test
    void 回應有XAccelBuffering標頭() {
        var headers = /* ... */ null;
        assertThat(headers.header("X-Accel-Buffering"))
                .as("""
                    缺少 X-Accel-Buffering: no。

                    後果：Nginx 會緩衝 SSE 的回應 ——
                    在本機（沒有 Nginx）完美，上線後完全不動。
                    這是 05 章 5.2.4 的那個事故。
                    """)
                .containsExactly("no");
    }
}
```

⚠️ **上面的 `WebClient` 呼叫鏈用了 `.retrieve()`，那不是真的 API。**
正確的是：

```java
client().get().uri("/orders/ord_1/events")
        .accept(MediaType.TEXT_EVENT_STREAM)
        .retrieve()                                    // 🔴 不存在
// ✅
client().get().uri("/orders/ord_1/events")
        .accept(MediaType.TEXT_EVENT_STREAM)
        .exchangeToFlux(response -> response.bodyToFlux(
                new org.springframework.core.ParameterizedTypeReference<
                        org.springframework.http.codec.ServerSentEvent<String>>() {}))
```

**`ServerSentEvent<String>` 這個型別很有用** ——
它把線路格式解析成 `id()` / `event()` / `data()` / `comment()`，
**於是斷言可以針對欄位而不是字串比對**：

```java
assertThat(received)
        .extracting(ServerSentEvent::id)
        .containsExactly("evt_1", "evt_2");
assertThat(received)
        .filteredOn(e -> e.comment() != null)
        .as("心跳（comment 形式）至少三次")
        .hasSizeGreaterThanOrEqualTo(3);
```

**`await()` 來自 Awaitility**：

```xml
<dependency>
    <groupId>org.awaitility</groupId>
    <artifactId>awaitility</artifactId>
    <scope>test</scope>
</dependency>
```

⚠️ **不要用 `Thread.sleep()` 代替 `await()`。**

| | `Thread.sleep(2000)` | `await().atMost(2s).until(...)` |
|---|---|---|
| 條件早就滿足 | **還是等 2 秒** | 立刻繼續（通常 50 ms） |
| 條件永遠不滿足 | 繼續執行 → 斷言失敗，訊息不清楚 | 逾時，訊息說「等了 2 秒條件仍未滿足」 |
| 100 個測試 | +200 秒 | +5 秒 |

### 7.11.5 壓縮、`Range`、chunked、超長標頭

```java
@SpringBootTest(webEnvironment = RANDOM_PORT)
class RealHttpBehaviourTest {

    @Autowired TestRestTemplate rest;

    /** ① 壓縮真的生效（05 章 5.12.2）。 */
    @Test
    void JSON回應會被gzip壓縮() {
        var headers = new HttpHeaders();
        headers.setAcceptEncodingAsString("gzip");
        // ⚠️ TestRestTemplate 的底層 client 預設會自動解壓縮並移除
        //    Content-Encoding 標頭 —— 所以要關掉那個行為
        var response = rawRest().exchange("/orders", HttpMethod.GET,
                new HttpEntity<>(headers), byte[].class);

        assertThat(response.getHeaders().getFirst("Content-Encoding"))
                .as("""
                    大的 JSON 回應沒有被壓縮。

                    檢查：
                      · server.compression.enabled = true？
                      · mime-types 包含 application/json？
                      · ★ 回應大於 min-response-size（2048）嗎？
                        —— 小的回應**刻意**不壓縮（壓縮的成本大於節省）
                        所以這個測試要確保回應夠大（至少 2 KB）
                    """)
                .isEqualTo("gzip");
    }

    /** ② 串流是 chunked（05 章 5.9）。 */
    @Test
    void CSV匯出用chunked傳輸() {
        var response = rest.exchange("/orders.csv", HttpMethod.GET,
                authEntity(Actors.客服()), byte[].class);

        assertThat(response.getHeaders().getFirst("Transfer-Encoding"))
                .as("""
                    CSV 匯出不是 chunked，代表它有 Content-Length ——
                    也就是**整份內容被先組在記憶體裡**。

                    那正是 05 章 5.2.3 的事故（41 萬筆訂單 OOM）。

                    檢查：Controller 回傳的是 StreamingResponseBody 嗎？
                    ⚠️ 常見的退步：有人為了「加一個總筆數的標頭」
                       而改成先收集再回傳 —— 那會靜默地退回 OOM 版本。
                    """)
                .isEqualTo("chunked");
        assertThat(response.getHeaders().getContentLength()).isEqualTo(-1);
    }

    /** ③ Range 請求的真實行為（05 章 5.8.3）。 */
    @Test
    void 收據支援Range請求() {
        var headers = new HttpHeaders();
        headers.setRange(List.of(HttpRange.createByteRange(0, 99)));

        var response = rest.exchange("/orders/ord_1/receipts/rcp_1",
                HttpMethod.GET, new HttpEntity<>(headers), byte[].class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.PARTIAL_CONTENT);
        assertThat(response.getBody()).hasSize(100);
        assertThat(response.getHeaders().getFirst("Content-Range"))
                .matches("bytes 0-99/\\d+");
        assertThat(response.getHeaders().getFirst("Accept-Ranges")).isEqualTo("bytes");
    }

    /**
     * ★★ ④ 「Range 支援沒有被 configureMessageConverters 弄掉」。
     *
     * <p>06 章 6.4.5 的核心陷阱：用 configureMessageConverters
     * （而不是 extendMessageConverters）會把
     * ResourceRegionHttpMessageConverter 弄掉，
     * **而唯一的症狀是 Range 請求變成回傳整個檔案**。
     *
     * <p>⚠️ 這個測試比 06 章 6.4.5 的 assertPresent 檢查更直接 ——
     *    它驗證的是行為而不是 bean 的存在。**兩個都留**。
     */
    @Test
    void Range支援的回歸測試() {
        var headers = new HttpHeaders();
        headers.setRange(List.of(HttpRange.createByteRange(100, 199)));

        var response = rest.exchange("/orders/ord_1/receipts/rcp_1",
                HttpMethod.GET, new HttpEntity<>(headers), byte[].class);

        assertThat(response.getStatusCode())
                .as("""
                    Range 請求回了 200 而不是 206。

                    最可能的原因（06 章 6.4.5）：
                    有人用 configureMessageConverters 覆寫了 converter 清單，
                    而那**移除**了 ResourceRegionHttpMessageConverter。

                    修法：改用 extendMessageConverters。

                    後果：App 的「續傳下載」變成「每次從頭下載」——
                    在行動網路上那是一個很貴的 bug，而且沒有任何錯誤訊息。
                    """)
                .isEqualTo(HttpStatus.PARTIAL_CONTENT);
    }

    /** ⑤ 超長標頭被拒絕（04 章 4.4.4 的 log injection 防護）。 */
    @Test
    void 超長的TraceId標頭被拒絕或截斷() {
        var headers = new HttpHeaders();
        headers.set("X-Trace-Id", "A".repeat(10_000));

        var response = rest.exchange("/products", HttpMethod.GET,
                new HttpEntity<>(headers), String.class);

        // ★ 兩種都可接受：容器擋掉（431/400）或應用層忽略它
        if (response.getStatusCode().is2xxSuccessful()) {
            assertThat(response.getHeaders().getFirst("X-Trace-Id"))
                    .as("""
                        應用層採用了客戶端提供的超長 traceId。

                        後果（04 章 4.4.4）：那個值會進 log ——
                        10,000 字元的 log 欄位、可能含換行（log injection）。

                        修法：TraceIdFilter 要驗證客戶端提供的 traceId
                              （長度、字元集），不合格就自己產生一個。
                        """)
                    .hasSizeLessThanOrEqualTo(64);
        } else {
            assertThat(response.getStatusCode().value()).isIn(400, 431);
        }
    }

    /** ⑥ 路徑穿越被容器擋掉。 */
    @ParameterizedTest
    @ValueSource(strings = {
            "/orders/../../etc/passwd",
            "/orders/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
            "/orders/ord_1%2Freceipts",           // 編碼的斜線
            "//orders//ord_1",                     // 雙斜線
            "/orders/ord_1;jsessionid=abc"          // 路徑參數
    })
    void 異常路徑不會存取到預期外的資源(String path) {
        var response = rest.exchange(path, HttpMethod.GET,
                authEntity(Actors.客戶()), String.class);

        assertThat(response.getStatusCode().value())
                .as("路徑 '%s' 得到 %s —— 檢查它到達了哪個 handler",
                    path, response.getStatusCode())
                .isIn(400, 401, 403, 404);
    }
}
```

⚠️ **`rawRest()`（不自動解壓縮的 client）**：

```java
/**
 * ★ TestRestTemplate 預設用 Apache HttpClient 或 JDK 的 client，
 *    而它們會「自動解壓縮並移除 Content-Encoding 標頭」——
 *    於是壓縮測試永遠看不到那個標頭。
 *
 * <p>解法：用一個明確關掉自動解壓縮的 client。
 */
private TestRestTemplate rawRest() {
    var factory = new org.springframework.http.client
            .SimpleClientHttpRequestFactory();
    var template = new org.springframework.web.client.RestTemplate(factory);
    // SimpleClientHttpRequestFactory 底層是 HttpURLConnection，
    // 它只在「客戶端自己設 Accept-Encoding」時**不會**自動解壓縮
    return new TestRestTemplate(template);
}
```

⚠️ **這個細節是「壓縮測試為什麼總是失敗」的答案。**
很多人會以為壓縮沒生效，實際上是 HTTP client 太貼心了。

### 7.11.6 Testcontainers 在 Web 層的角色

**Web 層的測試需要真的資料庫嗎？** 大部分不需要。
**三個例外**：

| 情況 | 為什麼需要真的 DB |
|---|---|
| **資源層級授權（IDOR，7.9.5）** | 判斷「這是誰的訂單」要查資料 |
| **`AFTER_COMMIT` 事件（7.2.4）** | 需要真的 commit |
| **冪等（04 章 4.9）** | 冪等鍵的唯一約束在資料庫 |

```java
package example.shop.integration;

import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.testcontainers.containers.MySQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

/**
 * 需要真實基礎設施的整合測試的共同基底。
 *
 * <p>★★ 關鍵設計：容器是 **static**，所以整個測試套件只啟動一次。
 *    MySQL 容器啟動約 4～8 秒 —— 每個測試類別一次是不可接受的。
 *
 * <p>★ @ServiceConnection（Boot 3.1+）取代了以前的
 *    @DynamicPropertySource —— 它自動把容器的連線資訊
 *    接到 spring.datasource.* 上。
 *
 * <p>⚠️ 三個常見錯誤：
 * <ol>
 *   <li>容器不是 static → 每個類別重啟 → 慢 20 倍</li>
 *   <li>沒有繼承同一個基底 → 不同的 context → 也慢</li>
 *   <li>用 @Transactional 讓測試自動回滾 → AFTER_COMMIT 不執行（7.2.4）</li>
 * </ol>
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Testcontainers
public abstract class InfrastructureIntegrationTest {

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL =
            new MySQLContainer<>("mysql:8.4")
                    .withReuse(true);      // ★ 本機開發時重用容器（要開 testcontainers.reuse.enable）

    @Container
    @ServiceConnection
    static final org.testcontainers.containers.GenericContainer<?> REDIS =
            new org.testcontainers.containers.GenericContainer<>("redis:7.4-alpine")
                    .withExposedPorts(6379)
                    .withReuse(true);

    /**
     * ★★ 資料清理：**不用 @Transactional**。
     *
     * <p>理由（7.2.4）：@Transactional 讓測試在結束時 rollback，
     * 於是 @TransactionalEventListener(AFTER_COMMIT) 永遠不執行 ——
     * 而那掩蓋了一整類 bug。
     *
     * <p>所以改成「每個測試前清空」。慢一點，但測的是真的行為。
     */
    @BeforeEach
    void 清空資料() {
        jdbcTemplate.execute("SET FOREIGN_KEY_CHECKS = 0");
        for (String table : TABLES_IN_DELETE_ORDER) {
            jdbcTemplate.execute("TRUNCATE TABLE " + table);
        }
        jdbcTemplate.execute("SET FOREIGN_KEY_CHECKS = 1");
        redisTemplate.getConnectionFactory().getConnection().serverCommands().flushDb();
    }
}
```

**`AFTER_COMMIT` 的測試（7.2.4 的正確版本）**：

```java
class ShippingAddressChangeIntegrationTest extends InfrastructureIntegrationTest {

    @Autowired TestRestTemplate rest;
    @MockitoBean MailSender mailSender;        // ★ 郵件還是 mock（不要真的寄）

    @Test
    void 修改地址會在交易提交後寄通知信() {
        String orderId = 建立一張已付款的訂單();

        var response = rest.exchange(
                "/orders/{id}/shipping-address", HttpMethod.PATCH,
                authEntity(Actors.客服(), """
                        {"recipientName":"王小明","phone":"0912345678",
                         "postalCode":"10041","line1":"台北市中正區重慶南路一段 122 號",
                         "reason":"客戶來電要求"}
                        """),
                String.class, orderId);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);

        // ★★ 關鍵：AFTER_COMMIT 的 listener 是**非同步**的（00 章 0.6.6）
        //    所以要 await，不能立刻 verify
        await().atMost(Duration.ofSeconds(5))
                .as("""
                    交易提交後沒有寄出地址變更通知信。

                    ★ 三個可能的原因（7.2.4 的三個 bug）：
                      1. 測試用了 @Transactional → 永遠不 commit
                         → AFTER_COMMIT 不執行
                         （這個測試沒用，所以不是這個）
                      2. 事件是在 @Transactional 方法**外面**發布的
                         → @TransactionalEventListener 靜默忽略它
                         （fallbackExecution 預設 false）
                      3. listener 拋了例外而被吞掉
                         → 檢查 log 裡有沒有 ERROR

                    ⚠️ 原因 2 最難查，因為沒有任何錯誤訊息。
                       診斷方法：把 fallbackExecution 暫時設 true，
                       如果信寄出來了，就是原因 2。
                    """)
                .untilAsserted(() -> verify(mailSender).send(argThat(m ->
                        m.getTo().contains("customer@example.com")
                        && m.getSubject().contains("收件地址已變更"))));

        // ★ 而且稽核紀錄要在同一個交易裡（所以現在一定看得到）
        assertThat(auditRepository.findByResourceId(orderId))
                .as("稽核紀錄應該與地址變更在同一個交易 —— 它現在應該已經存在")
                .hasSize(1);
    }
}
```

⚠️ **`await().untilAsserted(...)` 與 `await().until(...)` 的差別**：

```java
// until：條件回傳 boolean
await().until(() -> received.size() >= 3);

// untilAsserted：★ 裡面可以放斷言（含 Mockito 的 verify）
//   → 逾時的時候，失敗訊息是**最後一次斷言的失敗訊息**，
//     而不是「條件不滿足」
await().untilAsserted(() -> verify(mailSender).send(any()));
```

**`untilAsserted` 的失敗訊息好得多**：

```
org.awaitility.core.ConditionTimeoutException:
Assertion condition defined as a lambda expression ...
Wanted but not invoked:
mailSender.send(<any>);
Actually, there were zero interactions with this mock.
within 5 seconds.
```

---
## 7.12 測試的反模式

**這一節的每一個反模式都有三段**：壞的寫法、為什麼壞、好的寫法。

### 7.12.1 只斷言狀態碼

```java
// 🔴 壞
@Test
void 查詢訂單列表() throws Exception {
    mockMvc.perform(get("/orders")).andExpect(status().isOk());
}
```

**為什麼壞**：7.2.3 的事故。`status().isOk()` 在
「body 是空的」「body 是 `{}`」「body 少了一半欄位」時**全部通過**。

```java
// ✅ 好
@Test
void 查詢訂單列表() throws Exception {
    when(orderQueryService.list(any())).thenReturn(PageFixtures.兩筆訂單());

    mockMvc.perform(get("/orders?page=1&size=20").with(Auth.as(Actors.客戶())))
            .andExpect(status().isOk())
            .andExpect(ResponseMatchers.hasNonEmptyJsonObject())     // 7.6.3
            .andExpect(jsonPath("$.content", hasSize(2)))
            .andExpect(jsonPath("$.content[0].orderId").value("ord_01J5GKA1"))
            .andExpect(jsonPath("$.content[0].statusLabel").value("已付款"))
            .andExpect(jsonPath("$.pageInfo.page").value(1))
            .andExpect(jsonPath("$.pageInfo.size").value(20))
            .andExpect(jsonPath("$.pageInfo.totalElements").value(2));
}
```

**一個可以放進 CI 的檢查**：

```bash
#!/usr/bin/env bash
# scripts/check-assertion-quality.sh
#
# 找出「只有 status() 斷言」的 MockMvc 測試。
#
# ★ 這是一個啟發式檢查，會有誤報 ——
#   204 No Content、304、HEAD 的測試本來就只有狀態碼。
#   誤報的處理方式是加 // NOSONAR-status-only 註解並說明理由。
set -euo pipefail

echo "檢查「只斷言狀態碼」的測試..."

# 找出 mockMvc.perform(...) 之後只接一個 andExpect(status()...) 就結束的區塊
FOUND=$(awk '
  /mockMvc\.perform|performExpectingBody/ { block=""; inBlock=1 }
  inBlock { block = block $0 "\n" }
  inBlock && /;[[:space:]]*$/ {
      inBlock=0
      n = gsub(/andExpect/, "andExpect", block)
      if (n == 1 && block ~ /status\(\)/ && block !~ /NOSONAR-status-only/) {
          printf "%s:%d\n", FILENAME, NR
      }
  }
' $(find src/test/java -name '*Test.java') || true)

if [[ -n "$FOUND" ]]; then
  cat <<MSG

⚠️ 這些測試只斷言了狀態碼：

$FOUND

status().isOk() 不是斷言，是「有東西值得斷言」的前提（07 章 7.12.1）。

如果這個測試真的只該檢查狀態碼（204、304、HEAD），
在那一行加上：
    // NOSONAR-status-only：204 沒有 body
MSG
  exit 1
fi
```

### 7.12.2 在測試裡重新實作被測邏輯

```java
// 🔴 壞（7.2.5）
.andExpect(jsonPath("$.totalAmount")
        .value(MoneyFormat.format(new BigDecimal("1280.50"), "TWD")))

// 🔴 也壞：用同樣的邏輯算期望值
int expectedTotal = items.stream()
        .mapToInt(i -> i.quantity() * i.unitPrice())    // 這正是被測的計算
        .sum();
.andExpect(jsonPath("$.totalAmount").value(String.valueOf(expectedTotal)))

// 🔴 更隱晦的版本：用被測的 enum 產生期望值
.andExpect(jsonPath("$.statusLabel")
        .value(statusLabelResolver.resolve(OrderStatus.PAID, Locale.TAIWAN)))
```

**為什麼壞**：期望值與實際值來自同一份程式碼 ——
**那份程式碼壞掉時，兩邊會一起壞，測試仍然是綠的**。

```java
// ✅ 好：期望值是人寫下來的字面值
.andExpect(jsonPath("$.totalAmount").value("1280.50"))
.andExpect(jsonPath("$.statusLabel").value("已付款"))
```

⚠️ **「但是幣別有 12 種，我不想寫 12 個字面值」** ——
那正是參數化測試的用途：

```java
@ParameterizedTest(name = "{0} {1} → {2}")
@CsvSource({
        // ★ 期望值來自 06 章 6.5.7 的 FRACTION_DIGITS 那張表，不是憑印象
        "TWD, 1280.50, 1280.50",     // 台幣 2 位
        "TWD, 1280.5,  1280.50",     // ★ 補零
        "TWD, 1280.005, 1280.01",    // ★ HALF_UP（不是 HALF_EVEN，那會是 1280.00）
        "TWD, 1280.004, 1280.00",
        "USD, 1280.50, 1280.50",     // 美元 2 位
        "JPY, 1280.00, 1280",        // ★ 日圓 0 位 —— 這一列證明「小數位數依幣別而異」
        "JPY, 1280.50, 1281",        // ★ HALF_UP 到整數
        "KRW, 1280.49, 1280",        // 韓元 0 位
        "KWD, 1280.5,  1280.500",    // ★ 科威特第納爾 3 位
})
void 各幣別的金額格式(String currency, String raw, String expected) {
    assertThat(MoneyFormat.format(new BigDecimal(raw), currency))
            .isEqualTo(expected);
}

/**
 * ★ 而「未註冊的幣別」也要有一個測試 ——
 * 06 章 6.5.7 刻意選擇「拋例外而不是猜」，那個決定需要一個守門人。
 */
@Test
void 未支援的幣別拋例外() {
    // ⚠️ BHD（巴林第納爾，3 位小數）刻意不在 FRACTION_DIGITS 裡 ——
    //    它是「我們還沒支援的幣別」的代表
    assertThatThrownBy(() -> MoneyFormat.format(new BigDecimal("1280.5"), "BHD"))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("不支援的幣別");
}
```

**十行字面值，覆蓋了 06 章 6.5.7 的全部決定**
（每個幣別的小數位數、`HALF_UP` 的方向、補零、未支援的幣別）。
而這是 ① 純單元測試，0.05 ms。

⚠️ **注意 `TWD, 1280.005 → 1280.01` 那一列**：它是唯一能區分
`HALF_UP` 與 `HALF_EVEN`（銀行家捨入）的案例。
**沒有它的話，有人把捨入模式改成 `HALF_EVEN` 這個測試不會紅** ——
而那會讓每個月的對帳差幾塊錢。

### 7.12.3 一個測試檢查十件事

```java
// 🔴 壞
@Test
void 下單流程() throws Exception {
    // 建立
    var result = mockMvc.perform(post("/orders")...).andExpect(status().isCreated())
            .andReturn();
    String orderId = JsonPath.read(result.getResponse().getContentAsString(), "$.orderId");

    // 查詢
    mockMvc.perform(get("/orders/" + orderId)).andExpect(status().isOk());

    // 付款
    mockMvc.perform(post("/orders/" + orderId + "/payments")...)
            .andExpect(status().isCreated());

    // 取消（應該失敗）
    mockMvc.perform(post("/orders/" + orderId + "/cancellations")...)
            .andExpect(status().isConflict());

    // 退款
    mockMvc.perform(post("/orders/" + orderId + "/refunds")...)
            .andExpect(status().isCreated());
}
```

**三個問題**：

| 問題 | 具體 |
|---|---|
| **失敗訊息沒有資訊** | 「第 4 個 perform 失敗」—— 但你不知道是「取消的規則錯了」還是「前面的付款沒成功」 |
| **前面失敗就看不到後面** | 一次只能修一個問題 |
| **測試名字說謊** | 叫「下單流程」，實際上測了 5 件事 |

```java
// ✅ 好：用 @Nested + @TestMethodOrder 表達「有順序的情境」
@Nested
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
@DisplayName("訂單的生命週期")
class 訂單生命週期 {

    private static String orderId;

    @Test @Order(1)
    @DisplayName("① 下單回 201 與 Location")
    void 下單() throws Exception {
        var result = mockMvc.perform(post("/orders")...)
                .andExpect(status().isCreated())
                .andExpect(header().string("Location", matchesPattern("/orders/ord_[0-9A-Z]{26}")))
                .andExpect(jsonPath("$.status").value("PENDING_PAYMENT"))
                .andReturn();
        orderId = JsonPath.read(result.getResponse().getContentAsString(UTF_8), "$.orderId");
    }

    @Test @Order(2)
    @DisplayName("② 付款後狀態變成 PAID")
    void 付款() throws Exception { ... }

    @Test @Order(3)
    @DisplayName("③ ★ 已付款的訂單不可取消，且要帶 alternativeAction")
    void 已付款不可取消() throws Exception {
        mockMvc.perform(post("/orders/" + orderId + "/cancellations")...)
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("ORDER_NOT_CANCELLABLE"))
                .andExpect(jsonPath("$.currentStatus").value("PAID"))
                // ★ 03 章 3.7.3：告訴客戶端「那你可以做什麼」
                .andExpect(jsonPath("$.alternativeAction.code").value("REQUEST_RETURN"));
    }
}
```

⚠️ **`@TestMethodOrder` + `static` 欄位是一個「刻意的例外」。**
一般規則是「測試之間不可以有相依性」，
而**有順序的情境測試**是唯一合理的例外 ——
但要用 `@Nested` 明確框出範圍，並在 `@DisplayName` 標上編號。

### 7.12.4 用 `@Transactional` 讓測試自動回滾

```java
// 🔴 壞（7.2.4）
@SpringBootTest
@AutoConfigureMockMvc
@Transactional          // ← 「這樣就不用清資料了」
class SomeIntegrationTest { ... }
```

**為什麼壞 —— 四個被掩蓋的行為**：

| 被掩蓋的 | 具體 |
|---|---|
| **`AFTER_COMMIT` 事件** | 7.2.4 |
| **真正的交易邊界** | Service 裡的 `REQUIRES_NEW` 在測試的外層交易裡行為不同 |
| **資料庫的約束** | 延遲檢查的 UNIQUE、外鍵在 commit 時才報錯 |
| **多執行緒看得到嗎** | 非同步的 listener 看不到未提交的資料 → 而測試裡看得到 |

**★ 第四點最陰險**：

```java
@Test
@Transactional
void 下單後非同步扣庫存() {
    mockMvc.perform(post("/orders")...);
    // 非同步的 listener 在另一個執行緒查資料庫 → 看不到未提交的訂單
    // → 它靜默失敗 → 而測試不知道
}
```

```java
// ✅ 好：不用 @Transactional，改成明確清理
@BeforeEach
void 清空資料() { /* 7.11.6 的 TRUNCATE */ }
```

⚠️ **「但 TRUNCATE 很慢」** —— 實測數字：

```
@Transactional 回滾：        ~2 ms
TRUNCATE 12 張表：           ~18 ms
差 16 ms × 200 個整合測試 = 3.2 秒
```

**3.2 秒換「測到真的交易行為」，值得。**

**★ 一個例外**：純粹的 Repository 測試（`@DataJpaTest`）
用 `@Transactional` 是**對的** —— 因為那一層本來就不涉及交易提交後的行為。

### 7.12.5 `verifyNoMoreInteractions`

```java
// 🔴 壞
verify(orderService).create(any());
verifyNoMoreInteractions(orderService);
```

**為什麼壞**：它把「實作剛好呼叫了哪些方法」變成契約。

```java
// 有人加了一行合理的程式碼
public ResponseEntity<CreateOrderResponse> create(...) {
    var command = mapper.toCommand(request, actor, key);
    orderService.validateQuota(actor);            // ← 新增：檢查配額
    var order = orderService.create(command);
    ...
}
// → 🔴 verifyNoMoreInteractions 紅燈，而行為完全正確
```

```java
// ✅ 好：只驗證你在意的互動
verify(orderService).create(argThat(cmd -> cmd.actor() != null));

// ✅ 好：明確表達「不該發生的事」
verify(paymentService, never()).charge(any());
verifyNoInteractions(refundService);
```

### 7.12.6 `any()` 到處用

```java
// 🔴 壞
when(orderQueryService.findDetail(any(), any())).thenReturn(sampleDetail());
mockMvc.perform(get("/orders/ord_01J5GKA1"))
        .andExpect(jsonPath("$.orderId").value("ord_01J5GKA1"));
```

**為什麼壞**：`any()` 讓 mock 對**任何** ID 都回傳同一筆資料 ——
所以這個測試在「Controller 把 orderId 傳錯」時**仍然通過**。

```java
// ✅ 好：明確的參數
when(orderQueryService.findDetail(eq("ord_01J5GKA1"), any(Actor.class)))
        .thenReturn(sampleDetail());
```

⚠️ **這樣做的額外好處**：如果 Controller 傳錯 ID，
mock 回傳 `null` → 7.6.3 的 `hasNonEmptyBody` 立刻紅燈，
**而失敗訊息會提示「檢查 stub 的參數」**。

**什麼時候 `any()` 是對的**：

| 情況 | |
|---|---|
| 那個參數與這個測試無關（`any(Actor.class)`，而測試在測序列化） | ✅ |
| 參數是「無法預先知道」的（產生的 ID、時間戳） | ✅ |
| **參數正是這個測試在驗證的東西** | 🔴 用 `eq()` 或 `argThat()` |

### 7.12.7 測試名字說「做了什麼」而不是「該怎樣」

```java
// 🔴 壞
void testCreateOrder()
void 測試下單()
void createOrderTest()
void test1()

// ✅ 好：名字是一句「規則」
void 庫存不足時回409並帶上可購買數量()
void 已出貨的訂單不可取消()
void 客戶不可查詢別人的訂單()
void 未知的enum值不會讓App崩潰()
```

**判準：讀測試名字，能不能推出「這個系統的一條規則」？**

⚠️ 而 shop-service 用中文方法名是刻意的：

| | 中文方法名 | 英文方法名 |
|---|---|---|
| 表達規則 | ✅ 精確（「不可」vs「不應」） | ⚠️ `shouldNotAllowCancellationOfShippedOrders` 又長又難讀 |
| CI 報表 | ✅ 直接可讀 | 需要 `@DisplayName` 才可讀 |
| 相容性 | ⚠️ 少數工具對非 ASCII 方法名有問題 | ✅ |

**⚠️ 一個真實的相容性問題**：某些 Maven Surefire 版本在
Windows 上的預設編碼（Big5 / GBK）會讓中文方法名在報表裡變亂碼。

**修法**（必須設，7.13.2 的 `pom.xml` 有完整版）：

```xml
<properties>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    <project.reporting.outputEncoding>UTF-8</project.reporting.outputEncoding>
</properties>
<configuration>
    <argLine>-Dfile.encoding=UTF-8</argLine>
</configuration>
```

### 7.12.8 用 `Thread.sleep()` 等非同步

```java
// 🔴 壞
mockMvc.perform(post("/orders/exports")...);
Thread.sleep(3000);                                  // 「應該夠了吧」
assertThat(exportRepository.findAll()).hasSize(1);
```

**兩個問題**：慢（永遠等 3 秒）、且**不可靠**（CI 慢的時候 3 秒不夠 → flaky）。

```java
// ✅ 好
await().atMost(Duration.ofSeconds(10))
        .pollInterval(Duration.ofMillis(50))
        .untilAsserted(() -> assertThat(exportRepository.findAll()).hasSize(1));
```

### 7.12.9 依賴測試的執行順序（而沒有明說）

```java
// 🔴 壞
@Test void a_建立訂單() { orderId = ...; }     // static 欄位
@Test void b_查詢訂單() { get("/orders/" + orderId); }
//   ↑ 依賴 JUnit 的預設順序（是「確定性但未指定」的）
```

⚠️ **JUnit 5 的預設方法順序是「確定性的但刻意不公開」** ——
它可能隨版本改變。而且 7.13.3 開啟平行執行之後，
**同一個類別的方法可能同時跑**。

```java
// ✅ 好：明確宣告
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
@Execution(ExecutionMode.SAME_THREAD)      // ★ 這個類別不平行
class 訂單生命週期 { ... }
```

### 7.12.10 斷言失敗訊息裡放敏感資料

```java
// 🔴 壞
assertThat(responseBody)
        .as("回應含有信用卡號：%s", responseBody)      // 🔴 整個 body 進 CI log
        .doesNotContain(cardNumber);
```

**為什麼壞**：CI 的 log 通常保存 90 天、可能對整個組織可見，
**而測試失敗訊息會把敏感值印出來** —— 這正是這個測試想防的事。

```java
// ✅ 好（06 章 6.10.2 的做法）
assertThat(responseBody)
        .as("""
            回應含有疑似信用卡號的內容。

            ⚠️ 這裡刻意不印出找到的值 ——
               把它印進 CI log 正是這個測試想防的事。

            除錯方式：在本機重跑這個測試，加上
              -Dshop.test.print-sensitive=true
            """)
        .doesNotContainPattern("\\b\\d{13,19}\\b");
```

### 7.12.11 mock 掉 filter

7.4.4 已經詳述。**症狀：所有測試變成 200 + 空 body。**

### 7.12.12 「這個測試偶爾會失敗，重跑就好」

**這句話出現時，你已經失去了那個測試的價值。**

**因為一旦團隊習慣「重跑」，真正的失敗也會被重跑掉。**

**flaky 的五個常見原因與對策**（7.13.4 有完整版）：

| 原因 | 對策 |
|---|---|
| `Thread.sleep` | `await()`（7.12.8） |
| 時間（`Instant.now()`） | 固定 `Clock`（7.4.4） |
| 測試順序相依 | 明確宣告或移除相依（7.12.9） |
| `ThreadLocal` 沒清 | `@AfterEach` 清（7.4.3、7.9.3） |
| 共用的有狀態替身 | 每個測試用不同的 key（7.6.2 修法 A） |

---

## 7.13 CI 的組織：3,000 個測試，4 分鐘

### 7.13.1 測試分層與標籤

```java
package example.shop.test;

/**
 * 測試的分類標籤。
 *
 * <p>★ 為什麼要分類：不同的測試有不同的「該多常跑」。
 *    把它們混在一起，結果是「最慢的那一組決定了所有人的迭代速度」。
 */
public final class Tags {

    private Tags() {}

    /** ① 純單元測試 —— 每次存檔都可以跑。 */
    public static final String UNIT = "unit";

    /** ③ @WebMvcTest 切片 —— 每次 push 跑。 */
    public static final String SLICE = "slice";

    /** ④ @SpringBootTest —— 每次 push 跑（但在另一個 job）。 */
    public static final String INTEGRATION = "integration";

    /** ④′ 需要 Testcontainers —— 每次 push 跑（最慢的 job）。 */
    public static final String INFRA = "infra";

    /** 契約測試 —— 每次 push 跑，失敗要 block merge。 */
    public static final String CONTRACT = "contract";

    /** ★ 安全性測試（授權矩陣、IDOR、JSON 炸彈）—— 每次 push 跑。 */
    public static final String SECURITY = "security";

    /** 產生文件/範例 —— 只在 release 跑。 */
    public static final String DOCS = "docs";

    /** 慢的探索性測試（模糊測試、大量資料）—— nightly。 */
    public static final String NIGHTLY = "nightly";
}
```

**標在基底類別上，讓子類別自動繼承**：

```java
@Tag(Tags.SLICE)
@WebMvcTest
@Import(WebSliceInfraConfig.class)
public abstract class WebSliceTest { ... }

@Tag(Tags.INFRA)
@SpringBootTest(webEnvironment = RANDOM_PORT)
@Testcontainers
public abstract class InfrastructureIntegrationTest { ... }
```

⚠️ **`@Tag` 在父類別上會被子類別繼承**（JUnit 5 的 `@Tag` 是 `@Inherited` 的效果，
因為它由 `TestTag` 的解析器沿著類別階層收集）。
**這讓「忘記標 tag」變成不可能** —— 只要繼承對的基底類別。

**一個守門測試**：

```java
@Test
void 每個測試類別都有tag() {
    var untagged = new ClassFileImporter()
            .withImportOption(ImportOption.Predefined.ONLY_INCLUDE_TESTS)
            .importPackages("example.shop")
            .stream()
            .filter(c -> c.getMethods().stream().anyMatch(
                    m -> m.isAnnotatedWith(org.junit.jupiter.api.Test.class)
                      || m.isAnnotatedWith(
                              org.junit.jupiter.params.ParameterizedTest.class)))
            .filter(c -> collectTags(c).isEmpty())
            .map(JavaClass::getFullName)
            .collect(Collectors.toCollection(TreeSet::new));

    assertThat(untagged)
            .as("""
                這些測試類別沒有 @Tag：%s

                沒有 tag 的測試不會被任何 CI job 跑到（7.13.2 的
                Surefire 設定是「明確列出要跑的 group」）——
                也就是說**它們從來沒有執行過**。

                修法：繼承對的基底類別
                  · 純單元測試 → 直接 @Tag(Tags.UNIT)
                  · Web 切片   → extends WebSliceTest
                  · 整合       → extends InfrastructureIntegrationTest
                """, untagged)
            .isEmpty();
}
```

⚠️ **「沒 tag 的測試從來沒跑過」是一個真實而且很常見的問題** ——
它的症狀是「覆蓋率莫名其妙地低」。

### 7.13.2 Maven 的設定

```xml
<properties>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    <project.reporting.outputEncoding>UTF-8</project.reporting.outputEncoding>
    <maven.compiler.release>21</maven.compiler.release>

    <!-- ★ 預設跑什麼（本機 mvn test）-->
    <test.groups>unit,slice,contract</test.groups>
</properties>

<build>
<plugins>
    <!-- ① Surefire：快的測試 -->
    <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-surefire-plugin</artifactId>
        <version>3.2.5</version>
        <configuration>
            <groups>${test.groups}</groups>

            <!-- ★★ 平行執行的三個設定 -->
            <!-- forkCount=1C：每個 CPU 核心一個 JVM -->
            <forkCount>1C</forkCount>
            <!-- ⚠️ reuseForks=true 很重要 —— false 的話每個測試類別
                 重啟 JVM，Spring context 快取完全失效 -->
            <reuseForks>true</reuseForks>

            <argLine>
                @{argLine}
                -Dfile.encoding=UTF-8
                -Duser.timezone=UTC
                -XX:+EnableDynamicAgentLoading
                -Xshare:auto
            </argLine>

            <!-- ★ 讓 context 快取的統計進 log（7.4.5 的診斷）-->
            <systemPropertyVariables>
                <logging.level.org.springframework.test.context.cache>DEBUG</logging.level.org.springframework.test.context.cache>
            </systemPropertyVariables>

            <!-- ⚠️ 不要用 rerunFailingTestsCount —— 見 7.13.4 -->
        </configuration>
    </plugin>

    <!-- ② Failsafe：慢的整合測試（*IT.java 或 tag）-->
    <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-failsafe-plugin</artifactId>
        <version>3.2.5</version>
        <configuration>
            <groups>integration,infra,security</groups>
            <forkCount>1</forkCount>       <!-- ★ Testcontainers 不要多 fork -->
            <reuseForks>true</reuseForks>
        </configuration>
        <executions>
            <execution>
                <goals>
                    <goal>integration-test</goal>
                    <goal>verify</goal>
                </goals>
            </execution>
        </executions>
    </plugin>

    <!-- ③ Jacoco -->
    <plugin>
        <groupId>org.jacoco</groupId>
        <artifactId>jacoco-maven-plugin</artifactId>
        <version>0.8.12</version>
        <executions>
            <execution>
                <id>prepare-agent</id>
                <goals><goal>prepare-agent</goal></goals>
            </execution>
            <execution>
                <id>check</id>
                <phase>verify</phase>
                <goals><goal>check</goal></goals>
                <configuration>
                    <rules>
                        <!-- ★ 見 7.13.5 的討論 -->
                        <rule>
                            <element>PACKAGE</element>
                            <includes>
                                <include>example.shop.*.web</include>
                                <include>example.shop.common.web.*</include>
                            </includes>
                            <limits>
                                <limit>
                                    <counter>BRANCH</counter>
                                    <value>COVEREDRATIO</value>
                                    <minimum>0.75</minimum>
                                </limit>
                            </limits>
                        </rule>
                    </rules>
                </configuration>
            </execution>
        </executions>
    </plugin>
</plugins>
</build>

<profiles>
    <!-- ★ 兩個 Boot 版本的相容 profile（7.6.1 的修正）-->
    <profile>
        <id>boot-3.2</id>
        <activation><activeByDefault>true</activeByDefault></activation>
        <properties>
            <spring-boot.version>3.2.5</spring-boot.version>
        </properties>
        <build><plugins><plugin>
            <artifactId>maven-compiler-plugin</artifactId>
            <configuration>
                <!-- ★ @MockitoBean 不存在 → 排除用到它的測試支援類別，
                     改用 @MockBean 的版本 -->
                <testExcludes>
                    <testExclude>**/mockito62/**</testExclude>
                </testExcludes>
            </configuration>
        </plugin></plugins></build>
    </profile>
    <profile>
        <id>boot-3.4</id>
        <properties>
            <spring-boot.version>3.4.0</spring-boot.version>
        </properties>
        <build><plugins><plugin>
            <artifactId>maven-compiler-plugin</artifactId>
            <configuration>
                <testExcludes>
                    <testExclude>**/mockito61/**</testExclude>
                </testExcludes>
            </configuration>
        </plugin></plugins></build>
    </profile>
</profiles>
```

⚠️ **`@{argLine}` 那個寫法很重要。**
Jacoco 的 `prepare-agent` 會把 agent 參數放進一個叫 `argLine` 的 property，
而如果你直接寫 `<argLine>-Dfile.encoding=UTF-8</argLine>`，
**會把 Jacoco 的設定覆蓋掉 → 覆蓋率永遠是 0%**。

`@{argLine}` 是 Maven 的「延遲求值」語法，它會把原本的值展開進去。

**這是一個典型的「靜默失效」** —— 沒有錯誤訊息，只是覆蓋率報告全是 0。

**JUnit 平行執行的設定**（`src/test/resources/junit-platform.properties`）：

```properties
# ★★ 平行執行 —— 這是 47 分鐘變 4 分鐘的第二個關鍵
#    （第一個是 context 數量，7.4.5）
junit.jupiter.execution.parallel.enabled = true

# ★ 類別之間平行
junit.jupiter.execution.parallel.mode.classes.default = concurrent

# ⚠️ 類別**內部**的方法用同一個執行緒
#
# 為什麼：@MockitoBean 的 mock 是 context 層級共用的。
#         同一個類別的兩個方法同時跑 → 它們共用同一份 mock
#         → stub 互相覆蓋 → 隨機失敗。
#
# ★ 這是「平行執行」最容易出錯的一個設定。
junit.jupiter.execution.parallel.mode.default = same_thread

# 執行緒數 = CPU 核心數
junit.jupiter.execution.parallel.config.strategy = dynamic
junit.jupiter.execution.parallel.config.dynamic.factor = 1

# ★ 讓 @DisplayName 之外的名字也可讀（中文方法名）
junit.jupiter.displayname.generator.default = \
  org.junit.jupiter.api.DisplayNameGenerator$ReplaceUnderscores
```

> ### ⚠️⚠️ 但「類別之間平行」與 7.4.5 的「共用一個 context」會打架 ★★
>
> 7.4.5 的整個重點是「讓所有切片測試共用**同一個** context」——
> 而 `@MockitoBean` 的 mock **屬於 context**。
>
> **所以「不同類別」與「同一個類別的不同方法」共用的是同一批 mock 物件**：
>
> ```
> context #1（60 個切片測試類別共用）
>   └─ orderService（一個 Mockito mock 實例）
>
> 執行緒 A：OrderControllerTest.查詢訂單
>            when(orderService.findDetail(...)).thenReturn(已付款的訂單())
> 執行緒 B：OrderCancelControllerTest.取消訂單          ← 同時跑
>            when(orderService.findDetail(...)).thenReturn(已出貨的訂單())
>            ↑ 覆蓋了 A 的 stub
>
> 而且 MockitoTestExecutionListener 在【每個測試方法之後】reset ——
> B 結束時會把 A 的 stub 一起清掉。
> ```
>
> **症狀**：本機（核心多、排程鬆）幾乎不發生；CI（2 核心）偶發失敗，
> 而且失敗的測試每次不一樣 —— **7.13.4 說的那種 flaky。**
>
> **三個選擇（shop-service 選 B）**：
>
> | 選擇 | 做法 | 取捨 |
> |---|---|---|
> | A. 只在類別內部平行 | `mode.classes.default = same_thread`<br>`mode.default = concurrent` | 🔴 更糟 —— 同一個類別的方法共用 mock 的機率更高 |
> | **B. 切片測試不平行，其他平行** ★ | 在 `WebSliceTest` 上標 `@Execution(SAME_THREAD)`，並靠 **`forkCount=1C`（多個 JVM）**取得平行度 | ✅ 每個 fork 有自己的 context 與自己的 mock，天然隔離 |
> | C. 每個類別自己的 context | 回到 7.4.5 之前的狀態 | 🔴 89 個 context |
>
> **B 的具體設定**：
>
> ```java
> // ★ 標在基底類別上，所有子類別繼承
> @Tag(Tags.SLICE)
> @WebMvcTest
> @Import(WebSliceInfraConfig.class)
> @org.junit.jupiter.api.parallel.Execution(
>         org.junit.jupiter.api.parallel.ExecutionMode.SAME_THREAD)
> public abstract class WebSliceTest { ... }
> ```
>
> ```properties
> # 類別之間預設平行（純單元測試、ArchUnit 測試因此受益）
> junit.jupiter.execution.parallel.mode.classes.default = concurrent
> # 方法一律同執行緒
> junit.jupiter.execution.parallel.mode.default = same_thread
> ```
>
> **★ 平行度從哪裡來？Surefire 的 `forkCount=1C`。**
> 每個 fork 是一個獨立的 JVM → 獨立的 Spring context → 獨立的 mock。
> 8 核心 = 8 個 fork = 8 份 context（而不是 89 份），
> **既有平行度、又沒有共用 mock 的問題**。
>
> ⚠️ **代價**：context 從 6 個變成「6 × fork 數」。
> 7.4.5 的 `check-context-count.sh` 要把預算乘上 fork 數 ——
> 而那個腳本讀的是單一 fork 的 log，所以實務上不用改。
>
> **★ 純單元測試（① 層）可以放心開類別內平行**（它們沒有共用狀態）：
>
> ```java
> @Execution(ExecutionMode.CONCURRENT)
> class MoneyFormatTest { ... }
> ```

**想讓某個類別內部也平行**（例如純單元測試）：

```java
@Execution(ExecutionMode.CONCURRENT)
class MoneyFormatTest { ... }        // ★ 沒有共用狀態，可以
```

**想讓某個類別完全不平行**：

```java
@Execution(ExecutionMode.SAME_THREAD)
@Isolated                            // ★ 更強：它跑的時候沒有別人在跑
class 限流的整合測試 { ... }
```

⚠️ **`@Isolated` 用在「會影響全域狀態」的測試上** ——
例如「把限流的上限調到 1 然後打 2 次」。
**它很貴（整個平行執行停下來等它），所以要少用。**

### 7.13.3 47 分鐘 → 4 分鐘：完整的帳

**起點（7.2.2 的狀態）**：

```
2,840 個測試
89 個 Spring context
單一 JVM、序列執行
總時間：47 分鐘
```

**六個改動與各自的效益**：

| # | 改動 | 節省 | 累計 |
|---|---|---|---|
| — | 起點 | — | **47:00** |
| 1 | **統一基底類別，context 89 → 6**（7.4.5） | −18:30 | 28:30 |
| 2 | **測試分層 + 分成 3 個 CI job 平行跑**（7.13.1） | −13:00 | 15:30 |
| 3 | **JUnit 平行執行**（`forkCount=1C`）（7.13.2） | −8:20 | 07:10 |
| 4 | **`Thread.sleep` → `await()`**（7.12.8，找到 41 處） | −2:10 | 05:00 |
| 5 | **Testcontainers 容器 static + reuse**（7.11.6） | −0:45 | 04:15 |
| 6 | **移除 34 個「只斷言 200」的無效測試**（7.12.1） | −0:12 | **04:03** |

⚠️ **注意 6 只省了 12 秒。**
「測試太多所以要刪」這個直覺，在這張表裡是**最沒有效益**的一項。

**CI 的 job 切分**（GitHub Actions）：

```yaml
name: CI
on: [push, pull_request]

jobs:
  # ── job 1：快的測試（1 分 10 秒）────────────────────────
  fast:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          java-version: '21'
          distribution: 'temurin'
          cache: maven
      - name: 單元測試 + 切片測試 + 契約測試
        run: ./mvnw -B test -Dtest.groups=unit,slice,contract
      - name: ★ 檢查 Spring context 的數量（7.4.5）
        run: ./scripts/check-context-count.sh
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: surefire-fast
          path: target/surefire-reports/

  # ── job 2：安全性測試（1 分 40 秒）★ 獨立一個 job ────────
  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with: { java-version: '21', distribution: 'temurin', cache: maven }
      - name: 授權矩陣 + IDOR + JSON 炸彈
        run: ./mvnw -B verify -Dtest.groups=security -DskipTests=false
      # ★ 為什麼獨立一個 job：
      #   1. 它的失敗必須非常顯眼（不要淹沒在 3,000 個測試的報表裡）
      #   2. 它是 branch protection 的必要檢查
      #   3. 它與其他 job 平行 → 不增加總時間

  # ── job 3：整合測試（4 分 03 秒 ← 決定總時間的那一個）──
  integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with: { java-version: '21', distribution: 'temurin', cache: maven }
      - name: ★ 預先拉容器映像（與編譯平行）
        run: |
          docker pull mysql:8.4 &
          docker pull redis:7.4-alpine &
          wait
      - name: 整合測試
        run: ./mvnw -B verify -Dtest.groups=integration,infra
        env:
          TESTCONTAINERS_RYUK_DISABLED: 'true'   # CI 上不需要清理容器

  # ── job 4：靜態檢查（35 秒）────────────────────────────
  checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: 腳本檢查
        run: |
          ./scripts/check-dto-logging.sh        # 06 章 6.6.2
          ./scripts/check-assertion-quality.sh  # 07 章 7.12.1
          ./scripts/cors-check.sh --dry-run     # 06 章 6.3.9
```

**★ 三個「不明顯但很有效」的加速技巧**：

**① 預先拉容器映像，與編譯平行。**
`docker pull mysql:8.4` 在 CI 上約 25 秒 ——
放在編譯之前用 `&` 背景執行，等於免費。

**② Spring 的 AOT / CDS。**

```xml
<argLine>-Xshare:auto -XX:SharedArchiveFile=target/app.jsa</argLine>
```

Class Data Sharing 可以省下 10～15% 的 JVM 啟動時間。
**對「6 個 context × 每個 2 秒」來說約省 2 秒** —— 邊際效益不大，但免費。

**③ 「只跑受影響的測試」—— 慎用。**

```bash
# ⚠️ 這類工具（Maven 的 incremental、Gradle 的 test filtering）
#    對「設定改動」的影響分析通常不準 ——
#    改一行 application.yml 可能影響所有測試，但工具看不出來。
#
# shop-service 的做法：本機用它，CI 不用。
```

### 7.13.4 flaky 測試的處理

**先講一個絕對不要做的事**：

```xml
<!-- 🔴🔴 絕對不要 -->
<configuration>
    <rerunFailingTestsCount>3</rerunFailingTestsCount>
</configuration>
```

**為什麼**：它把「flaky 測試」變成「綠燈」，
於是**沒有人會去修它**，而 flaky 的數量會單調遞增。
**最終 CI 的訊號值變成零。**

**shop-service 的處理流程**：

```
① 發現一個 flaky 測試
       ↓
② 立刻標記 @Tag("flaky") + @Disabled("見 SHOP-1234")
   ★ 關鍵：**同時開一張票**，並在註解裡寫票號
       ↓
③ 票有一個硬性期限：兩週
       ↓
④ 兩週內修好 → 移除標記
   兩週內沒修 → ★ **刪掉那個測試**
```

⚠️ **第 ④ 步的「刪掉」是刻意的。**

理由：一個被 `@Disabled` 兩週以上的測試
**已經沒有在保護任何東西**，而它的存在造成兩個傷害：

- 讓人誤以為那個行為「有測試」。
- 每次有人看到它都要花時間判斷「這個能不能開回來」。

**而如果那個行為真的重要，兩週內一定會有人去修它。**

```java
/**
 * ⚠️ 這個測試不穩定。
 *
 * <p>症狀：約 1/20 的機率在 CI 上失敗，本機從未失敗。
 * <p>已知資訊：失敗時 registry.size() 是 1 而不是 0 ——
 *    看起來是 SSE 的清理有一個時間窗。
 * <p>票號：SHOP-1234
 * <p>期限：2026-09-09（兩週）
 * <p>★ 到期未修就刪掉這個測試，並在票裡記錄「這個行為目前沒有測試保護」。
 */
@Tag("flaky")
@Disabled("SHOP-1234 —— 期限 2026-09-09")
@Test
void 客戶端斷線會被清理() { ... }
```

**一個守門測試，讓期限不會被忘記**：

```java
/**
 * ★ 掃描所有 @Disabled 的測試，檢查它們的期限。
 *
 * <p>這個測試本身是「流程的執行者」——
 * 它讓「兩週期限」從一個口頭約定變成一個會紅燈的規則。
 */
@Test
void 沒有過期的Disabled測試() {
    var expired = new ClassFileImporter()
            .withImportOption(ImportOption.Predefined.ONLY_INCLUDE_TESTS)
            .importPackages("example.shop")
            .stream()
            .flatMap(c -> c.getMethods().stream())
            .filter(m -> m.isAnnotatedWith(org.junit.jupiter.api.Disabled.class))
            .map(m -> new Object() {
                final String name = m.getFullName();
                final String reason = m.getAnnotationOfType(
                        org.junit.jupiter.api.Disabled.class).value();
                final java.time.LocalDate deadline = parseDeadline(reason);
            })
            .filter(x -> x.deadline == null
                      || x.deadline.isBefore(java.time.LocalDate.now(clock)))
            .map(x -> x.name + " —— " + x.reason)
            .collect(Collectors.toCollection(TreeSet::new));

    assertThat(expired)
            .as("""
                這些 @Disabled 的測試已經過期（或沒有寫期限）：

                %s

                ★ shop-service 的規則（07 章 7.13.4）：
                  @Disabled 必須寫 "TICKET —— 期限 yyyy-MM-dd"，
                  期限最多兩週。

                  到期的處理只有兩個選項：
                    (a) 修好它，移除 @Disabled
                    (b) **刪掉它**，並在票裡記錄
                        「這個行為目前沒有測試保護」

                  ⚠️ 沒有第三個選項。長期 @Disabled 的測試
                     不保護任何東西，卻讓人以為有保護。
                """, String.join("\n  ", expired))
            .isEmpty();
}
```

### 7.13.5 覆蓋率該怎麼看

**覆蓋率是一個「找漏洞」的工具，不是一個「品質指標」。**

**三個具體的用法**：

**用法一：看「沒被覆蓋的分支」，不看數字。**

```
example/shop/order/web/OrderController.java
  ✅ create()          100%
  ✅ get()             100%
  ⚠️ list()             67%  ← 去看是哪一個分支
  🔴 export()           23%  ← 這個要處理
```

**用法二：對「不同的 package 設不同的門檻」。**

```xml
<rules>
    <!-- ★ Web 層：分支覆蓋 75%
         理由：Controller 的分支通常是「參數的有無」，
               而那正是最需要測的東西 -->
    <rule>
        <element>PACKAGE</element>
        <includes><include>example.shop.*.web</include></includes>
        <limits><limit>
            <counter>BRANCH</counter><value>COVEREDRATIO</value>
            <minimum>0.75</minimum>
        </limit></limits>
    </rule>

    <!-- ★★ 安全性相關的類別：行覆蓋 95%
         理由：這些是「錯了不會有人發現」的程式碼（03 章 3.3.6） -->
    <rule>
        <element>CLASS</element>
        <includes>
            <include>example.shop.common.upload.SafeFilename</include>
            <include>example.shop.common.upload.ContentTypeDetector</include>
            <include>example.shop.common.upload.SafeZip</include>
            <include>example.shop.common.web.ProblemWriter</include>
            <include>example.shop.common.web.ETags</include>
            <include>example.shop.common.web.CsvWriter</include>
        </includes>
        <limits><limit>
            <counter>LINE</counter><value>COVEREDRATIO</value>
            <minimum>0.95</minimum>
        </limit></limits>
    </rule>

    <!-- DTO / record：不設門檻 -->
    <rule>
        <element>PACKAGE</element>
        <includes><include>example.shop.*.web.dto</include></includes>
        <limits/>
    </rule>
</rules>
```

**用法三：看「趨勢」而不是「絕對值」。**

```bash
# scripts/check-coverage-trend.sh
#
# ★ 覆蓋率不可以下降 —— 但也不強求上升。
#   這個規則比「必須 80%」實用得多：
#   它不會因為一個舊專案的低基準而永遠紅燈，
#   但會擋住「加了新程式碼但沒加測試」。
set -euo pipefail

CURRENT=$(xmllint --xpath \
  'string(//report/counter[@type="BRANCH"]/@covered)' target/site/jacoco/jacoco.xml)
TOTAL=$(xmllint --xpath \
  'string(//report/counter[@type="BRANCH"]/@missed)' target/site/jacoco/jacoco.xml)
RATIO=$(echo "scale=4; $CURRENT / ($CURRENT + $TOTAL)" | bc)

BASELINE=$(cat .coverage-baseline 2>/dev/null || echo "0")

if (( $(echo "$RATIO < $BASELINE - 0.005" | bc -l) )); then
  echo "🔴 分支覆蓋率從 $BASELINE 降到 $RATIO"
  echo "   通常代表：新增了程式碼但沒有對應的測試"
  exit 1
fi

echo "$RATIO" > .coverage-baseline
```

**★ 覆蓋率最重要的一句話**：

> **「100% 覆蓋率」與「測試有效」是兩件事。**
> 7.2.3 的那個測試（只斷言 200）會讓整個 Controller 方法變成「已覆蓋」——
> 而它什麼都沒驗證。

### 7.13.6 突變測試：覆蓋率之外

**突變測試回答的問題**：
「如果我**故意**把程式碼改壞，測試會抓到嗎？」

```xml
<plugin>
    <groupId>org.pitest</groupId>
    <artifactId>pitest-maven</artifactId>
    <version>1.16.1</version>
    <configuration>
        <targetClasses>
            <!-- ★ 只對「純函式」跑 —— 它們最快也最值得 -->
            <param>example.shop.common.upload.*</param>
            <param>example.shop.common.web.ETags</param>
            <param>example.shop.common.web.CsvWriter</param>
            <param>example.shop.order.web.MoneyFormat</param>
            <param>example.shop.common.web.ClientIpResolver</param>
        </targetClasses>
        <targetTests>
            <param>example.shop.**.*Test</param>
        </targetTests>
        <mutationThreshold>85</mutationThreshold>
        <timestampedReports>false</timestampedReports>
    </configuration>
    <dependencies>
        <dependency>
            <groupId>org.pitest</groupId>
            <artifactId>pitest-junit5-plugin</artifactId>
            <version>1.2.1</version>
        </dependency>
    </dependencies>
</plugin>
```

**它怎麼運作**：

```java
// 原始
if (filename.length() > 255) { throw new UploadRejectedException(...); }

// Pitest 產生的突變體：
//   ① >  改成 >=
//   ② >  改成 <
//   ③ 255 改成 256
//   ④ 移除整個 if
//
// 對每一個突變體跑測試：
//   測試失敗 → 「殺死」了這個突變體 ✅
//   測試通過 → 🔴 存活的突變體 —— 代表你的測試抓不到這個改動
```

**shop-service 的實際結果（節錄）**：

```
example.shop.common.upload.SafeFilename
>> 產生 47 個突變體，殺死 44 個（93%）

存活的突變體：
  1. SafeFilename.java:38  「移除對長度上限的檢查」→ 測試仍然通過
     ⚠️ 診斷：測試用的長檔名是 2,000 字元，遠超過 255 ——
        任何「有檢查」的實作都會擋下它。
        缺的是「剛好 255 / 剛好 256」的邊界測試。

  2. SafeFilename.java:52  「把 replace('\\', '/') 改成 replace('/', '/')」
     ⚠️ 診斷：Windows 路徑的測試案例只有 "..\\..\\a.jpg"，
        而它被「移除 .. 」那一步擋下了 ——
        所以反斜線的處理本身沒有被驗證。

  3. StorageKeys.java:29   「把 UUID 的前綴長度 8 改成 7」
     ✅ 診斷：這是一個**等價突變體**（equivalent mutant）——
        前綴長度不影響任何可觀察的行為。
        處理：加 @DoNotMutate 或接受它。
```

**⚠️ 突變測試的三個代價**：

| 代價 | 具體 |
|---|---|
| **慢** | 對 5 個類別跑要 3 分鐘。對整個專案要 40 分鐘以上 |
| **等價突變體** | 有些突變不改變行為，永遠殺不死 —— 需要人工判斷 |
| **容易被誤用** | 「衝突變分數」會產生一堆低價值的邊界測試 |

**shop-service 的用法**：

```
· 只對「純函式 + 安全性相關」的 5～8 個類別跑
· 只在 nightly 跑（@Tag(Tags.NIGHTLY)）
· 分數不當作硬性門檻，而是「每個月看一次報告」
· ★ 主要用途：**設計新的邊界測試** ——
  存活的突變體會直接告訴你「哪個邊界沒測到」
```

> **突變測試是一個「找測試漏洞」的工具，不是一個 CI 門檻。**

---
## 7.14 shop-service 落地清單

### 7.14.1 這一章新增的檔案

```
src/test/java/example/shop/
├── test/                                       ★ 測試的基礎設施（不含斷言）
│   ├── WebSliceTest.java                       ★★ 所有切片測試的基底（7.4.5）
│   ├── WebSliceInfraConfig.java                ★★ 共用的替身（7.4.4）
│   ├── InfrastructureIntegrationTest.java      ★ Testcontainers 基底（7.11.6）
│   ├── ContractValidationConfig.java           自動驗證 OpenAPI（7.10.2）
│   ├── Tags.java                               測試的分類標籤（7.13.1）
│   ├── WithActor.java                          ★ @WithSecurityContext 工廠（7.4.3）
│   ├── JsonAssertions.java                     欄位存在性的斷言（7.5.4）
│   ├── ResponseMatchers.java                   ★ hasNonEmptyBody（7.6.3）
│   ├── FileFixtures.java                       真的檔案位元組（7.5.7）
│   ├── MaliciousFilenames.java                 ★ 攻擊目錄（7.5.7）
│   ├── BadRequests.java                        ★★ 壞輸入目錄（7.7.6）
│   │                                             （universal / forCreateOrder 兩組）
│   ├── AllServicesStubbedToSucceed.java        ★ 授權矩陣用的替身（7.14.3）
│   ├── DtoScanner.java                         掃描對外的 DTO（7.14.3）
│   ├── OpenApiErrorCodes.java                  讀 orders-api.yaml 的 code（7.14.3）
│   ├── TestTokens.java                         ④′ 用的真 JWT（7.14.3）
│   ├── InMemoryIdempotencyStore.java           記憶體版冪等儲存
│   ├── RecordingAuditRepository.java           可斷言的稽核
│   ├── authz/
│   │   ├── EndpointInventory.java              ★ 從 Spring 取得端點（7.9.2）
│   │   ├── AuthzMatrix.java                    讀 CSV
│   │   ├── UriTemplates.java                   ★ 樣板填值 + 守門（7.9.3）
│   │   ├── Auth.java                           以某個 Actor 身分（7.9.3）
│   │   ├── Actors.java                         六種身分的 fixture（含 SYSTEM）
│   │   ├── ValidBodies.java                    每個端點的合法 body（7.14.3）
│   │   └── Methods.java                        isWrite / requiresIdempotencyKey（7.14.3）
│   ├── mother/
│   │   ├── Orders.java                         ★ Object Mother（7.7.2）
│   │   ├── Products.java
│   │   ├── Items.java
│   │   ├── Addresses.java
│   │   └── PageFixtures.java
│   ├── mother/（續）
│   │   ├── StatusLabels.java                   ★ enum → 中文（寫死，7.14.3）
│   │   └── MoneyFixtures.java                  ★ 刻意不用 MoneyFormat（7.14.3）
│   └── builder/
│       ├── OrderDetailBuilder.java             ★ Test Data Builder（7.7.3）
│       ├── CreateOrderRequestBuilder.java
│       └── ProductDetailBuilder.java
│
├── arch/                                       ★ 「守門」測試
│   ├── WebMvcSliceInventoryTest.java           印出切片內容（7.4.1）
│   ├── SecuritySliceRealityCheckTest.java      ★★ Security 真的生效嗎（7.4.3）
│   ├── NoBlanketFilterDisablingTest.java       ★★ 禁止 addFilters=false（7.4.3）
│   ├── FiltersAppliedInSliceTest.java          filter 真的掛上了（7.4.4）
│   ├── AllTestsHaveTagTest.java                每個測試類別都有 tag（7.13.1）
│   ├── ErrorCodeUsageTest.java                 ★ PLANNED_FOR_LATER 的唯一定義（03 章 3.14.5）
│   ├── NoExpiredDisabledTestsTest.java         ★ @Disabled 的兩週期限（7.13.4）
│   ├── QueryServiceRequiresActorTest.java      ★★ 簽名一定有 Actor（7.6.4）
│   ├── ObjectMapperUsageTest.java              （06 章）
│   └── DtoTypeRulesTest.java                   （06 章）
│
├── contract/
│   ├── ErrorCodeContractTest.java              ★★ 83 個 code × 5 個規則（7.8.2）
│   ├── AllExposedEnumsHaveLabelsTest.java      ★ 每個 enum 值有 label（7.8.3）
│   ├── OpenApiContractTest.java                ★ 符合 orders-api.yaml（7.10.2）
│   ├── ConsumerFieldUsageTest.java             客戶端用到的欄位（7.10.5）
│   ├── JacksonContractTest.java                （06 章）
│   ├── StatusLabelCompletenessTest.java        （06 章，被 7.8.3 涵蓋）
│   ├── SealedSubtypeConsistencyTest.java       （06 章）
│   ├── DtoSerializabilityTest.java             （06 章）
│   └── SensitiveFieldScanTest.java             （06 章）
│
├── security/                                   ★★ 這一章最重要的目錄
│   ├── AuthorizationMatrixTest.java            ★★ 70 × 5（7.9.3）
│   ├── AuthzMatrixCompletenessTest.java        ★★ 端點與 ActorType 都要涵蓋（7.9.4）
│   ├── ObjectLevelAuthorizationTest.java       ★★ IDOR（7.9.5）
│   └── JsonBombTest.java                       （06 章）
│
├── docs/
│   ├── OrderDocumentationTest.java             REST Docs（7.10.3）
│   ├── ProductDocumentationTest.java
│   └── ErrorDocumentationTest.java
│
├── integration/
│   ├── FilterOrderTest.java                    ★★ filter 順序（7.11.2）
│   ├── CorsOnAllErrorPathsTest.java            ★ 每種錯誤都有 CORS（7.11.3）
│   ├── OrderEventStreamIntegrationTest.java    ★ SSE 六件事（7.11.4）
│   ├── RealHttpBehaviourTest.java              ★ 壓縮/Range/chunked（7.11.5）
│   ├── ShippingAddressChangeIntegrationTest.java  AFTER_COMMIT（7.11.6）
│   ├── IdempotencyIntegrationTest.java         （04 章）
│   └── CorsIntegrationTest.java                （06 章）
│
└── （各模組的切片測試）
    ├── order/web/
    │   ├── OrderControllerTest.java            extends WebSliceTest
    │   ├── OrderControllerErrorTest.java       （03 章，修正 @MockBean）
    │   ├── OrderControllerBindingTest.java     ★ ArgumentCaptor（7.6.5）
    │   ├── OrderControllerBadInputTest.java    ★ BadRequests 目錄（7.7.6）
    │   ├── OrderUpdateControllerTest.java      If-Match（06 章）
    │   ├── OrderCsvExportControllerTest.java   asyncDispatch（05 章）
    │   ├── OrderExportControllerTest.java
    │   └── OrderEventStreamControllerTest.java 線路格式（7.5.8）
    ├── product/web/
    │   ├── ProductControllerTest.java
    │   └── ProductImageControllerTest.java     ★ multipart 攻擊（7.5.7）
    └── common/web/
        ├── PageableGuardInterceptorTest.java   ★ standalone 的正當用途（7.4.6）
        ├── ProblemWriterTest.java
        └── ETagsTest.java

src/test/resources/
├── authz-matrix.csv                            ★★ 70 端點 × 5 角色（7.9.3）
├── junit-platform.properties                   ★ 平行執行（7.13.2）
├── application-test.yml                        測試的設定（7.14.2）
├── logback-test.xml
├── openapi/orders-api.yaml                     （03-rest-api 第 07 章的副本）
├── fixtures/
│   ├── 1x1.jpg                                 真的圖檔（7.5.7）
│   ├── 4000x3000.jpg                           大圖（尺寸限制）
│   ├── zip-bomb.zip                            （05 章 5.5.4）
│   └── receipt-sample.pdf
└── requests/
    ├── create-order-full.json                  ★ 與 docs/examples 共用（7.7.5）
    └── update-product-full.json

src/docs/asciidoc/
└── index.adoc                                  REST Docs 的組裝（7.10.3）

scripts/
├── check-context-count.sh                      ★ context 預算（7.4.5）
├── check-assertion-quality.sh                  ★ 只斷言 200（7.12.1）
├── check-doc-examples.sh                       範例不過期（7.5.5）
└── check-coverage-trend.sh                     覆蓋率不下降（7.13.5）

docs/examples/
└── order-detail.json                           由測試產生（7.5.5）
```

### 7.14.2 測試的設定檔

**`src/test/resources/application-test.yml`**：

```yaml
# ★★ 這個檔案的設計原則：
#    **盡量與正式環境一致**。每一個「與正式不同」的設定
#    都是一個「測試測不到的東西」，所以每一項都要寫理由。

spring:
  # ★ Jackson 完全不覆寫 —— 06 章的所有設定都要生效
  #    （如果這裡覆寫了任何一項，06 章那些測試就白寫了）

  main:
    # ⚠️ 允許 bean 覆寫：@TestConfiguration 的替身需要它
    #    （例如 InMemoryRateLimiter 覆蓋 RedisRateLimiter）
    allow-bean-definition-overriding: true

  task:
    execution:
      pool:
        # ★ 測試用同步執行緒池，讓 @Async 的結果可預測
        #   ⚠️ 但這也意味著「@Async 真的是非同步嗎」測不到 ——
        #      那件事由 7.11.6 的整合測試涵蓋
        core-size: 1
        max-size: 1

server:
  # ⚠️ 這些在 @WebMvcTest 裡無效（7.4.2），只對 ④′ 有意義
  compression:
    enabled: true
    mime-types: application/json,application/problem+json,text/csv,application/xml
    min-response-size: 2048

api:
  # ★ 限流的數字放大，避免一般測試意外被限流
  #   ⚠️ 但限流的測試自己用 @TestPropertySource 調回來
  rate-limit:
    ip-limit: 100000
    user-limit: 100000

  upload:
    malware-scan:
      enabled: false          # 與 local profile 一致（沒有 ClamAV）
    download:
      proxy-through-application: true

  sse:
    # ★ 大幅縮短，讓 SSE 測試不用等 20 秒
    #   ⚠️ 這是一個「與正式不同」的設定 ——
    #      「20 秒的心跳在真實網路上夠不夠」測不到（那要靠監控）
    heartbeat-interval: 200ms
    connection-timeout: 5s

  export:
    max-sync-rows: 20000      # 與正式一致

logging:
  level:
    # ★ 讓 7.4.5 的 context 診斷可用
    org.springframework.test.context.cache: DEBUG
    # ⚠️ 其他一律 WARN —— 3,000 個測試的 INFO log 會蓋掉失敗訊息
    root: WARN
    example.shop: INFO
```

⚠️ **`allow-bean-definition-overriding: true` 是一個有代價的設定。**

| | |
|---|---|
| 需要它 | `@TestConfiguration` 的替身要蓋掉正式的 bean |
| 代價 | **正式環境的「兩個同名 bean」錯誤，在測試裡不會出現** |
| 緩解 | 用 ④ 整合測試（不 import `WebSliceInfraConfig`）確保 context 真的起得來 |

**所以要有一個「context 真的載入得起來」的測試**：

```java
/**
 * ★ 最基本、也最容易被忽略的一個測試。
 *
 * <p>它驗證「正式的 context 真的能載入」——
 * 沒有 @TestConfiguration 的覆寫、沒有 mock。
 *
 * <p>⚠️ 為什麼需要它：所有其他測試都在某種程度上「動過」context，
 *    所以它們無法證明「正式環境啟動得起來」。
 *
 * <p>它抓到過的問題：
 *   · 兩個同名的 bean（被 allow-bean-definition-overriding 掩蓋）
 *   · 循環依賴
 *   · @Value 的 property 不存在
 *   · CorsConfigurationValidator（06 章 6.3.6）的啟動檢查失敗
 *   · ErrorMessageStartupValidator（03 章 3.4.5）的啟動檢查失敗
 */
@SpringBootTest(properties = "spring.main.allow-bean-definition-overriding=false")
@ActiveProfiles("prod-like")
class ApplicationContextLoadsTest {

    @Test
    void context載入成功() {
        // ★ 方法是空的 —— 「@SpringBootTest 沒拋例外」就是斷言
    }

    @Test
    void 啟動時的驗證器都跑過了(@Autowired ApplicationContext context) {
        // ★ 明確確認那些「只在啟動時跑」的檢查真的存在
        assertThat(context.getBeansOfType(ApplicationRunner.class).keySet())
                .contains("corsConfigurationValidator", "errorMessageStartupValidator");
    }
}
```

### 7.14.3 支援型別：前面用到但還沒定義的東西

```java
package example.shop.test.authz;

import example.shop.order.domain.Actor;
import example.shop.order.domain.Actor.ActorType;

/** 五種角色的 fixture。 */
public final class Actors {

    private Actors() {}

    public static Actor 客戶() {
        return new Actor(ActorType.CUSTOMER, "cust_01J5GKTESTCUST01", "測試客戶");
    }

    public static Actor 另一個客戶() {
        return new Actor(ActorType.CUSTOMER, "cust_01J5GKTESTCUST02", "測試客戶 B");
    }

    public static Actor 客服() {
        return new Actor(ActorType.SUPPORT, "supp_01J5GKTESTSUPP01", "測試客服");
    }

    public static Actor 倉管() {
        return new Actor(ActorType.WAREHOUSE, "whse_01J5GKTESTWHSE01", "測試倉管");
    }

    public static Actor 管理員() {
        return new Actor(ActorType.ADMIN, "admn_01J5GKTESTADMN01", "測試管理員");
    }

    /** ★ 系統帳號（webhook、排程用）—— 不在授權矩陣裡，但某些測試需要。 */
    public static Actor 系統() {
        return new Actor(ActorType.SYSTEM, "system", "系統");
    }
}
```

```java
package example.shop.test.authz;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.*;

/**
 * 讀取並解析 authz-matrix.csv。
 *
 * <p>★ 為什麼自己解析而不用 CSV 函式庫：
 *    這份 CSV 的格式是固定的，而多一個相依會讓
 *    「測試的基礎設施」變重。
 * <p>★ {@code split(",", 8)} 的第二個參數是關鍵：前 7 個欄位照常切，
 *    <b>剩下的全部算 note</b> —— 所以 <b>note 欄位可以有逗號</b>。
 *    ⚠️ 但<b>不可以有換行</b>（一列就是一行），也不支援引號跳脫。
 *    👉 CSV 裡的說明文字仍然建議用全形逗號「，」——
 *       那樣即使有人把 {@code limit} 參數拿掉也不會壞。
 */
public final class AuthzMatrix {

    public record Endpoint(String method, String uriTemplate,
                           Map<String, Integer> expectations, String note) {

        public String key() { return method + " " + uriTemplate; }

        /** {@code actor} 為 {@code null} 代表匿名。 */
        public int expectationFor(example.shop.order.domain.Actor actor) {
            return expectationFor(actor == null
                    ? Actor.ActorType.ANONYMOUS : actor.type());
        }

        /**
         * ★ 也接受 {@code ActorType}。
         *
         * <p>7.8.5 的「一次印出全貌」測試是用
         * {@code for (ActorType role : ActorType.values())} 走的 ——
         * 它拿不到 {@code Actor} 實例，所以需要這個多載。
         * ⚠️ 第一版只有吃 {@code Actor} 的版本，那個測試編譯不過。
         */
        public int expectationFor(Actor.ActorType type) {
            String role = type.name().toLowerCase(Locale.ROOT);
            Integer expected = expectations.get(role);
            if (expected == null) {
                throw new IllegalStateException("""
                        authz-matrix.csv 的 %s 沒有 '%s' 這一欄。

                        ⚠️ 是不是新增了一個 ActorType 但沒有更新 CSV 的標題列？
                        ⚠️ 如果那個 ActorType 刻意不納入矩陣（例如 SYSTEM），
                           請把它加進 AuthzMatrix.EXCLUDED_ACTOR_TYPES 並說明理由。
                        """.formatted(key(), role));
            }
            return expected;
        }
    }

    /**
     * CSV 的角色欄位。
     *
     * <p>⚠️⚠️ {@code ActorType} 有 <b>6</b> 個常數（04 章 4.13.6）：
     * {@code ANONYMOUS, CUSTOMER, SUPPORT, WAREHOUSE, ADMIN, SYSTEM} ——
     * 而這裡只有 5 個。
     *
     * <p>★ {@code SYSTEM} 刻意<b>不在</b>矩陣裡：它不是「一種使用者」，
     * 而是「排程與 webhook 用的內部身分」，它走的端點（{@code /webhooks/**}）
     * 用<b>簽章</b>驗證而不是角色（6.5.8）。
     *
     * <p>⚠️ 但「刻意排除」必須是一個<b>會紅燈</b>的決定而不是「剛好沒寫」——
     * 見下方的 {@link #EXCLUDED_ACTOR_TYPES} 與
     * {@code AuthzMatrixCompletenessTest.每個ActorType都被涵蓋或明確排除()}。
     */
    private static final List<String> ROLE_COLUMNS =
            List.of("anonymous", "customer", "support", "warehouse", "admin");

    /** ★ 明確排除的 ActorType —— 加進來要在 PR 說明為什麼。 */
    public static final Set<Actor.ActorType> EXCLUDED_ACTOR_TYPES =
            Set.of(Actor.ActorType.SYSTEM);   // webhook / 排程用簽章驗證，不是角色

    private static List<Endpoint> cached;

    public static synchronized AuthzMatrix load() {
        if (cached == null) cached = parse();
        return new AuthzMatrix();
    }

    public List<Endpoint> endpoints() { return cached; }

    public Set<String> keys() {
        return cached.stream().map(Endpoint::key)
                .collect(java.util.stream.Collectors.toCollection(TreeSet::new));
    }

    /** ★ 給 {@code 每個ActorType都被涵蓋或明確排除()} 用。 */
    public List<String> roleColumns() {
        return ROLE_COLUMNS;
    }

    private static List<Endpoint> parse() {
        try (var in = AuthzMatrix.class.getResourceAsStream("/authz-matrix.csv")) {
            Objects.requireNonNull(in, "找不到 /authz-matrix.csv");
            var lines = new String(in.readAllBytes(), StandardCharsets.UTF_8).lines()
                    .map(String::strip)
                    .filter(l -> !l.isEmpty() && !l.startsWith("#"))
                    .toList();

            // ★ 驗證標題列 —— 新增 ActorType 時這裡會紅燈
            var header = List.of(lines.get(0).split(",", -1));
            if (!header.subList(2, 7).equals(ROLE_COLUMNS)) {
                throw new IllegalStateException("""
                        authz-matrix.csv 的標題列與預期不符。
                        期望：method,uri,%s,note
                        實際：%s
                        """.formatted(String.join(",", ROLE_COLUMNS), lines.get(0)));
            }

            var result = new ArrayList<Endpoint>();
            for (String line : lines.subList(1, lines.size())) {
                // ★ 只 split 8 份，第 8 份（note）保留逗號
                String[] parts = line.split(",", 8);
                var expectations = new LinkedHashMap<String, Integer>();
                for (int i = 0; i < ROLE_COLUMNS.size(); i++) {
                    expectations.put(ROLE_COLUMNS.get(i),
                            Integer.parseInt(parts[2 + i].strip()));
                }
                result.add(new Endpoint(parts[0].strip(), parts[1].strip(),
                        expectations, parts.length > 7 ? parts[7].strip() : ""));
            }
            return List.copyOf(result);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
```

```java
package example.shop.test.authz;

/**
 * 每個寫入端點的「合法 body」。
 *
 * <p>★★ 為什麼授權矩陣需要這個（7.9.3 提過但值得展開）：
 *
 * <p>如果 POST /orders 的 body 是空的，回應會是 422（驗證失敗），
 * 而 422 既不是 201 也不是 403 —— 於是測試無法判斷
 * 「是授權擋下的，還是驗證擋下的」。
 *
 * <p>更糟的是：**如果授權真的漏了，回應仍然是 422** ——
 * 測試會通過（因為它期望的不是 201），而漏洞還在。
 *
 * <p>⚠️ 所以「授權測試的 body 必須是合法的」是這套測試正確性的前提。
 *    7.9.3 的失敗訊息裡有一句「如果得到 422/400，去修 ValidBodies」
 *    就是在守住這件事。
 */
public final class ValidBodies {

    private ValidBodies() {}

    public static String forEndpoint(String method, String uriTemplate) {
        return switch (method + " " + uriTemplate) {
            // ★ 欄位與 02 章 2.12.1 的正式版一致（刻意沒有 unitPrice、
            //   刻意用 shippingAddressId 而不是展開的地址）
            case "POST /orders" -> """
                    {"items":[{"productId":"P-1001","quantity":1}],
                     "shippingAddressId":"adr_01J5GKAUTHZ01"}
                    """;
            case "PATCH /orders/{orderId}" -> """
                    {"customerNote":"授權測試"}
                    """;
            case "PATCH /orders/{orderId}/shipping-address" -> """
                    {"recipientName":"王小明","phone":"0912345678","postalCode":"10041",
                     "line1":"台北市中正區重慶南路一段 122 號","reason":"授權測試"}
                    """;
            case "POST /orders/{orderId}/payments" -> """
                    {"paymentMethod":{"type":"CREDIT_CARD","token":"tok_test"}}
                    """;
            case "POST /orders/{orderId}/cancellations" -> """
                    {"reason":"CHANGED_MIND"}
                    """;
            case "POST /products" -> """
                    {"sku":"SKU-AUTHZ-001","name":"授權測試商品","price":"100",
                     "currency":"TWD"}
                    """;
            // ...（其餘端點）
            default -> {
                if (Methods.isWrite(method)) {
                    // ★★ 守門：寫入端點一定要有 body，不可以靜默用空的
                    throw new IllegalStateException("""
                            %s %s 是寫入端點，但 ValidBodies 沒有它的合法 body。

                            ⚠️ 沒有 body 的話，授權測試會得到 400/422，
                               而那讓「授權有沒有生效」變得無法判斷（見類別 javadoc）。

                            請在這個 switch 加上它。
                            """.formatted(method, uriTemplate));
                }
                yield "";
            }
        };
    }
}
```

⚠️ **`default` 分支拋例外而不是回傳 `"{}"`** ——
這是這一章反覆出現的模式：
**「不知道怎麼辦」時要大聲失敗，不要靜默用一個看起來合理的預設值。**

```java
package example.shop.test;

import example.shop.order.service.IdempotencyStore;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 04 章 4.9 的 IdempotencyStore 的記憶體實作。
 *
 * <p>★ 為什麼是「真的實作」而不是 mock（7.6.1）：
 *    冪等的行為是「第二次送同樣的請求要回同一個結果」——
 *    那需要真的記住狀態。mock 做不到。
 */
public class InMemoryIdempotencyStore implements IdempotencyStore {

    private record Entry(String fingerprint, String responseBody,
                         int status, Instant expiresAt) {}

    private final Map<String, Entry> store = new ConcurrentHashMap<>();
    private final Clock clock;

    public InMemoryIdempotencyStore(Clock clock) { this.clock = clock; }

    @Override
    public Optional<StoredResponse> find(String key, String fingerprint) {
        Entry entry = store.get(key);
        if (entry == null) return Optional.empty();
        if (entry.expiresAt().isBefore(clock.instant())) {
            store.remove(key);
            return Optional.empty();
        }
        if (!entry.fingerprint().equals(fingerprint)) {
            // ★ 同一個 key、不同的請求內容 → 409（04 章 4.9.4）
            throw new example.shop.common.web.IdempotencyKeyReusedException(key);
        }
        return Optional.of(new StoredResponse(entry.status(), entry.responseBody()));
    }

    @Override
    public void save(String key, String fingerprint, int status, String body) {
        store.put(key, new Entry(fingerprint, body, status,
                clock.instant().plus(Duration.ofHours(24))));
    }

    /** ⚠️ 測試專用 —— 不在正式介面上。 */
    public void clear() { store.clear(); }
}
```

⚠️ **`clear()` 不在 `IdempotencyStore` 介面上，只在這個實作上。**
這樣正式碼不會出現「只有測試用得到的方法」，
而測試需要它時可以宣告成具體型別：

```java
@Autowired InMemoryIdempotencyStore idempotencyStore;    // ★ 具體型別
```

```java
package example.shop.test;

import example.shop.common.audit.AuditEvent;
import example.shop.common.audit.AuditRepository;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * 04 章 4.6 的稽核儲存 —— 記錄到 list 供斷言。
 *
 * <p>★ 用 CopyOnWriteArrayList 而不是 ArrayList：
 *    稽核可能由非同步的 listener 寫入（04 章 4.6.4），
 *    而測試在主執行緒讀 —— 需要執行緒安全。
 *
 * <p>⚠️ 沒有這一點的話，症狀是
 *    「ConcurrentModificationException，偶爾發生」。
 */
public class RecordingAuditRepository implements AuditRepository {

    private final List<AuditEvent> events = new CopyOnWriteArrayList<>();

    @Override
    public void save(AuditEvent event) { events.add(event); }

    public List<AuditEvent> findAll() { return List.copyOf(events); }

    public List<AuditEvent> findByResourceId(String resourceId) {
        return events.stream().filter(e -> resourceId.equals(e.resourceId())).toList();
    }

    public void clear() { events.clear(); }
}
```


#### 前面用到但還沒定義的（第二批）★

> **這一批是「第三輪複查」抓到的** ——
> 前面的章節用了 10 個型別卻沒有定義它們。
> 而抓到它們的方式就是 05 章 5.12.4 那個 `comm -23` 腳本的變體：
>
> ```bash
> # 找出「被呼叫但沒有定義」的測試支援型別
> grep -rhoE '\b(Methods|DtoScanner|StatusLabels|TestTokens|PageFixtures|Items|Addresses)\.' \
>   src/test/java | sed 's/\.$//' | sort -u > /tmp/used.txt
> find src/test/java -name '*.java' -exec basename {} .java \; | sort -u > /tmp/defined.txt
> comm -23 /tmp/used.txt /tmp/defined.txt
> ```

```java
package example.shop.test.authz;

/** HTTP 方法的分類。 */
public final class Methods {

    private Methods() {}

    /**
     * 「這個方法需要 request body 嗎」。
     *
     * <p>★ 用它來決定授權測試要不要附 body（7.9.3）——
     * 而<b>不是</b>用「有沒有副作用」判斷：
     * {@code DELETE} 有副作用但沒有 body。
     */
    public static boolean isWrite(String method) {
        return switch (method.toUpperCase(java.util.Locale.ROOT)) {
            case "POST", "PUT", "PATCH" -> true;
            default -> false;         // GET / HEAD / OPTIONS / DELETE
        };
    }

    /** 需要 {@code Idempotency-Key} 的方法（04 章 4.9）。 */
    public static boolean requiresIdempotencyKey(String method) {
        return "POST".equalsIgnoreCase(method) || "PATCH".equalsIgnoreCase(method);
    }
}
```

```java
package example.shop.test;

import example.shop.order.service.*;
import example.shop.product.service.*;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;

/**
 * 授權矩陣測試用的「所有 Service 都成功」替身（7.9.3）。
 *
 * <p>★★ 為什麼授權測試需要它：
 * 那個測試要區分 <b>403</b> 與 <b>200</b> ——
 * 而 200 的路徑必須真的能走完，否則會是 500。
 *
 * <p>⚠️ 但它<b>不可以</b>是 {@code @MockitoBean}：
 * mock 沒 stub 就回 {@code null}（7.6.3）→ Controller NPE → 500，
 * 而 <b>500 既不是 403 也不是 200</b>，測試會失敗但原因指不出來。
 *
 * <p>★ 所以它是「一律回傳一個合法結果」的真實實作。
 * <b>而它刻意不驗證任何東西</b> —— 授權測試不該關心業務規則。
 */
@TestConfiguration(proxyBeanMethods = false)
public class AllServicesStubbedToSucceed {

    @Bean OrderService orderService() {
        return new OrderService() {
            @Override public Order create(CreateOrderCommand cmd) {
                return Orders.剛建立的訂單Domain();
            }
            @Override public void cancel(CancelOrderCommand cmd) { /* 成功 */ }
            // …其餘方法一律回傳「成功」的結果
        };
    }

    @Bean OrderQueryService orderQueryService() {
        return new OrderQueryService() {
            @Override public OrderDetail findDetail(String orderId, Actor actor) {
                return Orders.已付款的單品訂單();
            }
            @Override public PageResponse<OrderSummary> list(OrderFilter filter) {
                return PageFixtures.兩筆訂單();
            }
        };
    }

    // …其餘 12 個 Service 同樣的形狀

    /**
     * ⚠️ 這個類別會長到 200 行，而那是可以接受的 ——
     * 它換來的是「350 個授權斷言的結果只反映授權，不反映業務邏輯」。
     *
     * <p>★ 如果覺得太長：用一個 {@code Answer} 一次處理所有方法
     * <pre>
     * Mockito.mock(OrderService.class, invocation -&gt;
     *         DefaultResults.forReturnType(invocation.getMethod().getReturnType()));
     * </pre>
     * ⚠️ 但那會讓「回傳型別加一個」時靜默回 null —— 取捨自己決定。
     */
}
```

```java
package example.shop.test;

import java.util.List;
import java.util.Set;

/**
 * 掃描「對外可見的 DTO」（7.8.3、06 章 6.7.4 都用到）。
 *
 * <p>★ 判準是「出現在 Controller 方法的參數或回傳型別上」，
 * 而不是「在某個套件裡」—— 因為前者才是「對外可見」的真正定義。
 */
public final class DtoScanner {

    private DtoScanner() {}

    /**
     * @return 所有對外可見的 record 型別
     *
     * <p>★ 只回 record：本課程的 DTO 一律是 record（00 章 0.6.3），
     * 而「不是 record 的 DTO」本身就該被 ArchUnit 擋掉（6.7.5）。
     */
    public static Set<Class<?>> scan(String basePackage) {
        try (var scan = new io.github.classgraph.ClassGraphBuilder()
                .acceptPackages(basePackage)
                .enableAnnotationInfo()
                .enableMethodInfo()
                .scan()) {

            Set<Class<?>> dtos = new java.util.LinkedHashSet<>();
            for (var controller : scan.getClassesWithAnnotation(
                    org.springframework.web.bind.annotation.RestController.class)) {
                for (var method : controller.getMethodInfo()) {
                    collectRecords(method, dtos);
                }
            }
            return dtos;
        }
    }

    /** 遞迴收集 record 與它的巢狀 record（含泛型參數，例如 PageResponse&lt;OrderSummary&gt;）。 */
    private static void collectRecords(io.github.classgraph.MethodInfo method,
                                       Set<Class<?>> out) {
        // 實作略：走訪回傳型別與參數型別，對 record 遞迴它的 recordComponents
    }
}
```

```java
package example.shop.test;

/**
 * 從 {@code orders-api.yaml} 讀出「文件裡宣告的錯誤碼」（7.8.2 用到）。
 *
 * <p>★ 為什麼讀 YAML 而不是打 {@code /v3/api-docs}：
 * 06 章 6.10.3 與 07 章 7.10.4 的決定是
 * {@code springdoc.api-docs.enabled=false} ——
 * 手寫的 YAML 才是唯一的真相來源（contract-first）。
 */
public final class OpenApiErrorCodes {

    private OpenApiErrorCodes() {}

    /**
     * @param resourcePath classpath 上的 YAML（例如 {@code "openapi/orders-api.yaml"}）
     * @return 契約裡宣告的所有 {@code code} 值
     *
     * <p>★ 它讀的是 {@code components.schemas.Problem.properties.code} 的
     * {@code x-extensible-enum}（6.5.8 的決定：<b>不用 {@code enum}</b>）。
     */
    public static java.util.Set<String> readFrom(String resourcePath) throws Exception {
        var yaml = new com.fasterxml.jackson.dataformat.yaml.YAMLMapper();
        try (var in = new org.springframework.core.io.ClassPathResource(resourcePath)
                .getInputStream()) {
            var codeNode = yaml.readTree(in)
                    .path("components").path("schemas").path("Problem")
                    .path("properties").path("code");

            // ★ 優先讀 x-extensible-enum；沒有才退回 enum（並在訊息裡提醒）
            var values = codeNode.has("x-extensible-enum")
                    ? codeNode.get("x-extensible-enum")
                    : codeNode.get("enum");

            if (values == null) {
                throw new AssertionError("""
                        orders-api.yaml 的 Problem.code 既沒有 x-extensible-enum 也沒有 enum。
                        → 07 章 7.8.2 的「每個 code 都在 OpenAPI 的錯誤列表裡」無法檢查。
                        """);
            }
            var out = new java.util.TreeSet<String>();
            values.forEach(v -> out.add(v.asText()));
            return out;
        }
    }
}
```

```java
package example.shop.test.mother;

import example.shop.order.domain.OrderStatus;

/**
 * enum → 中文顯示文字（測試用的固定對照）。
 *
 * <p>★★ 為什麼<b>不</b>呼叫 {@code StatusLabelResolver}：
 * 那正是 7.2.5 / 7.12.2 的反模式（用被測邏輯算期望值）。
 *
 * <p>這裡的值是<b>人寫下來的字面值</b> ——
 * 而「它們與 {@code messages_zh_TW.properties} 一致」
 * 由 7.8.3 的 {@code AllExposedEnumsHaveLabelsTest} 保證。
 *
 * <p>⚠️ 那不是循環論證：
 * <ul>
 *   <li>7.8.3 檢查「properties 有沒有這個 key」（與這裡的值無關）</li>
 *   <li>這裡提供「builder 產生的 DTO 的 statusLabel」（讓資料自洽，7.7.3）</li>
 * </ul>
 */
public final class StatusLabels {

    private StatusLabels() {}

    public static String of(OrderStatus status) {
        return switch (status) {
            case PENDING_PAYMENT    -> "待付款";
            case PAID               -> "已付款";
            case PARTIALLY_SHIPPED  -> "部分出貨";
            case SHIPPED            -> "已出貨";
            case DELIVERED          -> "已送達";
            case CANCELLED          -> "已取消";
            case REFUNDED           -> "已退款";
            case UNKNOWN            -> "處理中";
            // ★ 沒有 default —— 新增一個狀態時【編譯失敗】，而那正是我們要的
        };
    }
}
```

```java
package example.shop.test;

/**
 * 整合測試用的 JWT（7.11.4 的 {@code WebClient} 需要真的 {@code Authorization} 標頭）。
 *
 * <p>⚠️ 為什麼整合測試不能用 {@code Auth.as(...)}：
 * 那是 {@code RequestPostProcessor}，只對 <b>MockMvc</b> 有效。
 * ④′ 是真的 HTTP，必須有一個真的 token。
 *
 * <p>★ 用測試專用的簽章金鑰（{@code application-test.yml} 的
 * {@code api.security.jwt.test-signing-key}）——
 * <b>絕不</b>使用正式環境的金鑰，也絕不把金鑰寫在原始碼裡。
 */
public final class TestTokens {

    private TestTokens() {}

    public static String customer() { return of("cust_01J5GKTESTCUST01", "CUSTOMER"); }
    public static String support()  { return of("supp_01J5GKTESTSUPP01", "SUPPORT"); }
    public static String admin()    { return of("admn_01J5GKTESTADMN01", "ADMIN"); }

    /**
     * ★ 角色放【裸名】（{@code "CUSTOMER"}），不加 {@code ROLE_} 前綴 ——
     * 與 {@code CurrentUser.roles} 的慣例一致（04 章 4.13.6）。
     * 前綴由 {@code getAuthorities()} 加。
     */
    private static String of(String subject, String role) {
        // 實作：用 nimbus-jose-jwt 簽一個 5 分鐘後過期的 HS256 token
        // （完整實作在 09-spring-security；這裡只需要它能被我們的 JwtDecoder 驗證）
        throw new UnsupportedOperationException("見 09-spring-security 第 04 章");
    }
}
```

```java
package example.shop.order.service;

/**
 * 測試用的事件注入點（7.11.4 的 SSE 整合測試需要「從外部觸發一個事件」）。
 *
 * <p>★★ 為什麼它在<b>正式碼</b>而不是測試碼：
 * 因為 SSE 的事件來源本來就是 Service 層 ——
 * 這個介面是 {@code OrderEventStreamController} 與
 * 「訂單狀態改變」之間的那個縫（05 章 5.11.6）。
 * 測試只是<b>另一個呼叫端</b>。
 *
 * <p>⚠️ 而如果它只有測試用得到，那就是一個設計訊號：
 * 代表「事件是怎麼發出去的」還沒有被想清楚。
 */
public interface OrderEventPublisher {

    /**
     * 發布一個訂單事件到所有訂閱者。
     *
     * @param eventId ★ 客戶端會用它當 {@code Last-Event-ID}（05 章 5.11.5）
     */
    void publish(String orderId, String eventId, String status);
}
```

```java
package example.shop.test.mother;

import example.shop.common.web.PageResponse;
import example.shop.order.web.dto.OrderSummary;

import java.util.List;

/** 分頁回應的 fixture。 */
public final class PageFixtures {

    private PageFixtures() {}

    public static PageResponse<OrderSummary> 兩筆訂單() {
        return new PageResponse<>(
                List.of(Orders.訂單摘要("ord_01J5GKA1"), Orders.訂單摘要("ord_01J5GKA2")),
                new PageResponse.PageInfo(1, 20, 2, 1));
    }

    /** ★ 空頁 —— 測「集合永不為 null」（06 章 6.5.9）。 */
    public static PageResponse<OrderSummary> 空的一頁() {
        return new PageResponse<>(List.of(), new PageResponse.PageInfo(1, 20, 0, 0));
    }
}
```

```java
package example.shop.test.mother;

import example.shop.order.web.dto.OrderItemDto;

import java.math.BigDecimal;

/** 訂單項目的 fixture。 */
public final class Items {

    private Items() {}

    /**
     * @param quantity 數量
     *
     * ★ 金額是 {@code String}（06 章 6.5.7 的決定），
     *   而且值是<b>寫死的</b>而不是 {@code MoneyFormat.format(...)} 算的（7.12.2）。
     */
    public static OrderItemDto 無線滑鼠(int quantity) {
        return new OrderItemDto("P-1001", "無線滑鼠", quantity, "1280.50",
                MoneyFixtures.multiply("1280.50", quantity));
    }

    public static OrderItemDto 機械鍵盤(int quantity) {
        return new OrderItemDto("P-2002", "機械鍵盤", quantity, "2990.00",
                MoneyFixtures.multiply("2990.00", quantity));
    }
}
```

```java
package example.shop.test.mother;

import example.shop.order.web.dto.ShippingAddressDto;

/** 地址的 fixture。 */
public final class Addresses {

    private Addresses() {}

    public static ShippingAddressDto 台北市中正區() {
        return new ShippingAddressDto(
                "adr_01J5GKA1B2C3D4E5F6G7H8",
                "王小明",
                "0912****78",                 // ★ 已遮蔽（06 章 6.6.2 的 MaskedPhone）
                "10041",
                "台北市中正區重慶南路一段 122 號",
                null);
    }
}
```

⚠️ **`Items` 用到的 `MoneyFixtures.multiply(...)` 是刻意的**：
`quantity` 是參數，所以小計必須算 —— 但它**用的不是 `MoneyFormat`**：

```java
package example.shop.test.mother;

/**
 * 測試用的金額運算。
 *
 * <p>★★ 它<b>刻意不用</b> {@code MoneyFormat} —— 那會變成 7.12.2 的反模式
 * （用被測邏輯算期望值）。
 *
 * <p>這裡用一個「獨立而且刻意笨」的實作：{@code BigDecimal} 直接乘、
 * 固定兩位小數。<b>如果它與 {@code MoneyFormat} 的結果不一致，
 * 那正是我們想知道的事。</b>
 */
final class MoneyFixtures {

    private MoneyFixtures() {}

    static String multiply(String unitPrice, int quantity) {
        return new java.math.BigDecimal(unitPrice)
                .multiply(java.math.BigDecimal.valueOf(quantity))
                .setScale(2, java.math.RoundingMode.UNNECESSARY)   // ★ 不該需要捨入
                .toPlainString();
    }
}
```

⚠️ **`RoundingMode.UNNECESSARY` 在這裡是一個斷言**：
`1280.50 × 2` 不該需要捨入。需要的話就是 fixture 的資料設計有問題
（而那比「測試通過但金額是錯的」好）。

#### 練習 3 用到的兩個例外

```java
package example.shop.order.domain;

import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;

import java.util.List;
import java.util.Map;

/**
 * 兩張訂單不屬於同一個客戶 —— 無法合併（7.16 練習 3）。
 *
 * <p>★ 422 而不是 409：這不是「狀態不允許」而是「請求的組合本身不合法」——
 * 重新取得資源再重試也不會成功（03-rest-api 4.9 的 retry 語意）。
 *
 * <p>⚠️ 而 {@code extensions} 刻意<b>不</b>包含另一張訂單的 {@code customerId} ——
 * 那會告訴呼叫者「那張訂單屬於誰」（一個資訊洩漏，03 章 3.11.2）。
 */
public class OrdersNotSameCustomerException extends BusinessException {

    public OrdersNotSameCustomerException(String targetOrderId, String sourceOrderId) {
        super(ErrorCode.ORDERS_NOT_MERGEABLE,
              "Orders %s and %s belong to different customers."
                      .formatted(targetOrderId, sourceOrderId),
              null,
              Map.of("targetOrderId", targetOrderId,
                     "sourceOrderId", sourceOrderId,
                     "hint", "只能合併同一個客戶的訂單。"),
              new Object[0],
              List.of());
    }
}
```

```java
package example.shop.order.domain;

import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;

import java.util.List;
import java.util.Map;

/**
 * 訂單的狀態不允許被合併（7.16 練習 3）。
 *
 * <p>★ 409 而不是 422：狀態是會變的 ——
 * 一張 {@code SHIPPED} 的訂單不會變回 {@code PAID}，
 * 但呼叫者「重新取得資源」之後至少知道為什麼（03 章 3.7.3）。
 *
 * <p>★ {@code alternativeAction} 是 03 章 3.7.3 的做法：
 * 「那你可以做什麼」比「你不能做什麼」有用得多。
 */
public class OrderNotMergeableException extends BusinessException {

    public OrderNotMergeableException(String orderId, OrderStatus currentStatus) {
        super(ErrorCode.ORDER_NOT_MERGEABLE,
              "Order %s is in %s and cannot be merged."
                      .formatted(orderId, currentStatus),
              null,
              Map.of("orderId", orderId,
                     "currentStatus", currentStatus.name(),
                     "mergeableStatuses", List.of("PENDING_PAYMENT", "PAID"),
                     "alternativeAction", Map.of(
                             "code", "REQUEST_RETURN",
                             "label", "申請退貨")),
              new Object[0],
              List.of());
    }
}
```

⚠️ **這兩個例外需要兩個新的 `ErrorCode`**
（★ 加上它們之後全書共 **85** 個 —— 而練習 3 的重點之一就是
「新增一個 code 要同時動四個地方：enum、i18n、`orders-api.yaml`、
以及 `PLANNED_FOR_LATER` 的決定」）：

```java
    // ── 新增於 07 章練習 3 ────────────────────────────────────────
    ORDERS_NOT_MERGEABLE  (HttpStatus.UNPROCESSABLE_ENTITY, "orders-not-mergeable"),
    ORDER_NOT_MERGEABLE   (HttpStatus.CONFLICT,             "order-not-mergeable",
                           Retry.REFETCH_THEN_RETRY),
```

```properties
error.ORDERS_NOT_MERGEABLE.title=訂單無法合併
error.ORDERS_NOT_MERGEABLE.user=只能合併同一位客戶的訂單。
error.ORDER_NOT_MERGEABLE.title=訂單狀態無法合併
error.ORDER_NOT_MERGEABLE.user=訂單目前的狀態（{0}）無法合併。
```

★ **而 7.8.2 的 `ErrorCodeContractTest` 會在你只加了 enum 常數、
還沒加訊息與 `orders-api.yaml` 條目時立刻紅燈** ——
那五個測試方法是這一整套機制的回報。

---

### 7.14.4 完整的測試地圖

**這張表是 07 章的總結，也是最常回頭查的那一張。**

| 要驗證的東西 | 層級 | 檔案 | 章節 |
|---|---|---|---|
| **路由與綁定** | | | |
| 靜態路徑贏過路徑變數 | ③ | `OrderControllerTest` | 7.5.3 |
| HTTP → Command 的翻譯 | ③ | `OrderControllerBindingTest` | **7.6.5** |
| 查詢參數的編碼與中文 | ③ | 同上 | 7.5.2 |
| 尾斜線的行為（Boot 3） | ④ | `RealHttpBehaviourTest` | 01 章 |
| **驗證** | | | |
| 每一種壞輸入的回應 | ③ | `OrderControllerBadInputTest` | **7.7.6** |
| 驗證訊息的 i18n | ④ | `ValidationMessageTest` | 02 章 |
| 分頁參數的邊界 | ② | `PageableGuardInterceptorTest` | 7.4.6 |
| **錯誤處理** | | | |
| 83 個 code 的完整契約 | ④ | `ErrorCodeContractTest` | **7.8.2** |
| 每種例外的 HTTP 回應 | ③ | `OrderControllerErrorTest` | 03 章 |
| 每種例外都有 advice 接 | ③ | `AdviceCoverageTest` | 7.5.9 |
| 資訊洩漏 | ④ | `SensitiveFieldScanTest` | 06 章 |
| 四層格式一致 | ④ | `CorsOnAllErrorPathsTest` | 7.11.3 |
| **請求生命週期** | | | |
| filter 順序 | ④ | `FilterOrderTest` | **7.11.2** |
| filter 真的掛上了 | ③ | `FiltersAppliedInSliceTest` | 7.4.4 |
| traceId 在非同步不變 | ③ | `OrderCsvExportControllerTest` | 7.5.6 |
| 限流 | ③ | `RateLimitTest` | 7.5.2 |
| 冪等 | ④ | `IdempotencyIntegrationTest` | 04 章 |
| **檔案與串流** | | | |
| 檔名攻擊 | ①+③ | `SafeFilenameTest` + `ProductImageControllerTest` | **7.5.7** |
| magic number | ① | `ContentTypeDetectorTest` | 05 章 |
| Range 分段 | ④′ | `RealHttpBehaviourTest` | 7.11.5 |
| chunked 串流 | ④′ | 同上 | 7.11.5 |
| SSE 線路格式 | ③ | `OrderEventStreamControllerTest` | 7.5.8 |
| SSE 心跳/斷線/重連 | ④′ | `OrderEventStreamIntegrationTest` | **7.11.4** |
| **關機時 SSE 被主動結束** | ④′ | `SseShutdownIntegrationTest` | 05 章 5.11.10 |
| **關機的三個數字不等式** | ① | `ShutdownTimingConsistencyTest` | 05 章 5.11.10 |
| **CORS 與序列化** | | | |
| preflight | ④′ | `CorsIntegrationTest` | 06 章 |
| 每種錯誤都有 CORS | ④′ | `CorsOnAllErrorPathsTest` | 7.11.3 |
| Jackson 設定沒被改 | ③ | `JacksonContractTest` | 06 章 |
| 金額格式 | ① | `MoneyFormatTest` | 7.12.2 |
| enum 的 label 完整 | ④ | `AllExposedEnumsHaveLabelsTest`（需要真的 `MessageSource`） | **7.8.3** |
| 全 null 也能序列化 | ① | `DtoSerializabilityTest` | 06 章 |
| JSON 炸彈 | ④ | `JsonBombTest` | 06 章 |
| gzip 壓縮 | ④′ | `RealHttpBehaviourTest` | 7.11.5 |
| **安全性** ★★ | | | |
| 功能層級授權（70×5） | ④ | `AuthorizationMatrixTest` | **7.9.3** |
| 矩陣涵蓋所有端點 | ④ | `AuthzMatrixCompletenessTest` | **7.9.4** |
| 資源層級授權（IDOR） | ④+DB | `ObjectLevelAuthorizationTest` | **7.9.5** |
| 查詢服務簽名有 Actor | ArchUnit | `QueryServiceRequiresActorTest` | 7.6.4 |
| 沒有 `addFilters=false` | ArchUnit | `NoBlanketFilterDisablingTest` | 7.4.3 |
| **契約與文件** | | | |
| 符合 orders-api.yaml | ③ | 自動（`ContractValidationConfig`） | **7.10.2** |
| 文件由測試產生 | ③ | `*DocumentationTest` | 7.10.3 |
| 客戶端用到的欄位還在 | ③ | `ConsumerFieldUsageTest` | 7.10.5 |
| 範例回應不過期 | ③ | `check-doc-examples.sh` | 7.5.5 |
| **測試自身的健康** | | | |
| context 數量在預算內 | 腳本 | `check-context-count.sh` | 7.4.5 |
| 每個測試類別有 tag | ArchUnit | `AllTestsHaveTagTest` | 7.13.1 |
| 沒有過期的 `@Disabled` | ArchUnit | `NoExpiredDisabledTestsTest` | 7.13.4 |
| 不只斷言狀態碼 | 腳本 | `check-assertion-quality.sh` | 7.12.1 |
| 覆蓋率不下降 | 腳本 | `check-coverage-trend.sh` | 7.13.5 |
| **正式 context 起得來** | ④ | `ApplicationContextLoadsTest` | 7.14.2 |

---

## 7.15 常見誤區

**誤區 1：「`@WebMvcTest` 就是 Controller 的單元測試」**

它不是單元測試 —— 它啟動了一個 Spring context，
載入了所有 advice、interceptor、converter、`ObjectMapper` 與 filter（7.4.1）。
**那正是它的價值**：它測的是「你的設定 + 你的 Controller」的組合行為。

**誤區 2：「`addFilters = false` 只是關掉 filter 而已」**

它關掉了**所有** filter，包含 Spring Security ——
於是那個測試類別的所有測試都在「沒有認證與授權」的環境下跑（7.2.1、7.4.3）。

**誤區 3：「測試變慢是因為測試太多」**

7.13.3 的帳：刪掉 34 個測試只省 12 秒，
而把 context 從 89 個降到 6 個省了 18 分半。
**慢的原因幾乎總是 context 數量與序列執行，不是測試數量。**

**誤區 4：「`status().isOk()` 至少證明它沒壞」**

它證明的是「狀態碼是 200」。
而 mock 沒 stub 時回傳 `null` → Controller 回傳 `null` →
**200 + 空 body**（7.2.3、7.6.3）。

**誤區 5：「用 builder 產生 JSON 比較安全，不會寫錯」**

它確實不會寫出語法錯的 JSON ——
但它也**測不到線路格式的問題**（7.7.5）。
序列化與反序列化用同一套設定，往返一定成功。

**誤區 6：「`@Transactional` 讓測試自動回滾，很方便」**

它同時關掉了 `AFTER_COMMIT` 的事件、真正的交易邊界、
延遲的資料庫約束，以及「別的執行緒看得到嗎」（7.2.4、7.12.4）。

**誤區 7：「授權測試在 `@WebMvcTest` 裡做就好」**

切片裡的 `SecurityFilterChain` 可能是自動設定的預設值而不是你的（7.4.3），
而 filter 順序也不保證一致（7.9.6）。

**誤區 8：「授權矩陣測完就安全了」**

矩陣測的是「角色能不能呼叫端點」（功能層級）。
**「客戶 A 能不能看客戶 B 的訂單」（資源層級）完全不在裡面** ——
而那是 OWASP API Security 的第一名（7.9.5）。

**誤區 9：「覆蓋率 90% 代表測試很完整」**

7.2.3 的那個測試（只斷言 200）會讓整個方法變成「已覆蓋」。
**覆蓋率量的是「跑過」，不是「驗證過」**（7.13.5）。
突變測試才量後者（7.13.6）。

**誤區 10：「flaky 測試加 `rerunFailingTestsCount` 就解決了」**

那是把「不穩定的訊號」變成「沒有訊號」。
一旦團隊習慣重跑，**真正的失敗也會被重跑掉**（7.13.4）。

**誤區 11：「用 `MoneyFormat.format(...)` 算期望值比較不會寫錯」**

那讓測試斷言「`MoneyFormat` 等於 `MoneyFormat`」——
不管它被改成什麼樣都會通過（7.2.5、7.12.2）。

**誤區 12：「`verifyNoMoreInteractions` 讓測試更嚴謹」**

它把「實作剛好呼叫了哪些方法」變成契約 ——
加一行合理的程式碼就紅燈（7.12.5）。

**誤區 13：「mock 掉那個 filter 就不會干擾了」**

Mockito 的 `Filter` mock **不呼叫 `chain.doFilter()`** ——
請求在那裡就停住了，所有回應變成 200 + 空 body（7.4.4）。

**誤區 14：「`getContentAsString()` 就是回應內容」**

它用回應的 character encoding，沒設時是 `ISO-8859-1` ——
中文會亂碼。要用 `getContentAsString(StandardCharsets.UTF_8)`（7.5.4）。

**誤區 15：「`jsonPath(...).doesNotExist()` 代表欄位不存在」**

它對「值是 `null`」也通過 ——
分不出「缺欄位」與「值為 null」，而那正是 06 章 6.5.9 的核心區分（7.5.4）。

**誤區 16：「`@MockitoBean` 是 `@MockBean` 的新名字，可以直接換」**

`@MockitoBean` 是 **Spring Framework 6.2（Boot 3.4）**才有的。
在 Boot 3.2/3.3 上那一行不會編譯（7.6.1）——
**而本課程 03 章有一處就寫錯了，這一章有修正**。

**誤區 17：「`@Tag` 沒標也沒關係，反正測試會跑」**

如果 Surefire 的設定是「明確列出要跑的 group」（7.13.2 就是），
**沒有 tag 的測試從來不會執行**（7.13.1）。

**誤區 18：「整合測試越多越好，那才是真的測試」**

整合測試慢 30～100 倍，而且失敗訊息通常指不出原因。
它的正確角色是**驗證「切片測不到的那些」**（7.11.1 那張表），
而不是重複切片已經測過的東西。

---
## 7.16 本章練習

### 練習 1：找出這個測試類別的 11 個問題

```java
package example.shop.order.web;

import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.*;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.transaction.annotation.Transactional;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@WebMvcTest(OrderController.class)
@AutoConfigureMockMvc(addFilters = false)
@Transactional
class OrderControllerTest {

    @Autowired MockMvc mockMvc;
    @MockBean OrderService orderService;
    @MockBean OrderQueryService orderQueryService;
    @MockBean RateLimiter rateLimiter;
    @MockBean IpRateLimitFilter ipRateLimitFilter;

    static String createdOrderId;

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void test1() throws Exception {
        var result = mockMvc.perform(post("/orders")
                        .contentType("application/json")
                        .content(mapper.writeValueAsString(
                                new CreateOrderRequest(
                                        List.of(new OrderItemRequest("P-1001", 2)),
                                        sampleAddress(), null))))
                .andExpect(status().isCreated())
                .andReturn();
        createdOrderId = JsonPath.read(
                result.getResponse().getContentAsString(), "$.orderId");
    }

    @Test
    void test2() throws Exception {
        when(orderQueryService.findDetail(any(), any())).thenReturn(sampleDetail());

        mockMvc.perform(get("/orders/" + createdOrderId))
                .andExpect(status().isOk());

        verify(orderQueryService).findDetail(any(), any());
        verifyNoMoreInteractions(orderQueryService);
    }

    @Test
    void test3() throws Exception {
        when(orderService.create(any())).thenThrow(
                new InsufficientStockException("P-1001", "無線滑鼠", 5, 3, null, 0));

        mockMvc.perform(post("/orders").contentType("application/json").content("{}"))
                .andExpect(status().isConflict());

        Thread.sleep(2000);
        assertThat(auditRepository.findAll()).isNotEmpty();
    }

    @Test
    void test4() throws Exception {
        when(orderQueryService.findDetail(any(), any())).thenReturn(sampleDetail());

        mockMvc.perform(get("/orders/ord_1"))
                .andExpect(jsonPath("$.totalAmount")
                        .value(MoneyFormat.format(new BigDecimal("1280.50"), "TWD")))
                .andExpect(jsonPath("$.createdAt")
                        .value(Instant.now().toString()));
    }
}
```

<details>
<summary>解答</summary>

**① `@AutoConfigureMockMvc(addFilters = false)`（7.4.3）**

關掉了所有 filter，包含 Spring Security。
**這個類別的所有測試都在「沒有認證與授權」的環境下跑** ——
7.2.1 的資料洩漏事故就是這樣發生的。

**修**：移除它，改成 `extends WebSliceTest`（7.4.5）。

**② `@Transactional` 在 `@WebMvcTest` 上（7.12.4）**

⚠️ **它不是「什麼都不做」——它會讓整個類別跑不起來。**

`TransactionalTestExecutionListener` 在每個測試方法之前會找
`PlatformTransactionManager`，找不到就拋：

```
java.lang.IllegalStateException: Failed to retrieve PlatformTransactionManager
for @Transactional test: [DefaultTestContext@... testClass = OrderControllerTest, ...]
```

而 `@WebMvcTest` 的切片**不包含 `DataSourceAutoConfiguration`
也不包含任何 `TransactionManager`** —— 所以**每一個測試方法都是紅燈**。

★ **這個失敗方式其實是好的**（大聲、訊息清楚）。
真正危險的是有人為了「修掉它」而把 `@WebMvcTest` 換成 `@SpringBootTest` ——
那時 `@Transactional` 就開始掩蓋 `AFTER_COMMIT` 的行為（7.2.4），
而且多了一個 Spring context（7.4.5）。

**修**：刪掉 `@Transactional`。

**③ `@MockBean IpRateLimitFilter`（7.4.4）**

**mock 的 `Filter` 不呼叫 `chain.doFilter()`** ——
請求在那裡停住，所有回應變成 200 + 空 body。
（在這個類別裡因為 ② 的 `addFilters = false`，它剛好不會發作 ——
**兩個 bug 互相掩蓋**，正是 7.2.4 那種形狀。）

**修**：刪掉這個 mock，改用 `WebSliceInfraConfig` 提供真的 `InMemoryRateLimiter`。

**④ `@MockBean RateLimiter` 沒有 stub（7.6.3）**

`tryConsume(...)` 回傳 `null` → interceptor NPE。
（同樣被 ② 掩蓋了。）

**修**：同上。

**⑤ `new ObjectMapper()`（7.6.6、06 章 6.5.2）**

它缺了 06 章的**所有**設定 ——
`use-big-decimal-for-floats`、`JavaTimeModule`、命名策略、
`FixedPrecisionInstantSerializer`……
於是這個測試產生的 JSON **與真實客戶端送的不一樣**。

**修**：`@Autowired ObjectMapper objectMapper;`

**⑥ 用 `writeValueAsString` 產生請求 JSON（7.7.5）**

即使用了正確的 `ObjectMapper`，這個寫法仍然**測不到線路格式** ——
序列化與反序列化互為反函式，往返一定成功。

**修**：用寫死的 JSON 字串。

**⑦ 測試名字 `test1` / `test2` / `test3` / `test4`（7.12.7）**

讀名字看不出任何規則。

**修**：`下單成功回201與Location()`、`庫存不足回409()` 等。

**⑧ `static String createdOrderId` 造成測試相依（7.12.9）**

`test2` 依賴 `test1` 先執行。而 JUnit 5 的預設順序是
「確定性但未指定」的，且 7.13.2 開啟平行執行後兩者可能同時跑。

**修**：`test2` 自己準備資料（stub `findDetail` 本來就已經 stub 了，
`createdOrderId` 根本沒用到 —— 直接寫死 `"ord_1"`）。

**⑨ `verifyNoMoreInteractions`（7.12.5）**

把「實作剛好呼叫了哪些方法」變成契約。

**修**：刪掉。改成有意義的 `verify`，
例如「有把 actor 傳下去」（7.6.5）。

**⑩ `Thread.sleep(2000)`（7.12.8）**

慢且不可靠。而且在 `@WebMvcTest` 裡稽核是同步寫的（沒有非同步），
所以這個 sleep **純粹是浪費 2 秒**。

**修**：直接斷言；真的需要等非同步時用 `await().untilAsserted(...)`。

**⑪ 用被測邏輯算期望值 + `Instant.now()`（7.12.2、7.2.5）**

```java
.value(MoneyFormat.format(new BigDecimal("1280.50"), "TWD"))   // 自我斷言
.value(Instant.now().toString())                                // ★ 必定失敗
```

`Instant.now()` 每次都不一樣，而且與回應裡的時間**永遠差幾毫秒** ——
這個斷言 100% 失敗。

**修**：
```java
.value("1280.50")                           // ★ 寫死（TWD 是 2 位小數，06 章 6.5.7）
.value("2026-08-24T02:30:00.000Z")          // 用固定 Clock 的時間（7.4.4）
```

**★ 額外觀察：`test3` 還有一個更根本的問題。**

```java
mockMvc.perform(post("/orders").contentType("application/json").content("{}"))
        .andExpect(status().isConflict());
```

`{}` 缺必填欄位 → Bean Validation 擋下 → **422，不是 409**。
`orderService.create()` 根本不會被呼叫，那個 `thenThrow` 完全沒用到。

**這個測試會失敗** —— 但如果有人「修」成 `status().is4xxClientError()`，
它就會變成一個永遠通過但什麼都沒測的測試。

**修正後的完整版本**：

```java
package example.shop.order.web;

import example.shop.test.WebSliceTest;
import example.shop.test.WithActor;
import example.shop.test.mother.Orders;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.matchesPattern;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@DisplayName("OrderController")
@WithActor(type = ActorType.CUSTOMER, id = "cust_01J5GKA")
class OrderControllerTest extends WebSliceTest {

    // ★ 欄位與 02 章 2.12.1 的正式版一致 —— 多一個欄位就會因為
    //   fail-on-unknown-properties: true（06 章 6.5.5）變成 400
    private static final String VALID_BODY = """
            {"items":[{"productId":"P-1001","quantity":2}],
             "shippingAddressId":"adr_01J5GKA1B2C3D4E5F6G7H8",
             "customerNote":"請放門口"}
            """;

    @Test
    void 下單成功回201與Location() throws Exception {
        when(orderService.create(any())).thenReturn(Orders.剛建立的訂單());

        mockMvc.perform(post("/orders")
                        .header("Idempotency-Key", "idem-create-1")
                        .contentType(APPLICATION_JSON)
                        .characterEncoding(UTF_8)
                        .content(VALID_BODY))
                .andExpect(status().isCreated())
                .andExpect(header().string("Location",
                        matchesPattern("/orders/ord_[0-9A-HJKMNP-TV-Z]{26}")))
                .andExpect(jsonPath("$.orderId").isNotEmpty())
                .andExpect(jsonPath("$.status").value("PENDING_PAYMENT"))
                .andExpect(jsonPath("$.statusLabel").value("待付款"));
    }

    @Test
    void 下單會把actor與冪等鍵傳給Service() throws Exception {
        when(orderService.create(any())).thenReturn(Orders.剛建立的訂單());

        mockMvc.perform(post("/orders")
                        .header("Idempotency-Key", "idem-create-2")
                        .contentType(APPLICATION_JSON).characterEncoding(UTF_8)
                        .content(VALID_BODY))
                .andExpect(status().isCreated());

        var captor = ArgumentCaptor.forClass(CreateOrderCommand.class);
        verify(orderService).create(captor.capture());

        assertThat(captor.getValue().actor().id()).isEqualTo("cust_01J5GKA");
        assertThat(captor.getValue().idempotencyKey()).isEqualTo("idem-create-2");
    }

    @Test
    void 查詢訂單回完整明細() throws Exception {
        when(orderQueryService.findDetail(eq("ord_01J5GKA1"), any(Actor.class)))
                .thenReturn(Orders.已付款的單品訂單());

        mockMvc.perform(get("/orders/{orderId}", "ord_01J5GKA1"))
                .andExpect(status().isOk())
                .andExpect(ResponseMatchers.hasNonEmptyJsonObject())
                .andExpect(jsonPath("$.orderId").value("ord_01J5GKA1"))
                .andExpect(jsonPath("$.statusLabel").value("已付款"))
                .andExpect(jsonPath("$.totalAmount").value("1280.50"))
                .andExpect(jsonPath("$.createdAt").value("2026-08-24T02:30:00.000Z"));
    }

    @Test
    void 庫存不足回409() throws Exception {
        when(orderService.create(any())).thenThrow(new InsufficientStockException(
                "P-1001", "無線滑鼠", 2, 1, LocalDate.of(2026, 8, 28), 0));

        mockMvc.perform(post("/orders")
                        .header("Idempotency-Key", "idem-create-3")
                        .contentType(APPLICATION_JSON).characterEncoding(UTF_8)
                        .content(VALID_BODY))                   // ★ 合法的 body
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("INSUFFICIENT_STOCK"))
                .andExpect(jsonPath("$.available").value(1));
    }

    @Test
    void 缺必填欄位回422而不是400() throws Exception {
        // ★ 明確測 06 章 6.5.3 的決定
        mockMvc.perform(post("/orders")
                        .header("Idempotency-Key", "idem-create-4")
                        .contentType(APPLICATION_JSON).content("{}"))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.code").value("VALIDATION_FAILED"))
                .andExpect(jsonPath("$.errors[*].field",
                        containsInAnyOrder("items", "shippingAddressId")));
    }
}
```

</details>

---

### 練習 2：預測這 10 種情況的結果

假設 shop-service 的設定如本課程 00～06 章所述。
**對每一種情況，說出測試會通過、失敗，還是「通過但沒測到東西」。**

| # | 情況 |
|---|---|
| 1 | `@WebMvcTest(OrderController.class)`，測試斷言 `jsonPath("$.statusLabel").value("已付款")`，但沒有 `@Import(WebSliceInfraConfig.class)` |
| 2 | `@WebMvcTest`，斷言 `header().string("Content-Encoding", "gzip")` |
| 3 | `@WebMvcTest`，忘了 stub `orderQueryService.list()`，斷言 `status().isOk()` |
| 4 | `@WebMvcTest`，忘了 stub `orderQueryService.list()`，斷言 `jsonPath("$.content", hasSize(2))` |
| 5 | `mockMvc.perform(get("/orders").param("status", "PAID"))`，而 `QueryMasker` 斷言遮蔽後的 query string 是 `status=PAID` |
| 6 | `@SpringBootTest` + `@Transactional`，斷言 `AFTER_COMMIT` 的 listener 有執行 |
| 7 | `content().json("{\"orderId\":\"ord_1\"}")`（LENIENT），而回應多了一個 `internalCostPrice` 欄位 |
| 8 | `jsonPath("$.errorCount").value(3L)`，而回應是 `"errorCount": 3` |
| 9 | SSE 測試裡 `asyncDispatch(started)` 但沒有呼叫 `emitter.complete()` |
| 10 | 授權矩陣測試裡，`POST /orders` 的 body 是 `{}`，而期望值是 403 |

<details>
<summary>解答</summary>

**1. 🔴 失敗（但不是你想的那個原因）**

`@WebMvcTest` 會載入 `Filter` bean（7.4.1），
而 `IpRateLimitFilter` 需要 `RateLimiter`（`@Component`，不會被載入）。

**context 根本起不來**：

```
Parameter 0 of constructor in IpRateLimitFilter required a bean of type
'RateLimiter' that could not be found.
```

**所以失敗訊息與 `statusLabel` 完全無關** —— 這是 7.4.4 的核心。

**2. 🔴 失敗，永遠。**

MockMvc 不經過 Servlet 容器，**從不壓縮**（7.5.9 第 1 點）。
`server.compression` 在切片裡完全無效。

**修**：改成 ④′ 整合測試（7.11.5）。

**3. ⚠️ 通過，但什麼都沒測到。**

`list()` 回傳 `null` → Controller 回傳 `null` →
Spring 不寫 body → **200 + 空 body**（7.6.3）。

**4. 🔴 失敗**，訊息是：

```
java.lang.AssertionError: No value at JSON path "$.content"
```

**⚠️ 而這個訊息會誤導你去找「為什麼 content 不見了」** ——
真正的原因是「mock 沒 stub」。
（如果第一個斷言是 `status().isOk()`，MockMvc 會印出完整回應，
你就會看到 body 是空的 —— **這就是「`status()` 放第一個」的價值**，7.5.4 陷阱六。）

**5. 🔴 失敗。**

`.param()` **不會產生 query string**（7.5.2 陷阱一）——
`request.getQueryString()` 是 `null`，
所以 `QueryMasker` 拿到的是 `null`。

**修**：`get("/orders?status=PAID")` 或 `.queryParam(...)`。

**6. 🔴 失敗。**

`@Transactional` 的測試永遠不 commit →
`@TransactionalEventListener(AFTER_COMMIT)` 永遠不執行（7.2.4、7.12.4）。

⚠️ **但如果那個類別裡有別的測試先跑過並留下 mock 的呼叫紀錄，
它可能「通過」** —— 兩個 bug 疊成一個綠燈。

**7. ⚠️ 通過。**

LENIENT 模式只檢查「期望的欄位都在且相符」，**多的欄位不管**（7.5.3）。

**這正是 06 章 6.7.5 想防的資訊洩漏，而 LENIENT 抓不到。**

**修**：`content().json(expected, true)`（STRICT），
或用 7.10.2 的 OpenAPI 驗證（若 schema 有 `additionalProperties: false`）。

**8. 🔴 失敗。**

```
JSON path "$.errorCount" expected: <3L> but was: <3>
```

Jayway 把 JSON 數字解析成 `Integer`，
而 `Integer.valueOf(3).equals(3L)` 是 `false`（7.5.4 陷阱一）。

**修**：`.value(3)` 或 `.value(comparesEqualTo(3))`。

**9. 🔴 失敗，而且失敗方式很難懂。**

`asyncDispatch` 會等到 MockMvc 的預設逾時（1 秒），
然後拋出一個看起來與 SSE 無關的例外（7.5.8）。

**修**：`emitter.complete()` 放在 `finally` 裡。

**10. ⚠️⚠️ 通過，但完全沒有驗證授權。**

`{}` 缺必填欄位 → **422**。而 422 ≠ 403 → **測試失敗**……

**等等，題目說期望值是 403，而實際是 422 → 失敗。**

**但真正的陷阱在另一個方向**：
如果矩陣的某一列期望是 **201**，而 body 是 `{}` →
實際是 422 → 失敗 → 有人會「修」成把期望值改成 422 →
**從此那個端點的授權永遠不會被驗證**（因為不管授權有沒有生效，
驗證都會先擋下來回 422）。

**這就是 `ValidBodies` 為什麼在 `default` 分支拋例外**（7.14.3）。

</details>

---

### 練習 3：為一個新端點設計完整的測試

**需求**：新增一個端點，讓客服可以「合併兩張訂單」。

```
POST /orders/{orderId}/merges

Request:
  {
    "sourceOrderId": "ord_01J5GKB9",
    "reason": "客戶重複下單"
  }

規則：
  · 只有 SUPPORT 與 ADMIN 可以呼叫
  · 兩張訂單必須屬於同一個客戶
  · 兩張都必須是 PENDING_PAYMENT 或 PAID
  · 合併後 sourceOrder 變成 MERGED 狀態
  · 需要冪等鍵
  · 要留稽核紀錄
  · 成功回 200 + 合併後的訂單明細
```

**任務**：列出你會寫哪些測試、各用什麼層級、以及**每個測試守住什麼**。

<details>
<summary>解答</summary>

**第一步：先問「哪些規則屬於 Web 層」。**

| 規則 | 屬於 | Web 層測什麼 |
|---|---|---|
| 只有 SUPPORT/ADMIN | **Security 設定** | 授權矩陣的一列 |
| 兩張訂單同一個客戶 | **Service** | 「例外 → 409/422」的翻譯 |
| 狀態必須是 PENDING/PAID | **Domain + Service** | 同上 |
| sourceOrder 變成 MERGED | **Service** | 不測（Web 層看不到） |
| 需要冪等鍵 | **Filter/Interceptor** | 缺鍵 → 400 |
| 留稽核紀錄 | **AuditFilter / Service** | Web 層測「有寫」 |
| 回 200 + 明細 | **Web 層** ★ | 完整測 |

**第二步：清單。**

**① 授權矩陣加一列（④，7.9.3）**

```csv
POST,/orders/{orderId}/merges,401,403,200,403,200,★ 只有客服與管理員可合併訂單
```

**守住**：客戶不可以合併自己的訂單（避免規避某些促銷規則）。
**這一列是免費的** —— 加進 CSV 就自動被測。

⚠️ 同時要在 `ValidBodies` 加上這個端點的合法 body（7.14.3），
否則 `AuthzMatrixCompletenessTest` 會紅燈告訴你。

**② 端點清單完整性（④）—— 自動**

`AuthzMatrixCompletenessTest`（7.9.4）會在你**還沒**加 CSV 那一列時紅燈。
**這就是那個測試存在的意義。**

**③ 快樂路徑（③）**

```java
@Test
@WithActor(type = ActorType.SUPPORT, id = "supp_01J5GK")
void 合併訂單回200與合併後的明細() throws Exception {
    when(orderService.merge(any())).thenReturn(Orders.合併後的訂單());

    mockMvc.perform(post("/orders/{orderId}/merges", "ord_01J5GKA1")
                    .header("Idempotency-Key", "idem-merge-1")
                    .contentType(APPLICATION_JSON).characterEncoding(UTF_8)
                    .content("""
                            {"sourceOrderId":"ord_01J5GKB9","reason":"客戶重複下單"}
                            """))
            .andExpect(status().isOk())
            .andExpect(ResponseMatchers.hasNonEmptyJsonObject())
            .andExpect(jsonPath("$.orderId").value("ord_01J5GKA1"))
            .andExpect(jsonPath("$.items", hasSize(3)))       // 1 + 2
            .andExpect(jsonPath("$.totalAmount").value("2561"))
            .andExpect(jsonPath("$.mergedFrom", contains("ord_01J5GKB9")));
}
```

**守住**：回應的結構與欄位。

**④ 翻譯（③，7.6.5）★ 最重要的一個**

```java
@Test
@WithActor(type = ActorType.SUPPORT, id = "supp_01J5GK")
void 合併請求被正確翻譯成Command() throws Exception {
    when(orderService.merge(any())).thenReturn(Orders.合併後的訂單());

    mockMvc.perform(post("/orders/{orderId}/merges", "ord_01J5GKA1")
                    .header("Idempotency-Key", "idem-merge-2")
                    .contentType(APPLICATION_JSON).characterEncoding(UTF_8)
                    .content("""
                            {"sourceOrderId":"ord_01J5GKB9","reason":"客戶重複下單"}
                            """))
            .andExpect(status().isOk());

    var captor = ArgumentCaptor.forClass(MergeOrdersCommand.class);
    verify(orderService).merge(captor.capture());

    var cmd = captor.getValue();
    // ★★ 路徑變數 → target，body → source（很容易寫反）
    assertThat(cmd.targetOrderId()).isEqualTo("ord_01J5GKA1");
    assertThat(cmd.sourceOrderId()).isEqualTo("ord_01J5GKB9");
    assertThat(cmd.reason()).isEqualTo("客戶重複下單");
    // ★★ actor 有傳下去（Service 要判斷「客服負責這個客戶嗎」）
    assertThat(cmd.actor().type()).isEqualTo(ActorType.SUPPORT);
    assertThat(cmd.actor().id()).isEqualTo("supp_01J5GK");
    assertThat(cmd.idempotencyKey()).isEqualTo("idem-merge-2");
}
```

**守住**：**「target 與 source 沒有寫反」** ——
這是這個端點最可能的 bug，而**回應看不出差別**
（mock 對任何 command 都回傳同一個結果）。

**⑤ 錯誤翻譯（③）**

```java
@ParameterizedTest(name = "{0} → {1} {2}")
@MethodSource("mergeErrors")
void 每一種合併失敗的回應(Exception thrown, int status, String code) throws Exception {
    when(orderService.merge(any())).thenThrow(thrown);
    // ...
}

static Stream<Arguments> mergeErrors() {
    return Stream.of(
            Arguments.of(new ResourceNotFoundException("Order", "ord_x"),
                    404, "RESOURCE_NOT_FOUND"),
            Arguments.of(new OrdersNotSameCustomerException("ord_a", "ord_b"),
                    422, "ORDERS_NOT_MERGEABLE"),
            Arguments.of(new OrderNotMergeableException("ord_b", OrderStatus.SHIPPED),
                    409, "ORDER_NOT_MERGEABLE"),
            Arguments.of(new IdempotencyKeyReusedException("idem-1"),
                    409, "IDEMPOTENCY_KEY_REUSED"));
}
```

**守住**：每種業務例外都有正確的狀態碼與 code。

⚠️ **新的 `ErrorCode` 常數要加**，而 7.8.2 的 `ErrorCodeContractTest`
會立刻告訴你「缺 title / userMessage / OpenAPI 條目」。
**那五個測試方法是免費的覆蓋。**

**⑥ 壞輸入目錄（③，7.7.6）**

```java
// ★ universal()，不是 forCreateOrder() —— 見下方
@ParameterizedTest(name = "[{index}] {0}")
@MethodSource("example.shop.test.BadRequests#universal")
void 合併端點對每一種壞輸入的回應(BadRequests.Case c) throws Exception { ... }
```

**守住**：JSON 語法、未知欄位、炸彈、mass assignment。
**也是免費的** —— 目錄已經存在。

⚠️⚠️ **而「用哪一個方法」是這一小題真正的重點。**

如果套 `forCreateOrder()`，那些驗證類案例的 body 是**下單的**格式 ——
對合併端點來說 `{"items":[...]}` 是「未知欄位」→ **400 而不是 422**，
於是測試紅燈。

**而「修法」很容易變成「把期望值改成 400」——那就再也測不到合併端點的驗證規則了。**

**正確的做法是 `BadRequests` 分成兩組**（7.7.6 已經這樣做了）：

```java
/** ★ 對「任何」接收 JSON 的端點都成立（語法、未知欄位、炸彈）。 */
public static List<Case> universal() { ... }

/** ⚠️ 與 CreateOrderRequest 的欄位有關，只給下單端點用。 */
public static List<Case> forCreateOrder() { ... }   // = universal() + 下單特有的
```

**而合併端點要自己補一組 `forMergeOrders()`**：

```java
/** ⚠️ 與 MergeOrdersRequest 的欄位有關。 */
public static List<Case> forMergeOrders() {
    var all = new ArrayList<>(universal());
    all.addAll(List.of(
            new Case("sourceOrderId 缺少", "{\"reason\":\"客戶重複下單\"}",
                    422, "VALIDATION_FAILED"),
            new Case("sourceOrderId 格式錯誤（@ResourceId）",
                    "{\"sourceOrderId\":\"../../etc/passwd\",\"reason\":\"x\"}",
                    422, "VALIDATION_FAILED"),
            new Case("★ 合併自己（跨欄位驗證，路徑變數 == body 欄位）",
                    "{\"sourceOrderId\":\"ord_01J5GKA1\",\"reason\":\"x\"}",
                    422, "VALIDATION_FAILED"),
            new Case("reason 超過 200 字", "…", 422, "VALIDATION_FAILED")));
    return all;
}
```

★ **注意第三個案例**：「合併自己」的驗證需要同時看**路徑變數與 body** ——
而 Bean Validation 的 `@AssertTrue` 只看得到 DTO。
👉 **這種驗證屬於 Service**（02 章 2.10.3 的界線），
Web 層只負責「把兩個 ID 都傳下去」（第 ④ 項的 `ArgumentCaptor` 測試）。
**這是一個「練習裡才會發現的設計問題」，而發現它的方式是把目錄套到第二個端點上。**

**⑦ 缺冪等鍵（③）**

```java
@Test
void 缺冪等鍵回400() throws Exception {
    mockMvc.perform(post("/orders/ord_1/merges")      // ★ 沒有 Idempotency-Key
                    .contentType(APPLICATION_JSON).content(VALID_MERGE_BODY))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("IDEMPOTENCY_KEY_REQUIRED"));
}
```

**守住**：`@Idempotent` 註解真的加上去了（04 章 4.9）。

**⑧ 冪等的真實行為（④）**

```java
@Test
void 相同的冪等鍵回同一個結果() {
    // 第一次 → 200
    // 第二次（相同 key、相同 body）→ 200，且**不會再呼叫 Service**
    // 第三次（相同 key、不同 body）→ 409 IDEMPOTENCY_KEY_REUSED
}
```

**守住**：冪等的完整語意。**必須是 ④**（跨 filter/interceptor）。

**⑨ 稽核紀錄（③ 或 ④）**

```java
@Test
@WithActor(type = ActorType.SUPPORT, id = "supp_01J5GK")
void 合併會留下稽核紀錄() throws Exception {
    // ... perform ...
    assertThat(auditRepository.findByResourceId("ord_01J5GKA1"))
            .as("客服的寫入操作一定要有稽核（04 章 4.6）")
            .anySatisfy(e -> {
                assertThat(e.actorId()).isEqualTo("supp_01J5GK");
                assertThat(e.action()).isEqualTo("ORDER_MERGE");
                assertThat(e.details()).containsEntry("sourceOrderId", "ord_01J5GKB9");
            });
}
```

**⑩ IDOR（④ + DB，7.9.5）—— 自動**

`ObjectLevelAuthorizationTest` 的 `endpointsWithOrderId()` 會**自動涵蓋**
這個新端點（因為它的 URI 含 `{orderId}`）。

**⑪ OpenAPI 契約（③）—— 自動**

`ContractValidationConfig`（7.10.2）讓所有測試自動驗證 ——
**如果你沒有先在 `orders-api.yaml` 加這個端點，測試會紅燈**。
**contract-first 由此被強制執行。**

**⑫ 文件（③，可選）**

如果它算「核心端點」，加一個 `@AutoConfigureRestDocs` 的測試（7.10.3）。

---

**統計**：

| 類型 | 數量 | 新寫的行數 |
|---|---|---|
| 自動涵蓋（矩陣、IDOR、契約、ErrorCode、壞輸入） | **6** | **~8 行**（CSV 一列 + ValidBodies 一個 case） |
| 需要新寫 | 6 | ~180 行 |

**★ 這就是前面所有基礎設施的回報**：
一個新端點的「安全性、契約、錯誤格式」是免費的，
你只需要寫「這個端點特有的行為」。

</details>

---

### 練習 4：一個「本機過、CI 偶爾失敗」的除錯

**現象**：

```
OrderEventStreamIntegrationTest.客戶端斷線會被清理
  本機：跑 100 次，全過
  CI：  約 1/15 的機率失敗

失敗訊息：
  org.awaitility.core.ConditionTimeoutException:
  Condition with lambda expression was not fulfilled within 5 seconds.
  （期望 registry.size() == 0，實際是 1）
```

**已知**：

- 這個測試在本機（M2，10 核心）從未失敗。
- CI 是 2 核心的 runner。
- 這個測試類別有 6 個測試方法。
- `junit-platform.properties` 設定：
  ```properties
  junit.jupiter.execution.parallel.enabled = true
  junit.jupiter.execution.parallel.mode.classes.default = concurrent
  junit.jupiter.execution.parallel.mode.default = same_thread
  ```
- `registry.size()` 是全域的（`SseEmitterRegistry` 是 singleton）。

**任務**：說出最可能的原因與修法。

<details>
<summary>解答</summary>

**原因：`registry.size()` 是全域的，而測試類別是平行執行的。**

```java
int before = registry.size();     // ← 讀到 0
var subscription = subscribe(...);       // ← 我的連線
await().until(() -> registry.size() == before + 1);   // ← 1
subscription.dispose();
await().until(() -> registry.size() == before);       // ← 期望 0
//                                            ↑
//        ⚠️ 但**另一個測試類別**的 SSE 連線這時候也開著 → 是 1
```

**`mode.classes.default = concurrent` 讓不同的測試類別同時跑**，
而 `SseEmitterRegistry` 是**整個 context 共用的 singleton**。

**為什麼本機不會**：10 核心的機器上，
6 個測試方法在 `same_thread` 模式下依序跑得很快，
而其他測試類別的 SSE 測試「剛好」不在同一個時間窗。
**2 核心的 CI 上排程更緊湊，碰撞機率大增。**

**四個修法，由好到壞**：

**修法 A（★ 最好）：不依賴全域計數，改成「查我自己的那個」。**

```java
@Test
void 客戶端斷線會被清理() {
    String actorId = "cust_" + java.util.UUID.randomUUID();   // ★ 唯一

    var subscription = subscribeAs(actorId, "/orders/ord_1/events");

    await().until(() -> registry.countFor(actorId) == 1);

    subscription.dispose();

    await().atMost(Duration.ofSeconds(5))
            .until(() -> registry.countFor(actorId) == 0);     // ★ 只看自己的
}
```

**這與 7.6.2 修法 A（每個測試用不同的 IP）是同一個原則**：
**讓有狀態的共用元件，被每個測試以不同的 key 使用。**

⚠️ 這需要在 `SseEmitterRegistry` 上加一個 `countFor(actorId)` 方法 ——
**而那個方法在正式碼也有用**（`max-connections-per-actor` 的檢查就需要它，
05 章 5.11.6）。**所以它不是「只有測試用的方法」。**

**修法 B：`@Isolated`。**

```java
@Isolated
class OrderEventStreamIntegrationTest { ... }
```

**可行，但很貴** —— 它讓整個平行執行在這個類別跑的時候停下來。
6 個 SSE 測試 × 每個 2～5 秒 = 全套測試多 20 秒的序列時間。

**⚠️ 而且它治標不治本**：如果哪天有人加了另一個用 SSE 的測試類別
但忘了標 `@Isolated`，問題就回來了。

**修法 C：`@ResourceLock`。**

```java
@ResourceLock("sse-registry")
class OrderEventStreamIntegrationTest { ... }
```

比 `@Isolated` 好 —— 它只與「同樣標記的類別」互斥，
其他測試仍然平行。

**⚠️ 但同樣需要「所有相關的類別都記得標」。**

**修法 D（🔴 不要）：把 timeout 從 5 秒加到 30 秒。**

**這不會修好任何東西** —— 問題不是「清理太慢」，
是「計數包含了別人的連線」。
加長 timeout 只是讓失敗機率變低一點，
**而它換來的是「真的壞掉時要等 30 秒才知道」**。

---

**★ 這個練習的一般教訓**：

> **「本機過、CI 偶爾失敗」的原因幾乎總是三個之一：**
>
> 1. **共用的可變狀態**（本題）—— 平行執行讓它顯現
> 2. **時間假設**（`Thread.sleep` 不夠、`Instant.now()` 的精度）
> 3. **執行順序假設**（`static` 欄位、`ThreadLocal` 沒清）
>
> **而「CI 比較慢」不是原因，是觸發條件。**
> 修法永遠是「移除那個假設」，不是「放寬那個門檻」。

**★ 而這個 bug 還揭露了一件事**：

`SseEmitterRegistry` 原本只有全域的 `size()`，沒有 `countFor(actorId)` ——
**而 05 章 5.11.6 的 `max-connections-per-actor` 檢查本來就需要後者**
（它藏在 `byActor` 那個私有的 `Map` 裡，外部讀不到）。

**測試逼出了一個正式碼的缺口，而那個缺口在正式碼也是缺口。**
👉 05 章 5.11.6 現在有 `countFor(String actorId)` 了。
★ **這是好測試最有價值的一種副作用：它讓「內部狀態」變成「可觀察的介面」，
而那對正式碼的可觀測性也是好事**（例如回應可以帶
`"您目前開了 3 條連線，上限 10"`）。

</details>

---

## 7.17 驗收清單

- [ ] 我能說出 Web 層測試的四個層級與各自的**首次啟動成本**。
- [ ] **我知道 Web 層的金字塔是梯形，也知道為什麼**（框架決定行為，不是你的程式碼）。
- [ ] 我能為 shop-service 的任何一個元件說出它該用哪一級（7.3.3）。
- [ ] 我有一個「這東西該用哪一級」的決策流程，而且三個判斷句我記得住。
- [ ] **我知道 `@WebMvcTest` 會載入所有 `@ControllerAdvice`、`WebMvcConfigurer`、`Converter`、`HandlerInterceptor`、`Filter` 與真的 `ObjectMapper`。**
- [ ] 我知道它**不**載入 `@Service` / `@Component` / `@Repository`。
- [ ] 我有一個「把切片內容印出來」的診斷測試，而且知道升級後要重跑它。
- [ ] **我知道 `server.compression`、`server.tomcat.*`、multipart 的大小上限在切片裡完全無效。**
- [ ] **我知道 `@WebMvcTest` 會套用 Spring Security，也知道那可能不是我的 `SecurityConfig`。**
- [ ] 我有一個測試在驗證「切片裡的 `SecurityFilterChain` 是我的那個」。
- [ ] **我知道 `addFilters = false` 關掉的不只是 Security，而那造成 7.2.1 的資料洩漏。**
- [ ] 我有一個 ArchUnit 測試守住「不可以隨便用 `addFilters = false`」。
- [ ] **我知道 `@WithMockUser` 的 principal 是 `String`，會讓 `@CurrentActor` 的解析拋 500。**
- [ ] 我知道要用 `@WithSecurityContext` 放一個真的 `CurrentUser` 進去。
- [ ] **我知道 `CurrentActorHolder` 沒有 setter —— `SecurityContextHolder` 就是唯一的真相來源。**
- [ ] 我知道用 `spring-security-test` 的機制就不必自己寫 `@AfterEach` 清理（而自己 set 就必須寫）。
- [ ] **我知道 mock 一個 `Filter` 會讓所有回應變成 200 + 空 body。**
- [ ] 我知道基礎設施的替身要用「真的輕量實作」而不是 mock，也知道三個理由。
- [ ] 我知道 `@TestConfiguration` 與 `@Configuration` 的差別，也知道一定要用前者。
- [ ] **我能列出 Spring context 快取鍵的九個組成，尤其是 mock 定義集合與 controller 清單。**
- [ ] **我知道「89 個 context」是 47 分鐘的主因，而不是「測試太多」。**
- [ ] 我知道統一基底類別的取捨（context 大一點，但只有一個）。
- [ ] 我有一個 CI 腳本在守住 context 的預算。
- [ ] 我知道 standalone 幾乎不用，也能說出三個理由。
- [ ] 我知道 standalone 的正當用途（與設定無關的 MVC 機制 + 大量參數組合）。
- [ ] **我知道 `status()` 要放第一個 `andExpect`，也知道為什麼（只有它失敗會印全部）。**
- [ ] **我知道 `.param()` 不會產生 query string，而那讓 `QueryMasker` 靜默失效。**
- [ ] 我知道 URI 裡的中文要用 URI template 才會被編碼。
- [ ] 我知道 `.with()` 是修改 request 的萬用逃生門（`remoteAddr`、認證）。
- [ ] **我知道 `content().json()` 的 LENIENT 與 STRICT 的用途完全不同。**
- [ ] 我知道 STRICT 是資訊洩漏防護，而它的代價是「新增欄位會紅燈」（那是刻意的）。
- [ ] **我知道 `jsonPath(...).value(3L)` 對 `3` 會失敗（Jayway 給 Integer）。**
- [ ] **我知道 `doesNotExist()` 分不出「缺欄位」與「值是 null」，也知道正確做法。**
- [ ] 我知道 `contains` / `containsInAnyOrder` / `hasItems` 的差別。
- [ ] **我知道 `getContentAsString()` 預設可能是 ISO-8859-1，中文要指定 UTF-8。**
- [ ] 我知道 `andDo(print())` 不該 commit，也知道三個替代方案。
- [ ] **我能說出非同步請求的六個階段，也知道「哪些 filter」會在 ASYNC dispatch 跑第二次（只有覆寫成 `false` 的那些）。**
- [ ] 我知道 `OncePerRequestFilter.shouldNotFilterAsyncDispatch()` **預設回傳 `true`**（跳過 ASYNC dispatch），也知道覆寫成 `false` 的 filter 會真的重跑，而「已執行過」的 attribute 擋不住它（04 章 4.4.6）。
- [ ] 我知道 `StreamingResponseBody` 的 `getAsyncResult()` 回傳的是 lambda 本身。
- [ ] **我知道 SSE 測試的 `emitter.complete()` 一定要放在 `finally` 裡。**
- [ ] 我知道 SSE 在 MockMvc 裡只能測「線路格式」，其他六件事要 ④′。
- [ ] 我知道 multipart 測試的位元組要有正確的 magic number，否則測到的是驗證器。
- [ ] **我知道看不見的字元（NUL、CRLF、RLO）要用 `(char) 0x...` 組出來，不要直接貼。**
- [ ] **我能列出 MockMvc 與真實容器的 12 個行為差異，也知道每一個對應哪一類測試。**
- [ ] 我知道「200 + 截斷的 JSON」在任何 MockMvc 測試裡都不會出現。
- [ ] 我知道 `MockMvcTester` 是 Spring 6.2 的，也知道它的四個改善與遷移策略。
- [ ] **我知道 `@MockitoBean` 是 Spring 6.2（Boot 3.4）才有的，而 `@MockBean` 已 deprecated。**
- [ ] **我知道 mock 沒 stub 就回 `null`，而那讓 `status().isOk()` 完全失去意義。**
- [ ] 我知道 `RETURNS_SMART_NULLS` 對 record 無效（shop-service 的 DTO 全是 record）。
- [ ] 我有一個 `hasNonEmptyBody()` matcher，讓「忘記 stub」從綠燈變紅燈。
- [ ] **我知道 `verify` 是用來驗證「回應看不出來的事」**（actor 有沒有傳下去）。
- [ ] 我知道 `verifyNoMoreInteractions` 幾乎總是過度指定。
- [ ] **我知道 `ArgumentCaptor` 是 Controller 測試的核心價值**（它一次覆蓋 06 章整章的設定）。
- [ ] 我知道 `capture()` 要放在 `verify()` 裡而不是 `when()` 裡，也知道理由（失敗訊息）。
- [ ] 我知道哪些東西不該 mock（`ObjectMapper`、`MessageSource`、`Validator`、mapper、filter）。
- [ ] **我知道「一個 `createOrder()` 輔助方法」崩塌的三個症狀。**
- [ ] 我知道 Object Mother 與 Test Data Builder 的分工。
- [ ] 我知道 builder 的預設值本身就是「什麼是合法資料」的文件。
- [ ] **我知道請求的 JSON 一律寫死，不可以用 `writeValueAsString` 產生。**
- [ ] 我知道那個寫法的盲點是「序列化與反序列化互為反函式，往返一定成功」。
- [ ] 我有一份「壞輸入目錄」，而且知道它要分成「與 DTO 無關」與「與 DTO 有關」兩組。
- [ ] 我知道那三個「不管哪種壞輸入都成立」的斷言是什麼（problem+json、traceId、不洩漏）。
- [ ] **我知道參數化測試買到的是「新增資料時測試自動跟上」。**
- [ ] 我知道 `@ArgumentsSource` + `SpringExtension.getApplicationContext` 可以拿到 Spring bean。
- [ ] 我能用一個測試覆蓋 83 個 `ErrorCode` 的五個規則。
- [ ] **我知道 `StatusLabel` 測試的核心斷言是 `.isNotEqualTo(status.name())`。**
- [ ] 我知道 `@TestFactory` 的兩個代價（mock 不重設、IDE 支援差）。
- [ ] 我知道矩陣型的測試要「一次印出全貌」，因為那讓你看到模式而不是症狀。
- [ ] **我知道授權是最值得寫的測試，也能說出三個理由。**
- [ ] 我知道 `EndpointInventory` 要用 `getPathPatternsCondition()`（Boot 3）。
- [ ] **我知道授權矩陣的骨架預設值要全填 403（保守的方向）。**
- [ ] **我知道 `AuthzMatrixCompletenessTest` 比那 350 個斷言更重要。**
- [ ] 我知道「對匿名開放的端點」要用 `containsExactlyInAnyOrder` 而不是 `isEmpty`。
- [ ] **我知道功能層級授權與資源層級授權（IDOR）是兩件事，而後者是 OWASP 第一名。**
- [ ] 我知道 IDOR 的防護分三層：Controller 傳 actor、Service 判斷、ArchUnit 守簽名。
- [ ] **我知道 `ValidBodies` 的 `default` 分支要拋例外，否則授權測試會被驗證誤導。**
- [ ] 我知道授權矩陣必須用 ④，也能說出四個理由。
- [ ] 我知道三種契約測試分別回答什麼問題。
- [ ] **我知道一個 `openApi().isValid()` 就同時檢查了五件事，包含「沒有多餘欄位」。**
- [ ] 我知道自動契約驗證要排除哪三類情況，以及 400 那個取捨的代價。
- [ ] **我知道 REST Docs 的 `responseFields` 漏一個欄位就失敗，而那是資訊洩漏防護。**
- [ ] 我知道 REST Docs 的四個優點與四個缺點，也知道「只做核心 12 個」的理由。
- [ ] **我知道不可以同時有「手寫的 YAML」與「springdoc 從程式碼產生的」兩份 OpenAPI。**
- [ ] 我知道 Pact 值得的三個判準，也知道 shop-service 為什麼用窮人版。
- [ ] **我有一張「`@WebMvcTest` 測不到什麼」的表，而且知道 Jackson 設定不在上面。**
- [ ] 我知道 filter 順序測試要用 `containsSubsequence` 而不是 `containsExactly`。
- [ ] 我知道「兩個 filter 相同 order」的執行順序是未定義的。
- [ ] 我知道 SSE 的六件事要 ④′，也知道要用 `WebClient` + `ServerSentEvent<String>`。
- [ ] **我知道 `await()` 比 `Thread.sleep()` 好的三個地方。**
- [ ] 我知道 `untilAsserted` 的失敗訊息比 `until` 好得多。
- [ ] **我知道壓縮測試失敗常常是因為 HTTP client 自動解壓縮了。**
- [ ] 我知道 Range 的回歸測試守住的是 06 章 6.4.5 的 `configureMessageConverters` 陷阱。
- [ ] **我知道 Testcontainers 的容器要 `static`，否則慢 20 倍。**
- [ ] **我知道整合測試不可以用 `@Transactional`，也知道它掩蓋的四件事。**
- [ ] 我知道 `TRUNCATE` 比回滾慢 16 ms，而那個代價是值得的。
- [ ] 我能說出 12 個測試反模式，並對每一個給出好的寫法。
- [ ] **我知道 `any()` 到處用會讓「Controller 傳錯 ID」的 bug 通過測試。**
- [ ] 我知道測試名字要是「一句規則」而不是「做了什麼」。
- [ ] 我知道中文方法名需要 `-Dfile.encoding=UTF-8`，否則 Windows 上是亂碼。
- [ ] **我知道 `@{argLine}` 的寫法，也知道寫成 `-DxxX` 會讓 Jacoco 覆蓋率永遠是 0%。**
- [ ] **我知道 `mode.default = same_thread` + `mode.classes.default = concurrent` 是唯一安全的平行組合。**
- [ ] 我知道 `reuseForks = false` 會讓 Spring context 快取完全失效。
- [ ] **我知道 47 → 4 分鐘的六個改動，也知道「刪測試」只省 12 秒。**
- [ ] 我知道 CI 要把安全性測試切成獨立的 job（三個理由）。
- [ ] **我知道 `rerunFailingTestsCount` 是把「不穩定的訊號」變成「沒有訊號」。**
- [ ] 我知道 `@Disabled` 要寫票號與兩週期限，而且有一個測試在守它。
- [ ] 我知道「到期就刪掉那個測試」是刻意的，也知道理由。
- [ ] **我知道覆蓋率量的是「跑過」不是「驗證過」。**
- [ ] 我知道覆蓋率的三個正確用法（看未覆蓋分支、分 package 設門檻、看趨勢）。
- [ ] 我知道突變測試是「找測試漏洞」的工具，不是 CI 門檻。
- [ ] 我知道等價突變體的存在，也知道它讓「100% 突變分數」不可能。
- [ ] **我知道「本機過、CI 偶爾失敗」的三個原因，而「CI 比較慢」是觸發條件不是原因。**
- [ ] 我知道修法永遠是「移除那個假設」，不是「放寬那個門檻」。
- [ ] 我有一個 `ApplicationContextLoadsTest`，用來驗證「正式的 context 真的起得來」。
- [ ] 我知道 `allow-bean-definition-overriding: true` 的代價，也知道要怎麼補。

---

## 7.18 下一站：05-service

**04-controller 到這裡結束了。**

七章的成果，一句話總結：

```
00  Controller 只做三件事：翻譯參數、驗證輸入、翻譯回應
01  路由與綁定 —— 把 HTTP 變成 Java 物件
02  驗證 —— 在進入 Service 之前擋下壞資料
03  錯誤格式 —— 83 個 code，一套格式，四層一致
04  生命週期 —— filter / interceptor / resolver 各司其職
05  檔案與串流 —— 大東西不要放進記憶體
06  跨來源與序列化 —— 內容跨越邊界時的事
07  測試 —— 讓上面六章的每一個決定都有一個會紅燈的守門人
```

**而 Web 層的每一個測試，都在同一件事上打轉**：

> **HTTP 的世界與 Java 的世界之間，那一層翻譯對不對。**

**它刻意沒有回答的問題**：

- 庫存真的不足時，`OrderService.create()` 會不會拋 `InsufficientStockException`？
- 「一天最多改 3 次地址」在兩個客服同時操作時會不會變成 4 次？
- 付款失敗時，已經扣掉的庫存要怎麼還回去？
- `AFTER_COMMIT` 的通知信寄失敗了，要重試幾次？
- 合併訂單的過程中資料庫斷線，會留下半張訂單嗎？

**這五個問題全部屬於 05-service。**

而它們有一個共同特徵，正好是 Web 層完全沒有碰到的：

> **它們都跟「交易」有關。**

Web 層的每一個請求是無狀態的、獨立的、可以重試的。
**Service 層不是** —— 它要處理
「一連串操作要嘛全部成功、要嘛全部失敗」，
以及「兩個人同時做同一件事」。

**05-service 的預告**：

| 章 | 主題 |
|---|---|
| 00 | Service 層的職責：交易邊界在哪裡 |
| 01 | `@Transactional` 的七個陷阱（自我呼叫、rollbackFor、傳播行為…） |
| 02 | 併發控制：樂觀鎖、悲觀鎖、與「一天最多 3 次」的正確做法 |
| 03 | 領域事件與 `@TransactionalEventListener` |
| 04 | 外部呼叫：逾時、重試、斷路器，以及「付款結果未知」 |
| 05 | 冪等在 Service 層的形狀（04 章 4.9 只做了 Web 層那一半） |
| 06 | 批次與非同步工作（05 章 5.10 的匯出，Service 層那一半） |
| 07 | Service 層的測試：什麼時候該用真的資料庫 |

**而 07 章建立的東西會一路用下去**：

| 這一章的東西 | 在 05-service 怎麼用 |
|---|---|
| 測試金字塔的決策流程（7.3.4） | Service 層有自己的一張表 |
| Object Mother / Builder（7.7） | 直接沿用（`Orders`、`Actors`） |
| 參數化測試（7.8） | 覆蓋所有狀態轉移的組合 |
| `Clock` 固定（7.4.4） | Service 層更需要（過期、重試間隔） |
| Testcontainers 基底（7.11.6） | Service 層的**主要**測試環境 |
| **不用 `@Transactional`**（7.12.4） | ★ 在 Service 層更關鍵 |
| `await()` 而不是 sleep（7.12.8） | 非同步工作的測試 |
| CI 的分層與平行（7.13） | 沿用 |

---

完成後請前往 [../05-service/](../05-service/)。
