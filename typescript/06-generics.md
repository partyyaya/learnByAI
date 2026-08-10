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

### 型別參數的命名規則與慣例

`<T>` 裡的 `T` 只是一個「型別參數的名字」，本質上就是一個識別字（identifier）。命名有「硬性規則」和「軟性慣例」兩層：

**慣例（建議遵守，非強制）**：習慣用單一大寫字母，語意化的常見選擇有：

- `T`（Type）— 最通用的第一個型別參數
- `K`（Key）、`V`（Value）— 鍵值對，如 `Map<K, V>`
- `E`（Element）— 集合的元素
- `R`（Return）— 回傳型別
- 多個時依序用 `T`、`U`、`V`…
- 需要語意時也可用 PascalCase 的描述性名稱，如 `TData`、`TItem`、`TKey`（函式庫中很常見）

**小寫可以嗎？** 可以，`t`、`item` 這類小寫或多字母名稱都能通過編譯：

```typescript
// ✅ 合法，但不建議 — 小寫容易和一般變數／內建型別混淆
function getFirst<t>(arr: t[]): t {
  return arr[0];
}
```

慣例上仍以大寫開頭，讓型別參數在程式碼中一眼就能和值變數區分。

**禁止使用的名稱（硬性規則）**：有兩類名稱不能拿來當型別參數：

1. **內建型別關鍵字** — 會直接報錯 `TS2368: Type parameter name cannot be '...'`：
   `any`、`unknown`、`never`、`object`、`string`、`number`、`boolean`、`symbol`、`bigint`、`undefined`

2. **JavaScript 保留字** — 因為根本不是合法識別字，會是語法錯誤（不是 TS2368）：
   如 `void`、`null`、`if`、`for`、`class`、`function`、`return`、`new`、`typeof`、`enum` 等

```typescript
// ❌ TS2368: Type parameter name cannot be 'string'.
function bad1<string>(x: string): string { return x; }

// ❌ 語法錯誤：void 是保留字，不能當識別字
// function bad2<void>(x: void): void { return x; }
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

#### 先搞懂 `keyof` 本身

`keyof` 是一個**型別運算子**：吃一個物件型別，吐出「它所有鍵名組成的聯合型別」。

```typescript
interface User {
  id: number;
  name: string;
  email: string;
}

type UserKeys = keyof User; // "id" | "name" | "email"

const k1: UserKeys = "name";  // ✅
// const k2: UserKeys = "phone"; // ❌ User 沒有 phone 這個鍵
```

它是**型別層的操作**，跟執行期的 `Object.keys()` 只是概念相似——`Object.keys(user)` 回傳的是值（一個 `string[]` 陣列），`keyof User` 產生的是型別（三個字串字面值的聯合）。

搭配**索引存取型別** `T[K]`（用鍵名取出對應的值型別），就能組出各種工具：

```typescript
type NameType = User["name"];       // string，用鍵名取值型別
type AllValues = User[keyof User];  // number | string，把所有鍵一次代進去 = 所有值型別的聯合
```

#### `keyof T` 與 `K extends keyof T` 差在哪？

這是最容易混淆的一點：兩種寫法都能擋掉不存在的鍵，但**只有後者記得住「你傳的是哪一個鍵」**。

```typescript
// 寫法 A：keyof T 直接當參數型別
function getA<T>(obj: T, key: keyof T) {
  return obj[key]; // 回傳型別是 T[keyof T]：所有值型別的聯合
}

// 寫法 B：把鍵綁成獨立的型別參數 K
function getB<T, K extends keyof T>(obj: T, key: K): T[K] {
  return obj[key];
}

const user = { name: "Gary", age: 30 };

const a = getA(user, "name"); // string | number ⚠️ 精度掉了
const b = getB(user, "name"); // string ✅ 剛好就是 name 的型別
```

差別在於 `K` 是一個**型別參數**，呼叫 `getB(user, "name")` 時 TypeScript 會把 `K` 推論成 `"name"` 這個具體的字面值型別，所以 `T[K]` 算出來就是 `string`。而寫法 A 的 `key` 型別永遠是「所有鍵的聯合」，函式內部無從得知你到底傳了哪一個，只能回傳「所有值型別的聯合」。

| 寫法 | 擋掉不存在的鍵 | 記得是哪一個鍵 | 適用時機 |
| --- | --- | --- | --- |
| `key: keyof T` | ✅ | ❌ | 只需要驗證鍵名合法，不在乎回傳型別（如下方場景 1 的 `Column<T>`） |
| `K extends keyof T` | ✅ | ✅ | 回傳型別或其他參數要跟著鍵變（場景 2、3） |

```typescript
// T 是物件，K 是 T 的鍵
function getProperty<T, K extends keyof T>(obj: T, key: K): T[K] {
  return obj[key];
}

const profile = { name: "Gary", age: 30, email: "gary@example.com" };

getProperty(profile, "name");  // 回傳型別為 string
getProperty(profile, "age");   // 回傳型別為 number
// getProperty(profile, "phone"); // ❌ "phone" 不是 profile 的鍵
```

> 📌 還有第三種長得很像的寫法 `[K in keyof T]`（映射型別），它做的事完全不同——是「走訪每一個鍵」。三者的對照見第 7 章 7.5。

#### 什麼時候真的需要 keyof 約束？

上面的 `getProperty(user, "name")` 其實有點多餘 —— 你明明可以直接寫 `user.name`。

`keyof` 約束的價值在於「**欄位名是變數，由呼叫端決定**」的時候，也就是你在寫**給別人用的通用函式或元件**，而不是寫業務邏輯的時候。以下三種是實務上最常遇到的形狀。

**場景 1：通用表格元件（最常見）**

```typescript
interface Column<T> {
  key: keyof T;    // 只能是 T 真的有的欄位名
  title: string;
}

function renderTable<T>(data: T[], columns: Column<T>[]): string[] {
  const header = columns.map((col) => col.title).join(" | ");
  const rows = data.map((row) =>
    columns.map((col) => String(row[col.key])).join(" | ")
  );
  return [header, ...rows];
}

interface Employee {
  id: number;
  name: string;
  age: number;
}

const employees: Employee[] = [
  { id: 1, name: "Alice", age: 28 },
  { id: 2, name: "Bob", age: 35 },
];

renderTable(employees, [
  { key: "name", title: "姓名" },
  { key: "age", title: "年齡" },
  // { key: "phone", title: "電話" }, // ❌ Employee 沒有 phone
]);
```

如果 `key` 只宣告成 `string`，欄位名打錯字（或後端把欄位改名）要等到執行期才會發現整欄變空白；有了 `keyof T`，編譯階段就會報錯。

**場景 2：排序、取欄位這類 helper（回傳型別要跟著 key 變）**

```typescript
function sortBy<T, K extends keyof T>(items: T[], key: K): T[] {
  return [...items].sort((a, b) => (a[key] > b[key] ? 1 : -1));
}

function pluck<T, K extends keyof T>(items: T[], key: K): T[K][] {
  return items.map((item) => item[key]);
}

const staff = [
  { id: 1, name: "Alice", age: 28 },
  { id: 2, name: "Bob", age: 35 },
];

const names = pluck(staff, "name");   // string[]
const ages = pluck(staff, "age");     // number[]
const sorted = sortBy(staff, "age");  // 依年齡排序
```

回傳型別寫成 `T[K]`，`names` 才會是 `string[]`、`ages` 才會是 `number[]`。若把參數宣告成 `key: string`，回傳只能退化成 `any[]`，型別安全整條斷掉。

**場景 3：key 與 value 必須「對得起來」（這是 `string` 完全做不到的）**

```typescript
function setField<T, K extends keyof T>(obj: T, key: K, value: T[K]): T {
  return { ...obj, [key]: value };
}

const profile = { name: "Gary", age: 30 };

setField(profile, "age", 31);      // ✅
// setField(profile, "age", "31"); // ❌ age 是 number，不能塞字串
// setField(profile, "name", 100); // ❌ name 是 string，不能塞數字
```

`value` 的型別會**隨著 `key` 自動改變**，這種「參數之間的關聯」只有 `K extends keyof T` + `T[K]` 能表達。表單欄位更新、狀態管理的 `setState(field, value)`、設定檔的 `config.set(key, value)` 全都是這個形狀。

**判斷準則**

| 情況 | 需要 `K extends keyof T` 嗎 |
| --- | --- |
| 你已經知道要拿哪個欄位 | ❌ 直接寫 `user.name` 就好 |
| 欄位名由參數、設定檔或使用者傳進來 | ✅ 用 `keyof T` 擋掉不存在的欄位 |
| 回傳值的型別要跟著欄位變 | ✅ 搭配 `T[K]` |
| key 與 value 要成對檢查 | ✅ 只有這個寫法做得到 |

一句話總結：**寫業務邏輯幾乎用不到，寫通用元件與工具函式幾乎一定會用到。**

### NoInfer\<T\>（TS 5.4+）搭配約束避免推斷型別被意外撐大

泛型函式若有多個參數都能推斷同一個型別參數 `T`，其中一個「意料之外」的參數也可能把 `T` 撐大成不是你想要的聯合型別。用 `NoInfer<T>` 包住某個參數的型別，能讓它不參與 `T` 的推斷，只負責檢查：

> **為什麼這裡要 `T extends string`？** 它不只是限制型別，更是這個示範能成立的前提：有 `extends string` 約束時，TypeScript 會讓 `T` **保留字面量型別**（把 `["admin", "user"]` 推斷成 `"admin" | "user"`）；若寫成裸泛型 `<T>`，字面量會被**拓寬成 `string`**，`T` 直接就是 `string`，那 `fallbackRole` 傳任何字串都合法，也就沒有「聯合被意外撐大」的問題可以示範了。

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

**先講白話：「變異」在問什麼？**

我們都知道 `Dog` 是 `Animal` 的子型別，所以 `const a: Animal = new Dog()` 可以。但是**包了一層泛型之後**呢？`Producer<Dog>` 可不可以當成 `Producer<Animal>` 用？

「變異（Variance）」講的就是這件事：**內層型別的父子關係，包上泛型後方向會不會保持**。答案取決於 `T` 在介面裡是被拿來**產出**還是**接收**：

| 標記 | 名稱 | `T` 出現的位置 | 方向 |
| --- | --- | --- | --- |
| `out T` | 協變（Covariant） | 只在**回傳值**（產出） | 跟 `Dog`/`Animal` 一樣 |
| `in T` | 逆變（Contravariant） | 只在**參數**（接收） | 跟 `Dog`/`Animal` **相反** |

```typescript
// out T：T 只出現在「回傳值」位置 → 這個介面只負責「產出」T
interface Producer<out T> {
  produce(): T;
}

// in T：T 只出現在「參數」位置 → 這個介面只負責「接收」T
interface Consumer<in T> {
  consume(value: T): void;
}

class Animal {
  name = "animal";
}
class Dog extends Animal {
  bark() {}
}

// ---------- 協變 out：方向跟繼承一樣 ----------
const dogProducer: Producer<Dog> = { produce: () => new Dog() };

// ✅ 狗工廠可以當動物工廠用
//    因為呼叫端拿到的是狗，而狗本來就是動物 —— 拿到的東西「更具體」永遠安全
const producer: Producer<Animal> = dogProducer;

const animalProducer: Producer<Animal> = { produce: () => new Animal() };

// ❌ 反過來不行：動物工廠不能當狗工廠用
//    呼叫端以為會拿到狗、想呼叫 .bark()，結果工廠可能生出一隻貓
// const wrong: Producer<Dog> = animalProducer;
// Type 'Producer<Animal>' is not assignable to type 'Producer<Dog>'.

// ---------- 逆變 in：方向跟繼承相反 ----------
const animalConsumer: Consumer<Animal> = { consume: (a) => console.log(a.name) };

// ✅ 「什麼動物都能處理」的處理器，可以當成「處理狗」的處理器用
//    因為呼叫端只會餵它狗，而它連任何動物都接得住 —— 接受範圍「更寬」永遠安全
const consumer: Consumer<Dog> = animalConsumer;

const dogConsumer: Consumer<Dog> = { consume: (d) => d.bark() };

// ❌ 反過來不行：只會處理狗的處理器，不能當成「處理任何動物」用
//    呼叫端可能餵它一隻貓，而 consume 內部會呼叫 .bark() —— 執行期就炸了
// const wrong2: Consumer<Animal> = dogConsumer;
// Type 'Consumer<Dog>' is not assignable to type 'Consumer<Animal>'.
```

**為什麼逆變的方向是反的？**

關鍵在於「**誰在保證什麼**」：

- 協變（產出）：我承諾「給你一隻動物」，實際給狗 —— **給得比承諾的更具體**，收下的人不會有問題。
- 逆變（接收）：我需要「一個能處理狗的東西」，拿到一個「什麼動物都能處理」的 —— **接受得比需求更寬**，餵什麼進去都不會噎到。

一句口訣：**產出可以更具體，接收可以更寬鬆。**

**加了標記到底差在哪？**

不標記時 TypeScript 也會自動推斷變異方向，但有個容易踩的坑：**用 method 語法宣告的參數，TypeScript 預設是「雙變（bivariant）」的，兩個方向都放行**：

```typescript
// 沒有 in 標記
interface ConsumerNoMark<T> {
  consume(value: T): void;
}

const dogOnly: ConsumerNoMark<Dog> = { consume: (d) => d.bark() };
const anyAnimal: ConsumerNoMark<Animal> = dogOnly; // ⚠️ 沒報錯！但這其實不安全
anyAnimal.consume(new Animal()); // 執行期爆炸：Animal 沒有 bark()
```

加上 `in` 標記後，同樣的寫法就會在編譯階段被擋下來。所以標記的效果是：**讓編譯器檢查更快、錯誤訊息更貼近根源，並且把 method 語法的雙變漏洞補起來。**

**什麼時候用得到？** 寫一般業務程式幾乎不需要手動標記；主要是在設計「要給別人用的型別庫」時，用它把介面的使用方式（唯讀 / 唯寫）寫進型別裡，順便讓誤用在編譯期就現形。第 13 章「型別層級程式設計」還會再補上第三種變異——`in out`（不變，既產出又接收，方向不能改）。

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

**用途：把「這個函式可能會失敗」寫進回傳型別，讓編譯器強迫呼叫端處理錯誤。**

用 `try/catch` 有兩個問題：一是從函式簽章上**完全看不出它會不會丟錯**，呼叫端很容易忘記包 `try`；二是 TypeScript 中 `catch (e)` 的 `e` 型別是 `unknown`（開啟 `useUnknownInCatchVariables` 時），還要自己判斷型別。Result 模式改用回傳值表達失敗，成功與失敗兩種形狀都寫在型別裡：

```typescript
// 可辨識聯合（Discriminated Union）：用 success 這個字面量欄位當「標籤」
// E 給預設值 Error，不指定時就是一般的 Error 物件
type Result<T, E = Error> =
  | { success: true; data: T }    // 成功時只有 data，沒有 error
  | { success: false; error: E }; // 失敗時只有 error，沒有 data

// 回傳型別直接宣告「我可能失敗，而且失敗時錯誤是 string」
// 呼叫端從簽章就看得出來，不會漏掉錯誤處理
function divide(a: number, b: number): Result<number, string> {
  if (b === 0) {
    // 除以零是「預期內」的失敗，不是程式 bug，所以用回傳值而非 throw
    return { success: false, error: "Cannot divide by zero" };
  }
  return { success: true, data: a / b };
}

const result = divide(10, 2);

// 關鍵：檢查 success 之後，TypeScript 會自動縮窄型別
// 沒有先檢查就存取 result.data 會直接編譯錯誤 —— 這就是「強迫處理錯誤」的來源
if (result.success) {
  console.log(result.data); // 型別縮窄為 number（這個分支沒有 error 可用）
} else {
  console.error(result.error); // 型別縮窄為 string（這個分支沒有 data 可用）
}

// console.log(result.data); // ❌ 沒先檢查 success，data 不存在於失敗分支
```

**常見使用場景**

- **API 呼叫**：網路失敗、4xx/5xx 都是預期內的結果，`Result<User, ApiError>` 比 throw 好處理
- **表單／輸入驗證**：`Result<ValidatedForm, ValidationError[]>`，把錯誤訊息一起帶回 UI
- **解析類操作**：`JSON.parse`、日期字串轉換、外部檔案讀取，失敗是家常便飯
- **需要把錯誤傳過多層**：throw 會穿透中間層，Result 則是明確地一層層傳遞

**什麼時候不要用**：真正的程式錯誤（不該發生的狀態、寫錯的邏輯）還是應該 `throw`，因為那種情況你要的是「立刻炸掉並看到 stack trace」，而不是安靜地回傳一個錯誤物件。判準是：**失敗是不是業務流程的一部分？** 是就用 Result，不是就 throw。

> 這個模式來自 Rust 的 `Result<T, E>` 與 Go 的 `(value, err)` 慣例。前端生態中 [neverthrow](https://github.com/supermacro/neverthrow)、`fp-ts` 的 `Either` 都是同一個概念的成熟實作。

### Builder 模式

**用途：把「參數很多、大多選填、而且要一步步組出來」的物件，改成可讀性高的鏈式呼叫。**

如果不用 Builder，這種需求通常會變成一個吃十幾個參數的函式，或是一個塞滿 `undefined` 的設定物件 —— 呼叫端看不出每個位置代表什麼，加新選項還得改簽章。Builder 讓每個設定都有名字、可以自由省略、順序也不重要：

```typescript
interface User {
  id: number;
  name: string;
  age: number;
}

// 泛型 T 代表「這個 query 是在查哪張表的資料」
// 有了 T，orderBy 才能限制只填得了 User 真的有的欄位
class QueryBuilder<T> {
  // 中間狀態都設為 private：外部只能透過方法修改，避免被亂改
  private conditions: string[] = [];
  private orderByField?: string;
  private limitValue?: number;

  where(condition: string): QueryBuilder<T> {
    this.conditions.push(condition); // 累加，所以可以連續呼叫多次 where
    return this; // 回傳自己 → 才能接著 .orderBy().limit()，這就是鏈式呼叫的原理
  }

  // keyof T 擋掉不存在的欄位；再交集 & string 是因為 keyof T 可能含 symbol/number，
  // 而這裡要把它拼進 SQL 字串，必須確保是 string
  orderBy(field: keyof T & string): QueryBuilder<T> {
    this.orderByField = field;
    return this;
  }

  limit(count: number): QueryBuilder<T> {
    this.limitValue = count;
    return this;
  }

  // build() 是「終結方法」：結束鏈式呼叫，把累積的狀態轉成最終產物
  // 注意它回傳 string 而不是 this，所以鏈到這裡就必須停下來
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

// 每個設定都有名字、都可以省略，順序也不影響結果
const query = new QueryBuilder<User>()
  .where("age > 18")
  .orderBy("name") // ✅ name 是 User 的欄位
  // .orderBy("phone") // ❌ User 沒有 phone，編譯期就擋下來
  .limit(10)
  .build(); // "SELECT * FROM table WHERE age > 18 ORDER BY name LIMIT 10"
```

**常見使用場景**

- **查詢建構器**：Knex、TypeORM、Prisma 的 query API 都是這個形狀
- **HTTP 請求封裝**：`request().url(...).header(...).timeout(...).send()`
- **測試資料工廠**：`userFactory().withName("Alice").withAge(30).build()`，只覆寫你在意的欄位，其他用預設值
- **複雜設定物件**：圖表設定、表單 schema、動畫序列這類「選項多到記不住順序」的東西

**兩個實作重點**

1. **每個設定方法都要 `return this`**，鏈式才接得下去；`build()` 這種終結方法則回傳最終產物。
2. 如果這個 Builder 之後可能被繼承，把回傳型別從 `QueryBuilder<T>` 改成 `this`，子類別呼叫父類別方法後才不會退化成父類別型別、接不到自己新增的方法。

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

**先搞懂 EventEmitter 是什麼**：它就是「訂閱 / 發佈」機制 —— `on("事件名", 回呼)` 是訂閱，`emit("事件名", 資料)` 是發佈，發佈時所有訂閱該事件的回呼都會被叫到。你其實天天在用：`button.addEventListener("click", handler)` 就是這個東西，Node.js 的 `EventEmitter`、Vue 的 `$emit`、各種狀態管理套件的訂閱機制也都是。

**沒有泛型會怎樣？** 事件名和資料形狀完全對不起來：

```typescript
class BadEmitter {
  private listeners: Record<string, Array<(payload: any) => void>> = {};

  on(event: string, listener: (payload: any) => void): void { /* ... */ }
  emit(event: string, payload: any): void { /* ... */ }
}

const bad = new BadEmitter();
bad.on("login", (payload) => console.log(payload.userId)); // payload 是 any，沒有提示
bad.emit("logni", { userId: 1 });  // ⚠️ 事件名打錯，不會報錯，只是永遠沒人收到
bad.emit("login", { name: "Gary" }); // ⚠️ 資料形狀錯了，也不會報錯，執行期才拿到 undefined
```

這題的目標就是：**用泛型把「事件名稱」和「該事件的資料形狀」綁在一起**，讓上面三個問題全部在編譯期被擋下來。

#### 小提醒：為什麼事件表只能用 `type`，不能用 `interface`？

這是很多人第一次寫這種泛型類別時會撞到、而且錯誤訊息看起來莫名其妙的坑。**內容一模一樣的兩個型別，只因為一個用 `interface`、一個用 `type`，結果一個過不了、一個過得了：**

```typescript
class EventEmitter<T extends Record<string, unknown>> {
  private listeners: { [K in keyof T]?: Array<(payload: T[K]) => void> } = {};

  on<K extends keyof T>(event: K, listener: (payload: T[K]) => void): void {
    (this.listeners[event] ??= []).push(listener);
  }
}

// 用 interface 宣告事件表
interface AppEventsBad {
  login: { userId: number };
}
// new EventEmitter<AppEventsBad>();
// ❌ Type 'AppEventsBad' does not satisfy the constraint 'Record<string, unknown>'.
//      Index signature for type 'string' is missing in type 'AppEventsBad'.

// 內容完全相同，只是改用 type 別名
type AppEvents = {
  login: { userId: number };
};
new EventEmitter<AppEvents>(); // ✅ 通過
```

**第一步：`Record<string, unknown>` 到底在要求什麼？**

它展開之後就是一個「索引簽章」：

```typescript
type Record<string, unknown> = { [key: string]: unknown };
// 意思是：「不管你用哪個字串當鍵去存取，都必須取得到一個 unknown」
```

注意是**任何**字串鍵，不只是你寫出來的那幾個。所以編譯器要放行，必須先確定「這個型別的屬性就這些，不會再多」。

**第二步：`interface` 為什麼不能確定？因為它是「開放」的**

`interface` 有一個 `type` 沒有的能力叫**宣告合併（Declaration Merging）**：同名的 interface 可以在任何地方再宣告一次，欄位會自動合併進去。

```typescript
interface AppEventsBad {
  login: { userId: number };
}

// 完全合法！可以在另一個檔案、甚至是別人的套件裡追加欄位
interface AppEventsBad {
  somethingWeird: () => void; // 這個值的型別不見得能當作 unknown 的字典值使用
}

// 現在 AppEventsBad 同時有 login 和 somethingWeird
```

正因為隨時可能被追加欄位，編譯器**無法保證它現在看到的欄位就是全部**，所以拒絕替 `interface` 推導出隱式的索引簽章 —— 這就是錯誤訊息說的 `Index signature ... is missing`。

反過來，`type` 別名是**封閉**的：宣告完就定死，同名再宣告一次會直接報「重複識別符」的錯。編譯器確定看得到全部欄位，逐一檢查值型別都能指派給 `unknown` 之後，就會給它一個隱式索引簽章，於是通過。

**一句話總結：`interface` 是開放的（可被追加），`type` 是封閉的（宣告即定案）。需要「屬性集合已完全確定」的檢查，只有封閉的 `type` 過得了。**

**第三步：三種解法（依推薦程度排序）**

```typescript
// 解法 1：事件表改用 type —— 最簡單，本題採用
type AppEvents1 = { login: { userId: number } };

// 解法 2：把約束放寬成 T extends object
//         事件表就能用 interface 了，但也失去「值必須是資料形狀」的限制
class Emitter2<T extends object> { /* ... */ }

// 解法 3：interface 自己補上明確的索引簽章
//         能過，但通常不建議 —— 補了之後任何字串鍵都變合法，
//         打錯事件名（emitter.emit("logni", ...)）反而不會報錯，等於自廢武功
interface AppEvents3 {
  [key: string]: unknown;
  login: { userId: number };
}
```

**這不只是這一題的問題**：只要你把 `interface` 傳給任何期待 `Record<string, unknown>` 的地方（不論是泛型約束還是一般指派），都會撞到同一個錯誤：

```typescript
interface Config {
  port: number;
}
declare const config: Config;

// const dict: Record<string, unknown> = config;
// ❌ 同樣的錯誤：Index signature for type 'string' is missing in type 'Config'

type ConfigType = { port: number };
declare const configType: ConfigType;
const dict2: Record<string, unknown> = configType; // ✅
```

日誌工具、序列化函式、`Object.entries` 的封裝這類「把物件當字典用」的 API 很常要求 `Record<string, unknown>`，遇到時就想起這條規則。

<details>
<summary>參考解答</summary>

把 `T` 約束成「事件名稱對應資料型別」的對照表（`Record<string, unknown>`）。內部用映射型別 `{ [K in keyof T]?: ... }` 讓每個事件各存一組監聽器；`on` 與 `emit` 各自帶一個 `K extends keyof T`，這樣選定某個事件後，該事件的 `payload` 型別就會自動對上 `T[K]`。如小提醒所述，事件表必須用 `type` 宣告才能滿足 `Record<string, unknown>` 約束。

```typescript
// T 是一張「事件名稱 -> 該事件的資料形狀」對照表
// 約束成 Record<string, unknown> 表示：鍵是事件名（字串），值是任意資料形狀
class EventEmitter<T extends Record<string, unknown>> {
  // 映射型別：逐一走訪 T 的每個鍵 K，替它建一個「監聽器陣列」欄位
  //   [K in keyof T] → 對 T 的每個事件名各產生一個欄位
  //   ?              → 選填，因為一開始是 {}，還沒人訂閱的事件根本沒有這個 key
  //   T[K]           → 該事件對應的資料型別，讓回呼的 payload 型別自動對上
  private listeners: { [K in keyof T]?: Array<(payload: T[K]) => void> } = {};

  // K 宣告在「方法」上而不是類別上：同一個 emitter 要能處理多個不同事件，
  // 每次呼叫 on 時 K 才被決定成這次訂閱的那一個事件名
  on<K extends keyof T>(event: K, listener: (payload: T[K]) => void): void {
    // ??= 是「不存在才指定」：第一次訂閱該事件時先建立空陣列，再把監聽器推進去
    (this.listeners[event] ??= []).push(listener);
  }

  // event 與 payload 共用同一個 K，兩者型別因此被綁死：
  // 選了 "login"，payload 就必須是 T["login"]
  emit<K extends keyof T>(event: K, payload: T[K]): void {
    // ?. 是因為該事件可能一個訂閱者都沒有（欄位是選填的，值可能是 undefined）
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

// 訂閱：K 被推斷成 "login"，所以 payload 自動是 { userId: number }
// 完全不用手動標註型別，payload. 打下去就有 userId 的自動完成
emitter.on("login", (payload) => console.log(`User ${payload.userId} logged in`));
emitter.on("logout", (payload) => console.log(`${payload.userId}: ${payload.reason}`));

// 發佈：事件名與資料形狀都會被檢查
emitter.emit("login", { userId: 1 });
emitter.emit("logout", { userId: 1, reason: "timeout" });

// emitter.emit("login", { reason: "x" });
// ❌ payload 型別不符：login 事件需要 { userId: number }

// emitter.emit("logni", { userId: 1 });
// ❌ 事件名打錯："logni" 不是 AppEvents 的鍵
```

**關鍵理解：映射型別到底展開成什麼？**

`{ [K in keyof T]?: Array<(payload: T[K]) => void> }` 看起來抽象，但把 `AppEvents` 代進去之後，它其實只是這個具體形狀：

```typescript
// listeners 的實際型別（TypeScript 幫你自動展開的結果）
{
  login?: Array<(payload: { userId: number }) => void>;
  logout?: Array<(payload: { userId: number; reason: string }) => void>;
}
```

也就是說，**這個映射型別替你把「每個事件各自存一組型別正確的監聽器」這件事寫出來了** —— 事件表加一個事件，`listeners` 就自動多一個對應欄位，你不用改任何一行類別的程式碼。

**關鍵理解：為什麼有 `T` 和 `K` 兩層型別參數？**

| 型別參數 | 宣告位置 | 代表什麼 | 什麼時候被決定 |
| --- | --- | --- | --- |
| `T` | 類別上 | **整張**事件表（這個 emitter 認得哪些事件） | `new EventEmitter<AppEvents>()` 時 |
| `K` | 方法上 | **這一次**操作的是哪一個事件 | 每次呼叫 `on` / `emit` 時 |

如果把 `K` 也放到類別上（`class EventEmitter<T, K>`），那一個實例就只能綁定一個事件，完全失去意義。**「整體的型別放類別、單次操作的型別放方法」是泛型類別很常見的分工。**

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
