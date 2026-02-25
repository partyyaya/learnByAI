# 第四章：快取策略設計（Cache First / Network First / SWR）

## 4.1 為什麼不能只用一種快取策略？

不同資源類型需要不同策略：

- 靜態資源（JS/CSS/Logo）追求速度 → `Cache First`
- API 資料追求新鮮度 → `Network First`
- 清單資料想兼顧速度與更新 → `Stale-While-Revalidate`

如果全部都 `Cache First`，你會得到很快但過時的產品。

## 4.2 常見策略對照

| 策略 | 適用場景 | 風險 |
|------|----------|------|
| Cache First | 圖片、字型、打包後靜態檔 | 更新延遲 |
| Network First | 即時資料（庫存、價格） | 弱網路下慢或失敗 |
| Stale-While-Revalidate | 文章列表、首頁 feed | 短時間顯示舊資料 |

## 4.3 依資源類型分流（完整版）

**備註（這段代碼要寫在哪裡）**

- 下列程式碼要放在 **Service Worker 檔案**，例如 `public/sw.js`，不是寫在一般頁面腳本中。
- 頁面端要先註冊 SW，這段才會生效：

```ts
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js");
}
```

**備註（`self` 是什麼）**

- `self` 是 Service Worker 的全域物件（`ServiceWorkerGlobalScope`），可視為 SW 環境裡對應 `window` 的角色。
- 在 Service Worker 內沒有 `document` 可操作 DOM，所以要用 `self.addEventListener(...)` 監聽 `fetch`、`install`、`activate` 等事件。

```js
const STATIC_CACHE = "static-v3";
const API_CACHE = "api-v3";
const IMAGE_CACHE = "image-v3";
const OFFLINE_HTML = "/offline.html";
const NETWORK_TIMEOUT_MS = 5000;

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 只攔截 GET；POST/PUT/DELETE 請求通常不走快取策略
  if (request.method !== "GET") return;
  // 避免攔截非 http(s) 請求（如 chrome-extension://）
  if (!url.protocol.startsWith("http")) return;

  // 1) 導覽請求（整頁切換）：優先拿最新頁面，失敗才退快取/離線頁
  if (request.mode === "navigate") {
    event.respondWith(
      networkFirst(request, STATIC_CACHE, {
        timeoutMs: NETWORK_TIMEOUT_MS,
        fallbackUrl: OFFLINE_HTML
      })
    );
    return;
  }

  // 2) API：重視資料新鮮度，採 Network First
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      networkFirst(request, API_CACHE, {
        timeoutMs: NETWORK_TIMEOUT_MS
      })
    );
    return;
  }

  // 3) 圖片：先回快取提升速度，背景更新
  if (request.destination === "image") {
    event.respondWith(staleWhileRevalidate(request, IMAGE_CACHE, event));
    return;
  }

  // 4) 其他靜態資源：快取優先
  event.respondWith(cacheFirst(request, STATIC_CACHE));
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const networkResponse = await fetch(request);
    if (isCacheable(networkResponse)) {
      await cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (error) {
    return Response.error();
  }
}

async function networkFirst(request, cacheName, options = {}) {
  const { timeoutMs = 5000, fallbackUrl } = options;
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  try {
    const networkResponse = await withTimeout(fetch(request), timeoutMs);
    if (isCacheable(networkResponse)) {
      await cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (error) {
    // 網路失敗時退回快取
    if (cached) return cached;

    // 導覽請求可再退到離線頁（需先預快取 /offline.html）
    if (fallbackUrl) {
      const fallback = await caches.match(fallbackUrl);
      if (fallback) return fallback;
    }

    return Response.error();
  }
}

async function staleWhileRevalidate(request, cacheName, event) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const networkPromise = fetch(request)
    .then(async (networkResponse) => {
      if (isCacheable(networkResponse)) {
        await cache.put(request, networkResponse.clone());
      }
      return networkResponse;
    })
    .catch(() => null);

  // 有快取先回，並在背景更新快取
  if (cached) {
    event.waitUntil(networkPromise);
    return cached;
  }

  // 沒快取就等網路
  const networkResponse = await networkPromise;
  return networkResponse || Response.error();
}

function isCacheable(response) {
  // opaque 常見於跨網域資源（例如 CDN 圖片）
  return !!response && (response.ok || response.type === "opaque");
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("network timeout")), ms);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}
```

### 4.3.1 代碼用途逐段說明

- `STATIC_CACHE` / `API_CACHE` / `IMAGE_CACHE`：按資源類型拆分快取，避免互相污染，升版也能分開控管。
- `fetch` 分流：先判斷請求類型，再套對應策略，這是實務上最重要的 SW 架構。
- `networkFirst`：先嘗試網路拿新資料，失敗再退快取；適合頁面導覽與 API。
- `cacheFirst`：先回快取，沒有才抓網路；適合版本化靜態檔（JS/CSS/font）。
- `staleWhileRevalidate`：先回舊快取保速度，背景更新快取，下次進站拿新內容。
- `withTimeout`：避免弱網路時無限等待，讓 `networkFirst` 能在合理時間內 fallback。
- `isCacheable`：避免把不適合的 response 寫入快取（但允許 `opaque` 供 CDN 圖片場景）。

> 補充：若要讓 `fallbackUrl: "/offline.html"` 生效，請在 `install` 事件先把 `/offline.html` 預快取。

## 4.4 實際運行情境與解決方法

### 情境一：商品價格更新了，使用者看到舊價格

**原因**：API 被 `Cache First` 快取。  
**解法**：

- API 改用 `Network First`
- 為關鍵資料加上快取期限（例如 30 秒）

### 情境二：快取越來越大，手機空間吃滿

**原因**：沒有做快取清理與上限控制。  
**解法**：

- 版本升級時刪除舊 cache key
- 對 image/API cache 加上最大筆數或 TTL（可用 Workbox expiration）

### 情境三：離線時首頁可開，內頁卻白屏

**原因**：只快取了 `index.html`，沒有處理路由導覽。  
**解法**：

- 針對 `request.mode === "navigate"` 統一回傳 app shell 或 offline 頁
- SPA 需在 SW 層做「導覽請求」特別處理

### 情境四：跨網域 API 回應無法正常重用

**原因**：CORS 與 opaque response 行為沒處理好。  
**解法**：

- 後端設定正確 CORS header
- 只對可控的 API 域名做快取，第三方請求盡量不快取

### 情境五：發版後快取與新程式碼不相容

**原因**：快取 key 沒有隨版本更新。  
**解法**：

- 用版本化命名，如 `static-v3`
- 每次 major 變更時同步升版並清舊 cache

## 4.5 本章小結

- 快取策略要「按資源分類」，而不是「全站套一個策略」
- API 新鮮度與靜態資產速度通常需要不同取捨
- 版本化快取與容量控管是長期穩定運行的必要條件

---

> 上一章：[Service Worker 生命週期與攔截流程](./03-service-worker-basics.md) | 下一章：[離線頁面、資料保存與重送機制](./05-offline-fallback-and-data.md)
