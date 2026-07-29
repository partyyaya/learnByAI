# 第 5 章：生命週期與 Composables

前四章你已經會用 `ref`/`reactive`/`computed`/`watch` 管理狀態，也會用 `props`/`emit`/`v-model`/`slots` 讓元件互相溝通。但真實應用還缺兩塊拼圖：一是「在對的時機做對的事」——什麼時候該去操作 DOM、發第一次請求、清掉計時器；二是「把重複的邏輯抽出來重用」——這正是 Vue 3 組合式 API 最大的賣點。

這一章我們把這兩件事講透。學完後，你就具備了把畫面邏輯「組織成可維護、可重用的單位」的能力，這也是後面《源碼課》與《Nuxt 全端課》都預設你已經內化的心智模型。

## 本章目標

完成這一章後，你應該可以：

1. 說出元件從建立到銷毀會經過哪些階段，並在對的生命週期 hook 做對的事。
2. 解釋組合式 API 與選項式 API 的差異，以及為什麼本課用組合式。
3. 用 template ref（`useTemplateRef` 或傳統 `ref`）取得 DOM 與子元件，並用 `defineExpose` 對外開放子元件方法。
4. 知道 `nextTick` 在什麼情況下不可或缺。
5. 把一段有狀態、有副作用的邏輯抽成 `useXxx` composable 並在多個元件重用。
6. 用 React custom hook 的經驗對照 Vue composable，並理解「為什麼 Vue 不需要依賴陣列」。

---

## 1. 心智模型：一個元件的一生

一個元件從出現到消失，會經過幾個固定階段。你不需要背，但要知道「每個階段能安全做什麼事」：

```text
建立 setup() ─▶ 掛載到畫面 ─▶ 資料變動時反覆更新 ─▶ 從畫面移除
   (無 DOM)        (有 DOM)         (DOM 重繪)          (清理)
```

- `<script setup>` 的程式碼**本身**就相當於 `setup()`，在元件「建立階段」執行一次。此時**還沒有 DOM**。
- 之後每個階段，Vue 都給你一個對應的 hook 讓你插入程式碼。

如果你寫過 React：這些 hook 大致就是把 `useEffect` 拆成「掛載時」「更新時」「卸載時」等更明確的時機點，各自有獨立的函式名稱，語意比一個 `useEffect` + 依賴陣列更直白。

---

## 2. 組合式 API vs 選項式 API：本課為什麼用組合式

Vue 有兩種寫元件的風格。先看同一個「計數器」兩種寫法的對照：

**選項式 API（Options API）**——把程式碼依「種類」放進 `data`/`computed`/`methods`/`mounted` 等選項：

```vue
<script>
export default {
  data() {
    return { count: 0 }
  },
  computed: {
    double() {
      return this.count * 2
    },
  },
  methods: {
    add() {
      this.count++
    },
  },
  mounted() {
    console.log('已掛載')
  },
}
</script>
```

**組合式 API（Composition API）+ `<script setup>`**——把程式碼依「功能」組織，用函式呼叫組合起來：

```vue
<script setup>
import { ref, computed, onMounted } from 'vue'

const count = ref(0)
const double = computed(() => count.value * 2)
function add() {
  count.value++
}
onMounted(() => console.log('已掛載'))
</script>
```

差別與取捨：

| 面向 | 選項式 API | 組合式 API（本課採用） |
|------|-----------|----------------------|
| 程式碼組織 | 依「種類」拆（所有狀態在 `data`、所有方法在 `methods`） | 依「功能」聚（一個功能的狀態＋邏輯放一起） |
| 邏輯重用 | mixins（易命名衝突、來源不明） | composable 函式（清楚、可組合） |
| `this` | 需要靠 `this` 存取 | 沒有 `this`，就是普通變數與函式 |
| 與 TypeScript | 型別推導較彎繞 | 型別推導自然 |
| 適合 | 小元件、Vue 2 遷移 | 中大型、邏輯要重用（現代 Vue 主流） |

> 本課全程用組合式 API + `<script setup>`。原因很單純：**當元件一大，選項式會把「同一個功能」的程式碼拆散到四五個選項裡，讀起來要上下跳；組合式讓相關邏輯聚在一起，還能整段抽成 composable 重用。** 這也是 Nuxt、VueUse 等生態的預設寫法。

---

## 3. 生命週期 hooks

在 `<script setup>` 裡，直接從 `vue` import 對應的 hook 並傳入一個回呼即可。它們必須在 `setup` 同步執行期間註冊（不能包在 `setTimeout` 或 `await` 之後）。

| Hook | 觸發時機 | 典型用途 |
|------|---------|---------|
| `onBeforeMount` | DOM 建立前 | 幾乎用不到；此時還讀不到 DOM |
| `onMounted` | DOM 掛載完成後 | 讀取/操作 DOM、發第一次請求、初始化第三方套件、加事件監聽 |
| `onBeforeUpdate` | 資料變了、DOM 重繪前 | 在畫面更新前記下舊的 DOM 狀態（如捲動位置） |
| `onUpdated` | DOM 因資料變動重繪後 | 需要「更新後的 DOM」才做的事（少用，小心無限迴圈） |
| `onBeforeUnmount` | 元件移除前 | 準備清理（此時 DOM 還在） |
| `onUnmounted` | 元件已移除 | **清理副作用**：清計時器、移除事件監聽、關閉連線 |

還有一個進階的 `onErrorCaptured`：可捕捉「子孫元件」拋出的錯誤，常用來做區域性的錯誤邊界，這裡先知道有這東西即可。

一個把常用 hook 都示範到的例子：

```vue
<script setup>
import { ref, onMounted, onUnmounted } from 'vue'

const seconds = ref(0)
let timer = null

onMounted(() => {
  // DOM 已就緒：這裡才適合發請求、操作 DOM、起計時器
  timer = setInterval(() => {
    seconds.value++
  }, 1000)
})

onUnmounted(() => {
  // 元件被移除時清掉計時器，否則會記憶體洩漏、背景還在跑
  clearInterval(timer)
})
</script>

<template>
  <p>元件已存活 {{ seconds }} 秒</p>
</template>
```

### 與 React `useEffect` 對照

| React | Vue 3 |
|-------|-------|
| `useEffect(fn, [])` | `onMounted(fn)` |
| `useEffect` 回傳的 cleanup 函式 | `onUnmounted(fn)` |
| `useEffect(fn, [dep])`（依賴變才跑） | `watch(dep, fn)`（第 2 章學過） |

> 心法差異：React 用**一個** `useEffect` + 依賴陣列涵蓋「掛載/更新/卸載」；Vue 把時機拆成**多個具名 hook**，各司其職。「依賴變化才做事」在 Vue 不靠生命週期，而是靠 `watch`/`watchEffect`（響應式自動追蹤，見第 6 節）。

---

## 4. Template refs：取得 DOM 與子元件

大多數時候你用資料驅動畫面，不該直接碰 DOM。但有些事非碰不可：聚焦輸入框、量元素尺寸、串接需要真實 DOM 節點的第三方套件（圖表、地圖）。這時用 **template ref**。

### 4.1 Vue 3.5 寫法：`useTemplateRef`

Vue 3.5 起建議用 `useTemplateRef`，傳入 template 裡 `ref` 屬性的字串名稱：

```vue
<script setup>
import { useTemplateRef, onMounted } from 'vue'

// 參數字串要對應下面 <input ref="search">
const inputRef = useTemplateRef('search')

onMounted(() => {
  // DOM 掛載後才拿得到，所以放在 onMounted
  inputRef.value.focus()
})
</script>

<template>
  <input ref="search" placeholder="頁面一載入就自動聚焦" />
</template>
```

### 4.2 傳統寫法（3.5 之前，仍可用）

宣告一個同名的 `ref(null)`，`template` 的 `ref` 屬性寫上「同一個變數名」：

```vue
<script setup>
import { ref, onMounted } from 'vue'

const inputRef = ref(null)
onMounted(() => inputRef.value.focus())
</script>

<template>
  <input ref="inputRef" placeholder="頁面一載入就自動聚焦" />
</template>
```

> 重點：**在 `setup` 同步階段，template ref 還是 `null`；要等 `onMounted` 之後才拿得到 DOM。** 這對應 React 的 `useRef` + 「在 effect 裡讀 `ref.current`」。

### 4.3 取得子元件、`defineExpose` 對外開放

把 `ref` 放在子元件上，就能拿到子元件實例。但用 `<script setup>` 的子元件預設是「封閉」的——父層讀不到它內部的東西，除非子元件用 `defineExpose` 明確開放：

```vue
<!-- components/Counter.vue（子元件）-->
<script setup>
import { ref } from 'vue'

const count = ref(0)
function increment() {
  count.value++
}
function reset() {
  count.value = 0
}

// 只有這裡列出來的，父層才拿得到
defineExpose({ count, reset })
</script>

<template>
  <button @click="increment">子元件內部計數：{{ count }}</button>
</template>
```

```vue
<!-- App.vue（父元件）-->
<script setup>
import { useTemplateRef } from 'vue'
import Counter from './components/Counter.vue'

const counter = useTemplateRef('counter')

function resetChild() {
  // reset 有被 defineExpose，這裡才叫得到
  counter.value.reset()
}
</script>

<template>
  <Counter ref="counter" />
  <button @click="resetChild">從父層重置子元件</button>
</template>
```

> 提醒：能用 `props`/`emit`/`v-model`（第 4 章）解決的，就別用 `ref` 直接操控子元件。`defineExpose` 保留給「命令式操作」的少數場景——例如叫一個 `<VideoPlayer>` 子元件 `play()`。

---

## 5. `nextTick`：等 DOM 更新完再做事

Vue 的 DOM 更新是**非同步、批次**的：你改了資料，Vue 不會馬上重繪，而是把更新排進佇列、在下一個 tick 一次做完。所以「改完資料，同一行馬上去讀 DOM」會讀到**舊的**。

`nextTick()` 回傳一個 Promise，`await` 它就能等到「DOM 已依最新資料更新完成」：

```vue
<script setup>
import { ref, nextTick, useTemplateRef } from 'vue'

const messages = ref(['第一則'])
const box = useTemplateRef('box')

async function send() {
  messages.value.push(`第 ${messages.value.length + 1} 則`)

  // 此刻 DOM 還沒長出新的一列，box 的 scrollHeight 還是舊的
  await nextTick()

  // 現在新列已經在 DOM 裡了，捲到底才會正確
  box.value.scrollTop = box.value.scrollHeight
}
</script>

<template>
  <div ref="box" style="height: 80px; overflow: auto; border: 1px solid #ccc">
    <p v-for="(m, i) in messages" :key="i">{{ m }}</p>
  </div>
  <button @click="send">送出並捲到底</button>
</template>
```

> 什麼時候需要它？**改了資料、又要立刻根據「更新後的畫面」去量尺寸/捲動/聚焦新出現的元素**時。其他情況幾乎用不到。

---

## 6. 把邏輯抽成 Composable（`useXxx`）

這是本章的重頭戲，也是組合式 API 的靈魂。**Composable 就是一個「會用到響應式狀態或生命週期」的普通函式**，慣例以 `use` 開頭。它讓你把「一段有狀態、有副作用的邏輯」抽出來，在任意元件重用。

如果你寫過 React：composable ≈ custom hook。差別在**依賴追蹤**——稍後對照。

### 6.1 第一個 composable：`useMouse`

先看內嵌版，體會「回傳 ref、內部自己註冊/清理副作用」：

```vue
<script setup>
import { ref, onMounted, onUnmounted } from 'vue'

function useMouse() {
  const x = ref(0)
  const y = ref(0)

  function update(e) {
    x.value = e.pageX
    y.value = e.pageY
  }

  onMounted(() => window.addEventListener('mousemove', update))
  onUnmounted(() => window.removeEventListener('mousemove', update))

  // 回傳響應式狀態，讓使用它的元件能綁到畫面
  return { x, y }
}

const { x, y } = useMouse()
</script>

<template>
  <p>滑鼠位置：{{ x }}, {{ y }}</p>
</template>
```

真正的價值是「抽成獨立檔案、多處重用」。把它搬到 `composables/useMouse.js`：

```js
// composables/useMouse.js
import { ref, onMounted, onUnmounted } from 'vue'

export function useMouse() {
  const x = ref(0)
  const y = ref(0)

  function update(e) {
    x.value = e.pageX
    y.value = e.pageY
  }

  onMounted(() => window.addEventListener('mousemove', update))
  onUnmounted(() => window.removeEventListener('mousemove', update))

  return { x, y }
}
```

任何元件要用，只要 import：

```vue
<script setup>
import { useMouse } from './composables/useMouse'
const { x, y } = useMouse()
</script>
```

> 注意生命週期 hook 寫在 composable 裡完全 OK——它們會註冊到「呼叫這個 composable 的那個元件」身上。所以清理（`onUnmounted`）也是自動跟著該元件走的，這就是 composable 能自帶副作用又不洩漏的原因。

### 6.2 更實用的 `useFetch`（簡版）

一個會「自動追蹤 URL 變化、自動重抓」的資料抓取 composable，回傳 `data`/`error`/`loading` 三個 ref：

```js
// composables/useFetch.js
import { ref, watchEffect, toValue } from 'vue'

// url 可以傳字串、ref、或 getter 函式（() => `.../${id.value}`）
export function useFetch(url) {
  const data = ref(null)
  const error = ref(null)
  const loading = ref(false)

  // watchEffect 會自動追蹤裡面用到的響應式來源；
  // 只要 toValue(url) 依賴的東西變了，就自動重跑（重新抓）
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

用法：

```vue
<script setup>
import { useFetch } from './composables/useFetch'

const { data: user, loading, error } = useFetch(
  'https://jsonplaceholder.typicode.com/users/1'
)
</script>

<template>
  <p v-if="loading">載入中…</p>
  <p v-else-if="error">出錯了：{{ error.message }}</p>
  <p v-else>{{ user.name }}（{{ user.email }}）</p>
</template>
```

### 6.3 與 React custom hook 的關鍵差異

```jsx
// React：依賴陣列要「自己列對」，漏了會抓不到最新值、多了會多跑
useEffect(() => {
  fetch(`/api/users/${id}`).then(/* ... */)
}, [id]) // ← 這個 [id] 是你手動維護的
```

```js
// Vue：watchEffect 自動追蹤「函式裡實際讀到的響應式來源」，不用手列
watchEffect(() => {
  fetch(toValue(url)) // url 依賴 id.value → id 變就自動重跑
})
```

| | React custom hook | Vue composable |
|---|------------------|----------------|
| 命名慣例 | `useXxx` | `useXxx` |
| 狀態載體 | `useState` 回傳 `[value, setValue]` | `ref`/`reactive` 回傳可直接 `.value` 改的物件 |
| 依賴追蹤 | **手動**維護依賴陣列 `[a, b]` | **自動**追蹤實際讀取的響應式來源 |
| 重新執行 | 依賴變 → 整個元件重渲染再跑 effect | 響應式來源變 → 只重跑相關的 `computed`/`watchEffect` |
| 清理 | effect 回傳 cleanup 函式 | `onUnmounted` / `watch` 的 `onCleanup` |

> 一句話記住：**React 靠「重跑函式 + 依賴陣列」，Vue 靠「響應式系統自動追蹤」。** 這也是為什麼 Vue composable 不需要、也沒有依賴陣列。

---

## 7. `<script setup>` 常見模式速查

把前面散落的重點收成一張表，日後回來查：

| 需求 | 用什麼 |
|------|--------|
| 宣告狀態 | `const x = ref(0)`（第 2 章） |
| 衍生值 | `const y = computed(() => ...)`（第 2 章） |
| 監聽變化做事 | `watch` / `watchEffect`（第 2 章 / 本章 6.2） |
| 接收父層資料 | `const props = defineProps(...)`（第 4 章） |
| 對父層發事件 | `const emit = defineEmits(...)`（第 4 章） |
| 掛載後做事（發請求、操作 DOM） | `onMounted(...)` |
| 卸載時清理 | `onUnmounted(...)` |
| 拿 DOM / 子元件 | `useTemplateRef('name')` + `ref="name"` |
| 子元件對外開放方法 | `defineExpose({ ... })` |
| 等 DOM 更新完 | `await nextTick()` |
| 抽出可重用邏輯 | 自訂 `useXxx()` composable |

---

## 常見陷阱

1. **在 `setup` 同步階段就想讀 DOM / template ref**：此時 DOM 還沒建立，`inputRef.value` 是 `null`。要放到 `onMounted` 裡。
2. **忘了清理副作用**：`onMounted` 起了 `setInterval`、`addEventListener`，卻沒在 `onUnmounted` 清掉。元件切走後計時器還在跑、監聽還在，造成記憶體洩漏。把「起」和「清」寫成一對，或直接抽成 composable 讓它自己管。
3. **在條件式或非同步後註冊生命週期 hook**：`if (x) onMounted(...)` 或 `await something(); onMounted(...)` 都會失效。hook 必須在 `setup` 同步流程中無條件註冊。
4. **改完資料立刻讀 DOM 尺寸**：因為 DOM 更新是非同步的，會讀到舊值。需要就 `await nextTick()`。
5. **想操控子元件卻忘了 `defineExpose`**：`<script setup>` 的子元件預設封閉，父層透過 ref 拿到的實例上什麼都沒有，除非子元件 `defineExpose` 開放。
6. **把 composable 當成「只是個工具函式」**：composable 的價值在於「回傳的是響應式狀態」。如果你的函式只是純計算、不涉及 `ref`/生命週期，那它就是普通 util，不用叫 `useXxx`。

---

## 練習作業

1. 寫一個 `useTitle(title)` composable：呼叫時把瀏覽器分頁標題 `document.title` 設為傳入值，並在元件卸載時還原成原本的標題。
2. 把本章的 `useMouse` 加上一個 `distance` 計算值（`computed`），表示目前游標離左上角 (0,0) 的直線距離。
3. 做一個「自動聚焦 + 送出後重新聚焦」的輸入框：頁面載入自動聚焦（`onMounted` + template ref），每次按 Enter 送出後（改資料 → `nextTick`）再把焦點放回輸入框。
4. 用 `useFetch` 抓 `https://jsonplaceholder.typicode.com/posts/1`，並在畫面上正確顯示載入中、錯誤、成功三種狀態。
5. 進階：把 `useFetch` 的 `url` 改成傳入一個 `ref`，畫面上放個按鈕切換要抓的文章 id，觀察 `watchEffect` 如何在 id 改變時自動重抓（完全不用你手動呼叫）。

---

## 最後範例：碼表元件（生命週期 + composable + template ref）

把本章觀念整合成一個可跑的碼表：邏輯抽成 `useStopwatch` composable（自帶清理），畫面用 template ref 做「重置後自動聚焦備註欄」。原樣建立以下檔案即可跑（第 1 章已教過 `npm create vue@latest` 建專案）。

### `src/composables/useStopwatch.js`

```js
import { ref, computed, onUnmounted } from 'vue'

export function useStopwatch() {
  const elapsed = ref(0) // 累積毫秒
  const running = ref(false)
  let timer = null

  // 衍生值：格式化成 mm:ss.d
  const display = computed(() => {
    const totalSec = elapsed.value / 1000
    const mm = String(Math.floor(totalSec / 60)).padStart(2, '0')
    const ss = String(Math.floor(totalSec % 60)).padStart(2, '0')
    const d = Math.floor((elapsed.value % 1000) / 100)
    return `${mm}:${ss}.${d}`
  })

  function start() {
    if (running.value) return
    running.value = true
    const startedAt = Date.now() - elapsed.value
    timer = setInterval(() => {
      elapsed.value = Date.now() - startedAt
    }, 100)
  }

  function pause() {
    running.value = false
    clearInterval(timer)
  }

  function reset() {
    pause()
    elapsed.value = 0
  }

  // composable 自己負責清理：用它的元件被卸載時，計時器一定會停
  onUnmounted(() => clearInterval(timer))

  return { elapsed, running, display, start, pause, reset }
}
```

### `src/App.vue`

```vue
<script setup>
import { ref, useTemplateRef, nextTick } from 'vue'
import { useStopwatch } from './composables/useStopwatch'

const { display, running, start, pause, reset } = useStopwatch()

const laps = ref([])
const noteRef = useTemplateRef('note')
const note = ref('')

async function recordLap() {
  laps.value.unshift({ time: display.value, note: note.value || '（無備註）' })
  note.value = ''
  // 清空後把焦點放回備註欄，方便連續記錄
  await nextTick()
  noteRef.value.focus()
}
</script>

<template>
  <main class="page">
    <h1>第 5 章最終範例：碼表</h1>

    <section class="card">
      <p class="clock">{{ display }}</p>

      <div class="row">
        <button v-if="!running" @click="start">開始</button>
        <button v-else class="ghost" @click="pause">暫停</button>
        <button class="ghost" @click="reset">重置</button>
      </div>

      <div class="row">
        <input ref="note" v-model="note" placeholder="這一段在做什麼？" />
        <button @click="recordLap">記錄一段</button>
      </div>

      <ul class="laps">
        <li v-for="(lap, i) in laps" :key="i">
          <span class="mono">{{ lap.time }}</span>
          <span>{{ lap.note }}</span>
        </li>
      </ul>
    </section>
  </main>
</template>

<style>
body { margin: 0; font-family: -apple-system, "Segoe UI", sans-serif; background: #f3f4f6; }
.page { width: min(560px, 100%); margin: 36px auto; padding: 0 16px; }
.card { background: #fff; border-radius: 14px; padding: 20px; box-shadow: 0 8px 24px rgba(17,24,39,.08); }
.clock { font-size: 48px; font-weight: 700; text-align: center; font-variant-numeric: tabular-nums; margin: 8px 0 16px; }
.row { display: flex; gap: 8px; margin-bottom: 12px; }
.row input { flex: 1; border: 1px solid #d1d5db; border-radius: 8px; padding: 8px 10px; }
button { border: 1px solid #111827; background: #111827; color: #fff; border-radius: 8px; padding: 8px 14px; cursor: pointer; }
button.ghost { background: #fff; color: #111827; border-color: #d1d5db; }
.laps { list-style: none; padding: 0; margin: 0; }
.laps li { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #e5e7eb; }
.mono { font-variant-numeric: tabular-nums; color: #2563eb; }
</style>
```

### 範例解釋

1. 所有計時邏輯都在 `useStopwatch` 裡，`App.vue` 只負責畫面——這就是「依功能聚合、可重用」。
2. `display` 是 `computed`，由 `elapsed` 自動推導，不需要另存一份格式化字串。
3. `onUnmounted(() => clearInterval(timer))` 寫在 composable 內，副作用的清理跟著元件走，永遠不會忘。
4. `recordLap` 先改資料、`await nextTick()` 等 DOM 更新，再用 template ref 把焦點放回輸入框——這正是 `nextTick` 的典型場景。

---

你已經掌握「在對的時機做事」與「把邏輯抽成 composable 重用」。下一章我們把這套能力用在**表單**上：`v-model` 全套、修飾符、手寫驗證，並把驗證邏輯抽成 `useForm`/`useField` composable。

---

## 上一章 / 下一章

- 上一章：[第 4 章：元件與溝通（props / emit / v-model / slots）](./04-components-props-emit.md)
- 下一章：[第 6 章：表單與驗證](./06-forms-and-validation.md)
