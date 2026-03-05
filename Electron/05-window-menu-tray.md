# 第五章：視窗、選單、系統匣與快捷鍵

## 5.1 章節目標

本章會讓你的應用程式更像「真正的桌面產品」，包含：

- 多視窗控制
- 原生選單（Menu）
- 系統匣（Tray）
- 全域快捷鍵（Global Shortcut）

---

## 5.2 準備圖示檔（可選）

```bash
# 建立 assets 目錄，集中放應用圖示與靜態資源
mkdir -p assets

# 建立系統匣圖示檔（請自行替換成真實 png）
touch assets/trayTemplate.png
```

---

## 5.3 視窗管理範例

`src/main/main.js`（節錄）：

```javascript
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

let mainWindow;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "Learn Electron",
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
}
```

---

## 5.4 建立應用選單

`src/main/menu.js`：

```javascript
const { Menu, shell } = require("electron");

function buildAppMenu(mainWindow) {
  const template = [
    {
      label: "檔案",
      submenu: [
        {
          label: "重新整理",
          accelerator: "CmdOrCtrl+R",
          click: () => mainWindow.reload()
        },
        { type: "separator" },
        { role: "quit", label: "離開" }
      ]
    },
    {
      label: "說明",
      submenu: [
        {
          label: "官方文件",
          click: () => shell.openExternal("https://www.electronjs.org/docs")
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

module.exports = { buildAppMenu };
```

---

## 5.5 建立系統匣（Tray）

`src/main/tray.js`：

```javascript
const path = require("node:path");
const { Tray, Menu } = require("electron");

let tray = null;

function createTray(mainWindow) {
  tray = new Tray(path.join(__dirname, "../../assets/trayTemplate.png"));
  tray.setToolTip("Learn Electron");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "顯示主視窗",
      click: () => mainWindow.show()
    },
    {
      label: "隱藏主視窗",
      click: () => mainWindow.hide()
    },
    { type: "separator" },
    { role: "quit", label: "離開" }
  ]);

  tray.setContextMenu(contextMenu);
}

module.exports = { createTray };
```

---

## 5.6 全域快捷鍵

`src/main/shortcut.js`：

```javascript
const { globalShortcut } = require("electron");

function registerShortcuts(mainWindow) {
  globalShortcut.register("CommandOrControl+Shift+I", () => {
    mainWindow.webContents.toggleDevTools();
  });
}

function unregisterShortcuts() {
  globalShortcut.unregisterAll();
}

module.exports = { registerShortcuts, unregisterShortcuts };
```

---

## 5.7 在 main.js 串接功能

```javascript
// ...省略既有 import
const { buildAppMenu } = require("./menu");
const { createTray } = require("./tray");
const { registerShortcuts, unregisterShortcuts } = require("./shortcut");

app.whenReady().then(() => {
  createMainWindow();
  buildAppMenu(mainWindow);
  createTray(mainWindow);
  registerShortcuts(mainWindow);
});

app.on("will-quit", () => {
  unregisterShortcuts();
});
```

---

## 5.8 執行驗證

```bash
# 啟動應用，驗證視窗、選單、系統匣、快捷鍵是否都正常
npm run dev
```

檢查項目：

- 選單列是否可使用「重新整理」與「官方文件」
- 系統匣是否可顯示/隱藏視窗
- `Cmd/Ctrl + Shift + I` 是否可開關 DevTools

---

## 5.9 本章小結

- 你已具備桌面應用核心互動能力
- 你可用系統匣讓 App 在背景運作
- 你可透過快捷鍵提升操作效率

---

> 下一章：[本機資料儲存與設定管理](./06-data-storage-config.md)
