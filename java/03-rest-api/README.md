# 03 — REST API 設計

> 這一站**刻意不綁框架**。API 設計的好壞，決定了前端要不要罵你、三個月後能不能改。
> 先把「介面契約」想清楚，下一站 04-controller 才是把它實作出來。

---

## 學完你可以

- 說明 REST 的核心約束，並判斷什麼情況其實不該用 REST。
- 設計一組一致的 URL 與資源結構，處理巢狀資源與「不是 CRUD」的動作。
- 選對 HTTP 方法與狀態碼，說明冪等性為什麼重要。
- 設計 DTO 與統一回應 / 錯誤格式，讓前端不用猜。
- 做出可用的分頁、篩選、排序，並知道 offset 分頁在大量資料下的問題。
- 用 OpenAPI 把文件變成契約，而不是永遠過期的 Word 檔。

## 前置知識

知道 HTTP 請求 / 回應結構即可，不需要先會 Spring。

---

## 章節目錄

| 章節 | 檔案 | 主題 | 重點 |
|------|------|------|------|
| 00 | `00-course-map-what-is-rest.md` | 課程地圖與 REST 本質 | 六大約束、資源導向思維、REST vs RPC vs GraphQL 的取捨 |
| 01 | `01-resource-modeling-and-url-design.md` | 資源建模與 URL 設計 | 名詞不用動詞、複數命名、巢狀深度、非 CRUD 動作怎麼表達 |
| 02 | `02-http-methods-and-status-codes.md` | HTTP 方法與狀態碼 | GET / POST / PUT / PATCH / DELETE 語意、安全性與冪等性、2xx / 4xx / 5xx 選擇表 |
| 03 | `03-request-response-and-dto-design.md` | 請求與回應設計 | DTO 分離、JSON 命名慣例、日期與時區、null vs 缺欄位、是否要統一包裝層 |
| 04 | `04-error-handling-and-problem-details.md` | 錯誤設計 | RFC 9457 Problem Details、業務錯誤碼、驗證錯誤格式、可讀 vs 可程式化訊息 |
| 05 | `05-pagination-filter-sort-search.md` | 分頁、篩選與排序 | offset vs cursor 分頁、總筆數的代價、篩選參數設計、搜尋端點 |
| 06 | `06-versioning-and-compatibility.md` | 版本控管與相容性 | URL / Header 版本策略、破壞性變更判定、擴充欄位、棄用與退場流程 |
| 07 | `07-openapi-and-documentation.md` | OpenAPI 與文件 | OpenAPI 3 規格、springdoc 產生、Design-first vs Code-first、範例與 Mock Server |
| 08 | `08-idempotency-caching-and-rate-limit.md` | 冪等、快取與限流 | 冪等鍵設計、ETag 與條件請求、`Cache-Control`、限流策略與 429 回應 |
| 09 | `09-api-testing-and-collaboration.md` | 測試與協作 | 測試分層、Postman / REST Client、契約測試、與前端定契約的流程 |

---

## 常見誤區（課程會逐一破解）

- `POST /getUserList`、`GET /deleteUser?id=1` — 方法與語意完全對不上。
- 全部回 `200 OK`，錯誤訊息塞在 body 的 `code` 欄位裡。
- 回應直接把 Entity 丟出去，資料庫欄位改名就爆前端、密碼欄位還一起外洩。
- 分頁只有 `page` / `size`，資料到第 10 萬頁時查詢直接逾時。
- 「先做完再補文件」，結果文件永遠與實作不一致。

## 產出

本站結束時會有一份完整的 **訂單系統 OpenAPI 契約**（`orders-api.yaml`），
後續 04-controller 與 10-capstone 都會拿它當實作目標。
