# 第 12 章：SEO、Meta 與社群分享

## 本章目標

完成這一章後，你應該可以：

1. 說出為什麼「SSR + 正確 meta」才能被搜尋引擎與社群正確收錄。
2. 用 `useHead` 設定 `title`、`meta`、`link`、`script` 等 head 內容。
3. 用 `useSeoMeta` 設定 SEO 與 Open Graph／Twitter Card（含動態值）。
4. 設定全站標題模板與預設 meta。
5. 用 `@nuxtjs/seo` 一次補齊 sitemap、robots、canonical 等 SEO 基礎建設。

---

## 1. 為什麼 SEO 要靠 Nuxt

搜尋引擎爬蟲與社群分享（LINE/FB/X 貼連結時的預覽卡）讀的是**伺服器回傳的原始 HTML**。純前端 SPA 首屏是空殼，爬蟲看到的就是空的 → SEO 差、分享沒預覽。

Nuxt 預設 SSR（第 5 章），伺服器會把內容連同 `<title>`、`<meta>` 一起產出。所以在 Nuxt 做 SEO 的關鍵是：**在頁面裡宣告好 meta，讓它們出現在 SSR 的 HTML `<head>` 裡**。

> 驗證方式同第 5 章：右鍵「檢視網頁原始碼」，`<head>` 裡要看得到你設定的 `<title>` 與 `<meta>`。看 DevTools Elements 不準（那是 hydrate 後的）。

---

## 2. `useHead`：通用的 head 控制

`useHead` 可設定幾乎所有 head 內容：

```vue
<script setup>
useHead({
  title: '關於我們',
  meta: [
    { name: 'description', content: '這是關於我們頁面' },
  ],
  link: [
    { rel: 'canonical', href: 'https://example.com/about' },
  ],
  htmlAttrs: {
    lang: 'zh-Hant',
  },
})
</script>
```

`useHead` 接受的常見欄位：`title`、`titleTemplate`、`meta`、`link`、`script`、`style`、`htmlAttrs`、`bodyAttrs`。值可以是**函式或 ref**，Nuxt 會保持響應式（資料變、head 跟著變）。

---

## 3. `useSeoMeta`：專為 SEO 設計

手寫 `meta: [{ property: 'og:title', ... }]` 容易打錯字。`useSeoMeta` 提供**有型別、扁平**的寫法，涵蓋 SEO 與社群標籤：

```vue
<script setup>
useSeoMeta({
  title: 'Nuxt 完整課程',
  description: '從零到全端上線的 Nuxt 4 教學',

  // Open Graph（FB / LINE / 多數社群）
  ogTitle: 'Nuxt 完整課程',
  ogDescription: '從零到全端上線的 Nuxt 4 教學',
  ogImage: 'https://example.com/og.png',
  ogType: 'website',

  // Twitter / X
  twitterCard: 'summary_large_image',
  twitterTitle: 'Nuxt 完整課程',
  twitterImage: 'https://example.com/og.png',
})
</script>
```

> 大多數頁面用 `useSeoMeta` 就夠，它會自動產出正確的 `<meta name="...">` / `<meta property="og:...">`。需要 `link`（canonical）、`script`（結構化資料）時才另外用 `useHead`。

---

## 4. 動態 meta：跟著資料變

文章詳情頁的標題/描述要用**抓到的文章內容**。因為 SEO meta 必須在 SSR 就正確，所以要在資料抓好後、用**函式形式**傳給 `useSeoMeta`（保持響應式）：

```vue
<script setup>
const route = useRoute()
const { data: post } = await useFetch(`/api/posts/${route.params.id}`)

useSeoMeta({
  // 用函式，post 一有值就更新（SSR 已 await，所以 server 端就正確）
  title: () => post.value?.title,
  description: () => post.value?.content?.slice(0, 80),
  ogTitle: () => post.value?.title,
  ogDescription: () => post.value?.content?.slice(0, 80),
})
</script>
```

> 因為前面 `await useFetch`，SSR 會等資料到才產 HTML，所以爬蟲拿到的就是**正確的文章標題**，不是預設值。這正是 Nuxt 做內容型 SEO 的正解。

### 效能小技巧：`useServerSeoMeta`

如果某些 meta 不需要在瀏覽器端反應（多數 SEO meta 都是這樣），可用 `useServerSeoMeta`——它只在伺服器產出，不佔用瀏覽器 runtime，稍微更快。用法與 `useSeoMeta` 相同。

---

## 5. 全站標題模板與預設 meta

每頁標題後面想自動接站名（`關於我們 - My Blog`），用 `titleTemplate`。放在 `app.vue` 或 `nuxt.config` 都可以：

```vue
<!-- app/app.vue -->
<script setup>
useHead({
  titleTemplate: (title) => (title ? `${title} - My Blog` : 'My Blog'),
})
</script>
```

全站預設 meta（例如預設 `description`、`lang`、favicon）建議放 `nuxt.config`，個別頁面再覆蓋：

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  app: {
    head: {
      htmlAttrs: { lang: 'zh-Hant' },
      title: 'My Blog',
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: '一個用 Nuxt 打造的部落格' },
      ],
      link: [{ rel: 'icon', type: 'image/png', href: '/favicon.png' }],
    },
  },
})
```

> ⚠️ 常見誤會：`definePageMeta` **不是拿來設 SEO 的**！它管的是 layout、middleware（第 2、3、9 章）。設標題與 meta 一律用 `useHead` / `useSeoMeta`。

---

## 6. sitemap / robots：用 @nuxtjs/seo 一次搞定

搜尋引擎還需要 `sitemap.xml`（網站地圖）和 `robots.txt`（爬蟲規則）。手寫很煩，用 `@nuxtjs/seo` 模組（它整合了 sitemap、robots、canonical、OG image 等一票 SEO 工具）：

```bash
npx nuxi module add seo
```

設定網站網址（sitemap/canonical 需要絕對網址）：

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['@nuxtjs/seo'],
  site: {
    url: 'https://example.com',
    name: 'My Blog',
  },
})
```

裝好後：

- **自動產生 `/sitemap.xml`**：靜態路由會自動收錄。
- **自動產生 `/robots.txt`**。
- **canonical、og:url 自動補**。

**動態路由**（`/posts/[id]`）sitemap 不會自己知道有哪些 id，要提供來源。用一支 server 端點回傳所有網址：

```js
// server/api/__sitemap__/urls.js
export default defineSitemapUrls(async () => {
  const posts = await prisma.post.findMany({ select: { id: true } })
  return posts.map((p) => ({ loc: `/posts/${p.id}`, changefreq: 'weekly' }))
})
```

> `@nuxtjs/seo` 版本演進較快，實際設定以你安裝版本的文件為準；核心觀念不變：**告訴它 `site.url`，並提供動態路由清單**。

---

## 7. 本章小練習

1. 用 `useSeoMeta` 幫首頁設 `title` 與 `description`，檢視原始碼確認出現在 `<head>`。
2. 幫 `/posts/[id]` 設**動態** title/description，切不同文章看 `<title>` 是否跟著變。
3. 加 Open Graph 標籤，用線上 OG 預覽工具（或貼進 LINE/Slack）看預覽卡。
4. 在 `app.vue` 設 `titleTemplate`，讓每頁標題後面接站名。
5. 安裝 `@nuxtjs/seo`，設好 `site.url`，打開 `/sitemap.xml` 與 `/robots.txt`。

---

## 最後範例：有完整 SEO 的部落格

> 在第 10/11 章的部落格上補齊 SEO：全站標題模板、首頁 meta、文章詳情動態 meta + OG。原樣建立以下檔案即可（後端沿用前面章節的 `/api/posts`）。

### `nuxt.config.ts`

```ts
export default defineNuxtConfig({
  app: {
    head: {
      htmlAttrs: { lang: 'zh-Hant' },
      meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }],
    },
  },
  // 安裝 @nuxtjs/seo 後啟用：
  // modules: ['@nuxtjs/seo'],
  // site: { url: 'https://example.com', name: 'My Blog' },
})
```

### `app/app.vue`

```vue
<script setup>
// 全站標題模板：每頁 title 後自動接站名
useHead({
  titleTemplate: (title) => (title ? `${title} - My Blog` : 'My Blog'),
})
</script>

<template>
  <div class="wrap">
    <nav class="nav">
      <NuxtLink to="/">首頁</NuxtLink>
      <NuxtLink to="/posts">文章</NuxtLink>
    </nav>
    <NuxtPage />
  </div>
</template>

<style>
body { margin: 0; font-family: -apple-system, "Segoe UI", sans-serif; background: #f9fafb; color: #111827; }
.wrap { max-width: 680px; margin: 0 auto; padding: 24px; line-height: 1.7; }
.nav { display: flex; gap: 16px; padding-bottom: 12px; border-bottom: 1px solid #eee; margin-bottom: 16px; }
.nav a { color: #111827; text-decoration: none; }
.nav a.router-link-active { color: #00dc82; font-weight: 600; }
.card a { color: #111827; text-decoration: none; font-weight: 600; }
.back { color: #2563eb; text-decoration: none; }
</style>
```

### `app/pages/index.vue`

```vue
<script setup>
useSeoMeta({
  title: '首頁',
  description: '用 Nuxt 4 打造、具備完整 SEO 的部落格範例。',
  ogTitle: 'My Blog',
  ogDescription: '用 Nuxt 4 打造的部落格',
  ogType: 'website',
  twitterCard: 'summary',
})
</script>

<template>
  <section>
    <h1>歡迎來到 My Blog</h1>
    <p>右鍵「檢視網頁原始碼」，在 &lt;head&gt; 裡找找 title 與 og 標籤。</p>
    <p><NuxtLink to="/posts">看所有文章 →</NuxtLink></p>
  </section>
</template>
```

### `app/pages/posts/index.vue`

```vue
<script setup>
useSeoMeta({ title: '所有文章', description: '文章列表' })
const { data: posts } = await useFetch('/api/posts')
</script>

<template>
  <section>
    <h1>所有文章</h1>
    <div v-for="p in posts" :key="p.id" class="card">
      <NuxtLink :to="`/posts/${p.id}`">{{ p.title }}</NuxtLink>
    </div>
  </section>
</template>
```

### `app/pages/posts/[id].vue`

```vue
<script setup>
definePageMeta({ validate: (route) => /^\d+$/.test(route.params.id) })

const route = useRoute()
const { data: post, error } = await useFetch(`/api/posts/${route.params.id}`, {
  key: `post-${route.params.id}`,
})
if (error.value) throw createError({ statusCode: 404, statusMessage: '找不到文章' })

// 動態 SEO：跟著文章內容變。因為上面已 await，SSR 端就是正確值
useSeoMeta({
  title: () => post.value?.title,
  description: () => post.value?.content?.slice(0, 80),
  ogTitle: () => post.value?.title,
  ogDescription: () => post.value?.content?.slice(0, 80),
  ogType: 'article',
  twitterCard: 'summary_large_image',
})
</script>

<template>
  <article v-if="post">
    <p><NuxtLink to="/posts" class="back">← 回列表</NuxtLink></p>
    <h1>{{ post.title }}</h1>
    <p>{{ post.content }}</p>
  </article>
</template>
```

跑起來後：

- 首頁標題列顯示「首頁 - My Blog」（模板生效）。
- 進 `/posts/1`，檢視原始碼：`<title>` 是**該篇文章標題**、`<meta property="og:title">` 也是；切到 `/posts/2` 內容跟著變。
- 把 `/posts/1` 貼進支援 OG 預覽的聊天軟體，會顯示標題與描述卡片。
- 裝上 `@nuxtjs/seo` 並設 `site.url` 後，`/sitemap.xml` 會列出頁面。

---

## 本章結語

你的站現在對 Google 與社群都友善了。下一章把工程面的韌性補齊：**錯誤處理、Plugins 與 Nuxt 模組生態**——優雅地攔錯、在啟動時注入共用能力（如 dayjs、API client），以及看懂怎麼挑用社群模組。
