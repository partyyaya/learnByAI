# 外部 HTTP、期限、取消與有限重試：第 23 章契約

本章承接[第 22 章契約](../22/BASELINE.md)。文章 API、認證、權限、交易、列表、OpenAPI、fixture 與 worker 隔離保留；新增獨立外部服務實驗，不掛入文章 AppModule，不新增套件或 migration。

## 1. 三個服務的界線

- 正式文章 API：主機 3023，仍有 PostgreSQL、Session 與原 17 paths／30 operations。
- external-lab：主機 3123，獨立 Nest app，GET／HEAD /lab/topics/:id，沒有資料庫、認證或文章路由。
- upstream：主機 3223，容器內 4000，可控制的本機故障服務，提供 /topics/:id、POST /deliveries 與 /__lab/stats。它只有記憶體計數，不寄信、不連第三方、不寫文章。

正式 API 的 OpenAPI info.version 仍為 21.0.0，只調整本機 origin 範例為 3023。外部實驗不加進正式 API 文件，不以實驗代碼改變原文章錯誤。

## 2. client 的範圍與限制

createExternalClient 使用 Node 24 原生 fetch，目的 origin 由可信設定提供，不接受使用者任意 URL。origin 不含帳密、path、query、fragment；HTTPS 可供可信遠端設定，HTTP 只接受本機 127.0.0.1／localhost 與 Compose upstream 主機名稱。這不是完整 DNS／egress 安全機制。

getTopic 的 id 僅為 1–40 個小寫英數／連字號，且開頭為字母；URL 以固定 /topics/:id 組合。不跟隨 redirect，不轉送 Cookie、Authorization、CSRF 或任意用戶 header；只傳 Accept、程式生成的 X-Course-Operation，以及 POST 的 Content-Type。

預設每個 singleton client 最多 4 個進行中邏輯操作，超額立即 UPSTREAM_BUSY，不無界排隊。每操作最多 3 次 fetch 呼叫；這個應用層計數不宣稱涵蓋底層 TCP／DNS 的所有行為。

回應只接受預期 status、application/json 與 UTF-8。先檢查 Content-Length，再串流累計實際 body bytes，上限 4096；沒有 Content-Length 也受限。HTTP 錯誤或不接受的回應會取消不用的 body，reader 於 finally 清理。

JSON 與執行期 schema 均須通過；topic id 必須與請求相同，label trim 後 1–80 code points。上游未知欄位可存在，但只投影 id／label，不回傳 internal 或原始 body。

## 3. 期限與取消

預設整體期限 800 ms、單次期限 250 ms。整體預算包含所有嘗試、body 讀取與退避等待，使用 monotonic clock 計算剩餘時間，不於 retry 重設。

每次 fetch 合併 caller、整體及單次 AbortSignal；退避用可取消的 timers/promises。單次與整體 timer 都在 finally 清理；active 容量也在 finally 釋放。沒有只用 Promise.race 回錯卻放任真正 I/O 繼續。

gateway 監聽 response close，只有未正常完成時才取消外部工作；不把 GET request body 結束當作用戶離線。已接受的工作使用 lifecycle.track，正常 drain 等它完成，再關 Nest context；沒有改動文章 API 的取消／shutdown 策略。

AbortSignal 不會回滾遠端已發生的副作用，也不會自動取消 Prisma 交易。期限依賴事件迴圈及底層合作，不是任意 CPU 工作的硬中斷。

## 4. 有限重試策略

| 結果 | GET | POST |
|------|-----|------|
| fetch／body 傳輸中斷 | 有剩餘預算時可重試 | 不重試，結果可能不確定 |
| 單次期限 | 有剩餘預算時可重試 | 不重試，結果可能不確定 |
| 429、502、503、504 | 有剩餘預算時可重試 | 不重試 |
| 404 | 不重試 | 不重試 |
| 其他 status，包含 400、500、redirect | 不重試 | 不重試 |
| JSON、UTF-8、media type、大小、schema、id 不符 | 不重試 | 不重試 |
| caller 取消或整體預算耗盡 | 不再重試 | 不重試 |
| 本機 callback／程式錯誤 | 不誤認成網路故障 | 不重試 |

最多 3 次包含第一次，不是第一次加三次。無 Retry-After 時採 full jitter：0 到 min(200 ms, baseDelayMs × 2^(已失敗次數−1))，預設 base 30 ms。

Retry-After 支援非負十進位秒數與 IMF-fixdate／RFC 850／asctime HTTP-date；拒絕無效日曆日期與 ISO 字串，兩位年份依 RFC 的未來 50 年規則判讀。無效值採本地退避。大值不溢位成短延遲；超過剩餘整體預算時直接回失敗，不縮短上游要求後提早重送。HTTP-date 使用 wall clock，整體預算仍用 monotonic clock。

本機 observer callback 錯誤保留為未知程式錯誤，不 blanket catch 後重試；錯誤資訊不直接對外公開。沒有全域 RxJS retry、timeout Interceptor、DB retry 或自動重送文章寫入。

## 5. POST 回應遺失的實驗

sendDelivery 只供獨立實驗，不掛 gateway POST 路由。ack- 前綴回 202；reject- 回 503 且不產生計數；lost- 先增加一次 deliveries，再斷線。

lost- 的 client 只呼叫一次 fetch，回 UPSTREAM_WRITE_UNCERTAIN；deliveries 已加一。這不代表遠端回滾，也不代表可以直接手動重送。X-Course-Operation 只是追蹤欄位，不是冪等鍵；upstream 不提供持久去重保證。

## 6. 獨立 Nest HTTP 邊界

GET／HEAD /lab/topics/:id 成功為 `{ data: { id, label } }`。id 非法或 query 非空回 400；不支援方法 405、Allow: GET, HEAD；詳細路徑尾斜線 404。HEAD 無 body，但仍呼叫上游 GET，使用相同容量與重試規則。

| lab 錯誤 | HTTP |
|----------|------|
| UPSTREAM_NOT_FOUND | 404 |
| UPSTREAM_BAD_RESPONSE | 502 |
| UPSTREAM_UNAVAILABLE／UPSTREAM_BUSY | 503 |
| UPSTREAM_TIMEOUT | 504 |
| UPSTREAM_CANCELLED | 內部取消；連線已離線不補寫 JSON，仍連線時為 503 |

沿用安全 error／requestId envelope 與 X-Request-ID，不回上游 body、URL、stack 或 driver 訊息。未知程式錯誤維持安全 500。singleton Provider 共享同一 client 容量；不每請求建立 client 來繞過限制。

## 7. 測試與執行

完整 Jest 35 套、428 項，原 368 項保留，新增 policy 24、client 27、Nest lab 9。兩 worker 另重跑原 6 項，不計為新測試。原兩份文章 HTTP 契約與第 22 章逐位元相同。

新增測試使用 loopback 隨機 port 真 HTTP，驗證重試次數、慢 headers／body、取消／退避／容量釋放、拒絕不重試、未知應用錯誤、POST 已寫入但回應遺失、header 不轉送、HTTP 錯誤、安全投影與正常 drain。不依賴真實第三方服務或窄毫秒效能門檻。

lab:external 建立並關閉自己的 upstream／Nest app，輸出 .data/external-proof.json，不用資料庫。test:external-compose 連正在執行的兩個實驗容器，驗證嘗試次數、用戶斷線與 POST 不重送，輸出 .data/external-compose-proof.json。

check 順序：generate → typecheck → 全量 Jest → build → test:runtime → 四個原 lab → lab:queries → openapi:export → test:parallel → lab:external。test／focused／parallel／external 測試都會清除 .test-dist，不能與彼此或依賴它的程序／查詢實驗並行。

## 8. 版本、資料與收尾

Compose nodejs-course-23；正式 API 3023、PG 15423、external-lab 3123、upstream 3223。test-db 不公開端口。版本、lockfile 套件節點、Prisma schema／migration、Express／Multer overrides 沿用；示範密碼仍含 18。

upstream 的 stats 與故障路由只供本機教學，重啟即失去記憶體計數，不是正式管理介面或持久通知功能。沒有新的外部帳號、第三方訊息、Outbox、排程或資料庫副作用。

最後先停 external-lab，再停 upstream，並正常停止 api／postgres／test-db；保留資料 volume 與 proof，不用 down -v。NDJSON 仍為獨立公開教學檔，不是 DB／外部結果備份；不執行 Git staging／commit。
