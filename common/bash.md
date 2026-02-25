# Bash 常用指令手冊（含 Nginx / Docker 實務）

這份文件整理了開發與維運最常用的 Bash 指令，特別補上 Nginx 與 Docker 場景。每個指令都會說明：

- 做什麼
- 什麼時候用
- 範例怎麼下

---

## 1. Bash 是什麼？

Bash（Bourne Again SHell）是 Linux/macOS 最常見的命令列 Shell。你在 Terminal 輸入的指令（例如 `ls`、`cd`、`docker ps`）通常都是由 Bash 幫你解析與執行。

你可以把它理解成：

- **命令執行器**：幫你執行系統指令
- **腳本語言**：可以把多個指令寫成 `.sh` 自動化腳本
- **系統管理入口**：部署、排錯、監控大多在這裡完成

---

## 2. 常用觀念先記住

### 2.1 `sudo`

`sudo` 代表用管理員權限執行指令。像安裝軟體、管理服務通常都需要它。

```bash
sudo apt install nginx
sudo systemctl restart nginx
```

### 2.2 `-h`, `--help`, `man`

不確定指令怎麼用時，先看說明文件：

```bash
docker --help
nginx -h
man ls
```

### 2.3 相對路徑 vs 絕對路徑

- 相對路徑：`./logs/access.log`
- 絕對路徑：`/var/log/nginx/access.log`

---

## 3. 目錄與檔案操作

| 指令 | 用途 | 常見情境 |
|------|------|----------|
| `pwd` | 顯示目前所在路徑 | 確認自己現在在哪個資料夾 |
| `ls` | 列出檔案與目錄 | 看目錄內容 |
| `cd` | 切換目錄 | 進到專案資料夾 |
| `mkdir` | 建立目錄 | 新增資料夾 |
| `touch` | 建立空檔案 / 更新時間戳 | 先建立設定檔 |
| `cp` | 複製檔案/目錄 | 備份設定檔 |
| `mv` | 移動/改名 | 重新命名檔案 |
| `rm` | 刪除檔案/目錄 | 移除不需要的檔案 |

```bash
# 顯示目前路徑
pwd

# 列出全部檔案（含隱藏檔）
ls -la

# 建立多層目錄
mkdir -p /etc/nginx/snippets

# 複製設定檔當備份
cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.bak

# 重新命名
mv old.conf new.conf

# 移動檔案到指定目錄
mv ./default.conf /etc/nginx/conf.d/

# 移動並同時改名
mv ./nginx.conf /etc/nginx/nginx.conf.bak

# 刪除資料夾（小心）
rm -rf /tmp/test-dir
```

> `rm -rf` 很危險，務必確認路徑再執行。
>
> `mv` 注意事項：
> - 目標檔名已存在時會直接覆蓋（預設不提示），可改用 `mv -i` 先確認
> - 目標目錄若不存在會失敗，先用 `mkdir -p` 建立
> - 跨磁碟移動本質上會是「複製 + 刪除」，大檔案可能需要較久時間

---

## 4. 查看檔案內容與文字搜尋

| 指令 | 用途 | 常見情境 |
|------|------|----------|
| `cat` | 一次輸出完整檔案 | 小檔案快速查看 |
| `less` | 分頁閱讀 | 看長檔案或日誌 |
| `tail` | 看檔案尾端 | 看最新 log |
| `head` | 看檔案開頭 | 快速看前幾行 |
| `wc` | 計算行數/字數 | 統計資料量 |
| `grep` | 關鍵字搜尋 | 日誌過濾 |

```bash
# 看 Nginx 設定
cat /etc/nginx/nginx.conf

# 分頁看錯誤日誌
less /var/log/nginx/error.log

# 即時追蹤日誌（非常常用）
tail -f /var/log/nginx/access.log

# 找出 500 錯誤
grep " 500 " /var/log/nginx/access.log

# 看檔案有幾行
wc -l /var/log/nginx/access.log

# 看檔案有幾個單字（字數）
wc -w /var/log/nginx/access.log

# 看檔案有幾個字元
wc -m /var/log/nginx/access.log
```

---

## 5. 權限與擁有者

| 指令 | 用途 | 常見情境 |
|------|------|----------|
| `chmod` | 修改權限 | 設定腳本可執行 |
| `chown` | 修改擁有者 | 網站目錄給 `www-data` |
| `id` | 查看使用者身分 | 確認目前帳號 |

```bash
# 1) 給腳本執行權限（對 user/group/other 都加上 x）
chmod +x deploy.sh
ls -l deploy.sh

# 2) 設定網站目錄擁有者（遞迴改擁有者與群組）
sudo chown -R www-data:www-data /var/www/mysite
ls -ld /var/www/mysite

# 3) 權限設為 755（遞迴）
chmod -R 755 /var/www/mysite
ls -ld /var/www/mysite
```

這三個指令的意思（逐行拆解）：

1. `chmod +x deploy.sh`
   - `chmod` = 改檔案權限（mode）
   - `+x` = 新增「可執行」權限
   - 效果：原本不能直接執行的腳本，現在可以用 `./deploy.sh` 跑
   - 什麼時候用：剛建立 shell script 後，第一次執行前

2. `sudo chown -R www-data:www-data /var/www/mysite`
   - `chown` = change owner，改「擁有者:群組」
   - `-R` = recursive，遞迴套用到所有子目錄與檔案
   - `www-data:www-data` = 擁有者是 `www-data`，群組也是 `www-data`
   - 效果：Nginx（通常以 `www-data` 運行）對網站檔案有正確存取身份，減少 403 權限錯誤
   - 什麼時候用：部署網站檔案後、權限混亂時

3. `chmod -R 755 /var/www/mysite`
   - `755` = 擁有者 `rwx`，其他人 `r-x`
   - `-R` = 遞迴套用到整個目錄樹
   - 效果：大家都可讀取，只有擁有者可寫入
   - 什麼時候用：快速給網站目錄可讀可進入權限
   - 注意：`-R 755` 會讓「檔案也有 x 權限」，通常不是最佳實務

更推薦的網站權限做法（目錄 755、檔案 644）：

```bash
# 目錄要可進入（x）
find /var/www/mysite -type d -exec chmod 755 {} \;

# 一般檔案不需要執行權限
find /var/www/mysite -type f -exec chmod 644 {} \;
```

為什麼是 `755` 這種三個數字，不是只寫一個 `7`？

`chmod` 的數字模式是「**每一位數對應一類人**」：

- 第 1 位：檔案擁有者（owner / user）
- 第 2 位：同群組使用者（group）
- 第 3 位：其他人（others）

所以：

- `755` = owner `7`、group `5`、others `5`
- `644` = owner `6`、group `4`、others `4`

單一數字（例如只有 `7`）不完整，因為系統需要同時知道三類人的權限。

每個數字的意義是這樣算出來的：

| 權限 | 數值 |
|------|------|
| 讀（r） | 4 |
| 寫（w） | 2 |
| 執行（x） | 1 |

把需要的權限加總就是那一位數：

- `7` = 4 + 2 + 1 = `rwx`
- `6` = 4 + 2 = `rw-`
- `5` = 4 + 1 = `r-x`
- `4` = `r--`

例子拆解：

```text
755 = rwx r-x r-x
      │   │   └─ others
      │   └───── group
      └───────── owner

644 = rw- r-- r--
```

補充：有時你會看到四位數（例如 `0755`），前面的 `0` 是特殊權限位（setuid / setgid / sticky）預設值，日常網站目錄多數先記三位數就夠用。

---

## 6. 行程與服務管理

| 指令 | 用途 | 常見情境 |
|------|------|----------|
| `ps` | 看行程清單 | 檢查程式是否在跑 |
| `pgrep` | 依名稱找行程 PID/命令列 | 精準找指定服務（如 nginx） |
| `top` / `htop` | 即時看 CPU/記憶體 | 排查效能問題 |
| `kill` | 終止行程 | 手動停止卡住的行程 |
| `systemctl` | 管理系統服務 | 管理 nginx、docker |
| `journalctl` | 看 systemd 服務日誌 | 查服務啟動失敗原因 |

```bash
# 找 nginx 行程
ps aux | grep nginx

# 避免把 grep 自己也列出來（更推薦）
# 在正規表示式裡，[n] 等同於 n，所以它一樣會匹配 nginx
# 但指令本身的文字是 grep [n]ginx，不包含連續字串 nginx
# 所以行程清單中的 grep [n]ginx 不會被 grep [n]ginx 自己匹配到
ps aux | grep [n]ginx
# 或更精準
pgrep -a nginx

# 即時看資源
top

# 終止 PID 1234
kill 1234

# 強制終止
kill -9 1234

# 管理服務
sudo systemctl start nginx
sudo systemctl status nginx
sudo systemctl restart docker

# 看 nginx 服務日誌
sudo journalctl -u nginx -n 100 --no-pager
```

`ps aux` 的 `aux` 是三個參數（不是一個單字）：

- `a`：顯示所有使用者的行程（不只你自己的）
- `u`：用「使用者導向」格式顯示（會看到 USER、%CPU、%MEM 等欄位）
- `x`：連沒有控制終端機（TTY）的背景行程也顯示

所以 `ps aux` 常被用來「看整台機器目前有哪些行程在跑」。

---

## 7. 網路排查常用指令

| 指令 | 用途 | 常見情境 |
|------|------|----------|
| `curl` | 發 HTTP 請求 | 測 API / 測網站 |
| `ping` | 測網路連通性 | 檢查主機可達性 |
| `ss` | 看連線/監聽埠 | 檢查 port 是否被占用 |
| `dig` / `nslookup` | 查 DNS | 排查網域解析問題 |
| `traceroute` | 看路由路徑 | 排查網路延遲/中斷 |

```bash
# 看網站回應 header
curl -I https://example.com

# 打健康檢查 API
curl http://127.0.0.1:3000/health

# 測網路連通性（送 4 次就結束）
ping -c 4 8.8.8.8

# 測網域是否可達（同時可驗證 DNS + 網路）
ping -c 4 example.com

# 看 80/443 是否在監聽
sudo ss -tlnp | grep -E ":80|:443"

# 查 DNS
dig example.com

# 查封包經過哪些節點（hop）
traceroute example.com

# 不做 DNS 反解（更快，適合排查）
traceroute -n example.com
```

`ping` 補充：

- `-c 4` = 只送 4 個封包，避免無限持續（不加 `-c` 會一直跑）
- 常看指標：`time=xx ms`（延遲）、`packet loss`（封包遺失率）
- 如果 `100% packet loss`，代表目標不可達或被防火牆擋住 ICMP

`traceroute` 補充：

- 用來看封包從你電腦到目標主機，中間經過哪些路由節點（hop）
- 如果某一跳開始大量 `* * *` 或延遲突然暴增，通常表示該段網路可能有問題
- 常用於「網站偶爾打得開、偶爾打不開」這種跨網段路徑問題

`ss -tlnp | grep -E ":80|:443"` 參數拆解：

- `ss`：顯示 socket/連線資訊
- `-t`：只看 TCP
- `-l`：只看正在監聽（LISTEN）的 socket
- `-n`：數字格式顯示，不做 DNS/服務名反查（更快、可讀性更高）
- `-p`：顯示是哪個行程（PID/程式名）在使用這個 port
- `|`：把前一個指令輸出交給下一個指令
- `grep -E ":80|:443"`：只保留包含 `:80` 或 `:443` 的行（`-E` 啟用延伸正規式，`|` 代表 OR）

等同意思也可寫成：

```bash
sudo ss -tlnp | grep -E ':(80|443)\b'
```

---

## 8. Nginx 常用指令（重點）

### 8.1 設定與控制

| 指令 | 用途 | 意義 |
|------|------|------|
| `nginx -t` | 測試設定語法 | 上線前必做，避免壞設定生效 |
| `nginx -T` | 輸出完整合併後設定 | 排查 include 後實際載入內容 |
| `nginx -s reload` | 平滑重載 | 不中斷既有連線 |
| `nginx -s stop` | 立即停止 | 緊急停機 |
| `nginx -s quit` | 優雅停止 | 等現有請求完成再停 |
| `nginx -V` | 顯示版本與編譯模組 | 檢查是否有某個模組 |

```bash
# 1) 先測設定
sudo nginx -t

# 2) 再重載（不中斷）
sudo nginx -s reload

# 看完整設定（含 include）
sudo nginx -T
```

### 8.2 服務管理（systemd）

```bash
sudo systemctl start nginx
sudo systemctl stop nginx
sudo systemctl restart nginx
sudo systemctl reload nginx
sudo systemctl status nginx
sudo systemctl enable nginx
```

### 8.3 日誌排查

```bash
# 看錯誤日誌
tail -f /var/log/nginx/error.log

# 看存取日誌
tail -f /var/log/nginx/access.log

# 篩出 502
grep " 502 " /var/log/nginx/access.log
```

### 8.4 常見 Nginx 排錯流程

```bash
# 1. 語法先過
sudo nginx -t

# 2. 服務狀態
sudo systemctl status nginx

# 3. 看錯誤日誌
tail -n 100 /var/log/nginx/error.log

# 4. 檢查監聽 port
sudo ss -tlnp | grep nginx
```

---

## 9. Docker 常用指令（重點）

### 9.1 基本生命週期

| 指令 | 用途 | 意義 |
|------|------|------|
| `docker ps` | 看運行中的容器 | 確認服務是否啟動 |
| `docker ps -a` | 看所有容器 | 包含已停止容器 |
| `docker images` | 看本機映像檔 | 檢查版本與大小 |
| `docker run` | 啟動新容器 | 從 image 建立並啟動 |
| `docker stop/start/restart` | 停止/啟動/重啟容器 | 日常維運操作 |
| `docker rm` | 刪除容器 | 清理不用的容器 |
| `docker rmi` | 刪除映像檔 | 清理磁碟 |

```bash
# 查看運行中容器
docker ps

# 啟動 Nginx 容器
docker run -d --name my-nginx -p 80:80 nginx:stable

# 停止與啟動
docker stop my-nginx
docker start my-nginx
```

### 9.2 偵錯與觀察

| 指令 | 用途 | 常見情境 |
|------|------|----------|
| `docker logs` | 看容器輸出 | 排查啟動失敗 |
| `docker exec` | 進入容器執行指令 | 查容器內檔案與程序 |
| `docker inspect` | 看容器詳細資訊 | 查 IP、掛載、環境變數 |
| `docker stats` | 看資源使用 | 查 CPU/記憶體是否爆量 |

```bash
# 即時看日誌
docker logs -f my-nginx

# 進容器內看設定
docker exec -it my-nginx sh

# 看容器資源
docker stats
```

### 9.3 映像建置與發布

```bash
# 依 Dockerfile 建 image
docker build -t myapp:1.0.0 .

# 打 tag
docker tag myapp:1.0.0 myrepo/myapp:1.0.0

# 推到 registry
docker push myrepo/myapp:1.0.0
```

### 9.4 Docker Compose

```bash
# 啟動（背景）
docker compose up -d

# 停止並刪除容器網路
docker compose down

# 看服務狀態
docker compose ps

# 看某服務日誌
docker compose logs -f nginx

# 重新建置後啟動
docker compose up -d --build
```

---

## 10. 壓縮、封存、下載

| 指令 | 用途 | 常見情境 |
|------|------|----------|
| `tar` | 打包/解壓 | 備份設定檔 |
| `gzip` / `gunzip` | 壓縮/解壓單檔 | 壓 log |
| `zip` / `unzip` | 壓縮包 | 跨平台傳檔 |
| `wget` / `curl -O` | 下載檔案 | 下載安裝包 |

```bash
# tar：打包 + gzip 壓縮（建立 .tar.gz）
tar -czf nginx-backup.tar.gz /etc/nginx

# 看壓縮包內有哪些檔案（不解壓）
tar -tzf nginx-backup.tar.gz

# 解壓到目前目錄
tar -xzf nginx-backup.tar.gz

# 解壓到指定目錄
tar -xzf nginx-backup.tar.gz -C /tmp/restore

# gzip：壓縮單一檔案（預設會把原檔替換成 .gz）
gzip access.log

# 保留原檔再壓縮
gzip -k access.log

# 解壓 .gz 檔案
gunzip access.log.gz

# zip：跨平台壓縮資料夾
zip -r website.zip ./website

# unzip：列出內容 / 解壓到指定目錄
unzip -l website.zip
unzip website.zip -d ./website-unzip

# wget：下載檔案（-c 可續傳）
wget -c https://example.com/file.tar.gz

# curl：依原檔名下載（-L 會跟隨 30x 轉址）
curl -L -O https://example.com/file.tar.gz

# curl：下載並自訂檔名
curl -L -o app.tar.gz https://example.com/file.tar.gz
```

這段最容易搞混的重點：

- `tar` 是「封存打包」，`gzip` 是「壓縮演算法」
- `tar -czf xxx.tar.gz` = 先打包，再用 gzip 壓縮
- `gzip` 主要處理單一檔案，不會像 `tar` 一次打包整個目錄結構
- `curl -O` 和 `curl -o` 不同：
  - `-O` 用遠端原始檔名
  - `-o` 用你指定的檔名
- `wget -c` 可續傳大檔，下載中斷時很實用
- `tar -xzf ... -C <dir>` 目標目錄必須先存在，不然會報錯

`tar` 參數快速記憶：

- `c` = create（建立封存）
- `x` = extract（解壓）
- `t` = list（列出內容）
- `z` = gzip（使用 gzip 壓縮/解壓）
- `f` = file（指定檔名，通常放最後）

---

## 11. 環境變數與暫時設定

| 指令 | 用途 | 常見情境 |
|------|------|----------|
| `export` | 設定環境變數 | 設 API URL、TOKEN |
| `env` | 查看環境變數 | 排查設定問題 |
| `echo` | 印出文字/變數 | 驗證變數值 |

```bash
# 設定暫時變數（當前 shell 有效）
export APP_ENV=production
export API_URL=https://api.example.com

# 檢查
echo $APP_ENV
env | grep API_URL
```

---

## 12. 重新導向與管線（超常用）

### 12.1 `|`

把前一個指令的輸出，交給下一個指令。

```bash
docker ps | wc -l
cat /var/log/nginx/access.log | grep " 500 "
```

### 12.2 `>` 與 `>>`

- `>` 覆蓋寫入
- `>>` 追加寫入

```bash
echo "deploy start" > deploy.log
echo "done" >> deploy.log
```

### 12.3 `&&`

前一個成功才執行下一個（部署很常用）。

```bash
sudo nginx -t && sudo nginx -s reload
```

---

## 13. 實務小抄：Nginx + Docker 上線常用組合

### 13.1 本機 Nginx 設定修改後生效

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 13.2 Docker 化服務重建部署

```bash
docker compose pull && docker compose up -d
docker compose ps
docker compose logs -f --tail=100
```

### 13.3 快速看 5xx 問題

```bash
grep " 50[0-9] " /var/log/nginx/access.log | tail -n 50
tail -n 100 /var/log/nginx/error.log
```

### 13.4 確認容器是否真的有對外提供服務

```bash
docker ps
sudo ss -tlnp | grep -E ":80|:443|:3000"
curl -I http://127.0.0.1
```

---

## 14. 常見錯誤與建議

- **先測再重載**：任何 Nginx 變更都先跑 `nginx -t`
- **不要直接 `rm -rf`**：特別是系統目錄
- **先看日誌再重啟**：重啟不是萬靈丹，先找根因
- **留意權限**：`403` 常常是 `chown/chmod` 問題
- **避免把密碼寫進指令歷史**：可改用環境變數或祕密管理工具

---

## 15. 一頁速查（最常用）

```bash
# 路徑與檔案
pwd && ls -la
cd /path/to/project

# Nginx
sudo nginx -t
sudo systemctl reload nginx
tail -f /var/log/nginx/error.log

# Docker
docker ps
docker logs -f <container>
docker exec -it <container> sh
docker compose up -d --build

# 網路
curl -I http://localhost
sudo ss -tlnp
```

---

需要的話我可以再幫你做一版 `bash-cheatsheet.md`（更短版，純指令清單 + 1 行說明），方便你上線時快速查。 
