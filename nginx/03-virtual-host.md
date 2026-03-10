# 第三章：虛擬主機（Server Block）設定

## 3.1 什麼是虛擬主機？

虛擬主機（Virtual Host）允許在同一台伺服器上運行多個網站。Nginx 使用 `server` 區塊來定義虛擬主機，根據請求的域名或 IP 來決定由哪個 server block 處理。

### 虛擬主機的類型

| 類型 | 說明 | 適用場景 |
|------|------|----------|
| 基於名稱（Name-based） | 根據 `Host` 標頭區分 | 最常見，一個 IP 對應多個域名 |
| 基於 IP（IP-based） | 根據不同 IP 位址區分 | 需要 SSL 且不支援 SNI 的舊環境 |
| 基於 Port（Port-based） | 根據不同 port 區分 | 測試環境、內部服務 |

> **備註：SSL 與 SNI 的差異**
> - **SSL/TLS**：負責連線加密與憑證驗證，重點是「安全傳輸」。
> - **SNI（Server Name Indication）**：TLS 握手時，客戶端先告訴伺服器要連哪個網域，重點是「同 IP 多網域辨識」。
> - **差異重點**：SSL/TLS 解決「要不要加密」；SNI 解決「同一個 `IP:443` 要用哪張憑證/哪個站點」。
> - 若客戶端不支援 SNI，通常同一個 `IP:443` 只能穩定服務一個 HTTPS 站台，因此舊環境常需用 IP-based（每站一個 IP）。

---

## 3.2 建立虛擬主機的標準流程

### 步驟一：建立網站目錄

```bash
# 建立網站根目錄
sudo mkdir -p /var/www/mysite.com/html
sudo mkdir -p /var/www/api.mysite.com/html

# 設定權限
sudo chown -R www-data:www-data /var/www/mysite.com
sudo chown -R www-data:www-data /var/www/api.mysite.com
sudo chmod -R 755 /var/www
```

### 步驟二：建立測試頁面

```bash
# 主站首頁
echo '<h1>Welcome to mysite.com</h1>' | sudo tee /var/www/mysite.com/html/index.html

# API 站首頁
echo '<h1>API Server - api.mysite.com</h1>' | sudo tee /var/www/api.mysite.com/html/index.html
```

> **備註：這兩行指令在做什麼？**
> - `echo '...'`：產生一段 HTML 文字（首頁內容）。
> - `|`（pipe）：把 `echo` 的輸出傳給後面的 `tee`。
> - `sudo tee /path/index.html`：用 root 權限把內容寫入檔案（通常網站目錄需要較高權限）。
> - 為何不用 `>`：`sudo echo ... > 檔案` 常因重導向權限失敗；`tee` 可正確以 sudo 權限寫入。

### 步驟三：建立 Server Block 設定檔

```bash
# 在 sites-available 建立設定檔（Ubuntu/Debian）
sudo nano /etc/nginx/sites-available/mysite.com

# 或在 conf.d 建立（CentOS/通用）
sudo nano /etc/nginx/conf.d/mysite.com.conf
```

> **備註：這段指令在做什麼？**
> - `sudo nano ...`：用 root 權限開啟編輯器，建立或編輯 Nginx 站台設定檔（Server Block）。
> - `/etc/nginx/sites-available/`：Ubuntu/Debian 常見做法，先放設定檔，再用符號連結啟用到 `sites-enabled`。
> - `/etc/nginx/conf.d/`：許多發行版（含 CentOS 常見配置）會直接載入此目錄下的 `*.conf` 檔案。
> - 兩種方式擇一使用即可，依你系統的 Nginx 預設目錄結構決定。

### 步驟四：啟用站台

```bash
# Ubuntu/Debian：建立符號連結
sudo ln -s /etc/nginx/sites-available/mysite.com /etc/nginx/sites-enabled/

# 測試並重載
sudo nginx -t && sudo nginx -s reload
```

> **備註：`ln -s` 這行的具體意義**
> - `ln -s A B`：在 `B` 建立一個「指向 `A` 的捷徑（符號連結）」。
> - 這裡是把 `sites-available/mysite.com` 連到 `sites-enabled/`，等於「啟用這個站台設定」。
> - 好處是不需複製檔案：只維護 `sites-available` 那一份，修改後立即反映到 `sites-enabled`。
> - 若要停用站台，通常刪除 `sites-enabled` 裡的連結即可，不必刪原始設定檔。
> - 停用範例：`sudo rm /etc/nginx/sites-enabled/mysite.com && sudo nginx -t && sudo nginx -s reload`

---

## 3.3 基於名稱的虛擬主機

這是最常見的設定方式，一個 IP 位址可以對應多個網站：

```nginx
# /etc/nginx/sites-available/mysite.com
server {
    listen 80;
    listen [::]:80;

    server_name mysite.com www.mysite.com;

    root /var/www/mysite.com/html;
    index index.html index.htm;

    # 存取日誌分開記錄
    access_log /var/log/nginx/mysite.com.access.log;
    error_log /var/log/nginx/mysite.com.error.log;

    # 預設處理網站根路徑與其子路徑的請求
    location / {
        # 先找檔案($uri)，再找目錄($uri/)，都不存在就回 404
        try_files $uri $uri/ =404;
    }

    # 自訂 404 頁面
    error_page 404 /404.html;
    location = /404.html {
        internal;
    }

    # 自訂 50x 頁面
    error_page 500 502 503 504 /50x.html;
    location = /50x.html {
        internal;
    }
}
```

> **備註：`error_page` 與 `internal` 的作用**
> - `error_page 404 /404.html;`：當請求結果是 404 時，改由 `/404.html` 作為回應內容。
> - `location = /404.html`：`=` 代表精準比對，只匹配這個路徑。
> - `internal;`：該路徑僅能被 Nginx 內部轉向使用，外部使用者不能直接請求此 URL。
> - `error_page 500 502 503 504 /50x.html;` 同理，會把常見伺服器錯誤導向 `/50x.html`。
> - 實務上請在網站根目錄準備 `404.html` 與 `50x.html`，避免錯誤頁不存在造成二次錯誤。

```nginx
# /etc/nginx/sites-available/api.mysite.com
server {
    listen 80;
    listen [::]:80;

    server_name api.mysite.com;

    root /var/www/api.mysite.com/html;
    index index.html;

    access_log /var/log/nginx/api.mysite.com.access.log;
    error_log /var/log/nginx/api.mysite.com.error.log;

    location / {
        try_files $uri $uri/ =404;
    }
}
```

---

## 3.4 預設伺服器（Default Server）

當請求的域名沒有匹配到任何 server block 時，Nginx 會使用預設伺服器：

```nginx
# 預設伺服器 — 拒絕所有未匹配的請求
server {
    listen 80 default_server;
    listen [::]:80 default_server;

    server_name _;

    # 方法一：回傳 444（Nginx 特殊狀態碼，直接關閉連線）
    # 適合拒絕未匹配流量，不提供任何頁面內容
    return 444;

    # 方法二：重導向到主站（保留原本路徑與查詢字串）
    # 例如 /foo?a=1 -> https://mysite.com/foo?a=1
    # return 301 https://mysite.com$request_uri;

    # 方法三：顯示維護頁面（啟用時需關閉上方 return）
    # root /var/www/default;
    # index maintenance.html;
}
```

> **備註：方法一到三可以同時存在嗎？**
> - 可以同時寫在設定檔中當「備用範例」，但實際生效時建議只啟用一種策略。
> - `return` 會立即結束請求；若啟用 `return 444;` 或 `return 301 ...;`，後面的 `root`、`index` 不會被執行。
> - 若你要用方法三（顯示維護頁），請把 `return` 相關行註解掉，並確認目錄裡有 `maintenance.html`。
>
> **備註：`$request_uri` 是什麼？**
> - `$request_uri` 是客戶端「原始請求 URI」（路徑 + 查詢字串）。
> - 例如請求 `/docs/page?id=10`，`$request_uri` 就是 `/docs/page?id=10`。
> - 所以 `return 301 https://mysite.com$request_uri;` 會導到 `https://mysite.com/docs/page?id=10`。

---

## 3.5 server_name 的匹配規則

```nginx
# 精確名稱
server_name example.com;

# 開頭萬用字元
server_name *.example.com;

# 結尾萬用字元
server_name www.example.*;

# 正規表示式
server_name ~^(?<subdomain>.+)\.example\.com$;

# 多個名稱
server_name example.com www.example.com blog.example.com;

# 佔位名稱（常與 default_server 搭配，不是「匹配所有」關鍵字）
server_name _;
```

> **備註：`server_name _;` 代表什麼？**
> - `_` 只是常見的佔位字串，用來表達「這不是要服務的正式網域」。
> - 真正負責接住未匹配請求的是 `listen ... default_server;`，不是 `_` 本身。
> - 也就是說：`server_name _;` 常和 default server 一起出現，但它不是萬用匹配語法。
>
> **範例：實際匹配流程**
> ```nginx
> server {
>     listen 80;
>     server_name mysite.com;
>     # ... 主站設定
> }
>
> server {
>     listen 80;
>     server_name api.mysite.com;
>     # ... API 站設定
> }
>
> server {
>     listen 80 default_server;  # 成為此 port 的兜底 server
>     server_name _;
>     return 444;                # 接手後的處理策略：直接關閉連線
> }
> ```
> - 請求 `Host: mysite.com` -> 命中第一個 block。
> - 請求 `Host: api.mysite.com` -> 命中第二個 block。
> - 請求 `Host: foo.com`（未定義）-> 前兩個都不匹配，落到第三個 `default_server`。
> - 補充：落到 `default_server` 只代表「由它處理」，不代表固定回應內容；是否回 `444`、`301` 或頁面，取決於 block 內指令。

### 匹配優先順序

```
1. 精確名稱：example.com
2. 最長的開頭萬用字元：*.example.com
3. 最長的結尾萬用字元：www.example.*
4. 第一個匹配的正規表示式（按設定檔順序）
5. default_server
```

---

## 3.6 www 與非 www 重導向

### 將 www 重導向到非 www（推薦）

```nginx
# www → 非 www
server {
    listen 80;
    server_name www.mysite.com;
    return 301 http://mysite.com$request_uri;
}

server {
    listen 80;
    server_name mysite.com;
    root /var/www/mysite.com/html;
    # ... 其他設定
}
```

### 將非 www 重導向到 www

```nginx
server {
    listen 80;
    server_name mysite.com;
    return 301 http://www.mysite.com$request_uri;
}

server {
    listen 80;
    server_name www.mysite.com;
    root /var/www/mysite.com/html;
    # ... 其他設定
}
```

---

## 3.7 多站台管理最佳實踐

### 目錄結構建議

```
/etc/nginx/
├── nginx.conf                    # 主設定檔（盡量不動）
├── conf.d/
│   ├── ssl-params.conf           # 共用的 SSL 參數
│   └── gzip.conf                 # 共用的 Gzip 設定
├── sites-available/              # 所有站台設定
│   ├── default
│   ├── mysite.com
│   ├── api.mysite.com
│   └── staging.mysite.com
├── sites-enabled/                # 已啟用的站台（符號連結）
│   ├── default -> ../sites-available/default
│   ├── mysite.com -> ../sites-available/mysite.com
│   └── api.mysite.com -> ../sites-available/api.mysite.com
└── snippets/                     # 可重用的設定片段
    ├── ssl-certificate.conf
    ├── security-headers.conf
    └── proxy-params.conf
```

### 使用 snippets 減少重複

```nginx
# /etc/nginx/snippets/security-headers.conf
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-XSS-Protection "1; mode=block" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;

# 在 server block 中引入
server {
    listen 80;
    server_name mysite.com;
    include snippets/security-headers.conf;
    # ...
}
```

> **備註：這段在做什麼？**
> - `snippets/*.conf` 是「可重用設定片段」，把共用規則抽出來，避免每個站台重複貼同樣內容。
> - `include snippets/security-headers.conf;` 代表把該檔案內容直接插入目前 `server` 區塊。
> - 好處是維護集中：要調整安全標頭，只改一個 snippet，所有引用它的站台一起生效。
>
> **常見 snippets 內容範例**
> ```nginx
> # /etc/nginx/snippets/security-headers.conf
> add_header X-Frame-Options "SAMEORIGIN" always;
> add_header X-Content-Type-Options "nosniff" always;
> add_header Referrer-Policy "strict-origin-when-cross-origin" always;
> add_header Content-Security-Policy "default-src 'self';" always;
> ```
>
> **`add_header` 各欄位與這段內容代表意思**
> - 基本語法：`add_header <Header-Name> <Header-Value> [always];`
> - `Header-Name`：HTTP 回應標頭名稱（例如 `X-Frame-Options`）。
> - `Header-Value`：該標頭值（例如 `"SAMEORIGIN"`）。
> - `always`：即使是 4xx/5xx 回應，也一併附帶這個 header。
> - `X-Frame-Options "SAMEORIGIN"`：只允許同網域 iframe 載入，降低 clickjacking 風險。
> - `X-Content-Type-Options "nosniff"`：禁止瀏覽器 MIME 猜測，避免把非腳本檔誤當腳本執行。
> - `X-XSS-Protection "1; mode=block"`：舊版瀏覽器的 XSS 過濾機制（現代瀏覽器多已弱化/不使用）。
> - `Referrer-Policy "strict-origin-when-cross-origin"`：同源保留完整 Referer，跨站只送來源網域，減少 URL/參數洩漏。
>
> ```nginx
> # /etc/nginx/snippets/proxy-params.conf
> proxy_set_header Host $host;
> proxy_set_header X-Real-IP $remote_addr;
> proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
> proxy_set_header X-Forwarded-Proto $scheme;
> proxy_connect_timeout 5s;
> proxy_read_timeout 60s;
> ```
>
> **反向代理參數說明**
> - `proxy_set_header Host $host`：將客戶端請求的原始域名傳給後端，讓後端知道使用者存取的是哪個網站。
> - `proxy_set_header X-Real-IP $remote_addr`：將客戶端的真實 IP 傳給後端（否則後端只會看到 Nginx 的 IP）。
> - `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`：記錄請求經過的所有代理 IP 鏈，用於追蹤原始來源（支援多層代理）。
> - `proxy_set_header X-Forwarded-Proto $scheme`：告訴後端原始請求使用的是 `http` 還是 `https`，讓後端正確處理重導向和連結產生。
> - `proxy_connect_timeout 5s`：Nginx 與後端建立連線的超時時間為 5 秒，超過則回傳 502。
> - `proxy_read_timeout 60s`：等待後端回應的超時時間為 60 秒，適用於處理較久的 API 請求。
>
> ```nginx
> # /etc/nginx/snippets/static-cache.conf
> location ~* \.(css|js|png|jpg|jpeg|gif|svg|woff2?)$ {
>     expires 7d;
>     add_header Cache-Control "public, max-age=604800, immutable";
>     access_log off;
> }
> ```
>
> **靜態資源快取設定說明**
> - `expires 7d`：設定 `Expires` 標頭，告訴瀏覽器該資源 7 天內有效，不需要重新請求。
> - `add_header Cache-Control "public, max-age=604800, immutable"`：
>   - `public`：任何人（瀏覽器、CDN、Proxy）都可以快取。
>   - `max-age=604800`：快取有效期 604800 秒（= 7 天，與 `expires 7d` 對應）。
>   - `immutable`：告訴瀏覽器資源不會改變，即使按重新整理也不重新驗證。
> - `access_log off`：關閉靜態資源的存取日誌，避免大量請求造成日誌膨脹與 I/O 負擔。
> - `expires` 和 `Cache-Control max-age` 功能重疊，同時寫是為了相容性 — 現代瀏覽器優先看 `Cache-Control`，較舊的客戶端則看 `Expires`。


---

## 3.8 實際情境

### 情境一：本地開發測試多個網站

**需求**：在本機開發環境模擬多個域名

```bash
# 修改 /etc/hosts（macOS/Linux）或 C:\Windows\System32\drivers\etc\hosts（Windows）
127.0.0.1   mysite.local
127.0.0.1   api.mysite.local
127.0.0.1   admin.mysite.local
```

```nginx
# 開發環境設定
server {
    listen 80;
    server_name mysite.local;
    root /home/user/projects/mysite/public;
    index index.html;
}

server {
    listen 80;
    server_name api.mysite.local;
    location / {
        proxy_pass http://localhost:3000;
    }
}

server {
    listen 80;
    server_name admin.mysite.local;
    location / {
        proxy_pass http://localhost:3001;
    }
}
```

### 情境二：停用某個站台但不刪除設定

```bash
# 移除符號連結（不刪除原始設定）
sudo rm /etc/nginx/sites-enabled/staging.mysite.com

# 重載 Nginx
sudo nginx -t && sudo nginx -s reload

# 需要時重新啟用
sudo ln -s /etc/nginx/sites-available/staging.mysite.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo nginx -s reload
```

### 情境三：設定子域名自動對應目錄

**需求**：`xxx.mysite.com` 自動對應 `/var/www/xxx` 目錄

```nginx
server {
    listen 80;
    server_name ~^(?<subdomain>.+)\.mysite\.com$;

    root /var/www/$subdomain/html;
    index index.html;

    # 如果目錄不存在，回傳 404
    if (!-d /var/www/$subdomain) {
        return 404;
    }
}
```

### 情境四：同一個站台需要處理帶 port 和不帶 port 的請求

```nginx
server {
    listen 80;
    listen 8080;
    server_name mysite.com;

    root /var/www/mysite.com/html;
    index index.html;
}
```

---

## 3.9 本章小結

- 虛擬主機讓一台伺服器能同時運行多個網站
- 基於名稱的虛擬主機是最常見的設定方式
- 務必設定 `default_server` 來處理未匹配的請求
- `server_name` 有嚴格的匹配優先順序
- 使用 `sites-available` / `sites-enabled` 模式管理站台
- 善用 `snippets` 減少設定重複

---

> 上一章：[設定檔結構與基礎語法](./02-config-basics.md) | 下一章：[反向代理](./04-reverse-proxy.md)
