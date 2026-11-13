# 03 — 作用域、閉包與提升

> 函式會記住它被**寫在哪裡**時看得到的變數，而不是被**在哪裡呼叫**。這一句話解釋了閉包，也解釋了大部分「變數的值怎麼不對」的問題。

[第 2 章](02-functions.md)的 `makeMultiplier(3)` 回傳一個記得 `factor` 是 3 的函式。這一章說明這是怎麼做到的，以及它帶來的用法和陷阱：私有狀態、`once`、`memoize`、`debounce`，還有迴圈裡的 `var` 和 React 開發常見的「舊值」問題。

## 3.1 詞法作用域

變數在哪裡看得到，由它**寫在程式碼的哪個位置**決定，這叫詞法作用域（lexical scope）。內層看得到外層的變數，外層看不到內層的：

```js
const appName = "shop"; // 模組作用域

function checkout() {
  const total = 100; // 函式作用域

  if (total > 50) {
    const discount = 10; // 區塊作用域
    console.log(appName, total, discount); // 都看得到
  }

  console.log(discount); // ReferenceError: discount is not defined
}
```

找變數時從目前的作用域開始，找不到就往外一層，一直到最外層；全部找不到就丟出 `ReferenceError`。

### 區塊作用域

`let`、`const`、`class` 的作用域是最近的一對大括號：`if`、`for`、`while` 或單獨的 `{}`。內層可以宣告同名變數，遮蔽（shadow）外層的：

```js
const x = "outer";
{
  const x = "inner";
  console.log(x); // "inner"
}
console.log(x); // "outer"
```

### `var` 只認函式

`var` 的作用域是整個函式，大括號擋不住它：

```js
if (true) {
  var leaked = "var 跑出了區塊";
}
console.log(leaked); // "var 跑出了區塊"
```

這是新程式碼不用 `var` 的主要原因之一。

## 3.2 提升與 TDZ

JavaScript 執行一個作用域之前，會先登記裡面所有的宣告，這叫**提升**（hoisting）。不同宣告被提升後的狀態不同：

| 宣告 | 提升後、宣告那一行之前去讀 |
|------|--------------------------|
| `function f() {}` | 可以呼叫，整個函式都已就緒 |
| `var x` | 得到 `undefined` |
| `let x`、`const x`、`class X` | `ReferenceError`（位於 TDZ） |

```js
console.log(hoistedVar); // undefined，不會報錯
var hoistedVar = 1;

console.log(tdz); // ReferenceError: Cannot access 'tdz' before initialization
let tdz = 2;
```

`let`、`const` 其實也被提升了，但從作用域開頭到宣告那一行之間，變數處於**暫時性死區**（Temporal Dead Zone，TDZ），存取就報錯。這比 `var` 默默給 `undefined` 好：錯誤在第一次存取時就出現，而不是帶著 `undefined` 繼續跑。

錯誤訊息的差別也能幫忙判斷問題：

- `x is not defined`：整個作用域鏈都沒有 `x`，通常是拼錯或忘了 import。
- `Cannot access 'x' before initialization`：`x` 存在，但在宣告之前就用了。常見於模組的循環依賴（[9.6 節](09-modules.md#96-循環依賴)）。

## 3.3 閉包

函式建立時，會記住當下所在的作用域。之後不管在哪裡呼叫，它都能存取那些變數，即使外層函式早已執行完畢。函式加上它記住的變數環境，就叫**閉包**（closure）。

```js
function createCounter() {
  let count = 0;
  return {
    increment: () => ++count,
    current: () => count,
  };
}

const c1 = createCounter();
const c2 = createCounter();
c1.increment();
c1.increment();
c2.increment();

c1.current(); // 2
c2.current(); // 1
```

幾個重點：

- `createCounter` 執行完後，`count` 並沒有消失，因為回傳的兩個函式還參考著它。
- 每次呼叫 `createCounter` 都建立一個**新的**作用域，所以 `c1`、`c2` 各有自己的 `count`。
- 外界沒有任何方法直接讀寫 `count`，只能透過 `increment` 和 `current`。這是在 class 有 `#private` 欄位之前，JavaScript 做私有狀態的標準方式。

## 3.4 閉包抓到的是變數，不是值

閉包記住的是**變數本身**。變數之後被改了，閉包讀到的是新值：

```js
function makeLogger() {
  let message = "first";
  const logIt = () => console.log("closure sees:", message);
  message = "second";
  return logIt;
}

makeLogger()(); // "closure sees: second"
```

### 迴圈裡的 `var`

這是閉包最經典的陷阱：

```js
for (var i = 0; i < 3; i++) {
  setTimeout(() => console.log("var", i), 0);
}
// var 3
// var 3
// var 3

for (let j = 0; j < 3; j++) {
  setTimeout(() => console.log("let", j), 0);
}
// let 0
// let 1
// let 2
```

`var i` 在整個函式裡只有一個，三個箭頭函式抓到的是同一個 `i`。等計時器觸發時迴圈早已跑完，`i` 是 3。`let` 在 `for` 迴圈裡有特別規則：**每一輪都建立新的 `j`**，所以每個箭頭函式抓到各自那一輪的值。

### 抓到舊的狀態

反過來的問題也很常見：閉包建立後，外面的變數換成了**新的變數**，閉包卻還抓著舊的。在 React 裡，每次重新渲染都會建立新的 state 變數和新的函式；如果某個 callback 是在早先的渲染裡建立的，它看到的就是那一次的值：

```js
function setupTimer(count) {
  // 這個 count 是呼叫 setupTimer 那一刻的參數
  setInterval(() => console.log("count is", count), 1000);
}

setupTimer(0); // 之後不管外面的計數器變成多少，這裡永遠印 0
```

React 開發時遇到「`useEffect` 裡讀到的 state 永遠是初始值」，原因就在這裡。解法是讓 callback 讀到最新的值（重新建立 callback，或把值放在可變的容器裡，例如 `ref.current`）。

## 3.5 閉包的應用

### `once`：只執行一次

```js
function once(fn) {
  let called = false;
  let result;
  return (...args) => {
    if (!called) {
      called = true;
      result = fn(...args);
    }
    return result;
  };
}

const init = once(() => {
  console.log("init runs");
  return 42;
});
init(); // 印出 "init runs"，回傳 42
init(); // 直接回傳 42
```

### `memoize`：記住計算結果

```js
function memoize(fn) {
  const cache = new Map();
  return (arg) => {
    if (cache.has(arg)) return cache.get(arg);
    const value = fn(arg);
    cache.set(arg, value);
    return value;
  };
}

const fastSquare = memoize((n) => n * n);
fastSquare(9); // 計算
fastSquare(9); // 從快取拿
```

`cache` 活在閉包裡，只有回傳的函式能存取。這個版本只支援一個參數，而且快取永遠不會清；參數種類很多時，快取會一直長大，這是 [17.2 節](17-memory-and-performance.md#172-常見的記憶體洩漏)會談的記憶體洩漏來源之一。

### `debounce` 與 `throttle`

使用者輸入、捲動、調整視窗大小時，事件一秒可能觸發幾十次。兩種常見的節流方式：

```js
// debounce：停下來 wait 毫秒後才執行一次
function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

// throttle：每 interval 毫秒最多執行一次
function throttle(fn, interval) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last >= interval) {
      last = now;
      fn(...args);
    }
  };
}
```

每 100 毫秒呼叫一次、連續 10 次（第 100 到 1000 毫秒），兩者的行為：

```text
throttle 1 @100
throttle 4 @400
throttle 7 @700
throttle 10 @1000
debounce 10 @1300
```

- **debounce**：每次呼叫都把計時器重設，只有最後一次呼叫後安靜了 300 毫秒才執行。適合搜尋框輸入完才查詢、視窗調整完才重算版面。
- **throttle**：固定間隔內最多執行一次。適合捲動時更新進度條、拖曳時更新位置。

`timer` 和 `last` 都存在閉包裡，每個 `debounce(...)` 回傳的函式有自己的一份。

這兩個是最小的版本。函式庫的版本（例如 lodash）還支援在開頭執行（leading）、取消、強制立即執行等選項。

## 3.6 全域作用域

最外層有兩種情況：

- **一般 `<script>`**：最外層的 `var` 和函式宣告會變成全域物件的屬性，不同 `<script>` 之間共用，容易互相覆蓋。
- **ES Module**：最外層就是模組自己的作用域，宣告不會跑到全域，其他模組要透過 `import` 才能用（[第 9 章](09-modules.md)）。

不管在瀏覽器（`window`）、Worker（`self`）還是 Node（`global`），都可以用 `globalThis` 取得全域物件。

新程式碼盡量不要建立全域變數。需要在模組之間共用的東西，用 `export`／`import` 明確傳遞。

## 3.7 閉包與記憶體

閉包讓變數活得比函式執行還久，代價是**只要閉包還在，它參考的變數就不會被回收**：

```js
function attach(button) {
  const hugeData = new Array(1_000_000).fill("x");
  button.addEventListener("click", () => {
    console.log(hugeData.length);
  });
}
```

只要 `button` 還在、監聽器沒移除，`hugeData` 就一直留在記憶體裡。大部分情況這是預期的行為；問題出在監聽器、計時器忘了清，或閉包意外抓住了用不到的大物件。[17.2 節](17-memory-and-performance.md#172-常見的記憶體洩漏)會整理這類問題的找法和清理方式。

## 3.8 本章小結

- 作用域由程式碼的位置決定；`let`、`const` 是區塊作用域，`var` 是函式作用域。
- 函式宣告整個提升；`var` 提升為 `undefined`；`let`、`const` 在宣告前處於 TDZ，存取會報錯。
- 閉包是函式加上它被建立時的變數環境；每次呼叫外層函式都建立新的環境。
- 閉包抓到的是變數，不是當下的值；`for` 迴圈用 `let` 才會每輪一個新變數。
- `once`、`memoize`、`debounce`、`throttle` 都靠閉包保存狀態。
- 閉包會讓它參考的變數一直存活，監聽器與計時器要記得清理。

下一章：[04 — 物件與陣列](04-objects-and-arrays.md)。

---

[上一章：函式](02-functions.md) · [返回課程總覽](README.md) · [下一章：物件與陣列](04-objects-and-arrays.md)
