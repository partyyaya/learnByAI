# 第 08 章：基礎設施選型：Spring Cloud 還是 K8s 原生

> **上一章**：[第 07 章](07-distributed-tracing-and-observability.md)讓一個 traceId 穿過 HTTP 與 RabbitMQ，用一次演練走完「告警 → exemplar → trace → 日誌」。那一次演練，兩個服務、Jaeger、Prometheus 都在同一台筆電上，靠三個寫死的位址找到彼此：訂單服務的 `shop.deployment.inventory.url`、演練用 `prometheus.yml` 裡的 `host.docker.internal:埠`、`SHOP_OTLP_ENDPOINT`。
>
> **這一章**：基礎設施。服務發現、負載平衡、設定管理、閘道這四件事，Spring Cloud 與 K8s 原生各有一套答案（8.3）。先量現在的樣子：庫存服務多開一台（8.2）。然後把兩個服務搬到本機的 K8s（kind，8.4），一件一件量：
>
> - 服務發現：訂單服務只認一個 Service 的名字；一台卡住時，多久不再收到請求（8.5）
> - 負載平衡：kube-proxy 在「建立連線」的時候挑 pod；擴容之後新的 pod 多久分到請求（8.6）
> - 設定：ConfigMap 改了之後多久生效（8.7）
> - 閘道：Gateway API 當入口；trace 從入口開始、誰決定 traceId；入口後面的「每個 IP」；兩層閘道各自重試（8.8）
> - 觀測：Prometheus 自己找 target；Jaeger 的資料放在哪裡（8.9）
> - 服務網格：sidecar 預設的重試、它的成本（8.10）
>
> 最後寫成一份選型文件（8.11，README 產出第 5 項）。
>
> **你手上會有**：從 `d07` 開出來的分支 `d08`。正式程式碼只改了三處：
>
> - `RateLimitFilter`：自己的另一個服務不算進「每個 IP 每秒 50 次」（8.6.3）。
> - `TraceFilters`：部署打開 `shop.deployment.edge.trust-traceparent` 時，`/api/**` 接上入口帶來的 `traceparent`（8.8.2）。
> - 第 12 站的通知：認領改成租約（V35，[第 12 站 7.7.2 的追記](../12-capstone/07-event-driven-order-flow.md)）。
>
> 其他都是部署：
>
> - `k8s/`：`base`（兩個服務、Service、外部依賴、ConfigMap 與 Secret、NetworkPolicy）、`migrate`（Flyway 的 Job）、`kind`（這台筆電的差別）、`gateway`（Gateway API）、`observability`（Collector、Jaeger v2、Prometheus）；`scripts/d08-kind.sh`。
> - 告警多一條 `ShopServiceGone`（8.9.1）。
> - 實驗：I1、K0～K11；`lab/scg`（實驗用的 Spring Cloud Gateway）。
>
> 測試 368 個，failsafe 契約驗證 39 個。
>
> **這一章的實測事故**：
>
> - **庫存服務多開一台，新的那一台一個請求都沒收到**（8.2）：A 收到 150 個預留、B 0 個。停掉 A 之後的 75 秒，375 張下單 338 張 503，B 還是 0；演練用的 Prometheus 叫醒人的是 `ShopDown{inventory-service}`：「庫存服務掛了」。換位址就要重啟訂單服務：15.5 秒。
> - **K8s 上擴成 3 台，新的 pod 要等 30～40 秒才分到第一個預留**（8.6.1）：kube-proxy 在建立連線時挑 pod，訂單服務重用連線；之後 10 秒一格看，常常是一台拿全部。
> - **入口會接著買家給的 traceId 往下記**（8.8.2）：100 個帶著自己 `traceparent` 的請求，入口抽到的 12 個 trace 全部用了買家給的 traceId。訂單服務一信任入口，100 個 `X-Trace-Id` 全部是買家給的。
> - **入口後面，「每個 IP 每秒 50 次」變成全站共用一個額度**（8.8.3）：每秒 80 個請求、250 個不同的買家，581 個 429 —— 限流的 key 只有一個 IP，是入口的。
> - **兩層閘道各自加了重試**（8.8.4）：10 個會 503 的 GET，訂單服務收到 80 次（一個 8 次），買家拿到的是 504：外層先放棄了，裡面還在重試。
> - **庫存服務縮到 0 台，第 12 站的 `ShopDown` 不會響**（8.9.1）：被刪掉的 pod 不是「抓不到」，是從 target 裡消失了。
> - **之後**：
>   - 一台庫存服務卡住（不是死掉），11 秒後不在 endpoints 裡；這段時間的下單全部成功，卡住那一刻的幾張多花 1 秒左右（8.5.2）。
>   - 改一個設定：掛成檔案的 ConfigMap 53 秒後在 pod 裡變了，應用程式不知道；`rollout restart` 20.7 秒、0 個錯誤（8.7.1）。
>   - 入口拿掉買家的 trace header、訂單服務信任入口、NetworkPolicy 讓只有入口連得到：入口抽到的 trace 全部接上訂單與庫存；付款那一條「入口 → 訂單服務 → MQ → 庫存服務」是一棵樹（8.8.2，README 產出第 4 項）。
>   - 新的告警 `ShopServiceGone` 在縮到 0 台之後 105 秒 firing（8.9.1）。
>
> **⚠️ 寫這一章途中被自己的實驗抓到的**：
>
> - **庫存服務對訂單服務限流**（8.6.3）：每秒 40 張下單時，庫存服務回了 40 個 429，`RemoteInventoryApi` 把它當成「我們的錯」，買家拿到 500。第 03 章切開之後就有這個 bug；第 03～07 章的實驗都關掉限流起服務，看不到。
> - **Prometheus 的權限放錯了 namespace**（8.9.1）：`kustomization.yaml` 的 `namespace` 把 Role 也搬到了 `observability`，Prometheus 的日誌一直是 forbidden，target 是空的。
> - **K4 第一版卡住了閒著的那一台**（8.5.2）：只錯了 1 張，看起來好像沒事。改成卡住「這一刻訂單服務連著的那一台」。
> - **K2 第一版從訂單服務那一邊數連線**（8.6.1）：從那裡看，對方是 Service 的 ClusterIP，分不出是哪一個 pod，每一格都是 0。
> - **實驗用的 Spring Cloud Gateway 起得來，第一個請求就 `NoSuchMethodError`**（8.8.4）：Spring Cloud 2023.0.6 要的 Spring Framework 比 Boot 3.2.5 帶的新。
> - **K6 第一版用 `curl --parallel --rate`**（8.8.3）：`--rate` 沒有作用，1,600 個請求幾秒內送完、100 個失敗。
>
> **小坑**：
>
> - **kubectl 與 cluster 的版本**（8.4.1）：這台筆電的 kubectl 是 1.34，kind v0.33 預設的 node 是 1.37 —— 差 3 個 minor，超過支援的 ±1。Envoy Gateway 1.9 又只支援到 1.36：node 換成 1.36、kubectl 換成 1.37。
> - **Jaeger v2 沒有 `/api/services`、`/api/traces?service=`**（8.4.5）：要用 `/api/v3`；只有 `/api/traces/{id}` 還在。
> - **在容器裡對 PID 1 送 `SIGSTOP`，`kill` 回 0，行程照樣在跑**（8.5.2）：要從 node 送。
> - **`kubectl apply` 不會拿掉 `kubectl patch` 加上去的欄位**（8.7.1）：last-applied 裡沒有它們。
> - **JDK HttpClient 自己會重送兩種**（8.6.4）：連不上（`ConnectException`）不分方法重連一次；池裡的連線已經被對方關了，只重送 GET、HEAD。
>
> **這一章沒有達成、或只達成一部分的目標**：
>
> - **Spring Cloud 那一欄大部分沒有量**：只有 Spring Cloud Gateway 真的跑過（8.8.4）；Eureka、Spring Cloud LoadBalancer、Config Server 用的是官方文件的預設值，標成「沒有量」。
> - **只有一個 node**：kube-proxy 在別台更新得慢、跨 node 的負載平衡都沒有量；preStop 在這裡量不出差別（8.6.4），不代表多 node 也一樣。（📌 第 09 章寫完之後的追記：三個 node 量了，8.6.6。）
> - **正式環境的「入口前面那一層」是模擬的**（8.8.3）：用 cluster 裡的一個 pod 扮演雲端的負載平衡器。
> - **尾端抽樣還是沒有做**（8.9.2）：Collector 已經在 span 的路上，抽樣的規則沒有寫。（📌 第 09 章寫完之後的追記：第 07 章 7.8.4。）
> - **Jaeger 只有一台**（8.9.3）：Badger 不能多台；Elasticsearch、OpenSearch、Cassandra 都沒有做。
> - **服務網格只量了預設的重試與成本**（8.10）：mTLS、每一個請求的負載平衡沒有量；量完就拿掉了。
> - **compose 上，單體停掉會叫醒人兩次**（8.9.1）：`ShopDown` 與 `ShopServiceGone` 一起響。Alertmanager 的抑制還是沒有設（第 07 章 7.11 的那一條）。（📌 第 09 章寫完之後的追記：抑制設了，第 07 章 7.11.1。）
> - **部署的順序靠一支腳本**（8.4.5）：設定 → migration → 應用程式；沒有 GitOps、沒有 CD。（📌 第 09 章寫完之後的追記：GitOps（Flux）做了，8.4.6。）
> - **第 07 章的演練沒有在 K8s 上重跑**。

---

## 8.1 學習目標

讀完這一章，你應該能：

- 說出服務發現、負載平衡、設定管理、閘道這四件事各在解決什麼問題，以及 Spring Cloud 與 K8s 原生各用什麼解：前者是應用程式裡的函式庫，後者是平台。
- 說出 Netflix 那一套（Eureka、Ribbon、Zuul、Hystrix）怎麼來、怎麼退場，今天還留下什麼。
- 把兩個服務部署到 K8s：Deployment、Service、探針、ConfigMap 與 Secret、migration 的 Job、外部依賴，以及它們的順序。
- 說出 K8s 的 Service 怎麼分請求（每一條連線挑一次），量出它對擴容的影響，並判斷什麼時候需要「每一個請求挑一次」。
- 決定設定怎麼改、多久生效，以及 Config Server 值不值得。
- 在服務前面放一個入口（Gateway API），並且說出入口進來之後要重想的三件事：trace 從哪裡開始、誰決定 traceId、「每個 IP」數的是誰。
- 說出兩層閘道、服務網格各自預設會不會重送，把它們算進第 06 章的乘法。
- 為這個專案寫一份選型文件：選哪個、換過去要付出什麼、什麼時候兩套混用。

---

## 8.2 先看見痛：庫存服務多開一台 ★★★

### 8.2.0 開分支

```bash
git switch -c d08 d07
```

這一章的第一個 commit 只有一個實驗（I1），正式程式碼還是第 07 章的。第 07 章的實驗工具（`Node`、`Calls`、`Keys`、`Prom`、`Jaeger`）改成 `public`，這一章的實驗在自己的套件（`dist08`）裡用它們。

### 8.2.1 實驗怎麼做（I1）

三個子 JVM（第 07 章 7.11 的 `Node`：管理埠、JSON 日誌、OTLP）：

- 庫存服務 A、B：同一個庫、同一個 vhost。
- 訂單服務：`shop.deployment.inventory.url` 指向 A —— 跟第 07 章演練時一樣，只有一個位址。

演練用的 Prometheus 照第 07 章的寫法，一個 job 一個寫死的位址；庫存服務那一個是 A 的管理埠。每秒 5 張下單（開放式負載），分三段：

1. 兩台都在，30 秒：A、B 各收到幾個預留（各自管理埠上的 `http_server_requests`）。
2. 停掉 A（B 還在），75 秒：下單的狀態碼、熔斷器、Prometheus 的 target 與告警。
3. 人工換位址：訂單服務用 B 的位址重啟。多久才又能下單、這段時間的下單怎麼樣。

```java
        try (ConfigurableApplicationContext keys = Keys.start();
             Node b = Node.inventory("i1-inventory-b", B_PORT, B_MGMT, common);
             Prom prom = Prom.start(new TreeMap<>(Map.of("order-service", ORDER_MGMT, "inventory-service", A_MGMT)))) {
            a = Node.inventory("i1-inventory-a", A_PORT, A_MGMT, common);
            order = Node.order("i1-order", ORDER_PORT, ORDER_MGMT, A_PORT, common);
```

（完整的 `I1MoreInventoryTest` 在 8.13.1。）

### 8.2.2 結果

```
═══ 8.2 庫存服務多開一台：A（18811）、B（18813），訂單服務的 shop.deployment.inventory.url = http://127.0.0.1:18811；每秒 5 張下單（load { 4.93 4.68 4.89 }）═══
  演練用的 Prometheus 的 target：[inventory-service up, order-service up]
  暖機之後：A 收到預留 300 個、B 0 個
  時間軸（每 5 秒問一次 Prometheus 的告警）：
    第  30 秒 ── 停掉 A（7,287 ms 結束）；B 還在
    第  45 秒    訂單服務的熔斷器 inventory-reserve：open
    第  50 秒 ShopDown{inventory-service} pending
    第  75 秒 ShopHigh5xxRatio pending
    第 105 秒    訂單服務呼叫預留的結果（shop_remote_call，A 停掉之後）：{breaker=306, no_response=32, ok=37}
    第 105 秒 ── 人工換位址：停掉訂單服務（8,151 ms），用 http://127.0.0.1:18813 重啟
    第 120 秒 ── 訂單服務 ready（停掉之後 15,458 ms）
    第 120 秒 ShopDown{inventory-service} firing
    第 120 秒 ShopDown{order-service} pending
    第 125 秒 ShopDown{order-service} 解除
    第 150 秒 ShopHigh5xxRatio 解除
  Prometheus 的 target（結束時）：[inventory-service down（Get "http://host.docker.internal:18812/actuator/prometheus": dial tcp 192.168.65.254:18812: connect: connection refused）, order-service up]
  ① 兩台都在   │  30.0 秒 │ 下單 {201=150}（-1 = 連不上訂單服務）
  ② A 停了   │  75.0 秒 │ 下單 {201=37, 503=338}（-1 = 連不上訂單服務）
     重啟中   │  15.5 秒 │ 下單 {-1=38, 201=2, 503=38}（-1 = 連不上訂單服務）
  ③ 換成 B   │  29.8 秒 │ 下單 {201=149}（-1 = 連不上訂單服務）
  到 ① 結束：A 收到預留 150 個、B 0 個
  到 ② 結束：A 收到預留 （停了）、B 0 個
  到 ③ 結束：A 收到預留 （停了）、B 151 個
  （結束時 load { 4.23 4.59 4.81 }）
```

- **① 兩台都在**：A 收到 150 個預留、B 0 個。B 起來了、ready 了，可是沒有人知道它。
- **② 停掉 A**：375 張下單，201 只有 37 張（A 還在關機的那 7.3 秒），338 張 503。預留呼叫的結果（第 07 章 7.7.1 的 `shop.remote.call`）：熔斷器擋下 306 次、沒有回應 32 次、成功 37 次。熔斷器在第 45 秒打開（第 06 章 6.7），之後大部分的下單根本沒有送出去，立刻 503 —— 它保護了訂單服務，救不了下單：另一台好好的庫存服務就在旁邊，熔斷器不知道它。
- **Prometheus**：`ShopDown{inventory-service}` 第 50 秒 pending，第 120 秒問到的時候已經 firing（重啟訂單服務的那 15 秒沒有問）。值班的人收到「庫存服務掛了」—— 只對了一半：A 掛了，B 好好的，只是沒有人送請求給它，Prometheus 也看不見它。
- **③ 人工換位址**：停掉訂單服務花了 8.2 秒，用 B 的位址起來、ready，一共 15.5 秒。這段時間 38 張連不上訂單服務、38 張 503（它正在關機）、2 張成功。之後 149 張全部成功，B 收到 151 個預留。

換一個位址要重啟一個服務，這一次是人工、半夜、15 秒的停機。

### 8.2.3 三個寫死的位址，四件事

第 07 章 7.16 列了三個寫死的位址。I1 把其中兩個的代價量出來了：

| 寫死的位址 | 多一台、少一台的時候 | 這一章的哪一件事 |
|---|---|---|
| 訂單服務的 `shop.deployment.inventory.url` | B 一個請求都沒有；A 一停，就是一次事故；換位址 = 重啟 | 服務發現（8.5）、負載平衡（8.6）、設定（8.7） |
| 演練用 Prometheus 的 `host.docker.internal:埠` | 看不見 B；A 停掉之後叫醒人的是「庫存服務掛了」—— 可是 B 好好的 | 觀測（8.9） |
| `SHOP_OTLP_ENDPOINT` | 在同一台筆電上沒有壞（兩台都送 `localhost:4318`）；換一台機器才壞 —— 這裡沒有量 | 觀測（8.9.2） |

還有第四件事，I1 沒有碰到，因為這條線上沒有它：**閘道**。買家直接打訂單服務的埠。第 07 章 7.16 說 README 產出第 4 項的「Gateway → 訂單 → MQ → 庫存」還缺 gateway —— 入口一進來，第 12 站 9.8.4 那一句「外面帶進來的 traceparent 一律不收」就要重想（8.8.2）。

這四件事，在單體的時代都不需要回答：一個行程，沒有「另一台」。

---

## 8.3 四件事、兩套答案

### 8.3.1 四件事各是什麼問題

| 這件事 | 要回答的問題 | I1 裡缺的那一塊 |
|---|---|---|
| 服務發現 | 庫存服務**現在**在哪幾台？誰告訴訂單服務？多一台、死一台，多久知道？ | 訂單服務只知道 A |
| 負載平衡 | 幾台之中，**這一個**請求送哪一台？ | 永遠是 A |
| 設定管理 | 設定放在哪裡？改了之後，怎麼、多久生效？ | 改位址 = 重啟 |
| 閘道 | 外面的請求從哪裡進來？進來的那一刻做什麼（路由、TLS、限流、trace 的起點）？ | 沒有入口 |

### 8.3.2 Spring Cloud 那一套，與 Netflix 的歷史

Spring Cloud 的答案是**函式庫**：每一件事都是應用程式裡的一段程式碼，跟著應用程式一起部署、一起升級。

| 這件事 | 今天的 Spring Cloud | 原本的 Netflix 版本 |
|---|---|---|
| 服務發現 | Eureka（Spring Cloud Netflix 還在維護）、Consul、Zookeeper、Spring Cloud Kubernetes | Eureka |
| 負載平衡 | Spring Cloud LoadBalancer：在呼叫端，每一個請求挑一次（預設輪流） | Ribbon |
| 設定 | Spring Cloud Config Server（Git 當來源），加上 Spring Cloud Bus 通知「重讀」 | Archaius |
| 閘道 | Spring Cloud Gateway（WebFlux 版與 WebMVC 版） | Zuul 1 |
| 熔斷 | Spring Cloud CircuitBreaker（底下是 Resilience4j） | Hystrix |

Netflix 在 2012 年前後把它內部用的這幾樣開源，Spring Cloud Netflix 把它們包成 starter —— 那幾年的「微服務」幾乎就等於這一套。後來的事：

- **2018 年底，Spring Cloud Greenwich**：Hystrix、Ribbon、Zuul 1、Archaius 進入維護模式（不再加功能，只修嚴重的 bug 與安全問題）；**Eureka 不在其中**。替代品是 Resilience4j、Spring Cloud LoadBalancer、Spring Cloud Gateway。（Spring 官方部落格：<https://spring.io/blog/2018/12/12/spring-cloud-greenwich-rc1-available-now>）
- **2020 年底，Spring Cloud 2020.0（Ilford）**：ribbon、hystrix、zuul 的支援從整個 release train 拿掉。（release notes：<https://github.com/spring-cloud/spring-cloud-release/wiki/Spring-Cloud-2020.0-Release-Notes>）

這個專案從第 06 章起用的熔斷器，就是 Hystrix 的接班人 Resilience4j —— 直接用，沒有經過 Spring Cloud CircuitBreaker（第 06 章 6.7）。

Spring Cloud 是一個 release train，**每一版綁定 Spring Boot 的版本**（官方的對照：<https://github.com/spring-cloud/spring-cloud-release/wiki/Supported-Versions>）：

| Spring Cloud | Spring Boot |
|---|---|
| 2025.1（Oakwood） | 4.0.x |
| 2025.0（Northfields） | 3.5.x |
| 2024.0（Moorgate） | 3.4.x |
| 2023.0（Leyton） | 3.3.x、3.2.x |

這個專案是 Boot 3.2.5，能用的是 2023.0。8.8.4 會量到這個「綁定」的另一面：同一個 2023.0，最新的那一個 patch 在 Boot 3.2.5 上起得來、第一個請求就壞。

### 8.3.3 K8s 原生那一套

K8s 的答案是**平台**：應用程式什麼都不用加，四件事由叢集做。

| 這件事 | K8s 原生 |
|---|---|
| 服務發現 | Service：一個穩定的名字（DNS）與一個虛擬 IP（ClusterIP）；後面有哪些 pod，記在 EndpointSlice，由探針決定誰算數 |
| 負載平衡 | kube-proxy：在每一台 node 上，把送往 ClusterIP 的**連線**轉給其中一個 pod |
| 設定 | ConfigMap、Secret：變成環境變數或掛成檔案 |
| 閘道 | Ingress（舊）、Gateway API（新）：叢集的入口，由一個控制器實作（Envoy Gateway、NGINX Gateway Fabric、Istio……） |

Ingress 最常見的實作是 ingress-nginx。它在 2025 年 11 月宣布退役，2026 年 3 月之後不再有任何 release、修補與安全更新；官方建議的方向是 Gateway API（Kubernetes 部落格：<https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/>）。這一章的入口用 Gateway API，實作選 Envoy Gateway（8.8.1）。

**服務網格**（Istio、Linkerd……）是在這之上的另一層：每一個 pod 旁邊一個代理（sidecar），服務之間的每一個請求都經過它 —— 負載平衡變成「每一個請求挑一次」，加上 mTLS、重試、遙測（8.10）。

### 8.3.4 這一章怎麼比

這個專案要跑在 K8s 上（02-spring-boot/08 的那一套），所以 K8s 那一欄是**真的部署、真的量**：本機的 kind（一個 Docker 容器就是一個 node），一個 node。

Spring Cloud 那一欄只有一樣真的跑過：Spring Cloud Gateway（8.8.4），因為 README 的誤區點名了它。Eureka、Spring Cloud LoadBalancer、Config Server 都沒有部署，用的是官方文件的預設值，表格裡標成「文件，沒有量」。

---

## 8.4 搬到 K8s：kind 上的兩個服務

這一節只是「搬過去」：同一個 jar、同一個映像檔（第 12 站 9.3 的 Dockerfile），兩個角色各一個 Deployment。MySQL、Redis、RabbitMQ 留在 cluster 外面（compose 的那一組），正式環境通常也是這樣：資料庫是託管的服務。

### 8.4.1 一個 node 的 cluster

```yaml
# 13 站第 08 章：本機的 K8s（kind：一個 Docker 容器就是一個 node）。
#   kind create cluster --config k8s/kind/cluster.yaml
# 只開一個 node：這一章要看的是服務之間怎麼找到彼此、請求怎麼分，不是排程。extraPortMappings 讓這台筆電連得到 cluster 裡的 NodePort
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: d08
nodes:
  - role: control-plane
    # 1.36：Envoy Gateway v1.9 支援到 1.36、Istio 1.31 支援 1.32～1.37 —— 兩個都要用，取交集（kind v0.33 預設是 1.37）
    image: kindest/node:v1.36.4@sha256:099e049362a1526b2db71494e1947aae99bd16290d7c895f2b7ea312e3cbfaed
    extraPortMappings:
      - {containerPort: 30080, hostPort: 18880}   # 入口（k8s/gateway 的 Envoy）
      - {containerPort: 30090, hostPort: 18890}   # Prometheus
      - {containerPort: 30686, hostPort: 18886}   # Jaeger 的查詢
```

版本是這一節第一個卡住的地方：

- kind v0.33 預設的 node 是 Kubernetes 1.37；這台筆電的 kubectl 是 1.34。kubectl 只支援跟 cluster 差 ±1 個 minor，`kubectl version` 會印一行警告。
- 入口用的 Envoy Gateway 1.9 支援 Kubernetes 1.33～1.36；8.10 要用的 Istio 1.31 支援 1.32～1.37。交集是 1.36：node 換成 `kindest/node:v1.36.4`，kubectl 換成 1.37（跟 1.36 差 1 個）。

Spring Cloud 綁 Spring Boot 的版本（8.3.2），平台這一邊一樣有自己的對照表要對：cluster、kubectl、入口的控制器、網格。

### 8.4.2 Deployment 與 Service

庫存服務：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: inventory-service
  labels: {app: inventory-service, system: shop}
spec:
  replicas: 2
  selector:
    matchLabels: {app: inventory-service}
  strategy:
    type: RollingUpdate
    rollingUpdate: {maxSurge: 1, maxUnavailable: 0}    # 02-spring-boot/08 的 ⑭：先多起一台、ready 了才關舊的
  template:
    metadata:
      labels: {app: inventory-service, system: shop}    # system=shop：Prometheus 認這個標籤（7.9.2），不認名字
    spec:
      terminationGracePeriodSeconds: 40                  # preStop 10 秒 + 應用程式關機最多 20 秒（timeout-per-shutdown-phase）+ 餘裕
      containers:
        - name: app
          image: shop:latest
          envFrom:
            - configMapRef: {name: shop-common}
            - configMapRef: {name: inventory-service}
            - secretRef: {name: shop-secrets}
          ports:
            - {name: http, containerPort: 8080}
            - {name: management, containerPort: 8081}
          startupProbe:
            httpGet: {path: /actuator/health/liveness, port: management}
            periodSeconds: 2
            failureThreshold: 90
          readinessProbe:                                # 不 ready → 從 Service 的 endpoints 拿掉，訂單服務的請求不再送來
            httpGet: {path: /actuator/health/readiness, port: management}
            periodSeconds: 5
            failureThreshold: 2
          livenessProbe:
            httpGet: {path: /actuator/health/liveness, port: management}
            periodSeconds: 10
            failureThreshold: 3
          lifecycle:
            preStop:
              sleep: {seconds: 10}                       # 02-spring-boot/08 8.7：先等 endpoints 拿掉這一台，再開始關機
          resources:
            requests: {cpu: 250m, memory: 640Mi}
            limits: {memory: 640Mi}
---
apiVersion: v1
kind: Service
metadata:
  name: inventory-service
  labels: {app: inventory-service, system: shop}
spec:
  selector: {app: inventory-service}
  ports:
    - {name: http, port: 8080, targetPort: http}
```

- **三種探針**都打管理埠（第 12 站 9.9）：`startupProbe` 給 JVM 最多 180 秒起來；`readinessProbe` 每 5 秒、連續 2 次失敗就從 Service 拿掉（8.5.2 量它）；`livenessProbe` 每 10 秒、連續 3 次失敗就重啟容器。
- **`maxSurge: 1、maxUnavailable: 0`**：滾動更新時先多起一台、ready 了才關舊的（02-spring-boot/08 的 ⑭）。
- **`preStop: sleep 10`**：02-spring-boot/08 的 8.7。`sleep` 是 kubelet 自己做的（`lifecycle.preStop.sleep`），映像檔裡不需要 `sleep` 這個指令。
- **`labels: system: shop`**：第 07 章 7.9.2 讓告警規則認 `system="shop"`，Prometheus 會把 pod 的這個標籤搬過去（8.9.1）。

訂單服務的 Deployment 一樣，只差名字與 ConfigMap（8.13.1）。

### 8.4.3 外部依賴、設定、秘密

```yaml
# MySQL、Redis、RabbitMQ 不在 cluster 裡（正式環境通常是託管的服務）。應用程式還是用一個 Service 的名字找它們：
# 換一台資料庫，改的是這裡的 externalName，不是每一個 Deployment 的環境變數。overlay 決定它們實際在哪裡
apiVersion: v1
kind: Service
metadata:
  name: mysql
  labels: {stage: config}
spec:
  type: ExternalName
  externalName: mysql.example.internal
---
apiVersion: v1
kind: Service
metadata:
  name: redis
  labels: {stage: config}
spec:
  type: ExternalName
  externalName: redis.example.internal
---
apiVersion: v1
kind: Service
metadata:
  name: rabbitmq
  labels: {stage: config}
spec:
  type: ExternalName
  externalName: rabbitmq.example.internal
```

`ExternalName` 讓 cluster 裡的 `mysql` 這個名字指向外面的某一台。應用程式的設定寫的是 `mysql`、`redis`、`rabbitmq` —— 資料庫換一台，改的是這三個 Service，不是每一個 Deployment。

```yaml
# 設定：不是秘密的放 ConfigMap，秘密放 Secret（overlay 產生）。兩個都用 envFrom 變成環境變數 —— application-prod.yml 讀的就是這些 SHOP_*。
# 環境變數只在容器啟動時讀一次：改了 ConfigMap，要 kubectl rollout restart 才生效（8.7.1 量了「掛成檔案」那一種要多久）
apiVersion: v1
kind: ConfigMap
metadata:
  name: shop-common
  labels: {stage: config}
data:
  SHOP_DB_HOST: mysql
  SHOP_REDIS_HOST: redis
  SHOP_RABBIT_HOST: rabbitmq
  SHOP_OTLP_ENDPOINT: http://otel-collector.observability:4318/v1/traces
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: order-service
  labels: {stage: config}
data:
  SPRING_PROFILES_ACTIVE: prod,order-service
  SHOP_DB_NAME: shop_order
  # 服務發現：一個 Service 的名字，不是一台機器。庫存服務有幾台、在哪裡，由 K8s 的 Service 決定（8.5）
  SHOP_INVENTORY_URL: http://inventory-service:8080
  # 入口（k8s/gateway）會拿掉買家帶來的 trace header，NetworkPolicy 讓只有入口連得到 8080：/api/** 的 traceparent 是入口寫的，接上它（8.8.2）
  SHOP_DEPLOYMENT_EDGE_TRUST_TRACEPARENT: "true"
  # 入口後面，request.getRemoteAddr() 是入口的 Envoy —— 「每個 IP 每秒 50 次」變成全站共用一個額度（8.8.3）。
  # native：Tomcat 的 RemoteIpValve 從 X-Forwarded-For 的右邊往左，略過內部的代理（預設：私有位址），第一個不是的就是買家
  SERVER_FORWARD_HEADERS_STRATEGY: native
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: inventory-service
  labels: {stage: config}
data:
  SPRING_PROFILES_ACTIVE: prod,inventory-service
  SHOP_DB_NAME: shop_inventory
```

`application-prod.yml` 本來就從 `SHOP_*` 環境變數讀設定（第 12 站 9.4）：ConfigMap 與 Secret 用 `envFrom` 變成環境變數，應用程式一行都不用改。`SHOP_INVENTORY_URL` 是一個 Service 的名字，不是一台機器（8.5.1）。最後兩項是入口進來之後才加的（8.8.2、8.8.3）。

這台筆電的差別放在 overlay：

```yaml
# 13 站第 08 章：base 疊上「這台筆電」的差別 ——
#   映像檔：docker build 出來、kind load 進去的 shop:d08（imagePullPolicy 預設 IfNotPresent：不會去 registry 拉）
#   外部依賴：compose 的 MySQL、Redis、RabbitMQ，在 host.docker.internal（Docker Desktop 讓容器連得到這台筆電）
#   資料庫、Redis 的 database、RabbitMQ 的 vhost：這一章自己的，不碰第 12 站的 shop
#   秘密：只在本機用的值（正式環境由部署平台注入，不在 repo 裡）
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../base
images:
  - name: shop
    newTag: d08
secretGenerator:
  - name: shop-secrets
    namespace: shop
    envs: [secrets.env]
    options:
      labels: {stage: config}
patches:
  - target: {kind: Service, name: mysql}
    patch: |-
      - {op: replace, path: /spec/externalName, value: host.docker.internal}
  - target: {kind: Service, name: redis}
    patch: |-
      - {op: replace, path: /spec/externalName, value: host.docker.internal}
  - target: {kind: Service, name: rabbitmq}
    patch: |-
      - {op: replace, path: /spec/externalName, value: host.docker.internal}
  - target: {kind: ConfigMap, name: shop-common}
    patch: |-
      - {op: add, path: /data/SPRING_RABBITMQ_VIRTUAL_HOST, value: shop_d08}
  - target: {kind: ConfigMap, name: order-service}
    patch: |-
      - {op: replace, path: /data/SHOP_DB_NAME, value: shop_d08_order}
      - {op: add, path: /data/SPRING_DATA_REDIS_DATABASE, value: "7"}
  - target: {kind: ConfigMap, name: inventory-service}
    patch: |-
      - {op: replace, path: /data/SHOP_DB_NAME, value: shop_d08_inv}
      - {op: add, path: /data/SPRING_DATA_REDIS_DATABASE, value: "6"}
```

秘密由 `secretGenerator` 從一個只在本機用的檔案產生（`k8s/kind/secrets.env`，跟 compose 一樣是 local-only 的值）；正式環境的秘密不在 repo 裡（第 12 站 0.6.5）。

### 8.4.4 migration 是一個 Job

```yaml
# 第 12 站 9.4：migration 是部署的一個步驟，不是應用程式啟動的一部分 —— DDL 的帳號（shop_migrator）只在這裡。
# 13 站第 02 章：每一個服務只跑自己的資料夾。SQL 檔在應用程式的映像檔裡（jar 拆層之後的 BOOT-INF/classes/db/migration）：
# initContainer 用同一個映像檔把它們複製出來，Flyway 的容器再去跑 —— 程式與 migration 永遠是同一個版本。
# 部署的順序：先 apply 這兩個 Job、kubectl wait 它們 complete，才 apply 應用程式（compose 的 service_completed_successfully）
apiVersion: batch/v1
kind: Job
metadata:
  name: migrate-inventory
spec:
  backoffLimit: 3
  template:
    spec:
      restartPolicy: Never
      initContainers:
        - name: copy
          image: shop:latest
          command: ["cp", "-r", "/app/BOOT-INF/classes/db/migration/.", "/migrations/"]
          volumeMounts: [{name: migrations, mountPath: /migrations}]
      containers:
        - name: flyway
          image: flyway/flyway:9.22.3
          env:
            - name: DB_NAME
              valueFrom: {configMapKeyRef: {name: inventory-service, key: SHOP_DB_NAME}}
          envFrom:
            - secretRef: {name: shop-migrator}
          args: ["-url=jdbc:mysql://mysql:3306/$(DB_NAME)?allowPublicKeyRetrieval=true&useSSL=false", "-user=$(FLYWAY_USER)", "-password=$(FLYWAY_PASSWORD)",
                 "-locations=filesystem:/migrations/inventory,filesystem:/migrations/shared", "-connectRetries=10", "migrate"]
          volumeMounts: [{name: migrations, mountPath: /migrations}]
      volumes: [{name: migrations, emptyDir: {}}]
---
apiVersion: batch/v1
kind: Job
metadata:
  name: migrate-order
spec:
  backoffLimit: 3
  template:
    spec:
      restartPolicy: Never
      initContainers:
        - name: copy
          image: shop:latest
          command: ["cp", "-r", "/app/BOOT-INF/classes/db/migration/.", "/migrations/"]
          volumeMounts: [{name: migrations, mountPath: /migrations}]
      containers:
        - name: flyway
          image: flyway/flyway:9.22.3
          env:
            - name: DB_NAME
              valueFrom: {configMapKeyRef: {name: order-service, key: SHOP_DB_NAME}}
          envFrom:
            - secretRef: {name: shop-migrator}
          # 庫存以外的每一個資料夾（application-order-service.yml 的 spring.flyway.locations）
          args: ["-url=jdbc:mysql://mysql:3306/$(DB_NAME)?allowPublicKeyRetrieval=true&useSSL=false", "-user=$(FLYWAY_USER)", "-password=$(FLYWAY_PASSWORD)",
                 "-locations=filesystem:/migrations/account,filesystem:/migrations/cart,filesystem:/migrations/catalog,filesystem:/migrations/notification,filesystem:/migrations/ordering,filesystem:/migrations/payment,filesystem:/migrations/shared",
                 "-connectRetries=10", "migrate"]
          volumeMounts: [{name: migrations, mountPath: /migrations}]
      volumes: [{name: migrations, emptyDir: {}}]
```

- **SQL 從應用程式的映像檔裡拿**：initContainer 用同一個映像檔把 `db/migration` 複製到一個空目錄，Flyway 的容器再去跑。程式與 migration 永遠是同一個版本。
- **每個服務只跑自己的資料夾**（第 02 章 2.4.2）：庫存的 Job 跑 `inventory` 與 `shared`，訂單的 Job 跑其他的。
- **自己一個 kustomization**：Job 的 spec 不能改，同一個名字要先刪掉才能再建。跟應用程式放在一起的話，每一次換映像檔的版本，`kubectl apply` 都會撞到它。

Job 要讀 ConfigMap 裡的庫名，所以設定得先在：

```yaml
# stage=config：設定類的物件（namespace、外部依賴、ConfigMap、Secret）。部署分三步 ——
#   kubectl apply -k k8s/kind -l stage=config      先有設定（migration 的 Job 要讀庫名）
#   kubectl apply -k k8s/kind/migrate               跑 migration，kubectl wait 它們 complete
#   kubectl apply -k k8s/kind                       才起應用程式
apiVersion: v1
kind: Namespace
metadata:
  name: shop
  labels: {stage: config}
```

### 8.4.5 部署

```bash
#!/usr/bin/env bash
# 13 站第 08 章：兩個服務在本機的 K8s（kind）上。MySQL、Redis、RabbitMQ 還是 compose 的那一組（cluster 外面，k8s/kind 的 ExternalName）。
#   cluster         建 cluster（k8s/kind/cluster.yaml）
#   image           docker build 映像檔 shop:d08，kind load 進 cluster（kind 的 node 不會去這台筆電的 docker 拿映像檔）
#   gateway-api     Gateway API 的 CRD 與 Envoy Gateway 控制器（observability 的 ReferenceGrant 要先有這些 CRD）
#   observability   Jaeger、OpenTelemetry Collector、Prometheus（k8s/observability）
#   databases       這一章自己的兩個庫（shop_d08_order、shop_d08_inv）與 vhost（shop_d08）—— 每一次都清空重建
#   deploy          設定 → migration（Job，等它們 complete）→ 兩個服務（等 rollout 完成）
#   gateway         入口：Gateway、HTTPRoute（k8s/gateway）；18880 從訂單服務的 NodePort 換成入口的 Envoy
#   down            刪掉 cluster
# 用法：scripts/d08-kind.sh cluster | image | gateway-api | observability | databases | deploy | gateway | down
set -euo pipefail
cd "$(dirname "$0")/.."

KIND=${KIND:-kind}
CTX=kind-d08
k() { kubectl --context "$CTX" "$@"; }

case "${1:-}" in
  cluster)
    "$KIND" get clusters | grep -qx d08 || "$KIND" create cluster --config k8s/kind/cluster.yaml
    ;;
  image)
    docker build -q -t shop:d08 .
    "$KIND" load docker-image shop:d08 --name d08
    ;;
  gateway-api)
    k apply --server-side -f https://github.com/envoyproxy/gateway/releases/download/v1.9.1/install.yaml > /dev/null
    k -n envoy-gateway-system rollout status deploy/envoy-gateway --timeout=300s
    ;;
  observability)
    kubectl kustomize --load-restrictor LoadRestrictionsNone k8s/observability | k apply -f -
    for d in jaeger otel-collector prometheus; do k -n observability rollout status "deploy/$d" --timeout=180s; done
    ;;
  databases)
    for db in shop_d08_order shop_d08_inv; do
      docker compose exec -T mysql mysql -uroot -proot -e \
        "DROP DATABASE IF EXISTS $db; CREATE DATABASE $db; GRANT ALL PRIVILEGES ON \`$db\`.* TO 'shop_migrator'@'%' WITH GRANT OPTION;" 2>&1 | grep -v "Using a password" || true
    done
    docker compose exec -T redis sh -c 'redis-cli -n 7 flushdb && redis-cli -n 6 flushdb' > /dev/null
    curl -sf -u shop:shop -X DELETE http://localhost:15672/api/vhosts/shop_d08 || true
    curl -sf -u shop:shop -X PUT http://localhost:15672/api/vhosts/shop_d08
    curl -sf -u shop:shop -X PUT -H 'Content-Type: application/json' -d '{"configure":".*","write":".*","read":".*"}' \
      http://localhost:15672/api/permissions/shop_d08/shop
    ;;
  deploy)
    k apply -k k8s/kind -l stage=config
    k -n shop delete job migrate-inventory migrate-order --ignore-not-found
    k apply -k k8s/kind/migrate
    k -n shop wait --for=condition=complete job/migrate-inventory job/migrate-order --timeout=180s
    k apply -k k8s/kind
    for d in inventory-service order-service; do k -n shop rollout status "deploy/$d" --timeout=300s; done
    ;;
  gateway)
    k -n shop delete service order-service-nodeport --ignore-not-found   # 30080 要讓給入口
    k apply -k k8s/gateway
    k -n shop wait --for=condition=Programmed gateway/shop --timeout=180s
    ;;
  down)
    "$KIND" delete cluster --name d08
    ;;
  *)
    sed -n '2,11p' "$0"; exit 1
    ;;
esac
```

這一章最後一輪實驗前，從刪掉 cluster 開始照著跑了一次：

| 步驟 | 花了 |
|---|---|
| `cluster`：建 cluster | 16 秒 |
| `image`：docker build（有快取）、kind load | 20 秒 |
| `gateway-api`：Gateway API 的 CRD 與 Envoy Gateway | 20 秒 |
| `observability`：Collector、Jaeger、Prometheus | 28 秒 |
| `databases`：兩個庫、vhost | 1 秒 |
| `deploy`：設定 → migration → 兩個服務 | 41 秒 |
| `gateway`：入口 | 11 秒 |
| 合計 | 137 秒 |

然後走一次整條路：經過入口下 40 張單、Prometheus 自己找到的 target、Jaeger 收到的服務：

```
═══ 8.4.5 kind 上的兩個服務 ═══
  庫存服務的 pod：[Pod[name=inventory-service-58478757df-kzzxj, app=inventory-service, ready=true, terminating=false, ip=10.244.0.21], Pod[name=inventory-service-58478757df-nm2nc, app=inventory-service, ready=true, terminating=false, ip=10.244.0.20]]
  inventory-service 的 EndpointSlice：[inventory-service-58478757df-kzzxj, inventory-service-58478757df-nm2nc]
  下單 40 張：{201=40}；每一個庫存服務的 pod 收到的預留：{inventory-service-58478757df-kzzxj=40.0, inventory-service-58478757df-nm2nc=0.0}
  Prometheus 的 target（kubernetes_sd）：[inventory-service/inventory-service-58478757df-kzzxj up, inventory-service/inventory-service-58478757df-nm2nc up, order-service/order-service-5b4957557c-wcrhc up]
  Jaeger 的服務：["inventory-service","order-service","shop.shop"]
  第一張下單的 traceId ce8a67d3c681098a832644c4842fc34a
```

40 張單一張一張依序送，**全部落在同一個庫存服務的 pod**。這不是巧合，是 8.6 的主題。

> 📌 **Jaeger v2 的查詢**：第 07 章的 compose 用的是 Jaeger v1 的 all-in-one 1.62（v1 在 2025 年底停止維護，8.9.3）。這裡是 v2 2.21：一條 trace 照樣是 `/api/traces/{id}`，但列出服務的 `/api/services`、找 trace 的 `/api/traces?service=…` 都是 404 —— 要改用 `/api/v3/services`、`/api/v3/traces`。K0 第一版印出的服務清單是空的，就是這個原因。

### 8.4.6 追記：GitOps —— 部署的順序寫成 dependsOn

📌 **第 09 章寫完之後補的。** 8.4.5 的部署是一支腳本：設定 → migration（等 Job 跑完）→ 應用程式。這一章開頭說「沒有 GitOps、沒有 CD」。這裡換成 Flux（v2.9.6）：cluster 裡的控制器照著一個 git repo 收斂 cluster，有人用 kubectl 改了什麼，下一輪改回去。

**順序要寫成結構。** Flux 一次套一個 kustomization，不認 kubectl 的 `-l stage=config`。腳本裡的三行，變成四個 Kustomization 與 `dependsOn`：

```yaml
# 13 站第 09 章寫完之後的追記（第 08 章 8.4.6）：GitOps —— Flux 照 repo 收斂 cluster。repo 是 cluster 裡的一個 git server（k8s/lab/git-server）。
# 第 08 章 8.4.5 的腳本是「設定 → migration（等 Job 跑完）→ 應用程式」三行；這裡是四個 Kustomization 與 dependsOn：
#   shop-config  → shop-migrate（force：Job 的 spec 不能改，換版本時刪掉重建；wait：Job 跑完才算好）→ shop-apps → shop-gateway
# interval：多久看一次 repo、多久把 cluster 改回 repo 的樣子（drift）。kubectl 直接改的，下一輪就被改回去 —— 第 09 章的 kubectl patch 權重也是
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata: {name: shop, namespace: flux-system}
spec:
  interval: 15s
  url: http://git-server.flux-system.svc:8080/git/shop.git
  ref: {branch: main}
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata: {name: shop-config, namespace: flux-system}
spec:
  interval: 1m
  sourceRef: {kind: GitRepository, name: shop}
  path: ./k8s/gitops/config
  prune: true
  wait: true
  timeout: 3m
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata: {name: shop-migrate, namespace: flux-system}
spec:
  dependsOn: [{name: shop-config}]
  interval: 1m
  sourceRef: {kind: GitRepository, name: shop}
  path: ./k8s/gitops/migrate
  prune: true
  force: true
  wait: true
  timeout: 5m
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata: {name: shop-apps, namespace: flux-system}
spec:
  dependsOn: [{name: shop-migrate}]
  interval: 1m
  sourceRef: {kind: GitRepository, name: shop}
  path: ./k8s/gitops/apps
  prune: true
  wait: true
  timeout: 5m
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata: {name: shop-gateway, namespace: flux-system}
spec:
  dependsOn: [{name: shop-apps}]
  interval: 1m
  sourceRef: {kind: GitRepository, name: shop}
  path: ./k8s/gitops/gateway
  prune: true
  wait: true
  timeout: 3m
```

四份 kustomization 不重寫 `k8s/kind`，照它產生、再把不屬於自己的那幾個拿掉（`$patch: delete`）：

```yaml
# 13 站第 09 章寫完之後的追記（第 08 章 8.4.6）：GitOps。第 08 章 8.4.5 的部署順序（設定 → migration → 應用程式）是腳本裡的三行，
# GitOps 的控制器（Flux）一次套一個 kustomization、不認 kubectl 的 -l —— 順序要寫成「三個 kustomization ＋ dependsOn」（k8s/gitops/flux.yaml）。
# 這裡不重寫 k8s/kind，照它產生、再把不屬於這一份的拿掉（$patch: delete）
# config：namespace、ConfigMap、外部依賴的 ExternalName Service。Secret 不在這裡：它的名字帶內容的 hash（secretGenerator），
#   Deployment 指到它的那一個名字，只有跟 Deployment 在同一次 kustomize 裡才會被換成帶 hash 的 —— 第一版放在這裡，apps 那一份的 Deployment 指的是不帶 hash 的名字
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources: [../../kind]
patches:
  - patch: |-
      $patch: delete
      apiVersion: apps/v1
      kind: Deployment
      metadata: {name: monolith, namespace: shop}
  - patch: |-
      $patch: delete
      apiVersion: apps/v1
      kind: Deployment
      metadata: {name: order-service, namespace: shop}
  - patch: |-
      $patch: delete
      apiVersion: apps/v1
      kind: Deployment
      metadata: {name: inventory-service, namespace: shop}
  - patch: |-
      $patch: delete
      apiVersion: v1
      kind: Service
      metadata: {name: monolith, namespace: shop}
  - patch: |-
      $patch: delete
      apiVersion: v1
      kind: Service
      metadata: {name: order-service, namespace: shop}
  - patch: |-
      $patch: delete
      apiVersion: v1
      kind: Service
      metadata: {name: inventory-service, namespace: shop}
  - patch: |-
      $patch: delete
      apiVersion: networking.k8s.io/v1
      kind: NetworkPolicy
      metadata: {name: monolith, namespace: shop}
  - patch: |-
      $patch: delete
      apiVersion: networking.k8s.io/v1
      kind: NetworkPolicy
      metadata: {name: order-service, namespace: shop}
  - patch: |-
      $patch: delete
      apiVersion: networking.k8s.io/v1
      kind: NetworkPolicy
      metadata: {name: inventory-service, namespace: shop}
  - patch: |-
      $patch: delete
      apiVersion: rbac.authorization.k8s.io/v1
      kind: Role
      metadata: {name: prometheus-discovery, namespace: shop}
  - patch: |-
      $patch: delete
      apiVersion: rbac.authorization.k8s.io/v1
      kind: RoleBinding
      metadata: {name: prometheus-discovery, namespace: shop}
  - patch: |-
      $patch: delete
      apiVersion: v1
      kind: Secret
      metadata: {name: shop-secrets, namespace: shop}
  - patch: |-
      $patch: delete
      apiVersion: v1
      kind: Secret
      metadata: {name: order-service-db, namespace: shop}
  - patch: |-
      $patch: delete
      apiVersion: v1
      kind: Secret
      metadata: {name: inventory-service-db, namespace: shop}
```

repo 要放在 Flux 拉得到的地方。它只認 HTTP(S) 與 SSH，不認 `git://`；這裡在 cluster 裡起一個最小的 git server（lighttpd 用 CGI 跑 git 自帶的 `git-http-backend`，`k8s/lab/git-server`），實驗把這個 repo 推上去。K15 從一個空的 namespace 開始：

```bash
mvn test -Pexperiments -Dtest=K15GitOpsTest -Dk15.flux=<flux 的執行檔>
```

```
═══ 8.4.6 GitOps：Flux 照 repo 收斂 cluster（config → migrate → apps → gateway）═══
  Flux（source-controller、kustomize-controller）、git server、推 repo：38 秒（不算在部署裡）
  ① 從空的 namespace 開始（套上 flux.yaml 起算）：shop-config 第 2 秒、shop-migrate 第 43 秒、shop-apps 第 88 秒、shop-gateway 第 92 秒；migration 的 Job 第 39 秒跑完；第一個應用程式的 pod 第 63 秒出現
     每一個 Kustomization 的狀態：shop-config ReconciliationSucceeded（Applied revision: main@sha1:cdafb3f04890f851eafcec01d3e34b18bfa4f567）；shop-migrate ReconciliationSucceeded（Applied revision: main@sha1:cdafb3f04890f851eafcec01d3e34b18bfa4f567）；shop-apps ReconciliationSucceeded（Applied revision: main@sha1:cdafb3f04890f851eafcec01d3e34b18bfa4f567）；shop-gateway ReconciliationSucceeded（Applied revision: main@sha1:cdafb3f04890f851eafcec01d3e34b18bfa4f567）
  ② 有人直接 kubectl（Kustomization 的 interval 是 1 分鐘）
     kubectl scale 庫存服務 → 1 台：庫存服務回到 2 台：55 秒
     kubectl patch 權重 → 50／50：權重回到 100／0：36 秒
     kubectl set env 訂單服務多一個 SHOP_EXTRA：150 秒（兩輪多）之後還在嗎 → 不在了
  ③ 用 commit 部署
     commit「庫存服務 3 台」、push：3 台都 ready：78 秒
     git revert、push：回到 2 台：66 秒
```

- **① 順序是結構，等待是輪詢。** config 第 2 秒好了，migrate 卻是第 43 秒（Job 第 39 秒跑完）；apps 第 88 秒、gateway 第 92 秒。每一層 `dependsOn` 的等待：後面那一個先看一次、前面的還沒好就說 `dependency … is not ready`，**30 秒之後再看**（kustomize-controller 的 `--requeue-dependency`，預設 30 秒）—— 前面的好了，不會叫醒它（它 watch 的是 source 的 revision 與設定，沒有 `dependsOn` 的那一個）。三層，最多多等 90 秒。8.4.5 的腳本是 `kubectl wait`，好了就走：最後一輪從零部署的時候，`scripts/d09-kind.sh deploy`（設定 → migration → 三個 Deployment 都 rollout 完）從開始到結束 65 秒，Flux 到 `shop-apps` 好了是 88 秒。
- **② 漂移：kubectl 改的，一分鐘內都被改回。** `scale` 55 秒、`patch` 權重 36 秒（Kustomization 的 interval 是 1 分鐘，每一輪先做一次 server-side 的 dry-run，跟 cluster 不一樣就套上去）。連 `set env` 加的、repo 裡**沒有**的那一個環境變數也被拿掉了 —— 我原本推論它會留著（server-side apply 只刪自己管的欄位），錯了。原因在 Flux 的原始碼（`fluxcd/pkg` 的 `ssa/patch.go` 與 kustomize-controller 的套用設定；讀的是兩個 repo 的 main 分支，不是 v2.9.6 那一版）：每一次套用之前，它把 field manager 的名字**以 `kubectl` 開頭**的那幾筆（`kubectl-set`、`kubectl-patch`、`kubectl-edit`…）改成它自己的，於是那些欄位變成「Flux 管、這一次的 manifest 裡沒有」—— 就刪了。不是 kubectl 改的（另一個控制器、另一個名字的 field manager），repo 裡沒有的欄位會留著。跟 8.7.1 正好相反：`kubectl apply` 不拿掉 `kubectl patch` 加上去的欄位（9.5.4 的 `sessionPersistence` 要用反向的 patch 拿掉），Flux 拿掉。
- **第 09 章的 `kubectl patch` 權重，在 GitOps 底下一分鐘內就被改回去**：灰度的每一步要是一個 commit。第 09 章與這幾節追記的實驗都直接改 cluster（權重、`scale`、`set env`、改 ConfigMap），要在 Flux 底下跑，得先 `flux suspend kustomization …`。
- **③ 部署與回滾都是 commit。** 「庫存服務 3 台」push 之後 78 秒三台都 ready；`git revert`、push，66 秒回到 2 台。GitRepository 15 秒看一次 repo，新的 revision 一出來四個 Kustomization 都被叫醒，可是後面三個要等前面的**套上同一個 revision**（`checkDependencies` 的條件之一），又是 30 秒一次。回滾不用 `rollout undo`（用了，推論下一輪也會被改回去 —— 跟上面的 `patch` 一樣是 kubectl 改的，沒有量）：cluster 的樣子就是 repo 的某一個 commit，8.7.2 的「設定也在 git 裡」在這裡是唯一的路。
- **決定：`k8s/` 還是腳本部署，`k8s/gitops` 留著當參考。** 理由是上面那一條：這一站的每一個實驗都靠直接改 cluster。正式環境要換，代價是順序的等待（每一層 30 秒，可以調 `--requeue-dependency`）與「所有的改動都要是 commit」—— 後者正是換它的理由。

> ⚠️ **第一版把 Secret 放在 config 那一份**（這一段與下一段是寫作途中的終端輸出，當時沒有存成紀錄）。`kubectl kustomize k8s/gitops/apps` 產生的 Deployment，`secretRef` 是 `shop-secrets` —— 不帶 hash；config 那一份產生的 Secret 叫 `shop-secrets-9897dmht29`。secretGenerator 的名字帶內容的 hash，Deployment 指到它的那個名字，只有兩個在**同一次** kustomize 裡才會被換成帶 hash 的；apps 這一份把 Secret 拿掉了，引用就沒有人換。改成 Secret 跟著 apps：apps 那一份只拿掉 namespace、ConfigMap 與外部依賴的 Service。8.7.3 的 configMapGenerator 是同一件事的另一面。
>
> 小坑：第一次 `git push` 到這個 git server，整個 repo 推不上去（`send-pack: unexpected disconnect while reading sideband packet`）；小的 repo 推得上去，`git -c http.postBuffer=524288000 push` 也推得上去。推論：大的 push 用 chunked 的請求，這個組合收不了 —— 沒有查 lighttpd 的原始碼。

---

## 8.5 服務發現：一個名字，後面有幾台由 K8s 決定

### 8.5.1 一個名字

訂單服務找庫存服務，現在是 `http://inventory-service:8080`：

1. DNS：`inventory-service` → 這個 Service 的 ClusterIP（一個穩定、不屬於任何一台機器的虛擬 IP）。
2. 連線到 ClusterIP：kube-proxy 在 node 上把它轉給 EndpointSlice 裡的其中一個 pod。
3. EndpointSlice 裡有誰：selector 選到的 pod，**而且 readiness 通過**。pod 被刪掉（滾動更新、縮容）的那一刻，它就被標成「正在結束」，不再收新的連線。

I1 的三段在這裡各是什麼樣子：

| I1 | 在 K8s 上 | 量在哪裡 |
|---|---|---|
| 多開一台，B 一個請求都沒有 | 多開一台，EndpointSlice 自己多一個 | 8.6.1（多久分到請求是另一個問題） |
| A 停了，下單 503，B 在旁邊閒著 | pod 被刪掉：滾動更新四次（兩種速率、有沒有 preStop），0 個錯誤 | 8.6.4 |
| 換位址 = 重啟訂單服務 | 位址不用換 | —— |
| Prometheus 只看得到 A | target 自己跟著 pod 變 | 8.9.1 |

刪掉一台，平台第一時間就知道。比較難的是另一種：**它還在，只是不回應**。

### 8.5.2 一台卡住（K4）

`kill -STOP` 讓庫存服務的 JVM 停住：行程還在、埠還開著，核心照樣完成 TCP 的握手，送進去的請求就是不會有回應。這是服務發現最難的一種 —— 網路說它在。

⚠️ 在容器裡 `kill -STOP 1` 沒有用。用 Docker 試過（`docker exec` 跟 `kubectl exec` 一樣，在容器的 PID namespace 裡）：`kill` 的結束碼是 0，PID 1 的狀態照樣是 `S (sleeping)` —— 訊號被丟掉了，沒有任何錯誤。PID 1 是那個 namespace 的 init：同一個 namespace 裡送給它的訊號，它沒有註冊處理器的，核心就不送；`SIGSTOP` 根本不能有處理器。要從 node 送 —— kind 的 node 是一個 Docker 容器，在裡面用 `crictl` 找到那個容器的行程：

```java
    /** 這個 pod 的應用程式（容器裡的 PID 1）在 kind node 上的 PID —— 在容器裡對 PID 1 送 SIGSTOP 會被核心忽略，要從 node 送 */
    public static String hostPid(String pod) throws Exception {
        String id = kubectl("get", "pod", pod, "-o", "jsonpath={.status.containerStatuses[0].containerID}").replace("containerd://", "").trim();
        return sh("docker", "exec", "d08-control-plane", "crictl", "inspect", "-o", "go-template", "--template", "{{.info.pid}}", id).trim();
    }
```

卡住哪一台很重要。訂單服務只跟它連著的那一台說話（8.6）；第一版卡住 `pods.get(0)`，那一次剛好是閒著的那一台：150 秒只錯了 1 張，看起來什麼事都沒有。改成「這一刻，訂單服務連進來的連線最多的那一台」：

```java
                if (s == stopAt) {
                    // 卡住「正在用的那一台」：這一刻訂單服務連進來的連線最多的那一個 pod。
                    // 第一版挑第一個 pod —— 剛好不是訂單服務連著的那一台，只錯了 1 張
                    Map<String, List<Integer>> conns = K2ScaleUpTest.connections();
                    String busiest = conns.entrySet().stream().max(java.util.Comparator.comparingInt(e -> e.getValue().size())).orElseThrow().getKey();
                    victim = Kube.pods("inventory-service").stream().map(Kube.Pod::name).filter(n -> n.endsWith("-" + busiest)).findFirst().orElseThrow();
                    Kube.signal(victim, "STOP");
                    timeline.add(String.format("第 %3d 秒 ── kill -STOP %s（這一刻訂單服務連進來的連線：%s）", s, busiest, conns));
                }
```

```
═══ 8.5.2 一台庫存服務卡住（kill -STOP）：每秒 10 張下單；第 20 秒卡住連線最多的那一台，不放開 ═══
  時間軸（每秒看一次 EndpointSlice、pod、熔斷器；只記變化）：
    第  20 秒 ── kill -STOP 27mwl（這一刻訂單服務連進來的連線：{27mwl=[54984], wqpt5=[]}）
    第  20 秒    27mwl：在 endpoints 裡；ready、重啟 0 次；熔斷器 closed
    第  31 秒    27mwl：不在 endpoints 裡；not ready、重啟 0 次；熔斷器 closed
    第  88 秒    27mwl：不在 endpoints 裡；not ready、重啟 1 次；熔斷器 closed
    第  97 秒    27mwl：在 endpoints 裡；ready、重啟 1 次；熔斷器 closed
  每 5 秒：
      0～  5 秒 │ 下單 201=50                 │ p99   165 ms │ 預留 {ok=51}
      5～ 10 秒 │ 下單 201=50                 │ p99   489 ms │ 預留 {ok=51}
     10～ 15 秒 │ 下單 201=50                 │ p99   110 ms │ 預留 {ok=49}
     15～ 20 秒 │ 下單 201=50                 │ p99   171 ms │ 預留 {ok=58}
     20～ 25 秒 │ 下單 201=50                 │ p99  1038 ms │ 預留 {ok=45}
     25～ 30 秒 │ 下單 201=50                 │ p99    75 ms │ 預留 {ok=49}
     30～ 35 秒 │ 下單 201=50                 │ p99   165 ms │ 預留 {ok=51}
     35～ 40 秒 │ 下單 201=50                 │ p99    78 ms │ 預留 {ok=50}
     40～ 45 秒 │ 下單 201=50                 │ p99    66 ms │ 預留 {ok=50}
     45～ 50 秒 │ 下單 201=50                 │ p99   903 ms │ 預留 {ok=50}
     50～ 55 秒 │ 下單 201=50                 │ p99    94 ms │ 預留 {ok=51}
     55～ 60 秒 │ 下單 201=50                 │ p99   261 ms │ 預留 {ok=49}
     60～ 65 秒 │ 下單 201=50                 │ p99   152 ms │ 預留 {ok=50}
     65～ 70 秒 │ 下單 201=50                 │ p99   113 ms │ 預留 {ok=50}
     70～ 75 秒 │ 下單 201=50                 │ p99   264 ms │ 預留 {ok=50}
     75～ 80 秒 │ 下單 201=50                 │ p99   294 ms │ 預留 {ok=50}
     80～ 85 秒 │ 下單 201=50                 │ p99    73 ms │ 預留 {ok=50}
     85～ 90 秒 │ 下單 201=50                 │ p99   214 ms │ 預留 {ok=52}
     90～ 95 秒 │ 下單 201=50                 │ p99   156 ms │ 預留 {ok=50}
     95～100 秒 │ 下單 201=50                 │ p99   446 ms │ 預留 {ok=48}
    100～105 秒 │ 下單 201=50                 │ p99    86 ms │ 預留 {ok=50}
    105～110 秒 │ 下單 201=50                 │ p99    88 ms │ 預留 {ok=50}
    110～115 秒 │ 下單 201=50                 │ p99   169 ms │ 預留 {ok=50}
    115～120 秒 │ 下單 201=50                 │ p99    80 ms │ 預留 {ok=50}
    120～125 秒 │ 下單 201=50                 │ p99   271 ms │ 預留 {ok=50}
    125～130 秒 │ 下單 201=50                 │ p99   208 ms │ 預留 {ok=50}
    130～135 秒 │ 下單 201=50                 │ p99    78 ms │ 預留 {ok=50}
    135～140 秒 │ 下單 201=50                 │ p99   344 ms │ 預留 {ok=50}
    140～145 秒 │ 下單 201=50                 │ p99    89 ms │ 預留 {ok=50}
    145～150 秒 │ 下單 201=50                 │ p99    80 ms │ 預留 {ok=51}
```

- **第 31 秒，它不在 endpoints 裡了**（卡住之後 11 秒）：`readinessProbe` 每 5 秒一次、連續 2 次失敗，加上 kubelet 回報與 EndpointSlice 更新的時間。
- **第 88 秒，它被重啟了**（卡住之後 68 秒）：`livenessProbe` 每 10 秒、連續 3 次失敗是 30 秒；kubelet 送 SIGTERM，可是行程停住了，收不到 —— 等滿 `terminationGracePeriodSeconds` 的 40 秒才 SIGKILL。
- **第 97 秒，它回來了**：JVM 重新起來、readiness 通過。
- **下單全部 201**。卡住之後的那一格（第 20～25 秒）p99 是 1,038 ms。預留的結果全部是 `ok`（一次呼叫裡的重送成功，outcome 記 `ok`，第 07 章 7.7.1）。推論：卡住的那一刻，訂單服務唯一的那一條連線連著它；那一條上的請求等滿 1 秒的 read timeout（第 06 章 6.4.2），用同一個冪等鍵再送一次 —— 開了一條新的連線，落到另一台，之後就一直用那一條。熔斷器一直是 closed。第 45～50 秒那一格也有 903 ms，那時候它已經不在 endpoints 裡了；這一輪的 load 在 9 上下，沒有查是哪幾張、慢在哪裡。

一台卡住的庫存服務，在這個設定下，代價是幾張下單多等 1 秒。

### 8.5.3 Eureka 要多久才知道（文件，沒有量）

同一件事在 Spring Cloud 的 Eureka 上，靠的是應用程式自己送心跳。Spring Cloud Netflix 的預設值（<https://docs.spring.io/spring-cloud-netflix/reference/configprops.html>）：

| 設定 | 預設 | 意思 |
|---|---|---|
| `eureka.instance.lease-renewal-interval-in-seconds` | 30 | 每 30 秒送一次心跳 |
| `eureka.instance.lease-expiration-duration-in-seconds` | 90 | 90 秒沒收到心跳，server 才把它拿掉 |
| `eureka.server.response-cache-update-interval-ms` | 30000 | server 給 client 的清單，最多舊 30 秒 |
| `eureka.client.registry-fetch-interval-seconds` | 30 | client 每 30 秒抓一次清單 |
| `spring.cloud.loadbalancer.cache.ttl` | 35 秒 | Spring Cloud LoadBalancer 的快取（<https://docs.spring.io/spring-cloud-commons/reference/spring-cloud-commons/loadbalancer.html>） |

一台 JVM 停住，它的心跳也停了（心跳是同一個 JVM 裡的一條執行緒）。照這幾個預設值推：server 至少 90 秒才拿掉它，呼叫端還可能再晚 30 + 30 + 35 秒才知道 —— **最壞 3 分鐘以上**。這是推算，這一章沒有部署 Eureka 量它。

差別不在哪一套比較好，在**誰判斷它還活著**：Eureka 是應用程式自己說（心跳）；K8s 是 kubelet 去問（探針），而且問的頻率是部署寫的 —— K4 的 10 秒，就是 `periodSeconds: 5`、`failureThreshold: 2`。Eureka 一樣可以調短，代價是心跳更多、網路一抖就把好好的實例拿掉（server 的自我保護模式就是為了這個：`eureka.server.enable-self-preservation` 預設 `true`）。

---

## 8.6 負載平衡：每一條連線，不是每一個請求

### 8.6.1 擴成三台（K2）

kube-proxy 轉的是**連線**：一條連線建立的那一刻挑一個 pod，之後這條連線上的每一個請求都到同一個 pod。訂單服務的 HTTP 用戶端（`RemoteInventoryApi` 裡的 JDK `HttpClient`）會重用連線。

K2：庫存服務 1 台、每秒 10 張下單；第 30 秒 `kubectl scale --replicas=3`。每 10 秒記一次每一個庫存服務的 pod 這 10 秒處理了幾個預留，以及**它身上有幾條連線**（從庫存服務那一邊數：`/proc/net/tcp` 裡本機是 `:8080`、ESTABLISHED 的；括號裡的數字是對方的埠，同一條連線，對方的埠不會變）：

```java
    /**
     * 每一個庫存服務的 pod 上，ESTABLISHED、本機是 :8080 的 TCP 連線（從伺服器這一邊數：從訂單服務那一邊看，對方是 Service 的 ClusterIP，
     * 看不出是哪一個 pod —— 第一版從訂單服務數，每一格都是 0）。值是「對方的埠」：同一條連線，對方的埠不會變
     */
    static Map<String, List<Integer>> connections() throws Exception {
        Map<String, List<Integer>> m = new TreeMap<>();
        for (Kube.Pod p : Kube.pods("inventory-service")) {
            List<Integer> ports = new ArrayList<>();
            String raw;
            try { raw = Kube.kubectl("exec", p.name(), "--", "cat", "/proc/net/tcp", "/proc/net/tcp6"); } catch (Exception notYet) { continue; }
            for (String line : raw.lines().toList()) {
                String[] f = line.trim().split("\\s+");
                if (f.length < 4 || !f[3].equals("01")) continue;                               // 01 = ESTABLISHED
                if (!f[1].endsWith(":1F90")) continue;                                          // 本機的埠 8080
                ports.add(Integer.parseInt(f[2].substring(f[2].lastIndexOf(':') + 1), 16));
            }
            ports.sort(null);
            m.put(short_(p.name()), ports);
        }
        return m;
    }
```

⚠️ 第一版從訂單服務那一邊數：從那裡看，每一條連線的對方都是 Service 的 ClusterIP，分不出是哪一個 pod —— 每一格都是 0。

```
═══ 8.6 擴成 3 台：每秒 10 張下單；第 30 秒 kubectl scale --replicas=3 ═══
  第  10 秒 │ {zzrgm=103（連線 [46496, 46510, 46522, 46526, 46532, 46546, 46558, 46566]）} │ endpoints 1 個
  第  20 秒 │ {zzrgm=100（連線 [46496, 46510, 46522, 46526, 46532, 46546, 46558, 46566]）} │ endpoints 1 個
  第  30 秒 │ {zzrgm=100（連線 [46496, 46510, 46522, 46526, 46532, 46546, 46558, 46566]）} │ endpoints 1 個
  第  30 秒 ── kubectl scale --replicas=3
  第  40 秒 │ {5lc8f=—（連線 []）, d5rmf=—（連線 []）, zzrgm=106（連線 [46496, 46510, 46522, 46526, 46532, 46546, 46558, 46566]）} │ endpoints 1 個
  第  50 秒 │ {5lc8f=—（連線 []）, d5rmf=—（連線 []）, zzrgm=95（連線 [46496, 46510, 46522, 46526, 46532, 46546, 46558, 46566]）} │ endpoints 3 個
  第  60 秒 │ {5lc8f=0（連線 [49070, 49094, 49098, 49100]）, d5rmf=0（連線 [49084]）, zzrgm=96（連線 [49112]）} │ endpoints 3 個
  第  70 秒 │ {5lc8f=68（連線 [49070, 49094, 49098, 49100]）, d5rmf=17（連線 [49084]）, zzrgm=16（連線 [49112]）} │ endpoints 3 個
  第  80 秒 │ {5lc8f=68（連線 [49070, 49094, 49098, 49100]）, d5rmf=16（連線 [49084]）, zzrgm=17（連線 [49112]）} │ endpoints 3 個
  第  90 秒 │ {5lc8f=68（連線 [49070, 49094, 49098, 49100]）, d5rmf=17（連線 [49084]）, zzrgm=17（連線 [49112]）} │ endpoints 3 個
  第 100 秒 │ {5lc8f=64（連線 [49070, 49094, 49098, 49100]）, d5rmf=17（連線 [49084]）, zzrgm=16（連線 [49112]）} │ endpoints 3 個
  第 110 秒 │ {5lc8f=69（連線 [49070, 49094, 49098, 49100]）, d5rmf=17（連線 [49084]）, zzrgm=17（連線 [49112]）} │ endpoints 3 個
  第 120 秒 │ {5lc8f=63（連線 []）, d5rmf=16（連線 []）, zzrgm=20（連線 [60652]）} │ endpoints 3 個
  第 130 秒 │ {5lc8f=0（連線 []）, d5rmf=0（連線 []）, zzrgm=102（連線 [52950]）} │ endpoints 3 個
  第 140 秒 │ {5lc8f=0（連線 []）, d5rmf=0（連線 []）, zzrgm=98（連線 [44636]）} │ endpoints 3 個
  第 150 秒 │ {5lc8f=8（連線 [44654]）, d5rmf=0（連線 []）, zzrgm=91（連線 [44636, 44652]）} │ endpoints 3 個
  第 160 秒 │ {5lc8f=43（連線 [44654]）, d5rmf=0（連線 []）, zzrgm=57（連線 [44652]）} │ endpoints 3 個
  第 170 秒 │ {5lc8f=49（連線 []）, d5rmf=3（連線 [59898]）, zzrgm=48（連線 []）} │ endpoints 3 個
  第 180 秒 │ {5lc8f=0（連線 []）, d5rmf=68（連線 [59898]）, zzrgm=34（連線 [59902]）} │ endpoints 3 個
  下單：擴之前 [201=307]；擴之後 [201=1503]
```

- 第 30 秒擴成 3 台，EndpointSlice 在第 50 秒有 3 個。新的兩台第一次分到預留，是第 60～70 秒那一格 —— 擴容之後 30～40 秒。
- 前 50 秒，庫存服務身上一直是**同樣的 8 條連線**（對方的埠沒有變過）。暖機的時候同時在路上的請求多，訂單服務的連線池開到 8 條；之後每秒 10 張分給 8 條，一條一秒一張多一點。Tomcat 每 100 個請求關一次連線（Spring Boot 的 `server.tomcat.max-keep-alive-requests`，預設 100）—— 一條連線要七、八十秒才用滿。kube-proxy 不會搬走已經建立的連線：新的 pod 要等舊的連線一條一條被關掉、重新建立的時候，才抽得到。
- 第 60 秒左右，那 8 條剛好陸續用滿、換掉了；新建的 6 條以 4／1／1 落在三台。接下來 40 秒，三台的預留是 68／17／16 —— **跟連線數成比例**，不是平均。
- 第 120～140 秒，連線又換了一輪，這一次只剩 1 條，落在原來那一台：三台 0／0／100。

拉長時間看，每一條新的連線隨機挑一台，大致是平均的；10 秒一格看，常常是一台拿全部。

### 8.6.2 負載高的時候

同一個實驗，每秒 40 張：

```
═══ 8.6 擴成 3 台：每秒 40 張下單；第 30 秒 kubectl scale --replicas=3 ═══
  第  10 秒 │ {rv5fr=411（連線 [44178, 44182, 44186, 44190, 44202, 44218, 44232, 44240, 44248, 44250, 44254, 44264, 44274, 44276, 44282, 44294, 44298, 44310, 44316, 54274]）} │ endpoints 1 個
  第  20 秒 │ {rv5fr=396（連線 [44178, 44182, 44186, 44190, 44202, 44218, 44232, 44240, 44248, 44250, 44254, 44264, 44274, 44276, 44282, 44294, 44298, 44310, 44316, 54274]）} │ endpoints 1 個
  第  30 秒 │ {rv5fr=406（連線 [50068, 50084]）} │ endpoints 1 個
  第  30 秒 ── kubectl scale --replicas=3
  第  40 秒 │ {js8r7=—（連線 []）, rv5fr=399（連線 [42322, 42324, 42340, 42350, 42360, 50068, 50084, 50094, 50106, 50114, 50126, 50128]）, znlg8=—（連線 []）} │ endpoints 1 個
  第  50 秒 │ {js8r7=—（連線 []）, rv5fr=377（連線 [42322, 42324, 42340, 42350, 42360, 42364, 50094, 50114, 50126, 50128, 56698, 56710]）, znlg8=—（連線 []）} │ endpoints 1 個
  第  60 秒 │ {js8r7=—（連線 []）, rv5fr=423（連線 [42322, 42324, 42340, 42350, 42360, 42364, 56698, 56710, 56724]）, znlg8=—（連線 []）} │ endpoints 3 個
  第  70 秒 │ {js8r7=0（連線 [60038, 60062, 60120, 60146, 60164, 60176]）, rv5fr=390（連線 [60094, 60132, 60158]）, znlg8=0（連線 [60040, 60050, 60078, 60104]）} │ endpoints 3 個
  第  80 秒 │ {js8r7=183（連線 [60038, 60062, 60120, 60146, 60164, 60176]）, rv5fr=95（連線 [60094, 60132, 60158]）, znlg8=124（連線 [60040, 60050, 60078, 60104]）} │ endpoints 3 個
  第  90 秒 │ {js8r7=186（連線 [60038, 60062, 60120, 60146, 60164, 60176]）, rv5fr=94（連線 [60094, 60132, 60158]）, znlg8=124（連線 [60040, 60050, 60078, 60104]）} │ endpoints 3 個
  第 100 秒 │ {js8r7=186（連線 [60038, 60062, 60120, 60146, 60164, 60176]）, rv5fr=92（連線 [60094, 60132, 60158]）, znlg8=122（連線 [60040, 60050, 60078, 60104]）} │ endpoints 3 個
  第 110 秒 │ {js8r7=198（連線 [60384]）, rv5fr=177（連線 [58476]）, znlg8=30（連線 []）} │ endpoints 3 個
  第 120 秒 │ {js8r7=128（連線 [49550, 60430]）, rv5fr=251（連線 [49558]）, znlg8=14（連線 [49556]）} │ endpoints 3 個
  下單：擴之前 [201=1233]；擴之後 [201=3607]
```

- 每秒 40 張，暖機時連線池開到 20 條。新的 pod 在第 60 秒才進 EndpointSlice（負載高，它們起得比較慢），第 70～80 秒那一格開始分到 —— 進 endpoints 之後 10～20 秒，比每秒 10 張快：請求多，每一條連線更快用滿 100 個。
- 分到多少，還是跟連線數走：6／3／4 條，183／95／124 個。
- 擴容之後的 3,607 張全部 201。這是 8.6.3 修正之後的樣子，入口也已經換成 8.8 的 gateway。

### 8.6.3 ⚠️ 庫存服務對訂單服務限流

8.6.2 的實驗第一次跑的時候（修正之前），擴容之後的下單是這樣：

```
  下單：擴之前 [201=1226]；擴之後 [201=3454, 429=15, 500=39, 503=130]
```

500 是「我們的錯」（429 的 15 張、503 的 130 張是別的原因，這裡沒有細查）。那一次用 `kubectl logs` 數，訂單服務的日誌裡有 40 行：

```
INVENTORY_ERROR op=reserve status=429：{"type":"/problems/rate-limited","title":"請求太頻繁","status":429,…
```

**庫存服務把訂單服務限流了。** 第 12 站 0.6.5 的全域限流是「每個 IP 每秒 50 次」（`RateLimitFilter`，`request.getRemoteAddr()`）。切開之後，庫存服務也跑同一個 filter —— 而訂單服務的每一個呼叫都從同一個 IP 來（一個 pod 一個 IP）。它一秒呼叫庫存服務超過 50 次，預留就被 429；`RemoteInventoryApi` 把 429 當成「我們的錯」（它的類別註解的 ①：只有庫存不足、狀態不對、暫時不能用三種原樣交給使用者），買家拿到 500。

這個 bug 從第 03 章切開之後就在。第 03～07 章的實驗都用 `shop.rate-limit.enabled=false` 起服務（第 00 章的 `SplitLab.common`），所以看不到；K8s 上用的是正式設定。

用一個測試把它釘住：上限調成每秒 5 次，同一秒裡用訂單服務的服務 token 送 20 次。修正前（那時候這一節還沒有編號，紀錄印的是「8.x」）：

```
13 站 8.x：上限每秒 5 次；訂單服務的 token 一秒 20 次 → {200=5, 429=15}
```

修法跟第 07 章 7.5 信任 `traceparent` 是同一個判斷 —— **自己的另一個服務**（`/internal/**`、帶著一個發給我的服務 token）不算進每個 IP 的額度：

```diff
 import com.example.shop.shared.config.ShopProperties;
 import com.example.shop.shared.error.ProblemType;
 import com.example.shop.shared.ratelimit.RateLimiter;
+import com.example.shop.shared.security.ServiceTokens;
 import jakarta.servlet.FilterChain;
 import jakarta.servlet.ServletException;
 import jakarta.servlet.http.HttpServletRequest;
 import jakarta.servlet.http.HttpServletResponse;
+import org.springframework.beans.factory.ObjectProvider;
 import org.springframework.boot.web.servlet.FilterRegistrationBean;
 import org.springframework.context.annotation.Bean;
 import org.springframework.context.annotation.Configuration;
…
 /**
  * 6.7.2 0.6.5 的全域限流：每個 IP 每秒 50 次。放在 Spring Security 之前：沒有登入的洪水也要擋（登入 API 本身就是公開的）。
  * health 不限流：負載平衡器的探測如果被 429，攻擊者就能讓負載平衡器把每一台都摘掉（5.2.1 的同一種後果）。
+ *
+ * 13 站 8.6.3：自己的另一個服務也不算（/internal/**、帶著一個發給我的服務 token —— 跟 TraceFilters 信任 traceparent 是同一個判斷）。
+ * 訂單服務的每一個呼叫都從同一個 IP 來（一個 pod 一個 IP）：第一版照算，它一秒呼叫庫存服務超過 50 次，預留就被 429，買家拿到 500
+ *（K8s 上每秒 40 張下單量到的；第 03～07 章的實驗都關掉限流起服務，看不到）。庫存服務不被訂單服務壓垮，靠的是訂單服務那一邊的
+ * 隔艙、熔斷與預算（第 06 章），不是用「來源 IP」猜
  */
 @Configuration(proxyBeanMethods = false)
 class RateLimitFilter {
 
     @Bean
-    FilterRegistrationBean<OncePerRequestFilter> perIpRateLimit(RateLimiter limiter, ShopProperties props, ProblemWriter problems) {
+    FilterRegistrationBean<OncePerRequestFilter> perIpRateLimit(RateLimiter limiter, ShopProperties props, ProblemWriter problems,
+                                                                ObjectProvider<ServiceTokens> serviceTokens) {
+        ServiceTokens tokens = serviceTokens.getIfAvailable();
         int limit = props.rateLimit().requestsPerIpPerSecond();
         boolean enabled = props.rateLimit().enabled();
         OncePerRequestFilter f = new OncePerRequestFilter() {
             @Override
             protected boolean shouldNotFilter(HttpServletRequest req) {
-                return !enabled || req.getRequestURI().startsWith("/actuator/health");
+                return !enabled || req.getRequestURI().startsWith("/actuator/health") || TraceFilters.fromOurService(req, tokens);
             }
 
             @Override
```

庫存服務不被訂單服務壓垮，靠的是訂單服務那一邊的隔艙、熔斷器與預算（第 06 章），不是用「來源 IP」猜。沒有服務 token 的請求照樣限流（`/internal/**` 沒有對外的路由，8.8.2 的 NetworkPolicy 也讓只有訂單服務連得到）。修正後，同一個測試：

```
13 站 8.6.3：上限每秒 5 次；沒有 token 一秒 20 次 → {401=5, 429=15}
13 站 8.6.3：上限每秒 5 次；訂單服務的 token 一秒 20 次 → {200=20}
```

### 8.6.4 滾動更新（K3）

刪掉一個 pod（滾動更新也是）同時發生兩件事：kubelet 送 SIGTERM、控制面把它從 EndpointSlice 拿掉，兩者沒有先後的保證。02-spring-boot/08 的 8.7 用 `preStop: sleep` 讓「拿掉」先發生 —— 那一章看的是入口；這裡看服務之間。K3 在每一種速率量兩次滾動更新：舊的 pod 有 `preStop`；以及先把 `preStop` patch 掉、滾完一次，再量下一次。

每秒 10 張：

```
═══ 8.6.4 滾動更新庫存服務（2 台，maxSurge 1、maxUnavailable 0）：每秒 10 張下單 ═══
  ① 舊的 pod 有 preStop: sleep 10：第 15.0 秒 kubectl rollout restart，第 47.9 秒舊的 pod 都結束了
      0～  5 秒 │ 下單 201=50                     │ p99   189 ms
      5～ 10 秒 │ 下單 201=50                     │ p99   134 ms
     10～ 15 秒 │ 下單 201=50                     │ p99    76 ms
     15～ 20 秒 │ 下單 201=50                     │ p99   129 ms
     20～ 25 秒 │ 下單 201=50                     │ p99   628 ms
     25～ 30 秒 │ 下單 201=50                     │ p99   138 ms
     30～ 35 秒 │ 下單 201=50                     │ p99   262 ms
     35～ 40 秒 │ 下單 201=50                     │ p99    89 ms
     40～ 45 秒 │ 下單 201=50                     │ p99   100 ms
     45～ 50 秒 │ 下單 201=50                     │ p99   244 ms
     50～ 55 秒 │ 下單 201=50                     │ p99    86 ms
     55～ 60 秒 │ 下單 201=50                     │ p99   152 ms
    整段：下單 [201=602]；預留呼叫的結果 {ok=602}；沒有回應的送出 0 次
```

```
  ② 舊的 pod 沒有 preStop：第 15.0 秒 kubectl rollout restart，第 36.1 秒舊的 pod 都結束了
      0～  5 秒 │ 下單 201=50                     │ p99   578 ms
      5～ 10 秒 │ 下單 201=50                     │ p99    63 ms
     10～ 15 秒 │ 下單 201=50                     │ p99    64 ms
     15～ 20 秒 │ 下單 201=50                     │ p99   192 ms
     20～ 25 秒 │ 下單 201=50                     │ p99   142 ms
     25～ 30 秒 │ 下單 201=50                     │ p99   361 ms
     30～ 35 秒 │ 下單 201=50                     │ p99   205 ms
     35～ 40 秒 │ 下單 201=50                     │ p99   315 ms
     40～ 45 秒 │ 下單 201=50                     │ p99   156 ms
     45～ 50 秒 │ 下單 201=50                     │ p99   296 ms
    整段：下單 [201=501]；預留呼叫的結果 {ok=501}；沒有回應的送出 0 次
```

每秒 30 張（只列每一段的總數）：

```
  ① 舊的 pod 有 preStop: sleep 10：第 15.0 秒 kubectl rollout restart，第 70.3 秒舊的 pod 都結束了
    整段：下單 [201=2551]；預留呼叫的結果 {ok=2551}；沒有回應的送出 0 次
  ② 舊的 pod 沒有 preStop：第 15.0 秒 kubectl rollout restart，第 58.3 秒舊的 pod 都結束了
    整段：下單 [201=2102]；預留呼叫的結果 {ok=2102}；沒有回應的送出 0 次
```

兩種速率、有沒有 `preStop`，四次滾動更新**都是 0 個錯誤、0 次沒有回應**；變的只有 p99（每秒 30 張時，這台筆電的 load 到 9～10，好幾格的 p99 超過 1 秒，最高 2.6 秒）。

沒有 `preStop` 也量不到錯誤。推論的原因（沒有一個一個驗證）：

- 一個 node：kube-proxy 就在同一台，EndpointSlice 一變，它幾乎同時改好轉送的規則。
- 庫存服務的 Tomcat 是優雅關機（第 12 站 9.5）：收到 SIGTERM 之後不收新的連線，閒置的 keep-alive 連線被關掉，JDK HttpClient 看到之後就從池裡拿掉。
- JDK HttpClient 自己會重送兩種失敗（JDK 21 的 `jdk.internal.net.http.MultiExchange`）：**連不上**（`ConnectException`）不分 HTTP 方法，重連一次（`jdk.httpclient.disableRetryConnect` 預設 false）；**池裡的連線已經被對方關了**（`ConnectionExpiredException`），只重送 GET、HEAD —— 預留是 PUT，不在裡面。K3 的「沒有回應」是 0：PUT 一次都沒有撞上「已經被關掉的舊連線」。

這不是說 `preStop` 可以拿掉。02-spring-boot/08 的那一段量的是**入口**（負載平衡器的 endpoints 更新得比 kube-proxy 慢）；多個 node 的時候，別台的 kube-proxy 也比較晚知道。這一章只量了「一個 node、服務之間」這一種。（📌 第 09 章寫完之後的追記：三個 node 量了，8.6.6。）

### 8.6.5 什麼時候要每一個請求挑一次

kube-proxy 的「每一條連線挑一次」，這個專案可以接受，理由都是量出來的：

- HTTP/1.1，而且 Tomcat 每 100 個請求關一次連線（`server.tomcat.max-keep-alive-requests` 的預設），連線一直在換手（8.6.1）。
- 負載越高，連線越多、換手越快，新的 pod 越快分到（8.6.2）。

會出問題的情況，在這個專案裡都還沒有：

- **長命的連線**：HTTP/2、gRPC 把所有請求多工在一條連線上，一條連線可以活幾個小時 —— 新的 pod 可能永遠分不到。這是「gRPC 在 K8s 上負載不均」的來源。
- **需要「最少請求」而不是「隨機」**：一台慢了，每一條連線挑一次的平衡器還是照樣送給它。

那時候的選擇：

| 做法 | 在哪一層 | 代價 |
|---|---|---|
| 呼叫端自己挑：Spring Cloud LoadBalancer + Spring Cloud Kubernetes 的服務發現（或 headless Service + DNS） | 應用程式（函式庫） | 每一個呼叫端都要有它；呼叫端要能讀 K8s 的 API（權限） |
| 服務網格：sidecar 每一個請求挑一次 | 平台 | 8.10 |
| 縮短連線的壽命（例如調小 `max-keep-alive-requests`） | 被呼叫端的設定 | 多一些 TCP 握手；只是讓「換手」更快，不是每一個請求 |

第一種就是「兩套混用」最常見的理由（8.11.4）。

### 8.6.6 追記：三個 node

📌 **第 09 章寫完之後補的。** 8.6.4 在一個 node 上量滾動更新，有沒有 `preStop` 都是 0 個錯；推論的原因之一是「kube-proxy 就在同一台」，也說「多個 node 的時候，別台的 kube-proxy 也比較晚知道」—— 沒有量。這裡換成三個 node 的 kind（一個控制面、兩個 worker，`k8s/kind/cluster-3nodes.yaml`），把訂單服務釘在一個 worker、庫存服務的兩台釘在另一個：每一個預留都跨 node。

```bash
kind create cluster --config k8s/kind/cluster-3nodes.yaml        # 之後照 8.4.5 的腳本部署
mvn test -Pexperiments -Dtest=K13MultiNodeTest -Dk3.rate=10
```

```
═══ 8.6.6 三個 node：訂單服務在 d08-worker、庫存服務在 d08-worker2；每秒 10 張下單 ═══
  ⓪ pod 在哪裡：{inventory-service-6ffd97db4d-rf2kb=d08-worker2, inventory-service-6ffd97db4d-x9v7t=d08-worker2, order-service-6bcc74c9f4-5cksb=d08-worker}；入口的 Envoy：d08-worker2（入口的 Service 改成 externalTrafficPolicy: Cluster）
  ① 刪掉一台庫存服務的 pod（沒有負載）：inventory-service-6ffd97db4d-rf2kb（10.244.2.27）→ d08-control-plane 206 ms、d08-worker 273 ms、d08-worker2 327 ms、EndpointSlice 438 ms（kube-proxy：mode: iptables）
  ② 舊的 pod 有 preStop: sleep 10：第 15.0 秒 kubectl rollout restart，第 55.7 秒舊的 pod 都結束了
      0～  5 秒 │ 下單 201=50                     │ p99   594 ms
      5～ 10 秒 │ 下單 201=50                     │ p99  1385 ms
     10～ 15 秒 │ 下單 201=50                     │ p99   145 ms
     15～ 20 秒 │ 下單 201=50                     │ p99  1051 ms
     20～ 25 秒 │ 下單 201=50                     │ p99  1079 ms
     25～ 30 秒 │ 下單 201=50                     │ p99  1012 ms
     30～ 35 秒 │ 下單 201=50                     │ p99   638 ms
     35～ 40 秒 │ 下單 201=50                     │ p99   278 ms
     40～ 45 秒 │ 下單 201=50                     │ p99   226 ms
     45～ 50 秒 │ 下單 201=50                     │ p99  1124 ms
     50～ 55 秒 │ 下單 201=50                     │ p99  1264 ms
     55～ 60 秒 │ 下單 201=50                     │ p99  1153 ms
     60～ 65 秒 │ 下單 201=50                     │ p99   123 ms
     65～ 70 秒 │ 下單 201=50                     │ p99   114 ms
    整段：下單 [201=701]；預留呼叫的結果 {ok=701}；沒有回應的送出 1 次
  ③ 舊的 pod 沒有 preStop：第 15.0 秒 kubectl rollout restart，第 44.3 秒舊的 pod 都結束了
      0～  5 秒 │ 下單 201=50                     │ p99   450 ms
      5～ 10 秒 │ 下單 201=50                     │ p99   122 ms
     10～ 15 秒 │ 下單 201=50                     │ p99   225 ms
     15～ 20 秒 │ 下單 201=50                     │ p99   369 ms
     20～ 25 秒 │ 下單 201=50                     │ p99   293 ms
     25～ 30 秒 │ 下單 201=50                     │ p99   281 ms
     30～ 35 秒 │ 下單 201=50                     │ p99  1630 ms
     35～ 40 秒 │ 下單 201=50                     │ p99   783 ms
     40～ 45 秒 │ 下單 201=50                     │ p99   791 ms
     45～ 50 秒 │ 下單 201=50                     │ p99   162 ms
     50～ 55 秒 │ 下單 201=50                     │ p99    72 ms
    整段：下單 [201=551]；預留呼叫的結果 {ok=551}；沒有回應的送出 1 次
```

- **① 刪掉一個 pod：三台 node 都在第一輪量完之前就拿掉它。** 每一輪依序問控制面、兩個 worker 的 iptables，最後問 EndpointSlice（每一問都是一個 `docker exec` 或 `kubectl`，幾十到一百多毫秒）。四次（連同下面 ⚠️ 的前幾次）都是控制面 206～242 ms、worker 273～312、另一個 worker 327～370、EndpointSlice 438～490 ms —— 跟問的順序一模一樣：這是量法的順序，不是傳播的先後。能說的是：從 `kubectl delete` 送出，到三台 node 的 kube-proxy 都拿掉它，不到 0.4 秒。
- **②③ 滾動更新：每一個預留都跨 node，有沒有 `preStop` 下單都是 0 個錯。** 每秒 10 張：有 `preStop` 701 張、沒有 551 張，全部 201、預留的結果全是 `ok`。
- **比一個 node 多了一點：「沒有回應的送出」這一次兩邊各 1 次**（訂單服務自己再送一次就成功了，買家拿到的還是 201）；前一次每秒 10 張（下面 ⚠️ 的第三次，標題印錯了、數字有效）兩邊各 0 次。8.6.4 在一個 node 上四次都是 0。那 1 次是 8.6.4 的第三個推論說的那一種（池裡的連線已經被對方關了、PUT 不自動重送）、還是跨 node 才有的，沒有分開量。`preStop` 也沒有讓它變成 0。
- 8.6.4 推論的三個原因，第一個（「kube-proxy 就在同一台」）在這裡不成立，下單還是 0 個錯：剩下的兩個 —— 庫存服務的優雅關機、JDK HttpClient 連不上時自己重連一次 —— 加上訂單服務自己的重送，就接住了（推論，這一次也沒有一個一個驗證）。8.6.4 那一句「多個 node 的時候，別台的 kube-proxy 也比較晚知道」：晚，但不到 0.4 秒。
- **`preStop` 仍然留著**：02-spring-boot/08 量的是入口後面的負載平衡器，那一層不在這裡；這一節只說「服務之間、三個 node、每秒 10 張」沒有它也沒有錯。每秒 30 張的那一次（下面 ⚠️ 的第二次）系統本身就過載，量不出差別。

> ⚠️ **K13 跑了四次，前三次各有一個地方沒有量到或印錯，卻都照樣跑完。**
>
> 第一次，②③ 的每一張下單都是 `-1`（客戶端連不上）：
>
> ```
>     整段：下單 [-1=1652]；預留呼叫的結果 {}；沒有回應的送出 0 次
>     整段：下單 [-1=1351]；預留呼叫的結果 {}；沒有回應的送出 0 次
> ```
>
> 入口的 Service 是 `externalTrafficPolicy: Local` —— Envoy Gateway 1.9.1 的預設（它的 API 定義：`+kubebuilder:default:="Local"`，「traffic will only go to pods on the node receiving the traffic」）。這台筆電的 18880 只對到控制面的 NodePort，而控制面有 taint、Envoy 在 worker 上：從控制面進來的，沒有本地的 Envoy 可以送。`cluster-3nodes.yaml` 第一版的註解寫「NodePort 在每一個 node 上都聽，從哪一台進去都一樣」—— 只有 `Cluster` 才是這樣。一個 node 的時候兩種沒有差別，所以第 08 章一直沒有碰到。
>
> 第二次（入口改成 `Cluster`，每秒 30 張），下單有了，可是：
>
> ```
>     整段：下單 [201=2597, 503=555]；預留呼叫的結果 {}；沒有回應的送出 0 次
>     整段：下單 [201=2180, 503=71]；預留呼叫的結果 {}；沒有回應的送出 0 次
> ```
>
> 「預留呼叫的結果 `{}`」「沒有回應的送出 0 次」也不是量出來的：這兩個數字是經過 API server 的 pod proxy 讀訂單服務的 8081，而 NetworkPolicy（8.8.2）只讓 `observability` 連 8081 —— 一個 node 的時候 proxy 從同一台 node 連進來，不受限制；三個 node 的時候它從控制面連到 worker 上的 pod，被擋（`dial tcp …:8081: i/o timeout`，寫作途中直接用 `kubectl get --raw` 試的），讀到的是 null，印出來就是 `{}` 與 0。那一次的 p99 到秒級、滾動更新還沒開始的頭 5 秒就有 503：三個 node 加每秒 30 張，這台筆電本身就過載了（推論那些 503 是隔艙滿了的拒絕，沒有看日誌）。
>
> 現在 K13 跑的時候把入口改成 `Cluster`、多加一條讓 node 連得到 8081 的 NetworkPolicy，結束時都拿掉；暖身之後沒有 201、或讀不到預留的指標，就停。
>
> 第三次（每秒 10 張）的標題印成「每秒 30 張」：K13 自己的暖身讀 `k13.rate`（預設 30），量滾動更新的 K3 讀 `k3.rate`（10）—— 兩個名字。滾動更新的數字是每秒 10 張、有效；改成都讀 `k3.rate` 之後跑第四次，就是上面那一次。① 不經過入口、也不讀指標，四次的數字都有效。

---

## 8.7 設定管理

### 8.7.1 改一個設定要多久（K8）

拿付款期限（`shop.order.payment-timeout`，預設 15 分鐘）當例子：下單的回應帶著 `createdAt` 與 `paymentDeadline`，相減就是訂單服務**現在用的值**。

這個專案的 ConfigMap 是環境變數，環境變數只在容器啟動時讀一次 —— 不用量，改了一定要重開。K8 量的是另一種做法：ConfigMap **掛成檔案**，用 Spring Boot 的 `configtree` 讀（一個目錄裡的每一個檔案是一個設定，檔名是 key）。實驗用 `kubectl patch` 臨時加上去：

```java
            Kube.kubectl("patch", "deploy/order-service", "--type=json", "-p", """
                    [{"op":"add","path":"/spec/template/spec/volumes","value":[{"name":"tuning","configMap":{"name":"order-tuning"}}]},
                     {"op":"add","path":"/spec/template/spec/containers/0/volumeMounts","value":[{"name":"tuning","mountPath":"%s"}]},
                     {"op":"add","path":"/spec/template/spec/containers/0/env","value":[{"name":"SPRING_CONFIG_IMPORT","value":"optional:configtree:%s/"}]}]
                    """.formatted(DIR, DIR));
```

```
═══ 8.7.1 改一個設定（付款期限 15m → 20m）要多久才生效 ═══
  一開始：下單的付款期限 15 分鐘
  ① 掛成檔案（/etc/shop/tuning/shop.order.payment-timeout = 15m）：下單的付款期限 15 分鐘
     ConfigMap 改成 20m → pod 裡的檔案 53 秒後變成 20m
     檔案變了之後再等 30 秒：下單的付款期限 15 分鐘
  ② kubectl rollout restart（每秒 5 張下單）：20.7 秒滾完；這段時間的下單 [201=104]；之後下單的付款期限 20 分鐘
```

- **掛成檔案**：ConfigMap 改成 20m 之後 53 秒，pod 裡的檔案才變（寫這一章途中的另一次是 76 秒）。K8s 的文件：延遲是 kubelet 的同步週期加上它的快取（<https://kubernetes.io/docs/concepts/configuration/configmap/>）。
- **檔案變了，訂單服務用的還是 15 分鐘**：`configtree` 只在啟動的時候讀。要「檔案一變就生效」，得有人重讀 —— Spring Cloud Kubernetes 的設定重讀，或自己寫一個。
- **`rollout restart`**：20.7 秒滾完，這段時間 104 張下單全部 201；之後是 20 分鐘。

對一個不會重讀的 Spring Boot 應用程式來說，掛成檔案什麼都沒有換到：檔案晚一分鐘左右才變，變了也還是要重開。

📌 實驗最後用 JSON patch 把這三樣拿掉。`kubectl apply` 不會幫你拿：它只刪「上一次 apply 有、這一次沒有」的欄位，`kubectl patch` 加上去的不在上一次 apply 的紀錄裡。

### 8.7.2 Config Server 值不值得

Spring Cloud 的答案是一個 Config Server：設定放在一個 Git repo，應用程式啟動時去拿；要「不重開就生效」，再加上 `@RefreshScope` 與一個通知（Spring Cloud Bus，或打每一台的 `/actuator/refresh`）。K8s 上的對應是 Spring Cloud Kubernetes：應用程式自己讀 ConfigMap，可以設定成變了就重讀。

這個專案不用，理由：

- **設定很少改，改的時候要有人看過**：K8 的 `rollout restart` 是 20.7 秒、0 個錯誤。一次設定的改變 = 一次部署 = 一次 code review，跟改程式走同一條路。
- **「不重開就生效」有它自己的代價**：哪些 bean 會重建、重建的那一刻正在處理的請求看到哪一個值、兩台在不同時間生效 —— 每一個都要想。這個專案的設定（逾時、預算、重試、熔斷）大部分在啟動時就建成物件（例如 `RemoteInventoryApi` 的熔斷器與隔艙），換值就是換物件。
- 我們真的想要「線上調」的，目前只有日誌的等級；Spring Boot 的 actuator 有 `loggers` 端點可以做，這個專案沒有開放它（第 12 站 9.9：管理埠只開放 health、info、prometheus）。

一個這一章**沒有做**的改進：ConfigMap 現在是固定的名字。`kubectl rollout undo` 換回的是 pod 的樣板，**不包括 ConfigMap 的內容**；用 kustomize 的 `configMapGenerator`（名字帶內容的 hash），設定一改名字就變，滾動更新與回滾都會連設定一起帶著走。代價是 migration 的 Job 要跟應用程式在同一個 kustomization 裡才找得到新的名字（8.4.4 把它們分開了）。（📌 第 09 章寫完之後的追記：做了、量了，8.7.3。）

### 8.7.3 追記：configMapGenerator —— 設定跟著滾動更新與回滾走

📌 **第 09 章寫完之後補的。** 8.7.2 的最後一段說了一個沒有做的改進：ConfigMap 是固定的名字，`kubectl rollout undo` 換回 pod 的樣板、**不換回 ConfigMap 的內容**；用 kustomize 的 `configMapGenerator`（名字帶內容的 hash），設定一改名字就變，滾動更新與回滾都會帶著設定走。代價是 migration 的 Job 找不到新的名字。K14 把三件事都量一次，拿單體的付款期限當例子（K8 的做法：下單的回應相減），權重 100／0。generator 寫在 `target/k14` 的一個 overlay 裡，`k8s/` 底下沒有改：

```bash
mvn test -Pexperiments -Dtest=K14ConfigGeneratorTest
```

```
═══ 8.7.3 configMapGenerator：單體的付款期限（下單的回應相減），權重 100／0 ═══
  一開始：15 分鐘
  ① 固定名字的 ConfigMap：改成 20m、rollout restart → 20 分鐘；rollout undo → 20 分鐘（ConfigMap 裡還是 20m）
  ② configMapGenerator（monolith 換成 monolith-config-8t57bmkb4h）：apply → 15 分鐘
     改成 20m、只有 apply（沒有 rollout restart）→ 19.9 秒滾完（monolith-config-9g5g78h88g）→ 20 分鐘
     rollout undo → 15 分鐘（pod 指回 monolith-config-8t57bmkb4h）
     cluster 裡的 monolith 開頭的 ConfigMap：[monolith, monolith-config-8t57bmkb4h, monolith-config-9g5g78h88g]
  ③ Job 在另一個 kustomization、固定名字的 ConfigMap 不在了：copy terminated；flyway CreateContainerConfigError：configmap "monolith" not found
     Job 放進同一個 kustomization：第一次 apply → job.batch/migrate-inventory created │ job.batch/migrate-monolith created │ job.batch/migrate-order created
       Job 的 configMapKeyRef → monolith-config-9g5g78h88g
     改成 25m、再 apply → job.batch/migrate-inventory unchanged │ job.batch/migrate-order unchanged │ The Job "migrate-monolith" is invalid: spec.template: Invalid value: {"labels":{ … null,"SchedulingGroup":null}}: field is immutable
```

- **① 固定名字**：`rollout undo` 之後，pod 回到上一版的樣板，付款期限還是 20 分鐘 —— ConfigMap 不在樣板裡（8.7.2 說的，這一次量了）。
- **② configMapGenerator**：名字帶內容的 hash（`monolith-config-…`）。改成 20m，**只有 `apply`、沒有 `rollout restart`**，pod 的樣板指到新的名字，K8s 自己滾動更新（19.9 秒）；`rollout undo` 指回舊的名字，回到 15 分鐘 —— 設定跟著回滾走了。代價一：舊的那幾份 ConfigMap 還在 cluster 裡（`kubectl apply` 不刪；要 `--prune` 或一個 GitOps 的控制器，8.4.6）。
- **③ 代價二：migration 的 Job。** Job 在另一個 kustomization（8.4.4 的理由：Job 的 spec 不能改），它的 `configMapKeyRef` 寫的是固定的名字 —— generator 的名字它不知道：`CreateContainerConfigError: configmap "monolith" not found`。放進同一個 kustomization，名字跟著換了，第一次跑得起來；設定一改，Job 的樣板也跟著變，再 apply 就是 `field is immutable`。
- **決定**：這個專案不換。設定一改就要重開（8.7.2 的選擇：一次設定的改變 = 一次部署），而 rollout undo 帶不回設定這件事，靠的是「設定也在 git 裡」—— 回滾就是把那一個 commit revert、再部署一次（8.4.6 的 GitOps 正是這樣）。

> ⚠️ **第一版的 overlay 直接產生一個叫 `monolith` 的 ConfigMap**：kustomize 說 base 已經有一個（`behavior must be merge or replace`，K14 第一次的紀錄）；`replace` 的結果還是不帶 hash 的 `monolith` —— base 的那一個本來就不是 generator 產生的（這一句是寫作途中用一個最小的 overlay 重做的：kubectl 1.37.1 內建的 kustomize v5.8.1）。換一個名字、把每一個引用它的地方改過去，才帶得上 hash —— 這也是代價：換成 generator，引用它的每一份 manifest 都要改。

---

## 8.8 閘道：入口

### 8.8.1 Gateway API 與 Envoy Gateway

Gateway API 是 K8s 定義的一組資源，實作由一個控制器提供。它把入口拆成幾個角色各管各的：

- `GatewayClass`：用哪一個實作（這裡是 Envoy Gateway）。
- `Gateway`：一個入口，聽哪些埠 —— 通常是平台的人管。
- `HTTPRoute`：哪些路徑轉給哪個 Service —— 通常是服務的人管。

控制器用它的 release 裡的一份 manifest 裝（`scripts/d08-kind.sh gateway-api`）。這個系統的入口：

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: envoy
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
---
# 入口的 Envoy 怎麼部署、trace 送到哪裡。samplingRate 是百分比：抽樣的決定在入口做一次，後面的服務照著它（parent-based）
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: shop-edge
spec:
  provider:
    type: Kubernetes
    kubernetes:
      envoyService:
        type: NodePort
        patch:                                   # kind：這台筆電的 18880 → node 的 30080（原本是訂單服務的 NodePort）
          type: StrategicMerge
          value:
            spec:
              ports: [{port: 80, nodePort: 30080}]
  telemetry:
    tracing:
      samplingRate: 10
      provider:
        type: OpenTelemetry
        backendRefs: [{name: otel-collector, namespace: observability, port: 4317}]
---
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: shop
spec:
  gatewayClassName: envoy
  infrastructure:
    parametersRef: {group: gateway.envoyproxy.io, kind: EnvoyProxy, name: shop-edge}
  listeners:
    - {name: http, protocol: HTTP, port: 80}
```

```yaml
# 買家、賣家、管理員、金流的回呼：都是 /api/**，都到訂單服務。庫存服務沒有對外的路由（/internal/** 只給訂單服務）
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: shop-api
spec:
  parentRefs: [{name: shop}]
  rules:
    - matches: [{path: {type: PathPrefix, value: /api}}]
      backendRefs: [{name: order-service, port: 8080}]
```

只有一條路由：`/api/**` 到訂單服務。庫存服務沒有對外的路由 —— `/internal/**` 只給訂單服務。

`samplingRate: 10`：入口抽 10%。第 07 章 7.8 決定抽樣率 0.1，抽樣的決定現在移到入口做一次；後面的服務照著 parent 的決定走 —— 前提是它們接得上入口的 trace（8.8.2）。

### 8.8.2 trace 從入口開始：誰決定 traceId（K5）

入口一進來，第 12 站 9.8.4 那一條規則就有兩個方向的問題：

- 訂單服務**不收**入口的 `traceparent`（`TraceFilters` ⓪：`/api/**` 一律藏起來）→ 入口的 span 跟訂單服務的 span 永遠在兩個 trace 裡。
- 訂單服務**照收** → 買家自己寫的 `traceparent`，入口如果照轉，traceId 就是買家決定的（第 12 站 9.8.4 擋的就是這個）。

訂單服務分不出「入口寫的」與「買家寫、入口照轉的」。所以要三樣東西一起成立：

1. **入口拿掉買家帶來的 trace header**：

```yaml
# 入口的第一件事：買家自己帶來的 trace header 一律拿掉（第 12 站 9.8.4 的規則，搬到入口做）。
# earlyRequestHeaders 在 Envoy 做 tracing 之前：不拿掉的話，Envoy 會接著買家給的 traceId 往下記（8.8.2 量到的：帶著 traceparent 的 20 個請求，
# 抽到的 4 個用的都是買家給的 traceId），後面的服務再接著它 —— 買家決定了 traceId
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: ClientTrafficPolicy
metadata:
  name: shop-edge
spec:
  targetRefs:
    - {group: gateway.networking.k8s.io, kind: Gateway, name: shop}
  headers:
    earlyRequestHeaders:
      remove: [traceparent, tracestate, b3, x-b3-traceid, x-b3-spanid, x-b3-parentspanid, x-b3-sampled, x-b3-flags]
```

（註解裡的「20 個請求、抽到 4 個」是寫這一章途中的那一次；最後一輪是 100 個、抽到 12 個，下面 K5 的 ①。）

2. **訂單服務信任入口**：一個部署的設定，預設關著：

```diff
 import jakarta.servlet.ServletException;
 import jakarta.servlet.http.HttpServletRequest;
 import jakarta.servlet.http.HttpServletResponse;
+import com.example.shop.shared.config.ShopProperties;
 import com.example.shop.shared.security.ServiceTokens;
 import org.slf4j.MDC;
 import org.springframework.beans.factory.ObjectProvider;
…
      * 13 站 7.5：例外只有一種 —— 自己的另一個服務。/internal/** 的請求、帶著一個發給我的服務 token（ServiceTokens 驗得過：
      * 服務的金鑰、到期、iss、aud = 我）→ 照收：訂單服務的 traceparent 要接上，不然庫存服務的每一個 span 都是另一個 trace 的根（7.2）。
      * 這裡比 Spring Security 早（它在 -100）：token 在這裡多驗一次。單體沒有 ServiceTokens（只在兩個服務的角色裡）→ 一律不收，跟第 12 站一樣
+     *
+     * 13 站第 08 章：第二個例外 —— 自己的入口。前面有了 gateway，買家的請求是 gateway 轉過來的，/api/** 的 traceparent 是 gateway 寫的：
+     * 不收的話，gateway 的 span 跟這個服務的 span 永遠在兩個 trace 裡（8.8.2 量到的）。可是這個服務分不出「gateway 寫的」與「買家自己寫、
+     * gateway 照轉的」—— 所以由部署來保證：入口拿掉買家帶來的 trace header、只有入口連得到這個服務，部署才打開 shop.deployment.edge.trust-traceparent
      */
     @Bean
-    FilterRegistrationBean<OncePerRequestFilter> dropIncomingTraceHeaders(ObjectProvider<ServiceTokens> serviceTokens) {
+    FilterRegistrationBean<OncePerRequestFilter> dropIncomingTraceHeaders(ObjectProvider<ServiceTokens> serviceTokens, ShopProperties props) {
         ServiceTokens tokens = serviceTokens.getIfAvailable();
+        boolean trustEdge = props.deployment().edge().trustTraceparent();
         FilterRegistrationBean<OncePerRequestFilter> reg = new FilterRegistrationBean<>(new OncePerRequestFilter() {
             @Override
             protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
-                if (fromOurService(req, tokens)) {
+                if (fromOurService(req, tokens) || trustEdge && req.getRequestURI().startsWith("/api/")) {
                     chain.doFilter(req, res);
                     return;
                 }
```

```java
     * 13 站第 08 章：這個服務前面的入口（gateway）。trustTraceparent：/api/** 的 traceparent 是入口寫的、可以接 ——
     * 只有在「入口會把買家自己帶來的 trace header 拿掉、而且只有入口連得到這個服務」的部署裡才能打開（k8s/gateway 的 ClientTrafficPolicy、
     * k8s/base 的 NetworkPolicy）。預設關著：第 12 站 9.8.4 的規則，外面帶進來的一律不收
     */
    public record Edge(@DefaultValue("false") boolean trustTraceparent) {}
```

3. **只有入口連得到訂單服務**：

```yaml
# 誰連得到誰（網路這一層）。服務 token（3.6）證明「是誰」，這裡保證「只有該來的連得到」——
# shop.deployment.edge.trust-traceparent 要靠它：只有入口連得到訂單服務的 8080，/api/** 的 traceparent 才一定是入口寫的。
# 只列 ingress（誰可以連進來）；連出去（MySQL、Redis、RabbitMQ、Collector）不限。kubelet 的探測從 node 來，不受 NetworkPolicy 影響
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: order-service
spec:
  podSelector: {matchLabels: {app: order-service}}
  policyTypes: [Ingress]
  ingress:
    - from:                                      # 8080：只有入口（Envoy Gateway 為 shop 這個 Gateway 起的 Envoy）
        - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: envoy-gateway-system}}
          podSelector: {matchLabels: {gateway.envoyproxy.io/owning-gateway-name: shop}}
      ports: [{port: 8080}]
    - from:                                      # 8081（管理埠）：Prometheus
        - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: observability}}
      ports: [{port: 8081}]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: inventory-service
spec:
  podSelector: {matchLabels: {app: inventory-service}}
  policyTypes: [Ingress]
  ingress:
    - from:                                      # 8080（/internal/**）：只有訂單服務
        - podSelector: {matchLabels: {app: order-service}}
      ports: [{port: 8080}]
    - from:
        - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: observability}}
      ports: [{port: 8081}]
```

kind 的網路外掛（kindnet）會執行 NetworkPolicy：套上之後，cluster 裡另一個 pod 連訂單服務的 8080 逾時（下面 K5 的 c），經過入口照樣 200，探針與 Prometheus（8081）照常（K5 之後的實驗都在這個設定下跑）。庫存服務的 8080 也一樣逾時 —— 這一條是寫作途中用一個 curl 的 pod 手動試的，沒有留下紀錄。

K5 把這三樣拆開來量，四種組合、同一組量法：

- a. 經過入口下 100 張單：入口抽到的 trace 有幾個接上了訂單服務與庫存服務。
- b. 經過入口、自己帶 `traceparent`（每一個不同的 traceId）100 次：用了買家給的 traceId 的 trace、`X-Trace-Id` 是買家給的，各有幾個。
- c. 不經過入口：cluster 裡另一個 pod 直接打訂單服務、自己帶 `traceparent`。

```
═══ 8.8.2 入口進來之後：trace 從哪裡開始、誰決定 traceId ═══
  ① 入口照收買家的 trace header、訂單服務不收入口的、沒有 NetworkPolicy
    a. 經過入口下單 100 張（201 有 100 張）：入口抽到的 trace 14 個，接上訂單服務的 0 個、訂單＋庫存都接上的 0 個；回應的 X-Trace-Id 是入口的 traceId 的 0 個
    b. 經過入口、自己帶 traceparent 100 次：入口抽到的 trace 12 個，用了買家給的 traceId 的 12 個；回應的 X-Trace-Id 是買家給的 0 個
    c. cluster 裡另一個 pod 直接打訂單服務的 8080、自己帶 traceparent：HTTP/1.1 200，X-Trace-Id 不是它給的
```

```
  ② 訂單服務收入口的、有 NetworkPolicy，但入口照收買家的
    a. 經過入口下單 100 張（201 有 100 張）：入口抽到的 trace 9 個，接上訂單服務的 9 個、訂單＋庫存都接上的 9 個；回應的 X-Trace-Id 是入口的 traceId 的 9 個
    b. 經過入口、自己帶 traceparent 100 次：入口抽到的 trace 4 個，用了買家給的 traceId 的 4 個；回應的 X-Trace-Id 是買家給的 100 個
    c. cluster 裡另一個 pod 直接打訂單服務的 8080、自己帶 traceparent：連不上（curl 3 秒逾時）
```

```
  ③ 入口拿掉買家的、訂單服務收入口的、沒有 NetworkPolicy
    a. 經過入口下單 100 張（201 有 100 張）：入口抽到的 trace 7 個，接上訂單服務的 7 個、訂單＋庫存都接上的 7 個；回應的 X-Trace-Id 是入口的 traceId 的 7 個
    b. 經過入口、自己帶 traceparent 100 次：入口抽到的 trace 9 個，用了買家給的 traceId 的 0 個；回應的 X-Trace-Id 是買家給的 0 個
    c. cluster 裡另一個 pod 直接打訂單服務的 8080、自己帶 traceparent：HTTP/1.1 200，X-Trace-Id 是它給的
```

```
  ④ 三樣都有
    a. 經過入口下單 100 張（201 有 100 張）：入口抽到的 trace 14 個，接上訂單服務的 14 個、訂單＋庫存都接上的 14 個；回應的 X-Trace-Id 是入口的 traceId 的 14 個
    b. 經過入口、自己帶 traceparent 100 次：入口抽到的 trace 7 個，用了買家給的 traceId 的 0 個；回應的 X-Trace-Id 是買家給的 0 個
    c. cluster 裡另一個 pod 直接打訂單服務的 8080、自己帶 traceparent：連不上（curl 3 秒逾時）
```

- **①**：入口抽到的 14 個 trace，沒有一個接上訂單服務 —— 訂單服務把入口的 `traceparent` 藏起來了，它的 span 在另一個 trace 裡。自己帶 `traceparent` 的 100 個，入口抽到 12 個，**12 個用的都是買家給的 traceId**：Envoy 預設接著上游給的 trace 往下記。
- **②**：只打開訂單服務的信任，入口照收。入口的 trace 都接上了（9 個裡 9 個）；可是**買家自己帶的 100 個，`X-Trace-Id` 全部是買家給的** —— 第 12 站 9.8.4 擋掉的事，從入口繞回來了：稽核表的 `trace_id`、客服拿去查的那一串，都由買家決定。入口只抽到其中 4 個，另外 96 個它沒有記，照樣把買家的 traceId 往下傳。
- **③**：入口拿掉之後，經過入口的都安全了（0 個）；可是 cluster 裡任何一個 pod 直接打訂單服務的 8080，traceId 還是它說了算。
- **④**：三樣都有。入口抽到的 14 個全部接上訂單服務與庫存服務；回應的 `X-Trace-Id` 就是入口的 traceId —— 客服拿到的那一串，在 Jaeger 裡從入口開始。

最後，在 ④ 的設定下付一次款，找一條被入口抽到的 —— README 產出第 4 項的那一條：

```
  ④ 付款的回呼（第 17 張才被入口抽到）：traceId d50feff9deb9ff6a406f6e4509e343e0，服務 [inventory-service, order-service, shop.shop]
      trace d50feff9deb9ff6a406f6e4509e343e0：15 個 span，第一個開始到最後一個結束 105.0 ms
           +0.0 ms        9.9 ms  [shop.shop] ingress SERVER
           +0.1 ms        9.8 ms    [shop.shop] router httproute/shop/shop-api/rule/0 egress CLIENT
           +0.5 ms        9.3 ms      [order-service] http post /api/payments/callback SERVER  exception=none status=200 uri=/api/payments/callback
           +1.9 ms        7.3 ms        [order-service] db connection INTERNAL
                                        · +0.6 ms acquired
          +84.3 ms       20.7 ms        [order-service] consume notification.order-events CONSUMER
          +84.5 ms        4.8 ms          [order-service] db connection INTERNAL
                                          · +0.0 ms acquired
          +89.3 ms        0.6 ms          [order-service] db connection INTERNAL
                                          · +0.0 ms acquired
          +90.0 ms        2.7 ms          [order-service] db connection INTERNAL
                                          · +0.0 ms acquired
          +93.3 ms        2.8 ms          [order-service] db connection INTERNAL
                                          · +0.0 ms acquired
          +96.1 ms        3.5 ms          [order-service] db connection INTERNAL
                                          · +0.0 ms acquired
          +99.6 ms        0.3 ms          [order-service] db connection INTERNAL
                                          · +0.0 ms acquired
         +100.0 ms        1.6 ms          [order-service] db connection INTERNAL
                                          · +0.0 ms acquired
         +101.8 ms        3.2 ms          [order-service] db connection INTERNAL
                                          · +0.0 ms acquired
          +84.4 ms        8.0 ms        [inventory-service] consume inventory.order-events CONSUMER
          +85.5 ms        6.2 ms          [inventory-service] db connection INTERNAL
```

15 個 span：入口兩個（`ingress`、轉給訂單服務的 `router … egress`）、訂單服務處理回呼與它借的連線；84 ms 之後，兩個服務的消費者接在回呼的那一個 span 底下（第 07 章 7.6：outbox 記住寫它的那一個 span）—— 中間那 84 ms，事件在 outbox、relay 與 RabbitMQ 裡。README 產出第 4 項的「Gateway → 訂單 → MQ → 庫存」，就是這一條。

`EdgeTraceparentTest` 守著「打開時接、關著時不接」（關著的那一半是驗收 Q7 ⑤）：

```
13 站 8.8.2：trust-traceparent=true → /api/ping 的 X-Trace-Id 0af7651916cd43dd8448eb211c80319c；/actuator/health c4492d77e9d17d67cc5fdcb2314f8b35
```

### 8.8.3 入口後面的「每個 IP」（K6）

`RateLimitFilter` 用 `request.getRemoteAddr()` 數「每個 IP 每秒 50 次」。入口後面，訂單服務看到的對方永遠是入口的 Envoy —— **每一個買家都是同一個 IP**。

這台筆電只有一個來源 IP。K6 用 `X-Forwarded-For` 假裝是很多買家：每秒 80 個商品頁、20 秒，每一個請求帶 `203.0.113.0`～`249` 其中一個（文件用的位址）—— 就像入口前面還有一層負載平衡器，它寫下了買家的 IP。負載中途掃一次 Redis：限流的 key（`rl:ip:<IP>:<那一秒>`）用的是哪些 IP。

```
═══ 8.8.3 入口後面的「每個 IP 每秒 50 次」：每秒 80 個商品頁、20 秒，每一個帶不同的 X-Forwarded-For（250 個買家）═══
  ① 訂單服務不看 X-Forwarded-For：{200=1019, 429=581}；負載中途 Redis 裡限流的 key 有 1 個不同的 IP（例如 [10.244.0.16]）
  ② server.forward-headers-strategy=native：{200=1030, 429=570}；負載中途 Redis 裡限流的 key 有 1 個不同的 IP（例如 [172.64.144.78]）
  ③ 同 ②，請求從 cluster 裡的 pod 送到入口：{200=1600}；負載中途 Redis 裡限流的 key 有 76 個不同的 IP（例如 [203.0.113.0, 203.0.113.1, 203.0.113.10]）
```

- **①**：限流的 key 只有一個 IP —— `10.244.0.16`，入口那個 Envoy 的 pod。每秒 80 個、上限 50：581 個 429（36%，跟「每秒超過的那 30 個」差不多）。正式環境裡，這就是**全站**每秒只放 50 個請求進來。
- **②**：打開 forward headers，key 變成 `172.64.144.78` —— Envoy 看到的、這台筆電經過 Docker Desktop 進到 kind 的位址。它不是私有位址，`RemoteIpValve` 停在它那裡：**買家自己寫的 `X-Forwarded-For` 被忽略了**（它在更左邊）。在 kind 上這是對的：所有的請求確實都來自同一台機器。
- **③**：從 cluster 裡的一個 pod（私有位址）送到入口 —— 正式環境的樣子：入口前面那一層負載平衡器在 VPC 裡，它寫下買家的 IP，它自己的位址是私有的。1,600 個全部 200；負載中途，Redis 裡有 76 個不同的買家 IP 正在被數。

```yaml
  SERVER_FORWARD_HEADERS_STRATEGY: native
```

（`k8s/base/config.yaml`，8.4.3。）`native`：Tomcat 的 `RemoteIpValve` 從 `X-Forwarded-For` 的右邊往左看，略過「內部的代理」（預設是私有位址：`10.*`、`172.16`～`31.*`、`192.168.*`……），第一個不是的就是買家。它能信任的前提，跟 8.8.2 一樣：只有入口連得到訂單服務。

⚠️ K6 第一版的 ③ 用 `curl --parallel --rate 80/s`：`--rate` 在 `--parallel` 底下沒有作用，1,600 個請求幾秒內送完、100 個失敗，Redis 裡也掃不到任何一個 key（負載早就結束了）。改成 4 個 `curl` 同時跑、各自一個一個送、每秒 20 個。

### 8.8.4 兩層閘道（K11）

README 原本的誤區寫的是「用了 Spring Cloud Gateway 又用 K8s Ingress，兩套路由規則互相打架」（這一章之後改成 8.14 的說法）。路由規則不只是路徑，還有**重試與逾時**。K11 在入口後面放一個 Spring Cloud Gateway（實驗用，`lab/scg`），它只有一條路由，加上很多人會順手加的那一行：

```yaml
# 一個團隊「在應用程式這一層」加的閘道：/api/** 轉給訂單服務，順手加上重試（Retry=3 的預設：GET、5xx、再送 3 次）
server:
  port: 8080
spring:
  cloud:
    gateway:
      routes:
        - id: shop-api
          uri: http://order-service:8080
          predicates: [Path=/api/**]
          filters: [Retry=3]
```

`Retry=3` 的預設：GET、5xx、再送 3 次。另一個團隊在入口也加了重試：

```yaml
# 13 站第 08 章的實驗：另一個團隊在入口這一層也加了重試（Envoy Gateway 的 BackendTrafficPolicy：再送 2 次，條件含 503）
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: BackendTrafficPolicy
metadata:
  name: shop-api-retry
spec:
  targetRefs:
    - {group: gateway.networking.k8s.io, kind: HTTPRoute, name: shop-api}
  retry:
    numRetries: 2
    retryOn:
      triggers: [connect-failure, retriable-status-codes]
      httpStatusCodes: [503]
```

庫存服務縮到 0 台，讓兩種請求都會 503：`GET /api/admin/orders/{orderNo}/saga`（管理員看一張單的 Saga，要問庫存服務，第 04 章）與下單。三種部署各送 10 個，數訂單服務那一邊收到幾次：

```
═══ 8.8.4 兩層閘道、各自的重試：庫存服務 0 台，GET（Saga）與 POST（下單）各送 10 個 ═══
  ① 入口 → 訂單服務（40.8 秒）
    GET  Saga：買家拿到 {503=10}（平均 2.0 秒、最長 2.1 秒）；訂單服務收到 10 次
    POST 下單：買家拿到 {503=10}（平均 2.0 秒、最長 2.0 秒）；訂單服務收到 10 次
    訂單服務呼叫庫存服務「沒有回應」40 次
```

```
  ② 入口 → Spring Cloud Gateway（Retry=3）→ 訂單服務（102.8 秒）
    GET  Saga：買家拿到 {503=10}（平均 8.2 秒、最長 8.6 秒）；訂單服務收到 40 次
    POST 下單：買家拿到 {503=10}（平均 2.0 秒、最長 2.1 秒）；訂單服務收到 10 次
    訂單服務呼叫庫存服務「沒有回應」100 次
```

```
  ③ 入口（再送 2 次）→ Spring Cloud Gateway（Retry=3）→ 訂單服務（211.6 秒）
    GET  Saga：買家拿到 {504=10}（平均 15.0 秒、最長 15.0 秒）；訂單服務收到 80 次
    POST 下單：買家拿到 {503=10}（平均 6.1 秒、最長 6.2 秒）；訂單服務收到 30 次
    訂單服務呼叫庫存服務「沒有回應」222 次
```

- **①**：一個請求，訂單服務收到 1 次。它呼叫庫存服務送 2 次（第 06 章：沒有回應，再送一次）；庫存服務 0 台，每一次送出都沒有回應 —— 每一個請求 2.0 秒、「沒有回應」40 次（從時間推：每一次都等滿了 1 秒的 connect timeout）。
- **②**：Spring Cloud Gateway 的 `Retry=3`：GET 在訂單服務變成 40 次（10 × 4），買家平均等 8.2 秒才拿到 503。POST 沒有被重送：`Retry` 預設只重送 GET。
- **③**：入口也加了重試。GET 的買家拿到的是 **504，每一個都是 15.0 秒** —— Envoy 的路由預設逾時 15 秒（Envoy 的文件：`RouteAction.timeout` 沒有設就是 15s，<https://www.envoyproxy.io/docs/envoy/latest/api-v3/config/route/v3/route_components.proto>）。在那 15 秒裡，入口送了 2 輪，每一輪 Spring Cloud Gateway 送 4 次：訂單服務收到 80 次。第 2 輪還在跑的時候，買家已經拿到 504 了 —— **外層早就放棄了，內層還在跑**（第 06 章 6.4 的那一種）。POST：入口的重試不分方法，送了 3 次（30 次）；如果庫存服務好好的，這三次靠的是同一個 `Idempotency-Key` 才不會變成三張訂單（這裡庫存服務是 0 台，一張都沒有成立）。
- 往裡面一層看：訂單服務呼叫庫存服務「沒有回應」的次數，40 → 100 → 222。

三層（入口、Spring Cloud Gateway、訂單服務）各自「再送幾次」，誰都沒有錯 —— 乘起來就是第 06 章 6.3.5 的那張表。**有邏輯的閘道只能有一層**；平台的入口只做 TLS 與轉發，不設重試，逾時比裡面那一層長。

⚠️ 實驗用的 Spring Cloud Gateway 第一版跟訂單服務一樣用 Boot 3.2.5，配 Spring Cloud 2023.0.6（2023.0 支援 Boot 3.2.x，8.3.2）。它起得來，第一個請求就壞：

```
java.lang.NoSuchMethodError: 'java.util.Set org.springframework.http.HttpHeaders.headerSet()'
	at org.springframework.cloud.gateway.filter.headers.RemoveHopByHopHeadersFilter.filter(RemoveHopByHopHeadersFilter.java:77)
```

`HttpHeaders.headerSet()` 是 spring-web 6.1.15 才有的（6.1.14 沒有）；Boot 3.2.5 帶的是 6.1.6。Spring Cloud 啟動時的相容性檢查沒有擋下它：Boot 3.2.x 在 2023.0 支援的範圍裡。換成 Boot 3.2 的最後一版 3.2.12（Spring Framework 6.1.15）就好了。**選了 Spring Cloud，就多一個要跟著 Boot 一起升的東西**，而且「同一個 release train」不代表每一個 patch 都跟你的 Boot 相容。

---

## 8.9 觀測的基礎設施

### 8.9.1 Prometheus 自己找 target（K7）

第 07 章演練用的 Prometheus，一個 job 寫死一個位址。K8s 上改用 `kubernetes_sd`：問 K8s「shop 這個 namespace 現在有哪些 pod」，留下帶著 `system=shop`、而且有一個叫 `management` 的埠的那幾個：

```yaml
# Prometheus 不再寫死位址：kubernetes_sd 問 K8s「shop 這個 namespace 現在有哪些 pod」，留下帶著 system=shop、
# 而且有一個叫 management 的埠的那幾個（管理埠，第 12 站 9.9），job 用 pod 的 app 標籤。庫存服務多一台，下一次刷新它就在 target 裡。
# 讀 shop 的 pod 的權限，由 shop 那一邊給（k8s/base/prometheus-access.yaml）：這個資料夾的 namespace 會蓋掉寫在 Role 上的 namespace
apiVersion: v1
kind: ServiceAccount
metadata:
  name: prometheus
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-config
data:
  prometheus.yml: |
    global: {scrape_interval: 15s, evaluation_interval: 15s}
    rule_files: [/etc/prometheus/rules/alerts.yml]
    scrape_configs:
      - job_name: shop
        metrics_path: /actuator/prometheus
        kubernetes_sd_configs:
          - role: pod
            namespaces: {names: [shop]}
        relabel_configs:
          - source_labels: [__meta_kubernetes_pod_label_system]
            regex: shop
            action: keep
          - source_labels: [__meta_kubernetes_pod_container_port_name]
            regex: management
            action: keep
          - source_labels: [__meta_kubernetes_pod_label_app]
            target_label: job                            # order-service、inventory-service（7.9 的兩個 job）
          - source_labels: [__meta_kubernetes_pod_label_system]
            target_label: system                         # 告警規則認這個（7.9.2）
          - source_labels: [__meta_kubernetes_pod_name]
            target_label: pod
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: prometheus
  labels: {app: prometheus}
spec:
  replicas: 1
  selector:
    matchLabels: {app: prometheus}
  template:
    metadata:
      labels: {app: prometheus}
    spec:
      serviceAccountName: prometheus
      containers:
        - name: prometheus
          image: prom/prometheus:v3.5.0
          args: ["--config.file=/etc/prometheus/prometheus.yml", "--storage.tsdb.retention.time=2d", "--enable-feature=exemplar-storage"]
          ports:
            - {name: web, containerPort: 9090}
          readinessProbe:
            httpGet: {path: /-/ready, port: web}
          volumeMounts:
            - {name: config, mountPath: /etc/prometheus}
            - {name: rules, mountPath: /etc/prometheus/rules}
          resources:
            requests: {cpu: 100m, memory: 256Mi}
            limits: {memory: 512Mi}
      volumes:
        - {name: config, configMap: {name: prometheus-config}}
        - {name: rules, configMap: {name: prometheus-rules}}
---
apiVersion: v1
kind: Service
metadata:
  name: prometheus
spec:
  type: NodePort                               # 這台筆電的入口（kind：18890 → 30090）
  selector: {app: prometheus}
  ports:
    - {name: web, port: 9090, targetPort: web, nodePort: 30090}
```

讀 shop 的 pod 的權限，由 shop 那一邊給：

```yaml
# observability 的 Prometheus 可以看 shop 這個 namespace 有哪些 pod（kubernetes_sd）—— 只有 list／watch pod，不能讀 Secret、不能改任何東西。
# 放在 shop 這一邊：誰能看這個 namespace，由這個 namespace 決定。
# （第一版放在 k8s/observability：那個資料夾的 kustomization 把 Role 的 namespace 也改成 observability，Prometheus 的日誌一直是 forbidden，target 是空的）
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: prometheus-discovery
rules:
  - apiGroups: [""]
    resources: [pods]
    verbs: [get, list, watch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: prometheus-discovery
roleRef: {apiGroup: rbac.authorization.k8s.io, kind: Role, name: prometheus-discovery}
subjects:
  - {kind: ServiceAccount, name: prometheus, namespace: observability}
```

⚠️ 第一版的 Role 與 RoleBinding 寫在 `k8s/observability`，`metadata` 裡寫明了 `namespace: shop`。可是那個資料夾的 `kustomization.yaml` 有 `namespace: observability` —— kustomize 把它們都改成了 `observability`。Prometheus 的日誌一直是：

```
failed to list *v1.Pod: pods is forbidden: User "system:serviceaccount:observability:prometheus" cannot list resource "pods" in API group "" in the namespace "shop"
```

target 是空的，K0 第一版印出 `[]`。搬到 `k8s/base` 之後，Prometheus 在下一次重試時找到了三個 target。

K7：庫存服務 2 台 → 3 台 → 1 台 → 0 台，每一步等 target 跟上；0 台的時候每秒 2 張下單、每 15 秒問一次告警，看 4 分鐘。先用第 12 站（第 07 章改過）的規則：

```
═══ 8.9.1 Prometheus 的 kubernetes_sd：庫存服務擴縮時的 target 與告警 ═══
  一開始：{gb94p=up, k7ftm=up}
  kubectl scale --replicas=3 → 23 秒後 target 是 {gb94p=up, k7ftm=up, rkpqn=up}
  kubectl scale --replicas=1 → 16 秒後 target 是 {gb94p=up}
  kubectl scale --replicas=0，接下來 240 秒（每秒 2 張下單：[201=25, 503=457]）：
    第   0 秒 庫存服務的 target：{gb94p=up}
    第  15 秒 庫存服務的 target：{}
    第  15 秒 ShopDown{inventory-service} pending
    第  60 秒 ShopHigh5xxRatio pending
    第  60 秒 ShopPlaceOrderSlow pending
    第  60 秒 ShopDown{inventory-service} 解除
  （up{job="inventory-service"} 現在有 0 條序列）
```

- **擴縮的時候，target 自己跟上**：擴成 3 台 23 秒、縮成 1 台 16 秒，`prometheus.yml` 一個字都沒改。I1 的「Prometheus 只看得到 A」不會再發生。
- **縮到 0 台**：第 15 秒，target 變成空的。`ShopDown` 在 pending —— 最後一次抓的時候 pod 正在關，抓不到，`up == 0`；第 60 秒它**自己解除了**：target 消失之後，`up` 那一條序列也沒了，「`up == 0`」不再成立。
- 4 分鐘裡 457 張下單 503。還在 pending 的只有 `ShopHigh5xxRatio` 與 `ShopPlaceOrderSlow`（`for: 5m`）—— 它們要有人下單才會響；半夜沒有人下單，整個庫存服務不見了，什麼都不會響。

加一條不寫死 job 名字的規則（第 07 章 7.9.2 的教訓）：

```diff
         annotations:
           summary: "Prometheus 抓不到 {{ $labels.instance }}"
           why: "連指標都抓不到"
+      # 13 站 8.9.1：K8s 上，被刪掉的 pod 不會變成 up == 0 —— 它直接從 target 裡消失（kubernetes_sd）。庫存服務整個縮到 0 台：
+      # ShopDown pending 30 秒之後自己解除，從來沒有響（8.9.1 量到的）。這一條不寫死 job 的名字（7.9.2）：15 分鐘內出現過的 job，
+      # 現在一個 up 的 target 都沒有。compose 的單體停掉時它跟 ShopDown 一起響（同一個事故兩條，Alertmanager 的抑制沒有設，7.11）
+      - alert: ShopServiceGone
+        expr: count by (job) (max_over_time(up{system="shop"}[15m])) unless count by (job) (up{system="shop"} == 1)
+        for: 1m
+        labels: {severity: page}
+        annotations:
+          summary: "{{ $labels.job }} 一個能抓到指標的實例都沒有"
+          why: "整個服務不見了（縮到 0、每一台都起不來），或每一台都抓不到"
       - alert: ShopRedisDegraded
         expr: sum(increase(shop_redis_trips_total{system="shop"}[5m])) > 0
         labels: {severity: warning}
```

（註解裡的「pending 30 秒之後自己解除」是寫這一章途中的那一次；最後一輪的舊規則是第 15 秒 pending、第 60 秒解除，上面的紀錄。）

promtool 的測試餵它 K8s 的形狀：兩台、先縮掉一台、再縮掉另一台：

```diff
         exp_alerts:
           - exp_labels: {severity: page, job: inventory-service}
             exp_annotations: {summary: "inventory-service：最舊的未送出事件已經 1m 15s", why: "0.6.6、0.6.4（落帳、通知 60 秒）。9.2.1 那一種（relay 被卡住）就是靠它看見的"}
+  # 13 站 8.9.1：K8s 的形狀。庫存服務兩台：b 第 2 分鐘縮掉（序列變 stale），a 第 4 分鐘也縮掉；訂單服務一直在
+  - interval: 15s
+    input_series:
+      - series: 'up{job="inventory-service",system="shop",pod="inventory-a"}'
+        values: '1x16 stale'
+      - series: 'up{job="inventory-service",system="shop",pod="inventory-b"}'
+        values: '1x8 stale'
+      - series: 'up{job="order-service",system="shop",pod="order-a"}'
+        values: '1x40'
+    alert_rule_test:
+      - {eval_time: 3m, alertname: ShopServiceGone, exp_alerts: []}         # 少了一台：不響
+      - {eval_time: 3m, alertname: ShopDown, exp_alerts: []}
+      - {eval_time: 4m30s, alertname: ShopServiceGone, exp_alerts: []}      # 一台都沒有了，pending（for 1m）
+      - eval_time: 5m30s
+        alertname: ShopServiceGone
+        exp_alerts:
+          - exp_labels: {severity: page, job: inventory-service}
+            exp_annotations: {summary: "inventory-service 一個能抓到指標的實例都沒有", why: "整個服務不見了（縮到 0、每一台都起不來），或每一台都抓不到"}
+      - {eval_time: 5m30s, alertname: ShopDown, exp_alerts: []}             # target 消失，不是 down：第 12 站那一條不會響
+
```

```
  SUCCESS: 20 rules found
  SUCCESS
```

同一個實驗，新的規則：

```
  kubectl scale --replicas=0，接下來 240 秒（每秒 2 張下單：[201=26, 503=456]）：
    第   0 秒 庫存服務的 target：{fmbnj=up}
    第  15 秒 庫存服務的 target：{}
    第  15 秒 ShopDown{inventory-service} pending
    第  45 秒 ShopHigh5xxRatio pending
    第  45 秒 ShopPlaceOrderSlow pending
    第  45 秒 ShopServiceGone{inventory-service} pending
    第  45 秒 ShopDown{inventory-service} 解除
    第 105 秒 ShopServiceGone{inventory-service} firing
  （up{job="inventory-service"} 現在有 0 條序列）
```

`ShopServiceGone{inventory-service}` 第 45 秒 pending、**第 105 秒 firing**（`for: 1m`，加上每 15 秒一次的抓取與評估）。`ShopDown` 一樣在第 45 秒自己解除了 —— 它在 K8s 上剩下的意思是：「這一個 pod 還在，可是抓不到」（8.5.2 卡住的那一台就是這一種；K4 沒有看告警，它那時候響不響沒有量）。

📌 **第 09 章寫完之後的追記：抑制設了。** `ShopServiceGone{job}` 響的時候，同一個 `job` 的 `ShopDown` 不送；Alertmanager 也改成照 severity 分組（一個事故一張單）。H7 把 compose 上單體停掉的那一對告警送進 Alertmanager：原本兩張單，現在一張、只有 `ShopServiceGone`（第 07 章 7.11.1）。

### 8.9.2 span 送到一個名字：Collector

`SHOP_OTLP_ENDPOINT` 現在是 `http://otel-collector.observability:4318/v1/traces`（8.4.3）—— 一個 Service 的名字，後面是一個 OpenTelemetry Collector，再後面才是 Jaeger：

```yaml
# 應用程式只認得這一個位址（SHOP_OTLP_ENDPOINT = http://otel-collector.observability:4318/v1/traces）。
# 後面接的是 Jaeger、換成別的後端、或多送一份，改的是這裡，不是應用程式
apiVersion: v1
kind: ConfigMap
metadata:
  name: otel-collector-config
data:
  config.yaml: |
    receivers:
      otlp:
        protocols:
          http: {endpoint: 0.0.0.0:4318}               # 兩個服務（Micrometer 的 OTLP/HTTP）
          grpc: {endpoint: 0.0.0.0:4317}               # 入口的 Envoy（它的 OpenTelemetry tracer 只送 gRPC）
    processors:
      memory_limiter: {check_interval: 1s, limit_percentage: 80, spike_limit_percentage: 20}
      batch: {}
    exporters:
      otlp/jaeger:
        endpoint: jaeger:4317
        tls: {insecure: true}
    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [memory_limiter, batch]
          exporters: [otlp/jaeger]
      telemetry:
        metrics:
          readers: [{pull: {exporter: {prometheus: {host: 0.0.0.0, port: 8888}}}}]
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: otel-collector
  labels: {app: otel-collector}
spec:
  replicas: 1
  selector:
    matchLabels: {app: otel-collector}
  template:
    metadata:
      labels: {app: otel-collector}
    spec:
      containers:
        - name: collector
          image: otel/opentelemetry-collector-contrib:0.162.0
          args: ["--config=/etc/otelcol/config.yaml"]
          ports:
            - {name: otlp-http, containerPort: 4318}
            - {name: otlp-grpc, containerPort: 4317}
            - {name: metrics, containerPort: 8888}
          volumeMounts:
            - {name: config, mountPath: /etc/otelcol}
          resources:
            requests: {cpu: 100m, memory: 128Mi}
            limits: {memory: 256Mi}
      volumes:
        - {name: config, configMap: {name: otel-collector-config}}
---
apiVersion: v1
kind: Service
metadata:
  name: otel-collector
spec:
  selector: {app: otel-collector}
  ports:
    - {name: otlp-http, port: 4318, targetPort: otlp-http}
    - {name: otlp-grpc, port: 4317, targetPort: otlp-grpc}
    - {name: metrics, port: 8888, targetPort: metrics}
---
# 入口的 Envoy（shop 這個 namespace 的 EnvoyProxy）可以把 span 送到這個 namespace 的 otel-collector。
# Gateway API 的規則：跨 namespace 的引用，要被引用的那一邊同意
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: shop-edge-tracing
spec:
  from: [{group: gateway.envoyproxy.io, kind: EnvoyProxy, namespace: shop}]
  to: [{group: "", kind: Service, name: otel-collector}]
```

多一跳，換來的是：後端換成別的、多送一份、在 span 的路上做事（例如第 07 章 7.8.3 的尾端抽樣），都只改這裡，應用程式不用動。

入口的 Envoy 送到 4317（OTLP/gRPC），所以 Collector 多聽一個 4317 —— K0 印出的服務裡有 `shop.shop`，就是從這裡來的。設定裡的註解說 Envoy「只送 gRPC」，說得太滿：我沒有查 Envoy 能不能改用 HTTP 送，只用了 Envoy Gateway 這樣設的結果。跨 namespace 的引用，Gateway API 的規則是要被引用的那一邊用 `ReferenceGrant` 同意；沒有它會怎樣，這裡沒有試。

尾端抽樣這一章**沒有做**：它要每一個服務都送 100% 的 span 到 Collector（第 07 章 7.8.2 量過，後端收到的量差 10 倍），規則（錯誤、慢的、其他抽 10%）寫在 Collector 的 `tail_sampling`。（📌 第 09 章寫完之後的追記：寫了、量了，第 07 章 7.8.4。）

### 8.9.3 Jaeger 的資料放在哪裡（K9）

第 07 章 compose 的 Jaeger 是 v1 的 all-in-one：資料在記憶體裡。v1 已經在 2025 年 12 月 31 日停止維護（<https://endoflife.date/jaeger>）。這裡換成 v2，資料放在 Badger（嵌在 Jaeger 裡的 key-value 庫）加一個 PersistentVolume：

```yaml
      jaeger_storage:
        backends:
          badger_store:
            badger:
              directories: {keys: /data/keys, values: /data/values}
              ephemeral: false
              ttl: {spans: 72h}
```

```
═══ 8.9.3 Jaeger 重開之後，trace 還在嗎 ═══
  ① kind 的 Jaeger v2（Badger、PersistentVolume）：trace d6a618da21df5acfdf5242da888de8ef 有 23 個 span → 重開（13 秒）→ 23 個 span
  ② compose 的 Jaeger v1 all-in-one（記憶體）：trace 00000000000000000001f24119235c10 有 1 個 span → 重開 → 0 個 span
```

- kind 的 v2：一條 23 個 span 的 trace，重開（13 秒）之後還是 23 個。
- compose 的 v1：送一個 span 進去、查得到；重開之後查不到了。第 07 章的演練如果在 Jaeger 重開之後才去查，那一條 trace 已經不在了。

Badger 只能有一個行程打開它（所以 Deployment 用 `strategy: Recreate`）：Jaeger 只能一台。要多台、要放更久、要讓別的工具也查得到，換 Elasticsearch、OpenSearch 或 Cassandra —— 那是另一套要維運的叢集。這個專案目前不需要：trace 是排查用的，72 小時夠用；出事的那幾張，日誌（100% 有 traceId）還在。

---

## 8.10 服務網格值不值得（K10）

服務網格在每一個 pod 旁邊放一個代理（sidecar），服務之間的每一個請求都經過它。它給你的：每一個請求挑一次的負載平衡、重試與逾時、mTLS、每一跳的遙測，**全部不用改應用程式**。K10 裝 Istio 1.31（sidecar 模式），量第 06 章 6.3.5 留下的那一句：「服務網格的 sidecar（例如 Istio，預設就會重試）」。

### 8.10.1 sidecar 預設的重試

訂單服務的 sidecar 給 `inventory-service:8080` 的路由，實際的設定（`istioctl proxy-config routes`）：

```
  訂單服務的 sidecar → inventory-service.shop.svc.cluster.local:8080 的重試：{"retryOn":"connect-failure,refused-stream,unavailable,cancelled,retriable-status-codes","numRetries":2,"retryHostPredicate":[{"name":"envoy.retry_host_predicates.previous_hosts","typedConfig":{"@type":"type.googleapis.com/envoy.extensions.retry.host.previous_hosts.v3.PreviousHostsPredicate"}}],"hostSelectionRetryMaxAttempts":"5"}
```

`retriable-status-codes` 在裡面，**可是沒有列任何一個狀態碼**。K10 從訂單服務的 pod 直接送 10 個一定會 503 的預留（服務 token、`Shop-Budget-Ms: 0`：庫存服務借到連線之後發現預算用完，回 503，第 06 章 6.4.3），數庫存服務收到幾次：

```
  ① 沒有 sidecar
    a. 從訂單服務的 pod 送 10 個 Shop-Budget-Ms: 0 的預留：拿到 {503=10}；庫存服務回了 503 10 次
  ② 有 sidecar（Istio 的預設）
    a. 從訂單服務的 pod 送 10 個 Shop-Budget-Ms: 0 的預留：拿到 {503=10}；庫存服務回了 503 10 次
```

有沒有 sidecar，都是 10 次：**sidecar 沒有重送 503**。`retriable-status-codes` 這個條件，只認路由上列出來的狀態碼，或請求自己帶著的 `x-envoy-retriable-status-codes`（Envoy 的文件：<https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/router_filter>）—— Istio 的預設路由一個都沒有列。它會重送的，是連不上、refused-stream 與幾個 gRPC 的狀態，而且換一台送（`previous_hosts`）；連不上的那一種，這裡沒有量。

### 8.10.2 哪幾層預設就會重送

第 06 章 6.3.5 說「第 08 章談基礎設施的時候，會回到這些層裡哪幾層預設就會重送」。這一章量到、讀到的：

| 這一層 | 預設會不會重送 | 怎麼知道的 |
|---|---|---|
| 入口（Envoy Gateway 1.9） | 不會：沒有 `BackendTrafficPolicy` 就不重試 | K11 的 ①：10 個 503 的 GET，訂單服務收到 10 次 |
| 入口，設了重試 | 沒寫條件時是 `connect-failure,refused-stream,unavailable,cancelled,retriable-status-codes(503)`，含 503；**不分方法** | 前半是 CRD 的說明；後半是 K11 的 ③（那裡寫了條件）：POST 也被重送了 |
| Spring Cloud Gateway 的 `Retry=3` | GET、5xx，再送 3 次 | K11 的 ② |
| Istio 1.31 的 sidecar | 再送 2 次，只在連不上、refused-stream 與幾個 gRPC 的狀態；**不重送 503** | K10 |
| JDK HttpClient（訂單服務的 `RemoteInventoryApi` 底下） | 連不上（`ConnectException`）：不分方法，重連一次；池裡的連線已經被對方關了：只重送 GET、HEAD | JDK 21 的原始碼（`jdk.internal.net.http.MultiExchange`） |
| `RemoteInventoryApi`（第 06 章） | 沒有回應：再送一次，同一個冪等鍵 | 6.5 |
| 資料庫驅動程式 | —— | 這一章沒有量 |

### 8.10.3 代價，與這個專案的選擇

同一個 K10，有沒有 sidecar：

```
    b. 經過入口每秒 10 張下單 40 秒：[201=402]，p50 35 ms、p99 96 ms
    c. 記憶體（working set）：{inventory-service/nqfsb/app=396, inventory-service/pgn9z/app=508, order-service/hv2nn/app=568}
    b. 經過入口每秒 10 張下單 40 秒：[201=402]，p50 45 ms、p99 293 ms
    c. 記憶體（working set）：{inventory-service/66sss/app=422, inventory-service/66sss/istio-proxy=40, inventory-service/x2wfp/app=399, inventory-service/x2wfp/istio-proxy=34, order-service/fnrfz/app=479, order-service/fnrfz/istio-proxy=39}
```

- **延遲**：每秒 10 張、40 秒，p50 35 → 45 ms、p99 96 → 293 ms。各只跑一次，這台筆電的 p99 很會跳（寫這一章途中的另一次是 177 → 219 ms）。每一張下單多經過三個代理：入口 → 訂單服務的 sidecar；訂單服務 → 自己的 sidecar → 庫存服務的 sidecar。
- **記憶體**：每一個 sidecar 34～40 MiB（kubelet 的 working set）；這三個 pod 多了 113 MiB。應用程式的容器是 396～568 MiB。
- 這兩個數字之外，還有一個控制平面（istiod）要部署、升級，sidecar 的版本要跟著它走。

這個專案**現在不用**服務網格。它能給的，這個專案目前不缺、或已經有了：

| 網格給的 | 這個專案現在 |
|---|---|
| 每一個請求挑一次的負載平衡 | HTTP/1.1 + Tomcat 每 100 個請求換一條連線，量到的不均可以接受（8.6.5） |
| 重試、逾時 | 在應用程式裡，而且有預算（第 06 章）；網格的重試要另外算進乘法（8.10.2） |
| mTLS、服務的身分 | 服務 token（第 03 章 3.6）＋ NetworkPolicy（8.8.2）；沒有加密服務之間的流量 —— 這是網格最強的理由，這個專案還沒有被要求 |
| 每一跳的遙測 | OpenTelemetry（第 07 章），應用程式自己送 |

會讓這個答案改變的：被要求服務之間全部加密（mTLS）、服務變多而且不全是 Java（每一種語言都要一套 Resilience4j 與 OpenTelemetry 的設定）、出現 gRPC（8.6.5）。Istio 也有不用 sidecar 的模式（ambient：每一台 node 一個代理，需要 L7 的時候再加），這一章沒有試。

量完把 Istio 拿掉了：`k8s/` 裡沒有任何網格的設定。

---

## 8.11 選型文件（README 產出第 5 項）

### 8.11.1 逐項的決策表

「量到」是這一章在 kind 上量的；「文件」是官方文件的預設值，沒有量。

| 這件事 | Spring Cloud 版 | K8s 原生版 | 這個專案 |
|---|---|---|---|
| 服務發現 | Eureka：應用程式自己送心跳。一台停住，最壞 3 分鐘以上才不再收到請求（從文件的預設值推算，8.5.3） | Service + EndpointSlice，kubelet 用探針問。一台停住，11 秒後不在 endpoints 裡（量到，8.5.2） | K8s |
| 負載平衡 | Spring Cloud LoadBalancer：在呼叫端，每一個請求輪流挑（文件） | kube-proxy：每一條**連線**挑一次。擴容之後，每秒 10 張時新的 pod 30～40 秒後才分到（量到，8.6.1） | K8s；出現長命的連線（gRPC）時，在呼叫端加平衡（8.6.5） |
| 設定 | Config Server（Git）；加上 `@RefreshScope` 與 Bus，不重開就生效（文件） | ConfigMap、Secret。環境變數：改了要 rollout（20.7 秒、0 個錯誤）；掛成檔案：53 秒後檔案變了，Spring Boot 不重讀（量到，8.7.1） | K8s：環境變數 + rollout |
| 閘道 | Spring Cloud Gateway：入口的邏輯用 Java 寫、跟服務同一套技術；版本跟 Boot 綁在一起（量到，8.8.4） | Gateway API + 控制器（Envoy Gateway）；ingress-nginx 已經退役（8.3.3） | Gateway API，**只有一層** |
| 熔斷、重試、逾時 | Spring Cloud CircuitBreaker（底下是 Resilience4j） | 網格的 sidecar：Istio 預設只重試連不上的（量到，8.10.1） | 應用程式裡，直接用 Resilience4j，帶預算（第 06 章） |
| 服務之間的身分 | —— | NetworkPolicy（量到，8.8.2）；網格的 mTLS | 服務 token（第 03 章 3.6）+ NetworkPolicy |
| 觀測 | Micrometer（兩邊一樣） | Prometheus 的 `kubernetes_sd`；一個 Collector 當 span 的入口 | Micrometer + OTLP → Collector → Jaeger；`kubernetes_sd`（8.9） |

### 8.11.2 這個專案選什麼、為什麼

**K8s 原生**，加上留在應用程式裡的兩樣：韌性（Resilience4j 與預算）、觀測（Micrometer、OpenTelemetry）。

- **這個系統本來就要跑在 K8s 上**（02-spring-boot/08）。四件事 K8s 都已經在做了：再加 Spring Cloud，同一件事就有兩套 —— 兩個「誰還活著」的來源、兩層路由。8.8.4 量到兩層各自的重試疊起來是什麼樣子。
- **留在應用程式裡的，是平台不知道的業務語意**：哪一種錯誤算「庫存服務出事」（4xx 不算，第 06 章 6.7）、重送要帶同一個冪等鍵、剩下的預算還夠不夠再送一次。sidecar 的重試不知道這些（8.10.2）。
- **不加任何一個 Spring Cloud 的依賴**：少一個跟 Boot 綁版本的東西（8.8.4）。

### 8.11.3 換過去要付出什麼

**這一章搬到 K8s，實際付出的**：

- 部署：`k8s/` 底下 23 個檔案（不算實驗用的 `k8s/lab`）、一支腳本。migration 從「部署的一個步驟」變成一個 Job，部署分三步（8.4.4）。
- 程式：兩處（8.6.3 的限流、8.8.2 的入口信任；通知的租約是途中修的第 12 站的 bug，跟 K8s 無關）。
- 設定：兩個 K8s 才需要的值（`SHOP_DEPLOYMENT_EDGE_TRUST_TRACEPARENT`、`SERVER_FORWARD_HEADERS_STRATEGY`）。
- 告警：一條（8.9.1）。
- 被它揭露的：庫存服務對訂單服務限流（8.6.3）—— 第 03 章就有的 bug，換了部署的形狀才看得到。
- 要會的新東西：探針、kube-proxy 怎麼分連線、NetworkPolicy、Gateway API 與 Envoy Gateway 的 policy、kubernetes_sd 的 relabel、版本的對照表（8.4.1）。

**如果換成 Spring Cloud 版**（推估，這一章沒有做）：

- 多三個要維運的服務：Eureka server（要高可用就要多台互相複製）、Config Server（加一個 Git repo；要不重開就生效，再加 Spring Cloud Bus，它要一個 broker）、Spring Cloud Gateway。
- 每一個服務加 Spring Cloud 的 BOM 與四、五個 starter；Spring Boot 每升一次，Spring Cloud 跟著對版本（8.8.4 的 `NoSuchMethodError`）。
- 如果還是跑在 K8s 上：Service 與 kube-proxy 照樣在，兩套服務發現並存，出事的時候要先查「是哪一套說它還活著」。

**如果加上服務網格**（量到的部分，8.10.3）：每一個 pod 多一個代理（這裡 34～40 MiB）、每一跳多一點延遲；它的重試要跟應用程式的重試一起算；多一個控制平面要升級、要維運。

### 8.11.4 什麼時候兩套混用

| 情況 | 混用的方式 |
|---|---|
| 有一部分服務不在 K8s 上（VM、另一個機房） | 一個 K8s 外面也看得到的註冊中心（Consul、Eureka），K8s 那一邊用 Spring Cloud Kubernetes 或同步工具 |
| 長命的連線（gRPC、HTTP/2）要每一個請求挑一次 | 呼叫端：Spring Cloud LoadBalancer + Spring Cloud Kubernetes 的服務發現；或者上網格（8.6.5） |
| 入口要用 Java 寫的邏輯（BFF、聚合幾個服務的回應） | Spring Cloud Gateway 當**唯一**一層有邏輯的閘道；平台的入口只做 TLS 與轉發，不設重試、逾時比它長（8.8.4） |
| 少數設定要線上調、不重開 | Spring Cloud Kubernetes 的設定重讀（8.7.2） |

混用不是問題；**同一件事兩套各自做**才是 —— 兩層各自重試、兩個註冊中心各自判斷誰活著、兩層路由各自改寫路徑。

---

## 8.12 流程測試與追溯表

### 8.12.1 這一章新增的測試與實驗

| 名稱 | 種類 | 跑在哪裡 | 守什麼／量什麼 |
|---|---|---|---|
| `NotificationClaimTest` | 測試（3 個） | Testcontainers | 通知的認領是一個租約（第 12 站 7.7.2 的追記） |
| `InternalRateLimitTest` | 測試（2 個） | Testcontainers，庫存服務的角色 | 自己的服務不算進每個 IP 的額度；沒有 token 的照樣限流（8.6.3） |
| `EdgeTraceparentTest` | 測試（1 個） | Testcontainers，`@AutoConfigureObservability` | 入口受信任時，`/api/**` 接上入口的 `traceparent`（8.8.2） |
| `alerts_test.yml` | promtool（多 1 組） | Docker | K8s 的形狀：少一台不響、一台都沒有了才響（8.9.1） |
| I1 `I1MoreInventoryTest` | 實驗 | compose、三個子 JVM、演練用的 Prometheus | 8.2 |
| K0 `K0SmokeTest` | 實驗 | kind | 8.4.5 |
| K2 `K2ScaleUpTest` | 實驗 | kind | 8.6.1、8.6.2 |
| K3 `K3RolloutTest` | 實驗 | kind | 8.6.4 |
| K4 `K4HungPodTest` | 實驗 | kind | 8.5.2 |
| K5 `K5EdgeTraceTest` | 實驗 | kind、入口 | 8.8.2 |
| K6 `K6ClientIpTest` | 實驗 | kind、入口 | 8.8.3 |
| K7 `K7DiscoveryAlertTest` | 實驗 | kind、Prometheus | 8.9.1 |
| K8 `K8ConfigTest` | 實驗 | kind | 8.7.1 |
| K9 `K9TraceStorageTest` | 實驗 | kind 的 Jaeger v2、compose 的 Jaeger v1 | 8.9.3 |
| K10 `K10MeshTest` | 實驗 | kind、Istio 1.31（量完拿掉） | 8.10 |
| K11 `K11TwoGatewaysTest` | 實驗 | kind、入口、`lab/scg` | 8.8.4 |
| 第 04 章的 E4、第 01 章的 B1 | 實驗（重跑） | —— | 8.12.2 |

預設的測試從第 07 章的 362 個變成 368 個（8.13）。

### 8.12.2 E4、B1 重跑

使用者的一天（第 04 章的 E4）：

```
  訂單服務 → 庫存服務：14 次 HTTP、7 種端點（第 03 章：38 次、10 種）
    POST /api/orders → POST /internal/inventory/v1/hot-gate                                              × 2
    POST /api/orders → PUT /internal/inventory/v1/reservations/{n}                                       × 6
    POST /api/seller/orders/{orderNo}/ship → GET /internal/inventory/v1/reservations/{n}/shippable       × 2
    POST /api/seller/products/{id}/hot → PUT /internal/inventory/v1/products/{n}/hot                     × 1
    POST /api/seller/products/{id}/restock → GET /internal/inventory/v1/stock                            × 1
    POST /api/seller/products/{id}/restock → POST /internal/inventory/v1/products/{n}/restocks           × 1
    排程 ReservationReconciliation.run → GET /internal/inventory/v1/reservations                           × 1
```

跟第 07 章一樣：14 次 HTTP、7 種端點。這一章沒有改任何一次呼叫的次數；改的是部署，以及「限流算不算」「`traceparent` 收不收」這兩個判斷。

B1（第 01 章的邊界地圖）：

```
     9 │ catalog+inventory                   │          0 │          0 │        9 │        1 │    5 │  25.0%（9）
    24 │ inventory                           │          0 │          0 │       10 │        0 │    7 │  22.2%（8）
```

跟第 07 章一樣：庫存這一刀的同步呼叫 10 種、第 24 名。這一章沒有改模組之間的介面：改的兩個 filter 在 `shared`，不在任何一個模組的 API 上。

### 8.12.3 追溯表：這一站的產出

| README 的產出 | 第 00～02 章 | 第 03～07 章 | 第 08 章加上的 |
|---|---|---|---|
| 1. 拆分決策文件 | 不該拆；四個代價；第一刀切 notification；資料的三個階段 | 同步還是非同步；編排還是協同；哪些讀可以晚；每一個「等」的上限；告警叫醒誰 | 換了部署的形狀，才看到的 bug（8.6.3） |
| 2. 庫存拆成獨立服務、下單改成 Saga | 兩種部署、獨立的資料庫、對帳 | 正式的服務、契約、Saga、補償、演練；讀模型；下單路徑的四道保護；換版那一刻的舊訊息 | 在 K8s 上：一台卡住、滾動更新、擴容（8.5、8.6） |
| 3. 跨服務報表：API 組合版與讀模型版、過時視窗 | 庫存這一刀不切斷報表 | 三個讀的頁面：API 組合 → 讀模型；過時視窗；重建 | （沒有改） |
| 4. 一條完整的 trace、一次排查紀錄 | K5：兩邊都斷 | 訂單 → 庫存、訂單 → MQ → 消費者，一棵樹；一次排查紀錄 | **入口 → 訂單服務 → MQ → 庫存服務**（8.8.2）；入口拿掉買家的 trace header |
| 5. 基礎設施選型 | 維運清單 | 一個 jar、三種角色；Pact Broker；熔斷器放在應用程式裡；OTLP 與 Jaeger；告警規則不寫死部署的形狀 | **選型文件**（8.11）；`k8s/`；Jaeger 的儲存（8.9.3） |

---

## 8.13 本章完成後的專案

```
（d08，相對於 d07）
k8s/
├── base/                     兩個服務、Service、外部依賴、ConfigMap、NetworkPolicy、Prometheus 的權限
├── migrate/                  Flyway 的 Job（每個服務一個）
├── kind/                     這台筆電：cluster、映像檔的版本、外部依賴的位址、秘密、庫名
│   └── migrate/
├── gateway/                  Gateway API：GatewayClass、EnvoyProxy、Gateway、HTTPRoute、ClientTrafficPolicy
├── observability/            OpenTelemetry Collector、Jaeger v2（Badger）、Prometheus（kubernetes_sd）
└── lab/                      實驗用：Spring Cloud Gateway、入口的重試
lab/scg/                      實驗用的 Spring Cloud Gateway（Boot 3.2.12、Spring Cloud 2023.0.6）
scripts/d08-kind.sh
docker/prometheus/alerts.yml, alerts_test.yml          ShopServiceGone
src/main/java/com/example/shop/
├── shared/web/RateLimitFilter.java                    自己的服務不算（8.6.3）
├── shared/web/TraceFilters.java                       入口受信任時接它的 traceparent（8.8.2）
├── shared/config/ShopProperties.java                  shop.deployment.edge
└── notification/internal/NotificationHandler.java     認領是租約（第 12 站 7.7.2 的追記）
src/main/resources/db/migration/notification/V35__notification_claim_lease.sql
src/test/java/com/example/shop/
├── dist08/                   I1、K0～K11、Kube、Load、Traces
├── dist07/                   實驗工具改成 public；Jaeger.trace 可以指定位址
├── inventory/internal/web/InternalRateLimitTest.java
├── shared/web/EdgeTraceparentTest.java
└── notification/internal/NotificationClaimTest.java
```

```
TEST_INFRA testcontainers 啟動 10,826 ms：mysql jdbc:mysql://localhost:59403/shop、redis localhost:59394、rabbitmq localhost:59399
TEST_INFRA MySQL 最多同時 36 條連線（max_connections 151）
[INFO] Tests run: 368, Failures: 0, Errors: 0, Skipped: 0
TEST_INFRA testcontainers 啟動 10,483 ms：mysql jdbc:mysql://localhost:61129/shop、redis localhost:61120、rabbitmq localhost:61126
TEST_INFRA MySQL 最多同時 5 條連線（max_connections 151）
[INFO] Tests run: 39, Failures: 0, Errors: 0, Skipped: 0
[INFO] BUILD SUCCESS
[INFO] Total time:  06:15 min
```

這一章的整套測試跑了兩次，都是 `mvn clean verify`、都在最後的 commit 上：

- **第一次**：最後一輪實驗之前（程式都改完了）。368 個、failsafe 39 個，全綠，6 分 15 秒。
- **第二次是上面那一份**：最後一輪實驗的最後一步（I1 跑在第一個 commit 上，其他的實驗、E4、B1 都跑在這一個 commit 上）。

第 12 站的驗收 Q10（第 06、07 章說它偶爾會紅）這兩次都綠。兩次全綠證明不了一個 8～36 次才紅一次的競態不在了；證明它的是 `NotificationClaimTest` —— 它把那個順序釘住，每一次都走得到。

途中另外跑過幾次只包含受影響測試的子集，沒有算在上面：

| 子集 | 結果 |
|---|---|
| Q10 的修正 cherry-pick 過來之後：`NotificationClaimTest`、`MigrationOwnershipTest`、`ServiceDatabaseTest`、`EventFlowTest`、`DeadLetterReplayTest`、驗收，26 個 | 全綠 |
| `InternalRateLimitTest`，修正之前 | 紅 1 個（8.6.3 的 `{200=5, 429=15}`），這是要它紅的 |
| 修正之後：`InternalRateLimitTest`、`InternalTraceparentTest`、`InventoryServiceApiTest`、`RateLimitTest`，15 個 | 全綠 |
| 入口的信任：`EdgeTraceparentTest`、`InternalTraceparentTest`、驗收，14 個 | 全綠 |

### 8.13.1 本章其餘檔案的完整內容

**`src/main/java/com/example/shop/notification/internal/NotificationHandler.java`**（第 12 站 7.7.2 的追記）

```diff
 import org.springframework.jdbc.core.JdbcTemplate;
 import org.springframework.stereotype.Component;
 
+import java.time.Duration;
 import java.util.ArrayList;
 import java.util.List;
 import java.util.Map;
…
  *
  * transactional() = false：寄信不在 MySQL 裡，processed_messages 保護不了它。冪等靠 notifications 自己：
  *  ① dedup_key = eventId:類型（V7 的唯一索引）：同一個事件、同一種通知只有一列（AC-3）
- *  ② 寄之前先「認領」：attempts 從 n 改成 n + 1，只有一個人會成功 —— 同一則訊息同時被投遞兩次，只有一個去寄
+ *  ② 寄之前先「認領」：蓋一個租約（claimed_until），只有一個人會成功 —— 同一則訊息同時被投遞兩次，只有一個去寄。
+ *     認領不到、又還沒寄出：另一份正在寄 → 丟例外，交給重試階梯晚一點再來看（不能 ack 掉：寄的那一份如果死了，這一份是還會再來的）
  *  ③ 寄完標 SENT；之後再來的同一個事件看到 SENT 就跳過
- * 擋不住的一種：寄出去了、標 SENT 之前行程死掉 → 重送時再寄一次。寄信本身沒有冪等鍵 —— 這是 at-least-once 的代價（7.7.2）。
+ * 擋不住的一種：寄出去了、標 SENT 之前行程死掉 → 租約過期之後，重送的那一份再寄一次。寄信本身沒有冪等鍵 —— 這是 at-least-once 的代價（7.7.2）。
+ *
+ * 7.7.2 的追記（13 站第 08 章）：第一版的認領是「attempts 從 n 改成 n + 1，條件是還是 n」。A 認領之後、標 SENT 之前，
+ * B 讀到的就是 n + 1，用它認領也會成功、也去寄 —— 驗收 Q10 偶爾紅（notification_attempts = 2）。只看 attempts，
+ * 分不出「有人正在寄」與「上一次寄失敗了」；租約分得出來（NotificationClaimTest）。
  */
 @Component
 class NotificationHandler implements EventHandler {
…
 
     record Target(long userId, String type, String text) {}
 
+    /**
+     * ② 的租約：認領的那一份最久可以寄多久。要比寄一封信的逾時長（不然還在寄，另一份就認領得到），
+     * 比重試階梯的總長（1 + 2 + 4 + 8 + 16 = 31 秒）短（不然寄的行程死掉之後，另一份投遞的重試用完、進了死信，租約都還沒過期）。
+     */
+    static final Duration CLAIM_LEASE = Duration.ofSeconds(10);
+
+    /** ② 認領不到，而且還沒寄出：另一份投遞正拿著租約在寄 */
+    static class InFlight extends RuntimeException {
+        InFlight(String dedup) { super("通知 " + dedup + " 正在由另一份投遞寄送（租約還沒過期）"); }
+    }
+
     private final JdbcTemplate jdbc;
     private final SimulatedMailer mailer;
     private final ObjectMapper json;
…
             jdbc.update("""
                     INSERT INTO notifications (user_id, type, dedup_key, payload) VALUES (?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE id = id""", t.userId(), t.type(), dedup, payload(e, t));
-            Map<String, Object> row = jdbc.queryForMap("SELECT id, status, attempts FROM notifications WHERE dedup_key = ?", dedup);
+            Map<String, Object> row = jdbc.queryForMap("SELECT id, status FROM notifications WHERE dedup_key = ?", dedup);
             if ("SENT".equals(row.get("status"))) continue;                // AC-3：已經寄過了
             long id = ((Number) row.get("id")).longValue();
-            int attempts = ((Number) row.get("attempts")).intValue();
-            int claimed = jdbc.update("UPDATE notifications SET attempts = attempts + 1 WHERE id = ? AND status <> 'SENT' AND attempts = ?", id, attempts);
-            if (claimed == 0) continue;                                     // 同一則訊息的另一份正在寄（或剛寄完）
-            mailer.send(t.userId(), t.type(), dedup, t.text());             // 失敗 → 例外 → 重試階梯（AC-4）
+            int claimed = jdbc.update("""
+                    UPDATE notifications SET attempts = attempts + 1, claimed_until = CURRENT_TIMESTAMP(3) + INTERVAL ? MICROSECOND
+                     WHERE id = ? AND status <> 'SENT' AND (claimed_until IS NULL OR claimed_until < CURRENT_TIMESTAMP(3))""",
+                    CLAIM_LEASE.toMillis() * 1000, id);
+            if (claimed == 0) throw new InFlight(dedup);                    // 另一份正在寄（或剛寄完）：重試階梯的下一級再來看
+            try {
+                mailer.send(t.userId(), t.type(), dedup, t.text());         // 失敗 → 例外 → 重試階梯（AC-4）
+            } catch (RuntimeException ex) {
+                jdbc.update("UPDATE notifications SET claimed_until = NULL WHERE id = ?", id);   // 放掉租約：下一級重試不用等它過期
+                throw ex;
+            }
             jdbc.update("UPDATE notifications SET status = 'SENT', sent_at = CURRENT_TIMESTAMP(3) WHERE id = ?", id);
         }
     }
```

**`src/main/resources/db/migration/notification/V35__notification_claim_lease.sql`**（第 12 站 7.7.2 的追記；第 12 站的專案裡是 V26）

```sql
-- 7.7.2 的追記（13 站第 08 章）：通知的認領要分得出「有人正在寄」與「上一次寄失敗了」——只看 attempts 分不出來。
-- claimed_until：這一列被某一份投遞認領到什麼時候（NULL = 沒有人），同 V14 的 outbox_events.claimed_until。
-- 一句 DDL、ALGORITHM=INSTANT（同 V14）。第 12 站的專案裡它是 V26；這一站的 migration 已經到 V34，所以是 V35。
ALTER TABLE notifications ADD COLUMN claimed_until DATETIME(3) NULL, ALGORITHM=INSTANT;
```

**`src/main/java/com/example/shop/shared/config/ShopProperties.java`**（8.8.2）

```diff
     public record Deployment(
             @NotNull @DefaultValue("monolith") ServiceRole role,
             @Valid @NotNull @DefaultValue Remote inventory,
-            @Valid @NotNull @DefaultValue ServiceToken serviceToken) {
+            @Valid @NotNull @DefaultValue ServiceToken serviceToken,
+            @Valid @NotNull @DefaultValue Edge edge) {
 
         @jakarta.validation.constraints.AssertTrue(message = "shop.deployment.role=order-service 必須設定 shop.deployment.inventory.url")
         public boolean isInventoryReachable() {
…
             @NotNull @DefaultValue("5s") @DurationMin(seconds = 1) Duration openFor,
             @DefaultValue("3") @Min(1) int halfOpenCalls) {}
 
+    /**
+     * 13 站第 08 章：這個服務前面的入口（gateway）。trustTraceparent：/api/** 的 traceparent 是入口寫的、可以接 ——
+     * 只有在「入口會把買家自己帶來的 trace header 拿掉、而且只有入口連得到這個服務」的部署裡才能打開（k8s/gateway 的 ClientTrafficPolicy、
+     * k8s/base 的 NetworkPolicy）。預設關著：第 12 站 9.8.4 的規則，外面帶進來的一律不收
+     */
+    public record Edge(@DefaultValue("false") boolean trustTraceparent) {}
+
     /** 3.6：服務之間的 token（HS256）。ttl：一個 token 用多久；呼叫端在到期前 1 分鐘換新的 */
     public record ServiceToken(
             String secret,
```

**`k8s/base/kustomization.yaml`**（8.4）

```yaml
# 13 站第 08 章：兩個服務在 K8s 上 —— 服務發現、設定、負載平衡用 K8s 原生的那一套（Service、ConfigMap／Secret、kube-proxy）。
# 這裡是「每一個環境都一樣」的部分；環境的差別（映像檔的版本、外部依賴在哪裡、秘密）在 overlay（k8s/kind）。
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: shop
resources:
  - namespace.yaml
  - dependencies.yaml
  - config.yaml
  - inventory-service.yaml
  - order-service.yaml
  - prometheus-access.yaml
  - network-policy.yaml
```

**`k8s/base/order-service.yaml`**（8.4.2）

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
  labels: {app: order-service, system: shop}
spec:
  replicas: 1
  selector:
    matchLabels: {app: order-service}
  strategy:
    type: RollingUpdate
    rollingUpdate: {maxSurge: 1, maxUnavailable: 0}
  template:
    metadata:
      labels: {app: order-service, system: shop}
    spec:
      terminationGracePeriodSeconds: 40
      containers:
        - name: app
          image: shop:latest
          envFrom:
            - configMapRef: {name: shop-common}
            - configMapRef: {name: order-service}
            - secretRef: {name: shop-secrets}
          ports:
            - {name: http, containerPort: 8080}
            - {name: management, containerPort: 8081}
          startupProbe:
            httpGet: {path: /actuator/health/liveness, port: management}
            periodSeconds: 2
            failureThreshold: 90
          readinessProbe:
            httpGet: {path: /actuator/health/readiness, port: management}
            periodSeconds: 5
            failureThreshold: 2
          livenessProbe:
            httpGet: {path: /actuator/health/liveness, port: management}
            periodSeconds: 10
            failureThreshold: 3
          lifecycle:
            preStop:
              sleep: {seconds: 10}
          resources:
            requests: {cpu: 250m, memory: 640Mi}
            limits: {memory: 640Mi}
---
apiVersion: v1
kind: Service
metadata:
  name: order-service
  labels: {app: order-service, system: shop}
spec:
  selector: {app: order-service}
  ports:
    - {name: http, port: 8080, targetPort: http}
```

**`k8s/kind/secrets.env`**（8.4.3：只在這台筆電用的值）

```
SHOP_DB_USER=shop
SHOP_DB_PASSWORD=shop
SHOP_REDIS_PASSWORD=
SHOP_RABBIT_USER=shop
SHOP_RABBIT_PASSWORD=shop
SHOP_JWT_SECRET=local-dev-only-secret-0123456789abcdef
SHOP_PAYMENT_CALLBACK_SECRET=local-dev-only-payment-callback-secret-0123
SHOP_SERVICE_TOKEN_SECRET=d03-lab-service-token-secret-0123456789
SHOP_BOOTSTRAP_ADMIN_EMAIL=admin@example.com
SHOP_BOOTSTRAP_ADMIN_PASSWORD=local-dev-only-admin-password
```

**`k8s/kind/migrate/kustomization.yaml`**（8.4.4）

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../migrate
images:
  - name: shop
    newTag: d08
secretGenerator:
  - name: shop-migrator
    namespace: shop
    literals: [FLYWAY_USER=shop_migrator, FLYWAY_PASSWORD=shop_migrator]
```

**`k8s/migrate/kustomization.yaml`**（8.4.4）

```yaml
# migration 的 Job 自己一個 kustomization：Job 的 spec 不能改（immutable），換版本要先刪掉舊的 Job 再 apply ——
# 跟應用程式放在一起的話，每一次 apply 應用程式都會撞到它
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: shop
resources:
  - jobs.yaml
```

**`k8s/gateway/kustomization.yaml`**（8.8.1）

```yaml
# 13 站第 08 章：入口。Gateway API（K8s 的標準介面）＋ Envoy Gateway（一個實作）。先裝控制器：
#   kubectl apply --server-side -f https://github.com/envoyproxy/gateway/releases/download/v1.9.1/install.yaml
# 這裡只有「這個系統的入口長什麼樣」：一個 Gateway、一條路由、入口的 trace 與 header 規則
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: shop
resources:
  - gateway.yaml
  - routes.yaml
  - client-traffic.yaml
```

**`k8s/observability/kustomization.yaml`**（8.9）

```yaml
# 13 站第 08 章：觀測的那幾樣，在 K8s 上。第 07 章的演練靠的兩個寫死的位址，在這裡變成：
#   span 送到哪裡 → 一個 Service 的名字（otel-collector.observability:4318），後面是 Collector、再後面是 Jaeger
#   Prometheus 抓誰 → kubernetes_sd：問 K8s 現在有哪些帶著 system=shop 的 pod，多一台、少一台都不用改設定
# alerts.yml 跟 compose 的是同一份（docker/prometheus/alerts.yml）。它在這個資料夾外面，所以要這樣套：
#   kubectl kustomize --load-restrictor LoadRestrictionsNone k8s/observability | kubectl apply -f -
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: observability
resources:
  - namespace.yaml
  - jaeger.yaml
  - otel-collector.yaml
  - prometheus.yaml
configMapGenerator:
  - name: prometheus-rules
    files: [../../docker/prometheus/alerts.yml]
```

**`k8s/observability/namespace.yaml`**（8.9）

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: observability
```

**`k8s/observability/jaeger.yaml`**（8.9.3）

```yaml
# Jaeger v2（第 07 章的 compose 用的是 v1 的 all-in-one 1.62：v1 在 2025 年底停止維護）。
# 資料放在 Badger（嵌在 Jaeger 裡的 key-value 庫）+ 一個 PersistentVolume：pod 重開，trace 還在（all-in-one 的記憶體做不到）。
# Badger 只能一台 —— 要多台、要放更久，換 Elasticsearch／OpenSearch／Cassandra（8.9.3 的取捨）
apiVersion: v1
kind: ConfigMap
metadata:
  name: jaeger-config
data:
  config.yaml: |
    service:
      extensions: [jaeger_storage, jaeger_query, healthcheckv2]
      pipelines:
        traces:
          receivers: [otlp]
          processors: [batch]
          exporters: [jaeger_storage_exporter]
      telemetry:
        resource: {service.name: jaeger}
        metrics:
          level: detailed
          readers: [{pull: {exporter: {prometheus: {host: 0.0.0.0, port: 8888}}}}]
    extensions:
      healthcheckv2: {use_v2: true, http: {endpoint: 0.0.0.0:13133}}
      jaeger_query:
        storage: {traces: badger_store}
      jaeger_storage:
        backends:
          badger_store:
            badger:
              directories: {keys: /data/keys, values: /data/values}
              ephemeral: false
              ttl: {spans: 72h}
    receivers:
      otlp:
        protocols:
          grpc: {endpoint: 0.0.0.0:4317}
          http: {endpoint: 0.0.0.0:4318}
    processors:
      batch: {}
    exporters:
      jaeger_storage_exporter: {trace_storage: badger_store}
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: jaeger-data
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests: {storage: 2Gi}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: jaeger
  labels: {app: jaeger}
spec:
  replicas: 1
  strategy: {type: Recreate}                 # Badger 的目錄同一時間只能有一個行程打開：先關舊的才起新的
  selector:
    matchLabels: {app: jaeger}
  template:
    metadata:
      labels: {app: jaeger}
    spec:
      securityContext: {fsGroup: 10001}
      containers:
        - name: jaeger
          image: jaegertracing/jaeger:2.21.0
          args: ["--config", "/etc/jaeger/config.yaml"]
          ports:
            - {name: otlp-grpc, containerPort: 4317}
            - {name: otlp-http, containerPort: 4318}
            - {name: query, containerPort: 16686}
            - {name: metrics, containerPort: 8888}
          readinessProbe:
            httpGet: {path: /status, port: 13133}
          volumeMounts:
            - {name: config, mountPath: /etc/jaeger}
            - {name: data, mountPath: /data}
          resources:
            requests: {cpu: 100m, memory: 256Mi}
            limits: {memory: 512Mi}
      volumes:
        - {name: config, configMap: {name: jaeger-config}}
        - {name: data, persistentVolumeClaim: {claimName: jaeger-data}}
---
apiVersion: v1
kind: Service
metadata:
  name: jaeger
spec:
  selector: {app: jaeger}
  ports:
    - {name: otlp-grpc, port: 4317, targetPort: otlp-grpc}
    - {name: query, port: 16686, targetPort: query}
    - {name: metrics, port: 8888, targetPort: metrics}
---
apiVersion: v1
kind: Service
metadata:
  name: jaeger-query-nodeport                # 這台筆電看 trace 的入口（kind：18886 → 30686）
spec:
  type: NodePort
  selector: {app: jaeger}
  ports:
    - {name: query, port: 16686, targetPort: query, nodePort: 30686}
```

**`k8s/lab/scg.yaml`**（8.8.4）

```yaml
# 13 站第 08 章的實驗（不是這個專案的部署）：入口後面多一層 Spring Cloud Gateway（lab/scg，映像檔 scg-lab:d08）。
#   kubectl -n shop apply -f k8s/lab/scg.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: scg-lab
  labels: {app: scg-lab}
spec:
  replicas: 1
  selector:
    matchLabels: {app: scg-lab}
  template:
    metadata:
      labels: {app: scg-lab}
    spec:
      containers:
        - name: app
          image: scg-lab:d08
          ports: [{name: http, containerPort: 8080}]
          readinessProbe:
            tcpSocket: {port: http}
          resources:
            requests: {cpu: 100m, memory: 384Mi}
            limits: {memory: 384Mi}
---
apiVersion: v1
kind: Service
metadata:
  name: scg-lab
spec:
  selector: {app: scg-lab}
  ports: [{name: http, port: 8080, targetPort: http}]
---
# 訂單服務的 8080 本來只收入口（k8s/base/network-policy.yaml）：多一層閘道，就要多開一條（NetworkPolicy 是加起來的）
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: order-service-from-scg-lab
spec:
  podSelector: {matchLabels: {app: order-service}}
  policyTypes: [Ingress]
  ingress:
    - from: [{podSelector: {matchLabels: {app: scg-lab}}}]
      ports: [{port: 8080}]
```

**`lab/scg/pom.xml`**（8.8.4）

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!-- 13 站第 08 章的實驗：一個 Spring Cloud Gateway，放在 Gateway API 的入口後面、訂單服務前面（8.8.4 的「兩層路由」）。不是這個專案的一部分 -->
<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>
    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <!-- 3.2.12（Spring Framework 6.1.15）。第一版跟訂單服務一樣用 3.2.5（6.1.6）：起得來，第一個請求就 NoSuchMethodError ——
             Spring Cloud Gateway 4.1.9 呼叫 HttpHeaders.headerSet()，那是 6.1.15 才有的（8.8.4 的小坑） -->
        <version>3.2.12</version>
        <relativePath/>
    </parent>
    <groupId>lab</groupId>
    <artifactId>scg</artifactId>
    <version>0.0.1</version>
    <properties>
        <java.version>21</java.version>
    </properties>
    <dependencyManagement>
        <dependencies>
            <dependency>
                <!-- 2023.0（Leyton）：Spring Boot 3.2／3.3 的那一組；Spring Cloud Gateway 4.1.9 -->
                <groupId>org.springframework.cloud</groupId>
                <artifactId>spring-cloud-dependencies</artifactId>
                <version>2023.0.6</version>
                <type>pom</type>
                <scope>import</scope>
            </dependency>
        </dependencies>
    </dependencyManagement>
    <dependencies>
        <dependency>
            <groupId>org.springframework.cloud</groupId>
            <artifactId>spring-cloud-starter-gateway</artifactId>
        </dependency>
    </dependencies>
    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
            </plugin>
        </plugins>
    </build>
</project>
```

**`lab/scg/Dockerfile`**（8.8.4）

```
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /src
COPY pom.xml .
COPY src src
RUN --mount=type=cache,target=/root/.m2 mvn -B -ntp -q -DskipTests package
FROM eclipse-temurin:21-jre
COPY --from=build /src/target/scg-0.0.1.jar /app.jar
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75", "-jar", "/app.jar"]
```

**`lab/scg/src/main/java/lab/scg/ScgLab.java`**（8.8.4）

```java
package lab.scg;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/** 13 站第 08 章的實驗用 Spring Cloud Gateway：路由與過濾器全部在 application.yml */
@SpringBootApplication
public class ScgLab {
    public static void main(String[] args) {
        SpringApplication.run(ScgLab.class, args);
    }
}
```

**`src/test/java/com/example/shop/dist08/I1MoreInventoryTest.java`**（8.2）

```java
package com.example.shop.dist08;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist02.Split;
import com.example.shop.dist03.Broker;
import com.example.shop.dist04.Nodes;
import com.example.shop.dist07.Calls;
import com.example.shop.dist07.Jaeger;
import com.example.shop.dist07.Keys;
import com.example.shop.dist07.Node;
import com.example.shop.dist07.Prom;
import com.example.shop.shared.web.Role;
import com.example.shop.support.TestTokens;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Collectors;

/**
 * 13 站 8.2：庫存服務多開一台。第 07 章的演練靠三個寫死的位址（7.16）—— 這裡看前兩個在「多一台」的時候怎麼樣。
 *
 * 三個子 JVM（第 07 章的 Node）：庫存服務 A、B（同一個庫、同一個 vhost），訂單服務的 shop.deployment.inventory.url 指向 A。
 * 演練用的 Prometheus 照第 07 章的寫法：一個 job 一個寫死的位址 —— 庫存服務那一個是 A 的管理埠。
 * 每秒 5 張下單（開放式負載）：
 *   ① 兩台都在 30 秒：A、B 各收到幾個預留（各自管理埠上的 http_server_requests）
 *   ② 停掉 A（B 還在）75 秒：下單的狀態碼、熔斷器、Prometheus 的 target 與告警
 *   ③ 人工換位址：訂單服務用 B 的位址重啟 —— 多久才又能下單，這段時間的下單怎麼樣；之後 30 秒
 *
 *   mvn test -Pexperiments -Dtest=I1MoreInventoryTest        （約 5 分鐘）
 */
@Tag("experiment")
class I1MoreInventoryTest {

    static final int A_PORT = 18811, A_MGMT = 18812, B_PORT = 18813, B_MGMT = 18814, ORDER_PORT = 18815, ORDER_MGMT = 18816;
    static final AtomicLong BUYERS = new AtomicLong(8_100_000);
    static final String RESERVE = "uri=\"/internal/inventory/v1/reservations/{orderId}\"";

    final long both = Long.getLong("i1.both", 30), aDown = Long.getLong("i1.aDown", 75), after = Long.getLong("i1.after", 30);
    final int rate = Integer.getInteger("i1.rate", 5);
    final PrintStream out = System.out;

    record Done(long atMs, int status) {}

    @Test
    void moreInventory() throws Exception {
        Split.freshDatabases();
        Nodes.flushRedis(Split.ORDER_REDIS);
        Nodes.flushRedis(Split.INV_REDIS);
        Broker.freshVhost();
        Jaeger.restart();
        List<String> common = Node.common("0.1");
        Node a = null, order = null;
        try (ConfigurableApplicationContext keys = Keys.start();
             Node b = Node.inventory("i1-inventory-b", B_PORT, B_MGMT, common);
             Prom prom = Prom.start(new TreeMap<>(Map.of("order-service", ORDER_MGMT, "inventory-service", A_MGMT)))) {
            a = Node.inventory("i1-inventory-a", A_PORT, A_MGMT, common);
            order = Node.order("i1-order", ORDER_PORT, ORDER_MGMT, A_PORT, common);
            SplitLab.seed(Split.ORDER_DB, true, false);
            SplitLab.seed(Split.INV_DB, false, true);
            Calls.Res rebuilt = Calls.send(ORDER_PORT, "POST", "/api/admin/stock-levels/rebuild", TestTokens.bearer(keys, 1, Role.ADMIN), null, Map.of());
            if (rebuilt.status() != 200) throw new IllegalStateException("重建副本 " + rebuilt.status() + " " + rebuilt.body());
            for (int i = 0; i < 60 && !(prom.targets().size() == 2 && prom.targets().stream().allMatch(t -> t.contains(" up"))); i++) Thread.sleep(1_000);
            for (int i = 0; i < 300; i++)                                   // 暖機
                Calls.place(ORDER_PORT, TestTokens.bearer(keys, BUYERS.incrementAndGet()), SplitLab.FIRST_PRODUCT + i % SplitLab.PRODUCTS);

            out.printf("═══ 8.2 庫存服務多開一台：A（%d）、B（%d），訂單服務的 shop.deployment.inventory.url = http://127.0.0.1:%d；每秒 %d 張下單（load %s）═══%n",
                    A_PORT, B_PORT, A_PORT, rate, SplitLab.load());
            out.printf("  演練用的 Prometheus 的 target：%s%n", prom.targets());
            long a0 = reserves(A_MGMT), b0 = reserves(B_MGMT);
            out.printf("  暖機之後：A 收到預留 %d 個、B %d 個%n", a0, b0);

            ConcurrentLinkedQueue<Done> done = new ConcurrentLinkedQueue<>();
            AtomicBoolean stop = new AtomicBoolean();
            ExecutorService load = Executors.newVirtualThreadPerTaskExecutor();
            long t0 = System.nanoTime();
            Thread sender = new Thread(() -> {
                long gap = 1_000_000_000L / rate;
                for (long i = 0; !stop.get(); i++) {
                    long wait = t0 + i * gap - System.nanoTime();
                    if (wait > 0) try { Thread.sleep(wait / 1_000_000, (int) (wait % 1_000_000)); } catch (InterruptedException e) { return; }
                    long at = (System.nanoTime() - t0) / 1_000_000;
                    load.submit(() -> {
                        int status;
                        try {
                            status = Calls.place(ORDER_PORT, TestTokens.bearer(keys, BUYERS.incrementAndGet()),
                                    SplitLab.FIRST_PRODUCT + ThreadLocalRandom.current().nextInt(SplitLab.PRODUCTS)).status();
                        } catch (Exception e) {
                            status = -1;                                     // 連不上訂單服務
                        }
                        done.add(new Done(at, status));
                    });
                }
            });
            sender.start();

            List<String> timeline = new ArrayList<>();
            Map<String, String> state = new LinkedHashMap<>();
            Map<String, long[]> counts = new LinkedHashMap<>();             // 每一段結束時 A、B 的預留數
            String lastBreaker = "closed";
            Map<String, Long> reservesAtStop = Map.of();
            long total = both + aDown + after;
            long restartAt = both + aDown, readyAt = -1, readyAtMs = -1;
            for (long s = 0; readyAt < 0 ? s <= total : s <= readyAt + after; s += 5) {
                long sleep = t0 + s * 1_000_000_000L - System.nanoTime();
                if (sleep > 0) Thread.sleep(sleep / 1_000_000);
                if (s == both) {
                    counts.put("①", new long[]{reserves(A_MGMT) - a0, reserves(B_MGMT) - b0});
                    reservesAtStop = outcomeCounts();
                    long c0 = System.nanoTime();
                    a.close();
                    a = null;
                    timeline.add(String.format("第 %3d 秒 ── 停掉 A（%,d ms 結束）；B 還在", s, (System.nanoTime() - c0) / 1_000_000));
                }
                long now0 = (System.nanoTime() - t0) / 1_000_000_000L;
                if (s >= both && s < restartAt) {
                    String br = breaker();
                    if (!br.equals(lastBreaker)) timeline.add(String.format("第 %3d 秒    訂單服務的熔斷器 inventory-reserve：%s", now0, br));
                    lastBreaker = br;
                }
                if (s == restartAt) {
                    counts.put("②", new long[]{-1, reserves(B_MGMT) - b0});
                    timeline.add(String.format("第 %3d 秒    訂單服務呼叫預留的結果（shop_remote_call，A 停掉之後）：%s", now0, outcomes(reservesAtStop)));
                    long c0 = System.nanoTime();
                    order.close();
                    order = null;
                    timeline.add(String.format("第 %3d 秒 ── 人工換位址：停掉訂單服務（%,d ms），用 http://127.0.0.1:%d 重啟", s, (System.nanoTime() - c0) / 1_000_000, B_PORT));
                    order = Node.order("i1-order-2", ORDER_PORT, ORDER_MGMT, B_PORT, common);
                    readyAtMs = (System.nanoTime() - t0) / 1_000_000;
                    readyAt = readyAtMs / 1000;
                    timeline.add(String.format("第 %3d 秒 ── 訂單服務 ready（停掉之後 %,d ms）", readyAt, (System.nanoTime() - c0) / 1_000_000));
                    s = readyAt - readyAt % 5;
                }
                Map<String, String> now = new LinkedHashMap<>();
                for (Prom.Alert al : prom.alerts())
                    now.put(al.name() + (al.labels().containsKey("job") ? "{" + al.labels().get("job") + "}" : ""), al.state());
                long at = (System.nanoTime() - t0) / 1_000_000_000L;
                for (var e : now.entrySet()) if (!e.getValue().equals(state.get(e.getKey()))) timeline.add(String.format("第 %3d 秒 %s %s", at, e.getKey(), e.getValue()));
                for (var k : state.keySet()) if (!now.containsKey(k)) timeline.add(String.format("第 %3d 秒 %s 解除", at, k));
                state = now;
            }
            stop.set(true);
            sender.join();
            load.shutdown();
            load.awaitTermination(60, TimeUnit.SECONDS);
            counts.put("③", new long[]{-1, reserves(B_MGMT) - b0});

            out.println("  時間軸（每 5 秒問一次 Prometheus 的告警）：");
            timeline.forEach(l -> out.println("    " + l));
            out.printf("  Prometheus 的 target（結束時）：%s%n", prom.targets());
            long end = (System.nanoTime() - t0) / 1_000_000;
            String[][] phases = {{"① 兩台都在", "0", String.valueOf(both * 1000)}, {"② A 停了", String.valueOf(both * 1000), String.valueOf(restartAt * 1000)},
                    {"   重啟中", String.valueOf(restartAt * 1000), String.valueOf(readyAtMs)}, {"③ 換成 B", String.valueOf(readyAtMs), String.valueOf(end)}};
            for (String[] p : phases) {
                long from = Long.parseLong(p[1]), to = Long.parseLong(p[2]);
                Map<Integer, Long> codes = done.stream().filter(d -> d.atMs() >= from && d.atMs() < to)
                        .collect(Collectors.groupingBy(Done::status, TreeMap::new, Collectors.counting()));
                out.printf("  %-8s │ %5.1f 秒 │ 下單 %s（-1 = 連不上訂單服務）%n", p[0], (to - from) / 1000.0, codes);
            }
            counts.forEach((k, v) -> out.printf("  到 %s 結束：A 收到預留 %s、B %d 個%n", k, v[0] < 0 ? "（停了）" : v[0] + " 個", v[1]));
        } finally {
            if (order != null) order.close();
            if (a != null) a.close();
        }
        out.printf("  （結束時 load %s）%n", SplitLab.load());
    }

    /** 這一台的管理埠上，預留（PUT /internal/inventory/v1/reservations/{orderId}）被處理了幾次；連不上 → -1 */
    static long reserves(int mgmt) {
        try {
            HttpResponse<String> r = Jaeger.HTTP.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + mgmt + "/actuator/prometheus")).build(),
                    HttpResponse.BodyHandlers.ofString());
            return (long) r.body().lines().filter(l -> l.startsWith("http_server_requests_seconds_count{") && l.contains(RESERVE) && l.contains("method=\"PUT\""))
                    .mapToDouble(l -> Double.parseDouble(l.substring(l.lastIndexOf(' ') + 1))).sum();
        } catch (Exception down) {
            return -1;
        }
    }

    /** 訂單服務呼叫預留（op=reserve）到現在為止，每一種結果幾次（shop_remote_call_seconds_count 的 outcome，13 站 7.7.1） */
    static Map<String, Long> outcomeCounts() {
        Map<String, Long> m = new TreeMap<>();
        try {
            HttpResponse<String> r = Jaeger.HTTP.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + ORDER_MGMT + "/actuator/prometheus")).build(),
                    HttpResponse.BodyHandlers.ofString());
            r.body().lines().filter(l -> l.startsWith("shop_remote_call_seconds_count{") && l.contains("op=\"reserve\""))
                    .forEach(l -> m.merge(l.replaceAll(".*outcome=\"([a-z_0-9]+)\".*", "$1"), (long) Double.parseDouble(l.substring(l.lastIndexOf(' ') + 1)), Long::sum));
        } catch (Exception down) { /* 訂單服務連不上 */ }
        return m;
    }

    /** 從 before 到現在，每一種結果多了幾次 */
    static Map<String, Long> outcomes(Map<String, Long> before) {
        Map<String, Long> m = new TreeMap<>();
        outcomeCounts().forEach((k, v) -> { long d = v - before.getOrDefault(k, 0L); if (d > 0) m.put(k, d); });
        return m;
    }

    /** 訂單服務的熔斷器 inventory-reserve 現在的狀態（resilience4j_circuitbreaker_state 值是 1 的那一個） */
    static String breaker() {
        try {
            HttpResponse<String> r = Jaeger.HTTP.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + ORDER_MGMT + "/actuator/prometheus")).build(),
                    HttpResponse.BodyHandlers.ofString());
            return r.body().lines().filter(l -> l.startsWith("resilience4j_circuitbreaker_state{") && l.contains("name=\"inventory-reserve\"") && l.endsWith(" 1.0"))
                    .map(l -> l.replaceAll(".*state=\"([a-z_]+)\".*", "$1")).findFirst().orElse("?");
        } catch (Exception down) {
            return "（訂單服務連不上）";
        }
    }
}
```

**`src/test/java/com/example/shop/dist08/Kube.java`**（8.4 之後每一個 K 實驗）

```java
package com.example.shop.dist08;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist07.Calls;
import com.fasterxml.jackson.databind.JsonNode;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.TimeUnit;

/**
 * 13 站第 08 章的實驗支架：kind 上的兩個服務（scripts/d08-kind.sh 起的那一組）。
 * 實驗在這台筆電上跑，用 kubectl 操作 cluster；買家的請求從 kind 的 extraPortMappings 進去（18880 → 訂單服務的 NodePort）。
 * 每一個 pod 的指標不用 port-forward：API server 的 pod proxy（/api/v1/namespaces/shop/pods/<pod>:8081/proxy/actuator/prometheus）。
 */
public final class Kube {

    public static final String CTX = "kind-d08", NS = "shop";
    public static final String ORDER_DB = "shop_d08_order", INV_DB = "shop_d08_inv";
    public static final int ENTRY = 18880;
    /** kind 的執行檔（scripts/d08-kind.sh 用的同一個；不在 PATH 上時用 -Dd08.kind=… 指給它） */
    static final String KIND = System.getProperty("d08.kind", "kind");

    public record Pod(String name, String app, boolean ready, boolean terminating, String ip) {}

    private Kube() {}

    /** 跑一個指令，回傳 stdout + stderr；結束碼不是 0 → 例外 */
    public static String sh(String... cmd) throws Exception {
        Process p = new ProcessBuilder(cmd).redirectErrorStream(true).directory(Path.of(".").toFile()).start();
        String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        if (!p.waitFor(10, TimeUnit.MINUTES) || p.exitValue() != 0) throw new IllegalStateException(String.join(" ", cmd) + "：" + out);
        return out;
    }

    /** 同 sh，但不管結束碼（例如 curl --parallel：其中一個失敗，整個的結束碼就不是 0，輸出還是要） */
    public static String shAny(String... cmd) throws Exception {
        Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
        String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        p.waitFor(10, TimeUnit.MINUTES);
        return out;
    }

    public static String kubectl(String... args) throws Exception {
        List<String> cmd = new ArrayList<>(List.of("kubectl", "--context", CTX, "-n", NS));
        cmd.addAll(List.of(args));
        return sh(cmd.toArray(String[]::new));
    }

    public static String script(String step) throws Exception {
        return sh("env", "KIND=" + KIND, "scripts/d08-kind.sh", step);
    }

    /** 清空這一章的兩個庫與 vhost、重跑 migration、兩個服務重開（新的庫要新的連線與佇列），種商品與庫存，重建庫存的副本（第 05 章 5.6） */
    public static void fresh(String adminToken) throws Exception {
        script("databases");
        script("deploy");
        kubectl("rollout", "restart", "deploy/inventory-service", "deploy/order-service");
        for (String d : List.of("inventory-service", "order-service")) kubectl("rollout", "status", "deploy/" + d, "--timeout=300s");
        waitFor(() -> pods("inventory-service").stream().noneMatch(Pod::terminating) && pods("order-service").stream().noneMatch(Pod::terminating), 120);
        SplitLab.seed(ORDER_DB, true, false);
        SplitLab.seed(INV_DB, false, true);
        Calls.Res r = Calls.send(ENTRY, "POST", "/api/admin/stock-levels/rebuild", adminToken, null, Map.of());
        if (r.status() != 200) throw new IllegalStateException("重建副本 " + r.status() + " " + r.body());
    }

    public static List<Pod> pods(String app) throws Exception {
        JsonNode items = Calls.JSON.readTree(kubectl("get", "pods", "-l", "app=" + app, "-o", "json")).path("items");
        List<Pod> out = new ArrayList<>();
        for (JsonNode p : items) {
            boolean ready = false;
            for (JsonNode c : p.path("status").path("conditions")) if (c.path("type").asText().equals("Ready")) ready = c.path("status").asText().equals("True");
            out.add(new Pod(p.path("metadata").path("name").asText(), app, ready, p.path("metadata").has("deletionTimestamp"), p.path("status").path("podIP").asText()));
        }
        out.sort((a, b) -> a.name().compareTo(b.name()));
        return out;
    }

    /** 這個 Service 的 EndpointSlice 裡，現在會收到請求的（ready、不是正在結束的）pod */
    public static List<String> endpoints(String service) throws Exception {
        JsonNode items = Calls.JSON.readTree(kubectl("get", "endpointslices", "-l", "kubernetes.io/service-name=" + service, "-o", "json")).path("items");
        List<String> out = new ArrayList<>();
        for (JsonNode s : items)
            for (JsonNode e : s.path("endpoints"))
                if (e.path("conditions").path("ready").asBoolean(false)) out.add(e.path("targetRef").path("name").asText());
        out.sort(null);
        return out;
    }

    /** 一個 pod 的 /actuator/prometheus（經過 API server 的 pod proxy）；拿不到 → null */
    public static String metrics(String pod) {
        try {
            return sh("kubectl", "--context", CTX, "get", "--raw", "/api/v1/namespaces/" + NS + "/pods/" + pod + ":8081/proxy/actuator/prometheus");
        } catch (Exception gone) {
            return null;
        }
    }

    /** 指標文字裡，名字是 name、而且每一個 contains 都出現的那幾行，值加總 */
    public static double sum(String metrics, String name, String... contains) {
        if (metrics == null) return Double.NaN;
        return metrics.lines().filter(l -> l.startsWith(name + "{") && java.util.Arrays.stream(contains).allMatch(l::contains))
                .mapToDouble(l -> Double.parseDouble(l.substring(l.lastIndexOf(' ') + 1))).sum();
    }

    /** 每一個庫存服務的 pod，到現在為止處理了幾個預留（PUT /internal/inventory/v1/reservations/{orderId}） */
    public static Map<String, Double> reservesByPod() throws Exception {
        Map<String, Double> m = new TreeMap<>();
        for (Pod p : pods("inventory-service"))
            m.put(p.name(), sum(metrics(p.name()), "http_server_requests_seconds_count", "uri=\"/internal/inventory/v1/reservations/{orderId}\"", "method=\"PUT\""));
        return m;
    }

    /** 這個 pod 的應用程式（容器裡的 PID 1）在 kind node 上的 PID —— 在容器裡對 PID 1 送 SIGSTOP 會被核心忽略，要從 node 送 */
    public static String hostPid(String pod) throws Exception {
        String id = kubectl("get", "pod", pod, "-o", "jsonpath={.status.containerStatuses[0].containerID}").replace("containerd://", "").trim();
        return sh("docker", "exec", "d08-control-plane", "crictl", "inspect", "-o", "go-template", "--template", "{{.info.pid}}", id).trim();
    }

    /** kill -STOP（卡住：行程還在、埠還開著、什麼都不回）／ kill -CONT */
    public static void signal(String pod, String sig) throws Exception {
        sh("docker", "exec", "d08-control-plane", "kill", "-" + sig, hostPid(pod));
    }

    /** 每一個訂單服務的 pod 的指標，name 與 contains 都符合的那幾行加總 */
    public static double orderSum(String name, String... contains) throws Exception {
        double total = 0;
        for (Pod p : pods("order-service")) {
            double v = sum(metrics(p.name()), name, contains);
            if (!Double.isNaN(v)) total += v;
        }
        return total;
    }

    /** 訂單服務呼叫預留（op=reserve）到現在為止，每一種結果幾次（shop_remote_call_seconds_count 的 outcome，13 站 7.7.1） */
    public static Map<String, Long> reserveOutcomes() throws Exception {
        Map<String, Long> m = new TreeMap<>();
        for (Pod p : pods("order-service")) {
            String text = metrics(p.name());
            if (text == null) continue;
            text.lines().filter(l -> l.startsWith("shop_remote_call_seconds_count{") && l.contains("op=\"reserve\""))
                    .forEach(l -> m.merge(l.replaceAll(".*outcome=\"([a-z_0-9]+)\".*", "$1"), (long) Double.parseDouble(l.substring(l.lastIndexOf(' ') + 1)), Long::sum));
        }
        return m;
    }

    public static Map<String, Long> minus(Map<String, Long> now, Map<String, Long> before) {
        Map<String, Long> m = new TreeMap<>();
        now.forEach((k, v) -> { long d = v - before.getOrDefault(k, 0L); if (d != 0) m.put(k, d); });
        return m;
    }

    public interface Check { boolean ok() throws Exception; }

    public static void waitFor(Check c, int seconds) throws Exception {
        for (int i = 0; i < seconds * 2; i++) {
            if (c.ok()) return;
            Thread.sleep(500);
        }
        throw new IllegalStateException(seconds + " 秒內沒有等到");
    }
}
```

**`src/test/java/com/example/shop/dist08/Load.java`**（8.5 之後）

```java
package com.example.shop.dist08;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist07.Calls;
import com.example.shop.support.TestTokens;
import org.springframework.context.ConfigurableApplicationContext;

import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Collectors;

/**
 * 13 站第 08 章：開放式負載（第 06 章的 Rig、第 07 章 H4 的做法）—— 每秒固定 N 張下單，不等前一張回來。
 * 每一張記下：送出的時間（從開始算的毫秒）、狀態碼（-1 = 連不上入口）、花了多久。
 */
public final class Load implements AutoCloseable {

    public record Done(long atMs, int status, long millis) {}

    static final AtomicLong BUYERS = new AtomicLong(8_200_000);

    public final ConcurrentLinkedQueue<Done> done = new ConcurrentLinkedQueue<>();
    public final long t0 = System.nanoTime();
    private final AtomicBoolean stop = new AtomicBoolean();
    private final ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();
    private final Thread sender;

    private Load(ConfigurableApplicationContext keys, int port, int rate) {
        sender = new Thread(() -> {
            long gap = 1_000_000_000L / rate;
            for (long i = 0; !stop.get(); i++) {
                long wait = t0 + i * gap - System.nanoTime();
                if (wait > 0) try { Thread.sleep(wait / 1_000_000, (int) (wait % 1_000_000)); } catch (InterruptedException e) { return; }
                long at = (System.nanoTime() - t0) / 1_000_000;
                pool.submit(() -> {
                    long s0 = System.nanoTime();
                    int status;
                    try {
                        status = Calls.place(port, TestTokens.bearer(keys, BUYERS.incrementAndGet()),
                                SplitLab.FIRST_PRODUCT + ThreadLocalRandom.current().nextInt(SplitLab.PRODUCTS)).status();
                    } catch (Exception e) {
                        status = -1;
                    }
                    done.add(new Done(at, status, (System.nanoTime() - s0) / 1_000_000));
                });
            }
        });
        sender.start();
    }

    public static Load start(ConfigurableApplicationContext keys, int port, int rate) {
        return new Load(keys, port, rate);
    }

    /** 從開始算第幾秒（等到那一秒才回來） */
    public void until(long second) throws InterruptedException {
        long sleep = t0 + second * 1_000_000_000L - System.nanoTime();
        if (sleep > 0) Thread.sleep(sleep / 1_000_000);
    }

    public long elapsedMs() { return (System.nanoTime() - t0) / 1_000_000; }

    /** [fromMs, toMs) 送出的那幾張：每一種狀態碼幾張 */
    public Map<Integer, Long> codes(long fromMs, long toMs) {
        return done.stream().filter(d -> d.atMs() >= fromMs && d.atMs() < toMs)
                .collect(Collectors.groupingBy(Done::status, TreeMap::new, Collectors.counting()));
    }

    /** [fromMs, toMs) 送出、成功（201）的那幾張的 p50、p99（毫秒） */
    public long[] p50p99(long fromMs, long toMs) {
        long[] ms = done.stream().filter(d -> d.atMs() >= fromMs && d.atMs() < toMs && d.status() == 201).mapToLong(Done::millis).sorted().toArray();
        return new long[]{pct(ms, 50), pct(ms, 99)};
    }

    static long pct(long[] sorted, int p) {
        if (sorted.length == 0) return 0;
        return sorted[Math.min(sorted.length - 1, (int) Math.ceil(p / 100.0 * sorted.length) - 1)];
    }

    /** 停止送出，等還在路上的那幾張回來 */
    @Override
    public void close() throws Exception {
        stop.set(true);
        sender.join();
        pool.shutdown();
        pool.awaitTermination(90, TimeUnit.SECONDS);
    }

    public static List<String> fmt(Map<Integer, Long> codes) {
        return codes.entrySet().stream().map(e -> e.getKey() + "=" + e.getValue()).toList();
    }
}
```

**`src/test/java/com/example/shop/dist08/Traces.java`**（8.8.2、8.9.3）

```java
package com.example.shop.dist08;

import com.example.shop.dist07.Calls;
import com.example.shop.dist07.Jaeger;
import com.example.shop.dist07.Spans;
import com.fasterxml.jackson.databind.JsonNode;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * 13 站第 08 章：kind 裡的 Jaeger v2（k8s/observability，這台筆電經過 NodePort 18886）。
 * v2 的查詢：一條 trace 用 /api/traces/{id}（跟 v1 一樣）；找 trace（某個服務、某一段時間）要用 /api/v3/traces —— v1 的 /api/services、
 * /api/traces?service=… 在 2.21 都是 404。
 */
public final class Traces {

    public static final String BASE = "http://localhost:18886";

    private Traces() {}

    /** 這段時間裡，有這個服務的 span 的 trace：traceId → 這個 trace 在這個查詢裡出現的服務 */
    public static Map<String, Set<String>> search(String service, Instant from, Instant to) throws Exception {
        String q = BASE + "/api/v3/traces?query.service_name=" + URLEncoder.encode(service, StandardCharsets.UTF_8)
                + "&query.start_time_min=" + from.truncatedTo(ChronoUnit.SECONDS) + "&query.start_time_max=" + to.truncatedTo(ChronoUnit.SECONDS)
                + "&query.search_depth=1000";
        Map<String, Set<String>> out = new TreeMap<>();
        JsonNode r = Calls.JSON.readTree(Jaeger.get(q).body());
        for (JsonNode rs : r.path("result").path("resourceSpans")) {
            String svc = "";
            for (JsonNode a : rs.path("resource").path("attributes")) if (a.path("key").asText().equals("service.name")) svc = a.path("value").path("stringValue").asText();
            for (JsonNode ss : rs.path("scopeSpans"))
                for (JsonNode sp : ss.path("spans")) out.computeIfAbsent(sp.path("traceId").asText(), k -> new TreeSet<>()).add(svc);
        }
        return out;
    }

    /** 一條 trace 裡有哪些服務 */
    public static Set<String> services(String traceId) throws Exception {
        Set<String> s = new TreeSet<>();
        for (Spans.Rec r : Jaeger.trace(BASE, traceId)) s.add(r.service());
        return s;
    }

    /** 印成一棵樹（第 07 章的 Spans.tree） */
    public static List<String> tree(String traceId) throws Exception {
        Spans.reset();
        Spans.ALL.addAll(Jaeger.trace(BASE, traceId));
        return Spans.tree(traceId);
    }
}
```

**`src/test/java/com/example/shop/dist08/K0SmokeTest.java`**（8.4.5）

```java
package com.example.shop.dist08;

import com.example.shop.dist07.Calls;
import com.example.shop.dist07.Jaeger;
import com.example.shop.dist07.Keys;
import com.example.shop.shared.web.Role;
import com.example.shop.support.TestTokens;
import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * 13 站 8.4.5：搬到 kind 之後，整條路走一次 —— 下單（入口 → 訂單服務 → Service DNS → 庫存服務）、Prometheus 自己找到的 target、
 * Jaeger 裡的 trace（應用程式 → otel-collector.observability → Jaeger）。
 *
 *   scripts/d08-kind.sh cluster image observability deploy 之後：mvn test -Pexperiments -Dtest=K0SmokeTest
 */
@Tag("experiment")
class K0SmokeTest {

    final PrintStream out = System.out;

    @Test
    void smoke() throws Exception {
        try (ConfigurableApplicationContext keys = Keys.start()) {
            Kube.fresh(TestTokens.bearer(keys, 1, Role.ADMIN));
            out.printf("═══ 8.4.5 kind 上的兩個服務 ═══%n");
            out.printf("  庫存服務的 pod：%s%n", Kube.pods("inventory-service"));
            out.printf("  inventory-service 的 EndpointSlice：%s%n", Kube.endpoints("inventory-service"));
            Map<Integer, Integer> codes = new TreeMap<>();
            String traceId = null;
            for (int i = 0; i < 40; i++) {
                Calls.Res r = Calls.place(Kube.ENTRY, TestTokens.bearer(keys, Load.BUYERS.incrementAndGet()), com.example.shop.dist00.SplitLab.FIRST_PRODUCT + i);
                codes.merge(r.status(), 1, Integer::sum);
                if (r.status() == 201 && traceId == null) traceId = r.traceId();
            }
            out.printf("  下單 40 張：%s；每一個庫存服務的 pod 收到的預留：%s%n", codes, Kube.reservesByPod());
            for (int i = 0; i < 40 && targets().size() < 3; i++) Thread.sleep(1_000);
            out.printf("  Prometheus 的 target（kubernetes_sd）：%s%n", targets());
            Thread.sleep(10_000);                                           // span 的批次送出、Collector
            // v2 的服務清單在 /api/v3/services（v1 的 /api/services 在 2.21 是 404 —— 第一版印出空的）
            out.printf("  Jaeger 的服務：%s%n", Calls.JSON.readTree(Jaeger.get(Traces.BASE + "/api/v3/services").body()).path("services"));
            out.printf("  第一張下單的 traceId %s%n", traceId);
        }
    }

    static List<String> targets() throws Exception {
        List<String> out = new ArrayList<>();
        for (JsonNode t : Calls.JSON.readTree(Jaeger.get("http://localhost:18890/api/v1/targets").body()).path("data").path("activeTargets"))
            out.add(t.path("labels").path("job").asText() + "/" + t.path("labels").path("pod").asText() + " " + t.path("health").asText());
        out.sort(null);
        return out;
    }
}
```

**`src/test/java/com/example/shop/dist08/K2ScaleUpTest.java`**（8.6.1、8.6.2）

```java
package com.example.shop.dist08;

import com.example.shop.dist07.Keys;
import com.example.shop.shared.web.Role;
import com.example.shop.support.TestTokens;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * 13 站 8.6：K8s 的 Service 怎麼分請求。訂單服務找庫存服務用 http://inventory-service:8080 —— 一個 ClusterIP，
 * kube-proxy 在「建立連線」的那一刻挑一個 pod；之後同一條連線上的請求都到同一個 pod。訂單服務的 HTTP client（JDK HttpClient）會重用連線。
 *
 * 庫存服務 1 台、每秒 N 張下單；第 30 秒擴成 3 台。每 10 秒記一次：每一個庫存服務的 pod 這 10 秒處理了幾個預留、
 * 訂單服務的 pod 現在有幾條連線連到每一個庫存服務的 pod（/proc/net/tcp 裡 ESTABLISHED、對方是 :8080 的）。
 *
 *   mvn test -Pexperiments -Dtest=K2ScaleUpTest        （約 4 分鐘）
 */
@Tag("experiment")
class K2ScaleUpTest {

    final int rate = Integer.getInteger("k2.rate", 10);
    final long before = Long.getLong("k2.before", 30), after = Long.getLong("k2.after", 150);
    final PrintStream out = System.out;

    @Test
    void scaleUp() throws Exception {
        try (ConfigurableApplicationContext keys = Keys.start()) {
            Kube.fresh(TestTokens.bearer(keys, 1, Role.ADMIN));
            Kube.kubectl("scale", "deploy/inventory-service", "--replicas=1");      // fresh() 套的 manifest 是 2 台
            Kube.waitFor(() -> Kube.pods("inventory-service").size() == 1, 120);
            try (Load warm = Load.start(keys, Kube.ENTRY, rate)) { warm.until(20); }   // 暖機

            out.printf("═══ 8.6 擴成 3 台：每秒 %d 張下單；第 %d 秒 kubectl scale --replicas=3 ═══%n", rate, before);
            Map<String, Double> last = Kube.reservesByPod();
            List<String> rows = new ArrayList<>();
            Load load = Load.start(keys, Kube.ENTRY, rate);
            long scaledAt = -1;
            for (long s = 10; s <= before + after; s += 10) {
                load.until(s);
                Map<String, Double> now = Kube.reservesByPod();
                Map<String, List<Integer>> conns = connections();
                Map<String, String> cells = new LinkedHashMap<>();
                for (var e : now.entrySet()) {
                    double d = e.getValue() - last.getOrDefault(e.getKey(), 0.0);
                    cells.put(short_(e.getKey()), (Double.isNaN(d) ? "—" : String.valueOf((long) d)) + "（連線 " + conns.getOrDefault(short_(e.getKey()), List.of()) + "）");
                }
                rows.add(String.format("第 %3d 秒 │ %s │ endpoints %d 個", s, cells, Kube.endpoints("inventory-service").size()));
                last = now;
                if (s == before) {                                         // before 是 10 的倍數
                    Kube.kubectl("scale", "deploy/inventory-service", "--replicas=3");
                    scaledAt = load.elapsedMs();
                    rows.add(String.format("第 %3d 秒 ── kubectl scale --replicas=3", s));
                }
            }
            load.close();
            rows.forEach(r -> out.println("  " + r));
            out.printf("  下單：擴之前 %s；擴之後 %s%n", Load.fmt(load.codes(0, scaledAt)), Load.fmt(load.codes(scaledAt, Long.MAX_VALUE)));
            Kube.kubectl("scale", "deploy/inventory-service", "--replicas=2");
        }
    }

    static String short_(String pod) { return pod.substring(pod.lastIndexOf('-') + 1); }

    /**
     * 每一個庫存服務的 pod 上，ESTABLISHED、本機是 :8080 的 TCP 連線（從伺服器這一邊數：從訂單服務那一邊看，對方是 Service 的 ClusterIP，
     * 看不出是哪一個 pod —— 第一版從訂單服務數，每一格都是 0）。值是「對方的埠」：同一條連線，對方的埠不會變
     */
    static Map<String, List<Integer>> connections() throws Exception {
        Map<String, List<Integer>> m = new TreeMap<>();
        for (Kube.Pod p : Kube.pods("inventory-service")) {
            List<Integer> ports = new ArrayList<>();
            String raw;
            try { raw = Kube.kubectl("exec", p.name(), "--", "cat", "/proc/net/tcp", "/proc/net/tcp6"); } catch (Exception notYet) { continue; }
            for (String line : raw.lines().toList()) {
                String[] f = line.trim().split("\\s+");
                if (f.length < 4 || !f[3].equals("01")) continue;                               // 01 = ESTABLISHED
                if (!f[1].endsWith(":1F90")) continue;                                          // 本機的埠 8080
                ports.add(Integer.parseInt(f[2].substring(f[2].lastIndexOf(':') + 1), 16));
            }
            ports.sort(null);
            m.put(short_(p.name()), ports);
        }
        return m;
    }
}
```

**`src/test/java/com/example/shop/dist08/K3RolloutTest.java`**（8.6.4）

```java
package com.example.shop.dist08;

import com.example.shop.dist07.Keys;
import com.example.shop.shared.web.Role;
import com.example.shop.support.TestTokens;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 13 站 8.6.4：滾動更新庫存服務的時候，訂單服務的請求會不會送到正在關的那一台。
 * kubectl delete pod（滾動更新也是）同時做兩件事：kubelet 送 SIGTERM、控制面把這個 pod 從 EndpointSlice 拿掉 —— 兩者沒有先後的保證。
 * 02-spring-boot/08 的 8.7 用 preStop: sleep 讓「拿掉」先發生；那一章看的是入口，這裡看的是服務之間（kube-proxy）。
 *
 * 庫存服務 2 台、每秒 N 張下單，量兩次滾動更新：
 *   ① 舊的 pod 有 preStop（k8s/base 的寫法）
 *   ② 舊的 pod 沒有 preStop（先 patch 掉 lifecycle、讓它滾完一次，再量下一次）
 * 每 5 秒一段：下單的狀態碼與 p99、訂單服務呼叫預留的結果（ok、no_response……）與「沒有回應、再送一次」的次數。
 *
 *   mvn test -Pexperiments -Dtest=K3RolloutTest        （約 6 分鐘）
 */
@Tag("experiment")
class K3RolloutTest {

    final int rate = Integer.getInteger("k3.rate", 10);
    final PrintStream out = System.out;

    @Test
    void rollout() throws Exception {
        try (ConfigurableApplicationContext keys = Keys.start()) {
            Kube.fresh(TestTokens.bearer(keys, 1, Role.ADMIN));
            try (Load warm = Load.start(keys, Kube.ENTRY, rate)) { warm.until(20); }
            out.printf("═══ 8.6.4 滾動更新庫存服務（2 台，maxSurge 1、maxUnavailable 0）：每秒 %d 張下單 ═══%n", rate);
            measure(keys, "① 舊的 pod 有 preStop: sleep 10");

            Kube.kubectl("patch", "deploy/inventory-service", "--type=json", "-p", "[{\"op\":\"remove\",\"path\":\"/spec/template/spec/containers/0/lifecycle\"}]");
            Kube.kubectl("rollout", "status", "deploy/inventory-service", "--timeout=300s");
            Kube.waitFor(() -> Kube.pods("inventory-service").stream().noneMatch(Kube.Pod::terminating), 120);
            measure(keys, "② 舊的 pod 沒有 preStop");

            Kube.script("deploy");                                          // 恢復 k8s/kind 的樣子
        }
    }

    void measure(ConfigurableApplicationContext keys, String title) throws Exception {
        List<String> windows = new ArrayList<>();
        Map<String, Long> outcomes0 = Kube.reserveOutcomes();
        double retries0 = Kube.orderSum("shop_remote_no_response_total", "op=\"reserve\"");
        Load load = Load.start(keys, Kube.ENTRY, rate);
        load.until(15);
        long restartAt = load.elapsedMs();
        Kube.kubectl("rollout", "restart", "deploy/inventory-service");
        Kube.kubectl("rollout", "status", "deploy/inventory-service", "--timeout=300s");
        Kube.waitFor(() -> Kube.pods("inventory-service").stream().noneMatch(Kube.Pod::terminating), 120);
        long doneAt = load.elapsedMs();
        long end = (doneAt / 5000 + 3) * 5;                                  // 滾完之後再 10～15 秒
        load.until(end);
        load.close();
        Map<String, Long> outcomes = Kube.reserveOutcomes();
        double retries = Kube.orderSum("shop_remote_no_response_total", "op=\"reserve\"") - retries0;
        for (long s = 5; s <= end; s += 5) {
            long[] p = load.p50p99((s - 5) * 1000, s * 1000);
            windows.add(String.format("%3d～%3d 秒 │ 下單 %-26s │ p99 %5d ms", s - 5, s, String.join(" ", Load.fmt(load.codes((s - 5) * 1000, s * 1000))), p[1]));
        }
        out.printf("  %s：第 %.1f 秒 kubectl rollout restart，第 %.1f 秒舊的 pod 都結束了%n", title, restartAt / 1000.0, doneAt / 1000.0);
        windows.forEach(l -> out.println("    " + l));
        out.printf("    整段：下單 %s；預留呼叫的結果 %s；沒有回應的送出 %.0f 次%n", Load.fmt(load.codes(0, Long.MAX_VALUE)), Kube.minus(outcomes, outcomes0), retries);
    }
}
```

**`src/test/java/com/example/shop/dist08/K4HungPodTest.java`**（8.5.2）

```java
package com.example.shop.dist08;

import com.example.shop.dist07.Keys;
import com.example.shop.shared.web.Role;
import com.example.shop.support.TestTokens;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 13 站 8.5.2：一台庫存服務卡住了 —— 不是死掉：行程還在、埠還開著，連線建得起來，只是什麼都不回（kill -STOP，從 kind 的 node 送）。
 * 這是服務發現最難的一種：問「它還在嗎」，網路說在。K8s 靠的是 readinessProbe（每 5 秒、連續 2 次失敗 → 從 endpoints 拿掉）
 * 與 livenessProbe（每 10 秒、連續 3 次 → 重啟容器）。
 *
 * 庫存服務 2 台、每秒 N 張下單；第 20 秒讓其中一台卡住，不放開。每秒看一次：EndpointSlice 裡還有沒有它、它的 ready 與重啟次數、
 * 訂單服務的熔斷器；每 5 秒一段：下單的狀態碼與 p99、預留呼叫的結果。
 *
 *   mvn test -Pexperiments -Dtest=K4HungPodTest        （約 4 分鐘）
 */
@Tag("experiment")
class K4HungPodTest {

    final int rate = Integer.getInteger("k4.rate", 10);
    final long stopAt = 20, total = Long.getLong("k4.total", 150);
    final PrintStream out = System.out;

    @Test
    void hungPod() throws Exception {
        try (ConfigurableApplicationContext keys = Keys.start()) {
            Kube.fresh(TestTokens.bearer(keys, 1, Role.ADMIN));
            try (Load warm = Load.start(keys, Kube.ENTRY, rate)) { warm.until(20); }
            out.printf("═══ 8.5.2 一台庫存服務卡住（kill -STOP）：每秒 %d 張下單；第 %d 秒卡住連線最多的那一台，不放開 ═══%n", rate, stopAt);
            List<String> timeline = new ArrayList<>();
            List<String> windows = new ArrayList<>();
            Map<String, Long> outcomes0 = Kube.reserveOutcomes();
            String lastState = "", victim = null;
            Load load = Load.start(keys, Kube.ENTRY, rate);
            for (long s = 1; s <= total; s++) {
                load.until(s);
                if (s == stopAt) {
                    // 卡住「正在用的那一台」：這一刻訂單服務連進來的連線最多的那一個 pod。
                    // 第一版挑第一個 pod —— 剛好不是訂單服務連著的那一台，只錯了 1 張
                    Map<String, List<Integer>> conns = K2ScaleUpTest.connections();
                    String busiest = conns.entrySet().stream().max(java.util.Comparator.comparingInt(e -> e.getValue().size())).orElseThrow().getKey();
                    victim = Kube.pods("inventory-service").stream().map(Kube.Pod::name).filter(n -> n.endsWith("-" + busiest)).findFirst().orElseThrow();
                    Kube.signal(victim, "STOP");
                    timeline.add(String.format("第 %3d 秒 ── kill -STOP %s（這一刻訂單服務連進來的連線：%s）", s, busiest, conns));
                }
                if (victim != null) {
                    String state = state(victim);
                    if (!state.equals(lastState)) timeline.add(String.format("第 %3d 秒    %s", load.elapsedMs() / 1000, state));
                    lastState = state;
                }
                if (s % 5 == 0) {
                    Map<String, Long> outcomes = Kube.reserveOutcomes();
                    long[] p = load.p50p99((s - 5) * 1000, s * 1000);
                    windows.add(String.format("%3d～%3d 秒 │ 下單 %-22s │ p99 %5d ms │ 預留 %s", s - 5, s,
                            String.join(" ", Load.fmt(load.codes((s - 5) * 1000, s * 1000))), p[1], Kube.minus(outcomes, outcomes0)));
                    outcomes0 = outcomes;
                }
            }
            load.close();
            out.println("  時間軸（每秒看一次 EndpointSlice、pod、熔斷器；只記變化）：");
            timeline.forEach(l -> out.println("    " + l));
            out.println("  每 5 秒：");
            windows.forEach(l -> out.println("    " + l));
        }
    }

    /** 卡住的那一台：在不在 endpoints 裡、ready、重啟了幾次；訂單服務的熔斷器 */
    static String state(String victim) throws Exception {
        boolean inEndpoints = Kube.endpoints("inventory-service").contains(victim);
        String pod = "（pod 不見了）";
        for (Kube.Pod p : Kube.pods("inventory-service"))
            if (p.name().equals(victim)) {
                String restarts = Kube.kubectl("get", "pod", victim, "-o", "jsonpath={.status.containerStatuses[0].restartCount}").trim();
                pod = (p.ready() ? "ready" : "not ready") + "、重啟 " + restarts + " 次";
            }
        String breaker = "?";
        String m = Kube.metrics(Kube.pods("order-service").get(0).name());
        if (m != null) breaker = m.lines().filter(l -> l.startsWith("resilience4j_circuitbreaker_state{") && l.contains("name=\"inventory-reserve\"") && l.endsWith(" 1.0"))
                .map(l -> l.replaceAll(".*state=\"([a-z_]+)\".*", "$1")).findFirst().orElse("?");
        return String.format("%s：%s；%s；熔斷器 %s", K2ScaleUpTest.short_(victim), inEndpoints ? "在 endpoints 裡" : "不在 endpoints 裡", pod, breaker);
    }
}
```

**`src/test/java/com/example/shop/dist08/K5EdgeTraceTest.java`**（8.8.2）

```java
package com.example.shop.dist08;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist07.Calls;
import com.example.shop.dist07.Keys;
import com.example.shop.shared.web.Role;
import com.example.shop.support.TestTokens;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ThreadLocalRandom;

/**
 * 13 站 8.8.2：入口進來之後，trace 從哪裡開始、誰決定 traceId。四種設定，同一組量法：
 *   ① 第 07 章的樣子：入口照收買家帶來的 trace header；訂單服務不收入口的 traceparent（TraceFilters ⓪）；沒有 NetworkPolicy
 *   ② 只打開訂單服務的信任（shop.deployment.edge.trust-traceparent）與 NetworkPolicy，入口照收買家的
 *   ③ 入口拿掉買家的 trace header（ClientTrafficPolicy）、訂單服務信任入口，但沒有 NetworkPolicy
 *   ④ 三樣都有
 * 量法：
 *   a. 經過入口下 100 張單：入口抽到的 trace 有幾個、其中幾個接上了訂單服務與庫存服務；回應的 X-Trace-Id 有幾個是入口的 traceId
 *   b. 經過入口、自己帶 traceparent（每一個不同的 traceId、sampled）100 次：Jaeger 裡用了買家給的 traceId 的 trace 有幾個、回應的 X-Trace-Id 是買家給的有幾個
 *   c. 不經過入口：cluster 裡另一個 pod 直接打訂單服務、自己帶 traceparent —— 連得到嗎、X-Trace-Id 是不是它給的
 * 最後在 ④：一張單付款，找一條被抽到的，印出「入口 → 訂單服務 → MQ → 庫存服務」那一棵樹（README 產出 4）。
 *
 *   mvn test -Pexperiments -Dtest=K5EdgeTraceTest        （約 6 分鐘）
 */
@Tag("experiment")
class K5EdgeTraceTest {

    static final String PROBE = "np-probe", CALLBACK_SECRET = "local-dev-only-payment-callback-secret-0123";
    final PrintStream out = System.out;

    @Test
    void edge() throws Exception {
        try (ConfigurableApplicationContext keys = Keys.start()) {
            Kube.fresh(TestTokens.bearer(keys, 1, Role.ADMIN));
            probePod();
            out.println("═══ 8.8.2 入口進來之後：trace 從哪裡開始、誰決定 traceId ═══");
            configure(false, false, false);
            measure(keys, "① 入口照收買家的 trace header、訂單服務不收入口的、沒有 NetworkPolicy");
            configure(false, true, true);
            measure(keys, "② 訂單服務收入口的、有 NetworkPolicy，但入口照收買家的");
            configure(true, true, false);
            measure(keys, "③ 入口拿掉買家的、訂單服務收入口的、沒有 NetworkPolicy");
            configure(true, true, true);
            measure(keys, "④ 三樣都有");
            paymentTrace(keys);
        } finally {
            Kube.kubectl("delete", "pod", PROBE, "--ignore-not-found", "--now");
        }
    }

    void probePod() throws Exception {
        Kube.kubectl("delete", "pod", PROBE, "--ignore-not-found", "--now");
        Kube.kubectl("run", PROBE, "--image=curlimages/curl:8.11.1", "--restart=Never", "--command", "--", "sleep", "3600");
        Kube.kubectl("wait", "--for=condition=Ready", "pod/" + PROBE, "--timeout=120s");
    }

    /** strip：入口的 ClientTrafficPolicy；trust：訂單服務的 shop.deployment.edge.trust-traceparent（改 ConfigMap、重開）；np：NetworkPolicy */
    void configure(boolean strip, boolean trust, boolean np) throws Exception {
        Kube.kubectl(strip ? "apply" : "delete", "-f", "k8s/gateway/client-traffic.yaml", strip ? "--validate=true" : "--ignore-not-found");
        Kube.kubectl(np ? "apply" : "delete", "-f", "k8s/base/network-policy.yaml", np ? "--validate=true" : "--ignore-not-found");
        String now = Kube.kubectl("get", "configmap", "order-service", "-o", "jsonpath={.data.SHOP_DEPLOYMENT_EDGE_TRUST_TRACEPARENT}").trim();
        if (!now.equals(String.valueOf(trust))) {
            Kube.kubectl("patch", "configmap", "order-service", "--type=merge", "-p", "{\"data\":{\"SHOP_DEPLOYMENT_EDGE_TRUST_TRACEPARENT\":\"" + trust + "\"}}");
            Kube.kubectl("rollout", "restart", "deploy/order-service");
            Kube.kubectl("rollout", "status", "deploy/order-service", "--timeout=300s");
            Kube.waitFor(() -> Kube.pods("order-service").stream().noneMatch(Kube.Pod::terminating), 120);
        }
        Thread.sleep(5_000);                                                // 入口的 Envoy 拿到新的設定
    }

    void measure(ConfigurableApplicationContext keys, String title) throws Exception {
        out.println("  " + title);
        // a. 100 張單
        Instant from = Instant.now().minusSeconds(2);
        Set<String> echoed = new HashSet<>();
        int ok = 0;
        for (int i = 0; i < 100; i++) {
            Calls.Res r = Calls.place(Kube.ENTRY, TestTokens.bearer(keys, Load.BUYERS.incrementAndGet()),
                    SplitLab.FIRST_PRODUCT + ThreadLocalRandom.current().nextInt(SplitLab.PRODUCTS));
            if (r.status() == 201) ok++;
            if (r.traceId() != null) echoed.add(r.traceId());
        }
        Thread.sleep(10_000);                                               // span 的批次送出、Collector、Jaeger
        Map<String, Set<String>> edge = Traces.search("shop.shop", from, Instant.now());
        int withOrder = 0, withBoth = 0;
        for (String t : edge.keySet()) {
            Set<String> s = Traces.services(t);
            if (s.contains("order-service")) withOrder++;
            if (s.contains("order-service") && s.contains("inventory-service")) withBoth++;
        }
        long sameId = edge.keySet().stream().filter(echoed::contains).count();
        out.printf("    a. 經過入口下單 100 張（201 有 %d 張）：入口抽到的 trace %d 個，接上訂單服務的 %d 個、訂單＋庫存都接上的 %d 個；回應的 X-Trace-Id 是入口的 traceId 的 %d 個%n",
                ok, edge.size(), withOrder, withBoth, sameId);

        // b. 自己帶 traceparent
        from = Instant.now().minusSeconds(2);
        List<String> forged = new ArrayList<>();
        int echoedForged = 0;
        for (int i = 0; i < 100; i++) {
            String id = String.format("%016x%016x", ThreadLocalRandom.current().nextLong(), ThreadLocalRandom.current().nextLong());
            forged.add(id);
            Calls.Res r = Calls.send(Kube.ENTRY, "GET", "/api/ping", null, null, Map.of("traceparent", "00-" + id + "-" + String.format("%016x", ThreadLocalRandom.current().nextLong()) + "-01"));
            if (id.equals(r.traceId())) echoedForged++;
        }
        Thread.sleep(10_000);
        Map<String, Set<String>> afterForged = Traces.search("shop.shop", from, Instant.now());
        long usedForged = afterForged.keySet().stream().filter(forged::contains).count();
        out.printf("    b. 經過入口、自己帶 traceparent 100 次：入口抽到的 trace %d 個，用了買家給的 traceId 的 %d 個；回應的 X-Trace-Id 是買家給的 %d 個%n",
                afterForged.size(), usedForged, echoedForged);

        // c. 不經過入口
        String id = String.format("%016x%016x", ThreadLocalRandom.current().nextLong(), ThreadLocalRandom.current().nextLong());
        String result;
        try {
            String raw = Kube.kubectl("exec", PROBE, "--", "curl", "-s", "-m", "3", "-D", "-", "-o", "/dev/null",
                    "-H", "traceparent: 00-" + id + "-00f067aa0ba902b7-01", "http://order-service:8080/api/ping");
            String status = raw.lines().findFirst().orElse("?").trim();
            String trace = raw.lines().filter(l -> l.toLowerCase().startsWith("x-trace-id:")).map(l -> l.substring(l.indexOf(':') + 1).trim()).findFirst().orElse(null);
            result = status + "，X-Trace-Id " + (id.equals(trace) ? "是它給的" : "不是它給的");
        } catch (IllegalStateException timeout) {
            result = "連不上（curl 3 秒逾時）";
        }
        out.printf("    c. cluster 裡另一個 pod 直接打訂單服務的 8080、自己帶 traceparent：%s%n", result);
    }

    /** ④ 的狀態：一張單付款，找一條被入口抽到的，等庫存服務的消費者那一段到了，印出整棵樹 */
    void paymentTrace(ConfigurableApplicationContext keys) throws Exception {
        for (int i = 1; i <= 60; i++) {
            String buyer = TestTokens.bearer(keys, Load.BUYERS.incrementAndGet());
            Calls.Res placed = Calls.place(Kube.ENTRY, buyer, SplitLab.FIRST_PRODUCT + ThreadLocalRandom.current().nextInt(SplitLab.PRODUCTS));
            if (placed.status() != 201) continue;
            Calls.Res paid = Calls.pay(Kube.ENTRY, buyer, placed.json().get("orderNo").asText(), CALLBACK_SECRET);
            String trace = paid.traceId();
            Set<String> s = Set.of();
            for (int w = 0; w < 30; w++) {
                Thread.sleep(1_000);
                s = Traces.services(trace);
                if (s.isEmpty() && w >= 12) break;                          // 沒有被抽到
                if (s.contains("shop.shop") && s.contains("inventory-service")) break;
            }
            if (s.contains("shop.shop") && s.contains("inventory-service")) {
                out.printf("  ④ 付款的回呼（第 %d 張才被入口抽到）：traceId %s，服務 %s%n", i, trace, s);
                Traces.tree(trace).forEach(l -> out.println("      " + l));
                return;
            }
        }
        out.println("  ④ 付款的回呼：60 張都沒有被抽到");
    }
}
```

**`src/test/java/com/example/shop/dist08/K6ClientIpTest.java`**（8.8.3）

```java
package com.example.shop.dist08;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist07.Keys;
import com.example.shop.shared.web.Role;
import com.example.shop.support.TestTokens;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * 13 站 8.8.3：入口後面，「每個 IP 每秒 50 次」（第 12 站 0.6.5，RateLimitFilter 用 request.getRemoteAddr()）數的是誰。
 * 訂單服務看到的對方是入口的 Envoy —— 每一個買家都是同一個 IP，全站共用一個額度。
 *
 * 這台筆電只有一個來源 IP。實驗用 X-Forwarded-For 假裝是很多買家：每一個請求帶 203.0.113.0～249 其中一個（文件用的位址），
 * 就像入口前面還有一層負載平衡器、它寫下買家的 IP。Envoy 會把它看到的對方（這台筆電，172.x，私有位址）接在後面。
 * 每秒 80 個商品頁（GET /api/products/{id}，不用登入、有快取），20 秒，兩種設定：
 *   ① 訂單服務不看 X-Forwarded-For（現在的樣子）
 *   ② server.forward-headers-strategy=native：Tomcat 的 RemoteIpValve 從右往左略過「內部的代理」（預設是私有位址），第一個不是的就是買家
 *   ③ 同 ②，但請求從 cluster 裡的一個 pod 送到入口（私有位址）—— 正式環境的樣子：入口前面那一層負載平衡器在 VPC 裡，它的位址是私有的。
 *      這台筆電經過 Docker Desktop 進到 kind，Envoy 看到的位址不是私有的（②），RemoteIpValve 會停在它那裡
 * 負載中途掃一次 Redis：限流的 key（rl:ip:<IP>:<那一秒>）用的是哪些 IP。
 *
 *   mvn test -Pexperiments -Dtest=K6ClientIpTest        （約 4 分鐘）
 */
@Tag("experiment")
class K6ClientIpTest {

    final int rate = Integer.getInteger("k6.rate", 80), seconds = Integer.getInteger("k6.seconds", 20);
    final PrintStream out = System.out;
    final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();

    @Test
    void clientIp() throws Exception {
        try (ConfigurableApplicationContext keys = Keys.start()) {
            Kube.fresh(TestTokens.bearer(keys, 1, Role.ADMIN));
            out.printf("═══ 8.8.3 入口後面的「每個 IP 每秒 50 次」：每秒 %d 個商品頁、%d 秒，每一個帶不同的 X-Forwarded-For（250 個買家）═══%n", rate, seconds);
            configure("none");
            measure("① 訂單服務不看 X-Forwarded-For");
            configure("native");
            measure("② server.forward-headers-strategy=native");
            fromInsideTheCluster("③ 同 ②，請求從 cluster 裡的 pod 送到入口");
        }
    }

    void configure(String strategy) throws Exception {
        String now = Kube.kubectl("get", "configmap", "order-service", "-o", "jsonpath={.data.SERVER_FORWARD_HEADERS_STRATEGY}").trim();
        if (now.equals(strategy)) return;
        Kube.kubectl("patch", "configmap", "order-service", "--type=merge", "-p", "{\"data\":{\"SERVER_FORWARD_HEADERS_STRATEGY\":\"" + strategy + "\"}}");
        Kube.kubectl("rollout", "restart", "deploy/order-service");
        Kube.kubectl("rollout", "status", "deploy/order-service", "--timeout=300s");
        Kube.waitFor(() -> Kube.pods("order-service").stream().noneMatch(Kube.Pod::terminating), 120);
        Thread.sleep(5_000);
    }

    void measure(String title) throws Exception {
        for (int i = 0; i < 100; i++) get(i, "198.51.100.1");                // 暖機（JIT、商品快取），不算
        Thread.sleep(1_500);
        Map<Integer, Integer> codes = new ConcurrentHashMap<>();
        ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();
        long t0 = System.nanoTime(), gap = 1_000_000_000L / rate;
        Set<String> keyIps = java.util.Collections.synchronizedSet(new TreeSet<>());
        for (long i = 0; i < (long) rate * seconds; i++) {
            long wait = t0 + i * gap - System.nanoTime();
            if (wait > 0) Thread.sleep(wait / 1_000_000, (int) (wait % 1_000_000));
            long n = i;
            pool.submit(() -> codes.merge(get(n, "203.0.113." + (n % 250)), 1, Integer::sum));
            if (i == (long) rate * seconds / 2) pool.submit(() -> { keyIps.addAll(rateLimitKeys()); return null; });   // 另一條執行緒：不要拖到送出的節奏
        }
        pool.shutdown();
        pool.awaitTermination(60, TimeUnit.SECONDS);
        String sample = keyIps.stream().limit(3).toList().toString();
        out.printf("  %s：%s；負載中途 Redis 裡限流的 key 有 %d 個不同的 IP（例如 %s）%n", title, new TreeMap<>(codes), keyIps.size(), sample);
    }

    int get(long n, String xff) {
        try {
            return http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + Kube.ENTRY + "/api/products/" + (SplitLab.FIRST_PRODUCT + n % 50)))
                    .header("X-Forwarded-For", xff).timeout(Duration.ofSeconds(10)).build(), HttpResponse.BodyHandlers.discarding()).statusCode();
        } catch (Exception e) {
            return -1;
        }
    }

    /** curl --parallel --rate：每一個請求一個 X-Forwarded-For（curl 設定檔裡用 next 分開，每一段有自己的 header） */
    void fromInsideTheCluster(String title) throws Exception {
        String probe = "xff-probe";
        Kube.kubectl("delete", "pod", probe, "--ignore-not-found", "--now");
        Kube.kubectl("run", probe, "--image=curlimages/curl:8.11.1", "--restart=Never", "--command", "--", "sleep", "3600");
        Kube.kubectl("wait", "--for=condition=Ready", "pod/" + probe, "--timeout=120s");
        try {
            String edge = Kube.sh("kubectl", "--context", Kube.CTX, "-n", "envoy-gateway-system", "get", "svc", "-l",
                    "gateway.envoyproxy.io/owning-gateway-name=shop", "-o", "jsonpath={.items[0].metadata.name}").trim();
            // curl 的 --rate 在 --parallel 底下沒有作用（第一版：1,600 個在幾秒內送完，100 個失敗）——
            // 改成 4 個 curl 同時跑、各自一個一個送、每秒 rate/4 個
            for (int part = 0; part < 4; part++) {
                StringBuilder cfg = new StringBuilder();
                for (int n = part; n < rate * seconds; n += 4)
                    cfg.append("url = \"http://").append(edge).append(".envoy-gateway-system/api/products/").append(SplitLab.FIRST_PRODUCT + n % 50).append("\"\n")
                            .append("header = \"X-Forwarded-For: 203.0.113.").append(n % 250).append("\"\n")
                            .append("output = \"/dev/null\"\nwrite-out = \"%{http_code}\\n\"\nnext\n");
                java.nio.file.Path file = java.nio.file.Path.of("target", "k6-" + part + ".cfg");
                java.nio.file.Files.writeString(file, cfg.toString());
                Kube.kubectl("cp", file.toString(), probe + ":/tmp/k6-" + part + ".cfg");
            }
            Set<String> keyIps = java.util.Collections.synchronizedSet(new TreeSet<>());
            Thread scan = new Thread(() -> {
                try { Thread.sleep(seconds * 500L); keyIps.addAll(rateLimitKeys()); } catch (Exception e) { }
            });
            scan.start();
            String raw = Kube.shAny("kubectl", "--context", Kube.CTX, "-n", Kube.NS, "exec", probe, "--", "sh", "-c",
                    "for i in 0 1 2 3; do curl -s --rate " + rate / 4 + "/s -K /tmp/k6-$i.cfg > /tmp/k6-$i.out & done; wait; cat /tmp/k6-*.out");
            // 000 = 那一個請求失敗。各寫各的檔案：第一版 4 個 curl 寫同一個輸出，有幾行黏在一起（1,600 個只數到 1,593）
            scan.join();
            Map<String, Integer> codes = new TreeMap<>();
            raw.lines().filter(l -> l.matches("\\d{3}")).forEach(l -> codes.merge(l, 1, Integer::sum));
            out.printf("  %s：%s；負載中途 Redis 裡限流的 key 有 %d 個不同的 IP（例如 %s）%n", title, codes, keyIps.size(), keyIps.stream().limit(3).toList());
        } finally {
            Kube.kubectl("delete", "pod", probe, "--ignore-not-found", "--now");
        }
    }

    /** 訂單服務的 Redis（7 號）裡，每 IP 限流的 key 用了哪些 IP */
    static Set<String> rateLimitKeys() throws Exception {
        Set<String> ips = new TreeSet<>();
        for (String k : Kube.sh("docker", "compose", "exec", "-T", "redis", "redis-cli", "-n", "7", "--scan", "--pattern", "rl:ip:*").lines().toList())
            if (k.startsWith("rl:ip:")) ips.add(k.substring("rl:ip:".length(), k.lastIndexOf(':')));
        return ips;
    }
}
```

**`src/test/java/com/example/shop/dist08/K7DiscoveryAlertTest.java`**（8.9.1）

```java
package com.example.shop.dist08;

import com.example.shop.dist07.Calls;
import com.example.shop.dist07.Jaeger;
import com.example.shop.dist07.Keys;
import com.example.shop.shared.web.Role;
import com.example.shop.support.TestTokens;
import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * 13 站 8.9.1：Prometheus 用 kubernetes_sd 找 target 之後，擴縮不用改設定 —— 但「一台都不見了」長什麼樣？
 * 第 12 站的 ShopDown 是 up == 0：抓得到 target、抓不到指標。K8s 上被刪掉的 pod 不會變成 down，它直接從 target 裡消失。
 *
 * 庫存服務 2 台 → 3 台 → 1 台 → 0 台（每一步等 target 跟上，記下花了幾秒）；0 台的時候每秒 2 張下單、每 15 秒問一次告警，看 4 分鐘。
 *
 *   mvn test -Pexperiments -Dtest=K7DiscoveryAlertTest        （約 8 分鐘）
 */
@Tag("experiment")
class K7DiscoveryAlertTest {

    static final String PROM = "http://localhost:18890";
    final long goneSeconds = Long.getLong("k7.gone", 240);
    final PrintStream out = System.out;

    @Test
    void discovery() throws Exception {
        try (ConfigurableApplicationContext keys = Keys.start()) {
            Kube.fresh(TestTokens.bearer(keys, 1, Role.ADMIN));
            Kube.waitFor(() -> inventoryTargets().size() == 2 && inventoryTargets().values().stream().allMatch("up"::equals), 120);
            out.printf("═══ 8.9.1 Prometheus 的 kubernetes_sd：庫存服務擴縮時的 target 與告警 ═══%n");
            out.printf("  一開始：%s%n", inventoryTargets());
            for (int n : new int[]{3, 1}) {
                long t0 = System.nanoTime();
                Kube.kubectl("scale", "deploy/inventory-service", "--replicas=" + n);
                Kube.waitFor(() -> inventoryTargets().size() == n && inventoryTargets().values().stream().allMatch("up"::equals), 300);
                out.printf("  kubectl scale --replicas=%d → %.0f 秒後 target 是 %s%n", n, (System.nanoTime() - t0) / 1e9, inventoryTargets());
            }

            Kube.kubectl("scale", "deploy/inventory-service", "--replicas=0");
            long t0 = System.nanoTime();
            List<String> timeline = new ArrayList<>();
            Map<String, String> state = new LinkedHashMap<>();
            String lastTargets = null;
            try (Load load = Load.start(keys, Kube.ENTRY, 2)) {
                for (long s = 0; s <= goneSeconds; s += 15) {
                    load.until(s);
                    String targets = inventoryTargets().toString();
                    if (!targets.equals(lastTargets)) timeline.add(String.format("第 %3d 秒 庫存服務的 target：%s", s, targets));
                    lastTargets = targets;
                    Map<String, String> now = alerts();
                    for (var e : now.entrySet()) if (!e.getValue().equals(state.get(e.getKey()))) timeline.add(String.format("第 %3d 秒 %s %s", s, e.getKey(), e.getValue()));
                    for (var k : state.keySet()) if (!now.containsKey(k)) timeline.add(String.format("第 %3d 秒 %s 解除", s, k));
                    state = now;
                }
                load.close();
                out.printf("  kubectl scale --replicas=0，接下來 %d 秒（每秒 2 張下單：%s）：%n", goneSeconds, Load.fmt(load.codes(0, Long.MAX_VALUE)));
            }
            timeline.forEach(l -> out.println("    " + l));
            out.printf("  （up{job=\"inventory-service\"} 現在有 %d 條序列）%n", series("up{job=\"inventory-service\"}"));
            Kube.kubectl("scale", "deploy/inventory-service", "--replicas=2");
            Kube.kubectl("rollout", "status", "deploy/inventory-service", "--timeout=300s");
        }
    }

    /** 庫存服務的 target：pod → health */
    static Map<String, String> inventoryTargets() throws Exception {
        Map<String, String> m = new TreeMap<>();
        for (JsonNode t : Calls.JSON.readTree(Jaeger.get(PROM + "/api/v1/targets").body()).path("data").path("activeTargets"))
            if (t.path("labels").path("job").asText().equals("inventory-service"))
                m.put(K2ScaleUpTest.short_(t.path("labels").path("pod").asText()), t.path("health").asText());
        return m;
    }

    /** 現在的告警：名字{job} → pending / firing */
    static Map<String, String> alerts() throws Exception {
        Map<String, String> m = new TreeMap<>();
        for (JsonNode a : Calls.JSON.readTree(Jaeger.get(PROM + "/api/v1/alerts").body()).path("data").path("alerts"))
            m.put(a.path("labels").path("alertname").asText() + (a.path("labels").has("job") ? "{" + a.path("labels").path("job").asText() + "}" : ""),
                    a.path("state").asText());
        return m;
    }

    static int series(String promql) throws Exception {
        return Calls.JSON.readTree(Jaeger.get(PROM + "/api/v1/query?query=" + java.net.URLEncoder.encode(promql, java.nio.charset.StandardCharsets.UTF_8)).body())
                .path("data").path("result").size();
    }
}
```

**`src/test/java/com/example/shop/dist08/K8ConfigTest.java`**（8.7.1）

```java
package com.example.shop.dist08;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist07.Calls;
import com.example.shop.dist07.Keys;
import com.example.shop.shared.web.Role;
import com.example.shop.support.TestTokens;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.time.Duration;
import java.time.Instant;

/**
 * 13 站 8.7.1：改一個設定要多久才生效。拿付款期限（shop.order.payment-timeout，預設 15 分鐘）當例子 —— 下單的回應帶著 createdAt 與
 * paymentDeadline，相減就是「訂單服務現在用的值」。
 *
 *   ① ConfigMap 掛成檔案（configtree：Spring Boot 把一個目錄裡的每一個檔案讀成一個設定，檔名是 key）。把值改成 20m：
 *      pod 裡的檔案多久之後變了？訂單服務用的值變了沒有？
 *   ② kubectl rollout restart（每秒 5 張下單）：滾完要多久、這段時間的下單、之後的值
 * 實驗用 kubectl patch 臨時給訂單服務加上 volume 與 SPRING_CONFIG_IMPORT，最後拿掉（k8s/base 不這樣做：設定是環境變數，8.7.2 的選擇）
 *
 *   mvn test -Pexperiments -Dtest=K8ConfigTest        （約 6 分鐘）
 */
@Tag("experiment")
class K8ConfigTest {

    static final String KEY = "shop.order.payment-timeout", DIR = "/etc/shop/tuning";
    final PrintStream out = System.out;

    @Test
    void config() throws Exception {
        try (ConfigurableApplicationContext keys = Keys.start()) {
            Kube.fresh(TestTokens.bearer(keys, 1, Role.ADMIN));
            out.printf("═══ 8.7.1 改一個設定（付款期限 15m → 20m）要多久才生效 ═══%n");
            out.printf("  一開始：下單的付款期限 %s%n", deadline(keys));

            Kube.kubectl("delete", "configmap", "order-tuning", "--ignore-not-found");
            Kube.kubectl("create", "configmap", "order-tuning", "--from-literal=" + KEY + "=15m");
            Kube.kubectl("patch", "deploy/order-service", "--type=json", "-p", """
                    [{"op":"add","path":"/spec/template/spec/volumes","value":[{"name":"tuning","configMap":{"name":"order-tuning"}}]},
                     {"op":"add","path":"/spec/template/spec/containers/0/volumeMounts","value":[{"name":"tuning","mountPath":"%s"}]},
                     {"op":"add","path":"/spec/template/spec/containers/0/env","value":[{"name":"SPRING_CONFIG_IMPORT","value":"optional:configtree:%s/"}]}]
                    """.formatted(DIR, DIR));
            waitRollout();
            String pod = Kube.pods("order-service").get(0).name();
            out.printf("  ① 掛成檔案（%s/%s = 15m）：下單的付款期限 %s%n", DIR, KEY, deadline(keys));

            Instant t0 = Instant.now();
            Kube.kubectl("patch", "configmap", "order-tuning", "--type=merge", "-p", "{\"data\":{\"" + KEY + "\":\"20m\"}}");
            String file = "15m";
            long changedAt = -1;
            for (int s = 1; s <= 180 && changedAt < 0; s++) {
                Thread.sleep(Math.max(0, t0.plusSeconds(s).toEpochMilli() - System.currentTimeMillis()));
                file = Kube.kubectl("exec", pod, "--", "cat", DIR + "/" + KEY).trim();
                if (file.equals("20m")) changedAt = Duration.between(t0, Instant.now()).toSeconds();
            }
            out.printf("     ConfigMap 改成 20m → pod 裡的檔案 %s%n", changedAt < 0 ? "180 秒都沒有變" : changedAt + " 秒後變成 " + file);
            Thread.sleep(30_000);
            out.printf("     檔案變了之後再等 30 秒：下單的付款期限 %s%n", deadline(keys));

            try (Load load = Load.start(keys, Kube.ENTRY, 5)) {
                load.until(5);
                long r0 = load.elapsedMs();
                Kube.kubectl("rollout", "restart", "deploy/order-service");
                waitRollout();
                long r1 = load.elapsedMs();
                load.until(r1 / 1000 + 5);
                load.close();
                out.printf("  ② kubectl rollout restart（每秒 5 張下單）：%.1f 秒滾完；這段時間的下單 %s；之後下單的付款期限 %s%n",
                        (r1 - r0) / 1000.0, Load.fmt(load.codes(r0, r1)), deadline(keys));
            }
        } finally {
            Kube.kubectl("patch", "deploy/order-service", "--type=json", "-p", """
                    [{"op":"remove","path":"/spec/template/spec/volumes"},
                     {"op":"remove","path":"/spec/template/spec/containers/0/volumeMounts"},
                     {"op":"remove","path":"/spec/template/spec/containers/0/env"}]""");
            waitRollout();
            Kube.kubectl("delete", "configmap", "order-tuning", "--ignore-not-found");
        }
    }

    static void waitRollout() throws Exception {
        Kube.kubectl("rollout", "status", "deploy/order-service", "--timeout=300s");
        Kube.waitFor(() -> Kube.pods("order-service").stream().noneMatch(Kube.Pod::terminating), 120);
    }

    /** 下一張單：paymentDeadline − createdAt */
    static String deadline(ConfigurableApplicationContext keys) throws Exception {
        Calls.Res r = Calls.place(Kube.ENTRY, TestTokens.bearer(keys, Load.BUYERS.incrementAndGet()), SplitLab.FIRST_PRODUCT + 7);
        if (r.status() != 201) return "（下單 " + r.status() + "）";
        Duration d = Duration.between(Instant.parse(r.json().get("createdAt").asText()), Instant.parse(r.json().get("paymentDeadline").asText()));
        return d.toMinutes() + " 分鐘";
    }
}
```

**`src/test/java/com/example/shop/dist08/K9TraceStorageTest.java`**（8.9.3）

```java
package com.example.shop.dist08;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist07.Calls;
import com.example.shop.dist07.Jaeger;
import com.example.shop.dist07.Keys;
import com.example.shop.dist07.Spans;
import com.example.shop.shared.web.Role;
import com.example.shop.support.TestTokens;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.util.List;

/**
 * 13 站 8.9.3：Jaeger 重開之後，trace 還在嗎。
 *   ① kind 裡的 Jaeger v2：Badger + PersistentVolume（k8s/observability/jaeger.yaml）
 *   ② 第 07 章 compose 的 Jaeger v1 all-in-one：記憶體
 * 各找一條有 span 的 trace，重開 Jaeger，再查一次。
 *
 *   mvn test -Pexperiments -Dtest=K9TraceStorageTest        （約 3 分鐘；②要 compose 的 --profile tracing）
 */
@Tag("experiment")
class K9TraceStorageTest {

    final PrintStream out = System.out;

    @Test
    void storage() throws Exception {
        try (ConfigurableApplicationContext keys = Keys.start()) {
            Kube.fresh(TestTokens.bearer(keys, 1, Role.ADMIN));
            out.println("═══ 8.9.3 Jaeger 重開之後，trace 還在嗎 ═══");
            // 入口抽 10%：下 50 張，等 span 送到（批次、Collector），找第一條有 span 的
            List<String> ids = new java.util.ArrayList<>();
            for (int i = 0; i < 50; i++) {
                Calls.Res r = Calls.place(Kube.ENTRY, TestTokens.bearer(keys, Load.BUYERS.incrementAndGet()), SplitLab.FIRST_PRODUCT + i);
                if (r.traceId() != null) ids.add(r.traceId());
            }
            Thread.sleep(10_000);
            String trace = null;
            for (String id : ids) if (trace == null && !Jaeger.trace(Traces.BASE, id).isEmpty()) trace = id;
            if (trace == null) { out.println("  ① 50 張都沒有被抽到"); return; }
            int before = Jaeger.trace(Traces.BASE, trace).size();
            long t0 = System.nanoTime();
            Kube.sh("kubectl", "--context", Kube.CTX, "-n", "observability", "rollout", "restart", "deploy/jaeger");
            Kube.sh("kubectl", "--context", Kube.CTX, "-n", "observability", "rollout", "status", "deploy/jaeger", "--timeout=180s");
            List<Spans.Rec> after = List.of();
            for (int i = 0; i < 60 && after.isEmpty(); i++) {
                try { after = Jaeger.trace(Traces.BASE, trace); } catch (Exception notYet) { }
                if (after.isEmpty()) Thread.sleep(1_000);
            }
            out.printf("  ① kind 的 Jaeger v2（Badger、PersistentVolume）：trace %s 有 %d 個 span → 重開（%.0f 秒）→ %d 個 span%n",
                    trace, before, (System.nanoTime() - t0) / 1e9, after.size());

            // ② compose 的 v1：用第 07 章的 Jaeger（localhost:4318 收、16686 查）。送一個 span 進去，重開，再查
            Jaeger.restart();
            String v1 = String.format("%032x", System.nanoTime());
            String body = """
                    {"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"k9-probe"}}]},
                      "scopeSpans":[{"spans":[{"traceId":"%s","spanId":"00f067aa0ba902b7","name":"probe","kind":1,
                        "startTimeUnixNano":"%d","endTimeUnixNano":"%d"}]}]}]}""".formatted(v1, System.currentTimeMillis() * 1_000_000L, System.currentTimeMillis() * 1_000_000L + 1_000_000);
            Jaeger.HTTP.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://localhost:4318/v1/traces"))
                    .header("Content-Type", "application/json").POST(java.net.http.HttpRequest.BodyPublishers.ofString(body)).build(),
                    java.net.http.HttpResponse.BodyHandlers.discarding());
            int v1Before = 0;
            for (int i = 0; i < 20 && v1Before == 0; i++) { Thread.sleep(500); v1Before = Jaeger.trace(v1).size(); }
            Jaeger.restart();
            out.printf("  ② compose 的 Jaeger v1 all-in-one（記憶體）：trace %s 有 %d 個 span → 重開 → %d 個 span%n", v1, v1Before, Jaeger.trace(v1).size());
        }
    }
}
```

**`src/test/java/com/example/shop/dist08/K10MeshTest.java`**（8.10）

```java
package com.example.shop.dist08;

import com.example.shop.dist03.Roles;
import com.example.shop.dist07.Calls;
import com.example.shop.dist07.Keys;
import com.example.shop.shared.web.Role;
import com.example.shop.support.TestTokens;
import com.fasterxml.jackson.databind.JsonNode;
import com.nimbusds.jose.jwk.source.ImmutableSecret;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jwt.JwsHeader;
import org.springframework.security.oauth2.jwt.JwtClaimsSet;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.security.oauth2.jwt.NimbusJwtEncoder;

import javax.crypto.spec.SecretKeySpec;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;

/**
 * 13 站 8.10：服務網格（Istio，sidecar 模式）。第 06 章 6.3.5 留下的一句：sidecar 預設就會重試 —— 量它。
 *
 * 同一組量法，先沒有 sidecar、再有 sidecar：
 *   a. 從訂單服務的 pod（app 容器）直接送 10 個「一定會 503」的預留到庫存服務：服務 token、Shop-Budget-Ms: 0
 *      （庫存服務借到連線之後發現預算用完，回 503，6.4.3）。庫存服務那一邊收到幾次（每一個 pod 的 http_server_requests，status=503）
 *   b. 經過入口、每秒 10 張下單 40 秒：p50、p99
 *   c. 每一個容器的記憶體（kubelet 的 /stats/summary）
 * 有 sidecar 的時候，另外印出訂單服務的 sidecar 給 inventory-service:8080 的路由上，實際的重試設定（istioctl proxy-config routes）。
 * 量完把 Istio 拿掉（這一章的部署沒有網格，8.10.3 的選擇）。
 *
 *   mvn test -Pexperiments -Dtest=K10MeshTest -Dd08.istioctl=…/istioctl        （約 10 分鐘）
 */
@Tag("experiment")
class K10MeshTest {

    static final String ISTIOCTL = System.getProperty("d08.istioctl", "istioctl");
    final PrintStream out = System.out;

    @Test
    void mesh() throws Exception {
        try (ConfigurableApplicationContext keys = Keys.start()) {
            Kube.fresh(TestTokens.bearer(keys, 1, Role.ADMIN));
            out.println("═══ 8.10 服務網格（Istio 1.31，sidecar）：預設的重試、延遲、記憶體 ═══");
            measure(keys, "① 沒有 sidecar");
            try {
                Kube.sh(ISTIOCTL, "--context", Kube.CTX, "install", "-y", "--set", "profile=minimal",
                        "--set", "components.pilot.k8s.resources.requests.cpu=100m", "--set", "components.pilot.k8s.resources.requests.memory=256Mi");
                Kube.kubectl("label", "namespace", Kube.NS, "istio-injection=enabled", "--overwrite");
                restart();
                String order = Kube.pods("order-service").get(0).name();
                JsonNode routes = Calls.JSON.readTree(Kube.sh(ISTIOCTL, "--context", Kube.CTX, "proxy-config", "routes", order + "." + Kube.NS, "--name", "8080", "-o", "json"));
                for (JsonNode rc : routes)
                    for (JsonNode vh : rc.path("virtualHosts"))
                        if (vh.path("name").asText().startsWith("inventory-service.shop.svc.cluster.local"))
                            out.printf("  訂單服務的 sidecar → %s 的重試：%s%n", vh.path("name").asText(), vh.path("routes").path(0).path("route").path("retryPolicy"));
                measure(keys, "② 有 sidecar（Istio 的預設）");
            } finally {
                Kube.kubectl("label", "namespace", Kube.NS, "istio-injection-");
                restart();
                Kube.sh(ISTIOCTL, "--context", Kube.CTX, "uninstall", "--purge", "-y");
                Kube.sh("kubectl", "--context", Kube.CTX, "delete", "namespace", "istio-system", "--ignore-not-found");
            }
        }
    }

    void restart() throws Exception {
        Kube.kubectl("rollout", "restart", "deploy/inventory-service", "deploy/order-service");
        for (String d : List.of("inventory-service", "order-service")) Kube.kubectl("rollout", "status", "deploy/" + d, "--timeout=300s");
        Kube.waitFor(() -> Kube.pods("inventory-service").stream().noneMatch(Kube.Pod::terminating) && Kube.pods("order-service").stream().noneMatch(Kube.Pod::terminating), 180);
        Thread.sleep(5_000);
    }

    void measure(ConfigurableApplicationContext keys, String title) throws Exception {
        out.println("  " + title);
        // a. 10 個一定會 503 的預留
        double before = inventory503();
        String order = Kube.pods("order-service").get(0).name();
        Map<String, Integer> codes = new TreeMap<>();
        for (int i = 0; i < 10; i++) {
            String code = Kube.kubectl("exec", order, "-c", "app", "--", "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-X", "PUT",
                    "-H", "Authorization: Bearer " + serviceToken(), "-H", "Content-Type: application/json", "-H", "Shop-Budget-Ms: 0",
                    "-d", "{\"lines\":[{\"productId\":9000001,\"quantity\":1}],\"hotLines\":[]}",
                    "http://inventory-service:8080/internal/inventory/v1/reservations/" + (88_000_000 + i)).trim();
            codes.merge(code, 1, Integer::sum);
        }
        Thread.sleep(2_000);
        out.printf("    a. 從訂單服務的 pod 送 10 個 Shop-Budget-Ms: 0 的預留：拿到 %s；庫存服務回了 503 %.0f 次%n", codes, inventory503() - before);
        // b. 延遲
        try (Load load = Load.start(keys, Kube.ENTRY, 10)) {
            load.until(10);
            long from = load.elapsedMs();
            load.until(50);
            load.close();
            long[] p = load.p50p99(from, load.elapsedMs());
            out.printf("    b. 經過入口每秒 10 張下單 40 秒：%s，p50 %d ms、p99 %d ms%n", Load.fmt(load.codes(from, Long.MAX_VALUE)), p[0], p[1]);
        }
        // c. 記憶體
        out.printf("    c. 記憶體（working set）：%s%n", memory());
    }

    /** 每一個庫存服務的 pod，PUT /reservations 回 503 的次數加總 */
    static double inventory503() throws Exception {
        double n = 0;
        for (Kube.Pod p : Kube.pods("inventory-service")) {
            double v = Kube.sum(Kube.metrics(p.name()), "http_server_requests_seconds_count",
                    "uri=\"/internal/inventory/v1/reservations/{orderId}\"", "method=\"PUT\"", "status=\"503\"");
            if (!Double.isNaN(v)) n += v;
        }
        return n;
    }

    /** 訂單服務發給庫存服務的服務 token（3.6；金鑰是 k8s/kind/secrets.env 的 SHOP_SERVICE_TOKEN_SECRET） */
    static String serviceToken() {
        var encoder = new NimbusJwtEncoder(new ImmutableSecret<>(new SecretKeySpec(Roles.SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256")));
        Instant now = Instant.now();
        JwtClaimsSet claims = JwtClaimsSet.builder().issuer("shop-services").subject("order-service").audience(List.of("inventory-service"))
                .issuedAt(now.minus(Duration.ofMinutes(1))).expiresAt(now.plus(Duration.ofMinutes(5))).id(UUID.randomUUID().toString()).build();
        return encoder.encode(JwtEncoderParameters.from(JwsHeader.with(MacAlgorithm.HS256).build(), claims)).getTokenValue();
    }

    /** shop 裡每一個容器的 working set（MiB），依 pod 名字的最後一段 */
    static Map<String, Long> memory() throws Exception {
        Map<String, Long> m = new TreeMap<>();
        JsonNode s = Calls.JSON.readTree(Kube.sh("kubectl", "--context", Kube.CTX, "get", "--raw", "/api/v1/nodes/d08-control-plane/proxy/stats/summary"));
        for (JsonNode p : s.path("pods"))
            if (p.path("podRef").path("namespace").asText().equals(Kube.NS) && !p.path("podRef").path("name").asText().startsWith("migrate"))
                for (JsonNode c : p.path("containers"))
                    m.put(p.path("podRef").path("name").asText().replaceAll("-[a-z0-9]+-[a-z0-9]+$", "") + "/" + K2ScaleUpTest.short_(p.path("podRef").path("name").asText())
                            + "/" + c.path("name").asText(), c.path("memory").path("workingSetBytes").asLong() / 1_048_576);
        return m;
    }
}
```

**`src/test/java/com/example/shop/dist08/K11TwoGatewaysTest.java`**（8.8.4）

```java
package com.example.shop.dist08;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist07.Calls;
import com.example.shop.dist07.Keys;
import com.example.shop.shared.web.Role;
import com.example.shop.support.TestTokens;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.util.Map;
import java.util.TreeMap;

/**
 * 13 站 8.8.4：兩層閘道，各自加了重試。庫存服務縮到 0 台，讓兩種請求都會 503：
 *   GET  /api/admin/orders/{orderNo}/saga（管理員看一張單的 Saga，要問庫存服務，4.x）
 *   POST /api/orders（下單）
 * 三種部署，每一種各送 10 個，數訂單服務那一邊收到幾次（http_server_requests）：
 *   ① 入口 → 訂單服務（入口沒有設重試：Envoy Gateway 的預設）
 *   ② 入口 → Spring Cloud Gateway（lab/scg：Retry=3）→ 訂單服務
 *   ③ 入口也加了重試（k8s/lab/gateway-retry.yaml：再送 2 次，含 503）→ Spring Cloud Gateway → 訂單服務
 *
 *   mvn test -Pexperiments -Dtest=K11TwoGatewaysTest        （約 5 分鐘；先 docker build -t scg-lab:d08 lab/scg）
 */
@Tag("experiment")
class K11TwoGatewaysTest {

    static final String SAGA = "uri=\"/api/admin/orders/{orderNo}/saga\"", ORDERS = "uri=\"/api/orders\"";
    final PrintStream out = System.out;

    @Test
    void twoGateways() throws Exception {
        try (ConfigurableApplicationContext keys = Keys.start()) {
            String admin = TestTokens.bearer(keys, 1, Role.ADMIN);
            Kube.fresh(admin);
            Kube.sh(Kube.KIND, "load", "docker-image", "scg-lab:d08", "--name", "d08");
            Kube.kubectl("apply", "-f", "k8s/lab/scg.yaml");
            Kube.kubectl("rollout", "status", "deploy/scg-lab", "--timeout=180s");
            Calls.Res placed = Calls.place(Kube.ENTRY, TestTokens.bearer(keys, Load.BUYERS.incrementAndGet()), SplitLab.FIRST_PRODUCT);
            String orderNo = placed.json().get("orderNo").asText();
            Kube.kubectl("scale", "deploy/inventory-service", "--replicas=0");
            Kube.waitFor(() -> Kube.pods("inventory-service").isEmpty(), 120);
            out.println("═══ 8.8.4 兩層閘道、各自的重試：庫存服務 0 台，GET（Saga）與 POST（下單）各送 10 個 ═══");
            try {
                measure(keys, admin, orderNo, "① 入口 → 訂單服務");
                Kube.kubectl("patch", "httproute", "shop-api", "--type=json", "-p",
                        "[{\"op\":\"replace\",\"path\":\"/spec/rules/0/backendRefs/0/name\",\"value\":\"scg-lab\"}]");
                Thread.sleep(5_000);
                measure(keys, admin, orderNo, "② 入口 → Spring Cloud Gateway（Retry=3）→ 訂單服務");
                Kube.kubectl("apply", "-f", "k8s/lab/gateway-retry.yaml");
                Thread.sleep(5_000);
                measure(keys, admin, orderNo, "③ 入口（再送 2 次）→ Spring Cloud Gateway（Retry=3）→ 訂單服務");
            } finally {
                Kube.kubectl("delete", "-f", "k8s/lab/gateway-retry.yaml", "--ignore-not-found");
                Kube.kubectl("apply", "-k", "k8s/gateway");
                Kube.kubectl("delete", "-f", "k8s/lab/scg.yaml", "--ignore-not-found");
                Kube.kubectl("scale", "deploy/inventory-service", "--replicas=2");
                Kube.kubectl("rollout", "status", "deploy/inventory-service", "--timeout=300s");
            }
        }
    }

    void measure(ConfigurableApplicationContext keys, String admin, String orderNo, String title) throws Exception {
        double saga0 = Kube.orderSum("http_server_requests_seconds_count", SAGA), orders0 = Kube.orderSum("http_server_requests_seconds_count", ORDERS, "method=\"POST\"");
        double noResponse0 = Kube.orderSum("shop_remote_no_response_total");
        Map<Integer, Integer> sagaCodes = new TreeMap<>(), orderCodes = new TreeMap<>();
        long sagaMax = 0, orderMax = 0, sagaSum = 0, orderSum = 0;
        long t0 = System.nanoTime();
        for (int i = 0; i < 10; i++) {
            Calls.Res g = Calls.send(Kube.ENTRY, "GET", "/api/admin/orders/" + orderNo + "/saga", admin, null, Map.of());
            sagaCodes.merge(g.status(), 1, Integer::sum);
            sagaMax = Math.max(sagaMax, g.millis());
            sagaSum += g.millis();
            Calls.Res o = Calls.place(Kube.ENTRY, TestTokens.bearer(keys, Load.BUYERS.incrementAndGet()), SplitLab.FIRST_PRODUCT + i);
            orderCodes.merge(o.status(), 1, Integer::sum);
            orderMax = Math.max(orderMax, o.millis());
            orderSum += o.millis();
        }
        double seconds = (System.nanoTime() - t0) / 1e9;
        Thread.sleep(2_000);
        out.printf("  %s（%.1f 秒）%n", title, seconds);
        out.printf("    GET  Saga：買家拿到 %s（平均 %.1f 秒、最長 %.1f 秒）；訂單服務收到 %.0f 次%n", sagaCodes, sagaSum / 10_000.0, sagaMax / 1000.0,
                Kube.orderSum("http_server_requests_seconds_count", SAGA) - saga0);
        out.printf("    POST 下單：買家拿到 %s（平均 %.1f 秒、最長 %.1f 秒）；訂單服務收到 %.0f 次%n", orderCodes, orderSum / 10_000.0, orderMax / 1000.0,
                Kube.orderSum("http_server_requests_seconds_count", ORDERS, "method=\"POST\"") - orders0);
        out.printf("    訂單服務呼叫庫存服務「沒有回應」%.0f 次%n", Kube.orderSum("shop_remote_no_response_total") - noResponse0);
    }
}
```

**`src/test/java/com/example/shop/inventory/internal/web/InternalRateLimitTest.java`**（8.6.3）

```java
package com.example.shop.inventory.internal.web;

import com.example.shop.support.TestInfra;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import java.util.TreeMap;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 13 站 8.6.3：庫存服務的「每個 IP 每秒 50 次」（第 12 站 6.7.2 的全域限流）也算到了訂單服務頭上。
 * 訂單服務的每一個呼叫都從同一個 IP 來（一個 pod 一個 IP）：它一秒呼叫超過 50 次，預留就被 429 —— RemoteInventoryApi 把 429
 * 當成「我們的錯」，買家拿到 500。K8s 上每秒 40 張下單量到的（第 03～07 章的實驗都用 shop.rate-limit.enabled=false 起服務，看不到）。
 * 這裡把上限調成每秒 5 次，同一秒裡送 20 次。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "shop.deployment.role=inventory-service", "shop.deployment.service-token.secret=" + InventoryServiceApiTest.SECRET,
        "shop.order.jobs-enabled=false", "shop.inventory.jobs-enabled=false", "shop.security.bootstrap-admin.enabled=false",
        "spring.jpa.hibernate.ddl-auto=none", "spring.flyway.locations=classpath:db/migration/inventory,classpath:db/migration/shared",
        "spring.data.redis.database=4", "shop.rate-limit.requests-per-ip-per-second=5"})
class InternalRateLimitTest {

    static final String DB = "shop_svc_inventory_ratelimit";

    static volatile String url;

    @DynamicPropertySource
    static void ownDatabase(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", () -> {
            if (url == null) {
                JdbcTemplate admin = TestInfra.adminJdbc();
                admin.execute("DROP DATABASE IF EXISTS " + DB);
                admin.execute("CREATE DATABASE " + DB);
                admin.execute("GRANT ALL PRIVILEGES ON `" + DB + "`.* TO 'shop_migrator'@'%' WITH GRANT OPTION");
                url = TestInfra.jdbcUrl(DB);
            }
            return url;
        });
    }

    @LocalServerPort int port;

    final HttpClient http = HttpClient.newHttpClient();

    /** 同一個固定窗（同一秒）裡送 n 次：先等到下一秒的開頭（第 12 站 perIpLimit 撞整分鐘的那個追記，同一個道理） */
    Map<Integer, Integer> burst(int n, String auth) throws Exception {
        while (System.currentTimeMillis() % 1000 > 50) Thread.sleep(1);
        Map<Integer, Integer> codes = new TreeMap<>();
        for (int i = 0; i < n; i++) {
            HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/internal/inventory/v1/stock?productIds=1"));
            if (auth != null) b.header("Authorization", auth);
            codes.merge(http.send(b.build(), HttpResponse.BodyHandlers.discarding()).statusCode(), 1, Integer::sum);
        }
        return codes;
    }

    @Test @DisplayName("8.6.3：訂單服務（帶著有效的服務 token）一秒 20 次，不被每個 IP 的上限擋")
    void ourOwnServiceIsNotLimitedPerIp() throws Exception {
        burst(1, null);                                                     // 暖機（第一個請求的 JIT），不算
        Thread.sleep(1_000);
        Map<Integer, Integer> codes = burst(20, InternalTraceparentTest.service("order-service", "inventory-service"));
        System.out.println("13 站 8.6.3：上限每秒 5 次；訂單服務的 token 一秒 20 次 → " + codes);
        assertThat(codes).containsOnlyKeys(200);
    }

    @Test @DisplayName("8.6.3：沒有服務 token 的，照樣每個 IP 每秒 5 次")
    void everyoneElseStillIs() throws Exception {
        Thread.sleep(1_000);
        Map<Integer, Integer> codes = burst(20, null);
        System.out.println("13 站 8.6.3：上限每秒 5 次；沒有 token 一秒 20 次 → " + codes);
        assertThat(codes).containsKey(429);
    }
}
```

**`src/test/java/com/example/shop/shared/web/EdgeTraceparentTest.java`**（8.8.2）

```java
package com.example.shop.shared.web;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.autoconfigure.actuate.observability.AutoConfigureObservability;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 13 站第 08 章：shop.deployment.edge.trust-traceparent=true（前面有一個會拿掉買家 trace header 的入口，而且只有它連得到這裡）——
 * /api/** 的 traceparent 是入口寫的，接上它；其他路徑照舊不收。關著的時候（預設），由驗收 Q7 ⑤ 守著第 12 站 9.8.4 的規則。
 * @AutoConfigureObservability：@SpringBootTest 預設把傳遞關掉（13 站 7.6.6）
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = "shop.deployment.edge.trust-traceparent=true")
@AutoConfigureObservability
class EdgeTraceparentTest {

    static final String TRACE = "0af7651916cd43dd8448eb211c80319c";

    @LocalServerPort int port;

    String traceOf(String path) throws Exception {
        return HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                        .header("traceparent", "00-" + TRACE + "-b7ad6b7169203331-01").build(), HttpResponse.BodyHandlers.discarding())
                .headers().firstValue("X-Trace-Id").orElse(null);
    }

    @Test @DisplayName("8.8.2：入口受信任時，/api/** 接上入口的 traceparent；/actuator/** 不接")
    void apiTakesTheEdgesTraceparent() throws Exception {
        String api = traceOf("/api/ping"), other = traceOf("/actuator/health");
        System.out.println("13 站 8.8.2：trust-traceparent=true → /api/ping 的 X-Trace-Id " + api + "；/actuator/health " + other);
        assertThat(api).isEqualTo(TRACE);
        assertThat(other).isNotEqualTo(TRACE);
    }
}
```

**`src/test/java/com/example/shop/notification/internal/NotificationClaimTest.java`**（第 12 站 7.7.2 的追記）

```java
package com.example.shop.notification.internal;

import com.example.shop.shared.events.Event;
import com.example.shop.shared.events.EventTypes;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;
import static org.awaitility.Awaitility.await;

/**
 * 7.7.2 的追記（13 站第 08 章）：② 的認領說「同一則訊息同時被兩條執行緒處理，只有一條會成功認領」。
 * 第一版的條件是「attempts 還是我讀到的那個 n」—— 擋得住兩條讀到同一個 n，擋不住這個順序：
 * A 認領（0 → 1）、正在寄；B 這時才讀，讀到 1，用「還是 1」認領（1 → 2），也寄。驗收 Q10 偶爾紅（notification_attempts = 2）就是它。
 * 這裡用一個停在寄信裡的 mailer，把 A 留在那個窗裡，再讓 B 進來。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = "shop.order.jobs-enabled=false")
class NotificationClaimTest {

    static final long BUYER = 990_077;

    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;

    /** 第一封停在寄信裡，直到 release；之後的照常寄 */
    static class GatedMailer extends SimulatedMailer {
        final CountDownLatch inside = new CountDownLatch(1), release = new CountDownLatch(1);
        final AtomicInteger calls = new AtomicInteger();

        @Override
        void send(long userId, String type, String dedupKey, String text) {
            if (calls.incrementAndGet() == 1) {
                inside.countDown();
                try {
                    release.await(10, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
            super.send(userId, type, dedupKey, text);
        }
    }

    @BeforeEach @AfterEach
    void cleanup() {
        jdbc.update("DELETE FROM notifications WHERE user_id = ?", BUYER);
    }

    Event placed() {
        var payload = json.createObjectNode().put("orderNo", "20000101-000077").put("buyerId", BUYER);
        return new Event(UUID.randomUUID().toString(), EventTypes.ORDER_PLACED, "ORDER", 99_077_000L, Instant.now(), payload, 1);
    }

    Map<String, Object> row(Event e) {
        return jdbc.queryForMap("SELECT status, attempts FROM notifications WHERE dedup_key = ?", e.eventId() + ":ORDER_PLACED");
    }

    @Test @DisplayName("7.7.2 ②：A 認領了、還在寄；B 這時才來 —— B 不寄，也不能把自己 ack 掉")
    void secondCopyWhileTheFirstIsSending() throws Exception {
        GatedMailer mailer = new GatedMailer();
        NotificationHandler handler = new NotificationHandler(jdbc, mailer, json);
        Event e = placed();

        CompletableFuture<Void> a = CompletableFuture.runAsync(() -> handler.handle(e));
        assertThat(mailer.inside.await(10, TimeUnit.SECONDS)).isTrue();         // A：認領了，停在寄信裡
        Throwable b = catchThrowable(() -> handler.handle(e));                    // B：同一則事件的另一份投遞
        Map<String, Object> during = row(e);
        mailer.release.countDown();
        a.get(10, TimeUnit.SECONDS);
        Throwable retry = catchThrowable(() -> handler.handle(e));                // B 的重試（重試階梯的下一級）

        System.out.printf("7.7.2 ②：A 停在寄信裡時 B 來了 → B %s，那時 %s；A 寄完、B 重試 → %s；寄了 %d 封，%s%n",
                b == null ? "沒有例外" : b, during, retry == null ? "沒有例外" : retry, mailer.sent().size(), row(e));
        assertThat(mailer.sent()).hasSize(1);
        assertThat(row(e)).containsEntry("status", "SENT").containsEntry("attempts", 1);
        assertThat(b).as("B 不能 ack 掉：A 如果死在寄信裡，B 是還會再來的那一份").isNotNull();
        assertThat(retry).isNull();
    }

    @Test @DisplayName("7.7.2：認領之後行程死掉 —— 租約過期之前，別的投遞不寄；過期之後再認領、再寄")
    void claimLeftByADeadSenderExpires() {
        SimulatedMailer mailer = new SimulatedMailer();
        NotificationHandler handler = new NotificationHandler(jdbc, mailer, json);
        Event e = placed();
        // 一個死在寄信裡的行程留下來的：認領了（attempts = 1），租約還剩 800 ms。它死的時候，那封信可能已經寄出去了
        jdbc.update("""
                INSERT INTO notifications (user_id, type, dedup_key, payload, attempts, claimed_until)
                VALUES (?, 'ORDER_PLACED', ?, '{}', 1, CURRENT_TIMESTAMP(3) + INTERVAL 800000 MICROSECOND)""",
                BUYER, e.eventId() + ":ORDER_PLACED");

        Throwable early = catchThrowable(() -> handler.handle(e));                // 重送的那一份，租約還沒過期
        int sentEarly = mailer.sent().size();
        await().atMost(Duration.ofSeconds(5)).until(() -> jdbc.queryForObject(
                "SELECT claimed_until < CURRENT_TIMESTAMP(3) FROM notifications WHERE dedup_key = ?", Boolean.class, e.eventId() + ":ORDER_PLACED"));
        Throwable late = catchThrowable(() -> handler.handle(e));                 // 重試階梯的下一級，租約過期了

        System.out.printf("7.7.2：死掉的行程留下租約 → 租約內重送 %s、寄了 %d 封；過期之後重試 → %s、寄了 %d 封，%s%n",
                early == null ? "沒有例外" : early, sentEarly, late == null ? "沒有例外" : late, mailer.sent().size(), row(e));
        assertThat(early).isInstanceOf(NotificationHandler.InFlight.class);
        assertThat(sentEarly).isZero();
        assertThat(late).isNull();
        assertThat(mailer.sent()).hasSize(1);
        assertThat(row(e)).containsEntry("status", "SENT").containsEntry("attempts", 2);
    }

    @Test @DisplayName("7.7.2：寄失敗 → 放掉租約，下一級重試馬上認領得到（AC-4 的 6 次不被租約擋住）")
    void failedSendReleasesTheClaim() {
        SimulatedMailer mailer = new SimulatedMailer();
        mailer.failNext(1);
        NotificationHandler handler = new NotificationHandler(jdbc, mailer, json);
        Event e = placed();

        Throwable first = catchThrowable(() -> handler.handle(e));
        Map<String, Object> afterFailure = jdbc.queryForMap("SELECT status, attempts, claimed_until FROM notifications WHERE dedup_key = ?",
                e.eventId() + ":ORDER_PLACED");
        Throwable second = catchThrowable(() -> handler.handle(e));

        System.out.printf("7.7.2：第一次寄失敗 → %s，%s；馬上重試 → %s，寄了 %d 封，%s%n",
                first, afterFailure, second == null ? "沒有例外" : second, mailer.sent().size(), row(e));
        assertThat(first).isInstanceOf(SimulatedMailer.MailException.class);
        assertThat(afterFailure).containsEntry("status", "PENDING").containsEntry("attempts", 1).containsEntry("claimed_until", null);
        assertThat(second).isNull();
        assertThat(mailer.sent()).hasSize(1);
        assertThat(row(e)).containsEntry("status", "SENT").containsEntry("attempts", 2);
    }
}
```

**`src/test/java/com/example/shop/dist07/Jaeger.java`**（8.8.2：trace(base, id)）

```diff
  *   trace(traceId)：查詢 API（16686 的 /api/traces/{id}）—— 跟網頁上看到的是同一份資料，換成 Spans.Rec 印成樹
  *   received()    ：它自己的指標（14269 的 /metrics）裡，收到的 span 數
  */
-final class Jaeger {
+public final class Jaeger {
 
-    static final HttpClient HTTP = HttpClient.newHttpClient();
+    public static final HttpClient HTTP = HttpClient.newHttpClient();
 
     private Jaeger() {}
 
-    static void restart() throws Exception {
+    public static void restart() throws Exception {
         sh("docker", "compose", "--profile", "tracing", "rm", "-sf", "jaeger");
         sh("docker", "compose", "--profile", "tracing", "up", "-d", "jaeger");
         for (int i = 0; i < 120; i++) {
…
         throw new IllegalStateException("Jaeger 60 秒內沒有起來");
     }
 
-    static void sh(String... cmd) throws Exception {
+    public static void sh(String... cmd) throws Exception {
         Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
         String out = new String(p.getInputStream().readAllBytes());
         if (p.waitFor() != 0) throw new IllegalStateException(String.join(" ", cmd) + "：" + out);
     }
 
-    static HttpResponse<String> get(String url) throws Exception {
+    public static HttpResponse<String> get(String url) throws Exception {
         return HTTP.send(HttpRequest.newBuilder(URI.create(url)).build(), HttpResponse.BodyHandlers.ofString());
     }
 
     /** 一條 trace 的每一個 span（找不到 → 空的） */
-    static List<Spans.Rec> trace(String traceId) throws Exception {
-        HttpResponse<String> r = get("http://localhost:16686/api/traces/" + traceId);
+    public static List<Spans.Rec> trace(String traceId) throws Exception {
+        return trace("http://localhost:16686", traceId);
+    }
+
+    /** 13 站第 08 章：同一個查詢，問另一個 Jaeger（kind 裡的 v2，經過 NodePort） */
+    public static List<Spans.Rec> trace(String base, String traceId) throws Exception {
+        HttpResponse<String> r = get(base + "/api/traces/" + traceId);
         List<Spans.Rec> out = new ArrayList<>();
         if (r.statusCode() != 200) return out;
         JsonNode t = Calls.JSON.readTree(r.body()).path("data").path(0);
…
     }
 
     /** 兩個服務送來的 span 數（jaeger_collector_spans_received_total 依 svc 分；Jaeger 自己也送一個，不算） */
-    static long received() throws Exception {
+    public static long received() throws Exception {
         long n = 0;
         for (String l : get("http://localhost:14269/metrics").body().split("\n"))
             if (l.startsWith("jaeger_collector_spans_received_total") && (l.contains("svc=\"order-service\"") || l.contains("svc=\"inventory-service\"")))
```

**`src/test/java/com/example/shop/dist07/Node.java`**（8.2.0：改成 public）

```diff
  *   正式環境的日誌格式（logback-json.xml）與 OTLP：span 送到 Jaeger（compose --profile tracing）
  * 日誌寫到 target/d07-<name>.log。
  */
-final class Node implements AutoCloseable {
+public final class Node implements AutoCloseable {
 
-    static final String OTLP = "http://localhost:4318/v1/traces";
+    public static final String OTLP = "http://localhost:4318/v1/traces";
 
-    final String name;
-    final int port, mgmt;
-    final Path log;
+    public final String name;
+    public final int port, mgmt;
+    public final Path log;
     private Process process;
 
     private Node(String name, int port, int mgmt) {
…
     }
 
     /** 庫存服務：庫存庫加上 SlowSql（開關是 target/d07-slow-ms） */
-    static Node inventory(String name, int port, int mgmt, List<String> extra) throws Exception {
+    public static Node inventory(String name, int port, int mgmt, List<String> extra) throws Exception {
         List<String> a = Split.override(Roles.inventoryArgs(), List.of(
                 "--spring.datasource.url=" + SplitLab.url(Split.INV_DB) + "&queryInterceptors=" + DbTap.class.getName() + "," + SlowSql.class.getName()));
         return new Node(name, port, mgmt).boot(Split.override(a, extra));
     }
 
-    static Node order(String name, int port, int mgmt, int inventoryPort, List<String> extra) throws Exception {
+    public static Node order(String name, int port, int mgmt, int inventoryPort, List<String> extra) throws Exception {
         return new Node(name, port, mgmt).boot(Split.override(Roles.orderArgs(inventoryPort), extra));
     }
 
     /** 兩個服務都要的：broker、JSON 日誌、OTLP、抽樣率 */
-    static List<String> common(String probability) {
+    public static List<String> common(String probability) {
         List<String> a = new ArrayList<>(Broker.args());
         a.addAll(List.of("--logging.config=classpath:logback-json.xml", "--logging.level.com.example.shop=INFO",
                 "--management.otlp.tracing.endpoint=" + OTLP, "--management.tracing.sampling.probability=" + probability));
```

**`src/test/java/com/example/shop/dist07/Calls.java`**（8.2.0：改成 public）

```diff
  * 13 站第 07 章的實驗：買家、金流的動作，全部走 HTTP、打訂單服務。跟第 03 章的 Shop 一樣，只多回傳一樣東西：
  * 回應的 X-Trace-Id（第 12 站 9.8.3）—— 這一章要拿它去找 span 與日誌，就像客服拿著買家畫面上的那一串字。
  */
-final class Calls {
+public final class Calls {
 
-    static final ObjectMapper JSON = new ObjectMapper();
+    public static final ObjectMapper JSON = new ObjectMapper();
 
-    record Res(int status, String body, long millis, String traceId) {
-        JsonNode json() {
+    public record Res(int status, String body, long millis, String traceId) {
+        public JsonNode json() {
             try { return JSON.readTree(body); } catch (Exception e) { throw new IllegalStateException(body, e); }
         }
     }
 
     private Calls() {}
 
-    static Res send(int port, String method, String path, String token, Object body, Map<String, String> headers) throws Exception {
+    public static Res send(int port, String method, String path, String token, Object body, Map<String, String> headers) throws Exception {
         HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                 .timeout(Duration.ofSeconds(60)).header("Content-Type", "application/json")
                 .method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body)));
…
     }
 
     /** 下單：每個商品 1 件、單價 100 */
-    static Res place(int port, String buyerToken, long... products) throws Exception {
+    public static Res place(int port, String buyerToken, long... products) throws Exception {
         List<Map<String, Object>> items = new ArrayList<>();
         for (long p : products) items.add(Map.of("productId", p, "quantity", 1, "unitPrice", new BigDecimal("100.00")));
         return send(port, "POST", "/api/orders", buyerToken, Map.of("items", items), Map.of("Idempotency-Key", UUID.randomUUID().toString()));
     }
 
     /** 建立付款、送出簽好章的金流回呼（成功）。回傳回呼的回應 —— 它的 X-Trace-Id 就是 order.paid 那一串事件的 traceId */
-    static Res pay(int port, String buyerToken, String orderNo, String callbackSecret) throws Exception {
+    public static Res pay(int port, String buyerToken, String orderNo, String callbackSecret) throws Exception {
         Res p = send(port, "POST", "/api/orders/" + orderNo + "/payments", buyerToken, null, Map.of());
         if (p.status() != 201) throw new IllegalStateException("建立付款 " + p.status() + " " + p.body());
         long paymentId = p.json().get("paymentId").asLong();
```

**`src/test/java/com/example/shop/dist07/Keys.java`**（8.2.0：改成 public）

```diff
  */
 @EnableConfigurationProperties(ShopProperties.class)
 @Import(AccessTokens.class)
-class Keys {
+public class Keys {
 
     @Bean
     Clock clock() { return Clock.systemUTC(); }
 
-    static ConfigurableApplicationContext start() {
+    public static ConfigurableApplicationContext start() {
         return new SpringApplicationBuilder(Keys.class).web(WebApplicationType.NONE).bannerMode(Banner.Mode.OFF).logStartupInfo(false)
                 .run("--spring.profiles.active=local", "--logging.level.root=WARN");
     }
```

**`src/test/java/com/example/shop/dist07/Prom.java`**（8.2.0：改成 public）

```diff
  * 13 站 7.11：演練用的 Prometheus —— 跟 compose 的同一個映像檔、同一份 alerts.yml，打開 exemplar 的儲存；
  * 抓的是這台機器上的兩個子 JVM（host.docker.internal 的管理埠），兩個 job、同一個 system=shop（prometheus.yml 的寫法）。
  */
-final class Prom implements AutoCloseable {
+public final class Prom implements AutoCloseable {
 
-    static final String NAME = "d07-prometheus";
-    static final int PORT = 19090;
+    public static final String NAME = "d07-prometheus";
+    public static final int PORT = 19090;
 
-    record Alert(String name, String state, String activeAt, Map<String, String> labels) {}
+    public record Alert(String name, String state, String activeAt, Map<String, String> labels) {}
 
-    record Exemplar(String traceId, double seconds, double at) {}
+    public record Exemplar(String traceId, double seconds, double at) {}
 
-    static Prom start(Map<String, Integer> jobs) throws Exception {
+    public static Prom start(Map<String, Integer> jobs) throws Exception {
         Path dir = Path.of("target", "d07-drill").toAbsolutePath();
         Files.createDirectories(dir);
         Files.copy(Path.of("docker/prometheus/alerts.yml"), dir.resolve("alerts.yml"), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
…
         throw new IllegalStateException("Prometheus 60 秒內沒有起來");
     }
 
-    JsonNode api(String path) throws Exception {
+    public JsonNode api(String path) throws Exception {
         return Calls.JSON.readTree(Jaeger.get("http://localhost:" + PORT + path).body());
     }
 
-    static String q(String s) { return URLEncoder.encode(s, StandardCharsets.UTF_8); }
+    public static String q(String s) { return URLEncoder.encode(s, StandardCharsets.UTF_8); }
 
     /** 每一個 target 現在 up 嗎 */
-    List<String> targets() throws Exception {
+    public List<String> targets() throws Exception {
         List<String> out = new ArrayList<>();
         for (JsonNode t : api("/api/v1/targets").path("data").path("activeTargets"))
             out.add(t.path("labels").path("job").asText() + " " + t.path("health").asText() + (t.path("lastError").asText().isEmpty() ? "" : "（" + t.path("lastError").asText() + "）"));
         return out;
     }
 
-    List<Alert> alerts() throws Exception {
+    public List<Alert> alerts() throws Exception {
         List<Alert> out = new ArrayList<>();
         for (JsonNode a : api("/api/v1/alerts").path("data").path("alerts")) {
             Map<String, String> labels = new java.util.TreeMap<>();
…
     }
 
     /** 一個即時查詢的第一個值（沒有 → NaN） */
-    double value(String promql) throws Exception {
+    public double value(String promql) throws Exception {
         JsonNode r = api("/api/v1/query?query=" + q(promql)).path("data").path("result");
         return r.isEmpty() ? Double.NaN : r.path(0).path("value").path(1).asDouble();
     }
 
     /** 這段時間（epoch 秒）裡，這個查詢的 exemplar：traceId、那一個請求的秒數 */
-    List<Exemplar> exemplars(String promql, double from, double to) throws Exception {
+    public List<Exemplar> exemplars(String promql, double from, double to) throws Exception {
         List<Exemplar> out = new ArrayList<>();
         for (JsonNode series : api("/api/v1/query_exemplars?query=" + q(promql) + "&start=" + from + "&end=" + to).path("data"))
             for (JsonNode e : series.path("exemplars"))
```


---

## 8.14 常見誤區

| 誤區 | 實際上 |
|---|---|
| 上了 K8s，負載平衡就有了 | kube-proxy 平衡的是**連線**。擴容之後，新的 pod 要等舊的連線換手才分得到（8.6.1）；長命的連線（gRPC）可能永遠分不到（8.6.5） |
| 用了 Spring Cloud Gateway 又用 K8s 的入口，兩層各自加重試比較保險 | 10 個會 503 的 GET，在後面變成 80 次（一個 8 次）；外層的逾時先到，買家拿到 504，裡面還在重試（8.8.4）。有邏輯的閘道只能有一層 |
| 前面有了 gateway，`/api/**` 的 `traceparent` 照收就好 | 入口預設會接著買家給的 traceId；照收的話，100 個 `X-Trace-Id` 全是買家給的。要三樣一起：入口拿掉、服務信任、只有入口連得到（8.8.2） |
| 入口後面，「每個 IP」照舊用 `getRemoteAddr()` | 每一個買家都是入口的 IP，全站共用一個額度（8.8.3）。打開 forward headers，而且只信任內部的代理 |
| `up == 0` 的告警會告訴你服務不見了 | 在 `kubernetes_sd` 上，被刪掉的 pod 是從 target 裡**消失**，不是 down。整個服務縮到 0，它 pending 一下就解除了（8.9.1） |
| 改了 ConfigMap 就生效 | 環境變數不會變；掛成檔案的，53 秒後檔案變了，Spring Boot 不重讀（8.7.1） |
| 服務網格的 sidecar 預設會重試，所以 503 會被放大 | Istio 1.31 預設只重試連不上、refused-stream 與幾個 gRPC 的狀態，503 不重試（8.10.1）。但入口的重試政策一設下去，沒寫條件就含 503、而且不分方法（8.10.2）—— 每一層都要去看它實際的設定 |
| Spring Cloud 2023.0 支援 Boot 3.2，所以哪一個 2023.0.x 都可以 | 2023.0.6 在 Boot 3.2.5 上起得來，第一個請求就 `NoSuchMethodError`（8.8.4） |
| 沒有 `preStop`，滾動更新一定會掉請求 | 在這個組合（一個 node、JDK HttpClient、Tomcat 的優雅關機）上，有沒有都是 0 個錯誤（8.6.4）。這不代表可以拿掉它：入口那一段、多 node 的時候，這裡都沒有量 |

---

## 8.15 本章小結

- **四件事、兩套答案**：Spring Cloud 是函式庫（每一個服務帶著），K8s 是平台（叢集做）。Netflix 那一套只剩 Eureka；其他的接班人是 Spring Cloud LoadBalancer、Spring Cloud Gateway、Resilience4j。
- **I1**：一個寫死的位址，讓第二台庫存服務一個請求都收不到，讓一台停掉變成一次事故，讓換位址變成重啟。
- **服務發現**：K8s 用探針判斷誰算數，卡住的那一台 11 秒後不在 endpoints 裡。
- **負載平衡**：每一條連線挑一次。這個專案可以接受，因為 HTTP/1.1 的連線一直在換手；換成長命的連線就不行。
- **設定**：環境變數 + rollout；不重開就生效有它的代價，這個專案不需要。
- **閘道**：Gateway API。入口進來之後，trace 的起點、traceId 由誰決定、「每個 IP」數的是誰，都要重想；有邏輯的閘道只能有一層。
- **觀測**：Prometheus 自己找 target，告警要能說出「一台都沒有了」；span 送到一個 Collector；Jaeger 的資料要放在會留下來的地方。
- **服務網格**：這個專案現在不用；它的重試不是你以為的那樣。
- **途中抓到的**：庫存服務對訂單服務限流 —— 換了部署的形狀，第 03 章的 bug 才看得到。

### 8.15.1 驗收清單

- [ ] 說出四件事各要回答的問題，以及 Spring Cloud 與 K8s 原生各用什麼回答。
- [ ] 說出 Hystrix、Ribbon、Zuul 1 什麼時候進入維護、什麼時候被拿掉，接班人是誰；Eureka 為什麼還在。
- [ ] 把兩個服務部署到 kind：設定 → migration（Job）→ 應用程式，並說出為什麼是這個順序。
- [ ] 讓一台庫存服務卡住，說出它多久不在 endpoints 裡、多久被重啟，各由哪一個設定決定。
- [ ] 擴容之後，說出新的 pod 為什麼不會馬上分到請求，以及在什麼情況下這會變成問題。
- [ ] 說出改一個 ConfigMap 之後，環境變數與掛成檔案各會怎樣。
- [ ] 說出入口進來之後，`traceparent` 要成立哪三個條件才能接；`X-Forwarded-For` 要信任誰。
- [ ] 算出兩層閘道各自重試時，一個請求在後面變成幾次，以及買家為什麼拿到的是 504。
- [ ] 寫一條在 `kubernetes_sd` 上能說出「整個服務不見了」的告警規則，並用 promtool 測它。
- [ ] 說出 Istio 預設會重送哪幾種失敗，以及這個專案現在為什麼不用網格。
- [ ] 為你自己的系統寫一份選型文件：選哪個、換過去要付出什麼、什麼時候混用。

---

## 8.16 下一章預告

這一章把兩個服務放進 K8s，前面加了一個入口。入口除了「轉給誰」，還能做一件這一章沒有用到的事：**照比例分流** —— `HTTPRoute` 的一條規則可以有好幾個 backend，各帶一個權重。

第 09 章是這一站的最後一章：**遷移與回頭路**。Strangler Fig 的完整流程（新舊兩條路並存、一點一點把流量切過去）、灰度、雙寫驗證、回滾，以及這一站開頭（第 00 章）就埋下的那個問題 —— **什麼時候該把服務合併回單體，怎麼做**。這個專案的 jar 本來就能用三種角色起（第 03 章 3.7）：合併回去，在部署上是一個設定；在資料上，是把兩個庫變回一個。
