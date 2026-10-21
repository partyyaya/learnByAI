# 第 7 章：`useEffect` 與 API 串接

## 本章目標

完成這一章後，你應該可以：

1. 理解 `useEffect` 的執行時機與依賴陣列。
2. 用 `loading / error / data` 管理 API 狀態。
3. 用 `AbortController` 避免快速切換造成的競態問題。
4. 解釋 StrictMode 下 effect 執行兩次的原因與正確應對。
5. 把重複的資料抓取邏輯抽成自訂 Hook。
6. 用 render 快照與閉包解釋依賴陣列，修正漏寫依賴與引用不穩定的問題。

---

## 1. `useEffect` 在解決什麼問題？

React 元件主要負責「渲染 UI」，  
但某些操作屬於副作用（side effects），例如：

- 打 API
- 操作 `document.title`
- 訂閱 / 取消訂閱事件

當這些操作需要隨元件顯示或 props/state 變化，與外部系統保持同步時，適合放在 `useEffect`。
但「按下送出才新增資料」應放在事件處理器；單純依 state 計算篩選結果則直接在 render 計算。
不要把所有副作用或衍生資料都塞進 Effect。詳見 [Synchronizing with Effects](https://react.dev/learn/synchronizing-with-effects)。

---

## 2. 依賴陣列與執行時機：為什麼重要？

```jsx
useEffect(() => {
  // effect logic
}, [userId]);
```

- 初次掛載提交（commit）後執行 setup；render 本身只是計算 UI。
- 後續提交若 `userId` 改變，先執行舊的 cleanup，再用新的值執行 setup。
- 卸載時執行最後一次 cleanup；被放棄、沒有提交的 render 不會執行其 Effect setup。

### 2.1 不傳、空陣列、有依賴，差在哪裡？

| 寫法 | 何時重新同步 |
|---|---|
| `useEffect(setup)` | 每次該元件提交後執行 |
| `useEffect(setup, [])` | 掛載時執行，不因後續 props/state 更新而重跑 |
| `useEffect(setup, [userId])` | 掛載時，以及 `userId` 與上次比較不同的提交後執行 |

`[]` 不代表整個應用生命週期只執行一次：重新掛載仍會執行，開發期 StrictMode 也會額外檢查（見第 5 節）。
Effect 只在客戶端執行。不要把它理解成「一定在瀏覽器繪製畫面後」的計時工具；互動造成的 Effect 可能在繪製前執行。
這些時機與依賴規則可查閱 [useEffect 官方 API](https://react.dev/reference/react/useEffect)。

### 2.2 少寫依賴，會留下哪一份資料？

第 5 章提過，每次 render 都有自己的 state 快照，callback 會透過閉包捕捉那份值。
依賴陣列是在告訴 React：**哪些值改變後，舊的同步工作已不適用，需要重新建立？**

```jsx
import { useEffect } from "react";

// 錯誤示範：切換使用者後，標題仍停留在最初的 userId
function UserTitle({ userId }) {
  useEffect(() => {
    document.title = `User ${userId}`;
  }, []); // 漏掉 userId

  return <h1>目前使用者：{userId}</h1>;
}
```

畫面可能已經顯示 User 2，但標題仍是 User 1。
修正成 `[userId]`，React 才會在切換後執行使用新值的 Effect。
計時器或訂閱也一樣：如果一直保留第一次建立的 callback，它就可能持續讀取舊值，這稱為 **stale closure（閉包中的舊值）**。

依賴應包含 Effect 讀取的 reactive values，例如 props、state，以及元件內宣告的變數與函式。
不需要機械式地把所有識別字都填進去：模組層級常數、穩定的 state setter 等不需要因每次 render 重新同步。
使用 `eslint-plugin-react-hooks` 的 `exhaustive-deps` 規則協助檢查；不要為了讓警告消失直接關掉規則。
詳見 [Removing Effect Dependencies](https://react.dev/learn/removing-effect-dependencies)。

### 2.3 `Object.is` 與物件／函式的引用

React 用 `Object.is` 逐項比較依賴，不會深度比較物件內容。
依賴陣列的項目數與排列應固定；每次建立新的陣列字面值 `[userId]` 沒問題，重點是裡面的值。

```jsx
// 元件函式內：每次 render 都建立新的 options 物件
const options = { userId };

useEffect(() => {
  document.title = `User ${options.userId}`;
}, [options]); // 即使 userId 沒變，options 的引用仍不同
```

若物件只是 Effect 的內部細節，把它移進 Effect，再依賴真正的輸入：

```jsx
useEffect(() => {
  const options = { userId };
  document.title = `User ${options.userId}`;
}, [userId]);
```

函式也有引用問題。只給 Effect 使用的函式可移進 Effect；不依賴元件資料的工具函式可移到元件外。
確實需要跨地方保持引用時，再考慮 `useMemo`／`useCallback`（第 13 章）。
單純引用不同會造成重跑；若 Effect 又更新 state，且更新讓依賴持續改變，才可能形成無限迴圈。

### 2.4 用函式型更新減少真正不需要的依賴

下面的計時器只需要「將前一次計數加一」，不用讀取這次 render 的 `count`：

```jsx
import { useEffect, useState } from "react";

export default function Timer() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const timerId = setInterval(() => {
      setCount((previous) => previous + 1);
    }, 1000);
    return () => clearInterval(timerId);
  }, []);

  return <p>經過 {count} 秒</p>;
}
```

若改成 `setCount(count + 1)` 卻保留 `[]`，callback 會一直要求設成最初的 `count + 1`。
加上 `[count]` 可以讓它讀新值，但也會每次清掉並重建計時器。
這裡用 updater 消除了對外層 `count` 的讀取，所以 `[]` 才是合理的；若計時器還使用 `step` prop，就仍應把 `step` 列入依賴。

**理解檢查：**依賴陣列會影響同步的正確性與重跑成本。要減少依賴，先改寫 Effect 讓它不再讀取那些值，再讓陣列與程式碼一致。

---

## 3. API 狀態建議拆三種

1. `loading`: 是否正在請求
2. `error`: 是否失敗
3. `data`: 成功資料

不要只用單一布林值，否則畫面狀態會不完整。

---

## 4. 競態問題與中止請求

當使用者快速切換篩選條件時，舊請求可能晚回來，覆蓋新資料。  
可用 `AbortController` 取消前一個請求：

```jsx
const controller = new AbortController();
fetch(url, { signal: controller.signal });
return () => controller.abort();
```

---

## 5. 為什麼開發時 effect 會跑兩次？（StrictMode）

用本章範例打 API 時，你會在 Network 面板看到**同一個請求發了兩次**。  
這不是 bug：`main.jsx` 裡的 `<React.StrictMode>` 在**開發模式**會刻意把
額外執行一次「setup → cleanup」，再執行正常的 setup，幫你提早發現無法正確清理的 Effect。

要知道三件事：

1. 這次額外檢查只發生在開發模式；正式版仍可能因重新掛載或依賴改變而再次執行。
2. 不要為了「只跑一次」移除 StrictMode 或亂加旗標——正確解法是把 cleanup 寫好。
3. 本章範例的 `AbortController` 就是正確示範：第一次的請求會在 cleanup 時被中止。

> 判斷準則：**檢查 setup 與 cleanup 是否對稱；像送出訂單這種由特定操作觸發的行為，應放在事件處理器。**

---

## 6. 把邏輯抽成自訂 Hook

當「抓資料 + 三種狀態」這組邏輯要在多個元件重複使用時，
可以抽成**自訂 Hook**——一個以 `use` 開頭、內部呼叫其他 hook 的函式：

```jsx
// src/hooks/useTodos.js
import { useEffect, useState } from "react";

export function useTodos(userId) {
  const [todos, setTodos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      try {
        setLoading(true);
        setError("");
        const response = await fetch(
          `https://jsonplaceholder.typicode.com/todos?userId=${userId}`,
          { signal: controller.signal }
        );
        if (!response.ok) throw new Error("API 請求失敗");
        setTodos((await response.json()).slice(0, 8));
      } catch (err) {
        if (err.name !== "AbortError") setError(err.message);
      } finally {
        setLoading(false);
      }
    }

    load();
    return () => controller.abort();
  }, [userId]);

  return { todos, loading, error };
}
```

元件端變得非常乾淨：

```jsx
const { todos, loading, error } = useTodos(userId);
```

同時記住 **Hook 的兩條規則**：

1. 只能在元件或自訂 Hook 的「最上層」呼叫 hook——不能放在 `if`、迴圈、事件處理器內。
2. 只能在 React 函式（元件、自訂 Hook）中呼叫，不能在一般 JS 函式裡用。

第 9 章的 `useLessonsQuery` 就是同一個模式——用 TanStack Query 後，這整包樣板碼會再縮成幾行。

---

## 7. 本章小練習

1. 提供使用者切換按鈕（User 1 / User 2 / User 3）。
2. 切換時重新抓取該使用者的 todo。
3. 顯示 loading、error、empty 狀態。
4. 在切換時避免舊資料覆蓋新資料。
5. 把抓資料邏輯抽成 `useTodos` 自訂 Hook 後再接回元件。
6. 重現第 2.2 節切換使用者但標題不更新的問題，再修正依賴。
7. 比較 Timer 使用 `setCount(count + 1)` 與函式型更新的差異，解釋閉包捕捉哪一份值。

---

## 最後範例：依使用者抓取待辦清單

### `src/App.jsx`

```jsx
import { useEffect, useState } from "react";
import "./App.css";

function App() {
  const [userId, setUserId] = useState(1);
  const [todos, setTodos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();

    async function loadTodos() {
      try {
        setLoading(true);
        setError("");

        const response = await fetch(
          `https://jsonplaceholder.typicode.com/todos?userId=${userId}`,
          { signal: controller.signal }
        );

        if (!response.ok) {
          throw new Error("API 請求失敗");
        }

        const data = await response.json();
        setTodos(data.slice(0, 8));
      } catch (err) {
        // 被 abort 的請求不視為錯誤
        if (err.name !== "AbortError") {
          setError(err.message || "發生未知錯誤");
        }
      } finally {
        setLoading(false);
      }
    }

    loadTodos();

    return () => {
      controller.abort();
    };
  }, [userId]);

  useEffect(() => {
    document.title = `User ${userId} Todos`;
  }, [userId]);

  return (
    <main className="page">
      <h1>第 7 章最終範例：useEffect 與 API 串接</h1>

      <div className="switches">
        {[1, 2, 3].map((id) => (
          <button
            key={id}
            className={userId === id ? "active" : ""}
            onClick={() => setUserId(id)}
          >
            User {id}
          </button>
        ))}
      </div>

      <section className="card">
        <h2>使用者 {userId} 的待辦清單</h2>

        {loading && <p>資料載入中...</p>}
        {error && <p className="error">錯誤：{error}</p>}

        {!loading && !error && todos.length === 0 && <p>目前沒有待辦資料。</p>}

        {!loading && !error && todos.length > 0 && (
          <ul>
            {todos.map((todo) => (
              <li key={todo.id}>
                <span className={todo.completed ? "done" : ""}>{todo.title}</span>
              </li>
            ))}
          </ul>
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
  width: min(760px, 100%);
  margin: 28px auto;
  padding: 0 16px 30px;
}

.switches {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

button {
  border: 1px solid #cbd5e1;
  background: #ffffff;
  border-radius: 8px;
  padding: 7px 12px;
  cursor: pointer;
}

button.active {
  background: #0f172a;
  color: #ffffff;
  border-color: #0f172a;
}

.card {
  background: #ffffff;
  border-radius: 12px;
  padding: 16px;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.07);
}

ul {
  margin: 0;
  padding-left: 18px;
}

li {
  margin-bottom: 8px;
}

.done {
  text-decoration: line-through;
  color: #64748b;
}

.error {
  color: #b91c1c;
}
```

### 範例解釋

1. 第一個 `useEffect` 依賴 `userId`，所以每次切換使用者都會重新抓取資料。
2. `AbortController` 在 cleanup 時中止前一次請求，避免競態覆蓋問題。
3. 狀態被拆成 `loading / error / todos`，畫面分支清楚，不會互相衝突。
4. 第二個 `useEffect` 示範非 API 副作用（同步更新頁面標題）。

---

## 本章結語

你已經能用 React 原生能力完成穩定的資料抓取流程。  
下一章會讓你把畫面拆成多頁並建立路由導航。
