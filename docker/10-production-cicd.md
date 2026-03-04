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
      - ./nginx/prod.conf:/etc/nginx/conf.d/default.conf:ro
      - ./certs:/etc/nginx/certs:ro
      - static-files:/var/www/static:ro
    depends_on:
      api:
        condition: service_healthy
    restart: always
    deploy:
      resources:
        limits:
          cpus: '0.5'
          memory: 128M
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost/health"]
      interval: 30s
      timeout: 5s
      retries: 3

  # === 應用程式 API ===
  api:
    image: ${REGISTRY}/api:${TAG:-latest}
    environment:
      NODE_ENV: production
      DB_HOST: db
      DB_PORT: 5432
      DB_NAME: ${DB_NAME}
      DB_USER: ${DB_USER}
      DB_PASSWORD_FILE: /run/secrets/db_password
      REDIS_URL: redis://redis:6379
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
    secrets:
      - db_password
    restart: always
    deploy:
      resources:
        limits:
          cpus: '1.0'
          memory: 512M
      replicas: 2    # 多副本（需搭配負載均衡）
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 30s
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
      POSTGRES_PASSWORD_FILE: /run/secrets/db_password
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./database/init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    secrets:
      - db_password
    restart: always
    deploy:
      resources:
        limits:
          cpus: '2.0'
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
secrets:
  db_password:
    file: ./secrets/db_password.txt

# === Volumes ===
volumes:
  pgdata:
  redis-data:
  static-files:

# === Networks ===
networks:
  default:
    driver: bridge
```

### 生產環境 Nginx 設定

```nginx
# nginx/prod.conf
upstream api_servers {
    server api:3000;
    # 如果有多個副本，Docker Compose 的 DNS 會自動負載均衡
}

server {
    listen 80;
    server_name example.com;

    # HTTP 轉 HTTPS
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name example.com;

    ssl_certificate /etc/nginx/certs/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/privkey.pem;

    # 安全 Headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # 健康檢查端點
    location /health {
        access_log off;
        return 200 'OK';
    }

    # API 反向代理
    location /api/ {
        proxy_pass http://api_servers/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_connect_timeout 30s;
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
    }

    # 靜態檔案
    location /static/ {
        alias /var/www/static/;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # SPA 路由
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
name: Docker CI/CD

on:
  push:
    branches: [main]
    tags: ['v*']
  pull_request:
    branches: [main]

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  # ===== 測試 =====
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run tests in Docker
        run: |
          # 啟動測試環境並在測試容器結束後停止整組服務
          docker compose -f docker-compose.test.yml up --build --abort-on-container-exit
          # 測試完成後清理容器與 volume，避免污染下一次 CI
          docker compose -f docker-compose.test.yml down -v

  # ===== 建構與推送映像 =====
  build-and-push:
    needs: test
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Login to Container Registry
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=ref,event=branch
            type=ref,event=pr
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=sha

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          push: ${{ github.event_name != 'pull_request' }}
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  # ===== 映像安全掃描 =====
  security-scan:
    needs: build-and-push
    runs-on: ubuntu-latest
    if: github.event_name != 'pull_request'

    steps:
      - name: Run Trivy vulnerability scanner
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:main
          format: 'sarif'
          output: 'trivy-results.sarif'
          severity: 'CRITICAL,HIGH'

      - name: Upload scan results
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: 'trivy-results.sarif'

  # ===== 部署 =====
  deploy:
    needs: [build-and-push, security-scan]
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    environment: production

    steps:
      - uses: actions/checkout@v4

      - name: Deploy to server
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.SERVER_HOST }}
          username: ${{ secrets.SERVER_USER }}
          key: ${{ secrets.SSH_PRIVATE_KEY }}
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
FROM node:20-alpine AS base
WORKDIR /app
COPY package.json package-lock.json ./

# ===== 測試階段 =====
FROM base AS test
RUN npm ci
COPY . .
CMD ["npm", "test"]

# ===== 建構階段 =====
FROM base AS builder
RUN npm ci
COPY . .
RUN npm run build

# ===== 生產階段 =====
FROM node:20-alpine AS production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --only=production && npm cache clean --force
COPY --from=builder /app/dist ./dist
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser
EXPOSE 3000
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
  prometheus:
    image: prom/prometheus:latest
    ports:
      - "9090:9090"
    volumes:
      - ./monitoring/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - prometheus-data:/prometheus
    restart: unless-stopped

  grafana:
    image: grafana/grafana:latest
    ports:
      - "3001:3000"
    volumes:
      - grafana-data:/var/lib/grafana
    environment:
      GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_PASSWORD}
    restart: unless-stopped

  # Docker 容器指標收集
  cadvisor:
    image: gcr.io/cadvisor/cadvisor:latest
    ports:
      - "8080:8080"
    volumes:
      - /:/rootfs:ro
      - /var/run:/var/run:ro
      - /sys:/sys:ro
      - /var/lib/docker/:/var/lib/docker:ro
    restart: unless-stopped

  # 主機節點指標
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
  scrape_interval: 15s

scrape_configs:
  - job_name: 'cadvisor'
    static_configs:
      - targets: ['cadvisor:8080']

  - job_name: 'node-exporter'
    static_configs:
      - targets: ['node-exporter:9100']

  - job_name: 'api'
    static_configs:
      - targets: ['api:3000']
    metrics_path: '/metrics'
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

> 上一章：[安全性最佳實踐](./09-security.md)
>
> 恭喜你完成了 Docker 完整教學課程！🎉
> 回到 [課程目錄](./README.md)
