# 第七章：進階型別技巧

## 7.1 聯合型別（Union Types）

```typescript
// 基本聯合型別
type ID = string | number;

function printId(id: ID): void {
  // 需要型別縮窄才能使用特定方法
  if (typeof id === "string") {
    console.log(id.toUpperCase());
  } else {
    console.log(id.toFixed(2));
  }
}

// 判別式聯合（Discriminated Union）
type Shape =
  | { kind: "circle"; radius: number }
  | { kind: "square"; side: number }
  | { kind: "rectangle"; width: number; height: number };

function getArea(shape: Shape): number {
  switch (shape.kind) {
    case "circle":
      return Math.PI * shape.radius ** 2;
    case "square":
      return shape.side ** 2;
    case "rectangle":
      return shape.width * shape.height;
    default: {
      // 窮盡性檢查：若 shape 的型別不是 never，表示還有分支沒處理
      const _exhaustive: never = shape;
      throw new Error(`Unhandled shape: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
```

加上 `default` 分支的窮盡性檢查（exhaustiveness check）後，未來替 `Shape` 新增一種變體（例如 `{ kind: "triangle"; ... }`）卻忘記在 `getArea` 補上對應 `case` 時，`shape` 在 `default` 分支的型別就不會是 `never`，`const _exhaustive: never = shape` 這一行會在**編譯期**直接報錯，而不用等到執行期才發現漏處理。

### satisfies 運算子（TS 4.9+）

`satisfies` 讓你在檢查物件是否符合某個型別結構的同時，仍然保留物件的字面值型別，跟一般型別標註（`: T`）或 `as T` 斷言都不一樣：

```typescript
type Shape =
  | { kind: "circle"; radius: number }
  | { kind: "square"; side: number }
  | { kind: "rectangle"; width: number; height: number };

// 一般型別標註：值被拓寬成 Shape，之後只能存取聯合型別共有欄位
const configA: Shape = { kind: "circle", radius: 5 };
// configA.radius; // ❌ 型別是 Shape，TypeScript 不知道一定是 circle 分支

// as 斷言：不會做完整結構檢查，多打的欄位可能就這樣溜過去
const configB = { kind: "circle", radius: 5, extraFlag: true } as Shape;

// satisfies：檢查是否符合 Shape 結構（含多餘屬性檢查），同時保留字面值型別
const configC = { kind: "circle", radius: 5 } satisfies Shape;
configC.radius; // ✅ 型別仍是 { kind: "circle"; radius: number }，可以直接存取

// const configD = { kind: "circle", radius: 5, extraFlag: true } satisfies Shape;
// ❌ 物件字面值有多餘屬性 extraFlag，satisfies 會抓出來
```

#### 什麼時候會需要 satisfies？

`satisfies` 解決的是一個「二選一」的困境 —— 在它出現之前，你只能在「有型別檢查」和「保留精確型別」之間挑一個：

| 寫法 | 有做結構檢查嗎 | 保留精確型別嗎 |
| --- | --- | --- |
| `const x: T = {...}` | ✅ 有 | ❌ 被拓寬成 `T` |
| `const x = {...} as T` | ⚠️ 只做寬鬆檢查，多打的欄位會溜過去 | ❌ 也變成 `T`，而且不安全 |
| `const x = {...}` | ❌ 沒有 | ✅ 有 |
| `const x = {...} satisfies T` | ✅ 有（含多餘屬性檢查） | ✅ 有 |

**場景 1：設定表 / 常數表（最常見，也最有感）**

```typescript
type RouteConfig = { path: string; auth: boolean };

// ❌ 一般標註：型別被拓寬成 Record<string, RouteConfig>
const routesA: Record<string, RouteConfig> = {
  home: { path: "/", auth: false },
  admin: { path: "/admin", auth: true },
};

routesA.hoem; // ⚠️ 打錯 key 完全不報錯！索引簽章等於宣告「任何字串鍵都合法」
type NameA = keyof typeof routesA; // string —— 具體有哪些路由的資訊全丟了

// ✅ satisfies：既檢查每個值符合 RouteConfig，又保留 key 的字面量
const routesB = {
  home: { path: "/", auth: false },
  admin: { path: "/admin", auth: true },
} satisfies Record<string, RouteConfig>;

// routesB.hoem;
// ❌ Property 'hoem' does not exist on type '{ home: ...; admin: ... }'

type NameB = keyof typeof routesB; // "home" | "admin" —— 可以拿去當參數型別
function go(name: NameB) {
  console.log(routesB[name].path);
}
go("admin"); // ✅ 有自動完成
// go("other"); // ❌ 編譯期就擋下來
```

這是 `satisfies` 最大的價值：`Record<string, T>` 這類約束天生會把鍵拓寬成 `string`，用 `satisfies` 才能同時保住「每個值都合格」和「鍵到底有哪些」。**路由表、i18n 語系檔、權限表、選單設定、API endpoint 對照表都是這個形狀。**

**場景 2：值的精確型別後續還要拿來用**

```typescript
type Colors = Record<string, string | [number, number, number]>;

const palette = {
  red: [255, 0, 0],
  green: "#00ff00",
} satisfies Colors;

palette.red.map((n) => n * 2); // ✅ 知道是陣列，能直接用陣列方法
palette.green.toUpperCase();   // ✅ 知道是字串，能直接用字串方法
```

若寫成 `const palette: Colors = {...}`，每個值的型別都會變成 `string | [number, number, number]` 這個聯合，使用前還得先 `typeof` 判斷一輪。字面量的保留也是同理：

```typescript
const config = {
  port: 3000,
  env: "production",
} satisfies { port: number; env: "development" | "production" };

if (config.env === "production") {
  // ✅ env 的型別是 "production" 字面量，縮窄有效
}
```

**場景 3：搭配 `as const`**

```typescript
const ROLES = ["admin", "user"] as const satisfies readonly string[];
type Role = (typeof ROLES)[number]; // "admin" | "user"
```

`as const` 負責凍結成字面量，`satisfies` 負責驗證形狀，兩者常一起出現。

**判斷準則**

- 這個值之後只當「某個型別」用，不在乎具體內容 → 用 `: T` 標註就好
- **這個值本身的內容還要拿來推導**（`keyof typeof`、型別縮窄、取字面量）→ 用 `satisfies`
- 想用 `as T` 繞過檢查時 → 先想想是不是該用 `satisfies`，多數情況它才是你真正要的

---

## 7.2 交集型別（Intersection Types）

```typescript
type WithId = { id: number };
type WithTimestamp = { createdAt: Date; updatedAt: Date };
type WithSoftDelete = { deletedAt: Date | null };

// 組合多個型別
type BaseEntity = WithId & WithTimestamp & WithSoftDelete;

type User = BaseEntity & {
  name: string;
  email: string;
};

// 函式組合
type Loggable = {
  log(): void;
};

type Serializable = {
  serialize(): string;
};

type LoggableAndSerializable = Loggable & Serializable;
```

---

## 7.3 型別縮窄（Type Narrowing）

### typeof Guard

```typescript
function padLeft(value: string, padding: string | number): string {
  if (typeof padding === "number") {
    return " ".repeat(padding) + value;
  }
  return padding + value;
}
```

### instanceof Guard

```typescript
class ApiError {
  constructor(public statusCode: number, public message: string) {}
}

class NetworkError {
  constructor(public message: string) {}
}

function handleError(error: ApiError | NetworkError): string {
  if (error instanceof ApiError) {
    // 縮窄成 ApiError，才存取得到只有它才有的 statusCode
    return `API Error ${error.statusCode}: ${error.message}`;
  }
  // 走到這裡 error 已自動縮窄成 NetworkError
  return `Network Error: ${error.message}`;
}
```

`error` 進來時的型別是 `ApiError | NetworkError`，經過 `instanceof ApiError` 判斷後，TypeScript 就知道 `if` 區塊內一定是 `ApiError`，因此允許存取只有它才有的 `statusCode`；`if` 之外則自動縮窄成 `NetworkError`。

#### 順帶一提：建構子參數的 `public` 是什麼？

上面 `constructor(public statusCode: number, ...)` 的 `public` 跟 `instanceof` 無關，它是 [第 5 章](./05-classes.md)介紹過的**參數屬性（Parameter Properties）** 語法糖，這裡只是用它把類別定義壓成一行。加了存取修飾符後，TypeScript 會**自動建立同名的類別屬性並在建構子裡指派**，所以這兩段完全等價：

```typescript
// 簡寫（參數屬性）
class ApiError {
  constructor(public statusCode: number, public message: string) {}
}

// 完整寫法 —— 上面那段實際上等於這段
class ApiError {
  public statusCode: number; // 1. 宣告欄位
  public message: string;

  constructor(statusCode: number, message: string) {
    // 2. 接收參數
    this.statusCode = statusCode; // 3. 手動指派
    this.message = message;
  }
}
```

省掉的就是「同一個名字要寫三次」的重複。**注意修飾符不是可有可無的裝飾，它就是「請幫我建立這個屬性」的開關** —— 看編譯出來的 JS 最清楚：

```javascript
// class ApiError { constructor(public statusCode: number, ...) {} } 編譯後
class ApiError {
    statusCode;
    message;
    constructor(statusCode, message) {
        this.statusCode = statusCode;   // ← TypeScript 自動補上的
        this.message = message;
    }
}

// 若把修飾符拿掉：constructor(statusCode: number, ...) {}
class NoModifier {
    constructor(statusCode, message) { }   // ← 什麼都沒有，屬性根本沒建立
}
```

沒寫修飾符的話，`statusCode` 只是個用完就丟的普通參數，之後寫 `error.statusCode` 會直接編譯錯誤。四種修飾符的差別：

| 寫法 | 效果 |
| --- | --- |
| `public x: T` | 建立屬性，外部可讀可寫（`public` 雖是預設值，但參數屬性**一定要明寫**才會生效） |
| `private x: T` | 建立屬性，只有類別內部能存取 |
| `protected x: T` | 建立屬性，類別內部與子類別能存取 |
| `readonly x: T` | 建立屬性，建構後不可修改（可與上面三者組合，如 `public readonly`） |

### in 運算子

```typescript
type Fish = { swim: () => void };
type Bird = { fly: () => void };

function move(animal: Fish | Bird): void {
  if ("swim" in animal) {
    animal.swim();
  } else {
    animal.fly();
  }
}
```

### 自定義型別守衛（Type Predicates）

```typescript
interface Cat {
  type: "cat";
  meow(): void;
}

interface Dog {
  type: "dog";
  bark(): void;
}

// 自定義型別守衛
function isCat(animal: Cat | Dog): animal is Cat {
  return animal.type === "cat";
}

function handleAnimal(animal: Cat | Dog): void {
  if (isCat(animal)) {
    animal.meow(); // TypeScript 知道這是 Cat
  } else {
    animal.bark(); // TypeScript 知道這是 Dog
  }
}
```

#### `animal is Cat` 的 `is` 到底做了什麼？

這叫**型別謂詞（Type Predicate）**，TypeScript 1.6 就有的老語法。它要解決的問題是：**光是回傳 `boolean` 的函式，TypeScript 不會拿來做型別縮窄。**

```typescript
// 回傳型別寫成 boolean
function isCatPlain(animal: Cat | Dog): boolean {
  return animal.type === "cat";
}

function useA(animal: Cat | Dog) {
  if (isCatPlain(animal)) {
    animal.meow();
    // ❌ Property 'meow' does not exist on type 'Cat | Dog'.
    //      Property 'meow' does not exist on type 'Dog'.
  }
}
```

從編譯器的角度，`isCatPlain` 只是「一個回傳 true/false 的函式」，它不知道那個 `true` 代表什麼意思。把回傳型別改成 `animal is Cat`，等於明確告訴編譯器：**「這個函式回傳 `true` 時，請把參數 `animal` 縮窄成 `Cat`」**。

所以 `is` 的價值是**把縮窄邏輯抽成可重複使用的函式** —— 否則每個用到的地方都得原地重寫一次 `if (animal.type === "cat")`。

**⚠️ 重點陷阱：TypeScript 不會驗證你的謂詞寫得對不對**

```typescript
function isCatWrong(animal: Cat | Dog): animal is Cat {
  return animal.type === "dog"; // ⚠️ 邏輯整個相反，但編譯器完全不報錯
}
```

`animal is Cat` 是**你對編譯器的單方面承諾**，編譯器選擇相信你、不去檢查函式本體。承諾寫錯的話型別系統會跟著錯下去，最後在執行期爆炸 —— 這一點的風險性質跟 `as` 斷言相同。**寫型別守衛時，函式本體的邏輯要自己看仔細。**

**TS 5.5+：很多情況已經不用手寫了**

從 TypeScript 5.5 起，函式夠簡單時**不寫 `is` 也會自動推斷出型別謂詞**：

```typescript
// 沒有標註回傳型別
function isCatInferred(animal: Cat | Dog) {
  return animal.type === "cat";
}

function useB(animal: Cat | Dog) {
  if (isCatInferred(animal)) {
    animal.meow(); // ✅ 通過，TS 自動推斷成 animal is Cat
  }
}
```

最有感的是 `filter`，這是以前每個人都會撞到的痛點：

```typescript
const names: (string | null)[] = ["a", null, "b"];
const filtered = names.filter((n) => n !== null);

const upper: string[] = filtered; // ✅ TS 5.5+ 直接通過
// TS 5.4 以前 filtered 的型別是 (string | null)[]，這行會報錯，
// 必須手動寫成 names.filter((n): n is string => n !== null)
```

**那什麼時候還是要手寫？** 自動推斷只在函式簡單、能直接從回傳運算式推導時生效。邏輯複雜、跨多個條件、或要處理 `unknown`（例如驗證 API 回傳的資料）時，仍然得自己標註。

### Assertion Functions

```typescript
function assertIsString(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new Error("Expected string");
  }
}

function processInput(input: unknown): string {
  assertIsString(input);
  // 這之後 input 的型別是 string
  return input.toUpperCase();
}
```

`asserts value is string` 跟上一節的 `value is string` 長得很像，但用法完全不同：

| | 型別謂詞 `value is T` | 斷言函式 `asserts value is T` |
| --- | --- | --- |
| 函式回傳 | `boolean` | 不回傳值，不符合就 `throw` |
| 呼叫方式 | 放在 `if` 條件裡 | 直接呼叫一行，之後型別就變了 |
| 不符合時 | 走 `else` 分支，程式繼續 | 直接中斷程式 |
| 適合的情境 | 兩種情況**都要處理**（分流） | 不符合就是**錯誤**，沒有備案 |

```typescript
// 謂詞：分流，兩邊都有事做
if (isCat(animal)) {
  animal.meow();
} else {
  animal.bark();
}

// 斷言：不是就炸，過了才繼續往下走
assertIsString(input);
return input.toUpperCase();
```

⚠️ 跟型別謂詞一樣，**TypeScript 不會驗證斷言函式的本體邏輯**，寫錯一樣是靜默出錯。此外斷言函式還有一個容易踩到的限制：**它必須是 `function` 宣告，或是有明確型別標註的變數**，否則 TypeScript 會拒絕套用斷言效果：

```typescript
// ❌ 箭頭函式指派給 const，但變數本身沒有型別標註
const assertIsNumber = (value: unknown): asserts value is number => {
  if (typeof value !== "number") throw new Error("Expected number");
};

function useB(input: unknown): number {
  assertIsNumber(input);
  // ❌ TS2775: Assertions require every name in the call target
  //            to be declared with an explicit type annotation.
  return input + 1; // ❌ input 仍然是 unknown
}

// ✅ 解法一：改用 function 宣告（就是本節開頭的寫法）

// ✅ 解法二：把型別標註在變數上
type Asserter = (value: unknown) => asserts value is number;
const assertIsNum: Asserter = (value) => {
  if (typeof value !== "number") throw new Error("Expected number");
};
```

---

## 7.4 條件型別（Conditional Types）

```typescript
// 基本語法：T extends U ? X : Y
type IsString<T> = T extends string ? "yes" : "no";

type A = IsString<string>;  // "yes"
type B = IsString<number>;  // "no"

// 實用範例：提取 Promise 的值型別
type UnwrapPromise<T> = T extends Promise<infer U> ? U : T;

type Result1 = UnwrapPromise<Promise<string>>; // string
type Result2 = UnwrapPromise<Promise<number>>; // number
type Result3 = UnwrapPromise<string>;           // string（不是 Promise 則回傳原型別）

// 遞迴解包巢狀 Promise
type DeepUnwrap<T> = T extends Promise<infer U> ? DeepUnwrap<U> : T;

type Deep = DeepUnwrap<Promise<Promise<Promise<string>>>>; // string
```

### infer 關鍵字

```typescript
// 提取函式回傳型別
type ReturnTypeOf<T> = T extends (...args: any[]) => infer R ? R : never;

type Fn = (x: number) => string;
type Result = ReturnTypeOf<Fn>; // string

// 提取函式參數型別
type ParametersOf<T> = T extends (...args: infer P) => any ? P : never;

type Params = ParametersOf<(a: string, b: number) => void>; // [string, number]

// 提取陣列元素型別
type ElementOf<T> = T extends (infer E)[] ? E : never;

type Item = ElementOf<string[]>; // string
```

### 分佈式條件型別（Distributive Conditional Types）

當條件型別檢查的對象是一個「裸露」的型別參數（naked type parameter），且傳入聯合型別時，TypeScript 會把條件型別分別套用到每個成員上再組合回聯合型別，這稱為分佈式（distributive）；用 `[T] extends [U]` 把 `T` 包進元組，就能關閉分佈行為：

```typescript
// T 是裸露的型別參數 → 對聯合型別會分佈
type ToArray<T> = T extends any ? T[] : never;

type StrOrNumArray = ToArray<string | number>;
// 分佈後等於 ToArray<string> | ToArray<number>，也就是 string[] | number[]
// 而不是 (string | number)[]

// [T] extends [U]：把 T 包進元組，關閉分佈行為
type ToArrayNonDist<T> = [T] extends [any] ? T[] : never;

type CombinedArray = ToArrayNonDist<string | number>;
// (string | number)[]，整個聯合型別被當成單一整體處理

const a: StrOrNumArray = ["x", "y"]; // ✅ 只能是 string[] 或 number[] 其中一種
const b: CombinedArray = ["x", 1];   // ✅ 混合陣列也可以
```

---

## 7.5 映射型別（Mapped Types）

```typescript
// 基本映射型別
type Readonly<T> = {
  readonly [K in keyof T]: T[K];
};

type Optional<T> = {
  [K in keyof T]?: T[K];
};

type Nullable<T> = {
  [K in keyof T]: T[K] | null;
};

// 使用範例
interface User {
  id: number;
  name: string;
  email: string;
}

type ReadonlyUser = Readonly<User>;
// { readonly id: number; readonly name: string; readonly email: string }

type OptionalUser = Optional<User>;
// { id?: number; name?: string; email?: string }
```

除了加上 `readonly` / `?`，也可以在前面加負號 `-` 來**移除**修飾詞：

```typescript
type Mutable<T> = {
  -readonly [K in keyof T]: T[K];
};

type Concrete<T> = {
  [K in keyof T]-?: T[K];
};

interface Point {
  readonly x?: number;
  readonly y?: number;
}

type MutablePoint = Mutable<Point>;   // { x?: number; y?: number }
type ConcretePoint = Concrete<Point>; // { readonly x: number; readonly y: number }

const mp: MutablePoint = {};
mp.x = 10; // ✅ 已移除 readonly，可以修改

const cp: ConcretePoint = { x: 1, y: 2 }; // ✅ 已移除 ?，兩個屬性都必填
```

### 鍵值重新映射（Key Remapping）

```typescript
interface User {
  id: number;
  name: string;
  email: string;
}

// 為所有鍵加上前綴
type Prefixed<T, P extends string> = {
  [K in keyof T as `${P}${Capitalize<string & K>}`]: T[K];
};

type UserEvents = Prefixed<User, "on">;
// { onId: number; onName: string; onEmail: string }

// Getter 型別
type Getters<T> = {
  [K in keyof T as `get${Capitalize<string & K>}`]: () => T[K];
};

type UserGetters = Getters<User>;
// { getId: () => number; getName: () => string; getEmail: () => string }
```

---

## 7.6 模板字面值型別（Template Literal Types）

```typescript
// 基本模板字面值
type Greeting = `Hello, ${string}!`;
let g: Greeting = "Hello, World!"; // ✅
// let bad: Greeting = "Hi, World!"; // ❌

// 組合
type Color = "red" | "green" | "blue";
type Size = "small" | "medium" | "large";
type ColorSize = `${Color}-${Size}`;
// "red-small" | "red-medium" | "red-large" | "green-small" | ...

// CSS 單位
type CSSUnit = "px" | "em" | "rem" | "%";
type CSSValue = `${number}${CSSUnit}`;

const width: CSSValue = "100px"; // ✅
const height: CSSValue = "50%";  // ✅

// 事件名稱
type EventName<T extends string> = `on${Capitalize<T>}`;
type ClickEvent = EventName<"click">; // "onClick"
type ChangeEvent = EventName<"change">; // "onChange"
```

---

## 7.7 內建工具型別（Utility Types）

### 常用工具型別一覽

```typescript
interface User {
  id: number;
  name: string;
  email: string;
  age: number;
  role: "admin" | "user";
}

// Partial<T> — 所有屬性變成可選
type UpdateUser = Partial<User>;

// Required<T> — 所有屬性變成必要
type StrictUser = Required<User>;

// Readonly<T> — 所有屬性變成唯讀
type FrozenUser = Readonly<User>;

// Pick<T, K> — 選取部分屬性
type UserPreview = Pick<User, "id" | "name">;
// { id: number; name: string }

// Omit<T, K> — 排除部分屬性
type UserWithoutId = Omit<User, "id">;
// { name: string; email: string; age: number; role: "admin" | "user" }

// Record<K, V> — 建立鍵值對型別
type UserMap = Record<string, User>;

// Exclude<T, U> — 從聯合型別中排除
type NonAdmin = Exclude<User["role"], "admin">; // "user"

// Extract<T, U> — 從聯合型別中提取
type OnlyAdmin = Extract<User["role"], "admin">; // "admin"

// NonNullable<T> — 排除 null 和 undefined
type MaybeString = string | null | undefined;
type DefiniteString = NonNullable<MaybeString>; // string

// ReturnType<T> — 取得函式回傳型別
function createUser() {
  return { id: 1, name: "Gary" };
}
type UserReturn = ReturnType<typeof createUser>;
// { id: number; name: string }

// Parameters<T> — 取得函式參數型別
type CreateParams = Parameters<typeof createUser>; // []

// Awaited<T> — 攤平 Promise（含巢狀 Promise），取得最終解析出的值型別
interface ApiResponse<T> {
  data: T;
  status: number;
}

async function fetchApi<T>(url: string): Promise<ApiResponse<T>> {
  const response = await fetch(url);
  return response.json();
}

type FetchedUser = Awaited<ReturnType<typeof fetchApi<User>>>;
// { data: User; status: number }
```

> **常見陷阱**：`Omit` 對聯合型別不會逐一分佈處理，而是先取所有成員「共同」的鍵，可能得到出乎意料的結果：
>
> ```typescript
> type A = { kind: "a"; x: number };
> type B = { kind: "b"; y: number };
> type Both = A | B;
>
> type BadOmit = Omit<Both, "kind">;
> // 預期可能是 { x: number } | { y: number }
> // 但 keyof (A | B) 只會取兩者共同的鍵（也就是只有 "kind"），
> // 排除 "kind" 之後剩下的鍵是 never，結果 BadOmit 實際上是 {}，
> // x、y 兩個屬性都在型別上直接消失了
>
> const bad: BadOmit = {}; // ✅ 型別上完全合法，但已經失去 x / y 的資訊
> ```

### 組合工具型別

```typescript
// 實用組合：建立 DTO
interface User {
  id: number;
  name: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
}

// 建立用 DTO
type CreateUserDto = Pick<User, "name" | "email"> & { password: string };

// 更新用 DTO（部分可選）
type UpdateUserDto = Partial<Pick<User, "name" | "email">>;

// 回傳用 DTO（排除敏感資料）
type UserResponse = Omit<User, "passwordHash">;

// 列表用 DTO
type UserListItem = Pick<User, "id" | "name" | "email">;
```

---

## 7.8 自定義工具型別

```typescript
// DeepReadonly — 深層唯讀
type DeepReadonly<T> = {
  readonly [K in keyof T]: T[K] extends object ? DeepReadonly<T[K]> : T[K];
};

// DeepPartial — 深層可選
type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

// RequireAtLeastOne — 至少需要一個屬性
type RequireAtLeastOne<T, Keys extends keyof T = keyof T> = Pick<
  T,
  Exclude<keyof T, Keys>
> &
  {
    [K in Keys]-?: Required<Pick<T, K>> & Partial<Pick<T, Exclude<Keys, K>>>;
  }[Keys];

// 實際使用
interface SearchParams {
  name?: string;
  email?: string;
  id?: number;
}

type ValidSearch = RequireAtLeastOne<SearchParams>;
// 至少要提供 name、email、id 的其中一個
```

---

## 練習題

### 練習 1：條件型別

實作一個 `Flatten<T>` 型別，將巢狀陣列型別展平：

```typescript
type Flatten<T> = ???;

type A = Flatten<number[]>;    // number
type B = Flatten<string[][]>;  // string[]
type C = Flatten<string>;      // string
```

<details>
<summary>參考解答</summary>

用條件型別搭配 `infer` 把陣列的元素型別「抓」出來：`T extends (infer E)[]` 成立時 `E` 就是元素型別，回傳 `E`；不是陣列則原樣回傳 `T`。

```typescript
type Flatten<T> = T extends (infer E)[] ? E : T;

type A = Flatten<number[]>;   // number
type B = Flatten<string[][]>; // string[]（把外層陣列脫掉一層，剩下 string[]）
type C = Flatten<string>;     // string（不是陣列，原樣回傳）
```

重點提醒：這個版本只會脫掉「一層」陣列，所以 `Flatten<string[][]>` 得到的是 `string[]` 而不是 `string`。若想遞迴展平到最底層，把回傳分支改成遞迴呼叫即可：`type DeepFlatten<T> = T extends (infer E)[] ? DeepFlatten<E> : T;`。

</details>

### 練習 2：映射型別

建立一個 `Mutable<T>` 型別，將所有 readonly 屬性變成可修改的：

```typescript
type Mutable<T> = ???;
```

<details>
<summary>參考解答</summary>

映射型別的修飾詞前面加負號 `-` 可以「移除」修飾詞。要拿掉 `readonly`，就在 `readonly` 前加 `-`：

```typescript
type Mutable<T> = {
  -readonly [K in keyof T]: T[K];
};

interface Config {
  readonly host: string;
  readonly port: number;
}

type MutableConfig = Mutable<Config>;
// { host: string; port: number }（readonly 已移除）

const cfg: MutableConfig = { host: "localhost", port: 8080 };
cfg.host = "127.0.0.1"; // ✅ 已移除 readonly，可以重新賦值
```

重點提醒：`-readonly` 與 `-?`（移除可選）是映射型別特有的修飾詞語法；不加正負號（單純 `readonly` / `?`）代表「加上」，加負號才是「移除」。內建的 `Readonly<T>` 是加上唯讀，本題的 `Mutable<T>` 剛好相反。

</details>

### 練習 3：工具型別組合

設計一個表單驗證的型別系統：

```typescript
interface FormField<T> {
  value: T;
  error: string | null;
  touched: boolean;
}

// 建立 FormState<T>，將 T 的每個屬性轉換為 FormField
type FormState<T> = ???;
```

<details>
<summary>參考解答</summary>

用映射型別走訪 `T` 的每個鍵 `K`，把原本的值型別 `T[K]` 包進 `FormField<T[K]>`：

```typescript
interface FormField<T> {
  value: T;
  error: string | null;
  touched: boolean;
}

type FormState<T> = {
  [K in keyof T]: FormField<T[K]>;
};

// 使用範例
interface LoginForm {
  username: string;
  password: string;
  remember: boolean;
}

type LoginFormState = FormState<LoginForm>;
// {
//   username: FormField<string>;
//   password: FormField<string>;
//   remember: FormField<boolean>;
// }

const state: LoginFormState = {
  username: { value: "gary", error: null, touched: true },
  password: { value: "", error: "必填", touched: false },
  remember: { value: true, error: null, touched: false },
};
```

重點提醒：關鍵在於 `FormField<T[K]>` 會把「每個欄位各自的型別」帶進 `value`，所以 `username.value` 是 `string`、`remember.value` 是 `boolean`，型別不會被混在一起。這正是映射型別最常見的實務用途之一：把一組資料欄位整批「包裝」成帶有額外中繼資訊（error、touched）的結構。

</details>

---

> 下一章：[第八章 — 模組系統與命名空間](./08-modules.md)
