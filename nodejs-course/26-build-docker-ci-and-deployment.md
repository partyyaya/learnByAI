# 26 — 正式建置、容器、migration 部署步驟、CI、代理與 HTTPS

> 交付一個已驗證的映像，再把 migration、設定與啟動順序接起來；重啟程序不應讓文章或 Session 消失。

前置：[第 07 章程序生命週期](07-process-signals-and-graceful-shutdown.md)、[第 18 章 Session／CSRF](18-authentication-sessions-and-guards.md)、[第 20 章交易與 migration](20-persistence-transactions-and-concurrency.md)、[第 24 章觀測](24-logging-health-and-observability.md)、[第 25 章資源限制](25-performance-load-and-resource-limits.md)。[本章快照](examples/26/README.md)可獨立執行；對外行為見 [BASELINE](examples/26/BASELINE.md)。

完成本章後，你應能：

- 分開編譯、測試、migration 與執行所需的檔案和權限。
- 建立無原始碼掛載、非 root、唯讀的 API runtime 映像。
- 由 secret 檔案提供 DB URL，讓缺漏／衝突設定在啟動時失敗。
- 先跑獨立 migration 工作，失敗就停止後續啟動。
- 透過 Nginx TLS 使用 Secure Cookie，保留精確 Origin／CSRF 與 HTTP 契約。
- 執行本機 CI 等效流程，驗證資料保留、映像替換與相容版本回退。

本章不新增正式 API 端點、套件或 migration；文章權限、版本、稽核、Session、OpenAPI 與既有實驗保留。OpenAPI 仍為 18 paths／32 operations、info.version=24.0.0。正式交付範例在本機演練，沒有發布到網際網路、registry 或雲端。

## 26.1 為什麼開發 Compose 不能直接當交付映像？

前章 tools 容器把原始碼掛到 /work，並共享該章 node_modules volume；這方便反覆編輯，但服務實際執行的內容可能隨主機檔案改變。

本章提供兩個獨立 Compose 專案：

| 項目 | compose.yaml | compose.production.yaml |
|------|--------------|-------------------------|
| 專案名稱 | nodejs-course-26 | nodejs-course-26-production |
| API | HTTP 3026 | 不公開 port，只由 proxy 連 3000 |
| PostgreSQL | 主機 15426 | 不公開 port，獨立 production_data volume |
| 外部／效能 lab | 3126／3226／3326 | 不交付 |
| 原始碼／套件掛載 | 開發工具使用 | API 不使用 |
| 對外入口 | API 直接 HTTP | HTTP 30826、HTTPS 34426，均綁主機 loopback |

同樣的服務名稱 postgres 在不同 Compose 網路中指向各自的 DB；兩邊不共用文章、Session 或 volume。部署演練不是開發資料庫升級，也不會把教學資料搬到另一邊。

## 26.2 一份 Dockerfile，多個明確用途

[Dockerfile](examples/26/Dockerfile)保留固定 Node 24.22.1 的映像 digest，使用多階段建置。[Docker multi-stage 文件](https://docs.docker.com/build/building/multi-stage/)

```text
base：Node、OpenSSL 與 CA
  ├─ tools：開發工作目錄，供原有 Compose 指令
  ├─ dependencies → build：完整依賴、generate、編譯
  │                   ├─ migration：獨立 Prisma CLI 工作
  │                   └─ 僅複製實際 API 編譯產物給 runtime
  ├─ production-dependencies：runtime 依賴
  └─ verifier：一次性 HTTPS 驗收工具，不提供 HTTP 服務
```

build 使用無法連線的示意 DATABASE_URL 產生 Prisma 型別；它不執行 migration、不連真 DB，也不接收正式憑證。正式 URL 只在執行時透過 secret 提供。

`tsconfig.runtime.json` 只以 main 與 readiness-probe 為入口，讓 TypeScript 編譯其相依檔案。runtime 不包含 src、測試、Prisma schema／CLI、TypeScript、Jest、示範 seed 或外部／效能 lab；另外帶入固定 NDJSON 教學檔與 release.json。

### 不能只假設 omit=dev 就沒有開發工具

Prisma Client 的 optional peer 可能讓 Prisma CLI 與 TypeScript 仍存在於安裝樹。本章 runtime 使用：

```bash
npm ci --omit=dev --omit=optional --omit=peer --ignore-scripts
```

Nest 等必要 runtime 相依已明列在根 dependencies；本例使用 JS pg adapter，不依賴被省略的 optional native driver。CLI／編譯留在 build／migration 階段。實際的 DB、登入、scrypt 與 HTTPS 驗收會確認這份裁減後的樹能工作，不能只看 npm ls 的顯示就推論檔案已移除。[npm ci 的 omit 選項](https://docs.npmjs.com/cli/v11/commands/npm-ci/#omit)

安裝方式必須配合專案實際依賴；不要在其他應用直接照搬 omit=optional 而跳過測試。原始 lockfile 不改寫套件節點，這裡不重新解析或升級版本。

### build context 也要限制

.dockerignore 採允許清單，只讓建置所需的來源、版本檔、schema 與指定腳本進 context。node_modules、dist、.test-dist、.data、deploy/local 的 secrets／私鑰與 CI 檔案不會因 COPY . 被意外帶進映像；Dockerfile 也沒有 COPY .。

base digest、lockfile 與 release ID 能幫助辨認輸入，但 apt 套件來源等仍可能變動，不能宣稱每次重建皆逐位元相同。交付時應記錄實際映像 ID；若之後推 registry，還要記錄其 manifest digest。

## 26.3 非 root、唯讀與資源限制

API runtime 以 node 使用者執行，root filesystem 唯讀；只有 /tmp 為 tmpfs。它不需要在啟動時編譯、裝套件或寫匯出檔。

| API 設定 | 本章值／目的 |
|----------|--------------|
| user | node，避免以 root 執行 |
| read_only | true，程式與套件隨映像交付 |
| cap_drop／security_opt | ALL／no-new-privileges |
| memory／CPU／PID | 512 MiB／1 CPU／64 |
| stop_grace_period | 8 秒，大於應用 3 秒關閉期限 |
| init | 轉送信號與回收子程序 |
| healthcheck | Node probe 呼叫 loopback /health/ready |

512 MiB 只是本演練的程序預算，不是容量保證。scrypt 仍保留原成本與最多兩個 KDF，不能為通過容器測試而降低密碼成本；實際流量與記憶體需求要依第 25 章的方法量測。

[check-runtime.sh](examples/26/scripts/check-runtime.sh)會真的檢查 UID、檔案不存在與寫入失敗，再讀取執行中容器的設定，驗證唯讀、資源限制、無公開 API port、沒有來源掛載或環境變數形式的 DB URL。結果只保存必要數值與映像 ID，不把完整 inspect 的主機路徑或環境資訊放進報告。

## 26.4 secret 檔案與啟動設定

開發環境仍接受 DATABASE_URL。部署改用 DATABASE_URL_FILE=/run/secrets/database_url，兩者同時出現，即使其中一個為空也拒絕啟動；沒有猜測 fallback。

[runtime-config.ts](examples/26/src/runtime-config.ts)限制 secret 為絕對路徑、最多 8192 bytes、有效 UTF-8；只接受單一尾端 LF／CRLF，拒絕額外空白與非 PostgreSQL URL。設定錯誤由正式入口輸出固定 startup_failed，不回原始 URL、檔案內容或例外。

NODE_ENV=production 要求 HTTPS APP_ORIGIN；Origin 的完整格式仍由原 AuthOptions 驗證。它是瀏覽器看見的外部來源，本例為 https://localhost:34426，與 Nginx → API 的內部 HTTP 連線不同。

Compose secrets 是授權服務可讀的檔案掛載，不等於自動加密保管庫。[Compose secrets 文件](https://docs.docker.com/compose/how-tos/use-secrets/)

## 26.5 產生本機 CA 與示範 DB 憑證

尚未安裝工具者，先完成[第 00 章 nvm／Node 安裝](00-course-map-and-project-contract.md#004-用-nvm-安裝-node-並執行第一個練習)與[第 01 章 Docker 操作](01-runtime-tooling-and-project-setup.md)。從倉庫根目錄開始：

```bash
cd nodejs-course/examples/26
nvm install
nvm use
docker compose build tools
docker compose up -d --wait test-db
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm run deploy:init
```

init-deploy 在已忽略的 deploy/local 建立隨機 DB 密碼、DB URL、本機 CA、localhost 的 TLS 憑證與私鑰；不修改系統或瀏覽器信任庫。CA 有效 30 天、伺服器憑證 7 天，只供短期本機演練。

再次執行只驗證必要檔案存在並重用，不覆寫密碼／私鑰。部分檔案缺漏會失敗，不能藉重新產生密碼來修復既有 volume；PostgreSQL 的初始密碼檔只在首次初始化資料目錄時使用。

憑證到期不會由deploy:init自動更新；它只重用檔案。需要續期時，保留DB密碼／URL及資料volume，只處理TLS憑證／CA的輪替、驗證鏈與localhost名稱，再重新建立proxy以載入掛載檔案。CA也到期時須另處理信任更新；不要刪除整個deploy/local重新初始化來處理TLS錯誤。這份範例沒有自動續期工作。

本機目錄設為 0700；給非 root 容器讀取的單一掛載檔案為 0444，CA 私鑰留為 0600。上層目錄限制主機其他使用者存取，容器則只取得 Compose 明確授權的檔案；Docker 管理者仍能讀取。這不是正式 secret manager，也沒有自動憑證輪替。

本演練沿用 course 初始化 DB 角色，migration 與 API 共用 DB 憑證；該角色有廣泛權限。實際承載資料前，應分開 DDL 的 migration 身分與只具必要 DML 的 API 身分、改用受管理的秘密與憑證。這份本機設定沒有完成這些環境專屬工作，不能直接視為公開服務的完整安全設定。

## 26.6 migration 成功後，才啟動新服務

先建立本章交付映像：

```bash
docker compose -f compose.production.yaml build api migrate verifier
sh scripts/deploy-local.sh
sh scripts/check-runtime.sh
```

部署腳本的順序固定：

```text
檢查 Compose 設定
  → PostgreSQL healthy
  → 一次性 migrate 工作
  → 只有退出 0，才更新 API／proxy
  → API ready
  → 真正 HTTPS 驗收
```

API 啟動不執行 migrate deploy，不在每個副本搶著 migration，也不自動 seed。migrate 使用獨立映像的 CLI 與原三份 migration。release-task 將 CLI 原始輸出留在程序內，只輸出固定完成／失敗事件；非零結果會讓 set -e 停止後續命令。

若環境已有相容舊服務，migration 失敗時腳本不更新它；若是第一次部署，則不啟動 API。這不代表已執行的 migration 一定自動回滾，也不能保證任意 DDL 對仍在服務的舊版本無影響。

lab:deployment 會在自有隨機 schema 套用原 migration，再於臨時目錄追加一份故意失敗的 migration；它驗證 Prisma 真正失敗、後續啟動標記不存在、原表仍可讀，最後清理自己的 schema。原始三份 migration 完全不改寫。

必要時可執行獨立狀態檢查：

```bash
docker compose -f compose.production.yaml run --rm migrate status
```

pending／失敗會非零，wrapper 不公開 SQL 或 datasource 內容。排查失敗須在受保護的管理通道檢視 migration 記錄；不要將 driver 或 `_prisma_migrations.logs` 原樣貼到公開日誌。也不要用 migrate reset 清空既有資料來「修復部署」。

### seed 必須明確選擇

HTTPS 驗收自己註冊隨機會員，不需要固定密碼帳號。只有本機教學確實需要 Alice／Bob／admin 時才執行：

```bash
docker compose -f compose.production.yaml run --rm -e DEMO_AUTH_SEED=1 migrate seed-demo
```

示範密碼仍含 18，seed 不覆寫既有憑證、角色或文章。此命令不是正式使用者佈建流程，不能把教學帳號當成公開服務帳號。

## 26.7 Nginx TLS 入口與信任邊界

[nginx.conf](examples/26/deploy/nginx.conf)以固定 Nginx 1.30-alpine digest 執行，非 root 101:101，監聽容器內 8080／8443。所有暫存路徑移至 /tmp，root filesystem 唯讀；跳過會修改 /etc 的預設啟動腳本，直接啟動 nginx。

```text
瀏覽器 https://localhost:34426
  → Nginx 終止 TLS
  → 私有 Compose 網路的 http://api:3000
  → Session／CSRF／文章服務
  → 私有 PostgreSQL
```

HTTP 30826 以 308 轉到固定 HTTPS origin，保留路徑與 query；TLS Host 必須為 localhost:34426，錯誤 Host 為 421。proxy_pass 不附 URI，不刻意改寫路徑；應用既有集合尾斜線別名與詳細路徑 strict routing 都要再測。[Nginx reverse proxy 文件](https://docs.nginx.com/nginx/admin-guide/web-server/reverse-proxy/)

Nginx 覆寫 Host／X-Forwarded-Proto，移除 X-Forwarded-For／Forwarded；應用仍不信任這些來源 header。Secure Cookie 由可信 APP_ORIGIN 決定，不靠使用者傳來的 X-Forwarded-Proto。

因此，原本按 socket 來源的認證限流，在這個單 proxy 部署中會讓用戶共享代理來源的每分鐘 20 次配額。本章沒有悄悄打開 trust proxy 或宣稱已完成真實 client IP 限流；要改成依用戶來源，需要先限制可信代理鏈、測試 spoofing，再修改明確契約。

### 路徑、body 與重試

proxy_request_buffering／proxy_buffering 都關閉。16 KiB、UTF-8、JSON、媒體類型與讀取期限仍由應用判斷，過大 body 經 TLS 仍應得到原 413 envelope。proxy 的 client_max_body_size=0 是讓這個限制由應用處理，不代表應用沒有上限。

proxy_next_upstream=off，不讓代理自動重送文章寫入。connect timeout=2 秒、send／read timeout=10 秒，後兩者是 I/O 閒置期限，不是整個請求的硬期限。慢 body、網路錯誤或代理自己拒絕的請求可能在到達應用前結束。

Nginx 自身的 421／502／504 等邊界錯誤不保證有應用 UUID 或 JSON envelope；不能將「經過 TLS」等同「已抵達應用」。access log 只留 status、request_time、upstream_status 與上游 request ID，不寫 URL／query／Cookie／body。一般 error log 可能附帶 request context，因此本例只保留 emerg 啟動錯誤；診斷細節的取得與遮蔽是另行管理的操作。

### 容器替換後的 DNS

Nginx 使用 Docker DNS 127.0.0.11、shared upstream zone 與 resolve，快取 5 秒，使 API 重新建立後能重新解析位址；不是只在 proxy 啟動時記住舊 IP。[Nginx upstream resolve](https://nginx.org/en/docs/http/ngx_http_upstream_module.html#resolve)

單 API 替換仍可能有短暫拒絕／502。這是單副本演練，沒有零停機、負載平衡或跨主機保證。

## 26.8 驗證憑證、Cookie 與 CSRF

```bash
curl --cacert deploy/local/ca.crt -i https://localhost:34426/health/ready
curl --cacert deploy/local/ca.crt -i https://localhost:34426/api/articles
curl -I http://localhost:30826/api/articles
docker compose -f compose.production.yaml run --rm verifier
```

不要使用 -k 或 NODE_TLS_REJECT_UNAUTHORIZED=0 代替信任設定。verifier 載入本機 CA，對 proxy 連線時以 localhost 驗證伺服器名稱；未提供 CA 的連線應失敗。瀏覽器尚未信任此 CA 時會提示不受信任，這不是關閉驗證的理由。

驗收會確認：

- HTTP→HTTPS 308、正式健康與 OpenAPI 可讀、HEAD／尾斜線行為保留。
- 原始外來 request ID 不被當作可信身分，錯誤 body 與回應 UUID 一致。
- `__Host-course_session` 有 Secure、HttpOnly、SameSite=Lax、Path=/，沒有 Domain；登入輪替。
- 精確 Origin＋登入後 CSRF 才能寫入；錯 Origin 或沿用登入前 CSRF 都為 403。
- 註冊固定 member、建立草稿 201／Location、公開端點看不到草稿、發佈後 version=2 並可公開讀取。
- 16 KiB 拒絕、公開 metrics、安全錯誤格式均保留。

.data/production-proof.json 只留驗收結果與公開文章，不含憑證。為驗證跨重啟 Session，另保存 0600 的 `.data/deployment-session.json` 私有 Cookie jar；它不是可分享報告，也不列入 CI artifact。若 Session 已過固定的 30 分鐘，重新跑一般 verifier 建立新驗收基準，不延長 Session。

## 26.9 容器健康不等於整條路徑健康

pg_isready 只確認 DB 能接受連線，不代表 schema 已完成 migration。API 的正式入口仍先檢查必要表；healthcheck 再呼叫 /health/ready，失敗非零。

probe 用 Node HTTP，不另安裝 curl；最多讀 2048 bytes，三秒涵蓋 headers／body，只有 200 才算通過。probe 失敗本身不會自動把 unhealthy 容器重新啟動；單純設 restart policy 也不等於完整健康修復策略。

depends_on 的 service_healthy 控制初次啟動順序，不保證依賴永遠健康，也不等於對 Nginx 實際作了一次 HTTPS 檢查。[Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/)

實際重啟驗收：

```bash
docker compose -f compose.production.yaml restart postgres
docker compose -f compose.production.yaml up -d --wait postgres
docker compose -f compose.production.yaml restart api
docker compose -f compose.production.yaml run --rm verifier --verify
```

公開文章必須與 proof 相同，原 Cookie 仍能查到同一位登入者。程序／映像替換不刪 DB Session；若使用者已過期、登出或被撤銷，則不應以保留 volume 當成繞過認證的理由。

## 26.10 CI 把同一套驗收變成可重複程序

```bash
sh ci/check.sh
```

這個腳本會安裝固定依賴、執行完整 check、建置映像、產生本機演練材料、跑 migration／TLS／runtime 限制，再重啟 DB／API 驗證 Session 與文章。EXIT trap 正常停止本章服務，保留 volume，不使用 down -v；失敗時保留原退出碼。

[ci/workflow.yml](examples/26/ci/workflow.yml)是 GitHub Actions 範例，尚未在本倉庫啟用。要在自己的 GitHub 倉庫採用時，從倉庫根目錄執行：

```bash
mkdir -p .github/workflows
test ! -e .github/workflows/nodejs-course-26.yml
cp nodejs-course/examples/26/ci/workflow.yml .github/workflows/nodejs-course-26.yml
```

已存在時先人工比對，不覆寫。範例使用 GitHub-hosted ubuntu-24.04、contents:read、25 分鐘 job 上限，checkout／upload-artifact 釘完整 SHA，checkout 不保留憑證。它不使用 pull_request_target，不需要 registry／部署 secret，也沒有雲端發布步驟。[GitHub Actions secure use](https://docs.github.com/en/actions/reference/security/secure-use)

artifact 明列三個檔案：OpenAPI、runtime-proof、production-proof；不使用 .data/** 或整章打包，避免上傳 Cookie jar、本機秘密與私鑰。第三方 linter 也只需 workflow 檔或 ci/，不應為了語法檢查提供整個含 secrets 的工作目錄。

本章驗證的是 workflow 語法與相同腳本的本機執行，不宣稱已觸發遠端 GitHub Actions。外部 PR 的執行環境與權限須隔離，不能直接交給持有部署秘密的自架 runner。

## 26.11 記錄映像，再練習相容版本回退

RELEASE_ID 寫進 image label 與 release.json，不是新的 HTTP 功能，也不是身分驗證資訊。runtime-proof 另記錄實際執行中的 image ID；tag 可以被覆寫，不能只用 tag 當成不可變內容證明。

下面以同一份應用程式建立 r1／r2，只改 release metadata，演練選擇已存在映像，不假裝是兩個不同業務版本：

```bash
RELEASE_ID=chapter26-r1 docker compose -f compose.production.yaml build api migrate
RELEASE_ID=chapter26-r1 sh scripts/deploy-local.sh
RELEASE_ID=chapter26-r1 sh scripts/check-runtime.sh
RELEASE_ID=chapter26-r2 docker compose -f compose.production.yaml build api migrate
RELEASE_ID=chapter26-r2 docker compose -f compose.production.yaml run --rm migrate
RELEASE_ID=chapter26-r2 docker compose -f compose.production.yaml up -d --no-deps --no-build api
docker compose -f compose.production.yaml run --rm verifier --verify
RELEASE_ID=chapter26-r1 docker compose -f compose.production.yaml up -d --no-deps --no-build api
docker compose -f compose.production.yaml run --rm verifier --verify
RELEASE_ID=chapter26-r1 sh scripts/check-runtime.sh
```

CI 腳本結束會停 DB，因此開始演練時 deploy-local 會再啟動它。r1 初次 verifier 建立自己的新 Cookie jar／文章基準，r2 與回到 r1 後都檢查相同基準。

沒有執行反向 migration，也不將 DB 還原成較舊 schema。真實版本回退是否可行，取決於新 schema／資料是否仍被舊程式理解；新增可選欄位與刪除／改義欄位的風險不同。若變更不相容，可能需要向前修復或另訂資料還原方案，第 29 章再深入演練。

## 26.12 保留開發快照與原實驗

若要操作與前章相同的 HTTP 開發 API，另用 compose.yaml，與 TLS 部署 DB 完全分開：

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
docker compose restart postgres
docker compose up -d --wait postgres
docker compose restart api
docker compose run --rm tools npm run test:query-persistence
docker compose run --rm tools npm run test:status-persistence
```

不要與會重建 .test-dist 的 check／test 並行執行這些驗收。Compose 的 Cookie／Origin 使用 HTTP 3026，而 TLS 部署使用 HTTPS localhost:34426，不能混用憑證。

## 26.13 測試、練習與停止

完整 check 新增設定／probe 21 項，合計 **40 套、515 項 Jest**（原 494＋21）；兩個真正 worker 另重跑 6 項。末尾增加 lab:deployment 的真實失敗 migration 閘門，之前的外部／效能／交易驗收保留。

### 練習一：哪些東西應進 runtime？

TypeScript、Prisma CLI、編譯後主程式、固定 NDJSON、私鑰、node_modules volume，各應放在哪裡？

<details>
<summary>參考答案</summary>

編譯工具／CLI 在 build 或獨立 migration 階段；runtime 只含主程式依賴與教學檔。私鑰在受控的執行期掛載，不能 COPY 入映像。開發 node_modules volume 不能覆蓋已驗證的 runtime 依賴。

</details>

### 練習二：把 migration 放進每個 API 啟動會怎樣？

三個副本同時更新、其中一個 migration 失敗，還能把另外兩個 ready 視為部署成功嗎？

<details>
<summary>參考答案</summary>

不能。schema 變更應由受控獨立工作執行並決定後續是否更新服務；每個副本自己 migrate 會混合權限、錯誤與並行協調。即使 CLI 有鎖，也不能取代發布順序與相容性設計。

</details>

### 練習三：Secure Cookie 為什麼不能只看 req.secure？

Nginx 後面的 API 收到 HTTP，而瀏覽器使用 HTTPS；若直接信任任何 X-Forwarded-Proto=https，又有什麼問題？

<details>
<summary>參考答案</summary>

內外兩段連線不同。本章由可信 APP_ORIGIN 決定 Cookie 與精確 Origin；隨便信任使用者 header 會把代理邊界交給外部。若未來需要 req.ip／req.secure，必須先明確限制可信代理鏈並測 spoofing。

</details>

### 練習四：tag 回到 r1，DB 就回去了嗎？

r2 已刪除 r1 需要的欄位，再以 --no-build 啟動 r1，會自動恢復欄位與資料嗎？

<details>
<summary>參考答案</summary>

不會。映像選擇不會還原 schema 或資料；必須先評估相容性與回復策略。不能以刪 volume、重跑 seed 或 migrate reset 取代保留真資料的還原方案。

</details>

### 收尾

```bash
docker compose -f compose.production.yaml stop proxy api postgres
docker compose stop performance-lab external-lab upstream api postgres test-db
```

保留 volume、文章、Session、稽核、映像與 proof，不用 down -v。NDJSON 仍是獨立公開教學檔，不是 DB 備份；Cookie jar／secret／私鑰也不能當教材附件分享。

下一章：[27 — 前端串接與 BFF 邊界](27-frontend-integration-and-bff-boundaries.md)：最小前端串接、Cookie／CORS／CSRF、載入錯誤與 BFF 邊界。

---

[上一章：效能與資源上限](25-performance-load-and-resource-limits.md) · [返回課程總覽](README.md) · [本章範例](examples/26/README.md) · [本章契約](examples/26/BASELINE.md)
