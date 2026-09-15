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

> `<meta>` 版本的 CSP 適合入門，但有先天限制：它無法涵蓋 `frame-ancestors`、`sandbox` 等只能經 HTTP 標頭生效的指令，要靠 HTML 正確載入才會套用，而且**每一個 HTML 檔都要各自貼一次**——第五章 5.4 的 `about.html` 這類子視窗頁面若忘了加，就等於沒有 CSP。正式產品建議改由 main process 用回應標頭注入，對所有載入的資源一體適用：
>
> ```javascript
> // src/main/main.js —— whenReady 內、建立視窗前後皆可
> const { session } = require("electron");
>
> session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
>   callback({
>     responseHeaders: {
>       ...details.responseHeaders,
>       "Content-Security-Policy": [
>         "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;"
>       ]
>     }
>   });
> });
> ```
>
> 兩者擇一即可，別重複設定造成互相打架。

---

## 9.5 限制導航、新視窗與權限請求

`contextIsolation` 與 CSP 守住的是「載入什麼」，但還有兩條攻擊面沒堵：**頁面被導去外部網址**、**惡意 `window.open` 開出不受控的新視窗**。這是 Electron 官方安全清單明列、卻最常被略過的兩項。做法是監聽每個 `webContents` 的建立事件，統一套上防護：

`src/main/security.js`：

```javascript
const { app, shell, session } = require("electron");
const { isSafeExternalUrl } = require("./utils/url-guard"); // 第七章 7.2

// 額外允許導航的 http(s) 來源（例如 dev server）；App 自己的 file:// 頁面預設放行。
// 注意：file:// 的 URL origin 在標準裡是 "null"，不是 "file://"，所以不能靠 origin 比對，
// 要另外判斷 protocol === "file:"。
const ALLOWED_ORIGINS = new Set([]); // 例如 dev 階段可加 "http://localhost:5173"

function isAllowedNavigation(rawUrl) {
  try {
    const { origin, protocol } = new URL(rawUrl);
    return protocol === "file:" || ALLOWED_ORIGINS.has(origin);
  } catch {
    return false;
  }
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
      if (!isAllowedNavigation(url)) {
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

module.exports = { hardenWebContents, denySensitivePermissions };
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
        "repo": "your-electron-app"
      }
    ]
  }
}
```

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

`src/main/main.js` 的 `app.whenReady()` 中加入：

```javascript
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
```

---

## 9.9 打包與更新驗證

```bash
# 先產生新版安裝檔，供更新機制比對版本
npm run dist

# 先登入 GitHub CLI，確保後續 release 上傳有權限
gh auth login

# 建立 GitHub Release 並上傳打包產物與更新資訊檔（手動示範流程）
# latest*.yml 是 electron-updater 判斷「有沒有新版」的依據，務必一併上傳
gh release create v1.0.1 release/*.dmg release/*.zip release/*.blockmap release/latest*.yml --title "v1.0.1" --notes "Electron app release"

# 查看 release 清單，確認版本與檔案是否已成功上傳
gh release list
```

> 提醒：
>
> - 上面的檔案清單以 macOS 產物為例（`.dmg`、`.zip`、`latest-mac.yml`），Windows / Linux 請依實際產物調整（`.exe`、`.AppImage`、`latest.yml` 等）。不要用 `release/*` 一把抓——`release/` 下還有 `mac/`、`win-unpacked/` 等資料夾，`gh` 無法上傳資料夾會直接失敗。
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
# App 簽章憑證（存在 macOS 鑰匙圈中，electron-builder 會自動挑選）
export CSC_LINK="..."          # 或直接安裝 Developer ID 憑證到鑰匙圈
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

更完整的設定與疑難排解參考 electron-builder 的 [Code Signing 文件](https://www.electron.build/code-signing)。Windows 也建議取得程式碼簽章憑證，可避免 SmartScreen 對未簽章安裝檔的攔截警告。

---

## 9.10 安全檢查清單

- `nodeIntegration: false`
- `contextIsolation: true`
- `sandbox: true`
- 只透過 preload 暴露白名單 API
- IPC 參數驗證（型別、字串長度、白名單 URL）
- 不信任 Renderer 輸入資料
- 設定 CSP（`<meta>` 或回應標頭擇一）
- 限制導航（`will-navigate`）與新視窗（`setWindowOpenHandler`）
- 預設拒絕敏感權限請求（`setPermissionRequestHandler`）
- 正式版本完成程式碼簽章與（macOS）公證
- 不要把 API key、私鑰、後端密碼打進包裡（`app.asar` 不是加密，見下方說明）
- 第三方套件定期升級

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

## 9.11 本章小結

- 你建立了 Electron 的核心安全基線（webPreferences、CSP、導航與權限防護）
- 你完成了 `electron-updater` 的基本整合，包含必備的錯誤處理
- 你理解更新流程要搭配打包產物、簽章公證與發佈平台
- 你知道 `app.asar` 可被一行指令解開，機密不能打進包裡

---

> 下一章：[除錯、測試與 CI/CD 發佈流程](./10-debugging-testing-cicd.md)
