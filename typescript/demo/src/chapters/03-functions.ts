// 第三章：函式與型別 — 範例整合檔
//
// 每一個獨立範例都各自包在一個 { ... } 區塊內，
// 利用區塊作用域避免同名 let/const/type/interface/function 互相衝突。
// 需要用到前面定義的型別時，直接把定義整段複製進該區塊，讓每塊自成一體。

// ===== 3.1 函式型別標註 =====

// --- 參數與回傳值型別 ---
{
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
}

// --- 函式型別表達式 ---
{
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
}

// ===== 3.2 可選參數與預設值 =====

// --- 可選參數 ---
{
  // 可選參數用 ? 標記，必須放在必要參數後面
  function greet(name: string, title?: string): string {
    if (title) {
      return `Hello, ${title} ${name}!`;
    }
    return `Hello, ${name}!`;
  }

  greet("Gary");           // "Hello, Gary!"
  greet("Gary", "Mr.");    // "Hello, Mr. Gary!"
}

// --- 預設值 ---
{
  // 有預設值的參數自動成為可選
  function createUser(name: string, role: string = "user"): object {
    return { name, role };
  }

  createUser("Gary");           // { name: "Gary", role: "user" }
  createUser("Gary", "admin");  // { name: "Gary", role: "admin" }
}

// --- NoInfer<T>（TypeScript 5.4+） ---
{
  type Status = "active" | "inactive" | "suspended";

  // 沒有 NoInfer：T 同時由 value 與 fallback 推斷
  function setDefaultLoose<T>(value: T, fallback: T): T {
    return value ?? fallback;
  }

  const currentStatus: Status = "active";
  const loose = setDefaultLoose(currentStatus, "not-a-status"); // ⚠️ 不會報錯！T 被拓寬成 "active" | "not-a-status"

  // 使用 NoInfer：fallback 不參與型別推斷，只能是 value 推斷出的型別
  function setDefault<T>(value: T, fallback: NoInfer<T>): T {
    return value ?? fallback;
  }

  const strict = setDefault(currentStatus, "active"); // ✅ OK
  // setDefault(currentStatus, "not-a-status"); // ❌ 正確報錯：不是合法的 Status

  console.log(loose, strict);
}

// ===== 3.3 剩餘參數（Rest Parameters）=====
{
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
}

// ===== 3.4 函式多載（Function Overloads）=====
// 當函式根據不同的輸入型別需要不同的回傳型別時，使用函式多載。
{
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
    // 用到 document 的實際執行敘述，包在 typeof 檢查內（Node 環境沒有 document）
    if (typeof document !== "undefined") {
      // 用泛型指定回傳為 HTMLElement，避免 Element 不可指派給 HTMLElement 的錯誤
      return document.querySelector<HTMLElement>(selector)!;
    }
    throw new Error("document is not available");
  }
}

// --- 箭頭函式版本的多載：改用多個呼叫簽名的 interface ---
{
  // function 宣告可以疊加多個多載簽名；賦值給變數的箭頭函式做不到，
  // 需改用具有多個呼叫簽名的 interface（或 type）來達到同樣效果。
  interface Parse {
    (value: string): number;
    (value: number): string;
  }

  const parse: Parse = ((value: string | number) => {
    if (typeof value === "string") {
      return parseInt(value, 10);
    }
    return value.toString();
  }) as Parse;

  console.log(parse("42"), parse(42));
}

// ===== 3.5 回呼函式（Callback）型別 =====
{
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
}

// ===== 3.6 this 的型別 =====
{
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
}

// ===== 3.7 泛型函式（預覽）=====
// 泛型將在第六章深入說明，這裡先預覽基本用法。
{
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
}

// ===== 3.8 常見的函式型別模式 =====

// --- Promise 回傳型別 ---
{
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

  void safeGetUser;
}

// --- 解構參數型別 ---
{
  // 參數解構
  function createUser({ name, age, email }: { name: string; age: number; email: string }) {
    return { id: Date.now(), name, age, email };
  }

  void createUser;
}
{
  // 更好的寫法 — 搭配 interface
  interface CreateUserParams {
    name: string;
    age: number;
    email: string;
  }

  function createUser({ name, age, email }: CreateUserParams) {
    return { id: Date.now(), name, age, email };
  }

  void createUser;
}

// --- 函式作為物件屬性 ---
{
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

  void calc;
}

// ===== 練習題 =====

// --- 練習 1：基本函式 ---
// 接收金額（number）和貨幣代碼（可選，預設 "TWD"），回傳格式化字串。
{
  // 練習參考解答
  function formatCurrency(amount: number, currency: string = "TWD"): string {
    return `${currency} ${amount.toLocaleString("en-US")}`;
  }

  console.log(formatCurrency(1000));        // "TWD 1,000"
  console.log(formatCurrency(1000, "USD")); // "USD 1,000"
}

// --- 練習 2：函式多載 ---
// 接收 string 回傳 number；接收 number 回傳 string。
{
  // 練習參考解答
  function convert(value: string): number;
  function convert(value: number): string;
  function convert(value: string | number): number | string {
    if (typeof value === "string") {
      return parseInt(value, 10);
    }
    return value.toString();
  }

  const n: number = convert("42"); // number
  const s: string = convert(42);   // string
  console.log(n, s);
}

// --- 練習 3：回呼函式（自動重試）---
// 接收一個非同步操作和重試次數，在失敗時自動重試。
{
  // 練習參考解答
  async function retry<T>(
    operation: () => Promise<T>,
    maxRetries: number,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  void retry;
}

console.log("第 3 章 函式與型別 範例載入完成 ✅");

export {};
