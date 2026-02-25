# 第四章：Docker Compose 多容器編排

## 4.1 什麼是 Docker Compose？

Docker Compose 是一個用來定義和管理多容器應用的工具。透過一個 YAML 檔案（`docker-compose.yml`），你可以一次定義、啟動和管理多個互相關聯的服務。

### 為什麼需要 Docker Compose？

```
沒有 Docker Compose 的世界：

# 啟動資料庫
docker run -d --name db -e POSTGRES_PASSWORD=secret -v pgdata:/var/lib/postgresql/data postgres:16

# 啟動 Redis
docker run -d --name redis redis:7-alpine

# 啟動後端 API
docker run -d --name api -p 3000:3000 -e DB_HOST=db -e REDIS_HOST=redis --link db --link redis my-api

# 啟動前端
docker run -d --name web -p 80:80 --link api my-frontend

# 停止時要一個一個停...
docker stop web api redis db
docker rm web api redis db
```

```
有 Docker Compose 的世界：

# 一行啟動所有服務
docker compose up -d

# 一行停止所有服務
docker compose down
```

### Compose V1 vs V2

```bash
# V1（已過時，使用 docker-compose 獨立指令）
docker-compose up -d

# V2（推薦，已整合進 Docker CLI）
docker compose up -d

# 本課程統一使用 V2 語法
```

---

## 4.2 docker-compose.yml 基本結構

```yaml
# docker-compose.yml

# 不再需要指定 version（Compose V2 會自動判斷）
services:
  # 服務名稱
  web:
    image: nginx:1.25-alpine
    ports:
      - "80:80"

  api:
    build: ./backend
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production

  db:
    image: postgres:16-alpine
    volumes:
      - pgdata:/var/lib/postgresql/data
    environment:
      POSTGRES_PASSWORD: secret

# 具名 Volume 宣告
volumes:
  pgdata:

# 自訂網路宣告
networks:
  app-network:
```

---

## 4.3 服務設定完整解析

### image — 使用現有映像

```yaml
services:
  nginx:
    image: nginx:1.25-alpine

  redis:
    image: redis:7-alpine

  postgres:
    image: postgres:16-alpine
```

### build — 從 Dockerfile 建構

```yaml
services:
  api:
    # 簡單寫法：指定包含 Dockerfile 的目錄
    build: ./backend

  web:
    # 完整寫法
    build:
      context: ./frontend          # 建構上下文路徑
      dockerfile: Dockerfile.prod  # 指定 Dockerfile
      args:                        # 建構參數
        NODE_ENV: production
        API_URL: https://api.example.com
      target: production           # Multi-stage Build 的目標階段
      cache_from:
        - myregistry.com/web:cache
```

### ports — Port 對映

```yaml
services:
  web:
    ports:
      # 簡短語法：主機:容器
      - "80:80"
      - "443:443"

      # 指定綁定 IP
      - "127.0.0.1:8080:80"

      # 只暴露容器 port（主機隨機分配）
      - "80"

  api:
    ports:
      # 完整語法
      - target: 3000       # 容器 port
        published: 3000    # 主機 port
        protocol: tcp
        mode: host
```

### environment — 環境變數

```yaml
services:
  api:
    environment:
      # Map 語法
      NODE_ENV: production
      DB_HOST: db
      DB_PORT: 5432
      DB_NAME: myapp
      DB_USER: postgres
      DB_PASSWORD: secret

  worker:
    environment:
      # List 語法
      - NODE_ENV=production
      - REDIS_URL=redis://redis:6379

  app:
    # 從檔案載入環境變數
    env_file:
      - .env
      - .env.production
```

### .env 檔案

```bash
# .env（放在 docker-compose.yml 同一目錄）

# 資料庫設定
DB_HOST=db
DB_PORT=5432
DB_NAME=myapp
DB_USER=postgres
DB_PASSWORD=my_secure_password

# Redis 設定
REDIS_URL=redis://redis:6379

# 應用程式設定
NODE_ENV=production
API_PORT=3000
SECRET_KEY=your_secret_key_here
```

```yaml
# docker-compose.yml 中使用 .env 的變數
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: ${DB_NAME}
      POSTGRES_USER: ${DB_USER}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    ports:
      - "${DB_PORT}:5432"
```

### volumes — 資料掛載

```yaml
services:
  db:
    image: postgres:16-alpine
    volumes:
      # 具名 Volume（推薦用於持久化資料）
      - pgdata:/var/lib/postgresql/data

      # Bind Mount（開發時掛載原始碼）
      - ./init.sql:/docker-entrypoint-initdb.d/init.sql

      # 唯讀掛載
      - ./config:/etc/app/config:ro

  api:
    volumes:
      # 開發用：掛載原始碼，啟用 hot reload
      - ./backend:/app
      # 排除 node_modules（避免覆蓋容器內的版本）
      - /app/node_modules

# 頂層 Volume 宣告
volumes:
  pgdata:
    driver: local
  redis-data:
```

### depends_on — 服務相依性

```yaml
services:
  api:
    build: ./backend
    depends_on:
      # 簡單寫法：只確保啟動順序
      - db
      - redis

  worker:
    build: ./worker
    depends_on:
      # 完整寫法：可設定健康檢查條件
      db:
        condition: service_healthy
      redis:
        condition: service_started

  db:
    image: postgres:16-alpine
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5
      start_period: 10s

  redis:
    image: redis:7-alpine
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
```

> **注意**：`depends_on` 只確保啟動順序，不保證服務已經「準備好」。使用 `condition: service_healthy` 搭配 `healthcheck` 才能確保服務就緒。

### networks — 網路設定

```yaml
services:
  web:
    networks:
      - frontend

  api:
    networks:
      - frontend
      - backend

  db:
    networks:
      - backend

networks:
  frontend:
  backend:
    internal: true  # 禁止外部存取
```

### restart — 重啟策略

```yaml
services:
  api:
    restart: unless-stopped    # 推薦

  db:
    restart: always

  worker:
    restart: on-failure
    # 或帶最大重試次數
    deploy:
      restart_policy:
        condition: on-failure
        max_attempts: 5
```

### 資源限制

```yaml
services:
  api:
    deploy:
      resources:
        limits:
          cpus: '1.0'
          memory: 512M
        reservations:
          cpus: '0.5'
          memory: 256M
```

---

## 4.4 完整實戰範例

### 範例一：Node.js + PostgreSQL + Redis

```yaml
# docker-compose.yml
services:
  api:
    build:
      context: ./backend
      dockerfile: Dockerfile
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: production
      DB_HOST: db
      DB_PORT: 5432
      DB_NAME: myapp
      DB_USER: postgres
      DB_PASSWORD: ${DB_PASSWORD}
      REDIS_URL: redis://redis:6379
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped
    networks:
      - app-network

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: myapp
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./database/init.sql:/docker-entrypoint-initdb.d/init.sql
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5
    restart: unless-stopped
    networks:
      - app-network

  redis:
    image: redis:7-alpine
    command: redis-server --appendonly yes
    volumes:
      - redis-data:/data
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
    restart: unless-stopped
    networks:
      - app-network

volumes:
  pgdata:
  redis-data:

networks:
  app-network:
    driver: bridge
```

對應的 Dockerfile：

```dockerfile
# backend/Dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --only=production

COPY . .

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3000
CMD ["node", "server.js"]
```

### 範例二：PHP Laravel + MySQL + Nginx

```yaml
# docker-compose.yml
services:
  nginx:
    image: nginx:1.25-alpine
    ports:
      - "80:80"
    volumes:
      - ./nginx/default.conf:/etc/nginx/conf.d/default.conf:ro
      - ./src:/var/www/html:ro
    depends_on:
      - php
    networks:
      - app-network

  php:
    build:
      context: .
      dockerfile: Dockerfile
    volumes:
      - ./src:/var/www/html
    environment:
      DB_HOST: mysql
      DB_DATABASE: laravel
      DB_USERNAME: laravel
      DB_PASSWORD: ${DB_PASSWORD}
    depends_on:
      mysql:
        condition: service_healthy
    networks:
      - app-network

  mysql:
    image: mysql:8.0
    environment:
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD}
      MYSQL_DATABASE: laravel
      MYSQL_USER: laravel
      MYSQL_PASSWORD: ${DB_PASSWORD}
    volumes:
      - mysql-data:/var/lib/mysql
    ports:
      - "3306:3306"
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - app-network

  redis:
    image: redis:7-alpine
    networks:
      - app-network

volumes:
  mysql-data:

networks:
  app-network:
```

對應的 Dockerfile：

```dockerfile
# Dockerfile（PHP-FPM）
FROM php:8.3-fpm-alpine

# 安裝 PHP 擴展
RUN docker-php-ext-install pdo pdo_mysql opcache

# 安裝 Composer
COPY --from=composer:latest /usr/bin/composer /usr/bin/composer

WORKDIR /var/www/html

COPY src/ .

RUN composer install --no-dev --optimize-autoloader

RUN chown -R www-data:www-data /var/www/html/storage /var/www/html/bootstrap/cache

USER www-data

EXPOSE 9000
CMD ["php-fpm"]
```

### 範例三：Python Django + PostgreSQL + Celery + RabbitMQ

```yaml
# docker-compose.yml
services:
  web:
    build: .
    command: gunicorn config.wsgi:application --bind 0.0.0.0:8000 --workers 4
    ports:
      - "8000:8000"
    env_file: .env
    depends_on:
      db:
        condition: service_healthy
      rabbitmq:
        condition: service_healthy
    volumes:
      - static-files:/app/staticfiles
    restart: unless-stopped

  celery-worker:
    build: .
    command: celery -A config worker -l info
    env_file: .env
    depends_on:
      db:
        condition: service_healthy
      rabbitmq:
        condition: service_healthy
    restart: unless-stopped

  celery-beat:
    build: .
    command: celery -A config beat -l info
    env_file: .env
    depends_on:
      - celery-worker
    restart: unless-stopped

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: ${DB_NAME}
      POSTGRES_USER: ${DB_USER}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USER}"]
      interval: 5s
      timeout: 5s
      retries: 5

  rabbitmq:
    image: rabbitmq:3-management-alpine
    ports:
      - "15672:15672"   # Management UI
    environment:
      RABBITMQ_DEFAULT_USER: guest
      RABBITMQ_DEFAULT_PASS: guest
    healthcheck:
      test: ["CMD", "rabbitmq-diagnostics", "-q", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  nginx:
    image: nginx:1.25-alpine
    ports:
      - "80:80"
    volumes:
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
      - static-files:/app/staticfiles:ro
    depends_on:
      - web

volumes:
  pgdata:
  static-files:
```

---

## 4.5 Compose 常用指令

```bash
# === 啟動與停止 ===
docker compose up                  # 前景啟動所有服務
docker compose up -d               # 背景啟動
docker compose up -d --build       # 重新建構映像後啟動
docker compose up -d api           # 只啟動特定服務
docker compose down                # 停止並移除容器、網路
docker compose down -v             # 同上，加上移除 volume
docker compose stop                # 停止服務（不移除容器）
docker compose start               # 啟動已停止的服務

# === 查看狀態 ===
docker compose ps                  # 列出服務狀態
docker compose logs                # 查看所有服務日誌
docker compose logs -f api         # 追蹤特定服務日誌
docker compose logs --tail 50 api  # 最後 50 行日誌
docker compose top                 # 查看各服務的行程

# === 執行指令 ===
docker compose exec api bash              # 進入運行中的容器
docker compose exec db psql -U postgres    # 連線 PostgreSQL
docker compose run api npm test            # 建立臨時容器執行指令

# === 建構與更新 ===
docker compose build               # 建構所有服務的映像
docker compose build api            # 建構特定服務
docker compose pull                 # 拉取所有服務的映像
docker compose up -d --force-recreate  # 強制重新建立容器

# === 擴展服務 ===
docker compose up -d --scale worker=3  # 將 worker 擴展為 3 個實例

# === 設定檢查 ===
docker compose config              # 驗證並顯示最終設定
docker compose config --services   # 列出所有服務名稱
```

---

## 4.6 多環境設定

### 使用多個 Compose 檔案

```yaml
# docker-compose.yml（基礎設定）
services:
  api:
    build: ./backend
    environment:
      NODE_ENV: production
    depends_on:
      - db
    restart: unless-stopped

  db:
    image: postgres:16-alpine
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

```yaml
# docker-compose.override.yml（開發環境，會自動合併）
services:
  api:
    build:
      context: ./backend
      dockerfile: Dockerfile.dev
    ports:
      - "3000:3000"
      - "9229:9229"    # Debug port
    volumes:
      - ./backend:/app
      - /app/node_modules
    environment:
      NODE_ENV: development
      DEBUG: "true"

  db:
    ports:
      - "5432:5432"
    environment:
      POSTGRES_PASSWORD: dev_password
```

```yaml
# docker-compose.prod.yml（生產環境）
services:
  api:
    image: myregistry.com/api:${TAG:-latest}
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: '1.0'
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

  db:
    environment:
      POSTGRES_PASSWORD: ${DB_PASSWORD}
```

```bash
# 開發環境（自動載入 docker-compose.yml + docker-compose.override.yml）
docker compose up -d

# 生產環境（指定檔案）
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# 檢查最終合併的設定
docker compose -f docker-compose.yml -f docker-compose.prod.yml config
```

---

## 4.7 實際情境

### 情境一：服務啟動順序問題

**問題**：API 服務在資料庫還沒準備好就嘗試連線，導致啟動失敗

```yaml
# ❌ depends_on 只確保啟動順序，不確保服務已就緒
services:
  api:
    depends_on:
      - db    # db 容器啟動了，但 PostgreSQL 可能還在初始化

# ✅ 使用 healthcheck + condition
services:
  api:
    depends_on:
      db:
        condition: service_healthy

  db:
    image: postgres:16-alpine
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5
      start_period: 10s
```

```bash
# 或者在應用程式中加入重試邏輯（更可靠的做法）
# Node.js 範例：
# const { Pool } = require('pg');
# async function connectWithRetry(retries = 5) {
#   for (let i = 0; i < retries; i++) {
#     try {
#       const pool = new Pool();
#       await pool.query('SELECT 1');
#       return pool;
#     } catch (err) {
#       console.log(`DB not ready, retrying in 3s... (${i + 1}/${retries})`);
#       await new Promise(r => setTimeout(r, 3000));
#     }
#   }
#   throw new Error('Unable to connect to database');
# }
```

### 情境二：Volume 權限問題

**問題**：掛載的目錄在容器內沒有寫入權限

```bash
# 查看容器內的使用者
docker compose exec api id
# uid=1000(node) gid=1000(node)

# 查看掛載目錄的權限
docker compose exec api ls -la /app/logs
# drwxr-xr-x 2 root root 4096 ...

# 解決方案一：在 Dockerfile 中設定目錄權限
# RUN mkdir -p /app/logs && chown -R node:node /app/logs

# 解決方案二：在 docker-compose.yml 中使用 user
services:
  api:
    user: "${UID:-1000}:${GID:-1000}"

# 解決方案三：在主機上設定目錄權限
# chmod 777 ./logs  # 不推薦，但可快速解決
```

### 情境三：修改程式碼後服務沒有更新

**問題**：改了程式碼，`docker compose up -d` 但服務還是舊版

```bash
# 原因：Docker Compose 不會自動重建映像

# 解決方案：加上 --build 強制重建
docker compose up -d --build

# 或者分開執行
docker compose build api
docker compose up -d api

# 如果用了快取導致舊版本，強制重建不使用快取
docker compose build --no-cache api
docker compose up -d api
```

### 情境四：docker compose down 後資料遺失

**問題**：重啟服務後資料庫資料消失

```yaml
# ❌ 未使用 Volume，資料存在容器的可寫層
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: secret

# ✅ 使用具名 Volume 持久化
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: secret
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

```bash
# 注意：docker compose down -v 會刪除 volume！
docker compose down      # ✅ 保留 volume
docker compose down -v   # ⚠️ 會刪除 volume（資料會遺失）
```

### 情境五：容器之間無法互相連線

**問題**：API 容器無法連線到 db 容器

```bash
# 排查步驟

# 1. 確認服務在同一個網路
docker compose exec api ping db

# 2. 確認使用的是服務名稱而非 localhost
# ❌ DB_HOST=localhost
# ✅ DB_HOST=db（使用 docker-compose.yml 中的服務名稱）

# 3. 確認目標服務已啟動
docker compose ps

# 4. 確認目標服務的 port
docker compose exec api nslookup db
docker compose exec api nc -zv db 5432
```

---

## 4.8 本章小結

- Docker Compose 讓多容器應用的管理變得簡單——一個 YAML 檔案搞定所有設定
- 使用 `depends_on` + `healthcheck` 正確管理服務啟動順序
- 環境變數可透過 `.env` 檔案、`environment` 或 `env_file` 設定
- 務必使用具名 Volume 持久化資料庫等有狀態服務的資料
- 善用 `docker-compose.override.yml` 區分開發與生產環境設定
- 容器之間透過服務名稱（service name）互相連線，不是 localhost

---

> 上一章：[Dockerfile 撰寫與映像建構](./03-dockerfile.md) | 下一章：[Docker 網路與資料持久化](./05-networking-volumes.md)
