# 第 27 章：前端串接與 BFF 邊界

[教材](../../27-frontend-integration-and-bff-boundaries.md) · [契約](BASELINE.md)

同源文章工作台、記憶體 CSRF、HttpOnly Session、錯誤／取消／衝突 UI，另有獨立 CORS lab、受測 BFF 讀取邊界與真 Chromium。固定依賴／版本及第 26 章部署流程沿用，沒有新增 JSON API 或框架套件。

先完成[00 的 nvm／Node](../../00-course-map-and-project-contract.md#004-用-nvm-安裝-node-並執行第一個練習)與[01 的 Docker](../../01-runtime-tooling-and-project-setup.md)，在本目錄執行：

```bash
docker compose build tools browser-tests
docker compose up -d --wait postgres test-db
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm browser-tests npm run test:browser
docker compose run --rm tools npm run db:deploy
docker compose run --rm tools npm run db:seed
docker compose run --rm tools npm run seed
docker compose up -d api cors-lab
```

開啟 http://127.0.0.1:3027；CORS 實驗為 /cors.html，對照 http://localhost:3027/cors.html。API／PG=3027／15427，舊 external-lab／upstream／performance-lab=3127／3227／3327，CORS lab=4027。Cookie 不按 port 隔離，使用獨立設定檔／jar。示範帳號／密碼仍沿用 18，seed 不覆寫資料。

```bash
sh ci/check.sh
```

完整 CI 包含 42 套／524 項 Jest、雙 worker 6 項、原生 web client 斷言、真 Chromium、交付映像及 TLS／Session 持久化；同目錄依序跑，不能與清除 .test-dist 的測試交錯。CI 結束正常停止自己的服務並保留 volume。

工作台固定提供 /、/app.js、/api-client.js、/style.css；CORS 教學另有 /cors.html／cors-demo.js。HTML CSP self、no-store、nosniff，內容以 textContent 呈現，不存 browser token／密碼。client 不自動 retry 寫入，timeout 可能結果未知，409 保留輸入。主線沒有開 CORS，OpenAPI 仍 18 paths／32 operations、24.0.0。

BFF 模組只做固定 GET 本人摘要，Cookie 每 request 挑選、無共享私人快取、1 秒／128 KiB／schema 投影、不跟 redirect。Next／Nuxt 為責任對照，未安裝完整框架專案。

browser-tests 使用隔離 Chromium profile＋自有 schema，不開主機 debugging port；--no-sandbox 僅供受控本機測試，不用來瀏覽不可信網站。Chromium／字型來自 apt，不宣稱逐位元固定；Node 24.22.1／npm 11.19.1 與所有套件 lock 節點沿用。browser proof 無憑證；CORS lab 無 DB／文章 API。

部署仍用獨立 nodejs-course-27-production、HTTPS localhost:34427／HTTP 30827；API／PG 不公開 port。runtime 包含 web，仍非 root／唯讀／資源受限，秘密／CA／DB 分權限制見前章與本章教材。

```bash
docker compose stop cors-lab api performance-lab external-lab upstream postgres test-db
docker compose -f compose.production.yaml stop proxy api postgres
```

保留 volume、文章、Session、稽核、proof，不用 down -v，不 staging／commit。

[下一章：專題整合與驗收](../28/README.md)

驗證紀錄（2026-11-03）：本輪完整check 42套／524項Jest與雙worker另6項通過；最終真Chromium含Session到期後重新登入，原生client含真HTTP body逾時／取消。TLS、runtime限制與重啟持久化通過。

前端補驗延後成功回應不清空新草稿／無關編輯；BFF補驗405 Allow、精確JSON media type，以及大小／body期限／取消。
