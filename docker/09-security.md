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
# ❌ 完整映像（包含編譯器、套件管理工具等大量執行時不需要的東西）
FROM node:24              # ~1.1GB
FROM python:3.12          # ~1GB

# ✅ 精簡映像
FROM alpine:3.24          # ~8MB
FROM node:24-alpine       # ~160MB
FROM python:3.12-slim     # ~125MB

# ✅✅ distroless：只有執行環境本身，沒有 shell、沒有套件管理工具
FROM gcr.io/distroless/nodejs24-debian13

# ✅✅ 最極致：空映像（適合靜態編譯的 Go / Rust）
FROM scratch              # 0MB
```

> 映像裡的東西越少，可被利用的工具（shell、curl、套件管理工具）與需要追蹤的漏洞就越少。代價是除錯不方便，可用第八章 8.3 的除錯容器彌補。

### 映像漏洞掃描

```bash
# 使用 Docker Scout（官方工具，需要 docker login）
# 列出映像已知 CVE 清單
docker scout cves hello-docker:v3
# 顯示可升級的基礎映像與修補建議
docker scout recommendations hello-docker:v3

# 使用 Trivy（開源掃描工具）
# 安裝（macOS）；其他平台見 https://trivy.dev
brew install trivy

# 掃描映像
trivy image hello-docker:v3

# 只顯示 HIGH 和 CRITICAL 級別的漏洞
trivy image --severity HIGH,CRITICAL hello-docker:v3

# 在 CI 中使用（發現嚴重漏洞時以 exit code 1 結束，讓流水線失敗）
trivy image --exit-code 1 --severity CRITICAL hello-docker:v3
```

不想安裝 Trivy 時，也可以用它的容器映像掃描。本機建構的映像先存成 tar 檔再交給它：

```bash
# 跟著做：掃描第三章建立的 hello-docker:v3
mkdir -p ~/docker-practice/scan && cd ~/docker-practice/scan
docker save hello-docker:v3 -o hello.tar
docker run --rm -v "$PWD":/work aquasec/trivy:latest \
  image --severity HIGH,CRITICAL --input /work/hello.tar
```

報告會分成兩部分：作業系統套件（例如 alpine 的 `apk` 套件）與程式語言套件（例如映像內 npm 自帶的 Node 套件）。每個漏洞都會列出目前版本與「修正版本（Fixed Version）」，有修正版本的就是更新基礎映像或依賴後可以解決的。

### 固定映像版本

```dockerfile
# ❌ 不要用 latest（每次建構可能拉到不同版本）
FROM node:latest

# ❌ 避免只用主版本
FROM node:24

# ✅ 使用完整版本號
FROM node:24.22.2-alpine3.24

# ✅✅ 使用 digest（最精確，不可變）
FROM node:24-alpine@sha256:<digest>
```

```bash
# 查詢某個標籤目前的 digest（第七章 7.5），看輸出最上方的 Digest: 那一行
docker buildx imagetools inspect node:24-alpine | head -3
# Name:      docker.io/library/node:24-alpine
# MediaType: application/vnd.oci.image.index.v1+json
# Digest:    sha256:8a32c8cf...
```

> 固定版本也代表「不會自動拿到安全修補」。實務上會搭配 Renovate 或 Dependabot 這類工具，定期自動發 PR 把 Dockerfile 的版本或 digest 更新到最新修補版，再經過 CI 測試後合併。

### 不在映像中存放 Secret

```dockerfile
# ❌ Secret 會永久記錄在映像層或建構歷史中
ENV API_KEY=sk-xxxxx
COPY .env /app/.env
RUN echo "password=secret" > /app/config.txt
ARG NPM_TOKEN            # --build-arg 傳入的值會出現在 docker history
```

```dockerfile
# syntax=docker/dockerfile:1
# ↑ 這行必須是 Dockerfile 的第一行（前面不能有註解）

FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
# ✅ 使用 BuildKit Secret Mount：.npmrc（含私有套件庫的 token）只在這個 RUN 期間出現，不會留在映像中
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc \
    npm ci
```

```bash
# 建構指令（BuildKit 已是預設建構器，不需要再設定 DOCKER_BUILDKIT=1）
docker build --secret id=npmrc,src=$HOME/.npmrc -t my-app .
```

完整的可執行練習見第三章 3.7 情境三。

執行期需要的 secret 則在啟動時注入：

```bash
# 用單一環境變數注入 secret（臨時測試常見）
docker run -e API_KEY=sk-xxxxx my-app
# 從 .env 檔案批次注入運行時環境變數
docker run --env-file .env my-app
```

> 環境變數的缺點：`docker inspect` 看得到明文、子行程會繼承、程式出錯時可能被整包印進日誌。比較敏感的值改用 9.5 的「secret 檔案」方式注入。

---

## 9.3 容器安全

### 以非 Root 使用者運行

```dockerfile
# Node.js 映像（已內建 node 使用者）
FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node . .
USER node

# Alpine 映像（手動建立使用者）
FROM alpine:3.24
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

整個容器檔案系統設為唯讀後，即使程式被入侵，攻擊者也無法改寫程式檔或植入工具。難處在於找出「程式其實需要寫入哪些目錄」：

```bash
# 跟著做：直接把 nginx 設成唯讀 → 啟動失敗
docker run -d --name ro-demo --read-only -p 8085:80 nginx:1.30-alpine
docker logs ro-demo
# [emerg] mkdir() "/var/cache/nginx/client_temp" failed (30: Read-only file system)
docker rm -f ro-demo

# 依錯誤訊息，把需要寫入的目錄掛成 tmpfs（記憶體，容器停止即清空）
# nginx 需要：/var/cache/nginx（暫存）、/run（pid 檔）、/tmp
docker run -d --name ro-demo --read-only \
  --tmpfs /var/cache/nginx \
  --tmpfs /run \
  --tmpfs /tmp:rw,noexec,nosuid,size=100m \
  -p 8085:80 nginx:1.30-alpine
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8085
# 200

# 確認網站目錄無法被竄改
docker exec ro-demo touch /usr/share/nginx/html/hacked
# touch: /usr/share/nginx/html/hacked: Read-only file system
docker rm -f ro-demo
```

`noexec`：這個目錄裡的檔案不能被執行（擋掉「下載惡意程式到 /tmp 再執行」）；`nosuid`：忽略 setuid 權限位元。

```yaml
# Docker Compose
services:
  api:
    image: my-api
    read_only: true            # 整個容器檔案系統設為唯讀，被入侵也無法竄改檔案（強化防禦）
    tmpfs:                      # 唯讀後，仍需暫時寫入的目錄改掛到記憶體（容器停止即清空）
      - /tmp:size=100m         # /tmp 限制 100MB
      - /var/run               # 例如 pid 檔、socket 等執行期暫存
    volumes:
      - api-logs:/app/logs    # 只有需要持久化的目錄可寫（用 Volume 明確開放）
```

### 限制 Capabilities

Linux 把 root 的特權拆成許多 capability（例如 `CHOWN` 改檔案擁有者、`NET_ADMIN` 改網路設定）。Docker 預設已經只給容器一小部分，`--cap-drop ALL` 再把剩下的全部拿掉：

```bash
# 以非 root 身分執行的應用程式，通常一個 capability 都不需要
docker run -d --cap-drop ALL --user 1000:1000 my-app
```

```yaml
# Docker Compose
services:
  api:
    user: "1000:1000"
    cap_drop:
      - ALL
```

跟著做：以 root 啟動、再自己降權的官方映像（nginx、postgres 等）需要補回幾個 capability：

```bash
# 全部拿掉 → nginx 啟動時要把暫存目錄 chown 給 nginx 使用者，失敗退出
docker run -d --name cap-demo --cap-drop ALL nginx:1.30-alpine
docker logs cap-demo
# [emerg] chown("/var/cache/nginx/client_temp", 101) failed (1: Operation not permitted)
docker rm -f cap-demo

# 只補回需要的：CHOWN（改擁有者）、SETUID / SETGID（切換成 nginx 使用者）、NET_BIND_SERVICE（綁 80 埠）
docker run -d --name cap-demo --cap-drop ALL \
  --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add NET_BIND_SERVICE \
  nginx:1.30-alpine
docker ps --filter name=cap-demo     # Up
docker rm -f cap-demo
```

> 非 root 使用者綁 1024 以下的埠，在 Docker 容器裡其實不需要 `NET_BIND_SERVICE`：Docker 預設把容器的 `net.ipv4.ip_unprivileged_port_start` 設為 0，任何使用者都能綁 80 埠。所以自己寫的服務以非 root 執行時，`cap_drop: [ALL]` 就夠了。

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
docker run --pid=host my-app        # 與主機共用 PID namespace，可看到主機行程
docker run --network=host my-app    # 與主機共用網路堆疊，隔離性降低

# ✅ 安全的做法
docker run \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --read-only \
  my-app
```

`no-new-privileges`：禁止容器內的行程透過 setuid 程式（例如 `sudo`、`su`）取得比啟動時更高的權限。

### 掛載 docker.sock 等於交出主機 root

很多工具（Portainer、Traefik、CI runner、監控 agent）會要求掛載 `/var/run/docker.sock`。能存取這個 socket，就能對 Docker daemon 下任何指令，包括「啟動一個掛載主機根目錄的特權容器」，等同主機的 root 權限。

```bash
# 跟著做：掛了 docker.sock 的容器，可以看到並控制主機上所有容器
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock docker:cli docker ps

# 常見的誤解：加上 :ro 就安全了
# :ro 只是讓 socket「檔案」不能被改寫，透過它送出的 API 請求完全不受影響
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock:ro docker:cli \
  docker run --rm alpine:3.24 echo "started a new container from inside"
# started a new container from inside
```

- 只掛載真的需要、而且信任的工具。
- 只需要「讀取容器資訊」的工具（例如反向代理自動發現服務），可在中間放一個只允許特定 API 的 socket proxy（例如 `tecnativa/docker-socket-proxy`）。
- 同樣的道理，加入 `docker` 群組的使用者也等同 root（第一章）。對安全要求高的主機，可以考慮 Docker 的 rootless 模式，讓 daemon 本身以一般使用者身分執行。

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

    # ✅ 不寫 ports：只有同一個 Docker 網路裡的容器連得到
    # expose 只是「文件用途」的宣告，不寫也一樣連得到、寫了也不會對外開放
    expose:
      - "5432"
```

> 決定能不能從外面連進來的是 `ports`，不是 `expose`。另外記得第二章的提醒：`ports` 沒寫 IP 時會綁在所有網路介面上，而且在 Linux 上會繞過 ufw / firewalld 的規則。真的需要開放給主機上的工具（例如備份腳本）連資料庫時，寫成 `"127.0.0.1:5432:5432"`。

### 使用 TLS 加密通訊

```yaml
services:
  nginx:
    image: nginx:1.30-alpine
    ports:
      - "443:443"                          # 對外只開 HTTPS
    volumes:
      - ./certs:/etc/nginx/certs:ro        # 掛入 TLS 憑證與私鑰（唯讀，容器不應改它）
      - ./nginx-ssl.conf:/etc/nginx/conf.d/default.conf:ro  # 掛入啟用 SSL 的站台設定（唯讀）
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
      # 注意是 POSTGRES_PASSWORD_FILE（結尾 _FILE），值是「檔案路徑」而非密碼本身
      # 很多官方映像支援這種 *_FILE 慣例：從檔案讀祕密，避免密碼出現在環境變數（docker inspect 看得到環境變數）
      POSTGRES_PASSWORD_FILE: /run/secrets/db_password
    secrets:
      - db_password            # 宣告這個服務要用 db_password，Docker 會把它掛到 /run/secrets/db_password

  api:
    build: .
    secrets:
      - db_password            # 同一個 secret 可被多個服務共用
      - api_key

# 頂層 secrets：定義祕密的「來源」
secrets:
  db_password:
    file: ./secrets/db_password.txt  # 來源是本機檔案；內容會以唯讀方式掛到容器的 /run/secrets/db_password
  api_key:
    file: ./secrets/api_key.txt
```

跟著做（只啟動 `db` 驗證；`api` 需要自己的程式，先略過）：

```bash
mkdir -p ~/docker-practice/secrets-demo && cd ~/docker-practice/secrets-demo
# 把上面的 docker-compose.yml 存到這個目錄

# 建立 secret 檔案
# 建立 secrets 目錄（若不存在）
mkdir -p secrets
# 寫入資料庫密碼示例（printf 不會在結尾多一個換行；echo 會，有些程式會把換行當成密碼的一部分）
printf 'my_secure_password' > secrets/db_password.txt
# 寫入 API Key 示範值
printf 'sk-xxxxxxxx' > secrets/api_key.txt
# 只有自己能進入這個目錄
chmod 700 secrets

# 確保 secrets 不被加入版本控制
echo "secrets/" >> .gitignore

# 啟動資料庫
docker compose up -d db

# 容器內看得到 secret 檔案
docker compose exec db ls -l /run/secrets
# -rw-r--r-- 1 root root 18 ... db_password

# docker inspect 只看得到檔案路徑，看不到密碼本身
docker inspect $(docker compose ps -q db) --format '{{range .Config.Env}}{{println .}}{{end}}' | grep PASSWORD
# POSTGRES_PASSWORD_FILE=/run/secrets/db_password

docker compose down -v
```

> 單機 Compose 的 secrets 其實是把檔案以 bind mount 唯讀掛進容器，檔案權限沿用主機上的設定，內容也沒有加密。它解決的是「密碼不出現在環境變數與 `docker inspect`」，主機上的 `secrets/` 目錄仍要自己保護好：對**目錄**設 `chmod 700`，其他使用者就進不去；檔案本身若設成 `600`，在 Linux 上容器內以非 root 執行的程式（UID 不同）會讀不到。Swarm 與 Kubernetes 的 secret 機制則會集中管理與加密儲存（第十一、十三章）。

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
# syntax=docker/dockerfile:1
# ↑ parser directive 必須是第一行，前面不能有任何註解

# ✅ 安全的 Dockerfile 範例

# 1. 使用特定版本、仍在支援期內的最小化映像
FROM node:24.22.2-alpine3.24

# 2. 設定工作目錄
WORKDIR /app

# 3. 只複製必要的檔案，只安裝正式依賴
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src/ ./src/

# 4. 不要在映像中存放 secret
# ❌ COPY .env ./
# ❌ ENV API_KEY=sk-xxxx

# 5. 建立並使用非 root 使用者
#    程式碼維持 root 擁有（appuser 只能讀、不能改自己的程式碼）；
#    只把執行時真的需要寫入的目錄交給 appuser
RUN addgroup -S appgroup && \
    adduser -S appuser -G appgroup && \
    mkdir -p /app/uploads && chown appuser:appgroup /app/uploads

USER appuser

# 6. 使用 HEALTHCHECK（alpine 沒有 curl，用 wget；網址用 127.0.0.1）
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

# 7. 暴露最少的 port
EXPOSE 3000

# 8. 使用 exec 格式的 CMD（訊號才送得到程式，見第三章 3.2）
CMD ["node", "src/server.js"]
```

### 用 hadolint 自動檢查 Dockerfile

上面的清單可以交給工具檢查。[hadolint](https://github.com/hadolint/hadolint) 會逐行比對常見的錯誤與最佳實踐，適合放進 CI：

```bash
# 跟著做：準備一個有問題的 Dockerfile
mkdir -p ~/docker-practice/lint-demo && cd ~/docker-practice/lint-demo
cat > Dockerfile <<'DOCKERFILE'
FROM node:latest
RUN apt-get update
RUN apt-get install -y curl
COPY . .
CMD npm start
DOCKERFILE

# 用容器執行 hadolint（Dockerfile 從 stdin 傳進去）
docker run --rm -i hadolint/hadolint < Dockerfile
# -:1 DL3007 warning: Using latest is prone to errors if the image will ever update...
# -:2 DL3009 info: Delete the apt lists (/var/lib/apt/lists) after installing something
# -:3 DL3059 info: Multiple consecutive `RUN` instructions. Consider consolidation.
# -:3 DL3008 warning: Pin versions in apt get install...
# -:3 DL3015 info: Avoid additional packages by specifying `--no-install-recommends`
# -:4 DL3045 warning: `COPY` to a relative destination without `WORKDIR` set.
# -:5 DL3025 warning: Use arguments JSON notation for CMD and ENTRYPOINT arguments
```

每一條規則（`DL3007` 等）在 hadolint 的 wiki 都有說明；確定某條規則不適用時，可在該行上方加 `# hadolint ignore=DL3008` 略過。

---

## 9.7 實際情境

### 情境一：映像被掃出嚴重漏洞

**問題**：CI 掃描發現映像中有 CRITICAL 漏洞

```bash
# 1. 查看漏洞詳情：重點看 Library（哪個套件）、Installed Version、Fixed Version
trivy image --severity CRITICAL my-app:latest
```

依漏洞出在哪一層處理：

```dockerfile
# a. 漏洞在基礎映像（作業系統套件或 Node 本身）→ 換成最新的修補版
FROM node:24.22.2-alpine3.24    # 改成目前最新的 24.x 修補版

# b. 基礎映像還沒釋出修補版，但作業系統套件已有修正 → 暫時在建構時升級套件
RUN apk upgrade --no-cache
```

```bash
# c. 漏洞在應用程式自己的依賴 → 在原始碼專案更新套件並提交 lock 檔
#    （不要在 Dockerfile 裡跑 npm audit fix：每次建構結果都可能不同，也沒有經過測試）
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD":/app -w /app node:24-alpine npm audit fix --package-lock-only

# 2. 重新建構時加上 --pull，確保拿到基礎映像的最新版本（而不是本機的舊快取）
docker build --pull -t my-app:latest .

# 3. 再掃描確認
trivy image --severity CRITICAL my-app:latest
```

> 不是每個漏洞都有修正版本（Fixed Version 欄位為空）。這時要評估該套件在你的映像裡是否真的會被用到，必要時換掉套件或基礎映像（例如改用 distroless），並在掃描工具裡記錄「已評估、暫時接受」的例外（Trivy 用 `.trivyignore`）。

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
# 從整段 Git 歷史刪除所有 .env 檔案記錄
bfg --delete-files .env
# 清掉 reflog，讓舊物件可被回收
git reflog expire --expire=now --all
# 進行垃圾回收，實際移除已不可達的敏感內容
git gc --prune=now --aggressive

# 3. 確保 .gitignore 有包含 .env
# 忽略本機環境變數檔
echo ".env" >> .gitignore
# 忽略 secrets 目錄
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
- 啟用唯讀檔案系統，移除不必要的 Capabilities（官方映像要補回啟動所需的幾個）
- 掛載 `docker.sock` 等同交出主機 root，`:ro` 沒有保護效果
- 用 hadolint 檢查 Dockerfile，用 Trivy / Docker Scout 掃描映像，並放進 CI

---

> 上一章：[除錯與問題排查](./08-debugging-troubleshooting.md) | 下一章：[生產環境部署與 CI/CD](./10-production-cicd.md)
