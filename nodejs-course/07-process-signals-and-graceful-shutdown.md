# 07 — 程序生命週期、信號與有界關閉

> 停止服務也是一條需要設計與測試的流程：先停止接新工作，再等待已接受的工作，最後釋放資源。

06 章已處理「用戶端取消下載」。本章換一個方向：如果服務正在傳送檔案，此時部署工具要求它停止，應該怎麼辦？

完成本章後，你應能：

- 區分一次請求結束、HTTP server 關閉與整個程序退出。
- 處理 SIGINT／SIGTERM，說明 SIGKILL 的限制。
- 停止接受新工作，等待既有回應與後續清理。
- 為整段關閉流程設定期限，區分正常完成與強制結束。
- 讓 Docker 的停止信號到達 Node，並以子程序測試退出結果。

前置：[06 章](06-files-buffers-streams-backpressure.md)。本章保留文章查詢、預覽與 NDJSON 匯出，新增關閉協調器與 `/health/ready`；仍沒有資料庫。

## 07.1 為什麼不能一收到信號就 exit？

想像一個已經開始的下載：

```text
用戶端正在收檔案
    ↓
部署工具送出「請停止」信號
    ↓
服務停止接新工作
    ↓
等待既有下載結束，以及 FileHandle 關閉
    ↓
關閉共用資源，程序退出
```

如果收到信號就立即 `process.exit(0)`，傳到一半的內容會被截斷，尚未執行的 `finally` 也沒有完成保證。反過來，如果永遠等待，用戶端不送完 body、慢速下載或卡住的清理工作都可能讓部署停住。

本章選擇的策略是：**給既有工作一段完成時間，整段流程超過期限就回報失敗並結束程序。** 這個期限是產品與操作上的取捨，不代表每個請求一定能成功。

## 07.2 先跑起來，再停止一次

完整範例：[examples/07](examples/07/README.md)。從倉庫根目錄執行：

```bash
cd nodejs-course/examples/07
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose up -d api
curl -i http://127.0.0.1:3007/health/ready
docker compose stop api
docker compose logs api
docker compose ps -a api
```

正常停止的主要日誌順序：

```text
LISTENING {"host":"0.0.0.0","port":3000}
SIGNAL SIGTERM
SHUTDOWN draining
SHUTDOWN http-drained
SHUTDOWN closed
```

`ps -a` 應顯示退出碼 0。`logs` 可能含先前啟動的紀錄，要看最後一次。主機連接埠為 **3007**；容器內仍是 3000。修改程式後需重新建置，再重新啟動 `api`。

需要匯出時，先執行 `docker compose run --rm tools npm run seed`，操作與 06 章相同。沒有 seed 不影響健康檢查與其他文章端點。

本機 Node 路線使用同版 Node／npm，依序執行 `npm ci`、`npm run check`、`npm start`，預設連接埠 3000。本章信號測試以 Linux Docker 為可重現環境；Windows 對信號的支援與模擬方式不同，不應直接套用 POSIX 測試預期。[Node 信號文件](https://nodejs.org/docs/latest-v24.x/api/process.html#signal-events)

## 07.3 Node 程序何時會結束？

`await` 一個 Promise，並不等於一定有底層工作讓程序持續存活。

```js
// 概念示例：沒有 timer、socket 或其他持續活動的資源。
new Promise(() => {});
```

這個永不完成的 Promise 本身不會讓 Node 永遠執行。監聽中的 server、仍被引用的 timer 等資源，才會影響事件迴圈是否還有工作。

| 狀態 | 代表什麼 | 尚未保證什麼 |
|------|----------|--------------|
| 呼叫 `res.end()` | 應用不再寫入這次回應 | 遠端已保存完整資料 |
| HTTP server 關閉完成 | 相關 HTTP 連線已結束 | 應用額外建立的 Promise／資源都已清理 |
| 關閉協調器完成 | 本章登記的請求工作與資源清理完成 | 未登記的背景工作也完成 |
| Node 程序退出 | 此執行實例已停止 | 所有外部副作用都成功 |

因此，06 章的串流函式必須把關檔放在自己回傳的 Promise 裡。本章才能等待整個 `route()`，包含 `finally`，而不是只看到回應結束就認定工作完成。

## 07.4 信號不是一般 HTTP 請求

| 信號 | 常見來源 | 本章處理方式 |
|------|----------|--------------|
| SIGINT | 終端機 Ctrl+C | 進入同一套關閉流程 |
| SIGTERM | Docker stop、部署工具 | 進入同一套關閉流程 |
| SIGKILL | 強制停止、外部等待期限到期 | 無法攔截，不能依靠 finally |

在支援 POSIX 信號的環境，為 SIGINT／SIGTERM 安裝 listener 後，原本的預設退出行為會被替換。應用要自己安排何時結束。[Node 信號文件](https://nodejs.org/docs/latest-v24.x/api/process.html#signal-events)

本章入口在開始監聽後註冊：

```ts
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
```

`stop` 的責任是啟動關閉、記錄結果與決定退出碼；它不放在文章業務函式裡。重複收到信號時直接返回，避免同時執行兩份清理流程。

### exitCode 與 exit 的不同

- 正常完成：設定 `process.exitCode = 0`，讓已釋放資源的程序自然退出。
- 關閉失敗或超時：本章入口使用 `process.exit(1)` 作最終結束手段。這條路徑可能截斷日誌或剩餘工作，不能宣稱完成清理。
- 設定錯誤：不啟動 server，設定退出碼 1。

不要把非同步清理放進 `process.on('exit', async () => ...)`；exit listener 只能可靠地做同步工作。`beforeExit` 也不是信號關閉的替代方案。[Node 程序退出文件](https://nodejs.org/docs/latest-v24.x/api/process.html#event-exit)

## 07.5 關閉流程要依什麼順序執行？

本章用 [shutdown.ts](examples/07/src/shutdown.ts) 協調以下階段：

| 順序 | 動作 | 理由 |
|------|------|------|
| 1 | 設定 `draining = true` | 已存在連線上後來到達的請求也要被拒絕 |
| 2 | 開始整體期限 timer | 等待 HTTP 與清理資源共用同一份時間預算 |
| 3 | 呼叫 `server.close()` | 停止接受新連線，等待既有 HTTP 工作 |
| 4 | HTTP 關閉後，反覆等待目前登記的 handler Promise，直到集合為空 | 已接受請求可能稍後才讀完 body；離線或回應後仍可能有資料操作及 finally |
| 5 | 呼叫 `closeResources(signal)` | 等請求不用共用資源後才關閉它們 |
| 6 | 清除期限 timer，回報完成 | 讓程序自然退出 |

程式輪廓如下；完整錯誤與期限處理請讀範例：

```ts
draining = true;
await httpClosed;
while (tasks.size > 0) {
  signal.throwIfAborted();
  await Promise.allSettled([...tasks]);
}
signal.throwIfAborted();
await closeResources?.(signal);
```

這裡的 `allSettled` 用來等待各工作走到完成或失敗。請求失敗已由自己的 HTTP 錯誤處理回應；不應因一個請求驗證失敗，就直接跳過其他工作清理。

不能只在 shutdown 開始時複製一次 tasks。已接受的請求可能仍在收 body，之後才登記資料操作；若客戶端隨即離線，HTTP 關閉也不代表資料操作完成。先等 HTTP 關閉，再檢查仍登記中的工作，才能涵蓋這條路徑。等待 HTTP 時，各 Promise 仍會繼續執行，並不是把工作暫停到下一階段。

`closeResources` 是未來資料庫連線池等資源的接點，**本章主程式沒有假裝連接資料庫**。測試會注入可控制的清理函式，驗證順序與失敗結果。

## 07.6 close、closeAllConnections 與請求入口各負責什麼？

本課固定 Node 24。此版本的 `server.close()` 會停止接受新連線並處理閒置連線，等待仍在使用的連線；不需要額外照搬舊版教學的閒置連線清理技巧。`closeAllConnections()` 則會強制中斷活動中的 HTTP 連線，本章只在期限到達時呼叫，且先前已呼叫過 `close()`。[Node HTTP 關閉 API](https://nodejs.org/docs/latest-v24.x/api/http.html#serverclosecallback)

停止接受新連線，和拒絕已有連線上的新請求，是不同責任。因此 [server.ts](examples/07/src/server.ts) 的路由入口先做：

```ts
if (lifecycle.isDraining) {
  throw new HttpError(503, 'SHUTTING_DOWN', '服務正在關閉');
}
```

這個檢查只發生在工作開始時。已經通過入口、正在收 body 的請求，可以在期限內繼續完成；不能在收到停止信號時立即把所有既有工作都當成新請求拒絕。

關閉開始後，新的 TCP 連線通常會遇到拒絕連線；如果請求仍經既有連線進到路由，才有機會得到 503。**不要把「所有新請求一定收到 JSON 503」當成保證。**

### live 與 ready

本章提供 `/health/live` 與 `/health/ready`，運作中都回 200；開始關閉後統一經過入口拒絕規則。

- live 用來觀察程序是否能回應。
- ready 用來表達服務是否適合接工作；本章尚未加入資料庫等依賴檢查。

這是本機的最小示範。實際代理的摘除傳播、readiness 探測頻率與容器平台設定，會在部署章延伸；光新增一個 ready URL 不會自動通知代理。

## 07.7 為什麼還要追蹤 handler Promise？

06 章的匯出流程大致是：

```text
開啟檔案 → pipeline 寫入回應 → finally 關閉檔案 → route Promise 完成
```

HTTP 連線關閉與 FileHandle 的非同步清理，不一定在同一刻完成。因此 server 會把工作登記到協調器：

```ts
void lifecycle.track(route(req, res)).catch(handleRequestError);
```

這是呼叫輪廓；範例的錯誤處理直接寫在 catch 裡。`track()` 保留原本 Promise，成功或失敗都會從集合移除。`shutdown()` 等 HTTP 關閉後，再等待集合中的工作；這也包含停止前已接受、停止後才登記的工作。

這個做法有明確前提：

1. 新請求在 draining 後不再啟動業務工作。
2. 一個 handler 建立的非同步工作，應由它 `await` 或 `return` 到結束。
3. 額外工作必須在所屬 handler／已追蹤工作結束前登記。不能讓一個未追蹤的 timer 在所有工作都完成後才啟動任務，期待協調器預知它。

這也是為什麼本章仍使用一個小型 HTTP 服務。背景佇列與 worker 需要自己的登記、停止與等待設計，不能只靠這個集合。

## 07.8 期限到了，能保證什麼？

本章預設 `SHUTDOWN_TIMEOUT_MS=3000`，接受 1–60000 的整數。這份預算包含 HTTP 排空、handler 清理與共用資源清理。

到期時會：

1. 送出 AbortSignal，讓合作式的共用資源清理得知取消。
2. 呼叫 `closeAllConnections()` 中斷尚未結束的 HTTP 連線。
3. 讓 shutdown Promise 失敗，由入口以退出碼 1 結束。

這不保證尚未跑完的 finally 都能完成。06 章的 response close 仍會觸發串流取消，但到達最終強制退出路徑時，已經不能承諾完成應用清理。

另外有兩個容易忽略的限制：

- **timer 需要事件迴圈才能執行。** 若同步 CPU 工作卡死 JavaScript，應用自己的 3 秒期限也無法準時執行，必須靠外部程序管理工具的期限。
- **關閉協調器只知道登記過的資源。** 若有漏掉的 interval，成功路徑的 `exitCode = 0` 不會幫你清掉它。本章沒有此類背景 timer；後續加入資源時要一起補關閉責任。

`closeAllConnections()` 不涵蓋已升級的 WebSocket 等連線。本章範例只處理一般 HTTP/1，不能直接宣稱它已是所有協定通用的關閉管理器。[Node 強制關閉說明](https://nodejs.org/docs/latest-v24.x/api/http.html#servercloseallconnections)

## 07.9 Docker 的信號要真正送到 Node

本章 [compose.yaml](examples/07/compose.yaml) 的 API 服務改為直接啟動 Node：

```yaml
init: true
stop_grace_period: 8s
command: ["node", "--enable-source-maps", "dist/main.js"]
```

`init: true` 讓容器使用小型 init 處理信號轉送與子程序回收。API 指令直接啟動 Node，可以清楚觀察真正服務程序接到的信號；npm 仍用於安裝、建置與測試。

`docker compose stop api` 預設先送 SIGTERM，等待設定的寬限時間後才強制停止。此處 Node 的應用預算是 3 秒，外部給 8 秒，保留結束與排程餘裕。如果調大應用期限，也要檢查 Docker 的期限。[Docker Compose 服務設定](https://docs.docker.com/reference/compose-file/services/#stop_grace_period)

不需要移除 volume 來練停止程序；停止、刪除容器與刪除資料是不同操作。

## 07.10 用真正的程序驗證信號

```bash
docker compose run --rm tools npm run test:runtime
```

[check-signals.cjs](examples/07/scripts/check-signals.cjs) 會啟動建置後的 `dist/main.js`，使用系統分配的連接埠，再送真實信號。它測試：

| 情境 | 預期結果 |
|------|----------|
| 非法 PORT 或關閉期限 | 啟動失敗，退出碼 1 |
| 空閒服務收到 SIGINT／SIGTERM | 依序排空與關閉，退出碼 0 |
| 已開始的 POST 在 SIGTERM 後送完 | 仍收到 200，再正常退出 |
| 關閉中重複收到同一信號 | 只啟動一次關閉流程 |
| 已開始的 POST 一直不結束 | 到達期限，中斷連線，退出碼 1 |

上傳測試使用 `Expect: 100-continue` 確認服務已接到請求，再送信號；不靠隨便等待幾毫秒猜測啟動時機。測試也有外部 watchdog，失敗時會回收自己建立的子程序。

`npm run check` 另外執行 39 項 Jest 測試，涵蓋上一章的 HTTP／串流行為，以及「回應結束後仍在清理」「共用資源清理失敗」「清理也會超時」「停止後才讀完 body 並登記工作，客戶端隨即離線」等案例。要區分兩層證據：Jest 驗證協調順序，子程序檢查驗證實際入口與退出結果。

## 07.11 常見問題、練習與驗收

| 現象 | 優先檢查 |
|------|----------|
| Docker stop 沒看到 SIGNAL 日誌 | 容器啟動的是 Node 還是另一層程序？是否已重新建置？ |
| 停止後仍不退出 | 是否有未登記的 timer、socket 或其他資源？ |
| 一開始停止，下載就全斷了 | 是否太早呼叫 closeAllConnections 或 process.exit？ |
| 一直等不到關閉 | 是否缺少整體期限，或事件迴圈被同步工作卡住？ |
| 檔案清理還沒做就關了共用資源 | 是否只等待 HTTP，而沒等待 handler Promise？ |
| Docker 比應用更早強殺 | stop_grace_period 是否小於應用等待預算？ |

### 練習一：先關資料庫會怎樣？

假設請求還在讀資料庫，就先執行 `pool.end()`，再等待 HTTP 結束，可能有什麼結果？

<details>
<summary>參考答案</summary>

仍在處理中的請求可能失去需要的資源。本課順序是先停止接新工作、等待已接受的工作，再關共用資源；整段過程仍需共享一個等待期限。

</details>

### 練習二：控制一個慢速下載

建立較大的教學檔案，使用 06 章的 curl 限速方法下載，再於另一個終端機執行 `docker compose stop api`。觀察是在期限內完成，還是到期中斷；不要把 curl 接收速度等同於 Node 已交給系統緩衝的速度。

### 練習三：重複呼叫為何不能重做？

閱讀 `shutdown()` 的 `completion` 變數，說明第二次呼叫為什麼回傳同一個 Promise。再找出對應的 Jest 測試。

### 本章完成檢查

- [ ] 能說明 HTTP 回應結束與整個工作清理完成的差別。
- [ ] 已用 Docker 停止服務，確認正常關閉順序與退出碼。
- [ ] 能解釋新連線被拒絕和已有連線收到 503 的差別。
- [ ] 期限涵蓋排空與資源清理；失敗時不回報正常完成。
- [ ] 知道 SIGKILL、CPU 阻塞與未登記資源的限制。
- [ ] 已通過 `npm run check`，看過實際信號與上傳測試。

下一章開始 [Express 路由與 HTTP 契約](08-express-routing-and-http-contracts.md)，以框架接手路由組合，保留已建立的請求與資源管理觀念。

---

[上一章：檔案與串流](06-files-buffers-streams-backpressure.md) · [返回課程總覽](README.md) · [本章範例](examples/07/README.md)
