# Java 後端工程師完整學習路線

> 這不是一門「Java 語法課」，而是一條**從語言基礎到可上線後端服務**的完整路線。
> 依照 `Java → Spring Boot → REST API → Controller → Service → Repository → MySQL → JPA / MyBatis → Spring Security → Redis → 訊息佇列` 的技能鏈設計，
> 每一站都是獨立子課程，可以單獨讀，也可以照順序一路走到期末專題，
> 做完專題還想再往前一步的人，最後有一站**選修**的服務拆分與分散式一致性。

---

## 課程目標

完成整條路線後，你應該可以：

- 用現代 Java（17 / 21 LTS）寫出結構清楚、有測試的程式。
- 用現代 Java 的反射、註解與動態代理**讀懂框架**，而不是把它當黑箱。
- 說明 Spring Boot 的 IoC、DI、自動組態到底做了什麼，而不是只會貼註解。
- 設計一組別人看得懂、改得動、不會一改就破壞相容的 REST API。
- 正確切分 Controller / Service / Repository 三層職責，知道每種邏輯該放哪一層。
- 設計 MySQL schema、看懂 `EXPLAIN`、處理交易與鎖。
- 在 JPA 與 MyBatis 之間做出有理由的選擇，並解決 N+1、延遲載入等經典問題。
- 用 Spring Security 實作登入、權限控管與 JWT，並知道常見漏洞怎麼防。
- 弄懂 Redis 本體（資料結構、單執行緒、淘汰、持久化、原子性），再把它正確接進 Spring 專案：
  快取、分散式鎖、限流與冪等、預扣庫存，以及 Redis 掛掉時的降級。
- 用 RabbitMQ 與 Kafka 做非同步與事件驅動，並說清楚訊息為什麼會漏、為什麼會重、怎麼處理。
- 獨立完成一個可部署、有測試、有監控的後端服務。
- （選修）判斷一個系統該不該拆成多個服務，並在決定要拆時處理資料庫拆分與跨服務一致性。

## 適合對象

- 會其他語言（JS / Python / PHP），要轉 Java 後端的工程師。
- 學過 Java 語法，但一碰 Spring Boot 就只會複製貼上的人。
- 前端 / 全端工程師想補齊後端與資料庫這一段。
- 準備面試，需要能講清楚分層架構、交易、ORM、權限設計、快取一致性與訊息可靠性的人。

## 前置知識

- 會用基本命令列與 Git。
- 知道 HTTP 請求 / 回應大致長什麼樣。
- 有任一程式語言基礎即可，不需要先會 Java。

---

## 技能鏈與課程地圖

```
Java                 語言與 JVM 基礎（01-java-core）
  ↓
Spring Boot          IoC / DI / 自動組態（02-spring-boot）
  ↓
REST API             介面設計原則，與框架無關（03-rest-api）
  ↓
Controller           Web 層：接請求、驗參數、回錯誤（04-controller）
  ↓
Service              商業邏輯層：交易、快取、外部呼叫（05-service）
  ↓
Repository           資料存取層：連線池、查詢抽象（06-repository）
  ↓
MySQL                資料庫本體：建模、索引、交易、鎖（07-mysql）
  ↓
JPA / MyBatis        兩種存取實作：ORM vs SQL Mapper（08-jpa-mybatis）
  ↓
Spring Security      認證與授權：登入、權限、JWT（09-spring-security）
  ↓
Redis                本體 → 快取、分散式鎖、限流、預扣庫存、降級、高可用（10-redis）
  ↓
訊息佇列              RabbitMQ 與 Kafka：非同步與事件驅動（11-messaging）
  ↓
Capstone             整合成一個可上線的服務（12-capstone）
  ⋮（選修）
分散式               服務拆分、Saga、跨服務查詢與追蹤（13-distributed-systems）
```

> **04 → 05 → 06 是同一件事的三個切面**：一個請求進來，會依序穿過 Controller、Service、Repository。
> 拆成三個子課程是為了把「哪些程式碼該放哪一層」講透，實務上它們一起出現在同一個專案裡。

---

## 子課程目錄

| # | 資料夾 | 主題 | 章節數 | 你會得到什麼 |
|---|--------|------|--------|--------------|
| 01 | [01-java-core/](./01-java-core/) ✅ | Java 語言核心與 JVM | 14 | 語法、OOP、集合、Stream、併發、JVM 記憶體、Maven / Gradle、JUnit、**反射與動態代理** |
| 02 | [02-spring-boot/](./02-spring-boot/) ✅ | Spring Boot 框架原理 | 10 | IoC 容器、DI、自動組態、設定檔與 Profile、AOP、Actuator、打包部署 |
| 03 | [03-rest-api/](./03-rest-api/) ✅ | REST API 設計 | 10 | URL 與資源設計、狀態碼、DTO、錯誤格式、分頁、版本控管、OpenAPI |
| 04 | [04-controller/](./04-controller/) ✅ | Web 層實作 | 9 | 參數綁定、Bean Validation、全域例外處理、Filter / Interceptor、檔案與串流、SSE、**WebSocket 與 STOMP**、CORS 與序列化、MockMvc 與授權矩陣測試 |
| 05 | [05-service/](./05-service/) ✅ | 商業邏輯層 | 8 | 商業邏輯層定位與**不變量**、貧血 vs 充血、Service 設計與**循環依賴**、交易傳播、DTO 轉換、例外分層、快取、非同步、外部 API、Mockito 測試 |
| 06 | [06-repository/](./06-repository/) ✅ | 資料存取層 | 7 | 資料層定位與**介面設計的七個判準**、**不變量的第四個位置**、DataSource 與連線池、JdbcTemplate、Spring Data 抽象、**分頁與動態查詢**、**交易邊界與批次**、**資料層測試（H2 vs 真 MySQL 的 21 根探針）** |
| 07 | [07-mysql/](./07-mysql/) ✅ | MySQL 實戰 | 8 | Schema 設計、JOIN、索引與 EXPLAIN、InnoDB 交易與鎖、慢查詢調校、Flyway 與線上大表變更、備份／複製／讀寫分離 |
| 08 | [08-jpa-mybatis/](./08-jpa-mybatis/) ✅ | JPA / Hibernate 與 MyBatis | 10 | **ORM vs SQL Mapper 的六條分歧軸**、Entity 映射、關聯、持久化情境、N+1、JPQL / QueryDSL、MyBatis 動態 SQL、**選型與混用** |
| 09 | [09-spring-security/](./09-spring-security/) ✅ | 認證與授權 | 9 | **認證 vs 授權的三層**、Filter Chain、UserDetails 與密碼雜湊、方法層權限、Session vs Token、JWT、OAuth2 |
| 10 | [10-redis/](./10-redis/) ✅ | Redis：本體與 Spring 應用 | 15 | **前半在 `redis-cli` 裡**：資料結構與編碼、TTL 與過期機制、單執行緒與慢命令、記憶體淘汰與持久化、原子性（Lua）；**後半接進 Spring**：序列化與 Lettuce 三層逾時、快取抽象、**故障降級**、分散式鎖、限流與冪等、Session 與 Token 撤銷、預扣庫存、Sentinel / Cluster、Testcontainers 與上線檢查清單 |
| 11 | [11-messaging/](./11-messaging/) ✅ | 訊息佇列：RabbitMQ 與 Kafka | 12 | 可靠投遞三段、**Outbox**、冪等消費、RabbitMQ 拓撲與 DLX、Kafka 分區與 offset、精確一次、死信與 lag 監控、**選型與「什麼時候不該用 MQ」** |
| 12 | [12-capstone/](./12-capstone/) ✅ | 期末專題：訂單系統 | 10 | 把上面全部串成一個可部署、有測試、有監控的服務 |
| 13 | [13-distributed-systems/](./13-distributed-systems/) ✅ 🔸 | 服務拆分與分散式一致性 | 10 | **該不該拆**、邊界切法、資料庫拆分、Saga 與補償、跨服務查詢、服務網韌性、分散式追蹤、Spring Cloud vs K8s 選型、遷移與回頭路 |

合計 **132 個章節**。✅ 表示該子課程已完成，🚧 表示進行中，🔸 表示進階選修。

> **10 與 11 的定位**：重點是「這東西進到 Spring 專案裡會怎麼壞」。
> ⚠️ **但 10 站的前六章（00～05）刻意留在 `redis-cli` 裡教 Redis 本體**——
> 因為後半段每一個事故（序列化爆炸、鎖失效、超賣）的根因都在那六章裡，跳過的話後半段會變成抄設定。
> 11 站則維持「不教 broker 內部原理」。

> **13 為什麼在 capstone 之後、而且不叫「Spring Cloud」**：
> Spring Cloud 的主要內容在這門課裡已經拆散教完了 —— 熔斷與重試在 [05-service/06](./05-service/06-async-and-external-api-calls.md)、限流在 [03-rest-api/08](./03-rest-api/08-idempotency-caching-and-rate-limit.md) 與 [10-redis/](./10-redis/)、
> 設定中心在 [02-spring-boot/03](./02-spring-boot/03-configuration-properties-and-profiles.md)、追蹤在 [02-spring-boot/05](./02-spring-boot/05-logging-and-actuator.md)、
> **閘道與服務發現在 [13-distributed-systems/](./13-distributed-systems/) 的 08 章**（那一章把服務發現、設定管理、閘道、負載平衡四件事攤成決策表）。
> 真正還沒教的不是「Spring Cloud 的功能」，而是**架構問題**：該不該拆、資料庫怎麼拆、跨服務的交易怎麼收尾。
> 這些問題只有在你手上已經有一個會痛的單體時才問得出來 —— 所以它排在 capstone 之後，
> 工具選型（Spring Cloud vs K8s 原生）放在第 08 章當決策表，而不是當前提。

### 目前進度

| 子課程 | 狀態 |
|--------|------|
| 01-java-core | ✅ 已結業（14 章，約 54,400 行） |
| 02-spring-boot | ✅ 已結業（10 章，約 29,100 行） |
| 03-rest-api | ✅ 已結業（10 章，約 33,700 行） |
| 04-controller | ✅ 完成（00～08 章，約 64,900 行） |
| 05-service | ✅ 完成（00～07 章，約 42,400 行） |
| 06-repository | ✅ 完成（00～06 章，約 20,150 行） |
| 07-mysql | ✅ 完成（00～07 章，8 章） |
| 08-jpa-mybatis | ✅ 完成（00～09 章，10 章） |
| 09-spring-security | ✅ 完成（00～08 章，9 章，約 32,900 行） |
| 10-redis | ✅ 完成（00～14 章，15 章，約 22,700 行） |
| 11-messaging | ✅ 完成（00～11 章，12 章，約 23,250 行） |
| 12-capstone | ✅ 完成（00～09 章，約 50,000 行，含每章「其餘檔案的完整內容」；01～07 章補上專題寫完之後實跑的 `mvn clean verify`，以及已知問題修正、US-RPT-2 AC-1／US-RPT-3 的追記；13 站途中找到的七個問題也以追記補上：4.6.2 取消時少退款、4.7.1 排程一張失敗整批停下、5.6.4 測試撞到整分鐘、5.10 兩台同時第一次啟動搶著建管理員、6.4.3 single-flight、7.7.2 通知的認領、7.7.3 死信測試讀得太早） |
| 13-distributed-systems | ✅ 完成（00～09 章，約 52,000 行；這一站不設練習；第 09 章寫完之後補了一輪追記（`products.hot` 分兩次部署收縮（同一次部署就刪：123 張 500）、每個服務一個資料庫帳號、停寫從 24 秒縮到 1.5 秒（新的先起來待命、只換誰在寫）、binlog 的搬家程式、依使用者分群的灰度、兩個服務的部署順序（擴充、遷移、收縮）、`ShopJobHigh5xxRatio` 在 kind 上真的響了一次、Alertmanager 照 severity 分組與抑制、燃燒速率的告警量了沒有換（這個 SLO 之下，每一種事故都響得更慢）、尾端抽樣、configMapGenerator、GitOps（Flux：kubectl 改的一分鐘內被改回）、三個 node；探索時的那 1 張 500 找到了 —— 搬家程式裝 trigger 的 DDL 與做到一半的預留，外鍵讓它們在 metadata lock 上成環，預留改成死結就整個重做）；第 09 章把單體也放上 kind，照 Strangler Fig 遷移：照第 02 章的計畫加一個 10% 的灰度就超賣 44 件、搬家程式的核對卻說兩個庫一樣，改成程式先搬（兩個服務先接單體的庫，入口的權重灰度、`Shop-Route` 雙跑比對、cookie 黏性、兩邊各算的告警）、資料最後搬（邊寫邊對帳、停寫切換約 24 秒、反方向的搬家程式與回滾演練），最後用同一組問題判斷這個系統該合回去，並真的合回去（資料先、程式後；交錯量的下單 p50 35 → 30 ms、記憶體 1,512 → 585 MiB）；途中修了兩個行程同時第一次啟動搶著建管理員（第 12 站也有，5.10 的追記）與訂單服務的副本還沒建好就接流量；第 08 章把兩個服務搬到本機的 K8s（kind）、前面加一個 Gateway API 的入口，逐項量服務發現、負載平衡、設定、閘道的 K8s 原生做法（kube-proxy 平衡的是連線、入口會接著買家的 traceId、入口後面「每個 IP」數的是入口、兩層閘道各自重試、縮到 0 台時舊的告警不會響），Spring Cloud 那一欄只量了 Spring Cloud Gateway、其餘引用文件，寫成一份選型文件；途中抓到庫存服務對訂單服務限流（第 03 章就有的 bug），並修了第 12 站驗收 Q10 的通知競態（7.7.2 的追記）；第 07 章讓一個 traceId 穿過 HTTP 與 RabbitMQ：換成 OpenTelemetry、送到 Jaeger，只信任自己服務帶來的 traceparent，outbox 帶著寫它的那一個 span，用借連線的 span 與 self time 指出誰慢了，告警只叫醒使用者感受得到的，並做了一次排查演練（換版那一刻的舊訊息曾被丟掉、MDC 的掛勾被搶先，都是途中抓到的）；第 06 章量了慢的下游與重試風暴（只要一層「再送一次」，一次 10 秒的變慢就回不來），做了逾時預算、重試預算、隔艙與熔斷；第 05 章做了庫存的讀模型（版本、過時視窗、從快照重建），熱點旗標搬回庫存；第 04 章寫完之後補了幾個追記：出貨檢查漏掉的一個窗口（4.6.3）、熱點閘門的洞量了沒修（4.2.2）、第 02 章的六個情境與第 00 章的四個代價在真的線上重跑（4.10.6、4.10.7）、事件的契約與 Pact Broker／can-i-deploy（3.8.6）、trigger 的代價多量幾輪（2.8.4）） |

---

## 三種讀法

**路線 A：零基礎轉 Java 後端（建議 3～4 個月）**

```
01 Java 核心 → 02 Spring Boot → 03 REST API → 04/05/06 三層
→ 07 MySQL → 08 JPA → 09 Security → 10 Redis → 11 訊息佇列 → 12 期末專題
```

> 13 站是**選修**，不在這條路線裡。第一份 Java 後端工作不會要你拆微服務，會要你把單體寫好。

**路線 B：已會其他語言後端，只想快速上手 Java 生態（建議 4～6 週）**

```
01（只讀 02、05、06、10、11、13 章）→ 02 Spring Boot → 04/05/06 三層
→ 08 JPA → 09 Security → 10 Redis → 11 訊息佇列 → 12 期末專題
```

> 已經在做微服務、或公司正要拆的人：做完 12 站再進 [13-distributed-systems/](./13-distributed-systems/)。
> 如果連 12 站的單體都還沒做過，13 站的每一章都會變成背名詞。
>
> 已經在用 Redis / MQ、只想補洞的人：10 站直接從 09（分散式鎖）與 10（限流與冪等）讀，
> 11 站直接從 02（Outbox）與 03（冪等消費）讀 —— 這四章是最常被跳過、也最常出事的地方。
> ⚠️ **但 10 站的 09 章會一路往回指到 05（Lua）、03（單執行緒）**，追不下去的時候就是該補前半段的訊號。

**路線 C：已在寫 Spring Boot，想補洞**

依症狀挑章節：

| 你的症狀 | 直接讀 |
|----------|--------|
| 註解會用但不知道為什麼會生效 | [01-java-core/](./01-java-core/) 13、[02-spring-boot/](./02-spring-boot/) 01～02 |
| 上線後一變慢就整個服務停止回應 | [02-spring-boot/](./02-spring-boot/) 08 |
| API 改版就炸掉前端 | [03-rest-api/](./03-rest-api/) 06 |
| 商業邏輯全塞在 Controller | [04-controller/](./04-controller/) 00、[05-service/](./05-service/) 00 |
| 前端說「拿不到後端的錯誤訊息，只看到 Network Error」 | [04-controller/](./04-controller/) 06 |
| 匯出報表就 OOM，或匯出的資料悄悄少了幾十萬筆 | [04-controller/](./04-controller/) 05 |
| 新增一個列舉值就讓 App 大量閃退 | [04-controller/](./04-controller/) 06 |
| 對帳老是差幾分錢或差 8 小時 | [04-controller/](./04-controller/) 06 |
| 測試全綠，上線後客戶看到別人的資料 | [04-controller/](./04-controller/) 07 |
| CI 從 4 分鐘變成 47 分鐘，而刪測試沒有用 | [04-controller/](./04-controller/) 07 |
| 聊天上線後「有時候收不到訊息」，而且完全不報錯 | [04-controller/](./04-controller/) 08（8.2.1、8.10） |
| WebSocket 的 `Principal` 永遠是 null，但 Security 設定看起來沒問題 | [04-controller/](./04-controller/) 08（8.2.2、8.8） |
| WebSocket 連線數只增不減，直到 pod 被 OOMKilled | [04-controller/](./04-controller/) 08（8.2.3、8.9） |
| `@Transactional` 沒生效 | [05-service/](./05-service/) 02（2.7 的五種情境） |
| 方法看起來成功卻拋 `UnexpectedRollbackException` | [05-service/](./05-service/) 02（2.8） |
| 一個外部 API 變慢，整個服務就停止回應 | [05-service/](./05-service/) 02（2.9.3） |
| 促銷時大量 `Deadlock found when trying to get lock` | [05-service/](./05-service/) 02（2.11.9） |
| 促銷第一分鐘超賣，而單元測試全綠 | [05-service/](./05-service/) 00（0.8）、02 |
| 對帳一年差幾千元，查不出是哪幾筆 | [05-service/](./05-service/) 00（0.5.3） |
| 客戶收到「訂單成立」的信，但點進去 404 | [05-service/](./05-service/) 00（0.3.2） |
| 升級 Boot 之後啟動失敗，訊息是一個 40 行的框框 | [05-service/](./05-service/) 01（1.6） |
| 「每個 Service 都要有介面嗎」講不出理由 | [05-service/](./05-service/) 01（1.3） |
| 加了 `CHECK` 約束還是超賣，而資料庫裡的數字看起來正常 | [06-repository/](./06-repository/) 00（0.8） |
| 單元測試全綠，換成真的 SQL 才發現資料沒被存下來 | [06-repository/](./06-repository/) 00（0.10） |
| 半夜整站停止回應，但資料庫 CPU 只有 4% | [06-repository/](./06-repository/) 01（1.9） |
| `Connection is not available, request timed out` | [06-repository/](./06-repository/) 01（1.9.2 的五分鐘流程） |
| 連線池要設多大講不出理由 | [06-repository/](./06-repository/) 01（1.6） |
| 使用者刪掉一筆明細、存檔成功，重新整理後它又回來了 | [06-repository/](./06-repository/) 02（2.8.4） |
| 搜尋框輸入一個 `%`，資料庫 CPU 就滿了 | [06-repository/](./06-repository/) 02（2.3.6） |
| 報表上「沒有折扣」與「折扣 0 元」分不出來 | [06-repository/](./06-repository/) 02（2.5.5） |
| 客戶取消了訂單，系統仍然出貨（每週兩三件） | [06-repository/](./06-repository/) 02（2.8.3、練習 3） |
| 一段沒有實作的介面「就是會動」，但說不出為什麼 | [06-repository/](./06-repository/) 03（3.2） |
| 訂單列表在測試機很快，上線後越來越慢（而且不報錯） | [06-repository/](./06-repository/) 03（3.9.4 的 N+1） |
| 「我沒有呼叫 save，資料怎麼被改掉了？」 | [06-repository/](./06-repository/) 03（3.9.2） |
| Controller 回傳時炸 `LazyInitializationException`，堆疊卻指向 Jackson | [06-repository/](./06-repository/) 03（3.5.2） |
| 使用者說「列表裡有一筆重複，而我的訂單不見了」 | [06-repository/](./06-repository/) 04（4.4.1） |
| 列表翻到後面越來越慢，第 1 頁卻很快 | [06-repository/](./06-repository/) 04（4.7） |
| 「加了商品篩選之後，有些訂單就從列表裡消失了」 | [06-repository/](./06-repository/) 04（4.6.6） |
| 排序參數傳一個不存在的欄位就 500，訊息還印出 entity 類名 | [06-repository/](./06-repository/) 04（4.5.2） |
| 匯出功能一跑就 OOM，而程式碼裡用的是 `Stream` | [06-repository/](./06-repository/) 05（5.11.2） |
| 設了 `hibernate.jdbc.batch_size` 卻一點都沒變快 | [06-repository/](./06-repository/) 05（5.8.3） |
| 方法看起來成功卻拋 `UnexpectedRollbackException`，而且外層寫的也不見了 | [06-repository/](./06-repository/) 05（5.5.2） |
| 業務例外拋出來了，資料卻被寫進去 | [06-repository/](./06-repository/) 05（5.5.1） |
| 一個外部呼叫塞在交易裡，連線池就滿了 | [06-repository/](./06-repository/) 05（5.12.1） |
| 測試全綠，上到 MySQL 就 `bad SQL grammar` | [06-repository/](./06-repository/) 06（6.6） |
| 使用者用 `Admin` 註冊，卻能用 `admin` 登入 | [06-repository/](./06-repository/) 06（6.4.2 探針 ⑬） |
| 約束測試在 H2 上是綠的，正式環境卻擋不住 | [06-repository/](./06-repository/) 06（6.3.2） |
| CI 從 4 分鐘變 47 分鐘，而刪測試沒有用 | [06-repository/](./06-repository/) 06（6.9） |
| 客戶名字在資料庫裡是 `???`，而你的工具看起來正常 | [07-mysql/](./07-mysql/) 00（0.5.5） |
| 兩個人的暱稱只差一個 emoji，第二個卻註冊不了 | [07-mysql/](./07-mysql/) 00（0.5.7） |
| 同一張表的兩個時間欄位差 8 小時，而 Java 測試全綠 | [07-mysql/](./07-mysql/) 00（0.6.3、0.6.5） |
| 時區改存 UTC 之後，「今天的營業額」反而少算了 | [07-mysql/](./07-mysql/) 00（0.6.6） |
| 設定沒改，某天半夜就 `Public Key Retrieval is not allowed` | [07-mysql/](./07-mysql/) 00（0.7.2） |
| 連不上資料庫，錯誤訊息是 `Communications link failure` | [07-mysql/](./07-mysql/) 00（0.7.2 的 sslMode） |
| CI 隨機失敗，而 `depends_on` 明明有設 | [07-mysql/](./07-mysql/) 00（0.4.2） |
| Mac 上測試全過，上線 Linux 就 `Table doesn't exist` | [07-mysql/](./07-mysql/) 00（0.9） |
| 批次插入很慢，以為是資料庫的問題 | [07-mysql/](./07-mysql/) 00（0.7.4 的 22 倍） |
| 遷移腳本失敗了，但第一個 `ALTER` 已經生效 | [07-mysql/](./07-mysql/) 06（6.5.1） |
| `git diff` 看起來沒改，服務卻起不來 | [07-mysql/](./07-mysql/) 06（6.3.5 的行尾空白） |
| `ALGORITHM=INSTANT` 的 DDL 卡住全站十幾秒 | [07-mysql/](./07-mysql/) 06（6.7.4 的 MDL） |
| 第 65 次 `ALTER` 突然報 `ERROR 4092` | [07-mysql/](./07-mysql/) 06（6.7.3） |
| `VARCHAR` 加長，有時候 0.1 秒有時候 5 秒 | [07-mysql/](./07-mysql/) 06（6.7.2 的 255 位元組邊界） |
| 刪掉舊資料，磁碟卻沒有變小 | [07-mysql/](./07-mysql/) 05（5.9.2）、06（6.7.9） |
| 備份「成功」了，還原時才發現少一張表的資料 | [07-mysql/](./07-mysql/) 07（7.2.4） |
| 誤刪資料，而事故後又進了新訂單 | [07-mysql/](./07-mysql/) 07（7.2.7 的 PITR） |
| 從庫回報零延遲，資料卻落後十幾秒 | [07-mysql/](./07-mysql/) 07（7.3.5） |
| 從庫設了唯讀，卻還是被寫進一筆資料 | [07-mysql/](./07-mysql/) 07（7.3.7） |
| 下單成功後跳轉，訂單頁說「找不到」 | [07-mysql/](./07-mysql/) 07（7.4.1 的 100%） |
| 主從資料不一樣，而複製狀態一切正常 | [07-mysql/](./07-mysql/) 07（7.3.1 的 STATEMENT 格式） |
| 對帳永遠差幾分錢 | [07-mysql/](./07-mysql/) 01（1.3.4、1.3.5） |
| 營業額報表的數字比實際多一倍 | [07-mysql/](./07-mysql/) 02（2.3.3） |
| 改成 `LEFT JOIN` 之後，有些資料還是不見了 | [07-mysql/](./07-mysql/) 02（2.3.2） |
| 「沒有訂單的客戶」在報表上顯示有 1 筆訂單 | [07-mysql/](./07-mysql/) 02（2.3.4） |
| 每日報表少了「當天沒有交易」的那幾天 | [07-mysql/](./07-mysql/) 02（2.9.1） |
| 行銷名單篩掉黑名單之後變成空的 | [07-mysql/](./07-mysql/) 02（2.5.2） |
| 訂單的商品清單顯示到一半就斷掉 | [07-mysql/](./07-mysql/) 02（2.4.5） |
| 累計金額報表在金額相同的兩天出現同一個數字 | [07-mysql/](./07-mysql/) 02（2.6.3） |
| 從 5.7 升 8.0 之後報表順序變了 | [07-mysql/](./07-mysql/) 02（2.4.3） |
| 改了暱稱之後使用者的頭像不見了 | [07-mysql/](./07-mysql/) 02（2.7.5 的 `REPLACE INTO`） |
| 用 `rowsAffected` 判斷 UPSERT 成功，結果誤判 | [07-mysql/](./07-mysql/) 02（2.7.3） |
| 查某支手機的訂單，查到別人的訂單 | [07-mysql/](./07-mysql/) 02（2.8.2） |
| 一筆 9999 萬的交易在報表上變成 1 億 | [07-mysql/](./07-mysql/) 01（1.3.4） |
| 每個月都有幾筆訂單被算進「隔天」，查不出規律 | [07-mysql/](./07-mysql/) 01（1.5.2） |
| 軟刪除的帳號加了唯一索引，還是出現重複的 email | [07-mysql/](./07-mysql/) 01（1.10.4） |
| UUID 主鍵在測試機很快，上線後寫入慢十倍 | [07-mysql/](./07-mysql/) 01（1.8.3） |
| `ALTER TABLE` 一下去整張表就唯讀了 | [07-mysql/](./07-mysql/) 01（1.2.2） |
| 查詢很慢，但 `EXPLAIN` 看起來「有走索引」 | [07-mysql/](./07-mysql/) 03（3.7.3、誤區 2） |
| 加了 `COLLATE` 修好 `Illegal mix of collations`，然後整個報表慢兩分鐘 | [07-mysql/](./07-mysql/) 03（3.7.8 的 1,950 倍） |
| 複合索引建了，但第二個欄位好像沒作用 | [07-mysql/](./07-mysql/) 03（3.4.3 的 `key_len`、3.5.3） |
| 列表翻到第 5 萬頁要等十秒 | [07-mysql/](./07-mysql/) 03（3.8.6 的 seek 法） |
| `ORDER BY ... DESC` 就出現 `Using filesort` | [07-mysql/](./07-mysql/) 03（3.5.5） |
| 「這個索引好像沒人用，但我不敢刪」 | [07-mysql/](./07-mysql/) 03（3.8.4 的不可見索引） |
| `EXPLAIN` 的 `rows` 跟實際差一倍以上 | [07-mysql/](./07-mysql/) 03（3.4.5、3.9.2 的直方圖） |
| 加了 optimizer hint，但執行計畫沒變 | [07-mysql/](./07-mysql/) 03（3.9.3 的靜默失敗） |
| 兩個單欄索引，`EXPLAIN` 出現 `Using intersect` | [07-mysql/](./07-mysql/) 03（3.8.2 的 68 倍） |
| 同一種寫法在 A 查詢快 19 倍、在 B 查詢慢 135 倍 | [07-mysql/](./07-mysql/) 03（3.10.3）、02（2.6.8） |
| 查詢很慢、log 一堆 SQL | [08-jpa-mybatis/](./08-jpa-mybatis/) 04、[07-mysql/](./07-mysql/) 03 |
| 登入做完了，使用者還是讀得到別人的訂單 | [09-spring-security/](./09-spring-security/) 00（0.3.1） |
| 「先讓它跑起來」的 `permitAll()` 活到上線，而且沒有任何訊號 | [09-spring-security/](./09-spring-security/) 00（0.3.2、0.8.4） |
| 密碼用 MD5 存，說不出「到底有多不安全」 | [09-spring-security/](./09-spring-security/) 00（0.3.3、0.7.2） |
| 登入失敗的回應一模一樣，帳號還是被列舉出去 | [09-spring-security/](./09-spring-security/) 00（0.3.4 的 22873 倍） |
| Filter 裡拋的例外，`@RestControllerAdvice` 接不到，前端只看到空的 401 | [09-spring-security/](./09-spring-security/) 00（0.3.5）、01（1.8） |
| 升級 Boot 3 之後，登入回 200 但下一個請求說沒登入 | [09-spring-security/](./09-spring-security/) 00（0.3.6）、01（1.5） |
| 401 該回還是 403 該回，講不出判準 | [09-spring-security/](./09-spring-security/) 00（0.4） |
| BCrypt 的 `cost` 要設多少，只會抄「設 10」 | [09-spring-security/](./09-spring-security/) 00（0.7.4） |
| 「我的 Security 設定好像沒生效」 | [09-spring-security/](./09-spring-security/) 01（1.3.3、1.4.4） |
| 自訂的 Filter 每個請求跑了兩次 | [09-spring-security/](./09-spring-security/) 01（1.6.4） |
| 兩條 `SecurityFilterChain`，第二條永遠不生效（而且啟動不報錯） | [09-spring-security/](./09-spring-security/) 01（1.7.3、1.7.4） |
| `@Async` 的方法拿不到登入者身分 | [09-spring-security/](./09-spring-security/) 01（1.9.2、1.9.5） |
| 非同步通知寄錯人 / 稽核日誌全記成同一個帳號 | [09-spring-security/](./09-spring-security/) 01（1.9.4 的身分外洩） |
| 自己寫的 `UserDetailsService` 讓「帳號存不存在」被時間差洩漏 | [09-spring-security/](./09-spring-security/) 02（2.5.3） |
| 帳密明明正確卻一直回 401（Entity 當 `UserDetails`） | [09-spring-security/](./09-spring-security/) 02（2.7.3） |
| 應用程式啟得起來，第一次登入卻 `StackOverflowError` | [09-spring-security/](./09-spring-security/) 02（2.6.3） |
| 帳號停用了，那個人的 session 卻還能用 | [09-spring-security/](./09-spring-security/) 02（2.7.7） |
| 用 HTTP Basic 保護的 API，QPS 一過七十就開始逾時 | [09-spring-security/](./09-spring-security/) 02（2.3.5） |
| 換密碼演算法要不要叫五十萬個使用者改密碼 | [09-spring-security/](./09-spring-security/) 02（2.8） |
| 不知道 JWT 該怎麼做才安全 | [09-spring-security/](./09-spring-security/) 05 |
| `redis-cli` 看到一串亂碼，改個套件名整個快取都讀不回來 | [10-redis/](./10-redis/) 00（0.3.3）、06 |
| 「Redis 只是快取」，但它一卡，整站的執行緒全堵住 | [10-redis/](./10-redis/) 03（3.7）、06（6.8）、08 |
| 沒設過期時間的購物車自己不見了，而且沒有任何錯誤 | [10-redis/](./10-redis/) 04（淘汰策略）、11（11.6.4） |
| 一行 `keys()` 讓所有人的 API 卡住半秒 | [10-redis/](./10-redis/) 01（1.5）、03 |
| 加了分散式鎖還是超賣，而鎖看起來有拿到 | [10-redis/](./10-redis/) 09（9.8 鎖與交易的順序） |
| 業務跑超過鎖的過期時間，兩個執行緒同時「持有」同一把鎖 | [10-redis/](./10-redis/) 09（9.6 watchdog） |
| 限流設 100 QPS，交界那一秒卻進來 200 個請求 | [10-redis/](./10-redis/) 10（10.2.3 固定窗） |
| 客戶端逾時重試，於是同一筆訂單建立了兩張 | [10-redis/](./10-redis/) 10（10.9 冪等鍵） |
| 加了一台機器之後，使用者「登入了又沒登入」 | [10-redis/](./10-redis/) 11（11.2） |
| 主從切換完成了，Java 客戶端卻 40 秒都沒恢復 | [10-redis/](./10-redis/) 13（13.5、13.8） |
| 單機測得好好的 Lua，上了 Cluster 直接回 `CROSSSLOT` | [10-redis/](./10-redis/) 13（13.7） |
| 通知信寄出去了，點進去卻找不到那筆訂單 | [11-messaging/](./11-messaging/) 02（Outbox） |
| 訂單寫進資料庫了，訊息沒送出去就重啟 | [11-messaging/](./11-messaging/) 01、02 |
| 同一封確認信客戶收到五次 | [11-messaging/](./11-messaging/) 03（冪等消費） |
| 消費失敗就 requeue，佇列每秒繞幾千圈把 broker 打爛 | [11-messaging/](./11-messaging/) 06 |
| 消費者一直被踢出 group，同一批訊息永遠處理不完 | [11-messaging/](./11-messaging/) 08（`max.poll.interval.ms`） |
| 想要全域順序於是只開一個 partition，吞吐就卡死了 | [11-messaging/](./11-messaging/) 07 |
| 用了 Kafka「精確一次」，資料庫卻還是被寫了兩次 | [11-messaging/](./11-messaging/) 09 |
| 出事時完全不知道訊息卡在哪 | [11-messaging/](./11-messaging/) 10 |
| 「我們為什麼用 RabbitMQ 不用 Kafka」講不出理由 | [11-messaging/](./11-messaging/) 11 |
| 拆成微服務之後，每個改動要協調三個團隊、四次部署 | [13-distributed-systems/](./13-distributed-systems/) 00、01（分散式單體） |
| 兩個「微服務」共用同一個資料庫 | [13-distributed-systems/](./13-distributed-systems/) 02 |
| 拆完之後報表寫不出來，因為 JOIN 不見了 | [13-distributed-systems/](./13-distributed-systems/) 02、05 |
| 同一個 jar 部署成兩個服務，一半的事件被錯的服務收走，有的還「成功」 | [13-distributed-systems/](./13-distributed-systems/) 03（同一個 jar、兩個角色） |
| 服務之間逾時，使用者再按一次，庫存補了兩次 | [13-distributed-systems/](./13-distributed-systems/) 03（服務之間的冪等） |
| 改了一個欄位的名字，測試全綠，上線後舊版的服務讀到 0 | [13-distributed-systems/](./13-distributed-systems/) 03（Pact 契約測試） |
| 訂單建立成功、扣庫存失敗，那筆訂單卡在中間沒人收 | [13-distributed-systems/](./13-distributed-systems/) 04（Saga 補償） |
| 一台服務當掉之後，使用者重送 30 秒都是「處理中」，最後還多一筆預留 | [13-distributed-systems/](./13-distributed-systems/) 04（catch 不是補償；冪等鍵綁到 Saga 的訂單） |
| 用了兩階段提交，協調者一當掉，熱門商品那一列被鎖住、整個搶購停住 | [13-distributed-systems/](./13-distributed-systems/) 04（2PC 的代價） |
| 加一個訂單狀態，migration 讓下單停了兩秒，報表的數字也多算了 | [13-distributed-systems/](./13-distributed-systems/) 04（語意鎖的代價） |
| 出貨之前明明問過庫存，還是出了一件不存在的貨 | [13-distributed-systems/](./13-distributed-systems/) 04（4.6.3 的追記：決定「要不要問」的那一次讀也會過時） |
| 搶購期間 Redis 跟 MySQL 對不上，對帳一直沒修 | [13-distributed-systems/](./13-distributed-systems/) 04（4.2.2 的追記：「連續兩輪才修」在一直有人買的時候永遠不成立） |
| 兩個服務的新版本都測過了，卻不知道該先部署哪一個 | [13-distributed-systems/](./13-distributed-systems/) 03（3.8.6 的追記：Pact Broker 與 can-i-deploy） |
| 庫存服務停掉，商品頁、購物車全部 503，只因為「還剩幾件」拿不到 | [13-distributed-systems/](./13-distributed-systems/) 05（讀模型：可以晚的讀不要每一次問） |
| 讀模型偶爾停在舊的數字，重試過的事件把新的值蓋回去 | [13-distributed-systems/](./13-distributed-systems/) 05（事件帶版本；`>=` 才修得好版本一樣、值錯了的列） |
| 讀模型的消費者部署好了，卻一則事件都沒收到 | [13-distributed-systems/](./13-distributed-systems/) 05（5.4.4：relay 只送自己的行程裡有人訂閱的事件） |
| 一個服務變慢，五個服務跟著一起死 | [13-distributed-systems/](./13-distributed-systems/) 06（級聯故障） |
| 每一層最多送 3 次，五層下去最底層收到 243 倍流量 | [13-distributed-systems/](./13-distributed-systems/) 06（重試風暴：這條線上兩層，量到 6 倍；重試預算） |
| 下游只慢了 10 秒，系統卻 40 秒都回不來 | [13-distributed-systems/](./13-distributed-systems/) 06（6.3.4：只要一層「再送一次」；預算與借到連線之後的檢查） |
| 每個呼叫都設了逾時，服務還是整個卡死，連不相關的頁面也慢 | [13-distributed-systems/](./13-distributed-systems/) 06（6.2：逾時 × 重送 × 每秒請求數 = 佔住的執行緒；隔艙） |
| 熔斷器開著，還是寫了一堆要補償的訂單 | [13-distributed-systems/](./13-distributed-systems/) 06（6.7.5：在做任何事之前問熔斷器） |
| 出事時每個服務的 log 看起來都正常，trace 卻一條都接不起來 | [13-distributed-systems/](./13-distributed-systems/) 07（收的那一邊丟了 traceparent、事件只帶 traceId、各服務各抽各的） |
| 客服拿著錯誤畫面上的 traceId，兩個服務的日誌都找不到 | [13-distributed-systems/](./13-distributed-systems/) 07（7.2.5、7.10） |
| 換了追蹤的實作，換版那一刻佇列裡的事件不見了 | [13-distributed-systems/](./13-distributed-systems/) 07（7.6.4：舊訊息的那條路丟例外，訊息不重新排隊） |
| 一張慢的請求，trace 上看不出慢在哪一段 | [13-distributed-systems/](./13-distributed-systems/) 07（7.7：借連線的 span、self time） |
| 熔斷器擋下的請求，trace 上什麼都沒有 | [13-distributed-systems/](./13-distributed-systems/) 07（7.7.5：每一個「不做了」都要留一個 span） |
| 拆成兩個服務之後，大部分的告警再也不會響，而且沒有任何錯誤 | [13-distributed-systems/](./13-distributed-systems/) 07（7.9.2：規則寫死了 job 的名字，19 條裡 16 條） |
| 日誌突然全部沒有 traceId，卻沒有任何錯誤 | [13-distributed-systems/](./13-distributed-systems/) 07（7.4.4：OpenTelemetry 的 MDC 掛勾被搶先） |
| 庫存服務多開一台，新的那一台一個請求都沒收到；舊的一停就是一次事故 | [13-distributed-systems/](./13-distributed-systems/) 08（8.2：寫死的位址；8.5：一個 Service 的名字） |
| K8s 上擴容之後，新的 pod 半分鐘以上分不到請求，之後一台拿全部 | [13-distributed-systems/](./13-distributed-systems/) 08（8.6：kube-proxy 平衡的是連線，不是請求） |
| 拆開之後，下單量一大就有幾張 500，庫存服務的日誌是 429 | [13-distributed-systems/](./13-distributed-systems/) 08（8.6.3：庫存服務把訂單服務限流了） |
| 前面加了 gateway，trace 從 gateway 開始就斷了，或者 traceId 是買家決定的 | [13-distributed-systems/](./13-distributed-systems/) 08（8.8.2：入口拿掉、服務信任、只有入口連得到，三樣一起） |
| 前面加了 gateway，全站每秒 50 個請求就開始 429 | [13-distributed-systems/](./13-distributed-systems/) 08（8.8.3：「每個 IP」數的是 gateway） |
| Spring Cloud Gateway 和 K8s 的入口兩層各自重試，一個請求在後面變成 8 次、買家拿到 504 | [13-distributed-systems/](./13-distributed-systems/) 08（8.8.4：有邏輯的閘道只能有一層） |
| 服務整個縮到 0 台，告警卻沒有響 | [13-distributed-systems/](./13-distributed-systems/) 08（8.9.1：kubernetes_sd 上，被刪掉的 pod 是消失，不是 down） |
| 改了 ConfigMap，應用程式用的還是舊的值 | [13-distributed-systems/](./13-distributed-systems/) 08（8.7.1） |
| Spring Cloud 的新 patch 起得來，第一個請求就 NoSuchMethodError | [13-distributed-systems/](./13-distributed-systems/) 08（8.8.4：Spring Cloud 跟 Spring Boot 的版本綁在一起） |
| 灰度只切了 10%，庫存就超賣，搬家程式的核對卻說兩個庫一樣 | [13-distributed-systems/](./13-distributed-systems/) 09（9.2：資料在兩個庫的時候，灰度就是兩個正本；9.3：程式先搬、資料最後搬） |
| 回滾只把權重改回去，那一段的訂單在舊的庫裡找不到預留 | [13-distributed-systems/](./13-distributed-systems/) 09（9.2、9.7：資料搬了，回滾就是另一次搬家） |
| 兩台同時對一個新的庫第一次部署，其中一台起不來 | [13-distributed-systems/](./13-distributed-systems/) 09（9.4.3）、[12-capstone/](./12-capstone/) 05（5.10 的追記） |
| 新的服務一接到流量，商品頁全部說 0 件 | [13-distributed-systems/](./13-distributed-systems/) 09（9.4.4：讀模型建好之前，readiness 不放流量）、05（5.6.4） |
| 灰度時新的那一邊錯了一成，告警一聲都沒響 | [13-distributed-systems/](./13-distributed-systems/) 09（9.5.2：全站的比例被稀釋，兩邊要各算各的） |
| 同一個買家重新整理，剩幾件反而變多 | [13-distributed-systems/](./13-distributed-systems/) 09（9.5.4：來回兩邊，一邊讀的是副本；黏性） |
| 停寫切換在測試環境只要一兩秒，在 K8s 上停了半分鐘 | [13-distributed-systems/](./13-distributed-systems/) 09（9.6.5：停寫的時間幾乎都是 pod 的關與起） |
| 拆完發現不對，沒有人敢提、也不知道怎麼合回去 | [13-distributed-systems/](./13-distributed-systems/) 09（9.9：同一組問題、加上數字；9.10：資料先、程式後） |
| 刪掉一個沒有人用的欄位，部署的那十幾秒下單大半是 500 | [13-distributed-systems/](./13-distributed-systems/) 05（5.7.9：收縮要分兩次部署 —— 先不讀不寫，下一次才刪） |
| 共用一個庫的那一段，新的服務讀得到別的服務的表、有人越界也沒有人知道 | [13-distributed-systems/](./13-distributed-systems/) 02（2.4.4 的追記：每個服務一個角色）、09（9.4.6） |
| 換庫的停寫半分鐘，幾乎都在等 pod 關掉、起來 | [13-distributed-systems/](./13-distributed-systems/) 09（9.6.7：新的先起來待命、舊的凍結，只換誰在寫） |
| 搬家程式裝 trigger（或 migration 跑一句 ALTER）的那一刻，一張下單 500，InnoDB 的死結紀錄裡什麼都沒有 | [13-distributed-systems/](./13-distributed-systems/) 09（9.6.5 的追記：外鍵讓 DDL 與做到一半的預留在 metadata lock 上成環，被犧牲的是預留；死結就整個交易重做） |
| 藍綠切換之後拿掉不用的那一組，值班的人被叫醒 | [13-distributed-systems/](./13-distributed-systems/) 09（9.6.7：兩組的 job 不同名，「整個服務不見了」的告警把它當成停機） |
| 兩個服務互相要對方的新版本，哪一個都不能先上 | [13-distributed-systems/](./13-distributed-systems/) 09（9.5.8：擴充、遷移、收縮，每一步問 can-i-deploy） |
| 一次事故，值班的人被叫醒兩次 | [13-distributed-systems/](./13-distributed-systems/) 07（7.11.1：照 severity 分組、抑制） |
| 照書上改成燃燒速率的告警，整個停掉的時候反而更晚才響 | [13-distributed-systems/](./13-distributed-systems/) 07（7.11.2：叫醒人要多快，是 SLO 決定的） |
| 出事的那幾張 trace 剛好沒被抽到 | [13-distributed-systems/](./13-distributed-systems/) 07（7.8.4：尾端抽樣，與它的代價） |
| `kubectl rollout undo` 之後，設定還是新的 | [13-distributed-systems/](./13-distributed-systems/) 08（8.7.3：configMapGenerator，與 migration 的 Job） |
| 灰度的權重用 kubectl 改了，過一會兒自己變回去 | [13-distributed-systems/](./13-distributed-systems/) 08（8.4.6：GitOps 之下，改權重是一個 commit） |

---

## 環境需求

| 項目 | 版本 / 建議 |
|------|-------------|
| JDK | **21 LTS**（最低 17；Java 25 也是 LTS，課程會標註版本差異） |
| 建置工具 | Maven 3.9+ 或 Gradle 8+ |
| Spring Boot | 3.x（Jakarta EE 命名空間） |
| 資料庫 | MySQL 8.0+（建議用 Docker 跑） |
| 快取 | Redis 7.2+（10 站起，Docker） |
| 訊息佇列 | RabbitMQ 3.13+ 與 Kafka 3.7+（11 站起，Docker Compose） |
| IDE | IntelliJ IDEA（推薦）/ VS Code + Extension Pack for Java |
| 其他 | Docker Desktop、Postman 或 VS Code REST Client |

### 快速開始

```bash
# 1. 安裝 JDK（macOS 建議用 SDKMAN 管多版本）
curl -s "https://get.sdkman.io" | bash
sdk install java 21.0.5-tem   # 課程基準；Java 25 LTS 也可以，差異都會標註
java -version

# 2. 用 Docker 起一個 MySQL
docker run -d --name mysql-learn \
  -e MYSQL_ROOT_PASSWORD=root \
  -e MYSQL_DATABASE=learnjava \
  -p 3306:3306 \
  mysql:8.0

# 3. 建立第一個 Spring Boot 專案
curl https://start.spring.io/starter.zip \
  -d dependencies=web,data-jpa,mysql,validation \
  -d javaVersion=21 \
  -d type=maven-project \
  -o demo.zip
unzip demo.zip -d demo
```

---

> 準備好了嗎？從 [01-java-core/](./01-java-core/) 開始吧。
