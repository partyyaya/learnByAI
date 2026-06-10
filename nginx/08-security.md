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

> 閱讀提示：
>
> - 安全防護是「分層」的概念，每一層只擋一部分攻擊，疊起來才有整體效果。
> - 本章聚焦 Nginx 層能做的事；SSL/TLS 的加密套件與憑證設定請參考[第六章](./06-ssl-https.md)。
> - 所有設定修改後，務必先 `sudo nginx -t` 測試語法，再 `sudo nginx -s reload` 套用。

---

## 8.2 隱藏伺服器資訊

```nginx
http {
    # 隱藏 Nginx 版本號（回應標頭只顯示 Server: nginx，不顯示 nginx/1.24.0）
    server_tokens off;

    # 隱藏後端伺服器資訊（拿掉後端回應中的 X-Powered-By，例如 PHP/8.2、Express）
    proxy_hide_header X-Powered-By;
    # 拿掉後端回應中的 Server 標頭（避免洩漏後端是 Apache/Tomcat 等）
    proxy_hide_header Server;

    # 自訂 Server 標頭（需要 headers-more 模組）
    # more_set_headers "Server: MyServer";
}
```

### 這段指令在做什麼？（逐條）

- `server_tokens off;`
  - 預設值是 `on`，回應標頭與錯誤頁面會顯示完整版本號，例如 `Server: nginx/1.24.0`。
  - 設為 `off` 後只顯示 `Server: nginx`，錯誤頁面（404、500）底部也不再帶版本號。
  - 為什麼要關？攻擊者常先掃描版本號，再針對該版本的已知漏洞（CVE）發動攻擊。隱藏版本號能增加攻擊成本。
  - 不設會怎樣？版本資訊直接暴露，等於告訴攻擊者「我可能有哪些漏洞」。
- `proxy_hide_header X-Powered-By;`
  - `proxy_hide_header` 的作用：Nginx 轉發後端回應給客戶端時，把指定的回應標頭移除。
  - `X-Powered-By` 常見值如 `PHP/8.2.7`、`Express`，會洩漏後端技術棧與版本。
- `proxy_hide_header Server;`
  - 移除後端自己帶的 `Server` 標頭（例如 `Apache/2.4.57`），客戶端只會看到 Nginx 自己的 `Server` 標頭。
- `more_set_headers "Server: MyServer";`
  - 開源版 Nginx 的 `server_tokens off` 只能隱藏版本號，**無法完全移除或改寫 `Server: nginx`**。
  - 若想把 `Server` 改成自訂值或完全移除，需要第三方模組 `headers-more-nginx-module`（所以這行預設是註解狀態）。

> 驗證方式：
>
> ```bash
> # -I 只取回應標頭；觀察 Server 與 X-Powered-By 是否還在
> curl -I http://myapp.com
> ```
>
> 實務建議：隱藏版本號屬於「增加攻擊成本」的手段（security by obscurity），不能取代「定期更新 Nginx 修補漏洞」這件事，兩者要同時做。

---

## 8.3 安全標頭設定

```nginx
server {
    # 防止點擊劫持（Clickjacking）：只允許同網域頁面用 iframe 嵌入本站
    add_header X-Frame-Options "SAMEORIGIN" always;

    # 防止 MIME 類型嗅探：要求瀏覽器嚴格依照 Content-Type 處理回應
    add_header X-Content-Type-Options "nosniff" always;

    # XSS 防護（舊版瀏覽器用；現代瀏覽器已改用 CSP，見下方說明）
    add_header X-XSS-Protection "1; mode=block" always;

    # 強制 HTTPS（HSTS）：要求瀏覽器在 max-age 期間內一律改用 HTTPS 連線
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;

    # 控制 Referer 資訊：跨站請求只送出來源網域，不送完整網址
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # 權限政策：禁用相機、麥克風、定位等瀏覽器 API
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;

    # 內容安全策略（CSP）：白名單機制，限制頁面只能載入指定來源的資源
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.example.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' https://fonts.gstatic.com;" always;
}
```

### 這段指令在做什麼？（逐條）

先看共同的部分——`add_header <名稱> <值> always;`：

- `add_header` 在回應中加入一個標頭；`always` 表示**不論狀態碼**（含 404、500 等錯誤頁）都要加。
- 不加 `always` 會怎樣？預設只在 200、204、301、302 等「成功類」回應加標頭，錯誤頁就沒有保護，攻擊者可故意觸發錯誤頁繞過防護。安全標頭一律建議加 `always`。

逐一說明每個標頭：

- `X-Frame-Options "SAMEORIGIN"`
  - 控制本站頁面能否被 `<iframe>` 嵌入。`SAMEORIGIN` = 只允許同網域嵌入；另一個常用值 `DENY` = 完全禁止嵌入。
  - 防什麼？點擊劫持（Clickjacking）：攻擊者把你的網站藏在透明 iframe 下，誘騙使用者點擊。
  - 不設會怎樣？任何網站都能用 iframe 包住你的頁面進行誘騙。
- `X-Content-Type-Options "nosniff"`
  - `nosniff` 是唯一合法值，要求瀏覽器不要「猜」檔案類型。
  - 防什麼？瀏覽器的 MIME 嗅探可能把使用者上傳的圖片猜成 HTML/JS 執行，造成 XSS。
- `X-XSS-Protection "1; mode=block"`
  - `1` = 啟用瀏覽器內建 XSS 過濾器；`mode=block` = 偵測到攻擊時直接擋下整頁，而不是嘗試清洗。
  - **注意**：這是給舊版瀏覽器（IE、舊版 Chrome）的標頭，Chrome、Edge、Firefox 現代版本已移除此功能，改以 CSP 為主。保留它不會有害，但別把它當成主要防線。
- `Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"`（HSTS）
  - `max-age=63072000`：單位是**秒**，63072000 秒 = 730 天 = 2 年。瀏覽器記住「這個網站只能走 HTTPS」的有效期間。建議值至少 1 年（31536000）。
  - `includeSubDomains`：所有子網域也一併強制 HTTPS。**設定前請確認所有子網域都已支援 HTTPS**，否則子網域會直接無法存取。
  - `preload`：申請加入瀏覽器內建的 HSTS 預載清單（hstspreload.org），連第一次訪問都強制 HTTPS。**加入後幾乎無法快速移除**，請確定全站長期支援 HTTPS 再加。
  - 此標頭只在 HTTPS 回應中有效，需搭配[第六章](./06-ssl-https.md)的 SSL 設定。
- `Referrer-Policy "strict-origin-when-cross-origin"`
  - 同網域跳轉：送出完整網址；跨網域跳轉：只送網域（origin）；HTTPS 跳到 HTTP：完全不送。
  - 防什麼？避免網址中的敏感資訊（例如 `?token=...`、內部路徑）經 Referer 標頭外洩給第三方網站。
- `Permissions-Policy "camera=(), microphone=(), geolocation=()"`
  - 格式為 `功能=(允許來源清單)`；`()` 空括號 = 任何來源（包含自己）都不允許使用該 API。
  - 一般網站用不到相機/麥克風/定位，直接全部關閉可縮小攻擊面；若有需要可改成 `camera=(self)`。
- `Content-Security-Policy "..."`（CSP）
  - 白名單機制，逐類資源限制可載入的來源，是目前對抗 XSS 最有效的標頭。逐段解讀範例中的值：
    - `default-src 'self'`：所有未明確指定的資源類型，預設只能從同網域載入。
    - `script-src 'self' 'unsafe-inline' https://cdn.example.com`：JS 只能來自同網域、行內腳本與指定 CDN。`'unsafe-inline'` 允許 `<script>...</script>` 行內腳本——**這會大幅削弱 CSP 的 XSS 防護**，是為了相容舊程式碼的妥協，長期應改用 nonce 或 hash。
    - `style-src 'self' 'unsafe-inline'`：CSS 只能來自同網域與行內樣式。
    - `img-src 'self' data: https:`：圖片允許同網域、`data:` URI（Base64 內嵌圖）與任何 HTTPS 來源。
    - `font-src 'self' https://fonts.gstatic.com`：字型允許同網域與 Google Fonts。
  - 不設會怎樣？頁面一旦被注入惡意 `<script>`，瀏覽器會照常執行；有 CSP 時，非白名單來源的腳本會被擋下。
  - 實務建議：CSP 規則錯誤會直接弄壞網站（JS/CSS 載不進來）。上線前可先用 `Content-Security-Policy-Report-Only` 標頭觀察違規回報，確認無誤再切換成正式 CSP。

> 常見錯誤：`add_header` 的繼承陷阱
>
> - 規則：某個 `location` 區塊裡**只要出現任何一個** `add_header`，就**不再繼承** server/http 層的所有 `add_header`。
> - 症狀：你在 `server` 層設好了 7 個安全標頭，結果某個 `location` 加了一行 `add_header Cache-Control ...;`，該路徑的安全標頭就全部消失了。
> - 解法：把安全標頭做成片段檔（見下方），在每個有自訂 `add_header` 的區塊重新 `include` 一次。

### 建立安全標頭片段

```nginx
# /etc/nginx/snippets/security-headers.conf
# 把共用的安全標頭集中成一個片段檔，避免每個 server 重複貼一次
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-XSS-Protection "1; mode=block" always;
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;

# 使用方式
server {
    include snippets/security-headers.conf;  # 引入片段檔，等同把上面內容貼進來
    # ...
}
```

> 驗證方式：
>
> ```bash
> # 檢查回應標頭是否包含上述安全標頭
> curl -I https://myapp.com
>
> # 連錯誤頁也要驗證（確認 always 有生效）
> curl -I https://myapp.com/not-exist-page
> ```
>
> 也可以用線上工具 [securityheaders.com](https://securityheaders.com) 對網站做整體評分。

---

## 8.4 速率限制（Rate Limiting）

防止暴力攻擊與 DDoS：

```nginx
http {
    # 定義限制區域：每個 IP 每秒 10 個請求
    # $binary_remote_addr = 用「二進位格式的客戶端 IP」當計數 key
    # zone=general:10m   = 共享記憶體區名稱 general，大小 10MB
    # rate=10r/s         = 每秒 10 個請求（r/s = requests per second）
    limit_req_zone $binary_remote_addr zone=general:10m rate=10r/s;

    # API 限制：每個 IP 每秒 5 個請求
    limit_req_zone $binary_remote_addr zone=api:10m rate=5r/s;

    # 登入限制：每個 IP 每分鐘 5 個請求（r/m = requests per minute）
    limit_req_zone $binary_remote_addr zone=login:10m rate=5r/m;

    # 連線數限制：只定義計數空間，上限數字在 location 的 limit_conn 指定
    limit_conn_zone $binary_remote_addr zone=conn_per_ip:10m;

    # 自訂超出限制的回應狀態碼（預設是 503，改 429 語意更正確）
    limit_req_status 429;
    limit_conn_status 429;

    server {
        listen 80;
        server_name myapp.com;

        # 一般頁面
        location / {
            limit_req zone=general burst=20 nodelay;  # 套用 general 區域；允許瞬間多 20 個請求
            limit_conn conn_per_ip 50;                # 每個 IP 最多 50 條同時連線
            # ...
        }

        # API 端點
        location /api/ {
            limit_req zone=api burst=10 nodelay;      # API 較嚴：5r/s + 緩衝 10 個
            # ...
        }

        # 登入頁面（嚴格限制）
        location /login {
            limit_req zone=login burst=3 nodelay;     # 登入最嚴：每分鐘 5 次 + 緩衝 3 個
            # ...
        }
    }
}
```

### 這段指令在做什麼？（逐條）

- `limit_req_zone $binary_remote_addr zone=general:10m rate=10r/s;`
  - 這行只「定義規則」，放在 `http` 區塊；實際「套用」靠 `location` 裡的 `limit_req`。
  - `$binary_remote_addr`：客戶端 IP 的二進位形式。為什麼不用 `$remote_addr`？因為二進位 IPv4 固定 4 bytes，文字形式最長 15 bytes（如 `203.113.250.140`），用二進位能在同樣記憶體裡記錄更多 IP。
  - `zone=general:10m`：`general` 是區域名稱（後面 `limit_req zone=general` 引用它）；`10m` 是共享記憶體大小，單位 MB。官方估算 1MB 約可存 16,000 個 IPv4 狀態，10MB 約 160,000 個 IP，一般網站綽綽有餘。
  - 記憶體用完會怎樣？Nginx 會回收最舊的紀錄；若仍不足，新請求會直接被拒絕，所以高流量站台可酌量加大。
  - `rate=10r/s`：平均速率上限。Nginx 內部以毫秒精度執行，`10r/s` 實際上是「每 100ms 最多放行 1 個請求」，超出的部分交給 `burst` 決定去留。
- `rate=5r/m`（登入區域）
  - `r/m` = 每分鐘請求數。`5r/m` 即「平均每 12 秒才放行 1 個」，適合登入、發簡訊、寄信這類不該頻繁觸發的端點。
- `limit_conn_zone $binary_remote_addr zone=conn_per_ip:10m;`
  - 與 `limit_req_zone` 的差別：`limit_req` 限制「請求頻率」，`limit_conn` 限制「同時連線數」。
  - 連線數上限不在這行設定，而是在套用處：`limit_conn conn_per_ip 50;` = 每個 IP 同時最多 50 條連線。
  - 為什麼設 50？一個瀏覽器分頁通常開 6~8 條連線，50 足夠正常使用者，但能擋住單一 IP 開數百條連線的攻擊。
- `limit_req_status 429;` / `limit_conn_status 429;`
  - 預設超限回 `503 Service Unavailable`，但 503 語意是「伺服器壞了」，會誤導監控系統。
  - `429 Too Many Requests` 才是「你請求太頻繁」的標準狀態碼，客戶端與監控都更容易正確處理。
- `limit_req zone=general burst=20 nodelay;`
  - `burst=20`：允許「瞬間」超過 rate 的請求數，超出 rate 的請求先進入長度 20 的緩衝佇列。
  - `nodelay`：佇列中的請求**立即處理**而不是排隊慢慢放行；只有連 burst 都塞滿時才拒絕（回 429）。
  - 三種組合的行為差異：
    - 只有 `limit_req zone=general;`（無 burst）：超過 rate 的請求一律立即拒絕，對正常使用者太嚴苛（網頁一次載入幾十個資源很常見）。
    - `burst=20`（無 nodelay）：超出的請求排隊，依 rate 一個一個放行——請求不會被拒絕，但會被「拖慢」（每個延遲 100ms 起跳）。
    - `burst=20 nodelay`：超出的請求立刻處理，佇列額度再依 rate 慢慢回補——對使用者體驗最好，是最常用的組合。

### 參數說明

```
rate=10r/s      每秒最多 10 個請求
burst=20        允許瞬間超過 rate 的請求數（排隊等待）
nodelay         burst 中的請求立即處理，不排隊（超過 burst 才拒絕）
```

> 驗證方式：
>
> ```bash
> # 連續發 30 個請求，觀察狀態碼變化（超限的會回 429）
> for i in $(seq 1 30); do
>     curl -s -o /dev/null -w "%{http_code}\n" http://myapp.com/api/
> done
> ```
>
> 實務建議：
>
> - rate 設多少？先觀察正常流量（access log 統計單一 IP 的請求頻率），取「正常尖峰的 2~3 倍」當起點，再逐步收緊。
> - 注意：若使用者在公司 NAT 或行動網路後面，多人會共用同一個出口 IP，rate 設太低會誤傷整群人。
> - 被限流的請求會記錄在 error log（等級 error），可用 `grep "limiting requests" /var/log/nginx/error.log` 觀察。

### 依據不同條件限制

```nginx
# 排除白名單 IP
geo $limit {
    default 1;          # 預設值：1 = 要限制
    10.0.0.0/8 0;      # 內網不限制
    192.168.0.0/16 0;   # 內網不限制
}

map $limit $limit_key {
    0 "";               # 空字串 = 不限制
    1 $binary_remote_addr;
}

limit_req_zone $limit_key zone=api:10m rate=10r/s;
```

### 這段指令在做什麼？（逐條）

- `geo $limit { ... }`
  - `geo` 模組依「客戶端 IP」決定變數值：建立變數 `$limit`，IP 落在哪個網段就取哪個值。
  - `default 1;`：沒匹配到任何網段的 IP，`$limit` = `1`（要限制）。
  - `10.0.0.0/8 0;`：IP 在 `10.0.0.0 ~ 10.255.255.255`（內網）時 `$limit` = `0`（不限制）；`192.168.0.0/16` 同理。
- `map $limit $limit_key { ... }`
  - `map` 把 `$limit` 轉換成 `$limit_key`：`0` → 空字串、`1` → `$binary_remote_addr`。
  - 關鍵原理：**`limit_req_zone` 的 key 是空字串時，該請求不會被計數**。所以白名單 IP 的 key 為空 → 完全跳過限流；其他 IP 用自己的位址當 key → 正常限流。
- `limit_req_zone $limit_key zone=api:10m rate=10r/s;`
  - 與前面範例相同，只是 key 從固定的 `$binary_remote_addr` 換成會「視 IP 而定」的 `$limit_key`，達成白名單效果。

---

## 8.5 IP 存取控制

```nginx
# 允許 / 拒絕特定 IP
location /admin/ {
    allow 10.0.0.0/8;       # 允許內網（10.0.0.0 ~ 10.255.255.255）
    allow 203.0.113.50;     # 允許特定 IP（單一位址可不寫 /32）
    deny all;               # 拒絕其他所有來源（回 403）
    # ...
}

# 封鎖惡意 IP
# /etc/nginx/conf.d/blocked-ips.conf
deny 1.2.3.4;        # 封鎖單一 IP
deny 5.6.7.0/24;     # 封鎖整個網段（5.6.7.0 ~ 5.6.7.255，共 256 個位址）

# 在 http 或 server 區塊中引入
include /etc/nginx/conf.d/blocked-ips.conf;
```

### 這段指令在做什麼？（逐條）

- `allow` / `deny` 的判斷規則：**由上往下逐條比對，第一條匹配的規則生效**，後面的不再看。
  - 所以「白名單模式」的寫法是：先寫一條條 `allow`，最後以 `deny all;` 收尾。
  - 順序寫反會怎樣？若把 `deny all;` 放第一行，所有請求都先匹配到它，後面的 `allow` 永遠不會生效，等於全部封鎖。
- `10.0.0.0/8` 的 `/8` 是 CIDR 表示法：前 8 個位元固定、其餘可變，涵蓋 `10.0.0.0 ~ 10.255.255.255` 約 1,677 萬個位址；`/24` 則涵蓋 256 個位址。
- 被 `deny` 擋下的請求預設回 `403 Forbidden`，並在 error log 留下 `access forbidden by rule` 紀錄。
- 把封鎖清單獨立成 `blocked-ips.conf` 的好處：日後新增封鎖只要改這個檔案再 reload，不必動主設定；也方便用腳本或 fail2ban 自動維護。

> 常見錯誤：Nginx 前面有反向代理或 CDN（如 Cloudflare）時，`$remote_addr` 看到的是代理的 IP，不是真實客戶端 IP，`allow`/`deny` 會判斷錯誤。需搭配 `real_ip` 模組（`set_real_ip_from` + `real_ip_header X-Forwarded-For;`）還原真實 IP 後再做存取控制。

### GeoIP 限制（依國家/地區）

```nginx
# 需要 ngx_http_geoip2_module（第三方模組，需另行安裝；資料庫來自 MaxMind GeoLite2）

# 載入 GeoIP2 資料庫
geoip2 /usr/share/GeoIP/GeoLite2-Country.mmdb {
    auto_reload 5m;    # 每 5 分鐘檢查資料庫檔案是否更新，自動重新載入
    $geoip2_metadata_country_build metadata build_epoch;    # 取得資料庫建檔時間（除錯用）
    # 依 $remote_addr 查出國家代碼存入 $geoip2_data_country_code；查不到時預設 US
    $geoip2_data_country_code default=US source=$remote_addr country iso_code;
}

# 封鎖特定國家
map $geoip2_data_country_code $allowed_country {
    default yes;    # 其他國家：允許
    CN no;          # 國家代碼 CN：封鎖
    RU no;          # 國家代碼 RU：封鎖
}

server {
    if ($allowed_country = no) {
        return 403;     # 被封鎖國家的請求直接回 403
    }
}
```

### 這段指令在做什麼？（逐條）

- `geoip2 /usr/share/GeoIP/GeoLite2-Country.mmdb { ... }`
  - 指定 GeoIP2 國家資料庫的路徑。GeoLite2 是 MaxMind 提供的免費資料庫，需註冊帳號定期下載更新（IP 與國家的對應會變動）。
- `auto_reload 5m;`
  - `5m` = 5 分鐘（Nginx 時間單位：`s` 秒、`m` 分、`h` 小時、`d` 天）。搭配排程更新資料庫檔案時，不必 reload Nginx 就能載入新資料。
- `$geoip2_data_country_code default=US source=$remote_addr country iso_code;`
  - 這行是「定義變數」：以 `source=$remote_addr`（客戶端 IP）查詢，取出 `country iso_code`（ISO 3166-1 兩碼國家代碼，如 `TW`、`JP`、`US`），存入變數 `$geoip2_data_country_code`。
  - `default=US`：查不到（如內網 IP、新分配的 IP 段）時的預設值。實際範例值：來自台灣的請求 → `TW`。
- `map ... $allowed_country { ... }`：把國家代碼翻譯成 `yes`/`no` 的允許旗標，邏輯集中、好維護。
- `if ($allowed_country = no) { return 403; }`
  - 放在 `server` 層，對該站台所有請求生效。`if` + `return` 是 Nginx 中安全的 `if` 用法（複雜邏輯放進 `if` 容易踩雷，但單純 `return` 沒問題）。

> 實務建議：依國家封鎖只能擋掉「沒有特別準備的攻擊者」，對方換個 VPN 或代理就能繞過，請視為輔助手段而非主要防線；也要小心誤傷使用 VPN 的正常使用者。

---

## 8.6 防止常見攻擊

### 防止目錄遍歷

```nginx
# 關閉目錄列表（預設即為 off，明確寫出避免被其他設定覆蓋）
autoindex off;

# 防止存取隱藏檔案（路徑中含 /. 的請求，例如 /.env、/.git/config）
location ~ /\. {
    deny all;            # 一律拒絕（回 403）
    access_log off;      # 不寫存取日誌（這類掃描量大，避免塞爆日誌）
    log_not_found off;   # 檔案不存在時也不寫 error log
}

# 防止存取敏感檔案（依副檔名封鎖）
location ~* \.(env|git|svn|htpasswd|htaccess|bak|swp|old|orig|log|sql)$ {
    deny all;
    access_log off;
    log_not_found off;
}
```

### 這段指令在做什麼？（逐條）

- `autoindex off;`
  - `autoindex on` 時，請求的目錄底下若沒有 `index` 檔案，Nginx 會自動列出目錄內容——等於把檔案結構攤給所有人看。
  - 預設值本來就是 `off`，但明確寫出來可以避免別處（或別人）開啟後忘記關。
- `location ~ /\. { deny all; }`
  - `~` 是區分大小寫的正規表示式匹配；`/\.` 匹配「斜線後接一個點」，即路徑任何一層的隱藏檔案或隱藏目錄。
  - `\.` 的反斜線是跳脫字元，讓 `.` 代表「字面上的點」而非正規表示式的「任意字元」。
  - 防什麼？`.env`（資料庫密碼）、`.git/`（可還原整份原始碼）、`.htpasswd`（密碼雜湊）等檔案一旦被下載，等於整站淪陷。
- `access_log off;` / `log_not_found off;`
  - 全網際網路的掃描器無時無刻在掃 `/.env`、`/.git/config`，這兩行讓這類雜訊不進日誌，保持日誌乾淨好分析。
- `location ~* \.(env|git|svn|...)$`
  - `~*` 是**不區分大小寫**的正規表示式（`.SQL`、`.Bak` 也會被擋）；`$` 表示「以此結尾」。
  - 涵蓋的檔案類型：編輯器暫存檔（`.swp`）、備份檔（`.bak`、`.old`、`.orig`）、資料庫匯出（`.sql`）、日誌（`.log`）——這些常被工程師不小心留在網站根目錄。

> 驗證方式：
>
> ```bash
> # 應該回 403（或 404），絕不能回 200
> curl -I http://myapp.com/.env
> curl -I http://myapp.com/.git/config
> curl -I http://myapp.com/backup.sql
> ```

### 防止 HTTP Request Smuggling

```nginx
# 嚴格解析 HTTP 請求：丟棄名稱含非法字元的標頭（預設即為 on，明確寫出以防被改掉）
ignore_invalid_headers on;

# 限制標頭大小
large_client_header_buffers 4 8k;    # 超大標頭緩衝區：最多 4 個、每個 8KB
client_header_buffer_size 1k;        # 一般標頭緩衝區：1KB（大多數正常請求夠用）
```

### 這段指令在做什麼？（逐條）

- `ignore_invalid_headers on;`
  - HTTP Request Smuggling（請求走私）利用前端代理與後端伺服器對「畸形請求」解析不一致，把惡意請求「夾帶」過去。
  - 設為 `on`（也是預設值）時，Nginx 會直接丟棄名稱不合法的標頭，降低前後端解析歧義。
  - 千萬不要為了相容奇怪的客戶端改成 `off`，那會放行畸形標頭。
- `client_header_buffer_size 1k;`
  - 讀取請求行與標頭的「第一個」緩衝區大小，預設就是 1k。正常請求（一般 Cookie、UA）都裝得下。
- `large_client_header_buffers 4 8k;`
  - 當 1k 不夠用時（超長 URL、超大 Cookie），Nginx 改用這組「大緩衝區」：最多 `4` 個、每個 `8k`。
  - 單一請求行超過 8k → 回 `414 Request-URI Too Large`；單一標頭超過 8k → 回 `400 Bad Request`。
  - 為什麼要限制？超大標頭常見於緩衝區溢位嘗試與資源耗盡攻擊；限制大小等於先天免疫。設太小則會誤傷帶大量 Cookie 的正常使用者（預設 `4 8k` 是平衡點）。

### 防止過大的請求

```nginx
server {
    # 限制請求體大小（防止大檔案攻擊）
    client_max_body_size 10M;            # 超過 10MB 的請求體直接回 413

    # 限制標頭大小
    large_client_header_buffers 4 16k;   # 此站台允許較大標頭：4 個 × 16KB

    # 超時設定（防止慢速攻擊 Slowloris）
    client_body_timeout 10s;     # 讀取請求體時，兩次讀取之間最多等 10 秒
    client_header_timeout 10s;   # 讀取完整請求標頭最多等 10 秒
    send_timeout 10s;            # 傳送回應時，兩次寫入之間最多等 10 秒
}
```

### 這段指令在做什麼？（逐條）

- `client_max_body_size 10M;`
  - 限制請求體（body）大小，單位可用 `k`、`m`/`M`、`g`。預設值是 `1m`，設 `0` 表示不限制（危險，不建議）。
  - 超過限制回 `413 Request Entity Too Large`。
  - 怎麼設？取決於業務：純 API 站台可設 `1M` 甚至更小；有檔案上傳的站台設成「最大允許上傳檔案 + 一點餘裕」。
  - 常見錯誤：使用者回報「上傳檔案失敗、出現 413」，多半就是這個值太小；但也不要因此設成超大值，否則攻擊者可用大量大請求吃光頻寬與磁碟。
- `client_body_timeout 10s;` / `client_header_timeout 10s;`
  - 注意 `client_body_timeout` 計的是「兩次成功讀取之間」的間隔，不是傳完整個 body 的總時間，所以大檔案上傳不會因此中斷。
  - 兩者預設都是 `60s`；收緊到 `10s` 可更快踢掉「故意慢慢傳」的惡意連線。
- `send_timeout 10s;`
  - 對「客戶端收得很慢」的回應傳輸設限（同樣是兩次寫入之間的間隔，預設 `60s`），避免回應端被慢速客戶端長期佔住連線。

### 防止 Slowloris 攻擊

```nginx
http {
    # 限制每個 IP 的連線數
    limit_conn_zone $binary_remote_addr zone=conn_limit:10m;    # 以 IP 為 key 的連線計數區，10MB

    server {
        limit_conn conn_limit 20;      # 每個 IP 最多 20 個同時連線

        # 嚴格的超時設定
        client_body_timeout 5s;        # 比一般建議（10s）更嚴，加速踢掉慢速連線
        client_header_timeout 5s;      # 標頭 5 秒內沒傳完就斷線
        keepalive_timeout 30s;         # Keep-Alive 閒置 30 秒就關閉連線（預設 75s）

        # 限制 Keep-Alive 請求數
        keepalive_requests 100;        # 單條連線最多服務 100 個請求後關閉（預設 1000）
    }
}
```

> 這組設定的防禦原理是什麼？
>
> - Slowloris 的手法：開大量連線，每條都「故意傳得極慢」（例如每 10 秒送 1 個 byte 的標頭），讓伺服器的連線池被「半開連線」佔滿，正常使用者連不進來。
> - 對策一（限數量）：`limit_conn conn_limit 20;` 讓單一 IP 最多佔 20 條連線，攻擊者無法用一台機器佔滿連線池。
> - 對策二（限時間）：`client_header_timeout 5s` 等嚴格逾時，讓「慢慢傳」的連線 5 秒就被踢掉，攻擊成本大增。
> - 對策三（限壽命）：`keepalive_timeout 30s` 與 `keepalive_requests 100` 確保連線會定期回收，不被長期霸佔。
> - 補充：Nginx 的事件驅動架構天生比 Apache（行程/執行緒模型）更耐 Slowloris，但上述設定仍建議套用。
> - 實務建議：5s 的逾時對行動網路使用者偏嚴，若你的用戶常在弱網環境，可放寬到 10s，遭受攻擊時再臨時收緊。

---

## 8.7 HTTP Basic Authentication

```bash
# 安裝密碼工具（htpasswd 由 apache2-utils 套件提供；CentOS/RHEL 用 httpd-tools）
sudo apt install apache2-utils -y

# 建立密碼檔案：-c = create，建立新檔並新增使用者 admin
# 注意：-c 會「覆蓋」既有檔案，只有第一次建檔時使用！
sudo htpasswd -c /etc/nginx/.htpasswd admin
# 輸入密碼（會互動式詢問兩次，密碼以雜湊形式儲存，不是明文）

# 新增更多使用者（不加 -c，附加到既有檔案）
sudo htpasswd /etc/nginx/.htpasswd user2
```

```nginx
# 保護特定路徑
location /admin/ {
    # 搭配 IP 限制：satisfy any = IP 或密碼其一通過即可放行
    # （預設是 satisfy all = IP 與密碼兩者都要通過）
    satisfy any;
    allow 10.0.0.0/8;       # 內網 IP 直接放行，不必輸入密碼
    deny all;               # 其他 IP 不在白名單 → 落到密碼驗證
    auth_basic "Restricted Area";               # 啟用 Basic Auth；字串為瀏覽器彈窗顯示的領域名稱
    auth_basic_user_file /etc/nginx/.htpasswd;  # 指定帳號密碼檔路徑
}

# 排除特定路徑（如健康檢查）
location /admin/health {
    auth_basic off;     # 關閉此路徑的密碼驗證（覆蓋上層繼承的設定）
    return 200 'OK';    # 直接回 200，供監控系統探測
}
```

### 這段指令在做什麼？（逐條）

- `sudo htpasswd -c /etc/nginx/.htpasswd admin`
  - `-c`（create）建立新檔案。**再次強調：對既有檔案使用 `-c` 會把原本所有使用者清掉**，第二個使用者開始請拿掉 `-c`。
  - 建議加上 `-B` 改用 bcrypt 雜湊（`sudo htpasswd -cB ...`），比預設的 MD5 雜湊更耐暴力破解。
  - 密碼檔放在 `/etc/nginx/` 底下而不是網站根目錄，避免被當靜態檔下載（前一節的 `location ~ /\.` 規則也擋了 `.htpasswd`，雙保險）。
- `auth_basic "Restricted Area";`
  - 啟用 HTTP Basic Authentication；`"Restricted Area"` 是 realm（領域）字串，會出現在瀏覽器的帳密彈窗上，內容可自訂。
  - 未通過驗證回 `401 Unauthorized`。
- `auth_basic_user_file /etc/nginx/.htpasswd;`
  - 指定驗證用的帳密檔。注意 Nginx worker 的執行身分（如 `www-data`）必須對此檔有讀取權限，否則所有登入都會失敗並在 error log 出現 permission denied。
- `satisfy any;` + `allow` / `deny`
  - `satisfy` 決定「多重驗證條件」的邏輯：`all`（預設）= IP 與密碼**都要**通過；`any` = **任一**通過即可。
  - 此例效果：內網（`10.0.0.0/8`）免密碼直接進；外網則輸入正確帳密也能進。
  - 若想要「只有內網能連，且還要輸密碼」，把 `satisfy any;` 拿掉（用預設的 `all`）即可。
- `auth_basic off;`
  - `auth_basic` 會被下層 location 繼承；健康檢查端點若不排除，監控系統會一直收到 401。`off` 明確關閉該路徑的驗證。

> 常見錯誤：同一個區塊內重複寫兩次 `auth_basic` 或 `auth_basic_user_file`，`nginx -t` 會直接報錯 `"auth_basic" directive is duplicate`，每個區塊各寫一次即可。
>
> 安全提醒：Basic Auth 的帳密是以 Base64 明文傳輸（不是加密），**務必只在 HTTPS 站台使用**，否則中途任何人都能攔截還原出密碼。
>
> 驗證方式：
>
> ```bash
> # 未帶帳密 → 應回 401
> curl -I http://myapp.com/admin/
>
> # 帶上正確帳密 → 應回 200
> curl -I -u admin:你的密碼 http://myapp.com/admin/
>
> # 健康檢查不需帳密 → 應回 200
> curl -I http://myapp.com/admin/health
> ```

---

## 8.8 防盜連（Hotlink Protection）

```nginx
# 防止其他網站直接引用你的圖片
location ~* \.(jpg|jpeg|png|gif|webp|svg)$ {
    # 定義「合法的 Referer 來源」清單
    valid_referers none blocked server_names
        *.mysite.com
        mysite.com;

    # Referer 不在合法清單時，$invalid_referer 為 "1"
    if ($invalid_referer) {
        return 403;
        # 或者導向一張預設圖片
        # rewrite ^/.*$ /images/hotlink-denied.jpg last;
    }

    expires 30d;    # 合法請求的圖片快取 30 天（盜連防護與快取設定可並存）
}
```

### 這段指令在做什麼？（逐條）

- `location ~* \.(jpg|jpeg|png|gif|webp|svg)$`
  - 不區分大小寫地匹配常見圖片副檔名（`.JPG`、`.Png` 也會命中），只對圖片請求做防盜連檢查。
- `valid_referers none blocked server_names *.mysite.com mysite.com;`
  - 定義哪些 `Referer` 標頭算「合法」，並據此設定內建變數 `$invalid_referer`。逐個值說明：
    - `none`：請求**沒有** Referer 標頭。使用者直接在網址列輸入圖片網址、或從書籤開啟時就是這種情況——不允許會誤傷正常使用。
    - `blocked`：有 Referer 但內容被防火牆/代理改寫過（不以 `http://` 或 `https://` 開頭）。
    - `server_names`：Referer 來自本設定檔 `server_name` 列出的網域。
    - `*.mysite.com` / `mysite.com`：額外允許的網域，支援 `*` 萬用字元（涵蓋 `www.mysite.com`、`blog.mysite.com` 等子網域）。
- `if ($invalid_referer) { return 403; }`
  - `$invalid_referer`：Referer 合法時為空字串 `""`（條件不成立）、不合法時為 `"1"`（條件成立）。
  - 實際範例：Referer 是 `https://blog.mysite.com/post/1` → 合法、放行；Referer 是 `https://others-site.com/steal` → `$invalid_referer = "1"` → 回 403。
  - 註解中的替代方案 `rewrite ... /images/hotlink-denied.jpg last;`：不回 403，改回一張「請勿盜連」的提示圖（對方網站會顯示這張圖）。啟用時記得把 `return 403;` 註解掉，兩者擇一。
- `expires 30d;`
  - 通過檢查的圖片設定 30 天瀏覽器快取，與第七章的快取策略一致。

> 常見錯誤：使用 `rewrite` 導向提示圖時，`/images/hotlink-denied.jpg` 本身也匹配這個 location，內部重寫後再次檢查 Referer 仍不合法 → 再次重寫 → 無限迴圈（Nginx 重寫 10 次後回 500）。解法是為提示圖另開一個精確匹配的 location：
>
> ```nginx
> location = /images/hotlink-denied.jpg {
>     # 精確匹配優先於正規匹配，提示圖不再走防盜連檢查
>     expires 30d;
> }
> ```
>
> 實務提醒：Referer 由客戶端自由填寫，可輕易偽造；防盜連只能擋「一般網站的直接引用」，擋不了有心人士。另外部分隱私瀏覽器/外掛會拿掉 Referer，這就是清單中要保留 `none` 的原因。
>
> 驗證方式：
>
> ```bash
> # 不帶 Referer（命中 none）→ 應回 200
> curl -I http://mysite.com/images/logo.png
>
> # 帶自家網域 Referer → 應回 200
> curl -I -e "https://www.mysite.com/page" http://mysite.com/images/logo.png
>
> # 帶其他網站 Referer → 應回 403
> curl -I -e "https://evil.com/steal" http://mysite.com/images/logo.png
> ```

---

## 8.9 實際情境

### 情境一：網站遭受 DDoS 攻擊

**症狀**：網站無法訪問，伺服器 CPU 和頻寬飆高

```nginx
# 1. 緊急限流
http {
    # 緊急限流區：每 IP 每秒只放行 2 個請求；20m 可記錄約 32 萬個 IP（攻擊時 IP 量大，加大空間）
    limit_req_zone $binary_remote_addr zone=emergency:20m rate=2r/s;
    # 緊急連線數計數區
    limit_conn_zone $binary_remote_addr zone=emergency_conn:20m;

    server {
        limit_req zone=emergency burst=5 nodelay;   # 緩衝只給 5 個，超出立即回 429/503
        limit_conn emergency_conn 10;               # 每 IP 最多 10 條同時連線

        # 快速拒絕可疑請求：User-Agent 含 bot/crawler/spider/scraper 字樣（~* = 不分大小寫）即回 403
        if ($http_user_agent ~* (bot|crawler|spider|scraper)) {
            return 403;
        }

        # 封鎖最頻繁的攻擊 IP（引入 deny 清單檔）
        include /etc/nginx/conf.d/blocked-ips.conf;
    }
}
```

> 這段緊急設定的取捨（逐條）：
>
> - `rate=2r/s` + `burst=5`：比平時嚴格非常多，會犧牲部分正常使用者體驗（重度使用者可能被限流），屬於「先讓網站活下來」的戰時設定，攻擊結束後記得調回正常值。
> - `$http_user_agent`：內建變數，值為請求的 `User-Agent` 標頭，例如 `Mozilla/5.0 (Windows NT 10.0; ...) Chrome/120.0`。
> - **注意誤傷**：`(bot|crawler|spider)` 也會擋掉 Googlebot、Bingbot 等正規搜尋引擎爬蟲，長期開著會影響 SEO；這條只適合攻擊期間臨時使用。
> - 防爬蟲補充：惡意爬蟲可以偽裝 UA 成正常瀏覽器，UA 過濾只是第一層；更完整的方案要靠速率限制、行為分析或 CDN 的 Bot 管理功能。

```bash
# 2. 找出攻擊來源 IP
# awk '{print $1}'：取出日誌每行第一欄（預設格式中是客戶端 IP）
# sort | uniq -c   ：排序後統計每個 IP 出現次數
# sort -rn         ：依次數由大到小排序（r=反向、n=數值）
# head -20         ：只看前 20 名（請求量最大的 IP）
awk '{print $1}' /var/log/nginx/access.log | sort | uniq -c | sort -rn | head -20

# 3. 封鎖惡意 IP
# 把 deny 規則附加到封鎖清單（>> = 附加不覆蓋；/etc/nginx 需 root 權限，
# 若目前不是 root，請改用：echo "deny 1.2.3.4;" | sudo tee -a /etc/nginx/conf.d/blocked-ips.conf）
echo "deny 1.2.3.4;" >> /etc/nginx/conf.d/blocked-ips.conf
# 先測語法再重載，確保清單格式正確才套用
sudo nginx -t && sudo nginx -s reload

# 4. 如果攻擊量大，考慮使用 CDN（如 Cloudflare）
#    大流量 DDoS 會直接塞爆主機頻寬，Nginx 層擋不住，需要 CDN/清洗中心在上游吸收流量
```

### 情境二：發現有人在暴力破解登入

**症狀**：日誌中大量 POST /login 請求

```nginx
# 嚴格限制登入頁面：3r/m = 平均每 20 秒才放行 1 個請求
limit_req_zone $binary_remote_addr zone=login:10m rate=3r/m;

location /login {
    # burst=5：允許短時間內多 5 次嘗試（涵蓋正常使用者打錯密碼重試），之後回 429
    limit_req zone=login burst=5 nodelay;

    # 失敗回應延遲（讓暴力破解更慢）
    # 這需要搭配後端實作
    proxy_pass http://backend;
}
```

> 為什麼登入頁要用 `r/m` 而不是 `r/s`？
>
> - 正常使用者一分鐘內頂多登入幾次；暴力破解則是每秒嘗試數十、數百組密碼。
> - `rate=3r/m` + `burst=5` 的效果：正常使用者打錯幾次密碼沒感覺，攻擊者一分鐘最多只能試 8 次左右，破解一組密碼的時間從數小時拉長到數年。
> - 限流以 IP 為單位，攻擊者若用殭屍網路換 IP 仍可繞過，所以還要搭配後端的帳號鎖定機制與 fail2ban。

```bash
# 分析登入日誌
# grep "POST /login"：篩出登入請求
# 後續管線同情境一：統計每個 IP 的登入嘗試次數，列出前 10 名
grep "POST /login" /var/log/nginx/access.log | awk '{print $1}' | sort | uniq -c | sort -rn | head -10

# 使用 fail2ban 自動封鎖
# fail2ban 會持續掃描日誌，發現同一 IP 短時間內多次違規就自動寫入防火牆封鎖規則
# /etc/fail2ban/jail.local
# [nginx-login]
# enabled = true                            # 啟用這個 jail（監控規則）
# filter = nginx-login                      # 使用的過濾器（定義在 filter.d/，用正規表示式匹配日誌）
# logpath = /var/log/nginx/access.log       # 要監控的日誌檔
# maxretry = 5                              # 違規次數門檻：5 次
# findtime = 300                            # 統計時間窗：300 秒（5 分鐘內違規 5 次就觸發）
# bantime = 3600                            # 封鎖時長：3600 秒（1 小時），到期自動解封
```

### 情境三：敏感資料外洩

**問題**：使用者可以存取 `.env`、`.git`、備份檔案等

```nginx
# 封鎖所有敏感檔案（.env、.git、.svn、macOS 的 .DS_Store）
location ~ /\.(env|git|svn|DS_Store) {
    deny all;
    return 404;     # 回 404 而非 403：不讓對方知道「檔案其實存在」
}

# 封鎖資料庫匯出與各類備份/暫存檔（依副檔名結尾匹配）
location ~ \.(sql|bak|old|orig|swp|swo|tmp)$ {
    deny all;
    return 404;
}

# 封鎖版本控制目錄（注意結尾的 /：匹配 .git/ 目錄底下的所有檔案）
location ~ /\.(git|svn|hg)/ {
    deny all;
    return 404;
}

# 封鎖設定檔（這些檔案會洩漏依賴版本與建置細節）
location ~ /(composer\.json|package\.json|Makefile|Dockerfile) {
    deny all;
    return 404;
}
```

> 這組規則的兩個設計重點：
>
> - **為什麼用 `return 404` 而不是只用 `deny all`（403）？**
>   - `403 Forbidden` 等於告訴攻擊者「這個檔案存在，只是你不能看」，反而確認了目標。
>   - `404 Not Found` 讓攻擊者無法分辨「檔案不存在」與「被擋下」，不洩漏任何資訊。
>   - 兩行並存時，`return` 在較早的處理階段（rewrite phase）就生效，客戶端實際收到的是 404；保留 `deny all;` 則是縱深防禦的保險。
> - **與 8.6 規則的差異**：8.6 的版本回 403 並關閉日誌（重點在減少雜訊）；本情境回 404（重點在不洩漏資訊）。實務上可擇一風格，團隊統一即可。
>
> 驗證方式：
>
> ```bash
> # 以下全部都應回 404
> curl -o /dev/null -s -w "%{http_code}\n" http://myapp.com/.env
> curl -o /dev/null -s -w "%{http_code}\n" http://myapp.com/.git/HEAD
> curl -o /dev/null -s -w "%{http_code}\n" http://myapp.com/db-backup.sql
> curl -o /dev/null -s -w "%{http_code}\n" http://myapp.com/package.json
> ```
>
> 實務建議：封鎖規則是「事後補救」，根本解法是**不要把敏感檔案放進網站根目錄**——`.env` 放在 webroot 之外、部署流程排除 `.git`、備份檔不落在對外目錄。

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

> 使用提示：
>
> - 「SSL 設定使用強加密套件」的具體做法（`ssl_protocols TLSv1.2 TLSv1.3;`、`ssl_ciphers` 等）請參考[第六章](./06-ssl-https.md)。
> - 每完成一項，建議用本章各節的 `curl` 驗證指令實際打一次確認，不要只看設定檔。
> - 新站台上線前把這份清單跑一遍；既有站台則建議每季覆查一次（設定可能在多次修改中被改壞）。

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
