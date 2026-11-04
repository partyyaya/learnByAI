# 25 — 壓測、事件迴圈延遲、CPU／I/O 瓶頸、連線池與資源上限

> 先找出請求把時間花在哪裡，再決定要減少運算、縮短等待，還是限制同時進來的工作。

前置：[第 03 章執行模型](03-event-loop-and-concurrency.md)、[第 07 章關閉流程](07-process-signals-and-graceful-shutdown.md)、[第 21 章查詢成本](21-api-contracts-pagination-and-openapi.md)、[第 23 章外部 HTTP](23-external-http-timeouts-and-retries.md)與[第 24 章觀測](24-logging-health-and-observability.md)。本章提供[完整獨立快照](examples/25/README.md)及[契約](examples/25/BASELINE.md)。

完成本章後，你應能：

- 區分吞吐、成功吞吐、失敗率與延遲分位數，說明少量樣本的限制。
- 對照 CPU 使用量、event loop utilization、event loop delay 與依賴等待。
- 以相同運算比較阻塞與分段讓出，知道 async 不會自動平行化 CPU 工作。
- 看見 pool 取得連線的等待，並把它和 SQL 執行時間分開。
- 實作有界 admission 與來源限流，讓超額工作得到明確失敗。
- 產生 CPU profile，並確認中斷、失敗與關閉都能釋放資源。

本章不修改文章 API 的業務或新增正式端點。正式 API 的 OpenAPI 保持 18 paths／32 operations、info.version=24.0.0；只調整本章 origin 為 3025。效能路由全部放在獨立 performance-lab，沒有掛進文章 AppModule，沒有新增套件或 migration。

## 25.1 「很慢」需要拆成可以驗證的問題

同樣是 100 ms 的等待，原因可能很不同：

```text
收到請求
  → 等到 event loop 有空處理
  → 等取得應用容量
  → 等取得 DB 連線
  → 執行 SQL，或等待外部回應
  → 整理／序列化資料
  → 送出 response
```

本章的 admission 不排隊，容量滿就拒絕；DB pool 仍可能在已接受的有限工作內排隊。CPU 被同步迴圈占用時，請求甚至還沒走到 admission 就已經等在事件迴圈／socket 層。限制 handler 裡的進行中數量，不代表限制了所有作業系統或 HTTP buffer。

因此，單看「平均延遲 100 ms」不能決定增加 pool 或擴程序。先建立假設，再用可以控制的工作觀察它：

| 情境 | 本章固定工作 | 要辨認的現象 |
|------|--------------|--------------|
| baseline | 回一份小 JSON | 傳輸、框架外的基本成本 |
| cpu | 同步執行 1200 萬次整數運算 | event loop 被占用，其他請求延後 |
| yield | 同樣運算，每 25 萬次 setImmediate | 同一執行緒交錯處理，仍消耗 CPU |
| db | 取得 pg pool client，再執行固定 50 ms pg_sleep | pool wait 與 SQL 等待分離 |
| external | 真 HTTP 呼叫自有 loopback upstream，非阻塞等待 50 ms | 等外部回應時 event loop 可做別的事 |

pg_sleep 是可控制的等待，不是慢查詢的最佳化案例，也沒有讀寫文章。真實 SQL 的 EXPLAIN、索引、count 與 offset 成本請對照第 21 章。[PostgreSQL 的延遲函式](https://www.postgresql.org/docs/17/functions-datetime.html#FUNCTIONS-DATETIME-DELAY)

## 25.2 建立獨立實驗，保留正式服務

本章的 performance-lab 使用原生 Node HTTP，讓實驗工作與資源等待容易閱讀；正式文章服務仍是 Nest＋Prisma。兩者測到的成本不同，不能把 lab 的吞吐當成文章 API 容量。

| 服務 | 主機連線 | 範圍 |
|------|----------|------|
| api | http://127.0.0.1:3025 | 原文章／認證／health／metrics |
| postgres | 127.0.0.1:15425 | 開發資料與固定 SELECT 實驗 |
| performance-lab | http://127.0.0.1:3325 | 本章固定工作、stats；自有獨立 pg pool |
| external-lab／upstream | 3125／3225 | 第 23 章外部 HTTP 實驗 |
| test-db | 不公開主機端口 | 測試與分程序效能實驗 |

performance-lab 另建立一個 loopback 隨機 port 的自有 upstream，關閉時一起清理。它不是 3225 的第 23 章 upstream，不接第三方服務，也不接受任意 URL。其 timer 不阻塞事件迴圈，但上游 HTTP 的處理成本仍計入同一 lab 程序的 CPU／ELU；這不是模擬兩台機器的完整效能測試。

首次操作先完成[第 00 章 nvm／Node 安裝](00-course-map-and-project-contract.md#004-用-nvm-安裝-node-並執行第一個練習)及[第 01 章 Docker 環境](01-runtime-tooling-and-project-setup.md)。從倉庫根目錄執行：

```bash
cd nodejs-course/examples/25
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
docker compose up -d api performance-lab upstream external-lab
docker compose run --rm tools npm run test:performance-compose
```

Compose 專案為 nodejs-course-25，APP_ORIGIN=http://127.0.0.1:3025。check 只處理測試資料庫，仍須另外 deploy／seed 開發 DB。示範密碼中的 18 不換成 25；各章 Cookie 不按 port 隔離，請使用獨立 Cookie jar。

不要同時執行同目錄的 check／test／parallel／效能實驗；除了 .test-dist 會重建，額外 CPU／DB 負載也會改變量測結果。

## 25.3 先呼叫一次，確認測的是哪個端點

```bash
curl -i http://127.0.0.1:3325/health/live
curl -i http://127.0.0.1:3325/lab/work/baseline
curl -i http://127.0.0.1:3325/lab/work/cpu
curl -i http://127.0.0.1:3325/lab/work/yield
curl -i http://127.0.0.1:3325/lab/work/db
curl -i http://127.0.0.1:3325/lab/work/external
curl -fsS http://127.0.0.1:3325/lab/stats
```

正常均為 200。工作回應例如 `{ "data": { "kind": "db" } }`；cpu／yield 另附 digest，相同迭代數的 digest 必須相同。每次請求由 lab 產生 X-Request-ID，錯誤 envelope 與既有格式一致。

只接受固定 GET／HEAD，HEAD 仍執行工作；拒絕 query 與 request body。未知路徑／尾斜線 404，其他方法 405／Allow: GET, HEAD。例如：

```bash
curl -i 'http://127.0.0.1:3325/lab/work/db?sql=SELECT'
curl -i -X POST http://127.0.0.1:3325/lab/work/cpu
curl -i http://127.0.0.1:3025/lab/work/cpu
```

依序為 lab 的 400、405，以及正式文章 API 的 404。用戶不能指定運算迭代數、SQL、外部 URL 或重設統計；這些是可信程式組裝設定。stats 只有彙總數值，不回 DB URL、SQL、body、Cookie、密碼或使用者資料。

lab 的端點無認證，Compose 只將它們映射到主機 loopback，供本機實驗。它不列入正式 OpenAPI，也不代表可直接當作產品管理 API。

## 25.4 把負載產生器移到另一個程序

如果 CPU 工作與產生請求的程式跑在同一 event loop，服務一阻塞，產生器也無法準時送請求。測到的數字混入了自己停送的效果。

[check-performance.cjs](examples/25/scripts/check-performance.cjs)讓每個情境啟動一個新的服務子程序，父程序執行負載產生器。它們仍共用主機／容器資源，不代表完全隔離；但不再共用同一個 JavaScript event loop。

```bash
docker compose run --rm tools npm run lab:performance
```

不必啟動常駐 performance-lab；腳本使用 TEST_DATABASE_URL，依序建立與正常關閉自己的子程序。每個正常情境先送兩次序列暖身，再執行 20 個正式請求；這兩次暖身不保證 JIT、所有 pool 連線與快取已穩定。限流情境不暖身，避免先消耗三次配額。

八個情境依序是五種工作、poolMax=1 的 db、併發 8 的 external，以及 rateLimit=3 的 baseline。服務的預設 admission=4、poolMax=2。最後寫入 `.data/performance-proof.json`，記錄設定、負載結果、服務統計與正常關閉事件，不含連線字串。

### closed-loop 的意思

本章模型為固定總請求數、固定最多幾個進行中請求：

```text
建立最多 C 個 worker
  → 每個 worker 送一個請求
  → 等回應／失敗／期限
  → 才送下一個
  → 到達 N 次後結束
```

服務變慢時，產生器自然減少每秒發送量。這是 closed-loop，不是固定每秒到達量的 open-loop。它無法重現持續到達的真實流量，也可能低估固定到達率下的排隊延遲；不能拿本章結果宣稱最大容量、SLO 或正式 p99。

## 25.5 負載程式自己的資源也要有界

[load-generator.ts](examples/25/src/load-generator.ts)使用 Node HTTP Agent 與固定 worker 數：

| 設定／行為 | 邊界 |
|------------|------|
| 單次 run 的請求數 | 1–200 |
| client 併發 | 1–16；Agent maxSockets 同值 |
| 單次期限 | 預設 2000 ms，最大 10000 ms，包含 response body |
| response body | 最多 4096 bytes，超過就 destroy request |
| 目的地 | HTTP loopback 或 Compose performance-lab，固定工作路徑 |
| 重試 | 無；每次失敗都計入，不自動重送 |
| 統計記憶體 | 最多 200 筆 latency，結束後銷毀 Agent |

這是有界的實驗工具，不是完整壓測產品。只有單次請求期限，整個 run 的耗時還受請求數、併發與排程影響；事件迴圈被阻塞時 timer 也可能延後，期限不是 CPU 硬中斷。

成功需同時得到 HTTP 200 與正確的 data.kind。200 但內容不符合契約記 invalidResponses；過期、中斷、無法連線與過大 body 記 transportErrors，timeouts 是其中因本地 deadline 發生的子集。中止 signal 會停止排程下一次，unscheduled 明確列出未啟動數，不將它們虛構成 HTTP 結果。

## 25.6 不要用快速的 503 美化吞吐

報告同時保留：

- planned／started／unscheduled：原定、已開始與未排程的數量。
- statuses：實際完成的有限 HTTP 狀態分類。
- transportErrors／timeouts／invalidResponses：傳輸與資料契約失敗。
- successes、failureRate、attemptsPerSecond 與 successesPerSecond。
- allAttempts 與 successful 的 p50／p95／p99／max。

```text
attemptsPerSecond = started / 經過秒數
successesPerSecond = successes / 經過秒數
failureRate = (started - successes) / started
```

若 20 次中只有 4 次成功，其餘 16 次迅速回 503，完成嘗試的速度可能很高，但成功吞吐未必改善。本章 overload 情境會檢查有成功也有 503；rateLimit=3 的情境則應為 3 次 200、17 次 429。

所有 attempt 的延遲與只有成功的延遲要一起讀。單看 successful p95 會漏掉失敗用戶，單看 allAttempts 的 p95 又可能被快速拒絕拉低。transport timeout 沒有 HTTP status，不要補成 500 或 504。

分位數使用 nearest rank：排序後取 ceil(q × 樣本數) 的位置。20 筆的 p99 幾乎就是最大值；零筆回 null，不捏造 0 ms。小型可重現實驗的分位數適合觀察結構，正式容量評估仍需足夠樣本、代表性流量與反覆測量。

## 25.7 CPU、ELU 與 event loop delay 是三件事

[performance-measurement.ts](examples/25/src/performance-measurement.ts)使用 Node 內建 API，不新增監控套件。[Node performance measurement 文件](https://nodejs.org/docs/latest-v24.x/api/perf_hooks.html)

| 量測 | 本章單位與意義 | 不可直接推論 |
|------|----------------|--------------|
| process.cpuUsage 差值 | user＋system 微秒轉成 CPU ms | 整台主機 CPU 百分比 |
| cpuPerWall | CPU ms／窗口 wall ms | 單一核心使用率；程序有多執行緒時可大於 1 |
| eventLoopUtilization | active／(active＋idle) | 與 CPU 使用量完全相同；某些同步等待也會占住 loop |
| monitorEventLoopDelay | timer 取樣延遲，ns 轉 ms | 每個請求的延遲或精確的排程保證 |
| rss／heapUsed | 程序記憶體快照，bytes | 單次快照就能證明 memory leak |

CPU 與 ELU 的 measurementWindow 由暖身後、負載前後兩次 snapshot 作差；整份 server 統計、stages 與 delay histogram 仍從該情境啟動後累計，包含暖身。delay resolution=10 ms，若尚無樣本則為 null；不要把取樣解析度當成 1 ms 的精度。

```text
CPU 工作：程序 CPU 增加，loop delay／ELU 也可能上升
DB 等待：延遲增加，程序 CPU 卻可能不高
外部等待：工作仍占容量，event loop 可處理其他請求
```

這些是判讀方向，不是固定倍數保證。GC、容器配額、同機其他程序、JIT 與 client 負載也會改變結果。本章驗收檢查計數、限制與清理，不硬編碼「CPU p99 一定大於幾 ms」等速度門檻。

## 25.8 分段讓出不等於平行運算

cpu 與 yield 使用同一個整數摘要迴圈，預設 1200 萬次；每 25 萬次為一段。yield 在段與段之間使用：

```ts
import { setImmediate } from 'node:timers/promises';

await setImmediate(undefined, { signal });
```

這讓 timer、socket 與其他工作有機會執行，因此常能降低其他請求被連續阻塞的時間；但所有段仍由同一 JavaScript 執行緒運算。它可能增加排程成本，也不保證該 CPU 請求本身更快。

測試確認相同迭代數的 digest 相同，並驗證 sync 迴圈期間已排程的 immediate 無法執行、yield 可以交錯。取消 signal 只能在合作的檢查點生效，無法在同步迴圈中間強制打斷。

如果證據顯示 CPU 工作才是瓶頸，改善順序可以是減少計算量、避免重複計算、限制工作量，再評估 worker threads／其他程序或專門服務。搬到 worker 也要限制數量與任務大小；本章不新增無界 worker 或把密碼 KDF 成本降低。

## 25.9 pool 等待不是 SQL 執行時間

本章在兩個位置量測：

```text
開始 pool.connect
  → 等可用 client，記 poolWait
  → 執行固定 SELECT pg_sleep(0.05)，記 dbQuery
  → finally client.release
```

poolMax=2、admission=4 時，已接受的四個 DB 工作可能有兩個等 client；poolMax=1 時，同樣四個工作只能逐一使用連線。pool.total／idle／waiting 是 snapshot，峰值需在工作進行中觀察；結束後 waiting=0 不代表過程中從未排隊。[pg Pool API](https://node-postgres.com/apis/pool)

取得 client 的時間也可能包含建立連線；dbQuery 的耗時則包含 driver 與網路等待，不是 PostgreSQL 內部純執行時間。兩次序列暖身不會預先建立所有連線。

pool.max 只限制連線數，不能單獨阻止無限多呼叫者進入等待佇列。這裡先用 admission 限制最多四個工作，使應用造成的 pool 等待有界；connectionTimeoutMillis=2000、statement_timeout=1000 是額外邊界，不是完整請求整體期限。

不要見到 waiting 就直接把 pool 從 2 調到 200。多個程序／副本的 pool 上限會相加，DB 還要保留管理與其他服務的連線空間；慢 SQL、鎖競爭或磁碟瓶頸也不會因 pool 變大而自動改善。[pg 的 pool sizing 說明](https://node-postgres.com/guides/pool-sizing)

## 25.10 同時進來多少，與每分鐘進來多少不同

| 控制 | 本章限制 | 失敗 |
|------|----------|------|
| admission | 預設最多 4 個邏輯工作，無應用佇列 | 503 LAB_BUSY、Retry-After: 1 |
| rate limiter | 每程序、每 socket 來源，首次請求起 60 秒 1200 次 | 429 RATE_LIMITED，Retry-After 為剩餘秒數向上取整 |
| 來源表 | 最多 1000 個尚有效來源，不淘汰有效項來繞過配額 | 503 SOURCE_CAPACITY |

順序為固定路由／方法驗證 → 來源配額 → admission → 工作。被 admission 拒絕的請求也已消耗來源配額。health／stats 不計來源配額，避免用量測請求消耗工作額度；它們仍有 HTTP 處理成本。

來源使用 socket.remoteAddress，不信任 X-Forwarded-For。固定視窗由該來源第一次請求開始，視窗到期才移除；到期前後仍可能出現短時間突發。這是單程序教學策略，不是跨副本一致的全域限流。正式認證原有每來源每分鐘 20 次限制保持不變。

Retry-After 是建議等待，不保證下一次一定有容量；負載產生器不自動重試，以免把拒絕藏進後續成功。增加重試可能增加負載，相關條件請回看第 23 章。

可信啟動設定可調整 PERF_MAX_CONCURRENT（1–16）、PERF_POOL_MAX（1–8）與 PERF_RATE_LIMIT（1–10000）；非法值拒絕監聽。HTTP 不接受這些設定。

## 25.11 產生 CPU profile，找到真正的熱點

只有 latency 與 CPU 總量，仍不知道是哪個函式在用 CPU。Node 的 CPU profiler 可產生 V8 profile；本章提供不需額外 GUI 的概要讀取器。[Node 的 profiling 介紹](https://nodejs.org/learn/getting-started/profiling)

```bash
docker compose run --rm tools npm run profile:cpu
docker compose run --rm tools npm run profile:summary
```

profile:cpu 在獨立服務子程序加上 --cpu-prof、--cpu-prof-dir 與 --cpu-prof-name；先暖身兩筆，再以併發 2 執行 16 筆 CPU 工作，正常 SIGTERM 排空後退出，寫出 `.data/performance-cpu.cpuprofile`。腳本會先移除自己的同名舊 profile，再確認新檔有 samples 與 cpuDigest 節點，避免把舊產物當成功。

profile:summary 列出最多十個函式的 self sample 次數，包含 idle。這不是完整 call tree、inclusive 成本或每請求 wall latency；熱點可指向 cpuDigest，但相同函式不同呼叫位置也可能是不同節點。需要進一步分析時，可用支援 V8 .cpuprofile 的工具開啟檔案。

採樣本身會改變執行成本，所以 profile run 與一般比較分開執行。profile 含程式路徑與函式資訊，屬於診斷產物；不要直接當成公開 API 回應，也不把原始憑證或 request body 寫進 report。

## 25.12 中斷後，真正的工作還在嗎？

SQL 工作與外部工作有不同的取消能力：

```text
SQL：用戶斷線 → response 結束 → SQL 仍繼續
    → 等真 query 完成 → finally release client → 釋放 admission

外部等待：用戶斷線 → abort fetch／body
    → 自有 upstream 偵測 close → 取消 timer
    → finally 釋放容量
```

不能在 response close 就把 admission 歸零，讓新請求繼續堆到 DB；也不能只回一個 timeout，卻保留真正 fetch。cpu 的同步段則要等事件迴圈恢復才可能處理斷線，yield 可在段間合作取消。

所有已接受工作用原有 lifecycle.track 登記。正常關閉：draining → 等 HTTP／工作 → http-drained → 關自有 upstream／pool、disable monitor → closed。pool 不會因 close 或 Observable finalize 提早關閉。關閉期限五秒，失敗不宣稱正常 closed。

測試會在真正的 DB 工作進行時斷線，再呼叫 shutdown，確認 pool 尚未關閉且 admission 仍被占用，直到 SQL 結束。外部取消則檢查 upstream.active 與 admission.active 歸零，之後仍能成功呼叫。

## 25.13 完整驗收與資料保留

```bash
docker compose run --rm tools npm run test:performance
docker compose run --rm tools npm run test:performance-compose
docker compose run --rm tools npm run test:observability-compose
docker compose run --rm tools npm run test:external-compose
docker compose run --rm tools npm run test:query-api
docker compose run --rm tools npm run test:status-api
docker compose restart postgres
docker compose up -d --wait postgres
docker compose restart api
docker compose run --rm tools npm run test:query-persistence
docker compose run --rm tools npm run test:status-persistence
curl -f http://127.0.0.1:3025/api/articles/export -o /tmp/chapter-25-articles.ndjson
curl -I http://127.0.0.1:3025/api/articles/export
docker compose stop performance-lab external-lab upstream api postgres test-db
```

query-api／status-api 建立持久化比對基準，必須先跑；之後重啟 API／PG 再驗證。停止時保留 volume、文章、Session、稽核與 proof，不用 down -v。NDJSON 仍是公開教學檔，不是 DB 備份。

完整 check：generate → typecheck → 全量 Jest → build → test:runtime → 四個原 lab → lab:queries → openapi:export → test:parallel → lab:external → lab:performance。Jest 共 39 套、494 項（原 449＋新增 45），兩個 worker 另重跑 6 項。

| 檔案 | 驗證範圍 |
|------|----------|
| performance-policy.test.ts | 24 項設定邊界、配額／來源有界、重複 release、分位數、CPU 合作取消、monitor 清理 |
| performance-http.test.ts | 21 項真 HTTP／PG、pool 等待、admission／429、離線工作、真外部取消、負載 deadline／錯誤回應與非法設定 |
| check-performance.cjs | 新服務子程序、八情境、暖身、計數一致、成功／拒絕、啟動失敗與正常 shutdown |
| check-performance-compose.cjs | 常駐容器的五工作、超額 503、pool／容量數量與安全 proof |

效能實驗只執行固定 SELECT，不新增 schema 或修改開發資料；既有交易等測試仍只操作自有隨機 schema，結束後清理。這些結果不等同於壓垮服務的極限測試，正式部署、容器配額與 CI 會在下一章處理。

## 25.14 練習與判讀

### 練習一：高吞吐真的改善了嗎？

A 的 20 次皆成功、花 1 秒；B 的 20 次有 4 次成功、16 次 503、花 0.2 秒。請計算兩者的完成嘗試速率、成功速率與失敗率。

<details>
<summary>參考答案</summary>

A：20 attempts/s、20 successes/s、失敗率 0。B：100 attempts/s、20 successes/s、失敗率 80%。B 更快拒絕了工作，成功吞吐沒有增加；還要比較延遲、資源使用與業務可接受的失敗。

</details>

### 練習二：pool 等待很多，要加連線嗎？

四個工作共用一個 client，SQL 每次等待 50 ms。將 pool 改成四個 client，是否證明正式服務也應直接增加 pool？

<details>
<summary>參考答案</summary>

固定 pg_sleep 的獨立等待可以平行重疊，不代表真實 DB 能承受更多 SQL。先分開 poolWait、dbQuery、DB 資源與鎖等待，確認多程序總連線預算；必要時改善查詢或限制工作，而不是無條件加大 pool。

</details>

### 練習三：async 迴圈與 yield

把同一 cpuDigest 呼叫包進 async 函式，但不增加任何讓出點，已排程的 timer 是否能在迴圈中間執行？為什麼 yield 版本也不保證更快？

<details>
<summary>參考答案</summary>

async 不會把同步計算搬離執行緒。只有合作讓出才讓其他工作交錯；yield 增加排程機會也增加成本，仍在同一執行緒完成相同迭代數。CPU 平行化與公平排程是不同問題。

</details>

### 練習四：只看 p99 的漏洞

只有 20 筆成功結果、未計入 timeout；報告 p99=10 ms。這足以證明所有使用者都很快嗎？若負載是 closed-loop，還缺什麼資訊？

<details>
<summary>參考答案</summary>

不足。需要總嘗試數、成功數、失敗／timeout、所有 attempt 與成功延遲、樣本量與量測窗口。20 筆 p99 近似最大值；closed-loop 在服務變慢時會減少送入量，沒有模擬固定到達率下持續累積的佇列。

</details>

### 完成檢查

- [ ] 能區分完成嘗試速率、成功速率、失敗率與分位數。
- [ ] 知道暖身、取樣解析度、同機資源與 closed-loop 的限制。
- [ ] 看過 CPU／yield／DB／外部等待的 CPU、ELU、delay 與 stage 數據。
- [ ] 能解釋 pool wait 與 query 時間，知道 pool.max 不會限制所有等待者。
- [ ] 503 與 429 分開計數，不以重試掩蓋拒絕。
- [ ] 已產生並讀取 CPU profile，沒有把採樣結果當 wall latency。
- [ ] SQL／外部中斷後資源清理正確，正常 drain 不提早關 pool。
- [ ] 正式文章契約、持久化與完整 check 通過，正常停止本章容器。

下一章：[26 — 建置、CI 與部署](26-build-docker-ci-and-deployment.md)：正式建置、容器、migration 部署步驟、CI、代理與 HTTPS。

---

[下一章：建置與部署](26-build-docker-ci-and-deployment.md) · [上一章：日誌與觀測](24-logging-health-and-observability.md) · [返回課程總覽](README.md) · [本章範例](examples/25/README.md) · [本章契約](examples/25/BASELINE.md)
