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

### 練習 2：繼承與抽象類別

設計一個支付系統的類別體系：

```typescript
abstract class PaymentMethod {
  abstract process(amount: number): Promise<boolean>;
  abstract refund(transactionId: string): Promise<boolean>;
}

// 實作 CreditCard、BankTransfer、LinePay
```

### 練習 3：設計模式

使用 TypeScript 類別實作 Observer 模式（觀察者模式）。

---

> 下一章：[第六章 — 泛型（Generics）](./06-generics.md)
