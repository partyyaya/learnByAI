# 第 14 章：樣式與 UI（Tailwind、@nuxt/image、字型）

## 本章目標

完成這一章後，你應該可以：

1. 在 Nuxt 用三種層次管理 CSS：全域、scoped、CSS 變數（暗色模式）。
2. 安裝並使用 **Tailwind CSS** 模組寫 utility-first 樣式。
3. 用 **`@nuxt/image`** 的 `<NuxtImg>` / `<NuxtPicture>` 做自動最佳化的圖片。
4. 用 **`@nuxt/fonts`** 自動最佳化字型，避免版面跳動。
5. 知道 `@nuxt/ui`、`@nuxtjs/color-mode` 這類 UI 模組的定位。

---

## 1. CSS 的三種層次

### 全域 CSS

放在 `app/assets/css/`，在 `nuxt.config` 用 `css` 陣列引入：

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  css: ['~/assets/css/main.css'],
})
```

```css
/* app/assets/css/main.css */
:root { --brand: #00dc82; }
body { margin: 0; font-family: system-ui, sans-serif; }
```

> `~/` 指向 `app/`（Nuxt 4 srcDir）。`app/assets/` 的東西會經過 build 處理；`public/` 則是原樣輸出。

### Scoped 樣式（元件內）

元件內 `<style scoped>` 只作用於該元件，不會外洩（前面章節一直在用）：

```vue
<style scoped>
.card { border-radius: 12px; } /* 只影響這個元件的 .card */
</style>
```

### CSS 變數 + 暗色模式

用 CSS 變數搭 `data-theme`（呼應第 7 章的 `useTheme`），切換超輕量：

```css
:root[data-theme="light"] { --bg: #fff; --fg: #111; }
:root[data-theme="dark"]  { --bg: #111; --fg: #eee; }
body { background: var(--bg); color: var(--fg); }
```

---

## 2. Tailwind CSS

Tailwind 是 utility-first 框架：不寫 CSS 檔，直接在 class 組樣式。安裝模組：

```bash
npx nuxi module add @nuxtjs/tailwindcss
```

裝好後直接在模板用 class：

```vue
<template>
  <div class="max-w-xl mx-auto p-6">
    <h1 class="text-2xl font-bold text-gray-900">標題</h1>
    <p class="mt-2 text-gray-500">用 utility class 直接排版，不用另外寫 CSS。</p>
    <button class="mt-4 px-4 py-2 rounded-lg bg-emerald-500 text-white hover:bg-emerald-600">
      按鈕
    </button>
  </div>
</template>
```

常用心法：

- 版面：`flex`、`grid`、`gap-*`、`max-w-*`、`mx-auto`
- 間距：`p-*`（padding）、`m-*`（margin）、`space-y-*`
- 文字：`text-*`（大小/顏色）、`font-*`
- 響應式：`md:flex`、`lg:grid-cols-3`（前綴就是斷點）
- 狀態：`hover:`、`focus:`、`dark:`

> Tailwind 版本演進較快（v4 改用 Vite plugin + `@import "tailwindcss"` 的設定方式）。用 `nuxi module add` 裝的版本會幫你配好，class 用法基本不變；細節設定以你安裝版本的文件為準。

---

## 3. `@nuxt/image`：自動最佳化圖片

直接用 `<img>` 常見問題：檔案太大、沒有響應式尺寸、沒現代格式（WebP/AVIF）、載入時版面跳動。`@nuxt/image` 幫你處理這些：

```bash
npx nuxi module add image
```

用 `<NuxtImg>` 取代 `<img>`：

```vue
<template>
  <!-- 自動最佳化：可轉格式、依尺寸產生、lazy load -->
  <NuxtImg
    src="/photos/cover.jpg"
    alt="封面"
    width="800"
    height="450"
    loading="lazy"
    sizes="100vw md:800px"
    format="webp"
  />
</template>
```

- `src` 從 `public/` 起算（`/photos/cover.jpg` = `public/photos/cover.jpg`）。
- `width`/`height`：**一定要給**，保留空間避免版面跳動（CLS）。
- `sizes`：不同螢幕給不同寬度，Nuxt 產對應尺寸。
- `format`：輸出格式（`webp`、`avif`）。

**藝術導向**（不同螢幕換不同裁切）用 `<NuxtPicture>`（產出 `<picture>`）。

> 用外部網址的圖片，要在 `nuxt.config` 的 `image.domains` 允許該網域。本地 `public/` 圖片則直接可用。

---

## 4. `@nuxt/fonts`：字型自動最佳化

網頁字型常見問題：從 Google Fonts 載入慢、載入完字型時版面「跳一下」（FOUT）。`@nuxt/fonts` 會自動幫你把字型**自架、預載、加 fallback 尺寸**：

```bash
npx nuxi module add fonts
```

裝好後——**你什麼都不用改**，只要在 CSS 用 `font-family` 指定字型名稱，模組會自動去找（Google Fonts、Bunny 等）並最佳化：

```css
/* app/assets/css/main.css */
body { font-family: 'Noto Sans TC', sans-serif; }
h1 { font-family: 'Poppins', sans-serif; }
```

> 這是 Nuxt「約定優於設定」的好例子：裝上模組、正常寫 `font-family`，最佳化在背景自動發生。

---

## 5. UI 元件庫與暗色模式模組

不想自己刻按鈕、彈窗、表單元件？可用現成 UI 模組：

- **`@nuxt/ui`**：官方 UI 元件庫（基於 Tailwind + Reka UI），提供 `<UButton>`、`<UCard>`、`<UModal>` 等大量元件，含暗色模式。適合快速做出一致的介面。
- **`@nuxtjs/color-mode`**：專門處理亮/暗/跟隨系統的主題切換，提供 `useColorMode()`，自動處理 SSR 與 localStorage 記憶（比第 7 章自己用 `useState` 更完整）。

```bash
npx nuxi module add ui          # 需要整套元件時
npx nuxi module add color-mode  # 只需要主題切換時
```

```vue
<script setup>
const colorMode = useColorMode()
</script>

<template>
  <button @click="colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'">
    切換主題（目前 {{ colorMode.value }}）
  </button>
</template>
```

> 選型建議：**要一致又快** → `@nuxt/ui`；**只想要 Tailwind + 自己刻** → `@nuxtjs/tailwindcss`（+ 需要時加 `color-mode`）。本課範例走後者，保持透明。

---

## 6. 本章小練習

1. 建立 `app/assets/css/main.css` 放全域樣式與 CSS 變數，在 `nuxt.config` 引入。
2. 安裝 Tailwind，把某一頁用 utility class 重排，做出響應式（手機單欄、桌機多欄）。
3. 安裝 `@nuxt/image`，把 `<img>` 換成 `<NuxtImg>`，設好 `width`/`height`/`sizes`，用 Network 面板看是否 lazy load。
4. 安裝 `@nuxt/fonts`，指定一個 Google 字型，觀察載入後版面不跳動。
5. 安裝 `@nuxtjs/color-mode`，做一顆亮/暗切換鈕，重整後主題記憶還在。

---

## 最後範例：好看的文章卡片頁（Tailwind + NuxtImg）

> 用 Tailwind 排版、`<NuxtImg>` 放封面圖，做出響應式的文章卡片。先安裝 `@nuxtjs/tailwindcss` 與 `@nuxt/image`，並在 `public/covers/` 放三張圖（或改成你有的檔名）。

### `nuxt.config.ts`

```ts
export default defineNuxtConfig({
  modules: [
    '@nuxtjs/tailwindcss',
    '@nuxt/image',
  ],
})
```

### `app/pages/index.vue`

```vue
<script setup>
const posts = [
  { id: 1, title: 'Nuxt 是什麼', excerpt: '把 Vue 變成可上線的全端框架。', cover: '/covers/1.jpg' },
  { id: 2, title: '檔案式路由', excerpt: 'app/pages/ 底下放檔案就是網址。', cover: '/covers/2.jpg' },
  { id: 3, title: '資料抓取', excerpt: 'useFetch 在伺服器就把資料抓好。', cover: '/covers/3.jpg' },
]
</script>

<template>
  <main class="max-w-4xl mx-auto p-6">
    <h1 class="text-3xl font-bold text-gray-900 mb-6">最新文章</h1>

    <!-- 手機一欄、平板兩欄、桌機三欄 -->
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      <article
        v-for="p in posts"
        :key="p.id"
        class="rounded-2xl overflow-hidden bg-white shadow-sm hover:shadow-md transition-shadow"
      >
        <NuxtImg
          :src="p.cover"
          :alt="p.title"
          width="400"
          height="240"
          sizes="100vw md:400px"
          format="webp"
          loading="lazy"
          class="w-full h-40 object-cover"
        />
        <div class="p-4">
          <h2 class="font-semibold text-lg text-gray-900">{{ p.title }}</h2>
          <p class="mt-1 text-sm text-gray-500">{{ p.excerpt }}</p>
          <NuxtLink
            :to="`/posts/${p.id}`"
            class="inline-block mt-3 text-emerald-600 font-medium hover:underline"
          >
            閱讀更多 →
          </NuxtLink>
        </div>
      </article>
    </div>
  </main>
</template>
```

跑起來後：

- 縮放視窗 → 卡片從一欄變兩欄、三欄（Tailwind 響應式前綴）。
- 封面圖經 `@nuxt/image` 最佳化（Network 面板可看到轉成 webp、依尺寸產生、lazy load）。
- 全程沒寫任何 `.css` 檔（Tailwind utility class 全包）。

> 若你沒有圖檔，先隨便放三張 jpg 到 `public/covers/`，或把 `src` 換成允許網域的外部圖片網址（記得在 `nuxt.config` 的 `image.domains` 加上該網域）。

---

## 本章結語

站又快又好看了。最後兩章收尾：下一章把**效能、快取與測試**做好——讓站在真實流量下又穩又快，並用測試守住品質；第 16 章部署上線並完成期末專題。
