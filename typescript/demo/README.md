# TypeScript 測試環境（demo）

一個開箱即用的環境，讓你隨手寫 `.ts` 檔就能執行、型別檢查，用來驗證 [TypeScript 課程](../README.md) 各章的範例。

## 前置需求

- Node.js **18 以上**（本機請用 `nvm use 20` 之類切到新版，預設的 v12 太舊）
- 使用 [tsx](https://github.com/privatenumber/tsx) 直接執行 TypeScript，**不需要**先編譯成 JavaScript

## 安裝

```bash
cd typescript/demo
npm install
```

## 快速開始

```bash
# 邊寫邊跑：修改 src/playground.ts 存檔後會自動重新執行
npm run dev

# 執行一次 playground
npm start

# 只做型別檢查（不執行），會檢查 src 底下所有檔案
npm run check

# 型別檢查 + 監看模式
npm run check:watch

# 執行 Compiler API 範例（第 14 章）
npm run capi
```

## 執行任意一個 `.ts` 檔

把檔案丟到 `src/` 底下（或任何地方），用 `tsx` 直接跑：

```bash
# 執行一次
npx tsx src/你的檔案.ts

# 存檔後自動重跑
npx tsx watch src/你的檔案.ts
```

> 💡 `tsx` 只負責「執行」，它會略過型別錯誤照樣跑。想確認型別正確，請另外跑 `npm run check`。

## 檔案結構

```
demo/
├── package.json        # 相依套件與指令
├── tsconfig.json       # 嚴格模式設定（strict: true）
└── src/
    ├── playground.ts     # 👈 你的主要測試場，隨便改
    ├── type-utils.ts     # 型別測試工具（Equal / Expect / expectType）
    ├── type-testing.ts   # 型別層級程式設計的斷言範例（第 13 章精簡版）
    ├── compiler-api.ts   # Compiler API 遊樂場（第 14 章精簡版）
    └── chapters/         # 👈 各章完整程式碼範例（見下方「章節範例」）
```

## 章節範例（src/chapters/）

課程各章的程式碼都整理進 [src/chapters/](./src/chapters/)，一章一個檔，方便逐章執行與型別檢查。**整個資料夾都納入 `npm run check`，全部 0 型別錯誤。**

| 檔案 | 可執行？ | 說明 |
|------|:--------:|------|
| `02-basic-types.ts` | ✅ | 原始型別、陣列、元組、列舉、any/unknown/never、型別推論/斷言、字面值 |
| `03-functions.ts` | ✅ | 函式型別、可選/預設/剩餘參數、多載、this、回呼 |
| `04-interfaces-type-aliases.ts` | ✅ | 介面、型別別名、擴展、宣告合併、索引簽名 |
| `05-classes.ts` | ✅ | 類別、修飾符、繼承、抽象類別、getter/setter、靜態、泛型類別 |
| `06-generics.ts` | ✅ | 泛型函式/介面/類別、約束、預設值、Result/Builder 模式 |
| `07-advanced-types.ts` | ✅ | 聯合/交集、型別縮窄、條件型別、映射型別、模板字面值、工具型別 |
| `08-modules.ts` | 📖 參考 | 模組匯入匯出、路徑別名、命名空間（`@ts-nocheck`） |
| `10-framework-integration.ts` | 📖 參考 | Vue / React / Nuxt / Next.js 整合（`@ts-nocheck`） |
| `11-decorators.ts` | 📖 參考 | 裝飾器與 NestJS/TypeORM/Angular（`@ts-nocheck`，見下方裝飾器說明） |
| `12-best-practices.ts` | ✅ | 錯誤處理、不可變、事件系統、型別安全 API、陷阱、zod |
| `13-type-level-programming.ts` | ✅ | 型別層級程式設計 + 型別斷言（正確性由 tsc 保證） |
| `14-compiler-api.ts` | ✅ | Compiler API（會發出網路/讀檔的範例包成不呼叫的函式） |

- **✅ 可執行**：用 `npx tsx src/chapters/07-advanced-types.ts` 直接跑，會印出範例輸出並以 `... 範例載入完成 ✅` 結尾。
- **📖 參考**：這些章節依賴外部框架、路徑別名或舊版裝飾器，無法在此單檔環境編譯／執行，故加了 `// @ts-nocheck` 只供閱讀（不納入型別檢查、也不要用 tsx 執行）。

> 第 1 章（環境安裝）與第 9 章（tsconfig 設定）內容是指令與 JSON 設定、非可執行程式碼，因此未收錄於此。

**每個範例都是自足的**：同一章不同範例各自包在 `{ ... }` 區塊裡（利用區塊作用域隔離同名的 `type`/`interface`/`class`/`let`），用到的型別也整段複製進該區塊，可以獨立閱讀、複製、修改。刻意示範「會編譯錯誤」或「執行時出錯」的行都已註解並保留 `// ❌` 說明。

## 兩種「測試」TypeScript 的方式

### 1. 測試「執行結果」——寫一般程式，用 tsx 跑

適合驗證函式邏輯、類別行為、非同步等會產生輸出的程式。

```bash
npx tsx src/playground.ts
```

### 2. 測試「型別」——寫型別斷言，用 tsc 檢查

型別層級的東西（第 6、7、13 章）沒有執行期輸出，正確與否要靠**型別檢查**。做法是用 `type-utils.ts` 提供的 `Equal` / `Expect`：

```typescript
import type { Equal, Expect } from "./type-utils.js";

type Add<A extends number, B extends number> = /* ... */ any;

// 只要型別不符，這一行就會出現紅線，npm run check 也會失敗
type _Test = Expect<Equal<Add<3, 4>, 7>>;
```

然後執行：

```bash
npm run check
```

沒有任何輸出（exit code 0）就代表所有型別斷言都通過了。範例見 [src/type-testing.ts](./src/type-testing.ts)。

## 測試裝飾器（第 11 章）

預設設定支援 TypeScript 5.0 的**標準（TC39）裝飾器**。若要測試課程中 NestJS / TypeORM 風格的**舊版裝飾器**，請：

1. 打開 [tsconfig.json](./tsconfig.json)，取消 `experimentalDecorators` 與 `emitDecoratorMetadata` 兩行的註解。
2. 若範例用到 `Reflect.defineMetadata`，安裝反射套件：
   ```bash
   npm install reflect-metadata
   ```
   並在檔案最上方加上 `import "reflect-metadata";`。

## 常見問題

- **執行時出現語法錯誤 / 找不到模組？** 先確認 Node 版本 `node -v` 是 18 以上。
- **`npm run check` 沒有輸出？** 這是正常的——代表沒有型別錯誤，全數通過。
- **改了型別卻沒報錯？** `tsx` 執行時會忽略型別錯誤；型別檢查一律用 `npm run check`。
