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
    client_header_buffer_size 4k;
    large_client_header_buffers 4 32k;

    # 如果是 Cookie 太大造成
    # 檢查應用程式是否設了過多的 Cookie
}
```

### 403 Forbidden

```bash
# 排查步驟

# 1. 檢查檔案權限
ls -la /var/www/mysite/
# 確保 Nginx worker 使用者（通常是 www-data）有讀取權限
sudo chown -R www-data:www-data /var/www/mysite
sudo chmod -R 755 /var/www/mysite

# 2. 確認 index 檔案存在
ls -la /var/www/mysite/html/index.html

# 3. 檢查 Nginx 設定中是否有 deny 規則
nginx -T | grep -i deny

# 4. 檢查 SELinux（CentOS/RHEL）
getenforce
# 如果是 Enforcing，可能需要：
sudo semanage fcontext -a -t httpd_sys_content_t "/var/www/mysite(/.*)?"
sudo restorecon -Rv /var/www/mysite
```

### 404 Not Found

```bash
# 排查步驟

# 1. 確認檔案是否存在
ls -la /var/www/mysite/html/requested-page.html

# 2. 確認 root 或 alias 設定是否正確
nginx -T | grep -A5 "server_name mysite.com"

# 3. 確認 location 匹配是否正確
# 使用 debug 日誌確認匹配了哪個 location
error_log /var/log/nginx/debug.log debug;

# 4. SPA 應用常見問題 — 重新整理頁面出現 404
# 解決：
location / {
    try_files $uri $uri/ /index.html;
}
```

### 499 Client Closed Request

```
原因：客戶端在伺服器回應前關閉了連線
常見情況：
  - 後端回應太慢，客戶端等不及
  - 使用者重複點擊或切換頁面
  - 前端設定的超時時間太短
```

```nginx
# 如果大量出現 499，需要優化後端回應速度
# 或調整前端超時時間

# 日誌中 499 不會顯示在 error_log，只在 access_log
```

### 502 Bad Gateway

```bash
# 最常見的反向代理錯誤

# 排查步驟

# 1. 確認後端服務是否在運行
sudo systemctl status your-app
curl http://localhost:3000/health

# 2. 確認後端 port 和地址是否正確
sudo ss -tlnp | grep 3000

# 3. 檢查 Nginx 錯誤日誌
tail -20 /var/log/nginx/error.log

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
```

### 503 Service Unavailable

```bash
# 原因：
# - 後端所有伺服器都不可用
# - Nginx 主動返回（維護模式）
# - 超過速率限制（如果設定了 limit_req_status 503）

# 排查步驟

# 1. 檢查 upstream 伺服器狀態
tail -f /var/log/nginx/error.log | grep upstream

# 2. 確認是否處於維護模式
nginx -T | grep "return 503"

# 3. 檢查速率限制設定
nginx -T | grep limit_req
```

### 504 Gateway Timeout

```bash
# 原因：後端回應超時

# 排查步驟

# 1. 確認後端是否有回應
time curl http://localhost:3000/slow-endpoint

# 2. 調整 Nginx 超時設定
```

```nginx
location / {
    proxy_pass http://backend;

    # 增加超時時間
    proxy_connect_timeout 30s;   # 連線後端的超時
    proxy_send_timeout 120s;     # 發送請求到後端的超時
    proxy_read_timeout 120s;     # 讀取後端回應的超時

    # 如果是 FastCGI
    # fastcgi_read_timeout 120s;
}
```

```bash
# 3. 檢查後端是否有效能問題
# 查看後端日誌
# 查看後端資源使用情況
ssh admin@backend-server "top -bn1 | head -20"
```

---

## 10.3 Nginx 無法啟動

```bash
# 排查步驟

# 1. 測試設定檔語法
sudo nginx -t
# 如果有錯誤，會顯示具體的檔案和行號

# 2. 檢查 port 是否被佔用
sudo ss -tlnp | grep :80
sudo ss -tlnp | grep :443

# 3. 檢查日誌
sudo journalctl -u nginx --no-pager -n 50
# 或
tail -20 /var/log/nginx/error.log

# 4. 檢查 SSL 憑證是否有效
sudo openssl x509 -in /path/to/cert.pem -noout -dates

# 5. 檢查 PID 檔案
cat /var/run/nginx.pid
# 如果行程已死但 PID 檔案還在：
sudo rm /var/run/nginx.pid
sudo systemctl start nginx

# 6. 檢查權限
ls -la /var/log/nginx/
ls -la /var/run/
```

---

## 10.4 效能問題排查

### 回應速度慢

```bash
# 1. 分析存取日誌的回應時間
# 找出回應時間超過 3 秒的請求
awk '$NF > 3' /var/log/nginx/access.log | tail -20

# 2. 區分是 Nginx 慢還是後端慢
# 比較 $request_time 和 $upstream_response_time
# 如果 upstream_response_time 接近 request_time → 後端慢
# 如果 request_time 遠大於 upstream_response_time → Nginx 或網路問題

# 3. 檢查系統資源
top -bn1 | head -20        # CPU 和記憶體
iostat -x 1 3              # 磁碟 I/O
ss -s                      # 網路連線統計
cat /proc/net/sockstat      # socket 統計

# 4. 檢查 Nginx worker 連線數
curl http://localhost/nginx_status
# 如果 Active connections 接近 worker_connections → 需要擴容
```

### 高 CPU 使用率

```bash
# 1. 確認是 Nginx 還是其他行程
top -c | head -20

# 2. 如果是 Nginx worker CPU 高
# - 檢查是否有大量的正規表示式匹配
# - 檢查是否有大量的 gzip 壓縮（降低壓縮等級）
# - 檢查是否有大量的 SSL 握手（啟用 SSL session cache）

# 3. 優化
gzip_comp_level 4;           # 降低壓縮等級
ssl_session_cache shared:SSL:10m;  # SSL session 快取
```

### 高記憶體使用

```bash
# 1. 檢查 Nginx 記憶體使用
ps aux | grep nginx

# 2. 可能的原因
# - proxy_buffering 緩衝太大
# - proxy_cache 快取太大
# - worker_connections 設太高
# - 大量的長連線（WebSocket）

# 3. 調整緩衝區
proxy_buffer_size 4k;
proxy_buffers 4 4k;
proxy_busy_buffers_size 8k;
```

---

## 10.5 SSL/HTTPS 問題

```bash
# 1. 測試 SSL 連線
openssl s_client -connect mysite.com:443 -servername mysite.com

# 2. 檢查憑證到期日
echo | openssl s_client -connect mysite.com:443 -servername mysite.com 2>/dev/null | openssl x509 -noout -dates

# 3. 檢查憑證鏈
echo | openssl s_client -connect mysite.com:443 -servername mysite.com -showcerts 2>/dev/null

# 4. 常見問題
# "SSL: error:0B080074:x509 certificate routines:X509_check_private_key:key values mismatch"
#   → 憑證和私鑰不匹配
#   → 確認使用了正確的 fullchain.pem 和 privkey.pem

# "SSL_CTX_use_certificate:ee key too small"
#   → 金鑰長度不足，需要至少 2048 位

# 5. 使用線上工具測試
# https://www.ssllabs.com/ssltest/
```

---

## 10.6 連線與網路問題

### DNS 解析問題

```bash
# 確認 DNS 解析
dig mysite.com
nslookup mysite.com

# Nginx 內部 DNS 快取問題
# upstream 中使用域名時，Nginx 預設在啟動時解析一次
# 如果 IP 會變（如 AWS ELB），需要設定 resolver

resolver 8.8.8.8 valid=30s;

upstream backend {
    server backend.internal.com:3000 resolve;
}
```

### 連線被拒

```bash
# 1. 檢查防火牆
sudo ufw status                    # Ubuntu
sudo firewall-cmd --list-all       # CentOS

# 2. 檢查安全群組（雲端環境）
# AWS: Security Group
# GCP: Firewall Rules
# Azure: Network Security Group

# 3. 檢查 Nginx 是否綁定在正確的地址
sudo ss -tlnp | grep nginx
# 如果只顯示 127.0.0.1:80 → 只監聽本地
# 應該顯示 0.0.0.0:80 或 *:80 → 監聽所有介面
```

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
├── 504 → 後端回應超時
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

# 2. 檢查 Nginx 狀態
sudo systemctl status nginx
# 如果 Nginx 沒在跑
sudo systemctl start nginx

# 3. 如果 Nginx 在跑但回傳錯誤
tail -50 /var/log/nginx/error.log

# 4. 檢查後端
curl http://localhost:3000/health
sudo systemctl status your-app

# 5. 檢查系統資源
free -m        # 記憶體是否耗盡
df -h          # 磁碟是否滿了
top -bn1       # CPU 使用狀況

# 6. 如果是 OOM（Out of Memory）
dmesg | grep -i "out of memory"
# 重啟被殺掉的服務
sudo systemctl restart your-app

# 7. 如果是磁碟滿了
du -sh /var/log/nginx/*
> /var/log/nginx/access.log   # 緊急清空
```

### 情境二：部署後網站出現 502

```bash
# 通常是新版本的後端還沒完全啟動

# 1. 確認後端是否在啟動中
sudo systemctl status your-app

# 2. 查看後端日誌
journalctl -u your-app --no-pager -n 50

# 3. 如果後端需要較長的啟動時間
# 可以在 upstream 設定中增加 fail_timeout
upstream backend {
    server localhost:3000 max_fails=5 fail_timeout=60s;
}

# 4. 更好的做法：使用健康檢查腳本
# 等待後端真正準備好後再重載 Nginx
while ! curl -s http://localhost:3000/health > /dev/null; do
    echo "Waiting for backend..."
    sleep 2
done
echo "Backend is ready!"
sudo nginx -s reload
```

### 情境三：特定頁面很慢但其他頁面正常

```bash
# 1. 分析存取日誌，找出慢的 URL
awk '{print $7, $NF}' /var/log/nginx/access.log | sort -k2 -rn | head -20

# 2. 直接測試該 URL 的回應時間
time curl -o /dev/null -s -w "Total: %{time_total}s\nConnect: %{time_connect}s\nTTFB: %{time_starttransfer}s\n" https://mysite.com/slow-page

# 3. 繞過 Nginx 直接測試後端
time curl http://localhost:3000/slow-page

# 4. 如果後端本身就慢 → 後端效能問題（查詢、外部 API 等）
# 5. 如果後端快但透過 Nginx 慢 → 檢查 proxy 設定、buffering 等
```

---

## 10.9 本章小結

- 系統性排查：症狀 → 日誌 → 設定 → 系統資源
- 502 是最常見的上線問題，通常是後端服務的問題
- `nginx -t` 是每次修改設定後必做的檢查
- 善用 `$request_time` 和 `$upstream_response_time` 區分瓶頸位置
- 保持快速排查清單在手邊，緊急情況時能快速定位問題
- 建立告警機制，在問題發生時第一時間收到通知

---

> 上一章：[日誌管理與監控](./09-logging-monitoring.md) | 下一章：[實際情境與解決方案](./11-real-world-scenarios.md)
