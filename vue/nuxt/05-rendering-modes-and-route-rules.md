# 第 5 章：渲染模式與 Route Rules

## 本章目標

完成這一章後，你應該可以：

1. 說清楚 Universal（SSR）、SPA、SSG（預渲染）、Hybrid 四種模式差在哪、各自的取捨。
2. 用 `nuxt.config` 的 `ssr` 選項整站切換模式。
3. 用 `routeRules` **逐路由**指定渲染方式（含 `prerender` / `swr` / `isr` / `redirect` / `headers`）。
4. 分清 `nuxt build` 與 `nuxt generate` 產出的差別，並知道怎麼驗證某頁到底是不是 SSR。

---

## 1. 四種渲染模式總覽

同一份 Nuxt 程式碼，可以用不同方式「變成使用者看到的 HTML」：

| 模式 | 何時產生 HTML | 首屏 | SEO | 需要 Node 伺服器？ | 適合 |
|---|---|---|---|---|---|
| **Universal（SSR）** 預設 | 每次請求，在伺服器算 | 快、有內容 | ✅ 好 | ✅ 要 | 內容會變、要 SEO 的頁（部落格、商品頁） |
| **SPA（Client-only）** | 不在伺服器算，瀏覽器才算 | 慢、先白屏 | ❌ 差 | ❌ 不用 | 登入後的後台、內部工具 |
| **SSG（預渲染）** | **打包時**先算好成靜態 HTML | 最快 | ✅ 好 | ❌ 不用（丟 CDN 即可） | 內容不常變（文件站、行銷頁） |
| **Hybrid（混合）** | 逐路由自己決定上面任一種 | 視設定 | 視設定 | 視設定 | 真實專案：不同區塊需求不同 |

一句話理解：

> **要不要 SEO、內容多久變一次、想不想養伺服器**——這三個問題決定你選哪種模式。真實專案幾乎都是 Hybrid：首頁預渲染、部落格 SWR 快取、後台走 SPA。

---

## 2. 整站切換：`ssr` 選項

Nuxt **預設就是 Universal（SSR）**，你前四章做的頁面都是伺服器先產出 HTML。若要整站改成純前端 SPA，在 `nuxt.config.ts` 設 `ssr: false`：

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  ssr: false, // 整站變 SPA：不在伺服器算 HTML，瀏覽器下載 JS 後才渲染
})
```

- `ssr: true`（預設）：Universal，伺服器產出 HTML。
- `ssr: false`：SPA，`index.html` 幾乎是空殼，靠瀏覽器 JS 撐起來。

> 但整站二選一太粗。真正實用的是下一節的 `routeRules`——**留著 SSR，只把該走 SPA 的路由挑出來**。

---

## 3. 逐路由設定：`routeRules`

`routeRules` 讓你針對不同網址套不同規則，這是 Nuxt Hybrid 的核心：

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  routeRules: {
    // 首頁：打包時就預渲染成靜態 HTML（最快、丟 CDN）
    '/': { prerender: true },

    // 關於頁：也預渲染
    '/about': { prerender: true },

    // 文章區：SWR 快取 1 小時（見第 5 節）
    '/posts/**': { swr: 3600 },

    // 後台：純前端 SPA，不做 SSR（內容不需要 SEO）
    '/admin/**': { ssr: false },

    // 舊網址轉址
    '/old-blog': { redirect: '/posts' },

    // 幫某段路由加自訂 HTTP 標頭
    '/downloads/**': { headers: { 'cache-control': 'max-age=31536000' } },
  },
})
```

常用的 key：

| key | 意思 |
|---|---|
| `prerender: true` | 打包時就產生靜態 HTML |
| `ssr: false` | 這段路由走 SPA（client 才渲染） |
| `swr: <秒>` / `swr: true` | 伺服器端快取（stale-while-revalidate，見下節） |
| `isr: <秒>` / `isr: true` | 類似 SWR，設計給有 CDN/邊緣的平台（Vercel/Netlify…） |
| `redirect: '/x'` | 轉址 |
| `headers: {}` | 加 HTTP 標頭 |
| `cors: true` | 允許跨來源（常用在 `/api/**`） |

> `**` 是萬用比對：`/posts/**` 會涵蓋 `/posts`、`/posts/1`、`/posts/a/b`。規則由**精確度**決定優先順序，越具體的越優先。

---

## 4. 預渲染（SSG）：`prerender`

預渲染是在 **打包當下** 就把頁面算成靜態 HTML，上線時不需要 Node 伺服器、直接丟 CDN，速度最快、最省成本。適合內容不常變的頁。

有兩種寫法：

**A. 針對特定路由**（前面已示範）：

```ts
routeRules: {
  '/': { prerender: true },
  '/about': { prerender: true },
}
```

**B. 整站靜態**：用 `nuxt generate` 指令（等同開啟全站預渲染）：

```bash
npm run generate     # 產出純靜態網站到 .output/public/
```

Nuxt 會從進入點開始，**自動爬你頁面裡的 `<NuxtLink>`** 去發現還有哪些路由要一起預渲染。若有些頁沒被連結到（例如靠程式跳轉），要手動補：

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  nitro: {
    prerender: {
      crawlLinks: true,           // 自動爬連結（預設就有）
      routes: ['/posts/1', '/posts/2', '/posts/3'], // 手動補上爬不到的
    },
  },
})
```

> 動態路由（`/posts/[id]`）不會自己知道有哪些 id，要嘛靠 `crawlLinks` 從列表頁的連結爬到，要嘛用 `routes` 明列。第 6 章抓到真實文章清單後，會再回來補這段。

---

## 5. SWR / ISR：兼顧「快」與「新」

SSR 每次請求都重算，內容最新但伺服器比較累；預渲染最快但內容是打包當下的、不會更新。**SWR（stale-while-revalidate）**是折衷：

```ts
routeRules: {
  '/posts/**': { swr: 3600 }, // 快取 1 小時
}
```

行為：

1. 第一個人來 → 伺服器算一次 HTML，**存進快取**回給他。
2. 一小時內其他人來 → 直接給快取的 HTML（超快，不重算）。
3. 過了一小時 → 先把**舊的**給你（stale），同時**背景重算**一份新的更新快取（revalidate）。下一個人就拿到新的。

這樣既有 SSR 的動態內容，又有接近靜態的速度。`isr` 用法幾乎一樣，差別在它是設計給有 CDN/邊緣網路的部署平台。

> 選擇口訣：**每次都要最新** → 純 SSR（不設快取）；**可以容忍幾分鐘的舊** → `swr`；**幾乎不變** → `prerender`。

---

## 6. `build` vs `generate`：兩種產出

| 指令 | 產出 | 需要 Node 伺服器？ | 對應模式 |
|---|---|---|---|
| `npm run build` | `.output/`（含 `server/`） | ✅ 要（跑 `node .output/server/index.mjs`） | SSR / Hybrid |
| `npm run generate` | `.output/public/`（純靜態檔） | ❌ 不用，丟任何靜態主機 | 全站 SSG |

兩者都能用 `npm run preview` 在本機先看結果。

> 重要觀念：**就算你用 `routeRules` 混了預渲染，只要有任何一條路由需要 SSR/SWR，就要用 `build` + Node 伺服器部署。** 只有「整站都能靜態」時才用 `generate`。部署細節在第 16 章。

---

## 7. 怎麼驗證某頁到底是不是 SSR？

不要用猜的，用「檢視原始碼」看：

1. 打開頁面 → 右鍵 → **檢視網頁原始碼**（View Source，看的是**伺服器回傳的原始 HTML**，不是 DevTools 的即時 DOM）。
2. 如果原始碼裡**找得到**你的文章標題等內容 → 這頁有 SSR / 預渲染。
3. 如果原始碼幾乎是空的、只有一堆 `<script>` → 這頁是 SPA（`ssr: false`）。

> DevTools 的 Elements 面板看到的是 hydration 後的結果，**永遠**有內容，所以判斷 SSR 一定要用「檢視原始碼」，不要看 Elements。

---

## 8. 本章小練習

1. 把首頁與 `/about` 設成 `prerender: true`，`npm run build` 後看 `.output/public/` 有沒有對應的 `.html`。
2. 把 `/posts/**` 設成 `swr: 30`，連續重整並觀察內容更新的節奏。
3. 把 `/admin/**` 設成 `ssr: false`，用「檢視原始碼」確認它是空殼、其他頁不是。
4. 加一條 `redirect`，把 `/blog` 轉到 `/posts`。

---

## 最後範例：一份混合渲染的部落格設定

> 用 `routeRules` 把「首頁預渲染、文章 SWR、後台 SPA、舊網址轉址」一次配好。原樣建立以下檔案即可跑（頁面用最小內容示範，重點在設定與驗證）。

### `nuxt.config.ts`

```ts
export default defineNuxtConfig({
  // 整站預設仍是 Universal(SSR)，只針對個別路由調整
  routeRules: {
    '/':          { prerender: true },   // 首頁：打包時靜態化
    '/about':     { prerender: true },   // 關於頁：靜態化
    '/posts/**':  { swr: 3600 },         // 文章區：SWR 快取 1 小時
    '/admin/**':  { ssr: false },        // 後台：純前端 SPA
    '/blog':      { redirect: '/posts' },// 舊網址轉址
  },
})
```

### `app/app.vue`

```vue
<template>
  <div class="wrap">
    <nav class="nav">
      <NuxtLink to="/">首頁</NuxtLink>
      <NuxtLink to="/about">關於</NuxtLink>
      <NuxtLink to="/posts">文章</NuxtLink>
      <NuxtLink to="/admin">後台</NuxtLink>
    </nav>
    <NuxtPage />
  </div>
</template>

<style>
body { margin: 0; font-family: -apple-system, "Segoe UI", sans-serif; }
.wrap { max-width: 640px; margin: 0 auto; padding: 24px; line-height: 1.7; }
.nav { display: flex; gap: 16px; padding-bottom: 16px; border-bottom: 1px solid #eee; margin-bottom: 16px; }
.nav a { color: #111827; text-decoration: none; }
.nav a.router-link-active { color: #00dc82; font-weight: 600; }
.badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; background: #eff6ff; color: #1d4ed8; }
</style>
```

### `app/pages/index.vue`

```vue
<template>
  <section>
    <h1>首頁 <span class="badge">prerender</span></h1>
    <p>這頁打包時就算好了。用「檢視原始碼」會看到這段文字，且不需要伺服器運算。</p>
  </section>
</template>
```

### `app/pages/about.vue`

```vue
<template>
  <section>
    <h1>關於 <span class="badge">prerender</span></h1>
    <p>同樣是預渲染的靜態頁。</p>
  </section>
</template>
```

### `app/pages/posts/index.vue`

```vue
<script setup>
// 用伺服器當下時間標記「這份 HTML 是何時算出來的」，方便觀察 SWR 快取行為。
// 因為 /posts/** 設了 swr:3600，這個時間在快取有效期間不會變。
const renderedAt = useState('posts-rendered-at', () => new Date().toISOString())
</script>

<template>
  <section>
    <h1>文章區 <span class="badge">swr 3600</span></h1>
    <p>這份 HTML 產生時間：<code>{{ renderedAt }}</code></p>
    <p>重整幾次，時間不會變（吃快取）；過了快取時間才會更新。</p>
  </section>
</template>
```

### `app/pages/admin/index.vue`

```vue
<template>
  <section>
    <h1>後台 <span class="badge">ssr:false（SPA）</span></h1>
    <p>這頁不做 SSR。用「檢視原始碼」會發現找不到這段文字，因為它是瀏覽器才渲染的。</p>
  </section>
</template>
```

驗證方式：

1. `/blog` → 自動轉到 `/posts`（`redirect` 生效）。
2. `/posts` → 重整多次，`renderedAt` 時間不變（`swr` 快取）。
3. `/admin` → 右鍵「檢視原始碼」，找不到「後台」字樣（`ssr:false` 的 SPA）。
4. `/` 與 `/about` → `npm run build` 後到 `.output/public/` 會看到預先產好的靜態檔。

---

## 本章結語

你現在能針對每一條路由選最合適的產出方式，這是 Nuxt 相對純 Vue 最有價值的能力之一。
但到目前為止，頁面資料都還是寫死的。下一章進到重頭戲：**資料抓取**——`useFetch`、`useAsyncData`、`$fetch` 三兄弟，讓頁面在伺服器就把真實資料抓好、隨 HTML 一起送到瀏覽器。
