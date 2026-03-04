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

以下用 macOS + Docker Desktop + minikube 作為入門環境。

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

---

## 11.4 第一個 Kubernetes 部署（指令版）

```bash
# 建立 namespace（避免都塞在 default）
kubectl create namespace demo

# 在 demo namespace 建立 Deployment
# -n demo: 指定 namespace
# --image: 指定容器映像
kubectl -n demo create deployment web --image=nginx:1.25-alpine

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

### deployment.yaml（範例）

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: demo
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
          image: nginx:1.25-alpine
          ports:
            - containerPort: 80
```

### service.yaml（範例）

```yaml
apiVersion: v1
kind: Service
metadata:
  name: web
  namespace: demo
spec:
  selector:
    app: web
  ports:
    - port: 80
      targetPort: 80
      protocol: TCP
  type: ClusterIP
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
kubectl -n demo set image deployment/web web=nginx:1.26-alpine

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

---

## 11.8 常用排錯指令（非常實用）

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
```

---

## 11.9 對外存取方式（入門版）

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
minikube service web -n demo
```

---

## 11.10 清理練習資源

```bash
# 刪除整個 demo namespace（裡面資源會一起刪除）
kubectl delete namespace demo

# 停止 minikube（保留資料）
minikube stop

# 刪除 minikube 叢集（清空本機練習環境）
minikube delete
```

---

## 11.11 什麼時候該用 Kubernetes？

適合使用 K8s 的情境：

- 多服務、多環境（dev/stage/prod）需要一致部署流程
- 需要自動擴縮、滾動更新、回滾、服務發現
- 團隊已進入平台化 / SRE 化管理

不一定要立刻用 K8s 的情境：

- 單機、少量服務、部署頻率低
- 團隊尚未建立 CI/CD 與基礎監控
- 維運人力不足，先把 Docker + Compose 穩定化更務實

---

## 11.12 Docker 學完後的 K8s 學習順序建議

1. 先熟 `kubectl` 基本操作（get/describe/logs/apply）
2. 再熟 Deployment / Service / ConfigMap / Secret
3. 接著學 Ingress、HPA、Resource requests/limits、Probe
4. 最後再進階到 Helm、GitOps、Observability（Prometheus/Grafana）

> 你目前這套 Docker 課程已打好基礎（Image、Dockerfile、Compose、CI/CD）。補上這章後，正好可以銜接 K8s 實務。

> 下一章：[第十二章：Kubernetes 實戰（Ingress + HPA + Requests/Limits + Probe + Helm）](./12-kubernetes-practice.md)
