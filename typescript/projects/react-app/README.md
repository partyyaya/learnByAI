# 使用者與文章瀏覽器（React 版）

這是 TypeScript 課程中的實戰範例：以真實專案結構打造一個小而完整的應用程式，
資料來源為免費且免驗證的公開 API [JSONPlaceholder](https://jsonplaceholder.typicode.com)。

同一個 App 也有一份姊妹專案 **Vue 版**，兩者的領域型別、API 行為與畫面功能完全對應，
方便對照兩種框架在 TypeScript 上的寫法差異。本專案的狀態管理使用 **Zustand**，
Vue 版則使用 **Pinia**。

## 這個 App 示範了什麼

- 型別化的 axios API 層（request / response 攔截器、統一的錯誤形狀）
- Zustand 狀態管理（使用者資料、收藏清單並持久化到 localStorage）
- React Router 路由（首頁、列表、詳細頁）
- 型別化的元件 props
- 可重用的泛型 hook（`useAsync<T>`）

## 技術棧

- React 19
- TypeScript ~5.6
- Zustand（狀態管理）
- React Router v7（路由）
- axios（HTTP 客戶端）
- Vite（開發與打包工具）

## 安裝與執行

> 需要 Node 18 以上。本機若有 nvm，請先切換版本：
>
> ```bash
> nvm use 20.19.5
> ```

```bash
# 安裝相依套件
npm install

# 啟動開發伺服器
npm run dev

# 型別檢查（不產出檔案）
npm run type-check

# 打包正式版
npm run build

# 預覽打包結果
npm run preview
```

### 環境變數

複製 `.env.example` 為 `.env.local` 後可自訂 API 基底網址；未設定時會 fallback 到公開 API。

```bash
VITE_API_BASE_URL=https://jsonplaceholder.typicode.com
```

## 資料夾結構

```
react-app/
├─ index.html
├─ vite.config.ts            # Vite 設定 + `@` 路徑別名
├─ tsconfig.json             # 專案參照（app + node）
├─ tsconfig.app.json         # 應用程式原始碼的 TS 設定
├─ tsconfig.node.json        # Vite 設定檔的 TS 設定
└─ src/
   ├─ main.tsx               # 進入點（createRoot + StrictMode）
   ├─ App.tsx                # 路由與版面
   ├─ vite-env.d.ts          # import.meta.env 型別
   ├─ types/
   │  └─ index.ts            # 領域型別（與 Vue 版共用形狀）
   ├─ api/
   │  ├─ client.ts           # axios 實例、攔截器、get<T> 輔助函式
   │  ├─ users.ts            # 使用者相關 API
   │  └─ posts.ts            # 文章相關 API
   ├─ stores/
   │  ├─ useUserStore.ts     # 使用者狀態
   │  └─ useFavoritesStore.ts# 收藏（persist 到 localStorage）
   ├─ hooks/
   │  └─ useAsync.ts         # 泛型非同步 hook
   ├─ components/
   │  ├─ NavBar.tsx          # 導覽列 + 收藏數量
   │  └─ UserCard.tsx        # 使用者卡片（typed props）
   └─ views/
      ├─ HomeView.tsx        # 首頁
      ├─ UsersView.tsx       # 使用者列表 + 搜尋
      └─ UserDetailView.tsx  # 使用者詳細頁 + 文章
```

## 這個範例示範了哪些 TypeScript 重點

- **型別化的 axios / DTO**：以 `get<T>()` 輔助函式讓呼叫端直接拿到 `T`，
  並把 `AxiosError` 正規化成統一的 `ApiError` 形狀。
- **Zustand store 型別**：使用 curried 的 `create<T>()(...)` 寫法取得正確推論，
  收藏 store 更透過 `persist` middleware 正確地保留型別。
- **型別化的路由參數**：`useParams` 的值是 `string | undefined`，
  在 `UserDetailView` 中正確轉為 `number` 使用。
- **元件 props 型別**：`UserCard` 以 `interface UserCardProps { user: User }` 定義 props。
- **泛型 hook**：`useAsync<T>` 以 `useState` + `useCallback` 封裝非同步流程，
  並注意記憶化以避免 stale-closure 問題。
