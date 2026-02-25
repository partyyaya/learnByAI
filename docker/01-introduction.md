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
│            Hypervisor (VMware/VBox)       │
├─────────────────────────────────────────┤
│              Host OS                     │
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
# 移除舊版本
sudo apt remove docker docker-engine docker.io containerd runc

# 安裝必要套件
sudo apt update
sudo apt install ca-certificates curl gnupg lsb-release -y

# 新增 Docker 官方 GPG key
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# 新增 Docker 套件庫
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# 安裝 Docker Engine
sudo apt update
sudo apt install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin -y

# 讓當前使用者不需要 sudo 即可執行 docker
sudo usermod -aG docker $USER
newgrp docker

# 驗證安裝
docker --version
docker compose version
```

### CentOS / RHEL

```bash
# 移除舊版本
sudo yum remove docker docker-client docker-client-latest docker-common \
  docker-latest docker-latest-logrotate docker-logrotate docker-engine

# 安裝必要套件
sudo yum install -y yum-utils

# 新增 Docker 套件庫
sudo yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo

# 安裝 Docker Engine
sudo yum install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin -y

# 啟動與設定開機自啟
sudo systemctl start docker
sudo systemctl enable docker

# 讓當前使用者不需要 sudo
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

# 4. 在 WSL2 終端中驗證
docker --version
```

---

## 1.4 安裝後驗證

```bash
# 查看 Docker 版本資訊
docker --version
# Docker version 27.x.x, build xxxxxxx

# 查看詳細版本資訊
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

### 情境三：docker pull 速度極慢

**問題**：從 Docker Hub 拉取映像檔速度非常慢

```bash
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

# 清理所有未使用的資源（映像、容器、網路、快取）
docker system prune -a

# 僅清理未使用的 volume
docker volume prune

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
