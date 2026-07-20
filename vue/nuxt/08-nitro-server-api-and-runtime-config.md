# 第 8 章：Nitro 伺服器 API 與 Runtime Config

## 本章目標

完成這一章後，你應該可以：

1. 說出 Nitro 是什麼，以及 `server/` 目錄各子資料夾的用途。
2. 在 `server/api/` 用 `defineEventHandler` 寫自己的 API，並用檔名指定 HTTP method。
3. 用 `getQuery` / `readBody` / `getRouterParam` 讀取請求輸入，用 `createError` 回錯誤。
4. 用 `server/middleware/` 與 `server/utils/` 做共用邏輯。
5. 用 **Runtime Config** 管環境變數與金鑰，分清 `public` 與私密設定、以及與 `app.config` 的差異。

---

## 1. Nitro 是什麼

Nuxt 內建一個伺服器引擎叫 **Nitro**。它讓你不必另外開一個 Express/後端專案，就能直接寫 API、伺服器中介層，還能一鍵部署到各種平台（第 16 章）。

`server/` 目錄（在專案根、**不在** `app/`）就是 Nitro 的地盤：

```text
server/
├─ api/           → API 端點，網址自動加上 /api 前綴
├─ routes/        → 伺服器路由，網址「不加」/api（例如 /sitemap.xml）
├─ middleware/    → 每個請求都會先跑（記錄、驗證…）
└─ utils/         → 伺服器端共用函式（自動匯入）
```

> 這裡的程式碼**只在伺服器執行**，永遠不會被打包進瀏覽器。所以放金鑰、連資料庫、用 Node API 都安全（第 10、11 章大量用到）。

---

## 2. 第一個 API

在 `server/api/hello.js` 放：

```js
// server/api/hello.js  → 對應 /api/hello
export default defineEventHandler((event) => {
  // 回傳的物件/陣列會自動被序列化成 JSON
  return { message: 'Hello from Nitro' }
})
```

啟動 `npm run dev`，打開 `http://localhost:3000/api/hello` 就看到 JSON。`defineEventHandler` 是所有 handler 的外殼，它拿到一個 `event`（含請求資訊）。

> `server/api/` 底下的檔案**不需要自己 import 任何東西**：`defineEventHandler`、`getQuery`、`readBody`、`createError` 這些都是 Nitro 自動匯入的（來自底層的 h3）。

---

## 3. 用檔名指定 HTTP method

同一個資源常要支援多種 method。Nitro 用**檔名後綴**區分：

```text
server/api/
├─ posts.get.js       → GET  /api/posts     （列表）
├─ posts.post.js      → POST /api/posts     （新增）
└─ posts/
   ├─ [id].get.js     → GET    /api/posts/:id
   ├─ [id].put.js     → PUT    /api/posts/:id
   └─ [id].delete.js  → DELETE /api/posts/:id
```

- 沒有後綴（`posts.js`）→ 接受**所有** method。
- 有後綴（`.get` / `.post` / `.put` / `.delete` / `.patch`）→ 只接該 method。
- 中括號 `[id]` 是動態片段，用 `getRouterParam(event, 'id')` 取值。

---

## 4. 讀取請求輸入

三個最常用的：

```js
// GET /api/posts?page=2&limit=10
export default defineEventHandler((event) => {
  const query = getQuery(event) // { page: '2', limit: '10' }（都是字串）
  return query
})
```

```js
// POST /api/posts  （body 是 JSON）
export default defineEventHandler(async (event) => {
  const body = await readBody(event) // { title: '...', content: '...' }
  return { received: body }
})
```

```js
// GET /api/posts/123
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id') // '123'（字串）
  return { id }
})
```

| 函式 | 拿什麼 |
|---|---|
| `getQuery(event)` | 查詢字串（`?a=1`） |
| `readBody(event)` | request body（需 `await`） |
| `getRouterParam(event, 'id')` | 動態路由參數（`[id]`） |
| `getHeader(event, 'x')` | 某個標頭 |
| `getCookie(event, 'x')` | 某個 cookie（第 11 章認證用） |

---

## 5. 回傳與丟錯誤

**成功**：直接 `return` 物件、陣列、字串——Nitro 幫你設好 JSON header。

**失敗**：用 `createError` 丟，Nitro 會回對應的 HTTP 狀態碼：

```js
export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  const post = findPost(id)

  if (!post) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Post not found',
    })
  }
  return post
})
```

前端用 `useFetch`/`$fetch` 打這支 API 時，這個 404 會變成 `error`，你可以再 `throw createError` 導到 `error.vue`（第 3、6 章）。

> 想設狀態碼但不算錯誤（例如新增成功回 201）：用 `setResponseStatus(event, 201)`。

---

## 6. `server/utils/`：共用邏輯與「假資料庫」

`server/utils/` 底下的匯出會**自動匯入**到所有 server 檔案。很適合放共用邏輯。第 10 章接真資料庫前，我們先用一個記憶體陣列當假 DB：

```js
// server/utils/db.js
let posts = [
  { id: 1, title: 'Nuxt 是什麼', content: '把 Vue 變全端框架。' },
  { id: 2, title: 'Nitro', content: 'Nuxt 內建的伺服器引擎。' },
]
let nextId = 3

export const db = {
  all: () => posts,
  find: (id) => posts.find((p) => p.id === Number(id)),
  create: (data) => {
    const post = { id: nextId++, ...data }
    posts.push(post)
    return post
  },
  remove: (id) => {
    posts = posts.filter((p) => p.id !== Number(id))
  },
}
```

> ⚠️ 記憶體資料重啟就沒了、也無法多台伺服器共用，**只適合教學/雛形**。第 10 章換成 Prisma + SQLite 就能持久化。

---

## 7. `server/middleware/`：每個請求都先跑

`server/middleware/` 的檔案會在**每個請求**進到 API/頁面前先執行，常用來記錄、驗證、附掛資料到 `event.context`：

```js
// server/middleware/logger.js
export default defineEventHandler((event) => {
  // 不回傳東西 → 只是「路過做點事」，然後放行
  console.log(`[${event.method}] ${event.path}`)
})
```

> 注意：**server middleware 不要回傳值**（回傳會被當成該請求的回應而中斷）。它只做副作用或往 `event.context` 掛東西（例如把解出來的使用者放 `event.context.user`，第 11 章會用）。

---

## 8. 呼叫自己的 API

- **頁面初始資料**：用第 6 章的 `useFetch('/api/posts')`（SSR 會抓好）。
- **互動觸發**：用 `$fetch('/api/posts', { method: 'POST', body })`。
- **在另一支 server API 裡呼叫**：一樣能用 `$fetch('/api/xxx')`，Nitro 會**直接走內部函式呼叫**，不繞真的 HTTP，很快。

```vue
<script setup>
// 頁面：SSR 抓列表
const { data: posts, refresh } = await useFetch('/api/posts')

// 互動：新增後刷新
async function add() {
  await $fetch('/api/posts', { method: 'POST', body: { title: '新文章', content: '...' } })
  await refresh()
}
</script>
```

---

## 9. Runtime Config：管環境變數與金鑰

硬寫金鑰在程式裡會外洩、也難換環境。Nuxt 用 `runtimeConfig` 統一管：

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  runtimeConfig: {
    // 私密：只在「伺服器端」讀得到，不會進瀏覽器
    apiSecret: '',          // 對應環境變數 NUXT_API_SECRET
    dbUrl: 'file:./dev.db', // 對應 NUXT_DB_URL

    // public：伺服器與瀏覽器都讀得到（不要放機密！）
    public: {
      apiBase: '/api',      // 對應 NUXT_PUBLIC_API_BASE
      siteName: 'My Blog',
    },
  },
})
```

規則：

- `runtimeConfig` 頂層的鍵 → **只有伺服器讀得到**（放金鑰、DB 連線字串）。
- `runtimeConfig.public` 的鍵 → **前後端都讀得到**（放非機密設定）。

### 用 `.env` 覆蓋

不要把真金鑰寫進 `nuxt.config`。在專案根放 `.env`，用 `NUXT_` 前綴對應覆蓋：

```bash
# .env（記得加進 .gitignore）
NUXT_API_SECRET=super-secret-value
NUXT_PUBLIC_API_BASE=https://api.example.com
```

對應規則：`NUXT_API_SECRET` → `runtimeConfig.apiSecret`；`NUXT_PUBLIC_API_BASE` → `runtimeConfig.public.apiBase`（`PUBLIC_` 對到 `public`，底線分隔轉 camelCase）。

### 讀取

```js
// 伺服器端（server/api/*）：讀得到全部，含私密。傳入 event 較佳
export default defineEventHandler((event) => {
  const config = useRuntimeConfig(event)
  const secret = config.apiSecret        // ✅ 私密，只有這裡讀得到
  const base = config.public.apiBase
  return { base }
})
```

```vue
<script setup>
// 前端（元件）：只讀得到 public
const config = useRuntimeConfig()
console.log(config.public.siteName) // ✅
console.log(config.apiSecret)       // ❌ undefined（不會外洩到瀏覽器）
</script>
```

> 經典用途：**用 server API 當代理去打第三方服務，金鑰藏在 `apiSecret`**，瀏覽器完全看不到。這是 Nuxt 相對純前端最重要的安全優勢之一。

### 和 `app.config.ts` 差在哪？

| | `runtimeConfig` | `app.config.ts` |
|---|---|---|
| 何時決定 | **執行時**（可被環境變數覆蓋） | **打包時**寫死 |
| 能放機密？ | 頂層可（伺服器限定） | ❌ 都會進前端 |
| 響應式 | 否 | 是（可在畫面即時反應） |
| 適合 | 金鑰、環境差異設定 | 主題色、功能開關這類公開設定 |

一句話：**會因環境不同、或是機密 → `runtimeConfig`；純前端的公開設定、想響應式 → `app.config`。**

---

## 10. 本章小練習

1. 寫 `GET /api/hello` 回你的名字，瀏覽器直接打開網址確認。
2. 用 `server/utils/db.js` 做假資料庫，實作 `GET /api/posts`、`GET /api/posts/[id]`（查無回 404）、`POST /api/posts`。
3. 頁面用 `useFetch` 顯示列表，做一個表單用 `$fetch` 新增後 `refresh`。
4. 加一支 `server/middleware/logger.js` 印出每個請求，觀察 terminal。
5. 在 `runtimeConfig.public` 放 `siteName`，在頁首顯示；在私密區放一個假 `apiSecret`，確認前端讀不到。

---

## 最後範例：自架文章 API + 前端串接 + Runtime Config

> 用 Nitro 做出一個記憶體版文章 API（列表/單篇/新增/刪除），前端完整串接，並用 runtimeConfig 顯示站名。原樣建立以下檔案即可跑（不需資料庫）。

### `nuxt.config.ts`

```ts
export default defineNuxtConfig({
  runtimeConfig: {
    apiSecret: 'demo-secret', // 只有伺服器讀得到
    public: {
      siteName: 'Nitro Blog',
    },
  },
})
```

### `server/utils/db.js`

```js
let posts = [
  { id: 1, title: 'Nuxt 是什麼', content: '把 Vue 變成可上線的全端框架。' },
  { id: 2, title: 'Nitro 引擎', content: 'server/ 目錄就能寫 API。' },
]
let nextId = 3

export const db = {
  all: () => posts,
  find: (id) => posts.find((p) => p.id === Number(id)),
  create: (data) => {
    const post = { id: nextId++, title: data.title, content: data.content }
    posts.push(post)
    return post
  },
  remove: (id) => {
    posts = posts.filter((p) => p.id !== Number(id))
  },
}
```

### `server/api/posts.get.js`

```js
export default defineEventHandler(() => {
  return db.all() // db 由 server/utils 自動匯入
})
```

### `server/api/posts.post.js`

```js
export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  if (!body?.title) {
    throw createError({ statusCode: 400, statusMessage: '標題必填' })
  }
  setResponseStatus(event, 201)
  return db.create({ title: body.title, content: body.content ?? '' })
})
```

### `server/api/posts/[id].get.js`

```js
export default defineEventHandler((event) => {
  const post = db.find(getRouterParam(event, 'id'))
  if (!post) {
    throw createError({ statusCode: 404, statusMessage: '找不到文章' })
  }
  return post
})
```

### `server/api/posts/[id].delete.js`

```js
export default defineEventHandler((event) => {
  db.remove(getRouterParam(event, 'id'))
  return { ok: true }
})
```

### `server/middleware/logger.js`

```js
export default defineEventHandler((event) => {
  console.log(`[${event.method}] ${event.path}`)
})
```

### `app/pages/index.vue`

```vue
<script setup>
const config = useRuntimeConfig()

// SSR 抓列表
const { data: posts, refresh } = await useFetch('/api/posts')

const title = ref('')
const content = ref('')

async function add() {
  if (!title.value) return
  await $fetch('/api/posts', { method: 'POST', body: { title: title.value, content: content.value } })
  title.value = ''
  content.value = ''
  await refresh() // 重抓列表
}

async function remove(id) {
  await $fetch(`/api/posts/${id}`, { method: 'DELETE' })
  await refresh()
}
</script>

<template>
  <main class="wrap">
    <h1>{{ config.public.siteName }}</h1>

    <form class="form" @submit.prevent="add">
      <input v-model="title" placeholder="標題" />
      <input v-model="content" placeholder="內容" />
      <button type="submit">新增</button>
    </form>

    <article v-for="p in posts" :key="p.id" class="card">
      <div>
        <strong>{{ p.title }}</strong>
        <p>{{ p.content }}</p>
      </div>
      <button class="del" @click="remove(p.id)">刪除</button>
    </article>
  </main>
</template>

<style>
body { margin: 0; font-family: -apple-system, "Segoe UI", sans-serif; background: #f3f4f6; }
.wrap { max-width: 620px; margin: 0 auto; padding: 24px; }
.form { display: flex; gap: 8px; margin-bottom: 16px; }
.form input { flex: 1; padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 8px; }
.form button { padding: 8px 16px; border: none; border-radius: 8px; background: #00dc82; color: #062; font-weight: 600; cursor: pointer; }
.card { display: flex; justify-content: space-between; align-items: center; background: #fff; border: 1px solid #eee; border-radius: 12px; padding: 12px 16px; margin-bottom: 10px; }
.card p { margin: 4px 0 0; color: #6b7280; }
.del { border: none; background: #fee2e2; color: #b91c1c; border-radius: 8px; padding: 6px 12px; cursor: pointer; }
</style>
```

跑起來後：

- 首頁標題來自 `runtimeConfig.public.siteName`（前端讀得到）。
- 列表由 `GET /api/posts` 在 SSR 抓好；檢視原始碼看得到文章。
- 新增走 `POST /api/posts`（後端擋空標題回 400）、刪除走 `DELETE`，都 `refresh` 更新。
- terminal 會印出每個請求（server middleware）。
- 直接打 `/api/posts` 看得到 JSON；`/api/posts/999` 回 404 JSON。

---

## 本章結語

你現在是全端了：前端畫面 + 自家 API + 安全的環境設定。
不過目前任何人都能新增/刪除文章。下一章先補上**路由中介層與導航守衛**，學會在「進頁面之前」攔截與導向，為第 11 章的登入權限鋪路。
