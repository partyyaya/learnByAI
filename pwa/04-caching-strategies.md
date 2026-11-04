# 第四章：快取策略設計（Cache First / Network First / SWR）

## 4.1 為什麼不能只用一種快取策略？

不同資源類型需要不同策略：

- 打包後檔名帶 hash 的 JS/CSS、字型追求速度 → `Cache First`
- 頁面與 API 資料追求新鮮度 → `Network First`
- 圖片、清單資料想兼顧速度與更新 → `Stale-While-Revalidate`

如果全部都 `Cache First`，你會得到很快但過時的產品。

## 4.2 常見策略對照

| 策略 | 適用場景 | 風險 |
|------|----------|------|
| Cache First | 打包後帶 hash 的 JS/CSS、字型 | 檔名不帶 hash 時會一直拿到舊檔 |
| Network First | 頁面導覽、即時資料（庫存、價格） | 弱網路下慢或失敗 |
| Stale-While-Revalidate | 圖片、文章列表、首頁 feed | 短時間顯示舊資料 |

## 4.3 依資源類型分流（完整版）

**備註（這段代碼要寫在哪裡）**

- 下列程式碼要放在 **Service Worker 檔案**，例如 `public/sw.js`，不是寫在一般頁面腳本中。
- 頁面端要先註冊 SW（第一章 1.4 的寫法，只在 build 版註冊），這段才會生效：

```ts
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register("/sw.js");
}
```

**備註（`self` 是什麼）**

- `self` 是 Service Worker 的全域物件（`ServiceWorkerGlobalScope`），可視為 SW 環境裡對應 `window` 的角色。
- 在 Service Worker 內沒有 `document` 可操作 DOM，所以要用 `self.addEventListener(...)` 監聽 `fetch`、`install`、`activate` 等事件。

```js
const STATIC_CACHE = "static-v1";
const API_CACHE = "api-v1";
const IMAGE_CACHE = "image-v1";
const OFFLINE_HTML = "/offline.html";
const NETWORK_TIMEOUT_MS = 5000;

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // 只攔截 GET；POST/PUT/DELETE 請求通常不走快取策略
  if (request.method !== "GET") return;
  // 避免攔截非 http(s) 請求（如 chrome-extension://）
  if (!url.protocol.startsWith("http")) return;
  // 影音的分段請求（Range）回應是 206，放不進快取，交給瀏覽器直接走網路
  if (request.headers.has("range")) return;

  // 1) 導覽請求（整頁切換）：優先拿最新頁面，失敗才退快取/離線頁
  if (request.mode === "navigate") {
    event.respondWith(
      networkFirst(event, STATIC_CACHE, {
        timeoutMs: NETWORK_TIMEOUT_MS,
        fallbackUrl: OFFLINE_HTML
      })
    );
    return;
  }

  // 2) 自家 API：重視資料新鮮度，採 Network First
  if (sameOrigin && url.pathname.startsWith("/api/")) {
    event.respondWith(networkFirst(event, API_CACHE, { timeoutMs: NETWORK_TIMEOUT_MS }));
    return;
  }

  // 3) 圖片：先回快取提升速度，背景更新
  if (request.destination === "image") {
    event.respondWith(staleWhileRevalidate(event, IMAGE_CACHE));
    return;
  }

  // 4) Vite 打包到 /assets/ 的檔案檔名帶 hash，內容不會變，快取優先
  if (sameOrigin && url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(event, STATIC_CACHE));
  }

  // 其他請求（第三方腳本、跨網域 API 等）不攔截，照常走網路
});

async function cacheFirst(event, cacheName) {
  const { request } = event;
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  // 離線又沒有快取時 fetch 會丟錯，瀏覽器會當成一般的網路錯誤
  const networkResponse = await fetch(request);
  if (isCacheable(networkResponse)) {
    await putSafely(cache, request, networkResponse.clone());
  }
  return networkResponse;
}

async function networkFirst(event, cacheName, options = {}) {
  const { request } = event;
  const { timeoutMs = 5000, fallbackUrl } = options;
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const networkPromise = fetch(request).then(async (networkResponse) => {
    if (isCacheable(networkResponse)) {
      await putSafely(cache, request, networkResponse.clone());
    }
    return networkResponse;
  });
  // 逾時先回快取時，網路請求繼續在背景跑完並更新快取
  event.waitUntil(networkPromise.catch(() => null));

  try {
    // 有快取可退才設逾時；沒有快取就一直等網路，慢網路才不會被當成離線
    return cached ? await withTimeout(networkPromise, timeoutMs) : await networkPromise;
  } catch (error) {
    // 網路失敗或逾時，退回快取
    if (cached) return cached;

    // 導覽請求可再退到離線頁（需先預快取 /offline.html）
    if (fallbackUrl) {
      const fallback = await caches.match(fallbackUrl);
      if (fallback) return fallback;
    }

    return Response.error();
  }
}

async function staleWhileRevalidate(event, cacheName) {
  const { request } = event;
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const networkPromise = fetch(request)
    .then(async (networkResponse) => {
      // 圖片常來自跨網域 CDN，這裡允許存 opaque 回應
      if (isCacheable(networkResponse, { allowOpaque: true })) {
        await putSafely(cache, request, networkResponse.clone());
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

function isCacheable(response, { allowOpaque = false } = {}) {
  // 只存完整的 200 回應
  if (response.status === 200) return true;
  // opaque 是沒有 CORS 的跨網域回應，看不到狀態碼，失敗的回應也可能被存下來
  return allowOpaque && response.type === "opaque";
}

// 寫快取失敗（例如空間不足）只記錄，不影響這次回應
async function putSafely(cache, request, response) {
  try {
    await cache.put(request, response);
  } catch (error) {
    console.warn("cache.put failed:", request.url, error);
  }
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
- `fetch` 分流：先判斷請求類型，再套對應策略，這是實務上最重要的 SW 架構。沒有對應策略的請求不呼叫 `respondWith`，瀏覽器就照常走網路。
- `range` 判斷：`<video>`、`<audio>` 的請求會帶 `Range` header，回應是 206 分段內容，Cache Storage 存不了。
- `networkFirst`：先嘗試網路拿新資料，失敗再退快取；適合頁面導覽與 API。手上有快取時才設逾時，沒有快取就等網路。
- `cacheFirst`：先回快取，沒有才抓網路。只適合檔名帶 hash 的檔案：內容一改檔名就變，不會拿到舊檔。
- `staleWhileRevalidate`：先回舊快取保速度，背景更新快取，下次拿到新內容。
- `withTimeout`：避免弱網路時無限等待，讓 `networkFirst` 能在合理時間內退回快取。
- `isCacheable`：只存完整的 200 回應；`opaque` 只在圖片這類可接受的地方開放。
- `putSafely`：寫快取失敗時照樣回傳網路回應。直接 `await cache.put()` 的話，空間不足這類錯誤會被誤當成網路失敗。

> 這段只有 `fetch`。`install`（記得把 `/offline.html` 加進預快取）和 `activate` 沿用第三章，保留清單改成 `const CURRENT_CACHES = [STATIC_CACHE, API_CACHE, IMAGE_CACHE];`。
>
> SPA 若希望離線時任何網址都能開，可以把導覽的 `fallbackUrl` 換成預快取的 `/index.html`，讓前端路由接手。

### 4.3.2 導覽預載（Navigation Preload）

SW 沒在執行時，瀏覽器要先啟動它，才能在 `fetch` 事件裡發出導覽請求，手機上常見要多花數十到數百毫秒。開啟導覽預載後，瀏覽器會在啟動 SW 的同時先把請求送出去：

```js
self.addEventListener("activate", (event) => {
  // 不支援的瀏覽器沒有 navigationPreload
  if (self.registration.navigationPreload) {
    event.waitUntil(self.registration.navigationPreload.enable());
  }
});
```

再把 `networkFirst` 裡的 `fetch(request)` 改成優先使用預載的回應：

```js
const networkPromise = Promise.resolve(event.preloadResponse)
  .then((preloaded) => preloaded || fetch(request))
  .then(async (networkResponse) => {
    // ...後面同上
  });
```

預載請求會帶 `Service-Worker-Navigation-Preload: true` header，後端可以據此回傳較精簡的內容。

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
- 對 image/API cache 加上最大筆數或 TTL（可用 Workbox expiration，見第十一章）
- 少存 opaque 回應：瀏覽器看不到它的實際大小，Chrome 計算配額時每筆至少以約 7 MB 計
- 用 `navigator.storage.estimate()` 觀察用量（見第五章）

### 情境三：離線時首頁可開，內頁卻白屏

**原因**：只快取了 `index.html`，沒有處理路由導覽。  
**解法**：

- 針對 `request.mode === "navigate"` 統一回傳 app shell 或 offline 頁（4.3 的 `fallbackUrl`）
- SPA 需在 SW 層做「導覽請求」特別處理

### 情境四：跨網域 API 回應無法正常重用

**原因**：CORS 與 opaque response 行為沒處理好。  
**解法**：

- 後端設定正確 CORS header；圖片要在 `<img>` 加上 `crossorigin` 屬性，請求才會以 CORS 模式送出，拿到看得到狀態碼的回應
- 只對可控的 API 域名做快取，第三方請求盡量不快取

### 情境五：發版後快取與新程式碼不相容

**原因**：快取 key 沒有隨版本更新。  
**解法**：

- 用版本化命名，如 `static-v3`
- 不帶 hash 的預快取檔案（例如 `/offline.html`）內容一改就要升版並清舊 cache；帶 hash 的檔案換了檔名，不需要升版

## 4.5 本章小結

- 快取策略要「按資源分類」，而不是「全站套一個策略」
- API 新鮮度與靜態資產速度通常需要不同取捨
- 版本化快取與容量控管是長期穩定運行的必要條件

---

> 上一章：[Service Worker 生命週期與攔截流程](./03-service-worker-basics.md) | 下一章：[離線頁面、資料保存與重送機制](./05-offline-fallback-and-data.md)
