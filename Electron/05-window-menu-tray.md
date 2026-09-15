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

## 5.4 開啟子視窗（多視窗控制）

到目前為止整個 App 只有一個 `mainWindow`。真實的桌面產品幾乎都會有第二個視窗——偏好設定、關於、獨立的編輯器分頁。多視窗要處理的不是「怎麼 new 一個 BrowserWindow」（那很簡單），而是三件事：**不要重複開、要跟主視窗有從屬關係、關掉後要清乾淨**。

`src/main/child-window.js`：

```javascript
const path = require("node:path");
const { BrowserWindow } = require("electron");

// 用模組層變數記住已開啟的子視窗，避免使用者連點選單開出一堆一樣的視窗
let aboutWindow = null;

function openAboutWindow(parent) {
  // 已經開著就把它叫到前面，不要再開一個
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    if (aboutWindow.isMinimized()) aboutWindow.restore();
    aboutWindow.focus();
    return aboutWindow;
  }

  aboutWindow = new BrowserWindow({
    width: 420,
    height: 320,
    title: "關於本課程",
    parent, // 從屬於主視窗：主視窗最小化時它會跟著收起、永遠疊在主視窗上方
    modal: false, // 設 true 會變成「必須先關掉它才能操作主視窗」的強制對話框
    resizable: false,
    minimizable: false,
    show: false,
    webPreferences: {
      // 子視窗一樣要帶完整的安全設定，不要因為「只是個小視窗」就省略
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  aboutWindow.setMenuBarVisibility(false); // Windows / Linux：子視窗不需要重複顯示選單列
  aboutWindow.loadFile(path.join(__dirname, "../renderer/about.html"));
  aboutWindow.once("ready-to-show", () => aboutWindow.show());

  // 關掉後把參考清成 null，下次才會重新建立（少了這行，第二次開會撞到已銷毀的物件）
  aboutWindow.on("closed", () => {
    aboutWindow = null;
  });

  return aboutWindow;
}

module.exports = { openAboutWindow };
```

`src/renderer/about.html`：

```html
<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="UTF-8" />
    <title>關於本課程</title>
    <link rel="stylesheet" href="./styles.css" />
    <!-- 子視窗比主視窗小很多，把 styles.css 為主畫面設計的外距調小一點 -->
    <style>
      main {
        margin: 20px;
        max-width: none;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Learn Electron</h1>
      <p>這是一個由子視窗載入的獨立頁面。</p>
      <p id="aboutPlatform"></p>
    </main>
    <script src="./about.js"></script>
  </body>
</html>
```

`src/renderer/about.js`：

```javascript
// 子視窗載入的是同一支 preload，所以第三章暴露的 appInfo 在這裡一樣可用
document.getElementById("aboutPlatform").textContent = `平台：${window.appInfo.getPlatform()}`;
```

三個必須知道的觀念：

- **每個 `BrowserWindow` 都是獨立的 renderer process**，彼此不共用 JavaScript 變數，也拿不到對方的 DOM。視窗之間要傳資料，只能透過 Main 轉手（第四章 4.7 的 `webContents.send` 模式）。
- **`parent` 與 `modal` 是兩件事**：`parent` 決定視覺與生命週期的從屬（跟著主視窗最小化、永遠在上層、主視窗關閉時一起關閉）；`modal: true` 才會鎖住父視窗，適合「非做決定不可」的對話框。偏好設定這種應該用 `modal: false`。
- **`BrowserWindow.getAllWindows()` 會列出所有視窗**，第二章 `window-all-closed` 判斷的就是這個清單。多視窗之後要小心：主視窗被隱藏、但子視窗還開著時，這個事件並不會觸發。

> 想知道某個 IPC 是哪個視窗發出來的，用 `BrowserWindow.fromWebContents(event.sender)`——這在只有一個視窗時無所謂，多視窗之後就是必備寫法（第七章的對話框、4.6 的標題列主題都用了它）。

---

## 5.5 建立應用選單

`src/main/menu.js`：

```javascript
const { app, Menu, shell } = require("electron");
const { openAboutWindow } = require("./child-window"); // 5.4

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
          // 5.4 的子視窗：從選單開啟，不需要經過 preload / IPC
          label: "關於本課程",
          click: () => openAboutWindow(mainWindow)
        },
        { type: "separator" },
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

## 5.6 建立系統匣（Tray）

`src/main/tray.js`：

```javascript
const path = require("node:path");
const { Tray, Menu } = require("electron");

let tray = null;

function createTray(mainWindow) {
  tray = new Tray(path.join(__dirname, "../../assets/trayTemplate.png"));
  tray.setToolTip("Learn Electron");

  function showMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  function hideMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.hide();
  }

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "顯示主視窗",
      click: showMainWindow
    },
    {
      label: "隱藏主視窗",
      click: hideMainWindow
    },
    { type: "separator" },
    { role: "quit", label: "離開" }
  ]);

  tray.setContextMenu(contextMenu);
}

module.exports = { createTray };
```

有系統匣的 App 通常不把「按視窗關閉鈕」視為結束程式，而是把主視窗藏到背景。否則在 macOS 上關窗後 App 仍活著，但 Tray 選單手上拿的是已銷毀的 `BrowserWindow`，下一次點「顯示主視窗」就會丟出 `Object has been destroyed`。

因此 `main.js` 要加上這段生命週期控制：

```javascript
let isQuitting = false;

function createMainWindow() {
  // ...建立 BrowserWindow 與 loadFile

  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.on("before-quit", () => {
  isQuitting = true;
});
```

---

## 5.7 全域快捷鍵

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
> 如果只是想在 App 自己的視窗內提供快捷鍵，應改用選單項目的 `accelerator`（如 5.5 的 `CmdOrCtrl+R`），它只在 App 為前景視窗時生效，不會干擾其他程式。本例註冊 `CommandOrControl+Shift+I` 純粹為了示範 API；實務上「開關 DevTools」這種功能建議放在選單的 `accelerator`。

---

## 5.8 確保只有一個實例（單一實例鎖）

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
    if (mainWindow && !mainWindow.isDestroyed()) {
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

重點：**所有 `app.whenReady()` 的內容都要搬進 `else` 區塊**。如果拿不到鎖卻還是建了視窗，就等於沒鎖。5.9 的完整 `main.js` 會把這個結構整合進來。

> 補充：`second-instance` 事件的回呼還會收到 `(event, argv, workingDirectory)`，第二份程序的命令列參數會透過 `argv` 傳進來。第七章的「深層連結」會用到這個參數——在 Windows 上，`myapp://...` 這類自訂協定被點開時，網址就是夾在 `argv` 裡送達的。

---

## 5.9 在 main.js 串接功能

`src/main/main.js`（完整檔案，包含第四章的 IPC 註冊、本章的選單／系統匣／快捷鍵，以及 5.8 的單一實例鎖）：

```javascript
const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const { registerSystemIpc } = require("./ipc/system.ipc");
const { buildAppMenu } = require("./menu");
const { createTray } = require("./tray");
const { registerShortcuts, unregisterShortcuts } = require("./shortcut");

let mainWindow;
let isQuitting = false;

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

  // 有系統匣時，按視窗關閉鈕只隱藏；真正離開由選單/托盤的 quit 觸發
  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// 5.8：單一實例鎖——拿不到鎖代表已有一份在跑，直接結束
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  // 使用者又啟動了一次：把既有視窗叫回前景，而不是開新視窗
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
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
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        return;
      }
      createMainWindow();
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

app.on("before-quit", () => {
  isQuitting = true;
});
```

---

## 5.10 執行驗證

```bash
# 啟動應用，驗證視窗、選單、系統匣、快捷鍵是否都正常
npm run dev
```

檢查項目：

- 選單列是否可使用「重新整理」與「官方文件」，macOS 上是否出現 App 名稱選單與「編輯」選單
- 「說明 → 關於本課程」是否開出子視窗；**連點多次是否只會有一個子視窗**、關掉後再點是否還能重新開啟
- 系統匣是否可顯示/隱藏視窗，按視窗關閉鈕後是否能再從系統匣叫回
- `Cmd/Ctrl + Shift + I` 是否可開關 DevTools
- 重複啟動 App（再次 `npm run dev` 或再點一次圖示）時，是否只會把既有視窗帶回前景、而非開出第二份

---

## 5.11 本章小結

- 你已具備桌面應用核心互動能力
- 你會開出從屬於主視窗的子視窗，並避免重複開啟與參考殘留
- 你可用系統匣讓 App 在背景運作
- 你可透過快捷鍵提升操作效率
- 你用單一實例鎖避免 App 被重複開啟，並讓選單在 macOS 上行為正確

---

> 下一章：[本機資料儲存與設定管理](./06-data-storage-config.md)
