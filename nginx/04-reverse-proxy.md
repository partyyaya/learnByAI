# 第四章：反向代理（Reverse Proxy）

## 4.1 什麼是反向代理？

反向代理是指客戶端不直接連接後端伺服器，而是透過 Nginx 作為中間層來轉發請求。

```
正向代理（Forward Proxy）：
  客戶端 → [代理伺服器] → 目標伺服器
  （客戶端知道目標伺服器，代理幫客戶端發請求）

反向代理（Reverse Proxy）：
  客戶端 → [Nginx 反向代理] → 後端伺服器
  （客戶端不知道後端伺服器，以為 Nginx 就是伺服器）
```

> **為什麼正向代理客戶端「知道」目標伺服器，反向代理卻「不知道」？**
>
> 關鍵在於：**代理是誰主動設定的、代替誰工作。**
>
> **正向代理 — 代理站在客戶端這邊**
> 是客戶端自己決定要透過代理存取目標。例如你在公司透過 VPN/Proxy 上 Google，
> 你很清楚你要存取的是 `google.com`，只是請代理幫你發出請求。
> ```
> 你（客戶端）："幫我去 google.com 拿資料"  ← 你知道目標是誰
> 代理伺服器：收到，我去幫你拿              ← 代理代替你發請求
> Google：（只看到代理的 IP，不知道你是誰）
> ```
>
> **反向代理 — 代理站在伺服器這邊**
> 是伺服器端部署的，客戶端完全不知道背後的架構。例如你打開 `example.com`，
> 你以為在跟 `example.com` 溝通，實際上 Nginx 把請求轉發給了後面的 Node.js、Java 等服務。
> ```
> 你（客戶端）：我要存取 example.com         ← 你不知道背後有誰
> Nginx（反向代理）：我幫你轉給後端 :3000    ← 代理代替伺服器接客
> 後端伺服器：（客戶端完全看不到我）
> ```
>
> 一句話總結：**正向代理隱藏客戶端身份，反向代理隱藏伺服器身份。**

### 為什麼需要反向代理？

| 用途 | 說明 |
|------|------|
| 隱藏後端 | 客戶端看不到後端伺服器的真實 IP 和 port |
| 負載均衡 | 將請求分散到多台後端伺服器 |
| SSL 終止 | 由 Nginx 處理 HTTPS，後端只需處理 HTTP |
| 快取加速 | 快取後端回應，減少後端壓力 |
| 安全防護 | 在前端層做速率限制、WAF 等防護 |
| 統一入口 | 多個微服務共用同一個域名 |

---

## 4.2 基本反向代理設定

### 代理到本地應用程式

```nginx
server {
    listen 80;
    server_name myapp.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;

        # 傳遞重要的標頭資訊
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### proxy_pass 的斜線問題（非常重要！）

```nginx
# 情境：請求 /api/users

# 有尾斜線 — 會去掉匹配的前綴
location /api/ {
    proxy_pass http://localhost:3000/;
    # 結果：轉發到 http://localhost:3000/users
}

# 無尾斜線 — 保留完整路徑
location /api/ {
    proxy_pass http://localhost:3000;
    # 結果：轉發到 http://localhost:3000/api/users
}

# 帶路徑且有尾斜線
location /api/ {
    proxy_pass http://localhost:3000/v2/;
    # 結果：轉發到 http://localhost:3000/v2/users
}
```

> **記住**：`proxy_pass` 有沒有尾斜線，行為完全不同！這是最常見的踩坑點。

---

## 4.3 完整的反向代理設定模板

```nginx
server {
    listen 80;
    server_name myapp.com;

    # 客戶端請求體大小限制
    client_max_body_size 50M;

    # 代理逾時設定
    proxy_connect_timeout 60s;
    proxy_send_timeout 60s;
    proxy_read_timeout 60s;

    # 代理緩衝區
    proxy_buffering on;
    proxy_buffer_size 4k;
    proxy_buffers 8 4k;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;

        # 標頭設定
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Port $server_port;

        # WebSocket 支援
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # 不修改後端回傳的重導向 URL
        proxy_redirect off;
    }
}
```

---

## 4.4 常見的代理場景

### 場景一：前後端分離（SPA + API）

```nginx
server {
    listen 80;
    server_name myapp.com;

    # 前端靜態檔案
    location / {
        root /var/www/myapp/dist;
        index index.html;
        try_files $uri $uri/ /index.html;  # SPA 路由支援
    }

    # API 請求轉發到後端
    location /api/ {
        proxy_pass http://localhost:8080/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # 靜態資源快取
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
        root /var/www/myapp/dist;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
}
```

### 場景二：微服務架構路由

```nginx
server {
    listen 80;
    server_name api.myapp.com;

    # 使用者服務
    location /users/ {
        proxy_pass http://localhost:3001/;
        include snippets/proxy-params.conf;
    }

    # 訂單服務
    location /orders/ {
        proxy_pass http://localhost:3002/;
        include snippets/proxy-params.conf;
    }

    # 商品服務
    location /products/ {
        proxy_pass http://localhost:3003/;
        include snippets/proxy-params.conf;
    }

    # 付款服務
    location /payments/ {
        proxy_pass http://localhost:3004/;
        include snippets/proxy-params.conf;
    }
}
```

```nginx
# /etc/nginx/snippets/proxy-params.conf
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_connect_timeout 30s;
proxy_read_timeout 30s;
```

### 場景三：WebSocket 代理

```nginx
# 地圖 - 根據 Upgrade 標頭決定 Connection 值
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name ws.myapp.com;

    location /ws/ {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;

        # WebSocket 連線通常持續較久
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

### 場景四：代理到外部服務

```nginx
server {
    listen 80;
    server_name myapp.com;

    # 代理到外部 API（例如避免前端 CORS 問題）
    location /external-api/ {
        proxy_pass https://api.external-service.com/;
        proxy_set_header Host api.external-service.com;
        proxy_set_header Accept-Encoding "";
        proxy_ssl_server_name on;  # 使用 SNI
    }
}
```

---

## 4.5 proxy_set_header 詳解

```nginx
# 為什麼需要設定這些標頭？

# 1. Host — 讓後端知道原始請求的域名
proxy_set_header Host $host;
# 如果不設定，後端收到的 Host 會是 proxy_pass 的地址（如 localhost:3000）

# 2. X-Real-IP — 傳遞客戶端真實 IP
proxy_set_header X-Real-IP $remote_addr;
# 如果不設定，後端看到的 IP 都是 Nginx 的 IP（如 127.0.0.1）

# 3. X-Forwarded-For — 記錄整個代理鏈的 IP
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
# 格式：client_ip, proxy1_ip, proxy2_ip

# 4. X-Forwarded-Proto — 傳遞原始協定
proxy_set_header X-Forwarded-Proto $scheme;
# 讓後端知道客戶端用的是 http 還是 https
```

---

## 4.6 實際情境與問題排查

### 情境一：502 Bad Gateway

**問題**：Nginx 回傳 502 錯誤

```bash
# 排查步驟：

# 1. 確認後端服務是否在運行
curl http://localhost:3000/health

# 2. 確認後端 port 是否正確
sudo ss -tlnp | grep 3000

# 3. 檢查 Nginx 錯誤日誌
tail -f /var/log/nginx/error.log
# 常見訊息：
# connect() failed (111: Connection refused)    → 後端沒啟動
# connect() failed (113: No route to host)      → 網路不通
# upstream prematurely closed connection         → 後端崩潰了

# 4. 檢查 SELinux（CentOS）
# SELinux 可能阻止 Nginx 連接到後端 port
sudo setsebool -P httpd_can_network_connect 1
```

### 情境二：代理後遺失客戶端 IP

**問題**：後端應用程式的日誌中，所有請求的 IP 都是 `127.0.0.1`

```nginx
# Nginx 設定加上標頭
location / {
    proxy_pass http://localhost:3000;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

```javascript
// Node.js/Express 後端讀取真實 IP
app.set('trust proxy', true);
const clientIP = req.headers['x-real-ip'] || req.ip;
```

### 情境三：413 Request Entity Too Large

**問題**：上傳檔案時出現 413 錯誤

```nginx
server {
    # 調整客戶端請求體大小限制
    client_max_body_size 100M;

    # 如果上傳檔案很大，也要調整超時時間
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;

    location /upload {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;

        # 暫存大型請求
        client_body_buffer_size 128k;
        client_body_temp_path /tmp/nginx_upload;
    }
}
```

### 情境四：代理後 CSS/JS 路徑錯誤

**問題**：網頁能打開但 CSS/JS 載入失敗，因為路徑不正確

```nginx
# 問題：後端應用程式生成的 URL 指向 localhost:3000
# 解決：使用 proxy_redirect 和 sub_filter

location / {
    proxy_pass http://localhost:3000;
    proxy_set_header Host $host;

    # 修正後端回傳的 redirect URL
    proxy_redirect http://localhost:3000/ /;

    # 修正回應 body 中的 URL（需要 ngx_http_sub_module）
    sub_filter 'http://localhost:3000' '';
    sub_filter_once off;
    sub_filter_types text/html text/css application/javascript;
}
```

### 情境五：CORS 跨域問題

**問題**：前端請求 API 時出現 CORS 錯誤

```nginx
location /api/ {
    proxy_pass http://localhost:3000/;

    # 添加 CORS 標頭
    add_header 'Access-Control-Allow-Origin' '$http_origin' always;
    add_header 'Access-Control-Allow-Methods' 'GET, POST, PUT, DELETE, OPTIONS' always;
    add_header 'Access-Control-Allow-Headers' 'Authorization, Content-Type, Accept' always;
    add_header 'Access-Control-Allow-Credentials' 'true' always;

    # 處理 OPTIONS 預檢請求
    if ($request_method = 'OPTIONS') {
        add_header 'Access-Control-Allow-Origin' '$http_origin';
        add_header 'Access-Control-Allow-Methods' 'GET, POST, PUT, DELETE, OPTIONS';
        add_header 'Access-Control-Allow-Headers' 'Authorization, Content-Type, Accept';
        add_header 'Access-Control-Max-Age' 86400;
        add_header 'Content-Length' 0;
        return 204;
    }
}
```

---

## 4.7 本章小結

- 反向代理是 Nginx 最核心的功能之一
- `proxy_pass` 的尾斜線會影響路徑轉發行為，務必注意
- 設定 `proxy_set_header` 傳遞客戶端真實資訊給後端
- WebSocket 需要額外設定 `Upgrade` 和 `Connection` 標頭
- 502 是最常見的反向代理錯誤，通常是後端服務未啟動
- 上傳檔案記得調整 `client_max_body_size`

---

> 上一章：[虛擬主機設定](./03-virtual-host.md) | 下一章：[負載均衡](./05-load-balancing.md)
