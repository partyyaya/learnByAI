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
