# 第 10 章：串接資料庫做全端 CRUD（Prisma + SQLite）

## 本章目標

完成這一章後，你應該可以：

1. 說出為什麼要把記憶體假資料換成真資料庫。
2. 安裝並初始化 **Prisma**，用 schema 定義資料模型並跑 migration。
3. 在 `server/utils/` 建立 **PrismaClient 單例**，避免開發時重複連線。
4. 用 Prisma 在 `server/api/` 寫出完整的 CRUD（列表 / 單篇 / 新增 / 更新 / 刪除）。
5. 前端用 `useFetch` 讀、`$fetch` 寫，並理解「樂觀更新」的概念。

---

## 1. 為什麼要真資料庫

第 8 章的 `server/utils/db.js` 用記憶體陣列存資料，問題是：

- **重啟就沒了**（HMR、部署都會清空）。
- **多台伺服器無法共用**（正式環境常多實例）。
- **沒有查詢能力**（排序、分頁、關聯都得自己刻）。

我們改用 **Prisma**（型別友善的 ORM）+ **SQLite**（免安裝、單檔資料庫，最適合學習）。正式環境把 SQLite 換成 PostgreSQL/MySQL，程式幾乎不用改。

---

## 2. 安裝與初始化 Prisma

```bash
npm install -D prisma          # CLI（開發用）
npm install @prisma/client     # 執行時用的 client
npx prisma init --datasource-provider sqlite
```

`prisma init` 會產生：

```text
prisma/
└─ schema.prisma      ← 資料模型定義
.env                  ← 內含 DATABASE_URL（Prisma 預設讀這裡）
```

打開 `.env` 確認（SQLite 用單檔）：

```bash
# .env
DATABASE_URL="file:./dev.db"
```

> Prisma 有自己讀 `.env` 的機制（`DATABASE_URL`），跟第 8 章 Nuxt 的 `runtimeConfig` 是兩套。記得把 `.env` 與 `*.db` 加進 `.gitignore`。

---

## 3. 定義資料模型

編輯 `prisma/schema.prisma`，加一個 `Post` 模型：

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

model Post {
  id        Int      @id @default(autoincrement())
  title     String
  content   String
  published Boolean  @default(false)
  createdAt DateTime @default(now())
}
```

跑 migration，把模型變成真的資料表，並產生 client：

```bash
npx prisma migrate dev --name init
```

這會：建立 `dev.db`、建立 `Post` 表、產生對應的 TypeScript client。之後每次改 schema，就再跑一次 `migrate dev --name 描述`。

> 想用 GUI 看/改資料，跑 `npx prisma studio`，會開一個網頁介面。

---

## 4. 建立 PrismaClient 單例

**不要在每支 API 各自 `new PrismaClient()`**——開發時 HMR 會重複建立，連線爆掉。標準做法是在 `server/utils/` 建一個單例（`server/utils/` 會自動匯入到所有 server 檔案）：

```js
// server/utils/prisma.js
import { PrismaClient } from '@prisma/client'

// 開發時 HMR 會重載模組，用 globalThis 快取避免重複 new
const globalForPrisma = globalThis

export const prisma = globalForPrisma.prisma || new PrismaClient()

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}
```

之後任何 server 檔案直接用 `prisma`，不用 import。

---

## 5. 寫 CRUD API

Prisma 的方法很直覺：`findMany` / `findUnique` / `create` / `update` / `delete`。

### `server/api/posts.get.js`（列表）

```js
export default defineEventHandler(async () => {
  return await prisma.post.findMany({
    orderBy: { createdAt: 'desc' },
  })
})
```

### `server/api/posts.post.js`（新增）

```js
export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  if (!body?.title) {
    throw createError({ statusCode: 400, statusMessage: '標題必填' })
  }
  setResponseStatus(event, 201)
  return await prisma.post.create({
    data: {
      title: body.title,
      content: body.content ?? '',
      published: body.published ?? false,
    },
  })
})
```

### `server/api/posts/[id].get.js`（單篇）

```js
export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  const post = await prisma.post.findUnique({ where: { id } })
  if (!post) {
    throw createError({ statusCode: 404, statusMessage: '找不到文章' })
  }
  return post
})
```

### `server/api/posts/[id].put.js`（更新）

```js
export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  const body = await readBody(event)
  try {
    return await prisma.post.update({
      where: { id },
      data: body, // { title?, content?, published? }
    })
  } catch {
    throw createError({ statusCode: 404, statusMessage: '找不到文章' })
  }
})
```

### `server/api/posts/[id].delete.js`（刪除）

```js
export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  await prisma.post.delete({ where: { id } }).catch(() => {})
  return { ok: true }
})
```

> 這幾支跟第 8 章長得幾乎一樣，只是把 `db.xxx()` 換成 `prisma.post.xxx()`——這就是把假 DB 換真 DB 的全部工作量。因為介面沒變，**前端完全不用改**。

---

## 6. 前端串接：讀用 useFetch、寫用 $fetch

概念沿用第 6、8 章：

```vue
<script setup>
// 讀：SSR 抓好列表
const { data: posts, refresh } = await useFetch('/api/posts')

// 寫：互動時 $fetch，完成後 refresh 重抓
async function createPost(payload) {
  await $fetch('/api/posts', { method: 'POST', body: payload })
  await refresh()
}
async function deletePost(id) {
  await $fetch(`/api/posts/${id}`, { method: 'DELETE' })
  await refresh()
}
</script>
```

### 樂觀更新（Optimistic Update）的概念

上面「等 API 回來再 `refresh`」最穩，但使用者要等一下。**樂觀更新**是「先改畫面、再送請求」，讓操作瞬間有反應；失敗再回滾：

```js
async function deleteOptimistic(id) {
  const backup = posts.value
  posts.value = posts.value.filter((p) => p.id !== id) // 先從畫面移除
  try {
    await $fetch(`/api/posts/${id}`, { method: 'DELETE' })
  } catch (e) {
    posts.value = backup // 失敗 → 還原
    alert('刪除失敗，已還原')
  }
}
```

> 記住第 6 章的坑：`useFetch` 的 `data` 是 `shallowRef`，所以要**整個換掉 `posts.value`**（用 `filter` 產生新陣列），不能只改深層。樂觀更新適合「幾乎不會失敗」的操作（刪除、按讚）；重要或易失敗的操作，還是等回應再 `refresh` 保險。

---

## 7. 本章小練習

1. 依上面步驟安裝 Prisma、建 `Post` 模型、跑 `migrate dev`，用 `prisma studio` 手動塞兩筆資料。
2. 完成五支 CRUD API，直接用瀏覽器/DevTools 打 `/api/posts` 驗證。
3. 前端做出列表 + 新增表單 + 刪除鈕（讀 `useFetch`、寫 `$fetch` + `refresh`）。
4. 幫刪除改成樂觀更新，並故意讓 API 失敗（例如刪不存在的 id 時丟錯）測試回滾。
5. 幫 `Post` 加一個 `author` 欄位，改 schema、再跑一次 `migrate dev`。

---

## 最後範例：可持久化的全端文章管理

> 把第 8 章的記憶體 API 全面升級成 Prisma + SQLite，資料重啟不消失。先完成第 2～5 節的安裝與 migration，再建立以下檔案即可跑。

### `prisma/schema.prisma`

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

model Post {
  id        Int      @id @default(autoincrement())
  title     String
  content   String
  published Boolean  @default(false)
  createdAt DateTime @default(now())
}
```

### `server/utils/prisma.js`

```js
import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis
export const prisma = globalForPrisma.prisma || new PrismaClient()
if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}
```

### `server/api/posts.get.js`

```js
export default defineEventHandler(async () => {
  return await prisma.post.findMany({ orderBy: { createdAt: 'desc' } })
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
  return await prisma.post.create({
    data: { title: body.title, content: body.content ?? '', published: !!body.published },
  })
})
```

### `server/api/posts/[id].get.js`

```js
export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  const post = await prisma.post.findUnique({ where: { id } })
  if (!post) throw createError({ statusCode: 404, statusMessage: '找不到文章' })
  return post
})
```

### `server/api/posts/[id].delete.js`

```js
export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  await prisma.post.delete({ where: { id } }).catch(() => {})
  return { ok: true }
})
```

### `app/pages/index.vue`

```vue
<script setup>
const { data: posts, refresh } = await useFetch('/api/posts')

const title = ref('')
const content = ref('')

async function add() {
  if (!title.value) return
  await $fetch('/api/posts', { method: 'POST', body: { title: title.value, content: content.value } })
  title.value = ''
  content.value = ''
  await refresh()
}

// 樂觀刪除：先改畫面，失敗再還原
async function remove(id) {
  const backup = posts.value
  posts.value = posts.value.filter((p) => p.id !== id)
  try {
    await $fetch(`/api/posts/${id}`, { method: 'DELETE' })
  } catch {
    posts.value = backup
  }
}
</script>

<template>
  <main class="wrap">
    <h1>文章管理（Prisma + SQLite）</h1>

    <form class="form" @submit.prevent="add">
      <input v-model="title" placeholder="標題" />
      <input v-model="content" placeholder="內容" />
      <button type="submit">新增</button>
    </form>

    <p v-if="!posts?.length" class="empty">還沒有文章，新增一篇吧。</p>

    <article v-for="p in posts" :key="p.id" class="card">
      <div>
        <strong>{{ p.title }}</strong>
        <p>{{ p.content }}</p>
        <small>{{ new Date(p.createdAt).toLocaleString() }}</small>
      </div>
      <button class="del" @click="remove(p.id)">刪除</button>
    </article>
  </main>
</template>

<style>
body { margin: 0; font-family: -apple-system, "Segoe UI", sans-serif; background: #f3f4f6; }
.wrap { max-width: 640px; margin: 0 auto; padding: 24px; }
.form { display: flex; gap: 8px; margin-bottom: 16px; }
.form input { flex: 1; padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 8px; }
.form button { padding: 8px 16px; border: none; border-radius: 8px; background: #00dc82; color: #062; font-weight: 600; cursor: pointer; }
.empty { color: #9ca3af; }
.card { display: flex; justify-content: space-between; align-items: flex-start; background: #fff; border: 1px solid #eee; border-radius: 12px; padding: 12px 16px; margin-bottom: 10px; }
.card p { margin: 4px 0; color: #6b7280; }
.card small { color: #9ca3af; }
.del { border: none; background: #fee2e2; color: #b91c1c; border-radius: 8px; padding: 6px 12px; cursor: pointer; }
</style>
```

跑起來後：

- 新增文章 → 寫進 SQLite，`refresh` 後出現在列表。
- **重啟 `npm run dev`，資料還在**（這就是真資料庫的差別）。
- 刪除 → 樂觀更新，畫面立即消失。
- `npx prisma studio` 打開能看到剛剛新增的資料列。

---

## 本章結語

你有一個能持久化的全端 CRUD 了，但仍然「人人可寫」。下一章補上最後一塊：**認證與授權**——用 cookie/session 做登入，把第 9 章的守衛換成真的身分驗證，讓只有登入者能新增/刪除文章，並在**伺服器端**再驗一次，杜絕繞過前端。
