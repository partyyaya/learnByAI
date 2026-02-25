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
- 如果你的 `sw.js` 已有 `fetch` 監聽器，請把這段「navigate fallback」邏輯合併到同一個 `fetch` 流程，避免重複 `respondWith`。

先預快取離線頁：

```js
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open("static-v1").then((cache) => cache.addAll(["/", "/index.html", OFFLINE_URL]))
  );
});
```

導覽請求失敗時回傳離線頁：

```js
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;

  event.respondWith(
    fetch(event.request).catch(async () => {
      const cache = await caches.open("static-v1");
      return cache.match(OFFLINE_URL);
    })
  );
});
```

## 5.3 離線資料保存（IndexedDB）

對於「新增留言、下單草稿、表單」這類操作，建議流程：

1. 使用者送出資料
2. 若網路失敗，先寫入 IndexedDB queue
3. 回復連線後再批次重送

> 可以使用 `idb` 套件簡化 IndexedDB 操作。

## 5.4 Background Sync 重送概念

頁面端（示意）：

```ts
// 1) 先把要送出的資料存到本地 queue（通常是 IndexedDB）
await saveToQueue(payload);
// 2) 等 SW 進入可用狀態（ready）再註冊同步任務
const registration = await navigator.serviceWorker.ready;
// 3) 註冊背景同步 tag；網路恢復後瀏覽器會觸發 sync 事件
await registration.sync.register("retry-pending-requests");
```

SW 端（示意）：

```js
// 在 Service Worker 內監聽背景同步事件
self.addEventListener("sync", (event) => {
  // 只處理指定 tag，避免混到其他 sync 任務
  if (event.tag === "retry-pending-requests") {
    // 把重送流程交給 waitUntil，確保任務完成前不被中止
    event.waitUntil(flushQueueToServer());
  }
});
```

**備註解讀：**

- 這段流程是「先存本地、後補送」，避免離線時使用者操作直接失敗。
- `register("retry-pending-requests")` 不代表立刻執行；它是排隊等瀏覽器在適合時機觸發。
- `flushQueueToServer()` 通常會做三件事：逐筆送出、成功刪除、失敗保留待下次再送。
- 若瀏覽器不支援 Background Sync（常見於部分 iOS 環境），要提供 `online` 事件的手動重送備援流程。

## 5.5 實際運行情境與解決方法

### 情境一：離線提交資料，重開 App 後資料不見

**原因**：只存在記憶體狀態（例如 React state），未持久化。  
**解法**：

- 進入離線流程時立刻寫入 IndexedDB
- UI 顯示「待同步」標記，避免使用者誤判已成功上傳

### 情境二：恢復網路後，資料被重送兩次

**原因**：同步流程沒有去重複（idempotency）。  
**解法**：

- 每筆操作附唯一 request id
- 後端根據 request id 去重，前端同步成功後刪除 queue

### 情境三：離線頁顯示成功，但 API 卡住導致整頁 loading

**原因**：導覽有 fallback，但頁內資料請求沒有 timeout/fallback。  
**解法**：

- API 請求加 timeout，失敗時回傳快取資料或提示區塊
- 區分「頁面可開啟」與「資料可更新」兩層狀態

### 情境四：Background Sync 在部分裝置不觸發

**原因**：瀏覽器對 Sync API 支援不一致。  
**解法**：

- 提供退化方案：`online` 事件觸發時手動重送
- 不把關鍵流程只押在 Background Sync

### 情境五：大量離線圖片導致儲存空間不足

**原因**：未限制 IndexedDB / CacheStorage 成長。  
**解法**：

- 限制資料筆數與保留時間
- 優先保留使用者最重要資料（草稿、待送出任務）

## 5.6 本章小結

- 離線體驗的本質是「可持續完成任務」，不是單純避免錯誤頁
- IndexedDB + 重送機制是離線互動型產品的核心
- 需同時設計「資料一致性」與「重複提交防護」

---

> 上一章：[快取策略設計](./04-caching-strategies.md) | 下一章：[版本更新流程與使用者提示](./06-update-lifecycle.md)
