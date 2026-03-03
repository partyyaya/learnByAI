# 第二章：映像檔與容器基礎操作

## 2.1 映像檔（Image）操作

### 搜尋與拉取映像檔

```bash
# 在 Docker Hub 搜尋映像檔
docker search nginx

# 拉取映像檔（預設標籤為 latest）
docker pull nginx

# 拉取指定版本
docker pull nginx:1.25
docker pull node:20-alpine
docker pull python:3.12-slim

# 拉取特定平台的映像
# --platform linux/amd64: 指定抓 x86_64 架構映像
# 常見於 Apple Silicon（M1/M2）要測試 amd64 相容性時
docker pull --platform linux/amd64 nginx:latest
```

### 映像檔標籤（Tag）命名規則

```
[registry/][namespace/]repository[:tag]

範例：
nginx                          # 官方映像，等同 docker.io/library/nginx:latest
nginx:1.25-alpine              # 指定版本與變體
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
# 先確認本地有這個映像
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
| `alpine` | 基於 Alpine Linux，極小 | 生產環境（約 5-10MB 基礎映像） |
| `slim` | 精簡版，移除不必要的套件 | 一般用途 |
| `bullseye` / `bookworm` | 基於特定 Debian 版本 | 需要特定系統套件時 |
| `windowsservercore` | Windows Server Core | Windows 容器 |

### 列出與管理映像檔

```bash
# 列出所有本地映像檔
docker images

# 輸出範例：
# REPOSITORY   TAG        IMAGE ID       CREATED        SIZE
# nginx        latest     a8758716bb6a   2 days ago     187MB
# node         20-alpine  1a2b3c4d5e6f   1 week ago     130MB
# python       3.12-slim  7a8b9c0d1e2f   3 days ago     125MB

# 依名稱過濾
docker images nginx

# 查看映像的詳細資訊
docker inspect nginx:latest

# 查看映像的層級歷史
docker history nginx:latest

# 標記映像（建立別名）
docker tag nginx:latest myregistry.com/nginx:v1.0
# 若想確認「兩個名字是不是同一份映像」，看 IMAGE ID 是否一樣
docker images --format "table {{.Repository}}\t{{.Tag}}\t{{.ID}}"

# 刪除映像
docker rmi nginx:latest

# 強制刪除（即使有容器使用中）
docker rmi -f nginx:latest

# 刪除所有未使用的映像（dangling images）
docker image prune

# 刪除所有未被容器使用的映像
docker image prune -a
```

---

## 2.2 容器（Container）操作

### 建立與啟動容器

```bash
# 基本運行（前景模式）
docker run nginx

# 背景模式運行（-d = detached）
docker run -d nginx

# 指定容器名稱
docker run -d --name my-nginx nginx

# Port 對映（主機:容器）
docker run -d -p 8080:80 --name my-nginx nginx

# 多個 port 對映
docker run -d -p 8080:80 -p 8443:443 --name my-nginx nginx

# 設定環境變數
docker run -d \
  -e MYSQL_ROOT_PASSWORD=secret \
  -e MYSQL_DATABASE=myapp \
  --name my-mysql \
  mysql:8.0

# 使用環境變數檔案
docker run -d --env-file .env --name my-app myapp:latest

# 掛載目錄（Bind Mount）
docker run -d \
  -v /path/on/host:/path/in/container \
  --name my-nginx \
  nginx

# 限制資源使用
docker run -d \
  --memory=512m \
  --cpus=1.5 \
  --name my-app \
  myapp:latest

# 容器停止時自動刪除
docker run --rm -it ubuntu:22.04 bash
```

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
# 列出運行中的容器
docker ps

# 列出所有容器（含已停止）
docker ps -a

# 輸出範例：
# CONTAINER ID   IMAGE   COMMAND                  STATUS         PORTS                  NAMES
# a1b2c3d4e5f6   nginx   "/docker-entrypoint.…"   Up 2 hours     0.0.0.0:8080->80/tcp   my-nginx
# f6e5d4c3b2a1   mysql   "docker-entrypoint.s…"   Up 30 minutes  3306/tcp               my-mysql

# 停止容器
docker stop my-nginx

# 如果 run 時沒設定 --name，可用 CONTAINER ID 停止
docker stop a1b2c3d4e5f6

# 先查目前容器的 ID / 自動名稱，再停止（擇一使用）
docker ps
# docker stop <CONTAINER ID>
# docker stop <自動名稱（例如 hopeful_morse）>

# 啟動已停止的容器
docker start my-nginx

# 重新啟動容器
docker restart my-nginx

# 暫停 / 恢復容器
docker pause my-nginx
docker unpause my-nginx

# 刪除已停止的容器
docker rm my-nginx

# 強制刪除運行中的容器
docker rm -f my-nginx

# 刪除所有已停止的容器
docker container prune
```

### 與容器互動

```bash
# 進入運行中的容器（開啟 bash shell）
docker exec -it my-nginx bash

# 執行單一指令
docker exec my-nginx cat /etc/nginx/nginx.conf

# 以 root 身份進入容器
docker exec -it -u root my-nginx bash

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

# 從主機複製檔案到容器
docker cp ./index.html my-nginx:/usr/share/nginx/html/
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

---

## 2.4 實際情境

### 情境一：容器啟動後立刻退出

**問題**：`docker run -d ubuntu` 後，容器立刻變成 Exited 狀態

```bash
# 查看容器狀態
docker ps -a
# STATUS: Exited (0) 2 seconds ago

# 原因：容器內沒有持續運行的前景行程
# Docker 容器在前景行程結束後就會自動退出

# 解決方案一：指定一個持續運行的指令
docker run -d ubuntu sleep infinity

# 解決方案二：使用互動式模式
docker run -it ubuntu bash

# 解決方案三：使用 tail 保持運行（常見於除錯）
docker run -d ubuntu tail -f /dev/null
```

### 情境二：container port 衝突

**問題**：`docker run -p 8080:80 nginx` 報錯 `port is already allocated`

```bash
# 找出佔用該 port 的行程
lsof -i :8080
# 或
docker ps --filter "publish=8080"

# 解決方案一：使用其他 port
docker run -d -p 8081:80 --name my-nginx nginx

# 解決方案二：停止佔用 port 的容器
docker stop <container_id>
docker run -d -p 8080:80 --name my-nginx nginx

# 解決方案三：讓 Docker 隨機分配主機 port
docker run -d -p 80 --name my-nginx nginx
docker port my-nginx
# 80/tcp -> 0.0.0.0:32768
```

### 情境三：容器內的資料在重啟後消失

**問題**：MySQL 容器重建後，資料庫資料全部遺失

```bash
# 原因：容器的檔案系統是暫時的，容器刪除後資料就消失

# 解決方案：使用 Volume 持久化資料
docker run -d \
  -v mysql-data:/var/lib/mysql \
  -e MYSQL_ROOT_PASSWORD=secret \
  --name my-mysql \
  mysql:8.0

# 即使容器被刪除重建，只要使用同一個 volume，資料就不會遺失
docker rm -f my-mysql
docker run -d \
  -v mysql-data:/var/lib/mysql \
  -e MYSQL_ROOT_PASSWORD=secret \
  --name my-mysql \
  mysql:8.0
# 資料仍然存在！
```

### 情境四：容器時區不正確

**問題**：容器內的時間顯示為 UTC，而非本地時區

```bash
# 查看容器時區
docker exec my-app date
# Fri Feb  6 08:00:00 UTC 2026

# 解決方案一：透過環境變數設定
docker run -d -e TZ=Asia/Taipei --name my-app myapp:latest

# 解決方案二：掛載主機時區檔案
docker run -d \
  -v /etc/localtime:/etc/localtime:ro \
  -v /etc/timezone:/etc/timezone:ro \
  --name my-app \
  myapp:latest
```

---

## 2.5 本章小結

- 映像檔是唯讀模板，容器是映像檔的運行實例
- 選擇映像時，生產環境優先使用 `alpine` 或 `slim` 變體
- `docker run` 是最常用的指令，熟記 `-d`、`-p`、`-v`、`-e` 等參數
- 容器內的資料是暫時的，需要持久化的資料務必使用 Volume
- 善用 `docker logs`、`docker exec`、`docker inspect` 來除錯

---

> 上一章：[Docker 簡介與安裝](./01-introduction.md) | 下一章：[Dockerfile 撰寫與映像建構](./03-dockerfile.md)
