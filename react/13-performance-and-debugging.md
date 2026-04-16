# 第 13 章：效能優化與除錯

## 本章目標

完成這一章後，你應該可以：

1. 判斷何時該做 React 效能優化、何時不需要。
2. 使用 `React.memo`、`useMemo`、`useCallback` 降低不必要重渲染。
3. 透過開發期工具定位效能瓶頸與渲染熱點。
4. 建立可重複的除錯與性能檢查流程。

---

## 1. 優化前先量測

不要一開始就到處加 `memo`。  
先找出真正慢的地方，再針對性處理。

建議順序：

1. 先確認是否有體感卡頓
2. 用 React DevTools Profiler 觀察重渲染熱點
3. 再決定是否需要 `memo / useMemo / useCallback`

---

## 2. 三個常見優化工具

### `React.memo`

避免 props 沒變時重渲染子元件。

### `useMemo`

快取昂貴計算結果（例如大量清單篩選）。

### `useCallback`

快取函式引用，避免每次 render 產生新函式導致 memo 失效。

---

## 3. 除錯重點清單

1. 資料是否重複來源（同資料被兩份 state 管理）
2. effect 是否缺依賴或依賴過多
3. key 是否穩定（避免 list 重建）
4. 是否有同步阻塞計算卡住主執行緒

---

## 4. 本章小練習

1. 建立一個 2000 筆列表篩選頁。
2. 先做無優化版本，觀察輸入延遲。
3. 套用 `useMemo` 與 `React.memo`，比較差異。
4. 用 Profiler 記錄優化前後。

---

## 最後範例：可優化的大型列表篩選器

### `src/App.jsx`

```jsx
import { memo, useCallback, useMemo, useState } from "react";
import "./App.css";

const allLessons = Array.from({ length: 2000 }, (_, index) => ({
  id: index + 1,
  title: `Lesson ${index + 1} - React Performance`,
  level: index % 3 === 0 ? "advanced" : index % 2 === 0 ? "intermediate" : "beginner",
  minutes: 15 + (index % 50),
}));

function expensiveFilter(list, keyword, level) {
  const text = keyword.trim().toLowerCase();
  // 模擬昂貴計算，方便觀察 useMemo 價值
  let cost = 0;
  for (let i = 0; i < 200000; i += 1) {
    cost += i;
  }
  if (cost < 0) console.log("never happen");

  return list.filter((lesson) => {
    const matchText = !text || lesson.title.toLowerCase().includes(text);
    const matchLevel = level === "all" || lesson.level === level;
    return matchText && matchLevel;
  });
}

const LessonList = memo(function LessonList({ lessons, onBookmark, bookmarkedIds }) {
  return (
    <ul>
      {lessons.slice(0, 120).map((lesson) => (
        <li key={lesson.id}>
          <span>
            {lesson.title} ({lesson.level})
          </span>
          <button onClick={() => onBookmark(lesson.id)}>
            {bookmarkedIds.includes(lesson.id) ? "已收藏" : "收藏"}
          </button>
        </li>
      ))}
    </ul>
  );
});

function App() {
  const [keyword, setKeyword] = useState("");
  const [level, setLevel] = useState("all");
  const [theme, setTheme] = useState("light");
  const [bookmarkedIds, setBookmarkedIds] = useState([]);

  const filteredLessons = useMemo(
    () => expensiveFilter(allLessons, keyword, level),
    [keyword, level]
  );

  const handleBookmark = useCallback((lessonId) => {
    setBookmarkedIds((prev) =>
      prev.includes(lessonId)
        ? prev.filter((id) => id !== lessonId)
        : [...prev, lessonId]
    );
  }, []);

  return (
    <main className={`page ${theme}`}>
      <header className="toolbar">
        <h1>第 13 章最終範例：效能優化與除錯</h1>
        <button
          onClick={() => setTheme((prev) => (prev === "light" ? "dark" : "light"))}
        >
          切換主題（測試無關狀態變更）
        </button>
      </header>

      <section className="panel filters">
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜尋課程關鍵字"
        />
        <select value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="all">all</option>
          <option value="beginner">beginner</option>
          <option value="intermediate">intermediate</option>
          <option value="advanced">advanced</option>
        </select>
      </section>

      <section className="panel">
        <p>
          篩選結果：{filteredLessons.length} 筆（畫面僅渲染前 120 筆，避免 DOM 過重）
        </p>
        <LessonList
          lessons={filteredLessons}
          onBookmark={handleBookmark}
          bookmarkedIds={bookmarkedIds}
        />
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
}

.page {
  min-height: 100vh;
  padding: 18px;
}

.page.light {
  background: #f8fafc;
  color: #0f172a;
}

.page.dark {
  background: #0f172a;
  color: #e2e8f0;
}

.toolbar {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.panel {
  background: rgba(255, 255, 255, 0.9);
  color: #0f172a;
  border-radius: 12px;
  padding: 12px;
  margin-top: 12px;
}

.filters {
  display: flex;
  gap: 8px;
}

input,
select {
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 8px 10px;
}

button {
  border: 0;
  border-radius: 8px;
  background: #1d4ed8;
  color: #ffffff;
  padding: 7px 11px;
  cursor: pointer;
}

ul {
  list-style: none;
  padding: 0;
  margin: 0;
}

li {
  border-bottom: 1px solid #e2e8f0;
  padding: 8px 0;
  display: flex;
  justify-content: space-between;
  gap: 10px;
}
```

### 範例解釋

1. `expensiveFilter` 模擬高成本計算，`useMemo` 只在 `keyword/level` 改變時重算。
2. `LessonList` 用 `React.memo` 包起來，避免父層無關狀態（如 theme）變更時重渲染。
3. `handleBookmark` 用 `useCallback` 固定引用，避免函式變動造成 memo 失效。
4. 篩選結果只渲染前 120 筆，示範「計算優化 + DOM 數量控制」雙管齊下。

---

## 本章結語

你已完成 React 實戰最關鍵的性能與診斷能力。  
下一章（第 14 章）即可銜接測試、部署與期末專題收斂。
