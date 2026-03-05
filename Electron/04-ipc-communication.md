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
const { ipcMain } = require("electron");

function registerSystemIpc() {
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
}

app.whenReady().then(() => {
  registerSystemIpc();
  createWindow();
});
```

---

## 4.4 在 Preload 開放安全 API

`src/preload/preload.js`：

```javascript
const { contextBridge, ipcRenderer } = require("electron");

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

`src/renderer/app.js`：

```javascript
const systemInfoBtn = document.getElementById("systemInfoBtn");
const systemInfoOutput = document.getElementById("systemInfoOutput");

systemInfoBtn.addEventListener("click", async () => {
  const info = await window.systemApi.getInfo();
  systemInfoOutput.textContent = JSON.stringify(info, null, 2);
});
```

---

## 4.6 執行驗證

```bash
# 重新啟動應用程式，讓新的 IPC 註冊與 preload 變更生效
npm run dev
```

點擊「讀取系統資訊」後，應看到平台、CPU 核心數與記憶體資訊。

---

## 4.7 IPC 安全守則

- 通道名稱要語意化，例如 `system:get-info`
- 僅在 preload 暴露「必要」功能，不要直接暴露 `ipcRenderer`
- Main 端對輸入參數做驗證，避免惡意資料
- `nodeIntegration` 維持 `false`、`contextIsolation` 維持 `true`

---

## 4.8 本章小結

- 你已完成完整的 IPC 流程（Renderer → Preload → Main → Renderer）
- 你已將系統資訊讀取封裝成可維護的通道
- 你掌握了 IPC 的基本安全原則

---

> 下一章：[視窗、選單、系統匣與快捷鍵](./05-window-menu-tray.md)
