# 第 8 章：用 Vitest 測試 Vue

前七章我們寫了不少東西：響應式狀態、元件、表單驗證、composable、Pinia store、路由守衛。到目前為止，確認「有沒有寫壞」的方法只有一個——**打開瀏覽器自己點**。

專案小的時候這樣沒問題。但當你有 20 個元件、5 個頁面、一堆互相影響的狀態時，改一行程式碼要手動回歸測試整站，成本高到你會乾脆不改——這就是專案開始腐爛的起點。

自動化測試解決的正是這件事：**把「我點過了，沒壞」變成一道跑一秒就有答案的指令**。這一章我們用 Vue 生態的標準組合 **Vitest + Vue Test Utils**，從一個純函式測起，一路測到元件互動、非同步請求、Pinia store 與路由守衛。

## 本章目標

完成這一章後，你應該可以：

1. 說出單元測試、元件測試、E2E 測試各測什麼，以及該把力氣放哪。
2. 在 Vite 專案裡設定 Vitest + Vue Test Utils + jsdom，並跑起第一個測試。
3. 測純函式與 composable（`useForm`、`useFetch`）。
4. 用 `mount` 測元件的 props、畫面、事件（`emitted`）與 `v-model`。
5. 用 `vi.fn()` / `vi.stubGlobal()` 假造 `fetch`，測非同步狀態。
6. 測 Pinia store，以及「元件 + store」一起跑的情境。
7. 用 memory history 測路由與登入守衛。
8. 判斷什麼該測、什麼不該測，並看懂覆蓋率報告。

---

## 1. 測試在測什麼：行為，不是實作

初學者寫測試最常見的失敗，是把測試綁在**實作細節**上：

```js
// ❌ 綁實作：內部改用別的變數名、把 ref 換成 computed，測試就掛了
expect(wrapper.vm.internalCount).toBe(1)
```

```js
// ✅ 綁行為：使用者點了按鈕，畫面上就該出現 1
await wrapper.get('button').trigger('click')
expect(wrapper.text()).toContain('1')
```

一個好測試的判準是：**重構（改寫法但不改行為）時它不該壞；改壞功能時它一定要壞。** 綁實作的測試兩邊都做不到——重構會誤報，而且它保證的只是「內部長這樣」，不是「使用者拿到正確的東西」。

所以本章的每個測試都盡量從外面看：**給定什麼 props / 什麼操作 → 畫面顯示什麼、發出什麼事件、狀態變成什麼**。

## 2. 三種測試與本章範圍

| 種類 | 測什麼 | 跑多快 | 本課 |
|------|--------|--------|------|
| **單元測試** | 一個函式 / 一個 composable / 一個 store | 毫秒級 | ✅ 主力 |
| **元件測試** | 一個元件掛起來後的行為（props、事件、畫面） | 數十毫秒 | ✅ 主力 |
| **E2E 測試** | 真的開瀏覽器走完整流程（登入 → 發文 → 看到文章） | 秒～分鐘級 | ⏭ 見下方 |

比例上的實務原則：**純邏輯盡量往單元測試推**（快、穩、好寫），**元件測試測互動與畫面**，**E2E 只留給少數關鍵路徑**（登入、結帳這種壞掉就完蛋的流程）。E2E 慢又容易因為時序而不穩，寫太多會拖垮開發節奏。

> E2E 不在本章範圍，但本 repo 有：Nuxt 課[第 15 章](../nuxt/15-performance-caching-testing.md)用 `@nuxt/test-utils/e2e` 實測一個全端專案；想更完整地學測試策略（測試替身、CI 品質門檻、舊專案補測），走[《Frontend Testing 課程》](../../frontend-testing-course/README.md)。

## 3. 環境建置

Vitest 是 Vite 官方的測試框架——**跟 Vite 共用同一份設定與轉譯管線**，所以你的 `.vue` 檔、別名、環境變數在測試裡不用重設一次就能用。這是 Vue 專案不選 Jest 而選 Vitest 的主因。

安裝三個東西：

```bash
# vitest：測試框架；@vue/test-utils：官方元件測試工具；jsdom：在 Node 裡模擬瀏覽器 DOM
npm install -D vitest @vue/test-utils jsdom
```

> 建專案時如果 `npm create vue@latest` 那步選了 `Add Vitest for unit testing? › Yes`（第 1 章我們選 No），這些就已經裝好了，可直接跳到寫測試。

在 `vite.config.js` 加上 `test` 區塊。注意 `defineConfig` 要從 `vitest/config` 匯入，才有 `test` 的型別與行為：

```js
// vite.config.js
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    // 元件測試需要 DOM；Node 預設沒有 document，用 jsdom 模擬
    environment: 'jsdom',
    // 測試檔放哪：本章把 .spec.js 放在被測檔案旁邊
    include: ['src/**/*.spec.js'],
  },
})
```

`package.json` 加指令：

```json
{
  "scripts": {
    "test": "vitest",
    "test:run": "vitest run",
    "coverage": "vitest run --coverage"
  }
}
```

- `npm run test`：**watch 模式**，存檔就自動重跑相關測試（開發時開著它）。
- `npm run test:run`：跑一次就結束（CI 用這個）。

**測試檔放哪？** 兩種慣例都常見：放在被測檔案旁邊（`useForm.js` / `useForm.spec.js`），或集中在 `tests/`。本章用前者——改一個檔案時，它的測試就在隔壁，比較不會忘記更新。

## 4. 第一個測試：純函式

從最好測的東西開始：**純函式**（同樣輸入永遠同樣輸出、不碰外部狀態）。第 6 章的 validators 正是這種東西——它們不知道 Vue、不碰 DOM，就是一組函式。

先把被測的檔案放好：

```js
// src/composables/validators.js（第 6 章）
export const required = (msg = '此欄位必填') => (v) =>
  v === '' || v == null || v === false ? msg : ''

export const minLength = (n, msg) => (v) =>
  String(v).length < n ? (msg || `至少需 ${n} 個字`) : ''

export const email = (msg = 'Email 格式不正確') => (v) =>
  /^[^@]+@[^@]+\.[^@]+$/.test(v) ? '' : msg

export const sameAs = (field, msg = '兩次輸入不一致') => (v, all) =>
  v === all[field] ? '' : msg
```

它的測試：

```js
// src/composables/validators.spec.js
import { describe, it, expect } from 'vitest'
import { required, minLength, email, sameAs } from './validators'

describe('required', () => {
  it('空字串回傳錯誤訊息', () => {
    expect(required()('')).toBe('此欄位必填')
  })

  it('有值回傳空字串（代表通過）', () => {
    expect(required()('Gary')).toBe('')
  })

  it('未勾選的 checkbox（false）視為未填', () => {
    expect(required('請同意條款')(false)).toBe('請同意條款')
  })
})

describe('minLength', () => {
  it('長度不足時回傳預設訊息', () => {
    expect(minLength(6)('abc')).toBe('至少需 6 個字')
  })

  it('可自訂訊息', () => {
    expect(minLength(6, '密碼至少 6 碼')('abc')).toBe('密碼至少 6 碼')
  })

  it('剛好等於下限視為通過（邊界）', () => {
    expect(minLength(6)('abcdef')).toBe('')
  })
})

describe('email', () => {
  // it.each：同一個斷言跑多組資料，省得複製貼上
  it.each([
    ['gary@example.com', ''],
    ['gary@example', 'Email 格式不正確'],
    ['gary.example.com', 'Email 格式不正確'],
    ['', 'Email 格式不正確'],
  ])('email(%s)', (input, expected) => {
    expect(email()(input)).toBe(expected)
  })
})

describe('sameAs', () => {
  it('與指定欄位相同才通過', () => {
    const all = { password: 'secret123' }
    expect(sameAs('password')('secret123', all)).toBe('')
    expect(sameAs('password')('secret999', all)).toBe('兩次輸入不一致')
  })
})
```

跑 `npm run test`：

```text
 ✓ src/composables/validators.spec.js (11 tests) 3ms

 Test Files  1 passed (1)
      Tests  11 passed (11)
```

三個結構元素就這樣：

- `describe(名稱, fn)`：把相關測試分組（可巢狀）。
- `it(描述, fn)`：一個測試案例。描述用「輸入什麼→預期什麼」的句子寫，失敗時終端機印的就是這句話。
- `expect(實際值).toBe(預期值)`：斷言。

> **注意邊界**：`minLength(6)('abcdef')` 這種「剛好等於下限」的案例，正是 `<` 寫成 `<=` 這類 off-by-one bug 藏身的地方。測試值得多花一行寫邊界。

### 紅燈 → 綠燈：測試怎麼幫你抓到 bug

試著把 `minLength` 的 `<` 改成 `<=`：

```js
export const minLength = (n, msg) => (v) =>
  String(v).length <= n ? (msg || `至少需 ${n} 個字`) : ''
```

存檔，watch 模式立刻跳紅：

```text
 FAIL  src/composables/validators.spec.js > minLength > 剛好等於下限視為通過（邊界）
AssertionError: expected '至少需 6 個字' to be '' // Object.is equality
```

它直接告訴你**哪個檔案、哪個案例、預期什麼、實際拿到什麼**。這就是測試的日常價值——你不用開瀏覽器打六個字試，改回 `<` 立刻變綠。

## 5. Vitest 斷言速查

| 斷言 | 用在 |
|------|------|
| `toBe(x)` | 基本型別、同一個物件參考（`Object.is`） |
| `toEqual(x)` | 物件／陣列的**內容**相等（最常用） |
| `toContain(x)` | 字串含子字串、陣列含某元素 |
| `toBeTruthy()` / `toBeFalsy()` | 真假值 |
| `toHaveLength(n)` | 陣列／字串長度 |
| `toBeInstanceOf(Error)` | 型別 |
| `toHaveBeenCalledWith(...)` | mock 函式被怎麼呼叫（第 10 節） |
| `rejects.toThrow()` | 非同步函式應該要失敗 |

> **`toBe` vs `toEqual` 是最常見的初學者陷阱**：`expect({ a: 1 }).toBe({ a: 1 })` 會失敗（兩個不同物件），要用 `toEqual`。基本型別（字串、數字、布林）兩者皆可，習慣上用 `toBe`。

常用的生命週期鉤子：`beforeEach` / `afterEach`（每個 `it` 前後跑）、`beforeAll` / `afterAll`（整個 `describe` 前後跑一次）。**測試之間必須互不影響**，共用狀態一律在 `beforeEach` 重建——這點在第 11 節測 Pinia 時特別關鍵。

## 6. 測 Composable

Composable 只是「會用到 Vue 響應式 API 的函式」，所以多數情況下**直接呼叫它就能測**。以第 6 章的 `useForm` 為例：

```js
// src/composables/useForm.js（第 6 章）
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

測試：

```js
// src/composables/useForm.spec.js
import { describe, it, expect } from 'vitest'
import { useForm } from './useForm'
import { required, minLength, sameAs } from './validators'

// 每個測試都用全新的一份表單，避免互相污染
function setup() {
  return useForm(
    { password: '', confirm: '' },
    {
      password: [required('請填密碼'), minLength(6, '密碼至少 6 碼')],
      confirm: [required('請再輸入一次密碼'), sameAs('password')],
    }
  )
}

describe('useForm', () => {
  it('初始狀態：全部未填、errors 有值、isValid 為 false', () => {
    const { values, touched, errors, isValid } = setup()

    expect(values.password).toBe('')
    expect(touched.password).toBe(false)
    expect(errors.value.password).toBe('請填密碼')
    expect(isValid.value).toBe(false)
  })

  it('改 values 後 errors / isValid 會自動重算（computed 的響應式）', () => {
    const { values, errors, isValid } = setup()

    values.password = 'secret123'
    values.confirm = 'secret123'

    expect(errors.value).toEqual({})
    expect(isValid.value).toBe(true)
  })

  it('每個欄位只回報第一條沒過的規則', () => {
    const { values, errors } = setup()

    values.password = 'abc' // 有填但太短
    expect(errors.value.password).toBe('密碼至少 6 碼')
  })

  it('跨欄位規則：confirm 會拿整份 values 比對', () => {
    const { values, errors } = setup()

    values.password = 'secret123'
    values.confirm = 'secret999'
    expect(errors.value.confirm).toBe('兩次輸入不一致')
  })

  it('touchAll 把所有欄位標記為碰過', () => {
    const { touched, touchAll } = setup()

    touchAll()
    expect(touched.password).toBe(true)
    expect(touched.confirm).toBe(true)
  })

  it('reset 把值與 touched 還原', () => {
    const { values, touched, touch, reset } = setup()

    values.password = 'secret123'
    touch('password')
    reset()

    expect(values.password).toBe('')
    expect(touched.password).toBe(false)
  })
})
```

兩個重點：

1. **`computed` 讀值要加 `.value`**（`errors.value`）；`reactive` 物件直接讀屬性（`values.password`）——這跟你在 `<script setup>` 裡的用法一致，模板才會自動解包。
2. **`computed` 在測試裡是同步重算的**。上面改完 `values.password` 立刻讀 `errors.value` 就是新值，不用等 `nextTick`（要等的是「畫面」，不是「值」，見下一節）。

> **例外：用到生命週期的 composable**。像第 5 章的 `useMouse`（`onMounted` 裡註冊事件）直接呼叫會拿到警告「onMounted is called when there is no active component instance」。這種要掛在一個測試用元件裡跑——最省事的做法就是**測用到它的元件**（下一節），而不是硬測 composable 本身。

## 7. 測元件：`mount`

Vue Test Utils 的 `mount()` 會把元件真的渲染到 jsdom 的 DOM 裡，回傳一個 `wrapper`（包裝器），你透過它查詢畫面、觸發事件。

先看被測元件：

```vue
<!-- src/components/PostCard.vue -->
<script setup>
import { computed } from 'vue'

const props = defineProps({
  post: { type: Object, required: true },
  favorited: { type: Boolean, default: false },
})

const emit = defineEmits(['toggle-favorite'])

const excerpt = computed(() => {
  const body = props.post.body ?? ''
  return body.length > 20 ? body.slice(0, 20) + '…' : body
})
</script>

<template>
  <article class="card">
    <h2>
      <router-link :to="{ name: 'post', params: { id: post.id } }">
        {{ post.title }}
      </router-link>
    </h2>
    <p data-testid="excerpt">{{ excerpt }}</p>
    <button
      data-testid="fav"
      :aria-pressed="favorited"
      @click="emit('toggle-favorite', post.id)"
    >
      {{ favorited ? '★ 已收藏' : '☆ 收藏' }}
    </button>
  </article>
</template>
```

測試：

```js
// src/components/PostCard.spec.js
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import PostCard from './PostCard.vue'

const post = { id: 1, title: 'Vue 測試入門', body: '這是一篇很長的文章內容，長度超過二十個字所以會被截斷。' }

// router-link 需要 router；單元測試裡先用 stub 換成假的（第 12 節會示範用真 router）
const global = { stubs: { 'router-link': { template: '<a><slot /></a>' } } }

describe('PostCard', () => {
  it('把 post.title 渲染出來', () => {
    const wrapper = mount(PostCard, { props: { post }, global })

    expect(wrapper.text()).toContain('Vue 測試入門')
  })

  it('內容超過 20 字會截斷並補上刪節號', () => {
    const wrapper = mount(PostCard, { props: { post }, global })

    const excerpt = wrapper.get('[data-testid="excerpt"]').text()
    expect(excerpt).toBe('這是一篇很長的文章內容，長度超過二十個字…')
  })

  it('內容不長就原樣顯示', () => {
    const wrapper = mount(PostCard, {
      props: { post: { ...post, body: '短內容' } },
      global,
    })

    expect(wrapper.get('[data-testid="excerpt"]').text()).toBe('短內容')
  })
})
```

### 查詢畫面的 API

| API | 行為 |
|-----|------|
| `wrapper.text()` | 整個元件的文字內容（快速斷言「有沒有出現某段字」） |
| `wrapper.get(選擇器)` | 找一個元素，**找不到直接丟錯**（預期一定存在時用它） |
| `wrapper.find(選擇器)` | 找一個元素，找不到回傳「不存在」的包裝器 |
| `wrapper.find(x).exists()` | 判斷「不該存在」時用（`toBe(false)`） |
| `wrapper.findAll(選擇器)` | 找多個，回傳陣列 |
| `.attributes('href')` / `.classes()` / `.element.value` | 取屬性 / class / input 的值 |

### 為什麼用 `data-testid`

用 `.excerpt` 這種 class 當選擇器，設計師改樣式就會弄壞測試；用 `p:nth-child(2)` 更慘，加一個標籤就爆。`data-testid` 是**專門給測試用的鉤子**，改樣式、換標籤都不影響。

> 更講究的做法是用「使用者看得到的東西」查詢——文字、`aria-label`、`role`（Testing Library 的哲學）。本章用 `data-testid` 是為了少裝一套工具；規模大起來後可以評估 `@testing-library/vue`。

## 8. 使用者互動：`trigger`、`setValue`、`emitted`

測「使用者做了什麼、結果如何」才是元件測試的重點：

```js
// src/components/PostCard.spec.js（續）
it('點收藏鈕會 emit toggle-favorite 並帶上 id', async () => {
  const wrapper = mount(PostCard, { props: { post }, global })

  await wrapper.get('[data-testid="fav"]').trigger('click')

  // emitted() 回傳這個元件發過的所有事件
  expect(wrapper.emitted('toggle-favorite')).toHaveLength(1)
  // 每次發射是一個陣列（事件的參數），所以 [0] 是第一次、再 [0] 才是第一個參數
  expect(wrapper.emitted('toggle-favorite')[0]).toEqual([1])
})

it('favorited prop 決定按鈕文字與 aria-pressed', async () => {
  const wrapper = mount(PostCard, { props: { post, favorited: false }, global })
  const btn = wrapper.get('[data-testid="fav"]')

  expect(btn.text()).toBe('☆ 收藏')
  expect(btn.attributes('aria-pressed')).toBe('false')

  // 父層把 prop 換成 true，畫面要跟著變
  await wrapper.setProps({ favorited: true })

  expect(btn.text()).toBe('★ 已收藏')
  expect(btn.attributes('aria-pressed')).toBe('true')
})
```

**為什麼每個操作前面都有 `await`？**

Vue 的 DOM 更新是**非同步批次**的（第 5 章的 `nextTick`）：改了狀態，畫面不會當下就更新，而是等到下一個 tick。`trigger()`、`setValue()`、`setProps()` 都回傳一個「等畫面更新完」的 Promise，所以：

```js
wrapper.get('button').trigger('click')
expect(wrapper.text()).toContain('1') // ❌ 常常失敗：畫面還沒更新

await wrapper.get('button').trigger('click')
expect(wrapper.text()).toContain('1') // ✅
```

> 規則很簡單：**任何會改狀態的操作都加 `await`**。忘了加 `await` 是元件測試最常見的失敗原因，而且錯誤訊息（「預期有 1 但拿到 0」）不會告訴你原因是時序。如果狀態不是透過這些 API 改的（例如直接改 store），就手動 `await wrapper.vm.$nextTick()`。

## 9. 測元件的 `v-model`

第 4 章的 `defineModel()` 本質是 `modelValue` prop + `update:modelValue` 事件，所以測法就是「傳 prop 進去、看事件出來」：

```vue
<!-- src/components/SearchInput.vue -->
<script setup>
const keyword = defineModel({ type: String, default: '' })
</script>

<template>
  <label>
    搜尋
    <input v-model="keyword" data-testid="search" placeholder="輸入關鍵字" />
  </label>
</template>
```

```js
// src/components/SearchInput.spec.js
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SearchInput from './SearchInput.vue'

describe('SearchInput（defineModel）', () => {
  it('把 modelValue 顯示在 input 裡', () => {
    const wrapper = mount(SearchInput, { props: { modelValue: 'vue' } })

    expect(wrapper.get('[data-testid="search"]').element.value).toBe('vue')
  })

  it('使用者輸入會 emit update:modelValue', async () => {
    const wrapper = mount(SearchInput, { props: { modelValue: '' } })

    await wrapper.get('[data-testid="search"]').setValue('pinia')

    expect(wrapper.emitted('update:modelValue')[0]).toEqual(['pinia'])
  })

  it('用 v-model 綁定時父層的值會真的更新', async () => {
    const wrapper = mount(SearchInput, {
      props: {
        modelValue: '',
        // v-model 的語法糖：父層收到事件就更新 prop
        'onUpdate:modelValue': (v) => wrapper.setProps({ modelValue: v }),
      },
    })

    await wrapper.get('[data-testid="search"]').setValue('vitest')

    expect(wrapper.props('modelValue')).toBe('vitest')
  })
})
```

第三個測試是完整的雙向流程：**輸入 → 子元件 emit → 父層更新 prop → 子元件顯示新值**。這正是 `v-model` 的全貌。

## 10. 非同步與 mock：測 `useFetch`

測到有網路請求的程式碼時，**絕對不要真的打 API**——會慢、會不穩、會因為別人的伺服器掛掉而紅燈。做法是用假的 `fetch` 取代真的。

被測的 composable（第 5、7 章）：

```js
// src/composables/useFetch.js
import { ref, watchEffect, toValue } from 'vue'

export function useFetch(url) {
  const data = ref(null)
  const error = ref(null)
  const loading = ref(false)

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

測試：

```js
// src/composables/useFetch.spec.js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { useFetch } from './useFetch'

// 假的 Response：只做出 useFetch 用到的那幾個東西
const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => body,
})

beforeEach(() => {
  // 用假的 fetch 蓋掉全域 fetch，測試才不會真的打網路
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useFetch', () => {
  it('成功時把 json 放進 data，並把 loading 收掉', async () => {
    fetch.mockResolvedValue(jsonResponse([{ id: 1, title: 'Hello' }]))

    const { data, error, loading } = useFetch('/api/posts')

    expect(loading.value).toBe(true) // 同步階段就已經開始載入
    await flushPromises() // 等所有 pending 的 promise 跑完

    expect(fetch).toHaveBeenCalledWith('/api/posts')
    expect(data.value).toEqual([{ id: 1, title: 'Hello' }])
    expect(error.value).toBe(null)
    expect(loading.value).toBe(false)
  })

  it('HTTP 錯誤碼會轉成 error，data 保持 null', async () => {
    fetch.mockResolvedValue(jsonResponse(null, { ok: false, status: 404 }))

    const { data, error, loading } = useFetch('/api/posts/999')
    await flushPromises()

    expect(error.value).toBeInstanceOf(Error)
    expect(error.value.message).toBe('HTTP 404')
    expect(data.value).toBe(null)
    expect(loading.value).toBe(false)
  })

  it('網路斷線（fetch reject）也會進 error', async () => {
    fetch.mockRejectedValue(new Error('Network down'))

    const { error } = useFetch('/api/posts')
    await flushPromises()

    expect(error.value.message).toBe('Network down')
  })

  it('url 傳 getter 時，依賴一變就自動重抓', async () => {
    fetch.mockResolvedValue(jsonResponse({ id: 1 }))
    const id = ref(1)

    const { data } = useFetch(() => `/api/posts/${id.value}`)
    await flushPromises()
    expect(fetch).toHaveBeenLastCalledWith('/api/posts/1')

    fetch.mockResolvedValue(jsonResponse({ id: 2 }))
    id.value = 2 // 改依賴
    await flushPromises() // watchEffect 重跑 + 新的請求完成

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch).toHaveBeenLastCalledWith('/api/posts/2')
    expect(data.value).toEqual({ id: 2 })
  })
})
```

三個新工具：

- **`vi.fn()`**：建立一個假函式。它會記錄每次被呼叫的參數，並可用 `mockResolvedValue` / `mockRejectedValue` / `mockReturnValue` 指定回傳值。
- **`vi.stubGlobal('fetch', ...)`**：把全域的 `fetch` 換成假的；`afterEach` 用 `vi.unstubAllGlobals()` 還原，避免污染其他測試檔。
- **`flushPromises()`**：等掉所有排隊中的 Promise 與 Vue 更新。測非同步時比 `nextTick` 好用（`nextTick` 只等一輪畫面更新，不等你的 `await fetch`）。

最後一個測試特別有價值：它驗證的是**「url 傳 getter 就會自動重抓」這個第 7 章 `PostDetail` 賴以運作的行為**。手動測要開瀏覽器點兩篇文章，自動化測只要幾行——這正是測試划算的地方。

> 想連 `fetch` 這層都不自己接？實務常見的做法是用 [MSW](https://mswjs.io/) 在網路層攔截請求，測試裡就能寫「假的後端」。本課先用最小成本的 `vi.stubGlobal`，概念是一樣的：**把不受你控制的東西換成你控制得了的**。

## 11. 測 Pinia store

Store 是「跨元件共享的狀態」，測起來有一個關鍵：**每個測試都要給一個乾淨的 pinia 實例**，否則上一個測試登入過的狀態會殘留到下一個。

```js
// src/stores/auth.js（第 7 章）
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useAuthStore = defineStore('auth', () => {
  const user = ref(null)
  const isLoggedIn = computed(() => user.value !== null)

  function login(name) {
    user.value = { name }
  }
  function logout() {
    user.value = null
  }

  return { user, isLoggedIn, login, logout }
})
```

```js
// src/stores/auth.spec.js
import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from './auth'

// 關鍵：每個測試都給一個全新的 pinia，否則 store 狀態會在測試之間互相污染
beforeEach(() => {
  setActivePinia(createPinia())
})

describe('auth store', () => {
  it('預設沒有登入者', () => {
    const auth = useAuthStore()

    expect(auth.user).toBe(null)
    expect(auth.isLoggedIn).toBe(false)
  })

  it('login 會存下使用者，isLoggedIn 這個 getter 跟著變 true', () => {
    const auth = useAuthStore()

    auth.login('Gary')

    expect(auth.user).toEqual({ name: 'Gary' })
    expect(auth.isLoggedIn).toBe(true)
  })

  it('logout 會清空', () => {
    const auth = useAuthStore()
    auth.login('Gary')

    auth.logout()

    expect(auth.user).toBe(null)
    expect(auth.isLoggedIn).toBe(false)
  })

  it('狀態不會殘留到下一個測試（前一個測試登入過，這裡仍是未登入）', () => {
    const auth = useAuthStore()

    expect(auth.isLoggedIn).toBe(false)
  })
})
```

> 注意 store 上讀 `auth.isLoggedIn` **不用加 `.value`**——Pinia 幫你解包了。這跟直接用 `computed()` 不同。

### 元件 + store 一起測

元件裡呼叫 `useAuthStore()` 時，pinia 必須已經裝好，所以掛載時要透過 `global.plugins` 傳進去：

```vue
<!-- src/components/UserBar.vue -->
<script setup>
import { storeToRefs } from 'pinia'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const { user, isLoggedIn } = storeToRefs(auth)
</script>

<template>
  <div class="user">
    <template v-if="isLoggedIn">
      <span data-testid="hello">哈囉，{{ user.name }}</span>
      <button data-testid="logout" @click="auth.logout()">登出</button>
    </template>
    <span v-else data-testid="guest">訪客</span>
  </div>
</template>
```

```js
// src/components/UserBar.spec.js
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import UserBar from './UserBar.vue'
import { useAuthStore } from '../stores/auth'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('UserBar', () => {
  it('未登入顯示訪客', () => {
    // 元件內部會呼叫 useAuthStore()，所以掛載時要把 pinia 裝進去
    const wrapper = mount(UserBar, { global: { plugins: [createPinia()] } })

    expect(wrapper.get('[data-testid="guest"]').text()).toBe('訪客')
    expect(wrapper.find('[data-testid="hello"]').exists()).toBe(false)
  })

  it('登入後顯示名字（改 store，畫面跟著更新）', async () => {
    const pinia = createPinia()
    const wrapper = mount(UserBar, { global: { plugins: [pinia] } })
    const auth = useAuthStore(pinia) // 拿的是同一個 pinia 實例裡的 store

    auth.login('Gary')
    await wrapper.vm.$nextTick() // 等 Vue 把畫面更新完再斷言

    expect(wrapper.get('[data-testid="hello"]').text()).toBe('哈囉，Gary')
  })

  it('點登出會清掉登入狀態並變回訪客', async () => {
    const pinia = createPinia()
    const wrapper = mount(UserBar, { global: { plugins: [pinia] } })
    const auth = useAuthStore(pinia)
    auth.login('Gary')
    await wrapper.vm.$nextTick()

    await wrapper.get('[data-testid="logout"]').trigger('click')

    expect(auth.isLoggedIn).toBe(false)
    expect(wrapper.get('[data-testid="guest"]').text()).toBe('訪客')
  })
})
```

兩個細節：

1. `useAuthStore(pinia)` **要傳入同一個 pinia 實例**，拿到的才是元件正在用的那份 store。
2. 直接改 store（不是透過 `trigger`）時，記得手動 `await wrapper.vm.$nextTick()` 再斷言畫面。

> 如果你想「假造 store 的行為」（例如讓 action 不真的執行、只記錄有沒有被呼叫），官方另有 `@pinia/testing` 的 `createTestingPinia()`。小專案用真的 store 更貼近現實，也少一層心智負擔——需要時再引入。

## 12. 測路由與登入守衛

第 7 章的守衛「未登入不准進 `/admin`」是很值得測的邏輯：它牽涉路由、store 兩邊，手動測要開無痕視窗試，自動化測則是幾行。

測試環境沒有瀏覽器網址列，所以用 **`createMemoryHistory()`**（把歷史紀錄放記憶體）：

```js
// src/router/router.spec.js
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import PostCard from '../components/PostCard.vue'

// 測試用的極簡頁面元件：測路由時我們只在意「跑到哪一頁」，不在意頁面長什麼樣
const Page = (name) => ({ template: `<div>${name}</div>` })

// 路由表與守衛跟第 7 章的 src/router/index.js 一致，只有 history 與頁面元件換掉
function createTestRouter() {
  const router = createRouter({
    // 測試環境沒有真的瀏覽器網址列，用 memory history
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: Page('PostList') },
      { path: '/posts/:id', name: 'post', component: Page('PostDetail') },
      { path: '/login', name: 'login', component: Page('Login') },
      {
        path: '/admin',
        name: 'admin',
        component: Page('Admin'),
        meta: { requiresAuth: true },
      },
    ],
  })

  router.beforeEach((to) => {
    const auth = useAuthStore()
    if (to.meta.requiresAuth && !auth.isLoggedIn) {
      return { name: 'login', query: { redirect: to.fullPath } }
    }
  })

  return router
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('路由守衛', () => {
  it('未登入進 /admin 會被導去登入頁，並記下 redirect', async () => {
    const router = createTestRouter()

    await router.push('/admin')

    expect(router.currentRoute.value.name).toBe('login')
    expect(router.currentRoute.value.query.redirect).toBe('/admin')
  })

  it('登入後可以進 /admin', async () => {
    const router = createTestRouter()
    useAuthStore().login('Gary')

    await router.push('/admin')

    expect(router.currentRoute.value.name).toBe('admin')
  })

  it('沒標 requiresAuth 的頁面不受影響', async () => {
    const router = createTestRouter()

    await router.push('/posts/3')

    expect(router.currentRoute.value.name).toBe('post')
    expect(router.currentRoute.value.params.id).toBe('3')
  })
})

describe('PostCard（掛真的 router，不用 stub）', () => {
  it('連結指向 /posts/:id', async () => {
    const router = createTestRouter()
    await router.push('/')
    await router.isReady() // 等路由就緒再掛載，router-link 才解析得出 href

    const wrapper = mount(PostCard, {
      props: { post: { id: 7, title: '測試也是一種文件', body: '短內容' } },
      global: { plugins: [router] },
    })

    expect(wrapper.get('a').attributes('href')).toBe('/posts/7')
  })
})
```

**stub 掉 `router-link`（第 7 節）還是掛真的 router（這裡）？** 看你在測什麼：只想測這個元件自己的邏輯 → stub 比較快也比較獨立；想確認「連結真的指到對的網址」→ 掛真 router 才測得到。兩種都合理，別為了純度硬選一邊。

## 13. 覆蓋率與 CI

覆蓋率（coverage）告訴你「程式碼有多少比例被測試執行過」。安裝後即可產報告：

```bash
npm install -D @vitest/coverage-v8
npm run coverage
```

```text
 % Coverage report from v8
------------------|---------|----------|---------|---------|
File              | % Stmts | % Branch | % Funcs | % Lines |
------------------|---------|----------|---------|---------|
All files         |     100 |    98.55 |   94.73 |     100 |
 components       |     100 |    96.42 |    87.5 |     100 |
  LoginForm.vue   |     100 |      100 |      80 |     100 |
  PostCard.vue    |     100 |     87.5 |     100 |     100 |
 composables      |     100 |      100 |     100 |     100 |
  useFetch.js     |     100 |      100 |     100 |     100 |
  useForm.js      |     100 |      100 |     100 |     100 |
  validators.js   |     100 |      100 |     100 |     100 |
 stores           |     100 |      100 |     100 |     100 |
  auth.js         |     100 |      100 |     100 |     100 |
------------------|---------|----------|---------|---------|
```

怎麼看它：**低覆蓋率是明確的壞消息，高覆蓋率不是明確的好消息**。80% 的專案裡那 20% 沒測到的通常正是錯誤處理分支（最容易出事的地方），值得補；但 100% 覆蓋率完全可以由一堆沒有斷言的爛測試堆出來。把它當「找沒測到的角落」的地圖，不要當 KPI。

CI（GitHub Actions 之類）跑的是不進 watch 的版本：

```yaml
# .github/workflows/test.yml
name: test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run test:run
```

這樣每次 push / 開 PR 都會自動跑測試，紅燈就擋下來。

## 14. 什麼該測、什麼不該測

新手最容易卡在「那我到底要測什麼」。一個實用的優先順序：

**優先測（投資報酬率最高）**

1. **純函式與商業邏輯**：驗證規則、計算金額、格式化——快、穩、幾乎不會誤報。
2. **會被很多地方用的 composable / store**：壞掉時波及面最大。
3. **有分支的行為**：`v-if` 的兩邊、成功／失敗／載入中三態、權限有無。
4. **修過的 bug**：每修一個 bug 就補一個會重現它的測試，它就永遠不會回來。

**不用測**

1. **框架本身**：`v-for` 會不會正確迴圈、`ref` 會不會觸發更新——那是 Vue 的測試該保證的。
2. **純樣式**：顏色、間距、CSS class 的視覺效果（要測請走視覺回歸工具）。
3. **第三方套件的內部行為**：測你「怎麼用它」就好。
4. **一次性的原型程式碼**：明天就要丟的東西別花這個時間。

> 一個好用的判斷句：**「這段程式碼壞掉時，我會希望在 push 之前就知道嗎？」** 會，就值得測。

---

## 常見陷阱

1. **忘了 `await`**：`trigger` / `setValue` / `setProps` 都是非同步的。沒 `await` 就斷言畫面，會拿到更新前的狀態。直接改 store 或 ref 時，用 `await wrapper.vm.$nextTick()`。
2. **`toBe` 拿來比物件**：`expect({a:1}).toBe({a:1})` 必失敗，物件／陣列要用 `toEqual`。
3. **測試之間互相污染**：Pinia 沒在 `beforeEach` 重建、`vi.stubGlobal` 沒還原、模組層級的變數被改到——症狀是「單獨跑會過、一起跑就失敗」（或反過來）。
4. **斷言內部狀態而非畫面**：`expect(wrapper.vm.count).toBe(1)` 能過，但重構就壞，而且沒保證使用者看到 1。測 `wrapper.text()`。
5. **忘了裝 plugin**：元件用到 store 或 router 卻沒給 `global.plugins`，會噴 `getActivePinia was called with no active Pinia` 或 `Failed to resolve component: router-link`。
6. **真的打了 API**：測試裡出現 `fetch('https://...')` 就是紅旗——測試會慢、會因為網路而隨機失敗。一律 mock。
7. **測 `computed` 卻等 `nextTick`**：值是同步重算的，不用等；要等的是 DOM。搞混會讓你以為「響應式壞了」。
8. **用 CSS class 或 DOM 結構當選擇器**：改樣式就壞。用 `data-testid`。
9. **一個 `it` 塞十個斷言**：失敗時看不出是哪裡壞。一個測試專注一件事，描述寫成一句話講得完的。

---

## 練習作業

1. 幫第 6 章的 `validators` 補上一條 `maxLength(n)` 規則，**先寫測試（紅燈）再實作（綠燈）**，包含邊界案例。
2. 幫 `useForm` 加一個 `submitCount`（每次 `touchAll` 就 +1），並補測試。
3. 幫第 7 章的 `PostList.vue` 寫測試：用 `vi.stubGlobal` 假造 `fetch` 回三筆文章，斷言畫面出現三張卡片；再測「載入中顯示『載入中…』」與「失敗顯示錯誤訊息」兩種狀態。
4. 幫 auth store 加上 `role`（`'user'` / `'admin'`），改守衛只放行 `admin` 進 `/admin`，並補三個測試：未登入、登入但非 admin、admin。
5. 跑 `npm run coverage`，找出覆蓋率最低的檔案，補測試把它拉到 80% 以上——過程中注意你補的是「真的有價值的案例」還是「為了數字」。
6. 進階：把測試接上 GitHub Actions，確認 PR 上會出現測試結果；再故意推一個壞掉的 commit，確認 CI 真的擋得下來。

---

## 最後範例：一個完整可跑的測試專案

把本章所有東西整理成一個可以直接跑的專案。原樣建立以下檔案，`npm install` 後 `npm run test:run` 就會看到 45 個測試全綠。

專案結構：

```text
vue-test-lab/
├─ package.json
├─ vite.config.js
└─ src/
   ├─ components/
   │  ├─ LoginForm.vue      + LoginForm.spec.js
   │  ├─ PostCard.vue       + PostCard.spec.js
   │  ├─ SearchInput.vue    + SearchInput.spec.js
   │  └─ UserBar.vue        + UserBar.spec.js
   ├─ composables/
   │  ├─ useFetch.js        + useFetch.spec.js
   │  ├─ useForm.js         + useForm.spec.js
   │  └─ validators.js      + validators.spec.js
   ├─ router/
   │  └─ router.spec.js
   └─ stores/
      └─ auth.js            + auth.spec.js
```

### `package.json`

```json
{
  "name": "vue-test-lab",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "test": "vitest",
    "test:run": "vitest run",
    "coverage": "vitest run --coverage"
  },
  "dependencies": {
    "pinia": "^3.0.1",
    "vue": "^3.5.13",
    "vue-router": "^4.5.0"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^5.2.1",
    "@vitest/coverage-v8": "^3.0.5",
    "@vue/test-utils": "^2.4.6",
    "jsdom": "^26.0.0",
    "vite": "^6.1.0",
    "vitest": "^3.0.5"
  }
}
```

### `vite.config.js`

```js
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.spec.js'],
  },
})
```

### 被測的原始碼

三個 composable、一個 store（與前面各節相同，這裡整理在一起方便一次建立）：

```js
// src/composables/validators.js
export const required = (msg = '此欄位必填') => (v) =>
  v === '' || v == null || v === false ? msg : ''

export const minLength = (n, msg) => (v) =>
  String(v).length < n ? (msg || `至少需 ${n} 個字`) : ''

export const email = (msg = 'Email 格式不正確') => (v) =>
  /^[^@]+@[^@]+\.[^@]+$/.test(v) ? '' : msg

export const sameAs = (field, msg = '兩次輸入不一致') => (v, all) =>
  v === all[field] ? '' : msg
```

```js
// src/composables/useForm.js
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

```js
// src/composables/useFetch.js
import { ref, watchEffect, toValue } from 'vue'

export function useFetch(url) {
  const data = ref(null)
  const error = ref(null)
  const loading = ref(false)

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

```js
// src/stores/auth.js
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useAuthStore = defineStore('auth', () => {
  const user = ref(null)
  const isLoggedIn = computed(() => user.value !== null)

  function login(name) {
    user.value = { name }
  }
  function logout() {
    user.value = null
  }

  return { user, isLoggedIn, login, logout }
})
```

三個元件（`PostCard.vue` 見第 7 節、`SearchInput.vue` 見第 9 節、`UserBar.vue` 見第 11 節，內容相同，這裡再列一次）：

```vue
<!-- src/components/PostCard.vue -->
<script setup>
import { computed } from 'vue'

const props = defineProps({
  post: { type: Object, required: true },
  favorited: { type: Boolean, default: false },
})

const emit = defineEmits(['toggle-favorite'])

const excerpt = computed(() => {
  const body = props.post.body ?? ''
  return body.length > 20 ? body.slice(0, 20) + '…' : body
})
</script>

<template>
  <article class="card">
    <h2>
      <router-link :to="{ name: 'post', params: { id: post.id } }">
        {{ post.title }}
      </router-link>
    </h2>
    <p data-testid="excerpt">{{ excerpt }}</p>
    <button
      data-testid="fav"
      :aria-pressed="favorited"
      @click="emit('toggle-favorite', post.id)"
    >
      {{ favorited ? '★ 已收藏' : '☆ 收藏' }}
    </button>
  </article>
</template>
```

```vue
<!-- src/components/SearchInput.vue -->
<script setup>
const keyword = defineModel({ type: String, default: '' })
</script>

<template>
  <label>
    搜尋
    <input v-model="keyword" data-testid="search" placeholder="輸入關鍵字" />
  </label>
</template>
```

```vue
<!-- src/components/UserBar.vue -->
<script setup>
import { storeToRefs } from 'pinia'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const { user, isLoggedIn } = storeToRefs(auth)
</script>

<template>
  <div class="user">
    <template v-if="isLoggedIn">
      <span data-testid="hello">哈囉，{{ user.name }}</span>
      <button data-testid="logout" @click="auth.logout()">登出</button>
    </template>
    <span v-else data-testid="guest">訪客</span>
  </div>
</template>
```

最後一個元件，前面沒出現過——它把「表單 + 驗證 + 送出」整合起來，是本章測試技巧的集大成：

### `src/components/LoginForm.vue`

```vue
<script setup>
import { useForm } from '../composables/useForm'
import { required, minLength } from '../composables/validators'

const emit = defineEmits(['submit'])

const { values, touched, errors, isValid, touch, touchAll } = useForm(
  { name: '', password: '' },
  {
    name: [required('請填暱稱')],
    password: [required('請填密碼'), minLength(6, '密碼至少 6 碼')],
  }
)

function onSubmit() {
  touchAll()
  if (!isValid.value) return
  emit('submit', { ...values })
}
</script>

<template>
  <form @submit.prevent="onSubmit">
    <input
      v-model="values.name"
      data-testid="name"
      placeholder="暱稱"
      @blur="touch('name')"
    />
    <p v-if="touched.name && errors.name" data-testid="name-error">{{ errors.name }}</p>

    <input
      v-model="values.password"
      type="password"
      data-testid="password"
      placeholder="密碼"
      @blur="touch('password')"
    />
    <p v-if="touched.password && errors.password" data-testid="password-error">
      {{ errors.password }}
    </p>

    <button type="submit">登入</button>
  </form>
</template>
```

### 測試檔

九支測試檔分別在第 4 節（`validators.spec.js`）、第 6 節（`useForm.spec.js`）、第 7 + 8 節（`PostCard.spec.js`，第 8 節那兩個 `it` 接在同一個 `describe` 裡）、第 9 節（`SearchInput.spec.js`）、第 10 節（`useFetch.spec.js`）、第 11 節（`auth.spec.js`、`UserBar.spec.js`）、第 12 節（`router.spec.js`），照著建立即可。剩下這一支：

### `src/components/LoginForm.spec.js`

這支測試把本章的技巧疊在一起：使用者輸入、驗證時機、事件與 payload——它測的正是「一個表單該有的行為」。

```js
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import LoginForm from './LoginForm.vue'

describe('LoginForm', () => {
  it('一開始不顯示任何錯誤（還沒碰過欄位）', () => {
    const wrapper = mount(LoginForm)

    expect(wrapper.find('[data-testid="name-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="password-error"]').exists()).toBe(false)
  })

  it('碰過又留空才顯示錯誤', async () => {
    const wrapper = mount(LoginForm)

    await wrapper.get('[data-testid="name"]').trigger('blur')

    expect(wrapper.get('[data-testid="name-error"]').text()).toBe('請填暱稱')
  })

  it('欄位沒填完就送出：不 emit，並把錯誤全部顯示出來', async () => {
    const wrapper = mount(LoginForm)

    await wrapper.get('form').trigger('submit')

    expect(wrapper.emitted('submit')).toBeUndefined()
    expect(wrapper.get('[data-testid="name-error"]').text()).toBe('請填暱稱')
    expect(wrapper.get('[data-testid="password-error"]').text()).toBe('請填密碼')
  })

  it('密碼太短擋下來', async () => {
    const wrapper = mount(LoginForm)

    await wrapper.get('[data-testid="name"]').setValue('Gary')
    await wrapper.get('[data-testid="password"]').setValue('123')
    await wrapper.get('form').trigger('submit')

    expect(wrapper.emitted('submit')).toBeUndefined()
    expect(wrapper.get('[data-testid="password-error"]').text()).toBe('密碼至少 6 碼')
  })

  it('填對就 emit submit 並帶出表單值', async () => {
    const wrapper = mount(LoginForm)

    await wrapper.get('[data-testid="name"]').setValue('Gary')
    await wrapper.get('[data-testid="password"]').setValue('secret123')
    await wrapper.get('form').trigger('submit')

    expect(wrapper.emitted('submit')).toHaveLength(1)
    expect(wrapper.emitted('submit')[0][0]).toEqual({
      name: 'Gary',
      password: 'secret123',
    })
  })
})
```

### 跑起來的樣子

```text
$ npm run test:run

 RUN  v3.2.7 /path/to/vue-test-lab

 ✓ src/stores/auth.spec.js (4 tests) 5ms
 ✓ src/composables/useFetch.spec.js (4 tests) 17ms
 ✓ src/components/SearchInput.spec.js (3 tests) 25ms
 ✓ src/components/UserBar.spec.js (3 tests) 23ms
 ✓ src/components/PostCard.spec.js (5 tests) 40ms
 ✓ src/components/LoginForm.spec.js (5 tests) 36ms
 ✓ src/router/router.spec.js (4 tests) 78ms
 ✓ src/composables/validators.spec.js (11 tests) 3ms
 ✓ src/composables/useForm.spec.js (6 tests) 3ms

 Test Files  9 passed (9)
      Tests  45 passed (45)
   Duration  1.48s
```

**45 個測試、1.5 秒。** 手動點完這些情境（四種表單狀態、收藏切換、v-model 雙向、四種請求結果、登入登出、三種守衛情境）至少要好幾分鐘，而且你不會每次改程式都重點一遍——但機器會。

---

## 結業與下一步

恭喜你完成這門 Vue 3 精華橋接課！回顧你已經具備的能力：

- SFC + Vite 開發環境（01）
- `ref`/`reactive`/`computed`/`watch` 響應式（02）
- 模板語法與指令（03）
- 元件溝通 `props`/`emit`/`v-model`/`slots`/`provide-inject`（04）
- 生命週期與把邏輯抽成 composable（05）
- 表單與可重用的驗證（06）
- Vue Router 多頁 + Pinia 全域狀態，並整合成一個迷你 SPA（07）
- 用 Vitest + Vue Test Utils 幫上面這些東西補上自動化測試（08）

這正是「能無縫進入本 repo 進階課」所需的全部基礎。接下來幾條路任選：

### 想搞懂「Vue 為什麼這樣運作」→ 走[《Vue 3 源碼解析課》](../vue-source/README.md)

你這門課用到的 `ref` 為什麼改了畫面就會動、`computed` 為什麼只在依賴變時重算、`watchEffect` 怎麼自動追蹤依賴、`<script setup>` 怎麼被編譯——源碼課會帶你從 `reactivity` 的 `track`/`trigger`/`effect` 一路追到 renderer 與編譯器，把「魔法」變成「你看得懂、追得動、改得準」的機制。你在本課建立的組合式 API 心智模型，正是讀源碼的最佳起點。

### 想把 SPA 升級成可上線的全端產品 → 走[《Nuxt 全端課》](../nuxt/README.md)

你在第 7 章手動拼的那些東西——路由設定、資料抓取、跨頁狀態、登入守衛——**Nuxt 全都內建好了**：

| 本課手動做的 | Nuxt 幫你內建 |
|-------------|--------------|
| `vue-router` 手寫 routes 表 | 檔案式路由（`pages/` 放檔案自動生成路由） |
| `useFetch` composable 自己寫 | 內建 `useFetch`／`useAsyncData`，還自動在伺服器就抓好（SSR） |
| `beforeEach` 全域守衛 | 路由中介層 `middleware/` + 伺服器端 `requireUserSession` 真正的權限 |
| 純前端 SPA | SSR / SSG / 混合渲染，SEO 友善、首屏更快 |
| 只能打別人的 API | Nitro 伺服器引擎，在 `server/api/` 寫自己的後端 |

換句話說，Nuxt 就是把「這一章你手動組的那套」升級成一個生產級全端框架。定位上，Nuxt 之於 Vue，就像 Next.js 之於 React。測試的部分在 Nuxt 課[第 15 章](../nuxt/15-performance-caching-testing.md)接續：`@nuxt/test-utils` 讓你連 SSR 與 API 都測得到（範例專案 [blog-demo](../nuxt/blog-demo/) 附了可直接跑的單元測試與 E2E 測試）。

### 想把測試學成一門手藝 → 走[《Frontend Testing 課程》](../../frontend-testing-course/README.md)

本章教的是「在 Vue 專案裡把測試寫起來」；那門課（框架無關）教的是**測試策略本身**：測試替身的取捨、整合測試的邊界、E2E 與關鍵使用者旅程、可近用性與視覺回歸、CI 品質門檻、以及最現實的一題——**舊專案沒半個測試，怎麼從零開始補**。

祝學習順利，我們在進階課再會。

---

## 上一章 / 下一章

- 上一章：[第 7 章：Vue Router 與 Pinia](./07-router-and-pinia.md)
- 課程結束 → [Vue 源碼解析課](../vue-source/README.md) ｜ [Nuxt 全端課](../nuxt/README.md) ｜ [Frontend Testing 課程](../../frontend-testing-course/README.md)
