const fs = require("node:fs");
const { ipcMain, dialog, BrowserWindow, nativeTheme } = require("electron");
const backupStore = require("../store/backup.store");
const settingsStore = require("../store/settings.store");

// 檔名固定用 ASCII，跟語言無關；使用者在存檔對話框裡本來就能改
function defaultFileName() {
  const stamp = new Date().toISOString().slice(0, 10);
  return `notepad-backup-${stamp}.json`;
}

// 對話框上的標題與檔案類型名稱由 renderer 傳進來（那邊才知道目前語言），
// 但它們純粹是顯示字串——路徑一律由使用者在系統對話框裡自己挑，
// renderer 沒有任何機會指定要讀寫哪個檔案。
function registerBackupIpc() {
  ipcMain.handle("backup:export", async (event, { title, filterName } = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender);

    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: typeof title === "string" ? title : undefined,
      defaultPath: defaultFileName(),
      filters: [{ name: typeof filterName === "string" ? filterName : "JSON", extensions: ["json"] }]
    });
    if (canceled || !filePath) return { canceled: true };

    try {
      const backup = backupStore.buildBackup();
      fs.writeFileSync(filePath, JSON.stringify(backup), "utf8");

      return {
        canceled: false,
        filePath,
        noteCount: backup.notes.length,
        imageCount: Object.keys(backup.images).length
      };
    } catch (error) {
      console.error("匯出備份失敗：", error);
      throw new Error("EXPORT_FAILED");
    }
  });

  ipcMain.handle("backup:import", async (event, { title, filterName } = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender);

    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: typeof title === "string" ? title : undefined,
      properties: ["openFile"],
      filters: [{ name: typeof filterName === "string" ? filterName : "JSON", extensions: ["json"] }]
    });
    if (canceled || filePaths.length === 0) return { canceled: true };

    // 先看檔案大小再讀，避免有人挑了一個 10GB 的檔案直接把記憶體吃光
    const { size } = fs.statSync(filePaths[0]);
    if (size > backupStore.MAX_BACKUP_BYTES) throw new Error("BACKUP_TOO_LARGE");

    const result = backupStore.restoreBackup(fs.readFileSync(filePaths[0], "utf8"));

    // 匯入的設定裡可能換了主題，原生元件與視窗底色要跟著更新
    nativeTheme.themeSource = result.settings.theme;
    win?.setBackgroundColor(settingsStore.backgroundColor(result.settings.theme));

    return { canceled: false, ...result };
  });
}

module.exports = { registerBackupIpc };
