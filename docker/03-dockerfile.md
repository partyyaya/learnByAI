# 第三章：Dockerfile 撰寫與映像建構

## 3.1 什麼是 Dockerfile？

Dockerfile 是一個純文字檔案，包含一系列指令，用來告訴 Docker 如何自動建構映像檔。每一行指令都會在映像中建立一個新的層（Layer）。

### 基本範例

```dockerfile
# 選擇基礎映像（提供 Node.js 執行環境；alpine 體積較小）
FROM node:20-alpine

# 設定工作目錄（容器內路徑，不是本機路徑；若不存在會自動建立）
# 後續 RUN/COPY/CMD 的相對路徑都以 /app 為基準（例如 COPY . . 會複製到 /app）
WORKDIR /app

# 先複製依賴描述檔（利用 Docker layer 快取，避免每次都重裝套件）
COPY package*.json ./

# 依 lock file 安裝正式環境依賴（可重現建構、映像較精簡）
RUN npm ci --only=production

# 再複製應用程式碼（把主機端 build context 的檔案複製到容器內）
# 左邊 `.` = build context（預設是執行 docker build 時，終端機目前所在路徑）
# 右邊 `.` = 容器內 WORKDIR（此例是 /app）
COPY . .

# 宣告容器內應用使用 3000 port（僅 metadata，不會自動對外開放）
# 主機要能連到容器，執行時仍需 `docker run -p 3000:3000 ...`
EXPOSE 3000

# 容器啟動時在「容器內」執行的預設命令（不是在主機端執行）
# 此例會在容器內執行 `node server.js`，可在 docker run 後方覆蓋
CMD ["node", "server.js"]
```

### 建構映像

```bash
# 基本建構
# -t: 指定建出來的 image 名稱與標籤（repository:tag）
# . : build context，代表用「主機端目前目錄」的檔案給 Dockerfile 使用（不是容器路徑）
# 預設會讀取 build context 根目錄下名為 `Dockerfile` 的檔案（注意 D 大寫）
# 若檔名不同（例如 Dockerfile.prod），需用 -f 明確指定
docker build -t my-app:v1.0 .

# 指定 Dockerfile 路徑
# -f Dockerfile.prod: 指定要使用哪個 Dockerfile（可不叫預設 Dockerfile）
# -t my-app:prod: 這次建構出的映像標籤是 prod
# 最後的 . 仍是 build context（不是 Dockerfile 路徑）
docker build -f Dockerfile.prod -t my-app:prod .

# 不使用快取建構
# --no-cache: 每一步都重跑，不使用先前的 layer cache（排查快取問題時常用）
docker build --no-cache -t my-app:v1.0 .

# 傳入建構參數
# --build-arg KEY=VALUE: 傳值給 Dockerfile 內的 ARG（僅建構期可用）
docker build --build-arg NODE_ENV=production -t my-app:prod .

# 查看建構過程的詳細資訊
# --progress=plain: 以純文字輸出完整 build log（方便除錯）
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
# CMD：容器啟動時的預設指令（可被 docker run 後方參數整段覆蓋）
# 注意：同一個 Dockerfile 只能生效「最後一個 CMD」
CMD ["node", "server.js"]
CMD ["python", "app.py"]
CMD ["nginx", "-g", "daemon off;"]  # 只有這行會生效

# 覆蓋 CMD（沒有 ENTRYPOINT 時）
# docker run my-app                 → nginx -g "daemon off;"
# docker run my-app sh              → sh（整段取代 CMD）
# docker run my-app echo hello      → echo hello（整段取代 CMD）

# ENTRYPOINT：容器的入口指令（一般不會被 run 後方參數取代；參數會附加在後面）
ENTRYPOINT ["python", "app.py"]

# ENTRYPOINT 的參數附加行為
# docker run my-app                 → python app.py
# docker run my-app --debug         → python app.py --debug
# 若真的要改入口指令：docker run --entrypoint sh my-app

# 搭配使用：ENTRYPOINT 定義指令，CMD 定義預設參數
ENTRYPOINT ["python", "manage.py"]
CMD ["runserver", "0.0.0.0:8000"]

# 這樣可以靈活地覆蓋參數：
# docker run my-app                        → python manage.py runserver 0.0.0.0:8000
# docker run my-app migrate                → python manage.py migrate
# docker run my-app createsuperuser        → python manage.py createsuperuser
```

什麼時候用 `ENTRYPOINT`？

- 把映像做成「固定用途工具」時（例如永遠執行 `python manage.py`、`nginx`、`mycli`）。
- 你想讓使用者只改「參數」，不改主程式時（搭配 `CMD` 放預設參數最方便）。
- 若你希望 `docker run my-image <something>` 可以完全改執行內容，主要用 `CMD` 就好。

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

何時用 `ENV`？

- 需要在「容器執行時」仍可取得的設定值（例如 `NODE_ENV`、`APP_PORT`、`TZ`）。
- 應用程式啟動時會讀取的設定（例如 `CMD` 啟動後由程式讀取）。
- 想提供預設值，並允許 `docker run -e` 在啟動時覆蓋。

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

何時用 `ARG`？

- 只在 build 階段需要的值（例如基底版本、下載來源、建構開關）。
- 想在建構時切換版本，但不希望該值留在最終執行環境。
- 常見於 `FROM node:${NODE_VERSION}-alpine` 這類可參數化基底映像。

快速判斷：

- 需要「容器啟動後」也看得到 → 用 `ENV`
- 只需要「建構當下」使用 → 用 `ARG`

### EXPOSE — 暴露 Port

```dockerfile
# 聲明容器內應用監聽的 port（預設協定是 tcp）
EXPOSE 3000         # 等同 EXPOSE 3000/tcp
EXPOSE 8080/tcp     # 明確宣告 TCP
EXPOSE 8443/udp     # 明確宣告 UDP（如 DNS、串流、遊戲伺服器常見）

# 注意：EXPOSE 只是一種 metadata / 文件宣告，不會自動對外開放
# 對外連線仍需 docker run -p 主機埠:容器埠（或用 -P 自動映射 EXPOSE 的埠）
```

為什麼 `EXPOSE 8080/tcp` 要加 `/tcp`？

- Docker 可同時處理 TCP/UDP，`/tcp` 是在明確指定協定。
- 不寫時預設就是 TCP，所以 `EXPOSE 3000` 等同 `EXPOSE 3000/tcp`。
- 若你的服務用 UDP，必須明確寫成 `EXPOSE 8443/udp`。

為什麼會先寫 `EXPOSE`？

- 讓看 Dockerfile 的人一眼知道容器預期使用哪些埠。
- 搭配 `docker run -P`（大寫 P）時，Docker 會自動映射所有 `EXPOSE` 的埠到主機隨機埠。
- 方便其他工具或平台（Compose、掃描工具）讀取容器埠資訊。

### VOLUME — 宣告掛載點

```dockerfile
# 宣告容器內哪些目錄需要持久化
VOLUME /data
VOLUME ["/data", "/logs"]

# 若執行時沒指定 -v/--mount，Docker 會自動建立匿名 volume
```

`VOLUME` 何時使用？

- 資料不能跟容器一起消失時（例如資料庫資料、上傳檔案、應用日誌）。
- 希望容器刪掉重建後，資料仍保留。
- 需要和其他容器共用同一份資料時（透過同一個 named volume）。

`VOLUME` 與主機的關聯：

- `VOLUME /data` 只宣告「容器內路徑」，不等於指定主機哪個資料夾。
- 若沒指定映射，Docker 會在主機上由自己管理一個匿名 volume（路徑由 Docker 決定）。
- 若你要「固定主機路徑」或「可讀名稱」，執行時要明確指定：
  - `-v /host/path:/data`（bind mount，綁定主機目錄）
  - `-v mydata:/data`（named volume，Docker 管理但有名字）

### USER — 指定執行使用者

```dockerfile
# 建立非 root 使用者（安全性最佳實踐）
# addgroup -S: 建立系統群組（system group）
# adduser  -S: 建立系統使用者（system user）
# -G appgroup: 把 appuser 加入 appgroup
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# 切換使用者
# 從這行開始，後續指令預設不再用 root 身份執行
USER appuser

# 之後的 RUN, CMD, ENTRYPOINT 都以 appuser 身份執行
```

何時會用到 `USER`？

- 幾乎所有正式環境映像都建議使用（避免主程式以 root 執行）。
- 容器若被攻擊時，可降低權限擴大風險（最小權限原則）。
- 適合 Web/API 服務、批次工作等一般應用；除非你真的需要 root 權限才保留 root。

常見流程：

1. 前面先用 root 安裝套件、建立目錄與設定權限。
2. 最後再 `USER appuser`，讓應用以低權限啟動。

### HEALTHCHECK — 健康檢查

```dockerfile
# 定義健康檢查
# --interval=30s: 每 30 秒檢查一次
# --timeout=10s: 單次檢查最多等 10 秒，超時視為失敗
# --start-period=5s: 容器啟動後前 5 秒為暖機期，失敗不計入重試次數
# --retries=3: 連續失敗 3 次才標記為 unhealthy
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  # curl -f: HTTP 狀態碼 4xx/5xx 時回傳非 0（判定失敗）
  # || exit 1: 明確回傳失敗碼，讓 Docker 判定健康檢查失敗
  CMD curl -f http://localhost:3000/health || exit 1

# 停用健康檢查
# 有些基底映像已內建 HEALTHCHECK，可用 NONE 關閉
HEALTHCHECK NONE
```

何時會用到 `HEALTHCHECK`？

- 容器「進程還活著」但服務其實不可用時（例如 API 卡死、DB 連不上）。
- 服務啟動需要暖機時間時（可搭配 `--start-period` 避免誤判）。
- 需要讓編排器/平台判斷健康狀態時（例如 Docker / Compose / K8s 監控）。
- 想把「活著（running）」和「可服務（healthy）」明確區分時。

常見做法：

- Web/API 服務檢查 `GET /health`（或 `/ready`）。
- Worker 類服務可檢查程序、佇列連線或關鍵依賴是否可用。

---

## 3.3 .dockerignore 檔案

類似 `.gitignore`，用來排除不需要送進建構上下文的檔案：

- 放置位置：放在 build context 的根目錄（通常與 `Dockerfile` 同層）。
- 生效時機：執行 `docker build <context>`（或 `docker compose build`）時生效。
- 生效範圍：只影響「主機送去建構的檔案集合」，不會影響容器啟動後的檔案系統。
- 例：`docker build -t my-app .` 會讀取目前目錄的 `.dockerignore`。

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
# COPY 語法：COPY <來源...> <目的地>
# 此行有兩個來源（package.json、package-lock.json）和一個目的地（./，即目前 WORKDIR）
COPY package.json package-lock.json ./
# npm ci: 依 package-lock.json 安裝，結果可重現（適合 CI / 生產環境）
# --only=production: 只安裝 dependencies，不安裝 devDependencies（減少映像大小）
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
# builder 階段：負責編譯/打包，會包含完整建構工具與 dev 依賴
FROM node:20-alpine AS builder

WORKDIR /app
# 來源是主機 build context（docker build 最後那個 .）
COPY package*.json ./
RUN npm ci
# 把主機專案檔案複製進 builder 容器
COPY . .
# 例如輸出前端或後端建構產物到 /app/dist
RUN npm run build

# ===== 階段 2：生產映像 =====
# production 階段：從乾淨基底開始，只放執行所需內容
FROM node:20-alpine AS production

WORKDIR /app

# 只安裝生產相依套件
# 這裡同樣是從主機 build context 複製 package 檔，不是沿用 builder 檔案系統
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# 從 builder 階段複製建構產物
# --from=builder 代表「從上一階段容器檔案系統」複製，不會回到主機抓檔案
# /app/dist（來源）= 第一階段 builder 內的路徑
# ./dist（目的地）= 目前這個階段（production）的 WORKDIR 內路徑（此例是 /app/dist）
COPY --from=builder /app/dist ./dist

# 建立非 root 使用者
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3000
CMD ["node", "dist/server.js"]
```

重點釐清：

- **是的**，第一段（`builder`）打包後的產物，會透過 `COPY --from=builder ...` 給第二段使用。
- 主機資料夾只會在 `COPY ...`（沒有 `--from`）時被使用，來源是 build context。
- 每個 `FROM` 都是新的檔案系統起點；第二段看不到第一段內容，除非你用 `COPY --from=...` 明確複製。

Docker 在這個範例的實際運行流程：

1. `docker build -t my-app:prod .` 時，Docker 先把主機 build context（`.`）送進建構流程。
2. 先執行 `builder` 階段：安裝完整相依、複製程式碼、`npm run build` 產出 `/app/dist`。
3. 再執行 `production` 階段：從新基底開始，只安裝 production 相依。
4. 用 `COPY --from=builder /app/dist ./dist` 把第一階段產物帶進第二階段。
5. 建構完成後，最終 image 內容來自最後階段（`production`）；`builder` 本身不會成為最終運行映像。
6. `docker run -p 3000:3000 my-app:prod` 時，容器會在第二階段環境啟動，執行 `CMD ["node", "dist/server.js"]`。

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
