// ┌─────────────────────────────────────────────────────────────┐
// │  05-classes.ts —— 第 5 章：類別與物件導向程式設計              │
// ├─────────────────────────────────────────────────────────────┤
// │  來源：typescript/05-classes.md                              │
// │  型別檢查： npm run check（或見 README 的 tsc 指令）           │
// │                                                              │
// │  ⚠ 每個獨立範例都包在自己的 { ... } 區塊內，                  │
// │    讓同名的 class / interface / const 彼此不衝突。            │
// └─────────────────────────────────────────────────────────────┘

// ===== 5.1 類別基礎 =====

// --- 5.1（範例一）定義類別 ---
{
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
}

// --- 5.1（範例二）簡化寫法：參數屬性（Parameter Properties）---
{
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

  const user = new User("Gary", "gary@example.com", 30);
  console.log(user.greet()); // "Hi, I'm Gary!"
}

// --- 5.1（範例三）readonly 參數屬性 + 箭頭函式類別欄位（詞法 this）---
{
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
  console.log("5.1 readonly point:", point.x, point.y);
}

// ===== 5.2 存取修飾符（Access Modifiers）=====

// --- 5.2（範例一）public / protected / private ---
{
  class BankAccount {
    public ownerName: string; // 任何地方都可存取
    protected accountType: string; // 只有類別內部和子類別可存取
    private balance: number; // 只有類別內部可存取

    constructor(owner: string, type: string, initialBalance: number) {
      this.ownerName = owner;
      this.accountType = type;
      this.balance = initialBalance;
    }

    public deposit(amount: number): void {
      this.balance += amount;
      this.logTransaction("deposit", amount);
    }

    public getBalance(): number {
      return this.balance;
    }

    private logTransaction(type: string, amount: number): void {
      console.log(`[${type}] ${amount} — Balance: ${this.balance}`);
    }
  }

  const account = new BankAccount("Gary", "savings", 1000);
  account.ownerName; // ✅ public
  // account.accountType; // ❌ protected — 類別外部無法存取
  // account.balance;     // ❌ private — 類別外部無法存取
}

// --- 5.2（範例二）ES2022 私有欄位 ---
{
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
}

// --- 5.2（範例三）#field vs private：執行期的差異 ---
{
  class WithHash {
    #secret = "hidden";

    reveal(): string {
      return this.#secret;
    }

    // #field in obj：品牌檢查（brand check），只有真正的 WithHash 實例才會是 true
    static isWithHash(obj: unknown): boolean {
      return typeof obj === "object" && obj !== null && #secret in obj;
    }
  }

  class WithPrivate {
    private secret = "hidden";

    reveal(): string {
      return this.secret;
    }
  }

  const a = new WithHash();
  const b = new WithPrivate();

  console.log("5.2 品牌檢查:", WithHash.isWithHash(a), WithHash.isWithHash(b));
  console.log("5.2 JSON #field:", JSON.stringify(a)); // {} — 看不到 #secret
  console.log("5.2 JSON private:", JSON.stringify(b)); // {"secret":"hidden"} — private 只是型別層級
  console.log("5.2 bracket #field:", (a as any)["#secret"]); // undefined，真正的私有
  console.log("5.2 bracket private:", (b as any)["secret"]); // "hidden"，執行期仍可見
}

// ===== 5.3 繼承（Inheritance）=====
// 同一條繼承鏈（Animal / Dog / Cat）放在同一個區塊內。
{
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
  console.log(cat.purr()); // "Whiskers is purring..."
}

// --- 5.3 override 關鍵字（TS 4.3+）：覆寫父類別的具體方法 ---
{
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
}

// ===== 5.4 抽象類別（Abstract Classes）=====
// 抽象類別不能被實例化，只能被繼承。用來定義子類別必須實作的方法。
// 同一條繼承鏈（Shape / Circle / Rectangle）放在同一個區塊內。
{
  abstract class Shape {
    abstract area(): number; // 子類別必須實作
    abstract perimeter(): number; // 子類別必須實作

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

  const rectangle = new Rectangle(3, 4);
  console.log(rectangle.describe()); // "Area: 12, Perimeter: 14"
}

// ===== 5.5 介面實作（implements）=====

// --- 5.5（範例一）一個類別可以實作多個介面 ---
{
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

  const doc = new Document("標題", "內容");
  console.log(doc.serialize()); // {"title":"標題","content":"內容"}
  doc.print();
}

// --- 5.5（範例二）abstract class vs interface ---
{
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

  const logger: Logger | BaseLogger = new ConsoleLogger();
  logger.log("hello");
  logger.error("something broke");
}

// ===== 5.6 Getter / Setter =====
{
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
  console.log(temp.celsius); // 25
  console.log(temp.fahrenheit); // 77

  temp.fahrenheit = 100;
  console.log(temp.celsius); // 37.78
}

// ===== 5.7 靜態成員（Static Members）=====

// --- 5.7（範例一）static 屬性與方法 ---
{
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
  console.log(MathUtils.PI); // 3.14159
  console.log(MathUtils.add(3, 5)); // 8
  console.log(MathUtils.factorial(5)); // 120
}

// --- 5.7（範例二）Singleton 模式 ---
// Singleton＝整個程式生命週期只允許一個實例，大家拿到的都是同一個。
// 何時用：資料庫/Redis 連線池、AppConfig、Logger、快取或 EventBus —— 共同點是
//         「建立成本高，而且本來就該全系統共用一份」。
// 何時別用：每個請求／每個使用者狀態不同的東西（購物車、request context），
//           做成 Singleton 資料會互相污染。
{
  class Database {
    private static instance: Database; // 實例掛在類別身上（全域唯一位置）
    private constructor(private connectionString: string) {} // 擋住外部 new

    static getInstance(): Database {
      // 延遲建立：第一次呼叫時才真的連線，沒人用就不浪費資源
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

  // ❌ private constructor 擋住直接 new
  // const bad = new Database("mongodb://localhost:27017");
}

// --- 5.7（範例二之二）Singleton：兩段式初始化（實務寫法）---
// 上面的範例把連線字串寫死在 getInstance() 裡，實務上設定要從外部來。
{
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
    // （Singleton 最大的缺點就是狀態跨測試殘留，所以要補這個逃生門）
    static reset(): void {
      Database.instance = null;
    }

    query(sql: string): void {
      console.log(`Executing: ${sql} (${this.connectionString})`);
    }
  }

  Database.init(process.env.DB_URL ?? "mongodb://localhost:27017");
  Database.getInstance().query("SELECT 1");
  Database.reset();

  // 實務替代方案：
  // A. ES module 本身就是單例 —— `export const db = new Database(...)`，
  //    模組只會被求值一次，之後 import 都拿快取。
  // B. 依賴注入（DI）—— 相依寫在建構子上，測試時直接傳假的進去；
  //    NestJS 的 @Injectable() 預設就是 singleton scope。
  // ⚠️「唯一」只在單一 process 內：cluster / PM2 多實例 / Serverless 冷啟動
  //    各自都有自己的 Singleton，別當成跨機器的全域鎖。
}

// --- 5.7（範例三）ES2022 static 初始化區塊 ---
{
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

  console.log("5.7 static block:", AppConfig.apiUrl, AppConfig.isProduction);
}

// ===== 5.8 泛型類別 =====
{
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
  console.log(stringStack.size); // 2
}

// ===== 練習題 =====

// --- 練習 1：基本類別（TodoList）---
{
  // 練習參考解答
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
  console.log(list.getPending()); // [{ id: 1, text: "Learn TypeScript", done: false }]
}

// --- 練習 2：繼承與抽象類別（支付系統）---
{
  // 練習參考解答
  abstract class PaymentMethod {
    abstract process(amount: number): Promise<boolean>;
    abstract refund(transactionId: string): Promise<boolean>;
  }

  // 實作 CreditCard、BankTransfer、LinePay
  class CreditCard extends PaymentMethod {
    // 為什麼要呼叫 super()？這是 JS 語言規則：class 用了 extends，
    // 而且「自己寫了 constructor」，就必須呼叫 super()，否則 TS2377。
    // 原因：子類別的 this 是由父類別建構鏈生出來的，super() 回來前 this 還不存在
    // （在 super() 之前碰 this 會得到 TS17009）。
    // 證據：private cardNumber 這個參數屬性的賦值，編譯後被自動排在 super() 之後：
    //   constructor(cardNumber) { super(); this.cardNumber = cardNumber; }
    // 父類別是 abstract 也一樣要呼叫 —— abstract 只是不能直接 new，
    // 它仍然是建構鏈的一環、仍然有建構子（這正是它跟 interface 的關鍵差別）。
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

  // LinePay 沒寫 super()，是因為它「根本沒寫 constructor」——
  // 這種情況 JS 會自動補一個隱含建構子：constructor(...args) { super(...args); }
  // 所以規則是：要嘛完全不寫 constructor，要嘛寫了就得呼叫 super()。
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

  const methods: PaymentMethod[] = [
    new CreditCard("1234567812345678"),
    new BankTransfer("001-222-333"),
    new LinePay(),
  ];
  methods.forEach((m) => {
    m.process(100);
  });
}

// --- 練習 2 補充：父類別的建構子有參數時，super() 就要往上傳 ---
{
  abstract class PaymentMethod {
    constructor(protected merchantId: string) {}
    abstract process(amount: number): Promise<boolean>;
  }

  class CreditCard extends PaymentMethod {
    constructor(merchantId: string, private cardNumber: string) {
      super(merchantId); // ← 參數要往上傳，不能只寫 super()
    }

    async process(amount: number): Promise<boolean> {
      console.log(
        `商店 ${this.merchantId} 收款 ${amount}（卡號末四碼 ${this.cardNumber.slice(-4)}）`,
      );
      return true;
    }
  }

  new CreditCard("shop-001", "1234567812345678").process(100);
}

// --- 練習 3：設計模式（Observer 觀察者模式）---
{
  // 練習參考解答
  interface Observer<T> {
    update(data: T): void;
  }

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
}

console.log("第 5 章 類別與物件導向 範例載入完成 ✅");

export {};
