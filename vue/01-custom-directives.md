# 製作 Vue 自訂指令（Custom Directives）

> 指令（directive）是 Vue 用來「直接操作 DOM」的官方擴充點。
> 當一個需求用 component / composable 都不順手、本質上是「對某個元素做 DOM 層級的事」時，自訂指令通常是最乾淨的解法。

---

## 1. 本章目標

讀完並做完範例後，你應該能：

1. 說清楚「什麼時候該用指令、什麼時候不該用」
2. 寫出區域與全域註冊的自訂指令
3. 熟悉指令的生命週期 hook（`mounted` / `updated` / `unmounted` …）
4. 正確使用 `binding`（`value` / `arg` / `modifiers`）
5. 處理常見陷阱：事件監聽未清除、`updated` 漏判、SSR、元件根節點繼承問題

---

## 2. 心智模型：指令是「掛在元素上的生命週期 hook」

一般 component 關心的是「資料 → 畫面」；
指令關心的是「這個 DOM 元素出現／更新／消失時，我要對它做什麼」。

```text
<div v-focus>          掛載元素時 → 我要 el.focus()
<img v-lazy="url">     掛載時設 observer，更新時換 url，卸載時斷開 observer
<button v-permission>  掛載時依權限決定要不要移除這顆按鈕
```

判斷準則（很重要）：

- **要直接碰 DOM（focus、捲動、量測、第三方 DOM 套件）** → 適合指令
- **只是組合資料與 UI** → 用 component / composable，不要用指令

---

## 3. 指令的生命週期 hook

Vue 3 指令物件可實作以下 hook（皆為選用）：

| Hook | 觸發時機 | 典型用途 |
|------|----------|----------|
| `created` | 元素 attribute / 事件監聽套用「前」 | 需要早於原生 attribute 設定的處理 |
| `beforeMount` | 元素插入 DOM「前」 | 插入前的準備 |
| `mounted` | 元素插入父節點後 | `focus()`、初始化第三方套件、加事件 |
| `beforeUpdate` | 元素更新「前」 | 記錄更新前狀態（如捲動位置） |
| `updated` | 元素與子節點更新「後」 | 依新 `value` 重新計算 |
| `beforeUnmount` | 元素卸載「前」 | 卸載前收尾 |
| `unmounted` | 元素卸載後 | **清除事件監聽、observer、timer** |

每個 hook 的簽名：

```ts
type DirectiveHook = (
  el: HTMLElement,          // 綁定的真實 DOM 元素
  binding: DirectiveBinding,// 綁定資訊（見下節）
  vnode: VNode,             // 對應的 vnode
  prevVnode: VNode | null   // 前一個 vnode（僅在 update 相關 hook 有值）
) => void;
```

---

## 4. Vue 2 與 Vue 3 寫 directives 的差異

如果你寫過 Vue 2 的自訂指令，搬到 Vue 3 時最容易踩到的就是「hook 名稱全變了」。
這一節整理兩者的核心差異。

### 4.1 生命週期 hook 名稱對照

Vue 3 把指令的 hook 改成「對齊元件生命週期」的命名，更直覺也更一致：

| Vue 2 | Vue 3 | 說明 |
|-------|-------|------|
| `bind` | `created` / `beforeMount` | Vue 2 的 `bind` 大致對應 Vue 3 的 `beforeMount`；若要更早可用 `created` |
| `inserted` | `mounted` | 元素插入父節點後 |
| `update` | （移除）| Vue 3 不再有對應 hook，改用 `beforeUpdate` |
| `componentUpdated` | `updated` | 元素與子節點更新後 |
| `unbind` | `unmounted` | 卸載後清理 |
| （無）| `beforeUpdate` | Vue 3 新增：更新前 |
| （無）| `beforeUnmount` | Vue 3 新增：卸載前 |

重點：Vue 2 最常用的 `bind` + `inserted`，在 Vue 3 幾乎都直接換成 `mounted` 即可。

```js
// Vue 2
Vue.directive("focus", {
  inserted(el) {
    el.focus();
  },
});

// Vue 3
app.directive("focus", {
  mounted(el) {
    el.focus();
  },
});
```

### 4.2 全域註冊 API 不同

```js
// Vue 2：掛在全域 Vue 建構子上
Vue.directive("focus", { inserted(el) { el.focus(); } });

// Vue 3：掛在 app 實例上（每個 app 獨立，不再污染全域）
const app = createApp(App);
app.directive("focus", { mounted(el) { el.focus(); } });
```

### 4.3 `binding` 物件大致相同，但有兩點要注意

- `value` / `oldValue` / `arg` / `modifiers` 兩版都有，用法一致
- Vue 3 的 `binding.instance` 指向「使用該指令的元件實例」（Vue 2 沒有這個欄位）
- Vue 2 第四個參數 `oldVnode` 在 Vue 3 改為 `prevVnode`

### 4.4 用在元件上的行為差異

- Vue 2：指令用在元件上時，行為較不明確
- Vue 3：指令會套用到元件的**根節點**；若元件是**多根（Fragment）**，指令會被忽略並發出警告（見 11.3）

### 4.5 函式簡寫的觸發時機不同

```js
// Vue 2：函式簡寫等同於 bind + update
Vue.directive("color", (el, binding) => { /* bind 與 update 時觸發 */ });

// Vue 3：函式簡寫等同於 mounted + updated
app.directive("color", (el, binding) => { /* mounted 與 updated 時觸發 */ });
```

> 遷移口訣：**`bind`→`mounted`、`inserted`→`mounted`、`update`/`componentUpdated`→`updated`、`unbind`→`unmounted`**，
> 全域註冊從 `Vue.directive` 換成 `app.directive`。

---

## 5. `binding` 物件：指令拿到的所有資訊

以這個用法為例：

```html
<div v-demo:foo.bar.baz="message"></div>
```

對應的 `binding` 會是：

```ts
{
  value: message,          // 綁定的值（message 的當前值）
  oldValue: prevMessage,   // 前一次的值（只有 updated/beforeUpdate 有）
  arg: "foo",              // 冒號後的參數
  modifiers: { bar: true, baz: true }, // 點號修飾符
  instance: <當前元件實例>,
  dir: <指令物件本身>
}
```

重點：

- `value` 是**會變動**的，每次更新都要從 `binding.value` 重讀，不要快取舊值
- `arg` 也可以是動態的：`v-demo:[dynamicArg]="value"`
- `modifiers` 是布林旗標集合，適合切換行為（如 `.prevent`、`.lazy`）

---

## 6. 範例一：`v-focus`（最小可用指令）

最經典的入門範例：元素掛載時自動聚焦。

### 區域註冊（`<script setup>`）

`<script setup>` 中，以 `v` 開頭並符合命名規則的駝峰變數會自動成為指令：

```vue
<script setup>
// 名稱必須是 vXxx，使用時對應 v-xxx
const vFocus = {
  mounted(el) {
    el.focus();
  },
};
</script>

<template>
  <input v-focus placeholder="頁面載入後自動聚焦" />
</template>
```

### 一般 `<script>`（Options 寫法）

```js
export default {
  directives: {
    focus: {
      mounted(el) {
        el.focus();
      },
    },
  },
};
```

### 全域註冊

```js
// main.js
import { createApp } from "vue";
import App from "./App.vue";

const app = createApp(App);

app.directive("focus", {
  mounted(el) {
    el.focus();
  },
});

app.mount("#app");
```

---

## 7. 範例二：`v-click-outside`（重點示範事件清除）

點擊元素「外部」時觸發 callback —— 下拉選單、彈窗關閉常用。
這個範例的關鍵是：**在 `unmounted` 一定要移除事件監聽**，否則造成記憶體洩漏。

```js
// directives/clickOutside.js
export const clickOutside = {
  mounted(el, binding) {
    // 把 handler 掛在 el 上，卸載時才取得到同一個參考
    el.__clickOutside__ = (event) => {
      // 點擊發生在元素內部 → 不處理
      if (el === event.target || el.contains(event.target)) return;
      // binding.value 應該是一個函式
      if (typeof binding.value === "function") {
        binding.value(event);
      }
    };
    // 用 capture 階段，避免內部 stopPropagation 影響
    document.addEventListener("click", el.__clickOutside__, true);
  },

  unmounted(el) {
    document.removeEventListener("click", el.__clickOutside__, true);
    delete el.__clickOutside__;
  },
};
```

使用：

```vue
<script setup>
import { ref } from "vue";
import { clickOutside as vClickOutside } from "./directives/clickOutside";

const open = ref(false);
</script>

<template>
  <div class="dropdown" v-click-outside="() => (open = false)">
    <button @click="open = !open">切換選單</button>
    <ul v-if="open">
      <li>項目 A</li>
      <li>項目 B</li>
    </ul>
  </div>
</template>
```

> 把 handler 存在 `el.__clickOutside__`，是為了讓 `unmounted` 能拿到「同一個函式參考」來移除。
> 直接 `addEventListener('click', fn)` 但 `removeEventListener` 傳入不同 fn，是無法移除的常見錯誤。

---

## 8. 範例三：`v-lazy`（示範 `updated` 與 observer 清理）

圖片進入視窗才載入，並在 `value` 變動時換圖、卸載時斷開 observer。

```js
// directives/lazy.js
export const lazy = {
  mounted(el, binding) {
    const loadImage = () => {
      el.src = binding.value;
    };

    // 建立一個 IntersectionObserver，用來偵測元素是否進入視窗範圍。
    // 把 observer 實例存在 el 上，unmounted 時才取得到同一個參考來斷開。
    el.__observer__ = new IntersectionObserver((entries) => {
      // entries 是「被觀察元素的可見度變化」清單；
      // 這裡只觀察一個元素，所以 forEach 實際只會跑一次。
      entries.forEach((entry) => {
        // isIntersecting 為 true 代表元素已經進入（或部分進入）視窗 → 此時才載入圖片
        if (entry.isIntersecting) {
          loadImage();
          // 圖片已載入，任務完成，停止觀察這個元素，避免後續重複觸發
          el.__observer__.unobserve(el);
        }
      });
    });

    // 開始觀察目標元素；元素進入視窗時上面的 callback 才會被呼叫
    el.__observer__.observe(el);
  },

  updated(el, binding) {
    // value 改變才更新，避免不必要的賦值
    if (binding.value !== binding.oldValue) {
      el.src = binding.value;
    }
  },

  unmounted(el) {
    if (el.__observer__) {
      el.__observer__.disconnect();
      delete el.__observer__;
    }
  },
};
```

```html
<img v-lazy="imageUrl" alt="lazy loaded" />
```

---

## 9. 範例四：`v-permission`（示範 `arg` / `modifiers`）

依使用者權限決定按鈕是否顯示，並用修飾符切換「隱藏」或「移除」。

```js
// directives/permission.js
const userPermissions = ["article:read", "article:edit"]; // 實務上來自 store / API

export const permission = {
  mounted(el, binding) {
    const required = binding.value; // 例如 "article:delete"
    const allowed = userPermissions.includes(required);

    if (allowed) return;

    if (binding.modifiers.disable) {
      // v-permission.disable → 只 disable 不移除
      el.setAttribute("disabled", "disabled");
      el.classList.add("is-disabled");
    } else {
      // 預設行為：直接從 DOM 移除
      el.parentNode && el.parentNode.removeChild(el);
    }
  },
};
```

```html
<!-- 沒權限 → 直接移除 -->
<button v-permission="'article:delete'">刪除</button>

<!-- 沒權限 → 只 disable -->
<button v-permission.disable="'article:delete'">刪除</button>
```

> 注意：用 `removeChild` 移除節點屬於「破壞性」操作，若該元素之後又因響應式重新渲染，行為可能不直覺。
> 安全性敏感的權限控制不該只靠前端指令 —— 後端仍必須驗證。

---

## 10. 函式簡寫

若只需要在 `mounted` 與 `updated` 做「相同的事」，可用函式簡寫：

```js
app.directive("color", (el, binding) => {
  // 這個函式會在 mounted 與 updated 兩個時機都被呼叫
  el.style.color = binding.value;
});
```

```html
<p v-color="'red'">紅色文字</p>
```

適合純粹「同步 value → DOM 樣式」的簡單情境。

---

## 11. 注意事項與常見陷阱

### 11.1 一定要清除副作用

`addEventListener`、`setInterval`、`IntersectionObserver`、第三方套件實例
都必須在 `unmounted`（或 `beforeUnmount`）對應清除。否則：

- 元件反覆掛載／卸載會累積監聽器 → 記憶體洩漏
- callback 操作已不存在的 DOM → 報錯

### 11.2 `updated` 要做 `value` 比對

`updated` 在元件每次更新都可能觸發，即使指令的 `value` 沒變。
務必比對 `binding.value !== binding.oldValue` 再做昂貴操作。

### 11.3 用在元件上要小心根節點

指令用在「元件」而非原生元素上時，會嘗試套用到元件的**根節點**。

- 若元件有多個根節點（Fragment），指令無法決定套用對象，會發出警告且被忽略
- 解法：讓元件單根、或在元件內部用 `v-bind="$attrs"` / 明確處理

### 11.4 命名規則

- 全域 / Options：`app.directive('myThing')` → 用 `v-my-thing`
- `<script setup>`：變數必須是 `vMyThing`（駝峰、`v` 開頭）→ 用 `v-my-thing`

### 11.5 SSR 注意

伺服器端渲染時，只有 `created`、`beforeMount`、`mounted` 之外的 DOM hook 不會在 server 執行
（server 沒有真實 DOM）。涉及 `window` / `document` 的程式碼要放在 client-only 的 hook（如 `mounted`），
或加 `typeof window !== 'undefined'` 防護。

### 11.6 不要濫用指令

能用 `:class` / `:style` / `v-if` / 事件綁定解決的，就不要做成指令。
指令的代價是「繞過 Vue 的宣告式模型直接操作 DOM」，過度使用會讓狀態難以追蹤。

---

## 12. 把指令整理成可重用模組

實務上建議集中註冊，方便維護：

```js
// directives/index.js
import { clickOutside } from "./clickOutside";
import { lazy } from "./lazy";
import { permission } from "./permission";

export default {
  install(app) {
    app.directive("click-outside", clickOutside);
    app.directive("lazy", lazy);
    app.directive("permission", permission);
  },
};
```

```js
// main.js
import directives from "./directives";
app.use(directives);
```

---

## 13. 練習作業

1. 寫一個 `v-longpress`：長按 800ms 後觸發 callback，支援 `.duration` 透過 `arg` 自訂時間
2. 寫一個 `v-tooltip`：`mounted` 建立提示框、`updated` 同步文字、`unmounted` 移除節點與事件
3. 為 `v-click-outside` 加上 `.exclude` modifier，可排除特定元素不視為「外部」

> 完成後對照「注意事項」逐條檢查：副作用都清掉了嗎？`updated` 有比對嗎？用在元件上會不會有根節點問題？
