# 第 13 章：SEO 與 Metadata

## 本章目標

完成這一章後，你應該可以：

1. 用靜態 `metadata` 設定頁面標題、描述。
2. 用 `generateMetadata` 為動態頁產生對應的 metadata。
3. 設定 Open Graph / Twitter Card，讓分享連結有漂亮預覽。
4. 用 `sitemap.js` 與 `robots.js` 產生 sitemap 與 robots.txt。
5. 產生動態 OG image。

---

## 1. 為什麼 Next.js 的 SEO 特別強

SPA 的問題：首頁 HTML 幾乎空白，`<title>` 與描述靠 JS 才補上，對爬蟲不友善。

Next.js 的 Server Component 在**伺服器就把完整 HTML（含 title、meta、內容）產好**送出，爬蟲一抓就有。加上 App Router 內建的 Metadata API，SEO 幾乎是「填空」等級的簡單。

---

## 2. 靜態 metadata

在 `layout.js` 或 `page.js` export 一個 `metadata` 物件即可：

```jsx
// app/about/page.js
export const metadata = {
  title: "關於我們",
  description: "這是一個用 Next.js 打造的部落格。",
};

export default function AboutPage() {
  return <h1>關於我們</h1>;
}
```

### 標題樣板（title template）

在根 Layout 設定樣板，子頁只要給主標，就會自動套上站名後綴：

```jsx
// app/layout.js
export const metadata = {
  title: {
    default: "My Blog",       // 沒設 title 的頁面用這個
    template: "%s | My Blog", // 子頁的 title 會套進 %s
  },
  description: "一個用 Next.js 打造的部落格",
};
```

之後子頁 `title: "關於我們"` 會顯示為 `關於我們 | My Blog`。

---

## 3. generateMetadata：動態頁的 metadata

文章頁的 title 要用文章標題，這種「依資料而定」的 metadata 用 `generateMetadata`（async 函式）：

```jsx
// app/blog/[slug]/page.js
export async function generateMetadata({ params }) {
  const { slug } = await params;
  const post = await getPost(slug);

  if (!post) return { title: "找不到文章" };

  return {
    title: post.title,
    description: post.excerpt,
  };
}

export default async function PostPage({ params }) {
  // …頁面本體
}
```

> `generateMetadata` 與頁面各自抓資料，但 Next.js 會**自動去重**（相同的 fetch 只打一次），所以不用擔心抓兩次。

---

## 4. Open Graph / Twitter：分享預覽

貼連結到 FB / LINE / X 時的預覽卡片，靠 Open Graph 與 Twitter Card：

```jsx
export const metadata = {
  title: "用 Next.js 打造部落格",
  description: "從路由到部署一次到位。",
  openGraph: {
    title: "用 Next.js 打造部落格",
    description: "從路由到部署一次到位。",
    url: "https://example.com/blog/nextjs",
    siteName: "My Blog",
    images: [{ url: "https://example.com/og.png", width: 1200, height: 630 }],
    type: "article",
  },
  twitter: {
    card: "summary_large_image",
    title: "用 Next.js 打造部落格",
    description: "從路由到部署一次到位。",
    images: ["https://example.com/og.png"],
  },
};
```

### metadataBase：讓相對路徑生效

設定 `metadataBase` 後，OG image 就能用相對路徑：

```jsx
// app/layout.js
export const metadata = {
  metadataBase: new URL("https://example.com"),
  openGraph: { images: ["/og-default.png"] }, // 會自動補成絕對網址
};
```

---

## 5. sitemap.js 與 robots.js

在 `app/` 根放這兩個檔，Next.js 會自動產生對應的 `/sitemap.xml` 與 `/robots.txt`：

```js
// app/sitemap.js  → /sitemap.xml
export default async function sitemap() {
  const posts = await getPosts();
  const postUrls = posts.map((p) => ({
    url: `https://example.com/blog/${p.slug}`,
    lastModified: p.updatedAt,
  }));

  return [
    { url: "https://example.com", lastModified: new Date() },
    { url: "https://example.com/about" },
    ...postUrls,
  ];
}
```

```js
// app/robots.js  → /robots.txt
export default function robots() {
  return {
    rules: { userAgent: "*", allow: "/", disallow: "/dashboard/" },
    sitemap: "https://example.com/sitemap.xml",
  };
}
```

---

## 6. 動態 OG image

用 `next/og` 的 `ImageResponse` 在檔案 `opengraph-image.js` 裡「用 JSX 畫」一張分享圖，Next.js 會即時產生 PNG：

```jsx
// app/blog/[slug]/opengraph-image.js
import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image({ params }) {
  const { slug } = await params;
  const post = await getPost(slug);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%", height: "100%", display: "flex",
          alignItems: "center", justifyContent: "center",
          background: "#111827", color: "#fff", fontSize: 64, padding: 80,
        }}
      >
        {post?.title ?? "My Blog"}
      </div>
    ),
    size
  );
}
```

> 好處：每篇文章自動有一張帶標題的分享圖，不用美編手工做圖。

---

## 7. 本章小練習

1. 在根 Layout 設 title template `%s | My Blog` 與預設描述。
2. 幫文章動態頁用 `generateMetadata` 帶入文章標題與摘要。
3. 加 Open Graph 與 Twitter Card，用線上工具檢查預覽。
4. 加 `sitemap.js` 與 `robots.js`，開 `/sitemap.xml` 確認。
5. 進階：用 `opengraph-image.js` 幫文章產生動態 OG 圖。

---

## 最後範例：文章頁完整 SEO

> 一個帶完整 metadata（含 title template、OG、Twitter）與動態 OG image 的文章頁。用記憶體資料示範，原樣建立即可跑。

### `lib/posts.js`（假資料）

```js
const POSTS = {
  "hello-nextjs": {
    slug: "hello-nextjs",
    title: "用 App Router 打造部落格",
    excerpt: "從路由、資料到部署，一次到位。",
    content: "這是文章內文……",
  },
  "server-components": {
    slug: "server-components",
    title: "Server Components 心法",
    excerpt: "預設 Server，需要互動才 Client。",
    content: "這是文章內文……",
  },
};

export async function getPost(slug) {
  return POSTS[slug] ?? null;
}
export async function getAllPosts() {
  return Object.values(POSTS);
}
```

### `app/layout.js`（title template + metadataBase）

```jsx
import "./globals.css";

export const metadata = {
  metadataBase: new URL("https://example.com"),
  title: { default: "My Blog", template: "%s | My Blog" },
  description: "一個用 Next.js App Router 打造的部落格",
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
```

### `app/blog/[slug]/page.js`（generateMetadata + 內容）

```jsx
import { notFound } from "next/navigation";
import { getPost } from "@/lib/posts";

// 依文章資料動態產生 metadata
export async function generateMetadata({ params }) {
  const { slug } = await params;
  const post = await getPost(slug);
  if (!post) return { title: "找不到文章" };

  return {
    title: post.title,
    description: post.excerpt,
    openGraph: {
      title: post.title,
      description: post.excerpt,
      type: "article",
      url: `/blog/${post.slug}`,
    },
    twitter: {
      card: "summary_large_image",
      title: post.title,
      description: post.excerpt,
    },
  };
}

export default async function PostPage({ params }) {
  const { slug } = await params;
  const post = await getPost(slug);
  if (!post) notFound();

  return (
    <main className="wrap">
      <h1>{post.title}</h1>
      <p className="excerpt">{post.excerpt}</p>
      <p>{post.content}</p>
    </main>
  );
}
```

### `app/blog/[slug]/opengraph-image.js`（動態分享圖）

```jsx
import { ImageResponse } from "next/og";
import { getPost } from "@/lib/posts";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image({ params }) {
  const { slug } = await params;
  const post = await getPost(slug);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%", height: "100%", display: "flex", flexDirection: "column",
          justifyContent: "center", padding: 80, background: "#0f172a", color: "#fff",
        }}
      >
        <div style={{ fontSize: 28, color: "#93c5fd" }}>My Blog</div>
        <div style={{ fontSize: 64, fontWeight: 700, marginTop: 12 }}>
          {post?.title ?? "文章"}
        </div>
      </div>
    ),
    size
  );
}
```

### `app/sitemap.js`

```js
import { getAllPosts } from "@/lib/posts";

export default async function sitemap() {
  const posts = await getAllPosts();
  return [
    { url: "https://example.com" },
    ...posts.map((p) => ({ url: `https://example.com/blog/${p.slug}` })),
  ];
}
```

### `app/robots.js`

```js
export default function robots() {
  return {
    rules: { userAgent: "*", allow: "/", disallow: "/dashboard/" },
    sitemap: "https://example.com/sitemap.xml",
  };
}
```

### 樣式（加進 `app/globals.css`）

```css
.wrap { max-width: 680px; margin: 40px auto; font-family: sans-serif; padding: 0 16px; line-height: 1.8; }
.excerpt { color: #6b7280; }
```

> 驗證：造訪 `/blog/hello-nextjs`，檢視原始碼看 `<title>`、`<meta>` 有沒有出現；造訪 `/blog/hello-nextjs/opengraph-image` 看動態圖；造訪 `/sitemap.xml`、`/robots.txt`。

---

## 本章結語

你的頁面現在 SEO 完備、分享有預覽、搜尋引擎找得到。功能與賣相都到位了。  
下一章把最後一哩路走完：**測試與部署**，把專案推上 Vercel。
