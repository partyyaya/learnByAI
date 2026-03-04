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
| Harbor | 開源自建 Registry | 企業內部部署 |
| Self-hosted Registry | Docker 官方 Registry 映像 | 小型團隊內部 |

---

## 7.2 Docker Hub 操作

### 登入與登出

```bash
# 登入 Docker Hub
docker login

# 使用 token 登入（推薦用於 CI/CD）
echo $DOCKER_TOKEN | docker login -u username --password-stdin

# 登出
docker logout
```

### 推送映像

```bash
# 步驟一：標記映像（需要包含 Docker Hub 使用者名稱）
# 發布固定版本標籤（建議部署使用）
docker tag my-app:latest username/my-app:v1.0
# 同步維護 latest 標籤（便於手動測試拉取）
docker tag my-app:latest username/my-app:latest

# 步驟二：推送到 Docker Hub
# 推送固定版本
docker push username/my-app:v1.0
# 推送 latest
docker push username/my-app:latest

# 推送所有標籤
docker push username/my-app --all-tags
```

### 拉取映像

```bash
# 從 Docker Hub 拉取
docker pull username/my-app:v1.0

# 從其他 Registry 拉取
# GHCR 範例
docker pull ghcr.io/owner/my-app:v1.0
# AWS ECR 範例
docker pull 123456789.dkr.ecr.ap-northeast-1.amazonaws.com/my-app:v1.0
```

---

## 7.3 GitHub Container Registry (GHCR)

```bash
# 登入 GHCR
echo $GITHUB_TOKEN | docker login ghcr.io -u USERNAME --password-stdin

# 標記映像
docker tag my-app:latest ghcr.io/username/my-app:v1.0

# 推送映像
docker push ghcr.io/username/my-app:v1.0

# 拉取映像
docker pull ghcr.io/username/my-app:v1.0
```

---

## 7.4 自建 Private Registry

### 使用 Docker 官方 Registry 映像

```yaml
# docker-compose.yml
services:
  registry:
    image: registry:2
    ports:
      - "5000:5000"
    volumes:
      - registry-data:/var/lib/registry
    environment:
      REGISTRY_STORAGE_DELETE_ENABLED: "true"
    restart: unless-stopped

volumes:
  registry-data:
```

```bash
# 啟動 Registry
docker compose up -d

# 推送映像到本地 Registry
docker tag my-app:latest localhost:5000/my-app:v1.0
docker push localhost:5000/my-app:v1.0

# 拉取映像
docker pull localhost:5000/my-app:v1.0

# 查看 Registry 中的映像
curl http://localhost:5000/v2/_catalog
# {"repositories":["my-app"]}

# 查看映像標籤
curl http://localhost:5000/v2/my-app/tags/list
# {"name":"my-app","tags":["v1.0"]}
```

### 加上 HTTPS 與認證

```yaml
# docker-compose.yml（生產級 Registry）
services:
  registry:
    image: registry:2
    ports:
      - "443:443"
    volumes:
      - registry-data:/var/lib/registry
      - ./certs:/certs:ro
      - ./auth:/auth:ro
    environment:
      REGISTRY_HTTP_ADDR: 0.0.0.0:443
      REGISTRY_HTTP_TLS_CERTIFICATE: /certs/domain.crt
      REGISTRY_HTTP_TLS_KEY: /certs/domain.key
      REGISTRY_AUTH: htpasswd
      REGISTRY_AUTH_HTPASSWD_PATH: /auth/htpasswd
      REGISTRY_AUTH_HTPASSWD_REALM: "Registry Realm"
      REGISTRY_STORAGE_DELETE_ENABLED: "true"
    restart: unless-stopped

  registry-ui:
    image: joxit/docker-registry-ui:latest
    ports:
      - "8080:80"
    environment:
      REGISTRY_TITLE: "My Docker Registry"
      REGISTRY_URL: https://registry:443
      SINGLE_REGISTRY: "true"
    depends_on:
      - registry

volumes:
  registry-data:
```

```bash
# 建立認證檔案
mkdir -p auth
docker run --rm --entrypoint htpasswd \
  httpd:2 -Bbn admin mysecretpassword > auth/htpasswd

# 登入自建 Registry
docker login myregistry.example.com
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
# 推送完整版本
docker push myregistry.com/my-app:1.2.3
# 推送次版本
docker push myregistry.com/my-app:1.2
# 推送主版本
docker push myregistry.com/my-app:1
# 推送 latest
docker push myregistry.com/my-app:latest
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
# 取目前分支名稱（例如 main / feature-x）
BRANCH=$(git rev-parse --abbrev-ref HEAD)
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

---

## 7.6 映像清理策略

### 本地清理

```bash
# 查看磁碟使用量
docker system df

# 刪除所有未使用的映像
docker image prune -a

# 刪除特定 pattern 的映像
# 篩出名稱含 my-app 的映像，取 Image ID 後批次刪除
docker images | grep "my-app" | awk '{print $3}' | xargs docker rmi

# 保留最近 N 個版本的映像
# 使用 script 搭配 docker images --format
# 流程：列出 tag -> 版本倒序排序 -> 略過最新 5 個 -> 刪除其餘舊版
docker images myregistry.com/my-app --format "{{.Tag}}" | sort -rV | tail -n +6 | xargs -I {} docker rmi myregistry.com/my-app:{}
```

### Registry 清理

```bash
# Docker Hub：在 Web 界面上刪除，或使用 API

# 自建 Registry：啟用垃圾回收
docker exec registry bin/registry garbage-collect /etc/docker/registry/config.yml

# GHCR：使用 GitHub Actions 自動清理過期映像
```

---

## 7.7 實際情境

### 情境一：推送映像到 Registry 被拒絕

**問題**：`docker push` 時出現 `denied: access forbidden`

```bash
# 排查步驟

# 1. 確認已登入
docker login myregistry.com

# 2. 確認映像標籤包含正確的 Registry 位址
docker tag my-app:latest myregistry.com/my-app:v1.0
# ❌ docker push my-app:v1.0（會嘗試推到 Docker Hub）
# ✅ docker push myregistry.com/my-app:v1.0

# 3. 確認使用者有推送權限
# Docker Hub：確認 Repository 是否存在，使用者名稱是否正確
# GHCR：確認 Token 有 write:packages 權限
```

### 情境二：映像拉取速度很慢

**問題**：CI/CD 每次拉取映像都要好幾分鐘

```bash
# 解決方案一：使用鏡像加速器
# 設定 /etc/docker/daemon.json 的 registry-mirrors

# 解決方案二：在 CI 環境中使用快取
# GitHub Actions 範例：
# - uses: docker/build-push-action@v5
#   with:
#     cache-from: type=gha
#     cache-to: type=gha,mode=max

# 解決方案三：使用較小的映像
# FROM node:20        → 1.1GB
# FROM node:20-slim   → 200MB
# FROM node:20-alpine → 130MB
```

### 情境三：Registry 磁碟空間不足

**問題**：自建的 Registry 磁碟快滿了

```bash
# 1. 查看 Registry 中的映像
curl http://localhost:5000/v2/_catalog

# 2. 刪除舊的映像標籤
# 先取得映像的 digest
# 呼叫 Registry API 取得舊 tag 的 manifest 內容，再用 jq 擷取 digest 欄位
DIGEST=$(curl -s -H "Accept: application/vnd.docker.distribution.manifest.v2+json" \
  http://localhost:5000/v2/my-app/manifests/old-tag | \
  jq -r '.config.digest')

# 刪除映像
curl -X DELETE http://localhost:5000/v2/my-app/manifests/$DIGEST

# 3. 執行垃圾回收
docker exec registry bin/registry garbage-collect /etc/docker/registry/config.yml

# 4. 設定自動清理策略
# 使用 cron job 定期清理老舊映像
```

---

## 7.8 本章小結

- Registry 是存放和分發容器映像的服務，選擇依團隊需求而定
- 生產環境永遠使用明確的版本標籤，避免 `latest`
- 語意化版本搭配 Git SHA 是最推薦的標籤策略
- 自建 Registry 務必加上 HTTPS 與認證
- 定期清理不需要的映像，避免磁碟空間被吃光

---

> 上一章：[開發環境實戰案例](./06-dev-environment.md) | 下一章：[除錯與問題排查](./08-debugging-troubleshooting.md)
