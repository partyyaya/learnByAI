# 第七章：原生能力整合（通知、對話框、剪貼簿）

## 7.1 章節目標

本章會把 Electron 的系統整合能力接到你的 App：

- 系統通知（Notification）
- 原生對話框（Dialog）
- 剪貼簿（Clipboard）
- 開啟外部連結（Shell）

---

## 7.2 Main 端建立原生功能 IPC

`src/main/ipc/native.ipc.js`：

```javascript
const { ipcMain, dialog, Notification, clipboard, shell } = require("electron");

function registerNativeIpc() {
  ipcMain.handle("native:show-open-dialog", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile", "openDirectory", "multiSelections"]
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
    await shell.openExternal(url);
    return { ok: true };
  });
}

module.exports = { registerNativeIpc };
```

---

## 7.3 註冊與 Preload 暴露

在 `src/main/main.js` 註冊：

```javascript
const { registerNativeIpc } = require("./ipc/native.ipc");

app.whenReady().then(() => {
  registerNativeIpc();
  createMainWindow();
});
```

在 `src/preload/preload.js` 暴露 API：

```javascript
const { contextBridge, ipcRenderer } = require("electron");

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
