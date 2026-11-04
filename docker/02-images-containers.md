# 第二章：映像檔與容器基礎操作

## 2.1 映像檔（Image）操作

### 搜尋與拉取映像檔

```bash
# 在 Docker Hub 搜尋映像檔
docker search nginx

# 拉取映像檔（預設標籤為 latest）
docker pull nginx

# 拉取指定版本
docker pull nginx:1.30-alpine
docker pull node:24-alpine
docker pull python:3.12-slim

# 拉取特定平台的映像
# --platform linux/amd64: 指定抓 x86_64 架構映像
# 常見於 Apple Silicon（M 系列晶片）要測試 amd64 相容性時
docker pull --platform linux/amd64 nginx:latest
```

> 同一個標籤（例如 `nginx:1.30-alpine`）底下其實存了多個平台的映像（amd64、arm64…），`docker pull` 會自動挑符合本機 CPU 的那一份。所以在 Apple Silicon 拉到的是 arm64 版、在一般雲端主機拉到的是 amd64 版，名稱卻一樣。

### 映像檔標籤（Tag）命名規則

```
[registry/][namespace/]repository[:tag]

範例：
nginx                          # 官方映像，等同 docker.io/library/nginx:latest
nginx:1.30-alpine              # 指定版本與變體
mycompany/api-server:v1.2.3    # 自訂命名空間
ghcr.io/owner/app:latest       # GitHub Container Registry
```

命名欄位說明：

- `registry`：映像倉庫位址（例如 `docker.io`、`ghcr.io`、`registry.example.com:5000`）
- `namespace`：使用者或組織名稱（例如 Docker Hub 帳號、GitHub org）
- `repository`：專案/服務名稱（例如 `api-server`）
- `tag`：版本或變體（例如 `v1.2.3`、`prod`、`latest`）

是否上傳都要這樣命名？

- **要上傳到遠端 registry 時，實務上要。** 至少要帶上「你有權限的 namespace/repository」。
- 例如你不能直接 `docker push nginx:latest`（那是官方倉庫，通常你沒有寫入權限）。
- Docker Hub 若省略 `registry`，預設就是 `docker.io`。

### 常用 Registry 官網與註冊資訊

| 平台 | 官網 / 文件 | 註冊入口 | 是否可免費註冊 |
|------|-------------|----------|----------------|
| Docker Hub | [https://hub.docker.com/](https://hub.docker.com/) | [https://hub.docker.com/signup](https://hub.docker.com/signup) | 可以（Personal 免費方案） |
| GHCR（GitHub Container Registry） | [https://ghcr.io/](https://ghcr.io/) / [GitHub Packages 文件](https://docs.github.com/packages/working-with-a-github-packages-registry/working-with-the-container-registry) | [https://github.com/signup](https://github.com/signup) | 可以（GitHub 帳號可免費註冊） |

補充：

- Docker Hub 與 GHCR 都可先用免費帳號開始上傳。
- 公開（public）映像通常最容易先免費使用；私有（private）映像的儲存與流量限制會依方案不同。
- 實際配額與費用會變動，以上傳前請以官方方案頁為準：  
  - Docker：`https://www.docker.com/pricing/`  
  - GitHub Packages：`https://docs.github.com/billing/managing-billing-for-github-packages/about-billing-for-github-packages`

### 上傳映像（Push）範例

```bash
# 練習用：先把現成的 nginx 映像另取一個名字 myapp:1.0.0，當作「自己的映像」
# （第三章學會 docker build 後，這裡換成自己建構的映像即可）
docker tag nginx:1.30-alpine myapp:1.0.0

# 確認本地有這個映像
docker images myapp

# 1) 上傳到 Docker Hub
docker login

# 把本地映像改成可推送名稱（<dockerhub_user> 要換成你的帳號）
docker tag myapp:1.0.0 <dockerhub_user>/myapp:1.0.0

# 推送
docker push <dockerhub_user>/myapp:1.0.0
```

```bash
# 2) 上傳到 GHCR（GitHub Container Registry）
# <github_user> / <owner> 請改成你的帳號或組織
# GITHUB_TOKEN：到 GitHub → Settings → Developer settings → Personal access tokens (classic)
#   建立一個勾選 write:packages 的 token，再 export GITHUB_TOKEN=<token>
echo $GITHUB_TOKEN | docker login ghcr.io -u <github_user> --password-stdin

# 重新打 tag（重點是要含 ghcr.io/owner/...）
docker tag myapp:1.0.0 ghcr.io/<owner>/myapp:1.0.0

# 推送
docker push ghcr.io/<owner>/myapp:1.0.0
```

常見錯誤提示：

- `denied: requested access to the resource is denied`：名稱不在你的 namespace，或尚未登入/沒權限。
- `name unknown`：repository 路徑打錯，或 registry 上不存在該路徑。

### 常見映像變體

| 後綴 | 說明 | 適用場景 |
|------|------|----------|
| `latest` | 最新版本（不建議用於生產） | 開發測試 |
| `alpine` | 基於 Alpine Linux，極小（基礎映像約 5-10MB） | 體積優先、相依單純的服務 |
| `slim` | Debian 精簡版，移除不必要的套件 | 一般用途、需要 glibc 相容性時 |
| `bookworm` / `trixie` | 基於特定 Debian 版本 | 需要特定系統套件時 |
| `windowsservercore` | Windows Server Core | Windows 容器 |

> `alpine` 用的 C 函式庫是 musl，不是一般 Linux 的 glibc。大多數程式沒差，但有些預先編譯好的套件（部分 Python wheel、Node 原生模組）沒有 musl 版本，安裝時得從原始碼編譯，反而更慢、更大；少數程式在 DNS 解析、時區、效能上也會有差異。`alpine` 不順時，改用 `slim` 通常就能解決。

### 列出與管理映像檔

```bash
# 列出所有本地映像檔
docker images

# 輸出範例：
# REPOSITORY   TAG          IMAGE ID       CREATED        SIZE
# nginx        1.30-alpine  a8758716bb6a   2 days ago     78MB
# node         24-alpine    1a2b3c4d5e6f   1 week ago     160MB
# python       3.12-slim    7a8b9c0d1e2f   3 days ago     125MB
# （SIZE 依平台與版本不同，數字僅供參考）

# 依名稱過濾
docker images nginx

# 查看映像的詳細資訊
docker inspect nginx:1.30-alpine

# 查看映像的層級歷史（每一行是一層，SIZE 為 0B 的是只改設定、不含檔案的層）
docker history nginx:1.30-alpine

# 標記映像（建立別名）
docker tag nginx:1.30-alpine myregistry.com/nginx:v1.0
# 若想確認「兩個名字是不是同一份映像」，看 IMAGE ID 是否一樣
docker images --format "table {{.Repository}}\t{{.Tag}}\t{{.ID}}"

# 刪除映像（只刪這個名字；同一份映像若還有別的名字，檔案不會真的被刪）
docker rmi myregistry.com/nginx:v1.0

# 強制刪除（有容器使用中時，-f 只會拿掉名字，映像本體要等容器刪掉才會釋放）
docker rmi -f myapp:1.0.0

# 刪除懸空映像（dangling：沒有名字、顯示為 <none> 的舊版本映像）
docker image prune

# 刪除所有未被容器使用的映像
docker image prune -a
```

---

## 2.2 容器（Container）操作

### 建立與啟動容器

以下指令可以由上往下依序貼上執行（在 `~/docker-practice` 底下操作）：

```bash
# 基本運行（前景模式）：終端會被佔住並顯示 nginx 的日誌，按 Ctrl+C 結束
docker run nginx:1.30-alpine

# 背景模式運行（-d = detached）：印出容器 ID 後立刻回到提示字元
docker run -d nginx:1.30-alpine

# 指定容器名稱 + Port 對映（主機 8080 → 容器 80）
docker run -d --name my-nginx -p 8080:80 nginx:1.30-alpine
curl -I http://localhost:8080     # 看到 HTTP/1.1 200 OK 代表連得到

# 容器名稱不能重複：再跑一次同名容器會出現 Conflict. The container name "/my-nginx" is already in use
# 先刪掉再重建（-f：運行中也直接刪）
docker rm -f my-nginx

# 多個 port 對映
docker run -d --name my-nginx -p 8080:80 -p 8443:443 nginx:1.30-alpine
docker rm -f my-nginx

# 只綁定本機介面 127.0.0.1：只有這台電腦連得到，同網段的其他電腦連不到
docker run -d --name my-nginx -p 127.0.0.1:8080:80 nginx:1.30-alpine
docker rm -f my-nginx

# 設定環境變數：用 alpine 的 env 指令直接印出容器內看到的變數
docker run --rm -e APP_ENV=production -e API_URL=https://api.example.com alpine:3.24 env

# 使用環境變數檔案（每行一個 KEY=VALUE）
printf 'APP_ENV=development\nLOG_LEVEL=debug\n' > app.env
docker run --rm --env-file app.env alpine:3.24 env

# 實際用途：啟動 MySQL 時用環境變數設定 root 密碼與預設資料庫
docker run -d \
  -e MYSQL_ROOT_PASSWORD=secret \
  -e MYSQL_DATABASE=myapp \
  --name my-mysql \
  mysql:8.4
# MySQL 第一次啟動要初始化約 15～30 秒，等日誌出現 port: 3306 才算就緒
until docker logs my-mysql 2>&1 | grep -q 'port: 3306'; do sleep 2; done
docker exec my-mysql mysql -uroot -psecret -e "SHOW DATABASES;"   # 看得到 myapp
docker rm -f my-mysql

# 掛載目錄（Bind Mount）：把主機的 html 目錄掛成 nginx 的網站根目錄
mkdir -p html && echo '<h1>Hello from host</h1>' > html/index.html
docker run -d --name my-nginx -p 8080:80 \
  -v "$PWD/html":/usr/share/nginx/html:ro \
  nginx:1.30-alpine
curl http://localhost:8080        # <h1>Hello from host</h1>
echo '<h1>Changed on host</h1>' > html/index.html
curl http://localhost:8080        # 不用重啟容器，立刻看到新內容
docker rm -f my-nginx

# 限制資源使用：最多 512MB 記憶體、1.5 顆 CPU
docker run -d \
  --memory=512m \
  --cpus=1.5 \
  --name my-limited \
  nginx:1.30-alpine
docker stats --no-stream my-limited   # MEM USAGE / LIMIT 欄位的上限會是 512MiB
docker rm -f my-limited

# 容器停止時自動刪除（--rm），並開一個互動式 shell；輸入 exit 離開後容器就消失
docker run --rm -it ubuntu:24.04 bash
```

> `-p 8080:80` 沒寫 IP 時，等於 `-p 0.0.0.0:8080:80`：主機上**所有**網路介面都會開放 8080，同一個 Wi-Fi 或區網的人都連得到。在 Linux 上，Docker 自己寫的防火牆規則還會繞過 ufw / firewalld，所以「主機防火牆有擋」並不代表安全。資料庫、Redis 這類只給自己用的服務，開發時建議一律寫成 `-p 127.0.0.1:5432:5432`。

### docker run 常用參數速查

| 參數 | 說明 | 範例 |
|------|------|------|
| `-d` | 背景執行 | `docker run -d nginx` |
| `-p` | Port 映射（格式：`主機埠:容器埠`） | `-p 8080:80`（用 `localhost:8080` 連到容器 `80`） |
| `-v` | 掛載資料（格式：`主機路徑:容器路徑[:模式]`） | `-v ./data:/data:ro`（主機 `./data` 掛到容器 `/data`，且唯讀） |
| `-e` | 設定容器啟動時的環境變數（常用於 DB 帳密、API URL、執行模式） | `-e APP_ENV=prod -e API_URL=https://api.example.com` |
| `--name` | 容器名稱 | `--name my-app` |
| `-it` | 互動式終端 | `docker run -it ubuntu bash` |
| `--rm` | 停止後自動刪除 | `docker run --rm nginx` |
| `--network` | 指定網路 | `--network my-net` |
| `--restart` | 重啟策略 | `--restart unless-stopped` |
| `-w` | 工作目錄 | `-w /app` |

`-e` 什麼時候會用到？

- 容器啟動時要帶入設定值（例如 `APP_ENV=production`、`API_URL=...`）。
- 啟動資料庫或應用時要傳密碼/帳號（例如 MySQL 的 `MYSQL_ROOT_PASSWORD`）。
- 變數很多時，建議改用 `--env-file .env` 管理。

`-it` 參數拆解：

- `-i`（interactive）：保持 STDIN 開啟，讓你可以持續輸入指令。
- `-t`（tty）：分配虛擬終端機，讓 shell 互動畫面（提示字元、換行）正常顯示。
- 實務上常一起用成 `-it`，例如 `docker run -it ubuntu bash`。

### 管理容器

```bash
# 先啟動一個練習用的容器（之後的指令都對它操作）
docker run -d --name my-nginx -p 8080:80 nginx:1.30-alpine

# 列出運行中的容器
docker ps

# 列出所有容器（含已停止）
docker ps -a

# 輸出範例：
# CONTAINER ID   IMAGE               COMMAND                  STATUS          PORTS                  NAMES
# a1b2c3d4e5f6   nginx:1.30-alpine   "/docker-entrypoint.…"   Up 2 minutes    0.0.0.0:8080->80/tcp   my-nginx
# f6e5d4c3b2a1   nginx:1.30-alpine   "/docker-entrypoint.…"   Up 10 minutes   80/tcp                 hopeful_morse

# 停止容器
docker stop my-nginx

# 如果 run 時沒設定 --name，Docker 會自動取一個名字（例如上面的 hopeful_morse）
# 這時可用自動名稱或 CONTAINER ID（打前幾碼就夠，不重複即可）停止
docker ps
# docker stop <CONTAINER ID>
# docker stop <自動名稱>

# 只列出 ID（-q），可搭配其他指令批次操作；例如停止所有運行中的容器：
# docker stop $(docker ps -q)

# 啟動已停止的容器
docker start my-nginx

# 重新啟動容器
docker restart my-nginx

# 暫停 / 恢復容器
docker pause my-nginx
docker unpause my-nginx

# 刪除容器：運行中的容器不能直接 rm，要先 stop
docker stop my-nginx
docker rm my-nginx

# 或強制刪除運行中的容器（等於 kill + rm）
docker run -d --name my-nginx -p 8080:80 nginx:1.30-alpine
docker rm -f my-nginx

# 刪除所有「已停止」的容器
# 前面 docker run -d nginx:1.30-alpine 產生的無名容器還在運行，要先用 docker ps 找到名字、docker stop 停掉才會被清
docker container prune
```

`docker stop` 與 `docker kill` 的差別：

- `docker stop`：先送 `SIGTERM` 給容器內的主行程，讓程式有機會收尾（關連線、寫完資料），預設等 10 秒還沒結束才送 `SIGKILL` 強制終止。等待秒數可用 `docker stop -t 30 <容器>` 調整。
- `docker kill`：直接送 `SIGKILL`，程式沒有機會收尾。

如果你發現某個容器每次 `docker stop` 都要等滿 10 秒，通常代表程式沒有處理 `SIGTERM`，最後是被強制殺掉的。第三章 3.2 會實際示範原因與修法。

### 與容器互動

```bash
# 重新建立練習用容器（上一段已經把 my-nginx 刪掉了）
docker run -d --name my-nginx -p 8080:80 nginx:1.30-alpine

# 進入運行中的容器（開啟 shell）
# alpine 系列映像只有 sh，沒有 bash；Debian / Ubuntu 系列（例如 nginx:1.30、python:3.12-slim）才有 bash
docker exec -it my-nginx sh

# 執行單一指令
docker exec my-nginx cat /etc/nginx/nginx.conf

# 以 root 身份進入容器
docker exec -it -u root my-nginx sh

# 查看容器日誌
docker logs my-nginx

# 即時追蹤日誌（類似 tail -f）
docker logs -f my-nginx

# 只看最後 100 行
docker logs --tail 100 my-nginx

# 查看帶時間戳的日誌
docker logs -t my-nginx

# 查看容器資源使用情況
docker stats

# 查看特定容器資源使用
docker stats my-nginx

# 查看容器的詳細資訊
docker inspect my-nginx

# 查看容器的 port 對映
docker port my-nginx

# 從容器複製檔案到主機
docker cp my-nginx:/etc/nginx/nginx.conf ./nginx.conf

# 從主機複製檔案到容器（用前面建立的 html/index.html）
docker cp ./html/index.html my-nginx:/usr/share/nginx/html/
curl http://localhost:8080

# 練習結束，刪除容器
docker rm -f my-nginx
```

---

## 2.3 容器的生命週期

```
                docker create
                     │
                     ▼
              ┌─────────────┐
              │   Created   │
              └──────┬──────┘
                     │ docker start
                     ▼
              ┌─────────────┐  docker pause   ┌─────────────┐
              │   Running   │───────────────→ │   Paused    │
              └──┬───┬──────┘ ←───────────────┘─────────────┘
                 │   │         docker unpause
   docker stop   │   │ 行程結束
                 │   │
                 ▼   ▼
              ┌─────────────┐
              │   Stopped   │
              └──────┬──────┘
                     │ docker rm
                     ▼
              ┌─────────────┐
              │   Deleted   │
              └─────────────┘
```

### 重啟策略

```bash
# no：不自動重啟（預設）
docker run -d --restart no nginx

# on-failure：行程非正常退出時重啟（可指定次數）
docker run -d --restart on-failure:5 nginx

# always：總是重啟（Docker 重啟後也會自動啟動）
docker run -d --restart always nginx

# unless-stopped：除非手動停止，否則總是重啟
docker run -d --restart unless-stopped nginx
```

`always` 與 `unless-stopped` 的差別只在「手動 `docker stop` 之後，Docker daemon 重啟（例如主機重開機）」這個時間點：`always` 會把容器重新拉起來，`unless-stopped` 會尊重你先前的手動停止。手動 `docker stop` 當下，兩者都不會立刻把容器重啟。

---

## 2.4 映像層與容器可寫層

這一節解釋「為什麼容器刪掉後資料就不見」，也是第三章 Dockerfile 最佳化與第五章 Volume 的基礎。

### 映像由多個唯讀層組成

```bash
# 每一行是一層；有檔案變動的層才有大小，ENV / CMD 這類只改設定的層是 0B
docker history nginx:1.30-alpine
```

容器啟動時，Docker 會在映像的唯讀層上面再疊一層**可寫層**，容器內所有的新增、修改、刪除都只寫在這一層：

```
┌──────────────────────────────┐
│ 容器可寫層（每個容器各一份）    │  ← 容器內的寫入都在這裡；容器刪掉就跟著消失
├──────────────────────────────┤
│ 映像層 3：COPY 程式碼（唯讀）   │
│ 映像層 2：RUN 安裝套件（唯讀）  │  ← 同一個映像的多個容器共用這些層
│ 映像層 1：基礎映像（唯讀）      │
└──────────────────────────────┘
```

- 修改映像裡原本就有的檔案時，Docker 先把檔案複製到可寫層再改（copy-on-write），原本的映像層不會變。
- 刪除映像裡的檔案，也只是在可寫層記一筆「這個檔案被刪了」，映像層裡的檔案還在。

### 跟著做：看見可寫層

```bash
# 在容器裡新增檔案、刪掉一個映像內的檔案、安裝一個套件
docker run --name layer-demo alpine:3.24 \
  sh -c 'echo hello > /hello.txt; rm /etc/motd; apk add -q --no-cache curl'

# docker diff 列出這個容器的可寫層和映像相比有哪些變動
# A = 新增（Added）、C = 變更（Changed）、D = 刪除（Deleted）
docker diff layer-demo
# C /etc
# D /etc/motd
# A /hello.txt
# ...

# 從同一個映像啟動新容器：新容器有自己全新的可寫層，看不到剛才的 /hello.txt
docker run --rm alpine:3.24 ls /hello.txt
# ls: /hello.txt: No such file or directory

# 刪除容器，可寫層跟著消失
docker rm layer-demo
```

這就是「容器的檔案系統是暫時的」的真正意思：資料寫在容器的可寫層，容器一刪就沒了。要讓資料活得比容器久，就要把那個目錄掛載到 Volume（見情境三與第五章）。

---

## 2.5 實際情境

### 情境一：容器啟動後立刻退出

**問題**：`docker run -d ubuntu:24.04` 後，容器立刻變成 Exited 狀態

```bash
# 查看容器狀態
docker ps -a
# STATUS: Exited (0) 2 seconds ago

# 原因：ubuntu 映像的預設指令是 bash，背景模式沒有終端可互動，bash 讀不到輸入就結束了
# Docker 容器在主行程（前景行程）結束後就會自動退出

# 解決方案一：指定一個持續運行的指令
docker run -d ubuntu:24.04 sleep infinity

# 解決方案二：使用互動式模式
docker run -it ubuntu:24.04 bash

# 解決方案三：使用 tail 保持運行（常見於除錯）
docker run -d ubuntu:24.04 tail -f /dev/null
```

> 正式的服務（nginx、資料庫、你的 API）本來就會一直在前景執行，不需要這些技巧；這些只適合臨時拿容器當工具環境使用。

### 情境二：container port 衝突

**問題**：`docker run -p 8080:80 nginx:1.30-alpine` 報錯 `port is already allocated`（或 `address already in use`）

```bash
# 重現：先佔用 8080，再啟動第二個要用 8080 的容器
docker run -d --name web-a -p 8080:80 nginx:1.30-alpine
docker run -d --name web-b -p 8080:80 nginx:1.30-alpine   # 報錯；web-b 會留下一個 Created 狀態的容器

# 找出佔用該 port 的是哪個容器
docker ps --filter "publish=8080"
# 若不是容器佔用，找主機上的行程（macOS / Linux）
lsof -i :8080

# 解決方案一：使用其他 port
docker rm web-b
docker run -d --name web-b -p 8081:80 nginx:1.30-alpine

# 解決方案二：停止佔用 port 的容器
docker rm -f web-b
docker stop web-a
docker run -d --name web-b -p 8080:80 nginx:1.30-alpine

# 解決方案三：讓 Docker 隨機分配主機 port
docker run -d --name web-c -p 80 nginx:1.30-alpine
docker port web-c
# 80/tcp -> 0.0.0.0:32768

# 清理
docker rm -f web-a web-b web-c
```

### 情境三：容器內的資料在重啟後消失

**問題**：MySQL 容器重建後，資料庫資料全部遺失

```bash
# 原因：資料寫在容器的可寫層（見 2.4），容器刪除後資料就消失

# 解決方案：把 MySQL 的資料目錄 /var/lib/mysql 掛到名為 mysql-data 的 Volume
docker run -d \
  -v mysql-data:/var/lib/mysql \
  -e MYSQL_ROOT_PASSWORD=secret \
  --name my-mysql \
  mysql:8.4

# 等 MySQL 就緒後建立一個資料庫
until docker logs my-mysql 2>&1 | grep -q 'port: 3306'; do sleep 2; done
docker exec my-mysql mysql -uroot -psecret -e "CREATE DATABASE demo;"

# 刪除容器，再用同一個 volume 重建
docker rm -f my-mysql
docker run -d \
  -v mysql-data:/var/lib/mysql \
  -e MYSQL_ROOT_PASSWORD=secret \
  --name my-mysql \
  mysql:8.4

# 資料仍然存在：清單裡看得到 demo
until docker logs my-mysql 2>&1 | grep -q 'port: 3306'; do sleep 2; done
docker exec my-mysql mysql -uroot -psecret -e "SHOW DATABASES;"

# 清理（volume 要另外刪，docker rm 不會刪 volume）
docker rm -f my-mysql
docker volume rm mysql-data
```

> 第二次啟動時，MySQL 看到 `/var/lib/mysql` 已經有資料，就會跳過初始化，`MYSQL_ROOT_PASSWORD` 這類初始化用的環境變數也不再生效。想換 root 密碼得進資料庫用 SQL 改，而不是改環境變數。

### 情境四：容器時區不正確

**問題**：容器內的時間顯示為 UTC，而非本地時區

```bash
# 查看容器時區：預設是 UTC
docker run --rm alpine:3.24 date
# Fri Oct 30 04:00:00 UTC 2026

# 解決方案一：透過環境變數 TZ 設定
# TZ 要靠映像裡的時區資料庫（tzdata）才查得到「Asia/Taipei」是幾點
# Debian 系列（例如 python:3.12-slim）已內建 tzdata，設 TZ 就生效
docker run --rm -e TZ=Asia/Taipei python:3.12-slim date
# Fri Oct 30 12:00:00 CST 2026

# alpine 系列（含 node:24-alpine）預設沒有 tzdata，只設 TZ 仍然是 UTC
docker run --rm -e TZ=Asia/Taipei alpine:3.24 date
# Fri Oct 30 04:00:00 UTC 2026

# 裝上 tzdata 後才生效（自己的映像請在 Dockerfile 加 RUN apk add --no-cache tzdata）
docker run --rm -e TZ=Asia/Taipei alpine:3.24 sh -c 'apk add -q --no-cache tzdata && date'
# Fri Oct 30 12:00:00 CST 2026

# 解決方案二：掛載主機時區檔案（只適用 Linux 主機；macOS / Windows 的 Docker Desktop 不適用）
docker run --rm \
  -v /etc/localtime:/etc/localtime:ro \
  alpine:3.24 date
```

> 資料庫與後端服務的時間，實務上常常刻意維持 UTC，只在顯示給使用者時才轉換時區，避免跨時區部署時資料混亂。是否要改時區，先和團隊確認慣例。

---

## 2.6 本章小結

- 映像檔是唯讀模板，容器是映像檔的運行實例；容器的寫入都在可寫層，容器刪除就消失
- 選擇映像時優先考慮 `slim` 或 `alpine` 變體，`alpine` 遇到相容性問題時改用 `slim`
- `docker run` 是最常用的指令，熟記 `-d`、`-p`、`-v`、`-e` 等參數；只給自己用的服務綁 `127.0.0.1`
- 容器內的資料是暫時的，需要持久化的資料務必使用 Volume
- 善用 `docker logs`、`docker exec`、`docker inspect`、`docker diff` 來除錯

---

> 上一章：[Docker 簡介與安裝](./01-introduction.md) | 下一章：[Dockerfile 撰寫與映像建構](./03-dockerfile.md)
