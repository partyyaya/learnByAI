# 第八章：安全性設定與防護

## 8.1 安全防護總覽

```
安全防護面向
├── 隱藏伺服器資訊
├── 安全標頭設定
├── 速率限制（Rate Limiting）
├── IP 存取控制
├── 防止常見攻擊
│   ├── DDoS 防護
│   ├── SQL Injection 過濾
│   ├── XSS 防護
│   └── 目錄遍歷防護
├── 檔案上傳限制
└── SSL 安全強化
```

---

## 8.2 隱藏伺服器資訊

```nginx
http {
    # 隱藏 Nginx 版本號
    server_tokens off;

    # 隱藏後端伺服器資訊
    proxy_hide_header X-Powered-By;
    proxy_hide_header Server;

    # 自訂 Server 標頭（需要 headers-more 模組）
    # more_set_headers "Server: MyServer";
}
```

---

## 8.3 安全標頭設定

```nginx
server {
    # 防止點擊劫持（Clickjacking）
    add_header X-Frame-Options "SAMEORIGIN" always;

    # 防止 MIME 類型嗅探
    add_header X-Content-Type-Options "nosniff" always;

    # XSS 防護
    add_header X-XSS-Protection "1; mode=block" always;

    # 強制 HTTPS（HSTS）
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;

    # 控制 Referer 資訊
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # 權限政策
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;

    # 內容安全策略（CSP）
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.example.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' https://fonts.gstatic.com;" always;
}
```

### 建立安全標頭片段

```nginx
# /etc/nginx/snippets/security-headers.conf
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-XSS-Protection "1; mode=block" always;
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;

# 使用方式
server {
    include snippets/security-headers.conf;
    # ...
}
```

---

## 8.4 速率限制（Rate Limiting）

防止暴力攻擊與 DDoS：

```nginx
http {
    # 定義限制區域：每個 IP 每秒 10 個請求
    limit_req_zone $binary_remote_addr zone=general:10m rate=10r/s;

    # API 限制：每個 IP 每秒 5 個請求
    limit_req_zone $binary_remote_addr zone=api:10m rate=5r/s;

    # 登入限制：每個 IP 每分鐘 5 個請求
    limit_req_zone $binary_remote_addr zone=login:10m rate=5r/m;

    # 連線數限制
    limit_conn_zone $binary_remote_addr zone=conn_per_ip:10m;

    # 自訂超出限制的回應
    limit_req_status 429;
    limit_conn_status 429;

    server {
        listen 80;
        server_name myapp.com;

        # 一般頁面
        location / {
            limit_req zone=general burst=20 nodelay;
            limit_conn conn_per_ip 50;
            # ...
        }

        # API 端點
        location /api/ {
            limit_req zone=api burst=10 nodelay;
            # ...
        }

        # 登入頁面（嚴格限制）
        location /login {
            limit_req zone=login burst=3 nodelay;
            # ...
        }
    }
}
```

### 參數說明

```
rate=10r/s      每秒最多 10 個請求
burst=20        允許瞬間超過 rate 的請求數（排隊等待）
nodelay         burst 中的請求立即處理，不排隊（超過 burst 才拒絕）
```

### 依據不同條件限制

```nginx
# 排除白名單 IP
geo $limit {
    default 1;
    10.0.0.0/8 0;      # 內網不限制
    192.168.0.0/16 0;   # 內網不限制
}

map $limit $limit_key {
    0 "";               # 空字串 = 不限制
    1 $binary_remote_addr;
}

limit_req_zone $limit_key zone=api:10m rate=10r/s;
```

---

## 8.5 IP 存取控制

```nginx
# 允許 / 拒絕特定 IP
location /admin/ {
    allow 10.0.0.0/8;       # 允許內網
    allow 203.0.113.50;     # 允許特定 IP
    deny all;               # 拒絕其他所有
    # ...
}

# 封鎖惡意 IP
# /etc/nginx/conf.d/blocked-ips.conf
deny 1.2.3.4;
deny 5.6.7.0/24;

# 在 http 或 server 區塊中引入
include /etc/nginx/conf.d/blocked-ips.conf;
```

### GeoIP 限制（依國家/地區）

```nginx
# 需要 ngx_http_geoip2_module

# 載入 GeoIP2 資料庫
geoip2 /usr/share/GeoIP/GeoLite2-Country.mmdb {
    auto_reload 5m;
    $geoip2_metadata_country_build metadata build_epoch;
    $geoip2_data_country_code default=US source=$remote_addr country iso_code;
}

# 封鎖特定國家
map $geoip2_data_country_code $allowed_country {
    default yes;
    CN no;
    RU no;
}

server {
    if ($allowed_country = no) {
        return 403;
    }
}
```

---

## 8.6 防止常見攻擊

### 防止目錄遍歷

```nginx
# 關閉目錄列表
autoindex off;

# 防止存取隱藏檔案
location ~ /\. {
    deny all;
    access_log off;
    log_not_found off;
}

# 防止存取敏感檔案
location ~* \.(env|git|svn|htpasswd|htaccess|bak|swp|old|orig|log|sql)$ {
    deny all;
    access_log off;
    log_not_found off;
}
```

### 防止 HTTP Request Smuggling

```nginx
# 嚴格解析 HTTP 請求
ignore_invalid_headers on;

# 限制標頭大小
large_client_header_buffers 4 8k;
client_header_buffer_size 1k;
```

### 防止過大的請求

```nginx
server {
    # 限制請求體大小（防止大檔案攻擊）
    client_max_body_size 10M;

    # 限制標頭大小
    large_client_header_buffers 4 16k;

    # 超時設定（防止慢速攻擊 Slowloris）
    client_body_timeout 10s;
    client_header_timeout 10s;
    send_timeout 10s;
}
```

### 防止 Slowloris 攻擊

```nginx
http {
    # 限制每個 IP 的連線數
    limit_conn_zone $binary_remote_addr zone=conn_limit:10m;

    server {
        limit_conn conn_limit 20;      # 每個 IP 最多 20 個同時連線

        # 嚴格的超時設定
        client_body_timeout 5s;
        client_header_timeout 5s;
        keepalive_timeout 30s;

        # 限制 Keep-Alive 請求數
        keepalive_requests 100;
    }
}
```

---

## 8.7 HTTP Basic Authentication

```bash
# 安裝密碼工具
sudo apt install apache2-utils -y

# 建立密碼檔案
sudo htpasswd -c /etc/nginx/.htpasswd admin
# 輸入密碼

# 新增更多使用者
sudo htpasswd /etc/nginx/.htpasswd user2
```

```nginx
# 保護特定路徑
location /admin/ {
    auth_basic "Restricted Area";
    auth_basic_user_file /etc/nginx/.htpasswd;

    # 搭配 IP 限制
    satisfy any;                    # any = IP 或密碼其一即可
    allow 10.0.0.0/8;
    deny all;
    auth_basic "Restricted Area";
    auth_basic_user_file /etc/nginx/.htpasswd;
}

# 排除特定路徑（如健康檢查）
location /admin/health {
    auth_basic off;
    return 200 'OK';
}
```

---

## 8.8 防盜連（Hotlink Protection）

```nginx
# 防止其他網站直接引用你的圖片
location ~* \.(jpg|jpeg|png|gif|webp|svg)$ {
    valid_referers none blocked server_names
        *.mysite.com
        mysite.com;

    if ($invalid_referer) {
        return 403;
        # 或者導向一張預設圖片
        # rewrite ^/.*$ /images/hotlink-denied.jpg last;
    }

    expires 30d;
}
```

---

## 8.9 實際情境

### 情境一：網站遭受 DDoS 攻擊

**症狀**：網站無法訪問，伺服器 CPU 和頻寬飆高

```nginx
# 1. 緊急限流
http {
    limit_req_zone $binary_remote_addr zone=emergency:20m rate=2r/s;
    limit_conn_zone $binary_remote_addr zone=emergency_conn:20m;

    server {
        limit_req zone=emergency burst=5 nodelay;
        limit_conn emergency_conn 10;

        # 快速拒絕可疑請求
        if ($http_user_agent ~* (bot|crawler|spider|scraper)) {
            return 403;
        }

        # 封鎖最頻繁的攻擊 IP
        include /etc/nginx/conf.d/blocked-ips.conf;
    }
}
```

```bash
# 2. 找出攻擊來源 IP
awk '{print $1}' /var/log/nginx/access.log | sort | uniq -c | sort -rn | head -20

# 3. 封鎖惡意 IP
echo "deny 1.2.3.4;" >> /etc/nginx/conf.d/blocked-ips.conf
sudo nginx -t && sudo nginx -s reload

# 4. 如果攻擊量大，考慮使用 CDN（如 Cloudflare）
```

### 情境二：發現有人在暴力破解登入

**症狀**：日誌中大量 POST /login 請求

```nginx
# 嚴格限制登入頁面
limit_req_zone $binary_remote_addr zone=login:10m rate=3r/m;

location /login {
    limit_req zone=login burst=5 nodelay;

    # 失敗回應延遲（讓暴力破解更慢）
    # 這需要搭配後端實作
    proxy_pass http://backend;
}
```

```bash
# 分析登入日誌
grep "POST /login" /var/log/nginx/access.log | awk '{print $1}' | sort | uniq -c | sort -rn | head -10

# 使用 fail2ban 自動封鎖
# /etc/fail2ban/jail.local
# [nginx-login]
# enabled = true
# filter = nginx-login
# logpath = /var/log/nginx/access.log
# maxretry = 5
# findtime = 300
# bantime = 3600
```

### 情境三：敏感資料外洩

**問題**：使用者可以存取 `.env`、`.git`、備份檔案等

```nginx
# 封鎖所有敏感檔案
location ~ /\.(env|git|svn|DS_Store) {
    deny all;
    return 404;
}

location ~ \.(sql|bak|old|orig|swp|swo|tmp)$ {
    deny all;
    return 404;
}

# 封鎖版本控制目錄
location ~ /\.(git|svn|hg)/ {
    deny all;
    return 404;
}

# 封鎖設定檔
location ~ /(composer\.json|package\.json|Makefile|Dockerfile) {
    deny all;
    return 404;
}
```

---

## 8.10 安全性檢查清單

```
□ 隱藏 Nginx 版本號（server_tokens off）
□ 設定安全標頭（X-Frame-Options, CSP, HSTS 等）
□ 啟用速率限制（Rate Limiting）
□ 限制請求體大小（client_max_body_size）
□ 設定超時時間，防止慢速攻擊
□ 封鎖敏感檔案存取（.env, .git 等）
□ 關閉目錄列表（autoindex off）
□ 管理後台加上 IP 限制或密碼保護
□ SSL 設定使用強加密套件
□ 啟用 HSTS
□ 定期更新 Nginx 到最新版本
□ 日誌監控異常請求
□ 設定 fail2ban 自動封鎖惡意 IP
```

---

## 8.11 本章小結

- 安全性是分層防護，沒有單一萬能的解決方案
- 速率限制是最基本也最有效的防護手段
- 安全標頭可以防止許多常見的前端攻擊
- 封鎖敏感檔案存取，避免資訊外洩
- 使用 fail2ban 自動化封鎖惡意 IP
- 定期檢查安全設定並保持 Nginx 更新

---

> 上一章：[效能優化與快取策略](./07-performance.md) | 下一章：[日誌管理與監控](./09-logging-monitoring.md)
