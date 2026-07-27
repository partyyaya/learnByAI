# 第六章：泛型（Generics）

## 6.1 什麼是泛型？

泛型是一種讓型別變成「參數」的機制，讓你在定義函式、介面、類別時**不預先指定具體型別**，而是在使用時才決定。

### 為什麼需要泛型？

```typescript
// 不使用泛型 — 缺乏型別安全
function getFirst(arr: any[]): any {
  return arr[0];
}

const result = getFirst([1, 2, 3]); // result 的型別是 any，失去了型別資訊

// 使用泛型 — 保留型別資訊
function getFirst<T>(arr: T[]): T {
  return arr[0];
}

const num = getFirst([1, 2, 3]);       // num 的型別是 number
const str = getFirst(["a", "b", "c"]); // str 的型別是 string
```

---

## 6.2 泛型函式

```typescript
// 基本泛型函式
function identity<T>(value: T): T {
  return value;
}

// 明確指定型別
identity<string>("hello"); // "hello"
identity<number>(42);       // 42

// 型別推論（推薦）
identity("hello"); // TypeScript 自動推斷 T = string
identity(42);       // TypeScript 自動推斷 T = number

// 多個型別參數
function pair<A, B>(first: A, second: B): [A, B] {
  return [first, second];
}

const p = pair("hello", 42); // 型別為 [string, number]

// 泛型箭頭函式
const toArray = <T>(value: T): T[] => [value];

// 在 TSX 中需要加逗號避免被解析成 JSX
const toArray2 = <T,>(value: T): T[] => [value];
```

### NoInfer\<T\>（TS 5.4+）避免推斷型別被意外撐大

泛型函式若有多個參數都能推斷同一個型別參數 `T`，其中一個「意料之外」的參數也可能把 `T` 撐大成不是你想要的聯合型別。用 `NoInfer<T>` 包住某個參數的型別，能讓它不參與 `T` 的推斷，只負責檢查：

```typescript
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
```

---

## 6.3 泛型約束（Generic Constraints）

使用 `extends` 關鍵字限制泛型的範圍。

```typescript
// 約束 T 必須有 length 屬性
function logLength<T extends { length: number }>(value: T): void {
  console.log(`Length: ${value.length}`);
}

logLength("hello");     // ✅ string 有 length
logLength([1, 2, 3]);   // ✅ 陣列有 length
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
```

### keyof 約束

```typescript
// T 是物件，K 是 T 的鍵
function getProperty<T, K extends keyof T>(obj: T, key: K): T[K] {
  return obj[key];
}

const user = { name: "Gary", age: 30, email: "gary@example.com" };

getProperty(user, "name");  // 回傳型別為 string
getProperty(user, "age");   // 回傳型別為 number
// getProperty(user, "phone"); // ❌ "phone" 不是 user 的鍵
```

---

## 6.4 泛型介面

```typescript
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

// 呼叫時指定型別
const userRes = await fetchApi<User>("/api/users/1");
// userRes.data 的型別是 User
```

### 型別變異標記 in / out（TS 4.7+）

在泛型介面或型別別名的型別參數上加 `out`（協變，只當輸出用）或 `in`（逆變，只當輸入用），可以明確告訴編譯器這個參數的變異方向，讓結構相容性檢查更快、錯誤訊息也更精準：

```typescript
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
const producer: Producer<Animal> = dogProducer; // ✅

const animalConsumer: Consumer<Animal> = { consume: (a) => console.log(a) };
// in T：Consumer<Animal> 可以當作 Consumer<Dog> 使用（逆變）
const consumer: Consumer<Dog> = animalConsumer; // ✅
```

不標記時 TypeScript 仍會自動推斷變異方向，但明確標記能讓編譯器檢查更快，型別不相容時也能給出更貼近問題根源的錯誤訊息，而不是籠統的「結構不相容」。第 13 章「型別層級程式設計」還會再補上第三種變異——`in out`（不變）。

### 泛型介面 — Repository 模式

```typescript
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
  // 實務上這裡會呼叫資料庫／API；下面補上最小可編譯的假實作
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
```

---

## 6.5 泛型類別

```typescript
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
```

---

## 6.6 泛型預設值

```typescript
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
```

---

## 6.7 常見泛型模式

### Result 模式（錯誤處理）

```typescript
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
```

### Builder 模式

```typescript
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
```

---

## 練習題

### 練習 1：泛型函式

實作一個泛型函式 `groupBy`，將陣列按照指定的鍵分組：

```typescript
function groupBy<T>(arr: T[], key: keyof T): Record<string, T[]> {
  // 實作...
}

// 使用
const users = [
  { name: "Alice", role: "admin" },
  { name: "Bob", role: "user" },
  { name: "Charlie", role: "admin" },
];

groupBy(users, "role");
// { admin: [Alice, Charlie], user: [Bob] }
```

<details>
<summary>參考解答</summary>

用 `reduce` 把陣列累積成一個物件：對每個元素取出 `item[key]` 當分組鍵，用 `String()` 轉成字串（物件的鍵是字串），再把元素推進對應的陣列。`??=`（空值合併賦值）在該鍵還沒有陣列時先建一個空陣列。累加器初始值 `{}` 要用 `as Record<string, T[]>` 標注型別。

```typescript
function groupBy<T>(arr: T[], key: keyof T): Record<string, T[]> {
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

console.log(groupBy(users, "role"));
// { admin: [Alice, Charlie], user: [Bob] }
```

重點：`key: keyof T` 約束了第二個參數只能是 `T` 真正有的屬性名；`String(item[key])` 是因為 `Record` 的鍵一律是字串，分組鍵可能是數字或其他型別時需要先轉換。

</details>

### 練習 2：泛型類別

建立一個 `EventEmitter<T>` 泛型類別，T 定義了事件名稱和對應的資料型別。

> **小提醒（interface vs type 的索引簽章差異）**：若把 `T` 約束為 `T extends Record<string, unknown>`，事件表必須用 `type`（型別別名）宣告，不能用 `interface`——因為 `interface` 不會自動具備索引簽章，即使欄位都已知，也無法滿足 `Record<string, unknown>` 的結構檢查；`type` 別名可以。
>
> ```typescript
> class EventEmitter<T extends Record<string, unknown>> {
>   private listeners: { [K in keyof T]?: Array<(payload: T[K]) => void> } = {};
>
>   on<K extends keyof T>(event: K, listener: (payload: T[K]) => void): void {
>     (this.listeners[event] ??= []).push(listener);
>   }
> }
>
> interface AppEventsBad {
>   login: { userId: number };
> }
> // new EventEmitter<AppEventsBad>();
> // ❌ interface 沒有索引簽章，不滿足 Record<string, unknown> 的約束
>
> type AppEvents = {
>   login: { userId: number };
> };
> new EventEmitter<AppEvents>(); // ✅ type 別名可以
> ```

<details>
<summary>參考解答</summary>

把 `T` 約束成「事件名稱對應資料型別」的對照表（`Record<string, unknown>`）。內部用映射型別 `{ [K in keyof T]?: ... }` 讓每個事件各存一組監聽器；`on` 與 `emit` 各自帶一個 `K extends keyof T`，這樣選定某個事件後，該事件的 `payload` 型別就會自動對上 `T[K]`。如小提醒所述，事件表必須用 `type` 宣告才能滿足 `Record<string, unknown>` 約束。

```typescript
// T 是「事件名稱 -> 對應資料型別」的對照表
class EventEmitter<T extends Record<string, unknown>> {
  // 每個事件各自存一組監聽器；用映射型別確保 payload 型別對得上
  private listeners: { [K in keyof T]?: Array<(payload: T[K]) => void> } = {};

  on<K extends keyof T>(event: K, listener: (payload: T[K]) => void): void {
    (this.listeners[event] ??= []).push(listener);
  }

  emit<K extends keyof T>(event: K, payload: T[K]): void {
    this.listeners[event]?.forEach((listener) => listener(payload));
  }
}

// 事件表必須用 type（型別別名），interface 不具備索引簽章，
// 無法滿足 T extends Record<string, unknown> 的約束
type AppEvents = {
  login: { userId: number };
  logout: { userId: number; reason: string };
};

const emitter = new EventEmitter<AppEvents>();
emitter.on("login", (payload) => console.log(`User ${payload.userId} logged in`));
emitter.emit("login", { userId: 1 });
// emitter.emit("login", { reason: "x" });
// ❌ payload 型別不符：login 事件需要 { userId: number }
```

重點：`on` / `emit` 各自帶 `K extends keyof T`，讓事件名稱與 `payload` 型別綁在一起，寫錯事件名或傳錯資料形狀都會在編譯期報錯；這正是泛型類別搭配 `keyof` 與映射型別的威力。

</details>

### 練習 3：泛型約束

實作一個 `merge` 函式，合併兩個物件並回傳正確的型別：

```typescript
function merge<T extends object, U extends object>(a: T, b: U): T & U {
  // 實作...
}
```

<details>
<summary>參考解答</summary>

實作本體只要用物件展開（spread）把兩個物件合併即可。關鍵在型別：兩個型別參數 `T`、`U` 各自約束為 `object`，回傳型別標成交集 `T & U`，這樣結果物件就同時擁有兩邊的屬性且各自保有正確型別。

```typescript
function merge<T extends object, U extends object>(a: T, b: U): T & U {
  return { ...a, ...b };
}

const merged = merge({ name: "Gary" }, { age: 30 });
console.log(merged.name, merged.age); // 兩個來源物件的屬性都保有正確型別
```

重點：交集型別 `T & U` 精準描述了「合併後同時具備雙方屬性」的結果，比回傳 `object` 或 `any` 保留了完整型別資訊；`extends object` 則擋掉傳入原始型別（如 `number`）的情況。

</details>

---

> 下一章：[第七章 — 進階型別技巧](./07-advanced-types.md)
