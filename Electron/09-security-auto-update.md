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

---

## 9.5 設定更新來源（electron-builder）

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

## 9.6 Main 整合自動更新流程

`src/main/updater.js`：

```javascript
const { autoUpdater } = require("electron-updater");

function setupAutoUpdate() {
  autoUpdater.autoDownload = false;

  autoUpdater.on("update-available", () => {
    autoUpdater.downloadUpdate();
  });

  autoUpdater.on("update-downloaded", () => {
    autoUpdater.quitAndInstall();
  });
}

function checkForUpdates() {
  autoUpdater.checkForUpdatesAndNotify();
}

module.exports = { setupAutoUpdate, checkForUpdates };
```

---

## 9.7 打包與更新驗證

```bash
# 先產生新版安裝檔，供更新機制比對版本
npm run dist

# 先登入 GitHub CLI，確保後續 release 上傳有權限
gh auth login

# 建立 GitHub Release 並上傳 release 目錄產物（手動示範流程）
gh release create v1.0.1 release/* --title "v1.0.1" --notes "Electron app release"

# 查看 release 清單，確認版本與檔案是否已成功上傳
gh release list
```

> 提醒：自動更新通常只在「已打包版本」中可完整測試，開發模式常無法模擬真實更新流程。

---

## 9.8 安全檢查清單

- `nodeIntegration: false`
- `contextIsolation: true`
- 只透過 preload 暴露白名單 API
- IPC 參數驗證（型別、字串長度、白名單 URL）
- 不信任 Renderer 輸入資料
- 第三方套件定期升級

---

## 9.9 本章小結

- 你建立了 Electron 的核心安全基線
- 你完成了 `electron-updater` 的基本整合
- 你理解更新流程要搭配打包產物與發佈平台

---

> 下一章：[除錯、測試與 CI/CD 發佈流程](./10-debugging-testing-cicd.md)
