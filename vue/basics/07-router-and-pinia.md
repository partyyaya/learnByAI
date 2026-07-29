# 第 7 章：Vue Router 與 Pinia

到目前為止，我們寫的都是「單一畫面」的元件。但真實應用有很多頁面（列表、詳情、登入、後台），還有需要跨頁共享的狀態（目前登入者、購物車）。這兩件事分別由 Vue 生態的兩個官方標配解決：

- **Vue Router**——讓網址對應到不同畫面，做出多頁的單頁應用（SPA）。
- **Pinia**——集中管理跨元件、跨頁面的共享狀態。

這是本課最後一章。學完後，我們會把前六章的所有能力整合成一個「文章列表 + 詳情 + 登入狀態 + 後台守衛」的迷你 SPA，並在結尾銜接到本 repo 的《源碼課》與《Nuxt 全端課》。

## 本章目標

完成這一章後，你應該可以：

1. 安裝並設定 Vue Router，用 `<router-link>` / `<router-view>` 做多頁切換。
2. 使用動態路由參數（`/user/:id`）與 `useRoute()`、用 `useRouter().push()` 做程式化導航。
3. 用巢狀路由做出共用 layout，並用 `beforeEach` 做登入保護。
4. 用 `() => import()` 做路由層級的 lazy 載入。
5. 用 Pinia 的 `defineStore`（setup 寫法）建立含 state / getters / actions 的 store，並在元件中使用。
6. 判斷什麼狀態該進 Pinia，並用 React Zustand 的經驗對照。

---

## Part 1：Vue Router

## 1. 為什麼需要路由

傳統多頁網站每點一個連結就跟伺服器要一份新 HTML、整頁刷新。SPA（單頁應用）只載入一次，之後**用 JavaScript 換掉畫面、同步改網址**，不整頁刷新，體驗像 App 一樣順。Vue Router 就是負責「網址 ↔ 該顯示哪個元件」這層對應的官方函式庫。

> 對照 React：Vue Router 之於 Vue，約等於 React Router 之於 React。概念幾乎一對一。

## 2. 安裝與設定

安裝：

```bash
npm install vue-router
```

建立路由設定檔，宣告「路徑 → 元件」的對應表：

```js
// src/router/index.js
import { createRouter, createWebHistory } from 'vue-router'
import Home from '../pages/Home.vue'

const routes = [
  { path: '/', name: 'home', component: Home },
  // lazy 載入：進到這個路由才下載該元件的檔案（見第 8 節）
  { path: '/about', name: 'about', component: () => import('../pages/About.vue') },
  // 動態參數 :id（見第 4 節）
  { path: '/user/:id', name: 'user', component: () => import('../pages/User.vue') },
]

export const router = createRouter({
  history: createWebHistory(), // 用瀏覽器 History API，網址乾淨沒有 #
  routes,
})
```

在進入點把 router 掛到 app 上：

```js
// src/main.js
import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'

createApp(App).use(router).mount('#app')
```

> `createWebHistory()` 產生 `/about` 這種乾淨網址（需伺服器把所有路徑導回 `index.html`；Vite 開發伺服器已處理好）。另有 `createWebHashHistory()` 會產生 `/#/about`，部署到靜態空間免設定，但網址較醜。一般用前者。

## 3. `<router-link>` 與 `<router-view>`

- `<router-view>`：一個「插槽」，目前路由對應的元件會渲染在這裡。
- `<router-link>`：宣告式導航，取代 `<a>`（它不會整頁刷新，還會自動加 active class）。

```vue
<!-- App.vue -->
<script setup></script>

<template>
  <nav>
    <router-link to="/">首頁</router-link>
    <!-- 也可用具名路由 + 參數物件，比手拼字串安全 -->
    <router-link :to="{ name: 'user', params: { id: 1 } }">使用者 1</router-link>
  </nav>

  <!-- 目前路由的畫面渲染在這 -->
  <router-view />
</template>
```

## 4. 動態路由參數與 `useRoute()`

路徑裡 `:id` 這種片段是動態參數。在元件裡用 `useRoute()` 拿到「目前這一筆路由」的資訊（參數、query 等）：

```vue
<!-- pages/User.vue，對應 /user/:id -->
<script setup>
import { useRoute } from 'vue-router'

const route = useRoute()
// 網址 /user/42 → route.params.id === '42'
// 網址 /user/42?tab=posts → route.query.tab === 'posts'
</script>

<template>
  <h1>使用者編號：{{ route.params.id }}</h1>
</template>
```

> 重點：`route.params.id` 是**響應式**的。但當你從 `/user/1` 導到 `/user/2`（同一個元件被重用）時，元件不會重新建立、`onMounted` 不會再跑。若你在 `onMounted` 裡發了請求，換 id 時不會重抓。解法：`watch(() => route.params.id, refetch)`，或像我們第 5 章的 `useFetch` 那樣把 url 寫成 getter 讓 `watchEffect` 自動追蹤（本章 capstone 就是這樣做）。

## 5. 程式化導航：`useRouter().push()`

在事件處理裡（例如登入成功後跳轉）用 `useRouter()` 拿到 router 實例來導航：

```vue
<script setup>
import { useRouter } from 'vue-router'

const router = useRouter()

function goHome() {
  router.push('/') // 用路徑
}
function goUser(id) {
  router.push({ name: 'user', params: { id } }) // 用具名路由
}
function goBack() {
  router.back() // 上一頁
}
</script>
```

> 區分兩個 composable：**`useRoute()`（單數，讀）** 拿「目前這頁的資訊」；**`useRouter()`（router，操作）** 拿「導航用的實例」。名字很像，別搞混。

## 6. 巢狀路由與 layout

多個頁面常共用外框（側欄、頁首）。用巢狀路由：父路由畫共用外框並放一個 `<router-view>`，子路由渲染進那個位置。

```js
// router/index.js（節錄）
const routes = [
  {
    path: '/admin',
    component: () => import('../layouts/AdminLayout.vue'),
    children: [
      { path: '', name: 'admin-home', component: () => import('../pages/AdminHome.vue') }, // /admin
      { path: 'posts', name: 'admin-posts', component: () => import('../pages/AdminPosts.vue') }, // /admin/posts
    ],
  },
]
```

```vue
<!-- layouts/AdminLayout.vue -->
<template>
  <div class="admin">
    <aside>
      <router-link to="/admin">總覽</router-link>
      <router-link to="/admin/posts">文章管理</router-link>
    </aside>
    <main>
      <!-- 子路由渲染在這 -->
      <router-view />
    </main>
  </div>
</template>
```

> 進 `/admin/posts` 時，畫面是「`AdminLayout` 外框 + 裡面嵌 `AdminPosts`」。這就是後台常見的固定側欄 + 內容區。（若你之後學 Nuxt，這件事會由檔案結構自動完成，不用手寫。）

## 7. 導航守衛：登入保護

「進某些頁面前先檢查有沒有登入，沒有就踢到登入頁」——用全域守衛 `beforeEach`。它在**每次導航前**執行，回傳一個路由物件就會改導到那裡，回傳 `false` 取消導航，什麼都不回傳（或 `true`）就放行。

先在路由用 `meta` 標記哪些頁面需要登入：

```js
// router/index.js（節錄）
const routes = [
  { path: '/', name: 'home', component: Home },
  { path: '/login', name: 'login', component: () => import('../pages/Login.vue') },
  {
    path: '/admin',
    name: 'admin',
    component: () => import('../pages/Admin.vue'),
    meta: { requiresAuth: true }, // ← 標記：這頁要登入
  },
]

// 守衛（放在 createRouter 之後）
router.beforeEach((to) => {
  const auth = useAuthStore() // Pinia store，見 Part 2；在守衛內呼叫確保 pinia 已就緒
  if (to.meta.requiresAuth && !auth.isLoggedIn) {
    // 導到登入頁，並記下原本想去哪，登入後好導回
    return { name: 'login', query: { redirect: to.fullPath } }
  }
  // 其餘放行
})
```

> 這是最小可用的登入保護骨架。注意：純前端的守衛只是「體驗上的攔截」，真正的安全要靠後端驗證——這正是 Nuxt 那類全端框架加上 server middleware 才能做到的（結尾會提）。

## 8. 路由層級的 lazy 載入

把 `component: X` 換成 `component: () => import('...')`，該路由的元件就會被打包成獨立 chunk，**使用者真的進到那個路由才下載**。首頁載入更快，後台那種不常進的頁面延後載。前面範例已經在用了：

```js
{ path: '/admin', component: () => import('../pages/Admin.vue') }
```

> 對照 React 的 `React.lazy(() => import(...))`。概念一樣：路由是最自然的程式碼分割邊界。

---

## Part 2：Pinia

## 9. 為什麼用 Pinia，而不是到處 provide/inject

第 4 章的 `provide`/`inject` 能把資料往下傳給深層子孫，但它有侷限：只能「上往下」、跨到完全不同的頁面分支就接不到、也不好在非元件的地方（如路由守衛）存取。當狀態需要**跨頁面、跨元件、隨處讀寫**（登入者、購物車、通知數），就該用專門的狀態管理——Pinia 是 Vue 官方推薦方案。

**與 React Zustand 對照**：如果你用過 Zustand，Pinia 的心智模型幾乎一樣——「一個集中的 store，裡面有狀態和改狀態的方法，任何元件都能訂閱使用」。

```js
// React Zustand
const useStore = create((set) => ({
  count: 0,
  increment: () => set((s) => ({ count: s.count + 1 })),
}))
```

```js
// Pinia（setup 寫法）
export const useCounter = defineStore('counter', () => {
  const count = ref(0)
  function increment() { count.value++ }
  return { count, increment }
})
```

差別：Zustand 靠 `set` 更新、用 selector `useStore(s => s.count)` 訂閱；Pinia 直接改 `ref`、靠 Vue 響應式自動追蹤（不用手寫 selector）。

## 10. 安裝與設定

```bash
npm install pinia
```

```js
// src/main.js
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'

createApp(App)
  .use(createPinia()) // 建議在 router 之前，路由守衛才拿得到 store
  .use(router)
  .mount('#app')
```

## 11. `defineStore`：setup 寫法（本課主用）

Pinia 的 store 有兩種寫法。本課用 **setup 寫法**，因為它跟 `<script setup>` 完全同手感：`ref` 當 state、`computed` 當 getter、一般函式當 action。

```js
// src/stores/auth.js
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

// 第一參數 'auth' 是這個 store 的唯一 id
export const useAuthStore = defineStore('auth', () => {
  // state → ref
  const user = ref(null)

  // getter → computed
  const isLoggedIn = computed(() => user.value !== null)

  // action → function
  function login(name) {
    user.value = { name }
  }
  function logout() {
    user.value = null
  }

  // 一定要 return 出去，外部才用得到
  return { user, isLoggedIn, login, logout }
})
```

**選項寫法（對照參考）**——跟 Vuex 較像，挑一種用即可，本課後面統一用 setup 寫法：

```js
export const useAuthStore = defineStore('auth', {
  state: () => ({ user: null }),
  getters: {
    isLoggedIn: (s) => s.user !== null,
  },
  actions: {
    login(name) { this.user = { name } },
    logout() { this.user = null },
  },
})
```

| setup 寫法 | 選項寫法 | 角色 |
|-----------|---------|------|
| `ref()` | `state: () => ({...})` | 狀態 |
| `computed()` | `getters` | 衍生值 |
| 一般 `function` | `actions` | 改狀態的方法 |

## 12. 在元件中使用（含 `storeToRefs` 陷阱）

```vue
<script setup>
import { storeToRefs } from 'pinia'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()

// 直接用 auth.xxx 沒問題（保有響應式）
// 但若要「解構」出 state / getter，必須用 storeToRefs，否則會失去響應式！
const { user, isLoggedIn } = storeToRefs(auth)

// action 是函式，可以直接解構（不需要 storeToRefs）
const { login, logout } = auth
</script>

<template>
  <p v-if="isLoggedIn">哈囉 {{ user.name }}</p>
  <button v-if="!isLoggedIn" @click="login('Gary')">登入</button>
  <button v-else @click="logout()">登出</button>
</template>
```

> **最常見的 Pinia 陷阱**：`const { user } = auth` 直接解構會拿到「當下的值」而失去響應式，畫面不會更新。要嘛整包用 `auth.user`，要嘛用 `storeToRefs(auth)` 解構 state/getter。action（函式）不受影響，可直接解構。

---

## Part 3：收尾小專案（迷你 SPA）

把前六章 + 本章整合：一個「文章列表 → 詳情」的閱讀站，用 Pinia 管登入狀態，用路由守衛保護後台。資料串免費的 `jsonplaceholder`。原樣建立以下檔案就能跑（`npm create vue@latest` 建專案後，`npm install vue-router pinia`）。

專案結構：

```text
src/
├─ main.js
├─ App.vue
├─ router/index.js
├─ stores/auth.js
├─ composables/useFetch.js
└─ pages/
   ├─ PostList.vue
   ├─ PostDetail.vue
   ├─ Login.vue
   └─ Admin.vue
```

### `src/composables/useFetch.js`

沿用第 5 章的 `useFetch`（整段拉進來，方便對照）。關鍵是 `url` 可傳 getter，`watchEffect` 會自動追蹤，換文章時自動重抓：

```js
import { ref, watchEffect, toValue } from 'vue'

export function useFetch(url) {
  const data = ref(null)
  const error = ref(null)
  const loading = ref(false)

  watchEffect(async () => {
    data.value = null
    error.value = null
    loading.value = true
    try {
      const res = await fetch(toValue(url))
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      data.value = await res.json()
    } catch (e) {
      error.value = e
    } finally {
      loading.value = false
    }
  })

  return { data, error, loading }
}
```

### `src/stores/auth.js`

```js
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useAuthStore = defineStore('auth', () => {
  const user = ref(null)
  const isLoggedIn = computed(() => user.value !== null)

  function login(name) {
    user.value = { name }
  }
  function logout() {
    user.value = null
  }

  return { user, isLoggedIn, login, logout }
})
```

### `src/router/index.js`

```js
import { createRouter, createWebHistory } from 'vue-router'
import PostList from '../pages/PostList.vue'
import { useAuthStore } from '../stores/auth'

const routes = [
  { path: '/', name: 'home', component: PostList },
  {
    path: '/posts/:id',
    name: 'post',
    component: () => import('../pages/PostDetail.vue'),
  },
  { path: '/login', name: 'login', component: () => import('../pages/Login.vue') },
  {
    path: '/admin',
    name: 'admin',
    component: () => import('../pages/Admin.vue'),
    meta: { requiresAuth: true },
  },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})

// 登入守衛：沒登入不准進 requiresAuth 的頁
router.beforeEach((to) => {
  const auth = useAuthStore()
  if (to.meta.requiresAuth && !auth.isLoggedIn) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }
})
```

### `src/main.js`

```js
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'

createApp(App).use(createPinia()).use(router).mount('#app')
```

### `src/App.vue`

```vue
<script setup>
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'
import { useAuthStore } from './stores/auth'

const auth = useAuthStore()
const { user, isLoggedIn } = storeToRefs(auth)
const router = useRouter()

function handleLogout() {
  auth.logout()
  router.push('/')
}
</script>

<template>
  <header class="bar">
    <nav>
      <router-link to="/">文章</router-link>
      <router-link to="/admin">後台</router-link>
    </nav>
    <div class="user">
      <template v-if="isLoggedIn">
        <span>哈囉，{{ user.name }}</span>
        <button class="ghost" @click="handleLogout">登出</button>
      </template>
      <router-link v-else to="/login">登入</router-link>
    </div>
  </header>

  <main class="content">
    <router-view />
  </main>
</template>

<style>
body { margin: 0; font-family: -apple-system, "Segoe UI", sans-serif; background: #f3f4f6; color: #111827; }
.bar { display: flex; justify-content: space-between; align-items: center; padding: 12px 24px; background: #fff; border-bottom: 1px solid #e5e7eb; }
.bar nav a { margin-right: 16px; text-decoration: none; color: #374151; }
.bar nav a.router-link-active { color: #2563eb; font-weight: 600; }
.user { display: flex; align-items: center; gap: 10px; }
.content { max-width: 680px; margin: 0 auto; padding: 24px; line-height: 1.7; }
button { border: 1px solid #2563eb; background: #2563eb; color: #fff; border-radius: 8px; padding: 6px 12px; cursor: pointer; }
button.ghost { background: #fff; color: #2563eb; }
a { color: #2563eb; }
.card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; margin-bottom: 12px; }
</style>
```

### `src/pages/PostList.vue`

```vue
<script setup>
import { useFetch } from '../composables/useFetch'

const { data: posts, loading, error } = useFetch(
  'https://jsonplaceholder.typicode.com/posts?_limit=10'
)
</script>

<template>
  <section>
    <h1>文章列表</h1>
    <p v-if="loading">載入中…</p>
    <p v-else-if="error">載入失敗：{{ error.message }}</p>
    <template v-else>
      <article v-for="post in posts" :key="post.id" class="card">
        <router-link :to="{ name: 'post', params: { id: post.id } }">
          <strong>{{ post.title }}</strong>
        </router-link>
      </article>
    </template>
  </section>
</template>
```

### `src/pages/PostDetail.vue`

```vue
<script setup>
import { useRoute, useRouter } from 'vue-router'
import { useFetch } from '../composables/useFetch'

const route = useRoute()
const router = useRouter()

// url 寫成 getter：route.params.id 一變，useFetch 內的 watchEffect 自動重抓
const { data: post, loading, error } = useFetch(
  () => `https://jsonplaceholder.typicode.com/posts/${route.params.id}`
)
</script>

<template>
  <section>
    <button class="ghost" @click="router.back()">← 返回</button>
    <p v-if="loading">載入中…</p>
    <p v-else-if="error">載入失敗：{{ error.message }}</p>
    <article v-else class="card">
      <h1>{{ post.title }}</h1>
      <p>{{ post.body }}</p>
    </article>
  </section>
</template>
```

### `src/pages/Login.vue`

```vue
<script setup>
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'

const name = ref('')
const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

function submit() {
  if (!name.value.trim()) return
  auth.login(name.value.trim())
  // 登入後導回原本想去的頁（守衛存在 query.redirect），沒有就回首頁
  router.push(route.query.redirect || '/')
}
</script>

<template>
  <section>
    <h1>登入</h1>
    <p v-if="route.query.redirect">
      登入後將帶你回：<code>{{ route.query.redirect }}</code>
    </p>
    <form class="card" @submit.prevent="submit">
      <input v-model="name" placeholder="輸入暱稱即可（示範）" />
      <button type="submit">登入</button>
    </form>
  </section>
</template>
```

### `src/pages/Admin.vue`

```vue
<script setup>
import { useAuthStore } from '../stores/auth'
const auth = useAuthStore()
</script>

<template>
  <section>
    <h1>後台（需登入）</h1>
    <p>只有登入者看得到這頁。目前登入者：<strong>{{ auth.user.name }}</strong></p>
    <p>直接在網址列輸入 <code>/admin</code> 未登入時，會被守衛導去登入頁。</p>
  </section>
</template>
```

### 跑起來後

- 首頁 `/` → 顯示 10 篇文章（`useFetch` 抓 jsonplaceholder）。
- 點標題 → 進 `/posts/:id`，`useFetch` 的 getter url 讓切換文章時自動重抓（不用手寫 watch）。
- 未登入點「後台」或直開 `/admin` → 守衛把你踢到 `/login?redirect=/admin`。
- 在登入頁輸入暱稱送出 → Pinia 存下登入者，導回 `/admin`，頁首即時顯示「哈囉，你的名字」（跨元件同步）。
- 按登出 → Pinia 清掉，頁首變回「登入」，再點後台又被擋。

這個骨架就是一個真實 SPA 的縮影：**路由分頁 + 資料抓取 + 全域狀態 + 存取控制**，全用本課教過的東西拼出來。

---

## 常見陷阱

1. **`useRoute` 與 `useRouter` 搞混**：讀當前頁資訊用 `useRoute()`；做導航用 `useRouter().push()`。
2. **同一元件跨參數不重抓**：`/posts/1` → `/posts/2` 時元件被重用、`onMounted` 不再跑。用 `watch(() => route.params.id, ...)` 或把 url 寫成 getter 交給 `watchEffect`（本章 capstone 的做法）。
3. **解構 Pinia store 失去響應式**：`const { user } = auth` 會斷開響應式。state/getter 要用 `storeToRefs(auth)` 解構；action 才可直接解構。
4. **在 store 就緒前用它**：路由守衛裡呼叫 `useAuthStore()` 前，`createPinia()` 必須先 `use`。把 `.use(createPinia())` 放在 `.use(router)` 之前，並在守衛「函式內」才呼叫 store（不要在模組頂層呼叫）。
5. **把純前端守衛當成安全機制**：`beforeEach` 只是體驗上的攔截，前端程式碼使用者都拿得到。真正的權限要靠後端驗證。
6. **`createWebHistory` 部署後重整 404**：伺服器要把所有路徑 fallback 到 `index.html`。開發時 Vite 已處理；部署到靜態主機要另外設定（或改用 `createWebHashHistory`）。

---

## 練習作業

1. 幫 capstone 加一個 `/users/:id` 頁面，用 `useFetch` 抓 `jsonplaceholder` 的使用者資料，並從文章詳情連過去。
2. 把 `Admin` 改成巢狀路由：`/admin`（總覽）與 `/admin/posts`（列表），共用一個含側欄的 `AdminLayout`。
3. 幫 auth store 加一個 `role`（`'user'` / `'admin'`），並讓守衛只放行 `admin` 進 `/admin`。
4. 加一個「文章草稿」的 Pinia store（`ref` 陣列 + `addDraft` action），在兩個不同頁面新增與顯示，確認跨頁同步。
5. 進階：把登入狀態存進 `localStorage`，重整頁面後仍保持登入（提示：在 store 初始化時讀取、在 action 改動時寫入，或研究 `pinia-plugin-persistedstate`）。

---

## 結業與下一步

恭喜你完成這門 Vue 3 精華橋接課！回顧你已經具備的能力：

- SFC + Vite 開發環境（01）
- `ref`/`reactive`/`computed`/`watch` 響應式（02）
- 模板語法與指令（03）
- 元件溝通 `props`/`emit`/`v-model`/`slots`/`provide-inject`（04）
- 生命週期與把邏輯抽成 composable（05）
- 表單與可重用的驗證（06）
- Vue Router 多頁 + Pinia 全域狀態，並整合成一個迷你 SPA（07）

這正是「能無縫進入本 repo 兩門進階課」所需的全部基礎。兩條路任選（或都走）：

### 想搞懂「Vue 為什麼這樣運作」→ 走[《Vue 3 源碼解析課》](../vue-source/README.md)

你這門課用到的 `ref` 為什麼改了畫面就會動、`computed` 為什麼只在依賴變時重算、`watchEffect` 怎麼自動追蹤依賴、`<script setup>` 怎麼被編譯——源碼課會帶你從 `reactivity` 的 `track`/`trigger`/`effect` 一路追到 renderer 與編譯器，把「魔法」變成「你看得懂、追得動、改得準」的機制。你在本課建立的組合式 API 心智模型，正是讀源碼的最佳起點。

### 想把 SPA 升級成可上線的全端產品 → 走[《Nuxt 全端課》](../nuxt/README.md)

你在第 7 章手動拼的那些東西——路由設定、資料抓取、跨頁狀態、登入守衛——**Nuxt 全都內建好了**：

| 本課手動做的 | Nuxt 幫你內建 |
|-------------|--------------|
| `vue-router` 手寫 routes 表 | 檔案式路由（`pages/` 放檔案自動生成路由） |
| `useFetch` composable 自己寫 | 內建 `useFetch`／`useAsyncData`，還自動在伺服器就抓好（SSR） |
| `beforeEach` 全域守衛 | 路由中介層 `middleware/` + 伺服器端 `requireUserSession` 真正的權限 |
| 純前端 SPA | SSR / SSG / 混合渲染，SEO 友善、首屏更快 |
| 只能打別人的 API | Nitro 伺服器引擎，在 `server/api/` 寫自己的後端 |

換句話說，Nuxt 就是把「這一章你手動組的那套」升級成一個生產級全端框架。定位上，Nuxt 之於 Vue，就像 Next.js 之於 React。你現在的 Vue 基礎已經足夠，直接開《Nuxt 全端課》的第 1 章即可。

祝學習順利，我們在進階課再會。

---

## 上一章 / 下一章

- 上一章：[第 6 章：表單與驗證](./06-forms-and-validation.md)
- 課程結束 → [Vue 源碼解析課](../vue-source/README.md) ｜ [Nuxt 全端課](../nuxt/README.md)
