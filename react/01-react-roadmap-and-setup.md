# 第 1 章：React 課程地圖與開發環境

## 本章目標

完成這一章後，你應該可以：

1. 說出 React 在前端開發中的角色。
2. 建立一個可正常開發的 React 專案（Vite）。
3. 看懂專案基本結構與日常開發流程。
4. 跑起第一個 React 頁面並確認環境正確。

---

## 1. React 在做什麼？

React 是一個「用元件建構 UI」的函式庫。  
你可以把畫面切成一個個可重用元件，再由資料驅動畫面更新。

用一句話記：

> **狀態改變 -> React 重新渲染 UI**

這種模式有三個好處：

- 介面可以模組化拆分。
- 資料流可預測，維護成本較低。
- 團隊協作時邏輯邊界更清楚。

---

## 2. 這門課的學習路線

你會先學穩三件事：

1. React 與 JavaScript 核心觀念
2. 元件、狀態、事件與副作用
3. 路由與實務開發結構

接著進入兩個重點工具：

- `TanStack Query`：管理伺服器資料（查詢、快取、重抓）
- `Zustand`：管理全域本地狀態（UI 控制、跨頁共享）

最後會補上效能、測試、部署與專題收斂。

---

## 3. 安裝開發環境

### 3.1 安裝 Node.js

建議安裝 Node.js 22 LTS 或更新的 LTS 版本。

安裝後請確認：

```bash
node -v
npm -v
```

`node -v` 若顯示 `v18`、`v20` 等舊版本，請先升級：較新的 Vite 需要較新的 Node，版本太舊時安裝會出現 Node 版本不符的警告（例如 `EBADENGINE`），`npm run dev` 也可能直接失敗。

### 3.2 推薦工具

- 編輯器：Cursor / VS Code
- 瀏覽器：Chrome
- 插件：React Developer Tools

---

## 4. 用 Vite 建立第一個 React 專案

```bash
npm create vite@latest my-react-course -- --template react
cd my-react-course
npm install
npm run dev
```

第一次執行 `npm create` 時，npm 可能會問是否安裝 `create-vite`（`Ok to proceed?`），按 `y` 繼續；若建立工具還詢問其他選項，選預設值即可（如果它已經幫你裝好並啟動，後面的 `npm install`、`npm run dev` 就不用再跑）。

啟動後會看到本機開發網址（通常是 `http://localhost:5173`），用瀏覽器打開即可；要停止開發伺服器，在終端機按 `Ctrl + C`。

> **版本說明**：這個模板會安裝最新版的 React（目前是 19），可以在 `package.json` 的 `dependencies` 看到版本。本課範例以 React 18 寫成，在 19 上照樣能跑；少數在 19 有差異或有新寫法的地方，課文會另外提醒。

---

## 5. 專案結構先看懂

建立完成後，先認識幾個最常碰到的檔案：

- `package.json`：專案用到的套件與版本，以及 `npm run dev` 這類指令的定義
- `index.html`：入口 HTML，提供掛載節點（`<div id="root"></div>`）
- `src/main.jsx`：React 進入點，把根元件掛到 `#root` 上
- `src/App.jsx`：主要頁面元件
- `src/assets/`：圖片與靜態資源

你現在不需要一次搞懂全部，只要知道：

> `main.jsx` 把 `App` 掛到頁面上，`App` 內部再拆成更多元件。

---

## 6. 日常開發流程（最小迴圈）

每次開發盡量固定以下節奏：

1. 啟動開發伺服器：`npm run dev`
2. 修改 `src` 內元件
3. 觀察瀏覽器即時更新（HMR，Hot Module Replacement：存檔後只替換改到的模組，不用手動重新整理）
4. 開啟 console 看是否有錯誤
5. 版本控制提交（每個小步驟一個 commit）

---

## 7. 本章小練習

請完成以下練習，確認環境沒問題：

1. 把頁面標題改成「React 學習儀表板」。
2. 顯示今天日期。
3. 建立三個學習目標清單。
4. 套一層簡單樣式（卡片、陰影、留白）。

---

## 最後範例：React 開發環境健康檢查頁

以下三個檔案，直接用整份內容取代模板裡的同名檔案。

### `src/main.jsx`

```jsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./App.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

- 模板原本在這裡引入 `./index.css`，本例改成引入 `./App.css`，樣式全部寫在 `App.css`。`index.css` 不再使用，留著或刪掉都可以；若保留原本的引入，模板的預設樣式（背景色、排版等）會和本例樣式疊在一起，畫面會跟預期不同。
- `<React.StrictMode>` 是開發模式專用的檢查工具，不會出現在畫面上；它造成的「某些程式執行兩次」現象，第 7 章會說明。

### `src/App.jsx`

```jsx
const goals = [
  "完成 React 開發環境安裝",
  "看懂 React 專案基本結構",
  "能獨立啟動並修改第一個頁面",
];

function App() {
  const today = new Date().toLocaleDateString("zh-TW", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });

  return (
    <main className="page">
      <section className="card">
        <h1>React 學習儀表板</h1>
        <p className="muted">今天是：{today}</p>
        <h2>本章完成目標</h2>
        <ul>
          {goals.map((goal) => (
            <li key={goal}>{goal}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}

export default App;
```

`{today}` 這種大括號寫法、`goals.map(...)` 渲染清單與 `key`，第 3 章會詳細說明，這裡先照打、確認畫面出現即可。

### `src/App.css`

```css
:root {
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #111827;
  background-color: #f3f4f6;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
}

.page {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
}

.card {
  width: min(680px, 100%);
  background: #ffffff;
  border-radius: 16px;
  padding: 24px;
  box-shadow: 0 10px 30px rgba(17, 24, 39, 0.08);
}

.muted {
  color: #4b5563;
}

h1,
h2 {
  margin-top: 0;
}

ul {
  padding-left: 20px;
}

li {
  margin-bottom: 8px;
}
```

---

## 本章結語

你已經完成 React 學習最重要的一步：把開發環境跑起來。  
下一章會補齊 React 會大量用到的 JavaScript 核心能力，幫你在後面寫元件時更順。
