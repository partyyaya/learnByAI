# 第二章：設定檔結構與基礎語法

## 2.1 設定檔的階層結構

Nginx 的設定檔採用區塊（Block）結構，由指令（Directive）和上下文（Context）組成：

```nginx
# 全域區塊（Main Context）
worker_processes auto;
error_log /var/log/nginx/error.log warn;
pid /var/run/nginx.pid;

# 事件區塊
events {
    worker_connections 1024;
    multi_accept on;
}

# HTTP 區塊
http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    # Server 區塊（虛擬主機）
    server {
        listen 80;
        server_name example.com;

        # Location 區塊（URL 路徑匹配）
        location / {
            root /var/www/html;
            index index.html;
        }
    }
}
```

### 結構層級圖

```
main（全域）
├── events { }           # 連線處理設定
└── http { }             # HTTP 服務設定
    ├── upstream { }     # 後端伺服器群組
    ├── server { }       # 虛擬主機
    │   ├── location { } # URL 路徑匹配
    │   │   └── if { }   # 條件判斷
    │   └── location { }
    └── server { }
```

---

## 2.2 基本語法規則

### 指令類型

```nginx
# 簡單指令：以分號結尾
worker_processes auto;
error_log /var/log/nginx/error.log;

# 區塊指令：以大括號包圍
events {
    worker_connections 1024;
}

# 註解：以 # 開頭
# 這是一行註解
worker_processes auto;  # 這也是註解
```

### include 指令

用於引入其他設定檔，避免主設定檔過於龐大：

```nginx
http {
    include /etc/nginx/mime.types;
    include /etc/nginx/conf.d/*.conf;
    include /etc/nginx/sites-enabled/*;
}
```

<sup>點擊編號查看詳細說明：</sup><br>
<sup>**[【1】](#note-1)** `mime.types` — MIME 類型對應表</sup><br>
<sup>**[【2】](#note-2)** `conf.d/*.conf` — 額外設定檔</sup><br>
<sup>**[【3】](#note-3)** `sites-enabled/*` — 已啟用的站台管理</sup>

---

## 2.3 主要設定區塊詳解

### Main Context（全域設定）

```nginx
worker_processes auto;
error_log /var/log/nginx/error.log warn;
pid /var/run/nginx.pid;
user www-data;
worker_rlimit_nofile 65535;
```

<sup>點擊編號查看詳細說明：</sup><br>
<sup>**[【4】](#note-4)** `pid` — PID 檔案位置</sup><br>
<sup>**[【5】](#note-5)** `user` — 執行使用者與群組</sup><br>
<sup>**[【6】](#note-6)** `worker_rlimit_nofile` — 最大檔案描述符數</sup>

### Events Context

```nginx
events {
    # 每個 worker 的最大連線數
    worker_connections 1024;

    # 是否允許一次接受多個連線
    multi_accept on;

    # 事件處理模型（Linux 建議 epoll，FreeBSD 建議 kqueue）
    use epoll;
}
```

> **小知識**：最大並發連線數 = worker_processes × worker_connections

### HTTP Context

```nginx
http {
    # MIME 類型
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    # 日誌格式
    log_format main '$remote_addr - $remote_user [$time_local] '
                    '"$request" $status $body_bytes_sent '
                    '"$http_referer" "$http_user_agent"';

    access_log /var/log/nginx/access.log main;

    # 效能相關
    sendfile on;               # 使用 sendfile 系統呼叫
    tcp_nopush on;             # 最佳化資料傳輸
    tcp_nodelay on;            # 減少延遲
    keepalive_timeout 65;      # Keep-Alive 超時時間
    types_hash_max_size 2048;  # 類型雜湊表大小

    # Gzip 壓縮
    gzip on;
    gzip_types text/plain text/css application/json application/javascript;
    gzip_min_length 1000;

    # 引入站台設定
    include /etc/nginx/conf.d/*.conf;
}
```

---

## 2.4 Server Block（伺服器區塊）

```nginx
server {
    # 監聽的 port
    listen 80;
    listen [::]:80;          # IPv6

    # 伺服器名稱（域名）
    server_name example.com www.example.com;

    # 網站根目錄
    root /var/www/example.com/html;

    # 預設首頁
    index index.html index.htm;

    # 字元編碼
    charset utf-8;

    # 存取日誌
    access_log /var/log/nginx/example.com.access.log;
    error_log /var/log/nginx/example.com.error.log;
}
```

---

## 2.5 Location Block（路徑匹配）

Location 區塊是 Nginx 設定中最常用也最複雜的部分，用於匹配 URL 路徑。

### 匹配規則與優先順序

```nginx
# 1. 精確匹配（最高優先）
location = /api/health {
    return 200 'OK';
}

# 2. 前綴匹配（優先，匹配後停止搜尋）
location ^~ /static/ {
    root /var/www;
}

# 3. 正規表示式匹配（區分大小寫）
location ~ \.php$ {
    fastcgi_pass unix:/var/run/php/php-fpm.sock;
}

# 4. 正規表示式匹配（不區分大小寫）
location ~* \.(jpg|jpeg|png|gif|ico|css|js)$ {
    expires 30d;
}

# 5. 一般前綴匹配
location /api/ {
    proxy_pass http://backend;
}

# 6. 預設匹配（最低優先）
location / {
    try_files $uri $uri/ =404;
}
```

### 匹配優先順序

```
1. = （精確匹配）          → 最高優先
2. ^~ （前綴匹配，停止搜尋）→ 次高
3. ~ （正規，區分大小寫）   → 第三
4. ~* （正規，不區分大小寫）→ 第四
5. 無修飾符（一般前綴）     → 最長匹配優先
```

---

## 2.6 常用變數

Nginx 提供許多內建變數，可在設定中使用：

```nginx
# 請求相關
$request_uri    # 完整的原始請求 URI（含參數）
$uri            # 正規化後的 URI（不含參數）
$args           # 查詢參數
$request_method # 請求方法（GET, POST 等）
$content_type   # Content-Type 標頭
$content_length # Content-Length 標頭

# 客戶端相關
$remote_addr    # 客戶端 IP
$remote_port    # 客戶端 port
$http_user_agent        # User-Agent 標頭
$http_referer           # Referer 標頭
$http_x_forwarded_for   # X-Forwarded-For 標頭

# 伺服器相關
$host           # 請求的 Host 標頭
$server_name    # 匹配到的 server_name
$server_port    # 伺服器 port
$scheme         # 協定（http 或 https）

# 回應相關
$status         # 回應狀態碼
$body_bytes_sent # 回應 body 大小
$request_time   # 請求處理時間
```

### 使用範例

```nginx
# 日誌中記錄真實 IP
log_format custom '$http_x_forwarded_for - $remote_addr [$time_local] '
                  '"$request" $status $body_bytes_sent '
                  'rt=$request_time';

# 根據請求方法做不同處理
if ($request_method = POST) {
    return 405;
}

# 設定自訂 header
add_header X-Request-ID $request_id;
```

---

## 2.7 實際情境

### 情境一：設定檔語法錯誤，Nginx 無法重載

**問題**：修改設定後 `nginx -s reload` 失敗

```bash
# 永遠先測試！
sudo nginx -t

# 輸出範例（有錯誤）：
# nginx: [emerg] unknown directive "sevrer" in /etc/nginx/conf.d/mysite.conf:3
# nginx: configuration file /etc/nginx/nginx.conf test failed

# 修正拼字錯誤後再測試
sudo nginx -t
# nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
# nginx: configuration file /etc/nginx/nginx.conf test is successful

# 測試通過後才重載
sudo nginx -s reload
```

### 情境二：多個 server block 衝突

**問題**：設定了多個 server block，但請求總是跑到錯誤的站台

```nginx
# 問題：兩個 server block 都監聽 80，且沒有正確設定 server_name
server {
    listen 80;
    server_name _;  # 這會變成預設伺服器
    root /var/www/default;
}

server {
    listen 80;
    server_name api.example.com;
    root /var/www/api;
}

# 解決方案：明確指定 default_server
server {
    listen 80 default_server;     # 明確標示為預設
    server_name _;
    return 444;                    # 拒絕未匹配的請求
}

server {
    listen 80;
    server_name api.example.com;
    root /var/www/api;
}
```

### 情境三：修改設定後忘記重載

**問題**：改了設定檔但網站沒有變化

```bash
# 確認設定是否已重載
# 方法一：看 Nginx master process 的啟動時間
ps aux | grep nginx

# 方法二：檢查錯誤日誌
tail -f /var/log/nginx/error.log

# 正確流程
sudo nginx -t && sudo nginx -s reload
```

---

## 2.8 本章小結

- Nginx 設定檔採用巢狀區塊結構：main → events / http → server → location
- 每次修改設定後，務必使用 `nginx -t` 測試語法
- Location 匹配有明確的優先順序，精確匹配 > 前綴匹配 > 正規匹配
- 善用 `include` 將設定模組化，提高可維護性
- 熟悉常用內建變數，可以靈活運用在日誌、條件判斷與標頭設定中

---

> 上一章：[Nginx 簡介與安裝](./01-introduction.md) | 下一章：[虛擬主機設定](./03-virtual-host.md)

---

## 補充說明

<a id="note-1"></a>
### 【1】MIME 類型（`include /etc/nginx/mime.types;`）

MIME（Multipurpose Internet Mail Extensions）類型是一種標準，用來告訴瀏覽器「這個檔案是什麼格式，該怎麼處理」。例如瀏覽器收到一個檔案時，需要知道它是 HTML 要渲染、是圖片要顯示、還是 ZIP 要下載。Nginx 透過 `mime.types` 檔案，根據副檔名對應到正確的 MIME 類型，並設定在回應的 `Content-Type` 標頭中。

常見的對應關係：

| 副檔名 | MIME 類型 | 瀏覽器行為 |
|--------|-----------|------------|
| `.html` | `text/html` | 渲染成網頁 |
| `.css` | `text/css` | 當作樣式表載入 |
| `.js` | `application/javascript` | 當作腳本執行 |
| `.png` | `image/png` | 顯示圖片 |
| `.json` | `application/json` | 解析為 JSON 資料 |
| `.pdf` | `application/pdf` | 開啟 PDF 檢視器 |
| `.zip` | `application/zip` | 觸發下載 |

如果沒有引入 `mime.types`，Nginx 會把所有檔案都當成 `application/octet-stream`（預設的二進位類型），瀏覽器就會直接下載檔案而不是正確地顯示——這就是為什麼有時候 CSS 沒生效、圖片變下載的原因。

`mime.types` 檔案內容範例（節錄）：

```nginx
types {
    text/html                             html htm shtml;
    text/css                              css;
    text/javascript                       js;
    application/json                      json;
    application/pdf                       pdf;
    image/jpeg                            jpeg jpg;
    image/png                             png;
    image/svg+xml                         svg svgz;
    video/mp4                             mp4;
    font/woff2                            woff2;
    application/octet-stream              bin exe dll;
}
```

格式為 `MIME類型  副檔名1 副檔名2 ...;`，一個 MIME 類型可以對應多個副檔名（例如 `image/jpeg` 同時對應 `jpeg` 和 `jpg`）。通常不需要手動修改此檔案，直接 `include` 引入即可。

[⬆ 回到 include 指令](#include-指令)

---

<a id="note-2"></a>
### 【2】額外設定檔（`include /etc/nginx/conf.d/*.conf;`）

`/etc/nginx/conf.d/` 目錄用來放置額外的設定檔，Nginx 會自動載入所有 `.conf` 結尾的檔案。常見用法是一個站台一個檔案：

```nginx
# /etc/nginx/conf.d/mysite.conf
server {
    listen 80;
    server_name mysite.com www.mysite.com;
    root /var/www/mysite/html;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }
}
```

```nginx
# /etc/nginx/conf.d/api.conf
server {
    listen 80;
    server_name api.mysite.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

也可以放共用設定（如 Gzip、SSL 參數），讓所有站台共享：

```nginx
# /etc/nginx/conf.d/gzip.conf
gzip on;
gzip_comp_level 5;
gzip_min_length 1000;
gzip_types text/plain text/css application/json application/javascript;
gzip_vary on;
```

重點：`conf.d/` 目錄內**只有 `.conf` 結尾的檔案會被載入**。如果想暫時停用某個設定，只要把副檔名改掉（例如改成 `.conf.disabled`）再重載 Nginx 即可。

[⬆ 回到 include 指令](#include-指令)

---

<a id="note-3"></a>
### 【3】已啟用的站台（`include /etc/nginx/sites-enabled/*;`）

這是 **Ubuntu / Debian** 系統特有的站台管理模式，搭配 `sites-available` 目錄一起使用。CentOS / RHEL 預設沒有這兩個目錄，只使用 `conf.d/`。

**運作原理**：

```
sites-available/    ← 存放所有站台設定檔（不論是否啟用）
sites-enabled/      ← 存放符號連結（symlink），指向 sites-available 中要啟用的站台
```

```
/etc/nginx/
├── sites-available/          # 所有站台設定都放這裡
│   ├── default               # 預設站台
│   ├── mysite.com            # 主站
│   ├── api.mysite.com        # API 站
│   └── staging.mysite.com    # 測試站（目前未啟用）
└── sites-enabled/            # 只放符號連結
    ├── default → ../sites-available/default
    ├── mysite.com → ../sites-available/mysite.com
    └── api.mysite.com → ../sites-available/api.mysite.com
    # staging.mysite.com 沒有連結 → 不會載入 → 不啟用
```

**前置作業（如果目錄不存在需要手動建立）**：

```bash
# 1. 建立目錄（CentOS 或乾淨安裝時可能不存在）
sudo mkdir -p /etc/nginx/sites-available
sudo mkdir -p /etc/nginx/sites-enabled

# 2. 確認 nginx.conf 的 http { } 區塊內有加上：
#    include /etc/nginx/sites-enabled/*;

# 3. 建立站台設定檔
sudo nano /etc/nginx/sites-available/mysite.com
```

**日常操作**：

```bash
# 啟用站台 — 建立符號連結
sudo ln -s /etc/nginx/sites-available/mysite.com /etc/nginx/sites-enabled/

# 停用站台 — 移除符號連結（原始設定檔不會被刪除）
sudo rm /etc/nginx/sites-enabled/mysite.com

# 每次操作後都要測試並重載
sudo nginx -t && sudo nginx -s reload
```

**與 `conf.d/` 的比較**：

| 比較項目 | `conf.d/` | `sites-available/` + `sites-enabled/` |
|---------|-----------|--------------------------------------|
| 啟用/停用站台 | 要改檔名或刪除檔案 | 只需新增或移除符號連結 |
| 保留已停用的設定 | 需自行管理 | 原始檔案始終保留在 `sites-available` |
| 適合場景 | 設定少、簡單環境 | 多站台、需要頻繁切換的環境 |
| 發行版預設 | CentOS / RHEL | Ubuntu / Debian |

兩種方式都能達到相同效果，選擇你的系統預設的方式即可。重要的是團隊統一一種做法，不要混用。

[⬆ 回到 include 指令](#include-指令)

---

<a id="note-4"></a>
### 【4】PID 檔案（`pid /var/run/nginx.pid;`）

PID（Process ID）是作業系統分配給每個執行中程式的唯一編號。這個指令讓 Nginx 啟動時把自己的主行程編號寫入指定檔案。

這個檔案的用途：

1. **管理指令依賴它** — `nginx -s reload`、`nginx -s stop` 等指令需要讀取 PID 檔案才知道要對哪個行程發送信號：

```bash
# nginx -s reload 背後其實等同於：
kill -HUP $(cat /var/run/nginx.pid)
# nginx -s stop 等同於：
kill -TERM $(cat /var/run/nginx.pid)
```

2. **systemd 管理依賴它** — `systemctl restart nginx`、`systemctl status nginx` 透過 PID 檔案追蹤 Nginx 的運行狀態。

3. **日誌輪替依賴它** — logrotate 在切割日誌後需要通知 Nginx 重新開啟日誌檔案：

```bash
kill -USR1 $(cat /var/run/nginx.pid)
```

4. **監控腳本依賴它** — 健康檢查、自動重啟等腳本用它來判斷 Nginx 是否還在運行。

簡單來說：**沒有 PID 檔案，系統就不知道 Nginx 在哪裡，也就無法對它下達重載、停止等指令。** 通常不需要改動預設路徑，保持 `/var/run/nginx.pid` 即可。

[⬆ 回到 Main Context](#main-context全域設定)

---

<a id="note-5"></a>
### 【5】執行使用者（`user www-data;`）

Nginx 啟動時有兩種行程：
- **master process**（主行程）：以 `root` 身份運行，負責讀取設定、綁定 port（80/443 需要 root 權限）
- **worker process**（工作行程）：實際處理客戶端請求，以 `user` 指定的身份運行

```
root      1234  master process    ← root 啟動，管理用
www-data  1235  worker process    ← www-data 身份處理請求
www-data  1236  worker process
```

為什麼不用 root 處理請求？因為**安全性**：
- 如果 worker 被攻擊者利用漏洞入侵，攻擊者只能取得 `www-data` 的低權限，無法控制整台伺服器
- 如果以 root 運行 worker，一旦被入侵就等於整台伺服器被拿下

常見的使用者名稱依發行版不同：

| 發行版 | 預設使用者 |
|--------|-----------|
| Ubuntu / Debian | `www-data` |
| CentOS / RHEL | `nginx` |
| macOS (Homebrew) | `nobody` |

**注意**：`user` 指定的使用者必須對網站目錄有讀取權限，否則會出現 403 Forbidden：

```bash
sudo chown -R www-data:www-data /var/www/mysite
```

[⬆ 回到 Main Context](#main-context全域設定)

---

<a id="note-6"></a>
### 【6】最大檔案描述符數（`worker_rlimit_nofile 65535;`）

在 Linux 中，**每一個網路連線、開啟的檔案、日誌檔案都會佔用一個「檔案描述符」（File Descriptor, fd）**。系統預設每個行程只能開啟 1024 個，對高流量網站來說遠遠不夠。

一個簡單的 HTTP 請求可能就需要多個 fd：

```
1 個 fd — 客戶端連線（socket）
1 個 fd — 讀取靜態檔案（如 index.html）
1 個 fd — 寫入存取日誌（access.log）
1 個 fd — 連線到後端（如果是反向代理）
─────────
一個請求可能用掉 2~4 個 fd
```

所以如果 `worker_connections` 設為 4096，每個連線平均用 2 個 fd，就需要至少 8192 個檔案描述符。設為 65535 可以確保不會因為 fd 不足而拒絕連線。

**常見錯誤**：如果設定了 `worker_rlimit_nofile` 但系統層級的限制沒調整，仍然會失敗：

```bash
# 查看當前系統限制
ulimit -n

# 需要同步調整系統層級限制
# /etc/security/limits.conf
www-data soft nofile 65535
www-data hard nofile 65535
```

[⬆ 回到 Main Context](#main-context全域設定)
