# 04 — Controller（Web 層）

> 上一站（03-rest-api）你把**契約**設計完了：83 條 URL、22 個 DTO、一份 `orders-api.yaml`。
> **這一站要把那份契約變成會動的 Java。**
>
> 而 Controller 只該做三件事：**把請求翻譯成參數、驗證輸入、把結果翻譯成回應**。
> 它不該有商業邏輯，也不該直接碰資料庫 ——
> 所以這一站的難點不是語法，是**職責邊界**，以及邊界上那些「在本機完全正常、上線才炸」的細節。

---

## 學完你可以

- 講清楚哪些程式碼屬於 Controller、哪些該往下推到 Service，並用**五個問題**當場判斷。
- 把 83 條 URL 對映成方法簽章，並說出路由衝突時 Spring 用什麼規則選。
- 熟練參數綁定：路徑變數、查詢參數、請求主體、標頭、檔案，
  以及 `required` / `defaultValue` / `Optional` 之間**哪三種組合是 bug**。
- 用 Bean Validation 驗證輸入，說出**每個註解對 `null` 的行為**，並把錯誤轉成一致的回應格式。
- 用 `@RestControllerAdvice` 把 83 個錯誤碼統一成一種格式，讓 Controller 裡不再有 try-catch ——
  並知道**哪六種例外根本進不了 advice**。
- 說明一個請求從 Filter → DispatcherServlet → Interceptor → Controller 的完整路徑，
  並在 Filter / Interceptor / ArgumentResolver / AOP 之間做出有理由的選擇。
- 安全地處理檔案：**檔名與內容都不可信**；在「大到放不進記憶體」時改用串流或預簽名 URL。
- 用 SSE 做即時推播，並知道它在 Nginx / 多實例部署下的必要設定。
- 正確設定 CORS，包含最容易漏的那一個：**錯誤回應也要有 CORS 標頭**。
- 掌握 Jackson 的全域設定，並說出每一項「改了會壞掉什麼」。
- 用 MockMvc 寫出不啟動整個應用程式的 Web 層測試，
  並知道 MockMvc **測不到**的 12 件事各自該用哪一種測試補。

## 前置知識

[02-spring-boot/](../02-spring-boot/) 01～03 章、[03-rest-api/](../03-rest-api/) 全部。

---

## 章節目錄

| 章節 | 主題 | 核心問題 |
|------|------|---------|
| **00** | [課程地圖與 Web 層職責](./00-course-map-web-layer-role.md) | 這段程式碼該放哪一層？800 行的 Controller 是怎麼長出來的 |
| **01** | [路由與參數綁定](./01-request-mapping-and-binding.md) | HTTP 的字串怎麼變成 Java 物件，以及沿路會掉什麼 |
| **02** | [輸入驗證與綁定錯誤](./02-validation-and-binding-errors.md) | 壞資料怎麼在進入 Service 之前被擋下來 |
| **03** ★ | [全域例外處理](./03-global-exception-handling.md) | 一個 advice、83 條端點、零個 try-catch 怎麼做到 |
| **04** | [請求生命週期](./04-filter-interceptor-and-lifecycle.md) | 橫切的需求（追蹤、日誌、限流、冪等）該掛在哪一層 |
| **05** | [檔案上傳下載與 SSE](./05-file-upload-download-and-sse.md) | 「不是 JSON 的東西」與「大到放不進記憶體的東西」 |
| **06** | [跨來源與序列化](./06-cors-content-negotiation-and-json.md) | 為什麼前端只看得到 `Network Error`；錢與時間怎麼變成 JSON |
| **07** ★ | [Web 層測試](./07-controller-testing-mockmvc.md) | 你怎麼知道前面六章都是對的 |

### 怎麼讀

```
00（分層、邊界、請求旅程、專案骨架）
 └─→ 01（路由與綁定：所有後續章節的前提）
      └─→ 02（驗證）
           └─→ 03 ★ 全域例外處理（錯誤格式從這裡開始固定下來）
                ├─→ 04（生命週期：traceId、日誌、冪等、限流）
                │    ├─→ 05（檔案、串流、SSE）
                │    └─→ 06（CORS、內容協商、Jackson）
                └─→ 07 ★ 測試（讀完 03 與 06 再讀，效果最好）
```

⚠️ **如果時間有限**：
**03 是最關鍵的一章** —— 錯誤格式一旦定下來，後面每一章都在往它上面掛東西。
**06 是「上線後才會發現」密度最高的一章**（CORS、金額、時區、enum 演進）。
**05 是唯一會讓服務整個掛掉的一章**（一個匯出報表就能 OOM）。

---

## 這一站會打破的幾個假設

每一章都在處理同一種東西：
**在本機、單一前端網域、小檔案、happy path 之下【完全正確】，而在正式環境是錯的程式碼。**

| 你以為 | 實際上 | 在哪一章 |
|---|---|---|
| 「`/orders/` 跟 `/orders` 一樣」 | Boot 3 起尾斜線**不再**自動比對 → 404 | 01 章 1.3 |
| 「`@RequestParam(required=false) int page` 沒送就是 0」 | 500，而且只在「客戶端不送」時發生 | 01 章 1.5 |
| 「`?status=paid` 會被接受」 | 400，連 `field` 都沒有（實測） | 01 章 1.9.2 |
| 「加了 `@Valid` 就有驗證」 | 沒加 `spring-boot-starter-validation` 時**完全不生效，也不報錯** | 00 章 0.11.3 |
| 「例外拋出去就會變成我的錯誤格式」 | **六種例外根本進不了 advice**（Filter、Security、404…） | 03 章 3.5.4 |
| 「advice 越精確的越先被選到」 | **順序贏過精確度** —— 註冊順序決定誰接到 | 03 章 3.3 |
| 「`getOriginalFilename()` 是檔名」 | 它是**攻擊者送的字串**，四種攻擊都從這裡進來 | 05 章 5.4 |
| 「匯出用 `List<T>` 就好」 | 41 萬筆訂單讓下單服務一起中斷 | 05 章 5.9 |
| 「SSE 本機是好的就是好的」 | 在 Nginx 後面預設完全不動 | 05 章 5.11 |
| 「回應是對的就等於前端拿得到」 | 錯誤回應少了 CORS 標頭 → 前端只看到 `Network Error` | 06 章 6.2.1、6.3.5 |
| 「`new ObjectMapper()` 只是拿一個 mapper」 | 你拿到的是**沒有任何設定**的那一個 | 06 章 6.5.2 |
| 「新增一個 enum 值是相容的變更」 | 舊 App 大量閃退 —— 除非你先做過準備 | 06 章 6.5.8 |
| 「測試全綠就是對的」 | `addFilters = false` 讓 415 個測試跑在沒有授權的世界裡 | 07 章 7.2.1 |
| 「斷言 `status().isOk()` 就夠了」 | mock 沒 stub 回 `null` → 200 + 空 body，測試照樣綠 | 07 章 7.2.3 |

**每一條都有一段跑得起來的程式碼把它拆掉**，而不是一句「應該要注意」。
每一章最後都有一份「常見誤區」的完整清單。

---

## 產出

依照 03-rest-api 的 `orders-api.yaml` 契約，實作出一組**完整的訂單 Web 層**：

- **路由與綁定**：83 條 URL 的方法簽章、14 個查詢參數綁成一個 `OrderFilter` record、
  `PATCH` 的三態語意、自訂 `Converter`。
- **驗證**：Bean Validation + 七個自訂驗證註解 + 四層 DoS 防護，錯誤一律變成 `errors[]`。
- **一套錯誤格式**：83 個 `ErrorCode` 的註冊表、一個 advice、
  以及 **Controller / Filter / Security / Nginx 四層格式一致**的檢查。
- **橫切機制**：`TraceIdFilter`、三層請求日誌與遮蔽、分頁硬上限、冪等鍵、`@CurrentActor`。
- **檔案與串流**：安全的上傳（magic number、二次編碼、ZIP bomb）、中文檔名下載、
  `StreamingResponseBody` 匯出、`202` + 輪詢的非同步工作、SSE 推播。
- **序列化**：CORS 設定、Jackson 全域設定、金額與時間的最終決策、enum 的演進策略、`ETag`。
- **測試**：`@WebMvcTest` 切片、`ArgumentCaptor`、一個測試涵蓋 83 個 code、
  **83 × 5 的授權矩陣**、OpenAPI 契約測試、CI 分層與突變測試。

**商業邏輯全部以介面呼叫下一層** —— `OrderService` 之後的東西是
[05-service/](../05-service/) 的事。

### 三張最常回頭查的決策表

| 想做什麼 | 去哪裡查 |
|---|---|
| 一個橫切需求該用 Filter / Interceptor / ArgumentResolver / AOP？ | 04 章 4.13.5 |
| 一個「大東西」該用 multipart / 預簽名 / 串流 / 非同步工作？ | 05 章 5.12.3 |
| 這個東西該用哪一種測試（純單元 / 切片 / 整合 / 真 HTTP）？ | 07 章 7.3.3、7.3.4 |
| filter 的 order 該給多少？ | 06 章 6.9.4（04 → 06 章的總表） |
| `@WebMvcTest` 測不到什麼、要改用哪一種？ | 07 章 7.11.1（配合 7.5.9 的 12 個差異） |

---

## 關於書裡的程式碼

**基準版本**：Java 21 / Spring Boot 3.2.5（Spring Framework 6.1）/ Jackson 2.17.2 /
Hibernate Validator 8.0 / JUnit 5.10 / Mockito 5.7 / ArchUnit 1.3。

⚠️ **三件開始前先知道的事**：

1. **Jackson 版本是刻意拉高的。** Boot 3.2.5 管理的是 2.15.4，
   而 06 章 6.5.3 的 JSON 炸彈防護需要 2.16+ 的 `maxDocumentLength` / `StreamWriteConstraints`。
   pom 裡的 `<jackson-bom.version>` 覆寫**必須留著**，理由與代價寫在 6.5.3。
2. **`@MockitoBean` 需要 Boot 3.4。** 這一站統一寫 `@MockitoBean`（政策見 07 章 7.6.1），
   因為 7.6.1 整節就是在教「新的那個在你的版本上不存在」這件事。
   **在 Boot 3.2 / 3.3 上，每一處都要改成 `@MockBean`** —— 課程在每個出現的地方都加了註記。
   ⚠️ 下一站（05-service）刻意選了相反的做法：它全站直接寫 `@MockBean`。
   兩者語意相同，只有 import 與類別名不同；放在同一個專案裡挑一個統一即可。
3. **07 章 7.7.3～7.7.4 的測試 fixture 用的是簡化版的 `OrderDetail`**，
   欄位與 06 章 6.5.9 的正式版不同（最重要的差別是金額：
   正式版是 `amounts.total`，簡化版是 `totalAmount`）。
   完整的欄位對照表就放在 7.7.4 那一節 —— **照著做專案時請以 06 章的為準**。

---

## 程式碼演進：後面的章節修正了前面的三處

**這三處是「上游的決定被下游的現實推翻」。**
課程刻意**不**回頭改寫前面的章節，只在原處標註理由 ——
因為「先看見痛，再給解法」需要痛留在原處。

| 改了什麼 | 原本在哪 | 為什麼 |
|---|---|---|
| `CachedBodyFilter` 要跳過 multipart | 04 章 4.4.6 | 否則 `MultipartFile` 綁到 `null`（05 章 5.6.4） |
| 冪等指紋對 multipart 不含 body | 04 章 4.9.4 | boundary 每次隨機 → 同樣的請求算出不同指紋（05 章 5.6.4） |
| `ProblemWriter` 的 `reset()` 要保留 CORS 標頭 | 03 章 3.10.1 | 否則所有 401 / 403 前端都讀不到內容（06 章 6.3.5） |

> 📌 **下一站（[05-service/](../05-service/)）有一張同樣的表，而它有 46 列。**
> 那不是因為 04-controller 寫得比較好，而是因為
> **「Service 是 stub」這個前提一旦拿掉，Web 層的許多決定就要重做** ——
> 例如 `allowedActions()` 為什麼不可能沒有參數。

---

> 讀完這一站，一個請求已經可以完整地進來、被驗證、變成一個 command，然後原路變成 JSON 回去。
> **接下來要決定的是「它到底做了什麼」** —— 從 [05-service/](../05-service/) 開始。
