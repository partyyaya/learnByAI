# 04-controller 撰稿複查紀錄（作者側，非課程內容）

> ⚠️ **這個檔案不是給讀者的。** 它是原稿的三輪校對日誌 ——
> 記錄每一輪抓到什麼、修法、以及還沒關掉的風險。
>
> 課程本身在 `../README.md` 與各章檔案裡。
> **讀者不需要知道原稿的第幾版寫錯了什麼**；作者需要，
> 因為同一類錯誤會跨站重複出現。
>
> 👉 05-service 的對應檔案：`../../05-service/.authoring/review-log.md`

---

> **全書複查（七章寫完後做的一次）**：檢查了程式碼區塊配對、節號重複、
> 所有跨章與章內的節號引用（約 1,200 處，只有 3 處斷掉，已修）、
> 以及「被 `new` 出來但沒有定義的型別」。修正與補充的項目：
>
> | 項目 | 位置 | 說明 |
> |---|---|---|
> | `ErrorCode` 實際是 **79** 個，全書 20 處寫成 78 | 03、06、07、README | enum 是真相來源，統一改成 79 |
> | 補上 `CreateOrderResponse` / `CreateOrderCommand` / `CancelOrderCommand` | **新增 01 章 1.12.5** | 跨 5 章被引用 35 次卻從未定義；07 章 7.6.5 的核心測試就在斷言它的每個欄位 |
> | 補上 `InvalidSortFieldException`、`InvalidWebhookSignatureException` | 同上 | 01 章的正式程式碼在拋它們 |
> | 補上 `IdempotencyKeyReusedException` | **04 章 4.13.6** | 冪等機制裡最重要的例外，原本只有 `ErrorCode` 沒有類別 |
> | `plannedForLater` 清單與實際不符（列了 6 個，實際有 15 個未使用的 code） | 03 章 3.14.5 | 補齊並說明「為什麼刻意先定義完整的錯誤目錄」 |
> | **新增 `RequestBodyAdvice`**（原本全書 0 次） | **新增 06 章 6.6.5** | `ResponseBodyAdvice` 對稱的那一半：`handleEmptyBody`、body 解密、型別層級的稽核遮蔽 |
> | **新增關機的完整脈絡** | **新增 05 章 5.11.10** | 5.11.6 的 `shutdown()` 在 `server.shutdown` 預設值下**完全不會生效**（而失敗是靜默的）；`@PreDestroy` 改成 `ContextClosedEvent` 讓部署從 45 秒降到 1 秒；串流匯出的 sentinel；`preStop` sleep；三個逾時數字的不等式 |
>
> **第二輪複查（方法層級）**：第一輪只查了「型別存不存在」，沒查「方法存不存在」。
> 補做之後抓到 8 處 —— **其中 6 處是第一輪補充時我自己寫錯的**：
>
> | 錯誤 | 修正 |
> |---|---|
> | 5.11.10 重複實作了 5.11.6 已有的 `SseEmitterRegistry.shutdown()`，還呼叫了不存在的 `activeCount()` / `forEach()` / `clear()` | 整節重寫成「**建立在既有的 `shutdown()` 之上**」，只改它的觸發點 |
> | `new CsvWriter(...)` / `writer.writeRow(...)` | `CsvWriter` 是**靜態工具**（`header()` / `row()` 回傳字串），改用 `BufferedWriter` 自己管 |
> | `ContentDispositions.attachment(...)` | 實際 API 是 `build(inline, filename)` |
> | `StreamingRequests.isClientAbort(...)` | 那是 5.9.4 定義在 controller 裡的 helper，不在 `StreamingRequests` 上 |
> | `DidYouMean.sanitize/suggest(...)` | 實際 API 是 `closest(input, List)`；遮蔽要用 `ValueMasker.mask` |
> | 三個新例外用 `@Override extensions()` | 改成建構子 + 父類別的 `ext(...)`，與既有 20 幾個子類別一致 |
>
> **另外抓到 3 處與我無關的既有問題**：
>
> | 問題 | 位置 |
> |---|---|
> | **07 章用 `@CurrentUser` 當參數註解，正確的是 `@CurrentActor`**（`CurrentUser` 是 principal 的型別） | 07 章 4 處 |
> | **7.4.3「事實四」的機制講錯了** —— `CurrentActorHolder` 沒有 setter，它直接讀 `SecurityContextHolder`。真正的症狀是 `@WithMockUser` 的 principal 是 `String` → resolver 拋 `IllegalStateException` → **500 而不是 null** | 07 章 7.4.3、7.9.3 整段重寫，改用 `@WithSecurityContext` |
> | `MoneyFormat.fractionDigits(...)` 被練習 4 呼叫但沒有公開 | 06 章 6.5.7 補上 |
>
> **00～07 章已做過跨章符號檢查**：確認每個 `throw new XxxException` 都有對應的類別定義、
> 每個被呼叫的方法都存在、章節之間沒有型別衝突。
> 修正紀錄見 03 章 3.13.3、04 章 4.13.6、05 章 5.12.4、06 章 6.9.3、07 章 7.14.3
> （五節「支援型別」就是這幾次檢查的產出）。
>

---

> **第三輪複查（全書 58,000 行逐節重讀）**：前兩輪查的是「型別存不存在」與
> 「方法存不存在」。這一輪查的是**「框架的行為真的是這樣嗎」**與
> **「章與章之間的接縫對得上嗎」**。
>
> 這一輪的結論是：**錯誤集中在「我自己補寫的部分」與「章與章的接縫」**，
> 而其中 06↔07 的接縫最嚴重 —— 07 章大量引用 06/05 章的 API，
> 但引用的是**記憶中的版本**而不是那兩章實際寫下的版本。
>
> **① 框架事實錯誤（會讓程式碼行為與課程描述不符）**
>
> | 錯誤 | 位置 | 實際行為 |
> |---|---|---|
> | `params` 條件不符回 **404** | 01 章 1.3.2、1.7.4、1.15 | **400** `UnsatisfiedServletRequestParameterException`（`handleNoMatch` 有專屬分支）。只有 `headers` 才落到 404。**這個例外全書從未出現** → 03 章 3.7.3 補上它的 handler、`safeDetail` 與 `acceptedParameterSets` 擴充欄位 |
> | `?size=` 空字串時 `defaultValue` **不**生效 | 01 章練習 1 第 6 題 | **生效**。`AbstractNamedValueMethodArgumentResolver` 有 `else if ("".equals(arg) && defaultValue != null)` 分支，而它在**轉型之前**。1.5.1 的表格原本是對的，練習答案與它自相矛盾 → 整節重寫成「空字串的三種結果」 |
> | `required=false` + **`boolean`** = 500 | 01 章 1.5.1 坑 ② | `handleNullValue` 對 `Boolean.TYPE` **回傳 `Boolean.FALSE`**。而「安靜地變成 false」比 500 危險（4.2.3 的靜默篩選）→ 補上「沒送是 false、送空的才 500」的區分 |
> | `@DateTimeFormat` 可用在 `Instant` | 01 章 1.7.2、1.9.3 | **完全無效**。`Jsr310DateTimeFormatAnnotationFormatterFactory.FIELD_TYPES` 不含 `Instant`，實際走 `InstantFormatter`（格式不可調）→ 移除那兩處註解並說明 |
> | 自訂約束漏 `RECORD_COMPONENT` 會**編譯錯誤** | 02 章 2.4.4、2.7.1、03 章 3.6.2 | 不會（JLS 8.10.1 的註解傳播；Jakarta 自己的 `@Size` 就沒有它）。真正的理由是**反射掃描讀得到** → 2.7.1 整段重寫 |
> | `@Component` + `FilterRegistrationBean` 會**註冊兩次** | 04 章 4.4.2 | 不會（`ServletContextInitializerBeans` 的 `seen` 會排除）。**真正**會註冊兩次的是「`FilterRegistrationBean` 包了一個 `new` 出來的新實例」→ 補上完整機制與三條規則 |
> | 「已執行過」attribute 在 ASYNC dispatch **還在** | 04 章 4.4.6、4.12.2、4.13（3 處） | **不在** —— 04 章自己貼的原始碼就在 `finally` 裡 `removeAttribute`。所以 `TraceIdFilter`（覆寫成 `false`）**真的會重跑** → 補上 `resolveOnce()`（否則非同步端點會產生第二個 traceId） |
> | Boot 的 filter 預設涵蓋 forward/include | 04 章 4.4.1 | 預設是 `REQUEST + ASYNC + ERROR`（**沒有** FORWARD/INCLUDE）→ 補上兩條註冊路徑的預設值差異 |
> | Lua 裡不能用 `redis.call('TIME')` | 04 章練習 3 | **Redis 5+ 可以**（effects replication）。仍然從應用端傳時間，但理由改成「測試可控 / 與 `Retry-After` 同源 / 單一時間源」 |
> | `CorsFilter` 設 `DispatcherType.ERROR` 就涵蓋 `/error` | 06 章 6.3.5 | **無效** —— `shouldNotFilterErrorDispatch()` 預設 `true`。真正有效的是 `ProblemWriter` 保存/復原 CORS 標頭 |
> | `MapperFeature.USE_STD_BEAN_NAMING` 與 enum `toString()` 有關 | 06 章 6.5.3 | 完全無關（它管 getter 名稱推導）。enum 的是 `write-enums-using-to-string` |
> | `FAIL_ON_SELF_REFERENCES: true` 的註解描述反了 | 06 章 6.5.3 | `true` = 拋例外；而且它只攔**直接**自我參照 |
> | `defaultImpl = NoClass.class` | 06 章 6.7.1 | 已廢棄的內部標記；正確的是 `JsonTypeInfo.None.class` |
> | `shouldNotFilterAsyncDispatch()` 預設 **`false`** | 07 章 7.5.6（2 處）+ 驗收清單 | 預設 **`true`**。**而 04 章寫對了** → 07 章改正並補上「哪些 filter 真的會重跑」的表 |
> | `@Transactional` 在 `@WebMvcTest` 上「什麼都不做」 | 07 章練習 1 答案② | **會讓整個類別紅燈**（`TransactionalTestExecutionListener` 找不到 `PlatformTransactionManager` 會拋 `IllegalStateException`） |
>
> **② 跨章接縫（同一個東西在兩章不一樣）**
>
> | 衝突 | 修法 |
> |---|---|
> | **`CreateOrderRequest` 有三種形狀** —— 02 章的正式版是 `items{productId,quantity}` + `shippingAddressId`，而 07 章用 `items{…,unitPrice}` + 巢狀 `shippingAddress`。**而 07 章 7.6.5 的旗艦測試斷言 `command.items().get(0).unitPrice()` 等於客戶端送的值 —— 那正是 00 章 0.6.2 明令禁止的價格篡改** | 全書統一成 02 章 2.12.1 的正式版；01 章 1.12.5 的 `CreateOrderCommand` 改成 `(actor, idempotencyKey, lines, shippingAddressId, couponCode, customerNote, invoice)`（與 00 章 0.10.3 的 mapper 一致）；7.6.5 的測試改成**用 `getRecordComponents()` 斷言「Line 上沒有價格欄位」** |
> | **`TWD` 的小數位數** —— 06 章是 **2**、`format()` 用 `HALF_UP`；07 章說「TWD → 0、`UNNECESSARY`」，於是 `"1281"` 這個期望值在 07 章出現 **8 次**，7.12.2 的 `@CsvSource` 8 列有 5 列錯 | 07 章全部改成 `"1280.50"`；7.12.2 的表改成「期望值來自 `FRACTION_DIGITS`」並加上一列 `1280.005 → 1280.01`（唯一能區分 `HALF_UP` 與 `HALF_EVEN` 的案例） |
> | **`ROLE_` 前綴加了兩次** —— 07 章 7.4.3 的 `WithActor` 與 7.9.3 的 `Auth.as()` 都傳 `Set.of("ROLE_" + type)`，而 `CurrentUser.getAuthorities()` 自己會加 → `ROLE_ROLE_CUSTOMER` → **授權矩陣的 350 個斷言每一格都是 403** | 兩處改成裸名；04 章 4.13.6 的 `roles` 欄位加上這個慣例的說明 |
> | **`ValueMasker` 同 FQN 兩種簽名** —— 03 章是 `mask(String, Object)`，06 章 6.9.3 重新定義成 `mask(Object)`；9 個呼叫點 6 個用一參數 | 06 章不再定義它；**03 章加一個 `mask(Object)` 多載**（給 Converter 與 type-id handler），並補上控制字元移除與值樣式偵測 |
> | **兩份 Levenshtein** —— 03 章 `DidYouMean`（固定距離 3）vs 06 章 `Suggestions`（比例門檻） | 統一用 `DidYouMean`，並把 06 章**較好的比例門檻搬進去**（固定距離 3 會把 `XYZ` 建議成 `PAID`） |
> | **`ErrorCode` 實際是 83 個** —— 05 章 5.12.4 加了 4 個，但 README / 06 / 07 章共 14 處仍寫 79 | 全部改成 83；並補上**缺的 32 條 i18n 訊息**（原本 51 / 83，3.4.5 的 `訊息完整()` 測試根本過不了） |
> | **`PLANNED_FOR_LATER` 兩份清單** —— 03 章 15 個、07 章 3 個，而且 07 章把 06 章正在用的 `FORBIDDEN_PARAMETER` 列為「未實作」 | 03 章 3.14.5 重寫成 `ErrorCodeUsageTest` 並把清單提升成 `public static final`；07 章 7.8.2 直接引用它。**另加一個反向守門**「已實作就要從清單移除」 |
> | **`SseEmitterRegistry.register()` 的簽名** —— 07 章 7.5.8 寫 `when(registry.register(a,b,c)).thenReturn(emitter)`，實際是 `void register(String,String,String,SseEmitter)` | 改用 `ArgumentCaptor<SseEmitter>` |
> | **SSE 連線上限回 429 還是 503** —— 07 章 7.11.4 期望 429，05 章明確用 `SERVICE_UNAVAILABLE`（503）並寫了理由 | 07 章改成 503；並把 `MAX_TOTAL`/`MAX_PER_ACTOR` 從**寫死的常數**改成 `SseProperties`（否則 `api.sse.*` 那兩行設定是死的，測試也無法把上限調低） |
> | **`StatusLabelResolver` 的 API** —— 07 章 7.8.3 呼叫 `resolve(Enum<?>, Locale)` 與 `keyFor(...)`，06 章只有 `label(OrderStatus)` | 06 章 6.5.8 補上 **`LabeledEnum` 介面 + 泛型的 `label(Enum<?>)`** —— 因為「每一個對外的 enum 都要有 label」這個結論，本來就需要一個泛型入口 |
> | **`springdoc.api-docs.enabled=false`（07 章 7.10.4）vs 06 章 6.10.3 打 `/v3/api-docs`** | 6.10.3 改成直接讀手寫的 `orders-api.yaml`（contract-first 的唯一真相來源） |
> | **06 章 6.9.4 的 filter order vs 07 章 7.11.2 的 `EXPECTED_ORDER`** —— 後者用的是**修正前**的值 | 統一成 `-118/-117/-116/-115/-114`；並把 `CorsFilter一定是第一個()` 改成「早於所有**自訂** filter」（`-200` 比 Boot 的 `MIN_VALUE` / `-9900` 大，原本的 `.first()` 永遠紅燈） |
> | **`Actor` 的套件** —— 定義在 `order.domain`，卻有 9 處 import 寫 `common.web.Actor` | 全部改正；並在 04 章 4.13.6 寫下「這是一個誠實的妥協」與拆 module 時的搬遷計畫 |
> | **`ActorType` 有 6 個常數，授權矩陣只有 5 欄** | 加 `EXCLUDED_ACTOR_TYPES`（`SYSTEM` 走簽章驗證）+ 一個「每個 ActorType 都被涵蓋或明確排除」的守門測試 |
>
> **③ 程式碼裡的實質 bug（不是筆誤）**
>
> | bug | 後果 |
> |---|---|
> | `BodyMasker` 的模糊比對清單含 `"pin"`，而 fallback 用 `contains` | 🔴 **`shippingAddressId` / `shippingFee` / `shippingAddress` / `shippingMethod` 在每一筆請求日誌與稽核紀錄裡都是 `***`** —— 而稽核的目的正是「事後查得到當時送了什麼」。→ 拆成 `FULLY_MASKED`（精確）/ `FUZZY_HINTS`（長度 ≥ 6）/ `NEVER_MASKED`（白名單），並加一組**「不可以被誤遮」**的測試 |
> | `ActorMdcInterceptor.afterCompletion` 清 MDC | 🔴 interceptor 的 `afterCompletion` 比外層 filter 的 `finally` **早**執行 → 4.6.5 的結構化日誌與練習 2 的 `AuditEvent` 的 `actorId` **永遠是 null** → 改成「MDC 由最外層的 `TraceIdFilter` 統一清」 |
> | `MessageNotReadableAnalyzer` 從 `@ExceptionHandler` 裡 `throw` | 🔴 3.3.6 自己解釋過這會讓 resolver 回 null → `/error` → **HTML**。→ 改成用回傳值把例外交給 advice |
> | catch-all `handleUnexpected(..., HandlerMethod)` | 🔴 `HandlerMethod` 在 `MultipartException` / `NoHandlerFound` 時是 null → 參數解析失敗 → resolver 回 null → **一個為了「保證回應是 JSON」而存在的方法，在最需要它的時候失效**。→ 改成從 request attribute 取 |
> | `"scope".equals(scope)` | 恆為 false（值是 `"server"`/`"actor"`）→ per-actor 的提示永遠不出現。使用者被叫去等，而正確動作是「關掉其他分頁」 |
> | `spring.lifecycle.timeout-per-shutdown-phase` 被放在 `server:` 底下 | 🔴 Boot **靜默忽略**（relaxed binding 找不到就不綁）→ 實際用 30 秒預設 → 5.11.10 整套「三個數字的不等式」失效 |
> | `UrlBasedCorsConfigurationSource` 先註冊 `/**` | 🔴 **第一個匹配就贏** → `publicConfiguration()` / `sseConfiguration()` 是死碼。6.3.5 的「惡意 Origin」測試因此**通過**、6.10.4 的「公開端點是 `*`」因此**失敗** —— 兩個測試互相矛盾就是這個 bug 的指紋 |
> | 5.11.10 的 CSV 迴圈在 `CsvWriter.row()` 之後又 `write('\n')` | `row()` 已含 CRLF → **每一列後面一個空行**（Excel 顯示成空白資料列）；同時把字面 BOM 字元改成 `CsvWriter.UTF8_BOM` |
> | `SafeFilename.sanitize(raw, ext)` 的第二個參數是 **fallback** 而不是「強制」 | 5.13.1 的測試期望 `application.png`，實際會得到 `application.yml`。→ 補一個 `sanitizeForcing(...)`，並讓 `UploadValidator` 用它（內容被二次編碼過，客戶端的副檔名已經不成立） |
> | `SensitiveFieldScanTest` 的禁用清單含 `"taxid"` | 發票的 `invoice.taxId` 是**正當而且必要**的回應欄位 → 掃描測試必然紅燈，而「修法」很容易變成「把 invoice 從回應移除」。→ 移除該關鍵字並加一個 `ALLOWED_PATHS` 白名單機制 |
> | 07 章 7.14.3 缺 **10 個**用到但沒定義的支援型別 | `Methods`、`AllServicesStubbedToSucceed`、`DtoScanner`、`OpenApiErrorCodes`、`StatusLabels`、`TestTokens`、`OrderEventPublisher`、`PageFixtures`、`Items`、`Addresses`（另加練習 3 的兩個例外與兩個 `ErrorCode`）→ 全部補齊 |
>
> **④ 版本與相容性**
>
> | 項目 | 修法 |
> |---|---|
> | `StreamReadConstraints.maxNameLength` / `maxDocumentLength` / `StreamWriteConstraints` 是 **Jackson 2.16+**，而 Boot 3.2.5 管理的是 **2.15.4** | 06 章 6.5.1 補上完整的版本表、`jackson-bom.version` 覆寫、一個「版本足夠」的測試，以及「不想偏離 BOM 就拿掉那三行」的補償方案 |
> | `@MockitoBean` 需要 Spring Framework **6.2（Boot 3.4）** | ⚠️ **上一輪的紀錄寫成「已改成 `@MockBean`」，那是不準確的** —— 實際做的是在 03/04/00 章加上版本註記，而課程仍統一寫 `@MockitoBean`（07 章 7.6.1 有明確的政策說明與 `mvn` profile）。這一輪把紀錄改成事實 |
> | `mode.classes.default = concurrent`（07 章 7.13.2）與「所有切片共用一個 context」（7.4.5）**互相衝突** | 共用 context ⇒ 共用同一批 `@MockitoBean` ⇒ 類別平行會讓 stub 互相覆蓋、reset 互相干擾。→ 切片測試標 `@Execution(SAME_THREAD)`，平行度改由 Surefire 的 `forkCount=1C`（多 JVM ⇒ 多 context ⇒ 天然隔離）提供 |
>
> **⑤ 這一輪也順手補了幾個「測試逼出來的」正式碼缺口**
>
> | 補上什麼 | 為什麼 |
> |---|---|
> | `SseEmitterRegistry.countFor(actorId)` | 07 章練習 4 的 flaky 除錯需要它；而 05 章 5.11.6 的 `max-connections-per-actor` 檢查本來就需要它（藏在私有 `Map` 裡） |
> | `SseProperties`（`@ConfigurationProperties`） | 「可設定」是「可測試」的前提 |
> | `LabeledEnum` + 泛型的 `label(Enum<?>)` | 「每一個對外的 enum 都要有 label」這個結論需要一個泛型入口才表達得出來 |
> | `CsvWriter.UTF8_BOM` 提升為 `public` | 看不見的字元只能有一份定義 |
> | `ValueMasker.mask(Object)` 多載 | Converter 與 type-id handler 拿不到欄位名 |
>
> ⚠️ **這一輪沒有做的事**：課程中的程式碼、YAML 與設定仍**未在本機編譯執行驗證**
> （這台機器上沒有 JDK 與 Maven）。上面所有「框架行為」的判斷都是對照
> Spring / Jackson / Servlet 的原始碼語意做的，而**那不等於實測**。
> 👉 **請以你的環境實測為準**，而且如果你發現任何一處不符，那是課程的問題不是你的。
>
> 另外 06 章 6.5.7 刻意「先寫錯再修正」了一段全域 `BigDecimal` serializer ——
> 那是一個很自然的第一直覺，而看到它為什麼錯比直接給答案更有價值。
>
> ⚠️ 課程中的程式碼、YAML 與設定均經逐行檢閱，但**尚未在本機編譯執行驗證**
> （這台機器上沒有安裝 JDK 與 Maven）。基準版本是 **Java 21 / Spring Boot 3.2.5 /
> Spring Framework 6.1 / Hibernate Validator 8.0 / **Jackson 2.17**
> （⚠️ Boot 3.2.5 管理的是 2.15.4，我們刻意用 `jackson-bom.version` 拉高 ——
> 理由與代價見 06 章 6.5.1）**。
> 若你的版本不同（尤其是 Boot 3.0/3.1），課程會標註差異，但仍請以你的環境實測為準。

---
