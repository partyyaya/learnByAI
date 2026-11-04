# 第 34 章：TypeORM 與 Prisma 對照

[教材](../../34-typeorm-entities-repositories-and-migrations.md) · [契約](BASELINE.md)

從 29 分支，新增 TypeORM0.3.28／@nestjs/typeorm11.0.0，提供真正 Entity／Repository／QueryBuilder／migration／Nest 組裝。無 Redis 需求；不包含 30–32 的 Outbox。先完成 [00 環境](../../00-course-map-and-project-contract.md#004-用-nvm-安裝-node-並執行第一個練習)、[01 Docker](../../01-runtime-tooling-and-project-setup.md)。

在本目錄依序執行：

瀏覽器 Cookie 不按 port 隔離：同一個瀏覽器 profile 存取相同 host 的不同章節，登入 Cookie 可能互相覆寫。建議一次操作一章，或使用不同瀏覽器 profile；CLI／測試的獨立 Cookie jar 不代表瀏覽器也自動隔離。

```bash
docker compose build tools browser-tests
docker compose up -d --wait postgres test-db
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm run db:deploy
docker compose run --rm tools npm run db:status
docker compose run --rm tools npm run db:seed
docker compose run --rm tools npm run seed
docker compose up -d api
```

工作台 `http://127.0.0.1:3034/` 使用 orm-main 與專用 course_orm；PG15434、external3134／upstream3234／performance3334／CORS4034。帳密同18，例如 alice@example.test／Alice-course-18!。project=nodejs-course-34，與其他章 volumes 分開。check 只建立測試 schema，不替開發 DB 部署／seed。

```bash
docker compose run --rm tools npm run test:orm
docker compose run --rm tools npm run lab:orm-runtime
docker compose run --rm browser-tests npm run test:browser
sh ci/check.sh
```

generate 保留 Prisma client 供歷史參考測試編譯；db:deploy／status／seed 全使用 ORM release task。專用 DB history=typeorm_migrations，synchronize／migrationsRun=false。不要執行 Prisma migrate 到 course_orm，也不要把 TypeORM 指向主線 course。

CI 驗證完整 check、TypeORM Chromium、非 root／唯讀 runtime、獨立 migration、TLS／Secure Cookie、PG／API 重啟持久化。正式 HTTP30834／HTTPS34434。未包含 29 的 Prisma 專用備份還原演練；部署驗證不等於已驗證資料災難恢復。

```bash
docker compose -f compose.production.yaml stop proxy api postgres
docker compose stop api cors-lab performance-lab external-lab upstream postgres test-db
```

保留 volumes 與證據，不 down -v、不 stage／commit。私密 deploy/local 與 Cookie jar 不上傳一般 artifact。[回課程總覽](../../README.md)。
