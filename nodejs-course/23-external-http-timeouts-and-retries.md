# 23 — 外部 HTTP、期限、取消、有限重試與冪等條件

第 22 章確認了測試組裝與資料隔離。現在把另一個會失敗的邊界加進來：**外部服務可能很慢、回錯誤、傳到一半斷線，甚至已經完成寫入，卻沒有把回應送回來。**

本章使用可控制的本機外部服務與獨立 Nest gateway，練習期限、取消、有限重試與錯誤轉換。文章 API 與稽核交易保留，不把網路重試套進既有文章寫入。[完整範例](examples/23/README.md)與[本章契約](examples/23/BASELINE.md)均可執行。

## 23.1 本章完成後應能做到什麼？

- 分清傳輸失敗、HTTP 錯誤與資料契約錯誤。
- 為一個邏輯操作設定整體預算，並另外限制每次嘗試。
- 將 AbortSignal 傳到真正的 fetch、body 讀取與退避等待。
- 只對明確適合的讀取操作作有限重試，處理 Retry-After。
- 解釋取消與回應遺失為什麼不能證明遠端回滾。
- 以真 HTTP 測試次數、資源清理與安全錯誤，不依賴第三方網站。

先讀 [04 — 非同步錯誤與資源生命週期](04-async-errors-and-resource-lifecycle.md)、[19 — RxJS／回應邊界](19-interceptors-filters-and-cross-cutting-concerns.md)、[20 — 交易](20-persistence-transactions-and-concurrency.md)、[22 — 測試與資料隔離](22-testing-modules-database-and-http.md)。

沿用 Node 24.22.1、npm 11.19.1、Nest 11.2.8、Jest 30.2.0 等固定版本。本章使用 Node 原生 fetch、AbortController、Web Streams 與 timers/promises，沒有新增 HTTP client 套件或 migration。官方 Node 文件連結採 24.x 分支，範例實測版本仍固定為 24.22.1。

## 23.2 先分清三個服務

```text
正式文章 API（3023）→ PostgreSQL（15423）
  保留 Session、CSRF、文章、稽核、列表與 OpenAPI

獨立 Nest external-lab（3123）
  GET／HEAD /lab/topics/:id
    → singleton external client
      → 本機 upstream（3223，容器內 4000）
```

external-lab 不匯入文章 AppModule，也不連資料庫；upstream 只提供可控制的回應與記憶體計數。沒有寄信、通知真實使用者或呼叫第三方帳號。

這讓我們能安全重現慢 headers、慢 body、503、錯誤 JSON、斷線與回應遺失，不必依賴外部網站當天的行為。未來將 client 接進應用 Service 時，也應保留清楚的模組與交易邊界。

正式 API 不新增 /lab 路由，OpenAPI 仍是原 17 paths／30 operations，info.version 保留 21.0.0。實驗端點與錯誤代碼不偷偷變成文章 API 契約。

## 23.3 fetch 完成，不代表業務資料正確

至少要依序處理三種結果：

| 層次 | 例子 | 應檢查什麼 |
|------|------|------------|
| 傳輸 | 無法連線、socket 中斷、body 讀取失敗 | 真正 I/O 是否失敗或被取消 |
| HTTP | 404、429、503、redirect | status 是否符合這個操作的契約 |
| 資料 | 200 但 JSON 壞掉、label 是數字、id 不符 | media type、bytes、編碼與執行期 schema |

fetch 不會只因 404 或 503 自動 reject。取得 Response 也不表示 body 已經完整讀完；若只限制等 headers 的時間，遠端可能接著永遠不結束 body。[Node 24 fetch 與 AbortSignal 文件](https://nodejs.org/download/release/latest-v24.x/docs/api/globals.html)

本章 [external-client.ts](examples/23/src/external-client.ts)對 GET 要求 200，對示範 POST 要求 202，再驗證資料。HTTP 錯誤不直接當成功 JSON 解析，錯誤 body 也不轉送給用戶。

### 在真正的 I/O 邊界分類

不要把整個 Service 裡的任意錯誤都當成網路暫時失敗。像本機 callback 的 TypeError，可能是程式 bug，不應因此自動重試。

本章在 fetch 與 reader.read 的呼叫邊界將傳輸 rejection 轉成應用自己的 AttemptFailure，再由策略決定是否重試。本機 observer callback 在這個邊界之外執行，錯誤會往外傳。

這也避免只靠 `instanceof TypeError` 判斷原生 fetch 錯誤：在 Jest 等不同執行環境中，錯誤物件可能不是目前環境的 TypeError 實例。測試同時保留真斷線與本機程式錯誤案例。

## 23.4 目的地、容量與回應大小都要有邊界

client 的 origin 由可信設定提供，不是使用者傳入的 URL。Controller 只接受有限格式的 topic ID，再組成固定路徑：

```text
可信 REFERENCE_ORIGIN + /topics/ + 合法 ID
```

origin 不包含帳密、path、query 或 fragment；不自動跟隨 redirect。HTTP 只為本機 loopback 與 Compose upstream 提供教學例外，可信 HTTPS 設定則可指向遠端。

這些規則可以避免把本章路由做成任意 URL 代理，但不是完整的 DNS／egress 安全機制。實際目的地政策仍需配合部署環境，不能把一個字串檢查當成所有網路存取的保證。

client 不轉送使用者 Cookie、Authorization、CSRF 或任意 header；只帶 Accept、程式產生的 X-Course-Operation，以及 POST 所需的 Content-Type。

### 每個 client 最多四個進行中操作

```text
進行中操作少於 4 → 取得容量 → 執行與重試 → finally 釋放
已達 4 → 立即 UPSTREAM_BUSY，不無界排隊
```

獨立 Nest Provider 共用一個 client，因此容量限制會跨請求生效。若每請求都 new client，這個上限就失去意義。多程序／多副本的總容量仍會累加，本章不宣稱提供分散式限流。

### 回應 body 也可能耗盡資源

預設最多 4096 bytes：

1. 先檢查 Content-Length，已超過就拒絕。
2. 即使沒有 Content-Length，仍逐 chunk 累計實際讀取 bytes。
3. 超過上限就取消 reader，不繼續累積。
4. 以 fatal UTF-8 解碼，再 JSON.parse，再驗證 schema。

fetch 的解壓縮可能讓實際 body 大於 header 表示的傳輸內容，因此不能只信 Content-Length。這個小型 JSON 邊界也不能代替大檔案串流設計。

不需要的 HTTP 錯誤 body 會明確取消，reader 在 finally 清理並釋放 lock，避免遠端錯誤 body 永不結束時卡住下一次重試。

### 上游未知欄位不直接成為公開欄位

topic schema 驗證 id 與 label，label trim 後為 1–80 code points，id 必須符合本次請求。上游可附帶未知欄位，但 client 只回 `{ id, label }`。

這與本課對使用者 body 採 strictObject 的目的不同：外部回應可能新增 metadata，我們明確投影必要欄位；使用者不能因此替文章寫入額外 authorId 或角色。

## 23.5 整體期限與單次期限

本章預設：

| 限制 | 預設 | 範圍 |
|------|------|------|
| totalTimeoutMs | 800 ms | 整個邏輯操作，含所有嘗試、body 與退避 |
| attemptTimeoutMs | 250 ms | 某一次 fetch 與 body 讀取 |
| maxAttempts | 3 | 包含第一次，最多三次應用層 fetch 呼叫 |

```text
整體預算 800 ms
  ├─ attempt 1：headers＋body，最多 250 ms
  ├─ 退避：使用剩餘整體預算
  ├─ attempt 2：最多 250 ms，不能超過剩餘時間
  ├─ 退避
  └─ attempt 3：只使用剩餘預算
```

不能每次重試都重新給完整的整體 timeout，否則用戶等待時間會隨重試次數擴張。client 用 monotonic clock 計算剩餘時間，避免系統 wall clock 調整直接改變操作預算。

這些期限依賴事件迴圈與底層取消支援，不是任意 CPU 工作的硬中斷。若程序被同步運算阻塞，timer 也可能延後處理；測試不斷言某個窄毫秒範圍一定準時結束。

### Promise.race 不會自動取消 I/O

```ts
await Promise.race([fetch(url), timeoutPromise]);
```

這只能決定哪個結果先完成；若 fetch 沒收到 signal，外部工作可能仍在跑。回了 504 不等於已釋放網路與容量。

本章把 caller、整體與單次 signal 合併，真正傳入 fetch：

```ts
signal: AbortSignal.any([operation, single.signal])
```

其中 operation 已合併 caller 與整體 deadline。每次嘗試的 timer 在內層 finally 清除，整體 timer 與 active 計數在外層 finally 清理，避免完成後又誤觸發取消。

## 23.6 取消必須一路傳下去

```text
用戶在回應完成前斷線
  → response close
  → caller.abort
  → fetch／body 讀取，或退避 timer 被取消
  → client finally 釋放容量
  → 已登記工作完成
```

gateway 監聽 response 的 close，並檢查 writableFinished。不要把 request 的 close 一律當成用戶放棄：GET 的 request body 已經讀完，不代表用戶不再等待 response。

退避也使用可取消的 timers/promises：

```ts
await delay(waitMs, undefined, { signal: operation });
```

取消發生在等下一次重試時，就不應再發新請求。[Node 24 timers/promises 文件](https://nodejs.org/download/release/latest-v24.x/docs/api/timers.html)

測試會等到上游真正收到慢請求才取消，然後檢查 active 歸零與請求次數，不以固定 sleep 猜測取消是否有效。已取消的 caller 則完全不發送。

### 取消不等於回滾

AbortSignal 只通知合作的底層停止後續等待或工作，不能收回已寄出的請求，也不能抹去遠端已提交的副作用。本章沒有把它接到 Prisma 交易，也沒有改變第 19 章「取消 from(Promise) 訂閱不等於取消 Promise」的界線。

正常 shutdown 仍先排空已接受工作；外部操作有自己的期限，完成後才關 Nest。沒有在開始 drain 時一律取消所有工作，更沒有先關資料庫 pool。

## 23.7 哪些錯誤可以重試？

重試需要同時回答兩件事：**操作是否適合重送，以及故障是否可能暫時恢復。**

| 結果 | 本章 GET 策略 |
|------|---------------|
| 傳輸中斷、單次期限 | 剩餘預算內可重試 |
| 429、502、503、504 | 剩餘預算內可重試 |
| 404 | 不重試，轉成外部資料不存在 |
| 400、500、其他 status、redirect | 不重試；這是本章明確選定的策略 |
| 錯誤 JSON、UTF-8、media type、大小、schema 或 id | 不重試 |
| caller 取消、整體預算耗盡 | 不再重試 |
| 本機程式錯誤 | 往外傳，不假裝是暫時網路故障 |

不是所有 5xx 都自動重試，也不是所有 timeout 都應無限重送。最多三次包含第一次；如果剩餘時間不夠或 Retry-After 太長，可以更早停止。

這是局部 client 策略，不使用全域 RxJS retry、timeout Interceptor 或通用 DB retry。否則一個全域 retry 可能重新執行文章寫入、Guard 或其他不應重做的流程。

### 有上限的退避與 jitter

沒有有效 Retry-After 時，本章採 full jitter：

```text
cap = min(200 ms, baseDelayMs × 2^(已失敗次數 − 1))
wait = 0 到 cap 之間的隨機整數
```

預設 base 30 ms，第一次失敗後最多 30 ms，第二次失敗後最多 60 ms。jitter 是減少多個呼叫同時重送的方式，不是容量、成功率或正式延遲的保證。

上限與總預算都要存在；只增加 backoff 而不限制重試次數，仍可能讓工作長期占用資源。

## 23.8 Retry-After 不能為了方便而縮短

Retry-After 可是非負整數秒數，也可是 HTTP-date。[RFC 9110 的 Retry-After 定義](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3)

```text
Retry-After: 0       → 可立即進行下一次有限嘗試
Retry-After: 3600    → 本章 800 ms 預算不夠，停止，不提早重送
HTTP-date           → 以 wall clock 計算等待時間
無效值              → 採本地有上限的退避
```

不能把 3600 秒直接 clamp 成 100 ms 後重試，那不是遵守上游要求。超大秒數也不能溢位成極短 timer；本章先檢查剩餘預算，過大或非有限的延遲直接停止。

HTTP-date 與整體預算使用不同的 clock：日期需要 wall clock，操作預算仍用 monotonic clock。日期精度與時鐘偏差也會影響等待值，不能把它當成精確跨系統倒數。

解析器接受 IMF-fixdate、舊式 RFC 850 與 asctime 三種 HTTP-date，並檢查日曆日期；ISO 字串不當成 HTTP-date。RFC 850 的兩位年份依目前時間判讀，超過未來 50 年才回到上一世紀。不能直接依賴 Date.parse 的固定年份分界，例如目前為 2026 年時，70 應能代表 2070，而非被當成 1970 後立即重試。[RFC 9110 日期格式與年份規則](https://www.rfc-editor.org/rfc/rfc9110.html#section-5.6.7)

## 23.9 POST 回應遺失，為什麼不能直接重送？

本機 upstream 的 POST /deliveries 有一個刻意的情境：

```text
client POST lost-example
  → upstream 收到 body
  → deliveries 加 1
  → socket 斷線，沒有成功回應
client 收到傳輸錯誤
  → 只嘗試一次
  → UPSTREAM_WRITE_UNCERTAIN
```

用戶沒收到成功，不代表遠端沒有執行。若 client 自動再送一次，計數就可能再加一次；真實系統可能變成重複寄信、重複建立工作或重複扣款。

HTTP 對非冪等操作的自動重試需要額外依據，例如明確知道原操作沒有生效，或伺服器有相應冪等保證。[RFC 9110 冪等方法與重試](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2)

本章 sendDelivery 即使收到 503 也不自動 retry；它只供獨立實驗，不掛成 gateway POST 路由，也不參與文章交易。

### 追蹤 ID 不是冪等鍵

X-Course-Operation 讓 upstream 知道 GET 的第幾次嘗試屬於同一邏輯操作，但沒有持久去重或重播結果的能力。upstream 的記憶體計數在重啟後也會消失。

真正的冪等設計需要伺服器約定 key 的範圍、相同 key 的請求內容、併發處理與保存結果，不能只在 header 加一個 UUID 就宣稱完成。未來可靠副作用還可能需要 Outbox 等流程，本章不提前實作。

## 23.10 轉成穩定且安全的 HTTP 錯誤

client 的 ExternalError 不附帶 URL、上游原始 body 或 stack 的公開內容。獨立 Nest Controller 再轉成既有安全 HttpError：

| 代碼 | lab HTTP | 用戶可理解的結果 |
|------|----------|------------------|
| UPSTREAM_NOT_FOUND | 404 | 找不到外部資料 |
| UPSTREAM_BAD_RESPONSE | 502 | 外部回應不符合契約 |
| UPSTREAM_UNAVAILABLE | 503 | 有限嘗試後仍不可用，或預算不足以重試 |
| UPSTREAM_BUSY | 503 | 本 client 容量已滿 |
| UPSTREAM_TIMEOUT | 504 | 外部工作超過期限 |
| UPSTREAM_CANCELLED | 內部取消 | 已離線不補第二份 JSON；仍連線時為 503 |

錯誤仍為 error／requestId envelope，requestId 與 X-Request-ID 一致。未知本機程式錯誤維持安全 500，不能把它吞成 200 或冒充遠端 503。

gateway 成功只回 `{ data: { id, label } }`。HEAD 無 body，但仍發上游 GET，可能消耗相同容量與重試次數；不是完全不做工作的健康檢查。

## 23.11 可控制的外部服務，比碰運氣測網站可靠

[reference-upstream.ts](examples/23/src/reference-upstream.ts)提供固定情境，每次邏輯操作有自己的追蹤 ID，所以 retry 情境可以重複觀察：

| topic ID | 上游行為 |
|----------|----------|
| ok | 200，附帶不公開的 internal 欄位 |
| retry | 同一操作前兩次 503，第三次 200 |
| retry-after | 第一次 429／Retry-After:0，第二次 200 |
| long-retry-after | 429／Retry-After:3600 |
| slow-headers／slow-body | 不送 headers，或送部分 body 後停止 |
| unavailable／drop | 持續 503，或直接斷線 |
| bad-json／bad-utf8／wrong-shape | 傳輸完成但資料不合法 |
| oversize-header／oversize-stream | 有／無 Content-Length 的過大 body |

只觀察根據結果猜重試次數不夠，因此 stats 記錄每種情境的收到次數、active、aborted 與 delivery 計數，並檢查是否收到不該轉送的認證 header。

這些是本機教學故障與觀測介面，不能直接當正式服務管理 API。程式不記錄或轉送真實密碼、Cookie 或 CSRF 值。

### 測試範圍

| 檔案 | 驗證內容 |
|------|----------|
| external-policy.test.ts | 24 項設定、Retry-After、jitter 與界線 |
| external-client.test.ts | 27 項真 HTTP、body、取消、容量、重試與 POST 結果 |
| external-lab.test.ts | 9 項 Nest Provider／Controller、錯誤、HEAD、斷線與 drain |

新增 **60 項**，原 368 項保留，合計 **35 套、428 項 Jest**。雙 worker 另重跑原六項，不把重跑當成新增測試。

測試使用 loopback 隨機 port，不需要網際網路，也不改原 HTTP 契約。它會觀察真正收到的請求次數、取消後 active 歸零、POST 副作用已發生與單次嘗試，而不是只 spy 一個假的 fetch。

```bash
docker compose run --rm tools npm run test:external
docker compose run --rm tools npm run test:baseline
```

native fetch 與真 timer 的整合不以全域 fake timer 取代；jitter／Retry-After 的純策略另作可重現測試。測試等待明確條件並設上限，不依賴窄毫秒效能門檻。

## 23.12 Docker 操作與驗收

從倉庫根目錄開始：

```bash
cd nodejs-course/examples/23
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

Compose 為 nodejs-course-23。主機端口：正式 API 3023、開發 PG 15423、external-lab 3123、upstream 3223；test-db 不公開。示範帳號密碼中的 18 沿用原值。

check 依序執行 generate → typecheck → 全量 Jest → build → test:runtime → 四個原 lab → lab:queries → openapi:export → test:parallel → lab:external。所有會重建 .test-dist 的測試指令都不能彼此，或與依賴它的程序／查詢實驗並行。

### 不開資料庫也能執行外部實驗

```bash
docker compose run --rm tools sh -c 'npm run generate && npm run build'
docker compose run --rm -e DATABASE_URL= -e TEST_DATABASE_URL= tools npm run lab:external
```

前提是已 build tools 與 npm ci。generate／build 為完整快照產生 Prisma 型別，但不連 DB；第二行清空兩個 DB 設定，證明獨立實驗不需資料庫。

lab:external 自行建立並關閉兩個隨機 port 服務，輸出 `.data/external-proof.json`。Compose 驗收則連正在執行的兩個容器，輸出 `.data/external-compose-proof.json`，包含嘗試次數、斷線取消、認證欄位未轉送與 POST 單次寫入結果。

### 手動觀察外部邊界

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

依序為 200、200、404、503、504、502。Compose depends_on 只是啟動順序，不等於 readiness；驗收腳本會等待真正能回應。stats 是累計值，若前面已執行腳本，不應期待全表次數仍是第一次的數字。

正式 API 的重啟與收尾沿用：

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

先成功執行 query-api／status-api，再做 persistence 比對。最後先停 gateway 再停 upstream，正常關閉文章 API 與 DB；保留資料 volume、文章、稽核與 proof，不使用 down -v。

NDJSON 仍是獨立公開教學檔，不是資料庫或外部服務備份。upstream 記憶體計數重啟會歸零，也不是稽核或可靠通知保存機制。

## 23.13 練習與完成檢查

### 練習一：找出看似有 timeout 的漏洞

某 client 只對 `await fetch(url)` 作 Promise.race，收到 headers 後才 `await response.json()`。遠端若送完 headers 就停止，會發生什麼？

<details>
<summary>參考答案</summary>

headers 階段的期限已結束，body 可能無界等待；Promise.race 也沒有自動取消 fetch。必須讓同一期限的 signal 涵蓋 fetch 與 body，限制 bytes，並在 finally 清理。

</details>

### 練習二：列出重試條件

分別判斷 GET 503、GET 壞 JSON、GET 404、caller 取消、POST 寫入後斷線、本機 callback TypeError。本章哪些能重試？

<details>
<summary>參考答案</summary>

只有 GET 503 在剩餘預算內可有限重試。資料契約錯誤與 404 不重試；caller 取消不再發送；POST 斷線結果不確定；本機 TypeError 應往外傳，不冒充網路故障。

</details>

### 練習三：驗證取消後資源可再使用

閱讀 maxConcurrent=1 的測試，讓一個慢 body 占用容量，第二個呼叫得到 BUSY；取消第一個後，確認新的 ok 請求成功。

驗收時同時檢查 active、上游收到次數與真正的成功回應，不能只驗證 abort 被呼叫。

### 練習四：設計真正的冪等契約

假設未來要建立外部工作，列出重送時如何辨認相同操作、相同 key 但不同內容如何處理、第一次結果未知時 client 如何查詢，以及去重結果由誰保存。這是設計練習，本章不新增通知或資料表。

### 完成檢查

- [ ] 外部 client 的 URL、headers、容量、body 與 schema 都有明確邊界。
- [ ] 整體期限不因重試重設，body 與退避也可取消。
- [ ] 本機程式錯誤不被 blanket retry，錯誤 body 不洩漏。
- [ ] 最多三次包含第一次，Retry-After 不被提前縮短。
- [ ] POST 回應遺失已驗證只嘗試一次，能解釋結果為何不確定。
- [ ] 用戶斷線釋放真正外部工作，正常 drain 等工作結束。
- [ ] 428 項全量、雙 worker、外部程序與 Compose 驗收通過。
- [ ] 正式 API／交易契約保留，資料與 proof 保留並正常停止。

下一章：[24 — 結構化日誌與觀測](24-logging-health-and-observability.md)：結構化日誌、request ID、敏感資料遮蔽、健康／就緒與基本指標。

---

[下一章：日誌與觀測](24-logging-health-and-observability.md) · [上一章：測試與資料隔離](22-testing-modules-database-and-http.md) · [返回課程總覽](README.md) · [本章範例](examples/23/README.md) · [本章契約](examples/23/BASELINE.md)
