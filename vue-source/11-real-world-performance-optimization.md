# 第 11 章：真實專案的效能優化實戰（改哪些使用方式可以變快）

## 11.1 本章目標

前面章節教你「源碼為什麼這樣設計」，這章把它倒過來用：

> 既然懂了 reactivity / renderer / compiler 的運作成本，
> 那在**真實專案的程式碼裡**，到底改哪些「使用方式」可以實際變快？

本章不談玄學優化，每一條建議都會說明：

1. 它對應源碼的哪個成本（依賴收集？patch？re-render？）
2. 改之前 vs 改之後的寫法
3. 什麼情況下該用、什麼情況下別用（避免過度優化）

讀完後，你應該能拿著一份 checklist 去 review 任何 Vue 專案，並說得出「為什麼這樣改會快」。

---

## 11.2 先建立心智模型：效能花在哪三層

Vue 應用的執行成本，幾乎都落在這三層。優化前先判斷你卡在哪一層，否則容易亂改。

| 層級 | 成本來源 | 對應源碼 | 典型症狀 |
|---|---|---|---|
| 反應式層 | 依賴收集、trigger 過多 effect | `track` / `trigger` / `effect` | 改一個值卻觸發一堆無關更新 |
| 更新/渲染層 | re-render、patch、diff | `renderEffect` / `patch` / `patchKeyedChildren` | 列表卡頓、輸入延遲、滾動掉幀 |
| 編譯/載入層 | bundle 過大、首屏載入慢 | `compiler` 輸出、Vite chunk | 首屏白屏久、TTI 高 |

> 黃金原則：**先量測，再優化**。沒有數據支撐的優化，常常是浪費時間或反向劣化（見 11.13）。

---

## 11.3 反應式層：別讓「不需要反應的資料」變成反應式

### 11.3.1 大型唯讀資料用 `shallowRef` / `shallowReactive`

`reactive` 會對物件做**深層**遞迴代理，每一層存取都觸發 `track`。如果你有一個幾千筆、巢狀很深的資料（例如後端回傳的大型 JSON），深層代理的建立與依賴收集成本很可觀，而你往往只是整包替換、不會改內部欄位。

> 特別注意：`ref(物件)` **不會**比較省。`ref` 內部會對物件呼叫 `toReactive`（即 `reactive`），所以 `ref(hugeJson)` 和 `reactive(hugeJson)` 的深層代理成本幾乎一樣（細節見 11.3.3）。要省，得用 `shallowRef` / `shallowReactive`。

```js
// ❌ 改之前：深層代理，整棵樹都被代理 + 收集依賴
const tableData = reactive(hugeNestedJson)  // 數千筆，每層都 proxy
const tableData = ref(hugeNestedJson)       // 一樣慘：內部 toReactive → 深層 proxy

// ✅ 改之後：只在「整包替換」時觸發更新，內部不做深層追蹤
const tableData = shallowRef(hugeNestedJson)
function reload(newData) {
  tableData.value = newData // 觸發一次 trigger，足夠了
}
```

對應源碼：`reactive` 走 `createReactiveObject` 並在 getter 內對巢狀物件遞迴 `reactive`；`ref` 在建構與 set 時對物件值呼叫 `toReactive`（`isObject(v) ? reactive(v) : v`），所以包物件等於套了一層深層 `reactive`。而 `shallowReactive` / `shallowRef` 只代理第一層（`shallowRef` 連 `toReactive` 都跳過），省掉大量 proxy 與 track。

**何時別用**：你確實需要修改物件內部欄位並讓 UI 響應時，shallow 反而要手動 `triggerRef` 或整包替換，會更麻煩。

### 11.3.2 永遠不會變的資料用 `markRaw`

像「靜態設定表、第三方類別實例（地圖、圖表、編輯器物件）」不需要反應式，包進 reactive 反而浪費，甚至可能因為被代理而出 bug。

```js
import { markRaw, reactive } from 'vue'

const state = reactive({
  // map 實例巨大且自己管理狀態，不該被 Vue 代理
  mapInstance: markRaw(new MapLibreMap(...)),
  config: markRaw(STATIC_CONFIG),
})
```

對應源碼：`markRaw` 會打上 `ReactiveFlags.SKIP`，`reactive` 在建立代理前看到這個 flag 就直接跳過。

### 11.3.3 `ref` vs `reactive` 的選擇

- 單一原始值（number / string / boolean）→ `ref`
- 一組相關欄位且常整組操作 → `reactive`
- 大型/巢狀/常整包替換 → `shallowRef`

差異不只是風格：`reactive` 解構會丟失反應性，誘導你用 `toRefs`（每個欄位各建一個 ref，多一層成本）。能用 `ref` 表達就別硬塞 `reactive`。

---

## 11.4 反應式層：縮小依賴與觸發範圍

### 11.4.1 `computed` 取代「模板裡的即時運算」

模板裡的方法呼叫、或 `{{ list.filter(...).map(...) }}` 這類運算，**每次 re-render 都會重算**，不快取。`computed` 會快取，只有依賴變動才重算（dirty 才重算，見第 02 章）。

```vue
<!-- ❌ 改之前：每次 render 都重新 filter，即使 list 沒變 -->
<span>{{ list.filter(i => i.active).length }}</span>

<!-- ✅ 改之後：computed 快取，依賴沒變就直接拿結果 -->
<span>{{ activeCount }}</span>
```

```js
const activeCount = computed(() => list.value.filter(i => i.active).length)
```

對應源碼：`computed` 有 `_dirty` / `_cacheable` 機制，依賴未變時直接回傳快取值，不執行 getter。

### 11.4.2 `watch` 別亂開 `deep: true`

`deep` watcher 會遞迴走訪整個物件來建立依賴，物件越大越貴，而且任何深層欄位變動都觸發回呼。

```js
// ❌ 改之前：deep 監聽整個大物件
watch(form, handler, { deep: true })

// ✅ 改之後：只監聽真正在意的欄位（getter 形式）
watch(() => form.email, handler)

// 或監聽多個明確來源
watch([() => form.email, () => form.phone], handler)
```

### 11.4.3 高頻來源做防抖 / 節流，並善用 `flush`

搜尋輸入、resize、scroll 這類高頻 trigger，會把大量 job 推進 scheduler queue。對「副作用」做防抖即可：

```js
import { watchDebounced } from '@vueuse/core' // 或自己包 debounce

watchDebounced(() => keyword.value, fetchResults, { debounce: 300 })
```

另外注意 `flush` 時機（第 02 章）：要讀更新後的 DOM 用 `flush: 'post'`，不要在 `'pre'` 階段讀 DOM 拿到舊值又被迫多一輪。

---

## 11.5 渲染層：穩定的 key 是列表效能的命脈

### 11.5.1 `v-for` 不要用 index 當 key

用 index 當 key，當列表發生**插入 / 刪除 / 重排**時，Vue 的 `patchKeyedChildren`（第 05 章）會把「不同的資料」對應到「相同的 key」，導致：

- 大量本可複用的 DOM 被誤判為要更新
- 子組件 / 輸入框的 local state 錯位
- LIS 最小移動優化失效

```vue
<!-- ❌ index 當 key：重排後狀態錯位、複用失準 -->
<Row v-for="(item, i) in list" :key="i" :item="item" />

<!-- ✅ 用穩定且唯一的業務 id -->
<Row v-for="item in list" :key="item.id" :item="item" />
```

對應源碼：keyed diff 靠 key 建立「新舊節點對應表」，再用最長遞增子序列算最小搬移。key 不穩 = 對應表錯 = 整個優化崩盤。

### 11.5.2 `v-once`：只渲染一次的靜態區塊

純靜態、且確定不會再變的內容，用 `v-once` 讓它只建立一次、之後 patch 直接跳過。

```vue
<footer v-once>
  © 2026 MyCompany — 所有版權內容固定不變
</footer>
```

### 11.5.3 `v-memo`：大型列表的精準跳過

`v-memo` 讓你手動指定「依賴陣列」，依賴沒變就跳過該子樹的 re-render，類似 React 的 memo。最適合「資料量大、但每列實際變動很少」的表格。

```vue
<!-- 只有 item.id 或 item.selected 改變時才重渲染這一列 -->
<tr v-for="item in bigList" :key="item.id" v-memo="[item.id, item.selected]">
  <!-- 很多欄位的複雜內容 -->
</tr>
```

對應源碼：`v-memo` 編譯成 `withMemo`，會比較依賴陣列，命中就回傳上一次的 vnode，直接省掉建立與 patch。

> 注意：`v-memo` 是進階工具，依賴陣列寫錯會導致「該更新卻沒更新」的 bug。先確定有效能問題再用。

---

## 11.6 渲染層：避免「假動態」破壞編譯器優化

第 07 章說過 Vue 用 patch flags / block tree 做精準更新。但有些寫法會讓編譯器**無法判定靜態**，或讓 runtime 每次都拿到新引用而誤判要更新。

### 11.6.1 別在模板裡寫 inline 物件 / 陣列字面量

```vue
<!-- ❌ 每次 render 都新建一個 {} / [] ，引用都不同 -->
<Child :style="{ color: 'red' }" :options="[1, 2, 3]" />

<!-- ✅ 提到外面成為穩定引用（或用 computed） -->
<Child :style="redStyle" :options="staticOptions" />
```

```js
const redStyle = { color: 'red' }      // 穩定引用
const staticOptions = [1, 2, 3]
```

成本來源：子組件收到的 prop 每次引用都變 → 即使值一樣也可能觸發子組件更新；對 `:style` / `:class` 也會走較重的比對路徑。

### 11.6.2 行內函式也是新引用

```vue
<!-- ❌ 每次 render 產生新函式，當作 prop 傳給子組件時會破壞穩定性 -->
<Child :on-select="(id) => handleSelect(id, extra)" />

<!-- ✅ 穩定的 handler（v-on 綁定事件其實會被 cache，但當 prop 傳就要注意） -->
<Child :on-select="onSelect" />
```

> 補充：模板上的 `@click="() => ..."` 事件，編譯器有 `cacheHandlers` 優化會幫你快取；但「當作 prop 往下傳」的函式不在此列，需自己保持穩定。

### 11.6.3 善待編譯器：能用 template 就別硬寫 render function

第 07 章提過：手寫 `render` 會失去 static hoist / patch flag / block tree 等自動優化。除非有強需求（高度動態結構），否則模板讓編譯器幫你優化，通常比手寫快又安全。

---

## 11.7 組件設計：把「會變的」和「不會變的」拆開

### 11.7.1 用元件邊界縮小 re-render 範圍

Vue 的更新粒度是**組件**：一個組件內任何被模板用到的反應式資料變動，整個組件的 render function 會重跑（再靠 diff 收斂）。所以把高頻變動的部分抽成獨立子組件，可以把 re-render 侷限在小範圍。

```text
❌ 一個巨大組件：頂部一個 timer 每秒跳動 → 整個大組件每秒重跑 render
✅ 把 timer 抽成 <Clock/> 子組件 → 只有 <Clock/> 每秒 re-render，其餘不受影響
```

對應源碼：每個組件有自己的 `renderEffect`（第 04 章），trigger 只會喚醒「依賴了該資料」的那個 effect。

### 11.7.2 保持 props 穩定，必要時 `keepalive`

- props 引用穩定 → 子組件不會被多餘喚醒
- 切換成本高的頁籤 / 列表，用 `<KeepAlive>`（第 08 章）快取實例，避免反覆銷毀重建

```vue
<KeepAlive :max="10">
  <component :is="currentTab" />
</KeepAlive>
```

### 11.7.3 大資料用 `provide/inject` 還是 prop？

深層 prop drilling 會讓中間每一層都因傳遞而牽動更新。跨多層共享、且讀多寫少的資料，`provide/inject` 或外部 store（Pinia）通常更乾淨且更省。

---

## 11.8 大型列表：超過幾百列就別硬渲染

DOM 節點本身是昂貴的。一次塞 1 萬個 `<tr>`，瓶頸在瀏覽器佈局與繪製，不是 Vue。

| 方案 | 適用 | 說明 |
|---|---|---|
| 分頁 / 無限滾動 | 大多數列表 | 最簡單，先做這個 |
| 虛擬滾動（virtual list） | 必須一次性大量資料 | 只渲染可視區 + buffer，配 `vue-virtual-scroller` 等 |
| `shallowRef` 存資料 | 大陣列 | 避免深層代理整包資料（見 11.3.1） |
| `v-memo` | 列變動少 | 跳過未變列的 re-render（見 11.5.3） |

```vue
<!-- 虛擬滾動：DOM 只維持可視範圍的數十個節點 -->
<RecycleScroller :items="bigList" :item-size="48" key-field="id" v-slot="{ item }">
  <Row :item="item" />
</RecycleScroller>
```

---

## 11.9 編譯/載入層：把首屏和 bundle 變小

### 11.9.1 路由與重組件懶載入

```js
// ❌ 一開始就全部打包進首屏
import Dashboard from './Dashboard.vue'

// ✅ 路由層級 code split，用到才載入
const Dashboard = () => import('./Dashboard.vue')
```

### 11.9.2 `defineAsyncComponent` + `Suspense`

對「進入畫面後才需要」的重組件（圖表、編輯器、地圖）做非同步載入，並用 `Suspense`（第 08 章）統一處理 loading：

```js
import { defineAsyncComponent } from 'vue'

const HeavyChart = defineAsyncComponent({
  loader: () => import('./HeavyChart.vue'),
  delay: 200,
  timeout: 8000,
})
```

### 11.9.3 善用 build 設定

- production build 一定要開（移除 warn、開啟壓縮）
- 設定 `__VUE_PROD_DEVTOOLS__ = false`、`__VUE_OPTIONS_API__ = false`（若全用 Composition API），可進一步 tree-shake
- 大型第三方庫做 chunk 分割，避免拖慢首屏

---

## 11.10 改之前 vs 改之後：完整對照速查

| 場景 | ❌ 常見寫法 | ✅ 建議寫法 | 省下的成本 |
|---|---|---|---|
| 大型唯讀資料 | `reactive(big)` | `shallowRef(big)` | 深層 proxy + track |
| 第三方實例 | 放進 `reactive` | `markRaw(instance)` | 不必要代理 |
| 模板即時運算 | 模板內 `filter/map` | `computed` | 每次 render 重算 |
| 監聽大物件 | `watch(obj, fn, {deep})` | `watch(() => obj.field, fn)` | 深層遍歷 + 多餘觸發 |
| 高頻輸入 | 直接 watch 觸發請求 | debounce / throttle | 大量 scheduler job |
| 列表 key | `:key="index"` | `:key="item.id"` | diff 複用與 LIS 失效 |
| 靜態區塊 | 一般渲染 | `v-once` | 重複建立 + patch |
| 大列表少變動 | 整列重渲染 | `v-memo` | 未變列的 re-render |
| 行內物件 prop | `:opts="{...}"` | 穩定引用 / computed | 子組件多餘更新 |
| 巨大組件 | 全塞一個組件 | 拆子組件 | 縮小 re-render 範圍 |
| 萬列表格 | 一次全渲染 | 虛擬滾動 / 分頁 | 瀏覽器佈局繪製 |
| 重組件首屏 | 同步 import | 懶載入 + Suspense | bundle / 首屏時間 |

---

## 11.11 一份可直接用的 Code Review Checklist

拿這份去審任何 Vue 專案：

**反應式**
- [ ] 大型 / 巢狀 / 整包替換的資料是否用 `shallowRef`？
- [ ] 第三方實例、靜態設定是否 `markRaw`？
- [ ] 模板裡有沒有可改成 `computed` 的即時運算？
- [ ] `watch` 是否濫用 `deep`？能否縮成 getter？
- [ ] 高頻來源是否做了防抖 / 節流？

**渲染**
- [ ] `v-for` 是否都用穩定唯一 key（非 index）？
- [ ] 是否有同元素同時 `v-if` + `v-for`（應拆開或用 `<template>` 包）？
- [ ] 大列表少變動是否考慮 `v-memo`？純靜態是否 `v-once`？
- [ ] 模板裡有沒有 inline 物件 / 陣列 / 函式被當 prop 傳？

**組件 / 結構**
- [ ] 高頻變動部分是否抽成獨立子組件？
- [ ] 切換成本高的內容是否用 `KeepAlive`？
- [ ] 萬列等級的列表是否做了虛擬滾動 / 分頁？

**載入 / build**
- [ ] 路由與重組件是否懶載入？
- [ ] production build 與 tree-shake flag 是否正確？

---

## 11.12 怎麼量測（不要憑感覺）

1. **Vue DevTools**：看哪些組件 re-render、render 次數與耗時。
2. **`app.config.performance = true`（dev）**：在 Performance 面板看 component init / render / patch 標記。
3. **Chrome Performance**：錄一段互動，看 scripting vs rendering vs painting 各佔多少，判斷瓶頸在 Vue 還是瀏覽器繪製。
4. **建立 before/after benchmark**：固定資料量與操作，記錄 patch 次數與耗時，用數據證明優化有效。

> 量測流程：先重現卡頓 → 錄製找熱點 → 判斷落在 11.2 哪一層 → 對症下藥 → 再量一次驗證。

---

## 11.13 常見誤區

### 誤區一：過早優化、過度優化

到處灑 `v-memo`、`shallowRef`、`markRaw`，反而增加心智負擔與 bug 風險（shallow / memo 都可能造成「該更新沒更新」）。**先量測有瓶頸，再針對熱點優化。**

### 誤區二：以為 `Object.freeze` / shallow 一定更快

它們省的是「反應式追蹤成本」。如果你的瓶頸其實在 DOM 數量或網路，這些改動毫無幫助，只是讓你誤以為在優化。

### 誤區三：把 index 當 key 還覺得「能跑就好」

它「能跑」，但會在重排 / 增刪時悄悄出狀態錯位 bug（第 05、10 章都點過），是最常見的隱性效能 + 正確性問題。

### 誤區四：用 `v-if` 反覆切換成本高的組件

`v-if` 是真正銷毀 / 重建。頻繁切換的重組件該用 `v-show`（只切 display）或 `KeepAlive`，視需求而定。

### 誤區五：手寫 render function 想「自己優化」

多數情況反而失去編譯器的 hoist / patch flag / block 優化（第 07 章），又難維護。

---

## 11.14 本章作業

### 必做

1. 在你目前的專案（或一個 demo）中，用 11.11 的 checklist 跑一遍，列出至少 **5 個**可優化點，並標註它對應 11.2 的哪一層。
2. 挑其中 1 個，做 before/after：
   - 用 Vue DevTools 或 `performance` 記錄改前數據
   - 改寫後再記錄
   - 寫出「省了什麼成本」的源碼層級解釋

### 加分

- 做一個「1 萬列表格」demo，比較：一次渲染 vs 分頁 vs 虛擬滾動 的滾動 FPS。
- 寫一篇「我們團隊的 Vue 效能規範」，把本章 checklist 在地化成團隊可遵循的條目。

### 驗收標準

- 能對每條優化說出「對應哪一層成本、為什麼會快」
- 能用數據（而非感覺）證明一個優化有效
- 能指出至少 2 個「不該優化」或「優化反而劣化」的情境

---

## 11.15 收尾

效能優化的本質不是背技巧，而是：

> 你懂源碼的成本模型（reactivity / render / compile），
> 所以你在寫每一行業務程式碼時，就已經知道它會讓 Vue 多花什麼成本。

把這章的 checklist 內化成寫 code 時的直覺，你就不再需要事後到處救火——
大部分效能問題，在你按下第一個鍵時就已經避開了。

---

> 回到 [課程目錄](./README.md)，或重溫與本章最相關的 [第 05 章：keyed diff](./05-diff-keyed-children.md) 與 [第 07 章：編譯最佳化](./07-compile-optimization-hoist-patchflags.md)。
