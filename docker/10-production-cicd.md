# 第十章：生產環境部署與 CI/CD

## 10.1 生產環境 Docker 部署策略

### 部署前檢查清單

```
✅ 映像使用特定版本標籤（非 latest）
✅ 映像已通過漏洞掃描
✅ 使用非 Root 使用者運行
✅ 設定了健康檢查（HEALTHCHECK）
✅ 設定了資源限制（CPU / Memory）
✅ 設定了合適的重啟策略
✅ 日誌有正確輸出到 stdout/stderr
✅ Secret 不在映像中，透過環境變數或 Secret 管理注入
✅ .dockerignore 已正確設定
✅ 資料庫等有狀態服務已設定 Volume 持久化
```

---

## 10.2 生產級 Docker Compose 設定

### 完整的生產環境範例

```yaml
# docker-compose.prod.yml
services:
  # === Nginx 反向代理 ===
  nginx:
    image: nginx:1.25-alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/prod.conf:/etc/nginx/conf.d/default.conf:ro # 生產站台設定（唯讀）
      - ./certs:/etc/nginx/certs:ro          # TLS 憑證（唯讀）
      - static-files:/var/www/static:ro      # 與 api 共用的靜態檔（唯讀）
    depends_on:
      api:
        condition: service_healthy           # 等 api 健康才啟動 nginx
    restart: always                          # 生產服務：幾乎任何情況都自動重啟（含 daemon 重啟）
    deploy:
      resources:
        limits:                              # 資源上限（Swarm 完整生效；單機 compose 視版本支援）
          cpus: '0.5'
          memory: 128M
    logging:                                 # 限制日誌大小，避免長期執行把磁碟寫爆
      driver: json-file
      options:
        max-size: "10m"                      # 單一日誌檔最大 10MB，超過會輪替
        max-file: "3"                        # 最多保留 3 個輪替檔（等於上限約 30MB）
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost/health"] # 打 /health 確認 Nginx 正常
      interval: 30s
      timeout: 5s
      retries: 3

  # === 應用程式 API ===
  api:
    image: ${REGISTRY}/api:${TAG:-latest}    # 從 .env 取 REGISTRY 與 TAG 組出映像；TAG 未設定時用 latest
    environment:
      NODE_ENV: production
      DB_HOST: db
      DB_PORT: 5432
      DB_NAME: ${DB_NAME}
      DB_USER: ${DB_USER}
      DB_PASSWORD_FILE: /run/secrets/db_password # 用 _FILE 慣例從 secret 檔讀密碼（不放環境變數明文）
      REDIS_URL: redis://redis:6379
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
    secrets:
      - db_password                          # 掛載 db_password secret 到 /run/secrets/db_password
    restart: always
    deploy:
      resources:
        limits:
          cpus: '1.0'
          memory: 512M
      replicas: 2    # 多副本（需搭配負載均衡；單機 compose 需 Swarm 才會真的起多份）
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 30s                      # 啟動暖機 30 秒內失敗不計入 retries（避免冷啟動誤判）
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"

  # === 資料庫 ===
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: ${DB_NAME}
      POSTGRES_USER: ${DB_USER}
      POSTGRES_PASSWORD_FILE: /run/secrets/db_password # 同樣用 secret 檔，不把密碼放環境變數
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./database/init.sql:/docker-entrypoint-initdb.d/init.sql:ro # 首次初始化自動執行的 SQL（唯讀）
    secrets:
      - db_password
    restart: always
    deploy:
      resources:
        limits:
          cpus: '2.0'                        # 資料庫給較多資源（通常是系統瓶頸）
          memory: 2G
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USER}"]
      interval: 10s
      timeout: 5s
      retries: 5
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

  # === Redis 快取 ===
  redis:
    image: redis:7-alpine
    # command: > 是 YAML 折疊式字串，會把以下多行合併成一行（換行變空格），等同：
    #   redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru
    #   --appendonly yes：開啟 AOF 持久化，重啟後資料可回復
    #   --maxmemory 256mb：限制 Redis 最多用 256MB 記憶體
    #   --maxmemory-policy allkeys-lru：記憶體滿時，淘汰最久沒用到的 key（適合純快取用途）
    command: >
      redis-server
      --appendonly yes
      --maxmemory 256mb
      --maxmemory-policy allkeys-lru
    volumes:
      - redis-data:/data
    restart: always
    deploy:
      resources:
        limits:
          cpus: '0.5'
          memory: 512M
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5

# === Secrets ===
# 頂層定義祕密來源；上面服務用 secrets: 引用後，會以唯讀掛到容器 /run/secrets/<名稱>
secrets:
  db_password:
    file: ./secrets/db_password.txt  # 來源檔（記得加入 .gitignore，勿提交）

# === Volumes ===
volumes:
  pgdata:                            # 資料庫資料
  redis-data:                        # Redis 持久化
  static-files:                      # api 產生、nginx 提供的靜態檔

# === Networks ===
networks:
  default:                           # 覆寫預設網路的設定
    driver: bridge
```

### 生產環境 Nginx 設定

```nginx
# nginx/prod.conf

# upstream：定義後端伺服器群組，下面用 proxy_pass 指到它即可
upstream api_servers {
    server api:3000;               # 後端位址（compose 服務名 api 的 3000 埠）
    # 如果有多個副本，Docker Compose 的 DNS 會自動負載均衡
}

# 第一個 server：監聽 80，把所有 HTTP 請求永久轉址到 HTTPS
server {
    listen 80;
    server_name example.com;       # 對應的網域

    # 301 永久轉址到同網址的 https 版本（$host 原主機、$request_uri 原完整路徑+查詢字串）
    return 301 https://$host$request_uri;
}

# 第二個 server：實際提供服務的 HTTPS 站台
server {
    listen 443 ssl http2;          # 監聽 443、啟用 SSL 與 HTTP/2
    server_name example.com;

    ssl_certificate /etc/nginx/certs/fullchain.pem;     # 憑證鏈（公鑰）
    ssl_certificate_key /etc/nginx/certs/privkey.pem;   # 私鑰

    # 安全 Headers（always 表示連錯誤回應也一併加上）
    add_header X-Frame-Options "SAMEORIGIN" always;          # 防點擊劫持：只允許同源 iframe 嵌入
    add_header X-Content-Type-Options "nosniff" always;      # 禁止瀏覽器亂猜 MIME 型別
    add_header X-XSS-Protection "1; mode=block" always;      # 舊瀏覽器的 XSS 過濾（現代多靠 CSP）
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always; # 強制一年內都走 HTTPS（HSTS）

    # 健康檢查端點：直接回 200，不查後端（給負載均衡器 / 監控探測用）
    location /health {
        access_log off;            # 探測很頻繁，關掉存取日誌避免洗版
        return 200 'OK';
    }

    # API 反向代理：把 /api/ 轉給上面定義的 api_servers
    location /api/ {
        proxy_pass http://api_servers/;                      # 結尾的 / 會把 /api/ 前綴去掉再轉給後端
        proxy_set_header Host $host;                         # 傳遞原始主機名
        proxy_set_header X-Real-IP $remote_addr;             # 傳遞真實客戶端 IP
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; # 代理鏈 IP 列表
        proxy_set_header X-Forwarded-Proto $scheme;          # 告訴後端原始協定是 http 還是 https（後端產生連結時需要）

        proxy_connect_timeout 30s; # 與後端建立連線的逾時
        proxy_read_timeout 60s;    # 等待後端回應的逾時
        proxy_send_timeout 60s;    # 傳送請求給後端的逾時
    }

    # 靜態檔案：直接由 Nginx 送出，不經過後端
    location /static/ {
        alias /var/www/static/;    # 把 /static/ 對應到容器內的 /var/www/static/
        expires 1y;                # 長期快取
        add_header Cache-Control "public, immutable";
    }

    # SPA 路由：其餘路徑都回 index.html，交給前端框架處理
    location / {
        root /var/www/html;
        try_files $uri $uri/ /index.html;
    }
}
```

---

## 10.3 CI/CD 流水線

### GitHub Actions 完整範例

```yaml
# .github/workflows/docker-ci-cd.yml
name: Docker CI/CD                  # 此 workflow 顯示在 GitHub Actions 頁的名稱

# on：觸發條件（什麼事件會跑這個流程）
on:
  push:
    branches: [main]               # push 到 main 時觸發
    tags: ['v*']                   # 推送 v 開頭的 tag（如 v1.2.3）時觸發
  pull_request:
    branches: [main]               # 對 main 開 PR 時觸發（通常只跑測試，不部署）

# env：整個 workflow 共用的環境變數
env:
  REGISTRY: ghcr.io                # 映像要推到的 registry
  IMAGE_NAME: ${{ github.repository }} # 用 owner/repo 當映像名（GitHub 內建變數）

# jobs：一個 workflow 由多個 job 組成，預設平行執行（用 needs 串成順序）
jobs:
  # ===== 測試 =====
  test:
    runs-on: ubuntu-latest         # 指定執行環境（GitHub 提供的 runner）
    steps:                         # 一個 job 由多個 step 依序執行
      - uses: actions/checkout@v4  # uses：套用現成 Action；這個負責把原始碼簽出到 runner

      - name: Run tests in Docker  # name：這個 step 在介面上顯示的名稱
        run: |                     # run：執行 shell 指令（| 表示多行）
          # 啟動測試環境並在測試容器結束後停止整組服務
          docker compose -f docker-compose.test.yml up --build --abort-on-container-exit
          # 測試完成後清理容器與 volume，避免污染下一次 CI
          docker compose -f docker-compose.test.yml down -v

  # ===== 建構與推送映像 =====
  build-and-push:
    needs: test                    # needs：等 test job 成功後才執行（建立先後順序）
    runs-on: ubuntu-latest
    permissions:                   # 這個 job 需要的權限（最小權限原則）
      contents: read               # 讀取程式碼
      packages: write              # 推送映像到 GHCR 需要 write 權限

    steps:
      - uses: actions/checkout@v4

      - name: Set up Docker Buildx # 啟用 Buildx，支援多平台建構與 GitHub Actions 快取
        uses: docker/setup-buildx-action@v3

      - name: Login to Container Registry
        uses: docker/login-action@v3
        with:                      # with：傳給該 Action 的參數
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}         # 觸發此次執行的使用者
          password: ${{ secrets.GITHUB_TOKEN }} # GitHub 自動提供的 token（不必自己建）

      - name: Extract metadata
        id: meta                   # id：給這個 step 命名，後面可用 steps.meta.outputs.* 取它的輸出
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |                  # 依事件自動產生多個標籤的規則
            type=ref,event=branch  # 分支名當標籤（如 main）
            type=ref,event=pr      # PR 編號當標籤
            type=semver,pattern={{version}}        # 由 git tag 取語意化版本（如 1.2.3）
            type=semver,pattern={{major}}.{{minor}} # 次版本標籤（如 1.2）
            type=sha               # commit SHA 當標籤（精確可追溯）

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          push: ${{ github.event_name != 'pull_request' }} # PR 時只建構不推送（驗證即可，避免污染 registry）
          tags: ${{ steps.meta.outputs.tags }}     # 套用上一步 metadata-action 產生的標籤
          labels: ${{ steps.meta.outputs.labels }} # 套用標準化的 OCI labels
          cache-from: type=gha     # 從 GitHub Actions 快取讀取既有 layer，加速建構
          cache-to: type=gha,mode=max # 把這次建構的 layer 寫回快取（mode=max 連中間層都快取）

  # ===== 映像安全掃描 =====
  security-scan:
    needs: build-and-push
    runs-on: ubuntu-latest
    if: github.event_name != 'pull_request' # if：條件式執行，這裡 PR 時跳過掃描

    steps:
      - name: Run Trivy vulnerability scanner
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:main # 要掃描的映像
          format: 'sarif'         # 輸出 SARIF 格式（GitHub 安全頁可直接解析）
          output: 'trivy-results.sarif'
          severity: 'CRITICAL,HIGH' # 只關注高危與嚴重等級

      - name: Upload scan results
        uses: github/codeql-action/upload-sarif@v3 # 把結果上傳到 GitHub Security 分頁
        with:
          sarif_file: 'trivy-results.sarif'

  # ===== 部署 =====
  deploy:
    needs: [build-and-push, security-scan] # 等建構與掃描都通過才部署
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'    # 只有 main 分支才部署（PR / 其他分支不部署）
    environment: production                # 綁定 GitHub 的 production 環境（可設審核 / 保護規則）

    steps:
      - uses: actions/checkout@v4

      - name: Deploy to server
        uses: appleboy/ssh-action@v1       # 透過 SSH 連到伺服器執行部署指令
        with:
          host: ${{ secrets.SERVER_HOST }}     # 以下皆從 repo 的 Secrets 取得（不寫死在檔案）
          username: ${{ secrets.SERVER_USER }}
          key: ${{ secrets.SSH_PRIVATE_KEY }}  # SSH 私鑰
          script: |
            # 切到部署目錄
            cd /opt/myapp
            # 拉取最新映像
            docker compose pull
            # 以背景模式更新服務，並移除不再定義的孤兒容器
            docker compose up -d --remove-orphans
            # 清掉未使用映像，回收磁碟空間
            docker image prune -f
```

### 測試用 Docker Compose

```yaml
# docker-compose.test.yml
services:
  test:
    build:
      context: .
      target: test    # Multi-stage Build 的測試階段
    environment:
      NODE_ENV: test
      DB_HOST: test-db
      DB_NAME: test_db
      DB_USER: postgres
      DB_PASSWORD: test_password
    depends_on:
      test-db:
        condition: service_healthy
    command: npm test

  test-db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: test_db
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: test_password
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5
```

對應的多階段 Dockerfile：

```dockerfile
# Dockerfile
# ===== 基礎階段 =====
# 共用基底：只放大家都會用到的東西（依賴描述檔），讓 test / builder 都繼承它
FROM node:20-alpine AS base
WORKDIR /app
COPY package.json package-lock.json ./

# ===== 測試階段 =====
# 給 CI 用：裝完整依賴後跑測試（docker-compose.test.yml 的 target: test 就是指這一段）
FROM base AS test
RUN npm ci
COPY . .
CMD ["npm", "test"]

# ===== 建構階段 =====
# 編譯/打包出產物（例如 dist/），含 build 工具，不會進到最終映像
FROM base AS builder
RUN npm ci
COPY . .
RUN npm run build

# ===== 生產階段 =====
# 最終映像：從乾淨基底開始，只放執行所需內容（不含測試 / build 工具）
FROM node:20-alpine AS production
WORKDIR /app
COPY package.json package-lock.json ./
# 只裝正式依賴並清掉 npm 快取，縮小映像
RUN npm ci --only=production && npm cache clean --force
# 從 builder 階段把打包好的產物複製進來（關鍵：只帶產物，不帶原始碼與 build 工具）
COPY --from=builder /app/dist ./dist
# 建立並切換非 root 使用者
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser
EXPOSE 3000
# 健康檢查：用 wget 打 /health，失敗回非 0；alpine 內建 wget，不必另裝 curl
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "dist/server.js"]
```

---

## 10.4 零停機部署（Zero-Downtime Deployment）

### 使用 Docker Compose 滾動更新

```bash
# 部署腳本：deploy.sh
#!/bin/bash
# 遇到任何非 0 指令立即中止，避免半套部署
set -e

# 從第一個參數取版本，未提供時預設 latest
IMAGE_TAG=${1:-latest}
# 指定要使用的 Compose 檔
COMPOSE_FILE="docker-compose.prod.yml"

# 輸出目前部署版本
echo "Deploying version: ${IMAGE_TAG}"

# 拉取新映像
# 將 TAG 匯出給 docker-compose.prod.yml 的 ${TAG} 使用
export TAG=${IMAGE_TAG}
docker compose -f ${COMPOSE_FILE} pull api

# 滾動更新 API 服務
# 先擴展新版本，再縮減舊版本
docker compose -f ${COMPOSE_FILE} up -d --no-deps --scale api=2 api

# 等待新容器就緒（根據 healthcheck）
# 顯示等待訊息，方便部署紀錄追蹤
echo "Waiting for new containers to be healthy..."
# 等待應用與 healthcheck 穩定
sleep 30

# 確認新容器健康
docker compose -f ${COMPOSE_FILE} ps api

# 如果健康，縮減回正常副本數
docker compose -f ${COMPOSE_FILE} up -d --no-deps --scale api=1 api

# 清理舊映像
docker image prune -f

# 輸出部署完成訊息
echo "Deployment completed successfully!"
```

### 使用 Nginx 健康檢查 + 優雅停機

```dockerfile
# 確保應用支援優雅停機（Graceful Shutdown）
# Node.js 範例
# process.on('SIGTERM', () => {
#   console.log('SIGTERM received, shutting down gracefully...');
#   server.close(() => {
#     console.log('Server closed');
#     process.exit(0);
#   });
#   // 如果 10 秒內沒有關閉，強制退出
#   setTimeout(() => process.exit(1), 10000);
# });
```

```yaml
services:
  api:
    stop_grace_period: 30s    # 給容器 30 秒優雅停機
    stop_signal: SIGTERM       # 使用 SIGTERM 信號
```

---

## 10.5 日誌管理

### 容器日誌最佳實踐

```yaml
services:
  api:
    logging:
      driver: json-file
      options:
        max-size: "10m"    # 每個日誌檔最大 10MB
        max-file: "5"      # 最多保留 5 個檔案
        tag: "{{.Name}}"   # 加上容器名稱標籤
```

### 集中式日誌收集

```yaml
# 使用 Fluentd 收集日誌
services:
  api:
    logging:
      driver: fluentd
      options:
        fluentd-address: localhost:24224
        tag: app.api

  fluentd:
    image: fluent/fluentd:v1.16
    volumes:
      - ./fluentd/conf:/fluentd/etc
      - fluentd-logs:/fluentd/log
    ports:
      - "24224:24224"
    restart: always

volumes:
  fluentd-logs:
```

### 結構化日誌（推薦）

```bash
# 應用程式應該輸出 JSON 格式的日誌到 stdout
# {"timestamp":"2026-02-06T10:00:00Z","level":"info","msg":"Request handled","method":"GET","path":"/api/users","status":200,"duration_ms":45}

# 這樣可以方便地用工具搜尋和分析
docker logs my-api | jq 'select(.level == "error")'
```

---

## 10.6 監控與告警

### 使用 Prometheus + Grafana

```yaml
# docker-compose.monitoring.yml
services:
  prometheus:                        # 指標資料庫：定時去各服務抓 metrics 並儲存
    image: prom/prometheus:latest
    ports:
      - "9090:9090"                  # Prometheus 自身的查詢 UI
    volumes:
      - ./monitoring/prometheus.yml:/etc/prometheus/prometheus.yml:ro # 抓取設定（見下方檔案）
      - prometheus-data:/prometheus  # 持久化指標資料
    restart: unless-stopped

  grafana:                           # 視覺化儀表板：把 Prometheus 的資料畫成圖表
    image: grafana/grafana:latest
    ports:
      - "3001:3000"                  # 主機 3001 對映容器 3000（避開與 app 的 3000 衝突）
    volumes:
      - grafana-data:/var/lib/grafana # 持久化儀表板與設定
    environment:
      GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_PASSWORD} # 預設 admin 密碼（從 .env 帶入）
    restart: unless-stopped

  # cAdvisor：收集「每個容器」的 CPU/記憶體/網路等指標
  cadvisor:
    image: gcr.io/cadvisor/cadvisor:latest
    ports:
      - "8080:8080"
    volumes:                         # 以唯讀掛入主機目錄，cAdvisor 才能讀到容器與系統資訊
      - /:/rootfs:ro                 # 主機根檔案系統
      - /var/run:/var/run:ro         # Docker 執行期 socket / 狀態
      - /sys:/sys:ro                 # 核心的 cgroup / 系統指標
      - /var/lib/docker/:/var/lib/docker:ro # Docker 容器與映像中繼資料
    restart: unless-stopped

  # node-exporter：收集「主機本身」的指標（CPU、記憶體、磁碟、網路）
  node-exporter:
    image: prom/node-exporter:latest
    ports:
      - "9100:9100"
    restart: unless-stopped

volumes:
  prometheus-data:
  grafana-data:
```

```yaml
# monitoring/prometheus.yml
global:
  scrape_interval: 15s             # 預設每 15 秒去各目標抓一次指標

# scrape_configs：定義要抓哪些目標；每個 job 是一組監控對象
scrape_configs:
  - job_name: 'cadvisor'           # 抓容器指標
    static_configs:
      - targets: ['cadvisor:8080'] # 目標用服務名稱（同一 Docker 網路內可解析）

  - job_name: 'node-exporter'      # 抓主機指標
    static_configs:
      - targets: ['node-exporter:9100']

  - job_name: 'api'                # 抓自家應用的指標
    static_configs:
      - targets: ['api:3000']
    metrics_path: '/metrics'       # 預設路徑是 /metrics，這裡明確寫出（應用需自行提供此端點）
```

---

## 10.7 備份與災難復原

### 自動備份腳本

```bash
#!/bin/bash
# backup.sh - 自動備份 Docker Volume

# 備份輸出目錄
BACKUP_DIR="/backup/docker"
# 產生時間戳（用於備份檔命名）
DATE=$(date +%Y%m%d_%H%M%S)
# 保留天數（超過會刪除）
RETENTION_DAYS=7

# 備份 PostgreSQL
echo "Backing up PostgreSQL..."
# 透過 pg_dump 匯出資料，並壓縮成 gz
docker compose exec -T db pg_dump -U postgres myapp | \
  gzip > "${BACKUP_DIR}/db_${DATE}.sql.gz"

# 備份 Redis
echo "Backing up Redis..."
# 觸發 Redis 背景快照（產生 dump.rdb）
docker compose exec -T redis redis-cli BGSAVE
# 等待快照寫檔完成
sleep 5
# 從 redis 容器把 dump.rdb 複製到備份目錄
docker cp $(docker compose ps -q redis):/data/dump.rdb \
  "${BACKUP_DIR}/redis_${DATE}.rdb"

# 備份 Volume（通用方式）
echo "Backing up volumes..."
# 以臨時 Alpine 容器把 volume 打包成 tar.gz
docker run --rm \
  -v myapp_pgdata:/source:ro \
  -v ${BACKUP_DIR}:/backup \
  alpine tar czf /backup/pgdata_${DATE}.tar.gz -C /source .

# 清理過期備份
echo "Cleaning old backups..."
# 刪除超過保留天數的 SQL 備份
find ${BACKUP_DIR} -name "*.gz" -mtime +${RETENTION_DAYS} -delete
# 刪除超過保留天數的 Redis 快照備份
find ${BACKUP_DIR} -name "*.rdb" -mtime +${RETENTION_DAYS} -delete

# 輸出備份完成訊息
echo "Backup completed: ${DATE}"
```

### 還原流程

```bash
#!/bin/bash
# restore.sh - 還原備份

# 讀取第一個參數作為備份檔路徑
BACKUP_FILE=$1

# 參數檢查：未提供備份檔就顯示用法並退出
if [ -z "$BACKUP_FILE" ]; then
  echo "Usage: ./restore.sh <backup_file>"
  exit 1
fi

# 停止服務
docker compose stop api celery-worker

# 還原 PostgreSQL
echo "Restoring PostgreSQL..."
# 解壓 SQL 備份並直接 pipe 進 psql 還原
gunzip -c ${BACKUP_FILE} | docker compose exec -T db psql -U postgres myapp

# 重新啟動服務
docker compose start api celery-worker

echo "Restore completed!"
```

---

## 10.8 實際情境

### 情境一：部署後新版本有 Bug，需要回滾

**問題**：新版映像部署後發現問題，需要快速回到上一版

```bash
# 回滾到上一個版本
# 方法一：重新指定舊版標籤
export TAG=v1.2.3    # 上一個穩定版本
# 依指定 TAG 重新建立 api 容器
docker compose -f docker-compose.prod.yml up -d api

# 方法二：使用 Git SHA 標籤
export TAG=abc1234
# 用 commit SHA 標籤回滾到對應映像
docker compose -f docker-compose.prod.yml up -d api

# 確認回滾成功
# 檢查容器狀態是否正常
docker compose ps
# 看最新 20 行日誌確認服務無錯
docker compose logs --tail 20 api
# 打健康檢查端點確認功能正常
curl http://localhost/api/health
```

### 情境二：SSL 憑證過期

**問題**：HTTPS 憑證過期，網站無法存取

```bash
# 使用 Let's Encrypt 自動更新憑證
# 在 docker-compose.prod.yml 中加入 certbot

services:
  certbot:
    image: certbot/certbot
    volumes:
      - ./certs:/etc/letsencrypt
      - certbot-www:/var/www/certbot
    entrypoint: "/bin/sh -c 'trap exit TERM; while :; do certbot renew; sleep 12h & wait $${!}; done;'"

  nginx:
    volumes:
      - ./certs:/etc/nginx/certs:ro
      - certbot-www:/var/www/certbot:ro

volumes:
  certbot-www:
```

```bash
# 手動更新憑證
docker compose run --rm certbot certonly \
  --webroot \
  --webroot-path=/var/www/certbot \
  -d example.com \
  -d www.example.com

# 重載 Nginx
docker compose exec nginx nginx -s reload
```

### 情境三：資料庫需要不停機遷移

**問題**：需要執行資料庫 schema 遷移，但不能停止服務

```bash
# 1. 確保遷移是向後相容的（Backward Compatible）
# ❌ 直接刪除或重命名欄位
# ✅ 先新增欄位 → 部署新版程式 → 再刪除舊欄位

# 2. 使用 Docker Compose 執行遷移
# 在既有 api 容器內執行遷移（常見做法）
docker compose exec api npm run migrate
# 或
# 起一次性容器執行 Python/Django 遷移
docker compose run --rm api python manage.py migrate

# 3. 驗證遷移結果
docker compose exec db psql -U postgres -d myapp -c "\dt"
```

### 情境四：磁碟空間告警

**問題**：伺服器磁碟空間不足，Docker 是主要佔用者

```bash
# 1. 查看 Docker 磁碟使用
docker system df -v

# 2. 清理建構快取（通常最大宗）
docker builder prune -a

# 3. 清理未使用的映像
docker image prune -a

# 4. 設定定期清理的 cron job
# 0 3 * * 0 docker system prune -a -f --volumes
# （每週日凌晨 3 點清理，包含未使用的 volume）

# 5. 設定 Docker 日誌大小限制
# /etc/docker/daemon.json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
```

---

## 10.9 本章小結

- 生產環境部署前務必完成檢查清單：版本標籤、健康檢查、資源限制、安全設定
- CI/CD 流水線應包含：測試 → 建構 → 掃描 → 部署
- 日誌應輸出到 stdout/stderr，使用 JSON 結構化格式
- 定期備份 Volume 資料，並測試還原流程
- 部署策略應支援快速回滾（使用語意化版本標籤）
- 監控容器資源使用，設定磁碟空間告警

---

> 恭喜你完成了 Docker 核心篇（01–10）！🎉 你已具備從開發到上線的完整能力。
>
> 接下來是容器編排的進階路線，把單機能力延伸到多節點：
>
> 上一章：[安全性最佳實踐](./09-security.md) | 下一章：[Kubernetes 入門（從 Docker 到 K8s）](./11-kubernetes-basics.md)
>
> 或回到 [課程目錄](./README.md)
