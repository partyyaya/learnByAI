# 第 13 章：效能優化與除錯

## 本章目標

完成這一章後，你應該可以：

1. 判斷何時該做 React 效能優化、何時不需要。
2. 使用 `React.memo`、`useMemo`、`useCallback` 降低不必要重渲染。
3. 透過開發期工具定位效能瓶頸與渲染熱點。
4. 建立可重複的除錯與性能檢查流程。
5. 用 `React.lazy` 做路由層級的 code splitting。
6. 用 Error Boundary 防止單一元件錯誤癱瘓整頁。
7. 用 `useDeferredValue` 讓大量渲染時輸入框仍然順暢。

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

## 3. `useDeferredValue`：大量渲染時保持輸入順暢

`useMemo` 快取的是「計算結果」，但如果「計算 + 渲染」本身就很重（例如打字即時過濾上千筆並渲染），每敲一個字畫面仍會頓一下——因為 React 得先算完、渲染完，才輪到處理下一個按鍵。

`useDeferredValue` 讓你把「不急的那份值」延後：輸入框綁最新值（永遠跟手），清單吃延後值（React 有空再更新）。

```jsx
import { useDeferredValue, useMemo, useState } from "react";

function SearchableList({ allItems }) {
  const [keyword, setKeyword] = useState("");
  const deferredKeyword = useDeferredValue(keyword); // 延後版的關鍵字

  const filtered = useMemo(
    () => allItems.filter((item) => item.title.includes(deferredKeyword)),
    [allItems, deferredKeyword]
  );

  return (
    <>
      {/* 輸入框綁「即時」的 keyword，打字永遠跟手 */}
      <input value={keyword} onChange={(e) => setKeyword(e.target.value)} />
      {/* 清單吃「延後」的結果，落後一點點沒關係 */}
      <ul>
        {filtered.map((item) => (
          <li key={item.id}>{item.title}</li>
        ))}
      </ul>
    </>
  );
}
```

- 輸入框永遠即時回應，消除打字卡頓的體感。
- `deferredKeyword` 會「慢半拍」跟上，重的過濾與渲染都掛在它身上。
- 想在延後期間顯示「更新中」的視覺，可用 `keyword !== deferredKeyword` 判斷。

如果你要延後的是「一段操作」而不是「一個值」（例如切換分頁、送出篩選），用它的姊妹 API `useTransition`：

```jsx
const [isPending, startTransition] = useTransition();
startTransition(() => setTab(nextTab)); // 標記成「非緊急」更新，isPending 可拿來顯示 loading
```

> 判斷準則：**`useMemo` 省掉「重複計算」；`useDeferredValue` / `useTransition` 則是把「不緊急的更新」讓路給使用者輸入。兩者常常一起用。**

---

## 4. 除錯重點清單

1. 資料是否重複來源（同資料被兩份 state 管理）
2. effect 是否缺依賴或依賴過多
3. key 是否穩定（避免 list 重建）
4. 是否有同步阻塞計算卡住主執行緒

---

## 5. Code Splitting：`React.lazy` 與 `Suspense`

預設情況下，Vite 會把所有頁面打包成一包 JS，首頁載入時「連沒去過的頁面」也一起下載。  
搭配 React Router 時，用 `React.lazy` 把頁面改成「進入時才載入」：

```jsx
import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";

// 靜態 import 改成動態 import，Vite 會自動拆包
const CoursesPage = lazy(() => import("./pages/CoursesPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));

function App() {
  return (
    <Suspense fallback={<p>頁面載入中...</p>}>
      <Routes>
        <Route path="/courses" element={<CoursesPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </Suspense>
  );
}
```

- `lazy()` 讓該頁面變成獨立 chunk，首次進入該路由才下載。
- `Suspense fallback` 是下載期間顯示的過渡畫面。
- 建議以「路由頁面」為切分單位，不要細到每個小元件都 lazy。

執行 `npm run build` 可以在輸出看到多個 chunk 檔案，驗證拆包是否生效。

---

## 6. Error Boundary：不讓一個元件炸掉整頁

React 元件在渲染時拋出錯誤，預設會讓**整個畫面變成空白**。  
Error Boundary 可以把錯誤攔在區塊內，顯示友善的錯誤畫面。

目前官方 API 仍需要 class 元件（這是課程中唯一會看到 class 的地方），
實務上通常直接抄這個樣板，或使用 `react-error-boundary` 套件：

```jsx
import { Component } from "react";

class ErrorBoundary extends Component {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error("ErrorBoundary 捕捉到錯誤：", error, info);
  }

  render() {
    if (this.state.hasError) {
      return <p className="error">這個區塊發生錯誤，請重新整理或稍後再試。</p>;
    }
    return this.props.children;
  }
}
```

使用方式——包在容易出錯的區塊外層：

```jsx
<ErrorBoundary>
  <LessonList lessons={lessons} />
</ErrorBoundary>
```

注意：Error Boundary 只攔「渲染期間」的錯誤；  
事件處理器與 API 錯誤仍要用 `try/catch` 或 Query 的 `isError` 處理。

---

## 7. 本章小練習

1. 建立一個 2000 筆列表篩選頁。
2. 先做無優化版本，觀察輸入延遲。
3. 套用 `useMemo` 與 `React.memo`，比較差異。
4. 把關鍵字改用 `useDeferredValue`，比較打字時的順暢度差異。
5. 用 Profiler 記錄優化前後。
6. 把任兩個頁面改成 `React.lazy` 載入，用 `npm run build` 的輸出驗證拆包。
7. 寫一個會在渲染時故意丟錯的元件，用 Error Boundary 攔住它。

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
5. 進一步練習：把 `keyword` 包一層 `useDeferredValue`，讓過濾吃延後值，打字會更跟手（見本章第 3 節）。

---

## 本章結語

你已完成 React 實戰最關鍵的性能與診斷能力。  
下一章會用測試與部署補上最後一塊拼圖，並以期末專題收斂整套課程。
