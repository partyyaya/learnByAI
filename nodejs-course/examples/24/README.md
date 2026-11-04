# 第 24 章：結構化日誌、健康／就緒與基本指標

這是承接第 23 章的完整獨立快照。新增可注入的 JSON 日誌、欄位白名單、HTTP／真正工作數量區分與公開彙總指標；保留文章、認證、稽核交易與獨立外部 HTTP 實驗。

[教材](../../24-logging-health-and-observability.md) · [本章契約](BASELINE.md) · [前章](../23/README.md) · [下一章：效能實驗](../25/README.md)

尚未安裝工具時，先完成[第 00 章 nvm／Node 安裝](../../00-course-map-and-project-contract.md#004-用-nvm-安裝-node-並執行第一個練習)與[第 01 章 Docker 操作](../../01-runtime-tooling-and-project-setup.md)。以下指令在本目錄執行；套件、建置、測試、API、PostgreSQL 仍使用 Docker。

## 從乾淨環境開始

```bash
nvm install
nvm use
docker compose build tools
docker compose up -d --wait postgres test-db
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm run db:deploy
docker compose run --rm tools npm run db:seed
docker compose run --rm tools npm run db:status
docker compose run --rm tools npm run seed
docker compose up -d api upstream external-lab
docker compose run --rm tools npm run test:observability-compose
docker compose run --rm tools npm run test:external-compose
docker compose run --rm tools npm run test:query-api
docker compose run --rm tools npm run test:status-api
```

| 服務 | 主機連線 | 用途 |
|------|----------|------|
| api | http://127.0.0.1:3024 | 正式文章／認證、health 與 metrics |
| postgres | 127.0.0.1:15424 | 三份既有 migration 的開發 DB |
| external-lab | http://127.0.0.1:3124 | 獨立 Nest gateway，無 DB |
| upstream | http://127.0.0.1:3224 | 本機可控制故障服務，容器內 upstream:4000 |
| test-db | 不公開主機端口 | 測試專用、隨機 schema |

Compose 專案 nodejs-course-24；APP_ORIGIN=http://127.0.0.1:3024。各章 node_modules／DB volume 獨立；Cookie 不按 port 隔離，請使用本章獨立 Cookie jar。不要同時跑同目錄的 test／check／focused／parallel，它們會重建 .test-dist。

check 順序：generate → typecheck → 全量 Jest → build → test:runtime → lab:nest → lab:scopes → lab:validation → lab:responses → lab:queries → openapi:export → test:parallel → lab:external。check 使用自有測試 schema，不替開發 DB deploy／seed。

## 用 request ID 找到日誌

```bash
curl -i -H 'X-Request-ID: user-provided' http://127.0.0.1:3024/missing
curl -i http://127.0.0.1:3024/health/live
curl -i http://127.0.0.1:3024/health/ready
curl -fsS http://127.0.0.1:3024/health/metrics
curl -I http://127.0.0.1:3024/health/metrics
docker compose logs --no-log-prefix --tail 30 api
```

第一個請求故意得到 404；服務產生新 UUID，錯誤 body.requestId 與 X-Request-ID 一致。API 日誌每行為 JSON，使用 event=request_completed／http_error／export_finished／shutdown 等有限事件；同一 UUID 可跨事件查找。

只記錄安全碼、route 樣板、method、duration、傳輸結果與清理數值。不記錄原始 URL／query／body／error、密碼、Cookie、CSRF、tokenHash、email、使用者／文章 ID、DB URL 或上游 body。新增欄位前必須修改投影與測試；不是通用遞迴 redactor。

errorStatus 是錯誤分類；httpStatus 是已送出的 HTTP 狀態。串流送出 200 後失敗，可能是 errorStatus=500、httpStatus=200、interrupted。不要把 200 與 finish 單獨當成完整下載或用戶收件證明。

## 指標與健康契約

GET／HEAD /health/metrics 公開提供 Prometheus text 0.0.4、no-store，拒絕 query；其他方法 405，尾斜線 404。只暴露程序彙總與有限 labels，不需要登入。OpenAPI info.version=24.0.0，18 paths／32 operations；同一來源匯出至 .data/openapi.json，沒有 Swagger UI。

- course_http_requests_total：finished／interrupted counter。
- course_http_duration_seconds：累計 histogram，桶 0.01／0.1／0.5／1／5／+Inf 秒。
- course_http_in_flight：尚未結束的 response，包括本次 scrape。
- course_work_pending：已登記工作票數，可能重疊，不是 SQL 數量。
- course_draining：開始關閉後為 1。
- course_log_dropped_total：同步 sink 拋錯或拒收的累計筆數。

labels 只用 route 樣板、有限 method、status_group 與 outcome；不放 requestId／原始 URL／使用者 ID。指標只在目前程序內累計，重啟歸零；沒有監控伺服器、告警或效能承諾。

live 不查 DB；ready 真正查必要表與認證欄位，失敗回 503 NOT_READY。draining 中的 ready 為 503 SHUTTING_DOWN，原已接受工作繼續排空；listener 關閉後沒有任何 HTTP 回應，不能期待停止後再 curl 到 503。

## 停 DB、恢復與持久化

先完成正常驗收與 query-api／status-api：

```bash
docker compose stop postgres
docker compose run --rm tools npm run test:observability-compose -- --unavailable
docker compose up -d --wait postgres
docker compose run --rm tools npm run test:observability-compose
docker compose restart postgres
docker compose up -d --wait postgres
docker compose restart api
docker compose run --rm tools npm run test:query-persistence
docker compose run --rm tools npm run test:status-persistence
curl -f http://127.0.0.1:3024/api/articles/export -o /tmp/chapter-24-articles.ndjson
curl -I http://127.0.0.1:3024/api/articles/export
```

DB 停止時：live／metrics=200、ready=503 NOT_READY、文章列表=500 INTERNAL_ERROR；API 不退出。恢復後 ready／列表回 200。proof 在 .data/observability-compose-proof.json，只有時間、狀態與服務 UUID；query／status proof 與前章同義。

NDJSON 是獨立公開教學檔，不是 DB／Session 備份。匯出日誌與 HTTP completion 共用 UUID，fileClosed=true 必須等檔案 finally 才能觀察。

## 測試、實作檔案與外部實驗

```bash
docker compose run --rm tools npm run test:observability
docker compose run --rm tools npm run test:baseline
docker compose run --rm tools npm run test:parallel
```

| 檔案 | 責任 |
|------|------|
| src/observability.ts | 同步 LogSink、事件投影、有限 labels、HTTP 結束與指標 |
| src/server.ts／runtime.module.ts | 共用正式 HTTP 組裝、OBSERVABILITY 注入、串接 callback |
| src/main.ts | JSON stdout、背壓拒收、啟動／信號／失敗事件 |
| src/health.module.ts | live／ready／metrics，draining 前後確認 |
| src/errors.ts | errorStatus 分類與已送 httpStatus 分離 |
| test/observability.test.ts | 18 項路由、欄位投影、sink、真 HTTP、中斷與 drain |
| test/observability-database.test.ts | 3 項真 PG 故障／交易、真登入遮蔽與 NDJSON 清理 |
| scripts/check-observability-compose.cjs | 執行中正式容器的正常／DB 不可用驗收 |

原 428 項加 21 項，完整 Jest 為 37 套、449 項。雙 worker 另重跑 6 項；程序腳本以 JSON 事件驗證啟動失敗、信號、排空與期限。測試只改動自有 schema，fixture 關閉可重複呼叫。

第 23 章的 native fetch 策略原樣保留。觀察獨立 lab：

```bash
curl -i http://127.0.0.1:3124/lab/topics/retry
curl -i http://127.0.0.1:3124/lab/topics/slow-body
curl -fsS http://127.0.0.1:3224/__lab/stats
docker compose run --rm tools npm run test:external-compose
```

GET 最多三次、整體 800 ms／單次 250 ms、最多四個邏輯操作、4096 bytes、有限重試與取消照舊；POST 回應遺失只送一次。lab 不掛正式文章 AppModule，不在正式 OpenAPI 或本章 metrics 中。獨立無 DB 的執行方式：

```bash
docker compose run --rm -e DATABASE_URL= -e TEST_DATABASE_URL= tools npm run lab:external
```

先完成 npm ci／generate／build；lab 自建 loopback 服務並清理，proof 在 .data/external-proof.json。

## 固定版本與收尾

Node 24.22.1、npm 11.19.1、TypeScript 5.9.3、Jest／@jest/globals 30.2.0、Express 5.3.0、Zod 4.6.7、Supertest 7.3.1、Nest common／core／platform-express／testing 11.2.8、Prisma CLI／Client／adapter-pg 7.10.1、pg 8.23.1、PostgreSQL 17；reflect-metadata 0.2.2、RxJS 7.8.2 與 adapter 的 Express 5.3.0／Multer 2.5.0 overrides 沿用。CommonJS／NodeNext、decorators／metadata 保留。

lockfile 只改根專案名稱，未重解依賴。2026-11-03 npm ci 觀察為 19 個受影響節點（3 low、16 moderate），未依升級提示改版或執行 audit fix --force。此數字會隨 advisory 改變。

示範 seed 需 DEMO_AUTH_SEED=1（Compose 已設定），不覆寫既有憑證、角色或文章：

| email | 密碼 | 角色／ID |
|------|------|----------|
| alice@example.test | Alice-course-18! | member／u_demo |
| bob@example.test | Bob-course-18!! | member／u_bob |
| admin@example.test | Admin-course-18! | admin／u_admin |

```bash
docker compose stop external-lab upstream api postgres test-db
docker compose logs --no-log-prefix --tail 15 api
```

正常關閉保留 volume、文章、稽核與 proof，不用 down -v。先排空 HTTP 與已登記工作，再關 Nest／資源／DB；response close 與 Observable finalize 都不會提前關 pool。


## 驗證紀錄（2026-11-03）

- 完整 check 通過：37 套、449 項 Jest（原 428＋新增 21）、typecheck／build、正式程序與信號／關閉期限、四個原 lab、查詢、OpenAPI、雙 worker 6 項與外部實驗。最終補上 DB 故障與 draining 同時發生的案例，以及真 Cookie／tokenHash 遮蔽比對後，再跑完整 check 並通過。
- 真 HTTP 驗證成功／失敗／串流中斷的 UUID、欄位白名單、sink 故障與拒收、有限 series／histogram、HTTP 結束與工作排空的差異；真 PG 自有 schema 故障／恢復、登入／CSRF、INSERT 回滾與 NDJSON finally 均通過。
- 正式 Compose 觀測、外部 HTTP、query-api、status-api 通過。實際停止本章 postgres 時 live／metrics=200、ready=503、列表=500，API 不退出；恢復後 ready／列表=200。healthy／databaseUnavailable proof 已保存。
- API／PostgreSQL 重啟後，OpenAPI HTTP 與匯出一致，六篇查詢驗收文章與狀態驗收文章／稽核逐欄位相同。主機 curl 的 live／ready／metrics=200、missing=404，外來 request ID 被替換。
- API JSON 日誌可逐行解析，錯誤 UUID 均能對到 completion，未發現測試用秘密、示範密碼、認證摘要、email 或 DB URL。NDJSON GET 為 20000 筆、3857788 bytes，SHA-256 與來源相同，HEAD 不讀檔且正常關閉。
- lockfile 除根專案名稱外與前章相同；Prisma schema／三份 migration 逐位元相同。既有文章業務核心與兩份 HTTP 基準保留；課程總覽與前後章導覽已更新，教材連結與指令語法檢查通過。
- 最終正式建置的觀測與兩份持久化驗收再通過；測試 schema 殘留為 0。五個本章容器均正常退出 0，最後關閉事件為 draining → http-drained → closed；資料 volume、文章、稽核與 proof 保留，未 staging／commit。
