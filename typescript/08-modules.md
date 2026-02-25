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
      "@types/*": ["src/types/*"],
      "@services/*": ["src/services/*"]
    }
  }
}
```

### 使用路徑別名

```typescript
// 不使用路徑別名
import { User } from "../../../types/user";
import { formatDate } from "../../utils/date";

// 使用路徑別名
import { User } from "@types/user";
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
