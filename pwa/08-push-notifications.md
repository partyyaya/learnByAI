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
  - Chrome：走 Google FCM 端點（`fcm.googleapis.com`）
  - Edge（Windows）：走 Windows Push Notification Services（`*.notify.windows.com`）
  - Firefox：走 Mozilla Push Service
  - Safari（macOS / iOS 16.4+）：走 Apple Push 端點（`web.push.apple.com`）
- 實務上你不需要手動挑瀏覽器推播端點；後端只要把訊息送到 `subscription.endpoint` 即可。
- 你可以選擇的「發送平台」通常是：
  - 自建後端（常見 Node `web-push` 套件，搭配 VAPID）
  - 第三方平台（如 OneSignal、Firebase Cloud Messaging）協助管理訂閱與發送

**備註（iOS 的限制）**

- iOS / iPadOS 只有「加入主畫面」的 Web App 能訂閱推播；在 Safari 分頁裡 `Notification`、`PushManager` 都不存在，要先引導使用者安裝（第七章）。
- 請求權限必須由使用者點擊直接觸發，Safari 會擋掉頁面載入時自動跳出的請求。
- iOS / iPadOS 18.4 起支援 Declarative Web Push：推播內容本身就描述好通知（最外層帶 `web_push` 欄位），不需要 Service Worker 也能顯示。

## 8.2 前端訂閱流程（示意）

先產生一組 VAPID 金鑰，公鑰放前端 `.env` 的 `VITE_VAPID_PUBLIC_KEY`，私鑰只放後端：

```bash
npx web-push generate-vapid-keys
```

```ts
// 在「啟用通知」按鈕的 click handler 裡呼叫
export async function enablePush() {
  if (!("Notification" in window) || !("PushManager" in window)) {
    throw new Error("此瀏覽器不支援推播（iOS 需先加入主畫面）");
  }

  // 先請求權限：Safari 要求在使用者點擊後直接呼叫，前面不要先 await 其他東西
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notification permission denied");

  const registration = await navigator.serviceWorker.ready;
  // 已經訂閱過就沿用，不要重複建立
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true, // 承諾每則推播都會顯示通知
      applicationServerKey: urlBase64ToUint8Array(import.meta.env.VITE_VAPID_PUBLIC_KEY)
    }));

  await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subscription)
  });
}

// VAPID 公鑰是 base64url 字串，subscribe 需要的是 Uint8Array
function urlBase64ToUint8Array(base64Url: string) {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}
```

## 8.3 SW 顯示通知（示意）

```js
self.addEventListener("push", (event) => {
  let payload = { title: "新通知", body: "你有一則新訊息", url: "/" };
  try {
    payload = { ...payload, ...event.data?.json() };
  } catch {
    // 不是 JSON 就當成純文字內容
    payload.body = event.data?.text() || payload.body;
  }

  // userVisibleOnly: true 代表每則推播都要顯示通知：
  // 沒顯示的話 Chrome 會改顯示一則預設通知，Safari 則可能撤銷訂閱
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-72.png", // Android 狀態列的小圖示，要用單色、透明背景
      tag: payload.tag, // 同一個 tag 的新通知會取代舊的，不會疊一排
      data: { url: payload.url }
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || "/", self.location.origin).href;

  event.waitUntil(
    (async () => {
      // App 已經開著就切過去並導到目標頁，沒有才開新視窗
      const windows = await self.clients.matchAll({ type: "window" });
      const existing = windows[0];
      if (existing) {
        await existing.focus();
        return existing.navigate(targetUrl);
      }
      return self.clients.openWindow(targetUrl);
    })()
  );
});
```

`clients.matchAll()` 預設只回傳受這個 SW 控制的分頁，`navigate()` 也只能用在這些分頁上。

## 8.4 後端發送重點

以 Node 的 `web-push` 套件為例：

```js
import webpush from "web-push";

webpush.setVapidDetails(
  "mailto:admin@example.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

export async function sendToSubscription(subscription, message) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify(message), {
      TTL: 60 * 60, // 裝置離線時，Push Service 最多保留 1 小時
      urgency: "normal"
    });
  } catch (error) {
    // 404/410：訂閱已失效，從資料庫刪除
    if (error.statusCode === 404 || error.statusCode === 410) {
      await deleteSubscription(subscription.endpoint);
      return;
    }
    throw error;
  }
}
```

- 訂閱資料需與使用者帳號綁定，並對 `endpoint` 建唯一索引，同一個瀏覽器重複訂閱只留一筆
- `endpoint` 可能超過 255 字元（例如 Edge 的 WNS 端點），欄位不要用 `VARCHAR(255)`
- 推播失敗（410/404）要清理失效訂閱；413 代表內容太大（上限約 4 KB），429 代表發太快，依 `Retry-After` 稍後再送
- 訂閱綁定建立當下的 VAPID 公鑰，換了金鑰之後舊訂閱全部不能用，要讓前端重新訂閱
- 請限制發送頻率，避免被判定濫用

## 8.5 實際運行情境與解決方法

### 情境一：`Notification.permission` 一直是 `denied`

**原因**：使用者曾拒絕權限。  
**解法**：

- 不要重複彈窗，改引導使用者到瀏覽器設定手動開啟
- 調整請求時機，在使用者理解價值後再請求

### 情境二：本機測得到，正式環境推播完全收不到

**原因**：VAPID 金鑰或 endpoint 環境不一致；iOS 使用者則可能是還沒把網站加入主畫面。  
**解法**：

- 確認前端 public key 與後端 private key 成對
- 驗證正式環境使用的 subscription 不是測試資料（測試環境換過金鑰的訂閱，在正式環境都不能用）
- iOS 先確認是從主畫面開啟的 App 訂閱，Safari 分頁裡無法訂閱

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
- App 已開著時，用 8.3 的 `focus()` + `navigate()` 切過去，不要每次都開新視窗

### 情境五：同一訊息出現重複通知

**原因**：同一個瀏覽器的 subscription 在資料庫存了多筆（例如每次登入都新增一筆），或同一事件被發送了多次。同帳號在多台裝置各收到一則是正常的，不算重複。  
**解法**：

- 以 `endpoint` 去重，同一個 endpoint 只存一筆
- 發送端對同一事件帶 dedupe key，避免重複發送
- 通知設定 `tag`：同一個 tag 的新通知會取代舊的；想讓取代時再響一次，加上 `renotify: true`

## 8.6 本章小結

- Web Push 是前端 SW + 後端發送基礎設施的協作
- 失效訂閱清理與發送節流是穩定運營關鍵
- 權限請求時機比技術實作更影響最終開啟率

---

> 上一章：[可安裝性與安裝引導 UX](./07-installability-and-ux.md) | 下一章：[測試、除錯與品質驗證](./09-testing-and-debugging.md)
