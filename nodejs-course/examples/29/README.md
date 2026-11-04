# 第 29 章：故障演練、備份還原與操作手冊

[教材](../../29-capstone-failure-drills-and-operations.md) · [契約](BASELINE.md)

完整獨立快照沿用文章、留言、Session／CSRF、管理稽核與前端，新增真資料庫中斷、custom dump、隔離還原及映像切換。先完成[00 的 nvm／Node](../../00-course-map-and-project-contract.md#004-用-nvm-安裝-node-並執行第一個練習)與[01 的 Docker](../../01-runtime-tooling-and-project-setup.md)，在本目錄執行：

```bash
sh ci/check.sh
```

CI 安裝固定依賴、執行45套／558項Jest、雙worker另6、真Chromium、正式映像／migration／TLS／重啟持久化，再執行故障與備份還原。相同目錄的測試依序執行；結束正常停止自己的服務，保留資料／dump／proof，不用down -v。

繼續使用該次CI映像：

```bash
export RELEASE_ID=local-ci
docker compose -f compose.production.yaml up -d --wait postgres api proxy
curl --cacert deploy/local/ca.crt -i https://localhost:34429/health/ready
docker compose -f compose.production.yaml run --rm verifier --verify
```

HTTPS localhost:34429／HTTP30829；API與PG不公開port。--verify使用私有jar內固定30分鐘Session，過期後需一般verifier建立新基準，不略過認證期限。一般verifier會建立驗收資料，日常探針請用health端點。

手動從乾淨環境部署與演練：

```bash
docker compose build tools browser-tests
docker compose up -d --wait test-db
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm browser-tests npm run test:browser
docker compose run --rm tools npm run deploy:init
docker compose -f compose.production.yaml build api migrate verifier
sh scripts/deploy-local.sh
sh scripts/check-runtime.sh
sh scripts/failure-drills.sh
```

保留當前shell的RELEASE_ID，建置與執行須一致。production專案nodejs-course-29-production，開發專案nodejs-course-29；開發工作台3029／PG15429，外部lab3129／upstream3229／效能lab3329／CORS4029。若要開發工作台，另執行db:deploy、db:seed、seed後up api，操作方式見前章。

故障期live／metrics200、ready503、文章安全500；恢復後原文章／留言／Session保留。備份暫停本機唯一API寫入者，pg_dump保存course DB；還原只連restore-db，在獨立restore_data建立全新restore_*資料庫，無主機port、不覆蓋來源或既有目標。真應用以還原DB驗證readiness、文章、留言、Session與四份migration。

.data/operations-proof.json記錄SHA-256、大小、筆數、故障／恢復與本次備份還原耗時，不代表RTO／RPO保證。dump含密碼雜湊／Session／CSRF，不可分享；.data/backups、私有deployment-session.json、deploy/local都不進Git／映像／artifact。secret／PG角色沿用本機高權限示範，沒有完成正式身分分權、加密異地備份、排程、WAL／PITR或憑證輪替。

```bash
sh scripts/check-image-switch.sh
```

另驗chapter29-r1→r2→r1，兩版只改release metadata；檢查不同image ID與原文章／留言／Session，寫rollback-proof後正常停止production。此結果不代表任意業務版本可回退，映像切換不會反向migration或回復資料。

手動故障腳本失敗可能留下API／proxy停止，先看日誌與退出位置，確認來源schema後才up postgres／api／proxy並--verify；保留失敗dump與隔離目標。CI範本ci/workflow.yml尚未啟用遠端Actions，artifact只明列安全證據，不上傳.data/**。

```bash
docker compose -f compose.production.yaml stop proxy api postgres restore-db
docker compose stop cors-lab api performance-lab external-lab upstream postgres test-db
```

保留volume、文章、留言、Session、稽核、dump、proof及映像，不stage／commit。00–29主線完成；30–34 選修已完成，詳見課程總覽。

驗證紀錄（2026-11-03）：本輪完整check 45套／558項Jest與雙worker另6項通過；最終真Chromium含Session到期後重新登入，原生client含真HTTP body逾時／取消。TLS、runtime限制與重啟持久化通過。管理稽核讀取／登出清除與留言新增刪除也通過。另通過真DB中斷／來源恢復、隔離還原、拒絕覆寫，以及r1→r2→r1不同image ID切換。

前端補驗延後成功回應不清空新草稿／無關編輯；BFF補驗405 Allow、精確JSON media type，以及大小／body期限／取消。
留言補驗等待刪除時切換文章，舊操作不切回先前文章；寫入成功與列表更新失敗分開回報。
備份另驗同名並行工作只有一個成功、原始manifest保留及同大小內容損壞拒絕；還原比較實際migration歷史欄位。

[下一章：Redis 快取與失效](../30/README.md)。
