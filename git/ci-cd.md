# GitHub & GitLab CI/CD 自動化部署教學

> 本篇以一個 Node.js（如 Vue / React / Express）專案為例，從推上遠端倉庫開始，到設定 CI/CD Pipeline 自動 `npm install`、建置、並部署到遠端伺服器。

---

## 目錄

1. [前置準備](#1-前置準備)
2. [將專案推上 GitHub](#2-將專案推上-github)
3. [將專案推上 GitLab](#3-將專案推上-gitlab)
4. [GitHub Actions CI/CD](#4-github-actions-cicd)
5. [GitLab CI/CD](#5-gitlab-cicd)
6. [遠端伺服器準備](#6-遠端伺服器準備)
7. [進階：Docker 化部署](#7-進階docker-化部署)
8. [常見問題與除錯](#8-常見問題與除錯)

---

## 1. 前置準備

### 專案結構（範例）

```
my-app/
├── src/
│   └── ...
├── public/
│   └── index.html
├── package.json
├── package-lock.json
├── .gitignore
├── ecosystem.config.js      ← PM2 設定檔（後面會建立）
└── README.md
```

### 確認 package.json 有必要的 scripts

```json
{
  "name": "my-app",
  "version": "1.0.0",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "start": "node server.js",
    "preview": "vite preview",
    "lint": "eslint . --ext .js,.vue",
    "test": "vitest run"
  }
}
```

### .gitignore 基本設定

```gitignore
node_modules/
dist/
.env
.env.local
.env.production
*.log
.DS_Store
```

---

## 2. 將專案推上 GitHub

### 步驟一：在 GitHub 建立 Repository

1. 前往 [github.com/new](https://github.com/new)
2. 輸入 Repository 名稱（例如 `my-app`）
3. 選擇 Public 或 Private
4. **不要**勾選 Initialize（因為本地已有專案）
5. 點擊 Create repository

### 步驟二：本地推送

```bash
# 初始化 Git（如果還沒有）
cd my-app
git init

# 加入所有檔案並提交
git add .
git commit -m "init: 初始化專案"

# 設定遠端倉庫
git remote add origin git@github.com:your-username/my-app.git

# 推送到 GitHub
git branch -M main
git push -u origin main
```

### 步驟三：設定 SSH Key（如果尚未設定）

> **`ed25519` 是什麼？**
> 它是一種基於橢圓曲線（Curve25519）的公鑰簽章演算法。
> 相比傳統 RSA，ed25519 金鑰更短、產生更快、安全性更高（256 bit 即達到 RSA 3000 bit 同等強度），
> 且設計上具備抗側信道攻擊能力。目前 GitHub、GitLab 及主流系統皆支援，是產生 SSH Key 的首選。
> 若遇到極老舊系統（OpenSSH < 6.5）不支援，才需改用 `ssh-keygen -t rsa -b 4096`。

```bash
# 產生 SSH Key（ed25519 = 橢圓曲線演算法，目前最推薦的金鑰類型）
ssh-keygen -t ed25519 -C "your@email.com"

# 複製公鑰
cat ~/.ssh/id_ed25519.pub
# 或 macOS
pbcopy < ~/.ssh/id_ed25519.pub

# 到 GitHub → Settings → SSH and GPG keys → New SSH key
# 貼上公鑰並儲存

# 測試連線
ssh -T git@github.com
# 輸出：Hi username! You've successfully authenticated
```

---

## 3. 將專案推上 GitLab

### 步驟一：在 GitLab 建立 Project

1. 前往 [gitlab.com/projects/new](https://gitlab.com/projects/new)
2. 選擇「Create blank project」
3. 輸入專案名稱
4. 選擇 Visibility Level
5. **取消勾選**「Initialize repository with a README」
6. 點擊 Create project

### 步驟二：本地推送

```bash
cd my-app
git init
git add .
git commit -m "init: 初始化專案"

git remote add origin git@gitlab.com:your-username/my-app.git
git branch -M main
git push -u origin main
```

### 同時推送到 GitHub 和 GitLab

```bash
# 新增第二個遠端
git remote add gitlab git@gitlab.com:your-username/my-app.git
git remote add github git@github.com:your-username/my-app.git

# 推送到兩邊
git push gitlab main
git push github main

# 或設定一個 remote 同時推送兩個 URL
git remote set-url --add --push origin git@github.com:your-username/my-app.git
git remote set-url --add --push origin git@gitlab.com:your-username/my-app.git

# 之後 git push origin main 會同時推送到兩邊
```

---

## 4. GitHub Actions CI/CD

### 4.1 基本觀念

- GitHub Actions 的設定檔放在 `.github/workflows/` 目錄下
- 每個 `.yml` 檔案就是一個 Workflow
- 可由 `push`、`pull_request`、`schedule` 等事件觸發

### 4.2 前端專案：自動建置並部署到遠端伺服器

#### 建立 Workflow 檔案

```bash
mkdir -p .github/workflows
```

#### `.github/workflows/deploy.yml`

```yaml
name: Build and Deploy

# 觸發條件：推送到 main 分支時執行
on:
  push:
    branches: [ main ]

# 環境變數（可選）
env:
  NODE_VERSION: '20'

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest

    steps:
      # Step 1：拉取程式碼
      - name: Checkout code
        uses: actions/checkout@v4

      # Step 2：設定 Node.js 環境
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'       # 自動快取 node_modules，加速後續安裝

      # Step 3：安裝依賴
      - name: Install dependencies
        run: npm ci
        # npm ci 比 npm install 更適合 CI 環境：
        # - 嚴格依照 package-lock.json 安裝
        # - 會先刪除 node_modules
        # - 速度更快

      # Step 4：執行 Lint 檢查（可選）
      - name: Lint check
        run: npm run lint

      # Step 5：執行測試（可選）
      - name: Run tests
        run: npm run test

      # Step 6：建置專案
      - name: Build
        run: npm run build

      # Step 7：透過 SSH 部署到遠端伺服器
      - name: Deploy to server
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.SERVER_HOST }}
          username: ${{ secrets.SERVER_USER }}
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          port: ${{ secrets.SERVER_PORT || 22 }}
          script: |
            cd /var/www/my-app
            git pull origin main
            npm ci --production
            npm run build
            pm2 restart my-app || pm2 start ecosystem.config.js
```

#### 設定 GitHub Secrets

到 GitHub 倉庫 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

需要設定的 Secrets：

| Secret 名稱 | 說明 | 範例值 |
|---|---|---|
| `SERVER_HOST` | 遠端伺服器 IP 或域名 | `123.456.78.90` |
| `SERVER_USER` | SSH 登入使用者 | `deploy` |
| `SSH_PRIVATE_KEY` | SSH 私鑰內容（完整複製） | `-----BEGIN OPENSSH PRIVATE KEY-----...` |
| `SERVER_PORT` | SSH 連接埠（選填，預設 22） | `22` |

取得私鑰的方式：

```bash
# 在你的本機或 CI 專用機器產生部署金鑰
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/deploy_key

# 複製私鑰內容，貼到 GitHub Secrets 的 SSH_PRIVATE_KEY
cat ~/.ssh/deploy_key

# 複製公鑰，加到遠端伺服器的 authorized_keys
cat ~/.ssh/deploy_key.pub
# 貼到遠端伺服器的 ~/.ssh/authorized_keys
```

### 4.3 使用 SCP 上傳建置產物（替代方案）

如果你是前端靜態網站，不需要在伺服器上 `git pull`，可以直接上傳 `dist/`：

```yaml
      # 替代 Step 7：使用 SCP 上傳 dist 資料夾
      - name: Deploy dist via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          host: ${{ secrets.SERVER_HOST }}
          username: ${{ secrets.SERVER_USER }}
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          source: "dist/"
          target: "/var/www/my-app"
          strip_components: 1    # 去掉 dist/ 前綴

      # 部署後重啟 Nginx（如果需要）
      - name: Restart Nginx
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.SERVER_HOST }}
          username: ${{ secrets.SERVER_USER }}
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          script: sudo systemctl reload nginx
```

### 4.4 Node.js 後端專案：自動部署並啟動服務

```yaml
name: Deploy Node.js Backend

on:
  push:
    branches: [ main ]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install & Test
        run: |
          npm ci
          npm run test --if-present

      - name: Deploy to Server
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.SERVER_HOST }}
          username: ${{ secrets.SERVER_USER }}
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          script: |
            # 進入專案目錄
            cd /var/www/my-app

            # 拉取最新程式碼
            git fetch origin main
            git reset --hard origin/main

            # 安裝依賴（只裝 production 依賴）
            npm ci --production

            # 使用 PM2 重啟應用
            pm2 restart ecosystem.config.js --env production

            # 確認服務狀態
            pm2 status
```

### 4.5 GitHub Actions 部署到 GitHub Pages（靜態網站）

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [ main ]

permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install and Build
        run: |
          npm ci
          npm run build

      - name: Setup Pages
        uses: actions/configure-pages@v4

      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: './dist'

      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

---

## 5. GitLab CI/CD

### 5.1 基本觀念

- GitLab CI/CD 的設定檔是專案根目錄的 `.gitlab-ci.yml`
- 需要 **GitLab Runner** 來執行 Job（GitLab.com 提供共享 Runner）
- Pipeline 由多個 **Stage** 組成，每個 Stage 包含多個 **Job**

### 5.2 前端專案：自動建置並部署到遠端伺服器

#### `.gitlab-ci.yml`

```yaml
# 定義使用的 Docker image
image: node:20-alpine

# 定義 Pipeline 階段（依序執行）
stages:
  - install
  - lint
  - test
  - build
  - deploy

# 全域快取設定（加速 npm install）
cache:
  key:
    files:
      - package-lock.json    # 只在 lock 檔變更時重新安裝
  paths:
    - node_modules/

# ========== 安裝依賴 ==========
install_dependencies:
  stage: install
  script:
    - npm ci
  artifacts:
    paths:
      - node_modules/
    expire_in: 1 hour

# ========== 程式碼檢查 ==========
lint:
  stage: lint
  script:
    - npm run lint
  allow_failure: false

# ========== 執行測試 ==========
test:
  stage: test
  script:
    - npm run test
  artifacts:
    when: always
    reports:
      junit: test-results.xml    # 測試報告（如果有產出）

# ========== 建置 ==========
build:
  stage: build
  script:
    - npm run build
  artifacts:
    paths:
      - dist/                    # 保留建置產物供部署使用
    expire_in: 1 week

# ========== 部署到正式環境 ==========
deploy_production:
  stage: deploy
  image: alpine:latest
  before_script:
    # 安裝 SSH 客戶端
    - apk add --no-cache openssh-client rsync
    # 設定 SSH 私鑰
    - mkdir -p ~/.ssh
    - echo "$SSH_PRIVATE_KEY" > ~/.ssh/id_ed25519
    - chmod 600 ~/.ssh/id_ed25519
    # 加入遠端伺服器到 known_hosts（避免互動確認）
    - ssh-keyscan -H -p ${SERVER_PORT:-22} $SERVER_HOST >> ~/.ssh/known_hosts
  script:
    # 方法一：使用 rsync 上傳建置產物
    - rsync -avz --delete
        -e "ssh -p ${SERVER_PORT:-22}"
        dist/
        $SERVER_USER@$SERVER_HOST:/var/www/my-app/dist/

    # 方法二：SSH 到伺服器執行部署指令
    - ssh -p ${SERVER_PORT:-22} $SERVER_USER@$SERVER_HOST "
        cd /var/www/my-app &&
        git pull origin main &&
        npm ci --production &&
        npm run build &&
        pm2 restart my-app || pm2 start ecosystem.config.js
      "
  environment:
    name: production
    url: https://my-app.example.com
  # 只在 main 分支觸發部署
  only:
    - main
  # 手動觸發（可選，拿掉此行則自動部署）
  # when: manual
```

#### 設定 GitLab CI/CD Variables

到 GitLab 專案 → **Settings** → **CI/CD** → **Variables** → **Add variable**

| Variable | Value | 設定 |
|---|---|---|
| `SERVER_HOST` | `123.456.78.90` | Protected, Masked |
| `SERVER_USER` | `deploy` | Protected |
| `SSH_PRIVATE_KEY` | 私鑰完整內容 | Protected, Masked, Type: File 或 Variable |
| `SERVER_PORT` | `22` | Protected |

> **Protected variable** 只會在 protected branches（如 main）的 Pipeline 中可用。

### 5.3 Node.js 後端：自動部署並重啟服務

```yaml
image: node:20-alpine

stages:
  - test
  - deploy

cache:
  key:
    files:
      - package-lock.json
  paths:
    - node_modules/

test:
  stage: test
  script:
    - npm ci
    - npm run test --if-present

deploy:
  stage: deploy
  image: alpine:latest
  before_script:
    - apk add --no-cache openssh-client
    - mkdir -p ~/.ssh
    - echo "$SSH_PRIVATE_KEY" > ~/.ssh/id_ed25519
    - chmod 600 ~/.ssh/id_ed25519
    - ssh-keyscan -H $SERVER_HOST >> ~/.ssh/known_hosts
  script:
    - ssh $SERVER_USER@$SERVER_HOST "
        cd /var/www/my-app &&
        git fetch origin main &&
        git reset --hard origin/main &&
        npm ci --production &&
        pm2 restart ecosystem.config.js --env production &&
        pm2 status
      "
  environment:
    name: production
  only:
    - main
```

### 5.4 部署到 GitLab Pages（靜態網站）

```yaml
image: node:20-alpine

pages:
  stage: deploy
  script:
    - npm ci
    - npm run build
    # GitLab Pages 要求產出放在 public/ 資料夾
    - mv dist public
  artifacts:
    paths:
      - public
  only:
    - main
```

---

## 6. 遠端伺服器準備

### 6.1 建立部署用使用者

```bash
# 在遠端伺服器上操作
# 建立部署用使用者
sudo adduser deploy
sudo usermod -aG sudo deploy

# 切換到 deploy 使用者
sudo su - deploy

# 設定 SSH 授權
mkdir -p ~/.ssh
chmod 700 ~/.ssh
nano ~/.ssh/authorized_keys
# 貼上 CI/CD 的公鑰（deploy_key.pub）
chmod 600 ~/.ssh/authorized_keys
```

### 6.2 安裝 Node.js（使用 nvm）

```bash
# 安裝 nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc

# 安裝 Node.js
nvm install 20
nvm use 20
nvm alias default 20

# 驗證
node -v
npm -v
```

### 6.3 安裝 PM2（程序管理器）

```bash
# 全域安裝 PM2
npm install -g pm2

# 設定 PM2 開機自動啟動
pm2 startup
# 按照輸出的指示執行命令
```

### 6.4 PM2 設定檔 `ecosystem.config.js`

在專案根目錄建立此檔案：

```javascript
module.exports = {
  apps: [
    {
      name: 'my-app',
      script: 'server.js',         // 你的進入點檔案
      // 如果是 Nuxt / Next.js：
      // script: 'node_modules/.bin/nuxt',
      // args: 'start',
      cwd: '/var/www/my-app',      // 專案路徑
      instances: 'max',            // 使用所有 CPU 核心（cluster mode）
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'development',
        PORT: 3000
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000
      },
      // 日誌設定
      error_file: '/var/log/pm2/my-app-error.log',
      out_file: '/var/log/pm2/my-app-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      // 自動重啟設定
      max_memory_restart: '1G',
      restart_delay: 5000,
      max_restarts: 10,
    }
  ]
};
```

### 6.5 常用 PM2 指令

```bash
# 啟動應用
pm2 start ecosystem.config.js --env production

# 查看狀態
pm2 status

# 查看日誌
pm2 logs my-app

# 重啟
pm2 restart my-app

# 停止
pm2 stop my-app

# 刪除
pm2 delete my-app

# 監控面板
pm2 monit

# 儲存目前的程序列表（開機自動恢復）
pm2 save
```

### 6.6 設定 Nginx 反向代理

```nginx
# /etc/nginx/sites-available/my-app
server {
    listen 80;
    server_name my-app.example.com;

    # 前端靜態檔案（如果是前端專案）
    location / {
        root /var/www/my-app/dist;
        index index.html;
        try_files $uri $uri/ /index.html;   # SPA 路由支援
    }

    # API 反向代理（如果有後端）
    location /api {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
# 啟用站點設定
sudo ln -s /etc/nginx/sites-available/my-app /etc/nginx/sites-enabled/

# 測試設定是否正確
sudo nginx -t

# 重新載入 Nginx
sudo systemctl reload nginx
```

### 6.7 首次在伺服器上 Clone 專案

```bash
# 切換到部署目錄
sudo mkdir -p /var/www/my-app
sudo chown deploy:deploy /var/www/my-app

# Clone 專案
cd /var/www
git clone git@github.com:your-username/my-app.git

# 安裝依賴並啟動
cd my-app
npm ci --production
npm run build
pm2 start ecosystem.config.js --env production
pm2 save
```

---

## 7. 進階：Docker 化部署

### 7.1 Dockerfile

```dockerfile
# ===== 建置階段 =====
FROM node:20-alpine AS builder

WORKDIR /app

# 先複製 package 檔案，利用 Docker 快取層加速
COPY package.json package-lock.json ./
RUN npm ci

# 複製原始碼並建置
COPY . .
RUN npm run build

# ===== 正式環境 =====
FROM node:20-alpine AS production

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production && npm cache clean --force

# 從建置階段複製產物
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server.js ./

# 建立非 root 使用者
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
```

### 7.2 docker-compose.yml

```yaml
version: '3.8'

services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: my-app
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - PORT=3000
    volumes:
      - app-logs:/app/logs
    healthcheck:
      test: ["CMD", "wget", "--spider", "http://localhost:3000/health"]
      interval: 30s
      timeout: 5s
      retries: 3

volumes:
  app-logs:
```

### 7.3 GitHub Actions + Docker 部署

```yaml
name: Docker Build and Deploy

on:
  push:
    branches: [ main ]

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Build and push to server
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.SERVER_HOST }}
          username: ${{ secrets.SERVER_USER }}
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          script: |
            cd /var/www/my-app
            git pull origin main

            # 建置新的 Docker image
            docker compose build --no-cache

            # 重啟容器（零停機）
            docker compose up -d

            # 清理舊的 image
            docker image prune -f

            # 查看狀態
            docker compose ps
```

### 7.4 GitLab CI/CD + Docker Registry

```yaml
stages:
  - build
  - deploy

variables:
  IMAGE_TAG: $CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA

build:
  stage: build
  image: docker:24
  services:
    - docker:24-dind
  script:
    - docker login -u $CI_REGISTRY_USER -p $CI_REGISTRY_PASSWORD $CI_REGISTRY
    - docker build -t $IMAGE_TAG .
    - docker push $IMAGE_TAG

deploy:
  stage: deploy
  image: alpine:latest
  before_script:
    - apk add --no-cache openssh-client
    - mkdir -p ~/.ssh
    - echo "$SSH_PRIVATE_KEY" > ~/.ssh/id_ed25519
    - chmod 600 ~/.ssh/id_ed25519
    - ssh-keyscan -H $SERVER_HOST >> ~/.ssh/known_hosts
  script:
    - ssh $SERVER_USER@$SERVER_HOST "
        docker login -u $CI_REGISTRY_USER -p $CI_REGISTRY_PASSWORD $CI_REGISTRY &&
        docker pull $IMAGE_TAG &&
        docker stop my-app || true &&
        docker rm my-app || true &&
        docker run -d
          --name my-app
          --restart unless-stopped
          -p 3000:3000
          -e NODE_ENV=production
          $IMAGE_TAG &&
        docker ps
      "
  only:
    - main
```

---

## 8. 常見問題與除錯

### Pipeline 執行失敗怎麼辦？

```bash
# GitHub：到 Actions 頁籤查看失敗的步驟 log
# GitLab：到 CI/CD → Pipelines 查看

# 常見原因：
# 1. npm ci 失敗 → 確認 package-lock.json 有被提交
# 2. SSH 連線失敗 → 檢查 Secrets/Variables 設定
# 3. 權限不足 → 確認伺服器上的檔案擁有者
# 4. 記憶體不足 → CI Runner 記憶體限制
```

### npm ci vs npm install

| 比較 | `npm install` | `npm ci` |
|------|--------------|----------|
| 依據 | `package.json` | `package-lock.json` |
| 速度 | 較慢 | 較快 |
| `node_modules` | 差異更新 | 刪除後全新安裝 |
| 適用場景 | 開發環境 | CI/CD 環境 |
| 版本一致性 | 可能不一致 | 嚴格一致 |

### SSH 連線問題排查

```bash
# 在 CI 中加入除錯步驟
- name: Debug SSH
  run: |
    echo "${{ secrets.SSH_PRIVATE_KEY }}" > /tmp/key
    chmod 600 /tmp/key
    ssh -vvv -i /tmp/key -o StrictHostKeyChecking=no \
      ${{ secrets.SERVER_USER }}@${{ secrets.SERVER_HOST }} "echo OK"
    rm /tmp/key
```

### PM2 應用沒有正確重啟

```bash
# 在伺服器上手動檢查
pm2 list
pm2 logs my-app --lines 50

# 如果 PM2 程序混亂，重新啟動
pm2 kill
pm2 start ecosystem.config.js --env production
pm2 save
```

### 部署後網站沒更新（快取問題）

```bash
# 清除 Nginx 快取（如果有設定）
sudo rm -rf /var/cache/nginx/*
sudo systemctl reload nginx

# 確認檔案已更新
ls -la /var/www/my-app/dist/

# 前端專案：確認 vite/webpack 有產生 hash 檔名
# vite.config.js 預設就會產生 hash，通常不需額外設定
```

### 避免部署時服務中斷（Zero Downtime）

```bash
# 使用 PM2 的 graceful reload
pm2 reload my-app

# 或使用 Docker 的滾動更新
docker compose up -d --no-deps --build app
```

---

## 完整流程圖

```
開發者 push 到 main
        │
        ▼
┌─────────────────────┐
│  CI/CD Pipeline 啟動  │
│  (GitHub Actions /   │
│   GitLab CI)         │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  Step 1: npm ci      │  ← 安裝依賴
│  Step 2: npm run lint│  ← 程式碼檢查
│  Step 3: npm run test│  ← 執行測試
│  Step 4: npm run build│ ← 建置專案
└─────────┬───────────┘
          │ 全部通過
          ▼
┌─────────────────────┐
│  SSH 連線到遠端伺服器  │
│                      │
│  git pull            │
│  npm ci --production │
│  npm run build       │
│  pm2 restart         │
└─────────┬───────────┘
          │
          ▼
    ✅ 網站自動上版完成
```
