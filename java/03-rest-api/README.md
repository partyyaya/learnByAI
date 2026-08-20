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
- 把整站的設計決策對照回 OWASP API Security Top 10，確認沒有一項是空白的。

## 前置知識

知道 HTTP 請求 / 回應結構即可，不需要先會 Spring。

---

## 章節目錄

| 章節 | 檔案 | 主題 | 重點 |
|------|------|------|------|
| 00 | [00-course-map-what-is-rest.md](./00-course-map-what-is-rest.md) ✅ | 課程地圖與 REST 本質 | 六大約束、Richardson 成熟度、資源導向思維、REST vs RPC vs GraphQL vs gRPC |
| 01 | [01-resource-modeling-and-url-design.md](./01-resource-modeling-and-url-design.md) ✅ | 資源建模與 URL 設計 | 命名十規則、識別碼與 IDOR、巢狀深度、**非 CRUD 動作的五種手法** |
| 02 | [02-http-methods-and-status-codes.md](./02-http-methods-and-status-codes.md) ✅ | HTTP 方法與狀態碼 | 安全性與冪等性、`PUT` vs `PATCH`、狀態碼決策樹、`202` 輪詢、`ETag` 樂觀鎖 |
| 03 | [03-request-response-and-dto-design.md](./03-request-response-and-dto-design.md) ✅ | 請求與回應設計 | 不回 Entity 的六個後果、mass assignment、金額與時間型別、列舉演進 |
| 04 | [04-error-handling-and-problem-details.md](./04-error-handling-and-problem-details.md) ✅ | 錯誤設計 | RFC 9457、錯誤碼註冊表、驗證錯誤格式、`traceId` 鏈路、重試語意 |
| 05 | [05-pagination-filter-sort-search.md](./05-pagination-filter-sort-search.md) ✅ | 分頁、篩選與排序 | 深分頁與資料漂移、**cursor 複合鍵**、`COUNT(*)` 的代價、排序白名單、搜尋分派 |
| 06 | [06-versioning-and-compatibility.md](./06-versioning-and-compatibility.md) ✅ | 版本控管與相容性 | **Consumer Contract**、破壞性變更判定表、Expand–Contract 六步、`Sunset` 與棄用流程 |
| 07 | [07-openapi-and-documentation.md](./07-openapi-and-documentation.md) ✅ | OpenAPI 與文件 | OpenAPI 3.1、`oneOf`+`discriminator`、springdoc 十個必做設定、Prism mock、25 條 Spectral 規則 |
| 08 | [08-idempotency-caching-and-rate-limit.md](./08-idempotency-caching-and-rate-limit.md) ✅ | 冪等、快取與限流 | 冪等鍵的三個競態、請求指紋正規化、`Cache-Control` 全指令、五種限流演算法、三者的交互作用 |
| 09 | [09-api-testing-and-collaboration.md](./09-api-testing-and-collaboration.md) ✅ | 測試與協作 | 六層測試分工、OpenAPI 契約驗證、資安迴歸測試、**OWASP API Top 10 對照表**、契約先行協作 |

---

## 常見誤區（課程會逐一破解）

- `POST /getUserList`、`GET /deleteUser?id=1` — 方法與語意完全對不上。
- 全部回 `200 OK`，錯誤訊息塞在 body 的 `code` 欄位裡。
- 回應直接把 Entity 丟出去，資料庫欄位改名就爆前端、密碼欄位還一起外洩。
- 分頁只有 `page` / `size`，資料到第 10 萬頁時查詢直接逾時。
- 「先做完再補文件」，結果文件永遠與實作不一致。

## 產出

一份完整的 **訂單系統 OpenAPI 契約**（`orders-api.yaml`，第 07 章），
外加 25 條 Spectral 規則、五個 job 的 CI pipeline、以及一整套契約測試（第 09 章）。
後續 04-controller 與 10-capstone 都會拿它當實作目標。

---

## 貫穿案例：shop-service 訂單系統

延續 [02-spring-boot](../02-spring-boot/) 的練習專案，這一站只做**設計**（不寫 Spring）。
領域是一個中小型 B2C 電商的訂單模組，有三種角色（顧客 / 客服 / 倉管）與一張七狀態的訂單狀態機。

| 章節 | 對案例做了什麼 |
|------|----------------|
| 00 | 領域盤點、訂單狀態機、20 條需求的「動詞 → 資源」對照表 |
| 01 | 19 個資源、**70 條端點的完整 URL 表**、識別碼方案（ULID + 對外編號） |
| 02 | 每條端點的方法 + 狀態碼契約表、15 條全域規則、契約冒煙測試腳本 |
| 03 | **22 個 DTO 的全家族**與 JSON 範例（含客服版的欄位差異） |
| 04 | **錯誤目錄**（第 04 章約 60 個碼，05/08 章再補 15 個）、8 個完整錯誤回應範例、前端消費程式碼 |
| 05 | **分頁／篩選／排序完整規格**、9 個索引清單、9 個新錯誤碼 |
| 06 | **Consumer Contract**、版本策略、PR checklist、棄用登記表 |
| 07 | **`orders-api.yaml`**（含 webhooks）、25 條 Spectral 規則、五個 job 的 CI |
| 08 | **冪等／快取／限流完整規格**、快取矩陣、多桶限流配額、6 個新錯誤碼 |
| 09 | **測試套件**（六層）、**OWASP API Top 10 對照表**、契約 review checklist、合成監控、compliance 追蹤 |

> **這六張表（資源清單、URL 表、狀態碼契約、DTO 清單、錯誤目錄、查詢參數規格）就是 API 設計的核心產出。**
> 如果你正在為實際專案設計 API，讀完 00～05 就可以拉出這六張表做一次團隊 review；
> 06～09 則是讓這份設計「能演進、能驗證、能被團隊執行」。

---

## 如果只能記住十五件事

1. **狀態碼是給機器看的，訊息是給人看的** —— 全部回 200 會讓監控、熔斷、健康檢查、自動重試全部失效。
2. **URL 用名詞，動詞交給 HTTP 方法** —— 唯一的例外是「控制器資源」，而且要列白名單。
3. **「這個動作有沒有留下值得查詢的紀錄？」** —— 有就是資源（`payments`、`cancellations`、`shipments`）。
4. **冪等性保護的是重試** —— 非冪等的 `POST` 被自動重試 = 重複扣款。關鍵操作一律要冪等鍵。
5. **`PUT` 沒送的欄位會被清空** —— 這是最常見的靜默資料遺失。表單只有部分欄位就用 `PATCH`。
6. **絕不回 Entity、絕不用 Entity 收請求** —— 前者洩漏 `passwordHash`，後者是 mass assignment 漏洞。
7. **金額用字串 decimal + 幣別，ID 一律字串，時間一律 UTC ISO-8601** —— 三個都是靜默算錯的來源。
8. **集合永遠回 `[]`，不回 `null`** —— 省 4 個字元，換前端白畫面。
9. **每個錯誤都要有 `code`、`userMessage`、`traceId`** —— 這三個欄位決定除錯是 4 分鐘還是一整天。
10. **改語意必須改名字** —— 加欄位安全，改型別／改單位／改語意是災難，而且不會拋錯。
11. **任何回集合的端點都要有 `size` 硬上限與深分頁上限** —— 一個實習生點一下就能讓全站掛 16 分鐘。
12. **靜默忽略是最貴的「寬容」** —— 忽略未知參數 = 篩選沒生效但沒人知道；靜默夾取 `size` = 匯出少了 41 萬筆。
13. **大部分你以為需要開 v2 的變更，其實不需要** —— Stripe 13 年沒有 v2，靠的是 Expand–Contract 與日期版本。
14. **相容性不是靠文件維持的，是靠工具維持的** —— Consumer Contract 要配「未知值注入」等可執行的測試工具，否則只是免責聲明。
15. **每一層都是別人的安全網** —— 冪等鍵失效有 UNIQUE 約束、限流失效有 velocity guard、DTO 漏了有 Spectral。設計時要假設其他機制會失效。

## 七張最常用的決策圖

| 我在想什麼 | 去看 |
|------------|------|
| 這個「動作」該怎麼變成 URL？ | [01 章 1.7.1 五種手法決策流程圖](./01-resource-modeling-and-url-design.md) |
| 這個情況該回什麼狀態碼？ | [02 章 2.8.6 狀態碼決策樹](./02-http-methods-and-status-codes.md) |
| 這個錯誤回應夠不夠用？ | [04 章 4.3 錯誤的六個問題](./04-error-handling-and-problem-details.md) |
| 這支列表端點該用 offset 還是 cursor？ | [05 章 5.5.2 分頁決策流程](./05-pagination-filter-sort-search.md) |
| 這個變更是破壞性的嗎？ | [06 章 6.3 破壞性變更判定表與流程圖](./06-versioning-and-compatibility.md) |
| 這條規則該測在哪一層？ | [09 章 9.2.1 測試六層分工](./09-api-testing-and-collaboration.md) |
| 這一版有沒有漏掉某類資安風險？ | [09 章 9.4.6 OWASP API Top 10 對照表](./09-api-testing-and-collaboration.md) |

---

## 進度

**第 00～09 章全部完成**（含每章的驗收清單與附解答練習）。這一站已結業。

| 章節 | 狀態 | 篇幅 |
|------|------|------|
| 00 課程地圖與 REST 本質 | ✅ 完成 | 約 1,700 行 |
| 01 資源建模與 URL 設計 | ✅ 完成 | 約 2,400 行 |
| 02 HTTP 方法與狀態碼 | ✅ 完成 | 約 3,000 行 |
| 03 請求與回應設計 | ✅ 完成 | 約 3,600 行 |
| 04 錯誤設計與 Problem Details | ✅ 完成 | 約 4,200 行 |
| 05 分頁、篩選與排序 | ✅ 完成 | 約 4,600 行 |
| 06 版本控管與相容性 | ✅ 完成 | 約 2,900 行 |
| 07 OpenAPI 與文件 | ✅ 完成 | 約 4,500 行 |
| 08 冪等、快取與限流 | ✅ 完成 | 約 3,700 行 |
| 09 測試與協作 | ✅ 完成 | 約 3,000 行 |

十章合計約 **33,700 行**（不含 README）。

> ⚠️ 課程中的程式碼、JSON 與設定均經逐行檢閱，但**尚未在本機編譯執行驗證**
> （這台機器上沒有安裝 JDK 與 Maven）。若你在實作時遇到與課文不符的行為，請以你的環境為準。
> RFC 與框架行為（Spring Boot 3.x、Jackson 2.15+）請對照你實際使用版本的官方文件。
