# 21 — API 契約、分頁／篩選、OpenAPI 與查詢成本

第 20 章讓文章狀態與稽核一起提交。本章處理另一個常見問題：**前端知道怎麼呼叫列表，不代表它知道列表能看哪些資料、如何排序、total 算什麼，以及文件是否真的符合服務。**

我們延伸既有列表，新增標題搜尋、固定排序選項與本人文章狀態篩選，再提供可匯出的 OpenAPI JSON。最後以隔離 PostgreSQL 實驗觀察第一頁、深 offset、精確 count 與搜尋的成本。[完整範例](examples/21/README.md)與[本章契約](examples/21/BASELINE.md)可直接執行。

## 21.1 本章完成後應能做到什麼？

- 分清 TypeScript DTO、執行期 schema、HTTP wire 契約與 OpenAPI 文件。
- 讓資料權限、搜尋、篩選、排序、分頁與 count 使用一致的查詢條件。
- 解釋穩定排序與單次快照的保證，也能指出 offset 分頁跨請求的限制。
- 用 OpenAPI 描述 Cookie、CSRF、Origin、成功／錯誤、HEAD、204 與 NDJSON。
- 以 HTTP 測試比對文件，避免只驗證 JSON 檔可以解析。
- 閱讀 EXPLAIN 的實際掃描筆數與索引選擇，不把 LIMIT 或索引當作效能保證。

先讀 [17 — DTO／Pipe](17-dto-pipes-and-runtime-validation.md)、[18 — Session／權限](18-authentication-sessions-and-guards.md)、[19 — 回應投影](19-interceptors-filters-and-cross-cutting-concerns.md)、[20 — 交易與併發](20-persistence-transactions-and-concurrency.md)。第 00 章的[最終契約](00-course-map-and-project-contract.md)仍是主線方向。

Node 24.22.1、npm 11.19.1、TypeScript 5.9.3、Jest 30.2.0、Nest 11.2.8、Prisma 7.10.1、pg 8.23.1、PostgreSQL 17 等固定版本沿用。沒有新增套件或 migration；示範帳號密碼仍含 18。

## 21.2 同一個參數，有四個不同層次

以 `GET /api/articles?page=2` 為例：

| 層次 | 實際意義 |
|------|----------|
| HTTP query | parser 取得 `{ page: '2' }`，仍是字串 |
| Zod／Pipe | 檢查單一十進位字串、轉數字、範圍與未知欄位 |
| DTO／應用型別 | handler 取得 `{ page: 2, pageSize: 20 }` 的編譯期型別 |
| OpenAPI | 描述外部可傳的參數、限制與回應，不負責實際執行驗證 |

TypeScript 註記會在執行時消失，不能自動拒絕 `page=abc`。OpenAPI 寫了 enum，也不會替 Controller 安裝 Pipe；文件說需要 Cookie，也不會替路由安裝 Guard。

```text
請求 → 傳輸檢查 → Guard → Pipe → DTO 值 → Service／Repository
  → presenter → HTTP 回應

OpenAPI：描述上述邊界
HTTP 測試：對照描述與實際結果
```

本章維持 Zod 作執行期驗證、DTO 從 schema 推導。OpenAPI 明確維護 wire 契約，透過測試降低不同步風險，沒有再加入一套 class-validator 或 class-transformer。

### 為什麼文件不直接複製所有驗證條件？

title 是先 trim，再按 code points 驗證 1–120。若把 request schema 寫成原始字串 maxLength:120，前後空白可能讓原本合法的輸入被文件工具拒絕。密碼的 512 UTF-8 bytes 上限也不是 JSON Schema 的 maxLength。

因此 request 的正規化與特殊限制明列於 description／x- 擴充欄位；已正規化的文章 response 才標記明確長度。標準工具不會自動執行本課的 x-trimmed-* 規則，這部分要由實際 Pipe 與測試保證。

## 21.3 明確擴充列表契約

本章只擴充兩個既有列表，不新增搜尋專用端點：

| 參數 | 公開 `/api/articles` | 本人 `/api/me/articles` | 規則 |
|------|----------------------|-------------------------|------|
| page | 可 | 可 | 預設 1，1–1000000 |
| pageSize | 可 | 可 | 預設 20，1–100 |
| q | 可 | 可 | trim 後 1–80 code points，不含 NUL |
| sort | 可 | 可 | newest／oldest，預設 newest |
| status | 不可 | 可 | draft／published／archived；省略為本人全部狀態 |

page／pageSize 仍要求單一十進位字串；不接受重複值、科學記號、負數或空字串。q 不 normalize，不搜尋 content；大小寫比較由 PostgreSQL ILIKE 規則決定，不宣稱完整 Unicode case folding、重音忽略、中文斷詞或模糊搜尋。

```text
/api/articles?q=Node&sort=oldest&pageSize=10
  → 公開文章中，標題含 Node，最早的先出現

/api/me/articles?status=draft&q=交易
  → 登入本人草稿中，標題含「交易」
```

公開 `status=draft` 與 `status=published` 都是 400，因為公開 query 沒有這個欄位。authorId 也不是允許參數；不能讓用戶指定另一位作者，再期待前端自己隱藏資料。

[schemas.ts](examples/21/src/schemas.ts)保留原 paginationSchema，另外延伸兩份 strict schema：

```ts
export const publicArticleListSchema = paginationSchema.extend({
  q: searchTitle.optional(),
  sort: z.enum(['newest', 'oldest']).optional(),
});
export const managedArticleListSchema = publicArticleListSchema.extend({
  status: z.enum(['draft', 'published', 'archived']).optional(),
});
```

這樣原 DTO／Pipe 實驗仍可只示範分頁，正式公開與私人 Controller 則各自綁正確 schema。空 q 與省略不同：`?q=` 拒絕，完全不傳 q 才是不搜尋。

private 列表先經 SessionGuard，再進 Pipe，所以未登入呼叫 `?status=bad` 是 401；已登入才會得到 query 的 400。這個順序也列入測試。

## 21.4 資料範圍必須與篩選相交

先看一個危險的組合方式：

```ts
// 若後面的輸入能帶 status，就可能覆寫固定可見範圍。
const where = { status: 'published', ...input };
```

本章使用明確的應用 query，並在 [Repository](examples/21/src/prisma-article-repository.ts)以 AND 相交：

```text
公開：status = published
本人：authorId = actor.id
    AND 可選的 status
    AND 可選的 title 搜尋
```

即使直接呼叫 Service，把 status:draft 傳給 public 查詢，也會得到 published AND draft 的空結果，無法把固定權限覆寫。HTTP 邊界仍會先拒絕這個不合法參數；Repository 的相交規則是另一道資料範圍保證。

admin 的 me 也只套 admin 自己的 authorId。admin 跨作者單篇入口保留，不新增任意作者列表。公開端點對任何角色都仍只提供 published。

### 字面搜尋與 SQL 參數化是兩回事

Prisma contains 在 PostgreSQL 上使用 LIKE／ILIKE 類型的比對。SQL 參數化能避免輸入變成 SQL 結構，但 `%`、`_` 仍可能是模式字元。本章明確選擇「字面子字串」搜尋，因此會先逃脫 `%`、`_` 與反斜線，再交給 Prisma。 [Prisma 篩選／排序文件](https://docs.prisma.io/docs/orm/v7/prisma-client/queries/filtering-and-sorting)

```text
q=100% → 找標題中的「100%」
q=_    → 找真正底線，不是任意單一字元
```

測試會建立含這三種字元的標題，在真實 PostgreSQL 驗證。像 SQL 的搜尋文字也只作為值，不拼接成 WHERE 或 ORDER BY。排序只從固定 enum 選擇方向，不接受任意欄位名稱。

## 21.5 先篩選，再排序與分頁，count 使用相同條件

```text
固定可見範圍 AND 搜尋／狀態
  → ORDER BY createdAt、id
  → skip = (page - 1) × pageSize → take = pageSize
  → 相同 where 的 count
  → data 與 meta 同層回傳
```

不能先取得前 20 筆，再用 JavaScript filter 搜尋或過濾權限。那樣每頁可能不足 20 筆，total 也可能洩漏不該看見的文章數量。

回應格式完全保留：

```json
{
  "data": [],
  "meta": { "page": 2, "pageSize": 20, "total": 7 }
}
```

這表示篩選後有七筆，但第二頁沒有資料。total 不是這一頁的 data.length，也不是整張 Article 表的筆數。新增 q／sort／status 不會被 spread 進 meta。

Repository 的 findMany 與 count 使用相同 where，並沿用 RepeatableRead。這保證單次列表回應的資料與數量來自同一快照；不是讓瀏覽器接下來每一頁都使用同一快照。

### 排序必須打破平手

newest 是 createdAt DESC、id DESC；oldest 是兩欄 ASC。createdAt 可能相同，因此只排序時間並不足以決定每筆位置。

id 是不透明字串，這裡只是依資料庫排序打破平手，不能從 ID 推論建立順序。當多筆時間完全相同，測試仍要驗證各頁順序；不能只拿不同時間的資料測試排序。

### 固定排序不會固定正在變動的列表

```text
第一次 page 1：D、C
中間新增較新的 E
第二次 page 2：C、B
```

兩次請求各自正確，仍會重複 C。本章有真實 HTTP 測試重現這個結果。[PostgreSQL LIMIT／OFFSET 文件](https://www.postgresql.org/docs/17/queries-limit.html)

cursor／keyset pagination 可用最後一筆的排序鍵向後查詢，但仍需設計游標編碼、查詢範圍、可變資料與 total 語意。本章不暗中把頁碼 API 換成 cursor，也不承諾查詢結果永遠不變。

## 21.6 OpenAPI 要描述實際的 HTTP 契約

[openapi.ts](examples/21/src/openapi.ts)提供 OpenAPI 3.1.1 文件，涵蓋 17 個 path、30 個 operation。它是 JSON 契約，沒有 Swagger UI，也沒有新增 @nestjs/swagger 依賴。

[OpenAPI 3.1.1 規格](https://spec.openapis.org/oas/v3.1.1.html)定義 paths、parameters、requestBody、responses、components 與 security 等結構。本章選擇固定規格版本，不因文件網站有新版就升級工具或課程套件。

| 區塊 | 本章描述 |
|------|----------|
| paths | health、認證、公開／本人／admin 文章、寫入、匯出與文件自身 |
| parameters | path ID、列表 query、Origin 與條件性的登出 CSRF |
| requestBody | strict body、expectedVersion、PATCH 至少一欄、16 KiB 與 UTF-8 描述 |
| responses | data／meta、錯誤 envelope、Location、Set-Cookie、X-Request-ID |
| schemas | 文章、公開使用者、分頁、輸入與錯誤；不帶內部憑證欄位 |
| securitySchemes | 本機／HTTPS Session Cookie 與 X-CSRF-Token |

servers 使用同源 `/`，本機實際 origin 為 http://127.0.0.1:3021。info.version=21.0.0 是本章文件版本，不表示路徑多了 /v21，也不會自動執行版本協商。

### Cookie、CSRF 與 Origin 不能簡化成 Bearer Token

受保護寫入使用：

```yaml
security:
  - LocalSession: []
    CsrfToken: []
  - SecureSession: []
    CsrfToken: []
```

同一物件裡是 Cookie AND CSRF，不同物件是替代方案 OR。LocalSession 為 course_session，SecureSession 為 __Host-course_session；Origin 另外列為必填 header，要求精確符合 APP_ORIGIN。

註冊與登入也需要 Cookie＋CSRF，但可以是匿名 Session。GET／HEAD csrf 可能建立匿名 Cookie；HEAD 並不代表完全沒有副作用。

需要 Cookie 不代表一定要先登入：註冊／登入缺少有效的匿名或登入 Session，會在 CSRF 檢查回 403；通過 CSRF 後，登入帳密錯誤才是 401 INVALID_CREDENTIALS。重複 email 的 409 USER_ALREADY_EXISTS 則只屬於註冊。文件的 security、狀態碼與 description 必須分別表達這些條件。

登出是特例：缺少／過期／撤銷 Session 仍可 204，必須有正確 Origin；有效 Session 則另需 CSRF。文件對 logout 不宣告一律需要 Session，並以 header 描述這個條件，不能讓工具誤判匿名登出一定是 401。

文件描述 Cookie 不會讓瀏覽器 JavaScript 讀到 HttpOnly Cookie，也不會繞過 Cookie、同源或瀏覽器 header 限制。需用真實登入取得憑證，不能把範例 token 當成正式通行證。

### HEAD、204、錯誤與串流分開描述

- GET 的一般 JSON 有明確 schema；HEAD 移除所有 response content，只描述 header。
- logout 204 沒有 JSON body，不能寫成 data:null。
- 已知錯誤狀態與 default 錯誤沿用 `{ error: { code, message, details }, requestId }`。
- 文章建立 201 的 Location 指向 /api/me/articles/{id}，因草稿不公開。
- export 是 application/x-ndjson 的獨立教學檔，已送 header 後的失敗可能中斷連線，不能保證再回 JSON 錯誤。

狀態與版本優先序、admin 權限、CSRF 等跨欄位／資料規則不能只靠一個 string enum 表達，仍在 operation description 與 HTTP 測試裡確認。非法狀態代碼保留 INVALID_STATE。

## 21.7 文件如何提供與匯出？

[ApiDescriptionModule](examples/21/src/api-description.module.ts)只提供文件，沒有資料庫依賴：

```text
GET /api/openapi.json
  → 空 query schema → 回傳原始 OpenAPI 物件
HEAD /api/openapi.json
  → 相同 header，無 body
```

不使用一般文章 presenter，避免被包成 `{ data: document }`。未知 query 400、不支援的方法 405／Allow、詳細路徑尾斜線或錯誤大小寫 404，沿用 strict routing 與安全錯誤出口。

```bash
docker compose run --rm tools npm run openapi:export
```

先 build；匯出至 `.data/openapi.json`，不連資料庫、不含真實憑證。HTTP 與匯出使用同一份來源，驗收會比較完整內容。

將來可以把這份 artifact 接到文件 UI、client generator 或規格檢查工具。但本章不宣稱測過所有工具；工具產生的型別也不能取代執行期驗證、權限與相容性評估。

## 21.8 文件也要有可失敗的測試

只檢查 JSON.parse 成功，無法知道文件是否漏了一條路由、把私人端點寫成公開，或把 response 內部欄位列成可公開。

本章分三層驗證：

| 測試 | 保證範圍 |
|------|----------|
| 文件結構與 Controller metadata | method／path 一致、operationId 唯一、$ref 與 security scheme 可解析 |
| JSON Schema 子集對照 | 實際 response 的型別、必要欄位、白名單、陣列與界線 |
| 真實 HTTP／PostgreSQL | 角色、CSRF、搜尋正規化、header、錯誤優先序與交易結果 |

[openapi.test.ts](examples/21/test/openapi.test.ts)讀取正式 Controller metadata，比對文件中的 GET／POST／PATCH 及隱含 HEAD。@All 的 405 fallback 不當成業務 operation。

[openapi-contract.ts](examples/21/test/openapi-contract.ts)只實作本課使用的 JSON Schema 子集。它不是完整 OpenAPI／JSON Schema validator；測試也不等於所有第三方工具一定相容。特殊正規化與權限仍需獨立斷言。

為了確認測試會失敗，案例會故意加入 passwordHash、移除必要欄位、改錯 role 型別，以及只帶 expectedVersion 的空 PATCH；比對器必須拒絕。

[list-query.test.ts](examples/21/test/list-query.test.ts)則在真實 DB 上建立多作者與各種狀態，確認 data 與 total 都不洩漏，並將真實註冊／登入／文章／錯誤 response 對照文件。

```bash
docker compose run --rm tools npm test -- --testPathPatterns='openapi|list-query'
docker compose run --rm tools npm run test:baseline
```

新增 35 項：列表 25、文件 10；原 304 項保留，共 **27 套、339 項 Jest**。原兩份文章 HTTP 契約與第 20 章逐位元相同，32 項基準繼續通過；狀態稽核回滾、雙 pool 競爭與傳輸測試也繼續執行。

## 21.9 LIMIT 20 不代表只做 20 筆工作

pageSize 限制回傳大小，有助於記憶體與傳輸控制，但不同查詢仍可能做很多工作：

| 查詢 | 可能需要的工作 |
|------|----------------|
| 適合索引的第一頁 | 依序取得足夠候選資料後停止 |
| 深 offset | 找出並略過前面的資料，再回傳本頁 |
| 精確 count | 計算所有符合條件的資料，不能只算本頁 |
| title 子字串搜尋 | 過濾候選標題；一般排序 B-tree 不等於全文索引 |

本章不以縮小 pageSize 假裝解決所有成本，也不把 total 改成估算值或另做快取，因為那會改變契約。既有 statement_timeout、pool 與交易期限仍保留，但不是固定的 HTTP 效能保證。

### 既有索引能幫到哪裡？

既有兩個索引：

```text
(status, createdAt, id)
(authorId, createdAt, id)
```

公開列表固定 status，可能使用第一個索引取得排序結果；本人列表固定 authorId，可能使用第二個。B-tree 可以正向或反向掃描，兩欄同方向的 newest／oldest 不必直接各建一份索引。[PostgreSQL 索引與 ORDER BY](https://www.postgresql.org/docs/17/indexes-ordering.html)

本人再篩 status，可能還需要檢查候選列。ILIKE '%q%' 也可能掃很多標題。要不要新增 authorId＋status 的索引、trigram 或全文搜尋，應先看資料分布、讀寫比例與實際需求；本章不先替每種組合新增永久索引。

## 21.10 在隔離資料庫觀察 EXPLAIN

[check-query-plans.cjs](examples/21/scripts/check-query-plans.cjs)是可執行實驗：

```text
驗證 TEST_DATABASE_URL／course_test
  → 建立隨機 schema 並套 migration
  → 建立 100 個合成使用者、30000 篇文章
  → ANALYZE Article
  → 執行六組 EXPLAIN ANALYZE／BUFFERS
  → 匯出計畫 → finally 清理自有 schema
```

```bash
docker compose up -d --wait test-db
docker compose run --rm tools npm run lab:queries
```

先完成 npm test，因實驗重用編譯後 fixture。不要與會刪除 .test-dist 的 npm test 並行。實驗只在自有 schema 移除 status 索引作比較，不碰開發 public 或其他章的資料。

EXPLAIN 顯示預估計畫，ANALYZE 會實際執行查詢並提供觀測數據；BUFFERS 幫助觀察 buffer 使用。cost 不是毫秒，Actual Rows 也要配合節點、loops 與過濾筆數閱讀。[PostgreSQL 17 EXPLAIN 文件](https://www.postgresql.org/docs/17/using-explain.html)

結果保存在 `.data/query-plans.json`。本次 30000 筆、6000 筆 published 的觀測如下，實際計畫可能因資料與統計不同而改變：

| 實驗 | 本次下層計畫與觀察 |
|------|--------------------|
| indexed-first-page | Index Only Scan 取 20 筆 |
| indexed-deep-offset | Seq Scan 找 6000 筆，再排序，略過前 5000 筆 |
| exact-count | Seq Scan 找 6000 筆，Aggregate 回傳一個 count 結果 |
| substring-search | Bitmap Index Scan 先找 6000 個 published 候選，再過濾標題，留下 8 筆 |
| own-status | authorId 複合 Index Scan 取得 20 筆 |
| without-status-index | Seq Scan 加排序，取得第一頁 20 筆 |

indexed-deep-offset 的名稱表示索引仍存在，不表示 planner 一定選它。count 的 Actual Rows=1 是聚合輸出一列，不能解讀成只檢查一篇文章。

實驗只投影 id；Index Only Scan 仍可能需要 Heap Fetches。正式 API 要回八個欄位，還有交易、序列化、網路與不同負載，因此不能把這裡的毫秒數當成正式 API 延遲。

這裡不斷言「一定使用某索引」或「必須低於某毫秒」。我們要觀察計畫如何隨查詢與索引改變，而不是讓課程測試依賴一台機器的速度或強制關閉 Seq Scan。

## 21.11 相容性不是改完文件就結束

本章保留預設排序、分頁界線、response 欄位、total 語意與錯誤 envelope，新增明確的可選 query。原 `sort=title` 仍拒絕，沒有放寬成任意排序。

| 變更 | 需評估的影響 |
|------|--------------|
| 新增可選篩選，省略行為不變 | 新功能仍需驗證權限、count 與錯誤行為 |
| newest 改成 oldest | 未明確指定排序的 client 會改變結果 |
| version 改字串、Date 改格式 | 型別與 client 解析可能失敗 |
| total 改成本頁筆數／估算 | 前端頁碼與空頁判斷改變 |
| 新增必要欄位、收緊長度 | 原本合法請求可能被拒絕 |
| 回應新增欄位或 enum 值 | 嚴格 schema／完整列舉的 client 可能需要調整 |
| INVALID_STATE 直接改名 | 前端依 code 分支的邏輯可能失效 |

本課 response schema 明列白名單；額外內部欄位應讓測試失敗。實際產品要如何允許擴充欄位、棄用舊欄位與發布新版本，需要與 client 的容錯方式一起決定，不能宣稱所有新增都是相容。

## 21.12 Docker 完整操作與驗收

從倉庫根目錄開始：

```bash
cd nodejs-course/examples/21
docker compose build tools
docker compose up -d --wait postgres test-db
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm run db:deploy
docker compose run --rm tools npm run db:seed
docker compose run --rm tools npm run db:status
docker compose run --rm tools npm run seed
docker compose up -d api
docker compose run --rm tools npm run test:query-api
docker compose run --rm tools npm run test:status-api
```

API 為 http://127.0.0.1:3021，開發 PostgreSQL 主機 15421；test-db 不公開端口。三份 migration、示範帳號與原有寫入契約沿用，沒有新 migration。npm ci 的更新提示不應觸發版本升級。

check 順序為 generate → typecheck → Jest → build → test:runtime → 四個原 lab → lab:queries → openapi:export。必須等待完成後再做其他使用 .test-dist 的測試。

### 手動讀文件與查詢

以下從本章範例目錄執行，不需本機 Node：

```bash
curl -fsS http://127.0.0.1:3021/api/openapi.json -o /tmp/chapter-21-openapi.json
curl -I http://127.0.0.1:3021/api/openapi.json
curl -i 'http://127.0.0.1:3021/api/articles?page=1&pageSize=1&sort=oldest'
curl -G -i --data-urlencode 'q=Node' http://127.0.0.1:3021/api/articles
curl -G -i --data-urlencode 'q=%' http://127.0.0.1:3021/api/articles
curl -i 'http://127.0.0.1:3021/api/articles?status=draft'
curl -i 'http://127.0.0.1:3021/api/me/articles?status=draft'
```

最後兩項預期為 400、401；`q=%` 是找真正的百分號，不是回傳所有文章。文件下載內容應與 `.data/openapi.json` 相同。

私人 query 的 Cookie／CSRF 登入操作沿用[第 20 章手動流程](20-persistence-transactions-and-concurrency.md#209-用-docker-操作-api)，在本章目錄操作並將 origin 改為 http://127.0.0.1:3021。登入後讀 me 不需寫入 CSRF header，但寫入仍需要 Cookie＋Origin＋X-CSRF-Token。

### 真正登入三角色並重啟比對

test:query-api 新增六篇帶唯一搜尋前綴的驗收文章，確認公開兩筆 published、Alice／admin 各自的 draft、排序與分頁，並檢查三筆狀態稽核。test:status-api 另保留前章並行發佈 200／409、admin 封存與登出撤銷驗收。

```bash
docker compose restart postgres
docker compose up -d --wait postgres
docker compose restart api
docker compose run --rm tools npm run test:query-persistence
docker compose run --rm tools npm run test:status-persistence
```

先成功執行對應 API 驗收，再執行 persistence。proof 只保存搜尋前綴、文章與稽核，不保存憑證；比對時重新登入。每次 API 驗收會保留自己的文章並覆寫對應 proof，不刪掉前一次資料。

最後正常停止：

```bash
curl -f http://127.0.0.1:3021/api/articles/export -o /tmp/chapter-21-articles.ndjson
curl -I http://127.0.0.1:3021/api/articles/export
docker compose logs --tail 20 api
docker compose stop api postgres test-db
```

NDJSON 仍是獨立公開教學檔，不是查詢結果或資料庫備份。stop 保留資料 volume，關閉順序沿用 draining → http-drained → closed，不用 down -v 作一般收尾。

## 21.13 練習與完成檢查

### 練習一：找出洩漏資料的 total

公開列表正確回傳十篇 published，但 total 使用沒有 where 的 article.count。即使 data 沒有草稿，這個 API 有什麼問題？

<details>
<summary>參考答案</summary>

total 包含不可見資料，可能洩漏草稿／封存數量，也使分頁與實際結果不同步。資料與 count 必須共用固定可見範圍及搜尋條件，並在同一快照讀取。

</details>

### 練習二：讓文件測試真的失敗

在自己的練習副本把 me 列表的 status 參數從文件移除，或把 Cookie＋CSRF 拆成兩個 OR 物件。執行 openapi 測試，確認會失敗，再恢復正確內容。

接著替 HTTP 公開使用者結果加入額外 passwordHash，確認 schema 子集比對會拒絕。這不能取代正式 presenter，兩層都有測試價值。

### 練習三：觀察深 offset 與 count

執行 lab:queries，閱讀深 offset、count 與第一頁的子節點。列出各自掃描／輸出多少列、是否排序、是否使用索引。

驗收：不能只寫根節點 Limit 回傳 20 或 Aggregate 回傳 1；必須指出下層工作。再改練習副本的資料分布，觀察 planner 是否換計畫，不硬編碼預期毫秒數。

### 練習四：評估契約變更

產品希望將 total 改成 hasMore，並改用 cursor。先寫出既有 client 受到的影響，再提出保留舊介面或明確遷移的方式。這是設計練習，本章主線仍使用既有 page／pageSize／total。

### 完成檢查

- [ ] 能指出 DTO、Pipe、OpenAPI 各自的責任與保證範圍。
- [ ] 公開／本人／admin 的可見範圍不被新增 query 覆寫。
- [ ] 搜尋先於分頁，data／total 使用同一 where 與快照。
- [ ] 字面 wildcard、重複參數、Unicode 長度與排序平手已測試。
- [ ] 能解釋跨請求 offset 推移與精確 count 的成本。
- [ ] OpenAPI 與正式路由、HTTP／匯出內容一致。
- [ ] Cookie＋CSRF、Origin、HEAD、204、錯誤與 NDJSON 描述正確。
- [ ] 不把本課 schema 子集比對器當作完整標準 validator。
- [ ] 隔離 EXPLAIN、完整 check、API／重啟驗收及正常停止完成。

下一章：[22 — TestingModule、資料庫、HTTP 測試與資料隔離](22-testing-modules-database-and-http.md)，深化 Provider 替換、單元／整合／HTTP 測試與資料隔離。

---

[上一章：交易與併發](20-persistence-transactions-and-concurrency.md) · [返回課程總覽](README.md) · [本章範例](examples/21/README.md) · [本章契約](examples/21/BASELINE.md)
