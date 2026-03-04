# 第六章：開發環境實戰案例

## 6.1 為什麼用 Docker 建立開發環境？

- **環境一致性**：新人加入團隊，`docker compose up` 即可開始工作
- **避免污染主機**：不同專案可以使用不同版本的 Node.js、Python、PHP
- **快速重置**：`docker compose down -v && docker compose up -d` 即可還原乾淨環境
- **接近生產環境**：開發環境與生產環境使用相同的服務配置

---

## 6.2 實戰一：Node.js + Express + MongoDB

### 專案結構

```
my-express-app/
├── docker-compose.yml
├── docker-compose.override.yml    # 開發環境設定
├── Dockerfile
├── Dockerfile.dev
├── .dockerignore
├── .env
├── package.json
└── src/
    └── server.js
```

### 生產用 Dockerfile

```dockerfile
# Dockerfile
FROM node:20-alpine AS production

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --only=production

COPY . .

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3000
CMD ["node", "src/server.js"]
```

### 開發用 Dockerfile

```dockerfile
# Dockerfile.dev
FROM node:20-alpine

WORKDIR /app

# 安裝 nodemon 用於 hot reload
RUN npm install -g nodemon

COPY package.json package-lock.json ./
RUN npm install

COPY . .

EXPOSE 3000
EXPOSE 9229

# 開發模式使用 nodemon
CMD ["nodemon", "--inspect=0.0.0.0:9229", "src/server.js"]
```

### Docker Compose 設定

```yaml
# docker-compose.yml（基礎設定）
services:
  api:
    build: .
    environment:
      NODE_ENV: production
      MONGO_URI: mongodb://mongo:27017/myapp
    depends_on:
      mongo:
        condition: service_healthy
    restart: unless-stopped

  mongo:
    image: mongo:7
    volumes:
      - mongo-data:/data/db
    healthcheck:
      test: ["CMD", "mongosh", "--eval", "db.adminCommand('ping')"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  mongo-data:
```

```yaml
# docker-compose.override.yml（開發環境，自動載入）
services:
  api:
    build:
      context: .
      dockerfile: Dockerfile.dev
    ports:
      - "3000:3000"
      - "9229:9229"     # Node.js debugger
    volumes:
      - ./src:/app/src   # Hot reload
      - /app/node_modules
    environment:
      NODE_ENV: development
      DEBUG: "app:*"

  mongo:
    ports:
      - "27017:27017"

  mongo-express:
    image: mongo-express
    ports:
      - "8081:8081"
    environment:
      ME_CONFIG_MONGODB_URL: mongodb://mongo:27017
    depends_on:
      - mongo
```

```bash
# 啟動開發環境
docker compose up -d

# API：     http://localhost:3000
# MongoDB:  localhost:27017
# Mongo UI: http://localhost:8081
```

---

## 6.3 實戰二：PHP Laravel + MySQL + Nginx + Redis

### 專案結構

```
my-laravel-app/
├── docker/
│   ├── nginx/
│   │   └── default.conf
│   └── php/
│       └── local.ini
├── docker-compose.yml
├── Dockerfile
├── .dockerignore
├── .env
└── src/                    # Laravel 專案目錄
    ├── app/
    ├── bootstrap/
    ├── config/
    ├── ...
    └── composer.json
```

### Dockerfile

```dockerfile
# Dockerfile
FROM php:8.3-fpm-alpine

# 安裝系統相依套件
RUN apk add --no-cache \
    freetype-dev \
    libjpeg-turbo-dev \
    libpng-dev \
    libzip-dev \
    zip \
    unzip \
    git \
    curl

# 安裝 PHP 擴展
RUN docker-php-ext-configure gd --with-freetype --with-jpeg && \
    docker-php-ext-install -j$(nproc) \
    pdo \
    pdo_mysql \
    gd \
    zip \
    opcache \
    bcmath

# 安裝 Redis 擴展
RUN apk add --no-cache --virtual .build-deps $PHPIZE_DEPS && \
    pecl install redis && \
    docker-php-ext-enable redis && \
    apk del .build-deps

# 安裝 Composer
COPY --from=composer:latest /usr/bin/composer /usr/bin/composer

# PHP 設定
COPY docker/php/local.ini /usr/local/etc/php/conf.d/local.ini

WORKDIR /var/www/html

# 複製 Composer 檔案並安裝相依套件
COPY src/composer.json src/composer.lock ./
RUN composer install --no-dev --no-scripts --no-autoloader

# 複製應用程式碼
COPY src/ .
RUN composer dump-autoload --optimize

# 設定權限
RUN chown -R www-data:www-data /var/www/html/storage /var/www/html/bootstrap/cache
RUN chmod -R 775 /var/www/html/storage /var/www/html/bootstrap/cache

USER www-data

EXPOSE 9000
CMD ["php-fpm"]
```

### Nginx 設定

```nginx
# docker/nginx/default.conf
server {
    listen 80;
    server_name localhost;
    root /var/www/html/public;
    index index.php index.html;

    client_max_body_size 20M;

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    location ~ \.php$ {
        fastcgi_split_path_info ^(.+\.php)(/.+)$;
        fastcgi_pass php:9000;
        fastcgi_index index.php;
        include fastcgi_params;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        fastcgi_param PATH_INFO $fastcgi_path_info;
        fastcgi_buffer_size 128k;
        fastcgi_buffers 4 256k;
    }

    location ~ /\.(?!well-known).* {
        deny all;
    }
}
```

### PHP 設定

```ini
; docker/php/local.ini
upload_max_filesize = 20M
post_max_size = 20M
memory_limit = 256M
max_execution_time = 60

; OPcache 設定
opcache.enable = 1
opcache.memory_consumption = 128
opcache.max_accelerated_files = 10000
opcache.validate_timestamps = 0
```

### Docker Compose 設定

```yaml
# docker-compose.yml
services:
  nginx:
    image: nginx:1.25-alpine
    ports:
      - "80:80"
    volumes:
      - ./docker/nginx/default.conf:/etc/nginx/conf.d/default.conf:ro
      - ./src:/var/www/html:ro
    depends_on:
      - php
    restart: unless-stopped

  php:
    build: .
    volumes:
      - ./src:/var/www/html
    environment:
      APP_ENV: local
      APP_DEBUG: "true"
      DB_CONNECTION: mysql
      DB_HOST: mysql
      DB_PORT: 3306
      DB_DATABASE: ${DB_DATABASE:-laravel}
      DB_USERNAME: ${DB_USERNAME:-laravel}
      DB_PASSWORD: ${DB_PASSWORD:-secret}
      CACHE_DRIVER: redis
      SESSION_DRIVER: redis
      REDIS_HOST: redis
    depends_on:
      mysql:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped

  mysql:
    image: mysql:8.0
    environment:
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD:-rootsecret}
      MYSQL_DATABASE: ${DB_DATABASE:-laravel}
      MYSQL_USER: ${DB_USERNAME:-laravel}
      MYSQL_PASSWORD: ${DB_PASSWORD:-secret}
    volumes:
      - mysql-data:/var/lib/mysql
    ports:
      - "3306:3306"
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

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

  # 開發工具：phpMyAdmin
  phpmyadmin:
    image: phpmyadmin:latest
    ports:
      - "8080:80"
    environment:
      PMA_HOST: mysql
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD:-rootsecret}
    depends_on:
      - mysql
    profiles:
      - dev    # 只在開發環境啟用

volumes:
  mysql-data:
  redis-data:
```

```bash
# 啟動開發環境
docker compose up -d

# 啟動含 phpMyAdmin 的開發環境
docker compose --profile dev up -d

# 初始化 Laravel
# 安裝 PHP 相依套件（依 composer.lock）
docker compose exec php composer install
# 產生 APP_KEY（Laravel 啟動必備）
docker compose exec php php artisan key:generate
# 執行資料庫遷移並灌入初始資料
docker compose exec php php artisan migrate --seed

# 網站：     http://localhost
# phpMyAdmin: http://localhost:8080
```

---

## 6.4 實戰三：Python Django + PostgreSQL + Celery

### 專案結構

```
my-django-app/
├── docker-compose.yml
├── Dockerfile
├── .dockerignore
├── .env
├── requirements.txt
└── myproject/
    ├── manage.py
    ├── config/
    │   ├── __init__.py
    │   ├── settings.py
    │   ├── urls.py
    │   ├── wsgi.py
    │   └── celery.py
    └── apps/
```

### Dockerfile

```dockerfile
# Dockerfile
FROM python:3.12-slim

# 防止 Python 產生 .pyc 檔案
ENV PYTHONDONTWRITEBYTECODE=1
# 讓 Python 輸出不被緩衝（即時看到日誌）
ENV PYTHONUNBUFFERED=1

WORKDIR /app

# 安裝系統相依套件
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    gcc \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# 安裝 Python 相依套件
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 複製應用程式碼
COPY myproject/ .

# 建立非 root 使用者
RUN useradd --create-home appuser && \
    chown -R appuser:appuser /app
USER appuser

EXPOSE 8000
CMD ["gunicorn", "config.wsgi:application", "--bind", "0.0.0.0:8000", "--workers", "4"]
```

### Docker Compose 設定

```yaml
# docker-compose.yml
services:
  web:
    build: .
    command: python manage.py runserver 0.0.0.0:8000
    ports:
      - "8000:8000"
    volumes:
      - ./myproject:/app
    env_file: .env
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: ${DB_NAME:-myapp}
      POSTGRES_USER: ${DB_USER:-postgres}
      POSTGRES_PASSWORD: ${DB_PASSWORD:-secret}
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

  celery-worker:
    build: .
    command: celery -A config worker -l info --concurrency=2
    volumes:
      - ./myproject:/app
    env_file: .env
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped

  celery-beat:
    build: .
    command: celery -A config beat -l info --scheduler django_celery_beat.schedulers:DatabaseScheduler
    volumes:
      - ./myproject:/app
    env_file: .env
    depends_on:
      - celery-worker
    restart: unless-stopped

  flower:
    build: .
    command: celery -A config flower --port=5555
    ports:
      - "5555:5555"
    env_file: .env
    depends_on:
      - celery-worker
    profiles:
      - dev

volumes:
  pgdata:
```

### 環境變數

```bash
# .env
DB_NAME=myapp
DB_USER=postgres
DB_PASSWORD=secret
DB_HOST=db
DB_PORT=5432
REDIS_URL=redis://redis:6379/0
CELERY_BROKER_URL=redis://redis:6379/1
SECRET_KEY=your-secret-key-here
DEBUG=True
ALLOWED_HOSTS=localhost,127.0.0.1
```

```bash
# 啟動開發環境
docker compose up -d

# 執行資料庫遷移
docker compose exec web python manage.py migrate

# 建立管理員帳號
docker compose exec web python manage.py createsuperuser

# 網站：     http://localhost:8000
# Admin：    http://localhost:8000/admin
# Flower：   http://localhost:5555 （需 --profile dev）
```

---

## 6.5 實戰四：React / Vue 前端 + API + Nginx

### 專案結構

```
my-fullstack-app/
├── docker-compose.yml
├── frontend/
│   ├── Dockerfile
│   ├── Dockerfile.dev
│   ├── nginx.conf
│   ├── package.json
│   └── src/
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
└── .env
```

### 前端 Dockerfile（生產）

```dockerfile
# frontend/Dockerfile
# ===== 建構階段 =====
FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ===== 生產階段 =====
FROM nginx:1.25-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

### 前端 Dockerfile（開發）

```dockerfile
# frontend/Dockerfile.dev
FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install
COPY . .

EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
```

### 前端 Nginx 設定

```nginx
# frontend/nginx.conf
server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html;

    # SPA 路由：所有路徑都導向 index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # API 反向代理
    location /api/ {
        proxy_pass http://api:3000/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # 靜態資源快取
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff2?)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

### Docker Compose 設定

```yaml
# docker-compose.yml
services:
  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile.dev
    ports:
      - "5173:5173"
    volumes:
      - ./frontend/src:/app/src
      - /app/node_modules
    environment:
      VITE_API_URL: http://localhost:3000

  api:
    build: ./backend
    ports:
      - "3000:3000"
    volumes:
      - ./backend/src:/app/src
      - /app/node_modules
    environment:
      NODE_ENV: development
      DB_HOST: db
      DB_PASSWORD: ${DB_PASSWORD:-secret}
    depends_on:
      db:
        condition: service_healthy

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: myapp
      POSTGRES_PASSWORD: ${DB_PASSWORD:-secret}
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  pgdata:
```

```bash
# 啟動
docker compose up -d

# 前端：  http://localhost:5173
# API：   http://localhost:3000
# DB：    localhost:5432
```

---

## 6.6 開發環境常見技巧

### 使用 Makefile 簡化指令

```makefile
# Makefile
.PHONY: up down build logs shell db-shell migrate seed test

up:
	docker compose up -d

down:
	docker compose down

build:
	docker compose up -d --build

logs:
	docker compose logs -f

shell:
	docker compose exec api sh

db-shell:
	docker compose exec db psql -U postgres -d myapp

migrate:
	docker compose exec api npm run migrate

seed:
	docker compose exec api npm run seed

test:
	docker compose exec api npm test

clean:
	docker compose down -v
	docker system prune -f
```

```bash
# 使用方式
# 啟動所有服務（背景）
make up
# 持續追蹤日誌
make logs
# 進入 API 容器 shell
make shell
# 執行資料庫遷移
make migrate
```

### 使用 profiles 區分服務

```yaml
services:
  # 核心服務（預設啟動）
  api:
    build: ./backend
    ports:
      - "3000:3000"

  db:
    image: postgres:16-alpine

  # 開發工具（需指定 profile 才啟動）
  pgadmin:
    image: dpage/pgadmin4
    ports:
      - "5050:80"
    environment:
      PGADMIN_DEFAULT_EMAIL: admin@admin.com
      PGADMIN_DEFAULT_PASSWORD: admin
    profiles:
      - dev

  mailhog:
    image: mailhog/mailhog
    ports:
      - "8025:8025"
      - "1025:1025"
    profiles:
      - dev

  # 測試用服務
  test-db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: test_db
      POSTGRES_PASSWORD: test
    profiles:
      - test
```

```bash
# 只啟動核心服務
docker compose up -d

# 啟動含開發工具
docker compose --profile dev up -d

# 啟動測試環境
docker compose --profile test up -d
```

---

## 6.7 實際情境

### 情境一：hot reload 不生效

**問題**：修改原始碼後容器內的應用沒有自動重啟

```yaml
# 確認 volume 掛載是否正確
services:
  api:
    volumes:
      # ✅ 掛載原始碼目錄
      - ./src:/app/src

      # ⚠️ 確保 node_modules 不被覆蓋
      - /app/node_modules
```

```bash
# 排查步驟

# 1. 確認檔案有同步到容器
docker compose exec api ls -la /app/src/

# 2. 確認 nodemon / 開發伺服器是否正在監聽
docker compose logs -f api

# 3. macOS 的 inotify 問題 → 使用 polling
```

```json
// nodemon.json（macOS 需要 polling）
{
  "watch": ["src"],
  "ext": "js,ts,json",
  "legacyWatch": true,
  "pollingInterval": 1000
}
```

### 情境二：不同開發者的 .env 不一致

**問題**：團隊成員的環境變數設定不同，導致問題難以重現

```bash
# 解決方案：
# 1. 提供 .env.example 範本（加入版本控制）
# 2. .env 加入 .gitignore（不加入版本控制）

# .env.example
DB_HOST=db
DB_PORT=5432
DB_NAME=myapp
DB_USER=postgres
DB_PASSWORD=change_me
REDIS_URL=redis://redis:6379

# 新成員加入時
cp .env.example .env
# 然後修改需要的值
```

### 情境三：容器內安裝的套件消失

**問題**：重啟容器後 `node_modules` 又要重新安裝

```yaml
# 原因：Bind Mount 覆蓋了容器內的 node_modules

# ❌ 錯誤
services:
  api:
    volumes:
      - .:/app    # 主機的空 node_modules 覆蓋了容器內的

# ✅ 正確：使用匿名 Volume 保護 node_modules
services:
  api:
    volumes:
      - .:/app
      - /app/node_modules    # 匿名 Volume，不會被覆蓋
```

```bash
# 如果 package.json 更新了，需要重新建構
docker compose up -d --build

# 或者進入容器手動安裝
docker compose exec api npm install
```

---

## 6.8 本章小結

- Docker 開發環境讓團隊快速上手，`docker compose up` 即可開始工作
- 區分開發與生產的 Dockerfile（`Dockerfile.dev` vs `Dockerfile`）
- 使用 `docker-compose.override.yml` 自動載入開發環境設定
- 掛載原始碼時，記得用匿名 Volume 保護 `node_modules`
- 善用 `profiles` 區分核心服務與開發工具
- 建立 `Makefile` 簡化常用指令

---

> 上一章：[Docker 網路與資料持久化](./05-networking-volumes.md) | 下一章：[Registry 與映像管理](./07-registry-image-mgmt.md)
