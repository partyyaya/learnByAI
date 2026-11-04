# 第七章：Registry 與映像管理

## 7.1 什麼是 Container Registry？

Container Registry 是一個儲存和分發 Docker 映像檔的服務。就像 GitHub 存放程式碼一樣，Registry 存放容器映像。

### 常見的 Registry 服務

| Registry | 說明 | 適用場景 |
|----------|------|----------|
| Docker Hub | Docker 官方 Registry | 公開映像、個人專案 |
| GitHub Container Registry (ghcr.io) | GitHub 整合 | 已使用 GitHub 的團隊 |
| AWS ECR | Amazon 的容器 Registry | AWS 生態系使用者 |
| Google Artifact Registry | GCP 的 Registry | GCP 生態系使用者 |
| Azure Container Registry | Azure 的 Registry | Azure 生態系使用者 |
| Harbor | 開源自建 Registry（含權限管理、漏洞掃描、映像複寫） | 企業內部部署 |
| Self-hosted Registry | Docker 官方 Registry 映像 | 小型團隊內部、離線環境 |

本章的「跟著做」會用到第三章建好的 `hello-docker:v3`。若沒有做第三章，可以先用 `docker tag nginx:1.30-alpine hello-docker:v3` 代替。

---

## 7.2 Docker Hub 操作

### 登入與登出

```bash
# 互動式登入 Docker Hub（會開瀏覽器或要求輸入帳密）
docker login

# 使用 token 登入（推薦用於 CI/CD）
# token 在 Docker Hub → Account settings → Personal access tokens 建立，權限選 Read & Write
echo "$DOCKER_TOKEN" | docker login -u <dockerhub_user> --password-stdin

# 登出
docker logout
```

> 登入資訊存在 `~/.docker/config.json`。macOS / Windows 的 Docker Desktop 會改存到系統的鑰匙圈（`credsStore`）；Linux 若沒有設定 credential helper，密碼只是 base64 編碼後直接寫在這個檔案裡，等同明文。共用主機上用完記得 `docker logout`。

### 推送映像

```bash
# 步驟一：標記映像（需要包含 Docker Hub 使用者名稱）
# 發布固定版本標籤（建議部署使用）
docker tag hello-docker:v3 <dockerhub_user>/hello-docker:1.0.0
# 同步維護 latest 標籤（便於手動測試拉取）
docker tag hello-docker:v3 <dockerhub_user>/hello-docker:latest

# 步驟二：推送到 Docker Hub
docker push <dockerhub_user>/hello-docker:1.0.0
docker push <dockerhub_user>/hello-docker:latest

# 一次推送這個 repository 在本機的所有標籤
docker push --all-tags <dockerhub_user>/hello-docker
```

推送後到 `https://hub.docker.com/r/<dockerhub_user>/hello-docker` 就看得到。免費帳號推送的 repository 預設是公開的。

### 拉取映像

```bash
# 從 Docker Hub 拉取
docker pull <dockerhub_user>/hello-docker:1.0.0

# 從其他 Registry 拉取：名稱開頭就是 registry 位址
# GHCR 範例
docker pull ghcr.io/owner/my-app:v1.0
# AWS ECR 範例
docker pull 123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/my-app:v1.0
```

---

## 7.3 GitHub Container Registry 與 AWS ECR

### GHCR

```bash
# 登入 GHCR（GITHUB_TOKEN 為勾選 write:packages 的 Personal access token，建立方式見第二章）
echo "$GITHUB_TOKEN" | docker login ghcr.io -u <github_user> --password-stdin

# 標記映像（名稱必須是小寫）
docker tag hello-docker:v3 ghcr.io/<github_user>/hello-docker:1.0.0

# 推送映像
docker push ghcr.io/<github_user>/hello-docker:1.0.0

# 拉取映像
docker pull ghcr.io/<github_user>/hello-docker:1.0.0
```

> GHCR 新推送的映像預設是**私有**的。要讓別人（或沒有登入的伺服器）拉得到，到 GitHub 個人頁 → Packages → 該映像 → Package settings 改成 Public，或讓對方登入後再拉。

### AWS ECR

ECR 不用固定密碼，而是用 AWS CLI 取得 12 小時有效的登入 token：

```bash
# 先建立 repository（每個映像名稱要先建好才能推送）
aws ecr create-repository --repository-name my-app --region ap-northeast-1

# 取得 token 並登入（帳號 ID 與區域換成你的）
aws ecr get-login-password --region ap-northeast-1 \
  | docker login --username AWS --password-stdin 123456789012.dkr.ecr.ap-northeast-1.amazonaws.com

docker tag hello-docker:v3 123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/my-app:1.0.0
docker push 123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/my-app:1.0.0
```

---

## 7.4 自建 Private Registry

### 跟著做：使用 Docker 官方 Registry 映像

```bash
mkdir -p ~/docker-practice/registry && cd ~/docker-practice/registry
```

```yaml
# docker-compose.yml
services:
  registry:
    image: registry:3                # 官方 Registry 映像（Distribution 3.x）
    ports:
      - "5000:5000"                  # Registry 預設監聽 5000
    volumes:
      - registry-data:/var/lib/registry  # 持久化映像資料（預設儲存路徑），否則容器刪掉映像就沒了
    environment:
      # 允許透過 API 刪除映像（預設關閉）；之後才能配合 garbage-collect 真正回收空間
      REGISTRY_STORAGE_DELETE_ENABLED: "true"
    restart: unless-stopped

volumes:
  registry-data:                     # 存放所有推送上來的映像
```

```bash
# 啟動 Registry
docker compose up -d --wait

# 推送映像到本地 Registry
docker tag hello-docker:v3 localhost:5000/my-app:v1.0
docker push localhost:5000/my-app:v1.0

# 刪掉本機的這個名字，再從 Registry 拉回來
docker rmi localhost:5000/my-app:v1.0
docker pull localhost:5000/my-app:v1.0

# 查看 Registry 中的映像
curl http://localhost:5000/v2/_catalog
# {"repositories":["my-app"]}

# 查看映像標籤
curl http://localhost:5000/v2/my-app/tags/list
# {"name":"my-app","tags":["v1.0"]}
```

> macOS 的「AirPlay 接收器」也使用 5000 埠。若 `docker compose up` 出現 `address already in use`，到系統設定 → 一般 → AirDrop 與接力 關閉「AirPlay 接收器」，或把 ports 改成 `"5001:5000"`、映像名稱改用 `localhost:5001/...`。

**從其他機器推送到這個 Registry**

Docker 預設只接受 HTTPS 的 registry，唯一的例外是 `localhost`／`127.0.0.1`。其他機器要推送到 `http://192.168.1.10:5000` 時會出現：

```
http: server gave HTTP response to HTTPS client
```

正式做法是幫 Registry 加上 HTTPS（下一段）。只在內網測試、確定要用 HTTP 時，在**推送端**的 daemon 設定加入例外（Linux：`/etc/docker/daemon.json`；Docker Desktop：Settings → Docker Engine），然後重啟 Docker：

```json
{
  "insecure-registries": ["192.168.1.10:5000"]
}
```

### 跟著做：加上 HTTPS 與認證

正式環境要用公開 CA（例如 Let's Encrypt）簽發的憑證。這裡用自簽憑證在本機練習，流程完全相同。

```bash
mkdir -p ~/docker-practice/registry-secure/certs ~/docker-practice/registry-secure/auth
cd ~/docker-practice/registry-secure

# 1. 產生自簽憑證（借用 alpine 容器裡的 openssl，主機不必安裝）
#    -nodes：私鑰不加密碼；subjectAltName：憑證適用的名稱，要包含你連線時用的主機名
docker run --rm -v "$PWD/certs":/certs alpine:3.24 sh -c '
  apk add -q --no-cache openssl &&
  openssl req -x509 -newkey rsa:4096 -sha256 -days 365 -nodes \
    -keyout /certs/domain.key -out /certs/domain.crt \
    -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,DNS:registry,IP:127.0.0.1"'

# 2. 建立認證檔
# 借用 httpd 映像內建的 htpasswd 工具來產生帳密檔（本機不必另外安裝 apache-utils）
# --rm：跑完即刪容器；--entrypoint htpasswd：把容器進入點改成 htpasswd 指令
# httpd:2：提供 htpasswd 的映像；後面是傳給 htpasswd 的參數
#   -B：用 bcrypt 加密（Registry 要求）
#   -b：從命令列直接帶入密碼（batch，不互動詢問）
#   -n：把結果輸出到 stdout（不寫檔），再由 shell 的 > 導向到 auth/htpasswd
# admin / mysecretpassword：帳號與密碼（請自行替換）
docker run --rm --entrypoint htpasswd \
  httpd:2 -Bbn admin mysecretpassword > auth/htpasswd
```

```yaml
# docker-compose.yml（加上 HTTPS 與認證的 Registry）
# 說明：Registry 的設定可全部用環境變數覆蓋，命名規則是把設定階層用底線串起來並全大寫，
#       例如設定檔的 http.tls.certificate → 環境變數 REGISTRY_HTTP_TLS_CERTIFICATE
services:
  registry:
    image: registry:3
    ports:
      - "5443:5443"                  # 練習用 5443；正式環境通常用 443
    volumes:
      - registry-data:/var/lib/registry # 持久化映像資料
      - ./certs:/certs:ro            # 掛入 TLS 憑證（唯讀）
      - ./auth:/auth:ro              # 掛入帳密檔（唯讀）
    environment:
      REGISTRY_HTTP_ADDR: 0.0.0.0:5443           # Registry 監聽位址與埠（綁 0.0.0.0 才能對外）
      REGISTRY_HTTP_TLS_CERTIFICATE: /certs/domain.crt # TLS 憑證檔路徑（容器內）
      REGISTRY_HTTP_TLS_KEY: /certs/domain.key   # TLS 私鑰檔路徑（容器內）
      REGISTRY_AUTH: htpasswd                    # 啟用 htpasswd 帳密認證
      REGISTRY_AUTH_HTPASSWD_PATH: /auth/htpasswd # 帳密檔路徑
      REGISTRY_AUTH_HTPASSWD_REALM: "Registry Realm" # 認證 realm 名稱（會顯示在登入提示）
      REGISTRY_STORAGE_DELETE_ENABLED: "true"    # 允許刪除映像（配合 garbage-collect 回收空間）
    restart: unless-stopped

  registry-ui:                       # 選用：給 Registry 加上網頁瀏覽介面
    image: joxit/docker-registry-ui:2
    ports:
      - "127.0.0.1:8080:80"          # 瀏覽器開 http://localhost:8080 瀏覽映像
    environment:
      REGISTRY_TITLE: "My Docker Registry"  # UI 標題
      # 由 UI 容器裡的 Nginx 在「容器內」轉發到 registry，所以可以用服務名稱
      # （REGISTRY_URL 則是給瀏覽器直接連的位址，瀏覽器看不懂 registry 這個服務名稱）
      NGINX_PROXY_PASS_URL: https://registry:5443
      SINGLE_REGISTRY: "true"              # 固定只連這一個 Registry（不讓使用者在 UI 切換）
    depends_on:
      - registry

volumes:
  registry-data:
```

```bash
docker compose up -d --wait

# 沒帶帳密 → 401；帶帳密 → 200（-k：略過自簽憑證檢查，只限練習）
curl -sk -o /dev/null -w '%{http_code}\n' https://localhost:5443/v2/
curl -sk -u admin:mysecretpassword -o /dev/null -w '%{http_code}\n' https://localhost:5443/v2/

# 登入自建 Registry（輸入剛建立的帳密；之後才能 push/pull）
echo mysecretpassword | docker login localhost:5443 -u admin --password-stdin
docker tag hello-docker:v3 localhost:5443/my-app:v1.0
docker push localhost:5443/my-app:v1.0

# 登出後再推送 → 被拒絕
docker logout localhost:5443
docker push localhost:5443/my-app:v1.0
# ... no basic auth credentials
```

瀏覽器開 http://localhost:8080，用 `admin` / `mysecretpassword` 登入即可瀏覽映像。

> Docker 對 `localhost` 的 registry 不檢查憑證，所以自簽憑證在本機可以直接用。從**其他機器**連這個 Registry 時，要讓那台機器信任這張憑證：把 `domain.crt` 複製到該機器的 `/etc/docker/certs.d/<registry 主機名>:<port>/ca.crt`（例如 `/etc/docker/certs.d/registry.example.com:5443/ca.crt`），不需要重啟 Docker。

```bash
# 練習結束
docker compose down -v
```

---

## 7.5 映像標籤策略

### 語意化版本（推薦）

```bash
# 格式：MAJOR.MINOR.PATCH
# 最完整版本（最推薦）
docker tag my-app:latest myregistry.com/my-app:1.2.3
# 同步次版本，方便追小版本更新
docker tag my-app:latest myregistry.com/my-app:1.2
# 同步主版本，方便追大版本線
docker tag my-app:latest myregistry.com/my-app:1
# 視團隊規範決定是否保留 latest
docker tag my-app:latest myregistry.com/my-app:latest

# 推送所有標籤
docker push --all-tags myregistry.com/my-app
```

### 基於 Git 的標籤

```bash
# 使用 Git commit hash
# 取目前 commit 的短 SHA（例如 abc1234）
GIT_SHA=$(git rev-parse --short HEAD)
docker tag my-app:latest myregistry.com/my-app:${GIT_SHA}

# 使用 Git tag
# 取最近的 tag（若無 tag 則回傳 SHA）
GIT_TAG=$(git describe --tags --always)
docker tag my-app:latest myregistry.com/my-app:${GIT_TAG}

# 使用 branch 名稱
# 取目前分支名稱（例如 main / feature-x）；分支名稱裡的 / 不能出現在標籤中，先換成 -
BRANCH=$(git rev-parse --abbrev-ref HEAD | tr '/' '-')
docker tag my-app:latest myregistry.com/my-app:${BRANCH}
```

### 標籤最佳實踐

```
✅ 推薦：
  myapp:1.2.3          # 語意化版本
  myapp:1.2.3-abc1234  # 版本 + Git SHA
  myapp:main-abc1234   # Branch + Git SHA

❌ 避免：
  myapp:latest         # 不知道是哪個版本（生產環境禁用）
  myapp:new            # 含義模糊
  myapp:test           # 不知道測試什麼
```

### 標籤可以被覆蓋，digest 不會

標籤只是一個「指向某份映像的名字」，同一個標籤可以被重新推送、指到不同的內容。每份映像內容另有一個由內容計算出的 **digest**（`sha256:...`），內容一樣 digest 就一樣、內容一改 digest 就變。

```bash
# 查看映像的 digest
docker buildx imagetools inspect nginx:1.30-alpine
# Name:      docker.io/library/nginx:1.30-alpine
# MediaType: application/vnd.oci.image.index.v1+json
# Digest:    sha256:...

# 用 digest 拉取：保證拿到的永遠是同一份內容
docker pull nginx:1.30-alpine@sha256:<上面看到的 digest>
```

- 部署時用 digest（或至少用不會重複使用的標籤，例如 `1.2.3-abc1234`），回滾時才能確定拿回的就是當初那一份。
- AWS ECR、Harbor 等 Registry 可以開啟「標籤不可覆蓋（tag immutability）」，從源頭避免同一個標籤被推送兩次。

---

## 7.6 多平台映像與離線搬運

### 多平台映像：避免 `exec format error`

在 Apple Silicon（arm64）上建構的映像，直接拿到一般雲端主機（amd64）上執行，會出現：

```
exec /usr/local/bin/docker-entrypoint.sh: exec format error
```

因為映像裡的執行檔是 arm64 的機器碼。解法是建構時指定平台，或一次建構多個平台、推送成同一個標籤（第二章 2.1 提到的「同一個標籤底下存了多個平台」）：

```bash
# 跟著做：沿用 7.4 的本地 Registry（localhost:5000）
mkdir -p ~/docker-practice/multi-demo && cd ~/docker-practice/multi-demo
cat > Dockerfile <<'EOF'
FROM alpine:3.24
# TARGETPLATFORM 是 BuildKit 自動提供的建構參數，值為目前正在建構的平台
ARG TARGETPLATFORM
RUN echo "built for $TARGETPLATFORM" > /platform.txt
CMD ["cat", "/platform.txt"]
EOF

# 同時建構 amd64 與 arm64，直接推送到 Registry（多平台映像需要 --push，或改用支援多平台的映像儲存）
docker buildx build --platform linux/amd64,linux/arm64 \
  -t localhost:5000/multi-demo:1.0 --push .

# 檢查：同一個標籤底下有兩個平台
docker buildx imagetools inspect localhost:5000/multi-demo:1.0
# MediaType: application/vnd.oci.image.index.v1+json
#   Platform:    linux/amd64
#   Platform:    linux/arm64
#   Platform:    unknown/unknown   ← 這兩筆是 BuildKit 自動附上的建構紀錄（provenance attestation），不是映像
#   Platform:    unknown/unknown

# 指定平台執行（非本機平台會透過模擬執行，比較慢）
docker run --rm --platform linux/amd64 localhost:5000/multi-demo:1.0   # built for linux/amd64
docker run --rm localhost:5000/multi-demo:1.0                          # 依本機平台自動挑選
```

> 若出現 `Multi-platform build is not supported for the docker driver`（Linux 上未啟用 containerd 映像儲存時常見），先建立一個 docker-container driver 的 builder 再重新執行：`docker buildx create --name multi --driver docker-container --driver-opt network=host --use`。`network=host` 讓這個 builder 容器連得到主機上的 `localhost:5000`。CI 上只需要部署平台的映像時，用 `--platform linux/amd64` 建單一平台即可，速度較快。

### 離線搬運：docker save / docker load

目標機器連不到任何 Registry（隔離網段、客戶現場）時，把映像存成檔案帶過去：

```bash
# 存成 tar 檔（可一次存多個映像）
docker save -o hello-docker.tar hello-docker:v3

# 想要小一點可以壓縮
docker save hello-docker:v3 | gzip > hello-docker.tar.gz

# 在目標機器載入
docker load -i hello-docker.tar
# 或
gunzip -c hello-docker.tar.gz | docker load
```

> `docker save` / `docker load` 保留映像的層、標籤與設定；另一組 `docker export` / `docker import` 處理的是「容器的檔案系統」，會丟掉層與 `CMD`、`ENV` 等設定，不適合用來搬映像。

---

## 7.7 映像清理策略

### 本地清理

```bash
# 查看磁碟使用量
docker system df

# 刪除所有沒有容器在使用的映像
docker image prune -a

# 刪除特定名稱的所有映像
# --filter reference=...：依名稱比對；-q：只輸出 ID
docker rmi $(docker images --filter reference='myregistry.com/my-app' -q)

# 保留最近 N 個版本的映像
# 流程：列出 tag -> 排除 <none> 與 latest -> 版本倒序排序 -> 略過最新 5 個 -> 刪除其餘舊版
docker images myregistry.com/my-app --format "{{.Tag}}" \
  | grep -v -E '^(<none>|latest)$' \
  | sort -rV \
  | tail -n +6 \
  | xargs -I {} docker rmi myregistry.com/my-app:{}
```

### Registry 清理

```bash
# Docker Hub / GHCR：在網頁介面刪除，或用它們的 API
#   GHCR 可在 GitHub Actions 用 actions/delete-package-versions 定期清理舊版本

# 自建 Registry：刪除 manifest 只是讓標籤消失，空間要等垃圾回收才會釋放
# registry:3 的設定檔在 /etc/distribution/config.yml（registry:2 是 /etc/docker/registry/config.yml）
docker compose exec registry registry garbage-collect /etc/distribution/config.yml --delete-untagged
```

---

## 7.8 實際情境

### 情境一：推送映像到 Registry 被拒絕

**問題**：`docker push` 時出現 `denied: access forbidden` 或 `requested access to the resource is denied`

```bash
# 排查步驟

# 1. 確認已登入「正確的 registry」（docker login 後面要接 registry 位址，沒寫就是 Docker Hub）
docker login myregistry.com

# 2. 確認映像標籤包含正確的 Registry 位址
docker tag my-app:latest myregistry.com/my-app:v1.0
# ❌ docker push my-app:v1.0（會嘗試推到 Docker Hub 的 library/my-app）
# ✅ docker push myregistry.com/my-app:v1.0

# 3. 確認使用者有推送權限
# Docker Hub：確認 namespace 是自己的帳號或有權限的組織，token 權限有 Write
# GHCR：確認 Token 有 write:packages 權限
# ECR：確認 repository 已建立、登入 token 未過期（12 小時）
```

### 情境二：映像拉取速度很慢

**問題**：CI/CD 每次拉取映像都要好幾分鐘

```bash
# 解決方案一：使用鏡像加速器
# 設定 /etc/docker/daemon.json 的 registry-mirrors（見第一章情境三）

# 解決方案二：在 CI 環境中使用建構快取
# GitHub Actions 範例：
# - uses: docker/build-push-action@v6
#   with:
#     cache-from: type=gha
#     cache-to: type=gha,mode=max

# 解決方案三：使用較小的映像（大小為約略值）
# FROM node:24        → 約 1.1GB
# FROM node:24-slim   → 約 230MB
# FROM node:24-alpine → 約 160MB
```

> 公司內有很多機器都從 Docker Hub 拉映像時，可以把自建 Registry 設成「pull-through cache」：在 registry 服務加上環境變數 `REGISTRY_PROXY_REMOTEURL: https://registry-1.docker.io`，再把各機器的 `registry-mirrors` 指向它。第一次拉取時由它向 Docker Hub 下載並快取，之後內網直接取用，也比較不會撞到 Docker Hub 的拉取次數限制。

### 情境三：Registry 磁碟空間不足

**問題**：自建的 Registry 磁碟快滿了

跟著做（沿用 7.4 的 `localhost:5000` Registry）：

```bash
cd ~/docker-practice/registry

# 0. 先推一個要被刪的舊標籤
docker tag alpine:3.24 localhost:5000/my-app:old-tag
docker push localhost:5000/my-app:old-tag

# 1. 查看 Registry 中的映像
curl http://localhost:5000/v2/my-app/tags/list
# {"name":"my-app","tags":["old-tag","v1.0"]}

# 2. 取得舊標籤的 manifest digest
#    要用 HEAD 請求（-I），digest 在回應標頭 Docker-Content-Digest 裡
#    Accept 標頭要列出各種 manifest 格式，否則 Registry 可能回傳轉換過的格式，digest 會對不上
DIGEST=$(curl -sI \
  -H "Accept: application/vnd.oci.image.index.v1+json" \
  -H "Accept: application/vnd.oci.image.manifest.v1+json" \
  -H "Accept: application/vnd.docker.distribution.manifest.list.v2+json" \
  -H "Accept: application/vnd.docker.distribution.manifest.v2+json" \
  http://localhost:5000/v2/my-app/manifests/old-tag \
  | awk 'tolower($1) == "docker-content-digest:" { print $2 }' | tr -d '\r')
echo "$DIGEST"
# sha256:e311ae74...

# 3. 用 digest 刪除 manifest（回應 202 代表成功）
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE http://localhost:5000/v2/my-app/manifests/$DIGEST
# 202

curl http://localhost:5000/v2/my-app/tags/list
# {"name":"my-app","tags":["v1.0"]}

# 4. 執行垃圾回收，真正刪除沒有被任何 manifest 引用的檔案層
docker compose exec registry registry garbage-collect /etc/distribution/config.yml --delete-untagged

# 練習結束
docker compose down -v
```

> 常見錯誤：把 manifest **內容**裡的 `config.digest` 拿來刪除。那是映像設定檔（config blob）的 digest，不是 manifest 的 digest，DELETE 會失敗。

> 垃圾回收期間若同時有人推送映像，可能刪到正在上傳的檔案層。正式環境要在離峰時段執行，或先在 Registry 設定檔把 `storage.maintenance.readonly.enabled` 設為 `true`（暫停接受推送）再回收。可以用 cron 定期執行上面的刪除與回收（例如只保留每個映像最近 10 個標籤）。

---

## 7.9 本章小結

- Registry 是存放和分發容器映像的服務，選擇依團隊需求而定
- 生產環境永遠使用明確的版本標籤，避免 `latest`；需要絕對不變時用 digest
- 語意化版本搭配 Git SHA 是最推薦的標籤策略
- 自建 Registry 務必加上 HTTPS 與認證；其他機器用 HTTP 連線時要設定 `insecure-registries`
- 開發機與伺服器的 CPU 架構不同時，用 `docker buildx build --platform` 建構對應平台
- 離線環境用 `docker save` / `docker load` 搬運映像
- 定期清理不需要的映像；自建 Registry 刪除後要執行 garbage-collect 才會釋放空間

---

> 上一章：[開發環境實戰案例](./06-dev-environment.md) | 下一章：[除錯與問題排查](./08-debugging-troubleshooting.md)
