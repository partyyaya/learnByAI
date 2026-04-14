# Promise、`then`、`async/await` — 非同步流程與原理手作

## 1 先理解：為什麼需要非同步？

JavaScript 在瀏覽器與 Node.js 中大多是**單執行緒**模型。  
如果所有 I/O（像是 API、檔案、資料庫）都用同步方式執行，整個程式會被卡住。

```text
同步流程（阻塞）：
main thread: [task A.....][等待 API.....][task B]

非同步流程（不阻塞）：
main thread: [task A][送出 API][task B][API 回來後再處理結果]
```

這也是 Promise 與 `async/await` 出現的核心背景：  
**把「等待結果」變成可管理、可組合、可讀性高的流程。**

---

## 2 從 Callback 到 Promise

在 Promise 出現前，常見寫法是 callback：

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
- 巢狀深（callback hell）
- 錯誤處理分散
- 流程不容易重用和組合

Promise 的目標就是把非同步結果包成「可鏈式處理的物件」。

---

## 3 Promise 核心原理（一定要懂）

### Promise 三種狀態

| 狀態 | 說明 |
|------|------|
| `pending` | 尚未完成 |
| `fulfilled` | 已成功，帶有 `value` |
| `rejected` | 已失敗，帶有 `reason`（通常是 Error） |

> Promise 一旦從 `pending` 進入 `fulfilled` 或 `rejected`，就不會再改變（immutable settlement）。

### `then` 做了什麼？

- `then(onFulfilled, onRejected)` 會註冊「完成後要做的事」
- `then` **一定回傳一個新的 Promise**
- 你在 `then` 裡 `return` 的值，會成為下一個 `then` 的輸入
- 你在 `then` 裡 `throw` 的錯誤，會往後傳到 `catch`

### 與 Event Loop 的關係

Promise callback（`then/catch/finally`）會放進 **microtask queue**，優先於一般 macrotask（如 `setTimeout`）執行。

```js
console.log("A");
setTimeout(() => console.log("B"), 0);
Promise.resolve().then(() => console.log("C"));
console.log("D");

// 輸出順序：A -> D -> C -> B
```

---

## 4 `then` / `catch` / `finally` 實戰用法

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

正確寫法：

```js
fetchUser(userId)
  .then((user) => {
    return fetchOrders(user.id);
  })
  .then((orders) => {
    console.log(orders);
  });
```

---

## 5 `async/await`：語法糖，但不是新機制

`async/await` 本質上是 Promise 的語法糖，讓流程更像同步程式。

### 關鍵規則

- `async function` 一定回傳 Promise
- `await` 只能在 `async function` 裡使用（或 ES module top-level await）
- `await x` 會先把 `x` 視為 Promise（若不是就包成 `Promise.resolve(x)`）
- 錯誤一樣要用 `try/catch` 或讓它往外拋

### `then` 版 vs `async/await` 版

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

---

## 6 手作 1：自己包一個 `delay()`

### 目標

- 用 Promise 封裝 `setTimeout`
- 理解 `resolve` 什麼時候被呼叫

### 實作

```js
function delay(ms, value) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), ms);
  });
}

delay(1000, "done").then((v) => console.log(v)); // 1 秒後印出 done
```

### 練習

1. 寫一個 `delayReject(ms, error)`，時間到後 `reject(error)`  
2. 用 `try/catch` 捕捉 `await delayReject(...)` 的錯誤

### 參考解答

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

### 預期輸出

```text
（約 0.8 秒後）
caught: network timeout
```

---

## 7 手作 2：串行 vs 並行請求

### 模擬 API

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

### 串行（總時間 = 全部相加）

```js
async function runSerial() {
  const a = await fakeApi("A", 1000);
  const b = await fakeApi("B", 1000);
  const c = await fakeApi("C", 1000);
  return [a, b, c];
}
```

### 並行（總時間約等於最慢那個）

```js
async function runParallel() {
  return Promise.all([
    fakeApi("A", 1000),
    fakeApi("B", 1000),
    fakeApi("C", 1000),
  ]);
}
```

### 參考解答

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

### 預期輸出

```text
A finished
B finished
C finished
serial result: [ 'A', 'B', 'C' ] time=3000ms 左右

A finished
B finished
C finished
parallel result: [ 'A', 'B', 'C' ] time=1000ms 左右
```

### 補充：失敗策略

- `Promise.all`：有一個失敗就整體失敗（fail fast）
- `Promise.allSettled`：全部完成後回傳每個結果（不論成功失敗）
- `Promise.race`：誰先完成（成功或失敗）就採用誰
- `Promise.any`：第一個成功的結果（全失敗才 throw AggregateError）

---

## 8 手作 3：做一個 `retry()`（含退避）

### 目標

當 API 偶發失敗時，自動重試，提升穩定性。

```js
async function retry(taskFn, retries = 3, backoffMs = 300) {
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await taskFn();
    } catch (err) {
      lastError = err;
      if (attempt === retries) break;

      // 簡單線性退避：300ms, 600ms, 900ms...
      await new Promise((r) => setTimeout(r, backoffMs * attempt));
    }
  }

  throw lastError;
}
```

### 測試用不穩定任務

```js
let count = 0;
async function unstableTask() {
  count += 1;
  if (count < 3) throw new Error(`fail at ${count}`);
  return `success at ${count}`;
}

retry(unstableTask, 5, 200)
  .then(console.log)
  .catch((e) => console.error("still failed:", e.message));
```

### 參考解答

```js
let count = 0;
async function unstableTaskWithLog() {
  count += 1;
  console.log(`attempt #${count}`);

  if (count < 3) {
    throw new Error(`fail at ${count}`);
  }
  return `success at ${count}`;
}

(async () => {
  try {
    const result = await retry(unstableTaskWithLog, 5, 200);
    console.log("result:", result);
  } catch (err) {
    console.error("still failed:", err.message);
  }
})();
```

### 預期輸出

```text
attempt #1
attempt #2
attempt #3
result: success at 3
```

> 你會觀察到第 1、2 次失敗之間有退避等待（約 200ms、400ms）。

---

## 9 常見坑與排查

### 1) `forEach` 內用 `await` 沒有效果

```js
// 錯誤觀念：forEach 不會等待 async callback
items.forEach(async (item) => {
  await save(item);
});
```

改用 `for...of` 或 `Promise.all`：

```js
for (const item of items) {
  await save(item); // 串行
}

await Promise.all(items.map((item) => save(item))); // 並行
```

### 2) 忘記處理 rejected Promise

未捕捉的拒絕（Unhandled Rejection）會讓錯誤難追。  
建議每條非同步流程都至少有一層 `catch` 或 `try/catch`。

### 3) 在 `new Promise(...)` 裡包已經是 Promise 的 API

若函式本身已回傳 Promise，通常不需要再手動 `new Promise` 包一層，避免多餘複雜度。

---

## 10 章末練習（建議真的動手）

### 題目 1

寫 `fetchWithTimeout(promise, ms)`：超過時間就 reject timeout error。

<details>
  <summary>參考解答（點我展開）</summary>

```js
function fetchWithTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout after ${ms}ms`));
    }, ms);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

const slowTask = new Promise((resolve) => {
  setTimeout(() => resolve("slow ok"), 1500);
});

fetchWithTimeout(slowTask, 1000)
  .then(console.log)
  .catch((err) => console.error(err.message));
```

```text
timeout after 1000ms
```

</details>

### 題目 2

寫 `mapLimit(items, limit, asyncMapper)`：限制同時最多執行 `limit` 個任務。

<details>
  <summary>參考解答（點我展開）</summary>

```js
async function mapLimit(items, limit, asyncMapper) {
  if (limit <= 0) {
    throw new Error("limit must be greater than 0");
  }

  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;

      if (current >= items.length) return;
      results[current] = await asyncMapper(items[current], current);
    }
  }

  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);

  return results;
}

mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
  await new Promise((r) => setTimeout(r, 300));
  return n * 10;
}).then((res) => console.log(res));
```

```text
[10, 20, 30, 40, 50]
```

</details>

### 題目 3

把一段 `then` 鏈重構成 `async/await`，再比較可讀性與錯誤處理差異。

<details>
  <summary>參考解答（點我展開）</summary>

```js
// then 版
function getDashboardDataThen(userId) {
  return fetchUser(userId)
    .then((user) => fetchOrders(user.id).then((orders) => ({ user, orders })))
    .then(({ user, orders }) => ({ userName: user.name, ordersCount: orders.length }))
    .catch((err) => {
      console.error("then flow failed:", err.message);
      throw err;
    });
}

// async/await 版
async function getDashboardDataAwait(userId) {
  try {
    const user = await fetchUser(userId);
    const orders = await fetchOrders(user.id);
    return { userName: user.name, ordersCount: orders.length };
  } catch (err) {
    console.error("await flow failed:", err.message);
    throw err;
  }
}
```

```text
差異重點：
1) async/await 版的流程更線性，閱讀負擔通常更小。
2) 錯誤集中在一個 try/catch，維護性更高。
3) then 鏈在需要大量平行組合時，仍然很有表達力。
```

</details>

### 題目 4

設計一個流程：先抓 user，再並行抓 orders / profile，最後組裝成單一物件回傳。

<details>
  <summary>參考解答（點我展開）</summary>

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
    level: profile.level,
    ordersCount: orders.length,
    latestOrderId: orders[0]?.id ?? null,
  };
}

buildUserOverview("u-001")
  .then((data) => console.log(data))
  .catch((err) => console.error("build overview failed:", err.message));
```

```text
{
  id: "u-001",
  name: "...",
  email: "...",
  level: "...",
  ordersCount: 3,
  latestOrderId: "ord-1001"
}
```

</details>

---

## 11 本章小結

- Promise 是非同步流程的核心抽象，重點是狀態與鏈式組合。
- `then` 不是「回呼結束」，而是「回傳新 Promise 供下游串接」。
- `async/await` 讓程式更直覺，但底層仍是 Promise。
- 效能關鍵常在「串行 vs 並行」選擇，而不是語法本身。
- 真實專案最需要的是：**錯誤處理、超時控制、重試策略、可觀測性**。

---
