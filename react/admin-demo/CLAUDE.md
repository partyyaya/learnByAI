# CLAUDE.md

本專案是一個「模擬後台管理系統」的 React 教學範例，對應 `react/` 資料夾內的完整課程。
技術棧：Vite + React 18 + React Router v6 + TanStack Query v5 + Zustand v5 + Axios（+ axios-mock-adapter 做前端 Mock）。

目標讀者是正在學 React 的人，因此**可讀性 > 花俏**。改動時請延續現有風格，不要引入教學範圍外的新工具。

## 優先順序

1. 保持現有行為與資料流不變。
2. 遵循下述目錄結構與命名慣例。
3. 改動小而聚焦，不順手重構無關檔案。

## 通用規範

- 只用 JavaScript / JSX，**不使用 TypeScript**，不要加型別註記。
- 一律用函式元件 + Hooks，不使用 class 元件。
- 匯入路徑使用 `@/` 別名（指向 `src/`），避免 `../../..`。
- 顯示文字用繁體中文；程式碼識別字用英文。
- 表單控制項一定要有可及名稱：有可見標籤的用 `Field` 包起來；
  工具列這類沒有可見標籤的（搜尋框、篩選下拉）一律加 `aria-label`。
  placeholder 不算標籤——它一打字就消失。
- 縮排 2 空白、不加分號、單引號（見 `.prettierrc.json`）。

## 目錄結構與職責

```
src/
├── main.jsx            # 進入點：掛 BrowserRouter + QueryClientProvider，並在 mock 模式時啟動 mock
├── App.jsx             # 路由樹（Routes/Route）與受保護路由
├── router/             # 路由設定、選單設定、ProtectedRoute
├── layouts/            # 後台外殼（Sidebar + Header + Outlet）
├── pages/              # 路由層級頁面（每個檔名以 Page 結尾）
├── components/ui/      # 跨頁共用的基礎 UI 元件（Button、Card、DataTable...）
├── stores/            # Zustand 全域狀態（本地 / UI 狀態），檔名 xxx.store.js
├── hooks/             # 自訂 hooks，主要封裝 TanStack Query（useXxxQuery / useXxxMutation）
├── services/          # HTTP 層：axios 實例 + 各 domain 的 api 模組（xxx.api.js）
├── mock/              # 前端 mock：axios-mock-adapter 設定 + 假資料 + 各 domain 攔截
├── test/              # 測試共用：setup.js（前置清理）+ renderWithProviders.jsx
├── utils/             # 純函式工具
└── styles/            # 全域樣式（變數/主題、layout、components）
```

## 命名慣例

- 元件檔：PascalCase，`.jsx`。路由層級頁面以 `Page` 結尾（`DashboardPage.jsx`）。
- 資料夾：kebab-case 或依 domain（`courses/`、`users/`）。
- Zustand store：`xxx.store.js`，匯出 `useXxxStore`。
- Query hook：`useXxxQuery.js` / `useXxxMutation.js`。
- API 模組：`xxx.api.js`，依 domain 分檔。
- Mock：`xxx.mock.js`，依 domain 分檔。
- 測試：`Xxx.test.jsx` / `xxx.test.js`，與被測檔案放在同一層。

## 狀態分工（重要）

這是本專案想教的核心觀念，請嚴格遵守：

- **伺服器狀態** → 一律用 TanStack Query（`useQuery` / `useMutation` / `useInfiniteQuery`）。
  loading / error / cache / refetch / 樂觀更新都交給 Query。
- **本地 / UI 狀態** → 用 Zustand（主題、側欄開合、登入資訊、清單篩選條件、選取項目）。
- 兩者透過 `queryKey` 串接：把 store 的篩選條件放進 `queryKey`，條件變動即自動重抓。
- 不要用 `useState` + `useEffect` 手寫抓資料樣板碼；那是課程第 7 章的過渡寫法，正式頁面改用 Query。

## HTTP / API

- 所有請求都走 `src/services/http.js` 的 axios 實例（統一 baseURL、token 注入、錯誤處理）。
- 不要在元件裡直接 `axios.get(...)`；請經由 `services/api/xxx.api.js` 匯出的函式，再由 Query hook 呼叫。
- 錯誤訊息以 `error.message` 呈現給使用者。

## Mock

- 是否啟用由 `VITE_USE_MOCK` 決定（見 `.env.development`），預設 `true`。
- Mock 只在 `src/mock` 內攔截；`services` 與 `pages` 感覺不到差異——這樣未來換真後端幾乎零改動。
- 假資料放 `src/mock/db.js`，各 domain 攔截放對應 `xxx.mock.js`。

## 測試（對應課程第 14 章）

- Vitest + React Testing Library，設定寫在 `vite.config.js` 的 `test` 區塊。
- 元件測試一律用 `src/test/renderWithProviders.jsx`，不要在測試檔裡各自手刻
  `QueryClientProvider` / `MemoryRouter`；測動態路由時傳 `route` 與 `path` 兩個選項。
- 每次 render 都要新的 `QueryClient`（`createTestQueryClient` 已處理），且務必
  `retry: false`——沿用正式設定的 retry 會讓錯誤狀態的測試變慢又不穩。
- 攔截 `services/api/xxx.api.js` 這一層（`vi.mock`），不要去攔 axios 或 mock adapter。
- Zustand 與 localStorage 的重設由 `src/test/setup.js` 統一處理；新增 store 時記得
  把它加進該檔的 `initialStoreStates`，否則測試會跨檔互相污染。
- 查詢元素用使用者視角：`getByRole` / `getByLabelText` 優先，`getByTestId` 是最後手段。
- 等待非同步結果用 `findBy*` 或 `waitFor`，不要用固定秒數的 sleep。

## 對應課程章節（維護時可對照）

| 功能 / 檔案 | 課程章節 |
|---|---|
| 登入表單驗證 `pages/LoginPage.jsx` | 06 表單與驗證 |
| `useEffect` 抓資料示範 `pages/EffectsLabPage.jsx` | 07 useEffect 與 API |
| 巢狀路由 / 動態參數 / 404 `router`, `pages/courses` | 08 React Router |
| `useQuery` 清單 `hooks/useCoursesQuery.js` | 09 Query 基礎 |
| `useMutation` 樂觀更新 / `useInfiniteQuery` | 10 Query 進階 |
| Zustand + persist `stores/ui.store.js` | 11 Zustand |
| Zustand 篩選 + Query queryKey `pages/courses` | 12 Zustand + Query 整合 |
| `memo` / `useMemo` / `useCallback` `pages/PerformanceLabPage.jsx` | 13 效能優化 |
| 測試設定與 Provider 包裝 `src/test/`、各 `*.test.jsx` | 14 測試與部署 |

## 不要做

- 不要引入 TypeScript、UI component library（antd/MUI）、CSS-in-JS。維持純 CSS 變數 + class。
- 不要新增未使用的抽象層。
- 不要在多個 state 重複同一份資料（單一資料來源）。
