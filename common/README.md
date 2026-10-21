# 通用基礎知識教學

> 整理命令列工具、JavaScript 非同步、瀏覽器 API、網路通訊與安全部署等共通知識，可依學習順序閱讀，也可按工作需求查閱。

---

## 課程目錄與建議順序

### 1. 環境與命令列工具

依作業系統選讀，不需要兩份都讀完才往下進行；部署時也可以回來查指令。

| 檔案 | 主題 |
|------|------|
| [bash.md](./bash.md) | Bash 常用指令 — 檔案、程序、網路與 Nginx／Docker 操作 |
| [windows.md](./windows.md) | Windows 常用指令 — CMD、PowerShell、程序與服務管理 |

### 2. 非同步與瀏覽器實務

先理解非同步流程，再學瀏覽器提供的能力，最後處理需要背景執行緒的運算。

| 檔案 | 主題 |
|------|------|
| [promise-async-await-then.md](./promise-async-await-then.md) | Promise、then 與 async/await — 非同步流程與原理手作 |
| [browser-native-apis.md](./browser-native-apis.md) | 瀏覽器原生 API — Observer、排程、請求取消、跨分頁通訊與資源清理 |
| [web-worker.md](./web-worker.md) | Web Worker — 背景運算、通訊與原生／Vue／React 整合 |

### 3. 網路與即時通訊

先建立 HTTP 基礎，再比較伺服器單向推送與雙向通訊。若不熟悉請求與回應，可先讀 HTTP，再回到瀏覽器 API 篇的 fetch 範例。

| 檔案 | 主題 |
|------|------|
| [http-https.md](./http-https.md) | HTTP 與 HTTPS — 網路通訊基礎與差異 |
| [sse.md](./sse.md) | SSE — 伺服器推送、自動重連與斷點續傳 |
| [websocket.md](./websocket.md) | WebSocket — 雙向通訊、握手升級、心跳重連與部署 |

### 4. 安全與部署上線

先理解憑證與傳輸安全，再學登入驗證，最後將網域、DNS、HTTPS 與 Nginx 串成上線流程。

| 檔案 | 主題 |
|------|------|
| [ssl-certificates.md](./ssl-certificates.md) | SSL/TLS 憑證 — 取得、結構與管理 |
| [jwt-auth-frontend-backend.md](./jwt-auth-frontend-backend.md) | JWT 登入與加密實戰 — 簽章、密碼雜湊、Token 流程與安全 |
| [domain-dns-https-nginx.md](./domain-dns-https-nginx.md) | 網域到 HTTPS 上線 — DNS、憑證與前端 Nginx 實戰 |

### 5. 互動效果範例

| 檔案 | 主題 |
|------|------|
| [mouse-erase-reveal.html](./mouse-erase-reveal.html) | 滑鼠擦除露圖效果 — Canvas 遮罩與滑鼠互動，可用瀏覽器開啟觀察 |

---

## 課程特色

- **基礎觀念扎實**：從原理開始講解，建立正確的知識架構
- **理論 + 實務並重**：每個章節都附有可執行的指令與設定範例
- **情境導向學習**：涵蓋開發到上線會遇到的真實問題與解決方案
- **跨領域通用**：無論你使用 Nginx、Docker 還是其他技術，這些知識都適用

## 適合對象

- 想搞懂 HTTP/HTTPS 原理的後端或全端工程師
- 想補強非同步、瀏覽器 API 與效能處理的前端工程師
- 需要管理 SSL 憑證的 DevOps / SRE 工程師
- 對網站安全性有興趣的開發者
- 準備將網站從 HTTP 升級到 HTTPS 的人

## 環境需求

- 命令列篇：Linux／macOS 的 Shell，或 Windows 的 CMD／PowerShell；部分指令依環境選用。
- 瀏覽器篇：瀏覽器與開發者工具；需要模組或安全環境的範例搭配本機開發伺服器。
- 網路與部署篇：依章節使用 curl、openssl、certbot、Nginx 等工具；實際申請公開憑證時準備網域與可驗證的部署環境。

---

> 已熟悉命令列可直接從 [Promise 與 async/await](./promise-async-await-then.md) 開始；只想學網站上線則從 [HTTP 與 HTTPS](./http-https.md) 接到安全與部署篇。
