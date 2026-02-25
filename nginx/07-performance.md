# 第七章：效能優化與快取策略

## 7.1 Nginx 效能優化總覽

```
優化面向
├── Worker 設定優化
├── 連線處理優化
├── 檔案傳輸優化
├── Gzip / Brotli 壓縮
├── 靜態檔案快取
├── 代理快取（Proxy Cache）
├── 瀏覽器快取策略
└── 系統層級優化（核心參數）
```

---

## 7.2 Worker 與連線優化

```nginx
# /etc/nginx/nginx.conf

# Worker 數量 = CPU 核心數
worker_processes auto;

# 每個 Worker 的最大檔案描述符數
worker_rlimit_nofile 65535;

events {
    # 每個 Worker 的最大連線數
    worker_connections 4096;

    # 使用高效的事件模型
    use epoll;            # Linux
    # use kqueue;         # FreeBSD/macOS

    # 允許一次接受多個新連線
    multi_accept on;
}
```

> **計算最大並發連線數**：worker_processes × worker_connections = 總並發連線數
>
> 例如 4 workers × 4096 connections = 16,384 並發連線

---

## 7.3 檔案傳輸優化

```nginx
http {
    # 使用 sendfile 系統呼叫，避免用戶空間與核心空間的資料複製
    sendfile on;

    # 搭配 sendfile 使用，在一個封包中發送 HTTP 標頭和檔案開頭
    tcp_nopush on;

    # 減少小封包延遲（適合即時互動應用）
    tcp_nodelay on;

    # Keep-Alive 設定
    keepalive_timeout 65;     # 連線保持時間
    keepalive_requests 1000;  # 單一連線最大請求數

    # 隱藏 Nginx 版本號（安全性考量）
    server_tokens off;

    # 減少雜湊表衝突
    types_hash_max_size 4096;
    server_names_hash_bucket_size 128;
}
```

---

## 7.4 Gzip 壓縮

壓縮可以大幅減少傳輸大小，加快頁面載入速度：

```nginx
http {
    # 啟用 Gzip
    gzip on;

    # 最小壓縮大小（小於此值不壓縮）
    gzip_min_length 1000;

    # 壓縮等級（1-9，建議 4-6，越高 CPU 消耗越大）
    gzip_comp_level 5;

    # 需要壓縮的 MIME 類型
    gzip_types
        text/plain
        text/css
        text/javascript
        text/xml
        application/json
        application/javascript
        application/xml
        application/xml+rss
        application/x-javascript
        application/vnd.ms-fontobject
        font/opentype
        image/svg+xml;

    # 對所有代理請求都進行壓縮
    gzip_proxied any;

    # 告訴代理伺服器快取壓縮和非壓縮版本
    gzip_vary on;

    # 禁用對 IE6 的壓縮
    gzip_disable "msie6";

    # 壓縮緩衝區
    gzip_buffers 16 8k;
}
```

### 使用預先壓縮的檔案（gzip_static）

```nginx
# 需要 ngx_http_gzip_static_module

location /assets/ {
    # 如果存在 .gz 檔案，直接使用（不需即時壓縮）
    gzip_static on;
    root /var/www/myapp;
}

# 建置時預先壓縮
# gzip -k -9 /var/www/myapp/assets/*.js
# gzip -k -9 /var/www/myapp/assets/*.css
```

---

## 7.5 瀏覽器快取策略

```nginx
server {
    listen 80;
    server_name myapp.com;
    root /var/www/myapp;

    # HTML — 不快取或短時間快取
    location ~* \.html$ {
        expires -1;
        add_header Cache-Control "no-store, no-cache, must-revalidate";
    }

    # CSS/JS — 使用含 hash 的檔名，長時間快取
    location ~* \.(css|js)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # 圖片 — 中等時間快取
    location ~* \.(jpg|jpeg|png|gif|ico|svg|webp)$ {
        expires 30d;
        add_header Cache-Control "public";
    }

    # 字型 — 長時間快取
    location ~* \.(woff|woff2|ttf|eot)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        add_header Access-Control-Allow-Origin "*";
    }

    # 媒體檔案
    location ~* \.(mp4|webm|ogg|mp3|wav)$ {
        expires 30d;
        add_header Cache-Control "public";
    }
}
```

---

## 7.6 代理快取（Proxy Cache）

當 Nginx 作為反向代理時，可以快取後端回應：

```nginx
http {
    # 定義快取區域
    proxy_cache_path /var/cache/nginx
        levels=1:2                # 目錄層級
        keys_zone=my_cache:10m    # 快取 key 的共享記憶體（10MB，可存約 8 萬個 key）
        max_size=10g              # 最大快取大小
        inactive=60m              # 未被存取超過 60 分鐘則刪除
        use_temp_path=off;        # 不使用暫存路徑

    server {
        listen 80;
        server_name myapp.com;

        location / {
            proxy_pass http://backend;

            # 啟用快取
            proxy_cache my_cache;

            # 快取有效時間
            proxy_cache_valid 200 60m;       # 200 狀態碼快取 60 分鐘
            proxy_cache_valid 301 302 10m;   # 重導向快取 10 分鐘
            proxy_cache_valid 404 1m;        # 404 快取 1 分鐘

            # 快取 key
            proxy_cache_key "$scheme$request_method$host$request_uri";

            # 顯示快取狀態（方便除錯）
            add_header X-Cache-Status $upstream_cache_status;

            # 在後端不可用時使用過期快取
            proxy_cache_use_stale error timeout http_500 http_502 http_503 http_504;

            # 只有一個請求去後端取資料，其他等待
            proxy_cache_lock on;
            proxy_cache_lock_timeout 5s;

            # 最少被請求幾次才快取
            proxy_cache_min_uses 2;

            # 繞過快取的條件
            proxy_cache_bypass $cookie_nocache $arg_nocache;
            proxy_no_cache $cookie_nocache $arg_nocache;
        }

        # API 不快取
        location /api/ {
            proxy_pass http://backend;
            proxy_cache off;
            proxy_no_cache 1;
        }
    }
}
```

### 快取狀態說明

```
X-Cache-Status 值說明：
- MISS    : 快取未命中，從後端取得
- HIT     : 快取命中
- EXPIRED : 快取已過期，從後端重新取得
- STALE   : 使用過期的快取（後端不可用時）
- BYPASS  : 繞過快取
- UPDATING: 快取正在更新中
```

### 手動清除快取

```bash
# 方法一：刪除快取目錄
sudo rm -rf /var/cache/nginx/*
sudo nginx -s reload

# 方法二：使用 proxy_cache_purge 模組（需要額外安裝）
# location ~ /purge(/.*) {
#     allow 127.0.0.1;
#     deny all;
#     proxy_cache_purge my_cache "$scheme$request_method$host$1";
# }
# curl http://myapp.com/purge/path/to/page
```

---

## 7.7 FastCGI 快取（PHP 網站）

```nginx
http {
    fastcgi_cache_path /var/cache/nginx/fastcgi
        levels=1:2
        keys_zone=php_cache:10m
        max_size=5g
        inactive=60m;

    server {
        listen 80;
        server_name mysite.com;
        root /var/www/mysite;

        # 設定不快取的條件
        set $skip_cache 0;

        # POST 請求不快取
        if ($request_method = POST) {
            set $skip_cache 1;
        }

        # 後台頁面不快取
        if ($request_uri ~* "/wp-admin/|/wp-login.php") {
            set $skip_cache 1;
        }

        # 已登入使用者不快取
        if ($http_cookie ~* "wordpress_logged_in") {
            set $skip_cache 1;
        }

        location ~ \.php$ {
            fastcgi_pass unix:/var/run/php/php-fpm.sock;
            fastcgi_index index.php;
            include fastcgi_params;

            # 啟用 FastCGI 快取
            fastcgi_cache php_cache;
            fastcgi_cache_valid 200 60m;
            fastcgi_cache_bypass $skip_cache;
            fastcgi_no_cache $skip_cache;
            fastcgi_cache_key "$scheme$request_method$host$request_uri";

            add_header X-Cache-Status $upstream_cache_status;
        }
    }
}
```

---

## 7.8 系統層級優化

```bash
# /etc/sysctl.conf

# 增加最大檔案描述符數
fs.file-max = 65535

# TCP 連線優化
net.core.somaxconn = 65535
net.core.netdev_max_backlog = 65535
net.ipv4.tcp_max_syn_backlog = 65535

# TCP Keep-Alive
net.ipv4.tcp_keepalive_time = 600
net.ipv4.tcp_keepalive_intvl = 30
net.ipv4.tcp_keepalive_probes = 5

# TCP 緩衝區
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216

# 允許重用 TIME_WAIT 狀態的 socket
net.ipv4.tcp_tw_reuse = 1

# 本地端口範圍
net.ipv4.ip_local_port_range = 1024 65535

# 套用設定
# sudo sysctl -p
```

```bash
# 增加使用者的檔案描述符限制
# /etc/security/limits.conf

www-data soft nofile 65535
www-data hard nofile 65535
```

---

## 7.9 實際情境

### 情境一：網站回應速度慢

**排查流程**：

```bash
# 1. 確認瓶頸在哪裡
# 檢查 Nginx 存取日誌中的 $request_time 和 $upstream_response_time
tail -f /var/log/nginx/access.log

# 如果 upstream_response_time 很高 → 後端問題
# 如果 request_time 高但 upstream_response_time 低 → 網路或 Nginx 設定問題

# 2. 檢查 Nginx worker 連線使用率
# 查看當前活躍連線數
curl http://localhost/nginx_status

# 啟用 stub_status
# location /nginx_status {
#     stub_status;
#     allow 127.0.0.1;
#     deny all;
# }

# 3. 檢查系統資源
top -bn1 | head -20
free -m
df -h
```

### 情境二：靜態資源載入慢

```nginx
# 優化靜態資源服務
location /static/ {
    alias /var/www/myapp/static/;

    # 啟用 sendfile
    sendfile on;
    tcp_nopush on;

    # 長時間快取
    expires max;
    add_header Cache-Control "public, immutable";

    # 開啟 gzip
    gzip on;
    gzip_types text/css application/javascript;

    # 預壓縮
    gzip_static on;

    # 關閉存取日誌（減少 I/O）
    access_log off;
}
```

### 情境三：高流量時 Nginx 報 worker_connections are not enough

```nginx
# 增加 worker_connections
events {
    worker_connections 8192;  # 從 1024 提高到 8192
    multi_accept on;
    use epoll;
}

# 同時增加系統檔案描述符限制
worker_rlimit_nofile 65535;
```

```bash
# 系統層級
sudo sysctl -w fs.file-max=65535
echo "www-data soft nofile 65535" | sudo tee -a /etc/security/limits.conf
echo "www-data hard nofile 65535" | sudo tee -a /etc/security/limits.conf
```

---

## 7.10 效能測試工具

```bash
# Apache Bench（ab）
ab -n 10000 -c 100 http://myapp.com/

# wrk（更現代的工具）
wrk -t4 -c100 -d30s http://myapp.com/

# siege
siege -c 100 -t 30s http://myapp.com/

# 查看結果重點：
# - Requests per second（每秒請求數）
# - Time per request（每個請求的平均時間）
# - Transfer rate（傳輸速率）
# - Failed requests（失敗請求數）
```

---

## 7.11 本章小結

- `worker_processes auto` 和 `worker_connections` 是基本的效能調校
- `sendfile`、`tcp_nopush`、`tcp_nodelay` 是傳輸優化三劍客
- Gzip 壓縮可以減少 60-80% 的傳輸大小
- 靜態資源使用長時間快取搭配檔名 hash 策略
- Proxy Cache 可以大幅減少後端壓力
- 系統層級的核心參數也要一併調整
- 使用效能測試工具驗證優化效果

---

> 上一章：[SSL/HTTPS 設定](./06-ssl-https.md) | 下一章：[安全性設定與防護](./08-security.md)
