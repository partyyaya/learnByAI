# 第 5 章：State 與事件處理

## 本章目標

完成這一章後，你應該可以：

1. 正確使用 `useState` 管理互動狀態。
2. 撰寫表單、按鈕、清單常見事件處理器。
3. 使用不可變更新方式操作陣列與物件 state。
4. 做出可新增、切換、刪除的互動列表。
5. 分辨 `useState` 與 `useRef` 的使用時機。

---

## 1. State 是元件的記憶

當資料會因使用者操作而改變，就應該放進 state：

- 輸入框內容
- 清單資料
- 是否完成、是否展開、是否顯示

React 透過 state 更新觸發重新渲染。

---

## 2. `useState` 基本用法

```jsx
const [count, setCount] = useState(0);
```

- `count`：當前狀態值
- `setCount`：更新狀態的函式

更新可直接給值，也可傳函式：

```jsx
setCount((prev) => prev + 1);
```

在依賴舊值時，優先使用函式寫法。

---

## 3. 事件處理常見模式

```jsx
function handleClick() {
  // 做事
}

<button onClick={handleClick}>點我</button>;
```

不要直接呼叫函式：

```jsx
// 錯誤：onClick={handleClick()}
// 正確：
<button onClick={handleClick}>點我</button>;
```

---

## 4. 陣列 state 的不可變更新

新增資料：

```jsx
setItems((prev) => [...prev, newItem]);
```

切換資料：

```jsx
setItems((prev) =>
  prev.map((item) =>
    item.id === targetId ? { ...item, done: !item.done } : item
  )
);
```

刪除資料：

```jsx
setItems((prev) => prev.filter((item) => item.id !== targetId));
```

---

## 5. `useRef`：不觸發渲染的記憶

不是所有「要記住的東西」都該放 state。`useRef` 有兩個常見用途：

### 5.1 操作 DOM（最常見：聚焦輸入框）

```jsx
import { useRef } from "react";

function SearchBox() {
  const inputRef = useRef(null);

  return (
    <>
      <input ref={inputRef} placeholder="搜尋課程" />
      <button onClick={() => inputRef.current.focus()}>聚焦輸入框</button>
    </>
  );
}
```

### 5.2 保存「改變時不需要重新渲染」的值

例如計時器 id、上一次的滾動位置：

```jsx
const timerRef = useRef(null);
timerRef.current = setInterval(/* ... */);
```

state 與 ref 的分工：

| | `useState` | `useRef` |
|---|---|---|
| 改變時重新渲染 | 會 | 不會 |
| 適合放 | 要顯示在畫面上的資料 | DOM 參照、計時器 id 等幕後資料 |

> 判斷準則：**值改變時畫面要跟著變 → state；不用 → ref。**

---

## 6. 本章小練習

1. 建一個學習任務列表（title + done）。
2. 可以新增任務。
3. 可以切換任務完成狀態。
4. 可以刪除任務並顯示完成比例。
5. 新增任務後，用 `useRef` 讓輸入框自動重新聚焦。

---

## 最後範例：學習任務追蹤器

### `src/App.jsx`

```jsx
import { useMemo, useState } from "react";
import "./App.css";

const initialTasks = [
  { id: 1, title: "完成 React 第 1 章", done: true },
  { id: 2, title: "手打 JSX 範例一遍", done: false },
  { id: 3, title: "整理 props 練習筆記", done: false },
];

function App() {
  const [tasks, setTasks] = useState(initialTasks);
  const [draft, setDraft] = useState("");

  const doneCount = useMemo(
    () => tasks.filter((task) => task.done).length,
    [tasks]
  );

  const progress = tasks.length === 0 ? 0 : Math.round((doneCount / tasks.length) * 100);

  function handleSubmit(event) {
    event.preventDefault();
    const value = draft.trim();
    if (!value) return;

    const newTask = {
      id: Date.now(),
      title: value,
      done: false,
    };

    setTasks((prev) => [...prev, newTask]);
    setDraft("");
  }

  function handleToggle(taskId) {
    setTasks((prev) =>
      prev.map((task) =>
        task.id === taskId ? { ...task, done: !task.done } : task
      )
    );
  }

  function handleDelete(taskId) {
    setTasks((prev) => prev.filter((task) => task.id !== taskId));
  }

  function handleReset() {
    setTasks(initialTasks);
    setDraft("");
  }

  return (
    <main className="page">
      <h1>第 5 章最終範例：State 與事件處理</h1>

      <section className="card">
        <h2>學習任務追蹤器</h2>
        <p>
          完成進度：{doneCount} / {tasks.length}（{progress}%）
        </p>
        <div className="progress-bar">
          <span style={{ width: `${progress}%` }} />
        </div>

        <form onSubmit={handleSubmit} className="form-row">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="新增任務，例如：完成第 6 章表單實作"
          />
          <button type="submit">新增</button>
          <button type="button" className="ghost" onClick={handleReset}>
            重設
          </button>
        </form>

        <ul className="task-list">
          {tasks.map((task) => (
            <li key={task.id}>
              <label>
                <input
                  type="checkbox"
                  checked={task.done}
                  onChange={() => handleToggle(task.id)}
                />
                <span className={task.done ? "done" : ""}>{task.title}</span>
              </label>
              <button className="danger" onClick={() => handleDelete(task.id)}>
                刪除
              </button>
            </li>
          ))}
        </ul>
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
  background: #f3f4f6;
}

.page {
  width: min(760px, 100%);
  margin: 36px auto;
  padding: 0 16px;
}

.card {
  background: #ffffff;
  border-radius: 14px;
  padding: 20px;
  box-shadow: 0 8px 24px rgba(17, 24, 39, 0.08);
}

.progress-bar {
  height: 10px;
  border-radius: 999px;
  background: #e5e7eb;
  overflow: hidden;
  margin-bottom: 14px;
}

.progress-bar span {
  display: block;
  height: 100%;
  background: #2563eb;
}

.form-row {
  display: flex;
  gap: 8px;
  margin-bottom: 14px;
}

input[type="text"],
.form-row input {
  flex: 1;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  padding: 8px 10px;
}

button {
  border: 1px solid #d1d5db;
  background: #111827;
  color: #ffffff;
  border-radius: 8px;
  padding: 8px 12px;
  cursor: pointer;
}

button.ghost {
  background: #ffffff;
  color: #111827;
}

button.danger {
  background: #b91c1c;
  border-color: #b91c1c;
}

.task-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.task-list li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid #e5e7eb;
}

.done {
  text-decoration: line-through;
  color: #6b7280;
}
```

### 範例解釋

1. `tasks` 與 `draft` 都屬於會變動資料，所以都用 `useState` 管理。
2. `handleSubmit` 透過 `event.preventDefault()` 避免表單送出刷新頁面。
3. `handleToggle`、`handleDelete` 都使用不可變更新，確保 React 能正確偵測變化。
4. `progress` 是由 `tasks` 推導出來的結果，不需要獨立 state，避免資料重複來源。

---

## 本章結語

你已經具備 React 互動頁面的基本能力。  
下一章會把這些能力用在表單流程中，加入驗證與錯誤提示機制。
