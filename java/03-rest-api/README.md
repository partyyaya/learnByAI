# 03 — REST API 設計

> 這一站**刻意不綁框架**。API 設計的好壞，決定了前端要不要罵你、三個月後能不能改。
> 先把「介面契約」想清楚，下一站 [04-controller](../04-controller/) 才是把它實作出來。

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
| 00 | [00-course-map-what-is-rest.md](./00-course-map-what-is-rest.md) | 課程地圖與 REST 本質 | 六大約束、Richardson 成熟度、資源導向思維、REST vs RPC vs GraphQL vs gRPC |
| 01 | [01-resource-modeling-and-url-design.md](./01-resource-modeling-and-url-design.md) | 資源建模與 URL 設計 | 命名十規則、識別碼與 IDOR、巢狀深度、**非 CRUD 動作的五種手法** |
| 02 | [02-http-methods-and-status-codes.md](./02-http-methods-and-status-codes.md) | HTTP 方法與狀態碼 | 安全性與冪等性、`PUT` vs `PATCH`、狀態碼決策樹、`202` 輪詢、`ETag` 樂觀鎖 |
| 03 | [03-request-response-and-dto-design.md](./03-request-response-and-dto-design.md) | 請求與回應設計 | 不回 Entity 的六個後果、mass assignment、金額與時間型別、列舉演進 |
| 04 ★ | [04-error-handling-and-problem-details.md](./04-error-handling-and-problem-details.md) | 錯誤設計 | RFC 9457、錯誤碼註冊表、驗證錯誤格式、`traceId` 鏈路、重試語意 |
| 05 | [05-pagination-filter-sort-search.md](./05-pagination-filter-sort-search.md) | 分頁、篩選與排序 | 深分頁與資料漂移、**cursor 複合鍵**、`COUNT(*)` 的代價、排序白名單、搜尋分派 |
| 06 | [06-versioning-and-compatibility.md](./06-versioning-and-compatibility.md) | 版本控管與相容性 | **Consumer Contract**、破壞性變更判定表、Expand–Contract 六步、`Sunset` 與棄用流程 |
| 07 ★ | [07-openapi-and-documentation.md](./07-openapi-and-documentation.md) | OpenAPI 與文件 | OpenAPI 3.1、`oneOf`+`discriminator`、springdoc 十個必做設定、Prism mock、25 條 Spectral 規則 |
| 08 | [08-idempotency-caching-and-rate-limit.md](./08-idempotency-caching-and-rate-limit.md) | 冪等、快取與限流 | 冪等鍵的三個競態、請求指紋正規化、`Cache-Control` 全指令、五種限流演算法、三者的交互作用 |
| 09 | [09-api-testing-and-collaboration.md](./09-api-testing-and-collaboration.md) | 測試與協作 | 六層測試分工、OpenAPI 契約驗證、資安迴歸測試、**OWASP API Top 10 對照表**、契約先行協作 |

### 怎麼讀

```
00（REST 本質、資源導向思維、貫穿案例）
 └─→ 01（資源與 URL：後面每一章都掛在這張表上）
      └─→ 02（方法與狀態碼：把 URL 表補成契約表）
           └─→ 03（DTO：請求與回應長什麼樣）
                └─→ 04 ★ 錯誤設計（錯誤格式在這裡定案，05／08 只往上加碼）
                     ├─→ 05（分頁、篩選、排序）
                     ├─→ 06（版本與相容性）
                     │    └─→ 07 ★ OpenAPI（把 01～06 的決定收斂成一份機器可讀的契約）
                     │         └─→ 08（冪等、快取、限流）
                     └─────────────→ 09（測試與協作：驗證前面九章的每一條規則）
```

⚠️ **如果時間有限**：
**04 是最關鍵的一章** —— 錯誤格式一旦定下來，05、07、08 都在往它上面掛東西。
**05 是「半年後才會炸」密度最高的一章**（深分頁、`COUNT(*)`、排序白名單）。
**07 是唯一把前面所有決定變成可執行檔案的一章。**

---

## 這一站會打破的幾個假設

| 你以為 | 實際上 | 在哪一章 |
|---|---|---|
| 「全部回 `200`，錯誤放 body 裡就好」 | 監控、熔斷、健康檢查、自動重試會全部失效 | 02 章 2.12 |
| 「`PUT` 跟 `PATCH` 差不多」 | `PUT` 沒送的欄位會被清空 —— 最常見的靜默資料遺失 | 02 章 2.5 |
| 「回 Entity 比較快」 | `passwordHash` 一起外洩，而且欄位改名就爆前端 | 03 章 3.2 |
| 「ID 用數字比較自然」 | 超過 `MAX_SAFE_INTEGER` 的 ID 在 JS 裡被靜默改掉 | 01 章 1.4.5、03 章 3.5.4 |
| 「集合空的時候回 `null` 或 `404`」 | 前端白畫面；省 4 個字元換一次線上事故 | 03 章 3.7 |
| 「分頁有 `page` / `size` 就夠了」 | 第 10 萬頁查詢逾時，而且資料會漂移 | 05 章 5.2、5.3 |
| 「cursor 只要記住 `created_at` 就好」 | 排序值重複且切在頁邊界時，整批資料**永遠不會出現** | 05 章 5.4.2 |
| 「未知的查詢參數忽略掉比較寬容」 | 篩選沒生效，而且沒有任何人知道 | 05 章 5.8.6 |
| 「這個變更要開 v2」 | 大部分不用 —— Stripe 13 年沒有 v2 | 06 章 6.7 |
| 「先做完再補文件」 | 文件永遠與實作不一致，最後沒人信它 | 07 章 7.2 |
| 「冪等鍵就是存進 Redis，有就跳過」 | 三個競態條件，其中一個會重複扣款 | 08 章 8.2.4 |
| 「`no-cache` 就是不要快取」 | 它的意思是「可以存，但用前要驗證」 | 08 章 8.3.2 |

每一章最後都有一份「常見誤區」的完整清單。

---

## 貫穿案例：shop-service 訂單系統

延續 [02-spring-boot](../02-spring-boot/) 的練習專案，這一站只做**設計**（不寫 Spring）。
領域是一個中小型 B2C 電商的訂單模組，有三種角色（顧客 / 客服 / 倉管）與一張七狀態的訂單狀態機。

| 章節 | 對案例做了什麼 |
|------|----------------|
| 00 | 領域盤點、訂單狀態機、20 條需求的「動詞 → 資源」對照表 |
| 01 | 19 個資源、**完整的 URL 表**、識別碼方案（ULID + 對外編號） |
| 02 | 主要端點的方法 + 狀態碼契約表、15 條全域規則、契約冒煙測試腳本 |
| 03 | **22 個 DTO 的全家族**與 JSON 範例（含客服版的欄位差異） |
| 04 | **錯誤目錄**（67 個碼，05／08 章再補 11 個）、8 個完整錯誤回應範例、前端消費程式碼 |
| 05 | **分頁／篩選／排序完整規格**、9 個索引清單、9 個新錯誤碼 + 4 個 warning 碼 |
| 06 | **Consumer Contract**、版本策略、PR checklist、棄用登記表 |
| 07 | **`orders-api.yaml`**（骨架 + 共用元件 + 完整範例端點 + webhooks）、25 條 Spectral 規則、五個 job 的 CI |
| 08 | **冪等／快取／限流完整規格**、快取矩陣、多桶限流配額 |
| 09 | **測試套件**（六層）、**OWASP API Top 10 對照表**、契約 review checklist、合成監控、compliance 追蹤 |

> **這六張表（資源清單、URL 表、狀態碼契約、DTO 清單、錯誤目錄、查詢參數規格）就是 API 設計的核心產出。**
> 如果你正在為實際專案設計 API，讀完 00～05 就可以拉出這六張表做一次團隊 review；
> 06～09 則是讓這份設計「能演進、能驗證、能被團隊執行」。

## 產出

一份 **訂單系統的 OpenAPI 契約**（`orders-api.yaml`，第 07 章）：
檔案結構、`securitySchemes`、共用參數與錯誤回應、`oneOf` 多形回應、webhooks，
以及一條**從頭寫到尾的完整端點**（`GET /orders`）當作其餘端點的樣板。
外加 25 條 Spectral 規則、五個 job 的 CI pipeline、以及一整套契約測試（第 09 章）。
後續 04-controller 與 12-capstone 都會拿它當實作目標。

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
| 這個錯誤回應夠不夠用？ | [04 章 4.3 錯誤的五個問題](./04-error-handling-and-problem-details.md) |
| 這支列表端點該用 offset 還是 cursor？ | [05 章 5.5.2 分頁決策流程](./05-pagination-filter-sort-search.md) |
| 這個變更是破壞性的嗎？ | [06 章 6.3 破壞性變更判定表](./06-versioning-and-compatibility.md) |
| 這條規則該測在哪一層？ | [09 章 9.2.1 測試六層的分層與職責](./09-api-testing-and-collaboration.md) |
| 這一版有沒有漏掉某類資安風險？ | [09 章 9.4.6 OWASP API Top 10 對照表](./09-api-testing-and-collaboration.md) |

---

## 關於書裡的程式碼

這一站是**設計站**，程式碼多半是用來說明設計決定的片段，不是一個可以直接 `mvn` 起來的專案 ——
真正跑得起來的實作從 [04-controller](../04-controller/) 開始。

**規格與工具基準**：OpenAPI 3.1 / RFC 9457（Problem Details）/ RFC 9110–9111（HTTP）/
springdoc-openapi 2.6 / Spectral 6 / Prism 5 / Redocly CLI 1.x / MySQL 8.0。
Java 片段以 Java 21 + Spring Boot 3.3 的行為為準。

⚠️ **兩個「跟你的環境有關」的地方**：

1. **RFC 與框架行為請對照你實際使用的版本。** 第 02 章的狀態碼語意來自 RFC 9110，
   但各家框架的預設行為（例如 Spring 對驗證失敗預設回 `400` 而非 `422`）不一定跟規範一致 ——
   課文會標出來，但版本一換就可能不同。
2. **第 05 章的 cursor SQL 一定要自己 `EXPLAIN ANALYZE` 一次。**
   `WHERE (created_at, id) < (?, ?)` 這種 row constructor 寫法**是否**被最佳化成
   index range scan，跟 MySQL 版本與索引定義高度相關；沒被最佳化時它會退化成全索引掃描，
   而且**只有在深分頁時才看得出來**（5.4.1 附了 MySQL 8.0.46 上 1,900 倍差距的實測）。

