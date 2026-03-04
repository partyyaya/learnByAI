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
# Exited (0)          → 正常退出（行程結束）
# Exited (1)          → 非正常退出（程式錯誤）
# Exited (137)        → 被 OOM Killer 終止（記憶體不足）
# Exited (143)        → 收到 SIGTERM 信號正常停止
# Restarting          → 一直重啟（可能是啟動失敗）
# Created             → 建立了但未啟動
```

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

# 3. Volume 掛載路徑不存在
# Error: invalid mount config
ls -la ./path/to/mount    # 確認路徑存在

# 4. 環境變數缺失
docker compose config    # 檢查最終設定，確認變數有正確帶入

# 5. 健康檢查一直失敗
docker inspect --format='{{json .State.Health}}' my-container | jq
```

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
docker run -it --rm \
  --network myproject_default \
  -v myproject_pgdata:/data \
  alpine sh

# 方法三：從退出的容器建立映像，再進入
docker commit exited-container debug-image
docker run -it --rm debug-image sh

# 方法四：覆蓋 entrypoint
docker run -it --rm --entrypoint sh my-app:latest
```

### 容器內常用除錯指令

```bash
# === 網路除錯 ===
# 安裝除錯工具（Alpine）
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

# 4. 確認 DB 容器正在監聽
docker exec db ss -tlnp | grep 5432

# 5. 檢查防火牆規則
docker exec api iptables -L -n  # 需要 root 權限
```

### 容器無法存取外網

```bash
# 1. 確認 DNS 設定
docker exec my-container cat /etc/resolv.conf

# 2. 測試 DNS 解析
docker exec my-container nslookup google.com

# 3. 測試網路連線
docker exec my-container ping -c 3 8.8.8.8

# 4. 檢查 Docker 的 DNS 設定
docker info | grep "DNS"

# 如果 DNS 有問題，可在 daemon.json 中設定
# /etc/docker/daemon.json
# {
#   "dns": ["8.8.8.8", "8.8.4.4"]
# }
```

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
# Node.js: app.listen(3000, '0.0.0.0')
# Python:  python manage.py runserver 0.0.0.0:8000
# Vite:    vite --host 0.0.0.0
```

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
# 查看容器的退出碼
docker inspect my-container --format='{{.State.ExitCode}}'
# 137 = OOM Killed

# 查看容器的記憶體限制
docker inspect my-container --format='{{.HostConfig.Memory}}'

# 解決方案：增加記憶體限制
docker run -d --memory=1g my-app

# Docker Compose
services:
  api:
    deploy:
      resources:
        limits:
          memory: 1G
```

### 磁碟空間問題

```bash
# 查看 Docker 整體磁碟使用
docker system df -v

# 查看容器的可寫層大小
docker ps -s

# 清理：
# 移除停止的容器
docker container prune

# 移除未使用的映像
docker image prune -a

# 移除未使用的 volume
docker volume prune

# 清理建構快取
docker builder prune

# 一次清理所有未使用的資源
docker system prune -a --volumes
```

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

# 注意優先順序（由高到低）：
# 1. docker compose exec -e KEY=VALUE
# 2. docker-compose.yml 中的 environment
# 3. env_file 指定的檔案
# 4. Dockerfile 中的 ENV
# 5. 專案目錄下的 .env 檔案
```

---

## 8.8 常見錯誤速查表

| 錯誤訊息 | 可能原因 | 解決方案 |
|----------|----------|----------|
| `port is already allocated` | Port 被其他容器或行程佔用 | `lsof -i :PORT` 找出佔用者 |
| `no space left on device` | 磁碟空間不足 | `docker system prune -a` |
| `OCI runtime error` | 容器無法啟動 | 檢查 `docker logs` |
| `name already in use` | 容器名稱重複 | `docker rm old-container` |
| `network not found` | 網路不存在 | `docker network create` |
| `volume not found` | Volume 不存在 | `docker volume create` |
| `permission denied` | 檔案權限問題 | 檢查 USER 與檔案擁有者 |
| `exec format error` | 映像平台不相容 | 用 `--platform` 指定平台 |
| `connection refused` | 服務未啟動或未監聽 | 確認服務綁定 `0.0.0.0` |
| `could not resolve host` | DNS 解析失敗 | 確認容器在同一網路 |
| `COPY failed: file not found` | 檔案不在建構上下文 | 檢查 `.dockerignore` |
| `Exited (137)` | 記憶體不足被 OOM Kill | 增加記憶體限制 |
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

### ctop — 容器即時監控

```bash
# 安裝
# macOS
brew install ctop

# 執行
ctop
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

# 4. 檢查 Nginx error log
docker exec my-frontend cat /var/log/nginx/error.log
```

---

## 8.11 本章小結

- 建立系統性的除錯流程：狀態 → 日誌 → 設定 → 進入容器 → 網路 → 資源
- `docker logs` 和 `docker exec` 是最常用的除錯工具
- 容器間連線用服務名稱，應用程式務必綁定 `0.0.0.0`
- 定期監控容器資源使用，設定合理的記憶體與 CPU 限制
- 善用 lazydocker、dive、ctop 等工具提升除錯效率
- 建構問題先用 `--progress=plain` 查看詳細輸出

---

> 上一章：[Registry 與映像管理](./07-registry-image-mgmt.md) | 下一章：[安全性最佳實踐](./09-security.md)
