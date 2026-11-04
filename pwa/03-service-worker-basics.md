# 第三章：Service Worker 生命週期與攔截流程

## 3.1 Service Worker 生命週期

Service Worker（SW）會經過以下狀態（也就是 `worker.state` 的值）：

1. `installing`：下載並安裝新版本 SW
2. `installed`（waiting）：安裝完成，等待接管
3. `activating`：啟用中
4. `activated`：正式接管頁面請求
5. `redundant`：被淘汰。可能是 `install` 失敗（例如 `cache.addAll` 裡有一個檔案 404），或已被更新的版本取代

理解這個流程，是避免「更新了卻沒生效」的關鍵。

### 瀏覽器什麼時候檢查新版

- 每次導覽到 scope 內的頁面
- 收到 `push`、`sync` 等事件，而且距離上次檢查超過 24 小時
- 呼叫 `registration.update()`，或用不同的網址重新 `register()`

檢查時會重新下載 `sw.js`，和目前的版本逐位元組比對（`importScripts` 載入的檔案也會比），只要有一個位元組不同就安裝新版。

### 新版什麼時候接管

新版安裝完會停在 waiting，直到舊版控制的分頁全部關閉。只按重新整理不夠：重新整理時新舊頁面會短暫重疊，舊 SW 始終有頁面在用。要提早接管就得呼叫 `skipWaiting()`（第六章）。

## 3.2 最小可用 SW 架構

```js
// 目前使用的靜態資源快取版本
const STATIC_CACHE = "static-v1";
// 這一版要保留的快取；之後加入 API、圖片等快取時也要列進來，否則每次啟用都會被刪
const CURRENT_CACHES = [STATIC_CACHE];
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
    caches
      .keys()
      // 刪除不在保留清單裡的快取（也就是舊版本）
      .then((keys) =>
        Promise.all(keys.filter((key) => !CURRENT_CACHES.includes(key)).map((key) => caches.delete(key)))
      )
      // 清完再讓目前 scope 內的頁面被新 SW 接管
      .then(() => self.clients.claim())
  );
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
  // 新版早已在等待（例如上次沒按更新就重新整理），這次載入不會再觸發 updatefound
  if (registration.waiting) {
    // 顯示「有新版本可更新」提示
  }

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
- 手動測試時記得：只按重新整理不會讓新版接管，要關掉所有分頁再開

### 情境二：SW 檔案更新後瀏覽器仍抓舊檔

**原因**：`sw.js` 被中間層快取（CDN/代理）。瀏覽器檢查更新時，預設會略過自己的 HTTP 快取（`updateViaCache` 預設為 `"imports"`），所以問題多半出在中間層。  
**解法**：

- 對 `sw.js` 設定 `Cache-Control: no-cache`
- `importScripts` 載入的檔案仍會使用 HTTP 快取，不要給長快取，或讓檔名帶 hash
- 確保每次部署都能拿到最新版 SW 腳本

### 情境三：`fetch` 攔截後頁面偶發空白

**原因**：`event.respondWith` 裡面 promise 拋錯，沒有 fallback。  
**解法**：

- 在 `fetch` 流程加上 `catch`，回傳快取頁或離線頁
- 嚴格區分 HTML 導航與 API 請求的錯誤處理策略

### 情境四：`navigator.serviceWorker.controller` 為 `null`

**原因**：頁面尚未被 SW 控制。通常是首次載入，或用了強制重新整理（Shift + 重新整理、Ctrl/Cmd + Shift + R），這種載入會直接略過 SW。  
**解法**：

- 重新整理頁面一次
- 不要把第一次就有 controller 當成必要條件

### 情境五：開發階段改了 SW 但行為非常混亂

**原因**：舊快取與舊 SW 混在一起。  
**解法**：

- DevTools Application 清除 `Storage`、`Cache Storage`
- 暫時 `Unregister service worker` 再重新測試
- 只想暫時略過 SW，可勾選 `Application -> Service Workers` 的 `Bypass for network`

## 3.5 本章小結

- SW 的 `install -> waiting -> activate` 是更新除錯的核心線索
- 版本管理要同時考慮「SW 腳本」與「快取內容」
- 頁面提示更新，比直接強制刷新更友善且穩定

---

> 上一章：[Web App Manifest 完整設定](./02-web-app-manifest.md) | 下一章：[快取策略設計](./04-caching-strategies.md)
