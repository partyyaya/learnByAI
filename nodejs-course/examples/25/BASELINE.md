# 效能、負載與資源限制：第 25 章契約

承接[第 24 章契約](../24/BASELINE.md)。正式文章／認證／權限／稽核交易／列表／日誌／健康／metrics 保留；新增獨立 performance-lab 與有界負載實驗，無新增套件或 migration。

## 1. 服務界線

- Compose nodejs-course-25；正式 API 3025、PG 15425、external-lab 3125、upstream 3225、performance-lab 3325；test-db 不公開。
- APP_ORIGIN=http://127.0.0.1:3025，Cookie 需本章獨立 jar，示範密碼中的 18 不變。
- performance-lab 使用原生 Node HTTP、獨立 pg Pool，只做 SELECT 1 與固定 pg_sleep(0.05)，不讀寫文章、不建立 schema。
- 自有 upstream 只在 loopback 隨機 port，與 lab 同程序，50 ms 可取消 timer；不是 3225 的舊 upstream。lab 正常關閉時一起關閉。
- lab 不掛文章 AppModule，不新增正式路由。正式 OpenAPI 保持 info.version=24.0.0、18 paths／32 operations，只有本機 origin 改為 3025；HTTP／匯出同一來源。
- 原 Prisma pool、scrypt 成本、認證限流、Session／CSRF、版本／狀態／稽核交易與 NDJSON 契約不變。

## 2. 固定 HTTP 實驗契約

GET／HEAD /health/live、/lab/stats、/lab/work/{baseline,cpu,yield,db,external}，無認證、no-store、服務 UUID。固定工作回 `{ data: { kind } }`，cpu／yield 另有 digest；相同迭代數 digest 相同。

只接受精確路徑，沒有 query／request body。未知／尾斜線 404、query 400 INVALID_QUERY、body 400 UNEXPECTED_BODY、其他方法 405／Allow: GET, HEAD。HEAD 無 body 但仍執行工作。錯誤為安全 error／requestId envelope，與 X-Request-ID 相同，不回原始 SQL、driver message、stack、URL 或輸入。

lab 公開供本機實驗，Compose 主機只映射 loopback；不代表正式產品管理 API。HTTP 不接受任意 SQL／外部 URL／CPU 次數／配額設定，也不提供統計 reset。stats 只有有限種類的數值，不記 requestId／userId／原始 URL 作 label。

## 3. 工作與資源上限

- cpu：1200 萬次固定整數迴圈；yield：相同迴圈每 25 萬次以 timers/promises.setImmediate 讓出。同一執行緒，沒有 CPU 平行化。
- db：pool.connect → 固定參數化 SELECT pg_catalog.pg_sleep(0.05) → finally release，poolWait 與 dbQuery 分開計時。不是 SQL 最佳化或真資料容量測試。
- external：fetch 自有固定 /wait，1000 ms signal 涵蓋 fetch／body，redirect=error、不轉送認證資訊；自有上游只回固定小 JSON，不宣稱是通用外部 client。第 23 章一般外部 client 策略仍獨立保留。
- admission 預設 4，可信設定 1–16；無應用佇列，滿載 503 LAB_BUSY、Retry-After:1。同步 CPU 仍可能在入口前阻塞，不宣稱限制所有 socket／OS buffer。
- pool.max 預設 2，可信設定 1–8；connectionTimeoutMillis=2000、statement_timeout=1000。pool.max 不限制所有等待者，本 lab 由 admission 限制已接受工作數。
- 每程序、每 socket 來源首次工作請求起 60 秒 1200 次，超過 429 RATE_LIMITED，Retry-After 向上取整。最多 1000 有效來源，滿表新來源 503 SOURCE_CAPACITY，不淘汰有效來源，不信任 X-Forwarded-For。
- 順序：路由／方法／body → 來源配額 → admission → 工作。admission 拒絕也消耗來源配額；health／stats 不消耗工作配額。
- PERF_MAX_CONCURRENT、PERF_POOL_MAX、PERF_RATE_LIMIT 為可信啟動設定；非法或缺少 DB URL 拒絕監聽，輸出固定 startup_failed 事件，不輸出憑證。

固定視窗可在到期前後突發，配額與 pool 在多程序會相加；不是全域分散式限流，也沒有自動 retry。

## 4. 量測與負載定義

runLoad 只接受 HTTP loopback／Compose performance-lab origin 與固定 kind，1–200 次、1–16 concurrency；Agent socket 上限同 concurrency。每個 worker 等上一次完成才送下一次，是 closed-loop，不保證固定到達率。

單 attempt 預設 2000 ms、最大 10000 ms deadline，涵蓋慢 body；response 最多 4096 bytes。沒有整個 run 的獨立硬期限，事件迴圈阻塞仍會延後 timer。最多保留 200 個 latency，finally 銷毀 Agent，不 retry。

200＋正確 data.kind 才算成功；錯誤 200 計 invalidResponses，傳輸／中斷／過大 body／deadline 計 transportErrors，timeouts 是其中子集。HTTP 狀態與傳輸錯誤分開，不偽造 status。停止 signal 不再排程，unscheduled 明列未開始數。

報告包含 planned／started／unscheduled、statuses、失敗分類、successes、failureRate、attemptsPerSecond／successesPerSecond，全 attempt 與成功樣本的 nearest-rank p50／p95／p99／max；無樣本為 null，不隱藏失敗。

CPU 為 process.cpuUsage 差值 user＋system 轉 ms，cpuPerWall 不是整機百分比，可能大於 1。ELU 不是 CPU 的同義詞。monitorEventLoopDelay resolution=10 ms，ns 轉 ms，無樣本 null；RSS／heapUsed 只作快照，不宣稱已證明 memory leak。

分程序腳本每個情境建立新服務子程序，父程序產生負載；仍共用主機資源。一般兩次序列暖身後跑 20 次，不保證 JIT／所有 pool 連線已穩定。CPU／ELU measurementWindow 在暖身後負載前後作差；server delay histogram、stages 與其他資料仍從情境啟動後累計，含暖身。

八情境為五工作、db poolMax=1、external concurrency=8、baseline rateLimit=3（此項無暖身）。測試檢查計數與限制，不斷言特定機器的延遲／吞吐倍數。closed-loop 與少量樣本不能證明正式容量或 SLO。

## 5. 取消與關閉

SQL 離線不等於取消 query，client 與 admission 要等真正 query 完成才釋放。外部 fetch／body 收到 caller signal，upstream close 取消 timer；yield 在檢查點合作取消，同步 CPU 不可在迴圈中間硬中斷。

工作用原 lifecycle.track 登記。正常順序：draining → 等 HTTP／工作 → http-drained → 關自有 upstream／pool、disable monitor → closed。五秒期限失敗不冒充 closed；重複 shutdown 共用同一 Promise。初始化失敗也關 pool／monitor／已建 upstream，不提前關共用資源。

## 6. 產物與驗收

- .data/performance-proof.json：八情境設定、負載、服務統計、CPU／ELU 差值與 shutdown。
- .data/performance-compose-proof.json：常駐 lab 五工作與 admission 超額驗收。
- .data/performance-cpu.cpuprofile：2 暖身＋16 次併發 2 的 CPU 子程序，以 --cpu-prof 採樣後正常關閉；移除自己的同名舊檔再產生，驗證 samples 與 cpuDigest 節點。
- profile:summary：self sample 前十節點，含 idle，不是 inclusive call tree／wall latency。profile 有程式路徑與函式資訊，不作公開 API 回應。

新增 Jest 2 套、45 項：policy 24、HTTP 21；原 449 保留，全量 39 套、494 項，雙 worker 另重跑 6 項。真 HTTP／PG 驗證固定工作、pool.waiting、超額 503、429／XFF、SQL 離線／drain、真 fetch 取消、callback 失敗清理、load 慢 body deadline、錯誤 200 與非法設定；不靠窄毫秒性能斷言。

check 順序：generate → typecheck → Jest → build → test:runtime → 四個原 lab → lab:queries → openapi:export → test:parallel → lab:external → lab:performance。profile 另跑，避免採樣改變比較。所有同目錄測試／效能指令依序執行。

Compose 另驗證 performance／observability／external、query-api／status-api、API／PG 重啟持久化與 NDJSON GET／HEAD。只清理自有測試 schema；效能 SELECT 不修改資料。最後正常停止本章六個服務，保留 volume／文章／稽核／profile／proof，不用 down -v，不 staging／commit。
