# 第 09 章：SFC 與 Vite 整合鏈路

## 9.1 本章目標

這章要把「`.vue` 檔如何變成可執行模組」說清楚：

1. `@vue/compiler-sfc` 做了哪些拆解與編譯
2. `@vitejs/plugin-vue` 如何處理請求與產生虛擬模組
3. script/template/style 如何在開發模式與 HMR 串起來
4. 如何定位「SFC 編譯問題」與「Vite 整合問題」的邊界

---

## 9.2 先看完整請求路徑

開發模式下，一個 `App.vue` 常不是只編譯一次，而是被拆成多段請求。

概念流程：

```text
瀏覽器請求 /src/App.vue
  -> plugin-vue 回傳主模組：script（compileScript）＋ template 編出的 render（直接內嵌）
     ＋ import 各個 style 子模組
  -> 再請求 /src/App.vue?vue&type=style&index=0&scoped=xxxx&lang.css
  -> 主模組用 _export_sfc 把 render、__scopeId 等掛到 component 上（見 9.5）
```

一般的 HTML template 不會另外發請求；只有 template 帶 `lang`（例如 pug）或 `src` 時，才會多一個 template 子請求：帶 `lang` 時是 `/src/App.vue?vue&type=template...`，帶 `src` 時則直接請求那個外部檔（例如 `/src/App.html?import&vue&type=template&src=...`）。

---

## 9.3 `compiler-sfc` 的核心角色

`@vue/compiler-sfc` 主要提供四個核心能力：

1. `parse`：把 SFC 拆成 descriptor（script/template/style/custom blocks）
2. `compileScript`：處理 `<script>` / `<script setup>`（含宏轉換）
3. `compileTemplate`：把 template 編成 render function
4. `compileStyle`：處理 scoped、css vars、預處理器對接

> 嚴格說 style 部分是另一個編譯路徑，但課程中可視為 SFC pipeline 一環。

---

## 9.4 `<script setup>` 轉換重點

`compileScript` 會把 `<script setup>` 改寫成普通 component 選項形式可執行程式碼，並處理下面這些**編譯期宏**（compiler macros）——它們不是真的 runtime 函式，`compileScript` 會在編譯時把它們展開/移除：

| 宏 | 版本 | 編譯後做什麼 |
|----|------|------|
| `defineProps` | 3.2 | 收集 props 宣告，改寫成 component 的 `props` 選項 |
| `defineEmits` | 3.2 | 改寫成 `emits` 選項 |
| `defineExpose` | 3.2 | 產生 `expose({...})` 呼叫，控制實例對外暴露的東西 |
| `withDefaults` | 3.2 | 為以型別宣告的 props 補預設值（展開成 runtime 預設） |
| **`defineModel`** | **3.4 穩定** | 宣告一個雙向綁定用的 model；展開成 `modelValue` prop + `update:modelValue` emit，並回傳一個「寫回會自動 emit」的 ref。**這是最該掌握的新宏**（元件版 `v-model` 的官方寫法） |
| `defineOptions` | 3.3 | 在 `<script setup>` 內宣告 `name` / `inheritAttrs` 等原本要寫在一般 `<script>` 的選項 |
| `defineSlots` | 3.3 | 純型別宏，為 slots 提供 TS 型別（無 runtime 產物） |

此外，**reactive props destructure（3.5 穩定）**：以往 `const { foo } = defineProps()` 解構後會失去響應式，3.5 起編譯器會把解構出的變數改寫成「讀取時走 `props.foo`」，所以解構後**仍保持響應式**（含預設值 `const { foo = 1 } = defineProps<...>()` 也由編譯期處理）。這正是「宏是編譯期語法、不是 runtime API」的最好例子——同樣寫法在沒有編譯器的純 runtime 下並不成立。

這也是為什麼很多宏看起來像 runtime API，但其實是編譯期語法：你在 runtime 匯入它們反而會拿到「這是宏、不該被呼叫」的警告。

---

## 9.5 template 編譯與 render 綁定

`compileTemplate` 會輸出 render function 程式碼。開發模式下，plugin-vue 把它改名為 `_sfc_render` 內嵌在主模組，最後用 `_export_sfc` 掛到 component 上。

以下面這個 `App.vue` 為例：

```vue
<script setup>
import { ref } from 'vue'
const count = ref(0)
</script>

<template>
  <button @click="count++">{{ count }}</button>
</template>

<style scoped>
button { color: red; }
</style>
```

plugin-vue 產生的主模組（Vue 3.5.41、`@vitejs/plugin-vue` 6.0.8 實際輸出，省略從 `vue` 匯入的幾行與 HMR 程式碼、路徑精簡）：

```js
const _sfc_main = {
  __name: 'App',
  setup(__props, { expose: __expose }) {
  __expose();

const count = ref(0)

const __returned__ = { count, ref }
Object.defineProperty(__returned__, '__isScriptSetup', { enumerable: false, value: true })
return __returned__
}

}

function _sfc_render(_ctx, _cache, $props, $setup, $data, $options) {
  return (_openBlock(), _createElementBlock("button", {
    onClick: _cache[0] || (_cache[0] = $event => ($setup.count++))
  }, _toDisplayString($setup.count), 1 /* TEXT */))
}

import "/src/App.vue?vue&type=style&index=0&scoped=7a7a37b1&lang.css"

import _export_sfc from '\0plugin-vue:export-helper'
export default /*#__PURE__*/_export_sfc(_sfc_main, [['render',_sfc_render],['__scopeId',"data-v-7a7a37b1"],['__file',"/src/App.vue"]])
```

production build 遇到 `<script setup>` 時會改用 `inlineTemplate`：template 直接編進 `setup()`，`setup()` 回傳的就是 render 函式，元件上不再有 `render` 選項（`compileScript(descriptor, { inlineTemplate: true })` 的輸出）：

```js
export default {
  __name: 'App',
  setup(__props) {

const count = ref(0)

return (_ctx, _cache) => {
  return (_openBlock(), _createElementBlock("button", {
    onClick: _cache[0] || (_cache[0] = $event => (count.value++))
  }, _toDisplayString(count.value), 1 /* TEXT */))
}
}

}
```

追「template 編譯結果」時，先確認你看的是 dev（`_sfc_render`，透過 `$setup` 存取）還是 production（內嵌在 `setup()`，直接存取區域變數）。

---

## 9.6 scoped CSS 的機制

當你使用 `<style scoped>`：

1. 編譯器會產生 scopeId（如 `data-v-xxxx`）
2. template 中元素會帶上該 scope 屬性
3. style selector 會被改寫為僅命中該 scope

結果：樣式被限制在當前組件，不污染全域。

---

## 9.7 Vite plugin-vue 在做什麼

你可以把 plugin-vue 理解成「SFC 請求協調器」：

- 攔截 `.vue` 與 query 子請求
- 呼叫 compiler-sfc 對應編譯 API
- 管理 descriptor 快取與無效化
- 串接 HMR 邏輯（script/template/style 局部熱更新）

---

## 9.8 HMR 更新路徑（高頻故障點）

不同區塊變更行為不同：

- **template 變更**：通常可重新編譯 render，保留 component state
- **style 變更**：多半直接熱替換 CSS
- **script 變更**：可能觸發較大範圍重載（視改動型態）

當你遇到 HMR 異常，先判斷是哪一類區塊改動。

---

## 9.9 Source Map 與除錯建議

若要追 SFC 轉換問題，建議：

1. 看 Vite transform 後中介碼（定位是否編譯即錯）
2. 檢查 source map 對應（定位行號偏移）
3. 分離 script/template/style 問題來源
4. 用最小 SFC 重現，減少外部干擾

---

## 9.10 常見整合問題與排查

### 問題一：宏函式報未定義

可能是編譯器版本不一致或 plugin 未正確生效。  
先確認 `@vue/compiler-sfc`、`vue`、`@vitejs/plugin-vue` 版本對齊。

### 問題二：scoped 樣式未命中

檢查是否有深層選擇器語法誤用，或樣式實際被其他高優先級規則覆蓋。

### 問題三：HMR 失效或整頁重載

先判斷是 script/template/style 哪個分支，  
再看 plugin 記錄的模組圖與無效化策略是否符合預期。

---

## 9.11 本章源碼閱讀建議路徑

建議順序：

1. 了解 plugin-vue 如何拆請求（主模組內嵌 template 的 render + style 子模組；template 帶 `lang`／`src` 時才另成子模組）
2. 看 descriptor 建立與快取
3. 看 `compileScript` / `compileTemplate` / `compileStyle` 呼叫點
4. 追 HMR 分支如何決定局部更新或重載

---

## 9.12 本章作業

### 必做

- 對一個 `.vue` 檔記錄：
  - 主模組轉換結果（含內嵌的 `_sfc_render`）
  - style 子請求輸出
- 修改 script/template/style 各一次，記錄 HMR 行為差異

### 加分

- 把 template 改成 `<template src="./App.html">` 引入外部檔案，觀察多出來的 template 子請求
- 寫一份「SFC 故障排查決策樹」（至少 10 個節點）
- 製作一個含 `<script setup> + scoped + CSS vars` 的綜合示例

### 驗收標準

- 能口述 `.vue` 從請求到執行的完整鏈路
- 能解釋為何 `<script setup>` 是編譯期特性
- 能在 5 分鐘內判斷一個問題更可能在 compiler 還是 Vite plugin 層

---

## 9.13 下一章預告

下一章把前面各章的能力整合成一套源碼閱讀工作流：  
你會用這套可落地的流程，從真實 issue 的重現、定位、修補到驗證，完成一次「真正的源碼實戰」。
