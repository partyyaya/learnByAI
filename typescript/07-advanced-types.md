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
    return `API Error ${error.statusCode}: ${error.message}`;
  }
  return `Network Error: ${error.message}`;
}
```

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
