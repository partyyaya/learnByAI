# 第 20 章：Prisma Provider、連線生命週期、交易與併發

延續第 19 章，讓 publish／archive 的文章更新與狀態稽核在同一交易提交。稽核記錄實際 actor、前後狀態與版本；稽核失敗會回滾文章。既有 CRUD、Session、CSRF、回應投影與版本契約保留。

[教材](../../20-persistence-transactions-and-concurrency.md) · [本章契約](BASELINE.md)

同一 host 的 Cookie 不按 port 隔離；同時練習第 18–23 章時，請各用獨立 curl Cookie jar 或瀏覽器設定檔，避免同名 Session Cookie 覆蓋。詳見[Cookie 與章節端口](../../18-authentication-sessions-and-guards.md#4-cookie-裡放什麼資料庫裡放什麼)。

## 從乾淨環境開始

在本目錄執行：

```bash
docker compose build tools
docker compose up -d --wait postgres test-db
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm run db:deploy
docker compose run --rm tools npm run db:seed
docker compose run --rm tools npm run db:status
docker compose run --rm tools npm run seed
docker compose up -d api
docker compose run --rm tools npm run test:status-api
```

API 主機 **3020**，開發 PostgreSQL **15420**；容器內 postgres:5432/course。test-db:5432/course_test 不公開主機端口。Compose 專案 nodejs-course-20；volume 與前章分開。

check 順序為 generate → typecheck → Jest → build → test:runtime → lab:nest → lab:scopes → lab:validation → lab:responses。Jest 25 套、304 項。npm test 會清除 .test-dist，不能與 test:runtime 並行。修改 src 後重新 build，再重啟 api。

三份 migration 含原文章表、Session／User 認證擴充，以及 ArticleStatusAudit。db:deploy 不產生 client；check 的 generate 已完成此步。db:seed 只補示範 DB 資料；seed 產生獨立 NDJSON，兩者不同。

APP_ORIGIN 必須為精確 `http://127.0.0.1:3020`。示範帳號仍是：

| 帳號 | 密碼 | 角色 |
|------|------|------|
| alice@example.test | Alice-course-18! | member，u_demo |
| bob@example.test | Bob-course-18!! | member，u_bob |
| admin@example.test | Admin-course-18! | admin，u_admin |

密碼中的 18 不改成 20。seed CLI 需要 DEMO_AUTH_SEED=1（Compose 已設定），不覆寫既有憑證、角色與文章，只供本機課程。

## 執行與重啟驗收

```bash
curl -i http://127.0.0.1:3020/health/ready
curl -i http://127.0.0.1:3020/api/me/articles
docker compose run --rm tools npm run test:status-api
docker compose restart postgres
docker compose up -d --wait postgres
docker compose restart api
docker compose run --rm tools npm run test:status-persistence
```

前兩項預期 200、401。test:status-api 真正取得 CSRF、登入三角色，驗證 Location、Bob 被拒絕、兩個並行 publish 得 200／409、公開查詢、HEAD、admin 封存與兩筆稽核，再登出撤銷。Cookie／CSRF 只在記憶體保留，不印出。

腳本保留 `.data/status-api-proof.json`，只有文章與稽核，供重啟後逐欄比對；不保存憑證。每次執行會新增驗收文章並覆寫 proof，舊驗收文章保留。test:status-persistence 必須先有成功的 test:status-api；它重新登入 admin，驗證資料保存，不宣稱驗證原 Session 跨重啟。

手動登入及 curl 狀態操作見[教材](../../20-persistence-transactions-and-concurrency.md#209-用-docker-操作-api)。Cookie、Origin 與 X-CSRF-Token 仍都需要。

## 直接觀察稽核

```bash
docker compose exec -T postgres psql -U course -d course -c 'SELECT "articleId", "actorId", action, "fromStatus", "toStatus", "fromVersion", "toVersion" FROM "ArticleStatusAudit" ORDER BY "articleId", "toVersion";'
```

新環境 seed 後應為 0 筆；test:status-api 每次會多 publish／archive 各一筆。admin 的 actorId 是 u_admin，Article.authorId 仍為 u_demo。PATCH 不新增狀態稽核，稽核不是完整修訂歷史。

## 交易與 Provider

```text
Session／CSRF → DTO／Pipe → Service
  → 同一交易：讀文章 → 權限／版本／狀態／上限
    → 條件 UPDATE → 讀回 → INSERT 狀態稽核
    → COMMIT 後回傳
  → 任一步驟失敗：ROLLBACK → 安全錯誤出口
```

| 檔案 | 責任 |
|------|------|
| src/database.ts | PrismaClient＋pg adapter，pool max 5 |
| src/database.module.ts | 共用 DATABASE async Provider、readiness 包含稽核表 |
| src/application.ts／src/main.ts | 關閉所有權、監聽前必要 migration 檢查 |
| src/article-service.ts | 既有業務規則、同一 tx 更新並追加稽核 |
| src/article-repository.ts | ArticleTransaction 的 appendStatusAudit 契約 |
| src/prisma-article-repository.ts | ReadCommitted、條件 UPDATE、交易內 INSERT |
| prisma/schema.prisma | 稽核 enum、關聯與唯一鍵 |
| prisma/migrations/202611020001_article_status_audit/migration.sql | 新表、CHECK、Restrict 外鍵，不回填歷史 |
| test/status-transactions.test.ts | 19 項真實交易／HTTP／併發案例 |
| test/status-migration.test.ts | 舊 schema 升級、資料保留與 SQL CHECK |
| scripts/check-status-api.cjs | 執行中 Compose API 與 DB 的實際驗收 |

每應用一個 client，Article／Auth／Health 共用；不每請求 connect／disconnect。保留 application 的單一關閉責任，不再加 Nest shutdown hook。

交易 options 為 ReadCommitted、maxWait 2000 ms、timeout 5000 ms；pg 的 connectionTimeoutMillis 2000、statement_timeout 5000、max 5 沿用。列表仍為 RepeatableRead。沒有自動重試、分散式鎖或新的 timeout Interceptor。

## 測試與故障演練

```bash
docker compose run --rm tools npm test -- --testPathPatterns=status-
docker compose run --rm tools npm run test:baseline
docker compose run --rm tools npm run check
```

完整 304 項包含原 283 項；新增 Service 1、交易／HTTP 19、migration 1。兩份文章 HTTP 契約與第 19 章逐位元相同，32 項基準保留。

- 真實外鍵／故障觸發器讓 INSERT 失敗，確認 status、version、updatedAt 回滾，沒有稽核。
- callback 在完成兩次寫入後拋錯，兩張表都不留下資料。
- 真正登入 admin，確認操作者；未登入、CSRF、越權、舊版本、非法狀態及版本上限不新增稽核。
- 兩個 pool 都完成 SELECT 後才解除測試屏障，驗證 publish／publish、publish／archive、PATCH／publish 只有一個勝出。
- 舊 schema 升級保留 User／Session／Article；CHECK、唯一鍵、Restrict 外鍵由 PostgreSQL 驗證。
- 缺稽核表時 live 可用、ready 503；程序在 listen 前拒絕啟動。tx 逃出 callback 後無法使用。

資料庫測試只接受 TEST_DATABASE_URL／course_test，每套使用自有隨機 schema，清理不碰開發 public。觸發器與等待屏障只存在測試中，正式 API 沒有故障端點。

## 固定版本與 audit

Node 24.22.1、npm 11.19.1、TypeScript 5.9.3、Jest 30.2.0、Express 5.3.0、Zod 4.6.7、Supertest 7.3.1；Nest common／core／platform-express／testing 11.2.8、reflect-metadata 0.2.2、RxJS 7.8.2；Prisma CLI／Client／adapter-pg 7.10.1、pg 8.23.1、PostgreSQL 17。

沒有新增套件，lockfile 只更改專案名稱，套件節點與前章相同；CommonJS／NodeNext、decorators／metadata 及 Express 5.3.0／Multer 2.5.0 overrides 保留。2026-11-02 npm ci 的 audit 回報 19 個受影響套件節點（3 low、16 moderate，無 high／critical），沿用前章開發依賴鏈；未執行 audit fix --force 或版本升級。

## 匯出與正常停止

```bash
curl -f http://127.0.0.1:3020/api/articles/export -o /tmp/chapter-20-articles.ndjson
curl -I http://127.0.0.1:3020/api/articles/export
docker compose logs --tail 20 api
docker compose stop api postgres test-db
```

NDJSON 是獨立教學檔，不是資料庫文章或稽核備份。stop 保留 volume 與驗收資料，不使用 down -v 作一般收尾。

## 驗證紀錄（2026-11-02）

- 完整 npm run check 通過：25 套、304 項 Jest，包含原 283 項及新增 21 項；typecheck、build、程序驗證與四個 lab 全部通過。
- 新增案例以真實 PostgreSQL 驗證 INSERT 故障與 callback 後段失敗回滾、admin actor、拒絕不新增稽核、三組雙 pool 版本競爭、約束與舊 schema 升級。原 32 項 HTTP 基準保留。
- 開發資料庫三份 migration deploy／status 成功；seed 後不補造歷史。Prisma migrate diff 比對實際資料庫與 schema，回報 No difference detected。
- test:status-api 通過：三角色、Location、公開資料範圍、HEAD、並行發佈 200／409、admin 封存、兩筆正確稽核、登出撤銷。API 與 PostgreSQL 重啟後，test:status-persistence 比對文章與稽核逐欄位相同。
- 從教材擷取手動 curl 指令實際執行，登入、建立、發佈、封存、登出成功；主機 3020 readiness 為 200。驗收文章、稽核與非憑證 proof 保留。
- NDJSON 20000 筆、3857788 bytes；GET 與來源 SHA-256 相同，HEAD bytesRead=0，兩者皆 fileClosed=true。日誌未出現示範密碼、Cookie、CSRF、摘要欄位或連線字串。
- 測試資料庫自有 test_／upgrade_ schema 殘留為 0。第 14–19 章共 481 個範例檔案摘要未變；兩份 HTTP 契約、認證核心、request-work、shutdown、application 與第 19 章相同。lockfile 除專案名稱外相同。
- 課程總覽、前章下一章連結與本章教材已更新；本機檔案連結檢查通過。
- API、開發 PostgreSQL、test-db 均已停止，退出碼 0；API 最後為 draining → http-drained → closed。volume、文章、稽核與教學匯出檔保留，未執行 Git staging 或 commit。
