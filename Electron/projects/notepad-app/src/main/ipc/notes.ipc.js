const { ipcMain, shell } = require("electron");
const notesStore = require("../store/notes.store");

// 所有檔案存取都留在 main process，renderer 只能透過這幾個白名單通道操作
function registerNotesIpc() {
  ipcMain.handle("notes:list", async () => notesStore.listNotes());

  ipcMain.handle("notes:create", async (_event, payload) =>
    notesStore.createNote(payload ?? {})
  );

  ipcMain.handle("notes:update", async (_event, payload) => {
    const { id, title, contentHtml } = payload ?? {};
    return notesStore.updateNote(id, { title, contentHtml });
  });

  ipcMain.handle("notes:delete", async (_event, id) => {
    if (typeof id !== "string") throw new Error("INVALID_ID");
    return { deleted: notesStore.deleteNote(id) };
  });

  ipcMain.handle("notes:save-image", async (_event, payload) =>
    notesStore.saveImage(payload ?? {})
  );

  // 記事資料夾的位置：只給 renderer 顯示用（tooltip），不接受 renderer 傳路徑進來
  ipcMain.handle("notes:data-dir", async () => notesStore.dataDir());

  ipcMain.handle("notes:open-data-dir", async () => {
    notesStore.ensureDataDirs(); // 資料夾被手動刪掉時先補回來，不然一定打不開

    // 路徑是 main 自己算出來的（app.getPath("userData") 底下），
    // 絕對不能拿 renderer 傳來的字串去 openPath——那等於開放它開啟任何檔案。
    const failure = await shell.openPath(notesStore.dataDir());
    if (failure) {
      console.error("打開記事資料夾失敗：", failure);
      throw new Error("OPEN_FOLDER_FAILED");
    }
    return { opened: true };
  });
}

module.exports = { registerNotesIpc };
