# 第 4 章：元件與溝通（props / emit / v-model / slots）

> 真實應用是由一堆元件組合而成的。這一章談「元件之間怎麼溝通」：父傳子用 **props**、子告訴父用 **emit**、雙向用 **`v-model`（`defineModel`）**、傳一段畫面進去用 **slots**、跨很多層用 **provide / inject**，還有沒宣告的屬性怎麼**透傳（`$attrs`）**。
> 學完這章，你就具備把畫面拆成可重用元件、並讓它們正確協作的能力，也正式接軌 vue-source 與 nuxt 的元件寫法。

---

## 本章目標

完成這一章後，你應該可以：

1. 匯入並使用子元件（`<script setup>` 的元件用法）。
2. 用 `defineProps` 宣告 props，含執行期驗證、預設值（`withDefaults`）與 TS 型別宣告。
3. 用 `defineEmits` 對外發事件，並遵守事件命名慣例。
4. 用 `defineModel()` 做元件版 `v-model`，並看懂它與舊寫法 `modelValue` + `update:modelValue` 的等價關係。
5. 用 slots 傳入內容：預設插槽、具名插槽（`#name`）、作用域插槽（scoped slot）。
6. 用 `provide` / `inject` 跨層級傳資料，並搭配 `readonly` 保護。
7. 理解 `$attrs` 透傳與 `inheritAttrs` 的行為。

---

## 1. 匯入並使用子元件

在 `<script setup>` 裡，元件就是「import 進來、直接在 template 用」，不需要像舊寫法那樣註冊 `components: {}`。

先建一個子元件 `src/components/HelloCard.vue`：

```vue
<!-- src/components/HelloCard.vue -->
<script setup>
// 這個子元件目前沒有任何 props，下一節就會加上
</script>

<template>
  <article class="card">
    <h3>我是一張卡片</h3>
    <p>由父元件組合進畫面</p>
  </article>
</template>

<style scoped>
.card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; }
</style>
```

在父元件 `src/App.vue` 使用它：

```vue
<!-- src/App.vue -->
<script setup>
import HelloCard from './components/HelloCard.vue'   // import 進來即可用
</script>

<template>
  <main>
    <HelloCard />
    <HelloCard />
  </main>
</template>
```

> 慣例：元件名用 PascalCase（`HelloCard`）。在 template 裡 `<HelloCard />` 與 `<hello-card />` 都能用，本課統一用 PascalCase。

---

## 2. `defineProps`：父傳子

props 是「父元件傳資料給子元件」的管道，資料流是**單向由上而下**。`defineProps` 是 `<script setup>` 裡的編譯器巨集（不用 import 就能用）。

### 2.1 最簡宣告

```vue
<!-- src/components/LessonCard.vue -->
<script setup>
// 陣列語法：只列出 prop 名字（最簡，但沒型別與驗證）
const props = defineProps(['title', 'minutes'])
// props.title 可讀；template 裡直接用 title、minutes
</script>

<template>
  <article class="card">
    <h3>{{ title }}</h3>
    <p>{{ minutes }} 分鐘</p>
  </article>
</template>
```

父元件傳值（用 `v-bind` / `:` 傳動態值）：

```vue
<script setup>
import LessonCard from './components/LessonCard.vue'
import { ref } from 'vue'
const t = ref('響應式基礎')
</script>

<template>
  <!-- 靜態字串直接寫；動態值用 :prop 綁定 -->
  <LessonCard title="Vue 心智模型" :minutes="30" />
  <LessonCard :title="t" :minutes="45" />
</template>
```

> 注意 `:minutes="30"` 有冒號——沒冒號的 `minutes="30"` 會傳字串 `"30"`；加冒號才是把它當 JS 運算式，傳數字 `30`。

### 2.2 物件語法：型別、必填、執行期驗證

實務上建議用物件語法，能宣告型別、是否必填、預設值與自訂驗證。Vue 會在開發模式下依這些規則檢查，傳錯型別會在 console 警告：

```vue
<!-- src/components/LessonCard.vue -->
<script setup>
const props = defineProps({
  title: { type: String, required: true },
  minutes: { type: Number, default: 0 },
  level: {
    type: String,
    default: 'Beginner',
    // 自訂驗證：回傳 false 會在開發模式警告
    validator: (v) => ['Beginner', 'Intermediate', 'Advanced'].includes(v),
  },
  tags: {
    type: Array,
    // 物件 / 陣列的預設值要用「工廠函式」回傳，避免多個實例共用同一份
    default: () => [],
  },
})
</script>

<template>
  <article class="card">
    <h3>{{ title }}</h3>
    <p>{{ minutes }} 分鐘 · {{ level }}</p>
    <span v-for="tag in tags" :key="tag">#{{ tag }} </span>
  </article>
</template>
```

要點：

- `type` 可以是 `String` / `Number` / `Boolean` / `Array` / `Object` / `Function` 等。
- **物件 / 陣列的 `default` 必須用工廠函式**（`() => []`），否則所有實例共用同一個參考。
- `validator` 給你執行期的自訂檢查。

### 2.3 props 是唯讀的

props 不能在子元件裡直接改（單向資料流）：

```js
// ❌ 直接改 prop 會警告，且無效
props.minutes++

// ✅ 要嘛用 computed 衍生、要嘛複製到本地 ref、要嘛 emit 請父層改（見第 3、4 節）
```

### 2.4 用 TS 型別宣告 props（型別驅動）

如果你的專案開了 TypeScript（第 1 章建專案時選 TS，或副檔名用 `<script setup lang="ts">`），可以直接用型別宣告 props，更精準也不用寫兩套：

```vue
<script setup lang="ts">
// 用泛型參數宣告 props 的型別
const props = defineProps<{
  title: string
  minutes?: number          // 加 ? 表示可選
  level?: 'Beginner' | 'Intermediate' | 'Advanced'
}>()
</script>
```

要給「型別宣告」的 props 加預設值，用 `withDefaults` 包起來：

```vue
<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    title: string
    minutes?: number
    tags?: string[]
  }>(),
  {
    minutes: 0,
    tags: () => [],          // 陣列預設值一樣用工廠函式
  },
)
</script>
```

> 本課前幾章用 JS 就好，這裡先讓你認得 TS 寫法——因為 vue-source 與 nuxt 都以 TS 為主，之後看到 `defineProps<{...}>()` 不會陌生。JS 用物件語法、TS 用型別宣告，兩者擇一，不要混用。

---

## 3. `defineEmits`：子告訴父

props 是父到子；反過來，子元件要「通知父元件發生了什麼事」，用**自訂事件**：子元件 `emit` 一個事件，父元件用 `@事件名` 接。

```vue
<!-- src/components/CounterButton.vue -->
<script setup>
const props = defineProps({ step: { type: Number, default: 1 } })

// 宣告這個元件會對外發哪些事件
const emit = defineEmits(['increment', 'reset'])

function onAdd() {
  emit('increment', props.step)   // 第二個參數起是傳給父層的資料（payload）
}
function onReset() {
  emit('reset')
}
</script>

<template>
  <button @click="onAdd">+{{ step }}</button>
  <button @click="onReset">歸零</button>
</template>
```

父元件接事件：

```vue
<!-- src/App.vue -->
<script setup>
import { ref } from 'vue'
import CounterButton from './components/CounterButton.vue'

const count = ref(0)
function handleIncrement(step) { count.value += step }
function handleReset() { count.value = 0 }
</script>

<template>
  <p>count：{{ count }}</p>
  <!-- 用 @事件名 接，事件名對應 emit 的字串 -->
  <CounterButton :step="5" @increment="handleIncrement" @reset="handleReset" />
</template>
```

### 3.1 事件命名慣例

- 事件名在 JS 裡用 **camelCase** 宣告（`emit('updateValue')`），在 template 上用 **kebab-case** 接（`@update-value`）。Vue 會自動對應。實務上為了少踩坑，很多團隊事件名直接全小寫或用 kebab（如 `increment`、`load-more`）。
- 表示「更新某個值」的事件，慣例用 `update:xxx`（例如 `update:modelValue`）——這正是下一節 `v-model` 的基礎。

### 3.2 對照 React

React 沒有獨立的「事件系統」，父子溝通就是「父層把 callback 當 prop 傳下去，子層呼叫它」（`<Child onIncrement={fn} />`）。Vue 的 `emit` 是同一件事的另一種寫法：**props 往下傳資料、events 往上回報**，只是 Vue 把「往上」獨立成 emit，讓意圖更清楚。

---

## 4. 元件版 `v-model`：`defineModel()`

第 3 章的 `v-model` 用在原生 `<input>`。它其實也能用在**自訂元件**上，做出「父子雙向綁定」的可重用輸入元件。Vue 3.4 起，官方推薦用 **`defineModel()`**（3.4+ 穩定），大幅簡化寫法。

### 4.1 用 `defineModel()`（推薦）

子元件 `src/components/MyInput.vue`：

```vue
<!-- src/components/MyInput.vue -->
<script setup>
// defineModel() 回傳一個 ref，讀寫它就會與父層的 v-model 雙向同步
const model = defineModel()
</script>

<template>
  <!-- 直接把 model 綁到原生 input 上；改它 → 父層跟著變 -->
  <input :value="model" @input="model = $event.target.value" />
</template>
```

父元件：

```vue
<!-- src/App.vue -->
<script setup>
import { ref } from 'vue'
import MyInput from './components/MyInput.vue'
const name = ref('Gary')
</script>

<template>
  <MyInput v-model="name" />      <!-- 和用在原生 input 一模一樣 -->
  <p>父層看到：{{ name }}</p>
</template>
```

`defineModel()` 也能給選項（型別、預設值、必填）：

```js
const model = defineModel({ type: String, default: '' })
```

多個 v-model？給它命名：`defineModel('firstName')`、`defineModel('lastName')`，父層寫 `v-model:firstName` / `v-model:lastName`。

### 4.2 它其實是 props + emit 的語法糖

理解 `defineModel` 最好的方式，是看它「展開」後等價於什麼。下面這個舊寫法和上面的 `defineModel()` **完全等價**：

```vue
<!-- 舊寫法：與 4.1 的 MyInput 等價 -->
<script setup>
// v-model 預設對應名為 modelValue 的 prop，與 update:modelValue 事件
const props = defineProps(['modelValue'])
const emit = defineEmits(['update:modelValue'])
</script>

<template>
  <input
    :value="props.modelValue"
    @input="emit('update:modelValue', $event.target.value)"
  />
</template>
```

也就是說，父層的 `v-model="name"` 其實是這段語法糖：

```vue
<!-- 這兩行完全等價 -->
<MyInput v-model="name" />
<MyInput :modelValue="name" @update:modelValue="name = $event" />
```

> 記法：**`v-model` = 傳一個 `modelValue` prop 下去 + 聽一個 `update:modelValue` 事件回來。** `defineModel()` 只是把這對「prop + emit」自動幫你接好，讓你像操作本地 ref 一樣寫。新專案（Vue 3.4+）一律用 `defineModel()`；看到舊碼的 `modelValue` / `update:modelValue`，知道它是同一回事即可。

---

## 5. Slots：把「一段畫面」傳進元件

props 傳的是「資料」；slots 傳的是「一段畫面（模板內容）」。這對應 React 的 `children`。

### 5.1 預設插槽

子元件用 `<slot>` 標記「父層傳進來的內容要放這裡」：

```vue
<!-- src/components/PanelCard.vue -->
<script setup></script>

<template>
  <section class="panel">
    <slot>預設內容（父層沒放東西時顯示這句）</slot>
  </section>
</template>

<style scoped>
.panel { border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; }
</style>
```

父層把內容塞在元件標籤中間：

```vue
<script setup>
import PanelCard from './components/PanelCard.vue'
</script>

<template>
  <PanelCard>
    <h3>自訂標題</h3>
    <p>這段會被放進 slot 的位置</p>
  </PanelCard>
</template>
```

### 5.2 具名插槽（`#name`）

一個元件想開好幾個「洞」（例如標題區、內容區、頁尾區），用具名插槽：

```vue
<!-- src/components/LayoutCard.vue -->
<template>
  <section class="panel">
    <header><slot name="header" /></header>
    <div class="body"><slot /></div>            <!-- 沒 name 的是預設插槽 -->
    <footer><slot name="footer" /></footer>
  </section>
</template>
```

父層用 `<template #name>` 指定內容要進哪個洞（`#` 是 `v-slot:` 的縮寫）：

```vue
<script setup>
import LayoutCard from './components/LayoutCard.vue'
</script>

<template>
  <LayoutCard>
    <template #header><h3>標題區</h3></template>

    <p>這段沒指定名字，進預設插槽（body）</p>

    <template #footer><small>頁尾區</small></template>
  </LayoutCard>
</template>
```

### 5.3 作用域插槽（scoped slot）：子把資料交給父的模板用

有時「洞裡要放什麼」由父決定，但「資料」在子元件手上（例如子元件負責跑迴圈，但每一項長怎樣由父決定）。子元件可以透過 slot 把資料往外傳：

```vue
<!-- src/components/UserList.vue -->
<script setup>
import { ref } from 'vue'
const users = ref([
  { id: 1, name: 'Gary', vip: true },
  { id: 2, name: 'Amy', vip: false },
])
</script>

<template>
  <ul>
    <li v-for="user in users" :key="user.id">
      <!-- 把 user 透過 slot 綁出去，父層才拿得到每一項 -->
      <slot :user="user" />
    </li>
  </ul>
</template>
```

父層用 `#default="slotProps"` 接住子元件綁出來的資料：

```vue
<script setup>
import UserList from './components/UserList.vue'
</script>

<template>
  <!-- v-slot 拿到的物件裡有 user；可以解構寫成 #default="{ user }" -->
  <UserList #default="{ user }">
    <strong>{{ user.name }}</strong>
    <span v-if="user.vip">（VIP）</span>
  </UserList>
</template>
```

> 心智模型：**一般 slot 是「父給子一段畫面」；作用域插槽多了一條回程——「子把資料交給父，讓父決定這段畫面怎麼用這份資料」。** 清單、表格這類「邏輯在裡、外觀由外」的可重用元件很常用到。

---

## 6. `provide` / `inject`：跨層級傳資料

props 一層層傳，若中間隔了很多層（爺 → 父 → 子 → 孫），每層都要轉手很煩，這叫「props drilling」。`provide` / `inject` 讓「祖先提供、後代直接注入」，跳過中間層。這對應 React 的 Context。

祖先元件 `provide`：

```vue
<!-- src/App.vue（祖先） -->
<script setup>
import { ref, provide, readonly } from 'vue'
import Child from './components/Child.vue'

const theme = ref('dark')
function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
}

// 提供資料給所有後代。用 readonly 包住 theme，避免後代直接亂改
provide('theme', readonly(theme))
// 想讓後代能改，就提供一個「改的方法」，而不是把可寫的 ref 直接丟出去
provide('toggleTheme', toggleTheme)
</script>

<template>
  <div :class="theme">
    <Child />
  </div>
</template>
```

任意深度的後代 `inject`：

```vue
<!-- src/components/Child.vue（可以再包很多層，孫、曾孫都能 inject） -->
<script setup>
import { inject } from 'vue'

// 第二參數是「沒人 provide 時的預設值」，建議都給，避免拿到 undefined
const theme = inject('theme', 'light')
const toggleTheme = inject('toggleTheme', () => {})
</script>

<template>
  <p>目前主題：{{ theme }}</p>
  <button @click="toggleTheme">切換主題</button>
</template>
```

要點：

- **用 `readonly` 保護**：直接把可寫的 ref `provide` 出去，任何後代都能改，資料流會變得難追。慣例是「provide 唯讀的狀態 + provide 一個修改用的函式」，把「誰能改」收斂回提供者。
- `inject` 給第二參數當預設值，避免沒人 provide 時拿到 `undefined`。
- provide / inject 適合「跨多層的共用設定」（主題、語系、當前使用者）；一般父子溝通還是用 props / emit 就好，別濫用。

---

## 7. `$attrs` 透傳與 `inheritAttrs`

當父層在元件上寫了「子元件沒宣告成 prop」的屬性（例如 `class`、`id`、`data-*`、原生事件 `@click`），這些會被收進 `$attrs`，並**預設自動套到子元件的根元素**上。這叫「透傳屬性（fallthrough attributes）」。

```vue
<!-- src/components/BaseButton.vue -->
<script setup>
// 只宣告 label 這個 prop
defineProps(['label'])
</script>

<template>
  <!-- 父層傳的 class、@click 等沒宣告的屬性，會自動落到這顆 button 上 -->
  <button>{{ label }}</button>
</template>
```

```vue
<script setup>
import BaseButton from './components/BaseButton.vue'
function hi() { alert('hi') }
</script>

<template>
  <!-- class 與 @click 都不是 BaseButton 宣告的 prop → 自動透傳到內部 <button> -->
  <BaseButton label="送出" class="primary" @click="hi" />
</template>
```

上面的 `class="primary"` 和 `@click="hi"` 會自動出現在內部那顆 `<button>` 上，父層完全不用在子元件重新宣告。

### 7.1 關掉自動透傳與手動指定

如果子元件的根不是你想套屬性的那個元素（例如外面包了一層 wrapper `<div>`，你其實想把屬性套到裡面的 `<input>`），就關掉自動透傳、改手動綁：

```vue
<!-- src/components/LabeledInput.vue -->
<script setup>
// 關掉「自動把 $attrs 套到根元素」的行為
defineOptions({ inheritAttrs: false })
</script>

<template>
  <div class="field">
    <label>帳號</label>
    <!-- 手動把所有透傳屬性綁到真正該接收的元素上 -->
    <input v-bind="$attrs" />
  </div>
</template>
```

要點：

- 預設 `inheritAttrs: true`——透傳屬性自動套到**單一根元素**。
- 若元件有多個根節點，Vue 不知道套哪個，需要你手動 `v-bind="$attrs"` 指定。
- `defineOptions({ inheritAttrs: false })` 關掉自動行為，配 `v-bind="$attrs"` 精準控制落點——做「包裝原生元素」的基礎元件時很常用。

---

## 8. 對照 React：props / children / context 一覽

| Vue | React | 說明 |
|-----|-------|------|
| `defineProps` | 函式參數 `props` | 父傳子資料，皆單向唯讀 |
| `defineEmits` + `@event` | 傳 callback 當 prop（`onXxx`） | 子通知父 |
| `defineModel()` / `v-model` | 自己傳 `value` + `onChange` | 雙向綁定，Vue 有語法糖 |
| slots（`<slot>` / `#name`） | `children` / render props | 傳「一段畫面」進元件 |
| 作用域插槽 | render props（`children(data)`） | 子把資料交回給父的模板 |
| `provide` / `inject` | `Context` | 跨層級共用 |
| `$attrs` 透傳 | `{...rest}` 展開到 DOM | 未宣告屬性往下傳 |

方向都一樣：**資料往下（props）、通知往上（emit / callback）、跨層用共享機制（provide/inject / Context）**。差在 Vue 把這些做成了更明確的內建語法。

---

## 常見陷阱

1. **傳數字 / 布林忘了加 `:`**：`minutes="30"` 傳的是字串 `"30"`；要傳數字得 `:minutes="30"`。
2. **直接改 prop**：props 唯讀。要改請 emit 請父層改，或複製到本地狀態 / 用 computed 衍生。
3. **物件 / 陣列 prop 的 `default` 沒用工廠函式**：`default: []` 會讓所有實例共用同一份，必須 `default: () => []`。
4. **`v-model` 新舊寫法混用**：新專案用 `defineModel()`；別再手寫 `modelValue` + `update:modelValue`（除非維護舊碼）。兩者是同一回事。
5. **provide 可寫 ref 卻到處被改**：用 `readonly` 包住狀態，另外 provide 修改函式，把「誰能改」收斂回提供者。
6. **inject 沒給預設值**：沒人 provide 時會拿到 `undefined`。第二參數給預設值。
7. **多根元件卻期待自動透傳**：元件有多個根節點時 `$attrs` 不會自動套，需 `inheritAttrs: false` + `v-bind="$attrs"` 手動指定。

---

## 練習作業

1. 做一個 `<RatingStars :max="5" v-model="score" />` 元件：用 `defineProps` 收 `max`、用 `defineModel()` 做雙向 `score`，點星星改分數。
2. 把第 3 章的待辦清單重構成元件：`TodoInput`（emit `add` 事件）、`TodoItem`（props 收單筆、emit `toggle` / `remove`）、父層 `App` 管陣列。
3. 做一個 `<Modal>` 元件，用具名插槽開 `header` / `default` / `footer` 三個洞，父層各塞內容。
4. 做一個 `<DataList :items="...">` 用作用域插槽把每一項 `item` 綁出去，讓父層自訂每列外觀。
5. 在 `App` 用 `provide` 提供 `readonly` 的 `currentUser` 與一個 `logout` 函式，在深層子元件 `inject` 出來顯示與使用。
6. 做一個 `<BaseInput>` 包一層 `<div class="field">`，用 `inheritAttrs: false` + `v-bind="$attrs"` 讓父層傳的 `placeholder`、`@focus` 正確落到內部 `<input>`。

---

## 銜接下一章與源碼 / 全端課

到這裡，你已經掌握 Vue 的四大核心：**響應式（第 2 章）、模板與指令（第 3 章）、元件與溝通（本章）**。這正是進入本 repo 進階課程的入場券：

- 想知道 `ref`、`v-model`、slots 這些「背後怎麼實作」——接 [Vue 源碼解析課](../vue-source/README.md)。
- 想把這些元件能力用在「可上線的全端框架」——接 [Nuxt 全端課](../nuxt/README.md)（Nuxt 完全沿用本章的 `<script setup>` 元件寫法）。

接下來第 5～7 章會補上生命週期與 composables、表單與驗證、Vue Router 與 Pinia，把「能獨立做一個小專案」的最後一塊補齊。

---

## 上一章 / 下一章

- 上一章：[第 3 章：模板語法與指令](./03-template-syntax-and-directives.md)
- 下一章：[第 5 章：生命週期與 Composables](./05-lifecycle-and-composables.md)
