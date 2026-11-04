# 第 26 章：建置、Docker、CI、migration、代理與 HTTPS

承接第 25 章的完整快照，新增多階段交付映像、檔案式 DB URL、獨立 migration、Nginx TLS 與 CI 範例。文章／Session／CSRF／稽核／日誌／health／metrics 保留；沒有新套件、migration 或正式 API 端點。

[教材](../../26-build-docker-ci-and-deployment.md) · [契約](BASELINE.md) · [前章](../25/README.md)

先完成[第 00 章 nvm／Node 安裝](../../00-course-map-and-project-contract.md#004-用-nvm-安裝-node-並執行第一個練習)與[第 01 章 Docker 操作](../../01-runtime-tooling-and-project-setup.md)。以下在本目錄執行，工具與服務仍使用 Docker。

## 乾淨環境與完整 CI 等效流程

```bash
nvm install
nvm use
sh ci/check.sh
```

腳本自動 build tools、啟動 test-db、npm ci、完整 check、產生演練憑證／secrets、建立交付映像，再驗證 migration／TLS／runtime 限制與 DB／API 重啟持久化。結束或失敗時正常停止本章服務，保留資料 volume 與原退出碼，不做 Git staging／commit。

也可逐步執行：

```bash
docker compose build tools
docker compose up -d --wait test-db
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm run deploy:init
docker compose -f compose.production.yaml build api migrate verifier
sh scripts/deploy-local.sh
sh scripts/check-runtime.sh
```

同目錄 test／check／parallel 與會讀取 .test-dist 的驗收要依序執行。完整 check 為 generate → typecheck → Jest → build → test:runtime → 四個原 lab → lab:queries → openapi:export → test:parallel → lab:external → lab:performance → lab:deployment。

## 兩個完全獨立的環境

| 環境 | 專案／主機 port | 資料與用途 |
|------|----------------|------------|
| 開發 compose.yaml | nodejs-course-26；API 3026、PG 15426、external-lab 3126、upstream 3226、performance-lab 3326 | 原有工具、範例與獨立資料 volume |
| 部署 compose.production.yaml | nodejs-course-26-production；HTTP 30826、HTTPS 34426 | API／PG 不公開 port，獨立 production_data |

部署 origin 為 https://localhost:34426，開發 origin 為 http://127.0.0.1:3026；Cookie 不按 port 隔離，各章與環境使用獨立 jar。兩個 postgres 名稱在不同 Compose 網路中，不共享資料。

正式 OpenAPI 保持 3.1.1、18 paths／32 operations、info.version=24.0.0；servers=/ 仍表示同源。文件的 3026 Origin example 是開發示意，TLS 操作需使用實際 APP_ORIGIN。HTTP／匯出文件仍同來源，沒有 Swagger UI。

## 交付與本機 TLS

- tools：原有開發 bind mount；build／migration：CLI、schema、完整編譯依賴。
- runtime：僅實際 API 編譯依賴、固定 NDJSON、release.json，沒有 src／測試／CLI／TypeScript／Jest／seed 或 lab。
- runtime npm ci 同時 omit dev／optional／peer，避免 optional peer 把 CLI 留下；必要根 dependencies 與 Prisma JS adapter 已以真 DB／scrypt／TLS 驗證。
- runtime user=node、read_only、/tmp tmpfs、drop ALL capabilities、no-new-privileges，512 MiB／1 CPU／64 PID、init、8 秒停止寬限。
- migration 先成功才更新 API；API 啟動不 migrate、不 seed。probe 呼叫 loopback ready，三秒／2048 bytes、只有 200 成功。

```bash
curl --cacert deploy/local/ca.crt -i https://localhost:34426/health/ready
curl --cacert deploy/local/ca.crt -i https://localhost:34426/api/articles
curl -I http://localhost:30826/api/articles
docker compose -f compose.production.yaml run --rm verifier
```

init-deploy 只建立本機 CA／localhost 憑證及隨機 DB 密碼；不修改信任庫，已有檔案重用、不覆寫。CA 30 天／伺服器憑證 7 天，沒有自動續期；不要用 -k 關掉驗證。deploy/local 0700、掛載檔 0444，CA 私鑰 0600；資料夾被 Git／build context 排除。Compose secret 是檔案掛載，不是加密 secret manager。

DATABASE_URL 與 DATABASE_URL_FILE 擇一，衝突／缺漏／過大檔案／非法 UTF-8／空白都拒絕。NODE_ENV=production 需要 HTTPS APP_ORIGIN，Secure Cookie 由可信設定決定，不信任外來 forwarded header。

本機演練沿用 course 初始化 DB 角色並共用 migration／API 憑證；並未完成真實部署所需的 DB 角色分權、受管理秘密與公開憑證。它也不是跨主機或零停機部署，沒有發布到外部服務。

## 代理的明確界線

Nginx 1.30-alpine 以固定 digest、非 root 101:101、唯讀與 /tmp tmpfs 執行；HTTP 308 到固定 HTTPS origin，TLS Host 只接受 localhost:34426，其他 421。

路徑不加 URI 重寫；proxy buffering／request buffering 關閉，16 KiB 與讀取限制由 API 保留。proxy_next_upstream=off，不自動重送寫入。connect=2 秒、send／read=10 秒，後兩者為 I/O 閒置期限。

Docker DNS resolve＋5 秒快取支援 API 重建後重新解析；單副本替換仍可能短暫 502。代理自身錯誤不保證 JSON／應用 UUID。access log 不記 URL／query／認證資訊，一般 error context 不公開，僅保留 emerg 啟動診斷。

應用不信任 XFF／Forwarded；認證每來源每分鐘 20 次在本例會由 proxy 下的用戶共享，不宣稱已實作真實 client IP 或全域限流。health／metrics 仍公開。

## 持久化、相容回退與證據

```bash
docker compose -f compose.production.yaml restart postgres
docker compose -f compose.production.yaml up -d --wait postgres
docker compose -f compose.production.yaml restart api
docker compose -f compose.production.yaml run --rm verifier --verify
```

一般 verifier 註冊自己的隨機會員、確認 Secure Cookie／登入輪替、錯 Origin／舊 CSRF 403、草稿 201／Location、公開隔離與發佈。--verify 檢查相同公開文章與 DB Session；固定 30 分鐘過期後須重新建立基準，不延長 Session。

| 產物 | 範圍 |
|------|------|
| .data/openapi.json | 同來源契約 |
| .data/runtime-proof.json | 執行中 image ID／release ID、使用者與容器限制 |
| .data/production-proof.json | TLS／CSRF 結果與公開驗收文章，無憑證 |
| .data/deployment-session.json | 0600 私有 Cookie jar，不能當 artifact 分享 |

教材提供 chapter26-r1 → r2 → r1 的 --no-build 映像替換演練。兩版僅 release metadata 不同，不是業務版本回歸測試；保留相同 DB／Session，不跑反向 migration。真實回退要先評估新 schema／資料能否被舊程式理解，不能刪 volume 或 migrate reset。

## CI 範例

ci/workflow.yml 可複製到自己倉庫的 .github/workflows/nodejs-course-26.yml；已存在則先比對，不覆寫。使用 ubuntu-24.04、contents:read、完整 action SHA、25 分鐘上限；不使用 pull_request_target，不保存 checkout credentials，不需要部署／registry secret。

workflow 只上傳 OpenAPI／runtime-proof／production-proof 三個明列檔案，不能用 .data/** 或整章打包。語法檢查只需掛載 ci/，不要提供含私鑰的整個目錄。此處驗證本機等效腳本與 workflow 語法，沒有聲稱遠端 GitHub Actions 已執行，也不自動發布。

## 開發 API 與沿用實驗

```bash
docker compose up -d --wait postgres test-db
docker compose run --rm tools npm run db:deploy
docker compose run --rm tools npm run db:seed
docker compose run --rm tools npm run seed
docker compose up -d api performance-lab upstream external-lab
docker compose run --rm tools npm run test:query-api
docker compose run --rm tools npm run test:status-api
docker compose run --rm tools npm run test:observability-compose
docker compose run --rm tools npm run test:external-compose
docker compose run --rm tools npm run test:performance-compose
```

先有 query／status proof 再做 PG／API 重啟與 persistence 比對；指令與前章同義。NDJSON 仍是獨立公開教學檔，不是 DB 備份。

示範帳號 alice@example.test／bob@example.test／admin@example.test，密碼仍為 Alice-course-18!／Bob-course-18!!／Admin-course-18!；開發 seed 需 DEMO_AUTH_SEED=1（已設定），不覆寫資料。部署不自動帶入帳號，只有本機明確需要時執行：

```bash
docker compose -f compose.production.yaml run --rm -e DEMO_AUTH_SEED=1 migrate seed-demo
```

## 檔案、版本與停止

| 檔案 | 責任 |
|------|------|
| Dockerfile／tsconfig.runtime.json | tools／build／migration／runtime／verifier 與實際 API 閉包 |
| src/runtime-config.ts／readiness-probe.ts | secret 設定、production HTTPS 與健康 probe |
| scripts/release-task.cjs／check-release-failure.cjs | 獨立 migration、真失敗閘門、原 migration 保留 |
| scripts/init-deploy.cjs／deploy-local.sh | 本機材料與依序部署 |
| deploy/nginx.conf／compose.production.yaml | TLS、代理、檔案掛載與資源限制 |
| scripts/check-production.cjs／check-runtime.sh | 真 HTTPS／Cookie／CSRF、容器／映像邊界與持久化 |
| ci/check.sh／workflow.yml | 同一份本機與 GitHub-hosted CI 流程 |

Jest 40 套、515 項（原 494＋設定／probe 21），雙 worker 另 6 項。lab:deployment 在自有 schema 與臨時 migration 目錄驗證真 Prisma 失敗阻止後續命令，清理後不留測試表；不修改原三份 migration。

Node 24.22.1、npm 11.19.1、TypeScript 5.9.3、Jest／@jest/globals 30.2.0、Express 5.3.0、Zod 4.6.7、Supertest 7.3.1、Nest 11.2.8、Prisma CLI／Client／adapter-pg 7.10.1、pg 8.23.1、PostgreSQL 17、reflect-metadata 0.2.2、RxJS 7.8.2、Express／Multer 2.5.0 overrides 保留。lockfile 只改根專案名稱；CommonJS／NodeNext、decorators／metadata 沿用，不依升級提示改版。

```bash
docker compose -f compose.production.yaml stop proxy api postgres
docker compose stop performance-lab external-lab upstream api postgres test-db
```

保留資料 volume、文章、Session、稽核、映像與 proof，不用 down -v，不 staging／commit。


## 驗證紀錄（2026-11-03）

- 完整 ci/check.sh 通過：40 套、515 項 Jest（原 494＋新增設定／probe 21）、build／typecheck、原程序／信號／關閉期限、四個原 lab、查詢／OpenAPI、雙 worker 6 項、外部 HTTP／八組效能實驗與真實失敗 migration 閘門。
- 真 migration 失敗只在自有 schema／臨時目錄產生，後續啟動標記不存在、原表保留；歷史 schema／三份 migration 逐位元不變。secret 設定衝突／檔案大小／UTF-8／換行、production HTTPS 與 probe 的慢／過大 body 都有測試。
- runtime 實際確認非 root、唯讀與資源限制、無原始碼掛載／公開 API port／環境變數形式 DB URL；無 Prisma CLI、TypeScript、Jest、seed／lab。npm omit dev／optional／peer 後，真正 PostgreSQL、scrypt、Cookie／CSRF 與 TLS 仍通過。
- 本機 CA 驗證成功、未信任 CA 失敗、HTTP 308、Secure __Host- Cookie／登入輪替、錯 Origin／舊 CSRF 403、201 Location、草稿隔離、發佈 version=2、16 KiB 413、路徑／HEAD／metrics 均通過。主機 curl 的 TLS live／ready=200，redirect=308，沒有關閉憑證驗證。
- r1→r2→r1 實際映像 ID 不同，最後回到原 r1；每次替換仍能用同一 Cookie 讀取同一使用者與相同公開文章，不回退 DB schema。release-switch-proof 保留必要映像 ID，沒有憑證。
- 開發 query／status／observability／external／performance Compose 全通過，API／PG 重啟後兩份持久化逐欄位相同。TLS NDJSON GET／HEAD 為 200、3857788 bytes；固定教學檔與 DB 備份界線保留。
- 最終 workflow 釘選官方完整 SHA，actionlint 1.7.7 只掛載 ci/ 檢查通過；所有 CJS 與 POSIX shell 語法、本地連結、教材 Bash 區塊與行尾空白檢查通過。這是本機 CI 等效執行，沒有啟用或宣稱遠端 Actions 已跑。
- lockfile 只改根專案名稱，原業務／認證／HTTP 基準／觀測／shutdown 核心保留；第 25 章範例僅新增 README 導覽。npm ci 開發依賴 audit 觀察為 19 個受影響節點（3 low、16 moderate），未升級或執行 audit fix --force。
- 測試 schema 殘留為 0；開發／部署 API 最終為 draining → http-drained → closed，九個常駐容器均正常退出 0。日誌與可分享 proof 未含實際 DB URL／密碼／Session Cookie／CSRF；TLS NDJSON 為 20000 筆，SHA-256 與來源相同。資料 volume、文章、Session、稽核、演練材料、映像與 proof 保留，未 staging／commit。

[下一章：前端串接與 BFF 邊界](../27/README.md)
