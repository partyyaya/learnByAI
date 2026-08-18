# 第 00 章：課程地圖與 Spring Boot 定位

> 「加一個註解就會動」是 Spring Boot 最大的優點，也是最大的陷阱。
> 會動的時候你很快樂，不會動的時候你完全不知道要從哪裡查——因為你從來沒看過它做了什麼。
> 這一章不寫太多程式，目的是先把**名詞地圖**與**啟動流程**弄清楚：
> Spring、Spring Boot、Spring MVC、Spring Cloud 到底誰是誰；`main()` 那一行 `SpringApplication.run()` 背後跑了什麼。
> 之後每一章我們都會回頭指著這張圖說「現在在講這一格」。

---

## 0.1 學習目標

完成本章後，你應該可以：

- 說出「沒有 Spring 的年代」寫一支 Web API 要處理哪些事，以及為什麼那些事該被框架吃掉。
- 精確區分 Spring Framework、Spring Boot、Spring MVC、Spring Data、Spring Cloud 的關係，不再混用。
- 說明 Spring Boot 的四根支柱：starter 依賴管理、自動組態、內嵌伺服器、可執行 jar。
- 用 `start.spring.io`（網頁 / curl / IDE）建立專案，並解釋每個產生出來的檔案為什麼存在。
- 把 `@SpringBootApplication` 拆成三個註解，說出各自負責什麼。
- 逐行讀懂 Spring Boot 的啟動日誌，並說出 `SpringApplication.run()` 的主要階段。
- 寫出第一個 REST 端點，用 `curl` 驗證，並用 Actuator 看到服務狀態。
- 遇到「port 被佔用」「找不到主類」「啟動變超慢」時知道從哪查起。

---

## 0.2 這一站在整條路線的位置

```
           01-java-core     語言 + JVM + 建置 + 測試（已完成）
                ↓
[你在這裡] 02-spring-boot   IoC / DI / 自動組態 / AOP / 設定 / 部署
                ↓
           03-rest-api      介面契約設計（不綁框架）
                ↓
           04 / 05 / 06     Controller / Service / Repository 三層
                ↓
           07 / 08          MySQL / JPA / MyBatis
                ↓
           09 / 10          Spring Security / 期末專題
```

這一站的定位很特別：**它不教你「怎麼寫業務功能」，它教你「你寫的東西為什麼會被執行」。**

後面 04～10 站會大量出現 `@RestController`、`@Service`、`@Transactional`、`@Cacheable`、`@PreAuthorize`。
這些註解沒有一個是 Java 語言的功能——它們全部是**由 Spring 容器在啟動時掃描、在執行時用代理攔截**才生效的。
你如果不知道這個機制，就會遇到經典的鬼故事：

| 症狀 | 真正原因 | 在本站哪一章 |
|---|---|---|
| `@Transactional` 加了但不會 rollback | 同類別自呼叫，沒有走過代理 | 第 04 章（AOP 與代理） |
| `@Async` 加了但還是同步執行 | 同上，而且忘了 `@EnableAsync` | 第 06 章 |
| 啟動報 `No qualifying bean of type ...` | 元件掃描沒掃到，或條件式 Bean 沒生效 | 第 01、02 章 |
| 有兩個實作，Spring 不知道要注入哪一個 | 沒用 `@Primary` / `@Qualifier` | 第 01 章 |
| 測試環境不小心連到正式資料庫 | Profile 沒切乾淨、設定優先序搞錯 | 第 03 章 |
| 加了 Redis 依賴，程式就自己去連 localhost:6379 然後啟動失敗 | 自動組態被觸發 | 第 02 章 |
| 每個測試都花 40 秒 | 全部掛 `@SpringBootTest`，context 無法快取 | 第 07 章 |
| 服務半夜掛掉，什麼線索都沒有 | 沒有結構化日誌、沒有 Actuator、沒有追蹤 ID | 第 05 章 |

**這一站就是在買下後面所有的除錯能力。**

### 練習專案：訂單服務的底座

從第 01 章開始，我們維護同一個專案 `demo/`（`shop-service`）。它會一路長大：

```
第 01 章  容器化改造：把手寫 new 的服務改成 Bean，付款方式用策略模式注入
第 02 章  抽出一個自訂 starter：稽核紀錄 auto-configuration
第 03 章  設定分環境：dev / test / staging / prod，密碼移出程式碼
第 04 章  加上稽核切面與計時切面，實測自呼叫失效
第 05 章  結構化 JSON 日誌 + 追蹤 ID + Actuator 指標
第 06 章  排程對帳任務 + 非同步寄信 + 領域事件
第 07 章  切片測試 vs 完整測試，context 快取實測
第 08 章  分層 Dockerfile、環境變數注入、優雅關閉
第 09 章  Spring Boot 2 → 3 遷移實作與雷點清單
```

到第 08 章結束時，`demo/` 會是一個**可以直接 `docker run` 起來、有健康檢查、有指標、有分環境設定**的服務骨架。
03～09 子課程的所有範例都會長在這個骨架上。

---

## 0.3 先看見痛：沒有 Spring 的一支 API

要理解框架的價值，最快的方式是**先寫一次沒有框架的版本**。

需求很單純：`GET /orders/{id}` 回傳一筆訂單的 JSON。

### 0.3.1 純 Servlet + JDBC 版本

```java
package com.example.legacy;

import jakarta.servlet.ServletException;
import jakarta.servlet.annotation.WebServlet;
import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import java.io.IOException;
import java.io.PrintWriter;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;

@WebServlet("/orders/*")
public class OrderServlet extends HttpServlet {

    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse resp)
            throws ServletException, IOException {

        // ① 自己從 URL 把 id 剖出來
        String path = req.getPathInfo();               // "/1001"
        if (path == null || path.length() <= 1) {
            resp.setStatus(400);
            resp.getWriter().write("{\"error\":\"missing id\"}");
            return;
        }
        long id;
        try {
            id = Long.parseLong(path.substring(1));    // ② 自己做型別轉換與錯誤處理
        } catch (NumberFormatException e) {
            resp.setStatus(400);
            resp.getWriter().write("{\"error\":\"id must be a number\"}");
            return;
        }

        Connection conn = null;
        try {
            // ③ 自己開連線——每次請求開一條，用完就丟
            conn = DriverManager.getConnection(
                    "jdbc:mysql://localhost:3306/shop", "root", "root");

            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT id, customer_name, amount, status FROM orders WHERE id = ?")) {
                ps.setLong(1, id);
                try (ResultSet rs = ps.executeQuery()) {
                    if (!rs.next()) {
                        resp.setStatus(404);
                        resp.getWriter().write("{\"error\":\"order not found\"}");
                        return;
                    }
                    // ④ 自己把 ResultSet 手動拼成 JSON 字串
                    resp.setStatus(200);
                    resp.setContentType("application/json;charset=UTF-8");
                    PrintWriter out = resp.getWriter();
                    out.write("{");
                    out.write("\"id\":" + rs.getLong("id") + ",");
                    out.write("\"customerName\":\"" + rs.getString("customer_name") + "\",");
                    out.write("\"amount\":" + rs.getBigDecimal("amount") + ",");
                    out.write("\"status\":\"" + rs.getString("status") + "\"");
                    out.write("}");
                }
            }
        } catch (SQLException e) {
            // ⑤ 自己決定錯誤格式，而且每支 Servlet 都各寫各的
            resp.setStatus(500);
            resp.getWriter().write("{\"error\":\"internal error\"}");
            e.printStackTrace();
        } finally {
            // ⑥ 自己關連線，忘了就洩漏
            if (conn != null) {
                try { conn.close(); } catch (SQLException ignored) { }
            }
        }
    }
}
```

再加上一份 `web.xml`（或至少一個容器來部署它），還要有一台裝好的 Tomcat，把 war 丟進 `webapps/`。

### 0.3.2 這段程式的實際代價

不是「不夠優雅」，是**它在生產環境會出事**：

| # | 問題 | 實際後果 |
|---|---|---|
| ① | 路由自己剖字串 | 多幾個端點就會出現 `/orders/1001/items` 剖錯的 bug |
| ② | 參數轉換與驗證手寫 | 每支 API 各寫一次，格式不一致，前端要處理 N 種錯誤形狀 |
| ③ | **每次請求開新連線** | 開連線要 TCP 三次握手 + MySQL 認證，約 5～30ms；流量一上來資料庫連線數瞬間爆掉 |
| ④ | **手拼 JSON** | `customer_name` 是 `王"小明"` 時 JSON 直接壞掉；金額用字串拼會掉精度 |
| ⑤ | 錯誤格式各寫各的 | 線上出事時 log 沒有請求 ID，無法把一次請求的所有 log 串起來 |
| ⑥ | 資源清理靠自律 | 少一個 `close()`，跑三天連線池耗盡，服務假死 |
| — | **完全無法單元測試** | 邏輯與 `HttpServletRequest`、`DriverManager` 綁死，測試要真的起 Tomcat 與 MySQL |
| — | 交易怎麼辦？ | 要跨兩張表寫入時，得自己 `conn.setAutoCommit(false)` / `commit()` / `rollback()`，並確保同一條連線傳遍所有方法 |

最後那兩點才是致命的。「把 `Connection` 一路當參數傳給每個方法」這件事，是 JDBC 時代最痛的地方：

```java
// JDBC 時代的真實寫法：Connection 汙染了所有方法簽章
public void placeOrder(Connection conn, Order order) throws SQLException {
    orderDao.insert(conn, order);          // 必須用同一條連線，交易才是同一個
    inventoryDao.decrease(conn, order);    // 少傳一次就變成兩個獨立交易
    couponDao.markUsed(conn, order);
}
```

> **真實案例**：某團隊的訂單服務就是這樣寫的。有位工程師在 `couponDao.markUsed()` 內部
> 「順手」用 `DriverManager.getConnection()` 另開了一條連線（因為他覺得傳參數很醜）。
> 結果是：訂單寫入失敗 rollback 時，**優惠券已經被標記使用且無法還原**。
> 客服每天處理十幾張「我的券不見了但訂單沒成立」的客訴，查了兩週才找到。
>
> 這個 bug 的根源不是那位工程師粗心，而是**架構把「交易邊界」交給人類自律**。
> Spring 的 `@Transactional` 之所以有價值，正是因為它把連線綁在執行緒上，讓「同一個交易」變成框架保證的事。

---

## 0.4 Spring Framework 解決了什麼

Spring（2003 年，Rod Johnson）當年的訴求就是「不要 EJB 那套重量級規格，也不要什麼都自己寫」。它提供三個核心能力：

### ① IoC 容器：物件的建立與組裝交給框架

你不再自己 `new`，而是**宣告依賴**，由容器組裝好交給你：

```java
// 沒有容器：自己 new，依賴寫死，無法替換
public class OrderService {
    private final OrderRepository repository = new JdbcOrderRepository();  // 綁死
    private final Notifier notifier = new EmailNotifier();                 // 綁死
}

// 有容器：宣告我需要什麼，怎麼來的不關我的事
public class OrderService {
    private final OrderRepository repository;
    private final Notifier notifier;

    public OrderService(OrderRepository repository, Notifier notifier) {
        this.repository = repository;
        this.notifier = notifier;
    }
}
```

第二種寫法讓「測試時換成假的 Repository」變成一行的事。這是第 01 章的主題。

### ② AOP：把橫切關注點抽出來

交易、日誌、權限、快取、重試——這些邏輯**每個方法都需要，但都不是業務邏輯本身**。
Spring 用動態代理把它們織進去：

```java
@Transactional          // 交易的 begin / commit / rollback 由代理處理
@Cacheable("orders")    // 快取的查詢與寫入由代理處理
public Order findById(long id) {
    return repository.findById(id);   // 你只寫這一行業務邏輯
}
```

代價是：**這些註解只有透過代理呼叫才會生效**。這正是第 04 章要講透的地方。

### ③ 一致的抽象層：把各家 API 的差異吃掉

```
你的程式碼   →  Spring 抽象      →  實作
─────────────────────────────────────────────
JdbcTemplate    DataAccessException   MySQL / PostgreSQL / Oracle
                （統一的例外階層）      各家 SQLException 錯誤碼不同
─────────────────────────────────────────────
CacheManager    Cache 介面           Redis / Caffeine / EhCache
─────────────────────────────────────────────
@Transactional  PlatformTransaction  JDBC / JPA / JTA
                Manager
```

換資料庫時，你的 `catch (DuplicateKeyException e)` 不用改——因為 Spring 把 MySQL 的
`SQLException(errorCode=1062)` 和 PostgreSQL 的 `SQLState=23505` 都翻譯成同一個例外。

---

## 0.5 Spring 還沒解決的：XML 地獄與版本地獄

Spring 2/3 的時代，上面那些好處要用**大量 XML** 換來：

```xml
<!-- applicationContext.xml：一個中型專案動輒 800 行 -->
<beans xmlns="http://www.springframework.org/schema/beans"
       xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
       xmlns:tx="http://www.springframework.org/schema/tx"
       xsi:schemaLocation="...">

    <bean id="dataSource" class="org.apache.commons.dbcp.BasicDataSource"
          destroy-method="close">
        <property name="driverClassName" value="com.mysql.jdbc.Driver"/>
        <property name="url" value="jdbc:mysql://localhost:3306/shop"/>
        <property name="username" value="root"/>
        <property name="password" value="root"/>
        <property name="maxActive" value="20"/>
    </bean>

    <bean id="transactionManager"
          class="org.springframework.jdbc.datasource.DataSourceTransactionManager">
        <property name="dataSource" ref="dataSource"/>
    </bean>

    <tx:annotation-driven transaction-manager="transactionManager"/>

    <bean id="orderRepository" class="com.example.JdbcOrderRepository">
        <property name="dataSource" ref="dataSource"/>
    </bean>

    <bean id="orderService" class="com.example.OrderService">
        <property name="repository" ref="orderRepository"/>
        <property name="notifier" ref="emailNotifier"/>
    </bean>
    <!-- ... 再來 700 行 ... -->
</beans>
```

問題有三層：

1. **XML 沒有型別檢查**：`class` 打錯字要等啟動才發現；重構改類別名，XML 不會跟著改。
2. **設定散在四五個檔案**：`web.xml`、`applicationContext.xml`、`spring-mvc.xml`、`spring-security.xml`、`log4j.xml`。
3. **版本地獄**：Spring 5.3 要搭哪個版本的 Jackson？Hibernate 5.6 要搭哪個 Validator？
   選錯就出現 `NoSuchMethodError`——這種錯誤只有執行到那一行才會爆。

再加上第四層：**部署要先有一台裝好、調好的 Tomcat**，開發環境與正式環境的容器版本、JVM 參數、`server.xml` 不一致，
造成「我機器上明明會動」的經典對話。

---

## 0.6 Spring Boot 的四根支柱

Spring Boot（2014）沒有發明新的 IoC 或 AOP——**它底下就是 Spring Framework**。
它做的是「把上面那些痛點一次處理掉」，靠四件事：

```
┌──────────────────────────────────────────────────────────┐
│                      Spring Boot                          │
│                                                           │
│  ① Starter 依賴管理     一行依賴 = 一整組相容的函式庫       │
│  ② 自動組態             有 X 在 classpath 就自動設定 X      │
│  ③ 內嵌伺服器           jar 裡就有 Tomcat，不用先裝容器      │
│  ④ 生產就緒功能         Actuator：健康檢查、指標、環境資訊    │
│                                                           │
│  ┌────────────────────────────────────────────────────┐  │
│  │              Spring Framework                       │  │
│  │   IoC 容器 / DI / AOP / 交易抽象 / MVC / 事件        │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### ① Starter：一行依賴解決一整組版本

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-web</artifactId>
</dependency>
```

注意**沒有寫版本號**。版本由父 POM（`spring-boot-starter-parent`）或 BOM 決定。
這一行實際上拉進來：

```
spring-boot-starter-web
├── spring-boot-starter                （核心：容器 + 自動組態 + 日誌）
│   ├── spring-boot
│   ├── spring-boot-autoconfigure
│   ├── spring-boot-starter-logging    → Logback + SLF4J
│   └── spring-core / spring-context
├── spring-boot-starter-json
│   └── jackson-databind / jackson-datatype-jsr310
├── spring-boot-starter-tomcat         → 內嵌 Tomcat
├── spring-web
└── spring-webmvc
```

用 `mvn dependency:tree` 可以親眼看到這棵樹：

```bash
mvn dependency:tree -Dincludes=org.springframework.boot
```

**這些版本是 Spring 團隊測過相容的組合**——這才是 starter 真正的價值，不是「少打幾行」。

### ② 自動組態：有東西就自動設定

`spring-boot-autoconfigure` 這個 jar 裡有一百多個 `XxxAutoConfiguration` 類別，每個都長這樣（簡化）：

```java
@AutoConfiguration
@ConditionalOnClass(DataSource.class)                  // classpath 有 DataSource 才生效
@ConditionalOnMissingBean(DataSource.class)            // 你自己沒定義才生效
@EnableConfigurationProperties(DataSourceProperties.class)
public class DataSourceAutoConfiguration {
    // 讀 spring.datasource.* 幫你建好 HikariCP 連線池
}
```

翻譯成白話：

> 「如果 classpath 上有 JDBC 相關類別，而且你自己沒有定義 `DataSource`，
> 那我就依照 `spring.datasource.*` 幫你建一個 HikariCP 連線池。」

**兩個關鍵性質**（第 02 章會拆到底）：

- **有條件**：不是全部都跑，是依 classpath 與設定決定。
- **讓位**：只要你自己定義了同型別的 Bean，自動組態就退開。**你永遠贏得了框架。**

### ③ 內嵌伺服器：jar 就是服務

```bash
java -jar shop-service.jar
```

這一行就是完整的部署。Tomcat 在 jar 裡面，版本由你的 `pom.xml` 鎖定，
所以「開發機 Tomcat 9、正式機 Tomcat 8.5」這種問題從此消失。

配合 Docker 就是：

```dockerfile
FROM eclipse-temurin:21-jre
COPY target/shop-service.jar /app.jar
ENTRYPOINT ["java","-jar","/app.jar"]
```

### ④ 生產就緒：Actuator

加一行依賴就有健康檢查、指標、環境資訊端點——這是 Kubernetes 存活/就緒探針、
Prometheus 抓指標的基礎。第 05 章會完整處理。

---

## 0.7 名詞地圖：誰是誰

這是初學者最容易講錯的地方，先釐清：

| 名稱 | 是什麼 | 關係 |
|---|---|---|
| **Spring Framework** | 核心框架：IoC 容器、AOP、事件、交易抽象、`spring-webmvc` | 所有東西的地基 |
| **Spring MVC** | Spring Framework **裡面的** Web 模組（`spring-webmvc`） | 是 Spring 的一部分，不是獨立產品 |
| **Spring Boot** | 建立在 Spring 之上的**啟動與組態層** | 用 Spring，不取代 Spring |
| **Spring Data JPA** | 資料存取的抽象（自動產生 Repository 實作） | 獨立專案，靠 Boot 自動組態接起來 |
| **Spring Security** | 認證授權框架（一整條 Filter 鏈） | 獨立專案 |
| **Spring Cloud** | 微服務工具集（設定中心、服務發現、閘道、熔斷） | 建立在 Boot 之上，**單體服務用不到** |
| **Spring WebFlux** | 響應式 Web 堆疊（Reactor + Netty） | 與 Spring MVC **並列的另一種選擇** |

三句話記住關係：

> **Spring Boot 不是新框架，是 Spring 的「開箱即用發行版」。**
> **Spring MVC 是 Spring 的 Web 模組，Spring Boot 只是幫你把它設定好。**
> **Spring Cloud 是微服務加值包，你在做單體服務時完全不需要。**

### 版本對應（重要）

| Spring Boot | Spring Framework | 最低 JDK | Jakarta 命名空間 |
|---|---|---|---|
| 2.7.x | 5.3.x | 8 | ❌ `javax.*`（已終止 OSS 支援） |
| 3.0 ～ 3.1 | 6.0 / 6.1 | **17** | ✅ `jakarta.*` |
| 3.2 ～ 3.4 | 6.1 / 6.2 | **17** | ✅ `jakarta.*` |
| 3.5.x | 6.2.x | **17** | ✅ `jakarta.*` |

> **本課基準：Spring Boot 3.x + JDK 21。**
> 用到 3.2 以後才有的功能（如 `RestClient`、虛擬執行緒開關）我會標註 `【Boot 3.2+】`。
> Spring Boot 2 → 3 的遷移雷點集中在第 09 章。
> Spring Boot 4 / Spring Framework 7 已經發布，主要方向是 API 版本控管、null-safety 標註與 HTTP 介面用戶端的強化；
> 但企業專案目前絕大多數仍在 3.x，本課以 3.x 為準，觀念完全可以平移。

---

## 0.8 建立第一個專案

三種方式，選一種就好。

### 方式 A：網頁 start.spring.io

打開 <https://start.spring.io>，填：

| 欄位 | 選擇 | 理由 |
|---|---|---|
| Project | Maven | 本課用 Maven（Gradle 對照見 01-java-core 第 10 章） |
| Language | Java | |
| Spring Boot | 3.x 最新的**非 SNAPSHOT** 版 | 不要選 M1/RC |
| Group | `com.example` | 公司網域反寫 |
| Artifact | `shop-service` | 專案名 |
| Packaging | **Jar** | 不要選 War，除非你被迫部署到外部容器 |
| Java | 21 | |
| Dependencies | Spring Web、Spring Boot Actuator、Lombok（選用） | 先加最小集合 |

> **提示**：右下角有個 `Explore` 按鈕，可以**先看產生出來的檔案內容再下載**。
> 還有 `Share...` 可以產生一個連結，把整份設定傳給同事。

### 方式 B：curl（可寫進腳本、可重現）

```bash
curl https://start.spring.io/starter.zip \
  -d type=maven-project \
  -d language=java \
  -d bootVersion=3.5.0 \
  -d groupId=com.example \
  -d artifactId=shop-service \
  -d name=shop-service \
  -d packageName=com.example.shop \
  -d packaging=jar \
  -d javaVersion=21 \
  -d dependencies=web,actuator \
  -o shop-service.zip

unzip shop-service.zip -d shop-service
cd shop-service
```

查有哪些 dependency 代號可用：

```bash
curl https://start.spring.io/metadata/client | jq '.dependencies.values[].values[].id' | head -40
# 或直接看人類可讀版本
curl https://start.spring.io
```

### 方式 C：IDE

- **IntelliJ IDEA**：`File → New → Project → Spring Boot`（Ultimate 版內建；Community 版可裝 Spring Initializr 外掛）。
- **VS Code**：裝 `Extension Pack for Java` + `Spring Boot Extension Pack`，
  然後 `Ctrl/Cmd+Shift+P` → `Spring Initializr: Create a Maven Project`。

### 第一次啟動

```bash
./mvnw spring-boot:run
```

第一次會下載很多依賴（大約 100～200 MB），耐心等。看到這行就成功了：

```
Started ShopServiceApplication in 1.632 seconds (process running for 1.914)
```

---

## 0.9 產生出來的專案結構，逐檔解剖

```
shop-service/
├── .mvn/wrapper/
│   ├── maven-wrapper.properties     ① 鎖定 Maven 版本
│   └── ...
├── mvnw                             ② Unix 的 Maven wrapper 腳本
├── mvnw.cmd                         ②' Windows 版
├── pom.xml                          ③ 依賴與建置設定
├── HELP.md                          （可刪）
└── src/
    ├── main/
    │   ├── java/com/example/shop/
    │   │   └── ShopServiceApplication.java   ④ 進入點
    │   └── resources/
    │       ├── application.properties        ⑤ 設定檔
    │       ├── static/                       ⑥ 靜態檔（css/js/圖）
    │       └── templates/                    ⑦ 樣板（Thymeleaf 等）
    └── test/
        └── java/com/example/shop/
            └── ShopServiceApplicationTests.java  ⑧ 冒煙測試
```

### ① ② Maven Wrapper：為什麼一定要用 `./mvnw`

`mvnw` 會讀 `maven-wrapper.properties` 裡指定的版本，自動下載對應的 Maven 再執行。

```properties
# .mvn/wrapper/maven-wrapper.properties
distributionUrl=https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.9/apache-maven-3.9.9-bin.zip
```

**價值**：你、同事、CI 三方跑的是同一個 Maven 版本。
新人 clone 下來不需要先安裝 Maven，`./mvnw` 就能建置。

> **實務規則**：專案內一律用 `./mvnw`，不要用 `mvn`。CI 腳本尤其如此。

### ③ `pom.xml`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0
                             https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <!-- ① 父 POM：帶來依賴版本管理 + 外掛設定 + 資源過濾規則 -->
    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>3.5.0</version>
        <relativePath/> <!-- 從遠端倉庫找，不要往上層目錄找 -->
    </parent>

    <groupId>com.example</groupId>
    <artifactId>shop-service</artifactId>
    <version>0.0.1-SNAPSHOT</version>
    <name>shop-service</name>
    <description>Demo project for Spring Boot</description>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencies>
        <!-- ② 注意：沒有 <version>，版本由 parent 決定 -->
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-actuator</artifactId>
        </dependency>

        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-test</artifactId>
            <scope>test</scope>   <!-- ③ 只在測試時可見，不會打包進 jar -->
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <!-- ④ 這個外掛才是「可執行 jar」的關鍵 -->
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
            </plugin>
        </plugins>
    </build>
</project>
```

**父 POM 帶來什麼**（用 `./mvnw help:effective-pom` 可以看到展開後的完整版）：

- `dependencyManagement`：三百多個常用函式庫的版本鎖定（Jackson、Hibernate、Netty、Kafka client…）。
- 外掛版本鎖定與預設設定（`maven-compiler-plugin` 的 `-parameters`、`maven-surefire-plugin` 設定）。
- 資源過濾：`application.properties` 裡可以用 `@project.version@` 取得 Maven 屬性。
- 預設編碼 UTF-8（省掉一堆亂碼問題）。

> **公司專案不想用 Spring 的 parent 怎麼辦？**（很常見，因為公司有自己的父 POM）
> 改用 BOM 匯入：
>
> ```xml
> <dependencyManagement>
>     <dependencies>
>         <dependency>
>             <groupId>org.springframework.boot</groupId>
>             <artifactId>spring-boot-dependencies</artifactId>
>             <version>3.5.0</version>
>             <type>pom</type>
>             <scope>import</scope>
>         </dependency>
>     </dependencies>
> </dependencyManagement>
> ```
>
> 差別是：版本管理有了，但**外掛設定與資源過濾沒有**，要自己補
> （尤其 `spring-boot-maven-plugin` 的 `repackage` goal 要手動綁定到 `package` 階段）。

### ④ 進入點

```java
package com.example.shop;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class ShopServiceApplication {

    public static void main(String[] args) {
        SpringApplication.run(ShopServiceApplication.class, args);
    }
}
```

它就是一個**普通的 Java 程式**——有 `main`，可以直接 `java -jar` 跑。這跟舊時代「部署到 Tomcat」是完全不同的模型。

### ⑤ `application.properties`

預設是空的。本課會**改用 YAML**（`application.yml`），因為階層結構清楚很多。第 03 章詳談。

### ⑥ ⑦ `static/` 與 `templates/`

- `static/`：放進去的檔案會直接以 `http://localhost:8080/檔名` 提供。
- `templates/`：伺服器端樣板引擎（Thymeleaf / FreeMarker）用的。**做純 API 的專案這兩個都可以刪掉。**

### ⑧ 冒煙測試

```java
@SpringBootTest
class ShopServiceApplicationTests {
    @Test
    void contextLoads() {
    }
}
```

方法體是空的，看起來很沒用，但它其實測了一件很重要的事：**整個 Spring 容器能不能成功啟動**。
Bean 少一個、設定打錯字、循環依賴——這個測試都會紅。**不要刪掉它。**

---

## 0.10 `@SpringBootApplication` 拆開來看

這一個註解等於三個：

```java
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
@Documented
@Inherited
@SpringBootConfiguration          // ①
@EnableAutoConfiguration          // ②
@ComponentScan(excludeFilters = { // ③
    @Filter(type = FilterType.CUSTOM, classes = TypeExcludeFilter.class),
    @Filter(type = FilterType.CUSTOM, classes = AutoConfigurationExcludeFilter.class) })
public @interface SpringBootApplication {
    // ...
}
```

### ① `@SpringBootConfiguration`

本質就是 `@Configuration`（所以這個類別本身也可以放 `@Bean` 方法），
但多了一個語意：**「我是這個應用程式的主要組態類別」**。
測試框架（`@SpringBootTest`、`@WebMvcTest`）會**從測試類別往上層套件搜尋**這個註解，來決定要載入哪個應用程式。

> 因此：**一個應用程式只能有一個 `@SpringBootConfiguration`。** 多一個，測試會直接報錯。

### ② `@EnableAutoConfiguration`

啟動自動組態機制。第 02 章整章都在講它。

### ③ `@ComponentScan`

**掃描範圍是「這個類別所在的套件，以及所有子套件」。** 這是最重要的一句話。

```
com.example.shop                 ← ShopServiceApplication 在這裡
├── controller/  ✅ 掃得到
├── service/     ✅ 掃得到
└── repository/  ✅ 掃得到

com.example.common               ← ❌ 掃不到！不在子套件下
com.other.util                   ← ❌ 掃不到
```

> **真實案例：新人最常見的第一個坑。**
> 有人把 `ShopServiceApplication` 從 `com.example.shop` 移到 `com.example.shop.config`，
> 「因為它是設定類別，放 config 比較整齊」。結果：`controller`、`service` 全部掃不到，
> 啟動成功但**所有 API 都回 404**，而且沒有任何錯誤訊息。查了半天才發現是套件位置問題。
>
> **規則**：`@SpringBootApplication` 的類別**永遠放在最上層套件（root package）**。

如果真的需要掃描別的套件（例如公司共用元件在 `com.example.common`）：

```java
@SpringBootApplication(scanBasePackages = {"com.example.shop", "com.example.common"})
public class ShopServiceApplication { }
```

但**更好的做法**是在共用元件那邊寫一個自動組態（第 02 章），讓使用方只要加依賴就好，不用改掃描設定。

---

## 0.11 `SpringApplication.run()` 到底做了什麼

這是本章的核心。把黑箱打開。

```
SpringApplication.run(ShopServiceApplication.class, args)
   │
   ├─ ① new SpringApplication(primarySources)
   │     ├─ 推斷應用程式型別（WebApplicationType）
   │     │    classpath 有 DispatcherServlet  → SERVLET
   │     │    classpath 只有 WebFlux          → REACTIVE
   │     │    兩個都沒有                       → NONE（純批次程式）
   │     ├─ 從 spring.factories 載入
   │     │    ApplicationContextInitializer / ApplicationListener
   │     └─ 推斷 main class（看 stack trace 找 main 方法）
   │
   └─ ② run(args)
         │
         ├─ 建立 StopWatch 開始計時
         ├─ 取得 SpringApplicationRunListeners → 發出 starting 事件
         ├─ ③ 準備 Environment
         │     ├─ 讀 系統屬性 / 環境變數 / 命令列參數
         │     ├─ 讀 application.yml / application-{profile}.yml
         │     ├─ 決定啟用的 profile
         │     └─ 發出 environmentPrepared 事件（設定此時已可用）
         │
         ├─ ④ 印出 Banner
         │
         ├─ ⑤ 建立 ApplicationContext（依 WebApplicationType）
         │     SERVLET → AnnotationConfigServletWebServerApplicationContext
         │
         ├─ ⑥ prepareContext
         │     ├─ 套用 ApplicationContextInitializer
         │     ├─ 註冊主類別為 Bean 定義
         │     └─ 發出 contextPrepared / contextLoaded 事件
         │
         ├─ ⑦ refreshContext ★ 真正的重頭戲 ★
         │     ├─ invokeBeanFactoryPostProcessors
         │     │     └─ ConfigurationClassPostProcessor
         │     │           ├─ 解析 @ComponentScan → 掃出你的 @Service / @Controller
         │     │           ├─ 解析 @Bean 方法
         │     │           └─ 解析 @Import → 觸發 自動組態 的載入與條件評估
         │     ├─ registerBeanPostProcessors（AOP 的代理就靠這些）
         │     ├─ initMessageSource / initApplicationEventMulticaster
         │     ├─ onRefresh ★ Web 應用在這裡建立並啟動內嵌 Tomcat ★
         │     ├─ finishBeanFactoryInitialization
         │     │     └─ 實例化所有非延遲的單例 Bean（依賴注入在此發生）
         │     └─ finishRefresh → 發出 ContextRefreshedEvent
         │
         ├─ ⑧ afterRefresh
         ├─ ⑨ 停止計時，印出 "Started ... in X seconds"
         ├─ ⑩ 發出 started 事件
         ├─ ⑪ callRunners → 執行 ApplicationRunner / CommandLineRunner
         └─ ⑫ 發出 ready 事件（ApplicationReadyEvent）
```

**幾個實務上真的會用到的重點：**

- **⑦ 的 `onRefresh` 才啟動 Tomcat**，而且是在「所有單例 Bean 建好」**之前**。
  所以 Tomcat 已在監聽 port，但你的 Bean 可能還沒好。這就是為什麼**「服務已啟動」要用
  `ApplicationReadyEvent`（⑫）判斷，不是 `ContextRefreshedEvent`**。
- **⑪ 的 Runner** 是「應用程式啟動後做一件事」的正規做法（例如載入快取、印出設定摘要）：

```java
@Component
public class WarmupRunner implements ApplicationRunner {
    private static final Logger log = LoggerFactory.getLogger(WarmupRunner.class);

    @Override
    public void run(ApplicationArguments args) {
        log.info("啟動參數：{}", args.getOptionNames());
        // 這裡跑的東西會「阻塞」啟動完成，時間太長會讓 K8s 探針誤判
    }
}
```

- **`ApplicationReadyEvent` 才是「可以開始接流量」的訊號**：

```java
@Component
public class ReadyListener {
    private static final Logger log = LoggerFactory.getLogger(ReadyListener.class);

    @EventListener(ApplicationReadyEvent.class)
    public void onReady() {
        log.info("服務就緒，可以開始接流量了");
    }
}
```

### 逐行讀懂啟動日誌

```
  .   ____          _            __ _ _
 /\\ / ___'_ __ _ _(_)_ __  __ _ \ \ \ \
( ( )\___ | '_ | '_| | '_ \/ _` | \ \ \ \
 \\/  ___)| |_)| | | | | || (_| |  ) ) ) )
  '  |____| .__|_| |_|_| |_\__, | / / / /
 =========|_|==============|___/=/_/_/_/
 :: Spring Boot ::                (v3.5.0)

2026-08-18T10:15:32.101+08:00  INFO 41287 --- [shop-service] [           main] c.e.shop.ShopServiceApplication          : Starting ShopServiceApplication using Java 21.0.5 with PID 41287 (/Users/dev/shop-service/target/classes started by dev in /Users/dev/shop-service)
2026-08-18T10:15:32.104+08:00  INFO 41287 --- [shop-service] [           main] c.e.shop.ShopServiceApplication          : No active profile set, falling back to 1 default profile: "default"
2026-08-18T10:15:32.812+08:00  INFO 41287 --- [shop-service] [           main] o.s.b.w.embedded.tomcat.TomcatWebServer  : Tomcat initialized with port 8080 (http)
2026-08-18T10:15:32.821+08:00  INFO 41287 --- [shop-service] [           main] o.apache.catalina.core.StandardService   : Starting service [Tomcat]
2026-08-18T10:15:32.822+08:00  INFO 41287 --- [shop-service] [           main] o.apache.catalina.core.StandardEngine    : Starting Servlet engine: [Apache Tomcat/10.1.x]
2026-08-18T10:15:32.867+08:00  INFO 41287 --- [shop-service] [           main] o.a.c.c.C.[Tomcat].[localhost].[/]       : Initializing Spring embedded WebApplicationContext
2026-08-18T10:15:32.868+08:00  INFO 41287 --- [shop-service] [           main] w.s.c.ServletWebServerApplicationContext : Root WebApplicationContext: initialization completed in 730 ms
2026-08-18T10:15:33.180+08:00  INFO 41287 --- [shop-service] [           main] o.s.b.a.e.web.EndpointLinksResolver      : Exposing 1 endpoint beneath base path '/actuator'
2026-08-18T10:15:33.245+08:00  INFO 41287 --- [shop-service] [           main] o.s.b.w.embedded.tomcat.TomcatWebServer  : Tomcat started on port 8080 (http) with context path '/'
2026-08-18T10:15:33.258+08:00  INFO 41287 --- [shop-service] [           main] c.e.shop.ShopServiceApplication          : Started ShopServiceApplication in 1.632 seconds (process running for 1.914)
```

| 訊息 | 對應到啟動流程的哪一步 | 你能從中知道什麼 |
|---|---|---|
| `Starting ... using Java 21.0.5 with PID 41287` | ② 開頭 | **JDK 版本**與 **PID**（要 `jstack` / `jmap` 時就用它） |
| `No active profile set, falling back to "default"` | ③ Environment | ⚠️ 正式環境看到這行代表 **profile 沒設**，通常是事故 |
| `Tomcat initialized with port 8080` | ⑦ onRefresh | 伺服器建立 |
| `Root WebApplicationContext: initialization completed in 730 ms` | ⑦ | 容器初始化耗時，**啟動變慢時先看這個數字** |
| `Exposing 1 endpoint beneath base path '/actuator'` | ⑦ | Actuator 開了幾個端點——**正式環境看到「Exposing 15 endpoints」要警覺** |
| `Tomcat started on port 8080` | ⑦ 尾端 | 開始監聽 |
| `Started ... in 1.632 seconds (process running for 1.914)` | ⑨ | 前者是 Spring 啟動時間，後者含 JVM 本身啟動 |

> **除錯技巧**：`1.632 seconds` 和 `1.914` 的差距是 JVM 啟動 + 類別載入。
> 如果這個差距很大（超過 1 秒），問題在 JVM 層（類別太多、沒開 CDS、磁碟慢）；
> 如果是 `Started ...` 的數字很大，問題在 Spring 層（Bean 太多、連線初始化慢、掃描範圍過寬）。

### 自訂 Banner（順手的小功能）

在 `src/main/resources/banner.txt` 放：

```
   _____ __                    _____                 _
  / ___// /_  ____  ____      / ___/___  ______   __(_)_______
  \__ \/ __ \/ __ \/ __ \     \__ \/ _ \/ ___/ | / / / ___/ _ \
 ___/ / / / / /_/ / /_/ /    ___/ /  __/ /   | |/ / / /__/  __/
/____/_/ /_/\____/ .___/    /____/\___/_/    |___/_/\___/\___/
                /_/
 版本：${application.version}    Spring Boot：${spring-boot.version}
 Profile：${spring.profiles.active}
```

`${application.version}` 需要 jar 的 `MANIFEST.MF` 有版本資訊（`spring-boot-maven-plugin` 打包時會加），
所以直接 `mvn spring-boot:run` 時會顯示空白，`java -jar` 時才有值。

關掉 banner：`spring.main.banner-mode=off`。

---

## 0.12 寫第一個端點

```java
package com.example.shop.web;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.math.BigDecimal;

@RestController
@RequestMapping("/orders")
public class OrderController {

    // 先寫死回傳值，第 01 章才會接上 Service
    @GetMapping("/{id}")
    public OrderResponse getOrder(@PathVariable long id) {
        return new OrderResponse(id, "王小明", new BigDecimal("1280.00"), "PAID");
    }

    // record 當 DTO 最省事（見 01-java-core 第 12 章）
    public record OrderResponse(long id, String customerName, BigDecimal amount, String status) { }
}
```

跟 0.3 的 Servlet 版本對照，Spring 幫你做掉了：

| Servlet 版本要自己做 | Spring Boot 版本 |
|---|---|
| 剖 URL 拿 id | `@PathVariable long id` — 連字串轉 long 都做好了 |
| id 不是數字時回 400 | 自動回 `400 Bad Request` |
| 設 `Content-Type` | 自動 `application/json` |
| 手拼 JSON 字串 | Jackson 自動序列化，跳脫字元、精度都正確 |
| 部署到 Tomcat | 內嵌，`java -jar` 就好 |

驗證：

```bash
$ curl -i http://localhost:8080/orders/1001
HTTP/1.1 200
Content-Type: application/json
Transfer-Encoding: chunked

{"id":1001,"customerName":"王小明","amount":1280.00,"status":"PAID"}

$ curl -i http://localhost:8080/orders/abc
HTTP/1.1 400
Content-Type: application/json

{"timestamp":"2026-08-18T02:31:07.418+00:00","status":400,"error":"Bad Request","path":"/orders/abc"}
```

> 那個預設的錯誤格式（`timestamp` / `status` / `error` / `path`）是 Spring Boot 的
> `DefaultErrorAttributes` 產生的。它**只適合開發階段**——正式 API 應該回一致的自訂格式。
> 這是 03-rest-api 第 04 章與 04-controller 第 03 章的主題。

### 用 REST Client 檔案取代 Postman

在專案根目錄放一個 `api.http`（IntelliJ 內建支援，VS Code 裝 `REST Client` 外掛）：

```http
### 查詢訂單
GET http://localhost:8080/orders/1001
Accept: application/json

### 錯誤路徑
GET http://localhost:8080/orders/abc

### 健康檢查
GET http://localhost:8080/actuator/health
```

**這個檔案可以 commit 進 Git**，比「大家各自的 Postman collection」好用太多。

---

## 0.13 開發體驗：DevTools 與 Actuator 初體驗

### DevTools：改完自動重啟

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-devtools</artifactId>
    <optional>true</optional>     <!-- 不要傳遞給依賴你的專案 -->
    <scope>runtime</scope>
</dependency>
```

原理很聰明：它用**兩個 ClassLoader**。

```
base ClassLoader     載入第三方 jar（不會變）      ← 重啟時保留
restart ClassLoader  載入你的 target/classes      ← 重啟時丟掉重建
```

所以「重啟」只需要重新載入你自己的類別，速度比冷啟動快好幾倍。

觸發方式：**編譯輸出改變時**。所以

- IntelliJ：`Build → Recompile`（或開 `Settings → Build → Compiler → Build project automatically`）。
- VS Code / Eclipse：存檔即編譯，改完就會重啟。

DevTools 還會**自動套用一組開發用的預設值**（快取全關，省得你改樣板沒反應）：

```properties
spring.thymeleaf.cache=false
spring.web.resources.cache.period=0
```

> ⚠️ **`spring-boot-devtools` 不會被打包進正式 jar**（`spring-boot-maven-plugin` 會排除它），
> 所以不用擔心帶到正式環境。但**還是要加 `<optional>true</optional>`**，
> 否則別的模組依賴你這個模組時會意外把它拉進去。

### Actuator：先看三個端點

`application.yml`：

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,info,env,beans,configprops,mappings,conditions
  endpoint:
    health:
      show-details: always
```

> ⚠️ 上面這組設定是**開發用**。第 05 章會講正式環境該怎麼收斂（只開 `health`、`info`、`prometheus`，
> 並且用獨立 port + Security 保護）。現在先開起來看，因為它們是最好的學習工具。

```bash
# 服務活著嗎
$ curl -s localhost:8080/actuator/health | jq
{
  "status": "UP",
  "components": {
    "diskSpace": { "status": "UP", "details": { "total": 494384795648, "free": 82301566976 } },
    "ping": { "status": "UP" }
  }
}

# 容器裡到底有哪些 Bean（第 01 章會用爆這個端點）
$ curl -s localhost:8080/actuator/beans | jq '.contexts.application.beans | keys | length'
187

# 所有 URL 對應到哪個方法（找不到 API 時的救命端點）
$ curl -s localhost:8080/actuator/mappings | jq -r \
    '.contexts.application.mappings.dispatcherServlets.dispatcherServlet[].details.requestMappingConditions.patterns[]?' \
    | sort -u
/actuator
/actuator/{path}
/orders/{id}
```

最後那個 `mappings` 端點特別有用：**「我的 API 回 404」時，先看它有沒有出現在這個清單裡**。
在清單裡 → 路徑打錯或方法不對；不在清單裡 → Controller 沒被掃到（回去看 0.10 的套件位置問題）。

---

## 0.14 常見錯誤與排查

### ① `Web server failed to start. Port 8080 was already in use.`

```
***************************
APPLICATION FAILED TO START
***************************

Description:
Web server failed to start. Port 8080 was already in use.

Action:
Identify and stop the process that's listening on port 8080 or configure this
application to listen on another port.
```

```bash
# macOS / Linux：找出誰佔用
lsof -i :8080
# 或
lsof -nP -iTCP:8080 -sTCP:LISTEN

kill -9 <PID>

# 或直接換 port 啟動
./mvnw spring-boot:run -Dspring-boot.run.arguments=--server.port=8081
java -jar target/shop-service.jar --server.port=8081

# 隨機 port（測試很好用）
server.port=0
```

> 最常見的原因是**上一次啟動沒關乾淨**（IDE 裡按了執行兩次）。

### ② `Unable to find a single main class from the following candidates`

```
Failed to execute goal org.springframework.boot:spring-boot-maven-plugin:repackage
(repackage) on project shop-service: Unable to find a single main class from the
following candidates [com.example.shop.ShopServiceApplication, com.example.shop.Tool]
```

專案裡有兩個 `main` 方法。指定一個：

```xml
<properties>
    <start-class>com.example.shop.ShopServiceApplication</start-class>
</properties>
```

### ③ `no main manifest attribute, in xxx.jar`

```bash
$ java -jar target/shop-service-0.0.1-SNAPSHOT.jar
no main manifest attribute, in target/shop-service-0.0.1-SNAPSHOT.jar
```

**你打包出來的是普通 jar，不是 Spring Boot 可執行 jar。** 原因通常是 `pom.xml` 少了：

```xml
<plugin>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-maven-plugin</artifactId>
</plugin>
```

驗證方式：

```bash
unzip -l target/shop-service-0.0.1-SNAPSHOT.jar | head -20
# 正確的 Spring Boot jar 會有：
#   BOOT-INF/classes/    ← 你的程式
#   BOOT-INF/lib/        ← 所有依賴 jar
#   org/springframework/boot/loader/   ← 啟動器

unzip -p target/shop-service-0.0.1-SNAPSHOT.jar META-INF/MANIFEST.MF
# Main-Class: org.springframework.boot.loader.launch.JarLauncher
# Start-Class: com.example.shop.ShopServiceApplication
```

### ④ 所有 API 都 404

依序檢查：

1. **Controller 有沒有被掃到**：`curl localhost:8080/actuator/beans | grep -i ordercontroller`
2. **套件位置**：Controller 是不是在 `@SpringBootApplication` 類別的子套件下？
3. **路徑對不對**：`curl localhost:8080/actuator/mappings`
4. **有沒有設 context path**：`server.servlet.context-path=/api` 的話要打 `/api/orders/1001`。

### ⑤ `UnsupportedClassVersionError`

```
java.lang.UnsupportedClassVersionError: com/example/shop/ShopServiceApplication
has been compiled by a more recent version of the Java Runtime (class file
version 65.0), but this version of the Java Runtime only recognizes class file
versions up to 61.0
```

編譯用 JDK 21（class 版本 65），執行用 JDK 17（61）。

| class 檔版本 | JDK |
|---|---|
| 52 | 8 |
| 61 | 17 |
| 65 | 21 |
| 69 | 25 |

```bash
java -version         # 執行用的
./mvnw -version       # Maven 用的（看 "Java version:" 那行）
echo $JAVA_HOME
```

### ⑥ 啟動突然變超慢

```bash
# 開啟啟動時間分析（Boot 3.x）
./mvnw spring-boot:run -Dspring-boot.run.jvmArguments="-Dspring.jmx.enabled=true"
```

更實用的是 `ApplicationStartup` 追蹤：

```java
public static void main(String[] args) {
    SpringApplication app = new SpringApplication(ShopServiceApplication.class);
    app.setApplicationStartup(new BufferingApplicationStartup(4096));
    app.run(args);
}
```

然後打 `/actuator/startup`（POST，只能取一次）：

```bash
curl -s -X POST localhost:8080/actuator/startup | jq \
  '[.timeline.events[] | {name: .startupStep.name, ms: (.duration | ltrimstr("PT") | rtrimstr("S") | tonumber * 1000 | floor)}] | sort_by(-.ms) | .[0:10]'
```

常見的慢因：

| 症狀 | 原因 |
|---|---|
| 卡在 `Bootstrapping Spring Data JPA repositories` | Repository 太多，可設 `spring.data.jpa.repositories.bootstrap-mode=deferred` |
| 卡在 `HikariPool-1 - Starting` | 資料庫連不上或很慢，檢查網路與 `connection-timeout` |
| 掃描階段很久 | `scanBasePackages` 設太寬（掃到 `com` 這種層級） |
| 每次啟動都在下載 | 網路問題，設 Maven mirror |

---

## 0.15 本章練習

### 練習 1：判斷名詞關係

以下說法哪些是錯的？錯在哪裡？

1. Spring Boot 取代了 Spring Framework。
2. 用 Spring Boot 就一定是微服務。
3. Spring MVC 是一個獨立於 Spring Framework 的專案。
4. Spring Boot 的自動組態是在編譯期產生程式碼。
5. `@SpringBootApplication` 會掃描整個 classpath 上的所有 `@Component`。

<details>
<summary>參考解答</summary>

| # | 對錯 | 說明 |
|---|---|---|
| 1 | ❌ 錯 | Spring Boot **建立在** Spring Framework 之上，底下的 IoC / AOP / MVC 全部都是 Spring Framework 的。Boot 只是加上 starter、自動組態、內嵌伺服器、Actuator |
| 2 | ❌ 錯 | Spring Boot 做**單體服務**再適合不過。微服務需要的是 Spring Cloud 那一套（設定中心、服務發現、閘道）。實務上絕大多數專案應該從模組化單體開始 |
| 3 | ❌ 錯 | Spring MVC 是 Spring Framework 內的 `spring-webmvc` 模組，不是獨立專案。獨立專案是 Spring Data、Spring Security、Spring Cloud 這些 |
| 4 | ❌ 錯 | 自動組態是**執行期**的：啟動時解析 `@Import`，評估 `@Conditional`，決定要不要註冊 Bean。（註：GraalVM native image 有 AOT 處理階段會把部分決策提前，但那是額外的最佳化，預設模型是執行期） |
| 5 | ❌ 錯 | 只掃描**主類別所在套件及其子套件**。這是新手最常踩的坑 |

</details>

### 練習 2：預測掃描結果

給定以下結構，哪些類別會被註冊成 Bean？

```
com.example
├── shop
│   ├── ShopServiceApplication.java     @SpringBootApplication
│   ├── web
│   │   └── OrderController.java        @RestController
│   └── service
│       └── OrderService.java           @Service
├── common
│   └── AuditLogger.java                @Component
└── util
    └── StringHelper.java               （沒有註解）
```

<details>
<summary>參考解答</summary>

| 類別 | 會不會成為 Bean | 原因 |
|---|---|---|
| `ShopServiceApplication` | ✅ | 它自己就是 `@Configuration`（透過 `@SpringBootConfiguration`） |
| `OrderController` | ✅ | 在 `com.example.shop.web`，是 `com.example.shop` 的子套件 |
| `OrderService` | ✅ | 同上 |
| `AuditLogger` | ❌ | 在 `com.example.common`，**不是 `com.example.shop` 的子套件** |
| `StringHelper` | ❌ | 沒有 stereotype 註解，而且套件也不對 |

**三種解法（由差到好）：**

```java
// 解法 A：擴大掃描範圍——能動，但把「掃描設定」變成使用方的責任
@SpringBootApplication(scanBasePackages = {"com.example.shop", "com.example.common"})

// 解法 B：在主類別直接宣告 @Bean——共用元件愈多愈難維護
@Bean
AuditLogger auditLogger() { return new AuditLogger(); }

// 解法 C（最好）：在 common 模組裡寫自動組態，使用方只要加依賴
// common 模組：
//   com/example/common/AuditAutoConfiguration.java  ← @AutoConfiguration + @Bean
//   META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports
//     內容：com.example.common.AuditAutoConfiguration
```

解法 C 就是第 02 章要做的事。

</details>

### 練習 3：讀啟動日誌

看到這段日誌，你能推論出哪些事？

```
2026-08-18T03:00:12.334Z  INFO 1 --- [shop-service] [main] c.e.shop.ShopServiceApplication : Starting ShopServiceApplication v1.4.2 using Java 17.0.9 with PID 1 (/app.jar started by root in /)
2026-08-18T03:00:12.338Z  INFO 1 --- [shop-service] [main] c.e.shop.ShopServiceApplication : No active profile set, falling back to 1 default profile: "default"
2026-08-18T03:00:19.881Z  INFO 1 --- [shop-service] [main] o.s.b.a.e.web.EndpointLinksResolver : Exposing 15 endpoints beneath base path '/actuator'
2026-08-18T03:00:20.114Z  INFO 1 --- [shop-service] [main] o.s.b.w.embedded.tomcat.TomcatWebServer : Tomcat started on port 8080 (http)
2026-08-18T03:00:20.156Z  INFO 1 --- [shop-service] [main] c.e.shop.ShopServiceApplication : Started ShopServiceApplication in 8.221 seconds
```

<details>
<summary>參考解答</summary>

可以讀出至少七件事：

1. **跑在容器裡**：`PID 1`、`/app.jar`、`started by root in /` — 這是典型的 Docker 容器特徵。
2. **用 root 執行**：⚠️ 安全問題。容器應該用非 root 使用者跑（第 08 章會處理）。
3. **版本 v1.4.2**：有版本號代表是 `java -jar` 跑打包後的 jar（`MANIFEST.MF` 有版本資訊）。
4. **JDK 17**：符合 Boot 3 最低要求，但不是 21。要用虛擬執行緒的話得先升版。
5. **⚠️ `No active profile set`**：正式環境**沒有設定 profile**。這是很嚴重的問題——
   代表它用的是 `application.yml` 的預設值，很可能連到開發用的資料庫，或用了不該有的預設密碼。
   應該用環境變數 `SPRING_PROFILES_ACTIVE=prod` 修正。
6. **⚠️ `Exposing 15 endpoints`**：Actuator 開太多端點。
   `/actuator/env` 會列出所有環境變數（含資料庫密碼、API key），`/actuator/heapdump` 可以下載整個記憶體映像。
   正式環境應該只開 `health`、`info`、`prometheus`，並且加上驗證。
7. **啟動花 8.2 秒**：偏慢。而且從 `12.338`（環境準備完）到 `19.881`（Actuator 完成）中間有 **7.5 秒**空白，
   要用 `/actuator/startup` 找出是誰花掉的（常見是資料庫連線池或 JPA Repository 掃描）。
   這對 K8s 的 `readinessProbe` `initialDelaySeconds` 設定有直接影響。

**這題想傳達的是：啟動日誌是免費的健康檢查報告，值得每次上線都看一眼。**

</details>

### 練習 4：動手做

1. 用 `curl` 方式建立一個 `shop-service` 專案（依賴：`web`、`actuator`）。
2. 把 `ShopServiceApplication` 從 `com.example.shop` 移到 `com.example.shop.boot`，
   重新啟動，**確認 `/orders/1001` 變成 404**，然後用 `/actuator/mappings` 證明它真的不在路由表裡。再改回來。
3. 加一個 `ApplicationRunner`，在裡面 `Thread.sleep(3000)`，觀察 `Started ... in X seconds` 的數字有沒有變。

<details>
<summary>參考解答</summary>

**第 2 題**：`/actuator/mappings` 裡會只剩 actuator 自己的路徑，`/orders/{id}` 消失。
`/actuator/beans` 裡也搜不到 `orderController`。這證明「掃描範圍 = 主類別所在套件及子套件」。

**第 3 題**：`Started ... in X seconds` 的數字**不會**因為 Runner 的 sleep 而變大。

原因回頭看 0.11 的流程：

```
⑨ 停止計時，印出 "Started ... in X seconds"
⑪ callRunners → 執行 ApplicationRunner
```

**計時在 ⑨ 就停了，Runner 在 ⑪ 才跑。**

但是——**`process running for Y` 這個數字會變大**（它是到 `run()` 完全結束為止），
而且**在 Runner 跑完之前，`ApplicationReadyEvent` 不會發出**。

實務啟示：如果你在 Runner 裡做很重的初始化（預熱快取、載入字典檔），
`Started in 1.6 seconds` 這個數字會**騙你**——服務其實還沒真的能用。
K8s 的 readiness 探針要打 `/actuator/health/readiness`（Boot 有內建的 readiness state），
而不是自己憑「啟動時間」猜。

</details>

---

## 0.16 驗收清單

- [ ] 我能說出「沒有 Spring 的 Servlet + JDBC」版本至少五個實際會出事的地方。
- [ ] 我能區分 Spring Framework / Spring Boot / Spring MVC / Spring Cloud，不會再說「Boot 取代了 Spring」。
- [ ] 我能說出 Spring Boot 的四根支柱，並解釋 starter 真正的價值是**版本相容性**而不是少打字。
- [ ] 我知道自動組態是**執行期**的、**有條件**的，而且**我自己定義的 Bean 一定贏**。
- [ ] 我能用 `curl` 或 IDE 建立專案，並解釋 `mvnw`、`spring-boot-starter-parent`、`spring-boot-maven-plugin` 各自的作用。
- [ ] 我能把 `@SpringBootApplication` 拆成三個註解並說出各自職責。
- [ ] 我知道 `@SpringBootApplication` 類別必須放在 root package，也知道放錯會出現什麼症狀。
- [ ] 我能說出 `SpringApplication.run()` 的主要階段，特別是「Tomcat 在 `onRefresh` 啟動」與「Runner 在計時停止後才跑」。
- [ ] 我知道要判斷「服務真的可以接流量」該用 `ApplicationReadyEvent`，不是 `Started in X seconds`。
- [ ] 我能從啟動日誌讀出 JDK 版本、PID、profile、Actuator 端點數量，並指出其中的風險。
- [ ] 我遇到 port 佔用、no main manifest attribute、全部 404 時，知道各自的排查步驟。
- [ ] 我知道 `/actuator/beans`、`/actuator/mappings`、`/actuator/conditions` 是後面幾章最重要的除錯工具。

---

完成後請前往 [01-ioc-di-and-bean-container.md](./01-ioc-di-and-bean-container.md)。
