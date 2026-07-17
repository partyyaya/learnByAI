# 第六章：本機資料儲存與設定管理

## 6.1 為什麼要做資料持久化？

桌面應用常見需求：

- 記住使用者偏好（主題、語言、視窗大小）
- 保存最近使用紀錄
- 離線模式下保留資料

在 Electron 中，推薦使用 `electron-store` 來儲存設定資料。

---

## 6.2 安裝儲存套件

```bash
# 安裝 electron-store，提供簡單且可靠的 JSON 設定儲存
npm install electron-store
```

> **版本注意**：`electron-store` 自 v9 起改為 **ESM-only** 套件。在 CommonJS 的 main process 裡，`require("electron-store")` 拿到的是模組命名空間物件，直接 `new` 會得到 `Store is not a constructor` 錯誤。兩種解法擇一：
>
> 1. 取 `.default` 才是建構子：`const Store = require("electron-store").default;`（需 Electron 內建 Node.js ≥ 20.19 / 22.12 才支援 `require(esm)`，近年的 Electron 版本皆符合）。本章採用此寫法。
> 2. 改安裝最後的 CommonJS 版本：`npm install electron-store@8`，即可直接 `require`。

---

## 6.3 建立設定服務

```bash
# 建立 store 模組目錄，集中管理本機設定與資料存取
mkdir -p src/main/store

# 建立設定服務檔案，封裝 get/set 操作
touch src/main/store/settings.store.js
```

`src/main/store/settings.store.js`：

```javascript
// electron-store v9+ 為 ESM-only，CommonJS 下需取 .default 才是建構子（見 6.2 說明）
const Store = require("electron-store").default;

const store = new Store({
  name: "settings",
  defaults: {
    theme: "light",
    language: "zh-Hant",
    autoLaunch: false
  }
});

function getSetting(key) {
  return store.get(key);
}

function setSetting(key, value) {
  store.set(key, value);
}

module.exports = {
  getSetting,
  setSetting
};
```

---

## 6.4 透過 IPC 提供設定存取

`src/main/ipc/settings.ipc.js`：

```javascript
const { ipcMain } = require("electron");
const { getSetting, setSetting } = require("../store/settings.store");

function registerSettingsIpc() {
  ipcMain.handle("settings:get", async (_event, key) => getSetting(key));

  ipcMain.handle("settings:set", async (_event, key, value) => {
    setSetting(key, value);
    return { ok: true };
  });
}

module.exports = { registerSettingsIpc };
```

在 `src/main/main.js` 的 `app.whenReady()` 註冊（完整區塊，保留前幾章已接上的功能）：

```javascript
const { registerSettingsIpc } = require("./ipc/settings.ipc");

app.whenReady().then(() => {
  registerSystemIpc(); // 第四章
  registerSettingsIpc(); // 本章新增
  createMainWindow();
  buildAppMenu(mainWindow); // 第五章
  createTray(mainWindow); // 第五章
  registerShortcuts(mainWindow); // 第五章

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});
```

---

## 6.5 Preload 開放設定 API

`src/preload/preload.js`（完整檔案，保留第三、四章的 API，新增 `settingsApi`）：

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

// 本章新增：設定存取
contextBridge.exposeInMainWorld("settingsApi", {
  get(key) {
    return ipcRenderer.invoke("settings:get", key);
  },
  set(key, value) {
    return ipcRenderer.invoke("settings:set", key, value);
  }
});
```

---

## 6.6 Renderer 實作主題切換

`src/renderer/index.html` 新增按鈕：

```html
<button id="themeToggleBtn">切換主題</button>
```

`src/renderer/styles.css` 加入深色主題樣式（沒有這段，切換主題不會有任何視覺變化）：

```css
html[data-theme="dark"] body {
  background: #1f2430;
  color: #e8eaf0;
}

html[data-theme="dark"] main {
  background: #2a3040;
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.4);
}
```

`src/renderer/app.js`（節錄，加在檔案最後）：

```javascript
const themeToggleBtn = document.getElementById("themeToggleBtn");

async function initTheme() {
  const theme = await window.settingsApi.get("theme");
  document.documentElement.dataset.theme = theme;
}

themeToggleBtn.addEventListener("click", async () => {
  const current = await window.settingsApi.get("theme");
  const next = current === "light" ? "dark" : "light";

  await window.settingsApi.set("theme", next);
  document.documentElement.dataset.theme = next;
});

initTheme();
```

---

## 6.7 執行驗證

```bash
# 重新啟動應用，驗證設定值是否可儲存且重開後仍保留
npm run dev
```

測試流程：

1. 切換主題為 dark
2. 關閉應用程式
3. 重新啟動後確認主題仍是 dark

---

## 6.8 資料儲存位置查詢（除錯用）

`electron-store` 實例的 `path` 屬性就是設定檔的完整路徑。可在 `settings.store.js` 暫時加一行：

```javascript
// 印出設定檔實際位置，確認資料寫到哪裡（除錯完可移除）
console.log("settings file:", store.path);
```

啟動 `npm run dev` 後，終端機會印出類似以下路徑：

- macOS：`~/Library/Application Support/electron-course-app/settings.json`
- Windows：`%APPDATA%\electron-course-app\settings.json`
- Linux：`~/.config/electron-course-app/settings.json`

這個目錄就是 Electron 的 `userData` 路徑（`app.getPath("userData")`），應用程式的本機資料（設定、快取、IndexedDB 等）都存放於此。

---

## 6.9 本章小結

- 你學會使用 `electron-store` 保存設定
- 你完成了設定存取的 IPC 封裝
- 你建立了可持久化的使用者偏好機制

---

> 下一章：[原生能力整合（通知、對話框、剪貼簿）](./07-native-features.md)
