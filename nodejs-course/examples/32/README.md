# 第 32 章：SSE 與 WebSocket

[教材](../../32-sse-websocket-and-connection-lifecycle.md) · [契約](BASELINE.md)

獨立延伸 31；新增 ws 8.18.3，以同一份 PG Notification 提供本人 SSE、WS 與 REST 補讀。Node／npm 與主線版本固定，不需主機安裝套件。先完成 [00 環境](../../00-course-map-and-project-contract.md#004-用-nvm-安裝-node-並執行第一個練習)、[01 Docker](../../01-runtime-tooling-and-project-setup.md)。

在本目錄依序執行，同章 check／browser 不同時執行：

瀏覽器 Cookie 不按 port 隔離：同一個瀏覽器 profile 存取相同 host 的不同章節，登入 Cookie 可能互相覆寫。建議一次操作一章，或使用不同瀏覽器 profile；CLI／測試的獨立 Cookie jar 不代表瀏覽器也自動隔離。

```bash
docker compose build tools browser-tests
docker compose up -d --wait postgres test-db cache-redis job-redis
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm run db:deploy
docker compose run --rm tools npm run db:seed
docker compose run --rm tools npm run seed
docker compose up -d api worker dispatcher
```

工作台 `http://127.0.0.1:3032/`，登入後開 `/notifications.html`。帳密沿用 [18](../../18-authentication-sessions-and-guards.md)，例如 alice@example.test／Alice-course-18!。先建立並發佈文章，再觀察站內通知。job-redis 與 cache-redis 各自隔離；job volume 保留，test-db 使用 tmpfs。

PG15432；external3132／upstream3232／performance3332／CORS4032。Compose project=nodejs-course-32，各章 node_modules、資料庫、queue prefix、TLS 材料及測試用 Cookie jar 檔案不共用。

```bash
docker compose run --rm browser-tests npm run test:browser
sh ci/check.sh
```

CI 驗證完整測試、worker 真 SIGKILL／stalled 回復、Chromium EventSource／WS、正式 HTTPS／WSS 與 Origin 拒絕、Redis 故障回源、PG 故障／隔離還原。正式 HTTP30832、HTTPS34432，其他服務無主機 port。`deploy/local` 為本機私密材料，`.data` 部分檔案是 Cookie jar，僅上傳 workflow 明列的 proof。

通知是站內資料，不寄外部訊息。每程序最多 32 條、每人 2 條即時連線；不是跨節點總額度。500ms PG 輪詢是有界教學實作，需評估容量後才能增加規模。

```bash
docker compose -f compose.production.yaml stop proxy api worker dispatcher job-redis cache-redis postgres restore-db
docker compose stop api worker dispatcher job-redis cache-redis cors-lab performance-lab external-lab upstream postgres test-db
```

保留 volumes、dump 與證據，不 down -v，不 stage／commit。[下一章](../33/README.md)。
