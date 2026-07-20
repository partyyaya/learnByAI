# 第 12 章：渲染策略與快取進階

## 本章目標

完成這一章後，你應該可以：

1. 分辨 Static / Dynamic 渲染，知道什麼會讓頁面變動態。
2. 說出 SSG / SSR / ISR 三種策略的差異與適用場景。
3. 用路由段設定（`dynamic`、`revalidate`、`fetchCache`）控制行為。
4. 用 `unstable_cache` 與 cache tags 對「非 fetch」的資料做快取。
5. 用 `revalidateTag` 精準讓某類資料失效。

---

## 1. Static vs Dynamic 渲染

App Router 的每個頁面，Next.js 會判斷它是**靜態**還是**動態**：

- **Static（靜態）**：在 build 時就產生 HTML，所有人看到同一份，最快、可被 CDN 快取。
- **Dynamic（動態）**：每次請求才在伺服器產生 HTML，適合「因人而異」或「即時」的內容。

什麼會讓頁面「變動態」？只要你用了「請求當下才知道」的東西：

- 讀 `cookies()`、`headers()`
- 用 `searchParams`
- `fetch` 設了 `cache: "no-store"`
- 明確設定 `export const dynamic = "force-dynamic"`

> 心智模型：**能靜態就靜態，需要即時或個人化才動態。** Next.js 會自動判斷，你也能手動指定。

---

## 2. 三種策略：SSG / SSR / ISR

| 策略 | 何時產生 HTML | 適用 |
|------|--------------|------|
| **SSG**（靜態產生） | build 時一次 | 內容幾乎不變：行銷頁、文件、已定稿文章 |
| **SSR**（伺服器渲染） | 每次請求 | 個人化、即時：儀表板、購物車、需登入頁 |
| **ISR**（增量靜態再生） | build 產生 + 定時背景更新 | 內容會變但可容忍延遲：部落格列表、商品頁 |

ISR 就是第 5 章的 `next: { revalidate: 秒數 }`——兼顧靜態速度與內容更新。

---

## 3. 路由段設定：整頁層級控制

在 `page.js` / `layout.js` export 這些變數，可以控制整條路由段的行為：

```jsx
// 強制動態（每次請求都重新渲染）
export const dynamic = "force-dynamic";

// 強制靜態（用到動態 API 會報錯，適合確保頁面是靜態）
export const dynamic = "force-static";

// 整頁的重新驗證秒數（ISR）
export const revalidate = 60;

// 控制此段所有 fetch 的預設快取
export const fetchCache = "default-cache";
```

常見組合：

```jsx
// 一個每 5 分鐘更新的部落格列表頁
export const revalidate = 300;

export default async function BlogPage() {
  const posts = await getPosts();
  // …
}
```

---

## 4. 快取非 fetch 的資料：unstable_cache

`fetch` 的快取只對 `fetch` 有效。但你若用 **Prisma / DB 查詢**（不是 fetch），要另外用 `unstable_cache` 包起來才能快取：

```jsx
import { unstable_cache } from "next/cache";
import { prisma } from "@/lib/prisma";

// 把 DB 查詢包成可快取，帶上 key 與 tags
const getPublishedPosts = unstable_cache(
  async () => prisma.post.findMany({ where: { published: true } }),
  ["published-posts"],          // 快取 key
  { revalidate: 60, tags: ["posts"] } // 60 秒 or 手動用 tag 失效
);

export default async function Page() {
  const posts = await getPublishedPosts();
  // …
}
```

> 名稱有 `unstable_` 前綴代表 API 可能微調，但功能穩定、廣泛使用。用它把「昂貴的 DB 查詢」快取起來，能大幅減少資料庫壓力。

---

## 5. cache tags 與 revalidateTag

Tag 讓你把「相關的快取」分組，一次失效。比 `revalidatePath` 更精準——你不用知道哪些頁面用到這份資料，只要它們標了同一個 tag。

**標 tag（fetch 版）：**

```jsx
await fetch(url, { next: { tags: ["posts"] } });
```

**標 tag（unstable_cache 版）：** 見上面第 4 點的 `tags: ["posts"]`。

**失效：** 在 Server Action 裡呼叫 `revalidateTag`：

```jsx
"use server";
import { revalidateTag } from "next/cache";

export async function createPost(formData) {
  await prisma.post.create({ /* … */ });
  revalidateTag("posts"); // 所有標 "posts" 的快取全部失效、下次重抓
}
```

`revalidatePath` vs `revalidateTag`：

- `revalidatePath("/blog")`：我知道要更新哪條路徑。
- `revalidateTag("posts")`：我只知道「文章資料變了」，讓所有用到文章的地方一起更新。

---

## 6. PPR 概念（部分預渲染）

Next.js 正在推進 **Partial Prerendering（PPR）**：同一頁裡，靜態外殼（版面、頁首）先秒出，動態區塊（個人化內容）用 Suspense 串流補上——把 SSG 的速度與 SSR 的即時合在同一頁。

它目前屬於實驗性功能（需在 config 開啟），觀念先知道即可：**未來趨勢是「一頁混合靜態與動態」，而不是整頁二選一。**

---

## 7. 本章小練習

1. 做一個頁面，故意讀 `cookies()`，用 `npm run build` 觀察它被標為動態（ƒ）。
2. 做一個 `revalidate = 30` 的列表頁，觀察 30 秒內外的差異。
3. 用 `unstable_cache` 包一個 Prisma 查詢，設 `tags: ["posts"]`。
4. 在新增文章的 Server Action 裡呼叫 `revalidateTag("posts")`，確認列表即時更新。

---

## 最後範例：同一份資料，三種渲染策略對照

> 三個頁面用同一支資料函式，分別示範 SSG / ISR / SSR，讓你直接看出差異。原樣建立即可跑，`npm run build` 時留意每頁的標記（○ 靜態、ƒ 動態）。

### `lib/data.js`（共用資料函式）

```js
// 回傳「產生當下的時間」，用來觀察頁面是何時被渲染的
export async function getSnapshot() {
  return {
    value: Math.floor(Math.random() * 1000),
    renderedAt: new Date().toLocaleTimeString("zh-TW"),
  };
}
```

### `app/render/ssg/page.js`（SSG：build 時固定）

```jsx
import { getSnapshot } from "@/lib/data";

// 沒有任何動態 API、沒有 revalidate → 預設靜態，build 時算一次
export const dynamic = "force-static";

export default async function SsgPage() {
  const snap = await getSnapshot();
  return (
    <main className="wrap">
      <h1>SSG（靜態產生）</h1>
      <p>值：{snap.value}</p>
      <p className="muted">渲染時間：{snap.renderedAt}</p>
      <p className="muted">重整頁面，時間<strong>不會變</strong>（build 時就定了）。</p>
    </main>
  );
}
```

### `app/render/isr/page.js`（ISR：每 10 秒更新）

```jsx
import { getSnapshot } from "@/lib/data";

// 每 10 秒背景重新產生一次
export const revalidate = 10;

export default async function IsrPage() {
  const snap = await getSnapshot();
  return (
    <main className="wrap">
      <h1>ISR（增量靜態再生）</h1>
      <p>值：{snap.value}</p>
      <p className="muted">渲染時間：{snap.renderedAt}</p>
      <p className="muted">重整：10 秒內<strong>不變</strong>，過期後下次重整才更新。</p>
    </main>
  );
}
```

### `app/render/ssr/page.js`（SSR：每次請求都重算）

```jsx
import { getSnapshot } from "@/lib/data";

// 強制動態：每次請求都重新渲染
export const dynamic = "force-dynamic";

export default async function SsrPage() {
  const snap = await getSnapshot();
  return (
    <main className="wrap">
      <h1>SSR（伺服器渲染）</h1>
      <p>值：{snap.value}</p>
      <p className="muted">渲染時間：{snap.renderedAt}</p>
      <p className="muted">每次重整，時間與值<strong>都會變</strong>。</p>
    </main>
  );
}
```

### 導覽頁 `app/render/page.js`

```jsx
import Link from "next/link";

export default function RenderIndex() {
  return (
    <main className="wrap">
      <h1>渲染策略對照</h1>
      <ul>
        <li><Link href="/render/ssg">SSG：重整不變</Link></li>
        <li><Link href="/render/isr">ISR：每 10 秒變</Link></li>
        <li><Link href="/render/ssr">SSR：每次都變</Link></li>
      </ul>
    </main>
  );
}
```

### 樣式（加進 `app/globals.css`）

```css
.wrap { max-width: 560px; margin: 40px auto; font-family: sans-serif; padding: 0 16px; line-height: 1.7; }
.muted { color: #6b7280; }
```

> 觀察方式：`npm run build && npm start`（正式模式才看得出快取行為），分別重整三個頁面比較「渲染時間」變不變。

---

## 本章結語

你現在能精準控制每一頁是靜態、動態還是 ISR，也會用 tag 做細緻的快取失效——這是 Next.js 效能的最後一塊拼圖。  
下一章把 SEO 與 Metadata 補齊，讓你的頁面在搜尋與社群分享都好看。
