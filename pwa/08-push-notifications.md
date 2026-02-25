# 第八章：Web Push 推播通知實作

## 8.1 推播架構總覽

Web Push 的基本流程：

1. 前端向使用者請求通知權限
2. 前端透過 Service Worker 訂閱 Push Service，拿到 subscription
3. 將 subscription 傳給後端保存
4. 後端以 VAPID 金鑰發送推播
5. Service Worker 收到 `push` 事件並顯示通知

**備註（這段通常寫在哪個檔案）**

- `8.2 前端訂閱流程` 是頁面端邏輯，通常放在 `src/main.ts`、`src/main.js` 或 `src/services/push.js`。
- 建議由「使用者點擊啟用通知按鈕」時才呼叫，避免一進站就請求權限。
- `8.3 SW 顯示通知` 則是放在 Service Worker 檔案（例如 `public/sw.js`）。

**備註（Push Service 可以使用哪個平台）**

- 若採標準 Web Push，實際 Push Service 由瀏覽器決定：
  - Chrome / Edge：通常走 Google FCM 端點
  - Firefox：通常走 Mozilla Push Service
  - Safari（macOS / iOS 16.4+）：走 Apple Push 端點
- 實務上你不需要手動挑瀏覽器推播端點；後端只要把訊息送到 `subscription.endpoint` 即可。
- 你可以選擇的「發送平台」通常是：
  - 自建後端（常見 Node `web-push` 套件，搭配 VAPID）
  - 第三方平台（如 OneSignal、Firebase Cloud Messaging）協助管理訂閱與發送

## 8.2 前端訂閱流程（示意）

```ts
const registration = await navigator.serviceWorker.ready;
const permission = await Notification.requestPermission();
if (permission !== "granted") throw new Error("Notification permission denied");

const subscription = await registration.pushManager.subscribe({
  userVisibleOnly: true,
  applicationServerKey: urlBase64ToUint8Array(import.meta.env.VITE_VAPID_PUBLIC_KEY)
});

await fetch("/api/push/subscribe", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(subscription)
});
```

## 8.3 SW 顯示通知（示意）

```js
self.addEventListener("push", (event) => {
  const payload = event.data ? event.data.json() : { title: "新通知", body: "你有一則新訊息" };
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-72.png",
      data: { url: payload.url || "/" }
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/";
  event.waitUntil(clients.openWindow(targetUrl));
});
```

## 8.4 後端發送重點

- 訂閱資料需與使用者帳號綁定
- 推播失敗（410/404）要清理失效訂閱
- 請限制發送頻率，避免被判定濫用

## 8.5 實際運行情境與解決方法

### 情境一：`Notification.permission` 一直是 `denied`

**原因**：使用者曾拒絕權限。  
**解法**：

- 不要重複彈窗，改引導使用者到瀏覽器設定手動開啟
- 調整請求時機，在使用者理解價值後再請求

### 情境二：本機測得到，正式環境推播完全收不到

**原因**：VAPID 金鑰或 endpoint 環境不一致。  
**解法**：

- 確認前端 public key 與後端 private key 成對
- 驗證正式環境使用的 subscription 不是測試資料

### 情境三：使用者換裝置或清除資料後，推播大量失敗

**原因**：後端還保留舊 subscription。  
**解法**：

- 發送回應若為 `410 Gone`，立即刪除該訂閱
- 定期清理長時間未活躍的 subscription

### 情境四：通知點擊後打開錯誤頁面

**原因**：payload URL 與路由規則不一致。  
**解法**：

- payload 傳完整可路由 URL
- SW 點擊事件統一導向入口，再由前端判斷跳轉

### 情境五：同一訊息出現重複通知

**原因**：同帳號在多裝置訂閱，後端未去重策略。  
**解法**：

- 允許多裝置推播但要有 dedupe key
- 對同一事件設定通知 id，重複時改為更新通知內容

## 8.6 本章小結

- Web Push 是前端 SW + 後端發送基礎設施的協作
- 失效訂閱清理與發送節流是穩定運營關鍵
- 權限請求時機比技術實作更影響最終開啟率

---

> 上一章：[可安裝性與安裝引導 UX](./07-installability-and-ux.md) | 下一章：[測試、除錯與品質驗證](./09-testing-and-debugging.md)
