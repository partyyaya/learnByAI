# 第 33 章：Fastify adapter 與平台比較

[教材](../../33-fastify-adapter-and-platform-boundaries.md) · [契約](BASELINE.md)

從 29 分支，保留 Prisma／PostgreSQL，新增 Fastify 5.11.3、@nestjs/platform-fastify 11.2.8、@fastify/cookie 11.0.2。不需 Redis；33 不包含 30–32 的通知功能。先依 [00](../../00-course-map-and-project-contract.md#004-用-nvm-安裝-node-並執行第一個練習)與 [01](../../01-runtime-tooling-and-project-setup.md)準備 nvm／Docker。

在本目錄依序執行：

瀏覽器 Cookie 不按 port 隔離：同一個瀏覽器 profile 存取相同 host 的不同章節，登入 Cookie 可能互相覆寫。建議一次操作一章，或使用不同瀏覽器 profile；CLI／測試的獨立 Cookie jar 不代表瀏覽器也自動隔離。

```bash
docker compose build tools browser-tests
docker compose up -d --wait postgres test-db
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm run db:deploy
docker compose run --rm tools npm run db:seed
docker compose run --rm tools npm run seed
docker compose up -d api
```

`http://127.0.0.1:3033/` 實際啟動 fastify-main，登入帳密沿用 18，例如 alice@example.test／Alice-course-18!。PG15433、external3133／upstream3233／performance3333／CORS4033。project=nodejs-course-33，各章資料與安裝 volume 分開。

```bash
docker compose run --rm tools npm run lab:platform
docker compose run --rm browser-tests npm run test:browser
sh ci/check.sh
```

check 包含兩平台相同的 66 項契約、歷史測試與分程序比較。`.data/platform-comparison.json` 僅供同工作負載觀察，無速度門檻；不可由一次短測宣稱 Fastify 一定更快。Chromium 及正式 TLS 實際使用 Fastify，正式 HTTP30833／HTTPS34433。

CI 含建置、migration、重啟持久化、PG 故障與隔離還原；runtime 檢查 fastify-main。開發安裝與執行在 Docker；不在主機 npm install，不更動固定版本。

```bash
docker compose -f compose.production.yaml stop proxy api postgres restore-db
docker compose stop api cors-lab performance-lab external-lab upstream postgres test-db
```

只停止本章，不 down -v，不 stage／commit。私密材料與 Cookie jar 不上傳為一般 artifact。[下一章](../34/README.md)。
