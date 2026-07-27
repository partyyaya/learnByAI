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
    // 部分環境（例如某些未安裝通知服務的 Linux）不支援系統通知，
    // 先檢查再送，避免呼叫後靜默失敗、卻讓 Renderer 以為成功
    if (!Notification.isSupported()) {
      return { ok: false, reason: "notification-not-supported" };
    }
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

## 7.6 深層連結（自訂協定 `myapp://`）

深層連結讓外部（瀏覽器、其他 App、OAuth 登入回呼）能用 `myapp://...` 這種自訂網址喚起你的 App 並帶入資料，是「在 App 中開啟」、登入回跳這類功能的基礎。

三個平台的送達路徑不同，這是最容易搞混的地方：

- **macOS**：透過 `open-url` 事件送達，與命令列參數無關。
- **Windows / Linux**：網址被當成「命令列參數」丟給 App。App 沒在跑時進 `process.argv`；已經在跑時，系統會啟動第二份程序、網址夾在第五章 `second-instance` 事件的 `argv` 裡送達——所以**深層連結在 Windows 上必須搭配第五章的單一實例鎖**才收得到。

### 註冊協定並處理送達

`src/main/deeplink.js`：

```javascript
const path = require("node:path");
const { app } = require("electron");

const PROTOCOL = "myapp";

function registerProtocol() {
  if (process.defaultApp) {
    // 開發模式（electron . 啟動）：要把「electron 執行檔 + 專案入口」一起註冊，
    // 否則系統不知道該用什麼程式開這個協定
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [
        path.resolve(process.argv[1])
      ]);
    }
  } else {
    // 打包後的正式版本：直接註冊即可
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}

// 從一串 argv 裡挑出 myapp:// 開頭的那個
function findDeepLink(argv) {
  return argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
}

function handleDeepLink(url, mainWindow) {
  if (!url) return;
  console.log("收到深層連結：", url);
  // 這裡依需求解析 url（例如 new URL(url) 取 query/path）並更新畫面
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    mainWindow.webContents.send("deeplink:received", url);
  }
}

module.exports = { registerProtocol, findDeepLink, handleDeepLink };
```

### 在 main.js 接上（延續第五章的單一實例鎖結構）

```javascript
const {
  registerProtocol,
  findDeepLink,
  handleDeepLink
} = require("./deeplink");

registerProtocol(); // 深層連結：註冊 myapp:// 協定

const gotTheLock = app.requestSingleInstanceLock(); // 第五章

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    // Windows / Linux：App 已在執行時，網址從第二份程序的 argv 送達
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    handleDeepLink(findDeepLink(argv), mainWindow); // 深層連結
  });

  // macOS 專屬：透過 open-url 事件送達
  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeepLink(url, mainWindow); // 深層連結
  });

  app.whenReady().then(() => {
    // ...第五章既有的視窗與功能建立（createMainWindow 等）

    // Windows / Linux：App 原本沒在跑、被協定喚起時，網址在啟動 argv 裡
    handleDeepLink(findDeepLink(process.argv), mainWindow); // 深層連結
  });
}
```

> 測試方式（打包後，或 macOS 上已把協定註冊給 electron）：在終端機執行
>
> - macOS：`open "myapp://test?foo=bar"`
> - Windows：`start myapp://test?foo=bar`
>
> App 應被喚到前景，並在終端機／DevTools 印出收到的網址。
>
> 兩個實務注意點：
>
> 1. **macOS 冷啟動**：若 App 沒在跑就被協定喚起，`open-url` 可能在視窗建立前就觸發，此時 `mainWindow` 還不存在。正式專案可先把網址暫存成 `pendingDeepLink`，等 `whenReady` 建好視窗再處理。
> 2. **要讓 Renderer 收到 `deeplink:received`**，記得比照第四章的原則在 preload 用 `ipcRenderer.on` 轉一層（例如 `onDeepLink(cb)`），不要直接把 `ipcRenderer` 暴露給前端。

---

## 7.7 本章小結

- 你已整合 Electron 的常用原生能力
- 你透過 IPC 保持 Renderer 與系統 API 的安全邊界
- 你可以把 Web UI 轉成真正的桌面操作體驗
- 你學會用自訂協定做深層連結，並理解三平台送達路徑的差異

---

> 下一章：[打包、安裝檔產生與跨平台發佈](./08-packaging-distribution.md)
