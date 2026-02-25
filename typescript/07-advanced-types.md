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
  }
}
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

### 鍵值重新映射（Key Remapping）

```typescript
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
```

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

### 練習 2：映射型別

建立一個 `Mutable<T>` 型別，將所有 readonly 屬性變成可修改的：

```typescript
type Mutable<T> = ???;
```

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

---

> 下一章：[第八章 — 模組系統與命名空間](./08-modules.md)
