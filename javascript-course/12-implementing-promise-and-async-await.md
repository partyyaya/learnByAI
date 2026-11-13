# 12 — 手寫 Promise 與 async/await

> `then` 為什麼一定回傳新的 Promise、callback 為什麼一定晚一步執行、`await` 為什麼能被 `try/catch` 接住——自己寫一遍就清楚了。

[第 11 章](11-promise-and-async-await.md)是使用者的角度。這一章換成實作者的角度：先做一個簡化版的 `MyPromise`，看清楚狀態機與鏈式串接；再用 [第 7 章](07-collections-iterators-and-generators.md)的 generator 加上一個 runner，模擬 `async/await`。

本章程式碼都能用 Node 24 執行。12.1 到 12.3 的三段程式依序放進同一個檔案（12.2 的 `then`、`catch`、`finally` 放回 class 裡），再接上 12.4 的測試即可。

## 12.1 狀態與 `resolve`／`reject`

```js
const PENDING = "pending";
const FULFILLED = "fulfilled";
const REJECTED = "rejected";

class MyPromise {
  constructor(executor) {
    this.state = PENDING;
    this.value = undefined;
    this.reason = undefined;

    // 狀態確定前登記的 callback
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

三個重點：

- `if (this.state !== PENDING) return` 讓狀態只能改變一次。executor 裡呼叫兩次 `resolve`，或先 `resolve` 再 `reject`，後面的都會被忽略。
- `resolve`、`reject` 用箭頭函式，`this` 才會指向這個 Promise 實例（`this` 的規則見 [5.1 節](05-this-prototypes-and-classes.md#51-this-由呼叫方式決定)）。executor 拿到它們之後，不管在哪裡呼叫都正確。
- executor 同步丟出錯誤時，用 `try/catch` 轉成 rejected。這就是 `new Promise(() => { throw err })` 不會讓程式當掉、而是得到 rejected Promise 的原因。

## 12.2 `then` 與鏈式串接

`then` 要做到三件事：

- 回傳**新的** `MyPromise`，下一個 `then` 才能拿到這一步的結果。
- 用 `queueMicrotask` 把 callback 排進 microtask，保證 callback 一定在目前的同步程式之後執行，即使 Promise 早就完成了。
- callback 回傳另一個 Promise 時要「攤平」：等它完成，再用它的結果完成下一個 Promise。

```js
class MyPromise {
  // ...省略 constructor

  then(onFulfilled, onRejected) {
    // 沒給 callback 就讓值／錯誤原樣傳下去
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
        }),
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
    // 回傳的是 Promise：等它完成
    result.then(resolve, reject);
    return;
  }

  // 一般值：直接完成
  resolve(result);
}
```

幾個值得停下來看的地方：

- **沒給 callback 時的預設值**決定了錯誤怎麼「跳過」中間的 `then`。成功的預設是 `(v) => v`，把值原樣傳下去；失敗的預設是 `(e) => { throw e }`，把錯誤再丟一次，於是錯誤一路傳到第一個有 `onRejected` 的地方，也就是 `catch`。
- **`catch` 只是 `then(undefined, onRejected)`**，沒有任何特別的機制。
- **callback 裡的 `throw` 被 `try/catch` 接住，轉成下一個 Promise 的 reject**。這是 11.3 節「在 `then` 裡 `throw` 會傳到 `catch`」背後的實作。
- **`finally` 的 callback 不收參數**，執行完後把原本的值或錯誤原封不動傳下去，所以 `finally` 不會改變結果。

## 12.3 靜態方法

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
        (err) => reject(err), // fail fast
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
        },
      );
    });
  });
};
```

對照第 11 章的表格，可以看出各組合器的差別全在「什麼時候呼叫 `resolve`／`reject`」：

- `all` 用 `results[index]` 保證結果順序和輸入一致，用計數器判斷全部完成；任何一個失敗就 `reject`。
- `race` 把同一組 `resolve`、`reject` 交給每一個 Promise，誰先呼叫誰贏；後面的呼叫被 12.1 節的狀態檢查擋掉。這也說明了為什麼 fail fast 不會取消其他工作：`all` 只是不再理會它們。
- `allSettled` 不論成功失敗都記下來，永遠不會 `reject`。

## 12.4 測試自己的 Promise

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

```text
step1: 1
step2: 2
step3: 20
caught: boom
done
```

再確認它和原生 Promise 一樣排在 microtask：

```js
const log = [];
setTimeout(() => log.push("timeout"), 0);
MyPromise.resolve(1).then(() => log.push("my-then"));
Promise.resolve(1).then(() => log.push("native-then"));
log.push("sync");
setTimeout(() => console.log(log.join(" -> ")), 10);
```

```text
sync -> my-then -> native-then -> timeout
```

兩個 `then` 都排在同步程式之後、`setTimeout` 之前，彼此照登記的順序執行。

### 實作和觀念的對照

| 觀念 | 在實作中對應的地方 |
|------|------------------|
| 狀態只能改變一次 | `if (this.state !== PENDING) return` |
| `then` 回傳新 Promise | `const nextPromise = new MyPromise(...)` |
| pending 時暫存 callback | `onFulfilledCallbacks`／`onRejectedCallbacks` |
| 鏈式攤平 Promise | `resolvePromise` 判斷回傳值是不是 MyPromise |
| callback 一定晚一步 | `queueMicrotask(...)` |
| `catch` 是語法糖 | `then(undefined, onRejected)` |

### 和規範的差距

這是教學用的簡化版，和 Promises/A+ 規範與原生 Promise 還差幾件事：

- **只認得自己**。規範要求接受任何有 `then` 方法的物件（thenable），所以原生 Promise 能 `await` 第三方函式庫的 Promise。這裡的 `resolvePromise` 只判斷 `instanceof MyPromise`。
- **executor 的 `resolve` 不會攤平**。原生的 `new Promise((r) => r(otherPromise))` 會等 `otherPromise`；這裡會把 `otherPromise` 本身當成值。
- **沒有 unhandled rejection 的偵測**。原生 Promise 被 reject 卻沒人處理時，瀏覽器和 Node 會發出警告；`MyPromise` 的錯誤會默默消失。

想要完整實作，可以拿 [Promises/A+ 的測試套件](https://github.com/promises-aplus/promises-tests)來跑。

## 12.5 用 generator 模擬 async/await

`async/await` 可以看成 **generator 加上一個自動執行的 runner**：

- generator 可以用 `yield` 暫停，把一個值交給外面。
- runner 拿到 `yield` 出來的 Promise，等它完成後，再用 `next(結果)` 把結果送回 generator，讓它從暫停處繼續。

在瀏覽器普遍支援 `async/await` 之前，Babel 和 TypeScript 把 `async` 函式編譯到舊版 JavaScript 時，做的就是這件事。

### 需要的 generator 能力

第 7 章介紹 generator 時，主要用它產生一串值。這一章用到的是它**雙向溝通**的能力，先複習三個方法：

| 方法 | 行為 |
|------|------|
| `it.next(value)` | 從暫停點繼續執行，`value` 成為上一個 `yield` 運算式的結果 |
| `it.throw(err)` | 在暫停點丟出錯誤，等於在 `yield` 那一行 `throw err`，可以被 generator 裡的 `try/catch` 接住 |
| `it.return(value)` | 強制結束 generator，回傳 `{ value, done: true }` |

```js
function* gen() {
  const a = yield 1;
  const b = yield 2;
  return a + b;
}

const it = gen();
console.log(it.next());   // { value: 1, done: false }  ← 暫停在 yield 1
console.log(it.next(10)); // a = 10，{ value: 2, done: false }  ← 暫停在 yield 2
console.log(it.next(20)); // b = 20，{ value: 30, done: true }  ← return 30
```

要記住的只有一句：**`it.next(x)` 傳進去的 `x`，會成為上一個 `yield` 運算式的結果。** 把 `yield` 換成 `await`、把 `x` 換成 Promise 的結果，就是 `await` 的行為。

### `runAsync` runner

```js
function runAsync(generatorFn) {
  return function (...args) {
    const iterator = generatorFn.apply(this, args);

    return new Promise((resolve, reject) => {
      function step(method, payload) {
        let result;
        try {
          result = iterator[method](payload); // next 或 throw
        } catch (err) {
          return reject(err); // generator 內部丟出、沒有接住的錯誤
        }

        const { value, done } = result;
        if (done) return resolve(value); // generator 的 return 值 → async 函式的回傳值

        // 把 yield 出來的值統一包成 Promise
        Promise.resolve(value).then(
          (v) => step("next", v), // 成功 → 把結果送回 generator
          (e) => step("throw", e), // 失敗 → 在 generator 裡丟出錯誤
        );
      }

      step("next", undefined);
    });
  };
}
```

`runAsync` 接收一個 generator 函式，回傳一個新函式；呼叫新函式會得到 Promise，和呼叫 `async` 函式一樣。

### 對比原生 async/await

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

### 錯誤處理也對得上

```js
const loadWithError = runAsync(function* () {
  try {
    const a = yield fakeApi("A", 200);
    const b = yield fakeApi("B", 200, true); // 這裡會失敗
    return [a, b];
  } catch (err) {
    // 和 async 函式裡的 try/catch 行為一致
    return `caught: ${err.message}`;
  }
});

loadWithError().then(console.log);
```

```text
native: [ 'A', 'B' ]
emulated: [ 'A', 'B' ]
caught: B failed
```

`fakeApi("B", 200, true)` 失敗時，runner 呼叫 `iterator.throw(err)`，錯誤從 `yield` 那一行丟出，被 generator 裡的 `try/catch` 接住。這就是 `await` 失敗時能用 `try/catch` 接住的原因。

### 對應關係

| `async/await` 語法 | generator 模擬 |
|--------------------|---------------|
| `async function f()` | `runAsync(function* () {...})` |
| `await expr` | `yield expr` |
| `return value` | `return value`（runner 用它 resolve） |
| 錯誤往外丟 | generator 內沒接住的 throw → runner reject |
| `try/catch` 包住 `await` | `try/catch` 包住 `yield`（靠 `iterator.throw`） |

## 12.6 本章小結

- Promise 的核心是一台狀態機：狀態只能改變一次，pending 時先把 callback 存起來。
- `then` 回傳新 Promise，callback 的回傳值決定新 Promise 的結果；`throw` 變成 reject，回傳 Promise 會被攤平。
- callback 一律透過 microtask 執行，所以即使 Promise 已完成，`then` 的 callback 也一定晚於目前的同步程式。
- 組合器的差別只在什麼時候呼叫 `resolve`／`reject`；不再理會其他 Promise 不等於取消它們。
- `async/await` 等於 generator 加 runner：`yield` 交出 Promise，runner 用 `next` 送回結果、用 `throw` 送回錯誤。

下一章：[13 — DOM 與事件](13-dom-and-events.md)，從語言本身轉到瀏覽器提供的環境。

---

[上一章：Promise 與 async/await](11-promise-and-async-await.md) · [返回課程總覽](README.md) · [下一章：DOM 與事件](13-dom-and-events.md)
