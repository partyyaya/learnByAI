# 第五章：離線頁面、資料保存與重送機制

## 5.1 離線不只是「顯示錯誤」

成熟的 PWA 需要在離線時提供：

- 可理解的離線回應（offline fallback）
- 已有資料的可讀體驗（cache / IndexedDB）
- 使用者操作不中斷（排隊重送）

## 5.2 離線頁面 fallback

**備註（這兩段代碼要寫在哪裡）**

- 兩段都寫在 **Service Worker 檔案**，例如 `public/sw.js`。
- `offline.html` 本體要放在 `public/offline.html`，讓 SW 可以從站點根路徑讀到。
- 頁面端要先註冊 SW（例如 `src/main.ts` 的 `navigator.serviceWorker.register("/sw.js")`），這段邏輯才會生效。
- 如果你的 `sw.js` 已有第三章的 `install`，直接把 `OFFLINE_URL` 加進 `STATIC_ASSETS` 即可。
- 如果你的 `sw.js` 已有 `fetch` 監聽器，請把這段「navigate fallback」邏輯合併到同一個 `fetch` 流程，避免重複 `respondWith`。

先預快取離線頁：

```js
const STATIC_CACHE = "static-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(["/", "/index.html", OFFLINE_URL]))
  );
});
```

導覽請求失敗時回傳離線頁：

```js
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;

  event.respondWith(
    fetch(event.request).catch(async () => {
      const offlinePage = await caches.match(OFFLINE_URL);
      return offlinePage || Response.error();
    })
  );
});
```

## 5.3 離線資料保存（IndexedDB）

對於「新增留言、下單草稿、表單」這類操作，建議流程：

1. 使用者送出資料時，先寫進 IndexedDB 的待送佇列（outbox）
2. 嘗試送出：成功就從佇列刪除
3. 失敗就留在佇列，等連線恢復再送

用 IndexedDB 而不是 localStorage，是因為 Service Worker 裡不能用 localStorage，IndexedDB 則頁面和 SW 都能存取。

頁面端用 `idb` 套件（`npm install idb`）簡化操作：

```ts
// src/outbox.ts
import { openDB } from "idb";

export type OutboxEntry = {
  id: string; // 每筆唯一，後端用它判斷是不是重複送出
  url: string;
  body: unknown;
  createdAt: number;
};

const dbPromise = openDB("shop-outbox", 1, {
  upgrade(db) {
    db.createObjectStore("requests", { keyPath: "id" });
  },
});

export async function saveToQueue(url: string, body: unknown) {
  const entry: OutboxEntry = { id: crypto.randomUUID(), url, body, createdAt: Date.now() };
  await (await dbPromise).put("requests", entry);
}

// 給 UI 顯示「N 筆待同步」
export async function countPending() {
  return (await dbPromise).count("requests");
}
```

SW 端：`public/sw.js` 不經過 Vite 打包，不能 `import` npm 套件，所以直接用原生 IndexedDB API（第十一章改用 `injectManifest` 打包後，就能和頁面共用 `idb`）：

```js
const OUTBOX_DB = "shop-outbox";
const OUTBOX_STORE = "requests";

function openOutbox() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OUTBOX_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(OUTBOX_STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// 把 IndexedDB 的 request 包成 Promise
function idbResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function flushQueueToServer() {
  const db = await openOutbox();
  const entries = await idbResult(db.transaction(OUTBOX_STORE).objectStore(OUTBOX_STORE).getAll());

  for (const entry of entries) {
    // 網路錯誤時 fetch 會丟錯，這筆和後面的都留在佇列
    const response = await fetch(entry.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": entry.id },
      body: JSON.stringify(entry.body)
    });
    // 5xx 留在佇列等下次；丟錯讓 Background Sync 稍後重試
    if (response.status >= 500) throw new Error(`server error ${response.status}`);
    // 成功或 4xx（重送也不會成功）都移出佇列；4xx 要另外通知使用者（這裡省略）
    await idbResult(db.transaction(OUTBOX_STORE, "readwrite").objectStore(OUTBOX_STORE).delete(entry.id));
  }
}
```

**備註解讀：**

- 每次讀寫都開新的 transaction：IndexedDB 的 transaction 在沒有待處理的請求時會自動結束，不能跨過 `await fetch()` 繼續使用。
- `Idempotency-Key` 讓後端認出「這是同一筆資料又送了一次」（見情境二）。

## 5.4 Background Sync 重送概念

頁面端：

```ts
import { saveToQueue } from "./outbox";

const supportsBackgroundSync = "SyncManager" in window;

export async function submitOrder(payload: unknown) {
  // 1) 先把要送出的資料存到本地佇列
  await saveToQueue("/api/orders", payload);

  if (!supportsBackgroundSync) {
    requestFlush();
    return;
  }

  // 2) 等 SW 進入可用狀態（ready）再註冊同步任務
  const registration = await navigator.serviceWorker.ready;
  // 3) 註冊背景同步 tag；網路恢復後瀏覽器會觸發 sync 事件
  //    TypeScript 的 DOM 型別沒有 Background Sync，要自己補型別
  const { sync } = registration as ServiceWorkerRegistration & {
    sync: { register(tag: string): Promise<void> };
  };
  await sync.register("retry-pending-requests");
}

// 請 SW 送出佇列：不支援 Background Sync 時的備援
function requestFlush() {
  navigator.serviceWorker.controller?.postMessage({ type: "FLUSH_QUEUE" });
}

if (!supportsBackgroundSync) {
  window.addEventListener("online", requestFlush);
}
// 開啟 App 時，把上次沒送完的送出去
requestFlush();
```

SW 端：

```js
// 在 Service Worker 內監聽背景同步事件
self.addEventListener("sync", (event) => {
  // 只處理指定 tag，避免混到其他 sync 任務
  if (event.tag === "retry-pending-requests") {
    // reject 時瀏覽器會稍後重試（次數有限，event.lastChance 為 true 代表最後一次）
    event.waitUntil(flushQueueToServer());
  }
});

// 頁面要求送出佇列
self.addEventListener("message", (event) => {
  if (event.data?.type === "FLUSH_QUEUE") {
    event.waitUntil(flushQueueToServer().catch(() => null));
  }
});
```

**備註解讀：**

- 這段流程是「先存本地、後補送」，避免離線時使用者操作直接失敗。
- `register("retry-pending-requests")` 不代表立刻執行；它是排隊等瀏覽器在適合時機觸發（有網路時通常很快就會觸發）。
- Background Sync 目前只有 Chromium 系瀏覽器（Chrome、Edge、Samsung Internet 等）支援，Safari 與 Firefox 都沒有，所以一定要有 `online` 事件的備援流程。
- `online` 事件只代表裝置連上了網路，不保證連得到伺服器，送失敗的資料要留在佇列。

## 5.5 儲存空間會被清掉嗎？

Cache Storage 與 IndexedDB 共用同一個網域的配額，而且預設是「盡力保存」：裝置空間不足時，瀏覽器可以把整個網域的資料一起清掉。

```ts
// 目前用量與上限（單位 byte，都是估計值）
const { usage = 0, quota = 0 } = await navigator.storage.estimate();
console.log(`已用 ${(usage / 1024 / 1024).toFixed(1)} MB / 上限 ${(quota / 1024 / 1024).toFixed(0)} MB`);

// 申請持久保存：同意後，空間不足時不會被自動清除
const persisted = await navigator.storage.persist();
```

- `persist()` 是否同意由瀏覽器決定，通常會參考網站是否已安裝、使用者互動程度
- Safari 對沒有加入主畫面的網站：使用者在 Safari 累計使用 7 天都沒有和這個網站互動，就會清掉所有由腳本寫入的資料（IndexedDB、Cache Storage、Service Worker 註冊、localStorage）；加入主畫面的 Web App 不受這條規則限制
- iOS 主畫面 Web App 與 Safari 的儲存是分開的：在 Safari 裡存的資料，從主畫面打開 App 後看不到

## 5.6 實際運行情境與解決方法

### 情境一：離線提交資料，重開 App 後資料不見

**原因**：只存在記憶體狀態（例如 React state），未持久化。  
**解法**：

- 進入離線流程時立刻寫入 IndexedDB
- UI 顯示「待同步」標記（例如 5.3 的 `countPending()`），避免使用者誤判已成功上傳

### 情境二：恢復網路後，資料被重送兩次

**原因**：同步流程沒有去重複（idempotency）。sync 事件和手動重送同時觸發，或伺服器其實處理成功、只是回應在路上斷掉，前端都會以為沒送成功。  
**解法**：

- 每筆操作附唯一 request id（5.3 的 `id`，以 `Idempotency-Key` header 送出）
- 後端根據 request id 去重，前端同步成功後刪除 queue

### 情境三：離線頁顯示成功，但 API 卡住導致整頁 loading

**原因**：導覽有 fallback，但頁內資料請求沒有 timeout/fallback。  
**解法**：

- API 請求加 timeout，失敗時回傳快取資料或提示區塊
- 區分「頁面可開啟」與「資料可更新」兩層狀態

### 情境四：Background Sync 在部分裝置不觸發

**原因**：Background Sync 只有 Chromium 系瀏覽器支援，Safari 與 Firefox 都不會觸發 `sync` 事件。  
**解法**：

- 提供退化方案：`online` 事件與開啟 App 時手動重送（5.4 的 `requestFlush()`）
- 不把關鍵流程只押在 Background Sync

### 情境五：大量離線圖片導致儲存空間不足

**原因**：未限制 IndexedDB / CacheStorage 成長。  
**解法**：

- 限制資料筆數與保留時間
- 優先保留使用者最重要資料（草稿、待送出任務）
- 用 `navigator.storage.estimate()` 監控用量，重要資料用 `navigator.storage.persist()` 申請持久保存

## 5.7 本章小結

- 離線體驗的本質是「可持續完成任務」，不是單純避免錯誤頁
- IndexedDB + 重送機制是離線互動型產品的核心
- 需同時設計「資料一致性」與「重複提交防護」

---

> 上一章：[快取策略設計](./04-caching-strategies.md) | 下一章：[版本更新流程與使用者提示](./06-update-lifecycle.md)
