# 第三章：Service Worker 生命週期與攔截流程

## 3.1 Service Worker 生命週期

Service Worker（SW）會經過以下狀態：

1. `installing`：下載並安裝新版本 SW
2. `installed`（waiting）：安裝完成，等待接管
3. `activating`：啟用中
4. `activated`：正式接管頁面請求

理解這個流程，是避免「更新了卻沒生效」的關鍵。

## 3.2 最小可用 SW 架構

```js
// 目前使用的靜態資源快取版本
const STATIC_CACHE = "static-v1";
// 預先快取的 App Shell（最小可啟動資源）
const STATIC_ASSETS = ["/", "/index.html", "/manifest.webmanifest"];

// install：安裝 SW 時先把核心檔案放進快取
self.addEventListener("install", (event) => {
  // 等快取完成後才視為 install 成功
  event.waitUntil(caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS)));
});

// activate：新 SW 啟用時清掉舊版本快取
self.addEventListener("activate", (event) => {
  event.waitUntil(
    // 取得所有 cache key，刪除不是目前版本的快取
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== STATIC_CACHE).map((key) => caches.delete(key)))
    )
  );
  // 讓目前 scope 內的頁面盡快被新 SW 接管
  self.clients.claim();
});

// fetch：攔截請求，提供快取優先（Cache First）回應
self.addEventListener("fetch", (event) => {
  // 非 GET 請求（POST/PUT/DELETE）通常不進快取策略
  if (event.request.method !== "GET") return;
  // 有快取就回快取，沒有才走網路
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
```

## 3.3 更新時的控制訊號

可在頁面端主動監聽新 SW：

```ts
// 註冊 Service Worker，拿到 registration 物件
navigator.serviceWorker.register("/sw.js").then((registration) => {
  // 當瀏覽器發現新版本 SW（下載中）時會觸發
  registration.addEventListener("updatefound", () => {
    // 正在安裝的新 SW 實例
    const newWorker = registration.installing;
    // 保險判斷：若沒有 installing worker 就中止
    if (!newWorker) return;
    // 監聽新 SW 的狀態變化（installing -> installed -> activating...）
    newWorker.addEventListener("statechange", () => {
      // installed + 有 controller = 代表舊 SW 正在控制頁面，新 SW 已可提示更新
      if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
        // 顯示「有新版本可更新」提示
      }
    });
  });
});
```

## 3.4 實際運行情境與解決方法

### 情境一：新版本發布了，使用者還是舊畫面

**原因**：新 SW 進入 `waiting`，尚未接管現有頁面。  
**解法**：

- 顯示更新提示，讓使用者點擊後呼叫 `skipWaiting`
- 在點擊事件中對 waiting SW `postMessage({ type: "SKIP_WAITING" })`

### 情境二：SW 檔案更新後瀏覽器仍抓舊檔

**原因**：`sw.js` 被中間層快取（CDN/代理）。  
**解法**：

- 對 `sw.js` 設定 `Cache-Control: no-cache`
- 確保每次部署都能拿到最新版 SW 腳本

### 情境三：`fetch` 攔截後頁面偶發空白

**原因**：`event.respondWith` 裡面 promise 拋錯，沒有 fallback。  
**解法**：

- 在 `fetch` 流程加上 `catch`，回傳快取頁或離線頁
- 嚴格區分 HTML 導航與 API 請求的錯誤處理策略

### 情境四：`navigator.serviceWorker.controller` 為 `null`

**原因**：頁面尚未被 SW 控制（通常首次載入）。  
**解法**：

- 重新整理頁面一次
- 不要把第一次就有 controller 當成必要條件

### 情境五：開發階段改了 SW 但行為非常混亂

**原因**：舊快取與舊 SW 混在一起。  
**解法**：

- DevTools Application 清除 `Storage`、`Cache Storage`
- 暫時 `Unregister service worker` 再重新測試

## 3.5 本章小結

- SW 的 `install -> waiting -> activate` 是更新除錯的核心線索
- 版本管理要同時考慮「SW 腳本」與「快取內容」
- 頁面提示更新，比直接強制刷新更友善且穩定

---

> 上一章：[Web App Manifest 完整設定](./02-web-app-manifest.md) | 下一章：[快取策略設計](./04-caching-strategies.md)
