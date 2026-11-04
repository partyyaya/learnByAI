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

和 `useQuery` 不同，`useMutation` 不會在元件掛載時自動執行，要呼叫它回傳的 `mutate` 才會送出：

```jsx
const createMutation = useMutation({
  mutationFn: createLesson, // 真正打 API 的函式，參數就是 mutate 傳進來的值
});

createMutation.mutate({ title: "新課程", level: "beginner" });
```

常用狀態有 `isPending`（送出中）、`isError`、`error`、`isSuccess`。
網路上 v4 的舊範例會寫 `mutation.isLoading`，v5 的 mutation 已經沒有這個欄位（會拿到 `undefined`），請用 `isPending`。

---

## 2. 樂觀更新是什麼？

「先更新 UI，再等伺服器回覆」，成功就保留、失敗就還原。  
體感會更快，但必須有 rollback 機制。

在 TanStack Query 裡，樂觀更新由 `useMutation` 的三個 callback 分工完成：

| callback | 何時執行 | 要做的事 |
|---|---|---|
| `onMutate` | `mutationFn` 送出之前 | 取消進行中的查詢 → 快照目前快取 → 直接改快取 → 回傳快照 |
| `onError` | API 失敗時 | 用第三個參數拿到 `onMutate` 回傳的快照，寫回快取（rollback） |
| `onSettled` | 成功或失敗之後都會執行 | `invalidateQueries`，讓快取與伺服器重新對齊 |

第一步的 `cancelQueries` 不能省：如果此時剛好有一次重新抓取還在路上，它晚一點回來會把你剛塞進快取的樂觀資料蓋掉。

`invalidateQueries({ queryKey })` 會把符合的查詢標成過期，畫面上正在使用的查詢會立刻重抓。
比對方式是「開頭相同就算」：`["lessons"]` 也會一併失效 `["lessons", { level: "advanced" }]` 這類 key。
v5 一律傳物件參數；v4 舊文章裡的 `invalidateQueries(["lessons"])` 在 v5 不會報錯，但陣列會被當成「沒有任何篩選條件」，結果是所有查詢都失效重抓。

---

## 3. `useInfiniteQuery` 用途

當列表資料量大時，用「分頁載入」比一次全抓更好。  
`useInfiniteQuery` 能管理多頁資料與下一頁參數。

它和 `useQuery` 的差別有三個：

- `initialPageParam`：第一頁的參數，v5 必填（v4 的舊範例常寫成 `queryFn` 參數的預設值）。
- `getNextPageParam(lastPage)`：拿最後一頁的回應算出下一頁參數；回傳 `undefined` 或 `null` 表示沒有下一頁，`hasNextPage` 就會變成 `false`。
- `data` 不是單一陣列，而是 `{ pages, pageParams }`：`pages` 依序放每一頁 `queryFn` 的回傳值，畫面通常用 `data.pages.flatMap(...)` 攤平成一份清單。呼叫 `fetchNextPage()` 會在 `pages` 後面再接一頁。

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
    queryFn: ({ pageParam }) => fetchLessonPage(pageParam),
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
2. `onMutate` 先把新課程插入第一頁快取，實現秒回饋（樂觀更新）。infinite query 的快取是 `{ pages, pageParams }`，所以要用 `...old` 保留 `pageParams`、只替換 `pages[0]`；`if (!old) return old` 則是列表還沒載入過時不去動快取。
3. 若 mutation 失敗，`onError` 用 `previousData` 回滾，避免 UI 假成功。`createLesson` 有 20% 機率失敗，多新增幾次就能看到「（暫存中）」的項目出現後又消失、下方出現錯誤訊息。
4. `onSettled` 統一 `invalidateQueries`，讓資料最終與伺服器狀態一致；暫時 id（`temp-...`）也會在這次重抓後換成伺服器給的正式 id。
5. 同一個 `["lessons-infinite"]` 在範例裡寫了六次，任何一處打錯，快照、回滾或失效就會對到別的快取。實務上會把 key 集中成一個物件，例如 admin-demo 的 `src/hooks/useCoursesQuery.js` 裡的 `courseKeys`。

---

## 本章結語

你已掌握 Query 的進階資料流程與一致性策略。  
下一章會進入 Zustand，處理跨元件共用的本地狀態。
