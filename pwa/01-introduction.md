# 第一章：PWA 基礎觀念與開發環境

## 1.1 什麼是 PWA？

PWA（Progressive Web App）是一種用 Web 技術打造、但體驗接近原生 App 的應用型態。  
重點不是「做一個網站」，而是讓網站具備：

- 可安裝（Installable）
- 可離線或弱網路可用（Offline-capable）
- 可背景更新與推播（Updatable + Push）

## 1.2 PWA 的三個核心組件

1. **HTTPS**：提供安全上下文，Service Worker 與 Push 需要它（`localhost` 例外，開發時可直接用）。  
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

// fetch：攔截同源的 GET 請求，採用 Cache First 策略
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    // 先讀快取，沒有才走網路
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        // 打包後的 JS/CSS 檔名事先不知道，第一次從網路拿到時順手存起來
        if (response.status === 200) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)));
        }
        return response;
      });
    })
  );
});
```

> 這個版本連 HTML 都一直從快取拿，發版後使用者看不到新內容；第三、四章會改成依資源類型分流。

在 `src/main.ts` 註冊：

```ts
// 只在 build 版註冊：開發伺服器的檔案一旦被快取，改了程式也看不到效果
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js");
  });
}
```

## 1.5 驗證是否成功

SW 只在 build 版註冊，所以用預覽伺服器驗證：

```bash
npm run build
npm run preview   # 預設開在 http://localhost:4173
```

1. Chrome DevTools → `Application` → `Service Workers`，確認狀態為 `activated and is running`
2. 重新整理一次：第一次載入時 SW 還沒裝好，JS/CSS 沒有經過 SW，要再載入一次才會存進快取
3. `Application` → `Cache Storage` → `app-shell-v1`，應該看得到 `/`、`/index.html` 與 `/assets/` 底下的檔案
4. `Network` 面板切成 `Offline` 再重新整理，畫面要正常顯示，`Size` 欄位會標示 `(ServiceWorker)`

> vanilla-ts 範本的畫面是由 `src/main.ts`（build 後是 `/assets/index-xxxx.js`）畫出來的。只快取 HTML 的話，離線時會是一片空白。

## 1.6 實際運行情境與解決方法

### 情境一：`ServiceWorker registration failed: 404`

**原因**：`/sw.js` 路徑錯誤，或檔案不在可被公開存取的目錄。  
**解法**：

- 將 `sw.js` 放在 `public/`（Vite 會原樣複製到站點根目錄）
- 註冊路徑寫從根目錄起算的 `"/sw.js"`。寫成 `"./sw.js"` 會相對於目前網址解析，在 `/products/1` 這類頁面註冊時會變成 `/products/sw.js`
- 網站部署在子路徑時，改用 `` `${import.meta.env.BASE_URL}sw.js` ``（見第十章）

### 情境二：第一次載入沒有被 SW 控制

**原因**：頁面只會被「載入當下已經啟用」的 SW 控制，第一次載入時 SW 才剛開始安裝。  
**解法**：

- 重新整理一次頁面
- 或在 SW 的 `activate` 事件中使用 `clients.claim()`，讓已開啟的頁面立刻被接管

### 情境三：本機測試正常，上線後完全失效

**原因**：正式環境不是 HTTPS。用手機連電腦的區網 IP（`http://192.168.x.x`）測試也一樣：它不算安全環境，`navigator.serviceWorker` 會是 `undefined`。  
**解法**：

- 生產環境必須啟用 HTTPS
- 若經過 CDN 或反向代理，確認沒有把 HTTPS 降級為 HTTP
- 手機測試可用 Android 的 `chrome://inspect` → Port forwarding，讓手機以 `localhost` 連到電腦；或用 ngrok 之類的 HTTPS 通道

### 情境四：iOS 看不到「安裝 App」提示

**原因**：iOS 沒有 `beforeinstallprompt` 事件，安裝只能由使用者從分享選單操作。  
**解法**：

- 顯示引導文案：「分享 → 加入主畫面」（iOS 16.4 起，Chrome、Edge 等瀏覽器的分享選單也有這個選項）
- 在 UX 上提供平台差異提示，不要只依賴系統彈窗（見第七章）

### 情境五：`The script has an unsupported MIME type ('text/html')`

**原因**：伺服器設了 SPA fallback（找不到檔案就回 `index.html`），`sw.js` 不存在或路徑寫錯時，瀏覽器拿到的是 HTML 而不是 JS。  
**解法**：

- 直接在瀏覽器開 `https://你的網域/sw.js`，確認回應是 JS 程式碼
- 讓 `sw.js` 這類固定檔案不走 fallback，找不到就回 404（見第十章的 Nginx 設定）

## 1.7 本章小結

- PWA 的核心是 HTTPS + Manifest + Service Worker
- 先完成可註冊、可快取、可離線的最小可行版本（MVP）
- SW 的效果要在 build 版（`npm run preview`）驗證，開發伺服器不適合測快取
- 前期先確保流程可跑通，再逐步優化快取策略與更新機制

---

> 下一章：[Web App Manifest 完整設定](./02-web-app-manifest.md)
