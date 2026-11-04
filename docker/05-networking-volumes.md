# 第五章：Docker 網路與資料持久化

## 5.1 Docker 網路模式

Docker 提供多種網路驅動，讓容器之間以及容器與外部世界進行通訊。

### 網路驅動類型

| 驅動 | 說明 | 適用場景 |
|------|------|----------|
| `bridge` | 預設驅動，建立虛擬網橋 | 單機上的多容器通訊 |
| `host` | 容器直接使用主機網路 | 需要最高網路效能 |
| `none` | 完全禁用網路 | 安全隔離場景 |
| `overlay` | 跨主機的容器通訊 | Docker Swarm / 多主機部署 |
| `macvlan` | 分配實體 MAC 位址 | 需要容器直接出現在實體網路中 |

> 備註：與主機網路關聯（直覺版）
>
> - `bridge`：容器在獨立網路 namespace，掛在 Docker 建的虛擬網橋上（常見 `docker0`）；主機扮演 NAT/轉送角色。
> - `host`：容器直接共用主機 network namespace，沒有自己的獨立 IP；服務直接使用主機 port。
> - `none`：容器雖有自己的 namespace，但幾乎沒有可用網路（通常只剩 loopback）；和主機/外部都不通。
> - `overlay`：容器分散在多台主機，主機之間用 overlay 隧道（例如 VXLAN）轉送封包，讓跨主機容器像在同一個網段。
> - `macvlan`：容器直接出現在實體網路，擁有自己的 MAC/IP，像一台獨立實體機；但主機與該容器常需額外設定才能互通。
>
> 備註：實務上常見選擇
>
> - 單機 Docker / Docker Compose：大多使用「自訂 `bridge` 網路」（最常見、平衡隔離與易用性）。
> - `host`：少數高效能或特殊需求才用（例如監控 agent、需要直接用主機 port）；要注意隔離性與 port 衝突。
> - `overlay`：主要在 Docker Swarm 多主機情境常見；純單機專案通常不需要。
> - `macvlan`：偏特殊整合場景（例如既有網路設備需要看到獨立 MAC/IP）。
>
> 備註：Kubernetes 通常用哪個？
>
> - Kubernetes 不直接用 Docker 的 `bridge/overlay` 指令，而是透過 CNI 建立 Pod 網路。
> - 在 K8s 中，每個 Pod 通常有自己的 IP，且可跨節點通訊；概念上較接近「可跨主機互通」的模型。
> - 常見 CNI（如 Calico / Cilium / Flannel）底層可能是 overlay（VXLAN）或路由模式。
> - K8s 也可用 `hostNetwork: true`（接近 Docker `host`），但通常只在特定需求下使用。

### Bridge 網路（預設）

```bash
# 查看現有網路
docker network ls

# 輸出範例：
# NETWORK ID     NAME      DRIVER    SCOPE
# a1b2c3d4e5f6   bridge    bridge    local
# f6e5d4c3b2a1   host      host      local
# 1a2b3c4d5e6f   none      null      local

# 預設 bridge 網路的特性：
# - 所有容器預設連到這個網路
# - 容器之間可以用 IP 互通
# - 但不支援 DNS 服務名稱解析（不推薦使用）

# 跟著做：在預設 bridge 上，用名稱找不到別的容器
docker run -d --name web nginx:1.30-alpine
docker run --rm alpine:3.24 ping -c 1 web
# ping: bad address 'web'
docker rm -f web
```

### 自訂 Bridge 網路（推薦）

```bash
# 建立自訂網路(bridge)
# 若不指定 --subnet，Docker 會自動挑一段未使用的網段
docker network create my-network

# 在自訂網路中啟動容器
# 啟動 Web 服務並加入 my-network（當作「api」）
docker run -d --name api --network my-network nginx:1.30-alpine
# 啟動 PostgreSQL 並加入同一網路（postgres 映像一定要給密碼，否則會直接退出）
docker run -d --name db --network my-network -e POSTGRES_PASSWORD=secret postgres:16-alpine

# 從同一個網路裡的臨時容器，用「容器名稱」連線
docker run --rm --network my-network alpine:3.24 wget -qO- http://api | head -4
docker run --rm --network my-network alpine:3.24 nc -zv db 5432
# db (172.18.0.3:5432) open

# 容器之間也能直接用名稱互連（nginx:1.30-alpine 內建 busybox 的 ping）
docker exec api ping -c 2 db
# PING db (172.18.0.3): 56 data bytes
# 64 bytes from 172.18.0.3: seq=0 ttl=64 time=0.123 ms

# 在應用程式中使用服務名稱
# DB_HOST=db（不是 IP 位址）

# 自訂 bridge 網路的優勢：
# ✅ 支援 DNS 自動解析（用容器名稱互連）
# ✅ 更好的隔離性
# ✅ 容器可以動態加入/離開網路
```

### 指定網段

```bash
# 指定子網路（CIDR）
# 10.123.0.0/16 = 網段 10.123.0.0，遮罩 255.255.0.0（可用位址約 65k）
# 常見用途：避免和公司 VPN/內網網段衝突、需要固定 IP 規劃、跨多專案維持可預測網段
docker network create --subnet=10.123.0.0/16 my-network-v2

# 確認網段
docker network inspect my-network-v2 --format '{{json .IPAM.Config}}'
# [{"Subnet":"10.123.0.0/16"}]
```

> 出現 `Pool overlaps with other one on this address space`，代表這個網段已經被這台機器上的其他 Docker 網路用掉了（例如其他 Compose 專案）。用 `docker network inspect $(docker network ls -q) --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}}'` 列出已使用的網段，換一段沒用到的即可。

> 備註：網路建立後可以改嗎？
>
> - `subnet`、`gateway`、`driver` 這類核心參數通常是「建立時決定」，建立後不能直接原地修改。
> - 建立後可調整的是「容器連線關係」：例如 `docker network connect` / `disconnect`、網路別名等。
> - 若要改網段，實務上做法是：新建網路 -> 容器切過去 -> 刪除舊網路。
>
> ```bash
> # 把 api 和 db 從 my-network 切到剛建立的 my-network-v2
> docker network connect my-network-v2 api
> docker network connect my-network-v2 db
> docker network disconnect my-network api
> docker network disconnect my-network db
> # 舊網路上已經沒有容器，才刪得掉（還有容器連著會出現 has active endpoints）
> docker network rm my-network
>
> # 切換後名稱解析照常運作，IP 變成新網段的位址
> docker exec api ping -c 1 db
> # PING db (10.123.0.3): 56 data bytes
> ```
>
> - 容器可同時連多個網路（雙掛）：先 `connect` 新網路，驗證服務正常，再 `disconnect` 舊網路，可降低切換時中斷風險。
> - 在上面的範例中，`api` 在 `docker network connect my-network-v2 api` 後會暫時同時連到 `my-network` 與 `my-network-v2`，下一步 `disconnect` 才會完全切換。

```bash
# 練習結束清理
docker rm -f api db
docker network rm my-network-v2
```

> 公司 VPN 或內網剛好使用 `172.17.0.0/16`～`172.31.0.0/16` 這類網段時，Docker 自動挑的網段可能和它重疊，造成連上 VPN 後容器或內網某些主機連不到。可以在 daemon 設定（Linux 的 `/etc/docker/daemon.json`；Docker Desktop 在 Settings → Docker Engine）指定 Docker 自動配發的網段範圍：
>
> ```json
> {
>   "default-address-pools": [
>     { "base": "10.200.0.0/16", "size": 24 }
>   ]
> }
> ```
>
> 改完要重啟 Docker，且只影響之後新建的網路。

### 容器連到主機上的服務：`host.docker.internal`

容器裡的 `localhost` 是容器自己。想從容器連到**主機**上跑的服務（例如主機上直接執行的開發伺服器、資料庫），要用特殊名稱 `host.docker.internal`：

```bash
# 在主機開一個簡單的 HTTP 服務（Python 3 內建），綁在所有介面
python3 -m http.server 8000

# 另開一個終端，從容器連回主機
docker run --rm alpine:3.24 wget -qO- http://host.docker.internal:8000 | head -3
```

- macOS / Windows 的 Docker Desktop 內建這個名稱。主機上的服務若只綁 `127.0.0.1`，從容器可能連不到（會出現 `Connection refused`），要綁 `0.0.0.0`。
- Linux 預設沒有這個名稱，要在啟動時加上對應：

```bash
# host-gateway 是特殊值，Docker 會換成主機在 bridge 網路上的 IP
docker run --rm --add-host=host.docker.internal:host-gateway alpine:3.24 wget -qO- http://host.docker.internal:8000
```

Compose 寫法：

```yaml
services:
  api:
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

### Host 網路

```bash
# 容器直接使用主機的網路
docker run -d --network host --name my-nginx nginx

# 特點：
# - 沒有 port 對映，容器直接綁定主機 port
# - 效能最好（沒有 NAT 開銷）
# - 只在 Linux 上完整支援；Docker Desktop 的「主機」其實是背景那台 Linux VM（見第一章），
#   要在 Settings → Resources → Network 啟用 host networking，且行為與 Linux 不完全相同
# - 容器間沒有網路隔離
```

> 備註：`host` 的「沒有網路隔離」是指容器與主機共用同一個 network namespace。
>
> - 兩個 `--network host` 容器，行為上很像同一台主機上的兩個程序，通常可以透過主機位址與 port 互通。
> - 但不代表「無條件完全互通」：仍受服務綁定位址（`127.0.0.1` / `0.0.0.0`）、防火牆規則、port 是否衝突影響。
> - 也不會有自訂 `bridge` 網路那種以容器名稱做 DNS 互相解析的體驗。

### 網路管理指令

```bash
# 列出所有網路
docker network ls

# 查看網路詳細資訊
docker network inspect my-network

# 將容器連接到網路
docker network connect my-network my-container

# 將容器從網路斷開
docker network disconnect my-network my-container

# 刪除網路
docker network rm my-network

# 清理未使用的網路
docker network prune
```

---

## 5.2 Docker Compose 中的網路

### 預設網路行為

```yaml
# Docker Compose 會自動建立一個網路
# 名稱為：<專案目錄名>_default
# 所有服務自動加入這個網路

services:
  api:
    image: my-api
    # 可以用 "db" 作為主機名稱連線

  db:
    image: postgres:16
    # 可以用 "api" 作為主機名稱連線
```

### 自訂網路

```yaml
services:
  # 前端只在 frontend 網路
  web:
    image: nginx
    networks:
      - frontend
    ports:
      - "80:80"

  # API 連接前後端兩個網路
  api:
    image: my-api
    networks:
      - frontend
      - backend

  # 資料庫只在 backend 網路（外部無法直接存取）
  db:
    image: postgres:16
    networks:
      - backend

networks:
  frontend:
    driver: bridge
  backend:
    driver: bridge
    internal: true    # 禁止外部存取（更安全）
```

### 使用固定 IP

```yaml
services:
  api:
    networks:
      app-network:
        ipv4_address: 172.20.0.10

networks:
  app-network:
    driver: bridge
    ipam:
      config:
        - subnet: 172.20.0.0/16
```

> 備註：這段在做什麼？
>
> - `ipv4_address: 172.20.0.10`：指定 `api` 在 `app-network` 上固定使用這個「單一 IP（主機位址）」。
> - `subnet: 172.20.0.0/16`：定義 `app-network` 的「整個網段（位址池）」。
> - `app-network` 是此 Compose 檔中的自訂網路名稱（key）；實際 Docker network 名稱通常會是 `<專案名>_app-network`（除非另外指定 `name`）。
> - 差別可理解為：`172.20.0.0/16` 是「社區範圍」，`172.20.0.10` 是「社區中的某一戶門牌」。
> - `172.20.0.0/16` 的位址範圍是 `172.20.0.0` ~ `172.20.255.255`；常見可用主機位址約為 `172.20.0.1` ~ `172.20.255.254`（`172.20.0.0` 為網段位址、`172.20.255.255` 為廣播位址）。
> - 固定 IP 必須落在該 subnet 內，且不能和其他容器重複。
>
> 備註：什麼情況會需要固定 IP？
>
> - 舊系統或防火牆白名單只能填 IP，不支援服務名稱（DNS）。
> - 要和外部設備/第三方系統做 ACL 綁定（只允許特定來源或目的 IP）。
> - 特定排錯或封包分析情境，需要可預期且不變的位址。
>
> 一般情況（特別是 Compose 服務互連）通常不建議依賴固定 IP，優先使用服務名稱（如 `db`、`api`）；可讀性與可擴展性更好，且不容易遇到擴容時 IP 衝突問題。

---

## 5.3 資料持久化

容器的檔案系統是暫時的——容器刪除後，所有修改的資料都會消失。Docker 提供三種方式來持久化資料。

### 三種掛載方式比較

```
┌─────────────────────────────────────────────────────────────────┐
│                        Docker Host                              │
│                                                                 │
│  ┌─────────────┐   ┌───────────────┐   ┌──────────────────┐     │
│  │ Named Volume│   │  Bind Mount   │   │   tmpfs Mount    │     │
│  │             │   │               │   │                  │     │
│  │ /var/lib/   │   │ /home/user/   │   │   (記憶體)        │     │
│  │ docker/     │   │ project/data  │   │                  │     │
│  │ volumes/    │   │               │   │                  │     │
│  └──────┬──────┘   └───────┬───────┘   └────────┬─────────┘     │
│         │                  │                     │              │
│         ▼                  ▼                     ▼              │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                     Container                           │    │
│  │  /data              /app/data             /tmp/cache    │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

| 類型 | 管理方式 | 效能 | 適用場景 |
|------|----------|------|----------|
| Named Volume | Docker 管理 | 好 | 資料庫、持久化資料 |
| Bind Mount | 使用者管理 | Linux 上好；Docker Desktop 上較慢（檔案要跨 VM 同步） | 開發時掛載原始碼 |
| tmpfs Mount | 記憶體 | 最快 | 暫時性機密資料 |

> 備註：三者具體差異（含主機與容器關聯）
>
> - `Named Volume`：主機上的實際資料由 Docker 管理（常在 `/var/lib/docker/volumes/...`），容器只看到掛載點（如 `/data`）；容器刪掉資料仍可保留，適合正式環境持久化。
> - `Bind Mount`：你指定主機路徑直接映射到容器路徑（如 `/home/user/project` -> `/app`）；主機與容器看到的是同一份檔案，雙向即時影響，最適合開發時改碼即生效。
> - `tmpfs Mount`：資料放在主機 RAM，不寫磁碟；容器可讀寫但容器停止/重建後資料即消失，適合快取、暫存、短期敏感資料。
>
> 快速判斷：
>
> - 要持久化且不要綁死主機目錄：選 `Named Volume`
> - 要直接操作主機檔案（尤其原始碼）：選 `Bind Mount`
> - 要極速且不落地保存：選 `tmpfs Mount`
>
> 一句話對照：`Named Volume` 是「用名字交給 Docker 管理資料」；`Bind Mount` 是「用主機實際路徑直接綁到容器」。

### Named Volume（具名掛載）

```bash
# 建立 Volume
docker volume create my-data

# 使用 Volume 啟動容器
docker run -d \
  -v my-data:/var/lib/postgresql/data \
  -e POSTGRES_PASSWORD=secret \
  --name my-db \
  postgres:16-alpine

# 列出所有 Volume
docker volume ls

# 查看 Volume 詳細資訊
docker volume inspect my-data

# 輸出範例：
# [
#   {
#     "CreatedAt": "2026-02-06T10:00:00Z",
#     "Driver": "local",
#     "Labels": {},
#     "Mountpoint": "/var/lib/docker/volumes/my-data/_data",
#     "Name": "my-data",
#     "Options": {},
#     "Scope": "local"
#   }
# ]

# 刪除 Volume（還有容器在使用時會失敗，先刪容器）
docker rm -f my-db
docker volume rm my-data

# 清理未使用的「匿名」Volume（沒有名字、只有一串 ID 的那種）
docker volume prune

# 連未使用的「具名」Volume 也清掉 ⚠️ compose down 後還沒啟動的專案資料也會被刪
docker volume prune -a
```

### 跟著做：Volume 與 Bind Mount 掛載時的差異

兩者掛到「映像裡原本就有檔案的目錄」時，行為完全不同。這個差異是很多「檔案不見了」問題的根源：

```bash
# 1. 空的 named volume 第一次掛上去：Docker 會先把映像裡該目錄的內容「複製」進 volume
docker run --rm -v html-vol:/usr/share/nginx/html nginx:1.30-alpine ls /usr/share/nginx/html
# 50x.html
# index.html          ← nginx 映像原本的檔案被複製進 volume 了

# 2. bind mount：主機目錄直接「蓋住」映像裡的目錄，原本的內容看不到
mkdir -p ~/docker-practice/empty-dir
docker run --rm -v ~/docker-practice/empty-dir:/usr/share/nginx/html nginx:1.30-alpine ls /usr/share/nginx/html
# （沒有任何輸出）    ← index.html 不見了

docker volume rm html-vol
```

| | Named Volume（空的） | Named Volume（已有資料） | Bind Mount |
|--|--|--|--|
| 映像裡該目錄的內容 | 第一次掛載時複製進 volume | **不會**再複製，以 volume 內容為準 | 被蓋住、看不到 |
| 擁有者與權限 | 沿用映像中該目錄的設定 | 維持 volume 現有的 | 沿用主機目錄的 |

這張表可以解釋幾個常見現象：

- 第四、六章用匿名 volume 保護 `/app/node_modules`：靠的是第 1 欄，空 volume 會先複製映像裡裝好的套件。
- 映像更新了套件，容器裡的 `node_modules` 卻還是舊的：因為第 2 欄，volume 已經有資料就不會再複製（解法見第六章 6.7 情境三）。
- 把原始碼目錄 bind mount 到 `/var/www/html`，映像裡 `composer install` 裝的 `vendor/` 就不見了：因為第 3 欄。

### `-v` 與 `--mount` 的差別：路徑不存在時

```bash
cd ~/docker-practice

# -v：主機路徑不存在時，Docker 會「自動建立一個目錄」
docker run --rm -v "$PWD/nginx.conf":/etc/nginx/conf.d/default.conf nginx:1.30-alpine
# 錯誤：... not a directory: Are you trying to mount a directory onto a file (or vice-versa)?
ls -ld nginx.conf
# drwxr-xr-x ... nginx.conf      ← 本來想掛檔案，結果主機多了一個叫 nginx.conf 的空目錄
rmdir nginx.conf

# --mount：路徑不存在時直接報錯，不會偷偷建立
docker run --rm --mount type=bind,source="$PWD/nginx.conf",target=/etc/nginx/conf.d/default.conf nginx:1.30-alpine
# 錯誤：invalid mount config for type "bind": bind source path does not exist: ...
```

掛載單一設定檔時，最常見的錯誤就是「打錯路徑或在錯的目錄執行」，結果 `-v` 自動建出一個目錄。看到 `not a directory` 的錯誤，先檢查主機上那個路徑是不是被建成了目錄。Compose 的 `volumes:` 短語法和 `-v` 一樣會自動建立目錄。

### Bind Mount（綁定掛載）

```bash
cd ~/docker-practice
mkdir -p config && echo 'debug=true' > config/app.conf

# 掛載當前目錄到容器的 /app，列出容器內看到的檔案
# "$PWD" 加雙引號：路徑裡有空白時才不會被拆開
docker run --rm -v "$PWD":/app alpine:3.24 ls /app

# 唯讀掛載：容器內讀得到，但寫入會失敗
docker run --rm -v "$PWD/config":/app/config:ro alpine:3.24 \
  sh -c 'cat /app/config/app.conf; touch /app/config/new-file'
# debug=true
# touch: /app/config/new-file: Read-only file system

# 使用 --mount 語法（更明確）
docker run --rm --mount type=bind,source="$PWD",target=/app alpine:3.24 ls /app
```

### tmpfs Mount

```bash
# 掛載到記憶體（容器停止後資料消失），df 可看到 /tmp 是 tmpfs、大小 100M
docker run --rm \
  --tmpfs /tmp:rw,size=100m \
  alpine:3.24 df -h /tmp

# 使用 --mount 語法
docker run --rm \
  --mount type=tmpfs,destination=/tmp,tmpfs-size=100m \
  alpine:3.24 df -h /tmp
# Filesystem      Size  Used Avail Use% Mounted on
# tmpfs         100.0M     0 100.0M   0% /tmp
```

> 備註：這兩個指令是等價寫法，都是把容器內 `/tmp` 掛到記憶體（tmpfs）。
>
> - `--tmpfs /tmp:rw,size=100m`
>   - `/tmp`：容器內掛載目標路徑
>   - `rw`：可讀寫
>   - `size=100m`：tmpfs 容量上限 100MB（超過可能出現 `No space left on device`）
> - `--mount type=tmpfs,destination=/tmp,tmpfs-size=100m`
>   - `type=tmpfs`：指定使用 tmpfs
>   - `destination=/tmp`：容器內掛載目標路徑
>   - `tmpfs-size=100m`：容量上限 100MB
> - `tmpfs` 不需要 `source`，因為它不是主機目錄也不是 named volume，而是直接使用主機記憶體。
> - 選擇建議：臨時手動測試可用 `--tmpfs`；在腳本/正式設定中 `--mount` 通常更清楚。

---

## 5.4 Docker Compose 中的 Volume 設定

```yaml
services:
  db:
    image: postgres:16-alpine
    volumes:
      # 具名 Volume
      - pgdata:/var/lib/postgresql/data

      # Bind Mount：初始化 SQL（只在資料目錄是空的、第一次初始化時執行）
      - ./init:/docker-entrypoint-initdb.d

      # 唯讀的設定檔
      - ./config/postgresql.conf:/etc/postgresql/postgresql.conf:ro
    # 光掛上設定檔，PostgreSQL 不會去讀它；要用 command 指定設定檔路徑
    command: postgres -c config_file=/etc/postgresql/postgresql.conf

  api:
    build: ./backend
    volumes:
      # 開發用：掛載原始碼（hot reload）
      - ./backend/src:/app/src

      # 匿名 Volume：保護容器內的 node_modules
      - /app/node_modules

      # 具名 Volume：日誌持久化
      - api-logs:/app/logs

# Volume 宣告
volumes:
  pgdata:
    # 若省略 driver，Docker Compose 預設就是 local
    driver: local

  api-logs:
    driver: local
    driver_opts:
      # 掛載類型；none 常搭配 bind，表示使用主機既有路徑
      type: none
      # 掛載參數；bind 代表用 bind mount 方式掛載
      o: bind
      # 主機端實際路徑（會被掛載到容器內 /app/logs）
      device: /path/to/logs

  # 其他常見類型範例：NFS（跨主機共享）
  nfs-data:
    driver: local
    driver_opts:
      # 使用 NFS 網路檔案系統
      type: nfs
      # 掛載選項：指定 NFS 伺服器、版本與讀寫模式
      o: addr=10.0.0.10,nfsvers=4,soft,rw
      # NFS 匯出路徑（前面的 : 不可省略）
      device: ":/exports/app-data"

  # 其他常見類型範例：CIFS/SMB（Windows/NAS 共享）
  cifs-data:
    driver: local
    driver_opts:
      # 使用 CIFS（SMB）網路共享
      type: cifs
      # 掛載選項：帳號密碼與檔案權限（正式環境避免明文密碼）
      o: username=${CIFS_USERNAME},password=${CIFS_PASSWORD},rw,uid=1000,gid=1000,file_mode=0644,dir_mode=0755
      # 共享路徑（Windows/NAS）
      device: "//192.168.1.20/shared"

  # 其他常見類型範例：tmpfs（記憶體檔案系統）
  tmpfs-cache:
    driver: local
    driver_opts:
      # 使用 tmpfs，資料存放在 RAM
      type: tmpfs
      # tmpfs 常見 device 寫法
      device: tmpfs
      # 限制容量與權限；容器停止後資料會消失
      o: size=256m,uid=1000,gid=1000,rw

  # 使用外部已存在的 Volume
  shared-data:
    external: true
```

> 備註：這段 `volumes` 宣告在做什麼？
>
> - `pgdata: { driver: local }`
>   - 建立一個由 Docker 管理的具名 Volume（名稱 `pgdata`）。
>   - 對應前面的 `pgdata:/var/lib/postgresql/data`：容器內是 `/var/lib/postgresql/data`，主機端實際位置由 Docker 管理（通常在 `/var/lib/docker/volumes/...`）。
>   - 補充：如果不寫 `driver`，預設也是 `local`，與明確寫出 `driver: local` 的效果相同。
> - `api-logs` 搭配 `driver_opts`
>   - `type: none` + `o: bind` + `device: /path/to/logs` 代表把主機目錄 `/path/to/logs` 綁定進來（本質接近 bind mount）。
>   - 對應前面的 `api-logs:/app/logs`：容器寫入 `/app/logs`，主機會直接看到 `/path/to/logs` 的檔案。
>   - `type` 還可依情境改成 `nfs`、`cifs`、`tmpfs`（需搭配對應的 `o` 參數與 `device` 格式）。
>     - `nfs`：掛載遠端 NFS 共享資料夾，常用在多台主機共享同一份資料（例如多節點讀寫同一目錄）。
>     - `cifs`：掛載 SMB/CIFS（常見於 Windows 檔案分享或 NAS），適合需要和 Windows 生態共享資料的情境。
>     - `tmpfs`：把資料放在記憶體（RAM）中，I/O 快但不持久；容器停止或重啟後資料會消失，適合暫存/快取。
>   - 上方也提供了 `nfs-data`、`cifs-data`、`tmpfs-cache` 三個可直接參考的 `driver_opts` 範例。
>   - `o` 可放 mount options，例如 `ro`（唯讀）、`rw`（可寫）；若是 bind mount 也常見 `bind,ro`。
>   - 實務上 `driver_opts` 參數會依主機 OS 與檔案系統不同而有差異，建議以目標環境先做驗證。
> - `shared-data: { external: true }`
>   - 表示這個 Volume 已在 Docker 外部先建立好，Compose 不會自動建立它。
>   - 常用於多個 Compose 專案共用同一份資料，或避免 `down -v` 時被誤刪。

---

## 5.5 Volume 備份與還原

這一節用一個練習用的 volume 示範，完整流程可以直接照做。

### 準備練習資料

```bash
cd ~/docker-practice
mkdir -p backups

# 建立一個 volume，並寫入兩個檔案當作「要備份的資料」
docker volume create demo-data
docker run --rm -v demo-data:/data alpine:3.24 \
  sh -c 'echo "hello" > /data/a.txt; mkdir -p /data/sub; echo "world" > /data/sub/b.txt'
```

### 備份

```bash
# 備份 Volume 到 tar 檔案
docker run --rm \
  -v demo-data:/source:ro \
  -v "$PWD/backups":/backup \
  alpine:3.24 \
  tar czf /backup/demo-data-backup.tar.gz -C /source .

# 使用日期命名
docker run --rm \
  -v demo-data:/source:ro \
  -v "$PWD/backups":/backup \
  alpine:3.24 \
  tar czf /backup/demo-data-$(date +%Y%m%d).tar.gz -C /source .

ls backups
# demo-data-20261030.tar.gz  demo-data-backup.tar.gz
```

> 備註：備份指令拆解
>
> - `docker run --rm alpine:3.24 ...`：啟動臨時 Alpine 容器來執行備份，完成後自動刪除容器（不留下執行殘骸）。
> - `-v demo-data:/source:ro`：把 Docker Volume `demo-data` 掛到容器內 `/source`，且用唯讀（`ro`）避免備份時誤寫入原資料。
> - `-v "$PWD/backups":/backup`：把主機的 `backups` 目錄掛到容器內 `/backup`，因此備份檔會直接出現在主機上。
> - `tar czf /backup/demo-data-backup.tar.gz -C /source .`：將 `/source` 內容打包成 gzip tar；`-C /source .` 表示切到 `/source` 再把目前目錄所有內容打包。
> - 第二條指令的 `$(date +%Y%m%d)` 是在**主機**的 shell 展開成當天日期（例如 `20261030`），方便做每日備份檔命名與保留多版本。

### 還原

```bash
# 模擬資料遺失：刪掉 volume
docker volume rm demo-data

# 還原到一個新的（空的）volume
docker volume create demo-data
docker run --rm \
  -v demo-data:/target \
  -v "$PWD/backups":/backup:ro \
  alpine:3.24 \
  sh -c "cd /target && tar xzf /backup/demo-data-backup.tar.gz"

# 驗證
docker run --rm -v demo-data:/data alpine:3.24 sh -c 'cat /data/a.txt /data/sub/b.txt'
# hello
# world

# 清理
docker volume rm demo-data
```

> 備註：還原指令拆解
>
> - `-v demo-data:/target`：把要還原的目標 Volume 掛到容器內 `/target`。
> - `-v "$PWD/backups":/backup:ro`：備份檔所在目錄，唯讀（`ro`）避免誤改備份檔。
> - `cd /target && tar xzf ...`：解開 gzip tar 並把內容寫入 volume。
> - 還原到**空的** volume：`tar` 只會新增與覆蓋檔案，不會刪除 volume 裡原本多出來的檔案，還原到舊 volume 會變成新舊資料混在一起。

> ⚠️ **資料庫不要在運作中用 tar 備份資料目錄。** PostgreSQL、MySQL 寫入時會同時改動多個檔案，執行中打包的 tar 可能是「寫到一半」的狀態，還原後資料庫無法啟動或資料不一致。資料庫請用：
>
> - 資料庫自己的匯出工具：`pg_dump`、`mysqldump`（服務不用停，見第十章 10.7）。
> - 或先 `docker compose stop db` 停掉資料庫，再用上面的 tar 方式備份資料目錄，備份完再啟動。

### 在容器之間共享資料

```yaml
services:
  web:
    image: nginx
    volumes:
      - shared-data:/usr/share/nginx/html:ro

  generator:
    build: ./generator
    volumes:
      - shared-data:/output

volumes:
  shared-data:
```

> 備註：這段設定在做什麼？
>
> - `shared-data` 是同一個具名 Volume，被兩個服務同時掛載。
> - `generator` 掛在 `/output`（可寫），負責產生資料。
> - `web` 掛在 `/usr/share/nginx/html:ro`（唯讀），負責讀取並對外提供內容。
> - 兩個容器看到的是同一份底層資料，只是各自掛載路徑不同。
>
> 如何取得/查看分享的資料？
>
> - 在 `web` 容器內看（讀取視角）：
>   - `docker compose exec web ls -al /usr/share/nginx/html`
> - 在 `generator` 容器內看（寫入視角）：
>   - `docker compose exec generator ls -al /output`
> - 不進入既有服務，使用臨時容器讀取 Volume：
>   - `docker run --rm -v shared-data:/data alpine ls -al /data`
>
> 補充：`docker compose exec` vs `docker exec`
>
> - `docker compose exec <service> ...`：用 Compose 的服務名（如 `web`、`generator`）定位容器，適合 Compose 專案。
> - `docker exec <container> ...`：用容器名稱或 ID（如 `myproj-web-1`）定位，適用所有 Docker 容器。
> - 本段示例使用 `docker compose exec`，是因為這裡以 Compose service 為主，通常比記容器實際名稱更穩定。
>
> 若需要在主機直接用檔案總管操作這份資料，通常改用 bind mount 會更直覺；named volume 比較適合由 Docker 管理。

---

## 5.6 實際情境

### 情境一：容器重啟後 IP 改變，服務連線中斷

**問題**：容器 IP 在重啟後改變，硬編碼 IP 的設定失效

```bash
# ❌ 錯誤做法：使用 IP 連線
DB_HOST=172.18.0.3

# ✅ 正確做法：使用容器名稱（需自訂網路）
DB_HOST=db

# 跟著做：建立網路與兩個容器，確認容器的 DNS 解析
docker network create demo-net
docker run -d --name db --network demo-net -e POSTGRES_PASSWORD=secret postgres:16-alpine
docker run -d --name api --network demo-net nginx:1.30-alpine
docker exec api nslookup db
# Server:    127.0.0.11
# Address:   127.0.0.11:53
# Name:      db
# Address:   172.18.0.3

# 重建 db 後 IP 可能改變，但名稱照樣解析得到
docker rm -f db
docker run -d --name db --network demo-net -e POSTGRES_PASSWORD=secret postgres:16-alpine
docker exec api nslookup db

# 清理
docker rm -f api db
docker network rm demo-net
```

> 備註：這段指令在說什麼？
>
> - `DB_HOST=172.18.0.3`：把資料庫位址寫死成某次啟動拿到的 IP；容器重建後 IP 可能改變，應用就連不到。
> - `DB_HOST=db`：改用服務名稱（容器名稱）連線，交給 Docker 內建 DNS 解析，不依賴固定 IP。
> - `docker exec api nslookup db`：進到 `api` 容器裡查詢 `db` 這個名稱是否能被解析，確認服務名稱互連正常。
> - 輸出中的 `Server: 127.0.0.11` 代表 Docker 內建 DNS；`Name: db` + `Address: 172.18.0.3` 代表目前解析到的實際 IP。
> - 重點是「用名稱連線、讓 IP 可變」：即使 `db` 之後變成新 IP，只要名稱不變，應用通常不需改設定。

### 情境二：Volume 資料被意外刪除

**問題**：執行 `docker compose down -v` 時不小心刪除了資料庫 Volume

```bash
# 預防措施：

# 1. 使用 external volume（不會被 docker compose down -v 刪除）
docker volume create pgdata-production
```

```yaml
volumes:
  pgdata:
    external: true
    name: pgdata-production
```

```bash
# 2. 定期備份（備份腳本見第十章 10.7 的 backup.sh）
# 用 crontab -e 加入一行：每天凌晨 2 點執行一次
0 2 * * * /opt/myapp/backup.sh >> /var/log/backup.log 2>&1

# 3. 使用 alias 防止手殘
# alias dcdown='docker compose down'  # 不加 -v
```

### 情境三：開發時 Bind Mount 的效能問題

**問題**：macOS / Windows 上使用 Bind Mount 掛載原始碼，`npm install`、測試、建置都非常慢

原因：Docker Desktop 的容器跑在 Linux VM 裡（見第一章），bind mount 的每一次檔案讀寫都要跨過主機與 VM 的邊界。`node_modules` 這種幾萬個小檔案的目錄最吃虧。

```yaml
services:
  api:
    volumes:
      # 原始碼仍用 bind mount（需要在主機上用編輯器修改）
      - ./backend:/app

      # node_modules 放在 named volume：檔案留在 VM 裡，不用跨邊界同步
      - node_modules:/app/node_modules

volumes:
  node_modules:
```

其他做法：

- **確認 Docker Desktop 使用 VirtioFS**：macOS 的新版 Docker Desktop 預設就是 VirtioFS（Settings → General → Choose file sharing implementation）。舊教學裡的 `:cached`、`:delegated` 掛載選項現在已經沒有作用，不必再加。
- **Windows**：程式碼放在 WSL2 的檔案系統（例如 `~/docker-practice`），不要放在 `/mnt/c/...`（見第一章）。
- **改用 `docker compose watch`**：不用 bind mount，改由 Compose 把變動的檔案同步進容器，見第六章 6.6。

### 情境四：多個 Compose 專案共用同一個資料庫

**問題**：專案 A 和專案 B 需要連到同一個 PostgreSQL 實例

```bash
# 建立獨立的資料庫網路
docker network create shared-db-network

# 建立共用的資料庫 Volume
docker volume create shared-pgdata
```

```yaml
# 專案 A：docker-compose.yml
services:
  api-a:
    build: .
    environment:
      DB_HOST: shared-db
    networks:
      - default
      - shared-db

networks:
  shared-db:
    external: true
    name: shared-db-network
```

```yaml
# 資料庫專用 docker-compose.yml
services:
  shared-db:
    image: postgres:16-alpine
    volumes:
      - shared-pgdata:/var/lib/postgresql/data
    environment:
      POSTGRES_PASSWORD: secret
    networks:
      - shared-db

volumes:
  shared-pgdata:
    external: true

networks:
  shared-db:
    external: true
    name: shared-db-network
```

---

## 5.7 本章小結

- Docker 提供 bridge、host、none、overlay 等網路驅動
- 永遠使用自訂 bridge 網路，而非預設的 bridge 網路（支援 DNS 解析）
- 容器之間用服務名稱連線，不要硬編碼 IP
- 有狀態的資料（資料庫、上傳檔案）務必使用 Named Volume 持久化
- 開發時用 Bind Mount 掛載原始碼，生產時用 Named Volume
- 定期備份 Volume，並且小心使用 `docker compose down -v`

---

> 上一章：[Docker Compose 多容器編排](./04-docker-compose.md) | 下一章：[開發環境實戰案例](./06-dev-environment.md)
