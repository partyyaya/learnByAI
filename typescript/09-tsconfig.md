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

### typeRoots 與 types

這兩個選項只管一件事：**哪些「全域型別包」要被自動載入**。它們常被誤解成「TypeScript 去哪裡找型別檔」，其實不是——那是 `include` / `files` 的工作。

先看它們解決什麼問題。當你 `npm i -D @types/node` 之後，不必在任何檔案寫 `import`，`process`、`Buffer` 這些全域名稱就直接可用了。這個「自動注入全域型別」的行為就是 `typeRoots` 在控制的：

| 選項 | 作用 | 預設值 |
| --- | --- | --- |
| `typeRoots` | 到**哪些資料夾**去找型別包 | 從目前目錄逐層往上找所有的 `node_modules/@types` |
| `types` | 這些資料夾裡，**只載入哪幾個**（白名單） | 不設定 = 全部載入 |

```json
{
  "compilerOptions": {
    "typeRoots": ["./node_modules/@types", "./src/types"],
    "types": ["node", "jest"]
  }
}
```

上面這組設定的意思是：「去 `node_modules/@types` 和 `src/types` 這兩個資料夾找型別包，但只自動載入 `node` 和 `jest` 這兩個。」

#### `types: []` 的實際用途

不設 `types` 時，`node_modules/@types` 底下**所有**套件都會被自動載入——包含你根本沒用到的。這在大型專案會拖慢編譯，也可能讓不該出現的全域型別汙染進來（例如前端專案不小心吃到 `@types/node` 的 `process`）。用白名單就能收斂：

```json
{
  "compilerOptions": {
    "types": [] // 完全關閉自動載入，只靠明確的 import
  }
}
```

#### ⚠️ 關鍵限制：`typeRoots` 底下必須是「資料夾」

這是最容易踩的坑。`typeRoots` 指向的目錄底下，**每個項目都必須是一個「套件式」的資料夾**（各自帶 `index.d.ts`，或用 `package.json` 的 `types` 欄位指路），跟 `node_modules/@types` 的結構一樣。直接丟一個 `.d.ts` 檔進去**不會有任何作用**：

```text
src/types/
├── my-globals/
│   └── index.d.ts     ✅ 資料夾形式 → 會被自動載入
└── loose.d.ts         ❌ 裸檔案 → typeRoots 完全看不到它
```

```typescript
// src/types/my-globals/index.d.ts
declare const __BUILD_ID__: string;
```

```typescript
// src/types/loose.d.ts
declare const __LOOSE_VAR__: string;
```

```typescript
console.log(__BUILD_ID__);  // ✅ 透過 typeRoots 自動載入
console.log(__LOOSE_VAR__); // ❌ error TS2304: Cannot find name '__LOOSE_VAR__'.
```

**單一 `.d.ts` 檔要靠 `include` 涵蓋**，不是靠 `typeRoots`：

```json
{
  "compilerOptions": {
    "typeRoots": ["./src/types"]
  },
  "include": ["src"] // ← 改成涵蓋整個 src，loose.d.ts 才會被納入編譯
}
```

#### 一句話區分

| 你想做的事 | 該用哪個 |
| --- | --- |
| 「我專案裡有一份 `.d.ts`，想讓它生效」 | `include` / `files` |
| 「我想控制 `@types/*` 這類全域型別包自動載入哪些」 | `typeRoots` / `types` |

> 📌 這也是第 8 章 8.3 那句警告的由來——自己寫的 `legacy-lib.d.ts`、`assets.d.ts` 都是「單一檔案」，要用 `include` 收，放進 `typeRoots` 是無效的。

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

Vite 專案的共通點：TypeScript 只做型別檢查（`noEmit: true`），打包與轉譯交給 Vite。因此 React 與 Vue 都會開 `moduleResolution: "bundler"`、`isolatedModules: true`，`lib` 也要含 `DOM`。真正分叉的是 **JSX / `.vue` 檔案怎麼處理**，以及 **用哪個指令做型別檢查**。

官方 `create-vite` / `create-vue` 樣板會再拆成 `tsconfig.app.json`（應用程式）與 `tsconfig.node.json`（Vite 設定檔），細節見 [第十章](./10-framework-integration.md)。這裡先給「單一 tsconfig」的可複製範本。

#### React + Vite

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

> 關鍵：`"jsx": "react-jsx"` 啟用 React 17+ 的新版 JSX transform，元件檔不必再手動 `import React`；含 JSX 的元件用 `.tsx`。型別檢查：`npx tsc --noEmit`。

#### Vue + Vite

`.vue` 單檔元件不是標準 TypeScript，`tsc` 看不懂它們，必須改用 `vue-tsc`。`include` 要涵蓋 `.vue`，並準備一份 `env.d.ts` 讓編譯器認識 Vite 客戶端型別。

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
    "jsx": "preserve",
    "jsxImportSource": "vue",
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  },
  "include": ["env.d.ts", "src/**/*.ts", "src/**/*.tsx", "src/**/*.vue"],
  "exclude": ["node_modules"]
}
```

```typescript
// env.d.ts — 讓 TypeScript 認識 Vite 的 import.meta.env 等客戶端型別
/// <reference types="vite/client" />
```

> 💡 `"jsx": "preserve"` 是給 **Vue JSX**（`.tsx` 裡寫 Vue 元件）用的：TypeScript 不轉譯 JSX，交給 Vue 的編譯器。若專案只用 `.vue` SFC、完全不寫 Vue JSX，這兩行 `jsx` / `jsxImportSource` 可以省略。型別檢查：`npx vue-tsc --noEmit`。

> 實務上不必把 DOM / bundler / isolatedModules 全部手寫，官方樣板會繼承 `@vue/tsconfig`（需 `npm install -D vue-tsc @vue/tsconfig`）：

```json
{
  "extends": "@vue/tsconfig/tsconfig.dom.json",
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  },
  "include": ["env.d.ts", "src/**/*.ts", "src/**/*.tsx", "src/**/*.vue"]
}
```

| 差異 | React + Vite | Vue + Vite |
|------|--------------|------------|
| `jsx` | `"react-jsx"` | `"preserve"` + `"jsxImportSource": "vue"`（純 SFC 可省略） |
| `include` | `.ts` / `.tsx` | 再加上 `.vue` 與 `env.d.ts` |
| 型別檢查 | `tsc --noEmit` | `vue-tsc --noEmit`（`tsc` 無法檢查 `.vue`） |

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

9.7 的 `extends` 是**複製設定**（子專案繼承一份 JSON）；這一節的 `references` 是**宣告建置相依**（先編完 A，B 才能用 A 的產出）。兩者常一起出現在 monorepo，但做的事完全不同。

適用情境：倉庫裡有多個套件（例如 `packages/core`、`packages/ui`、`packages/api`），彼此會互相 import。若仍用「根目錄一份 tsconfig 涵蓋全部原始碼」，TypeScript 會把整個倉庫當成**一個編譯單位**——任何一個檔案改動都可能牽動全庫重查，套件邊界也不清楚。Project References 的做法是：每個套件自己一份 tsconfig，再用 `references` 把「誰依賴誰」畫成建置圖，讓 `tsc --build` 依拓撲順序編譯，且只重建過期的專案。

### composite：讓這個專案成為「可被引用的建置單元」

`composite: true` 不是另一種嚴格模式，而是在跟編譯器說：**這份 tsconfig 是拼圖的一塊，它的產出要給其他專案當相依項。** 沒開它，別的專案就不得在 `references` 裡指向你，否則會得到 `TS6306`（Referenced project must have setting `"composite": true`）。

開啟後，TypeScript 會自動套上幾條「可被引用」的契約：

| 自動生效的行為 | 用意 |
|----------------|------|
| 視為開啟 `declaration: true`，編譯時產出 `.d.ts` | 下游專案讀你的**宣告檔**來做型別檢查，而不是每次都深入掃描你的 `.ts` 原始碼 |
| 視為開啟 `incremental: true`，寫入 `.tsbuildinfo` | `tsc --build` 才能判斷「這個專案上次編完之後有沒有過期」，沒改就跳過 |
| 所有實作檔必須被 `include` 或 `files` 涵蓋 | 避免漏編某個檔，導致下游看到不完整的公開型別 |
| 未指定時，`rootDir` 預設為 **tsconfig 所在目錄**（與一般專案「所有輸入檔的最長共同路徑」不同） | 輸出結構變嚴謹。原始碼若在 `src/`，實務上仍應明確寫 `"rootDir": "./src"`，否則 `dist/` 裡會多一層 `src/` |

可以這樣記：

- `incremental`：只加速**這一個專案自己**的重編譯。
- `composite`：包含增量編譯的效果，再加上「我可以當別人的相依項」——因此才強制產出 `.d.ts`。

沒有 `.d.ts`，下游在 `tsc --build` 時就沒有一份穩定、過期可偵測的型別契約可讀。這也是為什麼「只做型別檢查、不輸出」的 `noEmit: true` **不能**用在「還要被其他套件 `references`」的專案上（會得到 `TS6310` Referenced project may not disable emit）。Vite 把同一個 app 拆成 `tsconfig.app.json` / `tsconfig.node.json` 也用 `references`，那是為了分開檢查瀏覽器程式與 Vite 設定檔，**不是**套件互依；那種拆法見 [第十章](./10-framework-integration.md)。若前後端要抽共用型別套件，做法見本章練習 3。

> 💡 建議順手開 `"declarationMap": true`。有了 `.d.ts.map`，編輯器對下游專案「跳到定義」時可以連回上游的 `.ts` 原始碼，而不是停在產生出來的 `.d.ts`。

### 設定怎麼串起來

假設倉庫長這樣：`ui` 依賴 `core`，`api` 也依賴 `core`，三個套件彼此獨立編譯：

```
my-monorepo/
├── tsconfig.json              # 根：只當建置入口，不含原始碼
├── packages/
│   ├── core/
│   │   ├── tsconfig.json      # 被依賴的底層，必須 composite
│   │   └── src/index.ts
│   ├── ui/
│   │   ├── tsconfig.json      # references → core
│   │   └── src/index.ts
│   └── api/
│       ├── tsconfig.json      # references → core
│       └── src/index.ts
```

```json
// tsconfig.json（根目錄）
{
  "files": [],
  "references": [
    { "path": "./packages/core" },
    { "path": "./packages/ui" },
    { "path": "./packages/api" }
  ]
}

// packages/core/tsconfig.json — 沒有再依賴別人，是圖上的葉子
{
  "compilerOptions": {
    "composite": true,
    "declarationMap": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src"]
}

// packages/ui/tsconfig.json — 宣告「先建 core，再用它的 .d.ts」
{
  "compilerOptions": {
    "composite": true,
    "declarationMap": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "references": [
    { "path": "../core" }
  ],
  "include": ["src"]
}
```

`api` 的寫法與 `ui` 相同，同樣 `references` 指向 `../core`。根目錄那份 `"files": []` 是慣例：它本身不編譯任何檔案，只作為 `tsc --build` 的入口，依 `references` 把子專案串起來。若漏寫 `files` / `include`，編譯器可能會在根目錄意外撿到檔案，把「統籌用的 tsconfig」變成又一個編譯單位。

建置時發生的事：

1. `tsc --build` 讀根目錄，依 `references` 排出順序：先 `core`，再 `ui` / `api`。
2. `core` 編完後，`dist/` 裡會有 `.js`、`.d.ts` 與 `.tsbuildinfo`。
3. `ui` 做型別檢查時讀的是 `core` 的 `.d.ts`（建置產物），不是每次重跑 `core` 的全部原始碼。
4. 之後若只改 `ui`，再跑一次 `tsc --build` 會跳過仍是最新的 `core`；若改了 `core`，它與所有依賴它的專案都會被重建。

> ⚠️ `references` **不會**幫你改寫 import 路徑。套件之間要怎麼 `import`，仍靠相對路徑、`paths` 別名，或 workspace 的套件名稱（`package.json` 的 `name` / `exports`）。Project References 管的是**建置順序**與**型別從哪份產出讀取**。

### 建置指令

一般的 `npx tsc`（沒有 `--build`）**不會**去編譯 `references` 裡的專案；它頂多在型別檢查時假設那些產出已經存在。多專案請一律用 `--build`（可簡寫 `-b`）：

```bash
# 依相依順序，只重建過期的專案
npx tsc --build

# 看哪些專案被跳過、哪些被重建（除錯時很好用）
npx tsc --build --verbose

# 忽略時間戳，全部重編
npx tsc --build --force

# 清除各專案的 dist 與 .tsbuildinfo
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

#### 有加跟沒加，輸出差在哪？

這個選項的名字不太直覺，直接看編譯結果最清楚。假設有這兩個檔案：

```typescript
// types.ts
console.log("[types.ts] 這個模組被載入了"); // 模組層級的副作用

export interface User {
  id: number;
  name: string;
}

export const DEFAULT_USER: User = { id: 0, name: "guest" };
```

```typescript
// app.ts —— 注意這裡是普通的 import，沒有 type 關鍵字
import { User } from "./types.js";

export function greet(user: User): string {
  return `Hello, ${user.name}`;
}

console.log("[app.ts] " + greet({ id: 1, name: "Gary" }));
```

**沒開 `verbatimModuleSyntax`（預設行為）**——TypeScript 發現 `User` 只被當型別用，就把整行 import「消除」掉了：

```javascript
// 編譯後的 app.js —— import 那一行整個不見了
export function greet(user) {
    return `Hello, ${user.name}`;
}
console.log("[app.ts] " + greet({ id: 1, name: "Gary" }));
```

執行結果：

```text
[app.ts] Hello, Gary
```

⚠️ **`types.ts` 的 `console.log` 沒有印出來**——因為那行 import 被移除，`types.js` 從頭到尾沒有被載入，模組的副作用完全消失了。這個行為叫**匯入消除（import elision）**。

**開啟 `verbatimModuleSyntax`**——同一份 `app.ts` 直接編譯失敗，要求你講清楚：

```text
error TS1484: 'User' is a type and must be imported using a type-only import
              when 'verbatimModuleSyntax' is enabled.
```

改成明確的寫法後：

```typescript
import type { User } from "./types.js";      // 純型別 → 明確表示「這行會被移除」
import { DEFAULT_USER } from "./types.js";   // 值 → 明確表示「這行會保留」

export function greet(user: User): string {
  return `Hello, ${user.name}`;
}

console.log("[app.ts] " + greet(DEFAULT_USER));
```

```javascript
// 編譯後：import type 消失、值的 import 保留
import { DEFAULT_USER } from "./types.js";
export function greet(user) {
    return `Hello, ${user.name}`;
}
console.log("[app.ts] " + greet(DEFAULT_USER));
```

執行結果——副作用正常執行：

```text
[types.ts] 這個模組被載入了
[app.ts] Hello, guest
```

#### 四種情況對照

| 你寫的 | 沒開（預設） | 開啟後 |
| --- | --- | --- |
| `import { User }`，只當型別用 | ⚠️ 整行被消除（副作用一起消失） | ❌ 編譯錯誤 TS1484，強迫你改寫 |
| `import type { User }` | 整行被移除 | 整行被移除（結果相同，但意圖明確） |
| `import { fn }`，有用到 | 保留 | 保留 |
| `import { fn }`，完全沒用到 | ⚠️ 整行被消除 | ✅ **逐字保留**（副作用照樣執行） |

最後一列是「verbatim（逐字）」這個名字的由來：**開啟後，普通的 `import` 一定會出現在輸出裡，就算你完全沒用到它。** 要不要移除由你決定（寫不寫 `type`），而不是編譯器替你猜。

#### 為什麼需要這個選項？

**1. 副作用不會莫名消失**（上面示範的情況）

某些模組是靠「被載入」本身產生效果的——polyfill、CSS 匯入、註冊全域元件、Reflect metadata。這類 import 一旦被消除，程式在編譯期完全正常、執行期才出問題，而且很難查。

**2. 讓 esbuild / swc / Babel 這類工具能正確處理**

這些工具為了速度是**逐檔轉譯**的，看到 `import { User } from "./types"` 時，它們**無法知道** `User` 是型別還是值——那個資訊在另一個檔案裡，而它們不做跨檔案型別分析。所以它們只能選一邊：

- 全部保留 → 型別匯入殘留在輸出中，執行期會因為找不到匯出而爆掉
- 全部移除 → 值的匯入被誤刪

`verbatimModuleSyntax` 要求你在**每一行 import 上就把答案寫清楚**，逐檔轉譯的工具就不需要猜了。這也是為什麼用 Vite、esbuild 的專案（例如 Vue / React 的新專案樣板）幾乎都預設開啟它。

**3. 意圖明確，程式碼可讀**

`import type` 一眼就能看出「這個匯入編譯後會消失」，不必反查該符號是型別還是值。

> 💡 **實務建議**：新專案直接開啟。它唯一的成本是要多打 `type` 這幾個字，換來的是輸出可預測——而且多數 IDE 都能自動加上（VS Code 的 quick fix、或 ESLint 的 `@typescript-eslint/consistent-type-imports` 規則可以自動修正整個專案）。

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

<details>
<summary>參考解答</summary>

這是一份典型的「Vite + React」前端專案設定：TypeScript 只做型別檢查（`noEmit`），實際打包與轉譯交給 bundler。逐項作用如下：

| 選項 | 作用 |
|------|------|
| `"target": "ES2022"` | 型別檢查與（若有輸出時的）語法降級以 ES2022 為基準，可安心使用頂層 await、`.at()`、class fields 等特性。 |
| `"module": "ESNext"` | 使用最新的 ES Modules 語法輸出，保留原生 `import` / `export` 與動態 `import()`，交給 bundler 處理。 |
| `"moduleResolution": "bundler"` | 用打包工具（Vite/Webpack/esbuild）的解析規則，相對匯入**不必**補 `.js` 副檔名，最貼近實際開發體驗。 |
| `"strict": true` | 一次開啟所有核心嚴格檢查（`noImplicitAny`、`strictNullChecks`、`strictFunctionTypes` 等），是新專案的建議起點。 |
| `"noEmit": true` | TypeScript 只負責型別檢查、不輸出任何 `.js`；產出交給 Vite。這也是前端專案最常見的搭配。 |
| `"isolatedModules": true` | 要求每個檔案都能被「單獨轉譯」，配合 esbuild/swc 這類單檔案轉譯器；會限制某些 re-export（型別要用 `export type`）與 `const enum` 的用法。 |
| `"jsx": "react-jsx"` | 使用 React 17+ 的新版 JSX transform，元件檔不必再手動 `import React`。 |
| `"lib": ["ES2022", "DOM"]` | 納入 ES2022 內建 API 與瀏覽器 DOM 型別（`document`、`window`、`fetch` 等），因為程式跑在瀏覽器環境。 |

重點提醒：`noEmit + isolatedModules + moduleResolution: bundler` 這組合幾乎就是在宣告「型別檢查歸 TypeScript，打包歸 bundler」的分工；而 `lib` 帶了 `DOM` 正是「這是前端而非 Node.js 專案」的關鍵線索（Node 後端範本通常只寫 `["ES2022"]`）。

</details>

### 練習 2：設定遷移

將一個 `"strict": false` 的專案逐步遷移到嚴格模式，列出步驟和注意事項。

<details>
<summary>參考解答</summary>

核心思路：**不要一次把 `strict` 打開**（大型專案往往瞬間噴出上千個錯誤，難以收拾），而是「逐旗標開啟、逐一消化」，最後再收斂成 `strict: true`。`strict` 其實是多個子旗標的總開關，可以拆開來一顆一顆開。

建議步驟：

```json
// 步驟 0：現況（起點）
{ "compilerOptions": { "strict": false } }
```

```json
// 步驟 1：先開 noImplicitAny —— 逼出所有「隱含 any」的參數與變數，
// 逐一補上型別標註（通常是遷移量最大的一步）
{ "compilerOptions": { "strict": false, "noImplicitAny": true } }
```

```json
// 步驟 2：再開 strictNullChecks —— 這是影響最深遠的一顆，
// 會抓出所有可能為 null / undefined 卻沒防呆的存取
{
  "compilerOptions": {
    "strict": false,
    "noImplicitAny": true,
    "strictNullChecks": true
  }
}
```

```json
// 步驟 3：補齊其餘子旗標
{
  "compilerOptions": {
    "strict": false,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "strictBindCallApply": true,
    "strictPropertyInitialization": true,
    "noImplicitThis": true,
    "useUnknownInCatchVariables": true,
    "alwaysStrict": true
  }
}
```

```json
// 步驟 4：全部消化完畢後，收斂成單一開關（此時等價，但更簡潔、面向未來）
{ "compilerOptions": { "strict": true } }
```

注意事項：

- **一次只開一顆旗標**，把該旗標引發的錯誤修完、通過編譯後再開下一顆，讓每次 PR 的變更範圍可控、可 review。
- `strictNullChecks` 通常是工程量最大的一步，因為它會連帶影響型別推論；預留較多時間。
- 過渡期若某些檔案暫時修不完，可用「`// @ts-expect-error` 標記待辦」或先把該檔案排除在 `include` 之外，但要留下追蹤，避免變成永久技術債；盡量少用 `as any` 蓋錯誤。
- 也可搭配 `noUncheckedIndexedAccess` 等**不在 `strict` 內**的旗標一起評估，但同樣建議放到最後、獨立導入。
- 最後記得把散開的子旗標刪掉、改回 `"strict": true`：語意更清楚，且未來 TypeScript 若在 `strict` 底下新增旗標也會自動涵蓋。

</details>

### 練習 3：Monorepo 設定

為一個含有 `frontend`（React）和 `backend`（Node.js）的 monorepo 設計 tsconfig 結構。

<details>
<summary>參考解答</summary>

思路：用「一份共用基底 + `extends` 覆寫 + Project References 串接」三件事組出 monorepo。根目錄放 `tsconfig.base.json` 收攏共用嚴格設定，`frontend` / `backend` 各自 `extends` 基底再覆寫自己的 `target` / `module` / `lib`，最後在根目錄用 `references` 把兩個子專案串起來，一道 `tsc --build` 就能增量建置整個倉庫。

目錄結構：

```
my-monorepo/
├── tsconfig.base.json      # 共用基礎設定
├── tsconfig.json           # 根：只做 references 統籌，不含實際檔案
├── packages/
│   ├── frontend/
│   │   ├── tsconfig.json    # React 前端
│   │   └── src/
│   └── backend/
│       ├── tsconfig.json    # Node.js 後端
│       └── src/
```

共用基底（放所有子專案都一致的嚴格與品質設定）：

```json
// tsconfig.base.json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "composite": true
  }
}
```

前端（瀏覽器 + React，帶 DOM，交給 Vite 打包所以 `noEmit`）：

```json
// packages/frontend/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "noEmit": true,
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] }
  },
  "include": ["src"]
}
```

後端（Node.js 原生 ESM，只需 ES 標準庫，實際輸出到 dist）：

```json
// packages/backend/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src"]
}
```

根設定（不含自身檔案，只負責用 references 統籌建置順序）：

```json
// tsconfig.json（根）
{
  "files": [],
  "references": [
    { "path": "./packages/frontend" },
    { "path": "./packages/backend" }
  ]
}
```

```bash
# 增量建置整個 monorepo（tsc 會依 references 拓撲順序建置有變動的專案）
npx tsc --build

# 清除所有建置產物
npx tsc --build --clean
```

重點提醒：

- **共用的放 base、差異的放各自 tsconfig**。前後端最大的差異就是執行環境：前端要 `DOM` lib、`jsx`、`bundler` 解析與 `noEmit`；後端不要 DOM、用 `NodeNext` 並實際 `outDir` 輸出。
- 要用 Project References 就必須在被引用的專案開 `composite: true`（本例放進 base 一次到位），它會強制要求 `declaration: true`，換來 `tsc --build` 的增量建置與正確的跨專案建置順序。
- 根目錄 `tsconfig.json` 寫 `"files": []` 是慣例：它本身不編譯任何檔案，只作為 `references` 的入口。
- 若前後端要共用型別，正確做法是把它們抽成一個**會輸出宣告檔的** `packages/shared`（`composite: true`、不要開 `noEmit`），再讓 frontend／backend 各自 `references` 指向它，`tsc --build` 會自動先建這個相依專案。注意**不要**反過來 `references` 指向本例的 `frontend`——它開了 `noEmit` 不會產生 `.d.ts`，被引用時 `tsc --build` 會以 `TS6310`（referenced project may not disable emit）報錯。

</details>

---

> 下一章：[第十章 — 前端框架整合](./10-framework-integration.md)
