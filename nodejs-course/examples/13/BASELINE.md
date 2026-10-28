# Express 遷移基準：第 13 章

這份文件記錄**第 13 章已實作的契約子集**，供 14–16 章搬到 NestJS 時對照。它不等同於第 00 章的最終專題規格。契約變更必須說明理由、更新測試與消費端；不能只為了讓新框架的預設行為通過而改掉預期值。

## 1. 範圍與環境

- 固定作者 u_demo，僅供本機；尚無登入、Session、授權、留言、稽核、前端或正式部署設定。
- Node 24.22.1、npm 11.19.1、TypeScript 5.9.3、Jest 30.2.0。
- Express 5.3.0、Zod 4.6.7、Supertest 7.3.1；Prisma CLI／Client／adapter-pg 7.10.1、pg 8.23.1、PostgreSQL 17。
- 主機 API 3013、開發 PostgreSQL 15413；test-db 不公開端口。
- schema、migration、src 與第 12 章相同。本章擴充驗收，不新增業務端點或 ORM。

## 2. 路由矩陣

| 路徑 | 方法 | 成功回應／用途 |
|------|------|----------------|
| `/health/live` | GET、HEAD | 200，`{ data: { status: 'ok' } }` |
| `/health/ready` | GET、HEAD | Article 查詢成功為 200，失敗為 503 NOT_READY |
| `/api/articles` | GET、HEAD | 200，published 列表與分頁 metadata |
| `/api/articles` | POST | 201，建立 draft；Location 為 `/api/me/articles/:id` |
| `/api/articles/preview` | POST | 200，修剪後輸入加 status: draft、preview: true；不寫入 |
| `/api/articles/export` | GET、HEAD | 200，獨立 NDJSON 檔；檔案不存在回 404 EXPORT_NOT_FOUND |
| `/api/articles/:id` | GET、HEAD | 200，只可讀 published；其他狀態或不存在回 404 |
| `/api/articles/:id` | PATCH | 200，修改 title／content，版本加 1 |
| `/api/articles/:id/publish` | POST | 200，draft → published，版本加 1 |
| `/api/articles/:id/archive` | POST | 200，draft／published → archived，版本加 1 |
| `/api/me/articles` | GET、HEAD | 200，固定作者的全部狀態文章 |
| `/api/me/articles/:id` | GET、HEAD | 200，固定作者的單篇文章；不可見或不存在為 404 |

已知路徑不支援的方法回 **405 METHOD_NOT_ALLOWED**，Allow 列出表中的合法方法（順序由測試固定）；沒有永久 DELETE。未知路徑回 404 NOT_FOUND。大小寫敏感，詳細路徑多一個尾斜線回 404。列表掛載點目前同時接受 `/api/articles` 與 `/api/articles/`；不要由詳細路徑的 strict 設定推論所有路徑都相同。

HEAD 回傳狀態與必要 metadata，不送 body；包含錯誤回應。匯出 Content-Type 為 `application/x-ndjson; charset=utf-8`，Content-Disposition 為 `attachment; filename="articles.ndjson"`，Content-Length 是檔案 bytes。

## 3. 輸入與回應

- 寫入及 preview 要求 application/json、UTF-8；不接受壓縮 request body。
- JSON body 上限 16 KiB。title／content 先 trim，再依 Unicode code point 計數：title 1–120、content 1–4000。
- 沿用 Express strict JSON parser：頂層 null／數字／布林值／字串回 400 INVALID_JSON；陣列可解析，但由 Zod 回 400 VALIDATION_ERROR。物件內的欄位為 null 也由 Zod 拒絕；B09 固定這些分類。
- 建立／preview 只接受 title、content。PATCH 只接受 title、content、expectedVersion，至少提供一個文字欄位；未提供的文字欄位保留，null 不接受。
- publish／archive 只接受 expectedVersion。版本必須是正安全整數，不把字串轉數字；過大但合法的舊版本仍回 409。
- 列表只接受 page、pageSize；原始 query 必須是單一十進位數字字串。預設 1、20，上限 1000000、100；重複參數與額外欄位回 400。
- 排序 createdAt DESC，再 id DESC；先篩選後分頁與 count。空頁是 data: []，total 是該可見範圍的總數。
- export 不接受 query。其他未掛 query schema 的端點目前不檢查 query；遷移時不要誤稱所有路由都拒絕未知 query。

單篇成功 body 只有 data，Article 公開欄位固定為：id、authorId、title、content、status、version、createdAt、updatedAt。時間為 ISO UTC 字串，ID 視為不透明字串。列表為 `{ data: Article[], meta: { page, pageSize, total } }`。

失敗 body 為：

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "文章已更新，請重新讀取",
    "details": []
  },
  "requestId": "由伺服器產生，與 X-Request-ID header 相同"
}
```

每個請求由伺服器產生新的 X-Request-ID，不直接採用外部傳入值。VALIDATION_ERROR 的 details 元素為 field／code／message，field 以 body、query、params 起頭；未知欄位代碼 UNKNOWN_FIELDS，不回傳原始欄位名稱或值。其他無細項錯誤的 details 為空陣列。未知錯誤固定為 500 INTERNAL_ERROR／內部錯誤，不帶 SQL、連線字串或 stack。

## 4. 狀態與一致性

| 原狀態 | PATCH | publish | archive |
|--------|-------|---------|---------|
| draft | 保持 draft | published | archived |
| published | 保持 published | 409 INVALID_STATE | archived |
| archived | 409 INVALID_STATE | 409 INVALID_STATE | 409 INVALID_STATE |

所有成功更新都加一個版本。已通過 HTTP 驗證後的業務錯誤優先序：不存在 → 舊版本 → 非法狀態 → 版本上限 → 條件 UPDATE 未匹配。版本上限為 2147483647；此時拒絕增加並回 409 VERSION_LIMIT。

UPDATE 同時比對 id＋version＋status，並檢查受影響筆數；讀取、更新、讀回在同一交易。列表與 total 使用 RepeatableRead 快照。兩個不同 pool 的相同版本更新只能一個成功。交易 callback 後半拋錯時，前半寫入必須回滾。

## 5. 自動化證據與測試前置條件

`test/api-contract.ts` 與 10–12 章逐位元相同，包含 3 項核心 HTTP 案例。`test/migration-contract.ts` 增加以下分組，參數表展開為 29 項測試：

| 編號 | 驗證範圍 |
|------|----------|
| B01–B05 | 公開欄位、日期、Location、分頁、PATCH、版本衝突、狀態與失敗不寫入 |
| B06–B09 | PATCH 及 query 驗證、Unicode、拒絕額外欄位、parser 錯誤與 body byte 上限 |
| B10–B12 | preview 無寫入、405／Allow、未知路徑、大小寫、尾斜線、無效路徑編碼 |
| B13–B15 | HEAD、request ID、健康成功回應、獨立 NDJSON 與 metadata |

兩份契約都只透過 HTTP 呼叫 Server，不讀資料庫或內部類別。`migration-baseline.test.ts` 負責組裝，共執行 32 項案例；替換框架時主要更換這份組裝程式。

每個案例前必須有獨立乾淨資料：u_demo；a_1、a_2 為 published，a_draft 為 draft，version 全為 1，建立日期依序為 2026-01-03、01-02、01-01 的 UTC 午夜；title／content 由 seedDatabase 提供。匯出指向測試建立的臨時檔案，內容透過 exportText 參數交給契約函式；不能依賴讀者手動 seed 的 `.data`。

其他必要驗收仍在完整 check：

- database.test.ts：持久化、真實資料庫約束、條件寫入、不同 pool 併發、交易回滾與缺表 readiness。
- database-isolation.test.ts：拒絕不安全測試 URL；兩個 schema 的相同 ID 互不影響，清理一個不傷另一個。
- Service／Controller／錯誤／串流／shutdown 測試：用例與邊界失敗、已送 header 的錯誤、離線後仍等待登記工作。
- test:runtime：建置後的真實入口、缺設定／migration、SIGINT／SIGTERM、重複信號、進行中請求與有界關閉。

這不是窮盡所有 HTTP bytes 的協定測試；未宣稱各框架的內部日誌、堆疊、Date header 或暫存檔路徑相同。32 項基準通過，也不能替代資料庫與程序驗證。

尚未搬入本章基準的傳輸案例：非法 UTF-8 bytes、慢速 body 逾時與下載中斷後關檔等。它們仍在 [10 章 HTTP 測試](../10/test/http.test.ts)及[匯出測試](../10/test/export.test.ts)驗證 Express 快照；16 章須接到 Nest 的獨立 fixture 與 server 重新執行，舊實作通過不等於新實作已驗證。

## 6. 搬到 NestJS 時的變更邊界

| 現有內容 | 遷移方式 |
|----------|----------|
| article-model、Service 與 Repository 介面 | 優先保留規則，從手動 factory 接到 Provider |
| Prisma Repository、schema、migration | 保留條件更新、交易與歷史；不因換框架重建表格 |
| Controller／Router | 改為 Nest Controller，逐條維持路徑、狀態碼、Location、HEAD 與 405 |
| Zod／body parser／錯誤出口 | 接到新的請求流程；保持驗證、限制與錯誤 envelope |
| application／main／shutdown | 由新組裝與生命週期接上；仍等待登記工作再 disconnect |
| 兩份 HTTP 契約函式 | 複製到下一章，改組裝，不為了迎合框架預設改 assertion |

14–16 章先遷移功能，不加登入要求；18 章才有意識地新增未登入／越權案例。第 00 章的最終錯誤名稱是 INVALID_ARTICLE_STATE，目前基準是 INVALID_STATE；後續若統一名稱，必須明列契約變更並同步測試。不能在純框架遷移時暗中改名。

尚未實作：留言、認證授權、文章與稽核的跨資料交易、快取、背景工作、正式部署與安全設定。11–13 章已驗證單篇條件更新的併發保證；20 章將擴大交易情境，並非從零才開始保護版本。
