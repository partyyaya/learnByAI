// @ts-nocheck
// ============================================================
// 第 8 章：模組系統與命名空間 — 範例整理（閱讀參考檔）
// 來源：typescript/08-modules.md
// 說明：第 8 章示範模組匯入/匯出、路徑別名（@/、@utils/…）與命名空間。
//       這些依賴專案結構與 tsconfig paths，無法在此單檔環境解析，
//       故本檔以 @ts-nocheck 作為閱讀參考，不納入型別檢查。
// ============================================================

// ===== 8.1 ES Modules — 匯出（Export）：user.ts =====
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

// ===== 8.1 ES Modules — 匯入（Import）：main.ts =====
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

// ===== 8.1 ES Modules — 重新匯出（Re-export）：index.ts（barrel file）=====
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

// ===== 8.1 ES Modules — 動態匯入（Dynamic import()）與頂層 await =====

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

// 頂層 await（需要 target: ES2022 + module: ESNext/NodeNext，本 demo 的 tsconfig 剛好符合）
const topLevelMod = await import("./user");
const topLevelGary = topLevelMod.createUser("Gary", "gary@example.com");
console.log(`已載入使用者：${topLevelGary.name}`);

// ===== 8.2 import type — 型別匯入 =====
// ✅ 明確的型別匯入（推薦）
import type { User, Product } from "./types";
import { createUser, createProduct } from "./services";

// 混合匯入
import { createUser, type User } from "./user";

// 為什麼要用 import type？
// 1. 型別匯入在編譯後會被完全移除，不產生 JavaScript 程式碼
// 2. 避免循環依賴問題
// 3. 讓程式碼意圖更清晰

// ===== 8.3 型別宣告檔案（.d.ts）：types.d.ts =====
// types.d.ts
declare interface AppConfig {
  apiUrl: string;
  port: number;
  debug: boolean;
}

declare function initialize(config: AppConfig): void;

declare const VERSION: string;

// ===== 8.3 型別宣告檔案（.d.ts）— 為第三方函式庫新增型別 =====
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

// ===== 8.4 命名空間（Namespace）=====
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

// ===== 8.5 路徑別名（Path Aliases）— 使用路徑別名 =====
// 不使用路徑別名
import { User } from "../../../types/user";
import { formatDate } from "../../utils/date";

// 使用路徑別名
import { User } from "@models/user";
import { formatDate } from "@utils/date";
import Header from "@components/Header";

// ===== 8.6 模組組織最佳實踐 — Barrel File 模式 =====
// types/index.ts
export type { User, CreateUserDto, UpdateUserDto } from "./user";
export type { Product, CreateProductDto } from "./product";
export type { Order, OrderItem } from "./order";

// 在其他地方只需要一個 import
import type { User, Product, Order } from "@/types";

// ===== 8.6 模組組織最佳實踐 — 循環依賴的處理 =====
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

console.log("第 8 章 模組系統與命名空間 範例載入完成 ✅（參考用,已 @ts-nocheck）");
