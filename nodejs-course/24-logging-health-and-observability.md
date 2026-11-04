# 24 — 結構化日誌、request ID、敏感資料遮蔽、健康／就緒與基本指標

> 從一個失敗回應找到對應事件，再判斷是依賴失效、傳輸中斷，還是服務正在關閉。

前置：[第 07 章程序生命週期](07-process-signals-and-graceful-shutdown.md)、[第 19 章錯誤與回應邊界](19-interceptors-filters-and-cross-cutting-concerns.md)、[第 22 章測試隔離](22-testing-modules-database-and-http.md)與[第 23 章外部 HTTP](23-external-http-timeouts-and-retries.md)。本章的[完整快照](examples/24/README.md)可獨立啟動，不必先執行舊章服務。

完成本章後，你應能：

- 用同一個 request ID 對照錯誤回應、錯誤分類、傳輸結束與匯出清理。
- 建立一行一個 JSON 的日誌，透過可注入輸出介面測試，明確限制可記錄欄位。
- 區分 HTTP 已送出的狀態與應用錯誤分類，不把串流中斷當成成功下載。
- 分清 live、ready、資料庫故障與 draining，避免故障時反覆重啟仍可工作的程序。
- 讀懂計數、耗時 histogram 與進行中工作，避免無界 label。
- 用真 HTTP、PostgreSQL 故障與可控制替身驗證觀測結果及資源清理。

本章沒有新增套件或 migration。文章權限、Session、CSRF、版本與稽核交易沿用；外部服務實驗仍獨立。新增正式端點 `GET／HEAD /health/metrics`，公開範圍與格式見下文及 [BASELINE](examples/24/BASELINE.md)。OpenAPI 更新為 18 paths／32 operations，info.version 為 24.0.0。

## 24.1 日誌、指標與業務稽核各回答什麼？

假設使用者讀文章時得到 `500 INTERNAL_ERROR`。只有「出了錯」的文字，很難知道哪一次請求失敗；把整份 request 或 Error 印出，又可能留下密碼與連線字串。

| 資料 | 要回答的問題 | 本章實作 |
|------|----------------|----------|
| 日誌 | 某次請求發生什麼事？ | 有限欄位的 JSON 事件與 request ID |
| 指標 | 最近累計多少成功／失敗？多少工作尚未結束？ | 程序內 counter、histogram、gauge |
| 狀態稽核 | 哪位操作者成功改變了文章狀態？ | 原 ArticleStatusAudit，與文章同交易 |

日誌可能因輸出失敗或背壓被丟棄，不能拿來取代第 20 章的交易稽核。指標會在程序重啟後歸零，也不是永久歷史。本章不建立分散式 tracing 平台；request ID 只串接本服務的一次 HTTP 請求，不會自動穿越上游與其他服務。

文字流程如下：

```text
收到可由 Node 解析的 HTTP 請求
  → 服務產生 UUID，設定 X-Request-ID，HTTP in-flight +1
  → middleware → Guard／Pipe → Controller／Service
  → 若發生錯誤，記錄安全分類 http_error
  → response finish 或提前 close：只記一次 request_completed
  → HTTP in-flight -1，更新次數與耗時
  → 如仍有檔案 finally／Promise 工作，繼續等待並記錄清理結果
```

HTTP parser 在 request 事件之前就拒絕的封包，不在這份 HTTP 應用指標內。`finish` 表示 Node 已將資料交給底層傳送，不保證用戶已完整收到或讀取；`close` 若先於 finish，記為 interrupted。[Node HTTP 的 finish／close 語意](https://nodejs.org/docs/latest-v24.x/api/http.html#event-finish_2)

## 24.2 先設計事件，再挑選輸出工具

Nest 可使用自訂 logger 與依賴注入；但提供 logger 並不會自動替每個欄位決定公開範圍。[Nest Logger 文件](https://docs.nestjs.com/techniques/logger)

本章沿用原有依賴，在 [observability.ts](examples/24/src/observability.ts)定義小型輸出介面：

```ts
export type LogSink = (line: string) => void | boolean;
const observation = createObservability(line => {
  process.stdout.write(line + '\n');
});
```

這段是介面示意；正式 [main.ts](examples/24/src/main.ts)另處理 stdout 背壓。sink 為同步呼叫，收到已投影的一行 JSON，呼叫端負責加換行；回 false 表示未接受。不要把 async 函式直接當這個 sink，否則它的 Promise 不屬於此同步契約。

組裝時傳入同一個 observation：

```ts
const application = await createArticleApplication({
  database,
  auth: { origin: process.env.APP_ORIGIN },
  observability: observation,
});
```

Server 將它接到原生 HTTP 邊界、錯誤出口、匯出 callback 與 shutdown，並由 RuntimeModule 的 `OBSERVABILITY` token 提供給 HealthController。測試可注入記憶體 sink，不必攔截全域 console 或另外開放故障路由。

正式 API 不再輸出 `REQUEST_TRACE {...}` 等混合前綴；每行都是 JSON。舊 onTrace／onError 等可信程式接點仍保留，供先前實驗使用，但不將 steps 或任意 callback 資料直接寫入正式日誌。獨立 external-lab 沿用其教學輸出，不使用正式 API 的 metrics。

## 24.3 哪些欄位可以進日誌？

本章以白名單投影實作敏感資料遮蔽：**未列入的資料根本不送給 sink**。它不接受一個任意物件，再試圖猜出所有秘密欄位。

| 事件 | 可記錄欄位（另有 time、level、event） |
|------|--------------------------------------|
| request_completed | 服務 UUID、有限路由樣板、有限 method、finished／interrupted、已送出的 httpStatus、durationMs |
| http_error | 服務 UUID、errorStatus、安全 code、phase、若已送出則附 httpStatus |
| export_finished | 服務 UUID、complete／interrupted、bytesRead、fileClosed、安全串流 code |
| shutdown | draining／http-drained／closed／deadline |
| listening／signal | port，或 SIGINT／SIGTERM |
| startup_failed／shutdown_failed | 固定事件，不含原始例外 |

禁止記錄的資料包括：密碼、passwordHash、Cookie／Set-Cookie、Authorization、Session token、CSRF token、tokenHash、資料庫 URL、email、使用者 ID、文章 ID／標題／正文、原始 body／query、原始上游 body、SQL、stack 與任意 Error.message。本章連錯誤 details 也不直接記錄。

例如 `/api/articles/a_private?token=secret` 只會留下 `/api/articles/{id}`。未知路徑統一為 unmatched；未知 method 為 OTHER；未知錯誤碼為 OTHER_ERROR。字串有固定集合或 UUID 格式限制，數值也有檢查。即使呼叫端以型別斷言夾帶 password 或換行，投影仍不複製它們。

JSON.stringify 讓每筆事件保持一行；但光用 JSON.stringify 並不會保護秘密。下面的寫法仍會洩漏資料：

```ts
// 錯誤示意，勿加入正式程式。
console.log(JSON.stringify({ request, error, body: request.body }));
```

這個設計刻意只留下安全分類。需要增加診斷資訊時，應先定義有限欄位、使用目的與測試，再改投影；不要臨時把整個 driver error 塞進去。對既有日誌事後作字串替換，也不能保證移除未知格式的秘密。

## 24.4 用 request ID 找到同一次請求

服務自行產生 UUID，不採用外來的 X-Request-ID，避免用戶把任意文字或另一人的 ID 當成可信關聯。它不是 Session、授權資訊或冪等鍵。

一個安全的失敗回應如下：

```json
{
  "error": { "code": "NOT_FOUND", "message": "找不到路由", "details": [] },
  "requestId": "7f340b25-4d06-4ca9-95db-ed9486ff332a"
}
```

X-Request-ID 與 body 相同。對應兩行日誌可為：

```json
{"time":"2026-11-03T02:00:00.000Z","level":"warn","event":"http_error","requestId":"7f340b25-4d06-4ca9-95db-ed9486ff332a","errorStatus":404,"code":"NOT_FOUND","phase":"before-response"}
{"time":"2026-11-03T02:00:00.001Z","level":"info","event":"request_completed","requestId":"7f340b25-4d06-4ca9-95db-ed9486ff332a","route":"unmatched","method":"GET","outcome":"finished","httpStatus":404,"durationMs":1}
```

time 使用 UTC ISO 日期；耗時使用 performance.now 的 monotonic clock，避免調整系統時間改變同一次請求的耗時。上面是格式示意，實際 ID、時間與耗時由執行結果決定。

成功也要有 completion，否則看不到正常流量與耗時。每個 response 同時註冊 finish／close，但第一個終止事件會移除兩個 listener，避免成功回應隨後 close 時被重複計數。

## 24.5 HTTP 狀態與錯誤分類不能混在一起

想像 NDJSON 已經送出 `200` 與一段檔案，後面讀檔失敗。這時不能改成 `500`，也不能在檔案後追加一份 JSON error。

| 情況 | http_error | request_completed |
|------|------------|-------------------|
| 回應前未知錯誤 | errorStatus=500、before-response | httpStatus=500、finished |
| 已送 200 後才有未知錯誤 | errorStatus=500、httpStatus=200、streaming | httpStatus=200、interrupted |
| 尚未送 headers 就離線 | 若稍後錯誤，phase=disconnected | 沒有 httpStatus、interrupted |
| 正常回傳 404 | errorStatus=404、before-response | httpStatus=404、finished |

finished 描述 response 生命週期，並不表示業務成功；404 的 JSON 可以完整送完。反過來，httpStatus=200 也不能單獨證明串流完成，還要看 outcome。

正式 NDJSON 的 pipeline 在內部處理串流錯誤，因此不一定經過 Exception Filter。它用 `export_finished` 記錄 complete／interrupted、bytesRead 與 fileClosed；request ID 由 Controller 傳入。傳輸 completion 可能早於關檔事件，讀日誌時以關聯 ID 判讀，不要求不同事件固定相鄰。

本章也以測試專用 Express app 在送出片段後拋錯，驗證共用錯誤出口的 streaming 分類；該故障路由不會出現在正式 API。原始 Error.code 同樣不直接輸出，未列入的串流錯誤統一為 STREAM_FAILED。

## 24.6 live、ready 與 draining 的差別

| 狀態 | /health/live | /health/ready | /health/metrics | 文章 DB 操作 |
|------|--------------|---------------|-----------------|-------------|
| 正常提供服務 | 200 | 200 | 200 | 依業務契約 |
| 啟動後 DB 不可達／必要表不可讀 | 200 | 503 NOT_READY | 200 | 未知 DB 錯誤為安全 500 |
| 開始 draining | 若請求仍能進入口則 200 | 503 SHUTTING_DOWN | 若仍能進入口則 200 | 新進入口的工作 503；先前已接受工作排空 |
| listener 已關閉 | 無 HTTP 回應 | 無 HTTP 回應 | 無 HTTP 回應 | 不再接收 |

live 只說明此程序能執行並回應 HTTP，不查 DB。ready 每次真正檢查 Article、ArticleStatusAudit、Session 與 User 的認證欄位，失敗不暴露是哪張表或 driver 訊息；檢查結束後也再次確認是否已進入 draining，關閉狀態優先於同時發生的 DB 故障。

這保留原本 readiness 的查詢策略，沒有新增 probe 快取、SQL 自動重試或宣稱固定回應期限。連線與 SQL 有既有 adapter 限制，但多個依序查詢並不是一個整體硬期限。檢查只能表示當時可讀，不保證下一個交易一定成功，也沒有驗證所有索引或業務能力。

shutdown 會立即停止 listener 並排空既有連線；實際用戶通常先遇到連線拒絕，不能假設停止後還有時間再 curl 看到 503。程式內的 draining 檢查防止仍抵達 middleware 的新工作；測試另控制進行中的 ready，在 DB 檢查返回時開始 drain，驗證它不會誤回 200。

啟動前缺少設定、連線失敗或 migration 缺漏仍拒絕監聽，輸出 startup_failed 並非零退出。資料庫在啟動後故障則由 ready 回報，不把程序存活等同資料就緒。

## 24.7 指標要先限制維度

新增公開 `GET／HEAD /health/metrics`，無 Session 要求，回 `text/plain; version=0.0.4; charset=utf-8`、Cache-Control: no-store。它只提供程序彙總，沒有原始輸入、憑證或資料庫內容。拒絕 query；其他方法為 405／Allow: GET, HEAD，詳細路徑尾斜線 404。

公開是此教學 API 的明確決定。這些數字仍會透露流量概況；若後續產品需要限制，必須同時修改存取契約、OpenAPI 與測試，不能只在文件寫「內部使用」卻繼續公開。此處不配置部署網路或監控平台。

| 指標 | 類型與意義 |
|------|------------|
| course_http_requests_total | counter，response finished／interrupted 次數 |
| course_http_duration_seconds | histogram，從收到 request 到 finish／close 的秒數 |
| course_http_in_flight | gauge，尚未 finish／close 的 HTTP response 數 |
| course_work_pending | gauge，lifecycle 已登記但尚未結束的工作票數 |
| course_draining | gauge，開始關閉後為 1 |
| course_log_dropped_total | counter，sink 拒收或同步拋錯的筆數 |

counter／histogram 只使用以下有限 label：

- route：OpenAPI 路由樣板，加上 unmatched；參數值與 query 都不進 label。
- method：固定七種 method，其他歸 OTHER。
- status_group：1xx–5xx，尚未送出 headers 為 none。
- outcome：finished 或 interrupted。

requestId 適合逐筆日誌，不適合 metric label；使用者 ID、email、原始 URL 也會讓 series 隨輸入持續增加。即使只保留短字串，仍可能產生無界 cardinality。[Prometheus 的 label 與 cardinality 建議](https://prometheus.io/docs/practices/naming/)

metrics 的路由分類是對文件樣板作有限比對，代表「請求目標所屬樣板」，不宣稱 handler 一定執行成功。例如參數解碼失敗仍可能歸到文章詳情樣板。

## 24.8 讀懂 histogram 與兩種進行中數量

耗時桶為 0.01、0.1、0.5、1、5、+Inf 秒；每個桶是累計值。一個 0.08 秒的請求會增加 0.1 以上的所有桶，不只增加一個桶。

```text
course_http_duration_seconds_bucket{route="/health/live",method="GET",status_group="2xx",outcome="finished",le="0.1"} 4
course_http_duration_seconds_bucket{route="/health/live",method="GET",status_group="2xx",outcome="finished",le="+Inf"} 5
course_http_duration_seconds_sum{route="/health/live",method="GET",status_group="2xx",outcome="finished"} 0.6
course_http_duration_seconds_count{route="/health/live",method="GET",status_group="2xx",outcome="finished"} 5
```

這代表 5 次中有 4 次不超過 0.1 秒，總耗時 0.6 秒；平均為 0.12 秒。只靠平均看不到最慢那次，桶也不能還原每次精確耗時。本章只驗證計數與桶的一致性，不設定壓測門檻或延伸成第 25 章。

這份metrics只屬於目前程序。若未來有多個副本，監控系統需分別scrape後再彙總，不能只輪流讀一個負載平衡入口，便把不同程序的counter當成同一條連續序列。程序重啟會讓counter歸零，跨窗口判讀需處理reset。

metrics 的 snapshot 在該次 scrape 回應結束前產生，所以 in-flight 至少包含這一次 scrape；它自己的 completion 要等回應結束才進 counter。HEAD 沒有 body，但仍執行 handler，也算一次請求。不同次 scrape 的文字長度可能改變，不能要求 HEAD 長度永遠等於前一次 GET。

work_pending 是**工作票數**，可能同時包含 request guard 與 Controller 登記的同一段業務，不能解讀成獨立 SQL 數量。它可以在 HTTP 已斷線、in-flight 歸零後仍大於零。

```text
用戶離線 → HTTP in-flight 歸零
          → Promise／SQL／檔案 finally 可能繼續
          → 等已登記工作完成
          → 關閉 Nest、共用資源與 DB pool
```

取消訂閱或 response close 都不等於取消 SQL；本章沒有因此提早關 pool。新的 observation 也不改變 lifecycle.track 的所有權與關閉順序。

## 24.9 日誌輸出失敗時怎麼辦？

sink 同步拋錯或回 false，只增加 log_dropped_total，不改變已執行的交易或 HTTP 結果，也不再輸出可能含秘密的 sink 例外。

正式 stdout sink 若 write 回 false，表示該行已交給 Node buffer，但後續暫停收新行，直到 drain；不另建應用層無界佇列。若 stdout error，後續拒收。這會犧牲部分日誌完整性，換取有界的記憶體行為；不是可靠訊息佇列，也不保證程序強制退出前所有紀錄都送達。

測試同時驗證 throwing sink 與拒收 sink，確認 HTTP 仍為 200、丟棄計數增加。與此不同，業務稽核寫入失敗仍必須讓文章狀態交易回滾，不能套用「觀測失敗不影響業務」的規則忽略它。

## 24.10 從乾淨環境啟動

尚未安裝工具時，先依[第 00 章安裝 nvm／Node](00-course-map-and-project-contract.md#004-用-nvm-安裝-node-並執行第一個練習)，以及[第 01 章 Docker 操作](01-runtime-tooling-and-project-setup.md)。後續套件、測試與資料庫指令都在 Docker 執行；nvm use 不會改變 Docker 映像的 Node。

從倉庫根目錄：

```bash
cd nodejs-course/examples/24
nvm install
nvm use
docker compose build tools
docker compose up -d --wait postgres test-db
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm run db:deploy
docker compose run --rm tools npm run db:seed
docker compose run --rm tools npm run db:status
docker compose run --rm tools npm run seed
docker compose up -d api upstream external-lab
docker compose run --rm tools npm run test:observability-compose
docker compose run --rm tools npm run test:external-compose
docker compose run --rm tools npm run test:query-api
docker compose run --rm tools npm run test:status-api
```

Compose 為 nodejs-course-24；API 3024、PG 15424、external-lab 3124、upstream 3224，test-db 不公開主機端口。APP_ORIGIN=http://127.0.0.1:3024。各章 Session Cookie 不按 port 隔離，請使用獨立 Cookie jar，登入密碼仍含 18，見範例 README。

完整 check 沿用既有順序：generate → typecheck → 全量 Jest → build → test:runtime → 四個原 lab → lab:queries → openapi:export → test:parallel → lab:external。新測試已納入全量 Jest。相同目錄會重建 .test-dist，test／check／parallel／focused 等指令必須依序執行。

### 從回應找到日誌

以下 GET 故意得到 404，curl 不加 -f，讓你能讀取失敗 body：

```bash
curl -i -H 'X-Request-ID: user-provided' http://127.0.0.1:3024/missing
curl -i http://127.0.0.1:3024/health/live
curl -i http://127.0.0.1:3024/health/ready
curl -fsS http://127.0.0.1:3024/health/metrics
curl -I http://127.0.0.1:3024/health/metrics
docker compose logs --no-log-prefix --tail 30 api
```

找出 missing 回應的 X-Request-ID，在兩筆 JSON 中比對；它不會是 user-provided。HTTP envelope 與日誌都不應出現原始輸入或秘密。若要保存日誌供程式分析：

```bash
docker compose logs --no-log-prefix api > /tmp/chapter-24-api.jsonl
```

這只保存 API container 的應用輸出；Compose 自身的啟停訊息不等於 JSON 日誌契約。

## 24.11 實際停止 PostgreSQL，區分故障與存活

先確認上一節正常驗收成功，再執行：

```bash
docker compose stop postgres
docker compose run --rm tools npm run test:observability-compose -- --unavailable
curl -i http://127.0.0.1:3024/health/live
curl -i http://127.0.0.1:3024/health/ready
curl -fsS http://127.0.0.1:3024/health/metrics
docker compose up -d --wait postgres
docker compose run --rm tools npm run test:observability-compose
```

預期 DB 停止時 live／metrics 200、ready 503 NOT_READY，文章列表因未知 DB 錯誤安全回 500 INTERNAL_ERROR。API 程序保持運作，DB 恢復後 ready 與文章查詢恢復。驗收腳本不輸出憑證，也不在正式 HTTP 新增「關閉 DB」的管理路由。

proof 保存在 `.data/observability-compose-proof.json`，包含 healthy 與 databaseUnavailable 兩組 HTTP 結果及服務 UUID。它不是資料庫備份或業務稽核。

持久化與停止依序操作：

```bash
docker compose restart postgres
docker compose up -d --wait postgres
docker compose restart api
docker compose run --rm tools npm run test:query-persistence
docker compose run --rm tools npm run test:status-persistence
curl -f http://127.0.0.1:3024/api/articles/export -o /tmp/chapter-24-articles.ndjson
curl -I http://127.0.0.1:3024/api/articles/export
docker compose stop external-lab upstream api postgres test-db
docker compose logs --no-log-prefix --tail 15 api
```

先執行 query-api／status-api 才有持久化比對基準。正常關閉日誌應有 draining → http-drained → closed；metrics 隨程序重啟歸零，但 DB 文章與稽核不應消失。保留 volume 與 proof，不用 down -v。NDJSON 仍是獨立公開教學檔，不是資料庫匯出或備份。

## 24.12 測試如何證明觀測結果可信？

```bash
docker compose run --rm tools npm run test:observability
```

兩份新增測試共 21 項：

| 檔案 | 證據 |
|------|------|
| observability.test.ts | 8 組路由投影、欄位注入／換行、sink 故障、成功／失敗 UUID、錯誤狀態、有限 series、metrics／OpenAPI、histogram、真 HTTP 串流失敗、離線工作與 drain |
| observability-database.test.ts | 真 PG 自有 schema 改名故障／恢復、真登入與 CSRF 遮蔽、INSERT 後失敗的交易回滾、正式 NDJSON HEAD／完整／中斷與關檔 |

測試使用隨機 loopback port 與自有 PostgreSQL schema；只在自己的 schema 暫時改名資料表，不破壞開發 DB。外部 lab 原測試照常保留。這些案例不依賴第三方網站或窄毫秒效能斷言。

全量為 37 套、449 項 Jest，包含原 428 項；兩個真正 worker 另重跑 6 項。完整 check 還驗證正式入口缺設定／缺表不監聽、SIGINT／SIGTERM、重複信號與關閉期限，程序腳本已改成讀 JSON 事件。

健康端點的 200 不能取代資料持久化、權限或交易測試；相同地，觀測測試通過也不能代表完成壓測、容量規劃或正式部署。這些分別在後續章節處理。

## 24.13 練習與完成檢查

### 練習一：判讀看似矛盾的 200 與 500

同一 request ID 的 http_error 為 errorStatus=500、httpStatus=200、phase=streaming，而 completion 為 httpStatus=200、interrupted。這是日誌寫錯了嗎？應否再回一份 JSON？

<details>
<summary>參考答案</summary>

已送出 200 後發生內部錯誤，兩個數值描述不同事實。不能重寫 HTTP 狀態或追加 JSON；應中斷串流並依 request ID 查清理事件。以 status_group=2xx 計算成功率時，也必須另外考慮 outcome。

</details>

### 練習二：挑出不適合的 label

想加入 requestId、完整 URL、會員 ID、路由樣板與有限 outcome，哪些能放進 metrics？請用一千個不同文章 ID 說明 series 如何增加。

<details>
<summary>參考答案</summary>

本章只允許有限路由樣板與 outcome。每個 ID／query 變成新 label 值會持續增加 series；截短字串不能保證有界。requestId 用於日誌，原始 URL 與會員 ID 也不在本章日誌白名單。

</details>

### 練習三：讓輸出介面故障

閱讀 throwing／false sink 的測試，將第二次回 false 改成 throw，確認兩個 HTTP 回應仍為 200、log_dropped_total 仍累計為 2。再判斷：ArticleStatusAudit INSERT 失敗能否也忽略？

<details>
<summary>參考答案</summary>

日誌輸出不是交易的一部分，可以丟棄並計數；業務稽核屬於一致性契約，失敗必須回滾文章與版本。不能把兩者套成同一個 catch 後忽略策略。

</details>

### 練習四：解釋 in-flight=0、work_pending>0

在離線測試的 release gate 尚未放行時觀察兩個值，說明為什麼此時不能關閉 DB pool。若直接在 response close 或 RxJS finalize 關 pool，哪個案例會先壞？

<details>
<summary>參考答案</summary>

HTTP 已結束，但已接受的非同步工作或 finally 尚未完成。先關 pool 會讓仍在等待或執行的業務失敗；必須依 lifecycle 已登記工作的實際完成順序關資源。取消訂閱不會自動取消 Promise／SQL。

</details>

### 完成檢查

- [ ] 能由失敗回應 UUID 找到安全錯誤與 completion，外來 ID 不被採信。
- [ ] 原始 request／body／Error／DB URL／認證資訊不進 sink。
- [ ] 能分開判讀 httpStatus、errorStatus、phase 與 outcome。
- [ ] DB 停止與恢復時，live／ready／metrics 狀態符合契約。
- [ ] 指標 label 有限，知道 scrape 自身與工作票數的意義。
- [ ] 中斷後檔案關閉，drain 等待真正工作，才關 Nest／pool。
- [ ] 完整 check、Compose 故障／恢復、文章契約與持久化驗收通過。
- [ ] 正常停止本章容器，保留 volume、文章、稽核與 proof。

下一章：[25 — 效能與資源上限](25-performance-load-and-resource-limits.md)：壓測、資源上限與效能診斷。

---

[下一章：效能與資源上限](25-performance-load-and-resource-limits.md) · [上一章：外部 HTTP](23-external-http-timeouts-and-retries.md) · [返回課程總覽](README.md) · [本章範例](examples/24/README.md) · [本章契約](examples/24/BASELINE.md)
