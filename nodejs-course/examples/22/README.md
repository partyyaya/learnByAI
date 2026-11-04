# 第 22 章：TestingModule、資料庫與 HTTP 測試

保留第 21 章 API，讓 TestingModule 共用正式 HTTP 啟動流程，補上 fixture 所有權、初始化失敗清理、獨立 Cookie jar 與兩個 Jest worker 的實際隔離驗證。

[教材](../../22-testing-modules-database-and-http.md) · [本章契約](BASELINE.md)

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
docker compose run --rm tools npm run test:query-api
docker compose run --rm tools npm run test:status-api
```

API 主機 **3022**、開發 PostgreSQL **15422**；test-db 不公開端口。Compose 專案 nodejs-course-22 與 volume 獨立於前章。APP_ORIGIN 必須精確為 http://127.0.0.1:3022。

check 執行 32 套、368 項 Jest，以及 typecheck、build、程序驗證、四個原 lab、查詢實驗、OpenAPI 匯出，最後以兩個 worker 重跑 6 項並行案例。

沒有新套件或 migration。db:seed 補示範 DB 資料，seed 產生獨立 NDJSON；兩者不同。示範帳號沿用：

| 帳號 | 密碼 | 角色 |
|------|------|------|
| alice@example.test | Alice-course-18! | member，u_demo |
| bob@example.test | Bob-course-18!! | member，u_bob |
| admin@example.test | Admin-course-18! | admin，u_admin |

密碼中的 18 不變。seed CLI 需 DEMO_AUTH_SEED=1（Compose 已設定），不覆寫既有憑證、角色與文章，只供本機課程。

## 聚焦與並行測試

先完成 generate（完整 check 已包含），再執行：

```bash
docker compose run --rm tools npm run test:focused
docker compose run --rm tools npm run test:parallel
docker compose run --rm tools npm run test:baseline
```

- focused：新增 29 項，依序驗證 TestingModule、真實 HTTP、fixture 與並行案例本身。
- parallel：只跑 alpha／beta 兩份檔案，以兩個 worker 執行 6 項。等待兩個獨立 schema／app 同時建立後，才進行寫入，並驗證關閉及清理。
- baseline：原 32 項文章 HTTP 基準，先真正登入再驗證原有業務斷言。

`test:compile` 會刪除 .test-dist。test、focused、parallel 都會使用它，不能彼此並行，也不能與 test:runtime／lab:queries 並行。check 已按正確順序安排。

成功的並行紀錄在 `.data/parallel-proof.json`，包含兩個 PID、workerId、隨機 schema、port、closed 與 remainingSchemas:0，不含憑證。一般全量序列測試不產生這份 proof；它由專用 runner 驗證後寫入。

## 本章檔案與測試邊界

| 檔案 | 責任 |
|------|------|
| src/server.ts | 可選 applicationFactory；正式預設仍為 NestFactory，HTTP 設定與關閉流程共用 |
| test/testing-application.ts | compile 前覆寫 Provider，使用同一 root module／adapter／init 設定 |
| test/database-fixture.ts | 僅 course_test、UUID schema、非同步 migration、可重複 dispose |
| test/http-fixture.ts | 真 DB＋TestingModule＋loopback 隨機 port＋臨時匯出檔，統一清理 |
| test/testing-overrides.test.ts | 8 項替身／DI／HTTP 與 compile／init 邊界 |
| test/testing-http.test.ts | 7 項真實登入、權限、交易、重設及傳輸案例 |
| test/fixture-lifecycle.test.ts | 8 項 URL、重複清理、初始化失敗與獨立 fixture 案例 |
| test/parallel-http-cases.ts | alpha／beta 共用的三項真實 HTTP 案例與跨程序屏障 |
| jest.parallel.config.cjs／scripts/check-parallel.cjs | 限定兩份案例、驗證不同 worker 與清理、輸出 proof |

正式 source 不匯入 @nestjs/testing；applicationFactory 只由可信組裝程式傳入，不是 HTTP 或環境變數的驗證繞過開關。固定 test token 只存在明確的 AuthService 替身。

覆寫 readiness 的 200 不能證明 DB 可用；直接呼叫 Controller 不會執行 decorator 的 Guard／Pipe／presenter；替身呼叫紀錄不能證明回滾。這些界線分別有可失敗的測試。

httpFixture 的 reset 會清除自有 schema 裡的 Session，因此重設後必須重新登入。它只適合同一 fixture 無進行中工作時使用；不可共用給 test.concurrent 再彼此清表。

## 正式 API 與重啟驗收

```bash
curl -i http://127.0.0.1:3022/health/ready
curl -i 'http://127.0.0.1:3022/api/articles?pageSize=1&sort=oldest'
curl -fsS http://127.0.0.1:3022/api/openapi.json -o /tmp/chapter-22-openapi.json
curl -i http://127.0.0.1:3022/api/me/articles
docker compose restart postgres
docker compose up -d --wait postgres
docker compose restart api
docker compose run --rm tools npm run test:query-persistence
docker compose run --rm tools npm run test:status-persistence
```

私人未登入預期 401。其餘 API 與第 21 章相同；OpenAPI info.version 仍為 21.0.0，只調整本機 origin 範例。先成功執行 query-api／status-api，再用 persistence 比對保留資料；重啟驗收重新登入，不把舊憑證存入 proof。

## 固定版本與正常停止

Node 24.22.1、npm 11.19.1、TypeScript 5.9.3、Jest 30.2.0、Express 5.3.0、Zod 4.6.7、Supertest 7.3.1；Nest common／core／platform-express／testing 11.2.8、reflect-metadata 0.2.2、RxJS 7.8.2；Prisma CLI／Client／adapter-pg 7.10.1、pg 8.23.1、PostgreSQL 17。

lockfile 除專案名稱外與前章相同；CommonJS／NodeNext、decorators／metadata、Express 5.3.0／Multer 2.5.0 overrides 沿用。2026-11-02 npm ci audit 回報 19 個受影響套件節點（3 low、16 moderate，無 high／critical），未執行 audit fix --force 或版本升級。

```bash
curl -f http://127.0.0.1:3022/api/articles/export -o /tmp/chapter-22-articles.ndjson
curl -I http://127.0.0.1:3022/api/articles/export
docker compose logs --tail 20 api
docker compose stop api postgres test-db
```

NDJSON 仍是獨立公開教學檔，不是資料庫備份。正常停止為 draining → http-drained → closed；stop 保留資料 volume、文章、稽核與驗收 artifact，不用 down -v。

## 驗證紀錄（2026-11-02）

- 完整 check 通過：32 套、368 項 Jest，原 339 項保留，新增 29 項；typecheck、build、程序信號、四個原 lab、查詢實驗、OpenAPI 匯出與並行驗收全部通過。
- 本章新增 testing-overrides 8、testing-http 7、fixture-lifecycle 8、parallel alpha／beta 共 6 項。涵蓋真正 Guard／Pipe／presenter、獨立 Cookie jar、真交易 INSERT 後失敗回滾、Provider 初始化失敗、重複清理與 fixture 互不干擾。
- 專用並行重跑 6 項成功：worker 1／2，PID 2139／2140，port 37939／42115，兩份隨機 schema 同時建立後才執行案例。最後 server 均關閉、兩份 schema 已刪除，proof 保留於 .data/parallel-proof.json。
- 開發資料庫三份既有 migration deploy／seed／status 成功；正式 3022 API 的 query-api、status-api 均通過，包含三角色、列表／文件、並行發佈 200／409、admin 封存與正確狀態稽核。
- API／PostgreSQL 重啟後，query-persistence 與 status-persistence 均通過。教材主機 curl 指令已實際執行，ready／列表為 200、私人未登入為 401；OpenAPI 下載與匯出 JSON 一致。
- NDJSON 20000 筆、3857788 bytes，GET 與來源 SHA-256 一致；HEAD bytesRead=0，兩者皆 fileClosed=true。API 日誌未出現示範密碼、Cookie、CSRF、摘要欄位或連線字串。
- 測試、並行與查詢實驗的自有 test_／upgrade_ schema 殘留為 0。第 14–21 章共 705 個範例檔案摘要未變；原 HTTP 契約、業務核心、Prisma schema／migration 保留，lockfile 除專案名稱外相同。
- 教材、README、契約與導覽連結檢查通過；課程總覽進度已更新為 00–22 完成，前章下一章連結接上本章。
- API、postgres、test-db 均已正常停止，退出碼 0；最後關閉順序為 draining → http-drained → closed。資料 volume、文章、稽核、文件、查詢計畫、proof 與 NDJSON 保留；未執行 Git staging 或 commit。
