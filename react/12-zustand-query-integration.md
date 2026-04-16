# 第 12 章：Zustand 與 Query 整合模式

## 本章目標

完成這一章後，你應該可以：

1. 清楚切分「伺服器狀態」與「本地 UI 狀態」。
2. 用 Zustand 管理篩選條件、選取狀態等本地互動。
3. 用 TanStack Query 管理遠端資料抓取與快取。
4. 透過 `queryKey` 與 store 狀態連動，建立可維護查詢流程。

---

## 1. 狀態分工原則

### 放 TanStack Query

- 後端回來的資料
- loading / error / cache / refetch

### 放 Zustand

- 搜尋關鍵字
- 排序方式
- UI 開關、選取中的項目 id

---

## 2. 整合核心

把 store 內的條件組成 query key：

```jsx
queryKey: ["lessons", filters]
```

當 `filters` 改變時，Query 會自動抓對應資料並快取。

---

## 3. 本章小練習

1. 把 `search / level / sort` 放進 Zustand。
2. 把課程清單資料放進 Query。
3. 點列表項目時把 `selectedLessonId` 放進 Zustand。
4. 右側顯示目前選取課程細節。

---

## 最後範例：可篩選課程探索頁（Zustand + Query）

### `src/store/useLessonFilterStore.js`

```jsx
import { create } from "zustand";

export const useLessonFilterStore = create((set) => ({
  search: "",
  level: "all",
  sort: "title-asc",
  selectedLessonId: null,

  setSearch: (search) => set(() => ({ search })),
  setLevel: (level) => set(() => ({ level })),
  setSort: (sort) => set(() => ({ sort })),
  selectLesson: (id) => set(() => ({ selectedLessonId: id })),
  resetFilters: () =>
    set(() => ({
      search: "",
      level: "all",
      sort: "title-asc",
    })),
}));
```

### `src/api/lessonApi.js`

```jsx
const baseLessons = [
  { id: "r-101", title: "React 基礎", level: "beginner", minutes: 35 },
  { id: "r-201", title: "Router 實戰", level: "intermediate", minutes: 48 },
  { id: "q-101", title: "TanStack Query 入門", level: "intermediate", minutes: 52 },
  { id: "q-201", title: "Query 樂觀更新", level: "advanced", minutes: 60 },
  { id: "z-101", title: "Zustand 狀態切片", level: "advanced", minutes: 45 },
];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchLessons(filters) {
  await delay(350);

  const text = filters.search.trim().toLowerCase();

  let result = baseLessons.filter((lesson) => {
    const matchSearch = !text || lesson.title.toLowerCase().includes(text);
    const matchLevel = filters.level === "all" || lesson.level === filters.level;
    return matchSearch && matchLevel;
  });

  result = [...result].sort((a, b) => {
    if (filters.sort === "title-asc") return a.title.localeCompare(b.title);
    if (filters.sort === "title-desc") return b.title.localeCompare(a.title);
    if (filters.sort === "minutes-asc") return a.minutes - b.minutes;
    return b.minutes - a.minutes;
  });

  return result;
}
```

### `src/hooks/useFilteredLessonsQuery.js`

```jsx
import { useQuery } from "@tanstack/react-query";
import { fetchLessons } from "../api/lessonApi";

export function useFilteredLessonsQuery(filters) {
  return useQuery({
    queryKey: ["lessons", filters],
    queryFn: () => fetchLessons(filters),
    staleTime: 30_000,
  });
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
import { useMemo } from "react";
import { useLessonFilterStore } from "./store/useLessonFilterStore";
import { useFilteredLessonsQuery } from "./hooks/useFilteredLessonsQuery";
import "./App.css";

function App() {
  const search = useLessonFilterStore((state) => state.search);
  const level = useLessonFilterStore((state) => state.level);
  const sort = useLessonFilterStore((state) => state.sort);
  const selectedLessonId = useLessonFilterStore((state) => state.selectedLessonId);
  const setSearch = useLessonFilterStore((state) => state.setSearch);
  const setLevel = useLessonFilterStore((state) => state.setLevel);
  const setSort = useLessonFilterStore((state) => state.setSort);
  const selectLesson = useLessonFilterStore((state) => state.selectLesson);
  const resetFilters = useLessonFilterStore((state) => state.resetFilters);

  const filters = { search, level, sort };
  const lessonsQuery = useFilteredLessonsQuery(filters);

  const selectedLesson = useMemo(() => {
    const list = lessonsQuery.data ?? [];
    return list.find((item) => item.id === selectedLessonId) ?? null;
  }, [lessonsQuery.data, selectedLessonId]);

  return (
    <main className="page">
      <h1>第 12 章最終範例：Zustand + Query 整合</h1>

      <section className="panel toolbar">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜尋課程名稱"
        />
        <select value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="all">all</option>
          <option value="beginner">beginner</option>
          <option value="intermediate">intermediate</option>
          <option value="advanced">advanced</option>
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="title-asc">title asc</option>
          <option value="title-desc">title desc</option>
          <option value="minutes-asc">minutes asc</option>
          <option value="minutes-desc">minutes desc</option>
        </select>
        <button onClick={resetFilters}>重設條件</button>
      </section>

      <div className="layout">
        <section className="panel">
          <h2>課程清單</h2>

          {lessonsQuery.isLoading && <p>載入中...</p>}
          {lessonsQuery.isError && (
            <p className="error">錯誤：{lessonsQuery.error.message}</p>
          )}

          {!lessonsQuery.isLoading && !lessonsQuery.isError && (
            <ul>
              {lessonsQuery.data.map((lesson) => (
                <li
                  key={lesson.id}
                  className={selectedLessonId === lesson.id ? "selected" : ""}
                  onClick={() => selectLesson(lesson.id)}
                >
                  <strong>{lesson.title}</strong>
                  <span>
                    {lesson.level} - {lesson.minutes} 分鐘
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <h2>選取課程詳情</h2>
          {selectedLesson ? (
            <>
              <h3>{selectedLesson.title}</h3>
              <p>難度：{selectedLesson.level}</p>
              <p>時長：{selectedLesson.minutes} 分鐘</p>
            </>
          ) : (
            <p>請從左側清單選擇一門課程。</p>
          )}
        </section>
      </div>
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
  width: min(980px, 100%);
  margin: 24px auto;
  padding: 0 16px 28px;
}

.panel {
  background: #ffffff;
  border-radius: 12px;
  padding: 14px;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.06);
}

.toolbar {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

input,
select {
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 7px 10px;
}

button {
  border: 0;
  border-radius: 8px;
  background: #1d4ed8;
  color: white;
  padding: 7px 12px;
  cursor: pointer;
}

.layout {
  display: grid;
  grid-template-columns: 1.2fr 1fr;
  gap: 12px;
}

ul {
  list-style: none;
  padding: 0;
  margin: 0;
}

li {
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 10px;
  margin-bottom: 8px;
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

li.selected {
  border-color: #1d4ed8;
  background: #eff6ff;
}

.error {
  color: #b91c1c;
}
```

### 範例解釋

1. 篩選條件放在 Zustand，因此不同元件都可共享同一份 UI 狀態。
2. `useFilteredLessonsQuery(filters)` 用 `filters` 作為 `queryKey` 一部分，條件改變就自動抓新資料。
3. Query 只處理遠端資料與快取；Zustand 只處理互動狀態，責任邊界清楚。
4. `selectedLessonId` 放在 store，左側列表與右側詳情天然同步，不需 props 傳遞鏈。

---

## 本章結語

你已具備實務專案常見的資料分層能力。  
下一章收斂到效能與除錯，讓應用在規模成長後仍可維持流暢與可診斷性。
