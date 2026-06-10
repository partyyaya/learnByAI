# 第一章：Nginx 簡介與安裝

## 1.1 什麼是 Nginx？

Nginx（發音為「Engine X」）是一款高效能的 HTTP 伺服器、反向代理伺服器與郵件代理伺服器。由 Igor Sysoev 於 2004 年首次發布，最初是為了解決 C10K 問題（同時處理一萬個以上的並發連線）。

### Nginx 的核心特點

| 特點 | 說明 |
|------|------|
| 高並發處理 | 採用事件驅動（Event-Driven）架構，可處理數萬並發連線 |
| 低記憶體消耗 | 相較 Apache，處理相同請求所需記憶體更少 |
| 反向代理 | 可作為後端應用程式的代理伺服器 |
| 負載均衡 | 內建多種負載均衡演算法 |
| 靜態檔案服務 | 極高效的靜態檔案處理能力 |
| 模組化設計 | 可透過模組擴充功能 |

### Nginx vs Apache

```
                Nginx                           Apache
架構        事件驅動（非阻塞）              行程/執行緒（阻塞）
並發能力     極高（數萬連線）               中等（受限於執行緒數）
記憶體使用   低                              較高
靜態檔案     非常快                          快
動態內容     需搭配 FastCGI/Proxy            內建模組支援（mod_php）
設定方式     集中式設定檔                    支援 .htaccess 分散式設定
適用場景     高流量網站、反向代理、API Gateway  傳統網站、需要 .htaccess 的情境
```

---

## 1.2 安裝 Nginx

### Ubuntu / Debian

```bash
# 更新套件庫
sudo apt update

# 安裝 Nginx
sudo apt install nginx -y

# 確認安裝版本
nginx -v

# 啟動 Nginx
sudo systemctl start nginx

# 設定開機自動啟動
sudo systemctl enable nginx

# 確認狀態
sudo systemctl status nginx
```

<sup>名詞說明：**[【1】sudo](#note-1)** | **[【2】systemctl](#note-2)** | **[【3】apt](#note-3)**</sup>

### CentOS / RHEL

```bash
# 安裝 EPEL 儲存庫
sudo yum install epel-release -y

# 安裝 Nginx
sudo yum install nginx -y

# 啟動與設定開機自啟
sudo systemctl start nginx
sudo systemctl enable nginx
```

> **備註：EPEL 是什麼？為什麼要先裝它？**
>
> - EPEL（Extra Packages for Enterprise Linux）是 Fedora 社群維護的「額外套件庫」。
> - CentOS 7 / RHEL 7 的官方預設套件庫沒有收錄 Nginx，所以要先安裝 `epel-release` 把這個套件庫加進系統，後面的 `yum install nginx` 才找得到套件。
> - 較新的 CentOS Stream / RHEL 8+ 已內建 nginx 模組，可直接 `sudo dnf install nginx`，不一定需要 EPEL。

### macOS（使用 Homebrew）

```bash
# 安裝
brew install nginx

# 啟動（註冊為背景服務，登入時自動啟動，類似 Linux 的 systemctl enable + start）
brew services start nginx

# 或者手動啟動（直接執行一次，不註冊背景服務）
nginx
```

> **備註：macOS（Homebrew）版本的兩個差異**
>
> - Homebrew 安裝的 Nginx 預設監聽 **8080** port（不是 80），因為非 root 使用者無法綁定 1024 以下的特權 port；驗證時請改用 `http://localhost:8080`。
> - 設定檔位置也不同：`/opt/homebrew/etc/nginx/nginx.conf`（Apple Silicon）或 `/usr/local/etc/nginx/nginx.conf`（Intel）。

### Docker

```bash
# 拉取官方映像檔
docker pull nginx:stable

# 啟動容器
# -d: 背景執行（detached mode）
# --name: 指定容器名稱
# -p 80:80: 將主機 80 port 映射到容器 80 port
docker run -d --name my-nginx -p 80:80 nginx:stable

# 掛載自訂設定檔
# -v: 掛載 Volume(讓資料不跟容器一起消失，可持久化、可共享)，格式為 主機路徑:容器路徑[:模式]
# :ro: 唯讀模式（read-only），容器只能讀取不能修改
docker run -d --name my-nginx \
  -p 80:80 \
  -v /path/to/nginx.conf:/etc/nginx/nginx.conf:ro \
  -v /path/to/html:/usr/share/nginx/html:ro \
  nginx:stable

# 停止容器
docker stop my-nginx

# 刪除容器
docker rm my-nginx

# 強制停止並刪除容器（容器仍在執行時可用）
docker rm -f my-nginx
```

#### 補充：先用 Docker 跑 Ubuntu，再安裝 Nginx（可行）

```bash
# 1) 先進 Ubuntu 容器（示範用 8080 對外）
# -i: interactive 保持 STDIN(Standard Input) 開啟（可持續輸入指令）
# -t: pseudo-terminal，分配虛擬終端機（讓你看到互動式 shell）
# --name ubuntu-nginx: 指定容器名稱
# -p 8080:80: 主機 8080 對應容器 80
# ubuntu:22.04: 使用 Ubuntu 22.04 映像
# bash: 容器啟動後直接進入 bash shell
docker run -it --name ubuntu-nginx -p 8080:80 ubuntu:22.04 bash

# 2) 在容器內安裝 Nginx
apt update
apt install -y nginx

# 3) 在容器內以前景模式啟動
# 容器通常不跑 systemd（PID 1 不是 systemd），因此多半不使用 systemctl 管服務
# -g: 傳入全域設定指令
# 'daemon off;': 關閉背景化，讓 Nginx 留在前景當容器主行程
nginx -g 'daemon off;'
```

離開與再次進入容器（`ubuntu-nginx`）：

```bash
# 離開容器 shell（bash 結束後，容器通常也會停止）
exit

# 或 detach（離開終端但讓容器繼續跑）
# 快捷鍵：Ctrl + P，接著 Ctrl + Q

# 查看容器狀態
docker ps -a --filter "name=ubuntu-nginx"

# 若容器已停止，先啟動
docker start ubuntu-nginx

# 再次進入容器
docker exec -it ubuntu-nginx bash

# 也可一步完成：啟動並直接附著到容器
# -a (attach): 連到容器輸出（stdout/stderr）
# -i (interactive): 保持輸入開啟，可互動輸入指令
# 等同「docker start ubuntu-nginx + docker attach ubuntu-nginx」
#（此容器最初是用 bash 啟動，所以你會回到容器 shell）
docker start -ai ubuntu-nginx
```

實務建議：

- 這種方式「可行」，很適合教學、除錯、臨時驗證。
- 但正式環境通常更建議直接用 `nginx:stable`（映像較小、啟動更快、維護更簡單）。
- 若真的需要 Ubuntu 基底，建議寫 `Dockerfile` 固化安裝步驟，避免每次進容器手動安裝。

可直接使用的 `Dockerfile`（Ubuntu 基底）：

```dockerfile
# 基底映像：Ubuntu 22.04 LTS
FROM ubuntu:22.04

# 關閉 apt 互動式提示，避免 build 卡住
ENV DEBIAN_FRONTEND=noninteractive

# 更新套件索引並安裝 Nginx
# -y: 自動回答 yes
# --no-install-recommends: 不安裝建議套件，減少映像大小
# rm -rf /var/lib/apt/lists/*: 清除 apt 快取，縮小 image
RUN apt-get update \
    && apt-get install -y --no-install-recommends nginx ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 宣告容器會使用 80 埠（文件用途，不等於自動對外開放）
EXPOSE 80

# 讓 Nginx 在前景執行，符合容器執行模式
# -g 'daemon off;': 關閉 daemon 背景化，避免容器啟動後立即退出
CMD ["nginx", "-g", "daemon off;"]
```

```bash
# 1) 建立目錄並放入 Dockerfile
# -p: 目錄已存在時不報錯
# &&: 前一個指令成功才執行下一個
mkdir -p ubuntu-nginx && cd ubuntu-nginx

# 2) 建置映像
# -t: 指定 image 名稱與 tag（name:tag）
# .: 以目前目錄作為 build context
docker build -t ubuntu-nginx:local .

# 3) 啟動容器
# -d: 背景執行
# --name: 指定容器名稱
# -p 8080:80: 主機 8080 對應容器 80
docker run -d --name ubuntu-nginx -p 8080:80 ubuntu-nginx:local

# 4) 驗證
# -I: 只取 HTTP response headers（不下載 body）
curl -I http://localhost:8080
```

---

## 1.3 安裝後驗證

安裝完成後，開啟瀏覽器訪問 `http://localhost` 或 `http://你的伺服器IP`，應該會看到 Nginx 的預設歡迎頁面。

也可以使用 curl 測試：

```bash
# -I: 只取得 HTTP 回應標頭（不下載網頁內容），適合快速確認服務是否正常
curl -I http://localhost
```

預期回應：

```
HTTP/1.1 200 OK
Server: nginx/1.24.0
Date: ...
Content-Type: text/html
...
```

---

## 1.4 常用管理指令

```bash
# 啟動 Nginx
sudo systemctl start nginx

# 停止 Nginx
sudo systemctl stop nginx

# 重新啟動（會中斷連線）
sudo systemctl restart nginx

# 平滑重載設定（不中斷現有連線，推薦用於上線環境）
sudo systemctl reload nginx

# 測試設定檔語法是否正確（非常重要！每次修改後都要執行）
sudo nginx -t

# 查看 Nginx 的編譯參數與模組
nginx -V
```

### 直接使用 nginx 指令

```bash
# 測試設定檔
nginx -t

# 平滑重載
nginx -s reload

# 快速停止
nginx -s stop

# 優雅停止（等待現有請求處理完畢）
nginx -s quit

# 重新開啟日誌檔案（用於日誌輪替）
nginx -s reopen
```

> **`nginx -s` 的運作原理**
>
> - `-s` 是 signal（信號）的縮寫：這個指令本身不處理任何請求，而是讀取 PID 檔案（見第二章補充說明【4】），向「正在運行的 master process」發送對應的信號。
> - 對應關係：`reload` → `HUP`、`stop` → `TERM`（立即停止）、`quit` → `QUIT`（處理完現有請求才停止）、`reopen` → `USR1`（重新開啟日誌檔）。
> - `reload` 的內部流程：master 重新讀取設定 → 用新設定啟動一批新的 worker → 舊 worker 處理完手上的連線後優雅退出，因此服務不會中斷。
> - 也因此：若 Nginx 根本沒在運行，`nginx -s reload` 會直接報錯（找不到 PID 檔案），此時要用 `nginx` 或 `systemctl start nginx` 先啟動。
>
> **`nginx -v` 與 `nginx -V` 的差別**
>
> - `-v`（小寫）：只顯示版本號。
> - `-V`（大寫）：顯示版本號 + 編譯參數 + 內建模組清單；排查「某個模組有沒有被編進去」（例如 `http_ssl_module`、`http_sub_module`）時非常實用。

---

## 1.5 目錄結構

安裝完成後，Nginx 的主要檔案分布如下（以 Ubuntu 為例）：

```
/etc/nginx/                  # 主要設定目錄
├── nginx.conf               # 主設定檔
├── conf.d/                  # 額外設定檔目錄
│   └── default.conf         # 預設站台設定
├── sites-available/         # 可用的站台設定（Ubuntu/Debian 特有）
│   └── default
├── sites-enabled/           # 已啟用的站台設定（符號連結）
│   └── default -> ../sites-available/default
├── mime.types               # MIME 類型對應表
├── fastcgi_params           # FastCGI 參數
├── proxy_params             # 代理參數
└── snippets/                # 可重用的設定片段

/var/log/nginx/              # 日誌目錄
├── access.log               # 存取日誌
└── error.log                # 錯誤日誌

/usr/share/nginx/html/       # 預設網站根目錄
├── index.html               # 預設首頁
└── 50x.html                 # 錯誤頁面

/var/run/nginx.pid           # PID 檔案
```

Docker 補充（若用 `nginx:stable` 容器）：

- 上面這份樹狀結構是「Ubuntu 主機直接安裝」常見路徑；Docker 時是看「容器內」路徑，不是主機本機路徑。
- 容器內通常會有 `/etc/nginx/nginx.conf`、`/etc/nginx/conf.d/`、`/usr/share/nginx/html/`。
- `sites-available/`、`sites-enabled/` 在官方映像檔通常不會預設提供（除非你自行建立）。
- 若你有用 `-v` 掛載，主機檔案會映射到容器路徑（例如 `-v /path/to/nginx.conf:/etc/nginx/nginx.conf:ro`）。

```bash
# 進容器查看實際目錄
docker exec -it my-nginx sh
ls -la /etc/nginx
```

---

## 1.6 實際情境

### 情境一：安裝後無法訪問網頁

**問題**：安裝完 Nginx 後，瀏覽器無法連上 `http://伺服器IP`

**排查步驟**：

```bash
# 1. 確認 Nginx 是否正在運行
sudo systemctl status nginx

# 2. 確認是否監聽 80 port
# ss 參數：-t 只看 TCP、-l 只看監聽中（listening）、-n 以數字顯示 port、-p 顯示佔用的程式
sudo ss -tlnp | grep :80

# 3. 檢查防火牆設定
# Ubuntu (ufw)
sudo ufw status              # 查看防火牆狀態與現有規則
sudo ufw allow 'Nginx Full'  # 放行「Nginx Full」規則組（= 同時開放 80 + 443 port）

# CentOS (firewalld)
sudo firewall-cmd --permanent --add-service=http   # 永久放行 HTTP（80）；--permanent 表示寫入設定檔、重開機仍有效
sudo firewall-cmd --permanent --add-service=https  # 永久放行 HTTPS（443）
sudo firewall-cmd --reload                         # 重新載入防火牆規則，讓上面 --permanent 的變更立即生效

# 4. 如果是雲端主機，檢查安全群組（Security Group）是否開放 80/443 port
```

### 情境二：port 80 被其他程式佔用

**問題**：啟動 Nginx 時出現 `Address already in use`

```bash
# 找出佔用 port 80 的程式
# lsof -i :80：列出所有正在使用 80 port 的行程（含 PID 與程式名稱）
sudo lsof -i :80
# 或
sudo ss -tlnp | grep :80

# 常見佔用者：Apache
sudo systemctl stop apache2     # 先停止 Apache，釋放 80 port
sudo systemctl disable apache2  # 取消開機自啟，避免重開機後又搶回 port

# 然後重新啟動 Nginx
sudo systemctl start nginx
```

### 情境三：權限不足無法啟動

**問題**：非 root 使用者無法綁定 80 port

```bash
# 方法一：使用 sudo
sudo nginx

# 方法二：改用非特權 port（如 8080），在 nginx.conf 中修改
# listen 8080;

# 方法三：設定 capability（進階）
# setcap：賦予「執行檔」特定的核心權限（capability），不必整個程式用 root 跑
# cap_net_bind_service：允許綁定 1024 以下的特權 port（如 80/443）
# +ep：e（effective，立即生效）+ p（permitted，允許持有），兩者都要才有作用
sudo setcap 'cap_net_bind_service=+ep' /usr/sbin/nginx
```

> **備註：方法三的取捨**
>
> - 好處：Nginx 不必以 root 啟動也能綁定 80/443，整體權限更低、更安全。
> - 注意：capability 是綁在「執行檔」上的，升級 Nginx 後新的執行檔需要重新執行一次 `setcap`。

---

## 1.7 本章小結

- Nginx 是一款高效能的 Web 伺服器，擅長處理高並發場景
- 安裝流程簡單，支援多種作業系統與 Docker 部署
- 安裝後務必確認服務狀態、防火牆規則與 port 佔用情況
- `nginx -t` 是你最好的朋友——每次修改設定都要測試

---

> 下一章：[設定檔結構與基礎語法](./02-config-basics.md)

---

## 補充說明

<a id="note-1"></a>
### 【1】sudo

`sudo`（Super User DO）讓一般使用者**以系統管理員（root）身份**執行指令。

為什麼需要它？Linux 為了安全性，平時不會讓你用 root 帳號操作。但某些動作（安裝軟體、啟動服務、修改系統設定）需要最高權限，這時就要在指令前面加 `sudo`。

```bash
# 沒有 sudo → 權限不足，無法安裝
apt install nginx
# 錯誤：E: Could not open lock file - open (13: Permission denied)

# 加上 sudo → 以 root 身份執行，成功安裝
sudo apt install nginx
# 系統會要求輸入你的密碼（不是 root 的密碼）
```

常見情境：

| 指令 | 需要 sudo？ | 原因 |
|------|------------|------|
| `apt install / yum install` | 是 | 安裝軟體需要寫入系統目錄 |
| `systemctl start/stop` | 是 | 管理系統服務需要 root 權限 |
| `nginx -t` | 是 | 讀取 `/etc/nginx/` 下的設定檔 |
| `nginx -v` | 否 | 只是查看版本，不需要特殊權限 |
| `curl http://localhost` | 否 | 只是發送 HTTP 請求 |

> **小提醒**：如果你已經是 root 使用者（命令提示符號是 `#` 而非 `$`），就不需要加 `sudo`。

[⬆ 回到安裝 Nginx](#12-安裝-nginx)

---

<a id="note-2"></a>
### 【2】systemctl

`systemctl` 是 Linux 的**服務管理指令**，用來控制在背景持續運行的程式（稱為「服務」或「daemon」）。

Nginx 安裝後會註冊為系統服務，你不需要手動跑程式，而是透過 `systemctl` 管理它的生命週期：

```bash
# 啟動服務（背景運行）
sudo systemctl start nginx

# 停止服務
sudo systemctl stop nginx

# 重啟服務（先停再啟，會中斷現有連線）
sudo systemctl restart nginx

# 重載設定（不中斷連線，推薦用於上線環境）
sudo systemctl reload nginx

# 查看服務狀態（是否在運行、最近的日誌）
sudo systemctl status nginx

# 設定開機自動啟動
sudo systemctl enable nginx

# 取消開機自動啟動
sudo systemctl disable nginx
```

`systemctl status` 的輸出範例：

```
● nginx.service - A high performance web server
     Loaded: loaded (/lib/systemd/system/nginx.service; enabled)    ← enabled = 開機自啟
     Active: active (running) since Mon 2026-02-06 10:00:00 CST     ← running = 運行中
   Main PID: 1234 (nginx)
      Tasks: 3 (limit: 4915)
     Memory: 5.2M
        CPU: 32ms
     CGroup: /system.slice/nginx.service
             ├─1234 nginx: master process /usr/sbin/nginx
             ├─1235 nginx: worker process
             └─1236 nginx: worker process
```

重點欄位：
- **Active: active (running)** → 服務正在運行
- **Active: inactive (dead)** → 服務已停止
- **Active: failed** → 服務啟動失敗，往下看日誌找原因
- **enabled** → 開機會自動啟動
- **disabled** → 開機不會自動啟動

> **注意**：`systemctl` 是 systemd 系統的指令，適用於大多數現代 Linux（Ubuntu 16.04+、CentOS 7+）。非常舊的系統可能使用 `service nginx start` 的語法。

[⬆ 回到安裝 Nginx](#12-安裝-nginx)

---

<a id="note-3"></a>
### 【3】apt

`apt`（Advanced Package Tool）是 **Ubuntu / Debian** 系統的**套件管理工具**，用來安裝、更新、移除軟體。就像手機的 App Store，但是用指令操作。

不同的 Linux 發行版使用不同的套件管理工具：

| 發行版 | 套件管理指令 | 安裝 Nginx 範例 |
|--------|------------|-----------------|
| Ubuntu / Debian | `apt` | `sudo apt install nginx` |
| CentOS 7 / RHEL 7 | `yum` | `sudo yum install nginx` |
| CentOS 8+ / Fedora | `dnf` | `sudo dnf install nginx` |
| macOS | `brew`（Homebrew） | `brew install nginx` |

常用的 `apt` 指令：

```bash
# 更新套件清單（去伺服器查有哪些新版本可用）
# 注意：這不會安裝任何東西，只是「更新目錄」
sudo apt update

# 安裝軟體（-y 表示自動回答 Yes，不用手動確認）
sudo apt install nginx -y

# 移除軟體
sudo apt remove nginx

# 移除軟體 + 設定檔（完全清除）
sudo apt purge nginx

# 升級所有已安裝的軟體到最新版本
sudo apt upgrade -y

# 搜尋套件
apt search nginx

# 查看某個套件的資訊
apt show nginx
```

> **`apt update` vs `apt upgrade` 的差別**：
> - `apt update` = 更新「套件清單」（像是重新整理商品目錄，但沒有買東西）
> - `apt upgrade` = 把已安裝的軟體「升級到最新版」（真的安裝新版本）
>
> 通常的流程是**先 update 再 upgrade**，確保拿到最新的版本資訊後才升級。

[⬆ 回到安裝 Nginx](#12-安裝-nginx)
