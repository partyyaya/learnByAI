# 04 — Controller（Web 層）

> Controller 只該做三件事：**把請求翻譯成參數、驗證輸入、把結果翻譯成回應**。
> 它不該有商業邏輯，也不該直接碰資料庫。這一站的重點與其說是語法，不如說是**職責邊界**。

---

## 學完你可以

- 講清楚哪些程式碼屬於 Controller、哪些該往下推到 Service。
- 熟練參數綁定：路徑變數、查詢參數、請求主體、標頭、檔案。
- 用 Bean Validation 做輸入驗證，並把錯誤轉成一致的回應格式。
- 用 `@RestControllerAdvice` 統一處理例外，讓 Controller 裡不再有 try-catch。
- 說明一個請求從 Filter → DispatcherServlet → Interceptor → Controller 的完整路徑。
- 安全地處理檔案：判斷檔名與內容都不可信，並在「大到放不進記憶體」時改用串流或預簽名 URL。
- 用 SSE 做即時推播，並知道它在 Nginx / 多實例部署下的必要設定。
- 正確設定 CORS，包含**最容易漏的「錯誤回應也要有 CORS 標頭」**。
- 掌握 Jackson 的全域設定，並說出每一項的理由與「改了會壞掉什麼」。
- 用 MockMvc 寫出不啟動整個應用程式的 Web 層測試。

## 前置知識

[02-spring-boot/](../02-spring-boot/) 01～03 章、[03-rest-api/](../03-rest-api/) 全部。

---

## 章節目錄

| 章節 | 檔案 | 主題 | 重點 |
|------|------|------|------|
| 00 | [00-course-map-web-layer-role.md](./00-course-map-web-layer-role.md) ✅ | 課程地圖與 Web 層職責 | 分層架構總覽、**Controller 不該做的十件事**、判斷邊界的五個問題、請求完整旅程、800→40 行重構、專案骨架 |
| 01 | [01-request-mapping-and-binding.md](./01-request-mapping-and-binding.md) ✅ | 路由與參數綁定 | 路由衝突優先順序、**Boot 3 尾斜線 breaking change**、`required`/`defaultValue`/`Optional` 三角關係、14 個查詢參數綁成一個 record、`JsonNullable` 三態、自訂 `Converter`、`ResponseEntity` 決策表 |
| 02 | [02-validation-and-binding-errors.md](./02-validation-and-binding-errors.md) ✅ | 輸入驗證 | **每個註解對 `null` 的行為**、Spring 6.1 內建方法驗證、ReDoS 防護、`addPropertyNode()`、為什麼不在驗證器裡查 DB、EL 注入、`BindingResult`→`errors[]`、四層 DoS 防護、驗證覆蓋率測試 |
| 03 | [03-global-exception-handling.md](./03-global-exception-handling.md) ✅ | 全域例外處理 | `HandlerExceptionResolver` 鏈、**advice 順序贏過精確度**、83 個 code 的錯誤碼註冊表、**六種進不了 advice 的例外**、Jackson 例外→精確 field、Filter/Security/Nginx 四層格式統一、5xx 資訊洩漏防護、日誌分級與業務告警 |
| 04 | [04-filter-interceptor-and-lifecycle.md](./04-filter-interceptor-and-lifecycle.md) ✅ | 請求生命週期 | 五種機制的能力對照與決策流程、`OncePerRequestFilter`、**可重複讀的 body**、`TraceIdFilter` 與 log injection、三層請求日誌與 JSON 遮蔽、**分頁硬上限**、**冪等鍵（Filter+Interceptor 混合）**、`ArgumentResolver`、非同步生命週期 |
| 05 | [05-file-upload-download-and-sse.md](./05-file-upload-download-and-sse.md) ✅ | 檔案與串流 | multipart 四個設定值與暫存檔生命週期、**`getOriginalFilename()` 的四種攻擊**、magic number 與**圖片二次編碼**、ZIP bomb 四道防線、中文檔名的 `Content-Disposition`、`Range` 的三個前提、**`StreamingResponseBody` 的執行緒與交易**、串流中途失敗的三層應對、`202`+輪詢+一次性 token、**SSE 完整生命週期與 Nginx 三個坑** |
| 06 | [06-cors-content-negotiation-and-json.md](./06-cors-content-negotiation-and-json.md) ✅ | 跨來源與序列化 | **同源政策擋的是「讀回應」**、preflight 三個判準、`Allow-Headers: *` 不涵蓋 `Authorization`、**`response.reset()` 清掉 CORS 標頭**、`CorsFilter` 為何要 order -200、`configureMessageConverters` 弄掉 Range 支援、**永不 `new ObjectMapper()`**、`BigDecimal` 三個坑、**新增 enum 值不再是破壞性變更**、多型反序列化的 RCE、JSON 炸彈、`ETag` 快速 304 與 `If-Match` |
| 07 | [07-controller-testing-mockmvc.md](./07-controller-testing-mockmvc.md) ✅ | Web 層測試 | 測試金字塔在 Web 層是**梯形**、`@WebMvcTest` 的切片邊界、**`addFilters = false` 造成的資料洩漏**、context 快取鍵與「47 分鐘→4 分鐘」、MockMvc 與真實容器的 **12 個行為差異**、`jsonPath` 六陷阱、**mock 沒 stub 就回 `null`**、`ArgumentCaptor` 是 Controller 測試的核心、83 個 `ErrorCode` 一個測試、**授權矩陣 70×5 與 IDOR**、OpenAPI 契約與 REST Docs、12 個反模式、CI 分層與突變測試 |

---

## 目前進度

| 章節 | 狀態 | 篇幅 |
|------|------|------|
| 00 課程地圖與 Web 層職責 | ✅ 完成 | 約 2,610 行 |
| 01 路由與參數綁定 | ✅ 完成 | 約 3,660 行 |
| 02 輸入驗證與綁定錯誤 | ✅ 完成 | 約 4,810 行 |
| 03 全域例外處理 | ✅ 完成 | 約 6,650 行 |
| 04 請求生命週期 | ✅ 完成 | 約 6,840 行 |
| 05 檔案與串流 | ✅ 完成 | 約 12,020 行 |
| 06 跨來源與序列化 | ✅ 完成 | 約 11,630 行 |
| 07 Web 層測試 | ✅ 完成 | 約 10,090 行 |

目前合計約 **58,300 行**（不含 README）。

**04-controller 全部七章完成。**

### 程式碼演進表：後面的章節修正了前面的四處

**這四處是「上游的決定被下游的現實推翻」** —— 課程刻意**不**回頭改寫前面的章節，
只在原處標註理由，因為「先看見痛，再給解法」需要痛留在原處。

| 改了什麼 | 原本在哪 | 為什麼 |
|---|---|---|
| `CachedBodyFilter` 要跳過 multipart | 04 章 4.4.6 | 否則 `MultipartFile` 綁到 `null`（05 章 5.6.4） |
| 冪等指紋對 multipart 不含 body | 04 章 4.9.4 | boundary 每次隨機 → 同樣的請求算出不同指紋（05 章 5.6.4） |
| `ProblemWriter` 的 `reset()` 要保留 CORS 標頭 | 03 章 3.10.1 | 否則所有 401/403 前端都讀不到內容（06 章 6.3.5） |
| **`@MockitoBean` 的版本註記** | 03 章 3.13、3.14.4 | `@MockitoBean` 是 **Spring Framework 6.2（Boot 3.4）** 才有的，在 3.2.5 基準上不會編譯 |

⚠️ **最後一列是你最可能立刻撞到的一個**：

> 課程全書統一寫 `@MockitoBean`（07 章 7.6.1 有政策說明與 `mvn` profile），
> 但如果你用 **Boot 3.2 / 3.3**，每一處都要改成 `@MockBean`。
> 課程在每個出現的地方都加了註記。

> 📌 **下一站（[05-service/](../05-service/)）有一張同樣的表，而它有 22 列。**
> 那不是因為 04-controller 寫得比較好，而是因為
> **「Service 是 stub」這個前提一旦拿掉，Web 層的許多決定就要重做** ——
> 例如 `allowedActions()` 為什麼不可能沒有參數。

## 常見誤區（課程會逐一破解）

- Controller 裡直接注入 Repository，順手寫了 200 行商業邏輯。
- 每個方法都自己包 try-catch 回錯誤訊息，格式各寫各的。
- 只驗證 happy path，惡意輸入（超長字串、負數金額、缺欄位）直接進資料庫。
- 用 `@CrossOrigin("*")` 全開解決跨域，上線後才發現安全問題（06 章 6.2.2）。
- 檔案上傳沒限制大小與型別，被塞爆磁碟（05 章 5.2.1）。
- 以為「回應是對的」就等於「前端拿得到」—— 錯誤回應少了 CORS 標頭（06 章 6.2.1）。
- 用 `List<T>` 匯出 41 萬筆訂單，一個報表功能讓下單服務中斷（05 章 5.2.3）。
- SSE 在本機完美、在 Nginx 後面完全不動（05 章 5.2.4）。
- 為了修掉測試的 401 而加 `@AutoConfigureMockMvc(addFilters = false)`，
  於是 350 個測試全部跑在「沒有認證與授權」的環境裡（07 章 7.2.1）。
- 測試只斷言 `status().isOk()`，而 mock 沒 stub 回傳 `null` → 200 + 空 body（07 章 7.2.3）。
- 用被測的 `MoneyFormat` 算期望值，於是測試斷言「它等於它自己」（07 章 7.2.5）。

## 產出

依照 03-rest-api 的 `orders-api.yaml` 契約，實作出一組**完整的訂單 Controller**：
含驗證、統一錯誤格式、請求追蹤 ID、檔案上傳下載、非同步匯出、SSE 推播、CORS 與序列化設定，
以及整套 MockMvc 測試 — 但商業邏輯全部以介面呼叫下一層（由 05-service 補上）。

**跨章節的「機制決策表」**（讀完 04～06 章之後，這三張表是最常回頭查的）：

| 想做什麼 | 去哪裡查 |
|---|---|
| 一個橫切需求該用 Filter / Interceptor / ArgumentResolver / AOP？ | 04 章 4.13.5 |
| 一個「大東西」該用 multipart / 預簽名 / 串流 / 非同步工作？ | 05 章 5.12.3 |
| filter 的 order 該給多少？ | 06 章 6.9.4（04→06 章的總表） |
| 這個東西該用哪一種測試（純單元 / 切片 / 整合 / 真 HTTP）？ | **07 章 7.3.3、7.3.4** |
| `@WebMvcTest` 測不到什麼、要改用哪一種？ | **07 章 7.11.1**（配合 7.5.9 的 12 個差異） |
| 一個新端點要寫哪些測試？ | **07 章 7.16 練習 3**（含「哪些是免費的」） |
