# 第 2 章：響應式基礎（ref / reactive / computed / watch）

> 響應式（reactivity）是 Vue 的心臟。第 1 章你已經感受過「改資料、畫面自動變」；這一章要把背後的四組工具講清楚：用 `ref` / `reactive` 宣告狀態、用 `computed` 衍生狀態、用 `watch` / `watchEffect` 對變化做副作用。
> 弄懂這一章，你就掌握了 Vue 開發八成的日常。

---

## 本章目標

完成這一章後，你應該可以：

1. 說清楚 `ref` 為什麼要 `.value`，以及為什麼在 `<template>` 裡不用寫。
2. 用 `reactive` 管理物件狀態，並解釋「解構為什麼會失去響應式」以及用 `toRefs` / `toRef` 補救。
3. 判斷什麼時候用 `ref`、什麼時候用 `reactive`。
4. 用 `computed` 寫衍生狀態（唯讀與可寫兩種）。
5. 用 `watch` 監看指定來源，並正確使用 `immediate`、`deep`、`onCleanup`。
6. 用 `watchEffect` 自動追蹤依賴，並知道它與 `watch` 的取捨。
7. 對照 React 的 `useState` / `useMemo` / `useEffect`，理解 Vue「自動追蹤、不用依賴陣列」的差別。

---

## 1. `ref`：最基本的響應式狀態

`ref()` 把一個值包成「響應式參考」。它可以裝任何型別（數字、字串、布林、物件、陣列）。

```js
import { ref } from 'vue'

const count = ref(0)
console.log(count.value)   // 0，在 JS 裡要用 .value 讀
count.value++              // 用 .value 寫
console.log(count.value)   // 1
```

### 1.1 為什麼要 `.value`？

JavaScript 的基本型別（number、string…）是「傳值」的，沒辦法在傳遞後還追蹤到「有人改了它」。Vue 的解法是把值裝進一個物件：

> `ref(0)` 其實回傳一個物件 `{ value: 0 }`，Vue 在這個物件的 `value` 屬性上裝了 getter/setter——你讀 `.value` 時它「記下是誰在用」，你寫 `.value` 時它「通知所有用到的地方更新」。

所以 `.value` 不是囉嗦，而是響應式能運作的關鍵：追蹤與觸發都掛在這個 `.value` 存取點上。

### 1.2 為什麼 `<template>` 裡不用寫 `.value`？

因為 Vue 編譯 `<template>` 時，發現你用的是 ref，就會**自動幫你解包（unwrap）**——自動補上 `.value`。這叫「頂層 ref 自動解包」。

```vue
<script setup>
import { ref } from 'vue'
const count = ref(0)
function inc() { count.value++ }   // script 裡：要 .value
</script>

<template>
  <p>{{ count }}</p>               <!-- template 裡：自動解包，不用 .value -->
  <button @click="inc">+1</button>
</template>
```

> 一句話記：**`<script>` 裡碰 ref 一律 `.value`；`<template>` 裡直接寫名字。** 忘了 `.value` 是新手第一名的 bug——例如寫成 `count++`（其實是把整個 ref 物件加 1，得到 `NaN`）。

---

## 2. `reactive`：管理物件狀態

`reactive()` 專門用來把「物件 / 陣列」變成響應式。和 `ref` 不同，它**不需要 `.value`**——你直接讀寫屬性就好。

```js
import { reactive } from 'vue'

const state = reactive({
  name: 'Gary',
  age: 30,
})

state.age++            // 直接改屬性，不用 .value
console.log(state.name)
```

它底層是用 JavaScript 的 `Proxy` 攔截整個物件的讀寫，所以增刪改屬性都能被追蹤。

### 2.1 陷阱：解構會失去響應式

這是 `reactive` 最容易踩的坑。看這段：

```js
import { reactive } from 'vue'

const state = reactive({ name: 'Gary', age: 30 })

// ❌ 解構後，name / age 變成「普通變數」，跟 state 斷了連結
const { name, age } = state
// 之後 state.age++ 不會讓 age 更新；改 age 也不會影響 state
```

原因：響應式是掛在 `state` 這個 Proxy 上的。一旦你 `const { age } = state`，`age` 拿到的只是「當下那個數字的複本」，跟 Proxy 沒關係了。

### 2.2 補救：`toRefs` 與 `toRef`

想「解構出來但保留響應式」，用 `toRefs`（整包）或 `toRef`（單一屬性）——它們把 reactive 的屬性轉成一個個 ref，連結還在：

```js
import { reactive, toRefs, toRef } from 'vue'

const state = reactive({ name: 'Gary', age: 30 })

// ✅ toRefs：整個物件的每個屬性都轉成 ref，解構後仍連動
const { name, age } = toRefs(state)
age.value++            // 這樣改，state.age 也會變成 31（它們是同一份）

// ✅ toRef：只轉單一屬性
const ageRef = toRef(state, 'age')
ageRef.value++
```

注意 `toRefs` / `toRef` 轉出來的是 **ref**，所以在 `<script>` 裡又要 `.value` 了（template 裡一樣自動解包）。

---

## 3. `ref` vs `reactive`：到底用哪個？

兩者都能做響應式，很多場景可以互換。實務上的取捨：

| 情境 | 建議 |
|------|------|
| 單一值（數字、字串、布林） | 用 `ref` |
| 要整包傳遞 / 解構 / 回傳的狀態 | 用 `ref`（`.value` 讓連結不易斷） |
| 一組關係緊密、不會被解構的物件狀態 | `reactive` 或 `ref` 皆可 |
| 需要整個換掉整包資料（`state = 新物件`） | 用 `ref`（`state.value = 新物件`；`reactive` 沒法直接重新賦值整包） |

本課與多數社群的建議是：

> **拿不定主意時，一律用 `ref`。** 它一致性最高（什麼型別都能裝）、不會有解構失去響應式的坑，代價只是多寫 `.value`。`reactive` 留給「一組固定欄位、不會整包替換、也不會解構」的表單狀態之類場景。

一個 `ref` 裝物件的例子（注意這時要 `.value` 才能改屬性）：

```js
import { ref } from 'vue'

const user = ref({ name: 'Gary', age: 30 })
user.value.age++                    // 改屬性
user.value = { name: 'Amy', age: 25 } // 整包換掉也 OK
```

---

## 4. `computed`：衍生狀態

當一個值是「從其他響應式狀態算出來的」，用 `computed`，不要自己手動同步。它會**快取結果**，只有依賴變了才重算。

### 4.1 唯讀 computed（最常用）

```vue
<script setup>
import { ref, computed } from 'vue'

const firstName = ref('Gary')
const lastName = ref('Cai')

// fullName 依賴 firstName / lastName，任一改變就自動重算
const fullName = computed(() => `${firstName.value} ${lastName.value}`)
</script>

<template>
  <input v-model="firstName" />
  <input v-model="lastName" />
  <p>全名：{{ fullName }}</p>
</template>
```

`computed` 回傳的也是一個 ref，所以 `<script>` 裡讀它要 `fullName.value`，`<template>` 裡自動解包。

> 為什麼不直接在 template 寫 `{{ firstName + ' ' + lastName }}`？短的可以。但邏輯一長、或多處要用同一個衍生值時，`computed` 更清楚，而且**有快取**：依賴沒變就不重算。

### 4.2 可寫 computed

`computed` 也能雙向——傳一個含 `get` 和 `set` 的物件。適合「對外呈現一種格式、對內拆成多個狀態」的場景：

```vue
<script setup>
import { ref, computed } from 'vue'

const firstName = ref('Gary')
const lastName = ref('Cai')

const fullName = computed({
  get: () => `${firstName.value} ${lastName.value}`,
  set: (val) => {
    // 有人設定 fullName 時，反解回 firstName / lastName
    [firstName.value, lastName.value] = val.split(' ')
  },
})

function rename() {
  fullName.value = 'Amy Wang'   // 觸發 set，firstName='Amy'、lastName='Wang'
}
</script>

<template>
  <p>{{ fullName }}</p>
  <button @click="rename">改名</button>
</template>
```

### 4.3 對照 React：`computed` ≈ `useMemo`，但更省事

React 要寫 `const fullName = useMemo(() => a + b, [a, b])`——你得**手動列依賴陣列** `[a, b]`，列漏了就會拿到過期值。Vue 的 `computed` **自動追蹤**你在函式裡用到了哪些響應式狀態，不用也不能列依賴。這是 Vue 響應式最舒服的地方之一。

---

## 5. `watch`：監看指定來源、做副作用

`computed` 是「算出新值」；`watch` 是「當某個東西變了，去做一件事」（送 API、寫 localStorage、手動操作等副作用）。

### 5.1 基本用法：監看單一來源

```vue
<script setup>
import { ref, watch } from 'vue'

const keyword = ref('')

// 第一參數：要監看的來源；第二參數：變化時要跑的 callback
watch(keyword, (newVal, oldVal) => {
  console.log(`關鍵字從「${oldVal}」變成「${newVal}」`)
  // 這裡可以送搜尋 API…
})
</script>

<template>
  <input v-model="keyword" placeholder="輸入看 console" />
</template>
```

### 5.2 來源的幾種型別

`watch` 的第一個參數（來源）可以是：

```js
import { ref, reactive, watch } from 'vue'

const count = ref(0)
const state = reactive({ age: 30 })

// ① 一個 ref
watch(count, (n, o) => { /* ... */ })

// ② 一個 getter 函式（監看「運算式的結果」，最常用於 reactive 的某屬性）
watch(() => state.age, (n, o) => { /* ... */ })

// ③ 多個來源組成的陣列（任一變都觸發）
watch([count, () => state.age], ([c, a], [pc, pa]) => { /* ... */ })
```

> 常見錯誤：想監看 reactive 的某個屬性，寫成 `watch(state.age, ...)`——這是把「當下那個數字」傳進去，之後不會觸發。**正確是傳 getter：`watch(() => state.age, ...)`。**

### 5.3 選項：`immediate` 與 `deep`

`watch` 預設**只有來源變化才觸發**，一開始不會跑。兩個常用選項：

```vue
<script setup>
import { ref, watch } from 'vue'

const userId = ref(1)
const settings = ref({ theme: 'light', font: { size: 14 } })

// immediate: true → 建立時就先跑一次（例如「進頁面就先抓一次資料」）
watch(userId, (id) => {
  console.log('去抓 user', id)
}, { immediate: true })

// deep: true → 深層監看巢狀物件的內部變化
watch(settings, () => {
  console.log('settings 內部有變')
}, { deep: true })

function changeFont() {
  settings.value.font.size++   // 沒有 deep 的話，改「內層」不會觸發
}
</script>

<template>
  <button @click="changeFont">改字級</button>
</template>
```

- `immediate: true`：建立 watch 時立刻執行一次 callback，之後照常。
- `deep: true`：連物件內部深層屬性的變化也監看（有效能成本，物件大時要留意）。

> 提醒：直接 `watch` 一個「裝物件的 ref」時，若你是**改內部屬性**（`settings.value.font.size++`），需要 `deep`；若你是**整包替換**（`settings.value = {...}`），不需要 `deep` 也會觸發。

### 5.4 清理副作用：`onCleanup`

當 watch 觸發得很頻繁（例如每次打字都送搜尋），前一次還沒回來、下一次又發了，就會有「競態（race condition）」——舊請求比新請求晚回來，蓋掉正確結果。`watch` 的 callback 第三個參數 `onCleanup` 讓你在「下一次觸發前 / 元件卸載時」清掉上一次的副作用：

```vue
<script setup>
import { ref, watch } from 'vue'

const keyword = ref('')
const result = ref('')

watch(keyword, async (kw, _old, onCleanup) => {
  if (!kw) return
  const controller = new AbortController()
  // 下次觸發前先取消上一個請求，避免舊結果蓋掉新結果
  onCleanup(() => controller.abort())

  const res = await fetch(`/api/search?q=${kw}`, { signal: controller.signal })
  result.value = await res.text()
})
</script>

<template>
  <input v-model="keyword" />
  <p>{{ result }}</p>
</template>
```

---

## 6. `watchEffect`：自動追蹤依賴的副作用

`watchEffect` 和 `watch` 都是做副作用，但用法不同：

> **`watch` 要你「明講監看誰」；`watchEffect` 會「自動追蹤 callback 裡用到的所有響應式狀態」，任一變化就重跑。**

```vue
<script setup>
import { ref, watchEffect } from 'vue'

const a = ref(1)
const b = ref(2)

// 建立時立刻跑一次；之後只要 a 或 b 變，就自動重跑（不用列依賴）
watchEffect(() => {
  console.log(`a + b = ${a.value + b.value}`)
})

// watchEffect 一樣支援 onCleanup（callback 的第一個參數）
watchEffect((onCleanup) => {
  const timer = setInterval(() => console.log('tick', a.value), 1000)
  onCleanup(() => clearInterval(timer))
})
</script>

<template>
  <button @click="a++">a: {{ a }}</button>
  <button @click="b++">b: {{ b }}</button>
</template>
```

### 6.1 `watch` vs `watchEffect` 怎麼選？

| | `watch` | `watchEffect` |
|---|---|---|
| 依賴來源 | 你明確指定 | 自動追蹤 callback 內用到的狀態 |
| 初始是否執行 | 預設否（要 `immediate`） | 是，建立時立刻跑一次 |
| 拿得到新舊值 | 拿得到 `(newVal, oldVal)` | 拿不到舊值 |
| 適合場景 | 「特定狀態變 → 做某事」、需要舊值、需要精準控制 | 「一段邏輯依賴多個狀態，全部都想跟」 |

> 選擇原則：**需要舊值、或想精準只監看某幾個來源 → 用 `watch`；一段副作用同時依賴好幾個狀態、你懶得一一列 → 用 `watchEffect`。**

### 6.2 對照 React：`watch/watchEffect` ≈ `useEffect`，但不用依賴陣列

React 的 `useEffect(fn, [a, b])` 靠**手動依賴陣列**決定何時重跑，列錯就出 bug（過期閉包、無限迴圈都源自這裡）。Vue 兩者都是**自動追蹤**，沒有依賴陣列這回事：

- `watchEffect` ≈ `useEffect` 但自動抓依賴。
- `watch(src, cb)` ≈ 「只在 `src` 變化時跑的 `useEffect`」，且天生給你新舊值。
- 清理副作用：Vue 用 `onCleanup(...)`，React 用 `return () => {...}`——概念相同。

---

## 7. 綜合範例：一個可跑的響應式小面板

把本章工具串起來。原樣建立 `src/App.vue`：一個購物小計面板，示範 `ref`、`reactive` + `toRefs`、`computed`、`watch`。

```vue
<script setup>
import { ref, reactive, toRefs, computed, watch } from 'vue'

// ref：單一值
const taxRate = ref(0.05)

// reactive：一組表單狀態（不會整包替換，適合 reactive）
const form = reactive({
  price: 100,
  quantity: 1,
})
// 解構要保留響應式 → toRefs
const { price, quantity } = toRefs(form)

// computed：衍生狀態（自動追蹤，不用列依賴）
const subtotal = computed(() => price.value * quantity.value)
const total = computed(() => Math.round(subtotal.value * (1 + taxRate.value)))

// watch：金額變動時記錄（真實情境可能是寫 localStorage 或送 API）
watch(total, (newTotal, oldTotal) => {
  console.log(`總額 ${oldTotal} → ${newTotal}`)
}, { immediate: true })
</script>

<template>
  <main class="panel">
    <h1>購物小計</h1>

    <label>單價：<input type="number" v-model.number="price" /></label>
    <label>數量：<input type="number" v-model.number="quantity" /></label>
    <label>稅率：<input type="number" step="0.01" v-model.number="taxRate" /></label>

    <hr />
    <p>小計：{{ subtotal }}</p>
    <p class="total">含稅總額：{{ total }}</p>
  </main>
</template>

<style scoped>
.panel {
  max-width: 420px;
  margin: 48px auto;
  padding: 20px;
  font-family: -apple-system, "Segoe UI", sans-serif;
  border: 1px solid #e5e7eb;
  border-radius: 14px;
  line-height: 2;
}
label { display: block; }
input { width: 100px; margin-left: 8px; }
.total { font-size: 20px; font-weight: 700; color: #369a6e; }
</style>
```

（`v-model.number` 讓輸入自動轉數字，`v-model` 的細節在第 3 章與第 6 章。）打開後改任一輸入框，小計與總額會自動重算，console 也會印出總額變化——這就是 `computed`（衍生）與 `watch`（副作用）分工的實際樣子。

---

## 常見陷阱

1. **忘記 `.value`**：`<script>` 裡 `ref` 一律 `.value`。寫 `count++`（漏 `.value`）會把 ref 物件當數字加，得到 `NaN`。
2. **解構 `reactive` 失去響應式**：`const { age } = state` 會斷連結。要嘛用 `toRefs` / `toRef`，要嘛整包用 `state.age` 不解構。
3. **`watch` reactive 屬性沒用 getter**：`watch(state.age, ...)` 無效，必須 `watch(() => state.age, ...)`。
4. **改物件內層卻沒設 `deep`**：`watch` 一個裝物件的來源、又只改內部屬性時，要 `{ deep: true }` 才會觸發。
5. **把該用 `computed` 的東西塞進 `watch`**：如果只是「A 變了要算出 B」，用 `computed`（有快取、宣告式）；`watch` 是拿來做「副作用」的，不要用它手動同步一個衍生值。
6. **`reactive` 整包重新賦值**：`state = { ... }` 會直接斷掉響應式。需要整包替換的資料請改用 `ref`，寫 `state.value = { ... }`。

---

## 練習作業

1. 用 `ref` 做一個攝氏/華氏換算器：輸入攝氏，用 `computed` 算出華氏並顯示。
2. 把上題改成「可寫 computed」：輸入華氏也能反算攝氏（雙向）。
3. 用 `reactive` 建一個 `form = { username, email }`，用 `toRefs` 解構到 template；再用 `computed` 做一個 `isValid`（兩欄都非空才 true）。
4. 用 `watch` 監看 `username`，`{ immediate: true }`，每次變動印出新舊值。
5. 把第 5.4 節的搜尋範例改成用 `watchEffect` 寫寫看，體會「不用明列來源」與「拿不到舊值」的差別，並說出這題該用哪個比較適合。

---

## 上一章 / 下一章

- 上一章：[第 1 章：Vue 是什麼與環境建立](./01-intro-and-setup.md)
- 下一章：[第 3 章：模板語法與指令](./03-template-syntax-and-directives.md)
