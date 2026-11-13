# 04 — 物件與陣列

> 物件和陣列是 JavaScript 最主要的資料結構。現代寫法的核心是：用解構取值、用展開組合、用不改原資料的方法產生新值。

JavaScript 的物件同時扮演其他語言裡的 struct、dictionary、record；陣列是有順序的物件，附帶大量的方法。這一章整理日常最常用的語法與方法，重點放在**哪些操作會改到原資料、哪些不會**，這決定了程式在框架裡能不能正確更新畫面。

## 4.1 物件字面值

```js
const field = "price";
const name = "pen";

const item = {
  name,                         // 簡寫：等於 name: name
  [field]: 30,                  // 計算屬性名稱：鍵是 "price"
  [`${field}WithTax`]: 31.5,    // 鍵是 "priceWithTax"
  describe() {                  // 方法簡寫
    return `${this.name} costs ${this[field]}`;
  },
};

item.name;      // 點號：鍵是固定的識別字
item[field];    // 中括號：鍵來自變數或含特殊字元
item.describe(); // "pen costs 30"
```

### 新增、刪除、檢查屬性

```js
item.stock = 10;       // 新增
delete item.stock;     // 刪除
item.stock;            // undefined，不存在的屬性不會報錯

"toString" in item;          // true，in 會檢查原型鏈
Object.hasOwn(item, "toString"); // false，只檢查自己的屬性
```

`in` 會找到從原型繼承來的屬性（[5.4 節](05-this-prototypes-and-classes.md#54-原型鏈)），檢查「這個物件自己有沒有這個鍵」用 `Object.hasOwn`。

### 鍵的順序

物件的鍵會被轉成字串（Symbol 除外）。走訪順序有固定規則：**整數形式的鍵由小到大排在前面**，其他字串鍵依加入順序：

```js
Object.keys({ b: 1, 2: "two", a: 2, 1: "one" }); // ["1", "2", "b", "a"]
```

需要任意型別的鍵、或需要嚴格保留加入順序時，用 `Map`（[7.1 節](07-collections-iterators-and-generators.md#71-map)）。

## 4.2 解構

解構把物件或陣列的內容一次取出到變數。

### 物件解構

```js
const product = { name: "pen", price: 30, color: "red", size: "S" };

const { name, price: cost, stock = 0, ...others } = product;
// name   → "pen"
// cost   → 30，取 price 改名為 cost
// stock  → 0，不存在時用預設值
// others → { color: "red", size: "S" }，其餘的屬性
```

巢狀解構時，中間那層不存在會報錯，可以給它一個空物件當預設值：

```js
const { address: { city } = {} } = user; // user.address 不存在時 city 是 undefined
```

### 陣列解構

依位置取值：

```js
const [first, , third = "預設", ...rest] = [1, 2, undefined, 4, 5];
// first → 1
// 跳過第二個
// third → "預設"（值是 undefined 時用預設值）
// rest  → [4, 5]

let a = 1;
let b = 2;
[a, b] = [b, a]; // 交換：a 是 2，b 是 1
```

React 的 `const [count, setCount] = useState(0)` 就是陣列解構：`useState` 回傳一個兩個元素的陣列，用陣列解構可以自由命名。

解構也能直接用在函式參數上（[2.2 節](02-functions.md#22-參數)）和 `for...of` 裡：

```js
for (const [key, value] of Object.entries(prices)) { /* ... */ }
```

## 4.3 展開

展開（spread）把物件或陣列的內容攤開放進新的物件或陣列：

```js
const base = { theme: "light", lang: "zh" };

const a = { ...base, theme: "dark" }; // { theme: "dark", lang: "zh" }
const b = { theme: "dark", ...base }; // { theme: "light", lang: "zh" }，後面的蓋掉前面的

const merged = [...[1, 2], ...[3, 4]]; // [1, 2, 3, 4]
const copy = [...original];
```

同名的鍵**後面的會覆蓋前面的**。「預設值放前面、使用者設定放後面」就是利用這一點：`{ ...defaults, ...userOptions }`。

展開只複製**一層**。巢狀的物件還是同一個參考，見 4.6 節。

## 4.4 陣列方法

### 會改原陣列與不會改原陣列

這是使用陣列方法時最需要注意的一點：

| 會改原陣列 | 不改原陣列，回傳新的 |
|-----------|---------------------|
| `push`、`pop`、`shift`、`unshift` | `concat`、`[...arr, x]` |
| `splice` | `slice`、`toSpliced` |
| `sort` | `toSorted` |
| `reverse` | `toReversed` |
| `fill`、`copyWithin` | `with(index, value)` |
| | `map`、`filter`、`flat`、`flatMap` |

`toSorted`、`toReversed`、`toSpliced`、`with` 是 ES2023 加入的不可變版本，Node 20 以上和 2023 年後的瀏覽器都支援。

```js
const orig = [3, 1, 2];
const sorted = orig.toSorted(); // [1, 2, 3]
orig;                           // [3, 1, 2]，原陣列不變
orig.with(0, 9);                // [9, 1, 2]
orig.at(-1);                    // 2，負數從尾端算
```

### `sort` 預設按字串排序

```js
[10, 9, 1, 100].sort();                // [1, 10, 100, 9]
[10, 9, 1, 100].sort((x, y) => x - y); // [1, 9, 10, 100]
```

沒給比較函式時，`sort` 會把元素轉成字串再比較。排序數字一定要給比較函式：回傳負數表示 `x` 排前面，正數表示 `y` 排前面。排序物件時比較某個欄位，字串欄位用 `a.name.localeCompare(b.name)`（[6.1 節](06-strings-regex-dates-and-intl.md#61-字串的基本操作)）。

`sort` 是穩定排序：比較結果相等的元素，會維持原本的先後順序。

### 走訪與轉換

```js
const nums = [1, 2, 3, 4, 5];

nums.map((n) => n * 10);       // [10, 20, 30, 40, 50]，一對一轉換
nums.filter((n) => n % 2);     // [1, 3, 5]，留下 callback 回傳 truthy 的元素
nums.reduce((sum, n) => sum + n, 0); // 15，累積成一個值

nums.find((n) => n > 2);       // 3，第一個符合的元素；找不到是 undefined
nums.findIndex((n) => n > 2);  // 2；找不到是 -1
nums.findLast((n) => n < 4);   // 3，從尾端找
nums.some((n) => n > 4);       // true，至少一個符合
nums.every((n) => n > 0);      // true，全部符合
nums.includes(3);              // true

[[1, 2], [3, [4]]].flat();     // [1, 2, 3, [4]]，攤平一層
["a b", "c"].flatMap((s) => s.split(" ")); // ["a", "b", "c"]
```

串起來處理一筆資料：

```js
const orders = [
  { id: 1, status: "paid", amount: 300 },
  { id: 2, status: "pending", amount: 120 },
  { id: 3, status: "paid", amount: 80 },
];

const totalPaid = orders
  .filter((o) => o.status === "paid")
  .reduce((sum, o) => sum + o.amount, 0); // 380
```

`reduce` 一定要給初始值（第二個參數）。沒給時，第一個元素會被當成初始值；陣列是空的時候還會直接丟出 `TypeError`。

`forEach` 只是走訪，沒有回傳值，也不能用 `break` 中途停止。需要中途停止時用 `for...of`，或用 `some`／`find` 在找到時回傳。`forEach` 和 `async` callback 一起用時不會等待，見 [11.11 節](11-promise-and-async-await.md#1111-常見錯誤與排查)。

### 建立陣列

```js
Array.from({ length: 3 }, (_, i) => i * 2); // [0, 2, 4]
Array.from("hi");                           // ["h", "i"]
Array.from(new Set([1, 1, 2]));             // [1, 2]
```

`Array.from` 可以把任何可迭代物件或「有 `length` 的物件」轉成陣列，第二個參數是轉換函式。

## 4.5 不可變更新

前端框架判斷「資料有沒有變」，比較的通常是**參考**：新舊兩個值是不是同一個物件。直接改原物件的內容，參考沒變，框架就以為沒有變化，畫面不會更新。

所以更新狀態時，**產生新的物件，而不是修改原本的物件**：

```js
const state = {
  user: { name: "Ann", prefs: { theme: "light" } },
  todos: [
    { id: 1, done: false },
    { id: 2, done: false },
  ],
};

// 改巢狀的 theme：路徑上每一層都展開成新物件
const next = {
  ...state,
  user: {
    ...state.user,
    prefs: { ...state.user.prefs, theme: "dark" },
  },
};

next.user === state.user;   // false，這一層換了新物件
next.todos === state.todos; // true，沒改的部分沿用原本的參考
```

陣列的三種常見更新：

```js
// 新增
const added = [...state.todos, { id: 3, done: false }];

// 刪除
const removed = state.todos.filter((t) => t.id !== 1);

// 修改其中一筆
const toggled = state.todos.map((t) =>
  t.id === 2 ? { ...t, done: true } : t,
);
```

`map` 只為要修改的那一筆建立新物件，其他元素沿用原本的參考。這樣框架只需要重新處理有變化的部分。

巢狀很深時，展開會寫得很長。這時可以先檢查資料結構是否能攤平，或使用 Immer 這類函式庫，用「看起來像直接修改」的寫法產生新物件。

### `Object.freeze`

```js
const config = Object.freeze({ mode: "prod", db: { host: "x" } });
config.mode = "dev"; // 嚴格模式下 TypeError: Cannot assign to read only property
config.db.host = "y"; // 成功，freeze 只凍結一層
```

`Object.freeze` 適合用在常數設定上，防止被意外修改；它不會遞迴凍結巢狀物件。

## 4.6 複製：淺拷貝與 structuredClone

展開、`Object.assign`、`slice`、`Array.from` 都是**淺拷貝**：只複製第一層，巢狀物件仍然共用：

```js
const shallow = { ...state };
shallow.user.name = "changed";
state.user.name; // "changed"，user 是同一個物件
```

需要完整複製時用 `structuredClone`，瀏覽器和 Node 17 以上都內建：

```js
const src = {
  when: new Date("2026-01-01T00:00:00Z"),
  tags: new Set(["a"]),
  nested: { n: 1 },
};

const deep = structuredClone(src);
deep.when instanceof Date; // true，Date 保留
deep.tags;                 // Set(1) { "a" }
deep.nested !== src.nested; // true，巢狀物件也是新的
```

`structuredClone` 的限制：

- 不能複製函式和 DOM 節點，會丟出 `DataCloneError`。
- class 實例會變成一般物件，原型上的方法消失：`structuredClone(new Point(3)) instanceof Point` 是 `false`。

這些限制和 [Web Worker 的 `postMessage`](16-web-worker.md#164-worker-的限制與通訊方式) 完全相同，因為兩者用的是同一套結構化複製演算法。

### 為什麼不用 `JSON.parse(JSON.stringify(obj))`

舊程式碼常用 JSON 來回轉換做深拷貝，但會默默丟失資料：

```js
JSON.parse(JSON.stringify(src));
// {
//   when: "2026-01-01T00:00:00.000Z",  ← Date 變成字串
//   tags: {},                          ← Set 變成空物件
//   nested: { n: 1 }
// }
// 值為 undefined 的屬性會消失，NaN 會變成 null
```

新程式碼用 `structuredClone`。

## 4.7 JSON

```js
JSON.stringify({ id: 1, tags: ["a"] });         // '{"id":1,"tags":["a"]}'
JSON.stringify({ id: 1, tags: ["a"] }, null, 2); // 縮排 2 格，方便閱讀

// 第二個參數可以過濾或轉換欄位
JSON.stringify({ id: 1, password: "x" }, (key, value) =>
  key === "password" ? undefined : value,
); // '{"id":1}'
```

轉成 JSON 時的規則：

- `Date` 會呼叫自己的 `toJSON()`，變成 ISO 格式字串。
- `Map`、`Set` 變成 `{}`，要自己先轉成陣列或物件。
- 值為 `undefined`、函式、Symbol 的屬性會被省略；`NaN`、`Infinity` 變成 `null`。
- 物件有 `toJSON()` 方法時，序列化的是它的回傳值。

`JSON.parse` 得到的日期只是字串。需要 `Date` 物件時，用第二個參數 reviver 轉換：

```js
const data = JSON.parse('{"createdAt":"2026-11-13T08:00:00.000Z"}', (key, value) =>
  key === "createdAt" ? new Date(value) : value,
);
data.createdAt instanceof Date; // true
```

JSON 格式比 JavaScript 物件字面值嚴格：鍵必須用雙引號、不能有結尾逗號、不能有註解。格式錯誤時 `JSON.parse` 丟出 `SyntaxError`，解析外部輸入時要用 `try/catch` 包起來。

## 4.8 Object 的靜態方法

```js
const prices = { pen: 30, book: 250 };

Object.keys(prices);    // ["pen", "book"]
Object.values(prices);  // [30, 250]
Object.entries(prices); // [["pen", 30], ["book", 250]]
```

物件沒有 `map`、`filter`，要轉換物件時，先用 `entries` 轉成陣列，處理完再用 `fromEntries` 轉回來：

```js
const withTax = Object.fromEntries(
  Object.entries(prices).map(([k, v]) => [k, Math.round(v * 1.05)]),
); // { pen: 32, book: 263 }
```

依某個欄位分組，用 ES2024 的 `Object.groupBy`（Node 21 以上、2024 年後的瀏覽器）：

```js
const byStatus = Object.groupBy(orders, (o) => o.status);
// {
//   paid:    [{ id: 1, ... }, { id: 3, ... }],
//   pending: [{ id: 2, ... }],
// }
```

回傳的物件沒有原型（Node 印出時會標示 `[Object: null prototype]`），所以不會有 `toString` 這類繼承來的鍵和分組名稱衝突。

## 4.9 本章小結

- 物件字面值支援屬性簡寫、計算屬性名稱、方法簡寫；檢查自己的屬性用 `Object.hasOwn`。
- 解構一次取出多個值，可以改名、給預設值、收集其餘部分；展開時後面的鍵覆蓋前面的。
- 分清楚會改原陣列的方法（`push`、`splice`、`sort`、`reverse`）與回傳新陣列的方法（`map`、`filter`、`toSorted`、`with`）。
- `sort` 預設按字串排序，數字要給比較函式；`reduce` 一定給初始值。
- 更新狀態時產生新物件：路徑上每一層展開，沒改的部分沿用原參考。
- 展開是淺拷貝；深拷貝用 `structuredClone`，不要用 JSON 來回轉換。

下一章：[05 — `this`、原型與類別](05-this-prototypes-and-classes.md)。

---

[上一章：作用域、閉包與提升](03-scope-closures-and-hoisting.md) · [返回課程總覽](README.md) · [下一章：this、原型與類別](05-this-prototypes-and-classes.md)
