# 第 5 章：State 與事件處理

## 本章目標

完成這一章後，你應該可以：

1. 正確使用 `useState` 管理互動狀態。
2. 撰寫表單、按鈕、清單常見事件處理器。
3. 使用不可變更新方式操作陣列與物件 state。
4. 做出可新增、切換、刪除的互動列表。
5. 分辨 `useState` 與 `useRef` 的使用時機。
6. 認識 `useReducer`，處理「一組狀態有多種操作」的情境。
7. 解釋 Hooks 如何保存狀態、為什麼呼叫順序必須固定，以及 state 快照與更新佇列。

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

### 2.1 Hooks 的原理：函式重跑，狀態為什麼還在？

元件每次 render 都會重新執行函式，一般區域變數也會重新建立。
`useState` 的狀態則由 React 保存，並依元件在樹中的身分與 Hook 呼叫順序取回。
同時顯示兩個 `<Counter />`，各自會有獨立的狀態；卸載後重新掛載，或改變 `key` 造成身分改變，則會重新初始化。

先用「每個元件有一排狀態格子」理解：

```jsx
function Profile() {
  const [name, setName] = useState("Gary"); // 第 1 格
  const [age, setAge] = useState(20);      // 第 2 格
  // ...
}
```

第一次呼叫時建立格子；後續 render 依同樣順序讀回狀態，並處理待更新的資料。
React 不會靠 `name`、`age` 這些變數名稱辨認 Hook。
這是理解順序的教學模型，可對照官方的 [State: A Component's Memory](https://react.dev/learn/state-a-components-memory)。

更接近 React 18 實作的結構如下：

```text
元件對應的 Fiber（React 用來記錄元件與渲染工作的內部節點）
  └─ memoizedState → Hook 節點 → Hook 節點 → ...
                       │
                       └─ state 與更新佇列等資料
```

以 `useState` 為例，初次 render 會建立 Hook 節點，後續 render 會依序對應既有節點。
setter 把更新加入佇列並排程工作；React 在 render 時依更新計算下一份狀態。
Fiber 還會協助追蹤已提交與正在準備的版本，讓渲染工作可以重做。
這些是內部實作，不是應用程式應依賴的公開 API，也不要把格子模型當成所有 Hook 的完整實作。
原始碼可查看 React 18.2 的 [ReactFiberHooks.new.js](https://github.com/facebook/react/blob/v18.2.0/packages/react-reconciler/src/ReactFiberHooks.new.js)，搜尋 `mountWorkInProgressHook`、`updateWorkInProgressHook` 與 `dispatchSetState`。

### 2.2 為什麼不能在條件式裡呼叫 Hook？

```jsx
// 錯誤示範：兩次 render 的 Hook 順序不同
function Profile({ showName }) {
  if (showName) {
    const [name, setName] = useState("Gary");
  }
  const [age, setAge] = useState(20);
  return <p>{age}</p>;
}
```

當 `showName` 從 `true` 變成 `false`，原本第二次呼叫的 `useState` 變成第一次，
破壞了狀態對應，React 通常會報 Hook 數量或順序錯誤。
修正方式是每次都在最上層呼叫 Hook，再用條件決定 UI 或 Hook 內部要做的事。
提前 `return` 也要注意：不能讓某些 render 跳過後面的 Hook。

自訂 Hook 內的 `useState`、`useEffect` 等也屬於呼叫它的元件的 Hook 序列，
所以自訂 Hook 同樣要遵守順序規則。**自訂 Hook 共用的是邏輯，每次呼叫的狀態仍各自獨立**；跨元件共享資料要另外設計，例如第 11 章的 Zustand。

### 2.3 State 是快照，setter 是排入更新

假設這次 render 的 `count` 是 `0`，按鈕執行：

```jsx
function handleAddTwo() {
  setCount(count + 1);
  setCount(count + 1);
  console.log(count); // 仍是 0：讀到這次 render 的快照
}
```

兩次都要求「設成 1」，所以下次顯示 `1`。setter 不會改寫目前函式裡的 `count`。
如果要依前一個更新繼續累加，改成：

```jsx
function handleAddTwo() {
  setCount((previous) => previous + 1);
  setCount((previous) => previous + 1);
}
```

React 處理佇列時會依序計算 `0 → 1 → 2`。
updater 必須是純函式，不要在裡面發 API、寫日誌或修改外部資料，因為 React 可能重複呼叫它。
詳見官方的 [Queueing a Series of State Updates](https://react.dev/learn/queueing-a-series-of-state-updates)。

這也連到下一章之後會遇到的閉包問題：事件處理器、計時器與 Effect 的 callback，
會捕捉建立當下那次 render 的值；第 7 章會用這個觀念解釋依賴陣列。

**理解檢查：**能否用「元件身分、呼叫順序、更新佇列、render 快照」四個詞，解釋 `useState` 為什麼能記住資料？

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

## 6. `useReducer`：當一組狀態有多種操作

本章的任務追蹤器有三個動作：新增、切換、刪除，全部都在改同一份 `tasks`。
當「同一份狀態有多種更新方式」時，把散落的 `setTasks` 收斂成一個 **reducer** 會更好維護。

`useReducer` 有兩個角色：

- **reducer**：`(state, action) => newState` 的純函式，集中所有更新邏輯
- **dispatch**：發送一個 `action`（描述「發生了什麼事」）來觸發更新

```jsx
import { useReducer } from "react";

function tasksReducer(tasks, action) {
  switch (action.type) {
    case "added":
      return [...tasks, { id: Date.now(), title: action.title, done: false }];
    case "toggled":
      return tasks.map((task) =>
        task.id === action.id ? { ...task, done: !task.done } : task
      );
    case "deleted":
      return tasks.filter((task) => task.id !== action.id);
    default:
      throw new Error(`未知的 action：${action.type}`);
  }
}

function TaskApp() {
  const [tasks, dispatch] = useReducer(tasksReducer, initialTasks);

  // 元件裡不再直接寫更新邏輯，只發送「發生了什麼事」
  const handleAdd = (title) => dispatch({ type: "added", title });
  const handleToggle = (id) => dispatch({ type: "toggled", id });
  const handleDelete = (id) => dispatch({ type: "deleted", id });

  // ...渲染與 useState 版相同，只是把 setTasks 換成上面三個 handler
}
```

跟 `useState` 版比起來，好處是：

1. 所有更新邏輯集中在 `tasksReducer`，元件只負責「發事件」，畫面與邏輯分離。
2. reducer 是純函式，很好單獨測試（第 14 章）。
3. 動作一多（例如 5 個以上）時，比一堆 `setTasks` 好讀。

`useState` 與 `useReducer` 怎麼選：

| | `useState` | `useReducer` |
|---|---|---|
| 適合 | 單一、獨立的值 | 一組相關狀態、多種更新動作 |
| 更新邏輯 | 分散在各 handler | 集中在 reducer |
| 例子 | 輸入框文字、開關 | 任務清單、多欄位表單、購物車 |

> 判斷準則：**狀態單純就用 `useState`；當同一份狀態被很多個 `setX` 用不同方式更新，就換 `useReducer`。**

（第 11 章的 Zustand 也是同一種「把更新邏輯集中成 actions」的思路，只是再把狀態提升到全域。）

---

## 7. 本章小練習

1. 建一個學習任務列表（title + done）。
2. 可以新增任務。
3. 可以切換任務完成狀態。
4. 可以刪除任務並顯示完成比例。
5. 新增任務後，用 `useRef` 讓輸入框自動重新聚焦。
6. 把上面的任務追蹤器改用 `useReducer` 重寫，行為維持不變。
7. 做兩個計數器，分別連續呼叫兩次 `setCount(count + 1)` 與函式型更新，預測並驗證差異。
8. 同時渲染兩個計數器，確認狀態獨立，再改變其中一個的 `key`，觀察狀態重設。

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
