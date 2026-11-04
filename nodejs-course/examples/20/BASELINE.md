# Prisma Provider、交易與併發：第 20 章契約

本章以[第 19 章契約](../19/BASELINE.md)為 HTTP、認證、回應及傳輸基準，只擴充 publish／archive 的持久化保證，以及必要資料表的 readiness／啟動檢查。沒有新增業務端點，沒有重新實作 CRUD。

## 1. 狀態與稽核原子提交

每次成功的 publish／archive 恰有一筆 ArticleStatusAudit。文章的 status、version、updatedAt 與稽核在同一個 Prisma interactive transaction 提交；任一步驟或 commit 失敗都不得回成功。INSERT 失敗時，文章更新回滾。

| 操作 | 前置狀態 | 結果 | 稽核 |
|------|----------|------|------|
| create | 無 | draft，version 1 | 無 |
| PATCH | draft／published | 保持狀態，version + 1 | 無 |
| publish | draft | published，version + 1 | publish 一筆 |
| archive | draft／published | archived，version + 1 | archive 一筆 |
| 任意變更 | archived | 409 INVALID_STATE | 無 |
| 重複 publish | published | 409 INVALID_STATE | 無 |

仍要求登入 actor；不存在 404 → 無權限 403 → 版本 409 → 狀態 409 → 版本上限 409 → 條件 UPDATE。上限 2147483647。UPDATE 條件為 id＋authorId＋version＋status，未匹配回 VERSION_CONFLICT；沒有重試舊版本更新。

稽核只記錄本章啟用後的狀態變更，不補造舊紀錄，不是完整文章修訂歷史。seed 與 migration 不替既有 published 文章新增虛構紀錄；PATCH 造成的稽核版本間隔合法。

## 2. 稽核資料

欄位固定為 id、articleId、actorId、action、fromStatus、toStatus、fromVersion、toVersion、createdAt。id 由 Service 以 UUID 產生，createdAt 由資料庫產生，不是精確 commit 時間或全域排序序號。

- actorId 是經驗證的實際操作者；admin 操作時記 admin，不更改 Article.authorId。
- action 只有 publish／archive。前後狀態與版本由交易內讀取及更新結果產生，外部輸入不可指定。
- 不複製正文、email、密碼、Cookie、Session token、CSRF 或摘要。
- articleId／actorId 外鍵採 Restrict；UNIQUE(articleId, toVersion) 限制同一文章目標版本只有一筆。
- SQL CHECK 保證 fromVersion > 0、toVersion = fromVersion + 1，以及合法狀態組合。BIGINT 運算避免加法本身在 Int 上限溢位。
- CHECK 不會跨表驗證當前 Article，唯一鍵也不會強迫每次 Article UPDATE 都有稽核。原子性仍由正式 Service／Repository 的交易路徑保證。
- 應用只有交易內 appendStatusAudit，沒有稽核修改／刪除／查詢 HTTP API；DB 管理者仍能直接操作，本章沒有建立不可竄改或法遵稽核系統。

新增第三份 migration：202611020001_article_status_audit。前兩份 migration 不變；新增表初始為空，既有 User／Session／Article 不變。CHECK 存於 migration SQL，Prisma schema 不直接表達它，後續 migration 必須保留。

## 3. 交易、隔離與錯誤

ArticleTransaction 新增 appendStatusAudit，實作使用 callback 的 tx.articleStatusAudit，不能改用根 db。呼叫必須 await，完成後才能離開 callback。

文章寫入明確採 ReadCommitted、maxWait 2000 ms、timeout 5000 ms。兩個 pool 都讀到相同版本後，正常競爭應為一個成功、一個 VERSION_CONFLICT，只替成功的狀態變更寫稽核。其他資料庫故障仍走未知錯誤，不保證都回 409。

列表 findMany＋count 沿用 RepeatableRead。這只保證同一列表請求的快照，不能讓跨請求的 page 1／page 2 固定。

沒有全域 timeout／retry，也不捕捉任意 Prisma 錯誤轉成版本衝突。未知資料庫、交易逾時、稽核 INSERT 錯誤回安全 500 INTERNAL_ERROR；requestId 與 X-Request-ID 一致，不回 SQL、stack、連線字串或原始輸入。

## 4. Provider 與生命週期

每個應用建立一個 PrismaClient，透過同一 DatabaseModule 的 DATABASE token 提供給 Article／Auth／Health；不是每請求建立或斷線。沿用 pg adapter：max 5、connectionTimeoutMillis 2000、statement_timeout 5000。每應用自己的 pool 不等於整個部署共用五條連線。

DATABASE async factory 等待 $connect。main 在 listen 前檢查 Article、ArticleStatusAudit、Session、User 認證欄位；已連上但缺稽核表仍啟動失敗。/health/ready 做相同必要資料讀取，失敗回 503 NOT_READY；/health/live 不表示資料庫可用。

createArticleApplication 接手 database 的關閉責任。正常停止沿用 draining → http-drained → closed，等待工作後才 disconnect；初始化失敗也清理。未加第二套 Nest shutdown hook；tx 不得逃出 callback，取消訂閱也不會自動取消交易。

## 5. 沿用的 HTTP 與認證

- Cookie＋PostgreSQL Session，註冊固定 member、不自動登入，登入輪替與 CSRF、登出撤銷、固定到期、每次查目前角色均不變。
- 寫入需 Cookie＋精確 Origin＋X-CSRF-Token；preview 公開且不寫入。
- 公開列表／單篇只讀 published；me 永遠只查本人，包括 admin；admin 單篇入口才可跨作者與狀態。
- 建立作者由 Session 決定，201／Location 指向 /api/me/articles/:id；本人與 admin 仍需版本及合法狀態。
- JSON 16 KiB、UTF-8／媒體類型／讀取期限、Zod strictObject、title／content 的 120／4000 code points、正安全整數 expectedVersion 均沿用。
- 成功文章仍只回八個公開欄位，沒有 statusAudits；列表 data 與 meta 同層，Date 為 ISO UTC。
- HEAD 不回 body、logout 204、405／Allow、錯誤 envelope、白名單投影與 requestId 不變。
- 非法狀態代碼仍為 INVALID_STATE；第 00 章預定 INVALID_ARTICLE_STATE 尚未切換。
- 公開 NDJSON 仍是獨立教學檔，不是資料庫備份或稽核匯出。

## 6. 環境與版本

Compose nodejs-course-20，API 3020、PostgreSQL 15420，APP_ORIGIN=http://127.0.0.1:3020；test-db 不公開主機端口。資料與 node_modules volume 獨立於其他章。

Node 24.22.1、npm 11.19.1、TypeScript 5.9.3、Jest 30.2.0、Express 5.3.0、Zod 4.6.7、Supertest 7.3.1、Nest 11.2.8、Prisma 7.10.1、pg 8.23.1、PostgreSQL 17。其餘依賴與前章 lockfile 節點相同；CommonJS／NodeNext、decorators／metadata、Express／Multer overrides 沿用。

示範帳號密碼中的 18 沿用原值，seed 要求 DEMO_AUTH_SEED=1，不覆寫既有憑證、角色與文章。

## 7. 驗證邊界

完整 Jest 為 25 套、304 項；原 283 項保留。新增 21 項：Service 1、真實 PostgreSQL 交易／HTTP 19、舊 schema 升級 1。api-contract.ts／migration-contract.ts 與第 19 章逐位元相同，32 項基準繼續通過。

涵蓋稽核外鍵失敗回滾、兩張表寫完後 callback 失敗回滾、HTTP 故障觸發器與安全 500、admin actor、拒絕不寫入、版本上限、重送舊版本、兩個 pool 的 SELECT 屏障、SQL CHECK／唯一／外鍵、client 重建、migration／seed 重跑及缺稽核表 readiness。程序腳本另驗證缺稽核表時拒絕監聽。

測試只接受 TEST_DATABASE_URL／course_test，建立與清理自己擁有的隨機 schema；不清理開發 public。升級案例以兩份舊 migration SQL 建立 schema、插入資料，再執行本章 SQL；一般 fixture 用 Prisma migrate deploy。

test:status-api 連正在執行的 Compose API，真正登入三角色並比對開發 DB；test:status-persistence 在 API／PostgreSQL 重啟後比對保留的非憑證驗收資料。這兩項需啟動 API，不納入 npm run check。

沒有留言、稽核列表、Outbox、寄信、快取、分散式交易、冪等鍵或帳號復原。commit 成功但 HTTP 回應遺失時，不能推論交易回滾；本章以版本衝突與重新查詢辨識結果。
