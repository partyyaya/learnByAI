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

備註（原因）：

- `forEach` 的設計是同步迭代，只負責「把 callback 逐一呼叫出去」，不會收集或等待 callback 回傳的 Promise。
- `await` 只會暫停「當前 async callback」，不會暫停外層函式；所以外層流程通常會先往下跑完。
- 因為沒有把每次 `save(item)` 的 Promise 集中管理，錯誤也容易變成未預期的 unhandled rejection。

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

## 11 手寫 Promise 實作（簡化版 Promises/A+）

### 目標

- 親手做一個 `MyPromise`，理解 Promise 內部的狀態機與鏈式呼叫
- 看清楚 `then` 為什麼一定要回傳「新的」Promise
- 釐清 microtask（用 `queueMicrotask`）的時機

### Step 1：狀態與 `resolve` / `reject`

```js
const PENDING = "pending";
const FULFILLED = "fulfilled";
const REJECTED = "rejected";

class MyPromise {
  constructor(executor) {
    this.state = PENDING;
    this.value = undefined;
    this.reason = undefined;

    // 等狀態確定後要執行的 callback queue
    this.onFulfilledCallbacks = [];
    this.onRejectedCallbacks = [];

    const resolve = (value) => {
      if (this.state !== PENDING) return; // 一旦確定就不再變
      this.state = FULFILLED;
      this.value = value;
      this.onFulfilledCallbacks.forEach((cb) => cb(value));
    };

    const reject = (reason) => {
      if (this.state !== PENDING) return;
      this.state = REJECTED;
      this.reason = reason;
      this.onRejectedCallbacks.forEach((cb) => cb(reason));
    };

    try {
      executor(resolve, reject);
    } catch (err) {
      reject(err);
    }
  }
}
```

### Step 2：`then` 與鏈式串接

重點：

- `then` 要回傳「新的」`MyPromise`，下一個 `then` 才能拿到本次的結果
- 用 `queueMicrotask` 把 callback 排入 microtask，符合規範（保證非同步執行）
- 如果 callback 回傳的是另一個 Promise，要「攤平」它（resolve 它的結果）

```js
class MyPromise {
  // ...省略 constructor

  then(onFulfilled, onRejected) {
    // 沒給 callback 就讓值/錯誤透傳
    const handleFulfilled =
      typeof onFulfilled === "function" ? onFulfilled : (v) => v;
    const handleRejected =
      typeof onRejected === "function"
        ? onRejected
        : (e) => {
            throw e;
          };

    const nextPromise = new MyPromise((resolve, reject) => {
      const runFulfilled = (value) => {
        queueMicrotask(() => {
          try {
            const result = handleFulfilled(value);
            resolvePromise(nextPromise, result, resolve, reject);
          } catch (err) {
            reject(err);
          }
        });
      };

      const runRejected = (reason) => {
        queueMicrotask(() => {
          try {
            const result = handleRejected(reason);
            resolvePromise(nextPromise, result, resolve, reject);
          } catch (err) {
            reject(err);
          }
        });
      };

      if (this.state === FULFILLED) {
        runFulfilled(this.value);
      } else if (this.state === REJECTED) {
        runRejected(this.reason);
      } else {
        // 還在 pending：先存起來，等狀態確定再執行
        this.onFulfilledCallbacks.push(runFulfilled);
        this.onRejectedCallbacks.push(runRejected);
      }
    });

    return nextPromise;
  }

  catch(onRejected) {
    return this.then(undefined, onRejected);
  }

  finally(onFinally) {
    return this.then(
      (value) => MyPromise.resolve(onFinally()).then(() => value),
      (reason) =>
        MyPromise.resolve(onFinally()).then(() => {
          throw reason;
        })
    );
  }
}

// 處理 then callback 的回傳值
function resolvePromise(nextPromise, result, resolve, reject) {
  if (nextPromise === result) {
    // 避免自己 then 自己造成循環
    return reject(new TypeError("Chaining cycle detected"));
  }

  if (result instanceof MyPromise) {
    // 回傳的是 Promise：等它 settle
    result.then(resolve, reject);
    return;
  }

  // 一般值：直接 resolve
  resolve(result);
}
```

### Step 3：常用靜態方法

```js
MyPromise.resolve = function (value) {
  if (value instanceof MyPromise) return value;
  return new MyPromise((resolve) => resolve(value));
};

MyPromise.reject = function (reason) {
  return new MyPromise((_, reject) => reject(reason));
};

MyPromise.all = function (promises) {
  return new MyPromise((resolve, reject) => {
    const results = new Array(promises.length);
    let settledCount = 0;

    if (promises.length === 0) return resolve(results);

    promises.forEach((p, index) => {
      MyPromise.resolve(p).then(
        (value) => {
          results[index] = value;
          settledCount += 1;
          if (settledCount === promises.length) resolve(results);
        },
        (err) => reject(err) // fail fast
      );
    });
  });
};

MyPromise.race = function (promises) {
  return new MyPromise((resolve, reject) => {
    promises.forEach((p) => {
      MyPromise.resolve(p).then(resolve, reject);
    });
  });
};

MyPromise.allSettled = function (promises) {
  return new MyPromise((resolve) => {
    const results = new Array(promises.length);
    let settledCount = 0;

    if (promises.length === 0) return resolve(results);

    promises.forEach((p, index) => {
      MyPromise.resolve(p).then(
        (value) => {
          results[index] = { status: "fulfilled", value };
          settledCount += 1;
          if (settledCount === promises.length) resolve(results);
        },
        (reason) => {
          results[index] = { status: "rejected", reason };
          settledCount += 1;
          if (settledCount === promises.length) resolve(results);
        }
      );
    });
  });
};
```

### Step 4：測試自己的 Promise

```js
new MyPromise((resolve) => {
  setTimeout(() => resolve(1), 300);
})
  .then((v) => {
    console.log("step1:", v); // 1
    return v + 1;
  })
  .then((v) => {
    console.log("step2:", v); // 2
    return new MyPromise((resolve) => setTimeout(() => resolve(v * 10), 200));
  })
  .then((v) => {
    console.log("step3:", v); // 20
    throw new Error("boom");
  })
  .catch((err) => {
    console.error("caught:", err.message); // caught: boom
  })
  .finally(() => {
    console.log("done");
  });
```

### 預期輸出

```text
step1: 1
step2: 2
step3: 20
caught: boom
done
```

### 重點觀念整理

| 觀念 | 在實作中對應的地方 |
|------|------------------|
| 狀態不可變 | `if (this.state !== PENDING) return` |
| `then` 回傳新 Promise | `const nextPromise = new MyPromise(...)` |
| pending 時暫存 callback | `onFulfilledCallbacks` / `onRejectedCallbacks` |
| 鏈式攤平 Promise | `resolvePromise` 內判斷是不是 MyPromise |
| microtask 排程 | `queueMicrotask(...)` |
| `catch` 是語法糖 | `then(undefined, onRejected)` |

---

## 12 手寫 async/await（用 Generator 模擬）

`async/await` 在引擎內部，其實可以視為 **「Generator + 自動 runner」** 的組合：

- `function*` 可以用 `yield` 暫停執行
- 我們自己寫一個 runner，每次拿到 `yield` 出來的 Promise，等它 settle 後再 `next()` 回 generator

這就是 Babel/TypeScript 早期把 `async/await` 編譯到 ES5 時做的事。

### Step 1：認識 `function*` 與 `yield`

#### 為什麼需要 Generator？

一般函式只有「呼叫 → 執行到底 → 回傳一次」這種單向流程：

```js
function normal() {
  console.log("A");
  return 1;
  console.log("B"); // 永遠不會執行
}
```

而 **Generator function（生成器函式）** 不一樣：

- 它可以在中途「**暫停**」，把目前的值丟給呼叫者
- 之後可以從「暫停的那一行」繼續往下跑
- 呼叫者甚至可以「**塞值回去**」當作上次暫停點的結果

這個「可暫停、可恢復、可雙向溝通」的能力，就是用來模擬 `async/await` 的關鍵。

#### `function*` 是什麼？

在 `function` 後面加一個 `*` 就會宣告成 generator function：

```js
function* myGen() {
  // 函式本體
}
```

它跟一般函式最大的差異是：

| 一般 `function` | Generator `function*` |
|----------------|----------------------|
| 呼叫就直接執行 | 呼叫**不會執行函式本體**，只回傳一個 iterator |
| `return` 結束 | 透過 `yield` 多次「暫停並回傳」 |
| 只能回傳一次 | 可以 yield 任意多次 |

```js
function* myGen() {
  console.log("start"); // 你會發現呼叫 myGen() 不會印出這行
  yield 1;
}

const it = myGen();   // 什麼都不印，只拿到 iterator
it.next();            // 這時才會印 "start"，並回傳 { value: 1, done: false }
```

#### `yield` 是什麼？

`yield` 是 generator 專屬的關鍵字，作用是：

1. **把右邊的值丟出去**（成為 `it.next()` 回傳物件的 `value`）
2. **把函式暫停在這一行**
3. 下次 `it.next(x)` 被呼叫時，**`x` 會變成這個 `yield` 表達式的「結果」**，函式從這裡繼續往下跑

可以把它想像成一個「**雙向的門**」：值可以往外送，也可以從外面塞回來。

```js
function* demo() {
  const received = yield "hello"; // 先送出 "hello"，暫停；下次 next(x) 時 received = x
  console.log("received:", received);
}

const it = demo();
console.log(it.next());        // { value: "hello", done: false }
console.log(it.next("world")); // 印出 "received: world"，回傳 { value: undefined, done: true }
```

#### Iterator 三個方法

`function*` 回傳的 iterator 有三個常用方法：

| 方法 | 行為 |
|------|------|
| `it.next(value)` | 從暫停點繼續執行，`value` 變成上次 `yield` 的結果 |
| `it.throw(err)` | 在暫停點「拋出錯誤」，等同於在 `yield` 那行 `throw err`（可被 generator 內的 `try/catch` 接住） |
| `it.return(value)` | 強制結束 generator，回傳 `{ value, done: true }` |

`it.throw` 是 `async/await` 能用 `try/catch` 接住 `await` 錯誤的關鍵——稍後的 runner 會用它把 Promise 的 reject 注入回 generator 內部。

#### 綜合範例

```js
function* gen() {
  const a = yield 1;
  const b = yield 2;
  return a + b;
}

const it = gen();
console.log(it.next());      // { value: 1, done: false }   ← 暫停在 yield 1
console.log(it.next(10));    // a = 10，{ value: 2, done: false }   ← 暫停在 yield 2
console.log(it.next(20));    // b = 20，{ value: 30, done: true }   ← return 30
```

關鍵口訣：**`it.next(x)` 傳進去的 `x`，會成為「上一個 `yield` 表達式的結果」。**

> 有了這個機制，我們就能寫一個 runner：每次 generator `yield` 出 Promise 時，runner 等它 settle，再把結果用 `it.next(value)` 塞回去——這就完美對應 `await` 的行為。

### Step 2：寫一個 `runAsync` runner

```js
function runAsync(generatorFn) {
  return function (...args) {
    const iterator = generatorFn.apply(this, args);

    return new Promise((resolve, reject) => {
      function step(method, payload) {
        let result;
        try {
          result = iterator[method](payload); // next / throw
        } catch (err) {
          return reject(err); // generator 內部拋錯
        }

        const { value, done } = result;
        if (done) return resolve(value); // generator return → async function 的回傳值

        // 把 yield 出來的值統一包成 Promise
        Promise.resolve(value).then(
          (v) => step("next", v),     // 正常結果 → 餵回 generator
          (e) => step("throw", e)     // 失敗 → 在 generator 內部 throw
        );
      }

      step("next", undefined);
    });
  };
}
```

### Step 3：對比原生 async / await

```js
function fakeApi(name, ms, shouldFail = false) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (shouldFail) reject(new Error(`${name} failed`));
      else resolve(name);
    }, ms);
  });
}

// 原生寫法
async function loadNative() {
  const a = await fakeApi("A", 200);
  const b = await fakeApi("B", 200);
  return [a, b];
}

// 用 generator + runAsync 模擬
const loadEmulated = runAsync(function* () {
  const a = yield fakeApi("A", 200);
  const b = yield fakeApi("B", 200);
  return [a, b];
});

loadNative().then((r) => console.log("native:", r));
loadEmulated().then((r) => console.log("emulated:", r));
```

### Step 4：錯誤處理也能對齊

```js
const loadWithError = runAsync(function* () {
  try {
    const a = yield fakeApi("A", 200);
    const b = yield fakeApi("B", 200, true); // 這裡會失敗
    return [a, b];
  } catch (err) {
    // 跟 async function 裡的 try/catch 行為一致
    return `caught: ${err.message}`;
  }
});

loadWithError().then(console.log);
```

### 預期輸出

```text
native: [ 'A', 'B' ]
emulated: [ 'A', 'B' ]
caught: B failed
```

### 對應關係速查

| `async/await` 語法 | Generator 模擬 |
|--------------------|---------------|
| `async function f()` | `runAsync(function* () {...})` |
| `await expr` | `yield expr` |
| `return value` | `return value`（runner 用它 resolve） |
| `throw err` 往外拋 | generator 內未捕捉的 throw → runner reject |
| `try/catch await` | `try/catch yield`（靠 `iterator.throw`） |

### 練習

1. 在 `runAsync` 內加上 log，觀察「`yield` 出一個 Promise → 等它 settle → 再 `next()`」的順序  
2. 改成支援「`yield` 一個陣列」時自動套用 `Promise.all`（像某些舊版 co/koa 框架那樣）  
3. 把第 11 章的 `MyPromise` 接到 `runAsync` 裡，整套都是自己手寫的版本就完成了 

---

## 13 本章小結

- Promise 是非同步流程的核心抽象，重點是狀態與鏈式組合。
- `then` 不是「回呼結束」，而是「回傳新 Promise 供下游串接」。
- `async/await` 讓程式更直覺，但底層仍是 Promise。
- 效能關鍵常在「串行 vs 並行」選擇，而不是語法本身。
- 真實專案最需要的是：**錯誤處理、超時控制、重試策略、可觀測性**。
- 手寫一遍 `MyPromise` 與 `runAsync`，會讓你對狀態機、microtask、generator 三者的關係更扎實。

---
