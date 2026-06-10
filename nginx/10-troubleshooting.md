# 第十章：上線網站問題排查

## 10.1 問題排查的系統性方法

遇到上線問題時，按照以下流程逐步排查：

```
1. 確認症狀 → 2. 檢查日誌 → 3. 驗證設定 → 4. 檢查系統資源
     ↓              ↓              ↓                ↓
  使用者回報     error.log      nginx -t         CPU/記憶體/磁碟
  瀏覽器錯誤     access.log     設定檔內容        網路/連線數
  監控告警       系統日誌        upstream 設定     行程狀態
```

> 這個流程怎麼用？（逐步）
>
> - **確認症狀**：先弄清楚「誰、什麼時間、哪個 URL、看到什麼錯誤碼」。「全站掛掉」和「某頁偶爾變慢」的排查方向完全不同，先定義清楚能省一半時間。
> - **檢查日誌**：`error.log` 記錄 Nginx 自身與連後端的錯誤（502/504 的線索幾乎都在這）；`access.log` 看狀態碼分布與回應時間；系統日誌（`journalctl`、`dmesg`）看 OOM、服務崩潰等系統層問題。
> - **驗證設定**：`nginx -t` 只檢查「語法」是否正確，不保證「邏輯」正確（例如 root 路徑寫錯仍會通過）；`nginx -T` 會印出合併 include 後的完整生效設定，是確認「實際生效值」的最快方法。
> - **檢查系統資源**：CPU、記憶體、磁碟空間、連線數任何一項耗盡，表面症狀都可能只是「網站變慢或無回應」，必須逐項排除。

---

## 10.2 常見 HTTP 錯誤碼排查

### 400 Bad Request

```
原因：客戶端發送了不合規的請求
常見情況：
  - Cookie 太大
  - URL 太長
  - 請求標頭太大
```

```nginx
# 解決方案：增加緩衝區大小
http {
    client_header_buffer_size 4k;        # 單一請求的標頭基本緩衝區；預設 1k，多數正常請求夠用
    large_client_header_buffers 4 32k;   # 標頭超過上行時啟用的大緩衝區：最多 4 個、每個 32k（預設 4 8k）

    # 如果是 Cookie 太大造成
    # 檢查應用程式是否設了過多的 Cookie
}
```

> 這兩個指令的因果關係是什麼？（逐條）
>
> - `client_header_buffer_size 4k;`
>   - Nginx 先用這個「小緩衝區」讀請求標頭；單位可用 `k`（KB）、`m`（MB）。
>   - 放不下時不會直接報錯，而是改用下面的大緩衝區，所以這個值通常不必調太大。
> - `large_client_header_buffers 4 32k;`
>   - 兩個參數：`4` 是緩衝區「個數」、`32k` 是「每個的大小」。
>   - **單一標頭行**（例如一條超大的 Cookie）超過 32k → 回 `400`，error.log 會出現 `client sent too long header line` 或回應頁顯示 `Request Header Or Cookie Too Large`。
>   - **請求行（URL）** 超過 32k → 回 `414 Request-URI Too Large`。
>   - 預設 `4 8k` 對一般網站足夠；若有 SSO/JWT 等超長 Cookie 場景，常調到 `4 16k` 或 `4 32k`。不要無上限調大——這是每連線都可能配置的記憶體，調太大會放大記憶體用量與被攻擊面。
>
> 修改後驗證：
>
> ```bash
> # 檢查語法並重載
> sudo nginx -t && sudo nginx -s reload
>
> # 模擬超長 Cookie（約 9KB），確認不再回 400
> curl -i -H "Cookie: a=$(printf 'x%.0s' {1..9000})" http://mysite.com/
> # -i：連回應標頭一起顯示（可直接看到狀態碼）
> # -H：附加自訂請求標頭；printf 'x%.0s' {1..9000} 會產生 9000 個 x
> ```

### 403 Forbidden

```bash
# 排查步驟

# 1. 檢查檔案權限
ls -la /var/www/mysite/        # -l 長格式顯示權限與擁有者，-a 連隱藏檔一起列出
# 確保 Nginx worker 使用者（通常是 www-data）有讀取權限
sudo chown -R www-data:www-data /var/www/mysite   # -R 遞迴變更整個目錄的「擁有者:群組」
sudo chmod -R 755 /var/www/mysite                 # 755 = 擁有者 rwx、群組 r-x、其他 r-x；目錄必須有 x 才能被進入

# 2. 確認 index 檔案存在
ls -la /var/www/mysite/html/index.html   # 目錄存在但沒有 index 檔、又沒開 autoindex 時，也會回 403

# 3. 檢查 Nginx 設定中是否有 deny 規則
nginx -T | grep -i deny    # -T 印出合併 include 後的完整生效設定；grep -i 不分大小寫搜尋 deny

# 4. 檢查 SELinux（CentOS/RHEL）
getenforce    # 顯示 SELinux 模式：Enforcing（強制）/ Permissive（僅記錄）/ Disabled（關閉）
# 如果是 Enforcing，可能需要：
sudo semanage fcontext -a -t httpd_sys_content_t "/var/www/mysite(/.*)?"
# semanage fcontext：管理檔案的 SELinux 標籤規則；-a 新增、-t 指定類型
# httpd_sys_content_t 是「允許 Web 伺服器讀取」的內容標籤；"(/.*)?" 表示套用到目錄下所有檔案
sudo restorecon -Rv /var/www/mysite   # 依上面登記的規則實際套用標籤：-R 遞迴、-v 顯示變更了哪些檔案
```

> 403 的四種常見成因與 error.log 對照（逐條）
>
> - **檔案系統權限不足**：error.log 出現 `open() "..." failed (13: Permission denied)`
>   - worker 使用者（`user` 指令指定，通常 `www-data`）沿路徑每一層目錄都要有 `x` 權限、檔案要有 `r` 權限。
> - **設定了 deny 規則**：error.log 出現 `access forbidden by rule`
>   - 用 `nginx -T | grep -B3 deny` 找出是哪個 location 的 `deny` 擋下了請求。
> - **目錄沒有 index 檔**：error.log 出現 `directory index of "..." is forbidden`
>   - 請求的是目錄、找不到 `index` 指令列的檔案、又沒開 `autoindex on;` → Nginx 拒絕列目錄，回 403。
> - **SELinux 標籤不符**（CentOS/RHEL）：檔案權限看起來都對，但仍 403；`ls -laZ` 可看標籤是否為 `httpd_sys_content_t`。
>   - 排查時可先 `sudo setenforce 0` 暫時切到 Permissive 驗證是否為 SELinux 造成（確認後記得切回並正確設標籤，不要長期關閉）。

### 404 Not Found

```bash
# 排查步驟

# 1. 確認檔案是否存在
ls -la /var/www/mysite/html/requested-page.html   # 檔案根本不存在，再怎麼調設定都是 404

# 2. 確認 root 或 alias 設定是否正確
nginx -T | grep -A5 "server_name mysite.com"   # -A5：顯示符合行「之後 5 行」，可一併看到該 server 的 root 設定

# 3. 確認 location 匹配是否正確
# 使用 debug 日誌確認匹配了哪個 location（開法詳見 10.9 進階排查工具）
```

```nginx
error_log /var/log/nginx/debug.log debug;   # 把日誌等級調到 debug（最詳細），日誌中會出現 test location: "/api/" 等匹配過程
```

```bash
# 4. SPA 應用常見問題 — 重新整理頁面出現 404
# 解決：
```

```nginx
location / {
    try_files $uri $uri/ /index.html;   # 依序嘗試：實體檔案 → 目錄 → 都沒有就回傳 index.html 交給前端路由
}
```

> 404 排查的關鍵思路（逐條）
>
> - **最快定位法：看 error.log 的實際路徑**。404 時 error.log 通常有一行：
>   ```text
>   open() "/var/www/mysite/html/app.js" failed (2: No such file or directory)
>   ```
>   引號內就是 Nginx「實際嘗試開啟」的完整路徑，和你預期的路徑一比對，root/alias 哪裡接錯立刻現形。
> - **`root` 與 `alias` 的差異是 404 重災區**：
>   - `root /var/www;` + `location /static/` → 實際路徑 = `/var/www/static/...`（root 會把**完整 URI** 接在後面）。
>   - `alias /var/www/assets/;` + `location /static/` → 實際路徑 = `/var/www/assets/...`（alias 會**取代**匹配到的前綴）。
>   - `alias` 的值結尾務必加 `/`，否則路徑會黏在一起產生意外結果。
> - **`try_files $uri $uri/ /index.html;` 逐參數**：
>   - `$uri` 是正規化後的請求路徑（不含查詢參數）。例如請求 `/dashboard?tab=2` 時 `$uri` = `/dashboard`。
>   - 依序檢查：`root` 下是否有 `/dashboard` 這個檔案 → 是否有 `/dashboard/` 這個目錄 → 都沒有則改為內部轉向 `/index.html`。
>   - SPA（Vue/React）的路由只存在於前端，伺服器上沒有對應檔案，所以最後一定要兜底到 `/index.html`，否則重新整理就 404。
>   - 注意最後一個參數是「內部轉向目標」而非檔案檢查；若寫成 `=404` 則直接回 404 狀態碼。

### 499 Client Closed Request

```
原因：客戶端在伺服器回應前關閉了連線
常見情況：
  - 後端回應太慢，客戶端等不及
  - 使用者重複點擊或切換頁面
  - 前端設定的逾時時間太短
```

```nginx
# 如果大量出現 499，需要優化後端回應速度
# 或調整前端逾時時間

# 日誌中 499 不會顯示在 error_log，只在 access_log
```

> 關於 499 的幾個重點（逐條）
>
> - `499` 是 **Nginx 自定義**的狀態碼（不在 HTTP RFC 標準中），意思是「客戶端不等了、先掛斷」。
> - 因為是客戶端主動斷線，對 Nginx 來說不算「錯誤」，所以**只記在 access_log，不會出現在 error_log**——這就是為什麼很多人在 error.log 翻半天找不到線索。
> - 排查方向：先統計 499 請求的回應時間與集中的 URL：
>   ```bash
>   # 統計 access.log 中 499 最常出現在哪些 URL（$9 是 main 格式的狀態碼欄位）
>   awk '$9 == 499 {print $7}' /var/log/nginx/access.log | sort | uniq -c | sort -rn | head -10
>   # awk '$9 == 499'：只取狀態碼為 499 的行，印出第 7 欄（請求路徑）
>   # sort | uniq -c：分組計數；sort -rn：依次數由大到小；head -10：取前 10 名
>   ```
> - 若想觀察「客戶端斷線後，後端到底花了多久才回完」，可暫時開啟：
>   ```nginx
>   proxy_ignore_client_abort on;   # 客戶端斷線後 Nginx 仍等後端回應完（預設 off）
>   ```
>   這樣 access_log 會記到後端真實耗時，方便定位慢的環節；**但它會讓已放棄的請求繼續佔用後端資源，僅建議排查期間短暫使用**。

### 502 Bad Gateway

```bash
# 最常見的反向代理錯誤

# 排查步驟

# 1. 確認後端服務是否在運行
sudo systemctl status your-app     # 狀態須為 active (running)；failed / inactive 代表後端沒起來
curl http://localhost:3000/health  # 在伺服器本機直接打後端（繞過 Nginx），切割問題在哪一層

# 2. 確認後端 port 和地址是否正確
sudo ss -tlnp | grep 3000
# ss 選項逐一說明：
#   -t  只列 TCP 連線
#   -l  只列「監聽中」（LISTEN）的 socket
#   -n  不做名稱解析，直接顯示數字 port（更快、更不易誤判）
#   -p  顯示佔用該 port 的行程名稱與 PID（需要 sudo 才看得到別人的行程）
# 有輸出 → port 3000 有行程在監聽；沒輸出 → 後端沒起來，或聽在別的 port / 只綁了別的位址

# 3. 檢查 Nginx 錯誤日誌
tail -20 /var/log/nginx/error.log   # -20：只看最後 20 行（最新的錯誤在最下面）

# 常見日誌訊息與解決方案：
# "connect() failed (111: Connection refused)"
#   → 後端沒有在運行，重啟後端服務
#
# "connect() failed (113: No route to host)"
#   → 網路不通，檢查防火牆和安全群組
#
# "no live upstreams while connecting to upstream"
#   → 所有 upstream 伺服器都被標記為不可用

# 4. CentOS 的 SELinux 問題
sudo setsebool -P httpd_can_network_connect 1
# setsebool：切換 SELinux 開關；httpd_can_network_connect=1 允許 Web 服務（含 Nginx）主動連出去
# -P：永久生效（寫入策略，重開機仍保留）；不加 -P 重開機就失效
```

> 502 的因果關係：Nginx 收得到請求，但「連不上後端」或「後端回了不合法的內容」。錯誤日誌逐條解讀：
>
> - `connect() failed (111: Connection refused) while connecting to upstream`
>   - TCP 層被拒絕：到得了主機，但目標 port **沒有行程在聽** → 後端掛了、還沒啟動完、或 `proxy_pass` 的 port 寫錯。
> - `connect() failed (113: No route to host)`
>   - 網路層不通：路由不存在或被防火牆 REJECT → 檢查防火牆、雲端安全群組、後端主機是否關機。
> - `connect() failed (110: Connection timed out)`
>   - 連線逾時：封包出去了但沒有回音（常見於防火牆 DROP、後端過載、跨網段問題）。
> - `no live upstreams while connecting to upstream`
>   - upstream 中**所有**伺服器都因連續失敗被被動健康檢查標記為不可用（由 `max_fails` / `fail_timeout` 控制，見 10.8 情境二）；在 `fail_timeout` 視窗內 Nginx 連試都不試，直接回 502。
> - `upstream prematurely closed connection while reading response header`
>   - 後端「處理到一半斷線」：常見於後端崩潰、被 OOM Killer 殺掉、或後端自身逾時先斷線 → 去看後端日誌與 `dmesg`。
> - `upstream sent too big header while reading response header from upstream`
>   - 後端回應**標頭**超過 `proxy_buffer_size` 放不下 → 調大 `proxy_buffer_size`（例如 `8k` 或 `16k`），常見於 Set-Cookie 很多的應用。
>
> 修好後驗證：`curl -I http://mysite.com/` 應回 200；持續 `tail -f error.log` 確認不再出現上述訊息。

### 503 Service Unavailable

```bash
# 原因：
# - 後端所有伺服器都不可用
# - Nginx 主動返回（維護模式）
# - 超過速率限制（如果設定了 limit_req_status 503）

# 排查步驟

# 1. 檢查 upstream 伺服器狀態
tail -f /var/log/nginx/error.log | grep upstream
# tail -f：持續追蹤檔案新增的內容（即時看新日誌）；grep upstream 只留與後端相關的行

# 2. 確認是否處於維護模式
nginx -T | grep "return 503"   # 搜尋設定中是否有人手動回傳 503（維護頁的常見寫法）

# 3. 檢查速率限制設定
nginx -T | grep limit_req      # 找出速率限制相關設定；limit_req 觸發時「預設就回 503」
```

> 503 與 502 怎麼分？三種來源逐條對照：
>
> - **後端全數不可用**：error.log 同時會有大量 upstream 連線失敗紀錄 → 依 502 一節的步驟排查後端。
> - **維護模式**：有人在設定裡寫了 `return 503;`（常搭配維護頁）。上線前忘記移除是經典事故，`nginx -T | grep "return 503"` 一查便知。
> - **觸發速率限制**：`limit_req` / `limit_conn` 超限時**預設回 503**，error.log 會出現：
>   ```text
>   limiting requests, excess: 5.320 by zone "mylimit"
>   ```
>   表示某 IP 超出 zone `mylimit` 設定的速率。實務建議改回 429（語意更正確，客戶端才知道是「太快」而不是「壞了」）：
>   ```nginx
>   limit_req_status 429;   # 超限時改回 429 Too Many Requests（預設 503）
>   ```

### 504 Gateway Timeout

```bash
# 原因：後端回應逾時

# 排查步驟

# 1. 確認後端是否有回應
time curl http://localhost:3000/slow-endpoint
# time：量測整條指令的執行時間 → 直接得知後端這支 API 實際要跑幾秒
# 若量出來是 90 秒，而 proxy_read_timeout 是 60s，504 的因果關係就成立了

# 2. 調整 Nginx 逾時設定
```

```nginx
location / {
    proxy_pass http://backend;

    # 增加逾時時間
    proxy_connect_timeout 30s;   # 與後端「建立 TCP 連線」的逾時（預設 60s；官方限制實際不可超過約 75s）
    proxy_send_timeout 120s;     # 對後端「寫入請求」時，兩次寫入之間的逾時（預設 60s）
    proxy_read_timeout 120s;     # 「等待後端回應」時，兩次讀取之間的逾時（預設 60s）→ 504 絕大多數是它造成

    # 如果是 FastCGI
    # fastcgi_read_timeout 120s;   # PHP-FPM 場景對應的讀取逾時（與上面同理）
}
```

> 這三個逾時參數怎麼理解？（逐條）
>
> - 三者單位都可用 `s`（秒）、`m`（分鐘），預設皆為 `60s`。
> - 它們限制的是「**兩次相鄰操作之間**」的等待時間，不是整個請求的總時間。例如後端持續每 10 秒吐一點資料，即使總共花 10 分鐘也不會觸發 `proxy_read_timeout 60s`。
> - 觸發 `proxy_read_timeout` 時，error.log 的對應訊息是：
>   ```text
>   upstream timed out (110: Connection timed out) while reading response header from upstream
>   ```
>   看到 `while reading response header` 就知道是「等後端回應」逾時，而非連線階段。
> - **實務建議**：
>   - 不要無腦調大逾時。先弄清楚「後端為什麼要跑這麼久」——慢查詢、外部 API、報表運算？能優化後端才是治本。
>   - 逾時要符合「外層 ≥ 內層」的鏈條：前端/負載均衡器的逾時應大於 Nginx 的，Nginx 的應大於後端自身的，否則會出現外層先斷線的怪異現象（大量 499/502）。
>   - 真正的長任務（匯出報表等）建議改成非同步（任務佇列 + 輪詢/回呼），而不是把逾時調到 600s。

```bash
# 3. 檢查後端是否有效能問題
# 查看後端日誌
# 查看後端資源使用情況
ssh admin@backend-server "top -bn1 | head -20"
# 透過 ssh 在後端主機遠端執行 top：
#   -b   批次模式（純文字輸出，適合非互動／管線使用）
#   -n1  只取樣一次就結束
#   head -20 取前 20 行（系統摘要 + 最吃資源的前幾個行程）
```

---

## 10.3 Nginx 無法啟動

```bash
# 排查步驟

# 1. 測試設定檔語法
sudo nginx -t
# 載入並檢查所有設定檔（含 include 的檔案）；如果有錯誤，會顯示具體的檔案和行號

# 2. 檢查 port 是否被佔用
sudo ss -tlnp | grep :80     # 找出誰佔了 80 port（ss 選項意義見 10.2 的 502 小節）
sudo ss -tlnp | grep :443    # 同上，檢查 443；最常見的佔用者是 Apache 或另一個 Nginx

# 3. 檢查日誌
sudo journalctl -u nginx --no-pager -n 50
# journalctl：查 systemd 日誌；-u nginx 只看 nginx 服務、--no-pager 直接輸出不分頁、-n 50 最後 50 行
# 或
tail -20 /var/log/nginx/error.log   # Nginx 自己的錯誤日誌（啟動失敗原因常在這裡更詳細）

# 4. 檢查 SSL 憑證是否有效
sudo openssl x509 -in /path/to/cert.pem -noout -dates
# x509：處理憑證的子指令；-in 指定憑證檔
# -noout：不要把憑證本體印出來；-dates：只印 notBefore（生效日）與 notAfter（到期日）

# 5. 檢查 PID 檔案
cat /var/run/nginx.pid    # 顯示記錄的 master 行程編號（PID 檔的用途見第二章補充說明）
# 如果行程已死但 PID 檔案還在：
sudo rm /var/run/nginx.pid    # 移除殘留的 PID 檔，否則 systemd 可能誤判「已在運行」而拒絕啟動
sudo systemctl start nginx

# 6. 檢查權限
ls -la /var/log/nginx/   # 日誌目錄對 Nginx 不可寫 → 啟動直接失敗
ls -la /var/run/         # PID 檔寫不進去也會啟動失敗
```

> 啟動失敗的常見錯誤訊息怎麼讀？（逐條）
>
> - `nginx: [emerg] bind() to 0.0.0.0:80 failed (98: Address already in use)`
>   - 80 port 被別的行程佔用 → 用 `ss -tlnp | grep :80` 找出兇手（常是 Apache、舊的 Nginx 行程或開發用伺服器）。
> - `nginx: [emerg] open() "/var/log/nginx/error.log" failed (13: Permission denied)`
>   - 日誌檔/目錄權限不對 → 對照 `ls -la` 修正擁有者。
> - `nginx: [emerg] cannot load certificate "/etc/.../fullchain.pem" (SSL: ... No such file or directory)`
>   - 憑證路徑寫錯或檔案被搬走（憑證更新腳本改路徑是常見原因）。
> - `nginx: [emerg] unknown directive "xxx"`
>   - 指令拼錯字，或使用了未編譯進來的模組指令（用 `nginx -V` 確認編譯參數）。
> - 等級辨識：`[emerg]` 是「致命錯誤」，**一定會阻止啟動/重載**；`[warn]` 只是提醒，不影響啟動。
> - 養成習慣：**改完設定先 `nginx -t`，通過才 reload**。reload 失敗時舊行程會繼續用舊設定服務，網站不會掛，但你的新設定也沒生效。

---

## 10.4 效能問題排查

### 回應速度慢

```bash
# 1. 分析存取日誌的回應時間
# 找出回應時間超過 3 秒的請求（前提：log_format 的最後一欄是 $request_time）
awk '$NF > 3' /var/log/nginx/access.log | tail -20
# awk '$NF > 3'：$NF 代表「每行的最後一個欄位」；只印出該欄位數值大於 3（秒）的行
# tail -20：只看最後 20 筆（最新發生的慢請求）

# 2. 區分是 Nginx 慢還是後端慢
# 比較 $request_time 和 $upstream_response_time
# 如果 upstream_response_time 接近 request_time → 後端慢
# 如果 request_time 遠大於 upstream_response_time → Nginx 或網路問題

# 3. 檢查系統資源
top -bn1 | head -20        # CPU 和記憶體：-b 批次輸出、-n1 取樣一次（適合腳本/快照）
iostat -x 1 3              # 磁碟 I/O：-x 顯示延伸統計（重點看 %util 是否接近 100、await 是否飆高）；每 1 秒取樣、共 3 次
ss -s                      # 網路連線統計總覽（-s = summary）：看 TCP 總連線數與 timewait 數量是否異常
cat /proc/net/sockstat      # 核心層 socket 統計（inuse/tw/alloc）：判斷 socket 資源是否快耗盡

# 4. 檢查 Nginx worker 連線數
curl http://localhost/nginx_status   # 需先啟用 stub_status 狀態頁（設定見下方）
# 如果 Active connections 接近 worker_connections × worker_processes → 需要擴容
```

> `$request_time` 和 `$upstream_response_time` 怎麼用？（逐條）
>
> - `$request_time`：從 Nginx 收到請求的第一個 byte，到回應**全部送完給客戶端**的總時間（秒，精確到毫秒）。**包含客戶端網速**——手機弱網下載大檔時這個值會很大，但不代表伺服器慢。
> - `$upstream_response_time`：從 Nginx 連上後端，到收完後端回應的時間。**這才是後端的真實耗時**。
> - 兩個變數預設不在日誌裡，要先加進 `log_format`（放在 `http` 區塊）：
>   ```nginx
>   # 定義含時間欄位的日誌格式，命名為 timing
>   log_format timing '$remote_addr "$request" $status '
>                     'rt=$request_time urt=$upstream_response_time';
>   access_log /var/log/nginx/access.log timing;   # 套用 timing 格式
>   ```
> - 實際判讀範例：
>   - `rt=3.005 urt=2.998` → 時間幾乎都花在後端 → 查後端慢查詢/外部 API。
>   - `rt=3.005 urt=0.020` → 後端 20ms 就回了，但整體花 3 秒 → 查 Nginx buffering 設定、客戶端網速、或回應內容過大。
>   - `urt=-`（短橫線）→ 這個請求沒有經過後端（靜態檔或快取命中）。
>
> `nginx_status` 狀態頁怎麼開、怎麼讀？
>
> - 啟用方式（放在任一 server 區塊內；`stub_status` 模組官方套件預設已編入）：
>   ```nginx
>   location /nginx_status {
>       stub_status;        # 開啟內建狀態頁
>       allow 127.0.0.1;    # 只允許本機存取
>       deny all;           # 其他來源一律拒絕（狀態資訊不該對外公開）
>   }
>   ```
> - 輸出範例與逐行解讀：
>   ```text
>   Active connections: 291                ← 目前活躍連線數（含 Reading/Writing/Waiting）
>   server accepts handled requests
>    16630948 16630948 31070465            ← 累計：已接受連線數、已處理連線數、總請求數
>   Reading: 6 Writing: 179 Waiting: 106   ← 讀取請求中 / 回應傳送中 / Keep-Alive 閒置等待中
>   ```
> - `accepts` 與 `handled` 若不相等，代表有連線因資源不足被丟棄（通常是 `worker_connections` 不夠）。

### 高 CPU 使用率

```bash
# 1. 確認是 Nginx 還是其他行程
top -c | head -20    # -c 顯示完整指令列，可分辨吃 CPU 的是 nginx worker、後端應用還是其他行程

# 2. 如果是 Nginx worker CPU 高
# - 檢查是否有大量的正規表示式匹配
# - 檢查是否有大量的 gzip 壓縮（降低壓縮等級）
# - 檢查是否有大量的 SSL 握手（啟用 SSL session cache）

# 3. 優化
```

```nginx
gzip_comp_level 4;                  # 壓縮等級 1~9（預設 1）；越高越省頻寬但越吃 CPU，4~6 是常見的平衡點
ssl_session_cache shared:SSL:10m;   # 各 worker 共享的 SSL session 快取；1m 約可存 4000 個 session，10m 約 4 萬個
                                    # 命中快取的回訪連線可跳過完整 TLS 握手，大幅降低 CPU
```

> 補充：三個 CPU 兇手的判斷方式
>
> - **正規表示式**：location 規則中大量複雜 regex、或 `if` 搭配 regex，在高 QPS 下會明顯吃 CPU。盡量改用前綴匹配（`^~`）取代 regex。
> - **gzip**：壓縮等級 9 與等級 4 的壓縮率差異通常只有幾個百分點，CPU 消耗卻差數倍——這就是建議 4~6 的原因。已經壓縮過的格式（jpg/png/mp4/zip）不要再 gzip。
> - **SSL 握手**：若 access_log 顯示大量新連線（Keep-Alive 沒生效），每條連線都要完整握手。除了 session cache，也檢查 `keepalive_timeout` 是否被設成 0。

### 高記憶體使用

```bash
# 1. 檢查 Nginx 記憶體使用
ps aux | grep nginx   # 重點看 RSS 欄位（實際佔用的實體記憶體，單位 KB）；多個 worker 要加總

# 2. 可能的原因
# - proxy_buffering 緩衝太大
# - proxy_cache 快取太大
# - worker_connections 設太高
# - 大量的長連線（WebSocket）

# 3. 調整緩衝區
```

```nginx
proxy_buffer_size 4k;          # 存放後端「回應標頭」的緩衝區（預設 4k 或 8k，需大於後端最大標頭，否則出現 upstream sent too big header）
proxy_buffers 4 4k;            # 存放「回應內容」的緩衝區：每條連線最多 4 個、每個 4k（預設 8 個 4k/8k）
proxy_busy_buffers_size 8k;    # 回應還沒送完給客戶端時，可同時處於「忙碌」狀態的緩衝上限（通常設為單個 buffer 的 2 倍）
```

> 記憶體怎麼粗估？
>
> - 上面的設定下，每條代理連線的緩衝上限約 `4k + 4×4k = 20k`。
> - 若同時有 4096 條代理連線：`4096 × 20k ≈ 80MB`（單一 worker 的緩衝部分）。
> - 所以「`worker_connections` 調很高 + buffer 也調很大」兩者相乘就是記憶體暴增的原因，調整時要一起算。
> - 緩衝放不下的部分預設會寫到暫存檔（受 `proxy_max_temp_file_size` 控制），不會無限吃記憶體，但會增加磁碟 I/O。

---

## 10.5 SSL/HTTPS 問題

```bash
# 1. 測試 SSL 連線
openssl s_client -connect mysite.com:443 -servername mysite.com
# s_client：模擬一個 TLS 客戶端，印出完整握手過程與伺服器憑證
# -connect 主機:port：要連線的目標
# -servername：送出 SNI（Server Name Indication）；同一 IP 掛多個 HTTPS 站台時，
#              沒帶這個參數會拿到預設站台的憑證，造成「明明設定對卻驗出錯誤憑證」的誤判

# 2. 檢查憑證到期日
echo | openssl s_client -connect mysite.com:443 -servername mysite.com 2>/dev/null | openssl x509 -noout -dates
# echo |        ：送一個空輸入，讓 s_client 取完憑證就自動結束（否則會停在互動模式等你輸入）
# 2>/dev/null   ：把握手過程的雜訊（stderr）丟棄，只留乾淨輸出
# openssl x509 -noout -dates：解析收到的憑證，只印 notBefore（生效日）與 notAfter（到期日）

# 3. 檢查憑證鏈
echo | openssl s_client -connect mysite.com:443 -servername mysite.com -showcerts 2>/dev/null
# -showcerts：印出伺服器送來的「完整憑證鏈」
# 如果只看到一張憑證 → 缺中繼憑證（intermediate）→ 部分手機/舊系統會報「不受信任」

# 4. 常見問題
# "SSL: error:0B080074:x509 certificate routines:X509_check_private_key:key values mismatch"
#   → 憑證和私鑰不匹配
#   → 確認使用了正確的 fullchain.pem 和 privkey.pem

# "SSL_CTX_use_certificate:ee key too small"
#   → 金鑰長度不足，需要至少 2048 位

# 5. 使用線上工具測試
# https://www.ssllabs.com/ssltest/
```

> `s_client` 輸出的 verify return code 怎麼讀？（逐條）
>
> - `Verify return code: 0 (ok)` → 憑證鏈完整且可信，一切正常。
> - `Verify return code: 20 (unable to get local issuer certificate)` 或 `21 (unable to verify the first certificate)`
>   - 憑證鏈不完整：伺服器只回了站台憑證、沒附中繼憑證 → Nginx 的 `ssl_certificate` 應指向 **fullchain.pem**（站台憑證 + 中繼憑證合併檔），而不是只有 cert.pem。
> - `Verify return code: 10 (certificate has expired)` → 憑證過期 → `certbot renew` 後記得 reload Nginx（renew 不會自動讓 Nginx 載入新憑證，除非有設定 deploy hook）。
> - 上面第 4 點的兩個錯誤訊息會出現在 `nginx -t` 或啟動時的 error.log，屬於「設定載入階段」就會擋下的錯誤；verify return code 則是「客戶端視角」的驗證結果，兩邊對照可快速分辨是憑證檔配錯還是鏈不完整。
>
> 修好後驗證：
>
> ```bash
> sudo nginx -t && sudo nginx -s reload                       # 語法檢查通過才重載
> echo | openssl s_client -connect mysite.com:443 -servername mysite.com 2>/dev/null | grep "Verify return"
> # 期望輸出：Verify return code: 0 (ok)
> ```

---

## 10.6 連線與網路問題

### DNS 解析問題

```bash
# 確認 DNS 解析
dig mysite.com        # 查 DNS A 記錄；重點看 ANSWER SECTION 的 IP 是否正確、TTL 還剩多久
nslookup mysite.com   # 功能類似的查詢工具（Windows 也內建）；兩者擇一即可

# Nginx 內部 DNS 快取問題
# upstream 中使用域名時，Nginx 預設在啟動時解析一次
# 如果 IP 會變（如 AWS ELB），需要設定 resolver
```

```nginx
resolver 8.8.8.8 valid=30s;   # 指定 Nginx 執行期使用的 DNS 伺服器；valid=30s 強制每 30 秒重新解析（覆蓋 DNS 記錄本身的 TTL）

upstream backend {
    server backend.internal.com:3000 resolve;   # resolve 參數：IP 變動時自動更新，不需 reload
    # 注意：upstream 內的 resolve 參數需要「開源版 1.27.3+」或商業版 Nginx Plus
}
```

> 版本注意與 1.24 可用的替代寫法
>
> - 「Nginx 啟動時把域名解析一次就快取住」是 ELB/容器環境 502 的隱形殺手：後端 IP 換了，Nginx 還在連舊 IP。
> - `server ... resolve;` 在**開源版 1.27.3 之後**才支援（之前是 Nginx Plus 專屬）。若你使用 1.24 開源版，請改用「**變數 + proxy_pass**」寫法——`proxy_pass` 的目標含變數時，Nginx 會改用 `resolver` 在執行期動態解析：
>   ```nginx
>   resolver 8.8.8.8 valid=30s;            # 內網環境建議改填內部 DNS（如 VPC 的 DNS IP），別讓內部域名流向公網 DNS
>
>   location / {
>       set $backend "backend.internal.com";   # 用變數存域名，迫使 Nginx 延遲到執行期才解析
>       proxy_pass http://$backend:3000;       # 每次依 resolver 的結果連線，IP 變了也能跟上
>   }
>   ```
> - 代價：用變數後，`proxy_pass` 不再支援 upstream 區塊的負載均衡與 keepalive，且 URI 改寫行為略有不同，適合「單一域名指向 LB」的場景。
> - 驗證：更換後端 IP 後（或調整 DNS 記錄），30 秒內 `curl` 應該就能打到新後端，不需 reload Nginx。

### 連線被拒

```bash
# 1. 檢查防火牆
sudo ufw status                    # Ubuntu：列出 ufw 防火牆規則，確認 80/tcp、443/tcp 是 ALLOW
sudo firewall-cmd --list-all       # CentOS：列出 firewalld 目前 zone 開放的服務與 port（找 http/https 或 80/443）

# 2. 檢查安全群組（雲端環境）
# AWS: Security Group
# GCP: Firewall Rules
# Azure: Network Security Group

# 3. 檢查 Nginx 是否綁定在正確的地址
sudo ss -tlnp | grep nginx         # 列出 nginx 監聽中的位址與 port（選項意義見 10.2 的 502 小節）
# 如果只顯示 127.0.0.1:80 → 只監聽本地（外部永遠連不進來；對應設定 listen 127.0.0.1:80）
# 應該顯示 0.0.0.0:80 或 *:80 → 監聽所有介面
```

> 「連線被拒」的分層排查思路
>
> - 由外往內逐層測：`curl http://<公網IP>/`（外部）→ 雲端安全群組 → 主機防火牆 → `curl http://127.0.0.1/`（主機本機）。
> - 本機 curl 通、外部不通 → 問題在防火牆/安全群組/`listen` 綁定位址，不在 Nginx 設定邏輯。
> - 本機 curl 也不通 → 回到 10.3「Nginx 無法啟動」與 `ss -tlnp` 檢查監聽狀態。
> - 客戶端看到的錯誤也有線索：`Connection refused` = 到得了主機但 port 沒人聽或被 REJECT；`Connection timed out` = 封包被默默丟棄（DROP），九成是防火牆或安全群組。

---

## 10.7 快速排查清單

```
網站完全無法訪問
├── Nginx 是否在運行？ → systemctl status nginx
├── Port 是否在監聽？ → ss -tlnp | grep :80
├── 防火牆是否開放？ → ufw status / firewall-cmd --list-all
├── DNS 是否正確？ → dig mysite.com
└── 雲端安全群組？ → 檢查 inbound rules

網站回傳錯誤頁面
├── 502 → 後端服務未運行或地址錯誤
├── 503 → 所有後端不可用或維護模式
├── 504 → 後端回應逾時
├── 403 → 權限問題或存取被拒
├── 404 → 路徑設定錯誤或檔案不存在
└── 500 → 後端內部錯誤

效能問題
├── 回應慢 → 比較 request_time vs upstream_response_time
├── CPU 高 → 檢查壓縮等級、正規匹配
├── 記憶體高 → 檢查緩衝區設定
└── 連線數不足 → 增加 worker_connections

SSL 問題
├── 憑證過期 → certbot renew
├── 憑證鏈不完整 → 使用 fullchain.pem
├── 金鑰不匹配 → 重新生成憑證
└── TLS 版本不相容 → 檢查 ssl_protocols
```

---

## 10.8 實際情境

### 情境一：深夜網站突然掛掉

```bash
# 緊急處理流程

# 1. 快速確認症狀
curl -I https://mysite.com
# -I：只發 HEAD 請求、只看回應標頭 → 一秒鐘確認狀態碼（200/502/逾時），不用下載整頁

# 2. 檢查 Nginx 狀態
sudo systemctl status nginx
# 如果 Nginx 沒在跑
sudo systemctl start nginx

# 3. 如果 Nginx 在跑但回傳錯誤
tail -50 /var/log/nginx/error.log   # 看最後 50 行錯誤日誌；對照 10.2 各錯誤碼小節的訊息解讀

# 4. 檢查後端
curl http://localhost:3000/health   # 本機直打後端健康檢查（繞過 Nginx，切割問題層）
sudo systemctl status your-app

# 5. 檢查系統資源
free -m        # 記憶體是否耗盡：-m 以 MB 顯示；重點看 available 欄位（不是 free 欄位）
df -h          # 磁碟是否滿了：-h 用人類可讀單位（G/M）；看 Use% 是否接近 100%
top -bn1       # CPU 使用狀況：-b 批次輸出、-n1 取樣一次

# 6. 如果是 OOM（Out of Memory）
dmesg | grep -i "out of memory"
# dmesg：核心訊息；grep -i 不分大小寫搜尋 → 找 OOM Killer 殺掉行程的紀錄（會寫明殺了誰）
# 重啟被殺掉的服務
sudo systemctl restart your-app

# 7. 如果是磁碟滿了
du -sh /var/log/nginx/*       # 各日誌檔大小：-s 每個項目只顯示總計、-h 人類可讀單位
> /var/log/nginx/access.log   # 緊急清空：用 shell 的「截斷」把檔案內容清成 0 byte
```

> 為什麼清日誌要用 `>` 截斷，而不是 `rm` 刪除？
>
> - Nginx 正開著這個日誌檔的檔案描述符在寫入。`rm` 只移除目錄中的檔名，**行程握著的 fd 還在，磁碟空間不會釋放**，而且 Nginx 會繼續寫進那個「看不見的檔案」。
> - `> file` 是直接把檔案內容截斷成 0 byte，inode 不變、fd 仍有效，空間立即釋放，Nginx 也能繼續正常寫入。
> - 如果已經誤刪了，可以這樣找出「被刪除但仍被佔用」的檔案：
>   ```bash
>   sudo lsof +L1 | head -20
>   # lsof：列出行程開啟的檔案；+L1 只列「連結數小於 1」的檔案（已被 rm 但仍被某行程開著）
>   # 找到後對該行程 reload/重啟（Nginx 可用 nginx -s reopen 重開日誌檔），空間才會真正釋放
>   ```
> - 治本之道是設定 logrotate 定期切割日誌（參見第九章），不要等磁碟滿了才半夜起來清。

### 情境二：部署後網站出現 502

```bash
# 通常是新版本的後端還沒完全啟動

# 1. 確認後端是否在啟動中
sudo systemctl status your-app   # 狀態若是 activating，表示還在啟動流程中，再等等

# 2. 查看後端日誌
journalctl -u your-app --no-pager -n 50   # -u 指定服務、--no-pager 直接輸出、-n 50 最後 50 行（找啟動報錯）

# 3. 如果後端需要較長的啟動時間
# 可以在 upstream 設定中增加 fail_timeout
upstream backend {
    server localhost:3000 max_fails=5 fail_timeout=60s;
    # max_fails=5    ：在 fail_timeout 視窗（60 秒）內失敗滿 5 次，才把這台標記為不可用（預設 1 次，部署期間太敏感）
    # fail_timeout=60s：被標記不可用後，60 秒內不再嘗試連它；同時也是上面失敗次數的統計視窗（預設 10s）
}

# 4. 更好的做法：使用健康檢查腳本
# 等待後端真正準備好後再重載 Nginx
while ! curl -s http://localhost:3000/health > /dev/null; do
    # curl -s：靜默模式（不顯示進度條）；> /dev/null 丟棄回應內容，只取「連不連得上」的結果
    # while !：只要 curl 失敗（後端還沒就緒）就繼續迴圈
    echo "Waiting for backend..."
    sleep 2    # 每 2 秒重試一次，避免瘋狂輪詢
done
echo "Backend is ready!"
sudo nginx -s reload    # 確認後端就緒後才重載 Nginx（reload 是平滑重載，不中斷現有連線）
```

> 這個情境的因果鏈
>
> - 部署重啟後端 → 後端 port 短暫沒人聽 → Nginx 連線被拒（error.log：`111: Connection refused`）→ 回 502。
> - 若失敗次數超過 `max_fails`，這台會被標記不可用 `fail_timeout` 這麼久——**即使後端已經起來了，這段時間內 Nginx 還是回 502**（單台 upstream 時即 `no live upstreams`）。這就是「後端明明好了，502 卻多持續了一分鐘」的原因。
> - 進階解法：藍綠部署或兩台以上後端輪流重啟，讓任何時刻都有健康的後端可用，使用者完全無感。

### 情境三：特定頁面很慢但其他頁面正常

```bash
# 1. 分析存取日誌，找出慢的 URL
awk '{print $7, $NF}' /var/log/nginx/access.log | sort -k2 -rn | head -20
# awk '{print $7, $NF}'：印出第 7 欄與最後一欄
#   $7  在預設 main 格式中是請求路徑（"$request" 展開後的 GET /path HTTP/1.1 之中間段）
#   $NF 是每行最後一欄，這裡假設 log_format 行尾已加上 $request_time（加法見 10.4）
# sort -k2 -rn：依第 2 欄（回應時間）排序；-n 當數值比較、-r 由大到小
# head -20：取最慢的前 20 筆

# 2. 直接測試該 URL 的回應時間
time curl -o /dev/null -s -w "Total: %{time_total}s\nConnect: %{time_connect}s\nTTFB: %{time_starttransfer}s\n" https://mysite.com/slow-page
# -o /dev/null：丟棄回應內容（只關心時間數據）
# -s          ：靜默模式，不顯示下載進度條
# -w          ：請求完成後依自訂格式輸出 curl 量到的各階段時間：
#   %{time_total}         → 整個請求的總耗時
#   %{time_connect}       → TCP 連線建立耗時（偏高 → 網路或防火牆問題）
#   %{time_starttransfer} → 收到第一個 byte 的時間（TTFB；偏高 → 伺服器端處理慢）

# 3. 繞過 Nginx 直接測試後端
time curl http://localhost:3000/slow-page   # 與步驟 2 的結果相減比較，就能分辨慢在 Nginx 層還是後端

# 4. 如果後端本身就慢 → 後端效能問題（查詢、外部 API 等）
# 5. 如果後端快但透過 Nginx 慢 → 檢查 proxy 設定、buffering 等
```

> 三段時間的判讀範例
>
> - `Connect: 0.01s, TTFB: 4.8s, Total: 5.0s` → 連線很快、等回應很久 → 瓶頸在伺服器端處理（再用步驟 3 切分是 Nginx 還是後端）。
> - `Connect: 3.0s, TTFB: 3.2s, Total: 3.4s` → 光建立連線就 3 秒 → 網路層問題（DNS、路由、防火牆），與 Nginx 設定無關。
> - `TTFB: 0.2s, Total: 6.0s` → 第一個 byte 很快、傳完很慢 → 回應內容太大或客戶端網速問題，考慮壓縮與快取。

---

## 10.9 進階排查工具

當上述常規手段仍找不到原因時，可以動用更深入的工具。

### 開啟 debug 日誌

```nginx
# 方法一：全域開啟（資訊量極大，僅限排查期間使用）
error_log /var/log/nginx/debug.log debug;   # 等級調到 debug：會記錄 location 匹配、rewrite 過程、upstream 選擇等所有細節

# 方法二：只對特定來源 IP 開 debug（建議，避免正式流量把日誌灌爆）
events {
    debug_connection 203.0.113.10;     # 只有來自這個 IP 的連線會以 debug 等級記錄（填你自己的測試機 IP）
    debug_connection 192.168.1.0/24;   # 也可以指定整個網段
}
```

```bash
# 確認你的 Nginx 是否支援 debug 等級（需編譯時帶 --with-debug）
nginx -V 2>&1 | grep -o with-debug
# -V（大寫）：顯示版本與完整編譯參數；2>&1 把 stderr 併入 stdout 才能餵給 grep
# 有輸出 with-debug → 支援；沒有 → debug 等級會被靜默降級，看不到細節
# 官方 nginx.org 套件另附 nginx-debug 執行檔；多數發行版套件已內建 --with-debug
```

> 使用 debug 日誌的注意事項（逐條）
>
> - 日誌等級由低到高：`debug < info < notice < warn < error < crit < alert < emerg`；`error_log` 第二個參數是「最低記錄等級」，設 `debug` 等於全都記。
> - debug 等級在高流量站台**一分鐘可以寫出數 GB**，務必：限定來源 IP（方法二）、用獨立檔案、排查完立刻改回 `warn` 並 reload。
> - 在 debug 日誌中搜尋 `test location` 可以看到每個請求逐一嘗試匹配哪些 location、最後選中哪個——這是排查「請求進錯 location」的終極手段。

### 用 curl -v 觀察完整請求與回應

```bash
curl -v https://mysite.com/api/users
# -v（verbose）會逐行顯示三類資訊：
#   * 開頭的行 → 連線過程：DNS 解析到哪個 IP、TLS 握手、憑證資訊
#   > 開頭的行 → 實際送出的請求標頭（確認 Host、Cookie 是否如預期）
#   < 開頭的行 → 收到的回應標頭（狀態碼、Server、快取/重導向標頭都在這）

# 常用搭配技巧
curl -v -H "Host: mysite.com" http://203.0.113.10/
# 直接打 IP 並手動指定 Host 標頭 → 繞過 DNS，驗證「特定那台主機」的設定是否正確（DNS 切換前的預檢神器）

curl -vk https://mysite.com/
# -k：略過憑證驗證 → 憑證壞掉/過期時，仍可繼續測試 HTTP 層的行為

curl -v --resolve mysite.com:443:203.0.113.10 https://mysite.com/
# --resolve 域名:port:IP：把這個域名強制解析到指定 IP（連 SNI 與憑證驗證都按該域名走）
# 比 -H "Host: ..." 更完整，是測試「新伺服器 + HTTPS」的標準做法
```

### 用 strace 追蹤系統呼叫

```bash
# 1. 先找出 worker 行程的 PID
ps -ef | grep "nginx: worker"   # master 行程不處理請求，要追蹤的是 worker

# 2. 附加到 worker，觀察它實際在做什麼
sudo strace -p 12345 -f -e trace=network -s 200
# -p 12345        ：附加到 PID 為 12345 的行程（換成你查到的 worker PID）
# -f              ：連同它衍生的子行程一起追蹤
# -e trace=network：只顯示網路相關系統呼叫（connect/sendto/recvfrom...），過濾雜訊
# -s 200          ：字串內容最多顯示 200 字元（預設 32，常看不到完整的請求內容）

# 3. 常見用途：看 Nginx 開檔時「實際嘗試的路徑」（404/403 對不上設定時特別有用）
sudo strace -p 12345 -e trace=open,openat,stat 2>&1 | grep "/var/www"
# trace=open,openat,stat：只看檔案開啟與屬性查詢呼叫
# 邊 strace 邊用 curl 發一個請求，就能看到 worker 對哪個路徑呼叫了 openat、回了什麼錯誤碼
# （ENOENT = 檔案不存在 → 404；EACCES = 權限不足 → 403）
```

> strace 使用警告
>
> - strace 會攔截每一個系統呼叫，**被追蹤的 worker 效能會明顯下降**；正式環境只在低峰、短時間（幾十秒內）使用，按 Ctrl+C 即可解除附加。
> - 多 worker 時請求不一定落在你追蹤的那個 worker 上；排查時可暫時把 `worker_processes` 設為 `1`（記得排查完改回來），或同時開多個終端各追一個 worker。

### 用 lsof 檢查行程開了哪些資源

```bash
sudo lsof -i :80          # -i :80 列出所有使用 80 port 的行程與連線（查 port 被誰佔用的另一個選擇）
sudo lsof -p 12345 | head -30   # -p 指定 PID，列出該行程開啟的所有檔案、socket、日誌（看 fd 用量與實際開的檔案路徑）
sudo lsof +L1 | head -20        # +L1 列出「已被刪除但仍被開啟」的檔案（磁碟空間神祕消失時用，詳見 10.8 情境一）
```

---

## 10.10 本章小結

- 系統性排查：症狀 → 日誌 → 設定 → 系統資源
- 502 是最常見的上線問題，通常是後端服務的問題
- `nginx -t` 是每次修改設定後必做的檢查
- 善用 `$request_time` 和 `$upstream_response_time` 區分瓶頸位置
- 錯誤日誌的訊息（`Connection refused`、`upstream timed out`、`Permission denied`...）幾乎都直接指向根因，先學會讀訊息再動手改設定
- 保持快速排查清單在手邊，緊急情況時能快速定位問題
- 建立告警機制，在問題發生時第一時間收到通知

---

> 上一章：[日誌管理與監控](./09-logging-monitoring.md) | 下一章：[實際情境與解決方案](./11-real-world-scenarios.md)
