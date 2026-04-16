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

建議安裝 Node.js LTS 版本（18+）。

安裝後請確認：

```bash
node -v
npm -v
```

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

啟動後會看到本機開發網址（通常是 `http://localhost:5173`）。

---

## 5. 專案結構先看懂

建立完成後，先認識幾個最常碰到的檔案：

- `index.html`：入口 HTML，提供掛載節點
- `src/main.jsx`：React 進入點，掛載根元件
- `src/App.jsx`：主要頁面元件
- `src/assets/`：圖片與靜態資源

你現在不需要一次搞懂全部，只要知道：

> `main.jsx` 把 `App` 掛到頁面上，`App` 內部再拆成更多元件。

---

## 6. 日常開發流程（最小迴圈）

每次開發盡量固定以下節奏：

1. 啟動開發伺服器：`npm run dev`
2. 修改 `src` 內元件
3. 觀察瀏覽器即時更新（HMR）
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
