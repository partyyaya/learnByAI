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

> 什麼是虛擬 IP（VIP, Virtual IP）？
>
> - VIP 是一個「不固定綁在某台機器」的 IP 位址，由 Keepalived 透過 VRRP 協定動態決定目前由哪台機器持有。
> - 客戶端（或 DNS）永遠指向 VIP（例如 `192.168.1.100`），不需要知道背後實際是哪台 Nginx 在服務。
> - 正常時 VIP 掛在 Master 的網卡上；Master 故障時，Backup 在數秒內把 VIP「搶」到自己的網卡上，並發送 GARP（Gratuitous ARP）通知交換器更新 MAC 對應，流量隨即導向 Backup。
> - 因為對外 IP 沒變，客戶端完全無感知——這就是「雙機熱備」的核心原理。
>
> 什麼是 VRRP（Virtual Router Redundancy Protocol）？
>
> - Keepalived 實作的標準協定（RFC 5798），Master 會定期（預設每 1 秒）對外發送「我還活著」的通告（advertisement）。
> - Backup 若連續一段時間（約 3 × 通告間隔）收不到通告，就判定 Master 故障，依「優先權（priority）」高低選出新的 Master。
> - 注意：VRRP 預設走多播位址 `224.0.0.18`，若你的網路環境（特別是雲端 VPC）封鎖多播，需改用 unicast 模式（見後文實務建議）。

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

> DNS 輪詢（Round Robin）怎麼運作？有什麼限制？
>
> - 做法：在 DNS 上為同一個域名設定多筆 A 記錄（例如 `myapp.com → 203.0.113.10` 與 `203.0.113.20`），DNS 伺服器輪流回應不同 IP，讓流量大致平均分散到多台 Nginx。
> - 優點：實作極簡單，不需要額外軟硬體，天然支援跨機房。
> - 限制一（**沒有健康檢查**）：傳統 DNS 不知道某台 Nginx 掛了，仍會把該 IP 回給客戶端，造成部分使用者連線失敗。需搭配支援健康檢查的 DNS 服務（如 AWS Route53、Cloudflare）才能自動剔除故障節點。
> - 限制二（**快取延遲**）：客戶端與中繼 DNS 會快取解析結果，快取時間由 TTL 決定。即使 DNS 已剔除故障 IP，已快取的客戶端仍會連到舊 IP，直到 TTL 過期。
> - 實務建議：用於容災切換的 DNS 記錄，TTL 建議設 30～60 秒（太長切換慢、太短增加 DNS 查詢量）；一般靜態記錄常用 300～3600 秒。

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
# Ubuntu / Debian：用 apt 安裝；-y 代表自動回答 yes，不互動確認
sudo apt install keepalived -y

# CentOS / RHEL：用 yum 安裝（較新版本可改用 dnf）
sudo yum install keepalived -y

# 安裝後確認版本（建議 2.x 以上）
keepalived --version
```

> 安裝注意事項：
>
> - Keepalived 要安裝在「兩台 Nginx 主機」上（Master 與 Backup 各一份），不是裝在第三台機器。
> - 設定檔預設路徑為 `/etc/keepalived/keepalived.conf`，套件安裝後可能附帶範例設定，建議先備份再覆寫。
> - 兩台主機需在同一個二層網段（VIP 才能漂移）；若在雲端 VPC，請改用各雲商的浮動 IP / 彈性 IP 方案或 unicast 模式。

### Master 設定

```bash
# /etc/keepalived/keepalived.conf（Master）

global_defs {
    router_id NGINX_MASTER      # 本節點的識別名稱（每台機器唯一，常用主機名；僅用於日誌與識別）
}

# Nginx 健康檢查腳本（vrrp_script 區塊：定義「怎麼檢查」，要搭配下方 track_script 才會生效）
vrrp_script check_nginx {
    script "/etc/keepalived/check_nginx.sh"  # 要執行的檢查腳本；exit 0 = 健康，非 0 = 失敗
    interval 2      # 每 2 秒檢查一次（單位：秒；預設 1，太密集會增加負載，太鬆會拉長故障偵測時間）
    weight -20      # 檢查失敗時把本節點優先權扣 20（100 → 80，低於 Backup 的 90，VIP 因此切換）
    fall 3          # 連續失敗 3 次才判定為失敗（避免單次抖動造成誤切換）
    rise 2          # 連續成功 2 次才判定為恢復（避免服務還不穩就急著切回來）
}

vrrp_instance VI_1 {            # 一個 VRRP 實例 = 一組 VIP 的容錯單位；名稱 VI_1 兩台要一致
    state MASTER                # 初始角色：MASTER（啟動時先宣告自己是主）；實際角色仍由 priority 競選決定
    interface eth0              # VRRP 通告與 VIP 綁定的網路介面（用 ip addr 確認實際介面名，可能是 ens33、eth1 等）
    virtual_router_id 51        # 虛擬路由器 ID（0~255）；同一組的 Master 和 Backup 必須相同，同網段不同組必須不同
    priority 100                # 優先權（1~254，數字越大越優先）；Master 要設得比 Backup 高
    advert_int 1                # VRRP 通告間隔（秒，預設 1）；Backup 約 3 倍時間收不到通告就接管，值越小切換越快但流量越多

    authentication {            # VRRP 通告的認證設定，防止網段內其他主機偽造通告搶走 VIP
        auth_type PASS          # 認證方式：PASS = 簡單明文密碼（另一種 AH 已少用）
        auth_pass mypassword    # 認證密碼，Master/Backup 要一致（注意：只有前 8 個字元有效）
    }

    virtual_ipaddress {
        192.168.1.100/24        # 虛擬 IP（VIP）+ 子網遮罩；目前的 Master 會把它掛到 interface 指定的網卡上
    }

    track_script {
        check_nginx             # 引用上面定義的 vrrp_script；沒寫這段，健康檢查不會被執行！
    }

    # 狀態變更時的通知腳本（參數 master/backup/fault 會傳入腳本，見後文 notify.sh）
    notify_master "/etc/keepalived/notify.sh master"   # 升級為 MASTER（拿到 VIP）時執行
    notify_backup "/etc/keepalived/notify.sh backup"   # 降級為 BACKUP（讓出 VIP）時執行
    notify_fault  "/etc/keepalived/notify.sh fault"    # 進入 FAULT（如網卡斷線）時執行
}
```

### 這段設定在做什麼？（逐條）

- `global_defs { router_id ... }`
  - 全域設定區塊。`router_id` 只是本節點的「名牌」，會出現在 syslog 日誌中方便辨認是哪台機器，**不影響選主邏輯**（選主看的是 `priority`）。
- `vrrp_script check_nginx { ... }`
  - 定義一個名為 `check_nginx` 的健康檢查。Keepalived 每 `interval` 秒執行一次 `script`，依結束碼判斷成敗。
  - `weight -20` 是切換的關鍵機制：**檢查失敗時不是直接放棄 VIP，而是把自己的優先權扣 20**。Master 從 100 降為 80，低於 Backup 的 90，Backup 就會在下一輪通告比較中勝出並接管 VIP。
  - 若 `weight` 設為 0（或不設），行為改變：腳本失敗會讓該實例直接進入 FAULT 狀態、立刻放棄 VIP。兩種做法都可行，但用 weight 的好處是「多個檢查可以累加扣分」，調度更細緻。
  - `fall 3` × `interval 2` = 最長約 6 秒才確認故障；加上 VRRP 通告逾時，整體切換時間約在 2～10 秒內。想更快可縮小 `interval` 與 `fall`，但誤判風險上升。
- `state MASTER` + `priority 100`
  - `state` 只是「啟動瞬間的初始宣告」，真正的主備由 `priority` 決定：兩台同時在線時，priority 高者當 Master。
  - 因此慣例是：Master 設 `state MASTER` + `priority 100`，Backup 設 `state BACKUP` + `priority 90`，兩者差距要大於健康檢查的 `weight` 絕對值才能正確觸發切換（100 − 20 = 80 < 90 ✓）。**若差距設太大（例如 Backup 只有 70），扣完分還是 Master 比較高，VIP 永遠不會切換——這是最常見的設定錯誤。**
- `virtual_router_id 51`
  - 同一組 HA 配對的「群組編號」。兩台必須相同才會互相比較；若同一個網段還有別組 Keepalived，編號必須錯開，否則會互相干擾、出現腦裂或 VIP 亂跳。
- `advert_int 1`
  - Master 每 1 秒發一次「心跳」。Backup 連續約 3 個間隔（約 3 秒）收不到，就認定 Master 死亡。一般保持預設 1 秒即可。
- `virtual_ipaddress { 192.168.1.100/24 }`
  - 這裡可以列多個 VIP（一行一個）。`/24` 要與該網段實際遮罩一致；VIP 必須是該網段中**未被任何實體機器使用**的位址。

> 關於「搶占（Preemption）」：
>
> - Keepalived 預設是**搶占模式**：原 Master 修復、優先權恢復為 100 後，會自動把 VIP 搶回來，期間會再發生一次切換。
> - 若不希望服務反覆切換（每次切換都有數秒風險），可在 `vrrp_instance` 內加上 `nopreempt`（注意：使用 `nopreempt` 時兩台的 `state` 都要寫 `BACKUP`，純靠 priority 競選），讓修復後的節點安分地當備機，等下次故障才接手。
> - 也可用 `preempt_delay 60`（單位：秒）延遲搶占，給原 Master 一段「暖機觀察期」。
>
> 實務建議：
>
> - 雲端 VPC 通常封鎖 VRRP 多播，需改用 unicast：在 `vrrp_instance` 內加 `unicast_src_ip <本機IP>` 與 `unicast_peer { <對方IP> }`。
> - 修改設定後用 `sudo systemctl reload keepalived` 套用，並以 `journalctl -u keepalived -f` 觀察狀態轉換日誌。

### Backup 設定

```bash
# /etc/keepalived/keepalived.conf（Backup）

global_defs {
    router_id NGINX_BACKUP     # 識別名稱改為 BACKUP（每台唯一，方便看日誌時分辨）
}

# 健康檢查設定與 Master 完全相同（Backup 升級為 Master 後也需要監控自己的 Nginx）
vrrp_script check_nginx {
    script "/etc/keepalived/check_nginx.sh"
    interval 2                 # 每 2 秒檢查一次
    weight -20                 # 失敗時優先權 90 → 70
    fall 3                     # 連續失敗 3 次才算失敗
    rise 2                     # 連續成功 2 次才算恢復
}

vrrp_instance VI_1 {           # 實例名稱與 Master 相同
    state BACKUP               # 初始角色：BACKUP（啟動時先當備機，等著收 Master 的通告）
    interface eth0             # 依本機實際網卡名稱調整
    virtual_router_id 51       # 與 Master 相同（同一組才會互相通訊）
    priority 90                # 比 Master 低（差距 10 < weight 的 20，Master 故障扣分後才會被超越）
    advert_int 1               # 與 Master 一致

    authentication {
        auth_type PASS
        auth_pass mypassword   # 必須與 Master 完全一致，否則通告會被丟棄、兩台各自稱王（腦裂）
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

> Master 與 Backup 設定只差三個地方：
>
> | 項目 | Master | Backup | 說明 |
> |------|--------|--------|------|
> | `router_id` | `NGINX_MASTER` | `NGINX_BACKUP` | 各自唯一的識別名 |
> | `state` | `MASTER` | `BACKUP` | 啟動時的初始角色 |
> | `priority` | `100` | `90` | 決定誰是主；其餘欄位（`virtual_router_id`、`auth_pass`、VIP）**必須完全相同** |
>
> 常見錯誤：兩邊 `auth_pass` 不一致或 `virtual_router_id` 不同，會導致彼此「聽不懂」對方的通告，兩台同時持有 VIP（腦裂，split-brain），表現為網路時通時斷。可用 `ip addr show eth0` 在兩台同時檢查，VIP 應該**只出現在其中一台**。

### Nginx 健康檢查腳本

```bash
#!/bin/bash
# /etc/keepalived/check_nginx.sh
# Keepalived 每 2 秒執行一次本腳本：exit 0 = 健康；exit 非 0 = 失敗（觸發扣分 → failover）

# 第一關：檢查 Nginx 行程是否存在
# pidof nginx：找出 nginx 行程的 PID，找到回傳 0、找不到回傳非 0
# > /dev/null：丟棄輸出（我們只關心結束碼，不需要印出 PID）
# 前面的 !：把判斷反過來——「找不到行程」才進入 if
if ! pidof nginx > /dev/null; then
    # 嘗試自我修復：先重啟 Nginx 而不是直接放棄 VIP（很多故障重啟一次就好了）
    systemctl restart nginx
    sleep 2     # 等 2 秒讓 Nginx 完成啟動（太短可能還沒 listen，造成誤判）

    # 再次檢查：重啟後仍然沒有行程，代表真的起不來（如設定錯誤、port 被占用）
    if ! pidof nginx > /dev/null; then
        exit 1  # 回傳失敗 → Keepalived 扣優先權 → VIP 切換到 Backup
    fi
fi

# 第二關：行程在不代表服務正常，再用 HTTP 請求確認能回應
# curl 參數逐一說明：
#   -s             安靜模式，不顯示進度列與錯誤訊息
#   -o /dev/null   把回應內容丟棄（不需要 body）
#   -w "%{http_code}"  請求完成後只輸出 HTTP 狀態碼（例如 200、502）
# grep -q "200"：檢查輸出是否包含 200；-q = 安靜模式，只回傳成功/失敗結束碼
if ! curl -s -o /dev/null -w "%{http_code}" http://localhost/health | grep -q "200"; then
    exit 1      # 行程在但無法正常回應（如 worker 卡死、upstream 全掛），同樣觸發 failover
fi

exit 0          # 兩關都通過，回報健康
```

```bash
# 賦予執行權限（沒有 +x，Keepalived 執行腳本會失敗，健康檢查永遠不通過）
sudo chmod +x /etc/keepalived/check_nginx.sh

# 建議先手動跑一次，確認結束碼正確（0 = 健康）
sudo /etc/keepalived/check_nginx.sh; echo "exit code: $?"
```

> 這支腳本的設計重點：
>
> - **兩層檢查**：「行程存在」（第一關）+「HTTP 能回應」（第二關）。只檢查行程是不夠的——Nginx 行程可能還在，但已經無法服務（例如 worker 全部卡死）。
> - **先自救再求援**：行程消失時先 `systemctl restart nginx` 試著拉起來，失敗才回報故障。這能避免「Nginx 被 OOM 殺掉一次」就觸發整組 VIP 切換。
> - `http://localhost/health` 需要你在 Nginx 設定一個健康檢查端點（見 12.8 節的 `/health/live`）；若還沒設定，可先改成 `http://localhost/`。
> - 建議再加上逾時保護：`curl --max-time 2 ...`，避免 Nginx 半死不活時 curl 卡住，拖慢 Keepalived 的檢查週期。
> - 注意腳本內的結束碼語意和 Nginx 無關：這是 Keepalived 的約定——`vrrp_script` 以「腳本結束碼是否為 0」判斷成敗。

### 通知腳本

```bash
#!/bin/bash
# /etc/keepalived/notify.sh
# 由 keepalived.conf 的 notify_master / notify_backup / notify_fault 在「狀態變更時」呼叫
# 呼叫方式例如：/etc/keepalived/notify.sh master ← "master" 就是第一個參數

STATE=$1                                  # $1 = 腳本的第一個參數（master / backup / fault）
DATETIME=$(date '+%Y-%m-%d %H:%M:%S')     # 取得目前時間字串，例如 2026-06-10 14:30:05
VIP="192.168.1.100"                       # 記錄用的 VIP（與 keepalived.conf 中的 VIP 保持一致）

case $STATE in                            # 依參數值分支處理（bash 的 switch-case 寫法）
    "master")
        # 本機升級為 MASTER（剛接管 VIP）——這是最需要告警的事件，代表發生了切換
        echo "$DATETIME - Became MASTER, VIP: $VIP" >> /var/log/keepalived-state.log   # >> 表示附加寫入，不覆蓋舊紀錄
        # 可以發送通知（取消註解並換成自己的 Slack/Teams Webhook）
        # curl -X POST https://hooks.slack.com/... -d "{\"text\": \"Nginx became MASTER\"}"
        ;;                                # 每個分支以 ;; 結束
    "backup")
        # 本機降級為 BACKUP（讓出 VIP）——通常與另一台的 master 事件成對出現
        echo "$DATETIME - Became BACKUP" >> /var/log/keepalived-state.log
        ;;
    "fault")
        # 本機進入 FAULT 狀態（如監控的網卡 down、track 對象異常），暫時退出 VRRP 競選
        echo "$DATETIME - Entered FAULT state" >> /var/log/keepalived-state.log
        ;;
esac
```

```bash
# 同樣要賦予執行權限，否則狀態變更時不會有任何紀錄與通知
sudo chmod +x /etc/keepalived/notify.sh
```

> 實務建議：
>
> - 狀態切換是高可用架構中**最重要的告警事件**——切換成功不代表沒事，通常代表原 Master 出了問題，務必在 `master` 分支接上告警通知（Slack、簡訊、PagerDuty）。
> - 日誌寫到 `/var/log/keepalived-state.log` 方便事後回溯「何時切換、切了幾次」；若短時間內反覆切換（flapping），代表健康檢查條件太敏感或網路不穩。

### 啟動 Keepalived

```bash
# 在 Master 和 Backup 上都執行
sudo systemctl start keepalived    # 立即啟動 Keepalived 服務
sudo systemctl enable keepalived   # 設為開機自動啟動（重開機後 HA 才不會失效）

# 確認服務狀態與日誌（active (running) 才正常）
sudo systemctl status keepalived
sudo journalctl -u keepalived -f   # 即時追蹤日誌，可看到 Entering MASTER STATE 等狀態訊息

# 驗證 VIP：列出 eth0 介面上綁定的所有 IP
ip addr show eth0
# 應該「只在 Master 上」看到 192.168.1.100；Backup 上不應出現
# 若兩台都看到 VIP → 腦裂，檢查 virtual_router_id / auth_pass / 防火牆是否擋掉 VRRP（協定號 112）

# 從第三台機器測試 VIP 是否可連
curl -I http://192.168.1.100/      # -I 只取回應標頭，確認 VIP 上的 Nginx 有回應

# 測試 failover
# 在 Master 上停止 Nginx（模擬服務故障）
sudo systemctl stop nginx
# 預期流程：健康檢查連續失敗 3 次（約 6 秒）→ Master 優先權 100-20=80 → Backup（90）接管 VIP
# 在 Backup 上執行 ip addr show eth0，應可看到 192.168.1.100 已漂移過來
# 同時觀察兩台的 /var/log/keepalived-state.log，應有成對的 BACKUP / MASTER 紀錄

# 測試完記得把 Master 的 Nginx 拉起來
sudo systemctl start nginx
# 預設搶占模式下，Master 恢復健康後會自動把 VIP 搶回去
```

> 上線前建議完整演練三種故障情境：
>
> 1. **服務故障**：`systemctl stop nginx`（如上）——驗證健康檢查與 weight 扣分機制。
> 2. **主機故障**：直接重開機或關機 Master——驗證 VRRP 通告逾時接管（約 3 秒）。
> 3. **網路故障**：拔線或 `ip link set eth0 down`——驗證 FAULT 狀態與 notify_fault 通知。
>
> 每種情境都確認：VIP 是否正確漂移、客戶端請求是否持續成功（可在第三台跑 `while true; do curl -s -o /dev/null -w "%{http_code}\n" http://192.168.1.100/; sleep 1; done` 持續觀察）、告警是否送達。

---

## 12.4 設定同步

多台 Nginx 的設定需要保持一致：

### 方法一：使用 rsync 同步

```bash
#!/bin/bash
# /opt/scripts/sync-nginx-config.sh
# 在 Master 上執行：把本機的 Nginx 設定同步到 Backup，兩邊都驗證後再重載

MASTER="10.0.1.10"        # Master 的內網 IP（此腳本就在這台上跑）
BACKUP="10.0.1.11"        # Backup 的內網 IP（同步目標）
CONFIG_DIR="/etc/nginx"   # 要同步的設定目錄

# 第一步：在 Master 上先測試設定語法——錯的設定絕不能往外散播
nginx -t
if [ $? -ne 0 ]; then     # $? = 上一個指令的結束碼；-ne 0 代表「不等於 0」（即測試失敗）
    echo "Configuration test failed!"
    exit 1                # 立刻中止，不做任何同步
fi

# 第二步：用 rsync 把整個設定目錄同步到 Backup
# 參數說明：
#   -a  歸檔模式：遞迴複製並保留權限、時間戳、符號連結等屬性
#   -v  顯示同步了哪些檔案（verbose）
#   -z  傳輸時壓縮，節省頻寬
#   --delete  刪除 Backup 上「Master 已不存在」的檔案，確保兩邊完全一致（小心使用！）
# 路徑尾端的 / 很重要：$CONFIG_DIR/ 代表「同步目錄的內容」而非目錄本身
rsync -avz --delete \
    $CONFIG_DIR/ \
    deploy@$BACKUP:$CONFIG_DIR/   # 以 deploy 使用者透過 SSH 寫入 Backup 的 /etc/nginx/

# 第三步：先在 Backup 上測試並重載（&& 表示前一個成功才執行下一個）
# 順序刻意「先 Backup 後 Master」：萬一新設定有問題，至少 Master 還在跑舊設定
ssh deploy@$BACKUP "nginx -t && nginx -s reload"

# 第四步：Backup 沒問題後，Master 才重載
nginx -s reload

echo "Configuration synced and reloaded!"
```

> 這支腳本的關鍵設計（逐條）：
>
> - **測試 → 同步 → 先重載備機 → 再重載主機**：任何一步失敗都不影響線上的 Master，把風險控制在備機。
> - `--delete` 是雙面刃：能保證兩邊完全一致，但若 Backup 上有本機特有檔案（例如不同的憑證路徑）會被刪掉。確定兩台設定完全相同才使用，否則拿掉此參數。
> - 前置需求：Master 對 Backup 要設定 SSH 金鑰免密碼登入（`ssh-keygen` + `ssh-copy-id deploy@10.0.1.11`），且 `deploy` 使用者需有寫入 `/etc/nginx` 與執行 `nginx -s reload` 的權限（一般透過 sudoers 限定指令授權）。
> - 常見錯誤：忘了同步後在 Backup 上 `nginx -t`，等到故障切換時才發現備機設定是壞的——備機的設定驗證和主機一樣重要。

### 方法二：使用 Git + CI/CD

```yaml
# .gitlab-ci.yml 或 GitHub Actions
deploy_nginx:
  stage: deploy                                    # 此任務屬於 deploy 階段（在 build/test 之後執行）
  script:
    - ansible-playbook -i inventory deploy-nginx.yml   # 用 Ansible 把設定推送到 inventory 清單中的所有 Nginx 主機
  only:
    - main                                         # 只有 main 分支的變更才會觸發部署（避免開發分支誤上線）
  when: manual                                     # 需要有人在 CI 介面按下按鈕才執行（人工把關，而非合併即部署）
```

```yaml
# deploy-nginx.yml (Ansible)
---
- hosts: nginx_servers          # 目標主機群組（在 inventory 檔中定義，含所有 Nginx 節點）
  tasks:
    - name: Copy Nginx configuration
      copy:                     # 把 Git 倉庫中的設定目錄複製到每台主機
        src: ./nginx/           # 來源：倉庫內的 nginx/ 目錄（設定的唯一真相來源）
        dest: /etc/nginx/       # 目的地：主機上的 Nginx 設定目錄
        owner: root             # 檔案擁有者
        group: root             # 檔案群組
        mode: '0644'            # 權限：擁有者可讀寫，其他人唯讀

    - name: Test Nginx configuration
      command: nginx -t         # 每台主機都先做語法測試
      register: nginx_test      # 把執行結果（含結束碼）存到變數 nginx_test，供後續任務判斷

    - name: Reload Nginx
      service:
        name: nginx
        state: reloaded         # 用 reload 而非 restart：不中斷既有連線
      when: nginx_test.rc == 0  # 條件執行：rc（return code）為 0（測試通過）才重載
```

> 為什麼 Git + CI/CD 比 rsync 腳本更好？
>
> - **可追溯**：每次設定變更都有 commit 紀錄（誰改的、改了什麼、為什麼改），出問題可以 `git revert` 一鍵回滾。
> - **可審查**：透過 Merge Request / Pull Request 讓第二雙眼睛把關，再加上 `when: manual` 的人工確認，雙重防呆。
> - **可擴展**：未來從 2 台擴到 10 台 Nginx，只要在 inventory 加主機，部署流程完全不變。
> - Ansible 會對每台主機依序執行任務，且 `copy` 模組是冪等的（內容沒變就不動作），重複執行也安全。

### 方法三：使用 Consul Template（動態設定）

```hcl
# nginx.conf.ctmpl ← 這是「模板檔」，由 consul-template 程式渲染成真正的 nginx 設定
upstream backend {
    {{range service "web"}}    # 迴圈：列舉 Consul 服務目錄中所有名為 "web" 且健康的實例
    server {{.Address}}:{{.Port}} max_fails=3 fail_timeout=30s;   # 每個實例渲染成一行 server 指令
    {{end}}                    # 迴圈結束
}
```

> 這段模板怎麼運作？（逐條）
>
> - Consul 是服務註冊中心：每個後端服務啟動時向 Consul 註冊自己的 IP 與 port，並附帶健康檢查。
> - `{{range service "web"}}...{{end}}`：Go template 語法的迴圈，對「目前健康的每一個 web 服務實例」各產生一段內容。
> - `{{.Address}}`、`{{.Port}}`：迴圈中目前實例的 IP 與 port，例如渲染結果可能是：
>
> ```nginx
> upstream backend {
>     server 10.0.1.10:3000 max_fails=3 fail_timeout=30s;
>     server 10.0.1.11:3000 max_fails=3 fail_timeout=30s;
> }
> ```
>
> - `max_fails=3 fail_timeout=30s`：Nginx 的被動健康檢查——30 秒內失敗 3 次就暫時剔除該節點 30 秒（複習見負載均衡章節）。
> - 渲染與重載由 consul-template 常駐程式自動完成，常見啟動方式：
>
> ```bash
> # 監看 Consul 變化 → 重新渲染設定 → 測試通過才重載 Nginx
> consul-template \
>   -template "/etc/nginx/nginx.conf.ctmpl:/etc/nginx/conf.d/upstream.conf:nginx -t && nginx -s reload"
> #            └── 模板路徑 ──────────┘ └── 輸出路徑 ─────────────────┘ └── 渲染後執行的指令 ──────┘
> ```
>
> - 效益：後端擴容/縮容/故障時，**不需要人工改設定**，Nginx 的 upstream 清單自動跟著服務註冊狀態更新——適合容器化、頻繁伸縮的環境。

---

## 12.5 零停機部署策略

### 藍綠部署（Blue-Green Deployment）

```nginx
# 藍色環境（目前正在運行的穩定版本）
upstream blue {
    server 10.0.1.10:3000;     # 藍色環境的後端節點 1
    server 10.0.1.11:3000;     # 藍色環境的後端節點 2
}

# 綠色環境（部署了新版本，尚未承接正式流量）
upstream green {
    server 10.0.2.10:3000;     # 綠色環境的後端節點 1
    server 10.0.2.11:3000;     # 綠色環境的後端節點 2
}

# 使用 map 切換：依 Cookie 值決定 $backend 變數的內容
map $cookie_deploy_version $backend {
    "green" green;             # Cookie deploy_version=green 的請求 → 走 green upstream
    default blue;              # 其他所有請求（含沒帶 Cookie 的一般使用者）→ 走 blue
}

server {
    location / {
        proxy_pass http://$backend;   # 用變數指定 upstream 名稱，實際轉發目標由 map 動態決定
    }
}
```

### 這段設定在做什麼？（逐條）

- `map $cookie_deploy_version $backend { ... }`
  - `map` 的語法是「`map 來源變數 目標變數 { 對應表 }`」：根據來源變數的值，產生一個新變數。
  - `$cookie_deploy_version` 是 Nginx 內建變數家族 `$cookie_名稱` 的應用：自動取出請求中名為 `deploy_version` 的 Cookie 值。例如請求標頭帶 `Cookie: deploy_version=green`，則 `$cookie_deploy_version` 的值就是 `green`；沒帶這個 Cookie 時值為空字串。
  - 對應結果存入 `$backend`：值為 `"green"` 時 `$backend = green`，其餘一律 `$backend = blue`（`default` 行）。
  - `map` 只能寫在 `http {}` 層級（不能放在 `server` 或 `location` 內）。
- `proxy_pass http://$backend;`
  - `proxy_pass` 搭配變數時，Nginx 會在執行期解析變數值；因為 `blue`、`green` 都是已定義的 upstream 名稱，會直接命中 upstream，不需要額外設定 `resolver`。
  - 若變數值是「外部域名」而非 upstream 名稱，才需要 `resolver` 指令協助 DNS 解析——這是使用變數版 `proxy_pass` 的常見陷阱。
- 整體效果：一般使用者全部走藍色（穩定版）；測試人員只要在瀏覽器種一個 `deploy_version=green` 的 Cookie，就能用**正式網址**驗證綠色（新版本），互不干擾。

```bash
# 部署流程
# 1. 部署新版本到綠色環境（此時綠色沒有任何正式流量，部署失敗也不影響線上）
# 2. 測試綠色環境
#    -H "Cookie: deploy_version=green"：手動在請求中加上 Cookie 標頭，
#    模擬測試人員身分，讓 map 把這個請求導向 green upstream
curl -H "Cookie: deploy_version=green" https://myapp.com/health

# 3. 切換流量到綠色
# 修改 map 區塊：把 default 改指向 green（並保留用 Cookie 回訪 blue 的後門，方便快速回滾驗證）
# map $cookie_deploy_version $backend {
#     "blue" blue;          # 切換後：帶 deploy_version=blue 的請求才走舊版
#     default green;        # 一般使用者全部改走新版
# }

# 4. 重載 Nginx（先測試語法，通過才重載；reload 不中斷既有連線，使用者無感）
sudo nginx -t && sudo nginx -s reload

# 5. 監控一段時間（觀察 5xx 錯誤率、回應時間，建議至少觀察一個尖峰時段）
# 6. 確認沒問題後，藍色環境可以用於下次部署
#    若發現問題：把 map 的 default 改回 blue 再 reload，即可秒級回滾——這就是藍綠部署最大的優勢
```

### 金絲雀部署（Canary Deployment）

```nginx
upstream stable {
    server 10.0.1.10:3000;     # 穩定版節點
    server 10.0.1.11:3000;
}

upstream canary {
    server 10.0.2.10:3000;     # 新版本節點（金絲雀，先用少量流量試水溫）
}

# 5% 的流量到新版本
split_clients "${remote_addr}" $variant {   # 以客戶端 IP 為依據分流，結果存入 $variant
    5%   canary;               # 雜湊值落在前 5% 區間 → $variant = canary
    *    stable;               # 其餘 95%（* 代表剩下的全部）→ $variant = stable
}

server {
    location / {
        proxy_pass http://$variant;              # 依分流結果轉發到 canary 或 stable upstream
        add_header X-Served-By $variant always;  # 回應標頭標示走了哪個版本；always = 4xx/5xx 也要加
    }
}
```

### 這段設定在做什麼？（逐條）

- `split_clients "${remote_addr}" $variant { ... }`
  - 運作原理：把來源字串（這裡是客戶端 IP `$remote_addr`，例如 `203.0.113.10`）做 MurmurHash2 雜湊，依雜湊值落在哪個百分比區間，決定 `$variant` 的值。
  - **同一個 IP 永遠落在同一個區間**——這就是用 `${remote_addr}` 當 key 的目的：同一位使用者的請求不會在新舊版本之間跳來跳去（黏性分流），避免新舊版本資料格式不一致造成的錯亂。
  - 百分比總和不需要是 100%，`*` 接住所有剩餘流量；只能寫在 `http {}` 層級。
  - 換不同 key 有不同效果：用 `"${remote_addr}${http_user_agent}"` 可細分到「同 IP 不同裝置」；用 `$request_id` 則變成每個請求隨機分流（無黏性，較少用於金絲雀）。
- `add_header X-Served-By $variant always;`
  - 在回應標頭附上實際服務的版本（值為 `canary` 或 `stable`），方便用 `curl -I https://myapp.com/ | grep X-Served-By` 驗證分流比例與排查問題。
  - `always` 參數：預設 `add_header` 只在 2xx/3xx 回應時加標頭；加上 `always` 才能在 4xx/5xx 也看到——排查「金絲雀版本出錯」時特別重要，不加的話錯誤回應反而看不出是誰服務的。

```bash
# 逐步增加金絲雀比例
# 5% → 10% → 25% → 50% → 100%
# 做法：修改 split_clients 中的百分比（例如 5% 改 25%），然後：
sudo nginx -t && sudo nginx -s reload
# 每個階段觀察錯誤率和回應時間（例如 5xx 比例、P95 延遲），
# 任一指標惡化就把比例改回 0%（或刪除 canary 行）回滾
# 注意：調整百分比會改變雜湊區間邊界，部分使用者的分組可能改變，屬正常現象
```

---

## 12.6 容災與備份

### Nginx 設定備份

```bash
#!/bin/bash
# /opt/scripts/backup-nginx.sh

BACKUP_DIR="/backup/nginx"          # 備份檔存放目錄
DATE=$(date +%Y%m%d_%H%M%S)         # 時間戳字串，例如 20260610_030000，當作備份檔名的一部分

# 建立備份目錄（-p：目錄已存在不報錯，父層目錄不存在會一併建立）
mkdir -p $BACKUP_DIR

# 備份設定檔
# tar 參數：-c 建立壓縮檔、-z 用 gzip 壓縮、-f 指定輸出檔名
# 結果範例：/backup/nginx/nginx_config_20260610_030000.tar.gz
tar -czf $BACKUP_DIR/nginx_config_$DATE.tar.gz /etc/nginx/

# 備份 SSL 憑證（Let's Encrypt 的憑證、私鑰與續約設定都在 /etc/letsencrypt/）
tar -czf $BACKUP_DIR/ssl_certs_$DATE.tar.gz /etc/letsencrypt/

# 保留最近 30 天的備份
# find 參數：-name "*.tar.gz" 只找壓縮檔、-mtime +30 修改時間超過 30 天、-delete 直接刪除
find $BACKUP_DIR -name "*.tar.gz" -mtime +30 -delete

echo "Backup completed: $DATE"
```

```bash
# 設定每日自動備份：寫一個 cron 排程檔到 /etc/cron.d/（系統級排程，需指定執行身分）
echo "0 3 * * * root /opt/scripts/backup-nginx.sh" | sudo tee /etc/cron.d/nginx-backup

# cron 時間格式解讀：「0 3 * * *」＝ 每天凌晨 3:00 執行
#  ┌─ 分（0）
#  │ ┌─ 時（3）
#  │ │ ┌─ 日（* = 每天）
#  │ │ │ ┌─ 月（* = 每月）
#  │ │ │ │ ┌─ 星期（* = 每週每天）
#  0 3 * * *  root  /opt/scripts/backup-nginx.sh
#             └ /etc/cron.d/ 下的排程多一個「執行身分」欄位（這裡用 root，才有權限讀憑證目錄）

# 別忘了賦予腳本執行權限
sudo chmod +x /opt/scripts/backup-nginx.sh
```

> 實務建議：
>
> - **備份不要只放本機**：主機整台壞掉時，放在本機的備份一起陪葬。建議再同步一份到異地（如 `rsync` 到備份主機、或上傳 S3 等物件儲存）。
> - 憑證備份檔內含**私鑰**，務必限制權限（`chmod 600`）且不要放進 Git 倉庫。
> - 選凌晨 3 點是避開流量尖峰；備份本身吃 I/O，繁忙時段執行可能影響服務。
> - 驗證方式：手動執行一次腳本，然後 `ls -lh /backup/nginx/` 確認檔案產生、`tar -tzf 備份檔.tar.gz | head` 確認內容可正常列出（-t = 只列出不解壓）。

### 快速還原

```bash
#!/bin/bash
# /opt/scripts/restore-nginx.sh
# 用法：sudo /opt/scripts/restore-nginx.sh /backup/nginx/nginx_config_20260610_030000.tar.gz

BACKUP_FILE=$1                       # $1 = 第一個參數，即要還原的備份檔路徑

# 防呆：沒帶參數就顯示用法並列出可用的備份檔
# -z "$BACKUP_FILE" 代表「字串長度為 0」（即沒有給參數）
if [ -z "$BACKUP_FILE" ]; then
    echo "Usage: $0 <backup_file>"   # $0 = 腳本本身的名稱
    echo "Available backups:"
    ls -la /backup/nginx/            # 列出備份目錄，方便複製檔名重跑
    exit 1
fi

# 還原前先把「當前設定」備份一份——還原失敗時的逃生門
# $(date +%s) = Unix 時間戳（如 1781234567），確保每次備份目錄名稱不重複
cp -r /etc/nginx /etc/nginx.bak.$(date +%s)

# 還原：解壓備份檔
# tar 參數：-x 解壓、-z 處理 gzip、-f 指定檔案
# -C /：先切換到根目錄再解壓——因為備份時是以絕對路徑 /etc/nginx/ 打包，
#       解壓到 / 才會把檔案放回原本的 /etc/nginx/ 位置
tar -xzf $BACKUP_FILE -C /

# 測試還原後的設定是否合法
nginx -t
if [ $? -eq 0 ]; then                # 結束碼 0 = 測試通過
    nginx -s reload                  # 套用還原的設定（不中斷服務）
    echo "Restore completed successfully!"
else
    # 還原的設定有問題 → 用剛剛存的逃生門復原
    echo "Configuration test failed! Rolling back..."
    cp -r /etc/nginx.bak.* /etc/nginx
    nginx -s reload
fi
```

> 使用這支腳本的注意事項：
>
> - 整個流程的安全網是「**還原前先備份當前設定 → 還原後必過 `nginx -t` 才 reload**」，任何時刻線上服務都不會載入壞設定。
> - 小陷阱：回滾用的 `cp -r /etc/nginx.bak.* /etc/nginx` 在**累積多個** `.bak.*` 目錄時會把多個目錄一起複製進去。實務上建議把時間戳存成變數（`BAK_DIR=/etc/nginx.bak.$(date +%s)`），回滾時精確使用該目錄，並定期清理舊的 `.bak.*`。
> - 還原 SSL 憑證備份（`ssl_certs_*.tar.gz`）的做法相同，一樣用 `tar -xzf 檔名 -C /` 解回 `/etc/letsencrypt/`。
> - 災難復原演練時，建議在測試機上實際跑一次「備份 → 砍掉設定 → 還原」，確認備份真的可用——**沒驗證過的備份等於沒有備份**。

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

> Route53 故障轉移（Failover Routing）的設定由三個部分組成：
>
> 1. **健康檢查（Health Check）**
>    - 設定 Route53 定期（預設每 30 秒，可加價縮到 10 秒）從全球多個檢查點，向主要區域的端點發 HTTP/HTTPS/TCP 請求（例如 `https://主要區域LB/health`，回 2xx/3xx 視為健康）。
>    - 連續多次失敗（預設 3 次）才判定不健康，避免單點網路抖動誤判——概念與 Keepalived 的 `fall` 相同。
> 2. **兩筆同名 DNS 記錄（Failover 路由策略）**
>    - PRIMARY 記錄：指向 Region A 的負載均衡器，**綁定上面的健康檢查**。
>    - SECONDARY 記錄：指向 Region B；平時不回應，只有 PRIMARY 健康檢查失敗時，DNS 查詢才會改回應這筆。
> 3. **低 TTL**
>    - 容災記錄的 TTL 建議設 60 秒以內：故障切換後，全球客戶端最多再過一個 TTL 時間就會解析到新 IP。TTL 設 3600 秒的話，切換後最長一小時內仍有使用者連到掛掉的區域。
>
> Terraform 設定片段示意（協助理解結構，欄位名稱即上述概念）：
>
> ```hcl
> resource "aws_route53_health_check" "primary" {
>   fqdn              = "lb.region-a.example.com"  # 要檢查的主要區域端點
>   type              = "HTTPS"                    # 檢查協定
>   resource_path     = "/health"                  # 健康檢查路徑（即 Nginx 上的 /health 端點）
>   failure_threshold = 3                          # 連續失敗 3 次才判定故障
>   request_interval  = 30                         # 每 30 秒檢查一次
> }
> ```
>
> 跨區域容災的兩個常被忽略的重點：
>
> - **資料同步**：DNS 把流量切到 Region B 之後，B 的資料庫必須已有最新資料（跨區域複寫），否則切過去也是壞的服務——容災不只是切流量，更是切「完整可服務的環境」。
> - **定期演練**：備援區域平時沒有流量，設定壞了也不會被發現。建議定期手動觸發切換（或用少量加權流量持續驗證 Region B），確保備援真的能接。

---

## 12.8 監控與自動恢復

### 完整的健康檢查端點

```nginx
server {
    # 簡單的存活檢查：只回答「Nginx 本身活著嗎？」
    location /health/live {
        access_log off;              # 不記錄存取日誌（健康檢查每幾秒打一次，會灌爆日誌）
        default_type text/plain;     # 設定回應的 Content-Type 為純文字
        return 200 'alive';          # 直接回 200 與固定內容，不碰任何後端
    }

    # 就緒檢查（包含後端狀態）：回答「整條服務鏈路能正常服務嗎？」
    location /health/ready {
        access_log off;
        proxy_pass http://backend/health;   # 把檢查轉發給後端的 /health，後端掛了這裡就會回 502
        proxy_connect_timeout 3s;    # 連線後端的逾時：3 秒連不上就放棄（預設 60s，健康檢查必須快狠準）
        proxy_read_timeout 3s;       # 等待後端回應的逾時：3 秒沒回應視為失敗（預設 60s）
    }

    # 詳細狀態（需要認證）：給維運人員看的內部資訊，不可對外公開
    location /health/detail {
        auth_basic "Health Check";                    # 啟用 HTTP Basic 認證；字串是認證提示文字（realm）
        auth_basic_user_file /etc/nginx/.htpasswd;    # 帳密檔路徑（用 htpasswd 工具產生，見下方）

        default_type application/json;                # 回應宣告為 JSON
        return 200 '{
            "nginx": "running",
            "uptime": "$connections_active active connections",
            "version": "$nginx_version"
        }';
    }
}
```

### 這段設定在做什麼？（逐條）

- **三層健康檢查的分工**（概念借自 Kubernetes 的 liveness/readiness）：
  - `/health/live`（存活）：只確認 Nginx 行程能回應，**不依賴後端**。給 Keepalived 的 `check_nginx.sh`、雲端 LB 用——後端全掛時 Nginx 本身仍健康，不應觸發 VIP 切換。
  - `/health/ready`（就緒）：連同後端一起檢查。給「要不要把流量導給這個節點」的判斷用，例如上游 LB 或部署流程的驗證。
  - `/health/detail`（詳細）：含內部狀態資訊，必須加認證保護。
- `access_log off;`
  - 健康檢查通常每 2~10 秒一次、來自多個監控來源，不關日誌的話一天可多出數十萬行無意義紀錄，淹沒真正有用的存取紀錄。
- `default_type text/plain;` + `return 200 'alive';`
  - `return` 直接產生回應，是成本最低的端點寫法（不讀磁碟、不連後端）。
  - 注意：要設定回應的 Content-Type，應該用 `default_type`，而不是 `add_header Content-Type ...;`——`add_header` 只會「再附加一個」標頭，會造成回應出現兩個 Content-Type（一個來自預設值，一個來自 add_header），部分客戶端會解析錯亂。這是常見錯誤寫法，本範例已修正。
- `proxy_connect_timeout 3s;` / `proxy_read_timeout 3s;`
  - 兩者預設都是 60 秒，對健康檢查來說太久——監控系統通常 5~10 秒就逾時，等 Nginx 60 秒後才回 504 毫無意義。健康檢查場景建議 1~3 秒。
- `return 200 '{...}'` 中的變數：
  - `$connections_active`：目前活躍中的連線數（例如 `38`），由 `stub_status` 模組提供（官方套件預設已編入；可用 `nginx -V 2>&1 | grep stub_status` 確認）。
  - `$nginx_version`：Nginx 版本字串，例如 `1.24.0`。
  - `return` 的字串中可以直接內插變數，每次請求會代入當下的值，渲染結果例如：`{"nginx": "running", "uptime": "38 active connections", "version": "1.24.0"}`。
  - 安全提醒：版本號與連線數屬於內部資訊，洩漏給攻擊者有利於針對性攻擊，所以這個端點才需要 `auth_basic` 保護。

```bash
# 建立 Basic 認證的帳密檔（需要 apache2-utils / httpd-tools 套件）
sudo htpasswd -c /etc/nginx/.htpasswd ops    # -c 建立新檔案並新增使用者 ops（會互動式詢問密碼）

# 驗證三個端點
curl -i http://localhost/health/live                 # 應回 200 alive
curl -i http://localhost/health/ready                # 後端正常時回 200；後端掛掉時回 502/504
curl -i http://localhost/health/detail               # 沒帶帳密 → 401 Unauthorized
curl -i -u ops:密碼 http://localhost/health/detail   # -u 帳號:密碼 → 200 + JSON 內容
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
