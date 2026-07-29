# 第 1 章：Vue 是什麼與環境建立

> Vue 是一套「宣告式 + 響應式」的前端框架：你只描述「資料長怎樣、畫面就該長怎樣」，剩下的 DOM 更新交給 Vue。
> 這一章先把心智模型講清楚，再帶你用 Vite 建一個能跑的 Vue 3.5 專案，看懂 SFC（單檔元件）三段結構，並寫出你的第一個響應式狀態。

---

## 本章目標

完成這一章後，你應該可以：

1. 用一句話說出 Vue 的核心心智模型：**響應式狀態驅動宣告式畫面**。
2. 講出 Vue 與 React 在定位上的相同與不同（給有 React 背景的你對照用）。
3. 用官方指令建立一個 Vue 3.5 + Vite 專案並成功啟動。
4. 看懂 Vite + Vue 專案結構，知道 `main.js`、`App.vue` 各自負責什麼。
5. 讀懂 SFC 的 `<template>` / `<script setup>` / `<style scoped>` 三段，寫出第一個 `{{ }}` 插值與響應式狀態。
6. 裝好開發工具（VS Code 的 **Vue - Official** 外掛與 Vue DevTools）。

---

## 1. Vue 是什麼？先建立心智模型

傳統用 jQuery 寫網頁，是「命令式（imperative）」：你要一步步下指令——抓到某個元素、改它的 `textContent`、加個 class、綁事件……資料一多，這些手動同步就會失控。

Vue 是「宣告式（declarative）」的：

> **你只描述「資料是什麼、畫面就對應長什麼樣」，Vue 負責在資料變動時，幫你把畫面更新到正確狀態。**

搭配這句的另一半是「響應式（reactive）」：

> **當你把資料宣告成響應式，Vue 會自動追蹤「哪些畫面用到了這份資料」，資料一改，用到它的畫面就自動重繪。**

把這兩句合起來，就是 Vue 的全部精神：

```text
響應式狀態（state）  ──改變──▶  Vue 自動追蹤依賴  ──▶  對應的畫面自動更新
```

你在整套 Vue（以及後面的 vue-source、nuxt）都在反覆用這個迴圈。先記住它，後面每個 API 都是在服務這件事。

---

## 2. 給 React 背景的你：Vue vs React 定位對照

如果你學過 React，這張表能幫你快速定位。細節後面章節會展開，這裡先建立直覺：

| 面向 | React | Vue 3 |
|------|-------|-------|
| 核心心智 | 宣告式 UI（UI 是狀態的函式） | 宣告式 UI + **自動響應式追蹤** |
| 撰寫單位 | 函式元件 + JSX（`.jsx`） | 單檔元件 SFC（`.vue`，template/script/style 三段） |
| 畫面語法 | JSX（在 JS 裡寫 HTML） | Template（在 HTML 裡寫指令 `v-if`、`v-for`） |
| 狀態宣告 | `useState` | `ref` / `reactive` |
| 更新方式 | 呼叫 `setState`，整個元件函式重跑 | 直接改 `.value` 或物件屬性，**只重跑用到它的部分** |
| 副作用/依賴 | `useEffect` + **手動依賴陣列** | `watch` / `watchEffect`，**自動追蹤依賴** |
| 樣式 | 自己選方案（CSS Modules、styled…） | SFC 內建 `<style scoped>` |

一句話總結差異：

> **React 每次狀態變都「重跑整個元件函式」，靠你手動列依賴；Vue 靠響應式系統「自動知道誰依賴誰」，只更新該更新的地方。**

這不是說誰比較好，而是心態要切換：在 Vue，你**直接改資料**（`count.value++`、`user.name = 'x'`），不需要 `setState` 那種「回傳新物件」的思維。這點在第 2 章會反覆練到。

---

## 3. 環境需求：Node 版本

Vue 3.5 + Vite 需要較新的 Node，本課一律用 **Node 20 LTS 以上**。先確認版本：

```bash
node -v   # 建議 v20 以上
npm -v
```

> ⚠️ 若你本機預設是舊版 Node（例如 v12），用它跑 Vite 會直接失敗（常見是 rollup 原生模組找不到）。請用 nvm 切到 20：

```bash
nvm install 20
nvm use 20
node -v   # 例如 v20.19.5
```

---

## 4. 用官方指令建立專案

建立 Vue 專案有兩條路，本課推薦第一條：

### 4.1 推薦：`npm create vue@latest`（官方腳手架）

這是 Vue 官方的專案產生器，底層也是 Vite，但會多問「要不要 Router、Pinia、TypeScript…」，很適合當學習起點。

```bash
npm create vue@latest my-vue-course
```

它會問一連串問題，本課建議這樣選：

```text
✔ Add TypeScript?                        › No    （先用 JS，把觀念學穩再上 TS）
✔ Add JSX Support?                        › No    （Vue 主用 template，不需要）
✔ Add Vue Router for SPA?                 › No    （第 7 章才學，先不裝）
✔ Add Pinia for state management?         › No    （第 7 章才學，先不裝）
✔ Add Vitest for unit testing?           › No
✔ Add an End-to-End Testing Solution?    › No
✔ Add ESLint for code quality?           › Yes   （幫你抓錯，建議裝）
✔ Add Prettier for formatting?           › Yes   （自動排版，建議裝）
```

> 為什麼先都不裝 Router / Pinia / TS？因為前 6 章要專心把「響應式、模板、元件」這些**核心**練熟。等第 7 章要做路由與狀態管理時再裝，你會更清楚它們各自補了什麼。

### 4.2 替代：`npm create vite@latest`（更精簡）

如果你想要最乾淨的起點，也可以直接用 Vite 的 Vue 模板：

```bash
npm create vite@latest my-vue-course -- --template vue
```

差別是：`create vite` 給你一個「只有 Vue + Vite」的最小專案，不問 Router/Pinia/ESLint。兩者產出的 `App.vue` / `main.js` 結構幾乎一樣，本課的範例兩者都能跑。**擇一即可**，不用兩個都建。

### 4.3 安裝依賴並啟動

```bash
cd my-vue-course
npm install
npm run dev
```

終端機會印出一個網址（預設 `http://localhost:5173`），打開看到 Vue 歡迎頁，就代表環境正確。改任何檔案存檔，畫面會即時更新（這叫 **HMR，熱模組替換**）。

---

## 5. 專案結構導覽

`npm create vue` 產出的專案，重點檔案如下（省略設定檔）：

```text
my-vue-course/
├─ index.html          ← 唯一的 HTML，裡面有 <div id="app"></div> 掛載點
├─ src/
│  ├─ main.js          ← 進入點：建立 App 並掛到頁面上
│  ├─ App.vue          ← 根元件（整個畫面的最外層）
│  ├─ components/      ← 你寫的元件放這裡
│  └─ assets/          ← CSS、圖片等資源
├─ public/             ← 原樣輸出的靜態檔（favicon…）
├─ package.json
└─ vite.config.js      ← Vite 設定（含 @vitejs/plugin-vue）
```

三個檔案的關係，用一句話串起來：

> `index.html` 提供一個空的 `#app` 容器 → `main.js` 把 `App.vue` 這個根元件掛進 `#app` → 之後所有畫面都從 `App.vue` 往下長。

這跟 React 的 `index.html` + `main.jsx`（`createRoot(...).render(<App/>)`）+ `App.jsx` 是完全一樣的三層關係。

---

## 6. `main.js`：`createApp(App).mount('#app')`

打開 `src/main.js`，核心就三行：

```js
// src/main.js
import { createApp } from 'vue'
import App from './App.vue'
import './assets/main.css'   // 全域樣式（create vue 產生的，可留可改）

createApp(App).mount('#app')
```

拆解：

- `createApp(App)`：用根元件 `App` 建立一個 Vue 應用實例。
- `.mount('#app')`：把這個應用掛到 `index.html` 裡的 `<div id="app">`。

之後你若要註冊全域外掛（例如第 7 章的 Router、Pinia），就是在 `mount` 之前用 `.use(...)` 串上去。現在先知道「進入點在這裡」就好。

對照 React：

```jsx
// React 的等價寫法
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
createRoot(document.getElementById('root')).render(<App />)
```

概念一樣：**拿根元件，掛到頁面上某個 DOM 節點**。

---

## 7. SFC 三段結構：`<template>` / `<script setup>` / `<style scoped>`

Vue 的元件寫在副檔名 `.vue` 的檔案裡，稱為 **SFC（Single-File Component，單檔元件）**。一個 SFC 通常有三段：

```vue
<script setup>
// ① 邏輯：狀態、函式、import 其他元件
</script>

<template>
  <!-- ② 畫面：長什麼樣、用到哪些狀態 -->
</template>

<style scoped>
/* ③ 樣式：只作用在這個元件內 */
</style>
```

三段各自的角色：

| 區塊 | 作用 | 對應 React 的什麼 |
|------|------|------------------|
| `<script setup>` | 元件的邏輯：宣告狀態、函式、匯入子元件 | 函式元件的函式本體 |
| `<template>` | 元件的畫面：HTML + Vue 指令與插值 | JSX 的 return |
| `<style scoped>` | 元件的樣式，`scoped` 讓它只影響本元件 | CSS Modules / scoped 樣式方案 |

重點名詞 **`<script setup>`**：這是 Vue 3 的官方推薦寫法（本課全程使用）。它是「組合式 API（Composition API）」的語法糖——你在 `<script setup>` 裡宣告的變數、函式，`<template>` 都能直接用，不必手動 return。這比舊的「選項式 API（Options API，用 `data()`、`methods` 等物件）」更直覺，也是進入 vue-source 與 nuxt 課程的標準寫法。

`scoped` 的意思：加上 `scoped` 後，這段 CSS 只會套用到「這個元件」的元素，不會外洩去影響別的元件。這是 SFC 內建的樣式隔離，React 要另外選方案，Vue 直接給你。

---

## 8. 第一個響應式狀態與 `{{ }}` 插值

現在把樣板換成你自己的第一個元件。原樣覆蓋 `src/App.vue`：

```vue
<script setup>
import { ref } from 'vue'

// ref() 建立一個「響應式狀態」。
// 在 <script> 裡要用 .value 讀寫；在 <template> 裡會自動解包，直接寫 count 即可。
const count = ref(0)
const title = ref('我的第一個 Vue App')

function increment() {
  count.value++          // 直接改 .value，畫面就會自動更新
}
</script>

<template>
  <main class="wrap">
    <!-- {{ }} 叫「文字插值」，把響應式狀態塞進畫面 -->
    <h1>{{ title }}</h1>

    <!-- @click 是綁事件（第 3 章詳講），這裡先感受「改資料 → 畫面自動變」 -->
    <button class="btn" @click="increment">
      被點了 {{ count }} 次
    </button>

    <!-- 插值裡可以放 JS 運算式 -->
    <p class="hint">點兩下之後，總共會是 {{ count + 2 }}。</p>
  </main>
</template>

<style scoped>
.wrap {
  max-width: 640px;
  margin: 48px auto;
  padding: 0 16px;
  font-family: -apple-system, "Segoe UI", sans-serif;
  color: #111827;
  line-height: 1.7;
}
h1 { font-size: 28px; }
.btn {
  margin: 12px 0;
  padding: 10px 18px;
  font-size: 16px;
  color: #fff;
  background: #42b883;      /* Vue 的招牌綠 */
  border: none;
  border-radius: 10px;
  cursor: pointer;
}
.btn:hover { background: #369a6e; }
.hint { color: #6b7280; font-size: 14px; }
</style>
```

存檔後回到瀏覽器：

- 看到標題與按鈕 → 元件渲染正常。
- 點按鈕，數字會加、`count + 2` 也跟著變 → **響應式生效了**：你只改了 `count.value`，畫面上兩處用到它的地方自動同步。

這就是第 1 節那個迴圈的實際體驗。注意你**沒有**寫任何「去更新畫面」的程式碼——這正是宣告式 + 響應式的價值。

> `ref` 和 `.value` 是很多人第一個卡住的地方（為什麼要 `.value`？為什麼 template 又不用？）。這是下一章的主角，這裡先照著寫、先有手感即可。

---

## 9. 開發工具

工欲善其事，兩個工具務必裝好：

### 9.1 VS Code 外掛：Vue - Official（原 Volar）

在 VS Code 擴充套件搜尋 **「Vue - Official」**（發佈者 Vue，就是原本的 Volar）安裝。它提供：

- `.vue` 檔的語法高亮與排版
- `<template>` 內的自動補全與型別提示
- 跳轉定義、找元件用法

> 注意：舊教學可能叫你裝「Vetur」——那是 Vue 2 時代的外掛，Vue 3 請改用 **Vue - Official**，兩者不要同時開，會打架。

### 9.2 瀏覽器：Vue DevTools

到 Chrome / Edge 擴充商店安裝 **Vue.js devtools**。裝好後，在你的 Vue App 頁面打開瀏覽器開發者工具，會多一個「Vue」分頁，可以看到：

- 元件樹與每個元件當下的狀態
- 響應式資料的即時數值（除錯超好用）
- 時間軸與事件

> 學響應式時，開著 DevTools 看數值怎麼變，比只看程式碼快得多。第 2 章開始建議全程開著它。

---

## 常見陷阱

1. **Node 版本太舊**：本機預設 Node 12 之類的舊版跑不起來 Vite。先 `nvm use 20` 再 `npm install`。
2. **`create vite` 與 `create vue` 搞混**：兩者都能建 Vue 專案，差別只在「問不問你要不要 Router/Pinia/TS」。擇一即可，別兩個都建又互相蓋掉。
3. **忘記 `.value`**：在 `<script setup>` 裡讀寫 `ref` 一定要加 `.value`（`count.value++`）；只有 `<template>` 裡才會自動解包。少寫 `.value` 是新手最常見的 bug（第 2 章詳解）。
4. **裝了 Vetur**：Vue 3 專案請用 **Vue - Official**，別再裝 Vetur，兩者衝突會導致型別與高亮錯亂。
5. **把樣式寫在別的元件卻期待它生效**：`<style scoped>` 只影響當前元件；要全域樣式請放在 `main.js` 匯入的全域 CSS，或用不加 `scoped` 的 `<style>`。

---

## 練習作業

1. 用 `nvm use 20` 確認 Node 版本，再用 `npm create vue@latest` 建專案並成功 `npm run dev`。
2. 把 `App.vue` 換成本章第 8 節的範例，確認點按鈕數字會變、`count + 2` 同步變動。
3. 在同一個元件多加一個 `ref`（例如 `const step = ref(1)`），把 `increment` 改成 `count.value += step.value`，並在畫面上顯示目前的 `step`。
4. 打開 Vue DevTools，點按鈕時觀察 `count` 的數值在 DevTools 裡怎麼變。
5. 隨手改 `<h1>` 的文字存檔，體會 HMR 即時更新。

---

## 上一章 / 下一章

- 上一章：[課程索引（README）](./README.md)
- 下一章：[第 2 章：響應式基礎（ref / reactive / computed / watch）](./02-reactivity-fundamentals.md)
