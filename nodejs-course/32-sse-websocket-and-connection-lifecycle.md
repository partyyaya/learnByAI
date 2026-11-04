# 32 — SSE、WebSocket 與可恢復的即時通知

> 即時連線可能中斷；通知先存資料庫，連線只負責告訴畫面有哪些新資料。

本章延伸 [31 的 Outbox 與站內通知](31-background-jobs-outbox-and-idempotency.md)，以同一份 PostgreSQL Notification 接出 REST、SSE 與 WebSocket。先完成 [07 關閉](07-process-signals-and-graceful-shutdown.md)、[18 Session](18-authentication-sessions-and-guards.md)與 [26 代理／HTTPS](26-build-docker-ci-and-deployment.md)。[獨立快照與執行方式](examples/32/README.md)。

新增 ws **8.18.3** 與 @types/ws **8.18.1**，保留 Node 24.22.1、Nest 11.2.8、Prisma 7.10.1、BullMQ 5.58.5。沒有 Socket.IO 協定，也沒有把 Redis Pub/Sub 當作通知歷史。

## 32.1 先選傳輸，再選工具

| 方式 | 連線與方向 | 適合本例的用途 | 必須自己處理 |
|------|------------|----------------|--------------|
| REST 輪詢 | 每次 HTTP 請求，客戶端發起 | 初次載入、補讀、故障降級 | 輪詢間隔、游標 |
| SSE | 長時間 HTTP 回應，伺服器往瀏覽器 | 文章發佈通知 | 權限、容量、補讀、慢客戶端 |
| WebSocket | HTTP Upgrade 後雙向訊息 | 後續需要雙向協定時的基礎 | 重連、訊息 schema、心跳、容量 |

本例的 WebSocket 只接受一次初始游標，之後只讀通知；雙向傳輸能力不代表需要把修改文章搬進 socket。文章寫入仍走既有 HTTP、CSRF、expectedVersion 與交易。

瀏覽器 EventSource 以 `text/event-stream` 接收事件，並有重連及事件 ID 機制。[MDN EventSource](https://developer.mozilla.org/en-US/docs/Web/API/EventSource)

## 32.2 通知與連線分開

```text
HTTP publish
  → PG：Article + Audit + Outbox 同交易
  → dispatcher → BullMQ → worker
  → PG：Notification 唯一 eventId
  → SSE／WS 各連線讀「本人 seq > 游標」
```

重啟 API 不會清除通知。SSE／WS 沒有自己的業務提交動作，也不保存 Cookie 或完整文章內容到 Redis。

目前每條連線每 500ms 查一次 Session 與最多 20 筆通知。這是容易觀察、受容量限制的教學設計；不是以 Redis 廣播完成跨節點扇出。連線數增加時，先量 PG 查詢與連線池，再考慮喚醒訊號與共享派送機制。

[realtime.ts](examples/32/src/realtime.ts)集中管理連線、計時器、讀取及清理；[notifications.module.ts](examples/32/src/notifications.module.ts)保留 REST 補讀契約。

## 32.3 游標不是時間戳，也不是連續編號

Notification.seq 是 PostgreSQL BIGINT。JSON 以十進位**字串**傳送，瀏覽器用 BigInt 比較；不能先轉 Number。rollback 會留下序號空洞，不能要求下一筆恰好等於目前值加一。

查詢只接受 0 到 9223372036854775807 的整數字串，並以本人 userId、seq ASC 查詢。admin 也只能讀自己的通知。

僅用 BIGSERIAL 還不足以保證游標正確：交易 A 先取得較小 seq 卻晚提交，交易 B 的較大 seq 可能先被讀到。本例 worker 在分配 seq 前，先取得收件者的 transaction advisory lock，讓**同收件者**的通知提交順序與游標順序一致。不同收件者不需要全域排序。

重複事件、補讀與重連仍可能讓同一通知再到達。畫面以 seq 去重，持久化業務結果以 eventId 唯一約束去重；兩者責任不同。

## 32.4 SSE 的 HTTP 契約

```http
GET /api/me/events?after=0
Cookie: course_session=...
Accept: text/event-stream
```

登入 Cookie 由同源瀏覽器帶入，JavaScript 不讀 HttpOnly Cookie。不把憑證放在 URL、localStorage 或 sessionStorage。

成功回應包含：

```text
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-store
X-Accel-Buffering: no

retry: 1000

id: 123
event: article-published
data: {"type":"article-published","seq":"123","articleId":"a_...","articleVersion":2,"createdAt":"..."}

```

每個 frame 以空白行結束。具名事件要用 `addEventListener('article-published', ...)`；只註冊 onmessage 不會接到它。`Last-Event-ID` 優先於 query after，讓 EventSource 自動重連從已收到的位置補讀。HEAD 回相同類型的 headers，立即結束，不占長連線，也不因本人已有兩條串流而被額度拒絕。

有 Origin 時必須與 APP_ORIGIN 完全相同；無 Origin 的認證讀取允許。未登入 401、錯誤 Origin 403、游標錯誤 400，均在寫入串流前回安全 JSON。開始串流後發生錯誤只能結束連線，不能再送另一份 JSON 錯誤回應。

## 32.5 WebSocket 升級與訊息邊界

```text
wss://localhost:34432/api/me/socket
第一次文字訊息：{"after":"0"}
之後伺服器傳送 article-published JSON
```

使用 `ws` 的 noServer 模式，掛在原生 HTTP server 的 upgrade 事件，並非 Nest Gateway。升級時必須有有效 Session Cookie 及完全相符的 Origin。瀏覽器跨站 WebSocket 也可能帶 Cookie，因此不能只檢查 Cookie。

路徑不接受 query，不接受 token query 或從 client 指定 userId。游標沿用 31 章分階段驗證：非法字串只關閉該連線，不能把 BigInt 例外丟出 message listener。初始訊息兩秒內送達，嚴格 schema 只允許 after；binary、額外訊息與額外欄位都關閉連線。非 Upgrade 的 HTTP 呼叫回 426。

Upgrade 拒絕是短 HTTP 狀態回應，送完即銷毀原始 socket，避免 client 保持半開連線；進入 WebSocket 後是 close code。這條路徑不經 Nest HTTP Exception Filter，也不承諾既有 JSON envelope 或 HTTP request 指標涵蓋每則訊息。

| 情況 | 處理 |
|------|------|
| Session 到期／撤銷、協定違規 | 關閉，通常 1008 |
| API drain | 1001，包含尚未送初始游標的預約；停止接受新連線 |
| 輸出緩衝超額 | 1013，讓 client 重新補讀 |
| client 未回 pong | 結束失聯連線 |

## 32.6 容量、心跳與慢客戶端

每程序最多服務 32 條、每人最多 2 條 SSE／WS，包含尚未送初始游標的 WS 預約；已進入短暫關閉握手的連線另行清理。這是服務連線額度，不是所有 TCP socket 的硬上限，入口連線／速率限制仍需另行設計。上限是本程序的，部署兩個 API 不會自動變成全域 32 條。

- SSE 每約兩秒寫 heartbeat 註解；write 回 false 時結束連線。
- WS 每約兩秒 ping，六秒未見 pong 時，在下一次心跳檢查關閉；maxPayload 1 KiB，停用壓縮。
- WS bufferedAmount 超過 32 KiB 時關閉，不無界累積訊息。
- 每條連線同時只有一個輪詢，連線關閉後清掉 interval 與 listener。
- 最多再等 500ms 關閉握手，之後 terminate；這個期限計時器也會清掉。

這些界線保護單程序資源，不是完整的全域負載控制。不能用「連線很多但沒有訊息」推論能承受同量的大量廣播。

## 32.7 瀏覽器：停止、重連與補讀

[通知頁面](examples/32/web/notifications.html)與 [client](examples/32/web/notifications.js)可在登入後選 EventSource 或 WebSocket；主工作台連結至 `/notifications.html`。

畫面只保存記憶體游標，最多顯示 50 筆，使用 textContent。REST 每次 20 筆，單次補讀最多五頁，避免一個操作無限追趕；更多歷史需再次補讀。頁面重新載入會由目前可讀的歷史重建，沒有跨瀏覽器的已讀狀態。

停止按鈕、切換傳輸與 pagehide 都會 close 原連線。補讀尚未完成時按停止，會使舊回應失效並恢復補抓按鈕，之後可再操作；舊請求的回應與 finally 僅能更新原本的 generation。傳輸錯誤／關閉、回到可見頁面與補讀前會重新檢查身份；確認 401 或身份改變時，清掉私人列表與游標、停連線並禁用操作。這不是跨分頁即時廣播的登出同步；離線時也無法即時查證伺服器狀態。WS 重連與 REST 補讀由頁面操作啟動；本例沒有背景無限重連迴圈。EventSource 有內建重連，但收到未授權時不能期待它自動重新登入。

## 32.8 代理與 drain

[Nginx 設定](examples/32/deploy/nginx.conf)將 `/api/me/socket` 的 Upgrade／Connection 正確傳入，保留 Origin。SSE 以回應 header 關閉 buffering；心跳間隔短於代理的十秒讀取期限。

HTTP client 也可能在取消串流後建立一條尚未傳送任何 HTTP bytes 的 TCP 預連線。只有 server.close 的一般 idle 清理，可能讓這條連線留到 headers 期限，導致應用先碰到自己的關閉期限。本例在 listen 前登記 socket；進入 drain 後關閉零 bytes 的預連線，保留已收到資料的請求。另有原生 TCP 回歸測試，不以延長 timeout 或 forceExit 處理。

API 進入 drain 時先關閉長連線，再等待 HTTP listener 與已追蹤 DB 輪詢結束，最後釋放 Redis／DB。只呼叫 server.close 並等待 SSE 自行結束，可能讓關閉永遠等不到。

## 32.9 執行與驗證

在 `nodejs-course/examples/32`，依 README 安裝並遷移後：

```bash
docker compose up -d api worker dispatcher
docker compose build browser-tests
docker compose run --rm browser-tests npm run test:browser
sh ci/check.sh
```

先到 `http://127.0.0.1:3032/` 登入、建立並發佈文章，再到通知頁啟動傳輸。通知可能晚於 publish 回應；確認 dispatcher、worker 與 job-redis 都正常後再排查串流。

[真 HTTP／WS 測試](examples/32/test/realtime.test.ts)檢查 Cookie／Origin、私有收件者、游標、到期、容量與 drain 後計時器清理；Chromium 真正使用 EventSource 及 WebSocket。正式 verifier 透過 CA 驗證的 HTTPS／WSS 與 Nginx 收到發佈通知，並拒絕錯誤 Origin。沿用第 31 章的 worker SIGKILL／stalled 重送及業務去重測試。

OpenAPI **32.0.0** 有 **23 paths／42 operations**，新增 SSE GET／HEAD；WebSocket 訊息規則由本文與測試描述，不計為 OpenAPI operation。

## 32.10 練習與驗收

1. 開兩個分頁，第三條本人連線應被拒絕；關掉一條後可重新連線。
2. 接收一筆後停止，再發佈另一篇，使用 REST 或相同游標補讀，確認沒有漏掉資料。
3. 使用另一個帳號及 admin，確認都收不到原帳號通知。
4. 停止 API 再啟動，確認通知仍在 PG；恢復後補讀，而不是假設 TCP 連線延續。
5. 說明 seq 空洞與晚提交的差別，以及收件者鎖為何必須在 seq 分配前取得。

完成後應能說明傳輸、通知保存、授權與去重各在哪一層，並證明斷線與關閉後沒有留下計時器或輪詢工作。

[上一章](31-background-jobs-outbox-and-idempotency.md) · [下一章：Fastify 比較](33-fastify-adapter-and-platform-boundaries.md) · [課程總覽](README.md) · [範例](examples/32/README.md) · [契約](examples/32/BASELINE.md)
