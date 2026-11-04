# 第九章：測試、除錯與品質驗證

## 9.1 PWA 測試清單

每次發版前，至少確認：

- Service Worker 可註冊、可更新
- 離線模式可打開核心頁面
- API 失敗時有可理解回饋
- 可安裝流程可觸發
- DevTools `Application -> Manifest` 的 Installability 區塊沒有錯誤

## 9.2 DevTools 常用面板

- `Application -> Manifest`：檢查圖示、start_url、安裝條件（Installability 區塊會列出不符合的項目）
- `Application -> Service Workers`：檢查 SW 狀態與更新，這裡有三個常用勾選項：
  - `Offline`：讓頁面與 SW 都以為離線
  - `Update on reload`：每次重新整理都安裝新 SW 並立刻接管
  - `Bypass for network`：暫時略過 SW，所有請求直接走網路
- `Application -> Cache Storage`：檢查快取命中與版本
- `Network`（Offline/慢速網路）：模擬網路異常

Chrome 內建頁面：

- `chrome://serviceworker-internals`：列出所有已註冊的 SW，可強制停止或解除註冊
- `chrome://web-app-internals`：已安裝 App 的 manifest 與安裝資訊

實機除錯：

- Android：手機開啟 USB 偵錯，接上電腦後在電腦 Chrome 開 `chrome://inspect`，就能用 DevTools 檢查手機上的頁面與已安裝的 App
- iOS：iPhone 的 Safari 設定 →「進階」開啟「網頁檢閱器」，接上 Mac 後從 Mac Safari 的「開發」選單檢查

## 9.3 常用除錯指令與動作

```bash
# 本機啟動建置版（較接近正式環境）
npm run build
npm run preview

# Lighthouse（可搭配 CI）：看效能與最佳做法
npx lighthouse http://localhost:4173 --view
```

Lighthouse 從 12 版起已移除 PWA 分類，安裝與離線相關的檢查改用 9.2 的 DevTools 面板與實際操作確認。

DevTools 中建議搭配：

- 改 SW 程式時可勾選 `Update on reload` 加快迭代；測試第六章的更新提示時要取消勾選，否則新版會直接接管，看不到 waiting 狀態
- 測試前先到 `Application -> Storage` 按 `Clear site data`
- 針對不同網路狀態各跑一次完整流程

## 9.4 自動化測試建議

- E2E（Playwright/Cypress）覆蓋關鍵路徑：登入、主要查詢、提交
- 模擬離線後驗證 fallback 顯示與恢復同步：先等 `navigator.serviceWorker.ready`、重新整理一次讓頁面受 SW 控制，再切離線
- 建立 smoke test：版本更新提示是否出現

## 9.5 實際運行情境與解決方法

### 情境一：切到 Offline 後重新整理，出現瀏覽器內建的離線頁

**原因**：導航請求沒有 fallback、快取漏了入口檔，或頁面根本沒被 SW 控制。  
**解法**：

- 對 `navigate` 請求提供 app shell/offline 頁
- 確認 `index.html` 及關鍵資產在快取內
- 確認 `navigator.serviceWorker.controller` 不是 `null`，而且不是用 Shift + 重新整理（會略過 SW）

### 情境二：開發測試都正常，上線才出現混合內容錯誤

**原因**：正式站是 HTTPS，但仍請求 `http://` 資源。  
**解法**：

- 全面改為 `https://`（不要用 `//cdn...` 這種省略協議的寫法）
- 後端 API、圖片 CDN、字型都要檢查
- 過渡期可加 CSP `upgrade-insecure-requests`，讓瀏覽器自動把 `http://` 請求升級成 HTTPS

### 情境三：每次測試結果不一致

**原因**：舊快取殘留導致可重現性差。  
**解法**：

- 測試前固定清除 `Cache Storage` 與 `IndexedDB`
- 測試腳本中加入 clear step

### 情境四：開發環境熱更新導致 SW 行為混亂

**原因**：HMR 與 SW 快取同時作用，行為互相干擾。  
**解法**：

- 開發時不註冊 SW（第一章 1.4 的 `import.meta.env.PROD` 判斷），重點測試放在 preview/build 環境
- 必要時在 Console 全數解除註冊：

```js
const registrations = await navigator.serviceWorker.getRegistrations();
await Promise.all(registrations.map((registration) => registration.unregister()));
```

### 情境五：Android 正常、iOS 問題一堆

**原因**：Safari 對 PWA API 支援與限制不同。  
**解法**：

- 建立平台測試矩陣（Chrome Android / Safari iOS / Desktop），iOS 要分「Safari 分頁」與「主畫面 App」兩種情況測
- 功能採漸進增強，對不支援特性（Background Sync、`beforeinstallprompt`、未安裝時的推播）提供替代方案

## 9.6 本章小結

- PWA 除錯要以「環境差異」與「快取狀態」為主軸
- DevTools 的 Application 面板是主要檢查工具，Lighthouse 只看效能與最佳做法
- 自動化測試應覆蓋離線、更新、安裝三條關鍵流程

---

> 上一章：[Web Push 推播通知實作](./08-push-notifications.md) | 下一章：[部署上線與實際情境排查](./10-deployment-and-real-world.md)
