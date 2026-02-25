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

```typescript
// 多載簽名
function parse(value: string): number;
function parse(value: number): string;
// 實作簽名
function parse(value: string | number): number | string {
  if (typeof value === "string") {
    return parseInt(value, 10);
  }
  return value.toString();
}

const num = parse("42");   // 型別為 number
const str = parse(42);     // 型別為 string

// 實際應用：DOM querySelector
function querySelector(selector: "#app"): HTMLDivElement;
function querySelector(selector: "input"): HTMLInputElement;
function querySelector(selector: string): HTMLElement;
function querySelector(selector: string): HTMLElement {
  return document.querySelector(selector)!;
}
```

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
    callback(error as Error);
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

```typescript
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

### 練習 2：函式多載

寫一個多載函式 `convert`：
- 接收 `string` 回傳 `number`
- 接收 `number` 回傳 `string`

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

---

> 下一章：[第四章 — 介面與型別別名](./04-interfaces-type-aliases.md)
