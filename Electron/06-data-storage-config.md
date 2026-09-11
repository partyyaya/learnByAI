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
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      return;
    }
    createMainWindow();
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

## 6.7 記住視窗大小與位置

6.1 一開頭就提到「記住視窗大小」是桌面應用的常見需求。有了 `electron-store`，就能把上次的視窗尺寸與位置存起來，下次啟動時還原——這也順便補上第五章 `createMainWindow` 每次都用固定寬高的缺口。

先在 6.3 的設定服務追加視窗資料的存取（`src/main/store/settings.store.js`）：

```javascript
const store = new Store({
  name: "settings",
  defaults: {
    theme: "light",
    language: "zh-Hant",
    autoLaunch: false,
    windowState: {
      bounds: { width: 1200, height: 800 }, // 首次啟動的預設大小
      maximized: false
    }
  }
});

// ...原本的 getSetting / setSetting 保留不動

function getWindowState() {
  return store.get("windowState");
}

function saveWindowState(state) {
  store.set("windowState", state);
}

module.exports = {
  getSetting,
  setSetting,
  getWindowState, // 本節新增
  saveWindowState // 本節新增
};
```

再改第五章的 `createMainWindow`，開窗時套用存下來的尺寸、關窗前把當前尺寸寫回：

```javascript
const { getWindowState, saveWindowState } = require("./store/settings.store");

function createMainWindow() {
  const windowState = getWindowState(); // { bounds: { x, y, width, height }, maximized }

  mainWindow = new BrowserWindow({
    ...windowState.bounds, // 首次啟動時只有 width/height，會自動置中
    minWidth: 900,
    minHeight: 600,
    title: "Learn Electron",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));

  mainWindow.once("ready-to-show", () => {
    if (windowState.maximized) mainWindow.maximize();
    mainWindow.show();
  });

  // 關閉前記住「未最大化時」的大小與位置，以及目前是否最大化
  mainWindow.on("close", () => {
    saveWindowState({
      bounds: mainWindow.getNormalBounds(),
      maximized: mainWindow.isMaximized()
    });
  });
}
```

> 為什麼不用 `getBounds()`？視窗最大化時，`getBounds()` 會回傳接近整個螢幕的尺寸；下次啟動若直接套用，會變成「跟螢幕一樣大，但不是最大化狀態」的視窗。`getNormalBounds()` 會回傳最大化前的正常尺寸，再搭配 `isMaximized()` 還原狀態，體驗才一致。
>
> 進階提醒：如果使用者上次在第二個螢幕、下次卻只剩一個螢幕，還原的位置可能落在畫面外。正式產品可用 `screen.getDisplayMatching(windowState.bounds)` 檢查存下來的座標是否仍在可見範圍，超出就退回置中。這裡先示範最常用的寬高還原即可。

---

## 6.8 執行驗證

```bash
# 重新啟動應用，驗證設定值是否可儲存且重開後仍保留
npm run dev
```

測試流程：

1. 切換主題為 dark
2. 拖曳調整視窗大小與位置
3. 最大化視窗，再關閉應用程式
4. 重新啟動後確認主題仍是 dark、視窗仍是最大化
5. 取消最大化後確認會回到原本的正常尺寸，而不是整個螢幕大小

---

## 6.9 資料儲存位置查詢（除錯用）

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

有一個很容易在上線前才踩到的坑：`userData` 預設會跟著 App 名稱走，而 `app.getName()` 又會優先使用 `package.json` 的 `productName`。如果你開發時叫 `electron-course-app`，發佈前才把 `productName` 改成正式中文名稱，使用者原本的設定可能看起來像整批消失，實際上只是資料夾換了。

若產品已經有固定資料路徑，可以在 main process 最前面、建立 store 之前釘住：

```javascript
const path = require("node:path");
const { app } = require("electron");

app.setPath("userData", path.join(app.getPath("appData"), "electron-course-app"));
```

notepad-app 實戰專案就用了這個做法，避免之後調整 `productName` 影響既有記事資料。

---

## 6.10 用 safeStorage 保存敏感字串（補充）

設定檔可以放主題、語言、視窗大小，但不適合明文存 token、refresh token 或 API key。這類「需要重開 App 後仍存在」的敏感字串，應該在 Main 端用 Electron 的 `safeStorage` 加密後再寫進 `userData`。

`src/main/store/token.store.js`（概念範例，請在 `app.whenReady()` 之後使用）：

```javascript
const fs = require("node:fs/promises");
const path = require("node:path");
const { app, safeStorage } = require("electron");

function tokenFile() {
  return path.join(app.getPath("userData"), "auth-token.bin");
}

async function saveToken(token) {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error("ENCRYPTION_NOT_AVAILABLE");
  }
  const encrypted = await safeStorage.encryptStringAsync(token);
  await fs.writeFile(tokenFile(), encrypted);
}

async function loadToken() {
  try {
    const encrypted = await fs.readFile(tokenFile());
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(encrypted);
    if (shouldReEncrypt) await saveToken(result);
    return result;
  } catch {
    return null;
  }
}

module.exports = { saveToken, loadToken };
```

`safeStorage` 不是萬能保險箱：它保護的是「磁碟上的明文不要裸奔」，但 App 執行中拿到 token 後仍要小心 XSS、IPC 白名單與 log 外洩。admin-dashboard 的延伸練習會把目前只存在記憶體的 token 改成這種做法。

---

## 6.11 本章小結

- 你學會使用 `electron-store` 保存設定
- 你完成了設定存取的 IPC 封裝
- 你建立了可持久化的使用者偏好機制
- 你用同一套 store 記住視窗大小與位置，讓 App 更貼近原生體驗
- 你知道 `userData` 路徑與 `productName` 的關係，也知道敏感字串應交給 `safeStorage`

---

> 下一章：[原生能力整合（通知、對話框、剪貼簿）](./07-native-features.md)
