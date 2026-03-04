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
  nginx:1.25-alpine

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
```

---

## 13.5 用 Stack（YAML）管理完整應用（推薦）

CLI 建 service 很快，但實務上更建議把配置寫進檔案做版本管理。

### 13.5.1 建立 stack-demo.yml

```yaml
version: "3.9"

services:
  web:
    image: nginx:1.25-alpine
    ports:
      - target: 80
        published: 8080
        protocol: tcp
        mode: ingress
    networks:
      - app-net
    deploy:
      replicas: 3
      update_config:
        parallelism: 1
        delay: 10s
        order: start-first
        failure_action: rollback
      rollback_config:
        parallelism: 1
        delay: 5s
        order: stop-first
      restart_policy:
        condition: on-failure
        max_attempts: 3
      resources:
        limits:
          cpus: "0.50"
          memory: 256M
        reservations:
          cpus: "0.10"
          memory: 64M
      placement:
        constraints:
          - node.role == manager

  whoami:
    image: traefik/whoami:v1.10.1
    networks:
      - app-net
    deploy:
      replicas: 2
      restart_policy:
        condition: any

networks:
  app-net:
    driver: overlay
    attachable: true
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
# 把 demo_web 從 nginx:1.25-alpine 升級到 1.26-alpine
docker service update \
  --image nginx:1.26-alpine \
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
  alpine:3.20 \
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

### 13.7.4 清理 Secret 範例

```bash
# 先刪 service（有掛載 secret 的 service 還在時，secret 通常不能移除）
docker service rm secret-demo

# 再刪 secret
docker secret rm db_password
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
  nginx:1.25-alpine

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

常見誤解：

1. 在 `docker-compose.yml` 寫了 `deploy`，就以為 `docker compose up` 一定完整生效  
   - 事實上 `deploy` 多數設計給 Swarm（`docker stack deploy`）
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

> 上一章：[Kubernetes 實戰（Ingress + HPA + Requests/Limits + Probe + Helm）](./12-kubernetes-practice.md)
