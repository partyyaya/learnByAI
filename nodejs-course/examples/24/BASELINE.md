# 日誌、健康與基本指標：第 24 章契約

承接[第 23 章契約](../23/BASELINE.md)。本快照沿用文章／認證／CSRF／版本／稽核交易／列表／fixture／外部 HTTP；沒有新套件或 migration。新增正式公開 GET／HEAD /health/metrics 與結構化觀測。

## 1. 範圍與固定組裝

- nodejs-course-24；API 3024、PG 15424、external-lab 3124、upstream 3224；test-db 不公開。
- APP_ORIGIN=http://127.0.0.1:3024，Cookie 跨章需獨立 jar，示範密碼中的 18 不變。
- createArticleApplication／createArticleServer 共用正式 HTTP、adapter、init、shutdown；TestingModule 仍走相同入口。
- observability 是可信程式組裝參數；RuntimeModule 以 OBSERVABILITY token 提供同一實例。不開放 HTTP 故障注入或管理路由。
- 主線 API 每行 JSON；獨立 external-lab／upstream 保留前章教學輸出，不混入正式 API 的指標。

## 2. 日誌與遮蔽

LogSink 是同步 `(line: string) => void | boolean`；line 已投影且不含尾端換行，sink 回 false 表示拒收。非同步輸出需另設計合作介面，不將 async callback 當此同步 sink。

事件只有固定用途：request_completed、http_error、export_finished、shutdown、listening、signal、startup_failed、shutdown_failed。共同欄位 time 為 UTC ISO、level／event 由程式決定。

可記錄欄位：服務產生的 UUID、有限 route 樣板／method／outcome、安全錯誤 code／phase、HTTP 或分類狀態、耗時與非負清理數值、有限關閉狀態、port／signal。未知路徑=unmatched、method=OTHER、code=OTHER_ERROR；串流未知 code=STREAM_FAILED。額外物件屬性不會傳給 sink。

禁止原始 request／URL／query／body／Error.message／stack／SQL，以及密碼、hash、Cookie／Set-Cookie、Authorization、Session／CSRF token、tokenHash、DB URL、email、使用者／文章 ID、文章內容與上游 body。遮蔽採白名單投影，不提供通用遞迴 redactor。新增欄位須修改契約與測試。

sink 同步拋錯／拒收只增加 log_dropped_total，不改變 HTTP 或交易；不再輸出其原始例外。正式 stdout write 回 false 的該行已被 Node 接受，背壓期間後續行拒收，等 drain 再恢復；stdout error 後拒收。不另建無界佇列，不保證日誌可靠送達，也不能取代交易稽核。

## 3. request ID 與傳輸結果

原生 request 入口產生 UUID，先設定 X-Request-ID，再交框架。外來 X-Request-ID 不採用。錯誤 body.requestId 與 header 相同；export_finished 也帶相同 UUID。

- response finish／提前 close 只記一次 request_completed，移除兩個終止 listener。
- finished 表示 Node 的 response finish，不保證用戶完整收件，也不表示業務成功。
- interrupted 表示 response 在 finish 前 close；未送 header 不附 httpStatus，不虛構 200 或 499。
- errorStatus 是 normalizeError 的安全分類；httpStatus 只表示實際已送的狀態。
- 串流已送 200 後才錯誤，可同時記 errorStatus=500、httpStatus=200、phase=streaming；中斷連線，不補 JSON。
- 匯出 pipeline 在內部處理的中斷由 export_finished 呈現，包含 fileClosed；不強迫經過 Filter。
- error 與 completion／export 的順序可能交錯，依 UUID 關聯，不要求固定相鄰。
- Node parser 在 request 事件之前拒絕的封包不計入這份應用 HTTP 指標。

## 4. live、ready 與關閉

GET／HEAD /health/live 不查 DB，正常與 DB 故障時 200。ready 每次查 Article、ArticleStatusAudit、Session 與 User 認證欄位；失敗 503 NOT_READY，不暴露必要表名稱或 driver 訊息。保留既有查詢策略，不保證 probe 整體硬期限或下一筆交易成功。

開始 draining 後 ready 為 503 SHUTTING_DOWN；正在進行的 DB 檢查回來後也再次檢查 draining，包含 DB 同時失敗的情況，關閉分類優先。入口拒絕新業務請求，原先通過入口的工作繼續排空；live／metrics 若仍能抵達入口可回應。server.close 會立即停止 listener；關閉後無 HTTP 回應，不能保證用戶能觀察到一段 503 視窗。

DB 啟動後不可用：live／metrics 200、ready 503、文章 DB 未知錯誤安全 500；API 不因此自行退出。DB 恢復後可再次 ready。啟動前缺設定／連線／必要表則不監聽、startup_failed、非零退出。

shutdown 順序 draining → 等 HTTP／已登記工作 → http-drained → 關 Nest／資源／DB → closed。deadline 仍為失敗，不宣稱 closed。response close 或取消訂閱不等於 Promise／SQL 完成，不提前關 pool。

## 5. 公開 metrics

GET／HEAD /health/metrics 無 Session／CSRF 要求；只含程序彙總，不查 DB，不輸出使用者資料。text/plain; version=0.0.4; charset=utf-8、Cache-Control: no-store、X-Request-ID；HEAD 無 body。query 一律拒絕 400 VALIDATION_ERROR、尾斜線 404、其他方法 405／Allow: GET, HEAD，沿用安全錯誤 envelope。

公開彙總會透露流量概況，這是本教學 API 的明確範圍；需要保護時須一起修改實作／OpenAPI／驗收，不以文件宣稱內部使用代替實際限制。

- course_http_requests_total：finished／interrupted counter。
- course_http_duration_seconds：從 request 到 finish／close 的累計 histogram，0.01／0.1／0.5／1／5／+Inf 秒，另有 sum／count。
- course_http_in_flight：尚未結束的 response，snapshot 包含當次 scrape。
- course_work_pending：lifecycle 的未完成工作票數，可能重疊，不是獨立業務或 SQL 計數。
- course_draining：開始 shutdown 後為 1。
- course_log_dropped_total：同步 sink 拋錯／拒收數。

counter／histogram labels 僅 route（文件樣板＋unmatched）、method（七種＋OTHER）、status_group（1xx–5xx／none）、outcome（finished／interrupted）。不以原始 URL、UUID、使用者 ID、query 或 error message 作 label。分類表示請求目標樣板，不保證 handler 已執行。

series 按觀察到的有限組合建立；+Inf bucket=count=requests_total，sum 為非負秒數。snapshot 不包含本次尚未結束的 completion；HEAD 也執行 handler、計數。無跨程序合併或持久化，重啟歸零。沒有壓測、告警或監控平台。

## 6. OpenAPI 與既有契約

info.version=24.0.0，OpenAPI 3.1.1，18 paths／32 operations；新增 metrics text response／公開 security／HEAD，並說明 draining。HTTP /api/openapi.json 與 .data/openapi.json 仍為同一來源；無 Swagger UI，測試 schema 工具仍僅實作所用子集。

文章 API 的公開／me／admin 範圍、actor、201 Location、expectedVersion、檢查順序、條件 UPDATE、VERSION_LIMIT、RepeatableRead、INVALID_STATE、嚴格輸入、16 KiB 與安全錯誤不變。沒有文章 DELETE；NDJSON 仍是獨立公開教學檔。

Session／密碼 KDF／CSRF／認證限流與 seed 不覆寫策略保留；稽核與文章同交易。三份 migration 原檔保留。外部 native fetch 的期限、取消、GET retry 與 POST uncertain 策略保留，不掛文章 AppModule，不把本章指標擴充成上游監控。

## 7. 驗證與清理

全量 Jest 37 套、449 項（原 428＋新增 21）；兩 worker 另重跑 6 項。新增 18 項觀測與 3 項 DB 整合，涵蓋白名單／換行注入、外來 ID、sink 故障、有限 series／histogram、metrics／OpenAPI、真 HTTP streaming error、離線工作、ready／draining、真 PG 表故障恢復、真 Session／CSRF、真 INSERT 回滾與正式 NDJSON 關檔。

check 順序沿用：generate → typecheck → Jest → build → test:runtime → 四個原 lab → lab:queries → openapi:export → test:parallel → lab:external。程序驗收改讀 JSON 事件，保留缺設定／缺表拒絕監聽、SIGINT／SIGTERM、重複信號、排空與期限。測試／check／parallel 等同目錄指令不可並行。

Compose 驗收使用執行中的正式容器；`test:observability-compose -- --unavailable` 須先停止本章 postgres，驗證 live／metrics=200、ready=503、列表=500；恢復 DB 後再跑正常模式。proof=.data/observability-compose-proof.json，只有時間、狀態與服務 UUID。

另跑 query-api／status-api、API／PG 重啟後 persistence、外部 Compose 與 NDJSON GET／HEAD。fixture 只動自有隨機 schema，正常關閉後再清理；不刪開發資料。最後停止本章五個服務，保留 volume／文章／稽核／proof，不用 down -v，不 stage／commit。
