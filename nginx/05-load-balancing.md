# 第五章：負載均衡（Load Balancing）

## 5.1 什麼是負載均衡？

負載均衡是將客戶端請求分散到多台後端伺服器，避免單一伺服器負荷過大，提升系統的可用性與擴展性。

```
                        ┌──────────────┐
                        │ App Server 1 │
                   ┌───►│ (port 3001)  │
                   │    └──────────────┘
┌────────┐    ┌────┴────┐
│ Client ├───►│  Nginx  │  ┌──────────────┐
└────────┘    │  LB     ├─►│ App Server 2 │
              └────┬────┘  │ (port 3002)  │
                   │       └──────────────┘
                   │    ┌──────────────┐
                   └───►│ App Server 3 │
                        │ (port 3003)  │
                        └──────────────┘
```

---

## 5.2 upstream 區塊

Nginx 使用 `upstream` 區塊定義後端伺服器群組：

```nginx
http {
    # 定義後端伺服器群組；群組名稱 backend 可自訂，供下方 proxy_pass 引用
    upstream backend {
        server 192.168.1.10:3000;   # 後端伺服器 1（格式：IP:port）
        server 192.168.1.11:3000;   # 後端伺服器 2
        server 192.168.1.12:3000;   # 後端伺服器 3
    }

    server {
        listen 80;                  # 監聽 80 port（HTTP）
        server_name myapp.com;      # 此虛擬主機負責回應的域名

        location / {
            proxy_pass http://backend;                    # 轉發給上面定義的 upstream 群組
            proxy_set_header Host $host;                  # 保留原始 Host 標頭給後端
            proxy_set_header X-Real-IP $remote_addr;      # 告知後端客戶端的真實 IP
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;  # 累加代理鏈 IP 清單
        }
    }
}
```

### 這段指令在做什麼？（逐條）

- `upstream backend { ... }`
  - 定義一組後端伺服器，名稱 `backend` 可自訂（如 `api_servers`、`web_pool`）。
  - 只能放在 `http` 區塊內，不能放在 `server` 或 `location` 裡。
  - 之後用 `proxy_pass http://backend` 引用整個群組，由負載均衡演算法決定實際打到哪台。
- `proxy_pass http://backend;`
  - 把匹配到此 `location` 的請求轉發給 `backend` 群組。
  - 這裡的 `backend` 是 upstream 群組名稱，**不是 DNS 域名**；Nginx 會優先用群組名稱比對。
  - 不設會怎樣：請求不會被轉發，Nginx 只會以本機內容回應（通常是 404）。
- `proxy_set_header Host $host;`
  - `$host`：客戶端請求的 Host 標頭，例如 `myapp.com`。
  - 不設會怎樣：後端收到的 Host 會變成 upstream 名稱 `backend`；若後端依域名區分站台（虛擬主機）或產生絕對網址，就會出錯。
- `proxy_set_header X-Real-IP $remote_addr;`
  - `$remote_addr`：與 Nginx 建立 TCP 連線的客戶端 IP，例如 `203.0.113.10`。
  - 不設會怎樣：後端看到的來源 IP 永遠是 Nginx 自己的 IP，日誌、限流、風控全部失真。
- `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`
  - `$proxy_add_x_forwarded_for`：把 `$remote_addr` **附加**到請求原有的 `X-Forwarded-For` 標頭之後，形成完整代理鏈。
  - 範例：請求原本帶 `X-Forwarded-For: 198.51.100.5`，經過 Nginx 後變成 `198.51.100.5, 203.0.113.10`；若原本沒有此標頭，值就只是 `203.0.113.10`。
  - 與 `X-Real-IP` 的差異：`X-Real-IP` 只有一個 IP；`X-Forwarded-For` 保留整條代理路徑（多層代理、前面有 CDN 時特別重要）。

> **驗證方式**：
>
> ```bash
> # 檢查設定檔語法是否正確
> sudo nginx -t
>
> # 套用新設定（不中斷服務）
> sudo nginx -s reload
>
> # 連續發送請求，觀察是否輪流分配
> # （搭配後端回傳主機識別資訊，或觀察 access log 的 $upstream_addr，見 5.7）
> for i in {1..6}; do curl -s http://myapp.com/; echo; done
> ```

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

> - 每台伺服器的權重預設為 1，所以會平均輪流分配。
> - 優點是行為簡單可預期；缺點是完全不考慮每台伺服器「當下」的忙碌程度。
> - 若各請求的處理時間差異很大，建議改用 `least_conn`（見下方）。

### 2. Weighted Round Robin（加權輪詢）

根據權重分配請求，效能較好的伺服器分配更多請求：

```nginx
upstream backend {
    server 192.168.1.10:3000 weight=5;   # 接收 5/8 的請求
    server 192.168.1.11:3000 weight=2;   # 接收 2/8 的請求
    server 192.168.1.12:3000 weight=1;   # 接收 1/8 的請求
}
```

> - `weight=N`：相對權重（正整數，預設 1），分母是所有權重的總和：5 + 2 + 1 = 8。
> - 所以三台分別分到約 5/8、2/8、1/8 的請求，這就是上面註解中分數的由來。
> - 權重不是百分比，`weight=5/2/1` 與 `weight=50/20/10` 效果相同。

**適用場景**：伺服器硬體規格不同時

### 3. Least Connections（最少連線）

將請求分配給當前活躍連線最少的伺服器：

```nginx
upstream backend {
    least_conn;                  # 啟用最少連線演算法（寫在 server 列表之前）
    server 192.168.1.10:3000;
    server 192.168.1.11:3000;
    server 192.168.1.12:3000;
}
```

> - 「活躍連線」指該台伺服器目前還在處理中的請求數，Nginx 會把新請求送給連線數最少的那台。
> - 仍會考慮 `weight`：權重高的伺服器被允許承擔更多連線。
> - 不設會怎樣：使用預設輪詢時，慢查詢多的那台伺服器可能持續堆積請求，回應越來越慢。

**適用場景**：請求處理時間差異大的服務（如 API 有快有慢的查詢）

### 4. IP Hash

同一個客戶端 IP 的請求永遠分配到同一台伺服器：

```nginx
upstream backend {
    ip_hash;                     # 依客戶端 IP 計算雜湊，固定對應到某一台
    server 192.168.1.10:3000;
    server 192.168.1.11:3000;
    server 192.168.1.12:3000;
}
```

> - 雜湊 key 是 IPv4 位址的「前三段」：例如 `203.0.113.10` 和 `203.0.113.99` 會被分到**同一台**（IPv6 則使用完整位址）。
> - 要暫時下線某台伺服器時，請標記 `down` 而不是刪除該行，否則整體雜湊對應會重洗，所有使用者的 Session 粘性都會跑掉。
> - `ip_hash` 不能與 `backup` 參數同時使用（`nginx -t` 會直接報錯）。

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

> 這行設定怎麼讀？
>
> - 語法是 `hash <key> [consistent];`：依自訂 key 計算雜湊值來選擇伺服器，key 可以是任何變數或字串組合。
>   - `$request_uri`：完整的原始請求 URI（**含**查詢參數），例如 `/products/list?page=2`。相同 URI 的請求永遠落在同一台。
>   - 其他常見 key：`hash $remote_addr;`（類似 ip_hash，但用完整 IP）、`hash $arg_user_id;`（依查詢參數 user_id 分配，同一使用者固定同一台）、`hash $http_x_tenant_id;`（依自訂標頭分配，多租戶場景）。
> - `consistent`：啟用一致性雜湊（ketama 演算法）。
>   - 加了 `consistent`：增減伺服器時，只有少部分 key 會被重新對應到別台。
>   - 不加 `consistent`：採用「除以伺服器數取餘數」式的傳統雜湊，伺服器數量一變，幾乎**所有** key 都會重新分配——若用於快取，等於快取大面積失效（快取雪崩），後端瞬間承受全部回源流量。
>   - 結論：只要伺服器數量可能變動（擴縮容、故障），快取場景一律建議加上 `consistent`。

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

> 這行設定怎麼讀？
>
> - `random;`：單純隨機選一台（會考慮 `weight`）。
> - `random two;`：先隨機挑出兩台，再依指定方法從兩台中選一台；未指定方法時預設用 `least_conn`。
> - `random two least_conn;`：明確指定第二階段用最少連線，與 `random two;` 行為相同，只是語意寫得更清楚。
> - 這就是經典的「Power of Two Choices」策略：
>   - 純隨機可能連續打中忙碌的伺服器。
>   - 全域 `least_conn` 在「多台 Nginx 同時做負載均衡」時會失準——每台 Nginx 只看得到自己派出去的連線數，看不到別台 Nginx 的。
>   - 「隨機挑兩台、再選較閒的那台」在大規模叢集 + 多台負載均衡器的場景下，分配效果接近 least_conn，又避免了視角不完整的問題。

**適用場景**：大規模叢集，或同時有多台 Nginx 做負載均衡時

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

> 補充說明（容易誤解的地方）
>
> - `max_fails` 與 `fail_timeout` 是一組的：「在 `fail_timeout` 時間窗內失敗達 `max_fails` 次 → 標記為不可用 `fail_timeout` 秒」。同一個參數同時扮演**統計時間窗**與**停用時長**兩種角色。
>   - 範例 `max_fails=3 fail_timeout=30s`：30 秒內失敗 3 次 → 接下來 30 秒不再把請求送給這台。
> - 時間單位：`s` 是秒、`m` 是分鐘（如 `fail_timeout=1m`）；不寫單位時預設為秒。
> - `backup`：平常完全不接請求，只有所有非 backup 伺服器都不可用時才啟用；不能與 `hash`、`ip_hash`、`random` 演算法併用。
> - `down`：常用於維護或滾動更新（見 5.8）；在 `ip_hash` 場景要下線伺服器時，用 `down` 而不是刪除該行，才能維持其他客戶端的雜湊對應。
> - `max_conns=N`：限制單台伺服器的最大並發連線數，預設 0（不限制）；後端容量有限（例如資料庫連線池只有 50 條）時很實用。
> - `slow_start`：僅商業版（NGINX Plus）支援，開源版寫了會報錯。

---

## 5.5 健康檢查（被動）

Nginx 開源版內建被動健康檢查：

```nginx
upstream backend {
    # 每台都設定：30 秒內失敗 3 次 → 暫停派發請求 30 秒
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

### 這段指令在做什麼？（逐條）

- `proxy_next_upstream error timeout http_500 http_502 http_503;`
  - 定義哪些結果算「這次嘗試失敗」，要改送下一台重試：
    - `error`：與後端建立連線、傳送請求或讀取回應標頭時發生錯誤（如連線被拒、連線中斷）。
    - `timeout`：上述過程逾時（受 `proxy_connect_timeout`、`proxy_read_timeout` 等控制，見 5.7）。
    - `http_500` / `http_502` / `http_503`：後端「有回應」但回了這些狀態碼，也視為失敗。
  - 預設值只有 `error timeout`——也就是說，**預設後端回 500 並不會觸發重試**，需要自己加上 `http_5xx` 系列。
- `proxy_next_upstream_tries 3;`
  - 限制一個請求最多嘗試 3 台（含第一次），避免一個壞請求把所有伺服器都打一輪。
  - 預設 0 = 不限制（實際上限是 upstream 中的伺服器台數）。
- `proxy_next_upstream_timeout 10s;`
  - 含重試在內的總時間上限，超過 10 秒就放棄、回錯誤給客戶端。
  - 預設 0 = 不限制。與 `tries` 兩者「先到先生效」。

> **常見錯誤**：POST 等「非冪等」請求預設**不會**被轉送到下一台重試（避免重複扣款、重複建單）。若確定後端能承受重複請求，才在 `proxy_next_upstream` 額外加上 `non_idempotent`。

---

## 5.6 Session 持久化

### 方法一：IP Hash

```nginx
upstream backend {
    ip_hash;                     # 同一客戶端 IP 永遠導向同一台（細節見 5.3）
    server 192.168.1.10:3000;
    server 192.168.1.11:3000;
}
```

> 優點是零成本；缺點如 5.3 所述——客戶端走 CDN、公司 NAT（多人共用一個出口 IP）時會失效或分配不均。

### 方法二：Cookie-based（推薦）

```nginx
# 使用 map 從 cookie 中取得路由資訊（map 只能定義在 http 層級）
map $cookie_SERVERID $backend_server {
    server1 192.168.1.10:3000;   # Cookie 值是 server1 → 導向第一台
    server2 192.168.1.11:3000;   # Cookie 值是 server2 → 導向第二台
    default 192.168.1.10:3000;   # 沒帶 Cookie 或值對不上 → 預設第一台
}

server {
    listen 80;
    server_name myapp.com;

    location / {
        proxy_pass http://$backend_server;   # 用變數動態決定轉發目標
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

### 這段指令在做什麼？（逐條）

- `map $cookie_SERVERID $backend_server { ... }`
  - `map` 是「查表」指令，語法為 `map 來源變數 目標變數 { 比對值 結果; ... }`：依「來源變數」的值決定「目標變數」的內容。
  - 只能定義在 `http` 層級（`conf.d/*.conf` 檔案的最外層即是），不能放進 `server` 或 `location`。
  - 採惰性求值：只有真正用到 `$backend_server` 時才會查表，幾乎沒有效能負擔。
- `$cookie_SERVERID`
  - 內建變數家族 `$cookie_名稱`：取出請求中指定名稱的 Cookie 值。
  - 範例：請求帶 `Cookie: SERVERID=server2` → `$cookie_SERVERID` 的值是 `server2` → 查表得到 `$backend_server = 192.168.1.11:3000`。
- `default 192.168.1.10:3000;`
  - 來源變數比對不到任何條目時的預設值（第一次來訪、Cookie 被清除、值非法都走這裡）。
  - 不設會怎樣：查不到時 `$backend_server` 會是空字串，`proxy_pass http://;` 直接導致 500 錯誤。
- `proxy_pass http://$backend_server;`
  - `proxy_pass` 搭配**變數**使用：轉發目標在每個請求時動態決定。
  - 注意：走變數時就**不會**經過 upstream 群組，因此 5.4 / 5.5 的 `max_fails`、`backup`、`keepalive` 等機制都不適用，該台掛了也不會自動轉移到別台。
  - 若 map 的結果是域名而非 IP，還需要額外設定 `resolver`，否則無法解析。

> **誰負責寫入 Cookie？**
>
> - 這個方法需要**後端應用程式**在第一次回應時設定 Cookie，例如：`Set-Cookie: SERVERID=server1; Path=/`。
> - 之後瀏覽器每次請求都會帶上這個 Cookie，Nginx 依它把請求導回同一台。
> - 補充：開源版 Nginx 沒有 `sticky cookie` 指令（那是商業版 NGINX Plus 的功能），`map + $cookie_*` 正是開源版常見的替代做法。
> - 與 ip_hash 相比的優點：不受 CDN / NAT 影響，粘性跟著瀏覽器走，而不是跟著出口 IP 走。

### 方法三：後端共享 Session（最佳解法）

最理想的做法是讓後端應用程式使用共享的 Session 儲存：

```
                    ┌──────────────┐
              ┌────►│ App Server 1 │────┐
              │     └──────────────┘    │
┌────────┐  ┌─┴──┐                      ▼
│ Client ├─►│ LB │               ┌─────────────┐
└────────┘  └─┬──┘               │    Redis    │
              │                  │  (Session)  │
              │                  └─────────────┘
              │     ┌──────────────┐    ▲
              └────►│ App Server 2 │────┘
                    └──────────────┘
```

> 為什麼這是最佳解法？
>
> - Session 集中存放在 Redis（或 Memcached、資料庫），任何一台 App Server 都能服務任何使用者 → 負載均衡演算法可以自由選擇（例如 `least_conn`），完全不需要粘性。
> - 伺服器可以隨時增減、重啟，不會弄丟使用者的登入狀態，滾動更新（見 5.8）也更安全。
> - 代價：多了一個基礎元件（Redis）要維運，且每次請求多一次 Session 查詢的開銷。

---

## 5.7 完整的生產環境負載均衡設定

```nginx
# 注意：log_format 只能定義在 http 層級（conf.d/*.conf 檔案的最外層即是），
# 寫在 server 區塊內 nginx -t 會報錯
log_format upstream_log '$remote_addr - [$time_local] '
                        '"$request" $status $body_bytes_sent '
                        'upstream: $upstream_addr '
                        'response_time: $upstream_response_time '
                        'status: $upstream_status';

upstream api_servers {
    least_conn;                                  # 最少連線演算法（見 5.3）

    # 主要伺服器（weight：權重；max_fails / fail_timeout：被動健康檢查，見 5.4、5.5）
    server 10.0.1.10:3000 weight=3 max_fails=3 fail_timeout=30s;
    server 10.0.1.11:3000 weight=3 max_fails=3 fail_timeout=30s;
    server 10.0.1.12:3000 weight=2 max_fails=3 fail_timeout=30s;   # 規格較差，權重較低

    # 備用伺服器（上面三台全部不可用時才啟用）
    server 10.0.2.10:3000 backup;

    # Keep-Alive 連線池（需搭配下方 proxy_http_version 1.1 與 Connection "" 才會生效）
    keepalive 32;               # 每個 worker 行程最多保留 32 條「閒置」後端連線
    keepalive_requests 1000;    # 單條後端連線最多承載 1000 個請求後關閉重建
    keepalive_timeout 60s;      # 閒置的後端連線最多保留 60 秒
}

server {
    listen 80;
    server_name api.myapp.com;

    # 存取日誌（含 upstream 資訊），引用上面定義的 upstream_log 格式
    access_log /var/log/nginx/api.access.log upstream_log;

    location / {
        proxy_pass http://api_servers;   # 轉發給 upstream 群組
        proxy_http_version 1.1;          # 對後端改用 HTTP/1.1（預設 1.0 不支援 Keep-Alive）

        # Keep-Alive 支援（配合 upstream 的 keepalive）
        proxy_set_header Connection "";  # 清空 Connection 標頭，後端連線才能重複使用

        # 標頭（各變數含義詳見 5.2）
        proxy_set_header Host $host;                                   # 原始域名
        proxy_set_header X-Real-IP $remote_addr;                       # 客戶端真實 IP
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;   # 代理鏈 IP 清單
        proxy_set_header X-Forwarded-Proto $scheme;                    # 原始協定（http 或 https）

        # 逾時
        proxy_connect_timeout 5s;   # 與後端建立 TCP 連線的逾時
        proxy_send_timeout 60s;     # 傳送請求給後端時，兩次寫入之間的逾時
        proxy_read_timeout 60s;     # 讀取後端回應時，兩次讀取之間的逾時

        # 失敗轉移（各值含義詳見 5.5）
        proxy_next_upstream error timeout http_500 http_502 http_503;  # 哪些情況換下一台
        proxy_next_upstream_tries 2;       # 最多嘗試 2 台（含第一次）
        proxy_next_upstream_timeout 10s;   # 含重試在內的總時間上限
    }

    # 健康檢查端點（不需負載均衡，由 Nginx 直接回應）
    location /nginx-health {
        return 200 'OK';                      # 直接回 200 與內容 OK，不打後端
        add_header Content-Type text/plain;   # 標示回應為純文字
    }
}
```

### 這段設定在做什麼？（逐條）

**upstream 內的 Keep-Alive 三兄弟**

> - `keepalive 32;`
>   - 意義：**每個 worker 行程**最多保留 32 條「閒置的」後端連線供重複使用；超過時會關閉最久未使用的那條。
>   - 注意：這**不是**對後端的最大連線數上限——忙碌中（處理請求中）的連線不受這個數字限制。
>   - 為什麼要設：少了它，每個請求都要重新做一次 TCP 三方交握（若後端是 HTTPS 還要再做 TLS 交握），高流量下延遲與 CPU 開銷會明顯增加，後端也會累積大量 TIME_WAIT 連線。
>   - 建議值：一般 API 場景 16 ~ 64；總閒置連線數約為 `worker_processes × keepalive`，數字過大會占用後端的連線資源。
> - `keepalive_requests 1000;`
>   - 單條後端連線最多服務 1000 個請求，之後關閉重建（Nginx 1.24 預設即 1000）。
>   - 為什麼要定期重建：釋放單一連線累積的記憶體，也讓負載有機會重新分配，不會永遠黏在同一台。
> - `keepalive_timeout 60s;`
>   - 閒置的後端連線最多保留 60 秒，逾時就關閉（預設即 60s）。
>   - **小心同名指令**：`http` / `server` 區塊裡的 `keepalive_timeout` 管的是「客戶端 ↔ Nginx」的連線；upstream 區塊裡的這個管的是「Nginx ↔ 後端」的連線。名字相同、對象完全不同。
>   - 實務建議：把這個值設成「不大於後端應用程式自己的 keep-alive 逾時」，避免 Nginx 拿到一條後端已單方面關閉的連線而出錯。

**為什麼需要 `proxy_http_version 1.1` 和 `Connection ""`？**

> - `proxy_http_version 1.1;`
>   - Nginx 對後端**預設使用 HTTP/1.0**，而 HTTP/1.0 不支援連線重複使用——不設這行，upstream 的 `keepalive` 形同虛設。
> - `proxy_set_header Connection "";`
>   - Nginx 預設會對後端送出 `Connection: close`，等於每個請求做完就要求後端關閉連線。
>   - 把值設為空字串 `""` 時，Nginx 會**完全不送出**這個標頭；HTTP/1.1 預設行為就是 keep-alive，連線因此才能真正重複使用。
>   - 另一個作用：`Connection` 是「逐跳標頭」（hop-by-hop header），只對相鄰兩端有效；清空它可避免把客戶端帶來的 `Connection: close` 原封不動轉給後端造成干擾。
> - 三者缺一不可：`keepalive`（連線池）+ `proxy_http_version 1.1`（協定支援）+ `proxy_set_header Connection ""`（不主動要求關閉）。

**log_format 中的 upstream 變數**

> - `$upstream_addr`：實際處理這個請求的後端位址，例如 `10.0.1.11:3000`。若發生失敗轉移，會以逗號列出嘗試過的每一台，例如 `10.0.1.10:3000, 10.0.1.11:3000`。
> - `$upstream_response_time`：後端處理時間（單位：秒，毫秒精度），例如 `0.042`；重試時同樣以逗號分隔多個值。
> - `$upstream_status`：後端回應的狀態碼，例如 `200`；重試時可能是 `502, 200`（第一台回 502、第二台成功）。
> - 這三個變數是排查「慢在 Nginx 還是慢在後端」「請求被哪台處理」的關鍵資訊（見 5.8 情境三）。

**三個逾時參數**

> - `proxy_connect_timeout 5s;`
>   - 與後端**建立 TCP 連線**的等待上限；預設 60s，且實務上不應超過 75 秒。
>   - 同機房內網建立連線通常是毫秒級，設 3 ~ 5 秒已非常寬裕；設太長會讓「掛掉的伺服器」拖慢失敗轉移的速度。
> - `proxy_send_timeout 60s;`
>   - 把請求**寫給後端**時，「兩次成功寫入之間」的間隔上限；預設 60s。
>   - 上傳大檔案、後端讀取請求很慢時才可能觸發，一般維持預設即可。
> - `proxy_read_timeout 60s;`
>   - 等待後端回應時，「兩次成功讀取之間」的間隔上限；預設 60s。
>   - **不是整個回應的總時限**——只要後端持續有資料送出就不會觸發。
>   - 報表、匯出等慢查詢 API 常需調大到 120s ~ 300s（搭配 5.8 情境二）。

**失敗轉移**

> - `proxy_next_upstream error timeout http_500 http_502 http_503;`：定義哪些結果算失敗、要改送下一台（各值逐條解說見 5.5）。
> - `proxy_next_upstream_tries 2;`：最多嘗試 2 台（含第一次），即失敗轉移最多發生一次。生產環境建議設小（2 ~ 3），避免大面積故障時重試把流量放大數倍（重試風暴）。
> - `proxy_next_upstream_timeout 10s;`：含重試在內總共最多花 10 秒，與 `tries` 兩者先到先生效。
> - 提醒：每次失敗的嘗試也會累計到 5.4 / 5.5 的 `max_fails`，兩套機制是聯動的。

**健康檢查端點**

> - `location /nginx-health` 用來給外部監控（或上層 LB）確認「Nginx 本身」活著，請求不會進到後端。
> - 補充：更乾淨的寫法是在這個 location 裡用 `default_type text/plain;` 取代 `add_header Content-Type ...;`，可避免回應出現重複的 Content-Type 標頭。

> **驗證方式**：
>
> ```bash
> # 測試設定並平滑重載
> sudo nginx -t && sudo nginx -s reload
>
> # 測試健康檢查端點（應回 200 OK，且後端日誌不會出現這筆請求）
> curl -i http://api.myapp.com/nginx-health
>
> # 觀察 upstream 日誌欄位（確認分配是否均勻、回應時間是否正常）
> tail -f /var/log/nginx/api.access.log
> ```

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
# rolling-deploy.sh — 逐台「下線 → 部署 → 上線」，達成零停機更新

SERVERS=("10.0.1.10" "10.0.1.11" "10.0.1.12")   # 要依序更新的後端伺服器清單
NGINX_CONF="/etc/nginx/conf.d/upstream.conf"     # upstream 設定檔位置

for server in "${SERVERS[@]}"; do
    echo "Deploying to $server..."

    # 從負載均衡中移除：
    # sed -i 表示直接修改檔案（in-place）；s/舊字串/新字串/ 是「取代」語法
    # 效果：把「server 10.0.1.10:3000;」這一行改寫成「server 10.0.1.10:3000 down;」
    sed -i "s/server $server:3000;/server $server:3000 down;/" $NGINX_CONF
    nginx -t && nginx -s reload   # 語法檢查通過才重載，down 標記生效後不再派新請求給這台
    sleep 5  # 等待現有請求處理完畢（reload 後不派新請求，但已在處理中的請求需要時間收尾）

    # 部署新版本（SSH 到該台：拉取新程式碼並重啟應用程式）
    ssh deploy@$server "cd /app && git pull && pm2 restart all"
    sleep 10  # 等待應用程式啟動（暖機），避免還沒就緒就重新接流量

    # 重新加入負載均衡（把剛剛加上的 down 標記移除，還原成原本那行）
    sed -i "s/server $server:3000 down;/server $server:3000;/" $NGINX_CONF
    nginx -t && nginx -s reload
    sleep 3   # 緩衝觀察，確認這台穩定接流量後再處理下一台

    echo "$server deployed successfully!"
done

echo "Rolling deploy completed!"
```

> 這個腳本的關鍵點與風險（逐條）
>
> - `sed -i "s/.../.../" $NGINX_CONF`：用「字串取代」修改設定檔。第一次取代是在該行**加上** `down` 標記，第二次是把它**移除**還原。
> - 為什麼要 `sleep`？
>   - `sleep 5`：reload 後 Nginx 不再把新請求送到這台，但已在途中的請求還在處理；不等它們收尾就重啟應用程式，這些請求會直接失敗。
>   - `sleep 10`：等應用程式啟動完成。更可靠的做法是輪詢健康檢查端點而不是猜秒數：
>     `until curl -sf http://$server:3000/health; do sleep 1; done`
>   - `sleep 3`：恢復後的觀察緩衝，確認正常再進行下一台，避免「全部更新完才發現新版有問題」。
> - **風險一（最常見）**：sed 是逐字比對，若設定檔該行帶有其他參數（如 `weight=3 max_fails=3`），樣式比對不到就**默默不做任何事**——伺服器根本沒被下線，腳本卻照常往下跑、直接重啟還在接流量的應用程式。執行前先用 `grep "server $server" $NGINX_CONF` 確認實際行內容與 sed 樣式一致。
> - **風險二**：腳本沒有錯誤處理——若 `nginx -t` 失敗、SSH 斷線或部署失敗，迴圈仍會繼續更新下一台，可能造成多台同時異常。建議在開頭加上 `set -euo pipefail`（任一指令失敗就中止）。
> - **風險三**：權限與備份——修改 /etc/nginx 與執行 reload 通常需要 root；`sed -i` 動手前建議先備份：`cp $NGINX_CONF $NGINX_CONF.bak`。
> - **風險四**：容量下降——三台中隨時有一台在更新，期間整體容量少約 1/3，請挑離峰時段執行。

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

> 補充：
>
> - `proxy_read_timeout 120s;` 與 `upstream { ... }` 是 Nginx 設定（要寫回對應的設定檔再 reload），不是 bash 指令；這裡只是並列展示排查方向。
> - `max_fails=5 fail_timeout=10s` 的調整邏輯：放寬失敗次數（3 → 5）、縮短停用時間（30s → 10s），讓偶發抖動不會輕易把整台踢下線。
> - `free -m`：以 MB 為單位查看記憶體使用；`top -bn1 | head -20`：批次模式跑一次 top 並取前 20 行，快速看 CPU / 記憶體吃緊的行程。

### 情境三：負載不均勻

**問題**：某台伺服器的負載遠高於其他伺服器

```nginx
# 排查步驟：

# 1. 檢查日誌確認請求分配
# 在 log_format 中加入 $upstream_addr
access_log /var/log/nginx/access.log upstream_log;

# 2. 統計每台伺服器收到的請求數（grep -c：只輸出符合條件的行數）
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

> 補充：若 upstream 使用 `ip_hash` 或未加 `consistent` 的 `hash`，加入新伺服器會改變雜湊分布，部分使用者的 Session 粘性 / 快取命中會受影響（參考 5.3 的一致性雜湊說明）。

---

## 5.9 本章小結

- 負載均衡是避免單一伺服器負荷過大的關鍵技術
- Nginx 提供多種負載均衡演算法，根據場景選擇合適的演算法
- `least_conn` 是大多數場景的最佳選擇
- 被動健康檢查透過 `max_fails` 和 `fail_timeout` 實現
- 使用 `keepalive` 減少後端連線建立的開銷
- upstream 的 `keepalive` 必須搭配 `proxy_http_version 1.1` 與 `proxy_set_header Connection "";` 才會生效
- `hash` 演算法用於快取場景時，記得加上 `consistent` 避免擴縮容造成快取雪崩
- Session 持久化最好透過後端共享 Session 儲存來實現
- 滾動更新可以實現零停機部署

---

> 上一章：[反向代理](./04-reverse-proxy.md) | 下一章：[SSL/HTTPS 設定](./06-ssl-https.md)
