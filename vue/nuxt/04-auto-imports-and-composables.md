# 第 4 章：自動匯入、Composables 與 ClientOnly

## 本章目標

完成這一章後，你應該可以：

1. 說出 Nuxt 幫你自動匯入了哪些東西（Vue API、Nuxt composable、你自己的元件/函式）。
2. 依命名規則放置 `app/components/`，並用 `Lazy` 前綴做延遲載入。
3. 寫出自己的 composable，放進 `app/composables/` 被自動匯入。
4. 用 `<ClientOnly>` 與 `import.meta.client` 處理「只能在瀏覽器跑」的程式碼，避開 hydration 錯誤。

---

## 1. 你其實一直在用自動匯入

前三章我們用了 `ref`、`useRoute`、`NuxtLink`、`posts`、`findPost`，卻**從來沒寫過 `import`**。這不是魔法，是 Nuxt 的自動匯入（auto-imports）。它幫你自動匯入三類東西：

| 類別 | 例子 | 來源 |
|---|---|---|
| Vue 的 API | `ref`、`computed`、`watch`、`onMounted`、`reactive` | Vue |
| Nuxt 的 composable | `useRoute`、`useRouter`、`useState`、`useFetch`、`useHead`、`navigateTo`、`createError` | Nuxt |
| **你自己寫的** | `app/components/`、`app/composables/`、`app/utils/` 底下的東西 | 你的專案 |

好處是少寫一堆 import、重構搬檔案不用改 import 路徑；DevTools 也看得到誰被自動匯入。

> 什麼時候還是要手動 import？外部 npm 套件（例如 `import dayjs from 'dayjs'`）要自己 import。Nuxt 只自動匯入「Vue / Nuxt / 你 `app/` 底下約定目錄」的東西。

### 想手動 import 也可以

自動匯入是「可以不寫」，不是「不能寫」。若你想明確一點，可從 `#imports` 匯入：

```js
import { ref, computed } from '#imports'
```

---

## 2. 元件自動匯入：`app/components/`

放進 `app/components/` 的 `.vue` 檔會被自動註冊成全域元件，用**路徑 + 檔名**決定標籤名：

```text
app/components/
├─ TheHeader.vue              → <TheHeader />
├─ PostCard.vue               → <PostCard />
└─ blog/
   └─ SideBar.vue             → <BlogSideBar />   （資料夾名會變前綴）
```

用的時候直接寫標籤，不用 import：

```vue
<template>
  <TheHeader />
  <PostCard :title="'Hello'" />
  <BlogSideBar />
</template>
```

> 資料夾名會變前綴，避免撞名。`blog/SideBar.vue` → `<BlogSideBar>`，不是 `<SideBar>`。這也是為什麼很多專案愛用 `TheHeader`、`AppFooter` 這種前綴，一眼看出是全站唯一或共用元件。

---

## 3. 延遲載入元件：`Lazy` 前綴

在任何自動匯入的元件名前面加 `Lazy`，Nuxt 就會把它**獨立打包、用到才載入**（code-splitting）。適合「一開始不一定會出現」的重元件，例如彈窗、圖表：

```vue
<script setup>
const showChart = ref(false)
</script>

<template>
  <button @click="showChart = true">顯示圖表</button>

  <!-- 只有 showChart 為 true 時，才會真的去下載 HeavyChart 的 JS -->
  <LazyHeavyChart v-if="showChart" />
</template>
```

`<HeavyChart>` 與 `<LazyHeavyChart>` 指的是**同一個元件**（`app/components/HeavyChart.vue`），差別只在載入時機。

> 判斷準則：**首屏一定會用到的**，用一般寫法；**條件才出現、或很重的**，用 `Lazy` 省首包大小。

---

## 4. 寫你自己的 composable：`app/composables/`

Composable 就是「以 `use` 開頭、把一段可重用邏輯 + 狀態包起來的函式」。放進 `app/composables/`，它會被自動匯入，任何元件都能直接呼叫。

先看一個最單純的（**注意：這種每次呼叫都建立新狀態**）：

```js
// app/composables/useCounter.js
export function useCounter(initial = 0) {
  const count = ref(initial)
  const inc = () => count.value++
  const dec = () => count.value--
  const reset = () => (count.value = initial)
  return { count, inc, dec, reset }
}
```

在任兩個元件裡使用：

```vue
<script setup>
const { count, inc } = useCounter(10)
</script>

<template>
  <button @click="inc">count = {{ count }}</button>
</template>
```

每個元件呼叫 `useCounter()` 都會拿到**自己獨立的 `count`**——這正是元件內部狀態該有的行為。

> 檔案可以放多個 composable，但慣例是「一個 composable 一個檔、檔名對應主函式名」。`app/composables/` 只會自動掃**第一層**檔案；要巢狀請自行設定或用 index 匯出。

---

## 5. 想「跨元件共享同一份狀態」？先認識 `useState`

上面的 `useCounter` 每次呼叫都是新狀態。如果你想要「A 元件改了、B 元件也看到」的**共享**狀態，直覺可能是把 `ref` 提到模組最外層：

```js
// ❌ 在 SSR 會出事：這個 ref 會被所有使用者的請求共用！
const count = ref(0)
export function useSharedCounter() {
  return { count }
}
```

在純前端 SPA 這樣可行，但 Nuxt 有 SSR——**伺服器是一個長期執行的程序，同一個模組層級的 `ref` 會被不同使用者的請求共用**，造成資料串到別人身上。正確做法是用 Nuxt 的 `useState`：

```js
// app/composables/useSharedCounter.js
export function useSharedCounter() {
  // 用同一個 key，跨元件、跨頁面共享；且每個請求各自隔離，SSR 安全
  const count = useState('shared-counter', () => 0)
  const inc = () => count.value++
  return { count, inc }
}
```

- `useState(key, init)`：第一個參數是**唯一 key**，第二個是初始值工廠函式。
- 相同 key 在任何元件取到的都是**同一份**狀態。
- 它在伺服器算好的值會被序列化到 HTML，client hydration 時直接沿用，不會閃動或重算。

> 這裡先建立「共享狀態要用 `useState`、不要用模組層級 `ref`」的直覺。完整的狀態管理（含 Pinia）留到第 7 章。

---

## 6. `<ClientOnly>`：只在瀏覽器跑的東西

回到第 1 章的心智模型：元件會在**伺服器跑一次**、**瀏覽器再跑一次**。如果某段程式碼在伺服器根本不存在（例如 `window`、`localStorage`、`new Date()` 當下時間），就會出兩種問題：

1. 伺服器直接報錯（`window is not defined`）。
2. 伺服器算出的 HTML 和瀏覽器算出的**對不起來**，出現 **hydration mismatch** 警告，畫面會閃一下。

解法一：用 `<ClientOnly>` 包起來，這段只在瀏覽器渲染：

```vue
<template>
  <ClientOnly>
    <!-- 只有瀏覽器會渲染這段，伺服器會跳過 -->
    <p>視窗寬度：{{ width }}px</p>

    <!-- SSR 期間 / 還沒 hydrate 時，顯示 fallback，避免版面跳動 -->
    <template #fallback>
      <p>量測中…</p>
    </template>
  </ClientOnly>
</template>

<script setup>
const width = ref(0)
onMounted(() => {
  // onMounted 只在瀏覽器觸發，這裡用 window 是安全的
  width.value = window.innerWidth
})
</script>
```

解法二：用 `import.meta.client` / `import.meta.server` 做環境判斷：

```js
if (import.meta.client) {
  // 只在瀏覽器執行
  const saved = localStorage.getItem('token')
}
```

> 判斷準則：**只是「這段 UI 只在前端顯示」** → 用 `<ClientOnly>`；**「這段邏輯只在某一端執行」** → 用 `import.meta.client` / `import.meta.server`。碰到 `window`、`document`、`localStorage`、隨機值、當下時間，先想到這兩招。

---

## 7. 本章小練習

1. 把第 3 章的頁首抽成 `app/components/TheHeader.vue`，在 `default.vue` 直接用 `<TheHeader />`（不 import）。
2. 寫一個 `app/composables/useToggle.js`（回傳 `state` 與 `toggle`），在兩個元件用它，確認彼此獨立。
3. 把 `useToggle` 改用 `useState` 共享，觀察兩個元件變成連動。
4. 做一個顯示「目前時間」的區塊，先不包 `<ClientOnly>` 看 console 的 hydration 警告，再包起來看警告消失。

---

## 最後範例：可重用元件 + 共享狀態 + ClientOnly 時鐘

> 一個示範三大主題的可跑頁面：自動匯入的元件、`useState` 共享的計數器、`<ClientOnly>` 的即時時鐘。原樣建立以下檔案即可。

### `app/composables/useSharedCounter.js`

```js
// 用 useState 做「跨元件共享 + SSR 安全」的計數器
export function useSharedCounter() {
  const count = useState('demo-counter', () => 0)
  const inc = () => count.value++
  const dec = () => count.value--
  return { count, inc, dec }
}
```

### `app/components/CounterButton.vue`

```vue
<script setup>
// 兩個地方用它，會共享同一個 count（因為底層是 useState 同一個 key）
const { count, inc } = useSharedCounter()
const props = defineProps({ label: String })
</script>

<template>
  <button class="counter" @click="inc">
    {{ label }}：{{ count }}
  </button>
</template>

<style scoped>
.counter {
  padding: 8px 16px; margin: 4px;
  border: none; border-radius: 10px;
  background: #00dc82; color: #062; font-weight: 600; cursor: pointer;
}
.counter:hover { background: #00b86b; }
</style>
```

### `app/components/LiveClock.vue`

```vue
<script setup>
// 目前時間在 server / client 一定不同 → 只能在瀏覽器算，否則 hydration mismatch
const now = ref('')
let timer

onMounted(() => {
  const update = () => (now.value = new Date().toLocaleTimeString())
  update()
  timer = setInterval(update, 1000)
})

onUnmounted(() => clearInterval(timer)) // 記得清掉計時器
</script>

<template>
  <span class="clock">🕒 {{ now }}</span>
</template>

<style scoped>
.clock { font-variant-numeric: tabular-nums; color: #111827; }
</style>
```

### `app/pages/index.vue`

```vue
<script setup>
const showChart = ref(false)
</script>

<template>
  <section class="wrap">
    <h1>自動匯入 / Composable / ClientOnly 示範</h1>

    <h2>1. 自動匯入的元件 + useState 共享狀態</h2>
    <p>下面兩顆按鈕在不同位置，但共享同一個計數（試著各點幾下）：</p>
    <CounterButton label="按鈕 A" />
    <CounterButton label="按鈕 B" />

    <h2>2. ClientOnly 即時時鐘</h2>
    <p>時間只能在瀏覽器算，用 ClientOnly 包起來避免 hydration 錯誤：</p>
    <ClientOnly>
      <LiveClock />
      <template #fallback><span>時鐘載入中…</span></template>
    </ClientOnly>

    <h2>3. Lazy 元件（用到才載入）</h2>
    <button class="link" @click="showChart = !showChart">
      {{ showChart ? '收起' : '展開' }}延遲載入區塊
    </button>
    <LazyDemoPanel v-if="showChart" />
  </section>
</template>

<style scoped>
.wrap { font-family: -apple-system, "Segoe UI", sans-serif; line-height: 1.7; }
h2 { margin-top: 28px; font-size: 18px; }
.link { background: none; border: 1px dashed #9ca3af; border-radius: 8px; padding: 6px 12px; cursor: pointer; }
</style>
```

### `app/components/DemoPanel.vue`

```vue
<!-- 被 <LazyDemoPanel> 延遲載入的元件；打開 Network 面板可看到點按鈕才下載它的 JS -->
<template>
  <div class="panel">
    <p>我是被延遲載入的內容，首屏其實沒載我。</p>
  </div>
</template>

<style scoped>
.panel { margin-top: 12px; padding: 16px; background: #eff6ff; border-radius: 12px; color: #1d4ed8; }
</style>
```

跑起來後：

- 點「按鈕 A」再點「按鈕 B」→ 兩顆數字**同步增加**，證明 `useState` 共享成功。
- 時鐘每秒跳動，且 console **沒有** hydration 警告（因為包在 `<ClientOnly>`）。
- 打開 Network 面板，點「展開」時才會看到 `DemoPanel` 的 JS 被下載，證明 `Lazy` 生效。
- 全程沒有寫任何 `import`（元件、composable、`ref`、`onMounted` 都是自動匯入）。

---

## 本章結語

你已經掌握 Nuxt 的「少寫 import、邏輯抽 composable、瀏覽器專屬用 ClientOnly」三件事，也初嘗了 `useState`。
到目前為止我們的頁面都是 SSR 預設行為。下一章正式把 **渲染模式（SSR / SPA / SSG / Hybrid）與 `routeRules`** 講清楚，讓你能針對每一條路由選最適合的產出方式。
