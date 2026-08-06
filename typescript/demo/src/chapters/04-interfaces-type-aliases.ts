// =====================================================================
// 第 4 章：介面與型別別名
// 來源：typescript/04-interfaces-type-aliases.md
//
// 說明：同檔內許多範例重複宣告同名的 interface / type / const
// （多個 User、多個 translations…）。為避免衝突，每個「獨立範例」
// 都各自包在一個 { ... } 區塊內形成獨立作用域；宣告合併示範則刻意
// 放在「同一個」區塊內以保留合併語意。每塊皆自足（用到的型別會整段複製進來）。
// =====================================================================

// ===== 4.1 介面（Interface）— 基本介面 =====
{
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

  console.log(user);
}

// ===== 4.1 介面（Interface）— 可選屬性 =====
{
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

  console.log(product);
}

// ===== 4.1 介面（Interface）— 唯讀屬性 =====
{
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

  console.log(config);
}

// ===== 4.2 介面擴展（extends）=====
{
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

  console.log(admin);
}

// ===== 4.3 型別別名（Type Alias）— 基本用法 =====
{
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

  // 使用示範（讓型別被引用，避免只是宣告）
  const u: User = { id: 1, name: "Gary", email: "gary@example.com" };
  const key: ID = "abc";
  const mail: Email = "gary@example.com";
  const status: Status = "active";
  const point: Coordinate = [10, 20];
  const format: Formatter = (value) => value.toFixed(2);
  console.log(u, key, mail, status, point, format(3.14159));
}

// ===== 4.3 型別別名（Type Alias）— 交集型別（Intersection）=====
{
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

  console.log(user);
}

// ===== 4.4 Interface vs Type — 宣告合併（Declaration Merging）=====
// 注意：以下兩個同名 interface User 是「宣告合併」示範，必須放在同一個區塊內。
{
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

  console.log(user);
}

// ===== 4.4 Interface vs Type — 何時使用哪個？ =====
{
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

  // 使用示範
  const pair: Pair = ["age", 30];
  const ok: Result<User> = { ok: true, value: { id: 1, name: "Gary", email: "g@e.com" } };
  const ro: ReadonlyUser = { id: 1, name: "Gary", email: "g@e.com" };
  const service: UserService = {
    getUser: async (id) => ({ id, name: "Gary", email: "g@e.com" }),
    createUser: async (data) => ({ id: 1, name: data.name, email: data.email }),
  };
  console.log(pair, ok, ro, typeof service.getUser);
}

// ===== 4.5 索引簽名（Index Signatures）=====
{
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

  console.log(translations, profile);
}

// ===== 4.5 索引簽名 — Record 工具型別（替代方案）=====
{
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

  console.log(translations, permissions);
}

// ===== 4.6 介面與函式 =====
{
  // 自足：補上 SearchFunc 引用到的 SearchResult 型別
  interface SearchResult {
    id: number;
    title: string;
  }

  // 定義可呼叫的介面
  interface SearchFunc {
    (query: string, limit?: number): Promise<SearchResult[]>;
  }

  // 使用示範（讓 SearchFunc 被引用）
  const search: SearchFunc = async (query, limit = 10) =>
    [{ id: 1, title: `${query} (max ${limit})` }];

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
  console.log(typeof search);
}

// ===== 4.7 實戰模式 — API Response 型別設計 =====
{
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

  const list: UserListResponse = {
    code: 0,
    message: "ok",
    data: [{ id: 1, name: "Gary", email: "g@e.com" }],
    pagination: { page: 1, pageSize: 10, total: 1, totalPages: 1 },
  };
  const detail: UserDetailResponse = {
    code: 0,
    message: "ok",
    data: { id: 1, name: "Gary", email: "g@e.com" },
  };
  console.log(list, detail);
}

// ===== 4.7 實戰模式 — DTO（Data Transfer Object）模式 =====
{
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

  // --- 拆開來看：CreateUserDto ---
  // 步驟 1：Omit 拿掉三個自動生成的欄位 → { name: string; email: string }
  // 步驟 2：用 & 接上前端真的會傳的 password
  // 最終等同於手寫這個：
  type CreateUserDtoExpanded = {
    name: string;
    email: string;
    password: string; // 明文，後端收到才加密成 passwordHash
  };

  // --- 拆開來看：UpdateUserDto（巢狀工具型別由內往外讀）---
  // 步驟 1（內層 Pick）：只挑出 name 和 email → { name: string; email: string }
  // 步驟 2（外層 Partial）：全部加上 ?
  // 最終等同於手寫這個：
  type UpdateUserDtoExpanded = {
    name?: string;
    email?: string;
  };

  // 兩邊互相可指派 → 證明衍生寫法與手寫版本等價
  const proveCreate: CreateUserDtoExpanded = {} as CreateUserDto;
  const proveUpdate: UpdateUserDtoExpanded = {} as UpdateUserDto;

  // 使用示範
  const createDto: CreateUserDto = {
    name: "Gary",
    email: "gary@example.com",
    password: "secret",
  };
  const updateDto: UpdateUserDto = { name: "Gary Cai" };
  const patchNothing: UpdateUserDto = {}; // ✅ 什麼都不改也合法
  console.log(createDto, updateDto, patchNothing, proveCreate, proveUpdate);

  // ❌ id 是資料庫自動生成的，CreateUserDto 裡根本沒有這個欄位
  // const badCreate: CreateUserDto = { ...createDto, id: 1 };

  // ❌ passwordHash 沒被 Pick 進來，不能透過更新 DTO 改
  // const badUpdate: UpdateUserDto = { passwordHash: "..." };
}

// ===== 練習題 1：定義介面（練習參考解答）=====
{
  // 練習參考解答
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
  console.log(order);
}

// ===== 練習題 2：介面繼承（練習參考解答）=====
{
  // 練習參考解答（填入原本的 /* ... */ 佔位）
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
  console.log(dog, cat);
}

// ===== 練習題 3：Interface vs Type（練習參考解答）=====
{
  // 練習參考解答
  // 自足：補上 UserMap / ReadonlyUser 引用到的 User
  interface User {
    id: number;
    name: string;
  }

  // 以下四者原本都是 type，思考哪些可以改寫成 interface：
  // ❌ 聯合型別無法用 interface 表達，只能用 type
  type Status = "pending" | "active" | "inactive";
  // ❌ 元組無法用 interface 表達，只能用 type
  type Point = [number, number];
  // Record 映射型別無法直接用 interface，但可用索引簽名近似
  type UserMap = Record<string, User>;
  // 可改寫為 interface（索引簽名）：
  interface UserMapInterface {
    [key: string]: User;
  }
  // ❌ Readonly<T> 映射型別無法用 interface 表達，只能用 type
  type ReadonlyUser = Readonly<User>;

  const status: Status = "active";
  const point: Point = [1, 2];
  const map: UserMap = { u1: { id: 1, name: "Gary" } };
  const mapI: UserMapInterface = { u1: { id: 1, name: "Gary" } };
  const ro: ReadonlyUser = { id: 1, name: "Gary" };
  console.log(status, point, map, mapI, ro);
}

console.log("第 4 章 介面與型別別名 範例載入完成 ✅");

export {};
