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
8. 解釋 React 18 並發渲染解決的問題、render 與 commit 的差異，以及無法解決的阻塞。

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

## 3. React 18 的並發渲染：讓不緊急的更新讓路

### 3.1 解決的問題：輸入不該等整份清單更新完

假設搜尋框每打一次字，都要更新輸入文字、篩選資料並渲染大量項目。
若這些工作一起以不可中斷的方式執行，主執行緒會忙於更新清單，後續按鍵只能等待。
`useMemo` 可以減少重複計算，但關鍵字真的變了，仍需要計算新結果。

React 18 的 concurrent rendering（並發渲染）讓 React 可以依優先順序安排渲染，
把輸入回饋視為緊急更新，將清單結果等工作標記為非緊急。
後者的 render 可以暫停、繼續，也可以在新輸入到來時放棄過時工作並重做。
目標是改善互動回應，即使總工作量沒有減少，也能避免使用者一直等待舊結果。
React 18 的設計背景見 [React v18.0 官方說明](https://react.dev/blog/2022/03/29/react-v18)。

以下是概念時序，實際切分點由 React 決定：

```text
沒有區分優先順序：輸入 a → 完整渲染 a 的結果 → 才能處理下一次輸入 ab
使用並發更新：    輸入 a → 準備 a 的結果 → 讓出執行權 → 處理輸入 ab
                                                        └→ 改為準備 ab 的結果
```

這裡的「背景渲染」仍通常在主執行緒上交錯進行，不是另外開一條執行緒同時跑元件。
React 在可讓出的工作邊界交還執行權；正在執行的某個元件函式或同步迴圈，仍要先執行完。

### 3.2 Render 可以重做，commit 才更新畫面

| 階段 | 做什麼 | 與並發渲染的關係 |
|---|---|---|
| Render | 呼叫元件、計算下一份 UI 與差異 | 非緊急渲染可被中斷或放棄，所以必須保持純粹 |
| Commit | 將準備好的變更套用到 DOM、處理 ref 與 layout effects 等 | DOM 提交不會像 render 那樣分段讓路；大量 DOM 變更仍可能卡頓 |
| Effect setup | 提交後依依賴執行對外同步 | 被放棄的 render 不會執行其 Effect setup |

React 會先準備要提交的 UI，再更新 DOM，不會將一次未完成的渲染隨機套一半到畫面上。
因此不要在元件 render 裡發送訂單、修改外部變數或建立訂閱：這次 render 可能根本沒有提交。
階段區分可參考 [Render and Commit](https://react.dev/learn/render-and-commit)；Effect 與 cleanup 請對照第 7 章。

React 18 網頁專案先使用 `createRoot` 建立根節點（本課專案的 `main.jsx` 已使用）：

```jsx
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(<App />);
```

使用 React 18 並不表示所有更新都自動變成低優先順序；要透過 transition 等功能表達哪些工作可以延後。
同一版加入的 **automatic batching（自動批次更新）** 會將可合併的多次 state 更新集中處理，減少 render 次數；
並發渲染則著重工作順序與可中斷性，兩者解決的問題不同。

### 3.3 `useDeferredValue`：讓清單使用延後的值

輸入框綁最新的 `keyword`，清單使用 `deferredKeyword`。
把昂貴清單獨立成 `memo` 元件，緊急更新時才能在其 props 未變的情況下跳過清單工作：

```jsx
import { memo, useDeferredValue, useMemo, useState } from "react";

const SearchResults = memo(function SearchResults({ allItems, keyword }) {
  const filtered = useMemo(
    () => allItems.filter((item) => item.title.includes(keyword)),
    [allItems, keyword]
  );

  return (
    <ul>
      {filtered.map((item) => <li key={item.id}>{item.title}</li>)}
    </ul>
  );
});

function SearchableList({ allItems }) {
  const [keyword, setKeyword] = useState("");
  const deferredKeyword = useDeferredValue(keyword);
  const isStale = keyword !== deferredKeyword;

  return (
    <>
      <input
        aria-label="搜尋項目"
        value={keyword}
        onChange={(event) => setKeyword(event.target.value)}
      />
      <p role="status">{isStale ? "正在更新結果…" : "結果已更新"}</p>
      <div style={{ opacity: isStale ? 0.6 : 1 }}>
        <SearchResults allItems={allItems} keyword={deferredKeyword} />
      </div>
    </>
  );
}
```

先以最新輸入與舊的延後值渲染；只要 `allItems` 引用也穩定，`SearchResults` 此時可以跳過重渲染。
React 接著嘗試用新關鍵字準備清單，遇到更新的輸入時可以重新安排這份工作。
若父層每次都傳入新建立的陣列，`memo` 就無法靠 props 相等跳過渲染。

它沒有固定延遲毫秒數，也不會保證減少 API 請求。初次渲染沒有舊值可保留，仍要處理初始清單。
大量同步計算仍可能阻塞，不能承諾所有情況都不卡頓。
這些使用條件與 `memo` 的配合方式見 [useDeferredValue 官方 API](https://react.dev/reference/react/useDeferredValue)。

### 3.4 `useTransition`：把指定的 state 更新標成非緊急

當你能控制 setter，可以明確分開「輸入文字」與「用來產生結果的條件」。
以下是在元件內使用的替代寫法，`SearchResults` 沿用上例，不需要再加 `useDeferredValue`：

```jsx
// 此寫法需要從 react 匯入 useState、useTransition
const [input, setInput] = useState("");
const [query, setQuery] = useState("");
const [isPending, startTransition] = useTransition();

function handleChange(event) {
  const nextValue = event.target.value;
  setInput(nextValue); // 控制輸入框的 state 要立即更新
  startTransition(() => {
    setQuery(nextValue); // 結果清單的更新可讓路
  });
}

// JSX：
// <input value={input} onChange={handleChange} />
// <p role="status">{isPending ? "更新中…" : ""}</p>
// <SearchResults allItems={allItems} keyword={query} />
```

`startTransition` 的 callback 會立即執行，標記的是裡面的 state 更新。
若在 callback 裡先跑五秒迴圈再呼叫 setter，那五秒仍會阻塞。
也不要把控制文字輸入的 `setInput` 放進 transition。詳見 [useTransition 官方 API](https://react.dev/reference/react/useTransition)。

本節以 React 18 為基準：transition 標記適用於 callback 同步執行期間的更新，
不要假設 `await` 或 `setTimeout` 之後的 setter 會自動繼承標記；若需要，應在那個更新發生處重新呼叫 `startTransition`。

### 3.5 各種效能工具各解決什麼問題？

| 工具 | 主要用途 | 不能保證的事 |
|---|---|---|
| `memo`／`useMemo` | 輸入未變時，跳過渲染或重用計算 | 新輸入的計算成本會消失 |
| `useTransition` | 標記自己控制的非緊急 state 更新，並提供 `isPending` | callback 的同步程式變成背景執行緒 |
| `useDeferredValue` | 延後消費一個值，保留舊內容供緊急更新使用 | 固定等待時間、減少網路請求 |
| Debounce | 等使用者停止輸入一段時間再執行，例如搜尋請求 | 開始執行後的重工作可以中斷 |
| Web Worker | 將可移轉的 CPU 計算放到其他執行緒 | 直接在 Worker 操作 DOM |
| 清單虛擬化 | 只渲染可見範圍，減少元件與 DOM 數量 | 自動解決所有資料處理成本 |

**理解檢查：**React 18 並發渲染改善的是「昂貴 UI 更新拖慢重要互動」。
能否說明為什麼總渲染時間可能沒變短，但打字體感仍會改善？又為什麼單一長迴圈仍可能造成卡頓？

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
8. 分別以第 3.3、3.4 節實作搜尋頁，在瀏覽器 CPU 降速下連續輸入，比較結果延後與輸入回饋。
9. 暫時移除清單的 `memo`，用 Profiler 觀察緊急更新是否也執行清單；再解釋 debounce 與並發渲染的不同。

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
5. 進一步練習：參考第 3.3 節，把昂貴過濾放進獨立且經 `memo` 包裝的結果元件，傳入 `deferredKeyword`，觀察緊急更新能否跳過該元件；單次同步計算與 DOM 提交仍可能阻塞。

---

## 本章結語

你已完成 React 實戰最關鍵的性能與診斷能力。  
下一章會用測試與部署補上最後一塊拼圖，並以期末專題收斂整套課程。
