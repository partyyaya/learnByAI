# 第二章：建立第一個 Electron 應用程式

## 2.1 章節目標

這一章要完成一個「可互動」的桌面程式，並建立清楚的專案結構。

---

## 2.2 建立基礎目錄與檔案

```bash
# 建立 renderer 資料夾，放前端畫面相關檔案
mkdir -p src/renderer

# 建立主程序、HTML、CSS、JavaScript 檔案
touch main.js src/renderer/index.html src/renderer/styles.css src/renderer/app.js
```

建議結構如下：

```text
electron-course-app/
├─ main.js
├─ package.json
└─ src/
   └─ renderer/
      ├─ index.html
      ├─ styles.css
      └─ app.js
```

---

## 2.3 主程序載入本機頁面

更新 `main.js`：

```javascript
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  win.loadFile(path.join(__dirname, "src/renderer/index.html"));
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
```

---

## 2.4 建立前端畫面

`src/renderer/index.html`：

```html
<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Electron Quick Start</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <main>
      <h1>我的第一個 Electron App</h1>
      <p id="message">按下按鈕看看互動效果</p>
      <button id="helloBtn">點我</button>
    </main>
    <script src="./app.js"></script>
  </body>
</html>
```

`src/renderer/styles.css`：

```css
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #f6f7fb;
}

main {
  max-width: 560px;
  margin: 80px auto;
  padding: 24px;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.08);
}

button {
  border: 0;
  border-radius: 8px;
  padding: 10px 16px;
  background: #4f46e5;
  color: #fff;
  cursor: pointer;
}
```

`src/renderer/app.js`：

```javascript
const message = document.getElementById("message");
const helloBtn = document.getElementById("helloBtn");

helloBtn.addEventListener("click", () => {
  message.textContent = `你好，現在時間是 ${new Date().toLocaleTimeString()}`;
});
```

---

## 2.5 啟動與驗證

```bash
# 以開發模式啟動 Electron，確認視窗與頁面都正常
npm run dev
```

你應該可以看到按鈕被點擊後，文字會即時更新。

---

## 2.6 提升開發效率（選配）

若想每次改檔後自動重啟，可安裝 `electronmon`：

```bash
# 安裝 electronmon，讓開發中可自動重啟 Electron
npm install --save-dev electronmon
```

`package.json` 可新增：

```json
{
  "scripts": {
    "dev": "electron .",
    "dev:watch": "electronmon ."
  }
}
```

```bash
# 啟動可監看檔案變更的開發模式
npm run dev:watch
```

---

## 2.7 本章小結

- 你已完成標準化的 Electron 專案目錄
- 你已從主程序成功載入本機 HTML
- 你已建立可互動的渲染畫面

---

> 下一章：[Main / Renderer / Preload 架構解析](./03-main-renderer-preload.md)
