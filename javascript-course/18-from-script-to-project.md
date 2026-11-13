# 18 — 從單檔到專案

> 單一檔案適合學習和實驗；真正的專案需要管理套件、有開發伺服器與建置流程、有工具自動抓出錯誤、有測試保護修改。這一章把這幾件事各用最少的設定接起來。

前面的範例都是一個 `.mjs` 或一個 HTML 檔。這一章用 npm、Vite、ESLint、Prettier 和測試，把程式組織成一個可以多人協作、可以部署的專案。每一項都只帶到能用的程度，深入的內容由後續課程接手。

本章的指令以 Node 24 與 2026 年下半年的套件版本驗證：Vite 8、ESLint 10、Vitest 5、Prettier 3。

## 18.1 npm 與 package.json

npm 隨 Node 一起安裝，負責下載套件與執行指令。每個專案的根目錄有一個 `package.json`：

```json
{
  "name": "todo-app",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "node --test",
    "lint": "eslint ."
  },
  "dependencies": {
    "date-fns": "^4.1.0"
  },
  "devDependencies": {
    "eslint": "^10.14.0",
    "vite": "^8.3.6"
  }
}
```

| 欄位 | 用途 |
|------|------|
| `"type": "module"` | `.js` 檔當成 ES Module（[9.5 節](09-modules.md#95-在-node-使用)） |
| `scripts` | 專案的常用指令，用 `npm run 名稱` 執行；`test`、`start` 可以省略 `run` |
| `dependencies` | 程式執行時需要的套件 |
| `devDependencies` | 只在開發、建置、測試時需要的工具 |
| `"private": true` | 防止不小心把專案發布到 npm |

常用指令：

```bash
npm install                # 依 package.json 安裝所有套件
npm install date-fns       # 安裝套件並加到 dependencies
npm install -D vitest      # 加到 devDependencies
npm run dev                # 執行 scripts 裡的 dev
npx eslint .               # 執行專案裡安裝的工具（或臨時下載執行）
```

### 版本範圍與 lock 檔

`"^4.1.0"` 表示「4.x.x 中、不低於 4.1.0 的最新版」：允許次版號與修訂號更新，不允許主版號更新。依照語意化版本（semver）的約定，主版號變動才代表不相容的修改。

範圍允許變動，所以不同時間安裝可能拿到不同版本。`npm install` 會產生 `package-lock.json`，記錄實際安裝的每一個套件的確切版本：

- **`package-lock.json` 要提交到版本控制**，所有人和部署環境才會裝到相同的版本。
- CI 和部署時用 **`npm ci`**：完全依 lock 檔安裝，lock 檔和 `package.json` 不一致時直接失敗，不會悄悄更新。
- `node_modules` 不提交，加進 `.gitignore`。

### 選套件之前

每個依賴都是你要一起維護的程式碼，也是潛在的安全風險。安裝前先問：瀏覽器或 Node 是否已經內建（`fetch`、`structuredClone`、`Intl`、`URLSearchParams`、`node:test`）？這個套件是否還有人維護？它會帶進多少間接依賴？

## 18.2 用 Vite 建立前端專案

```bash
npm create vite@latest my-app -- --template vanilla
cd my-app
npm install
npm run dev
```

`--template vanilla` 是不使用框架的純 JavaScript 範本；也有 `vue`、`react`、`svelte` 等範本。產生的結構：

```text
my-app/
├─ index.html       ← 入口：用 <script type="module" src="/src/main.js"> 載入程式
├─ package.json
├─ public/          ← 原樣複製到輸出目錄的靜態檔案
└─ src/
   ├─ main.js
   ├─ counter.js
   └─ style.css
```

三個指令：

| 指令 | 作用 |
|------|------|
| `npm run dev` | 啟動開發伺服器（預設 `http://localhost:5173`），修改檔案後瀏覽器立即更新 |
| `npm run build` | 打包、壓縮成可部署的靜態檔案，輸出到 `dist/` |
| `npm run preview` | 在本機用正式版的建置結果啟動伺服器，部署前檢查 |

Vite 替你處理了前面幾章需要手動處理的事：

- **本機伺服器**：不用再自己開 `python3 -m http.server`（[0.4 節](00-course-map-and-runtime.md#04-範例怎麼執行)）。
- **裸模組名稱**：可以直接 `import { format } from "date-fns"`，不需要 import map（[9.3 節](09-modules.md#93-在瀏覽器使用)）。
- **CSS 與資源**：可以 `import "./style.css"`、`import logoUrl from "./logo.svg"`。
- **Worker**：`new Worker(new URL("./x.worker.js", import.meta.url), { type: "module" })` 會被正確打包（[16.6 節](16-web-worker.md#166-在-vue-3--vite-中使用)）。
- **建置**：合併模組、移除用不到的程式碼、依動態 `import()` 切分檔案（[9.4 節](09-modules.md#94-動態-import)）。

### 環境變數與 API 代理

```bash
# .env.development
VITE_API_URL=http://localhost:3000
```

```js
const api = createApiClient(import.meta.env.VITE_API_URL);
```

只有 `VITE_` 開頭的變數會被放進前端程式，而且**會原樣出現在打包後的檔案裡**，任何人都看得到。API 金鑰、資料庫密碼這類秘密不能放在前端的環境變數裡。

開發時前端（5173）和 API（3000）埠號不同，會遇到 CORS（[14.8 節](14-fetch-and-network-requests.md#148-跨來源請求cors)）。可以讓 Vite 代理 API 請求：

```js
// vite.config.js
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
```

前端改成請求 `/api/...`（同源），由 Vite 轉送到 3000 埠。這只在開發伺服器有效；正式環境要由伺服器或反向代理處理。

Vite 的內部原理（為什麼開發時不用打包、HMR 怎麼運作、建置時做了什麼）在 [Vite 原理與內核課程](../vite-course/README.md)。

## 18.3 程式碼檢查：ESLint 與 Prettier

### ESLint：抓出可能的錯誤

```bash
npm install -D eslint @eslint/js globals
```

```js
// eslint.config.js
import js from "@eslint/js";
import globals from "globals";
import { defineConfig } from "eslint/config";

export default defineConfig([
  js.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser }, // 告訴 ESLint 有 window、document 這些全域變數
    },
    rules: {
      eqeqeq: ["error", "always", { null: "ignore" }], // 要求 ===，允許 == null
      "no-unused-vars": "warn",
    },
  },
]);
```

```js
// src/bad.js
export function check(value, unused) {
  if (value == "1") return true;
  if (value == null) return false;
  return totl > 0;
}
```

```text
$ npx eslint .
src/bad.js
  1:30  warning  'unused' is defined but never used   no-unused-vars
  2:13  error    Expected '===' and instead saw '=='  eqeqeq
  4:10  error    'totl' is not defined                no-undef
```

拼錯的變數名稱、用了 `==`（[1.8 節](01-values-types-and-comparison.md#18-相等-與-objectis)）、忘了用的變數，在執行之前就被抓出來。`js.configs.recommended` 是官方建議的規則集，從它開始，再依團隊需要加減規則。在 Node 執行的程式，把 `globals.browser` 換成 `globals.node`。

### Prettier：統一格式

```bash
npm install -D prettier
npx prettier --write .   # 格式化所有檔案
npx prettier --check .   # 只檢查，CI 用
```

ESLint 管「程式碼有沒有問題」，Prettier 管「程式碼長什麼樣子」（縮排、引號、換行、分號）。格式交給工具統一後，程式碼審查不用再討論空白和逗號，[2.3 節](02-functions.md#23-回傳值)那種 `return` 後換行的排版也不會出現。

兩者都可以裝成編輯器的擴充套件，存檔時自動執行。

## 18.4 第一個測試

把核心邏輯寫成純函數（[2.6 節](02-functions.md#26-純函數與副作用)），測試就很簡單：給輸入、檢查輸出，不需要瀏覽器、DOM 或網路。

把 [13.11 節](13-dom-and-events.md#1311-組起來讓資料決定畫面)待辦清單的狀態更新抽成獨立的模組：

```js
// src/todos.js
export function addTodo(todos, title, id) {
  const trimmed = title.trim();
  if (!trimmed) return todos;
  return [...todos, { id, title: trimmed, done: false }];
}

export function toggleTodo(todos, id) {
  return todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t));
}

export function countLeft(todos) {
  return todos.filter((t) => !t.done).length;
}
```

### 用 Node 內建的 `node:test`

不需要安裝任何套件：

```js
// src/todos.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { addTodo, toggleTodo, countLeft } from "./todos.js";

test("addTodo 會去掉前後空白並加在最後", () => {
  const result = addTodo([], "  買牛奶 ", 1);
  assert.deepEqual(result, [{ id: 1, title: "買牛奶", done: false }]);
});

test("addTodo 遇到空白標題時回傳原陣列", () => {
  const todos = [{ id: 1, title: "a", done: false }];
  assert.equal(addTodo(todos, "   ", 2), todos);
});

test("toggleTodo 不修改原陣列", () => {
  const todos = [{ id: 1, title: "a", done: false }];
  const next = toggleTodo(todos, 1);
  assert.equal(todos[0].done, false);
  assert.equal(next[0].done, true);
  assert.equal(countLeft(next), 0);
});
```

```text
$ node --test
✔ addTodo 會去掉前後空白並加在最後 (0.72ms)
✔ addTodo 遇到空白標題時回傳原陣列 (0.07ms)
✔ toggleTodo 不修改原陣列 (0.08ms)
ℹ tests 3
ℹ pass 3
ℹ fail 0
```

`node --test` 會自動找出 `*.test.js` 這類命名的檔案。`node:assert/strict` 裡：

- `assert.equal` 用 `===` 比較（[1.8 節](01-values-types-and-comparison.md#18-相等-與-objectis)）。第二個測試用它確認回傳的是**同一個**陣列。
- `assert.deepEqual` 遞迴比較內容，用在物件與陣列上。
- `await assert.rejects(promise)` 檢查非同步函式會失敗。

第三個測試確認了「不修改原陣列」：這正是 [4.5 節](04-objects-and-arrays.md#45-不可變更新)不可變更新的要求，寫成測試之後，以後有人不小心改成直接修改，測試就會失敗。

### 在 Vite 專案用 Vitest

Vite 專案通常用 Vitest：設定沿用 `vite.config.js`，也能測試要經過 Vite 處理的程式碼（import CSS、環境變數）。

```bash
npm install -D vitest
```

```js
// 只要把 test 改從 vitest 匯入，上面的測試不用其他修改
import { test } from "vitest";
import assert from "node:assert/strict";
```

```bash
npx vitest        # 監看模式：存檔後自動重跑相關的測試
npx vitest run    # 執行一次，CI 用
```

Vitest 也提供 `expect(x).toEqual(y)` 這種寫法，以及模擬函式、模擬計時器、模擬瀏覽器環境等功能。元件測試、整合測試、E2E 測試在 [前端測試課程](../frontend-testing-course/README.md)。

## 18.5 專案的組織方式

```text
src/
├─ main.js            ← 進入點：組裝與啟動，盡量薄
├─ todos.js           ← 純邏輯：資料怎麼變化，不碰 DOM、不發請求
├─ todos.test.js
├─ api.js             ← 網路：createApiClient 與各個 API 呼叫
└─ view.js            ← 畫面：render 與事件綁定
```

依「會不會有副作用」分層：

- **純邏輯**放在獨立的模組，不 import DOM 或網路相關的東西。它最容易測試，也最常需要修改。
- **副作用**（DOM、網路、Storage、計時器）集中在少數幾個模組，透過參數或模組邊界和純邏輯連接。
- **進入點**只負責把各部分接起來。

這也是 React、Vue 專案的組織方式：元件負責畫面，狀態管理與資料轉換盡量寫成可以單獨測試的函式。

## 18.6 接下來

| 想做的事 | 下一門課 |
|---------|---------|
| 讓編輯器和編譯器幫你檢查型別 | [TypeScript](../typescript/README.md) |
| 用元件組織畫面 | [React](../react/README.md) 或 [Vue 基礎](../vue/basics/README.md) |
| 寫伺服器、API、資料庫 | [Node.js 後端與全端服務開發](../nodejs-course/README.md) |
| 測試元件與完整流程 | [前端測試](../frontend-testing-course/README.md) |
| 理解建置工具在做什麼 | [Vite 原理與內核](../vite-course/README.md) |
| 版本控制與協作 | [Git](../git/git.md) |

## 18.7 本章小結

- `package.json` 記錄套件與指令；`package-lock.json` 要提交，CI 用 `npm ci`。
- 安裝套件前先確認平台是否已經內建。
- Vite 提供開發伺服器、模組解析、資源處理與建置；`VITE_` 開頭的環境變數會公開在前端程式裡。
- ESLint 抓出可能的錯誤，Prettier 統一格式，兩者分工、一起用。
- 純函數用 `node:test` 或 Vitest 測試，給輸入、檢查輸出；把「不修改原資料」這類約定寫成測試。
- 依有沒有副作用分層：純邏輯獨立、副作用集中、進入點保持精簡。

---

[上一章：記憶體與效能除錯](17-memory-and-performance.md) · [返回課程總覽](README.md)
