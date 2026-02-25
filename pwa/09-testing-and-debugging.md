# 第九章：測試、除錯與品質驗證

## 9.1 PWA 測試清單

每次發版前，至少確認：

- Service Worker 可註冊、可更新
- 離線模式可打開核心頁面
- API 失敗時有可理解回饋
- 可安裝流程可觸發
- Lighthouse PWA 指標無重大警告

## 9.2 DevTools 常用面板

- `Application -> Manifest`：檢查圖示、start_url、安裝條件
- `Application -> Service Workers`：檢查 SW 狀態與更新
- `Application -> Cache Storage`：檢查快取命中與版本
- `Network`（Offline/Slow 3G）：模擬網路異常

## 9.3 常用除錯指令與動作

```bash
# 本機啟動建置版（較接近正式環境）
npm run build
npm run preview

# Lighthouse（可搭配 CI）
npx lighthouse http://localhost:4173 --view
```

DevTools 中建議搭配：

- 勾選 `Update on reload`（開發除錯方便）
- 測試前先 `Clear storage`
- 針對不同網路狀態各跑一次完整流程

## 9.4 自動化測試建議

- E2E（Playwright/Cypress）覆蓋關鍵路徑：登入、主要查詢、提交
- 模擬離線後驗證 fallback 顯示與恢復同步
- 建立 smoke test：版本更新提示是否出現

## 9.5 實際運行情境與解決方法

### 情境一：Lighthouse 顯示「Does not work offline」

**原因**：導航請求沒有 fallback，或快取漏了入口檔。  
**解法**：

- 對 `navigate` 請求提供 app shell/offline 頁
- 確認 `index.html` 及關鍵資產在快取內

### 情境二：開發測試都正常，上線才出現混合內容錯誤

**原因**：正式站是 HTTPS，但仍請求 `http://` 資源。  
**解法**：

- 全面改為 `https://` 或相對協議
- 後端 API、圖片 CDN、字型都要檢查

### 情境三：每次測試結果不一致

**原因**：舊快取殘留導致可重現性差。  
**解法**：

- 測試前固定清除 `Cache Storage` 與 `IndexedDB`
- 測試腳本中加入 clear step

### 情境四：開發環境熱更新導致 SW 行為混亂

**原因**：HMR 與 SW 快取同時作用，行為互相干擾。  
**解法**：

- 開發時縮小 SW 快取範圍，重點測試放在 preview/build 環境
- 必要時使用 `navigator.serviceWorker.getRegistrations()` 全數解除註冊

### 情境五：Android 正常、iOS 問題一堆

**原因**：Safari 對 PWA API 支援與限制不同。  
**解法**：

- 建立平台測試矩陣（Chrome Android / Safari iOS / Desktop）
- 功能採漸進增強，對不支援特性提供替代方案

## 9.6 本章小結

- PWA 除錯要以「環境差異」與「快取狀態」為主軸
- Lighthouse 是入口，不是唯一依據
- 自動化測試應覆蓋離線、更新、安裝三條關鍵流程

---

> 上一章：[Web Push 推播通知實作](./08-push-notifications.md) | 下一章：[部署上線與實際情境排查](./10-deployment-and-real-world.md)
