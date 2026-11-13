# 02 — 函式

> 在 JavaScript 裡，函式是一種值：可以存進變數、放進陣列、當參數傳、當結果回傳。框架和函式庫大量依賴這一點。

這一章整理函式的三種寫法、參數的規則，以及「函式是值」帶來的寫法：高階函式、函式組合、純函數。函式和變數環境的關係（閉包）在[第 3 章](03-scope-closures-and-hoisting.md)，函式裡的 `this` 在[第 5 章](05-this-prototypes-and-classes.md)。

## 2.1 三種寫法

```js
// 1. 函式宣告（function declaration）
function add(a, b) {
  return a + b;
}

// 2. 函式運算式（function expression）
const subtract = function (a, b) {
  return a - b;
};

// 3. 箭頭函式（arrow function）
const multiply = (a, b) => a * b;
```

三者都能呼叫，差別在這幾點：

| | 函式宣告 | 函式運算式 | 箭頭函式 |
|---|---|---|---|
| 宣告前能呼叫 | 可以（整個提升） | 不行 | 不行 |
| 自己的 `this` | 有，由呼叫方式決定 | 有，由呼叫方式決定 | 沒有，沿用外層的 `this` |
| `arguments` 物件 | 有 | 有 | 沒有 |
| 能用 `new` 呼叫 | 可以 | 可以 | 不行 |

```js
console.log(hoisted()); // "declaration ok"
function hoisted() {
  return "declaration ok";
}

notYet(); // ReferenceError: Cannot access 'notYet' before initialization
const notYet = function () {};
```

提升的細節在 [3.2 節](03-scope-closures-and-hoisting.md#32-提升與-tdz)，`this` 的差別在 [5.3 節](05-this-prototypes-and-classes.md#53-箭頭函式沒有自己的-this)。實務上的選擇：

- 模組裡的具名函式用**函式宣告**，讀起來清楚，堆疊追蹤裡也有名字。
- 傳給別人的 callback 用**箭頭函式**，短，而且 `this` 不會跑掉。
- 物件的方法用方法簡寫 `{ save() {...} }`（[4.1 節](04-objects-and-arrays.md#41-物件字面值)），不要用箭頭函式。

### 箭頭函式的簡寫

```js
const square = (x) => x * x;        // 只有一個運算式時，省略大括號會自動回傳
const toObj = (x) => ({ value: x }); // 回傳物件要加小括號
const oops = (x) => { value: x };    // 沒加小括號：大括號被當成函式本體，回傳 undefined
```

`oops` 的 `{ value: x }` 被解析成函式本體，`value:` 是一個標籤（label），所以函式沒有回傳任何東西。

## 2.2 參數

JavaScript 不檢查參數個數。少傳的參數是 `undefined`，多傳的被忽略；也沒有依參數型別區分的多載（overloading），同名函式後宣告的會覆蓋前面的。

### 預設值

```js
function greet(name = "訪客") {
  return `你好，${name}`;
}

greet();          // "你好，訪客"
greet(undefined); // "你好，訪客"
greet(null);      // "你好，null" ← null 不會觸發預設值
greet("");        // "你好，"
```

預設值**只在參數是 `undefined` 時**生效。後端回傳的 `null` 不會被換成預設值。

預設值在**每次呼叫時**重新計算，所以陣列、物件當預設值是安全的，每次呼叫都拿到新的一個：

```js
function addItem(item, list = []) {
  list.push(item);
  return list;
}

addItem(1); // [1]
addItem(2); // [2]，不會累積成 [1, 2]
```

寫過 Python 的人要注意，這和 Python 的預設參數只建立一次不同。

### 其餘參數與展開

```js
function sum(...nums) {
  // nums 是真正的陣列
  return nums.reduce((a, b) => a + b, 0);
}

sum(1, 2, 3); // 6
sum();        // 0

const nums = [5, 1, 9];
Math.max(...nums); // 9，呼叫時把陣列展開成參數
```

舊程式碼會用 `arguments` 取得所有參數。它不是真正的陣列（沒有 `map`、`filter`），箭頭函式裡也沒有，新程式碼一律用 `...rest`。

### 用物件傳選項

參數超過三個，或有好幾個可選參數時，改成傳一個物件，搭配解構與預設值：

```js
function createUser({ name, role = "user", active = true } = {}) {
  return { name, role, active };
}

createUser({ name: "Ann" }); // { name: "Ann", role: "user", active: true }
createUser({ name: "Bob", active: false });
createUser(); // 最後的 = {} 讓不傳參數也不會出錯
```

呼叫端可以只給需要的欄位，順序無關，讀起來也知道每個值的意思。解構語法在 [4.2 節](04-objects-and-arrays.md#42-解構)詳細說明。

## 2.3 回傳值

沒有 `return`，或 `return` 後面沒有值，函式回傳 `undefined`。

JavaScript 會在某些換行處自動補上分號（ASI）。`return` 後面直接換行就是其中一處：

```js
function getConfig() {
  return
    { ok: true }; // 永遠不會執行
}

getConfig(); // undefined
```

`return` 後面被補了分號，變成 `return;`。要回傳的值要和 `return` 寫在同一行。用 Prettier 這類格式化工具（[18.3 節](18-from-script-to-project.md#183-程式碼檢查eslint-與-prettier)）可以避免這種排版。

## 2.4 函式是值

函式可以像其他值一樣存放與傳遞：

```js
const square = (x) => x * x;
const ops = { square, double: (x) => x * 2 };

ops.square(3);           // 9
[1, 2, 3].map(ops.double); // [2, 4, 6]
```

函式也是物件，有自己的屬性：

```js
function f(a, b = 2, ...rest) {}
f.name;   // "f"
f.length; // 1，只算預設值之前的參數
```

把函式當值傳遞時要注意：**傳的是函式本身，不是呼叫結果**。

```js
button.addEventListener("click", handleClick);   // 正確：傳函式
button.addEventListener("click", handleClick()); // 錯誤：傳的是 handleClick 的回傳值
```

### 傳進去的函式會收到幾個參數

`map` 呼叫 callback 時會傳三個參數：元素、索引、整個陣列。直接把現成的函式傳進去時，多出來的參數可能被誤用：

```js
["1", "2", "3"].map(parseInt); // [1, NaN, NaN]
["1", "2", "3"].map(Number);   // [1, 2, 3]
```

`parseInt` 的第二個參數是進位，於是實際呼叫的是 `parseInt("2", 1)`、`parseInt("3", 2)`，都不合法。不確定對方會傳什麼時，包一層箭頭函式明確指定：`.map((s) => parseInt(s, 10))`。

## 2.5 高階函式

接收函式或回傳函式的函式叫**高階函式**。陣列的 `map`、`filter`、`reduce` 是接收函式的例子（[4.4 節](04-objects-and-arrays.md#44-陣列方法)），這裡看回傳函式的例子：

```js
function makeMultiplier(factor) {
  return (x) => x * factor;
}

const triple = makeMultiplier(3);
triple(5); // 15
```

`makeMultiplier(3)` 回傳一個新函式，這個函式記得 `factor` 是 3。這個「記得」就是第 3 章的閉包。

### 函式組合

把幾個小函式串成一條處理流程：

```js
const pipe = (...fns) => (input) => fns.reduce((acc, fn) => fn(acc), input);

const slugify = pipe(
  (s) => s.trim(),
  (s) => s.toLowerCase(),
  (s) => s.replaceAll(/\s+/g, "-"),
);

slugify("  Hello JavaScript World "); // "hello-javascript-world"
```

`pipe` 收到一串函式，回傳一個新函式；新函式把輸入依序交給每個函式處理。每個步驟都能單獨測試、替換或重新排列。

## 2.6 純函數與副作用

**純函數**滿足兩個條件：

1. 相同的輸入永遠得到相同的輸出。
2. 除了回傳值，不改變外界任何東西（沒有副作用）。

```js
// 純函數
function applyDiscount(price, rate) {
  return Math.round(price * (1 - rate));
}

// 不純：讀取外部狀態、改變參數
let globalRate = 0.1;
function applyDiscountToCart(cart) {
  cart.total = cart.total * (1 - globalRate); // 改了傳進來的物件
  return cart;
}
```

副作用包括：修改參數或全域變數、發網路請求、寫檔、操作 DOM、`console.log`、讀取目前時間或亂數。程式不可能沒有副作用，目標是**把副作用集中在邊界**，讓核心邏輯盡量是純函數：

- **好測試**：不用準備 DOM、網路、時間，給輸入、檢查輸出即可。
- **好推理**：讀到 `applyDiscount(price, rate)` 就知道它只依賴這兩個值。
- **框架依賴它**：React 要求元件在相同的 props 和 state 下產生相同的畫面；Redux、Zustand 的 reducer 必須是純函數。

讀取時間是常見的隱藏副作用。把時間當參數傳進來，函式就變成純的：

```js
// 難測試：結果取決於執行當下的時間
function isExpired(token) {
  return token.expiresAt < Date.now();
}
```

```js
// 好測試：呼叫端決定「現在」是什麼時候
function isExpired(token, now = Date.now()) {
  return token.expiresAt < now;
}
```

預設值 `now = Date.now()` 在每次呼叫時計算，正式程式不用傳，測試時傳一個固定值即可。

## 2.7 本章小結

- 函式宣告會整個提升，函式運算式與箭頭函式不會；箭頭函式沒有自己的 `this` 和 `arguments`，也不能 `new`。
- 箭頭函式直接回傳物件要加小括號；`return` 和回傳值要寫在同一行。
- 參數不檢查個數；預設值只在 `undefined` 時生效、每次呼叫重新計算。
- 用 `...rest` 收集參數，用物件傳選項。
- 函式是值：傳函式本身而不是呼叫結果，注意 callback 會收到幾個參數。
- 核心邏輯寫成純函數，副作用集中在邊界。

下一章：[03 — 作用域、閉包與提升](03-scope-closures-and-hoisting.md)，看函式如何「記得」它被建立時的變數。

---

[上一章：值、型別與比較](01-values-types-and-comparison.md) · [返回課程總覽](README.md) · [下一章：作用域、閉包與提升](03-scope-closures-and-hoisting.md)
