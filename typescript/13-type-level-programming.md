# 第十三章：型別層級程式設計（Type-Level Programming）

> 本章屬於進階補充章節。建議先熟悉 [第六章 泛型](./06-generics.md) 與 [第七章 進階型別技巧](./07-advanced-types.md) 再來閱讀。

## 13.1 什麼是型別層級程式設計？

一般寫程式時，我們在**值的層級（value level）** 操作資料：宣告變數、呼叫函式、跑迴圈。而 TypeScript 的型別系統本身就是一套**在編譯期執行的小型程式語言**，我們可以在**型別層級（type level）** 做計算：把型別當成資料，用泛型當成函式，用條件型別當成分支，用遞迴當成迴圈。

這件事之所以可能，是因為 TypeScript 的型別系統是**圖靈完備（Turing complete）** 的——理論上任何可計算的邏輯都能用型別表達出來。

### 值層級 vs 型別層級對照

| 值層級（執行期） | 型別層級（編譯期） |
|------------------|--------------------|
| 變數 `const x = 1` | 型別別名 `type X = 1` |
| 函式 `f(a, b)` | 泛型 `Type<A, B>` |
| 參數 | 泛型參數 `<T>` |
| `if / else` | 條件型別 `T extends U ? X : Y` |
| 解構賦值 `const [a, ...rest] = arr` | `infer` 搭配 `[A, ...Rest]` |
| 迴圈 / 遞迴 | 遞迴型別 |
| 回傳值 | 條件型別的結果 |

```typescript
// 值層級：一個把數字加一的函式
function inc(n: number): number {
  return n + 1;
}
const two = inc(1); // 值：2

// 型別層級：一個「把布林值反轉」的型別函式
type Not<B extends boolean> = B extends true ? false : true;
type A = Not<true>;  // 型別：false
type B = Not<false>; // 型別：true
```

### 為什麼要學這個？

型別層級程式設計不是為了炫技，而是讓型別能**精確描述真實邏輯**，把更多錯誤留在編譯期：

- **更強的型別推導**：例如根據字串路由 `"/users/:id"` 自動推出參數型別 `{ id: string }`。
- **API 設計**：函式庫作者能提供「用了就對」的型別提示（如 `zod`、`Prisma`、`tRPC` 都大量使用）。
- **編譯期驗證**：例如物件路徑 `"user.profile.name"` 只允許實際存在的路徑，打錯字直接紅線。

> ⚠️ 提醒：型別層級程式設計威力強大，但也容易寫出難以維護、拖慢編譯速度的型別。本章最後 13.9 會專門討論「什麼時候該收手」。

---

## 13.2 型別層級的基本構件

在開始寫複雜型別前，先把五個基本構件對應清楚。

### 字面值型別 = 常數

```typescript
type Zero = 0;
type Yes = "yes";
type True = true;
```

### 泛型 = 函式

泛型參數就是型別函式的「輸入」，型別別名的內容就是「回傳值」。

```typescript
// 一個接受 T、回傳「T 或 null」的型別函式
type Nullable<T> = T | null;

type MaybeString = Nullable<string>; // string | null
```

### `extends` = 比較 / 子型別判斷

在條件型別中，`A extends B` 問的是「A 是不是 B 的子型別（能不能賦值給 B）」。

```typescript
type T1 = "hello" extends string ? true : false; // true
type T2 = string extends "hello" ? true : false; // false
type T3 = 1 extends number ? true : false;        // true
type T4 = { a: 1; b: 2 } extends { a: 1 } ? true : false; // true（多的屬性仍相容）
```

### 型變標註 `in` / `out`（TypeScript 4.7+）

`extends` 問的是「A 能不能賦值給 B」，而**型變（variance）** 問的是：當 `A extends B` 成立時，包了一層泛型的 `Box<A>` 是否也該滿足 `Box<A> extends Box<B>`——這正是型別層級程式設計裡「精確描述型別關係」的核心問題之一。第 6 章 6.4 節已經示範過 `out`（協變，`T` 只出現在讀出位置）與 `in`（逆變，`T` 只出現在寫入位置）這兩種標註；這裡補上第三種、也是最嚴格的一種——`in out`（不變）：當 `T` 同時出現在讀跟寫的位置（例如可讀可寫的屬性），就必須讀寫兩個方向都能互相賦值，只滿足其中一邊是不夠的：

```typescript
class Animal {
  name = "";
}
class Dog extends Animal {
  breed = ""; // Dog 比 Animal 多這個欄位
}

interface Container<in out T> {
  value: T;
}

const dogContainer: Container<Dog> = { value: new Dog() };
let animalContainer: Container<Animal>;
// ❌ 不變：Dog extends Animal 成立，但 Animal extends Dog 不成立（缺少 breed），
//    兩個方向沒有同時滿足，所以 Container<Dog> 不是 Container<Animal> 的子型別
animalContainer = dogContainer;
```

不標記時 TypeScript 仍會自動推導型變方向，但推導在遞迴或複雜型別上可能昂貴、甚至不夠精確；明確標註能讓編譯器檢查更快，也讓錯誤訊息更貼近問題根源。

### 條件型別 = if / else

```typescript
type IsArray<T> = T extends any[] ? true : false;

type A = IsArray<string[]>; // true
type B = IsArray<number>;   // false
```

### `infer` = 解構 / 變數綁定

`infer` 讓我們在條件型別的 `extends` 子句裡「抓出」某個位置的型別，綁定到一個新的型別變數。

```typescript
// 抓出陣列的元素型別
type ElementOf<T> = T extends (infer E)[] ? E : never;
type E = ElementOf<number[]>; // number

// 抓出 Promise 內的值型別
type Awaited1<T> = T extends Promise<infer V> ? V : T;
type V = Awaited1<Promise<string>>; // string

// 一次抓出多個
type SplitFirst<T> = T extends [infer Head, ...infer Tail]
  ? { head: Head; tail: Tail }
  : never;
type R = SplitFirst<[1, 2, 3]>; // { head: 1; tail: [2, 3] }
```

---

## 13.3 遞迴型別（Recursive Types）

型別沒有 `for` 迴圈，重複運算靠**遞迴**——型別在自己的定義裡呼叫自己，直到滿足終止條件。

```typescript
// 反轉元組
type Reverse<T extends unknown[]> = T extends [infer Head, ...infer Tail]
  ? [...Reverse<Tail>, Head] // 遞迴：先反轉剩餘，再把 Head 放到最後
  : []; // 終止條件：空元組

type R = Reverse<[1, 2, 3]>; // [3, 2, 1]
```

### 遞迴深度限制

TypeScript 為了避免無窮遞迴會限制實例化深度，超過會報錯：

```
Type instantiation is excessively deep and possibly infinite.
```

- 一般遞迴大約在 **50 層** 左右觸頂。
- 從 TypeScript 4.5 起，**尾遞迴（tail-recursive）** 的條件型別會被最佳化，深度可拉高到約 **1000 層**。

「尾遞迴」指的是遞迴呼叫是整個運算的**最後一步**（結果直接回傳，不再包在其他運算裡）。要達成通常會用**累加器（accumulator）** 模式：

```typescript
// ❌ 非尾遞迴：遞迴結果外面還包了一層 [..., Head]
type ReverseSlow<T extends unknown[]> = T extends [infer H, ...infer R]
  ? [...ReverseSlow<R>, H]
  : [];

// ✅ 尾遞迴：用 Acc 累加器攜帶中間結果，遞迴是最後一步
type ReverseFast<
  T extends unknown[],
  // Acc = accumulator（累加器）：一個「多出來的參數」，用來存放已經算好的中間結果。
  // 預設值 [] 讓外部呼叫時可以只寫 ReverseFast<[1, 2, 3]>，不必自己傳空陣列。
  Acc extends unknown[] = [],
> = T extends [infer H, ...infer R]
  // 把 H 塞到 Acc 的最前面（順序自然就反過來了），再把「剩下的 R」和「新的 Acc」交給下一層。
  // 關鍵：整條分支就只有這個遞迴呼叫，結果直接回傳，外面沒有再包 [...] 之類的運算 → 尾遞迴。
  ? ReverseFast<R, [H, ...Acc]>
  // 終止條件：T 空了代表全部搬完，此時 Acc 就是最終答案。
  : Acc;

type R = ReverseFast<[1, 2, 3, 4, 5]>; // [5, 4, 3, 2, 1]
```

**Acc 到底在幹嘛？** 把上面的展開過程列出來就很清楚了——`T` 逐步變短，`Acc` 逐步長出反轉後的結果：

```
ReverseFast<[1, 2, 3], []>
ReverseFast<[2, 3],    [1]>
ReverseFast<[3],       [2, 1]>
ReverseFast<[],        [3, 2, 1]>   // T 空了 → 回傳 Acc
```

對比沒有 Acc 的 `ReverseSlow`，它必須等最深層先回傳，才能在回程時一層層把 `H` 接上去：

```
ReverseSlow<[1, 2, 3]> = [...ReverseSlow<[2, 3]>, 1]
                       = [...[...ReverseSlow<[3]>, 2], 1]
                       = [...[...[...ReverseSlow<[]>, 3], 2], 1]
                       // 每一層都還「欠著」一個 [..., H] 沒做完，得原路展開回來
```

兩者的差別可以這樣記：

| | `ReverseSlow`（無 Acc） | `ReverseFast`（有 Acc） |
| --- | --- | --- |
| 中間結果放哪 | 卡在呼叫堆疊上，等回程才組合 | 直接存在 `Acc` 參數裡，往下傳 |
| 遞迴後還有運算嗎 | 有（`[...結果, H]`） | 沒有，直接回傳 |
| 深度上限 | 約 50 層 | 約 1000 層（編譯器可展開成迴圈） |

所以 `Acc` 的用意不是「多存一份資料」，而是**把原本要在回程做的工作提前做掉**，讓遞迴呼叫成為最後一步，換取編譯器的尾遞迴最佳化。這個模式在型別體操裡到處都是（後面的算術、字串處理也會反覆用到），看到多出一個帶預設值的參數，通常就是累加器。

---

## 13.4 元組型別運算（Tuple Manipulation）

元組是型別層級最重要的「資料結構」，很多運算（包含後面的算術）都建立在元組上。

```typescript
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
type P = Push<[1, 2], 3>;    // [1, 2, 3]
type U = Unshift<[2, 3], 1>; // [1, 2, 3]

// Concat：串接兩個元組
type Concat<A extends unknown[], B extends unknown[]> = [...A, ...B];
type C = Concat<[1, 2], [3, 4]>; // [1, 2, 3, 4]
```

> 💡 關鍵洞察：`T["length"]` 對**元組**會回傳字面值（如 `3`），對一般陣列 `number[]` 只會回傳 `number`。這個特性是下一節「型別層級算術」的基礎。

```
Tuple：「我知道自己有幾個元素」
        ↓
[string, number, boolean]["length"]
        ↓
3

Array：「我不知道自己有幾個元素」
        ↓
number[]["length"]
        ↓
number
```

---

## 13.5 型別層級的算術（Type-Level Arithmetic）

型別系統沒有內建加減乘除，但我們可以用「元組的長度」來代表數字：想表示數字 `N`，就建一個長度為 `N` 的元組；要做加法，就把兩個元組接起來、再讀長度。

```typescript
// 建立長度為 L 的元組（元素內容用 unknown 即可）
type BuildTuple<
  L extends number,
  T extends unknown[] = [],
> = T["length"] extends L ? T : BuildTuple<L, [...T, unknown]>;

type Three = BuildTuple<3>; // [unknown, unknown, unknown]

// 加法：兩個元組接起來讀長度
type Add<A extends number, B extends number> = [
  ...BuildTuple<A>,
  ...BuildTuple<B>,
]["length"];

type Sum = Add<3, 4>; // 7

// 減法：A 的元組能不能拆成「B 的元組 + 剩下 Rest」，Rest 的長度就是答案
type Subtract<A extends number, B extends number> = BuildTuple<A> extends [
  ...BuildTuple<B>,
  ...infer Rest,
]
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

/**
 * 這段代表意思是：扣除b數組以後至少還要一個元素，其他隨便
 extends [
  ...BuildTuple<B>,
  unknown,
  ...unknown[],
]
 */
```

> ⚠️ 因為 `BuildTuple` 會真的建出長度為 N 的元組，這套算術只適合**小數字**。數字一大，很容易撞到遞迴深度上限，也會拖慢編譯。真的需要大數運算時，型別層級不是合適的工具。

---

## 13.6 字串型別運算（String Manipulation）

搭配 [第七章 7.6](./07-advanced-types.md) 的模板字面值型別與 `infer`，可以在型別層級解析、拆解、重組字串。

```typescript
// Split：依分隔符切成元組
type Split<
  S extends string,
  D extends string,
> = S extends `${infer Head}${D}${infer Tail}`
  ? [Head, ...Split<Tail, D>]
  : [S];

type Parts = Split<"2026-07-23", "-">; // ["2026", "07", "23"]

// Join：把字串元組用分隔符接起來
type Join<
  T extends string[],
  D extends string,
> = T extends [infer F extends string, ...infer R extends string[]]
  ? R extends []
    ? F
    : `${F}${D}${Join<R, D>}`
  : "";

type Path = Join<["a", "b", "c"], "/">; // "a/b/c"

// Trim：去除頭尾空白(注意：每一次只移除一個空白，是用遞迴的方式去掉全部空白)
type TrimLeft<S extends string> = S extends ` ${infer R}` ? TrimLeft<R> : S;
type TrimRight<S extends string> = S extends `${infer R} ` ? TrimRight<R> : S;
type Trim<S extends string> = TrimLeft<TrimRight<S>>;

type Trimmed = Trim<"   hello   ">; // "hello"

// Replace：替換第一個符合的子字串
type Replace<
  S extends string,
  From extends string,
  To extends string,
> = From extends ""
  ? S
  : S extends `${infer Head}${From}${infer Tail}`
    ? `${Head}${To}${Tail}`
    : S;

type Replaced = Replace<"hello world", "world", "TypeScript">; // "hello TypeScript"

// 💡 TypeScript 內建 4 個「內建字串操作型別」（intrinsic string manipulation types），
//    不需要自己實作：Uppercase<S>、Lowercase<S>、Capitalize<S>、Uncapitalize<S>。
//    下面的 SnakeToCamel 就用到其中的 Capitalize。

// snake_case 轉 camelCase
type SnakeToCamel<S extends string> = S extends `${infer Head}_${infer Tail}`
  ? `${Head}${Capitalize<SnakeToCamel<Tail>>}`
  : S;

type Camel = SnakeToCamel<"user_first_name">; // "userFirstName"
```

---

## 13.7 分配式條件型別（Distributive Conditional Types）

這是型別層級最容易踩坑、也最重要的行為之一。當條件型別作用在**裸型別參數（naked type parameter）** 且該參數是**聯合型別**時，條件型別會**對聯合型別的每個成員分別套用**，再把結果組成新的聯合型別。

```typescript
type ToArray<T> = T extends any ? T[] : never;

// T 是聯合型別，會分配：ToArray<string> | ToArray<number>
type R = ToArray<string | number>; // string[] | number[]
```

如果想**關閉分配**、把整個聯合型別當成一個整體處理，只要把 `extends` 兩側用元組（或任意會破壞「裸」型別的寫法）包起來：

```typescript
type ToArrayNonDist<T> = [T] extends [any] ? T[] : never;

type R = ToArrayNonDist<string | number>; // (string | number)[]
```

### 常見應用

```typescript
// 判斷是否為聯合型別
type IsUnion<T, U = T> = T extends U
  ? [U] extends [T]
    ? false
    : true
  : never;

type A = IsUnion<string>;          // false
type B = IsUnion<string | number>; // true

// 聯合型別轉交集型別
type UnionToIntersection<U> = (
  U extends any ? (arg: U) => void : never
) extends (arg: infer I) => void
  ? I
  : never;

type C = UnionToIntersection<{ a: 1 } | { b: 2 }>; // { a: 1 } & { b: 2 }

// 過濾聯合型別（自己實作 Exclude）
type MyExclude<T, U> = T extends U ? never : T;
type D = MyExclude<"a" | "b" | "c", "b">; // "a" | "c"
```

---

## 13.8 實戰案例

前面的構件單獨看像「型別體操」，組合起來就能解決真實工程問題。

### 案例一：型別安全的物件路徑

```typescript
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
type Age = Get<AppState, "user.profile.age">;   // number
type Bad = Get<AppState, "user.profile.xxx">;   // never（打錯字直接變 never）
```

### 案例二：列出所有合法路徑（自動補全）

```typescript
// 產生物件所有「點路徑」字串的聯合型別
type Paths<T> = T extends object
  ? {
      [K in keyof T & string]: T[K] extends object
        ? `${K}` | `${K}.${Paths<T[K]>}`
        : `${K}`;
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
declare function get<T, P extends Paths<T>>(obj: T, path: P): unknown;
// 呼叫時 path 參數會有自動補全，打錯字會被擋下
```

### 案例三：從路由字串解析參數

```typescript
// 抓出路由中所有 ":param" 的名稱
type PathParams<Path extends string> =
  Path extends `${string}:${infer Param}/${infer Rest}`
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

// 型別安全的路由處理器
declare function route<Path extends string>(
  path: Path,
  handler: (params: RouteParams<Path>) => void,
): void;

route("/users/:userId/posts/:postId", (params) => {
  params.userId; // ✅ string
  params.postId; // ✅ string
  // params.foo; // ❌ 型別錯誤：foo 不存在
});
```

### 案例四：型別安全的事件系統

```typescript
// 定義事件名稱與對應的 payload 型別
interface EventMap {
  click: { x: number; y: number };
  submit: { formId: string };
  close: void;
}

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
```

---

## 13.9 效能與陷阱

型別層級程式設計是把雙面刃。用得好能大幅提升型別安全；用過頭則會拖慢編譯、讓錯誤訊息變得難以閱讀、讓同事看不懂。

### 常見問題

1. **遞迴太深**：出現 `Type instantiation is excessively deep and possibly infinite.`
   - 改寫成尾遞迴（累加器模式，見 13.3）。
   - 減少單次遞迴的資料量（例如別對超長字串逐字元遞迴）。

2. **編譯變慢 / 編輯器卡頓**：複雜型別會讓 `tsc` 與 IDE 型別檢查明顯變慢。
   - 用 `tsc --extendedDiagnostics` 觀察 `Instantiations` 數量與 `Check time`。
   - 對外公開的型別，考慮用 `interface` 或具名型別「凍結」中間結果，避免重複展開。

3. **錯誤訊息爆炸**：巢狀太深時，錯誤訊息會列出整段展開的型別，幾乎無法閱讀。
   - 適度加上約束（`extends`），讓錯誤在更淺的地方就被擋下。

### 除錯技巧

```typescript
// 自足：Split 定義見 13.6，這裡整段複製供技巧二使用
type Split<
  S extends string,
  D extends string,
> = S extends `${infer Head}${D}${infer Tail}` ? [Head, ...Split<Tail, D>] : [S];

// 自足：Get 定義見 13.8 案例一，這裡整段複製供技巧三使用
type Get<T, P extends string> = P extends `${infer Key}.${infer Rest}`
  ? Key extends keyof T
    ? Get<T[Key], Rest>
    : never
  : P extends keyof T
    ? T[P]
    : never;

// 技巧一：用一個「展開」型別強制 IDE hover 顯示最終結果
type Expand<T> = T extends infer O ? { [K in keyof O]: O[K] } : never;

// 技巧二：階段性驗證，把中間型別拆出來單獨 hover 檢查
type Step1 = Split<"a-b-c", "-">; // 滑鼠移上去看是不是 ["a","b","c"]

// 技巧三：善用 @ts-expect-error 標記「這裡本來就該報錯」
// 注意：本章的 Get 對錯誤路徑回傳 never（並不會報錯），@ts-expect-error 在這裡不會抓到任何東西，
// 反而會因為「沒有實際錯誤可抓」而讓 TypeScript 回報 TS2578（未使用的 @ts-expect-error 指令）：
type ShouldBeNever = Get<{ a: 1 }, "b">; // 滑鼠移上去看是不是 never（不是編譯錯誤）

// 若想讓錯誤路徑在編譯期真的被擋下（@ts-expect-error 才有東西可抓），
// 要把 P 收斂成 keyof T，而不是任意 string：
type StrictGet<T, P extends keyof T> = T[P];
// @ts-expect-error 'b' 不存在於 { a: 1 }，預期報錯
type ShouldFail = StrictGet<{ a: 1 }, "b">;
```

### 什麼時候該收手？

- 如果一個型別要花超過幾分鐘才能看懂，先問自己：能不能用更簡單的型別 + 少量執行期檢查達成？
- 函式庫作者為了使用者體驗，值得投資複雜型別；應用程式開發者則多半不需要。
- 「能不能做到」和「值不值得做」是兩回事。

---

## 13.10 測試你的型別

複雜型別也需要測試。本節先介紹社群標準的斷言寫法，再說明幾種**看得到輸出**的驗證方式（測試報告、傾印推論結果），最後整理該用哪一種。

### 方法一：`Expect` + `Equal` 型別斷言

這是 [type-challenges](https://github.com/type-challenges/type-challenges) 使用的標準寫法，不需要安裝任何東西。

為什麼 `Equal` 要寫成這種「雙重條件式函式」比較，而不是直接寫 `X extends Y ? Y extends X ? true : false : false`？因為 `any` 對 `extends` 來說是特例：**任何型別 `extends any` 都成立，`any extends 任何型別` 也都成立**，導致簡單版本在兩種情況下會出錯：

```typescript
type Expect<T extends true> = T;
type Simple<X, Y> = X extends Y ? (Y extends X ? true : false) : false;

// 缺陷 1：把「含 any 的不同型別」誤判為相等 —— 靜默假通過，最危險
type Wrong1 = Expect<Simple<{ a: any }, { a: string }>>; // ✅ 通過，但兩者根本不是同一型別

// 缺陷 2：遇到聯合型別會分佈，連「自己等於自己」都答不出 true
type Wrong2 = Simple<"a" | "b", "a" | "b">; // boolean（不是 true）
// type Check = Expect<Wrong2>;
// ❌ Type 'boolean' does not satisfy the constraint 'true'

// 缺陷 3：檢查對象是 any 時，條件型別會回傳兩個分支的聯合
type Wrong3 = Simple<any, string>; // boolean（不是 true 也不是 false）
```

把 `X`、`Y` 分別包進兩個函式型別的回傳位置再互相比較，能利用 TypeScript 對函式型別比較的實作細節，讓 `any` 和其他型別不再被視為互相相容，上面三種情況就都能正確判斷。

```typescript
// Equal：嚴格比較兩個型別是否完全相等
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y
  ? 1
  : 2
  ? true
  : false;

// Expect：只接受 true，若傳入 false 就會是型別錯誤
type Expect<T extends true> = T;

// 自足：把下面測試會用到的型別，從本章前面各節整段複製進來
type BuildTuple<
  L extends number,
  T extends unknown[] = [],
> = T["length"] extends L ? T : BuildTuple<L, [...T, unknown]>;

type Add<A extends number, B extends number> = [
  ...BuildTuple<A>,
  ...BuildTuple<B>,
]["length"];

type Reverse<T extends unknown[]> = T extends [infer Head, ...infer Tail]
  ? [...Reverse<Tail>, Head]
  : [];

type Split<
  S extends string,
  D extends string,
> = S extends `${infer Head}${D}${infer Tail}` ? [Head, ...Split<Tail, D>] : [S];

type SnakeToCamel<S extends string> = S extends `${infer Head}_${infer Tail}`
  ? `${Head}${Capitalize<SnakeToCamel<Tail>>}`
  : S;

type PathParams<Path extends string> =
  Path extends `${string}:${infer Param}/${infer Rest}`
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
```

把整段複製進同一個 `.ts` 檔即可完整驗證。

用 `tsc` 直接檢查（不產生任何 JS）：

```bash
npx tsc --noEmit --strict types.test.ts
```

**沒有輸出就是全部通過**——這是型別斷言的特性：正確時完全安靜，錯誤時才出現 `TS2344: Type 'false' does not satisfy the constraint 'true'`。

⚠️ 使用 `Equal` 時要知道一件事：它比的是「**是不是同一個型別**」，不是「結構長得一樣」。交集型別和攤平後的物件會被判為不相等：

```typescript
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y
  ? 1
  : 2
  ? true
  : false;
type Expect<T extends true> = T;

// type Check = Expect<Equal<{ a: 1 } & { b: 2 }, { a: 1; b: 2 }>>;
// ❌ false —— 結構相同，但一個是交集、一個是物件字面值，不是同一型別

// 想比結構，先用 13.9 的 Expand 攤平
type Expand<T> = T extends infer O ? { [K in keyof O]: O[K] } : never;
type Ok = Expect<Equal<Expand<{ a: 1 } & { b: 2 }>, { a: 1; b: 2 }>>; // ✅ true
```

### 方法二：`@ts-expect-error` 斷言「這裡必須報錯」

方法一驗證「算出來的型別對不對」，但另一半同樣重要：**該被擋下來的有沒有真的被擋下來**。

```typescript
type Role = "admin" | "user";

// @ts-expect-error 這行必須報錯，否則 directive 自己會報錯
const bad: Role = "guest";

// @ts-expect-error 這行其實合法 → 反而被抓出來
const good: Role = "admin";
// ❌ TS2578: Unused '@ts-expect-error' directive.
```

關鍵在於它是**雙向**的：預期的錯誤消失時，它會主動告訴你。這是它比 `@ts-ignore` 好的地方——`@ts-ignore` 在錯誤消失後只會靜默失效，變成沒人發現的死程式碼。

> 📌 用在型別層級時有個陷阱：像 13.8 的 `Get` 對錯誤路徑是回傳 `never` 而不是報錯，`@ts-expect-error` 就抓不到東西。詳見 13.9 除錯技巧的技巧三。

### 方法三：用 `vitest --typecheck` 取得測試報告

前兩種方法都是「安靜就是通過」，看不到跑了幾項、哪一項失敗。想要真正的測試報告（綠燈紅燈、失敗清單），可以用 Vitest 的型別檢查模式搭配 `expectTypeOf`。

安裝：

```bash
npm i -D vitest typescript @types/node
```

`vitest.config.ts`：

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    typecheck: { enabled: true },
  },
});
```

`package.json`：

```json
{
  "scripts": {
    "test:types": "vitest run --typecheck"
  }
}
```

型別測試檔要用 `*.test-d.ts` 命名（Vitest 預設只把這個樣式當成型別測試）：

```typescript
// types.test-d.ts
import { expectTypeOf, describe, it } from "vitest";

type Getters<T> = {
  [K in keyof T as `get${Capitalize<string & K>}`]: () => T[K];
};

interface User {
  id: number;
  name: string;
}

const ROLES = ["admin", "editor", "user"] as const;
type Role = (typeof ROLES)[number];

describe("工具型別", () => {
  it("Getters 產生 getXxx 方法", () => {
    expectTypeOf<Getters<User>>().toEqualTypeOf<{
      getId: () => number;
      getName: () => string;
    }>();
  });

  it("(typeof ROLES)[number] 攤成聯合型別", () => {
    expectTypeOf<Role>().toEqualTypeOf<"admin" | "editor" | "user">();
  });
});
```

執行 `npm run test:types`：

```text
 Test Files  1 passed (1)
      Tests  2 passed (2)
Type Errors  no errors
```

把其中一個斷言改錯，輸出會明確指出是哪一個測試、錯在哪：

```text
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  types.test-d.ts > 故意寫錯
TypeCheckError: Type '"admin" | "guest"' does not satisfy the constraint
  '"Expected literal string admin, Actual literal string editor" | ...'

      Tests  1 failed | 2 passed (3)
Type Errors  1 failed
```

比手寫 `Expect<Equal<...>>` 的優勢：**錯誤訊息直接寫 Expected / Actual**，不用自己推敲哪裡不一樣。`expectTypeOf` 還有 `toBeString()`、`toMatchTypeOf()`、`parameter(0)`、`returns` 等斷言，也能直接對值使用：

```typescript
declare function pick<T, K extends keyof T>(obj: T, key: K): T[K];

expectTypeOf(pick({ name: "Gary", age: 30 }, "name")).toBeString();
```

> 💡 不想引入 Vitest 的話，`expect-type` 是同一套 API 的獨立套件（Vitest 的 `expectTypeOf` 就是它），只裝它再用 `tsc --noEmit` 跑也可以。

### 方法四：把推論結果傾印成 `.d.ts`

想一次看清「編譯器到底推論出什麼」，可以請它把答案寫成檔案：

```bash
npx tsc --emitDeclarationOnly --declaration --strict --outDir dts types.ts
```

原始檔完全不寫型別標註，全交給推論：

```typescript
// types.ts
export const ACTIONS = ["save", "delete", "publish"] as const;
export type Action = (typeof ACTIONS)[number];

export function pick<T, K extends keyof T>(obj: T, key: K) {
  return obj[key];
}

export const picked = pick({ name: "Gary", age: 30 }, "name");
```

產出的 `dts/types.d.ts`：

```typescript
export declare const ACTIONS: readonly ["save", "delete", "publish"];
export type Action = (typeof ACTIONS)[number];
export declare function pick<T, K extends keyof T>(obj: T, key: K): T[K];
export declare const picked: string;
```

這是唯一能「一覽整份檔案推論結果」的方式，很適合檢查對外 API 的型別是否如預期（也是函式庫發佈前該做的檢查）。

### 方法五：逼編譯器把型別印在錯誤訊息裡

臨時想知道某個型別算出什麼，又不想開 IDE hover 時：故意指派給一個不可能的型別，答案就出現在錯誤訊息中。

```typescript
interface User {
  id: number;
  name: string;
}
type Getters<T> = {
  [K in keyof T as `get${Capitalize<string & K>}`]: () => T[K];
};

declare const probe: Getters<User>;
const reveal: 1 = probe;
// ❌ TS2322: Type 'Getters<User>' is not assignable to type '1'.
//    ⚠️ 只印出別名，沒展開
```

只印別名時，套一層 13.9 的 `Expand` 強迫攤平：

```typescript
type Expand<T> = T extends infer O ? { [K in keyof O]: O[K] } : never;

declare const probe2: Expand<Getters<User>>;
const reveal2: 1 = probe2;
// ❌ TS2322: Type '{ getId: () => number; getName: () => string; }'
//            is not assignable to type '1'.   ← 攤開了
```

### 該用哪一個？

| 方法 | 有輸出嗎 | 適合場合 |
| --- | --- | --- |
| `Expect` + `Equal` | ❌ 安靜通過 | 零依賴，隨手驗一個型別；type-challenges 解題 |
| `@ts-expect-error` | ❌ 安靜通過 | 驗證「該報錯的有報錯」 |
| `vitest --typecheck` | ✅ 測試報告 | 專案長期維護、接 CI；工具型別較多時首選 |
| `--emitDeclarationOnly` | ✅ `.d.ts` 檔 | 檢視整份檔案的推論結果、發佈函式庫前檢查 |
| 逼編譯器印出型別 | ✅ 錯誤訊息 | 開發途中臨時查看某個型別 |

**實務建議**：日常開發靠 IDE hover 加上 `tsc --noEmit`；只要你寫的型別會被別人（或未來的自己）依賴，就補一份型別測試檔進 CI：

```json
{
  "scripts": {
    "type-check": "tsc --noEmit",
    "test:types": "vitest run --typecheck"
  }
}
```

型別出錯不會讓測試變紅、也不會讓程式壞掉——它只會讓自動完成默默失效、讓錯誤在幾個月後才浮現。**這正是型別需要測試的理由。**

---

## 練習題

### 練習 1：型別層級的 Filter

實作一個 `Filter<T, U>`，從元組 `T` 中保留所有可賦值給 `U` 的元素：

```typescript
type Filter<T extends unknown[], U> = ???;

type A = Filter<[1, "a", 2, "b", 3], number>; // [1, 2, 3]
type B = Filter<[true, 0, "x", false], boolean>; // [true, false]
```

<details>
<summary>參考解答</summary>

思路：用 `[infer H, ...infer R]` 拆出頭元素與剩餘，逐一走訪；`H extends U` 成立就把 `H` 留在結果最前面、否則跳過，再對 `R` 遞迴，空元組時結束。

```typescript
// 逐一走訪元組：符合條件的元素才收進結果，不符合就跳過
type Filter<T extends unknown[], U> = T extends [infer H, ...infer R]
  ? H extends U
    ? [H, ...Filter<R, U>]
    : Filter<R, U>
  : [];

type A = Filter<[1, "a", 2, "b", 3], number>; // [1, 2, 3]
type B = Filter<[true, 0, "x", false], boolean>; // [true, false]

// ---- 型別測試（Equal / Expect 為 type-challenges 標準寫法）----
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

type _cases = [
  Expect<Equal<A, [1, 2, 3]>>,
  Expect<Equal<B, [true, false]>>,
];
```

重點提醒：這裡的過濾條件是「可賦值給 `U`」（子型別判斷），所以 `0 extends boolean` 為 `false`、`"x" extends boolean` 也為 `false`，才會被濾掉。

</details>

### 練習 2：字串轉聯合型別

實作一個 `CharUnion<S>`，把字串拆成每個字元的聯合型別：

```typescript
type CharUnion<S extends string> = ???;

type A = CharUnion<"abc">; // "a" | "b" | "c"
```

<details>
<summary>參考解答</summary>

思路：模板字面值 `${infer Head}${infer Rest}` 會把字串拆成「第一個字元」與「剩餘字串」，用 `Head | CharUnion<Rest>` 逐字遞迴收集；字串被拆到空字串時不再符合模板，回傳 `never`（聯合型別中的 `never` 會自動被吸收）。

```typescript
// 逐字元遞迴，把每個字元收集成聯合型別
type CharUnion<S extends string> = S extends `${infer Head}${infer Rest}`
  ? Head | CharUnion<Rest>
  : never;

type A = CharUnion<"abc">; // "a" | "b" | "c"

// ---- 型別測試 ----
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

type _cases = [Expect<Equal<A, "a" | "b" | "c">>];
```

重點提醒：模板字面值裡連續兩個 `infer` 時，第一個只會抓「單一字元」，這正是逐字拆解字串的關鍵；終止分支回傳 `never` 而非 `""`，才不會讓空字串混進結果。

</details>

### 練習 3：實作 DeepReadonly（含陣列與函式）

強化 [第七章 7.8](./07-advanced-types.md) 的 `DeepReadonly`，讓它能正確處理巢狀陣列，並且**不要**把函式的屬性也變成 readonly：

```typescript
type DeepReadonly<T> = ???;

interface State {
  user: { name: string; roles: string[] };
  update: () => void;
}
type Frozen = DeepReadonly<State>;
// user、user.name、user.roles 都是 readonly，但 update 仍是可呼叫的函式
```

<details>
<summary>參考解答</summary>

思路：條件順序是關鍵。先攔截函式型別（用 `(...args: any[]) => any` 比對），原封不動回傳以保持可呼叫；接著才處理其他 `object`（陣列也是 object），用映射型別加上 `readonly` 並對每個屬性遞迴；最後基本型別直接回傳。因為陣列也走 `object` 分支，`string[]` 會遞迴成 `readonly string[]`。

```typescript
// 順序很關鍵：先排除函式，物件/陣列才遞迴加 readonly
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

// ---- 型別測試 ----
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

type _cases = [
  Expect<
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
  >,
];
```

重點提醒：函式在 TypeScript 裡也是 `object`，若不先攔截，映射型別會把它的呼叫簽章「攤平」成一個只有 readonly 屬性、卻不能再呼叫的型別，因此判斷順序一定要把函式放在物件前面。

</details>

### 練習 4：型別層級的 SQL SELECT

給定一個資料表型別與欄位名稱聯合型別，回傳只包含這些欄位的型別（自己實作，不要用內建 `Pick`）：

```typescript
type Select<T, K extends keyof T> = ???;

interface User { id: number; name: string; email: string; password: string }
type PublicUser = Select<User, "id" | "name" | "email">;
// { id: number; name: string; email: string }
```

<details>
<summary>參考解答</summary>

思路：`K extends keyof T` 保證欄位名稱都合法，接著用映射型別 `{ [P in K]: T[P] }` 走訪指定的欄位聯合，逐一從 `T` 取出對應型別——這其實就是內建 `Pick` 的核心實作。

```typescript
// 用映射型別挑出指定欄位（等同自己實作 Pick，不使用內建）
type Select<T, K extends keyof T> = { [P in K]: T[P] };

interface User {
  id: number;
  name: string;
  email: string;
  password: string;
}
type PublicUser = Select<User, "id" | "name" | "email">;
// { id: number; name: string; email: string }

// ---- 型別測試 ----
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

type _cases = [
  Expect<Equal<PublicUser, { id: number; name: string; email: string }>>,
];
```

重點提醒：把 `K` 約束成 `keyof T`，就能在編譯期擋掉不存在的欄位名稱（例如 `Select<User, "age">` 會直接紅線），這正是型別安全「投影」的價值所在。

</details>

---

> 下一章：[第十四章 — TypeScript Compiler API](./14-compiler-api.md)
