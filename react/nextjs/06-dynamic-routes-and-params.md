# 第 6 章：動態路由與參數

## 本章目標

完成這一章後，你應該可以：

1. 用 `[id]` 建立動態路由段，讀取 `params`。
2. 用 `[...slug]` 做 Catch-all 路由。
3. 讀取 `searchParams`（查詢字串）做篩選與分頁。
4. 用 `generateStaticParams` 預先產生靜態頁面。
5. 正確處理找不到的情況（`notFound()`）。

---

## 1. 動態段 `[id]`

用中括號命名資料夾，就成為動態段。網址那一段的值會透過 `params` 傳進頁面：

```text
app/products/[id]/page.js
  /products/1   → params.id === "1"
  /products/abc → params.id === "abc"
```

```jsx
// app/products/[id]/page.js
export default async function ProductPage({ params }) {
  const { id } = await params; // Next.js 15：params 是 Promise，要 await
  return <h1>商品編號：{id}</h1>;
}
```

> **Next.js 15 重點**：`params` 與 `searchParams` 現在是 **Promise**，一定要 `await`（或在 Client 元件用 `use()`）。看到舊教學直接 `params.id` 不 await，那是 14 以前的寫法。

---

## 2. Catch-all `[...slug]` 與 Optional `[[...slug]]`

要一次接住多層路徑，用展開語法：

```text
app/docs/[...slug]/page.js
  /docs/a        → params.slug === ["a"]
  /docs/a/b/c    → params.slug === ["a", "b", "c"]
```

```jsx
export default async function DocsPage({ params }) {
  const { slug } = await params; // 陣列
  return <p>路徑：{slug.join(" / ")}</p>;
}
```

- `[...slug]`：至少要有一段（`/docs` 本身不匹配）。
- `[[...slug]]`（雙中括號）：**可選**，連 `/docs` 也匹配，此時 `slug` 是 `undefined`。

---

## 3. searchParams：查詢字串

`?page=2&sort=new` 這種查詢字串，透過 `searchParams` 拿到（只有 `page.js` 有，layout 沒有）：

```jsx
// /products?category=book&page=2
export default async function ProductsPage({ searchParams }) {
  const sp = await searchParams; // Next.js 15：也是 Promise
  const category = sp.category ?? "all";
  const page = Number(sp.page ?? "1");
  return <p>分類 {category}，第 {page} 頁</p>;
}
```

> 用 `searchParams` 做篩選/分頁時，該頁會變成**動態渲染**（每次請求都重算），因為查詢字串在建置時未知。這很合理，也是預期行為。

要改查詢字串，在 Client 端用 `<Link href="/products?page=2">` 或 `router.push`。

---

## 4. generateStaticParams：預先產生靜態頁

如果動態頁的所有可能值在建置時就已知（例如所有文章 slug），可以用 `generateStaticParams` 讓 Next.js **在 build 時就把每一頁產生成靜態 HTML**（等同舊的 `getStaticPaths`）：

```jsx
// app/blog/[slug]/page.js

// build 時執行：回傳所有要預先產生的 params
export async function generateStaticParams() {
  const posts = await fetch("https://.../posts").then((r) => r.json());
  return posts.map((p) => ({ slug: p.slug }));
}

export default async function PostPage({ params }) {
  const { slug } = await params;
  // …用 slug 抓該篇文章
}
```

好處：這些頁在 build 時就變成靜態檔，上線後超快、又能被 CDN 快取。

---

## 5. 找不到就 notFound()

動態路由常會收到不存在的 id，記得處理：

```jsx
import { notFound } from "next/navigation";

export default async function Page({ params }) {
  const { id } = await params;
  const product = await getProduct(id);
  if (!product) notFound(); // 顯示最近的 not-found.js，並回應 404
  return <h1>{product.name}</h1>;
}
```

搭配同層或上層的 `not-found.js`（第 4 章）就能有漂亮的 404 畫面，也對 SEO 正確（真的回 404 狀態碼）。

---

## 6. 本章小練習

1. 建立 `/products/[id]`，顯示該 id 的商品（用公開 API）。
2. 建立 `/products` 列表，用 `<Link>` 連到各個 `[id]`。
3. 加 `?category=` 與 `?page=` 篩選/分頁，讀 `searchParams`。
4. 對不存在的 id 呼叫 `notFound()`，並加上 `not-found.js`。
5. 用 `generateStaticParams` 預產前 10 個商品頁，`npm run build` 觀察輸出。

---

## 最後範例：部落格文章動態頁 + 分頁/篩選

> `/blog` 列表支援分頁與關鍵字篩選，`/blog/[id]` 顯示詳情並預先靜態產生。用公開 API，原樣建立即可跑。

### `app/blog/page.js`（列表 + 分頁/篩選）

```jsx
import Link from "next/link";

const PAGE_SIZE = 5;

async function getPosts() {
  const res = await fetch("https://jsonplaceholder.typicode.com/posts", {
    next: { revalidate: 60 },
  });
  if (!res.ok) throw new Error("載入失敗");
  return res.json();
}

export default async function BlogPage({ searchParams }) {
  const sp = await searchParams; // Next.js 15：Promise
  const keyword = (sp.q ?? "").toLowerCase();
  const page = Math.max(1, Number(sp.page ?? "1"));

  const all = await getPosts();
  const filtered = keyword
    ? all.filter((p) => p.title.toLowerCase().includes(keyword))
    : all;

  const start = (page - 1) * PAGE_SIZE;
  const pagePosts = filtered.slice(start, start + PAGE_SIZE);
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);

  return (
    <main className="wrap">
      <h1>部落格</h1>

      {/* 篩選：用 GET 表單，送出後變成 ?q=... */}
      <form className="filter" action="/blog" method="get">
        <input name="q" defaultValue={sp.q ?? ""} placeholder="搜尋標題…" />
        <button type="submit">搜尋</button>
      </form>

      <ul className="post-list">
        {pagePosts.map((p) => (
          <li key={p.id}>
            <Link href={`/blog/${p.id}`}>{p.title}</Link>
          </li>
        ))}
        {pagePosts.length === 0 && <li className="muted">沒有符合的文章</li>}
      </ul>

      <nav className="pager">
        {page > 1 && (
          <Link href={`/blog?q=${sp.q ?? ""}&page=${page - 1}`}>← 上一頁</Link>
        )}
        <span>第 {page} / {totalPages || 1} 頁</span>
        {page < totalPages && (
          <Link href={`/blog?q=${sp.q ?? ""}&page=${page + 1}`}>下一頁 →</Link>
        )}
      </nav>
    </main>
  );
}
```

### `app/blog/[id]/page.js`（詳情 + 靜態產生）

```jsx
import Link from "next/link";
import { notFound } from "next/navigation";

async function getPost(id) {
  const res = await fetch(`https://jsonplaceholder.typicode.com/posts/${id}`, {
    next: { revalidate: 60 },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("載入失敗");
  return res.json();
}

// build 時預先產生前 10 篇的靜態頁
export async function generateStaticParams() {
  return Array.from({ length: 10 }, (_, i) => ({ id: String(i + 1) }));
}

export default async function PostPage({ params }) {
  const { id } = await params;
  const post = await getPost(id);
  if (!post) notFound();

  return (
    <main className="wrap">
      <Link href="/blog">← 回列表</Link>
      <h1>{post.title}</h1>
      <p>{post.body}</p>
    </main>
  );
}
```

### `app/blog/[id]/not-found.js`

```jsx
import Link from "next/link";

export default function NotFound() {
  return (
    <main className="wrap">
      <h1>找不到這篇文章</h1>
      <Link href="/blog">← 回列表</Link>
    </main>
  );
}
```

### 樣式（加進 `app/globals.css`）

```css
.wrap { max-width: 680px; margin: 40px auto; font-family: sans-serif; padding: 0 16px; }
.muted { color: #9ca3af; }
.filter { display: flex; gap: 8px; margin: 16px 0; }
.filter input { flex: 1; padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 8px; }
.filter button { padding: 8px 14px; border: 0; border-radius: 8px; background: #2563eb; color: #fff; cursor: pointer; }
.post-list { padding-left: 18px; line-height: 2; }
.post-list a { color: #2563eb; text-decoration: none; }
.pager { display: flex; gap: 16px; align-items: center; margin-top: 20px; }
.pager a { color: #2563eb; text-decoration: none; }
```

---

## 本章結語

你已經能用動態路由、查詢字串、靜態預產把「有很多筆資料的頁面」自動長出來。  
下一章換個角度：不只顯示資料，還要**提供 API**——用 Route Handlers 在 `app/api` 建立自己的後端端點。
