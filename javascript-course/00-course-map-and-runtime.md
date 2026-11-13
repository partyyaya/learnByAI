# 00 — 課程地圖與執行環境

> JavaScript 這門語言本身很小。你每天用到的 `document`、`fetch`、`setTimeout`、`fs`，都是執行環境提供的。

這一章先釐清兩件事：哪些東西屬於語言、哪些屬於執行環境；以及本課的範例要怎麼執行。最後列出寫過其他語言的人最需要調整的幾個預期，後面各章會逐一展開。

## 0.1 這門課怎麼走

| 部分 | 章節 | 回答的問題 |
|------|------|-----------|
| 語言核心 | 01～09 | 值和型別怎麼運作？函式、閉包、`this`、原型是什麼？程式碼怎麼拆成模組？ |
| 非同步與執行模型 | 10～12 | 只有一條執行緒，怎麼同時等很多件事？Promise 和 `async/await` 怎麼用、怎麼實作？ |
| 瀏覽器中的 JavaScript | 13～16 | 怎麼操作畫面、處理使用者輸入、發網路請求？怎麼用瀏覽器提供的 API？計算很重時怎麼不卡畫面？ |
| 工程化 | 17～18 | 記憶體一直漲、畫面卡頓怎麼查？單一檔案怎麼變成有套件、有檢查、有測試的專案？ |

## 0.2 語言與執行環境

JavaScript 的語言規格叫 **ECMAScript**，由 TC39 委員會維護，每年發布一版（ES2015、ES2016……ES2025）。規格只定義語言本身：語法、型別、運算子、`Object`、`Array`、`Promise`、`Map` 這些內建物件。

規格**沒有**定義怎麼讀檔、怎麼發網路請求、怎麼操作畫面，甚至沒有定義 `setTimeout` 和 `console.log`。這些由**執行環境**（host）提供：

| 來源 | 例子 | 文件 |
|------|------|------|
| 語言（ECMAScript） | `let`、`class`、`Array.prototype.map`、`Promise`、`JSON`、`Math` | MDN 的 JavaScript 參考 |
| 瀏覽器 | `document`、`window`、`fetch`、`localStorage`、`addEventListener` | MDN 的 Web API |
| Node.js | `fs`、`process`、`http`、`Buffer` | Node.js 官方文件 |
| 兩邊都有 | `setTimeout`、`console`、`fetch`、`URL`、`structuredClone`、`AbortController` | 兩邊各自實作，行為大致相同 |

執行 JavaScript 的程式叫**引擎**：Chrome、Edge 和 Node.js 用 V8，Firefox 用 SpiderMonkey，Safari 用 JavaScriptCore。引擎負責語言本身；瀏覽器或 Node 在引擎外面包一層，提供上表的 API 和事件迴圈。

分清楚這兩層有實際用處：

- **查文件時知道去哪查**。`Array.prototype.at` 是語言，在 Node 和瀏覽器都能用；`document.querySelector` 是瀏覽器 API，在 Node 裡不存在。
- **看懂錯誤**。在 Node 執行瀏覽器程式，得到 `ReferenceError: document is not defined`，不是語法錯，而是這個環境沒提供 `document`。
- **判斷功能能不能用**。語言新功能看引擎版本；Web API 看瀏覽器的支援表。MDN 每個頁面底部都有相容性表，標示 **Baseline** 的功能代表主流瀏覽器都已支援。

## 0.3 寫過其他語言的人要先調整的預期

| 你可能預期 | JavaScript 實際上 | 章節 |
|-----------|------------------|------|
| 型別不合會報錯 | 很多運算會自動轉換型別：`"5" - 1` 是 `4`，`"5" + 1` 是 `"51"` | 01 |
| 有整數和浮點數 | 只有一種 `number`（64 位元浮點數），另外有 `bigint` | 01 |
| `==` 比較值 | `==` 會先轉型再比較；日常一律用 `===` | 01 |
| 變數活在大括號裡 | `let`、`const` 是區塊作用域，`var` 不是 | 03 |
| 函式就是函式 | 函式是值，可以傳遞、回傳，還會記住建立時的變數（閉包） | 02、03 |
| `this` 指向所屬物件 | `this` 由**呼叫方式**決定，同一個方法換個呼叫方式 `this` 就變了 | 05 |
| 類別是物件的藍圖 | `class` 是原型機制的語法糖；物件之間直接繼承 | 05 |
| 等待時用執行緒 | 只有一條執行緒，等待交給事件迴圈，用 Promise 接結果 | 10、11 |

## 0.4 範例怎麼執行

### Node.js

本課以 **Node 24** 驗證範例。確認版本：

```bash
node -v
# v24.x.x
```

第一、二部的範例存成 `.mjs` 檔再執行：

```bash
node example.mjs
```

用 `.mjs` 而不是 `.js`，是讓 Node 把檔案當成 **ES Module**。這樣可以直接用 `import`／`export` 和最上層的 `await`，而且自動進入嚴格模式（0.5 節）。在專案裡也可以在 `package.json` 設定 `"type": "module"`，讓 `.js` 檔也當成 ES Module（[9.5 節](09-modules.md#95-在-node-使用)）。

想快速試一行程式，直接輸入 `node` 進入 REPL，每輸入一行就執行並印出結果，`.exit` 離開。

### 瀏覽器 DevTools

任何網頁按 F12（macOS 是 Cmd+Option+I）打開 DevTools，切到 Console 分頁就能輸入 JavaScript。Console 也支援最上層 `await`。

Console 印出物件時，展開的內容是**展開當下**的值，不是印出當時的值。物件之後被修改，展開後會看到新的內容。要確定印出當時的狀態，用 `console.log(JSON.stringify(obj))` 或 `console.log(structuredClone(obj))`。

### HTML 頁面

第三部的範例是 HTML 檔。只有一般 `<script>` 的頁面可以直接雙擊開啟；用到下面任何一項，就要透過本機伺服器開：

- `<script type="module">` 或 `import`
- `new Worker(...)`
- `fetch` 本機的 JSON 檔

原因是瀏覽器把 `file://` 開啟的頁面視為沒有來源（origin），這幾種載入方式都要求同源或 CORS，會被擋下。在範例所在的目錄執行其中一個指令：

```bash
npx serve .                 # Node 提供；第一次執行會詢問是否下載 serve
python3 -m http.server 8000 # macOS 與多數 Linux 內建
```

再用瀏覽器開 `http://localhost:3000`（serve）或 `http://localhost:8000`（Python）。

最小的模組頁面長這樣：

```html
<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="utf-8" />
    <title>範例</title>
  </head>
  <body>
    <p id="out"></p>
    <script type="module">
      document.getElementById("out").textContent = `現在是 ${new Date().toLocaleString()}`;
    </script>
  </body>
</html>
```

## 0.5 嚴格模式

JavaScript 早期有一些設計會讓錯誤安靜地通過，例如對沒有宣告的變數賦值會自動建立全域變數。ES5 加入**嚴格模式**（strict mode）修正這些行為：

```js
"use strict";
total = 10; // ReferenceError: total is not defined
```

ES Module 和 `class` 的內容**自動就是嚴格模式**，不用寫 `"use strict"`。本課所有範例都是 ES Module，所以都在嚴格模式下執行。嚴格模式和寬鬆模式行為不同的地方，本課只在有影響時提到，最常見的兩個是：

- 對未宣告的變數賦值會丟出 `ReferenceError`。
- 一般函式直接呼叫時，`this` 是 `undefined` 而不是全域物件（[5.1 節](05-this-prototypes-and-classes.md#51-this-由呼叫方式決定)）。

網路上的舊範例、舊專案可能是寬鬆模式，行為和本課不同時，先檢查是不是這個原因。

## 0.6 查文件與確認支援度

- **MDN Web Docs**（developer.mozilla.org）：語言和 Web API 的主要參考，有繁體中文介面，但最新、最完整的是英文版。
- **Node.js 文件**（nodejs.org/docs）：`fs`、`process` 等 Node 專屬 API。
- **ECMAScript 規格**（tc39.es/ecma262）：語言行為的最終依據。平常不需要讀，遇到「到底該印什麼」的爭議時才查。
- **相容性**：MDN 頁面底部的相容性表，或 caniuse.com。標示 Baseline 的功能代表主流瀏覽器都已支援。

本課提到比較新的功能時，會註明需要的版本。

## 0.7 本章小結

- ECMAScript 定義語言本身；DOM、`fetch`、`fs`、`setTimeout` 由執行環境提供。
- 引擎執行語言，瀏覽器或 Node 提供 API 與事件迴圈。
- 範例用 `.mjs` 檔在 Node 24 執行；瀏覽器範例用到模組或 Worker 時要透過本機伺服器開啟。
- ES Module 自動是嚴格模式，本課的範例都以嚴格模式為前提。

下一章：[01 — 值、型別與比較](01-values-types-and-comparison.md)，從 JavaScript 和其他語言差最多的地方開始。

---

[返回課程總覽](README.md) · [下一章：值、型別與比較](01-values-types-and-comparison.md)
