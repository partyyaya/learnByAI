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
```

### 自訂 Bridge 網路（推薦）

```bash
# 建立自訂網路
docker network create my-network

# 指定子網路
docker network create --subnet=172.20.0.0/16 my-network

# 在自訂網路中啟動容器
# 啟動 API 並加入 my-network
docker run -d --name api --network my-network my-api
# 啟動 PostgreSQL 並加入同一網路（讓 api 可用服務名連線）
docker run -d --name db --network my-network postgres:16

# 自訂 bridge 網路的優勢：
# ✅ 支援 DNS 自動解析（用容器名稱互連）
# ✅ 更好的隔離性
# ✅ 容器可以動態加入/離開網路
```

```bash
# 容器之間用名稱連線
docker exec api ping db
# PING db (172.20.0.3): 56 data bytes
# 64 bytes from 172.20.0.3: seq=0 ttl=64 time=0.123 ms

# 在應用程式中使用服務名稱
# DB_HOST=db（不是 IP 位址）
```

### Host 網路

```bash
# 容器直接使用主機的網路
docker run -d --network host --name my-nginx nginx

# 特點：
# - 沒有 port 對映，容器直接綁定主機 port
# - 效能最好（沒有 NAT 開銷）
# - 只在 Linux 上完整支援
# - 容器間沒有網路隔離
```

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

---

## 5.3 資料持久化

容器的檔案系統是暫時的——容器刪除後，所有修改的資料都會消失。Docker 提供三種方式來持久化資料。

### 三種掛載方式比較

```
┌─────────────────────────────────────────────────────────────────┐
│                        Docker Host                              │
│                                                                 │
│  ┌─────────────┐   ┌───────────────┐   ┌──────────────────┐   │
│  │ Named Volume │   │  Bind Mount   │   │   tmpfs Mount    │   │
│  │             │   │               │   │                  │   │
│  │ /var/lib/   │   │ /home/user/   │   │   (記憶體)       │   │
│  │ docker/     │   │ project/data  │   │                  │   │
│  │ volumes/    │   │               │   │                  │   │
│  └──────┬──────┘   └───────┬───────┘   └────────┬─────────┘   │
│         │                  │                     │              │
│         ▼                  ▼                     ▼              │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                     Container                            │   │
│  │  /data              /app/data             /tmp/cache     │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

| 類型 | 管理方式 | 效能 | 適用場景 |
|------|----------|------|----------|
| Named Volume | Docker 管理 | 好 | 資料庫、持久化資料 |
| Bind Mount | 使用者管理 | 好 | 開發時掛載原始碼 |
| tmpfs Mount | 記憶體 | 最快 | 暫時性機密資料 |

### Named Volume（具名掛載）

```bash
# 建立 Volume
docker volume create my-data

# 使用 Volume 啟動容器
docker run -d \
  -v my-data:/var/lib/postgresql/data \
  --name my-db \
  postgres:16

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

# 刪除 Volume
docker volume rm my-data

# 清理未使用的 Volume
docker volume prune
```

### Bind Mount（綁定掛載）

```bash
# 掛載當前目錄到容器的 /app
docker run -d \
  -v $(pwd):/app \
  --name my-app \
  node:20-alpine

# 唯讀掛載
docker run -d \
  -v $(pwd)/config:/app/config:ro \
  --name my-app \
  node:20-alpine

# 使用 --mount 語法（更明確）
docker run -d \
  --mount type=bind,source=$(pwd),target=/app \
  --name my-app \
  node:20-alpine
```

### tmpfs Mount

```bash
# 掛載到記憶體（容器停止後資料消失）
docker run -d \
  --tmpfs /tmp:rw,size=100m \
  --name my-app \
  node:20-alpine

# 使用 --mount 語法
docker run -d \
  --mount type=tmpfs,destination=/tmp,tmpfs-size=100m \
  --name my-app \
  node:20-alpine
```

---

## 5.4 Docker Compose 中的 Volume 設定

```yaml
services:
  db:
    image: postgres:16-alpine
    volumes:
      # 具名 Volume
      - pgdata:/var/lib/postgresql/data

      # Bind Mount：初始化 SQL
      - ./init:/docker-entrypoint-initdb.d

      # 唯讀的設定檔
      - ./config/postgresql.conf:/etc/postgresql/postgresql.conf:ro

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
    driver: local

  api-logs:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /path/to/logs

  # 使用外部已存在的 Volume
  shared-data:
    external: true
```

---

## 5.5 Volume 備份與還原

### 備份

```bash
# 備份 Volume 到 tar 檔案
docker run --rm \
  -v pgdata:/source:ro \
  -v $(pwd):/backup \
  alpine \
  tar czf /backup/pgdata-backup.tar.gz -C /source .

# 使用日期命名
docker run --rm \
  -v pgdata:/source:ro \
  -v $(pwd):/backup \
  alpine \
  tar czf /backup/pgdata-$(date +%Y%m%d).tar.gz -C /source .
```

### 還原

```bash
# 還原 Volume
docker run --rm \
  -v pgdata:/target \
  -v $(pwd):/backup:ro \
  alpine \
  sh -c "cd /target && tar xzf /backup/pgdata-backup.tar.gz"
```

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

---

## 5.6 實際情境

### 情境一：容器重啟後 IP 改變，服務連線中斷

**問題**：容器 IP 在重啟後改變，硬編碼 IP 的設定失效

```bash
# ❌ 錯誤做法：使用 IP 連線
DB_HOST=172.18.0.3

# ✅ 正確做法：使用容器名稱（需自訂網路）
DB_HOST=db

# 確認容器的 DNS 解析
docker exec api nslookup db
# Server:    127.0.0.11
# Address:   127.0.0.11:53
# Name:      db
# Address:   172.18.0.3
```

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
# 2. 定期備份
# 建立一個 cron job
# 每天凌晨 2 點執行一次備份腳本
0 2 * * * /usr/local/bin/backup-volumes.sh

# 3. 使用 alias 防止手殘
# alias dcdown='docker compose down'  # 不加 -v
```

### 情境三：開發時 Bind Mount 的效能問題

**問題**：macOS / Windows 上使用 Bind Mount 掛載原始碼，檔案 I/O 非常慢

```yaml
# macOS 上 Bind Mount 的效能最佳化

services:
  api:
    volumes:
      # 使用 delegated 一致性模式（犧牲一致性換取效能）
      - ./backend:/app:delegated

      # 將 node_modules 放在 Volume 中（避免同步大量小檔案）
      - node_modules:/app/node_modules

volumes:
  node_modules:
```

```bash
# 或者使用 Docker Desktop 的 VirtioFS（macOS）
# Docker Desktop → Settings → General → Choose file sharing implementation
# 選擇 VirtioFS（比 gRPC FUSE 更快）
```

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
