# React 完整課程（含 Zustand + TanStack Query）

> 這是一套以「實作優先」設計的 React 課程。你會先打好 React 與 JavaScript 基礎，再進到現代前端常用的 `TanStack Query` 與 `Zustand`，最後完成可上線的專題。

---

## 課程目錄

| 章節 | 檔案 | 主題 | 狀態 |
|------|------|------|------|
| 01 | [01-react-roadmap-and-setup.md](./01-react-roadmap-and-setup.md) | React 課程地圖與開發環境 | 已完成 |
| 02 | [02-javascript-core-for-react.md](./02-javascript-core-for-react.md) | JavaScript 必備觀念補強 | 已完成 |
| 03 | [03-jsx-and-component-basics.md](./03-jsx-and-component-basics.md) | JSX 與元件基礎 | 已完成 |
| 04 | [04-props-and-component-communication.md](./04-props-and-component-communication.md) | Props 與元件溝通 | 已完成 |
| 05 | [05-state-and-events.md](./05-state-and-events.md) | State 與事件處理 | 已完成 |
| 06 | [06-forms-and-validation.md](./06-forms-and-validation.md) | 表單處理與驗證 | 已完成 |
| 07 | [07-effects-and-api-fetching.md](./07-effects-and-api-fetching.md) | `useEffect` 與 API 串接 | 已完成 |
| 08 | [08-react-router-practice.md](./08-react-router-practice.md) | React Router 路由實戰 | 已完成 |
| 09 | [09-tanstack-query-fundamentals.md](./09-tanstack-query-fundamentals.md) | TanStack Query 基礎 | 已完成 |
| 10 | [10-tanstack-query-advanced.md](./10-tanstack-query-advanced.md) | TanStack Query 進階實戰 | 已完成 |
| 11 | [11-zustand-global-state.md](./11-zustand-global-state.md) | Zustand 全域狀態管理 | 已完成 |
| 12 | [12-zustand-query-integration.md](./12-zustand-query-integration.md) | Zustand 與 Query 整合模式 | 已完成 |
| 13 | [13-performance-and-debugging.md](./13-performance-and-debugging.md) | 效能優化與除錯 | 已完成 |
| 14 | [14-testing-deploy-capstone.md](./14-testing-deploy-capstone.md) | 測試、部署與期末專題 | 規劃中 |

---

## 你會學到什麼

- 建立可維護的 React 元件與頁面結構
- 用正確方式處理本地狀態、表單與副作用
- 用 `TanStack Query` 管理伺服器資料快取、重抓與 mutation
- 用 `Zustand` 管理全域 UI 狀態與跨元件共用資料
- 能規劃「本地狀態 / 伺服器狀態」分工，避免狀態混亂
- 具備上線前的效能、測試、部署基本能力

## 適合對象

- 已有 HTML / CSS / JavaScript 基礎，想完整學 React 的開發者
- 正在做 React 專案，但對狀態管理與資料流還不夠有信心的人
- 想從「會寫畫面」進階到「能設計可維護前端架構」的工程師

## 學習建議

1. 照章節順序學，不要跳章。
2. 每章先看完觀念，再手打一次最後範例。
3. 範例打完後，先自己改 1~2 個需求再進下一章。
4. 到第 9~12 章時，將 Query 與 Zustand 套入你手邊專案做遷移練習。

## 開發環境

- Node.js: 18+（建議 LTS）
- 套件管理: `npm` / `pnpm` / `yarn` 擇一
- 編輯器: Cursor / VS Code
- 瀏覽器: Chrome（建議安裝 React Developer Tools）

## 快速開始

```bash
# 1) 建立 React 專案
npm create vite@latest react-course-app -- --template react

# 2) 安裝依賴
cd react-course-app
npm install

# 3) 啟動開發伺服器
npm run dev
```

---

> 從 [第 1 章：React 課程地圖與開發環境](./01-react-roadmap-and-setup.md) 開始。
