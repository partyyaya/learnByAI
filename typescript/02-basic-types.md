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

### 何時使用 Enum vs Union Type？

```typescript
// Enum — 適合有邏輯分組的常數
enum Role {
  Admin = "ADMIN",
  User = "USER",
  Guest = "GUEST",
}

// Union Type — 適合簡單的字面值聯合（推薦）
type Role = "admin" | "user" | "guest";
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

### 練習 2：元組

定義一個代表 RGB 顏色的元組型別，並建立幾個顏色常數：

```typescript
// 定義 RGB 型別
type RGB = ???;

const red: RGB = ???;
const green: RGB = ???;
const blue: RGB = ???;
```

### 練習 3：列舉與聯合型別

分別用 Enum 和 Union Type 定義一組「訂單狀態」：pending、processing、shipped、delivered、cancelled。

---

> 下一章：[第三章 — 函式與型別](./03-functions.md)
