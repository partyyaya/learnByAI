# 第31章契約：Outbox與站內通知

承接[30](../30/BASELINE.md)的公開快取與主線業務。新增固定BullMQ5.58.5／@nestjs/bullmq11.0.4；第五份migration202611030002_notification_outbox，原四份不改。

- nodejs-course-31：API3031／PG15431，lab3131／3231／3331／4031；production HTTPS34431／HTTP30831。API、dispatcher、worker、PG、cache-redis、job-redis分服務。
- publish條件更新、狀態稽核、Outbox同交易；recipient取Article.authorId，edit／archive不寫Outbox，不回填舊事件。
- Outbox UNIQUE(articleId,articleVersion)、FK Restrict／版本CHECK。Notification.eventId UNIQUE；seq bigint對HTTP輸出字串。
- dispatcher一次最多10筆，SKIP LOCKED＋leaseToken／10秒lease；DB語句先完成再等Redis，入列後依id＋leaseToken標記。失敗清lease／中止可過期補送。
- 已入列超過30秒且沒有Notification的事件也可reconcile；不假定Redis永遠保有job。retained failed job先修復再人工retry。
- jobId固定event ID；3 attempts／100ms exponential backoff；complete／failed各保留100。job移除後仍以DB UNIQUE保護，不保證外部副作用exactly-once。
- worker使用真正Nest BullModule／Processor／WorkerHost，共享safe processor；只存站內DB通知，錯誤固定NOTIFICATION_WORK_FAILED，不保存driver原訊息。
- 每recipient交易advisory lock後才分配seq，避免同一人的提交順序越過cursor；允許缺號。
- GET／HEAD /api/me/notifications只查Session本人（admin也相同），after預設0／最大int64字串，limit預設20／最大50；先驗證字串格式、拒絕空白，再透過 pipe 執行 BigInt 上限檢查；非法字串回400。拒絕未知／重複query，no-store。OpenAPI22／40、31.0.0。
- job-redis無主機port、128MiB noeviction、AOF everysec／獨立volume；memory256MiB。與可淘汰cache分開；AOF仍非零RPO。DB Outbox是可補送意圖，不以清queue取代還原。
- producer有界失敗／無offline queue；worker blocking連線maxRetriesPerRequest=null。worker concurrency2／lock2秒／stalled interval1秒是教學設定。7秒關閉watchdog，超時非零；dispatcher／Docker可中止的窗口靠lease與冪等恢復。
- 真Redis／PG測試：rollback、post-add補送、job移除後去重、失敗3次、雙dispatcher、job遺失重建、本人權限。native lab真正SIGKILL自己active worker再恢復；不殺其他程序，不FLUSHALL。
- 備份前停API／worker／dispatcher，備份與還原比較Outbox／Notification及migration歷史。CI／停止保留volume／job_data／proof，不stage／commit。

HTTP 關閉協調器在 listen 前追蹤 socket，drain 時清理零 HTTP bytes 的預連線，並繼續等待已接受請求；保留原有關閉期限及非零失敗語意。見 [shutdown.ts](src/shutdown.ts) 與 [原生 TCP 測試](test/shutdown.test.ts)。

## 驗證紀錄

2026-11-03：完整 Jest 568 項及另行兩個 worker 的 6 項隔離測試通過；Docker 建置、Chromium、TLS 與重啟持久化均已實際驗證。另通過 PG 故障與隔離備份還原。佇列另驗證空 dispatcher 穩定運作、active worker SIGKILL／stalled 恢復及正常關閉。

2026-11-04 審閱回歸：26 項（Outbox、通知游標、快取、OpenAPI 與 shutdown）通過。非法字串／小數／前導零／換行／超出 int64 的游標均回400；保留最大 int64 邊界。本輪採針對性回歸，未重跑全部歷史 Jest 或整套正式部署 CI；上方 2026-11-03 為前次完整驗證。
