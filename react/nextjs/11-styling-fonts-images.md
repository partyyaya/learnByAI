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

兩個常見的卡關點：

- class 名稱有連字號（如 `.post-title`）時，`styles.postTitle` 會是 `undefined`，要寫成 `styles["post-title"]`。所以 CSS Modules 裡習慣用小駝峰命名（`.postTitle`）。
- CSS Modules 裡的選擇器至少要帶一個 class 或 id。像 `h1 { … }` 這種只有標籤的寫法會編譯失敗（`Selector "h1" is not pure`），要改寫成 `.title h1`，或放到 `globals.css`。

---

## 3. Tailwind CSS

建立專案時可直接勾 Tailwind；若沒勾（第 1 章建議先選 No），之後也能加。`create-next-app@15` 搭配的是 **Tailwind CSS v4**，手動加的步驟是：

```bash
npm install -D tailwindcss @tailwindcss/postcss
```

```js
// postcss.config.mjs（專案根目錄）
const config = {
  plugins: ["@tailwindcss/postcss"],
};
export default config;
```

```css
/* app/globals.css 最上面加這一行 */
@import "tailwindcss";
```

> **版本提醒**：v4 不需要 `tailwind.config.js`，會自動掃描專案裡用到的 class。網路上看到 `@tailwind base;`、`@tailwind components;` 加上 `tailwind.config.js` 的 `content` 設定，是 v3 的寫法，不要和 v4 混用。

裝好後重啟 `npm run dev`，直接在 `className` 用 utility：

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

用 `next/font` 載入字型，Next.js 會在 dev／build 時把字型檔下載下來、跟你的站一起部署（瀏覽器不必連 Google 伺服器），自動加上 `font-display: swap`，並用調整過尺寸的備用字型先頂著，減少字型換上時的版面跳動：

```jsx
// app/layout.js
import { Noto_Sans_TC } from "next/font/google";

// 要在模組最上層呼叫並存成常數，不能寫在元件函式裡
const notoTC = Noto_Sans_TC({ subsets: ["latin"], weight: ["400", "700"] });

export default function RootLayout({ children }) {
  return (
    <html lang="zh-Hant" className={notoTC.className}>
      <body>{children}</body>
    </html>
  );
}
```

> 好處：字型檔和你的站一起部署，沒有第三方請求（更快、更隱私）；字型載入前先顯示備用字、載入後換上時，版面幾乎不會跳動。

> **為什麼中文字型填 `subsets: ["latin"]`？** `subsets` 決定要「預先載入」哪一段字。Noto Sans TC 沒有中文子集可以選，Google 會把中文字切成很多小檔，頁面用到哪些字，瀏覽器才下載哪幾個，所以填 `latin` 就好。不填 `subsets` 會報錯（`Preload is enabled but no subsets were specified`）。

---

## 5. next/image：圖片優化

`<Image>` 會自動：依裝置給合適尺寸、轉現代格式（預設 WebP，要 AVIF 可在 `images.formats` 開）、lazy load、保留空間避免版面位移（CLS）。

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

`src` 寫字串路徑時，`width`/`height` 是必要的（除非用 `fill`）。它們代表圖片原始的寬高比，讓瀏覽器在圖片還沒下載前就先預留空間、避免版面跳動。實際顯示多大，仍可以用 CSS 調整。

> 也可以把圖片當模組匯入：`import logo from "./logo.png"`，再寫 `<Image src={logo} alt="站標" />`。Next.js 會在建置時讀出寬高，就不用自己填。

> 首屏最顯眼的大圖（例如頁首主視覺）加上 `priority`，Next.js 就不會延遲載入它，而是提早下載，讓畫面主體更快出現。其他圖片維持預設的 lazy load 即可。

### 填滿容器（fill）

當你不知道確切尺寸、想讓圖片填滿一個容器：

```jsx
<div style={{ position: "relative", width: "100%", height: 200 }}>
  <Image src="/cover.jpg" alt="封面" fill style={{ objectFit: "cover" }} />
</div>
```

`fill` 會讓圖片以 `position: absolute` 撐滿最近的定位父層，所以父層一定要設 `position: relative`（或 `absolute`／`fixed`）並給高度，不然圖片會跑版或高度變 0。`objectFit: "cover"` 讓圖片等比例裁切填滿，不會變形。

用 `fill` 時建議再加 `sizes`，告訴瀏覽器這張圖實際顯示多寬（例如 `sizes="(max-width: 640px) 100vw, 320px"`）。沒寫的話，瀏覽器會假設圖片和視窗一樣寬，下載到比需要大很多的檔案。

### 遠端圖片：要先允許網域

用外部網址的圖片，必須在 `next.config.mjs` 白名單網域，否則報錯（`hostname "…" is not configured under images in your next.config.js`）：

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

- 改了 `next.config.mjs` 要**重啟** `npm run dev` 才會生效。
- 舊教學常見的 `images.domains` 已棄用，請用 `remotePatterns`。
- 遠端圖片 Next.js 在建置時讀不到尺寸，所以一樣要給 `width`/`height`，或改用 `fill`。

---

## 6. 本章小練習

1. 做一個 `Card` 元件，分別用 CSS Modules 與（若有裝）Tailwind 各實作一次。
2. 在根 Layout 用 `next/font` 套一個中文字型（如 Noto Sans TC）。
3. 用 `next/image` 放一張 `public/` 的本地圖片，設定正確 `width`/`height`。
4. 用 `fill` 做一張填滿卡片的封面圖。
5. 允許一個遠端圖片網域，載入一張 Unsplash 圖。

---

## 最後範例：套版的文章卡片列表

> 用 CSS Modules + next/font + next/image 做出一排文章卡片。原樣建立以下檔案即可跑（圖片用遠端 Unsplash，記得設定 next.config；字型和圖片都要連網下載）。

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
