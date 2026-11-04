# 第九章：安全最佳實踐與自動更新

## 9.1 安全為什麼重要？

Electron 同時擁有瀏覽器與 Node.js 能力，如果邊界控制不好，風險會比純網頁更高。  
本章重點是「先安全、再更新」。

---

## 9.2 安裝自動更新套件

```bash
# 安裝 electron-updater，用於應用程式版本檢查與自動更新
npm install electron-updater
```

---

## 9.3 基礎安全設定（Main）

`src/main/main.js` 建議：

```javascript
const win = new BrowserWindow({
  width: 1200,
  height: 800,
  webPreferences: {
    preload: path.join(__dirname, "../preload/preload.js"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true
  }
});
```

`sandbox: true` 從 Electron 20 起已經是 renderer process 的預設值；這裡明寫出來，是為了讓安全基線一眼可見。要注意它的副作用：sandboxed preload 沒有完整 Node.js 環境，只能 `require("electron")` 與少數內建模組（例如 `events`、`timers`、`url`），不能直接 `require("node:fs")` 去讀寫檔案。需要檔案系統、子程序或作業系統能力時，請放在 Main process，透過第四章的 IPC 白名單呼叫。

如果 preload 開始變大，需要拆檔或使用 npm 套件，建議用 Vite / webpack 之類的 bundler 把 preload 打成單一檔案，再交給 `BrowserWindow` 載入。

---

## 9.4 前端 CSP（Content Security Policy）

`src/renderer/index.html` 在 `<head>` 加入：

```html
<meta
  http-equiv="Content-Security-Policy"
  content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;"
/>
```

說明：

- `default-src 'self'`：預設只允許載入本機資源
- `script-src 'self'`：禁止遠端注入惡意腳本

> `<meta>` 版本的 CSP 有兩個限制：無法使用 `frame-ancestors`、`sandbox`、`report-uri` 這類只能透過 HTTP 標頭生效的指令；而且**每一個 HTML 檔都要各自貼一次**。第五章 5.4 的 `about.html` 也是一個獨立頁面，請把同一段 `<meta>` 加進它的 `<head>`，否則那個視窗就沒有 CSP。
>
> 你可能在其他教學看過另一種寫法：在 main process 用 `session.defaultSession.webRequest.onHeadersReceived` 注入 `Content-Security-Policy` 回應標頭。那只對透過 HTTP(S) 載入的頁面有效（例如開發時的 Vite dev server）。本課程用 `loadFile()` 以 `file://` 載入頁面，沒有回應標頭可以改，Electron 官方安全文件也明確指出這種情況要用 `<meta>`。若之後改用自訂協定（`protocol.handle`）載入頁面，則直接在回傳的 `Response` 標頭裡設定 CSP。

---

## 9.5 限制導航、新視窗、IPC 發送者與權限請求

`contextIsolation` 與 CSP 守住的是「載入什麼」，但還有兩條攻擊面沒堵：**頁面被導去外部網址**、**惡意 `window.open` 開出不受控的新視窗**。這是 Electron 官方安全清單明列、卻最常被略過的兩項。做法是監聽每個 `webContents` 的建立事件，統一套上防護：

`src/main/security.js`：

```javascript
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { app, shell, session } = require("electron");
const { isSafeExternalUrl } = require("./utils/url-guard"); // 第七章 7.2

// App 自己的頁面都放在 src/renderer/ 底下（打包後在 app.asar 裡，路徑照樣成立）
const RENDERER_DIR = path.join(__dirname, "../renderer");

// 額外允許的 http(s) 來源（例如 dev server）
const ALLOWED_ORIGINS = new Set([]); // 例如 dev 階段可加 "http://localhost:5173"

// 只認 App 自己的頁面：src/renderer/ 底下的 file://，或白名單內的 http(s) 來源。
// file:// 的 URL origin 在標準裡是 "null"，不能靠 origin 比對；也不能只看 protocol === "file:"，
// 否則頁面一旦被 XSS，就能導去使用者下載資料夾裡的任意 HTML，而那個頁面一樣會載入 preload、
// 拿到你暴露的所有 API。
function isAppUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "file:") {
      return fileURLToPath(url).startsWith(RENDERER_DIR + path.sep);
    }
    return ALLOWED_ORIGINS.has(url.origin);
  } catch {
    return false;
  }
}

// 第四章 4.9：IPC 也要確認是 App 自己的頁面送來的
function isTrustedSender(event) {
  const url = event.senderFrame?.url;
  return typeof url === "string" && isAppUrl(url);
}

function openExternalIfSafe(rawUrl) {
  if (!isSafeExternalUrl(rawUrl)) {
    console.warn("已阻擋外部開啟：", rawUrl);
    return;
  }
  shell.openExternal(rawUrl).catch((error) => {
    console.warn("外部開啟失敗：", error);
  });
}

function hardenWebContents() {
  app.on("web-contents-created", (_event, contents) => {
    // 1) 阻止導航到非白名單來源（例如頁面被 XSS 塞了 location.href = 'https://evil...'）
    contents.on("will-navigate", (event, url) => {
      if (!isAppUrl(url)) {
        event.preventDefault();
        console.warn("已阻擋導航：", url);
      }
    });

    // 2) 不讓頁面自行開新視窗；需要外開的網址一律重用第七章的白名單驗證
    contents.setWindowOpenHandler(({ url }) => {
      openExternalIfSafe(url);
      return { action: "deny" };
    });
  });
}

function denySensitivePermissions() {
  // 3) 預設拒絕相機／麥克風／地理位置等敏感權限請求，需要時再逐項放行
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      const allowed = new Set([]); // 例如日後要用通知就加 "notifications"
      callback(allowed.has(permission));
    }
  );
}

module.exports = { hardenWebContents, denySensitivePermissions, isTrustedSender };
```

在 `src/main/main.js` 接上：

```javascript
const { hardenWebContents, denySensitivePermissions } = require("./security");

hardenWebContents(); // web-contents-created 要在視窗建立前就掛好

app.whenReady().then(() => {
  denySensitivePermissions();
  // ...其餘既有的 IPC 註冊與視窗建立
});
```

> 為什麼是 `web-contents-created` 而不是只針對主視窗？因為 `<webview>`、開發者工具、被開出來的子視窗都各自有 `webContents`。用這個事件才能一次涵蓋「所有」渲染內容，不會漏掉。
>
> 也不要把 `url.startsWith("https://")` 當成足夠驗證。`https` 只能保證協定，不代表那個網域可信；外開連結請集中走第七章的 `isSafeExternalUrl()`，依你的產品需求維護允許清單。

`isTrustedSender()` 用在會碰到系統能力的 IPC handler 上，例如第七章的 `native:open-external`：

```javascript
const { isTrustedSender } = require("../security");

ipcMain.handle("native:open-external", async (event, url) => {
  // 不是 App 自己的頁面送來的，一律拒絕
  if (!isTrustedSender(event)) return { ok: false, reason: "untrusted-sender" };
  if (!isSafeExternalUrl(url)) return { ok: false, reason: "url-not-allowed" };
  await shell.openExternal(url);
  return { ok: true };
});
```

導航限制與發送者驗證是兩道互補的防線：前者讓外部頁面進不來，後者確保萬一進來了，也呼叫不到你的 API。

> Electron 官方更進一步建議不要用 `file://` 載入頁面，改成註冊自訂協定（例如 `app://`），用 `protocol.handle` 只回應 App 目錄裡的檔案。`file://` 頁面理論上讀得到整台電腦的檔案，自訂協定則能把範圍限制在你指定的目錄；notepad-app 實戰專案顯示圖片用的 `note-image://` 就是同一套機制。本課程為了保持簡單沿用 `loadFile()`，產品化時值得考慮換掉。

---

## 9.6 設定更新來源（electron-builder）

`package.json` 的 `build` 欄位可加入：

```json
{
  "build": {
    "publish": [
      {
        "provider": "github",
        "owner": "your-github-org",
        "repo": "your-electron-app",
        "releaseType": "release"
      }
    ]
  }
}
```

`releaseType: "release"` 不能省：electron-builder 自動上傳時預設建立的是 **draft**（草稿）Release，而 electron-updater 看不到 draft，使用者就收不到更新。第十章的 CI 會用 electron-builder 自動上傳，到時就靠這一行。

---

## 9.7 Main 整合自動更新流程

自動更新比對的是打包後 App 的真實版本，因此不要讓第三章的 `"1.0.0-course-demo"` 留到這裡。第四章已經把 `window.appInfo.getVersion()` 改成透過 IPC 讀 `app.getVersion()`；發版時請用 `npm version patch --no-git-tag-version` 或手動更新 `package.json.version`，讓 UI、log 與更新機制看到同一個版本。

`src/main/updater.js`：

```javascript
const { dialog } = require("electron");
const { autoUpdater } = require("electron-updater");

function setupAutoUpdate() {
  autoUpdater.autoDownload = false;

  // 更新檢查失敗是常態（使用者離線、更新伺服器沒回應、Release 還沒建好），
  // 一定要接住：沒有這個 listener，錯誤會變成未處理的 Promise rejection
  autoUpdater.on("error", (error) => {
    console.error("自動更新失敗：", error?.message || error);
    // 檢查更新失敗不該打斷使用者，靜默記錄即可（第十章會改成寫進 electron-log）
  });

  autoUpdater.on("update-available", () => {
    autoUpdater.downloadUpdate().catch((error) => {
      console.error("下載更新失敗：", error?.message || error);
    });
  });

  autoUpdater.on("update-downloaded", async () => {
    // 不要無預警重啟：先詢問使用者，避免打斷未儲存的工作
    const { response } = await dialog.showMessageBox({
      type: "info",
      buttons: ["立即重啟更新", "稍後再說"],
      defaultId: 0,
      message: "新版本已下載完成",
      detail: "重新啟動應用程式即可完成更新。"
    });

    if (response === 0) autoUpdater.quitAndInstall();
  });
}

function checkForUpdates() {
  // checkForUpdates() 回傳 Promise，沒有 .catch() 就會噴 UnhandledPromiseRejection
  return autoUpdater.checkForUpdates().catch((error) => {
    console.error("檢查更新失敗：", error?.message || error);
    return null;
  });
}

module.exports = { setupAutoUpdate, checkForUpdates };
```

> 這裡用 `checkForUpdates()` 而非 `checkForUpdatesAndNotify()`：後者會在下載完成後直接跳系統通知，與我們自己控制的對話框流程重複。整條流程是「檢查 → 有新版就下載 → 下載完詢問使用者 → 同意才重啟安裝」。
>
> **錯誤處理不是選配**。`autoUpdater` 的失敗路徑比成功路徑更常走到，而且同時需要 `on("error")` 與 `.catch()` 兩層——前者接住事件流裡的錯誤，後者接住 `checkForUpdates()` 這個 Promise。少了它們，打包版一啟動就會在終端機／log 印出這種東西：
>
> ```text
> Error: HttpError: 404
> "method: GET url: https://github.com/your-org/your-app/releases.atom ..."
> (node:6903) UnhandledPromiseRejectionWarning: Unhandled promise rejection...
> ```
>
> 最常見的兩個觸發原因都跟「壞掉」無關，而是還沒準備好：GitHub Release 還沒建立（404），或是你用 `npm run pack` 測試（見 9.9 的提醒）。
>
> 補上 `on("error")` 之後，`electron-updater` 自己內建的 logger 仍會把完整的 HTTP 錯誤（含一大串 response headers）印到終端機。正式產品可以把它導到第十章的 electron-log，或直接關掉：
>
> ```javascript
> const log = require("./logger");      // 第十章 10.3
> autoUpdater.logger = log;             // 統一寫進 log 檔
> // autoUpdater.logger = null;         // 或者完全安靜
> ```

---

## 9.8 在 main.js 接上更新流程

`src/main/main.js` 加入以下內容（`require` 放到檔案上方其他 `require` 旁邊）：

```javascript
const { autoUpdater: nativeUpdater } = require("electron");
const { setupAutoUpdate, checkForUpdates } = require("./updater");

app.whenReady().then(() => {
  // ...前幾章既有的 IPC 註冊與視窗建立（見第七章 7.3 完整區塊）

  // 只在打包後的正式版本檢查更新：
  // 開發模式沒有打包產物與版本資訊可比對，autoUpdater 會直接報錯
  if (app.isPackaged) {
    setupAutoUpdate();
    checkForUpdates();
  }
});

// 讓第五章「按關閉鈕只隱藏」在安裝更新時放行
nativeUpdater.on("before-quit-for-update", () => {
  isQuitting = true;
});
```

最後那段一定要加。第五章的 `close` handler 只有在 `isQuitting` 為 true 時才放行，而 `isQuitting` 是在 `before-quit` 裡設定的；但由 `quitAndInstall()` 觸發的離開流程順序不同：Electron 會**先**關閉所有視窗、**之後**才發出 `before-quit`。少了這段，macOS 上按下「立即重啟更新」時，`close` handler 看到 `isQuitting` 還是 false，只會把視窗藏起來，App 不會結束，更新也就裝不上。`before-quit-for-update` 會在關閉視窗之前發出，electron-updater 在各平台安裝更新時都會觸發它，在這裡先把 `isQuitting` 設成 true 就能正常離開。

---

## 9.9 打包與更新驗證

要驗證更新，手上要有一個「舊版」，Release 上要有一個「新版」：

```bash
# 1) 先把目前的版本（例如 1.0.0）打包，安裝到電腦上當作舊版
npm run dist

# 2) 版本號升到 1.0.1（只改 package.json，不打 git tag）
npm version patch --no-git-tag-version

# 3) 打包新版，產生 1.0.1 的安裝檔與 latest*.yml
npm run dist

# 4) 登入 GitHub CLI，確保後續 release 上傳有權限
gh auth login

# 5) 建立 GitHub Release 並上傳新版產物：tag 要和 package.json 的版本一致；
#    release/*-1.0.1* 是這一版的安裝檔與 blockmap，latest*.yml 是 electron-updater 判斷「有沒有新版」的依據
gh release create v1.0.1 release/*-1.0.1* release/latest*.yml --title "v1.0.1" --notes "Electron app release"

# 6) 查看 release 清單，確認版本與檔案是否已成功上傳
gh release list
```

最後打開第 1 步安裝的 1.0.0：它應該在啟動後下載 1.0.1，並跳出「新版本已下載完成」的對話框。

> 提醒：
>
> - `release/*-1.0.1*` 會抓到這一版的所有產物：macOS 是 `.dmg`、`.zip` 與它們的 `.blockmap`，Windows 是 `.exe`，Linux 是 `.AppImage`。不要用 `release/*` 一把抓：`release/` 底下還留著 1.0.0 的檔案，以及 `mac-universal/`、`win-unpacked/` 等資料夾，`gh` 無法上傳資料夾會直接失敗。
> - 自動更新通常只在「已打包版本」中可完整測試，開發模式無法模擬真實更新流程。
> - **測更新一定要用 `npm run dist`，不能用 `npm run pack`**。`pack`（`electron-builder --dir`）只產生未封裝的目錄，**不會**產生 `app-update.yml`，autoUpdater 一啟動就會丟 `ENOENT: no such file or directory, open '.../Contents/Resources/app-update.yml'`。這個錯誤訊息完全沒提到「你用錯指令了」，很容易被誤判成程式有 bug。`dist`（或任何 dmg / zip / nsis 這類真實 target）才會把 `app-update.yml` 放進包裡，並在 `release/` 根目錄產生 `latest-mac.yml`。

### macOS 的三個硬性前提

`electron-updater` 在 macOS 上有三個沒滿足就直接報錯的要求：

1. **App 必須經過程式碼簽章**（Apple Developer 憑證）。未簽章的版本呼叫 autoUpdater 會拋出錯誤，這也是很多人「本機測試更新一直失敗」的原因。
2. `build.mac.target` 需包含 `zip`（第八章已設定），macOS 的更新實際透過 zip 包進行，`dmg` 只用於首次安裝。
3. macOS 架構要和更新檔對得上。第八章範例用 `universal` 同時支援 Intel 與 Apple Silicon；若你分開發佈 `x64` / `arm64`，要確認 GitHub Release 上的 `latest-mac.yml` 與檔名不會讓某個架構抓到另一個架構的包。

簽章與公證（notarization）需要 Apple Developer 帳號。**簽章**證明「這個 App 出自你」，**公證**則是把 App 送交 Apple 掃描惡意程式；少了公證，使用者在較新的 macOS 下載後會看到「無法打開，因為 Apple 無法檢查是否包含惡意軟體」而完全打不開——這是比簽章更常被漏掉的一步。

較新版 electron-builder（≥ 24）已內建公證，只要在 `build.mac` 開啟並提供 Apple 憑證資訊：

```json
{
  "build": {
    "mac": {
      "hardenedRuntime": true,
      "gatekeeperAssess": false,
      "notarize": true
    }
  }
}
```

再用環境變數提供帳密（別寫進版本控制），打包時 electron-builder 會自動簽章並送交公證：

```bash
# App 簽章憑證，二選一：
#   a) 本機：把 Developer ID Application 憑證安裝到鑰匙圈，electron-builder 會自動挑選，不必設定下面兩行
#   b) CI：把匯出的 .p12 憑證（檔案路徑或 base64）放進 CSC_LINK，密碼放進 CSC_KEY_PASSWORD
export CSC_LINK="..."
export CSC_KEY_PASSWORD="..."

# 公證用的 Apple 帳號資訊
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"  # App 專用密碼，非登入密碼
export APPLE_TEAM_ID="XXXXXXXXXX"

npm run dist:mac
```

- `hardenedRuntime: true` 是能通過公證的必要條件。
- `APPLE_APP_SPECIFIC_PASSWORD` 要到 [appleid.apple.com](https://appleid.apple.com/) 產生「App 專用密碼」，不是你的 Apple 登入密碼。
- 公證需要把產物上傳給 Apple 掃描，**會多花幾分鐘**，屬正常現象。

更完整的設定與疑難排解參考 electron-builder 的 [Code Signing 文件](https://www.electron.build/code-signing)。

Windows 也建議簽章，可減少 SmartScreen 對未簽章安裝檔的攔截警告。要注意現在的 Windows 程式碼簽章憑證都必須存放在硬體金鑰或雲端 HSM，不能再像以前一樣匯出 `.pfx` 檔交給 CI。在 CI 上簽章通常走兩條路：electron-builder 內建支援的 Azure Trusted Signing（`win.azureSignOptions`），或用 `win.signtoolOptions.sign` 指定自訂簽章腳本，交給憑證商提供的雲端簽章工具。

---

## 9.10 安全檢查清單

- `nodeIntegration: false`
- `contextIsolation: true`
- `sandbox: true`
- 只透過 preload 暴露白名單 API
- IPC 參數驗證（型別、字串長度、白名單 URL）
- 驗證 IPC 發送者（`event.senderFrame` 必須是 App 自己的頁面）
- 不信任 Renderer 輸入資料
- 設定 CSP（`<meta>` 或回應標頭擇一）
- 限制導航（`will-navigate`，只放行 App 自己的頁面）與新視窗（`setWindowOpenHandler`）
- 預設拒絕敏感權限請求（`setPermissionRequestHandler`）
- 正式版本完成程式碼簽章與（macOS）公證
- 不要把 API key、私鑰、後端密碼打進包裡（`app.asar` 不是加密，見下方說明）
- 打包版關閉用不到的 Fuses（9.11）
- Electron 與第三方套件定期升級（Electron 只維護最新的三個大版本）

> **`app.asar` 不是保護，只是打包格式。** 它沒有加密也沒有混淆，任何人只要一行指令就能把你的原始碼完整解開：
>
> ```bash
> # 列出包裡有哪些檔案
> npx @electron/asar list "你的App.app/Contents/Resources/app.asar"
>
> # 整包解開成一般資料夾
> npx @electron/asar extract "你的App.app/Contents/Resources/app.asar" ./extracted
> ```
>
> 這代表：**任何寫死在 main / preload / renderer 裡的東西，都等同公開**——API key、第三方服務的 secret、後端資料庫連線字串、授權驗證的判斷邏輯，全部都會被看到。正確作法是把需要 secret 的動作留在你自己的後端 API，App 端只拿短期 token（並照 6.11 用 `safeStorage` 存）。如果只是想提高一點閱讀門檻，可以用 bundler 壓縮打包，但請清楚知道那只是混淆，不是安全機制。

---

## 9.11 用 Fuses 關掉用不到的能力

Electron 執行檔裡有幾個「保險絲」（Fuses）開關，控制一些很少有 App 需要、卻可能被濫用的能力。例如 `ELECTRON_RUN_AS_NODE` 環境變數能讓你的 App 執行檔變成一個完整的 Node.js 執行環境；`--inspect` 參數則能讓任何啟動你 App 的人接上除錯器、在 main process 裡執行任意程式碼。攻擊者若想借用你已簽章、受使用者信任的執行檔做事，這些就是入口。

Fuses 是在打包時直接寫進執行檔的，執行期改不回來。electron-builder 可以在打包時幫你設定：

```json
{
  "build": {
    "electronFuses": {
      "runAsNode": false,
      "enableNodeOptionsEnvironmentVariable": false,
      "enableNodeCliInspectArguments": false,
      "onlyLoadAppFromAsar": true
    }
  }
}
```

- `runAsNode: false`：停用 `ELECTRON_RUN_AS_NODE`。如果你的程式用 `child_process.fork()` 執行 Node 腳本（它底層依賴這個環境變數），關掉後會失效，請改用 Electron 的 `utilityProcess.fork()`。
- `enableNodeOptionsEnvironmentVariable: false`：忽略 `NODE_OPTIONS` 環境變數，避免別人用它在啟動時注入程式碼。
- `enableNodeCliInspectArguments: false`：忽略 `--inspect` 這類除錯參數。只影響打包後的版本，開發時第十章的除錯方式照常可用。
- `onlyLoadAppFromAsar: true`：只從 `app.asar` 載入 App，避免有人在旁邊放一個 `app/` 資料夾替換你的程式碼。

設定後打包一次，確認 App 能正常啟動、自動更新流程沒有受影響，再放進正式流程。

---

## 9.12 本章小結

- 你建立了 Electron 的核心安全基線（webPreferences、CSP、導航、IPC 發送者與權限防護、Fuses）
- 你完成了 `electron-updater` 的基本整合，包含必備的錯誤處理
- 你理解更新流程要搭配打包產物、簽章公證與發佈平台
- 你知道 `app.asar` 可被一行指令解開，機密不能打進包裡

---

> 下一章：[除錯、測試與 CI/CD 發佈流程](./10-debugging-testing-cicd.md)
