# React Admin Demo · 課程實戰後台

這是 [`react/` 課程](../README.md)的整合實戰範例：一個**模擬後台管理系統**，
把課程 06～13 章的重點（表單驗證、`useEffect`、React Router、TanStack Query、Zustand、效能優化）
收斂成一個可實際操作的專案。

> 全程使用**前端 Mock**，不需要任何後端即可跑起來。

---

## 技術棧

| 類別 | 選型 | 對應章節 |
|------|------|----------|
| 建構工具 | Vite 5 | 01 |
| UI | React 18 + JSX（純 CSS，含亮/暗主題） | 03～05 |
| 路由 | React Router v6（巢狀路由、動態參數、路由守衛、404） | 08 |
| 伺服器狀態 | TanStack Query v5（`useQuery` / `useMutation` / `useInfiniteQuery` / 樂觀更新） | 09、10 |
| 本地狀態 | Zustand v5（`persist`、selector 最小訂閱） | 11、12 |
| HTTP | Axios（統一實例、攔截器） | 07 |
| Mock | axios-mock-adapter（攔截 axios 請求回傳假資料） | — |
| 測試 | Vitest + React Testing Library（jsdom） | 14 |

---

## 快速開始

```bash
cd react/admin-demo
npm install
npm run dev
```

打開終端機顯示的網址（預設 http://localhost:5173）。

### 登入帳號（Mock）

| 帳號 | 密碼 | 角色 |
|------|------|------|
| `admin` | `admin123` | 管理員（全部選單） |
| `editor` | `editor123` | 編輯（無「使用者管理」） |

---

## 可用指令

| 指令 | 說明 |
|------|------|
| `npm run dev` | 啟動開發伺服器（熱更新） |
| `npm run build` | 打包到 `dist/` |
| `npm run preview` | 本機預覽打包結果 |
| `npm run test` | Vitest watch 模式（開發時開著） |
| `npm run test:run` | 跑完一輪就結束，CI 與部署前用這個 |
| `npm run lint` | ESLint 檢查 |
| `npm run format` | Prettier 格式化 |

---

## 測試（第 14 章）

```bash
npm run test:run
```

測試檔與被測程式放在一起（`Xxx.jsx` 旁邊就是 `Xxx.test.jsx`），共用工具放 `src/test/`：

| 檔案 | 示範什麼 |
|------|----------|
| `src/test/setup.js` | 共用前置：jest-dom 斷言、每個測試前重設 Zustand 與 localStorage |
| `src/test/renderWithProviders.jsx` | 把元件包進 `QueryClientProvider` + `MemoryRouter` 再 render |
| `src/utils/format.test.js` | 純函式與邊界情況 |
| `src/stores/courseFilter.store.test.js` | Zustand store 測試，不需要 render 任何元件 |
| `src/pages/LoginPage.test.jsx` | 表單驗證、mutation 成功/失敗、登入態寫入 store |
| `src/pages/courses/CourseListPage.test.jsx` | 篩選條件 → `queryKey` → API 參數，樂觀更新的刪除與上下架 |
| `src/pages/courses/CourseDetailPage.test.jsx` | 動態路由參數、載入與錯誤狀態 |

三個貫穿全部測試檔的原則：

1. **測行為，不測實作細節**——查詢一律用使用者視角（`getByRole` / `getByLabelText`）。
2. **攔截 API 模組而非 axios**——測試驗的是元件對成功/失敗的反應，換掉最靠近元件的那一層最省事。
3. **每個測試都從乾淨狀態開始**——全新的 `QueryClient`、重設過的 store，避免順序一換結果就變。

每支測試檔開頭都有註解說明它在示範什麼，可以直接當第 14 章的延伸閱讀。

---

## 功能 → 課程對照

| 頁面 | 你會看到什麼 | 章節 |
|------|--------------|------|
| **登入** | 受控元件、同步驗證、送出流程、Zustand 存登入態 | 06、11 |
| **儀表板** | `useQuery` 抓統計、載入/錯誤狀態、卡片 | 09 |
| **課程管理** | Zustand 管篩選 → 進 `queryKey` → Query 自動重抓；`useMutation` 新增（樂觀更新 + 失敗回滾）、切換上架、刪除 | 10、12 |
| **課程詳情** | 巢狀路由 + `useParams` 動態載入 | 08 |
| **課程無限捲動** | `useInfiniteQuery`「載入更多」 | 10 |
| **使用者管理** | 依權限顯示選單、表格、分頁 | 08、11 |
| **Effects 實驗室** | 課程第 7 章寫法：`useEffect` + `AbortController` 手動抓資料，對照 Query 的差異 | 07 |
| **效能實驗室** | 2000 筆列表 + `React.memo` / `useMemo` / `useCallback` | 13 |
| **設定** | 主題切換、側欄偏好、收藏清單（`persist` 存 localStorage） | 11 |
| **404** | 萬用路由回饋 | 08 |

---

## 專案結構

```
src/
├── main.jsx          進入點：Router + QueryClientProvider + 啟動 mock
├── App.jsx           路由樹與受保護路由
├── router/           路由設定、選單設定、ProtectedRoute
├── layouts/          後台外殼（Sidebar + Header + Outlet）
├── pages/            各頁面（檔名以 Page 結尾）
├── components/ui/    共用基礎 UI（Button、Card、DataTable、Modal...）
├── stores/           Zustand 全域狀態（auth / ui / courseFilter）
├── hooks/            封裝 TanStack Query 的自訂 hooks
├── services/         axios 實例 + 各 domain api 模組
├── mock/             axios-mock-adapter 設定 + 假資料
├── test/             測試共用設定與 renderWithProviders
├── utils/            純函式工具
└── styles/           全域樣式（主題變數、layout、components）
```

詳細開發規範見 [CLAUDE.md](./CLAUDE.md)。

---

## 核心觀念：狀態分工

本專案最想傳達的一件事——**伺服器狀態與本地狀態分開管理**：

- 後端來的資料（清單、詳情、統計）→ **TanStack Query**，快取與重抓交給它。
- UI 與互動狀態（主題、側欄、登入態、篩選條件、選取項目）→ **Zustand**。
- 兩者以 `queryKey` 串接：`queryKey: ['courses', filters]`，`filters` 來自 Zustand，
  條件一改，Query 自動抓對應資料。

這樣責任邊界清楚，畫面狀態不會互相打架，是中大型 React 專案可維護的關鍵。

---

## 接真後端

1. 把 `.env.development` 的 `VITE_USE_MOCK` 改成 `false`。
2. 在 `vite.config.js` 的 `server.proxy` 設定後端網域。
3. 其餘程式（`services` / `hooks` / `pages`）不需改動——因為 mock 只在 `src/mock` 攔截。
