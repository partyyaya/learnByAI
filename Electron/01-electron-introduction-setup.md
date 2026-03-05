# 第一章：Electron 介紹與開發環境安裝

## 1.1 什麼是 Electron？

Electron 是一個讓你用 **Web 技術（HTML / CSS / JavaScript）** 開發桌面應用程式的框架。  
它結合了：

- **Chromium**：負責畫面渲染（像瀏覽器）
- **Node.js**：負責檔案系統、程序控制等後端能力

因此你可以用一套程式碼，同時支援 macOS / Windows / Linux。

---

## 1.2 先備知識與環境需求

- Node.js 20 LTS+
- npm 10+
- 熟悉 JavaScript（建議至少 ES6）
- 了解基本命令列操作

---

## 1.3 安裝與版本檢查

```bash
# 檢查目前 Node.js 版本，確認是否已安裝且版本足夠
node -v

# 檢查 npm 版本，避免套件管理指令不相容
npm -v
```

如果你是 macOS 且尚未安裝 Node.js，可用 Homebrew：

```bash
# 使用 Homebrew 安裝 Node.js（會一併提供 npm）
brew install node

# 安裝後再次驗證 Node.js 版本
node -v

# 安裝後再次驗證 npm 版本
npm -v
```

---

## 1.4 建立 Electron 專案

```bash
# 建立課程練習專案資料夾
mkdir electron-course-app

# 進入專案資料夾
cd electron-course-app

# 初始化 package.json（-y 代表使用預設值）
npm init -y

# 安裝 Electron 為開發依賴，因為它只在開發/打包時需要
npm install --save-dev electron
```

---

## 1.5 設定啟動指令

請在 `package.json` 裡加入：

```json
{
  "name": "electron-course-app",
  "version": "1.0.0",
  "description": "Electron 課程示範",
  "main": "main.js",
  "scripts": {
    "dev": "electron ."
  }
}
```

說明：

- `main`: Electron 啟動時會先執行的主程序檔案
- `dev`: 執行 `electron .` 代表以當前專案作為應用程式根目錄啟動
- `devDependencies` 會在你執行 `npm install --save-dev electron` 後由 npm 自動寫入

---

## 1.6 建立最小可執行檔案

先建立 `main.js`：

```javascript
const { app, BrowserWindow } = require("electron");

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 700
  });

  win.loadURL("data:text/html,<h1>Hello Electron</h1>");
}

app.whenReady().then(createWindow);
```

---

## 1.7 啟動應用程式

```bash
# 啟動 Electron 應用，驗證專案是否可正常開窗
npm run dev
```

若成功，你會看到一個桌面視窗顯示 `Hello Electron`。

---

## 1.8 本章小結

- Electron 讓前端技術可直接開發桌面應用
- 你已完成 Node.js 環境檢查與專案初始化
- 你已成功建立並啟動第一個最小 Electron 程式

---

> 下一章：[建立第一個 Electron 應用程式](./02-first-app-quick-start.md)
