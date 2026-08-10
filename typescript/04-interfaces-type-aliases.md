# 第四章：介面與型別別名

## 4.1 介面（Interface）

介面是 TypeScript 中定義物件結構的主要方式。

### 基本介面

```typescript
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
```

### 可選屬性

```typescript
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
```

### 唯讀屬性

```typescript
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
```

---

## 4.2 介面擴展（extends）

```typescript
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
```

### 注意事項

#### 覆寫繼承來的同名屬性：只能「收窄」，不能不相容

子介面可以重新宣告一個父介面已經有的屬性，但**新型別必須能指派給父型別**（也就是只能收窄成父型別的子集）。不相容就會出現 `TS2430`。

```typescript
interface Base {
  value: string | number;
  id: number;
}

// ✅ OK：把 value 收窄成 string（string 可指派給 string | number）
interface Ok extends Base {
  value: string;
}

// ❌ TS2430：id 從 number 改成 string，兩者不相容
interface Bad extends Base {
  id: string;
  // Interface 'Bad' incorrectly extends interface 'Base'.
  //   Types of property 'id' are incompatible.
}
```

同理，**不能把父介面的「必要屬性」改成「可選屬性」**——因為可選等於允許 `undefined`，而 `number | undefined` 不能指派給 `number`：

```typescript
interface Base {
  x: number;
}

// ❌ TS2430：可選會引入 undefined，違反父型別
interface Bad extends Base {
  x?: number;
}
```

> 💡 記法：`extends` 是**累加 + 收窄**，不是「取代」。子介面對同名屬性只能讓它更嚴格，不能改成不相容或更寬鬆。

#### readonly 不參與繼承檢查，而且只是「淺層、本地」保護

和上面的型別相容性不同，`readonly` **修飾詞在 `extends` 時完全不被檢查**——你可以在子介面自由地加上或拿掉它，編譯器都不會報錯：

```typescript
interface Base {
  readonly id: number;
  name: string;
}

// ✅ 兩個修改都不會報錯
interface Sub extends Base {
  id: number;            // 拿掉了 readonly
  readonly name: string; // 反而加上了 readonly
}
```

更要小心的是，`readonly` 只保證「不能透過這個名字直接改寫」，它**不參與物件之間的可指派性**，所以很容易被一個可變的別名繞過：

```typescript
interface ReadonlyName {
  readonly name: string;
}
interface MutableName {
  name: string;
}

const mutable: MutableName = { name: "a" };
const ro: ReadonlyName = mutable; // ✅ 可指派（readonly 不影響相容性）

mutable.name = "b"; // 透過可變別名改寫
console.log(ro.name); // "b"：ro 指向同一個物件，值一起變了
```

> ⚠️ `readonly` 是**編譯期的淺層保護**：只擋「直接對這個屬性賦值」，不保證整個物件不可變，也擋不住透過別名或型別轉換的修改。需要真正的不可變，請在執行期自行處理（例如 `Object.freeze`、複製而非修改），別把安全性建立在 `readonly` 上。

---

## 4.3 型別別名（Type Alias）

使用 `type` 關鍵字定義型別別名。

### 基本用法

```typescript
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
```

### 交集型別（Intersection）

```typescript
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
```

---

## 4.4 Interface vs Type

| 特性 | Interface | Type |
|------|-----------|------|
| 物件結構 | ✅ | ✅ |
| extends 繼承 | ✅ | ❌（用 `&` 交集代替） |
| implements | ✅ | ✅ |
| 宣告合併 | ✅ | ❌ |
| 聯合型別 | ❌ | ✅ |
| 原始型別別名 | ❌ | ✅ |
| 元組 | ❌ | ✅ |
| 映射型別 | ❌ | ✅ |

### 宣告合併（Declaration Merging）

```typescript
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
```

實務上宣告合併真正常用的場合，是**模組擴充（Module Augmentation）**——替第三方套件或全域型別補充自訂屬性，而不是像上面那樣在同一檔案裡刻意重複宣告：

```typescript
// 替 Express 的 Request 型別加上自訂屬性（例如登入後掛上的 user）
declare global {
  namespace Express {
    interface Request {
      user?: { id: number; name: string };
    }
  }
}

// 之後在任何看得到這份宣告的檔案中，req.user 都能直接使用且有型別
// app.get("/me", (req, res) => res.json(req.user));

export {}; // declare global 只能出現在「模組」裡；沒有任何 import/export 的檔案會被當成純指令碼，需要這行把它變成模組
```

這裡的 `declare` 是在告訴 TypeScript：**「以下的型別不是我這份檔案生出來的，它們屬於別的地方（這裡是全域範圍），我只是來補充內容，請不要為它產生任何 JavaScript。」** 這種只描述型別、不含實作的宣告叫**環境宣告（ambient declaration）**：

- `declare global { ... }` = 「打開全域範圍，把裡面的宣告合併進去」。Express 的 `Request` 介面在型別上位於全域的 `Express` 命名空間下，所以要先 `declare global` 才進得去。
- 上面整段編譯後會**完全消失**，不會產生任何一行 JavaScript——它純粹是給型別檢查器看的。
- 型別是補上了，但**執行期真的把 `req.user` 塞進去仍然要你自己寫**（通常在驗證登入的 middleware 裡）。TypeScript 不會驗證這個承諾；宣告了卻沒實際賦值，`req.user` 執行期就是 `undefined`。

> 📌 `declare` 的完整說明（各種形態、限制、以及 `.d.ts` 檔案）見第 8 章 8.3。

> 💡 這才是宣告合併存在的主因：讓你在不修改套件原始碼的情況下，為既有型別「補洞」。

### 何時使用哪個？

```typescript
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
```

> 💡 **建議**：定義物件結構優先用 `interface`，其他型別操作用 `type`。

---

## 4.5 索引簽名（Index Signatures）

當物件的**鍵在寫程式時還不知道**（例如翻譯表、設定檔、API 回傳的動態欄位），就用索引簽名描述「任何符合這種鍵的屬性，值都是這個型別」。

```typescript
// 動態鍵值
interface StringMap {
  [key: string]: string;
}

const translations: StringMap = {
  hello: "你好",
  goodbye: "再見",
  thanks: "謝謝",
};

// 索引簽名讓「未宣告的鍵」也合法
translations.welcome = "歡迎";   // ✅
// translations.count = 1;      // ❌ 值型別必須是 string
```

`[key: string]` 裡的 `key` 只是**參數名稱**，可以隨便命名（`k`、`prop`、`index` 都一樣），真正有意義的是**冒號兩邊的型別**：左邊是「鍵的型別」，右邊是「值的型別」。

### 鍵的型別可以放什麼

只有四種：`string`、`number`、`symbol`、樣板字面值型別（template literal type），以及它們的聯合。

```typescript
interface KeyKinds {
  [k1: string]: unknown;            // ✅ 字串鍵
  [k2: symbol]: unknown;            // ✅ symbol 鍵
  [k3: `data-${string}`]: unknown;  // ✅ 樣板字面值（TS 4.4+）
}

interface UnionKey {
  [key: string | number]: string;   // ✅ 聯合＝同時宣告 string 與 number 兩個簽名
}
```

> ⚠️ **不能**用具體的字面值聯合當鍵，會出現 TS1337：
>
> ```typescript
> type Role = "admin" | "user";
>
> interface Bad {
>   [key: Role]: string;  // ❌ TS1337: An index signature parameter type
>                         //    cannot be a literal type or generic type.
> }
>
> // ✅ 鍵是有限集合時，改用 Record（映射型別）
> type Good = Record<Role, string>;
> ```

### 多個索引簽名

一個型別可以同時有多個索引簽名，但要遵守兩條規則。

#### 規則一：同一種鍵型別只能出現一次

```typescript
interface Duplicated {
  [key: string]: string;
  [prop: string]: string;  // ❌ TS2374: Duplicate index signature for type 'string'.
}
```

樣板字面值也算「一種鍵型別」，同樣的樣式不能重複；但**不同**樣式可以並存：

```typescript
// ✅ 兩個不同樣式並存
interface HtmlAttrs {
  [key: `data-${string}`]: string;
  [key: `aria-${string}`]: string;
}

const attrs: HtmlAttrs = {
  "data-id": "42",
  "aria-label": "關閉",
  // "title": "x",   // ❌ 不符合任一樣式，不能加
};
```

#### 規則二：兩個簽名「管到同一個鍵」時，不能各說各話

這條規則是多數人卡住的地方，我們從頭推一次。

**第一步：先看 JS 的事實 —— 物件的鍵永遠是字串**

```javascript
const obj = {};
obj[0] = "hello";

console.log(obj["0"]);         // "hello"      ← 用字串 "0" 也拿到同一個值
console.log(Object.keys(obj)); // ["0"]        ← 鍵實際上被存成字串 "0"
console.log(typeof Object.keys(obj)[0]); // "string"
```

所以 `obj[0]` 和 `obj["0"]` 不是兩個屬性，**是同一個屬性**。這點是理解整條規則的關鍵。

**第二步：把索引簽名想成「一條承諾，管一組鍵」**

每個索引簽名都在宣告「凡是符合這個鍵型別的屬性，值都是某個型別」。不同簽名管到的鍵範圍如下：

```
所有可能的字串鍵：  "name"   "abc"   "id-1"   "id-x"   "0"   "1"   "2"  ...
                    └──────────────────────────────────────────────────┘
                     [key: string]          ← 管「全部」字串鍵

                                     └──────────┘
                                     [key: `id-${string}`]  ← 只管 id- 開頭

                                                    └────────────────┘
                                                    [index: number]  ← 只管數字鍵
                                                    （因為 0 就是 "0"，也落在字串鍵裡）
```

重點：`[key: string]` 的範圍**完整包含**另外兩個。`[index: number]` 和 `[key: \`id-${string}\`]` 都是它的**子集**。

**第三步：範圍重疊，承諾就必須相容**

```typescript
interface Conflict {
  [key: string]: string;   // 承諾 A：任何字串鍵 → 值是 string
  [index: number]: number; // 承諾 B：任何數字鍵 → 值是 number
}
```

拿 `obj[0]` 這一個屬性來問這個型別：

- 走承諾 A（`"0"` 是字串鍵）→ 值是 `string`
- 走承諾 B（`0` 是數字鍵）→ 值是 `number`

**同一個屬性，兩個答案，而且互相矛盾** —— TypeScript 無法決定 `obj[0]` 是什麼型別，所以直接報錯：

```typescript
interface Conflict {
  [key: string]: string;
  [index: number]: number;
  // ❌ TS2413: 'number' index type 'number' is not assignable to
  //            'string' index type 'string'.
  //    「數字鍵承諾的 number，不能塞進字串鍵承諾的 string」
}
```

> 💡 用規章來想：`[key: string]` 是**公司規章**（管全體員工），`[index: number]` 是**部門規章**（只管一個部門）。部門規章可以比公司規章更嚴格，但**不能違反**公司規章 —— 因為部門員工同時受兩份規章管。

**第四步：怎麼修 —— 讓窄的變成寬的「一種特例」**

只要讓子集簽名的值型別成為母集簽名值型別的**子型別**，兩個承諾就不矛盾了：

```typescript
// ✅ 把公司規章放寬，讓部門規章成為它的一種特例
interface Ok {
  [key: string]: string | number; // 承諾 A：任何字串鍵 → string 或 number
  [index: number]: number;        // 承諾 B：數字鍵 → 一定是 number
}
// 現在問 obj[0]：
//   走 A → string | number（「可能是這兩種」）
//   走 B → number        （「就是 number」）
// B 只是把 A 講得更精確，沒有牴觸 → 合法，且讀取時採用更精確的 B

// ✅ 樣板字面值同理：unknown 能容納任何值，所以永遠不會衝突
interface EventMap {
  [key: `on${string}`]: () => void; // 子集：on 開頭的鍵 → 函式
  [key: string]: unknown;           // 母集：其他鍵 → unknown
}
// () => void 是 unknown 的子型別 → 合法
```

**第五步：範圍不重疊，就完全沒有約束**

這條規則只在「兩個簽名管到同一個鍵」時才啟動。範圍互不相干的簽名可以隨便寫：

```typescript
// ✅ symbol 鍵不會被轉成字串，與 string 簽名完全不重疊
interface SymbolAndString {
  [key: string]: number;
  [key: symbol]: string;   // 互不干涉
}

// ✅ number 鍵與 on 開頭的字串鍵不會重疊（沒有 string 簽名把它們串起來）
interface NoOverlap {
  [index: number]: number;
  [key: `on${string}`]: () => void;
}
```

**第六步：這條規則跟「誰是 string 簽名」無關**

只要範圍有重疊就會檢查，即使兩邊都是樣板字面值也一樣：

```typescript
// ❌ "data-id-1" 同時符合兩個樣式 → 兩個承諾打架
interface OverlapPatterns {
  [key: `data-${string}`]: number;    // 母集
  [key: `data-id-${string}`]: string; // 子集
  // TS2413: '`data-id-${string}`' index type 'string' is not assignable to
  //         '`data-${string}`' index type 'number'.
}

// ❌ 這次是 number 簽名當母集，樣板字面值當子集
interface NumPattern {
  [index: number]: number;      // 母集（數字鍵）
  [key: `${number}`]: string;   // 子集（"0"、"1"…這類數字字串）
  // TS2413: '`${number}`' index type 'string' is not assignable to
  //         'number' index type 'number'.
}
```

> ⚠️ 記住一句話就夠：**子集簽名的值型別，必須能指派給母集簽名的值型別。**下一小節的 TS2411（固定屬性衝突）其實就是同一條規則 —— 固定屬性是「只管一個鍵」的最小子集。

#### 讀取時，最精確的簽名優先

多個簽名並存時，TypeScript 會挑**最符合該鍵**的那一個來決定型別。

```typescript
interface Mixed {
  [key: string]: string | number;
  [index: number]: number;
}

declare const m: Mixed;

const v1 = m[0];      // number          ← 命中 number 簽名
const v2 = m["0"];    // number          ← 數字字串也命中 number 簽名
const v3 = m["x"];    // string | number ← 只能命中 string 簽名

interface EventMap2 {
  [key: `on${string}`]: () => void;
  [key: string]: unknown;
}

declare const e: EventMap2;

const h1 = e["onClick"];  // () => void  ← 命中樣板字面值簽名
const h2 = e["foo"];      // unknown     ← 退回 string 簽名
```

| 型別的簽名組合 | `obj[0]` | `obj["0"]` | `obj["abc"]` |
| -------------- | -------- | ---------- | ------------ |
| 只有 `[k: string]: T` | `T` | `T` | `T` |
| 只有 `[k: number]: T` | `T` | `T` | ❌ TS7015 |
| `[k: string]: A` ＋ `[k: number]: B` | `B` | `B` | `A` |
| 只有 `[k: \`data-${string}\`]: T` | ❌ | ❌ | ❌ TS7053（鍵不符合樣式） |

### 混合固定屬性與索引簽名

```typescript
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
```

固定屬性就是**只管一個鍵的最小子集簽名**，所以套用的是上面那條規則二：它的型別必須能指派給覆蓋它的索引簽名的值型別，否則出現 TS2411。

```typescript
interface Invalid {
  name: string;
  age: number;          // ❌ TS2411：number 不能指派給索引簽名的 string
  [key: string]: string;
}
// 問 obj.age：走固定屬性 → number；走索引簽名 → string。矛盾。

interface InvalidMethod {
  greet(): string;      // ❌ TS2411：方法也算屬性，() => string 不是 string
  [key: string]: string;
}

// 同樣的規則也適用於樣板字面值簽名 —— 只看「有沒有覆蓋到這個鍵」
interface InvalidPattern {
  "data-id": number;    // ❌ TS2411：這個鍵符合 `data-${string}`，值型別必須是 string
  [key: `data-${string}`]: string;
}

// 沒被覆蓋到的固定屬性完全不受影響
interface Fine {
  name: number;         // ✅ symbol 簽名管不到字串鍵 name
  [key: symbol]: string;
}
```

三種解法，依需求選一種：

```typescript
// 解法 1：放寬索引簽名的值型別為聯合（最直接）
interface Union {
  name: string;
  age: number;
  [key: string]: string | number;
}

// 解法 2：把動態部分收進獨立屬性（推薦，型別最乾淨）
interface Nested {
  name: string;
  age: number;
  extra: Record<string, string>;
}

// 解法 3：用交集型別繞過（固定屬性維持原型別）
type Intersect = {
  name: string;
  age: number;
} & {
  [key: string]: string | number;
};
```

> ⚠️ 解法 1 的代價是**讀取時型別變寬**。固定屬性仍保有自己的窄型別，但動態鍵只能拿到聯合型別，用之前必須先窄化：
>
> ```typescript
> interface Union2 {
>   name: string;
>   age: number;
>   [key: string]: string | number;
> }
>
> declare const u: Union2;
>
> u.name.length;                          // ✅ 固定屬性保有 string
> // u.city.length;                       // ❌ TS2339：string | number 沒有 length
> if (typeof u.city === "string") {
>   u.city.length;                        // ✅ 窄化後可用
> }
> ```

### 兩個容易踩到的行為

**1. 索引簽名會關閉多餘屬性檢查**

```typescript
interface Strict {
  name: string;
}
// const a: Strict = { name: "G", extra: "x" };  // ❌ 多餘屬性檢查會攔下來

interface Loose {
  name: string;
  [key: string]: string;
}
const b: Loose = { name: "G", extra: "x" };      // ✅ 任何字串鍵都放行（打錯字也不會被抓到）
```

**2. 讀不存在的鍵不會報錯**

索引簽名承諾「任何鍵都有值」，但執行時當然可能是 `undefined`。開啟 `noUncheckedIndexedAccess` 讓 TypeScript 幫你把 `undefined` 加進來：

```typescript
interface Dict {
  [key: string]: string;
}

const dict: Dict = {};

const value = dict.missing;
// 預設：              string           → dict.missing.length 可通過編譯，執行時炸掉
// noUncheckedIndexedAccess：string | undefined → 強制你先檢查
```

> 💡 `keyof` 遇到索引簽名時會展開成鍵型別本身，而不是實際宣告的屬性名：
>
> ```typescript
> interface StringIdx { [key: string]: string }
> interface NumberIdx { [index: number]: string }
>
> type K1 = keyof StringIdx;              // string | number（字串鍵涵蓋數字鍵）
> type K2 = keyof NumberIdx;              // number
> type K3 = keyof Record<string, string>; // string（映射型別不會多出 number）
> ```
>
> 想拿到「只有實際宣告的那幾個鍵」，就不要用索引簽名，改用 `Record<具體聯合, T>`。

### interface 沒有隱式索引簽名

這是實務上最常見的困惑：**型別別名可以指派給 `Record`，interface 不行。**

```typescript
interface PointInterface {
  x: number;
  y: number;
}
type PointAlias = {
  x: number;
  y: number;
};

const p1: PointInterface = { x: 1, y: 2 };
const p2: PointAlias = { x: 1, y: 2 };

// const r1: Record<string, number> = p1;
// ❌ TS2322: Index signature for type 'string' is missing in type 'PointInterface'.

const r2: Record<string, number> = p2;  // ✅ 型別別名有「隱式索引簽名」
```

原因是 interface 可以被**宣告合併**或被其他 interface 繼承後加上新屬性（見 4.2），TypeScript 無法保證它的屬性型別未來仍然全部符合 `Record<string, number>`；型別別名封閉、不可再擴充，所以能安全推出隱式索引簽名。

> 💡 遇到這個錯誤時的處理方式：把 `interface` 改成 `type`、明確加上索引簽名，或在傳入處用 `{ ...p1 }` 展開成物件字面值。

### Record 工具型別（替代方案）

```typescript
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
```

---

## 4.6 介面與函式

```typescript
// 自足：補上 SearchFunc 引用到的 SearchResult 型別
interface SearchResult {
  id: number;
  title: string;
}

// 定義可呼叫的介面
interface SearchFunc {
  (query: string, limit?: number): Promise<SearchResult[]>;
}

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
```

---

## 4.7 實戰模式

### API Response 型別設計

```typescript
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
```

### DTO（Data Transfer Object）模式

`User` 是**資料庫裡的完整樣子**：有 id、有加密後的密碼、有建立時間。但 API 進出時傳的東西跟它不一樣：

- **註冊時**：前端不會傳 `id`（資料庫自動給）、不會傳 `passwordHash`（後端才算得出來）、不會傳 `createdAt`（資料庫自動填）；但會傳**明文 `password`**。
- **更新個資時**：只准改 `name` / `email`，而且可能只改其中一個。

DTO（Data Transfer Object，資料傳輸物件）就是為這兩種場合各做一個型別。做法是從 `User` **衍生**出來，而不是重新手寫。

> 下面會用到 `Omit`、`Pick`、`Partial` 這三個內建工具型別。它們的完整原理見 [第 6 章：泛型](./06-generics.md) 與 [第 7 章：進階型別](./07-advanced-types.md)，這裡先記住用途即可：

| 寫法 | 白話 |
| ---- | ---- |
| `Omit<T, K>` | 從 T **拿掉** K 這幾個欄位 |
| `Pick<T, K>` | 從 T **只挑** K 這幾個欄位 |
| `Partial<T>` | 把 T 的欄位**全變成可選**（都加上 `?`） |
| `A & B` | 交集型別：**同時具備** A 和 B 的欄位 |

```typescript
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
```

#### 拆開來看：`CreateUserDto`

```typescript
// 步驟 1：Omit 拿掉三個自動生成的欄位，剩下
// { name: string; email: string }

// 步驟 2：用 & 接上前端真的會傳的 password
// { name: string; email: string } & { password: string }

// 最終等同於手寫這個：
type CreateUserDtoExpanded = {
  name: string;
  email: string;
  password: string; // 明文，後端收到才加密成 passwordHash
};

const createDto: CreateUserDto = {
  name: "Gary",
  email: "gary@example.com",
  password: "secret",
};

// ❌ id 是資料庫自動生成的，DTO 裡根本沒有這個欄位
// const bad: CreateUserDto = { ...createDto, id: 1 };
```

#### 拆開來看：`UpdateUserDto`

巢狀的工具型別**由內往外**讀：

```typescript
// 步驟 1（內層 Pick）：只挑出 name 和 email
// { name: string; email: string }

// 步驟 2（外層 Partial）：全部加上 ?
// { name?: string; email?: string }

// 最終等同於手寫這個：
type UpdateUserDtoExpanded = {
  name?: string;
  email?: string;
};

const patchName: UpdateUserDto = { name: "Gary Cai" }; // ✅ 只改名字
const patchEmail: UpdateUserDto = { email: "new@example.com" }; // ✅ 只改信箱
const patchNothing: UpdateUserDto = {}; // ✅ 什麼都不改也合法

// ❌ email 沒被 Pick 進來的欄位不能改
// const bad: UpdateUserDto = { passwordHash: "..." };
```

這正是 `PATCH` 部分更新要的行為：欄位全可選，前端傳什麼就改什麼。

#### 為什麼不直接手寫三個 interface？

因為衍生型別會**跟著 `User` 走**。哪天 `User` 把 `name` 改名成 `username`：

- `Pick<User, "name">` 會立刻編譯錯誤（`"name"` 不是 `User` 的鍵），逼你去修 DTO。
- 手寫的三份型別則會默默不同步，等到 runtime 才炸。

一份來源（`User`）、多個視角（各種 DTO），這是 TypeScript 型別設計最常用的思路。

---

## 練習題

### 練習 1：定義介面

為一個電商系統定義以下介面：
- `Product`：id、名稱、價格、庫存、分類、可選的描述
- `CartItem`：包含 Product 和數量
- `Order`：id、購買者、訂單項目陣列、總金額、狀態

<details>
<summary>參考解答</summary>

先定義最底層的 `Product`，把「可能不存在」的描述用 `?` 標成可選；`CartItem` 直接把整個 `Product` 當屬性組合進來（組合優於重複欄位）；`Order` 再持有一組 `CartItem`，並用字面量聯合型別限定 `status` 只能是幾個合法狀態。

```typescript
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
```

重點：用字面量聯合型別（`"pending" | ...`）取代 `string`，可以讓非法狀態在編譯期就被擋下；欄位「可能沒有」時才用 `?`，不要濫用。

</details>

### 練習 2：介面繼承

設計一個動物類別體系，使用介面繼承：

```typescript
interface Animal { /* ... */ }
interface Pet extends Animal { /* ... */ }
interface Dog extends Pet { /* ... */ }
interface Cat extends Pet { /* ... */ }
```

<details>
<summary>參考解答</summary>

把共通欄位往上放：所有動物都有 `name`、`age`；`Pet` 在動物之上多了 `owner`；`Dog`、`Cat` 再各自補上專屬欄位與行為方法。每一層 `extends` 都會累積上層所有成員，所以 `Dog` 同時擁有 `name`、`age`、`owner`、`breed`、`bark`。

```typescript
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
```

重點：把共用欄位抽到上層介面、專屬欄位留在下層，是介面繼承最典型的用途；`extends` 是累加而非取代。

</details>

### 練習 3：Interface vs Type

將以下 Type 改寫為 Interface，並思考哪些無法用 Interface 表達：

```typescript
// 自足：補上 UserMap / ReadonlyUser 引用到的 User
interface User {
  id: number;
  name: string;
}

type Status = "pending" | "active" | "inactive";
type Point = [number, number];
type UserMap = Record<string, User>;
type ReadonlyUser = Readonly<User>;
```

<details>
<summary>參考解答</summary>

逐一檢視：聯合型別（`Status`）、元組（`Point`）、以及 `Readonly<T>` 這類映射工具型別，都**無法**用 `interface` 表達，只能維持 `type`。唯一能改寫的是 `UserMap`——`Record<string, User>` 本質是索引簽名，`interface` 可以用 `[key: string]: User` 近似表達。

```typescript
interface User {
  id: number;
  name: string;
}

// ❌ 聯合型別無法用 interface 表達，只能用 type
type Status = "pending" | "active" | "inactive";

// ❌ 元組無法用 interface 表達，只能用 type
type Point = [number, number];

// Record 映射型別：可用索引簽名近似改寫為 interface
type UserMap = Record<string, User>;
interface UserMapInterface {
  [key: string]: User;
}

// ❌ Readonly<T> 這類映射型別無法用 interface 表達，只能用 type
type ReadonlyUser = Readonly<User>;
```

重點：`interface` 專長是「描述物件形狀」與繼承；聯合、元組、映射型別這些「型別運算」是 `type` 的地盤。判斷準則就是本章 4.4 那張對照表。

</details>

---

> 下一章：[第五章 — 類別與物件導向程式設計](./05-classes.md)
