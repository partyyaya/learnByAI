# 第 3 章：模板語法與指令

> 第 2 章你學會了「怎麼準備響應式資料」，這一章要學「怎麼把資料綁進畫面、怎麼回應使用者操作」。
> Vue 的 `<template>` 看起來就是 HTML，但多了一組以 `v-` 開頭的**指令（directive）**——`v-bind`、`v-on`、`v-if`、`v-for`…。把這組指令練熟，你就能寫出絕大多數畫面。

---

## 本章目標

完成這一章後，你應該可以：

1. 用 `{{ }}` 做文字插值，並知道 `v-html` 的用途與 XSS 風險。
2. 用 `v-bind`（縮寫 `:`）綁定屬性、用 `v-on`（縮寫 `@`）綁定事件。
3. 分清 `v-if` / `v-else-if` / `v-else` 與 `v-show` 的差異與取捨。
4. 用 `v-for` 渲染陣列 / 物件 / 範圍，並說出 **`key` 為什麼重要**。
5. 知道為什麼 `v-for` 與 `v-if` **不要放在同一個元素**。
6. 用物件 / 陣列語法做 class 與 style 綁定。
7. 用事件修飾符（`.stop` / `.prevent` / `.self` / `.once` / `.capture`）與按鍵修飾符（`.enter` 等）。
8. 認識 `v-model` 的雙向綁定（基本款，表單細節留到第 6 章）。

---

## 1. 文字插值與 `v-html`

### 1.1 `{{ }}` 文字插值

最基本的綁定，把響應式資料塞進畫面。`{{ }}` 裡可以放**單一 JS 運算式**（不能放 `if`、`for` 這種陳述式）：

```vue
<script setup>
import { ref } from 'vue'
const name = ref('Gary')
const score = ref(88)
</script>

<template>
  <p>你好，{{ name }}</p>
  <p>成績：{{ score >= 60 ? '及格' : '不及格' }}</p>  <!-- 三元運算子 OK -->
  <p>加權：{{ score * 1.1 }}</p>                      <!-- 運算式 OK -->
</template>
```

`{{ }}` 一律把內容當**純文字**輸出，就算內容有 HTML 標籤也會被跳脫顯示成文字——這是安全的預設。

### 1.2 `v-html`：輸出真正的 HTML（小心 XSS）

如果你真的要把一段字串當 HTML 插進去（例如後端回傳的富文本），用 `v-html`：

```vue
<script setup>
import { ref } from 'vue'
const rawHtml = ref('<strong>粗體</strong>')
</script>

<template>
  <p>{{ rawHtml }}</p>          <!-- 顯示：<strong>粗體</strong>（純文字） -->
  <p v-html="rawHtml"></p>      <!-- 顯示：粗體（真的變粗體） -->
</template>
```

> ⚠️ **XSS 警告**：`v-html` 會原樣執行裡面的 HTML，若內容含使用者輸入或不可信來源，攻擊者可塞入 `<script>` 或惡意 `onerror` 竊取資料。**永遠不要對「使用者可控的內容」用 `v-html`**；非用不可時，先用可信的淨化庫（如 DOMPurify）清洗。

---

## 2. `v-bind`：綁定屬性（縮寫 `:`）

`{{ }}` 只能用在標籤「內容」，不能用在「屬性」。要讓屬性值跟著資料變，用 `v-bind`：

```vue
<script setup>
import { ref } from 'vue'
const imgUrl = ref('/logo.png')
const isDisabled = ref(true)
const linkId = ref('main-link')
</script>

<template>
  <!-- 完整寫法 -->
  <img v-bind:src="imgUrl" />

  <!-- 縮寫（幾乎都用這個）：把 v-bind 換成一個冒號 -->
  <img :src="imgUrl" :alt="'圖片：' + linkId" />

  <!-- 綁布林屬性：值為 false 時 Vue 會自動移除該屬性 -->
  <button :disabled="isDisabled">送出</button>

  <!-- 動態屬性名：屬性名也能是變數（用 [] 包起來） -->
  <a :[`data-${linkId}`]="'yes'">動態屬性名</a>
</template>
```

重點：

- **縮寫 `:`** 是慣例，`:src` 等同 `v-bind:src`。
- 綁布林屬性（`disabled`、`checked`…）時，值 `false` 會讓 Vue 直接移除該屬性，符合 HTML 直覺。

---

## 3. `v-on`：綁定事件（縮寫 `@`）

回應使用者操作（點擊、輸入、送出…）用 `v-on`：

```vue
<script setup>
import { ref } from 'vue'
const count = ref(0)

function add() { count.value++ }
function addBy(n) { count.value += n }
</script>

<template>
  <!-- 完整寫法 -->
  <button v-on:click="add">+1</button>

  <!-- 縮寫（幾乎都用這個）：把 v-on: 換成 @ -->
  <button @click="add">+1</button>

  <!-- 傳參數：用行內函式呼叫 -->
  <button @click="addBy(5)">+5</button>

  <!-- 需要原生事件物件時，用 $event -->
  <input @input="count = Number($event.target.value)" />

  <p>count：{{ count }}</p>
</template>
```

重點：

- **縮寫 `@`**，`@click` 等同 `v-on:click`。
- 傳值時寫成呼叫 `@click="addBy(5)"`；需要事件物件時用特殊變數 `$event`。

---

## 4. 條件渲染：`v-if` 家族 vs `v-show`

### 4.1 `v-if` / `v-else-if` / `v-else`

依條件決定「要不要渲染」某段畫面：

```vue
<script setup>
import { ref } from 'vue'
const status = ref('loading')   // 'loading' | 'success' | 'error'
</script>

<template>
  <p v-if="status === 'loading'">載入中…</p>
  <p v-else-if="status === 'success'">載入成功！</p>
  <p v-else>發生錯誤</p>

  <button @click="status = 'success'">設為成功</button>
</template>
```

`v-else-if` / `v-else` 必須「緊接」在 `v-if` 之後（中間不能插別的元素）。

### 4.2 `v-show`

`v-show` 也是控制顯示，但機制不同：

```vue
<template>
  <p v-show="isOpen">我一直都在 DOM 裡，只是靠 CSS display 控制顯示</p>
</template>
```

### 4.3 差異與取捨

| | `v-if` | `v-show` |
|---|---|---|
| 機制 | 條件為假時**根本不渲染**（不在 DOM 裡） | 一直渲染，只切換 CSS `display: none` |
| 初始成本 | 條件為假時完全不建，較省 | 不論如何都先建好 |
| 切換成本 | 每次切換都要建立/銷毀，較貴 | 只改 CSS，很便宜 |
| 適用 | 條件很少改變、或初始就用不到 | 需要**頻繁切換**顯示/隱藏 |

> 判斷準則：**頻繁切換用 `v-show`（例如切換分頁面板）；很少切換、或初始根本不需要的內容用 `v-if`（例如「只有登入才顯示」）。**

---

## 5. 列表渲染：`v-for` 與 key

### 5.1 渲染陣列

```vue
<script setup>
import { ref } from 'vue'
const lessons = ref([
  { id: 'v-101', title: 'Vue 心智模型', minutes: 30 },
  { id: 'v-102', title: '響應式基礎', minutes: 45 },
  { id: 'v-103', title: '模板與指令', minutes: 40 },
])
</script>

<template>
  <ul>
    <!-- (item, index) 第二個參數是索引 -->
    <li v-for="(lesson, index) in lessons" :key="lesson.id">
      {{ index + 1 }}. {{ lesson.title }}（{{ lesson.minutes }} 分）
    </li>
  </ul>
</template>
```

### 5.2 渲染物件與範圍

```vue
<script setup>
import { ref } from 'vue'
const user = ref({ name: 'Gary', age: 30, city: 'Taipei' })
</script>

<template>
  <!-- 迭代物件：(value, key, index) -->
  <ul>
    <li v-for="(value, key) in user" :key="key">{{ key }}：{{ value }}</li>
  </ul>

  <!-- 範圍：v-for="n in 5" → n 從 1 到 5 -->
  <span v-for="n in 5" :key="n">★</span>
</template>
```

### 5.3 為什麼 `key`這麼重要？

`v-for` 一定要配一個穩定唯一的 `:key`。原因跟渲染效能與正確性都有關：

> Vue 更新列表時，會用 `key` 來辨認「更新前後哪個項目是同一個」。有穩定的 `key`，Vue 就能精準地重用、移動、刪除對應的 DOM 節點；沒有 `key`（或用 `index` 當 key），在**插入 / 刪除 / 排序**時，Vue 會對不上，可能把 DOM 狀態（例如輸入框裡的字、動畫狀態）錯置到別的項目上。

原則：

- **用資料本身穩定的 id 當 key**（`:key="lesson.id"`）。
- **不要用 `index` 當 key**，除非列表是靜態、永不排序也不增刪。

這點和 React 的 `key` 用意完全一樣（可對照 React 課第 3 章的清單渲染）。

### 5.4 `v-for` 與 `v-if` 不要放同一個元素

看似方便，但這是官方明令避免的寫法：

```vue
<!-- ❌ 不要這樣：v-for 與 v-if 同層 -->
<li v-for="lesson in lessons" v-if="lesson.published" :key="lesson.id">
  {{ lesson.title }}
</li>
```

問題在於「誰先執行」不直覺，且每次渲染都會先跑完整個 `v-for` 再逐一判斷，浪費且易錯。正確做法有兩種：

```vue
<script setup>
import { ref, computed } from 'vue'
const lessons = ref([
  { id: 'v-101', title: '已發布', published: true },
  { id: 'v-102', title: '草稿', published: false },
])

// 做法 A（推薦）：先用 computed 過濾，再 v-for 乾淨的清單
const publishedLessons = computed(() => lessons.value.filter(l => l.published))
</script>

<template>
  <!-- 做法 A：v-for 過濾後的清單 -->
  <ul>
    <li v-for="lesson in publishedLessons" :key="lesson.id">{{ lesson.title }}</li>
  </ul>

  <!-- 做法 B：用一個 <template> 包一層，把 v-if 移到外面（不產生額外 DOM） -->
  <ul>
    <template v-for="lesson in lessons" :key="lesson.id">
      <li v-if="lesson.published">{{ lesson.title }}</li>
    </template>
  </ul>
</template>
```

> 記住：**過濾清單優先用 `computed`**（宣告式、可讀、有快取）；真要就地判斷再用 `<template>` 包一層。

---

## 6. class 與 style 綁定

`:class` 和 `:style` 是 `v-bind` 的特例，Vue 給了物件 / 陣列語法，讓你依狀態切樣式很方便。

### 6.1 class 綁定

```vue
<script setup>
import { ref } from 'vue'
const isActive = ref(true)
const hasError = ref(false)
const theme = ref('dark')
</script>

<template>
  <!-- 物件語法：key 是 class 名，value 為 true 才套上 -->
  <div :class="{ active: isActive, 'text-danger': hasError }">物件語法</div>

  <!-- 陣列語法：把多個 class 湊起來 -->
  <div :class="[theme, isActive ? 'active' : '']">陣列語法</div>

  <!-- 可以和靜態 class 並存，Vue 會自動合併 -->
  <div class="card" :class="{ active: isActive }">合併靜態與動態</div>
</template>

<style scoped>
.active { font-weight: 700; color: #369a6e; }
.text-danger { color: #dc2626; }
.dark { background: #111827; color: #fff; padding: 8px; }
.card { border: 1px solid #e5e7eb; padding: 8px; border-radius: 8px; }
</style>
```

### 6.2 style 綁定

```vue
<script setup>
import { ref } from 'vue'
const color = ref('teal')
const size = ref(18)
</script>

<template>
  <!-- 物件語法：CSS 屬性用駝峰式（fontSize）或字串 'font-size' 都可 -->
  <p :style="{ color: color, fontSize: size + 'px' }">動態 style</p>

  <!-- 陣列語法：合併多個 style 物件 -->
  <p :style="[{ color }, { fontWeight: 700 }]">合併多組</p>
</template>
```

---

## 7. 事件修飾符與按鍵修飾符

Vue 讓你把常見的事件處理（阻止冒泡、阻止預設、只觸發一次…）用「修飾符」寫在指令上，省掉在函式裡呼叫 `event.stopPropagation()` 這類樣板碼。

### 7.1 事件修飾符

```vue
<script setup>
function onOuter() { console.log('外層被點') }
function onInner() { console.log('內層被點') }
function onSubmit() { console.log('送出，且不會刷新頁面') }
function onOnce() { console.log('這句只會出現一次') }
</script>

<template>
  <!-- .stop：阻止事件冒泡（等同 event.stopPropagation()） -->
  <div @click="onOuter">
    外層
    <button @click.stop="onInner">內層（點它不會觸發外層）</button>
  </div>

  <!-- .prevent：阻止預設行為（等同 event.preventDefault()），表單最常用 -->
  <form @submit.prevent="onSubmit">
    <button>送出</button>
  </form>

  <!-- .self：只有「點到自己」才觸發（點到子元素冒泡上來不算） -->
  <div @click.self="onOuter" style="padding:20px;background:#eee">
    只有點到這層灰底才觸發
    <button @click="onInner">點我不會觸發外層</button>
  </div>

  <!-- .once：只觸發一次，之後自動解除 -->
  <button @click.once="onOnce">只生效一次</button>

  <!-- .capture：用捕獲模式監聽（由外往內），修飾符可串接 -->
  <div @click.capture="onOuter">捕獲階段先觸發</div>
</template>
```

修飾符速查：

| 修飾符 | 作用 |
|--------|------|
| `.stop` | 阻止冒泡 |
| `.prevent` | 阻止預設行為（表單送出、連結跳轉…） |
| `.self` | 只有事件目標是元素本身才觸發 |
| `.once` | 只觸發一次 |
| `.capture` | 使用捕獲模式（由外層先接到） |

### 7.2 按鍵修飾符

處理鍵盤事件時，用按鍵修飾符指定「哪個鍵」：

```vue
<script setup>
import { ref } from 'vue'
const text = ref('')
function submit() { console.log('送出：', text.value); text.value = '' }
</script>

<template>
  <!-- 按 Enter 才送出（等同判斷 event.key === 'Enter'） -->
  <input v-model="text" @keyup.enter="submit" placeholder="打字後按 Enter" />

  <!-- 常見按鍵：.esc .tab .delete .space .up .down .left .right -->
  <input @keyup.esc="text = ''" placeholder="按 Esc 清空" />

  <!-- 系統修飾鍵組合：.ctrl .alt .shift .meta，可串接 -->
  <textarea @keydown.ctrl.enter="submit" placeholder="Ctrl + Enter 送出"></textarea>
</template>
```

---

## 8. `v-model`：雙向綁定（先認識，細節在第 6 章）

前面 `v-bind`（單向：資料 → 畫面）加 `v-on`（單向：畫面 → 資料）合起來就是「雙向綁定」。表單元素很常需要這種雙向，Vue 給了語法糖 `v-model`：

```vue
<script setup>
import { ref } from 'vue'
const name = ref('')
const agree = ref(false)
</script>

<template>
  <!-- v-model 等於「:value 綁上去 + @input 寫回來」的組合 -->
  <input v-model="name" placeholder="輸入名字" />
  <p>你好，{{ name }}</p>

  <label>
    <input type="checkbox" v-model="agree" /> 我同意
  </label>
  <p>同意狀態：{{ agree }}</p>
</template>
```

`v-model` 用在 `<input>` / `<textarea>` / `<select>` 上會依元素型別自動選對「該綁哪個屬性、聽哪個事件」。你在第 2 章綜合範例用過的 `v-model.number`，就是它的修飾符之一。

> 本章先讓你認得 `v-model` 就好。**完整的表單處理**（各種輸入型別、`.number` / `.trim` / `.lazy` 修飾符、驗證與送出）留到 [第 6 章：表單與驗證](./06-forms-and-validation.md)。而**把 `v-model` 用在自訂元件上**（`defineModel`），是下一章的重點。

---

## 9. 一句話帶過：自訂指令

除了內建的 `v-if`、`v-for` 等，你也能寫自己的 `v-xxx`（例如 `v-focus`、`v-lazy`），用來「直接操作 DOM」。這屬於進階主題，本課不深講。

> 想深入自訂指令的生命週期與寫法，見本 repo 專章：[製作 Vue 自訂指令](../01-custom-directives.md)。日常畫面用內建指令就夠了。

---

## 常見陷阱

1. **對使用者內容用 `v-html`**：等於開 XSS 大門。使用者可控的內容一律不要 `v-html`，非用不可先淨化。
2. **`v-for` 沒加 `:key` 或用 `index` 當 key**：列表增刪 / 排序時 DOM 狀態會錯置。用資料的穩定 id。
3. **`v-for` 與 `v-if` 同層**：改用 `computed` 先過濾，或用 `<template>` 包一層把 `v-if` 移出去。
4. **該用 `v-show` 卻用 `v-if`（或反之）**：頻繁切換用 `v-show`，很少切換或初始不需要用 `v-if`。
5. **在表單 `submit` 忘了 `.prevent`**：預設會刷新整頁，SPA 幾乎一定要 `@submit.prevent`。
6. **`{{ }}` 裡放陳述式**：插值只能放「運算式」，不能放 `if`／`for`／宣告，複雜邏輯請移到 `computed` 或函式。

---

## 練習作業

1. 做一個待辦清單：`ref` 一個陣列，用 `v-for` + `:key` 渲染；輸入框用 `v-model` + `@keyup.enter` 新增項目。
2. 每個待辦項加一個「完成」勾選，用 `:class` 物件語法讓完成的項目加上刪除線樣式。
3. 加一組篩選按鈕（全部 / 未完成 / 已完成），用 `computed` 過濾清單（示範「別把 `v-if` 塞進 `v-for`」）。
4. 加一個「刪除」按鈕在每項旁邊；父層容器綁 `@click` 印一句話，子按鈕用 `@click.stop` 確認不會冒泡觸發父層。
5. 把 `v-if`/`v-else` 用在「清單為空時顯示『目前沒有待辦』」，並比較若改用 `v-show` 差在哪。

---

## 上一章 / 下一章

- 上一章：[第 2 章：響應式基礎（ref / reactive / computed / watch）](./02-reactivity-fundamentals.md)
- 下一章：[第 4 章：元件與溝通（props / emit / v-model / slots）](./04-components-props-emit.md)
