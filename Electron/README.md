# Electron 完整教學課程

> 從零開始學習 Electron，建立可在 macOS / Windows / Linux 執行的跨平台桌面應用程式，並完成打包、簽章與自動更新流程。

---

## 課程目錄

| 章節 | 檔案 | 主題 |
|------|------|------|
| 01 | [01-electron-introduction-setup.md](./01-electron-introduction-setup.md) | Electron 介紹與開發環境安裝 |
| 02 | [02-first-app-quick-start.md](./02-first-app-quick-start.md) | 建立第一個 Electron 應用程式 |
| 03 | [03-main-renderer-preload.md](./03-main-renderer-preload.md) | Main / Renderer / Preload 架構解析 |
| 04 | [04-ipc-communication.md](./04-ipc-communication.md) | IPC 通訊與安全橋接實作 |
| 05 | [05-window-menu-tray.md](./05-window-menu-tray.md) | 視窗、選單、系統匣與快捷鍵 |
| 06 | [06-data-storage-config.md](./06-data-storage-config.md) | 本機資料儲存與設定管理 |
| 07 | [07-native-features.md](./07-native-features.md) | 原生能力整合（通知、對話框、剪貼簿） |
| 08 | [08-packaging-distribution.md](./08-packaging-distribution.md) | 打包、安裝檔產生與跨平台發佈 |
| 09 | [09-security-auto-update.md](./09-security-auto-update.md) | 安全最佳實踐與自動更新 |
| 10 | [10-debugging-testing-cicd.md](./10-debugging-testing-cicd.md) | 除錯、測試與 CI/CD 發佈流程 |
| 11 | [11-steam-release-workflow.md](./11-steam-release-workflow.md) | Steam 發行實戰（上傳、迭代、測試、排錯） |

## 實戰專案

除了章節教材，[projects/](./projects/) 資料夾另收錄**可直接執行**的完整小專案，把各章的片段組成一個能用的產品：

| 專案 | 說明 | 主要涵蓋章節 |
|------|------|--------------|
| [projects/notepad-app](./projects/notepad-app/) | 本機記事本：左側清單 + 右側撰寫區，內容可貼上文字與圖片，全部離線儲存 | 03 / 04 / 06 / 09 |

---

## 課程特色

- **完整學習路線**：從 Hello World 到可上線的桌面產品
- **實作導向**：每章都提供可直接執行的命令與程式碼
- **安全優先**：預設導入 `contextIsolation`、IPC 白名單與內容安全策略
- **部署落地**：包含 `electron-builder`、簽章、更新伺服器、GitHub Actions 與 SteamPipe

## 適合對象

- 前端工程師想進入桌面應用開發
- 後端工程師想把內部工具 GUI 化
- 團隊需要跨平台桌面軟體解決方案
- 想建立可持續交付（CI/CD）的 Electron 產品

## 學習路線建議

```text
基礎篇（必修）
  01 介紹與安裝 → 02 第一個應用 → 03 三進程架構

核心篇（重點）
  04 IPC 通訊安全 → 05 視窗與互動介面 → 06 資料儲存

產品化篇（上線）
  07 原生能力整合 → 08 打包發佈 → 09 安全與自動更新

工程化篇（團隊協作）
  10 除錯、測試與 CI/CD

發行篇（平台整合）
  11 Steam 發行實戰（SteamPipe）
```

## 環境需求

- Node.js：20 LTS 或以上
- npm：10+（或 pnpm / yarn 皆可）
- 作業系統：macOS / Windows / Linux
- 建議工具：VS Code、Git、Postman（若有本機 API 整合）

---

## 延伸方向：整合前端框架（React / Vue + Vite）

本課程刻意用原生 HTML / CSS / JS 撰寫 renderer，目的是把焦點放在 **Electron 本身**（三進程架構、IPC、打包、發佈），不被前端框架的設定細節分散注意力。

當你要做真實產品、需要 React / Vue 的元件化、TypeScript 與 HMR 熱更新時，會再加一層前端建置工具。核心概念只有一個——**開發時載入 dev server，打包後載入建置好的靜態檔**：

```javascript
// main.js（概念示意）
if (!app.isPackaged) {
  // 開發：連到 Vite dev server，享受 HMR 熱更新
  win.loadURL(process.env.VITE_DEV_SERVER_URL);
} else {
  // 正式：載入 Vite 建置後的靜態產物
  win.loadFile(path.join(__dirname, "../renderer/dist/index.html"));
}
```

常見的兩條整合路線：

- **[Electron Forge](https://www.electronforge.io/) + Vite plugin**：官方推薦的一站式工具，含開發、打包、發佈。
- **[electron-vite](https://electron-vite.org/)**：以 Vite 為核心、對 main / preload / renderer 三端都做好設定的整合方案。

本 repo 另有 React、Vue 與 Vite 課程，學完本課程後可搭配使用，把這裡的 Electron 主程序骨架接上框架化的前端。

---

> 準備好了嗎？從 [第一章：Electron 介紹與開發環境安裝](./01-electron-introduction-setup.md) 開始。
