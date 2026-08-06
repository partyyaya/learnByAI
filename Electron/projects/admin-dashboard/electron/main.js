const path = require("node:path");
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { registerApiIpc } = require("./mock/api.ipc");

// 開發時 renderer 是 Vite dev server（有 HMR），打包後才是 dist-renderer 裡的靜態檔。
// 網址由 scripts/dev.mjs 在確定 server listen 成功之後用環境變數傳進來，
// 所以這裡不需要寫死 port，也不會發生「Electron 比 dev server 早開」的競爭條件。
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const IS_DEV = Boolean(DEV_SERVER_URL);
const IS_MAC = process.platform === "darwin";

// 自己畫的標題列高度。這個值 CSS 那邊也要有一份（global.css 的 --titlebar-h），
// 因為紅綠燈／系統控制鈕的位置是 main 決定的，版面留白是 renderer 決定的。
const TITLEBAR_HEIGHT = 32;

// 跟 global.css 兩套主題的 --surface / --text 同一個值。
// Windows / Linux 的系統控制鈕（最小化、關閉那三顆）是原生畫的，底色只有 main
// 改得動，所以主題切換時 renderer 要送一次訊息過來（見 preload 的 appWindow）。
// macOS 的紅綠燈只吃 height，顏色是系統的，不必跟著主題換。
const TITLEBAR_THEMES = {
  dark: { color: "#161b22", symbolColor: "#e6edf3" },
  light: { color: "#ffffff", symbolColor: "#16202c" }
};

let mainWindow = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 640,
    title: "後台管理",
    // 頁面還沒載入時的底色。跟 global.css 裡深色主題的 --bg 一樣，開場才不會閃白
    backgroundColor: "#0d1117",
    // 內容還沒畫好就先別顯示視窗，避免看到半成品版面
    show: false,

    // 系統標題列的底色是作業系統給的，App 改不動。深色的後台上面頂一條淺色的
    // 標題列，最上面那一段就會跟整個介面脫節。解法是把標題列藏起來、那一條改由
    // 頁面自己畫（<Titlebar /> + global.css 的 .titlebar），顏色就能跟側邊欄、
    // 導航欄共用同一個 --surface。
    //   macOS：hiddenInset — 紅綠燈留著，只是往內縮一點
    //   Windows / Linux：hidden — 三顆控制鈕改用 titleBarOverlay 疊在頁面上
    titleBarStyle: IS_MAC ? "hiddenInset" : "hidden",
    // 兩個平台都要給 titleBarOverlay：有它，CSS 才拿得到 env(titlebar-area-*)，
    // 版面不用自己猜「紅綠燈佔掉左邊多少寬度」。
    titleBarOverlay: { height: TITLEBAR_HEIGHT, ...TITLEBAR_THEMES.dark },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [
        `--app-version=${app.getVersion()}`,
        `--app-mode=${IS_DEV ? "development" : "production"}`
      ]
    }
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());

  if (IS_DEV) {
    mainWindow.loadURL(DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist-renderer/index.html"));
  }

  // 後台裡的外部連結一律交給系統瀏覽器，不在 App 內開新視窗
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // 除了 dev server 與本機檔案，其他導航全部擋掉。
  // 少了這一層，只要頁面上有一個 <a href="https://…"> 被點到，整個 App 就會
  // 變成一個沒有網址欄的瀏覽器，而且那個外部頁面跟 preload 共用同一個 window。
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = IS_DEV ? url.startsWith(DEV_SERVER_URL) : url.startsWith("file://");
    if (!allowed) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/**
 * 主題切換之後，把系統控制鈕那一塊的底色也換掉，不然淺色主題下右上角會留一塊深色。
 *
 * 用 on/send（單向通知）而不是 handle/invoke：renderer 不需要回覆，也不該等 main
 * 回話才更新自己的畫面。
 */
function registerTitleBarIpc() {
  ipcMain.on("titlebar:theme", (event, theme) => {
    const overlay = TITLEBAR_THEMES[theme];
    const win = BrowserWindow.fromWebContents(event.sender);
    // macOS 的紅綠燈顏色是系統的，改不動；setTitleBarOverlay 也只有 Windows 有
    if (!overlay || !win || IS_MAC || typeof win.setTitleBarOverlay !== "function") return;
    win.setTitleBarOverlay({ height: TITLEBAR_HEIGHT, ...overlay });
  });
}

app.whenReady().then(() => {
  registerApiIpc();
  registerTitleBarIpc();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
