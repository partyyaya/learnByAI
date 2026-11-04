# 第 9 章：TanStack Query 基礎

## 本章目標

完成這一章後，你應該可以：

1. 在 React 專案中正確初始化 TanStack Query。
2. 用 `useQuery` 取代手寫 `useEffect + loading + error` 模板。
3. 理解 `queryKey`、`queryFn`、`staleTime` 的核心用途。
4. 用快取機制提升資料載入體驗與可維護性。

---

## 1. 為什麼要用 TanStack Query？

在中大型專案中，API 狀態管理很快會變複雜：

- 重複抓取
- 快取失效時機不一致
- loading/error 狀態重複樣板碼

TanStack Query 專門處理這類「伺服器狀態」問題。

---

## 2. 安裝與初始化

```bash
npm install @tanstack/react-query
```

建立 `QueryClient` 並用 `QueryClientProvider` 包住 App。
`queryClient` 就是整個 App 共用的快取，要建立在元件外面（如下方 `main.jsx`）；若寫在元件裡，每次 render 都會換成一份新的空快取。

想直接看到快取內容與資料是否過期，可以另外安裝 `@tanstack/react-query-devtools`，把 `<ReactQueryDevtools />` 放進 `QueryClientProvider` 裡（admin-demo 的 `main.jsx` 就有加）。

---

## 3. `useQuery` 基本結構

```jsx
const lessonsQuery = useQuery({
  queryKey: ["lessons"],
  queryFn: fetchLessons,
  staleTime: 60_000,
});
```

- `queryKey`：快取識別（同 key 共用快取）
- `queryFn`：實際取資料函式，回傳 Promise；丟出錯誤就會進入錯誤狀態
- `staleTime`：資料多久內視為新鮮（單位是毫秒；`60_000` 就是 60000，底線只是方便閱讀）

`queryKey` 也取代了第 7 章的依賴陣列：查詢用到的參數要放進 key，例如 `["todos", userId]`。
`userId` 一變，key 就不同，Query 會改讀（或抓取）另一份快取；晚回來的舊請求只會寫回它自己的 key，不會蓋掉畫面上的新資料，所以不必再手寫 `AbortController` 防競態。

`staleTime` 預設是 `0`，資料一拿到就算「過期（stale）」。過期的資料仍會先從快取顯示，只是在元件重新掛載、視窗重新取得焦點或網路重新連線時，會在背景重抓一次；設成 60 秒，就是告訴 Query 這段時間內不必重抓。
另一個容易混淆的是 `gcTime`（v4 叫 `cacheTime`）：沒有任何元件在使用的快取，預設 5 分鐘後才會被清掉。

> **版本提醒：**v5 的 `useQuery` 只接受一個物件參數。網路上 v4 以前的文章常見 `useQuery(["lessons"], fetchLessons)` 這種寫法，以及 `useQuery` 的 `onSuccess`／`onError` 選項，在 v5 都已移除。

---

## 4. 常用狀態

- `isPending`：還沒有任何資料可顯示
- `isLoading`：第一次請求正在進行中（等於 `isPending && isFetching`）
- `isFetching`：任何一次請求正在進行中，包含已有資料後的背景重抓
- `isError`：請求失敗
- `data`：成功資料
- `refetch`：手動重抓（不看 `staleTime`，一定會發出請求）

> **v4 → v5 的命名差異：**v4 的 `isLoading` 在 v5 改名為 `isPending`，v5 的 `isLoading` 則是「沒有資料而且正在抓」。本章的查詢一掛載就會發請求，用 `isLoading` 判斷首次載入即可；若查詢可能被暫停或停用（例如離線、`enabled: false`），要判斷「還沒有資料」請改用 `isPending`。

---

## 5. 本章小練習

1. 把原本 `useEffect` 抓資料改成 `useQuery`。
2. 加入 `staleTime`，避免頻繁重抓。
3. 新增手動重新整理按鈕（`refetch`）。
4. 加入關鍵字過濾（本地過濾即可）。

---

## 最後範例：課程列表查詢（TanStack Query 版）

### `src/main.jsx`

```jsx
import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import "./App.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
);
```

### `src/api/lessonApi.js`

```jsx
export async function fetchLessons() {
  const response = await fetch("https://jsonplaceholder.typicode.com/posts?_limit=12");
  if (!response.ok) {
    throw new Error("取得課程資料失敗");
  }

  const posts = await response.json();
  return posts.map((post) => ({
    id: post.id,
    title: post.title,
    summary: post.body,
  }));
}
```

這裡借用 JSONPlaceholder 的 `posts` 假資料轉成課程格式；標題是拉丁文假字，測試篩選時請輸入英文（例如 `qui`）。

### `src/hooks/useLessonsQuery.js`

```jsx
import { useQuery } from "@tanstack/react-query";
import { fetchLessons } from "../api/lessonApi";

export function useLessonsQuery() {
  return useQuery({
    queryKey: ["lessons"],
    queryFn: fetchLessons,
    staleTime: 60_000,
  });
}
```

### `src/App.jsx`

```jsx
import { useState } from "react";
import { useLessonsQuery } from "./hooks/useLessonsQuery";
import "./App.css";

function App() {
  const [keyword, setKeyword] = useState("");
  const lessonsQuery = useLessonsQuery();

  const lessons = lessonsQuery.data ?? [];
  const text = keyword.trim().toLowerCase();
  const filteredLessons = text
    ? lessons.filter((lesson) => lesson.title.toLowerCase().includes(text))
    : lessons;

  return (
    <main className="page">
      <h1>第 9 章最終範例：TanStack Query 基礎</h1>

      <section className="card">
        <div className="toolbar">
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="輸入關鍵字篩選課程標題"
          />
          <button
            onClick={() => lessonsQuery.refetch()}
            disabled={lessonsQuery.isFetching}
          >
            {lessonsQuery.isFetching ? "抓取中..." : "手動重新抓取"}
          </button>
        </div>

        {lessonsQuery.isLoading && <p>資料載入中...</p>}
        {lessonsQuery.isError && (
          <p className="error">錯誤：{lessonsQuery.error.message}</p>
        )}

        {!lessonsQuery.isLoading && !lessonsQuery.isError && (
          <>
            <p>
              共 {filteredLessons.length} 筆資料（快取 key：<code>{'["lessons"]'}</code>）
            </p>
            <ul>
              {filteredLessons.map((lesson) => (
                <li key={lesson.id}>
                  <strong>{lesson.title}</strong>
                  <p>{lesson.summary}</p>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </main>
  );
}

export default App;
```

### `src/App.css`

```css
body {
  margin: 0;
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #f1f5f9;
}

.page {
  width: min(860px, 100%);
  margin: 26px auto;
  padding: 0 16px 28px;
}

.card {
  background: #ffffff;
  border-radius: 12px;
  padding: 16px;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.07);
}

.toolbar {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}

input {
  flex: 1;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 8px 10px;
}

button {
  border: 0;
  border-radius: 8px;
  background: #0f172a;
  color: white;
  padding: 8px 12px;
  cursor: pointer;
}

ul {
  padding-left: 18px;
}

li {
  margin-bottom: 10px;
}

li p {
  margin: 4px 0 0;
  color: #334155;
}

.error {
  color: #b91c1c;
}
```

### 範例解釋

1. `QueryClientProvider` 把查詢快取能力提供給整個 React 樹。
2. `useLessonsQuery` 把資料邏輯封裝成 hook，讓頁面元件更乾淨。
3. `queryKey: ["lessons"]` 是快取索引，頁面重訪時可直接命中快取。
4. `staleTime` 設為 60 秒，元件在 60 秒內重新掛載（例如切頁回來）時直接用快取、不重抓；元件單純 re-render 本來就不會觸發請求。
5. `main.jsx` 的 `defaultOptions` 是所有查詢的預設值：`retry: 1` 讓失敗只重試一次（預設重試 3 次，錯誤訊息要等比較久才出現），`refetchOnWindowFocus: false` 關掉切回分頁時的自動重抓。個別 `useQuery` 傳入的選項會覆蓋預設值，這裡兩邊都寫 60 秒只是為了示範。
6. 按下按鈕時資料已在畫面上，所以 `isLoading` 不會變成 `true`；要顯示「抓取中」得看 `isFetching`。

---

## 本章結語

你已完成 TanStack Query 的核心基礎。  
下一章會進入 mutation、樂觀更新與進階列表載入策略。
