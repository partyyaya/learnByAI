# 第一章：Docker 簡介與安裝

## 1.1 什麼是 Docker？

Docker 是一個開源的容器化平台，讓開發者可以將應用程式及其所有相依套件打包成一個輕量級、可攜帶的「容器（Container）」。容器可以在任何支援 Docker 的環境中一致地運行，徹底解決了「在我的電腦上可以跑」的經典問題。

### Docker 的核心特點

| 特點 | 說明 |
|------|------|
| 環境一致性 | 開發、測試、生產環境完全一致，消除環境差異問題 |
| 輕量級 | 容器共享主機核心，啟動只需秒級，遠比虛擬機快 |
| 可攜帶性 | 一次建構，到處運行（Build once, run anywhere） |
| 隔離性 | 每個容器互相隔離，不會互相影響 |
| 版本控制 | 映像檔可以版本化管理，輕鬆回滾 |
| 生態豐富 | Docker Hub 上有數十萬個現成映像可直接使用 |

### Docker vs 虛擬機（VM）

```
              Docker 容器                      虛擬機 (VM)
啟動速度      秒級                              分鐘級
資源佔用      低（共享主機核心）                高（需要完整 Guest OS）
映像大小      MB 等級                           GB 等級
效能         接近原生                           有虛擬化開銷
隔離程度      行程級隔離                        完整 OS 隔離
可攜帶性      極高                              受限於虛擬化平台
```

### 架構圖解

```
┌─────────────────────────────────────────┐
│              Docker 容器架構              │
├──────────┬──────────┬──────────┬────────┤
│ Container│ Container│ Container│  ...   │
│  (App A) │  (App B) │  (App C) │        │
├──────────┴──────────┴──────────┴────────┤
│              Docker Engine               │
├─────────────────────────────────────────┤
│            Host OS（Linux Kernel）        │
├─────────────────────────────────────────┤
│               硬體 (Hardware)            │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│              虛擬機架構                   │
├──────────┬──────────┬──────────┬────────┤
│   App A  │   App B  │   App C  │  ...   │
├──────────┼──────────┼──────────┼────────┤
│ Guest OS │ Guest OS │ Guest OS │  ...   │
├──────────┴──────────┴──────────┴────────┤
│            Hypervisor (VMware/VBox)     │
├─────────────────────────────────────────┤
│              Host OS                    │
├─────────────────────────────────────────┤
│               硬體 (Hardware)            │
└─────────────────────────────────────────┘
```

---

## 1.2 Docker 核心概念

在開始之前，先理解三個最重要的概念：

### 映像檔（Image）

映像檔是一個唯讀的模板，包含了運行應用程式所需的一切：程式碼、執行環境、函式庫、環境變數和設定檔。

```
映像檔 ≈ 類別（Class）
容器   ≈ 實例（Instance）
```

### 容器（Container）

容器是映像檔的運行實例。你可以從一個映像檔建立多個容器，每個容器都是獨立運行的。

### 倉庫（Registry）

倉庫是存放映像檔的地方，最常用的是 [Docker Hub](https://hub.docker.com/)。你可以從 Registry 拉取（pull）映像檔，也可以推送（push）自己建構的映像檔。

```
┌─────────┐    docker pull    ┌──────────┐    docker run    ┌───────────┐
│ Registry │ ───────────────→ │  Image   │ ──────────────→ │ Container │
│(Docker Hub)│               │ (映像檔) │                  │  (容器)   │
└─────────┘    docker push   └──────────┘    docker stop   └───────────┘
               ←───────────── │           │ ←──────────────
                              │ Dockerfile│
                              │ docker build
                              └──────────┘
```

---

## 1.3 安裝 Docker

### macOS

推薦使用 Docker Desktop：

```bash
# 方法一：官方下載
# 前往 https://www.docker.com/products/docker-desktop 下載安裝

# 方法二：使用 Homebrew
brew install --cask docker

# 安裝完成後，啟動 Docker Desktop 應用程式
# 驗證安裝
docker --version
docker compose version
```

### Ubuntu / Debian

```bash
# 移除舊版本（避免與官方套件衝突）
# 逐一移除：若把套件名稱寫在同一行，只要其中一個找不到，apt 就整行放棄，其他已安裝的也不會被移除
# 首次安裝會看到幾行「Unable to locate package」或「not installed」，屬正常
for pkg in docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc; do
  sudo apt remove -y $pkg
done

# 安裝必要套件
sudo apt update
# ca-certificates：HTTPS 憑證；curl：下載 GPG key；gnupg：處理金鑰；lsb-release：取得系統版本資訊
sudo apt install ca-certificates curl gnupg lsb-release -y

# 新增 Docker 官方 GPG key（用來驗證之後下載的套件「確實來自 Docker 官方、未被竄改」）
# install -m 0755 -d：建立存放金鑰的目錄並設定權限（-d 建目錄、-m 0755 設權限）
sudo install -m 0755 -d /etc/apt/keyrings
# curl 下載官方金鑰 → gpg --dearmor 轉成 apt 能讀的二進位格式 → 存到 keyrings 目錄
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
# 讓所有使用者可讀此金鑰（a+r），否則 apt update 可能因權限讀不到而報錯
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# 新增 Docker 套件庫（告訴 apt「去哪裡、用哪把金鑰、抓哪個版本」的套件）
# 這段是把一行 deb 來源寫進 /etc/apt/sources.list.d/docker.list：
#   arch=$(dpkg --print-architecture)：自動帶入本機 CPU 架構（如 amd64/arm64）
#   signed-by=...docker.gpg：指定用上面那把金鑰驗證此來源
#   $(. /etc/os-release && echo "$VERSION_CODENAME")：自動帶入 Ubuntu 版本代號（如 jammy/noble）
#   tee ... > /dev/null：把內容寫進檔案（需 sudo 權限），> /dev/null 是不要在畫面重複印出
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# 安裝 Docker Engine
sudo apt update    # 重新讀取套件清單（含剛加入的 Docker 來源）
# docker-ce：Docker 引擎；docker-ce-cli：docker 指令；containerd.io：底層容器執行階段
# docker-buildx-plugin：進階建構；docker-compose-plugin：提供 docker compose 指令
sudo apt install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin -y

# 讓當前使用者不需要 sudo 即可執行 docker（把使用者加進 docker 群組）
sudo usermod -aG docker $USER
newgrp docker      # 讓群組變更立即在目前 shell 生效（否則需重新登入）

# 驗證安裝
docker --version
docker compose version
```

> ⚠️ 加入 `docker` 群組的使用者，等同擁有這台主機的 root 權限：能執行 docker 指令，就能啟動一個掛載主機根目錄的容器（`docker run -v /:/host ...`）去改任何檔案。只把信任的帳號加進這個群組；共用伺服器上若不能接受，可改用 Docker 的 rootless 模式。

### CentOS Stream / RHEL / Rocky Linux（8、9 版）

```bash
# 移除舊版本（沒裝過時會顯示「No match」，屬正常）
sudo dnf remove -y docker docker-client docker-client-latest docker-common \
  docker-latest docker-latest-logrotate docker-logrotate docker-engine podman runc

# 安裝 dnf 的 config-manager 外掛（用來新增套件庫）
sudo dnf install -y dnf-plugins-core

# 新增 Docker 套件庫
sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo

# 安裝 Docker Engine
sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# 啟動並設定開機自啟（--now：enable 的同時立刻 start）
sudo systemctl enable --now docker

# 讓當前使用者不需要 sudo（重新登入後生效；安全性注意事項同上）
sudo usermod -aG docker $USER
```

### Windows（WSL2）

```bash
# 1. 先確保已啟用 WSL2
wsl --install

# 2. 下載並安裝 Docker Desktop for Windows
# 前往 https://www.docker.com/products/docker-desktop

# 3. 在 Docker Desktop 設定中啟用 WSL2 整合
# Settings → General → Use the WSL 2 based engine ✓
# Settings → Resources → WSL Integration → 勾選你使用的發行版（例如 Ubuntu）

# 4. 在 WSL2 終端中驗證
docker --version
```

> 建議把練習專案放在 WSL2 的檔案系統裡（例如 `~/docker-practice`），不要放在 `/mnt/c/...`。放在 Windows 磁碟上時，掛載進容器的檔案讀寫很慢，存檔後容器內也常收不到檔案變動通知（第六章的 hot reload 會失效）。

---

## 1.4 安裝後驗證

```bash
# 查看 Docker 版本資訊
docker --version
# Docker version 29.x.x, build xxxxxxx

# 查看詳細版本資訊（輸出分成 Client 與 Server 兩段）
docker version

# 查看 Docker 系統資訊
docker info

# 執行 Hello World 容器測試
docker run hello-world
```

預期輸出：

```
Hello from Docker!
This message shows that your installation appears to be working correctly.

To generate this message, Docker took the following steps:
 1. The Docker client contacted the Docker daemon.
 2. The Docker daemon pulled the "hello-world" image from the Docker Hub.
 3. The Docker daemon created a new container from that image...
 ...
```

### `docker` 指令其實是在跟誰說話？

`docker version` 分成 Client 與 Server 兩段，因為 Docker 是「用戶端 + 常駐服務」的架構：

```
docker CLI（Client）
   │  透過 /var/run/docker.sock 呼叫 REST API
   ▼
dockerd（Docker daemon，Server）── 管理映像、網路、volume、建構
   │
   ▼
containerd ── 管理容器生命週期
   │
   ▼
runc ── 實際呼叫 Linux 核心的 namespace / cgroup 把行程隔離起來
```

- 你打的每個 `docker ...` 都只是送 API 請求給 dockerd，真正建立容器的是 daemon。所以 daemon 沒啟動時，所有指令都會出現 `Cannot connect to the Docker daemon`。
- 容器本質上是「被 namespace 隔離、被 cgroup 限制資源的 Linux 行程」，所以需要 Linux 核心。
- macOS / Windows 沒有 Linux 核心，Docker Desktop 其實在背景跑了一台輕量 Linux VM，dockerd 與所有容器都在這台 VM 裡。之後遇到「掛載目錄比較慢」「`--network host` 用不了」「Docker 吃掉固定的記憶體」，原因都是這台 VM。

### 建立練習目錄

之後各章「跟著做」的檔案都放在同一個練習目錄底下，每個練習一個子目錄：

```bash
# 建立練習根目錄並進入
mkdir -p ~/docker-practice
cd ~/docker-practice
```

> macOS 的 Docker Desktop 預設只允許掛載 `/Users`、`/Volumes`、`/private`、`/tmp`、`/var/folders` 底下的路徑（Settings → Resources → File sharing）。練習目錄放在家目錄底下就不會遇到「mounts denied」的錯誤。

---

## 1.5 Docker 常用指令速覽

```bash
# === 映像相關 ===
docker pull <image>         # 拉取映像檔
docker images               # 列出本地映像檔
docker rmi <image>          # 刪除映像檔
docker build -t <name> .    # 建構映像檔

# === 容器相關 ===
docker run <image>          # 建立並啟動容器
docker ps                   # 列出運行中的容器
docker ps -a                # 列出所有容器（含已停止）
docker stop <container>     # 停止容器
docker start <container>    # 啟動已停止的容器
docker rm <container>       # 刪除容器
docker exec -it <container> bash  # 進入運行中的容器

# === 系統相關 ===
docker system df            # 查看磁碟使用量
docker system prune         # 清理未使用的資源
docker logs <container>     # 查看容器日誌
```

---

## 1.6 實際情境

### 情境一：docker 指令需要 sudo

**問題**：每次執行 docker 指令都需要加 `sudo`

```bash
# 原因：當前使用者未加入 docker 群組

# 解決方案：將使用者加入 docker 群組
sudo usermod -aG docker $USER

# 重新登入或執行以下指令讓群組變更生效
newgrp docker

# 驗證
docker ps
```

### 情境二：Docker Desktop 啟動後佔用大量記憶體

**問題**：macOS / Windows 上 Docker Desktop 佔用過多 RAM

```bash
# 解決方案：限制 Docker Desktop 資源使用

# macOS / Windows：在 Docker Desktop 中設定
# Settings → Resources → Memory → 調整為適當值（建議 4GB）

# WSL2 使用者可透過 .wslconfig 限制
# 建立 ~/.wslconfig（Windows 使用者目錄下）
```

```ini
# ~/.wslconfig
[wsl2]
memory=4GB
processors=2
swap=2GB
```

### 情境三：docker pull 速度極慢或被拒絕

**問題**：從 Docker Hub 拉取映像檔速度非常慢，或出現 `toomanyrequests: You have reached your pull rate limit`

```bash
# 原因一：Docker Hub 對拉取次數有限制，未登入（匿名）的額度最低，且以對外 IP 計算
#        公司或學校共用同一個對外 IP 時，很容易一起被擋
# 解決方案：登入後再拉取（免費帳號的額度比匿名高）
docker login

# 原因二：網路到 Docker Hub 慢
# 解決方案：設定鏡像加速器

# Linux：編輯 daemon.json
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json <<EOF
{
  "registry-mirrors": [
    "https://mirror.gcr.io"
  ]
}
EOF

# 重啟 Docker
sudo systemctl daemon-reload
sudo systemctl restart docker

# macOS / Windows：在 Docker Desktop 設定
# Settings → Docker Engine → 加入 registry-mirrors 設定
```

### 情境四：磁碟空間被 Docker 吃光

**問題**：Docker 使用一段時間後，磁碟空間不足

```bash
# 查看 Docker 磁碟使用量
docker system df

# 輸出範例：
# TYPE           TOTAL    ACTIVE    SIZE      RECLAIMABLE
# Images         15       3         5.2GB     4.1GB (78%)
# Containers     8        2         120MB     95MB (79%)
# Local Volumes  10       3         2.3GB     1.8GB (78%)
# Build Cache    45       0         3.5GB     3.5GB (100%)

# 清理未使用的資源：已停止的容器、沒被容器使用的網路與映像、建構快取
# -a：連「有名字但沒有容器在用」的映像也刪（沒有 -a 只刪 <none> 的懸空映像）
# 預設不會刪 volume，資料庫資料不會因此消失
docker system prune -a

# 清理沒有被任何容器掛載的「匿名」volume
docker volume prune

# 連「具名」volume 也清掉（例如 pgdata）
# ⚠️ 已停止、但之後還要用的專案（例如 compose down 後的資料庫）的資料也會被刪，執行前先 docker volume ls 看清楚
docker volume prune -a

# 僅清理建構快取
docker builder prune
```

---

## 1.7 本章小結

- Docker 是一個輕量級的容器化平台，解決了環境一致性問題
- 核心概念：映像檔（Image）、容器（Container）、倉庫（Registry）
- 安裝方式依作業系統不同，macOS / Windows 推薦 Docker Desktop，Linux 推薦直接安裝 Docker Engine
- 安裝後務必執行 `docker run hello-world` 驗證
- 定期使用 `docker system prune` 清理磁碟空間

---

> 下一章：[映像檔與容器基礎操作](./02-images-containers.md)
