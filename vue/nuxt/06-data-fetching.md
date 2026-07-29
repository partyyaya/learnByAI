# 第 6 章：資料抓取（useFetch / useAsyncData / $fetch）

## 本章目標

完成這一章後，你應該可以：

1. 分清 `useFetch`、`useAsyncData`、`$fetch` 三者的定位與選用時機。
2. 用 `useFetch` 在伺服器就抓好資料，隨 HTML 一起送到瀏覽器（避免瀏覽器重抓）。
3. 熟練常用選項：`key`、`lazy`、`server`、`query`、`transform`、`pick`、`watch`。
4. 用 `status` / `error` / `refresh` 處理載入、錯誤與重新抓取。
5. 避開 Nuxt 4 資料抓取的常見坑（`shallowRef`、key 撞號、在 `useFetch` 裡包 `$fetch`）。

---

## 1. 三兄弟的定位

| 工具 | 是什麼 | 用在哪 | 會參與 SSR？ |
|---|---|---|---|
| `$fetch` | 底層的 HTTP 請求函式（包了 `fetch`） | 事件處理、送出表單、在 server 端呼叫 | 你自己決定 |
| `useAsyncData` | 把「任意 async 函式」包成 SSR 友善的資料 | 資料來源不是單純一個 URL 時 | ✅ |
| `useFetch` | `useAsyncData` + `$fetch` 的糖 | 「抓某個 URL 當頁面資料」的九成情況 | ✅ |

一句話：

> **畫面要用的資料，用 `useFetch` / `useAsyncData`（它們會在 SSR 抓好、傳給前端，不重抓）；使用者「按下去」才發生的請求，用 `$fetch`。**

---

## 2. 為什麼不能直接用 `$fetch` 抓頁面資料？

你可能會想：抓資料不就 `const data = await $fetch('/api/posts')` 嗎？在 Nuxt 這樣做會踩坑：

因為 Universal Rendering，元件會在**伺服器跑一次、瀏覽器再跑一次**。若你直接 `$fetch`，那麼**兩邊都會各打一次 API**——伺服器抓完算好 HTML，瀏覽器 hydrate 時又抓一次，白白多一次請求。

`useFetch` / `useAsyncData` 解決這件事：它們在**伺服器抓好資料後，把結果序列化進 HTML 的 payload**，瀏覽器 hydration 時**直接拿現成的**，不再打第二次。

> 記這條鐵則：**頁面初始資料 → `useFetch`/`useAsyncData`；使用者互動觸發的請求 → `$fetch`。**

---

## 3. `useFetch`：最常用

```vue
<script setup>
// 在 setup 頂層呼叫。data 會在 SSR 就抓好
const { data: posts, status, error, refresh } = await useFetch('/api/posts')
</script>

<template>
  <div v-if="status === 'pending'">載入中…</div>
  <div v-else-if="error">載入失敗：{{ error.message }}</div>
  <ul v-else>
    <li v-for="p in posts" :key="p.id">{{ p.title }}</li>
  </ul>
</template>
```

回傳的東西：

| 名稱 | 意義 |
|---|---|
| `data` | 抓到的資料（Nuxt 4 是 `shallowRef`，見第 8 節） |
| `status` | `'idle'` / `'pending'` / `'success'` / `'error'` |
| `error` | 錯誤物件（沒錯就是 `null`） |
| `refresh()` | 重新抓一次 |
| `clear()` | 清空 data / error |

> `await useFetch(...)` 前面那個 `await` 會讓 SSR「等資料抓完才產出 HTML」，所以首屏就有內容。若不想等（見第 5 節 `lazy`），可以不 await。

---

## 4. 常用選項

`useFetch(url, options)` 的 `options` 很實用：

```vue
<script setup>
const route = useRoute()
const page = ref(1)

const { data } = await useFetch('/api/posts', {
  // 查詢字串：等同 /api/posts?page=1。page 是 ref，變動時會自動重抓
  query: { page },

  // 只把回傳資料的某些欄位留下來（減少傳給前端的 payload）
  pick: ['id', 'title'],

  // 對回傳資料做轉換（例如加工、排序）
  transform: (posts) => posts.map((p) => ({ ...p, title: p.title.toUpperCase() })),

  // 自訂快取 key（同 key 會共用，見第 8 節）
  key: `posts-${route.params.id}`,
})
</script>
```

| 選項 | 作用 |
|---|---|
| `query`（或 `params`） | 附加查詢字串；值可以是 `ref`，變動時自動重抓 |
| `method` / `body` | 改用 POST 等，帶 request body |
| `headers` | 自訂標頭 |
| `pick` | 只保留指定欄位，縮小 payload |
| `transform` | 抓到後先加工再存進 `data` |
| `default` | 資料還沒到時的預設值 |
| `watch` | 監看哪些來源、變動就重抓 |

---

## 5. `lazy` 與 `server`：控制「何時抓、在哪抓」

預設 `useFetch` 會**阻塞導覽**（等資料到才進頁）。有時你希望先進頁、資料在背景載入：

```vue
<script setup>
// lazy: true → 不阻塞，先進頁面，data 之後才填上（記得處理 pending 狀態）
const { data, status } = useFetch('/api/posts', { lazy: true })
// 等同 useLazyFetch('/api/posts')
</script>
```

`server` 控制要不要在伺服器抓：

```vue
<script setup>
// server: false → 完全跳過 SSR 抓取，只在瀏覽器抓（適合非 SEO、又慢又私密的資料）
const { data } = useFetch('/api/dashboard', { lazy: true, server: false })
</script>
```

| 選項 | 效果 |
|---|---|
| `lazy: true` | 不阻塞導覽，資料背景載入 |
| `server: false` | 不在 SSR 抓，只在 client 抓 |
| 兩者都設 | 常見於「登入後儀表板」這類不需 SEO 的資料 |

> 口訣：**要 SEO / 首屏要有** → 預設（阻塞 + SSR）；**次要資料、可晚點出現** → `lazy`；**私密或很慢、不需 SEO** → `lazy` + `server: false`。

---

## 6. `useAsyncData`：來源不是單一 URL 時

當你的資料不是「打一個 URL」那麼單純（例如同時打兩支 API、或呼叫 SDK），用 `useAsyncData(key, fn)`：

```vue
<script setup>
const { data } = await useAsyncData('home', async () => {
  // 這個 async 函式在 SSR 執行；裡面可以用 $fetch 併多支 API
  const [posts, tags] = await Promise.all([
    $fetch('/api/posts'),
    $fetch('/api/tags'),
  ])
  return { posts, tags }
})
</script>
```

- 第一個參數是**唯一 key**（給快取與去重用）。
- 第二個是回傳資料的 async 函式。

> `useFetch(url)` 其實就是 `useAsyncData(url, () => $fetch(url))` 的糖。看到「要併多支 API」或「要包 SDK 呼叫」就用 `useAsyncData`。

---

## 7. `$fetch`：互動時才發的請求

使用者點按鈕、送表單時，用 `$fetch` 直接打：

```vue
<script setup>
const title = ref('')

async function createPost() {
  // 送出新文章。這是「使用者觸發」，不需要 SSR，所以用 $fetch
  await $fetch('/api/posts', {
    method: 'POST',
    body: { title: title.value },
  })
  title.value = ''
  // 通常搭配 refresh() 讓列表更新（見下一節）
}
</script>
```

`$fetch` 的好處：自動幫你把回應 JSON parse 好、非 2xx 會 throw、在 server 端呼叫自家 `/api` 時還會**直接走內部函式呼叫**（不繞一圈 HTTP，超快）。

---

## 8. Nuxt 4 三個一定要知道的坑

**① `data` 是 `shallowRef`（Nuxt 4 改動）**

Nuxt 4 把 `useFetch`/`useAsyncData` 的 `data` 改成 `shallowRef` 以提升效能。意思是：**直接改深層屬性不會觸發畫面更新**。

```js
const { data } = await useFetch('/api/posts')

data.value[0].title = 'x'   // ❌ 畫面可能不更新（深層變動不追蹤）
data.value = [...data.value] // ✅ 換掉整個 .value 才會觸發
```

要更新資料，優先用 `refresh()` 重抓，或整個換掉 `data.value`。

**② 同 `key` 會共用資料（Nuxt 4 改動）**

Nuxt 4 中，所有相同 `key` 的 `useFetch`/`useAsyncData` **共用同一份 `data`/`error`/`status`**。這很好用（多元件抓同資料不會重打），但也代表 **key 不能撞**——不同資料用不同 key。`useFetch(url)` 沒給 key 時會用 URL + 選項自動算一個。

**③ 不要在 `useFetch` 裡再包一層 `$fetch`**

```js
// ❌ 多此一舉，等於抓兩次的心智負擔
const { data } = await useFetch(() => $fetch('/api/posts'))

// ✅ 直接給 URL
const { data } = await useFetch('/api/posts')

// ✅ 真要自訂邏輯就用 useAsyncData
const { data } = await useAsyncData('posts', () => $fetch('/api/posts'))
```

---

## 9. 站內切頁的快取：`getCachedData` 與 `useNuxtData`

**坑：站內來回切頁，`useFetch` 預設會「再抓一次」。** 你從列表點進詳情、再退回列表，`useFetch` 往往會重新發一次請求。想「切回來直接沿用之前抓好的、不重打」，用 `getCachedData` 指定「怎麼取快取」：

```vue
<script setup>
const { data: posts } = await useFetch('/api/posts', {
  key: 'posts',
  // 有快取就用：payload.data 是 SSR 傳來的、static.data 是 client 導覽時抓過的；兩個都沒有才重抓
  getCachedData: (key, nuxtApp) => nuxtApp.payload.data[key] ?? nuxtApp.static.data[key],
})
</script>
```

**`useNuxtData(key)`：讀「別頁已經抓好」的資料。** 經典情境是「列表 → 詳情」：列表頁已抓過所有文章，進詳情頁時先拿列表快取裡的那一筆**立刻顯示**，再背景抓完整內容更新，體感秒開：

```vue
<script setup>
const route = useRoute()

// 讀列表頁（key: 'posts'）已抓好的資料，從中挑出這一筆當「初始值」
const { data: cachedPosts } = useNuxtData('posts')
const initial = cachedPosts.value?.find((p) => p.id === Number(route.params.id))

// 再抓完整單篇；default 先給快取那筆，使用者不會先看到空白再跳出內容
const { data: post } = await useFetch(`/api/posts/${route.params.id}`, {
  key: `post-${route.params.id}`,
  default: () => initial,
})
</script>
```

> 承第 8 節：`useFetch`/`useAsyncData` 的 `data` 預設是 **`shallowRef`**（只追蹤整包替換、不追蹤深層屬性）。若你確實需要深層響應（例如就地改 `data.value.xxx` 要即時反映到畫面），加 `deep: true` 讓它變回深層響應式的 `ref`（代價是稍多一點效能開銷）。

---

## 10. SSR 下 `$fetch` 不帶 cookie 的坑：`useRequestFetch` / `useRequestHeaders`

這個坑做認證後最容易踩，先建立觀念，第 11 章會實際用到。

`useFetch` 底層用的是 **`useRequestFetch()`**——SSR 期間它會**自動把瀏覽器這次請求的 cookie 轉發**給你要打的 API。所以 SSR 時 `useFetch('/api/me')` 能帶著登入 cookie，順利通過伺服器端的 `requireUserSession`（第 11 章）。

但如果你在 SSR 期間改用**裸的 `$fetch`** 去打自家受保護 API，就沒有這層自動轉發：

```js
// ❌ 在 setup 頂層（SSR 也會執行）用裸 $fetch 打受保護 API
// 「你的伺服器 → 再打自己 API」這段是全新請求，預設不帶瀏覽器的 cookie → 直接 401
const me = await $fetch('/api/me')
```

原因：SSR 時「瀏覽器 → 你的 Nuxt 伺服器」帶了 cookie，但「你的伺服器 → 用 `$fetch` 再打自己的 API」是另一段全新的請求，預設不會把前一段的 cookie 接力過去。

兩種解法：

```js
// 解法 A（推薦）：用 useRequestFetch()，它會自動轉發當前請求的 cookie 等 headers
const requestFetch = useRequestFetch()
const me = await requestFetch('/api/me')

// 解法 B：手動把瀏覽器的 cookie header 轉發過去
const me = await $fetch('/api/me', {
  headers: useRequestHeaders(['cookie']),
})
```

> 口訣：**頁面資料照用 `useFetch`（它已經用 `useRequestFetch`，cookie 自動帶）；只有在「SSR 期間手動 `$fetch` 自家受保護 API」時，才需要 `useRequestFetch()` 或 `useRequestHeaders(['cookie'])` 補上 cookie。** 純瀏覽器端（使用者互動觸發）的 `$fetch` 本來就會帶 cookie，不受這個坑影響。

---

## 11. 本章小練習

1. 用 `useFetch` 抓一支公開 API（例如 `https://jsonplaceholder.typicode.com/posts`）並列出標題。
2. 加上 `query: { _limit: 5 }` 只取 5 筆，再把 `_limit` 換成 `ref` 做「載入更多」。
3. 用 `status` 顯示載入中、用 `error` 顯示錯誤（把網址打錯測試）。
4. 做一顆「重新整理」按鈕呼叫 `refresh()`。
5. 把某支慢 API 改成 `lazy: true`，體會「先進頁、資料後到」。

---

## 最後範例：文章列表 + 詳情（真實 API + 載入/錯誤/重抓）

> 用公開 API 取代前幾章寫死的資料，示範阻塞式 SSR 抓取、動態參數重抓、載入/錯誤狀態與 `refresh`。原樣建立以下檔案即可跑（不需自己的後端，第 8 章才自架 API）。

### `app/app.vue`

```vue
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
body { margin: 0; font-family: -apple-system, "Segoe UI", sans-serif; }
.wrap { max-width: 680px; margin: 0 auto; padding: 24px; line-height: 1.7; color: #111827; }
.nav { display: flex; gap: 16px; padding-bottom: 12px; border-bottom: 1px solid #eee; margin-bottom: 16px; }
.nav a { color: #111827; text-decoration: none; }
.nav a.router-link-active { color: #00dc82; font-weight: 600; }
.card { background: #fff; border: 1px solid #eee; padding: 14px 16px; border-radius: 12px; margin-bottom: 10px; }
.card a { color: #111827; text-decoration: none; font-weight: 600; }
.card a:hover { color: #00b86b; }
.state { padding: 12px; border-radius: 10px; }
.state.loading { background: #f3f4f6; color: #6b7280; }
.state.error { background: #fef2f2; color: #b91c1c; }
.btn { padding: 8px 14px; border: none; border-radius: 10px; background: #111827; color: #fff; cursor: pointer; }
.back { color: #2563eb; text-decoration: none; }
</style>
```

### `app/pages/index.vue`

```vue
<template>
  <section>
    <h1>資料抓取示範</h1>
    <p>用 <code>useFetch</code> 從公開 API 抓文章，在伺服器就抓好、隨 HTML 送來。</p>
    <p><NuxtLink to="/posts">看文章列表 →</NuxtLink></p>
  </section>
</template>
```

### `app/pages/posts/index.vue`

```vue
<script setup>
const limit = ref(5)

// 阻塞式 SSR 抓取：首屏就有文章。limit 是 ref，改變時自動重抓。
const { data: posts, status, error, refresh } = await useFetch(
  'https://jsonplaceholder.typicode.com/posts',
  {
    query: { _limit: limit },
    // 只留需要的欄位，縮小傳給前端的 payload
    transform: (list) => list.map((p) => ({ id: p.id, title: p.title })),
  },
)
</script>

<template>
  <section>
    <h1>文章列表</h1>

    <div v-if="status === 'pending'" class="state loading">載入中…</div>
    <div v-else-if="error" class="state error">載入失敗：{{ error.message }}</div>

    <template v-else>
      <div v-for="post in posts" :key="post.id" class="card">
        <NuxtLink :to="`/posts/${post.id}`">{{ post.title }}</NuxtLink>
      </div>

      <p>
        <button class="btn" @click="limit += 5">載入更多（目前 {{ limit }} 筆）</button>
        <button class="btn" style="background:#374151" @click="refresh()">重新整理</button>
      </p>
    </template>
  </section>
</template>
```

### `app/pages/posts/[id].vue`

```vue
<script setup>
definePageMeta({
  validate: (route) => /^\d+$/.test(route.params.id),
})

const route = useRoute()

// key 綁 id，切換不同文章時各自快取、不撞號
const { data: post, status, error } = await useFetch(
  () => `https://jsonplaceholder.typicode.com/posts/${route.params.id}`,
  { key: `post-${route.params.id}` },
)

// 查無資料丟 404（API 對不存在 id 會回錯，error 會有值）
if (error.value) {
  throw createError({ statusCode: 404, statusMessage: '找不到文章' })
}
</script>

<template>
  <section>
    <p><NuxtLink to="/posts" class="back">← 回列表</NuxtLink></p>
    <div v-if="status === 'pending'" class="state loading">載入中…</div>
    <article v-else-if="post">
      <h1>{{ post.title }}</h1>
      <p>{{ post.body }}</p>
    </article>
  </section>
</template>
```

跑起來後：

- `/posts` → 首屏就有 5 篇（檢視原始碼可看到標題，證明 SSR 抓好了）。
- 「載入更多」→ `limit` 變動觸發自動重抓，變 10、15…筆。
- 「重新整理」→ `refresh()` 重抓。
- 點標題進 `/posts/1` → 用 `route.params.id` 動態組 URL，切不同文章各自快取。
- `/posts/99999` → API 回錯 → `createError` 走 `error.vue`。

---

## 本章結語

你現在能在伺服器就把真實資料抓好、控制載入時機、處理錯誤與重抓——這是 Nuxt 資料流的核心。
但抓來的資料常常要**跨頁面、跨元件共享**（例如購物車、目前使用者）。下一章把狀態管理講透：從 SSR 安全的 `useState`，到正式導入 **Pinia**。
