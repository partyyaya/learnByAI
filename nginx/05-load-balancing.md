# 第五章：負載均衡（Load Balancing）

## 5.1 什麼是負載均衡？

負載均衡是將客戶端請求分散到多台後端伺服器，避免單一伺服器負荷過大，提升系統的可用性與擴展性。

```
                        ┌──────────────┐
                        │  App Server 1 │
                   ┌───►│  (port 3001)  │
                   │    └──────────────┘
┌────────┐    ┌────┴────┐
│ Client ├───►│  Nginx  │  ┌──────────────┐
└────────┘    │  LB     ├─►│  App Server 2 │
              └────┬────┘  │  (port 3002)  │
                   │       └──────────────┘
                   │    ┌──────────────┐
                   └───►│  App Server 3 │
                        │  (port 3003)  │
                        └──────────────┘
```

---

## 5.2 upstream 區塊

Nginx 使用 `upstream` 區塊定義後端伺服器群組：

```nginx
http {
    # 定義後端伺服器群組
    upstream backend {
        server 192.168.1.10:3000;
        server 192.168.1.11:3000;
        server 192.168.1.12:3000;
    }

    server {
        listen 80;
        server_name myapp.com;

        location / {
            proxy_pass http://backend;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        }
    }
}
```

---

## 5.3 負載均衡演算法

### 1. Round Robin（輪詢，預設）

請求依序分配給每台伺服器：

```nginx
upstream backend {
    # 預設就是 Round Robin，不需額外設定
    server 192.168.1.10:3000;
    server 192.168.1.11:3000;
    server 192.168.1.12:3000;
}
# 請求分配：1→2→3→1→2→3→...
```

### 2. Weighted Round Robin（加權輪詢）

根據權重分配請求，效能較好的伺服器分配更多請求：

```nginx
upstream backend {
    server 192.168.1.10:3000 weight=5;   # 接收 5/8 的請求
    server 192.168.1.11:3000 weight=2;   # 接收 2/8 的請求
    server 192.168.1.12:3000 weight=1;   # 接收 1/8 的請求
}
```

**適用場景**：伺服器硬體規格不同時

### 3. Least Connections（最少連線）

將請求分配給當前活躍連線最少的伺服器：

```nginx
upstream backend {
    least_conn;
    server 192.168.1.10:3000;
    server 192.168.1.11:3000;
    server 192.168.1.12:3000;
}
```

**適用場景**：請求處理時間差異大的服務（如 API 有快有慢的查詢）

### 4. IP Hash

同一個客戶端 IP 的請求永遠分配到同一台伺服器：

```nginx
upstream backend {
    ip_hash;
    server 192.168.1.10:3000;
    server 192.168.1.11:3000;
    server 192.168.1.12:3000;
}
```

**適用場景**：需要 Session 粘性（Session Sticky）的應用

> **注意**：ip_hash 在使用 CDN 或反向代理時可能失效，因為所有請求的來源 IP 都相同。

### 5. Generic Hash

根據自訂的 key 做雜湊分配：

```nginx
upstream backend {
    hash $request_uri consistent;  # 根據 URI 分配，consistent 表示一致性雜湊
    server 192.168.1.10:3000;
    server 192.168.1.11:3000;
    server 192.168.1.12:3000;
}
```

**適用場景**：快取場景，確保相同 URL 的請求打到同一台伺服器以提高快取命中率

### 6. Random（隨機）

```nginx
upstream backend {
    random two least_conn;  # 隨機選兩台，再從中選連線最少的
    server 192.168.1.10:3000;
    server 192.168.1.11:3000;
    server 192.168.1.12:3000;
}
```

### 演算法比較

```
演算法           分配方式             Session 保持    適用場景
─────────────────────────────────────────────────────────────
Round Robin     依序分配             否              通用場景
Weighted        按權重分配           否              硬體規格不同
Least Conn      最少連線優先         否              處理時間不均
IP Hash         按 IP 雜湊           是              需要 Session 粘性
Generic Hash    按自訂 key 雜湊      取決於 key      快取優化
Random          隨機                 否              大規模叢集
```

---

## 5.4 伺服器狀態控制

```nginx
upstream backend {
    server 192.168.1.10:3000;                    # 正常
    server 192.168.1.11:3000 weight=2;           # 權重 2
    server 192.168.1.12:3000 backup;             # 備用伺服器（其他伺服器都掛了才啟用）
    server 192.168.1.13:3000 down;               # 標記為下線（不接收請求）
    server 192.168.1.14:3000 max_fails=3 fail_timeout=30s;  # 健康檢查參數
}
```

### 參數說明

| 參數 | 說明 |
|------|------|
| `weight=N` | 權重，預設為 1 |
| `max_fails=N` | 允許失敗次數，超過則視為不可用，預設為 1 |
| `fail_timeout=Ns` | 失敗後的暫停時間，預設為 10s |
| `backup` | 備用伺服器 |
| `down` | 標記為永久下線 |
| `max_conns=N` | 限制最大並發連線數 |
| `slow_start=Ns` | 伺服器恢復後，權重逐漸增加的時間（商業版） |

---

## 5.5 健康檢查（被動）

Nginx 開源版內建被動健康檢查：

```nginx
upstream backend {
    server 192.168.1.10:3000 max_fails=3 fail_timeout=30s;
    server 192.168.1.11:3000 max_fails=3 fail_timeout=30s;
    server 192.168.1.12:3000 max_fails=3 fail_timeout=30s;
}
```

**工作原理**：

1. 將請求轉發給後端
2. 如果後端回傳錯誤（由 `proxy_next_upstream` 定義），失敗計數 +1
3. 失敗次數達到 `max_fails` → 標記為不可用
4. 等待 `fail_timeout` 後，重新嘗試發送請求
5. 如果成功，重置失敗計數

```nginx
server {
    location / {
        proxy_pass http://backend;

        # 定義什麼情況算「失敗」
        proxy_next_upstream error timeout http_500 http_502 http_503;

        # 嘗試下一台的次數
        proxy_next_upstream_tries 3;

        # 嘗試下一台的最大時間
        proxy_next_upstream_timeout 10s;
    }
}
```

---

## 5.6 Session 持久化

### 方法一：IP Hash

```nginx
upstream backend {
    ip_hash;
    server 192.168.1.10:3000;
    server 192.168.1.11:3000;
}
```

### 方法二：Cookie-based（推薦）

```nginx
# 使用 map 從 cookie 中取得路由資訊
map $cookie_SERVERID $backend_server {
    server1 192.168.1.10:3000;
    server2 192.168.1.11:3000;
    default 192.168.1.10:3000;
}
```

### 方法三：後端共享 Session（最佳解法）

最理想的做法是讓後端應用程式使用共享的 Session 儲存：

```
                    ┌──────────────┐
              ┌────►│  App Server 1 │──┐
              │     └──────────────┘  │
┌────────┐  ┌─┴──┐                    ▼
│ Client ├─►│ LB │              ┌──────────┐
└────────┘  └─┬──┘              │  Redis   │
              │     ┌──────────────┐  │  (Session) │
              └────►│  App Server 2 │──┘   └──────────┘
                    └──────────────┘
```

---

## 5.7 完整的生產環境負載均衡設定

```nginx
upstream api_servers {
    least_conn;

    # 主要伺服器
    server 10.0.1.10:3000 weight=3 max_fails=3 fail_timeout=30s;
    server 10.0.1.11:3000 weight=3 max_fails=3 fail_timeout=30s;
    server 10.0.1.12:3000 weight=2 max_fails=3 fail_timeout=30s;

    # 備用伺服器
    server 10.0.2.10:3000 backup;

    # Keep-Alive 連線池
    keepalive 32;
    keepalive_requests 1000;
    keepalive_timeout 60s;
}

server {
    listen 80;
    server_name api.myapp.com;

    # 存取日誌（含 upstream 資訊）
    log_format upstream_log '$remote_addr - [$time_local] '
                            '"$request" $status $body_bytes_sent '
                            'upstream: $upstream_addr '
                            'response_time: $upstream_response_time '
                            'status: $upstream_status';

    access_log /var/log/nginx/api.access.log upstream_log;

    location / {
        proxy_pass http://api_servers;
        proxy_http_version 1.1;

        # Keep-Alive 支援（配合 upstream 的 keepalive）
        proxy_set_header Connection "";

        # 標頭
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 逾時
        proxy_connect_timeout 5s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;

        # 失敗轉移
        proxy_next_upstream error timeout http_500 http_502 http_503;
        proxy_next_upstream_tries 2;
        proxy_next_upstream_timeout 10s;
    }

    # 健康檢查端點（不需負載均衡）
    location /nginx-health {
        return 200 'OK';
        add_header Content-Type text/plain;
    }
}
```

---

## 5.8 實際情境

### 情境一：部署新版本時不中斷服務（滾動更新）

```bash
# 假設有 3 台後端伺服器

# 步驟一：將第一台標記為 down
# 修改 upstream 設定
# server 10.0.1.10:3000 down;

# 步驟二：重載 Nginx
sudo nginx -t && sudo nginx -s reload

# 步驟三：更新第一台伺服器的應用程式
# ... 部署流程 ...

# 步驟四：恢復第一台，將第二台標記為 down
# 重複上述流程直到所有伺服器都更新完成
```

**更好的做法 — 使用腳本自動化**：

```bash
#!/bin/bash
# rolling-deploy.sh

SERVERS=("10.0.1.10" "10.0.1.11" "10.0.1.12")
NGINX_CONF="/etc/nginx/conf.d/upstream.conf"

for server in "${SERVERS[@]}"; do
    echo "Deploying to $server..."

    # 從負載均衡中移除
    sed -i "s/server $server:3000;/server $server:3000 down;/" $NGINX_CONF
    nginx -t && nginx -s reload
    sleep 5  # 等待現有請求處理完畢

    # 部署新版本
    ssh deploy@$server "cd /app && git pull && pm2 restart all"
    sleep 10  # 等待應用程式啟動

    # 重新加入負載均衡
    sed -i "s/server $server:3000 down;/server $server:3000;/" $NGINX_CONF
    nginx -t && nginx -s reload
    sleep 3

    echo "$server deployed successfully!"
done

echo "Rolling deploy completed!"
```

### 情境二：某台伺服器頻繁被標記為不可用

**問題**：日誌中出現大量 `upstream server temporarily disabled`

```bash
# 檢查錯誤日誌
tail -f /var/log/nginx/error.log | grep upstream

# 常見原因與解決方案：

# 1. 後端回應太慢
# → 調整逾時時間
proxy_read_timeout 120s;

# 2. 後端偶發性錯誤
# → 調整容錯參數
upstream backend {
    server 10.0.1.10:3000 max_fails=5 fail_timeout=10s;
}

# 3. 後端記憶體不足
# → 監控後端伺服器資源
ssh admin@10.0.1.10 "free -m && top -bn1 | head -20"
```

### 情境三：負載不均勻

**問題**：某台伺服器的負載遠高於其他伺服器

```nginx
# 排查步驟：

# 1. 檢查日誌確認請求分配
# 在 log_format 中加入 $upstream_addr
access_log /var/log/nginx/access.log upstream_log;

# 2. 統計每台伺服器收到的請求數
# grep -c "upstream: 10.0.1.10" /var/log/nginx/api.access.log
# grep -c "upstream: 10.0.1.11" /var/log/nginx/api.access.log

# 3. 可能的原因
# - 使用了 ip_hash，某些 IP 的請求量特別大
# - 權重設定不合理
# - 某台伺服器剛從 down 狀態恢復

# 解決方案：改用 least_conn
upstream backend {
    least_conn;
    server 10.0.1.10:3000;
    server 10.0.1.11:3000;
    server 10.0.1.12:3000;
}
```

### 情境四：需要在不停機的情況下加入新伺服器

```bash
# 1. 編輯 upstream 設定，加入新伺服器
sudo nano /etc/nginx/conf.d/upstream.conf

# 2. 測試設定
sudo nginx -t

# 3. 平滑重載（現有連線不受影響）
sudo nginx -s reload

# 注意：reload 是 graceful 的，不會中斷現有連線
```

---

## 5.9 本章小結

- 負載均衡是避免單一伺服器負荷過大的關鍵技術
- Nginx 提供多種負載均衡演算法，根據場景選擇合適的演算法
- `least_conn` 是大多數場景的最佳選擇
- 被動健康檢查透過 `max_fails` 和 `fail_timeout` 實現
- 使用 `keepalive` 減少後端連線建立的開銷
- Session 持久化最好透過後端共享 Session 儲存來實現
- 滾動更新可以實現零停機部署

---

> 上一章：[反向代理](./04-reverse-proxy.md) | 下一章：[SSL/HTTPS 設定](./06-ssl-https.md)
