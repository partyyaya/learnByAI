# 第九章：日誌管理與監控

## 9.1 Nginx 日誌類型

Nginx 有兩種主要日誌：

| 日誌類型 | 檔案 | 用途 |
|----------|------|------|
| 存取日誌（Access Log） | `/var/log/nginx/access.log` | 記錄所有客戶端請求 |
| 錯誤日誌（Error Log） | `/var/log/nginx/error.log` | 記錄錯誤和警告資訊 |

---

## 9.2 自訂存取日誌格式

### 預設格式

```nginx
log_format combined '$remote_addr - $remote_user [$time_local] '
                    '"$request" $status $body_bytes_sent '
                    '"$http_referer" "$http_user_agent"';
```

### 自訂增強格式

```nginx
# 基本增強格式
log_format main '$remote_addr - $remote_user [$time_local] '
                '"$request" $status $body_bytes_sent '
                '"$http_referer" "$http_user_agent" '
                'rt=$request_time urt=$upstream_response_time '
                'uaddr=$upstream_addr us=$upstream_status';
```

### 含效能指標的格式

```nginx
log_format performance '$remote_addr [$time_local] '
                       '"$request" $status $body_bytes_sent '
                       'request_time=$request_time '
                       'upstream_time=$upstream_response_time '
                       'upstream_addr=$upstream_addr '
                       'upstream_status=$upstream_status '
                       'cache_status=$upstream_cache_status '
                       'connection=$connection '
                       'connection_requests=$connection_requests';
```

### JSON 格式（方便後續分析工具解析）

```nginx
log_format json_log escape=json '{'
    '"time": "$time_iso8601", '
    '"remote_addr": "$remote_addr", '
    '"remote_user": "$remote_user", '
    '"request_method": "$request_method", '
    '"request_uri": "$request_uri", '
    '"status": $status, '
    '"body_bytes_sent": $body_bytes_sent, '
    '"request_time": $request_time, '
    '"http_referer": "$http_referer", '
    '"http_user_agent": "$http_user_agent", '
    '"upstream_addr": "$upstream_addr", '
    '"upstream_status": "$upstream_status", '
    '"upstream_response_time": "$upstream_response_time", '
    '"http_x_forwarded_for": "$http_x_forwarded_for"'
'}';
```

### 使用日誌格式

```nginx
server {
    # 使用自訂格式
    access_log /var/log/nginx/myapp.access.log json_log;

    # 壓縮日誌（減少磁碟空間）
    access_log /var/log/nginx/myapp.access.log.gz json_log gzip flush=5m;

    # 條件性日誌（只記錄特定請求）
    # 不記錄健康檢查
    map $request_uri $loggable {
        ~*^/health 0;
        ~*^/nginx_status 0;
        default 1;
    }
    access_log /var/log/nginx/myapp.access.log main if=$loggable;

    # 針對特定 location 關閉日誌
    location /health {
        access_log off;
        return 200 'OK';
    }
}
```

---

## 9.3 錯誤日誌設定

```nginx
# 錯誤日誌等級（從低到高）
# debug → info → notice → warn → error → crit → alert → emerg

# 全域錯誤日誌
error_log /var/log/nginx/error.log warn;

# 每個 server 可以有獨立的錯誤日誌
server {
    server_name myapp.com;
    error_log /var/log/nginx/myapp.error.log error;

    # 開發環境使用 debug 等級
    # error_log /var/log/nginx/myapp.error.log debug;
}
```

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

---

## 9.4 日誌輪替（Log Rotation）

### 使用 logrotate（推薦）

```bash
# /etc/logrotate.d/nginx
/var/log/nginx/*.log {
    daily               # 每天輪替
    missingok           # 檔案不存在也不報錯
    rotate 30           # 保留 30 天
    compress            # 壓縮舊日誌
    delaycompress       # 延遲一天再壓縮
    notifempty          # 空檔案不輪替
    create 0640 www-data adm   # 新檔案的權限
    sharedscripts
    postrotate
        # 輪替後通知 Nginx 重新開啟日誌檔案
        if [ -f /var/run/nginx.pid ]; then
            kill -USR1 `cat /var/run/nginx.pid`
        fi
    endscript
}
```

```bash
# 手動執行輪替測試
sudo logrotate -d /etc/logrotate.d/nginx   # 乾跑（不實際執行）
sudo logrotate -f /etc/logrotate.d/nginx   # 強制執行
```

### 手動輪替

```bash
# 移動日誌檔案
mv /var/log/nginx/access.log /var/log/nginx/access.log.$(date +%Y%m%d)

# 通知 Nginx 重新開啟日誌
nginx -s reopen
# 或
kill -USR1 $(cat /var/run/nginx.pid)

# 壓縮舊日誌
gzip /var/log/nginx/access.log.*
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
        stub_status;
        allow 127.0.0.1;
        allow 10.0.0.0/8;
        deny all;
    }
}
```

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

---

## 9.6 日誌分析

### 常用日誌分析指令

```bash
# 1. 找出請求最多的 IP
awk '{print $1}' /var/log/nginx/access.log | sort | uniq -c | sort -rn | head -20

# 2. 找出請求最多的 URL
awk '{print $7}' /var/log/nginx/access.log | sort | uniq -c | sort -rn | head -20

# 3. 找出回應時間最長的請求
awk '$NF > 5 {print $0}' /var/log/nginx/access.log   # 超過 5 秒的請求

# 4. 統計 HTTP 狀態碼分佈
awk '{print $9}' /var/log/nginx/access.log | sort | uniq -c | sort -rn

# 5. 找出所有 5xx 錯誤
awk '$9 >= 500 && $9 < 600' /var/log/nginx/access.log

# 6. 按小時統計請求數
awk '{print $4}' /var/log/nginx/access.log | cut -d: -f1,2 | uniq -c

# 7. 統計 User-Agent
awk -F'"' '{print $6}' /var/log/nginx/access.log | sort | uniq -c | sort -rn | head -10
```

### 使用 GoAccess 即時分析

```bash
# 安裝 GoAccess
sudo apt install goaccess -y

# 即時終端機模式
goaccess /var/log/nginx/access.log --log-format=COMBINED

# 生成 HTML 報告
goaccess /var/log/nginx/access.log -o /var/www/report.html --log-format=COMBINED --real-time-html

# 搭配 Nginx 提供報告頁面
# location /report {
#     alias /var/www/report.html;
#     auth_basic "Stats";
#     auth_basic_user_file /etc/nginx/.htpasswd;
# }
```

---

## 9.7 整合監控系統

### Prometheus + Nginx Exporter

```bash
# 安裝 nginx-prometheus-exporter
docker run -d --name nginx-exporter \
    -p 9113:9113 \
    nginx/nginx-prometheus-exporter:latest \
    -nginx.scrape-uri=http://host.docker.internal/nginx_status
```

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'nginx'
    static_configs:
      - targets: ['localhost:9113']
```

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

---

## 9.8 告警設定

### 簡易的日誌監控腳本

```bash
#!/bin/bash
# /opt/scripts/nginx-alert.sh

LOG_FILE="/var/log/nginx/access.log"
ALERT_EMAIL="admin@mysite.com"
THRESHOLD_5XX=50        # 5xx 錯誤數量閾值
THRESHOLD_CONN=1000     # 活躍連線數閾值

# 檢查最近 5 分鐘的 5xx 錯誤數
FIVE_MINUTES_AGO=$(date -d '5 minutes ago' '+%d/%b/%Y:%H:%M')
ERROR_COUNT=$(awk -v time="$FIVE_MINUTES_AGO" '$4 >= "["time && $9 >= 500 && $9 < 600' $LOG_FILE | wc -l)

if [ "$ERROR_COUNT" -gt "$THRESHOLD_5XX" ]; then
    echo "ALERT: $ERROR_COUNT 5xx errors in last 5 minutes" | \
        mail -s "Nginx 5xx Alert" $ALERT_EMAIL
fi

# 檢查活躍連線數
ACTIVE_CONN=$(curl -s http://localhost/nginx_status | awk '/Active/ {print $3}')

if [ "$ACTIVE_CONN" -gt "$THRESHOLD_CONN" ]; then
    echo "ALERT: Active connections: $ACTIVE_CONN" | \
        mail -s "Nginx High Connections Alert" $ALERT_EMAIL
fi
```

```bash
# 加入 cron 每 5 分鐘執行
*/5 * * * * /opt/scripts/nginx-alert.sh
```

---

## 9.9 實際情境

### 情境一：磁碟空間被日誌塞滿

**問題**：伺服器磁碟空間不足，影響服務運作

```bash
# 1. 確認日誌大小
du -sh /var/log/nginx/*

# 2. 緊急清理（不中斷服務）
# 不要直接刪除正在寫入的日誌！
# 錯誤做法：rm /var/log/nginx/access.log（Nginx 仍會寫入已刪除的 inode）
# 正確做法：
> /var/log/nginx/access.log    # 清空檔案內容
# 或
truncate -s 0 /var/log/nginx/access.log

# 3. 設定 logrotate 防止再次發生
# 確認 /etc/logrotate.d/nginx 設定正確
sudo logrotate -f /etc/logrotate.d/nginx

# 4. 考慮減少日誌量
# 關閉不需要的日誌
location ~* \.(js|css|png|jpg|gif|ico)$ {
    access_log off;
}
```

### 情境二：分析異常流量來源

**問題**：網站流量突然暴增，需要分析來源

```bash
# 1. 按 IP 統計請求數（最近 1 小時）
HOUR_AGO=$(date -d '1 hour ago' '+%d/%b/%Y:%H')
awk -v time="$HOUR_AGO" '$4 >= "["time' /var/log/nginx/access.log | \
    awk '{print $1}' | sort | uniq -c | sort -rn | head -20

# 2. 分析異常 IP 的請求模式
grep "1.2.3.4" /var/log/nginx/access.log | tail -50

# 3. 檢查是否為爬蟲
grep "1.2.3.4" /var/log/nginx/access.log | awk -F'"' '{print $6}' | sort -u

# 4. 必要時封鎖惡意 IP
echo "deny 1.2.3.4;" >> /etc/nginx/conf.d/blocked-ips.conf
sudo nginx -t && sudo nginx -s reload
```

### 情境三：追蹤特定使用者的請求鏈路

```nginx
# 使用 request_id 追蹤請求
log_format traced '$remote_addr [$time_local] '
                  '"$request" $status $body_bytes_sent '
                  'request_id=$request_id '
                  'trace_id=$http_x_trace_id';

server {
    # 生成唯一請求 ID
    add_header X-Request-ID $request_id;

    location /api/ {
        proxy_pass http://backend;
        # 將 request_id 傳給後端
        proxy_set_header X-Request-ID $request_id;
    }
}
```

```bash
# 用 request_id 追蹤完整的請求鏈路
grep "request_id=abc123" /var/log/nginx/access.log
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
