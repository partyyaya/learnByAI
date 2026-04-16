# 第 7 章：`useEffect` 與 API 串接

## 本章目標

完成這一章後，你應該可以：

1. 理解 `useEffect` 的執行時機與依賴陣列。
2. 用 `loading / error / data` 管理 API 狀態。
3. 用 `AbortController` 避免快速切換造成的競態問題。
4. 寫出穩定、可讀、可維護的資料抓取流程。

---

## 1. `useEffect` 在解決什麼問題？

React 元件主要負責「渲染 UI」，  
但某些操作屬於副作用（side effects），例如：

- 打 API
- 操作 `document.title`
- 訂閱 / 取消訂閱事件

這些邏輯應放在 `useEffect`。

---

## 2. 依賴陣列與執行時機

```jsx
useEffect(() => {
  // effect logic
}, [userId]);
```

- 初次渲染會執行
- `userId` 改變時再次執行
- 若回傳 cleanup function，下一次 effect 前或卸載時會先清理

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

## 5. 本章小練習

1. 提供使用者切換按鈕（User 1 / User 2 / User 3）。
2. 切換時重新抓取該使用者的 todo。
3. 顯示 loading、error、empty 狀態。
4. 在切換時避免舊資料覆蓋新資料。

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
