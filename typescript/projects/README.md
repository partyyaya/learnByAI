# 實戰專案：TypeScript 在真實前端專案中的用法

這個資料夾收錄兩個**可實際執行**的小型前端專案，示範 TypeScript 在貼近真實開發情境下的用法。兩個專案功能完全對應，一個用 **Vue 3**、一個用 **React 19**，讓你可以把「同一件事在兩個框架各怎麼用 TypeScript 寫」拿來左右對照。

| 專案 | 技術棧 | 說明 |
|------|--------|------|
| [vue-app](./vue-app/) | Vue 3 + Pinia + Vue Router + axios | Vue 版「使用者與文章瀏覽器」 |
| [react-app](./react-app/) | React 19 + Zustand + React Router + axios | React 版「使用者與文章瀏覽器」 |

> 這兩個專案是課程 [第 10 章：前端框架整合](../10-framework-integration.md) 的延伸——第 10 章講「怎麼設定」，這裡則是「設定好之後，一個有狀態管理、路由、API 串接的真實專案長什麼樣」。

---

## 這兩個專案在示範什麼？

一個共同的小應用「**使用者與文章瀏覽器**」，資料來自免費的公開 API [JSONPlaceholder](https://jsonplaceholder.typicode.com)（不需要註冊或金鑰）。三個頁面：

- `/`　　　　首頁（簡介）
- `/users`　　使用者列表（可即時搜尋、可加入收藏）
- `/users/:id`　使用者詳情 + 該使用者的文章列表

功能上刻意涵蓋真實專案最常見的幾塊，並各自展示對應的 TypeScript 重點：

| 面向 | 重點 | Vue 版 | React 版 |
|------|------|--------|----------|
| **API 串接** | 型別化 axios：攔截器、錯誤正規化、`get<T>()` 讓呼叫端直接拿到 `T` | `src/api/` | `src/api/` |
| **領域型別** | 共用的 DTO 介面（`User` / `Post` / `ApiError`），兩專案形狀完全相同 | `src/types/` | `src/types/` |
| **狀態管理** | store 的型別推論、非同步 action、收藏清單持久化到 localStorage | Pinia（`src/stores/`） | Zustand（`src/stores/`） |
| **路由** | 型別化路由參數（`:id` 由 `string` 轉 `number`）、具名/懶載入路由 | Vue Router（`src/router/`） | React Router（`App.tsx`） |
| **元件** | 元件 props 的型別標註、事件型別 | `defineProps<T>()` / `defineEmits` | `interface Props` |
| **邏輯重用** | 泛型的非同步載入封裝（loading / error / data） | composable `useAsync<T>` | hook `useAsync<T>` |

---

## 為什麼 Vue 用 Pinia、React 用 Zustand？

這是刻意的對照選擇：

- **Pinia** 是 Vue 官方推薦的狀態管理方案，本專案用它的 **setup store** 寫法（`defineStore('x', () => {...})`），型別推論最自然、也最貼近 Composition API。
- **Zustand** 是 React 生態中輕量、型別友善、概念上最接近 Pinia 的 store 方案，最適合拿來和 Pinia 做一對一對照。本專案用它的 curried `create<T>()(...)` 寫法以取得正確型別推論，收藏清單則用官方 `persist` middleware 持久化。

> 若你的 React 專案偏好更「企業級標準」的方案，**Redux Toolkit** 是另一個常見選擇（slice / thunk / typed hooks），但它的樣板較多、和 Pinia 的對照落差也較大，因此教學上這裡選了 Zustand。

---

## 快速開始

> ⚠️ 需要 **Node.js 18 以上**。本機預設的 `node` 可能是舊版（v12），請先用 `nvm use 20`（或 `nvm use 20.19.5`）切換到新版再操作。

兩個專案的指令完全一樣：

```bash
# 擇一進入專案
cd vue-app     # 或 cd react-app

# 安裝依賴
npm install

# 啟動開發伺服器（預設 http://localhost:5173）
npm run dev

# 只做型別檢查（Vue 用 vue-tsc、React 用 tsc）
npm run type-check

# 打包正式版
npm run build
```

API 位址可透過環境變數覆寫：複製 `.env.example` 成 `.env.local`，修改 `VITE_API_BASE_URL` 即可（預設指向 JSONPlaceholder）。

---

## 建議的閱讀順序

1. 先看 `src/types/` —— 了解整個 app 圍繞哪些領域型別打轉。
2. 再看 `src/api/client.ts` —— 型別化的 axios 封裝與錯誤處理。
3. 接著看 `src/stores/` —— 狀態怎麼被型別化地管理與持久化。
4. 最後看 `src/views/` 與 `src/components/` —— 頁面如何把上面這些串起來，以及路由參數、props 的型別怎麼流動。

兩個專案都已通過型別檢查（`npm run type-check` 零錯誤）並能成功 `npm run build`。
