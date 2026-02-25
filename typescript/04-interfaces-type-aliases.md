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

### 何時使用哪個？

```typescript
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

### 練習 2：介面繼承

設計一個動物類別體系，使用介面繼承：

```typescript
interface Animal { /* ... */ }
interface Pet extends Animal { /* ... */ }
interface Dog extends Pet { /* ... */ }
interface Cat extends Pet { /* ... */ }
```

### 練習 3：Interface vs Type

將以下 Type 改寫為 Interface，並思考哪些無法用 Interface 表達：

```typescript
type Status = "pending" | "active" | "inactive";
type Point = [number, number];
type UserMap = Record<string, User>;
type ReadonlyUser = Readonly<User>;
```

---

> 下一章：[第五章 — 類別與物件導向程式設計](./05-classes.md)
