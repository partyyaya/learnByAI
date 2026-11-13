# 01 — 值、型別與比較

> JavaScript 的值有型別，變數沒有。大部分的意外來自自動轉型：運算子會先把值轉成它要的型別，再做運算。

寫過靜態型別語言的人，最不習慣的是 JavaScript 很少因為型別不合而報錯，而是默默把值轉成另一種型別，繼續算下去。這一章把型別、轉型、比較的規則整理清楚，後面每一章都會用到。

本章的範例都可以存成 `.mjs` 檔用 Node 執行，也可以貼到瀏覽器的 Console 試。

## 1.1 宣告變數：`const`、`let`、`var`

```js
const rate = 0.05; // 不能重新賦值
let count = 0;     // 可以重新賦值
count += 1;
```

- **預設用 `const`**，需要重新賦值時才用 `let`。讀程式的人看到 `const` 就知道這個名字之後不會指向別的值。
- **不要用 `var`**。它是函式作用域、會被提升，行為和其他語言的變數不同（[第 3 章](03-scope-closures-and-hoisting.md)）。舊程式碼裡還很常見，看得懂就好。

`const` 限制的是**變數不能重新指向別的值**，不是值本身不能改：

```js
const user = { name: "Ann" };
user.name = "Bob";    // 可以：改的是物件內容
user = { name: "Cy" }; // TypeError: Assignment to constant variable.
```

想讓物件內容不能改，要用 `Object.freeze()`（只凍結一層，見 [4.5 節](04-objects-and-arrays.md#45-不可變更新)）。

## 1.2 七種原始型別與物件

JavaScript 的值分成兩大類：

| 類別 | 型別 | 例子 |
|------|------|------|
| 原始型別（primitive） | `string` | `"hello"`、`'hi'`、`` `x=${x}` `` |
| | `number` | `42`、`3.14`、`NaN`、`Infinity` |
| | `bigint` | `9007199254740993n` |
| | `boolean` | `true`、`false` |
| | `undefined` | `undefined` |
| | `null` | `null` |
| | `symbol` | `Symbol("id")` |
| 物件（object） | `object` | `{}`、`[]`、`new Date()`、`/re/`、函式 |

陣列、函式、日期、正規表達式都是物件。用 `typeof` 檢查型別：

```js
typeof "hi";          // "string"
typeof 42;            // "number"
typeof 10n;           // "bigint"
typeof undefined;     // "undefined"
typeof Symbol();      // "symbol"
typeof {};            // "object"
typeof [];            // "object"   ← 陣列也是物件
typeof function () {}; // "function" ← 函式是物件，但 typeof 特別回傳 "function"
typeof null;          // "object"   ← 歷史錯誤，無法修正
```

兩個要記住的特例：

- `typeof null` 是 `"object"`，這是語言最早期的錯誤，為了相容一直保留。檢查 `null` 要直接寫 `value === null`。
- 判斷陣列用 `Array.isArray(value)`，`typeof` 分不出陣列和一般物件。

## 1.3 原始值與參考

原始值是**不可變**的，比較時比的是值本身：

```js
let a = "hi";
let b = a;
b += "!";
console.log(a); // "hi"，a 不受影響

"abc" === "abc"; // true
```

物件則是透過**參考**存取。把物件指派給另一個變數，兩個變數指向同一個物件：

```js
const p1 = { x: 1 };
const p2 = p1;
p2.x = 99;
console.log(p1.x); // 99，同一個物件

({ x: 1 }) === ({ x: 1 }); // false，兩個不同的物件
```

傳參數也一樣。函式收到的是參考的**複本**：在函式裡改物件內容，呼叫端看得到；把參數重新指向另一個物件，呼叫端不受影響。

```js
function rename(user) {
  user.name = "Bob"; // 改內容：呼叫端看得到
  user = { name: "Cy" }; // 重新指向：只影響函式內的 user
}

const u = { name: "Ann" };
rename(u);
console.log(u.name); // "Bob"
```

這個區別在 [4.5 節](04-objects-and-arrays.md#45-不可變更新)的不可變更新、以及 React、Vue 判斷「資料有沒有變」時都很重要。

## 1.4 `number`：只有一種數字

JavaScript 沒有 `int`、`long`、`double` 之分，所有數字都是 **IEEE 754 雙精度浮點數**。

### 浮點誤差

```js
0.1 + 0.2;          // 0.30000000000000004
0.1 + 0.2 === 0.3;  // false
```

這不是 JavaScript 的錯誤，所有用二進位浮點數的語言都一樣，只是其他語言通常有整數或 decimal 型別可以避開。處理方式：

- **比較浮點數**時允許誤差：`Math.abs(a - b) < Number.EPSILON`。
- **金額**用最小單位的整數計算（以「分」為單位存 `1999`，而不是 `19.99`），顯示時再格式化（[6.5 節](06-strings-regex-dates-and-intl.md#65-intl在地化格式)）。
- **顯示**時才四捨五入：`(0.1 + 0.2).toFixed(2)` 得到字串 `"0.30"`。注意 `toFixed` 也受浮點表示影響，`(1.005).toFixed(2)` 是 `"1.00"`，因為 1.005 實際上存成 1.00499999……。

### 整數的安全範圍

整數在 `±(2^53 - 1)` 以內才能精確表示：

```js
Number.MAX_SAFE_INTEGER; // 9007199254740991
2 ** 53 + 1;             // 9007199254740992 ← 少了 1
```

資料庫的 64 位元 ID、金融計算超過這個範圍時，用 `bigint`：

```js
const big = 9007199254740993n; // 結尾加 n
big + 1n;  // 9007199254740994n
10n / 3n;  // 3n，整數除法
1n + 1;    // TypeError: Cannot mix BigInt and other types
```

`bigint` 和 `number` 不能混用，要明確轉換：`BigInt(1)`、`Number(10n)`。後端傳來的大數字 ID 若是 JSON 數字，`JSON.parse` 時就已經失去精度，所以這類 ID 應該以字串傳輸。

### `NaN` 與 `Infinity`

```js
1 / 0;            // Infinity
Number("abc");    // NaN（Not a Number）
typeof NaN;       // "number"
NaN === NaN;      // false ← NaN 不等於任何值，包括自己
Number.isNaN(NaN); // true
```

檢查 `NaN` 用 `Number.isNaN()`。全域的 `isNaN()` 會先轉型：`isNaN("abc")` 是 `true`，因為 `"abc"` 轉成數字是 `NaN`，這通常不是你要的。

### 除法與餘數

```js
7 / 2;               // 3.5，不是 3
Math.trunc(7 / 2);   // 3，往 0 取整
Math.floor(-7 / 2);  // -4，往下取整
Math.trunc(-7 / 2);  // -3
-7 % 3;              // -1，餘數的正負號跟著被除數
```

### 字串轉數字

```js
Number("42");       // 42
Number(" 42 ");     // 42，前後空白會忽略
Number("");         // 0  ← 空字串變 0
Number("12px");     // NaN
Number(null);       // 0
Number(undefined);  // NaN
parseInt("12px", 10);  // 12，從頭讀到不是數字為止
parseFloat("3.14abc"); // 3.14
```

- 要求整個字串都是數字時用 `Number()`，再用 `Number.isNaN` 檢查。
- 要從 `"12px"` 這種字串取出開頭的數字時用 `parseInt`／`parseFloat`；`parseInt` 一律帶第二個參數 `10`，避免被當成其他進位。
- 注意 `Number("")` 是 `0`：表單欄位空白時，直接 `Number(input.value)` 會得到 0 而不是錯誤。

## 1.5 `undefined` 與 `null`

兩者都表示「沒有值」，但來源不同：

- **`undefined`**：語言自動給的。宣告了沒賦值的變數、物件沒有的屬性、沒傳的參數、沒有 `return` 的函式回傳值。
- **`null`**：程式設計者刻意設的「空」。

```js
let x;
x;                // undefined
({}).missing;     // undefined
(function () {})(); // undefined

const selected = null; // 明確表示「目前沒有選取」
```

實務上的差異：

- JSON 只有 `null`。`JSON.stringify({ a: 1, b: undefined, c: null })` 得到 `'{"a":1,"c":null}'`，值為 `undefined` 的屬性會直接消失。
- 函式參數的預設值只在收到 `undefined` 時生效，收到 `null` 不會（[2.2 節](02-functions.md#22-參數)）。
- 同時檢查兩者用 `value == null`（1.8 節唯一推薦的 `==` 用法），或用 `??` 給預設值（1.9 節）。

## 1.6 型別轉換

JavaScript 的運算子會把運算元轉成它需要的型別。規則多，但日常會碰到的就幾條。

### `+` 遇到字串就串接

```js
"5" + 1;     // "51"
1 + 2 + "3"; // "33"，由左到右：先 1+2=3，再 3+"3"
"1" + 2 + 3; // "123"
true + 1;    // 2，true 轉成 1
```

### 其他算術運算子一律轉成數字

```js
"5" - 1;   // 4
"5" * "2"; // 10
"abc" * 2; // NaN
```

### 物件轉成字串

```js
`${[1, 2]}`; // "1,2"，陣列用逗號串起來
`${{}}`;     // "[object Object]"
[1, 2] + [3]; // "1,23"
```

在字串裡看到 `[object Object]`，就是物件被轉成字串了。要印出物件內容用 `JSON.stringify(obj)`。

### 明確轉換

依賴自動轉型會讓程式難讀。需要轉型時明確寫出來：

```js
String(42);       // "42"
Number("42");     // 42
Boolean("false"); // true ← 非空字串都是 true
```

從表單、網址參數、`localStorage` 讀到的值**一律是字串**，做數字運算前先轉型：

```js
const qty = Number(input.value);
const total = price * qty; // 不轉型時 * 會自動轉，但 + 會變成串接
```

## 1.7 真值與假值

`if`、`while`、`&&`、`||`、`!` 會把值轉成布林。轉成 `false` 的值（falsy）只有這幾個：

```text
false  0  -0  0n  ""  null  undefined  NaN
```

**其他全部都是 truthy**，包括很多人以為是假的：

```js
Boolean("0");     // true，非空字串
Boolean("false"); // true
Boolean([]);      // true，空陣列是物件
Boolean({});      // true
```

常見的錯誤是用 truthy 檢查「有沒有值」，結果把合法的 `0` 或空字串也排除了：

```js
function setVolume(level) {
  if (!level) level = 50; // level 傳 0 時也會被改成 50
  return level;
}
```

要檢查的是「有沒有提供」時，用 `level === undefined`，或用 1.9 節的 `??`。檢查陣列是否為空用 `arr.length === 0`，不要用 `if (arr)`。

## 1.8 相等：`===`、`==` 與 `Object.is`

### 一律用 `===`

`===`（嚴格相等）不轉型，型別不同就是 `false`。`==`（寬鬆相等）會先轉型再比較，規則很難記：

```js
0 == "";            // true
0 == "0";           // true
"" == "0";          // false ← 相等關係沒有遞移性
[] == false;        // true
null == 0;          // false
null >= 0;          // true ← 比較運算子用另一套轉型規則
```

日常一律用 `===` 和 `!==`。唯一常見的 `==` 用法是 `value == null`，它在 `value` 是 `null` 或 `undefined` 時為 `true`，其他都是 `false`，比 `value === null || value === undefined` 簡潔。

`switch` 也是用 `===` 比較：

```js
switch ("1") {
  case 1:
    console.log("不會進來，\"1\" !== 1");
    break;
  default:
    console.log("default");
}
```

### `NaN` 與 `-0`

`===` 有兩個特例：`NaN === NaN` 是 `false`，`0 === -0` 是 `true`。`Object.is` 修正了這兩點：

```js
Object.is(NaN, NaN); // true
Object.is(0, -0);    // false
```

陣列的 `indexOf` 用 `===`，找不到 `NaN`；`includes` 用另一套規則（SameValueZero），找得到：

```js
[NaN].indexOf(NaN);  // -1
[NaN].includes(NaN); // true
```

### 物件比較的是參考

```js
({}) === ({});           // false
[1, 2] === [1, 2];       // false
```

JavaScript 沒有內建的深度比較。測試時用 `node:assert` 的 `assert.deepStrictEqual`（[18.4 節](18-from-script-to-project.md#184-第一個測試)），一般程式碼通常比較特定欄位或 ID。

## 1.9 邏輯運算子、`??` 與 `?.`

### `||` 和 `&&` 回傳的是運算元，不是布林

```js
"a" && "b"; // "b"，左邊 truthy 就回傳右邊
0 || 10;    // 10，左邊 falsy 就回傳右邊
```

所以 `||` 常被拿來給預設值，但它會把 `0`、`""` 也當成「沒有值」：

```js
const pageSize = options.pageSize || 20; // pageSize 設成 0 會被換成 20
```

### `??`：只在 `null`／`undefined` 時用預設值

```js
0 ?? 10;       // 0
"" ?? "預設";   // ""
null ?? "x";   // "x"
```

給預設值時優先用 `??`。只有確定 `0`、`""` 也要換掉時才用 `||`。

### `?.`：中間可能沒有值時安全地讀取

```js
const user = { profile: null };

user.profile.name;    // TypeError: Cannot read properties of null
user.profile?.name;   // undefined
user.getName?.();     // undefined，方法不存在時不呼叫
user.tags?.[0];       // undefined，用在中括號
```

`?.` 左邊是 `null` 或 `undefined` 時，整個運算式直接回傳 `undefined`，不往下讀。常和 `??` 一起用：`user.profile?.name ?? "匿名"`。

`?.` 不要用得太多。如果 `profile` 照理說一定存在，寫 `?.` 反而會把資料錯誤藏起來；讓它在缺值時丟錯，比較容易發現問題。

### 邏輯賦值

```js
options.retries ??= 3;  // options.retries 是 null/undefined 時才設成 3
cache.hits ||= 0;
user.isAdmin &&= checkPermission(user);
```

## 1.10 流程控制：和其他語言不同的地方

`if`、`for`、`while`、`do...while`、`break`、`continue`、三元運算子 `a ? b : c` 都和 C 系語言一樣。需要注意的是兩種 `for` 迴圈：

```js
const arr = ["a", "b"];
arr.extra = "x"; // 陣列也是物件，可以加屬性

for (const v of arr) console.log(v); // "a", "b"            ← 值
for (const k in arr) console.log(k); // "0", "1", "extra"   ← 鍵（字串），包含額外屬性
```

- **`for...of`** 走訪**值**，適用所有可迭代物件：陣列、字串、Map、Set（[第 7 章](07-collections-iterators-and-generators.md)）。走訪陣列用它。
- **`for...in`** 走訪物件的**可列舉屬性名稱**（字串），還會包含從原型繼承來的屬性。不要拿來走訪陣列。要走訪物件的鍵值，用 `Object.entries(obj)` 搭配 `for...of`（[4.8 節](04-objects-and-arrays.md#48-object-的靜態方法)）。

## 1.11 本章小結

- 變數預設用 `const`，需要重新賦值才用 `let`，不用 `var`。`const` 不會讓物件內容變成唯讀。
- 七種原始型別比較值，物件比較參考；函式參數拿到的是參考的複本。
- 只有一種 `number`：小心浮點誤差、整數安全範圍、`NaN`；大整數用 `bigint`。
- `+` 遇到字串就串接，其他算術運算子轉成數字；從表單、網址讀到的值都是字串，先明確轉型。
- falsy 只有八個，`"0"`、`[]`、`{}` 都是 truthy。
- 一律用 `===`；給預設值用 `??`；可能缺值的路徑用 `?.`。

下一章：[02 — 函式](02-functions.md)。

---

[上一章：課程地圖與執行環境](00-course-map-and-runtime.md) · [返回課程總覽](README.md) · [下一章：函式](02-functions.md)
