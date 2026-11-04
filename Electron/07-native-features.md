# 第七章：原生能力整合（通知、對話框、剪貼簿）

## 7.1 章節目標

本章會把 Electron 的系統整合能力接到你的 App：

- 系統通知（Notification）
- 原生對話框（Dialog）
- 剪貼簿（Clipboard）
- 開啟外部連結（Shell）
- 拖放檔案取得路徑（webUtils）
- 深層連結（自訂協定）

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
const { BrowserWindow, ipcMain, dialog, Notification, clipboard, shell } = require("electron");
const { isSafeExternalUrl } = require("../utils/url-guard");

function registerNativeIpc() {
  ipcMain.handle("native:show-open-dialog", async (event) => {
    // 帶入發出請求的那個視窗，對話框才會「附著」在它身上（macOS 會變成下拉式 sheet，
    // Windows / Linux 則會是該視窗的 modal）；不傳的話是 app 層級對話框，
    // 多視窗時使用者會搞不清楚這個對話框屬於誰
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
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
const { syncAutoLaunchOnStartup } = require("./store/auto-launch"); // 第六章 6.8

app.whenReady().then(() => {
  registerSystemIpc(); // 第四章
  registerWindowIpc(); // 第四章 4.6
  registerSettingsIpc(); // 第六章
  syncAutoLaunchOnStartup(); // 第六章 6.8
  registerNativeIpc(); // 本章新增
  createMainWindow();
  buildAppMenu(mainWindow); // 第五章
  createTray(mainWindow); // 第五章
  registerShortcuts(mainWindow); // 第五章

  app.on("activate", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      return;
    }
    createMainWindow();
  });
});
```

`src/preload/preload.js`（完整檔案，保留前幾章的 API，新增 `nativeApi`）：

```javascript
const { contextBridge, ipcRenderer } = require("electron");

// 第三章：應用資訊
contextBridge.exposeInMainWorld("appInfo", {
  getVersion() {
    return ipcRenderer.invoke("app:get-version");
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

// 第四章 4.6：進度條
contextBridge.exposeInMainWorld("appWindow", {
  setProgress(value) {
    ipcRenderer.send("window:set-progress", value);
  }
});

// 第六章：設定存取與開機自動啟動
contextBridge.exposeInMainWorld("settingsApi", {
  get(key) {
    return ipcRenderer.invoke("settings:get", key);
  },
  set(key, value) {
    return ipcRenderer.invoke("settings:set", key, value);
  },
  getAutoLaunch() {
    return ipcRenderer.invoke("settings:get-auto-launch");
  },
  setAutoLaunch(enabled) {
    return ipcRenderer.invoke("settings:set-auto-launch", enabled);
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

## 7.6 拖放檔案：取得檔案路徑

把檔案拖進視窗是桌面 App 很常見的操作。網頁的 `drop` 事件拿得到 `File` 物件，但若要交給 Main 讀檔，需要的是**完整路徑**。舊教學常寫 `file.path`，這個由 Electron 額外加上的屬性已在 Electron 32 移除；現在要在 preload 用 `webUtils.getPathForFile()` 換成路徑。

`src/preload/preload.js`：開頭的 `require` 多取一個 `webUtils`，並在 7.3 的 `nativeApi` 加一個方法：

```javascript
const { contextBridge, ipcRenderer, webUtils } = require("electron");

// ...其他 API 保留不動

contextBridge.exposeInMainWorld("nativeApi", {
  // ...7.3 的 showOpenDialog、notify、copy、openExternal 保留不動

  // 本節新增：把拖進來的 File 物件換成完整路徑
  getPathForFile(file) {
    return webUtils.getPathForFile(file);
  }
});
```

`src/renderer/index.html` 加一塊拖放區：

```html
<div id="dropZone">把檔案拖到這裡</div>
```

`src/renderer/app.js`（加在檔案最後）：

```javascript
const dropZone = document.getElementById("dropZone");

// dragover 不取消預設行為的話，drop 事件根本不會觸發
dropZone.addEventListener("dragover", (event) => event.preventDefault());

dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  const paths = [...event.dataTransfer.files].map((file) => window.nativeApi.getPathForFile(file));
  nativeOutput.textContent = JSON.stringify(paths, null, 2);
});
```

兩個注意點：

- 檔案若被丟在拖放區**以外**的地方，Chromium 的預設行為是把整個視窗導向那個檔案。第九章 9.5 的導航限制會把這種導航擋下來。
- 之後若要把路徑交給 Main 讀檔，Main 端仍要自己檢查（副檔名、檔案大小）。Renderer 可以傳任何字串過來，「這是使用者剛拖進來的檔案」只是前端的說法。

---

## 7.7 深層連結（自訂協定 `myapp://`）

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

// 視窗還沒建立、或頁面還沒載入完時收到的網址，先存在這裡
let pendingUrl = null;

// 把視窗叫到前景，並把網址推給 Renderer
function deliverDeepLink(url, mainWindow) {
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send("deeplink:received", url);
}

function handleDeepLink(url, mainWindow) {
  if (!url) return;
  console.log("收到深層連結：", url);

  // 冷啟動時視窗可能還沒建立，或頁面還在載入、Renderer 還沒訂閱 deeplink:received；
  // 這時 webContents.send 出去的訊息會直接遺失，所以先暫存，等頁面載入完再送
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) {
    pendingUrl = url;
    return;
  }

  deliverDeepLink(url, mainWindow);
}

// 建立主視窗後呼叫：每次頁面載入完成（包含重新整理），都把暫存的網址補送出去。
// did-finish-load 觸發的當下 isLoading() 仍然是 true，所以這裡直接送，不再經過 handleDeepLink 的檢查
function flushPendingDeepLink(mainWindow) {
  mainWindow.webContents.on("did-finish-load", () => {
    if (!pendingUrl) return;
    const url = pendingUrl;
    pendingUrl = null;
    deliverDeepLink(url, mainWindow);
  });
}

module.exports = { registerProtocol, findDeepLink, handleDeepLink, flushPendingDeepLink };
```

### 在 main.js 接上（延續第五章的單一實例鎖結構）

```javascript
const {
  registerProtocol,
  findDeepLink,
  handleDeepLink,
  flushPendingDeepLink
} = require("./deeplink");

registerProtocol(); // 深層連結：註冊 myapp:// 協定

const gotTheLock = app.requestSingleInstanceLock(); // 第五章

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    // Windows / Linux：App 已在執行時，網址從第二份程序的 argv 送達
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
    handleDeepLink(findDeepLink(argv), mainWindow); // 深層連結
  });

  // macOS 專屬：透過 open-url 事件送達。冷啟動時它可能比 whenReady 更早觸發，
  // 這時 mainWindow 還不存在，handleDeepLink 會先把網址暫存起來
  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeepLink(url, mainWindow); // 深層連結
  });

  app.whenReady().then(() => {
    // ...第五章既有的視窗與功能建立（createMainWindow 等）

    flushPendingDeepLink(mainWindow); // 頁面載入完成後補送暫存的網址

    // Windows / Linux：App 原本沒在跑、被協定喚起時，網址在啟動 argv 裡
    handleDeepLink(findDeepLink(process.argv), mainWindow); // 深層連結
  });
}
```

> 測試方式：在終端機執行
>
> - macOS：`open "myapp://test?foo=bar"`
> - Windows：`start myapp://test?foo=bar`
>
> App 應被喚到前景，並在終端機／DevTools 印出收到的網址。
>
> **macOS 必須用打包後的版本測**：macOS 只會把協定交給 Info.plist 裡有宣告該協定的 App，這無法在執行期用 `setAsDefaultProtocolClient` 補上，所以要在第八章的 electron-builder 設定加上 `protocols`，由打包流程寫進 Info.plist。開發模式下的 `npm run dev` 用的是 node_modules 裡的 Electron.app，它的 Info.plist 沒有 `myapp`。Windows 則在開發模式就能測，`setAsDefaultProtocolClient` 會直接寫進登錄檔。
>
> 兩個實務注意點：
>
> 1. **網址是不可信的輸入**：任何網頁放一個 `<a href="myapp://...">` 就能觸發你的 App，網址裡的內容可能是任何東西。請用 `new URL()` 解析，只接受預期的路徑與參數格式，不要直接拿去開檔、執行指令或塞進 `innerHTML`。
> 2. **要讓 Renderer 收到 `deeplink:received`**，做法就是第四章 4.7 的 Main → Renderer 推送模式：preload 用 `ipcRenderer.on` 轉成 `onReceived(callback)`，回傳取消訂閱函式，而且不要把 `event` 或 `ipcRenderer` 暴露給前端。

---

## 7.8 本章小結

- 你已整合 Electron 的常用原生能力
- 你透過 IPC 保持 Renderer 與系統 API 的安全邊界
- 你可以把 Web UI 轉成真正的桌面操作體驗
- 你會用 `webUtils.getPathForFile()` 取得拖放檔案的路徑
- 你學會用自訂協定做深層連結，理解三平台送達路徑的差異，並處理冷啟動時頁面還沒載入的情況

---

> 下一章：[打包、安裝檔產生與跨平台發佈](./08-packaging-distribution.md)
