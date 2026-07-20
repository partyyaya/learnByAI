# 第 2 章：App Router 檔案系統路由

## 本章目標

完成這一章後，你應該可以：

1. 說出資料夾與檔名如何對應到網址。
2. 建立巢狀路由與多層頁面。
3. 用 `<Link>` 做客戶端導覽，理解和 `<a>` 的差別。
4. 用 Route Groups `(group)` 整理結構而不影響網址。

---

## 1. 核心規則：資料夾就是網址

App Router 用「資料夾結構 = 網址結構」。關鍵是幾個**保留檔名**：

- `page.js`：這個資料夾對應的**頁面**（有它，這條網址才能被瀏覽）
- `layout.js`：包住該層與其子層的**共用版面**
- `loading.js` / `error.js` / `not-found.js`：載入、錯誤、找不到（第 4 章）

對應關係：

```text
app/
├─ page.js                 → /
├─ about/
│  └─ page.js              → /about
├─ blog/
│  ├─ page.js              → /blog
│  └─ settings/
│     └─ page.js           → /blog/settings
```

> 只有放了 `page.js` 的資料夾才會變成可瀏覽的網址。只有 `layout.js` 而沒有 `page.js` 的資料夾，本身不能被瀏覽。

---

## 2. 一個頁面長什麼樣

`page.js` 要 **default export 一個 React 元件**：

```jsx
// app/about/page.js  → 對應 /about
export default function AboutPage() {
  return <h1>關於我們</h1>;
}
```

就這麼簡單。不需要註冊路由表，不需要 import 任何 router，放對位置就生效。

---

## 3. 用 `<Link>` 做頁面切換

頁面之間切換要用 `next/link` 的 `<Link>`，不要用純 `<a>`：

```jsx
import Link from "next/link";

export default function Nav() {
  return (
    <nav>
      <Link href="/">首頁</Link>
      <Link href="/about">關於</Link>
      <Link href="/blog">文章</Link>
    </nav>
  );
}
```

差別：

> `<a>` 會整頁重新載入（白屏、丟失狀態）。`<Link>` 做**客戶端導覽**：只換需要換的部分、預先抓取（prefetch）目標頁，切換近乎瞬間。

`<Link>` 底層還是渲染成 `<a>`，所以 SEO 與可及性都沒問題。

---

## 4. 巢狀 Layout

每一層資料夾都可以有自己的 `layout.js`，它會包住該層所有頁面與子頁面。Layout 之間會**巢狀堆疊**：

```text
app/layout.js         ← 根版面（全站，含 <html><body>）
 └─ app/blog/layout.js ← 只包 /blog 及其子頁
     └─ app/blog/page.js
```

Layout 一定要接收並渲染 `children`：

```jsx
// app/blog/layout.js
export default function BlogLayout({ children }) {
  return (
    <div className="blog-shell">
      <aside>文章側邊欄（切頁時不會重繪）</aside>
      <section>{children}</section>
    </div>
  );
}
```

> 導覽時，共用的 Layout **不會重新渲染**，只有 `children`（頁面內容）會換。這就是為什麼側邊欄、頁首能保持狀態。

---

## 5. Route Groups：整理結構但不影響網址

用括號命名的資料夾 `(group)` 只是**整理用**，不會出現在網址裡。常用來把不同區塊套不同 Layout：

```text
app/
├─ (marketing)/
│  ├─ layout.js       # 行銷頁專用版面
│  ├─ page.js         → /        （注意：不是 /marketing）
│  └─ about/page.js   → /about
├─ (shop)/
│  ├─ layout.js       # 商店專用版面
│  └─ products/page.js → /products
```

`(marketing)` 與 `(shop)` 都不進網址，但各自有獨立 Layout。

---

## 6. 本章小練習

1. 建立 `/about`、`/blog`、`/blog/settings` 三個頁面。
2. 做一個放在根 Layout 的導覽列，能在四個頁面間切換。
3. 幫 `/blog` 加一層自己的 `layout.js`，放一個側邊欄，切到 `/blog/settings` 時側邊欄不重繪。
4. 觀察 Network 面板：用 `<Link>` 切頁時是否整頁重載？

---

## 最後範例：多頁面站台骨架

> 一個含導覽列、巢狀 blog 版面的可跑站台。原樣建立以下檔案即可。

### `app/layout.js`

```jsx
import "./globals.css";
import Link from "next/link";

export const metadata = { title: "多頁面站台骨架" };

export default function RootLayout({ children }) {
  return (
    <html lang="zh-Hant">
      <body>
        <header className="topbar">
          <strong>My Site</strong>
          <nav className="nav">
            <Link href="/">首頁</Link>
            <Link href="/about">關於</Link>
            <Link href="/blog">文章</Link>
          </nav>
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
```

### `app/page.js`

```jsx
export default function HomePage() {
  return (
    <section>
      <h1>首頁</h1>
      <p>這是用 App Router 檔案系統路由建立的站台。</p>
    </section>
  );
}
```

### `app/about/page.js`

```jsx
export default function AboutPage() {
  return (
    <section>
      <h1>關於我們</h1>
      <p>資料夾 about/ 自動對應到 /about。</p>
    </section>
  );
}
```

### `app/blog/layout.js`

```jsx
import Link from "next/link";

// 這層 Layout 只包 /blog 與其子頁；切換子頁時側邊欄不會重繪
export default function BlogLayout({ children }) {
  return (
    <div className="blog-shell">
      <aside className="sidebar">
        <h3>文章分類</h3>
        <ul>
          <li><Link href="/blog">全部</Link></li>
          <li><Link href="/blog/settings">文章設定</Link></li>
        </ul>
      </aside>
      <section className="blog-content">{children}</section>
    </div>
  );
}
```

### `app/blog/page.js`

```jsx
export default function BlogPage() {
  return (
    <div>
      <h1>文章列表</h1>
      <p>這裡之後會放真實文章（第 5、6 章）。</p>
    </div>
  );
}
```

### `app/blog/settings/page.js`

```jsx
export default function BlogSettingsPage() {
  return (
    <div>
      <h1>文章設定</h1>
      <p>網址是 /blog/settings，由巢狀資料夾自動產生。</p>
    </div>
  );
}
```

### `app/globals.css`

```css
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, "Segoe UI", sans-serif;
  color: #111827;
  background: #f3f4f6;
}
.topbar {
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 12px 24px;
  background: #111827;
  color: #fff;
}
.nav { display: flex; gap: 16px; }
.nav a { color: #d1d5db; text-decoration: none; }
.nav a:hover { color: #fff; }
.container { padding: 24px; }
.blog-shell { display: grid; grid-template-columns: 200px 1fr; gap: 24px; }
.sidebar { background: #fff; padding: 16px; border-radius: 12px; }
.sidebar ul { padding-left: 18px; }
.blog-content { background: #fff; padding: 24px; border-radius: 12px; }
```

---

## 本章結語

你已經能用資料夾把網址搭出來，也知道 `<Link>` 與巢狀 Layout 的威力。  
下一章進到 App Router 最重要、也最容易搞混的觀念：**Server Component 與 Client Component 的分界**。
