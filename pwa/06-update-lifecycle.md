# 第六章：版本更新流程與使用者提示

## 6.1 為什麼 PWA 更新特別容易踩雷？

PWA 至少有三層版本：

1. 頁面 JS/CSS bundle
2. Service Worker 腳本
3. CacheStorage 中的舊資源

任一層不同步，都可能出現「部分新、部分舊」的錯誤。

## 6.2 建議的更新策略

- 偵測到新 SW 安裝完成後，顯示「有新版本」提示（頁面載入時新版已在等待也要提示）
- 由使用者主動點擊「立即更新」
- 對 waiting SW 發送 `SKIP_WAITING`
- `controllerchange` 後，只在按下更新的那個分頁執行一次 reload

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
// 頁面載入時是否已被 SW 控制（第一次造訪是 false）
const hadController = Boolean(navigator.serviceWorker.controller);
// 只有在這個分頁按下「立即更新」時才自動重新整理
let reloadOnControllerChange = false;

const updateBar = document.getElementById("update-bar"); // 「有新版本」提示區塊
const updateButton = document.getElementById("update-btn"); // 「立即更新」按鈕

function showUpdatePrompt(worker: ServiceWorker) {
  if (!updateBar || !updateButton) return;
  updateBar.hidden = false;
  updateButton.onclick = () => {
    reloadOnControllerChange = true;
    worker.postMessage({ type: "SKIP_WAITING" });
  };
}

navigator.serviceWorker.register("/sw.js").then((registration) => {
  // 新版早已在等待（例如上次按了「稍後」），這次載入不會再觸發 updatefound
  if (registration.waiting) {
    showUpdatePrompt(registration.waiting);
  }

  registration.addEventListener("updatefound", () => {
    const installing = registration.installing;
    if (!installing) return;

    installing.addEventListener("statechange", () => {
      if (installing.state === "installed" && navigator.serviceWorker.controller) {
        showUpdatePrompt(installing);
      }
    });
  });

  // 長時間不重新整理的頁面，每小時主動檢查一次 sw.js
  setInterval(() => {
    registration.update().catch(() => {});
  }, 60 * 60 * 1000);
});

navigator.serviceWorker.addEventListener("controllerchange", () => {
  if (reloadOnControllerChange) {
    reloadOnControllerChange = false;
    window.location.reload();
    return;
  }
  // 第一次造訪時 clients.claim() 也會觸發 controllerchange，這時什麼都不用做
  if (hadController) {
    // 其他分頁按了更新：顯示「新版已啟用，請重新整理」，不要直接刷新
  }
});
```

**備註解讀：**

- `registration.waiting`：使用者按了「稍後」再重新整理時，新版仍在等待，`updatefound` 不會再觸發，要在註冊後主動檢查。
- `hadController`：第一、三章的 SW 會呼叫 `clients.claim()`，第一次造訪時 SW 接管頁面也會觸發 `controllerchange`，不加判斷的話新使用者一進站就會被重新整理一次。
- `reloadOnControllerChange`：`skipWaiting()` 會讓所有分頁同時換成新 SW，每個分頁都會收到 `controllerchange`。只讓按下更新的分頁重新整理，其他分頁改顯示提示，避免未送出的表單被清掉。
- `registration.update()`：瀏覽器主要在導覽時檢查新版（第三章 3.1），像掃碼、儀表板這種一直開著的頁面要自己定期檢查。

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

**原因**：快取裡的舊 `index.html` 指向舊版的 hash 檔，但部署時舊檔已從伺服器刪掉；或舊頁面按需載入（lazy route）的 chunk 在新版已不存在。  
**解法**：

- 導覽請求用 Network First（第四章），不要讓 HTML 永遠從快取拿
- 部署時保留上一版的 `/assets/` 檔案一段時間（第十章）
- 發版時同步更新 cache key，確保舊快取在 activate 階段清理乾淨
- Vite 在動態 `import()` 失敗時會發出 `vite:preloadError` 事件，可以在這時重新整理拿新版：

```ts
window.addEventListener("vite:preloadError", () => {
  window.location.reload();
});
```

### 情境二：每次開啟都一直跳「有新版本」

**原因**：SW 檔案每次都變動（包含動態時間戳）導致持續判定更新。  
**解法**：

- 避免在 SW 打包內容中注入每次都不同的值
- 僅在真正發版時變更 SW 內容

### 情境三：按下「更新」後頁面無限 reload

**原因**：`controllerchange` 與頁面重整邏輯重複觸發。另一個常見原因是 DevTools 勾了 `Update on reload`：每次重新整理都會裝新 SW 並立刻接管，觸發 `controllerchange` 又重新整理。  
**解法**：

- 用旗標（如 6.2 的 `reloadOnControllerChange`）確保只 reload 一次
- 不要在多個事件同時呼叫 `location.reload`
- 測試更新提示時取消勾選 `Update on reload`

### 情境四：多分頁同時開啟，更新狀態混亂

**原因**：所有分頁共用同一個 SW。新版在等待時每個分頁都會跳提示；其中一個分頁按下更新，其他分頁也會同時換成新 SW，畫面上卻還是舊版程式。  
**解法**：

- 由其中一個分頁執行更新，其餘分頁收到 `controllerchange` 時顯示「請重新整理」（6.2 的寫法）
- 使用 `BroadcastChannel` 同步分頁間更新通知，例如一個分頁按了「稍後」，其他分頁也一起收起提示

### 情境五：前端升版後 API schema 不相容

**原因**：前端與後端版本切換不一致。  
**解法**：

- API 增量發布，維持一段時間向下相容
- 更新提示文案可引導使用者關閉舊分頁再重開

## 6.5 本章小結

- PWA 更新要處理「等待接管」與「快取版本」兩件事
- 使用者可感知的更新提示，比靜默強刷更安全
- 記得處理「載入時新版已在等待」與「首次接管」兩種情況
- 多分頁、前後端版本不一致是上線後常見問題

---

> 上一章：[離線頁面、資料保存與重送機制](./05-offline-fallback-and-data.md) | 下一章：[可安裝性與安裝引導 UX](./07-installability-and-ux.md)
