# 第十四章：型別體操（Type Gymnastics）

> 本章是 [第十三章 型別層級程式設計](./13-type-level-programming.md) 的**解題手冊**，不是第三遍語法課。條件型別、`infer`、映射型別、模板字面值的完整教學在 [第七章](./07-advanced-types.md) 與第十三章；這裡只整理「看到什麼題、選哪套手法」。
>
> 題目風格對齊 [type-challenges](https://github.com/type-challenges/type-challenges)。建議先熟悉 [第六章 泛型](./06-generics.md)、第七章與第十三章。

---

## 14.1 先選資料結構，再動手

[type-challenges](https://github.com/type-challenges/type-challenges) 看起來有近 190 題，反覆出現的手法大約十來個。多數 medium / hard 只是把同一套手法換資料結構再組一次。解題時先問：**這題操作的是哪一種資料？**

| 題目長這樣 | 用這套 | 代表題 |
|------------|--------|--------|
| 從 Union 拿掉／留下某些成員 | 裸參數 + 分佈 + `never` | #43 Exclude |
| 把物件每個 key 改一遍、刪掉某些 key | `[K in keyof T]`，刪 key 用 `as never` | #4 Pick、#3 Omit |
| 從 Tuple 中間拿掉元素、改順序、搜尋 | `infer` + 遞迴，不要用 `in keyof` | #18220 Filter、#533 Concat |
| 拆字串／路由／大小寫 | `` `${infer A}${Sep}${infer B}` `` | #108 Trim、#116 Replace |
| 要比「是不是同一個型別」 | `Equal`，不要雙向 `extends` | #898 Includes、#19749 IsEqual |
| 判斷 `never` / `any` / 是不是 Union | 先關分佈，再比 | #1042 IsNever、#223 IsAny、#1097 IsUnion |

後面各節都是這張表的展開。語法細節需要複習時，跟著連結回第 7、13 章即可。

---

## 14.2 條件型別：`extends` 是相容，不是相等

最基礎的核心：

```typescript
T extends U ? A : B
```

意思是：如果 `T` **可以當成** `U` 使用（是 `U` 的子型別），得到 `A`，否則得到 `B`。

```typescript
type If<C extends boolean, T, F> = C extends true ? T : F;

type A = If<true, "a", "b">;  // "a"
type B = If<false, "a", "b">; // "b"
```

這對應 type-challenges 的 [#268 If](https://github.com/type-challenges/type-challenges/blob/main/questions/00268-easy-if/README.md)。幾乎所有型別體操都從這條分支開始。

物件比的是**結構相容**，不是兩個型別長得一模一樣：

```typescript
type A = { name: string; age: number };
type B = { name: string };

type Result = A extends B ? true : false; // true，因為 A 至少具備 B 要求的 name
```

所以 `extends` 不是「完全相等」，而是「型別相容 / 包含關係」。要嚴格相等，用 14.8 的 `Equal`。

> 完整語法見 [7.4 條件型別](./07-advanced-types.md)。

---

## 14.3 分佈、`never`、以及什麼時候該關掉

### 裸參數會自動拆開 Union

當 `T` 是**裸型別參數**（bare / naked type parameter：單獨一個 `T`，沒被陣列、元組、函式包住），且傳入的是 Union，條件型別會對每個成員各跑一次，再把結果組成新的 Union。這就是 `Exclude` 能運作的原因：

```typescript
type MyExclude<T, U> = T extends U ? never : T;

type Result = MyExclude<"a" | "b" | "c", "a">; // "b" | "c"
```

對應 [#43 Exclude](https://github.com/type-challenges/type-challenges/blob/main/questions/00043-easy-exclude/README.md)。展開是：

```text
"a" extends "a" ? never : "a"   → never
| "b" extends "a" ? never : "b" → "b"
| "c" extends "a" ? never : "c" → "c"
```

最後 `never | "b" | "c"` 會簡化成 `"b" | "c"`。

### `never` 用來「刪掉」Union 成員

`never` 是空的聯合型別。寫進 Union 會被吸收：

```typescript
type T = "a" | never | "b"; // "a" | "b"
```

因此型別體操的慣用句是：

```typescript
T extends U ? never : T   // 符合的刪掉（Exclude）
T extends U ? T : never    // 符合的留下（Extract）
```

### 關掉分佈：`[T] extends [U]`

把 `T` 包進元組，它就不再裸露，整包聯合型別會被當成一個整體：

```typescript
type Dist<T> = T extends string ? 1 : 2;
type A = Dist<string | number>; // 1 | 2

type NonDist<T> = [T] extends [string] ? 1 : 2;
type B = NonDist<string | number>; // 2，比的是 [string | number] extends [string]
```

關掉之後，`Exclude` 會整個壞掉——這恰好能用來檢查自己有沒有誤關分佈：

```typescript
type BadExclude<T, U> = [T] extends [U] ? never : T;
type Oops = BadExclude<"a" | "b" | "c", "a">;
// "a" | "b" | "c"，整包不能賦值給 "a"，一個都沒排掉
```

> 分佈的觸發條件、`T extends any` 這種「故意觸發分佈」的寫法，以及 `boolean` 其實是 `true | false` 也會被拆開，見 [7.4 分佈式條件型別](./07-advanced-types.md)。

### `IsNever` 一定要關分佈

`never` 分佈時等於「沒有成員可跑」，結果直接是 `never`，連 `true` / `false` 都拿不到：

```typescript
type IsNeverWrong<T> = T extends never ? true : false;
type W = IsNeverWrong<never>; // never ❌

type IsNever<T> = [T] extends [never] ? true : false;
type R = IsNever<never>; // true ✅
type S = IsNever<undefined>; // false
```

裸的 `T extends ...` 會對 union 每個成員各跑一次，再把結果組成新的 union。`never` 是空的 union，等於對空陣列做 `map`：條件一次都沒執行，所以拿不到 `true` / `false`，只剩空結果 `never`。

```javascript
["a", "b"].map((x) => (x === "never" ? true : false));
// [false, false]  → 對應 Dist<"a" | "b"> = false | false

[].map((x) => (x === "never" ? true : false));
// []              → 對應 Dist<never> = never（空結果，不是 true 也不是 false）
```

寫成 `[T] extends [never]` 等於先把輸入包進一個長度固定的陣列再比，不再對成員逐一 `map`，所以 `[never]` 對 `[never]` 會真正走進 `true` 分支。

這就是 [#1042 IsNever](https://github.com/type-challenges/type-challenges/blob/main/questions/01042-medium-isnever/README.md) 的核心。`[T] extends [U]` 最常見的實戰用途就是這個，不是單純的冷知識。

---

## 14.4 `infer`：從型別裡拆東西

`infer` 只能出現在條件型別 `extends` 的**右側**，作用是挖空一格，讓 TypeScript 把對齊到的型別填進去。同一顆子彈打四種目標：

| 資料 | 樣板 | 代表題 |
|------|------|--------|
| Tuple | `T extends [infer F, ...infer R]` | #14 First、#15 Last |
| 函式 | `T extends (...args: infer P) => infer R` | #3312 Parameters、#2 ReturnType |
| Promise | `T extends Promise<infer V>` | #189 Awaited |
| 字串 | `` S extends `${infer A}${Sep}${infer B}` `` | #106 Trim Left、#116 Replace |

```typescript
type First<T extends unknown[]> = T extends [infer F, ...unknown[]] ? F : never;
type ParametersOf<T> = T extends (...args: infer P) => unknown ? P : never;
type Unwrap<T> = T extends Promise<infer V> ? Unwrap<V> : T;
type TrimLeft<S extends string> = S extends ` ${infer R}` ? TrimLeft<R> : S;
```

可以把它類比成 JavaScript 的解構，只是發生在型別層：

```javascript
const [first, ...rest] = array;
```

TS 4.7+ 還能在推論時加約束，對不上就走 false 分支：

```typescript
type FirstIfString<T> = T extends [infer H extends string, ...unknown[]] ? H : never;

type S1 = FirstIfString<["hello", 1]>; // "hello"
type S2 = FirstIfString<[1, 2, 3]>;    // never
```

> `infer` 的對齊規則、同一個名稱出現兩次時協變取聯集／逆變取交集、以及 `(infer E)[]` 吃不下 `readonly` 陣列，見 [7.4 infer](./07-advanced-types.md)。

---

## 14.5 Tuple：遞迴拆接，不要用 `in keyof`

Tuple 沒有 `for` 迴圈。標準起手式是：拆第一個 → 決定留不留 → 對剩下的遞迴 → 空元組結束。

### Filter：經典遞迴

對應 [#18220 Filter](https://github.com/type-challenges/type-challenges/blob/main/questions/18220-medium-filter/README.md)，也是 [第十三章練習 1](./13-type-level-programming.md)：

```typescript
type Filter<T extends unknown[], U> =
  T extends [infer First, ...infer Rest]
    ? First extends U
      ? [First, ...Filter<Rest, U>]
      : Filter<Rest, U>
    : [];

type Result = Filter<[1, "a", 2, "b", 3], number>; // [1, 2, 3]
```

流程：

```text
取 First
   ↓
First extends U？
   ↓
 ┌───────┴───────┐
 ↓               ↓
是               否
 ↓               ↓
保留 First       丟掉 First
 └───────┬───────┘
         ↓
    繼續處理 Rest
```

### 陷阱：`First` 自己也是 Union 時會再分佈一次

`First extends U` 裡的 `First` 如果是聯合型別，會再走一遍 14.3 的分佈：

```typescript
type Naive = Filter<[string | number, boolean], string>;
// First = string | number 被拆開：
//   string  → 留下 → [string, ...Filter<[boolean], string>]
//   number  → 丟掉 → Filter<[boolean], string>
// 結果是 [string] | []，不是「這一格整格留下或整格丟掉」
```

若題目要把「這一格」當整體處理，把 14.3 的關分佈用在 `First` 上：

```typescript
type FilterSlot<T extends unknown[], U> =
  T extends [infer First, ...infer Rest]
    ? [First] extends [U]
      ? [First, ...FilterSlot<Rest, U>]
      : FilterSlot<Rest, U>
    : [];
```

解 Tuple 題時養成習慣：先問「這裡要不要分佈？」再決定寫 `First extends U` 還是 `[First] extends [U]`。

### 為什麼 Filter 不適合 `in keyof`

`[K in keyof T]` 很擅長**改某個位置的型別**，但不容易把 Tuple 中間的元素真正移除。映射後常常變成：

```typescript
[1, never, 2, never, 3] // 長度還在，破洞還在
```

而 Filter 要的是 `[1, 2, 3]`。物件可以用下一節的 `as never` 刪 key；Tuple 的「刪中間」只能靠 `infer` + 遞迴。

### Concat、`readonly` 與 `as const`

對應 [#533 Concat](https://github.com/type-challenges/type-challenges/blob/main/questions/00533-easy-concat/README.md)：

```typescript
type Concat<
  T extends readonly unknown[],
  U extends readonly unknown[],
> = [...T, ...U];

type Result = Concat<[1, 2], [3, 4]>; // [1, 2, 3, 4]
```

`...T` 是 Tuple Spread：把 `T = [1, 2]` 攤成 `1, 2`，所以 `[...T, ...U]` 就是 `[1, 2, 3, 4]`。

約束要寫 `readonly unknown[]`，不要只寫 `unknown[]`（或 `any[]`）：

```text
T extends unknown[]
↓
只接受可變 Array / Tuple

T extends readonly unknown[]
↓
接受 mutable + readonly Array / Tuple
```

原因：`readonly` 陣列不能賦值給可變陣列。而 `as const` 推出來的正是 readonly 元組：

```typescript
const xs = [1, 2] as const; // 型別是 readonly [1, 2]

type C = Concat<typeof xs, [3]>; // [1, 2, 3]
// 若 Concat 的約束是 unknown[]，typeof xs 會對不上
```

教學與新程式用 `readonly unknown[]`。type-challenges 舊題常寫 `readonly any[]`，行為一樣，只是比較鬆。

只讀、不修改內容時，`readonly unknown[]` 幾乎總是更有彈性。`[...T, V]`、`[V, ...T]` 就是 Push / Unshift（#3057、#3060）。

### 兩個索引小工具

```typescript
type TupleToUnion<T extends readonly unknown[]> = T[number];
type Length<T extends readonly unknown[]> = T["length"];

type U = TupleToUnion<[1, 2, 3]>; // 1 | 2 | 3
type L = Length<[1, 2, 3]>;       // 3（元組的 length 是字面值）
```

`T[number]` 對應 [#10 Tuple to Union](https://github.com/type-challenges/type-challenges/blob/main/questions/00010-medium-tuple-to-union/README.md)。`T["length"]` 對一般陣列是 `number`，對元組才是字面值——[13.5 型別層算術](./13-type-level-programming.md) 全建立在這件事上。

---

## 14.6 物件：`in keyof`、`as never`、修飾符

`in keyof` 的核心是：把 `T` 的每個 key 走一遍，重新建立型別。這跟 `infer` 解構 Tuple 是兩條路。

### Pick：只留指定的 key

對應 [#4 Pick](https://github.com/type-challenges/type-challenges/blob/main/questions/00004-easy-pick/README.md)：

```typescript
type MyPick<T, K extends keyof T> = {
  [P in K]: T[P];
};

interface Todo {
  title: string;
  description: string;
  completed: boolean;
}

type Preview = MyPick<Todo, "title" | "completed">;
// { title: string; completed: boolean }
```

`K extends keyof T` 讓不存在的欄位名稱在編譯期就被擋下來。

### 刪 key 要用 `as never`，不是把值設成 `never`

對應 [#3 Omit](https://github.com/type-challenges/type-challenges/blob/main/questions/00003-medium-omit/README.md)：

```typescript
// K：要刪掉的鍵名（可以是一個，也可以是 "a" | "b" 這種聯合）
// PropertyKey = string | number | symbol，也就是物件鍵允許的型別
type MyOmit<T, K extends PropertyKey> = {
  // P in keyof T：把 T 的每個 key 走一遍
  // as ...：走訪時順便「改鍵名」——改成 never 就等於刪掉這個 key
  [P in keyof T as P extends K ? never : P]: T[P];
  //                  ↑ 這個 P 在要刪的名單裡？
  //                    是 → never（結果裡沒有這個 key）
  //                    否 → 鍵名維持 P，值仍是 T[P]
};

type WithoutDesc = MyOmit<Todo, "description">;
// { title: string; completed: boolean }
```

用 `Todo` 逐步拆一次：

```text
T = { title: string; description: string; completed: boolean }
K = "description"
keyof T = "title" | "description" | "completed"

P = "title"       → "title" extends "description"？否 → 留下 title: string
P = "description" → "description" extends "description"？是 → never（刪掉）
P = "completed"   → "completed" extends "description"？否 → 留下 completed: boolean

結果：{ title: string; completed: boolean }
```

注意 `as never` 刪的是**鍵**，不是把值改成 `never`。如果寫成 `[P in keyof T]: P extends K ? never : T[P]`，`description` 還在，只是型別變成 `never`。

對照 14.5：

| | 物件 | Tuple |
|--|------|-------|
| 改每個位置的型別 | `[K in keyof T]` | 映射後索引還在 |
| 真正拿掉中間元素 | `as never` 會刪掉這個 key | 映射成 `never` 只會留下破洞 |
| 依**值的型別**過濾 | `as T[K] extends U ? K : never` | 只能 `infer` + 遞迴 |

「依值挑欄位」（#2595 PickByType、#2852 OmitByType）只有 key remapping 做得到，`Pick` / `Omit` 只能依鍵名操作。細節見 [7.5 鍵值重新映射](./07-advanced-types.md)。

### 修飾符是獨立維度

映射時可以加上或拿掉 `readonly` 與 `?`：

```typescript
type MyReadonly<T> = { readonly [K in keyof T]: T[K] };
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type MyRequired<T> = { [K in keyof T]-?: T[K] };
```

Hard 的 [#57 Get Required](https://github.com/type-challenges/type-challenges/blob/main/questions/00057-hard-get-required/README.md)、[#59 Get Optional](https://github.com/type-challenges/type-challenges/blob/main/questions/00059-hard-get-optional/README.md) 不是新語法，而是在問：某個 key 能不能缺席。常用判斷是 `{} extends Pick<T, K>`——成立代表 `K` 可選。

巢狀物件往下走就是遞迴映射（#9 Deep Readonly），練習見 [第十三章練習 3](./13-type-level-programming.md)。

---

## 14.7 字串：模板字面值就是字串版 `infer`

字串題和 Tuple 題是同一件事，只是資料從 `[]` 換成 `` `${}` ``。

```typescript
type TrimLeft<S extends string> = S extends ` ${infer R}` ? TrimLeft<R> : S;
type TrimRight<S extends string> = S extends `${infer R} ` ? TrimRight<R> : S;
type Trim<S extends string> = TrimLeft<TrimRight<S>>;

type T1 = Trim<"  hello  ">; // "hello"
type T2 = TrimLeft<"  hello  ">; // "hello  "（只去左邊）
type T3 = TrimRight<"  hello  ">; // "  hello"（只去右邊）
type T4 = Trim<"hello">; // "hello"

type Replace<
  S extends string,
  From extends string,
  To extends string,
> = From extends ""
  ? S
  : S extends `${infer Head}${From}${infer Tail}`
    ? `${Head}${To}${Tail}`
    : S;

type R1 = Replace<"foobar", "bar", "foo">; // "foofoo"
type R2 = Replace<"foobarbar", "bar", "foo">; // "foofoobar"（只換第一處）
type R3 = Replace<"foobar", "", "foo">; // "foobar"（From 是空字串，原樣回傳）
type R4 = Replace<"hello", "x", "y">; // "hello"（對不上就回傳 S）

type ReplaceAll<
  S extends string,
  From extends string,
  To extends string,
> = From extends ""
  ? S
  : S extends `${infer Head}${From}${infer Tail}`
    ? `${Head}${To}${ReplaceAll<Tail, From, To>}`
    : S;

type RA1 = ReplaceAll<"foobarbar", "bar", "foo">; // "foofoofoo"（每一處都換）
type RA2 = ReplaceAll<"t y p e s", " ", "">; // "types"
```

對應 #106 Trim Left、#108 Trim、#116 Replace、#119 ReplaceAll。和 `Replace` 的差別只在 true 分支對 `Tail` 繼續遞迴；不要對整段 `` `${Head}${To}${Tail}` `` 再跑，否則 `To` 裡若含 `From` 會無限展開。

`StartsWith` / `EndsWith` 更短：

```typescript
type StartsWith<S extends string, P extends string> =
  S extends `${P}${string}` ? true : false;

type S1 = StartsWith<"abc", "ab">; // true
type S2 = StartsWith<"abc", "b">; // false
type S3 = StartsWith<"abc", "">; // true（空前綴對任何字串都成立）
```

路由參數、snake_case 轉換在 [13.6](./13-type-level-programming.md) 與 [13.8 案例三](./13-type-level-programming.md)。內建的 `Uppercase` / `Lowercase` / `Capitalize` / `Uncapitalize` 不必自己做。

---

## 14.8 判斷器：`IsNever`、`IsAny`、`IsUnion`、`Equal`

`any`、`unknown`、`never` 會讓普通 `extends` 說謊。型別體操裡「判斷這是什麼」幾乎都要先關分佈，或改用更嚴的比較。

可以先這樣記：

| 型別 | 直覺 | 對 `extends` 的麻煩 |
|------|------|----------------------|
| `any` | 限制非常寬鬆 | 跟誰比幾乎都成立 |
| `unknown` | 我不知道是什麼 | 只有 `unknown` / `any` 接得住它 |
| `never` | 不存在任何值 | 裸參數分佈時變成「跑 0 次」 |
| `boolean` | 其實是 `true \| false` | 會被拆成兩個分支 |

```typescript
T & unknown // T
T & never   // never
T & any     // any（有特殊規則）

T | unknown // unknown
T | never   // T
T | any     // any（有特殊規則）
```

### `IsAny`

`any` 跟任何型別做 `&` 都還是 `any`，於是：

```typescript
type IsAny<T> = 0 extends (1 & T) ? true : false;

type A = IsAny<any>;     // true，因為 1 & any = any，0 extends any 成立
type B = IsAny<unknown>;  // false，1 & unknown = 1，0 extends 1 不成立
type C = IsAny<never>;   // false，1 & never = never，0 extends never 不成立
```

對應 [#223 IsAny](https://github.com/type-challenges/type-challenges/blob/main/questions/00223-hard-isany/README.md)。

### `IsUnion`

對應 [#1097 IsUnion](https://github.com/type-challenges/type-challenges/blob/main/questions/01097-medium-isunion/README.md)。先讓 `T` 分佈，再看「拆開後的單一成員」能不能涵蓋原本的整包 `U`：

```typescript
// U = T：先把「完整輸入」存起來。後面 T extends U 會把 T 拆開，U 仍是整包
type IsUnion<T, U = T> = [T] extends [never]
  ? false // never 不是 Union。一定要關分佈，否則下一行會得到 never 而不是 false
  : T extends U // 觸發分佈：T 變成「其中一個成員」，U 仍是原本的整包
    ? [U] extends [T]
      ? false // 整包 U 塞得進單一成員 T → 本來就只有一個成員 → 不是 Union
      : true // 整包塞不進單一成員 → 還有別的成員 → 是 Union
    : never;

type A = IsUnion<string>; // false
type B = IsUnion<string | number>; // true
type C = IsUnion<[string | number]>; // false，元組裡裝 Union 仍是單一型別
type D = IsUnion<never>; // false（沒有第一行的話會是 never）
```

`[T] extends [never]` **就是在攔 `never`**，不是多餘的防呆。`never` 是空的 union，裸的 `T extends U` 會像 14.3 那樣「對 0 個成員跑 map」，結果是 `never`，連 `true` / `false` 都拿不到。包進 `[T]` 才能真的問「這是不是 never」，並規定答案為 `false`。

其餘情況逐步拆：

```text
IsUnion<string>
  T = string, U = string
  [string] extends [never]？否
  string extends string → [string] extends [string]？是 → false

IsUnion<string | number>
  T 分佈成 string 與 number，U 仍是 string | number
  [string | number] extends [string]？否 → true
  [string | number] extends [number]？否 → true
  true | true → true
```

完整說明見 [13.7](./13-type-level-programming.md)。

### 為什麼 `Equal` 不用雙向 `extends`

對應 [#19749 IsEqual](https://github.com/type-challenges/type-challenges/blob/main/questions/19749-medium-isequal/README.md)，也是 [13.10](./13-type-level-programming.md) 測試型別的標準寫法：

```typescript
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends
  (<T>() => T extends Y ? 1 : 2)
    ? true
    : false;
```

`<T>() => T extends X ? 1 : 2` 不是「拿一個 `T` 來比」，而是做一個對**任意** `T` 判斷 `T extends X` 的型別判斷器。兩個判斷器行為一致，才叫相等。

雙向 `extends` 過不了這三關：

```typescript
type Simple<X, Y> = X extends Y ? (Y extends X ? true : false) : false;
type Expect<T extends true> = T;

// 1. any 讓「根本不同的型別」假通過
type Wrong1 = Simple<{ a: any }, { a: string }>; // true ❌

// 2. Union 被分佈，連自己等於自己都不是 true
type Wrong2 = Simple<"a" | "b", "a" | "b">; // boolean ❌

// 3. 一邊是 any 時，條件型別回傳兩個分支的聯合
type Wrong3 = Simple<any, string>; // boolean ❌
```

另外：`Equal` 比的是「是不是同一個型別」，不是「結構長得一樣」：

```typescript
// T extends infer O：先把 T 複製進 O（若 T 是 Union 也會分佈）
// { [K in keyof O]: O[K] }：再依 key 重建一個「新的物件型別」
type Expand<T> = T extends infer O ? { [K in keyof O]: O[K] } : never;

type Intersection = { a: 1 } & { b: 2 }; // 型別身分仍是「兩個物件的交集」
type Flattened = { a: 1; b: 2 }; // 單一物件字面值

type E1 = Equal<Intersection, Flattened>; // false ❌ 賦值雙向都過，但不是同一型別
type E2 = Equal<Expand<Intersection>, Flattened>; // true ✅
```

`{ a: 1 } & { b: 2 }` 賦值給 `{ a: 1; b: 2 }` 沒問題，反過來也沒問題，所以雙向 `extends` 會說相等。`Equal` 卻看成兩種不同的型別構造：一個還掛著 `&`，一個是寫死的物件。

它不是拿這兩個型別直接互比，而是先做成兩個判斷器，再問判斷器相不相等：

```typescript
// Equal<Intersection, Flattened> 展開後就是在問：
type CheckerA = <T>() => T extends { a: 1 } & { b: 2 } ? 1 : 2;
type CheckerB = <T>() => T extends { a: 1; b: 2 } ? 1 : 2;

type SameChecker = CheckerA extends CheckerB ? true : false; // false
```

```text
Equal<{ a: 1 } & { b: 2 }, { a: 1; b: 2 }>
1. 左邊判斷器：任意 T，問 T extends ({ a: 1 } & { b: 2 })？
2. 右邊判斷器：任意 T，問 T extends ({ a: 1; b: 2 })？
3. 再問：左邊這個函式型別，能不能賦值給右邊？
```

`T` 此時還沒代入任何具體型別，條件是**延後計算**的。TypeScript 比較兩個泛型函式時，會看「`extends` 右側是不是同一個型別」，這一步**不會**先把 `&` 攤平。因此：

- CheckerA 右側仍是 Intersection
- CheckerB 右側是物件字面值
- 兩個判斷器不相等 → `Equal` 是 `false`

這也解釋了為什麼找不到「賦值得了其中一個、賦值不了另一個」的具體 `T`，`Equal` 照樣是 `false`：它比的是判斷器裡寫死的型別構造，不是代入後的結構相容。`Expand` 之後兩邊都變成 `T extends { a: 1; b: 2 }`，判斷器才一致。

`Expand` 做的事就是把 `&` 攤掉：

```text
Expand<{ a: 1 } & { b: 2 }>
1. infer O → O = { a: 1 } & { b: 2 }
2. keyof O = "a" | "b"（交集的 key 會併成聯集）
3. 映射重建 { a: 1; b: 2 } → 變成和 Flattened 同一個型別
```

測結構相不相等時先 `Expand`；測「是不是我寫出來的那一個型別」就不要攤。完整測試寫法見 [13.10](./13-type-level-programming.md)。

### `Includes` 為什麼看起來 easy，卻一定要用 `Equal`

[#898 Includes](https://github.com/type-challenges/type-challenges/blob/main/questions/00898-easy-includes/README.md) 被標成 easy，正確解卻是「Tuple 遞迴 + `Equal`」：

```typescript
type Includes<T extends readonly unknown[], U> =
  T extends [infer F, ...infer R]
    ? Equal<F, U> extends true
      ? true
      : Includes<R, U>
    : false;
```

若寫成 `F extends U`，`Includes<[boolean], true>` 之類的測資會過不了——`true` 可以賦值給 `boolean`，但題目要的是「陣列裡有沒有**這個型別**」。這題把 14.5 與本節串在一起。

測試方法（`Expect`、`@ts-expect-error`、`vitest --typecheck`）見 [13.10](./13-type-level-programming.md)。

---

## 14.9 Union 轉 Intersection：逆變

對應 [#55 Union to Intersection](https://github.com/type-challenges/type-challenges/blob/main/questions/00055-hard-union-to-intersection/README.md)。這是 Hard 的分水嶺，也是 [13.7](./13-type-level-programming.md) 寫過的公式：

```typescript
type UnionToIntersection<U> = (
  U extends any ? (x: U) => void : never
) extends (x: infer I) => void
  ? I
  : never;

type C = UnionToIntersection<{ a: 1 } | { b: 2 }>; // { a: 1 } & { b: 2 }
```

函式**參數**是逆變的：要把 `(x: A) => void | (x: B) => void` 當成同一個函式型別，參數會被交成 `A & B`。先用分佈把 Union 每個成員包進參數位置，再 `infer` 一次，就得到交集。

`Permutation`、`Union to Tuple`、`Currying` 都站在這塊上面。產品程式裡很少需要自己寫 `UnionToTuple`——它能做，但不穩定，也不該當成常規工具。

---

## 14.10 對照 type-challenges：最小題單

同一家族做 2～3 題，觀念就齊了；後面多半是換皮。建議順序：

| 家族 | 題 | 對應本章 |
|------|----|----------|
| 條件 / 分佈 | If、Exclude | 14.2、14.3 |
| 物件映射 | Pick、Readonly、Omit | 14.6 |
| Tuple | First、Concat、Parameters、Filter | 14.4、14.5 |
| 字串 | Trim Left、Trim、Replace | 14.4、14.7 |
| 判斷器 | IsNever、IsUnion、IsEqual、Includes | 14.3、14.8 |
| 進階 | Awaited、Tuple to Union、Deep Readonly、Union to Intersection、IsAny | 14.4、14.5、14.8、14.9 |

不必整本搬進課程的：

- Extreme 全部（JSON Parser、Sort、大數運算）
- 數字謎題：Fibonacci、Pascal、Sudoku、Tower of Hanoi
- 框架模擬：Simple Vue、Pinia（觀念已是遞迴物件 + 函式）
- `Union to Tuple`（能寫，產品裡不要用）

效能、遞迴深度、以及「什麼時候該收手」見 [13.9](./13-type-level-programming.md)。函式庫作者為了使用者體驗值得投資複雜型別；應用程式開發者多半不需要把 type-challenges 寫進業務程式。

---

## 練習題

以下三題刻意跟 [第十三章練習](./13-type-level-programming.md) 錯開：分別練物件映射、字串遞迴，以及「Tuple + `Equal`」。測資用 type-challenges 的 `Equal` / `Expect`。

```typescript
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends
  (<T>() => T extends Y ? 1 : 2)
    ? true
    : false;
type Expect<T extends true> = T;
```

### 練習 1：MyPick

實作內建的 `Pick`，不要使用 `Pick` 本身。

```typescript
type MyPick<T, K> = ???;

interface Todo {
  title: string;
  description: string;
  completed: boolean;
}

type _cases = [
  Expect<Equal<MyPick<Todo, "title">, { title: string }>>,
  Expect<Equal<MyPick<Todo, "title" | "completed">, { title: string; completed: boolean }>>,
];
```

<details>
<summary>參考解答</summary>

`K` 必須是 `T` 的 key，否則呼叫端寫錯欄位名稱不會被擋。映射的來源寫 `K`（而不是 `keyof T`），就只會留下被挑中的那些鍵。

```typescript
type MyPick<T, K extends keyof T> = {
  [P in K]: T[P];
};
```

</details>

### 練習 2：TrimLeft

去掉字串型別開頭的空白。一次只剝一層，靠遞迴清光。

```typescript
type TrimLeft<S extends string> = ???;

type _cases = [
  Expect<Equal<TrimLeft<"  hello">, "hello">>,
  Expect<Equal<TrimLeft<"hello">, "hello">>,
  Expect<Equal<TrimLeft<"   hello  ">, "hello  ">>,
];
```

<details>
<summary>參考解答</summary>

樣板 `` ` ${infer R}` `` 對上「開頭是空白」；對上就把剩餘丟回自己，對不上就回傳原字串。

```typescript
type TrimLeft<S extends string> = S extends ` ${infer R}` ? TrimLeft<R> : S;
```

`Trim` 是先 `TrimLeft` 再 `TrimRight`（或反過來），見 14.7。

</details>

### 練習 3：Includes

實作型別層的 `Array.includes`：元組 `T` 是否**包含型別** `U`。必須能區分 `boolean` 與 `true`，也必須能區分 `{ a: any }` 與 `{ a: string }`。

```typescript
type Includes<T extends readonly unknown[], U> = ???;

type _cases = [
  Expect<Equal<Includes<["Kars", "Esidisi", "Wamuu", "Santana"], "Dio">, false>>,
  Expect<Equal<Includes<["Kars", "Esidisi", "Wamuu", "Santana"], "Wamuu">, true>>,
  Expect<Equal<Includes<[boolean], true>, false>>,
  Expect<Equal<Includes<[{ a: any }], { a: string }>, false>>,
];
```

<details>
<summary>參考解答</summary>

拆 `First` / `Rest` 後，用 14.8 的 `Equal` 比第一個元素，命中就停，否則對 `Rest` 遞迴。空元組是 `false`。

```typescript
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends
  (<T>() => T extends Y ? 1 : 2)
    ? true
    : false;

type Includes<T extends readonly unknown[], U> =
  T extends [infer F, ...infer R]
    ? Equal<F, U> extends true
      ? true
      : Includes<R, U>
    : false;
```

若把 `Equal<F, U>` 寫成 `F extends U`，`Includes<[boolean], true>` 會得到 `true`，第三個測資會失敗。

</details>

---

> 上一章：[第十三章 — 型別層級程式設計](./13-type-level-programming.md)
> 下一章：[第十五章 — TypeScript Compiler API](./15-compiler-api.md)
