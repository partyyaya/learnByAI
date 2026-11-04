# 31 — BullMQ 背景工作、Outbox、重試與冪等

> PostgreSQL 提交與 Redis 入列不是同一筆交易；先留下可補送的意圖，再讓重複投遞不重複產生業務結果。

前置：[30 Redis](30-redis-caching-and-invalidation.md)、[20 交易](20-persistence-transactions-and-concurrency.md)、[07 關閉](07-process-signals-and-graceful-shutdown.md)與[24 觀測](24-logging-health-and-observability.md)。[獨立快照](examples/31/README.md)延伸30章，實作「文章發佈後，為文章作者建立站內通知」。沒有寄真實email、呼叫外部通知服務或把密碼放進job。

新增BullMQ **5.58.5**、@nestjs/bullmq **11.0.4**，沿用ioredis5.8.2。API、dispatcher與worker分程序，工作與快取分開Redis。API新增GET／HEAD /api/me/notifications，OpenAPI為22 paths／40 operations、31.0.0。

## 31.1 為什麼不能在 Controller 裡直接 queue.add？

```text
提交文章 → 程序中斷 → 尚未queue.add：文章已發佈，通知永久遺失
queue.add → DB交易回滾：通知卻已送出
```

把兩個await放在一起，不會讓PostgreSQL與Redis共同commit。也不能用一次HTTP重試推論前一個請求沒有提交。

本章把通知意圖寫成OutboxEvent：

```text
同一PostgreSQL交易
  → 條件更新Article，version+1
  → INSERT ArticleStatusAudit
  → 若action=publish，再INSERT OutboxEvent
  → 任一步失敗，全部rollback
```

[prisma-article-repository.ts](examples/31/src/prisma-article-repository.ts)在原appendStatusAudit交易接點建立Outbox，業務Service不用知道BullMQ。recipient取Article.authorId，admin代作者發佈不能誤把通知寄給admin；edit／archive不建立發佈通知。

## 31.2 第五份 migration 與兩種識別

[增量migration](examples/31/prisma/migrations/202611030002_notification_outbox/migration.sql)新增：

| 表／欄位 | 用途 |
|---------|------|
| OutboxEvent.id | 不透明event ID，也是BullMQ jobId |
| articleId＋articleVersion | UNIQUE，辨識同一篇的一次發佈 |
| userId | 通知收件者，由文章作者決定 |
| enqueuedAt | 已確認入列；不等於worker完成 |
| leaseToken／leaseUntil | 多dispatcher分工與中止後重新領取 |
| attempts | dispatcher領取次數；不同於BullMQ attemptsMade |
| Notification.eventId | UNIQUE，保護實際業務冪等 |
| Notification.seq | bigint游標，HTTP使用十進位字串 |

保留前四份Prisma migration，不改寫歷史、不替舊文章補造通知。User／Article與Outbox的Restrict外鍵、版本CHECK及Notification外鍵都由SQL保護。必要表也加入啟動／readiness檢查。

## 31.3 啟動四個角色

先完成[00的nvm／Node](00-course-map-and-project-contract.md#004-用-nvm-安裝-node-並執行第一個練習)及[01的Docker](01-runtime-tooling-and-project-setup.md)：

```bash
cd nodejs-course/examples/31
nvm install
nvm use
docker compose build tools browser-tests
docker compose up -d --wait postgres test-db cache-redis job-redis
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm run db:deploy
docker compose run --rm tools npm run db:seed
docker compose run --rm tools npm run seed
docker compose up -d api dispatcher worker
```

工作台3031／PG15431，其他lab為3131／3231／3331／4031。Compose專案nodejs-course-31；各章資料與測試用 Cookie jar 檔案分開，瀏覽器 Cookie 仍不按 port 隔離（操作方式見範例 README）。相同目錄的check／test／parallel／queue lifecycle依序執行。

| 程序 | 職責 |
|------|------|
| API | 驗證Session／CSRF、提交文章＋稽核＋Outbox |
| dispatcher | 領取可投遞Outbox，queue.add，確認後標記入列 |
| worker | 處理job，將站內通知寫入PostgreSQL |
| Redis | 保存排程／鎖／工作狀態；不是文章真實來源 |

cache-redis仍是64MiB allkeys-lru、可丟棄。job-redis改為128MiB noeviction、AOF everysec與自己的job_data volume，容器memory256MiB，無主機port；不要把工作放進會隨時淘汰的快取Redis。AOF everysec仍有掉電資料損失窗口，不能宣稱零RPO。[BullMQ生產環境說明](https://docs.bullmq.io/guide/going-to-production)

## 31.4 先理解 Queue／Worker，再接 Nest

[notification-queue.ts](examples/31/src/notification-queue.ts)建立Queue；[notification-processing.ts](examples/31/src/notification-processing.ts)是共享processor核心。整合測試先直接使用Queue，再用真正Nest worker消費。

[notification-worker.ts](examples/31/src/notification-worker.ts)以BullModule.forRoot／registerQueue、@Processor與WorkerHost組裝。worker以獨立Nest application context執行，不建立HTTP listener，也不將BullMQ放進每個API request。

Producer遇到Redis故障應有界失敗，使用connectTimeout、commandTimeout、無offline queue與有限重試；worker的blocking連線則需要持續等待／恢復，maxRetriesPerRequest=null。兩種用途不應直接共用同一套設定。Producer 關閉前先讓 waitUntilReady 的初始化成功或失敗確實結束；固定 BullMQ 版本若在初始化中直接 close，可能在移除 listener 後才收到錯誤事件。程序驗證包含空 Outbox 的 dispatcher 持續輪詢與正常停止。[BullMQ連線文件](https://docs.bullmq.io/guide/connections)

本章worker concurrency=2、lockDuration=2秒、stalledInterval=1秒，方便短時間演練。這些不是正式服務通用值；CPU阻塞、GC與網路延遲都可能影響續鎖，應依實際工作時間與負載調整。

## 31.5 dispatcher用lease協調，不持DB鎖等Redis

[outbox-dispatcher.ts](examples/31/src/outbox-dispatcher.ts)一次最多領10筆：

```text
UPDATE ... WHERE id IN (
  SELECT符合條件的Outbox
  → FOR UPDATE SKIP LOCKED
  → LIMIT 10
)
  → 設定本批leaseToken、10秒lease、attempts+1
  → DB語句完成並釋放鎖
  → 逐筆queue.add
  → 依id＋leaseToken標記enqueuedAt
```

SQL identifier僅來自已驗證的schema，值以參數傳入。不要在DB交易持鎖期間等Redis；也不能只用程序記憶體Set判斷其他dispatcher是否正在投遞。

lease 是暫時的租約：若整批處理超過十秒，另一個 dispatcher 可能接手。舊持有者只能以自己的 leaseToken 更新標記，真正的業務去重仍靠 Notification.eventId。

queue.add失敗時清lease，意圖仍在DB；程序在任何步驟中斷，lease到期後可再領取。enqueue成功、標記前中斷會產生重送，因此jobId固定為event ID；它不含冒號或使用者憑證。

若job-redis掉電遺失近期工作，只有enqueuedAt並不足以證明仍有job。dispatcher也會重新檢查「入列超過30秒、尚無Notification」的Outbox，再以相同jobId投遞。若相同 jobId 仍保留在 failed，queue.add 去重不會自動把它改回 waiting，需操作員處理。這是本機簡單 reconciliation，不是對任何外部副作用的交付保證。

## 31.6 jobId去重不是完整的業務冪等

完成／失敗工作各保留最多100筆。舊job被移除後，相同jobId可以再次加入；兩個worker或stalled recovery也可能重新執行processor。[BullMQ工作移除與jobId](https://docs.bullmq.io/guide/auto-removal-of-jobs)

本章的最終保護在PostgreSQL：

```text
取出不可變Outbox
  → 依recipient取得transaction advisory lock
  → 查Notification.eventId是否已存在
  → 已存在：回傳原seq，不新增
  → 尚不存在：INSERT唯一eventId的Notification
  → commit
```

這裡的副作用只有同一資料庫的通知紀錄，因此可以用交易與唯一約束處理重複。若換成寄email或扣款，不能把DB UNIQUE當成外部系統的exactly-once；需要接收端支援的冪等鍵、狀態查證及失敗政策。

recipient鎖還讓同一人的seq在前一交易提交後才分配給下一筆。序號可以有缺口，不能假設連續；下一章會用它實作補抓，不能只按建立時間排序或把字串'10'排在'2'之前。

## 31.7 重試、延遲、失敗保留與人工處理

測試也以 `queue.add('published', {eventId}, {jobId:eventId, delay:250})` 觀察 delayed → completed；正式 dispatcher 立即入列。delay 不早於指定時間執行，但可能因 worker 未啟動或忙碌而更晚。

Queue預設attempts=3、exponential backoff起始100ms。三次 attempts 是單一 job 實例的上限，並沒有替文章 POST 或資料庫交易自動 retry。失敗 retention 是有界 Redis 歷史，並非永久 dead-letter：若失敗 job 之後被移除，而 PG 仍無通知，reconciliation 會建立新 job 實例再嘗試。若需要永久失敗不再重送，應在 PG 加明確 terminal 狀態、人工恢復與告警；本例沒有實作這層政策。

processor將任意driver錯誤轉成固定NOTIFICATION_WORK_FAILED，避免把SQL／連線字串放進job的failedReason。失敗工作保留供操作，不在API暴露完整stack。attempts與retention／delay為不同設定，delay只代表不早於該時間可處理，不保證準時執行。[BullMQ重試文件](https://docs.bullmq.io/guide/retrying-failing-jobs)

```bash
docker compose run --rm tools node dist/queue-operator.js status
```

只輸出計數及最多20筆failed job的event ID／attemptsMade，不輸出job body。修復明確原因後，將實際ID代入：

```bash
docker compose run --rm tools node dist/queue-operator.js retry-failed evt_00000000-0000-0000-0000-000000000000
```

示意ID不存在會失敗；不可原樣當作成功案例。人工retry只接受目前前綴中的failed job。若工作仍有永久錯誤，再試一次不會讓它自動變正確。不要為了清錯誤而FLUSHALL。

## 31.8 查看自己的通知

GET／HEAD /api/me/notifications要求Session，admin也只查本人。after預設'0'、limit預設20且最多50；拒絕未知或重複query。seq以字串傳輸，after限非負int64，資料按seq升冪。

格式驗證必須先於 BigInt 轉換，並拒絕前後空白及換行（不可因 BigInt 會忽略空白就接受）。程式用 `.regex(...).pipe(z.string().refine(...))`，讓第一段成功後才執行數值上限檢查。不能假設 safeParse 會捕捉 refinement 自己拋出的例外；例如直接 BigInt('abc') 會拋 SyntaxError。非法游標應回 400，而不是 500 或讓 WS 程序結束。[Zod refinement 說明](https://zod.dev/api#refinements)

```json
{"data":[{"seq":"1","articleId":"a_example","articleVersion":2,"createdAt":"2026-11-03T00:00:00.000Z"}],"meta":{"after":"0","nextAfter":"1","limit":20}}
```

Cache-Control:no-store，不提供Outbox管理或任意收件者端點。通知是過去發佈事件，只含ID／版本；文章之後可能已封存，收到通知仍應重新查詢目前可見資料。本章沒有刪通知排程，資料保留政策需另外設計。

先在工作台登入／建立草稿／發佈，等worker處理，再以自己的Cookie jar呼叫通知API；完整登入HTTP寫法見18章。下一章提供可操作的通知頁面。

## 31.9 故障與關閉驗收

```bash
docker compose run --rm tools npm run lab:queue-lifecycle
```

這個腳本使用自有測試schema／queue prefix，讓一個真正子程序worker取得active job後SIGKILL，再啟動另一程序，等待stalled job恢復、只留下單筆通知，最後以SIGTERM正常關閉。它只操作自己spawn的PID，不中止開發worker。

Jest另驗證：Outbox INSERT真失敗回滾；Redis不可達保留意圖；enqueue後標記前失敗可補送；移除job再重送仍只一筆通知；兩dispatcher分工；工作資料遺失後重建；錯誤job三次失敗與私人列表權限。

worker關閉等已接受工作並關Nest／Redis／PG；7秒watchdog到期會非零退出，不偽裝closed。dispatcher停止接新批次，未完成lease可補送；Compose給8秒寬限，強制停止的窗口仍需依賴Outbox與冪等設計。

```bash
sh ci/check.sh
```

CI還驗TLS、快取Redis中斷、PG故障、重啟與隔離還原；備份前同時停止API／dispatcher／worker，才比較snapshot筆數。備份也保存Outbox與Notification，不能只備份Redis或以清空queue取代恢復策略。

## 31.10 練習

1. 在queue.add完成後、enqueuedAt之前停止dispatcher。說明哪個狀態會重送，並觀察Notification.eventId為何不重複。
2. 移除已完成job後再次加入同一event。比較jobId去重與DB唯一約束的責任。
3. 停掉worker，持續發佈兩篇文章，再重啟。檢查Outbox、waiting與Notification各代表哪個階段。
4. 讓工作永久失敗，確認三次attempt、failed保留與人工retry；不要將業務規則錯誤一律當成可重試傳輸錯誤。
5. 設計站內通知的保留期限，說明下一章cursor遇到已刪歷史時應如何告知用戶，不能默默聲稱全部補抓完成。

```bash
docker compose -f compose.production.yaml stop proxy api worker dispatcher postgres job-redis cache-redis restore-db
docker compose stop worker dispatcher api cors-lab performance-lab external-lab upstream postgres test-db job-redis cache-redis
```

保留PG與job_data、通知及proof，不down -v，不stage／commit。

---

[上一章：Redis快取](30-redis-caching-and-invalidation.md) · [下一章：SSE／WebSocket](32-sse-websocket-and-connection-lifecycle.md) · [課程總覽](README.md) · [範例](examples/31/README.md) · [契約](examples/31/BASELINE.md)
