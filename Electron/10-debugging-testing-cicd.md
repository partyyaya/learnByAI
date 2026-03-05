# 第十章：除錯、測試與 CI/CD 發佈流程

## 10.1 章節目標

本章讓專案從「可運作」走向「可長期維護」：

- 建立除錯流程
- 加入自動化測試
- 用 CI/CD 自動建置與發佈

---

## 10.2 常用除錯指令

```bash
# 開發模式啟動應用，搭配 DevTools 進行前端除錯
npm run dev

# 啟用 Electron 詳細日誌，排查主程序啟動與事件問題
ELECTRON_ENABLE_LOGGING=true npm run dev

# 在 macOS/Linux 直接印出 node 與 electron 版本，確認環境一致
npx electron --version
```

---

## 10.3 建立程式碼品質檢查

```bash
# 安裝 ESLint（JavaScript 靜態分析）與 Prettier（格式化工具）
npm install --save-dev eslint prettier eslint-config-prettier

# 初始化 ESLint 設定（互動式）
npx eslint --init
```

`package.json` 可新增：

```json
{
  "scripts": {
    "lint": "eslint \"src/**/*.{js,mjs,cjs}\"",
    "format": "prettier --write \"src/**/*.{js,json,md,css,html}\""
  }
}
```

```bash
# 執行靜態分析，提早發現未使用變數或可疑語法
npm run lint

# 自動格式化程式碼，維持團隊一致風格
npm run format
```

---

## 10.4 加入單元測試（Vitest 範例）

```bash
# 安裝 Vitest，建立快速的單元測試流程
npm install --save-dev vitest
```

`package.json`：

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

```bash
# 執行一次性測試，適合 CI 使用
npm run test

# 監看模式測試，適合本機開發邊寫邊驗證
npm run test:watch
```

---

## 10.5 E2E 測試（Playwright + Electron）

```bash
# 安裝 Playwright 測試框架，建立端到端互動測試
npm install --save-dev @playwright/test playwright

# 安裝瀏覽器依賴（Playwright 所需執行環境）
npx playwright install
```

---

## 10.6 建立 CI 工作流程

建立 `.github/workflows/release.yml`：

```yaml
name: Release Electron App

on:
  push:
    tags:
      - "v*.*.*"

jobs:
  build:
    runs-on: macos-latest
    steps:
      - name: Checkout source
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Run lint
        run: npm run lint

      - name: Run tests
        run: npm run test

      - name: Build distribution
        run: npm run dist
```

---

## 10.7 發版建議流程

```bash
# 先確認工作區乾淨，避免把暫存測試檔打進正式版
git status

# 將本次版本變更加入暫存區
git add .

# 建立 release commit，方便追蹤這次發版內容
git commit -m "release: v1.1.0"

# 建立語意化版本標籤，觸發 CI/CD 發佈流程
git tag v1.1.0

# 推送主分支最新程式碼到遠端
git push origin main

# 單獨推送版本標籤，讓 CI 依 tag 觸發發版工作
git push origin v1.1.0

# 若你習慣一次推送，可改用以下單行指令（二選一）
# git push origin main --tags
```

---

## 10.8 本章小結

- 你建立了可重複的除錯與驗證流程
- 你導入了 Lint、單元測試與 E2E 測試基礎
- 你掌握了以 Git Tag 觸發 CI/CD 發版的實務路線

---

> 恭喜完成 Electron 全課程！建議下一步把課程範例拆成 template repo，方便學員直接 fork 練習。
