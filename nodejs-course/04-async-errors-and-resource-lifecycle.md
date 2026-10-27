# 04 — 非同步錯誤、取消與資源生命週期

> 一項工作結束，要同時回答三件事：呼叫端得到什麼結果、底層工作是否停止、建立的資源是否清掉。

上一章看到 Promise 拒絕後，其他已開始的工作仍可能繼續。本章接著處理錯誤傳播、EventEmitter、逾時與取消，最後把 timer 和 listener 的清理放進測試。

完成本章後，你應能：

- 分辨同步 throw、Promise rejection、callback 錯誤與事件來源錯誤。
- 用 `await`、`return` 或 `.catch()` 保持可追蹤的錯誤路徑。
- 解釋 EventEmitter 為什麼不會自動等待 async listener。
- 區分停止等待、發出取消通知與實際停止工作。
- 在成功、錯誤、逾時與取消時，清理自己建立的資源。
- 驗證失敗路徑，避免測試結束後仍殘留 timer 或 listener。

前置：[03 章](03-event-loop-and-concurrency.md)。本章沿用 Node 24.22.1、TypeScript 與 Jest，示範的是程序內的工作協作，尚未建立 HTTP、資料庫或可靠背景工作佇列。

## 04.1 看似失敗了，工作卻還在跑

假設你等待文章匯出結果，兩秒後顯示「逾時」。這只說明等待方已得到失敗結果，並不能保證：

1. 匯出工作已經停止。
2. 先前安排的 timer 已被取消。
3. 等待結果的 listener 已從來源移除。
4. 已送出的外部請求或資料寫入被撤回。

如果每次逾時都留下 listener，下一次事件可能通知一群早已不需要結果的等待者。若留下很長的 timer，短程式也可能一直無法結束。

因此，失敗處理需要和資源擁有權一起設計，而不是只在畫面上顯示錯誤。

## 04.2 先執行四種結束路徑

從倉庫根目錄執行：

```bash
cd nodejs-course/examples/04
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm start
```

本機路線使用 `.nvmrc` 指定的 Node 與 npm 11.19.1，移除 Docker 前綴即可。後文所有指令都在本章範例目錄執行；Docker 路線在 `node`／`npm` 前加上 `docker compose run --rm tools`。

主程式使用一個新的 EventEmitter 模擬每次訊息來源，依序執行：

| scenario | outcome | 結束後自有 listener 數量 |
|----------|---------|--------------------------|
| `success` | `article-ready` | 0 |
| `source-error` | `source unavailable` | 0 |
| `timeout` | `timeout` | 0 |
| `cancel` | `user cancelled` | 0 |

輸出是上述資料的 JSON 陣列。四個案例都結束後，程序應自行退出；不需要用 `process.exit()` 強制掩蓋殘留資源。

| 檔案 | 責任 |
|------|------|
| [deadline.ts](examples/04/src/deadline.ts) | 建立期限、轉送取消、回報結果並清除期限 timer |
| [wait-for-message.ts](examples/04/src/wait-for-message.ts) | 等待訊息、來源錯誤或取消，移除自己的 listener |
| [main.ts](examples/04/src/main.ts) | 建立示範來源與 producer timer，最後停止來源 |
| [errors.cjs](examples/04/experiments/errors.cjs) | 觀察 await、return、遺漏 Promise 與 callback／事件錯誤 |
| [test/](examples/04/test/deadline.test.ts) | 驗證期限、取消與資源清理 |

`npm run check` 會執行 **18 個 Jest 測試與 7 項程序檢查**，包含預期會失敗的獨立子程序。

## 04.3 try/catch 接得到哪一種錯誤？

先依發生方式分類：

| 錯誤來源 | 常見接法 | 容易漏掉的地方 |
|----------|----------|----------------|
| 目前呼叫中的同步 throw | 包住呼叫的 `try/catch` | 不會因此涵蓋之後才執行的 callback |
| 回傳的 Promise rejection | `await`＋`try/catch`、回傳給上層、或 `.catch()` | 建立後沒有回傳、等待或處理 |
| error-first callback 的 `error` 參數 | 在 callback 內處理，或轉為 Promise rejection | 只檢查呼叫函式當下有沒有 throw |
| EventEmitter 的 `'error'` 事件 | 由來源擁有者與等待者明確訂閱 | 沒有 listener 時可能形成未捕捉例外 |

### async 函式的錯誤會成為 rejection

```js
async function fail() {
  throw new Error('operation failed');
}

try {
  fail();
} catch (error) {
  console.log('這裡接不到該 Promise 的拒絕');
}
```

`fail()` 回傳一個已拒絕的 Promise；外層 `try` 並沒有等待它。若沒有其他處理者，就會產生未處理 rejection。

要在這一層處理，讓 `await` 位於 `try` 內：

```js
try {
  await fail();
} catch (error) {
  // 在此決定回報、轉換錯誤或向上拋出。
}
```

上面的 `await` 範例需放在 async 函式或支援 top-level await 的 ESM 中；可執行版本已收在 `errors.cjs`。

### `return promise` 與 `return await promise` 的局部差異

```js
async function forward() {
  try {
    return fail();
  } catch {
    console.log('local caught');
  }
}

forward().catch(() => console.log('caller caught'));
```

`return fail()` 有把結果交給上層，所以呼叫端仍能處理 rejection；但這一層的 `catch` 不會接到日後的拒絕。若需要在本層捕捉它，使用 `return await fail()`。

重點是錯誤責任在哪一層，不是每個 `return` 都必須加 `await`。但若 `try/finally` 要等工作完成才清理資源，直接回傳 Promise 會讓 `finally` 提早執行，這時也要留意等待的位置。

## 04.4 callback 的錯誤不會穿越時間回到外層 try

以下外層 `catch` 接不到 timer callback 的 throw：

```js
try {
  setTimeout(() => {
    throw new Error('callback failed');
  }, 0);
} catch {
  console.log('local caught');
}
```

安排 timer 的呼叫早已結束，callback 是之後才由事件迴圈執行。若想將這項工作表示成 Promise，要把失敗接到 `reject`，或使用已有的 Promise API。

例如處理 error-first callback 時，概念上應是：

```js
const result = await new Promise((resolve, reject) => {
  legacyOperation((error, value) => {
    if (error) return reject(error);
    resolve(value);
  });
});
```

這是 callback 轉接的示意，`legacyOperation` 並非本章實作。若 callback 內還要執行可能 throw 的解析，也要在那個 callback 內捕捉並 `reject`；外層 Promise constructor 不會自動捕捉未來 callback 的 throw。

能使用 `node:fs/promises`、`node:timers/promises` 等標準 Promise API 時，通常不需要自己重新包裝。

### 親眼看預期失敗

```bash
node --unhandled-rejections=strict experiments/errors.cjs awaited
node --unhandled-rejections=strict experiments/errors.cjs returned
node --unhandled-rejections=strict experiments/errors.cjs detached
node --unhandled-rejections=strict experiments/errors.cjs callback
```

前兩者分別輸出 `local caught` 與 `caller caught`，並正常結束；後兩者預期以非零狀態結束。每條指令獨立執行，錯誤堆疊就是觀察結果。

自動驗證以 `--unhandled-rejections=strict` 固定未處理 rejection 的失敗方式。不要加一個全域處理器把這些錯誤吞掉，讓測試表面變綠；需要修正的是遺失的錯誤路徑。[Node.js 程序錯誤事件](https://nodejs.org/api/process.html#event-unhandledrejection)

## 04.5 EventEmitter：emit 不會自動 await listener

`EventEmitter` 讓程式註冊 listener，之後由來源發出事件。一般 `emit()` 會同步呼叫 listener，但不會收集 async listener 回傳的 Promise。

```js
source.on('message', async () => {
  throw new Error('listener failed');
});

try {
  source.emit('message');
} catch {
  console.log('這裡接不到 async listener 的拒絕');
}
```

async listener 裡的 throw 會變成 rejection，並不是 `emit()` 同步拋出的錯誤。可以用本章實驗確認：

```bash
node --unhandled-rejections=strict experiments/errors.cjs async-listener
```

如果事件處理需要做非同步工作，要明確接住 Promise，例如在 listener 內呼叫 `processMessage(message).catch(reportError)`。`reportError` 本身也必須妥善處理失敗；`void` 只表達不使用回傳值，並不等於處理 rejection。

Node 也提供 `captureRejections` 協助轉送 async listener 的拒絕，但仍需要設計 `'error'` 的處理者，且它不會替你停止來源或清理資源。[EventEmitter 官方文件](https://nodejs.org/api/events.html)

### 特殊的 `'error'` 事件

如果 EventEmitter 發出 `'error'`，卻沒有相應 listener，Node 會拋出錯誤；若未被捕捉，程序就會結束。執行 `errors.cjs emitter` 可以觀察這個情況。

因此，要在觸發來源之前註冊需要的 listener。若來源在同一段同步程式已發出一次事件，之後才開始等待，不會自動補收到過去的事件；EventEmitter 本身也不是可持久保存的訊息佇列。

## 04.6 取消是一個需要配合的協議

`AbortController` 提供控制端，`AbortSignal` 提供給被取消的工作：

```text
控制端 controller.abort(reason)
             │ signal 標記已取消、通知訂閱者
             ▼
工作收到 signal
             │ 主動中止等待、停止後續動作、清理資源
             ▼
呼叫端收到拒絕或其他約定結果
```

`abort()` 不會強制中斷任意 JavaScript，也不會自動撤銷已提交的外部副作用。底層 API 必須支援 signal，或由你自己檢查並實作清理。

例如 Node 的 Promise timer 支援 signal：

```ts
import { setTimeout as delay } from 'node:timers/promises';

const controller = new AbortController();
const pending = delay(1000, 'done', { signal: controller.signal });
const observed = pending.catch((error: unknown) => {
  console.log(error instanceof Error ? error.name : 'unknown');
});
controller.abort(new Error('user cancelled'));
await observed;
```

這個範例的 `await` 應放在 async 函式中。Promise timer 會以 `AbortError` 拒絕；不同 API 對取消錯誤的包裝可能不同，不應假設所有 API 都直接丟出 `signal.reason`。本章自己寫的 helper 則明確約定保留該 reason。[Promise timers 文件](https://nodejs.org/api/timers.html#timers-promises-api)

### 已取消與未來取消，都要處理

只註冊 `'abort'` listener 不夠，因為 signal 可能在工作開始前就已經取消。工作應先檢查 `signal.aborted` 或呼叫 `signal.throwIfAborted()`，再註冊後續需要的 listener。

成功後也要移除取消 listener。`{ once: true }` 只表示事件發生一次後移除；如果工作先成功、事件從未發生，listener 仍需要清理。[AbortController／AbortSignal 文件](https://nodejs.org/api/globals.html#class-abortcontroller)

## 04.7 為什麼只用 Promise.race 還不夠？

常見的逾時寫法是讓工作與 timer 競賽：

```ts
await Promise.race([
  doWork(),
  timeoutPromise,
]);
```

這只是結果競賽的示意。即使 `timeoutPromise` 先拒絕，`doWork()` 仍可能繼續；即使工作先成功，建立 timeout Promise 的 timer 也可能還在。

本章的 [withDeadline](examples/04/src/deadline.ts) 因此處理五件事：

1. 驗證期限，本練習限定為 1–60000 ms 的整數。
2. 先檢查父 signal 是否已取消，再建立自己的 controller。
3. 父取消或期限到達時，通知工作用的 signal，並讓等待方收到拒絕。
4. 將 signal 傳給 `operation`，讓底層有機會配合停止。
5. 不論哪條路徑結束，都清除期限 timer，移除自己註冊的 listener。

使用方式：

```ts
const result = await withDeadline(
  1000,
  signal => waitForMessage(source, signal),
  parentController.signal,
);
```

工作函式在這裡才建立，避免呼叫 helper 前就先啟動一個無法傳入 signal 的工作。內部也會將同步 throw 轉成可傳播的 rejection。

### 這個 helper 的保證與限制

| 情況 | 行為 |
|------|------|
| 工作成功 | 回傳結果，清除自己的期限 timer |
| 工作失敗 | 保留原始錯誤，清理自己的資源 |
| 期限到達 | 以 `TimeoutError` 通知取消，等待方收到拒絕 |
| 父 signal 取消 | 保留取消 reason，通知底層工作 |
| 工作忽略 signal | 等待方仍可結束，但底層工作可能繼續 |
| 工作長時間阻塞 JavaScript | timer 也無法準時執行，期限不是可搶占 CPU 的硬限制 |

這裡的期限是相對等待時間，依事件迴圈能處理 timer 的時機生效。若工作同步阻塞很久，它甚至可能在 timer 得到執行機會前就回傳結果；不能用這個 helper 對 CPU 工作承諾精準的牆鐘截止時間。

測試有一個刻意不理會 signal 的工作：10 ms 時呼叫端逾時，但工作自己的 50 ms timer 仍存在，之後照樣完成。這是要驗證的限制，不應把它誤判成已取消底層工作。

`AbortSignal.timeout()`／`AbortSignal.any()` 也是可用的組合工具。本章手動管理 controller 與 timer，是為了讓期限擁有權、錯誤型別及清理路徑可被直接觀察，而不是要求每個專案都重寫這套 helper。

## 04.8 等待事件：每一條出口都要清理

[waitForMessage](examples/04/src/wait-for-message.ts) 把一次事件等待轉成 Promise，結束路徑有：收到訊息、收到來源錯誤、或收到取消。

| 路徑 | Promise 結果 | 必須移除 |
|------|--------------|----------|
| 收到字串 message | resolve 字串 | 自己的 message、error、abort listener |
| 收到非法 payload | reject TypeError | 同上 |
| 來源發出 error | reject 原始 Error | 同上 |
| signal 取消 | reject signal.reason | 同上 |
| 開始前已取消 | 立即拒絕，不訂閱 | 不建立新 listener |

清理函式如下：

```ts
function cleanup(): void {
  source.off('message', onMessage);
  source.off('error', onError);
  signal.removeEventListener('abort', onAbort);
}
```

必須保留同一個函式參考，才能正確移除。`source.off('message', () => ...)` 建立的是另一個函式，不會移除先前註冊的那個。

也不要為了方便就 `removeAllListeners()`：共享來源可能還有別人的訂閱者。測試會先註冊一個既有 listener，確認 helper 結束後只移除自己的部分。

### 解除等待與停止來源，仍是兩個責任

`waitForMessage` 只擁有自己的訂閱，不擁有整個來源。示範的 producer timer 由 `main.ts` 建立，所以也由 `main.ts` 在 `finally` 清除。

如果真實共享來源在等待取消後仍可能發出 `'error'`，來源擁有者應維持自己的長期錯誤處理，直到來源停止。不能因為這次等待結束，就假設來源不再需要錯誤監聽。

若需求只是等待一次事件，Node 的 `events.once(source, 'message', { signal })` 已提供 Promise 形式及相應清理，通常可優先使用；收到參數後仍需驗證 payload。本章手寫版本是為了逐條看清擁有權與離開路徑。[events.once 文件](https://nodejs.org/api/events.html#eventsonceemitter-name-options)

## 04.9 finally 與資源擁有權

先問「誰建立」，再決定「誰釋放」：

| 資源 | 本章建立者 | 本章清理位置 |
|------|------------|--------------|
| 期限 timer | `withDeadline` | 該函式的 `finally` |
| 父 signal 的轉送 listener | `withDeadline` | 該函式的 `finally` |
| message／error／abort listener | `waitForMessage` | 每條結束路徑的 `cleanup` |
| 模擬資料來源的 timer | `main.ts` | 示範案例的 `finally` |

以 timer 為例，核心結構是：

```ts
const timer = setTimeout(onTimeout, ms);
try {
  return await pendingWork;
} finally {
  clearTimeout(timer);
}
```

這裡的 `await` 讓 `finally` 等結果確定後才執行。不要在 `finally` 任意 `return`，否則可能覆蓋原本的結果或錯誤；清理若可能失敗，也需要定義如何保留主要錯誤。

timer 的 `unref()` 只是讓它不單獨維持程序存活，並不等於取消 timer，也不會清理其他 listener。本章使用 `clearTimeout` 直接釋放自己建立的 timer，不用 `unref` 掩蓋資源管理問題。[Node.js timer 生命週期](https://nodejs.org/api/timers.html#timeoutunref)

同樣地，設 `process.exitCode = 1` 不會替你關閉尚在運作的伺服器或連線；07 章再處理程序層級的關閉順序。用 `process.exit()` 強行退出也不能證明資源已正確清理。

## 04.10 測試清理，而不只是測到錯誤

本章兩類測試各自回答不同問題：

| 驗證方式 | 回答什麼 |
|----------|----------|
| Jest fake timers | 成功、拒絕、取消、期限到達後，自己管理的 timer 還剩多少？ |
| listener 計數與參考比對 | 自己的訂閱是否移除？別人的訂閱是否仍存在？ |
| 重複 20 次逾時 | 是否每次結束都回到沒有自有 listener／timer 的狀態？ |
| 真實 Node 子程序 | 未處理錯誤是否確實失敗？正常示範是否自行結束？ |

Jest fake timers 讓我們主動推進測試中的時間，不需要真的等待很久。它適合測試這裡的 timer 狀態，不能拿來代替上一章真實事件迴圈順序的觀察。[Jest timer mocks 文件](https://jestjs.io/docs/timer-mocks)

例如期限測試會先接好 rejection 的 assertion，再推進時間：

```ts
const work = withDeadline(20, signal => waitForMessage(source, signal));
const assertion = expect(work).rejects.toBeInstanceOf(TimeoutError);
await jest.advanceTimersByTimeAsync(20);
await assertion;
expect(source.eventNames()).toEqual([]);
expect(jest.getTimerCount()).toBe(0);
```

不能只寫 `expect(work).rejects...` 卻忘記 `await` 或回傳它；測試可能在 assertion 完成前就結束。也不能靠測試最後強制清掉所有 timer，便宣稱程式本身已清理；計數檢查應在測試框架的收尾之前執行。

## 04.11 常見錯誤、練習與驗收

| 現象或誤解 | 檢查方向 |
|------------|----------|
| 外面有 try/catch，仍出現未處理 rejection | Promise 是否被 await、return 或 catch？ |
| callback throw 接不到 | 錯誤是否發生在之後的 callback，需要在該處轉接？ |
| emit 回來了，async listener 卻失敗 | emit 不等待 listener 回傳的 Promise |
| `once: true` 應該不會漏 listener | 若事件一直沒發生，仍需要在其他結束路徑移除 |
| race 已逾時，資料卻稍後被寫入 | 只停止等待，底層操作沒有取消或無法撤回 |
| abort 之後重迴圈還在跑 | 同步 CPU 工作不能被這個通知直接搶占 |
| 每次等待完成後 listener 數量增加 | 檢查成功、錯誤、取消是否都走到清理 |
| 程式印完結果卻不結束 | 檢查 timer、連線等仍存活資源；不要先加強制退出 |

### 練習一：找出遺失的 Promise

下面程式能等所有文章儲存完成嗎？

```ts
await articles.forEach(async article => {
  await saveArticle(article);
});
```

<details>
<summary>參考答案</summary>

不能，`forEach` 不會收集 callback 的 Promise。需要逐一執行時用 `for...of`；需要併發時使用 `Promise.all` 或上一章的有限併發工具，並清楚處理拒絕與取消。

</details>

### 練習二：讓清理測試失敗

暫時註解 `waitForMessage` 的 `source.off('message', onMessage)`，再執行 `npm test`。觀察成功、取消與重複逾時測試如何指出殘留 listener，最後恢復該行。

不要提高最大 listener 數量來隱藏警告；那不會移除不需要的訂閱。

### 練習三：逾時後是否可以直接重試？

文章寫入請求在呼叫端逾時，是否就能推論沒有寫入，立即重送一定安全？

<details>
<summary>參考答案</summary>

不能。遠端可能已完成寫入，只是回應尚未到達；本地取消也未必能撤回已完成副作用。重試需要另外考慮冪等與狀態確認，23 章會深化這個問題。

</details>

### 本章完成檢查

- [ ] 能分辨四類錯誤來源，為每一項工作指出誰處理失敗。
- [ ] 能說明 `return promise` 為何可傳給上層，卻不一定進入本層 catch。
- [ ] 知道 emit 不等待 async listener，並在啟動來源前完成訂閱。
- [ ] 能區分停止等待、signal 通知與底層真正停止。
- [ ] 已驗證成功、錯誤、期限與取消後的 listener／timer 清理。
- [ ] 知道共享來源仍由擁有者負責停止與長期錯誤處理。
- [ ] 已恢復練習修改並通過 `npm run check`。

下一章：[05 — 原生 HTTP：請求、回應與輸入邊界](05-native-http-request-response.md)，會把這些執行與錯誤觀念放進真正的原生 HTTP 請求／回應流程。

---

[上一章：事件迴圈與併發](03-event-loop-and-concurrency.md) · [返回課程總覽](README.md) · [本章範例](examples/04/README.md)
