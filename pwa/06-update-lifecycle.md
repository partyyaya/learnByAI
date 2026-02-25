# 第六章：版本更新流程與使用者提示

## 6.1 為什麼 PWA 更新特別容易踩雷？

PWA 至少有三層版本：

1. 頁面 JS/CSS bundle
2. Service Worker 腳本
3. CacheStorage 中的舊資源

任一層不同步，都可能出現「部分新、部分舊」的錯誤。

## 6.2 建議的更新策略

- 偵測到新 SW 安裝完成後，顯示「有新版本」提示
- 由使用者主動點擊「立即更新」
- 對 waiting SW 發送 `SKIP_WAITING`
- `controllerchange` 後執行一次 reload

頁面端示意：

**備註（這段通常加在哪個檔案）**

- 這段是「頁面端」程式碼，通常放在應用啟動入口，不是放在 `sw.js`。
- 常見位置：
  - Vanilla/Vite：`src/main.ts`
  - React：`src/main.tsx`（或根元件初始化處）
  - Vue：`src/main.ts`
- 建議只在 App 初始化時註冊一次，避免重複綁定 `updatefound` / `controllerchange` 監聽器。
- `SW 端接收訊號` 那段才是放在 Service Worker 檔案（例如 `public/sw.js`）。

```ts
let refreshing = false;

navigator.serviceWorker.register("/sw.js").then((registration) => {
  registration.addEventListener("updatefound", () => {
    const installing = registration.installing;
    if (!installing) return;

    installing.addEventListener("statechange", () => {
      if (installing.state === "installed" && navigator.serviceWorker.controller) {
        // 顯示更新通知 UI
      }
    });
  });
});

navigator.serviceWorker.addEventListener("controllerchange", () => {
  if (refreshing) return;
  refreshing = true;
  window.location.reload();
});
```

SW 端接收訊號：

```js
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
```

## 6.3 版本管理建議

- cache key 版本化：`static-v4`、`api-v4`
- 發版清單寫入 `release notes`，對應快取升版
- 若改動資料結構，先做向下相容再放更新

## 6.4 實際運行情境與解決方法

### 情境一：更新後使用者白屏，重整才好

**原因**：HTML 指向新 bundle，但舊 SW 仍提供舊檔。  
**解法**：

- 發版時同步更新 cache key
- 確保舊快取在 activate 階段清理乾淨

### 情境二：每次開啟都一直跳「有新版本」

**原因**：SW 檔案每次都變動（包含動態時間戳）導致持續判定更新。  
**解法**：

- 避免在 SW 打包內容中注入每次都不同的值
- 僅在真正發版時變更 SW 內容

### 情境三：按下「更新」後頁面無限 reload

**原因**：`controllerchange` 與頁面重整邏輯重複觸發。  
**解法**：

- 用旗標（如 `refreshing`）確保只 reload 一次
- 不要在多個事件同時呼叫 `location.reload`

### 情境四：多分頁同時開啟，更新狀態混亂

**原因**：不同分頁收到不同生命周期狀態。  
**解法**：

- 使用 `BroadcastChannel` 同步分頁間更新通知
- 由其中一個分頁執行更新，其餘分頁顯示提示

### 情境五：前端升版後 API schema 不相容

**原因**：前端與後端版本切換不一致。  
**解法**：

- API 增量發布，維持一段時間向下相容
- 更新提示文案可引導使用者關閉舊分頁再重開

## 6.5 本章小結

- PWA 更新要處理「等待接管」與「快取版本」兩件事
- 使用者可感知的更新提示，比靜默強刷更安全
- 多分頁、前後端版本不一致是上線後常見問題

---

> 上一章：[離線頁面、資料保存與重送機制](./05-offline-fallback-and-data.md) | 下一章：[可安裝性與安裝引導 UX](./07-installability-and-ux.md)
