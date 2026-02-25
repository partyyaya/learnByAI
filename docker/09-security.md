# 第九章：安全性最佳實踐

## 9.1 Docker 安全全景圖

```
┌─────────────────────────────────────────────────────────────┐
│                    Docker 安全層面                            │
├─────────────┬─────────────┬─────────────┬──────────────────┤
│  映像安全    │  容器安全    │  網路安全    │  主機安全         │
├─────────────┼─────────────┼─────────────┼──────────────────┤
│ ·最小化映像  │ ·非root執行  │ ·網路隔離   │ ·Docker 更新     │
│ ·漏洞掃描    │ ·唯讀檔案系統│ ·限制port    │ ·核心加固        │
│ ·可信來源    │ ·資源限制    │ ·TLS 加密   │ ·存取控制        │
│ ·不含secret  │ ·capabilities│ ·防火牆規則 │ ·稽核日誌        │
└─────────────┴─────────────┴─────────────┴──────────────────┘
```

---

## 9.2 映像安全

### 使用最小化映像

```dockerfile
# ❌ 完整映像（包含大量不需要的工具）
FROM ubuntu:22.04         # ~77MB
FROM node:20              # ~1.1GB
FROM python:3.12          # ~1GB

# ✅ 精簡映像
FROM alpine:3.19          # ~7MB
FROM node:20-alpine       # ~130MB
FROM python:3.12-slim     # ~125MB

# ✅✅ 最極致：空映像（適合靜態編譯的 Go / Rust）
FROM scratch              # 0MB
```

### 映像漏洞掃描

```bash
# 使用 Docker Scout（官方工具）
docker scout cves my-app:latest
docker scout recommendations my-app:latest

# 使用 Trivy（開源掃描工具）
# 安裝
brew install trivy

# 掃描映像
trivy image my-app:latest

# 只顯示 HIGH 和 CRITICAL 級別的漏洞
trivy image --severity HIGH,CRITICAL my-app:latest

# 在 CI 中使用（發現嚴重漏洞時失敗）
trivy image --exit-code 1 --severity CRITICAL my-app:latest
```

### 固定映像版本

```dockerfile
# ❌ 不要用 latest（每次建構可能拉到不同版本）
FROM node:latest

# ❌ 避免只用主版本
FROM node:20

# ✅ 使用完整版本號
FROM node:20.11.1-alpine3.19

# ✅✅ 使用 digest（最精確，不可變）
FROM node:20-alpine@sha256:abcdef1234567890...
```

### 不在映像中存放 Secret

```dockerfile
# ❌ Secret 會永久記錄在映像層中
ENV API_KEY=sk-xxxxx
COPY .env /app/.env
RUN echo "password=secret" > /app/config.txt

# ✅ 使用 BuildKit Secret Mount（建構時使用，不會留在映像中）
# syntax=docker/dockerfile:1
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc \
    npm ci

# 建構指令
# DOCKER_BUILDKIT=1 docker build --secret id=npmrc,src=.npmrc -t my-app .

# ✅ 運行時注入
docker run -e API_KEY=sk-xxxxx my-app
docker run --env-file .env my-app
```

---

## 9.3 容器安全

### 以非 Root 使用者運行

```dockerfile
# Node.js 映像（已內建 node 使用者）
FROM node:20-alpine
WORKDIR /app
COPY --chown=node:node . .
USER node

# Alpine 映像（手動建立使用者）
FROM alpine:3.19
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

# Debian/Ubuntu 映像
FROM python:3.12-slim
RUN useradd --create-home --shell /bin/bash appuser
USER appuser

# 驗證
docker exec my-container whoami
# appuser
docker exec my-container id
# uid=1000(appuser) gid=1000(appgroup) groups=1000(appgroup)
```

### 唯讀檔案系統

```bash
# 啟動時設定容器檔案系統為唯讀
docker run -d --read-only my-app

# 需要寫入的目錄使用 tmpfs
docker run -d \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=100m \
  --tmpfs /var/run:rw \
  my-app
```

```yaml
# Docker Compose
services:
  api:
    image: my-api
    read_only: true
    tmpfs:
      - /tmp:size=100m
      - /var/run
    volumes:
      - api-logs:/app/logs    # 只有需要持久化的目錄可寫
```

### 限制 Capabilities

```bash
# 移除所有 capabilities，只添加需要的
docker run -d \
  --cap-drop ALL \
  --cap-add NET_BIND_SERVICE \
  my-app
```

```yaml
# Docker Compose
services:
  api:
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE    # 綁定 < 1024 的 port
```

### 資源限制

```yaml
# Docker Compose
services:
  api:
    deploy:
      resources:
        limits:
          cpus: '1.0'
          memory: 512M
          pids: 100           # 限制行程數（防止 fork bomb）
        reservations:
          cpus: '0.25'
          memory: 128M
```

### 禁止特權模式

```bash
# ❌ 非常危險！特權容器擁有主機的所有權限
docker run --privileged my-app

# ❌ 也很危險
docker run -v /:/host my-app        # 掛載主機根目錄
docker run --pid=host my-app        # 共享主機 PID namespace
docker run --network=host my-app    # 在生產環境要謹慎使用

# ✅ 安全的做法
docker run \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --read-only \
  my-app
```

---

## 9.4 網路安全

### 網路隔離

```yaml
# 將不同服務放在不同網路中
services:
  # 前端只能訪問 API
  frontend:
    networks:
      - public

  # API 連接前端和資料庫網路
  api:
    networks:
      - public
      - internal

  # 資料庫只在內部網路
  db:
    networks:
      - internal

networks:
  public:
    driver: bridge
  internal:
    driver: bridge
    internal: true    # 禁止外部存取
```

### 最小化 Port 暴露

```yaml
services:
  db:
    image: postgres:16-alpine
    # ❌ 不要在生產環境暴露資料庫 port
    # ports:
    #   - "5432:5432"

    # ✅ 只在 Docker 網路內部可存取
    expose:
      - "5432"
```

### 使用 TLS 加密通訊

```yaml
services:
  nginx:
    image: nginx:1.25-alpine
    ports:
      - "443:443"
    volumes:
      - ./certs:/etc/nginx/certs:ro
      - ./nginx-ssl.conf:/etc/nginx/conf.d/default.conf:ro
```

---

## 9.5 Secret 管理

### Docker Compose Secrets

```yaml
# docker-compose.yml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD_FILE: /run/secrets/db_password
    secrets:
      - db_password

  api:
    build: .
    secrets:
      - db_password
      - api_key

secrets:
  db_password:
    file: ./secrets/db_password.txt
  api_key:
    file: ./secrets/api_key.txt
```

```bash
# 建立 secret 檔案
mkdir -p secrets
echo "my_secure_password" > secrets/db_password.txt
echo "sk-xxxxxxxx" > secrets/api_key.txt

# 確保 secrets 不被加入版本控制
echo "secrets/" >> .gitignore
```

### 在應用程式中讀取 Secret

```javascript
// Node.js 範例
const fs = require('fs');

function getSecret(name) {
  try {
    // Docker Secret 會掛載在 /run/secrets/
    return fs.readFileSync(`/run/secrets/${name}`, 'utf8').trim();
  } catch (err) {
    // 回退到環境變數
    return process.env[name.toUpperCase()];
  }
}

const dbPassword = getSecret('db_password');
```

```python
# Python 範例
import os

def get_secret(name):
    """讀取 Docker Secret，回退到環境變數"""
    try:
        with open(f'/run/secrets/{name}', 'r') as f:
            return f.read().strip()
    except FileNotFoundError:
        return os.environ.get(name.upper())

db_password = get_secret('db_password')
```

---

## 9.6 Dockerfile 安全檢查清單

```dockerfile
# ✅ 安全的 Dockerfile 範例
# syntax=docker/dockerfile:1

# 1. 使用特定版本的最小化映像
FROM node:20.11.1-alpine3.19

# 2. 設定工作目錄
WORKDIR /app

# 3. 只複製必要的檔案
COPY package.json package-lock.json ./
RUN npm ci --only=production && npm cache clean --force

COPY src/ ./src/

# 4. 不要在映像中存放 secret
# ❌ COPY .env ./
# ❌ ENV API_KEY=sk-xxxx

# 5. 建立並使用非 root 使用者
RUN addgroup -S appgroup && \
    adduser -S appuser -G appgroup && \
    chown -R appuser:appuser /app

USER appuser

# 6. 使用 HEALTHCHECK
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

# 7. 暴露最少的 port
EXPOSE 3000

# 8. 使用 exec 格式的 CMD
CMD ["node", "src/server.js"]
```

---

## 9.7 實際情境

### 情境一：映像被掃出嚴重漏洞

**問題**：CI 掃描發現映像中有 CRITICAL 漏洞

```bash
# 1. 查看漏洞詳情
trivy image --severity CRITICAL my-app:latest

# 2. 常見解決方案：
# a. 更新基礎映像
FROM node:20.11.1-alpine3.19  # 改用最新版本

# b. 更新系統套件
RUN apk update && apk upgrade --no-cache

# c. 更新應用相依套件
RUN npm audit fix

# 3. 重新建構後再掃描
docker build -t my-app:latest .
trivy image my-app:latest
```

### 情境二：容器以 root 身份運行

**問題**：安全稽核發現容器以 root 執行

```bash
# 確認容器的執行使用者
docker exec my-container whoami
# root ← 不安全

# 解決方案一：在 Dockerfile 中加入 USER
USER node  # 或自行建立的使用者

# 解決方案二：在 docker run 時指定使用者
docker run -u 1000:1000 my-app

# 解決方案三：在 Docker Compose 中指定
services:
  api:
    user: "1000:1000"
```

### 情境三：Secret 被提交到 Git

**問題**：`.env` 檔案被提交到 Git Repository

```bash
# 1. 立即更換所有外洩的 secret（API Key、密碼等）

# 2. 從 Git 歷史中移除 .env
# 使用 BFG Repo-Cleaner
bfg --delete-files .env
git reflog expire --expire=now --all
git gc --prune=now --aggressive

# 3. 確保 .gitignore 有包含 .env
echo ".env" >> .gitignore
echo "secrets/" >> .gitignore

# 4. 提供 .env.example 作為範本
cp .env .env.example
# 移除 .env.example 中的真實值
```

---

## 9.8 本章小結

- 使用最小化映像（Alpine / slim / scratch），減少攻擊面
- 永遠以非 Root 使用者運行容器
- 不在映像中存放 Secret——使用環境變數或 Docker Secrets
- 定期掃描映像漏洞（Trivy / Docker Scout）
- 利用網路隔離限制服務間的存取
- 設定資源限制，防止單一容器耗盡主機資源
- 啟用唯讀檔案系統，移除不必要的 Capabilities

---

> 上一章：[除錯與問題排查](./08-debugging-troubleshooting.md) | 下一章：[生產環境部署與 CI/CD](./10-production-cicd.md)
