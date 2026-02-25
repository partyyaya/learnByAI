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
| `-p` | Port 對映 | `-p 8080:80` |
| `-v` | 掛載 Volume | `-v ./data:/data` |
| `-e` | 環境變數 | `-e KEY=VALUE` |
| `--name` | 容器名稱 | `--name my-app` |
| `-it` | 互動式終端 | `docker run -it ubuntu bash` |
| `--rm` | 停止後自動刪除 | `docker run --rm nginx` |
| `--network` | 指定網路 | `--network my-net` |
| `--restart` | 重啟策略 | `--restart unless-stopped` |
| `-w` | 工作目錄 | `-w /app` |

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
              │   Created    │
              └──────┬──────┘
                     │ docker start
                     ▼
              ┌─────────────┐  docker pause   ┌─────────────┐
              │   Running    │───────────────→ │   Paused     │
              └──┬───┬──────┘ ←───────────────┘─────────────┘
                 │   │         docker unpause
   docker stop   │   │ 行程結束
                 │   │
                 ▼   ▼
              ┌─────────────┐
              │   Stopped    │
              └──────┬──────┘
                     │ docker rm
                     ▼
              ┌─────────────┐
              │   Deleted    │
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
