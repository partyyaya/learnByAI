# 13 — DOM 與事件

> DOM 是瀏覽器把 HTML 變成的一棵物件樹，JavaScript 透過它讀寫畫面；事件是使用者與瀏覽器通知你「發生了什麼」的方式。把畫面當成資料的結果，而不是到處直接改 DOM，是框架的出發點。

前兩部都在語言本身。從這一章開始進入瀏覽器提供的環境（[0.2 節](00-course-map-and-runtime.md#02-語言與執行環境)）：`document`、元素、事件都是瀏覽器的 API，不屬於 JavaScript 語言。這一章整理操作 DOM 與處理事件的基本功，最後用一個待辦清單把它們組起來。

本章範例存成 HTML 檔，用瀏覽器開啟，打開 DevTools 的 Console 觀察；用到 `<script type="module">` 的要透過本機伺服器開啟（[0.4 節](00-course-map-and-runtime.md#04-範例怎麼執行)）。

## 13.1 DOM 是什麼

瀏覽器讀取 HTML 後，建立一棵由**節點**組成的樹，稱為 DOM（Document Object Model）：

```html
<ul id="list">
  <li class="item">牛奶</li>
</ul>
```

```text
document
└─ html
   └─ body
      └─ ul#list            ← 元素節點（Element）
         ├─ "\n  "          ← 文字節點（換行與空白也是節點）
         ├─ li.item         ← 元素節點
         │  └─ "牛奶"        ← 文字節點
         └─ "\n"
```

JavaScript 改了 DOM，瀏覽器就會在下一次渲染時更新畫面（[10.5 節](10-event-loop.md#105-渲染時機與-requestanimationframe)）。

平常操作的大多是**元素**（Element）。`children`、`firstElementChild` 這類屬性只算元素；`childNodes`、`firstChild` 會把文字節點也算進去，所以常常拿到一段空白。

## 13.2 選取元素

```js
document.querySelector("#list");            // 第一個符合 CSS 選擇器的元素，找不到是 null
document.querySelectorAll("#list .item");   // 所有符合的元素（NodeList）
document.getElementById("list");            // 依 id 選取

const item = document.querySelector(".item");
item.closest("ul");                 // 往上找最近的祖先（包含自己）
item.matches("#list .item");        // 是否符合選擇器
list.querySelector(".item");        // 在某個元素底下找
```

- 選擇器的寫法和 CSS 完全相同，`querySelector` 一個方法就能涵蓋大部分需求。
- `querySelector` 找不到時回傳 `null`，接著讀屬性會丟出 `TypeError`。最常見的原因是 script 執行時元素還沒解析到；用 `type="module"` 的 script 會等 HTML 解析完才執行（[9.3 節](09-modules.md#93-在瀏覽器使用)），可以避開這個問題。
- `querySelectorAll` 回傳的 NodeList 是**靜態的**：之後新增的元素不會出現在裡面。`element.children` 則是**即時的**，會跟著 DOM 變化。NodeList 可以用 `for...of` 和 `forEach`，需要 `map`、`filter` 時先轉成陣列：`[...nodeList]`。

## 13.3 讀寫內容與屬性

### `textContent` 與 `innerHTML`

```js
el.textContent = "<b>不是粗體</b>"; // 原樣顯示文字，角括號不會被解析
el.innerHTML = "<b>粗體</b>";       // 解析成 HTML
```

**來自使用者或外部的資料一律用 `textContent`。** 把它們放進 `innerHTML`，等於讓別人在你的頁面上插入任意 HTML：

```js
// 危險：如果 comment 是 <img src=x onerror="偷走 cookie 的程式">，程式碼就會執行
list.innerHTML += `<li>${comment}</li>`;
```

這就是 XSS（跨站腳本攻擊）。`innerHTML` 只用在內容完全由自己掌控的情況；需要用範本產生結構時，用 13.4 節的 `<template>` 加 `textContent`。

### attribute 與 property

HTML 標籤上寫的是 **attribute**；DOM 物件上的是 **property**。大部分時候兩者同步，但有幾個重要的例外：

```html
<input id="name" value="預設值" />
```

```js
const input = document.querySelector("#name");
input.value = "使用者輸入";

input.value;                 // "使用者輸入"，property：目前的值
input.getAttribute("value"); // "預設值"，attribute：HTML 上寫的初始值
input.defaultValue;          // "預設值"
```

使用者在輸入框打字，改的是 `value` property，attribute 不變。讀取表單目前的值，一律用 property。

```js
link.setAttribute("href", "/docs");
link.getAttribute("href"); // "/docs"，原樣
link.href;                 // "https://example.com/docs"，解析成完整網址
```

### class、style 與 data-*

```js
el.classList.add("active");
el.classList.remove("active");
el.classList.toggle("done", todo.done); // 第二個參數決定加或移除
el.classList.contains("active");

el.style.transform = "translateX(10px)"; // 設定 inline style
el.dataset.userId = "7";                  // 對應 data-user-id="7"
el.dataset.userId;                        // "7"，一律是字串
```

切換外觀時，優先切換 class，把樣式寫在 CSS 裡；`style` 只用在每次都不同、必須動態計算的值（座標、尺寸）。`data-*` 適合在元素上記錄 id 這類資訊，13.7 節的事件委派會用到。

## 13.4 建立與插入節點

```js
const li = document.createElement("li");
li.textContent = "雞蛋";
li.classList.add("item");

list.append(li);          // 加在最後面（可以一次傳多個，也可以傳字串）
list.prepend(li);         // 加在最前面
li.before(otherLi);       // 加在 li 前面
li.after(otherLi);
li.replaceWith(newLi);
li.remove();
list.replaceChildren();   // 清空所有子節點
list.replaceChildren(a, b); // 換成指定的子節點
```

同一個節點只能在 DOM 裡的一個位置；把已經在頁面上的節點 `append` 到別處，是**移動**而不是複製。要複製用 `cloneNode(true)`（`true` 表示連同子節點）。

### 用 `<template>` 產生結構

結構比較複雜時，把 HTML 寫在 `<template>` 裡，需要時複製一份，再用 `textContent` 填入資料：

```html
<template id="item-template">
  <li>
    <span class="title"></span>
    <button data-action="remove">刪除</button>
  </li>
</template>
```

```js
const template = document.querySelector("#item-template");
const li = template.content.firstElementChild.cloneNode(true);
li.querySelector(".title").textContent = todo.title;
```

`<template>` 的內容不會顯示，也不會執行裡面的 script，只是一份可以複製的結構。這樣既保留了 HTML 的可讀性，又不會有 `innerHTML` 的 XSS 問題。

### 一次插入多個節點

在迴圈裡逐一 `append` 到頁面上，每次都會修改 DOM。先放進 `DocumentFragment`，最後一次插入：

```js
const fragment = document.createDocumentFragment();
for (const todo of todos) {
  fragment.append(createItem(todo));
}
list.replaceChildren(fragment);
```

同一個 task 裡的 DOM 修改本來就只會渲染一次（[10.5 節](10-event-loop.md#105-渲染時機與-requestanimationframe)），fragment 主要的好處是程式碼清楚、而且不會在中途讀取版面時觸發額外的計算（13.10 節）。

## 13.5 事件監聽

```js
function handleClick(event) {
  console.log(event.type, event.target);
}

button.addEventListener("click", handleClick);
button.removeEventListener("click", handleClick);
```

`removeEventListener` 必須傳入**同一個函式**。傳一個內容相同的新箭頭函式沒有用，因為那是另一個函式：

```js
button.addEventListener("click", () => count++);
button.removeEventListener("click", () => count++); // 移除不掉
```

### 選項

```js
button.addEventListener("click", handler, { once: true }); // 觸發一次後自動移除

window.addEventListener("scroll", onScroll, { passive: true }); // 保證不呼叫 preventDefault

const controller = new AbortController();
window.addEventListener("resize", onResize, { signal: controller.signal });
window.addEventListener("keydown", onKey, { signal: controller.signal });
controller.abort(); // 一次移除所有綁定這個 signal 的監聽器
```

`signal` 選項很適合元件：掛載時建立一個 `AbortController`，所有監聽器都綁同一個 signal，卸載時 `abort()` 一次清乾淨，不需要保存每個處理函式的參考。

`passive: true` 讓瀏覽器知道這個監聽器不會阻止捲動，可以不等 JavaScript 執行完就先捲動頁面。`touchstart`、`wheel` 這類會影響捲動的事件，沒有需要阻止預設行為時都應該加上。

### 事件物件

| 屬性與方法 | 意義 |
|-----------|------|
| `event.target` | 實際觸發事件的元素（例如被點到的按鈕裡面的圖示） |
| `event.currentTarget` | 目前執行的監聽器綁在哪個元素上 |
| `event.preventDefault()` | 取消瀏覽器的預設行為：送出表單、跟隨連結、勾選核取方塊 |
| `event.stopPropagation()` | 停止事件繼續傳遞（13.6 節） |
| `event.key`、`event.code` | 鍵盤事件按下的鍵 |
| `event.clientX`、`event.clientY` | 滑鼠、指標事件相對於視窗的座標 |

## 13.6 事件傳遞：捕獲、目標、冒泡

點擊一個按鈕時，事件不只發生在按鈕上。它從 `window` 一路往下傳到按鈕，再一路往上傳回來：

```html
<div id="outer">
  <div id="inner">
    <button id="btn">按我</button>
  </div>
</div>
```

```js
outer.addEventListener("click", () => log("outer 捕獲"), { capture: true });
inner.addEventListener("click", () => log("inner 捕獲"), { capture: true });
btn.addEventListener("click", (e) => log(`button target=${e.target.id} current=${e.currentTarget.id}`));
inner.addEventListener("click", (e) => log(`inner 冒泡 target=${e.target.id} current=${e.currentTarget.id}`));
outer.addEventListener("click", () => log("outer 冒泡"));
```

```text
outer 捕獲
inner 捕獲
button target=btn current=btn
inner 冒泡 target=btn current=inner
outer 冒泡
```

三個階段：

1. **捕獲**（capture）：從外往內，只有加了 `capture: true` 的監聽器會在這個階段執行。
2. **目標**（target）：到達實際被點到的元素。
3. **冒泡**（bubble）：從內往外，預設的監聽器都在這個階段執行。

在冒泡階段，`target` 一直是被點到的按鈕，`currentTarget` 則是監聽器所在的元素。

`stopPropagation()` 會讓事件停止往下一個元素傳遞。盡量少用：外層的程式碼（例如「點擊頁面其他地方時關閉選單」、分析工具的點擊追蹤）會因此收不到事件，而且很難發現原因。大部分情況可以改成在外層的監聽器裡檢查 `event.target`。

`focus`、`blur`、`mouseenter`、`mouseleave` 等少數事件不會冒泡；需要在外層監聽時，改用會冒泡的 `focusin`、`focusout`、`pointerover`、`pointerout`。

## 13.7 事件委派

利用冒泡，可以只在外層容器放**一個**監聽器，處理所有子元素的事件：

```js
list.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button || !list.contains(button)) return;

  const id = Number(button.closest("li").dataset.id);
  if (button.dataset.action === "remove") removeTodo(id);
  if (button.dataset.action === "toggle") toggleTodo(id);
});
```

好處：

- **之後新增的項目也有效**，不用每新增一個項目就綁一次監聽器，也不用在移除時解除。
- 一千個項目只有一個監聽器，而不是一千個。

`event.target` 可能是按鈕裡面的 `<svg>` 或 `<span>`，所以用 `closest("[data-action]")` 往上找到真正的按鈕，而不是直接判斷 `event.target`。`list.contains(button)` 確保找到的元素確實在清單裡。

## 13.8 Pointer Events：點擊與拖曳

Pointer Events 用同一組事件處理滑鼠、觸控與觸控筆：`pointerdown`、`pointermove`、`pointerup`、`pointercancel`。

```js
const box = document.querySelector("#box");
const offset = { x: 0, y: 0 }; // 目前的位移，下次拖曳從這裡接著算
let start = null;

box.addEventListener("pointerdown", (event) => {
  start = { x: event.clientX - offset.x, y: event.clientY - offset.y };
  box.setPointerCapture(event.pointerId); // 指標移出元素外，仍然收得到後續事件
});

box.addEventListener("pointermove", (event) => {
  if (!start) return;
  offset.x = event.clientX - start.x;
  offset.y = event.clientY - start.y;
  box.style.translate = `${offset.x}px ${offset.y}px`;
});

function endDrag() {
  start = null;
}
box.addEventListener("pointerup", endDrag);
box.addEventListener("pointercancel", endDrag);
```

```css
#box {
  touch-action: none; /* 在觸控裝置上，讓拖曳不被當成捲動頁面 */
}
```

幾個要點：

- **`setPointerCapture`** 讓快速拖曳、指標離開元素時，`pointermove` 和 `pointerup` 仍然送到這個元素。沒有它，拖太快會「掉」。
- **一定要處理 `pointercancel`**：瀏覽器接手手勢（例如開始捲動）、或指標裝置中斷時會觸發，這時不會有 `pointerup`。
- **位移以按下時的位置為基準計算**（`目前座標 - 起點`），而不是每次 `pointermove` 把移動量累加上去，才不會累積誤差。起點扣掉目前的 `offset`，第二次拖曳才會從上次放開的位置接著動。
- 要區分「點擊」和「拖曳」，記錄按下的位置，放開時位移小於幾個像素才當成點擊。
- `pointermove` 觸發得很頻繁，更新畫面的工作可以交給 `requestAnimationFrame` 合併（[15.6 節](15-browser-native-apis.md#156-排程rafidle-callback-與-microtask-怎麼選)）。

## 13.9 表單

```html
<form id="signup">
  <input name="email" type="email" required />
  <input name="age" type="number" min="0" />
  <button>送出</button>
</form>
```

```js
const form = document.querySelector("#signup");

form.addEventListener("submit", (event) => {
  event.preventDefault(); // 不讓瀏覽器整頁送出、重新載入

  const data = new FormData(form);
  const email = data.get("email");     // 一律是字串
  const age = Number(data.get("age")); // 數字要自己轉
  const all = Object.fromEntries(data); // { email: "...", age: "..." }

  submitSignup({ email, age });
});
```

- **監聽 `submit`，不要監聽按鈕的 `click`**。按 Enter 送出、用輔助科技送出，都會觸發 `submit`，不一定會觸發按鈕的 `click`。
- **`FormData`** 依 `name` 收集所有欄位，也可以直接當成 `fetch` 的 body（[14.4 節](14-fetch-and-network-requests.md#144-送出資料)）。讀出來的值都是字串（[1.6 節](01-values-types-and-comparison.md#16-型別轉換)）。
- `required`、`type="email"`、`min` 這些 HTML 驗證，會在觸發 `submit` 之前由瀏覽器檢查。自訂規則可以用 `input.setCustomValidity("訊息")` 接上同一套機制。前端驗證只是改善體驗，伺服器一定要再驗證一次。
- **`input` 事件**在每次輸入時觸發，適合即時搜尋（搭配 [3.5 節](03-scope-closures-and-hoisting.md#35-閉包的應用)的 debounce）；**`change` 事件**在值確定後觸發（輸入框失去焦點、選擇了選項）。

## 13.10 讀寫版面的成本

讀取 `offsetHeight`、`getBoundingClientRect()`、`scrollTop` 這類版面資訊時，瀏覽器必須先算出最新的版面。如果剛改過 DOM 或樣式，它就得**立刻**重新計算，而不是等到渲染時再一次算。

讀寫交錯會讓這個計算在迴圈裡重複發生，稱為 layout thrashing：

```js
// 慢：每一輪都先寫再讀，每次讀都觸發一次版面計算
for (const el of items) {
  el.style.width = "auto";
  el.style.height = `${el.offsetWidth / 2}px`;
}

// 快：先全部讀完，再全部寫入
for (const el of items) el.style.width = "auto";
const widths = items.map((el) => el.offsetWidth); // 只計算一次版面
items.forEach((el, i) => {
  el.style.height = `${widths[i] / 2}px`;
});
```

規則是**批次讀、批次寫**，不要交錯。DevTools 的 Performance 面板會把這種情況標成「Forced reflow」（[17.4 節](17-memory-and-performance.md#174-效能先量再改)）。

## 13.11 組起來：讓資料決定畫面

前面的 API 可以用兩種方式組合。第一種是每次操作都直接改 DOM：新增時 `append` 一個 `<li>`、勾選時切換 class、刪除時 `remove()`，同時還要記得更新「未完成幾項」的文字。功能一多，DOM 和資料很容易不同步。

第二種是**把資料當成唯一的來源**：所有操作只修改資料，再用一個 `render()` 依資料重新產生畫面。

```html
<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="utf-8" />
    <title>待辦清單</title>
    <style>
      .done span { text-decoration: line-through; color: #888; }
    </style>
  </head>
  <body>
    <form id="add-form">
      <input name="title" placeholder="新增待辦" required maxlength="50" />
      <button>新增</button>
    </form>
    <ul id="list"></ul>
    <p id="summary"></p>

    <template id="item-template">
      <li>
        <label>
          <input type="checkbox" data-action="toggle" />
          <span></span>
        </label>
        <button data-action="remove">刪除</button>
      </li>
    </template>

    <script type="module">
      // 1. 狀態：唯一的資料來源
      let todos = [
        { id: 1, title: "讀第 13 章", done: true },
        { id: 2, title: "寫一個待辦清單", done: false },
      ];
      let nextId = 3;

      const form = document.querySelector("#add-form");
      const list = document.querySelector("#list");
      const summary = document.querySelector("#summary");
      const template = document.querySelector("#item-template");

      // 2. 畫面：依狀態重新產生
      function render() {
        const fragment = document.createDocumentFragment();
        for (const todo of todos) {
          const li = template.content.firstElementChild.cloneNode(true);
          li.dataset.id = todo.id;
          li.classList.toggle("done", todo.done);
          li.querySelector("span").textContent = todo.title; // textContent，不是 innerHTML
          li.querySelector("input").checked = todo.done;
          fragment.append(li);
        }
        list.replaceChildren(fragment);

        const left = todos.filter((t) => !t.done).length;
        summary.textContent = `共 ${todos.length} 項，未完成 ${left} 項`;
      }

      // 3. 更新：只改狀態，然後重新 render
      function update(nextTodos) {
        todos = nextTodos;
        render();
      }

      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const title = new FormData(form).get("title").trim();
        if (!title) return;
        update([...todos, { id: nextId++, title, done: false }]);
        form.reset();
      });

      // 4. 事件委派：一個監聽器處理所有項目
      list.addEventListener("click", (event) => {
        const button = event.target.closest("[data-action]");
        if (!button || !list.contains(button)) return;
        const id = Number(button.closest("li").dataset.id);

        if (button.dataset.action === "toggle") {
          update(todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
        } else if (button.dataset.action === "remove") {
          update(todos.filter((t) => t.id !== id));
        }
      });

      render();
    </script>
  </body>
</html>
```

這個範例用到了前面幾章的東西：不可變更新（[4.5 節](04-objects-and-arrays.md#45-不可變更新)）、`<template>` 加 `textContent`、`FormData`、事件委派。

「資料 → `render()` → 畫面」的好處是畫面永遠和資料一致：摘要文字不會忘了更新，新增的項目自動有正確的狀態。代價是每次都重建整份清單：項目很多時效能不好，而且重建會讓輸入框失去焦點、捲動位置跑掉。

React、Vue 解決的就是這個代價：你一樣只寫「資料長什麼樣子，畫面就長什麼樣子」，框架比對前後兩次的結果，只更新真正變化的 DOM。理解了這個範例，就理解了這些框架為什麼要求你用不可變的方式更新狀態、為什麼列表要給 `key`。

## 13.12 本章小結

- DOM 是瀏覽器提供的物件樹；`querySelector` 用 CSS 選擇器選取，找不到回傳 `null`。
- 外部資料一律用 `textContent` 插入；`innerHTML` 只用在完全由自己掌控的內容。
- 表單目前的值讀 property（`input.value`），不是 attribute。
- 用 `<template>` 加 `cloneNode` 產生結構；多個節點先放進 `DocumentFragment` 再一次插入。
- `removeEventListener` 要傳同一個函式；用 `signal` 一次移除多個監聽器。
- 事件先捕獲、再到目標、再冒泡；少用 `stopPropagation`，多用事件委派加 `closest`。
- 拖曳用 Pointer Events 加 `setPointerCapture`，記得處理 `pointercancel`。
- 表單監聽 `submit`，用 `FormData` 收集欄位；讀寫版面要批次進行。
- 讓資料成為唯一的來源，由 `render()` 產生畫面，這是前端框架的核心想法。

下一章：[14 — fetch 與網路請求](14-fetch-and-network-requests.md)。

---

[上一章：手寫 Promise 與 async/await](12-implementing-promise-and-async-await.md) · [返回課程總覽](README.md) · [下一章：fetch 與網路請求](14-fetch-and-network-requests.md)
