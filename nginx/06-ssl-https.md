# 第六章：SSL / HTTPS 憑證設定

## 6.1 為什麼需要 HTTPS？

| 風險 | HTTP | HTTPS |
|------|------|-------|
| 資料被竊聽 | 明文傳輸，可被攔截 | 加密傳輸 |
| 資料被竄改 | 無法偵測竄改 | 完整性驗證 |
| 身份冒充 | 無法驗證伺服器身份 | 憑證驗證 |
| SEO 排名 | Google 降低排名 | 排名加分 |
| 瀏覽器警告 | 顯示「不安全」 | 顯示鎖頭圖示 |

---

## 6.2 使用 Let's Encrypt 免費憑證

### 安裝 Certbot

```bash
# Ubuntu
sudo apt install certbot python3-certbot-nginx -y

# CentOS
sudo yum install certbot python3-certbot-nginx -y
```

### 自動取得憑證並設定 Nginx

```bash
# Certbot 會自動修改 Nginx 設定
sudo certbot --nginx -d mysite.com -d www.mysite.com

# 互動式流程會詢問：
# 1. Email 地址（用於到期通知）
# 2. 是否同意服務條款
# 3. 是否將 HTTP 重導向到 HTTPS
```

### 手動取得憑證（不自動修改設定）

```bash
# 使用 webroot 方式驗證
sudo certbot certonly --webroot -w /var/www/mysite.com/html -d mysite.com -d www.mysite.com

# 憑證會存放在：
# /etc/letsencrypt/live/mysite.com/fullchain.pem  （完整憑證鏈）
# /etc/letsencrypt/live/mysite.com/privkey.pem    （私鑰）
```

### 設定自動續約

```bash
# 測試續約流程
sudo certbot renew --dry-run

# 自動續約（Certbot 安裝時通常會自動設定 cron 或 systemd timer）
# 檢查 timer 狀態
sudo systemctl status certbot.timer

# 手動添加 cron（如果沒有自動設定）
# 每天凌晨 2 點檢查並續約
echo "0 2 * * * root certbot renew --quiet --post-hook 'systemctl reload nginx'" | sudo tee /etc/cron.d/certbot-renew
```

---

## 6.3 手動設定 SSL

### 基本 HTTPS 設定

```nginx
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name mysite.com www.mysite.com;

    # SSL 憑證
    ssl_certificate /etc/letsencrypt/live/mysite.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mysite.com/privkey.pem;

    # SSL 設定
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;
    ssl_ciphers 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384';

    # SSL 效能優化
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;
    ssl_session_tickets off;

    # OCSP Stapling
    ssl_stapling on;
    ssl_stapling_verify on;
    ssl_trusted_certificate /etc/letsencrypt/live/mysite.com/chain.pem;
    resolver 8.8.8.8 8.8.4.4 valid=300s;
    resolver_timeout 5s;

    root /var/www/mysite.com/html;
    index index.html;
}

# HTTP → HTTPS 重導向
server {
    listen 80;
    listen [::]:80;
    server_name mysite.com www.mysite.com;
    return 301 https://$host$request_uri;
}
```

### 建立共用的 SSL 設定片段

```nginx
# /etc/nginx/snippets/ssl-params.conf

ssl_protocols TLSv1.2 TLSv1.3;
ssl_prefer_server_ciphers on;
ssl_ciphers 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384';

ssl_session_cache shared:SSL:10m;
ssl_session_timeout 10m;
ssl_session_tickets off;

ssl_stapling on;
ssl_stapling_verify on;

# 安全標頭
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-XSS-Protection "1; mode=block" always;
```

```nginx
# 在 server block 中使用
server {
    listen 443 ssl http2;
    server_name mysite.com;

    ssl_certificate /etc/letsencrypt/live/mysite.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mysite.com/privkey.pem;
    include snippets/ssl-params.conf;

    # ... 其他設定
}
```

---

## 6.4 HTTP/2 設定

HTTP/2 可以大幅提升網站載入速度：

```nginx
server {
    # 啟用 HTTP/2（需要 SSL）
    listen 443 ssl http2;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    # HTTP/2 推送（可選）
    location / {
        root /var/www/html;
        http2_push /css/style.css;
        http2_push /js/app.js;
    }
}
```

---

## 6.5 SSL 終止（SSL Termination）

在 Nginx 層處理 SSL，後端只需處理 HTTP：

```nginx
upstream backend {
    server 10.0.1.10:3000;
    server 10.0.1.11:3000;
}

server {
    listen 443 ssl http2;
    server_name api.mysite.com;

    ssl_certificate /etc/letsencrypt/live/api.mysite.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.mysite.com/privkey.pem;
    include snippets/ssl-params.conf;

    location / {
        # 後端使用 HTTP（不需要 SSL）
        proxy_pass http://backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;  # 告訴後端原始請求是 HTTPS
    }
}
```

**優點**：

- 後端不需要管理憑證
- 減少後端的 CPU 負擔（SSL 加解密由 Nginx 處理）
- 集中管理憑證，更容易維護

---

## 6.6 自簽憑證（開發環境用）

```bash
# 生成自簽憑證（有效期 365 天）
sudo openssl req -x509 -nodes -days 365 \
    -newkey rsa:2048 \
    -keyout /etc/ssl/private/self-signed.key \
    -out /etc/ssl/certs/self-signed.crt \
    -subj "/C=TW/ST=Taiwan/L=Taipei/O=Dev/CN=localhost"

# 生成 DH 參數（增強安全性）
sudo openssl dhparam -out /etc/ssl/certs/dhparam.pem 2048
```

```nginx
server {
    listen 443 ssl;
    server_name localhost;

    ssl_certificate /etc/ssl/certs/self-signed.crt;
    ssl_certificate_key /etc/ssl/private/self-signed.key;

    # ... 其他設定
}
```

---

## 6.7 實際情境

### 情境一：SSL 憑證到期，網站顯示不安全

**問題**：瀏覽器顯示「您的連線不安全」或「NET::ERR_CERT_DATE_INVALID」

```bash
# 1. 檢查憑證到期日
sudo openssl x509 -in /etc/letsencrypt/live/mysite.com/fullchain.pem -noout -dates

# 2. 手動續約
sudo certbot renew

# 3. 如果續約失敗，檢查原因
sudo certbot renew --dry-run

# 常見問題：
# - DNS 沒有指向這台伺服器
# - 80 port 被防火牆擋住（Let's Encrypt 需要 80 port 驗證）
# - Certbot 的 webroot 路徑不正確

# 4. 重載 Nginx
sudo nginx -s reload

# 5. 設定監控，在到期前 14 天發送通知
# 可使用 cron + 腳本檢查
```

### 情境二：Mixed Content 警告

**問題**：HTTPS 頁面中載入了 HTTP 資源

```nginx
# 方法一：在 Nginx 加上 CSP 標頭，自動將 HTTP 升級為 HTTPS
add_header Content-Security-Policy "upgrade-insecure-requests" always;

# 方法二：確保所有資源都使用 HTTPS 或相對路徑
# 檢查 HTML 中是否有 http:// 開頭的資源連結
```

### 情境三：SSL 握手失敗

**問題**：出現 `SSL_ERROR_HANDSHAKE_FAILURE_ALERT` 錯誤

```bash
# 1. 測試 SSL 連線
openssl s_client -connect mysite.com:443 -servername mysite.com

# 2. 檢查憑證鏈是否完整
openssl s_client -connect mysite.com:443 -servername mysite.com -showcerts

# 3. 常見原因
# - 憑證鏈不完整（缺少中間憑證）
# - 使用了 ssl_certificate 而非 fullchain.pem
# - TLS 版本不相容

# 解決：使用完整憑證鏈
ssl_certificate /etc/letsencrypt/live/mysite.com/fullchain.pem;  # 不是 cert.pem！
```

### 情境四：多個網站共用一台伺服器的 SSL 設定

```nginx
# 使用 SNI（Server Name Indication），一個 IP 可以有多張 SSL 憑證

server {
    listen 443 ssl http2;
    server_name site-a.com;
    ssl_certificate /etc/letsencrypt/live/site-a.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/site-a.com/privkey.pem;
    include snippets/ssl-params.conf;
}

server {
    listen 443 ssl http2;
    server_name site-b.com;
    ssl_certificate /etc/letsencrypt/live/site-b.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/site-b.com/privkey.pem;
    include snippets/ssl-params.conf;
}
```

---

## 6.8 SSL 安全性檢測

部署完成後，使用以下工具檢查 SSL 設定是否安全：

```bash
# 線上檢測
# https://www.ssllabs.com/ssltest/
# 目標：取得 A 或 A+ 評等

# 命令列檢測
# 檢查支援的 TLS 版本
nmap --script ssl-enum-ciphers -p 443 mysite.com

# 檢查憑證資訊
echo | openssl s_client -connect mysite.com:443 -servername mysite.com 2>/dev/null | openssl x509 -text -noout

# 檢查 HSTS
curl -sI https://mysite.com | grep -i strict
```

---

## 6.9 本章小結

- HTTPS 是現代網站的標配，Let's Encrypt 提供免費憑證
- 使用 Certbot 可以一鍵完成憑證申請與 Nginx 設定
- SSL 終止讓後端免於處理 SSL 加解密的負擔
- 一定要設定自動續約，避免憑證過期
- 務必使用 `fullchain.pem` 而非 `cert.pem`
- 上線後使用 SSL Labs 檢測安全性

---

> 上一章：[負載均衡](./05-load-balancing.md) | 下一章：[效能優化與快取策略](./07-performance.md)
