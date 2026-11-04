# 第十一章：Kubernetes 入門（從 Docker 到 K8s）

## 11.1 為什麼學 Kubernetes？

當服務從「單機幾個容器」成長到「多服務、多環境、多節點」時，只靠 `docker run` 或單機 `docker compose` 會開始吃力。  
Kubernetes（K8s）主要解決的是「大規模容器編排」問題。

### Docker 與 Kubernetes 的關係（重點）

- Docker：負責**建構映像**、**運行容器**（單機為主）。
- Kubernetes：負責**管理與調度容器**（多機叢集為主）。
- 實務上常見流程：`Dockerfile` 建映像 -> push 到 Registry -> Kubernetes 拉取並部署。

```
Docker（打包）        Registry（儲存）        Kubernetes（編排）
   build  ------->      push/pull  ------->      deploy / scale / heal
```

> Kubernetes 叢集裡實際執行容器的，通常**不是** Docker Engine，而是 containerd 或 CRI-O（Kubernetes 1.24 起移除了直接使用 Docker Engine 的 dockershim）。這不影響你用 Docker 建構的映像：映像格式是 OCI 標準，任何相容的執行環境都能跑。會受影響的只有「依賴 Docker daemon 本身」的做法，例如在 Pod 裡掛載 `/var/run/docker.sock`。

### 從 Compose 到 Kubernetes：概念對照

| Docker Compose | Kubernetes | 說明 |
|------|------|------|
| `services.api`（容器設定） | `Deployment`（裡面的 Pod 範本） | 要跑什麼映像、幾份副本 |
| `deploy.replicas` | `Deployment.spec.replicas` | 副本數 |
| 服務名稱 DNS（`db`） | `Service` | 穩定的名稱與入口，背後的 Pod 可以隨時替換 |
| `ports: "8080:80"` | `Service`（NodePort / LoadBalancer）或 `Ingress` | 對外開放 |
| `environment` / `env_file` | `ConfigMap` + `env` / `envFrom` | 非敏感設定 |
| `secrets` | `Secret` | 敏感設定 |
| named volume | `PersistentVolumeClaim` | 持久化儲存 |
| `healthcheck` | `livenessProbe` / `readinessProbe` / `startupProbe` | 健康檢查（第十二章） |
| `restart: always` | Pod 的 `restartPolicy: Always`（Deployment 預設） | 自動重啟 |
| `deploy.resources.limits` | `resources.limits` / `requests` | 資源限制（第十二章） |
| `depends_on` | 沒有直接對應 | 程式要自己重試連線，或用 initContainer 等待 |

---

## 11.2 Kubernetes 核心概念

| 物件 | 用途 | 你可以怎麼理解 |
|------|------|----------------|
| `Pod` | 最小部署單位（可含 1+ 容器） | 一個應用執行實例 |
| `Deployment` | 管理 Pod 副本、滾動更新、回滾 | 「我要跑幾份、怎麼升級」 |
| `Service` | 提供穩定存取入口（ClusterIP/NodePort/LB） | Pod 的固定門牌 |
| `ConfigMap` | 存非敏感設定 | `.env` 類設定 |
| `Secret` | 存敏感資料（密碼、Token） | 機敏設定 |
| `Namespace` | 邏輯隔離資源 | 分專案/環境 |

---

## 11.3 本機練習環境（minikube）

以下用 macOS + Docker Desktop + minikube 作為入門環境（minikube 的叢集本身跑在一個 Docker 容器裡）。

```bash
# 安裝 kubectl（Kubernetes CLI）
brew install kubectl

# 驗證 kubectl（只看 client 版本）
kubectl version --client

# 安裝 minikube（本機 K8s 叢集）
brew install minikube

# 啟動本機叢集
# --driver=docker: 用 Docker 當底層 driver
# --cpus / --memory: 指定給叢集的資源
minikube start --driver=docker --cpus=2 --memory=4096

# 查看叢集 API 與元件資訊
kubectl cluster-info

# 查看節點狀態
# -o wide: 顯示更多欄位（IP、OS、Runtime）
kubectl get nodes -o wide
```

> 若公司環境已有 K8s 叢集，只要把 `kubectl` 指向該叢集 context 即可，不一定要用 minikube。
>
> 另一個常見的本機選擇是 [kind](https://kind.sigs.k8s.io/)（Kubernetes in Docker）：`brew install kind` 後執行 `kind create cluster`，同樣是在 Docker 容器裡跑一個叢集。本章的 `kubectl` 指令兩者通用，只有 `minikube` 開頭的指令要換成 kind 的對應做法（文中會註明）。

---

## 11.4 第一個 Kubernetes 部署（指令版）

```bash
# 建立 namespace（避免都塞在 default）
kubectl create namespace demo

# 在 demo namespace 建立 Deployment
# -n demo: 指定 namespace
# --image: 指定容器映像
# 注意：用這個指令建立時，容器名稱會依映像名稱自動取為 nginx
kubectl -n demo create deployment web --image=nginx:1.28-alpine

# 查看 Deployment / Pod
kubectl -n demo get deployment
kubectl -n demo get pods -o wide

# 把 Deployment 暴露成 Service
# --port: Service 對外服務埠
# --target-port: Pod 內容器埠
# --type=ClusterIP: 僅叢集內可達（預設型態）
kubectl -n demo expose deployment web --port=80 --target-port=80 --type=ClusterIP

# 查看 Service
kubectl -n demo get svc

# 本機轉發（把本機 8080 轉到 service/web 的 80）
kubectl -n demo port-forward service/web 8080:80
```

在另一個終端驗證：

```bash
# 驗證服務回應（應可看到 HTTP/1.1 200 OK）
curl -I http://127.0.0.1:8080
```

---

## 11.5 用 YAML 管理（推薦做法）

實務上通常不用長指令直接建資源，而是把設定寫成 YAML 交給 Git 管理。

跟著做之前，先刪掉 11.4 用指令建立的同名資源：

```bash
kubectl -n demo delete deployment web
kubectl -n demo delete service web
```

> 若不刪就直接 `kubectl apply` 下面的 YAML，Kubernetes 會把 YAML 合併到既有的 Deployment：YAML 的容器叫 `web`，原本指令建立的容器叫 `nginx`，合併後同一個 Pod 裡有兩個 nginx 容器搶 80 埠，其中一個會不斷出錯重啟。同一個資源固定用一種方式管理（全用指令或全用 YAML），就不會遇到這種狀況。

在練習目錄建立 YAML 檔：

```bash
mkdir -p ~/docker-practice/k8s-basics && cd ~/docker-practice/k8s-basics
```

### deployment.yaml（範例）

```yaml
apiVersion: apps/v1          # 此資源使用的 API 群組/版本（Deployment 屬於 apps/v1）
kind: Deployment             # 資源類型：Deployment（管理一組 Pod 副本與滾動更新）
metadata:
  name: web                  # 這個 Deployment 的名稱
  namespace: demo            # 放在哪個 namespace（邏輯隔離）
spec:                        # spec：描述「期望狀態」，K8s 會持續讓現況趨近於此
  replicas: 2                # 期望跑 2 份 Pod 副本
  selector:
    matchLabels:
      app: web               # 這個 Deployment 管理「帶有 app=web 標籤」的 Pod
  template:                  # template：要建立的 Pod 長什麼樣子（Pod 範本）
    metadata:
      labels:
        app: web             # Pod 會被貼上這個標籤；必須對得上上面的 selector.matchLabels
    spec:                    # Pod 的規格
      containers:            # 一個 Pod 可含多個容器，這裡只有一個
        - name: web          # 容器名稱
          image: nginx:1.28-alpine  # 使用的映像
          ports:
            - containerPort: 80      # 宣告容器監聽 80（資訊用途，方便閱讀與工具識別）
```

### service.yaml（範例）

```yaml
apiVersion: v1               # Service 屬於核心群組，版本是 v1
kind: Service                # 資源類型：Service（提供一個穩定的存取入口給會變動的 Pod）
metadata:
  name: web                  # Service 名稱；同 namespace 內可用這個名稱當 DNS 連線
  namespace: demo
spec:
  selector:
    app: web                 # 用標籤選出要導流的 Pod（對上 Deployment 的 app=web）
  ports:
    - port: 80               # Service 對外提供的埠（其他服務連 web:80 時的這個 80）
      targetPort: 80         # 實際轉發到 Pod 容器的埠（可與 port 不同）
      protocol: TCP
  type: ClusterIP            # 服務型態：僅叢集內可達（最常見的內部服務型態）
```

套用與檢查：

```bash
# 套用 Deployment 定義
kubectl apply -f deployment.yaml

# 套用 Service 定義
kubectl apply -f service.yaml

# 檢視目前資源
kubectl -n demo get deployment,pod,svc

# 查看完整 YAML（實際生效內容）
kubectl -n demo get deployment web -o yaml
```

---

## 11.6 更新與回滾（Deployment 的核心價值）

```bash
# 更新映像版本（deployment/web 中容器 web 的 image）
# 語法：set image deployment/<name> <container>=<image>
# 容器名稱 web 來自 11.5 的 YAML（containers[].name）
kubectl -n demo set image deployment/web web=nginx:1.30-alpine

# 追蹤滾動更新狀態
kubectl -n demo rollout status deployment/web

# 查看 rollout 歷史版本
kubectl -n demo rollout history deployment/web

# 回滾到上一版
kubectl -n demo rollout undo deployment/web
```

---

## 11.7 設定管理：ConfigMap 與 Secret

```bash
# 建立 ConfigMap（非敏感設定）
kubectl -n demo create configmap app-config \
  --from-literal=APP_ENV=production \
  --from-literal=LOG_LEVEL=info

# 建立 Secret（敏感資訊）
kubectl -n demo create secret generic app-secret \
  --from-literal=DB_PASSWORD='change_me'

# 查看 ConfigMap
kubectl -n demo get configmap app-config -o yaml

# 查看 Secret（內容會是 base64 編碼，不是明文）
kubectl -n demo get secret app-secret -o yaml
```

> 注意：Secret 預設只是 base64 編碼，不等於加密。正式環境建議搭配 KMS / External Secret 管理。

### 在 Pod 中使用 ConfigMap 與 Secret

建立了 ConfigMap / Secret 之後，還要在 Pod 範本裡指定「怎麼交給容器」。下一節部署自己的映像時會一起示範，常見的三種方式：

```yaml
      containers:
        - name: hello
          # 1. envFrom：ConfigMap 裡的每個 key 都變成一個環境變數（對應 Compose 的 env_file）
          envFrom:
            - configMapRef:
                name: app-config
          # 2. env + valueFrom：只挑某個 key 變成環境變數，可改名
          env:
            - name: DB_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: app-secret
                  key: DB_PASSWORD
          # 3. 掛成檔案：每個 key 變成一個檔案（對應 Compose secrets 的 /run/secrets/...）
          volumeMounts:
            - name: secret-files
              mountPath: /run/secrets/app
              readOnly: true
      volumes:
        - name: secret-files
          secret:
            secretName: app-secret
```

> ConfigMap / Secret 改了之後，**環境變數不會自動更新**，要重啟 Pod 才會讀到新值（`kubectl -n demo rollout restart deployment/<名稱>`）；掛成檔案的方式則會在一段時間後自動更新檔案內容。

---

## 11.8 部署自己建構的映像

前面都用 Docker Hub 上的 nginx。換成第三章自己建構的 `hello-docker:v3` 時，要先解決「叢集拿不到映像」的問題：映像在你本機的 Docker 裡，叢集的節點（minikube / kind 的容器）看不到。

做法有兩種：

- **推到 Registry**（正式做法）：推到 GHCR / ECR 等（第七章），叢集從 Registry 拉取。私有 Registry 要另外建立 `imagePullSecrets` 給叢集登入資訊。
- **直接載入本機叢集**（本機練習）：

```bash
# minikube
minikube image load hello-docker:v3

# kind
kind load docker-image hello-docker:v3
```

建立 `hello.yaml`（使用上一節建立的 `app-config` 與 `app-secret`）：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hello
  namespace: demo
spec:
  replicas: 2
  selector:
    matchLabels:
      app: hello
  template:
    metadata:
      labels:
        app: hello
    spec:
      containers:
        - name: hello
          image: hello-docker:v3
          # 映像是載入的，不要去 Registry 拉
          # （預設值：標籤是 latest 時為 Always，其他為 IfNotPresent）
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 3000
          envFrom:
            - configMapRef:
                name: app-config
          env:
            - name: DB_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: app-secret
                  key: DB_PASSWORD
          volumeMounts:
            - name: secret-files
              mountPath: /run/secrets/app
              readOnly: true
          readinessProbe:              # 對應 Dockerfile 的 HEALTHCHECK（第十二章詳細說明）
            httpGet:
              path: /health
              port: 3000
      volumes:
        - name: secret-files
          secret:
            secretName: app-secret
---
apiVersion: v1
kind: Service
metadata:
  name: hello
  namespace: demo
spec:
  selector:
    app: hello
  ports:
    - port: 80
      targetPort: 3000
```

```bash
kubectl apply -f hello.yaml
kubectl -n demo rollout status deployment/hello

# 確認設定有進到容器
POD=$(kubectl -n demo get pod -l app=hello -o jsonpath='{.items[0].metadata.name}')
kubectl -n demo exec $POD -- sh -c 'env | grep -E "APP_ENV|LOG_LEVEL|DB_PASSWORD"; cat /run/secrets/app/DB_PASSWORD'
# APP_ENV=production
# LOG_LEVEL=info
# DB_PASSWORD=change_me
# change_me

# 透過 Service 呼叫（hostname 是 Pod 名稱，多呼叫幾次會看到兩個副本輪流回應）
kubectl -n demo port-forward service/hello 8081:80
# 另一個終端：curl http://127.0.0.1:8081
# {"message":"Hello from Docker","hostname":"hello-7f7d6bd9d6-tf2md","env":"production"}
```

> 若 Pod 卡在 `ErrImagePull` / `ImagePullBackOff`：確認映像有載入（`minikube image ls | grep hello`），並確認 `imagePullPolicy` 不是 `Always`。`Always` 會強制去 Docker Hub 找 `hello-docker`，當然找不到。

---

## 11.9 常用排錯指令（非常實用）

```bash
# 看 Pod 狀態（是否 CrashLoopBackOff / Pending）
kubectl -n demo get pods

# 看 Pod 詳細事件（排錯首選）
kubectl -n demo describe pod <pod-name>

# 看容器日誌
# -f: 持續追蹤
kubectl -n demo logs -f <pod-name>

# 若 Pod 內有多容器，需指定容器名稱
kubectl -n demo logs -f <pod-name> -c <container-name>

# 進容器互動除錯
# -it: 互動式終端
kubectl -n demo exec -it <pod-name> -- sh

# 查看 namespace 近期事件（按時間排序）
kubectl -n demo get events --sort-by=.metadata.creationTimestamp

# 容器裡沒有除錯工具時：加掛一個臨時的除錯容器（對應第八章 8.3 的共用 namespace 做法）
# --target：共用指定容器的行程 namespace，看得到它的行程
kubectl -n demo debug -it <pod-name> --image=busybox:1.36 --target=hello -- sh
# 在除錯容器內：ps、wget -qO- http://127.0.0.1:3000/health
```

---

## 11.10 對外存取方式（入門版）

### 方式 A：`port-forward`（本機開發最常用）

```bash
# 本機 8080 -> service/web 80
kubectl -n demo port-forward service/web 8080:80
```

### 方式 B：`NodePort`（測試環境常見）

```bash
# 把 service 改成 NodePort
kubectl -n demo patch svc web -p '{"spec":{"type":"NodePort"}}'

# 查看分配到的 NodePort
kubectl -n demo get svc web

# 若使用 minikube，可快速打開服務
# macOS 的 Docker driver 下，minikube 會建立一條通道並印出 http://127.0.0.1:<port>，這個終端機要保持開著
minikube service web -n demo
```

> 使用 kind 時，叢集節點的 NodePort 沒有直接對應到主機，本機練習請用方式 A 的 `port-forward`。

---

## 11.11 清理練習資源

```bash
# 刪除整個 demo namespace（裡面資源會一起刪除）
kubectl delete namespace demo

# 停止 minikube（保留資料）
minikube stop

# 刪除 minikube 叢集（清空本機練習環境）
minikube delete
```

---

## 11.12 什麼時候該用 Kubernetes？

適合使用 K8s 的情境：

- 多服務、多環境（dev/stage/prod）需要一致部署流程
- 需要自動擴縮、滾動更新、回滾、服務發現
- 團隊已進入平台化 / SRE 化管理

不一定要立刻用 K8s 的情境：

- 單機、少量服務、部署頻率低
- 團隊尚未建立 CI/CD 與基礎監控
- 維運人力不足，先把 Docker + Compose 穩定化更務實

---

## 11.13 Docker 學完後的 K8s 學習順序建議

1. 先熟 `kubectl` 基本操作（get/describe/logs/apply）
2. 再熟 Deployment / Service / ConfigMap / Secret
3. 接著學 Ingress、HPA、Resource requests/limits、Probe
4. 最後再進階到 Helm、GitOps、Observability（Prometheus/Grafana）

> 上一章：[生產環境部署與 CI/CD](./10-production-cicd.md) | 下一章：[第十二章：Kubernetes 實戰（Ingress + HPA + Requests/Limits + Probe + Helm）](./12-kubernetes-practice.md)
