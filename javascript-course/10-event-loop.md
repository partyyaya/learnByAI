# 10 — 事件迴圈

> JavaScript 一次只做一件事，而且一件事一定做完才換下一件。等待交給執行環境，結果回來時排進佇列，由事件迴圈一件一件取出來執行。

寫過 Java、Go 的人習慣用執行緒處理等待：開一條執行緒去等網路，主程式繼續做別的事。JavaScript 的做法完全不同：只有一條執行緒執行你的程式碼，等待交給執行環境（瀏覽器或 Node）在背後進行，完成後把 callback 排進佇列。這一章說明這套機制，它是第 11 到 16 章的共同基礎。

本章的 Node 範例存成 `.mjs` 執行；10.5、10.6 節的範例要在瀏覽器裡觀察。

## 10.1 單執行緒與執行到完成

JavaScript 的程式碼在一條執行緒上執行。一段同步程式碼一旦開始，就會**執行到完成**（run-to-completion），中途不會被其他 JavaScript 程式碼打斷。

這帶來兩個結果：

- **好處**：不需要鎖。一個函式在執行時，不會有另一段程式碼同時修改同一個變數。[11.9 節](11-promise-and-async-await.md#119-限制同時執行的數量)的 `mapLimit` 讓好幾個 worker 共用一個 `nextIndex` 卻不用鎖，靠的就是這一點。
- **壞處**：一段同步程式碼跑太久，其他所有事情都要等，包括處理點擊和更新畫面（10.6 節）。

「不會被打斷」只限於同步程式碼。遇到 `await` 時，函式會暫停、讓出執行緒，其他程式碼就可能在這時候修改共用的狀態。所以非同步程式仍然有競態問題，只是發生的位置一定在 `await` 上（[14.6 節](14-fetch-and-network-requests.md#146-避免競態只讓最新的結果寫回)）。

## 10.2 呼叫堆疊

引擎用**呼叫堆疊**（call stack）記錄目前執行到哪裡：呼叫函式時推入一層，函式回傳時彈出一層。

```js
function a() { b(); }
function b() { c(); }
function c() { throw new Error("boom"); }
a();
```

```text
Error: boom
    at c (file:///.../stack.mjs:3:22)
    at b (file:///.../stack.mjs:2:16)
    at a (file:///.../stack.mjs:1:16)
```

錯誤的 `stack` 就是丟出錯誤那一刻的呼叫堆疊，由內往外列出。無限遞迴會讓堆疊一直長大，最後丟出 `RangeError: Maximum call stack size exceeded`。

**堆疊清空**，代表目前這段同步程式碼執行完了。這是事件迴圈可以取下一件工作的時機。

## 10.3 Task 佇列與事件迴圈

`setTimeout`、網路請求、使用者點擊這類工作完成時，執行環境把對應的 callback 包成一個 **task**，放進 **task 佇列**。事件迴圈不斷重複：

```text
1. 從 task 佇列取出一個 task，執行它（直到呼叫堆疊清空）
2. 執行所有 microtask（10.4 節）
3. 必要時更新畫面（10.5 節，瀏覽器）
4. 回到 1
```

`setTimeout(fn, 0)` 不是「立刻執行」，而是「至少 0 毫秒後，把 `fn` 排進 task 佇列」。前面的同步程式碼還沒跑完，它就得等：

```js
const t0 = Date.now();
setTimeout(() => console.log(`timer(0) fired after ${Date.now() - t0}ms`), 0);
while (Date.now() - t0 < 200) {} // 佔住執行緒 200ms
console.log("busy loop done");
```

```text
busy loop done
timer(0) fired after 200ms
```

`setTimeout` 的時間是**最短延遲**，不是保證的執行時間。瀏覽器對巢狀很深的計時器、背景分頁的計時器還會再拉長間隔。需要精確計時的動畫用 `requestAnimationFrame` 的時間戳記（10.5 節），量測經過時間用 `performance.now()`。

## 10.4 Microtask：Promise 的 callback 插隊

除了 task 佇列，還有一個 **microtask 佇列**。Promise 的 `then`／`catch`／`finally` callback、`await` 之後的程式碼、`queueMicrotask()` 排入的函式，都進 microtask 佇列。

規則是：**每個 task 執行完、呼叫堆疊清空後，會把 microtask 佇列整個清空，才去取下一個 task。**

```js
console.log("A");
setTimeout(() => console.log("B"), 0);
Promise.resolve().then(() => console.log("C"));
console.log("D");
```

```text
A
D
C
B
```

`A`、`D` 是同步程式碼，先執行；同步程式碼跑完後清空 microtask，印出 `C`；最後才輪到 task 佇列裡的 `setTimeout`，印出 `B`。

### microtask 裡加入的 microtask 也會在同一輪執行

```js
setTimeout(() => console.log("timeout 1"), 0);
setTimeout(() => console.log("timeout 2"), 0);
Promise.resolve().then(() => {
  console.log("micro 1");
  Promise.resolve().then(() => console.log("micro 1-1"));
});
Promise.resolve().then(() => console.log("micro 2"));
queueMicrotask(() => console.log("micro 3"));
setTimeout(() => {
  console.log("timeout 3");
  Promise.resolve().then(() => console.log("micro inside timeout 3"));
}, 0);
setTimeout(() => console.log("timeout 4"), 0);
```

```text
micro 1
micro 2
micro 3
micro 1-1
timeout 1
timeout 2
timeout 3
micro inside timeout 3
timeout 4
```

- `micro 1-1` 是在執行 `micro 1` 時才加入的，它排在佇列尾端，但仍然在任何 timeout 之前執行，因為 microtask 佇列要**整個清空**。
- `timeout 3` 裡加入的 microtask，在 `timeout 3` 這個 task 結束後立刻執行，排在 `timeout 4` 之前。

反過來說，microtask 不斷加入新的 microtask，task 佇列和畫面更新就永遠輪不到，頁面會凍結。不要用 microtask 寫無窮的迴圈。

### `await` 之後的程式碼也是 microtask

```js
async function task() {
  console.log("2 task start");
  await null;
  console.log("5 after await");
}

console.log("1 sync start");
task();
Promise.resolve().then(() => console.log("4 then"));
console.log("3 sync end");
```

```text
1 sync start
2 task start
3 sync end
5 after await
4 then
```

- `task()` 被呼叫時，**第一個 `await` 之前的部分是同步執行的**，所以 `2` 緊接在 `1` 後面。
- 遇到 `await`，函式暫停，後續部分排進 microtask 佇列，控制權回到呼叫端，印出 `3`。
- 同步程式碼結束，依序清空 microtask：`await` 的後續比 `then` 先排入，所以 `5` 在 `4` 前面。

實務上不需要背這種順序，也不應該寫出依賴這種順序的程式碼。要記住的是兩條規則：`await` 前同步、`await` 後一定晚於目前的同步程式碼。

## 10.5 渲染時機與 requestAnimationFrame

瀏覽器的事件迴圈還要負責更新畫面。完整一點的流程：

```text
取一個 task 執行 → 清空 microtask → （需要時）渲染：
                                       ├─ 執行 requestAnimationFrame callback
                                       ├─ 計算樣式與版面（layout）
                                       └─ 繪製（paint）
```

由此可以推出幾個實用的結論：

**同一個 task 裡的多次 DOM 修改，畫面只會更新一次。** 渲染發生在 task 和 microtask 之後，所以下面的程式不會先閃一下紅色，使用者只會看到最後的藍色：

```js
box.style.background = "red";
box.style.background = "blue";
```

**JavaScript 執行期間，畫面不會更新。** 想在長時間工作中途顯示進度，只改 DOM 沒有用，要讓出執行緒，讓渲染有機會發生（10.6 節）。

**`requestAnimationFrame(fn)` 在下一次繪製之前執行 `fn`。** 頻率跟著螢幕更新率（60Hz 螢幕約每 16.7ms 一次），分頁在背景時會暫停。callback 會收到一個時間戳記，動畫應該依時間計算位置，而不是假設每一幀間隔固定：

```js
const start = performance.now();
function frame(now) {
  const progress = Math.min((now - start) / 1000, 1); // 1 秒內從 0 到 1
  box.style.transform = `translateX(${progress * 300}px)`;
  if (progress < 1) requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

用 `setTimeout(fn, 16)` 做動畫的問題是，它和瀏覽器的繪製時機沒有對齊：可能一幀裡執行兩次，也可能某一幀沒有執行，畫面看起來會頓。[15.6 節](15-browser-native-apis.md#156-排程rafidle-callback-與-microtask-怎麼選)整理了 rAF、`requestIdleCallback` 與其他排程方式的選擇。

## 10.6 長任務會卡住畫面

執行超過 50ms 的 task 稱為**長任務**（long task）。長任務執行期間，點擊沒有反應、捲動卡住、動畫停住。把下面的頁面存成 HTML，用瀏覽器開啟後按按鈕：

```html
<!doctype html>
<meta charset="utf-8" />
<title>長任務</title>
<style>
  #spinner { width: 40px; height: 40px; background: tomato; animation: spin 1s linear infinite; }
  @keyframes spin { to { rotate: 360deg; } }
</style>
<div id="spinner"></div>
<p id="counter">0</p>
<button id="block">同步跑 3 秒</button>
<button id="async">包成 async 跑 3 秒</button>
<button id="chunk">分段跑 3 秒</button>

<script type="module">
  let count = 0;
  setInterval(() => (document.querySelector("#counter").textContent = ++count), 100);

  function busy(ms) {
    const end = performance.now() + ms;
    while (performance.now() < end) {}
  }

  document.querySelector("#block").onclick = () => busy(3000);

  document.querySelector("#async").onclick = async () => {
    await null;
    busy(3000); // 還是在主執行緒上跑
  };

  const yieldToMain = () =>
    globalThis.scheduler?.yield
      ? scheduler.yield()
      : new Promise((resolve) => setTimeout(resolve, 0));

  document.querySelector("#chunk").onclick = async () => {
    const end = performance.now() + 3000;
    while (performance.now() < end) {
      busy(20);            // 每次只做 20ms
      await yieldToMain(); // 讓出執行緒，讓點擊與渲染有機會執行
    }
  };
</script>
```

觀察到的現象：

- **同步跑**：計數器停住 3 秒，再一次跳好幾個數字。旋轉的方塊在大多數瀏覽器仍會轉，因為 CSS 動畫可以在合成執行緒上進行，不依賴主執行緒；但需要主執行緒的東西（計時器、點擊、JavaScript 驅動的動畫）全部停住。
- **包成 async**：結果和同步一模一樣。`async` 只是把工作延後到 microtask 執行，執行時仍然佔住同一條執行緒。
- **分段跑**：計數器持續更新，按鈕也點得動。總工作量相同，只是每做一小段就讓出執行緒。

### 讓出執行緒

分段處理的關鍵是 `yieldToMain()`：讓目前的工作暫停，排到 task 佇列後面，讓其他 task 和渲染先執行。

- `setTimeout(resolve, 0)` 是傳統做法，各環境都能用，但恢復執行時要排在佇列的最後面。
- `scheduler.yield()` 是專門為此設計的 API，恢復時會優先於其他一般 task，不會被插隊太久。Chrome 129、Firefox 142 起支援，Safari 尚未支援，所以上面的寫法先檢查、再退回 `setTimeout`。

`await null` 或 `await Promise.resolve()` **不算**讓出：它們只排入 microtask，而 microtask 會在渲染和其他 task 之前全部執行完。

處理大量資料時，常見的寫法是以時間為單位分段：

```js
async function processAll(items) {
  let deadline = performance.now() + 50;
  for (const item of items) {
    processItem(item);
    if (performance.now() > deadline) {
      await yieldToMain();
      deadline = performance.now() + 50;
    }
  }
}
```

分段解決的是「畫面卡住」，總時間不會變短，反而因為讓出而稍微變長。計算本身就要好幾秒時，應該把它移到另一條執行緒：[第 16 章](16-web-worker.md)的 Web Worker。

## 10.7 Node 的事件迴圈

Node 的事件迴圈由 libuv 實作，把 task 依來源分成幾個階段（timers、I/O callback、`setImmediate` 等），每個階段之間清空 microtask。概念和瀏覽器相同：一次執行一個 callback，執行到完成，之間清空 microtask。差別在於：

- **沒有渲染步驟**，但一樣有「長任務」的問題：一個請求的處理函式跑了 3 秒的同步計算，這 3 秒內伺服器無法處理任何其他請求。
- **`process.nextTick`** 有自己的佇列，在 CommonJS 裡比 Promise 的 microtask 更早執行；但在 ES Module 的最上層，順序會相反，因為模組本身是在 microtask 裡執行的：

```js
Promise.resolve().then(() => console.log("promise"));
process.nextTick(() => console.log("nextTick"));
// 存成 .mjs：promise、nextTick
// 存成 .cjs：nextTick、promise
```

- **`setImmediate`** 在 I/O 階段之後執行。從主程式同時排入的 `setTimeout(fn, 0)` 和 `setImmediate`，誰先執行並不保證。

新程式碼用 `queueMicrotask` 或 Promise，不要依賴 `nextTick` 與 Promise 的相對順序。Node 的事件迴圈階段、worker pool 與 Worker Threads，在 [Node.js 課程第 03 章](../nodejs-course/03-event-loop-and-concurrency.md)有完整的實驗。

## 10.8 本章小結

- JavaScript 在一條執行緒上執行；同步程式碼執行到完成，不會被打斷，所以共用變數不需要鎖。
- 事件迴圈：取一個 task 執行 → 清空所有 microtask → 瀏覽器必要時渲染 → 重複。
- `setTimeout` 的時間是最短延遲；前面的同步程式碼沒跑完，它就得等。
- Promise callback 與 `await` 的後續是 microtask，一定晚於目前的同步程式碼、早於下一個 task。
- `async` 函式在第一個 `await` 前是同步執行的；`async` 不會讓 CPU 運算變成非同步。
- 同一個 task 裡的多次 DOM 修改只會渲染一次；動畫用 `requestAnimationFrame` 並依時間計算。
- 長任務會卡住點擊與畫面：分段並讓出執行緒（`scheduler.yield()` 或 `setTimeout`），或移到 Worker。

下一章：[11 — Promise 與 async/await](11-promise-and-async-await.md)，把「等待結果」變成可以組合的流程。

---

[上一章：模組](09-modules.md) · [返回課程總覽](README.md) · [下一章：Promise 與 async/await](11-promise-and-async-await.md)
