# 29 — 專題故障演練、備份還原與操作手冊

> 驗收包含故障發生時的行為，以及用保留下來的資料重新提供正確服務。

承接[第 28 章](28-capstone-feature-integration-and-acceptance.md)，本章提供[完整獨立快照](examples/29/README.md)。業務 API 不變，OpenAPI 維持 21 paths／38 operations、28.0.0；新增操作工具、隔離還原服務與演練證據，完成 00–29 主線。

完成後你應能：

- 依症狀區分 API 存活、資料庫就緒與整條 HTTPS 路徑。
- 說明正常 drain、期限中斷、外部 timeout 與寫入結果不確定的差別。
- 實際停止 PostgreSQL，驗證安全失敗，再恢復原資料與 Session。
- 建立 custom-format DB 備份，還原到隔離的新資料庫並啟動應用驗證。
- 分清映像回退、schema 相容、資料還原與可接受的資料損失。

## 29.1 先看本章會動到哪裡

| 環境 | 入口／資料 | 用途 |
|------|------------|------|
| nodejs-course-29 | API3029／PG15429，自己的開發 volume | 套件、測試與 HTTP／效能 lab |
| nodejs-course-29-production | HTTP30829／HTTPS localhost:34429，production_data | 本機 TLS、持久化與故障來源 |
| 同 production 網路的 restore-db | 沒有主機 port，獨立 restore_data | 只接收新名稱資料庫的還原 |
| .data/backups | 私有 dump 檔，每次唯一名稱 | 保存 DB snapshot，不放入 Git／映像／artifact |

API、來源 PG、restore-db 都不把 DB port 公開給主機。備份 job 的來源 host 固定 postgres；還原 host 固定 restore-db，目標名稱必須是 restore_ 加 12 個十六進位字元。它不接受任意 URL／shell SQL，也不使用 --clean 覆蓋既有 DB。這些限制同時存在於 Node 計畫驗證與 shell 工作中。

這是單機 Compose 演練，來源與還原 volume 仍在同一台 Docker 主機；它能驗證還原流程，不能抵抗整台主機或磁碟遺失。真實保存策略還需要異地副本、加密、保留期限、權限及定期還原驗證。

## 29.2 從乾淨環境跑完整驗收

未安裝工具，先完成[00 的 nvm／Node](00-course-map-and-project-contract.md#004-用-nvm-安裝-node-並執行第一個練習)與[01 的 Docker](01-runtime-tooling-and-project-setup.md)。從倉庫根目錄：

```bash
cd nodejs-course/examples/29
nvm install
nvm use
sh ci/check.sh
```

CI 會建立工具映像、npm ci、generate／typecheck／Jest／build、程序與外部 lab、真 Chromium、正式映像、migration、TLS 與重啟驗證，最後執行資料庫中斷和備份還原。需要 Docker Compose／網路下載套件及映像，不要求主機自行安裝 PostgreSQL、Prisma 或 Chromium。

完整 check 為 **45 套／558 項 Jest**（前章540＋操作目標／備份完整性驗證18），雙 worker另6項。瀏覽器、信號程序、HTTP lab、production 與還原驗證另計。同目錄不能平行跑會重建 .test-dist 的指令。

CI 結束會正常停止本章服務，保留 volume、dump 與證據。首次驗收使用 local-ci release；若要繼續檢查該次結果：

```bash
export RELEASE_ID=local-ci
docker compose -f compose.production.yaml up -d --wait postgres api proxy
curl --cacert deploy/local/ca.crt -i https://localhost:34429/health/ready
docker compose -f compose.production.yaml run --rm verifier --verify
```

登入 Session 為固定30分鐘；超過期限後 --verify 應失敗，先執行一般 verifier 建立新的測試使用者／文章／留言與私有 Cookie jar，再做短時間內的持久化驗證。不能為了通過測試而延長或跳過到期判斷。

## 29.3 需要手動部署時

不跑整套 CI 也可依序準備正式演練：

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

每條命令須成功才繼續；腳本內使用 set -eu。一般 verifier 會建立新的驗收資料，不是唯讀探針；日常讀取健康請用 /health/live、/health/ready，重驗既有資料用 --verify。

deploy:init 新增 0600 的 pgpass，供一次性 PG 工具使用，不在命令列列出密碼。既有秘密會重用；必要檔案缺漏就停止，不能刪除 secret 或重生密碼來「修復」仍存在的資料 volume。[PGPASSFILE 的格式與權限](https://www.postgresql.org/docs/17/libpq-pgpass.html)由 PostgreSQL 用戶端處理。

本章獨立快照應自行產生材料；從其他章手動帶來的舊 deploy/local 不會自動升級。CA／TLS 為本機短期演練，沿用30天／7天有效期，沒有自動輪替或系統信任庫安裝。

## 29.4 先用證據判斷故障

| 症狀 | 檢查 | 判讀／下一步 |
|------|------|--------------|
| 連不上 HTTPS | compose ps、proxy logs、主機 port、憑證名稱／期限 | 先確認代理與 TLS，不關閉憑證驗證 |
| live200、ready503 | PG狀態、API安全日誌、migration紀錄 | 程序還活著，依賴或schema未就緒 |
| live／ready200，但特定請求500 | request ID、錯誤事件、固定route metrics | 查該條操作；不要只重啟所有容器 |
| 正常200但延遲升高 | bounded metrics、pool等待、事件迴圈／CPU | 依25章分辨排隊、I/O與CPU |
| 寫入403 | Cookie、精確Origin、CSRF輪替、角色 | 不以放寬CORS或略過Guard修復 |
| 修改409 | expectedVersion、最新狀態 | 保留輸入，重新讀取；不自動覆蓋 |
| 代理502／用戶端斷線 | 服務切換、drain、上游程序 | 寫入可能已提交，先查結果再決定 |

```bash
docker compose -f compose.production.yaml ps
docker compose -f compose.production.yaml logs --tail=50 api proxy postgres
curl --cacert deploy/local/ca.crt -i https://localhost:34429/health/live
curl --cacert deploy/local/ca.crt -i https://localhost:34429/health/ready
curl --cacert deploy/local/ca.crt https://localhost:34429/health/metrics
```

分享診斷資訊前只保留必要事件；不分享 docker inspect 的完整環境、secret、Cookie jar、DB dump 或任意原始 body。公開 metric label 維持有限 route template，不把使用者 ID／request ID／完整 URL 放進 label。

## 29.5 真正停掉資料庫，再恢復

[scripts/failure-drills.sh](examples/29/scripts/failure-drills.sh)先用 HTTPS 建立新基準，再停止本章 production 的來源 PostgreSQL：

```bash
docker compose -f compose.production.yaml run --rm verifier
docker compose -f compose.production.yaml stop postgres
docker compose -f compose.production.yaml run --rm verifier --db-unavailable
docker compose -f compose.production.yaml up -d --wait postgres
docker compose -f compose.production.yaml run --rm verifier --verify
```

故障期實測契約：

- /health/live=200：程序仍可回應。
- /health/ready=503 NOT_READY：不應接新的業務流量。
- /health/metrics=200：基本觀測仍可取得。
- /api/articles=500 INTERNAL_ERROR：目前 API 的安全未知錯誤契約，不公開 SQL／stack／URL。

本章沒有把所有 DB 錯誤新改成503，也沒有自動重啟 unhealthy API。Compose service_healthy 控制啟動順序，並非持續流量調度器；Nginx 也沒有完整就緒摘流機制。因此故障期公開業務請求仍可能到 API 並失敗。

來源 PG 恢復後，--verify 比較原文章內容、留言及原 Session 身分，確認沒有靠重跑 seed 或重建 volume 產生「看起來相同」的資料。故障觀察保存為 .data/database-outage-proof.json。

## 29.6 正常關閉、逾時與結果不確定

正常關閉仍沿用07、22、24章的程序實驗：

```text
SIGTERM／SIGINT
  → draining，不再接受新業務
  → 等待已接收HTTP與已登記工作
  → 關閉Nest／資源／DB pool
  → closed，退出0
```

若期限到達，記錄 deadline、有界中斷，退出非零；不得因 response close／Observable finalize 就提前關閉還在使用的 pool。SHUTDOWN_TIMEOUT_MS=3000，API 的 Compose stop_grace_period=8s；proxy 先 SIGQUIT，允許有界完成代理請求。

```bash
docker compose run --rm tools npm run test:runtime
```

這會在自有 fixture 以真子程序驗證空閒停止、進行中上傳完成、重複信號只關一次，以及掛住上傳超時中斷；另驗無 DB／未完成 migration 時拒絕監聽。測試不是對開發資料庫發任意 kill。

外部 timeout 的可控制重現沿用23章：

```bash
docker compose run --rm tools npm run lab:external
```

它驗證整體／單次期限、取消、最多三次且只針對允許條件的 GET retry，以及 POST 已被 upstream 接收卻遺失回應時只嘗試一次。文章／留言寫入同樣不自動 retry；request ID 用於追蹤，不能當成去重或 exactly-once 保證。

## 29.7 備份哪些資料？

[backup-task.sh](examples/29/deploy/backup-task.sh)使用固定 PostgreSQL17工具，pg_dump --format=custom --no-owner --no-acl 備份來源 course DB。包含 User、Session、Article、ArticleStatusAudit、Comment、schema／約束／索引與 _prisma_migrations。

pg_dump 可在並行存取時產生一致的資料庫備份；本章另外暫停 proxy／API，是讓「備份前筆數」與 dump snapshot 可以直接比較，並非 pg_dump 本身要求停站。[PostgreSQL17 pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html)

本機演練只有這一組應用寫入者；若有其他 worker／管理工具繼續寫入，單純停止 API 不足以凍結資料。真實線上方案須另設計一致性標記或共享 snapshot，不可照抄筆數比較就宣稱涵蓋所有並行寫入。

dump **包含密碼雜湊、Session及CSRF**，不是可公開教材附件。檔案目錄0700、工作umask077；不輸出內容、不上傳CI artifact、不進Docker build context。這些權限不能取代備份加密與異地存放。

此單一DB dump不包含全域角色／tablespace、TLS私鑰、secret manager、主機設定或外部物件；--no-owner／--no-acl 也不重建原擁有者與權限。恢復環境的身分／設定必須另外管理。NDJSON仍是獨立公開教學檔，不能用它恢復資料庫。

## 29.8 還原到隔離目標，讓應用讀一次

完整流程由 failure-drills.sh 執行：

```text
停止proxy／API，保留來源PG
  → prepare-drill產生唯一dump／restore DB名稱與私有證據檔
  → snapshot記錄來源表筆數、文章／留言／Session及migration
  → pg_dump以noclobber原子方式開啟全新檔案，記錄原始manifest
  → 啟動原API／proxy，以HTTPS確認來源恢復
  → 啟動獨立restore-db
  → createdb建立全新目標，既有DB拒絕覆寫
  → 先比對原始SHA-256／bytes，再pg_restore --single-transaction --exit-on-error
  → 在還原DB啟動同一個應用，真HTTP驗證
  → 記錄SHA-256、大小、筆數與本次耗時
```

備份不用「先test檔案不存在，再pg_dump開啟」的兩步檢查，因為兩個程序可能都通過檢查後同時覆寫。shell使用noclobber原子建立輸出；演練刻意讓兩個同名備份競爭，只容許一個成功，另一個非零退出。失敗可能留下不完整檔案，仍保留供診斷，不將它當成完成備份。

還原命令固定連 restore-db，不使用 --clean／--create 重新導向來源名稱。pg_restore 的 custom archive、交易與遇錯停止選項可對照[官方說明](https://www.postgresql.org/docs/17/app-pgrestore.html)。演練也再次嘗試相同dump／目標，以及非十六進位名稱，確認一律非零退出且不覆寫。若失敗，保留目標與dump供檢查；下一次計畫使用新名稱，不清空失敗目標。

[check-operations-data.cjs](examples/29/scripts/check-operations-data.cjs)不只看退出碼：

1. 比較五個業務／認證表筆數，以及migration名稱、checksum、完成／回滾時間與applied steps等原始歷史；不能只因筆數都是4就認定歷史相同。
2. 比較基準文章與留言的所有回應欄位／時間值。
3. 將私有jar的Session token在記憶體雜湊，確認還原DB對應user、未撤銷且未過期。
4. 以還原DB啟動真正Nest應用，請求ready、公開文章、留言列表、目前使用者，確認200與身分。

此應用只在驗證容器的隨機loopback port接收請求，不將原Cookie輸出。測試完成關閉HTTP／Nest／DB；這是隔離功能驗證，沒有把還原DB自動切成線上服務，也沒有額外宣稱測過還原端的完整TLS入口。

本章沿用本機course高權限角色，來源、備份與還原共用示範密碼；一次性工具用root讀取明列掛載的私有檔。實際環境應分開API、migration、備份／還原身分與網路授權，不能把這套演練的廣泛權限直接搬到公開服務。

## 29.9 證據、耗時與恢復目標

| 檔案 | 內容／可見性 |
|------|-------------|
| .data/operations-proof.json | dump檔名、SHA-256、bytes、backupRestoreElapsedMs、故障／來源恢復及還原結果 |
| .data/backup-manifest.json | 備份完成時的原始SHA-256／bytes及計畫識別；還原前及最後報告均須比對 |
| .data/restore-proof.json | 隔離DB名稱、表筆數、應用與Session驗證結果 |
| .data/source-recovery-proof.json | 原來源HTTPS驗證完成時間及公開資料ID |
| .data/browser-proof.json／runtime-proof.json／production-proof.json | 瀏覽器、容器限制及TLS結果 |
| .data/deployment-session.json | 0600私有Cookie jar；不可分享 |
| .data/backups/*.dump、deploy/local | 私有備份／憑證；不可分享或上傳 |

備份完成後以串流計算原始manifest，避免把整份dump讀入記憶體。--record-backup不會覆寫已記錄的不同雜湊；還原前--verify-backup及--finish都重新串流比對，檔案即使大小相同、只改一個byte也失敗，不會把新的雜湊當作舊備份的成功證據。原生lab:backup-integrity以自有合成檔驗證，完全不改動保留中的真實dump。

operations-proof只在前面命令全部成功後寫出；讀取實際故障／來源恢復檔，確認還原各項為true。SHA-256可用來發現檔案內容改變，但不能單獨證明來源可信或還原完整。

backupRestoreElapsedMs從建立計畫到最後驗證，包含停站備份、啟動及工具時間，不是SLO、最大RTO或整次故障的端到端耗時。RTO是業務能接受多久不能服務；RPO是能接受遺失多少近期資料。本章沒有排程備份、WAL封存／PITR、跨機房切換或零資料損失保證。

舊備份中的Session可能已過期或撤銷狀態落後，還原到真環境前需決定是否統一撤銷，而不是因驗證中短時間Session可用，就承諾所有登入都應復活。

## 29.10 映像回退前先檢查相容性

選擇舊映像只切換程式，不會反向migration或回復已刪資料。先記錄當前image ID、release、schema版本及備份時間，判斷舊程式能否讀寫目前資料，再決定相容回退、向前修復或資料還原。

以下兩版只改release metadata，schema與業務程式相同，練習映像切換與Session保留；不是跨業務版本相容性的證明：

```bash
export RELEASE_ID=chapter29-r1
docker compose -f compose.production.yaml build api migrate verifier
sh scripts/deploy-local.sh
sh scripts/check-runtime.sh
export RELEASE_ID=chapter29-r2
docker compose -f compose.production.yaml build api migrate
docker compose -f compose.production.yaml run --rm migrate
docker compose -f compose.production.yaml up -d --wait --no-deps --no-build api
docker compose -f compose.production.yaml run --rm verifier --verify
export RELEASE_ID=chapter29-r1
docker compose -f compose.production.yaml up -d --wait --no-deps --no-build api
docker compose -f compose.production.yaml run --rm verifier --verify
sh scripts/check-runtime.sh
```

也可執行 `sh scripts/check-image-switch.sh` 完成同一流程，檢查兩個不同image ID與回到原ID，寫入 .data/rollback-proof.json 後正常停止本章production服務。

同時保留兩個image ID，確認切換確實不同；tag可被覆寫，不能把名稱當成不可變內容。保留來源volume，不跑反向migration，不將還原DB拿來覆蓋來源。若新版曾移除舊版需要的欄位，這組回退步驟就不適用；需要另外驗證expand／contract的相容窗口。

## 29.11 演練失敗時怎麼處理？

腳本遇錯停止；CI的EXIT trap停止本章服務並保留資料。手動failure-drills沒有「忽略失敗繼續對外服務」的trap，若在備份階段失敗，API／proxy可能仍停著。先看退出位置與安全日誌，保留dump／目標，確認來源PG與schema後恢復：

```bash
docker compose -f compose.production.yaml up -d --wait postgres
docker compose -f compose.production.yaml up -d --wait api proxy
docker compose -f compose.production.yaml run --rm verifier --verify
```

若只是Session超過30分鐘，應讀公開文章／留言確認資料，再以一般verifier建立新基準；不能把過期登入當成資料遺失，也不能略過驗證就標記還原成功。來源尚未就緒或migration失敗時，先修復明確原因，不重置DB、不重跑seed覆蓋憑證。

## 29.12 練習與主線驗收

### 練習一：ready503就應殺掉API嗎？

<details>
<summary>參考答案</summary>

不一定。PG短暫不可用時程序仍可觀測並等待依賴恢復；無條件重啟所有副本可能增加負載。先分辨live、ready與業務錯誤，再設計摘流／重試／恢復政策。

</details>

### 練習二：備份命令成功等於可恢復嗎？

請列出至少三個額外驗收項目，並實際執行隔離還原。不要拿正式來源試 --clean。

<details>
<summary>參考答案</summary>

檔案完整性、schema／migration歷史、必要資料內容與筆數、認證到期／撤銷條件、應用HTTP可用性，以及外部設定是否備妥。退出0或只看dump大小都不足夠。

</details>

### 練習三：前端送出留言後斷線

若伺服器已提交，但瀏覽器沒有收到201，立即retry會發生什麼？如何向使用者呈現並查證？

<details>
<summary>參考答案</summary>

可能建立重複留言。本課保留輸入、顯示結果未確認，先重新讀取列表協助查證；沒有可讓重試自動去重的冪等鍵或內容唯一約束，不能承諾可靠自動判定同一次操作。

</details>

### 練習四：把RTO／RPO寫成需求

假設只能容忍15分鐘資料損失、30分鐘停機，說明每天一次dump為何不足，還需要哪些保存／恢復機制與定期演練。這是設計題，本章沒有實作WAL／PITR或排程。

完成主線時應能從需求追到HTTP、Guard、交易、資料庫與畫面；提出成功、越權、版本競爭、取消、故障及恢復的可執行證據。接下來的30–34章為選修，先確保目前單體能正確運作，再加入快取、工作佇列或其他平台。

```bash
docker compose -f compose.production.yaml stop proxy api postgres restore-db
docker compose stop cors-lab api performance-lab external-lab upstream postgres test-db
```

只停止本章服務，保留來源與還原volumes、文章、Session、留言、稽核、dump及proof；不用down -v，不stage／commit。下一章為 [30：Redis 快取與失效策略](30-redis-caching-and-invalidation.md)。

---

[下一章：Redis 快取](30-redis-caching-and-invalidation.md) · [上一章：功能整合與驗收](28-capstone-feature-integration-and-acceptance.md) · [課程總覽](README.md) · [本章範例](examples/29/README.md) · [本章契約](examples/29/BASELINE.md)
