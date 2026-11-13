# 11 — Promise 與 async/await

> Promise 是「一個之後才會有的結果」；`async/await` 只是讓你用同步的寫法去等它。

[第 10 章](10-event-loop.md)看過事件迴圈：JavaScript 只有一條執行緒，等待網路或計時器時不會停下來，而是先往下跑，結果回來再由事件迴圈排進佇列。這一章處理隨之而來的問題：結果要怎麼交回來、多個等待要怎麼串起來或同時進行、失敗了怎麼辦。

本章範例都能直接用 Node 24 執行，存成 `.mjs` 檔再 `node 檔名.mjs` 即可。用到 `fetchUser`、`fetchOrders` 這類函式的片段是示意，重點在流程；需要實際跑的例子都會自己用 `setTimeout` 模擬 API。

## 11.1 為什麼需要非同步

如果所有 I/O（API、檔案、資料庫）都用同步方式執行，等待期間整條執行緒就卡住：

```text
同步流程（阻塞）：
main thread: [task A.....][等待 API.....][task B]

非同步流程（不阻塞）：
main thread: [task A][送出 API][task B][API 回來後再處理結果]
```

非同步讓等待期間的執行緒可以做別的事，代價是「結果什麼時候回來」不再由程式碼的順序決定。Promise 和 `async/await` 要解決的，就是**把「等待結果」變成可管理、可組合的流程**。

## 11.2 從 callback 到 Promise

在 Promise 出現前，非同步結果靠 callback 交回：

```js
getUser(userId, (err, user) => {
  if (err) return handleError(err);
  getOrders(user.id, (err2, orders) => {
    if (err2) return handleError(err2);
    getPayment(orders[0].id, (err3, payment) => {
      if (err3) return handleError(err3);
      console.log("done", payment);
    });
  });
});
```

問題通常是：

- 巢狀越來越深（callback hell）。
- 每一層都要自己處理錯誤，漏掉一層錯誤就消失了。
- 流程不容易重用和組合，例如「三個請求同時發、全部回來再繼續」很難寫。

Promise 把非同步結果包成一個**物件**。物件可以回傳、傳給別的函式、放進陣列，於是流程能夠組合。

## 11.3 Promise 的狀態與 `then`

### 三種狀態

| 狀態 | 說明 |
|------|------|
| `pending` | 尚未完成 |
| `fulfilled` | 已成功，帶有 `value` |
| `rejected` | 已失敗，帶有 `reason`（通常是 Error） |

Promise 一旦從 `pending` 進入 `fulfilled` 或 `rejected`，就不會再改變。後面不管多晚呼叫 `then`，拿到的都是同一個結果。

### `then` 做了什麼

- `then(onFulfilled, onRejected)` 登記「完成後要做的事」。
- `then` **一定回傳一個新的 Promise**。
- 在 `then` 裡 `return` 的值，會成為下一個 `then` 收到的值；如果 return 的是 Promise，下一個 `then` 會等它完成，收到的是它的結果。
- 在 `then` 裡 `throw` 的錯誤，會沿著鏈往後傳，直到遇到 `catch`。

`then` 的 callback 不會立刻執行，而是排進 microtask 佇列；即使 Promise 已經完成，callback 也要等目前的同步程式跑完才輪到。順序規則見 [10.4 節](10-event-loop.md#104-microtaskpromise-的-callback-插隊)。

## 11.4 `then`／`catch`／`finally` 的用法

### 基本鏈式寫法

```js
fetchUser(userId)
  .then((user) => fetchOrders(user.id))
  .then((orders) => orders[0])
  .then((firstOrder) => console.log("first order:", firstOrder))
  .catch((err) => {
    console.error("流程失敗:", err.message);
  })
  .finally(() => {
    console.log("不管成功失敗都會跑到這裡");
  });
```

鏈上任何一步失敗，後面的 `then` 都會跳過，直接進 `catch`。`finally` 不會收到值，也不會改變結果（除非它自己丟錯），適合放關閉 loading、釋放資源這類收尾。

### 常見錯誤：忘記 `return`

```js
// 錯誤示範：第二個 then 收不到 fetchOrders 的結果
fetchUser(userId)
  .then((user) => {
    fetchOrders(user.id); // 少了 return
  })
  .then((orders) => {
    console.log(orders); // undefined
  });
```

少了 `return`，第一個 `then` 回傳 `undefined`，下一步不會等 `fetchOrders`。更糟的是 `fetchOrders` 若失敗，這個錯誤不在鏈上，後面的 `catch` 接不到。正確寫法：

```js
fetchUser(userId)
  .then((user) => {
    return fetchOrders(user.id);
  })
  .then((orders) => {
    console.log(orders);
  });
```

箭頭函式只有一個運算式時可以省略大括號，`(user) => fetchOrders(user.id)` 會自動回傳，比較不容易漏。

## 11.5 `async/await`：語法糖，不是新機制

`async/await` 建立在 Promise 之上，讓流程讀起來像同步程式。

### 關鍵規則

- `async function` 一定回傳 Promise：`return x` 等於回傳 `Promise.resolve(x)`，`throw err` 等於回傳 rejected Promise。
- `await` 只能在 `async function` 裡使用，或在 ES module 的最上層（top-level await）。
- `await x` 會把 `x` 當成 Promise 等待；`x` 不是 Promise 時，等於 `await Promise.resolve(x)`。
- `await` 一個 rejected Promise 會在那一行丟出錯誤，用 `try/catch` 接住，或讓它往外傳。
- 函式在第一個 `await` 之前的部分是同步執行的；遇到 `await` 才讓出執行緒，後續部分排進 microtask。

### `then` 版與 `async/await` 版

```js
// then 版
function loadProfile(userId) {
  return fetchUser(userId)
    .then((user) => fetchOrders(user.id))
    .then((orders) => ({ ordersCount: orders.length }));
}
```

```js
// async/await 版
async function loadProfile(userId) {
  const user = await fetchUser(userId);
  const orders = await fetchOrders(user.id);
  return { ordersCount: orders.length };
}
```

兩個版本的錯誤處理也不同：`then` 版要在鏈尾加 `catch`，`async` 版可以把整段包進一個 `try/catch`，同步錯誤（例如 `user` 是 `undefined` 時讀 `user.id`）和非同步錯誤一起接住。

```js
async function getDashboardData(userId) {
  try {
    const user = await fetchUser(userId);
    const orders = await fetchOrders(user.id);
    return { userName: user.name, ordersCount: orders.length };
  } catch (err) {
    console.error("dashboard failed:", err.message);
    throw err; // 記錄後重新丟出，讓呼叫端決定怎麼處理
  }
}
```

在 `catch` 裡記錄後重新 `throw`，呼叫端才知道失敗了；如果只記錄不丟出，函式會回傳 `undefined`，呼叫端以為成功。

## 11.6 把 callback API 包成 Promise：`delay()`

`setTimeout` 是 callback 形式的 API。把它包成 Promise，之後就能 `await`：

```js
function delay(ms, value) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), ms);
  });
}

delay(1000, "done").then((v) => console.log(v)); // 1 秒後印出 done
```

`new Promise(executor)` 會立刻同步呼叫 executor，並傳入 `resolve`、`reject` 兩個函式。什麼時候呼叫 `resolve`，Promise 就什麼時候完成。失敗的版本呼叫 `reject`：

```js
function delayReject(ms, error) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(error), ms);
  });
}

async function runDelayRejectDemo() {
  try {
    await delayReject(800, new Error("network timeout"));
  } catch (err) {
    console.error("caught:", err.message);
  }
}

runDelayRejectDemo();
```

```text
（約 0.8 秒後）
caught: network timeout
```

Node 本身已經提供 Promise 版的計時器：`import { setTimeout as sleep } from "node:timers/promises"`，`await sleep(1000)`。瀏覽器沒有內建版本，上面的 `delay` 就是常見的寫法。

有時候 `resolve` 要在 executor 外面呼叫，例如收到某個事件時才完成。ES2024 的 `Promise.withResolvers()` 一次回傳 `{ promise, resolve, reject }`，不用把兩個函式從 executor 裡搬出來：

```js
const { promise, resolve } = Promise.withResolvers();
button.addEventListener("click", () => resolve("clicked"), { once: true });
await promise;
```

[第 16 章](16-web-worker.md)會用同樣的技巧，把 Worker 的訊息往返包成 Promise。

## 11.7 串行與並行

先準備一個會花時間的模擬 API：

```js
function fakeApi(name, ms) {
  return new Promise((resolve) => {
    setTimeout(() => {
      console.log(`${name} finished`);
      resolve(name);
    }, ms);
  });
}
```

### 串行：總時間是全部相加

```js
async function runSerial() {
  const a = await fakeApi("A", 1000);
  const b = await fakeApi("B", 1000);
  const c = await fakeApi("C", 1000);
  return [a, b, c];
}
```

每個 `await` 都等前一個完成才發下一個請求。

### 並行：總時間約等於最慢的那個

```js
async function runParallel() {
  return Promise.all([
    fakeApi("A", 1000),
    fakeApi("B", 1000),
    fakeApi("C", 1000),
  ]);
}
```

三個 `fakeApi()` 在建立陣列時就已經呼叫，計時器同時開始；`Promise.all` 只負責等全部完成，並依**傳入的順序**回傳結果，不是完成的順序。

### 量一次

```js
async function compareSerialAndParallel() {
  const serialStart = Date.now();
  const serialResult = await runSerial();
  const serialMs = Date.now() - serialStart;

  const parallelStart = Date.now();
  const parallelResult = await runParallel();
  const parallelMs = Date.now() - parallelStart;

  console.log("serial result:", serialResult, `time=${serialMs}ms`);
  console.log("parallel result:", parallelResult, `time=${parallelMs}ms`);
}

compareSerialAndParallel();
```

```text
A finished
B finished
C finished
A finished
B finished
C finished
serial result: [ 'A', 'B', 'C' ] time=3005ms
parallel result: [ 'A', 'B', 'C' ] time=1001ms
```

毫秒數每次會差幾毫秒，量級是 3 秒對 1 秒。

### 有依賴的部分串行，沒依賴的部分並行

實際流程常常兩者混合：先拿到 user，orders 和 profile 都只需要 `user.id`，彼此不相依，就同時發：

```js
async function buildUserOverview(userId) {
  const user = await fetchUser(userId);

  const [orders, profile] = await Promise.all([
    fetchOrders(user.id),
    fetchProfile(user.id),
  ]);

  return {
    id: user.id,
    name: user.name,
    email: profile.email,
    ordersCount: orders.length,
    latestOrderId: orders[0]?.id ?? null,
  };
}
```

看到一排 `await` 時先問：下一行真的需要上一行的結果嗎？不需要就能並行。

### 四種組合器的失敗策略

| 方法 | 完成條件 | 失敗時 |
|------|----------|--------|
| `Promise.all` | 全部成功 | 有一個失敗就整體失敗（fail fast），其他結果丟掉 |
| `Promise.allSettled` | 全部結束 | 不會失敗；每個結果是 `{ status, value }` 或 `{ status, reason }` |
| `Promise.race` | 第一個結束的（成功或失敗） | 第一個結束的是失敗，就整體失敗 |
| `Promise.any` | 第一個成功的 | 全部失敗才失敗，丟出 `AggregateError` |

fail fast 只代表 `Promise.all` 不再等，**其他還在跑的工作不會被取消**。請求會照樣送出、照樣回來，只是結果沒人收。真正取消請求要靠 `AbortController`，見 [14.5 節](14-fetch-and-network-requests.md#145-取消請求abortcontroller)。

## 11.8 逾時

Promise 本身沒有逾時。用 `setTimeout` 和原本的工作賽跑，誰先結束就採用誰：

```js
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout after ${ms}ms`));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

const slowTask = new Promise((resolve) => {
  setTimeout(() => resolve("slow ok"), 1500);
});

withTimeout(slowTask, 1000)
  .then(console.log)
  .catch((err) => console.error(err.message));
```

```text
timeout after 1000ms
```

兩個細節：

- 原本的工作先完成時要 `clearTimeout`。不清掉的話，計時器還在佇列裡，Node 會等它觸發才結束程式；網頁裡則是留下一個沒用的計時器。
- 逾時只是**不再等它**，`slowTask` 照樣在 1.5 秒後完成。如果包的是網路請求，請求仍在進行。要讓請求本身停下，用 `fetch` 的 `signal` 搭配 `AbortSignal.timeout(ms)`，見 [14.5 節](14-fetch-and-network-requests.md#145-取消請求abortcontroller)。

## 11.9 限制同時執行的數量

`Promise.all(items.map(...))` 會一次發出全部請求。一千筆資料就是一千個同時進行的請求，伺服器可能限流，瀏覽器對同一個主機的連線數也有上限。這時要限制同時進行的數量：

```js
async function mapLimit(items, limit, asyncMapper) {
  if (limit <= 0) {
    throw new Error("limit must be greater than 0");
  }

  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await asyncMapper(items[current], current);
    }
  }

  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);

  return results;
}

const start = Date.now();
const res = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
  await new Promise((r) => setTimeout(r, 300));
  return n * 10;
});
console.log(res, `${Date.now() - start}ms`);
```

```text
[ 10, 20, 30, 40, 50 ] 906ms
```

做法是開 `limit` 個 worker，每個 worker 迴圈領下一筆工作。`nextIndex` 被幾個 worker 共用卻不需要鎖，因為 JavaScript 只有一條執行緒：`const current = nextIndex; nextIndex += 1;` 這兩行之間沒有 `await`，不會被別的 worker 插進來。5 筆、同時 2 筆、每筆 300ms，分三輪跑完，大約 900ms。

結果放在 `results[current]`，所以輸出順序和輸入一致，不受完成先後影響。任一筆失敗時，`Promise.all(workers)` 會失敗，但其他 worker 會繼續把手上那筆跑完。

## 11.10 重試與退避

API 偶發失敗時，自動重試能提高成功率。每次重試前等久一點（退避），避免在對方出問題時一直打：

```js
async function retry(taskFn, retries = 3, backoffMs = 300) {
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await taskFn();
    } catch (err) {
      lastError = err;
      if (attempt === retries) break;

      // 線性退避：300ms, 600ms, 900ms...
      await new Promise((r) => setTimeout(r, backoffMs * attempt));
    }
  }

  throw lastError;
}
```

注意 `return await taskFn()`：這裡的 `await` 不能省。省掉的話，`try` 區塊直接回傳 Promise，失敗發生在函式回傳之後，`catch` 接不到，重試不會發生。

用一個前兩次會失敗的任務測試：

```js
let count = 0;
async function unstableTask() {
  count += 1;
  console.log(`attempt #${count}`);

  if (count < 3) {
    throw new Error(`fail at ${count}`);
  }
  return `success at ${count}`;
}

try {
  const result = await retry(unstableTask, 5, 200);
  console.log("result:", result);
} catch (err) {
  console.error("still failed:", err.message);
}
```

```text
attempt #1
attempt #2
attempt #3
result: success at 3
```

第 1、2 次之間等約 200ms，第 2、3 次之間等約 400ms。

實務上的重試還要考慮：

- **只重試暫時性的失敗**。網路錯誤、503、429 值得重試；400、401、404 重試幾次結果都一樣。
- **非冪等的操作要小心**。「建立訂單」第一次其實成功了、只是回應掉了，重試會建出第二筆。
- 多個客戶端同時失敗、又用同樣的間隔重試，會在同一時間一起打回來。常見做法是指數退避加上隨機抖動（jitter），例如 `backoffMs * 2 ** attempt * (0.5 + Math.random())`。

## 11.11 常見錯誤與排查

### `forEach` 裡用 `await` 不會等

```js
// forEach 不會等待 async callback
items.forEach(async (item) => {
  await save(item);
});
console.log("all saved?"); // 這行會先印，save 還沒完成
```

原因：

- `forEach` 是同步迭代，只負責把 callback 逐一呼叫出去，不收集、也不等待 callback 回傳的 Promise。
- `await` 只暫停「當前這個 async callback」，不會暫停外層函式。
- 每次 `save(item)` 的 Promise 沒人接，失敗時會變成未處理的 rejection。

`map`、`filter`、`reduce` 也一樣不會等。改用 `for...of`（串行）或 `Promise.all`（並行）：

```js
for (const item of items) {
  await save(item); // 串行
}

await Promise.all(items.map((item) => save(item))); // 並行
```

### 忘記處理 rejected Promise

沒有人接的 rejection 叫 unhandled rejection。瀏覽器會在 Console 印出 `Uncaught (in promise)`，並觸發 `window` 的 `unhandledrejection` 事件；Node 15 起預設會**直接結束程式**。每條非同步流程最後都要有一層 `catch` 或 `try/catch`，或者把 Promise 回傳給會處理的呼叫端。

只呼叫 async 函式、不 `await` 也不接 `catch`（「fire and forget」），是最常見的來源：

```js
async function onSubmit() {
  saveDraft();         // 沒有 await：失敗沒人知道
  await submitForm();
}
```

確定不需要等結果時，至少接一個 `catch`：`saveDraft().catch(reportError)`。

### 把已經回傳 Promise 的 API 再包一層 `new Promise`

```js
// 多此一舉，而且 fetch 失敗時這個 Promise 永遠不會完成
function getJson(url) {
  return new Promise((resolve) => {
    fetch(url).then((res) => resolve(res.json()));
  });
}
```

```js
// 直接回傳
function getJson(url) {
  return fetch(url).then((res) => res.json());
}
```

`new Promise` 只用在包裝 callback 形式的 API（像 `setTimeout`、舊式的事件介面）。函式本身已經回傳 Promise 時，直接 return 或 `await` 它。

## 11.12 本章小結

- Promise 是非同步結果的物件化：三種狀態，完成後不再改變。
- `then` 不是「callback 結束」，而是回傳一個新 Promise 供下游串接；鏈上要記得 `return`。
- `async/await` 讓流程更直覺，底層仍是 Promise；錯誤用 `try/catch` 接，記錄後要重新丟出。
- 效能關鍵常在「串行還是並行」，而不是語法本身。
- `Promise.all` 的 fail fast 不會取消其他工作；逾時只是不再等，也不會停下原本的工作。
- 實務流程需要的是：錯誤處理、逾時控制、並行上限、重試策略。

下一章：[12 — 手寫 Promise 與 async/await](12-implementing-promise-and-async-await.md)，親手實作一個簡化版 Promise，再用 generator 模擬 `async/await`。

---

[上一章：事件迴圈](10-event-loop.md) · [返回課程總覽](README.md) · [下一章：手寫 Promise 與 async/await](12-implementing-promise-and-async-await.md)
