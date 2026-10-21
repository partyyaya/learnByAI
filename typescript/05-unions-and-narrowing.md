# 第五章：聯合型別與型別縮窄

前四章已經零星用過 `string | number`、`unknown` 搭配 `typeof` 判斷、`"active" | "inactive"` 這類字面值聯合。本章把它們收攏成一套完整的工具：**聯合型別描述「可能是這幾種之一」，型別縮窄則讓你在程式裡一步步確認「現在到底是哪一種」**。

這是日常寫 TypeScript 最常用到的能力之一，後面的類別（`instanceof` 縮窄）、泛型（Result 模式靠判別式聯合運作）、錯誤處理與 API 回應設計都建立在它上面，所以放在核心篇先學。

> 📌 「同時具備 A 和 B」的交集型別 `A & B` 已在 [第 4 章 4.3](./04-interfaces-type-aliases.md) 介紹；本章專注在「A 或 B」的聯合型別。

---

## 5.1 聯合型別（Union Types）

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

第二行 `(typeof ROLES)[number]` 是「**把常數陣列轉成聯合型別**」的慣用寫法：`typeof ROLES` 取出 `ROLES` 這個值的型別（`readonly ["admin", "user"]`），再用 `[number]` 取出「任意索引位置的元素型別」，也就是所有元素的聯合。基礎說明見第 2 章 2.8〈typeof 型別查詢〉，`keyof` / `T[K]` 的完整說明見第 7 章 7.3，逐步拆解見第 8 章 8.3 末尾。

**判斷準則**

- 這個值之後只當「某個型別」用，不在乎具體內容 → 用 `: T` 標註就好
- **這個值本身的內容還要拿來推導**（`keyof typeof`、型別縮窄、取字面量）→ 用 `satisfies`
- 想用 `as T` 繞過檢查時 → 先想想是不是該用 `satisfies`，多數情況它才是你真正要的

---

## 5.2 型別縮窄（Type Narrowing）

拿到一個聯合型別的值時，TypeScript 只允許你使用「所有成員都有」的操作。**型別縮窄**是指：透過 `if`、`switch` 等執行期檢查，讓 TypeScript 在某個區塊內把型別收窄成其中一個成員。下面是常見的幾種縮窄方式。

### typeof Guard

```typescript
function padLeft(value: string, padding: string | number): string {
  if (typeof padding === "number") {
    return " ".repeat(padding) + value;
  }
  return padding + value;
}
```

### 真值與相等性縮窄

最常見的聯合其實是 `T | null` / `T | undefined`。直接用 `if (x)`、`x !== null` 或 `===` 比較字面值，TypeScript 都會跟著縮窄：

```typescript
function greet(name: string | null | undefined): string {
  if (!name) {
    return "Hi, guest"; // name 是 null | undefined | ""
  }
  return `Hi, ${name.toUpperCase()}`; // ✅ 這裡 name 已縮窄成 string
}

function describe(status: "loading" | "success" | "error"): string {
  if (status === "loading") {
    return "載入中…"; // status 是 "loading"
  }
  return status; // status 是 "success" | "error"
}
```

> ⚠️ `if (!x)` 會把 `0`、`""`、`false` 也當成「沒有值」。如果 `0` 或空字串是合法值，改用 `x == null`（同時排除 `null` 與 `undefined`）或 `??` 運算子。

前面 5.1 用 `switch (shape.kind)` 處理判別式聯合，就是相等性縮窄的應用。

### instanceof Guard

```typescript
class ApiError {
  statusCode: number;
  message: string;

  constructor(statusCode: number, message: string) {
    this.statusCode = statusCode;
    this.message = message;
  }
}

class NetworkError {
  message: string;

  constructor(message: string) {
    this.message = message;
  }
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

`instanceof` 是 JavaScript 本來就有的執行期檢查，只要右邊是一個類別（建構函式）就能用來縮窄。類別本身的 TypeScript 寫法（存取修飾符、參數屬性、繼承等）見 [第 6 章](./06-classes.md)。

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

## 練習題

### 練習 1：判別式聯合與窮盡性檢查

為下面的付款方式寫出 `describePayment`，並加上窮盡性檢查，讓未來新增付款方式卻忘了處理時會在編譯期報錯：

```typescript
type Payment =
  | { method: "card"; last4: string }
  | { method: "transfer"; bankCode: string; account: string }
  | { method: "cash" };

function describePayment(payment: Payment): string {
  // ???
}
```

<details>
<summary>參考解答</summary>

用 `switch (payment.method)` 依標籤欄位分流，每個 `case` 裡 TypeScript 都會縮窄成對應的成員；`default` 分支把剩下的值指派給 `never`：

```typescript
function describePayment(payment: Payment): string {
  switch (payment.method) {
    case "card":
      return `信用卡末四碼 ${payment.last4}`;
    case "transfer":
      return `轉帳 ${payment.bankCode}-${payment.account}`;
    case "cash":
      return "現金";
    default: {
      const _exhaustive: never = payment;
      throw new Error(`Unhandled payment: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
```

重點提醒：在 `case "card"` 以外的分支存取 `payment.last4` 會報錯，這就是判別式聯合的價值。之後在 `Payment` 加上 `{ method: "linepay"; ... }`，`default` 裡的 `payment` 就不再是 `never`，編譯器會立刻指出漏處理的地方。

</details>

### 練習 2：型別守衛驗證 API 資料

`fetch` 回來的 JSON 型別是 `unknown`（或 `any`）。寫一個型別守衛 `isUser`，讓下面的程式通過型別檢查：

```typescript
interface User {
  id: number;
  name: string;
}

function isUser(value: unknown): value is User {
  // ???
}

const data: unknown = JSON.parse('{"id":1,"name":"Gary"}');
if (isUser(data)) {
  console.log(data.name.toUpperCase());
}
```

<details>
<summary>參考解答</summary>

先排除非物件與 `null`，再用 `in` 確認欄位存在，最後用 `typeof` 檢查欄位型別：

```typescript
function isUser(value: unknown): value is User {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    "name" in value &&
    typeof value.id === "number" &&
    typeof value.name === "string"
  );
}
```

重點提醒：`typeof value === "object"` 對 `null` 也會回傳 `true`，所以 `value !== null` 不能省。TypeScript 4.9 起，`"id" in value` 之後就能直接存取 `value.id`。欄位一多，手寫守衛很容易漏，實務上會改用 Zod 這類驗證函式庫（見第 11 章 11.9）。

</details>

### 練習 3：用 satisfies 定義設定表

定義一組 HTTP 狀態訊息表，要求：每個值都必須是 `{ message: string; retry: boolean }`，而且 `StatusKey` 要能推導出 `"ok" | "notFound" | "serverError"`。

```typescript
type StatusInfo = { message: string; retry: boolean };

const STATUS = {
  ok: { message: "成功", retry: false },
  notFound: { message: "找不到資源", retry: false },
  serverError: { message: "伺服器錯誤", retry: true },
} /* ??? */;

type StatusKey = /* ??? */;
```

<details>
<summary>參考解答</summary>

```typescript
const STATUS = {
  ok: { message: "成功", retry: false },
  notFound: { message: "找不到資源", retry: false },
  serverError: { message: "伺服器錯誤", retry: true },
} satisfies Record<string, StatusInfo>;

type StatusKey = keyof typeof STATUS; // "ok" | "notFound" | "serverError"
```

重點提醒：如果改寫成 `const STATUS: Record<string, StatusInfo> = { ... }`，`keyof typeof STATUS` 會變成 `string`，鍵名資訊就丟了。`satisfies` 同時保住「每個值都合格」和「到底有哪些鍵」。

</details>

---

> 下一章：[第六章 — 類別與物件導向程式設計](./06-classes.md)

