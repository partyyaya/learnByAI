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

`PaymentMethod` 是抽象類別，只規定「所有付款方式都必須有 `process` 與 `refund`」但不提供實作。三個子類別各自 `extends` 它並補上具體邏輯；有需要建構參數的（信用卡卡號、轉帳帳號）就在建構子用參數屬性接收，並記得呼叫 `super()`。最後就能用同一個 `PaymentMethod[]` 型別統一操作，不必在意實際型別——這就是多型。

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
