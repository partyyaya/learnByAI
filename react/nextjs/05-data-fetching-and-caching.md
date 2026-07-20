# 第 5 章：資料抓取與快取基礎

## 本章目標

完成這一章後，你應該可以：

1. 在 Server Component 內用 `async/await` 直接抓資料。
2. 用 `fetch` 的快取選項控制「抓一次」還是「每次重抓」。
3. 用 `revalidate` 做定時重新驗證（ISR 的基礎）。
4. 用 `Suspense` 做串流，讓慢的區塊不擋住快的區塊。
5. 分辨平行抓取與瀑布式抓取，避免不必要的等待。

---

## 1. 在伺服器抓資料，不再需要 useEffect

在 React 課你用 `useEffect` + `useState` 或 TanStack Query 抓資料。App Router 更直接——**Server Component 可以是 async，直接 `await`**：

```jsx
// app/users/page.js （Server Component）
export default async function UsersPage() {
  const res = await fetch("https://jsonplaceholder.typicode.com/users");
  const users = await res.json();

  return (
    <ul>
      {users.map((u) => (
        <li key={u.id}>{u.name}</li>
      ))}
    </ul>
  );
}
```

好處：

> 資料在伺服器抓好、HTML 直接帶著資料送到瀏覽器。沒有「先空白、再閃一下、才出現」的問題，對 SEO 也友善。不用 loading state、不用 `useEffect`。

---

## 2. 快取：這次 fetch 要不要重抓？

Next.js 會依 `fetch` 的選項決定快取行為。三種最常用：

```jsx
// (A) 預設在 Next.js 15：不快取，每次請求都重抓（等同 no-store）
await fetch(url);

// (B) 明確快取，建置後就固定（適合不常變的資料）
await fetch(url, { cache: "force-cache" });

// (C) 定時重新驗證：最多 60 秒用舊資料，過期後下次請求時背景更新
await fetch(url, { next: { revalidate: 60 } });
```

> 版本差異提醒：Next.js 14 的 `fetch` 預設會快取；**Next.js 15 預設不快取**。要快取請明確寫 `cache: "force-cache"` 或 `next: { revalidate }`。本課以 Next.js 15 行為為準。

選擇原則：

- 即時性高（庫存、價格、個人資料）→ 不快取。
- 幾乎不變（文章內容、設定）→ `force-cache` 或長 `revalidate`。
- 折衷（列表、統計）→ `revalidate: 秒數`。

---

## 3. revalidate = ISR（增量靜態再生）

`next: { revalidate: 60 }` 的意思是：

1. 第一個人來，抓資料、產生頁面、快取起來。
2. 60 秒內來的人，直接吃快取（超快）。
3. 60 秒後第一個來的人，先拿到舊頁面，Next.js 在背景重抓、更新快取。
4. 之後的人就吃到新版。

這叫 **ISR**：既有靜態頁的速度，又能定時更新。第 12 章會更深入。

---

## 4. 串流：用 Suspense 讓慢區塊不擋住整頁

一個頁面常常有「快的部分」和「慢的部分」。如果整頁一起 `await`，使用者要等最慢的那塊。用 `<Suspense>` 可以**先送出快的，慢的邊好邊補上**：

```jsx
import { Suspense } from "react";

async function SlowStats() {
  await new Promise((r) => setTimeout(r, 2000)); // 模擬慢查詢
  return <p>統計：1280 次造訪</p>;
}

export default function Page() {
  return (
    <div>
      <h1>立刻出現的標題</h1>
      {/* 這塊慢，但不擋住上面的標題 */}
      <Suspense fallback={<p>統計載入中…</p>}>
        <SlowStats />
      </Suspense>
    </div>
  );
}
```

> `loading.js`（第 4 章）其實就是「整頁包一層 Suspense」；這裡是手動、更細緻地只包住慢的區塊。

---

## 5. 平行 vs 瀑布式抓取

**瀑布式（慢）**：一個 `await` 完才做下一個，時間會累加。

```jsx
const user = await getUser();     // 等 1 秒
const posts = await getPosts();   // 再等 1 秒 → 總共 2 秒
```

**平行（快）**：兩個沒有相依，就一起發，用 `Promise.all`：

```jsx
const [user, posts] = await Promise.all([getUser(), getPosts()]);
// 兩個同時進行 → 約 1 秒
```

> 原則：**沒有相依關係的抓取一律平行。** 只有「後一個需要前一個的結果」時，才照順序 await。

---

## 6. 本章小練習

1. 用公開 API（如 `jsonplaceholder.typicode.com/posts`）在 Server Component 抓文章列表並顯示。
2. 分別試 `no-store`、`force-cache`、`revalidate: 10`，重新整理觀察差異。
3. 把「文章列表」和「一個模擬慢 2 秒的統計區」用兩個 `Suspense` 分開，觀察串流。
4. 把兩個獨立抓取改成 `Promise.all`，比較載入時間。

---

## 最後範例：文章列表 + 詳情（含 streaming）

> 一個 `/posts` 列表頁，標題與列表立即出現，慢的「站台統計」用 Suspense 串流補上。原樣建立即可跑（用公開 API）。

### `app/posts/page.js`

```jsx
import { Suspense } from "react";
import Link from "next/link";
import Stats from "./Stats";

// 列表：定時重新驗證，60 秒內吃快取
async function getPosts() {
  const res = await fetch("https://jsonplaceholder.typicode.com/posts", {
    next: { revalidate: 60 },
  });
  if (!res.ok) throw new Error("文章載入失敗");
  const posts = await res.json();
  return posts.slice(0, 8); // 只取前 8 筆示範
}

export default async function PostsPage() {
  const posts = await getPosts();

  return (
    <main className="wrap">
      <h1>文章列表</h1>

      {/* 慢區塊用 Suspense 包住，不擋住下面的列表 */}
      <Suspense fallback={<p className="muted">統計載入中…</p>}>
        <Stats />
      </Suspense>

      <ul className="post-list">
        {posts.map((p) => (
          <li key={p.id}>
            <Link href={`/posts/${p.id}`}>{p.title}</Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
```

### `app/posts/Stats.js`

```jsx
// 模擬一個慢查詢，示範 streaming：頁面其他部分不會被它擋住
export default async function Stats() {
  await new Promise((r) => setTimeout(r, 2000));
  return <p className="stats">目前共有 100 篇文章、1280 次造訪。</p>;
}
```

### `app/posts/[id]/page.js`

```jsx
import Link from "next/link";
import { notFound } from "next/navigation";

async function getPost(id) {
  const res = await fetch(`https://jsonplaceholder.typicode.com/posts/${id}`, {
    next: { revalidate: 60 },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("文章載入失敗");
  return res.json();
}

export default async function PostDetailPage({ params }) {
  const { id } = await params; // Next.js 15：params 是 Promise
  const post = await getPost(id);
  if (!post) notFound();

  return (
    <main className="wrap">
      <Link href="/posts">← 回列表</Link>
      <h1>{post.title}</h1>
      <p>{post.body}</p>
    </main>
  );
}
```

### 樣式（加進 `app/globals.css`）

```css
.wrap { max-width: 680px; margin: 40px auto; font-family: sans-serif; padding: 0 16px; }
.muted { color: #9ca3af; }
.stats { background: #eff6ff; padding: 8px 12px; border-radius: 8px; color: #1d4ed8; }
.post-list { padding-left: 18px; line-height: 1.9; }
.post-list a { color: #2563eb; text-decoration: none; }
.post-list a:hover { text-decoration: underline; }
```

---

## 本章結語

你已經會在伺服器直接抓資料、控制快取、用 Suspense 串流、用 `Promise.all` 平行加速——這是 App Router 效能的核心。  
下一章把 `[id]` 這種**動態路由**講透，讓文章詳情、分類頁、分頁篩選都能自動生成。
