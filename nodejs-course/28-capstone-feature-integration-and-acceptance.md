# 28 — 專題功能整合：留言、管理端與完整驗收

> 從需求到資料庫、HTTP、畫面與測試，完成一個可以沿著請求追蹤的功能切片。

承接[第 27 章](27-frontend-integration-and-bff-boundaries.md)，本章提供[獨立快照](examples/28/README.md)。文章、登入、版本衝突、狀態稽核與部署流程繼續沿用，新增留言及管理員稽核查詢，完成主線的業務功能。下一章再做故障、備份與還原演練。

完成後你應能：

- 將留言需求拆成公開讀取、登入寫入、本人刪除與管理員處理。
- 用交易與 row lock 協調「新增留言」和「封存文章」。
- 以增量 migration 升級舊資料庫，保留使用者、文章及 Session。
- 將畫面、API、OpenAPI、SQL 約束與測試逐一對照。
- 用成功與失敗路徑驗收整個專題，而不只確認首頁能打開。

## 28.1 先固定功能規則

| 操作 | 身分／資料條件 | 成功 | 重要失敗 |
|------|----------------|------|----------|
| 列出留言 | 訪客也可；文章必須 published | 200，data＋meta | 不存在、draft、archived 都 404 |
| 新增留言 | 登入＋CSRF；文章必須 published | 201，data | 未登入 401、CSRF 403、輸入 400、文章不可公開 404 |
| 刪除留言 | 留言作者或 admin；登入＋CSRF | 204，沒有 body | 不存在 404、他人留言 403 |
| 查看文章狀態稽核 | admin；文章可以是任意狀態 | 200，data＋meta | 未登入 401、非 admin 403、文章不存在 404 |

文章作者沒有額外刪除別人留言的權限；需要處理違規內容時由 admin 執行。文章封存後不公開留言，也不接受新留言，但留言作者／admin 仍可依已知留言 ID 刪除。這個決定讓刪除權不依賴文章的公開狀態。

留言只提供建立、列表與永久刪除，沒有編輯、回覆串、按讚或審核狀態。刪除留言不新增 ArticleStatusAudit；該表仍只記錄文章 publish／archive。建立留言不修改文章 version／updatedAt，也不假造文章狀態歷史。

## 28.2 啟動自己的快照

尚未準備工具，先完成[00 的 nvm／Node](00-course-map-and-project-contract.md#004-用-nvm-安裝-node-並執行第一個練習)與[01 的 Docker](01-runtime-tooling-and-project-setup.md)。從倉庫根目錄執行：

```bash
cd nodejs-course/examples/28
nvm install
nvm use
docker compose build tools browser-tests
docker compose up -d --wait postgres test-db
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm browser-tests npm run test:browser
docker compose run --rm tools npm run db:deploy
docker compose run --rm tools npm run db:seed
docker compose run --rm tools npm run seed
docker compose up -d api
```

開啟 http://127.0.0.1:3028。API／PG 為 3028／15428；external-lab／upstream／performance-lab 為 3128／3228／3328，CORS lab 為 4028。每章有獨立 Compose 專案及 volume。測試使用自己的隨機 schema，不清理開發資料；同目錄的 check、browser、test:parallel 必須依序執行。

示範帳號仍為 Alice／Bob／admin，密碼中的 18 不變：

| Email | 密碼 | 角色 |
|-------|------|------|
| alice@example.test | Alice-course-18! | member |
| bob@example.test | Bob-course-18!! | member |
| admin@example.test | Admin-course-18! | admin |

seed 不覆寫既有密碼、角色或文章；若已有自己的資料，畫面結果應以目前 DB 為準。Cookie 不按 port 隔離，不同章／不同測試身分請使用獨立瀏覽器設定檔或 Cookie jar。

## 28.3 從 migration 建立資料保護

[第四份 migration](examples/28/prisma/migrations/202611030001_comments/migration.sql)新增 Comment，前三份歷史檔不改寫：

```text
User 1 → N Comment N → 1 Article
Comment：id、articleId、authorId、content、createdAt
索引：(articleId, createdAt, id)
```

articleId／authorId 外鍵採 Restrict，資料庫不接受不存在的文章或使用者。CHECK 以 char_length 限制 1–1000 字元；HTTP 邊界另外負責 trim、NUL、型別及未知欄位。PostgreSQL 的文字長度與本課 JavaScript 的 Unicode code points 規則對齊，不能直接拿 JS string.length 當成使用者字元數。

這份 migration 只新增表與關聯，不回填假留言，不清空任何既有表。既有部署的升級順序仍是「備妥可還原的備份 → 獨立 migration 成功 → 新映像」。本章的測試在自有 schema 模擬第 27 章資料庫後升級，確認使用者、文章、登入 Session 與 migration 歷史保留；測試內刪除空 Comment 表的安排只用於建構舊版 fixture，不是部署降版指令。

啟動檢查與 /health/ready 現在也查 Comment；缺表時 ready=503，live 仍 200，對外不透露 SQL 或表名。

## 28.4 用模組連接 HTTP 與資料庫

沿著 [comments.module.ts](examples/28/src/comments.module.ts)與[comment-store.ts](examples/28/src/comment-store.ts)閱讀：

```text
HTTP JSON／路由／參數
  → SessionGuard／CsrfGuard 或 AdminGuard
  → Zod Pipe 驗證
  → CommentStore 的資料條件與交易
  → Prisma／PostgreSQL
  → 明列欄位的回應
```

CommentsCoreModule 從 DatabaseModule 取得 DATABASE，建立 CommentStore。CommentsModule 接入共用 Runtime／Auth 模組，不另建全域 PrismaClient，也不複製認證系統。正式入口與 HTTP fixture 使用同一個 application factory，測試替身仍可省略這個可選功能組裝。

新增留言只接受：

```json
{"content":"這篇文章很有幫助"}
```

content 經 trim 後須為 1–1000 code points，禁止 NUL；authorId、role、articleId 等額外 body 欄位全部拒絕。articleId 取路由，authorId 取已驗證 actor。POST 仍有共用 16 KiB、媒體型別、UTF-8 與讀取期限限制；DELETE 不接受 body。

回應只包含留言 id、articleId、authorId、content、createdAt，不 JOIN 出使用者 email／passwordHash／Session。留言作者 ID 是此公開契約的一部分，角色與私密欄位不是。

## 28.5 「先查 published 再 INSERT」還不夠

若查詢與 INSERT 分開執行，可能發生：

```text
新增留言查到 published
  → 另一個交易封存並提交
  → 第一個請求仍 INSERT，形成封存後才新增的留言
```

本章在 ReadCommitted 交易內，先 SELECT Article ... FOR UPDATE，取得該文章的 row lock；在鎖內重新確認 published，再 INSERT。封存使用的條件 UPDATE 也會取得同一列的鎖，因此兩個操作會依取得鎖的順序完成。若封存先提交，等待中的留言讀到 archived，回 404；若留言先完成，封存等它提交後再繼續。row lock 的衝突與等待規則可對照 [PostgreSQL 17 官方說明](https://www.postgresql.org/docs/17/explicit-locking.html#LOCKING-ROWS)。

動態 SQL identifier 只來自 createDatabase 已驗證的 schema metadata，文章 ID 仍是參數，不把 HTTP 輸入交給 Prisma.raw。使用 schema-qualified table 才能讓測試隔離與正式 public schema 都正確運作。

[test/comments.test.ts](examples/28/test/comments.test.ts)用兩個真正 pool，先讓 archive 持鎖，再由另一個連線建立留言；觀察 pg_stat_activity 的 Lock 等待後才釋放交易，確認 404 且沒有留下資料。這比依賴某個幾毫秒的時間差更能驗證競爭條件。

等待鎖不是無限等待。本課固定Prisma7.10.1，生成Client的transactionOptions預設maxWait=2000ms、timeout=5000ms；adapter另有connectionTimeoutMillis=2000與statement_timeout=5000。這些是不同階段的限制，不可簡單相加成精確的HTTP期限；最新major的官方API也不能直接套進此快照。只有在期限內成功取得鎖後，才依最新狀態決定404或INSERT。超時屬於安全失敗，不能保證所有鎖競爭都回404，也不能在結果未明時自動重試。

鎖內沒有外部 HTTP 或密碼運算；交易失敗不自動重試，也不把取消等待宣稱為 SQL 已取消。大量熱門文章留言可能競爭同一列，這是此簡單一致性方案的成本，應先量測再調整。

## 28.6 列表與刪除有各自的一致性條件

留言列表只接受 page／pageSize，預設與上下限沿用共用分頁規則，不接受 q／status／authorId。同一 RepeatableRead 交易先確認文章 published，再以同一 articleId 篩選 findMany／count，依 createdAt、id 升冪排列。單次回應的 data／total 屬於同一 snapshot；跨請求的 offset 仍可能因新增或刪除而移動。

DELETE 先判斷留言存在，再判斷 actor 是留言作者或 admin，最後 deleteMany 帶 id＋原 authorId，確認 affected rows=1。兩個刪除競爭時，一個得到 204，另一個得到 404；不把「查詢時存在」誤認為已成功刪除。留言沒有修改作者的端點，authorId 條件也不由 body 決定。

## 28.7 管理端讀取真實狀態稽核

GET /api/admin/articles/:id/status-audits 需要 SessionGuard＋AdminGuard；本人文章作者也不能藉此讀取。查詢使用 page／pageSize，RepeatableRead 中確認文章存在、查明列欄位與 total，依 toVersion 升冪排列。

回應包含 actorId、action、fromStatus／toStatus、fromVersion／toVersion、createdAt 等既有稽核欄位。admin 代作者發佈時 actorId 是 admin，不是 article.authorId。create／edit／留言不新增這份歷史，舊文章缺歷史也不補造事件。

這是管理員查詢介面，沒有提供改寫或刪除稽核的 API；資料庫共用課程角色仍有高權限，因此不宣稱具備防管理員竄改的合規稽核能力。

## 28.8 在畫面走完整流程

[web/app.js](examples/28/web/app.js)沿用同源 Cookie、記憶體 CSRF、載入／錯誤訊息與 textContent，增加留言區及 admin 稽核區：

1. Alice 登入、建立草稿、發佈；在公開列表按「閱讀留言」。
2. 用另一個獨立設定檔登入 Bob，在該文章新增留言。輸入 `<img src=x onerror=alert(1)>` 應顯示文字。
3. Alice 可以看到 Bob 留言，但不能刪除；直接發 DELETE 仍須由 API 拒絕。
4. Bob 可刪自己的留言，admin 可刪任意留言；刪除成功處理 204，不解析 JSON。
5. admin 在管理區輸入文章 ID，讀取 publish／archive 稽核。member 沒有管理按鈕，API 也獨立回 403。
6. 文章封存後，公開留言讀取／新增都 404；已知 ID 的刪除規則繼續適用。

留言寫入綁定送出時的文章與輸入generation：等待A的DELETE時切到B，A的完成結果不能把留言區切回A；等待POST時輸入的新草稿也不能被清空。若DELETE／POST已成功，但重新讀取列表失敗，訊息會明確保留「寫入已成功」並要求重新載入，不將它誤報成寫入失敗而引導重送。切換文章載入失敗會清除舊列表，避免標題與內容混用。

管理稽核在身分改變／登出時清空；每次讀取帶generation，身分改變後的晚到結果不能重新填回私人資料。真Chromium也驗證admin讀取與登出清除。

畫面只載入目前一頁，沒有聲稱一次列出全部資料；需要下一頁時可用 API 分頁，或作為練習補上 UI。認證仍每請求查 DB 目前角色，不能因畫面顯示 admin 就放行。

## 28.9 API 文件與可重現驗收

本章 OpenAPI 3.1.1 更新為 info.version=28.0.0，共 **21 paths／38 operations**；相較前章新增：

| Path | Operations |
|------|------------|
| /api/articles/{id}/comments | GET、HEAD、POST |
| /api/comments/{id} | DELETE |
| /api/admin/articles/{id}/status-audits | GET、HEAD |

```bash
curl -i 'http://127.0.0.1:3028/api/articles/a_1/comments?pageSize=1'
curl -I http://127.0.0.1:3028/api/articles/a_1/comments
curl -i http://127.0.0.1:3028/api/articles/a_draft/comments
curl -i http://127.0.0.1:3028/api/admin/articles/a_1/status-audits
docker compose run --rm tools npm run openapi:export
```

乾淨 seed 下依序為 200／200／404／401；a_1 若已封存則第一組也回 404。登入寫入可使用工作台，完整 Cookie jar／CSRF HTTP 寫法見[第 18 章](18-authentication-sessions-and-guards.md)；不要把登入密碼直接放 URL。

| 驗收責任 | 可執行證據 |
|----------|------------|
| 舊文章／授權／版本／稽核契約 | 原有 HTTP、auth、status-transactions、list-query 測試 |
| 留言輸入、公開範圍、owner／admin、並行刪除 | test/comments.test.ts |
| row lock、SQL CHECK／FK、失敗回滾、readiness | test/comments.test.ts，真 PostgreSQL |
| 第 27 章資料升級保留 | test/comments-migration.test.ts |
| Controller metadata／回應與文件一致 | test/openapi.test.ts、HTTP schema 斷言 |
| 真瀏覽器登入／reload／衝突／XSS／留言新增刪除 | scripts/check-browser.cjs |
| TLS、Secure Cookie、CSRF、重啟後文章／留言／Session | scripts/check-production.cjs，獨立 production 專案 |

```bash
sh ci/check.sh
```

本章完整 check 為 **44 套／540 項 Jest**（前章 524＋留言／升級 16），雙 worker 另 6 項；原生 client、程序實驗、Chromium 與部署驗收另計。CI 依序執行並正常停止服務，保留 volumes 與 .data 的證據。Actions 範本在 ci/workflow.yml，尚未替讀者啟用遠端 workflow。

正式入口仍為 https://localhost:34428，HTTP 30828；runtime 不帶 Chromium／Prisma CLI／seed，API／PG 不公開 port。TLS、secret、資源限制與高權限課程 DB 角色的本機演練限制沿用[第 26 章](26-build-docker-ci-and-deployment.md)，不能直接當作完整公開站台部署。

## 28.10 練習與階段驗收

### 練習一：封存與留言誰先完成？

把「查詢 published → INSERT」拆成兩次非交易呼叫，可能多留下哪一筆資料？若使用同一列的 row lock，留言先持鎖是否一定要失敗？

<details>
<summary>參考答案</summary>

封存提交後仍可能新增留言。row lock 讓兩個交易排定順序；留言先持鎖且當時 published 時可以成功，之後文章封存會隱藏公開留言。規則不是所有同時發生的留言一律失敗，而是不能在已觀察到封存的新順序下繼續新增。

</details>

### 練習二：文章作者能否刪除留言？

Alice 的文章有 Bob 留言。Alice 是 member，為什麼 UI 藏按鈕還不夠？如果新增作者審核能力，至少要同步改哪些檔案？

<details>
<summary>參考答案</summary>

HTTP 可以繞過畫面，後端必須拒絕。改規則前先定義需求，再同步 Store 授權、HTTP／併發測試、OpenAPI 說明、UI 與 BASELINE；不能只改 button visibility。

</details>

### 練習三：count 相同就代表沒有越權？

為兩篇文章各建立一筆留言，用 pageSize=1 查其中一篇，驗證 data／total 都只包含指定文章；再加入未知 authorId query，應得到 400 而不是默默接受。

### 練習四：補上畫面分頁

為留言區加入上一頁／下一頁，沿用取消與 generation，切換文章或登出後清空舊結果。驗收快速切換不顯示前一篇留言，並且不把 total 當成「一定還有不變的下一頁」。

完成時應能以不同身分走完文章建立 → 發佈 → 留言 → 越權拒絕 → 刪除 → 封存 → 管理稽核，並指出每個結果的 HTTP 測試、資料庫條件與畫面狀態。

```bash
docker compose stop cors-lab api performance-lab external-lab upstream postgres test-db
docker compose -f compose.production.yaml stop proxy api postgres
```

保留 volume、文章、Session、留言、稽核與 proof，不用 down -v。下一章用同一份功能，驗證服務出故障時如何診斷與恢復。

---

[上一章：前端與 BFF](27-frontend-integration-and-bff-boundaries.md) · [下一章：故障與維運](29-capstone-failure-drills-and-operations.md) · [課程總覽](README.md) · [本章範例](examples/28/README.md) · [本章契約](examples/28/BASELINE.md)
