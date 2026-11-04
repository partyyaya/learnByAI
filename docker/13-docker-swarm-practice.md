# 第十三章：Docker Swarm 實戰（Stack + Overlay + Secrets + Rolling Update）

## 13.1 為什麼還要學 Docker Swarm？

雖然現在主流大型平台多採用 Kubernetes，但 Docker Swarm 仍有幾個實務價值：

- 你需要比單機 Compose 更進階的「多節點編排」，但不想一開始就導入 K8s 全套複雜度
- 團隊已經熟 Docker CLI，希望用最少學習成本上線（`docker service` / `docker stack`）
- 你要快速驗證滾動更新、服務擴縮、跨主機 overlay 網路、secret 管理

一句話總結：**Swarm 是 Docker 生態裡的輕量編排方案**，上手快、概念清楚。

---

## 13.2 核心概念速讀

| 名稱 | 功能 | 你可以怎麼理解 |
|------|------|----------------|
| `Manager` | 管理叢集狀態、排程 Task | 控制平面 |
| `Worker` | 執行被指派的容器工作 | 執行節點 |
| `Service` | 你宣告的應用目標狀態 | 「我要跑幾份、用哪個映像」 |
| `Task` | Service 的實際執行單位 | 每個副本對應一個 Task |
| `Stack` | 一組服務（YAML） | Swarm 版的整包應用部署 |
| `Overlay Network` | 跨節點容器通訊 | 多機內網 |
| `Routing Mesh` | 服務入口負載分流 | 對任何節點打同 port 都可導流 |

> Manager 之間用 Raft 演算法維持一致的叢集狀態，需要「過半數」的 manager 存活才能運作。所以 manager 數量要是**奇數**：1 台（練習用，壞了整個叢集就無法管理）、3 台（可容忍 1 台故障）、5 台（可容忍 2 台）。2 台 manager 反而比 1 台更脆弱，任何一台壞掉都不過半。

---

## 13.3 練習環境準備

### 13.3.1 確認 Docker 環境

```bash
# 查看 Docker 版本（Client/Server 都要正常）
docker version

# 查看 Engine 資訊（包含 Swarm 狀態）
docker info
```

### 13.3.2 單機初始化 Swarm（本章最容易跟著做）

```bash
# 若你之前已加入過其他 Swarm，可先離開（單機練習常用）
# --force: 目前節點是 manager 時也可直接離開
docker swarm leave --force

# 初始化新的 Swarm（單機會同時是 manager）
docker swarm init

# 查看目前節點清單與角色
docker node ls
```

### 13.3.3 多節點加入（選讀）

在 manager 上：

```bash
# 用指定 IP 初始化（多機時建議明確指定可達位址）
docker swarm init --advertise-addr <MANAGER_IP>

# 取得 worker 加入指令（會直接輸出完整 join command）
docker swarm join-token worker

# 取得 manager 加入指令（管理節點要嚴格控管）
docker swarm join-token manager
```

各節點之間要開放以下連線（雲端主機請在安全群組 / 防火牆設定）：

| Port | 協定 | 用途 |
|------|------|------|
| 2377 | TCP | 叢集管理（節點加入、manager 之間溝通） |
| 7946 | TCP + UDP | 節點之間互相發現與狀態同步 |
| 4789 | UDP | overlay 網路的 VXLAN 資料傳輸 |

在 worker 節點上（貼上上面輸出的命令）：

```bash
# 加入現有 Swarm
docker swarm join --token <WORKER_TOKEN> <MANAGER_IP>:2377
```

回到 manager 驗證：

```bash
# 確認節點都進來了，STATUS 應為 Ready
docker node ls
```

---

## 13.4 第一個 Service（CLI 直上）

### 13.4.1 建立 Overlay 網路

```bash
# 建立 overlay 網路（Swarm 多節點互通基礎）
# --attachable: 允許臨時容器也可加入此網路（排錯常用）
docker network create --driver overlay --attachable app-overlay

# 驗證網路類型（Driver 應為 overlay）
docker network ls
docker network inspect app-overlay
```

### 13.4.2 建立 web 服務（3 副本 + 對外 port）

```bash
# 建立 service
docker service create \
  --name web \
  --replicas 3 \
  --publish published=8080,target=80,protocol=tcp,mode=ingress \
  --network app-overlay \
  --update-parallelism 1 \
  --update-delay 10s \
  nginx:1.28-alpine

# 參數重點：
# --replicas 3: 預期跑 3 份
# --publish ... mode=ingress: 啟用 routing mesh，對任一節點 8080 都能打到服務
# --update-parallelism / --update-delay: 滾動更新時一次更新 1 個、每批間隔 10 秒
```

### 13.4.3 驗證服務狀態

```bash
# 看 service 總覽（REPLICAS 應接近 3/3）
docker service ls

# 看每個 task 被排到哪個節點
docker service ps web

# 看服務詳細設定（human-readable）
docker service inspect --pretty web

# 從本機打服務（應回 200 或 nginx 頁面）
curl -I http://127.0.0.1:8080
```

### 13.4.4 擴縮容

```bash
# 擴到 5 份副本
docker service scale web=5

# 再次確認
docker service ls
docker service ps web

# 縮回 2 份副本
docker service scale web=2

# 刪除這個練習用的 service（下一節的 stack 也要用 8080，不刪會出現 port already in use）
docker service rm web
```

---

## 13.5 用 Stack（YAML）管理完整應用（推薦）

CLI 建 service 很快，但實務上更建議把配置寫進檔案做版本管理。

### 13.5.1 建立 stack-demo.yml

```yaml
# stack-demo.yml
# 新版 Docker 的 stack deploy 不需要再寫 version 欄位（舊教學常見的 version: "3.9" 可以省略）

services:
  web:
    image: nginx:1.28-alpine
    ports:
      - target: 80                   # 容器內的埠
        published: 8080              # 對外發布的埠
        protocol: tcp
        mode: ingress                # ingress 模式：啟用 routing mesh，打任一節點的 8080 都會被導到服務
    networks:
      - app-net
    deploy:                          # deploy：Swarm 專屬設定（docker stack deploy 才會完整生效）
      replicas: 3                    # 這個服務要跑 3 個副本（task）
      update_config:                 # 滾動更新策略（docker service update 時的行為）
        parallelism: 1               # 一次更新 1 個副本（降低同時失敗的風險）
        delay: 10s                   # 每批更新之間等 10 秒
        order: start-first           # 先啟動新副本、確認可用後再停舊副本（降低中斷；預設是 stop-first）
        failure_action: rollback     # 更新若失敗，自動回滾到舊版
      rollback_config:               # 回滾時的策略
        parallelism: 1
        delay: 5s
        order: stop-first            # 回滾時先停舊的再起，較保守
      restart_policy:
        condition: on-failure        # 只在非正常退出時重啟
        max_attempts: 3              # 最多重試 3 次
      resources:
        limits:                      # 上限：單副本最多用這麼多
          cpus: "0.50"
          memory: 256M
        reservations:                # 預留：排程時保證至少有這麼多資源才放上去
          cpus: "0.10"
          memory: 64M
      placement:
        constraints:
          - node.role == manager     # 限制只能排到 manager 節點（依需求也可改成 worker 或自訂 label）

  whoami:                            # 簡單的測試服務，會回傳自己的容器/請求資訊
    image: traefik/whoami:v1.10.1
    networks:
      - app-net
    deploy:
      replicas: 2
      restart_policy:
        condition: any               # 任何結束（含正常 exit 0）都重啟，維持常駐

networks:
  app-net:
    driver: overlay                  # overlay：跨節點的 Swarm 網路，讓不同主機上的容器能互通
    attachable: true                 # 允許非 stack 的獨立容器也能 docker network connect 進來（排錯方便）
```

### 13.5.2 部署 Stack

```bash
# 部署（不存在就建立，存在就更新）
docker stack deploy -c stack-demo.yml demo

# 查看 stack 清單
docker stack ls

# 查看此 stack 下的服務
docker stack services demo

# 查看此 stack 下所有 task
docker stack ps demo

# 補充：stack 內 service 命名規則是 <stack>_<service>
# 所以 web 服務會叫 demo_web，whoami 會叫 demo_whoami
docker service ls
```

`docker stack deploy` 讀的是和 Compose 相同格式的 YAML，但有幾個行為不同，從 Compose 搬過來時最常踩到：

- **不會讀 `.env`**：`${VAR}` 只會從目前 shell 的環境變數取值。要沿用 `.env`，先把它載入 shell：

  ```bash
  # set -a：之後定義的變數都自動 export；. ./.env：讀入 .env；set +a：關閉自動 export
  set -a; . ./.env; set +a
  docker stack deploy -c stack-demo.yml demo
  ```

- **忽略 `build`**：stack 只能用現成的映像。單機練習可以用本機建好的映像；多節點時，其他節點拉不到你本機的映像，必須先推到 Registry（第七章）。
- **忽略 `depends_on`**：服務啟動順序不受控制，程式要能自己重試連線，並靠 `restart_policy` 重啟（第四章 4.7 情境一的重試邏輯在這裡是必要的）。

### 13.5.3 驗證對外流量

```bash
# web 服務有發布 8080，應可從本機存取
curl -I http://127.0.0.1:8080

# 持續打幾次，觀察是否穩定（也可配合 service logs）
for i in 1 2 3 4 5; do curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080; done
```

---

## 13.6 Rolling Update 與 Rollback（重點）

### 13.6.1 升級映像（滾動更新）

```bash
# 把 demo_web 從 nginx:1.28-alpine 升級到 1.30-alpine
docker service update \
  --image nginx:1.30-alpine \
  --update-parallelism 1 \
  --update-delay 10s \
  demo_web

# 觀察更新中的 task 狀態變化
docker service ps demo_web

# 查看目前 service 設定摘要
docker service inspect --pretty demo_web
```

### 13.6.2 回滾

```bash
# 直接回滾到上一個版本
docker service update --rollback demo_web

# 驗證回滾後 task 狀態
docker service ps demo_web
```

> 實務建議：更新時把 `--update-parallelism` 設小一點（例如 1），可降低一次失敗影響面。

### 13.6.3 跟著做：用自己的映像做不停機更新

滾動更新能不能做到不中斷，關鍵在 Swarm 怎麼判斷「新的 task 已經可以接流量」：**有 healthcheck 時，task 要變成 healthy 才算啟動完成**；沒有 healthcheck 時，容器一啟動就算，程式其實可能還沒準備好。

這裡用第三章建立的 `hello-docker:v2`（JavaScript 版）與 `hello-docker:v3`（TypeScript 版）示範。單一節點的 Swarm 可以直接使用本機的映像。

```yaml
# hello-stack.yml
services:
  hello:
    image: hello-docker:${TAG:-v2}
    ports:
      - "3000:3000"
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/health"]
      interval: 5s
      timeout: 3s
      retries: 3
      start_period: 5s
    stop_grace_period: 20s             # 舊 task 收到 SIGTERM 後最多等 20 秒
    deploy:
      replicas: 2
      update_config:
        parallelism: 1                 # 一次換一個
        delay: 5s
        order: start-first             # 先起新的、healthy 後才停舊的
        failure_action: rollback       # 新版起不來就自動回滾
        monitor: 15s                   # 每個新 task 起來後再觀察 15 秒，這段期間失敗也算更新失敗
```

```bash
# 部署 v2
TAG=v2 docker stack deploy -c hello-stack.yml hello
docker service ls --filter name=hello_hello
# REPLICAS 2/2   IMAGE hello-docker:v2

# 終端機 A：持續送請求，只印出狀態碼
while true; do curl -s -o /dev/null -w '%{http_code} ' http://localhost:3000; sleep 0.1; done

# 終端機 B：更新成 v3
TAG=v3 docker stack deploy -c hello-stack.yml hello

# 觀察 task 逐一被替換
docker service ps hello_hello
# hello_hello.1   hello-docker:v3   Running
#  \_ hello_hello.1  hello-docker:v2   Shutdown
# hello_hello.2   hello-docker:v3   Running
#  \_ hello_hello.2  hello-docker:v2   Shutdown

# 練習結束
docker stack rm hello
```

終端機 A 從頭到尾都是 `200`（實測更新期間 402 個請求、0 個失敗）。和第十章 10.4 自己寫部署腳本相比，Swarm 把「先起新的、等 healthy、再停舊的、失敗就回滾」都內建了。

---

## 13.7 Secrets 實戰

Swarm Secret 適合存密碼、Token、私鑰等敏感資訊，避免直接寫死在映像或 YAML。

### 13.7.1 建立 Secret

```bash
# 建立 secret（從 stdin 讀取內容）
printf 'change_me_please\n' | docker secret create db_password -

# 查看 secret 清單
docker secret ls
```

### 13.7.2 把 Secret 掛到 Service

```bash
# 建立示範 service，將 db_password 掛到 /run/secrets/db_password
docker service create \
  --name secret-demo \
  --secret source=db_password,target=db_password,mode=0400 \
  alpine:3.24 \
  sh -c "while true; do sleep 3600; done"

# 查看 service task 狀態
docker service ps secret-demo
```

### 13.7.3 進容器檢查 Secret 檔案

```bash
# 找到 secret-demo 對應容器 ID（通常會回傳 1 筆）
docker ps --filter name=secret-demo

# 進入容器（請把 <container_id> 換成實際值）
docker exec -it <container_id> sh

# 容器內檢查（在容器 shell 執行）
ls -l /run/secrets
cat /run/secrets/db_password
exit
```

### 13.7.4 在 Stack 檔中使用 Secret

實務上會在 stack 檔宣告要用的 secret。`external: true` 表示 secret 已經用 `docker secret create` 建好，stack 只負責引用：

```yaml
# db-stack.yml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD_FILE: /run/secrets/db_password   # 官方映像的 _FILE 慣例（第九章 9.5）
    secrets:
      - db_password
    volumes:
      - pgdata:/var/lib/postgresql/data

secrets:
  db_password:
    external: true

volumes:
  pgdata:
```

```bash
docker stack deploy -c db-stack.yml dbdemo

# Swarm secret 在容器內是唯讀檔案（權限 0444），內容加密儲存在 manager 的 Raft 資料中
docker exec $(docker ps -q --filter name=dbdemo_db) ls -l /run/secrets/
# -r--r--r-- 1 root root 16 ... db_password

docker stack rm dbdemo
```

> Swarm secret 建立後內容就不能修改，也無法用指令讀回內容。要換密碼的做法是建立新名稱的 secret（例如 `db_password_v2`），更新 service 改用新的，再刪掉舊的。

### 13.7.5 清理 Secret 範例

```bash
# 先刪 service（有掛載 secret 的 service 還在時，secret 不能移除）
docker service rm secret-demo

# 再刪 secret
# 若出現 secret 'db_password' is in use by the following service: dbdemo_db，
# 代表 13.7.4 的 stack 還沒刪完，等幾秒再執行一次
docker secret rm db_password

# dbdemo stack 的資料 volume 不會隨 stack rm 刪除，要另外刪
docker volume rm dbdemo_pgdata
```

---

## 13.8 Node Label 與 Placement（排程控制）

當你有多節點時，通常會希望某些服務只跑在特定節點（例如 SSD 節點、GPU 節點）。

### 13.8.1 新增節點 Label

```bash
# 看節點列表
docker node ls

# 假設你要幫某節點加上 label: tier=app
# 請把 <node_id> 換成實際節點 ID
docker node update --label-add tier=app <node_id>

# 驗證 label 是否已寫入
docker node inspect <node_id> --pretty
```

### 13.8.2 用 Constraint 指定排程位置

```bash
# 建立 service，要求只能排到 node.labels.tier == app 的節點
docker service create \
  --name label-demo \
  --constraint 'node.labels.tier == app' \
  nginx:1.28-alpine

# 檢查 task 是否確實排在目標節點
docker service ps label-demo
```

### 13.8.3 清理 Label 範例

```bash
# 刪除示範 service
docker service rm label-demo

# 移除節點 label
docker node update --label-rm tier <node_id>
```

---

## 13.9 Compose 與 Stack 的重要差異（避免踩坑）

| 指令 | 主要用途 | 你要注意 |
|------|----------|----------|
| `docker compose up` | 單機/開發環境多容器管理 | 偏本機工作流 |
| `docker stack deploy` | Swarm 叢集部署 | 才會用到 Swarm 排程能力 |

同一份 YAML 交給兩個指令，各欄位的處理方式不同：

| 欄位 | `docker compose up` | `docker stack deploy` |
|------|------|------|
| `build` | 會建構 | **忽略**，只能用現成映像 |
| `depends_on` | 依順序／健康狀態啟動 | **忽略** |
| `.env` 變數替換 | 自動讀取 | **不讀**，要先載入 shell（13.5.2） |
| `container_name` | 使用 | 忽略 |
| `restart` | 使用 | 忽略，改用 `deploy.restart_policy` |
| `deploy.replicas` | 使用（啟動對應數量的容器） | 使用 |
| `deploy.resources` | 使用（CPU / 記憶體限制） | 使用 |
| `deploy.restart_policy` | 部分支援，單機建議用 `restart` | 使用 |
| `deploy.update_config` / `rollback_config` | **忽略**（單機沒有滾動更新） | 使用 |
| `deploy.placement` | **忽略** | 使用 |
| `secrets`（`file:`） | 以 bind mount 掛入檔案 | 建立成 Swarm secret（加密儲存） |

常見誤解：

1. 在 `docker-compose.yml` 寫了 `update_config`，就以為 `docker compose up -d` 換版時會滾動更新
   - 單機 Compose 會忽略它，換版時仍是先停舊容器再啟動新的（第十章 10.4）
2. 把 `compose up` 與 `stack deploy` 混著管理同一組服務  
   - 容易狀態混亂，建議一套資源固定一種管理方式

---

## 13.10 常用排錯指令（實戰清單）

```bash
# 看整體 service 狀態
docker service ls

# 看某 service 每個 task 的錯誤原因（排錯首選）
docker service ps <service-name> --no-trunc

# 看 service 設定（含 update/rollback/placement）
docker service inspect --pretty <service-name>

# 看 stack 層級狀態
docker stack services <stack-name>
docker stack ps <stack-name>

# 看 node 狀態（是否有 Down / Drain）
docker node ls

# 看 service 日誌（若 image 有輸出 stdout）
docker service logs -f <service-name>
```

常見問題快速判斷：

- `task` 一直 `Pending`：通常是 `placement constraints` 不符合，或節點資源不足
- `task` 一直重啟：先看 `docker service ps --no-trunc` 與 `docker service logs`
- 升級卡住：檢查 `update_config` 參數與新映像是否可拉取

---

## 13.11 清理練習環境

```bash
# 刪除 stack（會移除 stack 內所有 service/network）
docker stack rm demo

# 若還有獨立建立的 service，一併刪除
docker service rm web || true
docker service rm secret-demo || true
docker service rm label-demo || true

# 刪除自建 overlay 網路（若仍存在）
docker network rm app-overlay || true

# 離開 swarm（單機練習最常用）
docker swarm leave --force

# swarm init 時建立的 docker_gwbridge 網路，離開後不會自動刪除
docker network rm docker_gwbridge
```

---

## 13.12 本章小結

你已完成 Docker Swarm 最重要的實戰路徑：

- `swarm init/join`：建立或加入叢集
- `service`：用 CLI 管理副本、更新與擴縮
- `stack deploy`：用 YAML 管理整包應用
- `overlay network`：跨節點服務互通
- `rolling update / rollback`：安全升級與快速回復
- `secrets / placement`：敏感資訊管理與排程控制

如果你在團隊中同時有 Swarm 與 K8s 評估需求，建議：

1. 小型系統、低維運成本優先：Swarm 可快速上線
2. 多租戶、複雜平台化需求：K8s 擴展性更強
3. 不論哪套編排，都要優先建立監控、日誌、備份與回滾流程

---

> 上一章：[Kubernetes 實戰（Ingress + HPA + Requests/Limits + Probe + Helm）](./12-kubernetes-practice.md) | 回到 [課程目錄](./README.md)
