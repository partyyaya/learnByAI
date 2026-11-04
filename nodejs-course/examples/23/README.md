# 第 23 章：外部 HTTP、期限、取消與有限重試

新增獨立 Nest 外部服務實驗，驗證整體／單次期限、body 讀取、取消、有限 GET retry、Retry-After、安全錯誤，以及 POST 已寫入但回應遺失時不自動重送。正式文章 API 與第 22 章契約保留。

[教材](../../23-external-http-timeouts-and-retries.md) · [本章契約](BASELINE.md) · [下一章：日誌與觀測](../24/README.md)

同一 host 的 Cookie 不按 port 隔離；同時練習第 18–23 章時，請各用獨立 curl Cookie jar 或瀏覽器設定檔，避免同名 Session Cookie 覆蓋。詳見[Cookie 與章節端口](../../18-authentication-sessions-and-guards.md#4-cookie-裡放什麼資料庫裡放什麼)。

## 從乾淨環境開始

在本目錄執行：

```bash
docker compose build tools
docker compose up -d --wait postgres test-db
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm run db:deploy
docker compose run --rm tools npm run db:seed
docker compose run --rm tools npm run db:status
docker compose run --rm tools npm run seed
docker compose up -d api upstream external-lab
docker compose run --rm tools npm run test:external-compose
docker compose run --rm tools npm run test:query-api
docker compose run --rm tools npm run test:status-api
```

| 服務 | 主機連線 | 用途 |
|------|----------|------|
| api | http://127.0.0.1:3023 | 既有文章與認證 API |
| postgres | 127.0.0.1:15423 | 既有三份 migration 的開發 DB |
| external-lab | http://127.0.0.1:3123 | 獨立 Nest gateway，無 DB |
| upstream | http://127.0.0.1:3223 | 可控制的本機故障服務，容器內 upstream:4000 |
| test-db | 不公開主機端口 | course_test 的隨機 schema |

Compose 專案 nodejs-course-23 與資料 volume 獨立。APP_ORIGIN=http://127.0.0.1:3023；REFERENCE_ORIGIN=http://upstream:4000 只供獨立 lab，不是使用者任意 URL 輸入。

完整 check 為 35 套、428 項 Jest，包含原 368 項與新增 60 項；build、程序、四個原 lab、查詢、OpenAPI、雙 worker 及外部 HTTP 實驗均依序執行。test／focused／parallel／external 會重建 .test-dist，不能彼此或與程序／查詢實驗並行。

## 只做外部 HTTP 實驗

不需啟動 PostgreSQL，可獨立完成：

```bash
docker compose build tools
docker compose run --rm tools npm ci
docker compose run --rm tools sh -c 'npm run generate && npm run build'
docker compose run --rm -e DATABASE_URL= -e TEST_DATABASE_URL= tools npm run lab:external
docker compose up -d upstream external-lab
docker compose run --rm tools npm run test:external-compose
```

generate／build 仍需產生完整快照所需的 Prisma 型別，但不連 DB。lab:external 在程序內建立 loopback 隨機 port 的 upstream／Nest app，結束時清理；Compose 版本則使用固定 3123／3223，等待真正可回應後驗收。

## 手動觀察

```bash
curl -i http://127.0.0.1:3123/lab/topics/ok
curl -i http://127.0.0.1:3123/lab/topics/retry
curl -i http://127.0.0.1:3123/lab/topics/not-found
curl -i http://127.0.0.1:3123/lab/topics/unavailable
curl -i http://127.0.0.1:3123/lab/topics/slow-body
curl -i http://127.0.0.1:3123/lab/topics/wrong-shape
curl -I http://127.0.0.1:3123/lab/topics/ok
curl -fsS http://127.0.0.1:3223/__lab/stats
```

依序為 200、200（最多三次）、404、503、504、502；HEAD 無 body，但仍呼叫上游。stats 是實驗專用累計資料，不能當作正式服務管理介面。

每個邏輯操作由 client 產生新的 X-Course-Operation，retry 的前三次行為可重複觀察；它不是冪等鍵。POST lost- 範例由驗收腳本執行，先增加上游記憶體計數再斷線，client 只嘗試一次，回 UPSTREAM_WRITE_UNCERTAIN。

## client 策略

- 整體期限 800 ms、單次 250 ms；整體包含 headers、body、退避，不於 retry 重設。
- 每操作最多 3 次 fetch 呼叫；只讓 GET 的已知傳輸／單次逾期與 429／502／503／504 重試。
- full jitter，預設 base 30 ms、cap 200 ms；有效 Retry-After 不提前縮短，超出剩餘預算即停止。
- 每 client 最多 4 個進行中操作，超額立即 503 UPSTREAM_BUSY，不無界排隊。
- 回應最多 4096 bytes，驗證 media type、UTF-8、JSON、schema 與 id，只投影 id／label。
- 不跟 redirect、不接任意 URL、不轉送 Cookie／Authorization／CSRF。POST 不自動重試；取消不代表遠端回滾。

這些都是本章局部策略，不改文章 API、Prisma 交易、全域 Interceptor 或既有 shutdown 契約。

## 測試與證據

```bash
docker compose run --rm tools npm run test:external
docker compose run --rm tools npm run test:baseline
docker compose run --rm tools npm run test:parallel
```

| 檔案 | 責任 |
|------|------|
| src/external-client.ts | 期限、取消、body 限制、schema、安全錯誤與有限重試 |
| src/external-lab.ts | 獨立 Nest Provider／Controller、用戶斷線、工作追蹤與 Filter |
| src/reference-upstream.ts | 本機慢 headers／body、錯誤、重試、斷線與寫入計數 |
| test/external-policy.test.ts | 24 項設定、Retry-After 與 jitter |
| test/external-client.test.ts | 27 項真外部 HTTP、容量、取消、POST 與程式錯誤邊界 |
| test/external-lab.test.ts | 9 項 Nest HTTP、header、HEAD、安全錯誤與 drain |
| scripts/check-external.cjs | 建置後可執行實驗，不用資料庫 |
| scripts/check-external-compose.cjs | 執行中兩個容器的嘗試次數與斷線驗收 |

proof 保存在 .data/external-proof.json 與 .data/external-compose-proof.json，只包含計數、結果與清理事件，不含憑證。外部計數在 upstream 重啟後重設，不是持久通知或稽核紀錄。

## 正式 API、版本與停止

原三個帳號仍為 alice@example.test／bob@example.test／admin@example.test，密碼分別 Alice-course-18!／Bob-course-18!!／Admin-course-18!；18 不更改。seed 需 DEMO_AUTH_SEED=1（Compose 已設定），不覆寫既有資料。

沒有新增套件或 migration。Node 24.22.1、npm 11.19.1、TypeScript 5.9.3、Jest 30.2.0、Express 5.3.0、Zod 4.6.7、Supertest 7.3.1、Nest 11.2.8、Prisma CLI／Client／adapter-pg 7.10.1、pg 8.23.1、PostgreSQL 17 沿用；reflect-metadata 0.2.2、RxJS 7.8.2 與 Express／Multer overrides 保留。

lockfile 除專案名稱外與前章相同。2026-11-02 npm ci audit 為 19 個受影響套件節點（3 low、16 moderate，無 high／critical），未執行 audit fix --force 或升級。

```bash
docker compose restart postgres
docker compose up -d --wait postgres
docker compose restart api
docker compose run --rm tools npm run test:query-persistence
docker compose run --rm tools npm run test:status-persistence
curl -f http://127.0.0.1:3023/api/articles/export -o /tmp/chapter-23-articles.ndjson
curl -I http://127.0.0.1:3023/api/articles/export
docker compose logs --tail 20 external-lab api
docker compose stop external-lab upstream api postgres test-db
```

先成功執行 query-api／status-api 再做重啟比對。NDJSON 仍是獨立公開教學檔，不是資料庫或外部服務備份。正常關閉保留 volume、文章、稽核與 proof，不用 down -v。

## 驗證紀錄（2026-11-02）

- 最終完整 check 通過：35 套、428 項 Jest，原 368 項保留，新增 policy 24、client 27、Nest lab 9；typecheck、build、程序、四個原 lab、查詢、OpenAPI、雙 worker 與 lab:external 全部通過。
- 真實 loopback HTTP 驗證 headers／body 期限、GET 三次上限、Retry-After、字元編碼／大小／schema、redirect 拒絕、取消／退避／容量釋放、錯誤投影與正常 drain。本機 TypeError 不被當成網路故障；原生 fetch／stream 錯誤在 I/O 邊界分類。
- lab:external 於清空 DATABASE_URL／TEST_DATABASE_URL 時仍通過，證明獨立實驗不使用資料庫。proof 顯示 deliveries=1、POST attempts=[1]、active=0，並有 draining → http-drained → closed。
- Compose 的 test:external-compose 通過：retry 收到三次、過長 Retry-After 不提早重送、用戶斷線後 active=0、認證欄位未轉送、HEAD 無 body，POST 回應遺失仍只發一次且 delivery 增加一。
- 教材中的主機 curl 指令已實際執行，3123 依序得到 200／200／404／503／504／502；3223 stats 顯示 active=0、credentialForwarded=false。正式 3023 API 的 /lab/topics/ok 為 404 NOT_FOUND。
- 開發資料庫三份既有 migration deploy／seed／status 成功。query-api、status-api、API／PG 重啟後兩份 persistence 驗收均通過，原文章、Session、權限與稽核契約保留。
- NDJSON 20000 筆、3857788 bytes，GET 與來源 SHA-256 相同；HEAD bytesRead=0，兩者皆 fileClosed=true。實驗與正式 API 日誌未出現示範密碼、Cookie、CSRF、摘要欄位、原始上游 body 或連線字串。
- 測試與查詢實驗的自有 test_／upgrade_ schema 殘留為 0。第 14–22 章共 831 個範例檔案摘要未變；原 HTTP 契約、正式組裝／業務核心、schema／migration 保留，lockfile 除專案名稱外相同。
- 教材、README、契約與導覽檔案連結檢查通過；課程總覽已更新為 00–23 完成，前章下一章連結接上本章。
- external-lab、upstream、api、postgres、test-db 五個容器均正常停止，退出碼 0；gateway 與正式 API 皆正常排空關閉。資料 volume、文章、稽核、文件、計畫、proof 與 NDJSON 保留；未執行 Git staging 或 commit。
