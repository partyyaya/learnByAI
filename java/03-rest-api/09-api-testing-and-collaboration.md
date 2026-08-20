# 第 09 章：測試與協作

> 前面八章做了大量的設計決定：70 條端點、22 個 DTO、66 個錯誤碼、
> 分頁規格、版本策略、冪等／快取／限流的完整契約。
>
> **但這些決定目前只存在於文件裡。**
> 這一章要把它們變成**會失敗的測試** —— 因為一條規則如果沒有測試，
> 它就只是一段建議，而建議會在三個月後被忘記。
>
> 這一章也處理最後一個問題：**這些設計要怎麼在一個有前端、有 App、有廠商的團隊裡真的被執行。**

---

## 9.1 學習目標

完成本章後，你應該可以：

- 設計 API 測試的六層分工，並說出每一層測什麼、不測什麼、比例是多少。
- 用 OpenAPI 契約自動驗證實際回應，讓「契約與實作不一致」變成測試失敗。
- 把第 02～08 章的規則變成可執行的測試套件（狀態碼、錯誤格式、分頁、冪等、快取、資安）。
- 實作消費者驅動契約（Pact），並說出它和「schema 驗證」的差別。
- 寫出「資安迴歸測試」：欄位洩漏、IDOR、快取污染。
- **把整站的資安設計決策對照回 OWASP API Security Top 10**，並確認沒有一格是空白的。
- 建立 `.http` / Hurl 的可版控測試集合，並在 CI 上執行。
- 設計契約先行的前後端協作流程，並處理它的六種阻力。
- 設計上線後的驗證：冒煙測試、合成監控、契約漂移偵測、consumer 用量追蹤。
- 完成 shop-service 的測試套件與協作規範。

---

## 9.2 API 測試的六層

### 9.2.1 分層與職責

```
   ⑥  合成監控（正式環境，持續執行）        幾支關鍵流程
   ⑤  E2E（staging，真實環境）             幾支關鍵流程
   ④  契約測試（consumer ↔ provider）      每個 consumer 的需求
   ③  整合測試（@SpringBootTest + TC）      每個端點的 happy path
   ②  Web 層切片（@WebMvcTest + MockMvc）   每個端點的所有回應
   ①  單元測試（純 Java，無 Spring）        大量
```

| 層 | 工具 | 測什麼 | **不**測什麼 | 數量 | 單次耗時 |
|---|---|---|---|---|---|
| ① 單元 | JUnit + AssertJ | 領域邏輯、狀態機、金額計算、cursor 編解碼、指紋正規化 | HTTP、資料庫 | 數百～數千 | < 1ms |
| ② Web 切片 | `@WebMvcTest` + MockMvc | **狀態碼、錯誤格式、header、驗證、參數綁定、序列化** | 真實的業務邏輯（mock 掉） | 每端點 5～15 | 10～50ms |
| ③ 整合 | `@SpringBootTest` + Testcontainers | 真實 SQL、交易、樂觀鎖、冪等的併發 | 所有錯誤分支（②做過了） | 每端點 1～3 | 0.5～3s |
| ④ 契約 | Pact / OpenAPI 驗證 | consumer 真正需要的欄位 | 業務邏輯 | 每 consumer 5～20 | 10～100ms |
| ⑤ E2E | `.http` / Hurl / Playwright | 跨端點的完整流程 | 邊界情況 | 5～15 | 5～60s |
| ⑥ 合成監控 | Hurl / k6 / Datadog Synthetics | 正式環境「還活著」 | 細節 | 3～8 | 持續 |

**② 是 API 測試的主力。** 這是本章最重要的一個判斷：

> **API 的大部分規則（狀態碼、錯誤格式、header、分頁契約）都可以用
> `@WebMvcTest` + MockMvc 測，而且是毫秒級的。**
>
> 很多團隊把這些放到 ③（`@SpringBootTest`），結果測試跑 10 分鐘，
> 然後大家開始 skip 測試。

**理想的比例**：

```
①  60~70%
②  20~30%
③   5~10%
④⑤⑥ < 5%
```

### 9.2.2 為什麼 ② 要 mock 掉 Service

```java
@WebMvcTest(OrderController.class)
@Import({GlobalExceptionHandler.class, ProblemDetailConfig.class})
class OrderControllerTest {

    @Autowired MockMvc mockMvc;

    @MockitoBean OrderService orderService;        // Spring Boot 3.4+；舊版是 @MockBean
    @MockitoBean OrderQueryService queryService;

    @Test
    void 庫存不足時回409且含available欄位() throws Exception {
        when(orderService.create(any()))
                .thenThrow(new InsufficientStockException(
                        "P-1001", "無線降噪耳機 Pro", 5, 3, LocalDate.of(2026, 8, 22)));

        mockMvc.perform(post("/v1/orders")
                        .contentType(APPLICATION_JSON)
                        .header("Idempotency-Key", "8f14e45f-ea36-4a1b-9c2e-77e8f1a3b0c1")
                        .header("X-Client-Id", "shop-web")
                        .header("X-Client-Version", "1.0.0")
                        .content(VALID_CREATE_ORDER_JSON))
                .andExpect(status().isConflict())
                .andExpect(content().contentTypeCompatibleWith("application/problem+json"))
                .andExpect(header().string("Cache-Control", containsString("no-store")))
                .andExpect(jsonPath("$.type").value(
                        "https://api.shop.example/problems/insufficient-stock"))
                .andExpect(jsonPath("$.code").value("INSUFFICIENT_STOCK"))
                .andExpect(jsonPath("$.status").value(409))
                .andExpect(jsonPath("$.available").value(3))
                .andExpect(jsonPath("$.requested").value(5))
                .andExpect(jsonPath("$.retryable").value(false))
                .andExpect(jsonPath("$.retryStrategy").value("MODIFY_REQUEST"))
                .andExpect(jsonPath("$.userMessage").value(containsString("僅剩 3 件")))
                .andExpect(jsonPath("$.traceId").isNotEmpty());
    }
}
```

**為什麼要 mock 掉 Service？**

| 理由 | 說明 |
|---|---|
| **速度** | 不啟動資料庫、不掛完整 context → 10ms vs 2s |
| **可控** | 「庫存不足」這個情境用 `thenThrow` 一行就有；用真實資料庫要先建商品、設庫存、下單 |
| **職責清楚** | 這個測試在問「Web 層有沒有正確地把領域例外轉成 HTTP」（第 04 章 4.10），不是在問「庫存邏輯對不對」 |
| **能測到所有錯誤分支** | 66 個錯誤碼都要測 → 用真實資料庫製造 66 種情境是不現實的 |

**⚠️ 但 `@WebMvcTest` 有三個坑**：

| 坑 | 說明 | 解法 |
|---|---|---|
| **不會自動載入 `@RestControllerAdvice`** | 除非它在同一個套件被掃到 | `@Import(GlobalExceptionHandler.class)` |
| **不會載入 Spring Security 的 filter chain** | 401/403 測不到（第 04 章 4.10.3） | `@Import(SecurityConfig.class)`，或用 ③ 測 |
| **Filter 不一定會執行** | 自訂的 `OncePerRequestFilter` 需要註冊 | `@Import(FilterConfig.class)`，或用 ③ 測 |

**第三個坑最容易漏**：冪等 Filter、限流 Filter、TraceId Filter 都在 filter 層 →
`@WebMvcTest` 預設可能不執行 → 這些機制要用 ③ 測。

**shop-service 的分工**：

| 機制 | 測在哪一層 |
|---|---|
| 狀態碼、錯誤格式、驗證、序列化 | ② `@WebMvcTest` |
| 401 / 403 | ② `@WebMvcTest` + `@Import(SecurityConfig)` |
| 冪等鍵（含併發） | ③ `@SpringBootTest` + Testcontainers |
| 限流 | ③（需要真的 Redis） |
| 快取 header | ② 測 header；③ 測 `304` 的完整流程 |
| 樂觀鎖 `412` | ③（需要真的版本衝突） |

### 9.2.3 ③ 整合測試：共用容器與 context

```java
@SpringBootTest(webEnvironment = RANDOM_PORT)
@AutoConfigureMockMvc
@ActiveProfiles("integration-test")
public abstract class AbstractIntegrationTest {

    // ★ static 且在基底類別 → 所有子類別共用同一組容器與同一個 Spring context
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0")
            .withDatabaseName("shop_test")
            .withReuse(!isCi());                  // 本機重用，CI 不重用

    static final GenericContainer<?> REDIS = new GenericContainer<>("redis:7-alpine")
            .withExposedPorts(6379)
            .withReuse(!isCi());

    static {
        MYSQL.start();
        REDIS.start();
    }

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", MYSQL::getJdbcUrl);
        r.add("spring.datasource.username", MYSQL::getUsername);
        r.add("spring.datasource.password", MYSQL::getPassword);
        r.add("spring.data.redis.host", REDIS::getHost);
        r.add("spring.data.redis.port", () -> REDIS.getMappedPort(6379));
    }

    private static boolean isCi() {
        return "true".equals(System.getenv("CI"));
    }
}
```

**兩個關鍵**：

| 關鍵 | 效果 |
|---|---|
| **容器在基底類別且 static** | 所有整合測試共用一組容器（不是每個測試類別各起一組） |
| **`@DynamicPropertySource` 的值一致** | Spring context 可以被快取（02-spring-boot 第 07 章）→ 只啟動一次 |

**`withReuse(true)` 的價值**：本機開發時容器不會每次重啟 → 測試從 30 秒變 3 秒。
需要在 `~/.testcontainers.properties` 設 `testcontainers.reuse.enable=true`。

**⚠️ CI 上不要 reuse**（每次要乾淨的環境）。

---

## 9.3 契約測試

### 9.3.1 三種「契約測試」的差別（常被混用）

| 種類 | 方向 | 問的問題 | 工具 |
|---|---|---|---|
| **A. Schema 驗證** | provider 自測 | 「我的回應符合我的 OpenAPI 嗎？」 | swagger-request-validator |
| **B. 消費者驅動契約（CDC）** | consumer → provider | 「我提供的東西滿足每個 consumer 的需求嗎？」 | Pact / Spring Cloud Contract |
| **C. Provider 驅動契約** | provider → consumer | 「consumer 有正確使用我的契約嗎？」 | 第 06 章 6.13 練習 5 的測試套件 |

**三者互補，不是替代**：

```
A 抓到：實作和契約不一致（例如漏了一個必填欄位）
B 抓到：契約改了但某個 consumer 需要那個欄位
C 抓到：consumer 沒處理未知列舉值
```

**shop-service 全部都做**，但優先序是 **A → C → B**（見 9.3.4 的理由）。

### 9.3.2 A：用 OpenAPI 驗證實際回應 ★ 投報率最高

```xml
<dependency>
    <groupId>com.atlassian.oai</groupId>
    <artifactId>swagger-request-validator-mockmvc</artifactId>
    <version>2.44.1</version>
    <scope>test</scope>
</dependency>
```

```java
@Test
void 訂單詳情的回應符合契約() throws Exception {
    when(queryService.findDetail(any(), any(), any())).thenReturn(SAMPLE_ORDER_DETAIL);

    mockMvc.perform(get("/v1/orders/ord_01J5GKQ8Z4W9V2X3Y6N7M8P0QR")
                    .header("Authorization", "Bearer " + TOKEN)
                    .header("X-Client-Id", "shop-web")
                    .header("X-Client-Version", "1.0.0"))
            .andExpect(status().isOk())
            .andExpect(openApi().isValid("file:dist/orders-api.yaml"));   // ★ 一行
}
```

**這一行 `openApi().isValid(...)` 會檢查**：

| 檢查 | 說明 |
|---|---|
| 端點存在於契約 | 打了契約沒定義的路徑 → 失敗 |
| 狀態碼在契約的 `responses` 裡 | 回了契約沒列的 `418` → 失敗 |
| `Content-Type` 相符 | 契約說 `application/problem+json` 但回了 `application/json` → 失敗 |
| **回應 body 符合 schema** | 缺必填欄位、型別錯 → 失敗 |
| 必填的 header 存在 | `201` 缺 `Location` → 失敗 |
| 請求也驗證 | 測試送的請求不符合契約 → 失敗（幫你抓到測試寫錯） |

**用一個「掃過所有端點」的測試**（投報率最高的單一測試）：

```java
@SpringBootTest(webEnvironment = RANDOM_PORT)
class AllEndpointsContractTest extends AbstractIntegrationTest {

    @Autowired MockMvc mockMvc;

    static Stream<ApiScenario> allScenarios() {
        return ScenarioLoader.loadFrom("src/test/resources/scenarios/");
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("allScenarios")
    void 每個情境的回應都符合契約(ApiScenario s) throws Exception {
        var request = request(s.method(), s.uri()).headers(s.headers());
        if (s.body() != null) request.contentType(APPLICATION_JSON).content(s.body());

        mockMvc.perform(request)
                .andExpect(status().is(s.expectedStatus()))
                .andExpect(openApi().isValid("file:dist/orders-api.yaml"));
    }
}
```

```yaml
# src/test/resources/scenarios/orders.yaml
- name: "GET /orders 一般查詢"
  method: GET
  uri: /v1/orders?status=PAID&page=0&size=20
  headers: { Authorization: "Bearer ${CUSTOMER_TOKEN}", X-Client-Id: shop-web }
  expectedStatus: 200

- name: "GET /orders 未認證"
  method: GET
  uri: /v1/orders
  expectedStatus: 401

- name: "GET /orders 深分頁超過上限"
  method: GET
  uri: /v1/orders?page=1000&size=100
  headers: { Authorization: "Bearer ${CUSTOMER_TOKEN}", X-Client-Id: shop-web }
  expectedStatus: 400

- name: "GET /orders 顧客帶 customerId"
  method: GET
  uri: /v1/orders?customerId=cus_other
  headers: { Authorization: "Bearer ${CUSTOMER_TOKEN}", X-Client-Id: shop-web }
  expectedStatus: 403
```

**這個設計的價值**：

| 價值 | 說明 |
|---|---|
| **情境用 YAML 描述** | 非工程師也能新增測試情境 |
| **同一份情境可以餵給多個地方** | 契約驗證、Hurl 的 E2E、合成監控 |
| **加新端點時只要加情境** | 不用寫新的測試類別 |
| **契約改了立刻失敗** | 第 07 章 7.4.4 的「反向檢查」 |

### 9.3.3 B：消費者驅動契約（Pact）

**Consumer 端（前端）**：

```javascript
await provider
  .given('顧客 cus_test 有 2 張已付款訂單')         // provider state
  .uponReceiving('查詢已付款訂單')
  .withRequest({
    method: 'GET',
    path: '/v1/orders',
    query: { status: 'PAID', page: '0', size: '20' },
    headers: { Authorization: like('Bearer eyJ...'), 'X-Client-Id': 'shop-web' },
  })
  .willRespondWith({
    status: 200,
    body: {
      // ★ 只宣告「我真的用到的欄位」
      items: eachLike({
        orderId: string('ord_01J5GKQ8Z4W9V2X3Y6N7M8P0QR'),
        orderNumber: regex(/^ORD-\d{8}-\d{4}$/, 'ORD-20260819-0001'),
        statusLabel: string('已付款'),               // ★ 我用 statusLabel 顯示
        statusCategory: string('IN_PROGRESS'),       // ★ 我用 category 分頁籤
        totalAmount: regex(/^-?\d+(\.\d{2})?$/, '1280.50'),
        currency: string('TWD'),
        itemCount: integer(3),
        createdAt: regex(/^\d{4}-\d{2}-\d{2}T.*Z$/, '2026-08-19T06:12:44Z'),
        // ⚠️ 注意我「沒有」宣告 status（原始列舉值）
        //    → 因為我不用它做邏輯判斷 → provider 可以自由新增列舉值
      }),
      page: like({ mode: 'OFFSET', hasMore: like(true) }),
      links: like({ next: like('/v1/orders?page=1&size=20') }),
    },
  })
  .executeTest(async (mock) => {
    const api = createClient({ baseUrl: mock.url + '/v1' });
    const res = await api.GET('/orders', { params: { query: { status: ['PAID'] } } });
    expect(res.data.items).toHaveLength(1);
    renderOrderList(res.data.items);                 // ★ 真的跑我的渲染邏輯
  });
```

**Provider 端驗證**：

```java
@Provider("shop-service")
@PactBroker(url = "${PACT_BROKER_URL}")
@SpringBootTest(webEnvironment = RANDOM_PORT)
class OrderPactVerificationTest extends AbstractIntegrationTest {

    @LocalServerPort int port;

    @BeforeEach
    void setTarget(PactVerificationContext ctx) {
        ctx.setTarget(new HttpTestTarget("localhost", port, "/"));
    }

    @TestTemplate
    @ExtendWith(PactVerificationInvocationContextProvider.class)
    void verify(PactVerificationContext ctx) {
        ctx.verifyInteraction();
    }

    // ★ provider state：把資料庫準備成 consumer 期望的狀態
    @State("顧客 cus_test 有 2 張已付款訂單")
    void customerHasTwoPaidOrders() {
        testDataFactory.reset();
        testDataFactory.customer("cus_test");
        testDataFactory.order("cus_test", OrderStatus.PAID, "1280.50");
        testDataFactory.order("cus_test", OrderStatus.PAID, "890.00");
    }
}
```

**Pact Broker 的完整流程**：

```
① consumer 的 CI 跑 pact 測試 → 產生 pact 檔案
② 發布到 Pact Broker（含 consumer 的版本與 branch）
③ provider 的 CI 從 Broker 拉取「所有 consumer 的所有 pact」→ 驗證
④ 驗證結果回報給 Broker
⑤ 部署前用 can-i-deploy 檢查相容性
```

```bash
pact-broker can-i-deploy \
  --pacticipant shop-service \
  --version "$GIT_SHA" \
  --to-environment production
# → 若有任何 consumer 的 pact 驗證失敗 → 阻止部署
```

**`can-i-deploy` 是 Pact 最有價值的功能** ——
它把「我改的東西會不會打壞誰」變成一個部署前的自動檢查。

### 9.3.4 CDC 的真實成本與判斷

**Pact 的價值**：

| 價值 | 說明 |
|---|---|
| ★ **知道「哪些欄位真的有人用」** | 第 06 章 6.8.3 的用量監控想解決的問題，Pact 在編譯期就給答案 |
| ★ **`can-i-deploy` 阻止破壞性部署** | 比「事後發現」好得多 |
| 精確的相容性檢查 | 比「OpenAPI diff」精確（diff 說「移除欄位」，Pact 說「shop-web 需要這個欄位」） |

**Pact 的成本（要誠實）**：

| 成本 | 說明 |
|---|---|
| **Provider state 的維護** | 每個 consumer 的每個情境都要一個 `@State` → 幾十個狀態設定方法 |
| **兩邊都要投入** | consumer 團隊要寫 pact 測試（他們可能不想） |
| **Broker 是額外的基礎設施** | 要部署、要維護、要備份 |
| **CI 的耦合** | provider 的 CI 依賴 Broker 可用 |
| **學習曲線** | matcher 的語意、state 的設計、branch 策略都要學 |

**判斷矩陣**：

| 情況 | 建議 |
|---|---|
| Consumer 是**同一個團隊**（自家前端） | ⚠️ **不一定需要** —— OpenAPI 驗證 + E2E 可能就夠 |
| Consumer 是**別的團隊**（同公司不同部門） | ★ **值得** —— 溝通成本高，Pact 讓契約明確 |
| Consumer 是**外部廠商** | ❌ **通常做不到** —— 你無法要求廠商寫 pact 測試 |
| Consumer 數量 > 5 且變動頻繁 | ★ 值得 |
| 微服務架構（服務間互相呼叫） | ★★ **最值得**（這是 Pact 的原生場景） |

**shop-service 的決定**：

```
✅ A（OpenAPI 驗證）：全面採用 —— 成本最低、抓到最多問題
✅ C（provider 驅動的測試套件）：提供給所有 consumer（第 06 章 6.13 練習 5）
⚠️ B（Pact）：只對「內部微服務」使用
```

```markdown
## ADR-014：不對前端與廠商使用 Pact

### 決定
只對內部微服務（inventory-service、payment-service）使用 Pact。
自家前端用 OpenAPI 型別產生 + E2E 測試；
廠商用契約 + mock server + 合規測試套件。

### 理由
1. 自家前端和後端在同一個團隊、同一個 repo、同一個 sprint
   → Pact 要解決的「跨團隊溝通」問題不存在
   → OpenAPI 驗證（provider 側）+ 型別產生（consumer 側）已覆蓋 90% 的風險
2. 廠商不會寫 pact 測試（我們無法要求）
   → 改為提供「合規測試套件」讓他們在自己的 CI 跑
3. Provider state 的維護成本高，而我們的整合測試已經有 test data factory

### 重新評估的條件
- 前端拆成獨立的團隊／repo
- Consumer 數量超過 8 個
- 出現「因為契約變更打壞 consumer」的事故超過 2 次
```

---

## 9.4 把設計規則變成測試 ★ 本章核心

**前面八章的每一條規則都應該有測試。這一節逐章列出。**

### 9.4.1 第 02 章：狀態碼與方法契約

```java
@WebMvcTest
@Import({GlobalExceptionHandler.class, SecurityConfig.class})
class StatusCodeContractTest {

    @Test
    void 集合端點空結果回200而非404() throws Exception {
        when(queryService.list(any(), any())).thenReturn(PageResponse.empty());

        mockMvc.perform(authed(get("/v1/orders?status=CANCELLED")))
                .andExpect(status().isOk())                          // ★ 不是 404
                .andExpect(jsonPath("$.items").isArray())
                .andExpect(jsonPath("$.items").isEmpty())            // ★ [] 不是 null
                .andExpect(jsonPath("$.page.totalElements").value(0));
    }

    @Test
    void POST建立成功回201且帶Location() throws Exception {
        when(orderService.create(any())).thenReturn(SAMPLE_ORDER);

        mockMvc.perform(authed(post("/v1/orders"))
                        .header("Idempotency-Key", newKey())
                        .contentType(APPLICATION_JSON)
                        .content(VALID_CREATE_ORDER_JSON))
                .andExpect(status().isCreated())
                .andExpect(header().exists("Location"))              // ★ 第 02 章 2.4.2
                .andExpect(header().string("Location",
                        matchesRegex("/v1/orders/ord_[0-9A-HJKMNP-TV-Z]{26}")))
                .andExpect(header().exists("ETag"));
    }

    @Test
    void DELETE成功回204且無body() throws Exception {
        mockMvc.perform(authed(delete("/v1/me/addresses/addr_1")))
                .andExpect(status().isNoContent())
                .andExpect(content().string(""));                    // ★ 第 02 章 2.8.2
    }

    @Test
    void 不支援的方法回405且帶Allow() throws Exception {
        mockMvc.perform(authed(delete("/v1/orders/ord_1")))
                .andExpect(status().isMethodNotAllowed())
                .andExpect(header().exists("Allow"))                 // ★ 第 02 章 2.8.4
                .andExpect(header().string("Allow", containsString("GET")))
                .andExpect(jsonPath("$.code").value("METHOD_NOT_ALLOWED"));
    }

    @Test
    void 未認證回401且帶WWWAuthenticate() throws Exception {
        mockMvc.perform(get("/v1/orders"))
                .andExpect(status().isUnauthorized())
                .andExpect(header().exists("WWW-Authenticate"))       // ★ 第 02 章 2.9.1
                .andExpect(header().string("WWW-Authenticate", containsString("Bearer")))
                .andExpect(jsonPath("$.code").value("AUTHENTICATION_REQUIRED"));
    }

    @Test
    void token過期回401而非403() throws Exception {
        mockMvc.perform(get("/v1/orders").header("Authorization", "Bearer " + EXPIRED_TOKEN))
                .andExpect(status().isUnauthorized())                // ★ 不是 403
                .andExpect(jsonPath("$.code").value("TOKEN_EXPIRED"))
                .andExpect(jsonPath("$.retryStrategy").value("REFRESH_TOKEN_THEN_RETRY"));
    }

    @Test
    void 缺少ContentType回415() throws Exception {
        mockMvc.perform(authed(post("/v1/orders"))
                        .header("Idempotency-Key", newKey())
                        .content("{}"))
                .andExpect(status().isUnsupportedMediaType())
                .andExpect(jsonPath("$.code").value("UNSUPPORTED_MEDIA_TYPE"));
    }

    // ★ 把第 00 章 0.10.3 的狀態機變成參數化測試
    @ParameterizedTest
    @CsvSource({
        "PENDING_PAYMENT, 201",   // 可取消
        "PAID,            201",   // 可取消
        "PARTIALLY_SHIPPED, 409",
        "SHIPPED,         409",   // 已出貨不可取消
        "COMPLETED,       409",
        "CANCELLED,       409",   // 已取消
        "RETURNED,        409",
    })
    void 取消訂單依狀態回對應的狀態碼(String status, int expected) throws Exception {
        stubOrderWithStatus(OrderStatus.valueOf(status));

        mockMvc.perform(authed(post("/v1/orders/ord_1/cancellations"))
                        .header("Idempotency-Key", newKey())
                        .contentType(APPLICATION_JSON)
                        .content("{\"reason\": \"CUSTOMER_CHANGED_MIND\"}"))
                .andExpect(status().is(expected));
    }
}
```

**最後那個參數化測試是很高價值的**：
它把「訂單狀態機」變成一張表，加新狀態時只要加一行 —— 而且**忘記加會被發現**
（因為 `OrderStatus` 的所有值都應該出現在表中，可以再加一個測試檢查這件事）。

```java
@Test
void 狀態機的參數化測試涵蓋了所有訂單狀態() {
    Set<String> tested = csvSourceValuesOf("取消訂單依狀態回對應的狀態碼");
    Set<String> all = Arrays.stream(OrderStatus.values()).map(Enum::name).collect(toSet());

    assertThat(all)
            .as("新增訂單狀態後，請在 @CsvSource 補上對應的預期狀態碼")
            .isSubsetOf(tested);
}
```

### 9.4.2 第 04 章：錯誤格式契約

```java
class ErrorFormatContractTest {

    /**
     * ★ 這個測試對「所有」錯誤碼檢查一致性。
     * 每次新增錯誤碼都會自動被檢查 —— 一個測試涵蓋 66 個錯誤碼。
     */
    @ParameterizedTest
    @EnumSource(ErrorCode.class)
    void 每個錯誤碼都有完整的必要欄位(ErrorCode code) {
        // ① 有 i18n 訊息（title + userMessage，zh-TW + en）
        assertThat(messages.getMessage(code.messageKey() + ".title", null, TAIWAN))
                .as("錯誤碼 %s 缺少 zh-TW 的 title", code).isNotBlank();
        assertThat(messages.getMessage(code.messageKey() + ".user-message", null, TAIWAN))
                .as("錯誤碼 %s 缺少 zh-TW 的 userMessage", code).isNotBlank();
        assertThat(messages.getMessage(code.messageKey() + ".title", null, ENGLISH))
                .as("錯誤碼 %s 缺少 en 的 title", code).isNotBlank();

        // ② 4xx 的 userMessage 不可含技術術語（第 04 章 4.7.4）
        if (code.status().is4xxClientError()) {
            String userMsg = messages.getMessage(code.messageKey() + ".user-message", null, TAIWAN);
            assertThat(userMsg)
                    .as("錯誤碼 %s 的 userMessage 含技術術語", code)
                    .doesNotContainIgnoringCase("null", "exception", "SQL", "樂觀鎖",
                            "序列化", "stack", "timeout", "socket");
        }

        // ③ type URI 格式正確（第 04 章 4.4.3）
        assertThat(code.type().toString())
                .as("錯誤碼 %s 的 type URI 格式錯誤", code)
                .startsWith("https://api.shop.example/problems/")
                .matches(".*/[a-z0-9]+(-[a-z0-9]+)*$");            // kebab-case

        // ④ type URI 有對應的文件頁面
        assertThat(documentedProblemTypes())
                .as("錯誤碼 %s 的 type URI 沒有對應的文件頁面", code)
                .contains(code.type().toString());

        // ⑤ 5xx 不可標為可重試（除了明確的暫時性錯誤）
        if (code.status().is5xxServerError()
                && !Set.of(SERVICE_UNAVAILABLE, GATEWAY_TIMEOUT, BAD_GATEWAY)
                        .contains(code.status())) {
            assertThat(code.retryable())
                    .as("錯誤碼 %s 是 %s 但標為可重試", code, code.status()).isFalse();
        }

        // ⑥ 在 OpenAPI 契約裡有定義
        assertThat(openApiErrorCodes())
                .as("錯誤碼 %s 沒有出現在 OpenAPI 契約中", code)
                .contains(code.name());
    }

    @Test
    void 驗證錯誤一次回傳全部欄位而非只有第一個() throws Exception {
        mockMvc.perform(authed(post("/v1/orders"))
                        .header("Idempotency-Key", newKey())
                        .contentType(APPLICATION_JSON)
                        .content(INVALID_ORDER_WITH_FOUR_ERRORS))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.code").value("VALIDATION_FAILED"))
                // ★ 第 04 章 4.6.2 要點 1：一次回全部
                .andExpect(jsonPath("$.errors", hasSize(greaterThanOrEqualTo(4))))
                // ★ 要點 2：field 含陣列索引
                .andExpect(jsonPath("$.errors[*].field", hasItems(
                        "items[1].productId", "items[1].quantity",
                        "shippingAddressId", "customerNote")))
                // ★ 要點 3：每個 error 都有 code
                .andExpect(jsonPath("$.errors[*].code", everyItem(not(emptyString()))))
                .andExpect(jsonPath("$.traceId").isNotEmpty());
    }

    @Test
    void 敏感欄位的rejectedValue被遮蔽() throws Exception {
        mockMvc.perform(post("/v1/auth/tokens")
                        .contentType(APPLICATION_JSON)
                        .content("{\"email\": \"not-an-email\", \"password\": \"123\"}"))
                .andExpect(status().isUnprocessableEntity())
                // ★ 第 04 章 4.6.2 要點 4
                .andExpect(jsonPath("$.errors[?(@.field == 'password')].rejectedValue")
                        .value(everyItem(is("***"))))
                .andExpect(content().string(not(containsString("\"123\""))));
    }

    @Test
    void 系統錯誤不洩漏內部細節() throws Exception {
        when(orderService.create(any())).thenThrow(new RuntimeException(
                "could not execute statement; SQL [insert into t_order_master "
                + "(customer_id) values (?)]; constraint [uk_order_no]"));

        mockMvc.perform(authed(post("/v1/orders"))
                        .header("Idempotency-Key", newKey())
                        .contentType(APPLICATION_JSON)
                        .content(VALID_CREATE_ORDER_JSON))
                .andExpect(status().isInternalServerError())
                .andExpect(jsonPath("$.code").value("INTERNAL_ERROR"))
                // ★ 第 04 章 4.7.3
                .andExpect(content().string(not(containsStringIgnoringCase("SQL"))))
                .andExpect(content().string(not(containsString("t_order_master"))))
                .andExpect(content().string(not(containsString("uk_order_no"))))
                .andExpect(content().string(not(containsString("constraint"))))
                .andExpect(jsonPath("$.trace").doesNotExist())
                .andExpect(jsonPath("$.stackTrace").doesNotExist())
                .andExpect(jsonPath("$.traceId").isNotEmpty());       // 但要有 traceId
    }

    @Test
    void 錯誤回應不可被快取() throws Exception {
        mockMvc.perform(authed(get("/v1/orders/ord_nonexistent")))
                .andExpect(status().isNotFound())
                // ★ 第 08 章 8.3.9
                .andExpect(header().string("Cache-Control", containsString("no-store")));
    }
}
```

**`@EnumSource(ErrorCode.class)` 那個測試是本節最有價值的**：
**它讓「新增錯誤碼時忘記加 i18n 訊息」在 CI 就被抓到，而不是在正式環境顯示空白。**

### 9.4.3 第 05 章：分頁契約

```java
class PaginationContractTest extends AbstractIntegrationTest {

    @Test
    void size超過上限回400而非靜默夾取() throws Exception {
        mockMvc.perform(authed(get("/v1/orders?size=10000")))
                .andExpect(status().isBadRequest())                   // ★ 第 05 章 5.2.4
                .andExpect(jsonPath("$.errors[0].field").value("size"))
                .andExpect(jsonPath("$.errors[0].constraint.max").value(100))
                .andExpect(jsonPath("$.hint").value(containsString("order-exports")));
    }

    @Test
    void 深分頁超過上限回400並提示替代方案() throws Exception {
        mockMvc.perform(authed(get("/v1/orders?page=1000&size=100")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("DEEP_PAGINATION_NOT_SUPPORTED"))
                .andExpect(jsonPath("$.maxOffset").value(10000))
                .andExpect(jsonPath("$.requestedOffset").value(100000))
                .andExpect(jsonPath("$.hint").value(containsString("cursor")));
    }

    @Test
    void page與cursor互斥() throws Exception {
        mockMvc.perform(authed(get("/v1/orders?page=0&cursor=eyJrIjpbXX0")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.errors[0].constraint.conflictsWith[0]").value("page"));
    }

    @Test
    void 未知的查詢參數回400並提供建議() throws Exception {
        mockMvc.perform(authed(get("/v1/orders?stauts=PAID")))
                .andExpect(status().isBadRequest())                   // ★ 第 05 章 5.8.6
                .andExpect(jsonPath("$.code").value("UNKNOWN_QUERY_PARAMETER"))
                .andExpect(jsonPath("$.errors[0].field").value("stauts"))
                .andExpect(jsonPath("$.errors[0].constraint.suggestion").value("status"));
    }

    @Test
    void 不允許的排序欄位回400且不洩漏該欄位存在() throws Exception {
        mockMvc.perform(authed(get("/v1/orders?sort=cost,desc")))
                .andExpect(status().isBadRequest())                   // ★ 第 05 章 5.9.2
                .andExpect(jsonPath("$.errors[0].field").value("sort"))
                .andExpect(jsonPath("$.errors[0].constraint.allowedValues",
                        not(hasItem("cost"))));
    }

    @Test
    void 排序自動附加id作為tiebreaker() throws Exception {
        // ★ 第 05 章 5.9.3：準備 50 筆 created_at 完全相同的訂單
        testDataFactory.ordersWithSameCreatedAt("cus_test", 50,
                Instant.parse("2026-08-19T06:00:00Z"));

        List<String> p1 = extractIds(authed(get("/v1/orders?size=20&sort=createdAt,desc")));
        List<String> p2 = extractIds(authed(get("/v1/orders?page=1&size=20&sort=createdAt,desc")));
        List<String> p3 = extractIds(authed(get("/v1/orders?page=2&size=20&sort=createdAt,desc")));

        List<String> all = concat(p1, p2, p3);
        assertThat(all).as("三頁之間不可有重複").doesNotHaveDuplicates();
        assertThat(all).as("50 筆應該全部出現").hasSize(50);
    }

    @Test
    void cursor分頁能完整遍歷且不重複不遺漏() throws Exception {
        testDataFactory.ordersWithSameCreatedAt("cus_test", 137,
                Instant.parse("2026-08-19T06:00:00Z"));

        Set<String> seen = new LinkedHashSet<>();
        String url = "/v1/orders?limit=20&sort=createdAt,desc";
        int pages = 0;

        while (url != null && pages++ < 50) {            // 防無限迴圈
            JsonNode body = json(authed(get(url)).andReturn().getResponse());
            body.path("items").forEach(item -> {
                String id = item.path("orderId").asText();
                assertThat(seen.add(id)).as("cursor 分頁出現重複: %s", id).isTrue();
            });
            JsonNode next = body.path("links").path("next");
            url = next.isNull() || next.isMissingNode() ? null : next.asText();
        }

        assertThat(seen).as("cursor 分頁應完整遍歷 137 筆").hasSize(137);
    }

    @Test
    void 換排序後沿用舊cursor回400() throws Exception {
        String cursor = firstPageCursor("/v1/orders?limit=20&sort=createdAt,desc");

        mockMvc.perform(authed(get("/v1/orders?limit=20&sort=totalAmount,desc&cursor=" + cursor)))
                .andExpect(status().isBadRequest())                   // ★ 第 05 章 5.4.3
                .andExpect(jsonPath("$.code").value("CURSOR_QUERY_MISMATCH"));
    }

    @Test
    void 日期範圍的to包含當天整天() throws Exception {
        // ★ 第 05 章 5.8.2：這個測試防止「8 月營收少了 8/31 一整天」的財務 bug
        // 台北時間 2026-08-31 23:30 建立的訂單（= UTC 15:30）
        testDataFactory.orderAt("cus_test", Instant.parse("2026-08-31T15:30:00Z"));

        mockMvc.perform(authed(get("/v1/orders?createdFrom=2026-08-01&createdTo=2026-08-31")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items", hasSize(1)))           // ★ 必須包含
                .andExpect(jsonPath("$.appliedFilters.createdTo")
                        .value("2026-08-31T16:00:00Z"));              // exclusive 上界
    }

    @Test
    void 布林篩選不帶參數時不篩選() throws Exception {
        testDataFactory.order("cus_test", withGift(true));
        testDataFactory.order("cus_test", withGift(false));

        // ★ 第 05 章 5.8.4：不帶 isGift 應該回兩筆
        mockMvc.perform(authed(get("/v1/orders")))
                .andExpect(jsonPath("$.items", hasSize(2)));

        mockMvc.perform(authed(get("/v1/orders?isGift=false")))
                .andExpect(jsonPath("$.items", hasSize(1)));
    }
}
```

**「日期範圍的 `to` 包含當天整天」這個測試值得特別強調**：
它防止的是「8 月營收少了 8/31 一整天」的財務 bug —— **一個測試值幾萬元。**

### 9.4.4 第 08 章：冪等、快取、限流

```java
class IdempotencyContractTest extends AbstractIntegrationTest {

    @Test
    void 必填端點沒帶冪等鍵回400() throws Exception {
        mockMvc.perform(authed(post("/v1/orders"))
                        .contentType(APPLICATION_JSON).content(VALID_CREATE_ORDER_JSON))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("IDEMPOTENCY_KEY_REQUIRED"))
                .andExpect(jsonPath("$.hint").value(containsString("UUID")));
    }

    @Test
    void 相同key相同內容回放首次結果() throws Exception {
        String key = newKey();

        var first = mockMvc.perform(authed(post("/v1/orders"))
                        .header("Idempotency-Key", key)
                        .contentType(APPLICATION_JSON).content(VALID_CREATE_ORDER_JSON))
                .andExpect(status().isCreated())
                .andReturn().getResponse();
        String orderId = json(first).path("orderId").asText();

        var second = mockMvc.perform(authed(post("/v1/orders"))
                        .header("Idempotency-Key", key)
                        .contentType(APPLICATION_JSON).content(VALID_CREATE_ORDER_JSON))
                .andExpect(status().isOk())                           // ★ 200 不是 201
                .andExpect(header().string("Idempotent-Replay", "true"))
                .andExpect(header().string("Location", first.getHeader("Location")))
                .andExpect(header().string("Cache-Control", containsString("no-store")))
                .andReturn().getResponse();

        assertThat(json(second).path("orderId").asText()).isEqualTo(orderId);
        assertThat(orderRepo.count()).as("只能建立一張訂單").isEqualTo(1);
    }

    @Test
    void 相同key不同內容回409() throws Exception {
        String key = newKey();
        mockMvc.perform(authed(post("/v1/orders")).header("Idempotency-Key", key)
                        .contentType(APPLICATION_JSON).content(VALID_CREATE_ORDER_JSON))
                .andExpect(status().isCreated());

        mockMvc.perform(authed(post("/v1/orders")).header("Idempotency-Key", key)
                        .contentType(APPLICATION_JSON).content(DIFFERENT_ORDER_JSON))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("IDEMPOTENCY_KEY_REUSED"))
                .andExpect(jsonPath("$.hint").value(containsString("新的 Idempotency-Key")));
    }

    @Test
    void JSON欄位順序不同視為相同請求() throws Exception {
        // ★ 第 08 章 8.2.5 的正規化
        String key = newKey();
        String a = "{\"items\":[{\"productId\":\"P-1001\",\"quantity\":2}],"
                 + "\"shippingAddressId\":\"addr_1\"}";
        String b = "{\"shippingAddressId\":\"addr_1\","
                 + "\"items\":[{\"quantity\":2,\"productId\":\"P-1001\"}]}";

        mockMvc.perform(authed(post("/v1/orders")).header("Idempotency-Key", key)
                        .contentType(APPLICATION_JSON).content(a))
                .andExpect(status().isCreated());

        mockMvc.perform(authed(post("/v1/orders")).header("Idempotency-Key", key)
                        .contentType(APPLICATION_JSON).content(b))
                .andExpect(status().isOk())                           // ★ 回放，不是 409
                .andExpect(header().string("Idempotent-Replay", "true"));
    }

    @Test
    void 併發的相同key只執行一次() throws Exception {
        // ★ 第 08 章 8.2.4 競態條件 1 —— 這是最難靠 code review 發現的 bug
        String key = newKey();
        int threads = 20;
        var latch = new CountDownLatch(1);
        var statuses = Collections.synchronizedList(new ArrayList<Integer>());

        try (var pool = Executors.newFixedThreadPool(threads)) {
            for (int i = 0; i < threads; i++) {
                pool.submit(() -> {
                    latch.await();
                    var res = restTemplate.postForEntity(
                            "/v1/orders", requestWithKey(key), String.class);
                    statuses.add(res.getStatusCode().value());
                    return null;
                });
            }
            latch.countDown();                                        // ★ 同時放行
        }

        assertThat(orderRepo.count()).as("併發下只能建立一張訂單").isEqualTo(1);
        assertThat(statuses).allMatch(s -> s == 201 || s == 200 || s == 409);
        assertThat(statuses).as("恰好一個 201").filteredOn(s -> s == 201).hasSize(1);
    }

    @Test
    void 5xx不記錄冪等結果讓客戶端能重試() throws Exception {
        // ★ 第 08 章 8.2.6
        String key = newKey();
        when(paymentGateway.charge(any())).thenThrow(new GatewayTimeoutException());

        mockMvc.perform(authed(post("/v1/orders/ord_1/payments"))
                        .header("Idempotency-Key", key)
                        .contentType(APPLICATION_JSON).content(PAYMENT_JSON))
                .andExpect(status().isGatewayTimeout());

        reset(paymentGateway);
        when(paymentGateway.charge(any())).thenReturn(SUCCESSFUL_CHARGE);

        // ★ 同一個 key 重試 → 應該真的執行（不是回放 504）
        mockMvc.perform(authed(post("/v1/orders/ord_1/payments"))
                        .header("Idempotency-Key", key)
                        .contentType(APPLICATION_JSON).content(PAYMENT_JSON))
                .andExpect(status().isCreated());
    }
}
```

```java
class CacheContractTest extends AbstractIntegrationTest {

    /**
     * ★ 掃過所有端點，確認需要認證的都有 private/no-store。
     * 這是防止「個資被 CDN 快取」的資安護欄（第 08 章 8.5.2）。
     */
    @ParameterizedTest
    @MethodSource("authenticatedGetEndpoints")
    void 需要認證的端點必須是private或nostore(String uri) throws Exception {
        mockMvc.perform(authed(get(uri)))
                .andExpect(result -> {
                    String cc = result.getResponse().getHeader("Cache-Control");
                    assertThat(cc).as("%s 缺少 Cache-Control", uri).isNotNull();
                    assertThat(cc)
                            .as("%s 的 Cache-Control 未含 private/no-store: %s", uri, cc)
                            .satisfiesAnyOf(
                                    s -> assertThat(s).contains("private"),
                                    s -> assertThat(s).contains("no-store"));
                });
    }

    @Test
    void 不同角色的ETag不同() throws Exception {
        // ★ 第 08 章 8.3.4 / 8.5.2 風險 4
        String etagCustomer = etagOf(get("/v1/orders/ord_1"), CUSTOMER_TOKEN);
        String etagSupport = etagOf(get("/v1/orders/ord_1"), SUPPORT_TOKEN);

        assertThat(etagCustomer)
                .as("不同角色看到不同欄位，ETag 必須不同")
                .isNotEqualTo(etagSupport);
    }

    @Test
    void 顧客帶客服的ETag不會拿到304() throws Exception {
        String etagSupport = etagOf(get("/v1/orders/ord_1"), SUPPORT_TOKEN);

        mockMvc.perform(get("/v1/orders/ord_1")
                        .header("Authorization", "Bearer " + CUSTOMER_TOKEN)
                        .header("If-None-Match", etagSupport))
                .andExpect(status().isOk());                          // ★ 200 不是 304
    }

    @Test
    void 不同語言的ETag不同() throws Exception {
        String zh = etagOf(get("/v1/orders/ord_1").header("Accept-Language", "zh-TW"), TOKEN);
        String en = etagOf(get("/v1/orders/ord_1").header("Accept-Language", "en"), TOKEN);
        assertThat(zh).isNotEqualTo(en);
    }

    @Test
    void 資料未變更時回304且body為空() throws Exception {
        String etag = etagOf(get("/v1/orders/ord_1"), TOKEN);

        mockMvc.perform(authed(get("/v1/orders/ord_1")).header("If-None-Match", etag))
                .andExpect(status().isNotModified())
                .andExpect(content().string(""))                      // ★ body 0 bytes
                .andExpect(header().string("ETag", etag));
    }

    @Test
    void 公開端點有Vary和stale指令() throws Exception {
        mockMvc.perform(get("/v1/products?categoryId=cat_1"))
                .andExpect(header().string("Cache-Control", containsString("public")))
                .andExpect(header().string("Cache-Control",
                        containsString("stale-while-revalidate")))
                .andExpect(header().string("Vary", containsString("Accept-Language")));
    }
}
```

```java
class RateLimitContractTest extends AbstractIntegrationTest {

    @Test
    void 超過配額回429且帶完整header() throws Exception {
        for (int i = 0; i < 31; i++) {
            authed(get("/v1/orders?q=test" + i));                     // 用完 search 桶
        }

        mockMvc.perform(authed(get("/v1/orders?q=final")))
                .andExpect(status().isTooManyRequests())
                .andExpect(header().exists("Retry-After"))            // ★ RFC 9110
                .andExpect(header().exists("RateLimit-Limit"))
                .andExpect(header().string("RateLimit-Remaining", "0"))
                .andExpect(header().exists("RateLimit-Reset"))
                .andExpect(jsonPath("$.code").value("RATE_LIMIT_EXCEEDED"))
                .andExpect(jsonPath("$.bucket").value("search"))
                .andExpect(jsonPath("$.retryable").value(true))
                .andExpect(jsonPath("$.retryStrategy").value("BACKOFF_AND_RETRY"))
                .andExpect(jsonPath("$.otherBuckets[?(@.name == 'read')].remaining")
                        .value(everyItem(greaterThan(0))))            // ★ 其他桶還有額度
                .andExpect(header().string("Cache-Control", containsString("no-store")));
    }

    @Test
    void 未超限時也回RateLimit header() throws Exception {
        mockMvc.perform(authed(get("/v1/orders")))
                .andExpect(status().isOk())
                .andExpect(header().exists("RateLimit-Limit"))
                .andExpect(header().exists("RateLimit-Remaining"))    // ★ 讓客戶端主動節流
                .andExpect(header().exists("RateLimit-Policy"));
    }

    @Test
    void 貴的操作扣更多令牌() throws Exception {
        int before = remainingOf(authed(get("/v1/orders")), "read");
        int after = remainingOf(authed(get("/v1/orders?expand=items&size=100")), "read");
        // cost = 1(base) + 2(expand) + 2(size>50) = 5
        assertThat(before - after).as("加權扣費").isGreaterThanOrEqualTo(5);
    }

    @Test
    void 所有端點都有明確的限流桶對映() {
        // ★ 第 08 章 8.9 練習 4 的缺陷 3（事故的根因）
        List<String> unmapped = allEndpointPatterns().stream()
                .filter(p -> !rateLimitProperties.hasBucketFor(p))
                .toList();

        assertThat(unmapped)
                .as("以下端點沒有限流桶對映，會落到 default（可能配額過寬）")
                .isEmpty();
    }

    @Test
    void 正式環境不可使用dryRun() {
        // ★ 第 08 章 8.9 練習 4 的原因 C
        assertThat(loadProperties("application-prod.yml").getProperty("rate-limit.dry-run"))
                .as("正式環境的 rate-limit.dry-run 必須是 false 或未設定")
                .isIn(null, "false");
    }
}
```

### 9.4.5 資安迴歸測試 ★ 最高優先

**這一節對應第 03 章 3.2、第 01 章 1.4.1、第 08 章 8.5.2 的三類資安問題。**

```java
class ApiSecurityRegressionTest extends AbstractIntegrationTest {

    private static final Set<String> FORBIDDEN_FIELD_NAMES = Set.of(
            "password", "passwordhash", "pwd", "salt", "secret", "privatekey",
            "idnumber", "ssn", "passportnumber", "creditcard", "cardnumber", "cvv",
            "internalcost", "cost", "margin", "marginrate", "riskscore",
            "fraudscore", "internalnote", "internalnotes");

    /**
     * ★ 掃過所有端點的回應，確認沒有敏感欄位（第 03 章 3.2.9）。
     * 這是「新增 Entity 欄位時不小心外洩」的護欄。
     */
    @ParameterizedTest
    @MethodSource("allGetEndpointsAsCustomer")
    void 顧客可見的回應不含敏感欄位(String uri) throws Exception {
        String body = authed(get(uri), CUSTOMER_TOKEN)
                .andReturn().getResponse().getContentAsString();
        if (body.isBlank()) return;

        List<String> leaked = allFieldPaths(body).stream()
                .filter(path -> {
                    String leaf = path.substring(path.lastIndexOf('.') + 1)
                                      .replaceAll("\\[\\d+\\]$", "")
                                      .toLowerCase();
                    return FORBIDDEN_FIELD_NAMES.contains(leaf);
                })
                .toList();

        assertThat(leaked).as("端點 %s 洩漏敏感欄位", uri).isEmpty();
    }

    @Test
    void 顧客無法讀取他人的訂單() throws Exception {
        String othersOrderId = testDataFactory.order("cus_other", PAID).getId();

        mockMvc.perform(get("/v1/orders/" + othersOrderId)
                        .header("Authorization", "Bearer " + CUSTOMER_A_TOKEN))
                .andExpect(status().isNotFound());                    // ★ 404 不是 403
    }

    @Test
    void 顧客無法透過巢狀路徑讀取他人的訂單明細() throws Exception {
        // ★ 第 01 章 1.5.3
        String othersOrderId = testDataFactory.order("cus_other", PAID).getId();

        mockMvc.perform(get("/v1/orders/" + othersOrderId + "/items")
                        .header("Authorization", "Bearer " + CUSTOMER_A_TOKEN))
                .andExpect(status().isNotFound());
    }

    @Test
    void 顧客無法用customerId參數看他人的訂單() throws Exception {
        // ★ 第 05 章 5.12.5：權限相關的參數被忽略必須是錯誤，不能是警告
        mockMvc.perform(get("/v1/orders?customerId=cus_other")
                        .header("Authorization", "Bearer " + CUSTOMER_A_TOKEN))
                .andExpect(status().isForbidden())                    // ★ 不是靜默忽略
                .andExpect(jsonPath("$.code").value("FORBIDDEN_PARAMETER"));
    }

    @Test
    void 登入失敗不洩漏帳號是否存在() throws Exception {
        // ★ 第 02 章 2.9.3
        var existing = login("existing@example.com", "wrong-password");
        var nonExisting = login("definitely-not-registered@example.com", "wrong-password");

        assertThat(existing.getStatus()).isEqualTo(nonExisting.getStatus());
        assertThat(json(existing).path("code").asText())
                .isEqualTo(json(nonExisting).path("code").asText())
                .isEqualTo("INVALID_CREDENTIALS");
        assertThat(json(existing).path("userMessage").asText())
                .isEqualTo(json(nonExisting).path("userMessage").asText());
    }

    @Test
    void 登入失敗的回應時間一致() throws Exception {
        // ★ 第 02 章 2.9.3：防時序攻擊
        long existing = timeOf(() -> login("existing@example.com", "wrong"));
        long nonExisting = timeOf(() -> login("nope@example.com", "wrong"));

        assertThat(Math.abs(existing - nonExisting))
                .as("回應時間差異過大，可用於推測帳號是否存在（%dms vs %dms）",
                    existing, nonExisting)
                .isLessThan(50);
    }

    @Test
    void 排序參數不接受任意欄位() throws Exception {
        // ★ 第 05 章 5.9.2：SQL injection + 資訊洩漏
        for (String malicious : List.of(
                "id; DROP TABLE orders--",
                "(SELECT password_hash FROM customers LIMIT 1)",
                "cost", "margin", "internal_note",
                "../../etc/passwd")) {
            mockMvc.perform(authed(get("/v1/orders?sort=" + urlEncode(malicious))))
                    .andExpect(status().isBadRequest());
        }
        assertThat(orderRepo.count()).as("資料表應該還在").isGreaterThan(0);
    }

    @Test
    void 未認證無法存取需要認證的端點() throws Exception {
        for (String uri : authenticatedEndpoints()) {
            mockMvc.perform(get(uri))
                    .andExpect(result -> assertThat(result.getResponse().getStatus())
                            .as("端點 %s 未認證時應回 401", uri)
                            .isEqualTo(401));
        }
    }

    @Test
    void 上傳檔案檢查magicBytes而非只信ContentType() throws Exception {
        // ★ 第 03 章 3.12.4：內容是 PE 執行檔的開頭，但宣告是 jpeg
        byte[] fakeImage = new byte[] { 0x4D, 0x5A, (byte) 0x90, 0x00 };

        mockMvc.perform(multipart("/v1/products/P-1001/images")
                        .file(new MockMultipartFile("file", "evil.jpg", "image/jpeg", fakeImage))
                        .header("Authorization", "Bearer " + ADMIN_TOKEN))
                .andExpect(status().isUnsupportedMediaType());
    }
}
```

**這一組測試是整個測試套件裡優先序最高的**：

| 理由 | 說明 |
|---|---|
| 它們測的是**資安**，失敗的後果是事故而不是 bug |
| 它們是**迴歸測試** —— 每一個都對應一個真的發生過的事故類型 |
| 它們**掃過所有端點** —— 新增端點時自動被涵蓋 |
| 它們**極便宜** —— 幾百毫秒換一整類事故的防護 |

**⚠️ `allGetEndpointsAsCustomer` 的實作要小心**：

```java
static Stream<String> allGetEndpointsAsCustomer() {
    return handlerMapping.getHandlerMethods().entrySet().stream()
            .filter(e -> e.getKey().getMethodsCondition().getMethods().contains(GET))
            .flatMap(e -> e.getKey().getPathPatternsCondition().getPatterns().stream())
            .map(PathPattern::getPatternString)
            // ★ 用測試資料的實際 ID 填入路徑參數
            .map(p -> p.replace("{orderId}", TEST_ORDER_ID)
                       .replace("{productId}", TEST_PRODUCT_ID)
                       .replace("{customerId}", TEST_CUSTOMER_ID)
                       .replace("{addressId}", TEST_ADDRESS_ID))
            // ★ 排除還有未替換的參數（避免測到無效路徑 → 假綠燈）
            .filter(p -> !p.contains("{"))
            .filter(p -> !p.startsWith("/actuator"))
            .filter(p -> !p.startsWith("/internal"));
}
```

**「排除還有未替換的參數」是必要的**，否則會測到 `/v1/orders/{unknownParam}` 這種無效路徑，
拿到 `400` 然後測試通過（但實際上什麼都沒測到 → **假的綠燈**）。

**所以要加一個涵蓋率檢查**：

```java
@Test
void 資安掃描涵蓋了足夠比例的端點() {
    long total = allGetEndpointPatterns().count();
    long covered = allGetEndpointsAsCustomer().count();

    assertThat((double) covered / total)
            .as("資安掃描只涵蓋 %d/%d 個端點 —— 請補上缺少的測試資料 ID", covered, total)
            .isGreaterThan(0.9);
}
```

**沒有這個檢查，資安掃描可能因為「測試資料 ID 沒準備」而靜默跳過大部分端點。**

---

### 9.4.6 對照 OWASP API Security Top 10 ★ 收斂成一張表

前面八章其實已經把 OWASP API Security Top 10（2023）講完了——
但它們**散在八個章節裡**，沒有一個地方能讓你一次確認「有沒有漏」。

這張表就是那個地方。**做 API 設計 review 或上線前檢查時，逐列打勾。**

| # | OWASP 風險 | 本站哪裡講過 | 對應的設計決策 | 測在哪一層 |
|---|---|---|---|---|
| **API1** | **BOLA**（物件層級授權失效，即 IDOR） | 01 章 1.4、05 章 5.4.3 | 識別碼不可猜（ULID）**＋每次查詢都帶 owner 條件** | 9.4.5 的 IDOR 掃描（**逐端點**） |
| **API2** | 認證失效 | 02 章 2.8（401 vs 403）、07 章 7.5.3 | `401` / `403` 語意分清、token 有效期與撤銷、錯誤碼 `TOKEN_EXPIRED` | 契約測試 + 09-spring-security |
| **API3** | **物件屬性層級授權失效**（過度暴露 / mass assignment） | 03 章 3.2、3.3 | **不回 Entity、不用 Entity 收請求**；客服版與顧客版是**不同的 DTO** | 9.4.5 的欄位洩漏掃描 |
| **API4** | 資源消耗無限制 | 03 章 3.13、05 章 5.11、08 章 8.4 | body 大小 / 巢狀深度上限、`size` 硬上限、深分頁上限、限流 | 契約測試（邊界值） |
| **API5** | **BFLA**（功能層級授權失效） | 01 章 1.10、02 章 2.13 | 每條端點都在**方法 + 角色**的矩陣裡有明確一格 | 契約測試（角色矩陣） |
| **API6** | 敏感業務流程無限制 | 08 章 8.4、8.5 | 對「下單 / 退款 / 匯出」等流程做**多桶限流 + velocity guard** | 合成監控（9.7） |
| **API7** | SSRF | 01 章 1.11（檔案與 URL） | 使用者提供的 URL 一律**白名單**，不做「幫你抓這個網址」 | 資安迴歸測試 |
| **API8** | 安全設定疏失 | 02 章 2.7（CORS）、08 章 8.3 | `Vary: Origin`、`Cache-Control: private`、CORS 不用 `*` 配憑證 | 9.4.5 的快取污染掃描 |
| **API9** | **庫存管理不當**（未知 / 已棄用端點還活著） | 06 章 6.8、07 章 7.9 | 棄用登記表 + `Sunset` header + **OpenAPI 是唯一真相** | 9.4 的「路由表 = 契約」檢查 |
| **API10** | 第三方 API 使用不安全 | 04 章 4.9、08 章 8.6 | 對下游一律設逾時、重試只對冪等操作、熔斷降級 | 整合測試 |

---

#### 三個「散在各處所以最容易漏」的

**① API9（庫存管理不當）——最容易漏的一個**

```
症狀：三年前的 /v1/internal/users 還活著，沒人記得它，也沒人在監控它
      → 它用的是舊的授權邏輯
      → 它是滲透測試最先找到的東西
```

檢查方式其實很簡單，而且應該在 CI 上跑（第 07 章 7.9 的 lint job 加一格）：

```
實際路由表（/actuator/mappings 或框架的 route dump）
  ⊖ OpenAPI 契約裡的路徑
  ────────────────────────────────
  = 「存在但沒有文件」的端點 → 必須為 0
```

> 🔑 **「沒有文件的端點」和「沒有測試的端點」一樣危險，但更難發現**——
> 因為它不會出現在任何清單上。**這個減法就是唯一能發現它的方法。**

**② API3 對上「客服版 DTO」**

第 03 章 3.14 的 22 個 DTO 裡，顧客版與客服版是**不同型別**，
而不是「同一個 DTO，有些欄位對顧客回 null」。

```
❌ 同一個 DTO + 條件式塞欄位
     → 新增欄位時預設會被所有角色看到（漏出去是預設行為）
✅ 不同型別
     → 新增欄位時要明確決定放進哪幾個 DTO（不漏是預設行為）
```

> 🔑 **這是本站反覆出現的原則：讓「安全」成為預設值，而不是靠人記得加判斷。**

**③ API1 的測試必須逐端點，不能抽樣**

9.4.5 已經寫了掃描與涵蓋率檢查。這裡只補一句**為什麼它是「最高優先」**：

```
一支端點漏掉 owner 條件 = 全站所有使用者的該資源都能被任意讀取
                        = 事故，不是 bug
```

抽樣測試會漏掉那一支。**所以要有涵蓋率檢查，讓「漏測」變成紅燈。**

---

#### 這張表怎麼用

| 時機 | 怎麼用 |
|---|---|
| **設計 review**（9.6 的 checklist） | 逐列問「我們這一版有沒有動到這一格」 |
| **新端點上線前** | API1 / API3 / API5 三格是**強制**，其餘視端點性質 |
| **季度盤點** | 只跑 API9 那個減法，找出殭屍端點 |
| **滲透測試前** | 整張表走一遍，自己先找到的比別人找到的便宜得多 |

> ⚠️ **這張表是「有沒有想過」的清單，不是「已經安全」的證明。**
> 每一格背後對應的章節都有更細的內容——
> 表格的作用是**確保沒有一格是空白的**。

---

## 9.5 `.http` / Hurl 的可版控測試集合

### 9.5.1 `.http` 檔案（開發與手動驗證）

第 00 章 0.11.3 介紹過。這裡補上組織方式：

```
api/http/
├── http-client.env.json          # 環境變數（進版控）
├── http-client.private.env.json  # 敏感值（.gitignore）
├── 00-auth.http                  # 取 token（其他檔案依賴它）
├── 01-orders-happy-path.http     # 完整的下單流程
├── 02-orders-errors.http         # ★ 所有錯誤路徑
├── 03-pagination.http
├── 04-idempotency.http
├── 05-caching.http               # ETag / 304 / If-Match
├── 06-rate-limit.http
└── 99-security-probes.http       # ★ 資安探測（IDOR、欄位洩漏）
```

```http
### api/http/02-orders-errors.http

### 缺少冪等鍵 → 400 IDEMPOTENCY_KEY_REQUIRED
POST {{host}}/orders
Content-Type: application/json
Authorization: Bearer {{token}}
X-Client-Id: {{clientId}}

{ "items": [{ "productId": "P-1001", "quantity": 1 }], "shippingAddressId": "addr_1" }

> {%
  client.test("回 400", () => client.assert(response.status === 400));
  client.test("code 正確", () =>
      client.assert(response.body.code === "IDEMPOTENCY_KEY_REQUIRED"));
  client.test("有 hint", () => client.assert(response.body.hint));
  client.test("有 traceId", () => client.assert(response.body.traceId));
%}

### 未知參數 → 400 且有拼字建議
GET {{host}}/orders?stauts=PAID
Authorization: Bearer {{token}}
X-Client-Id: {{clientId}}

> {%
  client.test("回 400", () => client.assert(response.status === 400));
  client.test("建議正確的參數名", () =>
      client.assert(response.body.errors[0].constraint.suggestion === "status"));
%}

### 深分頁 → 400 且引導到替代方案
GET {{host}}/orders?page=1000&size=100
Authorization: Bearer {{token}}
X-Client-Id: {{clientId}}

> {%
  client.test("回 400", () => client.assert(response.status === 400));
  client.test("有 hint 引導到 cursor 或匯出", () =>
      client.assert(response.body.hint.includes("cursor") ||
                    response.body.hint.includes("export")));
%}
```

**`.http` 的價值**：

| 價值 | 說明 |
|---|---|
| 進版控、跟著 PR review | Postman collection 做不到 |
| **新人第一天就能打通所有端點** | 不用去 Slack 要分享連結 |
| **錯誤路徑也存進版控** | 這是 Postman collection 最常缺的部分 |
| 內建斷言（IntelliJ / VS Code REST Client 都支援） | 手動測試也能驗證 |

**⚠️ 但 `.http` 不適合 CI**（IntelliJ 的語法不是通用標準）。CI 用 Hurl。

### 9.5.2 Hurl（CI 與合成監控）

```hurl
# api/hurl/smoke.hurl
# 用途：部署後的冒煙測試 + 正式環境的合成監控

# ── ① 公開端點（不需認證）───────────────────────
GET {{host}}/products?page=0&size=5
X-Client-Id: hurl-smoke
X-Client-Version: 1.0.0
HTTP 200
[Asserts]
header "Cache-Control" contains "public"
header "Cache-Control" contains "stale-while-revalidate"
header "Vary" contains "Accept-Language"
jsonpath "$.items" isCollection
jsonpath "$.page.mode" == "OFFSET"
duration < 1000

# ── ② 認證 ──────────────────────────────────────
POST {{host}}/auth/tokens
Content-Type: application/json
{
  "email": "{{smokeEmail}}",
  "password": "{{smokePassword}}"
}
HTTP 201
[Captures]
token: jsonpath "$.accessToken"
[Asserts]
header "Cache-Control" contains "no-store"

# ── ③ 需要認證的端點 ────────────────────────────
GET {{host}}/orders?page=0&size=5
Authorization: Bearer {{token}}
X-Client-Id: hurl-smoke
X-Client-Version: 1.0.0
HTTP 200
[Asserts]
header "Cache-Control" contains "private"
header "RateLimit-Remaining" exists
jsonpath "$.items" isCollection
jsonpath "$.page.mode" == "OFFSET"
duration < 2000

# ── ④ 錯誤格式（一定要測）───────────────────────
GET {{host}}/orders/ord_definitely_does_not_exist_00
Authorization: Bearer {{token}}
X-Client-Id: hurl-smoke
X-Client-Version: 1.0.0
HTTP 404
[Asserts]
header "Content-Type" contains "application/problem+json"
header "Cache-Control" contains "no-store"
jsonpath "$.code" == "RESOURCE_NOT_FOUND"
jsonpath "$.userMessage" exists
jsonpath "$.traceId" matches "^[0-9a-f]{16,32}$"
body not contains "SQL"
body not contains "Exception"
body not contains "at com.example"

# ── ⑤ 未認證回 401 ──────────────────────────────
GET {{host}}/orders
X-Client-Id: hurl-smoke
HTTP 401
[Asserts]
header "WWW-Authenticate" contains "Bearer"
jsonpath "$.code" == "AUTHENTICATION_REQUIRED"

# ── ⑥ 冪等鍵必填 ────────────────────────────────
POST {{host}}/orders
Authorization: Bearer {{token}}
Content-Type: application/json
X-Client-Id: hurl-smoke
{
  "items": [{ "productId": "P-1001", "quantity": 1 }],
  "shippingAddressId": "addr_smoke_test"
}
HTTP 400
[Asserts]
jsonpath "$.code" == "IDEMPOTENCY_KEY_REQUIRED"

# ── ⑦ 契約可取得 ────────────────────────────────
GET {{host}}/openapi.yaml
HTTP 200
[Asserts]
header "Content-Type" contains "yaml"
body contains "openapi: 3.1"
```

```bash
hurl --test \
     --variable host=https://staging-api.shop.example/v1 \
     --variable smokeEmail="$SMOKE_EMAIL" \
     --variable smokePassword="$SMOKE_PASSWORD" \
     --report-junit target/hurl-report.xml \
     --report-html target/hurl-report \
     api/hurl/*.hurl
```

**Hurl 的優勢**：

| 優勢 | 說明 |
|---|---|
| 純文字、進版控 | 和 `.http` 一樣 |
| ★ **CI 友善** | 單一二進位、產生 JUnit XML |
| 內建斷言語法 | 不用寫 JS |
| ★ **可用於正式環境的合成監控** | 同一份檔案，換個 host |
| `duration < 1000` 斷言 | 順便做效能迴歸檢查 |

**⚠️ 正式環境的合成監控要注意四件事**：

| 注意 | 說明 |
|---|---|
| 用**專用的測試帳號** | 不要用真實使用者的帳號 |
| **不要建立真實訂單** | ⑥ 刻意測「缺冪等鍵回 400」而不是真的下單 |
| 要能從監控與限流中排除 | `X-Client-Id: hurl-smoke` |
| 測試帳號的資料要定期清理 | 否則累積幾十萬筆測試資料 |

---

## 9.6 前後端協作流程

### 9.6.1 誰決定契約

| 模式 | 說明 | 適合 |
|---|---|---|
| **後端主導** | 後端寫契約，前端 review | ⚠️ 常見但容易產生「不好用的 API」 |
| **前端主導** | 前端提需求，後端實作 | ⚠️ 容易產生「後端做不到／效能很差」的設計 |
| **共同擁有** ★ | 後端寫初稿，前端 + iOS + 廠商 review 並有**否決權** | ★ 推薦 |

```markdown
## API 契約的擁有權

### 誰寫初稿
後端工程師（因為要評估可行性與效能）

### 誰有否決權
- **前端 / iOS**：對「這些欄位夠不夠畫畫面」有否決權
  → 若他們說「這樣要打 N 次請求」，契約必須改（避免 N+1 API）
- **後端**：對「這個效能做不到」有否決權
  → 若某個欄位需要 join 五張表，可以要求改成獨立端點或 ?expand=
- **PM**：對「這符不符合需求」有否決權
- **資安**：對「這個欄位不該暴露」有一票否決權

### 決策不了怎麼辦
1. 先做「最小可行的版本」（少欄位，之後可以加 —— 第 06 章 6.3.2）
2. ⚠️ **不要**做「最大可能的版本」（欄位一旦回出去就拿不回來 —— 第 00 章 0.8）
3. 若仍僵持 → tech lead 裁決，並記錄 ADR
```

**「先做最小版本」是很重要的原則**：

```
加欄位 = 相容（第 06 章 6.3.2）→ 之後隨時可以加
移除欄位 = 破壞性 → 需要 180 天流程

所以「不確定要不要」的欄位 → 先不要
```

### 9.6.2 契約變更的流程

| 變更類型 | 流程 |
|---|---|
| 新增選填欄位／參數 | PR + 一位 reviewer（不用開會） |
| 新增端點 | PR + 契約 review 會議（30 分鐘） |
| 新增列舉值 | PR + CHANGELOG + 通知（不用會議） |
| 新增錯誤碼 | PR + 更新錯誤目錄（不用會議） |
| Expand-Contract（改欄位） | PR + ADR + 契約 review + 通知所有 consumer |
| 移除任何東西 | ADR + tech lead 核准 + 180 天流程（第 06 章 6.8） |
| 開 v2 | ADR + 技術長核准 + 3 位資深工程師 review |

**ADR 模板**：

```markdown
# ADR-015：訂單支援多地址配送

## 狀態
已接受（2026-08-19）

## 背景
產品要支援「一張訂單分多個包裹寄到不同地址」（禮物、公司/住家分送）。
目前 `OrderDetail.shippingAddress` 是單一物件。

## 決策
用 Expand-Contract（第 06 章 6.7），不開 v2：
- 新增 `shipments[]`（每個有自己的 `shippingAddress` 與 `items`）
- 保留 `shippingAddress` = `shipments[0].shippingAddress`（標記 deprecated）
- 新增 `hasMultipleShipments` 旗標警示舊客戶端
- 多地址功能**灰度開放**：Day 0~90 只對 Web，Day 90+ 才對 App

## 考慮過的其他方案
1. **開 v2** —— 成本 14~36 人天 + 持續成本（第 06 章 6.2.1），不值得
2. **shippingAddress 改成陣列** —— 型別變更 = 靜默破壞（第 06 章 6.3.3）
3. **新開 /v1/multi-shipment-orders** —— 兩套訂單模型，維護地獄

## 後果
### 正面
- 零破壞性變更，所有 consumer 不改也能運作
- 廠商可用 `?splitByShipment=true` 把多地址訂單看成多張單地址訂單

### 負面
- `shippingAddress` 對多地址訂單「只是第一個」→ 舊客戶端會看到不完整資訊
  → 緩解：`hasMultipleShipments` 旗標 + 灰度開放
        + 監控 `multi_shipment.read_by_legacy_client` 指標
- 需要 schema 遷移（新增 shipments 表 + 回填 300 萬筆）
- `shippingAddress` 可能永不移除（維護成本：3 行 mapper）

## 相關
- 契約 PR：#1842
- Schema migration：V20260819_01 ~ V20260901_01
- 棄用登記：dep_2026_08_shipping_address
```

### 9.6.3 契約 review 的檢查清單

**放進 PR template 的契約區塊**：

```markdown
## 契約 Review Checklist

### 前端 / iOS 檢查
- [ ] 這些欄位夠我畫完整個畫面（不需要額外請求）
- [ ] 列表端點有我需要的摘要欄位（縮圖、名稱），不用打 N 次請求
- [ ] 有 `statusLabel` / `allowedActions`（我不需要自己維護對照表或業務規則）
- [ ] 錯誤情境我知道怎麼顯示（`userMessage` 夠用）
- [ ] 分頁方式符合我的 UI（表格要 offset、無限滾動要 cursor）
- [ ] 有範例可以直接餵給我的測試

### 後端檢查
- [ ] 這些欄位我拿得到（不需要 join 五張表）
- [ ] 有對應的索引（篩選 / 排序欄位）—— 已跑過 `EXPLAIN`
- [ ] 沒有暴露不該暴露的欄位
- [ ] 錯誤碼已加入錯誤目錄且有 i18n 訊息
- [ ] 集合端點有分頁上限與深分頁上限
- [ ] 寫入端點的冪等鍵策略已決定

### 資安檢查（一票否決）
- [ ] 沒有敏感欄位（`password*`、`idNumber`、`cost`、`margin`、`riskScore`…）
- [ ] 權限範圍在查詢條件裡（不是事後 if）
- [ ] 存在性敏感的資源，未授權存取回 `404` 不是 `403`
- [ ] 排序 / 篩選欄位有白名單
- [ ] 需要認證的端點有 `Cache-Control: private`

### 相容性檢查（第 06 章 6.3）
- [ ] 沒有移除欄位、沒有改型別／單位／語意
- [ ] 新增的 request 欄位是選填的
- [ ] 新增列舉值已在 CHANGELOG 記錄
- [ ] `oasdiff breaking` 通過（或已加入 allowlist 並附核准紀錄）

### CI 檢查（自動）
- [ ] Spectral lint 通過
- [ ] 契約與實作一致（drift 檢查）
- [ ] 範例符合 schema
- [ ] Mock server 可正常起動（mock-smoke）
```

### 9.6.4 溝通節奏

| 頻率 | 活動 | 參與者 |
|---|---|---|
| **每次變更** | 契約 PR + review | 相關的 consumer |
| **每個 sprint** | 15 分鐘的「API 變更摘要」 | 全體工程師 |
| **每月** | CHANGELOG 整理 + 發布給廠商 | 後端 + PM |
| **每季** | API 健康度檢視 | tech lead + 各 consumer 代表 |

**每季的「API 健康度檢視」議程**：

```
① 契約統計    端點數、DTO 數、錯誤碼數；這一季新增／棄用了什麼
② 品質指標    Spectral 違規數、drift 次數、allowlist 條目數（應趨近 0）
③ Consumer    各 consumer 的合規報告、還在用已棄用項目的、未帶 X-Client-Id 的流量比例
④ 效能可靠性  各端點 P99、限流拒絕率、5xx 率、快取命中率 / 304 比例
⑤ 事故回顧    幾次「API 變更打壞 consumer」、幾次「設計問題造成的事故」
              → 每一次都要有對應的迴歸測試
⑥ 決策        Spectral 規則要不要調整、限流配額要不要調整、
              有沒有該執行的 Contract（移除已棄用項目）
```

---

## 9.7 上線後的驗證

### 9.7.1 部署流程中的四道檢查

```
① 部署前（CI）
   □ 單元 + Web 切片 + 整合測試
   □ Spectral lint
   □ oasdiff breaking check
   □ 契約 drift check
   □ Pact can-i-deploy（若使用）

② 部署到 staging
   □ Hurl 冒煙測試（9.5.2）
   □ 契約驗證測試（對 staging 跑一次 AllEndpointsContractTest）
   □ 資安迴歸測試

③ 金絲雀部署到正式（5% 流量）
   □ 觀察 15 分鐘：5xx 錯誤率、P99、限流拒絕率
   □ 比較 canary vs baseline
   □ 任一指標劣化 > 20% → 自動回滾

④ 全量部署
   □ Hurl 冒煙測試（對正式環境）
   □ 觀察 1 小時
```

### 9.7.2 合成監控

```yaml
schedule: "*/2 * * * *"        # 每 2 分鐘
script: hurl --test --variable host=https://api.shop.example/v1 api/hurl/smoke.hurl
alerts:
  - condition: 連續 2 次失敗
    severity: critical
    notify: [pagerduty, slack-oncall]
  - condition: duration 斷言失敗（回應變慢）
    severity: warning
```

**合成監控 vs 真實使用者監控（RUM）**：

| | 合成監控 | RUM |
|---|---|---|
| 覆蓋 | 幾支關鍵流程 | 所有真實流量 |
| 一致性 | ★ 每次都一樣（可比較） | 變動大 |
| 低流量時段 | ★ 仍有資料 | 沒有流量就沒有資料 |
| 發現「完全掛掉」 | ★ 2 分鐘內 | 要等有使用者 |
| 發現「特定使用者的問題」 | ❌ | ★ |

**兩者互補。** 合成監控是「還活著嗎」，RUM 是「使用者的實際體驗」。

### 9.7.3 契約漂移偵測（正式環境）

**問題**：CI 檢查了「程式碼」和「契約」一致，但**正式環境的實際回應**呢？

```java
/**
 * ★ 在正式環境對「抽樣的回應」做契約驗證。
 * 這抓的是「CI 沒測到的組合」（例如特定歷史資料造成的欄位缺失）。
 */
@Component
@Profile("prod")
public class ContractDriftDetector implements ResponseBodyAdvice<Object> {

    private static final double SAMPLE_RATE = 0.001;      // 0.1%

    @Override
    public Object beforeBodyWrite(Object body, MethodParameter param, MediaType mt,
                                  Class converter, ServerHttpRequest req, ServerHttpResponse res) {
        if (ThreadLocalRandom.current().nextDouble() > SAMPLE_RATE) return body;

        try {
            var report = validator.validateResponse(
                    pathOf(req), methodOf(req), toValidatableResponse(res, body));
            if (report.hasErrors()) {
                // ⚠️ 只記錄，絕不影響回應
                log.warn("契約漂移偵測 path={} method={} errors={}",
                         pathOf(req), methodOf(req), report.getMessages());
                registry.counter("contract.drift",
                        "path", normalizedPath(req),
                        "type", firstErrorType(report)).increment();
            }
        } catch (Exception e) {
            // ⚠️ 驗證本身失敗絕不能影響正式流量
            log.debug("契約驗證失敗（已忽略）", e);
        }
        return body;
    }
}
```

**⚠️ 三個安全要求**：

| 要求 | 說明 |
|---|---|
| **抽樣**（0.1%） | 驗證有 CPU 成本，不能對每個回應做 |
| **只記錄，絕不改變回應** | 驗證失敗不能讓使用者的請求失敗 |
| **驗證本身的例外要吃掉** | 否則驗證器的 bug 會變成生產事故 |

**這個機制抓到的典型問題**：

```
CI 的測試資料：訂單都有 shippingAddress
正式環境：某些 2019 年的舊訂單 shippingAddress 是 null
→ 契約說 required → 契約漂移
→ 🔴 而且客戶端的非 optional 型別會 crash（第 06 章 6.3.2）
```

**這類「只有特定歷史資料才會觸發」的問題，只有正式環境的抽樣驗證能抓到。**

### 9.7.4 Consumer 用量追蹤

```java
Counter.builder("api.requests")
       .tag("consumer", consumer == null ? "unidentified" : consumer)
       .tag("version", version == null ? "unknown" : major(version))   // ★ 只取主版本（降基數）
       .tag("endpoint", normalizedPath(req))
       .tag("status", statusClass(res.getStatus()))                     // 2xx/4xx/5xx
       .register(registry).increment();

// ★ 已棄用項目的使用追蹤（第 06 章 6.8.3）
deprecationRegistry.usedIn(req, res).forEach(dep ->
        Counter.builder("api.deprecated.usage")
               .tag("item", dep.id())
               .tag("consumer", consumerOrUnidentified)
               .register(registry).increment());
```

**要看的儀表板**：

```
Consumer 健康度
─────────────────────────────────────────────────────────────
Consumer        版本   QPS    4xx%    5xx%   已棄用項目使用
shop-web        3.x    142    0.8%    0.01%   0
shop-ios        4.x     45    1.2%    0.02%   0
shop-ios        3.x      8    2.1%    0.01%   2   ← ⚠️ 舊版
shop-android    4.x     38    1.0%    0.01%   0
vendor-a-erp    -      8.3    0.1%    0.00%   1   ← ⚠️
vendor-b-erp    -      1.3    0.3%    0.00%   0
unidentified    -      0.4   12.4%    0.05%   3   ← 🔴
```

**這張表回答了第 06 章 6.8 最重要的問題：「還有誰在用舊的？」**

```
shop-ios 3.x 有 8 QPS 且用了 2 個已棄用項目
→ 查該版本的使用者數
→ 決定 Sunset 日期，或考慮 App 內強制升級
```

---

## 9.8 shop-service 的測試套件

### 9.8.1 結構

```
src/test/java/com/example/shop/
├── unit/                                    ① 單元（數百個）
│   ├── domain/OrderStateMachineTest.java
│   ├── domain/MoneyTest.java
│   ├── api/CursorCodecTest.java             cursor 編解碼
│   ├── api/FingerprintTest.java             請求指紋正規化
│   └── api/DateRangeFilterTest.java         5.8.2 的日期邊界
│
├── web/                                     ② Web 切片
│   ├── OrderControllerTest.java
│   ├── contract/StatusCodeContractTest.java      9.4.1
│   ├── contract/ErrorFormatContractTest.java     9.4.2
│   └── contract/OpenApiValidationTest.java       9.3.2
│
├── integration/                             ③ 整合
│   ├── AbstractIntegrationTest.java              9.2.3 共用容器
│   ├── OrderIntegrationTest.java
│   ├── contract/PaginationContractTest.java      9.4.3
│   ├── contract/IdempotencyContractTest.java     9.4.4
│   ├── contract/CacheContractTest.java           9.4.4
│   ├── contract/RateLimitContractTest.java       9.4.4
│   ├── contract/AllEndpointsContractTest.java    9.3.2
│   └── security/ApiSecurityRegressionTest.java   9.4.5 ★ 最高優先
│
├── pact/                                    ④ 契約（僅內部微服務）
│   └── InventoryServicePactTest.java
│
└── openapi/
    ├── OpenApiSnapshotTest.java             7.6.4
    └── ExamplesValidationTest.java          7.7.2

api/
├── http/                                    開發用
├── hurl/                                    ⑤⑥ CI + 合成監控
└── __tests__/spectral.test.mjs              7.13 練習 3
```

### 9.8.2 CI pipeline

```yaml
name: CI
on: [pull_request, push]

jobs:
  # ── 快（< 2 分鐘）：每次 push 都跑 ────────────────
  fast:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with: { java-version: '21', distribution: temurin, cache: maven }
      - name: 單元 + Web 切片測試
        run: ./mvnw -B test -Dgroups='unit|web'
      - name: Spectral lint
        run: |
          npx @redocly/cli bundle api/orders-api.yaml -o dist/orders-api.yaml
          npx @stoplight/spectral-cli lint dist/orders-api.yaml \
            --fail-severity error --format github-actions
      - name: Spectral 規則自身的測試
        run: npx vitest run api/__tests__/spectral.test.mjs
      - name: 範例符合 schema
        run: ./mvnw -B test -Dtest=ExamplesValidationTest

  # ── 契約檢查（並行）──────────────────────────────
  contract:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - run: ./scripts/check-breaking-changes.sh
      - run: ./scripts/check-contract-drift.sh
      - run: ./scripts/smoke-test-mock.sh

  # ── 慢（5~10 分鐘）─────────────────────────────
  integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with: { java-version: '21', distribution: temurin, cache: maven }
      - run: ./mvnw -B verify -Dgroups=integration
        env: { CI: 'true' }

  # ── 資安（獨立 job，失敗必須阻止合併）───────────
  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with: { java-version: '21', distribution: temurin, cache: maven }
      - run: ./mvnw -B verify -Dgroups=security
      - run: ./scripts/scan-sensitive-fields.sh

  # ── 部署後 ───────────────────────────────────────
  deploy-staging:
    if: github.ref == 'refs/heads/main'
    needs: [fast, contract, integration, security]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: ./scripts/deploy.sh staging
      - name: Hurl 冒煙測試
        run: |
          hurl --test \
            --variable host=https://staging-api.shop.example/v1 \
            --variable smokeEmail="${{ secrets.SMOKE_EMAIL }}" \
            --variable smokePassword="${{ secrets.SMOKE_PASSWORD }}" \
            --report-junit target/hurl.xml \
            api/hurl/*.hurl
      - run: ./scripts/publish-docs-and-mock.sh
```

**兩個關鍵設計**：

| 設計 | 理由 |
|---|---|
| **`fast` job 在 2 分鐘內** | 讓開發者願意等。超過 5 分鐘大家就會開始 push 完不看結果 |
| **`security` 是獨立的 job** | 讓「資安測試失敗」在 PR 上非常顯眼，而不是埋在幾百行的測試輸出裡 |

### 9.8.3 測試的優先序（如果時間有限）

| 優先 | 測試 | 為什麼 |
|---|---|---|
| **P0** | 資安迴歸（9.4.5） | 失敗的後果是事故。而且掃過所有端點，成本極低 |
| **P0** | 錯誤碼完整性（9.4.2 的 `@EnumSource`） | 一個測試涵蓋 66 個錯誤碼 |
| **P0** | OpenAPI 契約驗證（9.3.2） | 一行 `openApi().isValid()` 涵蓋 schema、狀態碼、header |
| **P1** | 冪等的併發測試（9.4.4） | 最難靠 code review 發現的 bug |
| **P1** | 分頁的穩定性（tie-breaker、cursor 遍歷） | 靜默的資料錯誤 |
| **P1** | 日期範圍邊界（9.4.3） | 財務 bug |
| **P1** | 快取的角色隔離（9.4.4） | 個資洩漏 |
| **P2** | 狀態碼契約（9.4.1） | 重要但比較容易在 review 發現 |
| **P2** | Hurl 冒煙（9.5.2） | 部署後的保險 |
| **P3** | 限流的細節 | 有 dry-run 與監控可以補 |
| **P3** | Pact | 成本高，且 9.3.4 的判斷可能是「不需要」 |

**⚠️ 注意 P0 的三項有一個共同特徵：它們都是「一個測試涵蓋很多東西」。**

```
資安掃描：       1 個測試 × 70 個端點
錯誤碼完整性：   1 個測試 × 66 個錯誤碼
OpenAPI 驗證：   1 行斷言 × 所有 schema 規則
```

**「用參數化測試涵蓋全部」比「為每個端點手寫測試」有效得多** ——
而且新增端點／錯誤碼時**自動被涵蓋**，不會漏。

---

## 9.9 常見誤區

**誤區 1：「API 測試就是 `@SpringBootTest` 打端點」**
9.2.1：大部分規則（狀態碼、錯誤格式、header、驗證）可以用 `@WebMvcTest` 測，
是毫秒級的。全用 `@SpringBootTest` 會讓測試跑 10 分鐘，然後大家開始 skip。

**誤區 2：「`@WebMvcTest` 會載入所有 Web 相關的元件」**
9.2.2：它**不會**自動載入 `@RestControllerAdvice`、Spring Security 的 filter chain、
自訂 Filter。錯誤格式測不到、401/403 測不到、冪等／限流測不到。

**誤區 3：「有 OpenAPI 就不用寫測試」**
9.3.2：契約只描述「應該是什麼」，測試驗證「實際是什麼」。
兩者的差距正是 bug 所在。

**誤區 4：「契約驗證要為每個端點手寫 schema 斷言」**
9.3.2：一行 `openApi().isValid()` 就涵蓋了 schema、狀態碼、Content-Type、必填 header。
手寫 `jsonPath` 斷言只該用在「契約無法表達的規則」（例如「`available` 必須小於 `requested`」）。

**誤區 5：「Pact 是契約測試的標準答案」**
9.3.4：Pact 的成本很高（provider state、Broker、兩邊都要投入）。
對「同團隊的前端」可能不需要；對「外部廠商」通常做不到。要有意識地判斷。

**誤區 6：「資安測試是資安團隊的事」**
9.4.5：「回應不含 `passwordHash`」「顧客不能讀別人的訂單」是**API 測試**，
而且是最便宜、最高價值的測試。

**誤區 7：「掃過所有端點的參數化測試很容易寫」**
9.4.5：如果路徑參數沒替換好，會測到無效路徑然後拿到 `400` → **假的綠燈**。
一定要加「涵蓋率檢查」。

**誤區 8：「測試通過就代表契約沒漂移」**
9.7.3：CI 的測試資料涵蓋不到「2019 年的歷史資料」。需要正式環境的抽樣驗證。

**誤區 9：「合成監控就是打健康檢查端點」**
9.5.2：`/actuator/health` 回 `UP` 不代表 API 能用。
要測真實的端點，而且**要測錯誤格式**（`404` 的回應是不是還符合契約）。

**誤區 10：「後端決定契約，前端照做」**
9.6.1：這會產生「不好用的 API」（N+1 API、缺 `statusLabel`）。
前端對「這些欄位夠不夠」要有否決權。

**誤區 11：「不確定要不要的欄位先加上，以後可能用到」**
9.6.1：加欄位是相容的，**移除是破壞性的**。
所以「不確定」時應該**先不要**（之後隨時能加）。

**誤區 12：「契約 review 會議是浪費時間」**
第 07 章 7.8.3：改 YAML 的成本是 10 分鐘，改已實作的 API 是 3 天。
這個會議取代了「整合階段的三次協調會」。

**誤區 13：「測試寫得越多越好」**
9.8.3：優先寫「一個測試涵蓋很多東西」的參數化測試。
70 個端點各寫 10 個手工測試 = 700 個測試 = 沒人維護。

---

## 9.10 本章練習

### 練習 1：設計測試分層

以下規則各該測在哪一層？為什麼？

```
1.  訂單金額 = 小計 + 折扣 + 運費 + 稅
2.  GET /orders 空結果回 200 + []
3.  訂單狀態機：SHIPPED 不能取消
4.  cursor 的 base64 編解碼正確
5.  相同 Idempotency-Key 併發 20 次只建立一張訂單
6.  PATCH 沒帶 If-Match 回 428
7.  兩個客服同時改同一張訂單，第二個回 412
8.  顧客不能讀別人的訂單
9.  回應不含 passwordHash
10. 完整下單流程：加購物車 → 結帳 → 付款 → 出貨
11. 錯誤碼都有 zh-TW 與 en 的訊息
12. createdTo=2026-08-31 包含 8/31 整天
13. 正式環境的 /orders 回應符合契約
14. 搜尋「王小明」走的是姓名索引而非全表掃描
```

<details>
<summary>參考解答</summary>

| # | 層 | 理由 |
|---|---|---|
| 1 | **① 單元** | 純計算，不需要 Spring 或資料庫。應該有大量邊界測試（負數折扣、零稅率、幣別小數位） |
| 2 | **② Web 切片** | mock 掉 Service 回空的 `PageResponse` → 驗證序列化成 `[]` 而非 `null`。10ms |
| 3 | **① 單元 + ② Web 切片** | ① 測 `OrderStateMachine.canCancel(SHIPPED) == false`<br>② 測「拋 `OrderNotCancellableException` → `409` + 正確的 `code`」<br>★ **兩層都要**：① 測業務規則，② 測 HTTP 轉換 |
| 4 | **① 單元** | 純函式。要測：編碼→解碼往返、篡改的 cursor 拒絕、超長拒絕、版本不符拒絕 |
| 5 | **③ 整合** | 需要真的 Redis + 真的併發 + 真的資料庫。<br>⚠️ **無法用 mock 測**（競態條件只在真實併發下出現） |
| 6 | **② Web 切片** | 只是「沒帶 header → 回 428」，不需要真實資料 |
| 7 | **③ 整合** | 需要真的版本衝突。⚠️ mock 的話你只是在測「mock 拋了例外會怎樣」 |
| 8 | **③ 整合**（security 群組） | 需要真實的兩個使用者 + 真實資料。<br>要驗證「查詢條件真的包含 customer_id」——這只有真 SQL 才測得到 |
| 9 | **③ 整合**（security 群組，掃所有端點） | 需要真實的完整回應（mock 的 DTO 不會有 Entity 的欄位） |
| 10 | **⑤ E2E**（Hurl / `.http`） | 跨多個端點的流程。⚠️ 只做 happy path（錯誤分支在 ② 測） |
| 11 | **① 單元**（`@EnumSource`） | 只需要 `MessageSource`，不需要 HTTP。一個測試涵蓋所有錯誤碼 |
| 12 | **① 單元 + ③ 整合** | ① 測 `toExclusive("2026-08-31")` 回 `2026-08-31T16:00:00Z`<br>③ 測「真的建一筆 8/31 23:30 的訂單，查詢能撈到」<br>★ **兩層都要**：① 測轉換邏輯，③ 測 SQL 的邊界真的對 |
| 13 | **⑥ 正式環境抽樣**（9.7.3） | CI 的測試資料涵蓋不到歷史資料的邊界 |
| 14 | **③ 整合**（用 `EXPLAIN` 斷言） | 見下 |

**第 14 題值得展開：怎麼測「走了索引」**

```java
@Test
void 姓名搜尋走索引而非全表掃描() throws Exception {
    testDataFactory.orders("cus_test", 5000);        // 建 5000 筆讓最佳化器有意義

    List<Map<String, Object>> plan = jdbc.queryForList("""
            EXPLAIN FORMAT=JSON
            SELECT id, order_number FROM orders
            WHERE region_id IN ('r_north') AND recipient_name = ?
            ORDER BY created_at DESC, id DESC LIMIT 21
            """, "王小明");

    String json = (String) plan.get(0).values().iterator().next();

    assertThat(json).as("查詢不可使用全表掃描")
            .doesNotContain("\"access_type\": \"ALL\"");
    assertThat(json).as("應使用 idx_orders_region_name 索引")
            .contains("idx_orders_region_name");
    assertThat(json).as("排序應由索引完成，不可 filesort")
            .doesNotContain("\"using_filesort\": true");

    long examined = mapper.readTree(json)
            .path("query_block").path("table").path("rows_examined_per_scan").asLong();
    assertThat(examined).as("掃描列數應接近 LIMIT，實際掃了 %d 筆", examined)
            .isLessThan(100);
}
```

**這種「執行計畫測試」是很少人做但價值很高的**：

| 價值 | 說明 |
|---|---|
| 防止「加了欄位／改了查詢後索引失效」 | 這是最常見的效能退化原因 |
| 防止「刪了索引」 | migration 刪索引時測試會失敗 |
| 讓「效能」變成可迴歸的 | 而不是「上線後才發現慢」 |

**⚠️ 但要小心三件事**：

| 注意 | 說明 |
|---|---|
| 資料量要足夠 | 100 筆資料時 MySQL 會選全表掃描（因為更快）→ 測試失敗但那是正確的 |
| MySQL 版本差異 | `EXPLAIN FORMAT=JSON` 的欄位名在不同版本可能不同 |
| 不要斷言得太細 | 斷言「用了某個索引」可以；斷言「cost 是 12.34」會很脆弱 |

**這一題的三個核心判斷**

**① 「需不需要真實的併發／真實的 SQL」決定了 ② 還是 ③**

```
第 5、7 題：競態條件與樂觀鎖 → 必須 ③（mock 測不到）
第 2、6 題：只是序列化與 header → ② 就夠（快 200 倍）
```

**② 有些規則需要「兩層都測」**

```
第 3、12 題：
  ① 測「邏輯正確」
  ②/③ 測「這個邏輯真的被 HTTP 層／SQL 層正確使用」

只測 ① → 邏輯對但沒接上
只測 ③ → 邊界情況測不完（③ 太慢）
```

**③ 資安測試一律在 ③（整合層）**

```
第 8、9 題必須用真實資料與真實 SQL：
  - mock 的 Service 不會有 Entity 的敏感欄位 → 第 9 題測不到
  - mock 的 Repository 不會執行真的 WHERE customer_id = ? → 第 8 題測不到
```

</details>

### 練習 2：把規則變成測試

第 03 章 3.7.2 有一條規則：「集合永遠回 `[]`，絕不回 `null`」。
請寫出「涵蓋所有端點」的測試，確保這條規則在整個 API 都成立。

<details>
<summary>參考解答</summary>

**這題的難點：怎麼「涵蓋所有端點的所有集合欄位」？** 三種做法，由弱到強。

**做法 1：掃描實際回應（動態，會漏）**

```java
@ParameterizedTest
@MethodSource("allGetEndpoints")
void 回應中的集合欄位不可為null(String uri) throws Exception {
    String body = authed(get(uri)).andReturn().getResponse().getContentAsString();
    if (body.isBlank()) return;

    Set<String> arrayPaths = openApiArrayFieldPaths();        // 從契約取得
    List<String> nullArrays = allFieldPaths(body).stream()
            .filter(arrayPaths::contains)
            .filter(p -> valueAt(body, p).isNull())
            .toList();

    assertThat(nullArrays)
            .as("端點 %s 的以下欄位是 null 但應該是陣列", uri)
            .isEmpty();
}
```

**⚠️ 弱點：只驗證「這次的測試資料」產生的回應。**

```
測試資料的訂單都有 shipments → 測不到「沒有 shipments 時是否回 []」
```

**做法 2：對 DTO 做反射檢查（靜態，涵蓋完整）★ 推薦**

```java
class CollectionNeverNullTest {

    /**
     * ★ 掃描所有 API DTO，確認每個集合型別的欄位都不可能是 null。
     * 「靜態」檢查 —— 不依賴測試資料，涵蓋所有可能的情況。
     */
    @ParameterizedTest
    @MethodSource("allApiResponseDtos")
    void 集合欄位在建構時被正規化為空集合(Class<?> dto) throws Exception {
        List<RecordComponent> collections = Arrays.stream(dto.getRecordComponents())
                .filter(rc -> Collection.class.isAssignableFrom(rc.getType())
                           || Map.class.isAssignableFrom(rc.getType()))
                .toList();
        if (collections.isEmpty()) return;

        // ★ 用「全部參數都給 null」建構，看集合欄位是否被正規化
        Object instance = newInstanceWithAllNulls(dto);

        for (RecordComponent rc : collections) {
            Object value = dto.getMethod(rc.getName()).invoke(instance);
            assertThat(value)
                    .as("""
                        %s.%s 是集合型別但傳入 null 時未被正規化。
                        請在 record 的 compact constructor 加上：
                            %s = %s == null ? List.of() : List.copyOf(%s);
                        （第 03 章 3.7.2）
                        """.formatted(dto.getSimpleName(), rc.getName(),
                                      rc.getName(), rc.getName(), rc.getName()))
                    .isNotNull();
        }
    }

    static Stream<Class<?>> allApiResponseDtos() {
        return scanClasses("com.example.shop.api.dto")
                .filter(Class::isRecord)
                .filter(c -> c.getSimpleName().matches(".*(Response|Detail|Summary)$"));
    }
}
```

**為什麼這個做法更強**：

| 優勢 | 說明 |
|---|---|
| **不依賴測試資料** | 直接測「DTO 的建構行為」 |
| **涵蓋所有 DTO** | 新增 DTO 時自動被檢查 |
| **錯誤訊息告訴你怎麼修** | 直接給出要加的程式碼 |
| **快** | 純反射，毫秒級 |

**⚠️ 限制**：只對 `record` 有效（用 Lombok `@Builder` 的類別要另外處理）。

**做法 3：在契約層面禁止（Spectral，最上游）**

```yaml
rules:
  array-must-not-be-nullable:
    description: |
      陣列型別的欄位不可為 nullable（第 03 章 3.7.2）。
      空集合請回 []，而非 null —— 否則客戶端的 items.map() 會爆掉。
    severity: error
    given: "$.components.schemas..properties[?(@.type == 'array')]"
    then:
      - field: nullable
        function: falsy

  array-must-be-required:
    description: |
      陣列欄位應該是 required（因為空集合也要回 []）。
      若某個陣列真的「可能不存在」（例如 ?expand= 才出現），
      請加 x-conditionally-present: true 並在 description 說明。
    severity: warn
    given: "$.components.schemas[?(@.type == 'object')]"
    then:
      function: arrayFieldsAreRequired
```

```javascript
// spectral-functions/arrayFieldsAreRequired.js
export default function arrayFieldsAreRequired(schema, _opts, ctx) {
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const results = [];
  for (const [name, prop] of Object.entries(props)) {
    if (prop.type !== 'array') continue;
    if (prop['x-conditionally-present'] === true) continue;
    if (!required.has(name)) {
      results.push({
        message:
          `陣列欄位 "${name}" 不在 required 中。空集合應回 [] 而非省略。` +
          `若此欄位真的可能不存在，請加 x-conditionally-present: true。`,
        path: [...ctx.path, 'properties', name],
      });
    }
  }
  return results;
}
```

**三個做法的組合（shop-service 的實際配置）**

```
① Spectral（契約層）  → 防止「契約允許 nullable 陣列」
                        最上游，PR 就被擋住

② DTO 反射（程式層）  → 防止「DTO 沒做正規化」
                        涵蓋所有 DTO，不依賴測試資料

③ 回應掃描（執行層）  → 防止「mapper 繞過了 DTO 的正規化」
                        抓漏網之魚（例如用 Map 直接組回應）
```

**⚠️ 為什麼三層都要？**

```
只有 ①：契約對了，但實作可能還是回 null
只有 ②：DTO 對了，但如果有端點用 Map<String,Object> 組回應就繞過了
只有 ③：只涵蓋測試資料觸發到的路徑
```

**這是「防禦性設計」的一般模式**（和第 08 章 8.5.5 的「每一層都是別人的安全網」同一個思路）。

**加一個「這條規則有被測到」的元測試**

```java
/**
 * ★ 元測試：確認上面的檢查真的會失敗。
 * 沒有這個測試，你不知道「測試通過」是因為程式對，還是因為測試沒在測東西。
 */
@Test
void 集合正規化的檢查真的會抓到違規() {
    record BadDto(String id, List<String> tags) {}     // 故意不做正規化

    assertThatThrownBy(() -> assertCollectionsNormalized(BadDto.class))
            .isInstanceOf(AssertionError.class)
            .hasMessageContaining("BadDto.tags")
            .hasMessageContaining("compact constructor");
}
```

**這種「元測試」對「掃過所有東西」的參數化測試特別重要** ——
因為那類測試最容易變成「掃了 0 個東西然後通過」（9.4.5 的假綠燈問題）。

**這一題的核心教訓**

> **把一條規則變成測試，通常有「上游／中游／下游」三個位置可以做。**
>
> - **上游**（契約 lint）：最便宜，PR 就擋住，但只約束契約
> - **中游**（型別／DTO 檢查）：涵蓋完整，不依賴測試資料
> - **下游**（實際回應掃描）：最真實，但只涵蓋測試資料觸發的路徑
>
> **重要的規則值得三個都做** —— 而「集合不可為 null」是重要的規則，
> 因為它的失敗模式是「前端整頁白畫面」。

</details>

### 練習 3：診斷測試套件的問題

某團隊的 API 測試現況：

```
測試數量：412 個
執行時間：14 分 32 秒
  @SpringBootTest：380 個（92%）
  @WebMvcTest：     18 個
  純單元：          14 個
覆蓋率：行覆蓋 78%

團隊反映：
- 「測試太慢，我都直接 push 讓 CI 跑」
- 「有 30 幾個測試是 flaky 的，失敗就重跑」
- 「上個月有三次『測試通過但正式環境壞掉』」
- 「新增端點時複製一個舊測試改，但常常忘記改斷言」
- 「錯誤格式的測試只有 5 個（66 個錯誤碼）」
```

請診斷並提出改善計畫。

<details>
<summary>參考解答</summary>

**診斷：五個結構性問題**

**問題 1：測試金字塔完全倒置（92% 是 `@SpringBootTest`）**

```
理想（9.2.1）：  ① 60~70%  ② 20~30%  ③ 5~10%
現況：           ①  3.4%   ②  4.4%   ③ 92.2%   ← 完全倒置
```

**後果推導**：

```
380 個 @SpringBootTest × 平均 2 秒 = 12.7 分鐘
→ 這就是 14 分 32 秒的來源
→ 「我都直接 push 讓 CI 跑」的直接原因
```

**根因猜測**：`@SpringBootTest` 是「什麼都能測」的萬用解 →
沒有人思考「這個測試需要啟動整個應用程式嗎」→ 逐漸累積。

**問題 2：Flaky 測試（30 幾個）**

**`@SpringBootTest` 佔 92% 是 flaky 的主要原因**：

| Flaky 來源 | 為什麼 `@SpringBootTest` 特別容易 |
|---|---|
| **測試間的資料污染** | 共用資料庫，測試 A 建的資料影響測試 B |
| **執行順序依賴** | 測試 A 必須在 B 之前跑 |
| **時間依賴** | `Instant.now()` 在邊界時失敗（例如跨日） |
| **併發／非同步** | `@Async`、事件監聽器的時序 |
| **Context 快取失效** | 不同的 `@MockBean` 組合 → 重新啟動 context |

**「失敗就重跑」是最危險的反應** ——
它讓「真的 bug」和「flaky」無法區分，於是真的 bug 也被重跑掉了。
**這幾乎確定是「三次測試通過但正式環境壞掉」的原因之一。**

**問題 3：「測試通過但正式環境壞掉」的五種可能**

| 可能原因 | 對應的缺失 |
|---|---|
| **錯誤格式測試不足**（5 個 vs 66 個錯誤碼） | 92% 的錯誤路徑沒測 |
| **沒有契約驗證** | 實作和文件不一致（第 07 章 7.4.4） |
| **flaky 測試被重跑掉** | 真的 bug 被當成 flaky |
| **測試資料不真實** | CI 用乾淨的資料，正式環境有歷史資料（9.7.3） |
| **沒有資安測試** | 欄位洩漏、IDOR 上線才發現 |

**問題 4：「複製舊測試改」造成的假綠燈**

```java
// 危險的版本：只剩一個斷言
@Test
void 查詢商品() throws Exception {
    mockMvc.perform(get("/v1/products/P-1001"))
            .andExpect(status().isOk());            // 🔴 永遠通過，但什麼都沒測
}
```

**「只斷言 status 200」的測試比沒有測試更糟** —— 它給人「有測試」的錯覺。

**問題 5：覆蓋率 78% 但錯誤路徑幾乎沒測**

**行覆蓋率是誤導性的指標**：

```java
// 這個方法的行覆蓋率可以達到 100%，但只測了 happy path
public OrderDetail create(CreateOrderRequest req) {
    validate(req);                        // ← 執行了（但沒測驗證失敗）
    Product p = findProduct(req);          // ← 執行了（但沒測商品不存在）
    checkStock(p, req.quantity());         // ← 執行了（但沒測庫存不足）
    return save(...);
}
```

**該看的指標是「分支覆蓋」與「錯誤碼覆蓋」**：

```java
@Test
void 每個錯誤碼都至少有一個測試涵蓋() {
    Set<String> tested = collectErrorCodesFromTestResults();
    Set<String> all = Arrays.stream(ErrorCode.values()).map(Enum::name).collect(toSet());
    assertThat(all).as("以下錯誤碼沒有任何測試涵蓋").isSubsetOf(tested);
}
```

**改善計畫（四個階段，共 8 週）**

```
═══ 階段 0：止血（Week 1）═════════════════════════════

□ 禁止「失敗就重跑」
   → CI 移除自動重試設定
   → 每個 flaky 開一個 issue（標籤 flaky）
   → ⚠️ 這會讓 CI 一開始經常紅 —— 要事先溝通這是刻意的

□ 標記所有測試的分組
   @Tag("unit") / @Tag("web") / @Tag("integration") / @Tag("security")

□ 拆 CI job（立刻改善開發體驗）
   fast job：       unit + web    → 目標 < 2 分鐘
   integration job：integration   → 可以慢
   → 開發者 push 後 2 分鐘就有回饋

□ 建立「不可只斷言 status」的檢查（ArchUnit 或自訂靜態分析）

═══ 階段 1：補最高價值的測試（Week 2-3）═══════════════

★ 這個階段不重構舊測試，只加新的高價值測試

□ P0：資安迴歸測試（9.4.5）—— 約 8 個測試，涵蓋一整類事故
□ P0：錯誤碼完整性（9.4.2 的 @EnumSource）—— 1 個測試涵蓋 66 個錯誤碼
     → 直接解決「錯誤格式測試只有 5 個」
□ P0：OpenAPI 契約驗證（9.3.2）
     → 對現有的 380 個測試加上 openApi().isValid()
     → ★ 一行改動換巨大價值，不用重寫測試
□ 建立「錯誤碼覆蓋率」指標並在 CI 顯示

═══ 階段 2：拆分測試（Week 4-6）═══════════════════════

□ 分析 380 個 @SpringBootTest：
   A. 只測狀態碼/錯誤格式/序列化 → 降級為 @WebMvcTest（估計 60%）
   B. 只測純邏輯               → 降級為單元測試（估計 15%）
   C. 真的需要真實 SQL/併發/Redis → 保留（估計 25%）

□ 降級的優先序：從「最慢的」開始
   → 找出最慢的 50 個測試先處理
   → ★ 帕雷托法則：處理 20% 的測試可能省下 60% 的時間

□ 建立共用的整合測試基底（9.2.3）
   → 所有整合測試共用同一組容器 + 同一個 Spring context
   → ★ 這一步可能就讓整合測試從 12 分鐘變 4 分鐘

□ 目標：fast < 2 分鐘、integration < 5 分鐘、總計 < 7 分鐘

═══ 階段 3：消滅 flaky（Week 6-8）═════════════════════

□ 逐一處理 30 幾個 flaky
   - 資料污染   → @Transactional 或每個測試 reset
   - 順序依賴   → 讓每個測試自己準備資料
   - 時間依賴   → 注入 Clock（Clock.fixed()）
   - 非同步時序 → Awaitility 而非 Thread.sleep()
   - Context 重啟 → 收斂 @MockBean 的組合

□ 建立 flaky 偵測：每晚跑三次完整測試，比對失敗的測試
□ 加入正式環境的契約漂移偵測（9.7.3）

═══ 持續 ════════════════════════════════════════════

□ 新測試的規則（寫進 PR template）
   □ 預設用 @WebMvcTest，只有「需要真實 SQL/併發/Redis」才用 @SpringBootTest
   □ 每個測試至少 3 個斷言（不可只斷言 status）
   □ 新增錯誤碼 → @EnumSource 自動涵蓋（不用另外寫）
   □ 新增端點 → 資安掃描自動涵蓋（要加測試資料 ID）
```

**預期成果**

| 指標 | 現況 | 目標 | 怎麼達成 |
|---|---|---|---|
| 總執行時間 | 14 分 32 秒 | **< 7 分鐘** | 階段 2 |
| 開發者的回饋時間 | 14.5 分鐘 | **< 2 分鐘** | 階段 0 |
| `@SpringBootTest` 比例 | 92% | **< 25%** | 階段 2 |
| Flaky 測試數 | 30+ | **0** | 階段 3 |
| 錯誤碼覆蓋 | 5/66（8%） | **66/66** | 階段 1 |
| 資安測試 | 0 | **8 個（掃全部端點）** | 階段 1 |
| 契約驗證 | 0 | **所有端點** | 階段 1（一行改動） |
| 「測試通過但正式壞掉」 | 3 次/月 | **< 1 次/季** | 階段 1 + 3 |

**⚠️ 三個常見的改善計畫失敗原因（要事先處理）**

| 失敗原因 | 預防 |
|---|---|
| **「先重構所有舊測試」** | 這會花三個月且沒有立即價值。<br>**階段 1 刻意「只加新的」** —— 兩週就有明顯效果 |
| **「移除重試後 CI 一直紅，大家受不了」** | 事先溝通這是刻意的；階段 0 同時拆 job（讓 fast job 是綠的）；<br>給 flaky 一個「已知問題」清單 |
| **「拆分測試時把測試改壞了」** | 降級後手動把實作改壞，確認測試會失敗（變異測試的思路） |

**這一題的核心教訓**

> **「測試太慢」不是「電腦太慢」，是「測試分層錯了」。**
>
> 92% 的測試用 `@SpringBootTest` 會同時造成四個問題：
> 慢、flaky、覆蓋不足（因為太貴所以不寫錯誤路徑）、假的信心。
>
> 而改善的關鍵順序是：
> 1. **先拆 CI job**（立刻改善開發體驗，成本 1 小時）
> 2. **再加高價值測試**（兩週見效，不動舊測試）
> 3. **最後才重構**（慢工，但已經有前兩步的收益支撐）
>
> **不要一開始就重構 380 個測試** —— 那會讓改善計畫在第三週被放棄。

</details>

### 練習 4：設計 consumer 的合規檢查

第 06 章 6.13 練習 5 設計了「provider 提供給 consumer 的測試套件」。
請設計它的**執行與追蹤機制**：怎麼讓 consumer 真的去跑，以及你怎麼知道他們跑了。

<details>
<summary>參考解答</summary>

**核心問題：你無法強迫 consumer 跑測試。所以要用「誘因」而不是「規定」。**

**機制 1：把合規變成「可見的狀態」+ 誘因**

```http
GET /v1/compliance/my-status
Authorization: Bearer <consumer token>
```

```jsonc
{
  "consumer": { "clientId": "vendor-c-erp", "displayName": "廠商 C ERP" },
  "complianceScore": 72,
  "grade": "C",
  "lastTestRun": {
    "at": "2026-08-12T03:14:22Z", "version": "2.1.0", "suiteVersion": "1.4.0",
    "passed": 10, "failed": 4, "daysAgo": 7
  },
  "checks": [
    { "requirement": 1, "title": "忽略未知欄位", "status": "PASS", "source": "TEST_SUITE" },
    { "requirement": 2, "title": "處理未知列舉值", "status": "FAIL", "source": "TEST_SUITE",
      "detail": "未知 status 的顯示結果是 undefined",
      "guide": "https://api.shop.example/docs/enums#unknown-values" },
    { "requirement": 8, "title": "分頁跟著 links.next 走", "status": "FAIL",
      "source": "TRAFFIC_ANALYSIS",
      "detail": "過去 7 天有 1,204 次自行組裝 page 參數的請求" },
    { "requirement": 10, "title": "關鍵操作帶 Idempotency-Key", "status": "FAIL",
      "source": "TRAFFIC_ANALYSIS",
      "detail": "POST /orders 的 48 次請求中，48 次未帶 Idempotency-Key" },
    { "requirement": 16, "title": "帶 X-Client-Version", "status": "WARN",
      "source": "TRAFFIC_ANALYSIS", "detail": "98% 有帶，2% 缺失" }
  ],
  "benefits": {
    "current": { "rateLimitMultiplier": 1.0, "earlyAccessEnabled": false,
                 "supportTier": "STANDARD" },
    "ifGradeA": { "rateLimitMultiplier": 1.5, "earlyAccessEnabled": true,
                  "supportTier": "PRIORITY",
                  "note": "達到 A 級（score >= 90 且無 FAIL）可享上述權益" }
  },
  "risks": [
    { "severity": "HIGH",
      "message": "因未處理未知列舉值，我們新增訂單狀態時你的畫面可能空白。我們預計 2026-11-01 新增 PENDING_REFUND。" },
    { "severity": "HIGH",
      "message": "因未帶 Idempotency-Key，網路重試時可能重複建立訂單。" }
  ]
}
```

**`benefits` 是整個機制的關鍵**：

| 誘因 | 說明 |
|---|---|
| **限流配額 × 1.5** | ★ 最有效 —— 這是 consumer 真正在意的東西 |
| **提早存取新功能** | 對積極的 consumer 有吸引力 |
| **優先技術支援** | 承諾更快的回應時間 |
| ⚠️ **不要用「罰」** | 「不合規就降配額」會讓對方覺得被威脅 → 反抗 |

**「獎勵而非懲罰」的理由**：consumer 不是你的下屬。

**機制 2：兩種資料來源（測試套件 + 流量分析）**

```
測試套件（consumer 主動跑）：
  ✅ 能測「客戶端的內部行為」（解析、渲染、未知值處理）
  ❌ 需要 consumer 配合

流量分析（你被動觀察）：
  ✅ 不需要 consumer 配合、反映真實行為
  ❌ 只能看到「請求的樣子」，看不到「客戶端怎麼處理回應」
```

**流量分析能偵測的項目**：

| 契約要求 | 怎麼從流量偵測 |
|---|---|
| 8. 跟著 `links.next` 走 | 比對「客戶端送的 URL」和「我們上次回的 `links.next`」是否一致 |
| 9. 用 `hasMore` 判斷結束 | 偵測「我們夾取了 `size` 但客戶端停止分頁」的模式 |
| 10. 帶 `Idempotency-Key` | 直接看 header |
| 11. 指數退避 + 抖動 | 分析重試的時間間隔分布（是否為固定間隔） |
| 16. 帶 `X-Client-Id/Version` | 直接看 header |
| 15. 訂閱 CHANGELOG | 看「已棄用項目」的使用量趨勢（有下降 = 有在跟進） |

**「偵測重試是否有抖動」的實作**：

```java
public RetryPattern analyze(String consumerId, Duration window) {
    List<List<Long>> intervals = loadRetryIntervals(consumerId, window);

    // 檢查 1：間隔是否遞增（指數退避）
    long notIncreasing = intervals.stream().filter(i -> !isIncreasing(i)).count();
    // 檢查 2：變異係數（有抖動的話 CV 應該 > 0.1）
    double avgCv = intervals.stream().mapToDouble(this::coefficientOfVariation)
                            .average().orElse(0);

    return new RetryPattern(notIncreasing == 0, avgCv > 0.1, intervals.size());
}
```

**這個分析能抓到第 08 章 8.5.1 的「重試風暴」風險** —— 在它造成事故**之前**。

**機制 3：讓執行變得極簡（降低門檻）**

```bash
# ★ 一行指令（不用安裝、不用設定）
npx @shop/api-contract-test --token $STAGING_TOKEN --adapter ./my-adapter.js
```

```javascript
// my-adapter.js —— consumer 只需要寫這幾行
export default {
  parseOrderList:    (json) => myApp.parseOrders(json),
  parseOrderDetail:  (json) => myApp.parseOrder(json),
  parseError:        (status, json) => myApp.handleApiError(status, json),
  paginateAll:       (fetchFn) => myApp.fetchAllOrders(fetchFn),
  renderOrderStatus: (order) => myApp.renderStatus(order),
};
```

**再提供三種「零設定」的整合方式**：

```yaml
# ① GitHub Action（consumer 加 3 行）
- uses: shop-example/api-contract-test-action@v1
  with:
    token: ${{ secrets.SHOP_STAGING_TOKEN }}
    adapter: ./contract-adapter.js
```

```
② Docker（不用 Node 環境）
   docker run --rm -v $(pwd):/app shop-example/contract-test \
     --token $STAGING_TOKEN --adapter /app/adapter.js

③ 我們幫你跑（最低門檻）
   consumer 提供一個 staging URL
   → 我們每週對它跑一次「黑箱」測試（只測 HTTP 行為）
   → 結果自動出現在 compliance 報告
```

**第 ③ 種的價值**：對「完全不願意配合」的 consumer，
你至少能測到一部分（分頁行為、冪等鍵、重試模式）。

**機制 4：測試結果自動回報（要透明）**

```markdown
## 測試結果的回報

測試套件會回報：套件版本、你的 client 版本、執行時間、環境（ci/local）、
每個檢查項目的通過/失敗狀態。

**不會**回報：
- 你的程式碼、adapter 的內容
- 失敗的詳細錯誤訊息（只有你在本機看得到）
- 任何你的業務資料

用 `--no-report` 可完全關閉回報（但你的 compliance 分數會顯示為「未測試」）。
```

**透明地說明「回報什麼、不回報什麼」是取得信任的前提。**

**機制 5：追蹤與升級路徑**

```
Consumer 合規儀表板（provider 內部）
──────────────────────────────────────────────────────────
Consumer       Grade  Score  上次測試   FAIL  高風險  趨勢
shop-web       A       98    2 天前      0     0      ↗
shop-ios       A       95    3 天前      0     0      →
shop-android   B       84    5 天前      1     0      ↗
vendor-a-erp   B       81    12 天前     1     1      →
vendor-b-erp   A       92    4 天前      0     0      ↗
vendor-c-erp   C       72    7 天前      4     2      ↘  🔴
vendor-d-erp   -        -    從未測試    ?     ?      -   🔴
```

| Grade | 行動 |
|---|---|
| **A**（≥ 90，無 FAIL） | ✅ 給予 benefits；可以安全地新增列舉值／欄位 |
| **B**（≥ 80） | 每月自動 email 摘要 |
| **C**（≥ 60） | 一對一聯繫，提供技術支援（甚至幫他們寫 patch） |
| **D**（< 60） | 升級到客戶經理；重大變更前必須個別協調 |
| **從未測試** | 主動聯絡；用流量分析評估風險 |

**最重要的用途：決定「破壞性變更的風險」**

```
要新增訂單狀態 PENDING_REFUND
→ 查 compliance 儀表板：
    - 5 個 consumer 是 A/B 級且「處理未知列舉值」PASS → ✅ 安全
    - vendor-c-erp 是 C 級且該項 FAIL → 🔴 會壞
    - vendor-d-erp 從未測試 → ⚠️ 風險未知
→ 決策：
    ① 先一對一協助 vendor-c 修好（提供程式碼範例）
    ② 對 vendor-d 做流量分析評估
    ③ 對這兩個 consumer 用降級對映（第 03 章 3.17 練習 4）
    ④ 其他 consumer 直接開放
```

**這正是第 06 章 6.4「把灰色變成黑白」想達成的**：

> **有了 compliance 資料，「新增列舉值是不是破壞性的」不再是猜測，
> 而是一個可以查詢的事實。**

**機制 6：讓 provider 自己也有 grade（互惠）**

```http
GET /v1/compliance/provider-status
```

```jsonc
{
  "provider": "shop-service",
  "commitments": [
    { "id": 1, "title": "不移除已發布的回應欄位", "status": "UPHELD", "violations": 0 },
    { "id": 4, "title": "不收緊 request 驗證", "status": "UPHELD", "violations": 0 },
    { "id": 7, "title": "移除前 180 天公告", "status": "UPHELD", "violations": 1,
      "note": "2025-11 因資安事件（SEC-2025-008）緊急移除 CustomerDetail.idNumber，公告期 3 天。已記入 allowlist 並經 DPO 核准。" }
  ],
  "metrics": {
    "uptime30d": 0.9997, "p99LatencyMs": 340,
    "breakingChangesLast12m": 1, "avgDeprecationNoticeDays": 213
  },
  "upcomingChanges": [
    { "type": "NEW_ENUM_VALUE", "target": "OrderStatus.PENDING_REFUND",
      "plannedAt": "2026-11-01",
      "riskToYou": "MEDIUM",
      "reason": "你的 compliance 檢查項目 2（處理未知列舉值）目前為 FAIL",
      "action": "請在 2026-10-15 前修正，或聯絡我們安排降級對映" }
  ]
}
```

| 價值 | 說明 |
|---|---|
| ★ **互惠感** | 「我們也對你負責」→ consumer 更願意配合 |
| ★ **`upcomingChanges` + `riskToYou`** | 直接告訴每個 consumer「這個變更對你的風險」 |
| 誠實面對自己的違規 | 第 7 條承認了一次違規並說明原因 → 建立信任 |

**`riskToYou` 是把兩邊的 compliance 資料交叉比對的產物** —— 這是整個機制最有價值的輸出。

**這一題的核心教訓**

> **Consumer Contract 的執行力 = 誘因設計 × 執行門檻的倒數。**
>
> - **誘因**：獎勵（配額 × 1.5）而非懲罰
> - **門檻**：一行指令 + 幾行 adapter + 三種零設定的整合方式
> - **不依賴配合**：流量分析讓你即使 consumer 完全不配合也有資料
> - **互惠**：provider 也公開自己的 compliance → 建立信任
>
> **最終的目的不是「讓 consumer 合規」，而是「讓你能夠自信地演進 API」** ——
> 有了 compliance 資料，「新增列舉值會不會打壞誰」變成一個可查詢的事實。

</details>

---

## 9.11 本站結業

### 9.11.1 你完成了什麼

**十章，一份完整的 API 設計方法論與一套可執行的規範。**

| 章 | 產出 |
|---|---|
| 00 | 領域盤點、訂單狀態機、動詞→資源對照表、六個 API 判準 |
| 01 | **70 條端點的 URL 表**、識別碼方案、非 CRUD 動作的五種手法 |
| 02 | **每條端點的方法／狀態碼契約**、15 條全域規則 |
| 03 | **22 個 DTO 全家族**、命名／金額／時間規範、列舉演進三層防護 |
| 04 | **約 66 個錯誤碼的錯誤目錄**、Problem Details 格式、前端消費程式碼 |
| 05 | **分頁／篩選／排序規格**、9 個索引、五層效能防護 |
| 06 | **Consumer Contract**、破壞性變更判定表、Expand-Contract 六步、棄用流程 |
| 07 | **`orders-api.yaml`**、25 條 Spectral 規則、五個 job 的 CI |
| 08 | **冪等／快取／限流完整規格**、三者的交互作用 |
| 09 | **測試套件**、協作流程、上線後的驗證 |

### 9.11.2 最終檢核

```
── 設計階段 ─────────────────────────────────────────
□ 畫了領域的狀態機（第 00 章 0.10.3）
□ 把需求的「動詞」翻成了「資源」（0.6.2）
□ 對每個動作問過「有沒有留下值得查詢的紀錄」（0.6.3）
□ 完成了 URL 表，且通過命名十規則（第 01 章 1.3）
□ 識別碼分了「內部 ID」與「對外編號」（1.4.3）
□ 巢狀深度不超過 2（1.5.2）
□ 每條端點的狀態碼契約都定了（第 02 章 2.13）
□ 關鍵寫入操作都要求 Idempotency-Key（2.2.4）
□ 多人協作的資源要求 If-Match（2.11.3）
□ DTO 分了 Request / Summary / Detail（第 03 章 3.3）
□ 金額、ID、時間的型別都定了（3.5、3.6）
□ 列舉有 statusLabel + statusCategory + allowedActions（3.10.2）
□ 錯誤目錄完成，每個 code 有 userMessage 與 retryStrategy（第 04 章 4.13）
□ 分頁上限、深分頁上限、日期範圍上限都定了（第 05 章 5.11.1）
□ 排序欄位有白名單且有對應索引（5.9）
□ 寫了 Consumer Contract 並提供測試工具（第 06 章 6.4）
□ 有版本策略與棄用流程（6.5、6.8）

── 實作階段 ─────────────────────────────────────────
□ orders-api.yaml 完成且通過 Spectral（第 07 章）
□ Prism mock server 可用，前端已開始並行開發（7.8）
□ 冪等鍵用原子操作實作，有請求指紋比對（第 08 章 8.2）
□ 需要認證的端點一律 private，錯誤一律 no-store（8.3）
□ 限流分桶且先 dry-run 一週（8.4）
□ ETag 涵蓋 version + locale + expand + role（8.3.4）

── 測試階段 ─────────────────────────────────────────
□ 資安迴歸測試（掃所有端點的敏感欄位、IDOR）（第 09 章 9.4.5）
□ 錯誤碼完整性測試（@EnumSource）（9.4.2）
□ OpenAPI 契約驗證（9.3.2）
□ 冪等的併發測試（9.4.4）
□ 分頁的穩定性測試（tie-breaker、cursor 遍歷）（9.4.3）
□ 日期邊界測試（9.4.3）
□ 快取的角色隔離測試（9.4.4）
□ CI 有五個 job（lint / breaking / drift / mock-smoke / publish）（7.9.3）
□ fast job < 2 分鐘（9.8.2）

── 上線後 ───────────────────────────────────────────
□ Hurl 冒煙測試 + 合成監控（9.5.2）
□ 契約漂移偵測（正式環境抽樣）（9.7.3）
□ Consumer 用量追蹤（9.7.4）
□ 「自家前端被限流」的告警（8.4.8）
□ 錯誤碼的指標與告警（4.12.5）
□ 每季的 API 健康度檢視（9.6.4）
```

### 9.11.3 如果只能帶走五件事

**1. 狀態碼是給機器的，訊息是給人的。**
全部回 200 會讓監控、熔斷、健康檢查、自動重試、客戶端函式庫全部失效。
這是本站唯一「一定不能妥協」的規則。

**2. 「這個動作有沒有留下值得查詢的紀錄？」**
有 → 它是資源（`payments`、`cancellations`、`shipments`、`inventory-adjustments`）。
這一個問題解決了 70% 的「非 CRUD 動作該怎麼設計」。

**3. 靜默破壞比大聲壞掉危險一百倍。**
改型別、改單位、改語意、改分頁基準 —— 這四種都不會拋錯，
但會讓客戶端「成功地拿到錯誤的資料」。**改語意必須改名字。**

**4. 相容性不是靠文件維持的，是靠工具維持的。**
Consumer Contract + 未知值注入 + OpenAPI diff + 契約驗證測試 + compliance 追蹤。
一份寫得再好的契約文件，如果 consumer 無法「跑一個指令就知道自己合不合規」，
它就只是一份免責聲明。

**5. 每一層都是別人的安全網。**
冪等鍵失效 → 業務表的 UNIQUE 約束擋住。
限流失效 → 業務層的 velocity guard 擋住。
慢查詢 → 連線池艙壁隔離。
DTO 忘記正規化 → Spectral 在契約層擋住。
**設計時要假設其他機制可能失效。**

### 9.11.4 下一站

```
[你剛完成] 03-rest-api      介面契約設計
                ↓
           04-controller    把契約實作出來
```

**04-controller 會實作這一站設計的東西**：

| 這一站設計的 | 04-controller 會實作 |
|---|---|
| 第 02 章的狀態碼契約 | `@ResponseStatus`、`ResponseEntity`、`ProblemDetail` |
| 第 03 章的 DTO 與驗證規則 | `@Valid`、`record` 綁定、`JsonNullable`、自訂 validator |
| 第 04 章的錯誤目錄 | `@RestControllerAdvice`、`ErrorCode` enum、i18n |
| 第 05 章的分頁規格 | `Pageable` 的坑、`Specification`、cursor 的實作 |
| 第 08 章的冪等／限流 | `OncePerRequestFilter`、`HandlerInterceptor` |
| 第 09 章的測試 | `@WebMvcTest`、MockMvc、契約驗證 |

**一個建議**：在開始 04-controller 之前，
把這一站的**六張表**（資源清單、URL 表、狀態碼契約、DTO 清單、錯誤目錄、查詢參數規格）
拉出來做一次團隊 review。

**這六張表就是你要實作的規格。** 有了它們，04-controller 就只是「把規格變成程式碼」——
而那是相對機械的工作。

**真正困難的部分，你已經完成了。**

---

## 9.12 驗收清單

- [ ] 我能說出 API 測試的六層，以及每一層測什麼、不測什麼、理想比例。
- [ ] 我知道 `@WebMvcTest` 是 API 測試的主力，而不是 `@SpringBootTest`。
- [ ] 我知道 `@WebMvcTest` 的三個坑（不載入 advice、不載入 Security、Filter 不執行）。
- [ ] 我能用共用的抽象基底類別讓所有整合測試共用容器與 Spring context。
- [ ] 我能區分三種「契約測試」（schema 驗證 / CDC / provider 驅動），並知道它們互補。
- [ ] 我會用 `openApi().isValid()` 一行涵蓋 schema、狀態碼、Content-Type、必填 header。
- [ ] 我能設計「YAML 描述情境 + 參數化測試」的架構，讓新增端點只要加情境。
- [ ] 我能實作 Pact，也知道 `can-i-deploy` 是它最有價值的功能。
- [ ] 我能誠實評估 Pact 的成本，並判斷「同團隊的前端可能不需要它」。
- [ ] 我知道 CDC 的獨特價值是「在編譯期知道哪些欄位真的有人用」。
- [ ] 我能把第 02 章的狀態碼契約變成測試，包含用參數化測試涵蓋狀態機。
- [ ] 我知道狀態機的參數化測試要再加一個「涵蓋所有狀態」的檢查。
- [ ] 我能用 `@EnumSource(ErrorCode.class)` 一個測試涵蓋所有錯誤碼的完整性。
- [ ] 我能測「驗證錯誤一次回全部」「敏感欄位被遮蔽」「5xx 不洩漏內部細節」。
- [ ] 我能測分頁的穩定性：tie-breaker、cursor 完整遍歷不重複不遺漏。
- [ ] 我能測「`createdTo` 包含當天整天」，並知道這防止的是財務 bug。
- [ ] 我能測冪等鍵的併發（20 個執行緒只建立一張訂單）。
- [ ] 我能測「JSON 欄位順序不同視為相同請求」與「5xx 不記錄冪等結果」。
- [ ] 我能寫「掃過所有端點檢查 `private`」的快取測試。
- [ ] 我能測「不同角色的 ETag 不同」與「顧客帶客服的 ETag 不會拿到 304」。
- [ ] 我知道資安迴歸測試是優先序最高的，也能列出它的九個項目。
- [ ] **我能把 OWASP API Security Top 10 的每一項對應回本站的章節與設計決策。**
- [ ] 我知道 API1（BOLA / IDOR）的測試必須**逐端點**，抽樣會漏掉出事的那一支。
- [ ] **我知道 API9（殭屍端點）只能靠「實際路由表 ⊖ OpenAPI 路徑」這個減法發現。**
- [ ] 我知道「不同角色用不同 DTO 型別」比「同一個 DTO 條件式塞欄位」安全，也說得出為什麼。
- [ ] 我知道這張表是「有沒有想過」的清單，不是「已經安全」的證明。
- [ ] 我知道「掃過所有端點」的參數化測試要加「涵蓋率檢查」，否則會有假綠燈。
- [ ] 我能組織 `.http` 檔案（含錯誤路徑），並知道它不適合 CI。
- [ ] 我能寫 Hurl 的冒煙測試，並知道它同時能用於正式環境的合成監控。
- [ ] 我知道合成監控的四個注意事項（專用帳號、不建真實資料、可排除、要清理）。
- [ ] 我能設計「共同擁有」的契約決策模式，並說出每個角色的否決權範圍。
- [ ] 我知道「不確定要不要的欄位先不要」，因為加是相容的、移除是破壞性的。
- [ ] 我能寫 ADR，並知道它要包含「考慮過的其他方案」與「負面後果」。
- [ ] 我能設計契約 review 的四類檢查清單（前端 / 後端 / 資安 / 相容性）。
- [ ] 我知道每季的「API 健康度檢視」該看哪六類資訊。
- [ ] 我能設計部署流程的四道檢查（CI / staging / canary / 全量）。
- [ ] 我能實作正式環境的契約漂移偵測，並知道它的三個安全要求。
- [ ] 我知道契約漂移偵測抓的是「CI 測試資料涵蓋不到的歷史資料」。
- [ ] 我能實作 consumer 用量追蹤，並用它回答「還有誰在用舊的」。
- [ ] 我知道測試的優先序，也知道 P0 的共同特徵是「一個測試涵蓋很多東西」。
- [ ] 我知道 `fast` job 必須 < 2 分鐘，`security` 要獨立成 job。
- [ ] 我能診斷「測試金字塔倒置」造成的四個問題（慢、flaky、覆蓋不足、假信心）。
- [ ] 我知道改善測試套件的順序是「拆 CI job → 加高價值測試 → 才重構」。
- [ ] 我知道「一條規則有上游／中游／下游三個測試位置」，重要的規則三個都做。
- [ ] 我知道「掃過全部」的參數化測試需要元測試（確認它真的會抓到違規）。
- [ ] 我能設計 consumer 合規的誘因機制（獎勵而非懲罰），並降低執行門檻。
- [ ] 我知道「流量分析」讓你在 consumer 不配合時也有資料。
- [ ] 我知道 compliance 資料的最終價值是「讓破壞性變更的風險變成可查詢的事實」。
- [ ] 我完成了 shop-service 的測試套件與協作規範。

---

**這一站結業了。** 完成後請前往 [../04-controller/](../04-controller/)。
