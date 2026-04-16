# 第 10 章：TanStack Query 進階實戰

## 本章目標

完成這一章後，你應該可以：

1. 使用 `useMutation` 處理新增/更新等寫入操作。
2. 實作樂觀更新（Optimistic Update）與失敗回滾（Rollback）。
3. 使用 `useInfiniteQuery` 做「載入更多」列表。
4. 理解查詢失效（invalidate）與重新同步資料流程。

---

## 1. `useMutation` 的角色

`useQuery` 是讀取資料；`useMutation` 是改動資料。  
常見 mutation 情境：

- 新增課程
- 編輯標題
- 切換發布狀態
- 刪除資料

---

## 2. 樂觀更新是什麼？

「先更新 UI，再等伺服器回覆」，成功就保留、失敗就還原。  
體感會更快，但必須有 rollback 機制。

---

## 3. `useInfiniteQuery` 用途

當列表資料量大時，用「分頁載入」比一次全抓更好。  
`useInfiniteQuery` 能管理多頁資料與下一頁參數。

---

## 4. 本章小練習

1. 建立可分頁載入的課程列表。
2. 新增課程時先做樂觀更新。
3. 若 API 失敗，回滾成 mutation 前的列表。
4. 成功後 invalidate 查詢，與伺服器資料重新對齊。

---

## 最後範例：Infinite Query + 樂觀新增

### `src/api/mockLessonApi.js`

```jsx
const PAGE_SIZE = 5;

let mockDb = Array.from({ length: 18 }, (_, index) => ({
  id: index + 1,
  title: `React 章節範例 #${index + 1}`,
  level: index % 3 === 0 ? "advanced" : index % 2 === 0 ? "intermediate" : "beginner",
  published: index % 4 !== 0,
}));

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchLessonPage(page) {
  await delay(400);

  const start = (page - 1) * PAGE_SIZE;
  const end = start + PAGE_SIZE;
  const items = mockDb.slice(start, end);
  const nextPage = end < mockDb.length ? page + 1 : null;

  return {
    items,
    nextPage,
  };
}

export async function createLesson(input) {
  await delay(500);

  // 模擬偶發失敗，觀察 rollback
  if (Math.random() < 0.2) {
    throw new Error("伺服器忙碌中，請稍後再試");
  }

  const newLesson = {
    id: Date.now(),
    title: input.title,
    level: input.level,
    published: false,
  };

  mockDb = [newLesson, ...mockDb];
  return newLesson;
}
```

### `src/main.jsx`

```jsx
import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import "./App.css";

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
);
```

### `src/App.jsx`

```jsx
import { useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { createLesson, fetchLessonPage } from "./api/mockLessonApi";
import "./App.css";

function App() {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [level, setLevel] = useState("beginner");

  const lessonsQuery = useInfiniteQuery({
    queryKey: ["lessons-infinite"],
    queryFn: ({ pageParam = 1 }) => fetchLessonPage(pageParam),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => lastPage.nextPage,
  });

  const createMutation = useMutation({
    mutationFn: createLesson,
    onMutate: async (newLessonInput) => {
      await queryClient.cancelQueries({ queryKey: ["lessons-infinite"] });

      const previousData = queryClient.getQueryData(["lessons-infinite"]);

      queryClient.setQueryData(["lessons-infinite"], (old) => {
        if (!old) return old;
        const optimisticLesson = {
          id: `temp-${Date.now()}`,
          title: newLessonInput.title,
          level: newLessonInput.level,
          published: false,
          optimistic: true,
        };

        const firstPage = old.pages[0];
        return {
          ...old,
          pages: [
            { ...firstPage, items: [optimisticLesson, ...firstPage.items] },
            ...old.pages.slice(1),
          ],
        };
      });

      return { previousData };
    },
    onError: (_error, _variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(["lessons-infinite"], context.previousData);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["lessons-infinite"] });
    },
  });

  function handleCreate(event) {
    event.preventDefault();
    const clean = title.trim();
    if (!clean) return;

    createMutation.mutate({
      title: clean,
      level,
    });

    setTitle("");
    setLevel("beginner");
  }

  const allLessons = lessonsQuery.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <main className="page">
      <h1>第 10 章最終範例：TanStack Query 進階</h1>

      <section className="card">
        <h2>新增課程（Optimistic Update）</h2>
        <form onSubmit={handleCreate} className="row">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="輸入新課程標題"
          />
          <select value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="beginner">beginner</option>
            <option value="intermediate">intermediate</option>
            <option value="advanced">advanced</option>
          </select>
          <button type="submit" disabled={createMutation.isPending}>
            {createMutation.isPending ? "送出中..." : "新增"}
          </button>
        </form>
        {createMutation.isError && (
          <p className="error">{createMutation.error.message}</p>
        )}
      </section>

      <section className="card">
        <h2>課程列表（Infinite Query）</h2>

        {lessonsQuery.isLoading && <p>載入中...</p>}
        {lessonsQuery.isError && (
          <p className="error">列表載入失敗：{lessonsQuery.error.message}</p>
        )}

        {!lessonsQuery.isLoading && !lessonsQuery.isError && (
          <>
            <ul>
              {allLessons.map((lesson) => (
                <li key={lesson.id}>
                  <strong>{lesson.title}</strong> - {lesson.level}
                  {lesson.optimistic && <em>（暫存中）</em>}
                </li>
              ))}
            </ul>

            <button
              onClick={() => lessonsQuery.fetchNextPage()}
              disabled={!lessonsQuery.hasNextPage || lessonsQuery.isFetchingNextPage}
            >
              {lessonsQuery.isFetchingNextPage
                ? "載入下一頁..."
                : lessonsQuery.hasNextPage
                ? "載入更多"
                : "沒有更多資料"}
            </button>
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
  background: #eef2ff;
}

.page {
  width: min(860px, 100%);
  margin: 24px auto;
  padding: 0 16px 30px;
}

.card {
  background: #ffffff;
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 12px;
  box-shadow: 0 8px 20px rgba(30, 41, 59, 0.08);
}

.row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

input,
select {
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 8px 10px;
}

input {
  flex: 1;
}

button {
  border: 0;
  border-radius: 8px;
  background: #1d4ed8;
  color: #ffffff;
  padding: 8px 12px;
  cursor: pointer;
}

button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

ul {
  padding-left: 18px;
}

li {
  margin-bottom: 8px;
}

em {
  margin-left: 6px;
  color: #9a3412;
}

.error {
  color: #b91c1c;
}
```

### 範例解釋

1. `useInfiniteQuery` 用 `pageParam` 與 `getNextPageParam` 管理「載入更多」流程。
2. `onMutate` 先把新課程插入第一頁快取，實現秒回饋（樂觀更新）。
3. 若 mutation 失敗，`onError` 用 `previousData` 回滾，避免 UI 假成功。
4. `onSettled` 統一 `invalidateQueries`，讓資料最終與伺服器狀態一致。

---

## 本章結語

你已掌握 Query 的進階資料流程與一致性策略。  
下一章會進入 Zustand，處理跨元件共用的本地狀態。
