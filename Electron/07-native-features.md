# 第七章：原生能力整合（通知、對話框、剪貼簿）

## 7.1 章節目標

本章會把 Electron 的系統整合能力接到你的 App：

- 系統通知（Notification）
- 原生對話框（Dialog）
- 剪貼簿（Clipboard）
- 開啟外部連結（Shell）

---

## 7.2 Main 端建立原生功能 IPC

先建立一個 URL 驗證工具。`shell.openExternal` 是 Electron 最常見的攻擊面之一：若直接把 Renderer 傳來的字串丟給它，一旦頁面被 XSS，攻擊者就能開啟 `file://` 或其他危險協定。因此 Main 端必須先驗證：

```bash
# 建立 main 端共用工具目錄
mkdir -p src/main/utils
```

`src/main/utils/url-guard.js`：

```javascript
// 允許開啟的網域白名單，依專案需求增減
const ALLOWED_HOSTS = new Set(["www.electronjs.org", "github.com"]);

function isSafeExternalUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  return url.protocol === "https:" && ALLOWED_HOSTS.has(url.hostname);
}

module.exports = { isSafeExternalUrl };
```

`src/main/ipc/native.ipc.js`：

```javascript
const { ipcMain, dialog, Notification, clipboard, shell } = require("electron");
const { isSafeExternalUrl } = require("../utils/url-guard");

function registerNativeIpc() {
  ipcMain.handle("native:show-open-dialog", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"]
    });
    return result;
  });

  ipcMain.handle("native:notify", async (_event, payload) => {
    const notification = new Notification({
      title: payload?.title || "提醒",
      body: payload?.body || "這是一則通知"
    });
    notification.show();
    return { ok: true };
  });

  ipcMain.handle("native:copy", async (_event, text) => {
    clipboard.writeText(text || "");
    return { ok: true };
  });

  ipcMain.handle("native:open-external", async (_event, url) => {
    // 不信任 Renderer 傳來的資料：只放行 https 且在白名單內的網域
    if (!isSafeExternalUrl(url)) {
      return { ok: false, reason: "url-not-allowed" };
    }
    await shell.openExternal(url);
    return { ok: true };
  });
}

module.exports = { registerNativeIpc };
```

> 跨平台注意：
>
> - **對話框**：`properties` 若同時給 `openFile` 與 `openDirectory`，只有 macOS 能同時選檔案與資料夾；**Windows / Linux 上會變成「只能選資料夾」**，因此上面範例只用 `openFile`。若需要選資料夾，建議另做一顆按鈕、開一個只帶 `openDirectory` 的對話框。
> - **Windows 通知**：Windows 的通知中心依 AppUserModelID 辨識應用程式，需在 main process 啟動時設定（與第八章 electron-builder 的 `appId` 一致），否則通知可能不顯示：
>
> ```javascript
> // Windows 通知需要 AppUserModelID 才能正常顯示
> if (process.platform === "win32") {
>   app.setAppUserModelId("com.learnbyai.electroncourse");
> }
> ```

---

## 7.3 註冊與 Preload 暴露

在 `src/main/main.js` 註冊（完整區塊，保留前幾章已接上的功能）：

```javascript
const { registerNativeIpc } = require("./ipc/native.ipc");

app.whenReady().then(() => {
  registerSystemIpc(); // 第四章
  registerSettingsIpc(); // 第六章
  registerNativeIpc(); // 本章新增
  createMainWindow();
  buildAppMenu(mainWindow); // 第五章
  createTray(mainWindow); // 第五章
  registerShortcuts(mainWindow); // 第五章

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});
```

`src/preload/preload.js`（完整檔案，保留前幾章的 API，新增 `nativeApi`）：

```javascript
const { contextBridge, ipcRenderer } = require("electron");

// 第三章：應用資訊
contextBridge.exposeInMainWorld("appInfo", {
  getVersion() {
    return "1.0.0-course-demo";
  },
  getPlatform() {
    return process.platform;
  }
});

// 第四章：系統資訊
contextBridge.exposeInMainWorld("systemApi", {
  getInfo() {
    return ipcRenderer.invoke("system:get-info");
  }
});

// 第六章：設定存取
contextBridge.exposeInMainWorld("settingsApi", {
  get(key) {
    return ipcRenderer.invoke("settings:get", key);
  },
  set(key, value) {
    return ipcRenderer.invoke("settings:set", key, value);
  }
});

// 本章新增：原生能力
contextBridge.exposeInMainWorld("nativeApi", {
  showOpenDialog() {
    return ipcRenderer.invoke("native:show-open-dialog");
  },
  notify(payload) {
    return ipcRenderer.invoke("native:notify", payload);
  },
  copy(text) {
    return ipcRenderer.invoke("native:copy", text);
  },
  openExternal(url) {
    return ipcRenderer.invoke("native:open-external", url);
  }
});
```

---

## 7.4 Renderer 綁定按鈕事件

`src/renderer/index.html` 可加入：

```html
<button id="notifyBtn">顯示通知</button>
<button id="pickFileBtn">選擇檔案</button>
<button id="copyBtn">複製文字</button>
<button id="openDocBtn">開啟文件網站</button>
<pre id="nativeOutput"></pre>
```

`src/renderer/app.js`（節錄）：

```javascript
const nativeOutput = document.getElementById("nativeOutput");

document.getElementById("notifyBtn").addEventListener("click", async () => {
  await window.nativeApi.notify({
    title: "課程示範",
    body: "這是 Electron 系統通知"
  });
});

document.getElementById("pickFileBtn").addEventListener("click", async () => {
  const result = await window.nativeApi.showOpenDialog();
  nativeOutput.textContent = JSON.stringify(result, null, 2);
});

document.getElementById("copyBtn").addEventListener("click", async () => {
  await window.nativeApi.copy("這段文字由 Electron 寫入剪貼簿");
});

document.getElementById("openDocBtn").addEventListener("click", async () => {
  await window.nativeApi.openExternal("https://www.electronjs.org/docs/latest");
});
```

---

## 7.5 執行與測試

```bash
# 啟動應用程式，手動測試通知、檔案選擇與剪貼簿功能
npm run dev
```

建議測試項目：

- 點「顯示通知」是否有系統通知彈出
- 點「選擇檔案」是否能取得路徑資訊
- 點「複製文字」後貼上是否成功
- 點「開啟文件網站」是否開啟預設瀏覽器

---

## 7.6 本章小結

- 你已整合 Electron 的常用原生能力
- 你透過 IPC 保持 Renderer 與系統 API 的安全邊界
- 你可以把 Web UI 轉成真正的桌面操作體驗

---

> 下一章：[打包、安裝檔產生與跨平台發佈](./08-packaging-distribution.md)
