# 第 25 章：壓測、CPU／I/O 瓶頸、連線池與資源上限

完整獨立快照，承接第 24 章正式 API，新增獨立 performance-lab、有界 closed-loop 負載產生器、CPU profile 與資源限制實驗。文章／認證／日誌／健康契約保留，無新套件或 migration。

[教材](../../25-performance-load-and-resource-limits.md) · [本章契約](BASELINE.md) · [前章](../24/README.md) · [下一章：建置與部署](../26/README.md)

尚未安裝工具時，先完成[第 00 章 nvm／Node 安裝](../../00-course-map-and-project-contract.md#004-用-nvm-安裝-node-並執行第一個練習)與[第 01 章 Docker 操作](../../01-runtime-tooling-and-project-setup.md)。以下在本目錄執行，套件／測試／建置與資料庫仍使用 Docker。

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
docker compose up -d api performance-lab upstream external-lab
docker compose run --rm tools npm run test:performance-compose
docker compose run --rm tools npm run test:observability-compose
docker compose run --rm tools npm run test:external-compose
docker compose run --rm tools npm run test:query-api
docker compose run --rm tools npm run test:status-api
```

| 服務 | 主機連線 | 用途 |
|------|----------|------|
| api | http://127.0.0.1:3025 | 正式 Nest 文章／認證與 health／metrics |
| postgres | 127.0.0.1:15425 | 開發資料；效能 lab 只做固定 SELECT |
| performance-lab | http://127.0.0.1:3325 | 原生 HTTP 效能實驗，獨立 pg pool |
| external-lab | http://127.0.0.1:3125 | 第 23 章 Nest gateway，無 DB |
| upstream | http://127.0.0.1:3225 | 第 23 章可控制外部服務，容器內 4000 |
| test-db | 不公開主機端口 | 自有 schema 測試與分程序效能實驗 |

Compose 專案 nodejs-course-25，APP_ORIGIN=http://127.0.0.1:3025。各章 volume 獨立；Session Cookie 不按 port 隔離，使用本章獨立 Cookie jar。check 只清理自己的測試 schema，不替開發 DB deploy／seed。

完整 check：generate → typecheck → Jest → build → test:runtime → lab:nest → lab:scopes → lab:validation → lab:responses → lab:queries → openapi:export → test:parallel → lab:external → lab:performance。同目錄 test／check／parallel／效能實驗依序執行，避免重建 .test-dist 或互相製造量測負載。

## 五種固定工作

```bash
curl -i http://127.0.0.1:3325/health/live
curl -i http://127.0.0.1:3325/lab/work/baseline
curl -i http://127.0.0.1:3325/lab/work/cpu
curl -i http://127.0.0.1:3325/lab/work/yield
curl -i http://127.0.0.1:3325/lab/work/db
curl -i http://127.0.0.1:3325/lab/work/external
curl -fsS http://127.0.0.1:3325/lab/stats
```

全部正常為 200，work 回 `{ data: { kind } }`，cpu／yield 另附 digest。兩者相同迭代數應有相同結果；cpu 同步算 1200 萬次，yield 每 25 萬次 setImmediate 讓出，沒有平行 CPU。

db 經獨立 pg pool 執行固定 `SELECT pg_catalog.pg_sleep($1::double precision)`、參數 0.05，分開記 poolWait／dbQuery。external 真正 fetch 自有 loopback 隨機 port upstream，等待 50 ms；它與 3225 的舊 upstream 無關。自有 upstream 與 lab 同程序，CPU／ELU 也包含其 HTTP 處理成本，不等於兩台機器的量測。

只接受固定 GET／HEAD，HEAD 仍做工作；拒絕 query／body，未知路徑與尾斜線 404，其他方法 405。所有回應 no-store；錯誤維持安全 error／requestId envelope，不提供 SQL、URL、stack 或原始輸入。

lab 無認證，僅供 Compose loopback 本機教學，不進正式 OpenAPI。正式 3025 的 /lab/work/cpu 為 404。

## 分程序負載與 CPU profile

```bash
docker compose run --rm tools npm run lab:performance
docker compose run --rm tools npm run profile:cpu
docker compose run --rm tools npm run profile:summary
```

前提是已 generate／build 且 test-db 啟動。lab:performance 不需常駐 performance-lab，使用 TEST_DATABASE_URL；每個情境各啟一個子程序，父程序產生請求，不共用同一 JavaScript event loop。

八情境：五工作（client 併發 4）、db poolMax=1、external client 併發 8、baseline rateLimit=3。一般先兩次序列暖身，再跑 20 次；限流不暖身，應為 3 次 200／17 次 429。暖身不保證 JIT／所有 pool client 已穩定。overload 應同時有成功與 503，數量受排程影響。

負載是 closed-loop，最多 C 個 worker，每個等結果才送下一個；服務慢時送入量也下降，不是固定到達率壓測。run 上限：200 requests、16 concurrency、單次 deadline 最大 10000 ms、body 4096 bytes，不重試。目的 origin 只接受 HTTP loopback／Compose performance-lab。

報告保留 started／unscheduled、statuses、transportErrors／timeouts／invalidResponses、成功數、失敗率、嘗試與成功速率，以及全體／成功延遲 nearest-rank p50／p95／p99／max。空樣本為 null；20 筆 p99 近似最大值，不能當正式 SLO。200 但 kind 不符不算成功。

CPU／ELU 的 measurementWindow 取暖身後、負載前後差值；server 的 stages、delay histogram 與其他數值從情境啟動後累計，包含暖身。delay resolution=10 ms，無樣本為 null；cpuPerWall 是程序 CPU／wall 比值，不是整機百分比。stats 只提供數值，不回憑證、使用者資料或任意原始 Error。

profile:cpu 額外以 --cpu-prof 執行服務子程序，2 次暖身＋16 次併發 2 的 CPU 工作，正常 SIGTERM 後輸出 V8 profile；重新執行只取代自己的同名檔。profile:summary 讀取 self samples 前十名，包含 idle，不是完整 call tree 或 wall latency。採樣與一般比較分開執行。

| 產物 | 內容 |
|------|------|
| .data/performance-proof.json | 八情境設定、client 結果、server 統計、CPU／ELU 差值與 shutdown |
| .data/performance-compose-proof.json | 常駐 lab 五工作與超額負載結果／統計 |
| .data/performance-cpu.cpuprofile | V8 CPU samples，含程式路徑與函式資訊 |

以上是診斷產物，不是文章、稽核或資料庫備份；沒有硬編碼速度門檻。容量規劃仍須代表性流量、足夠樣本與重複測量。

## 容量、來源配額與清理

- 預設 admission=4，無應用佇列，滿載立即 503 LAB_BUSY、Retry-After:1。
- 獨立 pg pool 預設 max=2，connectionTimeoutMillis=2000、statement_timeout=1000；poolWait 與 query 耗時均含 driver／排程成本。
- 每程序每 socket 來源，第一次工作請求起 60 秒 1200 次；超過 429 RATE_LIMITED。Retry-After 為剩餘秒數向上取整。
- 最多 1000 個有效來源；滿表新來源 503 SOURCE_CAPACITY，不淘汰有效來源繞過限制。不信任 X-Forwarded-For。
- 順序為來源配額再 admission；503 也消耗配額。health／stats 不消耗工作配額。
- PERF_MAX_CONCURRENT=1–16、PERF_POOL_MAX=1–8、PERF_RATE_LIMIT=1–10000 為可信啟動設定；非法值不監聽。HTTP 不接受設定變更。

這些是 lab 局部策略；正式 Prisma pool、認證每來源每分鐘 20 次與 scrypt 成本沒有改變。多副本的 pool 與配額會相加，這不是分散式限流。

SQL 用戶離線後仍等真正 query 完成才 release client／admission；外部 fetch 與 body 可取消，自有 upstream 的 timer 也清理。正常 shutdown 等已登記工作，再關 upstream／pool、disable monitor；重複 shutdown 共用 Promise。同步 CPU 不會因 response close 在迴圈中間被強制打斷。

## 測試與正式契約驗收

```bash
docker compose run --rm tools npm run test:performance
docker compose run --rm tools npm run test:performance-compose
docker compose run --rm tools npm run test:observability-compose
docker compose run --rm tools npm run test:external-compose
docker compose run --rm tools npm run test:query-api
docker compose run --rm tools npm run test:status-api
docker compose restart postgres
docker compose up -d --wait postgres
docker compose restart api
docker compose run --rm tools npm run test:query-persistence
docker compose run --rm tools npm run test:status-persistence
curl -f http://127.0.0.1:3025/api/articles/export -o /tmp/chapter-25-articles.ndjson
curl -I http://127.0.0.1:3025/api/articles/export
```

query-api／status-api 建立比對基準，先跑再重啟。OpenAPI 仍為 3.1.1、18 paths／32 operations、info.version=24.0.0；HTTP 與 .data/openapi.json 同來源。NDJSON 保持獨立教學檔，不是 DB 備份。

| 檔案 | 責任 |
|------|------|
| src/performance-policy.ts | admission、有限來源視窗、nearest-rank 分位數 |
| src/performance-measurement.ts | CPU／ELU／delay／memory 與相同 CPU 工作 |
| src/performance-lab.ts | 五工作、獨立 pool、自有 upstream、stats 與資源關閉 |
| src/load-generator.ts | 有界 Agent／worker、整體 attempt deadline、失敗與分位數 |
| test/performance-policy.test.ts | 24 項純策略、CPU 排程／取消、monitor |
| test/performance-http.test.ts | 21 項真 HTTP／PG／取消／限流／負載契約 |
| scripts/check-performance.cjs | 分程序八情境、啟動失敗、正常 drain、profile |
| scripts/check-performance-compose.cjs | 常駐服務驗收，無速度門檻 |
| scripts/summarize-cpu.cjs | profile self samples 概要 |

原 449 項加 45 項，完整 Jest 39 套、494 項；雙 worker 另重跑 6 項。效能 SELECT 不修改資料、不新建 schema；其餘 DB fixture 仍只清理自有隨機 schema，不能拿這些測試刪開發資料。

## 固定版本與停止

Node 24.22.1、npm 11.19.1、TypeScript 5.9.3、Jest／@jest/globals 30.2.0、Express 5.3.0、Zod 4.6.7、Supertest 7.3.1、Nest common／core／platform-express／testing 11.2.8、Prisma CLI／Client／adapter-pg 7.10.1、pg 8.23.1、PostgreSQL 17；reflect-metadata 0.2.2、RxJS 7.8.2、Express 5.3.0／Multer 2.5.0 overrides、CommonJS／NodeNext 與 decorators／metadata 保留。lockfile 只改根專案名稱，無新增依賴。

2026-11-03 npm ci audit 觀察為 19 個受影響節點（3 low、16 moderate），未依升級提示改版或執行 audit fix --force；advisory 數字可能改變。seed CLI 需 DEMO_AUTH_SEED=1（Compose 已設定），不覆寫既有憑證、角色或文章。

| email | 密碼 | 角色／ID |
|------|------|----------|
| alice@example.test | Alice-course-18! | member／u_demo |
| bob@example.test | Bob-course-18!! | member／u_bob |
| admin@example.test | Admin-course-18! | admin／u_admin |

```bash
docker compose stop performance-lab external-lab upstream api postgres test-db
docker compose logs --no-log-prefix --tail 15 performance-lab api
```

六個服務正常停止，保留 volume、文章、稽核、profile 與 proof；不用 down -v，不 staging／commit。


## 驗證紀錄（2026-11-03）

- 最終完整 check 通過：39 套、494 項 Jest（原 449＋新增 45）、typecheck／build、正式程序／信號／關閉期限、四個原 lab、查詢／OpenAPI、兩個真正 worker 6 項、外部 HTTP 與八組分程序效能實驗。
- 新增 policy 24、HTTP 21，包含真 PG pool 等待／client release、admission 超額 503、來源配額與 XFF、SQL 離線後 drain、真 fetch／upstream timer 取消、CPU sync／yield 結果與排程、monitor 關閉，以及負載 deadline／錯誤 200／過大 body／傳輸中斷與恢復。過大 body 先 reject 再 destroy，避免 end 事件誤記成功結果。
- 八情境每組正式 20 次、一般另有 2 次暖身；五工作與 poolMax=1 正常 20 次成功，超額組有成功與 503，配額組為 3 次 200／17 次 429。各子程序均正常 draining → http-drained → closed，不設定吞吐／延遲倍數門檻。
- CPU profile 實際產生，驗證非空 samples 與 cpuDigest 節點；profile:summary 可讀 self samples。最終所有 scripts/*.cjs 的 Node 語法檢查通過。
- 常駐 Compose 的 performance／observability／external、query-api／status-api 通過。完整 check 結束後依序重跑最終 Compose 與兩份 persistence，確認 API／PostgreSQL 重啟後文件、六篇查詢驗收文章與狀態文章／稽核逐欄位相同。
- 教材主機 curl 的 cpu／yield／db／external 均 200，cpu／yield digest 相同；query=400、POST=405、正式 API 的 lab 路徑=404。NDJSON GET 為 20000 筆、3857788 bytes，SHA-256 與來源相同，HEAD 正常。
- lockfile 除根專案名稱外與 24 相同；schema／三份 migration、文章／認證／日誌／關閉核心與兩份 HTTP 基準逐位元相同。第 24 章範例僅更新 README 導覽，課程總覽與前後章連結已更新；本地連結、Bash 與行尾空白檢查通過。
- 測試資料庫自有 schema 殘留為 0；API／performance-lab 日誌逐行 JSON 與敏感值檢查通過，最終關閉順序均為 draining → http-drained → closed。六個本章容器正常退出 0，volume、文章、稽核、profile 與 proof 保留，未 staging／commit。
