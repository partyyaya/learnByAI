const { contextBridge, ipcRenderer } = require("electron");

// 只暴露這七個方法給 renderer，不把 ipcRenderer 本身丟出去
contextBridge.exposeInMainWorld("notesApi", {
  // 取得所有記事（新到舊）
  list() {
    return ipcRenderer.invoke("notes:list");
  },

  // 新增一篇記事，回傳存好的 note 物件（含 main 端補上的 id / 預設標題 / 時間）
  create({ title, contentHtml }) {
    return ipcRenderer.invoke("notes:create", { title, contentHtml });
  },

  // 編輯既有記事，回傳更新後的 note 物件（id 與 createdAt 不變，多一個 updatedAt）
  update({ id, title, contentHtml }) {
    return ipcRenderer.invoke("notes:update", { id, title, contentHtml });
  },

  // 刪除記事
  remove(id) {
    return ipcRenderer.invoke("notes:delete", id);
  },

  // 存下貼上的圖片，回傳可直接放進 <img src> 的 note-image:// 網址
  saveImage({ mimeType, data }) {
    return ipcRenderer.invoke("notes:save-image", { mimeType, data });
  },

  // 記事資料夾的位置（顯示用）
  dataDir() {
    return ipcRenderer.invoke("notes:data-dir");
  },

  // 用系統的檔案總管打開記事資料夾；路徑由 main 決定，這裡不傳任何參數
  openDataFolder() {
    return ipcRenderer.invoke("notes:open-data-dir");
  }
});

// 開場的主題與語言由 main 透過 webPreferences.additionalArguments 塞進 process.argv，
// 這樣 renderer 第一次畫面就是對的顏色與語言，不用等 IPC 回來才換（會閃一下）。
function fromArgv(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

// 快捷鍵提示要顯示 ⌘ 還是 Ctrl，取決於作業系統。
// renderer 沒有 process 可用，由 preload 傳唯讀字串過去就夠了（sandbox 下 process 仍讀得到這些）。
contextBridge.exposeInMainWorld("appInfo", {
  platform: process.platform,
  initialTheme: fromArgv("initial-theme", "light"),
  initialLanguage: fromArgv("initial-language", "zh-Hant")
});

// 偏好設定：只開放「寫入」，讀取用上面那兩個開場值就夠了
contextBridge.exposeInMainWorld("settingsApi", {
  setTheme(theme) {
    return ipcRenderer.invoke("settings:set-theme", theme);
  },

  setLanguage(language) {
    return ipcRenderer.invoke("settings:set-language", language);
  }
});

// 備份：匯出／匯入整包資料。
// 只傳「對話框上要顯示的字」過去，實際要讀寫哪個檔案由使用者在系統對話框裡挑，
// renderer 拿不到也指定不了路徑。
contextBridge.exposeInMainWorld("backupApi", {
  exportAll({ title, filterName }) {
    return ipcRenderer.invoke("backup:export", { title, filterName });
  },

  importAll({ title, filterName }) {
    return ipcRenderer.invoke("backup:import", { title, filterName });
  }
});
