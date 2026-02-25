# 第十一章：實際情境與解決方案

## 11.1 情境總覽

本章收錄實際工作中常遇到的 Nginx 設定情境，每個情境都包含需求描述、完整設定範例、注意事項與常見問題。

---

## 11.2 情境：前後端分離的 SPA 部署

### 需求

- 前端：React / Vue / Angular 打包後的靜態檔案
- 後端：Node.js / Python / Java API 服務
- 同一個域名下，`/api` 路徑轉發到後端

### 完整設定

```nginx
server {
    listen 80;
    server_name myapp.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name myapp.com;

    ssl_certificate /etc/letsencrypt/live/myapp.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/myapp.com/privkey.pem;
    include snippets/ssl-params.conf;

    root /var/www/myapp/dist;
    index index.html;

    # 前端 SPA — 所有路徑都回傳 index.html
    location / {
        try_files $uri $uri/ /index.html;

        # HTML 不快取
        location ~* \.html$ {
            expires -1;
            add_header Cache-Control "no-store, no-cache, must-revalidate";
        }
    }

    # 靜態資源 — 長時間快取
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        access_log off;
    }

    # API 反向代理
    location /api/ {
        proxy_pass http://localhost:3000/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 上傳檔案大小限制
        client_max_body_size 50M;
    }

    # WebSocket
    location /ws/ {
        proxy_pass http://localhost:3000/ws/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }
}
```

### 常見問題

- **重新整理出現 404**：確認有 `try_files $uri $uri/ /index.html`
- **API CORS 錯誤**：確認 `proxy_pass` 的尾斜線設定
- **靜態資源 404**：確認 `root` 路徑正確、`dist` 目錄有內容

---

## 11.3 情境：WordPress / PHP 網站

### 完整設定

```nginx
server {
    listen 443 ssl http2;
    server_name blog.mysite.com;

    ssl_certificate /etc/letsencrypt/live/blog.mysite.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/blog.mysite.com/privkey.pem;
    include snippets/ssl-params.conf;

    root /var/www/wordpress;
    index index.php index.html;

    # WordPress 固定網址
    location / {
        try_files $uri $uri/ /index.php?$args;
    }

    # PHP 處理
    location ~ \.php$ {
        include fastcgi_params;
        fastcgi_pass unix:/var/run/php/php8.2-fpm.sock;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        fastcgi_index index.php;

        # 效能設定
        fastcgi_buffer_size 128k;
        fastcgi_buffers 4 256k;
        fastcgi_busy_buffers_size 256k;
        fastcgi_read_timeout 300;
    }

    # 靜態資源快取
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
        expires 30d;
        add_header Cache-Control "public";
        access_log off;
    }

    # 封鎖敏感檔案
    location ~ /\.ht {
        deny all;
    }

    location = /wp-config.php {
        deny all;
    }

    location ~* /wp-content/uploads/.*\.php$ {
        deny all;
    }

    # 限制 wp-login 登入嘗試
    location = /wp-login.php {
        limit_req zone=login burst=3 nodelay;
        include fastcgi_params;
        fastcgi_pass unix:/var/run/php/php8.2-fpm.sock;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    }

    # XML-RPC 防護（常被暴力攻擊）
    location = /xmlrpc.php {
        deny all;
        return 403;
    }
}
```

---

## 11.4 情境：多環境部署（開發 / 測試 / 正式）

### 需求

- `dev.myapp.com` → 開發環境
- `staging.myapp.com` → 測試環境
- `myapp.com` → 正式環境

```nginx
# 正式環境
server {
    listen 443 ssl http2;
    server_name myapp.com;

    ssl_certificate /etc/letsencrypt/live/myapp.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/myapp.com/privkey.pem;
    include snippets/ssl-params.conf;

    location / {
        proxy_pass http://production_backend;
        include snippets/proxy-params.conf;
    }
}

# 測試環境 — 加上密碼保護
server {
    listen 443 ssl http2;
    server_name staging.myapp.com;

    ssl_certificate /etc/letsencrypt/live/staging.myapp.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/staging.myapp.com/privkey.pem;
    include snippets/ssl-params.conf;

    # 密碼保護
    auth_basic "Staging Environment";
    auth_basic_user_file /etc/nginx/.htpasswd;

    # 加上 robots 禁止搜尋引擎索引
    add_header X-Robots-Tag "noindex, nofollow" always;

    location / {
        proxy_pass http://staging_backend;
        include snippets/proxy-params.conf;
    }
}

# 開發環境 — IP 限制 + 密碼保護
server {
    listen 443 ssl http2;
    server_name dev.myapp.com;

    ssl_certificate /etc/letsencrypt/live/dev.myapp.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dev.myapp.com/privkey.pem;
    include snippets/ssl-params.conf;

    # 只允許公司 IP
    allow 203.0.113.0/24;
    deny all;

    auth_basic "Development Environment";
    auth_basic_user_file /etc/nginx/.htpasswd;

    add_header X-Robots-Tag "noindex, nofollow" always;

    location / {
        proxy_pass http://dev_backend;
        include snippets/proxy-params.conf;
    }
}
```

---

## 11.5 情境：API Gateway 模式

### 需求

多個微服務共用一個域名入口

```nginx
upstream user_service {
    least_conn;
    server 10.0.1.10:3001 max_fails=3 fail_timeout=30s;
    server 10.0.1.11:3001 max_fails=3 fail_timeout=30s;
    keepalive 16;
}

upstream order_service {
    least_conn;
    server 10.0.2.10:3002 max_fails=3 fail_timeout=30s;
    server 10.0.2.11:3002 max_fails=3 fail_timeout=30s;
    keepalive 16;
}

upstream product_service {
    least_conn;
    server 10.0.3.10:3003 max_fails=3 fail_timeout=30s;
    server 10.0.3.11:3003 max_fails=3 fail_timeout=30s;
    keepalive 16;
}

# API 速率限制
limit_req_zone $binary_remote_addr zone=api_limit:10m rate=30r/s;

server {
    listen 443 ssl http2;
    server_name api.myapp.com;

    ssl_certificate /etc/letsencrypt/live/api.myapp.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.myapp.com/privkey.pem;
    include snippets/ssl-params.conf;

    # 全域設定
    limit_req zone=api_limit burst=50 nodelay;
    client_max_body_size 10M;

    # 共用的 proxy 設定
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Request-ID $request_id;

    # 使用者服務
    location /v1/users {
        proxy_pass http://user_service;
        proxy_next_upstream error timeout http_502 http_503;
    }

    # 訂單服務
    location /v1/orders {
        proxy_pass http://order_service;
        proxy_next_upstream error timeout http_502 http_503;
    }

    # 商品服務
    location /v1/products {
        proxy_pass http://product_service;
        proxy_next_upstream error timeout http_502 http_503;

        # 商品列表可以快取
        proxy_cache my_cache;
        proxy_cache_valid 200 5m;
        proxy_cache_key "$request_uri";
        add_header X-Cache-Status $upstream_cache_status;
    }

    # API 版本控制 — 舊版本重導向
    location /v0/ {
        return 301 /v1$request_uri;
    }

    # API 文件
    location /docs {
        alias /var/www/api-docs;
        index index.html;
    }

    # 健康檢查
    location /health {
        access_log off;
        return 200 '{"status":"ok"}';
        add_header Content-Type application/json;
    }
}
```

---

## 11.6 情境：靜態網站 + CDN 加速

```nginx
server {
    listen 443 ssl http2;
    server_name mysite.com;

    ssl_certificate /etc/letsencrypt/live/mysite.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mysite.com/privkey.pem;
    include snippets/ssl-params.conf;

    root /var/www/mysite;
    index index.html;

    # 開啟 gzip 壓縮
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml;
    gzip_min_length 1000;

    # 靜態資源快取策略
    location ~* \.(css|js)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        add_header Vary "Accept-Encoding";
    }

    location ~* \.(jpg|jpeg|png|gif|webp|svg|ico)$ {
        expires 1y;
        add_header Cache-Control "public";
    }

    location ~* \.(woff|woff2|ttf|eot)$ {
        expires 1y;
        add_header Cache-Control "public";
        add_header Access-Control-Allow-Origin "*";
    }

    # HTML — 短時間快取（讓 CDN 能及時更新）
    location ~* \.html$ {
        expires 10m;
        add_header Cache-Control "public, must-revalidate";
    }

    # 錯誤頁面
    error_page 404 /404.html;
    location = /404.html {
        internal;
    }

    # 如果在 CDN 後面，取得真實 IP
    set_real_ip_from 103.21.244.0/22;     # Cloudflare IP 範圍
    set_real_ip_from 103.22.200.0/22;
    set_real_ip_from 103.31.4.0/22;
    set_real_ip_from 104.16.0.0/13;
    set_real_ip_from 104.24.0.0/14;
    set_real_ip_from 108.162.192.0/18;
    set_real_ip_from 131.0.72.0/22;
    set_real_ip_from 141.101.64.0/18;
    set_real_ip_from 162.158.0.0/15;
    set_real_ip_from 172.64.0.0/13;
    set_real_ip_from 173.245.48.0/20;
    set_real_ip_from 188.114.96.0/20;
    set_real_ip_from 190.93.240.0/20;
    set_real_ip_from 197.234.240.0/22;
    set_real_ip_from 198.41.128.0/17;
    real_ip_header CF-Connecting-IP;
}
```

---

## 11.7 情境：維護模式

### 計畫性維護

```nginx
server {
    listen 443 ssl http2;
    server_name myapp.com;

    # ... SSL 設定 ...

    # 維護模式開關（建立 /etc/nginx/maintenance.flag 啟用維護模式）
    set $maintenance 0;

    if (-f /etc/nginx/maintenance.flag) {
        set $maintenance 1;
    }

    # 允許特定 IP 繞過維護模式（例如開發團隊）
    if ($remote_addr = 203.0.113.50) {
        set $maintenance 0;
    }

    if ($maintenance = 1) {
        return 503;
    }

    # 維護頁面
    error_page 503 @maintenance;
    location @maintenance {
        root /var/www/maintenance;
        rewrite ^(.*)$ /maintenance.html break;
        internal;
    }

    # 正常服務設定
    location / {
        proxy_pass http://backend;
        include snippets/proxy-params.conf;
    }
}
```

```bash
# 啟用維護模式
sudo touch /etc/nginx/maintenance.flag
sudo nginx -s reload

# 關閉維護模式
sudo rm /etc/nginx/maintenance.flag
sudo nginx -s reload
```

### 維護頁面範例

```html
<!-- /var/www/maintenance/maintenance.html -->
<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>系統維護中</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            background: #f5f5f5;
            color: #333;
        }
        .container {
            text-align: center;
            padding: 2rem;
        }
        h1 { font-size: 2rem; margin-bottom: 1rem; }
        p { font-size: 1.2rem; color: #666; }
    </style>
</head>
<body>
    <div class="container">
        <h1>系統維護中</h1>
        <p>我們正在進行系統升級，預計將於 30 分鐘內恢復。</p>
        <p>造成不便，敬請見諒。</p>
    </div>
</body>
</html>
```

---

## 11.8 情境：A/B Testing 與灰度發布

### 依 Cookie 分流

```nginx
# 根據 cookie 決定流向哪個版本
map $cookie_ab_version $backend {
    "v2"    backend_v2;
    default backend_v1;
}

upstream backend_v1 {
    server 10.0.1.10:3000;
    server 10.0.1.11:3000;
}

upstream backend_v2 {
    server 10.0.2.10:3000;
    server 10.0.2.11:3000;
}

server {
    listen 443 ssl http2;
    server_name myapp.com;

    location / {
        proxy_pass http://$backend;
        include snippets/proxy-params.conf;
    }
}
```

### 依百分比分流（灰度發布）

```nginx
# 使用 split_clients 做百分比分流
split_clients "${remote_addr}${uri}" $variant {
    10%     "new";      # 10% 的流量到新版本
    *       "old";      # 90% 的流量到舊版本
}

upstream old_version {
    server 10.0.1.10:3000;
}

upstream new_version {
    server 10.0.2.10:3000;
}

server {
    listen 443 ssl http2;
    server_name myapp.com;

    location / {
        if ($variant = "new") {
            proxy_pass http://new_version;
        }
        proxy_pass http://old_version;
        include snippets/proxy-params.conf;

        # 加上標頭方便追蹤
        add_header X-Variant $variant;
    }
}
```

---

## 11.9 情境：檔案下載伺服器

```nginx
server {
    listen 443 ssl http2;
    server_name dl.mysite.com;

    # ... SSL 設定 ...

    root /var/www/downloads;

    # 開啟目錄列表
    location / {
        autoindex on;
        autoindex_exact_size off;    # 顯示人類可讀的檔案大小
        autoindex_localtime on;      # 顯示本地時間
        autoindex_format html;
    }

    # 大檔案下載優化
    location ~* \.(zip|tar|gz|iso|dmg)$ {
        # 使用 sendfile 直接從核心傳送
        sendfile on;
        tcp_nopush on;

        # 支援斷點續傳
        max_ranges 1;

        # 限制下載速度（防止頻寬被單一用戶佔滿）
        limit_rate 5m;              # 每秒 5MB
        limit_rate_after 100m;      # 前 100MB 不限速

        # 限制每個 IP 的同時下載數
        limit_conn conn_per_ip 3;
    }
}
```

---

## 11.10 情境：多語系網站路由

```nginx
# 根據瀏覽器語言自動重導向
map $http_accept_language $lang {
    default en;
    ~^zh    zh;
    ~^ja    ja;
    ~^ko    ko;
}

server {
    listen 443 ssl http2;
    server_name mysite.com;

    # 首頁根據語言重導向
    location = / {
        return 302 /$lang/;
    }

    location /zh/ {
        alias /var/www/mysite/zh/;
        try_files $uri $uri/ /zh/index.html;
    }

    location /en/ {
        alias /var/www/mysite/en/;
        try_files $uri $uri/ /en/index.html;
    }

    location /ja/ {
        alias /var/www/mysite/ja/;
        try_files $uri $uri/ /ja/index.html;
    }
}
```

---

## 11.11 本章小結

- 前後端分離的 SPA 部署是最常見的場景，`try_files` 是關鍵
- WordPress 等 PHP 網站需要注意安全性設定
- 多環境部署要做好存取控制，避免測試環境被搜尋引擎收錄
- API Gateway 模式讓 Nginx 成為微服務的統一入口
- 維護模式可以透過檔案旗標快速切換
- 灰度發布與 A/B Testing 讓部署更安全

---

> 上一章：[上線問題排查](./10-troubleshooting.md) | 下一章：[高可用架構與容災設計](./12-high-availability.md)
