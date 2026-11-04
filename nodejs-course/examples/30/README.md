# 第30章：Redis快取與失效

[教材](../../30-redis-caching-and-invalidation.md) · [契約](BASELINE.md)

以29章為獨立基準，新增ioredis5.8.2／Redis7.2固定digest、Nest Provider與公開文章cache-aside。原文章／留言／Session API及OpenAPI21 paths／38 operations、28.0.0不變。

先完成[00的nvm／Node](../../00-course-map-and-project-contract.md#004-用-nvm-安裝-node-並執行第一個練習)與[01的Docker](../../01-runtime-tooling-and-project-setup.md)，在本目錄依序執行：

瀏覽器 Cookie 不按 port 隔離：同一個瀏覽器 profile 存取相同 host 的不同章節，登入 Cookie 可能互相覆寫。建議一次操作一章，或使用不同瀏覽器 profile；CLI／測試的獨立 Cookie jar 不代表瀏覽器也自動隔離。

```bash
docker compose build tools browser-tests
docker compose up -d --wait postgres test-db cache-redis
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm run db:deploy
docker compose run --rm tools npm run db:seed
docker compose run --rm tools npm run seed
docker compose up -d api
```

工作台3030／PG15430，external-lab3130／upstream3230／performance-lab3330／CORS4030。nodejs-course-30，各章 volume 與測試用 Cookie jar 檔案分開。示範帳密沿用18章，seed不覆寫資料。

命中前仍由PG確認published及版本，單篇／列表以schema與資料指紋區分key；並非零SQL快取。private／admin／Session不入cache，寫入先commit再盡力失效。TTL20–30秒、payload512KiB、同程序合併registry64，Redis離線不排隊、失敗回源。Provider在onModuleInit才啟動連線，關閉與初始化失敗不漏背景重連。

```bash
sh ci/check.sh
```

CI包含完整check、Chromium、映像／TLS／持久化及真Redis stop/restart降級，最後正常停止服務、保留volume。正式入口HTTPS localhost:34430／HTTP30830，API／PG／Redis無主機port；私有本機Redis無密碼，不能直接當完整公開環境設定。沿用29章的PG故障／備份還原；cache不是備份。

```bash
docker compose -f compose.production.yaml stop proxy api postgres cache-redis restore-db
docker compose stop api cors-lab performance-lab external-lab upstream postgres test-db cache-redis
```

不down -v、不stage／commit。[下一章](../31/README.md)。
