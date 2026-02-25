# 第一章：PWA 基礎觀念與開發環境

## 1.1 什麼是 PWA？

PWA（Progressive Web App）是一種用 Web 技術打造、但體驗接近原生 App 的應用型態。  
重點不是「做一個網站」，而是讓網站具備：

- 可安裝（Installable）
- 可離線或弱網路可用（Offline-capable）
- 可背景更新與推播（Updatable + Push）

## 1.2 PWA 的三個核心組件

1. **HTTPS**：提供安全上下文，Service Worker 與 Push 需要它。  
2. **Web App Manifest**：定義名稱、圖示、啟動畫面、顯示模式。  
3. **Service Worker**：攔截網路請求，實作快取與離線策略。

## 1.3 建立練習專案（Vite）

```bash
# 建立專案
npm create vite@latest pwa-lab -- --template vanilla-ts
cd pwa-lab
npm install

# 啟動開發伺服器
npm run dev
```

## 1.4 註冊第一個 Service Worker

建立 `public/sw.js`：

```js
// 快取名稱（之後升版時可改成 app-shell-v2、v3...）
const CACHE_NAME = "app-shell-v1";
// 預快取的核心資源（最小可用的 App Shell）
const APP_SHELL = ["/", "/index.html"];

// install：安裝 SW 時先把核心資源放進快取
self.addEventListener("install", (event) => {
  // 等快取完成才算安裝成功
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
});

// activate：SW 啟用後立刻嘗試接管目前頁面
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// fetch：攔截請求，採用 Cache First 策略
self.addEventListener("fetch", (event) => {
  event.respondWith(
    // 先讀快取，沒有才走網路
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
```

在 `src/main.ts` 註冊：

```ts
if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    await navigator.serviceWorker.register("/sw.js");
  });
}
```

## 1.5 驗證是否成功

- Chrome DevTools → `Application` → `Service Workers`
- 確認狀態為 `activated and is running`
- `Network` 面板切成 `Offline`，重新整理測試是否可載入快取內容

## 1.6 實際運行情境與解決方法

### 情境一：`ServiceWorker registration failed: 404`

**原因**：`/sw.js` 路徑錯誤，或檔案不在可被公開存取的目錄。  
**解法**：

- 將 `sw.js` 放在 `public/`（Vite 會映射到站點根目錄）
- 註冊路徑使用 `"/sw.js"`，不要寫相對路徑 `./sw.js`

### 情境二：第一次載入沒有被 SW 控制

**原因**：Service Worker 在第一次載入後才安裝完成。  
**解法**：

- 重新整理一次頁面
- 或在 SW 的 `activate` 事件中使用 `clients.claim()` 縮短等待期

### 情境三：本機測試正常，上線後完全失效

**原因**：正式環境不是 HTTPS。  
**解法**：

- 生產環境必須啟用 HTTPS
- 若經過 CDN 或反向代理，確認沒有把 HTTPS 降級為 HTTP

### 情境四：iOS 看不到「安裝 App」提示

**原因**：iOS Safari 沒有 `beforeinstallprompt` 事件。  
**解法**：

- 顯示引導文案：「分享 → 加入主畫面」
- 在 UX 上提供平台差異提示，不要只依賴系統彈窗

## 1.7 本章小結

- PWA 的核心是 HTTPS + Manifest + Service Worker
- 先完成可註冊、可快取、可離線的最小可行版本（MVP）
- 前期先確保流程可跑通，再逐步優化快取策略與更新機制

---

> 下一章：[Web App Manifest 完整設定](./02-web-app-manifest.md)
