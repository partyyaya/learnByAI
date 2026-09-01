# Java 後端工程師完整學習路線

> 這不是一門「Java 語法課」，而是一條**從語言基礎到可上線後端服務**的完整路線。
> 依照 `Java → Spring Boot → REST API → Controller → Service → Repository → MySQL → JPA / MyBatis → Spring Security` 的技能鏈設計，
> 每一站都是獨立子課程，可以單獨讀，也可以照順序一路走到期末專題。

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
- 獨立完成一個可部署、有測試、有監控的後端服務。

## 適合對象

- 會其他語言（JS / Python / PHP），要轉 Java 後端的工程師。
- 學過 Java 語法，但一碰 Spring Boot 就只會複製貼上的人。
- 前端 / 全端工程師想補齊後端與資料庫這一段。
- 準備面試，需要能講清楚分層架構、交易、ORM、權限設計的人。

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
Capstone             整合成一個可上線的服務（10-capstone）
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
| 07 | [07-mysql/](./07-mysql/) | MySQL 實戰 | 8 | Schema 設計、JOIN、索引與 EXPLAIN、InnoDB 交易與鎖、慢查詢、Flyway |
| 08 | [08-jpa-mybatis/](./08-jpa-mybatis/) | JPA / Hibernate 與 MyBatis | 10 | Entity 映射、關聯、持久化情境、N+1、JPQL / QueryDSL、MyBatis 動態 SQL |
| 09 | [09-spring-security/](./09-spring-security/) | 認證與授權 | 9 | Filter Chain、UserDetails、方法層權限、Session vs Token、JWT、OAuth2 |
| 10 | [10-capstone/](./10-capstone/) | 期末專題：訂單系統 | 8 | 把上面全部串成一個可部署、有測試、有監控的服務 |

合計 **92 個章節**。✅ 表示該子課程已完成，🚧 表示進行中。

### 目前進度

| 子課程 | 狀態 |
|--------|------|
| 01-java-core | ✅ 已結業（14 章，約 54,400 行） |
| 02-spring-boot | ✅ 已結業（10 章，約 29,100 行） |
| 03-rest-api | ✅ 已結業（10 章，約 33,700 行） |
| 04-controller | ✅ 完成（00～07 章，約 61,500 行） |
| 05-service | ✅ 完成（00～07 章，約 42,400 行） |
| 06-repository | ✅ 完成（00～06 章，約 20,150 行） |
| 07～10 | ⏳ 未開始 |

---

## 三種讀法

**路線 A：零基礎轉 Java 後端（建議 3～4 個月）**

```
01 Java 核心 → 02 Spring Boot → 03 REST API → 04/05/06 三層
→ 07 MySQL → 08 JPA → 09 Security → 10 期末專題
```

**路線 B：已會其他語言後端，只想快速上手 Java 生態（建議 4～6 週）**

```
01（只讀 02、05、06、10、11、13 章）→ 02 Spring Boot → 04/05/06 三層
→ 08 JPA → 09 Security → 10 期末專題
```

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
| 查詢很慢、log 一堆 SQL | [08-jpa-mybatis/](./08-jpa-mybatis/) 04、[07-mysql/](./07-mysql/) 03 |
| 不知道 JWT 該怎麼做才安全 | [09-spring-security/](./09-spring-security/) 05 |

---

## 環境需求

| 項目 | 版本 / 建議 |
|------|-------------|
| JDK | **21 LTS**（最低 17；Java 25 也是 LTS，課程會標註版本差異） |
| 建置工具 | Maven 3.9+ 或 Gradle 8+ |
| Spring Boot | 3.x（Jakarta EE 命名空間） |
| 資料庫 | MySQL 8.0+（建議用 Docker 跑） |
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
- [../docker/](../docker/) — 10-capstone 的部署章節會用到。
- [../security-course/](../security-course/) — 攻擊者視角。09-spring-security 是防守方視角，可對照閱讀。

---

> 準備好了嗎？從 [01-java-core/](./01-java-core/) 開始吧。
