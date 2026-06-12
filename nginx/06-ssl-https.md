# 第六章：SSL / HTTPS 憑證設定

## 6.1 為什麼需要 HTTPS？

| 風險 | HTTP | HTTPS |
|------|------|-------|
| 資料被竊聽 | 明文傳輸，可被攔截 | 加密傳輸 |
| 資料被竄改 | 無法偵測竄改 | 完整性驗證 |
| 身份冒充 | 無法驗證伺服器身份 | 憑證驗證 |
| SEO 排名 | Google 降低排名 | 排名加分 |
| 瀏覽器警告 | 顯示「不安全」 | 顯示鎖頭圖示 |

---

## 6.2 使用 Let's Encrypt 免費憑證

### 安裝 Certbot

> Certbot 是 Let's Encrypt 官方常用工具，用來「申請憑證 + 自動續約 +（可選）自動改寫 Nginx 設定」。

#### Certbot 的好處

- **免費且普及**：可快速取得受主流瀏覽器信任的 TLS 憑證。
- **高度自動化**：可自動申請、安裝、續約，降低人工維運成本。
- **整合 Nginx 容易**：`--nginx` 可直接協助設定 HTTPS 與重導向。
- **適合多數網站**：個人站、部落格、公司官網、API 服務都常用。

#### Certbot 的壞處 / 限制

- **憑證有效期短**：Let's Encrypt 憑證通常 90 天，必須確保續約機制正常。
- **有簽發頻率限制**：重複申請或測試過量會碰到 rate limit。
- **需要可驗證網域**：常見驗證方式需公開 DNS 與可連線的 80/443 連接埠。
- **自動改配置有風險**：複雜 Nginx 架構下，`--nginx` 可能不符合既有規範（可改用 `certonly`）。

#### 什麼時候使用 Certbot？

- **建議使用**：
  - 你有公開網域，想快速啟用 HTTPS。
  - 你希望憑證續約自動化，減少手動更新風險。
  - 你使用 Nginx/Apache，且部署環境標準化。

- **不一定適合**：
  - 內網或離線環境（無法完成公開驗證）。
  - 公司政策要求私有 CA、EV/OV 憑證或特定商業憑證流程。
  - 你需要高度客製化簽發流程（可考慮 ACME client 進階方案）。

```bash
# Ubuntu
sudo apt install certbot python3-certbot-nginx -y
# certbot                = ACME 客戶端本體，負責向 Let's Encrypt 申請與續約憑證
# python3-certbot-nginx  = Nginx 外掛，讓 certbot 能讀懂並自動修改 Nginx 設定
# -y                     = 安裝過程自動回答 yes，不再逐一詢問

# CentOS
sudo yum install certbot python3-certbot-nginx -y
```

### 自動取得憑證並設定 Nginx

```bash
# Certbot 會自動修改 Nginx 設定
sudo certbot --nginx -d mysite.com -d www.mysite.com
# --nginx        = 使用 Nginx 外掛：自動完成驗證「並且」直接改寫 Nginx 設定加上 SSL 區塊
# -d mysite.com  = 要申請憑證的網域，可重複多次 -d 把多個網域簽進同一張憑證
#                  （這裡 mysite.com 與 www.mysite.com 共用一張憑證）

# 互動式流程會詢問：
# 1. Email 地址（用於到期通知）
# 2. 是否同意服務條款
# 3. 是否將 HTTP 重導向到 HTTPS
```

> 這行指令背後發生了什麼事？
>
> 1. Certbot 向 Let's Encrypt 發起申請，證明「你真的控制這個網域」（HTTP-01 驗證）。
> 2. Let's Encrypt 的伺服器會連到 `http://mysite.com/.well-known/acme-challenge/xxx` 驗證檔案——這就是為什麼 **80 連接埠必須對外開放**。
> 3. 驗證通過後，憑證下載到 `/etc/letsencrypt/live/mysite.com/`。
> 4. `--nginx` 外掛找到 `server_name` 符合的 server block，自動加上 `listen 443 ssl` 與憑證路徑，並依你的選擇加上 HTTP→HTTPS 重導向。
>
> 如果你的 Nginx 設定較複雜（多檔案、include 結構特殊），不希望被自動改寫，請改用下面的 `certonly` 方式。

### 手動取得憑證（不自動修改設定）

```bash
# 使用 webroot 方式驗證
sudo certbot certonly --webroot -w /var/www/mysite.com/html -d mysite.com -d www.mysite.com
# certonly   = 只申請憑證，「不」自動修改任何 Nginx 設定（設定由你自己掌控）
# --webroot  = 驗證方式：把驗證檔寫進現有網站的目錄，由正在運行的 Nginx 對外提供
#              （好處：不需要停掉 Nginx，適合正式環境）
# -w <路徑>  = webroot 路徑，必須是 Nginx 實際對外服務的 root 目錄，
#              Certbot 會在這底下建立 .well-known/acme-challenge/ 供驗證

# 憑證會存放在：
# /etc/letsencrypt/live/mysite.com/fullchain.pem  （完整憑證鏈 = 伺服器憑證 + 中繼憑證）
# /etc/letsencrypt/live/mysite.com/privkey.pem    （私鑰，權限務必保持 600，絕不外流）
# 注意：live/ 底下是符號連結，永遠指向最新一次續約的憑證，
#       所以 Nginx 設定寫這個路徑即可，續約後不必改設定、只需 reload
```

### 設定自動續約

```bash
# 測試續約流程
sudo certbot renew --dry-run
# renew      = 檢查所有已申請的憑證，距離到期 30 天內的才會實際續約
# --dry-run  = 走一遍完整流程但使用測試環境，不會真的簽發憑證
#              （用來確認續約機制正常，且不消耗 Let's Encrypt 的簽發額度）

# 自動續約（Certbot 安裝時通常會自動設定 cron 或 systemd timer）
# 檢查 timer 狀態
sudo systemctl status certbot.timer
# 看到 Active: active (waiting) 代表排程已就緒，會定期自動執行 certbot renew

# 手動添加 cron（如果沒有自動設定）
# 每天凌晨 2 點檢查並續約
echo "0 2 * * * root certbot renew --quiet --post-hook 'systemctl reload nginx'" | sudo tee /etc/cron.d/certbot-renew
# 「0 2 * * *」    = cron 時間格式：分 時 日 月 週 → 每天 02:00 執行
# root             = 以 root 身份執行（/etc/cron.d/ 格式需要指定使用者欄位）
# --quiet          = 安靜模式，沒事不輸出（避免 cron 每天寄無意義的信）
# --post-hook '…'  = 「實際完成續約後」才執行的指令：重載 Nginx 讓新憑證生效
#                    （沒有這行的話，憑證換新了但 Nginx 還在用記憶體中的舊憑證！）
# sudo tee <檔案>  = 以 root 權限把前面 echo 的內容寫入 /etc/cron.d/certbot-renew
```

> **最常見的事故**：續約成功但忘了 reload Nginx。
> Nginx 啟動時會把憑證讀進記憶體，之後磁碟上的憑證換新它並不知道，
> 到期日一過瀏覽器就會跳「憑證過期」。所以 `--post-hook 'systemctl reload nginx'` 務必要設。

---

## 6.3 手動設定 SSL

### 基本 HTTPS 設定

```nginx
server { # 定義一個 HTTPS 網站（server block）
    listen 443 ssl http2; # 監聽 IPv4 的 443 連接埠，啟用 TLS 與 HTTP/2
    listen [::]:443 ssl http2; # 監聽 IPv6 的 443 連接埠，啟用 TLS 與 HTTP/2
    server_name mysite.com www.mysite.com; # 這個設定區塊要處理的網域名稱

    # SSL 憑證
    ssl_certificate /etc/letsencrypt/live/mysite.com/fullchain.pem; # 伺服器憑證 + 中繼憑證鏈
    ssl_certificate_key /etc/letsencrypt/live/mysite.com/privkey.pem; # 對應私鑰（需嚴格保護權限）

    # SSL 設定
    ssl_protocols TLSv1.2 TLSv1.3; # 只允許安全版本 TLS 1.2/1.3，停用舊版協定
    ssl_prefer_server_ciphers on; # TLS 1.2 時優先使用伺服器指定的 cipher 順序
    ssl_ciphers 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384'; # 限定可接受的 TLS 1.2 加密套件

    # SSL 效能優化
    ssl_session_cache shared:SSL:10m; # 啟用 TLS session 快取（多 worker 共用），減少重複握手成本
    ssl_session_timeout 10m; # session 快取有效時間，超過需重新握手
    ssl_session_tickets off; # 關閉 session tickets，避免金鑰輪替不當造成風險

    # OCSP Stapling
    ssl_stapling on; # 由伺服器主動附帶憑證狀態，降低客戶端查詢延遲
    ssl_stapling_verify on; # 驗證 OCSP 回應有效性，避免使用不可信回應
    ssl_trusted_certificate /etc/letsencrypt/live/mysite.com/chain.pem; # 驗證 OCSP 所需的受信任憑證鏈
    resolver 8.8.8.8 8.8.4.4 valid=300s; # 指定 DNS 解析器供 stapling/名稱解析使用，快取 300 秒
    resolver_timeout 5s; # DNS 查詢逾時時間，避免請求被長時間阻塞

    root /var/www/mysite.com/html; # 網站根目錄（靜態檔案預設讀取位置）
    index index.html; # 預設首頁檔名（請求目錄時回傳）
}

# HTTP → HTTPS 重導向
server {
    listen 80;                              # 監聽 IPv4 的 80 連接埠（HTTP）
    listen [::]:80;                         # 監聽 IPv6 的 80 連接埠
    server_name mysite.com www.mysite.com;  # 處理同樣這兩個網域的 HTTP 請求
    return 301 https://$host$request_uri;   # 回傳 301 永久重導向，導去 HTTPS 版本
}
```

> 這份設定怎麼讀？（逐條重點）
>
> **為什麼要兩個 server block？**
> - 第一個處理 HTTPS（443），第二個專門把 HTTP（80）的流量「趕去」HTTPS。
> - 80 連接埠不能關：使用者輸入網址通常不會打 `https://`，而且 Let's Encrypt 驗證也走 80。
>
> **重導向那行的變數**
> - `$host`：請求的網域名稱（例如 `www.mysite.com`），用變數而不寫死，兩個網域都能正確導向。
> - `$request_uri`：原始完整路徑含查詢參數（例如 `/products?page=2`），確保使用者被導去「同一頁」的 HTTPS 版本，而不是被丟回首頁。
> - `301` = 永久重導向，瀏覽器與搜尋引擎會記住；測試階段可先用 `302`（暫時），確認無誤再改 `301`。
>
> **憑證兩行的常見地雷**
> - `ssl_certificate` 一定要用 `fullchain.pem`（伺服器憑證＋中繼憑證）。若只用 `cert.pem`，部分裝置（尤其手機、舊系統）會因為拼不出完整信任鏈而報「憑證無效」。
> - `privkey.pem` 是私鑰，洩漏等於憑證作廢，權限保持 `600`、擁有者 root。
>
> **TLS 協定與加密套件**
> - `ssl_protocols TLSv1.2 TLSv1.3;`：TLS 1.0/1.1 已被瀏覽器與 PCI-DSS 淘汰，不要再開。
> - `ssl_ciphers '…';`：只對 TLS 1.2 生效（TLS 1.3 的套件由 Nginx 內建、不吃這個設定）；清單裡全是 ECDHE 開頭的套件，代表支援前向保密（Forward Secrecy）——就算私鑰未來外洩，過去錄下的流量也解不開。
> - `ssl_prefer_server_ciphers on;`：握手時以「伺服器」的套件順序為準，避免客戶端挑到弱加密。
>
> **Session 快取三行（效能優化的核心）**
> - 完整 TLS 握手需要多次往返與非對稱加密運算，成本高；session 快取讓「回頭客」可以複用上次的加密參數，省掉大半握手成本。
> - `shared:SSL:10m`：`shared` = 所有 worker 行程共用一塊快取；`SSL` 是這塊快取的名字；`10m` = 10MB 記憶體，**1MB 約可存 4,000 個 session**，10MB 約 40,000 個，一般網站綽綽有餘。
> - `ssl_session_timeout 10m;`：這裡的 `10m` 是 **10 分鐘**（時間），跟上面的 10MB（大小）單位不同，別搞混。
> - `ssl_session_tickets off;`：tickets 是另一種 session 復用機制，但金鑰若不定期輪替會削弱前向保密，單機環境直接關掉、用上面的 cache 就好。
>
> **OCSP Stapling 四行**
> - 瀏覽器本來需要自己連 CA 查「這張憑證有沒有被吊銷」（OCSP 查詢），會拖慢第一次連線。
> - `ssl_stapling on;` 改成由 Nginx 定期去 CA 查好，把結果「釘」在 TLS 握手裡一起給瀏覽器，省掉這趟查詢。
> - `ssl_trusted_certificate …chain.pem;`：驗證 OCSP 回應真偽所需的中繼憑證。
> - `resolver 8.8.8.8 …;`：Nginx 自己要去查 CA 的網域，所以需要指定 DNS 伺服器；`valid=300s` 表示解析結果快取 300 秒。內網環境建議改成公司內部 DNS。
>
> 改完設定後驗證：
>
> ```bash
> sudo nginx -t && sudo nginx -s reload   # 語法檢查通過才重載
> curl -I https://mysite.com              # 確認 HTTPS 回 200
> curl -I http://mysite.com               # 確認 HTTP 回 301，Location 指向 https://
> ```

### 建立共用的 SSL 設定片段

把多個站台都會用到的 SSL 參數抽成一個共用檔，每個站台只要一行 `include` 就能套用，避免複製貼上、日後調整也只改一處：

```nginx
# /etc/nginx/snippets/ssl-params.conf

ssl_protocols TLSv1.2 TLSv1.3;            # 只開安全版本（理由同 6.3 節）
ssl_prefer_server_ciphers on;             # TLS 1.2 握手以伺服器的套件順序為準
ssl_ciphers 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384';  # 限定 TLS 1.2 可用的強加密套件（皆支援前向保密）

ssl_session_cache shared:SSL:10m;         # 各 worker 共用的 session 快取（10MB ≈ 4 萬個 session）
ssl_session_timeout 10m;                  # session 有效 10 分鐘（這裡 m = 分鐘，不是 MB）
ssl_session_tickets off;                  # 關閉 tickets 機制，避免金鑰輪替不當破壞前向保密

ssl_stapling on;                          # 啟用 OCSP Stapling（由 Nginx 代查憑證吊銷狀態）
ssl_stapling_verify on;                   # 驗證 OCSP 回應的真偽

# 安全標頭
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;  # HSTS（詳見下方說明）
add_header X-Frame-Options "SAMEORIGIN" always;        # 只允許同網域以 iframe 嵌入本站（防點擊劫持）
add_header X-Content-Type-Options "nosniff" always;    # 禁止瀏覽器自行猜測檔案類型（防 MIME 混淆攻擊）
add_header X-XSS-Protection "1; mode=block" always;    # 舊版瀏覽器的 XSS 過濾器（現代瀏覽器已淘汰此機制，留著無害）
```

> 這個共用檔怎麼讀？（逐條補充）
>
> - **為什麼 `ssl_trusted_certificate` 和 `resolver` 不放進來？**
>   `chain.pem` 的路徑每個站台不同（跟著各自的憑證走），所以 stapling 的開關放共用檔，但憑證鏈路徑留在各站台的 server block 設定。
> - **HSTS 那行逐段拆解**：
>   - `max-age=63072000`：單位是秒，63,072,000 秒 = **2 年**。瀏覽器在這段期間內，連這個網域一律強制走 HTTPS，連第一次的 HTTP 請求都直接在本機升級，不會真的發出去。
>   - `includeSubDomains`：所有子網域一併適用（確定全部子網域都有 HTTPS 再加，否則某個只有 HTTP 的子網域會直接連不上）。
>   - `preload`：同意被收錄進瀏覽器內建的 HSTS 清單（需到 hstspreload.org 申請）。**收錄後幾乎無法撤回**，請確定永遠不會回到 HTTP 再加這個字。
> - **`always` 旗標**：預設 `add_header` 只在 2xx/3xx 回應時送出；加上 `always` 連 404、500 等錯誤頁也會帶安全標頭，避免錯誤頁成為防護缺口。
> - **`add_header` 繼承陷阱**：只要某個 location 裡又寫了任何一個 `add_header`，外層（這個 include 進來）的標頭就**全部失效**，必須在該 location 重新寫一次。這是 Nginx 最容易踩的坑之一，詳見第八章。

```nginx
# 在 server block 中使用
server {
    listen 443 ssl http2;
    server_name mysite.com;

    # 憑證路徑是「每個站台不同」的部分，留在各自的 server block
    ssl_certificate /etc/letsencrypt/live/mysite.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mysite.com/privkey.pem;
    ssl_trusted_certificate /etc/letsencrypt/live/mysite.com/chain.pem;  # 供 OCSP Stapling 驗證用
    include snippets/ssl-params.conf;     # 套用上面的共用 SSL 參數（相對路徑 = /etc/nginx/snippets/...）

    # ... 其他設定
}
```

---

## 6.4 HTTP/2 設定

HTTP/2 可以大幅提升網站載入速度：

```nginx
server {
    # 啟用 HTTP/2（實務上需要 SSL：瀏覽器只在 HTTPS 上使用 HTTP/2）
    listen 443 ssl http2;

    ssl_certificate /path/to/cert.pem;        # 憑證（正式環境請用 fullchain.pem）
    ssl_certificate_key /path/to/key.pem;     # 私鑰

    location / {
        root /var/www/html;
    }
}
```

> HTTP/2 好在哪？為什麼只要加一個字？
>
> - **多路複用（Multiplexing）**：HTTP/1.1 一條連線一次只能處理一個請求，瀏覽器得開 6 條連線排隊；HTTP/2 在**一條連線**上同時並行傳輸所有資源，網頁資源多時提速最明顯。
> - **標頭壓縮（HPACK）**：每個請求重複的 Cookie、User-Agent 等標頭會被壓縮，減少傳輸量。
> - **二進位協定**：解析更快、更不易出錯。
> - 對 Nginx 而言只是「換一種說話方式」，所以只需在 `listen` 加上 `http2`，網站內容與其他設定完全不用動。
>
> **版本語法差異**：Nginx 1.25.1 之後建議改用獨立指令的寫法——
>
> ```nginx
> listen 443 ssl;
> http2 on;   # 新寫法：http2 從 listen 參數獨立成指令
> ```
>
> 舊寫法 `listen 443 ssl http2;` 在 1.24 仍可用，但新版本會出現 deprecated 警告。
>
> **關於 `http2_push`（伺服器推送）**：舊教材常見的 `http2_push /css/style.css;` 已經**過時**——Chrome 已於 106 版移除支援，Nginx 也在 1.25.1 移除了這個指令，現在設定它只會報錯或無效。想預先載入關鍵資源，請改用 preload 提示：
>
> ```nginx
> location = /index.html {
>     # 告訴瀏覽器「待會一定會用到這些檔案，先抓」——效果類似推送，但由瀏覽器決定
>     add_header Link "</css/style.css>; rel=preload; as=style, </js/app.js>; rel=preload; as=script";
> }
> ```
>
> 部署後驗證 HTTP/2 是否生效：
>
> ```bash
> curl -sI --http2 https://mysite.com | head -1
> # 看到「HTTP/2 200」代表成功；若顯示 HTTP/1.1 表示沒談成 HTTP/2
> ```

---

## 6.5 SSL 終止（SSL Termination）

在 Nginx 層處理 SSL，後端只需處理 HTTP：

```nginx
upstream backend {
    server 10.0.1.10:3000;    # 後端伺服器 1（內網 IP，只跑 HTTP）
    server 10.0.1.11:3000;    # 後端伺服器 2，兩台輪流分擔流量（負載均衡見第五章）
}

server {
    listen 443 ssl http2;                  # 對外只開 HTTPS
    server_name api.mysite.com;

    # SSL 在這一層「終止」：加解密只發生在 Nginx
    ssl_certificate /etc/letsencrypt/live/api.mysite.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.mysite.com/privkey.pem;
    include snippets/ssl-params.conf;      # 套用 6.3 建立的共用 SSL 參數

    location / {
        # 後端使用 HTTP（不需要 SSL）
        proxy_pass http://backend;                                    # 注意是 http://——進內網後改走明文
        proxy_set_header Host $host;                                  # 把原始網域傳給後端（否則後端看到的是 upstream 名稱）
        proxy_set_header X-Real-IP $remote_addr;                      # 傳遞客戶端真實 IP
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;  # 累加代理鏈上的 IP 清單
        proxy_set_header X-Forwarded-Proto https;  # 告訴後端原始請求是 HTTPS
    }
}
```

> `X-Forwarded-Proto https` 這行為什麼特別重要？
>
> 後端收到的請求是 HTTP（因為 SSL 已在 Nginx 終止），如果不告訴它「使用者其實走的是 HTTPS」，常見的災難有：
>
> - 後端框架以為是 HTTP，把使用者**重導向去 HTTPS** → Nginx 又轉成 HTTP 給後端 → **無限重導向迴圈**。
> - 後端生成的絕對網址（信件連結、API callback）變成 `http://` 開頭。
> - Session cookie 的 `Secure` 屬性判斷錯誤。
>
> 後端框架通常要同步開啟「信任代理」設定（Express 的 `app.set('trust proxy', true)`、Django 的 `SECURE_PROXY_SSL_HEADER` 等），才會讀取這個標頭。
>
> 補充：這裡寫死 `https` 而不用 `$scheme`，是因為這個 server block 只監聽 443，進得來的一定是 HTTPS；若同一個 block 同時收 80/443，就改用 `$scheme` 動態帶入。

**優點**：

- 後端不需要管理憑證
- 減少後端的 CPU 負擔（SSL 加解密由 Nginx 處理）
- 集中管理憑證，更容易維護

> **安全前提**：Nginx 到後端這段是明文，所以僅適用於**可信任的內網**（同 VPC、私有網段）。若後端在不可信網路（跨機房、跨雲），這段也要加密（`proxy_pass https://...` 或走 VPN/服務網格）。

---

## 6.6 自簽憑證（開發環境用）

```bash
# 生成自簽憑證（有效期 365 天）
sudo openssl req -x509 -nodes -days 365 \
    -newkey rsa:2048 \
    -keyout /etc/ssl/private/self-signed.key \
    -out /etc/ssl/certs/self-signed.crt \
    -subj "/C=TW/ST=Taiwan/L=Taipei/O=Dev/CN=localhost"

# 各參數意義：
# req -x509        = 產生「自簽」憑證（自己當 CA 簽給自己），而不是產生申請檔（CSR）
# -nodes           = no DES：私鑰不加密碼保護（否則 Nginx 每次啟動都要人工輸入密碼）
# -days 365        = 憑證有效期 365 天
# -newkey rsa:2048 = 同時產生一把新的 RSA 2048 位元私鑰（不必事先準備）
# -keyout          = 私鑰輸出路徑
# -out             = 憑證輸出路徑
# -subj "…"        = 憑證主體資訊，直接在指令帶入、跳過互動式問答：
#                    C=國家(TW) / ST=州省 / L=城市 / O=組織 / CN=網域名稱
#                    其中 CN（Common Name）最重要，要填你實際存取用的主機名（這裡是 localhost）

# 生成 DH 參數（增強金鑰交換安全性，2048 位元計算需要數十秒屬正常）
sudo openssl dhparam -out /etc/ssl/certs/dhparam.pem 2048
```

```nginx
server {
    listen 443 ssl;
    server_name localhost;

    ssl_certificate /etc/ssl/certs/self-signed.crt;        # 上面產生的自簽憑證
    ssl_certificate_key /etc/ssl/private/self-signed.key;  # 對應私鑰
    ssl_dhparam /etc/ssl/certs/dhparam.pem;                # 引用 DH 參數（沒這行的話上面生成的檔案不會被使用）

    # ... 其他設定
}
```

> 使用自簽憑證的注意事項：
>
> - 瀏覽器**一定會跳「不安全」警告**——因為憑證不是受信任的 CA 簽的，這是正常現象，開發環境點「進階 → 繼續前往」即可。
> - `curl` 測試要加 `-k`（跳過憑證驗證）：`curl -k https://localhost`。
> - 自簽憑證**只能用於開發/測試**，正式環境請用 Let's Encrypt 或商業憑證。
> - 若想要開發環境不跳警告，可改用 [mkcert](https://github.com/FiloSottile/mkcert) 工具，它會建立本機信任的開發 CA。

---

## 6.7 實際情境

### 情境一：SSL 憑證到期，網站顯示不安全

**問題**：瀏覽器顯示「您的連線不安全」或「NET::ERR_CERT_DATE_INVALID」

```bash
# 1. 檢查憑證到期日
sudo openssl x509 -in /etc/letsencrypt/live/mysite.com/fullchain.pem -noout -dates
# x509     = 處理憑證的子指令
# -in      = 要檢查的憑證檔
# -noout   = 不要輸出憑證本體（一大串 base64）
# -dates   = 只印出生效日（notBefore）與到期日（notAfter）

# 2. 手動續約
sudo certbot renew

# 3. 如果續約失敗，檢查原因
sudo certbot renew --dry-run
# --dry-run 用測試環境完整跑一次驗證流程，錯誤訊息會直接告訴你卡在哪一步

# 常見問題：
# - DNS 沒有指向這台伺服器
# - 80 port 被防火牆擋住（Let's Encrypt 需要 80 port 驗證）
# - Certbot 的 webroot 路徑不正確

# 4. 重載 Nginx（憑證是啟動時讀進記憶體的，換了新憑證必須 reload 才生效）
sudo nginx -s reload

# 5. 設定監控，在到期前 14 天發送通知
# 可使用 cron + 腳本檢查，例如：
echo | openssl s_client -connect mysite.com:443 -servername mysite.com 2>/dev/null \
    | openssl x509 -noout -checkend 1209600 \
    || echo "憑證將在 14 天內到期！"
# -checkend 1209600 = 檢查憑證是否會在 1,209,600 秒（14 天）內到期，會的話回傳非 0
```

### 情境二：Mixed Content 警告

**問題**：HTTPS 頁面中載入了 HTTP 資源

```nginx
# 方法一：在 Nginx 加上 CSP 標頭，自動將 HTTP 升級為 HTTPS
add_header Content-Security-Policy "upgrade-insecure-requests" always;

# 方法二：確保所有資源都使用 HTTPS 或相對路徑
# 檢查 HTML 中是否有 http:// 開頭的資源連結
```

### 情境三：SSL 握手失敗

**問題**：出現 `SSL_ERROR_HANDSHAKE_FAILURE_ALERT` 錯誤

```bash
# 1. 測試 SSL 連線
openssl s_client -connect mysite.com:443 -servername mysite.com
# s_client            = openssl 的「測試客戶端」，模擬一次 TLS 握手並印出完整過程
# -connect 主機:port  = 實際建立 TCP 連線的目標
# -servername         = 在握手中帶上 SNI（見情境四）；一台主機有多張憑證時，
#                       沒帶這個參數可能拿到「別張」憑證，測試結果就失準了

# 2. 檢查憑證鏈是否完整
openssl s_client -connect mysite.com:443 -servername mysite.com -showcerts
# -showcerts = 印出伺服器送來的「整串」憑證鏈
# 健康的輸出應該有 2 張以上憑證（伺服器憑證 + 中繼憑證），
# 並且結尾顯示 Verify return code: 0 (ok)；
# 若只有 1 張、或出現 unable to get local issuer certificate → 憑證鏈不完整

# 3. 常見原因
# - 憑證鏈不完整（缺少中間憑證）
# - 使用了 ssl_certificate 而非 fullchain.pem
# - TLS 版本不相容（例如老舊客戶端只支援已被停用的 TLS 1.0/1.1）

# 解決：使用完整憑證鏈
ssl_certificate /etc/letsencrypt/live/mysite.com/fullchain.pem;  # 不是 cert.pem！
```

### 情境四：多個網站共用一台伺服器的 SSL 設定

```nginx
# 使用 SNI（Server Name Indication），一個 IP 可以有多張 SSL 憑證

server {
    listen 443 ssl http2;          # 兩個站台都監聽同一個 443 連接埠
    server_name site-a.com;        # Nginx 依 SNI 帶來的網域比對 server_name 來選擇 server block
    ssl_certificate /etc/letsencrypt/live/site-a.com/fullchain.pem;      # A 站自己的憑證
    ssl_certificate_key /etc/letsencrypt/live/site-a.com/privkey.pem;    # A 站自己的私鑰
    include snippets/ssl-params.conf;                                    # 共用 SSL 參數（6.3 節建立）
}

server {
    listen 443 ssl http2;
    server_name site-b.com;
    ssl_certificate /etc/letsencrypt/live/site-b.com/fullchain.pem;      # B 站用另一張憑證
    ssl_certificate_key /etc/letsencrypt/live/site-b.com/privkey.pem;
    include snippets/ssl-params.conf;
}
```

> SNI 是怎麼運作的？
>
> - 早期 TLS 有個雞生蛋問題：憑證要在「握手階段」送出，但那時伺服器還不知道你要訪問哪個網域（Host 標頭在握手完成後才看得到），所以一個 IP 只能綁一張憑證。
> - SNI 的解法：客戶端在 TLS 握手的第一個訊息（ClientHello）就先聲明「我要連 site-a.com」，Nginx 據此挑出對應 `server_name` 的 server block 與憑證。
> - 現今所有主流瀏覽器與客戶端都支援 SNI，可放心使用；這也是為什麼測試指令都要加 `-servername`。
> - 注意：SNI 在握手階段是**明文**的，網路中間人看得到你訪問的網域名稱（但看不到內容）。

---

## 6.8 SSL 安全性檢測

部署完成後，使用以下工具檢查 SSL 設定是否安全：

```bash
# 線上檢測
# https://www.ssllabs.com/ssltest/
# 目標：取得 A 或 A+ 評等

# 命令列檢測
# 檢查支援的 TLS 版本與加密套件
nmap --script ssl-enum-ciphers -p 443 mysite.com
# --script ssl-enum-ciphers = 用 nmap 內建腳本逐一嘗試各 TLS 版本/套件並評分
# -p 443                    = 只掃 443 連接埠
# 重點看輸出：TLSv1.0/1.1 不應出現；各套件評等應為 A

# 檢查憑證資訊
echo | openssl s_client -connect mysite.com:443 -servername mysite.com 2>/dev/null | openssl x509 -text -noout
# echo |        = 給 s_client 一個空輸入，讓它握手完就退出（否則會停住等你輸入）
# 2>/dev/null   = 丟棄握手過程的雜訊輸出
# | openssl x509 -text -noout = 把拿到的憑證解析成人類可讀格式（簽發者、有效期、SAN 網域清單…）

# 檢查 HSTS
curl -sI https://mysite.com | grep -i strict
# -s = 安靜模式（不顯示進度）；-I = 只取回應標頭
# grep -i strict = 不分大小寫過濾出 Strict-Transport-Security 標頭
# 有輸出代表 HSTS 已生效
```

---

## 6.9 本章小結

- HTTPS 是現代網站的標配，Let's Encrypt 提供免費憑證
- 使用 Certbot 可以一鍵完成憑證申請與 Nginx 設定
- SSL 終止讓後端免於處理 SSL 加解密的負擔，但要記得傳 `X-Forwarded-Proto`
- 一定要設定自動續約，且續約後要 reload Nginx 新憑證才會生效（`--post-hook`）
- 務必使用 `fullchain.pem` 而非 `cert.pem`
- `http2_push` 已被淘汰（Nginx 1.25.1 移除），預載資源請改用 `Link: rel=preload` 標頭
- 上線後使用 SSL Labs 檢測安全性

---

> 上一章：[負載均衡](./05-load-balancing.md) | 下一章：[效能優化與快取策略](./07-performance.md)
