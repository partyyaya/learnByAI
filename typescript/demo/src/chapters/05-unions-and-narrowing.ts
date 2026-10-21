// 第五章：聯合型別與型別縮窄
//
// 本檔為課程範例整理，供 demo 測試環境做型別檢查使用。
// 每個獨立範例都包在自己的 `{ ... }` 區塊內，以避免同名 type/interface 互相衝突。

// ===== 5.1 聯合型別（Union Types） =====
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

// ===== 5.1 satisfies 運算子（TS 4.9+） =====
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

// ===== 5.1 satisfies 場景 1：設定表 / 常數表（最常見）=====
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

  console.log("5.1 satisfies 設定表:", Object.keys(routesA), go("admin"));
  // 路由表、i18n 語系檔、權限表、選單設定、API endpoint 對照表都是這個形狀
}

// ===== 5.1 satisfies 場景 2：值的精確型別後續還要拿來用 =====
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
    console.log("5.1 satisfies 精確型別:", doubled, upper, config.port);
  }
}

// ===== 5.1 satisfies 場景 3：搭配 as const =====
{
  // as const 負責凍結成字面量，satisfies 負責驗證形狀
  const ROLES = ["admin", "user"] as const satisfies readonly string[];
  type Role = (typeof ROLES)[number]; // "admin" | "user"

  const current: Role = "admin";
  // const bad: Role = "guest"; // ❌ 不在 ROLES 之中

  console.log("5.1 satisfies as const:", ROLES, current);

  // 判斷準則：
  //   值之後只當「某個型別」用，不在乎具體內容            → 用 : T 標註
  //   值本身的內容還要拿來推導（keyof typeof、縮窄、字面量）→ 用 satisfies
  //   想用 as T 繞過檢查時                               → 先想想是不是該用 satisfies
}

// ===== 5.2 型別縮窄（Type Narrowing） =====

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

// --- 真值與相等性縮窄 ---
{
  function greet(name: string | null | undefined): string {
    if (!name) {
      return "Hi, guest"; // name 是 null | undefined | ""
    }
    return `Hi, ${name.toUpperCase()}`; // name 已縮窄成 string
  }

  function describe(status: "loading" | "success" | "error"): string {
    if (status === "loading") {
      return "載入中…";
    }
    return status; // "success" | "error"
  }

  console.log(greet(null), greet("gary"), describe("loading"), describe("error"));
}

// --- instanceof Guard ---
{
  class ApiError {
    statusCode: number;
    message: string;

    constructor(statusCode: number, message: string) {
      this.statusCode = statusCode;
      this.message = message;
    }
  }

  class NetworkError {
    message: string;

    constructor(message: string) {
      this.message = message;
    }
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

// ===== 練習題 =====

// --- 練習 1：判別式聯合與窮盡性檢查 ---
{
  type Payment =
    | { method: "card"; last4: string }
    | { method: "transfer"; bankCode: string; account: string }
    | { method: "cash" };

  function describePayment(payment: Payment): string {
    switch (payment.method) {
      case "card":
        return `信用卡末四碼 ${payment.last4}`;
      case "transfer":
        return `轉帳 ${payment.bankCode}-${payment.account}`;
      case "cash":
        return "現金";
      default: {
        const _exhaustive: never = payment;
        throw new Error(`Unhandled payment: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  console.log(describePayment({ method: "card", last4: "4242" }));
}

// --- 練習 2：型別守衛驗證 API 資料 ---
{
  interface User {
    id: number;
    name: string;
  }

  function isUser(value: unknown): value is User {
    return (
      typeof value === "object" &&
      value !== null &&
      "id" in value &&
      "name" in value &&
      typeof value.id === "number" &&
      typeof value.name === "string"
    );
  }

  const data: unknown = JSON.parse('{"id":1,"name":"Gary"}');
  if (isUser(data)) {
    console.log(data.name.toUpperCase());
  }
}

// --- 練習 3：用 satisfies 定義設定表 ---
{
  type StatusInfo = { message: string; retry: boolean };

  const STATUS = {
    ok: { message: "成功", retry: false },
    notFound: { message: "找不到資源", retry: false },
    serverError: { message: "伺服器錯誤", retry: true },
  } satisfies Record<string, StatusInfo>;

  type StatusKey = keyof typeof STATUS;
  const key: StatusKey = "notFound";
  // const bad: StatusKey = "timeout"; // ❌ 不是合法的鍵
  console.log(STATUS[key].message);
}

console.log("第 5 章 聯合型別與型別縮窄 範例載入完成 ✅");

export {};

