# 使用者與文章瀏覽器（Vue 3 + TypeScript 範例）

這是 TypeScript 課程中的一個實作範例，示範如何在一個「接近真實」的專案結構下，
用 Vue 3 + TypeScript 串接免費的公開 API [JSONPlaceholder](https://jsonplaceholder.typicode.com)，
瀏覽使用者清單、查看單一使用者的詳細資料與其文章，並可將喜歡的使用者加入收藏。

## 這個 App 示範了什麼

- 型別化的 axios API 層（統一的錯誤處理與 `get<T>` 泛型輔助函式）
- 使用 Pinia 做狀態管理（`users` 與 `favorites` 兩個 store）
- 使用 Vue Router 做路由（含型別化的動態路由參數）
- 型別化的 props / emits
- 一個可重用的泛型 composable（`useAsync`）
- 收藏清單以 `localStorage` 手動持久化

## 技術棧

- **Vue 3**（`<script setup lang="ts">` 組合式 API）
- **Pinia**（狀態管理，採 setup store 語法）
- **Vue Router**（路由）
- **axios**（HTTP client）
- **Vite**（開發／建置工具）
- **TypeScript** + **vue-tsc**（型別檢查）

## 安裝與執行

> 注意：本專案需要 **Node 18 以上**（建議 Node 20）。
> 若使用 nvm，請先切換版本：
>
> ```bash
> nvm use 20.19.5
> ```

```bash
# 安裝相依套件
npm install

# 啟動開發伺服器
npm run dev

# 型別檢查（vue-tsc）
npm run type-check

# 建置正式版
npm run build

# 預覽建置結果
npm run preview
```

### 環境變數

複製 `.env.example` 為 `.env.local` 後即可調整 API 位址：

```
VITE_API_BASE_URL=https://jsonplaceholder.typicode.com
```

未設定時，程式會自動 fallback 到上述預設網址。

## 資料夾結構

```
vue-app/
├─ index.html
├─ vite.config.ts
├─ tsconfig.json / tsconfig.app.json / tsconfig.node.json
├─ env.d.ts
├─ .env.example
└─ src/
   ├─ main.ts               # 進入點：建立 app、掛上 Pinia 與 Router
   ├─ App.vue               # 根元件：NavBar + RouterView
   ├─ assets/               # 全域樣式
   ├─ types/                # 領域型別（DTO）與 ApiError
   ├─ api/                  # axios 實例與各資源的 API 函式
   │  ├─ client.ts          #   axios 實例 + 攔截器 + get<T> 輔助函式
   │  ├─ users.ts
   │  └─ posts.ts
   ├─ stores/               # Pinia stores
   │  ├─ users.ts           #   使用者清單／單一使用者
   │  └─ favorites.ts       #   收藏（持久化到 localStorage）
   ├─ composables/          # 可重用的 composable
   │  └─ useAsync.ts
   ├─ router/               # Vue Router 設定
   │  └─ index.ts
   ├─ components/           # 可重用 UI 元件
   │  ├─ NavBar.vue
   │  └─ UserCard.vue
   └─ views/                # 頁面層級元件
      ├─ HomeView.vue
      ├─ UsersView.vue
      └─ UserDetailView.vue
```

## 這個範例示範了哪些 TypeScript 重點

- **型別化的 axios / DTO**：`get<T>()` 泛型輔助函式讓呼叫端直接拿到 `T`（而非
  `AxiosResponse<T>`），並用 `src/types` 的介面描述後端回傳資料。
- **Pinia store 型別推論**：使用 setup store 語法，state / getters / actions
  的型別由 TypeScript 自動推論，無需額外標註。
- **型別化路由參數**：`route.params.id` 的型別是 `string | string[]`，範例中
  示範如何安全地轉成 `number`。
- **`defineProps` / `defineEmits` 泛型**：以型別參數宣告 props 與 emits，
  emits 使用 Vue 3.3+ 的型別字面量簡寫。
- **泛型 composable**：`useAsync<T>` 封裝任意非同步函式，統一管理
  `data / loading / error` 狀態。

## 與 React 版本的差異

本範例的狀態管理使用 **Pinia**；平行開發的 React 姊妹專案則使用 **Zustand**。
兩者的領域型別（`src/types`）與 API 契約完全一致，方便對照兩個生態系的做法。
