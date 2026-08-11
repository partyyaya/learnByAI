# 第二章：基本型別系統

## 2.1 原始型別（Primitive Types）

TypeScript 支援 JavaScript 的所有原始型別，並加上了型別標註語法。

### string

```typescript
let name: string = "Gary";
let greeting: string = `Hello, ${name}`; // 支援模板字串
let empty: string = "";
```

### number

```typescript
let age: number = 30;
let price: number = 19.99;
let hex: number = 0xff;       // 十六進位
let binary: number = 0b1010;  // 二進位
let octal: number = 0o744;    // 八進位
let big: bigint = 100n;       // BigInt（需要 ES2020+）
```

### boolean

```typescript
let isDone: boolean = false;
let isActive: boolean = true;
```

### null 與 undefined

```typescript
let nothing: null = null;
let notDefined: undefined = undefined;

// 在 strict 模式下，null 和 undefined 不能賦值給其他型別
let name: string = null;      // ❌ 嚴格模式下錯誤
let age: number = undefined;  // ❌ 嚴格模式下錯誤
```

### symbol

```typescript
let sym1: symbol = Symbol("key");
let sym2: symbol = Symbol("key");
console.log(sym1 === sym2); // false — 每個 Symbol 都是唯一的
```

---

## 2.2 陣列（Array）

```typescript
// 方式一：型別 + []
let numbers: number[] = [1, 2, 3, 4, 5];
let names: string[] = ["Alice", "Bob", "Charlie"];

// 方式二：Array<型別>（泛型寫法）
let scores: Array<number> = [90, 85, 78];
let items: Array<string> = ["apple", "banana"];

// 聯合型別陣列：元素可以是多種型別
let mixed: (string | number)[] = ["apple", 42, "banana", 100];
let mixed2: Array<string | number> = ["apple", 42]; // 泛型寫法

// ⚠️ 注意括號位置：
// (string | number)[] → string 或 number 的陣列 ✅
// string | number[]   → string 或 number陣列（語意不同）❌

// 唯讀陣列
let readonlyArr: readonly number[] = [1, 2, 3];
// readonlyArr.push(4); // ❌ 唯讀陣列不能修改
```

---

## 2.3 元組（Tuple）

元組是**固定長度**且每個位置有**明確型別**的陣列。

```typescript
// 定義元組
let person: [string, number] = ["Gary", 30];

// 存取元素
console.log(person[0]); // "Gary" — 型別為 string
console.log(person[1]); // 30 — 型別為 number

// ❌ 錯誤的賦值
// let wrong: [string, number] = [30, "Gary"]; // 型別順序錯誤
// let short: [string, number] = ["Gary"];      // 長度不符

// 具名元組（Named Tuples）— TypeScript 4.0+
let user: [name: string, age: number, active: boolean] = ["Gary", 30, true];

// 唯讀元組
let point: readonly [number, number] = [10, 20];
// point[0] = 30; // ❌ 無法修改
```

### 實用場景

```typescript
// React 的 useState 就是回傳元組
// const [count, setCount] = useState<number>(0);

// 座標
type Coordinate = [x: number, y: number];
const origin: Coordinate = [0, 0];

// 鍵值對
type Entry = [key: string, value: unknown];
const entries: Entry[] = [
  ["name", "Gary"],
  ["age", 30],
];
```

---

## 2.4 列舉（Enum）

### 數字列舉

```typescript
enum Direction {
  Up,    // 0
  Down,  // 1
  Left,  // 2
  Right, // 3
}

let dir: Direction = Direction.Up;
console.log(dir);                  // 0
console.log(Direction[0]);         // "Up"（反向映射）

// 自訂起始值
enum StatusCode {
  OK = 200,
  NotFound = 404,
  ServerError = 500,
}
```

### 字串列舉

```typescript
enum Color {
  Red = "RED",
  Green = "GREEN",
  Blue = "BLUE",
}

let color: Color = Color.Red;
console.log(color); // "RED"
```

### const enum（編譯時消除）

```typescript
const enum HttpMethod {
  GET = "GET",
  POST = "POST",
  PUT = "PUT",
  DELETE = "DELETE",
}

// 編譯後直接被替換成值，不產生額外程式碼
let method = HttpMethod.GET; // 編譯後：let method = "GET";
```

### 普通 enum vs const enum，該選哪個？

兩者寫法幾乎一樣，差別在「編譯後有沒有留下東西」：

| 比較項目 | 普通 enum | const enum |
| --- | --- | --- |
| 編譯結果 | 產生一個真實的 JS 物件 | 完全消除，直接把值 inline 進去 |
| 執行期是否存在 | 存在，可傳遞、可遍歷 | 不存在，沒有物件可用 |
| `Object.values()` 遍歷 | ✅ 可以 | ❌ 不行（物件已被消除） |
| 打包後體積 | 較大 | 較小（零額外程式碼） |
| 工具相容性 | 到處都能用 | Babel / esbuild / Vite / swc 等單檔轉譯工具不支援 |

```typescript
// 普通 enum 可以在執行期遍歷（做下拉選單、驗證輸入很常用）
enum Color {
  Red = "RED",
  Green = "GREEN",
  Blue = "BLUE",
}
Object.values(Color).forEach((c) => console.log(c)); // RED / GREEN / BLUE

// const enum 沒有這個物件，上面這行會直接編譯錯誤
```

**選擇原則：**

- **預設用普通 enum。** 需要在執行期遍歷、傳遞、或用 `Object.values()` / `Object.keys()` 時只能用它。
- **只有在確定用不到執行期物件、又想省下打包體積時，才考慮 const enum。**
- ⚠️ **用 Vite / esbuild / Babel / swc 建置的專案（也就是大多數現代前端專案）請避免 const enum**，這些工具是逐檔轉譯、看不到 enum 的完整定義，會報錯或行為不正確。
- 💡 如果只是想要「一組字面值」而不需要 enum 的物件特性，通常直接用下面的 **Union Type** 會更單純。

### 何時使用 Enum vs Union Type？

> ⚠️ 下面兩段刻意分成兩個獨立區塊：`enum Role` 與 `type Role` 同名會產生 TS2567 衝突，實際專案中只會擇一使用。

```typescript
// Enum — 適合有邏輯分組的常數
enum Role {
  Admin = "ADMIN",
  User = "USER",
  Guest = "GUEST",
}

let adminRole: Role = Role.Admin;
```

```typescript
// Union Type — 適合簡單的字面值聯合（推薦）
type Role = "admin" | "user" | "guest";

let userRole: Role = "user";
```

> 💡 現代 TypeScript 開發中，**字串聯合型別（Union Type）** 通常比 Enum 更受歡迎，因為它更簡潔且不會產生額外的 JavaScript 程式碼。

---

## 2.5 any、unknown、never、void

### any — 任意型別（盡量避免使用）

```typescript
let anything: any = "hello";
anything = 42;       // ✅ 不報錯
anything = true;     // ✅ 不報錯
anything.foo.bar;    // ✅ 不報錯（但執行時可能出錯！）

// ⚠️ any 會讓 TypeScript 失去型別保護
```

### unknown — 安全的 any（TypeScript 3.0+）

```typescript
let value: unknown = "hello";
value = 42;
value = true;

// ❌ 不能直接使用 unknown
// value.toUpperCase(); // 錯誤！

// ✅ 必須先進行型別檢查（Type Guard）
if (typeof value === "string") {
  console.log(value.toUpperCase()); // OK
}

if (typeof value === "number") {
  console.log(value.toFixed(2)); // OK
}
```

### void — 無回傳值

```typescript
function log(message: string): void {
  console.log(message);
  // 沒有 return（或 return undefined）
}
```

### never — 永遠不會有值

```typescript
// 函式永遠不會正常結束
function throwError(message: string): never {
  throw new Error(message);
}

// 無窮迴圈
function infiniteLoop(): never {
  while (true) {}
}

// 用於窮盡檢查（Exhaustive Check）
type Shape = "circle" | "square" | "triangle";

function getArea(shape: Shape): number {
  switch (shape) {
    case "circle":
      return Math.PI * 10 * 10;
    case "square":
      return 10 * 10;
    case "triangle":
      return (10 * 10) / 2;
    default:
      // 如果漏掉某個 case，這裡會出現型別錯誤
      const _exhaustive: never = shape;
      return _exhaustive;
  }
}
```

### void vs never，該用哪一個？

兩者都表示「沒有回傳值」，但關鍵差別在於**函式到底會不會正常結束**：

| | void | never |
| --- | --- | --- |
| 函式會正常執行完嗎 | ✅ 會，只是不回傳有意義的值 | ❌ 不會，根本走不到結尾 |
| 實際回傳的值 | `undefined` | 沒有任何值（連 undefined 都沒有） |
| 典型情境 | 有副作用但不需回傳（log、事件處理、setter） | 一定會 throw、無窮迴圈、窮盡檢查 |

```typescript
// void：做完事情就結束，回傳 undefined
function printReceipt(total: number): void {
  console.log(`總金額：${total}`); // 有副作用，但呼叫端不需要拿到回傳值
}

// never：這個函式「保證」不會把控制權還給呼叫端
function fail(message: string): never {
  throw new Error(message); // 執行到這裡就中斷了，後面的程式碼永遠不會跑
}
```

**判斷方法：** 問自己「這個函式呼叫完之後，下一行程式碼會不會執行？」

- 會執行 → 用 **`void`**（大多數不回傳值的函式都是這種）。
- 不會執行（一定 throw 或卡死） → 用 **`never`**。

> 💡 `never` 大部分時候是 TypeScript **自動推論**出來的，你很少需要手動標註。真正常用它的地方是上面的**窮盡檢查**：當 `Shape` 之後新增了型別卻忘了補 `case`，`shape` 就不再是 `never`，`const _exhaustive: never = shape;` 這行會立刻報錯，提醒你少處理了一種情況。

---

## 2.6 型別推論（Type Inference）

TypeScript 會自動推斷變數的型別，不需要每個地方都手動標註。

```typescript
// TypeScript 自動推斷型別
let name = "Gary";       // 推斷為 string
let age = 30;            // 推斷為 number
let active = true;       // 推斷為 boolean
let items = [1, 2, 3];   // 推斷為 number[]

// 函式回傳型別也可以推斷
function add(a: number, b: number) {
  return a + b; // 回傳型別自動推斷為 number
}

// 什麼時候需要手動標註？
// 1. 函式參數（必須標註）
// 2. 變數初始化為空陣列時
let results: number[] = [];

// 3. 當推斷結果不符合預期時
let id: string | number = "abc";
```

---

## 2.7 型別斷言（Type Assertion）

當你比 TypeScript 更了解某個值的型別時，可以使用型別斷言。

```typescript
// 方式一：as 語法（推薦）
let someValue: unknown = "hello world";
let strLength: number = (someValue as string).length;

// 方式二：尖括號語法（在 JSX/TSX 中不可用）
let strLength2: number = (<string>someValue).length;

// 實際場景：DOM 操作
const input = document.getElementById("username") as HTMLInputElement;
input.value = "Gary";

// 非空斷言（Non-null Assertion）— 用 ! 運算子
const element = document.getElementById("app")!;
// 告訴 TypeScript：我確定這個值不是 null
```

> ⚠️ 型別斷言不是型別轉換，它不會改變資料本身，只是告訴編譯器「請相信我」。濫用會導致執行時錯誤。

---

## 2.8 字面值型別（Literal Types）

```typescript
// 字串字面值型別
let direction: "up" | "down" | "left" | "right";
direction = "up";    // ✅
// direction = "forward"; // ❌

// 數字字面值型別
type DiceRoll = 1 | 2 | 3 | 4 | 5 | 6;
let roll: DiceRoll = 3; // ✅
// let invalid: DiceRoll = 7; // ❌

// 布林字面值型別
type Yes = true;
let agree: Yes = true;
// let disagree: Yes = false; // ❌

// 搭配物件使用
type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";
type ApiEndpoint = {
  url: string;
  method: HttpMethod;
};

const endpoint: ApiEndpoint = {
  url: "/api/users",
  method: "GET",
};
```

### as const 斷言

```typescript
// 一般物件
const config = {
  url: "https://api.example.com",
  method: "GET",
};
// config.method 的型別是 string

// 使用 as const
const config2 = {
  url: "https://api.example.com",
  method: "GET",
} as const;
// config2.method 的型別是 "GET"（字面值型別）
// config2 所有屬性都變成 readonly
```

#### 為什麼型別會變？先搞懂「型別拓寬」

很多人會困惑：`config` 明明是 `const`，為什麼 `method` 還被推論成 `string`，而不是 `"GET"`？

關鍵在於 **`const` 鎖住的是「變數」，不是「物件內容」**。物件屬性本身是可以改的：

```typescript
const config = {
  url: "https://api.example.com",
  method: "GET",
};

config.method = "POST"; // ✅ 完全合法！物件屬性可以被重新賦值
```

正因為 TypeScript 知道 `config.method` 之後**還可能被改成別的字串**，所以它保守地把型別「拓寬」成 `string`，而不是死守 `"GET"`。這個「把字面值放寬成通用型別」的行為就叫 **型別拓寬（Type Widening）**。

```typescript
// 對照：直接用 const 宣告「原始值」時，不會拓寬
const method = "GET";   // 型別是 "GET"（字面值，因為 method 不可能再被改）
let   method2 = "GET";  // 型別是 string（let 可以被改，所以拓寬）
```

#### as const 做了什麼

`as const` 等於告訴 TypeScript：「這整個值都是不可變的常數，請用最窄的字面值型別，別拓寬。」

```typescript
const config2 = {
  url: "https://api.example.com",
  method: "GET",
} as const;

// config2.method = "POST"; // ❌ 錯誤：屬性是 readonly，不能改
```

它一次做了兩件事：

1. **所有屬性變成 `readonly`** → 保證內容不會再變。
2. **屬性型別收窄成字面值** → 既然不會變，`method` 就能安全地推論為 `"GET"`。

換句話說：**因為 `as const` 承諾了「不會再改」，TypeScript 才敢把型別收到最窄。** 這也是為什麼它很適合用來定義設定檔、常數表，或搭配前面的字串聯合型別使用。

### typeof 型別查詢：從「值」取出「型別」

`as const` 把值凍結成最窄的字面值型別後，下一步通常是**把這些型別拿出來用**——這需要 `typeof`。

#### `typeof` 有兩種身分

同一個關鍵字，靠**出現的位置**決定意義：

| 位置 | 身分 | 什麼時候執行 |
| --- | --- | --- |
| 運算式中（`if`、賦值右側…） | JavaScript 的運算子，回傳型別名稱的字串 | 執行期 |
| 型別位置（`:` 之後、`type X =` 右側…） | TypeScript 的**型別查詢**，取出某個值的型別 | 編譯期 |

```typescript
const value = "hello";

const isStr = typeof value === "string"; // 運算式位置：執行期得到字串 "string"
type ValueType = typeof value;           // 型別位置：編譯期得到型別 "hello"
```

兩者只是共用了關鍵字，**做的事情完全不同**，不會互相影響。

#### 用途一：不必手寫型別，直接從值推導

平常我們是「先定義型別，再寫符合型別的值」。`typeof` 讓你反過來：**先寫值，型別自動生出來**。

```typescript
const config = {
  url: "https://api.example.com",
  timeout: 5000,
  retry: true,
};

// 不用手寫 interface Config { url: string; timeout: number; retry: boolean }
type Config = typeof config;

// 之後其他變數就能沿用這個型別
const backupConfig: Config = { url: "/api/backup", timeout: 100, retry: false };
```

好處是**只有一份來源**：`config` 加一個欄位，`Config` 自動跟著長出來，不會出現「改了值卻忘記改型別」的情形。

> ⚠️ `typeof` 後面只能放**值**（變數、函式、類別），不能放型別：
>
> ```typescript
> interface Foo { a: number }
> // type T = typeof Foo;
> // ❌ TS2693: 'Foo' only refers to a type, but is being used as a value here.
> ```

#### 用途二：搭配 `keyof` 取出所有鍵

`keyof` 吃的是型別，所以要先用 `typeof` 把值轉成型別，才能接 `keyof`——`keyof typeof x` 這個組合在實務上非常常見：

```typescript
const THEME = {
  primary: "#007bff",
  danger: "#dc3545",
} as const;

type ThemeName = keyof typeof THEME; // "primary" | "danger"

function getColor(name: ThemeName): string {
  return THEME[name];
}

getColor("primary"); // ✅ 有自動完成
// getColor("warning"); // ❌ THEME 裡沒有這個鍵，編譯期就擋下來
```

#### 用途三：把常數陣列變成聯合型別

陣列版本要多一個步驟 `[number]`：

```typescript
const ROLES = ["admin", "editor", "user"] as const;

type Role = (typeof ROLES)[number]; // "admin" | "editor" | "user"
```

`[number]` 的意思是「**索引是任意數字時，可能取到的型別**」——既然每個位置都有可能，結果就是所有元素型別的聯合。（不是「第 number 個元素」。）

這個三段組合是實務上極常用的樣板：

```text
as const            typeof              [number]
凍結成字面值   →   從值進到型別   →   把元組攤成聯合型別
```

**`as const` 不能省**，否則第一步字面值就丟掉了：

```typescript
const LOOSE = ["admin", "editor", "user"]; // 沒有 as const → string[]
type Bad = (typeof LOOSE)[number];         // string ⚠️ 整個技巧失效
```

最大的價值是**執行期與編譯期共用同一份來源**：

```typescript
const ROLES = ["admin", "editor", "user"] as const;
type Role = (typeof ROLES)[number];

function isRole(value: string): value is Role {
  return ROLES.includes(value as Role); // 執行期檢查用同一個陣列
}

// 之後要新增角色，只改 ROLES 一個地方，型別與執行期檢查都自動跟上
```

> 📌 `keyof` 的完整說明見第 6 章 6.3，索引存取型別（`T[K]`）與更多應用見第 7 章 7.6。

---

## 練習題

### 練習 1：型別標註

為以下變數加上正確的型別標註：

```typescript
let productName = "iPhone 15";
let price = 35900;
let inStock = true;
let tags = ["electronics", "phone", "apple"];
let rating = [4.5, 4.8, 4.2, 4.9];
```

<details>
<summary>參考解答</summary>

依照每個變數的初始值判斷型別：字串用 `string`、數字用 `number`、布林用 `boolean`，字串陣列用 `string[]`、數字陣列用 `number[]`。

```typescript
let productName: string = "iPhone 15";
let price: number = 35900;
let inStock: boolean = true;
let tags: string[] = ["electronics", "phone", "apple"];
let rating: number[] = [4.5, 4.8, 4.2, 4.9];
```

重點提醒：其實這些變數在初始化時，TypeScript 就能自動推論出相同型別，手動標註只是練習語法；真正一定要標註的是「函式參數」與「初始化為空陣列」等推論不出來的情況。

</details>

### 練習 2：元組

定義一個代表 RGB 顏色的元組型別，並建立幾個顏色常數：

```typescript
// 定義 RGB 型別
type RGB = ???;

const red: RGB = ???;
const green: RGB = ???;
const blue: RGB = ???;
```

<details>
<summary>參考解答</summary>

RGB 顏色是三個固定位置的數字（紅、綠、藍），正好用「固定長度、每個位置有明確型別」的元組來表達。這裡用具名元組讓每個位置的意義更清楚。

```typescript
// 具名元組（TypeScript 4.0+），三個位置都是 number
type RGB = [r: number, g: number, b: number];

const red: RGB = [255, 0, 0];
const green: RGB = [0, 255, 0];
const blue: RGB = [0, 0, 255];
```

重點提醒：用 `[number, number, number]` 也完全正確；具名元組的名稱只是提升可讀性，不影響型別檢查。元組長度固定，寫成 `[255, 0]` 或 `[255, 0, 0, 0]` 都會報錯。

</details>

### 練習 3：列舉與聯合型別

分別用 Enum 和 Union Type 定義一組「訂單狀態」：pending、processing、shipped、delivered、cancelled。

<details>
<summary>參考解答</summary>

Enum 版把每個狀態列為成員並指定字串值；Union Type 版則直接把五個字面值用 `|` 串起來。

> ⚠️ 下面兩段刻意分成兩個獨立區塊：`enum OrderStatus` 與 `type OrderStatus` 同名會產生 TS2567 衝突，實務上擇一使用即可。

```typescript
// 方式一：Enum
enum OrderStatus {
  Pending = "pending",
  Processing = "processing",
  Shipped = "shipped",
  Delivered = "delivered",
  Cancelled = "cancelled",
}

const status: OrderStatus = OrderStatus.Shipped;
```

```typescript
// 方式二：Union Type
type OrderStatus =
  | "pending"
  | "processing"
  | "shipped"
  | "delivered"
  | "cancelled";

const status: OrderStatus = "shipped";
```

重點提醒：現代 TypeScript 多半偏好 Union Type，因為它更簡潔、不會編譯出額外的 JavaScript 程式碼；需要反向映射或整組常數集中管理時，Enum 才較有優勢。

</details>

---

> 下一章：[第三章 — 函式與型別](./03-functions.md)
