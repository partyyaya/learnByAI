# 第 3 章：app.vue、Layouts 與版面結構

## 本章目標

完成這一章後，你應該可以：

1. 說清楚 `app.vue`、`<NuxtLayout>`、`<NuxtPage>` 三者的關係。
2. 建立預設版面 `default.vue` 與多個自訂版面，並讓頁面選用。
3. 用 `definePageMeta` 與 `setPageLayout` 靜態／動態切換版面。
4. 建立全站錯誤頁 `error.vue`，並用 `clearError` 復原。

---

## 1. 三個角色：app.vue / NuxtLayout / NuxtPage

上一章我們把導覽列直接寫在 `app.vue`。這樣「頁首」是全站共用了，但如果部落格區要側邊欄、後台區要另一種外框呢？把所有變化都塞進 `app.vue` 會很亂。Nuxt 的分工是：

```text
app.vue          ← App 最外層（全站唯一，通常很薄）
 └─ <NuxtLayout> ← 版面：頁首/頁尾/側邊欄這類「一群頁面共用的外框」
      └─ <NuxtPage> ← 目前網址對應的頁面內容
```

- **`app.vue`**：整個 App 的根。放真的全站都要有的東西（例如全域 CSS、`<NuxtLoadingIndicator>`）。
- **Layout（版面）**：一組頁面共用的外框，可以有很多個（`default`、`blog`、`admin`…）。
- **Page（頁面）**：第 2 章那些 `app/pages/` 檔案，只專心處理自己的內容。

> 心智模型：**app.vue 是相框、Layout 是襯紙、Page 是照片。** 換照片（切頁）時襯紙不用換；換一種襯紙（切 layout）時相框也不用動。

---

## 2. 讓 app.vue 啟用版面系統

要用版面，`app.vue` 要把 `<NuxtPage>` 包在 `<NuxtLayout>` 裡：

```vue
<!-- app/app.vue -->
<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
```

就這樣。`<NuxtLayout>` 會自動去找 `app/layouts/default.vue` 當預設版面，把 `<NuxtPage>`（也就是目前頁面）塞進版面的 `<slot>` 位置。

---

## 3. 預設版面 `default.vue`

在 `app/layouts/default.vue` 建立版面。**版面一定要有 `<slot />`**——那是頁面內容要插入的位置：

```vue
<!-- app/layouts/default.vue -->
<template>
  <div class="layout">
    <header class="topbar">
      <strong>My Blog</strong>
      <nav>
        <NuxtLink to="/">首頁</NuxtLink>
        <NuxtLink to="/posts">文章</NuxtLink>
      </nav>
    </header>

    <main class="content">
      <slot />   <!-- 頁面內容渲染在這裡 -->
    </main>

    <footer class="foot">© 2026 My Blog</footer>
  </div>
</template>
```

現在**所有頁面**都會自動套上這個頁首與頁尾，頁面檔案（`app/pages/*.vue`）只要寫自己的內容就好。

> 建議版面用**單一根元素**（例如最外層一個 `<div>`）包起來，頁面轉場動畫、`<NuxtLayout>` 的 class 傳遞才不會出問題。

---

## 4. 多個版面與如何選用

版面可以有很多個。例如部落格區想要側邊欄，就多做一個 `blog.vue`：

```vue
<!-- app/layouts/blog.vue -->
<template>
  <div class="layout">
    <header class="topbar">
      <strong>My Blog</strong>
      <NuxtLink to="/">回首頁</NuxtLink>
    </header>

    <div class="blog-shell">
      <aside class="sidebar">
        <h3>分類</h3>
        <ul>
          <li><NuxtLink to="/posts">全部文章</NuxtLink></li>
          <li><NuxtLink to="/about">關於作者</NuxtLink></li>
        </ul>
      </aside>
      <main class="blog-main">
        <slot />
      </main>
    </div>
  </div>
</template>
```

頁面要用哪個版面，用 `definePageMeta` 指定 `layout`：

```vue
<!-- app/pages/posts/index.vue -->
<script setup>
definePageMeta({ layout: 'blog' })   // 這頁改用 blog 版面
</script>

<template>
  <h1>文章列表</h1>
</template>
```

- 沒寫 `layout` 的頁面 → 用 `default`。
- 寫 `layout: 'blog'` → 用 `app/layouts/blog.vue`。
- `layout: false` → 這頁**不套任何版面**（例如全螢幕登入頁）。

> 命名對應：檔名 `blog.vue` → `layout: 'blog'`；檔名用連字號 `admin-panel.vue` → `layout: 'admin-panel'`。

---

## 5. 動態切換版面：`setPageLayout`

有時版面要看情況決定（例如登入後才換成後台版面）。可以在執行時用 `setPageLayout` 動態切：

```vue
<script setup>
// 例如：某條件成立才切成 blog 版面
function useBlogSkin() {
  setPageLayout('blog')
}
</script>
```

也可以直接在 `app.vue` 用 `<NuxtLayout name="...">` 指定，或用 `:name` 綁一個響應式值：

```vue
<!-- app/app.vue -->
<script setup>
const layoutName = ref('default')
</script>

<template>
  <NuxtLayout :name="layoutName">
    <NuxtPage />
  </NuxtLayout>
</template>
```

> 大多數情況用 `definePageMeta({ layout })` 就夠了。`setPageLayout` 留給「同一頁在不同狀態要換外框」的少數情境。

---

## 6. 全站錯誤頁 `error.vue`

第 2 章我們用 `validate` 讓不合法的網址走「錯誤頁」，但還沒做那個頁。錯誤頁放在 **`app/error.vue`**（注意：跟 `app.vue` 同層，不是放在 `pages/`）：

```vue
<!-- app/error.vue -->
<script setup>
// Nuxt 會把錯誤物件透過 error prop 傳進來
const props = defineProps({
  error: Object, // { statusCode, statusMessage, message, ... }
})

// 清掉錯誤並導回某頁（不呼叫的話會一直停在錯誤畫面）
function handleClear() {
  clearError({ redirect: '/' })
}
</script>

<template>
  <div class="error-page">
    <h1>{{ error.statusCode }}</h1>
    <p>{{ error.statusMessage || '發生了一點問題' }}</p>
    <button @click="handleClear">回首頁</button>
  </div>
</template>
```

重點：

- `error.vue` **不會**套用你的 layout（它是完全獨立的畫面），所以頁首頁尾要自己補。
- `error.statusCode` 常見是 `404`（找不到）或 `500`（伺服器錯誤）。
- 一定要提供 `clearError()` 的出口，否則使用者會卡在錯誤頁。`clearError({ redirect: '/' })` 會清掉錯誤並導到指定網址。

> 想主動丟出錯誤（例如查無資料時回 404），用 `throw createError({ statusCode: 404, statusMessage: '找不到文章' })`。這個第 6、13 章抓資料時會大量用到，這裡先知道錯誤最後會落在 `error.vue`。

---

## 7. 本章小練習

1. 把上一章的導覽列從 `app.vue` 搬到 `app/layouts/default.vue`，讓 `app.vue` 只剩 `<NuxtLayout><NuxtPage /></NuxtLayout>`。
2. 做一個含側邊欄的 `blog.vue`，讓 `/posts` 與 `/posts/[id]` 都用它。
3. 做 `app/error.vue`，故意打一個不存在的網址觸發 404，確認錯誤頁出現、按鈕能回首頁。
4. 把某一頁設成 `layout: false`，觀察它是不是真的沒有頁首頁尾。

---

## 最後範例：把部落格重構成版面制

> 沿用第 2 章的頁面資料，抽出 `default` 與 `blog` 兩種版面，並補上錯誤頁。原樣建立以下檔案即可跑（`app/utils/posts.js` 沿用第 2 章那份）。

### `app/utils/posts.js`（沿用第 2 章）

```js
export const posts = [
  { id: 1, title: 'Nuxt 是什麼', body: 'Nuxt 把 Vue 變成可上線的全端框架。' },
  { id: 2, title: '檔案式路由', body: 'app/pages/ 底下放檔案，網址自動長出來。' },
  { id: 3, title: 'Universal Rendering', body: '先在伺服器算好 HTML，再讓瀏覽器接手。' },
]

export function findPost(id) {
  return posts.find((p) => p.id === Number(id))
}
```

### `app/app.vue`

```vue
<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>

<style>
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, "Segoe UI", sans-serif; color: #111827; background: #f3f4f6; }
.layout { min-height: 100vh; display: flex; flex-direction: column; }
.topbar { display: flex; align-items: center; gap: 24px; padding: 12px 24px; background: #111827; color: #fff; }
.topbar a { color: #d1d5db; text-decoration: none; margin-right: 12px; }
.topbar a:hover, .topbar a.router-link-active { color: #00dc82; }
.content { flex: 1; max-width: 720px; width: 100%; margin: 0 auto; padding: 24px; }
.foot { text-align: center; padding: 16px; color: #6b7280; font-size: 14px; }
.blog-shell { flex: 1; max-width: 960px; width: 100%; margin: 0 auto; padding: 24px; display: grid; grid-template-columns: 200px 1fr; gap: 24px; }
.sidebar { background: #fff; padding: 16px; border-radius: 12px; height: fit-content; }
.sidebar ul { list-style: none; padding: 0; }
.sidebar a { color: #111827; text-decoration: none; }
.sidebar a:hover { color: #00b86b; }
.blog-main { background: #fff; padding: 24px; border-radius: 12px; }
.post-list { list-style: none; padding: 0; }
.post-list li { padding: 12px 0; border-bottom: 1px solid #f3f4f6; }
.post-list a { color: #111827; text-decoration: none; font-weight: 600; }
.post-list a:hover { color: #00b86b; }
.back { color: #2563eb; text-decoration: none; }
.error-page { max-width: 480px; margin: 80px auto; text-align: center; font-family: sans-serif; }
.error-page h1 { font-size: 64px; margin: 0; color: #00dc82; }
.error-page button { margin-top: 16px; padding: 10px 20px; border: none; border-radius: 10px; background: #111827; color: #fff; cursor: pointer; }
</style>
```

### `app/layouts/default.vue`

```vue
<template>
  <div class="layout">
    <header class="topbar">
      <strong>My Blog</strong>
      <nav>
        <NuxtLink to="/">首頁</NuxtLink>
        <NuxtLink to="/posts">文章</NuxtLink>
        <NuxtLink to="/about">關於</NuxtLink>
      </nav>
    </header>
    <main class="content"><slot /></main>
    <footer class="foot">© 2026 My Blog · default layout</footer>
  </div>
</template>
```

### `app/layouts/blog.vue`

```vue
<template>
  <div class="layout">
    <header class="topbar">
      <strong>My Blog</strong>
      <NuxtLink to="/">回首頁</NuxtLink>
    </header>
    <div class="blog-shell">
      <aside class="sidebar">
        <h3>分類</h3>
        <ul>
          <li><NuxtLink to="/posts">全部文章</NuxtLink></li>
          <li><NuxtLink to="/about">關於作者</NuxtLink></li>
        </ul>
      </aside>
      <main class="blog-main"><slot /></main>
    </div>
  </div>
</template>
```

### `app/error.vue`

```vue
<script setup>
defineProps({ error: Object })
function handleClear() {
  clearError({ redirect: '/' })
}
</script>

<template>
  <div class="error-page">
    <h1>{{ error.statusCode }}</h1>
    <p>{{ error.statusMessage || '發生了一點問題' }}</p>
    <button @click="handleClear">回首頁</button>
  </div>
</template>
```

### `app/pages/index.vue`（用 default 版面）

```vue
<template>
  <section>
    <h1>首頁</h1>
    <p>這頁沒指定 layout，套用 <code>default</code> 版面（頁首 + 頁尾）。</p>
    <p><NuxtLink to="/posts">看所有文章 →</NuxtLink></p>
  </section>
</template>
```

### `app/pages/about.vue`

```vue
<template>
  <section>
    <h1>關於</h1>
    <p>資料夾就是路由，<code>about.vue</code> 自動對應 <code>/about</code>。</p>
  </section>
</template>
```

### `app/pages/posts/index.vue`（改用 blog 版面）

```vue
<script setup>
definePageMeta({ layout: 'blog' })   // 換成有側邊欄的版面
</script>

<template>
  <div>
    <h1>文章列表</h1>
    <ul class="post-list">
      <li v-for="post in posts" :key="post.id">
        <NuxtLink :to="`/posts/${post.id}`">{{ post.title }}</NuxtLink>
      </li>
    </ul>
  </div>
</template>
```

### `app/pages/posts/[id].vue`（也用 blog 版面 + 查無資料丟 404）

```vue
<script setup>
definePageMeta({
  layout: 'blog',
  validate: (route) => /^\d+$/.test(route.params.id),
})

const route = useRoute()
const post = findPost(route.params.id)

// 查無此文 → 主動丟 404，最後會落在 app/error.vue
if (!post) {
  throw createError({ statusCode: 404, statusMessage: '找不到文章' })
}
</script>

<template>
  <div>
    <p><NuxtLink to="/posts" class="back">← 回列表</NuxtLink></p>
    <h1>{{ post.title }}</h1>
    <p>{{ post.body }}</p>
  </div>
</template>
```

跑起來後：

- `/` 與 `/about` → `default` 版面（頁首 + 頁尾）。
- `/posts`、`/posts/1` → `blog` 版面（左側分類側邊欄），切頁時側邊欄不重繪。
- `/posts/999` → `createError` 丟 404 → 顯示 `error.vue`，按「回首頁」用 `clearError` 復原。
- `/posts/abc` → `validate` 失敗 → 一樣走 `error.vue`。

---

## 本章結語

現在版面、頁面、錯誤頁各司其職，畫面結構乾淨了。你可能已經注意到：`ref`、`posts`、`findPost`、`NuxtLink` 我們都沒 `import` 就直接用了——這就是 Nuxt 的**自動匯入**。
下一章把自動匯入講透，並帶你寫第一個 **composable**，還有處理「只在瀏覽器跑」的 `<ClientOnly>`。
