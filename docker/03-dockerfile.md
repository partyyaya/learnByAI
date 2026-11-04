# 第三章：Dockerfile 撰寫與映像建構

## 3.1 什麼是 Dockerfile？

Dockerfile 是一個純文字檔案，包含一系列指令，用來告訴 Docker 如何自動建構映像檔。其中 `RUN`、`COPY`、`ADD` 會產生含檔案的映像層（第二章 2.4 的唯讀層）；`ENV`、`CMD`、`EXPOSE` 這類指令只修改映像的設定，不增加檔案。

### 跟著做：準備練習專案

本章用一個沒有任何外部套件的小型 Node.js 服務當練習對象。主機**不需要安裝 Node.js**，需要 Node 的步驟都用容器執行。

```bash
mkdir -p ~/docker-practice/hello-docker
cd ~/docker-practice/hello-docker
```

建立 `package.json`：

```json
{
  "name": "hello-docker",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "start": "node server.js"
  }
}
```

建立 `server.js`：

```javascript
const http = require('node:http');
const os = require('node:os');

const port = Number(process.env.PORT) || 3000;

const server = http.createServer((req, res) => {
  // 健康檢查端點：之後的 HEALTHCHECK、Compose、Kubernetes 都會用到
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok\n');
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    message: 'Hello from Docker',
    hostname: os.hostname(),               // 容器內的 hostname 預設是容器 ID 的前 12 碼
    env: process.env.NODE_ENV || 'development',
  }) + '\n');
});

// 綁 0.0.0.0：容器外（透過 -p 對映）的請求才進得來；綁 127.0.0.1 只有容器自己連得到
server.listen(port, '0.0.0.0', () => {
  console.log(`listening on ${port}`);
});
```

產生 `package-lock.json`（下面 Dockerfile 的 `npm ci` 一定要有它）：

```bash
# 用 node 容器在目前目錄執行 npm install，產生 package-lock.json
# -v "$PWD":/app -w /app：把目前目錄掛進容器並當成工作目錄，產生的檔案會直接出現在主機上
# -u "$(id -u):$(id -g)"：用你自己的 UID/GID 執行，Linux 主機上產生的檔案才不會變成 root 擁有
# -e HOME=/tmp：非 root 身分的家目錄，npm 需要可寫入的快取目錄
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD":/app -w /app node:24-alpine npm install

ls
# package-lock.json  package.json  server.js
```

### 基本範例

在 `hello-docker` 目錄建立 `Dockerfile`：

```dockerfile
# 選擇基礎映像（提供 Node.js 執行環境；alpine 體積較小）
FROM node:24-alpine

# 設定工作目錄（容器內路徑，不是本機路徑；若不存在會自動建立）
# 後續 RUN/COPY/CMD 的相對路徑都以 /app 為基準（例如 COPY . . 會複製到 /app）
WORKDIR /app

# 先複製依賴描述檔（利用 Docker layer 快取，避免每次都重裝套件）
COPY package*.json ./

# 依 lock file 安裝正式環境依賴（--omit=dev：不裝 devDependencies；可重現建構、映像較精簡）
RUN npm ci --omit=dev

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

建構並執行：

```bash
# 建構映像，命名為 hello-docker:v1
docker build -t hello-docker:v1 .

# 啟動容器
docker run -d --name hello -p 3000:3000 hello-docker:v1

# 驗證
curl http://localhost:3000
# {"message":"Hello from Docker","hostname":"029a5ac63bdb","env":"development"}
curl http://localhost:3000/health
# ok

# 覆蓋 CMD：映像後面接的指令會取代 CMD，這次只印出 Node 版本
docker run --rm hello-docker:v1 node -v

# 先刪掉容器（3.2 的 PID 1 實驗會再用到這個映像）
docker rm -f hello
```

### 建構指令參數

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
# --build-arg KEY=VALUE: 傳值給 Dockerfile 內的 ARG（僅建構期可用；值會留在 docker history，不能傳密碼）
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
FROM node:24-alpine

# 使用特定版本（推薦用於生產環境）
FROM node:24.22.2-alpine3.24

# 使用最精簡的映像
FROM alpine:3.24

# 使用空映像（適合靜態編譯的程式，如 Go）
FROM scratch

# 為建構階段命名（Multi-stage Build）
FROM node:24-alpine AS builder
```

> **最佳實踐**：永遠指定明確的版本標籤，避免使用 `latest`。也要留意版本本身的支援期限：例如 Node.js 20 已在 2026-04-30 停止安全更新，固定在停止支援的版本，等於固定在不會再修補漏洞的版本。

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

# 多指令合併（推薦）
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      curl \
      wget \
      git && \
    rm -rf /var/lib/apt/lists/*

# 安裝 Python 相依套件
RUN pip install --no-cache-dir -r requirements.txt
```

> **最佳實踐**：相關的步驟合併成一個 `RUN`，用 `&&` 連接。原因有兩個：
>
> 1. **清理必須和產生在同一層**：每個 `RUN` 都是一個唯讀層。若在下一個 `RUN` 才 `rm -rf /var/lib/apt/lists/*`，檔案仍存在於上一層，映像一點也不會變小。
> 2. **避免快取拿到過期的套件清單**：若 `apt-get update` 單獨一行，這行命中快取後就不會再執行；之後只改了下一行的安裝清單，就會拿舊的套件索引去安裝，出現找不到套件或裝到舊版的問題。

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

### 跟著做：PID 1 與停止訊號

`CMD` 寫法不只影響「執行什麼」，還影響容器能不能被正常停止。這一段用 3.1 建好的 `hello-docker:v1` 實驗。

**實驗一：程式收不到 SIGTERM**

```bash
cd ~/docker-practice/hello-docker
docker run -d --name hello -p 3000:3000 hello-docker:v1

# 看容器內的行程：node 是 PID 1（{MainThread} 是 busybox ps 顯示的執行緒名稱）
docker exec hello ps -o pid,args
# PID   COMMAND
#     1 {MainThread} node server.js

# 停止容器並計時（-t 10：最多等 10 秒，這也是 Docker 的預設值）
time docker stop -t 10 hello
# real    0m10.2s      ← 等滿 10 秒

docker inspect -f '{{.State.ExitCode}}' hello
# 137                  ← 128 + 9（SIGKILL），代表是被強制殺掉的
docker rm hello
```

原因：容器內第一個行程的 PID 是 1。Linux 核心對 PID 1 有特別規則：**PID 1 沒有自己註冊處理函式的訊號，核心不會套用預設動作**。一般行程收到 `SIGTERM` 會直接結束，但 `server.js` 沒有處理 `SIGTERM`，它又剛好是 PID 1，於是訊號被忽略。Docker 等了 10 秒，最後只好送 `SIGKILL`。

這代表每次部署、重啟都要多等 10 秒，而且程式沒有機會收尾（處理到一半的請求被直接切斷）。

**修法一：`--init`，讓一個小型 init 程式當 PID 1**

```bash
docker run -d --init --name hello -p 3000:3000 hello-docker:v1
docker exec hello ps -o pid,args
#     1 /sbin/docker-init -- docker-entrypoint.sh node server.js
#     6 {MainThread} node server.js     ← node 不再是 PID 1

time docker stop -t 10 hello
# real    0m0.3s
docker inspect -f '{{.State.ExitCode}}' hello
# 143                  ← 128 + 15（SIGTERM），由訊號正常結束
docker rm hello
```

`--init` 會用 Docker 內建的 tini 當 PID 1，負責把訊號轉給子行程、回收殭屍行程。Compose 寫成 `init: true`。

**修法二：程式自己處理 SIGTERM（推薦，可以優雅停機）**

在 `server.js` 最後加上：

```javascript
// 收到 SIGTERM（docker stop、Kubernetes 刪除 Pod 都會送這個訊號）時：
// 不再接新連線，等目前的請求處理完再結束
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  server.close(() => process.exit(0));
});
```

```bash
docker build -t hello-docker:v2 .
docker run -d --name hello -p 3000:3000 hello-docker:v2

time docker stop -t 10 hello
# real    0m0.3s
docker inspect -f '{{.State.ExitCode}}' hello
# 0                    ← 程式自己正常結束
docker logs hello
# listening on 3000
# SIGTERM received, closing server...
docker rm hello
```

**常見陷阱：入口腳本沒有 `exec`**

很多映像會用一支 shell 腳本當 `ENTRYPOINT`，先做準備工作再啟動主程式。以下是錯誤寫法：

```sh
#!/bin/sh
# docker-entrypoint.sh（錯誤寫法）
echo "preparing..."
node server.js
```

這時 PID 1 是 `/bin/sh`，`node` 只是它的子行程。`sh` 收到 `SIGTERM` 不會轉給子行程，就算 `server.js` 有處理 `SIGTERM` 也收不到，`docker stop` 又變成等滿 10 秒、exit code 137。正確寫法是最後用 `exec` 讓主程式取代 shell，成為 PID 1：

```sh
#!/bin/sh
# docker-entrypoint.sh（正確寫法）
set -e                  # 任何一步失敗就中止，不要帶著錯誤繼續啟動
echo "preparing..."     # 例如：等待資料庫、產生設定檔
exec "$@"               # 用 CMD 傳進來的指令取代目前的 shell，成為 PID 1
```

```dockerfile
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]       # 會變成腳本的 "$@"
```

> Windows 使用者注意：腳本若以 CRLF 換行存檔，容器內會出現 `exec /usr/local/bin/docker-entrypoint.sh: no such file or directory`（其實是找不到 `/bin/sh\r`）。編輯器把換行改成 LF 即可。

**結論：**

- `CMD` / `ENTRYPOINT` 一律用 exec 格式（JSON 陣列）。shell 格式會先啟動 `/bin/sh -c`，`sh` 會不會把自己換成主程式依 shell 與指令內容而定；只要 `sh` 留在 PID 1，訊號就傳不到主程式。
- 直接執行主程式（`node server.js`），不要再包一層 `npm start`，少一個行程也少一層訊號轉送。
- 程式要處理 `SIGTERM`；做不到時至少加上 `--init`（Compose：`init: true`）。

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
# 寫在 FROM 之前的 ARG：只能用在 FROM 這一行
ARG BASE_TAG=24-alpine
FROM node:${BASE_TAG}

# FROM 之後要用同一個 ARG，必須再宣告一次（不用再給預設值，會沿用上面的值）
ARG BASE_TAG
RUN echo "base tag: ${BASE_TAG}"

# 一般的建構參數
ARG APP_VERSION=dev
RUN echo "${APP_VERSION}" > /app-version.txt

# 建構時傳入
# docker build --build-arg APP_VERSION=1.2.3 -t my-app .

# ARG vs ENV 差異
# ARG：只在建構過程中是環境變數，容器執行時看不到
# ENV：建構時和容器運行時都可用
```

> ⚠️ ARG 的值雖然在容器執行時看不到，卻會被記錄在映像的建構歷史中：`docker build --build-arg API_TOKEN=xxx` 之後，任何拿到這個映像的人用 `docker history --no-trunc <映像>` 都能看到 `API_TOKEN=xxx`。密碼、token 不要用 ARG 傳，改用 3.7 情境三的 secret mount。

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
# 官方 node 映像已內建一個非 root 使用者 node（UID 1000），可直接 USER node
# 其他映像需要自己建立使用者（以下為 alpine 的寫法；Debian/Ubuntu 用 groupadd / useradd）

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

> `COPY` 進來的檔案預設屬於 root。切換成 `appuser` 後，程式讀得到這些檔案，但**寫不進去**。程式執行時需要寫入的目錄（上傳檔、快取、日誌），要在 `USER` 之前先 `chown`，或用 `COPY --chown=appuser:appgroup`。

### HEALTHCHECK — 健康檢查

```dockerfile
# 定義健康檢查
# --interval=30s: 每 30 秒檢查一次
# --timeout=10s: 單次檢查最多等 10 秒，超時視為失敗
# --start-period=5s: 容器啟動後前 5 秒為暖機期，失敗不計入重試次數
# --retries=3: 連續失敗 3 次才標記為 unhealthy
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  # wget -qO-: 靜默下載並輸出到 stdout；連不上或 HTTP 4xx/5xx 時回傳非 0（判定失敗）
  # || exit 1: 明確回傳失敗碼，讓 Docker 判定健康檢查失敗
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

# 停用健康檢查
# 有些基底映像已內建 HEALTHCHECK，可用 NONE 關閉
HEALTHCHECK NONE
```

健康檢查指令是在**容器裡**執行的，所以用的工具必須存在於映像中：

- `node:24-alpine` 這類 alpine 映像只有 busybox 的 `wget`，**沒有 `curl`**。寫 `curl -f ...` 的話，檢查永遠失敗，容器永遠是 `unhealthy`。
- Debian 系的 `slim` 映像兩個都沒有，要自己 `apt-get install curl`，或用程式語言本身寫檢查（例如 `CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]`）。
- 網址寫 `127.0.0.1` 而不是 `localhost`：容器內的 `localhost` 可能先解析成 IPv6 的 `::1`，而 `server.js` 只綁在 IPv4 的 `0.0.0.0`，就會出現 `Connection refused`。

跟著做：把健康檢查加進 `hello-docker`。在 `Dockerfile` 的 `CMD` 前加上：

```dockerfile
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1
```

```bash
docker build -t hello-docker:v2 .
docker run -d --name hello -p 3000:3000 hello-docker:v2

# 剛啟動時 STATUS 顯示 (health: starting)，幾秒後變成 (healthy)
docker ps --filter name=hello

# 查看每次檢查的結果
docker inspect --format '{{json .State.Health}}' hello

docker rm -f hello
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

# 相依套件目錄（**/ 開頭：任何深度的同名目錄都排除）
**/node_modules
vendor
**/__pycache__
**/*.pyc

# 環境設定（避免把密碼打包進映像）
.env
.env.*
*.env
# 例外：範本檔要保留（! 開頭代表「不要排除」，必須寫在排除規則之後）
!.env.example

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
compose*.yaml
.dockerignore

# 測試報告
coverage
.nyc_output

# 文件
README.md
docs
LICENSE
```

規則的比對方式：

- 每一行都是**相對於 build context 根目錄**的路徑。`node_modules` 只排除根目錄那一個，`sub/node_modules` 不受影響；要排除所有層級，寫 `**/node_modules`。
- `!` 開頭是例外規則，後面的規則會覆蓋前面的。
- 排除 `Dockerfile` 不影響建構，Docker 仍然讀得到它；只是 `COPY . .` 不會把它複製進映像。
- 測試程式（`test/`、`tests/`）是否排除要看用途：第十章會在容器裡跑測試，那時就不能排除。

> **重要**：沒有 `.dockerignore` 時，整個目錄（包含 `node_modules`、`.git` 等）都會被送進建構上下文，大幅拖慢建構速度；主機上的 `node_modules` 還會被 `COPY . .` 蓋掉映像裡剛裝好的套件，Windows / macOS 編譯的原生模組放進 Linux 容器就會無法執行。

跟著做：為 `hello-docker` 建立 `.dockerignore`：

```bash
cat > .dockerignore <<'EOF'
**/node_modules
dist
.git
*.log
.env
EOF
```

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
FROM node:24-alpine
WORKDIR /app

# ❌ 每次程式碼變動都會使 npm install 快取失效
COPY . .
RUN npm install

CMD ["node", "server.js"]
```

### 最佳範例

```dockerfile
FROM node:24-alpine
WORKDIR /app

# ✅ 先複製 package.json，利用快取
# COPY 語法：COPY <來源...> <目的地>
# 此行有兩個來源（package.json、package-lock.json）和一個目的地（./，即目前 WORKDIR）
COPY package.json package-lock.json ./
# npm ci: 依 package-lock.json 安裝，結果可重現（適合 CI / 生產環境）
# --omit=dev: 只安裝 dependencies，不安裝 devDependencies（減少映像大小）
RUN npm ci --omit=dev

# 程式碼變動只影響這一層之後
COPY . .

CMD ["node", "server.js"]
```

### 快取怎麼判斷「沒變」

- `COPY` / `ADD`：比對**複製進來的檔案內容**（checksum），檔案內容一樣就命中快取。
- `RUN`：只比對**指令字串**本身。`RUN apt-get update` 字面沒變就命中快取，不會真的再執行一次，即使外面的套件庫早就更新了。
- 某一層失效後，它之後的所有層都要重建。

### 快取失效情境

```
COPY / ADD 的檔案內容有變動 → 該層及之後所有層快取失效
RUN 指令字串有變動 → 該層及之後所有層快取失效
FROM 的基礎映像換了 → 所有層快取失效
  （本機已有舊的 node:24-alpine 時，Docker 不會自動去拉新版；要加 --pull 才會檢查並使用最新的基礎映像）
使用 --no-cache 建構 → 所有層快取失效
```

### 跟著做：觀察快取命中

```bash
cd ~/docker-practice/hello-docker

# 什麼都沒改，再建構一次：每一步都顯示 CACHED，幾乎瞬間完成
docker build -t hello-docker:v2 .

# 只改程式碼
echo "// touch" >> server.js
docker build -t hello-docker:v2 .
# [3/5] COPY package*.json ./        CACHED  ← package.json 沒變
# [4/5] RUN npm ci --omit=dev        CACHED  ← 不用重裝套件
# [5/5] COPY . .                             ← 只有這層之後重建

# 改回來
sed -i.bak '$d' server.js && rm server.js.bak
```

### 套件管理器的快取（BuildKit cache mount）

`package.json` 一改，`npm ci` 那層就要整個重跑，所有套件重新下載。BuildKit 的 cache mount 可以讓下載快取跨建構保留，而且**不會**被打包進映像：

```dockerfile
# --mount=type=cache：把 /root/.npm（npm 的下載快取目錄）掛成建構快取
# 下次即使這一層要重跑，已下載過的套件直接從快取取用
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev
```

其他常見的快取目錄：pip 是 `/root/.cache/pip`、apt 是 `/var/cache/apt`、Go 是 `/root/.cache/go-build` 與 `/go/pkg/mod`。

---

## 3.5 Multi-stage Build（多階段建構）

Multi-stage Build 是建構小映像的關鍵技巧，允許在一個 Dockerfile 中使用多個 `FROM` 指令。

### 跟著做：把 hello-docker 改成 TypeScript

要編譯的專案才看得出 multi-stage 的價值：編譯需要 TypeScript 編譯器（devDependency），執行只需要編譯後的 JavaScript。

```bash
cd ~/docker-practice/hello-docker

# 1. 安裝 TypeScript 與 Node 的型別定義（寫進 devDependencies）
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD":/app -w /app node:24-alpine npm install -D typescript @types/node

# 2. 修改 npm scripts：build 用 tsc 編譯，start 改跑編譯結果
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD":/app -w /app node:24-alpine \
  npm pkg set scripts.build=tsc "scripts.start=node dist/server.js"

# 3. 原始碼移到 src/ 並改名為 .ts
mkdir -p src && mv server.js src/server.ts
```

把 `src/server.ts` 開頭兩行的 `require` 改成 `import`（其餘內容不用動）：

```typescript
import * as http from 'node:http';
import * as os from 'node:os';
```

建立 `tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "nodenext",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

`.dockerignore` 已經排除 `dist` 與 `node_modules`（3.3 建立的），主機上的編譯結果不會混進建構。接著把 `Dockerfile` 改成兩個階段：

```dockerfile
# ===== 階段 1：建構 =====
# builder 階段：負責編譯/打包，會包含完整建構工具與 dev 依賴
FROM node:24-alpine AS builder

WORKDIR /app
# 來源是主機 build context（docker build 最後那個 .）
COPY package*.json ./
# 這裡要裝完整依賴（含 devDependencies 的 typescript）才能編譯
RUN npm ci
# 把主機專案檔案複製進 builder 容器
COPY . .
# tsc 把 src/*.ts 編譯到 /app/dist
RUN npm run build

# ===== 階段 2：生產映像 =====
# production 階段：從乾淨基底開始，只放執行所需內容
FROM node:24-alpine AS production

WORKDIR /app
ENV NODE_ENV=production

# 只安裝生產相依套件
# 這裡同樣是從主機 build context 複製 package 檔，不是沿用 builder 檔案系統
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 從 builder 階段複製建構產物
# --from=builder 代表「從上一階段容器檔案系統」複製，不會回到主機抓檔案
# /app/dist（來源）= 第一階段 builder 內的路徑
# ./dist（目的地）= 目前這個階段（production）的 WORKDIR 內路徑（此例是 /app/dist）
COPY --from=builder /app/dist ./dist

# 建立非 root 使用者
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "dist/server.js"]
```

建構並比較兩個階段：

```bash
# 建構最終映像（預設建到最後一個階段 production）
docker build -t hello-docker:v3 .

# 只建到 builder 階段，拿來比較大小
docker build --target builder -t hello-docker:builder .

docker images hello-docker
# IMAGE                  ID             DISK USAGE   CONTENT SIZE
# hello-docker:builder   a846d2837855        305MB         82.4MB   ← 含 typescript、原始碼
# hello-docker:v3        e8dd9aa74988        242MB         62.8MB   ← 只有編譯結果與執行期依賴
# （欄位格式依 Docker 版本不同，數字依平台不同；重點是 v3 比 builder 小）

docker run -d --name hello -p 3000:3000 hello-docker:v3
curl http://localhost:3000
# {"message":"Hello from Docker","hostname":"cb7bb67be3c0","env":"production"}

docker exec hello id        # uid=100(appuser) ← 不是 root
docker exec hello ls        # dist  package-lock.json  package.json ← 沒有 src、tsconfig、typescript
docker rm -f hello
```

重點釐清：

- **是的**，第一段（`builder`）打包後的產物，會透過 `COPY --from=builder ...` 給第二段使用。
- 主機資料夾只會在 `COPY ...`（沒有 `--from`）時被使用，來源是 build context。
- 每個 `FROM` 都是新的檔案系統起點；第二段看不到第一段內容，除非你用 `COPY --from=...` 明確複製。

Docker 在這個範例的實際運行流程：

1. `docker build -t hello-docker:v3 .` 時，Docker 先把主機 build context（`.`）送進建構流程。
2. 先執行 `builder` 階段：安裝完整相依、複製程式碼、`npm run build` 產出 `/app/dist`。
3. 再執行 `production` 階段：從新基底開始，只安裝 production 相依。
4. 用 `COPY --from=builder /app/dist ./dist` 把第一階段產物帶進第二階段。
5. 建構完成後，最終 image 內容來自最後階段（`production`）；`builder` 本身不會成為最終運行映像。
6. `docker run -p 3000:3000 hello-docker:v3` 時，容器會在第二階段環境啟動，執行 `CMD ["node", "dist/server.js"]`。

> 以下 Go、前端、Django 三個範例是**其他語言的範本**，套用到你自己的專案時照著調整路徑與指令。Go 範例附了最小程式，可以直接跟著做；前端與 Django 的完整練習在第六章。

### Go 應用（極致精簡）

跟著做時先準備一個最小的 Go 服務：

```bash
mkdir -p ~/docker-practice/hello-go && cd ~/docker-practice/hello-go

cat > main.go <<'EOF'
package main

import (
	"fmt"
	"log"
	"net/http"
)

func main() {
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, "Hello from Go in a scratch image")
	})
	log.Println("listening on 8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
}
EOF

# 用 golang 容器產生 go.mod（主機不用裝 Go）
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e GOCACHE=/tmp/gocache \
  -v "$PWD":/src -w /src golang:1.27-alpine go mod init hello-go
```

```dockerfile
# ===== 階段 1：建構 =====
FROM golang:1.27-alpine AS builder

WORKDIR /app
# go.* 會同時比對 go.mod 與 go.sum；沒有外部套件的專案沒有 go.sum，寫死 go.sum 會 COPY 失敗
COPY go.* ./
RUN go mod download
COPY . .
# CGO_ENABLED=0：產生不依賴 C 函式庫的靜態執行檔，才能放進什麼都沒有的 scratch
RUN CGO_ENABLED=0 GOOS=linux go build -o /app/server .

# ===== 階段 2：最終映像 =====
FROM scratch

COPY --from=builder /app/server /server
# scratch 裡沒有 CA 憑證，程式若要呼叫 HTTPS API 必須自己帶進來
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/

# scratch 沒有 /etc/passwd，不能用使用者名稱，直接寫數字 UID:GID（65534 慣例上是 nobody）
USER 65534:65534

EXPOSE 8080
ENTRYPOINT ["/server"]
```

```bash
docker build -t hello-go .
docker images hello-go          # 約 10MB 出頭
docker run -d --name hello-go -p 8080:8080 hello-go
curl http://localhost:8080      # Hello from Go in a scratch image
docker rm -f hello-go
```

> 使用 `scratch` 空映像，最終映像只有執行檔本身的大小。代價是容器裡沒有 shell，`docker exec ... sh` 進不去，除錯方式見第八章。

### React / Vue 前端應用

```dockerfile
# ===== 階段 1：建構前端資源 =====
FROM node:24-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ===== 階段 2：Nginx 提供靜態檔案 =====
FROM nginx:1.30-alpine

# 複製自訂 Nginx 設定（內容見第六章 6.5，至少要有 SPA 的 try_files 規則，否則重新整理子頁面會 404）
COPY nginx.conf /etc/nginx/conf.d/default.conf

# 從 builder 階段複製建構產物（Vite 輸出到 dist；Create React App 是 build）
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

> 前端的環境變數（例如 Vite 的 `VITE_API_URL`）是在 `npm run build` **當下**被寫死進 JavaScript 檔案的。映像建好後再用 `docker run -e VITE_API_URL=...` 不會有任何效果。要讓同一個映像在不同環境呼叫不同 API，常見做法是前端一律呼叫相對路徑 `/api`，由 Nginx 反向代理到後端（第六章 6.5 的設定就是這樣做）。

### Python / Django 應用

```dockerfile
# ===== 階段 1：建構 =====
FROM python:3.12-slim AS builder

WORKDIR /app

# gcc 與 libpq-dev（標頭檔）只在編譯 psycopg2 這類 C 擴充套件時需要
RUN apt-get update && \
    apt-get install -y --no-install-recommends gcc libpq-dev && \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# ===== 階段 2：生產映像 =====
FROM python:3.12-slim

# 不產生 .pyc；stdout 不緩衝，docker logs 才看得到即時日誌
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# 執行期仍需要 libpq 的共用函式庫（libpq5），只是不需要編譯工具
# 少了這行，啟動時會出現 ImportError: libpq.so.5: cannot open shared object file
RUN apt-get update && \
    apt-get install -y --no-install-recommends libpq5 && \
    rm -rf /var/lib/apt/lists/*

# 只複製安裝好的套件
COPY --from=builder /install /usr/local

# 複製應用程式碼
COPY . .

# 收集靜態檔案：要寫入 STATIC_ROOT，必須在切換成非 root 之前執行（此時 /app 仍屬於 root）
# 若 settings.py 從環境變數讀 SECRET_KEY，建構時沒有這個變數會失敗，可在這一行臨時給一個值：
# RUN SECRET_KEY=build-only python manage.py collectstatic --noinput
RUN python manage.py collectstatic --noinput

# 建立非 root 使用者
RUN useradd --create-home appuser
USER appuser

EXPOSE 8000
CMD ["gunicorn", "config.wsgi:application", "--bind", "0.0.0.0:8000", "--workers", "4"]
```

---

## 3.6 映像大小最佳化

### 常見技巧

```dockerfile
# 1. 使用精簡的基礎映像（大小為約略值）
FROM node:24-alpine          # 約 160MB
FROM node:24-slim            # 約 230MB（Debian 精簡版，相容性較好）
# 而不是
FROM node:24                 # 約 1.1GB（含編譯工具等完整 Debian）

# 2. 合併 RUN 指令，並在同一個 RUN 裡清理快取（分開寫不會變小，見 3.2 RUN）
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
docker images hello-docker

# 查看每一層是哪個指令產生、多大
docker history hello-docker:v3

# 使用 dive 工具分析映像各層的檔案內容
# 安裝：brew install dive（其他平台見 https://github.com/wagoodman/dive）
dive hello-docker:v3
```

---

## 3.7 實際情境

### 情境一：建構時 npm install 每次都重跑

**問題**：只改了一行程式碼，`npm install` 又跑了好幾分鐘

```dockerfile
# ❌ 錯誤做法
FROM node:24-alpine
WORKDIR /app
# 任何檔案變動都會使這層及之後的快取失效
COPY . .
# 結果：每次都重新安裝所有套件
RUN npm install
CMD ["node", "server.js"]

# ✅ 正確做法：分離相依套件安裝與程式碼複製
FROM node:24-alpine
WORKDIR /app
# 先只複製依賴描述檔：只有 package.json / lock 變動時才會重裝
COPY package.json package-lock.json ./
RUN npm ci
# 程式碼變動只影響這層（之前的 npm ci 仍命中快取）
COPY . .
CMD ["node", "server.js"]
```

### 情境二：映像大小超過 1GB

**問題**：建構出來的映像太大，推送和部署都很慢

```bash
# 查看映像各層大小
docker history my-app:latest

# 常見原因與解決方案：
# 1. 使用了完整版映像 → 改用 alpine 或 slim
# 2. 沒有清理 apt/apk 快取，或清理寫在另一個 RUN → 在同一個 RUN 裡 rm -rf /var/lib/apt/lists/*
# 3. 把建構工具帶進最終映像 → 使用 Multi-stage Build
# 4. 複製了 node_modules/.git 等不必要檔案 → 加入 .dockerignore
```

### 情境三：Dockerfile 中的 secret 外洩

**問題**：建構時需要 API Key 或私有套件庫的 token（例如下載私有 npm 套件），不小心寫進了 Dockerfile

```dockerfile
# ❌ 非常危險！secret 會被記錄在映像的 layer 或建構歷史中
RUN echo "API_KEY=sk-xxxxx" > /app/.env
ENV API_KEY=sk-xxxxx
ARG API_KEY            # 搭配 --build-arg 傳入，一樣會留在 docker history
```

✅ 使用 BuildKit secret mount：secret 只在那一個 `RUN` 執行期間出現，不會寫進任何一層。

跟著做（在新目錄練習）：

```bash
mkdir -p ~/docker-practice/secret-demo && cd ~/docker-practice/secret-demo
printf 'sk-test-12345' > api_key.txt
```

建立 `Dockerfile`。第一行的 `# syntax=` 是 parser directive，**必須是檔案的第一行**（前面不能有註解或空行），否則會被當成一般註解：

```dockerfile
# syntax=docker/dockerfile:1
FROM alpine:3.24

# 方式一：secret 以檔案形式掛在 /run/secrets/<id>
RUN --mount=type=secret,id=api_key \
    echo "file length: $(wc -c < /run/secrets/api_key)"

# 方式二：直接變成這個 RUN 的環境變數（env=）
RUN --mount=type=secret,id=api_key,env=API_KEY \
    echo "env length: ${#API_KEY}"

# 下一個 RUN 已經看不到 secret
RUN ls /run/secrets || true
```

```bash
# --secret id=api_key,src=./api_key.txt：把主機檔案以 api_key 這個 id 提供給建構
docker build --no-cache --progress=plain --secret id=api_key,src=./api_key.txt -t secret-demo .
# file length: 13
# env length: 13
# ls: /run/secrets: No such file or directory

# 確認建構歷史裡沒有 secret 內容
docker history --no-trunc secret-demo | grep sk-test     # 沒有任何輸出
```

執行期需要的 secret（例如 API 呼叫用的 key）則在啟動容器時注入，見第九章 9.5。

### 情境四：建構在 CI 上很慢

**問題**：本地建構很快，但 CI/CD 環境每次都是全新的機器，沒有任何快取

```bash
# 解決方案：把建構快取存到 registry，下次建構時取回來

# 1. 建立一個 docker-container driver 的 builder
#    預設的 docker driver 不支援把快取匯出到 registry
docker buildx create --name ci-builder --driver docker-container --use

# 2. 建構時同時讀取與寫入 registry 上的快取
#    mode=max：所有階段（含 builder 階段）的層都寫進快取
#    （舊式的 BUILDKIT_INLINE_CACHE 只會快取最後一個階段，multi-stage 前面的 npm ci、編譯步驟都不會被快取）
docker buildx build \
  --cache-from type=registry,ref=myregistry.com/my-app:buildcache \
  --cache-to type=registry,ref=myregistry.com/my-app:buildcache,mode=max \
  -t myregistry.com/my-app:1.2.3 \
  --push \
  .
```

> 使用 GitHub Actions 時可以改用 `type=gha`，快取直接存在 GitHub 的 Actions cache，不必另外佔用 registry，見第十章 10.3。

---

## 3.8 本章小結

- Dockerfile 是自動化建構映像的核心檔案
- `CMD` / `ENTRYPOINT` 用 exec 格式，程式要處理 `SIGTERM`，入口腳本最後要 `exec "$@"`
- 指令順序影響建構快取效率——將不常變動的指令放前面
- 務必建立 `.dockerignore` 排除不必要的檔案
- Multi-stage Build 是縮小映像的關鍵技巧
- 永遠不要在 Dockerfile 中硬編碼 secret，也不要用 ARG 傳 secret
- HEALTHCHECK 用的工具必須存在於映像中（alpine 沒有 curl）
- 生產映像應使用非 root 使用者執行

---

> 上一章：[映像檔與容器基礎操作](./02-images-containers.md) | 下一章：[Docker Compose 多容器編排](./04-docker-compose.md)
