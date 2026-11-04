# 第十章：生產環境部署與 CI/CD

## 10.1 生產環境 Docker 部署策略

### 部署前檢查清單

```
✅ 映像使用特定版本標籤（非 latest），而且版本仍在支援期內
✅ 映像已通過漏洞掃描
✅ 使用非 Root 使用者運行
✅ CMD 使用 exec 格式，程式會處理 SIGTERM（優雅停機）
✅ 設定了健康檢查（HEALTHCHECK），檢查工具存在於映像中
✅ 設定了資源限制（CPU / Memory）
✅ 設定了合適的重啟策略
✅ 日誌有正確輸出到 stdout/stderr，並限制了日誌檔大小
✅ Secret 不在映像中，透過 secret 檔案或環境變數注入
✅ .dockerignore 已正確設定
✅ 資料庫等有狀態服務已設定 Volume 持久化，且有備份與還原演練
✅ 資料庫、Redis 等內部服務沒有對外開放 port
```

---

## 10.2 生產級 Docker Compose 設定

本章延續第四章 4.4 的 `compose-demo`（Node.js API + PostgreSQL + Redis），把它變成「接近正式環境」的部署：前面加上 Nginx（HTTPS、反向代理）、API 跑兩個副本、資料庫密碼改用 secret 檔案。所有步驟都可以在本機跟著做。

### 跟著做：準備應用程式

```bash
cd ~/docker-practice/compose-demo
```

**1. 讓程式支援 `DB_PASSWORD_FILE`**（第九章 9.5 的 `_FILE` 慣例），並在回應中加上版本與容器名稱，方便之後觀察負載平衡與部署。修改 `backend/server.js`：

```javascript
// 檔案最上方，require('node:http') 的下一行加上：
const fs = require('node:fs');
const os = require('node:os');
```

```javascript
// new Pool({...}) 裡的 password 改成：
  // 優先讀 DB_PASSWORD_FILE 指向的 secret 檔案，沒有才用 DB_PASSWORD
  password: process.env.DB_PASSWORD_FILE
    ? fs.readFileSync(process.env.DB_PASSWORD_FILE, 'utf8').trim()
    : process.env.DB_PASSWORD,
```

```javascript
// '/' 路由回傳的 JSON 改成（多了 version 與 host）：
      return res.end(JSON.stringify({
        visits,
        notes: rows.map((r) => r.title),
        version: process.env.APP_VERSION || 'dev',
        host: os.hostname(),            // 容器 ID，看得出這次是哪個副本回應
      }) + '\n');
```

**2. 把版本號寫進映像。** 在 `backend/Dockerfile` 的 `USER node` 前面加上：

```dockerfile
# 建構時用 --build-arg APP_VERSION=1.0.0 傳入，寫進環境變數讓程式讀取
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
```

**3. 建構兩個版本的映像**（1.1.0 留給 10.4 的部署練習）：

```bash
docker build --build-arg APP_VERSION=1.0.0 -t compose-demo-api:1.0.0 backend
docker build --build-arg APP_VERSION=1.1.0 -t compose-demo-api:1.1.0 backend
```

正式環境的映像通常由 CI 建構並推送到 Registry（10.3），伺服器只負責拉取與啟動；這裡先用本機建構的映像代替。

### 跟著做：準備設定檔

```bash
mkdir -p nginx certs html secrets

# 資料庫密碼（secret 檔案）
# 目錄設 700：主機上其他使用者讀不到；檔案本身維持可讀，容器內的 node 使用者才讀得到
printf 'devpassword' > secrets/db_password.txt
chmod 700 secrets

# 首頁靜態檔
echo '<h1>compose-demo</h1>' > html/index.html

# 本機練習用的自簽憑證（正式環境改用 Let's Encrypt，見 10.8 情境二）
docker run --rm -v "$PWD/certs":/certs alpine:3.24 sh -c '
  apk add -q --no-cache openssl &&
  openssl req -x509 -newkey rsa:2048 -sha256 -days 365 -nodes \
    -keyout /certs/privkey.pem -out /certs/fullchain.pem \
    -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"'

# 要部署的版本寫在 .env，之後每個 docker compose 指令都會讀到同一個版本
printf 'TAG=1.0.0\n' > .env
```

> 第四章的 `.env` 裡有 `DB_PASSWORD=devpassword`，這裡改用 secret 檔案後就不再需要，整個 `.env` 換成只有 `TAG` 一行。

### 生產環境 Nginx 設定

```nginx
# nginx/prod.conf

# 第一個 server：監聽 80
server {
    listen 80;
    server_name _;                 # _ 代表任何網域；正式環境寫你的網域，例如 example.com

    # 健康檢查端點：不轉址，給 Docker healthcheck / 負載均衡器探測用
    location = /health {
        access_log off;            # 探測很頻繁，關掉存取日誌避免洗版
        return 200 'OK';
    }

    # Let's Encrypt 驗證網域所有權用的路徑，必須能用 HTTP 存取（見 10.8 情境二）
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    # 其他請求一律 301 永久轉址到 HTTPS（$host 原主機、$request_uri 原完整路徑+查詢字串）
    location / {
        return 301 https://$host$request_uri;
    }
}

# 第二個 server：實際提供服務的 HTTPS 站台
server {
    listen 443 ssl;
    http2 on;                      # 啟用 HTTP/2（nginx 1.25.1 起的寫法；舊寫法 listen 443 ssl http2 已棄用）
    server_name _;

    ssl_certificate     /etc/nginx/certs/fullchain.pem;  # 憑證鏈（公鑰）
    ssl_certificate_key /etc/nginx/certs/privkey.pem;    # 私鑰

    # 安全 Headers（always 表示連錯誤回應也一併加上）
    add_header X-Frame-Options "SAMEORIGIN" always;          # 防點擊劫持：只允許同源 iframe 嵌入
    add_header X-Content-Type-Options "nosniff" always;      # 禁止瀏覽器亂猜 MIME 型別
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always; # 強制一年內都走 HTTPS（HSTS）

    # 使用 Docker 內建 DNS，每 10 秒重新解析服務名稱（原因見第六章 6.5）
    resolver 127.0.0.11 valid=10s;

    location = /health {
        access_log off;
        return 200 'OK';
    }

    # API 反向代理：/api/xxx → api:3000/xxx
    location /api/ {
        set $api_upstream http://api:3000;
        rewrite ^/api/(.*)$ /$1 break;
        proxy_pass $api_upstream;
        # api 有多個副本時，DNS 會回傳多個 IP，Nginx 輪流轉發；
        # 其中一個連不上（例如部署時正在關閉）就自動改送下一個
        proxy_next_upstream error timeout http_502 http_503;

        proxy_set_header Host $host;                         # 傳遞原始主機名
        proxy_set_header X-Real-IP $remote_addr;             # 傳遞真實客戶端 IP
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; # 代理鏈 IP 列表
        proxy_set_header X-Forwarded-Proto $scheme;          # 告訴後端原始協定是 http 還是 https（後端產生連結時需要）

        proxy_connect_timeout 5s;  # 與後端建立連線的逾時
        proxy_read_timeout 60s;    # 等待後端回應的逾時
        proxy_send_timeout 60s;    # 傳送請求給後端的逾時
    }

    # 其餘路徑：靜態檔（SPA 的話找不到就回 index.html，交給前端路由）
    location / {
        root /usr/share/nginx/html;
        try_files $uri $uri/ /index.html;
    }
}
```

### 完整的生產環境 Compose 設定

```yaml
# docker-compose.prod.yml

# 共用的日誌設定：用 YAML anchor 避免每個服務重寫一次
x-logging: &default-logging
  driver: json-file
  options:
    max-size: "10m"                  # 單一日誌檔最大 10MB，超過會輪替
    max-file: "3"                    # 最多保留 3 個輪替檔（等於上限約 30MB）

services:
  # === Nginx 反向代理 ===
  nginx:
    image: nginx:1.30-alpine
    ports:
      - "8080:80"                    # 本機練習用 8080/8443；正式環境改成 "80:80"、"443:443"
      - "8443:443"
    volumes:
      - ./nginx/prod.conf:/etc/nginx/conf.d/default.conf:ro # 生產站台設定（唯讀）
      - ./certs:/etc/nginx/certs:ro  # TLS 憑證（唯讀）
      - ./html:/usr/share/nginx/html:ro # 靜態檔（唯讀）
    depends_on:
      api:
        condition: service_healthy   # 等 api 健康才啟動 nginx
    restart: always                  # 生產服務：幾乎任何情況都自動重啟（含 daemon 重啟）
    deploy:
      resources:
        limits:
          cpus: '0.5'
          memory: 128M
    logging: *default-logging
    healthcheck:
      # nginx:alpine 映像內有 curl；-f：4xx/5xx 視為失敗；-sS：安靜但保留錯誤訊息
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1/health"]
      interval: 30s
      timeout: 5s
      retries: 3

  # === 應用程式 API ===
  api:
    # IMAGE 沒設定時用本機建構的 compose-demo-api；TAG 沒設定就直接報錯，避免誤用 latest
    image: ${IMAGE:-compose-demo-api}:${TAG:?請在 .env 設定要部署的版本 TAG}
    environment:
      NODE_ENV: production
      DB_HOST: db
      DB_PORT: 5432
      DB_NAME: myapp
      DB_USER: postgres
      DB_PASSWORD_FILE: /run/secrets/db_password # 用 _FILE 慣例從 secret 檔讀密碼（不放環境變數明文）
      REDIS_URL: redis://redis:6379
    secrets:
      - db_password                  # 掛載 db_password secret 到 /run/secrets/db_password
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: always
    stop_grace_period: 30s           # docker stop 時最多等 30 秒讓程式收尾（預設 10 秒）
    deploy:
      replicas: 2                    # 跑 2 個副本；單機 docker compose 也會照這個數量啟動
      resources:
        limits:
          cpus: '1.0'
          memory: 512M
    healthcheck:
      # node:24-alpine 沒有 curl，用 wget；網址用 127.0.0.1
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/health"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 10s              # 啟動暖機 10 秒內失敗不計入 retries（避免冷啟動誤判）
    logging: *default-logging
    # 沒有 ports：只讓 nginx 在 Docker 網路內連線，不直接對外

  # === 資料庫 ===
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: myapp
      POSTGRES_USER: postgres
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
          cpus: '2.0'                # 資料庫給較多資源（通常是系統瓶頸）
          memory: 2G
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d myapp"]
      interval: 10s
      timeout: 5s
      retries: 5
    logging: *default-logging

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
    logging: *default-logging

# === Secrets ===
# 頂層定義祕密來源；上面服務用 secrets: 引用後，會以唯讀掛到容器 /run/secrets/<名稱>
secrets:
  db_password:
    file: ./secrets/db_password.txt  # 來源檔（記得加入 .gitignore，勿提交）

# === Volumes ===
volumes:
  pgdata:                            # 資料庫資料
  redis-data:                        # Redis 持久化
```

### 啟動與驗證

```bash
# 若第四章的開發版還在跑，先停掉（兩份設定的專案名稱相同，會共用 volume）
docker compose down -v

docker compose -f docker-compose.prod.yml up -d --wait

docker compose -f docker-compose.prod.yml ps
# compose-demo-api-1     Up (healthy)
# compose-demo-api-2     Up (healthy)     ← 兩個副本
# compose-demo-db-1      Up (healthy)
# compose-demo-nginx-1   Up (healthy)
# compose-demo-redis-1   Up (healthy)

# 透過 HTTPS 呼叫 API（-k：略過自簽憑證檢查），多打幾次看 host 輪流變化
for i in 1 2 3 4; do curl -sk https://localhost:8443/api/; done
# {"visits":1,...,"version":"1.0.0","host":"43664838dec6"}
# {"visits":2,...,"version":"1.0.0","host":"43664838dec6"}
# {"visits":3,...,"version":"1.0.0","host":"166274a22ec1"}
# ...

# HTTP 會被轉址到 HTTPS
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://localhost:8080/api/
# 301 https://localhost/api/
```

> 每個 `docker compose -f docker-compose.prod.yml ...` 指令都會讀 `.env` 的 `TAG`。如果 `TAG` 只在當下的 shell 用 `export` 設定，換一個終端機（或重開機後的自動化腳本）執行 `docker compose ps` 就會出現 `required variable TAG is missing a value`，甚至啟動到錯的版本。所以部署的版本要寫進 `.env`，10.4 的部署腳本也是這樣做。

---

## 10.3 CI/CD 流水線

### GitHub Actions 完整範例

流程：測試 → 建構映像 → 掃描漏洞（**推送前**）→ 推送到 GHCR → 部署到伺服器。

```yaml
# .github/workflows/docker-ci-cd.yml
name: Docker CI/CD                  # 此 workflow 顯示在 GitHub Actions 頁的名稱

# on：觸發條件（什麼事件會跑這個流程）
on:
  push:
    branches: [main]               # push 到 main 時觸發
    tags: ['v*']                   # 推送 v 開頭的 tag（如 v1.2.3）時觸發
  pull_request:
    branches: [main]               # 對 main 開 PR 時觸發（只跑測試、建構與掃描，不推送也不部署）

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
      - uses: actions/checkout@v7  # uses：套用現成 Action；這個負責把原始碼簽出到 runner

      - name: Run tests in Docker  # name：這個 step 在介面上顯示的名稱
        # --abort-on-container-exit：任一容器結束就停掉整組
        # --exit-code-from test：以 test 容器的結束碼作為這個指令的結束碼（測試失敗 → step 失敗）
        run: docker compose -f docker-compose.test.yml up --build --abort-on-container-exit --exit-code-from test

      - name: Clean up
        if: always()               # 前一步失敗也要清理
        run: docker compose -f docker-compose.test.yml down -v

  # ===== 建構、掃描、推送映像 =====
  build-scan-push:
    needs: test                    # needs：等 test job 成功後才執行（建立先後順序）
    runs-on: ubuntu-latest
    permissions:                   # 這個 job 需要的權限（最小權限原則）
      contents: read               # 讀取程式碼
      packages: write              # 推送映像到 GHCR 需要 write 權限

    steps:
      - uses: actions/checkout@v7

      - name: Set up Docker Buildx # 啟用 Buildx，支援多平台建構與 GitHub Actions 快取
        uses: docker/setup-buildx-action@v4

      - name: Login to Container Registry
        if: github.event_name != 'pull_request'  # PR 不推送，不需要登入
        uses: docker/login-action@v4
        with:                      # with：傳給該 Action 的參數
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}         # 觸發此次執行的使用者
          password: ${{ secrets.GITHUB_TOKEN }} # GitHub 自動提供的 token（不必自己建）

      - name: Extract metadata
        id: meta                   # id：給這個 step 命名，後面可用 steps.meta.outputs.* 取它的輸出
        uses: docker/metadata-action@v6
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |                  # 依事件自動產生多個標籤的規則
            type=ref,event=branch  # 分支名當標籤（如 main）
            type=ref,event=pr      # PR 編號當標籤
            type=semver,pattern={{version}}        # 由 git tag 取語意化版本（如 1.2.3）
            type=semver,pattern={{major}}.{{minor}} # 次版本標籤（如 1.2）
            type=sha               # commit SHA 當標籤（格式 sha-abc1234，精確可追溯；部署就用這個）

      # 先建構到 runner 本機（load: true），還不推送
      - name: Build image for scanning
        uses: docker/build-push-action@v7
        with:
          context: .
          load: true               # 載入 runner 的 Docker，讓下一步掃描
          tags: scan-target:${{ github.sha }}
          cache-from: type=gha     # 從 GitHub Actions 快取讀取既有 layer，加速建構
          cache-to: type=gha,mode=max # 把這次建構的 layer 寫回快取（mode=max 連中間層都快取）

      # 掃描：有 CRITICAL / HIGH 且已有修正版的漏洞就讓 job 失敗，後面的推送與部署都不會執行
      - name: Run Trivy vulnerability scanner
        uses: aquasecurity/trivy-action@v0.36.0   # 固定版本，不要用 @master（避免上游被竄改時直接執行到惡意程式碼）
        with:
          image-ref: scan-target:${{ github.sha }}
          severity: 'CRITICAL,HIGH'
          ignore-unfixed: true     # 還沒有修正版本的漏洞先不擋（另行評估）
          exit-code: '1'           # 找到漏洞時以 1 結束 → step 失敗

      # 掃描通過才推送；這次建構會直接命中上一步的快取，幾乎不花時間
      - name: Build and push
        if: github.event_name != 'pull_request'
        uses: docker/build-push-action@v7
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}     # 套用 metadata-action 產生的標籤
          labels: ${{ steps.meta.outputs.labels }} # 套用標準化的 OCI labels
          cache-from: type=gha

  # ===== 部署 =====
  deploy:
    needs: build-scan-push
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'    # 只有 main 分支才部署（PR / 其他分支不部署）
    environment: production                # 綁定 GitHub 的 production 環境（可設審核 / 保護規則）

    steps:
      - name: Deploy to server
        uses: appleboy/ssh-action@v1.2.5   # 透過 SSH 連到伺服器執行部署指令
        with:
          host: ${{ secrets.SERVER_HOST }}     # 以下皆從 repo 的 Secrets 取得（不寫死在檔案）
          username: ${{ secrets.SERVER_USER }}
          key: ${{ secrets.SSH_PRIVATE_KEY }}  # SSH 私鑰
          script: |
            set -e
            cd /opt/myapp
            # GHCR 的映像預設是私有的，伺服器要先登入才能拉取
            # GHCR_READ_TOKEN：一個只有 read:packages 權限的 token，存在 repo Secrets
            echo "${{ secrets.GHCR_READ_TOKEN }}" | docker login ghcr.io -u "${{ github.actor }}" --password-stdin
            # 部署這次 commit 對應的映像（metadata-action 的 type=sha 標籤：sha- + 前 7 碼）
            ./deploy.sh "sha-$(echo '${{ github.sha }}' | cut -c1-7)"
```

> 伺服器上的 `/opt/myapp` 放的是 `docker-compose.prod.yml`、`nginx/`、`secrets/`、`.env` 與 10.4 的 `deploy.sh`；`.env` 裡要加上 `IMAGE=ghcr.io/<owner>/<repo>`，讓 Compose 從 GHCR 拉映像。

注意事項：

- **掃描放在推送之前**：若先推送再掃描，就算掃描失敗，有漏洞的映像也已經進了 Registry，其他人或其他環境仍可能拉到它。
- **部署用不可變的標籤**：`main`、`latest` 這類標籤會一直被覆蓋；部署用 `sha-xxxxxxx`，伺服器上 `.env` 記錄的就是確切的版本，回滾時也知道要回到哪個標籤。
- **Action 固定版本**：第三方 Action 等於在你的 CI 裡執行別人的程式碼。至少固定到版本號；要求更高時固定到 commit SHA（`uses: owner/action@<40 碼 SHA>`），並用 Dependabot 定期更新。

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

對應的多階段 Dockerfile（以有 `build` 與 `test` 腳本的 TypeScript 專案為例，例如第三章的 `hello-docker`）：

```dockerfile
# Dockerfile
# ===== 基礎階段 =====
# 共用基底：只放大家都會用到的東西（依賴描述檔），讓 test / builder 都繼承它
FROM node:24-alpine AS base
WORKDIR /app
COPY package.json package-lock.json ./

# ===== 測試階段 =====
# 給 CI 用：裝完整依賴後跑測試（docker-compose.test.yml 的 target: test 就是指這一段）
# 注意：.dockerignore 不能排除測試檔，否則 COPY 之後沒有測試可跑
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
FROM node:24-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# 只裝正式依賴並清掉 npm 快取，縮小映像
RUN npm ci --omit=dev && npm cache clean --force
# 從 builder 階段把打包好的產物複製進來（關鍵：只帶產物，不帶原始碼與 build 工具）
COPY --from=builder /app/dist ./dist
# 建立並切換非 root 使用者
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser
EXPOSE 3000
# 健康檢查：用 wget 打 /health，失敗回非 0；alpine 內建 wget，不必另裝 curl
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "dist/server.js"]
```

> 最後一個階段（`production`）是 `docker build` 不指定 `--target` 時的預設結果，所以 CI 的 `build-push-action` 建出來的就是正式映像；`test` 階段只有 `docker-compose.test.yml` 會用到。

---

## 10.4 零停機部署（Zero-Downtime Deployment）

### 為什麼 `docker compose up -d` 會中斷服務

換版時直接執行 `docker compose up -d`，Compose 會把舊容器**先停掉再建立新的**。新容器啟動、通過健康檢查之前，沒有任何容器在服務，請求會失敗。單純加 `--scale api=2` 也沒用：映像變了，Compose 會把現有的容器全部重建。

要做到不中斷，順序必須是：**先啟動新版 → 確認健康 → 讓流量轉到新版 → 再關掉舊版**。

### 跟著做：部署腳本

```bash
#!/usr/bin/env bash
# deploy.sh：不停機更新 api 服務
# 用法：./deploy.sh 1.1.0
set -euo pipefail

NEW_TAG=${1:?用法: ./deploy.sh <版本>}
COMPOSE="docker compose -f docker-compose.prod.yml"
SERVICE=api

cd "$(dirname "$0")"

# 1. 把要部署的版本寫進 .env，之後所有 docker compose 指令都用這個版本
sed -i.bak "s/^TAG=.*/TAG=${NEW_TAG}/" .env && rm .env.bak
echo "Deploying ${SERVICE}:${NEW_TAG}"

# 2. 先拉取新映像（本機建構、Registry 上沒有的映像會略過）
$COMPOSE pull --ignore-pull-failures "$SERVICE" || true

# 3. 記下目前（舊版）的容器
OLD_CONTAINERS=$($COMPOSE ps -q "$SERVICE")
OLD_COUNT=$(echo "$OLD_CONTAINERS" | wc -l | tr -d ' ')

# 4. 加開同樣數量的新版容器；--no-recreate：舊容器不要動
$COMPOSE up -d --no-deps --no-recreate --scale "$SERVICE=$((OLD_COUNT * 2))" "$SERVICE"

# 5. 等新容器全部 healthy（最多等 120 秒）；失敗就刪掉新容器，舊版繼續服務
NEW_CONTAINERS=$(comm -13 <(echo "$OLD_CONTAINERS" | sort) <($COMPOSE ps -q "$SERVICE" | sort))
for c in $NEW_CONTAINERS; do
  for i in $(seq 1 60); do
    status=$(docker inspect -f '{{.State.Health.Status}}' "$c")
    [ "$status" = "healthy" ] && break
    if [ "$i" = 60 ]; then
      echo "新容器 $c 沒有變成 healthy，取消部署"
      docker rm -f $NEW_CONTAINERS
      exit 1
    fi
    sleep 2
  done
done

# 6. 等 Nginx 重新解析 DNS（prod.conf 的 resolver valid=10s），讓新容器開始接流量
sleep 15

# 7. 停掉舊容器（docker stop 會送 SIGTERM，程式處理完手上的請求才結束）
docker stop $OLD_CONTAINERS
docker rm $OLD_CONTAINERS

# 8. 恢復原本的副本數（不會重建剛啟動的新容器）
$COMPOSE up -d --no-deps --no-recreate --scale "$SERVICE=$OLD_COUNT" "$SERVICE"

echo "Deployment of ${NEW_TAG} completed"
$COMPOSE ps "$SERVICE"
```

把腳本存成 `~/docker-practice/compose-demo/deploy.sh`，然後一邊持續送請求、一邊部署 1.1.0：

```bash
cd ~/docker-practice/compose-demo
chmod +x deploy.sh

# 終端機 A：每 0.1 秒打一次 API，只印出狀態碼與版本
while true; do
  curl -sk -o /tmp/resp.json -w '%{http_code} ' https://localhost:8443/api/
  grep -o '"version":"[^"]*"' /tmp/resp.json
  sleep 0.1
done

# 終端機 B：部署新版
./deploy.sh 1.1.0
# Deploying api:1.1.0
# ...
# Deployment of 1.1.0 completed
# compose-demo-api-3   compose-demo-api:1.1.0   Up 23 seconds (healthy)
# compose-demo-api-4   compose-demo-api:1.1.0   Up 23 seconds (healthy)
```

終端機 A 的輸出會從 `200 "version":"1.0.0"` 逐漸變成 `200 "version":"1.1.0"`，中間沒有任何非 200 的回應（實測部署期間 383 個請求、0 個失敗）。回滾就是部署舊版本：`./deploy.sh 1.0.0`。

能做到不中斷，靠的是幾個條件同時成立：

- **健康檢查**：第 5 步確認新容器真的能服務，才進行下一步。
- **Nginx 動態解析**：`resolver` + 變數讓 Nginx 發現新容器、不再使用已刪除的容器；`proxy_next_upstream` 讓剛好送到「正在關閉的容器」的請求改送其他副本。
- **程式的優雅停機**：舊容器收到 SIGTERM 後不再接新連線，但把手上的請求處理完才結束（第三章 3.2、第四章 compose-demo 的 `process.on('SIGTERM', ...)`）。少了這一步，正在處理中的請求會被直接切斷。
- **`stop_grace_period: 30s`**：給優雅停機足夠的時間；超過才會被強制 SIGKILL。

> 這個腳本的做法，社群有現成的 Compose 外掛 [docker-rollout](https://github.com/wowu/docker-rollout) 可以直接使用。需要多台主機、自動回滾、流量逐步切換時，就該考慮 Docker Swarm（第十三章）或 Kubernetes（第十一、十二章），它們的滾動更新是內建功能。

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

也可以在 daemon 設定成整台主機的預設值（Linux：`/etc/docker/daemon.json`；Docker Desktop：Settings → Docker Engine）：

```json
{
  "log-driver": "local",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
```

- `local` driver 會壓縮日誌、預設就有輪替，比 `json-file` 省空間；`docker logs` 照樣能用。
- daemon 的預設值**只套用到之後新建立的容器**。改完要重啟 Docker，而且既有的容器要重建（`docker compose up -d --force-recreate`）才會生效。

### 集中式日誌收集

```yaml
# 使用 Fluentd 收集日誌
services:
  api:
    logging:
      driver: fluentd
      options:
        # 注意：日誌是由主機上的 Docker daemon 送出，不是從容器裡送，
        # 所以這裡要寫「主機看得到的位址」（下面 fluentd 對主機開放的 24224），不能寫服務名稱 fluentd
        fluentd-address: localhost:24224
        tag: app.api
        # fluentd 沒啟動或連不上時，預設 api 容器會「無法啟動」；async 讓容器照常啟動，日誌先暫存
        fluentd-async: "true"

  fluentd:
    image: fluent/fluentd:v1.16
    volumes:
      - ./fluentd/conf:/fluentd/etc
      - fluentd-logs:/fluentd/log
    ports:
      - "127.0.0.1:24224:24224"
    restart: always

volumes:
  fluentd-logs:
```

> 使用 `fluentd` 等遠端 driver 時，`docker logs` 可能就看不到日誌了（取決於 Docker 版本的 dual logging 設定），排查時要到集中式日誌系統查。

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
    image: prom/prometheus:v3.5.0
    ports:
      - "127.0.0.1:9090:9090"        # Prometheus 自身的查詢 UI（只開給本機）
    volumes:
      - ./monitoring/prometheus.yml:/etc/prometheus/prometheus.yml:ro # 抓取設定（見下方檔案）
      - prometheus-data:/prometheus  # 持久化指標資料
    restart: unless-stopped

  grafana:                           # 視覺化儀表板：把 Prometheus 的資料畫成圖表
    image: grafana/grafana:12.2.0
    ports:
      - "127.0.0.1:3001:3000"        # 主機 3001 對映容器 3000（避開與 app 的 3000 衝突）
    volumes:
      - grafana-data:/var/lib/grafana # 持久化儀表板與設定
    environment:
      GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_PASSWORD:?請設定 GRAFANA_PASSWORD} # admin 密碼
    restart: unless-stopped

  # cAdvisor：收集「每個容器」的 CPU/記憶體/網路等指標
  cadvisor:
    image: gcr.io/cadvisor/cadvisor:v0.52.1
    privileged: true                 # 需要讀取主機的 cgroup 與裝置資訊
    devices:
      - /dev/kmsg
    volumes:                         # 以唯讀掛入主機目錄，cAdvisor 才能讀到容器與系統資訊
      - /:/rootfs:ro                 # 主機根檔案系統
      - /var/run:/var/run:ro         # Docker 執行期狀態（含 docker.sock，見第九章：等同 root 權限）
      - /sys:/sys:ro                 # 核心的 cgroup / 系統指標
      - /var/lib/docker/:/var/lib/docker:ro # Docker 容器與映像中繼資料
    # 不對外開 port：只讓 Prometheus 在 Docker 網路內抓取
    restart: unless-stopped

  # node-exporter：收集「主機本身」的指標（CPU、記憶體、磁碟、網路）
  node-exporter:
    image: prom/node-exporter:v1.9.1
    # 預設看到的是容器自己的檔案系統與網路；要量主機，必須掛入主機根目錄並告訴它路徑
    command:
      - '--path.rootfs=/host'
    pid: host                        # 看得到主機的行程
    volumes:
      - '/:/host:ro,rslave'
    restart: unless-stopped

volumes:
  prometheus-data:
  grafana-data:
```

> 映像版本請以各專案的最新穩定版為準，部署前確認標籤存在；這裡固定版本是為了避免 `latest` 帶來的不確定性。cAdvisor、node-exporter 主要用於 Linux 伺服器，Docker Desktop 上量到的是背景 VM 的數據。

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

  - job_name: 'api'                # 抓自家應用的指標（應用需自行提供 /metrics；沒有的話先刪掉這個 job）
    static_configs:
      - targets: ['api:3000']
    metrics_path: '/metrics'
```

```bash
# 和應用程式一起啟動：兩個檔案合併，服務才在同一個網路裡，Prometheus 才解析得到 api
GRAFANA_PASSWORD=change-me docker compose \
  -f docker-compose.prod.yml -f docker-compose.monitoring.yml up -d
```

啟動後：

1. 開 http://localhost:9090 → Status → Targets，確認各目標是 `UP`。
2. 開 http://localhost:3001，用 `admin` 登入 Grafana → Connections → Data sources → Add → Prometheus，URL 填 `http://prometheus:9090`（Grafana 在容器內，用服務名稱）。
3. Dashboards → Import，輸入社群儀表板編號（例如 Node Exporter Full 的 `1860`）即可看到主機圖表。

**告警**：Prometheus 本身只負責收集與判斷規則，通知（Email、Slack、LINE）由 Alertmanager 負責。在 `prometheus.yml` 加上 `rule_files` 定義規則（例如「容器記憶體使用率超過 90% 持續 5 分鐘」「磁碟剩餘少於 10%」），再加一個 `prom/alertmanager` 服務設定通知管道。Grafana 也內建告警功能，小型團隊可以先從 Grafana 開始。

---

## 10.7 備份與災難復原

### 自動備份腳本

```bash
#!/usr/bin/env bash
# backup.sh：備份 PostgreSQL 與 Redis
# -e：任一指令失敗就中止；-u：用到未定義的變數就報錯；-o pipefail：管線中任一段失敗都算失敗
set -euo pipefail

# 切到腳本所在目錄：cron 執行時的工作目錄是家目錄，不切過來 docker compose 會找不到設定檔
cd "$(dirname "$0")"

# 備份輸出目錄（可用環境變數覆蓋）
BACKUP_DIR="${BACKUP_DIR:-/backup/docker}"
# 產生時間戳（用於備份檔命名）
DATE=$(date +%Y%m%d_%H%M%S)
# 保留天數（超過會刪除）
RETENTION_DAYS=7
COMPOSE="docker compose -f docker-compose.prod.yml"

mkdir -p "$BACKUP_DIR"

# 備份 PostgreSQL
# pg_dump 在資料庫運作中也能取得一致的快照；--format=custom 為壓縮格式，用 pg_restore 還原
echo "Backing up PostgreSQL..."
$COMPOSE exec -T db pg_dump -U postgres -d myapp --format=custom \
  > "${BACKUP_DIR}/db_${DATE}.dump"

# 備份 Redis
# BGSAVE 是在背景寫檔，指令會立刻返回；要等 LASTSAVE（最後一次存檔時間）改變才代表寫完
echo "Backing up Redis..."
LAST_SAVE=$($COMPOSE exec -T redis redis-cli LASTSAVE)
$COMPOSE exec -T redis redis-cli BGSAVE > /dev/null
until [ "$($COMPOSE exec -T redis redis-cli LASTSAVE)" != "$LAST_SAVE" ]; do
  sleep 1
done
docker cp "$($COMPOSE ps -q redis)":/data/dump.rdb "${BACKUP_DIR}/redis_${DATE}.rdb"

# 清理過期備份
echo "Cleaning old backups..."
find "$BACKUP_DIR" \( -name 'db_*.dump' -o -name 'redis_*.rdb' \) -mtime +"$RETENTION_DAYS" -delete

echo "Backup completed: ${DATE}"
ls -lh "$BACKUP_DIR"
```

> 不要用 tar 打包「運作中」的資料庫資料目錄（第五章 5.5 的提醒）：那樣得到的可能是寫到一半的檔案，還原後無法啟動。資料庫一律用它自己的匯出工具。

### 還原流程

```bash
#!/usr/bin/env bash
# restore.sh：從 pg_dump 備份還原 PostgreSQL
set -euo pipefail

cd "$(dirname "$0")"

# 讀取第一個參數作為備份檔路徑；未提供就顯示用法並退出
BACKUP_FILE=${1:?用法: ./restore.sh <db_xxx.dump>}
COMPOSE="docker compose -f docker-compose.prod.yml"

# 停止會寫入資料庫的服務，避免還原過程中有新資料進來
echo "Stopping api..."
$COMPOSE stop api

# --clean --if-exists：先刪除現有的資料表等物件再重建，還原後與備份當時完全一致
echo "Restoring PostgreSQL from ${BACKUP_FILE}..."
$COMPOSE exec -T db pg_restore -U postgres -d myapp --clean --if-exists < "$BACKUP_FILE"

# 重新啟動服務
echo "Starting api..."
$COMPOSE start api

echo "Restore completed!"
```

### 跟著做：演練一次備份與還原

```bash
cd ~/docker-practice/compose-demo
# 把上面兩個腳本存成 backup.sh、restore.sh
chmod +x backup.sh restore.sh

# 1. 新增一筆資料，然後備份
docker compose -f docker-compose.prod.yml exec -T db \
  psql -U postgres -d myapp -c "INSERT INTO notes (title) VALUES ('備份前新增的資料');"
BACKUP_DIR=./backups ./backup.sh

# 2. 模擬事故：資料被刪光
docker compose -f docker-compose.prod.yml exec -T db psql -U postgres -d myapp -c "DELETE FROM notes;"
curl -sk https://localhost:8443/api/
# {"visits":...,"notes":[],...}

# 3. 還原最新的備份
./restore.sh $(ls ./backups/db_*.dump | tail -1)

# 4. 驗證（api 剛重啟，等健康檢查通過、Nginx 重新解析後再打）
sleep 12
curl -sk https://localhost:8443/api/
# {"visits":...,"notes":["這筆資料由 init.sql ...","之後重啟容器不會再執行 init.sql","備份前新增的資料"],...}
```

排程與異地保存：

```bash
# crontab -e：每天凌晨 2 點備份（腳本內已經 cd 到自己的目錄）
0 2 * * * BACKUP_DIR=/backup/docker /opt/myapp/backup.sh >> /var/log/myapp-backup.log 2>&1
```

- **3-2-1 原則**：至少 3 份備份、存在 2 種不同媒介、其中 1 份在異地。備份和資料庫放在同一台主機上，主機壞了會一起消失；可以在腳本最後把檔案上傳到物件儲存（例如 `aws s3 cp`、`rclone`）。
- **定期演練還原**：沒有實際還原過的備份，等於不知道能不能用。

---

## 10.8 實際情境

### 情境一：部署後新版本有 Bug，需要回滾

**問題**：新版映像部署後發現問題，需要快速回到上一版

```bash
# 用 10.4 的部署腳本部署舊版本即可（一樣不停機）
./deploy.sh 1.0.0

# 若用 CI 的 sha 標籤部署，到 GitHub Actions 或 Registry 找上一個正常的 commit
./deploy.sh sha-abc1234

# 確認回滾成功
# 檢查容器狀態與版本
docker compose -f docker-compose.prod.yml ps api
# 看最新 20 行日誌確認服務無錯
docker compose -f docker-compose.prod.yml logs --tail 20 api
# 打 API 確認版本
curl -sk https://localhost:8443/api/
```

> 回滾只回滾得了程式。若新版已經對資料庫做了不相容的結構變更（刪欄位、改型別），舊版程式可能無法使用新的結構，這就是情境三強調「向後相容遷移」的原因。

### 情境二：使用 Let's Encrypt 取得並自動更新憑證

**問題**：要讓正式網域使用免費且自動更新的 HTTPS 憑證；或憑證過期導致網站無法存取

前提：有一個公開網域（例如 `example.com`）的 DNS 已經指向這台伺服器，且 80、443 埠對外開放（Let's Encrypt 會從網際網路連進來驗證）。這一段無法在本機練習。

**1. 調整掛載與憑證路徑。** 在 `docker-compose.prod.yml` 的 nginx 服務加上 certbot 用的兩個目錄，並新增 certbot 服務：

```yaml
services:
  nginx:
    volumes:
      - ./nginx/prod.conf:/etc/nginx/conf.d/default.conf:ro
      - ./html:/usr/share/nginx/html:ro
      - ./certbot/conf:/etc/letsencrypt:ro     # certbot 產生的憑證
      - ./certbot/www:/var/www/certbot:ro      # 驗證用的檔案（對應 prod.conf 的 acme-challenge）

  certbot:
    image: certbot/certbot
    volumes:
      - ./certbot/conf:/etc/letsencrypt
      - ./certbot/www:/var/www/certbot
    profiles:
      - tools                        # 平常不啟動，只在 docker compose run 時使用
```

`nginx/prod.conf` 的憑證路徑改成 certbot 的輸出位置（`live/<網域>/` 底下）：

```nginx
    ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;
```

**2. 第一次申請憑證。** 還沒有憑證時，443 的 server 區塊會因為找不到憑證檔而讓 Nginx 起不來。先暫時拿掉 `prod.conf` 的 HTTPS server 區塊（只留 80 的那段，它已經有 `/.well-known/acme-challenge/`），啟動 Nginx 後申請：

```bash
docker compose -f docker-compose.prod.yml up -d nginx

docker compose -f docker-compose.prod.yml run --rm certbot certonly \
  --webroot -w /var/www/certbot \
  -d example.com -d www.example.com \
  --email you@example.com --agree-tos --no-eff-email
# Successfully received certificate.
# Certificate is saved at: /etc/letsencrypt/live/example.com/fullchain.pem

# 把 HTTPS server 區塊加回 prod.conf，重新載入 Nginx
docker compose -f docker-compose.prod.yml exec nginx nginx -s reload
```

**3. 自動更新。** Let's Encrypt 憑證效期短，要定期續期，續期後還要讓 Nginx 重新載入才會用新憑證：

```bash
# crontab -e：每天凌晨 3 點嘗試續期（快到期才會真的換），之後重新載入 Nginx
0 3 * * * cd /opt/myapp && docker compose -f docker-compose.prod.yml run --rm certbot renew --quiet && docker compose -f docker-compose.prod.yml exec -T nginx nginx -s reload
```

> **更簡單的選擇：Caddy。** 反向代理改用 [Caddy](https://caddyserver.com/) 的話，它會自動申請與更新 Let's Encrypt 憑證，上面三個步驟都不需要。對應 `prod.conf` 的 Caddy 設定（`Caddyfile`）只有幾行：
>
> ```
> example.com {
>     handle_path /api/* {
>         reverse_proxy api:3000
>     }
>     handle {
>         root * /usr/share/nginx/html
>         try_files {path} /index.html
>         file_server
>     }
> }
> ```
>
> Caddy 容器要把 `/data` 掛成 volume，憑證才不會在容器重建後遺失（重新申請太頻繁會被 Let's Encrypt 限制）。

### 情境三：資料庫需要不停機遷移

**問題**：需要執行資料庫 schema 遷移，但不能停止服務

```bash
# 1. 確保遷移是向後相容的（Backward Compatible）
# ❌ 直接刪除或重命名欄位（舊版程式還在跑，會立刻出錯）
# ✅ 先新增欄位 → 部署新版程式 → 確認不需要回滾後，下一次部署再刪除舊欄位

# 2. 在部署新版之前，用新版映像起一個一次性容器執行遷移
# --rm：跑完就刪；--no-deps：不重啟其他服務
docker compose -f docker-compose.prod.yml run --rm --no-deps api npm run migrate
# 或（Python/Django 專案）
docker compose -f docker-compose.prod.yml run --rm --no-deps api python manage.py migrate

# 3. 驗證遷移結果
docker compose -f docker-compose.prod.yml exec db psql -U postgres -d myapp -c "\dt"

# 4. 遷移成功後再執行 ./deploy.sh <新版本>
```

> `run` 會用 `.env` 裡的 `TAG` 建立容器，所以要先把 `TAG` 改成新版本再執行遷移；或在 `deploy.sh` 第 1 步之後加入這一行，讓遷移成為部署的一部分。

### 情境四：磁碟空間告警

**問題**：伺服器磁碟空間不足，Docker 是主要佔用者

```bash
# 1. 查看 Docker 磁碟使用
docker system df -v

# 2. 清理建構快取（通常最大宗）；--keep-storage 保留最近 5GB，下次建構仍有快取可用
docker builder prune -f --keep-storage 5gb

# 3. 清理超過 7 天、沒有容器使用的映像
#    保留最近的舊版本，回滾時不必重新下載
docker image prune -a -f --filter "until=168h"

# 4. 設定定期清理的 cron job
# 0 3 * * 0 docker builder prune -f --keep-storage 5gb && docker image prune -a -f --filter "until=168h"
# （每週日凌晨 3 點；不要在正式機排程 docker system prune --volumes：
#   剛好處於停止狀態的服務，它的資料 volume 也可能被清掉）
```

```json
// 5. 設定 Docker 日誌大小限制（/etc/docker/daemon.json，見 10.5；只對新建立的容器生效）
{
  "log-driver": "local",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
```

---

## 10.9 本章小結

- 生產環境部署前務必完成檢查清單：版本標籤、健康檢查、資源限制、安全設定
- 部署的版本寫進 `.env`，所有 `docker compose` 指令都看同一個版本
- CI/CD 流水線應包含：測試 → 建構 → 掃描（推送前）→ 推送 → 部署；部署用不可變的 sha 標籤
- `docker compose up -d` 換版會中斷服務；零停機要「先起新版、確認健康、切流量、再關舊版」，並搭配優雅停機
- 日誌應輸出到 stdout/stderr，使用 JSON 結構化格式，並限制日誌檔大小
- 資料庫用 `pg_dump` 等工具備份，定期演練還原，並保存一份在異地
- 監控容器資源使用，設定告警

---

> 恭喜你完成了 Docker 核心篇（01–10）！🎉 你已具備從開發到上線的完整能力。
>
> 接下來是容器編排的進階路線，把單機能力延伸到多節點：
>
> 上一章：[安全性最佳實踐](./09-security.md) | 下一章：[Kubernetes 入門（從 Docker 到 K8s）](./11-kubernetes-basics.md)
>
> 或回到 [課程目錄](./README.md)
