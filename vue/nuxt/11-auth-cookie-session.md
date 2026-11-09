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
    throw createError({ status: 400, message: 'email 與密碼必填' })
  }

  const exists = await prisma.user.findUnique({ where: { email } })
  if (exists) {
    throw createError({ status: 409, message: 'email 已被註冊' })
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
    throw createError({ status: 401, message: '帳號或密碼錯誤' })
  }

  await setUserSession(event, {
    user: { id: user.id, name: user.name, email: user.email },
  })
  return { ok: true }
})
```

### 登出：不用自己寫 API

`nuxt-auth-utils` 內建了一支 `DELETE /api/_auth/session`，裡面呼叫的就是伺服器端的 `clearUserSession(event)`。前端呼叫 `useUserSession()` 的 `clear()`（下一節）就會打這支端點，把 session cookie 清掉。只有「在伺服器端順便登出」的情境（例如刪除帳號的 API 裡）才需要自己呼叫 `clearUserSession(event)`。

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
  await clear()          // 打內建的 DELETE /api/_auth/session 清掉 cookie，並清空前端狀態
  await navigateTo('/login')
}
</script>

<template>
  <div v-if="loggedIn">哈囉 {{ user.name }} <button @click="logout">登出</button></div>
  <NuxtLink v-else to="/login">登入</NuxtLink>
</template>
```

`useUserSession()` 回傳：`loggedIn`、`user`、`session`、`ready`、`fetch()`（重抓）、`clear()`（登出：清掉伺服器端的 session cookie，也清空前端狀態）。

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
  if (!body?.title) throw createError({ status: 400, message: '標題必填' })

  return await prisma.post.create({
    data: {
      title: body.title,
      content: body.content ?? '',
      published: body.published === true, // 沒勾「立即發佈」就存成草稿
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
  if (!Number.isInteger(id)) throw createError({ status: 404, message: '找不到文章' })

  const post = await prisma.post.findUnique({ where: { id } })
  if (!post) throw createError({ status: 404, message: '找不到文章' })

  // 授權檢查：不是作者就擋
  if (post.authorId !== user.id) {
    throw createError({ status: 403, message: '只能刪除自己的文章' })
  }

  await prisma.post.delete({ where: { id } })
  return { ok: true }
})
```

### 授權：只有作者能改

第 10 章的 `[id].put.js` 只處理了「找不到」與欄位白名單，沒有任何登入／權限檢查，任何人都能改任何文章，要換成這一版：先登入、再確認是作者，最後才用欄位白名單更新（`authorId`、`id`、`createdAt` 一律不讓請求決定）：

```js
// server/api/posts/[id].put.js
export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ status: 404, message: '找不到文章' })

  const post = await prisma.post.findUnique({ where: { id } })
  if (!post) throw createError({ status: 404, message: '找不到文章' })
  if (post.authorId !== user.id) {
    throw createError({ status: 403, message: '只能修改自己的文章' })
  }

  // 欄位白名單：只更新允許改的欄位
  const body = await readBody(event)
  const data = {}
  if (typeof body?.title === 'string') data.title = body.title
  if (typeof body?.content === 'string') data.content = body.content
  if (typeof body?.published === 'boolean') data.published = body.published
  if (data.title === '') throw createError({ status: 400, message: '標題必填' })

  return await prisma.post.update({ where: { id }, data })
})
```

### 授權：草稿只有作者看得到

第 10 章留下的兩個讀取端點也要補上：已發佈的文章大家都能看，**草稿只回給作者本人**。列表與單篇都要擋，只擋一支等於沒擋。這兩支是公開端點，沒登入也要能用，所以用 `getUserSession`（沒登入不會丟錯，只是拿不到 `user`），而不是 `requireUserSession`：

```js
// server/api/posts.get.js
export default defineEventHandler(async (event) => {
  const { user } = await getUserSession(event)
  return await prisma.post.findMany({
    // 已發佈 + （有登入時）自己的草稿
    where: user ? { OR: [{ published: true }, { authorId: user.id }] } : { published: true },
    orderBy: { createdAt: 'desc' },
    include: { author: { select: { name: true, id: true } } },
  })
})
```

```js
// server/api/posts/[id].get.js
export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ status: 404, message: '找不到文章' })

  const post = await prisma.post.findUnique({ where: { id } })
  if (!post) throw createError({ status: 404, message: '找不到文章' })

  // 草稿：不是作者一律當作不存在（回 404 而非 403，不洩漏草稿存在）
  if (!post.published) {
    const { user } = await getUserSession(event)
    if (!user || post.authorId !== user.id) {
      throw createError({ status: 404, message: '找不到文章' })
    }
  }
  return post
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
  sameSite: 'lax',            // 跨站的 POST／fetch 不會帶這個 cookie
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
  // ⚠️ 順序很重要：先 trim/toLowerCase「正規化」，最後才驗 email 格式
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8, '密碼至少 8 碼'),
  name: z.string().min(1).optional(),
})

export default defineEventHandler(async (event) => {
  // 驗證失敗會自動丟 400，不用自己組錯誤
  const { email, password, name } = await readValidatedBody(event, schema.parse)

  const exists = await prisma.user.findUnique({ where: { email } })
  if (exists) throw createError({ status: 409, message: 'email 已被註冊' })

  const hashed = await hashPassword(password)
  const user = await prisma.user.create({
    data: { email, name: name || email, password: hashed },
  })
  await setUserSession(event, { user: { id: user.id, name: user.name, email: user.email } })
  return { ok: true }
})
```

**鏈式順序是會咬人的細節**：zod 的驗證與轉換是**照你寫的順序跑**的。若寫成 `z.string().email().trim().toLowerCase()`，`.email()` 會先拿到**還沒 trim 的原字串**去驗——使用者複製貼上多帶了一個空白（`"  foo@x.com  "`），就會直接被判定成「Email 格式錯誤」，而你以為自己有處理空白。實測：

```js
z.string().email().trim().toLowerCase().safeParse('  Foo@X.com  ')
// → 失敗：Invalid email address     ← trim 根本沒機會執行

z.string().trim().toLowerCase().email().safeParse('  Foo@X.com  ')
// → 成功：'foo@x.com'
```

記法：**正規化（trim / toLowerCase）在前，驗證（email / min）在後。**

> 版本註記：zod 4 起建議改用頂層的 `z.email()`（`z.string().email()` 已標記為 deprecated，但仍可用）。要注意 **`z.email().trim().toLowerCase()` 同樣會踩到順序問題**——它語法上合法、不會報錯，但 `z.email()` 的驗證一樣排在 `trim` 前面，padded 輸入照樣被判定格式錯誤。用 `z.email()` 時把正規化放前面、再 `pipe`：
>
> ```js
> z.string().trim().toLowerCase().pipe(z.email())   // ✅
> z.string().trim().toLowerCase().email()           // ✅ 舊寫法，也對
> z.email().trim().toLowerCase()                    // ❌ 順序不對，padded 輸入會被擋
> ```

（登入 API 同理，也要把 email 正規化為小寫再查，否則使用者用不同大小寫登入會查不到帳號。）

**CSRF 一句話**：`nuxt-auth-utils` 的 session cookie 預設是 `SameSite=Lax`，這就是**主要的 CSRF 緩解**——別的網站送來的 POST／PUT／DELETE（包括跨站表單送出）與 `fetch` 都不會帶上你的 session cookie，惡意網站因此無法「借用你的登入狀態」偷打會改資料的 API。它擋不住的有三種情況：

- **跨站的頂層 GET 導覽**（點連結、`<form method="get">`）仍會帶 cookie，所以**不要用 GET 做會改資料的事**。
- **同一個網域底下的其他子網域**（例如 `evil.example.com` 對 `blog.example.com`）算「同站」，SameSite 不會擋。
- **你自己的第三方前端**（不同網域的 SPA 要帶登入狀態來打 API）得改成 `SameSite=None; Secure`，這時就要另外加 CSRF token 並設好 CORS。

一般同源部落格（本課情境）用預設即可。

---

## 10. 本章小練習

1. 安裝 `nuxt-auth-utils`、設 `NUXT_SESSION_PASSWORD`、加 `User` 模型並 migrate。
2. 做註冊、登入兩支 API 與登出鈕（`clear()`），用 DevTools 觀察 cookie（會看到一個 `httpOnly` 的 session cookie，且 JS 讀不到）。
3. 前端做登入表單與頁首的登入狀態顯示。
4. 用 `auth` 中介層保護 `/admin`，並用 `requireUserSession` 保護新增／修改／刪除 API。
5. 用兩個帳號測試「只能改、刪自己的文章，也看不到別人的草稿」，被擋時分別看到 403 與 404。

---

## 最後範例：登入後才能發文、只能刪自己的

> 整合第 10 章 CRUD 與本章認證。先完成第 2、3 節（裝模組、加 User 模型、migrate），再建立以下檔案即可跑。

### `server/api/auth/register.post.js`、`login.post.js`

（同第 4 節，原樣建立兩支檔案。登出直接用前端的 `clear()`，不用另寫 API。）

### `server/api/posts.get.js`、`server/api/posts/[id].get.js`（已發佈公開、草稿只給作者）

（同第 7 節，原樣建立，取代第 10 章的版本。）

### `server/api/posts.post.js`（要登入）

```js
export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const body = await readBody(event)
  if (!body?.title) throw createError({ status: 400, message: '標題必填' })
  setResponseStatus(event, 201)
  return await prisma.post.create({
    data: {
      title: body.title,
      content: body.content ?? '',
      published: body.published === true,
      authorId: user.id,
    },
  })
})
```

### `server/api/posts/[id].put.js`（要登入 + 只能改自己的）

（同第 7 節，原樣建立，取代第 10 章第 5 節的版本；沒做過那支就直接新增。）

### `server/api/posts/[id].delete.js`（要登入 + 只能刪自己的）

```js
export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ status: 404, message: '找不到文章' })
  const post = await prisma.post.findUnique({ where: { id } })
  if (!post) throw createError({ status: 404, message: '找不到文章' })
  if (post.authorId !== user.id) throw createError({ status: 403, message: '只能刪自己的文章' })
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
    err.value = e.data?.message || '失敗'
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
const published = ref(true)

async function add() {
  if (!title.value) return
  await $fetch('/api/posts', {
    method: 'POST',
    body: { title: title.value, content: content.value, published: published.value },
  })
  title.value = ''; content.value = ''; published.value = true
  await refresh()
}
async function remove(id) {
  try {
    await $fetch(`/api/posts/${id}`, { method: 'DELETE' })
    await refresh()
  } catch (e) {
    alert(e.data?.message || '刪除失敗')
  }
}
async function logout() {
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
      <label class="pub"><input v-model="published" type="checkbox" /> 立即發佈</label>
      <button type="submit">發表</button>
    </form>

    <article v-for="p in posts" :key="p.id" class="card">
      <div>
        <strong>{{ p.title }}</strong>
        <small v-if="!p.published" class="draft">草稿</small>
        <p>{{ p.content }}</p>
        <small>作者：{{ p.author?.name || '未知' }}</small>
      </div>
      <!-- 用 user?.id：登出時 clear() 先把 user 清成 null，頁面在導走前還會重繪一次 -->
      <button v-if="p.authorId === user?.id" class="del" @click="remove(p.id)">刪除</button>
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
.pub { display: flex; align-items: center; gap: 4px; white-space: nowrap; font-size: 14px; }
.form .pub input { flex: none; padding: 0; }
.card { display: flex; justify-content: space-between; align-items: flex-start; background: #fff; border: 1px solid #eee; border-radius: 12px; padding: 12px 16px; margin-bottom: 10px; }
.card p { margin: 4px 0; color: #6b7280; }
.card small { color: #9ca3af; }
.card .draft { margin-left: 6px; color: #b45309; }
.del { border: none; background: #fee2e2; color: #b91c1c; border-radius: 8px; padding: 6px 12px; cursor: pointer; }
</style>
```

跑起來後：

- 沒登入開任何頁 → 被 `auth` 踢到 `/login`。
- 註冊/登入後 → 進管理頁，DevTools 的 Application → Cookies 看到 `httpOnly` 的 session cookie（`document.cookie` 讀不到）。
- 發文成功、列表顯示作者名；**只有自己的文章才出現「刪除」鈕**。
- 不勾「立即發佈」→ 存成草稿，只有你自己的列表看得到。
- 用第二個帳號登入：看不到第一個帳號的草稿（直接打 `/api/posts/<草稿 id>` 也是 **404**）；試著用 DevTools 直接 `$fetch` 刪別人的文章 → 伺服器回 **403**（前端藏了鈕，後端也擋住）。

---

## 本章結語

到這裡，你的全端能力已經完整：路由、資料抓取、狀態、API、資料庫、認證與授權。接下來三章把產品「打磨到可上線」——先從**能被 Google 與社群看見**開始。下一章講 **SEO 與 Meta**：`useSeoMeta`、`useHead`、Open Graph 與 sitemap。
