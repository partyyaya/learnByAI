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

    location / {
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
    return 444;

    # 方法二：重導向到主站
    # return 301 https://mysite.com$request_uri;

    # 方法三：顯示維護頁面
    # root /var/www/default;
    # index maintenance.html;
}
```

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

# 匹配所有（通常用於 default_server）
server_name _;
```

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
