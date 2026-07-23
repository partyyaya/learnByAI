// =============================================================================
// 第 13 章 型別層級程式設計（Type-Level Programming）
//
// 本章幾乎都是「型別層級」程式碼，沒有執行期輸出。
// 正確性靠「型別斷言 + 型別檢查」驗證：只要 tsc --noEmit 通過（0 錯誤），
// 就代表所有 Expect<Equal<...>> 斷言都成立。
//
// 為了避免同名 type 互相衝突，每個獨立範例（或小節）各自包在一個 { ... }
// 區塊內，type 在區塊內是區塊作用域，彼此不干擾。
// 下面全域定義的 Equal / Expect 為 type-challenges 標準斷言工具，區塊內可直接用。
// =============================================================================

// ---- type-challenges 標準斷言工具（全域，最上方定義一次）----
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// ===== 13.1 什麼是型別層級程式設計？ =====
{
  // 值層級：一個把數字加一的函式
  function inc(n: number): number {
    return n + 1;
  }
  const two = inc(1); // 值：2

  // 型別層級：一個「把布林值反轉」的型別函式
  type Not<B extends boolean> = B extends true ? false : true;
  type A = Not<true>; // 型別：false
  type B = Not<false>; // 型別：true

  type _t = [Expect<Equal<A, false>>, Expect<Equal<B, true>>, Expect<Equal<typeof two, number>>];
}

// ===== 13.2 型別層級的基本構件 =====

// 字面值型別 = 常數
{
  type Zero = 0;
  type Yes = "yes";
  type True = true;

  type _t = [Expect<Equal<Zero, 0>>, Expect<Equal<Yes, "yes">>, Expect<Equal<True, true>>];
}

// 泛型 = 函式
{
  // 一個接受 T、回傳「T 或 null」的型別函式
  type Nullable<T> = T | null;
  type MaybeString = Nullable<string>; // string | null

  type _t = Expect<Equal<MaybeString, string | null>>;
}

// extends = 比較 / 子型別判斷
{
  type T1 = "hello" extends string ? true : false; // true
  type T2 = string extends "hello" ? true : false; // false
  type T3 = 1 extends number ? true : false; // true
  type T4 = { a: 1; b: 2 } extends { a: 1 } ? true : false; // true（多的屬性仍相容）

  type _t = [
    Expect<Equal<T1, true>>,
    Expect<Equal<T2, false>>,
    Expect<Equal<T3, true>>,
    Expect<Equal<T4, true>>,
  ];
}

// 條件型別 = if / else
{
  type IsArray<T> = T extends any[] ? true : false;
  type A = IsArray<string[]>; // true
  type B = IsArray<number>; // false

  type _t = [Expect<Equal<A, true>>, Expect<Equal<B, false>>];
}

// infer = 解構 / 變數綁定
{
  // 抓出陣列的元素型別
  type ElementOf<T> = T extends (infer E)[] ? E : never;
  type E = ElementOf<number[]>; // number

  // 抓出 Promise 內的值型別
  type Awaited1<T> = T extends Promise<infer V> ? V : T;
  type V = Awaited1<Promise<string>>; // string

  // 一次抓出多個
  type SplitFirst<T> = T extends [infer Head, ...infer Tail] ? { head: Head; tail: Tail } : never;
  type R = SplitFirst<[1, 2, 3]>; // { head: 1; tail: [2, 3] }

  type _t = [
    Expect<Equal<E, number>>,
    Expect<Equal<V, string>>,
    Expect<Equal<R, { head: 1; tail: [2, 3] }>>,
  ];
}

// ===== 13.3 遞迴型別（Recursive Types）=====

// 反轉元組
{
  type Reverse<T extends unknown[]> = T extends [infer Head, ...infer Tail]
    ? [...Reverse<Tail>, Head] // 遞迴：先反轉剩餘，再把 Head 放到最後
    : []; // 終止條件：空元組

  type R = Reverse<[1, 2, 3]>; // [3, 2, 1]

  type _t = Expect<Equal<R, [3, 2, 1]>>;
}

// 尾遞迴（tail-recursive）與累加器（accumulator）模式
{
  // ❌ 非尾遞迴：遞迴結果外面還包了一層 [..., Head]
  type ReverseSlow<T extends unknown[]> = T extends [infer H, ...infer R] ? [...ReverseSlow<R>, H] : [];

  // ✅ 尾遞迴：用 Acc 累加器攜帶中間結果，遞迴是最後一步
  type ReverseFast<T extends unknown[], Acc extends unknown[] = []> = T extends [infer H, ...infer R]
    ? ReverseFast<R, [H, ...Acc]> // 直接回傳遞迴呼叫
    : Acc;

  type R = ReverseFast<[1, 2, 3, 4, 5]>; // [5, 4, 3, 2, 1]

  type _t = [
    Expect<Equal<ReverseSlow<[1, 2, 3]>, [3, 2, 1]>>,
    Expect<Equal<R, [5, 4, 3, 2, 1]>>,
  ];
}

// ===== 13.4 元組型別運算（Tuple Manipulation）=====
{
  // Head：取第一個元素
  type Head<T extends unknown[]> = T extends [infer H, ...unknown[]] ? H : never;
  type H = Head<[1, 2, 3]>; // 1

  // Tail：去掉第一個元素
  type Tail<T extends unknown[]> = T extends [unknown, ...infer R] ? R : [];
  type T = Tail<[1, 2, 3]>; // [2, 3]

  // Last：取最後一個元素
  type Last<T extends unknown[]> = T extends [...unknown[], infer L] ? L : never;
  type L = Last<[1, 2, 3]>; // 3

  // Length：取長度（元組的 length 是字面值型別！）
  type Length<T extends unknown[]> = T["length"];
  type Len = Length<[1, 2, 3]>; // 3

  // Push / Unshift
  type Push<T extends unknown[], V> = [...T, V];
  type Unshift<T extends unknown[], V> = [V, ...T];
  type P = Push<[1, 2], 3>; // [1, 2, 3]
  type U = Unshift<[2, 3], 1>; // [1, 2, 3]

  // Concat：串接兩個元組
  type Concat<A extends unknown[], B extends unknown[]> = [...A, ...B];
  type C = Concat<[1, 2], [3, 4]>; // [1, 2, 3, 4]

  type _t = [
    Expect<Equal<H, 1>>,
    Expect<Equal<T, [2, 3]>>,
    Expect<Equal<L, 3>>,
    Expect<Equal<Len, 3>>,
    Expect<Equal<P, [1, 2, 3]>>,
    Expect<Equal<U, [1, 2, 3]>>,
    Expect<Equal<C, [1, 2, 3, 4]>>,
  ];
}

// ===== 13.5 型別層級的算術（Type-Level Arithmetic）=====
{
  // 建立長度為 L 的元組（元素內容用 unknown 即可）
  type BuildTuple<L extends number, T extends unknown[] = []> = T["length"] extends L
    ? T
    : BuildTuple<L, [...T, unknown]>;

  type Three = BuildTuple<3>; // [unknown, unknown, unknown]

  // 加法：兩個元組接起來讀長度
  type Add<A extends number, B extends number> = [...BuildTuple<A>, ...BuildTuple<B>]["length"];
  type Sum = Add<3, 4>; // 7

  // 減法：A 的元組能不能拆成「B 的元組 + 剩下 Rest」，Rest 的長度就是答案
  type Subtract<A extends number, B extends number> = BuildTuple<A> extends [...BuildTuple<B>, ...infer Rest]
    ? Rest["length"]
    : never;
  type Diff = Subtract<7, 4>; // 3

  // 比較大小：A 減 B 有結果（且不為 0）代表 A > B
  type GreaterThan<A extends number, B extends number> = BuildTuple<A> extends [
    ...BuildTuple<B>,
    unknown,
    ...unknown[],
  ]
    ? true
    : false;
  type G1 = GreaterThan<5, 3>; // true
  type G2 = GreaterThan<3, 5>; // false

  type _t = [
    Expect<Equal<Three, [unknown, unknown, unknown]>>,
    Expect<Equal<Sum, 7>>,
    Expect<Equal<Diff, 3>>,
    Expect<Equal<G1, true>>,
    Expect<Equal<G2, false>>,
  ];
}

// ===== 13.6 字串型別運算（String Manipulation）=====
{
  // Split：依分隔符切成元組
  type Split<S extends string, D extends string> = S extends `${infer Head}${D}${infer Tail}`
    ? [Head, ...Split<Tail, D>]
    : [S];
  type Parts = Split<"2026-07-23", "-">; // ["2026", "07", "23"]

  // Join：把字串元組用分隔符接起來
  type Join<T extends string[], D extends string> = T extends [
    infer F extends string,
    ...infer R extends string[],
  ]
    ? R extends []
      ? F
      : `${F}${D}${Join<R, D>}`
    : "";
  type Path = Join<["a", "b", "c"], "/">; // "a/b/c"

  // Trim：去除頭尾空白
  type TrimLeft<S extends string> = S extends ` ${infer R}` ? TrimLeft<R> : S;
  type TrimRight<S extends string> = S extends `${infer R} ` ? TrimRight<R> : S;
  type Trim<S extends string> = TrimLeft<TrimRight<S>>;
  type Trimmed = Trim<"   hello   ">; // "hello"

  // Replace：替換第一個符合的子字串
  type Replace<S extends string, From extends string, To extends string> = From extends ""
    ? S
    : S extends `${infer Head}${From}${infer Tail}`
      ? `${Head}${To}${Tail}`
      : S;
  type Replaced = Replace<"hello world", "world", "TypeScript">; // "hello TypeScript"

  // snake_case 轉 camelCase
  type SnakeToCamel<S extends string> = S extends `${infer Head}_${infer Tail}`
    ? `${Head}${Capitalize<SnakeToCamel<Tail>>}`
    : S;
  type Camel = SnakeToCamel<"user_first_name">; // "userFirstName"

  type _t = [
    Expect<Equal<Parts, ["2026", "07", "23"]>>,
    Expect<Equal<Path, "a/b/c">>,
    Expect<Equal<Trimmed, "hello">>,
    Expect<Equal<Replaced, "hello TypeScript">>,
    Expect<Equal<Camel, "userFirstName">>,
  ];
}

// ===== 13.7 分配式條件型別（Distributive Conditional Types）=====

// 分配：條件型別作用在裸型別參數且該參數是聯合型別時，會對每個成員分別套用
{
  type ToArray<T> = T extends any ? T[] : never;
  // T 是聯合型別，會分配：ToArray<string> | ToArray<number>
  type R = ToArray<string | number>; // string[] | number[]

  type _t = Expect<Equal<R, string[] | number[]>>;
}

// 關閉分配：把 extends 兩側用元組包起來，破壞「裸」型別
{
  type ToArrayNonDist<T> = [T] extends [any] ? T[] : never;
  type R = ToArrayNonDist<string | number>; // (string | number)[]

  type _t = Expect<Equal<R, (string | number)[]>>;
}

// 常見應用
{
  // 判斷是否為聯合型別
  type IsUnion<T, U = T> = T extends U ? ([U] extends [T] ? false : true) : never;
  type A = IsUnion<string>; // false
  type B = IsUnion<string | number>; // true

  // 聯合型別轉交集型別
  type UnionToIntersection<U> = (U extends any ? (arg: U) => void : never) extends (arg: infer I) => void
    ? I
    : never;
  type C = UnionToIntersection<{ a: 1 } | { b: 2 }>; // { a: 1 } & { b: 2 }

  // 過濾聯合型別（自己實作 Exclude）
  type MyExclude<T, U> = T extends U ? never : T;
  type D = MyExclude<"a" | "b" | "c", "b">; // "a" | "c"

  type _t = [
    Expect<Equal<A, false>>,
    Expect<Equal<B, true>>,
    Expect<Equal<C, { a: 1 } & { b: 2 }>>,
    Expect<Equal<D, "a" | "c">>,
  ];
}

// ===== 13.8 實戰案例 =====

// 案例一：型別安全的物件路徑
{
  // 依 "a.b.c" 這種路徑，取出巢狀屬性的型別
  type Get<T, P extends string> = P extends `${infer Key}.${infer Rest}`
    ? Key extends keyof T
      ? Get<T[Key], Rest>
      : never
    : P extends keyof T
      ? T[P]
      : never;

  interface AppState {
    user: {
      profile: {
        name: string;
        age: number;
      };
      isLoggedIn: boolean;
    };
  }

  type Name = Get<AppState, "user.profile.name">; // string
  type Age = Get<AppState, "user.profile.age">; // number
  type Bad = Get<AppState, "user.profile.xxx">; // never（打錯字直接變 never）

  type _t = [
    Expect<Equal<Name, string>>,
    Expect<Equal<Age, number>>,
    Expect<Equal<Bad, never>>,
  ];
}

// 案例二：列出所有合法路徑（自動補全）
{
  // 產生物件所有「點路徑」字串的聯合型別
  type Paths<T> = T extends object
    ? {
        [K in keyof T & string]: T[K] extends object ? `${K}` | `${K}.${Paths<T[K]>}` : `${K}`;
      }[keyof T & string]
    : never;

  interface AppState {
    user: {
      profile: { name: string; age: number };
      isLoggedIn: boolean;
    };
  }

  type AllPaths = Paths<AppState>;
  // "user" | "user.profile" | "user.profile.name"
  //   | "user.profile.age" | "user.isLoggedIn"

  // 搭配 Get，寫一個型別安全的取值函式
  // （原文為 declare function；此處改為一般函式加空實作，讓檔案可獨立編譯）
  function get<T, P extends Paths<T>>(_obj: T, _path: P): unknown {
    return undefined;
  }
  void get; // 避免「宣告但未使用」的觀感；呼叫時 path 參數會有自動補全

  type _t = Expect<
    Equal<
      AllPaths,
      "user" | "user.profile" | "user.profile.name" | "user.profile.age" | "user.isLoggedIn"
    >
  >;
}

// 案例三：從路由字串解析參數
{
  // 抓出路由中所有 ":param" 的名稱
  type PathParams<Path extends string> = Path extends `${string}:${infer Param}/${infer Rest}`
    ? Param | PathParams<`/${Rest}`>
    : Path extends `${string}:${infer Param}`
      ? Param
      : never;

  // 組成參數物件型別
  type RouteParams<Path extends string> = {
    [K in PathParams<Path>]: string;
  };

  type Params = RouteParams<"/users/:userId/posts/:postId">;
  // { userId: string; postId: string }

  // 型別安全的路由處理器（原文為 declare function；此處改為一般函式加空實作）
  function route<Path extends string>(_path: Path, _handler: (params: RouteParams<Path>) => void): void {}

  route("/users/:userId/posts/:postId", (params) => {
    params.userId; // ✅ string
    params.postId; // ✅ string
    // params.foo; // ❌ 型別錯誤：foo 不存在
  });

  type _t = Expect<Equal<Params, { userId: string; postId: string }>>;
}

// 案例四：型別安全的事件系統
{
  // 定義事件名稱與對應的 payload 型別
  // （原文為 interface EventMap；改為 type 才能滿足下方 Record<string, any> 約束，
  //   因為 interface 沒有隱式索引簽章、無法賦值給 Record<string, any>）
  type EventMap = {
    click: { x: number; y: number };
    submit: { formId: string };
    close: void;
  };

  class EventBus<T extends Record<string, any>> {
    private handlers: { [K in keyof T]?: Array<(payload: T[K]) => void> } = {};

    on<K extends keyof T>(event: K, handler: (payload: T[K]) => void): void {
      (this.handlers[event] ??= []).push(handler);
    }

    emit<K extends keyof T>(event: K, payload: T[K]): void {
      this.handlers[event]?.forEach((h) => h(payload));
    }
  }

  const bus = new EventBus<EventMap>();

  bus.on("click", (p) => {
    console.log(p.x, p.y); // ✅ p 的型別是 { x: number; y: number }
  });

  bus.emit("submit", { formId: "login" }); // ✅
  // bus.emit("submit", { x: 1 });          // ❌ payload 型別不符
}

// ===== 13.9 效能與陷阱：除錯技巧 =====
{
  // 自足：從 13.6 複製 Split，供 Step1 使用
  type Split<S extends string, D extends string> = S extends `${infer Head}${D}${infer Tail}`
    ? [Head, ...Split<Tail, D>]
    : [S];

  // 自足：從 13.8 案例一複製 Get
  type Get<T, P extends string> = P extends `${infer Key}.${infer Rest}`
    ? Key extends keyof T
      ? Get<T[Key], Rest>
      : never
    : P extends keyof T
      ? T[P]
      : never;

  // 技巧一：用一個「展開」型別強制 IDE hover 顯示最終結果
  type Expand<T> = T extends infer O ? { [K in keyof O]: O[K] } : never;
  type _expand = Expect<Equal<Expand<{ a: 1 } & { b: 2 }>, { a: 1; b: 2 }>>;

  // 技巧二：階段性驗證，把中間型別拆出來單獨 hover 檢查
  type Step1 = Split<"a-b-c", "-">; // 滑鼠移上去看是不是 ["a","b","c"]
  type _step = Expect<Equal<Step1, ["a", "b", "c"]>>;

  // 技巧三：善用 @ts-expect-error 標記「這裡本來就該報錯」
  // 注意：本章的 Get 對錯誤路徑回傳 never（並不會報錯），所以這裡用斷言驗證
  type ShouldBeNever = Get<{ a: 1 }, "b">; // never
  type _never = Expect<Equal<ShouldBeNever, never>>;

  // 若把 P 限制為 keyof T，錯誤路徑就會在編譯期被擋下，@ts-expect-error 才有東西可抓
  type StrictGet<T, P extends keyof T> = T[P];
  // @ts-expect-error 'b' 不存在於 { a: 1 }，預期報錯
  type ShouldFail = StrictGet<{ a: 1 }, "b">;
  void 0 as unknown as ShouldFail; // 使用一下，避免「宣告但未使用」觀感
}

// ===== 13.10 測試你的型別 =====
{
  // 自足：把下面測試會用到的型別，從前面各節整段複製進來
  type BuildTuple<L extends number, T extends unknown[] = []> = T["length"] extends L
    ? T
    : BuildTuple<L, [...T, unknown]>;
  type Add<A extends number, B extends number> = [...BuildTuple<A>, ...BuildTuple<B>]["length"];

  type Reverse<T extends unknown[]> = T extends [infer Head, ...infer Tail]
    ? [...Reverse<Tail>, Head]
    : [];

  type Split<S extends string, D extends string> = S extends `${infer Head}${D}${infer Tail}`
    ? [Head, ...Split<Tail, D>]
    : [S];

  type SnakeToCamel<S extends string> = S extends `${infer Head}_${infer Tail}`
    ? `${Head}${Capitalize<SnakeToCamel<Tail>>}`
    : S;

  type PathParams<Path extends string> = Path extends `${string}:${infer Param}/${infer Rest}`
    ? Param | PathParams<`/${Rest}`>
    : Path extends `${string}:${infer Param}`
      ? Param
      : never;
  type RouteParams<Path extends string> = {
    [K in PathParams<Path>]: string;
  };

  // ---- 型別測試 ----
  type Cases = [
    Expect<Equal<Add<3, 4>, 7>>,
    Expect<Equal<Reverse<[1, 2, 3]>, [3, 2, 1]>>,
    Expect<Equal<Split<"a,b,c", ",">, ["a", "b", "c"]>>,
    Expect<Equal<SnakeToCamel<"user_id">, "userId">>,
    Expect<Equal<RouteParams<"/u/:id">, { id: string }>>,
  ];
  // 只要有任何一個型別不符，這一行就會出現紅線
  type _cases = Cases;
}

// =============================================================================
// 練習題參考解答
// =============================================================================

// 練習 1：型別層級的 Filter
{
  // 練習參考解答：逐一走訪元組，保留可賦值給 U 的元素
  type Filter<T extends unknown[], U> = T extends [infer H, ...infer R]
    ? H extends U
      ? [H, ...Filter<R, U>]
      : Filter<R, U>
    : [];

  type A = Filter<[1, "a", 2, "b", 3], number>; // [1, 2, 3]
  type B = Filter<[true, 0, "x", false], boolean>; // [true, false]

  type _t = [Expect<Equal<A, [1, 2, 3]>>, Expect<Equal<B, [true, false]>>];
}

// 練習 2：字串轉聯合型別
{
  // 練習參考解答：逐字元遞迴，把每個字元收集成聯合型別
  type CharUnion<S extends string> = S extends `${infer Head}${infer Rest}`
    ? Head | CharUnion<Rest>
    : never;

  type A = CharUnion<"abc">; // "a" | "b" | "c"

  type _t = Expect<Equal<A, "a" | "b" | "c">>;
}

// 練習 3：實作 DeepReadonly（含陣列與函式）
{
  // 練習參考解答：先排除函式（保持可呼叫），物件/陣列才遞迴加 readonly
  type DeepReadonly<T> = T extends (...args: any[]) => any
    ? T
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

  interface State {
    user: { name: string; roles: string[] };
    update: () => void;
  }
  type Frozen = DeepReadonly<State>;
  // user、user.name、user.roles 都是 readonly，但 update 仍是可呼叫的函式

  type _t = Expect<
    Equal<
      Frozen,
      {
        readonly user: {
          readonly name: string;
          readonly roles: readonly string[];
        };
        readonly update: () => void;
      }
    >
  >;
}

// 練習 4：型別層級的 SQL SELECT
{
  // 練習參考解答：直接用映射型別挑出指定欄位（不使用內建 Pick）
  type Select<T, K extends keyof T> = { [P in K]: T[P] };

  interface User {
    id: number;
    name: string;
    email: string;
    password: string;
  }
  type PublicUser = Select<User, "id" | "name" | "email">;
  // { id: number; name: string; email: string }

  type _t = Expect<Equal<PublicUser, { id: number; name: string; email: string }>>;
}

console.log("第 13 章 型別層級程式設計 範例載入完成 ✅（正確性由 tsc 型別檢查保證）");

export {};
