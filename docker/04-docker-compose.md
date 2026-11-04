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
# V1（已停止維護，使用 docker-compose 獨立指令，有連字號）
docker-compose up -d

# V2 之後（整合進 Docker CLI，沒有連字號）
docker compose up -d

# 本課程統一使用 docker compose 語法
# docker compose version 顯示 v2.x 或更新的版本號（例如 v5.x）都屬於整合版，用法相同
```

### 設定檔名稱與專案名稱

- **設定檔**：`docker compose` 會在目前目錄依序找 `compose.yaml`、`compose.yml`、`docker-compose.yaml`、`docker-compose.yml`。`compose.yaml` 是規格建議的新名稱，本課程沿用最常見的 `docker-compose.yml`，兩者用法完全相同。
- **專案名稱**：預設是設定檔所在的**目錄名稱**。Compose 建立的容器、網路、volume 都會加上這個前綴，例如在 `compose-demo` 目錄啟動時：
  - 容器：`compose-demo-db-1`
  - volume：`compose-demo_pgdata`
  - 網路：`compose-demo_default`

  這就是為什麼之後用 `docker volume ls` 看到的名稱和 YAML 裡寫的 `pgdata` 不一樣。要固定專案名稱，可在設定檔最上方寫 `name: myproject`，或執行時加 `-p myproject`。兩個專案若在同名目錄（例如都叫 `app`），會被當成同一個專案而互相覆蓋，這時就要指定不同的專案名稱。

---

## 4.2 docker-compose.yml 基本結構

```yaml
# docker-compose.yml

# 不再需要指定 version（Compose V2 會自動判斷）
services:
  # 服務名稱
  web:
    image: nginx:1.30-alpine
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
    image: nginx:1.30-alpine

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
        # 快取來源：registry 上的快取（不是本機檔案路徑）
        - type=registry,ref=myregistry.com/web:buildcache
      cache_to:
        # 建構完把快取寫回 registry，供下一次（例如 CI 的新機器）使用
        - type=registry,ref=myregistry.com/web:buildcache,mode=max
```

`cache_from` / `cache_to` 的作用與第三章 3.7 情境四的 `docker buildx build --cache-from/--cache-to` 相同。快取不存在時建構仍會進行，只是比較慢。本機開發不需要設定，Docker 本身就有本機建構快取。

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

  db:
    ports:
      # 開發時讓本機工具連資料庫：只綁 127.0.0.1，區網的其他電腦連不到（理由見第二章 2.2）
      - "127.0.0.1:5432:5432"

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

變數替換的進階寫法：

| 寫法 | 意思 |
|------|------|
| `${VAR}` | 取 `VAR` 的值；沒設定時變成空字串，並印出警告 |
| `${VAR:-default}` | `VAR` 沒設定或是空字串時，用 `default` |
| `${VAR:?錯誤訊息}` | `VAR` 沒設定或是空字串時，**直接中止**並顯示錯誤訊息（必填的密碼很適合用這個） |
| `$$` | 字面上的 `$`。想把 `$HOME` 原封不動交給容器內的 shell 解析時，要寫成 `$$HOME` |

兩組優先順序容易搞混，分開記：

- **`${VAR}` 替換時的值從哪來**（高 → 低）：執行 `docker compose` 那個 shell 的環境變數 → `--env-file` 指定的檔案（沒指定時是專案目錄的 `.env`）。所以 shell 裡殘留的 `export DB_PASSWORD=...` 會蓋掉 `.env`。
- **容器內最後拿到的值**（高 → 低）：`docker compose run -e` → `environment` → `env_file` → Dockerfile 的 `ENV`。

用 `docker compose config` 可以看到替換完成後的最終設定，排查「變數到底是哪個值」時最可靠。

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
      # 注意：這個匿名 volume 在容器重建時會被沿用，package.json 改了之後要用 docker compose up -d --build -V（見第六章 6.7 情境三）
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

  importer:
    restart: on-failure:5      # 帶最大重試次數：失敗最多重啟 5 次就放棄
```

> 補充：一般 `docker compose up` 以 `restart` 欄位為主；`deploy.restart_policy` 是 Swarm（`docker stack deploy`）的寫法，單機請用 `restart`。  
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
> 單機 `docker compose up` 會套用 `deploy.resources` 的 CPU 與記憶體限制，也會依 `deploy.replicas` 啟動多個容器。`deploy` 底下只有 `update_config`、`rollback_config`、`placement` 這類排程與滾動更新設定是 Swarm 專屬，單機 Compose 會忽略（第十三章 13.9 有對照表）。
>
> 可用以下方式驗證容器實際資源限制：
>
> ```bash
> docker compose up -d
> CID=$(docker compose ps -q api)
> docker inspect "$CID" --format 'NanoCpus={{.HostConfig.NanoCpus}} Memory={{.HostConfig.Memory}}'
> # NanoCpus=1000000000 Memory=536870912   ← 1 顆 CPU、512MB
> ```

---

## 4.4 完整實戰範例

### 範例一：Node.js + PostgreSQL + Redis（跟著做）

這個範例附完整程式，可以從頭做到尾：API 每次被呼叫時，把計數 +1 存進 Redis，並從 PostgreSQL 讀出 `init.sql` 建立的資料。

**1. 建立目錄結構**

```bash
mkdir -p ~/docker-practice/compose-demo/backend ~/docker-practice/compose-demo/database
cd ~/docker-practice/compose-demo
```

完成後的結構：

```
compose-demo/
├── docker-compose.yml
├── .env
├── backend/
│   ├── .dockerignore
│   ├── Dockerfile
│   ├── package.json
│   ├── package-lock.json
│   └── server.js
└── database/
    └── init.sql
```

**2. 後端程式**

`backend/package.json`：

```json
{
  "name": "compose-demo-api",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "start": "node server.js"
  }
}
```

`backend/server.js`：

```javascript
const http = require('node:http');
const { Pool } = require('pg');
const { createClient } = require('redis');

// 連線資訊全部來自環境變數（由 docker-compose.yml 的 environment 提供）
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});
const redis = createClient({ url: process.env.REDIS_URL });
redis.on('error', (err) => console.error('redis error:', err.message));

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/health') {
      // 資料庫與 Redis 都連得上才算健康
      await pool.query('SELECT 1');
      await redis.ping();
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok\n');
    }
    if (req.url === '/') {
      const visits = await redis.incr('visits');                                // 每次請求 +1，存在 Redis
      const { rows } = await pool.query('SELECT title FROM notes ORDER BY id'); // 讀 init.sql 建的資料
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ visits, notes: rows.map((r) => r.title) }) + '\n');
    }
    res.writeHead(404);
    res.end('not found\n');
  } catch (err) {
    res.writeHead(500);
    res.end(`error: ${err.message}\n`);
  }
});

async function main() {
  await redis.connect();
  server.listen(3000, '0.0.0.0', () => console.log('api listening on 3000'));
}

// docker compose stop / down 時優雅關閉：停止接新連線，關掉 Redis 與資料庫連線池
process.on('SIGTERM', () => {
  server.close(async () => {
    await redis.close();
    await pool.end();
    process.exit(0);
  });
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

安裝套件並產生 lock file（`--package-lock-only`：只更新 `package.json` 與 `package-lock.json`，不在主機上產生 `node_modules`）：

```bash
cd backend
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD":/app -w /app node:24-alpine npm install --package-lock-only pg redis
printf 'node_modules\n' > .dockerignore
cd ..
```

**3. 資料庫初始化 SQL**

`database/init.sql`：

```sql
CREATE TABLE notes (
  id    SERIAL PRIMARY KEY,
  title TEXT NOT NULL
);

INSERT INTO notes (title) VALUES
  ('這筆資料由 init.sql 在資料庫第一次初始化時建立'),
  ('之後重啟容器不會再執行 init.sql');
```

**4. 密碼放在 `.env`**

```bash
printf 'DB_PASSWORD=devpassword\n' > .env
```

**5. `docker-compose.yml`**

```yaml
# docker-compose.yml
services:
  api:                                 # 後端 API 服務
    build:
      context: ./backend               # 建構上下文：用 ./backend 目錄的內容來 build
      dockerfile: Dockerfile           # 指定使用的 Dockerfile（檔名就是預設值，可省略）
    ports:
      - "3000:3000"                    # 主機 3000 對映到容器 3000（格式為 主機埠:容器埠）
    environment:
      NODE_ENV: production             # 讓 Node 應用以正式模式啟動
      DB_HOST: db                      # 用「服務名稱 db」連線，由 Compose 內建 DNS 解析（不要寫 localhost）
      DB_PORT: 5432                    # PostgreSQL 預設埠
      DB_NAME: myapp                   # 要連線的資料庫名稱
      DB_USER: postgres                # 資料庫帳號
      # 從 .env 的 DB_PASSWORD 帶入，避免把密碼明文寫死在此檔；:? 表示沒設定就直接報錯中止
      DB_PASSWORD: ${DB_PASSWORD:?請在 .env 設定 DB_PASSWORD}
      REDIS_URL: redis://redis:6379    # Redis 連線字串，同樣用服務名稱 redis
    depends_on:
      db:
        condition: service_healthy     # 等 db 健康檢查通過才啟動 api（不只是容器有起來）
      redis:
        condition: service_healthy     # 等 redis 健康檢查通過才啟動 api
    healthcheck:
      # node:24-alpine 沒有 curl，用內建的 wget；網址用 127.0.0.1（原因見第三章 3.2 HEALTHCHECK）
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/health"]
      interval: 10s
      timeout: 3s
      retries: 3
      start_period: 5s
    restart: unless-stopped            # 異常退出會自動重啟；但你手動 stop 後不會被自動拉起
    networks:
      - app-network                    # 加入下方定義的 app-network

  db:                                  # PostgreSQL 資料庫服務
    image: postgres:16-alpine          # 官方 PostgreSQL 16 的 alpine 精簡映像
    environment:
      POSTGRES_DB: myapp               # 容器第一次啟動時自動建立的資料庫
      POSTGRES_USER: postgres          # 初始化的超級使用者帳號
      POSTGRES_PASSWORD: ${DB_PASSWORD:?請在 .env 設定 DB_PASSWORD} # 初始化密碼（從 .env 帶入）
    volumes:
      - pgdata:/var/lib/postgresql/data # 具名 Volume 持久化資料，容器刪除重建後資料仍在
      # 首次初始化時自動執行的 SQL：只有資料目錄是空的（第一次啟動）才會執行
      - ./database/init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    ports:
      - "127.0.0.1:5432:5432"          # 方便本機用工具連線；只綁 127.0.0.1（正式環境通常不開）
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d myapp"] # 用 pg_isready 確認 DB 是否可接受連線
      interval: 5s                     # 每 5 秒檢查一次
      timeout: 5s                      # 單次檢查最多等 5 秒
      retries: 5                       # 連續失敗 5 次才標記為 unhealthy
    restart: unless-stopped
    networks:
      - app-network

  redis:                               # Redis 快取服務
    image: redis:7-alpine
    command: redis-server --appendonly yes # 啟用 AOF 持久化（append-only file），重啟後資料可回復
    volumes:
      - redis-data:/data               # 持久化 Redis 資料（AOF/RDB 檔放這）
    ports:
      - "127.0.0.1:6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"] # 用 redis-cli ping，回 PONG 代表健康
      interval: 5s
      timeout: 3s
      retries: 5
    restart: unless-stopped
    networks:
      - app-network

volumes:                               # 頂層宣告具名 Volume（資源本體）
  pgdata:                              # 對應 db 服務使用的 pgdata
  redis-data:                          # 對應 redis 服務使用的 redis-data

networks:                              # 頂層宣告自訂網路
  app-network:
    driver: bridge                     # 單機常用的 bridge 驅動；同網路的服務可用服務名互連
```

**6. `backend/Dockerfile`**

```dockerfile
# backend/Dockerfile

# 以 Node.js 24 的 alpine 精簡映像為基底
FROM node:24-alpine

# 設定容器內工作目錄，後續相對路徑都以 /app 為基準
WORKDIR /app

# 先只複製依賴描述檔，善用 layer 快取（程式碼變動時不會重裝套件）
COPY package.json package-lock.json ./
# 依 lock file 安裝正式環境依賴，可重現且映像較小
RUN npm ci --omit=dev

# 再複製其餘原始碼（這層之後才會因程式碼變動而失效）
COPY . .

# 切換成映像內建的非 root 使用者 node（安全性）
USER node

# 宣告容器內監聽 3000（僅 metadata，實際對外仍由 Compose 的 ports 決定）
EXPOSE 3000
# 容器啟動時在容器內執行的預設命令（exec 格式，SIGTERM 才送得到 node）
CMD ["node", "server.js"]
```

**7. 啟動與驗證**

```bash
cd ~/docker-practice/compose-demo

# --build：先建構 api 映像；--wait：等所有服務都 healthy 才回到提示字元
docker compose up -d --build --wait

docker compose ps
# NAME                   SERVICE   STATUS
# compose-demo-api-1     api       Up 5 seconds (healthy)
# compose-demo-db-1      db        Up 11 seconds (healthy)
# compose-demo-redis-1   redis     Up 11 seconds (healthy)

curl http://localhost:3000
# {"visits":1,"notes":["這筆資料由 init.sql 在資料庫第一次初始化時建立","之後重啟容器不會再執行 init.sql"]}
curl http://localhost:3000
# {"visits":2,...}

# 直接查資料庫
docker compose exec db psql -U postgres -d myapp -c 'SELECT * FROM notes;'

# volume 名稱加上了專案名稱前綴
docker volume ls
# compose-demo_pgdata
# compose-demo_redis-data

# down：刪除容器與網路，但保留 volume
docker compose down
docker compose up -d --wait
curl http://localhost:3000
# {"visits":3,...}      ← 計數接續下去，Redis 與 PostgreSQL 的資料都還在

# down -v：連 volume 一起刪，下次 up 會是全新的資料庫（init.sql 會再執行一次）
docker compose down -v
```

> 若 `docker compose up` 出現 `required variable DB_PASSWORD is missing a value: 請在 .env 設定 DB_PASSWORD`，代表 `.env` 不在 `docker-compose.yml` 同一個目錄，或檔案裡沒有 `DB_PASSWORD`。這就是 `${VAR:?訊息}` 的效果：缺少必要設定時直接中止，而不是帶著空密碼啟動。

> `init.sql` 只在資料庫**第一次初始化**（資料目錄是空的）時執行。改了 `init.sql` 卻沒生效時，是因為 `pgdata` volume 裡已經有資料；開發階段可用 `docker compose down -v` 清掉重來，正式環境則要用資料庫遷移（migration）工具處理結構變更。

> 範例二、三是其他技術棧的**範本**，說明多服務之間怎麼組合；要從零建立專案並跟著做，請看第六章 6.3（Laravel）與 6.4（Django）。

### 範例二：PHP Laravel + MySQL + Nginx

這個版本把程式碼與 `vendor/` 都打包在映像裡（接近正式環境的做法），所以 `php` 服務**不**掛載原始碼。

```yaml
# docker-compose.yml
services:
  nginx:                             # 對外的 Web 伺服器，負責處理 HTTP 並把 PHP 請求轉給 php-fpm
    image: nginx:1.30-alpine
    ports:
      - "80:80"                      # 對外開放 80 埠
    volumes:
      - ./nginx/default.conf:/etc/nginx/conf.d/default.conf:ro # 掛入自訂站台設定（:ro 唯讀，容器不應改它）
      - ./src/public:/var/www/html/public:ro # Nginx 只需要直接讀取 public/ 底下的靜態檔
    depends_on:
      - php                          # 先啟動 php 再啟動 nginx（僅保證順序，不等就緒）
    networks:
      - app-network

  php:                               # PHP-FPM 應用容器（實際執行 Laravel 程式）
    build:
      context: .                     # 用專案根目錄當建構上下文
      dockerfile: Dockerfile         # 使用根目錄的 Dockerfile 建構 PHP 映像
    # 不掛載 ./src：映像裡已經有程式碼和 composer install 裝好的 vendor/
    # 若把 ./src 掛到 /var/www/html，主機目錄會整個蓋掉映像裡的內容，vendor/ 與調整過權限的 storage/ 都會不見
    environment:
      DB_HOST: mysql                 # 用服務名稱 mysql 連資料庫
      DB_DATABASE: laravel           # 資料庫名稱（需與 mysql 服務一致）
      DB_USERNAME: laravel           # 資料庫帳號
      DB_PASSWORD: ${DB_PASSWORD}    # 密碼從 .env 帶入
    depends_on:
      mysql:
        condition: service_healthy   # 等 MySQL 健康檢查通過才啟動 php，避免一啟動就連不上 DB
    networks:
      - app-network

  mysql:                             # MySQL 資料庫服務
    image: mysql:8.4                 # 8.4 是 LTS 版本；8.0 已在 2026-04 停止支援
    environment:
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD} # root 密碼（從 .env 帶入）
      MYSQL_DATABASE: laravel        # 首次啟動自動建立的資料庫
      MYSQL_USER: laravel            # 首次啟動自動建立的一般使用者
      MYSQL_PASSWORD: ${DB_PASSWORD} # 上述使用者的密碼
    volumes:
      - mysql-data:/var/lib/mysql    # 具名 Volume 持久化 MySQL 資料目錄
    ports:
      - "127.0.0.1:3306:3306"        # 方便本機資料庫工具連線；只綁本機
    healthcheck:
      # -h 127.0.0.1 強制走 TCP：MySQL 第一次初始化時會先起一個不開網路的暫時 server，
      # 用 localhost（走 socket）會在初始化還沒完成時就回報健康
      test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - app-network

  redis:                             # Redis（Laravel 可用於 cache / session / queue）
    image: redis:7-alpine
    networks:
      - app-network

volumes:
  mysql-data:                        # 宣告 mysql 使用的具名 Volume

networks:
  app-network:                       # 自訂 bridge 網路；四個服務都在此網路內可用服務名互連
```

對應的 Dockerfile：

```dockerfile
# Dockerfile（PHP-FPM）

# PHP 8.4 的 FPM 版本（給 Nginx 透過 fastcgi 呼叫；目前的 Laravel 需要 PHP 8.4 以上）
FROM php:8.4-fpm-alpine

# 安裝 PHP 擴展
# docker-php-ext-install 是官方 PHP 映像內建的腳本，用來編譯/啟用擴展
# pdo + pdo_mysql：連 MySQL 必備；opcache：快取編譯後的 bytecode，提升效能
RUN docker-php-ext-install pdo pdo_mysql opcache

# 安裝 Composer
# 直接從官方 composer 映像複製執行檔過來，省去自行安裝的步驟（multi-stage 的小技巧）
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

# Laravel 程式放在此目錄
WORKDIR /var/www/html

# 把主機 src/ 內的 Laravel 專案複製進來
COPY src/ .

# 安裝相依套件（--no-dev 不裝開發套件、--optimize-autoloader 產生最佳化 autoload）
RUN composer install --no-dev --optimize-autoloader

# Laravel 執行期需要寫入 storage 與 bootstrap/cache，這裡把擁有者改成 php-fpm 的執行帳號 www-data
RUN chown -R www-data:www-data /var/www/html/storage /var/www/html/bootstrap/cache

# 切換成非 root 的 www-data 執行（安全性）
USER www-data

# php-fpm 預設監聽 9000（給 Nginx 的 fastcgi_pass 連線）
EXPOSE 9000
# 啟動 php-fpm 常駐程序
CMD ["php-fpm"]
```

### 範例三：Python Django + PostgreSQL + Celery + RabbitMQ

web、migrate、celery-worker、celery-beat 四個服務跑的是**同一份程式碼**，只是啟動指令不同。這個範例示範兩個減少重複的技巧：

- **YAML anchor**：把共用設定寫在 `x-django` 區塊，用 `&django` 命名，再用 `<<: *django` 合併進各服務。`x-` 開頭的頂層欄位 Compose 會忽略，專門拿來放這類共用片段。
- **只建構一次**：只有 `web` 寫 `build`，其他服務用同一個 `image` 名稱並加上 `pull_policy: never`（不要去 registry 拉）。若每個服務都寫 `build: .` 配同一個 `image`，Compose 會同時建構好幾次，還可能出現 `image ... already exists` 的錯誤。

```yaml
# docker-compose.yml

# 共用設定：每個 Django 相關服務都要的東西
x-django: &django
  image: myproject-django:dev        # 同一個映像名稱
  pull_policy: never                 # 這個映像只會在本機建構，不要去 registry 拉
  env_file: .env                     # 從 .env 把所有變數注入容器（DB 連線、SECRET_KEY 等）
  restart: unless-stopped

services:
  migrate:                           # 一次性任務：執行資料庫遷移後就結束
    <<: *django
    command: python manage.py migrate --noinput
    restart: "no"                    # 一次性任務不要重啟（覆蓋 anchor 裡的 unless-stopped）
    depends_on:
      db:
        condition: service_healthy

  web:                               # Django 應用（用 gunicorn 提供 WSGI 服務）
    <<: *django
    build: .                         # 只有這個服務負責建構映像
    command: gunicorn config.wsgi:application --bind 0.0.0.0:8000 --workers 4
    ports:
      - "8000:8000"
    depends_on:
      migrate:
        condition: service_completed_successfully  # 等遷移跑完且 exit code 為 0 才啟動
      rabbitmq:
        condition: service_healthy   # 等 RabbitMQ 就緒（Celery 的訊息佇列）
    volumes:
      - static-files:/app/staticfiles # 與 nginx 共用的靜態檔 Volume（collectstatic 的輸出）

  celery-worker:                     # Celery worker：實際執行非同步任務
    <<: *django
    command: celery -A config worker -l info  # 啟動 worker；-A config 指定 Celery app，-l info 設定日誌等級
    depends_on:
      migrate:
        condition: service_completed_successfully
      rabbitmq:
        condition: service_healthy

  celery-beat:                       # Celery beat：排程器，定時把週期任務送進佇列
    <<: *django
    command: celery -A config beat -l info    # 啟動 beat 排程器
    depends_on:
      - celery-worker                # 在 worker 之後啟動

  db:                                # PostgreSQL 資料庫
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: ${DB_NAME}        # 以下三項皆從 .env 帶入，與 Django settings 對齊
      POSTGRES_USER: ${DB_USER}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data # 持久化資料
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USER} -d ${DB_NAME}"] # 用設定的使用者做就緒檢查
      interval: 5s
      timeout: 5s
      retries: 5

  rabbitmq:                          # 訊息佇列（Celery 的 broker）
    image: rabbitmq:4-management-alpine # -management 版本內建 Web 管理介面
    ports:
      - "127.0.0.1:15672:15672"      # Management UI（瀏覽器 http://localhost:15672 可進管理頁）
    environment:
      RABBITMQ_DEFAULT_USER: guest   # 預設帳號（正式環境請改掉並用 secret）
      RABBITMQ_DEFAULT_PASS: guest   # 預設密碼
    healthcheck:
      test: ["CMD", "rabbitmq-diagnostics", "-q", "ping"] # 用內建診斷工具確認 broker 健康
      interval: 10s
      timeout: 5s
      retries: 5

  nginx:                             # 反向代理 + 提供靜態檔
    image: nginx:1.30-alpine
    ports:
      - "80:80"
    volumes:
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro # 自訂站台設定（唯讀）
      - static-files:/app/staticfiles:ro # 共用 web 產生的靜態檔，由 Nginx 直接送出（唯讀）
    depends_on:
      - web

volumes:
  pgdata:                            # db 使用的持久化 Volume
  static-files:                      # web 與 nginx 共用的靜態檔 Volume
```

> 用 `docker compose config` 可以看到 anchor 展開後每個服務的完整設定，確認合併結果是否如預期。

---

## 4.5 Compose 常用指令

```bash
# === 啟動與停止 ===
docker compose up                  # 前景啟動所有服務（Ctrl+C 停止）
docker compose up -d               # 背景啟動
docker compose up -d --build       # 重新建構映像後啟動
docker compose up -d --wait        # 背景啟動，並等到所有服務 healthy 才返回（CI 很好用）
docker compose up -d api           # 只啟動特定服務（連同它 depends_on 的服務）
docker compose down                # 停止並移除容器、網路（保留 volume）
docker compose down -v             # 同上，加上移除 volume（資料會消失）
docker compose down --remove-orphans  # 一併移除「YAML 裡已經刪掉的服務」留下的容器
docker compose stop                # 停止服務（不移除容器）
docker compose start               # 啟動已停止的服務
docker compose restart api         # 重啟容器；⚠️ 不會套用 YAML 的修改，改了設定要用 up -d

# === 查看狀態 ===
docker compose ps                  # 列出服務狀態
docker compose logs                # 查看所有服務日誌
docker compose logs -f api         # 追蹤特定服務日誌
docker compose logs --tail 50 api  # 最後 50 行日誌
docker compose top                 # 查看各服務的行程

# === 執行指令 ===
docker compose exec api sh                # 進入「已在執行」的容器（alpine 映像沒有 bash，用 sh）
docker compose exec db psql -U postgres    # 連線 PostgreSQL
docker compose run --rm api node -v        # 建立一次性容器執行指令（不會用到既有 api 容器）
                                           # --rm：跑完就刪；不加的話每執行一次就留下一個已停止的容器

# === 建構與更新 ===
docker compose build               # 建構所有服務的映像
docker compose build api            # 建構特定服務
docker compose pull                 # 拉取所有服務的映像
docker compose up -d --force-recreate  # 強制重新建立容器

# === 擴展服務 ===
docker compose up -d --scale worker=3  # 將 worker 擴展為 3 個實例
# 有固定主機 port（ports: "3000:3000"）或 container_name 的服務不能擴展，第二個實例會撞名或撞 port

# === 設定檢查 ===
docker compose config              # 驗證並顯示最終設定（變數替換、多檔合併、anchor 展開後的結果）
docker compose config --services   # 列出所有服務名稱
docker compose ls                  # 列出這台機器上所有執行中的 Compose 專案
```

> 改了 `docker-compose.yml` 之後，直接再執行一次 `docker compose up -d` 即可：Compose 會比對設定，只重建有變動的服務，沒變的容器不會被動到。

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
      - "127.0.0.1:5432:5432"
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
# 用了 -f 就不會再自動載入 override 檔，所以開發用的 ports、原始碼掛載不會帶到生產環境
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# 檢查最終合併的設定
docker compose -f docker-compose.yml -f docker-compose.prod.yml config
```

多檔案合併規則（後面的檔案優先）：

- **單一值**（`image`、`command`、`restart`…）：後面的**取代**前面的。
- **對照表**（`environment`、`labels`…）：依 key 合併，同一個 key 由後面的取代。
- **清單**（`ports`、`expose`、`dns`…）：**合併**，不是取代。基礎檔已經有 `ports: ["3000:3000"]`，覆蓋檔再寫 `ports: ["8080:3000"]`，結果是兩個 port 都會開。`volumes` 則依容器內路徑合併，同一個目標路徑由後面的取代。

要讓覆蓋檔「清空」前面的設定，用 `!reset`；要整個換掉，用 `!override`：

```yaml
# docker-compose.prod.yml
services:
  db:
    ports: !reset []           # 移除基礎檔裡的所有 ports，生產環境的資料庫不對外
  api:
    ports: !override
      - "127.0.0.1:3000:3000"  # 不管前面寫了什麼，最後只有這一個
```

合併結果是否符合預期，一律用 `docker compose ... config` 確認。

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
```

原因：容器內的程式以 `node`（UID 1000）執行，但目錄屬於 root。容器與主機看的是**數字 UID**，不是使用者名稱。bind mount 的目錄若是主機上 UID 1001 的使用者建立的，容器裡的 UID 1000 一樣寫不進去。macOS / Windows 的 Docker Desktop 會自動轉換檔案擁有者，所以這個問題主要出現在 Linux 主機上。

```bash
# 解決方案一：在 Dockerfile 中先建立目錄並設定擁有者（適用 named volume）
# 空的 named volume 第一次掛上去時，會沿用映像中該目錄的擁有者與權限
# RUN mkdir -p /app/logs && chown -R node:node /app/logs

# 解決方案二：讓容器用「主機使用者的 UID/GID」執行（適用 bind mount）
# 注意：bash 的 $UID 不是環境變數（沒有 export），Compose 讀不到，${UID:-1000} 永遠會是 1000
# 所以改用自訂的變數名稱，寫進 .env：
echo "HOST_UID=$(id -u)" >> .env
echo "HOST_GID=$(id -g)" >> .env
```

```yaml
services:
  api:
    user: "${HOST_UID:-1000}:${HOST_GID:-1000}"
```

```bash
# 解決方案三：在主機上把目錄權限開到最大
# chmod 777 ./logs  # 不推薦：任何使用者都能寫，只適合臨時排查
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
# 排查步驟（以下 ping / nslookup / nc 是 alpine 映像內建的 busybox 指令；
# Debian slim 系的映像沒有這些工具，改用第八章 8.3 的臨時除錯容器）

# 1. 確認服務在同一個網路，且名稱解析得到
docker compose exec api ping -c 2 db

# 2. 確認使用的是服務名稱而非 localhost
# ❌ DB_HOST=localhost   ← 容器裡的 localhost 是 api 容器自己，不是資料庫
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
