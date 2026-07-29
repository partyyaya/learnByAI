# 第 7 章：共享狀態（useState 與 Pinia）

## 本章目標

完成這一章後，你應該可以：

1. 解釋為什麼在 SSR 下不能用「模組層級的 `ref`」當全域狀態。
2. 用 `useState` 做跨元件、SSR 安全的共享狀態，並包成 composable。
3. 安裝並使用 **Pinia**，寫出含 `state` / `getters` / `actions` 的 store。
4. 判斷「什麼時候 `useState` 就夠、什麼時候該上 Pinia」。
5. 知道 Pinia 狀態如何在 SSR → client 自動 hydration，以及如何做持久化。

---

## 1. 問題：SSR 下的全域狀態很危險

在純前端 SPA，你可以把 `ref` 放模組最外層當全域狀態：

```js
// ❌ 在 Nuxt(SSR) 會出事
const user = ref(null)
export function useUser() {
  return user
}
```

在瀏覽器這沒問題，因為每個使用者都有自己的分頁、自己的 JS 環境。但 **Nuxt 伺服器是一個長期執行的 Node 程序，同時服務很多使用者**。這個模組層級的 `user` 只會被建立一次，於是：

> A 使用者登入後 `user.value = A`，B 使用者的請求進來時，竟然看到 A 的資料——**狀態串到別人身上了**（跨請求汙染）。

這是 SSR 新手最危險的坑之一。解法就是 Nuxt 的 `useState`（第 4 章初嘗過），或 Pinia。

---

## 2. `useState`：SSR 安全的共享狀態

`useState(key, init)` 幫你做到「每個請求各自隔離、同一請求內跨元件共享」：

```js
// app/composables/useUser.js
export function useUser() {
  // 相同 key 在任何元件取到同一份；但不同請求彼此隔離，SSR 安全
  return useState('user', () => null)
}
```

用起來就像 `ref`：

```vue
<script setup>
const user = useUser()
</script>

<template>
  <p v-if="user">哈囉 {{ user.name }}</p>
  <button @click="user = { name: 'Gary' }">登入</button>
</template>
```

重點：

- 第一參數 **key** 要唯一；相同 key 跨元件/頁面共享同一份。
- 第二參數是**初始值工廠函式**（不是值本身），Nuxt 只在需要時呼叫它。
- 伺服器算好的值會序列化進 HTML payload，client hydration 直接沿用（不閃動、不重算）。
- 值必須可被序列化（JSON-friendly）——不要塞函式、class 實例進去。

> 慣例：把 `useState` 包進 `app/composables/useXxx.js`，對外只暴露乾淨的 API。元件不直接呼叫 `useState('user', ...)`，避免 key 散落各處、打錯字。

---

## 3. 用 `useState` 包出一個小 store

`useState` 搭配 composable，就能做出輕量 store，含衍生值與操作：

```js
// app/composables/useCart.js
export function useCart() {
  const items = useState('cart', () => []) // [{ id, title, price, qty }]

  const count = computed(() => items.value.reduce((s, i) => s + i.qty, 0))
  const total = computed(() => items.value.reduce((s, i) => s + i.price * i.qty, 0))

  function add(product) {
    const found = items.value.find((i) => i.id === product.id)
    if (found) found.qty++
    else items.value = [...items.value, { ...product, qty: 1 }]
  }

  function remove(id) {
    items.value = items.value.filter((i) => i.id !== id)
  }

  return { items, count, total, add, remove }
}
```

這對中小專案很夠用。但當狀態變複雜（很多 store、要 devtools 追蹤、跨 store 互動、要模組化）時，就換 Pinia。

---

## 4. 安裝 Pinia

Pinia 是 Vue 官方推薦的狀態管理庫，Nuxt 有官方模組整合（自動處理 SSR hydration、自動匯入 store）。安裝：

```bash
npx nuxi module add pinia
```

這會自動安裝 `@pinia/nuxt` + `pinia` 並加進 `nuxt.config.ts`：

```ts
// nuxt.config.ts（module add 會幫你補好）
export default defineNuxtConfig({
  modules: ['@pinia/nuxt'],
})
```

> 若指令沒自動裝 `pinia`，手動補：`npm install pinia`。

---

## 5. 寫一個 Pinia store

Store 放在 `app/stores/`（會被自動匯入）。有兩種寫法，本課用較直覺的 **setup 寫法**（跟 `<script setup>` 一樣的手感）：

> ⚠️ Nuxt 4 把原始碼收進 `app/`，store 的路徑是 `app/stores/`。**較新版的 `@pinia/nuxt` 才會自動掃這個路徑**；若你發現 `useXxxStore()` 沒被自動匯入（報 undefined），先確認 `@pinia/nuxt` 是新版，或在 `nuxt.config` 設 `pinia: { storesDirs: ['./app/stores/**'] }` 明確指定掃描目錄。

```js
// app/stores/cart.js
export const useCartStore = defineStore('cart', () => {
  // state → 用 ref
  const items = ref([])

  // getters → 用 computed
  const count = computed(() => items.value.reduce((s, i) => s + i.qty, 0))
  const total = computed(() => items.value.reduce((s, i) => s + i.price * i.qty, 0))

  // actions → 用一般函式
  function add(product) {
    const found = items.value.find((i) => i.id === product.id)
    if (found) found.qty++
    else items.value.push({ ...product, qty: 1 })
  }
  function remove(id) {
    items.value = items.value.filter((i) => i.id !== id)
  }
  function clear() {
    items.value = []
  }

  return { items, count, total, add, remove, clear }
})
```

在元件裡使用（`useCartStore` 自動匯入）：

```vue
<script setup>
const cart = useCartStore()
</script>

<template>
  <p>購物車：{{ cart.count }} 件，共 ${{ cart.total }}</p>
  <button @click="cart.add({ id: 1, title: '課程', price: 100 })">加入</button>
  <button @click="cart.clear()">清空</button>
</template>
```

> 注意：在 store 裡改 Pinia 的 `ref` 可以直接 `items.value.push(...)`（Pinia 的 state 是深層響應式，跟第 6 章 `useFetch` 的 `shallowRef` 不同，別搞混）。在元件裡讀 `cart.count`、`cart.items` 不用 `.value`（Pinia 幫你解包了）。

### 選項寫法（對照參考）

Pinia 也支援物件式寫法，跟 Vuex 較像：

```js
export const useCartStore = defineStore('cart', {
  state: () => ({ items: [] }),
  getters: {
    count: (s) => s.items.reduce((a, i) => a + i.qty, 0),
  },
  actions: {
    add(p) { /* ... */ },
  },
})
```

兩種等價，挑一種用就好。本課後面統一用 setup 寫法。

---

## 6. SSR hydration 與持久化

**hydration 自動搞定**：`@pinia/nuxt` 會把伺服器端 store 的 state 序列化進 payload，client 端自動接上，你什麼都不用做——這正是用官方模組（而非自己 `new Pinia()`）的好處。

**持久化到 localStorage**：Pinia 的 state 預設不會存，重整就沒了。要保留（例如購物車、主題），裝 `pinia-plugin-persistedstate`。**注意它是一個 Nuxt 模組，光 `npm install` 不會生效**——一定要把模組註冊起來：

```bash
npx nuxi module add pinia-plugin-persistedstate
```

它會裝好套件並把 `'pinia-plugin-persistedstate/nuxt'` 加進 `nuxt.config.ts`（也可以手動加，記得排在 `'@pinia/nuxt'` 之後）：

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: [
    '@pinia/nuxt',
    'pinia-plugin-persistedstate/nuxt', // 註冊後，store 的 persist 選項才會生效
  ],
})
```

模組註冊好之後，store 加 `persist: true` 才會啟用：

```js
// app/stores/cart.js
export const useCartStore = defineStore('cart', () => {
  /* ...同上... */
}, {
  persist: true, // 自動存 localStorage、重整還在
})
```

> ⚠️ 最常見的坑：只跑了 `npm install pinia-plugin-persistedstate` 沒註冊模組，就寫 `persist: true`——這時 `persist` 會被**默默忽略**（不會報錯），重整資料照樣消失，很難察覺。看到「加了 `persist` 卻沒效果」，先檢查模組有沒有進 `modules`。
>
> ⚠️ `localStorage` 只有瀏覽器有。持久化插件會在 client 端補水，這是預期行為；但別在 store 初始值裡直接讀 `localStorage`（SSR 會炸），交給插件處理。

---

## 7. `useState` vs Pinia：怎麼選

| 情況 | 建議 |
|---|---|
| 一兩個簡單共享值（主題、目前使用者） | `useState` + composable |
| 邏輯簡單、不想加依賴 | `useState` |
| 多個 store、複雜互動、要 devtools 時間旅行 | **Pinia** |
| 團隊已習慣 Pinia / 專案會長大 | **Pinia** |
| 伺服器資料的快取（列表、詳情） | 都不是——用第 6 章的 `useFetch`！ |

最後這條最重要：

> **別把「伺服器資料」塞進 Pinia 手動管快取。** 那是 `useFetch`/`useAsyncData` 的工作（它們處理去重、快取、重抓）。Pinia/`useState` 管的是「**UI 狀態與跨頁共用的本地狀態**」——例如購物車內容、側欄開合、主題、登入者資訊。分清「伺服器狀態 vs 客戶端狀態」，狀態就不會亂。

---

## 8. 本章小練習

1. 用 `useState` 做一個 `useTheme`（`light` / `dark` 切換），在頁首放切換鈕。
2. 安裝 Pinia，把上面的 `useCart` 改寫成 Pinia store。
3. 在兩個不同頁面各放「加入購物車」與「購物車數量」，確認跨頁同步。
4. 幫 cart store 加 `persist: true`，重整頁面看內容還在不在。
5. 想一個你手邊專案的狀態，判斷它該用 `useFetch`、`useState` 還是 Pinia。

---

## 最後範例：主題（useState）+ 購物車（Pinia）

> 同時示範兩種狀態工具：輕量主題用 `useState`，較完整的購物車用 Pinia。先安裝 Pinia：`npx nuxi module add pinia`。原樣建立以下檔案即可跑。

### `app/composables/useTheme.js`

```js
// 輕量共享狀態，用 useState 就夠
export function useTheme() {
  const theme = useState('theme', () => 'light')
  const toggle = () => (theme.value = theme.value === 'light' ? 'dark' : 'light')
  return { theme, toggle }
}
```

### `app/stores/cart.js`

```js
export const useCartStore = defineStore('cart', () => {
  const items = ref([])
  const count = computed(() => items.value.reduce((s, i) => s + i.qty, 0))
  const total = computed(() => items.value.reduce((s, i) => s + i.price * i.qty, 0))

  function add(product) {
    const found = items.value.find((i) => i.id === product.id)
    if (found) found.qty++
    else items.value.push({ ...product, qty: 1 })
  }
  function remove(id) {
    items.value = items.value.filter((i) => i.id !== id)
  }
  function clear() {
    items.value = []
  }

  return { items, count, total, add, remove, clear }
})
```

### `app/app.vue`

```vue
<script setup>
const { theme, toggle } = useTheme()
const cart = useCartStore()
</script>

<template>
  <div class="wrap" :data-theme="theme">
    <header class="bar">
      <nav>
        <NuxtLink to="/">商店</NuxtLink>
        <NuxtLink to="/cart">購物車（{{ cart.count }}）</NuxtLink>
      </nav>
      <button class="ghost" @click="toggle">
        {{ theme === 'light' ? '🌙 深色' : '☀️ 淺色' }}
      </button>
    </header>
    <main><NuxtPage /></main>
  </div>
</template>

<style>
body { margin: 0; font-family: -apple-system, "Segoe UI", sans-serif; }
.wrap { min-height: 100vh; }
.wrap[data-theme="light"] { background: #f3f4f6; color: #111827; }
.wrap[data-theme="dark"] { background: #111827; color: #f9fafb; }
.bar { display: flex; justify-content: space-between; align-items: center; padding: 12px 24px; border-bottom: 1px solid rgba(128,128,128,.2); }
.bar nav a { margin-right: 16px; text-decoration: none; color: inherit; }
.bar nav a.router-link-active { color: #00dc82; font-weight: 600; }
main { max-width: 640px; margin: 0 auto; padding: 24px; line-height: 1.7; }
.ghost { background: none; border: 1px solid currentColor; color: inherit; border-radius: 999px; padding: 4px 12px; cursor: pointer; }
.product { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border: 1px solid rgba(128,128,128,.2); border-radius: 12px; margin-bottom: 10px; }
.btn { padding: 6px 14px; border: none; border-radius: 10px; background: #00dc82; color: #062; font-weight: 600; cursor: pointer; }
</style>
```

### `app/pages/index.vue`

```vue
<script setup>
const cart = useCartStore()
const products = [
  { id: 1, title: 'Nuxt 課程', price: 100 },
  { id: 2, title: 'Vue 課程', price: 80 },
  { id: 3, title: 'TypeScript 課程', price: 90 },
]
</script>

<template>
  <section>
    <h1>商店</h1>
    <div v-for="p in products" :key="p.id" class="product">
      <span>{{ p.title }} — ${{ p.price }}</span>
      <button class="btn" @click="cart.add(p)">加入購物車</button>
    </div>
  </section>
</template>
```

### `app/pages/cart.vue`

```vue
<script setup>
const cart = useCartStore()
</script>

<template>
  <section>
    <h1>購物車</h1>
    <p v-if="cart.count === 0">還是空的，<NuxtLink to="/">去逛逛 →</NuxtLink></p>
    <template v-else>
      <div v-for="i in cart.items" :key="i.id" class="product">
        <span>{{ i.title }} × {{ i.qty }}（${{ i.price * i.qty }}）</span>
        <button class="btn" style="background:#ef4444;color:#fff" @click="cart.remove(i.id)">移除</button>
      </div>
      <h3>總計：${{ cart.total }}</h3>
      <button class="btn" @click="cart.clear()">清空</button>
    </template>
  </section>
</template>
```

跑起來後：

- 首頁加入商品 → 頁首「購物車」數字即時更新（Pinia 跨元件同步）。
- 切到 `/cart` → 內容一致（跨頁共享）。
- 右上角切換主題 → 整站配色變（`useState` 共享）。
- 檢視原始碼：主題與購物車初始狀態都在 HTML 裡（SSR 正常、hydration 不閃）。

---

## 本章結語

你現在能分清「伺服器狀態（`useFetch`）」與「客戶端狀態（`useState` / Pinia）」，狀態設計不再打結。
但我們一直在打**別人的 API**。下一章要自己當後端：用 Nuxt 內建的 **Nitro 伺服器引擎**，在 `server/api/` 寫自己的 API，並學會用 **Runtime Config** 安全地管環境變數與金鑰。
