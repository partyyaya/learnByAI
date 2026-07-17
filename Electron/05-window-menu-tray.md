# 第五章：視窗、選單、系統匣與快捷鍵

## 5.1 章節目標

本章會讓你的應用程式更像「真正的桌面產品」，包含：

- 多視窗控制
- 原生選單（Menu）
- 系統匣（Tray）
- 全域快捷鍵（Global Shortcut）

---

## 5.2 準備圖示檔

```bash
# 建立 assets 目錄，集中放應用圖示與靜態資源
mkdir -p assets
```

接著請放入一張**真實的 PNG 圖檔** `assets/trayTemplate.png`（建議 16×16 或 22×22 像素）。

> 兩個常見陷阱：
>
> 1. 不要用 `touch` 建立空檔案充數——空圖檔不會報錯，但系統匣圖示會是「隱形」的，看起來就像功能壞掉。
> 2. 檔名結尾的 `Template` 是 macOS 的特殊命名慣例：以 `Template` 結尾的圖示會被視為「模板圖片」（只使用黑色與透明兩色），macOS 會依選單列的深淺色模式自動反轉顏色。若不需要此行為，改用一般檔名即可；Windows / Linux 則不受此慣例影響。

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

> `globalShortcut` 是「**系統層級**」的快捷鍵：即使 App 不在前景、甚至視窗全部隱藏，按下組合鍵仍會被你的 App 攔截，並且會**蓋掉其他軟體對同一組合鍵的使用**。它適合「從背景喚出 App」這類場景。
>
> 如果只是想在 App 自己的視窗內提供快捷鍵，應改用選單項目的 `accelerator`（如 5.4 的 `CmdOrCtrl+R`），它只在 App 為前景視窗時生效，不會干擾其他程式。本例註冊 `CommandOrControl+Shift+I` 純粹為了示範 API；實務上「開關 DevTools」這種功能建議放在選單的 `accelerator`。

---

## 5.7 在 main.js 串接功能

`src/main/main.js`（完整檔案，包含第四章的 IPC 註冊與本章的選單、系統匣、快捷鍵）：

```javascript
const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const { registerSystemIpc } = require("./ipc/system.ipc");
const { buildAppMenu } = require("./menu");
const { createTray } = require("./tray");
const { registerShortcuts, unregisterShortcuts } = require("./shortcut");

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

app.whenReady().then(() => {
  registerSystemIpc(); // 第四章
  createMainWindow();
  buildAppMenu(mainWindow); // 本章新增
  createTray(mainWindow); // 本章新增
  registerShortcuts(mainWindow); // 本章新增

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// 離開前解除全域快捷鍵，避免殘留註冊
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
