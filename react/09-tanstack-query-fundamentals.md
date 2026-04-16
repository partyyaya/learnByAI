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
- `queryFn`：實際取資料函式
- `staleTime`：資料多久內視為新鮮

---

## 4. 常用狀態

- `isLoading`: 首次載入中
- `isError`: 請求失敗
- `data`: 成功資料
- `refetch`: 手動重抓

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
import { useMemo, useState } from "react";
import { useLessonsQuery } from "./hooks/useLessonsQuery";
import "./App.css";

function App() {
  const [keyword, setKeyword] = useState("");
  const lessonsQuery = useLessonsQuery();

  const filteredLessons = useMemo(() => {
    const lessons = lessonsQuery.data ?? [];
    const text = keyword.trim().toLowerCase();
    if (!text) return lessons;
    return lessons.filter((lesson) => lesson.title.toLowerCase().includes(text));
  }, [lessonsQuery.data, keyword]);

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
          <button onClick={() => lessonsQuery.refetch()}>手動重新抓取</button>
        </div>

        {lessonsQuery.isLoading && <p>資料載入中...</p>}
        {lessonsQuery.isError && (
          <p className="error">錯誤：{lessonsQuery.error.message}</p>
        )}

        {!lessonsQuery.isLoading && !lessonsQuery.isError && (
          <>
            <p>共 {filteredLessons.length} 筆資料（快取 key：`["lessons"]`）</p>
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
4. `staleTime` 設為 60 秒，避免切頁或 re-render 造成不必要重抓。

---

## 本章結語

你已完成 TanStack Query 的核心基礎。  
下一章會進入 mutation、樂觀更新與進階列表載入策略。
