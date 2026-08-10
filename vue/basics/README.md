# Vue 3 精華橋接課（Vue 3.5 + Vite + `<script setup>`）

> 這是一套「快速上手」導向的 Vue 3 課程。目標是：如果你會 JavaScript（可能也學過 React），用最短的路徑把 Vue 3 的核心心智模型與日常寫法建立起來，讓你能**無縫接軌本 repo 的進階課程**——[Vue 源碼解析課](../vue-source/README.md)與 [Nuxt 全端課](../nuxt/README.md)。
>
> 本課全程使用 **Vue 3.5.x + Vite + `<script setup>` 組合式 API（Composition API）**，這也是目前社群與本 repo 進階課的標準寫法。

---

## 課程目標

- 建立 Vue 的核心心智模型：**響應式狀態驅動宣告式畫面**。
- 熟練組合式 API：`ref` / `reactive` / `computed` / `watch`。
- 寫得出可維護的元件與元件間溝通（props / emit / v-model / slots / provide-inject）。
- 能獨立用 Vite 建專案、拆元件、做出一個帶路由與狀態管理的小應用。
- 能用 Vitest + Vue Test Utils 幫元件、composable、store 與路由守衛補上自動化測試。
- 學完後能看懂 vue-source 的原始碼寫法、也能直接進 Nuxt 學全端。

---

## 章節總覽（共 8 章）

| 章節 | 檔案 | 主題 | 你會學到 | 狀態 |
|------|------|------|----------|------|
| 01 | [01-intro-and-setup.md](./01-intro-and-setup.md) | Vue 是什麼與環境建立 | 心智模型、與 React 對照、用 Vite 建專案、SFC 三段結構、第一個響應式狀態、開發工具 | ✅ 已完成 |
| 02 | [02-reactivity-fundamentals.md](./02-reactivity-fundamentals.md) | 響應式基礎 | `ref` / `reactive`（含 `toRefs`）、`computed`（唯讀/可寫）、`watch`（immediate/deep/cleanup）、`watchEffect` | ✅ 已完成 |
| 03 | [03-template-syntax-and-directives.md](./03-template-syntax-and-directives.md) | 模板語法與指令 | 插值與 `v-html`、`v-bind`/`v-on`、`v-if` vs `v-show`、`v-for` + key、class/style 綁定、事件與按鍵修飾符、`v-model` 初探 | ✅ 已完成 |
| 04 | [04-components-props-emit.md](./04-components-props-emit.md) | 元件與溝通 | `defineProps`（含 TS 與 `withDefaults`）、`defineEmits`、`defineModel()`、slots（預設/具名/作用域）、`provide`/`inject`、`$attrs` 透傳 | ✅ 已完成 |
| 05 | [05-lifecycle-and-composables.md](./05-lifecycle-and-composables.md) | 生命週期與 Composables | lifecycle hooks、組合式 vs 選項式、抽 `useXxx`、template refs、`nextTick` | ✅ 已完成 |
| 06 | [06-forms-and-validation.md](./06-forms-and-validation.md) | 表單與驗證 | `v-model` 全套與修飾符（`.number`/`.trim`/`.lazy`）、表單驗證、送出 | ✅ 已完成 |
| 07 | [07-router-and-pinia.md](./07-router-and-pinia.md) | Vue Router 與 Pinia | 路由、導航守衛、Pinia store、串 API 小專案收尾 | ✅ 已完成 |
| 08 | [08-testing-with-vitest.md](./08-testing-with-vitest.md) | 用 Vitest 測試 Vue | Vitest + Vue Test Utils 環境、測純函式／composable、`mount` 與 `emitted`、`v-model`、mock `fetch`、測 Pinia 與路由守衛、覆蓋率 | ✅ 已完成 |

> 第 01～04 章為本課核心（響應式、模板、元件），第 05～07 章補上生命週期、表單與工程化收尾，第 08 章把前面寫的東西用自動化測試保護起來。

---

## 先備知識

- **JavaScript**：變數、函式、箭頭函式、陣列方法（`map`/`filter`）、解構、`Promise` / `async-await`、ES Modules（`import` / `export`）。
- **HTML / CSS 基礎**：知道標籤、屬性、class 與基本樣式。
- **（可選）React 經驗**：有的話更快——本課會適時用「Vue 的 X ≈ React 的 Y」幫你對照，但沒學過 React 也完全能上。
- **環境**：Node.js **20 LTS 以上**（本機若是舊版 Node，先 `nvm use 20`）。

---

## 學習建議

1. **照章節順序學**，每章的範例都是可以直接跑的 SFC，動手打一次比只讀有用得多。
2. **全程開著 Vue DevTools**：學響應式時看資料怎麼變，比只看程式碼快。
3. **每章做完「練習作業」再進下一章**，卡住時回頭看該章的「常見陷阱」。
4. **有 React 背景的人**：留意心態切換——Vue 是「直接改資料」，不用 `setState`；副作用**自動追蹤依賴**，沒有依賴陣列。
5. 前 4 章別急著裝 Router / Pinia / TypeScript，先把核心練熟；到第 7 章再補工程化。
6. 第 8 章的測試不必等到最後才學——寫完第 5、6 章的 composable 後就可以回頭補測試，感受「改壞立刻紅燈」的價值。

---

## 開發環境

- Node.js：**20 LTS 以上**（本機預設是舊版 Node 時，用 `nvm use 20`）
- 套件管理：`npm` / `pnpm` / `yarn` 擇一（本課用 `npm`）
- 編輯器：Cursor / VS Code，裝 **Vue - Official** 外掛（原 Volar；別再裝 Vetur）
- 瀏覽器：Chrome / Edge，裝 **Vue.js devtools**

## 快速開始

```bash
# 0) 確認 Node 版本（舊版先切）
nvm use 20

# 1) 用官方腳手架建立 Vue 專案（前幾章 Router/Pinia/TS 都先選 No）
npm create vue@latest my-vue-course

# 2) 安裝依賴並啟動
cd my-vue-course
npm install
npm run dev
```

打開終端機印出的網址（預設 `http://localhost:5173`）看到 Vue 歡迎頁，即代表環境正確。

---

## 這門課之後接什麼

| 你想往哪走 | 接哪門課 |
|------------|----------|
| 想看懂 Vue 這些 API「背後怎麼實作」 | [Vue 源碼解析課](../vue-source/README.md) |
| 想把 Vue 用在「可上線的全端框架」（SSR、路由、API、資料庫） | [Nuxt 全端課](../nuxt/README.md) |
| 想深入「直接操作 DOM」的自訂指令 | [製作 Vue 自訂指令](../01-custom-directives.md) |
| 想把測試學成一門手藝（策略、E2E、CI、舊專案補測） | [Frontend Testing 課程](../../frontend-testing-course/README.md) |
| 有 React 背景想兩邊對照 | [React 完整課程](../../react/README.md) |

> 本課與 Nuxt 課共用同一套 `<script setup>` 元件寫法，學完本課直接進 Nuxt 幾乎零摩擦。

---

> 從 [第 1 章：Vue 是什麼與環境建立](./01-intro-and-setup.md) 開始。
