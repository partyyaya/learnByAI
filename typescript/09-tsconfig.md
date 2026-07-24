# 第九章：tsconfig.json 設定完全指南

## 9.1 tsconfig.json 概覽

`tsconfig.json` 是 TypeScript 專案的設定檔，定義了編譯器的行為和專案結構。

### 建立 tsconfig.json

```bash
# 自動產生含有所有選項說明的 tsconfig.json
npx tsc --init
```

### 基本結構

```json
{
  "compilerOptions": {
    // 編譯器選項
  },
  "include": [],
  "exclude": [],
  "extends": "",
  "references": []
}
```

---

## 9.2 核心編譯選項

### 目標版本（target）

```json
{
  "compilerOptions": {
    // 指定編譯輸出的 JavaScript 版本
    "target": "ES2020"
    // 常用值：ES5, ES6/ES2015, ES2016, ES2017, ES2018, ES2019, ES2020, ES2021, ES2022, ESNext
  }
}
```

```typescript
// 原始碼
const greet = (name: string) => `Hello, ${name}`;

// target: ES5 — 箭頭函式會被轉換
var greet = function (name) { return "Hello, " + name; };

// target: ES2020 — 保持原樣
const greet = (name) => `Hello, ${name}`;
```

### 模組系統（module）

```json
{
  "compilerOptions": {
    "module": "ESNext"
    // 常用值：CommonJS, ES6/ES2015, ES2020, ES2022, ESNext, NodeNext
  }
}
```

| 值 | 使用場景 |
|----|---------|
| `CommonJS` | Node.js 傳統專案 |
| `ES2020` / `ESNext` | 前端框架、現代瀏覽器 |
| `NodeNext` | Node.js 16+ 原生 ESM |

### 模組解析（moduleResolution）

```json
{
  "compilerOptions": {
    "moduleResolution": "bundler"
    // 常用值：node, node16, nodenext, bundler
  }
}
```

| 值 | 適用場景 |
|----|---------|
| `node` | 傳統 Node.js（CommonJS） |
| `node16` / `nodenext` | Node.js ESM |
| `bundler` | Vite / Webpack / esbuild 等打包工具 |

---

## 9.3 嚴格模式選項

```json
{
  "compilerOptions": {
    // 開啟所有嚴格檢查（推薦）
    "strict": true

    // 或個別開啟：
    // "noImplicitAny": true,            // 禁止隱含 any
    // "strictNullChecks": true,          // 嚴格 null 檢查
    // "strictFunctionTypes": true,       // 嚴格函式型別
    // "strictBindCallApply": true,       // 嚴格 bind/call/apply
    // "strictPropertyInitialization": true, // 類別屬性必須初始化
    // "noImplicitThis": true,            // 禁止隱含 this
    // "alwaysStrict": true,              // 輸出 "use strict"
    // "useUnknownInCatchVariables": true  // catch 變數為 unknown
  }
}
```

> ⚠️ **`strict: true` 不等於「全部嚴格選項」**：上面這些才是 `strict: true` 實際包含的旗標。像 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noImplicitOverride` 這幾個常見的嚴格旗標**都不包含在 `strict` 裡**，必須額外手動開啟——不要以為開了 `strict` 就萬無一失，詳見下方「不包含在 strict 內的常用嚴格旗標」。

### 嚴格模式差異範例

```typescript
// noImplicitAny: true
function greet(name) {} // ❌ 參數 name 隱含 any 型別
function greet(name: string) {} // ✅

// strictNullChecks: true
let name: string = null; // ❌ null 不能賦值給 string
let name: string | null = null; // ✅

// strictPropertyInitialization: true
class User {
  name: string; // ❌ 未在建構子中初始化
  name: string = ""; // ✅ 給預設值
  name!: string; // ✅ 明確斷言會在其他地方初始化
}
```

> 💡 **強烈建議**：新專案一律開啟 `"strict": true`。

### 不包含在 strict 內的常用嚴格旗標

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true, // 索引存取（arr[i]、record[key]）的結果多包一層 undefined
    "exactOptionalPropertyTypes": true, // 可選屬性不可明確賦值 undefined，須與「完全沒有這個屬性」區分
    "noImplicitOverride": true // 覆寫父類別方法時，強制寫出 override 關鍵字
  }
}
```

```typescript
// noUncheckedIndexedAccess: true
const scores: number[] = [90, 85];
const first = scores[0]; // 沒開啟時型別是 number；開啟後型別是 number | undefined，逼你先檢查再用
```

> 💡 **`noUncheckedIndexedAccess`** 是目前實務上最常被推薦、但預設沒開啟的嚴格旗標之一：它讓陣列與物件的索引存取結果多一層 `| undefined`，避免「明明陣列存取卻在執行期噴 undefined」的常見錯誤。由於它會讓既有程式碼多出不少檢查，建議新專案從一開始就開啟，既有專案則可以評估後再逐步導入。

---

## 9.4 輸出選項

```json
{
  "compilerOptions": {
    "outDir": "./dist",           // 輸出目錄
    "rootDir": "./src",           // 原始碼根目錄
    "declaration": true,          // 產生 .d.ts 型別宣告檔
    "declarationMap": true,       // 產生 .d.ts.map
    "sourceMap": true,            // 產生 .js.map（偵錯用）
    "removeComments": true,       // 移除註解
    "noEmit": true,               // 不產生輸出（搭配 bundler 時使用）
    "emitDeclarationOnly": true   // 只產生 .d.ts（搭配 bundler）
  }
}
```

### noEmit vs emitDeclarationOnly

```
使用 Vite / Webpack 等打包工具時：
  "noEmit": true
  → TypeScript 只負責型別檢查，打包交給 bundler

開發函式庫時：
  "emitDeclarationOnly": true
  → 只輸出 .d.ts，JS 由其他工具產生

傳統 Node.js 專案：
  "outDir": "./dist"
  → TypeScript 負責完整的編譯輸出
```

---

## 9.5 路徑與檔案

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"],
      "@components/*": ["src/components/*"],
      "@utils/*": ["src/utils/*"]
    },
    "typeRoots": ["./node_modules/@types", "./src/types"],
    "types": ["node", "jest"]
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

### include / exclude / files

```json
{
  // 指定要編譯的檔案（glob 模式）
  "include": [
    "src/**/*.ts",
    "src/**/*.tsx"
  ],

  // 排除的檔案
  "exclude": [
    "node_modules",
    "dist",
    "**/*.spec.ts",
    "**/*.test.ts"
  ],

  // 明確指定檔案列表（優先於 include/exclude）
  "files": [
    "src/index.ts",
    "src/global.d.ts"
  ]
}
```

---

## 9.6 常見專案設定範本

下面的範本會重複用到幾個選項，先簡單說明它們的作用與取捨：

| 選項 | 作用與取捨 |
|------|-----------|
| `esModuleInterop` | 讓 `import x from "cjs-module"` 這種預設匯入語法，也能套用在沒有真正 `default` 匯出的 CommonJS 模組上（詳見第 8 章「與 CommonJS 互通」）。實務上新專案幾乎都會開啟。 |
| `skipLibCheck` | 跳過所有 `.d.ts`（含 `node_modules` 內的型別定義檔）的型別檢查。能大幅加快編譯速度，代價是可能「蓋住」不同套件之間互相衝突的型別問題（例如兩個套件對同一個全域型別的宣告有衝突，不會被抓出來）。 |
| `isolatedModules` | 要求每個檔案都能「被單獨轉譯」，不依賴跨檔案的型別資訊。這是 esbuild、swc、Babel 等單檔案轉譯器（一次只看一個檔案，不做完整型別分析）的必要條件，會限制某些重新匯出（如 `export { Type }` 需搭配 `export type`）與 `const enum` 的用法。 |
| `composite` | 啟用 Project References（見 9.8），讓這個專案可以被其他專案用 `references` 引用。開啟後會強制要求 `declaration: true`，且輸出設定（如 `rootDir`）要更嚴謹，換取增量建置（`tsc --build`）的效能。 |

### Node.js 後端專案

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

### 前端專案（搭配 Vite）

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"],
  "exclude": ["node_modules"]
}
```

### 函式庫（Library）專案

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2020"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

---

## 9.7 繼承設定（extends）

```json
// tsconfig.base.json — 共用基礎設定
{
  "compilerOptions": {
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}

// tsconfig.json — 繼承並覆寫
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "outDir": "./dist"
  },
  "include": ["src/**/*.ts"]
}
```

### 使用官方推薦設定

```bash
# 安裝官方推薦的 tsconfig 基礎設定
npm install --save-dev @tsconfig/recommended
npm install --save-dev @tsconfig/node20
npm install --save-dev @tsconfig/strictest
```

```json
{
  "extends": "@tsconfig/node20/tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist"
  },
  "include": ["src"]
}
```

---

## 9.8 Project References（多專案設定）

適用於 monorepo 或大型專案。

```json
// tsconfig.json（根目錄）
{
  "references": [
    { "path": "./packages/core" },
    { "path": "./packages/ui" },
    { "path": "./packages/api" }
  ],
  "files": []
}

// packages/core/tsconfig.json
{
  "compilerOptions": {
    "composite": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src"]
}

// packages/ui/tsconfig.json
{
  "compilerOptions": {
    "composite": true,
    "outDir": "./dist"
  },
  "references": [
    { "path": "../core" }
  ],
  "include": ["src"]
}
```

```bash
# 建置所有 references
npx tsc --build

# 清除建置結果
npx tsc --build --clean
```

---

## 9.9 verbatimModuleSyntax、moduleDetection 與 isolatedDeclarations

TypeScript 5.0 之後新增了幾個與模組語法／宣告檔輸出有關的選項。第 8 章曾提過 `verbatimModuleSyntax`，這裡完整說明它與另外兩個相關選項。

### verbatimModuleSyntax（TS 5.0+）

```json
{
  "compilerOptions": {
    "verbatimModuleSyntax": true
  }
}
```

開啟後：

- 型別匯入／匯出**必須**明確寫 `import type` / `export type`，混合匯入要加上 `type` 修飾字（如 `import { createUser, type User } from "./user"`），否則會編譯錯誤。
- 匯入的程式碼會「逐字（verbatim）」保留到輸出檔案——TypeScript 不會自動幫你判斷某個匯入只用到型別而悄悄把它移除；你寫什麼就輸出什麼。
- 取代了舊版的 `importsNotUsedAsValues` 與 `preserveValueImports` 兩個選項，效果上也和 `isolatedModules` 大致相容，是目前推薦的統一設定（見第 8 章 8.2）。

### moduleDetection

```json
{
  "compilerOptions": {
    "moduleDetection": "force" // 常用值："auto"（預設）、"legacy"、"force"
  }
}
```

控制 TypeScript 如何判斷一個檔案是「模組」還是「全域指令碼」：

- `"auto"`（預設）：檔案只要有 `import` / `export` 就視為模組；在 `module: nodenext` 下也會參考 `package.json` 的 `type` 欄位判斷。
- `"force"`：把**所有**檔案都當成模組處理，即使檔案裡完全沒有 `import` / `export`。適合已知專案內所有檔案都應該是模組，但有些檔案暫時還沒寫任何 import/export（例如只放型別宣告）的情況，避免它們被誤判為全域腳本、彼此汙染全域變數。

### isolatedDeclarations（TS 5.5+）

```json
{
  "compilerOptions": {
    "isolatedDeclarations": true, // 需要 TypeScript 5.5 以上
    "declaration": true
  }
}
```

> ⚠️ **版本注意**：`isolatedDeclarations` 是 TypeScript **5.5** 才新增的選項，若專案鎖定在更早的版本會被 `tsc` 回報無法識別。本課程 demo 的 `package.json` 雖然寫的是 `typescript: ^5.4.0`，但 `^` 代表「允許安裝 5.4.0 以上、6.0.0 以下的任何版本」——實際安裝進 `node_modules` 的版本以 `package-lock.json` 鎖定的為準，通常會是符合範圍的最新版（執行 `npx tsc -v` 可確認實際版本），所以不一定需要手動升級才能在 demo 環境試用這個選項；只有當專案明確把版本鎖死在 5.4.x（例如用 `"typescript": "5.4.0"` 不加 `^`）時，才需要真的升級。

開啟後，TypeScript 會要求每個匯出的宣告（函式、類別、變數等）都有**足夠的顯式型別標註**，讓編譯器不需要做跨檔案的型別推論就能單獨產生該檔案的 `.d.ts`。這與 `isolatedModules` 的精神類似（每個檔案都能被獨立處理），但這次是針對「宣告檔輸出」——目的是讓 esbuild、swc 這類單檔案工具也能快速產生型別宣告檔，不必依賴完整的 TypeScript 型別檢查器。

```typescript
// isolatedDeclarations: true
// ❌ 缺少回傳型別標註，無法單獨推導出宣告檔
export function double(x: number) {
  return x * 2;
}
```

```typescript
// isolatedDeclarations: true
// ✅ 顯式標註回傳型別
export function double(x: number): number {
  return x * 2;
}
```

---

## 練習題

### 練習 1：設定分析

分析以下設定，說明每個選項的作用：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM"]
  }
}
```

### 練習 2：設定遷移

將一個 `"strict": false` 的專案逐步遷移到嚴格模式，列出步驟和注意事項。

### 練習 3：Monorepo 設定

為一個含有 `frontend`（React）和 `backend`（Node.js）的 monorepo 設計 tsconfig 結構。

---

> 下一章：[第十章 — 前端框架整合](./10-framework-integration.md)
