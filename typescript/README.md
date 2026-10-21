# TypeScript 完整教學課程

> 從零開始學習 TypeScript，涵蓋型別系統、物件導向、泛型、進階型別到前端框架整合的完整課程。

---

## 課程目錄

| 章節 | 檔案 | 主題 |
|------|------|------|
| 01 | [01-introduction.md](./01-introduction.md) | TypeScript 簡介與環境安裝 |
| 02 | [02-basic-types.md](./02-basic-types.md) | 基本型別系統 |
| 03 | [03-functions.md](./03-functions.md) | 函式與型別 |
| 04 | [04-interfaces-type-aliases.md](./04-interfaces-type-aliases.md) | 介面與型別別名 |
| 05 | [05-unions-and-narrowing.md](./05-unions-and-narrowing.md) | 聯合型別與型別縮窄 |
| 06 | [06-classes.md](./06-classes.md) | 類別與物件導向程式設計 |
| 07 | [07-generics.md](./07-generics.md) | 泛型（Generics）與型別運算子 |
| 08 | [08-advanced-types.md](./08-advanced-types.md) | 進階型別技巧（條件、映射、模板字面值、工具型別） |
| 09 | [09-modules.md](./09-modules.md) | 模組系統與命名空間 |
| 10 | [10-tsconfig.md](./10-tsconfig.md) | tsconfig.json 設定完全指南 |
| 11 | [11-best-practices.md](./11-best-practices.md) | 最佳實踐與常見模式 |
| 12 | [12-framework-integration.md](./12-framework-integration.md) | 前端框架整合（Vue / React / Nuxt / Next.js） |
| 13 | [13-decorators.md](./13-decorators.md) | 裝飾器（Decorators）（進階補充） |
| 14 | [14-type-level-programming.md](./14-type-level-programming.md) | 型別層級程式設計（進階補充） |
| 15 | [15-type-gymnastics.md](./15-type-gymnastics.md) | 型別體操解題手冊（進階補充） |
| 16 | [16-compiler-api.md](./16-compiler-api.md) | TypeScript Compiler API（進階補充） |

---

## 實戰專案

除了章節教材，[projects/](./projects/) 資料夾另收錄兩個**可實際執行**、功能互相對應的小型前端專案，示範 TypeScript 在真實專案（狀態管理、路由、API 串接）中的用法，可左右對照：

| 專案 | 技術棧 | 說明 |
|------|--------|------|
| [projects/vue-app](./projects/vue-app/) | Vue 3 + Pinia + Vue Router + axios | Vue 版「使用者與文章瀏覽器」 |
| [projects/react-app](./projects/react-app/) | React 19 + Zustand + React Router + axios | React 版「使用者與文章瀏覽器」 |

詳見 [projects/README.md](./projects/README.md)。

---

## 課程特色

- **漸進式學習**：從基礎型別到進階應用，循序漸進
- **實戰導向**：每個章節附有完整的程式碼範例與練習題
- **框架整合**：涵蓋 Vue、React、Nuxt、Next.js 的 TypeScript 設定與開發
- **生產級實踐**：業界常用的型別設計模式與最佳實踐

## 適合對象

- 有 JavaScript 基礎，想學習 TypeScript 的前端開發者
- 希望在 Vue / React 專案中導入 TypeScript 的工程師
- 想提升程式碼品質與可維護性的全端開發者
- 準備轉型到強型別語言的 JavaScript 開發者

## 學習路線建議

```
基礎篇（必修）
  01 簡介與安裝 → 02 基本型別 → 03 函式型別

核心篇（重點掌握）
  04 介面與型別別名 → 05 聯合型別與型別縮窄 → 06 類別與 OOP → 07 泛型

進階篇（能力提升）
  08 進階型別 → 09 模組系統 → 10 tsconfig 設定

實戰篇（框架應用）
  11 最佳實踐 → 12 框架整合 + 實戰專案

進階補充（選修 / 挑戰）
  13 裝飾器（NestJS / Angular / TypeORM 使用者）
  14 型別層級程式設計 → 15 型別體操 → 16 Compiler API
```

> 💡 排序原則：每章只用到前面已經教過的觀念。聯合型別與縮窄放在類別、泛型之前，是因為 `instanceof` 縮窄、Result 模式、API 回應設計都建立在它上面；`keyof` / `typeof` / `T[K]` 在泛型章（7.3）一次講清楚，第 8 章的型別運算才有共同基礎。

## 環境需求

- Node.js 版本：18+（建議使用 LTS 版本）
- TypeScript 版本：5.0+
- 編輯器：VS Code（推薦）/ WebStorm / Cursor
- 套件管理：npm / yarn / pnpm

### 快速安裝

```bash
# 全域安裝 TypeScript
# 本機已在 20 裝上
npm install -g typescript

# 確認版本
tsc --version

# 初始化 TypeScript 專案
mkdir my-ts-project && cd my-ts-project
npm init -y
npm install typescript --save-dev
npx tsc --init
```

---

> 準備好了嗎？讓我們從 [第一章：TypeScript 簡介與環境安裝](./01-introduction.md) 開始吧！
