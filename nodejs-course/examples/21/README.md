# 第 21 章：API 契約、分頁／篩選與 OpenAPI

保留第 20 章狀態稽核交易，新增標題搜尋、固定排序選項與本人文章狀態篩選，提供 OpenAPI JSON，並用真實 HTTP 與隔離 PostgreSQL 查詢計畫驗證行為。

[教材](../../21-api-contracts-pagination-and-openapi.md) · [本章契約](BASELINE.md)

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

API 主機 **3021**、開發 PostgreSQL **15421**；test-db 不公開主機端口。Compose 專案 nodejs-course-21 與資料 volume 獨立於前章。APP_ORIGIN 必須精確為 http://127.0.0.1:3021。

check 依序執行 generate、typecheck、27 套／339 項 Jest、build、程序驗證、四個既有 lab，再執行 lab:queries、openapi:export。npm test 會清掉 .test-dist，不可與程序或查詢實驗並行。

沒有新增 migration；三份既有 migration 保留。db:seed 補示範 DB 資料，seed 產生獨立 NDJSON；兩者不同。原示範帳號：

| 帳號 | 密碼 | 角色 |
|------|------|------|
| alice@example.test | Alice-course-18! | member，u_demo |
| bob@example.test | Bob-course-18!! | member，u_bob |
| admin@example.test | Admin-course-18! | admin，u_admin |

密碼中的 18 不更改。seed CLI 需 DEMO_AUTH_SEED=1（Compose 已設定），不覆寫既有憑證、角色與文章，僅供本機課程。

## 公開文件與列表

```bash
curl -fsS http://127.0.0.1:3021/api/openapi.json -o /tmp/chapter-21-openapi.json
curl -I http://127.0.0.1:3021/api/openapi.json
curl -i 'http://127.0.0.1:3021/api/articles?page=1&pageSize=1&sort=oldest'
curl -G -i --data-urlencode 'q=Node' http://127.0.0.1:3021/api/articles
curl -i 'http://127.0.0.1:3021/api/articles?status=draft'
curl -i 'http://127.0.0.1:3021/api/me/articles?status=draft'
```

文件是原始 OpenAPI 3.1.1，沒有 data 外包裝或 Swagger UI。最後兩項分別為 400（公開不接受 status）、401（尚未登入）。登入後 me 的 status 只能縮小自己的資料範圍，admin 也不能靠 me 讀他人。

| 參數 | 範圍 |
|------|------|
| page／pageSize | 原預設 1／20，上限 1000000／100，單一十進位字串 |
| q | title 不分大小寫字面搜尋，trim 後 1–80 code points；拒絕空值、NUL |
| sort | newest（預設）／oldest，依 createdAt＋id 同方向排序 |
| status | 僅 me：draft／published／archived，省略為本人全部狀態 |

未知或重複參數拒絕；q 中 %、_、反斜線為字面值。先套資料權限與篩選，再分頁與 count。total 為篩選後筆數，回應仍為 data＋meta。

## 文件匯出與查詢實驗

```bash
docker compose run --rm tools npm run openapi:export
docker compose run --rm tools npm run lab:queries
```

先完成 check。輸出 `.data/openapi.json` 與 `.data/query-plans.json`。OpenAPI 來源為 src/openapi.ts；HTTP 文件與匯出內容必須一致。文件不會自行安裝驗證器、Guard 或 CSRF 防護。

查詢實驗在 course_test 的隨機 schema 建立 30000 篇合成文章，執行 ANALYZE 與六組 EXPLAIN，最後清理自己的 schema。它只在該 schema 移除 status 複合索引作比較；開發 public 不受影響。

計畫可能因統計與資料分布不同而選擇 Index Scan、Bitmap Scan 或 Seq Scan。沒有固定毫秒數或強制索引斷言；查詢只投影 id，不能直接當 API 延遲。深 offset、精確 total 與子字串搜尋都要觀察下層實際掃描筆數。

## 執行中的 API 與重啟驗收

```bash
docker compose run --rm tools npm run test:query-api
docker compose run --rm tools npm run test:status-api
docker compose restart postgres
docker compose up -d --wait postgres
docker compose restart api
docker compose run --rm tools npm run test:query-persistence
docker compose run --rm tools npm run test:status-persistence
```

query-api 真正登入 Alice、Bob、admin，新增六篇驗收文章，確認公開只讀 published、me 永遠本人、排序／搜尋／分頁、OpenAPI HTTP 與匯出一致，以及三筆正確狀態稽核。status-api 保留前章的並行發佈、admin 封存與登出撤銷驗收。

proof 存在 .data，只有文章／稽核／搜尋前綴，不存 Cookie、CSRF 或密碼。每次執行保留各自驗收文章並覆寫相應 proof；重啟比對重新登入，驗證資料保存，不宣稱舊 Session 存在 proof 中。

手動 Cookie／CSRF 操作可參考[第 20 章](../../20-persistence-transactions-and-concurrency.md#209-用-docker-操作-api)，從本目錄執行並將 origin 改為 http://127.0.0.1:3021。

## 測試與檔案

```bash
docker compose run --rm tools npm test -- --testPathPatterns='openapi|list-query'
docker compose run --rm tools npm run test:baseline
docker compose run --rm tools npm run check
```

| 檔案 | 責任 |
|------|------|
| src/schemas.ts／article.dto.ts | 公開與本人列表 schema／DTO，保留舊 pagination 實驗 |
| src/articles.controller.ts | 兩個列表綁定不同 schema；認證 Guard 不變 |
| src/prisma-article-repository.ts | 可見範圍 AND 篩選、字面 ILIKE、固定排序與 RepeatableRead |
| src/openapi.ts／api-description.module.ts | 17 paths／30 operations 的文件與 GET／HEAD |
| test/list-query.test.ts | 25 項真實 DB／HTTP 篩選、權限、分頁與文件對照 |
| test/openapi.test.ts／openapi-contract.ts | 10 項文件／路由測試及本課 JSON Schema 子集比對 |
| scripts/check-query-plans.cjs | 隔離 EXPLAIN 實驗與計畫匯出 |
| scripts/export-openapi.cjs | 不連 DB 的文件匯出 |
| scripts/check-query-api.cjs | 執行中 API 及重啟驗收 |

原 304 項測試、32 項 HTTP 基準、狀態稽核回滾與雙 pool 競爭都保留。新增 35 項，共 27 套、339 項。兩份原文章 HTTP 契約與第 20 章逐位元相同。

文件比對器只支援本課使用的 schema 子集，不是完整 OpenAPI／JSON Schema validator。正規化、權限、header、傳輸與交易仍需獨立測試。

## 固定版本與正常停止

Node 24.22.1、npm 11.19.1、TypeScript 5.9.3、Jest 30.2.0、Express 5.3.0、Zod 4.6.7、Supertest 7.3.1；Nest 11.2.8、reflect-metadata 0.2.2、RxJS 7.8.2；Prisma CLI／Client／adapter-pg 7.10.1、pg 8.23.1、PostgreSQL 17。

沒有新依賴，lockfile 除專案名稱外與前章相同；CommonJS／NodeNext、decorators／metadata、Express 5.3.0／Multer 2.5.0 overrides 沿用。2026-11-02 npm ci audit 為 19 個受影響套件節點（3 low、16 moderate，無 high／critical），未執行 audit fix --force 或升級。

```bash
curl -f http://127.0.0.1:3021/api/articles/export -o /tmp/chapter-21-articles.ndjson
curl -I http://127.0.0.1:3021/api/articles/export
docker compose logs --tail 20 api
docker compose stop api postgres test-db
```

NDJSON 仍是獨立教學檔，不是資料庫或稽核備份。正常關閉為 draining → http-drained → closed；stop 保留資料 volume，沒有 down -v。

## 驗證紀錄（2026-11-02）

- 完整 check 通過：27 套、339 項 Jest，原 304 項保留，新增列表 25、文件 10；typecheck、build、程序驗證、四個原 lab、lab:queries 與 openapi:export 全部通過。
- 17 個 path／30 個 operation 與正式 Controller metadata 一致。OpenAPI HTTP 回應、主機下載與匯出 JSON 內容相同，HEAD 無 body；文件、列表與非法 query 的主機 curl 指令已從教材擷取實際執行。
- 真實 PostgreSQL 驗證 title-only 搜尋、字面 wildcard、Unicode 長度、重複／非法 query、owner／admin 範圍、穩定排序、先篩選後分頁與 total；另重現跨請求新增資料造成的 offset 重複。
- 30000 篇合成文章的六組 EXPLAIN 完成，計畫保留於 .data/query-plans.json。觀察到第一頁 Index Only Scan、深 offset 與 count 的 Seq Scan、搜尋的 Bitmap Scan；沒有固定效能門檻或強制索引。
- 開發資料庫三份既有 migration deploy／seed／status 成功。test:query-api 與 test:status-api 通過，包含三角色、六篇新列表驗收文章、文件一致、並行發佈 200／409 及正確稽核。API／PG 重啟後兩份 persistence 驗收均通過。
- NDJSON 20000 筆、3857788 bytes，GET 與來源 SHA-256 一致；HEAD bytesRead=0，兩者皆 fileClosed=true。日誌未出現示範密碼、Cookie、CSRF、摘要欄位或連線字串。
- 測試與查詢實驗的自有 test_／upgrade_ schema 殘留為 0。第 14–20 章共 589 個範例檔案摘要未變；原 HTTP 契約、認證／關閉核心、Prisma schema／migration 保留，lockfile 除專案名稱外相同。
- 課程總覽進度更新為 00–21 完成，前章下一章連結已接上；本機文件連結與 Markdown fence 檢查通過。
- API、postgres、test-db 已正常停止，退出碼 0，最後關閉順序為 draining → http-drained → closed。資料 volume、驗收文章／稽核、文件與查詢計畫及 NDJSON 保留；未執行 Git staging 或 commit。
