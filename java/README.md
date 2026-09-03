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
- 把 Redis 正確接進 Spring 專案：快取、分散式鎖、限流，以及 Redis 掛掉時的降級。
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
Redis                快取、分散式鎖、限流、降級（10-redis）
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
| 04 | [04-controller/](./04-controller/) ✅ | Web 層實作 | 8 | 參數綁定、Bean Validation、全域例外處理、Filter / Interceptor、檔案與串流、SSE、CORS 與序列化、MockMvc 與授權矩陣測試 |
| 05 | [05-service/](./05-service/) ✅ | 商業邏輯層 | 8 | 商業邏輯層定位與**不變量**、貧血 vs 充血、Service 設計與**循環依賴**、交易傳播、DTO 轉換、例外分層、快取、非同步、外部 API、Mockito 測試 |
| 06 | [06-repository/](./06-repository/) ✅ | 資料存取層 | 7 | 資料層定位與**介面設計的七個判準**、**不變量的第四個位置**、DataSource 與連線池、JdbcTemplate、Spring Data 抽象、**分頁與動態查詢**、**交易邊界與批次**、**資料層測試（H2 vs 真 MySQL 的 21 根探針）** |
| 07 | [07-mysql/](./07-mysql/) ✅ | MySQL 實戰 | 8 | Schema 設計、JOIN、索引與 EXPLAIN、InnoDB 交易與鎖、慢查詢調校、Flyway 與線上大表變更、備份／複製／讀寫分離 |
| 08 | [08-jpa-mybatis/](./08-jpa-mybatis/) | JPA / Hibernate 與 MyBatis | 10 | Entity 映射、關聯、持久化情境、N+1、JPQL / QueryDSL、MyBatis 動態 SQL |
| 09 | [09-spring-security/](./09-spring-security/) | 認證與授權 | 9 | Filter Chain、UserDetails、方法層權限、Session vs Token、JWT、OAuth2 |
| 10 | [10-redis/](./10-redis/) | Redis 應用（Spring 視角） | 9 | 序列化與 Lettuce 逾時、快取抽象接 Redis、**故障降級**、分散式鎖、限流與冪等、Session 與 Token 撤銷、預扣庫存 |
| 11 | [11-messaging/](./11-messaging/) | 訊息佇列：RabbitMQ 與 Kafka | 12 | 可靠投遞三段、**Outbox**、冪等消費、RabbitMQ 拓撲與 DLX、Kafka 分區與 offset、精確一次、死信與 lag 監控、選型 |
| 12 | [12-capstone/](./12-capstone/) | 期末專題：訂單系統 | 10 | 把上面全部串成一個可部署、有測試、有監控的服務 |
| 13 | [13-distributed-systems/](./13-distributed-systems/) 🔸 | 服務拆分與分散式一致性 | 10 | **該不該拆**、邊界切法、資料庫拆分、Saga 與補償、跨服務查詢、服務網韌性、分散式追蹤、Spring Cloud vs K8s 選型、遷移與回頭路 |

合計 **125 個章節**。✅ 表示該子課程已完成，🚧 表示進行中，🔸 表示進階選修。

> **10 與 11 的定位**：它們不教 Redis 或 MQ 的內部原理，教的是「這東西進到 Spring 專案裡會怎麼壞」。
> Redis 本身（資料結構、持久化、Cluster）請看 [../database-course/redis-course/](../database-course/redis-course/)，本課只負責 Java 這一側的交界。

> **13 為什麼在 capstone 之後、而且不叫「Spring Cloud」**：
> Spring Cloud 的主要內容在這門課裡已經拆散教完了 —— 熔斷與重試在 [05-service/06](./05-service/06-async-and-external-api-calls.md)、限流在 [03-rest-api/08](./03-rest-api/08-idempotency-caching-and-rate-limit.md) 與 [10-redis/](./10-redis/)、
> 設定中心在 [02-spring-boot/03](./02-spring-boot/03-configuration-properties-and-profiles.md)、追蹤在 [02-spring-boot/05](./02-spring-boot/05-logging-and-actuator.md)、閘道在 [../nginx/](../nginx/)、服務發現在 [../docker/](../docker/) 的 K8s 兩章。
> 真正還沒教的不是「Spring Cloud 的功能」，而是**架構問題**：該不該拆、資料庫怎麼拆、跨服務的交易怎麼收尾。
> 這些問題只有在你手上已經有一個會痛的單體時才問得出來 —— 所以它排在 capstone 之後，
> 工具選型（Spring Cloud vs K8s 原生）放在第 08 章當決策表，而不是當前提。

### 目前進度

| 子課程 | 狀態 |
|--------|------|
| 01-java-core | ✅ 已結業（14 章，約 54,400 行） |
| 02-spring-boot | ✅ 已結業（10 章，約 29,100 行） |
| 03-rest-api | ✅ 已結業（10 章，約 33,700 行） |
| 04-controller | ✅ 完成（00～07 章，約 61,500 行） |
| 05-service | ✅ 完成（00～07 章，約 42,400 行） |
| 06-repository | ✅ 完成（00～06 章，約 20,150 行） |
| 07-mysql | ✅ 完成（00～07 章，8 章） |
| 08～13 | ⏳ 未開始 |

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
> 已經在用 Redis / MQ、只想補洞的人：10 站直接從 03（分散式鎖）與 05（限流）讀，
> 11 站直接從 02（Outbox）與 03（冪等消費）讀 —— 這四章是最常被跳過、也最常出事的地方。

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
| 不知道 JWT 該怎麼做才安全 | [09-spring-security/](./09-spring-security/) 05 |
| `redis-cli` 看到一串亂碼，改個套件名整個快取都讀不回來 | [10-redis/](./10-redis/) 01 |
| 「Redis 只是快取」，但它一卡，整站的執行緒全堵住 | [10-redis/](./10-redis/) 01、03 |
| 加了分散式鎖還是超賣，而鎖看起來有拿到 | [10-redis/](./10-redis/) 04（鎖與交易的順序） |
| 業務跑超過鎖的過期時間，兩個執行緒同時「持有」同一把鎖 | [10-redis/](./10-redis/) 04（watchdog） |
| 限流設 100 QPS，交界那一秒卻進來 200 個請求 | [10-redis/](./10-redis/) 05 |
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
| 訂單建立成功、扣庫存失敗，那筆訂單卡在中間沒人收 | [13-distributed-systems/](./13-distributed-systems/) 04（Saga 補償） |
| 一個服務變慢，五個服務跟著一起死 | [13-distributed-systems/](./13-distributed-systems/) 06（級聯故障） |
| 每層重試 3 次，最底層收到 243 倍流量 | [13-distributed-systems/](./13-distributed-systems/) 06（重試風暴） |
| 出事時每個服務的 log 看起來都正常 | [13-distributed-systems/](./13-distributed-systems/) 07（`traceId` 跨服務） |
| Spring Cloud Gateway 和 K8s Ingress 兩套路由打架 | [13-distributed-systems/](./13-distributed-systems/) 08 |

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

## 與其他課程的關係

- [../database-course/](../database-course/) — 資料庫**通論**（選型、建模、高併發、Redis、NoSQL）。本課的 07-mysql 聚焦「Java 專案怎麼用 MySQL」，兩者互補。
- [../database-course/redis-course/](../database-course/redis-course/) — Redis **本體**（資料結構、持久化、Cluster、維運排錯，15 章）。本課的 10-redis 只講 Java 這一側；兩門課建議搭配讀，不重複。
- [../docker/](../docker/) — 12-capstone 的部署章節會用到。
- [../security-course/](../security-course/) — 攻擊者視角。09-spring-security 是防守方視角，可對照閱讀。

---

> 準備好了嗎？從 [01-java-core/](./01-java-core/) 開始吧。
