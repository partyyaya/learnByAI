# 第八章：模組系統與命名空間

## 8.1 ES Modules（ESM）

TypeScript 完整支援 ES Modules 語法，這是現代 JavaScript 的標準模組系統。

### 匯出（Export）

```typescript
// user.ts

// 具名匯出
export interface User {
  id: number;
  name: string;
  email: string;
}

export function createUser(name: string, email: string): User {
  return { id: Date.now(), name, email };
}

export const MAX_USERS = 100;

// 預設匯出
export default class UserService {
  private users: User[] = [];

  add(user: User): void {
    this.users.push(user);
  }

  getAll(): User[] {
    return [...this.users];
  }
}
```

### 匯入（Import）

```typescript
// main.ts

// 匯入預設匯出
import UserService from "./user";

// 匯入具名匯出
import { User, createUser, MAX_USERS } from "./user";

// 匯入並重新命名
import { createUser as makeUser } from "./user";

// 匯入全部
import * as UserModule from "./user";
UserModule.createUser("Gary", "gary@example.com");

// 僅匯入型別（不會產生 JavaScript 程式碼）
import type { User } from "./user";

// 混合匯入
import UserService, { createUser, type User } from "./user";
```

### 重新匯出（Re-export）

```typescript
// index.ts — barrel file（桶裝匯出）

export { User, createUser } from "./user";
export { Product, createProduct } from "./product";
export { Order } from "./order";

// 重新匯出並重新命名
export { createUser as makeUser } from "./user";

// 匯出全部
export * from "./user";
export * from "./product";

// 匯出型別
export type { User } from "./user";
```

### 動態匯入（Dynamic `import()`）

除了檔案頂部的靜態 `import`，ES Modules 也支援在執行期才載入模組的**動態 `import()`**——它是一個回傳 `Promise` 的函式呼叫，而不是宣告：

```typescript
// user.ts（同本節開頭的具名匯出／預設匯出）
export interface User {
  id: number;
  name: string;
  email: string;
}

export function createUser(name: string, email: string): User {
  return { id: Date.now(), name, email };
}

export const MAX_USERS = 100;

export default class UserService {
  private users: User[] = [];
  add(user: User): void {
    this.users.push(user);
  }
  getAll(): User[] {
    return [...this.users];
  }
}

// main.ts

// 動態匯入：在需要時才載入模組，回傳 Promise<模組物件>
async function loadUser() {
  const mod = await import("./user");
  const user = mod.createUser("Gary", "gary@example.com");
  console.log(mod.MAX_USERS); // 100
  return user;
}

// 常見用途：條件式載入、程式碼分割（code splitting）、避免載入用不到的模組
async function loadServiceOnDemand(shouldLoad: boolean) {
  if (!shouldLoad) return null;
  const { default: UserService } = await import("./user"); // 取出預設匯出
  return new UserService();
}
```

> 💡 動態 `import()` 回傳 `Promise`，所以只能在 `async` 函式內用 `await`（或搭配下面的頂層 await）。在瀏覽器打包工具（Vite、Webpack）中，動態 `import()` 也是「程式碼分割」的標準寫法。

### 頂層 await（Top-level await）

ES2022 起支援**頂層 await**——直接在模組最外層使用 `await`，不必包一層 `async function`。要使用它，`tsconfig.json` 需要滿足：

- `"target"` 設為 `ES2022`（或更新）
- `"module"` 設為 `ESNext` / `NodeNext`（不能是 `CommonJS`）

```typescript
// main.ts — 模組最外層，不需要包在 async function 裡
import type { User } from "./user"; // 只要檔案已經有任何 import/export，就會被視為模組

const mod = await import("./user");
const gary = mod.createUser("Gary", "gary@example.com");

console.log(`已載入使用者：${gary.name}`);
```

> ⚠️ 頂層 await 有個前提：該檔案必須被 TypeScript 視為「模組」（至少要有一個 `import` 或 `export`），否則會出現 `'await' expressions are only allowed at the top level of a file when that file is a module` 的編譯錯誤。多數實際專案的檔案本來就有其他 import/export，通常不會踩到；只有像上面這種幾乎「空」的檔案才需要留意。
>
> 本課程 demo 的 `tsconfig.json`（`target: ES2022`、`module: ESNext`）剛好滿足頂層 await 的另一個條件，見第 9 章對 `target` / `module` 的說明。

### 與 CommonJS 互通

專案裡常會同時遇到 ESM（`export` / `import`）與 CommonJS（`module.exports` / `require`）兩種模組系統，尤其是安裝的第三方套件仍以 CommonJS 發佈時，容易踩到幾個地雷：

- **`esModuleInterop`**：CommonJS 模組的 `module.exports = xxx` 並沒有真正的「預設匯出（default export）」，TypeScript 會把它模擬成一個 `default` 屬性。若沒開啟 `esModuleInterop`，`import express from "express"` 這種預設匯入寫法會編譯失敗，必須改寫成 `import * as express from "express"`；開啟後兩種寫法都能用。

  ```json
  {
    "compilerOptions": {
      "esModuleInterop": true // 讓 import express from "express" 這類寫法能正常運作
    }
  }
  ```

- **`export default` 與 `module.exports` 不是同一件事**：TypeScript／ESM 的 `export default X` 編譯成 CommonJS 後，實際上是 `exports.default = X`，而不是 `module.exports = X`。兩者混用時（例如用 `require()` 去讀一個由 `export default` 編譯出來的模組）常會發現多了一層 `.default`，這是最常見的誤會來源之一。

- 這類問題通常只在**混用 CommonJS 套件與 ESM 專案**時才會出現；若第三方套件也都提供原生 ESM 版本，就比較不會踩到。

### 相對路徑匯入的副檔名陷阱（`node16` / `nodenext`）

當 `moduleResolution` 設為 `node16` 或 `nodenext`（對應 Node.js 原生 ESM 的解析規則）時，**相對路徑的匯入必須明確寫出副檔名，而且要寫 `.js`，即使原始檔是 `.ts`**：

```typescript
// moduleResolution: "node16" / "nodenext" 時
// ❌ 執行期找不到模組（Node ESM 不會自動補副檔名）
import { createUser } from "./user";
```

```typescript
// moduleResolution: "node16" / "nodenext" 時
// ✅ 即使原始檔是 user.ts，也要寫 .js
import { createUser } from "./user.js";
```

這是因為 Node.js 原生 ESM 解析器是根據**編譯後**的檔案路徑運作，並不知道你原本寫的是 TypeScript；TypeScript 只會照抄你寫的路徑到輸出檔案裡，不會自動幫你把 `.ts` 換成 `.js`。這是實務上最常見的 TS + ESM 踩雷點之一。

> 💡 本課程 demo 的 `typescript/demo/tsconfig.json` 把 `moduleResolution` 設為 `"Bundler"`（見該檔案第 6 行的註解：「不需要在 import 補上 .js 副檔名，最貼近 tsx 的解析方式」），因此在這個 demo 環境裡練習時，你很可能還沒踩過這個雷——`Bundler` 模式刻意放寬了這個限制。若專案改用 `node16` / `nodenext`（例如要發佈給 Node.js 原生 ESM 執行的函式庫），就得留意這條副檔名規則。

---

## 8.2 import type — 型別匯入

TypeScript 提供了 `import type` 語法，明確區分**值匯入**和**型別匯入**。

```typescript
// ✅ 明確的型別匯入（推薦）
import type { User, Product } from "./types";
import { createUser, createProduct } from "./services";

// 混合匯入
import { createUser, type User } from "./user";

// 為什麼要用 import type？
// 1. 型別匯入在編譯後會被完全移除，不產生 JavaScript 程式碼
// 2. 避免循環依賴問題
// 3. 讓程式碼意圖更清晰
```

### tsconfig 設定

```json
{
  "compilerOptions": {
    // 強制使用 import type
    "verbatimModuleSyntax": true
    // 或舊版設定
    // "importsNotUsedAsValues": "error"
  }
}
```

這個選項在做什麼？**預設情況下，TypeScript 會自作聰明**：發現某個匯入只被當型別用，就把整行 import 從輸出中「消除」掉（稱為 import elision）。方便，但有兩個問題——如果那個模組帶有副作用（polyfill、CSS、註冊全域元件），副作用會跟著消失；而 esbuild、swc 這類逐檔轉譯的工具也無法判斷哪些該刪。

開啟 `verbatimModuleSyntax` 後，**你寫什麼就輸出什麼**：`import type` 一定被移除、普通 `import` 一定保留，同時強制你把型別匯入寫成 `import type`，否則報 `TS1484`。

```typescript
// verbatimModuleSyntax: true
import { User } from "./types.js";
// ❌ TS1484: 'User' is a type and must be imported using a type-only import
//            when 'verbatimModuleSyntax' is enabled.

import type { User } from "./types.js"; // ✅
```

> 📌 完整說明（含編譯前後的實際輸出對照、四種情況的行為差異、以及它取代的舊選項）見第 9 章 9.9。

---

## 8.3 型別宣告檔案（.d.ts）

### declare 關鍵字：「這東西存在，但實作不在這裡」

在讀 `.d.ts` 之前得先搞懂 `declare`，因為整套型別宣告檔都建立在它上面。

TypeScript 裡的宣告可以分成兩類：一類會編譯成真正的 JavaScript（`const`、`function`、`class`…），一類只活在型別層、編譯後完全消失（`interface`、`type`）。**`declare` 的作用就是把第一類變成第二類**：

> `declare X` 的意思是：「我保證 `X` 在執行期一定存在，但它**不是由這份 TypeScript 檔案產生的**（而是來自 `<script>`、打包工具、瀏覽器環境或某個 JS 套件）。你只要記住它的型別、拿去做檢查就好，不要幫我產生任何程式碼。」

這種「只描述型別、不產生實作」的宣告，官方術語叫**環境宣告（ambient declaration）**。

```typescript
// app.ts
declare const __APP_VERSION__: string;                            // 由打包工具在建置時注入（Vite 的 define / webpack 的 DefinePlugin）
declare function gtag(command: string, ...args: unknown[]): void; // 由 HTML 裡的 <script> 載入的全域函式

console.log(`版本：${__APP_VERSION__}`); // ✅ 有型別，也不會報「找不到名稱 __APP_VERSION__」
gtag("event", "page_view");              // ✅ 參數會被檢查
```

編譯後的 `app.js`——兩行 `declare` 蒸發了，只剩下使用它們的程式碼：

```javascript
"use strict";
console.log(`版本：${__APP_VERSION__}`);
gtag("event", "page_view");
```

**沒有 `declare` 的話你只有兩個選擇**：忍受 `Cannot find name '__APP_VERSION__'` 的錯誤，或是寫個假的 `const __APP_VERSION__ = ""` ——但後者會真的編譯出一行 JS，把建置時注入的值蓋掉。`declare` 就是為了填這個缺口：**告知型別，但不干涉執行期**。

#### 三條規則

**1. 不能有實作，也不能有初始值**——因為實作本來就在別的地方：

```typescript
declare function f(): void {}   // ❌ TS1183: An implementation cannot be declared in ambient contexts.
declare const x: number = 5;    // ❌ TS1039: Initializers are not allowed in ambient contexts.

declare function g(): void;      // ✅ 只有簽章
declare const y: number;         // ✅ 只有型別
```

**2. TypeScript 不會驗證你講的是不是真的**——`declare` 跟 `as` 斷言一樣屬於「你自己負責」的承諾。如果那個東西執行期其實不存在，編譯期一片綠燈，執行期直接 `ReferenceError`：

```typescript
declare const totallyFake: string; // 編譯器照單全收
console.log(totallyFake);          // 💥 執行期 ReferenceError: totallyFake is not defined
```

**3. 純型別的東西不需要 `declare`**——`interface` 和 `type` 本來就不產生 JavaScript，加了也沒有任何效果：

```typescript
declare interface A { x: number } // ⚠️ declare 是多餘的
interface A2 { x: number }        // ✅ 一樣的效果
```

反過來說，在 `.d.ts` 檔案裡，頂層的 `const` / `function` / `class` **一定**要加 `declare`（或 `export`），否則會報 `TS1046: Top-level declarations in .d.ts files must start with either a 'declare' or 'export' modifier.`

#### `declare` 的常見形態

| 寫法 | 用來做什麼 | 說明位置 |
| --- | --- | --- |
| `declare const` / `declare function` / `declare class` | 描述由 `<script>`、CDN、打包工具注入的全域變數與函式 | 本節上方 |
| `declare module "套件名"` | 為沒有型別定義的 JS 套件補上型別 | 本節下方「為第三方函式庫新增型別」 |
| `declare global { ... }` | 在模組檔案裡擴充全域型別（`Window`、`Express.Request`…） | 第 4 章 4.4 宣告合併 |
| `declare namespace` | 描述舊式的全域命名空間（常見於 UMD 套件） | 8.4 命名空間 |

> 💡 課程後面的章節（例如第 7 章的 `declare function pick(x: string): string;`）還會看到另一種用途：**只想示範型別、不想寫沒意義的函式本體**時，用 `declare` 就能省掉實作。
>
> ⚠️ 反過來提醒：如果套件已經自帶型別、或裝了對應的 `@types/xxx`，就**不要**再自己 `declare` 一份，否則容易蓋掉正確的型別或造成衝突。

### 什麼是 .d.ts 檔案？

`.d.ts` 檔案只包含型別資訊，不包含實作——換句話說，它整個檔案就是一堆環境宣告的集合。用來為 JavaScript 函式庫提供型別定義。

#### 什麼時候才需要自己寫 .d.ts？

先講最重要的一件事，因為這是最常見的誤解：

> ⚠️ **你自己寫的 TypeScript 程式碼，完全不需要手寫 `.d.ts`。**

編譯器會自己產生。開啟 `declaration` 選項後，`.ts` 檔的型別宣告是自動輸出的：

```typescript
// mine.ts —— 你只要寫這個
export function double(x: number) {
  return x * 2;
}
```

```bash
npx tsc mine.ts --declaration --outDir out
```

```typescript
// out/mine.d.ts —— 編譯器自動生成，不用你動手
export declare function double(x: number): number;
```

手寫 `.d.ts` 只發生在一種情況：**有個東西在執行期存在，但 TypeScript 看不到它的原始碼**。以下是實務上會遇到的幾種，依「該不該自己動手」排序。

**情況 1：套件沒有型別（先別急著自己寫）**

匯入沒有型別的套件時，會看到這個錯誤——注意編譯器已經把兩個解法都寫在訊息裡了：

```text
error TS7016: Could not find a declaration file for module 'no-types'.
  '.../node_modules/no-types/index.js' implicitly has an 'any' type.
  Try `npm i --save-dev @types/no-types` if it exists
  or add a new declaration (.d.ts) file containing `declare module 'no-types';`
```

依序試這三步，**自己寫是最後手段**：

| 順序 | 做法 | 怎麼確認 |
| --- | --- | --- |
| 1️⃣ | 套件是不是**自帶**型別？ | 看 `node_modules/套件名/package.json` 有沒有 `types` / `typings` 欄位（例如 typescript 自己是 `"types": "./lib/typescript.d.ts"`）。有的話什麼都不用做 |
| 2️⃣ | DefinitelyTyped 上有沒有？ | 執行 `npm i -D @types/套件名`，裝得起來就結束了 |
| 3️⃣ | 兩者皆無 | 才輪到自己寫 |

真的要自己寫時，也**不必一次寫完整**——依你用到多少來決定：

```typescript
// typings/legacy-lib.d.ts

// 寫法 A：只想讓編譯過（整個模組變成 any，最省事但失去型別保護）
declare module "legacy-lib";

// 寫法 B：只宣告你實際用到的 API（最推薦，成本低又有型別）
declare module "legacy-lib" {
  export function format(value: string): string;
}
```

> 💡 寫法 A 只是把 `any` 合法化——用得到的地方沒有任何自動完成與檢查。適合暫時擋著，但別忘了留 TODO。

##### 檔名要跟模組同名嗎？TypeScript 怎麼找到它？

**檔名完全不重要。** 決定配對的是 `declare module "..."` 引號裡的字串，跟檔案叫什麼毫無關係——把上面那份存成 `zzz-random-name.d.ts` 一樣會生效：

```typescript
// typings/zzz-random-name.d.ts ← 檔名隨便取
declare module "legacy-lib" {
  //            ^^^^^^^^^^ 這個字串才是關鍵，要跟 import 的路徑逐字相符
  export function format(value: string): string;
}
```

```typescript
import { format } from "legacy-lib"; // ✅ 配對成功
```

真正決定「找不找得到」的是下面三件事：

**1. 這個檔案必須被納入編譯範圍**

這是最常見的失敗原因。`.d.ts` 不會因為放在專案裡就自動生效，它必須被 `tsconfig.json` 的 `include`（或 `files`）涵蓋到：

```json
{
  "compilerOptions": { "strict": true },
  "include": ["src", "typings"]
}
```

漏掉 `typings` 的話，錯誤訊息看起來會像「宣告根本不存在」，很難聯想到是設定問題：

```text
error TS7016: Could not find a declaration file for module 'legacy-lib'.
```

> ⚠️ **別用 `typeRoots` 來放這種檔案。** `typeRoots` 是控制「`@types/*` 這類全域型別包要自動載入哪些」的選項，跟「去哪裡找 `.d.ts`」是兩回事。它底下的每個項目都必須是**資料夾**（各自帶 `index.d.ts`），直接丟一個 `legacy-lib.d.ts` 進去完全不會生效。單一檔案一律用 `include` 收。詳見第 9 章 9.5。

**2. 這個檔案必須是「環境宣告檔」，不能是模組**

只要檔案裡出現**頂層**的 `import` 或 `export`，它就變成一個模組，此時 `declare module "legacy-lib"` 的意義會從「定義一個新模組」變成「**擴充一個既有模組**」，對無型別的套件反而會報錯：

```typescript
// ❌ 多了這一行，整個檔案變成模組
export {};

declare module "legacy-lib" {
  export function format(value: string): string;
}
// error TS2665: Invalid module name in augmentation. Module 'legacy-lib'
//               resolves to an untyped module ..., which cannot be augmented.
```

注意 `declare module` **區塊內部**的 `export` 不算頂層，是正常且必要的寫法。

（反過來說，第 4 章的 `declare global` 就**必須**寫在模組裡，所以那裡才要刻意加 `export {};`——兩者的要求剛好相反。）

**3. 模組名要「逐字相符」，而且子路徑要另外宣告**

大小寫不同、少一個字都配不上。子路徑（`legacy-lib/sub`）也被視為不同的模組，父模組的宣告不會涵蓋它：

```typescript
import { format } from "legacy-lib";
import { deep } from "legacy-lib/sub"; // ❌ 上面的宣告救不到這一行
```

兩種解法：

```typescript
// 解法一：子路徑各自宣告（有完整型別，推薦）
declare module "legacy-lib" {
  export function format(value: string): string;
}

declare module "legacy-lib/sub" {
  export const deep: number;
}
```

```typescript
// 解法二：用萬用字元一次涵蓋所有子路徑（內容是 any）
declare module "legacy-lib" {
  export function format(value: string): string;
}

declare module "legacy-lib/*";
```

> 💡 慣例上還是會把檔名取成 `legacy-lib.d.ts` 並放在 `typings/`——那是為了**你自己好找**，不是編譯器的要求。

**情況 2：非 JavaScript 的資源模組（前端專案最常見）**

`import logo from "./logo.svg"` 這種寫法能運作是打包工具的功勞，TypeScript 並不知道 `.svg` 是什麼，所以會直接報錯：

```text
error TS2307: Cannot find module './logo.svg' or its corresponding type declarations.
```

解法是宣告這些「模組」的型別：

```typescript
// typings/assets.d.ts
declare module "*.svg" {
  const content: string;
  export default content;
}

declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}
```

```typescript
import logo from "./logo.svg";        // ✅ string
import styles from "./app.module.css"; // ✅ Record<string, string>
```

##### 用 Vite / webpack 的話，需要自己補嗎？

**取決於工具**——差別很大，而且 Vite 需要一行設定才會生效：

| 工具 | 有附資源模組型別嗎 | 你要做什麼 |
| --- | --- | --- |
| **Vite** | ✅ 有，非常完整 | 只要**啟用** `vite/client`（見下方），不用自己寫 |
| **Nuxt** | ✅ 有（自動接上 `vite/client`） | 完全不用管，`nuxt prepare` 會處理 |
| **Astro** | ✅ 有，涵蓋範圍最廣（連 `*.md`、`*.mdx` 都有） | 不用管，但要跑過 `astro sync` |
| **Next.js** | ✅ 有（圖片類） | 自動產生 `next-env.d.ts`，不用管 |
| **CRA / react-scripts** | ✅ 有 | 樣板已含 `react-app.d.ts`，不用管 |
| **webpack**（自行配置） | ❌ 完全沒有 | 得自己寫 `assets.d.ts` |

**Vite：型別已經在套件裡，但要「啟用」**

Vite 的 `client.d.ts` 涵蓋了約 60 種模組樣式——圖片、影音、字型、CSS（含 CSS Modules）、`?raw`、`?url`、`?worker` 等 query 後綴，以及 `import.meta.env`：

```typescript
// node_modules/vite/client.d.ts（節錄）
declare module '*.svg' {
  const src: string
  export default src
}
```

但它**不會自動生效**，必須用下面任一種方式引入。兩種都試過，效果相同：

```json
// 方式一：tsconfig.json（較新的做法，推薦）
{
  "compilerOptions": {
    "types": ["vite/client"]
  }
}
```

```typescript
// 方式二：src/vite-env.d.ts —— create-vite 產生的樣板就是這樣
/// <reference types="vite/client" />
```

> ⚠️ 如果你用了方式一，記得 `types` 是**白名單**——一旦設定，其他 `@types/*` 就不再自動載入了，需要的要一起列進去（如 `"types": ["vite/client", "node"]`）。原因見第 9 章 9.5。

沒有引入時，以下四種寫法全部會報錯（實測）：

```typescript
import logo from "./logo.svg";         // ❌ TS2307
import styles from "./app.module.css"; // ❌ TS2307
import raw from "./data.txt?raw";      // ❌ TS2307
import.meta.env.MODE;                  // ❌ TS2339 Property 'env' does not exist
```

引入之後，四種全部有型別，**不需要自己寫任何宣告**。

**Nuxt：完全不用管，它幫你接好了**

Nuxt 底層就是 Vite，而且它會**自動把 `vite/client` 接進來**——不需要像純 Vite 專案那樣自己設定。`nuxt prepare`（或 `nuxt dev`）會產生 `.nuxt/` 目錄，引用鏈是這樣：

```text
.nuxt/tsconfig.app.json    include: ["./nuxt.d.ts", ...]
  └─ .nuxt/nuxt.d.ts       /// <reference path="types/builder-env.d.ts" />
       └─ .nuxt/types/builder-env.d.ts
            └─ import "vite/client";   ← 資源模組型別從這裡進來
```

```typescript
// .nuxt/types/builder-env.d.ts —— Nuxt 自動產生的內容就只有這一行
import "vite/client";
```

所以在 Nuxt 專案裡 `import logo from "~/assets/logo.svg"` 直接就有型別（`string`），不必自己寫任何宣告。

值得注意的是 Nuxt 產生的 tsconfig 裡 `"types": []`——它刻意關掉自動載入，改成用明確的 `/// <reference>` 逐一引入。這正好印證上面那個 ⚠️：`types` 是白名單，Nuxt 選擇完全自己掌控要載入什麼。

> 💡 因為型別檔在 `.nuxt/` 裡，**剛 clone 下來或刪掉 `.nuxt/` 後會突然一堆型別錯誤**。解法是跑 `npx nuxi prepare`（Nuxt 樣板通常已經放進 `postinstall`）。型別檢查則用 `npx nuxi typecheck`，它會用 `.nuxt/` 底下的 tsconfig，而不是專案根目錄的（Nuxt 專案通常根本沒有根目錄 tsconfig）。

**Astro：涵蓋最廣，但一定要先跑 `astro sync`**

Astro 的 `client.d.ts` 是這幾個工具裡涵蓋最完整的——除了圖片、影音、字型、CSS、`?raw` / `?url` / `?worker` 之外，連 **Markdown（`*.md`、`*.mdx`）和 `*.html`** 都有宣告。

啟用方式跟 Nuxt 類似，靠建置流程產生的檔案接上：

```text
tsconfig.json          { "extends": "astro/tsconfigs/strict" }
  └─ base.json         include: ["${configDir}/.astro/types.d.ts", ...]
       └─ .astro/types.d.ts        ← astro sync 產生
            └─ /// <reference types="astro/client" />
```

```typescript
// .astro/types.d.ts —— astro sync 產生的內容
/// <reference types="astro/client" />
/// <reference path="content.d.ts" />
```

所以只要 `tsconfig.json` 繼承官方樣板（`astro/tsconfigs/base` / `strict` / `strictest`），資源模組就都有型別了。**但 `.astro/` 是產生出來的**，剛 clone 或清掉之後會一次冒出一堆錯誤：

```text
error TS2307: Cannot find module './assets/logo.svg' or its corresponding type declarations.
error TS2307: Cannot find module './assets/data.txt?raw' or its corresponding type declarations.
error TS2339: Property 'env' does not exist on type 'ImportMeta'.
```

解法是 `npx astro sync`（`astro dev` / `astro build` 也會自動跑）。型別檢查用 `npx astro check`，它額外處理 `.astro` 檔案——注意 **`.astro` 檔沒有 `declare module "*.astro"` 這種宣告**，是由 Astro 的語言伺服器處理的，所以純 `tsc` 檢查不到 `.astro` 檔內部。

> ⚠️ **Astro 的 `*.svg` 型別跟 Vite 不一樣**，遷移或參考別人程式碼時容易踩到：
>
> ```typescript
> // Vite：SVG 是 URL 字串
> declare module '*.svg' {
>   const src: string
>   export default src
> }
>
> // Astro 6：SVG 是可以直接渲染的元件（同時帶 ImageMetadata 的 width / height 等欄位）
> declare module '*.svg' {
>   const Component: import('./types').SvgComponent & ImageMetadata;
>   export default Component;
> }
> ```
>
> 所以在 Astro 裡 `import Logo from "./logo.svg"` 之後可以直接 `<Logo />`，也可以讀 `Logo.width`；把 Vite 專案的程式碼複製過來（假設它是 `string`）就會型別錯誤。

> 💡 順帶一提，Astro 官方 tsconfig 樣板預設就開了 `verbatimModuleSyntax` 和 `isolatedModules`（見 9.9 與 9.6）——這也印證了前面說的：用 esbuild／單檔轉譯的工具鏈幾乎都會要求這兩個選項。

**webpack：真的要自己寫**

webpack 的 `types.d.ts` 只有它自己的 API 型別（`Configuration`、`Compiler` 等），**沒有任何資源模組宣告**。常被誤以為能解決的 `@types/webpack-env` 也不行——它涵蓋的是 `__webpack_require__`、`module.hot`、`require.context` 這類 webpack 執行期 API，同樣沒有 `*.svg`：

```bash
# 這個不會幫你解決資源模組的型別
npm i -D @types/webpack-env
```

所以用 webpack（或 Rollup、esbuild 直接配置）時，上面那份 `typings/assets.d.ts` 就得自己維護。

**Next.js：完全不用管**

`next dev` 會自動產生 / 維護 `next-env.d.ts`，裡面參照了 Next 內建的宣告。值得一提的是它對 `svg` 的處理方式：

```typescript
// node_modules/next/image-types/global.d.ts（節錄）
declare module '*.svg' {
  /**
   * Use `any` to avoid conflicts with
   * `@svgr/webpack` plugin or
   * `babel-plugin-inline-react-svg` plugin.
   */
  const content: any
  export default content
}
```

刻意用 `any`，是為了不跟 SVGR 這類「把 SVG 變成 React 元件」的外掛衝突——這也提示了一個常見情況：**如果你裝了 SVGR，`*.svg` 的型別就不該是 `string` 而是元件**，這時即使用 Vite 也需要自己覆寫宣告：

```typescript
// typings/svgr.d.ts —— 搭配 vite-plugin-svgr 時
declare module "*.svg?react" {
  import type { FunctionComponent, SVGProps } from "react";
  const ReactComponent: FunctionComponent<SVGProps<SVGSVGElement>>;
  export default ReactComponent;
}
```

##### 小結

**先看你的工具有沒有附**——`node_modules/<工具>/` 底下找找 `client.d.ts`、`*-env.d.ts` 這類檔案，或直接看框架的建置流程產生了什麼（Nuxt 是 `.nuxt/`、Astro 是 `.astro/`、Next.js 是 `next-env.d.ts`）。有就啟用它，沒有才自己寫。

真正**一定得自己寫**的只有兩種情況：

1. 工具沒附（自行配置的 webpack、Rollup、esbuild）
2. 你用外掛改變了資源的匯入形式（SVGR、`?react`、自訂 loader）——這時工具附的宣告反而是錯的，要自己覆寫

框架（Nuxt / Astro / Next.js / CRA）幾乎都幫你處理好了，這也是用框架樣板的好處之一。但要記住**「產生型」框架的共同陷阱**：Nuxt 的 `.nuxt/`、Astro 的 `.astro/` 都是**建置時產生**的，不會進版控。剛 clone 專案或清過快取後看到一堆 `TS2307`，第一件事是跑對應的 prepare 指令，而不是懷疑自己的程式碼：

| 框架 | 產生型別的指令 | 型別檢查指令 |
| --- | --- | --- |
| Nuxt | `npx nuxi prepare` | `npx nuxi typecheck` |
| Astro | `npx astro sync` | `npx astro check` |
| Next.js | `next dev` / `next build`（自動維護 `next-env.d.ts`） | `npx tsc --noEmit` |

**情況 3：全域變數與環境變數**

由 `<script>`、CDN、打包工具注入的東西，只存在於執行期，得自己告訴 TypeScript：

```typescript
// typings/env.d.ts
export {}; // 讓這個檔案成為模組，declare global 才能使用

declare global {
  // 掛在 window 上的東西
  interface Window {
    __APP_VERSION__: string;
  }

  // 專案自訂的環境變數（需要 @types/node）
  namespace NodeJS {
    interface ProcessEnv {
      API_URL: string;
      NODE_ENV: "development" | "production";
    }
  }
}
```

```typescript
const v: string = window.__APP_VERSION__;               // ✅ 有型別
const env: "development" | "production" = process.env.NODE_ENV; // ✅ 不再是 string | undefined
```

**情況 4：替既有型別補東西**

第三方套件的型別存在、但缺了你需要的欄位（例如替 Express 的 `Request` 加上 `user`）。這是模組擴充，見第 4 章 4.4 的宣告合併。

#### 一句話判斷

**問自己：「這個東西的原始碼，TypeScript 讀得到嗎？」**

- 讀得到（你自己的 `.ts`）→ 不用寫，編譯器自動產生
- 讀不到，但別人已經描述過了（套件自帶型別、`@types/*`）→ 裝起來就好
- 讀不到，也沒人描述過（無型別套件、`.svg`、全域變數）→ 這時才自己寫

> ⚠️ 再次提醒：不要對「已經有型別」的套件自己寫一份，會蓋掉正確的型別或造成衝突。

```typescript
// types.d.ts
interface AppConfig {
  // interface 是純型別，不需要 declare（寫了也只是多餘）
  apiUrl: string;
  port: number;
  debug: boolean;
}

// const 與 function 會對應到執行期的實體，在 .d.ts 頂層一定要加 declare（或 export）
declare function initialize(config: AppConfig): void;

declare const VERSION: string;
```

### 為第三方函式庫新增型別

```typescript
// 如果某個 JS 函式庫沒有型別定義
// 建立 typings/my-lib.d.ts

declare module "my-lib" {
  export function doSomething(value: string): number;
  export function doAnother(value: number): string;

  export interface MyLibOptions {
    verbose: boolean;
    timeout: number;
  }

  export default class MyLib {
    constructor(options?: MyLibOptions);
    run(): void;
  }
}
```

### @types 套件

```bash
# 許多流行函式庫的型別定義都在 @types 組織下
npm install --save-dev @types/node
npm install --save-dev @types/lodash
npm install --save-dev @types/express

# 安裝後 TypeScript 會自動載入這些型別
```

---

## 8.4 命名空間（Namespace）

> ⚠️ 現代 TypeScript 開發中，**推薦使用 ES Modules 取代 Namespace**。Namespace 主要用於舊專案或全域宣告。

```typescript
// 定義命名空間
namespace Validation {
  export interface Validator {
    isValid(value: string): boolean;
  }

  export class EmailValidator implements Validator {
    isValid(value: string): boolean {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    }
  }

  export class PhoneValidator implements Validator {
    isValid(value: string): boolean {
      return /^\d{10}$/.test(value);
    }
  }
}

// 使用
const emailValidator = new Validation.EmailValidator();
console.log(emailValidator.isValid("gary@example.com")); // true
```

### Namespace vs Module

```
Namespace:
  - 全域作用域
  - 適合簡單的程式碼組織
  - 不需要模組載入器
  - ⚠️ 不推薦用於新專案

Module (ES Modules):
  - 檔案作用域
  - 標準化的模組系統
  - 支援 tree-shaking
  - ✅ 推薦用於所有新專案
```

---

## 8.5 路徑別名（Path Aliases）

### tsconfig.json 設定

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"],
      "@components/*": ["src/components/*"],
      "@utils/*": ["src/utils/*"],
      "@models/*": ["src/models/*"],
      "@services/*": ["src/services/*"]
    }
  }
}
```

> ⚠️ 避免把自訂別名取名為 `@types/*`——這跟上一節安裝第三方型別套件用的 npm `@types` scope（如 `@types/node`）長得一模一樣，但意義完全不同（一個是你專案的路徑別名，一個是 npm 組織名稱），很容易讓人混淆。這裡改用 `@models/*` 代表 `src/models/*` 目錄下的資料模型型別。

### 使用路徑別名

```typescript
// 不使用路徑別名
import { User } from "../../../types/user";
import { formatDate } from "../../utils/date";

// 使用路徑別名
import { User } from "@models/user";
import { formatDate } from "@utils/date";
import Header from "@components/Header";
```

> 💡 注意：路徑別名只在 TypeScript 編譯器層面生效。如果你使用 Webpack、Vite 或其他打包工具，需要在對應的設定中也配置相同的別名。

---

## 8.6 模組組織最佳實踐

### 目錄結構

```
src/
├── types/           # 型別定義
│   ├── user.ts
│   ├── product.ts
│   └── index.ts     # barrel file
├── services/        # 業務邏輯
│   ├── user.service.ts
│   ├── product.service.ts
│   └── index.ts
├── utils/           # 工具函式
│   ├── date.ts
│   ├── format.ts
│   └── index.ts
└── index.ts         # 進入點
```

### Barrel File 模式

```typescript
// types/index.ts
export type { User, CreateUserDto, UpdateUserDto } from "./user";
export type { Product, CreateProductDto } from "./product";
export type { Order, OrderItem } from "./order";

// 在其他地方只需要一個 import
import type { User, Product, Order } from "@/types";
```

### 循環依賴的處理

```typescript
// ❌ 循環依賴
// user.ts imports from order.ts
// order.ts imports from user.ts

// ✅ 解決方式一：提取共用型別到獨立檔案
// types/shared.ts
export interface BaseEntity {
  id: number;
  createdAt: Date;
}

// ✅ 解決方式二：使用 import type
import type { Order } from "./order"; // 型別匯入不會造成循環
```

---

## 練習題

### 練習 1：模組設計

為一個部落格系統設計模組結構，包含：
- 型別定義（User, Post, Comment）
- 服務層（UserService, PostService）
- 工具函式（formatDate, slugify）
- Barrel file 統一匯出

<details>
<summary>參考解答</summary>

依「型別 / 服務 / 工具」三層拆分目錄，每層各放一個 `index.ts` 當 barrel file 統一對外匯出；型別用 `import type`／`export type` 匯入匯出，避免產生多餘的執行期程式碼與循環依賴。這是一個**多檔案**的結構示範（分屬不同檔案，不是單一可編譯片段）。

目錄結構：

```
src/
├── types/
│   ├── user.ts
│   ├── post.ts
│   ├── comment.ts
│   └── index.ts       # barrel file
├── services/
│   ├── user.service.ts
│   ├── post.service.ts
│   └── index.ts       # barrel file
├── utils/
│   ├── date.ts
│   ├── slug.ts
│   └── index.ts       # barrel file
└── index.ts           # 專案進入點
```

型別定義：

```typescript
// src/types/user.ts
export interface User {
  id: number;
  name: string;
  email: string;
}

// src/types/post.ts
export interface Post {
  id: number;
  authorId: number;
  title: string;
  slug: string;
  content: string;
  createdAt: Date;
}

// src/types/comment.ts
export interface Comment {
  id: number;
  postId: number;
  authorId: number;
  content: string;
  createdAt: Date;
}

// src/types/index.ts —— barrel file，只匯出型別
export type { User } from "./user";
export type { Post } from "./post";
export type { Comment } from "./comment";
```

工具函式：

```typescript
// src/utils/date.ts
export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

// src/utils/slug.ts
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

// src/utils/index.ts —— barrel file
export { formatDate } from "./date";
export { slugify } from "./slug";
```

服務層（用 `import type` 匯入型別，用一般 import 匯入工具函式）：

```typescript
// src/services/user.service.ts
import type { User } from "../types";

export class UserService {
  private users: User[] = [];

  add(user: User): void {
    this.users.push(user);
  }

  findById(id: number): User | undefined {
    return this.users.find((u) => u.id === id);
  }
}

// src/services/post.service.ts
import type { Post } from "../types";
import { slugify } from "../utils";

export class PostService {
  private posts: Post[] = [];

  create(authorId: number, title: string, content: string): Post {
    const post: Post = {
      id: Date.now(),
      authorId,
      title,
      slug: slugify(title),
      content,
      createdAt: new Date(),
    };
    this.posts.push(post);
    return post;
  }
}

// src/services/index.ts —— barrel file
export { UserService } from "./user.service";
export { PostService } from "./post.service";
```

進入點只需要從各層 barrel file 匯入：

```typescript
// src/index.ts
import type { User, Post } from "./types";
import { UserService, PostService } from "./services";
import { formatDate } from "./utils";

const userService = new UserService();
const postService = new PostService();

const author: User = { id: 1, name: "Gary", email: "gary@example.com" };
userService.add(author);

const post: Post = postService.create(author.id, "Hello TypeScript", "內文…");
console.log(`${post.slug} @ ${formatDate(post.createdAt)}`);
```

重點提醒：型別一律走 `export type` / `import type`，編譯後會被完全移除、也不會造成循環依賴；barrel file 讓外部只需 `import { ... } from "./services"` 一行就取用整層模組，是模組組織的常見手法。缺點是 barrel file 可能拖累 tree-shaking，大型專案要斟酌是否每一層都建。

</details>

### 練習 2：型別宣告

為一個假想的 JavaScript 函式庫 `simple-math` 撰寫 `.d.ts` 型別宣告。

<details>
<summary>參考解答</summary>

用 `declare module "simple-math"` 為這個沒有型別的 JS 套件補上型別：裡面用 `export` 宣告函式、常數、介面與預設匯出的 class，只描述「型別長相」而不寫實作。把它存成專案裡的 `typings/simple-math.d.ts`，TypeScript 就會在 `import ... from "simple-math"` 時套用這份型別。

```typescript
// typings/simple-math.d.ts
declare module "simple-math" {
  export interface RoundOptions {
    precision?: number;
  }

  export function add(a: number, b: number): number;
  export function subtract(a: number, b: number): number;
  export function multiply(a: number, b: number): number;
  export function divide(a: number, b: number): number;
  export function round(value: number, options?: RoundOptions): number;

  export const PI: number;
  export const E: number;

  // 預設匯出：一個可鏈式呼叫的計算機 class
  export default class Calculator {
    constructor(initial?: number);
    value: number;
    add(n: number): this;
    subtract(n: number): this;
    result(): number;
  }
}
```

消費端就能享有完整型別檢查與自動完成：

```typescript
// main.ts
import Calculator, { add, round, PI, type RoundOptions } from "simple-math";

const sum: number = add(1, 2);
const opts: RoundOptions = { precision: 2 };
const rounded: number = round(3.14159, opts);

const total: number = new Calculator(10).add(5).subtract(3).result();
console.log(sum, rounded, PI, total);
```

重點提醒：這是**多檔案**示範——`declare module` 一定要放在「沒有頂層 `import` / `export` 的環境宣告檔（.d.ts）」裡，它才會被當成「為某個模組補型別」；如果把它寫進一個本身已經是模組的檔案（檔案內有其他 import/export），`declare module "simple-math"` 反而會被解讀成「模組擴增（augmentation）」而報 `module ... cannot be found`。另外要確保這個 `typings/simple-math.d.ts` 有被 `tsconfig.json` 的 `include`（或 `files`）涵蓋到——這一點與上面 8.3〈檔名要跟模組同名嗎〉說明的規則相同（不要改用 `typeRoots`，原因見 8.3 的提醒與第 9 章 9.5）。

</details>

### 練習 3：路徑別名

設定 tsconfig.json 的路徑別名，並重構一個有深層相對路徑的專案。

<details>
<summary>參考解答</summary>

先在 `tsconfig.json` 用 `baseUrl` + `paths` 定義別名，把常用目錄對應到簡短前綴，再把原本一長串的 `../../../` 相對路徑改寫成別名。以下的 tsconfig 是完整設定片段，import 改寫則是對照示範。

`tsconfig.json` 設定：

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"],
      "@components/*": ["src/components/*"],
      "@models/*": ["src/models/*"],
      "@services/*": ["src/services/*"],
      "@utils/*": ["src/utils/*"]
    }
  }
}
```

重構前（深層相對路徑，難讀又容易在搬移檔案時斷掉）：

```typescript
// src/features/dashboard/widgets/UserCard.tsx
import { User } from "../../../models/user";
import { formatDate } from "../../../../utils/date";
import { UserService } from "../../../services/user.service";
```

重構後（用別名，路徑與檔案所在深度無關）：

```typescript
// src/features/dashboard/widgets/UserCard.tsx
import type { User } from "@models/user";
import { formatDate } from "@utils/date";
import { UserService } from "@services/user.service";
```

重點提醒：`paths` 只在 **TypeScript 編譯器層面** 解析型別，實際打包／執行時還要讓對應工具知道相同別名——Vite/Webpack 需在各自設定裡同步一份 `resolve.alias`，用 `tsc` 直接輸出到 Node 執行時則要搭配 `tsc-alias` 之類的工具改寫路徑，否則執行期會找不到模組。另外別名建議避開 `@types/*`（容易和 npm 的 `@types` scope 混淆），本例改用 `@models/*` 表示 `src/models/*`。

</details>

---

> 下一章：[第九章 — tsconfig.json 設定完全指南](./09-tsconfig.md)
