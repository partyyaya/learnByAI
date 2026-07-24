// =====================================================================
// 第六章：泛型（Generics）
// 來源：typescript/06-generics.md
// 每個獨立範例都包在自己的 { ... } 區塊內，避免同名宣告互相衝突，
// 並把用到的型別/介面整段複製進來，讓每塊自成一體。
// =====================================================================

// ===== 6.1 什麼是泛型？ =====

// 範例 A：不使用泛型 — 缺乏型別安全
{
  function getFirst(arr: any[]): any {
    return arr[0];
  }

  const result = getFirst([1, 2, 3]); // result 的型別是 any，失去了型別資訊
  console.log("6.1 any 版本 getFirst:", result);
}

// 範例 B：使用泛型 — 保留型別資訊
{
  function getFirst<T>(arr: T[]): T {
    return arr[0];
  }

  const num = getFirst([1, 2, 3]); // num 的型別是 number
  const str = getFirst(["a", "b", "c"]); // str 的型別是 string
  console.log("6.1 泛型版本 getFirst:", num, str);
}

// ===== 6.2 泛型函式 =====
{
  // 基本泛型函式
  function identity<T>(value: T): T {
    return value;
  }

  // 明確指定型別
  identity<string>("hello"); // "hello"
  identity<number>(42); // 42

  // 型別推論（推薦）
  identity("hello"); // TypeScript 自動推斷 T = string
  identity(42); // TypeScript 自動推斷 T = number

  // 多個型別參數
  function pair<A, B>(first: A, second: B): [A, B] {
    return [first, second];
  }

  const p = pair("hello", 42); // 型別為 [string, number]
  console.log("6.2 pair:", p);

  // 泛型箭頭函式
  const toArray = <T>(value: T): T[] => [value];

  // 在 TSX 中需要加逗號避免被解析成 JSX
  const toArray2 = <T,>(value: T): T[] => [value];
  console.log("6.2 toArray:", toArray(1), toArray2("a"));
}

// ===== 6.2 NoInfer<T>（TS 5.4+）避免推斷型別被意外撐大 =====
{
  // 沒有 NoInfer：fallbackRole 的型別也會拿去推斷 T，讓 T 被意外撐大
  function pickRole<T extends string>(roles: T[], fallbackRole?: T): T {
    return fallbackRole ?? roles[0];
  }

  const role = pickRole(["admin", "user"], "guest");
  // role 的型別被撐大成 "admin" | "user" | "guest"，
  // 即使 "guest" 根本不在 roles 陣列裡，也不會報錯

  // 用 NoInfer<T> 排除 fallbackRole 對 T 的推斷貢獻，只讓 roles 陣列決定 T
  function pickRoleFixed<T extends string>(roles: T[], fallbackRole?: NoInfer<T>): T {
    return fallbackRole ?? roles[0];
  }

  const roleFixed = pickRoleFixed(["admin", "user"], "admin"); // ✅ T 只會是 "admin" | "user"
  // pickRoleFixed(["admin", "user"], "guest");
  // ❌ Argument of type '"guest"' is not assignable to parameter of type '"admin" | "user" | undefined'

  console.log("6.2 NoInfer:", role, roleFixed);
}

// ===== 6.3 泛型約束（Generic Constraints）=====
{
  // 約束 T 必須有 length 屬性
  function logLength<T extends { length: number }>(value: T): void {
    console.log(`Length: ${value.length}`);
  }

  logLength("hello"); // ✅ string 有 length
  logLength([1, 2, 3]); // ✅ 陣列有 length
  // logLength(42);        // ❌ number 沒有 length

  // 使用介面約束
  interface HasId {
    id: number;
  }

  function findById<T extends HasId>(items: T[], id: number): T | undefined {
    return items.find((item) => item.id === id);
  }

  const users = [
    { id: 1, name: "Alice" },
    { id: 2, name: "Bob" },
  ];

  const user = findById(users, 1); // 型別為 { id: number; name: string } | undefined
  console.log("6.3 findById:", user);
}

// ===== 6.3 keyof 約束 =====
{
  // T 是物件，K 是 T 的鍵
  function getProperty<T, K extends keyof T>(obj: T, key: K): T[K] {
    return obj[key];
  }

  const user = { name: "Gary", age: 30, email: "gary@example.com" };

  getProperty(user, "name"); // 回傳型別為 string
  getProperty(user, "age"); // 回傳型別為 number
  // getProperty(user, "phone"); // ❌ "phone" 不是 user 的鍵
  console.log("6.3 getProperty:", getProperty(user, "name"), getProperty(user, "age"));
}

// ===== 6.4 泛型介面 =====
{
  // 泛型介面
  interface ApiResponse<T> {
    data: T;
    status: number;
    message: string;
    timestamp: string;
  }

  interface User {
    id: number;
    name: string;
  }

  interface Product {
    id: number;
    title: string;
    price: number;
  }

  // 使用泛型介面
  type UserResponse = ApiResponse<User>;
  type ProductListResponse = ApiResponse<Product[]>;

  // 泛型介面搭配函式
  async function fetchApi<T>(url: string): Promise<ApiResponse<T>> {
    const response = await fetch(url);
    return response.json();
  }

  // 呼叫時指定型別 — 刻意不執行這個 IIFE：fetch("/api/users/1") 是相對路徑，
  // 在 Node.js 環境下會直接丟出 "Failed to parse URL" 而讓整個範例中斷，
  // 這裡只是要展示呼叫時的型別標注寫法，不需要真的發出網路請求
  async () => {
    const userRes = await fetchApi<User>("/api/users/1");
    // userRes.data 的型別是 User
    console.log("6.4 fetchApi:", userRes.data);
  };

  // 讓型別別名被使用一下，避免被視為完全孤立
  const _demoUserResponse: UserResponse = {
    data: { id: 1, name: "Gary" },
    status: 200,
    message: "ok",
    timestamp: "2026-07-23",
  };
  const _demoProductResponse: ProductListResponse = {
    data: [{ id: 1, title: "Book", price: 100 }],
    status: 200,
    message: "ok",
    timestamp: "2026-07-23",
  };
  console.log("6.4 ApiResponse:", _demoUserResponse.data, _demoProductResponse.data);
}

// ===== 6.4 型別變異標記 in / out（TS 4.7+）=====
{
  interface Producer<out T> {
    produce(): T;
  }

  interface Consumer<in T> {
    consume(value: T): void;
  }

  class Animal {}
  class Dog extends Animal {}

  const dogProducer: Producer<Dog> = { produce: () => new Dog() };
  // out T：Producer<Dog> 可以當作 Producer<Animal> 使用（協變）
  const producer: Producer<Animal> = dogProducer;

  const animalConsumer: Consumer<Animal> = { consume: (a) => console.log(a) };
  // in T：Consumer<Animal> 可以當作 Consumer<Dog> 使用（逆變）
  const consumer: Consumer<Dog> = animalConsumer;

  console.log("6.4 variance in/out:", producer.produce(), typeof consumer.consume);
}

// ===== 6.4 泛型介面 — Repository 模式 =====
{
  interface User {
    id: number;
    name: string;
  }

  interface Repository<T extends { id: number }> {
    findAll(): Promise<T[]>;
    findById(id: number): Promise<T | null>;
    create(data: Omit<T, "id">): Promise<T>;
    update(id: number, data: Partial<T>): Promise<T>;
    delete(id: number): Promise<boolean>;
  }

  class UserRepository implements Repository<User> {
    // 原文的方法本體為 /* ... */，這裡補上最小可編譯實作
    async findAll(): Promise<User[]> {
      return [];
    }
    async findById(id: number): Promise<User | null> {
      return null;
    }
    async create(data: Omit<User, "id">): Promise<User> {
      return { id: 0, ...data };
    }
    async update(id: number, data: Partial<User>): Promise<User> {
      return { id, name: "unknown", ...data };
    }
    async delete(id: number): Promise<boolean> {
      return true;
    }
  }

  const repo = new UserRepository();
  console.log("6.4 Repository:", repo instanceof UserRepository);
}

// ===== 6.5 泛型類別 =====
{
  interface User {
    id: number;
    name: string;
  }

  class DataStore<T> {
    private items: T[] = [];

    add(item: T): void {
      this.items.push(item);
    }

    getAll(): T[] {
      return [...this.items];
    }

    find(predicate: (item: T) => boolean): T | undefined {
      return this.items.find(predicate);
    }

    filter(predicate: (item: T) => boolean): T[] {
      return this.items.filter(predicate);
    }

    remove(predicate: (item: T) => boolean): void {
      this.items = this.items.filter((item) => !predicate(item));
    }
  }

  // 使用
  const userStore = new DataStore<User>();
  userStore.add({ id: 1, name: "Alice" });
  userStore.add({ id: 2, name: "Bob" });

  const alice = userStore.find((u) => u.name === "Alice");
  console.log("6.5 DataStore:", alice, userStore.getAll());
}

// ===== 6.6 泛型預設值 =====
{
  interface User {
    id: number;
    name: string;
  }

  // 給泛型指定預設型別
  interface PaginatedList<T = unknown> {
    items: T[];
    page: number;
    pageSize: number;
    total: number;
  }

  // 不指定型別時使用預設值
  const list: PaginatedList = {
    items: [],
    page: 1,
    pageSize: 10,
    total: 0,
  };

  // 也可以指定具體型別
  const userList: PaginatedList<User> = {
    items: [{ id: 1, name: "Gary" }],
    page: 1,
    pageSize: 10,
    total: 1,
  };
  console.log("6.6 PaginatedList:", list.total, userList.items);
}

// ===== 6.7 常見泛型模式 — Result 模式（錯誤處理）=====
{
  type Result<T, E = Error> =
    | { success: true; data: T }
    | { success: false; error: E };

  function divide(a: number, b: number): Result<number, string> {
    if (b === 0) {
      return { success: false, error: "Cannot divide by zero" };
    }
    return { success: true, data: a / b };
  }

  const result = divide(10, 2);
  if (result.success) {
    console.log(result.data); // 型別縮窄為 number
  } else {
    console.error(result.error); // 型別縮窄為 string
  }
}

// ===== 6.7 常見泛型模式 — Builder 模式 =====
{
  interface User {
    id: number;
    name: string;
  }

  class QueryBuilder<T> {
    private conditions: string[] = [];
    private orderByField?: string;
    private limitValue?: number;

    where(condition: string): QueryBuilder<T> {
      this.conditions.push(condition);
      return this; // 回傳 this 實現鏈式呼叫
    }

    orderBy(field: keyof T & string): QueryBuilder<T> {
      this.orderByField = field;
      return this;
    }

    limit(count: number): QueryBuilder<T> {
      this.limitValue = count;
      return this;
    }

    build(): string {
      let query = "SELECT * FROM table";
      if (this.conditions.length) {
        query += ` WHERE ${this.conditions.join(" AND ")}`;
      }
      if (this.orderByField) {
        query += ` ORDER BY ${this.orderByField}`;
      }
      if (this.limitValue) {
        query += ` LIMIT ${this.limitValue}`;
      }
      return query;
    }
  }

  const query = new QueryBuilder<User>()
    .where("age > 18")
    .orderBy("name")
    .limit(10)
    .build();
  console.log("6.7 Builder:", query);
}

// ===== 練習 1：泛型函式 groupBy =====
{
  function groupBy<T>(arr: T[], key: keyof T): Record<string, T[]> {
    // 練習參考解答
    return arr.reduce((acc, item) => {
      const groupKey = String(item[key]);
      (acc[groupKey] ??= []).push(item);
      return acc;
    }, {} as Record<string, T[]>);
  }

  // 使用
  const users = [
    { name: "Alice", role: "admin" },
    { name: "Bob", role: "user" },
    { name: "Charlie", role: "admin" },
  ];

  console.log("練習 1 groupBy:", groupBy(users, "role"));
  // { admin: [Alice, Charlie], user: [Bob] }
}

// ===== 練習 2：泛型類別 EventEmitter<T> =====
{
  // 練習參考解答：T 定義了「事件名稱 -> 對應資料型別」的對照表
  class EventEmitter<T extends Record<string, unknown>> {
    private listeners: { [K in keyof T]?: Array<(payload: T[K]) => void> } = {};

    on<K extends keyof T>(event: K, listener: (payload: T[K]) => void): void {
      (this.listeners[event] ??= []).push(listener);
    }

    emit<K extends keyof T>(event: K, payload: T[K]): void {
      this.listeners[event]?.forEach((listener) => listener(payload));
    }
  }

  // 用 type（而非 interface）才能滿足 Record<string, unknown> 的索引簽章約束
  interface AppEventsBad {
    login: { userId: number };
  }
  // new EventEmitter<AppEventsBad>();
  // ❌ interface 沒有索引簽章，不滿足 Record<string, unknown> 的約束

  type AppEvents = {
    login: { userId: number };
    logout: { userId: number; reason: string };
  };

  const emitter = new EventEmitter<AppEvents>();
  emitter.on("login", (payload) => console.log(`User ${payload.userId} logged in`));
  emitter.emit("login", { userId: 1 });
}

// ===== 練習 3：泛型約束 merge =====
{
  function merge<T extends object, U extends object>(a: T, b: U): T & U {
    // 練習參考解答
    return { ...a, ...b };
  }

  const merged = merge({ name: "Gary" }, { age: 30 });
  console.log("練習 3 merge:", merged.name, merged.age);
}

console.log("第 6 章 泛型 範例載入完成 ✅");

export {};
