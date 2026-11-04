# 第六章：開發環境實戰案例

## 6.1 為什麼用 Docker 建立開發環境？

- **環境一致性**：新人加入團隊，`docker compose up` 即可開始工作
- **避免污染主機**：不同專案可以使用不同版本的 Node.js、Python、PHP
- **快速重置**：`docker compose down -v && docker compose up -d` 即可還原乾淨環境
- **接近生產環境**：開發環境與生產環境使用相同的服務配置

本章四個實戰都可以從空目錄開始跟著做，主機只需要 Docker；建立專案用的 Node、Composer、Django 指令都在容器裡執行。

---

## 6.2 實戰一：Node.js + Express + MongoDB

### 專案結構

```
my-express-app/
├── docker-compose.yml             # 基礎設定（接近正式環境）
├── docker-compose.override.yml    # 開發環境設定（自動合併）
├── Dockerfile                     # dev 與 production 兩個階段
├── .dockerignore
├── package.json
├── package-lock.json
└── src/
    └── server.js
```

### 建立專案

```bash
mkdir -p ~/docker-practice/my-express-app/src
cd ~/docker-practice/my-express-app
```

`package.json`：

```json
{
  "name": "my-express-app",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "start": "node src/server.js",
    "dev": "nodemon --inspect=0.0.0.0:9229 src/server.js"
  }
}
```

- `start`：正式環境直接用 node 執行。
- `dev`：開發時用 nodemon 監看檔案，存檔就自動重啟；`--inspect=0.0.0.0:9229` 開啟 Node 除錯器並綁 0.0.0.0，主機的 VS Code / Chrome 才連得進來。

安裝套件（`express`、`mongodb` 是正式依賴，`nodemon` 只在開發用）：

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD":/app -w /app node:24-alpine \
  sh -c 'npm install --package-lock-only express mongodb && npm install --package-lock-only -D nodemon'

printf 'node_modules\n.git\n' > .dockerignore
```

`src/server.js`：每次請求在 MongoDB 寫一筆紀錄，並回傳目前總筆數。

```javascript
const express = require('express');
const { MongoClient } = require('mongodb');

const app = express();
const client = new MongoClient(process.env.MONGO_URI);

app.get('/', async (req, res) => {
  const visits = client.db().collection('visits');   // 資料庫名稱取自 MONGO_URI 最後的 /myapp
  await visits.insertOne({ at: new Date() });
  res.json({ message: 'Hello from Express', visits: await visits.countDocuments() });
});

app.get('/health', (req, res) => res.send('ok'));

async function main() {
  await client.connect();
  const server = app.listen(3000, '0.0.0.0', () => console.log('listening on 3000'));
  // 優雅停機（原因見第三章 3.2）
  process.on('SIGTERM', () => server.close(() => client.close().then(() => process.exit(0))));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

### Dockerfile：用 target 區分開發與正式

不必維護 `Dockerfile` 與 `Dockerfile.dev` 兩個檔案。把開發與正式寫成同一個檔案的兩個階段，Compose 再用 `target` 選要建哪一個：

```dockerfile
# Dockerfile

# ===== 開發階段 =====
FROM node:24-alpine AS dev
WORKDIR /app
COPY package.json package-lock.json ./
# 開發環境裝完整依賴（含 devDependencies 的 nodemon）
RUN npm ci
COPY . .
# 3000：應用埠；9229：Node.js 除錯器埠
EXPOSE 3000 9229
CMD ["npm", "run", "dev"]

# ===== 正式階段 =====
FROM node:24-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# 只裝正式依賴，映像較小
RUN npm ci --omit=dev
COPY . .
USER node
EXPOSE 3000
# 正式環境直接執行 node（不需要 nodemon，也少一層 npm）
CMD ["node", "src/server.js"]
```

### Docker Compose 設定

```yaml
# docker-compose.yml（基礎設定：接近正式環境）
services:
  api:
    build:
      context: .
      target: production             # 預設建正式階段；開發環境在 override 改成 dev
    environment:
      NODE_ENV: production
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
      test: ["CMD", "mongosh", "--quiet", "--eval", "db.adminCommand('ping')"] # 用 mongosh 下 ping 指令確認 DB 就緒
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 10s

volumes:
  mongo-data:                        # 宣告 mongo 使用的具名 Volume
```

```yaml
# docker-compose.override.yml（開發環境，docker compose up 時自動載入）
services:
  api:
    build:
      target: dev                    # 改建開發階段（nodemon + 完整依賴）
    ports:
      - "3000:3000"
      - "9229:9229"                  # Node.js debugger
    volumes:
      - ./src:/app/src               # 只掛原始碼目錄：存檔後 nodemon 立刻重啟
    environment:
      NODE_ENV: development

  mongo:
    ports:
      - "127.0.0.1:27017:27017"      # 開發時讓本機工具（MongoDB Compass 等）連線；只綁本機

  mongo-express:                     # 開發用的 MongoDB 網頁管理介面（正式環境不需要）
    image: mongo-express:1
    ports:
      - "127.0.0.1:8081:8081"        # 瀏覽器開 http://localhost:8081
    environment:
      ME_CONFIG_MONGODB_URL: mongodb://mongo:27017  # 要連的 MongoDB 位址
      ME_CONFIG_BASICAUTH_USERNAME: admin           # mongo-express 1.x 預設要求登入，這裡指定帳密
      ME_CONFIG_BASICAUTH_PASSWORD: admin
    depends_on:
      mongo:
        condition: service_healthy
```

> 這段設定的目的：
>
> - `./src:/app/src`：只把原始碼目錄掛進容器。映像裡的 `/app/node_modules` 沒有被蓋到，所以不需要第四章那個匿名 volume 的技巧。
> - `target: dev`：開發環境用含 nodemon 的階段；正式部署時不載入 override，自然就是 `production` 階段。
> - `NODE_ENV=development`：讓應用程式以開發模式啟動。

### 啟動與驗證

```bash
docker compose up -d --build --wait

curl http://localhost:3000
# {"message":"Hello from Express","visits":1}

# 在主機修改原始碼，存檔後 nodemon 會自動重啟（不用重建映像）
sed -i.bak 's/Hello from Express/Hello after edit/' src/server.js && rm src/server.js.bak
sleep 2
curl http://localhost:3000
# {"message":"Hello after edit","visits":2}

docker compose logs api | tail -4
# [nodemon] restarting due to changes...
# [nodemon] starting `node --inspect=0.0.0.0:9229 src/server.js`
# Debugger listening on ws://0.0.0.0:9229/...
# listening on 3000
```

- API：http://localhost:3000
- MongoDB：`localhost:27017`
- Mongo UI：http://localhost:8081（帳號 `admin`、密碼 `admin`）

### 用 VS Code 中斷點除錯

容器內的 Node 已經開了 9229 除錯埠。在專案根目錄建立 `.vscode/launch.json`：

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "attach",
      "name": "Attach to Docker",
      "address": "localhost",
      "port": 9229,
      "localRoot": "${workspaceFolder}/src",
      "remoteRoot": "/app/src",
      "restart": true
    }
  ]
}
```

- `localRoot` / `remoteRoot`：主機的 `src` 對應容器的 `/app/src`，VS Code 才知道中斷點要下在容器裡的哪個檔案。
- `restart: true`：nodemon 重啟程式後自動重新連線。

在 `src/server.js` 下中斷點，按 F5 選「Attach to Docker」，再 `curl http://localhost:3000` 就會停在中斷點。

```bash
# 練習結束
docker compose down -v
```

---

## 6.3 實戰二：PHP Laravel + MySQL + Nginx + Redis

開發環境的做法是：**映像只負責 PHP 執行環境**（PHP 版本、擴展、Composer），Laravel 程式碼用 bind mount 掛進去，`vendor/` 也直接裝在主機的專案目錄裡。這和第四章範例二（程式碼打包進映像）是兩種用途：前者給開發、後者給部署。

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
├── .env                    # Compose 用的變數（UID/GID 等），不是 Laravel 的 .env
└── src/                    # Laravel 專案目錄（稍後由 composer 產生）
```

```bash
mkdir -p ~/docker-practice/my-laravel-app/docker/nginx \
         ~/docker-practice/my-laravel-app/docker/php \
         ~/docker-practice/my-laravel-app/src
cd ~/docker-practice/my-laravel-app
```

### Dockerfile

```dockerfile
# Dockerfile（開發用：只有 PHP 環境，不含程式碼）

# PHP 8.4 的 FPM 版本（給 Nginx 透過 fastcgi 呼叫）
# 版本要符合 Laravel 的要求：目前的 Laravel 依賴需要 PHP 8.4 以上
FROM php:8.4-fpm-alpine

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
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

# PHP 設定（把自訂的 php.ini 片段放到 conf.d，啟動時會自動載入）
COPY docker/php/local.ini /usr/local/etc/php/conf.d/local.ini

# Laravel 程式放在此目錄（開發時由 bind mount 提供）
WORKDIR /var/www/html

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
; 是否檢查檔案修改時間：開發環境一定要 1，改了 PHP 才會立刻生效
; 正式環境（程式碼打包在映像裡、不會變動）設 0 效能最好，但改碼需重啟才生效
opcache.validate_timestamps = 1
; 每次請求都檢查（0 秒）；正式環境不需要這行
opcache.revalidate_freq = 0
```

### Docker Compose 設定

```yaml
# docker-compose.yml
services:
  nginx:                             # Web 伺服器，對外接 HTTP、把 PHP 請求轉給 php 容器
    image: nginx:1.30-alpine
    ports:
      - "8000:80"                    # 瀏覽器開 http://localhost:8000
    volumes:
      - ./docker/nginx/default.conf:/etc/nginx/conf.d/default.conf:ro # 掛入站台設定（唯讀）
      - ./src:/var/www/html:ro       # 掛入程式碼供 Nginx 讀取靜態檔（唯讀）
    depends_on:
      - php                          # 先啟動 php
    restart: unless-stopped

  php:                               # Laravel 應用（PHP-FPM）
    build: .                         # 用本節上面的 Dockerfile 建構
    # 用主機使用者的 UID/GID 執行，在 Linux 上 composer、Laravel 寫入的檔案才不會變成別人的（見第四章 4.7 情境二）
    user: "${HOST_UID:-1000}:${HOST_GID:-1000}"
    volumes:
      - ./src:/var/www/html          # 掛入程式碼（可寫，改碼即生效）
    environment:
      # 非 root 身分沒有家目錄，Composer 與 artisan tinker 需要一個可寫的目錄
      HOME: /tmp
      COMPOSER_HOME: /tmp/composer
      # 以下變數會覆蓋 src/.env 裡的同名設定（Laravel 不會用 .env 覆蓋已存在的環境變數）
      # 注意 ${VAR:-預設值} 語法：若 .env 沒設定 VAR，就用冒號後的預設值
      APP_ENV: local                 # Laravel 環境：本機開發
      APP_DEBUG: "true"              # 顯示詳細錯誤頁（正式環境務必關閉）
      DB_CONNECTION: mysql           # 使用 MySQL 連線驅動（Laravel 新專案預設是 sqlite）
      DB_HOST: mysql                 # 用服務名稱 mysql 連線
      DB_PORT: 3306
      DB_DATABASE: ${DB_DATABASE:-laravel}    # 資料庫名稱，未設定時預設 laravel
      DB_USERNAME: ${DB_USERNAME:-laravel}    # 資料庫帳號，未設定時預設 laravel
      DB_PASSWORD: ${DB_PASSWORD:-secret}     # 資料庫密碼，未設定時預設 secret
      CACHE_STORE: redis             # 快取存到 Redis
      SESSION_DRIVER: redis          # Session 存到 Redis
      REDIS_HOST: redis              # 用服務名稱 redis 連線
    depends_on:
      mysql:
        condition: service_healthy   # 等 MySQL 健康才啟動（避免一開機就連不上 DB）
      redis:
        condition: service_healthy   # 等 Redis 健康才啟動
    restart: unless-stopped

  mysql:                             # MySQL 資料庫
    image: mysql:8.4
    environment:
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD:-rootsecret} # root 密碼（預設 rootsecret）
      MYSQL_DATABASE: ${DB_DATABASE:-laravel}  # 首次啟動自動建立的資料庫
      MYSQL_USER: ${DB_USERNAME:-laravel}      # 首次啟動自動建立的一般帳號
      MYSQL_PASSWORD: ${DB_PASSWORD:-secret}   # 上述帳號的密碼（需與 php 端一致）
    volumes:
      - mysql-data:/var/lib/mysql    # 持久化 MySQL 資料
    ports:
      - "127.0.0.1:3306:3306"        # 方便本機 DB 工具連線；只綁本機
    healthcheck:
      # -h 127.0.0.1 強制走 TCP，初始化期間的暫時 server 不會被誤判為健康（見第四章範例二）
      test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1"]
      interval: 5s
      timeout: 5s
      retries: 20                    # 第一次初始化較久，多給幾次機會
    restart: unless-stopped

  redis:                             # Redis（快取 / session）
    image: redis:7-alpine
    command: redis-server --appendonly yes # 啟用 AOF 持久化
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
    restart: unless-stopped

  # 開發工具：phpMyAdmin（資料庫網頁管理介面）
  phpmyadmin:
    image: phpmyadmin:5
    ports:
      - "127.0.0.1:8080:80"          # 瀏覽器開 http://localhost:8080 進管理頁
    environment:
      PMA_HOST: mysql                # phpMyAdmin 要連的資料庫主機（服務名稱）
    depends_on:
      - mysql
    profiles:
      - dev    # 只在開發環境啟用：需 docker compose --profile dev up 才會啟動（預設不啟動）

volumes:
  mysql-data:                        # MySQL 持久化 Volume
  redis-data:                        # Redis 持久化 Volume
```

### 建立 Laravel 專案並啟動

```bash
cd ~/docker-practice/my-laravel-app

# 1. 讓 Compose 知道你的 UID/GID（php 服務的 user: 會用到）
printf "HOST_UID=$(id -u)\nHOST_GID=$(id -g)\n" > .env

# 2. 建構 PHP 映像（第一次約 1～2 分鐘，主要在編譯擴展）
docker compose build php

# 3. 用「同一個 PHP 映像」建立 Laravel 專案到 src/
#    在 php 容器裡跑 composer，安裝套件時用的 PHP 版本就和執行時完全相同
#    run 會先啟動 depends_on 的 mysql、redis，create-project 最後會自動產生 APP_KEY 並執行 migration
docker compose run --rm php composer create-project laravel/laravel .

# 4. 啟動所有服務
docker compose up -d --wait

# 5. 灌入範例資料（migration 已在第 3 步執行過）
docker compose exec php php artisan migrate --seed
```

驗證：

```bash
# 網站首頁
curl -s http://localhost:8000 | grep -o '<title>[^<]*</title>'
# <title>Laravel</title>

# 確認 Laravel 用的是 MySQL 與 Redis（而不是新專案預設的 sqlite / database）
docker compose exec php php artisan tinker --execute 'echo \App\Models\User::count(), " users; cache=", config("cache.default"), "; session=", config("session.driver"), PHP_EOL;'
# 1 users; cache=redis; session=redis

# 改 PHP 檔立刻生效（opcache.validate_timestamps = 1）
echo "<?php echo 'edited';" > src/public/edit-test.php
curl http://localhost:8000/edit-test.php     # edited
rm src/public/edit-test.php

# 啟動含 phpMyAdmin 的開發環境（帳號 laravel / secret，或 root / rootsecret）
docker compose --profile dev up -d
```

- 網站：http://localhost:8000
- phpMyAdmin：http://localhost:8080（需 `--profile dev`）

```bash
# 練習結束（--profile dev 才會一起停掉 phpmyadmin）
docker compose --profile dev down -v
```

> `docker compose run --rm php composer create-project ...` 如果出現 `Project directory "/var/www/html/." is not empty`，代表 `src/` 裡已經有檔案（例如上次失敗留下的），清空 `src/` 再執行一次。

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
└── myproject/              # Django 專案（稍後由 django-admin 產生）
    ├── manage.py
    └── config/
        ├── __init__.py
        ├── settings.py
        ├── urls.py
        ├── wsgi.py
        └── celery.py       # 自己新增
```

```bash
mkdir -p ~/docker-practice/my-django-app/myproject
cd ~/docker-practice/my-django-app
```

### requirements.txt 與 Dockerfile

```text
# requirements.txt
Django~=5.2
psycopg[binary]~=3.2
celery[redis]~=5.5
gunicorn~=23.0
flower~=2.0
```

- `Django~=5.2`：5.2 是長期支援版（LTS），`~=` 代表接受 5.2.x 的修補版。
- `psycopg[binary]`：PostgreSQL 驅動的預編譯版本，**不需要** gcc、libpq-dev 這些編譯工具，Dockerfile 單純很多。
- `celery[redis]`：Celery 加上 Redis 作為 broker 所需的套件。

```dockerfile
# Dockerfile
FROM python:3.12-slim

# 防止 Python 產生 .pyc 檔案（容器內不需要，保持乾淨）
ENV PYTHONDONTWRITEBYTECODE=1
# 讓 Python 輸出不被緩衝（stdout 即時刷出，docker logs 才看得到即時日誌）
ENV PYTHONUNBUFFERED=1

WORKDIR /app

# 先裝 Python 相依套件（善用快取；--no-cache-dir 不留 pip 快取，縮小映像）
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 複製應用程式碼（開發時會被 bind mount 蓋過；正式部署時用的就是這份）
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

```bash
printf '__pycache__\n*.pyc\n.env\n' > .dockerignore
```

### 環境變數

```bash
# .env
DB_NAME=myapp
DB_USER=postgres
DB_PASSWORD=secret
DB_HOST=db
DB_PORT=5432
CELERY_BROKER_URL=redis://redis:6379/0
CELERY_RESULT_BACKEND=redis://redis:6379/1
SECRET_KEY=change-me-in-production
DEBUG=True
ALLOWED_HOSTS=localhost,127.0.0.1
```

把上面內容存成 `.env`，再加上 UID/GID：

```bash
printf "HOST_UID=$(id -u)\nHOST_GID=$(id -g)\n" >> .env
```

### Docker Compose 設定

web、celery-worker、celery-beat、flower 跑的是同一份程式碼，用第四章範例三的 YAML anchor 寫法共用設定，並且只建構一次映像：

```yaml
# docker-compose.yml

# 共用設定
x-django: &django
  image: my-django-app:dev           # 四個服務共用同一個映像
  pull_policy: never                 # 只在本機建構，不要去 registry 拉
  user: "${HOST_UID:-1000}:${HOST_GID:-1000}" # 用主機使用者身分，寫入 bind mount 的檔案才不會變成別人的
  volumes:
    - ./myproject:/app               # 掛入程式碼，改碼即生效
  env_file: .env                     # 從 .env 注入所有環境變數（DB、Redis、SECRET_KEY 等）
  restart: unless-stopped

services:
  web:                               # Django 網站本體
    <<: *django
    build: .                         # 只有 web 負責建構映像
    command: python manage.py runserver 0.0.0.0:8000 # 開發用伺服器（改碼會自動重載）；正式環境用映像預設的 gunicorn
    ports:
      - "8000:8000"
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy

  celery-worker:                     # Celery worker：執行非同步任務
    <<: *django
    command: celery -A config worker -l info --concurrency=2 # -A config 指定 app；--concurrency=2 同時跑 2 個工作行程
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy

  celery-beat:                       # Celery beat：定時排程器，把週期任務丟進佇列
    <<: *django
    # --schedule：排程狀態檔放 /tmp，不要寫進掛載的專案目錄
    command: celery -A config beat -l info --schedule /tmp/celerybeat-schedule
    depends_on:
      - celery-worker

  flower:                            # Flower：Celery 任務的網頁監控介面（開發工具）
    <<: *django
    command: celery -A config flower --port=5555
    ports:
      - "127.0.0.1:5555:5555"        # 瀏覽器開 http://localhost:5555 查看任務狀態
    depends_on:
      - celery-worker
    profiles:
      - dev                          # 只在 --profile dev 時啟動

  db:                                # PostgreSQL
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: ${DB_NAME:-myapp}      # ${VAR:-預設}：.env 沒設定就用預設值
      POSTGRES_USER: ${DB_USER:-postgres}
      POSTGRES_PASSWORD: ${DB_PASSWORD:-secret}
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "127.0.0.1:5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USER:-postgres} -d ${DB_NAME:-myapp}"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:                             # Redis：當 Celery 的 broker / result backend
    image: redis:7-alpine
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

volumes:
  pgdata:
```

### 建立 Django 專案

```bash
# 1. 建構映像
docker compose build web

# 2. 在容器裡用 django-admin 建立專案到 myproject/（--no-deps：這一步不需要啟動資料庫）
docker compose run --rm --no-deps web django-admin startproject config .

ls myproject
# config  manage.py
```

**3. 讓 settings 改從環境變數讀取。** 在 `myproject/config/settings.py` 最後面加上：

```bash
cat >> myproject/config/settings.py <<'EOF'

# ===== Docker 環境：以下設定改從環境變數讀取 =====
import os

SECRET_KEY = os.environ.get('SECRET_KEY', SECRET_KEY)
DEBUG = os.environ.get('DEBUG', 'False') == 'True'
ALLOWED_HOSTS = os.environ.get('ALLOWED_HOSTS', 'localhost').split(',')

DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.postgresql',
        'NAME': os.environ['DB_NAME'],
        'USER': os.environ['DB_USER'],
        'PASSWORD': os.environ['DB_PASSWORD'],
        'HOST': os.environ.get('DB_HOST', 'db'),     # 用服務名稱 db 連線
        'PORT': os.environ.get('DB_PORT', '5432'),
    }
}

# collectstatic 的輸出目錄（正式環境由 Nginx 提供，見第四章範例三）
STATIC_ROOT = BASE_DIR / 'staticfiles'

# Celery 設定：config/celery.py 會讀取 CELERY_ 開頭的設定
CELERY_BROKER_URL = os.environ['CELERY_BROKER_URL']
CELERY_RESULT_BACKEND = os.environ['CELERY_RESULT_BACKEND']
EOF
```

**4. 建立 Celery app。** `myproject/config/celery.py`：

```python
import os

from celery import Celery

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')

app = Celery('config')
# 從 Django settings 讀取 CELERY_ 開頭的設定
app.config_from_object('django.conf:settings', namespace='CELERY')
# 自動尋找各 Django app 裡的 tasks.py
app.autodiscover_tasks()


@app.task
def add(x, y):
    return x + y


# beat 的週期任務：每 30 秒執行一次 add(2, 3)
app.conf.beat_schedule = {
    'add-every-30-seconds': {
        'task': 'config.celery.add',
        'schedule': 30.0,
        'args': (2, 3),
    },
}
```

`myproject/config/__init__.py`（原本是空檔案，改成以下內容，讓 Django 啟動時一併載入 Celery）：

```python
from .celery import app as celery_app

__all__ = ('celery_app',)
```

### 啟動與驗證

```bash
# 啟動開發環境
docker compose up -d --wait

# 執行資料庫遷移
docker compose exec web python manage.py migrate

# 建立管理員帳號（會互動詢問帳號、Email、密碼）
docker compose exec web python manage.py createsuperuser

# 從 Django 送一個任務給 Celery，等 worker 算完拿回結果
docker compose exec web python manage.py shell -c "from config.celery import add; print(add.delay(2, 3).get(timeout=10))"
# 5

# beat 每 30 秒送一次任務，worker 的日誌會持續出現 succeeded
docker compose logs -f celery-worker
# ... Task config.celery.add[...] succeeded in 0.002s: 5
# （Ctrl+C 離開）

# 啟動含 Flower 的開發環境
docker compose --profile dev up -d
```

- 網站：http://localhost:8000
- Admin：http://localhost:8000/admin
- Flower：http://localhost:5555（需 `--profile dev`）

```bash
# 練習結束
docker compose --profile dev down -v
```

> 想讓排程可以在 Django Admin 裡動態調整，可再加裝 `django-celery-beat`，加入 `INSTALLED_APPS`、執行 migrate 後，beat 改用 `--scheduler django_celery_beat.schedulers:DatabaseScheduler`。

---

## 6.5 實戰四：React（Vite）前端 + API + Nginx

這個實戰的重點是「**瀏覽器裡的程式**要怎麼呼叫容器裡的 API」：前端的 JavaScript 是在**主機的瀏覽器**執行的，不在 Docker 網路裡，看不懂 `http://api:3000` 這種服務名稱。解法是讓前端一律呼叫相對路徑 `/api/...`，再由前面那一層（開發時是 Vite、正式環境是 Nginx）代理到容器裡的 `api:3000`。

```
開發：瀏覽器 → localhost:5173（Vite dev server 容器）──/api──→ api:3000
正式：瀏覽器 → localhost:8080（Nginx 容器，提供打包好的靜態檔）──/api──→ api:3000
```

### 專案結構

```
my-fullstack-app/
├── docker-compose.yml          # 開發用
├── docker-compose.prod.yml     # 正式版本機驗證用
├── frontend/
│   ├── Dockerfile              # 正式：build 後交給 Nginx
│   ├── Dockerfile.dev          # 開發：Vite dev server
│   ├── nginx.conf
│   ├── vite.config.js
│   ├── package.json
│   └── src/
└── backend/
    ├── Dockerfile
    └── server.js
```

### 建立前端專案

```bash
mkdir -p ~/docker-practice/my-fullstack-app/backend
cd ~/docker-practice/my-fullstack-app

# 用 create-vite 建立 React 專案到 frontend/（--no-interactive：不詢問，直接用預設值）
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD":/app -w /app node:24-alpine \
  npm create vite@latest frontend -- --template react --no-interactive

# 產生 package-lock.json（Dockerfile 的 npm ci 需要）
cd frontend
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD":/app -w /app node:24-alpine npm install --package-lock-only
printf 'node_modules\ndist\n' > .dockerignore
cd ..
```

把 `frontend/vite.config.js` 改成：

```javascript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',   // 預設只綁 127.0.0.1，容器外（主機瀏覽器）會連不進來
    port: 5173,
    proxy: {
      // 瀏覽器請求 /api/xxx → Vite 在容器裡轉發到 API_PROXY_TARGET/xxx
      '/api': {
        target: process.env.API_PROXY_TARGET || 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
```

把 `frontend/src/App.jsx` 改成呼叫 API 的簡單畫面：

```jsx
import { useEffect, useState } from 'react'

export default function App() {
  const [data, setData] = useState(null)

  useEffect(() => {
    // 相對路徑：開發時由 Vite 代理、正式環境由 Nginx 代理，程式碼不用改
    fetch('/api/')
      .then((res) => res.json())
      .then(setData)
      .catch((err) => setData({ error: err.message }))
  }, [])

  return (
    <main>
      <h1>Frontend + API</h1>
      <pre>{data ? JSON.stringify(data, null, 2) : 'loading...'}</pre>
    </main>
  )
}
```

### 前端 Dockerfile（開發）

```dockerfile
# frontend/Dockerfile.dev
FROM node:24-alpine

WORKDIR /app
COPY package.json package-lock.json ./
# 開發環境裝完整依賴（含 devDependencies 的 vite）
RUN npm ci
COPY . .

# Vite 開發伺服器預設埠
EXPOSE 5173
# 啟動 Vite 開發伺服器（含 HMR 熱更新）；host 已在 vite.config.js 設為 0.0.0.0
CMD ["npm", "run", "dev"]
```

### 後端 API

```javascript
// backend/server.js
const http = require('node:http');

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200);
    return res.end('ok\n');
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message: 'Hello from API', path: req.url, time: new Date().toISOString() }) + '\n');
});

server.listen(3000, '0.0.0.0', () => console.log('api listening on 3000'));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
```

```dockerfile
# backend/Dockerfile
FROM node:24-alpine
WORKDIR /app
COPY server.js .
USER node
EXPOSE 3000
CMD ["node", "server.js"]
```

### Docker Compose 設定（開發）

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
      - ./frontend/src:/app/src      # 只掛原始碼目錄，改碼即時 HMR（node_modules 不受影響）
    environment:
      # Vite proxy 的轉發目標：這段程式在「容器內」執行，所以用服務名稱 api
      API_PROXY_TARGET: http://api:3000
    depends_on:
      - api

  api:                               # 後端 API
    build: ./backend
    ports:
      - "3000:3000"                  # 方便直接用 curl 測 API；前端並不需要這個對外 port
```

```bash
docker compose up -d --build --wait

# 透過 Vite 的 proxy 呼叫 API（瀏覽器實際走的路徑）
curl http://localhost:5173/api/
# {"message":"Hello from API","path":"/","time":"..."}
```

瀏覽器開 http://localhost:5173 會看到 API 的回應。修改 `frontend/src/App.jsx` 的標題並存檔，頁面會立即熱更新（HMR）。

> 位址怎麼寫，取決於「程式在哪裡執行」：
>
> | 程式在哪裡執行 | 要連 API 時寫 |
> |--|--|
> | 主機的瀏覽器（React 程式碼） | `/api/...`（相對路徑）或 `http://localhost:3000` |
> | 容器內（Vite proxy、Nginx、其他後端服務） | `http://api:3000`（服務名稱） |
> | 主機上的指令（curl、Postman） | `http://localhost:3000`（透過 ports 對映） |

### 前端 Dockerfile（生產）

```dockerfile
# frontend/Dockerfile
# ===== 建構階段 =====
# 用 Node 把前端原始碼打包成靜態檔；此階段含完整 build 工具，不會進到最終映像
FROM node:24-alpine AS builder

WORKDIR /app
# 先裝依賴（善用快取）
COPY package.json package-lock.json ./
RUN npm ci
# 再複製原始碼並建構，產物輸出到 /app/dist
COPY . .
RUN npm run build

# ===== 生產階段 =====
# 最終映像只用輕量 Nginx 提供靜態檔，不含 Node 與 node_modules（體積極小）
FROM nginx:1.30-alpine

# 複製自訂的 Nginx 站台設定
COPY nginx.conf /etc/nginx/conf.d/default.conf
# 關鍵：用 --from=builder 從建構階段把打包好的 dist 複製進來當網站內容
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80
# 前景執行 Nginx：daemon off 讓 nginx 不要背景化，否則容器主程序結束會立刻退出
CMD ["nginx", "-g", "daemon off;"]
```

### 前端 Nginx 設定

```nginx
# frontend/nginx.conf
server {
    listen 80;                       # 監聽 80 埠
    root /usr/share/nginx/html;      # 靜態檔根目錄（對應 Dockerfile 複製進來的 dist）
    index index.html;                # 預設首頁

    # 使用 Docker 內建 DNS 解析服務名稱；valid=10s：每 10 秒重新解析一次
    resolver 127.0.0.11 valid=10s;

    # SPA 路由：所有找不到實體檔的路徑都回 index.html，交給前端框架自己處理路由
    location / {
        # 依序找 $uri（實體檔）→ $uri/（目錄）→ 都沒有就回 index.html
        try_files $uri $uri/ /index.html;
    }

    # API 反向代理：把 /api/ 開頭的請求轉給後端 api 容器，瀏覽器只跟同一個網域溝通，也就沒有跨域（CORS）問題
    location /api/ {
        # 把位址放進變數：Nginx 才會在「每次請求時」透過上面的 resolver 解析 api
        set $api_upstream http://api:3000;
        # 去掉 /api 前綴再轉給後端：/api/hello → /hello
        rewrite ^/api/(.*)$ /$1 break;
        proxy_pass $api_upstream;
        # 以下三個 header 讓後端知道「原始請求」的真實資訊（否則後端只看到 Nginx）
        proxy_set_header Host $host;                              # 保留原始主機名
        proxy_set_header X-Real-IP $remote_addr;                 # 真實客戶端 IP
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; # 經過的代理鏈 IP 列表
    }

    # 靜態資源（JS/CSS/圖片/字型）長期快取，加速重複載入
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff2?)$ {
        expires 1y;                  # 瀏覽器快取 1 年
        # immutable 告訴瀏覽器「這檔不會變」，連條件式請求都省了（Vite 產生的檔名帶 hash，改版即換檔名）
        add_header Cache-Control "public, immutable";
    }
}
```

> 為什麼不直接寫 `proxy_pass http://api:3000/;`？Nginx 遇到寫死的主機名稱，只在**啟動時**解析一次：
>
> - 啟動當下 `api` 容器不存在（還沒起來、或剛好在重建），Nginx 會出現 `host not found in upstream "api"` 並直接啟動失敗。
> - `api` 容器重建後換了 IP，Nginx 仍連舊 IP，回 502，直到 Nginx 重啟。
>
> 改用 `resolver` + 變數後，每次請求都重新解析，`api` 暫時不在時只回 502，等它回來就自動恢復。

### 本機驗證正式版

```yaml
# docker-compose.prod.yml
services:
  frontend:
    build: ./frontend                # 使用正式版 Dockerfile（Nginx）
    ports:
      - "8080:80"
    depends_on:
      - api

  api:
    build: ./backend                 # 正式版不需要對外開 3000，只讓 Nginx 在內部連
```

```bash
# 先停掉開發環境（兩個設定檔在同一個目錄，專案名稱相同）
docker compose down

# 用 -f 指定只讀正式版設定
docker compose -f docker-compose.prod.yml up -d --build --wait

curl http://localhost:8080/api/hello
# {"message":"Hello from API","path":"/hello",...}

# SPA 的深層路徑也回 200（由 try_files 回 index.html）
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/some/page
# 200

# 重建 api 容器（IP 可能改變），Nginx 不用重啟也連得到
docker compose -f docker-compose.prod.yml up -d --force-recreate --no-deps api
sleep 11
curl http://localhost:8080/api/after

docker compose -f docker-compose.prod.yml down
```

---

## 6.6 開發環境常見技巧

### docker compose watch：不用 bind mount 的 hot reload

bind mount 在 Docker Desktop 上較慢（第五章情境三），還有 `node_modules` 被蓋掉的問題。`docker compose watch` 改由 Compose 監看主機檔案，把有變動的檔案**同步**進容器，或在依賴改變時**自動重建**映像。

以 6.2 的 `my-express-app` 為例，把 `docker-compose.override.yml` 的 `api` 改成用 `develop.watch`（拿掉 `volumes`）：

```yaml
# docker-compose.override.yml
services:
  api:
    build:
      target: dev
    ports:
      - "3000:3000"
      - "9229:9229"
    environment:
      NODE_ENV: development
    develop:
      watch:
        # src/ 有變動 → 把檔案同步進容器的 /app/src（nodemon 會偵測到並重啟）
        - action: sync
          path: ./src
          target: /app/src
        # package.json 有變動 → 重建映像並重建容器（新套件會在 npm ci 時裝好）
        - action: rebuild
          path: package.json
```

```bash
cd ~/docker-practice/my-express-app
docker compose up -d --build --wait

# 啟動監看（前景執行，Ctrl+C 結束監看；容器會繼續跑）
docker compose watch
# Watch enabled

# 另開一個終端修改 src/server.js 並存檔
# watch 的終端會顯示：Syncing service "api" after 1 changes were detected
```

| | bind mount | `docker compose watch` |
|--|--|--|
| 檔案怎麼進容器 | 主機目錄直接掛進去 | Compose 偵測到變動才複製進去 |
| Docker Desktop 上的效能 | 較慢 | 接近原生 |
| `node_modules` 被蓋掉 | 會（要靠匿名 volume 技巧） | 不會（只同步指定目錄） |
| 套件變動 | 要手動重建 | `rebuild` 自動處理 |
| 容器內產生的檔案回到主機 | 會 | 不會（單向同步） |

`action` 還有 `sync+restart`：同步後重啟容器，適合沒有內建 hot reload、但改設定檔需要重啟的服務（例如 Nginx 設定）。

### 使用 Makefile 簡化指令

```makefile
# Makefile
# 把常用的長指令包成短命令（make up / make logs ...），團隊好記又一致
# .PHONY：宣告這些是「指令名稱」而非真實檔案，避免目錄剛好有同名檔案時 make 不執行
# 注意：Makefile 的指令行必須用 Tab 縮排，不能用空白
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

# 完整清理本專案：容器、網路、volume、本專案建構的映像（⚠️ 會刪資料庫資料）
# 不用 docker system prune：那會清掉這台機器上「所有專案」未使用的資源
clean:
	docker compose down -v --rmi local
```

```bash
# 使用方式
# 啟動所有服務（背景）
make up
# 持續追蹤日誌
make logs
# 進入 API 容器 shell
make shell
```

> `migrate`、`seed`、`test` 對應的是 `package.json` 裡的 npm scripts，請依自己的專案調整。

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
    environment:
      POSTGRES_PASSWORD: secret

  # 開發工具：有 profiles 的服務「預設不啟動」，要加 --profile dev 才會起來
  pgadmin:                           # PostgreSQL 的網頁管理介面
    image: dpage/pgadmin4
    ports:
      - "127.0.0.1:5050:80"
    environment:
      PGADMIN_DEFAULT_EMAIL: admin@example.com # 登入帳號
      PGADMIN_DEFAULT_PASSWORD: admin          # 登入密碼
    profiles:
      - dev                          # 歸類到 dev profile

  mailpit:                           # 攔截開發環境寄出的信件，提供假 SMTP + 網頁收件匣
    image: axllent/mailpit
    ports:
      - "127.0.0.1:8025:8025"        # 8025：網頁收件匣 UI
      - "127.0.0.1:1025:1025"        # 1025：假的 SMTP 埠（應用把信寄到 mailpit:1025）
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

# 停止時也要帶 profile，否則有 profile 的服務不會被停掉
docker compose --profile dev --profile test down
```

---

## 6.7 實際情境

### 情境一：hot reload 不生效

**問題**：修改原始碼後容器內的應用沒有自動重啟

```bash
# 排查步驟

# 1. 確認檔案有同步到容器（在主機改完後，容器內看到的內容有沒有變）
docker compose exec api cat /app/src/server.js | head -5

# 2. 確認 nodemon / 開發伺服器是否正在監聽
docker compose logs -f api
```

- **第 1 步看到的是舊內容**：掛載路徑寫錯（例如掛到 `/app/source`，程式卻在 `/app/src`），或用了 `docker compose watch` 但沒有執行 `docker compose watch`。
- **內容是新的、但程式沒重啟**：容器收不到檔案變動通知。最常見於 Windows 把專案放在 `/mnt/c/...`（Windows 磁碟）上，這時檔案變動事件傳不進 Linux 容器。最好的解法是把專案搬到 WSL2 的檔案系統（第一章）；搬不了就改用輪詢（polling），定時主動檢查檔案：

```json
// nodemon.json（放在專案根目錄）
{
  "watch": ["src"],
  "ext": "js,ts,json",
  "legacyWatch": true,
  "pollingInterval": 1000
}
```

```javascript
// vite.config.js 的 server 區塊加上
watch: {
  usePolling: true,
  interval: 1000,
},
```

polling 會持續佔用一些 CPU，確定是檔案事件的問題才用。

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

搭配第四章的 `${DB_PASSWORD:?請在 .env 設定 DB_PASSWORD}`，缺少必要變數時 `docker compose up` 會直接告訴對方少了什麼。

### 情境三：新增套件後容器裡找不到

**問題**：把整個專案目錄掛進容器時，主機的目錄會蓋掉映像裡的 `node_modules`

```yaml
# ❌ 錯誤
services:
  api:
    volumes:
      - .:/app    # 主機的目錄（沒有 node_modules，或是 macOS/Windows 編譯的版本）蓋掉了容器內的

# ✅ 正確：使用匿名 Volume 保護 node_modules
services:
  api:
    volumes:
      - .:/app
      - /app/node_modules    # 匿名 Volume：第一次建立時會複製映像裡裝好的套件（見第五章 5.3）
```

但匿名 volume 帶來另一個問題：**package.json 加了新套件、重建映像之後，容器裡還是舊的 node_modules**，出現 `Cannot find module 'xxx'`。

原因：Compose 重建容器時會**沿用**舊容器的匿名 volume，而 volume 裡已經有資料，就不會再從新映像複製（第五章 5.3 的表）。

```bash
# ❌ 只重建映像：映像裡有新套件，但容器掛的還是舊的匿名 volume
docker compose up -d --build

# ✅ 加上 -V（--renew-anon-volumes）：重建時改用全新的匿名 volume，從新映像重新複製
docker compose up -d --build -V

# 或在執行中的容器裡直接安裝（裝進匿名 volume，下次 -V 重建前都有效）
docker compose exec api npm install
```

最根本的做法是只掛原始碼目錄（6.2 的 `./src:/app/src`），或改用 `docker compose watch`（6.6），就不會有這個問題。

---

## 6.8 本章小結

- Docker 開發環境讓團隊快速上手，`docker compose up` 即可開始工作
- 建立專案（npm、composer、django-admin）也在容器裡做，主機只需要 Docker
- 用 Dockerfile 的多個階段（`target: dev` / `production`）區分開發與正式，不必維護兩份 Dockerfile
- 使用 `docker-compose.override.yml` 自動載入開發環境設定
- 只掛原始碼目錄，或用 `docker compose watch`；必須掛整個專案時，用匿名 Volume 保護 `node_modules`，套件更新後用 `up -d --build -V`
- 瀏覽器裡的前端程式用相對路徑 `/api`，由 Vite / Nginx 代理到容器內的服務名稱
- 善用 `profiles` 區分核心服務與開發工具
- 建立 `Makefile` 簡化常用指令

---

> 上一章：[Docker 網路與資料持久化](./05-networking-volumes.md) | 下一章：[Registry 與映像管理](./07-registry-image-mgmt.md)
