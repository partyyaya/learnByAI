# 第四章：介面與型別別名

## 4.1 介面（Interface）

介面是 TypeScript 中定義物件結構的主要方式。

### 基本介面

```typescript
interface User {
  id: number;
  name: string;
  email: string;
}

const user: User = {
  id: 1,
  name: "Gary",
  email: "gary@example.com",
};

// ❌ 缺少必要屬性
// const incomplete: User = { id: 1, name: "Gary" };

// ❌ 多餘的屬性
// const extra: User = { id: 1, name: "Gary", email: "...", age: 30 };
```

### 可選屬性

```typescript
interface Product {
  id: number;
  name: string;
  price: number;
  description?: string; // 可選
  tags?: string[];      // 可選
}

const product: Product = {
  id: 1,
  name: "TypeScript Book",
  price: 500,
  // description 和 tags 可以不提供
};
```

### 唯讀屬性

```typescript
interface Config {
  readonly apiUrl: string;
  readonly port: number;
  debug: boolean;
}

const config: Config = {
  apiUrl: "https://api.example.com",
  port: 3000,
  debug: false,
};

// config.apiUrl = "..."; // ❌ 無法修改 readonly 屬性
config.debug = true;      // ✅ 非 readonly 屬性可以修改
```

---

## 4.2 介面擴展（extends）

```typescript
// 基礎介面
interface BaseEntity {
  id: number;
  createdAt: Date;
  updatedAt: Date;
}

// 繼承擴展
interface User extends BaseEntity {
  name: string;
  email: string;
}

interface Post extends BaseEntity {
  title: string;
  content: string;
  authorId: number;
}

// 多重繼承
interface AdminUser extends User {
  role: "admin";
  permissions: string[];
}

const admin: AdminUser = {
  id: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
  name: "Admin Gary",
  email: "admin@example.com",
  role: "admin",
  permissions: ["read", "write", "delete"],
};
```

---

## 4.3 型別別名（Type Alias）

使用 `type` 關鍵字定義型別別名。

### 基本用法

```typescript
// 物件型別
type User = {
  id: number;
  name: string;
  email: string;
};

// 原始型別的別名
type ID = string | number;
type Email = string;

// 聯合型別
type Status = "active" | "inactive" | "suspended";

// 元組
type Coordinate = [number, number];

// 函式型別
type Formatter = (value: number) => string;
```

### 交集型別（Intersection）

```typescript
type HasId = {
  id: number;
};

type HasTimestamps = {
  createdAt: Date;
  updatedAt: Date;
};

type HasName = {
  name: string;
};

// 合併多個型別
type User = HasId & HasTimestamps & HasName & {
  email: string;
};

const user: User = {
  id: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
  name: "Gary",
  email: "gary@example.com",
};
```

---

## 4.4 Interface vs Type

| 特性 | Interface | Type |
|------|-----------|------|
| 物件結構 | ✅ | ✅ |
| extends 繼承 | ✅ | ❌（用 `&` 交集代替） |
| implements | ✅ | ✅ |
| 宣告合併 | ✅ | ❌ |
| 聯合型別 | ❌ | ✅ |
| 原始型別別名 | ❌ | ✅ |
| 元組 | ❌ | ✅ |
| 映射型別 | ❌ | ✅ |

### 宣告合併（Declaration Merging）

```typescript
// Interface 支援宣告合併
interface User {
  name: string;
}

interface User {
  age: number;
}

// 合併結果：User 同時有 name 和 age
const user: User = { name: "Gary", age: 30 };

// Type 不支援宣告合併
// type User = { name: string };
// type User = { age: number }; // ❌ 重複定義
```

實務上宣告合併真正常用的場合，是**模組擴充（Module Augmentation）**——替第三方套件或全域型別補充自訂屬性，而不是像上面那樣在同一檔案裡刻意重複宣告：

```typescript
// 替 Express 的 Request 型別加上自訂屬性（例如登入後掛上的 user）
declare global {
  namespace Express {
    interface Request {
      user?: { id: number; name: string };
    }
  }
}

// 之後在任何看得到這份宣告的檔案中，req.user 都能直接使用且有型別
// app.get("/me", (req, res) => res.json(req.user));

export {}; // declare global 只能出現在「模組」裡；沒有任何 import/export 的檔案會被當成純指令碼，需要這行把它變成模組
```

> 💡 這才是宣告合併存在的主因：讓你在不修改套件原始碼的情況下，為既有型別「補洞」。

### 何時使用哪個？

```typescript
// 自足：補上此範例引用到的型別定義
interface User {
  id: number;
  name: string;
  email: string;
}
interface CreateUserDto {
  name: string;
  email: string;
  password: string;
}
interface Success<T> {
  ok: true;
  value: T;
}
interface Failure {
  ok: false;
  error: string;
}

// ✅ 使用 Interface：定義物件結構、需要繼承、對外 API
interface UserService {
  getUser(id: number): Promise<User>;
  createUser(data: CreateUserDto): Promise<User>;
}

// ✅ 使用 Type：聯合型別、元組、映射型別、複合型別
type Result<T> = Success<T> | Failure;
type Pair = [string, number];
type ReadonlyUser = Readonly<User>;
```

> 💡 **建議**：定義物件結構優先用 `interface`，其他型別操作用 `type`。

---

## 4.5 索引簽名（Index Signatures）

```typescript
// 動態鍵值
interface StringMap {
  [key: string]: string;
}

const translations: StringMap = {
  hello: "你好",
  goodbye: "再見",
  thanks: "謝謝",
};

// 混合固定與動態屬性
interface UserProfile {
  name: string;
  email: string;
  [key: string]: string; // 其他動態屬性
}

const profile: UserProfile = {
  name: "Gary",
  email: "gary@example.com",
  github: "gary-cai",
  twitter: "@gary",
};
```

> ⚠️ 固定屬性的型別必須能指派給索引簽名的值型別，否則會出現 TS2411 錯誤：
>
> ```typescript
> interface Invalid {
>   name: string;
>   age: number;          // ❌ TS2411：number 不能指派給索引簽名的 string
>   [key: string]: string;
> }
> ```

### Record 工具型別（替代方案）

```typescript
// 使用 Record 更簡潔
type TranslationMap = Record<string, string>;

const translations: TranslationMap = {
  hello: "你好",
  goodbye: "再見",
};

// 限定 key
type UserRole = "admin" | "editor" | "viewer";
type RolePermissions = Record<UserRole, string[]>;

const permissions: RolePermissions = {
  admin: ["read", "write", "delete"],
  editor: ["read", "write"],
  viewer: ["read"],
};
```

---

## 4.6 介面與函式

```typescript
// 自足：補上 SearchFunc 引用到的 SearchResult 型別
interface SearchResult {
  id: number;
  title: string;
}

// 定義可呼叫的介面
interface SearchFunc {
  (query: string, limit?: number): Promise<SearchResult[]>;
}

// 帶有屬性的可呼叫介面
interface Logger {
  (message: string): void;
  level: "info" | "warn" | "error";
  prefix: string;
}

function createLogger(prefix: string): Logger {
  const logger = function (message: string) {
    console.log(`[${logger.prefix}] ${message}`);
  } as Logger;

  logger.level = "info";
  logger.prefix = prefix;

  return logger;
}

const log = createLogger("App");
log("Server started");    // [App] Server started
console.log(log.level);   // "info"
```

---

## 4.7 實戰模式

### API Response 型別設計

```typescript
// 自足：補上此範例引用到的 User 型別
interface User {
  id: number;
  name: string;
  email: string;
}

// 通用回應結構
interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
}

interface PaginatedResponse<T> extends ApiResponse<T[]> {
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

// 使用
type UserListResponse = PaginatedResponse<User>;
type UserDetailResponse = ApiResponse<User>;
```

### DTO（Data Transfer Object）模式

```typescript
interface User {
  id: number;
  name: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
}

// 建立用 DTO — 排除自動生成的欄位
type CreateUserDto = Omit<User, "id" | "passwordHash" | "createdAt"> & {
  password: string;
};

// 更新用 DTO — 所有欄位可選
type UpdateUserDto = Partial<Pick<User, "name" | "email">>;
```

---

## 練習題

### 練習 1：定義介面

為一個電商系統定義以下介面：
- `Product`：id、名稱、價格、庫存、分類、可選的描述
- `CartItem`：包含 Product 和數量
- `Order`：id、購買者、訂單項目陣列、總金額、狀態

<details>
<summary>參考解答</summary>

先定義最底層的 `Product`，把「可能不存在」的描述用 `?` 標成可選；`CartItem` 直接把整個 `Product` 當屬性組合進來（組合優於重複欄位）；`Order` 再持有一組 `CartItem`，並用字面量聯合型別限定 `status` 只能是幾個合法狀態。

```typescript
interface Product {
  id: number;
  name: string;
  price: number;
  stock: number;
  category: string;
  description?: string; // 可選的描述
}

interface CartItem {
  product: Product;
  quantity: number;
}

interface Order {
  id: number;
  buyer: string;
  items: CartItem[];
  total: number;
  status: "pending" | "paid" | "shipped" | "completed" | "cancelled";
}

const order: Order = {
  id: 1,
  buyer: "Gary",
  items: [
    {
      product: { id: 1, name: "TS Book", price: 500, stock: 10, category: "book" },
      quantity: 2,
    },
  ],
  total: 1000,
  status: "pending",
};
```

重點：用字面量聯合型別（`"pending" | ...`）取代 `string`，可以讓非法狀態在編譯期就被擋下；欄位「可能沒有」時才用 `?`，不要濫用。

</details>

### 練習 2：介面繼承

設計一個動物類別體系，使用介面繼承：

```typescript
interface Animal { /* ... */ }
interface Pet extends Animal { /* ... */ }
interface Dog extends Pet { /* ... */ }
interface Cat extends Pet { /* ... */ }
```

<details>
<summary>參考解答</summary>

把共通欄位往上放：所有動物都有 `name`、`age`；`Pet` 在動物之上多了 `owner`；`Dog`、`Cat` 再各自補上專屬欄位與行為方法。每一層 `extends` 都會累積上層所有成員，所以 `Dog` 同時擁有 `name`、`age`、`owner`、`breed`、`bark`。

```typescript
interface Animal {
  name: string;
  age: number;
}

interface Pet extends Animal {
  owner: string;
}

interface Dog extends Pet {
  breed: string;
  bark(): void;
}

interface Cat extends Pet {
  indoor: boolean;
  meow(): void;
}

const dog: Dog = {
  name: "Lucky",
  age: 3,
  owner: "Gary",
  breed: "Shiba",
  bark: () => console.log("Woof!"),
};

const cat: Cat = {
  name: "Kitty",
  age: 2,
  owner: "Gary",
  indoor: true,
  meow: () => console.log("Meow!"),
};
```

重點：把共用欄位抽到上層介面、專屬欄位留在下層，是介面繼承最典型的用途；`extends` 是累加而非取代。

</details>

### 練習 3：Interface vs Type

將以下 Type 改寫為 Interface，並思考哪些無法用 Interface 表達：

```typescript
// 自足：補上 UserMap / ReadonlyUser 引用到的 User
interface User {
  id: number;
  name: string;
}

type Status = "pending" | "active" | "inactive";
type Point = [number, number];
type UserMap = Record<string, User>;
type ReadonlyUser = Readonly<User>;
```

<details>
<summary>參考解答</summary>

逐一檢視：聯合型別（`Status`）、元組（`Point`）、以及 `Readonly<T>` 這類映射工具型別，都**無法**用 `interface` 表達，只能維持 `type`。唯一能改寫的是 `UserMap`——`Record<string, User>` 本質是索引簽名，`interface` 可以用 `[key: string]: User` 近似表達。

```typescript
interface User {
  id: number;
  name: string;
}

// ❌ 聯合型別無法用 interface 表達，只能用 type
type Status = "pending" | "active" | "inactive";

// ❌ 元組無法用 interface 表達，只能用 type
type Point = [number, number];

// Record 映射型別：可用索引簽名近似改寫為 interface
type UserMap = Record<string, User>;
interface UserMapInterface {
  [key: string]: User;
}

// ❌ Readonly<T> 這類映射型別無法用 interface 表達，只能用 type
type ReadonlyUser = Readonly<User>;
```

重點：`interface` 專長是「描述物件形狀」與繼承；聯合、元組、映射型別這些「型別運算」是 `type` 的地盤。判斷準則就是本章 4.4 那張對照表。

</details>

---

> 下一章：[第五章 — 類別與物件導向程式設計](./05-classes.md)
