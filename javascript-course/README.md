# JavaScript 語言核心與執行模型

> 給已經寫過程式的人：不從「什麼是變數」講起，而是把 JavaScript 和你熟悉的語言不一樣的地方講清楚——型別轉換、閉包、`this`、原型、事件迴圈、Promise——再進到瀏覽器提供的環境。讀完這門課，再學 TypeScript、React、Vue 或 Node.js 時，不會被語言本身卡住。

---

## 課程目錄

| 章節 | 檔案 | 主題 |
|------|------|------|
| 00 | [00-course-map-and-runtime.md](./00-course-map-and-runtime.md) | 課程地圖與執行環境 |
| 01 | [01-values-types-and-comparison.md](./01-values-types-and-comparison.md) | 值、型別與比較 |
| 02 | [02-functions.md](./02-functions.md) | 函式 |
| 03 | [03-scope-closures-and-hoisting.md](./03-scope-closures-and-hoisting.md) | 作用域、閉包與提升 |
| 04 | [04-objects-and-arrays.md](./04-objects-and-arrays.md) | 物件與陣列 |
| 05 | [05-this-prototypes-and-classes.md](./05-this-prototypes-and-classes.md) | `this`、原型與類別 |
| 06 | [06-strings-regex-dates-and-intl.md](./06-strings-regex-dates-and-intl.md) | 字串、正規表達式、日期與 Intl |
| 07 | [07-collections-iterators-and-generators.md](./07-collections-iterators-and-generators.md) | Map／Set、Symbol、迭代器與產生器 |
| 08 | [08-error-handling.md](./08-error-handling.md) | 錯誤處理 |
| 09 | [09-modules.md](./09-modules.md) | 模組 |
| 10 | [10-event-loop.md](./10-event-loop.md) | 事件迴圈 |
| 11 | [11-promise-and-async-await.md](./11-promise-and-async-await.md) | Promise 與 async/await |
| 12 | [12-implementing-promise-and-async-await.md](./12-implementing-promise-and-async-await.md) | 手寫 Promise 與 async/await |
| 13 | [13-dom-and-events.md](./13-dom-and-events.md) | DOM 與事件 |
| 14 | [14-fetch-and-network-requests.md](./14-fetch-and-network-requests.md) | fetch 與網路請求 |
| 15 | [15-browser-native-apis.md](./15-browser-native-apis.md) | 瀏覽器原生 API：Observer、排程、儲存與頁面互動 |
| 16 | [16-web-worker.md](./16-web-worker.md) | Web Worker |
| 17 | [17-memory-and-performance.md](./17-memory-and-performance.md) | 記憶體與效能除錯 |
| 18 | [18-from-script-to-project.md](./18-from-script-to-project.md) | 從單檔到專案 |

---

## 學習路線

```text
第一部　語言核心
  00 執行環境 → 01 值與型別 → 02 函式 → 03 作用域與閉包
  → 04 物件與陣列 → 05 this、原型與類別
  → 06 字串與日期 → 07 集合、迭代器與產生器 → 08 錯誤處理 → 09 模組

第二部　非同步與執行模型
  10 事件迴圈 → 11 Promise 與 async/await → 12 手寫 Promise 與 async/await

第三部　瀏覽器中的 JavaScript
  13 DOM 與事件 → 14 fetch 與網路請求 → 15 瀏覽器原生 API → 16 Web Worker

第四部　工程化
  17 記憶體與效能除錯 → 18 從單檔到專案
```

- **第一部**是語言本身，和瀏覽器、Node 都無關。01、03、05 三章是 JavaScript 和其他語言差最多的地方，熟悉其他語言的讀者最容易在這裡踩到坑。06、07 可以先跳過，用到時再回來查。
- **第二部**是整門課的核心：JavaScript 只有一條執行緒，卻能同時等很多件事。10 章的事件迴圈是 11～16 章的共同基礎，不建議跳過。12 章是原理篇，只想會用可以先跳過。
- **第三部**是瀏覽器提供的環境。13 章之後的範例要用瀏覽器開啟。15 章是常用瀏覽器 API 的實戰整理，可以按需要的小節查閱。
- **第四部**把前面的程式從單一檔案帶到真正的專案：怎麼除錯、怎麼量測、怎麼用 npm、Vite、ESLint 和測試組織起來。

## 適合對象

- 寫過 Java、Python、C#、Go 或其他語言，要開始寫前端或 Node.js 的工程師。
- 會用 JavaScript 寫功能，但說不清楚 `this`、閉包、事件迴圈為什麼會那樣運作的人。
- 準備學 TypeScript、React、Vue，想先把語言底子打穩的人。

## 前置知識

- 寫過任何一種程式語言：知道變數、條件、迴圈、函式、陣列是什麼。
- 基本的命令列操作：切換目錄、執行指令。
- 第三部需要知道 HTML 與 CSS 的基本長相；不需要會排版。

## 環境需求

- **Node.js 24**：第一、二部的範例存成 `.mjs` 檔，用 `node 檔名.mjs` 執行。
- **新版瀏覽器**（Chrome、Edge、Firefox、Safari 皆可）：第三部的範例與 DevTools。
- **本機靜態伺服器**：用到 ES Modules 或 Worker 的頁面不能直接開 `file://`，要透過 `npx serve` 或 `python3 -m http.server` 開啟。做法見 [0.4 節](./00-course-map-and-runtime.md#04-範例怎麼執行)。

## 讀完之後

| 方向 | 下一門課 |
|------|----------|
| 加上型別 | [TypeScript](../typescript/README.md) |
| 前端框架 | [React](../react/README.md) 或 [Vue 基礎](../vue/basics/README.md) |
| 伺服器端 | [Node.js 後端與全端服務開發](../nodejs-course/README.md) |
| 即時通訊 | [SSE](../common/sse.md)、[WebSocket](../common/websocket.md) |
| 測試與建置 | [前端測試](../frontend-testing-course/README.md)、[Vite 原理與內核](../vite-course/README.md) |
