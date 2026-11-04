# 第 28 章：專題功能整合與驗收

[教材](../../28-capstone-feature-integration-and-acceptance.md) · [契約](BASELINE.md)

獨立快照新增留言、owner／admin 刪除、管理員稽核列表、增量 migration、畫面與完整驗收。先完成[00 的 nvm／Node](../../00-course-map-and-project-contract.md#004-用-nvm-安裝-node-並執行第一個練習)與[01 的 Docker](../../01-runtime-tooling-and-project-setup.md)，在本目錄執行：

```bash
docker compose build tools browser-tests
docker compose up -d --wait postgres test-db
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm browser-tests npm run test:browser
docker compose run --rm tools npm run db:deploy
docker compose run --rm tools npm run db:seed
docker compose run --rm tools npm run seed
docker compose up -d api
```

工作台 http://127.0.0.1:3028；PG 15428，external-lab／upstream／performance-lab 3128／3228／3328，CORS lab 4028。專案 nodejs-course-28，Cookie 不按 port 隔離，使用獨立設定檔／jar。Alice／Bob／admin 帳密沿用第 18 章，seed 不覆寫資料。

- 公開留言 GET／HEAD、登入＋CSRF POST：/api/articles/:id/comments。只有 published 可讀／新增，其他狀態一律 404。
- DELETE /api/comments/:id：留言作者或 admin；文章作者沒有額外權限。封存後仍可刪已知 ID；204 無 body，請求也不接受 body。
- 管理員 GET／HEAD /api/admin/articles/:id/status-audits，page／pageSize；member 403。
- content trim 後 1–1000 code points、無 NUL／額外欄位，authorId 取 Session；文章版本／時間／稽核不因留言改動。
- 新增留言與封存共用 Article row lock；列表使用 RepeatableRead，SQL CHECK／FK／索引及升級測試。四份 migration，前三份不變。
- UI 以 textContent 顯示留言，依 API 決定權限；admin 區可依文章 ID 查稽核。OpenAPI 21 paths／38 operations、28.0.0。

```bash
sh ci/check.sh
```

完整 CI 包含 44 套／540 項 Jest、雙 worker另6、真 Chromium 登入／reload／衝突／XSS／留言新增刪除，以及映像／TLS／文章留言 Session 持久化。相同目錄測試依序執行。瀏覽器自有 schema／profile，CDP 不開主機 port；Chromium 的 --no-sandbox 只用於受控容器測試。

部署 nodejs-course-28-production、HTTPS localhost:34428／HTTP 30828；API／PG 無公開 port。版本／lockfile 沿用，runtime 帶 web 而不帶瀏覽器；本機 CA、secret、唯讀非 root 與 DB 角色限制見教材。CI 正常停止自己的服務並保留 volume，遠端 Actions 範本未啟用。

```bash
docker compose stop cors-lab api performance-lab external-lab upstream postgres test-db
docker compose -f compose.production.yaml stop proxy api postgres
```

保留資料與 proof，不用 down -v、不 staging／commit。[下一章：故障與維運](../29/README.md)。

驗證紀錄（2026-11-03）：本輪完整check 44套／540項Jest與雙worker另6項通過；最終真Chromium含Session到期後重新登入，原生client含真HTTP body逾時／取消。TLS、runtime限制與重啟持久化通過。管理稽核讀取／登出清除與留言新增刪除也通過。

前端補驗延後成功回應不清空新草稿／無關編輯；BFF補驗405 Allow、精確JSON media type，以及大小／body期限／取消。
留言補驗等待刪除時切換文章，舊操作不切回先前文章；寫入成功與列表更新失敗分開回報。
