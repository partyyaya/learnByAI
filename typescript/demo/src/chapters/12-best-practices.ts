// =============================================================
// 第 12 章 最佳實踐與常見模式 — 程式碼範例
// 來源:typescript/12-best-practices.md
//
// 說明:
// - 本檔把每個獨立範例包在各自的 `{ ... }` 區塊內,避免同名
//   interface/type/const/function 互相衝突;每個區塊自成一體。
// - 本章用到 zod(demo 安裝的是 v4);import 只放在檔案最上方一次。
// - 刻意示範「錯誤 / 危險」而會編譯失敗或執行時崩潰的行,已註解掉,
//   並保留其後的 ❌ 說明文字。
// =============================================================

import { z } from "zod";

// -------------------------------------------------------------
// 12.1 型別設計原則
// -------------------------------------------------------------

// 優先使用 interface 定義物件結構
{
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

  // 使用一下這些型別,避免只宣告不使用造成困惑
  const u: UserWithStatus = {
    id: 1,
    name: "Gary",
    email: "gary@example.com",
    status: "active",
  };
  const ru: ReadonlyUser = { id: 2, name: "Ada", email: "ada@example.com" };
  console.log(u, ru);
}

// 避免使用 any
{
  // ❌ 使用 any(以下三個 parse 各自包在獨立區塊,否則會「重複宣告」)
  {
    // ❌ 使用 any
    function parse(data: any): any {
      return JSON.parse(data);
    }
    console.log(parse('{"a":1}'));
  }
  {
    // ✅ 使用 unknown + 型別守衛
    function parse(data: string): unknown {
      return JSON.parse(data);
    }
    console.log(parse('{"a":1}'));
  }
  {
    // ✅ 使用泛型
    function parse<T>(data: string): T {
      return JSON.parse(data) as T;
    }
    console.log(parse<{ a: number }>('{"a":1}'));
  }
  {
    // ✅ 更安全的做法:runtime validation
    // zod v4:z.string().email() → z.email()
    const UserSchema = z.object({
      id: z.number(),
      name: z.string(),
      email: z.email(),
    });

    type User = z.infer<typeof UserSchema>;

    function parseUser(data: string): User {
      return UserSchema.parse(JSON.parse(data));
    }

    console.log(
      parseUser('{"id":1,"name":"Gary","email":"gary@example.com"}'),
    );
  }
}

// 善用字面值型別和聯合型別
{
  // ❌ 過度寬泛(僅示意,包在獨立區塊避免與下方 Button 衝突)
  {
    interface Button {
      variant: string;
      size: string;
    }
    const btn: Button = { variant: "primary", size: "md" };
    console.log(btn);
  }
  {
    // ✅ 精確定義
    interface Button {
      variant: "primary" | "secondary" | "danger" | "ghost";
      size: "sm" | "md" | "lg";
    }
    const btn: Button = { variant: "primary", size: "md" };
    console.log(btn);
  }
}

// -------------------------------------------------------------
// 12.2 型別安全的錯誤處理
// -------------------------------------------------------------

// Result 模式
{
  // 自足:本範例需要 User 型別,整段拉進來
  interface User {
    id: number;
    name: string;
    email: string;
  }

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
    console.error(result.error); // 型別安全
  }
}

// 自定義 Error 類別
{
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

  handleError(new NotFoundError("User", 1));
  handleError(new ValidationError("bad", { email: "invalid" }));
}

// -------------------------------------------------------------
// 12.3 不可變資料模式
// -------------------------------------------------------------
{
  // 自足:本範例需要 User 與 Notification 型別
  interface User {
    id: number;
    name: string;
    email: string;
  }
  interface Notification {
    id: number;
    message: string;
  }

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

  const state: ImmutableState = { user: null, theme: "light", notifications: [] };
  const route: Route = ROUTES.users;
  console.log(state, route);
}

// as const vs satisfies(TS 4.9+)
{
  type RouteMap = Record<"home" | "users" | "settings", string>;

  // satisfies:驗證形狀符合 RouteMap,驗證通過後型別仍是最窄的字面值
  const ROUTES_SATISFIES = {
    home: "/",
    users: "/users",
    settings: "/settings",
  } satisfies RouteMap;

  type RouteSatisfies = (typeof ROUTES_SATISFIES)[keyof typeof ROUTES_SATISFIES];
  // "/" | "/users" | "/settings"

  // 對照組:一般型別標註,形狀檢查一樣會過,但型別被拓寬成 RouteMap
  const ROUTES_ANNOTATED: RouteMap = {
    home: "/",
    users: "/users",
    settings: "/settings",
  };
  type WidenedHome = typeof ROUTES_ANNOTATED.home; // string(拓寬了,不再是 "/")

  const r1: RouteSatisfies = ROUTES_SATISFIES.home; // ✅ "/"
  const r2: WidenedHome = ROUTES_ANNOTATED.home; // string
  console.log(r1, r2);
}

// -------------------------------------------------------------
// 12.4 型別安全的事件系統
// -------------------------------------------------------------
{
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
}

// -------------------------------------------------------------
// 12.5 型別安全的 API 客戶端
// -------------------------------------------------------------
{
  // 自足:本範例需要 User / CreateUserDto / UpdateUserDto
  interface User {
    id: number;
    name: string;
    email: string;
  }
  interface CreateUserDto {
    name: string;
    email: string;
  }
  interface UpdateUserDto {
    name?: string;
    email?: string;
  }

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

  // 保留上面兩個工具型別的使用示範,避免看起來像死碼
  type _Method = ExtractMethod<"GET /users">; // "GET"
  type _Path = ExtractPath<"GET /users">; // "/users"

  async function apiClient<K extends keyof ApiRoutes>(
    route: K,
    options?: Partial<ApiRoutes[K]>,
  ): Promise<ApiRoutes[K]["response"]> {
    // 真實實作會解析 route（如 "GET /users"）再 fetch；
    // 示範環境改用 mock，避免實際發出網路請求而崩潰。重點在「呼叫端的型別安全」。
    console.log(`[mock] 呼叫 API: ${String(route)}`, options ?? {});
    return undefined as ApiRoutes[K]["response"];
  }

  // 使用 — 完全型別安全（route 字串、params/query、回傳型別都會被檢查）
  const users = await apiClient("GET /users", { query: { page: 1 } });
  // users 的型別是 User[]

  const user = await apiClient("GET /users/:id", { params: { id: 1 } });
  // user 的型別是 User

  void users;
  void user;
}

// -------------------------------------------------------------
// 12.6 常見的型別陷阱與解決方案
// -------------------------------------------------------------

// 陷阱 1:物件字面值的多餘屬性檢查
{
  interface User {
    name: string;
    email: string;
  }

  // ❌ 直接字面值賦值 — 多餘屬性會報錯(整段註解,否則編譯失敗)
  // const user: User = {
  //   name: "Gary",
  //   email: "gary@example.com",
  //   age: 30, // ❌ 錯誤:'age' 不存在於 User 中
  // };

  // ✅ 透過變數賦值 — 多餘屬性不報錯(結構子型別)
  const data = { name: "Gary", email: "gary@example.com", age: 30 };
  const user: User = data; // OK
  console.log(user);
}

// 陷阱 2:陣列型別的協變問題
{
  interface Animal {
    name: string;
  }
  interface Dog extends Animal {
    breed: string;
  }

  // TypeScript 陣列是協變的(可能導致不安全的操作)
  {
    const dogs: Dog[] = [{ name: "Buddy", breed: "Labrador" }];
    const animals: Animal[] = dogs; // ✅ 允許(但要小心)
    animals.push({ name: "Kitty" }); // 這會破壞 dogs 陣列!(型別檢查通過,但執行時不安全)
    console.log(dogs);
  }

  // 解決方案:使用 readonly
  {
    const dogs: readonly Dog[] = [{ name: "Buddy", breed: "Labrador" }];
    const animals: readonly Animal[] = dogs;
    // animals.push({ name: "Kitty" }); // ❌ readonly 不允許 push
    console.log(animals);
  }
}

// 陷阱 3:型別斷言的濫用
{
  interface User {
    name: string;
    email: string;
  }

  // ❌ 危險的型別斷言
  {
    const user = {} as User;
    // console.log(user.name.toUpperCase()); // ❌ 型別檢查通過,但執行時 Error!(user 其實是 {})
    console.log(user);
  }

  // ✅ 正確的方式
  {
    const user: User = {
      name: "Gary",
      email: "gary@example.com",
    };
    console.log(user);
  }

  // ✅ 如果真的需要漸進式建構
  {
    const user: Partial<User> = {};
    user.name = "Gary";
    user.email = "gary@example.com";
    console.log(user);
  }
}

// 陷阱 4:可選鏈和 Nullish Coalescing
{
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

  console.log(host, port);
}

// -------------------------------------------------------------
// 12.7 專案組織建議 — 命名慣例
// (目錄結構為純文字說明,略;此處僅整理可編譯的命名範例)
// -------------------------------------------------------------
{
  // 介面:使用名詞,Pascal Case
  interface UserProfile {}
  interface ApiResponse<T> {}

  // 型別別名:使用名詞或描述性名稱
  type UserId = string;
  type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

  // 泛型參數命名
  // T = Type(通用)
  // K = Key
  // V = Value
  // E = Element / Error
  // R = Return
  // P = Props / Params

  // ❌ 不推薦:I 前綴
  interface IUser {} // Java/C# 風格,TypeScript 不推薦

  // ✅ 推薦:直接使用名稱
  interface User {}

  // 使用一下上述型別以示意
  const profile: UserProfile = {};
  const resp: ApiResponse<number> = {};
  const id: UserId = "u_1";
  const method: HttpMethod = "GET";
  const legacy: IUser = {};
  const user: User = {};
  console.log(profile, resp, id, method, legacy, user);
}

// 品牌型別(Branded / Nominal Types)— UserId 不該和 OrderId 混用
{
  type UserId = string;
  type OrderId = string;

  function getUser(_id: UserId) {
    /* ... */
  }

  const orderId: OrderId = "order_123";
  getUser(orderId); // ✅ 編譯通過(結構化型別系統擋不住這種誤用)——這正是問題所在

  // 加上「品牌」欄位,讓結構不再相容
  type Branded<T, Brand extends string> = T & { readonly __brand: Brand };
  type BrandedUserId = Branded<string, "UserId">;
  type BrandedOrderId = Branded<string, "OrderId">;

  function createUserId(id: string): BrandedUserId {
    return id as BrandedUserId; // 型別轉換只在「建立」這一個點做一次
  }

  function getUserSafe(_id: BrandedUserId) {
    /* ... */
  }

  const safeUserId = createUserId("user_1");
  const safeOrderId = "order_123" as BrandedOrderId;

  getUserSafe(safeUserId); // ✅
  // getUserSafe(safeOrderId); // ❌ 型別錯誤:缺少品牌 "UserId"
  console.log(safeUserId, safeOrderId);
}

// -------------------------------------------------------------
// 12.8 效能考量 — 避免過度複雜的型別
// (Project References / skipLibCheck 為 JSON 設定,略)
// -------------------------------------------------------------
{
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

  // 使用示意
  type A = { a: number; nested: { x: number } };
  type B = { b: string; nested: { y: number } };
  const deep: DeepMerge<A, B> = { a: 1, b: "s", nested: { x: 1, y: 2 } };
  const merged: Merge<A, B> = { a: 1, b: "s", nested: { y: 2 } };
  console.log(deep, merged);
}

// -------------------------------------------------------------
// 12.9 推薦工具生態系 — Zod 範例
// -------------------------------------------------------------
{
  // 定義 Schema(同時是驗證規則和型別定義)
  // zod v4:z.string().email() → z.email()
  const UserSchema = z.object({
    id: z.number(),
    name: z.string().min(2).max(50),
    email: z.email(),
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

  // 安全驗證(不拋出錯誤)
  function safeCreateUser(data: unknown) {
    const result = UserSchema.safeParse(data);
    if (result.success) {
      return result.data; // 型別為 User
    }
    console.error(result.error.issues);
    return null;
  }

  console.log(
    createUser({
      id: 1,
      name: "Gary",
      email: "gary@example.com",
      role: "admin",
    }),
  );
  console.log(safeCreateUser({ id: 2, name: "X", email: "bad", role: "user" }));
}

// -------------------------------------------------------------
// 練習題
// -------------------------------------------------------------

// 練習 1:重構挑戰(以下為「待重構」的 any 版本,可編譯但不推薦)
{
  function fetchData(url: any, options: any): any {
    return fetch(url, options).then((res: any) => res.json());
  }

  function processItems(items: any[]): any[] {
    return items.filter((item: any) => item.active).map((item: any) => ({
      id: item.id,
      label: item.name.toUpperCase(),
    }));
  }

  console.log(typeof fetchData, typeof processItems);
}

// 練習 2:型別安全的 Store(此為「請你自行實作」的目標 API,
// createStore 尚未實作,整段以註解保留,避免編譯失敗)
{
  // 定義 State、Actions、Getters 都有完整型別
  // const store = createStore({
  //   state: { count: 0, user: null as User | null },
  //   actions: {
  //     increment(state) { state.count++ },
  //     setUser(state, user: User) { state.user = user },
  //   },
  //   getters: {
  //     doubleCount(state) { return state.count * 2 },
  //   },
  // });
}

// 練習 3:綜合實作 — 為純文字說明,無程式碼。

console.log("第 12 章 最佳實踐與常見模式 範例載入完成 ✅");

export {};
