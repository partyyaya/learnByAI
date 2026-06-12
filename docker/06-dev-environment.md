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

# 正式環境基底；命名為 production 階段
FROM node:20-alpine AS production

# 容器內工作目錄
WORKDIR /app

# 先複製依賴描述檔（善用快取，程式碼改動時不會重裝套件）
COPY package.json package-lock.json ./
# 依 lock file 只裝正式依賴（可重現、映像較小）
RUN npm ci --only=production

# 再複製其餘原始碼
COPY . .

# 建立非 root 使用者，之後以低權限身份執行（安全性）
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

# 宣告監聽埠（僅 metadata）
EXPOSE 3000
# 正式啟動命令：直接跑 server.js（不需 hot reload）
CMD ["node", "src/server.js"]
```

### 開發用 Dockerfile

```dockerfile
# Dockerfile.dev
FROM node:20-alpine

WORKDIR /app

# 安裝 nodemon 用於 hot reload（偵測檔案變動自動重啟，開發專用）
RUN npm install -g nodemon

COPY package.json package-lock.json ./
# 開發環境裝完整依賴（含 devDependencies；正式環境才用 npm ci --only=production）
RUN npm install

COPY . .

# 3000：應用埠
EXPOSE 3000
# 9229：Node.js 除錯器（debugger）埠
EXPOSE 9229

# 開發模式使用 nodemon
# --inspect=0.0.0.0:9229：開啟 Node 偵錯器並綁 0.0.0.0，讓主機的 VSCode/Chrome 可連進來除錯
CMD ["nodemon", "--inspect=0.0.0.0:9229", "src/server.js"]
```

### Docker Compose 設定

```yaml
# docker-compose.yml（基礎設定）
services:
  api:
    build: .                         # 預設用 Dockerfile（正式版）建構；開發環境會在 override 改成 Dockerfile.dev
    environment:
      NODE_ENV: production           # 基礎設定預設正式模式（override 會覆蓋成 development）
      MONGO_URI: mongodb://mongo:27017/myapp # 用服務名稱 mongo 連線，myapp 是資料庫名稱
    depends_on:
      mongo:
        condition: service_healthy   # 等 mongo 健康檢查通過才啟動 api
    restart: unless-stopped

  mongo:
    image: mongo:7                   # 官方 MongoDB 7
    volumes:
      - mongo-data:/data/db          # 持久化資料目錄（MongoDB 預設資料路徑 /data/db）
    healthcheck:
      test: ["CMD", "mongosh", "--eval", "db.adminCommand('ping')"] # 用 mongosh 下 ping 指令確認 DB 就緒
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  mongo-data:                        # 宣告 mongo 使用的具名 Volume
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
      - /app/node_modules # 匿名 Volume，避免主機端 node_modules 覆蓋容器內相依套件
    environment:
      NODE_ENV: development # 啟用開發模式（較完整錯誤資訊、方便除錯）
      DEBUG: "app:*"        # 開啟 debug 日誌，顯示 app:* 命名空間訊息

  mongo:
    ports:
      - "27017:27017"     # 開發時把 DB 埠對外，方便用本機工具（Compass 等）連線

  mongo-express:          # 開發用的 MongoDB 網頁管理介面（正式環境不需要）
    image: mongo-express
    ports:
      - "8081:8081"       # 瀏覽器開 http://localhost:8081 即可管理資料
    environment:
      ME_CONFIG_MONGODB_URL: mongodb://mongo:27017  # 告訴 mongo-express 要連的 MongoDB 位址
    depends_on:
      - mongo
```

> 這段設定的目的：
>
> - `./src:/app/src`：把主機原始碼掛進容器，修改程式後可即時由 `nodemon` 重新載入。
> - `/app/node_modules`：用匿名 Volume 保留容器內安裝的套件，避免被主機目錄覆蓋（特別是跨 OS 時二進位套件不相容問題）。
> - `NODE_ENV=development`：讓應用程式以開發模式啟動。
> - `DEBUG=app:*`：開啟 debug 套件的命名空間日誌，方便追查請求流程與錯誤來源。
>   - 直覺對照：
>     - `DEBUG=app:*`：顯示所有 `app:` 開頭的除錯訊息（例如 `app:api`、`app:db`）。
>     - `DEBUG=app:db`：只顯示 `app:db` 這個命名空間。
>     - `DEBUG=*`：顯示所有命名空間（通常訊息量很大）。
>   - 注意：這個變數主要對 `debug` 套件生效；若程式只用 `console.log`，不會被 `DEBUG` 篩選。

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

# PHP 8.3 的 FPM 版本（給 Nginx 透過 fastcgi 呼叫）
FROM php:8.3-fpm-alpine

# 安裝系統相依套件（大多是「編譯 PHP 擴展所需的開發標頭檔 -dev」與常用工具）
# --no-cache：不保留 apk 套件索引快取，讓映像更小
#   freetype-dev / libjpeg-turbo-dev / libpng-dev：gd 影像處理擴展（字型、JPEG、PNG）所需
#   libzip-dev：zip 擴展所需
#   zip / unzip：壓縮工具，Composer 解壓套件會用到
#   git：Composer 從 git 取套件時會用到
#   curl：常用下載工具
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
# docker-php-ext-configure：編譯前的設定（這裡讓 gd 啟用 freetype 與 jpeg）
# docker-php-ext-install：實際編譯並啟用擴展；-j$(nproc) 用 CPU 核心數平行編譯加速
#   pdo / pdo_mysql：連 MySQL 必備；gd：影像處理；zip：壓縮
#   opcache：快取編譯後 bytecode 提升效能；bcmath：高精度數學運算（金額計算常用）
RUN docker-php-ext-configure gd --with-freetype --with-jpeg && \
    docker-php-ext-install -j$(nproc) \
    pdo \
    pdo_mysql \
    gd \
    zip \
    opcache \
    bcmath

# 安裝 Redis 擴展（PECL 套件，需要編譯）
# --virtual .build-deps：把「只在編譯時需要的工具」打包成一個虛擬套件名，裝完可一次移除
# $PHPIZE_DEPS：官方映像提供的變數，內含編譯擴展所需的 gcc/make/autoconf 等
# 流程：裝編譯工具 → pecl 下載編譯 redis → 啟用 redis → 移除編譯工具（避免殘留、縮小體積）
RUN apk add --no-cache --virtual .build-deps $PHPIZE_DEPS && \
    pecl install redis && \
    docker-php-ext-enable redis && \
    apk del .build-deps

# 安裝 Composer（直接從官方 composer 映像複製執行檔，免去自行安裝）
COPY --from=composer:latest /usr/bin/composer /usr/bin/composer

# PHP 設定（把自訂的 php.ini 片段放到 conf.d，啟動時會自動載入）
COPY docker/php/local.ini /usr/local/etc/php/conf.d/local.ini

# Laravel 程式放在此目錄
WORKDIR /var/www/html

# 先只複製 Composer 描述檔並安裝套件（善用快取：程式碼變動不會每次重裝 vendor）
# --no-dev：不裝開發套件；--no-scripts：先跳過 artisan 腳本；--no-autoloader：程式碼還沒進來，先不產生 autoload
COPY src/composer.json src/composer.lock ./
RUN composer install --no-dev --no-scripts --no-autoloader

# 再複製應用程式碼，然後產生最佳化的 autoload 對照表
COPY src/ .
RUN composer dump-autoload --optimize

# 設定權限：Laravel 執行時需要寫入 storage 與 bootstrap/cache
# chown 把擁有者改為 php-fpm 帳號 www-data；chmod 775 賦予可讀寫執行
RUN chown -R www-data:www-data /var/www/html/storage /var/www/html/bootstrap/cache
RUN chmod -R 775 /var/www/html/storage /var/www/html/bootstrap/cache

# 切換成非 root 執行（安全性）
USER www-data

# php-fpm 監聽埠（給 Nginx fastcgi_pass）
EXPOSE 9000
CMD ["php-fpm"]
```

### Nginx 設定

```nginx
# docker/nginx/default.conf
server {
    listen 80;                       # 監聽 80 埠（容器內）
    server_name localhost;           # 對應的網域名稱（本機測試用 localhost）
    root /var/www/html/public;       # 網站根目錄；Laravel 的對外入口在 public/
    index index.php index.html;      # 預設首頁檔（找不到指定檔時依序嘗試）

    client_max_body_size 20M;        # 允許的最大上傳大小（預設 1M，常需調大以支援檔案上傳）

    # 一般請求：先找實體檔案/目錄，找不到就交給 Laravel 的入口檔 index.php 處理路由
    location / {
        # try_files 依序嘗試：$uri（同名檔）→ $uri/（同名目錄）→ 最後導到 index.php 並帶上原查詢字串
        try_files $uri $uri/ /index.php?$query_string;
    }

    # 把 .php 結尾的請求轉給 PHP-FPM 處理（fastcgi 協定）
    location ~ \.php$ {
        fastcgi_split_path_info ^(.+\.php)(/.+)$;  # 拆出腳本路徑與 PATH_INFO（支援 /index.php/foo 這類路徑）
        fastcgi_pass php:9000;                     # 轉發到名為 php 的容器的 9000 埠（compose 服務名 + php-fpm 埠）
        fastcgi_index index.php;                   # 若請求是目錄，預設執行的腳本
        include fastcgi_params;                    # 載入 Nginx 內建的標準 fastcgi 參數集
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;  # 告訴 PHP-FPM 實際要執行哪個檔（最關鍵的參數）
        fastcgi_param PATH_INFO $fastcgi_path_info;  # 傳遞 PATH_INFO 給 PHP
        fastcgi_buffer_size 128k;                  # 回應標頭的緩衝大小
        fastcgi_buffers 4 256k;                    # 回應內容的緩衝區數量與大小（避免大回應寫入暫存檔）
    }

    # 拒絕存取隱藏檔（以 . 開頭），但放行 /.well-known（Let's Encrypt 憑證驗證會用到）
    location ~ /\.(?!well-known).* {
        deny all;                    # 回 403，保護 .env、.git 等敏感檔不被直接讀取
    }
}
```

### PHP 設定

```ini
; docker/php/local.ini
; （在 php.ini 中分號 ; 是註解；以下覆寫 PHP 預設值）

; 單一上傳檔案大小上限（需 <= post_max_size 才有意義）
upload_max_filesize = 20M
; 整個 POST 請求的大小上限（含所有上傳檔與表單欄位）
post_max_size = 20M
; 單一請求可用的記憶體上限（複雜頁面或大量資料處理時常需調高）
memory_limit = 256M
; 單一腳本最長執行秒數（避免卡死；CLI 模式不受此限）
max_execution_time = 60

; OPcache 設定（把編譯後的 PHP bytecode 快取在記憶體，避免每次請求重編譯）
; 啟用 OPcache
opcache.enable = 1
; 配給 OPcache 的記憶體（MB）
opcache.memory_consumption = 128
; 可快取的檔案數量上限（專案檔多時要調大）
opcache.max_accelerated_files = 10000
; 是否檢查檔案修改時間：0=不檢查（正式環境效能最好，但改碼需重啟才生效）
; 開發環境建議設 1，否則改了 PHP 也看不到變化
opcache.validate_timestamps = 0
```

### Docker Compose 設定

```yaml
# docker-compose.yml
services:
  nginx:                             # Web 伺服器，對外接 HTTP、把 PHP 請求轉給 php 容器
    image: nginx:1.25-alpine
    ports:
      - "80:80"
    volumes:
      - ./docker/nginx/default.conf:/etc/nginx/conf.d/default.conf:ro # 掛入站台設定（唯讀）
      - ./src:/var/www/html:ro       # 掛入程式碼供 Nginx 讀取靜態檔（唯讀）
    depends_on:
      - php                          # 先啟動 php
    restart: unless-stopped

  php:                               # Laravel 應用（PHP-FPM）
    build: .                         # 用本章上面的 Dockerfile 建構
    volumes:
      - ./src:/var/www/html          # 掛入程式碼（可寫，改碼即生效）
    environment:
      # 注意 ${VAR:-預設值} 語法：若 .env 沒設定 VAR，就用冒號後的預設值
      APP_ENV: local                 # Laravel 環境：本機開發
      APP_DEBUG: "true"              # 顯示詳細錯誤頁（正式環境務必關閉）
      DB_CONNECTION: mysql           # 使用 MySQL 連線驅動
      DB_HOST: mysql                 # 用服務名稱 mysql 連線
      DB_PORT: 3306
      DB_DATABASE: ${DB_DATABASE:-laravel}    # 資料庫名稱，未設定時預設 laravel
      DB_USERNAME: ${DB_USERNAME:-laravel}    # 資料庫帳號，未設定時預設 laravel
      DB_PASSWORD: ${DB_PASSWORD:-secret}     # 資料庫密碼，未設定時預設 secret
      CACHE_DRIVER: redis            # 快取存到 Redis
      SESSION_DRIVER: redis          # Session 存到 Redis
      REDIS_HOST: redis              # 用服務名稱 redis 連線
    depends_on:
      mysql:
        condition: service_healthy   # 等 MySQL 健康才啟動（避免一開機就連不上 DB）
      redis:
        condition: service_healthy   # 等 Redis 健康才啟動
    restart: unless-stopped

  mysql:                             # MySQL 資料庫
    image: mysql:8.0
    environment:
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD:-rootsecret} # root 密碼（預設 rootsecret）
      MYSQL_DATABASE: ${DB_DATABASE:-laravel}  # 首次啟動自動建立的資料庫
      MYSQL_USER: ${DB_USERNAME:-laravel}      # 首次啟動自動建立的一般帳號
      MYSQL_PASSWORD: ${DB_PASSWORD:-secret}   # 上述帳號的密碼（需與 php 端一致）
    volumes:
      - mysql-data:/var/lib/mysql    # 持久化 MySQL 資料
    ports:
      - "3306:3306"                  # 對外開放，方便本機 DB 工具連線
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"] # 用 mysqladmin ping 確認就緒
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  redis:                             # Redis（快取 / session）
    image: redis:7-alpine
    command: redis-server --appendonly yes # 啟用 AOF 持久化
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

  # 開發工具：phpMyAdmin（資料庫網頁管理介面）
  phpmyadmin:
    image: phpmyadmin:latest
    ports:
      - "8080:80"                    # 瀏覽器開 http://localhost:8080 進管理頁
    environment:
      PMA_HOST: mysql                # phpMyAdmin 要連的資料庫主機（服務名稱）
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD:-rootsecret}
    depends_on:
      - mysql
    profiles:
      - dev    # 只在開發環境啟用：需 docker compose --profile dev up 才會啟動（預設不啟動）

volumes:
  mysql-data:                        # MySQL 持久化 Volume
  redis-data:                        # Redis 持久化 Volume
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

# 防止 Python 產生 .pyc 檔案（容器內不需要，保持乾淨）
ENV PYTHONDONTWRITEBYTECODE=1
# 讓 Python 輸出不被緩衝（stdout 即時刷出，docker logs 才看得到即時日誌）
ENV PYTHONUNBUFFERED=1

WORKDIR /app

# 安裝系統相依套件（編譯某些 Python 套件時需要）
# gcc：編譯含 C 擴展的套件時需要
# libpq-dev：psycopg2（PostgreSQL 驅動）編譯所需的標頭檔
# --no-install-recommends：不裝建議套件，縮小體積
# 最後 rm -rf /var/lib/apt/lists/* 清掉 apt 索引快取，縮小映像
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    gcc \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# 先裝 Python 相依套件（善用快取；--no-cache-dir 不留 pip 快取，縮小映像）
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 複製應用程式碼
COPY myproject/ .

# 建立非 root 使用者並把 /app 擁有權交給它（安全性）
RUN useradd --create-home appuser && \
    chown -R appuser:appuser /app
USER appuser

EXPOSE 8000
# 用 gunicorn 啟動 WSGI 應用（正式環境用，比 runserver 穩定）
# config.wsgi:application 指向 Django 專案的 WSGI 進入點
# --bind 0.0.0.0:8000 才能被容器外連到；--workers 4 開 4 個工作行程
CMD ["gunicorn", "config.wsgi:application", "--bind", "0.0.0.0:8000", "--workers", "4"]
```

### Docker Compose 設定

```yaml
# docker-compose.yml
services:
  web:                               # Django 網站本體
    build: .                         # web / celery-worker / beat / flower 共用同一個映像
    command: python manage.py runserver 0.0.0.0:8000 # 開發用伺服器（改碼會自動重載）；正式環境改用 gunicorn
    ports:
      - "8000:8000"
    volumes:
      - ./myproject:/app             # 掛入程式碼，改碼即生效（hot reload）
    env_file: .env                   # 從 .env 注入所有環境變數（DB、Redis、SECRET_KEY 等）
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped

  db:                                # PostgreSQL
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: ${DB_NAME:-myapp}      # ${VAR:-預設}：.env 沒設定就用預設值
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

  redis:                             # Redis：當 Celery 的 broker / result backend
    image: redis:7-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

  celery-worker:                     # Celery worker：執行非同步任務
    build: .
    command: celery -A config worker -l info --concurrency=2 # -A config 指定 app；--concurrency=2 同時跑 2 個工作行程
    volumes:
      - ./myproject:/app
    env_file: .env
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped

  celery-beat:                       # Celery beat：定時排程器，把週期任務丟進佇列
    build: .
    command: celery -A config beat -l info --scheduler django_celery_beat.schedulers:DatabaseScheduler # 用 DB 儲存排程（可在 Django Admin 動態調整）
    volumes:
      - ./myproject:/app
    env_file: .env
    depends_on:
      - celery-worker
    restart: unless-stopped

  flower:                            # Flower：Celery 任務的網頁監控介面（開發工具）
    build: .
    command: celery -A config flower --port=5555
    ports:
      - "5555:5555"                  # 瀏覽器開 http://localhost:5555 查看任務狀態
    env_file: .env
    depends_on:
      - celery-worker
    profiles:
      - dev                          # 只在 --profile dev 時啟動

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
# 用 Node 把前端原始碼打包成靜態檔；此階段含完整 build 工具，不會進到最終映像
FROM node:20-alpine AS builder

WORKDIR /app
# 先裝依賴（善用快取）
COPY package.json package-lock.json ./
RUN npm ci
# 再複製原始碼並建構，產物通常輸出到 /app/dist
COPY . .
RUN npm run build

# ===== 生產階段 =====
# 最終映像只用輕量 Nginx 提供靜態檔，不含 Node 與 node_modules（體積極小）
FROM nginx:1.25-alpine

# 複製自訂的 Nginx 站台設定
COPY nginx.conf /etc/nginx/conf.d/default.conf
# 關鍵：用 --from=builder 從建構階段把打包好的 dist 複製進來當網站內容
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80
# 前景執行 Nginx：daemon off 讓 nginx 不要背景化，否則容器主程序結束會立刻退出
CMD ["nginx", "-g", "daemon off;"]
```

### 前端 Dockerfile（開發）

```dockerfile
# frontend/Dockerfile.dev
FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json ./
# 開發環境裝完整依賴（含 devDependencies）
RUN npm install
COPY . .

# Vite 開發伺服器預設埠
EXPOSE 5173
# 啟動 Vite 開發伺服器（含 HMR 熱更新）
# 第一個 -- 是把後面參數傳給 npm script；--host 0.0.0.0 讓 dev server 綁所有介面
# 若不加 --host，Vite 預設只綁 127.0.0.1，容器外（主機瀏覽器）會連不進來
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
```

### 前端 Nginx 設定

```nginx
# frontend/nginx.conf
server {
    listen 80;                       # 監聽 80 埠
    root /usr/share/nginx/html;      # 靜態檔根目錄（對應 Dockerfile 複製進來的 dist）
    index index.html;                # 預設首頁

    # SPA 路由：所有找不到實體檔的路徑都回 index.html，交給前端框架自己處理路由
    location / {
        # 依序找 $uri（實體檔）→ $uri/（目錄）→ 都沒有就回 index.html
        try_files $uri $uri/ /index.html;
    }

    # API 反向代理：把 /api/ 開頭的請求轉給後端 api 容器，避免瀏覽器跨域（CORS）問題
    location /api/ {
        # 轉發到名為 api 的容器的 3000 埠；結尾的 / 會把 /api/ 前綴去掉再轉給後端
        proxy_pass http://api:3000/;
        # 以下三個 header 讓後端知道「原始請求」的真實資訊（否則後端只看到 Nginx）
        proxy_set_header Host $host;                              # 保留原始主機名
        proxy_set_header X-Real-IP $remote_addr;                 # 真實客戶端 IP
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; # 經過的代理鏈 IP 列表
    }

    # 靜態資源（JS/CSS/圖片/字型）長期快取，加速重複載入
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff2?)$ {
        expires 1y;                  # 瀏覽器快取 1 年
        # immutable 告訴瀏覽器「這檔不會變」，連條件式請求都省了（檔名通常帶 hash，改版即換檔名）
        add_header Cache-Control "public, immutable";
    }
}
```

### Docker Compose 設定

```yaml
# docker-compose.yml
services:
  frontend:                          # 前端（Vite 開發伺服器）
    build:
      context: ./frontend
      dockerfile: Dockerfile.dev     # 開發用 Dockerfile（跑 dev server，非打包成靜態檔）
    ports:
      - "5173:5173"
    volumes:
      - ./frontend/src:/app/src      # 掛入原始碼，改碼即時 HMR
      - /app/node_modules            # 匿名 Volume：保護容器內裝好的 node_modules 不被主機覆蓋
    environment:
      VITE_API_URL: http://localhost:3000 # 前端打 API 的位址；VITE_ 前綴的變數才會被 Vite 注入到瀏覽器端

  api:                               # 後端 API
    build: ./backend
    ports:
      - "3000:3000"
    volumes:
      - ./backend/src:/app/src       # 掛入後端原始碼
      - /app/node_modules            # 同樣用匿名 Volume 保護依賴
    environment:
      NODE_ENV: development
      DB_HOST: db                    # 用服務名稱連資料庫
      DB_PASSWORD: ${DB_PASSWORD:-secret}
    depends_on:
      db:
        condition: service_healthy

  db:                                # PostgreSQL
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
# 把常用的長指令包成短命令（make up / make logs ...），團隊好記又一致
# .PHONY：宣告這些是「指令名稱」而非真實檔案，避免目錄剛好有同名檔案時 make 不執行
.PHONY: up down build logs shell db-shell migrate seed test clean

# 背景啟動所有服務
up:
	docker compose up -d

# 停止並移除容器與網路（保留 volume，資料不會掉）
down:
	docker compose down

# 重新建構映像後啟動（改了 Dockerfile 或依賴時用）
build:
	docker compose up -d --build

# 持續追蹤所有服務日誌
logs:
	docker compose logs -f

# 進入 api 容器的 shell
shell:
	docker compose exec api sh

# 進入資料庫互動介面（psql）
db-shell:
	docker compose exec db psql -U postgres -d myapp

# 執行資料庫遷移
migrate:
	docker compose exec api npm run migrate

# 灌入初始 / 測試資料
seed:
	docker compose exec api npm run seed

# 執行測試
test:
	docker compose exec api npm test

# 完整清理：連同 volume 一起移除，再清掉未使用資源（⚠️ 會刪資料庫資料）
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
  # 核心服務（沒有 profiles，預設一律啟動）
  api:
    build: ./backend
    ports:
      - "3000:3000"

  db:
    image: postgres:16-alpine

  # 開發工具：有 profiles 的服務「預設不啟動」，要加 --profile dev 才會起來
  pgadmin:                           # PostgreSQL 的網頁管理介面
    image: dpage/pgadmin4
    ports:
      - "5050:80"
    environment:
      PGADMIN_DEFAULT_EMAIL: admin@admin.com   # 登入帳號
      PGADMIN_DEFAULT_PASSWORD: admin          # 登入密碼
    profiles:
      - dev                          # 歸類到 dev profile

  mailhog:                           # 攔截開發環境寄出的信件，提供假 SMTP + 網頁收件匣
    image: mailhog/mailhog
    ports:
      - "8025:8025"                  # 8025：網頁收件匣 UI
      - "1025:1025"                  # 1025：假的 SMTP 埠（應用把信寄到這）
    profiles:
      - dev

  # 測試用服務：歸到 test profile，跑測試時才啟動，與開發資料庫分開
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
