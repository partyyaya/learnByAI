# 06 — 字串、正規表達式、日期與 Intl

> 字串的長度不一定等於字數；`new Date("2026-11-13")` 和 `new Date("2026-11-13T00:00")` 在台灣差了 8 小時。這一章把這類「看起來沒問題」的坑集中整理。

這一章是工具章，可以先快速看過，用到時再回來查。範例的日期結果以台北時區（UTC+8）為準，執行時可以用 `TZ=Asia/Taipei node 檔名.mjs` 固定時區。

## 6.1 字串的基本操作

字串是不可變的原始值，所有方法都回傳新字串：

```js
const s = "  Hello, JavaScript  ";

s.trim();                    // "Hello, JavaScript"
s.trim().toUpperCase();      // "HELLO, JAVASCRIPT"
s.includes("Java");          // true
s.trim().startsWith("Hello"); // true
s.trim().slice(7);           // "JavaScript"
s.trim().slice(-6);          // "Script"，負數從尾端算
"a,b,,c".split(",");         // ["a", "b", "", "c"]
"7".padStart(3, "0");        // "007"
"a-b-c".replaceAll("-", "/"); // "a/b/c"
"abc".at(-1);                // "c"
```

嚴格模式下對字串的索引賦值會丟出錯誤，不會默默失敗：

```js
const str = "abc";
str[0] = "z"; // TypeError: Cannot assign to read only property '0' of string 'abc'
```

### 樣板字面值

反引號字串可以嵌入運算式、可以跨行：

```js
const html = `
  <li class="${done ? "done" : ""}">
    ${title}（${count} 件）
  </li>
`;
```

把使用者輸入直接組成 HTML 有 XSS 風險，插入 DOM 時要用 `textContent` 而不是 `innerHTML`（[13.3 節](13-dom-and-events.md#133-讀寫內容與屬性)）。

### 比較與排序

`<`、`>` 比較字串時，比的是 UTF-16 編碼的大小，大寫字母排在所有小寫之前：

```js
["b", "a", "C"].toSorted();                              // ["C", "a", "b"]
["b", "a", "C"].toSorted((x, y) => x.localeCompare(y)); // ["a", "b", "C"]
```

給使用者看的排序一律用 `localeCompare` 或 `Intl.Collator`（6.5 節）。

## 6.2 Unicode 與長度

JavaScript 字串以 **UTF-16 的編碼單位**儲存，`length` 算的是編碼單位的個數，不是字數：

```js
"台灣".length;  // 2
"😀".length;    // 2，emoji 超出基本平面，佔兩個編碼單位
[..."😀"].length; // 1，展開時以 code point 為單位
```

有些「一個字」由好幾個 code point 組成，例如家庭 emoji 是三個人用連接字元串起來的：

```js
const family = "👨‍👩‍👧";
family.length;      // 8
[...family].length; // 5

const segmenter = new Intl.Segmenter("zh-TW", { granularity: "grapheme" });
[...segmenter.segment(family)].length; // 1，使用者眼中的一個字
```

實際影響：

- **限制輸入字數**時，`length` 會把一個 emoji 算成 2 或更多。要以使用者看到的字數為準，用 `Intl.Segmenter`。
- **截斷字串**時，`slice` 可能把 emoji 切成兩半，留下一個無法顯示的半個字元：`"😀abc".slice(0, 1)` 得到亂碼。
- 資料庫欄位的長度限制通常以 code point 或位元組計算，和 `length` 又不一樣。前後端的長度檢查要用同一種算法。

### 正規化

同一個字可能有不同的編碼方式。`é` 可以是一個字元，也可以是 `e` 加上組合用的重音符號：

```js
const e1 = "é";       // U+00E9
const e2 = "é"; // e + 組合重音
e1 === e2;                          // false
e1.normalize() === e2.normalize();  // true
```

比較或搜尋來自不同來源（例如 macOS 檔名、使用者輸入）的字串前，先用 `normalize()` 轉成同一種形式。

## 6.3 正規表達式

```js
const re = /(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})/;
```

### 常用方法

```js
const m = "訂單日期 2026-11-13".match(re);
m.index;       // 5，符合的位置
m[0];          // "2026-11-13"
m.groups.year; // "2026"，具名群組

// 取代時用 $<名稱> 引用群組
"2026-11-13".replace(re, "$<day>/$<month>/$<year>"); // "13/11/2026"

// 第二個參數也可以是函式
"price: 30, tax: 2".replace(/\d+/g, (n) => String(Number(n) * 2));
// "price: 60, tax: 4"

// 取得所有符合的結果與群組
[..."a1 b22 c333".matchAll(/([a-z])(\d+)/g)].map((m) => `${m[1]}=${m[2]}`);
// ["a=1", "b=22", "c=333"]

/^\d+$/.test("123"); // true，只要知道有沒有符合時用 test
```

### 旗標

| 旗標 | 作用 |
|------|------|
| `g` | 全域：找出所有符合的位置 |
| `i` | 不分大小寫 |
| `m` | 多行：`^`、`$` 比對每一行的開頭結尾 |
| `s` | `.` 也比對換行 |
| `u` | Unicode 模式：以 code point 為單位，支援 `\p{...}` |
| `v` | `u` 的升級版，支援集合運算 |
| `y` | 黏著：只從 `lastIndex` 的位置開始比對 |
| `d` | 產生每個群組的起訖位置 |

處理中文、emoji 時加上 `u`：

```js
/^.$/.test("😀");               // false，沒有 u 時 . 只比對一個編碼單位
/^.$/u.test("😀");              // true
/^\p{Script=Han}+$/u.test("台灣"); // true，比對漢字
```

### `g` 旗標與 `test` 的陷阱

帶 `g` 的正規表達式物件會記住上次比對結束的位置（`lastIndex`），下次從那裡繼續：

```js
const g = /a/g;
g.test("aa"); // true，lastIndex 變成 1
g.test("aa"); // true，lastIndex 變成 2
g.test("aa"); // false，從位置 2 開始找不到，lastIndex 重設為 0
```

把帶 `g` 的正規表達式存成常數、拿來重複 `test` 不同的字串，結果會時對時錯。只需要判斷是否符合時，不要加 `g`。

### 用使用者輸入建立正規表達式

使用者輸入的 `.`、`*`、`?`、`+` 在正規表達式裡有特殊意義，直接 `new RegExp(input)` 會比對到不該比對的內容，甚至語法錯誤。要先跳脫：

```js
const userInput = "1+1=2?";
new RegExp(RegExp.escape(userInput)).test("問：1+1=2?"); // true
```

`RegExp.escape` 是 ES2025 加入的，Node 24 和 2025 年後的瀏覽器才有。舊環境用替換的方式跳脫：

```js
const escaped = userInput.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
```

只是要找固定的子字串時，直接用 `includes`、`indexOf`、`replaceAll`，不需要正規表達式。

## 6.4 Date 的陷阱

`Date` 內部只存一個數字：從 1970-01-01 00:00:00 UTC 起算的毫秒數。所有「幾月幾號幾點」都是依照某個時區換算出來的。

```js
const now = new Date("2026-11-13T08:30:00Z");
now.getTime();     // 1794558600000，時間戳記
now.toISOString(); // "2026-11-13T08:30:00.000Z"，一律 UTC
now.getHours();    // 16，執行環境的時區（台北）
now.getUTCHours(); // 8
```

### 月份從 0 開始

```js
const d = new Date(2026, 0, 31); // 2026 年 1 月 31 日，0 代表一月
d.getMonth(); // 0
```

日期、小時、分鐘都從自然數開始，只有月份從 0 開始。

### 解析字串：只寫日期時是 UTC

```js
new Date("2026-11-13").toISOString();          // "2026-11-13T00:00:00.000Z"，當成 UTC
new Date("2026-11-13T00:00").toISOString();    // "2026-11-12T16:00:00.000Z"，當成本地時間
new Date("2026-11-13T00:00:00Z").toISOString(); // UTC
new Date("2026-11-13T00:00:00+08:00").toISOString(); // 明確指定 +8
```

同樣是 11 月 13 日的零點，只寫日期時當成 UTC，加上時間時卻當成本地時間，在台灣差了 8 小時。在 UTC 負時區的使用者（例如美國），`new Date("2026-11-13")` 用本地時間顯示甚至會變成 11 月 12 日。

規則：

- **傳輸和儲存**一律用帶時區的 ISO 字串（`toISOString()` 的格式）或時間戳記。
- **解析**只接受 ISO 格式。`"2026/11/13"`、`"Nov 13 2026"` 這類格式的解析方式由瀏覽器自行決定，不保證一致。
- 解析失敗不會丟錯，而是得到 `Invalid Date`，`getTime()` 是 `NaN`。用 `Number.isNaN(d.getTime())` 檢查。

### Date 物件是可變的

```js
const start = new Date(2026, 0, 1);
const end = start;
end.setFullYear(2030);
start.getFullYear(); // 2030，同一個物件
```

要修改前先複製：`new Date(start)` 或 `new Date(start.getTime())`。

### 日期運算

```js
const d2 = new Date(2026, 10, 30); // 11 月 30 日
d2.setDate(d2.getDate() + 3);      // 12 月 3 日，會自動進位到下個月

const d3 = new Date(2026, 0, 31);
d3.setMonth(1);                    // 3 月 3 日：2 月 31 日不存在，溢出到 3 月

// 兩個日期相減得到毫秒差
(new Date("2026-12-25T00:00:00Z") - new Date("2026-11-13T00:00:00Z")) / 86_400_000; // 42
```

「加一個月」的語意本來就有歧義（1 月 31 日加一個月是哪天？），`Date` 的做法是溢出。業務上需要明確規則時，自己寫判斷，或用日期函式庫。

### Temporal

`Date` 的這些問題，新的 **Temporal** API 都有修正：區分「日期」「時間」「帶時區的時間點」等不同型別、物件不可變、月份從 1 開始、有明確的日期運算。Firefox 139、Chrome 144 起已經支援，Safari 與 Node 24 還沒有正式支援。在支援普及前，可以用 polyfill，或繼續用 `Date` 搭配 date-fns、Day.js 這類函式庫。

## 6.5 Intl：在地化格式

`Intl` 是內建的國際化 API，依語系格式化數字、貨幣、日期、相對時間，以及排序字串。不需要安裝套件。

### 數字與貨幣

```js
new Intl.NumberFormat("zh-TW").format(1234567.891);
// "1,234,567.891"

new Intl.NumberFormat("zh-TW", { style: "currency", currency: "TWD" }).format(1234567.891);
// "$1,234,567.89"

new Intl.NumberFormat("zh-TW", {
  style: "currency",
  currency: "TWD",
  maximumFractionDigits: 0,
}).format(1234567.891);
// "$1,234,568"

new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" }).format(1500);
// "￥1,500"

new Intl.NumberFormat("zh-TW", { notation: "compact" }).format(1234567); // "123萬"
new Intl.NumberFormat("zh-TW", { style: "percent", maximumFractionDigits: 1 }).format(0.1234); // "12.3%"

(1234.5).toLocaleString("de-DE"); // "1.234,5"，德國用點分千位、逗號分小數
```

金額用最小單位的整數計算（[1.4 節](01-values-types-and-comparison.md#14-number只有一種數字)），只在顯示時用 `Intl.NumberFormat` 格式化。要格式化很多次時，建立一個 formatter 重複使用，比每次呼叫 `toLocaleString` 快。

### 日期與時間

```js
const now = new Date("2026-11-13T08:30:00Z");

new Intl.DateTimeFormat("zh-TW", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "Asia/Taipei",
}).format(now);
// "2026年11月13日 下午4:30"

new Intl.DateTimeFormat("zh-TW", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
  timeZone: "Asia/Taipei",
}).format(now);
// "2026/11/13（週五）"

new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "America/New_York",
}).format(now);
// "Nov 13, 2026, 3:30 AM"
```

`timeZone` 決定用哪個時區顯示。不指定時用執行環境的時區：瀏覽器是使用者電腦的時區，伺服器上通常是 UTC。伺服器端產生給使用者看的時間（例如寄出的通知信），一定要明確指定時區。

### 相對時間、列表與排序

```js
const rtf = new Intl.RelativeTimeFormat("zh-TW", { numeric: "auto" });
rtf.format(-1, "day");  // "昨天"
rtf.format(3, "hour");  // "3 小時後"
rtf.format(-2, "week"); // "2 週前"

new Intl.ListFormat("zh-TW", { type: "conjunction" }).format(["筆", "紙", "橡皮擦"]);
// "筆、紙和橡皮擦"

["蘋果", "香蕉", "芭樂", "apple", "Banana"].toSorted(new Intl.Collator("zh-TW").compare);
// ["芭樂", "香蕉", "蘋果", "apple", "Banana"]，中文依筆畫排序

["item10", "item2", "item1"].toSorted(new Intl.Collator(undefined, { numeric: true }).compare);
// ["item1", "item2", "item10"]，數字部分按數值比較
```

`RelativeTimeFormat` 只負責格式化，「3 小時」要自己計算。`numeric: "auto"` 讓 -1 天顯示成「昨天」，而不是「1 天前」。

## 6.6 本章小結

- 字串不可變；給使用者看的排序用 `localeCompare` 或 `Intl.Collator`。
- `length` 算的是 UTF-16 編碼單位；以使用者看到的字數為準時用 `Intl.Segmenter`；比較前先 `normalize()`。
- 正規表達式處理中文和 emoji 時加 `u`；重複 `test` 時不要加 `g`；使用者輸入要先跳脫。
- `Date` 存的是 UTC 毫秒數；月份從 0 開始；只寫日期的字串被當成 UTC；物件可變，修改前先複製。
- 傳輸與儲存用 ISO 字串；顯示時用 `Intl.DateTimeFormat` 並明確指定時區。
- 數字、貨幣、相對時間用 `Intl` 格式化，formatter 建立一次重複使用。

下一章：[07 — Map／Set、Symbol、迭代器與產生器](07-collections-iterators-and-generators.md)。

---

[上一章：this、原型與類別](05-this-prototypes-and-classes.md) · [返回課程總覽](README.md) · [下一章：Map／Set、Symbol、迭代器與產生器](07-collections-iterators-and-generators.md)
