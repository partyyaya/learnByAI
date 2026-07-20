# 第 4 章：版面、載入與錯誤處理

## 本章目標

完成這一章後，你應該可以：

1. 用 `layout.js` 設計共用版面，理解它與 `template.js` 的差別。
2. 用 `loading.js` 做載入骨架（底層是 Suspense）。
3. 用 `error.js` 攔截並復原錯誤（底層是 Error Boundary）。
4. 用 `not-found.js` 處理找不到的情況。
5. 在 Client 元件用 `usePathname` / `useRouter` 做導覽狀態。

---

## 1. Layout：跨頁共用、切頁不重繪

`layout.js` 包住同層與子層的所有頁面，**切換頁面時它不會重新渲染**，很適合放頁首、側邊欄、頁尾。

```jsx
// app/dashboard/layout.js
export default function DashboardLayout({ children }) {
  return (
    <div className="dash">
      <aside>側邊欄（切子頁時保留狀態）</aside>
      <main>{children}</main>
    </div>
  );
}
```

根 `app/layout.js` 是必要的，且必須包含 `<html>` 與 `<body>`。

### Layout vs Template

- `layout.js`：切頁時**保留**（不重繪、狀態留著）。
- `template.js`：切頁時**每次重建**（重置狀態、重跑動畫）。

大多數情況用 `layout.js`。只有在「每次進頁都要重跑進場動畫或重置」時才用 `template.js`。

---

## 2. loading.js：自動載入狀態

當某頁是 async（在伺服器抓資料）時，資料還沒好之前，Next.js 會**自動顯示同層的 `loading.js`**。你不用自己寫 loading 狀態的 `useState`。

```jsx
// app/dashboard/loading.js
export default function Loading() {
  return <p>載入中…</p>;
}
```

它底層就是把頁面包進 React `<Suspense>`。所以：

> 頁面在伺服器 `await` 資料的期間，使用者先看到 `loading.js`；資料好了再換成真正內容——這就是「串流」的基礎（第 5 章深入）。

---

## 3. error.js：攔截錯誤並提供復原

同層任何地方 throw 錯誤，會被 `error.js` 接住，顯示備援 UI，而不是整站崩掉。

**`error.js` 必須是 Client Component**（要用到 `reset` 這種互動）：

```jsx
// app/dashboard/error.js
"use client";

export default function Error({ error, reset }) {
  return (
    <div>
      <h2>這個區塊出錯了</h2>
      <p>{error.message}</p>
      {/* reset() 會嘗試重新渲染這段，讓使用者重試 */}
      <button onClick={() => reset()}>再試一次</button>
    </div>
  );
}
```

- `error`：被丟出的錯誤物件。
- `reset()`：重新嘗試渲染出錯的段落。

> `error.js` 只攔它「子層」的錯誤，攔不到同層 `layout.js` 自己的錯。要攔 Layout 的錯，得放在**上一層**。

---

## 4. not-found.js 與 notFound()

`not-found.js` 是「找不到」的畫面。你可以在程式裡呼叫 `notFound()` 主動觸發它：

```jsx
// app/blog/[slug]/page.js
import { notFound } from "next/navigation";

export default async function Page({ params }) {
  const { slug } = await params; // Next.js 15：params 是 Promise，要 await
  const post = await getPost(slug);
  if (!post) notFound(); // 觸發最近的 not-found.js
  return <article>{post.title}</article>;
}
```

```jsx
// app/blog/[slug]/not-found.js
export default function NotFound() {
  return <p>找不到這篇文章。</p>;
}
```

---

## 5. 導覽狀態：usePathname / useRouter

要在導覽列「標示目前在哪一頁」，需要知道目前路徑——這是瀏覽器行為，得用 Client Component：

```jsx
"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

export default function NavItem({ href, children }) {
  const pathname = usePathname();        // 目前網址路徑
  const isActive = pathname === href;
  return (
    <Link href={href} className={isActive ? "active" : ""}>
      {children}
    </Link>
  );
}
```

`useRouter` 則用於程式化導覽（例如送出後跳頁）：

```jsx
"use client";
import { useRouter } from "next/navigation";

function BackButton() {
  const router = useRouter();
  return <button onClick={() => router.back()}>返回</button>;
  // 也有 router.push("/path")、router.refresh()
}
```

> 注意：App Router 的這些 hook 來自 `next/navigation`，**不是** 舊的 `next/router`。

---

## 6. 這些檔案怎麼疊在一起

同一層資料夾裡，Next.js 會自動把它們包成這個結構：

```text
<Layout>
  <ErrorBoundary fallback={error.js}>
    <Suspense fallback={loading.js}>
      <NotFoundBoundary fallback={not-found.js}>
        <Page />   ← 你的 page.js
      </NotFoundBoundary>
    </Suspense>
  </ErrorBoundary>
</Layout>
```

你只要放對檔名，這套包裝就自動生效。

---

## 7. 本章小練習

1. 幫 `/dashboard` 加一個帶側邊欄的 `layout.js`。
2. 讓 dashboard 頁 async 等待 2 秒（模擬抓資料），加上 `loading.js` 觀察載入畫面。
3. 在頁面裡 `throw new Error("測試")`，加 `error.js` 並讓「再試一次」可運作。
4. 把導覽列改成能標示 active 的 `NavItem`（用 `usePathname`）。

---

## 最後範例：帶側邊欄的後台版面 + loading/error 狀態

> 五個檔案組成一個 `/dashboard` 區塊，示範 Layout + loading + error + 導覽 active 狀態。

### `app/dashboard/layout.js`

```jsx
import NavItem from "./NavItem";

export default function DashboardLayout({ children }) {
  return (
    <div className="dash">
      <aside className="dash-side">
        <h3>後台</h3>
        <nav className="dash-nav">
          <NavItem href="/dashboard">總覽</NavItem>
          <NavItem href="/dashboard/reports">報表</NavItem>
        </nav>
      </aside>
      <main className="dash-main">{children}</main>
    </div>
  );
}
```

### `app/dashboard/NavItem.js`

```jsx
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export default function NavItem({ href, children }) {
  const pathname = usePathname();
  const isActive = pathname === href;
  return (
    <Link href={href} className={`nav-item ${isActive ? "active" : ""}`}>
      {children}
    </Link>
  );
}
```

### `app/dashboard/page.js`

```jsx
// async 頁面：等待期間會顯示同層 loading.js
export default async function DashboardPage() {
  // 模擬抓資料 1.5 秒
  await new Promise((r) => setTimeout(r, 1500));
  const stats = { users: 128, posts: 56 };

  return (
    <div>
      <h1>總覽</h1>
      <ul>
        <li>使用者：{stats.users}</li>
        <li>文章：{stats.posts}</li>
      </ul>
    </div>
  );
}
```

### `app/dashboard/loading.js`

```jsx
export default function Loading() {
  return (
    <div>
      <h1>總覽</h1>
      <p className="skeleton">載入中…</p>
    </div>
  );
}
```

### `app/dashboard/error.js`

```jsx
"use client";

export default function DashboardError({ error, reset }) {
  return (
    <div className="error-box">
      <h2>後台載入失敗</h2>
      <p>{error.message}</p>
      <button onClick={() => reset()}>再試一次</button>
    </div>
  );
}
```

### 樣式（加進 `app/globals.css`）

```css
.dash { display: grid; grid-template-columns: 200px 1fr; min-height: 100vh; }
.dash-side { background: #111827; color: #fff; padding: 20px; }
.dash-nav { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.nav-item { color: #cbd5e1; text-decoration: none; padding: 6px 10px; border-radius: 8px; }
.nav-item:hover { background: #1f2937; color: #fff; }
.nav-item.active { background: #2563eb; color: #fff; }
.dash-main { padding: 24px; }
.skeleton { color: #9ca3af; }
.error-box { border: 1px solid #fecaca; background: #fef2f2; padding: 16px; border-radius: 12px; }
```

---

## 本章結語

你已經能用檔名約定把版面、載入、錯誤、找不到都組起來，頁面骨架就完整了。  
下一章正式進入 Next.js 的重頭戲：在 Server Component 裡**直接抓資料**，並用快取與串流讓它又快又穩。
