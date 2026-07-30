const { ipcMain, nativeTheme, BrowserWindow } = require("electron");
const settingsStore = require("../store/settings.store");

function registerSettingsIpc() {
  ipcMain.handle("settings:set-theme", async (event, theme) => {
    const saved = settingsStore.setTheme(theme);

    // 原生的部分（捲軸、右鍵選單、confirm 對話框）跟著換色
    nativeTheme.themeSource = saved.theme;

    // 視窗底色也要換，否則之後縮放或重新載入時會閃一下另一個主題的顏色
    BrowserWindow.fromWebContents(event.sender)?.setBackgroundColor(
      settingsStore.backgroundColor(saved.theme)
    );

    return saved;
  });

  ipcMain.handle("settings:set-language", async (_event, language) =>
    settingsStore.setLanguage(language)
  );
}

module.exports = { registerSettingsIpc };
