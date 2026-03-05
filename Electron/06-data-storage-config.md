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
const Store = require("electron-store");

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

在 `src/main/main.js` 的 `app.whenReady()` 註冊：

```javascript
const { registerSettingsIpc } = require("./ipc/settings.ipc");

app.whenReady().then(() => {
  registerSettingsIpc();
  createMainWindow();
});
```

---

## 6.5 Preload 開放設定 API

`src/preload/preload.js`：

```javascript
const { contextBridge, ipcRenderer } = require("electron");

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

`src/renderer/app.js`（節錄）：

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

```bash
# 印出 Electron 的 userData 路徑，確認設定檔實際儲存位置
npx electron -e "const {app}=require('electron');app.whenReady().then(()=>{console.log(app.getPath('userData'));app.quit();});"
```

---

## 6.9 本章小結

- 你學會使用 `electron-store` 保存設定
- 你完成了設定存取的 IPC 封裝
- 你建立了可持久化的使用者偏好機制

---

> 下一章：[原生能力整合（通知、對話框、剪貼簿）](./07-native-features.md)
