# 第 9 章：路由中介層與導航守衛

## 本章目標

完成這一章後，你應該可以：

1. 分清「路由中介層（route middleware）」與第 8 章的「伺服器中介層（server middleware）」。
2. 用 `defineNuxtRouteMiddleware` 寫具名、全域、行內三種中介層。
3. 用 `navigateTo` 導向、用 `abortNavigation` 取消導覽。
4. 理解中介層在 SSR 首次載入與 client 端切頁時各跑一次，並正確處理。
5. 做出一個「未登入就踢到登入頁」的路由守衛雛形。

---

## 1. 兩種 middleware，別搞混

Nuxt 有兩個「中介層」，名字像但完全不同：

| | 伺服器中介層（第 8 章） | **路由中介層（本章）** |
|---|---|---|
| 位置 | `server/middleware/` | `app/middleware/` |
| 何時跑 | 每個 **HTTP 請求**進伺服器時 | 每次**頁面導覽**（換路由）時 |
| 在哪跑 | 只在伺服器 | 伺服器（首次載入）+ 瀏覽器（之後切頁） |
| 典型用途 | 記錄請求、解析 token 掛到 `event.context` | 擋頁面、依權限導向、確認資料 |
| 拿到什麼 | `event`（請求物件） | `to` / `from`（路由物件） |

> 一句話：**server middleware 守「請求」，route middleware 守「頁面導覽」。** 本章講後者——它就是 Vue Router 導航守衛的 Nuxt 版。

---

## 2. 路由中介層長什麼樣

放在 `app/middleware/`，用 `defineNuxtRouteMiddleware` 定義。它拿到 `to`（要去的路由）與 `from`（從哪來）：

```js
// app/middleware/log.js
export default defineNuxtRouteMiddleware((to, from) => {
  console.log(`要從 ${from.path} 去 ${to.path}`)
  // 什麼都不 return → 放行
})
```

中介層可以有三種回傳：

| 回傳 | 效果 |
|---|---|
| 不 return（或 `return`） | 放行，繼續導覽 |
| `return navigateTo('/login')` | 改導到別的路由 |
| `return abortNavigation()` | 取消這次導覽（留在原地） |
| `return abortNavigation(createError({...}))` | 取消並顯示錯誤頁 |

---

## 3. 三種掛法

### 3.1 具名中介層（named）

檔名就是名字。`app/middleware/auth.js` → 名字叫 `auth`。用 `definePageMeta` 掛在需要的頁：

```js
// app/middleware/auth.js
export default defineNuxtRouteMiddleware((to) => {
  const loggedIn = useState('loggedIn', () => false)
  if (!loggedIn.value) {
    return navigateTo('/login') // 沒登入 → 踢到登入頁
  }
})
```

```vue
<!-- app/pages/admin.vue -->
<script setup>
definePageMeta({
  middleware: ['auth'], // 進這頁前先跑 auth
})
</script>
```

一頁可掛多個：`middleware: ['auth', 'load-profile']`，依陣列順序執行。

### 3.2 全域中介層（global）

檔名加 `.global` → **每次**導覽都跑，不用在頁面掛：

```js
// app/middleware/analytics.global.js
export default defineNuxtRouteMiddleware((to) => {
  // 每次換頁都會進來，適合記錄、全站性檢查
  console.log('進入', to.path)
})
```

執行順序：**所有 global（依檔名字母序）→ 頁面上指定的具名/行內**。

### 3.3 行內中介層（inline）

只給某一頁用、不想開檔案時，直接寫在 `definePageMeta`：

```vue
<script setup>
definePageMeta({
  middleware: (to, from) => {
    if (to.query.preview !== 'true') {
      return navigateTo('/')
    }
  },
})
</script>
```

> 選擇：**多頁共用** → 具名；**全站都要** → global；**只有這頁、簡單邏輯** → inline。

---

## 4. `navigateTo` 與 `abortNavigation`

**`navigateTo`** 是 Nuxt 導覽的正解，在中介層裡一定要 `return` 它：

```js
return navigateTo('/login')                       // 一般導向
return navigateTo('/login', { redirectCode: 301 })// 指定狀態碼
return navigateTo({ path: '/login', query: { from: to.path } }) // 帶查詢字串
return navigateTo('https://外部網站', { external: true })       // 外部連結要加 external
```

**`abortNavigation`** 取消導覽（使用者留在原本頁面）：

```js
export default defineNuxtRouteMiddleware((to) => {
  if (to.params.id === 'secret') {
    return abortNavigation(createError({ statusCode: 403, statusMessage: '禁止進入' }))
  }
})
```

> ⚠️ 一定要 `return`。寫 `navigateTo('/x')` 不 return，導覽不會被攔下來。

---

## 5. SSR 與 client：中介層會跑兩次的地方

路由中介層預設在**兩端都跑**：

- **首次載入**某網址（直接輸入網址、重整）→ 在**伺服器**跑一次。
- 之後在站內用 `<NuxtLink>` 切頁 → 在**瀏覽器**跑。

所以中介層裡不要直接用只有瀏覽器才有的東西（`localStorage`、`window`）。要嘛用 `useState`/`useCookie`（兩端都可讀，第 11 章），要嘛判斷環境：

```js
export default defineNuxtRouteMiddleware((to) => {
  if (import.meta.server) return       // 只想在 client 跑就先擋掉 server
  // 這裡以下只在瀏覽器執行
})
```

想讓某個中介層**只在 client 跑**，可在 `definePageMeta` 設定或用上面的環境判斷。多數守衛應該兩端都跑（否則 SSR 首屏會先閃出受保護內容再被踢走）。

> 為什麼要在 server 也擋？因為使用者可能**直接貼網址**進受保護頁。若只在 client 擋，伺服器會先把內容算出來送出去（內容外洩 + 畫面閃一下），才被前端踢走。**兩端都擋才安全。**

---

## 6. 本章小練習

1. 寫一個 `analytics.global.js` 印出每次導覽的 `to.path`，切幾頁看 console。
2. 寫 `auth.js`，用 `useState('loggedIn')` 判斷，沒登入就 `navigateTo('/login')`。
3. 做 `/admin`（掛 `auth`）與 `/login`（有一顆「登入」把 `loggedIn` 設 true）。未登入直接開 `/admin` 應被踢到 `/login`。
4. 登入後帶 `redirect` 查詢字串回原本要去的頁。
5. 寫一個 inline 中介層，只有網址帶 `?preview=true` 才放行。

---

## 最後範例：登入守衛雛形（useState 版）

> 用 `useState` 模擬登入狀態，做出「未登入踢到登入頁、登入後導回原頁」的完整流程。第 11 章會把它換成真正的 cookie/session 認證。原樣建立以下檔案即可跑。

### `app/middleware/auth.js`（具名守衛）

```js
export default defineNuxtRouteMiddleware((to) => {
  const loggedIn = useState('loggedIn', () => false)

  if (!loggedIn.value) {
    // 記住原本要去哪，登入後好導回
    return navigateTo({ path: '/login', query: { redirect: to.fullPath } })
  }
})
```

### `app/middleware/logger.global.js`（全域記錄）

```js
export default defineNuxtRouteMiddleware((to, from) => {
  if (import.meta.client) {
    console.log(`[導覽] ${from.path} → ${to.path}`)
  }
})
```

### `app/app.vue`

```vue
<script setup>
const loggedIn = useState('loggedIn', () => false)
</script>

<template>
  <div class="wrap">
    <nav class="nav">
      <NuxtLink to="/">首頁</NuxtLink>
      <NuxtLink to="/admin">後台</NuxtLink>
      <span class="status">{{ loggedIn ? '已登入' : '未登入' }}</span>
    </nav>
    <NuxtPage />
  </div>
</template>

<style>
body { margin: 0; font-family: -apple-system, "Segoe UI", sans-serif; background: #f3f4f6; }
.wrap { max-width: 560px; margin: 0 auto; padding: 24px; line-height: 1.7; }
.nav { display: flex; gap: 16px; align-items: center; padding-bottom: 12px; border-bottom: 1px solid #eee; margin-bottom: 16px; }
.nav a { color: #111827; text-decoration: none; }
.nav a.router-link-active { color: #00dc82; font-weight: 600; }
.status { margin-left: auto; font-size: 13px; color: #6b7280; }
.btn { padding: 8px 16px; border: none; border-radius: 10px; background: #00dc82; color: #062; font-weight: 600; cursor: pointer; }
.btn.gray { background: #374151; color: #fff; }
</style>
```

### `app/pages/index.vue`

```vue
<template>
  <section>
    <h1>首頁</h1>
    <p>任何人都能看。試著點「後台」——沒登入會被踢到登入頁。</p>
  </section>
</template>
```

### `app/pages/admin.vue`（受保護）

```vue
<script setup>
definePageMeta({ middleware: ['auth'] })

const loggedIn = useState('loggedIn')
</script>

<template>
  <section>
    <h1>後台（受保護）</h1>
    <p>你能看到這頁，代表 auth 中介層放行了。</p>
    <button class="btn gray" @click="loggedIn = false; navigateTo('/')">登出</button>
  </section>
</template>
```

### `app/pages/login.vue`

```vue
<script setup>
const loggedIn = useState('loggedIn', () => false)
const route = useRoute()

function login() {
  loggedIn.value = true
  // 導回原本要去的頁（沒有就回首頁）
  navigateTo(route.query.redirect || '/')
}
</script>

<template>
  <section>
    <h1>登入</h1>
    <p v-if="route.query.redirect">登入後將帶你回：<code>{{ route.query.redirect }}</code></p>
    <button class="btn" @click="login">一鍵登入（示範）</button>
  </section>
</template>
```

跑起來後：

- 未登入時點「後台」或直接開 `/admin` → 被 `auth` 踢到 `/login?redirect=/admin`。
- 在登入頁按「一鍵登入」→ `loggedIn` 設 true 並導回 `/admin`。
- 進到後台按「登出」→ `loggedIn` 設 false 並回首頁；再點後台又被擋。
- console 每次切頁都有 `[導覽]` 記錄（global 中介層）。

---

## 本章結語

你現在能在「進頁面之前」攔截、導向、取消，權限控管的骨架就位了。
但資料還躺在記憶體裡（重啟就沒）。下一章把假 DB 換成真的：用 **Prisma + SQLite** 接資料庫，把第 8 章的 API 升級成能持久化的**全端 CRUD**。
