# 第四章：Docker Compose 多容器編排

## 4.1 什麼是 Docker Compose？

Docker Compose 是一個用來定義和管理多容器應用的工具。透過一個 YAML 檔案（`docker-compose.yml`），你可以一次定義、啟動和管理多個互相關聯的服務。

### 為什麼需要 Docker Compose？

- 沒有 Docker Compose 的世界：

```bash
# 啟動資料庫
# -d: 背景執行
# --name db: 容器命名為 db
# -e POSTGRES_PASSWORD=secret: 設定 PostgreSQL 初始化密碼
# -v pgdata:/var/lib/postgresql/data: 把資料寫到 named volume，避免容器刪除後資料遺失
# postgres:16: 使用 PostgreSQL 16 映像
docker run -d --name db -e POSTGRES_PASSWORD=secret -v pgdata:/var/lib/postgresql/data postgres:16

# 啟動 Redis
# redis:7-alpine: 使用較小體積的 Alpine 變體
docker run -d --name redis redis:7-alpine

# 啟動後端 API
# -p 3000:3000: 主機 3000 對映到容器 3000
# -e DB_HOST=db / -e REDIS_HOST=redis: 傳入後端要連的服務主機名稱
# --link: 舊式容器連線方式（legacy），在 Compose 通常改用同一 network + 服務名解析
docker run -d --name api -p 3000:3000 -e DB_HOST=db -e REDIS_HOST=redis --link db --link redis my-api

# 啟動前端
# -p 80:80: 主機 80 對映到前端容器 80
docker run -d --name web -p 80:80 --link api my-frontend

# 停止時要一個一個停...
# 依序停止多個容器（名稱可一次帶多個）
docker stop web api redis db
# 刪除已停止的容器（仍需逐一列出）
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
    networks:
      - app-network

  api:
    build: ./backend
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
    networks:
      - app-network

  db:
    image: postgres:16-alpine
    # 上面（services.*.volumes）= 這個服務要「掛載/使用」哪些 volume
    volumes:
      - pgdata:/var/lib/postgresql/data
    environment:
      POSTGRES_PASSWORD: secret
    # 上面（services.*.networks）= 這個服務要加入哪些 network
    networks:
      - app-network

# 具名 Volume 宣告
# 下面（頂層 volumes）= volume 資源「本體定義」位置
# 可在這裡集中設定 driver / external 等選項
volumes:
  # 冒號後留空是合法寫法，代表使用預設設定建立 named volume
  # 等價寫法：pgdata: {}
  pgdata:

# 自訂網路宣告
# 下面（頂層 networks）= network 資源「本體定義」位置
# 可在這裡設定 internal / ipam / driver 等網路屬性
networks:
  # 冒號後留空是合法寫法，代表使用預設設定建立 network
  # 等價寫法：app-network: {}
  app-network:
```

上面跟下面的差別（最容易搞混）：

| 位置 | 作用 | 例子 |
|------|------|------|
| `services.<name>.volumes` / `services.<name>.networks`（上面） | **引用資源**：宣告「這個服務要用哪些 volume/network」 | `db` 服務使用 `pgdata`、加入 `app-network` |
| `volumes:` / `networks:`（下面） | **定義資源本體**：宣告資源本身與設定（driver、external、internal...） | 定義 `pgdata` 這個 volume、`app-network` 這個 network |

這樣設置的原因與注意事項：

- `services`：每個服務（`web`/`api`/`db`）各自描述映像、埠、環境變數與掛載規則。
- `volumes`（頂層）：
  - **有用到 named volume 時，建議宣告在頂層**（像 `pgdata`），可讀性高，也方便加進階設定。
  - bind mount（例如 `./data:/data`）通常不需要在頂層 `volumes` 宣告。
- `networks`（頂層）：
  - 服務若要加入自訂網路（如 `app-network`），建議在頂層明確定義其屬性。
  - 若完全不寫 `services.*.networks`，Compose 會自動建立預設網路讓服務互連。
- 安全性注意：`POSTGRES_PASSWORD` 建議改成 `.env` 或 secret，不要明文寫在版本庫。

頂層 `volumes` / `networks` 一定要寫嗎？

- **不一定。** 只用預設網路、或只用 bind mount 時，可以不寫頂層區塊。
- **建議要寫。** 當你使用 named volume、自訂 network，或需要進階屬性（`external` / `driver` / `internal`）時。
- 若設定 `external: true`，代表資源由 Compose 外部管理，Compose 不會幫你建立。

`external`、`driver`、`internal` 範例：

```yaml
volumes:
  # driver：指定 volume driver（local 是最常見預設）
  pgdata:
    driver: local

  # external：使用已存在的 volume（Compose 不會建立/刪除它）
  shared-assets:
    external: true
    name: company_shared_assets

networks:
  # driver：指定網路驅動（單機常見 bridge）
  app-network:
    driver: bridge

  # internal：只允許容器間內部通訊，不直接對外
  backend-internal:
    internal: true

  # external：使用已存在的 network
  corp-net:
    external: true
    name: corp_shared_network
```

> 使用 `external: true` 前，請先建立資源（例如 `docker volume create company_shared_assets`、`docker network create corp_shared_network`）。

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
        # 快取來源（image tag），不是本機檔案路徑
        # 通常是前一次建構後推到 registry 的快取映像
        - myregistry.com/web:cache
```

`cache_from` 要從哪裡取得？

- `myregistry.com/web:cache` 不是檔案，而是「registry 上的映像標籤」。
- 常見來源：CI/CD 在前一次建構後，把可重用層推到這個 tag。
- 若該 tag 不存在，建構仍可進行，只是快取命中率會降低（可能變慢）。

常見做法（概念）：

```bash
# 先嘗試拉取快取來源（不存在可忽略）
docker pull myregistry.com/web:cache || true

# 建構後更新 cache tag（供下一次 cache_from 使用）
docker build -t myregistry.com/web:cache ./frontend
docker push myregistry.com/web:cache
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
        protocol: tcp       # 協定（tcp / udp）
        mode: host          # 發佈模式：直接綁定主機 port（單機 Compose 通常可省略，寫出來較清楚）
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
    # Compose 會依清單順序由上到下讀取 env_file
    # 若兩個檔案有同名變數，後面檔案會覆蓋前面檔案（此例 .env.production 會覆蓋 .env）
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
# ${VAR} 這種寫法是「Compose 變數替換（interpolation）」
# 預設會自動讀取專案目錄下的 .env（不需另外在 service 內設定 env_file）
# 若不是使用預設檔名 .env，請在命令列改用 --env-file 指定
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

```bash
# 使用預設 .env（Compose 會自動讀取）
docker compose up -d

# 指定其他環境變數檔（例如 .env.production）
docker compose --env-file .env.production up -d
```

> 補充：`--env-file .env.production`（或預設 `.env`）主要是給 Compose 在解析 `docker-compose.yml` 時做 `${VAR}` 變數替換，**不會**自動把檔案內所有變數注入容器。  
> 真正要把變數放進容器，請使用 service 的 `environment` 或 `env_file`。  
> 例如：`environment: DB_PASSWORD: ${DB_PASSWORD}` 會把替換後的 `DB_PASSWORD` 傳進容器；沒有被引用的變數不會自動進容器。

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
      # 這不是語法上的 exclude，而是用「子路徑掛載」覆蓋 /app/node_modules
      # 這樣主機 ./backend/node_modules 就不會蓋到容器內安裝的依賴
      - /app/node_modules

# 頂層 Volume 宣告（具名 Volume）
# 宣告後可在 services.*.volumes 以名稱引用（例如 pgdata:/var/lib/postgresql/data）
# 具名 Volume 的生命週期獨立於容器，docker compose down 不加 -v 時資料會保留
volumes:
  pgdata:
    driver: local   # 資料會放在 Docker 主機的 volume 儲存區（不是專案資料夾），由 Docker 自動建立與管理
  redis-data:       # 未指定 driver 時預設也是 local，行為與上面相同
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
      # condition 是 Docker Compose 規範內建欄位（depends_on.condition）
      # service_healthy：要等 db 的 healthcheck 狀態變成 healthy 才會啟動 worker
      db:
        condition: service_healthy
      # service_started：只要 redis 容器已啟動（running）就會繼續，不會等健康檢查通過
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

> `service_started` / `service_healthy` 不是你自訂的字串，而是 Docker Compose 在 `depends_on.condition` 內建的條件值。  
> 常見條件有 3 種：`service_started`、`service_healthy`、`service_completed_successfully`（一次性任務常用）。
>
> - `service_started`：依賴服務「容器已啟動」就算成立（不等健康檢查）
> - `service_healthy`：依賴服務必須有 `healthcheck`，且狀態要變成 `healthy`
> - `service_completed_successfully`：依賴服務要先執行完且 exit code 為 0（常用於 migration job）
>
> 實務上：資料庫通常用 `service_healthy`；快取或不需嚴格就緒判定的服務可用 `service_started`。

### networks — 網路設定

- networks（含 internal: true）在管「容器之間、以及容器能不能往外連」

```yaml
services:
  web:
    networks:
      - frontend   # 前台網段（通常承接對外流量）

  api:
    networks:
      - frontend   # 可被 web 存取
      - backend    # 可存取 db

  db:
    networks:
      - backend    # 僅內部網段可見

networks:
  frontend:        # 預設網段（可對外）
  backend:
    internal: true  # 外部隔離網段：同網段容器可互通，但不提供直接對外連線
```

> 這個範例的重點是做「網路分層」：`web` 只在 `frontend`，`db` 只在 `backend`，所以 `web` 不能直接連 `db`，要透過同時連兩個網段的 `api`。  
> `internal: true` 的主要意思是：這個網段給內部服務互連用，不讓該網段的容器直接對外連線。若你也不在 `db` 設定 `ports`，外部就更無法直接打到資料庫。
>
> 快速判斷（`internal` 與 `ports` 是兩個不同層次）：  
> - `internal: true` + **無** `ports`：同網段容器可互連；主機/外部無法直接連入；容器也不能直接對外。  
> - `internal: true` + **有** `ports`：通常仍可透過映射埠從主機連入；但容器對外連線限制依然存在。  
> - `internal: false` + **無** `ports`：容器可對外；但主機/外部仍無法直接連入該服務。  
> - `internal: false` + **有** `ports`：主機/外部可透過映射埠直接連入。  
>
> 結論：`internal: true` 不是「等設定 `ports` 才生效」，兩者互相獨立；資料庫服務通常建議不開 `ports`。

### restart — 重啟策略

```yaml
services:
  api:
    restart: unless-stopped    # 常駐服務推薦：異常退出會重啟；若你手動 stop，之後不會被自動拉起

  db:
    restart: always            # 強制維持運行：幾乎任何停止情況都會嘗試重啟（含 Docker daemon 重啟後）

  worker:
    restart: on-failure        # 只在非 0 exit code 時重啟；正常結束（exit 0）不會重啟
    # 或帶最大重試次數（此寫法主要用於 Swarm）
    deploy:
      restart_policy:
        condition: on-failure  # 只在失敗時重啟
        max_attempts: 5        # 最多重啟 5 次
```

> 補充：一般 `docker compose up`（非 Swarm）以 `restart` 欄位為主；`deploy.restart_policy` 主要給 `docker stack deploy`（Swarm）使用。  
> `always` 與 `unless-stopped` 的差別在「手動 stop 之後」：`unless-stopped` 會尊重你的手動停止，不會在 daemon 重啟後自動拉起。

### 資源限制

```yaml
services:
  api:
    deploy:
      resources:
        limits:
          cpus: '1.0'     # 硬上限：最多使用 1 顆 CPU
          memory: 512M    # 硬上限：最多 512MB，超過可能被 OOM Kill
        reservations:
          cpus: '0.5'     # 預留值：排程時預留 0.5 顆 CPU
          memory: 256M    # 預留值：排程時預留 256MB 記憶體
```

> `limits` 是「上限」，`reservations` 是「預留需求」（偏排程語意）。  
> `deploy.resources` 在 Swarm（`docker stack deploy`）會完整生效；單機 `docker compose up` 是否完全套用，會受 Compose/Engine 版本影響，建議實測確認。
>
> 可用以下方式驗證容器實際資源限制：
>
> ```bash
> docker compose up -d
> CID=$(docker compose ps -q api)
> docker inspect "$CID" --format 'NanoCpus={{.HostConfig.NanoCpus}} Memory={{.HostConfig.Memory}}'
> ```

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
docker compose exec api bash              # 進入「已在執行」的容器（若映像沒有 bash 改用 sh）
docker compose exec db psql -U postgres    # 連線 PostgreSQL
docker compose run api npm test            # 建立一次性容器執行指令（不會用到既有 api 容器）

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

> 多檔案合併規則：後面 `-f` 的檔案優先權較高（同欄位會覆蓋前者）。  
> 例如上例是 `docker-compose.prod.yml` 覆蓋 `docker-compose.yml` 的同名設定。

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
