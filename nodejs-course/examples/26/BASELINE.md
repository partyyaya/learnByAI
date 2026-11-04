# 建置、CI 與部署：第 26 章契約

承接[第 25 章契約](../25/BASELINE.md)。保留文章／認證／權限／版本／稽核／列表／日誌／health／metrics／外部與效能實驗；無新套件、正式端點或 migration。

## 1. 兩個環境

開發 nodejs-course-26：API 3026、PG 15426、external-lab 3126、upstream 3226、performance-lab 3326，APP_ORIGIN=http://127.0.0.1:3026。工具仍使用原始碼與 node_modules volume。

部署 nodejs-course-26-production：HTTPS https://localhost:34426、HTTP 30826，皆主機 loopback；API／PG 不公開 port，獨立 production_data。沒有外部發布、公開 CA、自動續期、跨主機或零停機保證。

正式 OpenAPI 仍 3.1.1、18 paths／32 operations、info.version=24.0.0；沒有新部署 API，servers=/ 同源，HTTP／匯出同一來源。文件 Origin example 為開發 3026，TLS 仍必須精確使用實際 APP_ORIGIN。

## 2. 映像與設定

多階段 tools／dependencies／build／production-dependencies／migration／runtime／verifier。runtime 只含實際主程式閉包、固定 NDJSON、release.json 與必要 production 依賴；無 src、測試、schema／CLI、TypeScript／Jest、seed 或 lab。npm ci 同時 omit dev／optional／peer，不改原 lock 套件節點；必要根相依／JS pg adapter 由真 DB／scrypt／HTTPS 驗證。

runtime user=node、唯讀、/tmp tmpfs、drop ALL、no-new-privileges、512 MiB／1 CPU／64 PID、init、8 秒停止寬限。health probe loopback ready，三秒／2048 bytes，僅 200 成功。invalid production HTTP origin 非零退出，不監聽。

DATABASE_URL／DATABASE_URL_FILE 只能一個來源；檔案路徑絕對、最多 8192 bytes、fatal UTF-8、只移除單一尾端 LF／CRLF，拒絕額外空白、非 PG URL、fragment、缺 DB。錯誤維持固定 startup_failed，不輸出 URL／原始例外。NODE_ENV=production 必須 HTTPS；AuthOptions 仍驗證完整 origin。

.dockerignore 允許清單排除 .data、deploy/local、generated／node_modules／舊 dist；建置不使用正式秘密或 DB。固定輸入不保證 apt 等每次逐位元相同；release ID 是 metadata，實際 image ID 才辨認執行內容，tag 可被覆寫。

## 3. 本機材料與 migration

init-deploy 產生隨機 DB 密碼、本機 CA（30 天）、localhost TLS（7 天）；不修改信任庫。目錄 0700、供非 root 單檔掛載 0444、CA key 0600。完整既有材料只重用、不覆寫，部分缺漏失敗；Compose secret 不等於加密 secret manager。

本演練沿用 course 初始化管理角色，API／migration 共用 DB 憑證，沒有完成 DB 角色分權、受管理秘密或公開環境憑證管理；不可宣稱完整公開生產安全設定。

部署腳本順序：DB healthy → 獨立 migrate 成功 → 更新 API／proxy → 真 HTTPS 驗收。API 不自動 migration／seed，release-task 的 CLI 輸出不公開；失敗非零，set -e 不啟動後續服務。舊服務是否安全仍受 schema 相容性影響，不承諾任意 DDL 回滾。

三份 migration 原檔保留。lab:deployment 只在自有隨機 schema 與臨時 migration 目錄追加失敗 SQL，驗證真正 Prisma 失敗、後續標記不存在、原表可讀，最後關 pool／刪自己的 schema／目錄。不得使用 reset 或刪 volume 解決失敗。

seed-demo 需 DEMO_AUTH_SEED=1，不覆寫憑證／角色／文章；固定密碼中的 18 不變。TLS verifier 自行註冊，不依賴教學帳號。

## 4. Nginx、TLS 與代理界線

Nginx 1.30-alpine 固定 digest，user=101:101、唯讀、暫存全在 /tmp；HTTP 308 到固定 HTTPS origin，TLS Host 只接受 localhost:34426，不符 421。驗收提供 CA 與 localhost servername，不用 -k／關閉驗證。

原路徑傳遞、request／response buffering off、client_max_body_size=0 讓 API 原 16 KiB／解析／讀取期限維持契約；HEAD／集合別名／詳細 strict 路徑仍測。proxy_next_upstream off，不自動重試寫入；connect=2 秒、send／read=10 秒為 I/O 閒置限制。

覆寫 Host／X-Forwarded-Proto，移除 XFF／Forwarded；應用不信任外來 forwarded header。Cookie 由 APP_ORIGIN 產生 __Host- Secure／HttpOnly／SameSite=Lax／Path=/、無 Domain；精確 Origin 與 Session CSRF 不變。來源限流因 socket 來源變 proxy 而共享原每分鐘 20 次配額，未宣稱完成真 client IP／全域限流。

DNS resolver=127.0.0.11、5 秒快取、shared upstream zone＋resolve，API 替換後重解析。單副本仍可能短暫 502；代理自身錯誤不保證應用 JSON／UUID。access log 只留 status、耗時、上游狀態／UUID，不記 URL／query／Cookie／body；error log 僅 emerg 啟動診斷。

## 5. 證據與持久化

verifier 確認 CA 正向／未信任失敗、308、HTTP／UUID 契約、HEAD／路徑、16 KiB、Secure Cookie、登入輪替、錯 Origin／舊 CSRF 403、草稿隔離／201 Location／發佈 version=2、metrics。公開 proof 不含憑證；另寫 0600 私有 deployment-session.json Cookie jar，供 --verify 檢查重啟／替換後相同 Session／公開文章。固定期限仍有效，過期不續期。

check-runtime 檢查實際 UID／檔案不存在／寫入失敗與執行中容器設定；runtime-proof 只保留 image ID、release ID 與必要限制，不保存整份 inspect 的路徑／環境。

r1→r2→r1 練習只改 release metadata，驗證既有映像選擇、相同 DB 與 Session；不是不同業務版本回歸，不執行反向 migration。真實回退需 schema／資料相容性判斷，不能將映像回退當作 DB 還原。

## 6. CI 與停止

ci/check.sh 實作本機等效流程，包含完整 check、建置、migration、TLS、runtime、DB／API 重啟持久化；EXIT trap 正常停止自己的服務、保留退出碼與 volume。

ci/workflow.yml 尚未在本倉庫啟用；供複製採用的 GitHub-hosted ubuntu-24.04 範例。contents:read、完整 action SHA、checkout 不保留憑證、25 分鐘上限，不用 pull_request_target、registry／部署 secret，也不發布。

artifact 僅明列 OpenAPI／runtime-proof／production-proof，不包含 Cookie jar、secret、私鑰或整章。linter 只需 ci/ 或 workflow 檔。驗證本機腳本與語法不等於已觸發遠端 Actions。

全量 Jest 40 套、515 項（原 494＋設定／probe 21），兩 worker 另 6 項；check 順序沿用第 25 章再加 lab:deployment。所有會清除／讀取 .test-dist 的驗收依序執行。

另驗證開發 API、query／status、外部／效能／觀測 Compose 與持久化、NDJSON GET／HEAD。只清理自有 schema；最後正常停止開發六個與部署三個常駐服務，保留 volume／文章／Session／稽核／映像／proof，不用 down -v，不 staging／commit。
