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

> `metadata` 和 `generateMetadata` 只能從 Server Component 的檔案 export。檔案開頭有 `"use client"` 時，build 會報錯。需要互動的頁面，把互動部分抽成 Client 元件，`page.js` 本身保持 Server Component，metadata 就能放在 `page.js`。

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

> 樣板只會套用到「下層」路由段。`app/page.js`（首頁）和根 Layout 在同一層，首頁自己寫的 `title` 不會套上 `| My Blog`。首頁通常直接用 `default` 那個標題。

---

## 3. generateMetadata：動態頁的 metadata

文章頁的 title 要用文章標題，這種「依資料而定」的 metadata 用 `generateMetadata`（async 函式）：

```jsx
// app/blog/[slug]/page.js
export async function generateMetadata({ params }) {
  const { slug } = await params; // Next.js 15：params 是 Promise
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

> `generateMetadata` 與頁面各自抓資料。如果用的是 `fetch`，Next.js 會**自動去重**：同一次請求裡相同的 fetch 只打一次，所以不用擔心抓兩次。

> 自動去重只對 `fetch` 有效。如果 `getPost` 是查資料庫（像 Prisma），同一次請求就會真的查兩次。要去重的話，用 React 的 `cache()` 把函式包起來：
>
> ```js
> import { cache } from "react";
> import { prisma } from "@/lib/prisma";
>
> export const getPost = cache(async (slug) => {
>   return prisma.post.findUnique({ where: { slug } });
> });
> ```

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

社群平台抓預覽圖時需要完整網址，所以相對路徑一定要靠 `metadataBase` 補成完整網址。沒設的話，Next.js 在 build 時會警告。自己架站時，它只能暫時用 `http://localhost:3000` 補，分享出去的圖就抓不到。上線前記得改成正式網域。

> **合併規則是「淺層」的**：子頁的 metadata 會和上層合併，但 `openGraph` 這種物件是整個覆蓋，不會逐欄合併。子頁只要寫了 `openGraph: { title: "…" }`，Layout 設的 `openGraph.images` 就不見了。需要共用的欄位，可以抽成一個常數，在子頁用展開運算子 `...` 帶進去。

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

> sitemap 與 robots 裡的網址要寫完整（含 `https://` 與網域），`metadataBase` 不會套用到這裡。實務上常把網域放進環境變數（例如第 14 章的 `NEXT_PUBLIC_SITE_URL`），避免到處寫死。

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

> 好處：每篇文章自動有一張帶標題的分享圖，不用美編手工做圖。放了這個檔，Next.js 會自動在該頁加上 `og:image`（以及 `twitter:image`）標籤，不用再手寫 `openGraph.images`。

寫這種 JSX 時有幾個和網頁不一樣的地方：

- 畫圖的引擎不是瀏覽器，只支援部分 CSS，排版用 flexbox。**一個 `<div>` 裡有兩個以上子元素時，一定要寫 `display: "flex"`**，否則會報錯。
- 中文字會在產生圖片時自動向 Google Fonts 抓 Noto Sans TC 來補，所以伺服器要能連外。想用自己的字型（或要確實顯示粗體），可以用 `ImageResponse` 的 `fonts` 選項載入字型檔。

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

> 驗證：造訪 `/blog/hello-nextjs`，檢視原始碼看 `<title>`（應為 `用 App Router 打造部落格 | My Blog`）、`<meta>` 有沒有出現；造訪 `/blog/hello-nextjs/opengraph-image` 看動態圖；造訪 `/sitemap.xml`、`/robots.txt`。原始碼裡 `og:image` 的網址，在 `npm run dev` 時會是 localhost，build 後則由 `metadataBase` 補成 `https://example.com/...`。換成正式網域後，就會指向你的站。

---

## 本章結語

你的頁面現在 SEO 完備、分享有預覽、搜尋引擎找得到。功能與賣相都到位了。  
下一章把最後一哩路走完：**測試與部署**，把專案推上 Vercel。
