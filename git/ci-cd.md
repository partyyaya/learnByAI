# GitHub & GitLab CI/CD 自動化部署教學

> 本篇以一個 Node.js（如 Vue / React / Express）專案為例，從推上遠端倉庫開始，到設定 CI/CD Pipeline：PR 時自動安裝依賴、檢查、測試與建置，合併到 main 後再把建置好的版本部署到遠端伺服器。

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
├── public/                  ← 靜態資源（favicon 等），建置時原樣複製到 dist/
│   └── favicon.ico
├── index.html               ← Vite 的進入頁面放在專案根目錄
├── server.js                ← 後端進入點（Express 等），要提供 /health 路由
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
- 一個 Workflow 可以有多個 Job，預設平行執行；用 `needs` 指定先後順序
- CI 的建置結果要交給部署使用：部署的應該就是 CI 測過的那一份，而不是在伺服器上重新建置

### 4.2 前端專案：PR 檢查與自動部署

這個 Workflow 分成兩個 Job：

- `ci`：開 PR 和 push 到 main 都會執行，負責安裝、Lint、測試、建置，最後把 `dist/` 存成 artifact。
- `deploy`：只在 push 到 main、而且 `ci` 通過後執行，把 `ci` 建置好的 `dist/` 上傳到伺服器。

#### 建立 Workflow 檔案

```bash
mkdir -p .github/workflows
```

#### `.github/workflows/deploy.yml`

```yaml
name: CI and Deploy

# 觸發條件：開 PR、更新 PR 時，以及推送到 main 時
on:
  pull_request:
  push:
    branches: [ main ]

# GITHUB_TOKEN 只給讀取權限
permissions:
  contents: read

# 環境變數（可選）
env:
  NODE_VERSION: '24'

jobs:
  ci:
    runs-on: ubuntu-latest

    steps:
      # Step 1：拉取程式碼
      - name: Checkout code
        uses: actions/checkout@v7

      # Step 2：設定 Node.js 環境
      - name: Setup Node.js
        uses: actions/setup-node@v7
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'       # 快取 npm 的下載快取（~/.npm），不是 node_modules

      # Step 3：安裝依賴
      - name: Install dependencies
        run: npm ci
        # npm ci 比 npm install 更適合 CI 環境：
        # - 嚴格依照 package-lock.json 安裝，和 package.json 對不上時直接失敗
        # - 會先刪除 node_modules，每次都是乾淨安裝

      # Step 4：執行 Lint 檢查
      - name: Lint check
        run: npm run lint

      # Step 5：執行測試
      - name: Run tests
        run: npm run test

      # Step 6：建置專案
      - name: Build
        run: npm run build

      # Step 7：保存建置產物，交給 deploy job
      - name: Upload dist
        uses: actions/upload-artifact@v7
        with:
          name: dist
          path: dist/

  deploy:
    needs: ci                 # ci 全部通過才會執行
    # 只有 push 到 main 才部署；PR 只跑 ci
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    # 同一時間只跑一個部署，後到的排隊等待
    concurrency:
      group: production
      cancel-in-progress: false

    steps:
      - name: Download dist
        uses: actions/download-artifact@v8
        with:
          name: dist
          path: dist

      # 透過 SSH 把 dist/ 上傳到伺服器
      - name: Deploy dist via SCP
        uses: appleboy/scp-action@v1
        with:
          host: ${{ secrets.SERVER_HOST }}
          username: ${{ secrets.SERVER_USER }}
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          port: ${{ secrets.SERVER_PORT || 22 }}
          source: "dist/"
          target: "/var/www/my-app/dist"   # 和 6.6 Nginx 設定的 root 相同
          strip_components: 1              # 去掉 dist/ 這一層，index.html 直接放在 target 底下
```

靜態檔案上傳後立即生效，不需要重新載入 Nginx。

這個 Workflow 在 PR 上跑過一次後，`ci` 會出現在 Branch Protection 的 status checks 清單裡，可以設成 PR 必須通過才能合併（見 [GitHub 協作指南的「設定 Branch Protection」](./github-collaboration.md#步驟-5設定-branch-protection)）。

#### 設定 GitHub Secrets

到 GitHub 倉庫 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

需要設定的 Secrets：

| Secret 名稱 | 說明 | 範例值 |
|---|---|---|
| `SERVER_HOST` | 遠端伺服器 IP 或域名 | `203.0.113.10` |
| `SERVER_USER` | SSH 登入使用者 | `deploy` |
| `SSH_PRIVATE_KEY` | SSH 私鑰內容（完整複製） | `-----BEGIN OPENSSH PRIVATE KEY-----...` |
| `SERVER_PORT` | SSH 連接埠（選填，預設 22） | `22` |

取得私鑰的方式：

```bash
# 在你的本機產生 CI 專用的部署金鑰
# -N "" 表示不設 passphrase：CI 執行時沒辦法輸入密碼
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/deploy_key -N ""

# 複製私鑰內容，貼到 GitHub Secrets 的 SSH_PRIVATE_KEY
cat ~/.ssh/deploy_key

# 複製公鑰，加到遠端伺服器 deploy 使用者的 ~/.ssh/authorized_keys（見 6.1）
cat ~/.ssh/deploy_key.pub
```

這把金鑰是「CI 連進伺服器」用的。伺服器要從 GitHub 拉程式碼時（4.3 的後端部署），需要另一把「伺服器連 GitHub」的金鑰，設定方式見 6.7。

### 4.3 Node.js 後端專案：自動部署並啟動服務

後端不需要建置，部署方式是讓伺服器拉取 CI 測過的那個 commit，安裝 production 依賴後重新載入服務。

```yaml
name: Deploy Node.js Backend

on:
  pull_request:
  push:
    branches: [ main ]

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v7

      - name: Setup Node.js
        uses: actions/setup-node@v7
        with:
          node-version: '24'
          cache: 'npm'

      - name: Install & Test
        run: |
          npm ci
          npm run test --if-present

  deploy:
    needs: test
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    concurrency:
      group: production
      cancel-in-progress: false
    steps:
      - name: Deploy to Server
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.SERVER_HOST }}
          username: ${{ secrets.SERVER_USER }}
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          port: ${{ secrets.SERVER_PORT || 22 }}
          script: |
            # 非互動式 SSH 不會載入 nvm，要自己載入（原因見 6.2）
            export NVM_DIR="$HOME/.nvm"
            . "$NVM_DIR/nvm.sh"

            # 任何一步失敗就停止，不要帶著錯誤繼續重啟服務
            set -e

            # 進入專案目錄
            cd /var/www/my-app

            # 拉取程式碼，切到這次 CI 測過的 commit（伺服器要先設定 Deploy key，見 6.7）
            git fetch origin main
            git reset --hard ${{ github.sha }}

            # 只安裝 production 依賴
            npm ci --omit=dev

            # cluster 模式下逐一重啟 worker，服務不中斷
            pm2 reload ecosystem.config.js --env production

            # 確認服務狀態
            pm2 status
```

### 4.4 GitHub Actions 部署到 GitHub Pages（靜態網站）

使用前要先做兩件事：

1. 到 repo → **Settings** → **Pages**，把 **Source** 設成 **GitHub Actions**。沒設定的話，最後的部署步驟會失敗。
2. 網址是 `https://<user>.github.io/<repo>/` 這種 project page 時，Vite 要設定 `base`。否則建置出的 JS、CSS 會從網域根目錄 `/assets/...` 載入，全部 404：

```js
// vite.config.js
import { defineConfig } from 'vite'

export default defineConfig({
  base: '/<repo>/',
})
```

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [ main ]

permissions:
  contents: read
  pages: write
  id-token: write

# 同一時間只跑一個部署
concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}

    steps:
      - name: Checkout
        uses: actions/checkout@v7

      - name: Setup Node.js
        uses: actions/setup-node@v7
        with:
          node-version: '24'
          cache: 'npm'

      - name: Install and Build
        run: |
          npm ci
          npm run build

      - name: Setup Pages
        uses: actions/configure-pages@v6

      - name: Upload artifact
        uses: actions/upload-pages-artifact@v5
        with:
          path: './dist'

      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v5
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
image: node:24-alpine

# 定義 Pipeline 階段（依序執行；同一階段的 Job 平行執行）
stages:
  - check
  - build
  - deploy

# 全域快取：快取 npm 的下載快取（.npm/），不是 node_modules
# npm ci 每次都會先刪掉 node_modules，快取它沒有作用
cache:
  key:
    files:
      - package-lock.json    # lock 檔沒變就沿用同一份快取
  paths:
    - .npm/

# 每個 Job 開始前先安裝依賴（有快取時很快）
default:
  before_script:
    - npm ci --cache .npm --prefer-offline

# ========== 程式碼檢查 ==========
lint:
  stage: check
  script:
    - npm run lint

# ========== 執行測試 ==========
test:
  stage: check
  script:
    # 同時輸出一般結果和 JUnit 報告，GitLab 會在 MR 頁面顯示測試結果
    - npm run test -- --reporter=default --reporter=junit --outputFile.junit=test-results.xml
  artifacts:
    when: always
    reports:
      junit: test-results.xml

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
  cache: []                      # 這個 Job 不需要 npm 快取
  before_script:                 # 取代 default 的 npm ci
    # 安裝 SSH 客戶端與 rsync
    - apk add --no-cache openssh-client rsync
    # 設定 SSH 私鑰：SSH_PRIVATE_KEY 是 File 類型變數，值是暫存檔的路徑
    - mkdir -p ~/.ssh
    - chmod 700 ~/.ssh
    - cp "$SSH_PRIVATE_KEY" ~/.ssh/id_ed25519
    - chmod 600 ~/.ssh/id_ed25519
    # 加入遠端伺服器到 known_hosts（避免互動確認）
    - ssh-keyscan -H -p ${SERVER_PORT:-22} "$SERVER_HOST" >> ~/.ssh/known_hosts
  script:
    # 用 rsync 上傳 build 階段產生的 dist/；--delete 會刪掉伺服器上已經不存在的舊檔
    - rsync -az --delete -e "ssh -p ${SERVER_PORT:-22}" dist/ "$SERVER_USER@$SERVER_HOST:/var/www/my-app/dist/"
  environment:
    name: production
    url: https://my-app.example.com
  rules:
    # 只在 main 分支部署
    - if: $CI_COMMIT_BRANCH == "main"
      # 改成手動按下才部署（可選）
      # when: manual
```

#### 設定 GitLab CI/CD Variables

到 GitLab 專案 → **Settings** → **CI/CD** → **Variables** → **Add variable**

| Variable | Value | 設定 |
|---|---|---|
| `SERVER_HOST` | `203.0.113.10` | Protected |
| `SERVER_USER` | `deploy` | Protected |
| `SSH_PRIVATE_KEY` | 私鑰完整內容（最後保留一個換行） | Protected，Type 選 File |
| `SERVER_PORT` | `22` | Protected |

> **Protected variable** 只會在 protected branches（如 main）與 protected tags 的 Pipeline 中可用。
>
> **Masked** 只適用單行、字元有限制的值（例如 API token），多行的 SSH 私鑰無法設成 Masked。所以私鑰改用 **File** 類型：Job 執行時 GitLab 把內容寫進暫存檔，變數的值是那個檔案的路徑，因此上面用 `cp "$SSH_PRIVATE_KEY"`，不是 `echo`。私鑰最後要保留一個換行，否則 ssh 會回報 `error in libcrypto`。

### 5.3 Node.js 後端：自動部署並重啟服務

```yaml
image: node:24-alpine

stages:
  - test
  - deploy

cache:
  key:
    files:
      - package-lock.json
  paths:
    - .npm/

test:
  stage: test
  script:
    - npm ci --cache .npm --prefer-offline
    - npm run test --if-present

deploy:
  stage: deploy
  image: alpine:latest
  cache: []
  before_script:
    - apk add --no-cache openssh-client
    - mkdir -p ~/.ssh
    - chmod 700 ~/.ssh
    - cp "$SSH_PRIVATE_KEY" ~/.ssh/id_ed25519
    - chmod 600 ~/.ssh/id_ed25519
    - ssh-keyscan -H "$SERVER_HOST" >> ~/.ssh/known_hosts
  script:
    # 遠端指令用單引號包起來，$HOME 才會在伺服器上展開
    # 非互動式 SSH 不會載入 nvm，要自己載入（原因見 6.2）
    - ssh "$SERVER_USER@$SERVER_HOST" '
        export NVM_DIR="$HOME/.nvm" &&
        . "$NVM_DIR/nvm.sh" &&
        cd /var/www/my-app &&
        git fetch origin main &&
        git reset --hard origin/main &&
        npm ci --omit=dev &&
        pm2 reload ecosystem.config.js --env production &&
        pm2 status
      '
  environment:
    name: production
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
```

### 5.4 部署到 GitLab Pages（靜態網站）

```yaml
image: node:24-alpine

pages:
  stage: deploy
  script:
    - npm ci
    - npm run build
    # GitLab Pages 發布的是 public/ 資料夾。
    # Vite 專案本來就有 public/（放靜態資源），直接 mv dist public 會變成 public/dist/，
    # 所以先刪掉原本的 public/ 再改名（public/ 的檔案建置時已經複製進 dist/）
    - rm -rf public
    - mv dist public
  artifacts:
    paths:
      - public
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
```

網址是 `https://<user>.gitlab.io/<repo>/` 時，Vite 一樣要設定 `base: '/<repo>/'`（見 4.4）。

---

## 6. 遠端伺服器準備

### 6.1 建立部署用使用者

```bash
# 在遠端伺服器上操作
# 建立部署用使用者
sudo adduser deploy
# 不要把 deploy 加進 sudo 群組：CI 拿到的就是這個帳號的金鑰，權限越小越好

# 切換到 deploy 使用者
sudo su - deploy

# 設定 SSH 授權
mkdir -p ~/.ssh
chmod 700 ~/.ssh
nano ~/.ssh/authorized_keys
# 貼上 CI/CD 的公鑰（deploy_key.pub）
chmod 600 ~/.ssh/authorized_keys
```

CI 透過 SSH 執行指令時無法輸入密碼，一般的 `sudo` 會直接失敗：

```
sudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper
```

如果部署流程真的需要 root 權限（例如更新 Nginx 設定後要 reload），只開放那一條指令免密碼執行，不要給完整的 sudo：

```bash
# 用有 sudo 權限的管理帳號執行
echo 'deploy ALL=(root) NOPASSWD: /usr/bin/systemctl reload nginx' | sudo tee /etc/sudoers.d/deploy-nginx
sudo chmod 440 /etc/sudoers.d/deploy-nginx

# 檢查語法：sudoers 寫錯會讓 sudo 整個無法使用
sudo visudo -c
```

只更新前端靜態檔案的話不需要 reload Nginx，檔案上傳後就會生效。

### 6.2 安裝 Node.js（使用 nvm）

```bash
# 安裝 nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash
source ~/.bashrc

# 安裝 Node.js
nvm install 24
nvm use 24
nvm alias default 24

# 驗證
node -v
npm -v
```

nvm 是寫在 `~/.bashrc` 裡載入的，但 Ubuntu 的 `~/.bashrc` 開頭會判斷「不是互動式 shell 就直接結束」。CI 透過 SSH 執行指令屬於非互動式，nvm 不會被載入，會出現 `npm: command not found`、`pm2: command not found`。所以 CI 的部署指令開頭要自己載入 nvm：

```bash
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
```

另一個做法是改用系統套件（例如 NodeSource）安裝 Node.js，`node`、`npm` 會在 `/usr/bin`，任何 shell 都找得到。

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

PM2 以 deploy 使用者執行，沒有權限在 `/var/log` 底下建立資料夾，要先用管理帳號建立：

```bash
sudo mkdir -p /var/log/pm2
sudo chown deploy:deploy /var/log/pm2
```

不想另外處理的話，拿掉 `error_file`、`out_file` 兩行，PM2 會把日誌寫在 `~/.pm2/logs/`。

### 6.5 常用 PM2 指令

```bash
# 啟動應用
pm2 start ecosystem.config.js --env production

# 查看狀態
pm2 status

# 查看日誌
pm2 logs my-app

# 重啟（先停止再啟動，會短暫中斷）
pm2 restart my-app

# 重新載入（cluster 模式下逐一重啟 worker，服務不中斷）
pm2 reload my-app

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

### 6.7 讓伺服器能拉取程式碼（Deploy key）

後端部署（4.3、5.3）和 Docker 部署（7.3）都是在伺服器上 `git clone`、`git fetch`，伺服器需要有讀取 repo 的權限。做法是在伺服器產生一把金鑰，把公鑰設成 repo 的 Deploy key：

```bash
# 以 deploy 使用者在伺服器上產生金鑰
ssh-keygen -t ed25519 -C "my-app-server" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```

1. GitHub：repo → **Settings** → **Deploy keys** → **Add deploy key**，貼上公鑰。GitLab：專案 → **Settings** → **Repository** → **Deploy keys**。
2. **不要**勾選寫入權限（Allow write access），伺服器只需要讀取。

```bash
# 測試連線
ssh -T git@github.com
# 輸出：Hi your-username/my-app! You've successfully authenticated, but GitHub does not provide shell access.
```

Deploy key 只對單一 repo 有效，同一把公鑰也不能加到第二個 repo，有多個專案就各產生一把。

這裡有兩把用途不同的金鑰，不要搞混：

| 金鑰 | 方向 | 私鑰放在 | 公鑰放在 |
|---|---|---|---|
| `deploy_key`（4.2 產生） | CI → 伺服器 | GitHub Secrets／GitLab Variables | 伺服器的 `~/.ssh/authorized_keys` |
| 伺服器的 `id_ed25519` | 伺服器 → GitHub／GitLab | 伺服器的 `~/.ssh/` | repo 的 Deploy keys |

### 6.8 首次在伺服器上 Clone 專案

```bash
# 建立部署目錄（用管理帳號執行）
sudo mkdir -p /var/www/my-app
sudo chown deploy:deploy /var/www/my-app

# 以下用 deploy 使用者執行
# Clone 專案（目錄已存在但是空的，可以直接 clone 進去）
git clone git@github.com:your-username/my-app.git /var/www/my-app

# 後端只安裝 production 依賴；前端的 dist/ 由 CI 建置後上傳（見 4.2）
cd /var/www/my-app
npm ci --omit=dev
pm2 start ecosystem.config.js --env production
pm2 save
```

---

## 7. 進階：Docker 化部署

### 7.1 Dockerfile

```dockerfile
# ===== 建置階段 =====
FROM node:24-alpine AS builder

WORKDIR /app

# 先複製 package 檔案，利用 Docker 快取層加速
COPY package.json package-lock.json ./
RUN npm ci

# 複製原始碼並建置
COPY . .
RUN npm run build

# ===== 正式環境 =====
FROM node:24-alpine AS production

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 從建置階段複製產物
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server.js ./

# 建立非 root 使用者
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3000

# server.js 要提供 /health 路由；node:alpine 沒有 curl，用內建的 wget
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
```

### 7.2 docker-compose.yml

```yaml
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
    concurrency:
      group: production
      cancel-in-progress: false
    steps:
      - name: Build and deploy on server
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.SERVER_HOST }}
          username: ${{ secrets.SERVER_USER }}
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          script: |
            set -e
            cd /var/www/my-app

            # 拉取這次 push 的 commit（伺服器要先設定 Deploy key，見 6.7）
            git fetch origin main
            git reset --hard ${{ github.sha }}

            # 重新建置映像並重建容器
            # 舊容器會先停止再啟動新容器，中間服務會中斷幾秒
            docker compose up -d --build

            # 清理沒有被使用的舊映像
            docker image prune -f

            # 查看狀態
            docker compose ps
```

- deploy 使用者要能執行 docker 指令（加入 `docker` 群組）。`docker` 群組的權限等同 root，這台伺服器的 deploy 金鑰要特別保護。
- 這種做法在伺服器上建置，會佔用伺服器的 CPU 與記憶體。規模大一點時，改成 CI 建好映像推到 Registry，伺服器只負責拉取（見 7.4）。
- `docker compose up -d` 不是零停機部署。要做到更新時服務不中斷，常見做法有：
  - 藍綠部署：先啟動新版容器，健康檢查通過後讓 Nginx 改指向新容器，再停掉舊的。
  - Docker Swarm 的滾動更新：在服務設定 `deploy.update_config.order: start-first`，先啟動新容器再停舊容器。

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
    # 用 --password-stdin 傳密碼，不會出現在指令參數和程序列表裡
    - echo "$CI_REGISTRY_PASSWORD" | docker login -u "$CI_REGISTRY_USER" --password-stdin "$CI_REGISTRY"
    - docker build -t "$IMAGE_TAG" .
    - docker push "$IMAGE_TAG"
  rules:
    - if: $CI_COMMIT_BRANCH == "main"

deploy:
  stage: deploy
  image: alpine:latest
  before_script:
    - apk add --no-cache openssh-client
    - mkdir -p ~/.ssh
    - chmod 700 ~/.ssh
    - cp "$SSH_PRIVATE_KEY" ~/.ssh/id_ed25519
    - chmod 600 ~/.ssh/id_ed25519
    - ssh-keyscan -H "$SERVER_HOST" >> ~/.ssh/known_hosts
  script:
    # 密碼透過 SSH 的標準輸入，交給伺服器上的 docker login
    - echo "$CI_REGISTRY_PASSWORD" | ssh "$SERVER_USER@$SERVER_HOST" "
        docker login -u $CI_REGISTRY_USER --password-stdin $CI_REGISTRY &&
        docker pull $IMAGE_TAG &&
        (docker stop my-app || true) &&
        (docker rm my-app || true) &&
        docker run -d
          --name my-app
          --restart unless-stopped
          -p 3000:3000
          -e NODE_ENV=production
          $IMAGE_TAG &&
        docker ps
      "
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
```

`CI_REGISTRY_PASSWORD` 只在這次 Job 執行期間有效。伺服器需要在 Pipeline 之外自己拉取映像（例如手動回滾到舊版本的映像）時，改用 GitLab 的 Deploy token（權限選 `read_registry`）登入。

---

## 8. 常見問題與除錯

### Pipeline 執行失敗怎麼辦？

```bash
# GitHub：到 Actions 頁籤查看失敗的步驟 log
# GitLab：到 CI/CD → Pipelines 查看

# 常見原因：
# 1. npm ci 失敗 → 確認 package-lock.json 有被提交，且和 package.json 一致
# 2. SSH 連線失敗 → 檢查 Secrets/Variables 設定
# 3. 權限不足 → 確認伺服器上的檔案擁有者
# 4. 記憶體不足 → CI Runner 記憶體限制
# 5. npm: command not found、pm2: command not found → 非互動式 SSH 沒有載入 nvm（見 6.2）
# 6. sudo: a terminal is required to read the password → CI 無法輸入 sudo 密碼（見 6.1）
```

### npm ci vs npm install

| 比較 | `npm install` | `npm ci` |
|------|--------------|----------|
| 依據 | `package.json`（有 lock 檔時會參考，但可能改寫 lock 檔） | `package-lock.json`（和 `package.json` 對不上時直接失敗） |
| 速度 | 較慢 | 較快 |
| `node_modules` | 差異更新 | 刪除後全新安裝 |
| 適用場景 | 開發環境 | CI/CD 環境 |
| 版本一致性 | 可能不一致 | 嚴格一致 |

### SSH 連線問題排查

在 GitHub Actions 加入一個除錯用的 step。私鑰透過 `env` 傳入，不要把 `${{ secrets.* }}` 直接寫在 `run` 的指令裡：

```yaml
- name: Debug SSH
  env:
    SSH_PRIVATE_KEY: ${{ secrets.SSH_PRIVATE_KEY }}
    SERVER_USER: ${{ secrets.SERVER_USER }}
    SERVER_HOST: ${{ secrets.SERVER_HOST }}
  run: |
    printf '%s\n' "$SSH_PRIVATE_KEY" > /tmp/key
    chmod 600 /tmp/key
    # StrictHostKeyChecking=no 會略過伺服器身分檢查，只在除錯時使用，找到問題後就刪掉這個 step
    ssh -vvv -i /tmp/key -o StrictHostKeyChecking=no "$SERVER_USER@$SERVER_HOST" "echo OK"
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

先確認伺服器上的檔案真的更新了：

```bash
ls -la /var/www/my-app/dist/
```

檔案已經更新、瀏覽器卻還是舊畫面，最常見的原因是瀏覽器快取了舊的 `index.html`，它引用的還是舊的 JS、CSS 檔名。Vite 建置出的資源檔名帶有 hash（例如 `index-3f2a1b.js`），內容一改檔名就變，可以長期快取；只有 `index.html` 要每次向伺服器確認。在 6.6 的 `server` 區塊加入：

```nginx
# index.html：每次都向伺服器確認有沒有新版
location = /index.html {
    root /var/www/my-app/dist;
    add_header Cache-Control "no-cache";
}

# 帶 hash 的資源：檔名變了就是新檔案，可以快取一年
location /assets/ {
    root /var/www/my-app/dist;
    add_header Cache-Control "public, max-age=31536000, immutable";
}
```

如果有設定 Nginx 的 `proxy_cache`，也要清除：

```bash
sudo rm -rf /var/cache/nginx/*
sudo systemctl reload nginx
```

### 避免部署時服務中斷（Zero Downtime）

```bash
# PM2：cluster 模式下 reload 會逐一重啟 worker，服務不中斷
# fork 模式沒有這個效果，reload 等同 restart
pm2 reload my-app
```

Docker：`docker compose up -d` 換新映像時會先停掉舊容器，中間有幾秒中斷；加上 `--no-deps --build` 也一樣，並不是滾動更新。要做到不中斷，參考 7.3 提到的藍綠部署或 Docker Swarm 滾動更新。

---

## 完整流程圖

```
開發者 push 分支、開 PR
        │
        ▼
CI（PR 與 main 都會執行）
  npm ci → npm run lint → npm run test → npm run build
        │
        │ 全部通過，而且是 push 到 main
        ▼
CD（只有 main）
  前端：把 CI 建置好的 dist/ 上傳到伺服器
  後端：伺服器 git fetch → npm ci --omit=dev → pm2 reload
        │
        ▼
  ✅ 網站自動上版完成
```
