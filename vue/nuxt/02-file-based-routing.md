# 第 2 章：檔案式路由與頁面

## 本章目標

完成這一章後，你應該可以：

1. 說出 `app/pages/` 底下的檔名如何對應到網址。
2. 建立巢狀路由、動態路由 `[id]` 與 catch-all `[...slug]`。
3. 用 `<NuxtLink>` 做客戶端導覽，理解和 `<a>` 的差別。
4. 用 `useRoute` / `useRouter` / `navigateTo` 讀路由參數與程式化導覽。
5. 用 `definePageMeta` 設定頁面層級的中繼資料。

---

## 1. 核心規則：`app/pages/` 就是路由

Nuxt 沒有路由表。你在 `app/pages/` 放一個 `.vue` 檔，它就變成一個網址：

```text
app/pages/
├─ index.vue              → /
├─ about.vue              → /about
├─ contact.vue            → /contact
└─ blog/
   ├─ index.vue           → /blog
   └─ settings.vue        → /blog/settings
```

規則就兩條：

- `index.vue` 對應該層資料夾「本身」的網址。
- 其他檔名 `xxx.vue` 對應 `/xxx`；放在子資料夾就多一層路徑。

> 重點：只要檔案放進 `app/pages/`，路由就生效，**不用註冊、不用 import 任何 router**。Nuxt 會在你第一次建立 `app/pages/` 時自動裝好 Vue Router。

---

## 2. ⚠️ 有了 pages 之後，`app.vue` 要放 `<NuxtPage />`

這是初學者第一個大坑。上一章我們在 `app/app.vue` 直接寫死內容。但**一旦你建立 `app/pages/`，頁面要顯示在哪裡？答案是 `<NuxtPage />`**。

有兩種做法，二選一：

**做法 A（推薦）：保留 `app.vue`，放全站共用外框 + `<NuxtPage />`**

```vue
<!-- app/app.vue -->
<template>
  <div>
    <!-- 這裡可放全站都要有的東西，例如頁首 -->
    <NuxtPage />   <!-- 目前網址對應的頁面會渲染在這 -->
  </div>
</template>
```

**做法 B：直接刪掉 `app.vue`**，Nuxt 會自動用 `app/pages/` 當進入點。

> 如果你建了 `app/pages/index.vue` 卻還看到上一章的舊畫面、或首頁空白，九成是 `app.vue` 裡沒有 `<NuxtPage />`。記這句：**`app.vue` 是外框，`<NuxtPage />` 是換頁的洞。**

---

## 3. 一個頁面長什麼樣

頁面就是一個普通的 `.vue` 元件，放對位置就好：

```vue
<!-- app/pages/about.vue  → 對應 /about -->
<template>
  <h1>關於我們</h1>
</template>
```

需要邏輯就加 `<script setup>`：

```vue
<!-- app/pages/index.vue  → 對應 / -->
<script setup>
const title = '首頁'
</script>

<template>
  <h1>{{ title }}</h1>
</template>
```

---

## 4. 用 `<NuxtLink>` 做頁面切換

站內切頁要用 `<NuxtLink>`，不要用純 `<a>`：

```vue
<template>
  <nav>
    <NuxtLink to="/">首頁</NuxtLink>
    <NuxtLink to="/about">關於</NuxtLink>
    <NuxtLink to="/blog">文章</NuxtLink>
  </nav>
</template>
```

差別：

> `<a>` 會整頁重新載入（白屏、丟失狀態、要重新 hydration）。`<NuxtLink>` 做**客戶端導覽**：只換頁面內容、進畫面時預先抓取（prefetch）目標頁的資源，切換近乎瞬間。

`<NuxtLink>` 底層仍渲染成 `<a>`，SEO 與無障礙都沒問題。它還會自動幫「目前所在」的連結加上 `router-link-active` class，方便你做導覽高亮。

> 進階：`<NuxtLink to="/heavy" :prefetch="false">` 可關掉預抓；外部連結 `<NuxtLink to="https://...">` 會自動變成一般 `<a>`。

---

## 5. 動態路由：`[參數]`

檔名或資料夾名用中括號包起來，就是動態片段：

```text
app/pages/
└─ posts/
   ├─ index.vue           → /posts          （列表）
   └─ [id].vue            → /posts/123      （詳情，id 會是 "123"）
```

在頁面裡用 `useRoute()` 讀參數：

```vue
<!-- app/pages/posts/[id].vue -->
<script setup>
const route = useRoute()
// 網址 /posts/123 → route.params.id === '123'（字串）
const id = route.params.id
</script>

<template>
  <h1>第 {{ id }} 號文章</h1>
</template>
```

> `route.params` 的值永遠是字串。要當數字用記得自己轉：`Number(route.params.id)`。

---

## 6. Catch-all 路由：`[...slug]`

想接住「未知深度」的路徑（例如文件站 `/docs/a/b/c`），用 `[...slug]`：

```text
app/pages/
└─ docs/
   └─ [...slug].vue       → /docs/a、/docs/a/b、/docs/a/b/c 都會進來
```

```vue
<!-- app/pages/docs/[...slug].vue -->
<script setup>
const route = useRoute()
// /docs/a/b/c → route.params.slug === ['a', 'b', 'c']（陣列）
const path = route.params.slug
</script>

<template>
  <p>你在 docs 的：{{ Array.isArray(path) ? path.join(' / ') : '首頁' }}</p>
</template>
```

同理，把 `app/pages/[...slug].vue` 放在最外層，可以當作**自訂 404 相符頁**（沒有其他路由接住時的兜底）。

---

## 7. 巢狀路由（父頁面裡再開洞）

有時你要的是「父頁面固定、子頁面在父頁面內部切換」，例如 `/settings` 有共用頂欄，內部再切 `/settings/profile`、`/settings/security`。這時父檔案裡也要放一個 `<NuxtPage />`：

```text
app/pages/
├─ settings.vue           ← 父頁面（含共用 UI + <NuxtPage />）
└─ settings/
   ├─ profile.vue         → /settings/profile
   └─ security.vue        → /settings/security
```

```vue
<!-- app/pages/settings.vue -->
<template>
  <div class="settings">
    <h1>設定</h1>
    <nav>
      <NuxtLink to="/settings/profile">個人資料</NuxtLink>
      <NuxtLink to="/settings/security">安全性</NuxtLink>
    </nav>
    <NuxtPage />   <!-- profile / security 會渲染在這，父層頂欄不重繪 -->
  </div>
</template>
```

> 分辨：**沒有子路由需求**就直接一個檔案；**父層要保留 UI、內部換子頁**才用「同名檔 + 同名資料夾 + 父檔裡的 `<NuxtPage />`」。

---

## 8. 程式化導覽與 `definePageMeta`

### 8.1 用程式碼換頁

除了 `<NuxtLink>`，你也能在邏輯裡導頁：

```vue
<script setup>
const router = useRouter()

function goHome() {
  navigateTo('/')          // Nuxt 推薦：SSR/CSR 都正確
  // router.push('/')      // Vue Router 原生寫法，也可用
}
</script>
```

> `navigateTo` 是 Nuxt 包好的導覽函式，在伺服器端會回傳正確的重導，在瀏覽器端做客戶端切頁，比直接用 `router.push` 更安全。第 9 章的路由守衛也會用它。

### 8.2 `definePageMeta`：頁面的中繼資料

在頁面的 `<script setup>` 裡用 `definePageMeta` 設定這一頁的屬性，例如指定 layout、掛 middleware、或驗證參數：

```vue
<script setup>
definePageMeta({
  layout: 'blog',                 // 用哪個版面（第 3 章）
  middleware: ['auth'],           // 進頁前跑的守衛（第 9 章）
})
</script>
```

一個好用的功能是 **`validate`**：參數不合法就自動走 404，不用在每頁手寫判斷：

```vue
<!-- app/pages/posts/[id].vue -->
<script setup>
definePageMeta({
  // id 必須是純數字，否則視為找不到頁面
  validate: (route) => /^\d+$/.test(route.params.id),
})

const route = useRoute()
const id = Number(route.params.id)
</script>

<template>
  <h1>第 {{ id }} 號文章</h1>
</template>
```

現在 `/posts/123` 正常，`/posts/abc` 會顯示錯誤頁（錯誤頁我們第 3 章做）。

---

## 9. 本章小練習

1. 建立 `/`、`/about`、`/blog`、`/blog/settings` 四個頁面，並在 `app.vue` 放導覽列與 `<NuxtPage />`。
2. 建立 `/posts/[id]`，在頁面顯示 `id`，並加上 `validate` 只允許數字。
3. 用 `<NuxtLink>` 從列表連到 `/posts/1`，打開 Network 面板確認切頁時**不是**整頁重載。
4. 做一個 `app/pages/[...slug].vue` 當兜底頁，隨便打一個不存在的深層網址看看會不會進來。

---

## 最後範例：多頁面部落格骨架（含列表 → 詳情）

> 一個含導覽列、文章列表、動態詳情頁的可跑站台。資料先寫死在前端，第 6 章再換成真實 API。原樣建立以下檔案即可。

### `app/app.vue`

```vue
<template>
  <div>
    <header class="topbar">
      <strong>My Blog</strong>
      <nav class="nav">
        <NuxtLink to="/">首頁</NuxtLink>
        <NuxtLink to="/posts">文章</NuxtLink>
        <NuxtLink to="/about">關於</NuxtLink>
      </nav>
    </header>

    <main class="container">
      <NuxtPage />
    </main>
  </div>
</template>

<style>
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, "Segoe UI", sans-serif; color: #111827; background: #f3f4f6; }
.topbar { display: flex; align-items: center; gap: 24px; padding: 12px 24px; background: #111827; color: #fff; }
.nav { display: flex; gap: 16px; }
.nav a { color: #d1d5db; text-decoration: none; }
.nav a:hover, .nav a.router-link-active { color: #00dc82; }
.container { max-width: 720px; margin: 0 auto; padding: 24px; }
.post-list { list-style: none; padding: 0; }
.post-list li { background: #fff; padding: 16px; border-radius: 12px; margin-bottom: 12px; }
.post-list a { color: #111827; text-decoration: none; font-weight: 600; }
.post-list a:hover { color: #00b86b; }
.back { color: #2563eb; text-decoration: none; }
</style>
```

### `app/utils/posts.js`

```js
// 先用寫死的假資料，第 6 章會換成從 API 抓。
// 放在 app/utils/ 底下的函式會被 Nuxt 自動匯入（第 4 章詳談）。
export const posts = [
  { id: 1, title: 'Nuxt 是什麼', body: 'Nuxt 把 Vue 變成可上線的全端框架。' },
  { id: 2, title: '檔案式路由', body: 'app/pages/ 底下放檔案，網址自動長出來。' },
  { id: 3, title: 'Universal Rendering', body: '先在伺服器算好 HTML，再讓瀏覽器接手。' },
]

export function findPost(id) {
  return posts.find((p) => p.id === Number(id))
}
```

### `app/pages/index.vue`（首頁）

```vue
<template>
  <section>
    <h1>首頁</h1>
    <p>這是用 <code>app/pages/</code> 檔案式路由建立的部落格骨架。</p>
    <p><NuxtLink to="/posts">看所有文章 →</NuxtLink></p>
  </section>
</template>
```

### `app/pages/about.vue`（關於）

```vue
<template>
  <section>
    <h1>關於</h1>
    <p>資料夾就是路由，<code>about.vue</code> 自動對應 <code>/about</code>。</p>
  </section>
</template>
```

### `app/pages/posts/index.vue`（文章列表）

```vue
<script setup>
// posts 由 app/utils/posts.js 自動匯入，不用手動 import
</script>

<template>
  <section>
    <h1>文章列表</h1>
    <ul class="post-list">
      <li v-for="post in posts" :key="post.id">
        <NuxtLink :to="`/posts/${post.id}`">{{ post.title }}</NuxtLink>
      </li>
    </ul>
  </section>
</template>
```

### `app/pages/posts/[id].vue`（文章詳情，動態路由）

```vue
<script setup>
definePageMeta({
  // 只允許數字 id，其餘走錯誤頁
  validate: (route) => /^\d+$/.test(route.params.id),
})

const route = useRoute()
// findPost 由 app/utils/posts.js 自動匯入
const post = findPost(route.params.id)
</script>

<template>
  <section v-if="post">
    <p><NuxtLink to="/posts" class="back">← 回列表</NuxtLink></p>
    <h1>{{ post.title }}</h1>
    <p>{{ post.body }}</p>
  </section>

  <section v-else>
    <p><NuxtLink to="/posts" class="back">← 回列表</NuxtLink></p>
    <h1>找不到這篇文章</h1>
  </section>
</template>
```

跑起來後：

- `/` → 首頁，點「看所有文章」到 `/posts`。
- `/posts` → 三篇文章列表，點標題到 `/posts/1`。
- `/posts/2` → 顯示第 2 篇；`/posts/999` → 顯示「找不到這篇文章」；`/posts/abc` → 因 `validate` 失敗走錯誤頁。
- 用 `<NuxtLink>` 切頁時，頁首導覽列不重繪、不整頁刷新。

---

## 本章結語

你已經能用資料夾把網址搭出來，也會處理動態參數、程式化導覽與頁面中繼資料。
但每頁都自己寫頁首、頁尾很累——下一章進到 **`app.vue`、Layouts 與錯誤頁**，把共用版面抽出來，讓頁面只專心處理自己的內容。
