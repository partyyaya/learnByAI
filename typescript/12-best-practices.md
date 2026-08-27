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
```

只有型別和兩個建構子還不夠用——每次取值都要先 `if (r.ok)`，串三四層就變成巢狀地獄。Result 模式真正的價值在**組合工具**：

```typescript
// 成功才套用轉換，失敗原封不動往下傳
function map<T, U, E>(r: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return r.ok ? ok(fn(r.value)) : r;
}

// 轉換本身也可能失敗時用這個（避免 Result<Result<T>>）
function andThen<T, U, E>(
  r: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> {
  return r.ok ? fn(r.value) : r;
}

// 取值，失敗給預設
function unwrapOr<T, E>(r: Result<T, E>, fallback: T): T {
  return r.ok ? r.value : fallback;
}

// 兩邊都要處理成同一種東西（例如都轉成畫面文字）
function match<T, E, R>(
  r: Result<T, E>,
  handlers: { ok: (value: T) => R; err: (error: E) => R },
): R {
  return r.ok ? handlers.ok(r.value) : handlers.err(r.error);
}
```

#### 兩個容易漏掉的地方

**錯誤不要壓成 `string`。** 寫成 `Result<User, string>` 之後，呼叫端只拿到一段文字，沒辦法分辨「該重試」還是「該叫使用者改輸入」。用聯合型別，`switch` 才有 exhaustive 檢查。

**`res.json()` 回傳 `any`。** 這是最隱蔽的一個：

```typescript
async function fetchUser(id: number): Promise<Result<User, string>> {
  // ...
  const user = await res.json(); // any
  return ok(user);               // ❌ any 一路穿過，編譯器不會吭一聲
}
```

`ok(user)` 得到 `Result<any, never>`，可以指派給 `Result<User, string>`，所以 `result.value.name` 看起來型別安全——但那個 `User` 是標註出來的，**runtime 完全沒有驗證過**。API 少一個欄位或型別變了，錯誤會延後到某個 `undefined.xxx` 才爆。要在邊界擋下來：

```typescript
import { z } from "zod";

const UserSchema = z.object({
  id: z.number(),
  name: z.string(),
  email: z.string().email(),
});
type User = z.infer<typeof UserSchema>;

type FetchError =
  | { kind: "http"; status: number }
  | { kind: "network"; message: string }
  | { kind: "parse"; issues: string[] };

async function fetchUser(id: number): Promise<Result<User, FetchError>> {
  let res: Response;
  try {
    res = await fetch(`/api/users/${id}`);
  } catch (e) {
    return err({ kind: "network", message: (e as Error).message });
  }

  if (!res.ok) {
    return err({ kind: "http", status: res.status });
  }

  const parsed = UserSchema.safeParse(await res.json());
  if (!parsed.success) {
    return err({
      kind: "parse",
      issues: parsed.error.issues.map((i) => i.message),
    });
  }

  return ok(parsed.data); // 到這裡 User 才是真的
}
```

#### 使用

```typescript
// 注意：top-level await 需要檔案是 module，否則 TS1375
async function main() {
  const result = await fetchUser(1);

  // 只關心成功的情況
  const label = map(result, (u) => `${u.name} <${u.email}>`);
  console.log(unwrapOr(label, "(載入失敗)"));

  // 兩邊都要處理，且每種錯誤給不同訊息
  const msg = match(result, {
    ok: (u) => `Hello ${u.name}`,
    err: (e) => {
      switch (e.kind) {
        case "http":
          return `伺服器回 ${e.status}`;
        case "network":
          return `連線失敗：${e.message}`;
        case "parse":
          return `回傳格式不符：${e.issues.join(", ")}`;
      }
    },
  });
  console.log(msg);
}
```

四種情境的實際輸出：

| 情境 | `unwrapOr(label, ...)` | `match(...)` |
|---|---|---|
| 200 + 格式正確 | `Alice <a@example.com>` | `Hello Alice` |
| 404 | `(載入失敗)` | `伺服器回 404` |
| 200 但欄位型別錯 | `(載入失敗)` | `回傳格式不符：Invalid input: expected number, received string, ...` |
| fetch 直接 throw | `(載入失敗)` | `連線失敗：ECONNREFUSED` |

順帶一個誤解：`switch` 漏掉一個 `case` 時，TS **不會**在 `switch` 當場報錯——`err` 的回傳型別只是悄悄變成 `string | undefined`，錯誤要等到把它當 `string` 用的地方才浮出來。想在原地擋下來，加一個 `never` 兜底：

```typescript
switch (e.kind) {
  case "http":
    return `伺服器回 ${e.status}`;
  case "network":
    return `連線失敗：${e.message}`;
  default: {
    const _exhaustive: never = e;
    // ❌ TS2322: Type '{ kind: "parse"; issues: string[]; }'
    //    is not assignable to type 'never'
    return _exhaustive;
  }
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

// ---- 使用：拋出 ----
interface User { id: number; name: string; email: string }

const users = new Map<number, User>([
  [1, { id: 1, name: "Alice", email: "alice@example.com" }],
]);

function getUser(id: number): User {
  const user = users.get(id);
  if (!user) throw new NotFoundError("User", id);
  return user;
}

function createUser(name: string, email: string): User {
  const fields: Record<string, string> = {};
  if (name.trim() === "") fields.name = "不可為空";
  if (!email.includes("@")) fields.email = "格式錯誤";
  if (Object.keys(fields).length > 0) {
    throw new ValidationError("使用者資料驗證失敗", fields);
  }
  const user: User = { id: users.size + 1, name, email };
  users.set(user.id, user);
  return user;
}

// ---- 使用：接住 ----
try { getUser(999) } catch (e) { handleError(e) }
// 404: User with id 999 not found

try { createUser("", "not-an-email") } catch (e) { handleError(e) }
// Validation: {"name":"不可為空","email":"格式錯誤"}

try { throw new AppError("DB connection lost", "DB_ERROR", 503) } catch (e) { handleError(e) }
// App Error [DB_ERROR]: DB connection lost

try { throw "oops" } catch (e) { handleError(e) }
// Unknown error: oops
```

`instanceof` 的判斷順序**必須子類別在前**。把 `AppError` 那條搬到最上面，`NotFoundError` 和 `ValidationError` 就永遠進不去自己的分支——它們本身也都是 `AppError` 的實例。

`handleError` 只是印出來，真正的用途是在**邊界**把錯誤收斂成回應。`statusCode` 和 `code` 就是為此存在的：

```typescript
function toResponse(error: unknown): { status: number; body: unknown } {
  if (error instanceof AppError) {
    return {
      status: error.statusCode,
      body: {
        code: error.code,
        message: error.message,
        ...(error instanceof ValidationError && { fields: error.fields }),
      },
    };
  }
  // 非預期錯誤：記下來，但不要把內部細節吐給前端
  console.error("Unexpected:", error);
  return {
    status: 500,
    body: { code: "INTERNAL_ERROR", message: "Internal Server Error" },
  };
}

toResponse(new NotFoundError("User", 999));
// { status: 404, body: { code: "NOT_FOUND", message: "User with id 999 not found" } }

toResponse(new ValidationError("驗證失敗", { email: "格式錯誤" }));
// { status: 400, body: { code: "VALIDATION_ERROR", message: "驗證失敗",
//                        fields: { email: "格式錯誤" } } }

toResponse(new Error("boom"));
// { status: 500, body: { code: "INTERNAL_ERROR", message: "Internal Server Error" } }
```

在 Express 就掛成一個 error middleware，所有 handler 只管 `throw`：

```typescript
import type { Request, Response, NextFunction } from "express";

app.get("/users/:id", (req, res) => {
  res.json(getUser(Number(req.params.id))); // 找不到就直接 throw
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const { status, body } = toResponse(error);
  res.status(status).json(body);
});
```

⚠️ 一個常見的坑：`tsconfig` 的 `target` 設成 `ES5` 時，繼承 `Error` 會讓 `instanceof` 全部失效，上面每個分支都會掉到 `else`。原因是 ES5 沒有真正的 class，降級後 `super(message)` 回傳的新物件蓋掉了原型鏈。

| `target` | `e instanceof NotFoundError` | `e instanceof AppError` |
|---|---|---|
| `ES5` | `false` | `false` |
| `ES2015` 以上 | `true` | `true` |

解法是 `target` 用 `ES2015` 以上；真的得編到 ES5，就在每個 constructor 最後補一行（需要 `lib` 有 `ES2015`）：

```typescript
class NotFoundError extends AppError {
  constructor(resource: string, id: string | number) {
    super(`${resource} with id ${id} not found`, "NOT_FOUND", 404);
    this.name = "NotFoundError";
    Object.setPrototypeOf(this, NotFoundError.prototype); // ES5 下才需要
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

### `as const` vs `satisfies`（TypeScript 4.9+）

`as const` 只負責「把值凍結成最窄的字面值型別」，不會檢查值的形狀對不對。想要「既驗證形狀、又保留最窄字面值型別」，就該用 `satisfies`：

```typescript
type RouteMap = Record<"home" | "users" | "settings", string>;

// ✅ satisfies：驗證 ROUTES_SATISFIES 符合 RouteMap 的形狀（少一個 key 或型別不符都會報錯），
//    驗證通過後，型別仍然是推斷出的最窄字面值，而不是被拓寬成 RouteMap
const ROUTES_SATISFIES = {
  home: "/",
  users: "/users",
  settings: "/settings",
} satisfies RouteMap;

type RouteSatisfies = (typeof ROUTES_SATISFIES)[keyof typeof ROUTES_SATISFIES];
// "/" | "/users" | "/settings" —— 和 as const 一樣窄

// 對照組：用一般的型別標註，形狀檢查一樣會過，但型別被拓寬成 RouteMap
const ROUTES_ANNOTATED: RouteMap = {
  home: "/",
  users: "/users",
  settings: "/settings",
};
type WidenedHome = typeof ROUTES_ANNOTATED.home; // string（拓寬了，不再是 "/"）

// const BAD_ROUTES = {
//   home: "/",
//   users: "/users",
// } satisfies RouteMap; // ❌ 缺少 'settings'，編譯期就會被擋下
```

> 💡 三者的取捨：`as const` 只凍結、不驗證形狀；`: T` 標註驗證形狀、但會拓寬型別；`satisfies T` 兩者兼顧——驗證形狀，同時保留推斷出的最窄型別。

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

// 用法示範：從路由字串字面值中拆出 HTTP 方法與路徑
type M = ExtractMethod<"GET /users">; // "GET"
type P = ExtractPath<"GET /users">;   // "/users"

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

> 📎 另外兩個常被找、但屬於基礎章節的主題：判別聯合型別（discriminated unions）見 [第七章 7.1](./07-advanced-types.md)；用 `never` 做窮盡性檢查（exhaustiveness check）見 [第二章 2.5](./02-basic-types.md)。

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

### 品牌型別（Branded / Nominal Types）

`type UserId = string` 只是替 `string` 取了個別名，底層還是同一個型別。TypeScript 是**結構化型別系統（structural typing）**，不是 Java/C# 那種**具名型別系統（nominal typing）**——只要結構相同就能互相賦值，因此 `UserId` 和 `OrderId` 這種語意完全不同的字串 ID，一樣能被誤傳、混用而不會有任何編譯錯誤：

```typescript
type UserId = string;
type OrderId = string;

function getUser(id: UserId) { /* ... */ }

const orderId: OrderId = "order_123";
getUser(orderId); // ✅ 編譯通過——但這其實是個錯誤的呼叫！

// 加上一個「品牌」欄位，讓結構不再相容
type Branded<T, Brand extends string> = T & { readonly __brand: Brand };
type BrandedUserId = Branded<string, "UserId">;
type BrandedOrderId = Branded<string, "OrderId">;

function createUserId(id: string): BrandedUserId {
  return id as BrandedUserId; // 型別轉換只在「建立」這一個點做一次
}

function getUserSafe(id: BrandedUserId) { /* ... */ }

const safeUserId = createUserId("user_1");
const safeOrderId = "order_123" as BrandedOrderId;

getUserSafe(safeUserId); // ✅
// getUserSafe(safeOrderId); // ❌ 型別錯誤：缺少品牌 "UserId"，兩者不再結構相容
```

> 💡 品牌欄位（如 `__brand`）在執行期完全不存在，純粹是編譯期用來製造「名義區別」的標記。適合用在 ID、金額單位（分 vs 元）、已驗證 vs 未驗證的字串等容易混淆、卻又同為 `string`/`number` 的場景。

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

<details>
<summary>參考解答</summary>

兩個函式的 `any` 各有不同解法。`fetchData` 的回傳型別要由呼叫端決定，所以用**泛型** `T`；`url` 收斂成 `string`，`options` 用內建的 `RequestInit`。`processItems` 的輸入／輸出形狀是固定的，用 `interface` 明確定義即可，`filter`/`map` 的參數型別會自動推斷、不需再標註。

```typescript
// 回傳型別交給呼叫端以泛型指定，url/options 用內建型別
async function fetchData<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// 明確定義輸入與輸出的形狀
interface Item {
  id: number;
  name: string;
  active: boolean;
}

interface ProcessedItem {
  id: number;
  label: string;
}

function processItems(items: Item[]): ProcessedItem[] {
  return items
    .filter((item) => item.active) // item 已推斷為 Item
    .map((item) => ({
      id: item.id,
      label: item.name.toUpperCase(),
    }));
}

// 使用示範
interface User {
  id: number;
  name: string;
  active: boolean;
}

const users = await fetchData<User[]>("/api/users"); // users: User[]
const processed = processItems(users); // processed: ProcessedItem[]
```

重點：需要「由呼叫端決定型別」時用泛型，形狀固定時用 `interface`；`res.json()` 回傳 `Promise<any>`，用 `as Promise<T>` 把它收束到泛型結果即可，避免整條鏈都退化成 `any`。

</details>

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

<details>
<summary>參考解答</summary>

關鍵是讓 `createStore` 的三個泛型 `S`（state）、`A`（actions）、`G`（getters）互相關聯：`S` 由 `state` 推斷出來，`actions`/`getters` 的第一個參數再透過 `Record<string, (state: S, ...) => ...>` 的約束「反向」拿到 `S` 的型別（所以 `increment(state)` 的 `state` 不用標註也知道是 `{ count: number; user: User | null }`）。對外暴露時再用**條件型別 + `infer`** 把 action 的第一個 `state` 參數「藏起來」，並把 getter 轉成取值屬性。

```typescript
interface User {
  id: number;
  name: string;
}

// action：第一個參數固定是 state，後面可帶任意額外參數
type ActionsConfig<S> = Record<string, (state: S, ...args: any[]) => any>;
// getter：只吃 state，回傳衍生值
type GettersConfig<S> = Record<string, (state: S) => any>;

interface StoreConfig<
  S,
  A extends ActionsConfig<S>,
  G extends GettersConfig<S>,
> {
  state: S;
  actions: A;
  getters: G;
}

// 對外暴露的 action：把第一個 state 參數移除，只留下其餘參數
type ExposedActions<S, A extends ActionsConfig<S>> = {
  [K in keyof A]: A[K] extends (state: S, ...args: infer P) => infer R
    ? (...args: P) => R
    : never;
};

// getter 對外變成「取值」屬性
type ExposedGetters<S, G extends GettersConfig<S>> = {
  readonly [K in keyof G]: ReturnType<G[K]>;
};

interface Store<S, A extends ActionsConfig<S>, G extends GettersConfig<S>> {
  state: S;
  actions: ExposedActions<S, A>;
  getters: ExposedGetters<S, G>;
}

function createStore<
  S,
  A extends ActionsConfig<S>,
  G extends GettersConfig<S>,
>(config: StoreConfig<S, A, G>): Store<S, A, G> {
  const state = config.state;

  const actions = {} as ExposedActions<S, A>;
  for (const key in config.actions) {
    // 呼叫時自動把 state 注入為第一個參數
    actions[key] = ((...args: any[]) =>
      config.actions[key](state, ...args)) as ExposedActions<S, A>[typeof key];
  }

  const getters = {} as Record<string, unknown>;
  for (const key in config.getters) {
    // getter 每次讀取都重新計算
    Object.defineProperty(getters, key, {
      get: () => config.getters[key](state),
      enumerable: true,
    });
  }

  return { state, actions, getters: getters as ExposedGetters<S, G> };
}

// 使用 —— state / actions / getters 全程型別安全
const store = createStore({
  state: { count: 0, user: null as User | null },
  actions: {
    increment(state) {
      state.count++;
    },
    setUser(state, user: User) {
      state.user = user;
    },
  },
  getters: {
    doubleCount(state) {
      return state.count * 2;
    },
  },
});

store.actions.increment(); // ✅ 不需要傳 state
store.actions.setUser({ id: 1, name: "Gary" }); // ✅ 只需傳 user
const n: number = store.getters.doubleCount; // ✅ 推斷為 number
// store.actions.setUser(); // ❌ 缺少 user 參數
```

重點：多個泛型互相約束（`A extends ActionsConfig<S>`）是讓 action 內 `state` 自動推斷的關鍵；用條件型別 + `infer P` 移除首個參數，讓對外 API 從 `(state, ...args)` 變成 `(...args)`，呼叫端不必也不能再手動傳 state。

</details>

### 練習 3：綜合實作

選擇一個你熟悉的框架（Vue / React），建立一個完整的 TypeScript 專案，包含：
- 型別定義檔案
- 型別安全的 API 層
- 型別安全的狀態管理
- 元件的完整型別標註

<details>
<summary>參考解答</summary>

這題是開放式整合練習，課程已經附上兩個**可實際執行**的完整參考實作，功能互相對應，正好涵蓋題目要求的四塊——建議直接對照原始碼閱讀：

- [projects/vue-app](./projects/vue-app/) — Vue 3 + Pinia + Vue Router + axios
- [projects/react-app](./projects/react-app/) — React 19 + Zustand + React Router + axios

題目四項要求對應到專案裡的位置：

| 要求 | vue-app | react-app |
|------|---------|-----------|
| 型別定義檔案 | `src/types/index.ts`（共用的 `User`/`Post`/`ApiError` DTO + `isApiError` 型別守衛） | 同左 |
| 型別安全的 API 層 | `src/api/`（axios 攔截器把錯誤正規化成 `ApiError`，`get<T>()` 讓呼叫端直接拿到 `T`） | 同左 |
| 型別安全的狀態管理 | `src/stores/`（Pinia setup store，含收藏清單持久化） | `src/stores/`（Zustand，`persist` middleware） |
| 元件的完整型別標註 | `src/components/`、`src/views/`（`defineProps<T>()`、型別化路由參數） | 同左（`interface Props`、`useParams` 轉型） |

動手做的建議步驟：

1. 先用 `npm create vue@latest`（勾選 TypeScript / Router / Pinia）或 `npm create vite@latest -- --template react-ts` 建立骨架。
2. 在 `src/types/` 定義領域型別與 `isApiError` 守衛，讓其餘各層都 import 同一份型別。
3. 封裝一支型別化的 axios 實例（攔截器 + `get<T>()`），API 函式一律回傳 `Promise<具體型別>`。
4. 用 Pinia / Zustand 建立 store，非同步 action 在 `catch` 用 `isApiError` 取出訊息（避免 `any` 與不安全的 `as`）。
5. 元件的 props、事件、路由參數全部標註型別，最後跑 `npm run type-check`（Vue 用 `vue-tsc`、React 用 `tsc`）確認 0 型別錯誤。

完整結構與逐檔說明見 [projects/README.md](./projects/README.md)。

</details>

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

---

## 想更進一步？

以下兩章屬於**進階補充**，帶你深入 TypeScript 型別系統的深水區與工具開發：

- [第十三章 — 型別層級程式設計](./13-type-level-programming.md)：把型別當成程式語言，用泛型、條件型別與遞迴做編譯期運算。
- [第十四章 — TypeScript Compiler API](./14-compiler-api.md)：用程式操作編譯器本身，開發 codemod、linter 與程式碼產生器。
