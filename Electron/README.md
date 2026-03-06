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

> 準備好了嗎？從 [第一章：Electron 介紹與開發環境安裝](./01-electron-introduction-setup.md) 開始。
