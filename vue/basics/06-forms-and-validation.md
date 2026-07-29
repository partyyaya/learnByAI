# 第 6 章：表單與驗證

表單是幾乎每個應用都逃不掉的東西：登入、註冊、搜尋、結帳。它同時考驗你對「雙向綁定」「衍生狀態」「副作用」的理解，所以是驗收前幾章的好題目。

好消息是：Vue 的 `v-model` 讓表單綁定比 React 少寫非常多樣板碼。這一章我們先把 `v-model` 在各種表單元素上的用法一次講齊，接著用第 5 章學到的 composable 技巧，把驗證邏輯抽成 `useForm`/`useField` 重用，最後做一個完整、可跑、會送到後端的註冊表單。

## 本章目標

完成這一章後，你應該可以：

1. 在文字框、`textarea`、`checkbox`、`radio`、`select`（單/多選）上正確使用 `v-model`。
2. 用 `.lazy` / `.number` / `.trim` 修飾符調整綁定行為。
3. 用 `reactive` 管理多欄位表單，並用 `computed` 算出即時錯誤。
4. 做出「碰過才顯示錯誤（touched）」「送出前全面檢查」的驗證體驗。
5. 把驗證抽成可重用的 `useForm`/`useField` composable。
6. 送出表單到後端並正確處理 loading / error / 成功三種狀態。

---

## 1. 心智模型：`v-model` 是雙向綁定的語法糖

先跟 React 對照，你會秒懂。React 的表單是**受控元件**：值來自 state，改變要自己寫 `onChange` 同步回去，兩件事都得手動接：

```jsx
// React：value 進、onChange 出，兩條線都要自己接
const [text, setText] = useState("")
<input value={text} onChange={(e) => setText(e.target.value)} />
```

Vue 的 `v-model` 把「進」和「出」兩條線一次接好：

```vue
<script setup>
import { ref } from 'vue'
const text = ref('')
</script>

<template>
  <input v-model="text" />
  <p>你輸入了：{{ text }}</p>
</template>
```

`v-model` 其實只是這段的簡寫（知道原理，才知道修飾符在改什麼）：

```vue
<!-- v-model="text" 等同於： -->
<input :value="text" @input="text = $event.target.value" />
```

> 心法：**React 是「受控元件，兩條線手動接」；Vue 是「v-model 一條指令雙向綁」。** 本質一樣（都是狀態驅動畫面），Vue 只是幫你把樣板碼收掉了。第 4 章你已看過 `v-model` 用在自訂元件上；這章聚焦原生表單元素。

---

## 2. `v-model` 全套：各種表單元素

不同表單元素綁出來的資料型別不同，這是最容易搞混的地方。逐一看：

### 2.1 文字輸入與 `textarea`

```vue
<script setup>
import { ref } from 'vue'
const name = ref('')
const bio = ref('')
</script>

<template>
  <input v-model="name" placeholder="姓名" />
  <textarea v-model="bio" placeholder="自我介紹"></textarea>
</template>
```

> `textarea` 用 `v-model`，不要在標籤中間寫 `{{ }}`。

### 2.2 checkbox：單一布林 vs 綁陣列

**單一 checkbox** 綁到布林值（勾/不勾）：

```vue
<script setup>
import { ref } from 'vue'
const agreed = ref(false)
</script>

<template>
  <label><input type="checkbox" v-model="agreed" /> 我同意條款</label>
  <p>{{ agreed ? '已同意' : '尚未同意' }}</p>
</template>
```

**多個 checkbox 綁同一個陣列**，勾選的 `value` 會被收進陣列：

```vue
<script setup>
import { ref } from 'vue'
const langs = ref([]) // 例如勾兩個後：['js', 'ts']
</script>

<template>
  <label><input type="checkbox" value="js" v-model="langs" /> JavaScript</label>
  <label><input type="checkbox" value="ts" v-model="langs" /> TypeScript</label>
  <label><input type="checkbox" value="py" v-model="langs" /> Python</label>
  <p>已選：{{ langs }}</p>
</template>
```

### 2.3 radio

同名的一組 radio 綁同一個變數，值是被選中那顆的 `value`：

```vue
<script setup>
import { ref } from 'vue'
const plan = ref('free')
</script>

<template>
  <label><input type="radio" value="free" v-model="plan" /> 免費</label>
  <label><input type="radio" value="pro" v-model="plan" /> 專業</label>
  <p>方案：{{ plan }}</p>
</template>
```

### 2.4 select：單選與多選

單選 `select`，值是被選項的值：

```vue
<script setup>
import { ref } from 'vue'
const city = ref('')
</script>

<template>
  <select v-model="city">
    <option disabled value="">請選擇城市</option>
    <option value="tpe">台北</option>
    <option value="txg">台中</option>
    <option value="khh">高雄</option>
  </select>
  <p>城市：{{ city }}</p>
</template>
```

> 放一個 `disabled value=""` 的預設項，能避免「沒選」時綁到第一個選項的坑。

多選 `select`（加 `multiple`），綁到陣列：

```vue
<script setup>
import { ref } from 'vue'
const cities = ref([])
</script>

<template>
  <select v-model="cities" multiple>
    <option value="tpe">台北</option>
    <option value="txg">台中</option>
    <option value="khh">高雄</option>
  </select>
  <p>已選：{{ cities }}</p>
</template>
```

一張表收好綁出來的型別：

| 元素 | `v-model` 綁出來的型別 |
|------|----------------------|
| `input`（text）/ `textarea` | 字串 |
| 單一 `checkbox` | 布林 |
| 多個 `checkbox`（共用一變數） | 陣列 |
| `radio` | 被選中那顆的 `value` |
| `select` 單選 | 被選項的值 |
| `select multiple` | 陣列 |

---

## 3. 修飾符：`.lazy` / `.number` / `.trim`

`v-model` 後面接修飾符可微調行為，很常用：

```vue
<script setup>
import { ref } from 'vue'
const search = ref('')
const age = ref(0)
const account = ref('')
</script>

<template>
  <!-- .lazy：改在 change 事件才同步（失焦或按 Enter），而非每次 input -->
  <input v-model.lazy="search" />

  <!-- .number：自動把字串轉成數字（表單輸入預設都是字串） -->
  <input v-model.number="age" type="number" />

  <!-- .trim：自動去掉頭尾空白 -->
  <input v-model.trim="account" />
</template>
```

| 修飾符 | 作用 | 常見場景 |
|--------|------|---------|
| `.lazy` | 由 `input` 改為 `change` 時才同步 | 不需要即時更新、想少觸發 |
| `.number` | 值轉成數字型別 | 數量、年齡、價格 |
| `.trim` | 去除頭尾空白 | 帳號、Email、搜尋字 |

> `.number` 很重要：沒有它，`<input type="number">` 綁出來仍是**字串** `"18"`，做數字比較或送後端時容易踩雷。

---

## 4. 多欄位表單用 `reactive` 管理

欄位一多，與其宣告一堆 `ref`，不如用一個 `reactive` 物件集中管理，`v-model` 直接綁物件屬性：

```vue
<script setup>
import { reactive } from 'vue'

const form = reactive({
  email: '',
  password: '',
  plan: 'free',
  agree: false,
})
</script>

<template>
  <input v-model.trim="form.email" placeholder="Email" />
  <input v-model="form.password" type="password" placeholder="密碼" />
  <select v-model="form.plan">
    <option value="free">免費</option>
    <option value="pro">專業</option>
  </select>
  <label><input type="checkbox" v-model="form.agree" /> 我同意條款</label>
</template>
```

> 對照 React：那邊你要寫 `setForm((prev) => ({ ...prev, email: e.target.value }))` 手動展開合併；Vue 的 `reactive` 物件可直接 `form.email = '...'`，`v-model` 幫你做掉了。

---

## 5. 手寫表單驗證

驗證不用套件也能寫得乾淨。核心觀念只有一個：**錯誤訊息是「從表單資料推導出來的衍生狀態」，所以用 `computed` 算，不要另外拿 state 存一份。**

### 5.1 用 `computed` 算 errors

```vue
<script setup>
import { reactive, computed } from 'vue'

const form = reactive({ email: '', password: '' })

// errors 完全由 form 推導；form 一變，errors 自動重算（不用手動同步）
const errors = computed(() => {
  const e = {}
  if (!form.email) e.email = 'Email 必填'
  else if (!/^[^@]+@[^@]+\.[^@]+$/.test(form.email)) e.email = 'Email 格式不正確'

  if (!form.password) e.password = '密碼必填'
  else if (form.password.length < 6) e.password = '密碼至少 6 碼'

  return e
})

const isValid = computed(() => Object.keys(errors.value).length === 0)
</script>
```

### 5.2 `touched`：碰過才報錯

一進頁面就滿江紅的紅字體驗很差。慣例是「使用者碰過（失焦）某欄位，才顯示它的錯誤」，這個「碰過」狀態叫 **touched**：

```vue
<script setup>
import { reactive, computed } from 'vue'

const form = reactive({ email: '', password: '' })
const touched = reactive({ email: false, password: false })

const errors = computed(() => {
  const e = {}
  if (!form.email) e.email = 'Email 必填'
  else if (!/^[^@]+@[^@]+\.[^@]+$/.test(form.email)) e.email = 'Email 格式不正確'
  if (!form.password) e.password = '密碼必填'
  else if (form.password.length < 6) e.password = '密碼至少 6 碼'
  return e
})
const isValid = computed(() => Object.keys(errors.value).length === 0)

function handleSubmit() {
  // 送出前，把所有欄位都標記為碰過，讓漏填的欄位也亮紅字
  touched.email = true
  touched.password = true
  if (!isValid.value) return
  console.log('通過驗證，準備送出', { ...form })
}
</script>

<template>
  <form @submit.prevent="handleSubmit">
    <div>
      <input
        v-model.trim="form.email"
        placeholder="Email"
        @blur="touched.email = true"
      />
      <!-- 碰過 + 有錯，才顯示 -->
      <small v-if="touched.email && errors.email">{{ errors.email }}</small>
    </div>

    <div>
      <input
        v-model="form.password"
        type="password"
        placeholder="密碼"
        @blur="touched.password = true"
      />
      <small v-if="touched.password && errors.password">{{ errors.password }}</small>
    </div>

    <!-- 有錯就禁用送出鈕 -->
    <button type="submit" :disabled="!isValid">註冊</button>
  </form>
</template>
```

> 注意 `@submit.prevent`：`.prevent` 修飾符等同於 `event.preventDefault()`，擋掉表單送出時的整頁刷新（對照 React 的 `e.preventDefault()`）。

---

## 6. 抽成 `useForm` / `useField` composable 重用

上面每個表單都要重寫 `form`/`touched`/`errors`/`isValid` 很煩。用第 5 章的技巧把它抽成一組 composable，之後任何表單只要「給初始值 + 給規則」就行。

先寫一組**驗證規則工廠**（每個規則是「值 → 錯誤訊息或空字串」的函式）：

```js
// composables/validators.js
export const required = (msg = '此欄位必填') => (v) =>
  v === '' || v == null || v === false ? msg : ''

export const minLength = (n, msg) => (v) =>
  String(v).length < n ? (msg || `至少需 ${n} 個字`) : ''

export const email = (msg = 'Email 格式不正確') => (v) =>
  /^[^@]+@[^@]+\.[^@]+$/.test(v) ? '' : msg

// 跨欄位比對：確認密碼要等於 password。第二參數 all 是整個表單物件
export const sameAs = (field, msg = '兩次輸入不一致') => (v, all) =>
  v === all[field] ? '' : msg
```

再寫 `useForm`：接收「初始值」與「每個欄位的規則陣列」，回傳 `values`/`touched`/`errors`/`isValid` 與幾個操作函式：

```js
// composables/useForm.js
import { reactive, computed } from 'vue'

export function useForm(initial, rules = {}) {
  const values = reactive({ ...initial })
  const touched = reactive(
    Object.fromEntries(Object.keys(initial).map((k) => [k, false]))
  )

  // 依 rules 逐欄套規則，回傳第一個不通過的訊息
  const errors = computed(() => {
    const result = {}
    for (const field in rules) {
      for (const rule of rules[field]) {
        const msg = rule(values[field], values)
        if (msg) {
          result[field] = msg
          break // 一個欄位只報第一個錯就好
        }
      }
    }
    return result
  })

  const isValid = computed(() => Object.keys(errors.value).length === 0)

  const touch = (field) => (touched[field] = true)
  const touchAll = () => Object.keys(touched).forEach((k) => (touched[k] = true))
  const reset = () => {
    Object.assign(values, initial)
    Object.keys(touched).forEach((k) => (touched[k] = false))
  }

  return { values, touched, errors, isValid, touch, touchAll, reset }
}
```

> `useField` 概念：如果你想更細到「單一欄位自帶 value/error/touched」，可以再抽一層。但實務上 `useForm`（管整張表）＋ validators（管單條規則）這個組合最好用，所以本課以它為主；把單一欄位的綁定包成小元件即可達到 `useField` 想要的重用效果（見最後範例的 `<FormField>`）。

這裡再次體現第 5 章的重點：`errors` 是 `computed`，**只要 `values` 變就自動重算**，你完全不用手動同步、也沒有依賴陣列——這是 Vue 響應式相對 React 手動維護的優勢。

---

## 7. 送出到後端：處理 loading / error / 成功

送出通常是非同步的，要管三個狀態：送出中（避免重複點）、失敗（顯示錯誤）、成功（給回饋、清表單）。

```js
import { ref } from 'vue'

const submitting = ref(false)
const submitError = ref('')
const done = ref(false)

async function submit(payload) {
  submitting.value = true
  submitError.value = ''
  try {
    const res = await fetch('https://jsonplaceholder.typicode.com/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) throw new Error(`伺服器回應 ${res.status}`)
    done.value = true
  } catch (e) {
    submitError.value = e.message
  } finally {
    submitting.value = false // 不管成敗都要解除送出中
  }
}
```

> 這裡用瀏覽器原生 `fetch`（純 Vue + Vite 環境）。到了 Nuxt，你會改用內建的 `$fetch`／`useFetch`（第 7 章末會銜接），API 更順、還自動處理 SSR，但心智模型一樣是「送出中 / 錯誤 / 成功」三態。

---

## 常見陷阱

1. **`<input type="number">` 忘了 `.number`**：綁出來是字串 `"18"` 不是數字 `18`，數字比較與送後端都會出錯。
2. **把 errors 存成 state 再手動同步**：例如 `const [errors, setErrors] = ...` 然後每次 change 都 `setErrors(...)`。錯誤是衍生狀態，用 `computed` 算，讓它自己跟著資料變。
3. **一進頁面就報一堆錯**：沒做 `touched`。應該「碰過（失焦）才顯示該欄錯誤」，送出時再 `touchAll` 把漏填的也亮出來。
4. **忘了擋整頁刷新**：`<form>` 的預設送出會重新整理頁面，記得 `@submit.prevent`。
5. **多個 checkbox 想收成陣列，卻忘了給每顆 `value`**：沒有 `value` 的 checkbox 綁陣列時無法辨識是哪一項。
6. **`finally` 沒解除 `submitting`**：只在 `try` 成功時把 `submitting` 設回 false，一旦丟錯就會卡在「送出中」永遠點不了。把它放 `finally`。
7. **`select` 沒放預設 disabled 選項**：使用者「還沒選」時會被當成選了第一項，必填驗證形同虛設。

---

## 練習作業

1. 幫 5.2 的表單加上「確認密碼」欄位，用 `sameAs('password')` 規則驗證兩次輸入一致。
2. 用 `useForm` + validators 重寫上題，體會「只給初始值和規則」有多省。
3. 做一個「興趣多選（checkbox 陣列）＋至少選 2 項」的驗證：寫一條 `minSelected(2)` 規則。
4. 幫送出鈕加上送出中狀態：`submitting` 為 true 時鈕顯示「送出中…」並 `disabled`。
5. 進階：把單一欄位（label + input + 錯誤訊息 + blur 標記 touched）包成 `<FormField>` 元件，讓最後範例的 template 更精簡（這就是 `useField` 想達到的重用）。

---

## 最後範例：完整可跑的註冊表單

整合本章全部觀念：`reactive` 多欄位、`v-model` 各型別、修飾符、`useForm` + validators 驗證、touched 體驗、送出到後端三態。原樣建立以下檔案即可跑。

### `src/composables/validators.js`

```js
export const required = (msg = '此欄位必填') => (v) =>
  v === '' || v == null || v === false ? msg : ''

export const minLength = (n, msg) => (v) =>
  String(v).length < n ? (msg || `至少需 ${n} 個字`) : ''

export const email = (msg = 'Email 格式不正確') => (v) =>
  /^[^@]+@[^@]+\.[^@]+$/.test(v) ? '' : msg

export const sameAs = (field, msg = '兩次輸入不一致') => (v, all) =>
  v === all[field] ? '' : msg
```

### `src/composables/useForm.js`

```js
import { reactive, computed } from 'vue'

export function useForm(initial, rules = {}) {
  const values = reactive({ ...initial })
  const touched = reactive(
    Object.fromEntries(Object.keys(initial).map((k) => [k, false]))
  )

  const errors = computed(() => {
    const result = {}
    for (const field in rules) {
      for (const rule of rules[field]) {
        const msg = rule(values[field], values)
        if (msg) {
          result[field] = msg
          break
        }
      }
    }
    return result
  })

  const isValid = computed(() => Object.keys(errors.value).length === 0)

  const touch = (field) => (touched[field] = true)
  const touchAll = () => Object.keys(touched).forEach((k) => (touched[k] = true))
  const reset = () => {
    Object.assign(values, initial)
    Object.keys(touched).forEach((k) => (touched[k] = false))
  }

  return { values, touched, errors, isValid, touch, touchAll, reset }
}
```

### `src/App.vue`

```vue
<script setup>
import { ref } from 'vue'
import { useForm } from './composables/useForm'
import { required, minLength, email, sameAs } from './composables/validators'

const { values, touched, errors, isValid, touch, touchAll, reset } = useForm(
  { name: '', email: '', password: '', confirm: '', plan: 'free', agree: false },
  {
    name: [required('請填姓名'), minLength(2)],
    email: [required('請填 Email'), email()],
    password: [required('請填密碼'), minLength(6, '密碼至少 6 碼')],
    confirm: [required('請再輸入一次密碼'), sameAs('password')],
    agree: [required('請先同意條款')],
  }
)

const submitting = ref(false)
const submitError = ref('')
const done = ref(false)

async function handleSubmit() {
  touchAll()
  if (!isValid.value) return

  submitting.value = true
  submitError.value = ''
  try {
    const res = await fetch('https://jsonplaceholder.typicode.com/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    })
    if (!res.ok) throw new Error(`伺服器回應 ${res.status}`)
    done.value = true
    reset()
  } catch (e) {
    submitError.value = e.message
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <main class="page">
    <h1>第 6 章最終範例：註冊表單</h1>

    <p v-if="done" class="ok">註冊成功！（示範 API，資料不會真的儲存）</p>

    <form class="card" @submit.prevent="handleSubmit">
      <div class="field">
        <label>姓名</label>
        <input v-model.trim="values.name" @blur="touch('name')" />
        <small v-if="touched.name && errors.name">{{ errors.name }}</small>
      </div>

      <div class="field">
        <label>Email</label>
        <input v-model.trim="values.email" @blur="touch('email')" />
        <small v-if="touched.email && errors.email">{{ errors.email }}</small>
      </div>

      <div class="field">
        <label>密碼</label>
        <input v-model="values.password" type="password" @blur="touch('password')" />
        <small v-if="touched.password && errors.password">{{ errors.password }}</small>
      </div>

      <div class="field">
        <label>確認密碼</label>
        <input v-model="values.confirm" type="password" @blur="touch('confirm')" />
        <small v-if="touched.confirm && errors.confirm">{{ errors.confirm }}</small>
      </div>

      <div class="field">
        <label>方案</label>
        <select v-model="values.plan">
          <option value="free">免費</option>
          <option value="pro">專業</option>
        </select>
      </div>

      <div class="field">
        <label class="inline">
          <input type="checkbox" v-model="values.agree" @change="touch('agree')" />
          我同意服務條款
        </label>
        <small v-if="touched.agree && errors.agree">{{ errors.agree }}</small>
      </div>

      <p v-if="submitError" class="err">送出失敗：{{ submitError }}</p>

      <button type="submit" :disabled="submitting">
        {{ submitting ? '送出中…' : '註冊' }}
      </button>
    </form>

    <pre class="debug">目前表單值：{{ values }}</pre>
  </main>
</template>

<style>
body { margin: 0; font-family: -apple-system, "Segoe UI", sans-serif; background: #f3f4f6; }
.page { width: min(520px, 100%); margin: 36px auto; padding: 0 16px; }
.card { background: #fff; border-radius: 14px; padding: 20px; box-shadow: 0 8px 24px rgba(17,24,39,.08); }
.field { margin-bottom: 14px; display: flex; flex-direction: column; gap: 4px; }
.field label { font-weight: 600; font-size: 14px; }
.field label.inline { flex-direction: row; align-items: center; gap: 6px; font-weight: 400; }
.field input:not([type="checkbox"]), .field select { border: 1px solid #d1d5db; border-radius: 8px; padding: 8px 10px; }
small { color: #dc2626; font-size: 12px; }
button { border: none; background: #2563eb; color: #fff; border-radius: 8px; padding: 10px 16px; cursor: pointer; width: 100%; }
button:disabled { opacity: .6; cursor: not-allowed; }
.ok { color: #16a34a; font-weight: 600; }
.err { color: #dc2626; }
.debug { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px; font-size: 12px; color: #6b7280; overflow: auto; }
</style>
```

### 範例解釋

1. `useForm` 讓 `App.vue` 只需宣告「初始值 + 規則」，驗證細節全在 composable 裡，換個表單直接重用。
2. `errors` 是 `computed`：使用者一邊打字，錯誤訊息即時重算，完全不用手動同步。
3. `touched` 控制「碰過才報錯」，送出時 `touchAll()` 讓漏填欄位一併亮紅字。
4. 送出走 `submitting`/`submitError`/`done` 三態，`finally` 保證「送出中」一定會解除。
5. 底部的 `<pre>{{ values }}</pre>` 讓你即時看到綁定結果——`.number`/`.trim`/checkbox 陣列的效果一目了然。

---

你已經能做出體驗完整、邏輯可重用的表單。下一章是本課的收尾：用 **Vue Router** 讓應用有多個頁面、用 **Pinia** 管跨頁共享狀態，並把前六章整合成一個迷你 SPA。

---

## 上一章 / 下一章

- 上一章：[第 5 章：生命週期與 Composables](./05-lifecycle-and-composables.md)
- 下一章：[第 7 章：Vue Router 與 Pinia](./07-router-and-pinia.md)
