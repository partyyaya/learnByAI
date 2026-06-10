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
        proxy_pass http://localhost:3000;  # 轉發目的地：本機 3000 port 的後端服務
        proxy_http_version 1.1;            # 與後端改用 HTTP/1.1（預設是 1.0）

        # 傳遞重要的標頭資訊（各標頭的詳細說明見 4.5）
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

> **`proxy_http_version 1.1;` 為什麼幾乎都要加？**
>
> - Nginx 與後端溝通時，預設使用 HTTP/1.0。
> - HTTP/1.0 不支援連線重用（keep-alive），每個請求都要重新建立 TCP 連線；也不支援 `Upgrade` 機制。
> - 因此只要用到 upstream keepalive（第五章）或 WebSocket（本章場景三），就必須是 1.1；一般反向代理也建議統一加上。

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

    # 客戶端請求體大小限制（預設只有 1m；超過直接回 413）
    client_max_body_size 50M;

    # 代理逾時設定
    proxy_connect_timeout 60s;  # 與後端「建立連線」的逾時
    proxy_send_timeout 60s;     # 向後端「送出請求」時，兩次寫入之間的逾時
    proxy_read_timeout 60s;     # 等待後端「回應」時，兩次讀取之間的逾時

    # 代理緩衝區
    proxy_buffering on;    # 啟用回應緩衝（預設即為 on）
    proxy_buffer_size 4k;  # 存放「回應開頭（標頭）」的緩衝區大小
    proxy_buffers 8 4k;    # 存放「回應主體」的緩衝區：8 個 × 4k = 每條連線最多 32k

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;

        # 標頭設定（前四個的詳細說明見 4.5）
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;          # 原始請求的域名（部分框架讀這個而非 Host）
        proxy_set_header X-Forwarded-Port $server_port;   # 原始請求的 port（讓後端能組出正確的對外 URL）

        # WebSocket 支援（寫死 "upgrade" 的取捨見下方說明）
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # 不修改後端回傳的重導向 URL
        proxy_redirect off;
    }
}
```

### 這段指令在做什麼？（逐條）

- `client_max_body_size 50M;`
  - 限制客戶端請求主體（上傳檔案、POST body）的最大大小。
  - **預設值只有 `1m`**，有檔案上傳功能幾乎一定要調大；超過限制時 Nginx 直接回 `413 Request Entity Too Large`，請求根本不會送到後端（排查見 4.6 情境三）。
  - 設 `0` 代表不限制，但會失去對惡意大請求的保護，不建議。
- `proxy_connect_timeout 60s;`
  - Nginx 與後端「建立 TCP 連線」的逾時，超過回 502。
  - 預設 60s，且官方規定**不能超過 75s**。同機房的後端通常 3~10 秒內連得上，實務常設更短（如 `5s`）讓故障盡早暴露。
- `proxy_send_timeout 60s;` / `proxy_read_timeout 60s;`
  - 注意計時對象：是「**兩次成功寫入／讀取之間**」的間隔，不是整個請求或回應的總時間。
  - 只要後端持續有資料往來，連線就不會被切斷；後端「完全沒回應」超過 `proxy_read_timeout` 才會逾時（回 504）。
  - 預設皆為 60s；慢查詢 API、檔案上傳、長輪詢等場景需要調大（見 4.6 情境三的 `300s`）。
- `proxy_buffering on;`
  - 開啟時：Nginx 盡快把後端的回應「整個收進緩衝區」，讓後端早點釋放連線，再由 Nginx 慢慢回給（可能網速很慢的）客戶端——這能避免慢客戶端長時間拖住後端。
  - 預設就是 `on`；設 `off` 時改為逐段即時轉發，適合 SSE、串流回應等需要「邊產生邊送」的場景，代價是後端連線會被慢客戶端佔住。
- `proxy_buffer_size 4k;`
  - 回應「第一段」的緩衝區，實務上就是放**回應標頭**的空間。預設為一個記憶體分頁（依平台為 4k 或 8k）。
  - 若後端回應標頭很大（例如塞了大量 `Set-Cookie` 或 JWT），會出現 `upstream sent too big header` 錯誤（502），此時需調大（如 `16k`）。
- `proxy_buffers 8 4k;`
  - 格式是「**數量 × 單個大小**」：8 個 × 4k = 這條連線最多用 32k 記憶體緩衝回應主體。預設值是 `8 4k`（或 `8 8k`，依平台）。
  - 怎麼估：讓「數量 × 大小」≥ 你的常見回應大小。例如 API 回應多在 100KB 以內，可設 `16 8k`（= 128k）。
  - 回應超過緩衝區總量也不會出錯：多出來的部分會寫到磁碟暫存檔（由 `proxy_max_temp_file_size` 控制，預設 1024m），只是多了磁碟 I/O、變慢。
  - 注意這是「每條連線」的用量：高併發時記憶體消耗 ≈ 併發連線數 × 32k，不要無腦調太大。
- `proxy_set_header Upgrade` / `Connection "upgrade"`
  - 讓 WebSocket 升級請求能透傳到後端（原理見場景三）。
  - 注意：這裡把 `Connection` **寫死成 `"upgrade"`**，代表「所有」經過的請求都聲稱要升級，部分後端框架可能誤判。更精確的做法是用 `map` 動態決定（場景三），純 HTTP API 則可直接拿掉這兩行。
- `proxy_redirect off;`
  - 控制 Nginx 是否改寫後端回應中的 `Location` / `Refresh` 轉址標頭。
  - 預設值是 `proxy_redirect default`：自動把標頭裡的 `proxy_pass` 位址（如 `http://localhost:3000/`）改寫回對外位址。
  - `off` = 完全不改寫。適用於後端已經能產生正確對外 URL 的情況（例如有正確讀取 `X-Forwarded-*` 標頭）。
  - 若後端會回 `Location: http://localhost:3000/...` 這種內部位址，請不要用 `off`，改用明確改寫（見 4.6 情境四的 `proxy_redirect http://localhost:3000/ /;`）。

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
