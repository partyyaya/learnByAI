# 03 — 事件迴圈、microtask、I/O 與併發

> `async` 讓函式回傳 Promise，不會自動把 CPU 運算搬到另一條執行緒。

前兩章已建立工具與模組。本章開始觀察 Node 執行程式的方式：一項工作等待時，其他工作何時能前進？同一項工作如果改成大量計算，結果又有何不同？

完成本章後，你應能：

- 追蹤同步程式、`await` 後續、Promise callback 與 timer 的執行位置。
- 理解 CommonJS／ESM 頂層情境對 `nextTick` 順序的影響。
- 區分等待 I/O、阻塞 JavaScript、worker pool 工作與 Worker Threads。
- 說明併發、平行、有限併發及其代價。
- 用可重現實驗觀察阻塞，而不把某次毫秒數當成保證。

前置：[02 章](02-modules-packages-and-configuration.md) 與基本 Promise／async-await。範例沿用 Node 24.22.1 與前面的 TypeScript／Jest 工具，這次是獨立的執行模型實驗，不需要 `.env` 或資料庫。

## 03.1 為什麼另一個使用者也變慢了？

假設文章 API 同時接到兩項工作：

1. Alice 要匯出大量文章，程式正在組合與處理內容。
2. Bob 只想查一篇文章的標題。

如果 Alice 的工作只是等待資料，Node 有機會處理 Bob 的請求。但如果 Alice 的工作在同一條 JavaScript 執行緒上連續計算很久，Bob 的處理函式即使已準備好，也只能等待。

本章先用「慢工作＋一個快速探針 callback」觀察這個差別。探針代表另一項等待被執行的工作，**不是 HTTP 請求本身**；05 章才建立真正的 HTTP 服務。

## 03.2 執行方式與檔案分工

從倉庫根目錄開始：

```bash
cd nodejs-course/examples/03
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm start
```

若使用本機 Node，先確認 `.nvmrc` 與 npm 版本，將容器前綴移除即可。後文所有指令都在本章範例目錄執行；Docker 路線在 `node ...`／`npm ...` 前面加上 `docker compose run --rm tools`。

| 檔案 | 觀察目標 |
|------|----------|
| [order.cjs](examples/03/experiments/order.cjs)、[order.mjs](examples/03/experiments/order.mjs) | 相同程式在兩種頂層情境的順序 |
| [io-order.cjs](examples/03/experiments/io-order.cjs) | 檔案 I/O callback 裡的 immediate 與 timer |
| [microtasks.cjs](examples/03/experiments/microtasks.cjs) | 連續 `await Promise.resolve()` 與 timer 的先後 |
| [latency.ts](examples/03/src/latency.ts) | 等待與 CPU 阻塞對另一項工作的影響 |
| [concurrency.ts](examples/03/src/concurrency.ts) | 限制同時進行的工作數量 |
| [pool.cjs](examples/03/experiments/pool.cjs) | worker pool 中的工作競爭 |

`npm run check` 包含 **8 個 Jest 測試與 6 項真實 Node 程序實驗**。事件迴圈的觀察不放在 Jest 的執行包裝內，也不用假計時器模擬 Node 的實際排程。

## 03.3 先建立夠用的執行模型

先以一條 JavaScript 執行緒來看：

```text
1. 執行目前的 JavaScript
       │ 遇到非同步 API，登記工作或等待
       ▼
2. 目前這段程式結束／暫停
       │ 處理相應的 nextTick 與 microtask 檢查點
       ▼
3. 事件迴圈讓已準備好的 timer、I/O 等 callback 有機會執行
       │ callback 本身也是 JavaScript
       └─ 回到前面的步驟
```

這是閱讀本章的簡化模型，不代表所有 callback 都在同一個先進先出佇列。Node 有不同階段，`process.nextTick` 也不是其中一個獨立階段。

| 名稱 | 本章先掌握的意思 |
|------|------------------|
| 呼叫堆疊（call stack） | 目前正在執行的函式呼叫；一般同步函式執行途中，不會被另一個 timer callback 插入 |
| 事件迴圈（event loop） | 協調何時處理不同類型的 callback |
| microtask | 例如 Promise 的 `.then`、`queueMicrotask` 與已恢復的 `await` 後續 |
| `process.nextTick` | Node 特有的排程機制；順序還要看當下是否已在執行 microtask |
| timers／poll／check | 可分別用到期 timer、I/O 處理、`setImmediate` 建立初步對照 |

事件迴圈的完整階段可查 [Node.js 官方說明](https://nodejs.org/en/learn/asynchronous-work/event-loop-timers-and-nexttick)。本章先觀察具體情境，不要求背一張涵蓋所有版本細節的順序表。

## 03.4 實驗一：`async` 的哪一段會立即執行？

兩個 `order` 檔案的內容相同，只是副檔名不同。核心如下：

```js
const events = ['sync:start'];
process.nextTick(() => events.push('nextTick'));
Promise.resolve().then(() => events.push('promise'));
queueMicrotask(() => events.push('queueMicrotask'));
(async () => {
  events.push('async:before-await');
  await Promise.resolve();
  events.push('async:after-await');
})();
events.push('sync:end');
setTimeout(() => console.log(JSON.stringify(events)), 0);
```

執行：

```bash
npm run order
```

本章固定環境下的順序：

| 順序 | CommonJS 頂層 `.cjs` | ESM 頂層 `.mjs` |
|------|---------------------|----------------|
| 1 | `sync:start` | `sync:start` |
| 2 | `async:before-await` | `async:before-await` |
| 3 | `sync:end` | `sync:end` |
| 4 | `nextTick` | `promise` |
| 5 | `promise` | `queueMicrotask` |
| 6 | `queueMicrotask` | `async:after-await` |
| 7 | `async:after-await` | `nextTick` |

先看兩邊相同的部分：呼叫 async 函式後，第一個 `await` 之前仍立即執行；遇到 `await` 才把後續留到之後。即使等待的是已完成的 Promise，也不代表後續會同步接著跑。

再看差異：CommonJS 這個頂層情境會先處理 `nextTick`；ESM 的頂層評估本身已處於非同步模組執行流程，這裡排入的 microtask 會先被處理。不能把左欄推廣成「任何地方 nextTick 都永遠比 Promise 早」。[Node.js 的 nextTick 與 microtask 情境說明](https://nodejs.org/api/process.html#when-to-use-queuemicrotask-vs-processnexttick)

本章保留兩個原生檔案，就是為了讓模組格式與執行情境可見。若貼進測試框架、瀏覽器 Console 或另一個 Promise callback，請重新確認前提。

## 03.5 實驗二：timer 是門檻，不是準時保證

`setTimeout(callback, 0)` 不表示現在立刻執行，也不保證恰好零毫秒後執行。callback 仍要等目前程式、相關佇列與事件迴圈排程；延遲只是安排執行的條件之一。[Node.js timers 文件](https://nodejs.org/api/timers.html)

因此，不要在頂層把 `setTimeout(..., 0)` 與 `setImmediate(...)` 的順序當作跨情境保證。

本章選擇比較明確的情境：在檔案讀取 callback 內安排兩者。

```js
readFile(__filename, (error) => {
  if (error) throw error;
  const events = ['io:callback'];
  setTimeout(() => {
    events.push('timeout');
    console.log(JSON.stringify(events));
  }, 0);
  setImmediate(() => events.push('immediate'));
});
```

執行 `node experiments/io-order.cjs`，預期：

```text
["io:callback","immediate","timeout"]
```

在這個 I/O callback 情境，接下來的 check 階段可以處理 `setImmediate`，再輪到後續 timer。重點是先描述「在哪裡排程」，再討論順序。

這裡讀取的是範例自己的檔案，不需要外部服務。callback 內的 `throw` 只是讓這個獨立實驗在讀取失敗時結束；04 章會說明如何將 callback 錯誤接回呼叫端。

## 03.6 實驗三：一直 await，為什麼 timer 還在等？

執行：

```bash
node experiments/microtasks.cjs
```

程式先安排 timer，再連續執行 1000 次 `await Promise.resolve()`。預期輸出：

```text
["microtasks:done","timer"]
```

每次 `await` 確實暫停目前 async 函式，但後續又排進 microtask。持續補入 microtask，不等於讓 timer 或 I/O callback 取得執行機會；無界限地重複會造成飢餓。本例刻意限定 1000 次，讓觀察可以正常結束。

若要把一段可拆分計算切成小塊，可以在每塊之間等待 `node:timers/promises` 的 `setImmediate`：

```ts
import { setImmediate as yieldToLoop } from 'node:timers/promises';

// 示意：processChunk 是你能拆分且控制大小的同步工作。
for (const chunk of chunks) {
  processChunk(chunk);
  await yieldToLoop();
}
```

這段是設計示意，不是額外的可執行檔。它增加其他工作被處理的機會，但每一塊仍可能阻塞；如果單塊計算就很重，還需要重新切分、改演算法，或考慮 Worker Threads。

## 03.7 實驗四：等待與 CPU 工作的差別

執行 `npm start`，會依序比較兩種慢工作，再示範有限併發。

| 情境 | 慢工作做什麼 | 探針 callback 的位置 |
|------|--------------|---------------------|
| `waiting` | 以非同步 timer 模擬等待 120 ms | 在慢工作完成前有機會執行 |
| `cpu` | 在 JavaScript 裡忙碌迴圈約 120 ms | 等計算結束後才能執行 |

timer 等待是用來模擬等待中的空檔，不是資料庫或網路效能測試。兩種情境都使用 async 函式，差別在函式裡做的事情。

輸出會包含 `events`、`probeMs` 與 `totalMs`。應觀察到：

```text
waiting：slow:start → probe → slow:end
cpu：    slow:start → slow:end → probe
```

`probeMs` 表示從安排探針到真正執行的經過時間。CPU 情境的探針會被忙碌迴圈拖延；確切數值則受硬體、容器負載與排程影響，不需要等於教材某個固定數字。

這也說明以下寫法仍會阻塞：

```ts
async function buildExport() {
  const result = expensiveSynchronousCalculation();
  return result;
}
```

`new Promise(resolve => resolve(expensiveSynchronousCalculation()))` 也一樣，Promise 的 executor 本身同步執行。函式回傳 Promise，與裡面的計算在哪裡執行，是兩個問題。

## 03.8 worker pool 與 Worker Threads 是什麼？

Node 程序並不是只有一條執行緒。常見的非同步檔案操作、部分加密與壓縮工作可以使用 libuv worker pool；網路 I/O 通常依賴作業系統的非阻塞機制，不能把所有非同步工作都想成丟給 pool。[Node.js 對事件迴圈與 worker pool 的說明](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop)

| 工作 | 常見執行方式 | 可能拖慢誰 |
|------|--------------|------------|
| 大量同步 JavaScript 計算 | 目前 JavaScript 執行緒 | 等待同一執行緒處理的其他 callback |
| 非同步檔案／部分 crypto 操作 | worker pool | 使用同一 pool 的其他工作 |
| 網路等待 | 作業系統通知與事件迴圈協調 | 仍受連線、遠端容量及回應處理成本影響 |
| 自己建立的 Worker Thread | 另一個 JavaScript 執行環境 | 有啟動、資料傳遞、記憶體與 CPU 競爭成本 |

Worker Threads 不會因為加上 `async` 就自動建立；libuv worker pool 也不會自動接手你寫的任意 JavaScript 迴圈。

### 觀察 pool 裡的排隊

```bash
npm run pool
```

這個指令在**新子程序啟動前**設定 `UV_THREADPOOL_SIZE=1`，依序送出較長與較短的 `pbkdf2` 工作，再送出檔案讀取與 timer 探針。

輸出包含各工作完成時的 `elapsedMs`。通常能看到短的 crypto 工作也被前面的長工作拖延，而 timer 探針仍能提早回應，因為主 JavaScript 執行緒沒有被那段原生計算直接占住。

請比較排隊現象，不要把一次觀察到的完整完成順序當成所有機器的保證。測試只確認各工作完成與指定 pool 設定，不以毫秒門檻判斷通過。

本實驗的固定字串與加密參數只用於製造工作量，不是密碼儲存建議。也不要看到排隊就直接把 pool 開很大；增加執行緒仍會競爭 CPU 與記憶體，需要量測。[Worker Threads 官方文件](https://nodejs.org/api/worker_threads.html)

## 03.9 併發不等於平行，也不等於越多越好

- **併發**：多項工作在一段時間內都處於進行中，例如 A 等回應時先處理 B。
- **平行**：多項工作在不同運算資源上同時執行，例如多個 CPU 核心上的計算。

非同步 I/O 很適合讓等待重疊，但無法保證遠端或資料庫能承受任意數量的工作。

假設 `loadArticle` 回傳 Promise，三種安排如下：

```ts
// 逐一等待：下一筆直到上一筆完成才開始。
for (const id of ids) {
  await loadArticle(id);
}

// 一次全部啟動：Promise.all 本身沒有併發上限。
const results = await Promise.all(ids.map(id => loadArticle(id)));

// 有限併發：本章的 helper 最多同時執行兩筆。
const limited = await mapConcurrent(ids, 2, id => loadArticle(id));
```

這是操作方式的示意，`loadArticle` 尚不是實際 API。`Promise.all` 接收的是已經建立的 Promise，不會自動把同步工作搬到背景；結果依輸入順序排列，也不表示實際完成順序相同。

本章的 [mapConcurrent](examples/03/src/concurrency.ts) 用共用索引分配工作，工作完成後才拿下一筆。這裡的 `worker()` 只是 async 函式名稱，**不是作業系統執行緒或 Worker Thread**。

範例最多同時處理兩篇文章，輸出中的 `concurrency.peak` 應為 2。這只是單一程序內的上限，不會限制其他程序或服務實例。

### 其中一項失敗，其他工作呢？

本 helper 收到錯誤後停止派發新項目，並讓呼叫端收到 rejection；已開始的工作仍可能繼續。`Promise.all` 的拒絕不等於取消其他 Promise，下一章會處理這個責任。

不能把 `ids.forEach(async id => ...)` 外面加一個 `await` 就當作等待所有工作，因為 `forEach` 不收集 callback 回傳的 Promise。需要明確使用 `for...of`、`Promise.all` 或有限併發工具。

## 03.10 測試如何避免變成硬體速度競賽？

[有限併發測試](examples/03/test/concurrency.test.ts) 使用可由測試主動完成的 Promise：先暫停前兩項，確認第三項尚未開始，再讓其中一項完成。這樣能驗證上限與順序，不必猜測「等 10 ms 應該夠」。

事件迴圈實驗則用獨立 Node 程序，檢查有明確前提的事件順序。測試不要求某個 probe 必須在 3 ms 內完成，也不把 timer 當成精準時鐘。

| 要回答的問題 | 使用的證據 |
|--------------|------------|
| CPU 是否阻擋探針？ | `slow:end` 與 `probe` 的相對順序 |
| 兩個檔案的頂層情境是否不同？ | `.cjs`／`.mjs` 各自的實際輸出 |
| 同時進行數是否受限？ | 主動控制 Promise 完成，記錄正在進行的數量 |
| pool 是否可能互相影響？ | 限定 pool 的獨立程序觀察；時間值只作診斷 |

量測正式 API 的吞吐量、延遲分位數與事件迴圈延遲，會在 25 章深化；本章只建立判讀方向。

## 03.11 常見錯誤、練習與驗收

| 誤解 | 修正方向 |
|------|----------|
| async 函式內的計算都在背景 | 檢查實際工作是不是同步 CPU 計算 |
| await 一定讓其他 I/O callback 前進 | 已完成 Promise 的後續仍在 microtask；要看等待的對象 |
| timer 到期就一定立即執行 | 它仍要等 JavaScript 與事件迴圈有機會處理 |
| nextTick 永遠比 Promise 早 | 描述模組格式與目前執行情境，再判斷順序 |
| Promise.all 等於平行執行所有 JavaScript | 它協調 Promise 結果，不建立 CPU 執行緒 |
| worker pool 會處理自己寫的重迴圈 | 任意 JavaScript 不會自動被丟進 libuv pool |
| 一項失敗後其他工作都停止 | 取消需要額外協議與底層配合，見下一章 |

### 練習一：預測後再執行

把 `order.cjs` 與 `order.mjs` 中 `queueMicrotask` 的註冊移到 `Promise.resolve().then(...)` 之前。哪些輸出位置會改變？修改後單獨執行兩個檔案，再恢復原始版本。

<details>
<summary>參考答案</summary>

這兩個 microtask 的先後會交換。同步段仍先執行；兩種頂層情境對 `nextTick` 的差異仍在。自動驗證固定了原始實驗的預期值，所以完成後要恢復再跑完整檢查。

</details>

### 練習二：選擇改善方向

文章匯出正在進行大量同步字串處理，其他請求開始變慢。把函式改成 `async`、把它包在 `Promise.all`、切小工作並讓出執行機會，哪一種可能改善回應能力？

<details>
<summary>參考答案</summary>

前兩者不會自動移走同步計算。切小工作可以讓其他 callback 有機會執行，但仍要控制每塊成本；重計算也可評估演算法改善或 Worker Threads。最終改善要用實際負載量測。

</details>

### 本章完成檢查

- [ ] 能指出 async 函式第一個 await 前仍同步執行的部分。
- [ ] 能說明本章 CommonJS／ESM 順序差異的前提。
- [ ] 已比較 waiting／cpu 的事件順序與探針延遲。
- [ ] 不把 `await Promise.resolve()` 當作讓出 I/O 的通用方法。
- [ ] 能區分事件迴圈、worker pool 與 Worker Threads。
- [ ] 已通過有限併發測試，知道上限與取消是不同責任。

下一章：[04 — 非同步錯誤、取消與資源生命週期](04-async-errors-and-resource-lifecycle.md)，將處理失敗如何回到呼叫端，以及工作結束後如何清理資源。

---

[上一章：模組與設定](02-modules-packages-and-configuration.md) · [返回課程總覽](README.md) · [本章範例](examples/03/README.md)
