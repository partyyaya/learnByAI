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

> 如果你的環境不是 minikube，通常會用 Helm 安裝 ingress-nginx 與 metrics-server，可參考 12.9.1 的命令。

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
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: k8s-practice
spec:
  replicas: 2
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: registry.k8s.io/hpa-example
          ports:
            - containerPort: 80
              name: http
          resources:
            # requests：排程時「至少要有」的資源
            requests:
              cpu: 100m
              memory: 128Mi
            # limits：容器「最多可用」的資源上限
            limits:
              cpu: 500m
              memory: 256Mi
          startupProbe:
            # 啟動探針：給冷啟動時間，避免剛啟動就被判定失敗
            httpGet:
              path: /
              port: http
            periodSeconds: 5
            failureThreshold: 30
          readinessProbe:
            # 就緒探針：通過才會加入 Service 流量池
            httpGet:
              path: /
              port: http
            initialDelaySeconds: 3
            periodSeconds: 5
            timeoutSeconds: 1
            failureThreshold: 3
          livenessProbe:
            # 存活探針：失敗太多次會觸發容器重啟
            httpGet:
              path: /
              port: http
            initialDelaySeconds: 10
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
  type: ClusterIP
  selector:
    app: web
  ports:
    - name: http
      port: 80
      targetPort: http
```

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
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web
  namespace: k8s-practice
spec:
  ingressClassName: nginx
  rules:
    - host: web.k8s.local
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web
                port:
                  number: 80
```

### 12.5.2 套用與驗證 Ingress

```bash
# 套用 Ingress 規則
kubectl apply -f 04-ingress.yaml

# 查看 Ingress 狀態（ADDRESS 可能要等幾秒）
kubectl -n k8s-practice get ingress web

# 取得 minikube IP（把流量打到該 IP）
MINIKUBE_IP=$(minikube ip)
echo "${MINIKUBE_IP}"

# 用 Host Header 模擬 DNS，驗證 Ingress 路由是否命中
curl -i -H "Host: web.k8s.local" "http://${MINIKUBE_IP}/"
```

> 如果你是雲端環境，通常會建立正式 DNS（例如 `web.example.com`）指向 Ingress/LB。

---

## 12.6 HPA 實戰（自動擴縮）

### 12.6.1 建立 HPA

`05-hpa.yaml`：

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: web
  namespace: k8s-practice
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: web
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 50
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

> HPA 不是即時毫秒級反應，會依 metrics 收集週期與穩定窗口延遲調整，這是正常現象。

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

# 安裝或更新 metrics-server（建立 kube-system namespace）
helm upgrade --install metrics-server metrics-server/metrics-server \
  --namespace kube-system \
  --create-namespace
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
replicaCount: 2

image:
  repository: registry.k8s.io/hpa-example
  pullPolicy: IfNotPresent
  tag: ""

service:
  type: ClusterIP
  port: 80

resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 256Mi

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
  enabled: true
  className: nginx
  annotations: {}
  hosts:
    - host: web.k8s.local
      paths:
        - path: /
          pathType: Prefix
  tls: []

autoscaling:
  enabled: true
  minReplicas: 2
  maxReplicas: 10
  targetCPUUtilizationPercentage: 50
```

### 12.9.4 補上 startupProbe 模板（若你的 chart 預設沒有）

在 `web/templates/deployment.yaml` 容器設定區塊加入：

```yaml
          {{- with .Values.startupProbe }}
          startupProbe:
            {{- toYaml . | nindent 12 }}
          {{- end }}
          {{- with .Values.livenessProbe }}
          livenessProbe:
            {{- toYaml . | nindent 12 }}
          {{- end }}
          {{- with .Values.readinessProbe }}
          readinessProbe:
            {{- toYaml . | nindent 12 }}
          {{- end }}
```

### 12.9.5 安裝、升級、回滾

```bash
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

> 延伸閱讀：[第十三章：Docker Swarm 實戰（Stack + Overlay + Secrets + Rolling Update）](./13-docker-swarm-practice.md)
