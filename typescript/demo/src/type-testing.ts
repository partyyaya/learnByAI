// ┌─────────────────────────────────────────────────────────────┐
// │  type-testing.ts —— 型別層級程式設計的「測試檔」               │
// ├─────────────────────────────────────────────────────────────┤
// │  這個檔案幾乎沒有執行期程式碼，重點是用 `npm run check` 驗證   │
// │  型別是否符合預期。若任何 Expect<Equal<...>> 不成立，該行會   │
// │  出現紅線、npm run check 也會失敗。                            │
// │                                                               │
// │  搭配課程第 13 章「型別層級程式設計」閱讀。                    │
// └─────────────────────────────────────────────────────────────┘

import type { Equal, Expect } from "./type-utils.js";

// ── 元組運算 ──────────────────────────────────────────────
type Reverse<T extends unknown[], Acc extends unknown[] = []> = T extends [
  infer H,
  ...infer R,
]
  ? Reverse<R, [H, ...Acc]>
  : Acc;

// ── 型別層級算術（用元組長度代表數字）────────────────────
type BuildTuple<
  L extends number,
  T extends unknown[] = [],
> = T["length"] extends L ? T : BuildTuple<L, [...T, unknown]>;

type Add<A extends number, B extends number> = [
  ...BuildTuple<A>,
  ...BuildTuple<B>,
]["length"];

// ── 字串運算 ──────────────────────────────────────────────
type Split<
  S extends string,
  D extends string,
> = S extends `${infer Head}${D}${infer Tail}` ? [Head, ...Split<Tail, D>] : [S];

type SnakeToCamel<S extends string> = S extends `${infer Head}_${infer Tail}`
  ? `${Head}${Capitalize<SnakeToCamel<Tail>>}`
  : S;

// ── 路由參數解析 ──────────────────────────────────────────
type PathParams<Path extends string> =
  Path extends `${string}:${infer Param}/${infer Rest}`
    ? Param | PathParams<`/${Rest}`>
    : Path extends `${string}:${infer Param}`
      ? Param
      : never;

type RouteParams<Path extends string> = { [K in PathParams<Path>]: string };

// ╔═══════════════════════════════════════════════════════════╗
// ║  型別斷言：只要有任何一行紅線，npm run check 就會失敗       ║
// ╚═══════════════════════════════════════════════════════════╝
type _Cases = [
  Expect<Equal<Reverse<[1, 2, 3]>, [3, 2, 1]>>,
  Expect<Equal<Add<3, 4>, 7>>,
  Expect<Equal<Split<"2026-07-23", "-">, ["2026", "07", "23"]>>,
  Expect<Equal<SnakeToCamel<"user_first_name">, "userFirstName">>,
  Expect<
    Equal<
      RouteParams<"/users/:userId/posts/:postId">,
      { userId: string; postId: string }
    >
  >,
];

// 讓 tsx 執行時也有輸出（型別驗證主要靠 npm run check）
console.log("✅ type-testing.ts：型別斷言若能通過型別檢查即代表正確");
console.log("   執行 `npm run check` 來實際驗證這些型別。");

export {};
