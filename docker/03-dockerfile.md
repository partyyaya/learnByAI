# 第三章：Dockerfile 撰寫與映像建構

## 3.1 什麼是 Dockerfile？

Dockerfile 是一個純文字檔案，包含一系列指令，用來告訴 Docker 如何自動建構映像檔。每一行指令都會在映像中建立一個新的層（Layer）。

### 基本範例

```dockerfile
# 選擇基礎映像
FROM node:20-alpine

# 設定工作目錄
WORKDIR /app

# 複製 package.json（利用快取機制）
COPY package*.json ./

# 安裝相依套件
RUN npm ci --only=production

# 複製應用程式碼
COPY . .

# 暴露 port
EXPOSE 3000

# 啟動指令
CMD ["node", "server.js"]
```

### 建構映像

```bash
# 基本建構
docker build -t my-app:v1.0 .

# 指定 Dockerfile 路徑
docker build -f Dockerfile.prod -t my-app:prod .

# 不使用快取建構
docker build --no-cache -t my-app:v1.0 .

# 傳入建構參數
docker build --build-arg NODE_ENV=production -t my-app:prod .

# 查看建構過程的詳細資訊
docker build --progress=plain -t my-app:v1.0 .
```

---

## 3.2 Dockerfile 指令詳解

### FROM — 基礎映像

```dockerfile
# 使用官方映像
FROM node:20-alpine

# 使用特定版本（推薦用於生產環境）
FROM node:20.11.1-alpine3.19

# 使用最精簡的映像
FROM alpine:3.19

# 使用空映像（適合靜態編譯的程式，如 Go）
FROM scratch

# 為建構階段命名（Multi-stage Build）
FROM node:20-alpine AS builder
```

> **最佳實踐**：永遠指定明確的版本標籤，避免使用 `latest`。

### WORKDIR — 工作目錄

```dockerfile
# 設定工作目錄（如果不存在會自動建立）
WORKDIR /app

# 之後的 RUN, CMD, COPY, ADD 指令都以此為相對路徑
COPY . .
RUN npm install
```

### COPY vs ADD

```dockerfile
# COPY：單純複製檔案（推薦使用）
COPY package.json ./
COPY src/ ./src/
COPY . .

# 使用 --chown 設定檔案擁有者
COPY --chown=node:node . .

# ADD：功能更多，但不推薦日常使用
# ADD 會自動解壓縮 tar 檔案
ADD app.tar.gz /app/

# ADD 支援 URL（但不推薦，建議用 RUN curl）
ADD https://example.com/file.tar.gz /tmp/
```

> **最佳實踐**：除非需要自動解壓縮，否則一律使用 `COPY`。

### RUN — 執行指令

```dockerfile
# Shell 格式（預設使用 /bin/sh -c）
RUN apt-get update && apt-get install -y curl

# Exec 格式
RUN ["apt-get", "install", "-y", "curl"]

# 多指令合併（減少層數，推薦）
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      curl \
      wget \
      git && \
    rm -rf /var/lib/apt/lists/*

# 安裝 Python 相依套件
RUN pip install --no-cache-dir -r requirements.txt
```

> **最佳實踐**：將多個 `RUN` 合併為一個，用 `&&` 連接，減少映像層數與大小。

### CMD vs ENTRYPOINT

```dockerfile
# CMD：容器啟動時的預設指令（可被 docker run 的參數覆蓋）
CMD ["node", "server.js"]
CMD ["python", "app.py"]
CMD ["nginx", "-g", "daemon off;"]

# ENTRYPOINT：容器的入口指令（不會被覆蓋，docker run 的參數會附加在後面）
ENTRYPOINT ["python", "app.py"]

# 搭配使用：ENTRYPOINT 定義指令，CMD 定義預設參數
ENTRYPOINT ["python", "manage.py"]
CMD ["runserver", "0.0.0.0:8000"]

# 這樣可以靈活地覆蓋參數：
# docker run my-app                        → python manage.py runserver 0.0.0.0:8000
# docker run my-app migrate                → python manage.py migrate
# docker run my-app createsuperuser        → python manage.py createsuperuser
```

### ENV — 環境變數

```dockerfile
# 設定環境變數
ENV NODE_ENV=production
ENV APP_PORT=3000

# 多個變數
ENV NODE_ENV=production \
    APP_PORT=3000 \
    LOG_LEVEL=info

# 在 RUN 中使用
RUN echo "Environment: $NODE_ENV"
```

### ARG — 建構參數

```dockerfile
# 宣告建構參數
ARG NODE_VERSION=20
ARG APP_VERSION

# 使用在 FROM 中
ARG NODE_VERSION=20
FROM node:${NODE_VERSION}-alpine

# 建構時傳入
# docker build --build-arg APP_VERSION=1.2.3 -t my-app .

# ARG vs ENV 差異
# ARG：僅在建構時可用，不會存在於最終映像
# ENV：建構時和容器運行時都可用
```

### EXPOSE — 暴露 Port

```dockerfile
# 聲明容器使用的 port（僅作為文件用途）
EXPOSE 3000
EXPOSE 8080/tcp
EXPOSE 8443/udp

# 注意：EXPOSE 不會實際發佈 port，需要 docker run -p 來對映
```

### VOLUME — 宣告掛載點

```dockerfile
# 宣告資料卷
VOLUME /data
VOLUME ["/data", "/logs"]

# 容器啟動時，Docker 會自動建立匿名 volume
```

### USER — 指定執行使用者

```dockerfile
# 建立非 root 使用者（安全性最佳實踐）
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# 切換使用者
USER appuser

# 之後的 RUN, CMD, ENTRYPOINT 都以 appuser 身份執行
```

### HEALTHCHECK — 健康檢查

```dockerfile
# 定義健康檢查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# 停用健康檢查
HEALTHCHECK NONE
```

---

## 3.3 .dockerignore 檔案

類似 `.gitignore`，用來排除不需要送進建構上下文的檔案：

```
# .dockerignore

# 版本控制
.git
.gitignore

# 相依套件目錄
node_modules
vendor
__pycache__
*.pyc

# 環境設定
.env
.env.*
*.env

# IDE 設定
.vscode
.idea
*.swp

# 建構產物
dist
build
*.log

# Docker 相關
Dockerfile*
docker-compose*.yml
.dockerignore

# 測試
test
tests
coverage
.nyc_output

# 文件
README.md
docs
LICENSE
```

> **重要**：沒有 `.dockerignore` 時，整個目錄（包含 `node_modules`、`.git` 等）都會被送進建構上下文，大幅拖慢建構速度。

---

## 3.4 建構快取機制

Docker 建構時會逐層快取。如果某一層的內容沒有變動，就會使用快取，大幅加速建構。

### 快取原則

```
指令順序很重要！
將變動頻率低的指令放在前面，變動頻率高的放在後面。
```

### 不良範例

```dockerfile
FROM node:20-alpine
WORKDIR /app

# ❌ 每次程式碼變動都會使 npm install 快取失效
COPY . .
RUN npm install

CMD ["node", "server.js"]
```

### 最佳範例

```dockerfile
FROM node:20-alpine
WORKDIR /app

# ✅ 先複製 package.json，利用快取
COPY package.json package-lock.json ./
RUN npm ci --only=production

# 程式碼變動只影響這一層之後
COPY . .

CMD ["node", "server.js"]
```

### 快取失效情境

```
COPY / ADD 的檔案內容有變動 → 該層及之後所有層快取失效
RUN 指令內容有變動 → 該層及之後所有層快取失效
FROM 映像有更新 → 所有層快取失效
使用 --no-cache 建構 → 所有層快取失效
```

---

## 3.5 Multi-stage Build（多階段建構）

Multi-stage Build 是建構小映像的關鍵技巧，允許在一個 Dockerfile 中使用多個 `FROM` 指令。

### 基本範例：Node.js 應用

```dockerfile
# ===== 階段 1：建構 =====
FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ===== 階段 2：生產映像 =====
FROM node:20-alpine AS production

WORKDIR /app

# 只安裝生產相依套件
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# 從 builder 階段複製建構產物
COPY --from=builder /app/dist ./dist

# 建立非 root 使用者
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3000
CMD ["node", "dist/server.js"]
```

### Go 應用（極致精簡）

```dockerfile
# ===== 階段 1：建構 =====
FROM golang:1.22-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /app/server .

# ===== 階段 2：最終映像 =====
FROM scratch

COPY --from=builder /app/server /server
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/

EXPOSE 8080
ENTRYPOINT ["/server"]
```

> 使用 `scratch` 空映像，最終映像可能只有 10-20MB！

### React / Vue 前端應用

```dockerfile
# ===== 階段 1：建構前端資源 =====
FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ===== 階段 2：Nginx 提供靜態檔案 =====
FROM nginx:1.25-alpine

# 複製自訂 Nginx 設定
COPY nginx.conf /etc/nginx/conf.d/default.conf

# 從 builder 階段複製建構產物
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

### Python / Django 應用

```dockerfile
# ===== 階段 1：建構 =====
FROM python:3.12-slim AS builder

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends gcc libpq-dev && \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# ===== 階段 2：生產映像 =====
FROM python:3.12-slim

WORKDIR /app

# 只複製安裝好的套件
COPY --from=builder /install /usr/local

# 複製應用程式碼
COPY . .

# 建立非 root 使用者
RUN useradd --create-home appuser
USER appuser

# 收集靜態檔案
RUN python manage.py collectstatic --noinput

EXPOSE 8000
CMD ["gunicorn", "config.wsgi:application", "--bind", "0.0.0.0:8000", "--workers", "4"]
```

---

## 3.6 映像大小最佳化

### 常見技巧

```dockerfile
# 1. 使用 Alpine 映像
FROM node:20-alpine          # 130MB
# 而不是
FROM node:20                 # 1.1GB

# 2. 合併 RUN 指令並清理快取
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

# 3. 使用 Multi-stage Build
# （見上一節）

# 4. 使用 --no-cache 安裝套件
RUN pip install --no-cache-dir -r requirements.txt
RUN npm ci && npm cache clean --force
RUN apk add --no-cache curl

# 5. 最小化 COPY 範圍
COPY src/ ./src/
COPY package.json ./
# 而不是
COPY . .
```

### 檢視映像大小

```bash
# 查看映像大小
docker images my-app

# 使用 dive 工具分析映像各層
# 安裝：https://github.com/wagoodman/dive
dive my-app:latest
```

---

## 3.7 實際情境

### 情境一：建構時 npm install 每次都重跑

**問題**：只改了一行程式碼，`npm install` 又跑了好幾分鐘

```dockerfile
# ❌ 錯誤做法
FROM node:20-alpine
WORKDIR /app
COPY . .               # 任何檔案變動都會使快取失效
RUN npm install         # 每次都重新安裝
CMD ["node", "server.js"]

# ✅ 正確做法：分離相依套件安裝與程式碼複製
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./    # 只有 package.json 變動才會重裝
RUN npm ci
COPY . .                                   # 程式碼變動只影響這層
CMD ["node", "server.js"]
```

### 情境二：映像大小超過 1GB

**問題**：建構出來的映像太大，推送和部署都很慢

```bash
# 查看映像各層大小
docker history my-app:latest

# 常見原因與解決方案：
# 1. 使用了完整版映像 → 改用 alpine 或 slim
# 2. 沒有清理 apt/apk 快取 → 加上 rm -rf /var/lib/apt/lists/*
# 3. 把建構工具帶進最終映像 → 使用 Multi-stage Build
# 4. 複製了 node_modules/.git 等不必要檔案 → 加入 .dockerignore
```

### 情境三：Dockerfile 中的 secret 外洩

**問題**：不小心把 API Key 寫在 Dockerfile 中

```dockerfile
# ❌ 非常危險！secret 會被記錄在映像的 layer 中
RUN echo "API_KEY=sk-xxxxx" > /app/.env
ENV API_KEY=sk-xxxxx

# ✅ 使用 BuildKit secret mount
# syntax=docker/dockerfile:1
RUN --mount=type=secret,id=api_key \
    export API_KEY=$(cat /run/secrets/api_key) && \
    ./configure

# 建構時傳入 secret
# docker build --secret id=api_key,src=./api_key.txt -t my-app .

# ✅ 在運行時透過環境變數或 secret 管理工具注入
docker run -e API_KEY=sk-xxxxx my-app
```

### 情境四：建構在 CI 上很慢

**問題**：本地建構很快，但 CI/CD 環境每次都是全新建構

```bash
# 解決方案：利用遠端快取

# 建構時輸出快取
docker build \
  --cache-from myregistry.com/my-app:cache \
  --build-arg BUILDKIT_INLINE_CACHE=1 \
  -t myregistry.com/my-app:latest \
  -t myregistry.com/my-app:cache \
  .

# 推送快取映像
docker push myregistry.com/my-app:cache

# CI 中使用快取
docker pull myregistry.com/my-app:cache || true
docker build --cache-from myregistry.com/my-app:cache -t my-app .
```

---

## 3.8 本章小結

- Dockerfile 是自動化建構映像的核心檔案
- 指令順序影響建構快取效率——將不常變動的指令放前面
- 務必建立 `.dockerignore` 排除不必要的檔案
- Multi-stage Build 是縮小映像的關鍵技巧
- 永遠不要在 Dockerfile 中硬編碼 secret
- 生產映像應使用非 root 使用者執行

---

> 上一章：[映像檔與容器基礎操作](./02-images-containers.md) | 下一章：[Docker Compose 多容器編排](./04-docker-compose.md)
