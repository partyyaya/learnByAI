# 第 8 章：Server Actions 與表單

## 本章目標

完成這一章後，你應該可以：

1. 用 `"use server"` 定義 Server Action。
2. 讓表單直接呼叫 Server Action，不必手寫 API + fetch。
3. 用 `useActionState` 顯示驗證錯誤與結果。
4. 用 `useFormStatus` 顯示送出中的狀態。
5. 用 `revalidatePath` / `revalidateTag` 讓畫面拿到最新資料。
6. 做一個基本的樂觀更新（`useOptimistic`）。

---

## 1. Server Action 是什麼

Server Action 是一個**只在伺服器執行的函式**，但你可以直接從表單或 Client 元件呼叫它，Next.js 幫你處理中間的網路傳輸。

定義方式：在函式或檔案最上面加 `"use server"`。

```jsx
// app/actions.js
"use server"; // 整個檔案的函式都是 Server Action

export async function createTodo(formData) {
  const text = formData.get("text");
  // …這裡可以直接讀資料庫、用密鑰，因為只在伺服器跑
  console.log("新增：", text);
}
```

> 和 Route Handler 的差別：Server Action 不需要你設計 URL、方法、回傳格式。它就是「一個可以從前端安全呼叫的伺服器函式」，最適合表單與資料異動。

---

## 2. 表單直接綁 action

把 Server Action 傳給 `<form action={...}>`，送出時 Next.js 會把 `FormData` 交給它，**全程不需要 `onSubmit`、不需要 `fetch`**：

```jsx
// app/page.js （Server Component）
import { createTodo } from "./actions";

export default function Page() {
  return (
    <form action={createTodo}>
      <input name="text" placeholder="輸入待辦" />
      <button type="submit">新增</button>
    </form>
  );
}
```

就算使用者關掉 JavaScript，這個表單依然能運作（漸進增強）。

---

## 3. 更新後刷新畫面：revalidatePath / revalidateTag

異動資料後，畫面上的列表要更新。Server Action 裡呼叫 `revalidatePath` 告訴 Next.js「這條路徑的快取失效了，重抓」：

```jsx
"use server";
import { revalidatePath } from "next/cache";

export async function createTodo(formData) {
  const text = formData.get("text");
  await db.todo.create({ text }); // 假設有資料庫（第 9 章）
  revalidatePath("/todos");        // /todos 頁重新抓資料
}
```

- `revalidatePath("/todos")`：讓某條路徑重新驗證。
- `revalidateTag("todos")`：讓所有標了該 tag 的 fetch 重新驗證（第 12 章）。

---

## 4. 顯示驗證錯誤與結果：useActionState

要在畫面上顯示「錯誤訊息」或「成功提示」，用 React 的 `useActionState`（需在 Client 元件）。Action 的回傳值會成為新的 state：

```jsx
"use client";
import { useActionState } from "react";
import { createTodo } from "./actions";

export default function TodoForm() {
  // state = action 的回傳值；formAction 綁到 <form>
  const [state, formAction] = useActionState(createTodo, { error: null });

  return (
    <form action={formAction}>
      <input name="text" />
      <button type="submit">新增</button>
      {state?.error && <p className="err">{state.error}</p>}
      {state?.success && <p className="ok">新增成功！</p>}
    </form>
  );
}
```

對應的 action 要接收 `prevState` 當第一個參數，並**回傳**新狀態：

```jsx
"use server";
export async function createTodo(prevState, formData) {
  const text = (formData.get("text") ?? "").trim();
  if (!text) return { error: "內容不可為空" }; // 回傳錯誤，畫面顯示
  await saveTodo(text);
  return { success: true };
}
```

---

## 5. 送出中的狀態：useFormStatus

要讓按鈕在送出時 disable 並顯示「送出中…」，用 `useFormStatus`（必須放在 `<form>` 裡的**子元件**）：

```jsx
"use client";
import { useFormStatus } from "react-dom";

export default function SubmitButton({ children }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}>
      {pending ? "送出中…" : children}
    </button>
  );
}
```

> `useFormStatus` 只能讀到「包住它的那個 `<form>`」的狀態，所以要把它包成獨立子元件放進表單裡，不能和 `<form>` 寫在同一個元件。

---

## 6. 樂觀更新：useOptimistic

想在伺服器回來前就先把 UI 更新（像按讚立刻 +1），用 `useOptimistic`：

```jsx
"use client";
import { useOptimistic } from "react";

function TodoList({ todos, addAction }) {
  const [optimisticTodos, addOptimistic] = useOptimistic(
    todos,
    (state, newText) => [...state, { id: "temp", text: newText, sending: true }]
  );

  async function handle(formData) {
    const text = formData.get("text");
    addOptimistic(text);      // 立即在畫面加上（灰色 pending）
    await addAction(formData); // 真正送到伺服器
  }

  return (
    <form action={handle}>
      <input name="text" />
      <ul>
        {optimisticTodos.map((t) => (
          <li key={t.id} style={{ opacity: t.sending ? 0.5 : 1 }}>{t.text}</li>
        ))}
      </ul>
    </form>
  );
}
```

---

## 7. 本章小練習

1. 用 Server Action 做「新增待辦」表單，送出後用 `revalidatePath` 刷新列表。
2. 加驗證：空字串回傳錯誤，用 `useActionState` 顯示。
3. 加 `SubmitButton`，送出時顯示「送出中…」。
4. 加「刪除」按鈕（也是 Server Action）。
5. 進階：用 `useOptimistic` 讓新增立即出現在清單。

---

## 最後範例：新增/刪除待辦（無需手寫 fetch）

> 用記憶體資料源示範完整流程：Server Action 做新增/刪除、`revalidatePath` 刷新、`useActionState` 顯示錯誤、`useFormStatus` 顯示送出中。原樣建立以下檔案即可跑（第 9 章會把資料源換成真資料庫）。

### `app/todos/store.js`（記憶體資料源，示範用）

```js
// 簡單記憶體資料源；dev 重啟會重置，僅供示範。
let todos = [{ id: 1, text: "學會 Server Actions", done: false }];
let nextId = 2;

export function listTodos() {
  return todos;
}
export function addTodo(text) {
  const t = { id: nextId++, text, done: false };
  todos.push(t);
  return t;
}
export function removeTodo(id) {
  todos = todos.filter((t) => t.id !== id);
}
```

### `app/todos/actions.js`（Server Actions）

```jsx
"use server";
import { revalidatePath } from "next/cache";
import { addTodo, removeTodo } from "./store";

// 新增：接 prevState + formData，回傳結果狀態
export async function createTodoAction(prevState, formData) {
  const text = (formData.get("text") ?? "").trim();
  if (!text) return { error: "內容不可為空" };
  if (text.length > 50) return { error: "不可超過 50 字" };

  addTodo(text);
  revalidatePath("/todos"); // 讓列表重新抓資料
  return { success: true };
}

// 刪除：直接綁在表單 action，用 formData 夾帶 id
export async function deleteTodoAction(formData) {
  const id = Number(formData.get("id"));
  removeTodo(id);
  revalidatePath("/todos");
}
```

### `app/todos/SubmitButton.js`（Client：送出中狀態）

```jsx
"use client";
import { useFormStatus } from "react-dom";

export default function SubmitButton({ children }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}>
      {pending ? "處理中…" : children}
    </button>
  );
}
```

### `app/todos/TodoForm.js`（Client：新增表單 + 錯誤顯示）

```jsx
"use client";
import { useActionState } from "react";
import { createTodoAction } from "./actions";
import SubmitButton from "./SubmitButton";

export default function TodoForm() {
  const [state, formAction] = useActionState(createTodoAction, { error: null });

  return (
    <form action={formAction} className="todo-form">
      <input name="text" placeholder="新增待辦…" />
      <SubmitButton>新增</SubmitButton>
      {state?.error && <p className="err">{state.error}</p>}
    </form>
  );
}
```

### `app/todos/page.js`（Server：列表 + 刪除）

```jsx
import { listTodos } from "./store";
import { deleteTodoAction } from "./actions";
import TodoForm from "./TodoForm";
import SubmitButton from "./SubmitButton";

export default function TodosPage() {
  const todos = listTodos();

  return (
    <main className="wrap">
      <h1>待辦清單</h1>
      <TodoForm />

      <ul className="todo-list">
        {todos.map((t) => (
          <li key={t.id}>
            <span>{t.text}</span>
            {/* 刪除也是表單 + Server Action，用 hidden input 夾帶 id */}
            <form action={deleteTodoAction}>
              <input type="hidden" name="id" value={t.id} />
              <SubmitButton>刪除</SubmitButton>
            </form>
          </li>
        ))}
      </ul>
    </main>
  );
}
```

### 樣式（加進 `app/globals.css`）

```css
.wrap { max-width: 520px; margin: 40px auto; font-family: sans-serif; padding: 0 16px; }
.todo-form { display: flex; gap: 8px; align-items: center; }
.todo-form input { flex: 1; padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 8px; }
button { padding: 8px 14px; border: 0; border-radius: 8px; background: #2563eb; color: #fff; cursor: pointer; }
button:disabled { opacity: 0.6; cursor: not-allowed; }
.err { color: #dc2626; margin: 6px 0 0; }
.todo-list { list-style: none; padding: 0; margin-top: 16px; }
.todo-list li { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid #eee; }
.todo-list button { background: #ef4444; }
```

---

## 本章結語

Server Actions 讓「表單 → 伺服器處理 → 刷新畫面」變成幾行事，是 App Router 最提升生產力的功能。  
但目前資料還存在記憶體裡，一重啟就沒了。下一章接上 **Prisma + SQLite**，讓資料真正落地。
