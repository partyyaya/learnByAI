// 第七章：進階型別技巧
//
// 本檔為課程範例整理，供 demo 測試環境做型別檢查使用。
// 每個獨立範例都包在自己的 `{ ... }` 區塊內，以避免同名 type/interface 互相衝突，
// 並且刻意允許在區塊內重新定義 Readonly / Optional / Nullable 等以遮蔽全域內建型別。

// ===== 7.1 聯合型別（Union Types） =====
{
  // 基本聯合型別
  type ID = string | number;

  function printId(id: ID): void {
    // 需要型別縮窄才能使用特定方法
    if (typeof id === "string") {
      console.log(id.toUpperCase());
    } else {
      console.log(id.toFixed(2));
    }
  }

  // 判別式聯合（Discriminated Union）
  type Shape =
    | { kind: "circle"; radius: number }
    | { kind: "square"; side: number }
    | { kind: "rectangle"; width: number; height: number };

  function getArea(shape: Shape): number {
    switch (shape.kind) {
      case "circle":
        return Math.PI * shape.radius ** 2;
      case "square":
        return shape.side ** 2;
      case "rectangle":
        return shape.width * shape.height;
      default: {
        // 窮盡性檢查：新增 Shape 變體卻忘記補 case 時，這行會在編譯期報錯
        const _exhaustive: never = shape;
        throw new Error(`Unhandled shape: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  // 讓宣告被使用，示範呼叫
  printId("abc");
  printId(3.14159);
  console.log("圓面積:", getArea({ kind: "circle", radius: 2 }));
}

// ===== 7.1 satisfies 運算子（TS 4.9+） =====
{
  type Shape =
    | { kind: "circle"; radius: number }
    | { kind: "square"; side: number }
    | { kind: "rectangle"; width: number; height: number };

  // 一般型別標註：值被拓寬成 Shape，之後只能存取聯合型別共有欄位
  const configA: Shape = { kind: "circle", radius: 5 };
  // configA.radius; // ❌ 型別是 Shape，TypeScript 不知道一定是 circle 分支

  // as 斷言：不會做完整結構檢查，多打的欄位可能就這樣溜過去
  const configB = { kind: "circle", radius: 5, extraFlag: true } as Shape;

  // satisfies：檢查是否符合 Shape 結構（含多餘屬性檢查），同時保留字面值型別
  const configC = { kind: "circle", radius: 5 } satisfies Shape;
  configC.radius; // ✅ 型別仍是 { kind: "circle"; radius: number }

  // const configD = { kind: "circle", radius: 5, extraFlag: true } satisfies Shape;
  // ❌ 物件字面值有多餘屬性 extraFlag，satisfies 會抓出來

  console.log("satisfies:", configA.kind, configB.kind, configC.radius);
}

// ===== 7.1 satisfies 場景 1：設定表 / 常數表（最常見）=====
// satisfies 解決的是「有型別檢查」與「保留精確型別」二選一的困境：
//   : T          → 有檢查，但型別被拓寬
//   as T         → 檢查寬鬆（多打的欄位會溜過去），型別也變成 T，不安全
//   satisfies T  → 有檢查（含多餘屬性檢查），同時保留精確型別
{
  type RouteConfig = { path: string; auth: boolean };

  // ❌ 一般標註：型別被拓寬成 Record<string, RouteConfig>
  const routesA: Record<string, RouteConfig> = {
    home: { path: "/", auth: false },
    admin: { path: "/admin", auth: true },
  };
  // routesA.hoem 打錯 key 完全不報錯！索引簽章等於宣告「任何字串鍵都合法」
  // keyof typeof routesA 是 string —— 具體有哪些路由的資訊全丟了

  // ✅ satisfies：既檢查每個值符合 RouteConfig，又保留 key 的字面量
  const routesB = {
    home: { path: "/", auth: false },
    admin: { path: "/admin", auth: true },
  } satisfies Record<string, RouteConfig>;

  // routesB.hoem;
  // ❌ Property 'hoem' does not exist on type '{ home: ...; admin: ... }'

  type RouteName = keyof typeof routesB; // "home" | "admin"，可以拿去當參數型別
  function go(name: RouteName): string {
    return routesB[name].path;
  }
  // go("other"); // ❌ 編譯期就擋下來

  console.log("7.1 satisfies 設定表:", Object.keys(routesA), go("admin"));
  // 路由表、i18n 語系檔、權限表、選單設定、API endpoint 對照表都是這個形狀
}

// ===== 7.1 satisfies 場景 2：值的精確型別後續還要拿來用 =====
{
  type Colors = Record<string, string | [number, number, number]>;

  const palette = {
    red: [255, 0, 0],
    green: "#00ff00",
  } satisfies Colors;

  // 若寫成 const palette: Colors = {...}，每個值都會變成聯合型別，
  // 使用前還得先 typeof 判斷一輪
  const doubled = palette.red.map((n) => n * 2); // ✅ 知道是陣列
  const upper = palette.green.toUpperCase(); // ✅ 知道是字串

  // 字面量的保留也是同理
  const config = {
    port: 3000,
    env: "production",
  } satisfies { port: number; env: "development" | "production" };

  if (config.env === "production") {
    // ✅ env 的型別是 "production" 字面量，縮窄有效
    console.log("7.1 satisfies 精確型別:", doubled, upper, config.port);
  }
}

// ===== 7.1 satisfies 場景 3：搭配 as const =====
{
  // as const 負責凍結成字面量，satisfies 負責驗證形狀
  const ROLES = ["admin", "user"] as const satisfies readonly string[];
  type Role = (typeof ROLES)[number]; // "admin" | "user"

  const current: Role = "admin";
  // const bad: Role = "guest"; // ❌ 不在 ROLES 之中

  console.log("7.1 satisfies as const:", ROLES, current);

  // 判斷準則：
  //   值之後只當「某個型別」用，不在乎具體內容            → 用 : T 標註
  //   值本身的內容還要拿來推導（keyof typeof、縮窄、字面量）→ 用 satisfies
  //   想用 as T 繞過檢查時                               → 先想想是不是該用 satisfies
}

// ===== 7.2 交集型別（Intersection Types） =====
{
  type WithId = { id: number };
  type WithTimestamp = { createdAt: Date; updatedAt: Date };
  type WithSoftDelete = { deletedAt: Date | null };

  // 組合多個型別
  type BaseEntity = WithId & WithTimestamp & WithSoftDelete;

  type User = BaseEntity & {
    name: string;
    email: string;
  };

  // 函式組合
  type Loggable = {
    log(): void;
  };

  type Serializable = {
    serialize(): string;
  };

  type LoggableAndSerializable = Loggable & Serializable;

  // 使用範例（讓型別被引用）
  const user: User = {
    id: 1,
    name: "Gary",
    email: "gary@example.com",
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };
  const service: LoggableAndSerializable = {
    log() {},
    serialize() {
      return "";
    },
  };
  console.log("交集型別 user:", user.name, typeof service.serialize);
}

// ===== 7.3 型別縮窄（Type Narrowing） =====

// --- typeof Guard ---
{
  function padLeft(value: string, padding: string | number): string {
    if (typeof padding === "number") {
      return " ".repeat(padding) + value;
    }
    return padding + value;
  }

  console.log(padLeft("hi", 3));
  console.log(padLeft("hi", ">> "));
}

// --- instanceof Guard ---
{
  // 建構子參數的 public 是「參數屬性（Parameter Properties）」語法糖（第 5 章），
  // 跟 instanceof 無關，這裡只是用它把類別定義壓成一行。
  // 加了存取修飾符後，TypeScript 會自動建立同名屬性並在建構子裡指派。
  class ApiError {
    constructor(public statusCode: number, public message: string) {}
  }

  // 上面那段完全等價於這種完整寫法：
  class ApiErrorVerbose {
    public statusCode: number; // 1. 宣告欄位
    public message: string;

    constructor(statusCode: number, message: string) {
      // 2. 接收參數
      this.statusCode = statusCode; // 3. 手動指派
      this.message = message;
    }
  }

  // 修飾符不是可有可無的裝飾，而是「請幫我建立這個屬性」的開關。
  // 沒寫修飾符時參數只是用完就丟，之後存取 error.statusCode 會編譯錯誤。
  class NoModifier {
    constructor(statusCode: number, message: string) {
      void statusCode;
      void message;
    }
  }
  // new NoModifier(404, "x").statusCode;
  // ❌ Property 'statusCode' does not exist on type 'NoModifier'

  class NetworkError {
    constructor(public message: string) {}
  }

  function handleError(error: ApiError | NetworkError): string {
    if (error instanceof ApiError) {
      // 縮窄成 ApiError，才存取得到只有它才有的 statusCode
      return `API Error ${error.statusCode}: ${error.message}`;
    }
    // 走到這裡 error 已自動縮窄成 NetworkError
    return `Network Error: ${error.message}`;
  }

  console.log(handleError(new ApiError(404, "Not Found")));
  console.log(handleError(new NetworkError("timeout")));
  console.log("參數屬性完整寫法:", new ApiErrorVerbose(500, "Server Error").statusCode);
  void NoModifier;
}

// --- in 運算子 ---
{
  type Fish = { swim: () => void };
  type Bird = { fly: () => void };

  function move(animal: Fish | Bird): void {
    if ("swim" in animal) {
      animal.swim();
    } else {
      animal.fly();
    }
  }

  move({ swim: () => console.log("游泳") });
  move({ fly: () => console.log("飛行") });
}

// --- 自定義型別守衛（Type Predicates） ---
{
  interface Cat {
    type: "cat";
    meow(): void;
  }

  interface Dog {
    type: "dog";
    bark(): void;
  }

  // 自定義型別守衛：animal is Cat 叫「型別謂詞」，
  // 意思是「這個函式回傳 true 時，請把參數 animal 縮窄成 Cat」
  function isCat(animal: Cat | Dog): animal is Cat {
    return animal.type === "cat";
  }

  function handleAnimal(animal: Cat | Dog): void {
    if (isCat(animal)) {
      animal.meow(); // TypeScript 知道這是 Cat
    } else {
      animal.bark(); // TypeScript 知道這是 Dog
    }
  }

  handleAnimal({ type: "cat", meow: () => console.log("喵") });
  handleAnimal({ type: "dog", bark: () => console.log("汪") });

  // 對照組：只回傳 boolean 的話，TypeScript 不會拿來做型別縮窄
  function isCatPlain(animal: Cat | Dog): boolean {
    return animal.type === "cat";
  }
  function useA(animal: Cat | Dog): void {
    if (isCatPlain(animal)) {
      // animal.meow();
      // ❌ Property 'meow' does not exist on type 'Cat | Dog'
      console.log("是貓，但型別沒被縮窄:", animal.type);
    }
  }
  useA({ type: "cat", meow: () => console.log("喵") });

  // ⚠️ 陷阱：TypeScript 不會驗證謂詞的本體邏輯，寫反了也不報錯
  function isCatWrong(animal: Cat | Dog): animal is Cat {
    return animal.type === "dog"; // 邏輯整個相反，編譯器完全不管
  }
  void isCatWrong;

  // TS 5.5+：函式夠簡單時，不寫 is 也會自動推斷出型別謂詞
  function isCatInferred(animal: Cat | Dog) {
    return animal.type === "cat";
  }
  function useB(animal: Cat | Dog): void {
    if (isCatInferred(animal)) {
      animal.meow(); // ✅ 通過，TS 自動推斷成 animal is Cat
    }
  }
  useB({ type: "cat", meow: () => console.log("推斷謂詞也能縮窄") });

  // 最有感的是 filter：TS 5.4 以前 filtered 會是 (string | null)[]
  const names: (string | null)[] = ["a", null, "b"];
  const filtered = names.filter((n) => n !== null);
  const upper: string[] = filtered; // ✅ TS 5.5+ 直接通過
  console.log("filter 推斷謂詞:", upper);
}

// --- Assertion Functions ---
{
  function assertIsString(value: unknown): asserts value is string {
    if (typeof value !== "string") {
      throw new Error("Expected string");
    }
  }

  function processInput(input: unknown): string {
    assertIsString(input);
    // 這之後 input 的型別是 string
    return input.toUpperCase();
  }

  console.log(processInput("hello"));

  // 謂詞 vs 斷言：
  //   value is T          → 回傳 boolean，放在 if 裡分流，兩種情況都要處理
  //   asserts value is T  → 不回傳值，不符合就 throw，過了才繼續往下走

  // ⚠️ 限制：斷言函式必須是 function 宣告，或是有明確型別標註的變數
  // ❌ 箭頭函式指派給 const、變數本身沒有型別標註：
  //   const assertIsNumber = (value: unknown): asserts value is number => { ... };
  //   assertIsNumber(input);
  //   ❌ TS2775: Assertions require every name in the call target
  //              to be declared with an explicit type annotation.

  // ✅ 解法：把型別標註在變數上
  type Asserter = (value: unknown) => asserts value is number;
  const assertIsNum: Asserter = (value) => {
    if (typeof value !== "number") {
      throw new Error("Expected number");
    }
  };

  function double(input: unknown): number {
    assertIsNum(input);
    return input * 2; // ✅ input 已縮窄成 number
  }
  console.log("斷言函式（變數標註版）:", double(21));
}

// ===== 7.4 條件型別（Conditional Types） =====
{
  // 基本語法：T extends U ? X : Y
  type IsString<T> = T extends string ? "yes" : "no";

  type A = IsString<string>; // "yes"
  type B = IsString<number>; // "no"

  // 實用範例：提取 Promise 的值型別
  type UnwrapPromise<T> = T extends Promise<infer U> ? U : T;

  type Result1 = UnwrapPromise<Promise<string>>; // string
  type Result2 = UnwrapPromise<Promise<number>>; // number
  type Result3 = UnwrapPromise<string>; // string（不是 Promise 則回傳原型別）

  // 遞迴解包巢狀 Promise
  type DeepUnwrap<T> = T extends Promise<infer U> ? DeepUnwrap<U> : T;

  type Deep = DeepUnwrap<Promise<Promise<Promise<string>>>>; // string

  // 讓型別被使用（避免只宣告不使用）
  const a: A = "yes";
  const b: B = "no";
  const r1: Result1 = "x";
  const r2: Result2 = 1;
  const r3: Result3 = "y";
  const deep: Deep = "z";
  console.log(a, b, r1, r2, r3, deep);
}

// --- infer 關鍵字 ---
{
  // 提取函式回傳型別
  type ReturnTypeOf<T> = T extends (...args: any[]) => infer R ? R : never;

  type Fn = (x: number) => string;
  type Result = ReturnTypeOf<Fn>; // string

  // 提取函式參數型別
  type ParametersOf<T> = T extends (...args: infer P) => any ? P : never;

  type Params = ParametersOf<(a: string, b: number) => void>; // [string, number]

  // 提取陣列元素型別
  type ElementOf<T> = T extends (infer E)[] ? E : never;

  type Item = ElementOf<string[]>; // string

  const result: Result = "hi";
  const params: Params = ["a", 1];
  const item: Item = "s";
  console.log(result, params, item);
}

// --- 分佈式條件型別（Distributive Conditional Types） ---
{
  // T 是裸露的型別參數 → 對聯合型別會分佈
  type ToArray<T> = T extends any ? T[] : never;

  type StrOrNumArray = ToArray<string | number>;
  // 分佈後等於 ToArray<string> | ToArray<number>，也就是 string[] | number[]

  // [T] extends [U]：把 T 包進元組，關閉分佈行為
  type ToArrayNonDist<T> = [T] extends [any] ? T[] : never;

  type CombinedArray = ToArrayNonDist<string | number>;
  // (string | number)[]，整個聯合型別被當成單一整體處理

  const a: StrOrNumArray = ["x", "y"];
  const b: CombinedArray = ["x", 1];
  console.log("分佈式條件型別:", a, b);
}

// ===== 7.5 映射型別（Mapped Types） =====
{
  // 基本映射型別（區塊內刻意遮蔽全域的 Readonly）
  type Readonly<T> = {
    readonly [K in keyof T]: T[K];
  };

  type Optional<T> = {
    [K in keyof T]?: T[K];
  };

  type Nullable<T> = {
    [K in keyof T]: T[K] | null;
  };

  // 使用範例
  interface User {
    id: number;
    name: string;
    email: string;
  }

  type ReadonlyUser = Readonly<User>;
  // { readonly id: number; readonly name: string; readonly email: string }

  type OptionalUser = Optional<User>;
  // { id?: number; name?: string; email?: string }

  const ro: ReadonlyUser = { id: 1, name: "Gary", email: "g@example.com" };
  const opt: OptionalUser = { name: "Gary" };
  const nul: Nullable<User> = { id: null, name: "Gary", email: null };
  console.log(ro.name, opt.name, nul.name);
}

// --- 映射型別修飾符：-readonly / -? ---
{
  type Mutable<T> = {
    -readonly [K in keyof T]: T[K];
  };

  type Concrete<T> = {
    [K in keyof T]-?: T[K];
  };

  interface Point {
    readonly x?: number;
    readonly y?: number;
  }

  type MutablePoint = Mutable<Point>; // { x?: number; y?: number }
  type ConcretePoint = Concrete<Point>; // { readonly x: number; readonly y: number }

  const mp: MutablePoint = {};
  mp.x = 10; // ✅ 已移除 readonly，可以修改

  const cp: ConcretePoint = { x: 1, y: 2 }; // ✅ 已移除 ?，兩個屬性都必填
  console.log("-readonly / -?:", mp.x, cp.x, cp.y);
}

// --- 鍵值重新映射（Key Remapping） ---
{
  // 自足原則：本範例用到 User，整段複製進來
  interface User {
    id: number;
    name: string;
    email: string;
  }

  // 為所有鍵加上前綴
  type Prefixed<T, P extends string> = {
    [K in keyof T as `${P}${Capitalize<string & K>}`]: T[K];
  };

  type UserEvents = Prefixed<User, "on">;
  // { onId: number; onName: string; onEmail: string }

  // Getter 型別
  type Getters<T> = {
    [K in keyof T as `get${Capitalize<string & K>}`]: () => T[K];
  };

  type UserGetters = Getters<User>;
  // { getId: () => number; getName: () => string; getEmail: () => string }

  const events: UserEvents = { onId: 1, onName: "Gary", onEmail: "g@x.com" };
  const getters: UserGetters = {
    getId: () => 1,
    getName: () => "Gary",
    getEmail: () => "g@x.com",
  };
  console.log(events.onName, getters.getName());
}

// ===== 7.6 模板字面值型別（Template Literal Types） =====
{
  // 基本模板字面值
  type Greeting = `Hello, ${string}!`;
  let g: Greeting = "Hello, World!"; // ✅
  // let bad: Greeting = "Hi, World!"; // ❌ 不符合 `Hello, ${string}!` 樣式

  // 組合
  type Color = "red" | "green" | "blue";
  type Size = "small" | "medium" | "large";
  type ColorSize = `${Color}-${Size}`;
  // "red-small" | "red-medium" | "red-large" | "green-small" | ...

  // CSS 單位
  type CSSUnit = "px" | "em" | "rem" | "%";
  type CSSValue = `${number}${CSSUnit}`;

  const width: CSSValue = "100px"; // ✅
  const height: CSSValue = "50%"; // ✅

  // 事件名稱
  type EventName<T extends string> = `on${Capitalize<T>}`;
  type ClickEvent = EventName<"click">; // "onClick"
  type ChangeEvent = EventName<"change">; // "onChange"

  const cs: ColorSize = "red-small";
  const click: ClickEvent = "onClick";
  const change: ChangeEvent = "onChange";
  console.log(g, width, height, cs, click, change);
}

// ===== 7.7 內建工具型別（Utility Types） =====

// --- 常用工具型別一覽 ---
{
  interface User {
    id: number;
    name: string;
    email: string;
    age: number;
    role: "admin" | "user";
  }

  // Partial<T> — 所有屬性變成可選
  type UpdateUser = Partial<User>;

  // Required<T> — 所有屬性變成必要
  type StrictUser = Required<User>;

  // Readonly<T> — 所有屬性變成唯讀
  type FrozenUser = Readonly<User>;

  // Pick<T, K> — 選取部分屬性
  type UserPreview = Pick<User, "id" | "name">;
  // { id: number; name: string }

  // Omit<T, K> — 排除部分屬性
  type UserWithoutId = Omit<User, "id">;
  // { name: string; email: string; age: number; role: "admin" | "user" }

  // Record<K, V> — 建立鍵值對型別
  type UserMap = Record<string, User>;

  // Exclude<T, U> — 從聯合型別中排除
  type NonAdmin = Exclude<User["role"], "admin">; // "user"

  // Extract<T, U> — 從聯合型別中提取
  type OnlyAdmin = Extract<User["role"], "admin">; // "admin"

  // NonNullable<T> — 排除 null 和 undefined
  type MaybeString = string | null | undefined;
  type DefiniteString = NonNullable<MaybeString>; // string

  // ReturnType<T> — 取得函式回傳型別
  function createUser() {
    return { id: 1, name: "Gary" };
  }
  type UserReturn = ReturnType<typeof createUser>;
  // { id: number; name: string }

  // Parameters<T> — 取得函式參數型別
  type CreateParams = Parameters<typeof createUser>; // []

  // Awaited<T> — 攤平 Promise（含巢狀 Promise），取得最終解析出的值型別
  interface ApiResponse<T> {
    data: T;
    status: number;
  }

  async function fetchApi<T>(url: string): Promise<ApiResponse<T>> {
    const response = await fetch(url);
    return response.json();
  }

  type FetchedUser = Awaited<ReturnType<typeof fetchApi<User>>>;
  // { data: User; status: number }

  const fetched: FetchedUser = {
    data: { id: 1, name: "Gary", email: "g@x.com", age: 30, role: "user" },
    status: 200,
  };
  console.log("Awaited:", fetched.data.name);

  // 讓型別被引用
  const upd: UpdateUser = { name: "Gary" };
  const strict: StrictUser = {
    id: 1,
    name: "Gary",
    email: "g@x.com",
    age: 30,
    role: "user",
  };
  const frozen: FrozenUser = strict;
  const preview: UserPreview = { id: 1, name: "Gary" };
  const without: UserWithoutId = {
    name: "Gary",
    email: "g@x.com",
    age: 30,
    role: "user",
  };
  const map: UserMap = { gary: strict };
  const nonAdmin: NonAdmin = "user";
  const onlyAdmin: OnlyAdmin = "admin";
  const definite: DefiniteString = "s";
  const ret: UserReturn = createUser();
  const args: CreateParams = [];
  console.log(
    upd,
    frozen.id,
    preview.name,
    without.email,
    map.gary.role,
    nonAdmin,
    onlyAdmin,
    definite,
    ret,
    args
  );
}

// --- 常見陷阱：Omit 對聯合型別不會逐一分佈 ---
{
  type A = { kind: "a"; x: number };
  type B = { kind: "b"; y: number };
  type Both = A | B;

  type BadOmit = Omit<Both, "kind">;
  // 預期可能是 { x: number } | { y: number }
  // 但 keyof (A | B) 只會取兩者共同的鍵（也就是只有 "kind"），
  // 排除 "kind" 之後剩下的鍵是 never，結果 BadOmit 實際上是 {}

  const bad: BadOmit = {}; // ✅ 型別上完全合法，但已經失去 x / y 的資訊
  console.log("Omit 聯合型別陷阱:", bad);
}

// --- 組合工具型別 ---
{
  // 實用組合：建立 DTO（此 User 與上一段不同，故獨立區塊）
  interface User {
    id: number;
    name: string;
    email: string;
    passwordHash: string;
    createdAt: Date;
    updatedAt: Date;
  }

  // 建立用 DTO
  type CreateUserDto = Pick<User, "name" | "email"> & { password: string };

  // 更新用 DTO（部分可選）
  type UpdateUserDto = Partial<Pick<User, "name" | "email">>;

  // 回傳用 DTO（排除敏感資料）
  type UserResponse = Omit<User, "passwordHash">;

  // 列表用 DTO
  type UserListItem = Pick<User, "id" | "name" | "email">;

  const create: CreateUserDto = {
    name: "Gary",
    email: "g@x.com",
    password: "secret",
  };
  const update: UpdateUserDto = { name: "Gary" };
  const response: UserResponse = {
    id: 1,
    name: "Gary",
    email: "g@x.com",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const listItem: UserListItem = { id: 1, name: "Gary", email: "g@x.com" };
  console.log(create.password, update.name, response.id, listItem.email);
}

// ===== 7.8 自定義工具型別 =====
{
  // DeepReadonly — 深層唯讀
  type DeepReadonly<T> = {
    readonly [K in keyof T]: T[K] extends object ? DeepReadonly<T[K]> : T[K];
  };

  // DeepPartial — 深層可選
  type DeepPartial<T> = {
    [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
  };

  // RequireAtLeastOne — 至少需要一個屬性
  type RequireAtLeastOne<T, Keys extends keyof T = keyof T> = Pick<
    T,
    Exclude<keyof T, Keys>
  > &
    {
      [K in Keys]-?: Required<Pick<T, K>> & Partial<Pick<T, Exclude<Keys, K>>>;
    }[Keys];

  // 實際使用
  interface SearchParams {
    name?: string;
    email?: string;
    id?: number;
  }

  type ValidSearch = RequireAtLeastOne<SearchParams>;
  // 至少要提供 name、email、id 的其中一個

  interface Config {
    server: {
      host: string;
      port: number;
    };
    debug: boolean;
  }

  const roConfig: DeepReadonly<Config> = {
    server: { host: "localhost", port: 8080 },
    debug: true,
  };
  const partialConfig: DeepPartial<Config> = { server: { host: "localhost" } };
  const search: ValidSearch = { name: "Gary" };
  console.log(roConfig.server.host, partialConfig.server?.port, search);
}

// ===== 練習題 =====

// --- 練習 1：條件型別（Flatten） ---
{
  // 練習參考解答
  type Flatten<T> = T extends (infer E)[] ? E : T;

  type A = Flatten<number[]>; // number
  type B = Flatten<string[][]>; // string[]
  type C = Flatten<string>; // string

  const a: A = 1;
  const b: B = ["x", "y"];
  const c: C = "hello";
  console.log(a, b, c);
}

// --- 練習 2：映射型別（Mutable） ---
{
  // 練習參考解答：用 -readonly 移除唯讀修飾
  type Mutable<T> = {
    -readonly [K in keyof T]: T[K];
  };

  interface Point {
    readonly x: number;
    readonly y: number;
  }

  type MutablePoint = Mutable<Point>;

  const p: MutablePoint = { x: 1, y: 2 };
  p.x = 10; // 已可修改
  console.log(p.x, p.y);
}

// --- 練習 3：工具型別組合（FormState） ---
{
  interface FormField<T> {
    value: T;
    error: string | null;
    touched: boolean;
  }

  // 練習參考解答：將 T 的每個屬性轉換為 FormField
  type FormState<T> = {
    [K in keyof T]: FormField<T[K]>;
  };

  interface LoginForm {
    username: string;
    password: string;
    remember: boolean;
  }

  const state: FormState<LoginForm> = {
    username: { value: "gary", error: null, touched: true },
    password: { value: "", error: "必填", touched: false },
    remember: { value: true, error: null, touched: false },
  };
  console.log(state.username.value, state.password.error);
}

console.log("第 7 章 進階型別技巧 範例載入完成 ✅");

export {};
