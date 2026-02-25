# 第一章：TypeScript 簡介與環境安裝

## 1.1 什麼是 TypeScript？

TypeScript 是由 Microsoft 開發的開源程式語言，它是 JavaScript 的超集（Superset），在 JavaScript 的基礎上加入了**靜態型別系統**和其他增強功能。所有合法的 JavaScript 程式碼都是合法的 TypeScript 程式碼，但 TypeScript 提供了更強大的型別檢查能力。

### TypeScript 的核心特點

| 特點 | 說明 |
|------|------|
| 靜態型別 | 在編譯階段就能發現型別錯誤，而非執行時期 |
| 型別推論 | 即使不明確標註型別，編譯器也能自動推斷 |
| 介面與泛型 | 提供強大的型別抽象能力 |
| 完整的 OOP 支援 | 類別、介面、繼承、存取修飾符 |
| 優秀的編輯器支援 | 自動補全、重構、即時錯誤提示 |
| 向下相容 | 編譯輸出標準 JavaScript，可設定目標版本 |

### TypeScript vs JavaScript

```
                TypeScript                         JavaScript
型別系統      靜態型別（編譯時檢查）              動態型別（執行時檢查）
型別標註      支援（可選）                        不支援
介面          支援                                不支援
泛型          支援                                不支援
列舉          支援                                不支援
編譯步驟      需要編譯成 JS                       直接執行
學習曲線      中等                                低
錯誤檢測      編譯時期即可發現                    執行時才會發現
```

---

## 1.2 為什麼要使用 TypeScript？

### 1. 提早發現錯誤

```typescript
// JavaScript — 執行時才會發現錯誤
function add(a, b) {
  return a + b;
}
add("hello", 5); // "hello5" — 非預期的字串串接

// TypeScript — 編譯時就能發現錯誤
function add(a: number, b: number): number {
  return a + b;
}
add("hello", 5); // ❌ 編譯錯誤：Argument of type 'string' is not assignable to parameter of type 'number'
```

### 2. 更好的開發體驗

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

// 編輯器會自動提示 user 的所有屬性
user. // 自動補全：id, name, email
```

### 3. 程式碼即文件

```typescript
// 型別標註就是最好的文件
interface ApiResponse<T> {
  data: T;
  status: number;
  message: string;
  timestamp: Date;
}

// 一看就知道函式需要什麼參數、回傳什麼
function fetchUser(id: number): Promise<ApiResponse<User>> {
  // ...
}
```

### 4. 安全的重構

```typescript
// 當你修改 interface 時，所有使用到的地方都會被標記錯誤
interface User {
  id: number;
  name: string;
  email: string;
  role: "admin" | "user"; // 新增屬性
}

// TypeScript 會告訴你所有需要更新的地方
const user: User = {
  id: 1,
  name: "Gary",
  email: "gary@example.com",
  // ❌ 缺少 role 屬性
};
```

---

## 1.3 安裝 TypeScript

### 方法一：全域安裝

```bash
# 使用 npm 全域安裝
npm install -g typescript

# 使用 yarn
yarn global add typescript

# 使用 pnpm
pnpm add -g typescript

# 確認安裝版本
tsc --version
# TypeScript 5.x.x
```

### 方法二：專案內安裝（推薦）

```bash
# 建立新專案
mkdir my-ts-project
cd my-ts-project
npm init -y

# 安裝 TypeScript 為開發依賴
npm install typescript --save-dev

# 使用 npx 執行
npx tsc --version
```

### 方法三：使用 ts-node（直接執行 .ts 檔案）

```bash
# 安裝 ts-node
npm install -g ts-node

# 直接執行 TypeScript 檔案（無需先編譯）
ts-node hello.ts
```

### 方法四：使用 tsx（更快速的替代方案）

```bash
# 安裝 tsx
npm install -g tsx

# 直接執行 TypeScript 檔案
tsx hello.ts

# 監聽模式
tsx watch hello.ts
```

---

## 1.4 第一個 TypeScript 程式

### 建立專案

```bash
mkdir hello-typescript
cd hello-typescript
npm init -y
npm install typescript --save-dev
npx tsc --init
```

### 撰寫程式碼

建立 `hello.ts`：

```typescript
// hello.ts
function greet(name: string): string {
  return `Hello, ${name}! Welcome to TypeScript.`;
}

const userName: string = "Gary";
console.log(greet(userName));

// 嘗試傳入錯誤的型別
// greet(42); // ❌ 編譯錯誤！
```

### 編譯與執行

```bash
# 編譯 TypeScript → JavaScript
npx tsc hello.ts

# 查看輸出的 hello.js
cat hello.js

# 執行編譯後的 JavaScript
node hello.js
# Output: Hello, Gary! Welcome to TypeScript.
```

編譯後的 `hello.js`：

```javascript
// hello.js（編譯輸出）
function greet(name) {
  return "Hello, " + name + "! Welcome to TypeScript.";
}
var userName = "Gary";
console.log(greet(userName));
```

---

## 1.5 TypeScript 編譯流程

```
┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│   .ts / .tsx     │      │   TypeScript      │      │   .js / .jsx     │
│   原始碼         │ ───▶ │   Compiler (tsc)  │ ───▶ │   JavaScript     │
│                  │      │   型別檢查 + 編譯  │      │   可執行檔案     │
└──────────────────┘      └──────────────────┘      └──────────────────┘
                                  │
                                  ▼
                          ┌──────────────────┐
                          │   .d.ts           │
                          │   型別宣告檔案     │
                          └──────────────────┘
```

### 編譯過程說明

1. **解析（Parsing）**：將 `.ts` 原始碼轉為 AST（抽象語法樹）
2. **型別檢查（Type Checking）**：驗證型別正確性
3. **轉譯（Emit）**：產生 `.js` 檔案與 `.d.ts` 型別宣告

---

## 1.6 開發環境設定

### VS Code / Cursor 推薦擴充

| 擴充套件 | 說明 |
|----------|------|
| TypeScript Importer | 自動匯入模組 |
| Pretty TypeScript Errors | 更友善的錯誤訊息顯示 |
| Error Lens | 行內顯示錯誤訊息 |
| ESLint | 程式碼風格檢查 |

### 基本 tsconfig.json

```bash
# 自動產生 tsconfig.json
npx tsc --init
```

產生的預設設定（關鍵部分）：

```json
{
  "compilerOptions": {
    "target": "es2016",
    "module": "commonjs",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

> 💡 `tsconfig.json` 的完整設定將在 [第九章](./09-tsconfig.md) 詳細說明。

---

## 1.7 TypeScript Playground

如果你不想安裝任何東西，可以使用線上環境：

- **官方 Playground**：[https://www.typescriptlang.org/play](https://www.typescriptlang.org/play)
- **StackBlitz**：[https://stackblitz.com](https://stackblitz.com)
- **CodeSandbox**：[https://codesandbox.io](https://codesandbox.io)

---

## 練習題

### 練習 1：環境測試

建立一個 TypeScript 專案，撰寫以下程式並確認可以正確編譯執行：

```typescript
function calculateArea(width: number, height: number): number {
  return width * height;
}

const area = calculateArea(10, 20);
console.log(`面積為：${area}`);
```

### 練習 2：體驗型別錯誤

嘗試以下程式碼，觀察 TypeScript 如何在編譯時期報錯：

```typescript
let message: string = "Hello";
message = 42; // 觀察錯誤訊息

function multiply(a: number, b: number): number {
  return a * b;
}
multiply("3", "4"); // 觀察錯誤訊息
```

---

> 下一章：[第二章 — 基本型別系統](./02-basic-types.md)
