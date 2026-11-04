# 第31章：BullMQ、Outbox與冪等通知

[教材](../../31-background-jobs-outbox-and-idempotency.md) · [契約](BASELINE.md)

承接30，新增BullMQ5.58.5、@nestjs/bullmq11.0.4與第五份Prisma migration。發佈＋稽核＋Outbox同交易；dispatcher與Nest worker分程序，只建立本機站內通知，不對外寄信。

先完成[00環境](../../00-course-map-and-project-contract.md#004-用-nvm-安裝-node-並執行第一個練習)／[01 Docker](../../01-runtime-tooling-and-project-setup.md)，本目錄依序：

瀏覽器 Cookie 不按 port 隔離：同一個瀏覽器 profile 存取相同 host 的不同章節，登入 Cookie 可能互相覆寫。建議一次操作一章，或使用不同瀏覽器 profile；CLI／測試的獨立 Cookie jar 不代表瀏覽器也自動隔離。

```bash
docker compose build tools browser-tests
docker compose up -d --wait postgres test-db cache-redis job-redis
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm run db:deploy
docker compose run --rm tools npm run db:seed
docker compose run --rm tools npm run seed
docker compose up -d api dispatcher worker
```

工作台3031／PG15431，lab3131／3231／3331／4031。Redis無主機port；cache可淘汰，job-redis採noeviction＋AOF everysec＋獨立job_data。示範帳密仍沿用18，不共用其他章 volume／測試用 Cookie jar 檔案。

GET／HEAD /api/me/notifications：Session、只查本人，after非負int64字串／limit1–50，no-store。OpenAPI22 paths／40 operations、31.0.0。

```bash
docker compose run --rm tools node dist/queue-operator.js status
docker compose run --rm tools npm run lab:queue-lifecycle
sh ci/check.sh
```

Queue operator只列計數與最多20個failed event ID；人工retry語法見教材。測試用隨機queue prefix／自有schema，僅清理自己，無FLUSHALL。原生lifecycle驗真正active worker SIGKILL與stalled recovery、單筆通知及正常重啟關閉。

lease領取10筆／10秒；jobId固定event，資料庫Notification.eventId唯一；逾30秒未完成也會reconcile重建遺失job。failed job需先修復原因再人工retry。此範例的DB冪等不保證任意外部副作用exactly-once。

production HTTPS34431／HTTP30831，queue-runtime為獨立精簡worker／dispatcher映像。CI包含完整check、Chromium、TLS、Redis／PG故障及含Outbox／Notification的隔離還原；最後停止服務保留所有volume／proof。秘密、CA、高權限課程角色與同機備份限制沿用26／29。

```bash
docker compose -f compose.production.yaml stop proxy api worker dispatcher postgres job-redis cache-redis restore-db
docker compose stop worker dispatcher api cors-lab performance-lab external-lab upstream postgres test-db job-redis cache-redis
```

不down -v、不stage／commit。[下一章](../32/README.md)。
