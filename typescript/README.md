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
| 05 | [05-classes.md](./05-classes.md) | 類別與物件導向程式設計 |
| 06 | [06-generics.md](./06-generics.md) | 泛型（Generics） |
| 07 | [07-advanced-types.md](./07-advanced-types.md) | 進階型別技巧 |
| 08 | [08-modules.md](./08-modules.md) | 模組系統與命名空間 |
| 09 | [09-tsconfig.md](./09-tsconfig.md) | tsconfig.json 設定完全指南 |
| 10 | [10-framework-integration.md](./10-framework-integration.md) | 前端框架整合（Vue / React / Nuxt / Next.js） |
| 11 | [11-decorators.md](./11-decorators.md) | 裝飾器（Decorators） |
| 12 | [12-best-practices.md](./12-best-practices.md) | 最佳實踐與常見模式 |

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
  04 介面與型別別名 → 05 類別與 OOP → 06 泛型

進階篇（能力提升）
  07 進階型別 → 08 模組系統 → 09 tsconfig 設定

實戰篇（框架應用）
  10 框架整合 → 11 裝飾器 → 12 最佳實踐
```

## 環境需求

- Node.js 版本：18+（建議使用 LTS 版本）
- TypeScript 版本：5.0+
- 編輯器：VS Code（推薦）/ WebStorm / Cursor
- 套件管理：npm / yarn / pnpm

### 快速安裝

```bash
# 全域安裝 TypeScript
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
