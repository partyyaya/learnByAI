# 第十章：部署上線與實際情境排查

## 10.1 上線前檢查清單

- 全站 HTTPS（含 API、CDN 資源）
- `sw.js`、`manifest.webmanifest` 可正確存取
- SPA 路由 fallback 設定完整
- cache key 與版本號同步
- 上一版的 `/assets/` 檔案仍保留在伺服器上（舊頁面還會載入它們）
- 錯誤監控已接入（Sentry/Log/Analytics）

## 10.2 伺服器快取策略建議

建議區分資源類型：

- `sw.js`：`Cache-Control: no-cache`
- `manifest.webmanifest`：短快取或需可回收
- 打包後 hash 檔（`app.xxxxx.js`）：長快取（immutable）
- `index.html`：`no-cache`，每次向伺服器確認，發版後入口立刻更新

## 10.3 Nginx（SPA + PWA）示例

```nginx
server {
  listen 443 ssl;
  server_name example.com;
  ssl_certificate     /etc/nginx/certs/example.com.crt;
  ssl_certificate_key /etc/nginx/certs/example.com.key;
  root /var/www/pwa-app;

  # SW 腳本：每次向伺服器確認；找不到就回 404，不會被 SPA fallback 回成 HTML
  location = /sw.js {
    add_header Cache-Control "no-cache";
  }

  location = /manifest.webmanifest {
    add_header Cache-Control "public, max-age=300";
  }

  # 入口 HTML：try_files 退回 /index.html 時也會套用這裡的標頭
  location = /index.html {
    add_header Cache-Control "no-cache";
  }

  location /assets/ {
    add_header Cache-Control "public, max-age=31536000, immutable";
  }

  location / {
    try_files $uri $uri/ /index.html;
  }
}
```

> Nginx 的 `add_header` 寫在 `location` 裡時，不會再繼承 `server` 層的 `add_header`。若在 `server` 層設了安全標頭（例如 CSP），每個有 `add_header` 的 `location` 都要再寫一次。

## 10.4 CI/CD 發版建議

- 每次部署生成唯一版本號（例如 git sha）
- 部署時不要清空 `/assets/`：新檔案與上一版的檔案並存一段時間，再定期清掉太舊的
- 發版後自動執行 smoke test（首頁、離線頁、SW 狀態）
- 若錯誤率飆升可快速回滾
- 回滾時同步處理 SW 與 cache 版本，避免新舊混跑

## 10.5 實際運行情境與解決方法

### 情境一：部署完成，部分使用者永遠拿到舊版

**原因**：CDN 對 `sw.js` 做長快取。  
**解法**：

- 強制 `sw.js` 走 `no-cache`
- 發版後主動 purge 相關路徑

### 情境二：站點部署在子路徑，安裝後全部 404

**原因**：Manifest `start_url`/`scope` 仍是根路徑。  
**解法**：

- 子路徑 `/pwa/` 需設定 `start_url: "/pwa/"`、`scope: "/pwa/"`
- Vite 設定 `base: "/pwa/"`，註冊時用 `BASE_URL` 組路徑，SW 的 scope 預設就是 `sw.js` 所在的 `/pwa/`：

```ts
navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
```

- SW 裡寫死的 `"/"`、`"/index.html"`、`"/offline.html"` 也要改成子路徑，或用 `new URL("index.html", self.registration.scope).href` 組出來
- `sw.js` 若放在比 scope 更深的目錄（例如 `/pwa/assets/sw.js` 想控制 `/pwa/`），伺服器要對 `sw.js` 加上 `Service-Worker-Allowed: /pwa/` 標頭

### 情境三：Deep link 在瀏覽器正常，安裝版點進去 404

**原因**：伺服器沒對 SPA 路由 fallback 到 `index.html`。在瀏覽器裡多半是從首頁點進去，由前端路由切換，不會向伺服器要這個網址；安裝版從捷徑、通知或分享連結直接開深層網址，請求才會打到伺服器。  
**解法**：

- 補上 `try_files $uri $uri/ /index.html`
- 對 API 路徑獨立 location，避免被誤導到前端入口

### 情境四：緊急回滾後仍有使用者報新版本錯誤

**原因**：用戶端快取與 SW 狀態不同步。  
**解法**：

- 回滾版本也要升新的 cache key（例如 `static-v5-rollback1`）
- 顯示「請重新整理」提示，必要時引導清理站點資料
- 情況嚴重、需要讓所有使用者立刻脫離 SW 時，部署一支「自我解除」的 `sw.js`：

```js
// 緊急停用用的 sw.js：清掉所有快取、解除註冊，並把開著的頁面重新載入
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      await self.registration.unregister();
      const windows = await self.clients.matchAll({ type: "window" });
      windows.forEach((client) => client.navigate(client.url));
    })()
  );
});
```

- 也可以在 `index.html` 的回應加上 `Clear-Site-Data: "cache", "storage"`，瀏覽器會清掉快取、儲存資料與 SW 註冊。使用者的離線草稿也會一起消失，各瀏覽器支援度也不同；只在緊急時短期加上，否則每次載入都會清一次

### 情境五：多地區部署後行為不一致

**原因**：區域 CDN 與 API 版本不同步。  
**解法**：

- 發版採漸進 rollout，監控分區指標
- 前端讀取版本端點，異常時可提示使用者暫時刷新

## 10.6 維運觀測指標

- 安裝率（Install conversion rate）
- 推播開啟率與退訂率
- 離線命中率（Offline success rate）
- 更新成功率（新 SW 接管比例）
- 前端錯誤率與 API 失敗率

## 10.7 本章小結

- PWA 上線穩定度取決於快取策略與部署流程
- `sw.js` 快取政策是最常見事故根源
- 回滾策略必須把 Service Worker 生命週期一起納入設計

---

> 上一章：[測試、除錯與品質驗證](./09-testing-and-debugging.md) | 下一章：[vite-plugin-pwa 與 Workbox](./11-vite-plugin-pwa-and-workbox.md)
