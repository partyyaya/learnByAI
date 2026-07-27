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
const { app, Menu, shell } = require("electron");

const isMac = process.platform === "darwin";

function buildAppMenu(mainWindow) {
  const template = [
    // macOS 慣例：template 的「第一個」項目一定會被當成 App 名稱選單（畫面上粗體的那個）。
    // 用展開語法依平台決定放不放：非 macOS 平台沒有這個項目。
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about", label: `關於 ${app.name}` },
              { type: "separator" },
              { role: "quit", label: `結束 ${app.name}` }
            ]
          }
        ]
      : []),
    {
      label: "檔案",
      submenu: [
        {
          label: "重新整理",
          accelerator: "CmdOrCtrl+R",
          click: () => mainWindow.reload()
        },
        { type: "separator" },
        // macOS 的「結束」已放在 App 名稱選單，這裡改放「關閉視窗」；其他平台放「離開」
        isMac ? { role: "close", label: "關閉視窗" } : { role: "quit", label: "離開" }
      ]
    },
    {
      // 少了這個「編輯」選單，macOS 的 Cmd+C / Cmd+V / Cmd+A 在輸入框裡會失效——
      // 這些快捷鍵在 macOS 是由選單項目的 role 提供的，不是瀏覽器內建行為。
      label: "編輯",
      submenu: [
        { role: "undo", label: "復原" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪下" },
        { role: "copy", label: "複製" },
        { role: "paste", label: "貼上" },
        { role: "selectAll", label: "全選" }
      ]
    },
    {
      label: "說明",
      submenu: [
        {
          // 這是 main 端寫死的可信網址，直接 openExternal 即可；
          // 第七章會處理「來自 Renderer 的網址」為何要先過白名單驗證。
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

> 為什麼要依平台分岔？兩個 macOS 專屬的坑：
>
> 1. **第一個項目會變成 App 名稱選單**：不管你把它 label 成什麼，macOS 都會把 template 的第一項當成那個粗體的 App 名稱選單。若照 Windows 的寫法把「檔案」放第一個，在 macOS 上就不會出現獨立的「檔案」選單，內容會被塞進 App 名稱底下，跨平台外觀不一致。因此上面用 `isMac` 判斷，只有 macOS 才 prepend `app.name` 這個項目。
> 2. **沒有 Edit 選單 = 複製貼上壞掉**：macOS 的 `Cmd+C / Cmd+V / Cmd+X / Cmd+A` 是綁在選單項目的 `role` 上的。只要應用程式有輸入框（`<input>`、`<textarea>`、可編輯區），卻沒提供帶 `editMenu` role 的選單，這些快捷鍵就完全沒反應。本課程 demo 沒有輸入框所以不明顯，但一做真實表單就會踩到，務必保留「編輯」選單。
>
> 補充：`role: "editMenu"` 其實可以一行帶出整組標準編輯項目（`Menu.buildFromTemplate([{ role: "editMenu" }])`）。這裡刻意展開成逐項，是為了讓你看到每個 role 的中文標籤怎麼設；實務上想省事可直接用 `{ role: "editMenu" }`。

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

## 5.7 確保只有一個實例（單一實例鎖）

桌面應用通常**不希望被開成好幾份**：使用者重複點圖示、或從系統匣又啟動一次時，正確行為是「把既有視窗叫回前景」，而不是再開一個新程序。Electron 用 `app.requestSingleInstanceLock()` 處理這件事——第一份程序拿到鎖，之後啟動的程序拿不到鎖就立刻結束，並把啟動事件轉交給第一份程序：

```javascript
// 嘗試取得「單一實例鎖」；第一份程序會拿到 true，之後啟動的會拿到 false
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // 已經有一份在跑，這一份直接退出
  app.quit();
} else {
  // 有人又啟動了一次（例如再點一次圖示）：把既有視窗叫回前景
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });

  // 只有拿到鎖的那份才真正建立視窗、註冊功能
  app.whenReady().then(() => {
    // ...建立視窗與各項功能
  });
}
```

重點：**所有 `app.whenReady()` 的內容都要搬進 `else` 區塊**。如果拿不到鎖卻還是建了視窗，就等於沒鎖。下一節的完整 `main.js` 會把這個結構整合進來。

> 補充：`second-instance` 事件的回呼還會收到 `(event, argv, workingDirectory)`，第二份程序的命令列參數會透過 `argv` 傳進來。第七章的「深層連結」會用到這個參數——在 Windows 上，`myapp://...` 這類自訂協定被點開時，網址就是夾在 `argv` 裡送達的。

---

## 5.8 在 main.js 串接功能

`src/main/main.js`（完整檔案，包含第四章的 IPC 註冊、本章的選單／系統匣／快捷鍵，以及 5.7 的單一實例鎖）：

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

  // 開發模式自動打開 DevTools；打包後（app.isPackaged 為 true）不打開
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
}

// 5.7：單一實例鎖——拿不到鎖代表已有一份在跑，直接結束
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  // 使用者又啟動了一次：把既有視窗叫回前景，而不是開新視窗
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });

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
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// 離開前解除全域快捷鍵，避免殘留註冊
app.on("will-quit", () => {
  unregisterShortcuts();
});
```

---

## 5.9 執行驗證

```bash
# 啟動應用，驗證視窗、選單、系統匣、快捷鍵是否都正常
npm run dev
```

檢查項目：

- 選單列是否可使用「重新整理」與「官方文件」，macOS 上是否出現 App 名稱選單與「編輯」選單
- 系統匣是否可顯示/隱藏視窗
- `Cmd/Ctrl + Shift + I` 是否可開關 DevTools
- 重複啟動 App（再次 `npm run dev` 或再點一次圖示）時，是否只會把既有視窗帶回前景、而非開出第二份

---

## 5.10 本章小結

- 你已具備桌面應用核心互動能力
- 你可用系統匣讓 App 在背景運作
- 你可透過快捷鍵提升操作效率
- 你用單一實例鎖避免 App 被重複開啟，並讓選單在 macOS 上行為正確

---

> 下一章：[本機資料儲存與設定管理](./06-data-storage-config.md)
