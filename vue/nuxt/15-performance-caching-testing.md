# 第 15 章：效能優化、快取與測試

## 本章目標

完成這一章後，你應該可以：

1. 用「延遲水合（lazy hydration）」延後非首屏元件的互動化，縮小首包負擔。
2. 用 `<NuxtLink>` prefetch 與 Lazy 元件控制載入時機。
3. 用 Nitro 的 `defineCachedEventHandler` / `defineCachedFunction` 快取伺服器運算。
4. 複習 `routeRules` 與 `useFetch` 的快取策略，知道各自的定位。
5. 用 `@nuxt/test-utils` + Vitest 寫元件單元測試與端對端（E2E）測試。

---

## 1. 效能的三個著力點

Nuxt 效能大致從三處下手：

1. **少送、晚送 JS 到瀏覽器**（延遲水合、Lazy 元件、prefetch 控制）。
2. **少算、快回**（伺服器端快取：`routeRules`、`cachedEventHandler`）。
3. **少抓、不重抓**（`useFetch` 去重與快取，第 6 章）。

前四章其實已鋪好一半：`routeRules`（第 5 章）、`useFetch` 去重（第 6 章）、`<NuxtImg>` 與 Lazy 元件（第 4、14 章）。本章補上剩下的。

---

## 2. 延遲水合（Lazy Hydration）

回顧第 1 章：SSR 送出 HTML 後，瀏覽器要下載 JS 做 **hydration** 才能互動。頁面越大，一次性 hydrate 越慢。**延遲水合**讓非首屏元件「晚一點」才 hydrate。

在 `Lazy` 元件上加水合策略 props（Nuxt 4 內建）：

```vue
<template>
  <!-- 進入可視範圍才 hydrate（頁尾、下方卡片最適合） -->
  <LazyHeavyComments hydrate-on-visible />

  <!-- 瀏覽器閒置時才 hydrate -->
  <LazyRelatedPosts hydrate-on-idle />

  <!-- 使用者互動（點擊/hover）才 hydrate -->
  <LazyCommentBox hydrate-on-interaction="click" />

  <!-- 延遲固定毫秒 -->
  <LazyNewsletter :hydrate-after="3000" />

  <!-- 永不 hydrate（純靜態展示、無互動） -->
  <LazyStaticFooter hydrate-never />
</template>
```

| 策略 | 何時 hydrate | 適合 |
|---|---|---|
| `hydrate-on-visible` | 捲到看得見 | 下方卡片、留言區 |
| `hydrate-on-idle` | 瀏覽器閒置 | 次要 widget |
| `hydrate-on-interaction` | 使用者互動 | 需點開才用的元件 |
| `hydrate-after` | 固定延遲 | 可晚出現的東西 |
| `hydrate-never` | 從不 | 純靜態、零互動 |

> 心法：**首屏、要立刻互動的**照常；**在下面、次要、要互動才用的**加延遲水合。這能明顯改善 TTI（可互動時間）。

---

## 3. Prefetch 與 Lazy 元件

- **`<NuxtLink>` 預設會 prefetch**：連結進到可視範圍時，先偷偷抓好目標頁的 JS，點下去近乎瞬間。太多連結想省流量時可 `:prefetch="false"`。
- **Lazy 元件**（第 4 章）：`<LazyXxx v-if="...">` 讓重元件用到才下載，縮小首包。
- 兩者搭配延遲水合，就是「該早的早、該晚的晚」。

---

## 4. Nitro 伺服器端快取

有些 API 很貴（複雜查詢、打第三方）。用 `defineCachedEventHandler` 把結果快取一段時間，期間直接回快取、不重算：

```js
// server/api/stats.get.js
export default defineCachedEventHandler(
  async () => {
    // 假設這是一個很貴的統計查詢
    const total = await prisma.post.count()
    return { total, computedAt: new Date().toISOString() }
  },
  {
    maxAge: 60,        // 快取 60 秒
    name: 'stats',
    getKey: () => 'all', // 快取 key（可依 query 產生不同 key）
  },
)
```

也能快取「任意函式」（不限 event handler）用 `defineCachedFunction`：

```js
// server/utils/getRates.js
export const getRates = defineCachedFunction(
  async () => {
    return await $fetch('https://api.example.com/rates') // 貴的外部呼叫
  },
  { maxAge: 300, name: 'rates', getKey: () => 'latest' },
)
```

> `routeRules` 的 `swr`（第 5 章）是快取**整頁 HTML**；`defineCachedEventHandler` 是快取**單支 API 的回傳**。前者給頁面、後者給資料端點，常一起用。

---

## 5. 快取策略速查

| 想快取的東西 | 用什麼 | 章節 |
|---|---|---|
| 整頁 HTML | `routeRules: { swr / isr / prerender }` | 5 |
| 單支 API 回傳 | `defineCachedEventHandler` | 本章 |
| 任意貴函式 | `defineCachedFunction` | 本章 |
| 同頁多元件抓同資料 | `useFetch` 同 key 自動去重 | 6 |
| 圖片 | `@nuxt/image` | 14 |

---

## 6. 測試環境：@nuxt/test-utils + Vitest

Nuxt 官方測試工具搭 Vitest。安裝：

```bash
npm install -D @nuxt/test-utils vitest @vue/test-utils happy-dom playwright-core
```

建立 `vitest.config.ts`，用 Nuxt 提供的設定（讓測試能用自動匯入、Nuxt runtime）：

```ts
// vitest.config.ts
import { defineVitestConfig } from '@nuxt/test-utils/config'

export default defineVitestConfig({
  test: {
    environment: 'nuxt', // 在 Nuxt 環境跑測試
  },
})
```

在 `package.json` 加指令：

```json
{
  "scripts": {
    "test": "vitest"
  }
}
```

---

## 7. 單元測試：composable 與元件

**測 composable**（純邏輯，最好測）：

```js
// tests/useCounter.spec.js
import { describe, it, expect } from 'vitest'
import { useCounter } from '~/composables/useCounter'

describe('useCounter', () => {
  it('inc 會加一', () => {
    const { count, inc } = useCounter(0)
    inc()
    expect(count.value).toBe(1)
  })
})
```

**測元件**：用 `mountSuspended`（支援 async setup 與自動匯入）：

```js
// tests/PostCard.spec.js
import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import PostCard from '~/components/PostCard.vue'

describe('PostCard', () => {
  it('顯示標題', async () => {
    const wrapper = await mountSuspended(PostCard, {
      props: { title: 'Hello Nuxt' },
    })
    expect(wrapper.text()).toContain('Hello Nuxt')
  })
})
```

---

## 8. E2E 測試：跑真的 Nuxt

E2E 會真的啟動一個 Nuxt 伺服器，測整條路徑。用 `@nuxt/test-utils/e2e`：

```js
// tests/e2e/home.spec.js
import { describe, it, expect } from 'vitest'
import { setup, $fetch } from '@nuxt/test-utils/e2e'

describe('首頁 (E2E)', async () => {
  // 啟動一個測試用的 Nuxt 實例
  await setup({ /* 可指定 rootDir、build 選項 */ })

  it('首頁 HTML 含站名', async () => {
    const html = await $fetch('/')       // 打真的伺服器，拿 SSR 後的 HTML
    expect(html).toContain('My Blog')
  })

  it('API 回傳文章陣列', async () => {
    const posts = await $fetch('/api/posts')
    expect(Array.isArray(posts)).toBe(true)
  })
})
```

> 分工：**單元測試**跑得快，測邏輯與單一元件；**E2E** 較慢，測「SSR 是否真的輸出正確、API 是否真的通」。日常多寫單元、關鍵路徑補 E2E。

---

## 9. 本章小練習

1. 把頁面下方一個重元件改成 `<Lazy... hydrate-on-visible />`，用 DevTools Performance 觀察 hydration 變化。
2. 幫一支貴的 API 加 `defineCachedEventHandler`，連打多次看 `computedAt` 是否在 `maxAge` 內不變。
3. 設好 Vitest，替第 4 章的 `useCounter` 寫單元測試並 `npm run test` 通過。
4. 用 `mountSuspended` 測一個會顯示 props 的元件。
5. 寫一個 E2E 測試，確認 `/api/posts` 回陣列。

---

## 最後範例：快取的統計 API + 一支通過的測試

> 示範 Nitro 快取與最基本的測試設定。先完成第 6 節安裝與 `vitest.config.ts`。

### `server/api/stats.get.js`

```js
// 假設統計很貴，快取 10 秒
export default defineCachedEventHandler(
  async () => {
    // 這裡用假運算代表「很貴」；實務可能是 DB 聚合或第三方呼叫
    let sum = 0
    for (let i = 0; i < 1e6; i++) sum += i
    return { sum, computedAt: new Date().toISOString() }
  },
  { maxAge: 10, name: 'stats', getKey: () => 'all' },
)
```

### `app/pages/index.vue`

```vue
<script setup>
const { data, refresh } = await useFetch('/api/stats')
</script>

<template>
  <main class="wrap">
    <h1>My Blog</h1>
    <p>統計計算時間：<code>{{ data.computedAt }}</code></p>
    <button @click="refresh()">重新抓取</button>
    <p class="hint">10 秒內連按「重新抓取」，時間不會變（吃 Nitro 快取）；過 10 秒才更新。</p>
  </main>
</template>

<style>
body { margin: 0; font-family: -apple-system, "Segoe UI", sans-serif; }
.wrap { max-width: 520px; margin: 40px auto; padding: 0 20px; line-height: 1.7; }
button { padding: 8px 16px; border: none; border-radius: 10px; background: #00dc82; color: #062; font-weight: 600; cursor: pointer; }
.hint { color: #6b7280; font-size: 14px; }
</style>
```

### `vitest.config.ts`

```ts
import { defineVitestConfig } from '@nuxt/test-utils/config'

export default defineVitestConfig({
  test: { environment: 'nuxt' },
})
```

### `tests/e2e/stats.spec.js`

```js
import { describe, it, expect } from 'vitest'
import { setup, $fetch } from '@nuxt/test-utils/e2e'

describe('stats API', async () => {
  await setup()

  it('回傳含 sum 與 computedAt', async () => {
    const data = await $fetch('/api/stats')
    expect(data).toHaveProperty('sum')
    expect(data).toHaveProperty('computedAt')
  })

  it('10 秒內兩次呼叫拿到相同快取', async () => {
    const a = await $fetch('/api/stats')
    const b = await $fetch('/api/stats')
    expect(a.computedAt).toBe(b.computedAt) // 命中快取，時間相同
  })
})
```

跑起來後：

- 首頁連按「重新抓取」，`computedAt` 在 10 秒內不變（Nitro 快取命中）。
- `npm run test` → 兩個 E2E 測試通過，證明 API 正常且快取生效。

---

## 本章結語

你的站現在又快又穩、還有測試守門。只剩最後一步：**上線**。下一章講部署（各種 Nitro preset、`build` vs `generate`），並把前面 15 章的能力整合成期末專題——一個可實跑的**全端部落格 `blog-demo/`**。
