# 第 11 章：樣式、字型與圖片優化

## 本章目標

完成這一章後，你應該可以：

1. 用 CSS Modules 做元件層級樣式。
2. 在 Next.js 專案整合 Tailwind CSS。
3. 用 `next/font` 自動優化字型、避免版面跳動。
4. 用 `next/image` 做圖片優化（尺寸、lazy load、避免 CLS）。
5. 用靜態資源與遠端圖片。

---

## 1. 三種樣式方案

Next.js 支援多種 CSS，常用三種：

- **全域 CSS**：`app/globals.css`，在根 Layout import，套用全站。
- **CSS Modules**：`xxx.module.css`，class 自動加雜湊，不會互相污染。
- **Tailwind CSS**：utility class，開發快、風格一致。

本章 CSS Modules 與 Tailwind 各講一種，你依團隊習慣選。

---

## 2. CSS Modules

檔名以 `.module.css` 結尾，import 進來後用物件取用 class：

```css
/* app/components/Card.module.css */
.card {
  border-radius: 12px;
  padding: 16px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
}
.title { font-size: 18px; font-weight: 700; }
```

```jsx
// app/components/Card.js
import styles from "./Card.module.css";

export default function Card({ title, children }) {
  return (
    <div className={styles.card}>
      <h3 className={styles.title}>{title}</h3>
      {children}
    </div>
  );
}
```

> `styles.card` 會被編譯成像 `Card_card__a1b2c` 的唯一 class，所以不同檔案用同名 `.card` 也不會打架。

---

## 3. Tailwind CSS

建立專案時可直接勾 Tailwind；若沒勾，之後也能加。裝好後直接在 `className` 用 utility：

```jsx
export default function Card({ title, children }) {
  return (
    <div className="rounded-xl p-4 shadow-md bg-white">
      <h3 className="text-lg font-bold mb-2">{title}</h3>
      <div className="text-gray-600">{children}</div>
    </div>
  );
}
```

好處是不用切檔案、命名，風格也一致。缺點是 class 會長。兩種方案沒有絕對優劣，看團隊。

---

## 4. next/font：字型優化

用 `next/font` 載入字型，Next.js 會在 build 時自我託管字型檔（不連 Google 伺服器）、自動 `font-display: swap`、並保留空間避免版面跳動：

```jsx
// app/layout.js
import { Inter, Noto_Sans_TC } from "next/font/google";

const inter = Inter({ subsets: ["latin"] });
const notoTC = Noto_Sans_TC({ subsets: ["latin"], weight: ["400", "700"] });

export default function RootLayout({ children }) {
  return (
    <html lang="zh-Hant" className={notoTC.className}>
      <body>{children}</body>
    </html>
  );
}
```

> 好處：字型檔和你的站一起部署，沒有第三方請求（更快、更隱私），也不會有「字型載入完才跳字」的閃動（FOUT）。

---

## 5. next/image：圖片優化

`<Image>` 會自動：依裝置給合適尺寸、轉現代格式（WebP/AVIF）、lazy load、保留空間避免版面位移（CLS）。

### 本地圖片（放在 public/）

```jsx
import Image from "next/image";

export default function Logo() {
  return (
    <Image
      src="/logo.png"   // 對應 public/logo.png
      alt="站標"
      width={120}
      height={40}
    />
  );
}
```

`width`/`height` 是必要的（除非用 `fill`），用來預留空間、避免載入時版面跳動。

### 填滿容器（fill）

當你不知道確切尺寸、想讓圖片填滿一個容器：

```jsx
<div style={{ position: "relative", width: "100%", height: 200 }}>
  <Image src="/cover.jpg" alt="封面" fill style={{ objectFit: "cover" }} />
</div>
```

### 遠端圖片：要先允許網域

用外部網址的圖片，必須在 `next.config.mjs` 白名單網域，否則報錯：

```js
// next.config.mjs
const nextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "images.unsplash.com" },
    ],
  },
};
export default nextConfig;
```

---

## 6. 本章小練習

1. 做一個 `Card` 元件，分別用 CSS Modules 與（若有裝）Tailwind 各實作一次。
2. 在根 Layout 用 `next/font` 套一個中文字型（如 Noto Sans TC）。
3. 用 `next/image` 放一張 `public/` 的本地圖片，設定正確 `width`/`height`。
4. 用 `fill` 做一張填滿卡片的封面圖。
5. 允許一個遠端圖片網域，載入一張 Unsplash 圖。

---

## 最後範例：套版的文章卡片列表

> 用 CSS Modules + next/font + next/image 做出一排文章卡片。原樣建立以下檔案即可跑（圖片用遠端 Unsplash，記得設定 next.config）。

### `next.config.mjs`

```js
const nextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "images.unsplash.com" },
    ],
  },
};
export default nextConfig;
```

### `app/layout.js`

```jsx
import "./globals.css";
import { Noto_Sans_TC } from "next/font/google";

const notoTC = Noto_Sans_TC({ subsets: ["latin"], weight: ["400", "700"] });

export const metadata = { title: "文章卡片列表" };

export default function RootLayout({ children }) {
  return (
    <html lang="zh-Hant" className={notoTC.className}>
      <body>{children}</body>
    </html>
  );
}
```

### `app/components/PostCard.module.css`

```css
.card {
  background: #fff;
  border-radius: 16px;
  overflow: hidden;
  box-shadow: 0 6px 20px rgba(17, 24, 39, 0.08);
  display: flex;
  flex-direction: column;
}
.cover { position: relative; width: 100%; height: 160px; }
.body { padding: 16px; }
.title { font-size: 18px; font-weight: 700; margin: 0 0 8px; }
.excerpt { color: #6b7280; font-size: 14px; margin: 0; }
```

### `app/components/PostCard.js`

```jsx
import Image from "next/image";
import styles from "./PostCard.module.css";

export default function PostCard({ post }) {
  return (
    <article className={styles.card}>
      <div className={styles.cover}>
        <Image
          src={post.cover}
          alt={post.title}
          fill
          style={{ objectFit: "cover" }}
          sizes="(max-width: 640px) 100vw, 320px"
        />
      </div>
      <div className={styles.body}>
        <h3 className={styles.title}>{post.title}</h3>
        <p className={styles.excerpt}>{post.excerpt}</p>
      </div>
    </article>
  );
}
```

### `app/page.js`

```jsx
import PostCard from "./components/PostCard";

const posts = [
  {
    id: 1,
    title: "用 App Router 打造部落格",
    excerpt: "從路由、資料到部署，一次到位。",
    cover: "https://images.unsplash.com/photo-1499750310107-5fef28a66643?w=640",
  },
  {
    id: 2,
    title: "Server Components 心法",
    excerpt: "預設 Server，需要互動才 Client。",
    cover: "https://images.unsplash.com/photo-1526379095098-d400fd0bf935?w=640",
  },
  {
    id: 3,
    title: "圖片與字型優化",
    excerpt: "next/image 與 next/font 讓你又快又穩。",
    cover: "https://images.unsplash.com/photo-1517180102446-f3ece451e9d8?w=640",
  },
];

export default function HomePage() {
  return (
    <main className="wrap">
      <h1>精選文章</h1>
      <div className="grid">
        {posts.map((p) => (
          <PostCard key={p.id} post={p} />
        ))}
      </div>
    </main>
  );
}
```

### `app/globals.css`

```css
* { box-sizing: border-box; }
body { margin: 0; background: #f3f4f6; color: #111827; }
.wrap { max-width: 960px; margin: 40px auto; padding: 0 16px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 20px; }
```

---

## 本章結語

你的站現在有一致的樣式、優化過的字型與圖片，賣相到位。  
下一章回到底層，把**渲染策略與快取**講透：同一個頁面，什麼時候是靜態、什麼時候是動態、怎麼精準控制。
