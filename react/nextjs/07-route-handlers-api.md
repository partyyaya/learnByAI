# 第 7 章：Route Handlers（API 路由）

## 本章目標

完成這一章後，你應該可以：

1. 用 `route.js` 建立自己的 API 端點。
2. 處理 `GET` / `POST` / `PUT` / `DELETE` 各種方法。
3. 讀取請求的 body、查詢字串、動態段、`cookies`、`headers`。
4. 用 `NextResponse` 回傳 JSON 與正確的狀態碼。
5. 知道什麼時候該用 Route Handler、什麼時候該用 Server Action（下一章）。

---

## 1. route.js：一個檔案就是一個 API 端點

在 `app` 裡建立名為 `route.js` 的檔案（注意：不是 `page.js`），它就是一個 API 端點。export 一個和 HTTP 方法同名的函式：

```text
app/api/hello/route.js   → 對應 /api/hello
```

```jsx
// app/api/hello/route.js
import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ message: "Hello from API" });
}
```

打開瀏覽器連 `/api/hello` 就會看到 JSON。

> **同一個資料夾不能同時有 `page.js` 和 `route.js`**（一個是畫面、一個是 API，會衝突）。慣例上把 API 集中放在 `app/api/` 底下。

---

## 2. 各種 HTTP 方法

export 對應名稱的函式即可，沒 export 的方法會自動回 405：

```jsx
import { NextResponse } from "next/server";

export async function GET() { /* 讀取 */ }
export async function POST(request) { /* 新增 */ }
export async function PUT(request) { /* 更新 */ }
export async function DELETE(request) { /* 刪除 */ }
```

---

## 3. 讀取請求內容

### 讀 body（POST/PUT 的 JSON）

```jsx
export async function POST(request) {
  const body = await request.json(); // 解析 JSON body
  // body.title, body.content …
  return NextResponse.json({ ok: true, received: body }, { status: 201 });
}
```

### 讀查詢字串 `?q=...`

```jsx
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q") ?? "";
  return NextResponse.json({ q });
}
```

### 讀動態段（例如 `/api/todos/[id]`）

```jsx
// app/api/todos/[id]/route.js
export async function GET(request, { params }) {
  const { id } = await params; // Next.js 15：params 是 Promise
  return NextResponse.json({ id });
}
```

### 讀 cookies / headers

```jsx
import { cookies, headers } from "next/headers";

export async function GET() {
  const cookieStore = await cookies();      // Next.js 15：要 await
  const token = cookieStore.get("token")?.value;

  const headerList = await headers();
  const ua = headerList.get("user-agent");

  return NextResponse.json({ token, ua });
}
```

---

## 4. 回應：NextResponse

```jsx
import { NextResponse } from "next/server";

// JSON + 狀態碼
NextResponse.json({ error: "找不到" }, { status: 404 });

// 設定 cookie
const res = NextResponse.json({ ok: true });
res.cookies.set("token", "abc123", { httpOnly: true, path: "/" });
return res;

// 轉址
NextResponse.redirect(new URL("/login", request.url));
```

---

## 5. Route Handler vs Server Action，怎麼選？

| 情境 | 用哪個 |
|------|--------|
| 提供給**外部**（手機 App、第三方、webhook）呼叫的 API | Route Handler |
| 需要自訂 HTTP 方法、狀態碼、回傳格式 | Route Handler |
| **表單提交、頁面內的資料異動**（新增/編輯/刪除） | Server Action（第 8 章） |
| 想在 Server Component 內直接抓資料 | 直接 `await fetch`（第 5 章），不必先建 API |

> 新手常犯的錯：為了在自己頁面顯示資料，先建一個 API route，再用 `useEffect` fetch 它。App Router 裡**根本不需要**——Server Component 直接抓就好。Route Handler 是給「真的需要對外 API」的情境。

---

## 6. 本章小練習

1. 建 `GET /api/time`，回傳目前伺服器時間。
2. 建 `GET /api/todos` 回傳一個記憶體陣列的待辦清單。
3. 建 `POST /api/todos`，接收 `{ text }`，新增後回傳 201 與新項目。
4. 建 `DELETE /api/todos/[id]`，刪除指定項目。
5. 用瀏覽器 / `curl` / Thunder Client 測試四個端點。

---

## 最後範例：待辦事項 REST API

> 一組用記憶體陣列當資料源的 CRUD API（重啟會清空，示範用；真正落地資料庫在第 9 章）。原樣建立以下檔案即可測試。

### `app/api/todos/store.js`（共用的假資料層）

```js
// 簡單的記憶體資料源，讓兩個 route 檔共用同一份陣列。
// 注意：dev 模式熱更新或重啟會重置，僅供 API 教學示範。
let todos = [
  { id: 1, text: "學會 Route Handler", done: false },
  { id: 2, text: "學會 Server Action", done: false },
];
let nextId = 3;

export function listTodos() {
  return todos;
}

export function addTodo(text) {
  const todo = { id: nextId++, text, done: false };
  todos.push(todo);
  return todo;
}

export function removeTodo(id) {
  const before = todos.length;
  todos = todos.filter((t) => t.id !== id);
  return todos.length < before; // 有沒有刪到東西
}
```

### `app/api/todos/route.js`（列表 + 新增）

```jsx
import { NextResponse } from "next/server";
import { listTodos, addTodo } from "./store";

// GET /api/todos → 回傳全部
export async function GET() {
  return NextResponse.json(listTodos());
}

// POST /api/todos → 新增一筆
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "body 必須是 JSON" }, { status: 400 });
  }

  const text = (body.text ?? "").trim();
  if (!text) {
    return NextResponse.json({ error: "text 不可為空" }, { status: 400 });
  }

  const todo = addTodo(text);
  return NextResponse.json(todo, { status: 201 });
}
```

### `app/api/todos/[id]/route.js`（刪除）

```jsx
import { NextResponse } from "next/server";
import { removeTodo } from "../store";

// DELETE /api/todos/:id → 刪除指定項目
export async function DELETE(request, { params }) {
  const { id } = await params; // Next.js 15：Promise
  const ok = removeTodo(Number(id));

  if (!ok) {
    return NextResponse.json({ error: "找不到該待辦" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
```

### 測試指令

```bash
# 列表
curl http://localhost:3000/api/todos

# 新增
curl -X POST http://localhost:3000/api/todos \
  -H "Content-Type: application/json" \
  -d '{"text":"寫完 Next.js 課程"}'

# 刪除 id=1
curl -X DELETE http://localhost:3000/api/todos/1
```

---

## 本章結語

你已經會用 Route Handler 建立對外的 REST API，也知道它和 Server Component 抓資料的分工。  
下一章進到 App Router 最有生產力的功能：**Server Actions**——不必手寫 API 與 fetch，就能處理表單與資料異動。
