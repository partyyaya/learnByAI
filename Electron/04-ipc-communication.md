# 第四章：IPC 通訊與安全橋接實作

## 4.1 IPC 是什麼？

IPC（Inter-Process Communication）是 Electron 中 Main 與 Renderer 互相傳遞資料的機制。  
常見情境：

- Renderer 想讀檔案（必須由 Main 代做）
- Renderer 想呼叫系統 API（例如顯示原生對話框）
- Renderer 想取得應用程式版本、系統資訊

---

## 4.2 建立 IPC 模組

```bash
# 建立 main 端的 ipc 目錄，集中管理所有事件通道
mkdir -p src/main/ipc

# 建立範例 handler 檔案，用來回傳系統資訊
touch src/main/ipc/system.ipc.js
```

`src/main/ipc/system.ipc.js`：

```javascript
const os = require("node:os");
const { app, ipcMain } = require("electron");

function registerSystemIpc() {
  ipcMain.handle("app:get-version", async () => app.getVersion());

  ipcMain.handle("system:get-info", async () => {
    return {
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      memoryGB: Math.round(os.totalmem() / 1024 / 1024 / 1024)
    };
  });
}

module.exports = { registerSystemIpc };
```

---

## 4.3 在 Main 註冊 IPC Handler

`src/main/main.js`：

```javascript
const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const { registerSystemIpc } = require("./ipc/system.ipc");

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
  registerSystemIpc();
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

## 4.4 在 Preload 開放安全 API

`src/preload/preload.js`（完整檔案，保留第三章的 `appInfo`，但把示範版號改成向 Main 讀真實版號；另新增 `systemApi`）：

```javascript
const { contextBridge, ipcRenderer } = require("electron");

// 第三章建立的 appInfo API；版本號從本章起改向 Main 讀真實 app 版本
contextBridge.exposeInMainWorld("appInfo", {
  getVersion() {
    return ipcRenderer.invoke("app:get-version");
  },
  getPlatform() {
    return process.platform;
  }
});

// 本章新增：透過 IPC 向 Main 要求系統資訊
contextBridge.exposeInMainWorld("systemApi", {
  getInfo() {
    return ipcRenderer.invoke("system:get-info");
  }
});
```

---

## 4.5 Renderer 呼叫並顯示資料

`src/renderer/index.html` 新增按鈕：

```html
<button id="systemInfoBtn">讀取系統資訊</button>
<pre id="systemInfoOutput"></pre>
```

`src/renderer/app.js`（完整檔案，保留第三章的按鈕行為，新增系統資訊區塊）：

```javascript
const message = document.getElementById("message");
const helloBtn = document.getElementById("helloBtn");

// 第三章的按鈕行為，保留不動
helloBtn.addEventListener("click", async () => {
  const version = await window.appInfo.getVersion();
  const platform = window.appInfo.getPlatform();

  message.textContent = `版本：${version}，平台：${platform}`;
});

// 本章新增：讀取系統資訊並顯示
const systemInfoBtn = document.getElementById("systemInfoBtn");
const systemInfoOutput = document.getElementById("systemInfoOutput");

systemInfoBtn.addEventListener("click", async () => {
  const info = await window.systemApi.getInfo();
  systemInfoOutput.textContent = JSON.stringify(info, null, 2);
});
```

---

## 4.6 單向通知：Renderer → Main

`invoke` / `handle` 適合「問一件事、等一個結果」。如果 Renderer 只是要通知 Main，不需要等回覆，就用 `ipcRenderer.send` 搭配 `ipcMain.on`。admin-dashboard 的自訂標題列主題就是這種情境：畫面已經先切主題，順手通知 Main 更新 Windows / Linux 的系統控制鈕底色。

`src/preload/preload.js`（延續 4.4 的檔案，在最後追加這一段；檔案開頭的 `require` 已經有了，不用重複寫）：

```javascript
const { contextBridge, ipcRenderer } = require("electron"); // 4.4 已宣告，此處僅為完整示意

contextBridge.exposeInMainWorld("appWindow", {
  setTitleBarTheme(theme) {
    ipcRenderer.send("titlebar:theme", theme);
  }
});
```

`src/main/ipc/window.ipc.js`：

```javascript
const { BrowserWindow, ipcMain } = require("electron");

const IS_MAC = process.platform === "darwin";

const TITLEBAR_THEMES = {
  dark: { color: "#161b22", symbolColor: "#e6edf3" },
  light: { color: "#ffffff", symbolColor: "#16202c" }
};

function registerWindowIpc() {
  ipcMain.on("titlebar:theme", (event, theme) => {
    const overlay = TITLEBAR_THEMES[theme];
    const win = BrowserWindow.fromWebContents(event.sender);
    // macOS 的紅綠燈按鈕由系統繪製，改不動；setTitleBarOverlay 也只有 Windows / Linux 提供
    if (!overlay || !win || IS_MAC || typeof win.setTitleBarOverlay !== "function") return;
    win.setTitleBarOverlay({ height: 32, ...overlay });
  });
}

module.exports = { registerWindowIpc };
```

重點一樣是白名單：Renderer 傳來的 `theme` 不是 CSS 顏色，而是 `dark` / `light` 這種有限字串，Main 端查表後才使用。

另外注意 `IS_MAC` 這道防線：`setTitleBarOverlay` 只支援 Windows 與 Linux，macOS 上那三顆紅綠燈是系統畫的、改不了顏色。admin-dashboard 實戰專案就是這樣寫的——**跨平台 API 要先判斷平台再呼叫**，不要只靠 `typeof` 檢查碰運氣。

---

## 4.7 推送事件：Main → Renderer

另一個常見模式是 Main 主動推送事件給畫面，例如第七章的深層連結：作業系統把 `myapp://...` 交給 Main，Main 再通知 Renderer 更新 UI。這時 Main 用 `webContents.send`，preload 用 `ipcRenderer.on` 包成安全的訂閱函式，並回傳取消訂閱函式。

Main 端：

```javascript
mainWindow.webContents.send("deeplink:received", url);
```

Preload 端：

```javascript
contextBridge.exposeInMainWorld("deeplinkApi", {
  onReceived(callback) {
    const listener = (_event, url) => callback(url);
    ipcRenderer.on("deeplink:received", listener);
    return () => ipcRenderer.off("deeplink:received", listener);
  }
});
```

Renderer 端：

```javascript
const unsubscribe = window.deeplinkApi.onReceived((url) => {
  console.log("收到深層連結：", url);
});

window.addEventListener("beforeunload", unsubscribe);
```

不要把 `event` 物件傳給 Renderer，因為它帶著 Electron 內部能力；只把你要給前端的資料抽出來傳入 callback。

---

## 4.8 執行驗證

```bash
# 重新啟動應用程式，讓新的 IPC 註冊與 preload 變更生效
npm run dev
```

點擊「讀取系統資訊」後，應看到平台、CPU 核心數與記憶體資訊。

---

## 4.9 IPC 安全守則

- 通道名稱要語意化，例如 `system:get-info`
- 僅在 preload 暴露「必要」功能，不要直接暴露 `ipcRenderer`
- Main 端對輸入參數做驗證，避免惡意資料
- `nodeIntegration` 維持 `false`、`contextIsolation` 維持 `true`
- IPC 參數與回傳值要能被結構化複製；不要傳 DOM 物件、函式、class 實例或帶複雜 prototype 的物件，否則常會遇到 `An object could not be cloned`
- `ipcMain.handle` 裡若直接拋錯，Renderer 端收到的錯誤會被 Electron 包裝，message 可能變成 `Error invoking remote method ...`，自訂欄位也可能遺失；正式 API 可改回 `{ ok, code, data }` 這類信封格式

---

## 4.10 本章小結

- 你已完成完整的 IPC 流程（Renderer → Preload → Main → Renderer）
- 你已將系統資訊讀取封裝成可維護的通道
- 你掌握了 `invoke` / `send` / `webContents.send` 三種常用通訊模式
- 你知道 IPC 資料傳遞與錯誤傳遞的限制

---

> 下一章：[視窗、選單、系統匣與快捷鍵](./05-window-menu-tray.md)
