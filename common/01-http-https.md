# 第一章：HTTP 與 HTTPS — 你必須知道的網路通訊基礎

## 1.1 什麼是 HTTP？

HTTP（HyperText Transfer Protocol，超文本傳輸協定）是網際網路上最廣泛使用的應用層協定。當你在瀏覽器輸入網址並按下 Enter，瀏覽器與伺服器之間的溝通就是透過 HTTP 完成的。

### HTTP 的基本運作流程

```
使用者                    瀏覽器                      伺服器
  |                        |                           |
  |--- 輸入網址 --------->|                           |
  |                        |--- HTTP Request -------->|
  |                        |                           |--- 處理請求
  |                        |<-- HTTP Response --------|
  |<-- 顯示網頁 ----------|                           |
```

### HTTP 的特性

| 特性 | 說明 |
|------|------|
| 無狀態（Stateless） | 每次請求之間互相獨立，伺服器不會記住上一次的請求 |
| 基於請求/回應模型 | 客戶端發送請求，伺服器回傳回應 |
| 明文傳輸 | 資料以純文字形式傳輸，**不加密** |
| 預設 Port 80 | HTTP 使用 TCP port 80 |
| 支援多種資料格式 | HTML、JSON、XML、圖片、影片等 |

---

## 1.2 HTTP 請求方法（Methods）

| 方法 | 用途 | 是否有 Body | 冪等性 |
|------|------|-------------|--------|
| GET | 取得資源 | 否 | 是 |
| POST | 建立資源 / 提交資料 | 是 | 否 |
| PUT | 完整更新資源 | 是 | 是 |
| PATCH | 部分更新資源 | 是 | 否 |
| DELETE | 刪除資源 | 可選 | 是 |
| HEAD | 取得回應標頭（不含 Body） | 否 | 是 |
| OPTIONS | 查詢伺服器支援的方法（常用於 CORS 預檢） | 否 | 是 |

### 常見使用範例

```bash
# GET — 取得資料
curl -X GET https://api.example.com/users

# POST — 建立資料
curl -X POST https://api.example.com/users \
  -H "Content-Type: application/json" \
  -d '{"name": "Alice", "email": "alice@example.com"}'

# PUT — 完整更新
curl -X PUT https://api.example.com/users/1 \
  -H "Content-Type: application/json" \
  -d '{"name": "Alice Updated", "email": "alice@example.com"}'

# DELETE — 刪除
curl -X DELETE https://api.example.com/users/1
```

---

## 1.3 HTTP 狀態碼（Status Codes）

### 狀態碼分類

| 分類 | 範圍 | 含義 |
|------|------|------|
| 1xx | 100-199 | 資訊回應（Informational） |
| 2xx | 200-299 | 成功（Success） |
| 3xx | 300-399 | 重新導向（Redirection） |
| 4xx | 400-499 | 客戶端錯誤（Client Error） |
| 5xx | 500-599 | 伺服器錯誤（Server Error） |

### 最常見的狀態碼

```
2xx 成功
├── 200 OK              — 請求成功
├── 201 Created         — 資源建立成功（常見於 POST）
├── 204 No Content      — 成功但無回傳內容（常見於 DELETE）

3xx 重新導向
├── 301 Moved Permanently  — 永久重新導向（SEO 會轉移）
├── 302 Found              — 暫時重新導向
├── 304 Not Modified       — 資源未變更，使用快取

4xx 客戶端錯誤
├── 400 Bad Request     — 請求格式錯誤
├── 401 Unauthorized    — 未認證（需要登入）
├── 403 Forbidden       — 已認證但無權限
├── 404 Not Found       — 資源不存在
├── 405 Method Not Allowed — 不支援該 HTTP 方法
├── 429 Too Many Requests  — 請求頻率過高（Rate Limit）

5xx 伺服器錯誤
├── 500 Internal Server Error — 伺服器內部錯誤
├── 502 Bad Gateway          — 閘道錯誤（上游伺服器無回應）
├── 503 Service Unavailable  — 服務暫時不可用
├── 504 Gateway Timeout      — 閘道逾時
```

---

## 1.4 HTTP 標頭（Headers）

HTTP 標頭攜帶請求與回應的附加資訊：

### 常見的請求標頭

| 標頭 | 用途 | 範例 |
|------|------|------|
| Host | 指定目標主機 | `Host: www.example.com` |
| Content-Type | 請求 Body 的格式 | `Content-Type: application/json` |
| Authorization | 認證資訊 | `Authorization: Bearer <token>` |
| Accept | 客戶端可接受的回應格式 | `Accept: application/json` |
| User-Agent | 客戶端識別資訊 | `User-Agent: Mozilla/5.0 ...` |
| Cookie | 攜帶 Cookie | `Cookie: session_id=abc123` |
| Cache-Control | 快取控制 | `Cache-Control: no-cache` |

### 常見的回應標頭

| 標頭 | 用途 | 範例 |
|------|------|------|
| Content-Type | 回應 Body 的格式 | `Content-Type: text/html; charset=utf-8` |
| Set-Cookie | 設定 Cookie | `Set-Cookie: session_id=abc123; HttpOnly` |
| Cache-Control | 快取策略 | `Cache-Control: max-age=3600` |
| Location | 重新導向目標 URL | `Location: https://www.example.com/new` |
| Access-Control-Allow-Origin | CORS 允許的來源 | `Access-Control-Allow-Origin: *` |

```bash
# 查看完整的請求與回應標頭
curl -v https://www.example.com

# 只查看回應標頭
curl -I https://www.example.com
```

---

## 1.5 什麼是 HTTPS？

HTTPS（HyperText Transfer Protocol Secure）= HTTP + TLS/SSL 加密。它在 HTTP 的基礎上加入了 TLS（Transport Layer Security）加密層，確保資料在傳輸過程中的安全性。

### HTTPS 的三大安全保障

```
1. 加密（Encryption）
   ┌──────────┐         加密通道          ┌──────────┐
   │  瀏覽器   │ ======================== │  伺服器   │
   └──────────┘    第三方無法讀取內容      └──────────┘

2. 資料完整性（Integrity）
   發送：Hello ──→ 傳輸中未被竄改 ──→ 接收：Hello ✓

3. 身份驗證（Authentication）
   瀏覽器確認「這個伺服器確實是 example.com」而非冒充者
```

---

## 1.6 HTTP 與 HTTPS 的核心差異

| 比較項目 | HTTP | HTTPS |
|----------|------|-------|
| 全名 | HyperText Transfer Protocol | HyperText Transfer Protocol Secure |
| 預設 Port | 80 | 443 |
| 加密 | 無（明文傳輸） | TLS/SSL 加密 |
| 資料完整性 | 無保障 | 有（防竄改） |
| 身份驗證 | 無 | 透過 SSL 憑證驗證伺服器身份 |
| URL 前綴 | `http://` | `https://` |
| 效能 | 較快（無加密開銷） | 略慢（TLS 握手 + 加密開銷，但 HTTP/2 補回） |
| SEO | Google 會降低排名 | Google 優先排名 |
| 瀏覽器顯示 | 「不安全」警告 | 鎖頭圖示 🔒 |
| 是否需要憑證 | 不需要 | 需要 SSL/TLS 憑證 |
| 適用場景 | 本地開發、內部測試 | 所有上線網站（強烈建議） |

### 明文 vs 加密的風險示意

```
HTTP（明文傳輸）：
使用者 ──── 帳號:admin, 密碼:1234 ────→ 伺服器
                  ↑
              攻擊者可直接看到！

HTTPS（加密傳輸）：
使用者 ──── x7#kQ!9m$zL... ────→ 伺服器（解密後取得原始資料）
                  ↑
              攻擊者只看到亂碼
```

---

## 1.7 TLS 握手流程（HTTPS 如何建立安全連線）

HTTPS 在傳輸資料前，會先進行 TLS 握手（TLS Handshake）：

### TLS 1.2 握手流程

```
瀏覽器                                        伺服器
  |                                             |
  |─── 1. ClientHello ────────────────────────→|
  |    （支援的 TLS 版本、加密套件清單）           |
  |                                             |
  |←── 2. ServerHello ────────────────────────|
  |    （選定的 TLS 版本、加密套件）               |
  |                                             |
  |←── 3. Certificate ────────────────────────|
  |    （伺服器的 SSL 憑證）                      |
  |                                             |
  |─── 4. 驗證憑證 ──→ CA（憑證授權機構）          |
  |    （確認憑證是否有效、是否被信任）              |
  |                                             |
  |─── 5. Key Exchange ──────────────────────→|
  |    （交換加密金鑰材料）                        |
  |                                             |
  |←── 6. Finished ───────────────────────────|
  |                                             |
  |═══════ 加密通道建立完成 ═══════════════════|
  |═══════ 開始傳輸加密的 HTTP 資料 ═══════════|
```

### TLS 1.3 握手流程（更快）

```
TLS 1.2：需要 2 次往返（2-RTT）才能建立連線
TLS 1.3：只需要 1 次往返（1-RTT），甚至支援 0-RTT

瀏覽器                                        伺服器
  |                                             |
  |─── ClientHello + Key Share ──────────────→|
  |                                             |
  |←── ServerHello + Key Share + Certificate ──|
  |                                             |
  |═══════ 加密通道建立完成（只需 1-RTT）═══════|
```

---

## 1.8 HTTP 版本演進

| 版本 | 年份 | 主要特點 |
|------|------|----------|
| HTTP/1.0 | 1996 | 每次請求都建立新的 TCP 連線 |
| HTTP/1.1 | 1997 | 持久連線（Keep-Alive）、管線化（Pipelining） |
| HTTP/2 | 2015 | 多路復用、標頭壓縮、伺服器推送、需要 HTTPS |
| HTTP/3 | 2022 | 基於 QUIC（UDP）、更快的連線建立、改善行動網路表現 |

### HTTP/1.1 vs HTTP/2

```
HTTP/1.1（一次處理一個請求，需要多個 TCP 連線）：
連線 1: ──[請求 HTML]──[回應]──[請求 CSS]──[回應]──
連線 2: ──[請求 JS]────[回應]──[請求 圖片]──[回應]──
連線 3: ──[請求 字型]──[回應]──

HTTP/2（一個連線同時處理多個請求）：
連線 1: ══[HTML]══[CSS]══[JS]══[圖片]══[字型]══
         ↑ 所有請求在同一個 TCP 連線中並行處理
```

### HTTP/2 vs HTTP/3

```
HTTP/2（基於 TCP）：
  - 一個封包遺失 → 所有串流都被阻塞（隊頭阻塞）
  - TCP 三次握手 + TLS 握手 = 較慢的連線建立

HTTP/3（基於 QUIC / UDP）：
  - 一個串流遺失 → 只影響該串流，其他串流不受影響
  - QUIC 握手 = 更快的連線建立（0-RTT 重連）
  - 更適合行動網路（切換 Wi-Fi / 4G 不斷線）
```

---

## 1.9 如何為你的網站啟用 HTTPS

### 方法一：Let's Encrypt 免費憑證（最推薦）

```bash
# 1. 安裝 Certbot
sudo apt install certbot python3-certbot-nginx -y

# 2. 取得憑證並自動設定（以 Nginx 為例）
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com

# 3. 設定自動續約
sudo certbot renew --dry-run
```

### 方法二：使用雲端服務商的免費 SSL

| 服務商 | 免費 SSL 方案 | 特點 |
|--------|---------------|------|
| Cloudflare | 免費方案即包含 | 最容易設定，只需更改 DNS |
| AWS | ACM（AWS Certificate Manager） | 免費用於 ALB、CloudFront |
| GCP | Google-managed SSL | 免費用於 Cloud Load Balancing |

### 方法三：購買付費 SSL 憑證

適用於需要 OV（組織驗證）或 EV（延伸驗證）憑證的企業：

```
購買流程：
1. 選擇 SSL 供應商（DigiCert、Sectigo、GlobalSign 等）
2. 產生 CSR（Certificate Signing Request）
3. 提交 CSR 並完成驗證（DNS / Email / HTTP 驗證）
4. 下載憑證並安裝到伺服器
```

```bash
# 產生 CSR
openssl req -new -newkey rsa:2048 -nodes \
  -keyout yourdomain.key \
  -out yourdomain.csr \
  -subj "/C=TW/ST=Taiwan/L=Taipei/O=MyCompany/CN=yourdomain.com"
```

### 方法四：反向代理自動處理 HTTPS

如果你使用 Nginx 或 Caddy 作為反向代理，可以讓它代為處理 HTTPS：

```nginx
# Nginx 設定：前端處理 HTTPS，後端用 HTTP
server {
    listen 443 ssl http2;
    server_name yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;  # 後端應用不需要處理 SSL
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

```
# Caddy 設定（自動取得並管理 HTTPS 憑證）
yourdomain.com {
    reverse_proxy localhost:3000
}
# Caddy 會自動向 Let's Encrypt 申請憑證，完全不需要手動設定！
```

---

## 1.10 實際情境

### 情境一：瀏覽器顯示「不安全」警告

**問題**：使用者反映訪問網站時，瀏覽器地址列出現「不安全」提示

**原因與解決**：

```bash
# 原因：網站仍使用 HTTP，未啟用 HTTPS

# 解決步驟：
# 1. 確認是否已有 SSL 憑證
sudo certbot certificates

# 2. 如果沒有，申請一張
sudo certbot --nginx -d yourdomain.com

# 3. 設定 HTTP 自動導向 HTTPS
# 在 Nginx 中加入：
# server {
#     listen 80;
#     server_name yourdomain.com;
#     return 301 https://$host$request_uri;
# }

# 4. 測試
curl -I http://yourdomain.com
# 應回傳 301 導向到 https://
```

### 情境二：HTTPS 上線後，頁面出現 Mixed Content

**問題**：網站已啟用 HTTPS，但瀏覽器 Console 出現 Mixed Content 警告，部分資源無法載入

```
# 典型錯誤訊息：
Mixed Content: The page at 'https://yourdomain.com' was loaded over HTTPS,
but requested an insecure resource 'http://cdn.example.com/style.css'.
```

**解決方式**：

```bash
# 1. 找出所有使用 http:// 的資源引用
rg 'http://' --glob '*.html' --glob '*.css' --glob '*.js' /var/www/yourdomain/

# 2. 將 http:// 改為 https:// 或使用協定相對路徑 //
# 修改前：<img src="http://cdn.example.com/logo.png">
# 修改後：<img src="https://cdn.example.com/logo.png">
# 或：    <img src="//cdn.example.com/logo.png">

# 3. 在 Nginx 加上 CSP 標頭，自動升級不安全的請求
# add_header Content-Security-Policy "upgrade-insecure-requests" always;
```

### 情境三：API 從 HTTP 升級到 HTTPS 後，前端呼叫失敗

**問題**：後端 API 啟用 HTTPS 後，前端出現 CORS 錯誤或連線失敗

```bash
# 常見原因：
# 1. 前端仍使用 http:// 呼叫 API → 改為 https://
# 2. CORS 設定的 Origin 仍為 http:// → 更新為 https://
# 3. 憑證不被信任（自簽憑證）→ 改用 Let's Encrypt

# 檢查方式
curl -v https://api.yourdomain.com/health

# 如果是自簽憑證問題（開發環境），可暫時略過驗證
curl -k https://api.yourdomain.com/health
```

### 情境四：不確定網站的 HTTP 版本

```bash
# 查看網站使用的 HTTP 版本
curl -sI https://www.google.com -o /dev/null -w "HTTP Version: %{http_version}\n"
# 輸出：HTTP Version: 2

# 查看詳細的 TLS 資訊
curl -v https://yourdomain.com 2>&1 | grep -E "(SSL|TLS|HTTP/)"
```

---

## 1.11 開發者常見問題 FAQ

### Q1：本地開發需要 HTTPS 嗎？

大多數情況不需要。但以下場景需要：
- 測試 Service Worker（PWA）
- 使用需要 HTTPS 的 Web API（如 Geolocation、Camera）
- 測試 CORS 或 Cookie 的 `Secure` 屬性

```bash
# 本地快速建立 HTTPS（使用 mkcert）
# 安裝 mkcert
brew install mkcert    # macOS
sudo apt install mkcert # Linux

# 安裝本地 CA
mkcert -install

# 產生本地憑證
mkcert localhost 127.0.0.1 ::1

# 在 Node.js 中使用
# const https = require('https');
# const fs = require('fs');
# https.createServer({
#   key: fs.readFileSync('./localhost-key.pem'),
#   cert: fs.readFileSync('./localhost.pem')
# }, app).listen(3000);
```

### Q2：HTTPS 會讓網站變慢嗎？

**幾乎不會**。原因：
- 現代 CPU 的加解密效能極高
- TLS 1.3 握手只需 1-RTT（比 TLS 1.2 快）
- HTTPS 是啟用 HTTP/2 的前提，HTTP/2 的效能提升遠大於加密的開銷
- 使用 SSL Session Resumption 可以避免重複握手

### Q3：HTTP 和 HTTPS 可以同時運行嗎？

可以，但建議設定 HTTP → HTTPS 的 301 重新導向：

```nginx
# 同時監聽 80 和 443，但將 HTTP 導向 HTTPS
server {
    listen 80;
    server_name yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name yourdomain.com;
    # ... SSL 設定
}
```

---

## 1.12 本章小結

- HTTP 是網際網路的基礎通訊協定，理解請求方法、狀態碼、標頭是後端開發的必備知識
- HTTPS = HTTP + TLS 加密，提供加密傳輸、資料完整性、身份驗證三大保障
- 所有上線網站都應該使用 HTTPS，Let's Encrypt 提供免費且自動化的憑證方案
- HTTP/2 和 HTTP/3 帶來顯著的效能提升，而 HTTPS 是啟用 HTTP/2 的前提條件
- TLS 1.3 比 1.2 更快、更安全，應優先使用
- 切換到 HTTPS 後，注意處理 Mixed Content 和 CORS 問題

---

> 下一章：[SSL 憑證的取得與必備知識](./02-ssl-certificates.md)
