# 09 — 模組

> 一個檔案就是一個模組：有自己的作用域，用 `export` 決定對外公開什麼，用 `import` 取得別人公開的東西。整個程式裡，每個模組只會執行一次。

JavaScript 很長一段時間沒有模組系統，前端靠全域變數和 `<script>` 的順序拼起來，Node 則自己發展了 CommonJS（`require`）。ES2015 加入的 **ES Modules**（ESM）是語言標準，現在瀏覽器和 Node 都支援。這一章以 ESM 為主，最後對照仍然常見的 CommonJS。

## 9.1 `export` 與 `import`

### 具名匯出

```js
// price.js
export const TAX_RATE = 0.05;

export function withTax(cents) {
  return Math.round(cents * (1 + TAX_RATE));
}

function round(n) {} // 沒有 export，模組外看不到
```

```js
// main.js
import { withTax, TAX_RATE } from "./price.js";
import { withTax as addTax } from "./price.js"; // 改名
import * as price from "./price.js";            // 全部放進一個命名空間物件

withTax(1000);       // 1050
price.TAX_RATE;      // 0.05
```

### 預設匯出

```js
// logger.js
export default function log(message) {
  console.log(`[app] ${message}`);
}
```

```js
import log from "./logger.js";      // 預設匯出不用大括號，名稱自己取
import whatever from "./logger.js"; // 取什麼名字都可以
```

### 重新匯出

把幾個模組的內容集中在一個入口：

```js
// utils/index.js
export { withTax, TAX_RATE } from "./price.js";
export * from "./format.js";
export { default as log } from "./logger.js";
```

### 建議用具名匯出

預設匯出讓匯入端可以任意命名，結果同一個東西在不同檔案裡叫不同名字，搜尋和重構都比較困難。具名匯出的名稱是固定的，編輯器也能自動補完與自動 import。

例外是框架要求預設匯出的情況，例如 Vue 的單檔元件、Next.js 的頁面元件。

## 9.2 模組的特性

### 每個模組有自己的作用域

模組最上層的變數不會變成全域變數，其他模組只能透過 `import` 取得 `export` 的東西（[3.6 節](03-scope-closures-and-hoisting.md#36-全域作用域)）。模組自動是嚴格模式，最上層的 `this` 是 `undefined`。

### 每個模組只執行一次

```js
// counter.js
export let count = 0;
export function increment() {
  count += 1;
}
console.log("counter.js evaluated");
```

不管有多少個模組 `import` 了 `counter.js`，`"counter.js evaluated"` 只會印一次，所有匯入端拿到的是**同一個**模組實例。所以模組最上層的狀態，在整個程式裡是共用的單例（singleton）。這很方便（共用一個設定、一個資料庫連線），但也代表測試之間可能互相影響。

### 匯入的是即時繫結，而且唯讀

```js
import { count, increment } from "./counter.js";

console.log(count); // 0
increment();
console.log(count); // 1，看到的是 counter.js 裡最新的值

count = 10; // TypeError: Assignment to constant variable.
```

`import` 拿到的不是值的複本，而是連到原模組變數的**即時繫結**（live binding）：原模組改了，匯入端看到的也跟著變。但匯入端不能直接賦值，要改只能呼叫原模組提供的函式。這讓「誰能修改這份狀態」很清楚：只有模組自己。

### `import` 會被提升

`import` 宣告在模組的任何程式碼執行之前就處理完畢，寫在檔案中間也一樣。習慣上把所有 `import` 放在檔案最上面。

### 最上層 `await`

ES Module 最上層可以直接 `await`：

```js
// config.js
const response = await fetch("/config.json");
export const config = await response.json();
```

匯入 `config.js` 的模組，會等這個 `await` 完成才開始執行。很方便，但要注意它會延後所有依賴它的模組；載入很慢或可能失敗的工作，不要放在被很多模組依賴的檔案最上層。

## 9.3 在瀏覽器使用

```html
<script type="module" src="./main.js"></script>
```

`type="module"` 的 script 和一般 script 不同：

- **自動延後執行**，等 HTML 解析完才執行，效果等同 `defer`，不用把 `<script>` 放在 `<body>` 最後面。
- **一律走 CORS**，所以要透過伺服器開啟，不能用 `file://`（[0.4 節](00-course-map-and-runtime.md#04-範例怎麼執行)）。
- **路徑要寫完整**：`"./price.js"` 要有 `./` 和副檔名，瀏覽器不會自動補。

### 裸模組名稱與 import map

Node 和打包工具允許 `import { ref } from "vue"` 這種寫法（裸模組名稱，bare specifier），它們知道去 `node_modules` 找。瀏覽器不知道 `"vue"` 對應哪個檔案。不使用打包工具時，用 import map 告訴瀏覽器：

```html
<script type="importmap">
  {
    "imports": {
      "vue": "https://cdn.jsdelivr.net/npm/vue@3.5.13/dist/vue.esm-browser.prod.js"
    }
  }
</script>
<script type="module">
  import { createApp, ref } from "vue";
</script>
```

實際專案通常交給 Vite 這類工具處理（[18.2 節](18-from-script-to-project.md#182-用-vite-建立前端專案)），它在開發時把裸模組名稱改寫成瀏覽器看得懂的路徑，打包時再把所有模組合併、壓縮。

## 9.4 動態 `import()`

`import` 宣告是靜態的：寫在最上層、路徑是固定字串。需要在執行時才決定載入什麼、或要延後載入時，用 `import()` 函式，它回傳一個 Promise：

```js
button.addEventListener("click", async () => {
  const { renderChart } = await import("./chart.js");
  renderChart(data);
});
```

`chart.js` 和它依賴的圖表函式庫，要到使用者按下按鈕時才下載。打包工具看到 `import()`，會把那部分程式切成獨立的檔案（code splitting），讓首頁載入更快。前端框架的路由懶載入（`() => import("./pages/Admin.vue")`）用的就是這個機制。

動態載入的模組和靜態載入的是同一個實例，同樣只執行一次。

## 9.5 在 Node 使用

Node 依副檔名和 `package.json` 決定一個檔案是 ESM 還是 CommonJS：

| 檔案 | 模組系統 |
|------|---------|
| `.mjs` | 一律 ESM |
| `.cjs` | 一律 CommonJS |
| `.js` | 看最近的 `package.json`：有 `"type": "module"` 就是 ESM，否則是 CommonJS |

新專案在 `package.json` 加上 `"type": "module"`，`.js` 檔就是 ESM。

```js
import { readFile } from "node:fs/promises"; // 內建模組加上 node: 前綴，一看就知道不是第三方套件
import path from "node:path";

// ESM 沒有 __dirname、__filename，改用 import.meta
const configPath = path.join(import.meta.dirname, "config.json");

// 匯入 JSON 要標註型別
import data from "./data.json" with { type: "json" };
```

`import.meta.dirname` 與 `import.meta.filename` 從 Node 20.11 開始提供。在 Node 的 ESM 裡相對路徑同樣要寫副檔名：`"./price.js"`，不能寫成 `"./price"`。

## 9.6 循環依賴

A 匯入 B、B 又匯入 A，就形成循環依賴。ESM 允許循環，但執行時可能讀到還沒初始化的變數：

```js
// a.js
import { b } from "./b.js";
export const a = "A";
console.log("a.js sees", b);
```

```js
// b.js
import { a } from "./a.js";
export const b = "B";
console.log("b.js sees", a); // ReferenceError: Cannot access 'a' before initialization
```

執行 `a.js` 時，Node 先處理它的依賴 `b.js`；`b.js` 要讀 `a`，但 `a.js` 本身還沒執行到 `export const a` 那一行，`a` 還在 TDZ 中（[3.2 節](03-scope-closures-and-hoisting.md#32-提升與-tdz)）。

如果 `b.js` 只在函式裡讀 `a`，而那個函式要等兩個模組都載入完才被呼叫，就不會出錯，因為那時 `a` 已經初始化了。但這種「剛好沒事」很脆弱，調整一下 import 順序就可能壞掉。

看到 `Cannot access 'X' before initialization`，而 `X` 是匯入的名稱時，先懷疑循環依賴。解法通常是把兩邊共用的部分抽到第三個模組，讓依賴變成單向的。

## 9.7 對照 CommonJS

Node 的舊專案和很多 npm 套件仍然使用 CommonJS：

```js
// price.cjs
const TAX_RATE = 0.05;
function withTax(cents) {
  return Math.round(cents * (1 + TAX_RATE));
}
module.exports = { TAX_RATE, withTax };
```

```js
// main.cjs
const { withTax } = require("./price.cjs");
const fs = require("node:fs");
```

| | ES Modules | CommonJS |
|---|---|---|
| 語法 | `import`／`export` | `require()`／`module.exports` |
| 載入 | 先分析所有依賴，再執行；支援最上層 `await` | `require` 執行到那一行時同步載入 |
| 匯入的值 | 即時繫結 | 當下的值（物件是參考，原始值是複本） |
| `require`、`__dirname` | 沒有，用 `import.meta` | 有 |
| 執行環境 | 瀏覽器與 Node | 只有 Node（和打包工具） |

### 兩邊互相使用

- **ESM 匯入 CommonJS**：可以。`module.exports` 會成為預設匯出；Node 也會盡量分析出具名匯出，所以 `import { add } from "./legacy.cjs"` 通常可以用。
- **CommonJS 匯入 ESM**：Node 22.12 起可以直接 `require()` 一個 ES Module，條件是那個模組（和它的依賴）沒有最上層 `await`。更早的版本只能用動態 `import()`。

新程式碼一律寫 ESM。看到 `require` 時知道它是什麼、知道怎麼跟它互通即可。

## 9.8 本章小結

- 每個檔案是一個模組，有自己的作用域，自動是嚴格模式。
- 優先用具名匯出；預設匯出只在框架要求時使用。
- 每個模組只執行一次，最上層狀態是共用的單例；匯入的是唯讀的即時繫結。
- 瀏覽器用 `<script type="module">`，路徑要寫完整，要透過伺服器開啟；裸模組名稱交給 import map 或打包工具。
- 動態 `import()` 用來延後載入與切分程式碼。
- Node 依副檔名與 `"type": "module"` 判斷模組系統；ESM 裡用 `import.meta.dirname` 取代 `__dirname`。
- `Cannot access 'X' before initialization` 出現在匯入的名稱上時，先檢查循環依賴。

下一章：[10 — 事件迴圈](10-event-loop.md)，進入第二部：只有一條執行緒，怎麼同時等很多件事。

---

[上一章：錯誤處理](08-error-handling.md) · [返回課程總覽](README.md) · [下一章：事件迴圈](10-event-loop.md)
