# 第五章：類別與物件導向程式設計

## 5.1 類別基礎

### 定義類別

```typescript
class User {
  // 屬性宣告
  name: string;
  email: string;
  age: number;

  // 建構子
  constructor(name: string, email: string, age: number) {
    this.name = name;
    this.email = email;
    this.age = age;
  }

  // 方法
  greet(): string {
    return `Hi, I'm ${this.name}!`;
  }
}

const user = new User("Gary", "gary@example.com", 30);
console.log(user.greet()); // "Hi, I'm Gary!"
```

### 簡化寫法：參數屬性（Parameter Properties）

```typescript
class User {
  // 在建構子參數加上存取修飾符，自動建立並指派屬性
  constructor(
    public name: string,
    public email: string,
    public age: number,
  ) {}

  greet(): string {
    return `Hi, I'm ${this.name}!`;
  }
}
```

同樣的語法也可以加上 `readonly`，鎖定參數屬性建構後不可修改；另外，類別欄位若賦值為箭頭函式，`this` 在定義當下就會綁定為目前實例，很適合當回呼傳遞：

```typescript
class Point {
  constructor(
    public readonly x: number,
    public readonly y: number,
  ) {}
}

const point = new Point(1, 2);
// point.x = 10; // ❌ readonly 參數屬性，編譯期禁止賦值

class Button {
  constructor(private label: string) {}

  // 箭頭函式類別欄位：this 在定義時就綁定為目前實例，
  // 適合當回呼傳遞（例如 addEventListener("click", button.onClick)）而不怕 this 跑掉
  onClick = () => {
    console.log(`${this.label} clicked`);
  };
}

const button = new Button("Submit");
const handler = button.onClick;
handler(); // "Submit clicked"
```

---

## 5.2 存取修飾符（Access Modifiers）

| 修飾符 | 類別內部 | 子類別 | 類別外部 |
|--------|---------|--------|---------|
| `public` | ✅ | ✅ | ✅ |
| `protected` | ✅ | ✅ | ❌ |
| `private` | ✅ | ❌ | ❌ |

```typescript
class BankAccount {
  public ownerName: string;      // 任何地方都可存取
  protected accountType: string; // 只有類別內部和子類別可存取
  private balance: number;       // 只有類別內部可存取

  constructor(owner: string, type: string, initialBalance: number) {
    this.ownerName = owner;
    this.accountType = type;
    this.balance = initialBalance;
  }

  public deposit(amount: number): void {
    this.balance += amount;
  }

  public getBalance(): number {
    return this.balance;
  }

  private logTransaction(type: string, amount: number): void {
    console.log(`[${type}] ${amount} — Balance: ${this.balance}`);
  }
}

const account = new BankAccount("Gary", "savings", 1000);
account.ownerName;     // ✅ public
// account.accountType; // ❌ protected
// account.balance;     // ❌ private
```

### ES2022 私有欄位

```typescript
class Counter {
  #count = 0; // JavaScript 原生私有欄位

  increment(): void {
    this.#count++;
  }

  getCount(): number {
    return this.#count;
  }
}

const counter = new Counter();
// counter.#count; // ❌ 語法層面的私有，無法存取
```

> **`#field` vs `private` 的差異**：`#count` 是 JavaScript 執行期真正封裝的私有欄位——外部無法透過 `obj["#count"]` 或 `JSON.stringify(obj)` 存取到它，甚至能用 `#count in obj` 做「品牌檢查」（brand check）判斷物件是否為同一類別的實例；`private` 則只是 TypeScript 型別層級的檢查，編譯後會被抹除，執行期仍可透過 `obj["balance"]` 或 `JSON.stringify(obj)` 看到該欄位，只是在「型別」上被擋下來而已。

---

## 5.3 繼承（Inheritance）

```typescript
class Animal {
  constructor(
    public name: string,
    protected sound: string,
  ) {}

  makeSound(): string {
    return `${this.name} says ${this.sound}!`;
  }
}

class Dog extends Animal {
  constructor(name: string) {
    super(name, "Woof"); // 呼叫父類別建構子
  }

  fetch(item: string): string {
    return `${this.name} fetches the ${item}!`;
  }
}

class Cat extends Animal {
  constructor(name: string) {
    super(name, "Meow");
  }

  purr(): string {
    return `${this.name} is purring...`;
  }
}

const dog = new Dog("Buddy");
console.log(dog.makeSound()); // "Buddy says Woof!"
console.log(dog.fetch("ball")); // "Buddy fetches the ball!"

const cat = new Cat("Whiskers");
console.log(cat.makeSound()); // "Whiskers says Meow!"
console.log(cat.purr());      // "Whiskers is purring..."
```

### override 關鍵字（TS 4.3+）

上面的 Dog、Cat 只是「新增」方法，並沒有覆寫父類別已存在的具體方法。若子類別要覆寫父類別的**具體**（非 abstract）方法，建議加上 `override` 關鍵字：

```typescript
class Employee {
  constructor(protected name: string) {}

  describe(): string {
    return `${this.name} is an employee`;
  }
}

class Manager extends Employee {
  constructor(
    name: string,
    private teamSize: number,
  ) {
    super(name);
  }

  // override 明確標示：這是覆寫父類別的具體方法（非抽象）
  override describe(): string {
    return `${this.name} manages a team of ${this.teamSize}`;
  }
}

const manager = new Manager("Alice", 5);
console.log(manager.describe()); // "Alice manages a team of 5"
```

建議在 `tsconfig.json` 開啟 `"noImplicitOverride": true`：只要子類別覆寫了父類別方法卻忘記加 `override`，編譯器就會報錯。這樣一來，未來若父類別的方法被改名或移除，子類別裡「原本想覆寫」的方法就不會悄悄變成一個沒人呼叫的全新方法，而是立刻在編譯期被抓出來。

---

## 5.4 抽象類別（Abstract Classes）

抽象類別不能被實例化，只能被繼承。用來定義子類別必須實作的方法。

```typescript
abstract class Shape {
  abstract area(): number;       // 子類別必須實作
  abstract perimeter(): number;  // 子類別必須實作

  // 可以有具體的方法
  describe(): string {
    return `Area: ${this.area()}, Perimeter: ${this.perimeter()}`;
  }
}

class Circle extends Shape {
  constructor(private radius: number) {
    super();
  }

  area(): number {
    return Math.PI * this.radius ** 2;
  }

  perimeter(): number {
    return 2 * Math.PI * this.radius;
  }
}

class Rectangle extends Shape {
  constructor(
    private width: number,
    private height: number,
  ) {
    super();
  }

  area(): number {
    return this.width * this.height;
  }

  perimeter(): number {
    return 2 * (this.width + this.height);
  }
}

// const shape = new Shape(); // ❌ 無法實例化抽象類別
const circle = new Circle(5);
console.log(circle.describe()); // "Area: 78.54, Perimeter: 31.42"
```

---

## 5.5 介面實作（implements）

```typescript
interface Serializable {
  serialize(): string;
  deserialize(data: string): void;
}

interface Printable {
  print(): void;
}

// 一個類別可以實作多個介面
class Document implements Serializable, Printable {
  constructor(
    public title: string,
    public content: string,
  ) {}

  serialize(): string {
    return JSON.stringify({ title: this.title, content: this.content });
  }

  deserialize(data: string): void {
    const parsed = JSON.parse(data);
    this.title = parsed.title;
    this.content = parsed.content;
  }

  print(): void {
    console.log(`=== ${this.title} ===`);
    console.log(this.content);
  }
}
```

### abstract class vs interface

```typescript
// Interface：定義「契約」，沒有實作
interface Logger {
  log(message: string): void;
  error(message: string): void;
}

// Abstract class：可以有部分實作
abstract class BaseLogger {
  abstract log(message: string): void;

  error(message: string): void {
    this.log(`[ERROR] ${message}`);
  }

  warn(message: string): void {
    this.log(`[WARN] ${message}`);
  }
}

class ConsoleLogger extends BaseLogger {
  log(message: string): void {
    console.log(message);
  }
}
```

---

## 5.6 Getter / Setter

```typescript
class Temperature {
  private _celsius: number;

  constructor(celsius: number) {
    this._celsius = celsius;
  }

  // Getter
  get celsius(): number {
    return this._celsius;
  }

  // Setter（含驗證邏輯）
  set celsius(value: number) {
    if (value < -273.15) {
      throw new Error("Temperature below absolute zero is not possible");
    }
    this._celsius = value;
  }

  // 計算屬性
  get fahrenheit(): number {
    return this._celsius * 1.8 + 32;
  }

  set fahrenheit(value: number) {
    this._celsius = (value - 32) / 1.8;
  }
}

const temp = new Temperature(25);
console.log(temp.celsius);    // 25
console.log(temp.fahrenheit); // 77

temp.fahrenheit = 100;
console.log(temp.celsius);    // 37.78
```

---

## 5.7 靜態成員（Static Members）

```typescript
class MathUtils {
  static readonly PI = 3.14159;

  static add(a: number, b: number): number {
    return a + b;
  }

  static factorial(n: number): number {
    if (n <= 1) return 1;
    return n * MathUtils.factorial(n - 1);
  }
}

// 不需要實例化，直接透過類別呼叫
console.log(MathUtils.PI);          // 3.14159
console.log(MathUtils.add(3, 5));   // 8
console.log(MathUtils.factorial(5)); // 120
```

### Singleton 模式

Singleton（單例）＝ **整個程式生命週期內只允許存在一個實例**，而且大家拿到的都是同一個。

```typescript
class Database {
  private static instance: Database;
  private constructor(private connectionString: string) {}

  static getInstance(): Database {
    if (!Database.instance) {
      Database.instance = new Database("mongodb://localhost:27017");
    }
    return Database.instance;
  }

  query(sql: string): void {
    console.log(`Executing: ${sql}`);
  }
}

const db1 = Database.getInstance();
const db2 = Database.getInstance();
console.log(db1 === db2); // true — 同一個實例
```

#### 三個關鍵機制

| 寫法 | 作用 |
| ---- | ---- |
| `private constructor` | 外部**不能** `new Database()`，唯一入口只剩 `getInstance()` |
| `private static instance` | 實例存在**類別身上**（全域唯一位置），不是掛在某個物件上 |
| `if (!Database.instance)` | 延遲（lazy）建立：第一次被呼叫時才真的連線，沒人用就不浪費資源 |

```typescript
// ❌ private constructor 擋住直接 new
// const db = new Database("mongodb://...");
```

#### 何時會用到？

適用情境有個共同點：**這個資源建立成本高，而且本來就該全系統共用一份**。

- **資料庫 / Redis 連線池** — 每次 `new` 都開一組新連線會直接打爆連線數上限。
- **設定物件（AppConfig）** — 讀 `.env`、解析設定檔只該做一次，之後全程式讀同一份。
- **Logger** — 要共用同一個輸出檔控制代碼、同一組緩衝區。
- **快取 / 全域狀態** — 例如記憶體快取、事件匯流排（EventBus），分散成多份就失去意義了。

反過來說，**每個請求／每個使用者狀態不同**的東西（購物車、request context）就絕不該做成 Singleton —— 資料會互相污染。

#### 陷阱：這個範例的連線字串寫死了

上面的 `getInstance()` 把 `"mongodb://localhost:27017"` 寫死在裡面，實務上設定要從外部來。常見解法是**兩段式初始化**：

```typescript
class Database {
  private static instance: Database | null = null;
  private constructor(private connectionString: string) {}

  // 進入點（例如 main.ts）啟動時呼叫一次
  static init(connectionString: string): Database {
    if (Database.instance) {
      throw new Error("Database 已經初始化過了");
    }
    Database.instance = new Database(connectionString);
    return Database.instance;
  }

  // 之後任何地方取用
  static getInstance(): Database {
    if (!Database.instance) {
      throw new Error("請先呼叫 Database.init()");
    }
    return Database.instance;
  }

  // 測試用：讓每個測試案例回到乾淨狀態
  static reset(): void {
    Database.instance = null;
  }
}

Database.init(process.env.DB_URL ?? "mongodb://localhost:27017");
Database.getInstance().query("SELECT 1");
```

#### 其他缺點與現代替代做法

Singleton 是**被討論最多的爭議模式**，主要缺點有二：

1. **難測試** —— 狀態跨測試案例殘留，也不好抽換成 mock（所以上面要補 `reset()`）。
2. **隱藏相依** —— 任何檔案都能 `Database.getInstance()`，相依關係不會出現在建構子簽名上，讀程式時看不出這個 class 用了資料庫。

在 TypeScript / Node.js 實務上，通常有更簡單的做法：

```typescript
// 方案 A：ES module 本身就是單例 —— 模組只會被求值一次，之後 import 都拿快取
// db.ts
export const db = new Database(process.env.DB_URL!);

// 其他檔案
import { db } from "./db";
```

```typescript
// 方案 B：依賴注入（DI）—— 相依關係寫在建構子上，測試時直接傳假的進去
class UserService {
  constructor(private db: Database) {}
}
// NestJS 的 @Injectable() 預設就是 singleton scope，由框架的容器保證唯一
```

> ⚠️ 另外要注意：「唯一」的範圍只在**單一 process 內**。Node.js cluster、PM2 多實例、Serverless 冷啟動各自都有自己的 Singleton，別把它當成跨機器的全域鎖。

### ES2022 static 初始化區塊（`static { }`）

`static { ... }` 讓你在類別內執行任意的靜態初始化邏輯（例如依賴環境變數、計算多個靜態屬性之間的相依順序），比單一運算式更有彈性：

```typescript
class AppConfig {
  static apiUrl: string;
  static isProduction: boolean;

  // ES2022：static 初始化區塊，可以做比單一運算式更複雜的邏輯
  static {
    const env = process.env.NODE_ENV ?? "development";
    this.isProduction = env === "production";
    this.apiUrl = this.isProduction
      ? "https://api.example.com"
      : "http://localhost:3000";
  }
}

console.log(AppConfig.apiUrl, AppConfig.isProduction);
```

---

## 5.8 泛型類別

```typescript
class Stack<T> {
  private items: T[] = [];

  push(item: T): void {
    this.items.push(item);
  }

  pop(): T | undefined {
    return this.items.pop();
  }

  peek(): T | undefined {
    return this.items[this.items.length - 1];
  }

  get size(): number {
    return this.items.length;
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }
}

const numberStack = new Stack<number>();
numberStack.push(1);
numberStack.push(2);
numberStack.push(3);
console.log(numberStack.pop()); // 3

const stringStack = new Stack<string>();
stringStack.push("hello");
stringStack.push("world");
```

---

## 練習題

### 練習 1：基本類別

建立一個 `TodoList` 類別，具備以下功能：
- 新增待辦事項
- 標記完成
- 刪除事項
- 取得所有未完成的事項

<details>
<summary>參考解答</summary>

先用一個 `Todo` 介面描述單筆待辦的結構。類別內部把 `todos` 陣列與自動遞增的 `nextId` 都設為 `private`，避免外部直接亂改；四個功能各對應一個方法，用 `find` / `filter` 操作陣列即可。

```typescript
interface Todo {
  id: number;
  text: string;
  done: boolean;
}

class TodoList {
  private todos: Todo[] = [];
  private nextId = 1;

  // 新增待辦事項
  add(text: string): Todo {
    const todo: Todo = { id: this.nextId++, text, done: false };
    this.todos.push(todo);
    return todo;
  }

  // 標記完成
  complete(id: number): void {
    const todo = this.todos.find((t) => t.id === id);
    if (todo) {
      todo.done = true;
    }
  }

  // 刪除事項
  remove(id: number): void {
    this.todos = this.todos.filter((t) => t.id !== id);
  }

  // 取得所有未完成的事項
  getPending(): Todo[] {
    return this.todos.filter((t) => !t.done);
  }
}

const list = new TodoList();
list.add("Learn TypeScript");
const second = list.add("Write demo");
list.complete(second.id);
console.log(list.getPending()); // 只剩尚未完成的那筆
```

重點：把內部狀態（`todos`、`nextId`）設為 `private`，只透過方法操作，就是封裝的基本精神；`nextId` 由類別自己管理，呼叫端不必也不該傳入 id。

</details>

### 練習 2：繼承與抽象類別

設計一個支付系統的類別體系：

```typescript
abstract class PaymentMethod {
  abstract process(amount: number): Promise<boolean>;
  abstract refund(transactionId: string): Promise<boolean>;
}

// 實作 CreditCard、BankTransfer、LinePay
```

<details>
<summary>參考解答</summary>

`PaymentMethod` 是抽象類別，只規定「所有付款方式都必須有 `process` 與 `refund`」但不提供實作。三個子類別各自 `extends` 它並補上具體邏輯；有需要建構參數的（信用卡卡號、轉帳帳號）就在建構子用參數屬性接收，並記得呼叫 `super()`（原因見下方說明）。最後就能用同一個 `PaymentMethod[]` 型別統一操作，不必在意實際型別——這就是多型。

```typescript
abstract class PaymentMethod {
  abstract process(amount: number): Promise<boolean>;
  abstract refund(transactionId: string): Promise<boolean>;
}

class CreditCard extends PaymentMethod {
  constructor(private cardNumber: string) {
    super();
  }

  async process(amount: number): Promise<boolean> {
    console.log(`CreditCard 付款 ${amount}（卡號末四碼 ${this.cardNumber.slice(-4)}）`);
    return true;
  }

  async refund(transactionId: string): Promise<boolean> {
    console.log(`CreditCard 退款 ${transactionId}`);
    return true;
  }
}

class BankTransfer extends PaymentMethod {
  constructor(private account: string) {
    super();
  }

  async process(amount: number): Promise<boolean> {
    console.log(`BankTransfer 付款 ${amount} 到 ${this.account}`);
    return true;
  }

  async refund(transactionId: string): Promise<boolean> {
    console.log(`BankTransfer 退款 ${transactionId}`);
    return true;
  }
}

class LinePay extends PaymentMethod {
  async process(amount: number): Promise<boolean> {
    console.log(`LinePay 付款 ${amount}`);
    return true;
  }

  async refund(transactionId: string): Promise<boolean> {
    console.log(`LinePay 退款 ${transactionId}`);
    return true;
  }
}

// 統一以 PaymentMethod 型別操作，不需在意實際是哪一種付款方式
const methods: PaymentMethod[] = [
  new CreditCard("1234567812345678"),
  new BankTransfer("001-222-333"),
  new LinePay(),
];
methods.forEach((m) => {
  m.process(100);
});
```

**為什麼 `CreditCard` / `BankTransfer` 要呼叫 `super()`，`LinePay` 卻不用？**

這是 **JavaScript 的語言規則，不是 TypeScript 額外加的**：只要 class 用了 `extends`，而且**自己寫了 `constructor`**，就必須在裡面呼叫 `super()`。漏掉會直接編譯錯誤：

```
error TS2377: Constructors for derived classes must contain a 'super' call.
```

`LinePay` 之所以不用寫，是因為它**根本沒寫 `constructor`**。這種情況 JS 會自動補一個隱含的建構子：

```typescript
// LinePay 實際上等同於有這個：
// constructor(...args) { super(...args); }
```

所以規則是：**要嘛完全不寫 constructor，要嘛寫了就得呼叫 `super()`**。`CreditCard` 和 `BankTransfer` 因為要接收卡號 / 帳號，被迫要寫 constructor，也就被迫要補 `super()`。

**為什麼一定要？**

因為在 ES6 class 裡，**子類別的 `this` 是由父類別的建構鏈「生出來」的**。`super()` 回來之前 `this` 根本還不存在（處於暫時性死區）：

```typescript
class CreditCard extends PaymentMethod {
  constructor(cardNumber: string) {
    // ❌ TS17009: 'super' must be called before accessing 'this' in the constructor of a derived class
    // this.cardNumber = cardNumber;
    super();
  }
}
```

把 `CreditCard` 編譯出來就能看到這件事 —— `private cardNumber` 這個參數屬性的賦值，被編譯器**自動排在 `super()` 之後**，因為在那之前寫不了 `this`：

```javascript
class CreditCard extends PaymentMethod {
    cardNumber;
    constructor(cardNumber) {
        super();                      // ← 先呼叫父類別建構子，this 才誕生
        this.cardNumber = cardNumber; // ← 參數屬性的賦值被插在這裡
    }
}
```

**父類別是 `abstract`，又不能被 `new`，為什麼還要 `super()`？**

`abstract` 只代表「不能直接 `new PaymentMethod()`」，但它**仍然是建構鏈的一環，仍然有建構子**。子類別被建立時，父類別的建構子照樣會執行 —— 這正是抽象類別能放共用初始化邏輯的原因，也是它跟 `interface` 的關鍵差別。

這裡 `PaymentMethod` 沒宣告 constructor，用的是隱含的無參數建構子，所以 `super()` 是空的。如果父類別有參數，就得往上傳：

```typescript
abstract class PaymentMethod {
  constructor(protected merchantId: string) {}
  abstract process(amount: number): Promise<boolean>;
  abstract refund(transactionId: string): Promise<boolean>;
}

class CreditCard extends PaymentMethod {
  constructor(merchantId: string, private cardNumber: string) {
    super(merchantId); // ← 參數要往上傳
  }
  // ...實作 process 與 refund
}
```

重點：抽象類別定義「契約 + 共用行為」，子類別負責填實作；把它們裝進 `PaymentMethod[]` 就能寫出對所有付款方式一視同仁的程式碼（多型）。

</details>

### 練習 3：設計模式

使用 TypeScript 類別實作 Observer 模式（觀察者模式）。

<details>
<summary>參考解答</summary>

觀察者模式有兩個角色：被觀察的「主題」（`Subject`）與訂閱它的「觀察者」（`Observer`）。用泛型 `T` 表示通知時傳遞的資料型別，讓主題與觀察者對資料的認知一致。`Subject` 維護一份觀察者清單，提供訂閱／取消訂閱，`notify` 時逐一呼叫每個觀察者的 `update`。

```typescript
// 觀察者介面：所有觀察者都要實作 update
interface Observer<T> {
  update(data: T): void;
}

// 被觀察的主題：負責訂閱、取消訂閱、以及通知所有觀察者
class Subject<T> {
  private observers: Observer<T>[] = [];

  subscribe(observer: Observer<T>): void {
    this.observers.push(observer);
  }

  unsubscribe(observer: Observer<T>): void {
    this.observers = this.observers.filter((o) => o !== observer);
  }

  notify(data: T): void {
    this.observers.forEach((o) => o.update(data));
  }
}

class LogObserver implements Observer<string> {
  update(data: string): void {
    console.log(`LogObserver 收到：${data}`);
  }
}

const subject = new Subject<string>();
const observer = new LogObserver();
subject.subscribe(observer);
subject.notify("hello observers"); // "LogObserver 收到：hello observers"
subject.unsubscribe(observer);
```

重點：主題只依賴 `Observer<T>` 這個介面、不在意觀察者的具體型別，這種「面向介面而非實作」的鬆耦合，正是設計模式想達成的目標；泛型 `T` 則讓通知資料保有型別安全。

</details>

---

> 下一章：[第六章 — 泛型（Generics）](./06-generics.md)
