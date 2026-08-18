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
- 用 MockMvc 寫出不啟動整個應用程式的 Web 層測試。

## 前置知識

[02-spring-boot/](../02-spring-boot/) 01～03 章、[03-rest-api/](../03-rest-api/) 全部。

---

## 章節目錄

| 章節 | 檔案 | 主題 | 重點 |
|------|------|------|------|
| 00 | `00-course-map-web-layer-role.md` | 課程地圖與 Web 層職責 | 分層架構總覽、Controller 該做 / 不該做什麼、瘦 Controller 原則 |
| 01 | `01-request-mapping-and-binding.md` | 路由與參數綁定 | `@RestController`、`@GetMapping` 家族、`@PathVariable` / `@RequestParam` / `@RequestBody` / `@RequestHeader`、`ResponseEntity` |
| 02 | `02-validation-and-binding-errors.md` | 輸入驗證 | Bean Validation 註解、巢狀與集合驗證、驗證群組、自訂驗證器、`BindingResult` |
| 03 | `03-global-exception-handling.md` | 全域例外處理 | `@RestControllerAdvice`、`@ExceptionHandler`、業務例外對應狀態碼、統一錯誤格式落地 |
| 04 | `04-filter-interceptor-and-lifecycle.md` | 請求生命週期 | Filter vs Interceptor vs AOP 的選擇、`HandlerMethodArgumentResolver`、追蹤 ID、請求日誌 |
| 05 | `05-file-upload-download-and-sse.md` | 檔案與串流 | multipart 上傳、大小限制與安全檢查、檔案下載、`StreamingResponseBody`、SSE 推播 |
| 06 | `06-cors-content-negotiation-and-json.md` | 跨來源與序列化 | CORS 設定（與 Security 的關係）、內容協商、Jackson 全域設定、自訂序列化器 |
| 07 | `07-controller-testing-mockmvc.md` | Web 層測試 | `@WebMvcTest` 切片、MockMvc 語法、驗證測試、錯誤路徑測試、文件產生 |

---

## 常見誤區（課程會逐一破解）

- Controller 裡直接注入 Repository，順手寫了 200 行商業邏輯。
- 每個方法都自己包 try-catch 回錯誤訊息，格式各寫各的。
- 只驗證 happy path，惡意輸入（超長字串、負數金額、缺欄位）直接進資料庫。
- 用 `@CrossOrigin("*")` 全開解決跨域，上線後才發現安全問題。
- 檔案上傳沒限制大小與型別，被塞爆磁碟。

## 產出

依照 03-rest-api 的 `orders-api.yaml` 契約，實作出一組**完整的訂單 Controller**：
含驗證、統一錯誤格式、請求追蹤 ID 與整套 MockMvc 測試 — 但商業邏輯全部以介面呼叫下一層（由 05-service 補上）。
