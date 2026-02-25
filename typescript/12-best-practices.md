# 第十二章：最佳實踐與常見模式

## 12.1 型別設計原則

### 優先使用 interface 定義物件結構

```typescript
// ✅ 使用 interface 定義物件
interface User {
  id: number;
  name: string;
  email: string;
}

// ✅ 使用 type 處理聯合、交集、映射等
type Status = "active" | "inactive" | "suspended";
type UserWithStatus = User & { status: Status };
type ReadonlyUser = Readonly<User>;
```

### 避免使用 any

```typescript
// ❌ 使用 any
function parse(data: any): any {
  return JSON.parse(data);
}

// ✅ 使用 unknown + 型別守衛
function parse(data: string): unknown {
  return JSON.parse(data);
}

// ✅ 使用泛型
function parse<T>(data: string): T {
  return JSON.parse(data) as T;
}

// ✅ 更安全的做法：runtime validation
import { z } from "zod";

const UserSchema = z.object({
  id: z.number(),
  name: z.string(),
  email: z.string().email(),
});

type User = z.infer<typeof UserSchema>;

function parseUser(data: string): User {
  return UserSchema.parse(JSON.parse(data));
}
```

### 善用字面值型別和聯合型別

```typescript
// ❌ 過度寬泛
interface Button {
  variant: string;
  size: string;
}

// ✅ 精確定義
interface Button {
  variant: "primary" | "secondary" | "danger" | "ghost";
  size: "sm" | "md" | "lg";
}
```

---

## 12.2 型別安全的錯誤處理

### Result 模式

```typescript
type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

// 使用
async function fetchUser(id: number): Promise<Result<User, string>> {
  try {
    const res = await fetch(`/api/users/${id}`);
    if (!res.ok) {
      return err(`HTTP Error: ${res.status}`);
    }
    const user = await res.json();
    return ok(user);
  } catch (e) {
    return err(`Network Error: ${(e as Error).message}`);
  }
}

const result = await fetchUser(1);
if (result.ok) {
  console.log(result.value.name); // 型別安全
} else {
  console.error(result.error);    // 型別安全
}
```

### 自定義 Error 類別

```typescript
class AppError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "AppError";
  }
}

class NotFoundError extends AppError {
  constructor(resource: string, id: string | number) {
    super(`${resource} with id ${id} not found`, "NOT_FOUND", 404);
    this.name = "NotFoundError";
  }
}

class ValidationError extends AppError {
  constructor(
    message: string,
    public fields: Record<string, string>,
  ) {
    super(message, "VALIDATION_ERROR", 400);
    this.name = "ValidationError";
  }
}

// 型別安全的錯誤處理
function handleError(error: unknown): void {
  if (error instanceof NotFoundError) {
    console.log(`404: ${error.message}`);
  } else if (error instanceof ValidationError) {
    console.log(`Validation: ${JSON.stringify(error.fields)}`);
  } else if (error instanceof AppError) {
    console.log(`App Error [${error.code}]: ${error.message}`);
  } else {
    console.log("Unknown error:", error);
  }
}
```

---

## 12.3 不可變資料模式

```typescript
// 使用 Readonly 防止修改
interface AppState {
  readonly user: Readonly<User> | null;
  readonly theme: "light" | "dark";
  readonly notifications: readonly Notification[];
}

// 深層唯讀
type DeepReadonly<T> = {
  readonly [K in keyof T]: T[K] extends object ? DeepReadonly<T[K]> : T[K];
};

type ImmutableState = DeepReadonly<AppState>;

// as const 建立不可變字面值
const ROUTES = {
  home: "/",
  users: "/users",
  settings: "/settings",
} as const;

type Route = (typeof ROUTES)[keyof typeof ROUTES];
// "/" | "/users" | "/settings"
```

---

## 12.4 型別安全的事件系統

```typescript
// 使用泛型定義事件映射
interface EventMap {
  "user:login": { userId: number; timestamp: Date };
  "user:logout": { userId: number };
  "notification:new": { message: string; type: "info" | "warning" | "error" };
  "theme:change": { theme: "light" | "dark" };
}

class TypedEventEmitter<T extends Record<string, any>> {
  private listeners = new Map<keyof T, Set<Function>>();

  on<K extends keyof T>(event: K, handler: (data: T[K]) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
  }

  off<K extends keyof T>(event: K, handler: (data: T[K]) => void): void {
    this.listeners.get(event)?.delete(handler);
  }

  emit<K extends keyof T>(event: K, data: T[K]): void {
    this.listeners.get(event)?.forEach((handler) => handler(data));
  }
}

// 使用
const emitter = new TypedEventEmitter<EventMap>();

emitter.on("user:login", (data) => {
  // data 的型別自動推斷為 { userId: number; timestamp: Date }
  console.log(`User ${data.userId} logged in at ${data.timestamp}`);
});

emitter.emit("user:login", { userId: 1, timestamp: new Date() }); // ✅
// emitter.emit("user:login", { wrong: "data" }); // ❌ 型別錯誤
```

---

## 12.5 型別安全的 API 客戶端

```typescript
// 定義 API 路由結構
interface ApiRoutes {
  "GET /users": {
    query: { page?: number; limit?: number };
    response: User[];
  };
  "GET /users/:id": {
    params: { id: number };
    response: User;
  };
  "POST /users": {
    body: CreateUserDto;
    response: User;
  };
  "PUT /users/:id": {
    params: { id: number };
    body: UpdateUserDto;
    response: User;
  };
  "DELETE /users/:id": {
    params: { id: number };
    response: void;
  };
}

// 型別安全的 fetch 封裝
type ExtractMethod<T extends string> = T extends `${infer M} ${string}` ? M : never;
type ExtractPath<T extends string> = T extends `${string} ${infer P}` ? P : never;

async function apiClient<K extends keyof ApiRoutes>(
  route: K,
  options?: Partial<ApiRoutes[K]>,
): Promise<ApiRoutes[K]["response"]> {
  // 實作 fetch 邏輯...
  const response = await fetch(/* ... */);
  return response.json();
}

// 使用 — 完全型別安全
const users = await apiClient("GET /users", { query: { page: 1 } });
// users 的型別是 User[]

const user = await apiClient("GET /users/:id", { params: { id: 1 } });
// user 的型別是 User
```

---

## 12.6 常見的型別陷阱與解決方案

### 陷阱 1：物件字面值的多餘屬性檢查

```typescript
interface User {
  name: string;
  email: string;
}

// ❌ 直接字面值賦值 — 多餘屬性會報錯
const user: User = {
  name: "Gary",
  email: "gary@example.com",
  age: 30, // 錯誤：'age' 不存在於 User 中
};

// ✅ 透過變數賦值 — 多餘屬性不報錯（結構子型別）
const data = { name: "Gary", email: "gary@example.com", age: 30 };
const user: User = data; // OK
```

### 陷阱 2：陣列型別的協變問題

```typescript
interface Animal {
  name: string;
}
interface Dog extends Animal {
  breed: string;
}

// TypeScript 陣列是協變的（可能導致不安全的操作）
const dogs: Dog[] = [{ name: "Buddy", breed: "Labrador" }];
const animals: Animal[] = dogs; // ✅ 允許（但要小心）
animals.push({ name: "Kitty" }); // 這會破壞 dogs 陣列！

// 解決方案：使用 readonly
const dogs: readonly Dog[] = [{ name: "Buddy", breed: "Labrador" }];
const animals: readonly Animal[] = dogs;
// animals.push({ name: "Kitty" }); // ❌ readonly 不允許 push
```

### 陷阱 3：型別斷言的濫用

```typescript
// ❌ 危險的型別斷言
const user = {} as User;
console.log(user.name.toUpperCase()); // 執行時 Error！

// ✅ 正確的方式
const user: User = {
  name: "Gary",
  email: "gary@example.com",
};

// ✅ 如果真的需要漸進式建構
const user: Partial<User> = {};
user.name = "Gary";
user.email = "gary@example.com";
```

### 陷阱 4：可選鏈和 Nullish Coalescing

```typescript
interface Config {
  database?: {
    host?: string;
    port?: number;
  };
}

const config: Config = {};

// ❌ 不安全
// const host = config.database.host; // 可能 TypeError

// ✅ 可選鏈
const host = config.database?.host; // string | undefined

// ✅ Nullish Coalescing
const port = config.database?.port ?? 3306; // number
```

---

## 12.7 專案組織建議

### 目錄結構

```
src/
├── types/                 # 全域型別定義
│   ├── models/           # 資料模型型別
│   │   ├── user.ts
│   │   └── product.ts
│   ├── api/              # API 相關型別
│   │   ├── request.ts
│   │   └── response.ts
│   ├── common.ts         # 通用工具型別
│   └── index.ts          # barrel file
├── utils/                # 工具函式
│   ├── type-guards.ts    # 型別守衛函式
│   ├── validators.ts
│   └── formatters.ts
├── services/             # 業務邏輯
├── components/           # UI 元件
└── hooks/ (composables/) # 自定義 Hook / Composable
```

### 命名慣例

```typescript
// 介面：使用名詞，Pascal Case
interface UserProfile {}
interface ApiResponse<T> {}

// 型別別名：使用名詞或描述性名稱
type UserId = string;
type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

// 泛型參數命名
// T = Type（通用）
// K = Key
// V = Value
// E = Element / Error
// R = Return
// P = Props / Params

// ❌ 不推薦：I 前綴
interface IUser {}    // Java/C# 風格，TypeScript 不推薦

// ✅ 推薦：直接使用名稱
interface User {}
```

---

## 12.8 效能考量

### 避免過度複雜的型別

```typescript
// ❌ 過度複雜 — 可能導致 IDE 變慢
type DeepMerge<T, U> = {
  [K in keyof T | keyof U]: K extends keyof T
    ? K extends keyof U
      ? T[K] extends object
        ? U[K] extends object
          ? DeepMerge<T[K], U[K]>
          : U[K]
        : U[K]
      : T[K]
    : K extends keyof U
      ? U[K]
      : never;
};

// ✅ 適度的型別複雜度
type Merge<T, U> = Omit<T, keyof U> & U;
```

### 使用 Project References 加速大型專案

```json
// 根目錄 tsconfig.json
{
  "references": [
    { "path": "./packages/core" },
    { "path": "./packages/ui" }
  ]
}
```

### 適當使用 `skipLibCheck`

```json
{
  "compilerOptions": {
    "skipLibCheck": true // 跳過 .d.ts 檔案的型別檢查，加快編譯速度
  }
}
```

---

## 12.9 推薦工具生態系

| 工具 | 用途 | 說明 |
|------|------|------|
| [Zod](https://zod.dev/) | Runtime 驗證 | Schema 驗證 + 型別推論 |
| [tRPC](https://trpc.io/) | API 型別安全 | 端對端型別安全的 API |
| [Prisma](https://www.prisma.io/) | ORM | 自動產生型別安全的 DB 客戶端 |
| [ts-pattern](https://github.com/gvergnaud/ts-pattern) | 模式匹配 | 型別安全的模式匹配 |
| [Effect](https://effect.website/) | 函式式程式設計 | 型別安全的副作用管理 |
| [TypeBox](https://github.com/sinclairzx81/typebox) | JSON Schema | JSON Schema + TypeScript 型別 |
| [ts-reset](https://www.totaltypescript.com/ts-reset) | 型別修補 | 修復 TypeScript 內建型別的不足 |

### Zod 範例

```typescript
import { z } from "zod";

// 定義 Schema（同時是驗證規則和型別定義）
const UserSchema = z.object({
  id: z.number(),
  name: z.string().min(2).max(50),
  email: z.string().email(),
  age: z.number().int().positive().optional(),
  role: z.enum(["admin", "user", "guest"]),
});

// 自動推斷型別
type User = z.infer<typeof UserSchema>;
// { id: number; name: string; email: string; age?: number; role: "admin" | "user" | "guest" }

// Runtime 驗證
function createUser(data: unknown): User {
  return UserSchema.parse(data); // 驗證失敗會拋出 ZodError
}

// 安全驗證（不拋出錯誤）
function safeCreateUser(data: unknown) {
  const result = UserSchema.safeParse(data);
  if (result.success) {
    return result.data; // 型別為 User
  }
  console.error(result.error.issues);
  return null;
}
```

---

## 練習題

### 練習 1：重構挑戰

將以下充滿 `any` 的程式碼重構為型別安全的版本：

```typescript
function fetchData(url: any, options: any): any {
  return fetch(url, options).then((res: any) => res.json());
}

function processItems(items: any[]): any[] {
  return items.filter((item: any) => item.active).map((item: any) => ({
    id: item.id,
    label: item.name.toUpperCase(),
  }));
}
```

### 練習 2：型別安全的 Store

使用 TypeScript 設計一個簡易的型別安全狀態管理：

```typescript
// 定義 State、Actions、Getters 都有完整型別
const store = createStore({
  state: { count: 0, user: null as User | null },
  actions: {
    increment(state) { state.count++ },
    setUser(state, user: User) { state.user = user },
  },
  getters: {
    doubleCount(state) { return state.count * 2 },
  },
});
```

### 練習 3：綜合實作

選擇一個你熟悉的框架（Vue / React），建立一個完整的 TypeScript 專案，包含：
- 型別定義檔案
- 型別安全的 API 層
- 型別安全的狀態管理
- 元件的完整型別標註

---

## 總結

恭喜你完成了 TypeScript 完整教學課程！以下是重點回顧：

1. **型別是你的朋友** — 善用型別系統能在編譯時期就捕獲錯誤
2. **嚴格模式是底線** — 新專案務必開啟 `strict: true`
3. **避免 any** — 使用 `unknown` + 型別守衛取代
4. **善用工具型別** — `Partial`、`Pick`、`Omit` 等減少重複定義
5. **泛型是核心** — 掌握泛型才能寫出真正可複用的程式碼
6. **型別推論很強大** — 不需要標註每一個地方，讓 TypeScript 幫你推斷
7. **選擇合適的框架整合** — Vue、React、Nuxt、Next.js 都有成熟的 TypeScript 支援

> 持續練習，讓 TypeScript 成為你開發的利器！
