# 第 4 章：Props 與元件溝通

## 本章目標

完成這一章後，你應該可以：

1. 清楚區分 `props` 與 `state` 的角色。
2. 用 `props` 做父元件到子元件的資料傳遞。
3. 用 callback function 讓子元件通知父元件。
4. 在中小型頁面中維持清楚、可預測的單向資料流。
5. 知道何時該用 `Context` 解決 props drilling。

---

## 1. Props 是什麼？

`props` 是父元件傳給子元件的參數，通常用來：

- 傳資料（字串、數字、物件、陣列）
- 傳行為（函式）
- 傳設定（布林值、顯示模式）

重點是：

> 子元件不應直接修改 props，props 是唯讀資料。

---

## 2. 單向資料流（One-way Data Flow）

React 的推薦模式是：

`父元件 state -> 透過 props 傳給子元件 -> 子元件觸發事件回報父元件`

這樣做有兩個好處：

1. 狀態來源清楚（知道誰擁有資料）。
2. 問題容易追蹤（資料流方向固定）。

---

## 3. `children`：元件組合的核心

當你想讓元件可重用，又不想把內容寫死時，`children` 很重要。

```jsx
function Panel({ title, children }) {
  return (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  );
}
```

`Panel` 可以裝不同內容，維持一致外觀但不綁定特定業務邏輯。

---

## 4. 子傳父：用 callback 回報事件

例如子元件要改變篩選條件：

```jsx
function Filter({ onChangeLevel }) {
  return <button onClick={() => onChangeLevel("beginner")}>Beginner</button>;
}
```

這不是「子元件改父元件」，而是子元件通知父元件「請你更新 state」。

---

## 5. Props Drilling 與 Context

當一份資料要跨越很多層元件（例如「目前登入者」要從 `App` 傳到第五層的按鈕），
每一層都得幫忙轉傳 props，這叫 **props drilling**。

React 內建的 `Context` 可以解決這個問題：

```jsx
import { createContext, useContext } from "react";

// 1) 建立 Context
const UserContext = createContext(null);

// 2) 在上層提供資料
function App() {
  const user = { name: "Gary", role: "admin" };
  return (
    <UserContext.Provider value={user}>
      <Dashboard />
    </UserContext.Provider>
  );
}

// 3) 在任意深度的子元件直接取用，中間層不需轉傳
function UserBadge() {
  const user = useContext(UserContext);
  return <span>{user.name}（{user.role}）</span>;
}
```

三種傳遞方式怎麼選：

| 方式 | 適合情境 |
|------|----------|
| Props | 預設選擇；一兩層內的資料傳遞，資料流最清楚 |
| Context | 很少變動、但很多元件都要讀的資料（主題、語系、登入者） |
| Zustand（第 11 章） | 常變動、跨頁共用、還需要 actions 的全域狀態 |

注意：Context 的 `value` 一變，所有讀取它的元件都會重新渲染，
所以**頻繁變動的互動狀態不適合塞進 Context**——這也是第 11 章引入 Zustand 的原因。

---

## 6. 常見誤區

1. 在子元件直接改 props（錯）。
2. 過度巢狀傳 props（可考慮 Context 或 Zustand）。
3. 元件責任混亂（同時負責資料、顯示、流程控制）。
4. 什麼都塞進 Context（頻繁變動的狀態會造成大範圍重渲染）。

---

## 7. 本章小練習

1. 做一個等級篩選器（All / Beginner / Intermediate / Advanced）。
2. 篩選器按鈕放在子元件，篩選狀態放在父元件。
3. 顯示課程總數與已發布數量。
4. 將區塊外框抽成 `Panel` 元件，使用 `children` 包內容。

---

## 最後範例：課程篩選面板（Props + Callback + Children）

### `src/App.jsx`

```jsx
import { useMemo, useState } from "react";
import CourseSummary from "./components/CourseSummary";
import LessonList from "./components/LessonList";
import LevelFilter from "./components/LevelFilter";
import Panel from "./components/Panel";
import "./App.css";

const lessonData = [
  { id: "r-101", title: "React 心智模型", level: "beginner", minutes: 35, published: true },
  { id: "r-102", title: "JSX 與元件拆分", level: "beginner", minutes: 42, published: true },
  { id: "r-201", title: "Router 路由基礎", level: "intermediate", minutes: 50, published: false },
  { id: "r-202", title: "Query 快取策略", level: "intermediate", minutes: 55, published: true },
  { id: "r-301", title: "效能與 Profiler", level: "advanced", minutes: 60, published: false },
];

function App() {
  const [activeLevel, setActiveLevel] = useState("all");

  const filteredLessons = useMemo(() => {
    if (activeLevel === "all") return lessonData;
    return lessonData.filter((lesson) => lesson.level === activeLevel);
  }, [activeLevel]);

  const publishedCount = filteredLessons.filter((lesson) => lesson.published).length;

  return (
    <main className="page">
      <h1>第 4 章最終範例：Props 與元件溝通</h1>

      <Panel title="課程篩選">
        <LevelFilter activeLevel={activeLevel} onChangeLevel={setActiveLevel} />
      </Panel>

      <Panel title="統計資訊">
        <CourseSummary
          totalCount={filteredLessons.length}
          publishedCount={publishedCount}
          activeLevel={activeLevel}
        />
      </Panel>

      <Panel title="課程清單">
        <LessonList lessons={filteredLessons} />
      </Panel>
    </main>
  );
}

export default App;
```

### `src/components/Panel.jsx`

```jsx
function Panel({ title, children }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      <div>{children}</div>
    </section>
  );
}

export default Panel;
```

### `src/components/LevelFilter.jsx`

```jsx
const levels = [
  { label: "All", value: "all" },
  { label: "Beginner", value: "beginner" },
  { label: "Intermediate", value: "intermediate" },
  { label: "Advanced", value: "advanced" },
];

function LevelFilter({ activeLevel, onChangeLevel }) {
  return (
    <div className="button-group">
      {levels.map((level) => (
        <button
          key={level.value}
          className={activeLevel === level.value ? "active" : ""}
          onClick={() => onChangeLevel(level.value)}
        >
          {level.label}
        </button>
      ))}
    </div>
  );
}

export default LevelFilter;
```

### `src/components/CourseSummary.jsx`

```jsx
function CourseSummary({ totalCount, publishedCount, activeLevel }) {
  return (
    <div className="summary">
      <p>目前篩選等級：{activeLevel}</p>
      <p>課程總數：{totalCount}</p>
      <p>已發布：{publishedCount}</p>
    </div>
  );
}

export default CourseSummary;
```

### `src/components/LessonList.jsx`

```jsx
function LessonList({ lessons }) {
  if (lessons.length === 0) {
    return <p>目前篩選條件沒有符合的課程。</p>;
  }

  return (
    <ul className="lesson-list">
      {lessons.map((lesson) => (
        <li key={lesson.id}>
          <strong>{lesson.title}</strong> - {lesson.level} - {lesson.minutes} 分鐘
          <span className={lesson.published ? "ok" : "draft"}>
            {lesson.published ? "已發布" : "草稿"}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default LessonList;
```

### `src/App.css`

```css
body {
  margin: 0;
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #f3f4f6;
  color: #111827;
}

.page {
  width: min(920px, 100%);
  margin: 32px auto;
  padding: 0 16px 32px;
}

.panel {
  background: #ffffff;
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 14px;
  box-shadow: 0 8px 20px rgba(17, 24, 39, 0.06);
}

.button-group {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

button {
  border: 1px solid #d1d5db;
  background: white;
  border-radius: 999px;
  padding: 6px 12px;
  cursor: pointer;
}

button.active {
  background: #2563eb;
  color: white;
  border-color: #2563eb;
}

.lesson-list {
  padding-left: 18px;
  margin: 0;
}

.lesson-list li {
  margin-bottom: 8px;
}

.ok {
  margin-left: 8px;
  color: #166534;
}

.draft {
  margin-left: 8px;
  color: #991b1b;
}
```

### 範例解釋

1. `App` 擁有篩選狀態 `activeLevel`，因此它是資料的單一來源（single source of truth）。
2. `LevelFilter` 不持有篩選 state，只透過 `onChangeLevel` 通知父元件更新。
3. `CourseSummary` 與 `LessonList` 都是純展示元件，根據 props 呈現結果。
4. `Panel` 透過 `children` 把布局邏輯抽離，讓各區塊可重用且一致。

---

## 本章結語

你已經掌握 React 元件間最核心的溝通方式。  
下一章會在這個基礎上，進一步用 `state` 與事件處理建立互動流程。
