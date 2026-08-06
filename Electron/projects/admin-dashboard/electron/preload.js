const { contextBridge, ipcRenderer } = require("electron");

// 取資料只有這一個方法。它長得像 fetch：給 method / path / query / body，
// 回一個 { ok, status, code, message, data } 的信封。
//
// 這裡故意不做任何「解讀」——不判斷 status、不 throw、不轉型。要不要把 401 當成
// 錯誤、要不要重試，是前端的策略，屬於 src/api/client.js 的責任。preload 只當管線。
contextBridge.exposeInMainWorld("adminApi", {
  request({ method, path, params, body, token }) {
    return ipcRenderer.invoke("api:request", { method, path, params, body, token });
  }
});

// 標題列是自己畫的（見 main.js 的 titleBarStyle），但 Windows / Linux 上那三顆
// 系統控制鈕還是原生的，底色只有 main 改得動——所以主題切換時通知它一聲。
// 用 send 不用 invoke：這是通知，不需要回覆。
contextBridge.exposeInMainWorld("appWindow", {
  setTitleBarTheme(theme) {
    ipcRenderer.send("titlebar:theme", theme);
  }
});

function fromArgv(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

// renderer 沒有 process 可用，需要的幾個唯讀字串由 preload 傳過去就夠了
contextBridge.exposeInMainWorld("appInfo", {
  platform: process.platform,
  version: fromArgv("app-version", "0.0.0"),
  isDev: fromArgv("app-mode", "production") === "development"
});
