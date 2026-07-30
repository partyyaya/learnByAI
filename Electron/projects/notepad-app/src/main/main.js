const path = require("node:path");
const { app, BrowserWindow, nativeImage, nativeTheme, shell } = require("electron");
const { registerImageScheme, handleImageProtocol } = require("./image-protocol");
const { registerNotesIpc } = require("./ipc/notes.ipc");
const { registerSettingsIpc } = require("./ipc/settings.ipc");
const { registerBackupIpc } = require("./ipc/backup.ipc");
const notesStore = require("./store/notes.store");
const settingsStore = require("./store/settings.store");

// package.json 加了 productName 之後 app.getName() 會變成「記事本」，
// 而 userData 預設是 <appData>/<app 名稱>——不釘住的話資料夾會跟著改名，
// 已經存在的記事看起來就像整批消失了。這裡固定用原本的資料夾。
app.setPath("userData", path.join(app.getPath("appData"), "electron-notepad"));

// 自訂 scheme 一定要在 app ready 之前註冊
registerImageScheme();

// App 圖示（橘白肥貓捧著一支筆）。原始檔是 build/icon.svg，PNG 用 `npm run icon` 產生。
const ICON_FILE = path.join(__dirname, "../../build/icon.png");

// 視窗標題只在「視窗開了、頁面還沒載入」那一瞬間看得到，
// 之後 renderer 會用 i18n 的 app.title 覆蓋掉（見 src/renderer/i18n.js）。
const WINDOW_TITLES = { "zh-Hant": "記事本", en: "Notepad" };

let mainWindow = null;

function createMainWindow() {
  const { theme } = settingsStore.readSettings();
  const language = settingsStore.resolveLanguage(); // 使用者選過就用選的，沒有才看系統偏好

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    title: WINDOW_TITLES[language],
    icon: ICON_FILE, // Windows / Linux 的視窗與工作列圖示；macOS 走下面的 app.dock
    backgroundColor: settingsStore.backgroundColor(theme), // 開場那一瞬間的底色
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 讓 preload 一開始就同步拿得到主題與語言，renderer 才不會先畫錯再改
      additionalArguments: [`--initial-theme=${theme}`, `--initial-language=${language}`]
    }
  });

  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));

  if (!app.isPackaged) mainWindow.webContents.openDevTools({ mode: "detach" });

  // 記事內容可能含外部連結：一律用系統瀏覽器開，不在 App 裡開新視窗
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// macOS 的 dock 圖示不吃 BrowserWindow 的 icon，要另外設。
// 這一段只為了「開發時 npm run dev 也看得到貓」：打包後的 dock 圖示來自 .app 裡的
// icns（electron-builder 會用 build/icon.png 產生），而 build/ 不在打包內容裡。
function applyDockIcon() {
  if (app.isPackaged || process.platform !== "darwin" || !app.dock) return;

  const icon = nativeImage.createFromPath(ICON_FILE);
  if (icon.isEmpty()) {
    console.error("讀不到 App 圖示，請先跑 npm run icon：", ICON_FILE);
    return;
  }
  app.dock.setIcon(icon);
}

app.whenReady().then(() => {
  applyDockIcon();
  notesStore.ensureDataDirs();
  handleImageProtocol(notesStore.imagesDir());
  notesStore.cleanupOrphanImages(); // 清掉上次沒存檔就關閉時留下的圖片
  nativeTheme.themeSource = settingsStore.readSettings().theme; // 原生元件也跟著使用者選的樣式
  registerNotesIpc();
  registerSettingsIpc();
  registerBackupIpc();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
