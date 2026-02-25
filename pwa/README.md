# PWA 完整教學課程

> 從零開始學習 Progressive Web App（PWA），涵蓋核心觀念、離線策略、安裝體驗、推播通知到部署上線與故障排查的完整課程。

---

## 課程目錄

| 章節 | 檔案 | 主題 |
|------|------|------|
| 01 | [01-introduction.md](./01-introduction.md) | PWA 基礎觀念與開發環境 |
| 02 | [02-web-app-manifest.md](./02-web-app-manifest.md) | Web App Manifest 完整設定 |
| 03 | [03-service-worker-basics.md](./03-service-worker-basics.md) | Service Worker 生命週期與攔截流程 |
| 04 | [04-caching-strategies.md](./04-caching-strategies.md) | 快取策略設計（Cache First / Network First / SWR） |
| 05 | [05-offline-fallback-and-data.md](./05-offline-fallback-and-data.md) | 離線頁面、資料保存與重送機制 |
| 06 | [06-update-lifecycle.md](./06-update-lifecycle.md) | 版本更新流程與使用者提示 |
| 07 | [07-installability-and-ux.md](./07-installability-and-ux.md) | 可安裝性與安裝引導 UX |
| 08 | [08-push-notifications.md](./08-push-notifications.md) | Web Push 推播通知實作 |
| 09 | [09-testing-and-debugging.md](./09-testing-and-debugging.md) | 測試、除錯與品質驗證 |
| 10 | [10-deployment-and-real-world.md](./10-deployment-and-real-world.md) | 部署上線與實際情境排查 |

---

## 課程特色

- **情境導向教學**：每章都包含「實際運行會遇到的問題」與「可落地的解法」。
- **從開發到上線**：不只教語法，更涵蓋更新策略、監控與部署實務。
- **跨平台考量**：同時說明 Android、Desktop、iOS Safari 的差異。
- **可直接演練**：每章都有可執行的程式片段與驗證步驟。

## 適合對象

- 具備 HTML / CSS / JavaScript 基礎，想做可安裝 Web App 的前端工程師
- 想提升網站離線可用性、效能與使用者留存的產品開發者
- 想建立一套可維護的 PWA 架構與部署流程的團隊

## 學習路線建議

```
基礎篇（必修）
  01 基礎觀念與環境 → 02 Manifest 設定 → 03 Service Worker 基礎

核心篇（重點實作）
  04 快取策略 → 05 離線資料流程 → 06 更新生命週期

體驗篇（產品化）
  07 安裝引導 UX → 08 推播通知

維運篇（上線必備）
  09 測試與除錯 → 10 部署與真實情境排查
```

## 環境需求

- Node.js：20+（建議 LTS）
- 瀏覽器：Chrome / Edge 最新版（用於完整 PWA 偵錯）
- 開發工具：Cursor / VS Code
- 本機 HTTPS：`localhost` 可視為安全環境；正式環境需 HTTPS

---

> 準備好了嗎？先從 [第一章：PWA 基礎觀念與開發環境](./01-introduction.md) 開始。
