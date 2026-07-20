# 第 13 章：錯誤處理、Plugins 與 Nuxt 模組

## 本章目標

完成這一章後，你應該可以：

1. 分清 `createError` / `showError` / `clearError` / `useError` 的用途，處理致命與非致命錯誤。
2. 用 `<NuxtErrorBoundary>` 做局部錯誤隔離，不讓一小塊壞掉就整頁掛掉。
3. 用 `defineNuxtPlugin` 寫外掛，在啟動時注入共用能力（helper、第三方 client）。
4. 分清 client-only / server-only plugin，並控制執行順序。
5. 說出 Nuxt 模組是什麼、和 plugin 差在哪、怎麼挑與安裝。

---

## 1. 錯誤處理的三個層次

Nuxt 的錯誤處理有三種粒度，對應不同情境：

| 層次 | 工具 | 效果 |
|---|---|---|
| **整頁致命錯誤** | `createError({ fatal: true })` / `showError` | 顯示 `app/error.vue`（第 3 章） |
| **局部錯誤** | `<NuxtErrorBoundary>` | 只有那一塊顯示 fallback，其餘正常 |
| **可預期的資料錯誤** | `useFetch` 的 `error` | 在畫面裡自己處理（顯示訊息、重試） |

### `createError`：丟出錯誤

```js
// 非致命（例如在 API handler 裡）：前端收到後可自行處理
throw createError({ statusCode: 404, statusMessage: '找不到文章' })

// 致命（fatal: true）：直接跳到全站錯誤頁 error.vue
throw createError({ statusCode: 500, statusMessage: '系統錯誤', fatal: true })
```

在 `<script setup>` 頂層 `throw createError({ statusCode: 404 })`（如第 3、6、12 章）就會走 `error.vue`。

### `showError` / `clearError` / `useError`

```js
showError({ statusCode: 500, statusMessage: '出事了' }) // 程式化觸發錯誤頁
```

在 `error.vue` 裡除了 `error` prop，也能用 `useError()` 讀目前錯誤；用 `clearError({ redirect: '/' })` 清除並導頁（第 3 章）。

---

## 2. `<NuxtErrorBoundary>`：局部錯誤隔離

有時你不想「一小塊壞掉就整站跳錯誤頁」。用 `<NuxtErrorBoundary>` 把可能出錯的區塊包起來，只有它顯示 fallback：

```vue
<template>
  <div>
    <h1>儀表板</h1>

    <NuxtErrorBoundary>
      <!-- 這塊若丟錯，只有這裡顯示 fallback，上面的標題與其他區塊照常 -->
      <RiskyWidget />

      <template #error="{ error, clearError }">
        <p>這個小工具載入失敗了 😢</p>
        <button @click="clearError">重試</button>
      </template>
    </NuxtErrorBoundary>
  </div>
</template>
```

> 判斷：**核心內容壞了** → 讓它走 `error.vue`（整頁）；**周邊小工具壞了**（推薦區、廣告、圖表）→ 用 `<NuxtErrorBoundary>` 局部處理，保住主要體驗。

---

## 3. Plugins：啟動時注入能力

Plugin 是「App 啟動時執行一次」的程式，放在 `app/plugins/`（自動註冊，依檔名順序）。常見用途：

- 注入全站可用的 helper（格式化日期、金額）。
- 初始化第三方套件（設定好一個 API client、圖表庫）。
- 註冊 Vue 指令、掛 App 層級的 hook。

基本形狀：

```js
// app/plugins/hello.js
export default defineNuxtPlugin((nuxtApp) => {
  console.log('App 啟動了，這裡只跑一次')
})
```

### 注入 helper：`provide`

用 `provide` 注入的東西，可在任何元件用 `$名稱`（模板）或 `useNuxtApp().$名稱`（script）取得：

```js
// app/plugins/format.js
export default defineNuxtPlugin(() => {
  return {
    provide: {
      // 注入一個格式化日期的函式，全站可用 $formatDate
      formatDate: (d) => new Date(d).toLocaleDateString('zh-TW'),
    },
  }
})
```

```vue
<script setup>
const { $formatDate } = useNuxtApp()
</script>

<template>
  <!-- 模板裡直接用 $formatDate -->
  <small>{{ $formatDate(post.createdAt) }}</small>
</template>
```

> 小提醒：能用 composable（`app/composables/`）解決的，優先用 composable。Plugin 適合「需要在啟動時初始化」或「要注入到 Vue App 實例」的東西。

---

## 4. client-only / server-only plugin 與執行順序

有些初始化只該在某一端跑（例如只有瀏覽器才有的分析 SDK）。用檔名後綴控制：

```text
app/plugins/
├─ analytics.client.js   → 只在瀏覽器執行
├─ setup.server.js       → 只在伺服器執行
└─ common.js             → 兩端都執行
```

**執行順序**：預設依檔名字母序。要明確排序，可用數字前綴（`01.setup.js`、`02.api.js`），或用物件式語法宣告相依：

```js
export default defineNuxtPlugin({
  name: 'my-plugin',
  dependsOn: ['other-plugin'], // 等 other-plugin 先跑完
  async setup(nuxtApp) {
    // ...
  },
})
```

### 掛 App 層級 hook（全域攔錯）

Plugin 也適合掛全域錯誤 hook，把錯誤送到監控服務：

```js
// app/plugins/error-tracking.client.js
export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.hook('vue:error', (err, instance, info) => {
    // 送到你的錯誤監控（Sentry 等）
    console.error('[捕捉到 Vue 錯誤]', err, info)
  })
})
```

---

## 5. Nuxt 模組是什麼

前面我們裝過 `@pinia/nuxt`、`nuxt-auth-utils`、`@nuxtjs/seo`——它們都是 **Nuxt 模組**。

模組和 plugin 的差別：

| | Plugin | Module |
|---|---|---|
| 何時作用 | **執行時**（App 啟動） | **打包時**（改變專案怎麼被建置） |
| 能做什麼 | 注入 helper、初始化套件 | 加路由、加元件、注入 plugin、改 webpack/vite 設定、自動匯入… |
| 你寫的頻率 | 常寫 | 少自己寫，多是「安裝別人的」 |
| 例子 | `format.js` | `@pinia/nuxt`、`@nuxt/image` |

一句話：**Plugin 是「App 內的一段啟動程式」，Module 是「擴充 Nuxt 本身的外掛」。** 模組威力更大，因為它能在建置階段動整個專案（甚至自動幫你注入 plugin）。

### 怎麼挑與安裝模組

- 到官方模組列表（nuxt.com 的 Modules 頁）找，優先看 ⭐ 官方（`@nuxt/*`、`@nuxtjs/*`）與維護活躍度。
- 安裝一律用：

```bash
npx nuxi module add <模組名>
```

它會自動裝套件並加進 `nuxt.config.ts` 的 `modules` 陣列。之後就能用該模組提供的元件/composable（多半也是自動匯入）。

> 本課用到的模組彙整：狀態 `@pinia/nuxt`、認證 `nuxt-auth-utils`、SEO `@nuxtjs/seo`、樣式 `@nuxtjs/tailwindcss`、圖片 `@nuxt/image`、字型 `@nuxt/fonts`、測試 `@nuxt/test-utils`（後面章節會用到）。

---

## 6. 本章小練習

1. 寫 `app/plugins/format.js` 注入 `$formatDate`，在文章列表顯示格式化後的日期。
2. 用 `<NuxtErrorBoundary>` 包一個會丟錯的小元件，做出「只有它壞、其他正常」的效果。
3. 寫一個 `.client.js` plugin，在 console 印出「只有瀏覽器會看到這行」，確認 SSR terminal 沒印。
4. 掛 `vue:error` hook，故意在元件丟錯，看 hook 有沒有攔到。
5. 到 Nuxt Modules 找一個你有興趣的模組，用 `nuxi module add` 裝起來玩玩。

---

## 最後範例：注入日期 helper + 局部錯誤隔離

> 示範 plugin 注入全站 helper，以及 `<NuxtErrorBoundary>` 保住主要內容。原樣建立以下檔案即可跑。

### `app/plugins/format.js`

```js
export default defineNuxtPlugin(() => {
  return {
    provide: {
      formatDate: (d) => {
        if (!d) return ''
        return new Date(d).toLocaleString('zh-TW', {
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit',
        })
      },
    },
  }
})
```

### `app/components/FlakyWidget.vue`

```vue
<script setup>
// 用來示範錯誤邊界：勾一下就丟錯
const props = defineProps({ broken: Boolean })
if (props.broken) {
  throw new Error('這個小工具壞掉了')
}
</script>

<template>
  <div class="widget">✅ 小工具正常運作中</div>
</template>

<style scoped>
.widget { padding: 12px 16px; background: #ecfdf5; border-radius: 10px; color: #065f46; }
</style>
```

### `app/pages/index.vue`

```vue
<script setup>
const { $formatDate } = useNuxtApp()
const now = new Date().toISOString()
const broken = ref(false)
</script>

<template>
  <main class="wrap">
    <h1>Plugin + 錯誤邊界示範</h1>

    <section>
      <h2>1. Plugin 注入的 $formatDate</h2>
      <p>原始：<code>{{ now }}</code></p>
      <p>格式化：<strong>{{ $formatDate(now) }}</strong></p>
    </section>

    <section>
      <h2>2. NuxtErrorBoundary 局部隔離</h2>
      <label><input type="checkbox" v-model="broken" /> 讓小工具壞掉</label>

      <NuxtErrorBoundary>
        <FlakyWidget :broken="broken" />
        <template #error="{ error, clearError }">
          <div class="fallback">
            <p>⚠️ 小工具載入失敗：{{ error.message }}</p>
            <button @click="() => { broken = false; clearError() }">重試</button>
          </div>
        </template>
      </NuxtErrorBoundary>

      <p class="note">↑ 就算上面壞了，這行字與整頁其他部分都還在。</p>
    </section>
  </main>
</template>

<style>
body { margin: 0; font-family: -apple-system, "Segoe UI", sans-serif; background: #f9fafb; }
.wrap { max-width: 560px; margin: 0 auto; padding: 24px; line-height: 1.7; }
h2 { font-size: 18px; margin-top: 24px; }
.fallback { padding: 12px 16px; background: #fef2f2; border-radius: 10px; color: #b91c1c; }
.fallback button { margin-top: 8px; border: none; background: #b91c1c; color: #fff; border-radius: 8px; padding: 6px 12px; cursor: pointer; }
.note { color: #6b7280; font-size: 14px; }
</style>
```

跑起來後：

- `$formatDate` 把 ISO 時間變成好讀的本地格式（plugin 注入成功，全站可用）。
- 勾「讓小工具壞掉」→ 只有那一塊變成紅色 fallback，標題與其他內容不受影響。
- 按「重試」→ 小工具恢復正常（`clearError` 生效）。

---

## 本章結語

工程韌性補齊了。接下來兩章把「賣相」與「品質」做好：下一章講 **樣式與 UI 模組**——用 Tailwind、`@nuxt/image`、`@nuxt/fonts` 讓站又快又好看。
