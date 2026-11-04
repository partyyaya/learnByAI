# 第三章：Main / Renderer / Preload 架構解析

## 3.1 為什麼要分三層？

Electron 應用主要由三個區塊組成：

- **Main Process（主程序）**：控制應用生命週期、視窗與系統資源
- **Renderer Process（渲染程序）**：負責 UI（HTML/CSS/JS）
- **Preload Script（預載腳本）**：安全地橋接 Main 與 Renderer

這三者不是三個進程。Electron 只有兩種進程：一個 Main process，加上每個視窗各自一個 Renderer process。Preload 是在 Renderer process 裡、網頁腳本執行**之前**先跑的一段程式；它和網頁在同一個進程，但處在隔離的 JavaScript 環境（`contextIsolation`），網頁碰不到它手上的 Electron API，只能使用它透過 `contextBridge` 刻意開放的函式。

---

## 3.2 調整專案結構

```bash
# 建立 main 與 preload 目錄，讓程式責任更清楚
mkdir -p src/main src/preload

# 將原本根目錄 main.js 移到 src/main 以符合分層架構
mv main.js src/main/main.js

# 建立 preload 腳本檔案，稍後用於安全橋接 API
touch src/preload/preload.js
```

調整後結構：

```text
electron-course-app/
├─ package.json
└─ src/
   ├─ main/
   │  └─ main.js
   ├─ preload/
   │  └─ preload.js
   └─ renderer/
      ├─ index.html
      ├─ styles.css
      └─ app.js
```

---

## 3.3 更新 package.json 入口

```json
{
  "main": "src/main/main.js",
  "scripts": {
    "dev": "electron ."
  }
}
```

---

## 3.4 在 Main 指定 Preload

`src/main/main.js`：

```javascript
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  win.loadFile(path.join(__dirname, "../renderer/index.html"));

  // 延續第二章：開發模式自動打開 DevTools，打包後不觸發
  if (!app.isPackaged) win.webContents.openDevTools();
}

app.whenReady().then(() => {
  createWindow();

  // 延續第二章的慣例：macOS 點擊 Dock 圖示且無視窗時重建主視窗
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 延續第二章的慣例：非 macOS 平台在視窗全關時結束程式
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
```

---

## 3.5 用 Preload 暴露安全 API

`src/preload/preload.js`：

```javascript
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("appInfo", {
  getVersion() {
    return "1.0.0-course-demo";
  },
  getPlatform() {
    return process.platform;
  }
});
```

寫 preload 時一定會遇到兩個限制：

- **不能直接掛到 `window` 上**：因為 `contextIsolation`，preload 裡寫 `window.appInfo = {...}`，網頁那邊看不到，一定要經過 `contextBridge.exposeInMainWorld`。傳過橋的物件會被複製一份，函式會被包成代理，class 實例的 prototype 與方法則會遺失，所以暴露的 API 最好是「一組普通函式 + 純資料」。
- **preload 預設跑在 sandbox 裡**：Electron 20 起 renderer 預設 `sandbox: true`，preload 只能 `require("electron")` 與少數內建模組（例如 `events`、`timers`、`url`），`require("node:fs")` 或 `require("./helper")` 都會失敗。`process.platform` 這類唯讀資訊仍然讀得到，所以上面的範例沒問題。要讀檔或使用系統功能，就交給 Main 去做、透過下一章的 IPC 呼叫；第九章 9.3 會再完整說明 sandbox。

---

## 3.6 Renderer 呼叫 Preload API

`src/renderer/app.js`：

```javascript
const message = document.getElementById("message");
const helloBtn = document.getElementById("helloBtn");

helloBtn.addEventListener("click", () => {
  const version = window.appInfo.getVersion();
  const platform = window.appInfo.getPlatform();

  message.textContent = `版本：${version}，平台：${platform}`;
});
```

---

## 3.7 執行與驗證

```bash
# 啟動應用程式，驗證 preload API 是否能在 renderer 正常呼叫
npm run dev
```

測試方式：點擊按鈕後，畫面應顯示版本與平台資訊。

---

## 3.8 本章小結

- 你理解了 Electron 的三層責任分工
- 你完成了 `main`、`renderer`、`preload` 的標準分層
- 你學會用 `contextBridge` 安全暴露功能

---

> 下一章：[IPC 通訊與安全橋接實作](./04-ipc-communication.md)
