# 第 06 章：編譯器主流程（parse / transform / codegen）

## 6.1 本章目標

這章要建立你對 Vue 編譯器的主幹理解：

1. template 怎麼被解析成 AST
2. AST 如何被轉換成更利於 runtime 的結構
3. 最終如何產生 render function 字串
4. runtime helper 是如何被收集與注入的

學完你要能回答：  
「`<div>{{ msg }}</div>` 為何能變成可執行的 render code？」

---

## 6.2 先看總流程

編譯主鏈可視化：

```text
template string
  -> parse        (字串 -> AST)
  -> transform    (AST 優化/改寫，附加 codegenNode)
  -> codegen      (AST -> JS render code)
  -> new Function / bundler 處理後執行
```

在 `compiler-core` 裡，你會常看到 `baseCompile` 作為入口。

---

## 6.3 parse：把模板字串變成 AST

### parse 的本質

parse 做的是語法分析，不處理執行期資料。  
它會讀取字元流，產生節點樹（Root / Element / Text / Interpolation...）。

### 常見節點類型

| AST 節點 | 對應語法 |
|---|---|
| `Root` | 整份模板 |
| `Element` | 一般標籤（如 `div`） |
| `Text` | 純文字 |
| `Interpolation` | `{{ expr }}` |
| `SimpleExpression` | 表達式內容 |
| `Attribute` / `Directive` | props、`v-if`、`v-for` 等 |

> 版本註記（Vue 3.5.x）：**Vue 3.4 起 template parser 已重寫為 tokenizer 狀態機**（`compiler-core/src/tokenizer.ts`），解析效能約提升 2x。上面「讀字元流、遞迴下降建樹」只是**概念模型**；實際追 `baseParse` 會看到它驅動一個 `Tokenizer`，用一連串狀態與 callback（`onopentagname`、`ontext`、`onattribdata`…）邊掃邊建 AST，而不是傳統遞迴下降。看不懂新結構時，先用這裡的概念模型理解「要產出什麼」，再回頭對照 tokenizer 的狀態流。

---

## 6.4 以範例理解 parse 結果

輸入：

```vue
<div class="box">{{ msg }}</div>
```

抽象後 AST 大意：

```text
Root
└─ Element(div)
   ├─ props: class="box"
   └─ children:
      └─ Interpolation
         └─ SimpleExpression("msg")
```

這時候還沒有 patch flag，也還沒有 render function。  
parse 只負責「看懂語法」。

---

## 6.5 transform：編譯器真正的工程核心

transform 會做三類事情：

1. 走訪 AST（traverse）
2. 對節點套用轉換（node transforms / directive transforms）
3. 為 codegen 準備 `codegenNode` 與 helper 依賴

你可以把 transform 理解成「語法樹重寫 + 優化標記」階段。

---

## 6.6 transform context 會管理什麼

常見內容：

- `helpers`：收集 render 需要的 helper（如 `toDisplayString`）
- `components` / `directives`：記錄 template 使用到的元件與指令
- `hoists`：可提升的靜態節點
- `scopes`：v-for / v-slot 等作用域計數
- `currentNode` / `parent`：遍歷時上下文

這些資料會直接影響 codegen 輸出。

---

## 6.7 transform 常見處理項目

### A. Interpolation

`{{ msg }}` 會變成需要 helper 的顯示字串邏輯。

### B. Element

元素節點會被轉成 VNode 建立呼叫，並判斷是否是 block、是否有動態 props。

### C. Directive（`v-if` / `v-for`）

會把模板語法糖改寫成條件/循環結構，並生成對應 codegen 節點。

> 以下 D / E / F 對應 Vue 3.5.x，是實務最常追的三種 directive transform。

### D. `v-model`（`transformModel`）

`v-model` 是語法糖，編譯期由 `transformModel` 展開。

**用在元件上** → 拆成一個 prop + 一個更新事件：

```js
// <MyInput v-model="msg" /> 編譯後（概念）
_createVNode(MyInput, {
  modelValue: _ctx.msg,
  "onUpdate:modelValue": $event => (_ctx.msg = $event)
})
```

具名 `v-model:title="x"` 則展開成 `title` + `onUpdate:title`。這正是 `defineModel()`（見 09 章）背後對應的協定。

**用在原生表單元素上**（由 `compiler-dom` 覆寫的 `transformModel` 接手）→ 展開成 **value 綁定 + input 事件**，並掛上對應的 runtime directive：

```js
// <input v-model="msg" /> 編譯後（概念）
_withDirectives(_createElementVNode("input", {
  "onUpdate:modelValue": $event => (_ctx.msg = $event)
}, null, 512 /* NEED_PATCH */), [
  [_vModelText, _ctx.msg]   // vModelText 負責設 el.value 並監聽 input 事件
])
```

### E. 事件（`transformOn` + `cacheHandlers`）

`transformOn` 把 `@click="fn"` 轉成 `onClick` prop。問題是：若每次 render 都產生新的處理函式，傳給子元件當 prop 會破壞其穩定性、也讓 patch 多做事。於是有 **`cacheHandlers`** 優化——把處理器**快取進 `_cache`**，之後每次 render 都拿同一個函式：

```js
// <button @click="fn"> 編譯後（開啟 cacheHandlers）
_createElementVNode("button", {
  onClick: _cache[0] || (_cache[0] = (...args) => (_ctx.fn && _ctx.fn(...args)))
})
```

`_cache` 由 render function 的參數帶入（`render(_ctx, _cache)`），跨 render 保留。因為引用穩定，這類節點甚至不需要 `PROPS` patch flag。

### F. slots（`buildSlots`）

slots 分兩端編譯。

**插槽出口**（元件模板內的 `<slot>`）→ 編成 `_renderSlot`：

```js
// <slot name="header" :item="item" />
_renderSlot(_ctx.$slots, "header", { item: item })
```

**插槽內容**（使用元件時的 `<template #name>`）→ 由 `buildSlots` 編成一個 slots 物件，每個具名 slot 都用 `withCtx` 包起來（保留正確的 render 上下文），scoped slot 的參數就是 callback 的參數：

```js
// <Comp><template #header="{ item }">{{ item.name }}</template></Comp>
_createVNode(Comp, null, {
  header: _withCtx(({ item }) => [ _toDisplayString(item.name) ]),
  _: 1 /* STABLE */
})
```

若 slot 內容是**條件/動態產生**的（`v-if`、`v-for` 包住 `<template #x>`），`buildSlots` 無法靜態確定 slot 集合，會標上 **`DYNAMIC_SLOTS`** flag（輸出 `_: 2`），runtime 就會走較保守的 slot 更新路徑（見 07 章 patch flags）。

---

## 6.8 codegen：輸出 render function

codegen 會把 transform 產出的 `codegenNode` 轉成字串程式碼，包含：

- function 簽名
- helper 引入別名
- 建立 vnode 的呼叫
- 條件與列表邏輯

簡化概念：

```ts
function render(_ctx, _cache) {
  return (_openBlock(), _createElementBlock("div", null, _toDisplayString(_ctx.msg), 1))
}
```

你看到的 `_openBlock`、`_createElementBlock`、`_toDisplayString` 就是 helper 系統的結果。

---

## 6.9 一條完整追蹤路徑（建議實作）

### 範例模板

```vue
<ul>
  <li v-for="item in list" :key="item.id">{{ item.name }}</li>
</ul>
```

請依序做：

1. 看 parse AST（至少辨識 `Element`、`ForNode`、`Interpolation`）
2. 看 transform 後產生哪些 helper 與 patch flag
3. 看 codegen render code（確認列表與 key 邏輯）
4. 對照 runtime 更新時實際會用到哪些資訊

---

## 6.10 為什麼編譯器要做這麼多事

因為 runtime 需要高效率更新。  
若所有判斷都留到 runtime，每次更新都要全量比對，成本會很高。

編譯器的價值是：

- 提前知道哪些是靜態內容
- 提前知道哪些是動態點
- 讓 runtime 在更新時少做無效工作

---

## 6.11 本章源碼閱讀建議路徑

建議順序：

1. `baseCompile`
2. `baseParse` 及 parse children/element/interpolation 邏輯
3. `transform` 主流程與 context
4. 常見 node transform（element、text、if、for）
5. `generate` 與輸出函式

第一輪先追「單一模板範例」即可，不要同時開太多語法特性。

---

## 6.12 常見誤區

### 誤區一：把編譯器當黑盒

結果就是 runtime 很多行為看不懂，尤其 patch flag 與 block tree。

### 誤區二：看 AST 但不對照 render code

transform 結果是否正確，最終要看 codegen 輸出與 runtime 行為。

### 誤區三：以為每次更新都重新編譯 template

一般情況下 template 在建置期已編譯完成，runtime 只執行 render function。

---

## 6.13 本章作業

### 必做

- 選 3 段模板（簡單元素、`v-if`、`v-for`）追 parse AST
- 記錄每段模板 transform 增加了哪些 helper
- 對照 codegen，標出 render function 中對應片段

### 加分

- 嘗試寫一個簡化 node transform（例如為特定元素加註記）
- 比較開發模式與生產模式輸出差異（若有）

### 驗收標準

- 能口述 parse/transform/codegen 職責分工
- 能指出某個 template 語法在 AST 與 render code 的對應位置
- 能解釋 helper 是何時被收集、何時被輸出

---

## 6.14 下一章預告

下一章會深挖編譯器最佳化：  
`hoistStatic`、block tree、patch flags 如何直接決定 runtime 更新成本。
