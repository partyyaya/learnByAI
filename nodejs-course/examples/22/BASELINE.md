# TestingModule、資料庫與 HTTP 測試：第 22 章契約

本章承接[第 21 章契約](../21/BASELINE.md)，深化測試組裝、fixture 所有權、失敗清理與跨 worker 隔離。沒有新增業務端點、套件、migration 或權限規則；文章、Session、CSRF、狀態稽核、列表、OpenAPI、NDJSON 與傳輸契約保留。

## 1. 正式與測試共用啟動流程

server.ts 新增可選 applicationFactory 組裝參數。正式入口不傳入它，仍使用 NestFactory.create；測試透過 TestingModule 建立相同 AppModule 與 ContractExpressAdapter。

query parser、strict routing、原始 HTTP server、requestContext、bodyParser:false、Nest init、工作追蹤、Filter／Interceptor 與關閉順序仍由同一 createArticleServer 管理。沒有測試專用路由或 HTTP header 開關，production source 不匯入 @nestjs/testing。

test/testing-application.ts 在 compile 前執行 overrideProvider，取得 context 後交由正式流程 init；不另外關閉 context，避免早於進行中請求關 pool。application 繼續擁有 database 的 disconnect 責任，包含建立失敗。

## 2. 替身的保證範圍

- testing-overrides 使用明確的 DATABASE、Repository、AuthService、readiness 替身，保留真正 Controller／Service／Guard／Pipe／presenter／Filter。
- DATABASE 替換可跳過原 async factory；只替換 Repository 不會移除 DATABASE 初始化。
- 覆寫 readiness 的 200 不證明 PostgreSQL 可用；固定 test token 只由 test/ 中 AuthService 替身接受。
- 直接呼叫 Controller method 不執行 decorator 的 Guard、Pipe 或 presenter，不能作 HTTP 驗收。
- Repository 替身不假裝保證交易與回滾；資料一致性仍需真實 PostgreSQL 案例。
- Nest TestingModule overrideProvider(...).useFactory 使用 factory 欄位，與正式 Provider 的 useFactory 欄位不同。

## 3. fixture 與資源所有權

database-fixture.ts 只接受 PostgreSQL protocol 與精確 /course_test，不回退 DATABASE_URL。每次產生自有 UUID schema，移除輸入 schema 參數後再指定新名稱；不是依 worker 編號重用固定 schema。

Prisma migrate deploy 改為非同步 execFile 並等待，deploy() 現在必須 await。更新本快照的兩個既有呼叫處；migration 本身沒有變更。dispose 回傳同一個 Promise，可重複／同時呼叫；只 DROP 自有 schema 並關閉管理 pool。

httpFixture 每次擁有獨立 schema、真實 database、TestingModule、綁定 127.0.0.1:0 的 server 與暫存 NDJSON 目錄。它預先 seed，並提供 reset；reset 清理 Session → 稽核 → 文章 → User，再 seed，只能在該 fixture 沒有進行中請求時使用。

清理順序：應用排空／Nest 關閉／disconnect → DROP 自有 schema → 刪自有暫存目錄。後續清理步驟仍會嘗試，錯誤用 AggregateError 報告。初始化失敗時也清理；已交給 application 的 database 不由 fixture 再次 disconnect。

這些保證涵蓋程式能執行清理的路徑，不代表 SIGKILL、Docker 引擎中止或主機當機後 finally 必定執行。資料庫名稱檢查是本機防誤用機制，不是識別正式環境或資料庫權限的安全邊界。

## 4. 真實登入與失敗驗證

loginSession 使用各自的 Supertest agent Cookie jar，真正執行 csrf → login；writeHeaders 提供 Origin 與登入後 CSRF。Alice／Bob 不共用可變的全域身分；CSRF 不能跨 Session 借用。

真實 TestingModule 案例驗證 owner／admin 邊界、跨作者 me 404、越權 403 且資料不變、admin 的 me 仍本人、reset 撤銷舊 Session，以及兩個 app／pool 共用 schema 的並行發佈 200／409。

故障注入只替換 Repository 的 append 步驟：先執行真正 tx INSERT，再拋錯。確認 HTTP 安全 500、status／version／updatedAt 與稽核一起回滾；移除單次故障後相同版本可成功。這不是用 mockRejectedValue 取代資料庫回滾證據。

原第 20 章雙 pool SELECT 屏障與真實 SQL 故障測試保留。新 HTTP Promise.all 案例不宣稱能保證兩邊都先 SELECT；這與舊章受控交錯各有範圍。

## 5. 真正的 worker 隔離

parallel-alpha／parallel-beta 各使用同一組三項 HTTP 案例：相同 a_draft ID 各自修改／發佈、Bob 越權拒絕、自有 schema 的 SQL INSERT 故障回滾。

一般 npm test 依序執行所有案例；test:parallel 則重新編譯後，以獨立 Jest config、maxWorkers=2、no-cache 只執行這兩份檔案。runner 清空子程序 DATABASE_URL，仍要求 TEST_DATABASE_URL。

各 worker 在自有 schema／app 建立後寫入非憑證 ready 紀錄，等待另一個 worker 到達，有 15 秒期限。確認兩個 app／schema 同時存在後才執行案例；runner 最後確認不同 PID、workerId、schema、port、server 已關閉與兩份 schema 已刪除。

proof 保存於 .data/parallel-proof.json，不含 Cookie、CSRF、密碼或連線字串。它證明本課兩份案例跨 worker 隔離，不宣稱任意擴大 worker 數或整個測試集都已驗證並行；每程序的 pool／KDF 資源限制仍會隨 worker 數累加。

## 6. 測試數與執行順序

完整 Jest 32 套、368 項；原 339 項保留，新增 29 項：testing-overrides 8、testing-http 7、fixture-lifecycle 8、parallel alpha／beta 合計 6。

test:parallel 另以兩個 worker 重跑上述 6 項，不把重跑計成新增測試。api-contract.ts／migration-contract.ts 與第 21 章逐位元相同，32 項基準保留。

check：generate → typecheck → Jest 全量序列 → build → test:runtime → 四個原 lab → lab:queries → openapi:export → test:parallel。test、test:parallel、test:focused 都會清除／重建 .test-dist，不能與程序、查詢實驗或彼此並行。

沒有以 forceExit、detectOpenHandles 常態執行、提高通用 timeout、retry 或降低 scrypt 成本讓測試通過；使用專用 fixture、隨機 port、正確等待與清理。

## 7. Docker 與既有 API

Compose nodejs-course-22，API 3022、開發 PostgreSQL 15422，APP_ORIGIN=http://127.0.0.1:3022；test-db 不公開主機端口。示範帳號密碼仍含 18，seed 不覆寫原資料。

版本及 lockfile 套件節點與第 21 章相同；CommonJS／NodeNext、decorators／metadata、Express 5.3.0／Multer 2.5.0 overrides 不變。Prisma schema 與三份 migration 不變。

OpenAPI 仍 17 paths／30 operations，info.version 保留 21.0.0，因本章不改業務契約；只調整本機 origin 範例為 3022。既有 test:query-api／test:status-api 與兩份重啟驗收保留。

NDJSON 為獨立公開教學檔，不是資料庫備份。正常停止保留 volume、驗收文章、稽核與 proof，不用 down -v；不執行 Git staging／commit。
