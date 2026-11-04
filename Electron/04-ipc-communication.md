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

`invoke` / `handle` 適合「問一件事、等一個結果」。如果 Renderer 只是要通知 Main，不需要等回覆，就用 `ipcRenderer.send` 搭配 `ipcMain.on`。

典型情境是進度回報：工作列（Windows）與 Dock 圖示（macOS）上的進度條只有 Main 能控制，Renderer 只需要一直告訴 Main「現在跑到幾 %」，不必等任何回覆。

`src/preload/preload.js`（延續 4.4 的檔案，在最後追加這一段；檔案開頭已經 `require` 過 `contextBridge` 與 `ipcRenderer`，不要再宣告一次）：

```javascript
// 本節新增：單向通知 Main 更新進度條，不需要回覆所以用 send
contextBridge.exposeInMainWorld("appWindow", {
  setProgress(value) {
    ipcRenderer.send("window:set-progress", value);
  }
});
```

`src/main/ipc/window.ipc.js`：

```javascript
const { BrowserWindow, ipcMain } = require("electron");

function registerWindowIpc() {
  ipcMain.on("window:set-progress", (event, value) => {
    // 不信任 Renderer：只接受 0～1 的數字，或代表「移除進度條」的 -1
    const isValid = Number.isFinite(value) && (value === -1 || (value >= 0 && value <= 1));
    if (!isValid) return;

    // 誰送來的就更新誰的進度條；多視窗之後才不會改錯視窗（第五章 5.4）
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.setProgressBar(value);
  });
}

module.exports = { registerWindowIpc };
```

在 4.3 的 `src/main/main.js` 補上註冊：

```javascript
const { registerWindowIpc } = require("./ipc/window.ipc"); // 加在其他 require 旁邊

app.whenReady().then(() => {
  registerSystemIpc();
  registerWindowIpc(); // 本節新增
  createWindow();
  // ...activate 監聽保留不動
});
```

`src/renderer/index.html` 新增按鈕：

```html
<button id="progressBtn">模擬下載進度</button>
```

`src/renderer/app.js`（加在檔案最後）：

```javascript
// 本節新增：每 300ms 前進 10%，每一步都單向通知 Main，跑完移除進度條
const progressBtn = document.getElementById("progressBtn");

progressBtn.addEventListener("click", () => {
  let step = 0;
  const timer = setInterval(() => {
    step += 1;
    if (step > 10) {
      clearInterval(timer);
      window.appWindow.setProgress(-1);
      return;
    }
    window.appWindow.setProgress(step / 10);
  }, 300);
});
```

重點一樣是白名單：Renderer 傳來的值先檢查型別與範圍，Main 才拿去用。

> 跨平台的 API 要先確認平台再呼叫。admin-dashboard 實戰專案用同樣的 `send` / `on` 模式，在切換主題時通知 Main 改變 Windows / Linux 標題列控制鈕的底色（`setTitleBarOverlay`）。那個 API 只有 Windows 與 Linux 有，而且視窗建立時必須開啟 `titleBarOverlay`，所以 Main 端會先判斷平台，並且只接受 `dark` / `light` 這兩個字串、查表後才使用。`setProgressBar` 則三個平台都能呼叫，只是 Linux 上只有 Unity 桌面會顯示。

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

點擊「讀取系統資訊」後，應看到平台、CPU 核心數與記憶體資訊；點擊「模擬下載進度」後，工作列或 Dock 圖示上應出現跑到 100% 後消失的進度條。

---

## 4.9 IPC 安全守則

- 通道名稱要語意化，例如 `system:get-info`
- 僅在 preload 暴露「必要」功能，不要直接暴露 `ipcRenderer`
- Main 端對輸入參數做驗證，避免惡意資料
- 驗證是誰送來的：preload 會載入到視窗裡的每一個頁面，萬一視窗被導去外部網址，那個頁面一樣能呼叫你暴露的 API。重要的 handler 應檢查 `event.senderFrame` 的網址是否為 App 自己的頁面，第九章 9.5 會實作
- `nodeIntegration` 維持 `false`、`contextIsolation` 維持 `true`
- IPC 參數與回傳值要能被結構化複製：函式、DOM 物件、Promise 傳過去會直接丟出 `An object could not be cloned`；class 實例雖然不會報錯，但到了另一端只剩欄位，prototype 與方法都會遺失
- `ipcMain.handle` 裡若直接拋錯，Renderer 端收到的錯誤會被 Electron 包裝，message 可能變成 `Error invoking remote method ...`，自訂欄位也可能遺失；正式 API 可改回 `{ ok, code, data }` 這類信封格式

---

## 4.10 本章小結

- 你已完成完整的 IPC 流程（Renderer → Preload → Main → Renderer）
- 你已將系統資訊讀取封裝成可維護的通道
- 你掌握了 `invoke` / `send` / `webContents.send` 三種常用通訊模式
- 你知道 IPC 資料傳遞與錯誤傳遞的限制

---

> 下一章：[視窗、選單、系統匣與快捷鍵](./05-window-menu-tray.md)
