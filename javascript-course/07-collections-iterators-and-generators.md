# 07 — Map／Set、Symbol、迭代器與產生器

> `for...of`、展開、解構、`Array.from`、`Promise.all` 能接受陣列以外的東西，是因為它們都只認一個協議：迭代器。

物件當字典用有不少限制，所以 ES2015 加入了 `Map` 和 `Set`。這一章先介紹這兩種集合，再說明讓它們能被 `for...of` 走訪的迭代協議，最後是用來實作迭代器的產生器（generator）。產生器還會在 [12.5 節](12-implementing-promise-and-async-await.md#125-用-generator-模擬-asyncawait)用來模擬 `async/await`。

## 7.1 Map

`Map` 是鍵值對的集合，鍵可以是**任何型別**，包括物件：

```js
const userA = { id: 1 };
const userB = { id: 2 };

const visits = new Map();
visits.set(userA, 3).set(userB, 1); // set 回傳 Map 本身，可以串接
visits.set(userA, visits.get(userA) + 1);

visits.get(userA); // 4
visits.size;       // 2
visits.has(userB); // true
visits.delete(userB);
```

用一般物件做同樣的事會出錯，因為物件的鍵一律被轉成字串：

```js
const obj = {};
obj[userA] = 1;
obj[userB] = 2;
Object.keys(obj); // ["[object Object]"]，兩個使用者變成同一個鍵
```

### 走訪與轉換

`Map` 保證依**加入順序**走訪：

```js
const m = new Map([
  ["b", 1],
  ["a", 2],
]);

for (const [key, value] of m) {
  console.log(key, value); // "b" 1，然後 "a" 2
}

[...m.keys()];       // ["b", "a"]
Object.fromEntries(m); // { b: 1, a: 2 }
new Map(Object.entries({ x: 1 })); // Map(1) { "x" => 1 }
```

`JSON.stringify(map)` 得到 `"{}"`。要傳給後端或存起來時，先轉成陣列（`[...map]`）或物件（`Object.fromEntries(map)`）。

### 什麼時候用 Map，什麼時候用物件

| 用物件 | 用 Map |
|--------|--------|
| 結構固定、欄位事先知道的資料（一筆使用者、一份設定） | 執行時才知道有哪些鍵的字典 |
| 要轉成 JSON | 鍵不是字串（物件、DOM 節點） |
| | 經常新增、刪除鍵 |
| | 鍵來自使用者輸入 |

最後一點值得說明：物件會繼承原型上的屬性。用物件當字典、鍵又來自外部時，`"constructor" in dict` 是 `true`，`dict["__proto__"]` 有特殊行為。`Map` 沒有這些問題。

## 7.2 Set

`Set` 是不重複值的集合：

```js
const tags = new Set(["js", "css", "js"]);
tags.size;        // 2
tags.has("css");  // true
tags.add("html");
tags.delete("js");

[...new Set([3, 1, 3, 2, 1])]; // [3, 1, 2]，陣列去重，保留第一次出現的順序
```

判斷是否重複用的是和 `===` 幾乎相同的規則（`NaN` 視為相等）。物件比較的是參考，兩個內容相同的物件仍然是兩個元素：

```js
new Set([{ id: 1 }, { id: 1 }]).size; // 2
```

### 集合運算

ES2025 加入了集合運算方法，Node 22 以上和 2024 年後的瀏覽器都支援：

```js
const a = new Set([1, 2, 3]);
const b = new Set([2, 3, 4]);

a.union(b);               // Set {1, 2, 3, 4}
a.intersection(b);        // Set {2, 3}
a.difference(b);          // Set {1}
a.symmetricDifference(b); // Set {1, 4}
a.isSubsetOf(new Set([1, 2, 3, 4])); // true
```

### 用 Set 加速查找

`array.includes(x)` 要從頭找到尾，在迴圈裡反覆呼叫，成本是兩者長度的乘積。先把其中一邊轉成 `Set`，每次查找就是常數時間：

```js
// 慢：每個訂單都掃一次 blockedIds 陣列
orders.filter((o) => !blockedIds.includes(o.userId));

// 快：先轉成 Set
const blocked = new Set(blockedIds);
orders.filter((o) => !blocked.has(o.userId));
```

資料量小時看不出差別；兩邊各五萬筆時，在一般筆電上實測從約 380 毫秒降到約 4 毫秒，資料再多一倍，`includes` 的版本大約慢四倍（[17.5 節](17-memory-and-performance.md#175-常見的效能問題與對策)）。

## 7.3 WeakMap 與 WeakSet

`WeakMap` 的鍵必須是物件，而且是**弱參考**：鍵物件在其他地方都沒有人用時，可以被垃圾回收，對應的值也一起消失。

```js
const metadata = new WeakMap();

function track(element) {
  metadata.set(element, { clicks: 0, firstSeen: Date.now() });
}
```

如果用一般的 `Map`，DOM 元素從頁面移除後，`Map` 仍然參考著它，元素和資料都不會被回收，這就是記憶體洩漏。`WeakMap` 讓「附加在某個物件上的資料」跟著物件的生命週期走。

代價是 `WeakMap` 和 `WeakSet` **不能走訪**，也沒有 `size`：因為內容隨時可能被回收，列出來的結果沒有意義。

另外還有 `WeakRef` 與 `FinalizationRegistry`，可以直接持有弱參考、在物件被回收時收到通知。回收的時機由引擎決定，不可預測，一般應用程式很少需要用到。

## 7.4 Symbol

`Symbol` 是一種原始型別，每個 Symbol 都是唯一的：

```js
const id = Symbol("id"); // "id" 只是描述，方便除錯
Symbol("x") === Symbol("x"); // false

const user = { name: "Ann", [id]: 123 };
user[id];             // 123
Object.keys(user);    // ["name"]，Symbol 鍵不會出現
JSON.stringify(user); // '{"name":"Ann"}'
```

Symbol 鍵不會和任何字串鍵衝突，也不會出現在一般的走訪裡。函式庫用它在物件上放內部資料，不怕和使用者的欄位撞名。

`Symbol.for("app.key")` 會從全域登錄表取得 Symbol：同樣的名稱拿到同一個 Symbol，可以跨模組、跨 iframe 共用。

### 內建的 Symbol

語言用一組內建的 Symbol 當作「掛鉤」，讓你的物件參與語言的內建行為：

| Symbol | 作用 |
|--------|------|
| `Symbol.iterator` | 讓物件可以被 `for...of`、展開走訪（7.5 節） |
| `Symbol.asyncIterator` | 讓物件可以被 `for await...of` 走訪（7.7 節） |
| `Symbol.toPrimitive` | 自訂物件轉成數字或字串的方式 |
| `Symbol.hasInstance` | 自訂 `instanceof` 的判斷 |

## 7.5 迭代協議

一個物件只要有 `[Symbol.iterator]()` 方法，並回傳一個**迭代器**，就是**可迭代的**（iterable）。迭代器是一個有 `next()` 方法的物件，每次呼叫回傳 `{ value, done }`：

```js
const it = [10, 20][Symbol.iterator]();
it.next(); // { value: 10, done: false }
it.next(); // { value: 20, done: false }
it.next(); // { value: undefined, done: true }
```

陣列、字串、`Map`、`Set`、`arguments`、DOM 的 `NodeList` 都是可迭代的。接受可迭代物件的語法與 API：

- `for...of`
- 展開 `[...x]`、`fn(...x)`
- 陣列解構 `const [a, b] = x`
- `Array.from(x)`、`new Map(x)`、`new Set(x)`
- `Promise.all(x)`、`Promise.race(x)` 等組合器

### 自己做一個可迭代物件

```js
const range = {
  from: 1,
  to: 4,
  [Symbol.iterator]() {
    let current = this.from;
    const last = this.to;
    return {
      next() {
        return current <= last
          ? { value: current++, done: false }
          : { value: undefined, done: true };
      },
    };
  },
};

[...range];                         // [1, 2, 3, 4]
Array.from(range, (x) => x * 10);   // [10, 20, 30, 40]
Math.max(...range);                 // 4
const [first, second] = range;      // 1, 2

for (const n of range) {
  if (n > 2) break; // 可以中途停止
}
```

`range` 本身不存任何陣列，數字是在 `next()` 被呼叫時才算出來的。

## 7.6 產生器

手寫 `next()` 要自己管理狀態。**產生器函式**（generator function）用 `function*` 宣告，用 `yield` 交出一個值，讓引擎替你管理狀態：

```js
function* rangeGen(from, to) {
  for (let i = from; i <= to; i++) {
    yield i;
  }
}

[...rangeGen(1, 4)]; // [1, 2, 3, 4]
```

呼叫產生器函式**不會執行函式本體**，而是回傳一個產生器物件，它同時是迭代器和可迭代物件。每次呼叫 `next()`，函式從上次暫停的地方執行到下一個 `yield`：

```js
function* lazyLog() {
  console.log("gen start");
  yield 1;
  console.log("after 1");
  yield 2;
  console.log("gen end");
}

const g = lazyLog(); // 什麼都沒印
g.next(); // 印出 "gen start"，回傳 { value: 1, done: false }
g.next(); // 印出 "after 1"，回傳 { value: 2, done: false }
g.next(); // 印出 "gen end"，回傳 { value: undefined, done: true }
```

用產生器改寫 7.5 節的 `range`，放進 class 裡：

```js
class Range {
  constructor(from, to) {
    this.from = from;
    this.to = to;
  }

  *[Symbol.iterator]() {
    for (let i = this.from; i <= this.to; i++) yield i;
  }
}

[...new Range(3, 5)]; // [3, 4, 5]
```

### 惰性與無限序列

產生器只在被要求時才計算下一個值，所以可以表示無限長的序列：

```js
function* naturals() {
  let n = 1;
  while (true) yield n++;
}

function* take(iterable, count) {
  if (count <= 0) return;
  for (const x of iterable) {
    yield x;
    if (--count <= 0) return;
  }
}

[...take(naturals(), 5)]; // [1, 2, 3, 4, 5]
```

ES2025 的迭代器輔助方法（Node 22 以上、2025 年後的瀏覽器）讓迭代器也有 `map`、`filter`、`take`，而且同樣是惰性的：

```js
naturals()
  .filter((n) => n % 2 === 0)
  .map((n) => n * n)
  .take(3)
  .toArray(); // [4, 16, 36]
```

陣列的 `map`、`filter` 每一步都會建立完整的新陣列；迭代器的版本一次只處理一個值，處理大量或無限的資料時不會佔用大量記憶體。

### `yield*` 與清理

```js
function* inner() {
  yield "a";
  yield "b";
}

function* outer() {
  yield 1;
  yield* inner(); // 把另一個可迭代物件的值逐一交出
  yield 2;
}

[...outer()]; // [1, "a", "b", 2]
```

`for...of` 中途 `break` 時，會呼叫產生器的 `return()`，產生器裡的 `finally` 區塊會執行。產生器持有檔案、連線這類資源時，把清理寫在 `finally` 裡：

```js
function* withCleanup() {
  try {
    yield 1;
    yield 2;
    yield 3;
  } finally {
    console.log("cleanup");
  }
}

for (const v of withCleanup()) {
  if (v === 2) break; // 印出 "cleanup"
}
```

### 產生器只能走訪一次

```js
const once = rangeGen(1, 3);
[...once]; // [1, 2, 3]
[...once]; // []，已經走完了
```

陣列可以重複走訪，因為每次 `[Symbol.iterator]()` 都回傳新的迭代器；產生器物件的 `[Symbol.iterator]()` 回傳的是它自己。需要重複走訪時，保留產生器**函式**，每次呼叫取得新的產生器，或像 `Range` 一樣包在 class 裡。

## 7.7 非同步迭代

資料要一批一批非同步取得時（分頁 API、檔案串流、網路串流），用**非同步產生器**和 `for await...of`：

```js
async function* allItems() {
  let page = 1;
  while (page) {
    const res = await fetchPage(page); // 每一頁要等網路回應
    yield* res.items;
    page = res.next; // 最後一頁的 next 是 null
  }
}

for await (const item of allItems()) {
  console.log(item); // 一筆一筆處理，不用等全部頁面載完
}

const everything = await Array.fromAsync(allItems()); // 全部收集成陣列
```

呼叫端只看到「一串項目」，不需要知道分頁的細節；中途 `break` 時，後面的頁面就不會被請求。

`for await...of` 也可以走訪一般的可迭代物件，遇到 Promise 會等它完成。Node 的串流和瀏覽器的 `ReadableStream`（較新的瀏覽器）都實作了非同步迭代，[14.7 節](14-fetch-and-network-requests.md#147-串流讀取回應)會用它逐段讀取網路回應。

## 7.8 本章小結

- 鍵不是字串、或執行時才知道有哪些鍵時用 `Map`；不重複的值用 `Set`，也用它加速大量查找。
- `WeakMap` 讓附加資料跟著鍵物件的生命週期走，代價是不能走訪。
- Symbol 是唯一的鍵；`Symbol.iterator` 等內建 Symbol 讓物件參與語言的內建行為。
- 有 `[Symbol.iterator]()` 的物件就能被 `for...of`、展開、解構、`Array.from` 使用。
- 產生器用 `yield` 暫停與交出值，惰性計算、可以表示無限序列；只能走訪一次；清理寫在 `finally`。
- 非同步產生器加 `for await...of`，把分頁、串流這類一批批到來的資料變成一條序列。

下一章：[08 — 錯誤處理](08-error-handling.md)。

---

[上一章：字串、正規表達式、日期與 Intl](06-strings-regex-dates-and-intl.md) · [返回課程總覽](README.md) · [下一章：錯誤處理](08-error-handling.md)
