# 第十二章：高可用架構與容災設計

## 12.1 什麼是高可用（High Availability）？

高可用性是指系統能在預定的時間內持續運作的能力，通常以「幾個 9」來衡量：

| 可用性 | 年度允許停機時間 | 等級 |
|--------|-----------------|------|
| 99%（兩個 9） | 3.65 天 | 基本 |
| 99.9%（三個 9） | 8.76 小時 | 一般生產環境 |
| 99.99%（四個 9） | 52.6 分鐘 | 高要求系統 |
| 99.999%（五個 9） | 5.26 分鐘 | 金融/醫療等級 |

### 高可用的核心原則

```
1. 消除單點故障（SPOF - Single Point of Failure）
   → 每個關鍵元件都有備援

2. 故障自動偵測
   → 健康檢查、監控告警

3. 故障自動切換（Failover）
   → 無需人工介入即可恢復服務

4. 資料一致性
   → 多台伺服器的資料保持同步
```

---

## 12.2 Nginx 高可用架構

### 架構一：單層 Nginx + 多後端

```
                    ┌──────────┐
              ┌────►│ Backend 1 │
              │     └──────────┘
┌────────┐  ┌─┴──┐ ┌──────────┐
│ Client ├─►│ LB ├►│ Backend 2 │
└────────┘  └─┬──┘ └──────────┘
              │     ┌──────────┐
              └────►│ Backend 3 │
                    └──────────┘

問題：Nginx 本身是單點故障
```

### 架構二：Nginx 雙機熱備（Keepalived）

```
                          ┌──────────┐
                    ┌────►│ Backend 1 │
                    │     └──────────┘
┌────────┐  ┌──────┴──────┐
│ Client ├─►│ Virtual IP   │
└────────┘  │ (Keepalived) │
            └──────┬──────┘
            ┌──────┴──────┐
      ┌─────┤             ├─────┐
      │     │             │     │
┌─────┴──┐  │         ┌──┴─────┐
│ Nginx  │  │         │ Nginx  │
│ Master │◄─┘         │ Backup │
└────────┘            └────────┘

說明：兩台 Nginx 共享一個虛擬 IP（VIP）
      Master 掛掉時，Backup 自動接手
```

### 架構三：DNS 輪詢 + 多台 Nginx

```
                ┌───────────┐     ┌──────────┐
          ┌────►│ Nginx LB 1├────►│ Backends │
          │     └───────────┘     └──────────┘
┌────────┐│
│ Client ├┤     DNS Round Robin
└────────┘│
          │     ┌───────────┐     ┌──────────┐
          └────►│ Nginx LB 2├────►│ Backends │
                └───────────┘     └──────────┘
```

### 架構四：雲端方案（推薦）

```
                ┌──────────────────────┐
                │    Cloud LB          │
                │ (AWS ALB/NLB, GCP LB)│
                └──────┬───────────────┘
                       │
              ┌────────┼────────┐
              │        │        │
        ┌─────┴──┐ ┌──┴─────┐ ┌┴────────┐
        │ Nginx 1│ │ Nginx 2│ │ Nginx 3 │
        └────┬───┘ └───┬────┘ └────┬────┘
             │         │           │
        ┌────┴─────────┴───────────┴────┐
        │        Backend Servers         │
        └────────────────────────────────┘

說明：使用雲端負載均衡器作為最前層
      Nginx 本身也做水平擴展
```

---

## 12.3 Keepalived 實現 Nginx 雙機熱備

### 安裝 Keepalived

```bash
# Ubuntu
sudo apt install keepalived -y

# CentOS
sudo yum install keepalived -y
```

### Master 設定

```bash
# /etc/keepalived/keepalived.conf（Master）

global_defs {
    router_id NGINX_MASTER
}

# Nginx 健康檢查腳本
vrrp_script check_nginx {
    script "/etc/keepalived/check_nginx.sh"
    interval 2      # 每 2 秒檢查一次
    weight -20       # 檢查失敗時降低優先權 20
    fall 3           # 連續失敗 3 次才判定為失敗
    rise 2           # 連續成功 2 次才判定為恢復
}

vrrp_instance VI_1 {
    state MASTER
    interface eth0              # 網路介面（根據實際情況修改）
    virtual_router_id 51        # 同一組的 Master 和 Backup 要相同
    priority 100                # Master 優先權較高
    advert_int 1                # VRRP 通告間隔（秒）

    authentication {
        auth_type PASS
        auth_pass mypassword    # 認證密碼，Master/Backup 要一致
    }

    virtual_ipaddress {
        192.168.1.100/24        # 虛擬 IP（VIP）
    }

    track_script {
        check_nginx
    }

    # 狀態變更時的通知腳本
    notify_master "/etc/keepalived/notify.sh master"
    notify_backup "/etc/keepalived/notify.sh backup"
    notify_fault  "/etc/keepalived/notify.sh fault"
}
```

### Backup 設定

```bash
# /etc/keepalived/keepalived.conf（Backup）

global_defs {
    router_id NGINX_BACKUP
}

vrrp_script check_nginx {
    script "/etc/keepalived/check_nginx.sh"
    interval 2
    weight -20
    fall 3
    rise 2
}

vrrp_instance VI_1 {
    state BACKUP
    interface eth0
    virtual_router_id 51       # 與 Master 相同
    priority 90                # 比 Master 低
    advert_int 1

    authentication {
        auth_type PASS
        auth_pass mypassword
    }

    virtual_ipaddress {
        192.168.1.100/24       # 與 Master 相同的 VIP
    }

    track_script {
        check_nginx
    }

    notify_master "/etc/keepalived/notify.sh master"
    notify_backup "/etc/keepalived/notify.sh backup"
    notify_fault  "/etc/keepalived/notify.sh fault"
}
```

### Nginx 健康檢查腳本

```bash
#!/bin/bash
# /etc/keepalived/check_nginx.sh

# 檢查 Nginx 行程是否存在
if ! pidof nginx > /dev/null; then
    # 嘗試重啟 Nginx
    systemctl restart nginx
    sleep 2

    # 再次檢查
    if ! pidof nginx > /dev/null; then
        exit 1  # Nginx 無法啟動，觸發 failover
    fi
fi

# 檢查 Nginx 是否能正常回應
if ! curl -s -o /dev/null -w "%{http_code}" http://localhost/health | grep -q "200"; then
    exit 1
fi

exit 0
```

```bash
# 設定執行權限
sudo chmod +x /etc/keepalived/check_nginx.sh
```

### 通知腳本

```bash
#!/bin/bash
# /etc/keepalived/notify.sh

STATE=$1
DATETIME=$(date '+%Y-%m-%d %H:%M:%S')
VIP="192.168.1.100"

case $STATE in
    "master")
        echo "$DATETIME - Became MASTER, VIP: $VIP" >> /var/log/keepalived-state.log
        # 可以發送通知
        # curl -X POST https://hooks.slack.com/... -d "{\"text\": \"Nginx became MASTER\"}"
        ;;
    "backup")
        echo "$DATETIME - Became BACKUP" >> /var/log/keepalived-state.log
        ;;
    "fault")
        echo "$DATETIME - Entered FAULT state" >> /var/log/keepalived-state.log
        ;;
esac
```

```bash
sudo chmod +x /etc/keepalived/notify.sh
```

### 啟動 Keepalived

```bash
# 在 Master 和 Backup 上都執行
sudo systemctl start keepalived
sudo systemctl enable keepalived

# 驗證 VIP
ip addr show eth0
# 應該在 Master 上看到 192.168.1.100

# 測試 failover
# 在 Master 上停止 Nginx
sudo systemctl stop nginx
# 觀察 VIP 是否切換到 Backup
```

---

## 12.4 設定同步

多台 Nginx 的設定需要保持一致：

### 方法一：使用 rsync 同步

```bash
#!/bin/bash
# /opt/scripts/sync-nginx-config.sh

MASTER="10.0.1.10"
BACKUP="10.0.1.11"
CONFIG_DIR="/etc/nginx"

# 在 Master 上測試設定
nginx -t
if [ $? -ne 0 ]; then
    echo "Configuration test failed!"
    exit 1
fi

# 同步到 Backup
rsync -avz --delete \
    $CONFIG_DIR/ \
    deploy@$BACKUP:$CONFIG_DIR/

# 在 Backup 上測試並重載
ssh deploy@$BACKUP "nginx -t && nginx -s reload"

# 在 Master 上重載
nginx -s reload

echo "Configuration synced and reloaded!"
```

### 方法二：使用 Git + CI/CD

```yaml
# .gitlab-ci.yml 或 GitHub Actions
deploy_nginx:
  stage: deploy
  script:
    - ansible-playbook -i inventory deploy-nginx.yml
  only:
    - main
  when: manual
```

```yaml
# deploy-nginx.yml (Ansible)
---
- hosts: nginx_servers
  tasks:
    - name: Copy Nginx configuration
      copy:
        src: ./nginx/
        dest: /etc/nginx/
        owner: root
        group: root
        mode: '0644'

    - name: Test Nginx configuration
      command: nginx -t
      register: nginx_test

    - name: Reload Nginx
      service:
        name: nginx
        state: reloaded
      when: nginx_test.rc == 0
```

### 方法三：使用 Consul Template（動態設定）

```hcl
# nginx.conf.ctmpl
upstream backend {
    {{range service "web"}}
    server {{.Address}}:{{.Port}} max_fails=3 fail_timeout=30s;
    {{end}}
}
```

---

## 12.5 零停機部署策略

### 藍綠部署（Blue-Green Deployment）

```nginx
# 藍色環境（目前正在運行）
upstream blue {
    server 10.0.1.10:3000;
    server 10.0.1.11:3000;
}

# 綠色環境（新版本）
upstream green {
    server 10.0.2.10:3000;
    server 10.0.2.11:3000;
}

# 使用 map 切換
map $cookie_deploy_version $backend {
    "green" green;
    default blue;
}

server {
    location / {
        proxy_pass http://$backend;
    }
}
```

```bash
# 部署流程
# 1. 部署新版本到綠色環境
# 2. 測試綠色環境
curl -H "Cookie: deploy_version=green" https://myapp.com/health

# 3. 切換流量到綠色
# 修改 default 為 green
# map $cookie_deploy_version $backend {
#     "blue" blue;
#     default green;
# }

# 4. 重載 Nginx
sudo nginx -t && sudo nginx -s reload

# 5. 監控一段時間
# 6. 確認沒問題後，藍色環境可以用於下次部署
```

### 金絲雀部署（Canary Deployment）

```nginx
upstream stable {
    server 10.0.1.10:3000;
    server 10.0.1.11:3000;
}

upstream canary {
    server 10.0.2.10:3000;
}

# 5% 的流量到新版本
split_clients "${remote_addr}" $variant {
    5%   canary;
    *    stable;
}

server {
    location / {
        proxy_pass http://$variant;
        add_header X-Served-By $variant always;
    }
}
```

```bash
# 逐步增加金絲雀比例
# 5% → 10% → 25% → 50% → 100%
# 每個階段觀察錯誤率和回應時間
```

---

## 12.6 容災與備份

### Nginx 設定備份

```bash
#!/bin/bash
# /opt/scripts/backup-nginx.sh

BACKUP_DIR="/backup/nginx"
DATE=$(date +%Y%m%d_%H%M%S)

# 建立備份目錄
mkdir -p $BACKUP_DIR

# 備份設定檔
tar -czf $BACKUP_DIR/nginx_config_$DATE.tar.gz /etc/nginx/

# 備份 SSL 憑證
tar -czf $BACKUP_DIR/ssl_certs_$DATE.tar.gz /etc/letsencrypt/

# 保留最近 30 天的備份
find $BACKUP_DIR -name "*.tar.gz" -mtime +30 -delete

echo "Backup completed: $DATE"
```

```bash
# 設定每日自動備份
echo "0 3 * * * root /opt/scripts/backup-nginx.sh" | sudo tee /etc/cron.d/nginx-backup
```

### 快速還原

```bash
#!/bin/bash
# /opt/scripts/restore-nginx.sh

BACKUP_FILE=$1

if [ -z "$BACKUP_FILE" ]; then
    echo "Usage: $0 <backup_file>"
    echo "Available backups:"
    ls -la /backup/nginx/
    exit 1
fi

# 備份當前設定
cp -r /etc/nginx /etc/nginx.bak.$(date +%s)

# 還原
tar -xzf $BACKUP_FILE -C /

# 測試
nginx -t
if [ $? -eq 0 ]; then
    nginx -s reload
    echo "Restore completed successfully!"
else
    echo "Configuration test failed! Rolling back..."
    cp -r /etc/nginx.bak.* /etc/nginx
    nginx -s reload
fi
```

---

## 12.7 跨區域容災

### 使用 DNS 做跨區域切換

```
                     ┌─────────────────┐
                     │   DNS (Route53)  │
                     │   Health Check   │
                     └────┬────────┬───┘
                          │        │
              ┌───────────┘        └───────────┐
              │                                │
    ┌─────────┴─────────┐          ┌──────────┴─────────┐
    │  Region A (主要)    │          │  Region B (備援)    │
    │                     │          │                     │
    │  ┌──────────────┐  │          │  ┌──────────────┐  │
    │  │   Nginx LB   │  │          │  │   Nginx LB   │  │
    │  └──────┬───────┘  │          │  └──────┬───────┘  │
    │         │          │          │         │          │
    │  ┌──────┴───────┐  │          │  ┌──────┴───────┐  │
    │  │   Backends   │  │          │  │   Backends   │  │
    │  └──────────────┘  │          │  └──────────────┘  │
    └─────────────────────┘          └─────────────────────┘
```

```bash
# AWS Route53 健康檢查 + 故障轉移路由
# 主要區域掛掉時，DNS 自動切換到備援區域
# 這通常透過 AWS Console 或 Terraform 設定
```

---

## 12.8 監控與自動恢復

### 完整的健康檢查端點

```nginx
server {
    # 簡單的存活檢查
    location /health/live {
        access_log off;
        return 200 'alive';
        add_header Content-Type text/plain;
    }

    # 就緒檢查（包含後端狀態）
    location /health/ready {
        access_log off;
        proxy_pass http://backend/health;
        proxy_connect_timeout 3s;
        proxy_read_timeout 3s;
    }

    # 詳細狀態（需要認證）
    location /health/detail {
        auth_basic "Health Check";
        auth_basic_user_file /etc/nginx/.htpasswd;

        default_type application/json;
        return 200 '{
            "nginx": "running",
            "uptime": "$connections_active active connections",
            "version": "$nginx_version"
        }';
    }
}
```

### 自動重啟腳本

```bash
#!/bin/bash
# /opt/scripts/auto-recover.sh

MAX_RETRIES=3
RETRY_COUNT=0
HEALTH_URL="http://localhost/health/live"

while true; do
    # 檢查 Nginx 健康狀態
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" $HEALTH_URL)

    if [ "$HTTP_CODE" != "200" ]; then
        RETRY_COUNT=$((RETRY_COUNT + 1))
        echo "$(date) - Health check failed (attempt $RETRY_COUNT/$MAX_RETRIES)"

        if [ $RETRY_COUNT -ge $MAX_RETRIES ]; then
            echo "$(date) - Max retries reached, restarting Nginx..."
            systemctl restart nginx
            RETRY_COUNT=0

            # 發送通知
            curl -X POST "https://hooks.slack.com/services/xxx" \
                -H "Content-Type: application/json" \
                -d '{"text": "Nginx was auto-restarted due to health check failure"}'
        fi
    else
        RETRY_COUNT=0
    fi

    sleep 10
done
```

---

## 12.9 實際情境

### 情境一：主伺服器突然宕機

**處理流程**：

```
1. Keepalived 偵測到 Master 故障（2-6 秒內）
2. Backup 自動升級為 Master，接管 VIP
3. 客戶端無感知（因為 IP 沒變）
4. 告警通知發送給運維團隊
5. 運維團隊修復原 Master 伺服器
6. 原 Master 恢復後自動成為 Backup（或根據優先權恢復為 Master）
```

### 情境二：需要更新 Nginx 版本

```bash
# 在高可用環境下滾動更新

# 1. 先更新 Backup 伺服器
ssh admin@backup-server
sudo apt update && sudo apt upgrade nginx -y
sudo nginx -t && sudo systemctl restart nginx

# 2. 確認 Backup 正常運行
curl -I http://backup-server/health

# 3. 手動觸發 failover（讓 Backup 接管流量）
# 在 Master 上臨時降低優先權
sudo systemctl stop keepalived
# 此時 Backup 會接管 VIP

# 4. 更新原 Master
sudo apt update && sudo apt upgrade nginx -y
sudo nginx -t && sudo systemctl restart nginx

# 5. 恢復 Keepalived
sudo systemctl start keepalived
# 根據優先權設定，可能會自動恢復為 Master

# 全程服務不中斷
```

### 情境三：流量突然暴增需要緊急擴容

```bash
# 1. 快速部署新的 Nginx + Backend 節點
# 使用 Docker 或 VM 映像快速啟動

# 2. 將新節點加入 upstream
upstream backend {
    server 10.0.1.10:3000;
    server 10.0.1.11:3000;
    server 10.0.1.12:3000;    # 新增
    server 10.0.1.13:3000;    # 新增
}

# 3. 重載 Nginx
sudo nginx -t && sudo nginx -s reload

# 4. 監控新節點的狀態
tail -f /var/log/nginx/error.log | grep upstream
```

---

## 12.10 高可用架構設計檢查清單

```
基礎設施
□ Nginx 至少有兩台，使用 Keepalived 或雲端 LB
□ 後端伺服器至少有兩台
□ 資料庫有主從備援
□ 使用共享儲存或物件儲存（如 S3）
□ DNS 有備援設定

設定管理
□ Nginx 設定使用版本控制（Git）
□ 設定變更有自動化部署流程
□ 多台 Nginx 的設定保持一致
□ SSL 憑證有自動續約機制

監控與告警
□ Nginx 狀態監控（stub_status）
□ 後端服務健康檢查
□ 錯誤率告警（5xx > 閾值）
□ 回應時間告警（P95 > 閾值）
□ SSL 憑證到期告警
□ 磁碟空間告警

備份與還原
□ Nginx 設定定期備份
□ SSL 憑證備份
□ 有測試過的還原流程
□ 定期做災難復原演練

部署策略
□ 零停機部署流程
□ 快速回滾機制
□ 灰度/金絲雀部署能力
□ 維護模式切換機制
```

---

## 12.11 本章小結

- 高可用的核心是消除單點故障
- Keepalived + 虛擬 IP 是實現 Nginx 高可用的經典方案
- 雲端環境推薦使用雲端負載均衡器 + 多台 Nginx
- 設定同步可透過 rsync、Git + CI/CD 或 Ansible 實現
- 零停機部署可採用藍綠或金絲雀策略
- 定期做備份與災難復原演練
- 完善的監控與告警是高可用的保障

---

> 上一章：[實際情境與解決方案](./11-real-world-scenarios.md) | 回到目錄：[README](./README.md)

---

恭喜你完成了整個 Nginx 教學課程！你現在已經具備了從安裝部署到高可用架構設計的完整知識。持續實踐和探索，你會成為一位優秀的 Nginx 工程師。
