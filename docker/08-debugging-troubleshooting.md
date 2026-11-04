# 第八章：除錯與問題排查

## 8.1 系統性除錯流程

遇到 Docker 問題時，按照以下流程排查可以快速定位問題：

```
1. 確認容器狀態     → docker ps -a / docker compose ps
2. 查看容器日誌     → docker logs <container>
3. 檢查容器設定     → docker inspect <container>
4. 進入容器除錯     → docker exec -it <container> sh
5. 檢查網路連通性   → ping / curl / nslookup
6. 查看資源使用量   → docker stats
7. 檢查映像與建構   → docker history / docker build --progress=plain
```

---

## 8.2 容器啟動失敗

### 查看容器狀態

```bash
# 列出所有容器（含已停止的）
docker ps -a

# 常見狀態：
# Up 2 hours          → 正常運行
# Up 2 hours (healthy)/(unhealthy) → 有設定 HEALTHCHECK 時的健康狀態
# Exited (0)          → 正常退出（行程結束）
# Exited (1)          → 非正常退出（程式錯誤）
# Exited (137)        → 被 SIGKILL 強制終止（記憶體不足、docker kill、或 docker stop 等太久）
# Exited (143)        → 收到 SIGTERM 後結束
# Restarting          → 一直重啟（可能是啟動失敗）
# Created             → 建立了但未啟動（常見於 port 衝突或找不到執行檔，啟動那一刻就失敗）
```

### Exit Code 對照表

容器的 exit code 就是主行程的結束碼。大於 128 的代表「被訊號終止」，減掉 128 就是訊號編號：

| Exit Code | 意思 | 常見原因 |
|-----------|------|----------|
| 0 | 正常結束 | 一次性任務跑完；或常駐程式以為工作做完了（見第二章情境一） |
| 1 | 程式自己回報錯誤 | 未捕捉的例外、設定錯誤、連不上資料庫 → 看 `docker logs` |
| 125 | Docker 本身執行失敗 | `docker run` 參數錯誤、port 衝突 |
| 126 | 指令找得到但無法執行 | 入口腳本沒有執行權限（`chmod +x`） |
| 127 | 找不到指令 | `CMD` 打錯、映像裡沒有這個程式、alpine 映像裡寫了 `bash` |
| 137 | 128 + 9（SIGKILL） | 記憶體超過上限被 OOM kill；`docker kill`；`docker stop` 等了 10 秒程式還沒結束 |
| 139 | 128 + 11（SIGSEGV） | 程式崩潰（原生模組與平台不合、musl / glibc 不相容） |
| 143 | 128 + 15（SIGTERM） | `docker stop` 送 SIGTERM 後程式結束，通常是正常停止 |

137 不一定是記憶體不足，要看 `OOMKilled` 才能確定：

```bash
# 跟著做：把記憶體上限設成 32MB，故意吃光記憶體
docker run --name oom-demo --memory=32m alpine:3.24 sh -c 'tail /dev/zero'
docker inspect oom-demo --format 'exit={{.State.ExitCode}} oom={{.State.OOMKilled}}'
# exit=137 oom=true      ← 真的是記憶體不足

# 對照：用 docker kill 結束，同樣是 137，但 OOMKilled 是 false
docker run -d --name kill-demo alpine:3.24 sleep 100
docker kill kill-demo
docker inspect kill-demo --format 'exit={{.State.ExitCode}} oom={{.State.OOMKilled}}'
# exit=137 oom=false

docker rm oom-demo kill-demo
```

`OOMKilled=false` 的 137，若是發生在 `docker stop` 或部署時，通常代表程式沒處理 SIGTERM，被等了 10 秒後強制殺掉（第三章 3.2）。

### 查看日誌

```bash
# 查看完整日誌
docker logs my-container

# 即時追蹤日誌
docker logs -f my-container

# 最後 50 行帶時間戳
docker logs --tail 50 -t my-container

# Docker Compose：查看特定服務日誌
# 看 api 目前日誌（一次輸出）
docker compose logs api
# 同時持續追蹤 api 與 db 兩個服務
docker compose logs -f api db

# 查看所有服務的日誌
docker compose logs -f
```

### 常見啟動失敗原因

```bash
# 1. 找不到映像
# Error: No such image: myapp:latest
docker images | grep myapp
docker compose build    # 重新建構

# 2. Port 已被佔用
# Error: port is already allocated
lsof -i :3000
docker ps --filter "publish=3000"

# 3. Volume 掛載路徑不存在，或想掛檔案卻被建成目錄（見第五章 5.3）
# Error: invalid mount config / not a directory
ls -la ./path/to/mount    # 確認路徑存在、而且是檔案還是目錄

# 4. 環境變數缺失
docker compose config    # 檢查最終設定，確認變數有正確帶入

# 5. 健康檢查一直失敗
docker inspect --format='{{json .State.Health}}' my-container | jq
# 常見原因：檢查指令用了映像裡沒有的 curl；網址寫 localhost 解析成 IPv6（見第三章 3.2 HEALTHCHECK）

# 6. 找不到執行檔（exit code 127，容器停在 Created）
# exec: "nodejs": executable file not found in $PATH
# → CMD / ENTRYPOINT 拼錯，或映像裡沒有這個程式（alpine 映像沒有 bash）

# 7. 入口腳本沒有執行權限（exit code 126）
# exec: "/entry.sh": permission denied
# → 主機上先 chmod +x entry.sh 再建構，或在 Dockerfile 加 RUN chmod +x /entry.sh

# 8. 入口腳本「明明存在」卻說找不到
# exec /entry.sh: no such file or directory
# → 腳本是 Windows 換行（CRLF），第一行變成 #!/bin/sh\r，系統找不到 /bin/sh\r 這個直譯器
```

跟著做：重現並修正 CRLF 問題

```bash
mkdir -p ~/docker-practice/crlf-demo && cd ~/docker-practice/crlf-demo

# 故意用 \r\n 換行建立腳本（模擬在 Windows 編輯器存檔）
printf '#!/bin/sh\r\necho hi\r\n' > entry.sh
chmod +x entry.sh
printf 'FROM alpine:3.24\nCOPY entry.sh /entry.sh\nENTRYPOINT ["/entry.sh"]\n' > Dockerfile

docker build -t crlf-demo . && docker run --rm crlf-demo
# exec /entry.sh: no such file or directory

# 檢查：看得到 \r
od -c entry.sh | head -1
# 0000000   #   !   /   b   i   n   /   s   h  \r  \n

# 修正：把 \r 去掉（或在編輯器把換行設成 LF），重新建構
sed -i.bak 's/\r$//' entry.sh && rm entry.sh.bak
docker build -t crlf-demo . && docker run --rm crlf-demo
# hi
```

> 用 Git 管理的專案，可在 `.gitattributes` 加上 `*.sh text eol=lf`，讓 Windows 上 checkout 的 shell 腳本也維持 LF。

---

## 8.3 容器內除錯

### 進入容器

```bash
# 進入運行中的容器
# BusyBox/Alpine 常見 shell
docker exec -it my-container sh
# Debian/Ubuntu 常見 shell
docker exec -it my-container bash
# Alpine 預設 shell 路徑
docker exec -it my-container /bin/ash  # Alpine

# 以 root 身份進入
docker exec -it -u root my-container sh

# Docker Compose
# 進入 api 服務容器（一般權限）
docker compose exec api sh
# 以 root 身份進入 api 服務容器
docker compose exec -u root api sh
```

### 容器已經退出，無法 exec

```bash
# 方法一：用相同映像建立臨時容器
docker run -it --rm my-app:latest sh

# 方法二：用相同的 volume 和網路建立臨時容器
# 網路與 volume 名稱前面有 Compose 的專案名稱（第四章 4.1），用 docker network ls / docker volume ls 確認
docker run -it --rm \
  --network myproject_default \
  -v myproject_pgdata:/data \
  alpine sh

# 方法三：從退出的容器建立映像，再進入（保留了當時的可寫層內容）
docker commit exited-container debug-image
docker run -it --rm --entrypoint sh debug-image

# 方法四：覆蓋 entrypoint（入口腳本本身就是問題所在時特別好用）
docker run -it --rm --entrypoint sh my-app:latest
```

### 映像裡沒有 shell 怎麼除錯

`scratch`、distroless 這類極簡映像裡沒有 `sh`，`docker exec` 進不去。做法是另外啟動一個「有工具的除錯容器」，**共用目標容器的網路與行程 namespace**。除錯容器看到的 `localhost`、行程清單，就和目標容器一樣：

```bash
# 跟著做：使用第三章建立的 hello-go（scratch 映像）
docker run -d --name hello-go -p 8080:8080 hello-go

docker exec -it hello-go sh
# exec: "sh": executable file not found in $PATH

# --network container:hello-go：共用 hello-go 的網路（localhost 就是 hello-go）
# --pid container:hello-go：共用 hello-go 的行程清單
docker run --rm -it \
  --network container:hello-go \
  --pid container:hello-go \
  busybox:1.36 sh

# 在除錯容器內：
ps                                   # 看得到 hello-go 的 /server（PID 1）
wget -qO- http://127.0.0.1:8080      # Hello from Go in a scratch image
netstat -tln                         # :::8080 LISTEN
exit

docker rm -f hello-go
```

- 需要更多網路工具（`dig`、`tcpdump`、`curl`、`iperf`）時，把 `busybox:1.36` 換成 `nicolaka/netshoot`，它是專為網路除錯準備的映像。
- Docker Desktop 另外提供 `docker debug <容器>`，會自動做同樣的事並帶入常用工具。
- Kubernetes 上對應的做法是 `kubectl debug`（第十一章）。

### 容器內常用除錯指令

```bash
# === 網路除錯 ===
# 安裝除錯工具（Alpine；需要 root 身分與對外網路，容器重建後就沒了，只適合臨時排查）
# 非 root 映像可用 docker exec -u root 進去安裝；更好的做法是用上一節的除錯容器
apk add --no-cache curl wget bind-tools netcat-openbsd

# DNS 解析測試
nslookup db
# Server:    127.0.0.11
# Address:   127.0.0.11:53
# Name:      db
# Address:   172.20.0.3

# 測試 port 連通性
nc -zv db 5432
# db (172.20.0.3:5432) open

# 測試 HTTP 連線
curl -v http://api:3000/health

# 查看路由表
ip route

# 查看網路設定
ifconfig  # 或 ip addr

# === 行程除錯 ===
# 查看運行中的行程
ps aux

# 查看 port 使用
netstat -tlnp
# 或
ss -tlnp

# === 檔案系統除錯 ===
# 查看磁碟使用
df -h

# 查看目錄大小
du -sh /app/*

# 查看檔案權限
ls -la /app/

# 查看環境變數
env | sort
```

---

## 8.4 網路問題排查

### 容器間連線失敗

```bash
# 問題：API 容器無法連線 DB 容器

# 1. 確認兩個容器在同一個網路
docker network inspect myproject_default

# 2. 從 API 容器內測試 DNS
docker exec api nslookup db

# 3. 測試 port 連通性
docker exec api nc -zv db 5432

# 4. 確認 DB 容器正在監聽（ss / netstat 不存在時，用上一節的除錯容器共用 db 的網路來查）
docker exec db ss -tlnp | grep 5432
docker run --rm --network container:db busybox:1.36 netstat -tln

# 5. 確認是不是被 internal 網路或網路分層擋住（第四章 4.3 networks）
docker inspect api --format '{{json .NetworkSettings.Networks}}' | jq 'keys'
docker inspect db --format '{{json .NetworkSettings.Networks}}' | jq 'keys'
# 兩邊沒有共同的網路，就連不到
```

### 容器無法存取外網

```bash
# 1. 確認 DNS 設定（自訂網路裡會是 127.0.0.11，由 Docker 轉發給主機的 DNS）
docker exec my-container cat /etc/resolv.conf

# 2. 測試 DNS 解析
docker exec my-container nslookup google.com

# 3. 測試網路連線（用 IP，排除 DNS 因素）
docker exec my-container ping -c 3 8.8.8.8

# 如果 DNS 有問題，可在 daemon 設定中指定 DNS 伺服器
# Linux：/etc/docker/daemon.json；Docker Desktop：Settings → Docker Engine
# {
#   "dns": ["8.8.8.8", "8.8.4.4"]
# }
```

其他常見原因：

- **連上 VPN 後就不通**：VPN 的網段和 Docker 網路的網段重疊（例如都是 `172.17.x.x`），往 VPN 的封包被導進了 Docker 網路。用第五章 5.1 的 `default-address-pools` 把 Docker 改到不衝突的網段。
- **公司網路需要 Proxy**：容器與建構過程都要知道 Proxy。執行期可用 `-e HTTP_PROXY=... -e HTTPS_PROXY=... -e NO_PROXY=localhost,127.0.0.1`；建構期用 `--build-arg HTTP_PROXY=...`；也可以寫在 `~/.docker/config.json` 的 `proxies` 區塊，讓 Docker 自動帶入每個新容器與建構。
- **可以 ping、但 HTTPS 下載卡住**：VPN 環境的 MTU 較小，大封包被丟掉。可在 daemon 設定加 `"mtu": 1400`，或在 Compose 網路設定 `driver_opts: { com.docker.network.driver.mtu: 1400 }`。

### 主機無法連線容器

```bash
# 1. 確認 port 對映
docker port my-container
# 80/tcp -> 0.0.0.0:8080

# 2. 確認容器正在監聽（0.0.0.0，不是 127.0.0.1）
docker exec my-container ss -tlnp
# ✅ 0.0.0.0:3000
# ❌ 127.0.0.1:3000（外部無法連線）

# 3. 解決方案：確保應用綁定 0.0.0.0
# Node.js: app.listen(3000, '0.0.0.0')（不寫 host 也可以，Node 預設綁所有介面）
# Python:  python manage.py runserver 0.0.0.0:8000（Django / Flask 預設只綁 127.0.0.1）
# Vite:    vite --host 0.0.0.0（預設只綁 localhost）
```

> 這是容器化最常遇到的問題之一：程式在主機上跑得好好的，放進容器後連不到。原因是很多開發伺服器預設只聽 `127.0.0.1`，而容器裡的 `127.0.0.1` 只有容器自己連得到，從主機經 `-p` 對映進來的連線是走容器的網卡，不是 loopback。

---

## 8.5 效能問題排查

### 資源監控

```bash
# 即時監控所有容器的資源使用
docker stats

# 輸出範例：
# CONTAINER ID   NAME       CPU %   MEM USAGE / LIMIT   MEM %   NET I/O         BLOCK I/O      PIDS
# a1b2c3d4e5f6   api        2.50%   128MiB / 512MiB     25.00%  1.2MB / 500kB   10MB / 5MB     15
# f6e5d4c3b2a1   db         0.80%   256MiB / 1GiB       25.00%  800kB / 1.5MB   50MB / 30MB    25

# 查看特定容器
docker stats my-container --no-stream

# Docker Compose
docker compose top    # 查看各服務的行程
```

### 記憶體問題

```bash
# 容器被 OOM Kill
# 查看退出碼與 OOMKilled 旗標（137 + true 才是記憶體不足，見 8.2）
docker inspect my-container --format='exit={{.State.ExitCode}} oom={{.State.OOMKilled}}'

# 查看容器的記憶體限制（單位 byte；0 代表沒有限制）
docker inspect my-container --format='{{.HostConfig.Memory}}'

# 解決方案：增加記憶體限制
docker run -d --memory=1g my-app
```

```yaml
# Docker Compose
services:
  api:
    deploy:
      resources:
        limits:
          memory: 1G
```

> 沒設限制也會被 OOM kill：Docker Desktop 的 VM 本身有記憶體上限（Settings → Resources），所有容器加起來超過時，Linux 核心會挑一個行程殺掉。另外 Node.js、Java 這類有自己記憶體管理的執行環境，要讓它的上限比容器限制小一點（例如 Node 的 `--max-old-space-size`、Java 的 `-XX:MaxRAMPercentage`），否則常常是容器先被殺，而不是程式自己回報記憶體不足。

### 磁碟空間問題

```bash
# 查看 Docker 整體磁碟使用
docker system df -v

# 查看容器的可寫層大小（SIZE 欄；容器一直往可寫層寫檔，通常代表該掛 volume 的目錄沒有掛）
docker ps -s

# 清理：
# 移除停止的容器
docker container prune

# 移除未使用的映像
docker image prune -a

# 移除未使用的匿名 volume（加 -a 連具名 volume 也刪，見第一章情境四）
docker volume prune

# 清理建構快取（通常是最大宗）
docker builder prune

# 一次清理未使用的容器、網路、映像、建構快取，以及匿名 volume
# ⚠️ 執行前先 docker ps -a 確認：已停止、之後還要用的容器也會被刪
docker system prune -a --volumes
```

> 另一個常見的磁碟殺手是**容器日誌**：預設的 json-file 日誌沒有大小上限，長期執行、輸出量大的容器，日誌檔可以長到數十 GB。`docker inspect <容器> --format '{{.LogPath}}'` 可以看到日誌檔位置。限制日誌大小的設定見第十章 10.5。

---

## 8.6 建構問題排查

### 建構失敗

```bash
# 查看詳細的建構過程
docker build --progress=plain -t my-app . 2>&1

# 不使用快取（排除快取問題）
docker build --no-cache -t my-app .

# 建構特定階段（Multi-stage Build 除錯）
docker build --target builder -t my-app:builder .
docker run -it --rm my-app:builder sh    # 進入建構階段查看
```

### 常見建構錯誤

```bash
# 1. COPY 找不到檔案
# COPY failed: file not found in build context
# 原因：檔案不在建構上下文中，或被 .dockerignore 排除

# 確認建構上下文
docker build --progress=plain -t my-app .
# 查看 .dockerignore 是否排除了需要的檔案

# 2. RUN 指令失敗
# 常見於 apt-get 找不到套件
# 解決：先執行 apt-get update
RUN apt-get update && apt-get install -y curl

# 3. 權限問題
# 在 RUN 中設定正確的權限
RUN chown -R node:node /app
USER node

# 4. 平台不相容
# 在 M1/M2 Mac 上建構 linux/amd64 映像
docker build --platform linux/amd64 -t my-app .
```

---

## 8.7 Docker Compose 問題排查

### 驗證設定檔

```bash
# 驗證語法並顯示最終設定（包含環境變數替換）
docker compose config

# 只列出服務名稱
# 用來確認 service 名稱拼寫是否正確
docker compose config --services

# 檢查特定服務的設定
# 轉成 JSON 後只看 api 節點，方便精準排查
docker compose config --format json | jq '.services.api'
```

### 服務一直重啟

```bash
# 查看重啟次數
docker inspect my-container --format='{{.RestartCount}}'

# 查看最近的日誌
docker compose logs --tail 50 api

# 暫時停用重啟策略來除錯
docker update --restart no my-container

# 或修改 docker-compose.yml
services:
  api:
    restart: "no"    # 暫時關閉自動重啟
```

### 環境變數沒有生效

```bash
# 確認環境變數的值
docker compose exec api env | sort

# 確認 .env 檔案被正確載入
docker compose config | grep -A5 "environment"

# 容器內的值，優先順序（由高到低）：
# 1. docker compose run -e KEY=VALUE（只影響這次的一次性容器）
# 2. docker-compose.yml 中的 environment
# 3. env_file 指定的檔案
# 4. Dockerfile 中的 ENV
#
# 專案目錄下的 .env 不在這個清單裡：它只用來替換 YAML 裡的 ${VAR}，不會自動進容器（見第四章 4.3）
# ${VAR} 的值又以「執行 docker compose 的 shell 環境變數」優先於 .env
# 所以 shell 裡殘留的 export 會讓 .env 看起來「沒生效」：
env | grep DB_PASSWORD
```

### 用 docker events 看容器發生了什麼事

容器一直重啟、突然消失、健康檢查狀態變來變去時，`docker events` 會依時間列出 Docker 做過的每個動作：

```bash
# 即時觀察（Ctrl+C 結束）；另開終端操作容器就會看到事件
docker events --filter type=container

# 查最近 10 分鐘某個容器的事件
docker events --since 10m --until 0s --filter container=my-container --format '{{.Time}} {{.Action}}'
# 1793341192 start
# 1793341250 health_status: unhealthy
# 1793341260 oom
# 1793341260 die
```

### Docker 本身的日誌

容器的日誌看不出原因，問題可能出在 Docker daemon（例如映像拉取失敗、網路建立失敗、磁碟滿了）：

```bash
# Linux（systemd）
sudo journalctl -u docker.service --since "10 min ago"

# Docker Desktop：Troubleshoot（右上角蟲的圖示）→ 可以看日誌、重啟、恢復原廠設定
# 或在終端機產生診斷包
docker desktop diagnose
```

---

## 8.8 常見錯誤速查表

| 錯誤訊息 | 可能原因 | 解決方案 |
|----------|----------|----------|
| `port is already allocated` | Port 被其他容器或行程佔用 | `docker ps --filter publish=PORT`、`lsof -i :PORT` 找出佔用者 |
| `no space left on device` | 磁碟空間不足（常見是建構快取或容器日誌） | `docker system df` 找出大宗，再針對性清理（8.5） |
| `executable file not found in $PATH` | 指令拼錯或映像裡沒有該程式 | 檢查 `CMD`；alpine 沒有 `bash` |
| `exec ...: no such file or directory`（檔案明明存在） | 腳本是 CRLF 換行 | 換成 LF（8.2） |
| `exec ...: permission denied` | 腳本沒有執行權限 | `chmod +x` |
| `name already in use` | 容器名稱重複 | `docker rm old-container` |
| `network not found` | 網路不存在（external 網路要自己建） | `docker network create` |
| `volume not found` | Volume 不存在（external volume 要自己建） | `docker volume create` |
| `Pool overlaps with other one` | 指定的網段和既有網路重疊 | 換一段沒用到的網段（第五章 5.1） |
| `permission denied`（容器內寫檔） | 執行身分與檔案擁有者不同 | 檢查 USER 與檔案擁有者（第四章 4.7 情境二） |
| `exec format error` | 映像平台不相容（arm64 / amd64） | 用 `--platform` 指定平台建構（第七章 7.6） |
| `connection refused` | 服務未啟動、未監聽，或只綁 127.0.0.1 | 確認服務綁定 `0.0.0.0` |
| `could not resolve host` / `bad address` | DNS 解析失敗 | 確認容器在同一個自訂網路 |
| `COPY failed: file not found` | 檔案不在建構上下文 | 檢查路徑與 `.dockerignore` |
| `toomanyrequests` | Docker Hub 拉取次數超過限制 | `docker login` 後再拉（第一章情境三） |
| `Exited (137)` | SIGKILL：OOM、kill、stop 逾時 | 看 `OOMKilled`（8.2） |
| `Exited (1)` | 程式碼錯誤 | `docker logs` 查看詳細錯誤 |

---

## 8.9 實用除錯工具

### lazydocker — Terminal UI 管理工具

```bash
# 安裝
# macOS
brew install lazydocker

# Linux
curl https://raw.githubusercontent.com/jesseduffield/lazydocker/master/scripts/install_update_linux.sh | bash

# 執行（提供互動式 UI 查看容器、映像、日誌等）
lazydocker
```

### dive — 映像分析工具

```bash
# 安裝
# macOS
brew install dive

# 使用：分析映像每一層的內容
dive my-app:latest

# CI 中使用（檢查映像效率）
dive --ci my-app:latest
```

### docker stats 的自訂輸出

不想安裝額外工具時，`docker stats` 搭配 `--format` 就能做出簡單的監控表：

```bash
# 依需要挑欄位；--no-stream 只輸出一次，拿掉就會持續更新
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.PIDs}}"
```

---

## 8.10 實際情境

### 情境一：容器內的應用連不上資料庫

**問題**：API 啟動後一直報 `ECONNREFUSED 127.0.0.1:5432`

```bash
# 原因：應用程式連線到 127.0.0.1 而不是 db 容器

# 排查步驟：
# 1. 確認環境變數
docker compose exec api env | grep DB
# DB_HOST=db ← 正確
# 但如果應用程式碼預設使用 localhost...

# 2. 確認應用程式碼使用環境變數
# ❌ const host = process.env.DB_HOST || 'localhost'
#    → 如果 DB_HOST 沒設定，就會連 localhost

# ✅ 確保 Docker Compose 中有設定 DB_HOST
services:
  api:
    environment:
      DB_HOST: db     # 這裡的 "db" 是 DB 服務的名稱

# 3. 從容器內測試連線
# 驗證 api 容器是否能連到 db:5432
docker compose exec api nc -zv db 5432
```

### 情境二：Docker 佔用大量 CPU

**問題**：`docker stats` 顯示某個容器 CPU 使用率 100%

```bash
# 1. 找出高 CPU 容器
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}"

# 2. 查看容器內的行程
docker top my-container
# 在容器內看更完整的行程資訊（CPU/MEM/命令）
docker exec my-container ps aux

# 3. 常見原因：
# - 應用程式的無窮迴圈
# - 日誌寫入過於頻繁
# - 健康檢查太頻繁

# 4. 限制 CPU 使用
docker update --cpus 1.0 my-container
```

### 情境三：映像建構成功但容器啟動白屏

**問題**：前端映像建構成功，Nginx 啟動正常，但網頁空白

```bash
# 1. 進入容器檢查建構產物
docker exec my-frontend ls -la /usr/share/nginx/html/
# 如果目錄是空的 → 建構階段的 COPY --from 路徑不正確

# 2. 檢查 Multi-stage Build 的建構階段
docker build --target builder -t my-frontend:builder .
# 直接在 builder 階段確認 /app/dist 是否有前端建構產物
docker run -it --rm my-frontend:builder ls /app/dist
# 確認 dist 目錄確實有內容

# 3. 確認 Nginx 設定中的 root 路徑與 COPY 目標一致
# Dockerfile: COPY --from=builder /app/dist /usr/share/nginx/html
# nginx.conf: root /usr/share/nginx/html;

# 4. 檢查 Nginx 日誌
# 官方 nginx 映像把 access.log / error.log 導到 stdout / stderr，所以直接看 docker logs
# （cat /var/log/nginx/error.log 會因為它其實是指向 /dev/stderr 的連結而卡住或沒有輸出）
docker logs my-frontend

# 5. 用瀏覽器開發者工具的 Network 分頁看 JS / CSS 是否 404
# 若網站不是部署在根路徑（例如 https://example.com/app/），
# Vite 要在 vite.config.js 設定 base: '/app/'，否則打包出的 /assets/... 路徑會對不上
```

---

## 8.11 本章小結

- 建立系統性的除錯流程：狀態 → 日誌 → 設定 → 進入容器 → 網路 → 資源
- `docker logs` 和 `docker exec` 是最常用的除錯工具
- 容器間連線用服務名稱，應用程式務必綁定 `0.0.0.0`
- 定期監控容器資源使用，設定合理的記憶體與 CPU 限制
- exit code 137 要搭配 `OOMKilled` 判斷；127 / 126 / CRLF 是入口指令的三大常見錯誤
- 沒有 shell 的映像，用共用 namespace 的除錯容器（`--network container:` / `--pid container:`）排查
- 善用 `docker events`、lazydocker、dive 等工具提升除錯效率
- 建構問題先用 `--progress=plain` 查看詳細輸出

---

> 上一章：[Registry 與映像管理](./07-registry-image-mgmt.md) | 下一章：[安全性最佳實踐](./09-security.md)
