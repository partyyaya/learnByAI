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
# 第一個 server：把所有 HTTP（80）流量導向 HTTPS
server {
    listen 80;                              # 監聽 IPv4 的 80 port（HTTP）
    server_name myapp.com;                  # 此站台對應的域名
    return 301 https://$host$request_uri;   # 301 永久重導向到 HTTPS，並保留原始路徑與查詢參數
}

# 第二個 server：真正提供服務的 HTTPS 站台
server {
    listen 443 ssl http2;                   # 監聽 443 port，啟用 SSL 與 HTTP/2（1.25+ 也可改寫成獨立的 http2 on;）
    server_name myapp.com;

    ssl_certificate /etc/letsencrypt/live/myapp.com/fullchain.pem;    # 憑證鏈（站台憑證 + 中繼憑證）
    ssl_certificate_key /etc/letsencrypt/live/myapp.com/privkey.pem;  # 憑證私鑰（檔案權限建議 600）
    include snippets/ssl-params.conf;       # 引入共用 SSL 安全參數（TLS 版本、加密套件、HSTS 等），避免每個站台重複貼一份

    root /var/www/myapp/dist;               # 前端打包輸出目錄（npm run build 的產物）
    index index.html;                       # 預設首頁檔名

    # 前端 SPA — 所有路徑都回傳 index.html
    location / {
        try_files $uri $uri/ /index.html;   # 依序嘗試：實體檔案 → 目錄 → 都沒有就回 index.html（交給前端路由）

        # HTML 不快取（巢狀 location：只攔截 .html 結尾的請求）
        location ~* \.html$ {
            expires -1;                     # 等同 Expires 設為過去時間 + Cache-Control: no-cache，瀏覽器每次都要回源確認
            add_header Cache-Control "no-store, no-cache, must-revalidate";  # 三重保險：不儲存、不用快取、過期必須驗證
        }
    }

    # 靜態資源 — 長時間快取
    location /assets/ {
        expires 1y;                          # 快取一年（打包工具會在檔名加 hash，內容變了檔名就變，不怕快取舊版）
        add_header Cache-Control "public, immutable";  # public：CDN/代理也可快取；immutable：瀏覽器連條件式請求都不發
        access_log off;                      # 靜態資源請求量大、價值低，關閉日誌減少磁碟 I/O
    }

    # API 反向代理
    location /api/ {
        proxy_pass http://localhost:3000/;   # 尾斜線會把 /api/ 前綴去掉：/api/users → 後端收到 /users
        proxy_http_version 1.1;              # 預設是 1.0；1.1 才支援 Keep-Alive 與 chunked 傳輸
        proxy_set_header Host $host;                                  # 把原始 Host 標頭傳給後端（否則後端看到 localhost:3000）
        proxy_set_header X-Real-IP $remote_addr;                      # 客戶端真實 IP（例如 203.0.113.10）
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;  # 累加式 IP 鏈：原有 XFF 後面附加 $remote_addr
        proxy_set_header X-Forwarded-Proto $scheme;                   # 原始協定（https），後端據此產生正確的跳轉/Cookie Secure 屬性

        # 上傳檔案大小限制
        client_max_body_size 50M;            # 請求主體上限；預設僅 1M，上傳大檔不調整會收到 413 Request Entity Too Large
    }

    # WebSocket
    location /ws/ {
        proxy_pass http://localhost:3000/ws/;
        proxy_http_version 1.1;                       # WebSocket 升級握手必須是 HTTP/1.1
        proxy_set_header Upgrade $http_upgrade;       # 轉發客戶端的 Upgrade 標頭（值為 websocket）
        proxy_set_header Connection "upgrade";        # 告知後端要升級協定（預設 Connection 標頭不會被轉發）
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;                     # 讀取逾時拉長到 1 小時；預設 60s 會把閒置的 WebSocket 連線砍掉
    }
}
```

### 這段指令在做什麼？（逐條）

> **HTTP → HTTPS 重導向區塊**
>
> - `return 301 https://$host$request_uri;`
>   - `$host`：請求的 Host 標頭（例如 `myapp.com`）。
>   - `$request_uri`：完整原始 URI 含查詢參數（例如 `/products?page=2`）。
>   - 組合起來：`http://myapp.com/products?page=2` 會被導向 `https://myapp.com/products?page=2`，路徑與參數都不會掉。
>   - 用 `301`（永久）而非 `302`（暫時），瀏覽器與搜尋引擎會記住，之後直接走 HTTPS。
>
> **SPA 路由區塊**
>
> - `try_files $uri $uri/ /index.html;` 是 SPA 部署的核心：
>   - 使用者直接造訪 `/dashboard`（前端路由，磁碟上沒有這個檔案）時，前兩項都找不到，最後回傳 `/index.html`，由前端 JavaScript 接手渲染。
>   - 不加這行，重新整理任何非首頁路徑都會 404。
> - 巢狀的 `location ~* \.html$` 讓 `index.html` 永遠不被快取：
>   - SPA 的 JS/CSS 檔名帶 hash 可以快取一年，但 `index.html` 是「指向最新版檔名」的入口，一旦被快取，使用者就拿不到新版。
>   - `try_files` 內部重導向到 `/index.html` 後，Nginx 會重新匹配 location，最終落入這個巢狀區塊，因此 SPA 入口頁也吃得到不快取的標頭。
>
> **`/api/` 反向代理區塊 — `proxy_pass` 尾斜線是最容易踩的坑**
>
> | 寫法 | 請求 `/api/users` 時後端收到 |
> |---|---|
> | `proxy_pass http://localhost:3000/;`（有尾斜線） | `/users`（`/api/` 被替換掉） |
> | `proxy_pass http://localhost:3000;`（無尾斜線） | `/api/users`（原樣轉發） |
>
> - 兩種都合法，取決於後端路由是否含 `/api` 前綴；寫錯會整批 404。
> - `$proxy_add_x_forwarded_for` 範例值：請求經過 CDN 再到 Nginx 時，可能是 `198.51.100.7, 203.0.113.10`（左邊是最初的客戶端，右邊是上一跳）。
>
> **WebSocket 區塊**
>
> - HTTP 升級成 WebSocket 需要 `Upgrade: websocket` 與 `Connection: upgrade` 兩個標頭，但 Nginx 預設不轉發逐跳（hop-by-hop）標頭，所以必須手動 `proxy_set_header` 補上，否則握手失敗（後端回 400 或連線直接被當一般 HTTP 處理）。
> - `$http_upgrade`：客戶端送來的 `Upgrade` 標頭值；一般 HTTP 請求時為空字串，WebSocket 握手時為 `websocket`。
> - `proxy_read_timeout 3600s;`：WebSocket 常常長時間沒有資料往返，預設 60 秒就會被斷線；依業務閒置時間設定，搭配應用層心跳（ping/pong）更穩。

### 驗證方式

```bash
# 確認設定語法正確後重載
sudo nginx -t && sudo nginx -s reload

# 測試 HTTP 是否正確 301 到 HTTPS（-I 只看標頭）
curl -I http://myapp.com/dashboard
# 預期：HTTP/1.1 301 Moved Permanently、Location: https://myapp.com/dashboard

# 測試 SPA 路由：非實體路徑應回 200（index.html），而不是 404
curl -I https://myapp.com/dashboard

# 測試 index.html 的快取標頭
curl -I https://myapp.com/index.html
# 預期：Cache-Control: no-store, no-cache, must-revalidate

# 測試 API 轉發是否正常（路徑前綴是否如預期被去掉）
curl -i https://myapp.com/api/health
```

### 常見問題

- **重新整理出現 404**：確認有 `try_files $uri $uri/ /index.html`
- **API CORS 錯誤**：確認 `proxy_pass` 的尾斜線設定
- **靜態資源 404**：確認 `root` 路徑正確、`dist` 目錄有內容

---

## 11.3 情境：WordPress / PHP 網站

### 完整設定

```nginx
# 前置需求：速率限制 zone 必須定義在 http 區塊（放在 conf.d/*.conf 的頂層即可）
# 含義：以客戶端 IP 為 key，配置 10MB 共享記憶體，限制每秒最多 1 個請求
limit_req_zone $binary_remote_addr zone=login:10m rate=1r/s;

server {
    listen 443 ssl http2;                   # HTTPS + HTTP/2
    server_name blog.mysite.com;

    ssl_certificate /etc/letsencrypt/live/blog.mysite.com/fullchain.pem;    # 憑證鏈
    ssl_certificate_key /etc/letsencrypt/live/blog.mysite.com/privkey.pem;  # 私鑰
    include snippets/ssl-params.conf;       # 共用 SSL 安全參數

    root /var/www/wordpress;                # WordPress 安裝目錄
    index index.php index.html;             # 先找 index.php（WordPress 入口），再找 index.html

    # WordPress 固定網址（Permalink）
    location / {
        try_files $uri $uri/ /index.php?$args;   # 找不到實體檔案就交給 index.php，並把原始查詢參數帶上
    }

    # 上傳目錄禁止執行 PHP，封死「上傳 webshell 再執行」的攻擊路徑
    # 注意：regex location 之間是「由上而下、先命中先贏」，
    # 這條必須寫在下面的 ~ \.php$ 之前，否則 uploads 下的 PHP 仍會被先命中執行
    location ~* /wp-content/uploads/.*\.php$ {
        deny all;
    }

    # PHP 處理
    location ~ \.php$ {
        include fastcgi_params;             # 引入標準 FastCGI 參數（REQUEST_METHOD、QUERY_STRING 等數十個變數）
        fastcgi_pass unix:/var/run/php/php8.2-fpm.sock;   # 透過 Unix Socket 交給 PHP-FPM（同機通訊比 TCP 快）
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;  # 告訴 PHP-FPM 要執行哪個實體檔案
        fastcgi_index index.php;            # URI 以 / 結尾時，補上的預設腳本名

        # 效能設定
        fastcgi_buffer_size 128k;           # 讀取回應「第一部分」（通常是標頭）的緩衝區；預設 4k/8k，WordPress 標頭多（Cookie、外掛）容易爆
        fastcgi_buffers 4 256k;             # 緩衝回應主體：4 個 × 256k = 最多 1MB 放在記憶體；預設 8 個 4k/8k
        fastcgi_busy_buffers_size 256k;     # 尚未送完給客戶端時，允許「忙碌中」的緩衝上限
        fastcgi_read_timeout 300;           # 等 PHP 回應的逾時秒數；預設 60s，後台匯入/外掛更新等長任務會逾時
    }

    # 靜態資源快取
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
        expires 30d;                        # 瀏覽器快取 30 天
        add_header Cache-Control "public";  # 允許 CDN / 中間代理快取
        access_log off;                     # 靜態資源不寫日誌，降低 I/O
    }

    # 封鎖敏感檔案
    location ~ /\.ht {
        deny all;                           # 拒絕存取 .htaccess / .htpasswd（Apache 遺留檔，內含規則或密碼雜湊）
    }

    location = /wp-config.php {
        deny all;                           # wp-config.php 含資料庫帳密，絕不可被直接存取
    }

    location ~* /wp-content/uploads/.*\.php$ {
        deny all;                           # 上傳目錄禁止執行 PHP，封死「上傳 webshell 再執行」的攻擊路徑
    }

    # 限制 wp-login 登入嘗試
    location = /wp-login.php {
        limit_req zone=login burst=3 nodelay;   # 套用上面定義的 login zone：每秒 1 次、突發最多再容忍 3 次、超過直接回 503
        include fastcgi_params;                 # 精確匹配（=）優先於 regex，不會再進入上面的 \.php$ 區塊，FastCGI 設定要重寫一份
        fastcgi_pass unix:/var/run/php/php8.2-fpm.sock;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    }

    # XML-RPC 防護（常被暴力攻擊）
    location = /xmlrpc.php {
        deny all;                           # 拒絕所有來源
        return 403;                         # 直接回 403（return 會先生效；想更省資源可改 return 444 直接斷線不回應）
    }
}
```

### 這段指令在做什麼？（逐條）

> **固定網址：`try_files $uri $uri/ /index.php?$args;`**
>
> - WordPress 的「好看網址」如 `/2026/06/hello-world/` 在磁碟上並不存在。
> - `$uri`：先試實體檔案（圖片、CSS 等直接命中）；`$uri/`：再試目錄；最後 fallback 到 `/index.php` 由 WordPress 路由。
> - `$args`：原始查詢參數（例如 `?preview=true`），不帶上的話預覽、搜尋等功能會壞掉。
>
> **FastCGI 變數**
>
> - `$document_root`：目前的 `root` 值，這裡是 `/var/www/wordpress`。
> - `$fastcgi_script_name`：請求的腳本路徑，例如 `/index.php`。
> - 兩者相加 = `/var/www/wordpress/index.php`，就是 PHP-FPM 實際執行的檔案。少了這行，PHP-FPM 會回「No input file specified」。
>
> **`limit_req zone=login burst=3 nodelay;` 參數拆解**
>
> - `zone=login`：引用 http 區塊定義的共享記憶體區；**zone 沒定義的話 `nginx -t` 會直接報錯**。
> - `$binary_remote_addr`：IP 的二進位形式（IPv4 僅 4 bytes，比 `$remote_addr` 字串省記憶體）；`10m` 約可記錄 8～16 萬個 IP 的狀態。
> - `rate=1r/s`：穩定速率每秒 1 次——對「人類登入」綽綽有餘，對暴力破解則是災難級限速。
> - `burst=3`：允許短暫突發再排隊 3 個請求（例如手滑連點）。
> - `nodelay`：突發額度內立即處理、不排隊延遲；超過額度直接回 503。
>
> **實務建議**
>
> - 安全區塊（`deny all` 那幾段）建議放在 PHP 處理區塊「之前」閱讀順序上比較直覺，但實際匹配是看 location 優先級：`= /wp-config.php`（精確）與 `~* /wp-content/uploads/.*\.php$`（regex、定義在 `~ \.php$` 之後但⋯）——注意 **regex location 之間是「由上而下，先命中先贏」**，所以 uploads 封鎖必須寫在 `~ \.php$` 之後仍能生效的原因是：本範例中 `~ \.php$` 在前會先命中。若你的環境發現 uploads 下的 PHP 仍被執行，請把 uploads 封鎖規則移到 `~ \.php$` **前面**。
> - 被 `limit_req` 擋下的請求預設回 503，可用 `limit_req_status 429;` 改成語意更精確的 429 Too Many Requests。

### 驗證方式

```bash
# 語法檢查 + 重載
sudo nginx -t && sudo nginx -s reload

# 確認敏感檔案確實被擋（預期 403）
curl -o /dev/null -s -w "%{http_code}\n" https://blog.mysite.com/wp-config.php
curl -o /dev/null -s -w "%{http_code}\n" https://blog.mysite.com/xmlrpc.php

# 快速連打 wp-login.php，確認速率限制生效（預期前幾次 200/302，之後出現 503）
for i in $(seq 1 10); do
  curl -o /dev/null -s -w "%{http_code}\n" https://blog.mysite.com/wp-login.php
done
```

---

## 11.4 情境：多環境部署（開發 / 測試 / 正式）

### 需求

- `dev.myapp.com` → 開發環境
- `staging.myapp.com` → 測試環境
- `myapp.com` → 正式環境

```nginx
# 正式環境 — 對外公開，不加任何存取限制
server {
    listen 443 ssl http2;
    server_name myapp.com;                  # 靠 server_name 區分環境（三個 server 都監聽 443，由 SNI/Host 分流）

    ssl_certificate /etc/letsencrypt/live/myapp.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/myapp.com/privkey.pem;
    include snippets/ssl-params.conf;

    location / {
        proxy_pass http://production_backend;   # 轉發到正式環境 upstream（需另外以 upstream 區塊定義）
        include snippets/proxy-params.conf;     # 共用代理參數（Host、X-Real-IP、X-Forwarded-* 等），抽成檔案避免三份重複
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
    auth_basic "Staging Environment";               # 啟用 HTTP Basic 認證；字串是瀏覽器彈窗顯示的領域名稱（realm）
    auth_basic_user_file /etc/nginx/.htpasswd;      # 帳號密碼檔（htpasswd 工具產生，密碼以雜湊儲存）

    # 加上 robots 禁止搜尋引擎索引
    add_header X-Robots-Tag "noindex, nofollow" always;   # 告訴搜尋引擎不要收錄；always 確保 4xx/5xx 回應也帶這個標頭

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
    allow 203.0.113.0/24;                   # 放行公司網段（CIDR：203.0.113.0 ~ 203.0.113.255）
    deny all;                               # 其餘一律拒絕（403）；allow/deny 由上而下，命中即停止

    auth_basic "Development Environment";   # IP 通過後，還要再過一道密碼（預設 satisfy all = 兩者都要通過）
    auth_basic_user_file /etc/nginx/.htpasswd;

    add_header X-Robots-Tag "noindex, nofollow" always;

    location / {
        proxy_pass http://dev_backend;
        include snippets/proxy-params.conf;
    }
}
```

### 這段指令在做什麼？（逐條）

> **為什麼測試 / 開發環境要層層上鎖？**
>
> - 測試環境常跑著「半成品 + 真實資料的副本」，被搜尋引擎收錄或被外人逛到，輕則洩漏新功能、重則洩漏資料。
> - 三道防線各司其職：
>   - `allow` / `deny`：網路層白名單，連密碼輸入框都看不到。
>   - `auth_basic`：帳號密碼，防止公司網段內的非相關人員誤入。
>   - `X-Robots-Tag`：就算哪天防線被打開，搜尋引擎也不會收錄。
>
> **`allow` / `deny` 評估規則**
>
> - 由上而下逐條比對，**第一條命中的規則決定結果**，後面不再看。
> - 所以 `deny all;` 一定要放在所有 `allow` 之後；順序顛倒會把所有人（包括自己）擋在門外。
>
> **`satisfy` 的兩種模式**
>
> - 預設 `satisfy all;`：IP 限制「和」密碼**都要**通過（本範例 dev 環境的行為）。
> - 改成 `satisfy any;`：IP 在白名單內就免輸密碼，名單外的人輸對密碼也能進——適合「辦公室免登入、在家輸密碼」的需求。
>
> **`add_header ... always` 的 `always` 是什麼？**
>
> - `add_header` 預設只在 200、204、301、302、303、304、307、308 等狀態碼時加標頭。
> - 加上 `always` 後，403、404、500 等錯誤回應也會帶上——對 `X-Robots-Tag` 這種「任何回應都該有」的標頭是必要的。
>
> **前置需求提醒**
>
> - `production_backend`、`staging_backend`、`dev_backend` 需先以 `upstream` 區塊定義（參考 11.5 的寫法），否則 `nginx -t` 會報 `host not found in upstream`。
> - `snippets/proxy-params.conf` 內容通常就是 11.2 中那組 `proxy_http_version` + `proxy_set_header` 指令。

### 建立密碼檔

```bash
# 安裝 htpasswd 工具（Ubuntu/Debian 在 apache2-utils 套件裡）
sudo apt install apache2-utils

# 第一次建立密碼檔：-c 會「建立新檔」，並新增使用者 alice（會互動式詢問密碼）
sudo htpasswd -c /etc/nginx/.htpasswd alice

# 之後新增使用者「不要」再加 -c，否則會覆蓋整個檔案、清掉既有帳號
sudo htpasswd /etc/nginx/.htpasswd bob

# 確認 Nginx 的 worker 使用者讀得到密碼檔（讀不到會整站 500）
sudo chown root:www-data /etc/nginx/.htpasswd
sudo chmod 640 /etc/nginx/.htpasswd
```

### 驗證方式

```bash
# 不帶帳密存取測試環境（預期 401 Unauthorized）
curl -o /dev/null -s -w "%{http_code}\n" https://staging.myapp.com/

# 帶上帳密（預期 200）
curl -u alice:密碼 -o /dev/null -s -w "%{http_code}\n" https://staging.myapp.com/

# 從非白名單 IP 打開發環境（預期 403）
curl -o /dev/null -s -w "%{http_code}\n" https://dev.myapp.com/

# 確認 X-Robots-Tag 標頭有出現（連錯誤頁也要有）
curl -sI https://staging.myapp.com/ | grep -i x-robots-tag
```

---

## 11.5 情境：API Gateway 模式

### 需求

多個微服務共用一個域名入口

```nginx
# ───── upstream：三個微服務各自的伺服器群組（負載均衡） ─────
upstream user_service {
    least_conn;                                        # 負載均衡演算法：把新請求派給「目前連線數最少」的伺服器（適合請求耗時不均的 API）
    server 10.0.1.10:3001 max_fails=3 fail_timeout=30s; # 30 秒內失敗 3 次 → 標記故障、暫停派發 30 秒
    server 10.0.1.11:3001 max_fails=3 fail_timeout=30s; # 第二台，同樣的故障判定條件
    keepalive 16;                                      # 每個 worker 對此 upstream 保留最多 16 條閒置長連線，省去重複 TCP 握手
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

# API 速率限制：以客戶端 IP 為 key，10MB 記憶體存狀態，每 IP 每秒 30 個請求
limit_req_zone $binary_remote_addr zone=api_limit:10m rate=30r/s;

# 前置需求：商品服務要用的快取必須先定義（放在 http 區塊 / conf.d 頂層）
# levels=1:2 兩層目錄避免單目錄檔案過多；keys_zone 名稱 my_cache、索引佔 10MB（約 8 萬個 key）
# max_size=1g 快取總量上限；inactive=60m 超過 60 分鐘沒被存取就淘汰
proxy_cache_path /var/cache/nginx/api levels=1:2 keys_zone=my_cache:10m max_size=1g inactive=60m use_temp_path=off;

server {
    listen 443 ssl http2;
    server_name api.myapp.com;

    ssl_certificate /etc/letsencrypt/live/api.myapp.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.myapp.com/privkey.pem;
    include snippets/ssl-params.conf;

    # 全域設定（寫在 server 層，所有 location 都套用）
    limit_req zone=api_limit burst=50 nodelay;   # 每 IP 穩定 30r/s、突發再容忍 50 個，超過直接回 503
    client_max_body_size 10M;                    # 請求主體上限 10MB（預設 1M）；API 上傳需求大再個別調高

    # 共用的 proxy 設定（寫一次，底下所有 location 繼承）
    proxy_http_version 1.1;                      # upstream keepalive 必須搭配 HTTP/1.1
    proxy_set_header Connection "";              # 清空 Connection 標頭，連線才能真正保持（不清空預設會送 close）
    proxy_set_header Host $host;                                  # 原始域名（api.myapp.com）
    proxy_set_header X-Real-IP $remote_addr;                      # 客戶端 IP
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;  # IP 轉發鏈
    proxy_set_header X-Forwarded-Proto $scheme;                   # 原始協定（https）
    proxy_set_header X-Request-ID $request_id;                    # Nginx 產生的每請求唯一 ID，往後端傳，用於跨服務追蹤

    # 使用者服務
    location /v1/users {
        proxy_pass http://user_service;
        proxy_next_upstream error timeout http_502 http_503;   # 這台連線失敗/逾時/回 502/503 → 自動換下一台重試
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
        proxy_cache my_cache;                          # 啟用上面 proxy_cache_path 定義的快取區
        proxy_cache_valid 200 5m;                      # 只快取 200 回應，存活 5 分鐘（商品資料容忍 5 分鐘延遲）
        proxy_cache_key "$request_uri";                # 以「路徑 + 查詢參數」當快取 key（不同分頁/排序各自一份）
        add_header X-Cache-Status $upstream_cache_status;  # 回給客戶端快取狀態：HIT / MISS / EXPIRED / BYPASS，方便驗證
    }

    # API 版本控制 — 舊版本重導向
    location /v0/ {
        return 301 /v1$request_uri;                    # /v0/users?id=1 → /v1/v0/users?id=1？不對——見下方逐條說明的修正提醒
    }

    # API 文件
    location /docs {
        alias /var/www/api-docs;                       # alias：把 /docs 對應到這個目錄（/docs/x.html → /var/www/api-docs/x.html）
        index index.html;
    }

    # 健康檢查
    location /health {
        access_log off;                                # 監控系統每幾秒打一次，不關日誌會被洗版
        return 200 '{"status":"ok"}';                  # 不經過後端，Nginx 直接回 200 與固定 JSON
        add_header Content-Type application/json;      # 明確標示回應類型，否則會用 default_type
    }
}
```

### 這段指令在做什麼？（逐條）

> **upstream 區塊的三個關鍵參數**
>
> - `least_conn;`：預設演算法是輪詢（round-robin）；`least_conn` 在「各請求處理時間差異大」的 API 場景更平均，不會讓慢請求堆在同一台。
> - `max_fails=3 fail_timeout=30s`：`fail_timeout` 一個值兩種意思——「30 秒內失敗達 3 次」就把該台標記故障，且「接下來 30 秒」不再派請求給它；時間到了會放少量請求試探是否復活。
> - `keepalive 16;`：對後端維持的閒置連線池（每個 worker 各 16 條）。**必須搭配** `proxy_http_version 1.1;` 與 `proxy_set_header Connection "";`，少任何一個，連線都不會被重用，效能白調。
>
> **速率限制參數**
>
> - `$binary_remote_addr`：IP 的二進位形式（IPv4 只佔 4 bytes），`10m` 共享記憶體約可追蹤 8～16 萬個 IP。
> - `rate=30r/s`：每個 IP 穩定每秒 30 個請求——一般網頁應用的 API 呼叫量綽綽有餘；若客戶端是「一頁打十幾支 API」的儀表板，可酌量調高。
> - `burst=50 nodelay`：頁面載入瞬間常併發數十個請求，burst 讓這種「正常突發」不被誤殺；`nodelay` 表示突發額度內不排隊、立即處理。
>
> **`proxy_next_upstream` 的取捨**
>
> - 列出的條件（`error timeout http_502 http_503`）發生時自動換下一台，搭配 upstream 的多台伺服器實現故障轉移。
> - 故意**不含** `http_500`：500 通常是程式邏輯錯誤，每台都會錯，重試只是放大流量。
> - 注意：對「非冪等」請求（如 POST 扣款）重試可能造成重複執行；必要時用 `proxy_next_upstream_tries 2;` 限制重試次數，或對寫入型 API 關閉重試。
>
> **`$request_id` 與 `$upstream_cache_status`**
>
> - `$request_id`：Nginx 為每個請求產生的 32 字元十六進位唯一值（例如 `444535f9378a3dfa1b8604bc9e05a303`）；轉發給後端並寫入各服務日誌，就能用一個 ID 串起整條呼叫鏈。
> - `$upstream_cache_status`：本次回應的快取結果——`HIT`（快取命中）、`MISS`（未命中、回源）、`EXPIRED`（過期回源）、`BYPASS`（被設定略過）。
>
> **修正提醒：`/v0/` 重導向的陷阱**
>
> - `$request_uri` 是「完整原始 URI」，請求 `/v0/users` 時其值是 `/v0/users`，所以 `return 301 /v1$request_uri;` 實際會導向 `/v1/v0/users` —— 多了一層 `/v0`。
> - 想把 `/v0/xxx` 導向 `/v1/xxx`，應改用 rewrite 擷取路徑：
>
> ```nginx
> location /v0/ {
>     rewrite ^/v0/(.*)$ /v1/$1 permanent;   # 用正規擷取 /v0/ 後面的部分，301 導向 /v1/同路徑（查詢參數預設自動保留）
> }
> ```
>
> **實務建議**
>
> - `location /docs { alias /var/www/api-docs; }` 建議改成「前後都帶斜線」的對稱寫法 `location /docs/ { alias /var/www/api-docs/; }`，可避免 `/docsxyz` 這類前綴誤命中與路徑拼接歧義。
> - **`proxy_set_header` 的繼承是「全有或全無」**：只要某個 location 裡寫了任何一條 `proxy_set_header`，server 層的整組設定就全部失效，必須整組重寫。這是 API Gateway 設定最常見的隱形錯誤。
> - 健康檢查回 JSON 也可改用 `default_type application/json;` 寫法，語意是「此回應的內容類型」，比 `add_header` 更正規。

### 驗證方式

```bash
# 語法檢查（zone / upstream / 快取路徑沒定義好，這一步就會報錯）
sudo nginx -t && sudo nginx -s reload

# 健康檢查
curl -s https://api.myapp.com/health
# 預期：{"status":"ok"}

# 連打兩次商品 API，觀察快取狀態從 MISS 變 HIT
curl -sI https://api.myapp.com/v1/products | grep -i x-cache-status   # 第一次：MISS
curl -sI https://api.myapp.com/v1/products | grep -i x-cache-status   # 第二次：HIT

# 驗證舊版 API 重導向位置是否正確
curl -sI https://api.myapp.com/v0/users | grep -i location
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

    root /var/www/mysite;                   # 靜態網站根目錄
    index index.html;

    # 開啟 gzip 壓縮
    gzip on;                                # 啟用 gzip，文字類資源通常可壓到原始大小的 20~30%
    gzip_types text/plain text/css application/json application/javascript text/xml;  # 只壓文字類（圖片/影片已壓縮過，再壓只是浪費 CPU）
    gzip_min_length 1000;                   # 小於 1000 bytes 不壓（壓縮開銷大於收益；預設值 20 太小）

    # 靜態資源快取策略
    location ~* \.(css|js)$ {
        expires 1y;                                     # 快取一年（檔名帶 hash 的打包產物才能這樣設）
        add_header Cache-Control "public, immutable";   # immutable：瀏覽器在效期內連 304 驗證請求都不發
        add_header Vary "Accept-Encoding";              # 告訴 CDN：壓縮版與未壓縮版要分開快取，避免發錯版本
    }

    location ~* \.(jpg|jpeg|png|gif|webp|svg|ico)$ {
        expires 1y;                         # 圖片通常改名不改檔，可長快取
        add_header Cache-Control "public";  # 允許 CDN 與瀏覽器共同快取
    }

    location ~* \.(woff|woff2|ttf|eot)$ {
        expires 1y;
        add_header Cache-Control "public";
        add_header Access-Control-Allow-Origin "*";   # 字型受 CORS 限制：跨網域（如 CDN 網域）載入字型沒這行會被瀏覽器擋下
    }

    # HTML — 短時間快取（讓 CDN 能及時更新）
    location ~* \.html$ {
        expires 10m;                                        # HTML 是內容入口，只快取 10 分鐘，更新最多延遲 10 分鐘可見
        add_header Cache-Control "public, must-revalidate"; # 過期後必須回源驗證，不可拿過期版本充數
    }

    # 錯誤頁面
    error_page 404 /404.html;               # 404 時改用自訂錯誤頁
    location = /404.html {
        internal;                           # 只允許內部跳轉使用；直接在網址列打 /404.html 會得到 404 而不是這頁
    }

    # 如果在 CDN 後面，取得真實 IP
    # 原理：$remote_addr 本來是 CDN 節點的 IP；以下宣告「這些網段是可信任的代理」，
    # Nginx 會改從 real_ip_header 指定的標頭取出真正的客戶端 IP
    set_real_ip_from 103.21.244.0/22;     # Cloudflare IP 範圍（信任清單，缺一段就有部分請求拿不到真實 IP）
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
    real_ip_header CF-Connecting-IP;        # 從 Cloudflare 專屬標頭讀真實 IP（一般 CDN 多用 X-Forwarded-For）
}
```

### 這段指令在做什麼？（逐條）

> **快取策略為什麼分四級？**
>
> | 資源類型 | 快取時間 | 理由 |
> |---|---|---|
> | CSS / JS | 1 年 + `immutable` | 打包工具在檔名加 hash（如 `app.3f8a2c.js`），內容變了檔名就變，舊檔永遠不會「變髒」 |
> | 圖片 / 字型 | 1 年 | 通常新增不修改；若會原地覆蓋同名圖片，應縮短或改用 hash 檔名 |
> | HTML | 10 分鐘 + `must-revalidate` | HTML 裡寫著「要載入哪個 hash 檔名」，是更新的入口，不能長快取 |
> | 404 頁 | 不對外 | `internal` 限定內部跳轉 |
>
> - `expires 1y;`：同時設定 `Expires` 標頭與 `Cache-Control: max-age=31536000`。單位可用 `s`（秒，預設）、`m`（分）、`h`（時）、`d`（天）、`y`（年）。
> - `Vary: Accept-Encoding`：同一個 URL 會有 gzip 版與原始版兩種回應，CDN 必須依客戶端的 `Accept-Encoding` 分開存，否則可能把 gzip 內容發給不支援壓縮的客戶端（畫面變亂碼）。
>
> **真實 IP 還原（`set_real_ip_from` + `real_ip_header`）**
>
> - 沒有這幾行時：日誌、速率限制、IP 白名單看到的全是 CDN 節點 IP——限流會誤殺整個 CDN 節點背後的所有使用者。
> - `set_real_ip_from`：只信任這些網段送來的 IP 標頭。**不能省**，否則任何人都能偽造標頭冒充別人的 IP。
> - `real_ip_header CF-Connecting-IP;`：Cloudflare 把客戶端真實 IP 放在這個自訂標頭；其他 CDN（CloudFront、Fastly 等）多用 `X-Forwarded-For`，要對應調整。
> - 此功能由 `ngx_http_realip_module` 提供，官方套件預設已內建；若是自行編譯，需加 `--with-http_realip_module`。
>
> **實務建議**
>
> - Cloudflare 的 IP 清單會變動，建議定期從 <https://www.cloudflare.com/ips/> 同步，或用排程腳本自動更新後 `nginx -s reload`。
> - 字型的 `Access-Control-Allow-Origin "*"` 若想收緊，可改成指定自家網域，例如 `add_header Access-Control-Allow-Origin "https://mysite.com";`。

### 驗證方式

```bash
# 檢查各類資源的快取標頭是否符合預期
curl -sI https://mysite.com/assets/app.css | grep -iE "cache-control|expires|vary"
curl -sI https://mysite.com/index.html | grep -iE "cache-control|expires"

# 確認 gzip 有生效（帶上 Accept-Encoding 才會壓縮）
curl -sI -H "Accept-Encoding: gzip" https://mysite.com/assets/app.css | grep -i content-encoding
# 預期：Content-Encoding: gzip

# 確認 404 頁不能被直接存取（預期 404，而不是顯示頁面內容後回 200）
curl -o /dev/null -s -w "%{http_code}\n" https://mysite.com/404.html

# 確認日誌記到的是真實 IP（不是 CDN 節點 IP）
sudo tail -5 /var/log/nginx/access.log
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
    set $maintenance 0;                     # 預設值：不在維護模式

    if (-f /etc/nginx/maintenance.flag) {   # -f：檢查檔案是否存在；每個請求都會即時檢查
        set $maintenance 1;                 # 旗標檔存在 → 進入維護模式
    }

    # 允許特定 IP 繞過維護模式（例如開發團隊）
    if ($remote_addr = 203.0.113.50) {      # 開發團隊的固定 IP
        set $maintenance 0;                 # 即使在維護中也照常服務，方便上線前驗證
    }

    if ($maintenance = 1) {
        return 503;                         # 回 503 Service Unavailable（語意正確：搜尋引擎知道是「暫時」不可用，不會降權）
    }

    # 維護頁面
    error_page 503 @maintenance;            # 503 時轉交給名為 maintenance 的具名 location
    location @maintenance {
        root /var/www/maintenance;          # 維護頁所在目錄
        rewrite ^(.*)$ /maintenance.html break;   # 不管原本要去哪個路徑，一律改寫成 /maintenance.html；break = 改寫後不再重新匹配 location
        internal;                           # 僅供內部跳轉（具名 location 本來就不可被外部直接存取，此行屬雙重保險）
    }

    # 正常服務設定
    location / {
        proxy_pass http://backend;
        include snippets/proxy-params.conf;
    }
}
```

```bash
# 啟用維護模式：建立旗標檔即可
sudo touch /etc/nginx/maintenance.flag
# 補充：if (-f ...) 是「每個請求」即時檢查檔案，其實不 reload 也會立即生效；
#       reload 無害，留著當作習慣動作亦可
sudo nginx -s reload

# 關閉維護模式：刪除旗標檔
sudo rm /etc/nginx/maintenance.flag
sudo nginx -s reload
```

### 這段指令在做什麼？（逐條）

> **整體流程**
>
> 1. 每個請求進來，先把 `$maintenance` 預設為 `0`。
> 2. 旗標檔存在 → 設為 `1`；但若來源 IP 是開發團隊 → 又改回 `0`。**三個 `if` 的先後順序就是優先級**，調換順序邏輯就錯了。
> 3. 最後 `$maintenance` 仍是 `1` 的請求直接 `return 503`，再由 `error_page 503` 轉去維護頁。
>
> **為什麼用「檔案旗標」而不是改設定檔？**
>
> - `touch` / `rm` 一個檔案就能切換，不需要動設定、不需要 reload，零風險、秒生效，也方便寫進部署腳本。
>
> **為什麼回 503 而不是 200？**
>
> - 503 明確告訴搜尋引擎與監控系統「暫時無法服務」；若用 200 顯示維護頁，搜尋引擎可能把維護頁當成正式內容收錄。
> - 可再加 `add_header Retry-After 1800 always;` 提示「約 1800 秒（30 分鐘）後再來」，對爬蟲與 API 客戶端更友善。
>
> **`@maintenance` 具名 location**
>
> - `@` 開頭的 location 沒有對應 URL，只能被 `error_page`、`try_files` 等內部機制引用。
> - `rewrite ^(.*)$ /maintenance.html break;`：`^(.*)$` 匹配任何原始路徑；`break` 表示改寫後直接在當前 location 取檔，不再重新走一輪 location 匹配（避免又被 `location /` 攔走、形成迴圈）。
>
> **`if` 不是很危險嗎？**
>
> - Nginx 社群有句名言「if is evil」，但那是指在 `location` 內搭配複雜指令使用。
> - 本範例的 `if` 全部位於 `server` 層、且只搭配 `set` 與 `return` —— 這是官方文件認可的兩種安全用法。

### 驗證方式

```bash
# 開啟維護模式後，從外部 IP 測試（預期 503 + 維護頁 HTML）
curl -i https://myapp.com/
# 預期第一行：HTTP/2 503

# 從開發團隊白名單 IP 測試（預期 200，正常服務）
curl -o /dev/null -s -w "%{http_code}\n" https://myapp.com/
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
# $cookie_ab_version：內建變數，自動取出名為 ab_version 的 Cookie 值
map $cookie_ab_version $backend {
    "v2"    backend_v2;     # Cookie 值是 v2 → 走新版 upstream
    default backend_v1;     # 沒帶 Cookie 或是其他值 → 一律走舊版（安全預設）
}

upstream backend_v1 {
    server 10.0.1.10:3000;  # 舊版（v1）伺服器
    server 10.0.1.11:3000;
}

upstream backend_v2 {
    server 10.0.2.10:3000;  # 新版（v2）伺服器
    server 10.0.2.11:3000;
}

server {
    listen 443 ssl http2;
    server_name myapp.com;

    location / {
        proxy_pass http://$backend;          # 用變數動態指定 upstream：每個請求依 map 結果送往 v1 或 v2
        include snippets/proxy-params.conf;
    }
}
```

> 這段指令在做什麼？（逐條）
>
> - `map` 在「每次請求讀取 `$backend` 時」才求值，開銷極低；整段邏輯等於：`backend = (cookie.ab_version == "v2") ? "backend_v2" : "backend_v1"`。
> - `$cookie_名稱` 是一整族內建變數：請求標頭 `Cookie: ab_version=v2; theme=dark` 中，`$cookie_ab_version` 的值就是 `v2`。
> - `proxy_pass http://$backend;` 用變數時，Nginx 會先在已定義的 `upstream` 名稱中查找（本例可命中）；若變數值是外部域名，則必須另外設定 `resolver`，否則無法解析。
> - 適用場景：QA 或內部人員手動把自己的 Cookie 設成 `ab_version=v2`，就能在正式環境體驗新版，一般使用者完全不受影響。

### 依百分比分流（灰度發布）

```nginx
# 使用 split_clients 做百分比分流
# 第一個參數是「雜湊的輸入字串」：同一個 IP + 同一個 URI 永遠得到相同結果（分組穩定，不會這次新版下次舊版）
split_clients "${remote_addr}${uri}" $variant {
    10%     "new";      # 10% 的流量到新版本
    *       "old";      # 90% 的流量到舊版本（* = 剩餘所有流量）
}

upstream old_version {
    server 10.0.1.10:3000;   # 穩定版
}

upstream new_version {
    server 10.0.2.10:3000;   # 灰度中的新版
}

server {
    listen 443 ssl http2;
    server_name myapp.com;

    location / {
        if ($variant = "new") {          # 雜湊結果落在 10% 區間 → 改送新版
            proxy_pass http://new_version;
        }
        proxy_pass http://old_version;   # 其餘 90% 走舊版（if 命中時上面那行已生效，不會走到這行）
        include snippets/proxy-params.conf;

        # 加上標頭方便追蹤
        add_header X-Variant $variant;   # 回應帶上分組結果（new / old），驗證與除錯都靠它
    }
}
```

> 這段指令在做什麼？（逐條）
>
> - `split_clients` 的原理：對輸入字串（這裡是 `客戶端IP + 請求路徑`）做 MurmurHash2 雜湊，依雜湊值落點把流量切成設定的比例。
>   - 用 `${remote_addr}${uri}` 當 key：同一人重新整理同一頁，分組不變；換一頁可能換組。
>   - 若希望「同一個使用者全站固定同一組」，把 key 改成 `"${remote_addr}"` 或改用帶使用者 ID 的 Cookie（如 `"${cookie_user_id}"`）。
> - 百分比可寫小數（如 `0.5%`），總和不必湊滿 100%，`*` 承接剩餘全部。
> - 灰度節奏實務上常是：`1% → 5% → 10% → 50% → 100%`，每階段觀察錯誤率與延遲再放大；出問題改回 `0%`（或拿掉 if）即可秒回滾。
> - **關於 `location` 內的 `if + proxy_pass`**：這是「if is evil」清單上少數可安全使用的組合之一（if 區塊內只有一條 `proxy_pass`）。若想完全避開 if，可改用 map 直接對應 upstream 名稱，寫法更乾淨：
>
> ```nginx
> map $variant $gray_backend {
>     "new"   new_version;
>     default old_version;
> }
> # location 內只需要：proxy_pass http://$gray_backend;
> ```

### 驗證方式

```bash
# 手動帶 Cookie 測試 v2 分流是否生效
curl -sI -H "Cookie: ab_version=v2" https://myapp.com/ | grep -i x-variant

# 多打幾次觀察 new / old 的比例是否接近 10%（不同來源 IP 才會分到不同組）
for i in $(seq 1 20); do
  curl -sI "https://myapp.com/page$i" | grep -i x-variant
done
```

---

## 11.9 情境：檔案下載伺服器

```nginx
# 前置需求：限制同時連線數的 zone 必須先定義在 http 區塊（conf.d 頂層即可）
# 以客戶端 IP 為 key，10m 約可追蹤 16 萬個 IP 的連線數
limit_conn_zone $binary_remote_addr zone=conn_per_ip:10m;

server {
    listen 443 ssl http2;
    server_name dl.mysite.com;

    # ... SSL 設定 ...

    root /var/www/downloads;            # 下載檔案存放根目錄

    # 開啟目錄列表
    location / {
        autoindex on;                   # 自動產生目錄列表頁（預設 off：沒有 index 檔會回 403）
        autoindex_exact_size off;       # 顯示人類可讀的檔案大小（如 1.2M；on 會顯示精確 byte 數 1234567）
        autoindex_localtime on;         # 顯示伺服器本地時間（預設 off 顯示 GMT，台灣使用者會差 8 小時）
        autoindex_format html;          # 輸出格式：html（人看）；也可選 json / xml / jsonp（給程式解析）
    }

    # 大檔案下載優化
    location ~* \.(zip|tar|gz|iso|dmg)$ {
        # 使用 sendfile 直接從核心傳送
        sendfile on;                    # 零拷貝：檔案內容在核心空間直接送往網卡，不經過使用者空間，省 CPU 與記憶體
        tcp_nopush on;                  # 搭配 sendfile：攢滿一個封包再送，減少封包數量、提升大檔吞吐

        # 支援斷點續傳
        max_ranges 1;                   # 允許 Range 請求但每次最多 1 個範圍：續傳可用，又防多範圍請求（range 攻擊）放大伺服器負擔

        # 限制下載速度（防止頻寬被單一用戶佔滿）
        limit_rate 5m;                  # 每「連線」限速 5MB/s（單位是 bytes/s，k = KB、m = MB）
        limit_rate_after 100m;          # 前 100MB 全速傳輸，之後才開始限速——小檔秒下，只有大檔吃到限速

        # 限制每個 IP 的同時下載數
        limit_conn conn_per_ip 3;       # 每個 IP 最多同時 3 條下載連線，超過回 503；防止單人開 20 線程吃光頻寬
    }
}
```

### 這段指令在做什麼？（逐條）

> **`autoindex` 一家四口**
>
> - `autoindex on;` 是開關；後面三個指令只是調整顯示格式，預設值在大多數下載站都不理想，所以常一起出現。
> - 安全提醒：開了 `autoindex` 等於把目錄結構公開，請確認該目錄下沒有不該被看到的檔案（備份檔、設定檔等）。
>
> **限速兩兄弟：`limit_rate` 與 `limit_rate_after`**
>
> - `limit_rate 5m;`：限的是「單一連線」的速度，不是單一 IP——這就是為什麼還需要 `limit_conn`，否則使用者開 3 條連線就有 15MB/s。
> - `limit_rate_after 100m;`：典型「先甜後限」策略。網頁、小工具檔案（< 100MB）完全無感；超大 ISO 檔則在 100MB 後降到 5MB/s，保護整體頻寬。
> - 預設兩者皆為 `0`（不限速、立即生效），數值支援 `k` / `m` 單位。
>
> **`limit_conn conn_per_ip 3;` 的配套**
>
> - `limit_conn` 引用的 zone **必須**先以 `limit_conn_zone` 定義在 http 區塊，否則 `nginx -t` 報錯 `zone "conn_per_ip" is unknown`——這是本情境最常見的「抄了範例卻起不來」原因。
> - 被擋下的連線預設回 503，可用 `limit_conn_status 429;` 改為 429。
> - 注意：公司或學校共用一個出口 IP 時，3 條連線是「整個辦公室共享」的額度，請依使用者結構調整。
>
> **`max_ranges 1;` 在防什麼？**
>
> - HTTP Range 請求是斷點續傳與多線程下載器的基礎；但惡意客戶端可在單一請求塞入大量不連續範圍（如 `Range: bytes=0-1,5-6,10-11,...`），迫使伺服器大量 seek。
> - 設為 `1` 表示一次只接受一個範圍：續傳工具正常運作，多範圍攻擊直接失效。設為 `0` 則完全停用 Range 支援（續傳也會失效，一般不建議）。

### 驗證方式

```bash
# 確認目錄列表正常顯示
curl -s https://dl.mysite.com/ | head -20

# 測試斷點續傳：請求檔案的第 0~99 byte（預期 HTTP 206 Partial Content）
curl -sI -H "Range: bytes=0-99" https://dl.mysite.com/big-file.iso | head -5

# 觀察下載速度是否在 100MB 後降到約 5MB/s（看 curl 的即時速度欄位）
curl -o /dev/null https://dl.mysite.com/big-file.iso
```

---

## 11.10 情境：多語系網站路由

```nginx
# 根據瀏覽器語言自動重導向
# $http_accept_language：客戶端的 Accept-Language 標頭，範例值：zh-TW,zh;q=0.9,en;q=0.8
map $http_accept_language $lang {
    default en;     # 比不到任何規則 → 預設英文（國際網站最安全的兜底）
    ~^zh    zh;     # ~ 開頭 = 正規匹配；^zh = 標頭以 zh 開頭（涵蓋 zh-TW、zh-CN、zh-HK）
    ~^ja    ja;     # 日文（ja、ja-JP）
    ~^ko    ko;     # 韓文（ko、ko-KR）
}

server {
    listen 443 ssl http2;
    server_name mysite.com;

    # 首頁根據語言重導向
    location = / {                      # 精確匹配「只有首頁」做語言跳轉，其餘路徑不受影響
        return 302 /$lang/;             # 302 暫時重導向：使用者換瀏覽器語言後，下次來還會重新判斷（301 會被瀏覽器永久記住，改語言就回不來了）
    }

    location /zh/ {
        alias /var/www/mysite/zh/;              # alias：/zh/about.html → /var/www/mysite/zh/about.html
        try_files $uri $uri/ /zh/index.html;    # 找不到就回中文版首頁（SPA 或自訂 404 落地頁）
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

### 這段指令在做什麼？（逐條）

> **`map $http_accept_language $lang` 怎麼運作？**
>
> - `$http_名稱` 是一族內建變數，對應任意請求標頭（標頭名轉小寫、`-` 轉 `_`）：`Accept-Language` → `$http_accept_language`。
> - 瀏覽器送來 `Accept-Language: zh-TW,zh;q=0.9,en;q=0.8` 時，`~^zh` 命中（字串以 `zh` 開頭），`$lang` 即為 `zh`。
> - 注意這是「只看開頭」的簡化判斷：只比對第一優先語言，不會解析 `q` 權重；對大多數網站已足夠，要精準解析需交給應用程式處理。
> - `~` 是區分大小寫的正規；標頭語言碼慣例為小寫，若要保險可改用 `~*^zh` 不區分大小寫。
>
> **為什麼用 `302` 而不是 `301`？**
>
> - `301`（永久）會被瀏覽器強力快取：使用者第一次來時是英文系統，之後就算把系統改成中文，瀏覽器仍直接跳 `/en/`。
> - `302`（暫時）每次都重新詢問伺服器，語言判斷永遠是「當下」的結果。
>
> **`alias` 與 `root` 的差別（本例的關鍵選擇）**
>
> - `root`：實體路徑 = root 值 + 完整 URI → `location /zh/ { root /var/www/mysite; }` 時 `/zh/about.html` → `/var/www/mysite/zh/about.html`。
> - `alias`：實體路徑 = alias 值 + 「去掉 location 前綴後」的 URI → 一樣得到 `/var/www/mysite/zh/about.html`。
> - 本例兩者結果相同。**實務建議**：當目錄結構與 URI 結構一致時（如本例），優先用一行 `root /var/www/mysite;` 放在 server 層取代三個 alias——更簡潔，也避開 `alias` 與 `try_files` 在某些版本上的路徑解析怪癖（nginx 已知問題 trac #97）。
> - `alias` 真正不可替代的場合：URI 與磁碟路徑「對不起來」時，例如 `location /docs/ { alias /opt/manuals/v2/; }`。
>
> **常見錯誤**
>
> - `alias` 搭配前綴 location 時，**兩邊的尾斜線要一致**（`/zh/` 對 `/var/www/mysite/zh/`）；一邊有一邊沒有，會拼出 `/var/www/mysitezh/...` 這類錯誤路徑。
> - 忘了 `location = /` 的 `=`：寫成 `location /` 會讓「所有」路徑都被導去 `/$lang/`，整個網站陷入重導向迴圈。

### 驗證方式

```bash
# 模擬中文瀏覽器（預期 302 → /zh/）
curl -sI -H "Accept-Language: zh-TW,zh;q=0.9" https://mysite.com/ | grep -i location

# 模擬日文瀏覽器（預期 302 → /ja/）
curl -sI -H "Accept-Language: ja-JP,ja;q=0.9" https://mysite.com/ | grep -i location

# 沒有 Accept-Language 標頭（預期走 default → /en/）
curl -sI https://mysite.com/ | grep -i location

# 確認各語系頁面本身回 200
curl -o /dev/null -s -w "%{http_code}\n" https://mysite.com/zh/
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
