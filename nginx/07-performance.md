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
worker_processes auto;        # auto = 依 CPU 核心數自動決定 worker 行程數

# 每個 Worker 的最大檔案描述符數
worker_rlimit_nofile 65535;   # 提高 fd 上限，避免高併發時「Too many open files」

events {
    # 每個 Worker 的最大連線數
    worker_connections 4096;  # 預設 512/1024；反向代理場景建議 2048~4096

    # 使用高效的事件模型
    use epoll;            # Linux
    # use kqueue;         # FreeBSD/macOS

    # 允許一次接受多個新連線
    multi_accept on;      # worker 被喚醒時一次收下所有排隊中的新連線
}
```

> **計算最大並發連線數**：worker_processes × worker_connections = 總並發連線數
>
> 例如 4 workers × 4096 connections = 16,384 並發連線

### 這段指令在做什麼？（逐條）

- `worker_processes auto;`
  - Nginx 是「一個 master 行程 + 多個 worker 行程」的架構，真正處理請求的是 worker。
  - `auto` 會自動設為 CPU 核心數（例如 4 核就開 4 個 worker），讓每個核心對應一個 worker，避免行程切換的浪費。
  - 不設的話預設是 `1`，多核心機器只會用到一顆 CPU，效能直接打折。
- `worker_rlimit_nofile 65535;`
  - 在 Linux 中，每條連線、每個開啟的檔案、每個日誌檔都佔用一個檔案描述符（fd）。
  - 系統預設每個行程只能開 1024 個 fd；一個反向代理請求常同時佔用「客戶端連線 + 上游連線 + 日誌檔」2~4 個 fd，1024 很快就不夠。
  - 設為 `65535` 是常見起手式；**還必須同步調整系統層級限制**（見 7.8 的 `limits.conf`），否則仍會被系統擋住。
- `worker_connections 4096;`
  - 單一 worker 可同時維持的連線上限，注意這個數字**包含**與後端伺服器的連線，不只是客戶端。
  - 建議值範圍：小型站台 `1024~2048`、API / 反向代理 `2048~4096`、大量長連線（WebSocket）`4096~8192`。
  - 超過上限時，新連線會被拒絕，錯誤日誌會出現 `worker_connections are not enough`（見 7.9 情境三）。
- `use epoll;`
  - `epoll` 是 Linux 的高效 I/O 事件機制：只通知「有事件發生」的連線，不必每次掃描全部連線，大量連線下比 `select`/`poll` 省 CPU 得多。
  - 不寫這行時，Nginx 會自動選擇平台上最佳的事件模型（Linux 上就是 epoll），所以這行其實是「明確宣告」而非必要。
- `multi_accept on;`
  - 預設 `off` 時，worker 每次被喚醒只接受一條新連線；設 `on` 則一次把佇列中的新連線全部收下。
  - 高流量、短連線（大量新連線湧入）時開啟有幫助；一般流量下差異不大。

> **實務建議**：反向代理場景下，一個客戶端請求會同時佔用「客戶端連線 + 上游連線」兩條，可服務的客戶端數粗估約為 `(worker_processes × worker_connections) / 2`。
>
> 套用後建議驗證：
>
> ```bash
> # 檢查設定檔語法是否正確（每次修改後必做）
> sudo nginx -t
>
> # 不中斷服務地套用新設定
> sudo nginx -s reload
>
> # 確認 worker 數量是否符合預期（auto 應接近 CPU 核心數）
> ps -ef | grep "nginx: worker process"
> ```

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
    keepalive_timeout 65;     # 連線保持時間（秒），預設 75
    keepalive_requests 1000;  # 單一連線最大請求數，預設 1000

    # 隱藏 Nginx 版本號（安全性考量）
    server_tokens off;        # 回應標頭只顯示 Server: nginx，不帶版本號

    # 減少雜湊表衝突
    types_hash_max_size 4096;            # MIME 類型雜湊表大小
    server_names_hash_bucket_size 128;   # server_name 雜湊桶大小（域名很長時需加大）
}
```

### 這段指令在做什麼？（逐條）

- `sendfile on;`
  - 一般傳檔流程是「磁碟 → 核心緩衝區 → 使用者空間（Nginx）→ 核心 socket 緩衝區 → 網卡」，資料要在記憶體間複製多次。
  - `sendfile` 讓核心直接把檔案內容從磁碟緩衝送進 socket（零拷貝，zero-copy），跳過使用者空間，減少 CPU 與記憶體複製。
  - 對靜態檔案服務幾乎是必開；若檔案放在某些網路檔案系統（NFS、特殊容器掛載）出現傳輸異常，可暫時關閉排查。
- `tcp_nopush on;`
  - 對應 Linux 的 `TCP_CORK` 選項：先把 HTTP 標頭與檔案開頭「攢」滿一個封包再送出，減少小封包數量、提高吞吐量。
  - **只在 `sendfile on` 時才生效**，因此兩者通常成對出現。
- `tcp_nodelay on;`
  - 關閉 Nagle 演算法（Nagle 會把小封包攢在一起延遲送出，等到收到 ACK 或攢滿才發）。
  - 設 `on` 表示有資料就立刻送出，降低小封包的延遲，適合 API、即時互動應用。
  - 看似與 `tcp_nopush` 矛盾，但 Nginx 會聰明處理：傳輸過程用 nopush 攢滿封包，**最後一個不滿的封包**改用 nodelay 立即送出，兩者可以同時開啟。
- `keepalive_timeout 65;`
  - 單位是秒；客戶端連線在閒置這麼久之後才關閉，期間可重複使用同一條連線發送多個請求，省去重複 TCP 握手。
  - 預設 `75`；常見設 `60~75`。設太短會頻繁重建連線，設太長則閒置連線佔住 fd 與記憶體。設 `0` 等於關閉 Keep-Alive。
- `keepalive_requests 1000;`
  - 一條 Keep-Alive 連線最多服務幾個請求，達到上限就關閉連線（讓資源有機會釋放、負載重新分配）。
  - 預設即為 `1000`（Nginx 1.19.10 之後；舊版預設 100）。一般不需要調整，壓測或 API Gateway 等高頻場景可考慮加大。
- `server_tokens off;`
  - 預設 `on` 時回應標頭會是 `Server: nginx/1.24.0`，錯誤頁也會顯示版本號；關閉後只剩 `Server: nginx`。
  - 隱藏版本號可降低被針對特定版本漏洞攻擊的風險，屬於基本安全習慣。
- `types_hash_max_size 4096;`
  - Nginx 把 `mime.types` 的副檔名對應表放進雜湊表加速查詢，此參數是雜湊表的最大容量。
  - 預設 `1024`；類型很多時 Nginx 啟動會警告 `could not build the types_hash`，把這個值加大即可。
- `server_names_hash_bucket_size 128;`
  - `server_name` 也是存在雜湊表中，桶（bucket）大小須能容納最長的域名。
  - 預設值與 CPU 快取行對齊（通常 32/64/128）；當出現 `could not build server_names_hash` 錯誤（常見於很長的域名或大量虛擬主機）時，把它加大為 64 → 128 → 256。

### 補充：開啟檔案快取（open_file_cache 系列）

靜態檔案站台還可以快取「檔案描述符與中繼資料」，省去每次請求都重新 open / stat 檔案的系統呼叫：

```nginx
http {
    # 快取最多 10000 個檔案的描述符；20 秒內沒被存取就移出快取
    open_file_cache max=10000 inactive=20s;

    # 每 30 秒重新檢查一次快取項目是否仍有效（檔案是否被修改/刪除）
    open_file_cache_valid 30s;

    # 在 inactive 時間內至少被存取 2 次，才會留在快取中
    open_file_cache_min_uses 2;

    # 連「檔案不存在」這類錯誤結果也快取（避免重複查詢不存在的檔案）
    open_file_cache_errors on;
}
```

> 這段指令在做什麼？（逐條）
>
> - `open_file_cache max=10000 inactive=20s;`
>   - 快取的內容是**檔案描述符、大小、修改時間**等中繼資料，不是檔案內容本身。
>   - `max=10000`：最多快取 10000 個項目，滿了用 LRU（最久未用）淘汰。
>   - `inactive=20s`：20 秒內沒被再次存取的項目會被移除。
>   - 預設是 `off`；高流量靜態站台開啟後可明顯減少 open/stat 系統呼叫。
> - `open_file_cache_valid 30s;`
>   - 每隔 30 秒驗證一次快取資訊是否仍正確。
>   - **注意**：在這個時間窗內換掉檔案，Nginx 可能還拿著舊的描述符回應，因此「檔案頻繁更新」的目錄不適合設太長。
> - `open_file_cache_min_uses 2;`
>   - 過濾掉冷門檔案：`inactive` 期間至少被存取 2 次才值得佔一個快取位。
> - `open_file_cache_errors on;`
>   - 把「找不到檔案」的結果也記下來，避免每次都白跑一趟磁碟；缺點是補上檔案後，最長要等 `open_file_cache_valid` 秒才會被看見。

---

## 7.4 Gzip 壓縮

壓縮可以大幅減少傳輸大小，加快頁面載入速度：

```nginx
http {
    # 啟用 Gzip
    gzip on;

    # 最小壓縮大小（小於此值不壓縮）
    gzip_min_length 1000;   # 單位 bytes，預設 20；小檔壓了省不了多少還耗 CPU

    # 壓縮等級（1-9，建議 4-6，越高 CPU 消耗越大）
    gzip_comp_level 5;      # 預設 1；5 是壓縮率與 CPU 的常見平衡點

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
    gzip_vary on;           # 回應加上 Vary: Accept-Encoding 標頭

    # 禁用對 IE6 的壓縮
    gzip_disable "msie6";   # User-Agent 符合此正規表示式的請求不壓縮

    # 壓縮緩衝區
    gzip_buffers 16 8k;     # 16 個 8KB 緩衝區，共 128KB
}
```

### 這段指令在做什麼？（逐條）

- `gzip on;`
  - 啟用即時壓縮：每個符合條件的回應都會在送出前由 CPU 壓縮一次。換頻寬要付 CPU 成本，這就是後面這堆參數要調的東西。
- `gzip_min_length 1000;`
  - 單位是 bytes（依 `Content-Length` 判斷），預設 `20`。
  - 太小的回應壓縮效益低（gzip 本身有標頭開銷，極小檔案壓完反而更大），常見設 `256~1024`。
- `gzip_comp_level 5;`
  - 範圍 `1~9`：等級越高壓得越小但 CPU 消耗越大。實測上 `6` 之後壓縮率提升非常有限，CPU 卻明顯增加。
  - 建議 `4~6`；CPU 吃緊的機器可降到 `1~3`。
- `gzip_types ...;`
  - 列出「除了 `text/html` 之外」要壓縮的 MIME 類型——`text/html` **永遠會被壓縮**，不必也不能寫進來（寫了會有警告）。
  - 只列文字類型（HTML/CSS/JS/JSON/XML/SVG）；**不要**加入 jpg、png、mp4、woff2 等本身已壓縮的格式，再壓只是浪費 CPU。
- `gzip_proxied any;`
  - 控制「帶有 `Via` 標頭、代表經過代理的請求」要不要壓縮，預設 `off`（經代理的請求一律不壓）。
  - `any` 表示全部都壓；其他選項如 `no-cache`、`expired` 可只對不會被代理快取的回應壓縮。Nginx 在 CDN 或多層代理後面時建議設 `any`。
- `gzip_vary on;`
  - 在回應加上 `Vary: Accept-Encoding` 標頭，告訴中間的快取（CDN、代理）：「同一個 URL 有壓縮版與未壓縮版，要分開快取」。
  - 不開的話，CDN 可能把壓縮版回應給不支援 gzip 的舊客戶端，造成亂碼。
- `gzip_disable "msie6";`
  - 參數是比對 `User-Agent` 的正規表示式；`msie6` 是內建特殊值，會排除 IE6（含 SP1 例外處理），因為 IE6 處理 gzip 有 bug。
  - 現代環境幾乎沒有 IE6 流量，留著無害，刪掉也沒問題。
- `gzip_buffers 16 8k;`
  - 格式為「數量 大小」：配置 16 個 8KB 的緩衝區存放壓縮結果，總計最多 128KB。
  - 預設依平台為 `32 4k` 或 `16 8k`，一般不需要調整；只有在回應普遍很大時才考慮加大。

> **驗證壓縮是否生效**：
>
> ```bash
> # 帶上 Accept-Encoding 標頭模擬支援 gzip 的瀏覽器，-I 只看回應標頭
> curl -H "Accept-Encoding: gzip" -I http://myapp.com/app.css
>
> # 回應中看到這行就代表壓縮成功：
> # Content-Encoding: gzip
>
> # 比較壓縮前後大小（-s 靜默模式，-o 丟棄內容，-w 印出下載大小）
> curl -s -o /dev/null -w "未壓縮: %{size_download} bytes\n" http://myapp.com/app.css
> curl -s -H "Accept-Encoding: gzip" -o /dev/null -w "壓縮後: %{size_download} bytes\n" http://myapp.com/app.css
> ```
>
> **常見錯誤**：在 `curl` 沒帶 `Accept-Encoding` 標頭時測不到 gzip——Nginx 只對「聲明支援壓縮」的客戶端壓縮，這不是設定壞了。

### 使用預先壓縮的檔案（gzip_static）

```nginx
# 需要 ngx_http_gzip_static_module
# 可用 nginx -V 2>&1 | grep gzip_static 確認編譯時是否包含此模組

location /assets/ {
    # 如果存在 .gz 檔案，直接使用（不需即時壓縮）
    gzip_static on;            # 請求 app.js 時，若 app.js.gz 存在就直接回傳它
    root /var/www/myapp;
}

# 建置時預先壓縮
# gzip -k -9 /var/www/myapp/assets/*.js     # -k 保留原始檔，-9 最高壓縮等級
# gzip -k -9 /var/www/myapp/assets/*.css
```

> `gzip_static` 跟 `gzip` 差在哪？
>
> - `gzip` 是**每次請求即時壓縮**，耗 CPU；`gzip_static` 是直接回傳**事先壓好的 `.gz` 檔**，幾乎零 CPU 成本。
> - 因為是離線壓縮，可以放心用最高等級 `-9`（即時壓縮用 `-9` 會拖垮 CPU，離線壓縮只做一次無所謂）。
> - `gzip -k` 的 `-k`（keep）很重要：**必須同時保留原始檔**，否則不支援 gzip 的客戶端會拿不到檔案。
> - 建議把預壓縮做進 CI/CD 建置流程，部署時 `.js` 與 `.js.gz` 一起上線。

---

## 7.5 瀏覽器快取策略

```nginx
server {
    listen 80;
    server_name myapp.com;
    root /var/www/myapp;

    # HTML — 不快取或短時間快取
    location ~* \.html$ {
        expires -1;                # 送出過去時間的 Expires 標頭 = 立即過期
        add_header Cache-Control "no-store, no-cache, must-revalidate";
    }

    # CSS/JS — 使用含 hash 的檔名，長時間快取
    location ~* \.(css|js)$ {
        expires 1y;                # 相當於 Cache-Control: max-age=31536000（一年）
        add_header Cache-Control "public, immutable";
    }

    # 圖片 — 中等時間快取
    location ~* \.(jpg|jpeg|png|gif|ico|svg|webp)$ {
        expires 30d;               # 快取 30 天
        add_header Cache-Control "public";
    }

    # 字型 — 長時間快取
    location ~* \.(woff|woff2|ttf|eot)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        add_header Access-Control-Allow-Origin "*";   # 字型受 CORS 限制，跨網域載入需要這行
    }

    # 媒體檔案
    location ~* \.(mp4|webm|ogg|mp3|wav)$ {
        expires 30d;
        add_header Cache-Control "public";
    }
}
```

### 這段指令在做什麼？（逐條）

- `location ~* \.html$ { ... }`
  - `~*` 是不區分大小寫的正規表示式匹配，`\.html$` 表示路徑以 `.html` 結尾。
- `expires -1;`
  - `expires` 會自動產生 `Expires` 與 `Cache-Control: max-age` 兩個標頭；負值代表「已過期」，瀏覽器每次都得回來確認。
  - HTML 是「入口檔案」，裡面引用了帶 hash 的 CSS/JS 檔名——HTML 一旦被快取住，使用者就拿不到新版資源，所以 HTML 必須不快取。
- `add_header Cache-Control "no-store, no-cache, must-revalidate";`
  - `no-store`：完全不准存任何副本（最嚴格）。
  - `no-cache`：可以存，但每次使用前必須先向伺服器確認是否仍有效。
  - `must-revalidate`：快取過期後必須重新驗證，不准擅自使用過期內容。
  - 三個一起寫是為了相容各種瀏覽器與代理的保守做法。
- `expires 1y;` + `Cache-Control "public, immutable"`
  - `1y` = 一年，會轉成 `max-age=31536000`（單位是秒）。
  - `public`：允許瀏覽器**與中間代理/CDN** 都快取（相對的 `private` 只允許瀏覽器存）。
  - `immutable`：告訴瀏覽器「這個檔案永遠不會變，效期內連確認都不用發」。能這樣設的前提是**檔名含內容 hash**（如 `app.3f8a2b.js`），內容一變檔名就變，舊快取自然失效。
- `add_header Access-Control-Allow-Origin "*";`
  - 字型檔受瀏覽器 CORS 政策限制：若字型放在 CDN 或其他網域，沒有這個標頭瀏覽器會拒絕載入（主控台出現 CORS 錯誤）。圖片與 JS 沒有這個限制。

> **常見錯誤（add_header 的繼承陷阱）**：`add_header` 只要在 `location` 內出現**任何一條**，就會**完全覆蓋**而非疊加上層（`server`/`http`）定義的所有 `add_header`。如果你在 `server` 層加了安全性標頭（如 `X-Frame-Options`），又在 `location` 裡加了 `Cache-Control`，安全性標頭會在這個 location 消失——需要把它們在 location 內重新宣告一次。
>
> **驗證快取標頭**：
>
> ```bash
> # -I 只取回應標頭，確認 Expires / Cache-Control 是否如預期
> curl -I http://myapp.com/assets/app.js
>
> # 預期輸出包含：
> # Expires: <一年後的日期>
> # Cache-Control: max-age=31536000
> # Cache-Control: public, immutable
> ```

---

## 7.6 代理快取（Proxy Cache）

當 Nginx 作為反向代理時，可以快取後端回應：

```nginx
http {
    # 定義快取區域（只能寫在 http 區塊）
    proxy_cache_path /var/cache/nginx
        levels=1:2                # 目錄層級：1 字元/2 字元的兩層子目錄
        keys_zone=my_cache:10m    # 快取 key 的共享記憶體（10MB，可存約 8 萬個 key）
        max_size=10g              # 最大快取大小（磁碟用量上限）
        inactive=60m              # 未被存取超過 60 分鐘則刪除
        use_temp_path=off;        # 不使用暫存路徑，直接寫入快取目錄

    server {
        listen 80;
        server_name myapp.com;

        location / {
            proxy_pass http://backend;

            # 啟用快取（引用上面 keys_zone 定義的名稱）
            proxy_cache my_cache;

            # 快取有效時間
            proxy_cache_valid 200 60m;       # 200 狀態碼快取 60 分鐘
            proxy_cache_valid 301 302 10m;   # 重導向快取 10 分鐘
            proxy_cache_valid 404 1m;        # 404 快取 1 分鐘

            # 快取 key（決定「什麼樣的請求算同一份快取」）
            proxy_cache_key "$scheme$request_method$host$request_uri";

            # 顯示快取狀態（方便除錯）
            add_header X-Cache-Status $upstream_cache_status;

            # 在後端不可用時使用過期快取
            proxy_cache_use_stale error timeout http_500 http_502 http_503 http_504;

            # 只有一個請求去後端取資料，其他等待
            proxy_cache_lock on;
            proxy_cache_lock_timeout 5s;     # 等待鎖的逾時時間

            # 最少被請求幾次才快取
            proxy_cache_min_uses 2;

            # 繞過快取的條件
            proxy_cache_bypass $cookie_nocache $arg_nocache;   # 不讀快取
            proxy_no_cache $cookie_nocache $arg_nocache;       # 不寫快取
        }

        # API 不快取
        location /api/ {
            proxy_pass http://backend;
            proxy_cache off;      # 此 location 完全停用快取
            proxy_no_cache 1;     # 雙保險：任何回應都不寫入快取
        }
    }
}
```

### 這段指令在做什麼？（逐條）

**`proxy_cache_path` 的各參數**：

- `/var/cache/nginx`
  - 快取檔案實際存放的磁碟目錄，須確保 Nginx worker 的執行使用者（如 `www-data`）有寫入權限。
- `levels=1:2`
  - 快取檔名是快取 key 的 MD5 值；`1:2` 表示用 MD5 **最後 1 個字元**當第一層目錄、**再往前 2 個字元**當第二層。
  - 例如 key 的 MD5 為 `...d7b6ec9`，檔案會存在 `/var/cache/nginx/9/ec/b7f54b2df7773722d382f4809d65029c9...`。
  - 為什麼要分層？因為單一目錄放幾十萬個檔案時，檔案系統的查找會明顯變慢；不設 `levels` 所有檔案會擠在同一層。
- `keys_zone=my_cache:10m`
  - 格式為「名稱:大小」。`my_cache` 是這塊快取的名字，後面 `proxy_cache my_cache;` 就是在引用它。
  - `10m` 是**共享記憶體**大小，存的是快取 key 與中繼資料（不是回應內容本身，內容在磁碟）；官方估算 1MB 約可存 8000 個 key，10MB 約 8 萬個。
  - 記憶體滿了之後，最久未使用的 key 會被淘汰。
- `max_size=10g`
  - 磁碟快取總量上限。有一個叫 cache manager 的行程會定期巡邏，超過上限就用 LRU 淘汰最少使用的快取檔。
  - 不設的話快取會一直長到塞滿磁碟，**務必要設**。
- `inactive=60m`
  - 60 分鐘內沒被任何人存取的快取項目會被刪除——**不管它有沒有過期**。
  - 注意與 `proxy_cache_valid` 的差異：`valid` 管「內容新不新鮮」，`inactive` 管「這份快取值不值得繼續佔空間」。冷門頁面就算還在有效期內，閒置太久一樣會被清掉。
- `use_temp_path=off`
  - 預設 `on` 時，回應會先寫到 `proxy_temp_path` 暫存目錄再搬進快取目錄；若兩者在不同檔案系統，這一搬就是一次完整複製。
  - 設 `off` 直接寫入快取目錄，省掉搬移成本，是官方建議的做法。

**location 內的快取指令**：

- `proxy_cache my_cache;`
  - 啟用快取並指定使用哪個 `keys_zone`。沒有這行，上面定義的 `proxy_cache_path` 不會有任何作用。
- `proxy_cache_valid 200 60m;`
  - 依狀態碼設定快取多久：成功回應（200）存 60 分鐘；重導向（301/302）存 10 分鐘；404 只存 1 分鐘（避免長時間擋住「之後補上的頁面」，但又能吸收重複的無效請求）。
  - 若後端回應帶有 `Cache-Control: max-age` 或 `Expires` 標頭，**以後端標頭優先**，這裡的設定是後備值。
  - 沒列到的狀態碼（如 500）不會被快取。
- `proxy_cache_key "$scheme$request_method$host$request_uri";`
  - 組出快取的唯一鍵。以請求 `GET http://myapp.com/products?page=2` 為例，key 會是 `httpGETmyapp.com/products?page=2`。
  - `$scheme`＝協定（http/https）、`$request_method`＝方法（GET/POST）、`$host`＝Host 標頭、`$request_uri`＝含查詢參數的完整 URI。
  - key 設計很重要：少放了 `$host` 會讓多個站台共用快取（資料互串）；如果回應依登入者不同，還得把識別資訊加進 key，否則會把 A 使用者的頁面快取給 B 使用者看。
- `add_header X-Cache-Status $upstream_cache_status;`
  - `$upstream_cache_status` 是 Nginx 內建變數，記錄這次請求的快取結果（HIT/MISS/...，完整列表見下方）。
  - 加進回應標頭後，用 `curl -I` 就能直接觀察快取行為，是除錯快取問題的第一工具。
- `proxy_cache_use_stale error timeout http_500 http_502 http_503 http_504;`
  - 「降級保命」機制：當後端發生連線錯誤（`error`）、逾時（`timeout`）或回傳 500/502/503/504 時，改用**已過期的舊快取**回應，而不是把錯誤丟給使用者。
  - 效果是：後端掛掉時，有快取的頁面仍能正常瀏覽（狀態顯示 `STALE`）。
- `proxy_cache_lock on;` + `proxy_cache_lock_timeout 5s;`
  - 防止「快取雪崩（cache stampede）」：快取失效的瞬間若湧入 100 個相同請求，預設會有 100 個請求同時打到後端。
  - 開啟 lock 後只放**一個**請求去後端取資料並回填快取，其餘請求原地等待，等到快取寫好直接讀快取。
  - `lock_timeout 5s`：等待超過 5 秒的請求不再等，直接放行到後端（避免全部卡死）。預設也是 `5s`。
- `proxy_cache_min_uses 2;`
  - 同一個 key 被請求至少 2 次才開始寫入快取，過濾掉只被看一次的冷門頁面，避免它們白白佔用磁碟。預設 `1`（第一次就快取）。
- `proxy_cache_bypass` 與 `proxy_no_cache` 的差別：
  - `proxy_cache_bypass`：條件成立時**不從快取讀**，直接去後端拿（拿回來的結果仍可能寫入快取，狀態顯示 `BYPASS`）。
  - `proxy_no_cache`：條件成立時**不把回應寫入快取**。
  - 兩者通常成對設定，才能做到「完全跳過快取」。
  - 判斷規則：列出的變數中**任何一個不是空字串也不是 `0`**，條件就成立。
  - `$cookie_nocache`：請求 Cookie 中名為 `nocache` 的值（例如 `Cookie: nocache=1`）。
  - `$arg_nocache`：查詢參數中名為 `nocache` 的值（例如 `GET /page?nocache=1`）。
  - 實務用途：開發或除錯時帶上 `?nocache=1` 就能強制看到後端的即時內容。
- `proxy_cache off;`（API location）
  - 在這個 location 明確停用快取（也會覆蓋從上層繼承的 `proxy_cache` 設定）。
  - API 回應通常與使用者狀態相關（登入資訊、即時資料），快取下來會出大事——這是**最常見的快取事故來源**，寧可明確關閉。

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

> **驗證快取是否生效**：
>
> ```bash
> # 第一次請求：應該看到 X-Cache-Status: MISS（去後端拿）
> curl -I http://myapp.com/products
>
> # 立刻再請求一次：應該變成 HIT（從快取回）
> # 注意：若設了 proxy_cache_min_uses 2，第二次仍是 MISS，第三次才會 HIT
> curl -I http://myapp.com/products
>
> # 帶上繞過條件：應該看到 BYPASS
> curl -I "http://myapp.com/products?nocache=1"
> ```

### 手動清除快取

```bash
# 方法一：刪除快取目錄
sudo rm -rf /var/cache/nginx/*   # 直接清空整個快取目錄（粗暴但有效）
sudo nginx -s reload             # 重載讓 Nginx 重建 keys_zone 的記憶體索引

# 方法二：使用 proxy_cache_purge 模組（需要額外安裝）
# 開源版 Nginx 沒有內建，需自行編譯第三方模組 ngx_cache_purge
# location ~ /purge(/.*) {
#     allow 127.0.0.1;            # 只允許本機呼叫清除介面
#     deny all;                   # 拒絕其他所有來源（避免被外人清快取）
#     proxy_cache_purge my_cache "$scheme$request_method$host$1";
#     # $1 是 location 正規表示式中 (/.*) 捕捉到的路徑
# }
# curl http://myapp.com/purge/path/to/page   # 清除 /path/to/page 這一筆快取
```

> **實務建議**：方法一會把所有快取一次清光，後端會瞬間承受全部流量（快取全 MISS），高流量站台請在離峰時間操作；只想讓單一頁面更新時，用方法二的精準清除，或在請求時帶 `proxy_cache_bypass` 條件強制刷新。

---

## 7.7 FastCGI 快取（PHP 網站）

```nginx
http {
    # 與 proxy_cache_path 參數完全相同，只是作用對象是 FastCGI（PHP-FPM）回應
    fastcgi_cache_path /var/cache/nginx/fastcgi
        levels=1:2                # 兩層子目錄，避免單一目錄檔案過多
        keys_zone=php_cache:10m   # 共享記憶體名稱 php_cache，10MB 約可存 8 萬個 key
        max_size=5g               # 磁碟快取上限 5GB
        inactive=60m;             # 60 分鐘沒人存取就刪除

    server {
        listen 80;
        server_name mysite.com;
        root /var/www/mysite;

        # 設定不快取的條件（先預設為 0 = 要快取）
        set $skip_cache 0;

        # POST 請求不快取（POST 通常會改變資料，回應不該被重複使用）
        if ($request_method = POST) {
            set $skip_cache 1;
        }

        # 後台頁面不快取（$request_uri 是含參數的完整請求路徑）
        if ($request_uri ~* "/wp-admin/|/wp-login.php") {
            set $skip_cache 1;
        }

        # 已登入使用者不快取（$http_cookie 是請求的完整 Cookie 標頭字串）
        if ($http_cookie ~* "wordpress_logged_in") {
            set $skip_cache 1;
        }

        location ~ \.php$ {
            fastcgi_pass unix:/var/run/php/php-fpm.sock;  # 透過 Unix Socket 交給 PHP-FPM
            fastcgi_index index.php;                       # 目錄請求時的預設 PHP 檔
            include fastcgi_params;                        # 引入標準 FastCGI 參數對應表

            # 啟用 FastCGI 快取
            fastcgi_cache php_cache;             # 引用上面定義的 keys_zone
            fastcgi_cache_valid 200 60m;         # 只快取 200 回應，存 60 分鐘
            fastcgi_cache_bypass $skip_cache;    # $skip_cache=1 時不讀快取
            fastcgi_no_cache $skip_cache;        # $skip_cache=1 時不寫快取
            fastcgi_cache_key "$scheme$request_method$host$request_uri";  # 快取鍵組成

            add_header X-Cache-Status $upstream_cache_status;  # 回應標頭顯示 HIT/MISS/BYPASS
        }
    }
}
```

### 這段指令在做什麼？（逐條）

- `fastcgi_cache_*` 系列與 7.6 的 `proxy_cache_*` 是同一套機制的兄弟版本：`proxy_*` 用於 `proxy_pass`（HTTP 後端），`fastcgi_*` 用於 `fastcgi_pass`（PHP-FPM），參數意義完全相同。
- `set $skip_cache 0;`
  - 自訂變數 `$skip_cache`，預設 `0`；後面三個 `if` 像開關一樣，命中任一條件就翻成 `1`。
  - `fastcgi_cache_bypass` / `fastcgi_no_cache` 的規則是「值非空且非 `0` 就成立」，所以 `0` = 正常快取、`1` = 跳過快取。
- `if ($request_method = POST)`
  - `$request_method` 是請求方法（GET/POST/PUT...）。POST 代表寫入操作，回應不能拿去回給別人，必須跳過。
- `if ($request_uri ~* "/wp-admin/|/wp-login.php")`
  - `~*` 是不區分大小寫的正規比對，`|` 表示「或」。後台與登入頁面每次內容都因人而異，不可快取。
- `if ($http_cookie ~* "wordpress_logged_in")`
  - `$http_cookie` 對應請求的整串 `Cookie` 標頭，例如 `wordpress_logged_in_abc123=admin|...; wp-settings=...`。
  - WordPress 登入後會種下名稱含 `wordpress_logged_in` 的 Cookie，比對到就代表是登入者——登入者看到的頁面（管理列、個人化內容）絕不能快取給匿名訪客。
- 為什麼 `if` 放在 `server` 層而不是 `location` 內？
  - 放在 `server` 層的 `if` + `set` 是公認安全的用法；`if` 裡做其他事（如 `try_files`、`proxy_pass`）容易踩到 Nginx「if is evil」的地雷。這裡只用 `set` 翻旗標，是標準寫法。

> **驗證**：用無痕視窗（未登入）連續請求兩次首頁，第二次 `X-Cache-Status` 應為 `HIT`；登入後再看同一頁，應顯示 `BYPASS`。如果登入後仍是 `HIT`，表示登入判斷沒生效，請立即檢查 Cookie 名稱是否相符。

---

## 7.8 系統層級優化

Nginx 調得再好，系統核心參數沒跟上一樣會卡住。以下參數寫入 `/etc/sysctl.conf` 後用 `sysctl -p` 套用：

```bash
# /etc/sysctl.conf

# 增加最大檔案描述符數
fs.file-max = 65535                      # 整個系統可開啟的 fd 總數上限（所有行程加總）

# TCP 連線優化
net.core.somaxconn = 65535               # 單一 socket 的 accept 佇列上限（預設僅 128/4096，高併發瞬間湧入會溢出）
net.core.netdev_max_backlog = 65535      # 網卡收包速度快過核心處理速度時，允許排隊的封包數
net.ipv4.tcp_max_syn_backlog = 65535     # 半連線佇列上限（收到 SYN、還沒完成三向交握的連線數）

# TCP Keep-Alive
net.ipv4.tcp_keepalive_time = 600        # 連線閒置 600 秒後開始發送 keepalive 探測（預設 7200 秒太長）
net.ipv4.tcp_keepalive_intvl = 30        # 每次探測間隔 30 秒
net.ipv4.tcp_keepalive_probes = 5        # 連續 5 次探測無回應就判定連線死亡並回收

# TCP 緩衝區
net.core.rmem_max = 16777216             # 單一 socket 接收緩衝區上限：16MB（bytes）
net.core.wmem_max = 16777216             # 單一 socket 傳送緩衝區上限：16MB
net.ipv4.tcp_rmem = 4096 87380 16777216  # TCP 接收緩衝：最小 / 預設 / 最大（核心會自動調節）
net.ipv4.tcp_wmem = 4096 65536 16777216  # TCP 傳送緩衝：最小 / 預設 / 最大

# 允許重用 TIME_WAIT 狀態的 socket
net.ipv4.tcp_tw_reuse = 1                # 對「對外發起的連線」重用 TIME_WAIT socket（反向代理對後端大量短連線時特別有用）

# 本地端口範圍
net.ipv4.ip_local_port_range = 1024 65535   # 對外連線可用的來源 port 範圍，擴大後約有 6.4 萬個可用 port

# 套用設定
# sudo sysctl -p                          # 重新讀取 /etc/sysctl.conf 並立即生效（不需重開機）
```

> 這幾個參數為什麼重要？
>
> - **三個 backlog（somaxconn / netdev_max_backlog / tcp_max_syn_backlog）**
>   - 想像成三道排隊閘門：封包先過網卡佇列、再過 SYN 半連線佇列、完成交握後進 accept 佇列等 Nginx 來收。
>   - 任何一道佇列滿了，新連線就會被默默丟棄——客戶端看到的是「偶發連線逾時」，非常難排查。預設值是為一般桌面環境設計的，伺服器必須加大。
>   - 注意：Nginx `listen` 指令的 `backlog` 參數會受 `somaxconn` 上限約束，兩邊要一起調。
> - **TCP Keep-Alive 三兄弟**
>   - 用來回收「對端已消失但本端不知道」的殭屍連線。依上面設定，一條死連線最長 600 + 30×5 = 750 秒會被回收；用預設值則要超過 2 小時。
>   - 這是**核心層**的 TCP keepalive，與 Nginx 的 HTTP `keepalive_timeout` 是兩回事，不要混淆。
> - **TCP 緩衝區（rmem / wmem）**
>   - 三個值是「最小 預設 最大」（單位 bytes）；核心會依連線狀況在範圍內自動調節，所以只要把「最大」放寬即可，不必改預設值。
>   - 16MB 上限適合高頻寬或高延遲（跨國）連線；內網低延遲環境用預設值通常也夠。
> - **tcp_tw_reuse = 1**
>   - 連線關閉後 socket 會停留在 TIME_WAIT 狀態約 60 秒。反向代理對後端大量建立短連線時，TIME_WAIT 會迅速吃光來源 port。
>   - 此參數允許安全地重用這些 socket，**只影響主動對外發起的連線**，不影響接收。
>   - 千萬不要去找已被新核心移除的 `tcp_tw_recycle`——它在 NAT 環境會造成連線異常，新核心（4.12+）已將其刪除。
> - **ip_local_port_range**
>   - 每條對外連線都要佔用一個本機來源 port。範圍太小時，連往同一個後端最多就只能開那麼多條連線，會出現 `Cannot assign requested address` 錯誤。

```bash
# 增加使用者的檔案描述符限制
# /etc/security/limits.conf

www-data soft nofile 65535   # soft：目前生效的限制（行程可自行調高到 hard 為止）
www-data hard nofile 65535   # hard：上限天花板，只有 root 能再提高
```

> **常見錯誤**：只設了 Nginx 的 `worker_rlimit_nofile`，卻沒改 `limits.conf` 和 `fs.file-max`，三者任一沒到位，高併發時照樣噴 `Too many open files`。設定後可用以下指令驗證：
>
> ```bash
> # 查看 Nginx worker 行程實際生效的 fd 限制（將 <PID> 換成 worker 的行程編號）
> cat /proc/<PID>/limits | grep "open files"
>
> # 查看系統層級上限
> cat /proc/sys/fs/file-max
> ```
>
> 另外，`limits.conf` 的修改要**重新登入或重啟服務**才生效；若 Nginx 由 systemd 管理，較可靠的做法是在 service 設定中加 `LimitNOFILE=65535`。

---

## 7.9 實際情境

### 情境一：網站回應速度慢

**排查流程**：

```bash
# 1. 確認瓶頸在哪裡
# 檢查 Nginx 存取日誌中的 $request_time 和 $upstream_response_time
tail -f /var/log/nginx/access.log   # -f 持續追蹤新寫入的日誌

# $request_time          = Nginx 收到請求第一個 byte 到送完回應的總時間（秒）
# $upstream_response_time = 後端處理所花的時間（秒）
# （這兩個變數需要先加進 log_format 才會出現在日誌中，參考第二章）

# 如果 upstream_response_time 很高 → 後端問題
# 如果 request_time 高但 upstream_response_time 低 → 網路或 Nginx 設定問題

# 2. 檢查 Nginx worker 連線使用率
# 查看當前活躍連線數
curl http://localhost/nginx_status

# 輸出範例：
# Active connections: 291          ← 目前活躍連線數
# server accepts handled requests
#  16630948 16630948 31070465      ← 累計接受/處理的連線數、總請求數
# Reading: 6 Writing: 179 Waiting: 106
# （Reading=讀取請求中、Writing=回應中、Waiting=Keep-Alive 閒置中）
# 若 accepts 與 handled 兩數字不相等，代表有連線被丟棄 → 資源不足的警訊

# 啟用 stub_status（需要以下 location 設定）
# location /nginx_status {
#     stub_status;          # 啟用內建狀態頁模組
#     allow 127.0.0.1;      # 只允許本機查看
#     deny all;             # 拒絕外部存取（狀態資訊不該公開）
# }

# 3. 檢查系統資源
top -bn1 | head -20    # -b 批次模式輸出、-n1 只取一次快照，看 CPU 與負載
free -m                # 以 MB 顯示記憶體使用量，確認是否用到 swap
df -h                  # 以人類可讀單位顯示磁碟用量（磁碟滿會導致日誌/快取寫入失敗）
```

### 情境二：靜態資源載入慢

```nginx
# 優化靜態資源服務
location /static/ {
    alias /var/www/myapp/static/;   # alias：把 /static/ 對應到此實體目錄（注意結尾斜線要成對）

    # 啟用 sendfile（零拷貝傳輸，原理見 7.3）
    sendfile on;
    tcp_nopush on;        # 攢滿封包再送，減少封包數量

    # 長時間快取
    expires max;          # 送出最遠的過期時間（Cache-Control: max-age 約 10 年）
    add_header Cache-Control "public, immutable";   # 允許 CDN 快取；immutable=效期內連驗證都免了

    # 開啟 gzip
    gzip on;
    gzip_types text/css application/javascript;     # 只壓文字類資源（圖片影片本身已壓縮）

    # 預壓縮
    gzip_static on;       # 存在 .gz 檔時直接回傳，免去即時壓縮的 CPU 成本

    # 關閉存取日誌（減少 I/O）
    access_log off;       # 靜態資源量大且分析價值低，關閉可省下大量磁碟寫入
}
```

> **實務建議**：`expires max` + `immutable` 的前提是檔名帶內容 hash（建置工具如 Vite/Webpack 的預設行為）。若檔名固定（如 `style.css`），請改用 `expires 7d` 之類的中等時間，否則改版後使用者會一直看到舊檔。

### 情境三：高流量時 Nginx 報 worker_connections are not enough

```nginx
# 增加 worker_connections
events {
    worker_connections 8192;  # 從 1024 提高到 8192
    multi_accept on;          # 一次接受所有排隊的新連線
    use epoll;                # Linux 高效事件模型
}

# 同時增加系統檔案描述符限制
# （此指令位於全域區塊，與 events 同層；連線數調高 fd 上限必須跟著調）
worker_rlimit_nofile 65535;
```

```bash
# 系統層級
sudo sysctl -w fs.file-max=65535   # -w 立即修改核心參數（重開機會失效，永久生效需寫入 /etc/sysctl.conf）

# 把使用者層級的 fd 限制附加到 limits.conf（tee -a 表示附加寫入，需要 sudo 權限）
echo "www-data soft nofile 65535" | sudo tee -a /etc/security/limits.conf
echo "www-data hard nofile 65535" | sudo tee -a /etc/security/limits.conf
```

> **為什麼三個地方都要改？**因為限制是層層套疊的：`worker_connections`（Nginx 自身）≤ `worker_rlimit_nofile`（行程 fd 上限）≤ `limits.conf`（使用者上限）≤ `fs.file-max`（系統總量）。任何一層卡住，調其他層都沒用。改完記得 `sudo nginx -t && sudo nginx -s reload`，並觀察錯誤日誌確認警告不再出現。

---

## 7.10 效能測試工具

```bash
# Apache Bench（ab）
ab -n 10000 -c 100 http://myapp.com/
# -n 10000：總共發送 10000 個請求
# -c 100  ：同時保持 100 個並發連線
# 注意結尾的 / 不能省略，ab 要求完整 URL 路徑

# wrk（更現代的工具）
wrk -t4 -c100 -d30s http://myapp.com/
# -t4   ：使用 4 個執行緒產生負載（建議 ≤ 壓測機的 CPU 核心數）
# -c100 ：總共維持 100 條連線（平均分給各執行緒）
# -d30s ：持續壓測 30 秒（s=秒、m=分鐘）
# wrk 預設使用 Keep-Alive，比 ab 更貼近真實瀏覽器行為

# siege
siege -c 100 -t 30s http://myapp.com/
# -c 100 ：100 個並發使用者
# -t 30s ：持續 30 秒
# siege 預設在請求之間加入隨機延遲，模擬真實使用者的瀏覽節奏

# 查看結果重點：
# - Requests per second（每秒請求數）→ 吞吐量指標，優化前後比較的主要數字
# - Time per request（每個請求的平均時間）→ 延遲指標，使用者體感
# - Transfer rate（傳輸速率）→ 確認是否已撞到頻寬上限
# - Failed requests（失敗請求數）→ 必須為 0 或極低，有失敗代表撐不住這個並發量
```

> **壓測的實務建議**：
>
> - **不要在被測的伺服器上跑壓測工具**——壓測程式本身會吃掉 CPU，數據會失真；請從另一台機器透過網路施壓。
> - 先壓一次當「優化前基準值」，每改一項設定重壓一次，才知道是哪個改動有效。
> - 由小到大逐步提高 `-c` 並發數，觀察 RPS 何時不再上升、延遲何時開始飆高，那就是系統的拐點。
> - 測快取效果時，第一輪會大量 MISS（暖機），看第二輪的數據才準。
> - 壓測會產生大量 TIME_WAIT 連線與日誌，請在測試環境或離峰時間進行，不要直接打正式環境。

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
