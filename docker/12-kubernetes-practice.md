# 第十二章：Kubernetes 實戰（Ingress + HPA + Requests/Limits + Probe + Helm）

## 12.1 本章目標

這章會帶你做一套「接近真實上線」的 Kubernetes 練習，完成以下 5 件事：

1. 用 `Ingress` 讓 HTTP 流量由入口統一進來
2. 用 `HPA`（HorizontalPodAutoscaler）根據 CPU 自動擴縮
3. 在容器設定 `requests / limits`，讓排程與資源使用可控
4. 加上 `startupProbe / readinessProbe / livenessProbe`，提升穩定性
5. 用 `Helm` 把部署流程模板化，具備升級與回滾能力

---

## 12.2 實戰架構（先看全貌）

```text
Browser / curl
      |
      v
   Ingress  (HTTP 入口、Host/Path 路由)
      |
      v
   Service  (ClusterIP 服務入口)
      |
      v
Deployment (replicas=N)
  ├─ Pod A (requests/limits + probes)
  ├─ Pod B (requests/limits + probes)
  └─ Pod C ...
      ^
      |
HPA 讀取 metrics-server 的 CPU 指標，自動調整 replicas
```

---

## 12.3 前置環境準備

本章以 **minikube** 當示範環境（你若是 EKS/GKE/AKS 也能套用同概念）。

### 12.3.1 檢查 CLI 工具

```bash
# 檢查 kubectl 是否可用（顯示 client 版本）
kubectl version --client

# 檢查 Helm 是否可用（顯示 Helm 版本）
helm version

# 檢查目前 kubectl context 指向哪個叢集
kubectl config current-context

# 檢查叢集節點是否 Ready
kubectl get nodes -o wide
```

### 12.3.2 minikube 啟用必要元件（Ingress + Metrics）

```bash
# 啟用 Ingress Controller（Nginx）
minikube addons enable ingress

# 啟用 metrics-server（HPA 需要）
minikube addons enable metrics-server

# 確認 Ingress Controller Pod 正常
kubectl -n ingress-nginx get pods

# 確認 metrics-server Pod 正常
kubectl -n kube-system get pods | grep metrics-server
```

> 如果你的環境不是 minikube，通常會用 Helm 安裝 Ingress Controller 與 metrics-server，可參考 12.9.1 的命令。

> **關於 ingress-nginx**：minikube 的 `ingress` addon 使用的是社群的 ingress-nginx。Kubernetes 官方已宣布 ingress-nginx 在 2026 年 3 月停止維護（之後不再有版本與安全修補，既有安裝仍可運作）。本章用它學習 Ingress 的概念沒有問題：Ingress 這個 API 本身沒有被淘汰，換成其他 Ingress Controller（例如 Traefik、HAProxy、各雲端供應商的 Controller）時，本章的 Ingress YAML 幾乎不用改。新的正式環境建議評估 Ingress 的後繼標準 **Gateway API**。

---

## 12.4 建立練習空間與基礎資源

### 12.4.1 建立練習目錄與 Namespace

```bash
# 建立本章專用目錄，集中放 YAML
mkdir -p ~/k8s-practice && cd ~/k8s-practice

# 建立 namespace YAML（方便版本控管）
cat > 01-namespace.yaml <<'EOF'
apiVersion: v1
kind: Namespace
metadata:
  name: k8s-practice
EOF

# 套用 namespace
kubectl apply -f 01-namespace.yaml

# 驗證 namespace 是否建立成功
kubectl get namespace k8s-practice
```

### 12.4.2 建立 Deployment（含 Requests/Limits + Probe）

`02-deployment.yaml`：

```yaml
apiVersion: apps/v1          # Deployment 屬於 apps/v1
kind: Deployment
metadata:
  name: web
  namespace: k8s-practice
spec:
  replicas: 2                # 期望的 Pod 副本數（之後交給 HPA 自動調整）
  selector:
    matchLabels:
      app: web               # 這個 Deployment 管理帶 app=web 標籤的 Pod
  template:                  # 要建立的 Pod 範本
    metadata:
      labels:
        app: web             # Pod 標籤，需對上上面的 selector
    spec:
      containers:
        - name: web
          image: registry.k8s.io/hpa-example  # K8s 官方提供、會吃 CPU 的示範映像（方便測 HPA；只有 latest 標籤）
          ports:
            - containerPort: 80
              name: http     # 幫這個埠取名 http，後面 Service/Probe 可用名稱引用（埠號改了也不用改多處）
          resources:
            # requests：排程時「至少要有」的資源（K8s 用它決定 Pod 放哪個節點；也是 HPA 計算使用率的分母）
            requests:
              cpu: 100m       # 100m = 0.1 顆 CPU（m 是 millicore，1000m = 1 核）
              memory: 128Mi
            # limits：容器「最多可用」的資源上限（CPU 超過會被限速；記憶體超過會被 OOMKilled）
            limits:
              cpu: 500m
              memory: 256Mi
          startupProbe:
            # 啟動探針：給冷啟動時間，通過前不會跑 readiness/liveness，避免啟動慢的程式被誤殺
            httpGet:
              path: /         # 對容器發 HTTP GET /
              port: http      # 用上面命名的 http 埠
            periodSeconds: 5        # 每 5 秒探一次
            failureThreshold: 30    # 最多容忍 30 次失敗（≈ 5×30=150 秒的啟動緩衝）
          readinessProbe:
            # 就緒探針：通過才會被加入 Service 的流量池；失敗會「暫停送流量」但不重啟
            httpGet:
              path: /
              port: http
            initialDelaySeconds: 3  # 容器起來後等 3 秒才開始探
            periodSeconds: 5
            timeoutSeconds: 1       # 單次探測逾時 1 秒
            failureThreshold: 3     # 連續 3 次失敗才判定為「未就緒」
          livenessProbe:
            # 存活探針：判斷「程式是否還活著」，連續失敗會「重啟容器」
            httpGet:
              path: /
              port: http
            initialDelaySeconds: 10 # 給比 readiness 更長的緩衝，避免啟動期就重啟
            periodSeconds: 10
            timeoutSeconds: 1
            failureThreshold: 3
```

### 12.4.3 建立 Service

`03-service.yaml`：

```yaml
apiVersion: v1
kind: Service
metadata:
  name: web
  namespace: k8s-practice
spec:
  type: ClusterIP            # 叢集內部入口（之後由 Ingress 從外部接進來）
  selector:
    app: web                 # 把流量導向帶 app=web 標籤的 Pod
  ports:
    - name: http
      port: 80               # Service 對外提供的埠
      targetPort: http       # 轉發到 Pod 容器名為 http 的埠（即 Deployment 裡的 containerPort 80）
```

> `hpa-example` 是一個 PHP + Apache 的映像，每次請求 `/` 都會做大量運算來消耗 CPU。它只有 amd64 版本，在 Apple Silicon（arm64）上會透過模擬執行，第一次拉取與每次請求都比較慢，屬於正常現象。

### 12.4.4 套用與驗證

```bash
# 套用 Deployment
kubectl apply -f 02-deployment.yaml

# 套用 Service
kubectl apply -f 03-service.yaml

# 查看主要資源狀態
kubectl -n k8s-practice get deploy,pod,svc -o wide

# 檢查 Pod 的 requests/limits 實際配置
kubectl -n k8s-practice get pod -l app=web \
  -o jsonpath='{.items[0].spec.containers[0].resources}'
echo

# 查看探針事件（排錯很重要）
kubectl -n k8s-practice describe pod -l app=web
```

---

## 12.5 Ingress 實戰（統一入口）

### 12.5.1 建立 Ingress

`04-ingress.yaml`：

```yaml
apiVersion: networking.k8s.io/v1   # Ingress 屬於 networking.k8s.io/v1
kind: Ingress                      # Ingress：HTTP(S) 的 L7 入口，依 Host/Path 把外部流量導到不同 Service
metadata:
  name: web
  namespace: k8s-practice
spec:
  ingressClassName: nginx          # 由哪個 Ingress Controller 處理（這裡是 ingress-nginx）
  rules:
    - host: web.k8s.local          # 比對請求的 Host 標頭；只有這個網域的請求才套用以下規則
      http:
        paths:
          - path: /                # 比對路徑（這裡是所有路徑）
            pathType: Prefix       # 比對方式：前綴比對（/ 會匹配所有路徑）
            backend:
              service:
                name: web          # 轉發到名為 web 的 Service
                port:
                  number: 80       # 轉發到 Service 的 80 埠
```

### 12.5.2 套用與驗證 Ingress

```bash
# 套用 Ingress 規則
kubectl apply -f 04-ingress.yaml

# 查看 Ingress 狀態（ADDRESS 可能要等幾秒）
kubectl -n k8s-practice get ingress web
```

連到 Ingress 的方式依作業系統而不同：

**Linux（minikube 的 docker driver）**：minikube 的 IP 從主機可以直接連到。

```bash
# 取得 minikube IP（把流量打到該 IP）
MINIKUBE_IP=$(minikube ip)
echo "${MINIKUBE_IP}"

# 用 Host Header 模擬 DNS，驗證 Ingress 路由是否命中
curl -i -H "Host: web.k8s.local" "http://${MINIKUBE_IP}/"
```

**macOS / Windows（Docker Desktop + docker driver）**：minikube 的節點在 Docker Desktop 的 VM 裡，`minikube ip` 回傳的位址從主機**連不到**，curl 會一直逾時。要另開一個終端機執行 `minikube tunnel`，把 Ingress 對應到本機的 127.0.0.1：

```bash
# 終端機 A：建立通道（會要求輸入密碼以綁定 80/443 埠；這個終端機要保持開著）
minikube tunnel

# 終端機 B：改打 127.0.0.1
curl -i -H "Host: web.k8s.local" http://127.0.0.1/
```

> 如果你是雲端環境，通常會建立正式 DNS（例如 `web.example.com`）指向 Ingress/LB。

---

## 12.6 HPA 實戰（自動擴縮）

### 12.6.1 建立 HPA

`05-hpa.yaml`：

```yaml
apiVersion: autoscaling/v2         # HPA v2 才支援多種指標來源
kind: HorizontalPodAutoscaler      # HPA：依指標自動增減 Pod 副本數（水平擴縮）
metadata:
  name: web
  namespace: k8s-practice
spec:
  scaleTargetRef:                  # 要自動擴縮「哪個」工作負載
    apiVersion: apps/v1
    kind: Deployment
    name: web                      # 對應前面建立的 web Deployment
  minReplicas: 2                   # 副本數下限（再閒也至少留 2 份）
  maxReplicas: 10                  # 副本數上限（再忙也不超過 10 份）
  metrics:
    - type: Resource               # 以資源用量當擴縮依據
      resource:
        name: cpu                  # 看 CPU
        target:
          type: Utilization        # 以「使用率」判斷（相對於 requests.cpu 的百分比）
          averageUtilization: 50   # 目標：所有 Pod 平均 CPU 維持在 50%，超過就擴容、低於就縮容
```

### 12.6.2 套用並觀察 HPA

```bash
# 套用 HPA
kubectl apply -f 05-hpa.yaml

# 檢查 HPA 當前狀態（TARGETS 欄位要有 CPU 指標）
kubectl -n k8s-practice get hpa

# 檢查 metrics-server 是否有提供 Pod 指標
kubectl -n k8s-practice top pods
```

### 12.6.3 製造流量，觸發擴容

先開一個終端觀察擴縮：

```bash
# 持續觀察 HPA（看到 replicas 變化）
kubectl -n k8s-practice get hpa -w
```

再開另一個終端做壓測：

```bash
# 建立負載 Pod，不斷請求 Service（提升 CPU 使用率）
kubectl -n k8s-practice run loadgen \
  --image=busybox:1.36 \
  --restart=Never \
  -- /bin/sh -c "while true; do wget -q -O- http://web > /dev/null; done"

# 觀察 Pod 數量是否上升（可在第 3 個終端執行）
kubectl -n k8s-practice get pods -w
```

停止壓測並觀察縮容：

```bash
# 刪除壓測 Pod，讓 CPU 回落
kubectl -n k8s-practice delete pod loadgen

# 再看一次 HPA（通常 1~5 分鐘內逐步縮回）
kubectl -n k8s-practice get hpa
```

> HPA 不是即時毫秒級反應，會依 metrics 收集週期與穩定窗口延遲調整，這是正常現象。擴容通常 1～2 分鐘內就會看到（實測在 1 分鐘內從 2 份擴到上限 10 份）；縮容預設有 5 分鐘的穩定窗口，避免流量忽高忽低時副本數來回震盪。

> HPA 接手之後，副本數由 HPA 決定。若之後又 `kubectl apply -f 02-deployment.yaml`，檔案裡的 `replicas: 2` 會把副本數瞬間改回 2，HPA 再慢慢調回去，造成不必要的縮放。實務上交給 HPA 管理的 Deployment，YAML 裡通常不寫 `replicas`（`helm create` 產生的模板在 `autoscaling.enabled: true` 時也會自動省略這個欄位）。

---

## 12.7 Requests/Limits 調校重點

`requests / limits` 不是「隨便填」，建議用以下原則：

| 欄位 | 用途 | 實戰建議 |
|------|------|----------|
| `requests.cpu` | Pod 排程的 CPU 最低需求 | 先用觀測值 P95 再加 10~30% buffer |
| `limits.cpu` | 單容器 CPU 上限 | 避免單 Pod 吃光節點 |
| `requests.memory` | Pod 排程的記憶體最低需求 | 參考常態使用量，不可太低 |
| `limits.memory` | 單容器記憶體上限 | 過低會 OOMKilled，過高會浪費 |

實務常用觀察指令：

```bash
# 看節點資源使用，判斷叢集是否接近飽和
kubectl top nodes

# 看工作負載目前資源使用
kubectl -n k8s-practice top pods

# 看 Pod 最近事件（是否被 OOMKill、是否探針失敗）
kubectl -n k8s-practice describe pod -l app=web
```

---

## 12.8 Probe 驗證演練（故障注入）

以下示範「readiness 探針錯誤」會發生什麼事。

### 12.8.1 將 readinessProbe 路徑改成錯誤值

```bash
# 把 readinessProbe 路徑從 "/" 改成 "/not-ready"（故意製造失敗）
kubectl -n k8s-practice patch deployment web \
  --type='json' \
  -p='[{"op":"replace","path":"/spec/template/spec/containers/0/readinessProbe/httpGet/path","value":"/not-ready"}]'

# 觀察 Pod Ready 狀態（通常會變成 0/1）
kubectl -n k8s-practice get pods -l app=web -w
```

### 12.8.2 觀察 Service Endpoints 變化

```bash
# Ready 失敗的 Pod 不會出現在 Endpoints 中
kubectl -n k8s-practice get endpoints web -w
```

### 12.8.3 回滾到上一版

```bash
# 回滾 Deployment 到上個修訂版
kubectl -n k8s-practice rollout undo deployment/web

# 確認 rollout 完成
kubectl -n k8s-practice rollout status deployment/web
```

> 重點：`readinessProbe` 失敗不一定會重啟容器，但會停止接流量；`livenessProbe` 連續失敗才會重啟容器。

---

## 12.9 Helm 實戰（把部署模板化）

上面你已用 YAML 跑通一次，接著改用 Helm 管理，目標是：

- 統一不同環境參數（dev/stage/prod）
- 一行命令做 install/upgrade/rollback
- 減少重複 YAML 維護成本

### 12.9.1 用 Helm 安裝常見控制器（非 minikube 可用）

```bash
# 加入 ingress-nginx chart 倉庫
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx

# 加入 metrics-server chart 倉庫
helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/

# 更新本機 chart 索引
helm repo update

# 安裝或更新 ingress-nginx（建立 ingress-nginx namespace）
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --create-namespace

# 安裝或更新 metrics-server（kube-system namespace 叢集本來就有）
# 本機叢集（kind 等）的 kubelet 使用自簽憑證，要加 --kubelet-insecure-tls，否則 metrics-server 抓不到指標
helm upgrade --install metrics-server metrics-server/metrics-server \
  --namespace kube-system \
  --set 'args={--kubelet-insecure-tls}'
```

### 12.9.2 建立應用 Chart

```bash
# 回到練習根目錄
cd ~/k8s-practice

# 建立 Helm chart（會產生 web 目錄）
helm create web

# 先檢查 chart 結構是否正常
helm lint ./web
```

### 12.9.3 設定 values.yaml（啟用 Ingress/HPA/Resources/Probe）

把 `web/values.yaml` 重要區段改成以下內容：

```yaml
# values.yaml：Helm chart 的「預設參數」；不同環境可用 -f 或 --set 覆寫這些值
# 模板（templates/*.yaml）會用 .Values.xxx 讀到這裡的設定
replicaCount: 2              # 對應 Deployment 的 replicas

image:
  repository: registry.k8s.io/hpa-example  # 映像名稱（不含 tag）
  pullPolicy: IfNotPresent   # 拉取策略：本機已有就不重抓
  # 一定要明確寫出 tag：留空時模板會改用 Chart.yaml 的 appVersion（helm create 預設是 "1.16.0"），
  # 變成 hpa-example:1.16.0 這個不存在的映像，Pod 會卡在 ImagePullBackOff
  tag: "latest"

service:
  type: ClusterIP            # Service 型態
  port: 80                   # Service 對外埠

resources:                   # 帶進容器的 requests/limits（語意同前面 Deployment 的說明）
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 256Mi

# 三種探針的設定（會被下方模板用 toYaml 整段套進容器設定）
startupProbe:
  httpGet:
    path: /
    port: http
  periodSeconds: 5
  failureThreshold: 30

livenessProbe:
  httpGet:
    path: /
    port: http
  periodSeconds: 10
  timeoutSeconds: 1
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /
    port: http
  periodSeconds: 5
  timeoutSeconds: 1
  failureThreshold: 3

ingress:
  enabled: true              # 是否建立 Ingress（chart 模板會依此決定要不要產生）
  className: nginx           # 對應 ingressClassName
  annotations: {}            # 額外註解（如 cert-manager、流量設定），這裡留空
  hosts:
    - host: web.k8s.local    # 對外網域
      paths:
        - path: /
          pathType: Prefix
  tls: []                    # TLS 設定（空陣列＝先不啟用 HTTPS）

autoscaling:
  enabled: true              # 是否建立 HPA
  minReplicas: 2
  maxReplicas: 10
  targetCPUUtilizationPercentage: 50  # 目標平均 CPU 使用率（同 HPA 的 averageUtilization）
```

### 12.9.4 補上 startupProbe 模板

`helm create` 產生的 `web/templates/deployment.yaml` 已經有 `livenessProbe` 與 `readinessProbe` 的區塊，但沒有 `startupProbe`。打開檔案找到這兩行：

```yaml
          {{- with .Values.livenessProbe }}
          livenessProbe:
```

在它們**正上方**加入（只加 startupProbe 這一段；若把 liveness / readiness 也再貼一次，產生的 YAML 會有重複的欄位）：

```yaml
          {{- with .Values.startupProbe }}
          startupProbe:
            {{- toYaml . | nindent 12 }}
          {{- end }}
```

這段是 Helm 的 Go 模板語法，逐項拆解：

- `{{ ... }}`：模板指令；前綴的 `-`（如 `{{-`）會「吃掉左邊的空白與換行」，避免渲染出多餘空行。
- `{{- with .Values.startupProbe }} ... {{- end }}`：**條件式 + 切換作用域**。只有當 `values.yaml` 有設定 `startupProbe` 時才產生這段；在 `with` 區塊內，`.` 就代表 `.Values.startupProbe` 本身。
- `toYaml .`：把 `.`（這裡是 probe 的整個物件）轉回 YAML 字串，省得逐欄位手寫。
- `| nindent 12`：用管線把上一步的 YAML 結果，每行縮排 12 個空白（n＝先換行再縮排），讓它正好對齊 `startupProbe:` 底下的層級。

> 一句話：「如果 values 有設這個 probe，就把它整段轉成 YAML、縮排對齊後填進來」。這也是為什麼只要改 `values.yaml` 就能調整探針，不必動模板。

### 12.9.5 安裝、升級、回滾

Helm 只管理「自己安裝的資源」。12.4～12.6 用 `kubectl apply` 建立的 `web` Deployment、Service、Ingress、HPA 還在 `k8s-practice` 裡，名稱又和這個 release 會產生的資源相同，直接安裝會出現：

```
Error: ... Deployment "web" in namespace "k8s-practice" exists and cannot be imported into the current release: invalid ownership metadata
```

所以先刪掉這些資源，再交給 Helm 管理：

```bash
cd ~/k8s-practice
kubectl delete -f 05-hpa.yaml -f 04-ingress.yaml -f 03-service.yaml -f 02-deployment.yaml
```

```bash
# 只看渲染結果（不連線叢集、不套用），確認 startupProbe、image tag 都正確
helm template web ./web | grep -E 'image:|startupProbe' 

# 先做 dry-run，確認渲染結果正確（不會真的套用）
helm upgrade --install web ./web \
  --namespace k8s-practice \
  --create-namespace \
  --dry-run

# 正式安裝或升級 release
helm upgrade --install web ./web \
  --namespace k8s-practice \
  --create-namespace

# 查看 release 清單
helm list -n k8s-practice

# 查看 release 歷史版本（revision）
helm history web -n k8s-practice

# 如升級有問題，回滾到前一個 revision（例：回滾到 1）
helm rollback web 1 -n k8s-practice
```

> 實務建議：同一批資源請固定使用同一套工具管理（要嘛都 `kubectl apply`，要嘛都 Helm），避免狀態漂移。

---

## 12.10 常用排錯指令清單（實戰版）

```bash
# 一次看核心資源狀態
kubectl -n k8s-practice get deploy,rs,pod,svc,ingress,hpa

# 看 Deployment 事件（排程失敗、探針失敗、拉鏡像失敗等）
kubectl -n k8s-practice describe deployment web

# 看 Pod 事件與探針訊息
kubectl -n k8s-practice describe pod -l app=web

# 看應用日誌（若多 Pod 可先用 get pods 找名稱）
kubectl -n k8s-practice logs <pod-name>

# 持續追日誌（線上除錯常用）
kubectl -n k8s-practice logs -f <pod-name>

# 看 namespace 的時間序事件（定位問題非常有效）
kubectl -n k8s-practice get events --sort-by=.metadata.creationTimestamp
```

---

## 12.11 常見問題與處理

### 問題 1：Ingress 一直 404 / 無回應

檢查順序：

1. `kubectl -n ingress-nginx get pods` 是否 Running
2. `kubectl -n k8s-practice get ingress web -o yaml` 的 `host/path` 是否正確
3. `curl` 是否有帶 `Host` Header（本機最常漏）
4. Service selector 與 Pod label 是否一致

### 問題 2：HPA 的 TARGETS 顯示 `<unknown>`

通常是 metrics-server 尚未就緒或讀不到指標：

```bash
# 檢查 metrics-server 是否正常
kubectl -n kube-system get pods | grep metrics-server

# 檢查是否能拿到 Pod 指標
kubectl -n k8s-practice top pods
```

### 問題 3：Pod 反覆重啟

可能是 `livenessProbe` 太嚴格或 `limits.memory` 太小：

```bash
# 先看 Pod 事件，是否 Liveness probe failed / OOMKilled
kubectl -n k8s-practice describe pod <pod-name>
```

---

## 12.12 清理練習資源

如果你用 `kubectl apply` 套了本章 YAML：

```bash
# 刪除整個練習 namespace（最乾淨）
kubectl delete namespace k8s-practice
```

如果你用 Helm 安裝了 release：

```bash
# 先刪除 Helm release
helm uninstall web -n k8s-practice

# 再刪除 namespace
kubectl delete namespace k8s-practice
```

---

## 12.13 本章小結

你已經把 Kubernetes 最常用的 5 個生產核心能力串起來了：

- `Ingress`：統一路由入口，接住外部流量
- `HPA`：依 CPU 自動擴縮，降低人工介入
- `requests/limits`：讓資源可預期、可治理
- `startup/readiness/liveness probe`：提高部署穩定性與可用性
- `Helm`：把部署流程標準化，支援升級與回滾

下一步可以往這些方向走：

1. TLS 與憑證自動化（cert-manager + Let's Encrypt）
2. 觀測性（Prometheus + Grafana + Loki）
3. GitOps（Argo CD / Flux）
4. Progressive Delivery（Canary / Blue-Green）

> 上一章：[Kubernetes 入門（從 Docker 到 K8s）](./11-kubernetes-basics.md) | 延伸閱讀：[第十三章：Docker Swarm 實戰（Stack + Overlay + Secrets + Rolling Update）](./13-docker-swarm-practice.md)
