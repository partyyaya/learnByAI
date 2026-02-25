# 第十章：部署上線與實際情境排查

## 10.1 上線前檢查清單

- 全站 HTTPS（含 API、CDN 資源）
- `sw.js`、`manifest.webmanifest` 可正確存取
- SPA 路由 fallback 設定完整
- cache key 與版本號同步
- 錯誤監控已接入（Sentry/Log/Analytics）

## 10.2 伺服器快取策略建議

建議區分資源類型：

- `sw.js`：`Cache-Control: no-cache`
- `manifest.webmanifest`：短快取或需可回收
- 打包後 hash 檔（`app.xxxxx.js`）：長快取（immutable）
- `index.html`：短快取，確保入口可快速更新

## 10.3 Nginx（SPA + PWA）示例

```nginx
server {
  listen 443 ssl;
  server_name example.com;
  root /var/www/pwa-app;

  location = /sw.js {
    add_header Cache-Control "no-cache";
  }

  location = /manifest.webmanifest {
    add_header Cache-Control "public, max-age=300";
  }

  location /assets/ {
    add_header Cache-Control "public, max-age=31536000, immutable";
  }

  location / {
    try_files $uri $uri/ /index.html;
  }
}
```

## 10.4 CI/CD 發版建議

- 每次部署生成唯一版本號（例如 git sha）
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
- SW 註冊路徑與 scope 也要同步調整

### 情境三：Deep link 在瀏覽器正常，安裝版點進去 404

**原因**：伺服器沒對 SPA 路由 fallback 到 `index.html`。  
**解法**：

- 補上 `try_files $uri $uri/ /index.html`
- 對 API 路徑獨立 location，避免被誤導到前端入口

### 情境四：緊急回滾後仍有使用者報新版本錯誤

**原因**：用戶端快取與 SW 狀態不同步。  
**解法**：

- 回滾版本也要升新的 cache key（例如 `static-v5-rollback1`）
- 顯示「請重新整理」提示，必要時引導清理站點資料

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

> 上一章：[測試、除錯與品質驗證](./09-testing-and-debugging.md)
