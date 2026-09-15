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

### 11.5 SSR 注意：所有生命週期 hook 都只在 client 跑

伺服器端渲染（SSR）時，server 上沒有真實 DOM，所以指令的**生命週期 hook 一個都不會在 server 執行**——
`created`、`beforeMount`、`mounted`、`updated`、`beforeUnmount`、`unmounted` 全部都是 client-only。
它們只會在瀏覽器端 hydration 之後才第一次被呼叫。

因此：

- 這些 hook 裡可以安全使用 `window` / `document`（因為它們本來就只在 client 跑），不需要 `typeof window` 防護。
- 但要注意：只靠 `mounted` 去改 DOM，會讓 server 端輸出的 HTML **不含**這個效果，直到 client hydration 後才補上——
  若這個效果會改變版面（例如加/移除節點、改屬性），可能造成 hydration mismatch 或畫面閃動。
- 若你需要「server 端輸出的 HTML 就帶上指令的效果」，要用下一節的 `getSSRProps`。

### 11.6 `getSSRProps`：讓指令在 server 端也能輸出屬性

SSR 唯一會在 server 執行的指令 hook 是 `getSSRProps(binding, vnode)`。
它不碰 DOM，而是**回傳一組 props（通常是屬性）**，由 Vue 在 server 端渲染成 HTML 字串。

```js
// 一個會在 server 端就把顏色寫進 style 的指令
export const color = {
  // client 端：hydration 後照常用 mounted/updated 操作 DOM
  mounted(el, binding) {
    el.style.color = binding.value;
  },
  updated(el, binding) {
    el.style.color = binding.value;
  },
  // server 端：回傳要 render 進 HTML 的屬性
  getSSRProps(binding /*, vnode */) {
    return { style: { color: binding.value } };
  },
};
```

這樣 server 輸出的 HTML 就會是 `<p style="color:red">...</p>`，hydration 前後畫面一致、不閃動。

重點：

- `getSSRProps` **只在 server 執行**，`mounted`/`updated` 等**只在 client 執行**，兩者互補：server 先把靜態結果寫進 HTML，client 再接手處理互動與後續更新。
- 只有「能表達成屬性」的效果適合 `getSSRProps`（如 `style`、`class`、`aria-*`）。像 `v-focus`、`v-click-outside` 這種本質是「事件監聽 / 呼叫 DOM API」的指令，server 端沒有對應輸出，就維持只寫 client hook 即可。

### 11.7 不要濫用指令

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

---

## 14. 練習作業參考解答

三題共用同一個骨架，也是本章最想讓你養成的習慣：

```text
mounted   → 建立副作用（事件、節點、計時器），把「之後還要用到的東西」存在 el 上
updated   → 只同步會變的資料，不重建副作用
unmounted → 把 mounted 建立的東西全部收乾淨
```

「把東西存在 `el` 上」不只是為了 `unmounted` 取得同一個參考（第 7 節已經講過），
還有第二個理由：**`mounted` 收到的 `binding` 是那一次渲染的舊物件**。
如果 handler 用閉包直接抓 `binding.value`，元件更新後指令仍然呼叫舊的 callback。
所以下面三題都改成：狀態放 `el`，`updated` 時覆寫，事件處理器一律從 `el` 讀最新值。

### 14.1 `v-longpress`

需求：長按 800ms 後觸發 callback，`arg` 可自訂時間（`v-longpress:1500="fn"`）。

```js
// directives/longpress.js
const DEFAULT_DURATION = 800;

function resolveDuration(binding) {
  // arg 一定是字串（v-longpress:1200 → arg === "1200"），要自己轉數字並檢查
  const ms = Number(binding.arg);
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_DURATION;
}

export const longpress = {
  mounted(el, binding) {
    // 把「會變動的東西」存成 state 放在 el 上，讓 handler 每次都讀最新值。
    // 不要用閉包直接捕捉 mounted 當下的 binding：那是舊物件，元件更新後不會跟著變。
    const state = {
      handler: binding.value,
      duration: resolveDuration(binding),
      timer: null,
      fired: false,
    };
    el.__longpress__ = state;

    const clear = () => {
      if (state.timer !== null) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    };

    state.onPointerDown = (event) => {
      // 只認主鍵（滑鼠左鍵／觸控／觸控筆），右鍵與中鍵不算長按
      if (event.button !== 0) return;
      state.fired = false;
      clear();
      state.timer = setTimeout(() => {
        state.timer = null;
        state.fired = true;
        if (typeof state.handler === "function") state.handler(event);
      }, state.duration);
    };

    // 放開、移出元素、被系統中斷（來電、捲動接管）都要取消計時
    state.onCancel = () => clear();

    // 長按觸發後放開，瀏覽器仍會補一個 click；用 capture 攔掉，避免同時觸發 @click
    state.onClick = (event) => {
      if (!state.fired) return;
      state.fired = false;
      event.stopPropagation();
      event.preventDefault();
    };

    // 行動裝置長按預設會跳系統選單，一併擋掉
    state.onContextMenu = (event) => event.preventDefault();

    el.addEventListener("pointerdown", state.onPointerDown);
    el.addEventListener("pointerup", state.onCancel);
    el.addEventListener("pointerleave", state.onCancel);
    el.addEventListener("pointercancel", state.onCancel);
    el.addEventListener("click", state.onClick, true);
    el.addEventListener("contextmenu", state.onContextMenu);
    el.style.touchAction = "manipulation";
    el.style.userSelect = "none";
  },

  updated(el, binding) {
    const state = el.__longpress__;
    if (!state) return;
    // 同步最新的 callback 與時間，handler 讀到的永遠是新的
    state.handler = binding.value;
    state.duration = resolveDuration(binding);
  },

  unmounted(el) {
    const state = el.__longpress__;
    if (!state) return;
    clearTimeout(state.timer);
    el.removeEventListener("pointerdown", state.onPointerDown);
    el.removeEventListener("pointerup", state.onCancel);
    el.removeEventListener("pointerleave", state.onCancel);
    el.removeEventListener("pointercancel", state.onCancel);
    el.removeEventListener("click", state.onClick, true);
    el.removeEventListener("contextmenu", state.onContextMenu);
    delete el.__longpress__;
  },
};
```

使用：

```vue
<script setup>
import { ref } from "vue";
import { longpress as vLongpress } from "./directives/longpress";

const log = ref("試試看按住不放");
const ms = ref(1200);
</script>

<template>
  <!-- 預設 800ms -->
  <button v-longpress="() => (log = '長按 800ms 觸發')">預設長按</button>

  <!-- arg 自訂 1500ms -->
  <button v-longpress:1500="() => (log = '長按 1.5 秒觸發')">慢速長按</button>

  <!-- arg 也可以是動態的 -->
  <button v-longpress:[ms]="() => (log = `長按 ${ms}ms 觸發`)">動態時間</button>

  <p>{{ log }}</p>
</template>
```

幾個容易漏掉的點：

- **`arg` 永遠是字串**：`v-longpress:1500` 拿到的是 `"1500"`，要自己 `Number()` 並檢查，
  否則寫錯成 `v-longpress:abc` 會變成 `setTimeout(fn, NaN)`（等同 0ms，一按就觸發）。
- **用 pointer 事件而不是 `mousedown` + `touchstart`**：後者在手機上會同時觸發，callback 跑兩次。
- **一定要處理取消**：`pointerup`（放開）、`pointerleave`（滑走）、`pointercancel`（系統中斷，例如來電或捲動接管）三種都要清計時器。
- **長按之後還會補一個 `click`**：如果同一顆按鈕又綁了 `@click`，短按長按都會觸發它。
  用 capture 階段攔截並在 `fired` 為真時 `stopPropagation()`，長按就不會順帶按到。

### 14.2 `v-tooltip`

需求：`mounted` 建立提示框、`updated` 同步文字、`unmounted` 移除節點與事件。

```js
// directives/tooltip.js
export const tooltip = {
  mounted(el, binding) {
    // 提示框掛在 body 底下，避免被父層 overflow: hidden 裁掉
    const tip = document.createElement("div");
    tip.className = "v-tooltip";
    tip.textContent = binding.value ?? ""; // 用 textContent 不用 innerHTML，避免 XSS
    tip.style.position = "absolute";
    tip.style.display = "none";
    tip.style.zIndex = "9999";
    tip.style.pointerEvents = "none"; // 提示框自己不吃滑鼠事件，否則會擋住底下元素
    document.body.appendChild(tip);

    const state = { tip };
    el.__tooltip__ = state;

    const place = () => {
      const rect = el.getBoundingClientRect();
      const tipRect = tip.getBoundingClientRect();
      // getBoundingClientRect 相對視窗；position: absolute 用的是文件座標，要加捲動量
      tip.style.top = `${rect.top + window.scrollY - tipRect.height - 8}px`;
      tip.style.left = `${rect.left + window.scrollX + (rect.width - tipRect.width) / 2}px`;
    };

    state.show = () => {
      if (!tip.textContent) return; // 沒文字就不顯示
      tip.style.display = "block";
      place(); // 要先 display 才量得到尺寸，順序反了會量到 0
    };
    state.hide = () => {
      tip.style.display = "none";
    };

    el.addEventListener("mouseenter", state.show);
    el.addEventListener("mouseleave", state.hide);
    // 鍵盤使用者也要看得到提示
    el.addEventListener("focus", state.show);
    el.addEventListener("blur", state.hide);
  },

  updated(el, binding) {
    const state = el.__tooltip__;
    if (!state) return;
    if (binding.value === binding.oldValue) return; // 11.2：value 沒變就別做事
    state.tip.textContent = binding.value ?? "";
    if (!state.tip.textContent) state.hide(); // 文字被清空就順手收起來
  },

  unmounted(el) {
    const state = el.__tooltip__;
    if (!state) return;
    el.removeEventListener("mouseenter", state.show);
    el.removeEventListener("mouseleave", state.hide);
    el.removeEventListener("focus", state.show);
    el.removeEventListener("blur", state.hide);
    state.tip.remove(); // 提示框掛在 body，不歸 Vue 管，一定要自己移除
    delete el.__tooltip__;
  },
};
```

搭配的樣式：

```css
.v-tooltip {
  background: #333;
  color: #fff;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  white-space: nowrap;
}
```

使用：

```vue
<script setup>
import { ref } from "vue";
import { tooltip as vTooltip } from "./directives/tooltip";

const tip = ref("我是提示文字");
</script>

<template>
  <button v-tooltip="tip" @click="tip = '文字換掉了'">滑上來看看</button>
</template>
```

幾個容易漏掉的點：

- **提示框掛在 `document.body`，不是掛在 `el` 裡面**：掛在裡面會被父層的 `overflow: hidden` 裁掉，
  也會被父層的 `transform` / `z-index` 影響堆疊。代價是這個節點**完全不歸 Vue 管**，
  `unmounted` 沒把它 `remove()` 掉就會留下孤兒節點——元件反覆掛載卸載時會一直累積。
- **先 `display: block` 再量尺寸**：`getBoundingClientRect()` 對 `display: none` 的元素回傳全 0，
  順序反了會把提示框定位到左上角。
- **`textContent` 而不是 `innerHTML`**：提示文字常常來自後端資料，用 `innerHTML` 等於開了 XSS。
- **`updated` 要先比對 `value`**（第 11.2 節）：元件每次更新都會進 `updated`，文字沒變就不該重寫 DOM。
- **`focus` / `blur` 也要綁**：只綁 `mouseenter` 的話，鍵盤操作的使用者永遠看不到提示。
- 想更完整可以在 `show()` 時加上 `scroll` / `resize` 監聽即時重新定位，`hide()` 時移除——
  記得這兩個監聽同樣要進 `unmounted` 的清單。

### 14.3 為 `v-click-outside` 加上 `.exclude`

需求：`.exclude` modifier 可指定某些元素不算「外部」。

這是第 7 節版本的完整替換版（不是片段），介面向下相容：

- 不加 modifier：`v-click-outside="fn"`，行為與第 7 節完全相同
- 加了 modifier：`v-click-outside.exclude="{ handler, exclude }"`，`exclude` 收 CSS selector 字串、DOM 元素、template ref 或它們的陣列

```js
// directives/clickOutside.js（第 7 節版本 + .exclude）
// 兩種用法：
//   v-click-outside="fn"
//   v-click-outside.exclude="{ handler: fn, exclude: ['#trigger', triggerRef] }"
function normalize(binding) {
  const value = binding.value;

  // 沒加 .exclude → 維持第 7 節的用法：value 本身就是 callback
  if (!binding.modifiers.exclude || typeof value === "function") {
    return { handler: value, exclude: [] };
  }

  const exclude = value?.exclude ?? [];
  return {
    handler: value?.handler,
    exclude: Array.isArray(exclude) ? exclude : [exclude],
  };
}

// 把清單裡的一項解析成真正的 DOM 節點清單
function resolveNodes(item) {
  if (!item) return [];
  // 字串當 CSS selector 查；每次點擊都重查，才抓得到之後才出現的節點
  if (typeof item === "string") return Array.from(document.querySelectorAll(item));
  // 先判 Node！<button>/<input> 自己就有 .value 屬性，
  // 若先看 .value 會把按鈕誤判成 ref 而拿到空字串（實測踩過的坑）
  if (item instanceof Node) return [item];
  // 元件 ref 拿到的是元件實例，真正的節點在 $el
  if (item.$el instanceof Node) return [item.$el];
  // 剩下才是 ref 物件 { value: ... }，遞迴解一層
  if ("value" in item) return resolveNodes(item.value);
  return [];
}

function isExcluded(target, exclude) {
  return exclude.some((item) =>
    resolveNodes(item).some((node) => node === target || node.contains(target)),
  );
}

export const clickOutside = {
  mounted(el, binding) {
    const state = { ...normalize(binding) };
    el.__clickOutside__ = state;

    state.onDocumentClick = (event) => {
      const target = event.target;
      // 1) 點在元素自己內部 → 不算外部
      if (el === target || el.contains(target)) return;
      // 2) 點在排除清單上 → 也不算外部
      if (isExcluded(target, state.exclude)) return;
      if (typeof state.handler === "function") state.handler(event);
    };

    // 用 capture 階段，避免內部 stopPropagation 影響
    document.addEventListener("click", state.onDocumentClick, true);
  },

  updated(el, binding) {
    const state = el.__clickOutside__;
    if (!state) return;
    // handler 與 exclude 都換成最新的；監聽器本身不動，不必反覆增刪
    Object.assign(state, normalize(binding));
  },

  unmounted(el) {
    const state = el.__clickOutside__;
    if (!state) return;
    document.removeEventListener("click", state.onDocumentClick, true);
    delete el.__clickOutside__;
  },
};
```

使用——這裡示範最典型的情境：**觸發鈕在面板外面**。

```vue
<script setup>
import { ref, useTemplateRef } from "vue";
import { clickOutside as vClickOutside } from "./directives/clickOutside";

const open = ref(false);
const triggerRef = useTemplateRef("trigger"); // Vue 3.5+
</script>

<template>
  <!-- 觸發鈕不在面板內：不排除的話，點它會先被判定成「點外部」而關閉，
       緊接著 @click 又把它打開 —— 畫面上看起來就是「這顆按鈕關不掉選單」 -->
  <button ref="trigger" @click="open = !open">切換選單</button>

  <div
    v-if="open"
    class="panel"
    v-click-outside.exclude="{ handler: () => (open = false), exclude: [triggerRef] }"
  >
    <p>面板內容，點這裡不會關</p>
  </div>
</template>
```

幾個容易漏掉的點：

- **`.exclude` 改變的是 `value` 的形狀**，所以 `normalize()` 要同時吃得下舊的函式寫法與新的物件寫法；
  只寫物件寫法會讓既有程式碼全部壞掉。
- **selector 要在「每次點擊時」才查**，不能在 `mounted` 先查好存起來——
  排除目標可能是之後才被 `v-if` 渲染出來的節點。
- **判斷 template ref 時要先 `instanceof Node`**：`<button>`、`<input>`、`<option>` 這些元素**自己就有 `.value` 屬性**，
  若先用 `item.value ?? item` 解包，按鈕會被誤認成 ref 而拿到空字串，排除就默默失效。
  這一條是實測時真的踩到的坑：測試裡排除的目標剛好是 `<button>`，排除完全沒作用。
- **模板裡的 ref 會被自動解包，陣列裡的不會**：`exclude: [triggerRef]` 寫在 template 中拿到的是 DOM 元素，
  但如果這個設定物件是在 `<script setup>` 裡組好再傳出來，指令收到的是 `{ value: el }`。兩種都要支援。
- **`updated` 只換 state，不要重綁監聽**：每次更新都 `removeEventListener` + `addEventListener` 沒有必要，
  也容易在某次分支漏掉而漏移除。

> 三個指令都可以直接照第 12 節的 `directives/index.js` 集中註冊。
