# 第 11 章：認證與授權（Cookie / Session）

## 本章目標

完成這一章後，你應該可以：

1. 說清楚 cookie、`httpOnly`、session 與「密碼雜湊」在登入流程裡的角色。
2. 用 `nuxt-auth-utils` 建立以加密 cookie 為基礎的 session。
3. 實作註冊、登入、登出，並用 `hashPassword` / `verifyPassword` 安全存密碼。
4. 用路由中介層守衛頁面、用 `requireUserSession` **在伺服器端**守衛 API。
5. 做「只有作者能刪自己的文章」這種授權（authorization）判斷。

---

## 1. 幾個一定要懂的觀念

**驗證（Authentication）**：你是誰（登入）。**授權（Authorization）**：你能做什麼（權限）。兩件事，本章都會碰。

登入狀態存哪？

| 存法 | 問題 |
|---|---|
| `localStorage` 存 token | JS 讀得到 → 容易被 XSS 偷；SSR 也讀不到 |
| 一般 cookie | JS 讀得到，一樣有 XSS 風險 |
| **`httpOnly` cookie**（本章） | **JS 讀不到**、瀏覽器自動附帶、SSR 也拿得到 ✅ |

**密碼絕對不能明文存**。要用**雜湊（hash）**：存的是不可逆的雜湊值，登入時把使用者輸入的密碼再雜湊一次比對。本章用 `nuxt-auth-utils` 內建的 `hashPassword`（底層是 scrypt）。

**session 放哪？** 本章用「**加密後塞進 cookie**」的做法（`nuxt-auth-utils` 幫你把 session 內容用 `NUXT_SESSION_PASSWORD` 加密封裝進 `httpOnly` cookie）。好處是不用額外的 session 資料庫；壞處是不能主動讓單一 session 失效（適合中小專案）。

---

## 2. 安裝 nuxt-auth-utils

手刻 cookie/session 很容易出安全漏洞。本課用官方社群模組 `nuxt-auth-utils`，它把「加密 cookie session + 密碼雜湊」都包好了：

```bash
npx nuxi module add auth-utils
```

它會裝好模組並加進 `nuxt.config.ts`。session 加密需要一把金鑰，放在 `.env`（至少 32 字元）：

```bash
# .env（開發時若沒設，模組會自動幫你產一把）
NUXT_SESSION_PASSWORD=please-change-this-to-a-32+-char-secret
```

> ⚠️ 正式環境一定要自己設一把夠長的隨機字串，且別進版控。

---

## 3. 加上 User 模型

沿用第 10 章的 Prisma。在 `prisma/schema.prisma` 加 `User`，並讓 `Post` 關聯到作者：

```prisma
model User {
  id       Int    @id @default(autoincrement())
  email    String @unique
  password String          // 存的是雜湊，不是明文
  name     String
  posts    Post[]
}

model Post {
  id        Int      @id @default(autoincrement())
  title     String
  content   String
  published Boolean  @default(false)
  createdAt DateTime @default(now())
  author    User?    @relation(fields: [authorId], references: [id])
  authorId  Int?
}
```

跑 migration：

```bash
npx prisma migrate dev --name add-user
```

---

## 4. 註冊與登入 API

### 註冊：`server/api/auth/register.post.js`

```js
export default defineEventHandler(async (event) => {
  const { email, password, name } = await readBody(event)
  if (!email || !password) {
    throw createError({ statusCode: 400, statusMessage: 'email 與密碼必填' })
  }

  const exists = await prisma.user.findUnique({ where: { email } })
  if (exists) {
    throw createError({ statusCode: 409, statusMessage: 'email 已被註冊' })
  }

  // 密碼雜湊後才存
  const hashed = await hashPassword(password)
  const user = await prisma.user.create({
    data: { email, name: name || email, password: hashed },
  })

  // 註冊完直接登入：把使用者放進加密 session cookie
  await setUserSession(event, {
    user: { id: user.id, name: user.name, email: user.email },
  })
  return { ok: true }
})
```

### 登入：`server/api/auth/login.post.js`

```js
export default defineEventHandler(async (event) => {
  const { email, password } = await readBody(event)

  const user = await prisma.user.findUnique({ where: { email } })
  // 帳號不存在或密碼錯，都回一樣的訊息（不要洩漏是哪個錯）
  if (!user || !(await verifyPassword(user.password, password))) {
    throw createError({ statusCode: 401, statusMessage: '帳號或密碼錯誤' })
  }

  await setUserSession(event, {
    user: { id: user.id, name: user.name, email: user.email },
  })
  return { ok: true }
})
```

### 登出：`server/api/auth/logout.post.js`

```js
export default defineEventHandler(async (event) => {
  await clearUserSession(event)
  return { ok: true }
})
```

> 重點：session 裡**只放非機密、必要的欄位**（id、名稱、email），**絕不放密碼雜湊**。cookie 會來回傳輸，放越少越好。

---

## 5. 前端：`useUserSession`

`nuxt-auth-utils` 提供自動匯入的 `useUserSession()`，前端拿登入狀態就靠它：

```vue
<script setup>
const { loggedIn, user, clear, fetch: refreshSession } = useUserSession()

async function login(email, password) {
  await $fetch('/api/auth/login', { method: 'POST', body: { email, password } })
  await refreshSession() // 重抓 session，讓 loggedIn/user 更新
  await navigateTo('/')
}

async function logout() {
  await $fetch('/api/auth/logout', { method: 'POST' })
  await clear()          // 清前端 session 狀態
  await navigateTo('/login')
}
</script>

<template>
  <div v-if="loggedIn">哈囉 {{ user.name }} <button @click="logout">登出</button></div>
  <NuxtLink v-else to="/login">登入</NuxtLink>
</template>
```

`useUserSession()` 回傳：`loggedIn`、`user`、`session`、`ready`、`fetch()`（重抓）、`clear()`（前端登出）。

---

## 6. 守衛頁面：路由中介層

把第 9 章的 `auth.js` 換成用真 session 判斷：

```js
// app/middleware/auth.js
export default defineNuxtRouteMiddleware((to) => {
  const { loggedIn } = useUserSession()
  if (!loggedIn.value) {
    return navigateTo({ path: '/login', query: { redirect: to.fullPath } })
  }
})
```

需要登入的頁面掛上它：

```vue
<script setup>
definePageMeta({ middleware: ['auth'] })
</script>
```

---

## 7. ⚠️ 最重要：伺服器端也要守

**前端中介層擋不住惡意使用者**——別人可以繞過瀏覽器直接打你的 API。所以**每一支會改資料的 API，都要在伺服器端再驗一次**。用 `requireUserSession`（沒登入自動丟 401）：

```js
// server/api/posts.post.js（受保護版）
export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event) // 沒登入 → 直接 401

  const body = await readBody(event)
  if (!body?.title) throw createError({ statusCode: 400, statusMessage: '標題必填' })

  return await prisma.post.create({
    data: {
      title: body.title,
      content: body.content ?? '',
      authorId: user.id, // 記錄作者
    },
  })
})
```

### 授權：只有作者能刪

登入還不夠，還要判斷「這篇是不是你的」：

```js
// server/api/posts/[id].delete.js
export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const id = Number(getRouterParam(event, 'id'))

  const post = await prisma.post.findUnique({ where: { id } })
  if (!post) throw createError({ statusCode: 404, statusMessage: '找不到文章' })

  // 授權檢查：不是作者就擋
  if (post.authorId !== user.id) {
    throw createError({ statusCode: 403, statusMessage: '只能刪除自己的文章' })
  }

  await prisma.post.delete({ where: { id } })
  return { ok: true }
})
```

> 心法：**前端守衛是「體驗」（不讓使用者看到不該看的），伺服器守衛才是「安全」（真正擋住操作）。兩個都要，缺一不可。**

---

## 8. `useCookie`：SSR-safe 的偏好型 cookie

前面的 session 是 `httpOnly` cookie——**JS 讀不到**、由 `nuxt-auth-utils` 在伺服器端管理，這是安全需求。但有些 cookie 你**希望前端也讀得到、也想直接寫**：主題（深/淺色）、語系、「不再顯示公告」這類**非機密偏好**。這時用 Nuxt 內建的 `useCookie`：

```vue
<script setup>
// 一個「像 ref 的 cookie」，對應瀏覽器的 theme cookie
const theme = useCookie('theme', {
  sameSite: 'lax',            // CSRF 緩解：跨站請求不會自動帶這個 cookie
  maxAge: 60 * 60 * 24 * 365, // 存一年（單位：秒）
  default: () => 'light',
})

function toggle() {
  // 直接改 .value 就會寫回 cookie，下次請求（含 SSR）都讀得到
  theme.value = theme.value === 'light' ? 'dark' : 'light'
}
</script>

<template>
  <button @click="toggle">目前主題：{{ theme }}</button>
</template>
```

`useCookie` 的特點：

- **SSR-safe、兩端可讀寫**：伺服器渲染時就讀得到 cookie 值（首屏主題不閃、不跳動），瀏覽器端改 `.value` 會自動同步回 cookie。
- 適合放**非 `httpOnly` 的偏好**（主題、語系、UI 記憶）；**機密（登入憑證）絕不要用它**——那要走前面的 `httpOnly` session。
- 值會自動 JSON 序列化/反序列化，可直接存物件。

和「伺服器端」的 cookie 函式分工：

| 用途 | 工具 | 在哪用 |
|---|---|---|
| 元件/頁面裡讀寫偏好 cookie | `useCookie('name', options)` | 前端 + SSR（`app/` 端） |
| 在 API handler 裡讀 cookie | `getCookie(event, 'name')` | `server/`（第 8 章） |
| 在 API handler 裡寫 cookie | `setCookie(event, 'name', value, options)` | `server/` |

> 一句話：**`app/` 端要一個「像 ref 的 cookie」用 `useCookie`；`server/` 的 API handler 裡要讀寫 cookie 用 `getCookie` / `setCookie`。** 登入 session 這種機密，交給 `nuxt-auth-utils`（它底層就是用 `httpOnly` 的 `setCookie` 幫你封裝），別自己用 `useCookie` 存。

---

## 9. 別忘了輸入驗證與 CSRF

認證安全不只「密碼有沒有雜湊」，**輸入驗證**也是 API 安全的一環。第 4 節的註冊 API 只擋了「email/密碼必填」，實務上還要：

- **驗 email 格式**：長得不像 email 的就擋掉。
- **密碼最小長度**（例如 ≥ 8）：太短的弱密碼直接回錯。
- **email 正規化為小寫**：否則 `Foo@x.com` 與 `foo@x.com` 會變成兩個不同帳號（連 `@unique` 都擋不住，因為字串本身不一樣）。

手動一條條 `if` 檢查容易漏。h3（Nitro 底層）內建 **`readValidatedBody(event, validate)`**，可搭配 [zod](https://zod.dev)（先 `npm install zod`）這類 schema 驗證庫，比手寫 `readBody` + 一堆 `if` 更穩、錯誤訊息也更一致：

```js
// server/api/auth/register.post.js（加上驗證的版本）
import { z } from 'zod'

const schema = z.object({
  // email 正規化為小寫 + 去頭尾空白，避免大小寫造成重複帳號
  email: z.string().email().trim().toLowerCase(),
  password: z.string().min(8, '密碼至少 8 碼'),
  name: z.string().min(1).optional(),
})

export default defineEventHandler(async (event) => {
  // 驗證失敗會自動丟 400，不用自己組錯誤
  const { email, password, name } = await readValidatedBody(event, schema.parse)

  const exists = await prisma.user.findUnique({ where: { email } })
  if (exists) throw createError({ statusCode: 409, statusMessage: 'email 已被註冊' })

  const hashed = await hashPassword(password)
  const user = await prisma.user.create({
    data: { email, name: name || email, password: hashed },
  })
  await setUserSession(event, { user: { id: user.id, name: user.name, email: user.email } })
  return { ok: true }
})
```

（登入 API 同理，也要把 email 正規化為小寫再查，否則使用者用不同大小寫登入會查不到帳號。）

**CSRF 一句話**：`nuxt-auth-utils` 的 session cookie 預設是 `SameSite=Lax`，這就是**主要的 CSRF 緩解**——跨站送過來的請求不會自動帶上你的 session cookie，惡意網站因此無法「借用你的登入狀態」偷打你的 API。但若情境是**跨站表單提交**或**第三方前端**（不同網域的 SPA 來打你的 API），`SameSite=Lax` 就不夠，要另外加 CSRF token 或搭配適當的 CORS 設定。一般同源部落格（本課情境）用預設即可。

---

## 10. 本章小練習

1. 安裝 `nuxt-auth-utils`、設 `NUXT_SESSION_PASSWORD`、加 `User` 模型並 migrate。
2. 做註冊/登入/登出三支 API，用 DevTools 觀察 cookie（會看到一個 `httpOnly` 的 session cookie，且 JS 讀不到）。
3. 前端做登入表單與頁首的登入狀態顯示。
4. 用 `auth` 中介層保護 `/admin`，並用 `requireUserSession` 保護新增/刪除 API。
5. 用兩個帳號測試「只能刪自己文章」，被擋時看到 403。

---

## 最後範例：登入後才能發文、只能刪自己的

> 整合第 10 章 CRUD 與本章認證。先完成第 2、3 節（裝模組、加 User 模型、migrate），再建立以下檔案即可跑。

### `server/api/auth/register.post.js`、`login.post.js`、`logout.post.js`

（同第 4 節，原樣建立三支檔案。）

### `server/api/posts.get.js`（公開讀取，附作者名）

```js
export default defineEventHandler(async () => {
  return await prisma.post.findMany({
    orderBy: { createdAt: 'desc' },
    include: { author: { select: { name: true, id: true } } },
  })
})
```

### `server/api/posts.post.js`（要登入）

```js
export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const body = await readBody(event)
  if (!body?.title) throw createError({ statusCode: 400, statusMessage: '標題必填' })
  setResponseStatus(event, 201)
  return await prisma.post.create({
    data: { title: body.title, content: body.content ?? '', authorId: user.id },
  })
})
```

### `server/api/posts/[id].delete.js`（要登入 + 只能刪自己的）

```js
export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const id = Number(getRouterParam(event, 'id'))
  const post = await prisma.post.findUnique({ where: { id } })
  if (!post) throw createError({ statusCode: 404, statusMessage: '找不到文章' })
  if (post.authorId !== user.id) throw createError({ statusCode: 403, statusMessage: '只能刪自己的文章' })
  await prisma.post.delete({ where: { id } })
  return { ok: true }
})
```

### `app/middleware/auth.js`

```js
export default defineNuxtRouteMiddleware((to) => {
  const { loggedIn } = useUserSession()
  if (!loggedIn.value) {
    return navigateTo({ path: '/login', query: { redirect: to.fullPath } })
  }
})
```

### `app/pages/login.vue`

```vue
<script setup>
const { fetch: refreshSession } = useUserSession()
const route = useRoute()

const mode = ref('login') // 'login' | 'register'
const email = ref('')
const password = ref('')
const name = ref('')
const err = ref('')

async function submit() {
  err.value = ''
  try {
    const url = mode.value === 'login' ? '/api/auth/login' : '/api/auth/register'
    await $fetch(url, { method: 'POST', body: { email: email.value, password: password.value, name: name.value } })
    await refreshSession()
    await navigateTo(route.query.redirect || '/')
  } catch (e) {
    err.value = e.data?.statusMessage || '失敗'
  }
}
</script>

<template>
  <main class="wrap">
    <h1>{{ mode === 'login' ? '登入' : '註冊' }}</h1>
    <form class="form" @submit.prevent="submit">
      <input v-if="mode === 'register'" v-model="name" placeholder="名稱" />
      <input v-model="email" type="email" placeholder="email" />
      <input v-model="password" type="password" placeholder="密碼" />
      <button type="submit">{{ mode === 'login' ? '登入' : '註冊' }}</button>
    </form>
    <p v-if="err" class="err">{{ err }}</p>
    <p class="switch" @click="mode = mode === 'login' ? 'register' : 'login'">
      {{ mode === 'login' ? '沒有帳號？去註冊' : '已有帳號？去登入' }}
    </p>
  </main>
</template>

<style>
body { margin: 0; font-family: -apple-system, "Segoe UI", sans-serif; background: #f3f4f6; }
.wrap { max-width: 420px; margin: 0 auto; padding: 32px 24px; }
.form { display: flex; flex-direction: column; gap: 10px; }
.form input { padding: 10px; border: 1px solid #d1d5db; border-radius: 8px; }
.form button { padding: 10px; border: none; border-radius: 8px; background: #00dc82; color: #062; font-weight: 600; cursor: pointer; }
.err { color: #b91c1c; }
.switch { color: #2563eb; cursor: pointer; }
</style>
```

### `app/pages/index.vue`

```vue
<script setup>
definePageMeta({ middleware: ['auth'] }) // 要登入才能進管理頁

const { user, clear } = useUserSession()
const { data: posts, refresh } = await useFetch('/api/posts')

const title = ref('')
const content = ref('')

async function add() {
  if (!title.value) return
  await $fetch('/api/posts', { method: 'POST', body: { title: title.value, content: content.value } })
  title.value = ''; content.value = ''
  await refresh()
}
async function remove(id) {
  try {
    await $fetch(`/api/posts/${id}`, { method: 'DELETE' })
    await refresh()
  } catch (e) {
    alert(e.data?.statusMessage || '刪除失敗')
  }
}
async function logout() {
  await $fetch('/api/auth/logout', { method: 'POST' })
  await clear()
  await navigateTo('/login')
}
</script>

<template>
  <main class="wrap">
    <header class="top">
      <h1>文章管理</h1>
      <span>{{ user?.name }} <button class="link" @click="logout">登出</button></span>
    </header>

    <form class="form" @submit.prevent="add">
      <input v-model="title" placeholder="標題" />
      <input v-model="content" placeholder="內容" />
      <button type="submit">發表</button>
    </form>

    <article v-for="p in posts" :key="p.id" class="card">
      <div>
        <strong>{{ p.title }}</strong>
        <p>{{ p.content }}</p>
        <small>作者：{{ p.author?.name || '未知' }}</small>
      </div>
      <button v-if="p.authorId === user.id" class="del" @click="remove(p.id)">刪除</button>
    </article>
  </main>
</template>

<style>
.wrap { max-width: 640px; margin: 0 auto; padding: 24px; }
.top { display: flex; justify-content: space-between; align-items: center; }
.link { background: none; border: none; color: #2563eb; cursor: pointer; }
.form { display: flex; gap: 8px; margin: 16px 0; }
.form input { flex: 1; padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 8px; }
.form button { padding: 8px 16px; border: none; border-radius: 8px; background: #00dc82; color: #062; font-weight: 600; cursor: pointer; }
.card { display: flex; justify-content: space-between; align-items: flex-start; background: #fff; border: 1px solid #eee; border-radius: 12px; padding: 12px 16px; margin-bottom: 10px; }
.card p { margin: 4px 0; color: #6b7280; }
.card small { color: #9ca3af; }
.del { border: none; background: #fee2e2; color: #b91c1c; border-radius: 8px; padding: 6px 12px; cursor: pointer; }
</style>
```

跑起來後：

- 沒登入開任何頁 → 被 `auth` 踢到 `/login`。
- 註冊/登入後 → 進管理頁，DevTools 的 Application → Cookies 看到 `httpOnly` 的 session cookie（`document.cookie` 讀不到）。
- 發文成功、列表顯示作者名；**只有自己的文章才出現「刪除」鈕**。
- 用第二個帳號登入，試著用 DevTools 直接 `$fetch` 刪別人的文章 → 伺服器回 **403**（前端藏了鈕，後端也擋住）。

---

## 本章結語

到這裡，你的全端能力已經完整：路由、資料抓取、狀態、API、資料庫、認證與授權。接下來三章把產品「打磨到可上線」——先從**能被 Google 與社群看見**開始。下一章講 **SEO 與 Meta**：`useSeoMeta`、`useHead`、Open Graph 與 sitemap。
