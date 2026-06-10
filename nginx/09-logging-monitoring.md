# 第九章：日誌管理與監控

## 9.1 Nginx 日誌類型

Nginx 有兩種主要日誌：

| 日誌類型 | 檔案 | 用途 |
|----------|------|------|
| 存取日誌（Access Log） | `/var/log/nginx/access.log` | 記錄所有客戶端請求 |
| 錯誤日誌（Error Log） | `/var/log/nginx/error.log` | 記錄錯誤和警告資訊 |

> 補充說明：
>
> - 上表是多數發行版的預設路徑；實際路徑由設定檔中的 `access_log` 與 `error_log` 指令決定，每個 `server`、`location` 都可以指定自己的日誌檔。
> - 存取日誌：**一筆請求寫一行**，請求處理完成時才寫入（所以記錄到的 `$request_time` 是完整處理時間）。
> - 錯誤日誌：記錄 Nginx 本身的運作訊息（啟動、重載、連後端失敗、檔案找不到等），**排查問題時請先看錯誤日誌**。

---

## 9.2 自訂存取日誌格式

### 預設格式

```nginx
# combined 是 Nginx「內建」的預設格式，這裡列出它的定義內容供對照
# 注意：combined 已由 Nginx 預先定義，不需要（也不能）自行重新宣告，
#       否則會出現 duplicate "log_format" name 錯誤；自訂格式請換一個名稱
log_format combined '$remote_addr - $remote_user [$time_local] '   # 客戶端 IP、認證使用者、本地時間
                    '"$request" $status $body_bytes_sent '          # 請求行、狀態碼、回應主體大小
                    '"$http_referer" "$http_user_agent"';           # 來源頁、瀏覽器 UA
```

> `combined` 格式怎麼讀？（逐欄位）
>
> - `$remote_addr`：客戶端 IP（若前面有代理/CDN，看到的會是代理 IP，真實 IP 要看 `$http_x_forwarded_for`）。
> - `$remote_user`：HTTP Basic 認證的使用者名稱，沒有認證時顯示 `-`。
> - `[$time_local]`：伺服器本地時間，方括號是格式的一部分，例如 `[10/Jun/2026:14:23:05 +0800]`。
> - `"$request"`：完整請求行，包含方法、URI 與協定版本，例如 `GET /index.html HTTP/1.1`。
> - `$status`：HTTP 狀態碼（200、404、502...）。
> - `$body_bytes_sent`：回應主體大小（單位 bytes，**不含**回應標頭）。
> - `"$http_referer"`：請求來源頁面 URL，沒有時為 `"-"`。
> - `"$http_user_agent"`：客戶端 UA 字串（瀏覽器/爬蟲識別）。
>
> 實際一行日誌長這樣：
>
> ```text
> 203.0.113.10 - - [10/Jun/2026:14:23:05 +0800] "GET /index.html HTTP/1.1" 200 1024 "https://example.com/" "Mozilla/5.0 ..."
> ```

### 自訂增強格式

```nginx
# 基本增強格式：在 combined 的欄位之外，多記錄四個「反向代理觀測」欄位
log_format main '$remote_addr - $remote_user [$time_local] '
                '"$request" $status $body_bytes_sent '
                '"$http_referer" "$http_user_agent" '
                'rt=$request_time '                  # Nginx 處理整個請求花的時間（秒）
                'urt=$upstream_response_time '       # 後端回應時間（秒）
                'uaddr=$upstream_addr '              # 實際處理請求的後端位址
                'us=$upstream_status';               # 後端回應的狀態碼
```

> 新增的四個變數是排查「慢在哪裡」的關鍵：
>
> - `$request_time`：從收到請求第一個 byte 到回應送完的**總時間**（秒，毫秒精度），例如 `rt=0.732`。
> - `$upstream_response_time`：Nginx 把請求交給後端、到收完後端回應的時間，例如 `urt=0.698`。
>   - 若請求重試過多台後端，會以逗號分隔列出多個值，例如 `urt=3.001, 0.087`。
>   - 純靜態檔請求沒有後端，值為 `-`。
> - `$upstream_addr`：實際處理這次請求的後端位址，例如 `uaddr=10.0.0.11:8080`（重試時同樣會列出多個）。
> - `$upstream_status`：後端回應的狀態碼，例如 `us=502`；可與 `$status` 比對（例如後端回 502，但 Nginx 因為 `proxy_intercept_errors` 改回自訂頁面）。
> - 判讀技巧：`rt` 大但 `urt` 小 → 慢在 Nginx 與客戶端之間（網路慢、客戶端收得慢）；`rt` 與 `urt` 都大 → 慢在後端。

### 含效能指標的格式

```nginx
log_format performance '$remote_addr [$time_local] '
                       '"$request" $status $body_bytes_sent '
                       'request_time=$request_time '                    # 總處理時間（秒）
                       'upstream_time=$upstream_response_time '         # 後端回應時間（秒）
                       'upstream_addr=$upstream_addr '                  # 後端位址
                       'upstream_status=$upstream_status '              # 後端狀態碼
                       'cache_status=$upstream_cache_status '           # 代理快取命中狀態
                       'connection=$connection '                        # 連線序號
                       'connection_requests=$connection_requests';      # 此連線上的第幾個請求
```

> 這三個額外變數的含義：
>
> - `$upstream_cache_status`：代理快取（`proxy_cache`）的命中狀態，常見值：
>   - `HIT`：直接從快取回應（最快，沒打到後端）
>   - `MISS`：快取沒有，向後端取資料
>   - `EXPIRED`：快取過期，重新向後端驗證/取得
>   - `BYPASS`：符合 `proxy_cache_bypass` 條件，跳過快取
>   - `STALE`：後端故障時回應過期快取（搭配 `proxy_cache_use_stale`）
>   - 未啟用快取時為 `-`。可用來計算快取命中率，評估快取設定是否有效。
> - `$connection`：TCP 連線的序號（每條連線一個遞增編號），例如 `connection=8121`。
> - `$connection_requests`：這條連線上目前是**第幾個請求**，例如 `connection_requests=7` 代表 Keep-Alive 連線被重複使用了 7 次。
>   - 若大量請求都是 `1`，代表 Keep-Alive 沒有發揮作用（可檢查 `keepalive_timeout` 是否太短）。

### JSON 格式（方便後續分析工具解析）

```nginx
# escape=json：把欄位值中的特殊字元（雙引號、反斜線、換行等）做 JSON 跳脫，
#              避免 UA 之類含引號的字串把整行 JSON 弄壞（沒加的話日誌可能無法被解析）
log_format json_log escape=json '{'
    '"time": "$time_iso8601", '                                # ISO 8601 時間，如 2026-06-10T14:23:05+08:00
    '"remote_addr": "$remote_addr", '                          # 客戶端 IP
    '"remote_user": "$remote_user", '                          # Basic 認證使用者（無則為空字串）
    '"request_method": "$request_method", '                    # 請求方法（GET/POST...）
    '"request_uri": "$request_uri", '                          # 原始 URI（含 query string）
    '"status": $status, '                                      # 狀態碼：必為數字，所以不加引號
    '"body_bytes_sent": $body_bytes_sent, '                    # 回應主體 bytes：必為數字，不加引號
    '"request_time": $request_time, '                          # 總處理時間（秒）：必為數字，不加引號
    '"http_referer": "$http_referer", '                        # 來源頁
    '"http_user_agent": "$http_user_agent", '                  # UA 字串（最容易含特殊字元，靠 escape=json 保護）
    '"upstream_addr": "$upstream_addr", '                      # 後端位址：可能是 "-" 或多值，所以加引號當字串
    '"upstream_status": "$upstream_status", '                  # 後端狀態碼：可能是 "-"，所以加引號
    '"upstream_response_time": "$upstream_response_time", '    # 後端回應時間：可能是 "-" 或多值，所以加引號
    '"http_x_forwarded_for": "$http_x_forwarded_for"'          # 代理鏈上的原始客戶端 IP
'}';
```

> 這段格式的幾個關鍵設計：
>
> - **為什麼有的欄位不加引號？** JSON 中數字不加引號。`$status`、`$body_bytes_sent`、`$request_time` 永遠是數字，直接輸出成 JSON number，分析工具（ELK / Loki / Datadog）就能直接做數值聚合（平均、P95），不用再轉型。
> - **為什麼 upstream 相關欄位反而加引號？** 因為它們可能是 `-`（沒有後端）或逗號分隔的多值（請求重試多台後端），不是合法的 JSON number，加引號當字串才不會產生壞掉的 JSON。
> - `$time_iso8601`：機器友善的時間格式（`2026-06-10T14:23:05+08:00`），比 `$time_local` 更適合給分析工具解析與排序。
> - 多行單引號字串會被 Nginx 串接成一條格式，分行只是為了可讀性。
>
> 實際輸出一行（已排版，實際是單行）：
>
> ```json
> {"time": "2026-06-10T14:23:05+08:00", "remote_addr": "203.0.113.10", "remote_user": "", "request_method": "GET", "request_uri": "/api/users?page=2", "status": 200, "body_bytes_sent": 532, "request_time": 0.087, "http_referer": "https://example.com/", "http_user_agent": "Mozilla/5.0 ...", "upstream_addr": "10.0.0.11:8080", "upstream_status": "200", "upstream_response_time": "0.085", "http_x_forwarded_for": ""}
> ```

### 使用日誌格式

```nginx
http {
    # 條件性日誌的開關要用 map 產生
    # 注意：map 只能寫在 http 區塊，不能放進 server 區塊（放錯位置 nginx -t 會報錯）
    map $request_uri $loggable {
        ~*^/health        0;    # URI 以 /health 開頭（~* 不分大小寫）→ $loggable = 0（不記錄）
        ~*^/nginx_status  0;    # 狀態頁同樣不記錄
        default           1;    # 其他請求 → $loggable = 1（記錄）
    }

    server {
        # 寫法一：使用自訂格式（json_log 是 9.2 定義的格式名稱）
        access_log /var/log/nginx/myapp.access.log json_log;

        # 寫法二：壓縮日誌（減少磁碟空間）
        # gzip      → 寫入前先壓縮（檔案要用 zcat / zless 讀），可寫 gzip=6 指定壓縮等級（1~9，預設 1）
        # flush=5m  → 緩衝區中的日誌最多滯留 5 分鐘就寫入磁碟（單位可用 s/m/h）
        # 註：使用 gzip 會自動啟用緩衝（預設 64k，可用 buffer=32k 自行指定），
        #     日誌不再即時落盤，tail -f 會看到延遲，除錯時請留意
        access_log /var/log/nginx/myapp.access.log.gz json_log gzip flush=5m;

        # 寫法三：條件性日誌（只記錄特定請求）
        # if=$loggable → 值為空或 "0" 時不記錄；搭配上面的 map，健康檢查與狀態頁就不會灌進日誌
        access_log /var/log/nginx/myapp.access.log main if=$loggable;

        # 寫法四：針對特定 location 直接關閉日誌
        location /health {
            access_log off;     # 此路徑完全不寫存取日誌
            return 200 'OK';    # 直接回 200，不碰磁碟、不打後端
        }
    }
}
```

> `access_log` 完整語法與參數說明：
>
> ```nginx
> access_log path [format [buffer=size] [gzip[=level]] [flush=time] [if=condition]];
> ```
>
> - `path`：日誌檔路徑；不指定 `format` 時預設使用 `combined`。
> - `buffer=size`：在記憶體累積到指定大小才批次寫入磁碟（例如 `buffer=32k`），高流量站台可大幅減少磁碟 I/O；預設**不開**緩衝（每筆即寫）。
> - `gzip[=level]`：先壓縮再寫入；等級 1~9，預設 1（速度優先）；啟用 gzip 會自動隱含緩衝。
> - `flush=time`：緩衝資料最久多久必須落盤一次，避免低流量時日誌一直卡在記憶體裡。
> - `if=condition`：條件式記錄；條件值為空字串或 `0` 時跳過該筆。
>
> 實務建議：
>
> - 同一個區塊可以寫**多條** `access_log`，每筆請求會同時寫進所有目標——上面範例的寫法一、二、三若同時生效，一筆請求會寫三次。實務上**依需求擇一**，這裡並列只是示範。
> - 健康檢查、監控探測（load balancer probe）的路徑建議一律 `access_log off;`，否則一天可能多出數十萬行無意義日誌。
> - 改完設定先 `sudo nginx -t` 驗證，再 `sudo nginx -s reload` 套用；可用 `curl http://localhost/health` 加 `tail /var/log/nginx/myapp.access.log` 確認該路徑確實沒被記錄。

---

## 9.3 錯誤日誌設定

```nginx
# 錯誤日誌等級（從低到高）
# debug → info → notice → warn → error → crit → alert → emerg
# 設定某個等級後，「該等級以上（含）」的訊息都會被記錄
# 例如設 warn → 會記錄 warn、error、crit、alert、emerg

# 全域錯誤日誌：路徑 + 最低記錄等級（不寫等級時預設為 error）
error_log /var/log/nginx/error.log warn;

# 每個 server 可以有獨立的錯誤日誌
server {
    server_name myapp.com;
    error_log /var/log/nginx/myapp.error.log error;   # 此站台只記 error 以上，與全域日誌分開存放

    # 開發環境使用 debug 等級（量非常大，正式環境切勿長開）
    # error_log /var/log/nginx/myapp.error.log debug;
}
```

> 各等級的含義與適用場景：
>
> | 等級 | 含義 | 使用時機 |
> |------|------|----------|
> | `debug` | 最詳細，逐步記錄請求處理細節 | 深度除錯；需 Nginx 編譯時帶 `--with-debug` 才有完整輸出（`nginx -V` 可確認） |
> | `info` | 一般資訊（如客戶端正常斷線） | 排查連線行為 |
> | `notice` | 重要的正常事件（如設定重載、worker 重啟） | 通常不需要特別開 |
> | `warn` | 警告，不影響服務但值得注意 | **正式環境常用的最低等級** |
> | `error` | 請求處理失敗（連不上後端、檔案不存在等） | 預設等級 |
> | `crit` / `alert` / `emerg` | 嚴重 → 致命（如設定錯誤導致無法啟動） | 一定要處理 |
>
> 實務建議：
>
> - 正式環境建議 `warn` 或 `error`；`debug` 一開日誌可能每秒數百行，磁碟很快被塞滿。
> - 錯誤日誌**不能**像 `access_log off;` 那樣完全關閉；`error_log /dev/null crit;` 是常見的「實質關閉」寫法，但不建議——出問題時會無從查起。

### 常見錯誤日誌訊息

```
# 後端連線失敗
connect() failed (111: Connection refused) while connecting to upstream

# 後端超時
upstream timed out (110: Connection timed out) while reading response header

# 客戶端斷開連線
client prematurely closed connection

# 請求體過大
client intended to send too large body

# 檔案不存在
open() "/var/www/html/favicon.ico" failed (2: No such file or directory)
```

> 這幾條訊息各代表什麼？該查什麼？
>
> - `connect() failed (111: Connection refused)`：後端服務**根本沒在監聽**該 port。
>   - 查：後端行程是否活著（`systemctl status`）、`proxy_pass` 的位址/port 是否打錯、防火牆是否擋住。
>   - 客戶端通常會收到 502 Bad Gateway。
> - `upstream timed out (110: Connection timed out)`：後端有在跑，但**回應太慢**，超過 `proxy_read_timeout`（預設 60 秒）等逾時設定。
>   - 查：後端是否過載、SQL 慢查詢；確認逾時值是否合理。客戶端通常收到 504 Gateway Timeout。
> - `client prematurely closed connection`：客戶端等不及自己斷線（使用者關頁面、App 端逾時）。
>   - 偶發屬正常；大量出現代表回應太慢，使用者等不下去。
> - `client intended to send too large body`：上傳內容超過 `client_max_body_size`（**預設只有 1m**）。
>   - 查：依需求調大，例如 `client_max_body_size 50m;`。客戶端會收到 413。
> - `open() ... failed (2: No such file or directory)`：請求的檔案在磁碟上不存在。
>   - `favicon.ico` 缺檔是經典案例，可補上檔案，或設 `location = /favicon.ico { access_log off; log_not_found off; }` 不再記錄。

---

## 9.4 日誌輪替（Log Rotation）

### 使用 logrotate（推薦）

```bash
# /etc/logrotate.d/nginx
/var/log/nginx/*.log {            # 對 /var/log/nginx/ 下所有 .log 檔套用以下規則
    daily               # 每天輪替一次（可改 weekly / monthly；高流量站台甚至用 hourly）
    missingok           # 檔案不存在也不報錯（例如某站台還沒產生日誌）
    rotate 30           # 保留 30 份舊檔，更舊的自動刪除（daily + rotate 30 = 留 30 天）
    compress            # 用 gzip 壓縮輪替出來的舊日誌（access.log.2.gz ...）
    delaycompress       # 最新一份舊檔（access.log.1）先不壓縮，下一輪才壓
    notifempty          # 日誌是空的就跳過這次輪替（避免產生一堆空檔案）
    create 0640 www-data adm   # 輪替後建立新的空日誌：權限 0640、擁有者 www-data、群組 adm
    sharedscripts       # 多個檔案匹配時，postrotate 腳本只執行一次（而不是每個檔案跑一次）
    postrotate          # 「輪替完成後」要執行的指令，到 endscript 為止
        # 輪替後通知 Nginx 重新開啟日誌檔案
        if [ -f /var/run/nginx.pid ]; then            # 先確認 Nginx 有在跑（PID 檔存在）
            kill -USR1 `cat /var/run/nginx.pid`       # 對 master 行程送 USR1 信號 = 重新開啟日誌檔
        fi
    endscript
}
```

> 這份設定的幾個關鍵問答：
>
> - **為什麼需要 `postrotate` 送 USR1？**
>   logrotate 是把 `access.log` **改名**成 `access.log.1`，但 Nginx 手上的檔案描述符還指向原本的檔案（inode），會繼續往改名後的舊檔寫。`USR1` 是 Nginx 約定的「重新開啟日誌檔」信號，收到後才會建立並改寫新的 `access.log`。**漏掉這段，輪替形同失效。**
> - **為什麼要 `delaycompress`？**
>   承上，從「改名」到「Nginx 收到 USR1」之間有極短時間仍在寫舊檔；若立刻壓縮可能遺失這幾筆。延後一輪再壓最安全。
> - **`create 0640 www-data adm` 的權限怎麼讀？**
>   `0640` = 擁有者可讀寫、群組唯讀、其他人不可讀；`www-data` 要與 Nginx worker 的執行使用者一致（CentOS/RHEL 通常是 `nginx`），否則新日誌可能寫不進去；`adm` 是 Debian/Ubuntu 慣例的日誌管理群組。
> - **`rotate 30` 要設多少？**
>   依法規/稽核需求與磁碟空間權衡：一般網站常見 14~30 天，金融或合規場景可能要 90~180 天（建議搭配集中式日誌系統）。

```bash
# 手動執行輪替測試
sudo logrotate -d /etc/logrotate.d/nginx   # -d = debug 乾跑：只「印出會做什麼」，不實際動檔案，用來驗證設定
sudo logrotate -f /etc/logrotate.d/nginx   # -f = force 強制輪替：不管時間條件到了沒都執行一次，用來實測效果
```

> 驗證輪替是否成功：執行 `-f` 後用 `ls -lh /var/log/nginx/` 確認出現 `access.log.1`，且新的 `access.log` 檔案大小從 0 開始增長（代表 Nginx 已切到新檔）。

### 手動輪替

```bash
# 1. 移動日誌檔案（mv 只改名、不動 inode，Nginx 此刻仍寫往舊檔，服務不中斷）
mv /var/log/nginx/access.log /var/log/nginx/access.log.$(date +%Y%m%d)
#                                              └ $(date +%Y%m%d) 會展開成今天日期，例如 access.log.20260610

# 2. 通知 Nginx 重新開啟日誌（兩種寫法效果相同，擇一即可）
nginx -s reopen                            # 透過 nginx 指令發送 reopen 信號
# 或
kill -USR1 $(cat /var/run/nginx.pid)       # 直接對 master 行程的 PID 送 USR1 信號

# 3. 壓縮舊日誌（確認 Nginx 已切換到新檔後再壓，避免漏資料）
gzip /var/log/nginx/access.log.*           # 逐一壓成 .gz，通常可省下 90% 以上空間
```

---

## 9.5 Nginx 狀態監控

### stub_status 模組

```nginx
server {
    listen 80;
    server_name localhost;

    # Nginx 狀態頁面
    location /nginx_status {
        stub_status;          # 啟用狀態頁（Nginx 1.7.5+ 不需要寫成 stub_status on;）
        allow 127.0.0.1;      # 允許本機存取（監控程式通常跑在本機）
        allow 10.0.0.0/8;     # 允許內網網段（例如監控伺服器所在網段）
        deny all;             # 其他來源一律拒絕（回 403）——狀態頁會洩漏流量資訊，務必限制
    }
}
```

> 注意事項：
>
> - `stub_status` 由 `http_stub_status_module` 提供，官方套件預設已內建；可用 `nginx -V 2>&1 | grep stub_status` 確認，沒有就需要重新編譯或改用內建的發行版套件。
> - `allow` / `deny` 由上而下逐條比對，**命中第一條就停止**，所以 `deny all;` 一定放最後。

```bash
# 查看狀態
curl http://localhost/nginx_status

# 輸出範例：
# Active connections: 291
# server accepts handled requests
#  16630948 16630948 31070465
# Reading: 6 Writing: 179 Waiting: 106
```

### 狀態指標說明

```
Active connections  當前活躍的客戶端連線數（包含 Waiting）
accepts             已接受的連線總數
handled             已處理的連線總數（通常與 accepts 相同）
requests            已處理的請求總數
Reading             正在讀取客戶端請求標頭的連線數
Writing             正在寫入回應給客戶端的連線數
Waiting             等待新請求的 Keep-Alive 連線數
```

> 用上面的輸出範例實際解讀一次：
>
> - `Active connections: 291`：此刻有 291 條客戶端連線，且恆等於 `Reading + Writing + Waiting`（6 + 179 + 106 = 291）。
> - `accepts = 16630948`、`handled = 16630948`：兩者相等代表**沒有連線被丟棄**。
>   - 若 `handled < accepts`，代表有連線被接受了卻處理不了——通常是 `worker_connections` 或檔案描述符到頂，需要擴容（參考第二章）。
> - `requests = 31070465`：`requests ÷ handled ≈ 31070465 ÷ 16630948 ≈ 1.87`，平均每條連線處理約 1.87 個請求，代表 Keep-Alive 有被重複使用；若比值趨近 1，可檢查 `keepalive_timeout` 是否太短。
> - `Reading: 6`：正在讀請求標頭的連線很少，正常；此值異常飆高可能是慢速攻擊（Slowloris）或客戶端網路極差。
> - `Writing: 179`：正在回寫回應（含等待後端產生回應）的連線數；持續偏高通常代表**後端處理慢**。
> - `Waiting: 106`：Keep-Alive 閒置連線，等待下一個請求，屬正常現象。
>
> 監控實務：accepts / handled / requests 是**自啟動以來的累計值**（重啟歸零），監控系統（如 Prometheus）會自動換算成每秒速率再判讀。

---

## 9.6 日誌分析

以下指令都假設日誌是 9.2 的 `combined` 格式。awk 預設以空白切欄位，對應關係：
`$1`=客戶端 IP、`$4`=時間（含 `[`）、`$7`=URI、`$9`=狀態碼、`$10`=回應 bytes、`$NF`=最後一個欄位。

### 常用日誌分析指令

```bash
# 1. 找出請求最多的 IP
awk '{print $1}' /var/log/nginx/access.log | sort | uniq -c | sort -rn | head -20
# awk '{print $1}'  → 只取第 1 欄（客戶端 IP）
# sort              → 先排序，讓相同 IP 排在一起（uniq 只能合併「相鄰」的重複行）
# uniq -c           → 合併重複行並在前面加上出現次數
# sort -rn          → 依次數做數值（-n）反向（-r）排序，次數多的排前面
# head -20          → 只看前 20 名

# 2. 找出請求最多的 URL（同上，只是改取第 7 欄 = 請求 URI）
awk '{print $7}' /var/log/nginx/access.log | sort | uniq -c | sort -rn | head -20

# 3. 找出回應時間最長的請求
awk '$NF > 5 {print $0}' /var/log/nginx/access.log   # 超過 5 秒的請求
# $NF 是「最後一欄」；此指令的前提是日誌格式「結尾是純數字的 $request_time」
# （例如 log_format 最後一個欄位寫 $request_time）
# 注意：combined 格式最後一欄是 UA 字串、9.2 的 main 格式結尾是 us=...，
#       這些情況 $NF 不是數字，比較永遠不成立——請先確認自己的格式再用

# 4. 統計 HTTP 狀態碼分佈（第 9 欄 = 狀態碼）
awk '{print $9}' /var/log/nginx/access.log | sort | uniq -c | sort -rn
# 輸出範例： 152340 200 / 3201 404 / 87 502 → 一眼看出錯誤佔比

# 5. 找出所有 5xx 錯誤
awk '$9 >= 500 && $9 < 600' /var/log/nginx/access.log
# 條件式不寫 {action} 時，awk 預設印出整行；這裡列出狀態碼介於 500~599 的完整日誌

# 6. 按小時統計請求數
awk '{print $4}' /var/log/nginx/access.log | cut -d: -f1,2 | uniq -c
# $4 是時間欄位，長相為 [10/Jun/2026:14:23:05
# cut -d: -f1,2 → 以冒號切割，取前兩段 = [10/Jun/2026:14（日期 + 小時）
# uniq -c       → 計算每個「日期+小時」的行數；因日誌本身按時間排序，不需先 sort

# 7. 統計 User-Agent
awk -F'"' '{print $6}' /var/log/nginx/access.log | sort | uniq -c | sort -rn | head -10
# -F'"' → 改用雙引號當分隔符；combined 格式以引號切割後：
#         $2 = 請求行、$4 = Referer、$6 = User-Agent
# 後面同樣是「排序 → 計數 → 反向排序 → 取前 10」的組合
```

> 實務建議：
>
> - 日誌量大時可先用 `tail -n 100000 access.log` 只分析最近一段，或對 `.gz` 舊檔用 `zcat access.log.2.gz | awk ...`。
> - 若採用 9.2 的 JSON 格式，建議改用 `jq` 分析（例如 `jq -r .remote_addr access.log | sort | uniq -c`），比 awk 切欄位可靠。

### 使用 GoAccess 即時分析

```bash
# 安裝 GoAccess（互動式日誌分析工具；-y 表示自動回答 yes，不再逐一確認）
sudo apt install goaccess -y

# 即時終端機模式：在終端機開出互動式儀表板（訪客、URL、狀態碼排行等）
# --log-format=COMBINED → 告訴 GoAccess 日誌是 Nginx 預設 combined 格式（內建支援，免自訂）
goaccess /var/log/nginx/access.log --log-format=COMBINED

# 生成 HTML 報告
# -o /var/www/report.html → 輸出成單一 HTML 報告檔
# --real-time-html        → 持續監看日誌並透過 WebSocket（預設 port 7890）即時更新頁面；
#                            拿掉此參數則只產生「一次性」的靜態報告
goaccess /var/log/nginx/access.log -o /var/www/report.html --log-format=COMBINED --real-time-html

# 搭配 Nginx 提供報告頁面（以下為 Nginx 設定，放進 server 區塊）
# location = /report {                              # 用 = 精確匹配 /report 這個路徑
#     alias /var/www/report.html;                   # alias 直接對應到單一檔案
#     auth_basic "Stats";                           # 啟用 Basic 認證（報告含流量細節，不可公開）
#     auth_basic_user_file /etc/nginx/.htpasswd;    # 帳密檔（htpasswd 工具產生）
# }
```

---

## 9.7 整合監控系統

### Prometheus + Nginx Exporter

```bash
# 安裝 nginx-prometheus-exporter（把 stub_status 轉成 Prometheus 指標格式）
docker run -d --name nginx-exporter \
    -p 9113:9113 \
    nginx/nginx-prometheus-exporter:latest \
    -nginx.scrape-uri=http://host.docker.internal/nginx_status
# 逐行說明：
# docker run -d --name nginx-exporter → 背景（-d）執行容器，命名為 nginx-exporter 方便管理
# -p 9113:9113                        → 把容器的 9113 port 映射到主機（exporter 的慣用 port）
# nginx/nginx-prometheus-exporter:latest → 官方 exporter 映像檔
# -nginx.scrape-uri=...               → 告訴 exporter 去哪裡抓 9.5 設定的 stub_status 頁面
#
# 注意：host.docker.internal 在 Docker Desktop（macOS/Windows）可直接使用；
#       Linux 上需加 --add-host=host.docker.internal:host-gateway，
#       或直接改填主機 IP。同時 stub_status 的 allow 清單要放行容器來源 IP。
```

```yaml
# prometheus.yml（Prometheus 主設定檔的抓取目標設定）
scrape_configs:
  - job_name: 'nginx'                  # 任務名稱，會成為指標上的 job 標籤
    static_configs:
      - targets: ['localhost:9113']    # 去 9113 port 抓 exporter 吐出的指標（預設每 15 秒一次）
```

> 驗證整條鏈路是否通：
>
> ```bash
> curl http://localhost/nginx_status        # 1. stub_status 本身有回應
> curl http://localhost:9113/metrics        # 2. exporter 有把它轉成 nginx_connections_active 等指標
> ```
>
> 之後在 Prometheus 的 Targets 頁面看到 nginx job 為 UP，即可在 Grafana 匯入現成的 Nginx 儀表板。

### 監控重點指標

```
1. 請求速率（Requests per second）
   - 突然飆高可能是攻擊
   - 突然降低可能是服務異常

2. 錯誤率（Error rate）
   - 4xx 比例 → 客戶端問題（路由設定、權限）
   - 5xx 比例 → 伺服器問題（後端崩潰、資源不足）

3. 回應時間（Response time）
   - P50、P95、P99 分佈
   - 突然升高 → 後端效能問題或資源瓶頸

4. 活躍連線數（Active connections）
   - 接近 worker_connections 上限 → 需要擴容

5. 上游伺服器狀態（Upstream status）
   - 某台持續失敗 → 需要排查該伺服器
```

> 補充：P50 / P95 / P99 怎麼讀？
>
> - P50（中位數）：一半的請求比這個值快——代表「一般使用者」的體感。
> - P95：95% 的請求比這個值快——常用的服務水準（SLO）指標。
> - P99：最慢的 1% 請求——平均值看起來正常時，P99 往往最早暴露問題（慢查詢、GC 停頓）。
> - 實務上告警建議盯 **5xx 錯誤率** 與 **P95/P99 回應時間**，而不是平均值。

---

## 9.8 告警設定

### 簡易的日誌監控腳本

```bash
#!/bin/bash
# /opt/scripts/nginx-alert.sh

LOG_FILE="/var/log/nginx/access.log"    # 要分析的存取日誌路徑
ALERT_EMAIL="admin@mysite.com"          # 告警收件人
THRESHOLD_5XX=50        # 5xx 錯誤數量閾值：5 分鐘內超過 50 筆就告警
THRESHOLD_CONN=1000     # 活躍連線數閾值：超過 1000 條就告警（依 worker_connections 容量調整）

# 檢查最近 5 分鐘的 5xx 錯誤數
# date -d '5 minutes ago' 是 GNU date 語法（Linux 可用；macOS 要改用 date -v-5M）
# '+%d/%b/%Y:%H:%M' 輸出與日誌時間欄位相同的格式，例如 10/Jun/2026:14:18
FIVE_MINUTES_AGO=$(date -d '5 minutes ago' '+%d/%b/%Y:%H:%M')
# awk -v time="..."   → 把 shell 變數傳進 awk，awk 內以 time 取用
# $4 >= "["time       → "[" 與 time 字串相接後，與第 4 欄（如 [10/Jun/2026:14:20:31）做字串比較，
#                        篩出「時間在 5 分鐘前之後」的行
# && $9 >= 500 && $9 < 600 → 且狀態碼是 5xx
# wc -l               → 計算符合條件的行數
ERROR_COUNT=$(awk -v time="$FIVE_MINUTES_AGO" '$4 >= "["time && $9 >= 500 && $9 < 600' $LOG_FILE | wc -l)
# 注意：字串比較對 %d/%b/%Y 這種「日/月名/年」格式只在同一天內可靠（跨日、跨月時
#       字典序與時間順序不一致）。正式環境建議改用 $time_iso8601 的 JSON 日誌，
#       或交給 Prometheus 這類監控系統處理。

if [ "$ERROR_COUNT" -gt "$THRESHOLD_5XX" ]; then        # -gt = 大於（整數比較）
    echo "ALERT: $ERROR_COUNT 5xx errors in last 5 minutes" | \
        mail -s "Nginx 5xx Alert" $ALERT_EMAIL          # mail -s 設定主旨並寄出（主機需先設定好 MTA，如 postfix）
fi

# 檢查活躍連線數
# curl -s            → 靜默模式，不輸出進度資訊
# awk '/Active/ ...' → 找到含 Active 的那行（Active connections: 291），印出第 3 欄 = 291
ACTIVE_CONN=$(curl -s http://localhost/nginx_status | awk '/Active/ {print $3}')

if [ "$ACTIVE_CONN" -gt "$THRESHOLD_CONN" ]; then
    echo "ALERT: Active connections: $ACTIVE_CONN" | \
        mail -s "Nginx High Connections Alert" $ALERT_EMAIL
fi
```

```bash
# 加入 cron 每 5 分鐘執行（用 crontab -e 編輯後貼上）
*/5 * * * * /opt/scripts/nginx-alert.sh
# cron 五個欄位依序是：分 時 日 月 星期
# */5 在「分」的位置 = 每 5 分鐘執行一次；其餘 * 代表不限制
# 別忘了先給腳本執行權限：chmod +x /opt/scripts/nginx-alert.sh
```

---

## 9.9 實際情境

### 情境一：磁碟空間被日誌塞滿

**問題**：伺服器磁碟空間不足，影響服務運作

```bash
# 1. 確認日誌大小
du -sh /var/log/nginx/*        # -s 只顯示總計、-h 以人類可讀單位（K/M/G）列出各日誌檔大小

# 2. 緊急清理（不中斷服務）
# 不要直接刪除正在寫入的日誌！
# 錯誤做法：rm /var/log/nginx/access.log
#   → Nginx 的檔案描述符仍指向被刪除的 inode，會繼續寫入「看不見的檔案」，
#     空間不會釋放（df 看起來還是滿的），直到 Nginx 重啟或 reopen 為止
# 正確做法（兩種擇一）：
> /var/log/nginx/access.log    # 用 shell 重導向把檔案內容清空為 0 bytes，inode 不變，Nginx 可繼續正常寫入
# 或
truncate -s 0 /var/log/nginx/access.log   # truncate 指令把檔案截斷成 0 bytes（-s 0 = 目標大小為 0），效果相同

# 3. 設定 logrotate 防止再次發生
# 確認 /etc/logrotate.d/nginx 設定正確（參考 9.4 的逐行說明）
sudo logrotate -f /etc/logrotate.d/nginx   # 強制執行一次輪替，立即釋放空間並驗證設定有效
```

```nginx
# 4. 考慮減少日誌量（以下為 Nginx 設定，放進 server 區塊）
# 靜態資源（圖檔、CSS、JS）通常量大又沒有分析價值，關閉其存取日誌可大幅減量
location ~* \.(js|css|png|jpg|gif|ico)$ {   # ~* = 不分大小寫的正規匹配，命中常見靜態資源副檔名
    access_log off;                          # 此類請求不寫存取日誌
}
```

### 情境二：分析異常流量來源

**問題**：網站流量突然暴增，需要分析來源

```bash
# 1. 按 IP 統計請求數（最近 1 小時）
HOUR_AGO=$(date -d '1 hour ago' '+%d/%b/%Y:%H')      # 產生 1 小時前的「日期:小時」字串，如 10/Jun/2026:13
awk -v time="$HOUR_AGO" '$4 >= "["time' /var/log/nginx/access.log | \
    awk '{print $1}' | sort | uniq -c | sort -rn | head -20
# 第一個 awk：篩出時間欄位（$4）在 1 小時前之後的行（字串比較，限制同 9.8 的注意事項）
# 第二個 awk 之後：取 IP → 排序 → 計數 → 依次數排序 → 取前 20 名（同 9.6 的指令 1）

# 2. 分析異常 IP 的請求模式
grep "1.2.3.4" /var/log/nginx/access.log | tail -50
# grep 撈出該 IP 的所有日誌行，tail -50 只看最近 50 筆
# 觀察重點：是否狂打同一個 URI、間隔是否規律（腳本特徵）、狀態碼是否大量 404（掃描器特徵）

# 3. 檢查是否為爬蟲
grep "1.2.3.4" /var/log/nginx/access.log | awk -F'"' '{print $6}' | sort -u
# 以雙引號切欄取 $6（User-Agent），sort -u 去除重複只留不同的 UA
# 正常瀏覽器 UA 固定；一個 IP 出現大量不同 UA，或 UA 是 python-requests/curl，多半是程式行為

# 4. 必要時封鎖惡意 IP
echo "deny 1.2.3.4;" >> /etc/nginx/conf.d/blocked-ips.conf   # 把 deny 指令「附加」（>>）到封鎖清單設定檔
sudo nginx -t && sudo nginx -s reload                        # 先驗證語法，通過才重載（&& 確保前者成功才執行後者）
# 之後該 IP 的請求會收到 403；封鎖清單集中放一個檔案，方便管理與解除
```

### 情境三：追蹤特定使用者的請求鏈路

```nginx
# 使用 request_id 追蹤請求
log_format traced '$remote_addr [$time_local] '
                  '"$request" $status $body_bytes_sent '
                  'request_id=$request_id '         # Nginx 為每個請求產生的唯一 ID（32 字元十六進位亂數）
                  'trace_id=$http_x_trace_id';      # 讀取請求標頭 X-Trace-Id 的值（前端或上游服務帶來的追蹤 ID，沒有則為 -）

server {
    # 生成唯一請求 ID 並回給客戶端（add_header 加在「回應」標頭，讓客戶端拿得到、可回報客服）
    add_header X-Request-ID $request_id;

    location /api/ {
        proxy_pass http://backend;
        # 將 request_id 傳給後端（proxy_set_header 加在「轉發給後端的請求」標頭）
        # 後端把這個 ID 一起寫進自己的日誌，就能跨系統用同一個 ID 串起整條鏈路
        proxy_set_header X-Request-ID $request_id;
    }
}
```

> 這套追蹤機制的運作流程：
>
> 1. 請求進來，Nginx 產生 `$request_id`（例如 `444535f9378a3dfa1b8604bc9e05a303`）。
> 2. `add_header` 把它放進**回應**標頭 → 客戶端／使用者拿到 ID，出問題時回報這串值。
> 3. `proxy_set_header` 把它放進**轉發給後端的請求**標頭 → 後端應用程式記進自己的日誌。
> 4. `log_format traced` 把它寫進 Nginx 存取日誌 → 三方（客戶端、Nginx、後端）共用同一個 ID。
>
> 注意 `add_header` 與 `proxy_set_header` 方向相反：前者是「給客戶端的回應」、後者是「給後端的請求」，兩行缺一不可。
> 若希望 4xx/5xx 錯誤回應也帶上 ID（排錯時最需要），請寫成 `add_header X-Request-ID $request_id always;`。

```bash
# 用 request_id 追蹤完整的請求鏈路
grep "request_id=abc123" /var/log/nginx/access.log
# 拿使用者回報的 ID 直接搜尋日誌，定位到那「一筆」請求的完整記錄；
# 再拿同一個 ID 去搜後端應用程式的日誌，即可還原整條請求鏈路
```

---

## 9.10 本章小結

- 日誌是排查問題的第一手資料，務必妥善設定
- JSON 格式的日誌方便後續工具分析
- logrotate 防止日誌檔案無限膨脹
- stub_status 提供基本的 Nginx 運行指標
- GoAccess 是快速分析日誌的好工具
- 整合 Prometheus + Grafana 實現完整的監控告警
- 使用 request_id 追蹤分散式系統的請求鏈路

---

> 上一章：[安全性設定與防護](./08-security.md) | 下一章：[上線網站問題排查](./10-troubleshooting.md)
