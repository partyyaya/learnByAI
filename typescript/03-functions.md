# 第三章：函式與型別

## 3.1 函式型別標註

### 參數與回傳值型別

```typescript
// 基本函式型別標註
function add(a: number, b: number): number {
  return a + b;
}

// 箭頭函式
const multiply = (a: number, b: number): number => a * b;

// 回傳 void（無回傳值）
function log(message: string): void {
  console.log(message);
}
```

### 函式型別表達式

```typescript
// 定義函式型別
type MathFn = (a: number, b: number) => number;

const add: MathFn = (a, b) => a + b;
const subtract: MathFn = (a, b) => a - b;

// 作為參數傳遞
function calculate(fn: MathFn, x: number, y: number): number {
  return fn(x, y);
}

calculate(add, 10, 5);      // 15
calculate(subtract, 10, 5); // 5
```

---

## 3.2 可選參數與預設值

### 可選參數

```typescript
// 可選參數用 ? 標記，必須放在必要參數後面
function greet(name: string, title?: string): string {
  if (title) {
    return `Hello, ${title} ${name}!`;
  }
  return `Hello, ${name}!`;
}

greet("Gary");           // "Hello, Gary!"
greet("Gary", "Mr.");    // "Hello, Mr. Gary!"
```

### 預設值

```typescript
// 有預設值的參數自動成為可選
function createUser(name: string, role: string = "user"): object {
  return { name, role };
}

createUser("Gary");           // { name: "Gary", role: "user" }
createUser("Gary", "admin");  // { name: "Gary", role: "admin" }
```

### NoInfer\<T\>（TypeScript 5.4+）

> 📌 **學習定位：進階、非必備。** 這是設計泛型 API 時才會用到的工具，日常寫業務邏輯、元件、呼叫 API 幾乎不會親手寫到它（你反而常常間接受惠於函式庫內部的用法）。**理解概念即可**，不用刻意背；等哪天自己寫泛型函式、發現某個參數把 `T` 意外拓寬了，再回來查它就行。

一般情況下，`T` 會同時從 `value` 和 `fallback` 兩個參數推斷，導致 `fallback` 若傳入預期範圍外的字面值，`T` 會被意外拓寬，讓本不該通過的值也通過型別檢查。用 `NoInfer<T>` 包住 `fallback`，讓它「只被檢查、不參與推斷」，型別完全以 `value` 為準。

```typescript
type Status = "active" | "inactive" | "suspended";

// 沒有 NoInfer：T 同時由 value 與 fallback 推斷
function setDefaultLoose<T>(value: T, fallback: T): T {
  return value ?? fallback;
}

const currentStatus: Status = "active";
setDefaultLoose(currentStatus, "not-a-status"); // ⚠️ 不會報錯！T 被拓寬成 "active" | "not-a-status"

// 使用 NoInfer：fallback 不參與型別推斷，只能是 value 推斷出的型別
function setDefault<T>(value: T, fallback: NoInfer<T>): T {
  return value ?? fallback;
}

setDefault(currentStatus, "active");        // ✅ OK
// setDefault(currentStatus, "not-a-status"); // ❌ 正確報錯：不是合法的 Status
```

---

## 3.3 剩餘參數（Rest Parameters）

```typescript
// 使用 ... 接收不定數量的參數
function sum(...numbers: number[]): number {
  return numbers.reduce((total, n) => total + n, 0);
}

sum(1, 2, 3);       // 6
sum(1, 2, 3, 4, 5); // 15

// 混合使用
function log(prefix: string, ...messages: string[]): void {
  messages.forEach((msg) => console.log(`[${prefix}] ${msg}`));
}

log("INFO", "Server started", "Port: 3000");
```

---

## 3.4 函式多載（Function Overloads）

當函式根據不同的輸入型別需要不同的回傳型別時，使用函式多載。

#### 先看「不用多載」會遇到什麼問題

如果只寫一個簽名，把輸入輸出都用聯合型別帶過：

```typescript
function parseLoose(value: string | number): number | string {
  if (typeof value === "string") return parseInt(value, 10);
  return value.toString();
}

const n = parseLoose("42");
// n 的型別是 number | string，不是 number！
// n.toFixed(2); // ❌ 因為 n 可能是 string，TS 不讓你直接當 number 用
```

問題在於：**回傳型別 `number | string` 沒有把「輸入是字串 → 輸出一定是數字」這個對應關係表達出來。** 呼叫者拿到的永遠是模糊的聯合型別，還得自己再判斷一次。

#### 用多載把「輸入與輸出的對應」寫清楚

```typescript
// 多載簽名（給呼叫者看的「對外說明書」，可以有很多條）
function parse(value: string): number;
function parse(value: number): string;
// 實作簽名（給函式內部看的，涵蓋所有情況；呼叫者看不到、也不能直接呼叫）
function parse(value: string | number): number | string {
  if (typeof value === "string") {
    return parseInt(value, 10);
  }
  return value.toString();
}

const num = parse("42");   // 型別精準為 number
const str = parse(42);     // 型別精準為 string

// 實際應用：DOM querySelector（傳不同的選擇字串，回傳更精確的 DOM 型別）
function querySelector(selector: "#app"): HTMLDivElement;
function querySelector(selector: "input"): HTMLInputElement;
function querySelector(selector: string): HTMLElement;
function querySelector(selector: string): HTMLElement {
  return document.querySelector(selector)!;
}
```

**三個部分各自的角色，一次記住：**

| 部分 | 誰看得到 | 作用 |
| --- | --- | --- |
| 多載簽名（上面幾行，只有簽名沒有 `{}`） | ✅ 呼叫者 | 對外的「說明書」，決定呼叫時能傳什麼、回傳什麼型別 |
| 實作簽名（最後一行，有 `{}` 函式本體） | ❌ 呼叫者看不到 | 只給函式內部用，必須用聯合型別涵蓋**所有**多載情況 |

> ⚠️ **常見誤解**：實作簽名雖然寫著 `value: string | number`，但呼叫者**不能**直接用它。也就是說，就算實作允許 `string | number`，只要多載簽名沒列出來的組合（例如同時想接受 `boolean`）就會被擋下。呼叫時能用哪些型別，**完全由上面的多載簽名決定**，實作簽名只是「內部一次處理所有狀況」的地方。

> 💡 以上多載都寫在 `function` 宣告上。如果把函式改成賦值給變數的箭頭函式（`const parse = (value: string | number) => ...`），就**無法直接在它身上疊加多個多載簽名**——原因有兩個：
>
> 1. **「疊加多條簽名」是 `function` 宣告獨有的語法。** 上面那種多載，是連續寫好幾行「只有簽名、沒有 `{}`」的 `function parse(...)` 宣告，TypeScript 會把它們全部算成同一個 `parse` 的多載。箭頭函式則是「先算出一個函式值，再用 `const` 賦值給變數」，語法上根本沒有「在同一個 `const` 上再多寫幾條簽名」這種寫法。
> 2. **一個變數只有「一格」型別位置可以標註。** 變數的型別只能寫在冒號後面那一格（`const parse: 型別 = ...`），而這一格只能填**一個**函式型別，沒辦法把「string→number」「number→string」兩條對應同時塞進去。
>
> 所以解法是：把「多條簽名」包成**一個型別**，再填進那唯一的一格——也就是改用具有多個呼叫簽名（call signature）的 `interface`（或 `type`）：

```typescript
// 箭頭函式版本的多載：改用多個呼叫簽名的 interface
interface Parse {
  (value: string): number; // 傳 string → 回傳 number
  (value: number): string; // 傳 number → 回傳 string
}

// 實作本體要用聯合型別涵蓋所有情況，再用 as 斷言成 Parse
const parse = ((value: string | number) => {
  if (typeof value === "string") {
    return parseInt(value, 10);
  }
  return value.toString();
}) as Parse;

// 呼叫方式與回傳型別，跟前面 function 宣告版完全一樣：
const num = parse("42");   // 型別精準為 number
const str = parse(42);     // 型別精準為 string
// parse(true);            // ❌ 報錯：Parse 沒有接受 boolean 的簽名
```

> ⚠️ **為什麼一定要 `as Parse`？** 因為實作本體的型別是 `(value: string | number) => number | string`，它並不符合 `Parse` 裡「傳 string 就一定回 number」這種精確對應（回傳的 `number | string` 不能塞進 `number`），TypeScript 會拒絕直接賦值。這裡用 `as Parse` 告訴編譯器「相信我，這個實作涵蓋了全部情況」。這也是箭頭函式版多載比 `function` 宣告版麻煩的地方——所以**能用 `function` 宣告時，通常還是優先用它**。

---

## 3.5 回呼函式（Callback）型別

```typescript
// 定義回呼型別
type Callback = (error: Error | null, result?: string) => void;

function fetchData(url: string, callback: Callback): void {
  try {
    // 模擬 API 請求
    const result = `Data from ${url}`;
    callback(null, result);
  } catch (error) {
    // catch 到的 error 型別是 unknown，須先型別縮窄（見 2.5 unknown）才能安全使用
    callback(error instanceof Error ? error : new Error(String(error)));
  }
}

fetchData("https://api.example.com", (err, data) => {
  if (err) {
    console.error(err.message);
    return;
  }
  console.log(data);
});

// 事件處理器
type EventHandler = (event: MouseEvent) => void;

const handleClick: EventHandler = (event) => {
  console.log(`Clicked at (${event.clientX}, ${event.clientY})`);
};
```

---

## 3.6 this 的型別

```typescript
// 明確標註 this 的型別
interface Button {
  label: string;
  onClick(this: Button): void;
}

const button: Button = {
  label: "Submit",
  onClick() {
    console.log(`Button: ${this.label}`); // this 的型別是 Button
  },
};

// ❌ 從物件中解構會失去 this
// const { onClick } = button;
// onClick(); // 錯誤：this 的型別不對

// 使用 bind
const boundClick = button.onClick.bind(button);
boundClick(); // ✅ OK
```

---

## 3.7 泛型函式（預覽）

> 泛型將在 [第六章](./06-generics.md) 深入說明，這裡先預覽基本用法。

```typescript
// 不使用泛型 — 需要為每種型別寫一個函式
function identityString(arg: string): string {
  return arg;
}
function identityNumber(arg: number): number {
  return arg;
}

// 使用泛型 — 一個函式適用所有型別
function identity<T>(arg: T): T {
  return arg;
}

identity<string>("hello"); // 回傳型別為 string
identity<number>(42);      // 回傳型別為 number
identity("hello");         // 也可以省略，TypeScript 會自動推斷
```

---

## 3.8 常見的函式型別模式

### Promise 回傳型別

只要函式加上 `async`，它的回傳型別**一定**是 `Promise<T>`——就算你在函式裡寫 `return user`（一個普通物件），實際拿到的也是包了一層的 `Promise<User>`。這裡的 `<T>` 標的是「`await` 之後會拿到什麼」，而不是函式當場吐出來的東西。

```typescript
// 自足：補上此範例用到的 User 型別定義
interface User {
  id: number;
  name: string;
  email: string;
}

async function fetchUser(id: number): Promise<User> {
  const response = await fetch(`/api/users/${id}`);
  return response.json();
}

// 搭配 try-catch
async function safeGetUser(id: number): Promise<User | null> {
  try {
    return await fetchUser(id);
  } catch {
    return null;
  }
}
```

**逐行拆解上面發生了什麼事：**

| 寫法 | 型別 | 說明 |
| --- | --- | --- |
| `fetchUser(id)` | `Promise<User>` | 呼叫 async 函式，拿到的是「還沒完成的 Promise」，不是 `User` 本身 |
| `await fetchUser(id)` | `User` | `await` 把 Promise「拆封」，等它完成後取出裡面的 `User` |
| `return response.json()` | —— | `.json()` 回傳的是 `Promise<any>`，直接 `return` 出去，由函式簽名 `Promise<User>` 決定對外型別 |

> ⚠️ **最容易誤會的一點：型別標註不會在執行期驗證資料。** `fetchUser` 標成 `Promise<User>`，只是「告訴 TypeScript 相信這個 API 會回傳 `User`」。如果後端實際回傳的 JSON 缺了 `email`，TypeScript **不會報錯也不會擋下來**——編譯期的型別檢查與執行期真正收到的資料是兩回事。要真正確保資料正確，得自己在執行期驗證（例如用 [Zod](https://zod.dev) 之類的函式庫）。

> 💡 **為什麼 `safeGetUser` 的回傳型別是 `Promise<User | null>`？** 因為它多了一條「失敗就回 `null`」的路徑：成功時 `return await fetchUser(id)`（`User`），失敗時 `return null`。兩條路徑合起來，async 包裝後就是 `Promise<User | null>`。好處是**呼叫者被型別強制處理「可能沒拿到」的情況**——直接 `user.name` 會被 TS 擋下來，逼你先判斷 `if (user)`。

### 解構參數型別

```typescript
// 參數解構
function createUser({ name, age, email }: { name: string; age: number; email: string }) {
  return { id: Date.now(), name, age, email };
}

// 更好的寫法 — 搭配 interface
interface CreateUserParams {
  name: string;
  age: number;
  email: string;
}

function createUser({ name, age, email }: CreateUserParams) {
  return { id: Date.now(), name, age, email };
}
```

### 函式作為物件屬性

```typescript
interface Calculator {
  add: (a: number, b: number) => number;
  subtract: (a: number, b: number) => number;
  multiply(a: number, b: number): number; // 方法簡寫
}

const calc: Calculator = {
  add: (a, b) => a + b,
  subtract: (a, b) => a - b,
  multiply(a, b) {
    return a * b;
  },
};
```

---

## 練習題

### 練習 1：基本函式

寫一個函式 `formatCurrency`，接收金額（number）和貨幣代碼（可選，預設 "TWD"），回傳格式化字串：

```typescript
formatCurrency(1000);          // "TWD 1,000"
formatCurrency(1000, "USD");   // "USD 1,000"
```

<details>
<summary>參考解答</summary>

第二個參數 `currency` 給預設值 `"TWD"`，它就自動變成可選參數。金額的千分位可以用 `toLocaleString("en-US")` 產生（例如 `1000` → `"1,000"`），最後用模板字串把貨幣代碼和金額組起來。

```typescript
function formatCurrency(amount: number, currency: string = "TWD"): string {
  return `${currency} ${amount.toLocaleString("en-US")}`;
}

formatCurrency(1000);        // "TWD 1,000"
formatCurrency(1000, "USD"); // "USD 1,000"
```

重點提醒：有預設值的參數就等同於可選參數，不必再加 `?`；兩者一起用（`currency?: string = "TWD"`）反而是語法錯誤。

</details>

### 練習 2：函式多載

寫一個多載函式 `convert`：
- 接收 `string` 回傳 `number`
- 接收 `number` 回傳 `string`

<details>
<summary>參考解答</summary>

先寫兩行「多載簽名」描述外部看到的輸入輸出對應，再寫一行「實作簽名」處理實際邏輯（它的型別要能涵蓋所有多載，所以用聯合型別）。實作簽名本身不會被外部呼叫。

```typescript
// 多載簽名
function convert(value: string): number;
function convert(value: number): string;
// 實作簽名
function convert(value: string | number): number | string {
  if (typeof value === "string") {
    return parseInt(value, 10);
  }
  return value.toString();
}

const n = convert("42"); // 型別為 number
const s = convert(42);   // 型別為 string
```

重點提醒：呼叫端只看得到上面兩個多載簽名，因此 `convert("42")` 的回傳型別是 `number`、`convert(42)` 是 `string`，比單純寫 `number | string` 更精確。

</details>

### 練習 3：回呼函式

定義一個 `retry` 函式，接收一個非同步操作和重試次數，在失敗時自動重試：

```typescript
async function retry<T>(
  operation: () => Promise<T>,
  maxRetries: number,
): Promise<T> {
  // 實作...
}
```

<details>
<summary>參考解答</summary>

用一個迴圈嘗試執行 `operation`，成功就直接 `return` 結果；失敗就把錯誤記下來繼續下一輪。迴圈跑滿 `maxRetries` 次仍失敗，就把最後一次的錯誤拋出。`catch` 到的 `error` 型別是 `unknown`，拋出前先用 `instanceof Error` 縮窄（見 2.5 unknown）確保拋出的是 `Error`。

```typescript
async function retry<T>(
  operation: () => Promise<T>,
  maxRetries: number,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error; // 記住最後一次錯誤，重試次數用完後再拋出
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// 範例：前兩次故意失敗，第三次成功
let count = 0;
async function unstable(): Promise<string> {
  count++;
  if (count < 3) {
    throw new Error(`第 ${count} 次失敗`);
  }
  return "成功！";
}

retry(unstable, 5).then((result) => console.log(result)); // 成功！
```

重點提醒：`operation` 的回傳型別用泛型 `T` 帶著走，所以 `retry` 能適用任何非同步操作而不失去型別資訊（泛型將在第六章深入）；`for` 迴圈條件寫 `attempt <= maxRetries` 代表「第一次執行 + 額外重試 maxRetries 次」。

</details>

---

> 下一章：[第四章 — 介面與型別別名](./04-interfaces-type-aliases.md)
