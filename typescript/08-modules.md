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

> 📌 `verbatimModuleSyntax` 完整說明（含它取代的舊選項）見第 9 章 9.9。

---

## 8.3 型別宣告檔案（.d.ts）

### 什麼是 .d.ts 檔案？

`.d.ts` 檔案只包含型別資訊，不包含實作。用來為 JavaScript 函式庫提供型別定義。

```typescript
// types.d.ts
declare interface AppConfig {
  apiUrl: string;
  port: number;
  debug: boolean;
}

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

### 練習 2：型別宣告

為一個假想的 JavaScript 函式庫 `simple-math` 撰寫 `.d.ts` 型別宣告。

### 練習 3：路徑別名

設定 tsconfig.json 的路徑別名，並重構一個有深層相對路徑的專案。

---

> 下一章：[第九章 — tsconfig.json 設定完全指南](./09-tsconfig.md)
