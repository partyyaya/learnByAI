# 第 03 章：核心 API：商品、購物車、訂單查詢與報表

> 第 02 章結束時，19 張表建好了、24 個 CHECK 守著、10 萬張訂單的種子資料也躺在裡面。Entity 有了，但**它們全部是 package-private、沒有 setter、藏在 `internal` 裡** —— 沒有任何一個 HTTP 請求碰得到它們。
>
> **這一章要蓋 Entity 與 HTTP 之間的那一層，而且讓它「只洩漏你決定要給的東西」。**
>
> 這一章結束時，你手上會有：
>
> - **16 支 API**：商品的瀏覽與搜尋、賣家的商品管理、購物車、訂單查詢、以及用 MyBatis 寫的賣家日報表（3.3）。
> - **一個錯誤出口**：0.4.1 錯誤型別表裡的 12 種 Problem Details `type`（`email-unavailable` 在第 05 章補）變成一個 enum，每個模組的例外都對應到其中一種，而 `shared` **不依賴任何一個模組**（3.4）。
> - **驗收 Q4 變綠**：訂單列表一頁 5、20、45 筆，SQL 都是 **3 句**（3.6.3）。
> - 一份**由程式碼產生、而且被快照守著**的 OpenAPI 文件：任何一支 API 的形狀變了，`mvn test` 就紅，並指出哪一個 operation 變了（3.8）。
> - 8 個 MockMvc 測試，把 0.12.2 追溯表裡 PRD 與 CART 的那幾列填上（3.9）。

---

## 3.1 學習目標

完成本章後，你應該可以：

- 用 3.2.1 的四個數字（200 殘缺 JSON、500、22 / 102 句、11,969 個 Entity）說明**為什麼 Controller 不回傳 Entity**，以及 `open-in-view` 在這件事裡扮演的角色。
- 說出 `JOIN FETCH` 搭配分頁時 Hibernate 做了什麼（`HHH90003004`），並寫出「一頁固定 3 句 SQL」的查詢（3.6.2）。
- 說出錯誤回應**可以**放什麼、**不可以**放什麼，並寫出一個讓 `shared` 不依賴任何模組的全域例外處理器（3.4）。
- 說出為什麼角色檢查要放在 interceptor（或 Security filter），而不是 Controller 方法裡（3.4.4）。
- 用 DTO 擋住**大量指派**（mass assignment）：`sellerId`、`status` 為什麼不能出現在請求 DTO 裡（3.5.1）。
- 說出 JPA 三種 `LIKE` 寫法哪一種會跳脫萬用字元，並寫出自己的 `escapeLike`（3.5.4）。
- 說出 MySQL 的 CHECK 違反在 `JdbcTemplate` 裡會變成哪一個例外，以及怎麼辨認它（3.6.1）。
- 用「**邊界在 Java 算好、欄位上不套函式**」寫出依台北時間切日、又用得到索引的報表 SQL（3.7.1）。
- 說出 JPA 與 MyBatis 共用交易時的兩個陷阱（flush、MyBatis local cache），以及本專題的設定（3.7.2）。
- 讓 OpenAPI 文件正確描述 `Pageable` 與「不是參數的參數」，並用快照測試守住 API 契約（3.8）。
- 讓**驗收 Q4** 變綠。

---

## 3.2 先看見痛：API 層的 bug 會「成功」

### 3.2.0 實驗用的迷你應用程式

> 🔧 **前置條件**（本章的實驗與 `curl` 都需要）：
>
> ```bash
> docker compose up -d --wait                       # MySQL、Redis、RabbitMQ（0.10）
> mvn test -Pseed -Dtest=SeedData                   # 第 02 章的種子資料（2.8.2）；會先清空 shop 的資料表
> ```
>
> 本章的實驗類別（`D0`～`D6`、`D5`、`D5b`）都標了 `@Tag("experiment")`，預設的 `mvn test` 不會跑（2.11），要一個一個指名：
>
> ```bash
> mvn test -Pexperiments -Dtest=D1ReturnTheEntityTest
> mvn test -Pexperiments -Dtest='D5*'               # 3.7.2 的兩個（session 與 statement）
> ```
>
> 輸出的數字來自固定亂數種子的種子資料；你的毫秒數會不同，句數、筆數、天數應該一樣。

本章的前三個事故，都是「**大部分教學的寫法**」會碰到的。本專題的 Entity 刻意寫成 package-private、沒有 public getter —— 那樣的 Entity **根本沒辦法被直接回傳**（Jackson 看不到任何屬性）。
所以要重現事故，先寫一個「照教學寫」的迷你應用程式，放在 `com.example.lab.ch03`（2.2.0：實驗用的 Entity 不能放在 `com.example.shop` 底下），**直接讀 `shop` 資料庫裡第 02 章的種子資料**：

```java
package com.example.lab.ch03;

import com.fasterxml.jackson.annotation.JsonIgnore;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.autoconfigure.jackson.Jackson2ObjectMapperBuilderCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.core.env.Environment;

/**
 * 3.2.1 的實驗用迷你應用程式：「大部分教學的寫法」—— public Entity、public getter、雙向關聯、Controller 直接回傳 Entity。
 * 放在 com.example.lab 底下，不會被正式的 ShopApplication 掃到（2.2.0）。直接讀 shop 資料庫的種子資料（唯讀）。
 */
@SpringBootApplication
public class LabShopApp {

    /** lab.ignore-back-reference=true 時，等同在 LabOrderItem.getOrder() 上加 @JsonIgnore */
    abstract static class IgnoreOrder { @JsonIgnore abstract LabOrder getOrder(); }

    @Bean
    Jackson2ObjectMapperBuilderCustomizer backReference(Environment env) {
        return b -> { if (env.getProperty("lab.ignore-back-reference", Boolean.class, false)) b.mixIn(LabOrderItem.class, IgnoreOrder.class); };
    }
}
```

```java
package com.example.lab.ch03;

import jakarta.persistence.*;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

@Entity
@Table(name = "orders")
public class LabOrder {
    @Id Long id;
    String orderNo;
    long buyerId;
    long sellerId;
    String status;
    BigDecimal totalAmount;
    Instant createdAt;
    @Version int version;
    @OneToMany(mappedBy = "order")
    List<LabOrderItem> items = new ArrayList<>();

    public Long getId() { return id; }
    public String getOrderNo() { return orderNo; }
    public long getBuyerId() { return buyerId; }
    public long getSellerId() { return sellerId; }
    public String getStatus() { return status; }
    public BigDecimal getTotalAmount() { return totalAmount; }
    public Instant getCreatedAt() { return createdAt; }
    public int getVersion() { return version; }
    public List<LabOrderItem> getItems() { return items; }
}
```

```java
package com.example.lab.ch03;

import jakarta.persistence.*;

import java.math.BigDecimal;

@Entity
@Table(name = "order_items")
public class LabOrderItem {
    @Id Long id;
    @ManyToOne(fetch = FetchType.LAZY) @JoinColumn(name = "order_id")
    LabOrder order;
    long productId;
    String productName;
    BigDecimal unitPrice;
    int quantity;

    public Long getId() { return id; }
    public LabOrder getOrder() { return order; }
    public long getProductId() { return productId; }
    public String getProductName() { return productName; }
    public BigDecimal getUnitPrice() { return unitPrice; }
    public int getQuantity() { return quantity; }
}
```

```java
package com.example.lab.ch03;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

public interface LabOrderRepository extends JpaRepository<LabOrder, Long> {

    Page<LabOrder> findByBuyerIdOrderByCreatedAtDesc(long buyerId, Pageable pageable);

    /** 「N+1 的標準解法」：JOIN FETCH。加上分頁會怎樣？ */
    @Query(value = "select distinct o from LabOrder o join fetch o.items where o.buyerId = :buyerId order by o.createdAt desc",
           countQuery = "select count(o) from LabOrder o where o.buyerId = :buyerId")
    Page<LabOrder> findWithItems(long buyerId, Pageable pageable);
}
```

```java
package com.example.lab.ch03;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** 最常見的寫法：Controller 直接回傳 Entity（的 Page） */
@RestController
class LabOrderController {
    private final LabOrderRepository orders;
    LabOrderController(LabOrderRepository orders) { this.orders = orders; }

    @GetMapping("/lab/orders")
    Page<LabOrder> list(@RequestParam long buyerId, @RequestParam(defaultValue = "20") int size) {
        return orders.findByBuyerIdOrderByCreatedAtDesc(buyerId, PageRequest.of(0, size));
    }

    @GetMapping("/lab/orders-fetch-join")
    Page<LabOrder> fetchJoin(@RequestParam long buyerId, @RequestParam(defaultValue = "20") int size) {
        return orders.findWithItems(buyerId, PageRequest.of(0, size));
    }
}
```

**三個「看起來很正常」的地方**：public getter（IDE 一鍵產生）、`LabOrderItem.getOrder()`（雙向關聯，從明細也能找到訂單）、`Page<LabOrder>`（Spring Data 直接回傳）。

### 3.2.1 事故一：Controller 直接回傳 Entity ★★★

同一個請求 —— 最重度的買家 1001（2.8 的種子資料，3,000 張訂單）的第 1 頁 —— 在四種設定下各跑一次，並用 Hibernate 的 `Statistics` 數出**執行了幾句 SQL、載入了幾個 Entity**：

```java
package com.example.shop.ch03;

import com.example.lab.ch03.LabShopApp;
import jakarta.persistence.EntityManagerFactory;
import org.hibernate.SessionFactory;
import org.hibernate.stat.Statistics;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.context.WebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

/**
 * 3.2.1 Controller 直接回傳 Entity：四種設定，同一個請求（最重度的買家 1001，一頁 20 筆）。
 * 需要第 02 章的種子資料。
 */
@Tag("experiment")
class D1ReturnTheEntityTest {

    static final HttpClient HTTP = HttpClient.newHttpClient();

    static ConfigurableApplicationContext start(boolean openInView, boolean ignoreBackReference) {
        return new SpringApplicationBuilder(LabShopApp.class).run(
                "--server.port=0", "--spring.flyway.enabled=false", "--spring.jpa.hibernate.ddl-auto=none",
                "--spring.jpa.open-in-view=" + openInView, "--lab.ignore-back-reference=" + ignoreBackReference,
                "--spring.jpa.properties.hibernate.generate_statistics=true",
                "--spring.main.banner-mode=off", "--logging.level.root=OFF",
                "--logging.level.org.hibernate.orm.query=WARN",                                   // HHH90003004
                "--logging.level.org.springframework.web=WARN", "--logging.level.org.apache.catalina=WARN");    // 「寫 JSON 失敗」
    }

    static String jsonCheck(String body) {
        try {
            var f = com.fasterxml.jackson.core.JsonFactory.builder()
                    .streamReadConstraints(com.fasterxml.jackson.core.StreamReadConstraints.builder().maxNestingDepth(100_000).build()).build();
            new com.fasterxml.jackson.databind.ObjectMapper(f).readTree(body);
            return "合法的 JSON";
        } catch (Exception e) {
            return "不是合法的 JSON（" + e.getClass().getSimpleName() + "：" + e.getMessage().lines().findFirst().orElse("") + "）";
        }
    }

    static void call(ConfigurableApplicationContext ctx, String label, String path) throws Exception {
        int port = ((WebServerApplicationContext) ctx).getWebServer().getPort();
        Statistics stats = ctx.getBean(EntityManagerFactory.class).unwrap(SessionFactory.class).getStatistics();
        stats.clear();
        long t0 = System.nanoTime();
        String outcome;
        try {
            HttpResponse<String> r = HTTP.send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + path)).build(),
                    HttpResponse.BodyHandlers.ofString());
            String body = r.body();
            outcome = "HTTP %d，body %,d bytes，%s".formatted(r.statusCode(), body.length(), jsonCheck(body));
        } catch (Exception e) {
            outcome = "連線錯誤：" + e.getClass().getSimpleName() + " " + e.getMessage();
        }
        System.out.printf("  [%s] %s%n      SQL %,d 句、載入 Entity %,d 個、%,.0f ms%n", label, outcome,
                stats.getPrepareStatementCount(), stats.getEntityLoadCount(), (System.nanoTime() - t0) / 1e6);
    }

    @Test
    void returnTheEntity() throws Exception {
        System.out.println("═══ 3.2.1 Controller 直接回傳 Entity ═══");
        try (var ctx = start(true, false)) {
            call(ctx, "① 雙向關聯、open-in-view=true（Boot 預設）", "/lab/orders?buyerId=1001&size=20");
        }
        try (var ctx = start(false, true)) {
            call(ctx, "② 反向關聯加 @JsonIgnore、open-in-view=false", "/lab/orders?buyerId=1001&size=20");
        }
        try (var ctx = start(true, true)) {
            call(ctx, "③ 反向關聯加 @JsonIgnore、open-in-view=true，size=20", "/lab/orders?buyerId=1001&size=20");
            call(ctx, "③ 同上，size=100", "/lab/orders?buyerId=1001&size=100");
            call(ctx, "④ 改用 JOIN FETCH，size=20", "/lab/orders-fetch-join?buyerId=1001&size=20");
        }
    }
}
```

**輸出**（Spring 與 Hibernate 的 WARN 日誌保留，時間戳與執行緒名省略）：

```
═══ 3.2.1 Controller 直接回傳 Entity ═══
WARN  DefaultHandlerExceptionResolver : Ignoring exception, response committed already: org.springframework.http.converter.HttpMessageNotWritableException: Could not write JSON: Infinite recursion (StackOverflowError)
WARN  DefaultHandlerExceptionResolver : Resolved [org.springframework.http.converter.HttpMessageNotWritableException: Could not write JSON: Infinite recursion (StackOverflowError)]
  [① 雙向關聯、open-in-view=true（Boot 預設）] HTTP 200，body 234,965 bytes，不是合法的 JSON（JsonParseException：Unexpected character ('}' (code 125)): was expecting a colon to separate field name and value）
      SQL 3 句、載入 Entity 23 個、233 ms
WARN  DefaultHandlerExceptionResolver : Resolved [org.springframework.http.converter.HttpMessageNotWritableException: Could not write JSON: failed to lazily initialize a collection of role: com.example.lab.ch03.LabOrder.items: could not initialize proxy - no Session]
  [② 反向關聯加 @JsonIgnore、open-in-view=false] HTTP 500，body 111 bytes，合法的 JSON
      SQL 2 句、載入 Entity 20 個、52 ms
  [③ 反向關聯加 @JsonIgnore、open-in-view=true，size=20] HTTP 200，body 8,623 bytes，合法的 JSON
      SQL 22 句、載入 Entity 74 個、53 ms
  [③ 同上，size=100] HTTP 200，body 44,123 bytes，合法的 JSON
      SQL 102 句、載入 Entity 399 個、117 ms
WARN  org.hibernate.orm.query : HHH90003004: firstResult/maxResults specified with collection fetch; applying in memory
  [④ 改用 JOIN FETCH，size=20] HTTP 200，body 8,623 bytes，合法的 JSON
      SQL 2 句、載入 Entity 11,969 個、203 ms
```

（跑了三次：① 的 body 長度在 232,925～235,164 bytes 之間 —— 每次在不同的位置被截斷；其餘的句數與 Entity 數三次都一樣。）

**① 雙向關聯：HTTP 200，但 JSON 是壞的。**

Jackson 序列化 `LabOrder` → `items` → 每一個 `LabOrderItem` → `getOrder()` → 又是那張 `LabOrder` → `items` → …… 無限遞迴，直到 `StackOverflowError`。

這不意外。**意外的是 HTTP 狀態碼是 200。** 看第一行 WARN：`Ignoring exception, response committed already`。

Jackson 是**串流**寫出 JSON 的：它一邊序列化、一邊把位元組寫進回應。Tomcat 的回應緩衝區預設 8 KB，**寫滿第一個 8 KB 的那一刻，200 的狀態碼和 header 就已經送出去了**（response committed）。
之後 `StackOverflowError` 才發生 —— 這時候 Spring 想回 500 也來不及了，只能在日誌裡寫一行「忽略這個例外」，然後關掉連線。

客戶端看到的是：**HTTP 200、`Content-Type: application/json`、一個在 23 萬 bytes 處被硬生生收尾的字串**。
它不是單純被截斷：Jackson 出錯時會自動補上還沒關閉的 `}`、`]`（`JsonGenerator` 的 auto-close），所以結尾剛好落在一個欄位名稱後面 —— 上面的輸出就是 `Unexpected character ('}' (code 125)): was expecting a colon`。
前端的 `fetch()` 會成功，`response.json()` 才會失敗 —— 錯誤是一個發生在第 23 萬個字元附近的**語法錯誤**，**跟後端的任何日誌都對不上**。監控上，這個請求是一個成功的 200。

**② 加上 `@JsonIgnore`、關掉 open-in-view：500。**

遞迴斷了，但 `items` 是 LAZY 的。Repository 方法結束時交易結束、Hibernate Session 關閉；Jackson 在**交易之外**序列化時才去碰 `items` —— `LazyInitializationException: could not initialize proxy - no Session`。

**③ 打開 open-in-view：能動了 —— 然後是 N+1。**

open-in-view（OSIV）的意思是：**Session 從請求進來開到回應寫完**，所以 Jackson 序列化時還能 lazy load。結果：

```
size=20  → 1（訂單）+ 1（總數）+ 20（每張訂單的明細各一句） = 22 句
size=100 → 1 + 1 + 100                                  = 102 句
```

**SQL 句數跟頁面大小成正比。** 這就是 N+1，而且它發生在 **Jackson 裡** —— 你在 Service、Repository 的程式碼裡找不到任何一行在查明細。
第 02 章把 `open-in-view: false` 寫進 `application.yml`，就是為了讓這件事**不可能默默發生**：要嘛你在交易裡明確地載入，要嘛 ② 的 500 會直接告訴你。

Spring Boot 自己也知道這個預設值有問題 —— 沒有設定 `spring.jpa.open-in-view` 時，啟動日誌會印出（`D0OsivWarningTest`，用 `--spring.config.name=no-such-config` 讓它不讀任何 `application.yml`，資料庫連線改由命令列給；完整內容在 3.10.1）：

```
WARN  JpaBaseConfiguration$JpaWebConfiguration : spring.jpa.open-in-view is enabled by default. Therefore, database queries may be performed during view rendering. Explicitly configure spring.jpa.open-in-view to disable this warning
```

**④ 「N+1 的標準解法」`JOIN FETCH`：2 句 SQL，11,969 個 Entity。**

SQL 從 22 句變成 2 句，看起來完美。但看「載入 Entity」那一欄：**11,969** —— 這位買家的 **3,000 張訂單 + 8,969 個明細，全部**。

那一行 WARN 說明了原因：`HHH90003004: firstResult/maxResults specified with collection fetch; applying in memory`。
`JOIN FETCH` 一個集合時，SQL 的每一列是「一張訂單 × 一個明細」—— 在 SQL 上 `LIMIT 20` 會切掉某張訂單的一部分明細。
Hibernate 的選擇是：**不在 SQL 上分頁，把所有列讀回來，在記憶體裡取前 20 張**。

在這位買家身上，它是 203 ms 和幾 MB 的記憶體。**在一個會掃過 10 萬張訂單的管理員查詢上，它是幾十萬個 Entity —— 在 0.6.2 的 `-Xmx512m` 底下，很可能就是 OOM。** 而且那只是一行 WARN。

**四種寫法，四種失敗：**

| | HTTP | SQL | 載入的 Entity | 真正的問題 |
|---|---|---|---|---|
| ① 雙向關聯 | **200** | 3 | 23 | 回應在出錯前就送出了，**客戶端收到殘缺的 JSON** |
| ② + `@JsonIgnore`、OSIV 關 | 500 | 2 | 20 | lazy 集合在交易外被碰 |
| ③ + `@JsonIgnore`、OSIV 開 | 200 | **22 / 102** | 74 / 399 | N+1，而且藏在 Jackson 裡 |
| ④ `JOIN FETCH` | 200 | 2 | **11,969** | 在記憶體裡分頁 |

**而且四種都把 Entity 的每一個 getter 變成了 API**：`buyerId`、`sellerId`、`version`、內部的 `id` 全部出現在 JSON 裡 —— 0.6.7 說過「不對外暴露內部 id」。
下一次有人在 Entity 上加一個 `getInternalNote()`，它就自動變成了一個公開欄位。

> 📌 **這一節要帶走的**：Controller 回傳的東西，是一份**跟前端的契約**。Entity 是**跟資料庫的契約**。兩者綁在一起，任何一邊的變動都會默默改掉另一邊。
> 本章的每一支 API 都回傳自己的 DTO（3.5.1），而且在**交易之內**把 DTO 組好 —— OSIV 關著，Jackson 只看得到已經完全載入的 record。3.6.2 會寫出「一頁固定 3 句」的版本。

### 3.2.2 事故二：「好心」的錯誤訊息 ★★★

前端工程師抱怨：「後端錯誤只回 `Internal Server Error`，我們不知道發生什麼事。」後端工程師加了一個全域處理器，把例外訊息放進回應 —— **完全出於好意**：

```java
package com.example.lab.ch03;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/**
 * 「前端說看不到錯誤原因，所以把例外訊息放進 detail」—— 一個很常見、而且出於好意的寫法。
 * lab.leaky-errors=true 時才生效。
 */
@RestControllerAdvice
@ConditionalOnProperty("lab.leaky-errors")
class LeakyExceptionHandler {

    @ExceptionHandler(Exception.class)
    ProblemDetail handle(Exception e) {
        return ProblemDetail.forStatusAndDetail(HttpStatus.INTERNAL_SERVER_ERROR, e.getMessage());
    }
}
```

用三個會出錯的請求比較三種處理方式：Spring Boot 預設（沒有任何 `@RestControllerAdvice`）、上面這個「好心」的處理器、以及本專題 3.4 的 `GlobalExceptionHandler`。
迷你應用程式多了兩支 API：

```java
package com.example.lab.ch03;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.web.bind.annotation.*;

import java.math.BigDecimal;

/** 3.2.2 的三種錯誤：排序欄位不存在、資料庫約束、JSON 型別錯誤 */
@RestController
class LabErrorController {
    private final LabProductRepository products;
    private final LabOrderItemRepository items;
    LabErrorController(LabProductRepository products, LabOrderItemRepository items) { this.products = products; this.items = items; }

    @GetMapping("/lab/products")
    Page<LabProduct> list(Pageable pageable) { return products.findAll(pageable); }

    record NewItem(long id, long orderId, long productId, String productName, BigDecimal unitPrice, int quantity) {}

    @PostMapping("/lab/order-items")
    String add(@RequestBody NewItem req) {
        items.insert(req.id(), req.orderId(), req.productId(), req.productName(), req.unitPrice(), req.quantity());
        return "ok";
    }
}
```

（它用到的 `LabProduct` 與 `LabOrderItemRepository` 完整內容在 3.10.1。`insert` 是一句原生 SQL，要同時有 `@Modifying` 與 `@Transactional` —— 少了 `@Transactional`，你看到的會是 `TransactionRequiredException`，而不是下面 ② 的外鍵錯誤。）

```java
package com.example.shop.ch03;

import com.example.lab.ch03.LabShopApp;
import com.example.shop.ShopApplication;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.context.WebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

/** 3.2.2 同樣三個出錯的請求，三種錯誤處理：Boot 預設、「好心」的 getMessage()、本專題的 GlobalExceptionHandler */
@Tag("experiment")
class D2ErrorMessageLeakTest {

    static final HttpClient HTTP = HttpClient.newHttpClient();

    static ConfigurableApplicationContext lab(boolean leaky) {
        return new SpringApplicationBuilder(LabShopApp.class).run("--server.port=0", "--spring.flyway.enabled=false",
                "--spring.jpa.hibernate.ddl-auto=none", "--lab.leaky-errors=" + leaky,
                "--spring.main.banner-mode=off", "--logging.level.root=OFF");
    }

    static void send(ConfigurableApplicationContext ctx, String label, String method, String path, String json) throws Exception {
        int port = ((WebServerApplicationContext) ctx).getWebServer().getPort();
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
                .header("Content-Type", "application/json").header("X-Debug-User-Id", "2").header("X-Debug-Roles", "SELLER");
        b = json == null ? b.GET() : b.method(method, HttpRequest.BodyPublishers.ofString(json));
        HttpResponse<String> r = HTTP.send(b.build(), HttpResponse.BodyHandlers.ofString());
        System.out.printf("  %-26s HTTP %d  %s%n", label, r.statusCode(), r.body());
    }

    static final String BAD_FK = """
            {"id": 9000001, "orderId": 424242, "productId": 1, "productName": "x", "unitPrice": 100, "quantity": 1}""";
    static final String BAD_TYPE = """
            {"name": "耳機", "price": "一百元", "categoryId": 11, "initialStock": 1}""";

    @Test
    void errorMessageLeak() throws Exception {
        System.out.println("═══ 3.2.2 錯誤回應裡有什麼 ═══");
        for (boolean leaky : new boolean[]{false, true}) {
            System.out.println(leaky ? "── 「好心」的處理器：detail = e.getMessage() ──" : "── Spring Boot 預設（沒有任何 @RestControllerAdvice）──");
            try (var ctx = lab(leaky)) {
                send(ctx, "① 排序欄位不存在", "GET", "/lab/products?sort=sellerPassword,asc", null);
                send(ctx, "② 資料庫擋下（外鍵）", "POST", "/lab/order-items", BAD_FK);
                send(ctx, "③ JSON 型別不對", "POST", "/lab/order-items", BAD_TYPE.replace("\"price\"", "\"unitPrice\""));
            }
        }
        System.out.println("── 本專題（GlobalExceptionHandler）──");
        try (var ctx = new SpringApplicationBuilder(ShopApplication.class).run("--server.port=0",
                "--spring.main.banner-mode=off", "--logging.level.root=OFF")) {
            send(ctx, "① 排序欄位不存在", "GET", "/api/products?sort=sellerPassword,asc", null);
            send(ctx, "③ JSON 型別不對", "POST", "/api/seller/products", BAD_TYPE);
        }
    }
}
```

**輸出**：

```
═══ 3.2.2 錯誤回應裡有什麼 ═══
── Spring Boot 預設（沒有任何 @RestControllerAdvice）──
  ① 排序欄位不存在        HTTP 500  {"timestamp":"2026-09-29T10:20:23.281+00:00","status":500,"error":"Internal Server Error","path":"/lab/products"}
  ② 資料庫擋下（外鍵）    HTTP 500  {"timestamp":"2026-09-29T10:20:23.396+00:00","status":500,"error":"Internal Server Error","path":"/lab/order-items"}
  ③ JSON 型別不對         HTTP 400  {"timestamp":"2026-09-29T10:20:23.404+00:00","status":400,"error":"Bad Request","path":"/lab/order-items"}
── 「好心」的處理器：detail = e.getMessage() ──
  ① 排序欄位不存在        HTTP 500  {"type":"about:blank","title":"Internal Server Error","status":500,"detail":"No property 'sellerPassword' found for type 'LabProduct'","instance":"/lab/products"}
  ② 資料庫擋下（外鍵）    HTTP 500  {"type":"about:blank","title":"Internal Server Error","status":500,"detail":"JDBC exception executing SQL [insert into order_items (id, order_id, product_id, product_name, unit_price, quantity) values (?, ?, ?, ?, ?, ?)] [Cannot add or update a child row: a foreign key constraint fails (`shop`.`order_items`, CONSTRAINT `fk_order_items_order` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`))] [n/a]; SQL [n/a]; constraint [null]","instance":"/lab/order-items"}
  ③ JSON 型別不對         HTTP 500  {"type":"about:blank","title":"Internal Server Error","status":500,"detail":"JSON parse error: Cannot deserialize value of type `java.math.BigDecimal` from String \"一百元\": not a valid representation","instance":"/lab/order-items"}
── 本專題（GlobalExceptionHandler）──
  ① 排序欄位不存在        HTTP 400  {"type":"/problems/validation","title":"請求內容不正確","status":400,"detail":"不支援的排序欄位","instance":"/api/products","errors":[{"field":"sort","message":"可用的排序欄位：createdAt、price、name"}]}
  ③ JSON 型別不對         HTTP 400  {"type":"/problems/validation","title":"請求內容不正確","status":400,"detail":"請求內容無法解析（JSON 格式或欄位型別不正確）","instance":"/api/seller/products"}
```

**看「好心」版的 ②，一句一句數它送出了什麼：**

| 洩漏了什麼 | 攻擊者拿它做什麼 |
|---|---|
| `insert into order_items (id, order_id, product_id, product_name, unit_price, quantity)` | 完整的欄位清單 —— SQL injection 時不用猜欄位名 |
| `` `shop`.`order_items` `` | 資料庫名與表名 |
| `` CONSTRAINT `fk_order_items_order` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) `` | 表之間的關係 |
| `JDBC exception executing SQL` | 用的是 JDBC / Hibernate（Java 後端） |

① 洩漏了 **Entity 的類別名** `LabProduct` —— 以及「`sellerPassword` 這個屬性不存在」這個事實（試幾次就能列舉出所有存在的屬性名）。
③ 洩漏了 `java.math.BigDecimal`。

0.6.5 的要求是「錯誤回應**不含**堆疊、類別名、SQL、內部 id 格式」。**這個處理器一次違反了三條。**

**「好心」版還有第二個問題：狀態碼。** ③ 是**客戶端**送錯了格式，應該是 400 —— Boot 預設版是對的。
但「好心」處理器接了 `Exception.class`，**把所有例外都變成 500**。前端的錯誤處理邏輯通常是「4xx 顯示給使用者、5xx 顯示『系統忙碌』並重試」—— 這個處理器讓使用者的格式錯誤變成了**無限重試**。

**Boot 預設版呢？** 它是安全的（什麼都不說），但**它說錯了狀態**：① 是客戶端送了一個不存在的排序欄位，應該是 400（US-PRD-2 AC-3），它回 500。
前端工程師的抱怨也是對的 —— `Internal Server Error` 對任何人都沒有幫助。

**本專題的版本**做了三件事：狀態碼對（400）、`type` 可以被程式判斷（`/problems/validation`）、`errors[]` 指出**哪個欄位**有什麼問題 —— 而且這兩個回應裡**沒有任何一個字來自例外的原始訊息**。3.4 會說它怎麼做到，以及它**還沒做到**的那一種情況（綁定失敗的欄位，3.4.3）。

> 📌 那 ② 在本專題裡會怎樣？本專題的 Service 在寫入之前就會檢查（3.5.3：分類不存在 → 400 `field: categoryId`），所以資料庫的外鍵錯誤**只有在 bug 的時候**才會出現。
> 出現時，`GlobalExceptionHandler` 回 `500 /problems/internal`「系統發生錯誤」—— **完整的例外只進日誌**，不進回應。

### 3.2.3 事故三：搜尋框輸入一個 `%` ★★

US-PRD-2 AC-4：「`q=%` 或 `q=_` 視為字面字元搜尋，**不是萬用字元**」。

「關鍵字搜尋商品名稱」在 Spring Data JPA 有三種常見寫法。迷你應用程式各寫一個：

```java
package com.example.lab.ch03;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.JpaSpecificationExecutor;
import org.springframework.data.jpa.repository.Query;

public interface LabProductRepository extends JpaRepository<LabProduct, Long>, JpaSpecificationExecutor<LabProduct> {

    /** 寫法一：衍生查詢 */
    Page<LabProduct> findByStatusAndNameContaining(String status, String keyword, Pageable pageable);

    /** 寫法二：@Query 裡的 %:keyword% */
    @Query("select p from LabProduct p where p.status = 'ON_SALE' and p.name like %:keyword%")
    Page<LabProduct> searchByQuery(String keyword, Pageable pageable);
}
```

第三種是 `JpaSpecificationExecutor` 的 Criteria 寫法 —— 本專題的搜尋有 4 個可選條件（關鍵字、分類、價格上下限），動態組條件最自然的就是它：

```java
package com.example.shop.ch03;

import com.example.lab.ch03.LabProduct;
import com.example.lab.ch03.LabProductRepository;
import com.example.lab.ch03.LabShopApp;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.jpa.domain.Specification;

import java.util.function.Function;

/** 3.2.3 搜尋框輸入 % 或 _：三種常見寫法各會怎樣（1 萬個商品的種子資料） */
@Tag("experiment")
class D3LikeWildcardTest {

    @Test
    void likeWildcards() {
        try (var ctx = new SpringApplicationBuilder(LabShopApp.class).web(WebApplicationType.NONE).run(
                "--spring.flyway.enabled=false", "--spring.jpa.hibernate.ddl-auto=none", "--spring.main.banner-mode=off", "--logging.level.root=OFF")) {
            LabProductRepository repo = ctx.getBean(LabProductRepository.class);
            PageRequest page = PageRequest.of(0, 20);
            Function<String, Page<LabProduct>> derived = q -> repo.findByStatusAndNameContaining("ON_SALE", q, page);
            Function<String, Page<LabProduct>> atQuery = q -> repo.searchByQuery(q, page);
            Function<String, Page<LabProduct>> criteria = q -> repo.findAll((Specification<LabProduct>) (root, cq, cb) -> cb.and(
                    cb.equal(root.get("status"), "ON_SALE"), cb.like(root.get("name"), "%" + q + "%")), page);
            System.out.println("═══ 3.2.3 搜尋框輸入特殊字元（ON_SALE 商品共 " + derived.apply("").getTotalElements() + " 個）═══");
            System.out.printf("  %-10s %-24s %-24s %-24s%n", "關鍵字", "衍生查詢 Containing", "@Query like %:q%", "Criteria cb.like");
            for (String q : new String[]{"耳機", "%", "_", "100%", "#1_"}) {
                System.out.printf("  %-12s %-26s %-26s %-26s%n", "\"" + q + "\"",
                        run(derived, q), run(atQuery, q), run(criteria, q));
            }
        }
    }

    static String run(Function<String, Page<LabProduct>> f, String q) {
        long t0 = System.nanoTime();
        long n = f.apply(q).getTotalElements();
        return "%,6d 筆（%.1f ms）".formatted(n, (System.nanoTime() - t0) / 1e6);
    }
}
```

**輸出**（第 02 章的種子資料，上架商品 9,486 個）：

```
═══ 3.2.3 搜尋框輸入特殊字元（ON_SALE 商品共 9486 個）═══
  關鍵字      衍生查詢 Containing      @Query like %:q%        Criteria cb.like
  "耳機"        839 筆（12.0 ms）        839 筆（13.5 ms）        839 筆（18.8 ms）
  "%"             0 筆（13.4 ms）      9,486 筆（14.8 ms）      9,486 筆（22.2 ms）
  "_"             0 筆（13.3 ms）      9,486 筆（9.3 ms）       9,486 筆（17.0 ms）
  "100%"          0 筆（10.6 ms）         21 筆（14.5 ms）         21 筆（16.9 ms）
  "#1_"           0 筆（9.3 ms）       1,057 筆（7.5 ms）       1,057 筆（11.7 ms）
```

**三種寫法對正常的關鍵字（「耳機」）結果完全一樣。** 差別只在特殊字元：

- **衍生查詢 `...Containing`**：Spring Data **自動跳脫** `%`、`_`（它產生的 SQL 是 `like ? escape '\'`，並在參數裡加上跳脫字元）。`"%"` 找不到任何商品名含有 `%` 的商品 → 0 筆。正確。
- **`@Query` 的 `%:q%`**：Spring Data 會幫你在兩邊加上 `%`，**但不會跳脫參數本身**。`"%"` 變成 `like '%%%'` → 全部。
- **Criteria 的 `cb.like`**：完全照你給的 pattern。`"%" + q + "%"` → `'%%%'` → 全部。

**`"%"` 回傳 9,486 筆**，在 1 萬個商品上只要 15～22 ms —— 看起來無害。但：

- **分頁的 `COUNT(*)`** 每次都要數完所有商品。表長到 100 萬列時，每一個輸入 `%` 的請求都是一次全表掃描（`LIKE '%...'` 本來就用不了索引，2.7.2）。
- **`"100%"`**：使用者想找「100% 純棉」，得到的是「名稱裡有 `100` 的所有商品」（21 筆）—— **搜尋結果是錯的**，而且沒有任何錯誤。
- **`"#1_"`**：使用者想找「#1_」，得到了 1,057 個名稱含 `#1` 後面接任一字元的商品。

> 📌 **這一節要帶走的**：同樣是「關鍵字搜尋」，**寫法決定了你有沒有被保護**，而且三種寫法的正常結果一模一樣 —— 測試只測「耳機」的話，三種都會綠。
> 本專題用 Criteria（要動態組 4 個條件），所以自己跳脫（3.5.4 的 `escapeLike`），並把 `"100%"`、`"zq_"` 寫成測試案例（3.9）。

### 3.2.4 事故四：「9 月的每日訂單數」有 25 天是錯的 ★★★

US-RPT-1 AC-2：「以 **Asia/Taipei** 的日曆日為準（資料庫存 UTC，查詢時轉換）」。0.4.7 的 📌 已經預言過：「需求不寫，就一定有人用 UTC 切。」
第 02 章的種子資料刻意在台北凌晨 0～8 點安排了訂單（2.8.2 的 `HOUR_WEIGHT`）—— 現在它們派上用場了。

三種寫法，賣家 2（最大的賣家）的 9 月 1～28 日：

```java
package com.example.shop.ch03;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

import java.sql.Timestamp;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.*;

/**
 * 3.2.4 「9 月的每日訂單數」：用 DATE(created_at) 切日 vs 用台北時間切日。
 * 賣家 2（最大的賣家）、2026-09-01 ～ 2026-09-28，第 02 章的種子資料。
 */
@Tag("experiment")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE)
class D4ReportTimeZoneTest {

    @Autowired JdbcTemplate jdbc;

    static final LocalDate FROM = LocalDate.parse("2026-09-01"), TO = LocalDate.parse("2026-09-28");
    static final ZoneId TAIPEI = ZoneId.of("Asia/Taipei");

    /** 寫法一：最直覺的 SQL —— 資料庫存 UTC，所以 DATE() 切出來的是 UTC 的日子 */
    static final String NAIVE = """
            SELECT DATE(created_at) AS day, COUNT(*) AS n FROM orders
             WHERE seller_id = 2 AND DATE(created_at) BETWEEN ? AND ?
             GROUP BY DATE(created_at)""";

    /** 寫法二：知道要轉時區了，但把函式套在欄位上 */
    static final String CONVERT_IN_WHERE = """
            SELECT DATE(CONVERT_TZ(created_at, '+00:00', '+08:00')) AS day, COUNT(*) AS n FROM orders
             WHERE seller_id = 2 AND DATE(CONVERT_TZ(created_at, '+00:00', '+08:00')) BETWEEN ? AND ?
             GROUP BY day""";

    /** 寫法三（本專題的 SalesReportMapper）：邊界在 Java 算成 UTC，欄位上不套函式 */
    static final String RANGE = """
            SELECT DATE(CONVERT_TZ(created_at, '+00:00', '+08:00')) AS day, COUNT(*) AS n FROM orders
             WHERE seller_id = 2 AND created_at >= ? AND created_at < ?
             GROUP BY day""";

    Map<LocalDate, Long> run(String sql, Object... args) {
        Map<LocalDate, Long> m = new TreeMap<>();
        jdbc.query(sql, rs -> { m.put(rs.getDate("day").toLocalDate(), rs.getLong("n")); }, args);
        return m;
    }

    @Test
    void reportTimeZone() {
        Object[] utcDays = {FROM, TO};
        Object[] bounds = {Timestamp.from(FROM.atStartOfDay(TAIPEI).toInstant()), Timestamp.from(TO.plusDays(1).atStartOfDay(TAIPEI).toInstant())};
        Map<LocalDate, Long> naive = run(NAIVE, utcDays), right = run(RANGE, bounds), convert = run(CONVERT_IN_WHERE, utcDays);

        System.out.println("═══ 3.2.4 賣家 2 的每日訂單數：UTC 切日 vs 台北切日 ═══");
        System.out.println("  日期          DATE(created_at)   台北時間   差");
        int differentDays = 0;
        long moved = 0;
        for (LocalDate d = FROM; !d.isAfter(TO); d = d.plusDays(1)) {
            long a = naive.getOrDefault(d, 0L), b = right.getOrDefault(d, 0L);
            if (a != b) differentDays++;
            if (d.getDayOfMonth() <= 5 || d.getDayOfMonth() >= 26)
                System.out.printf("  %s   %6d          %6d   %+4d%n", d, a, b, a - b);
            else if (d.getDayOfMonth() == 6) System.out.println("  ...");
        }
        long naiveTotal = naive.values().stream().mapToLong(Long::longValue).sum();
        long rightTotal = right.values().stream().mapToLong(Long::longValue).sum();
        Long earlyMorning = jdbc.queryForObject("""
                SELECT COUNT(*) FROM orders WHERE seller_id = 2 AND created_at >= ? AND created_at < ?
                   AND HOUR(CONVERT_TZ(created_at, '+00:00', '+08:00')) < 8""", Long.class, bounds);
        System.out.printf("%n  28 天裡有 %d 天的數字不一樣；總數 %,d vs %,d%n", differentDays, naiveTotal, rightTotal);
        System.out.printf("  台北凌晨 0～8 點成立的訂單：%,d 張（佔 %.1f%%）—— 它們在 UTC 切日的報表裡，全部被算到「前一天」%n",
                earlyMorning, 100.0 * earlyMorning / rightTotal);
        System.out.println("  寫法二（函式套在欄位上）與寫法三結果相同？" + convert.equals(right));
        for (String[] q : new String[][]{{"寫法二 CONVERT_TZ 在 WHERE", CONVERT_IN_WHERE}, {"寫法三 UTC 邊界", RANGE}}) {
            Map<String, Object> e = jdbc.queryForList("EXPLAIN " + q[1], q[1] == RANGE ? bounds : utcDays).get(0);
            System.out.printf("  %-26s type=%-6s key=%-26s rows=%s  Extra=%s%n", q[0], e.get("type"), e.get("key"), e.get("rows"), e.get("Extra"));
        }
    }
}
```

**輸出**：

```
═══ 3.2.4 賣家 2 的每日訂單數：UTC 切日 vs 台北切日 ═══
  日期          DATE(created_at)   台北時間   差
  2026-09-01      129             132     -3
  2026-09-02       96             102     -6
  2026-09-03      116             116     +0
  2026-09-04      110             106     +4
  2026-09-05      115             118     -3
  ...
  2026-09-26      133             130     +3
  2026-09-27      123             123     +0
  2026-09-28      115             119     -4

  28 天裡有 25 天的數字不一樣；總數 3,357 vs 3,367
  台北凌晨 0～8 點成立的訂單：329 張（佔 9.8%）—— 它們在 UTC 切日的報表裡，全部被算到「前一天」
  寫法二（函式套在欄位上）與寫法三結果相同？true
  寫法二 CONVERT_TZ 在 WHERE     type=ref    key=idx_orders_seller_created  rows=20900  Extra=Using where; Using index; Using temporary
  寫法三 UTC 邊界               type=range  key=idx_orders_seller_created  rows=3367   Extra=Using where; Using index; Using temporary
```

**寫法一：28 天裡有 25 天是錯的。**

`DATE(created_at)` 切出來的是 **UTC 的日子**。UTC 的 9 月 1 日是台北時間 9 月 1 日 **08:00** 到 9 月 2 日 **08:00**。
所以台北時間 9 月 2 日凌晨 0～8 點成立的訂單，被算進了「9 月 1 日」；而 9 月 1 日凌晨的那些，被算到了 8 月 31 日。

**每一天都丟掉自己的凌晨、撿走隔天的凌晨。** 如果每天凌晨的訂單數一樣，錯誤會互相抵銷 —— 所以才會有 3 天剛好對（差 +0）。
但總數也不對（3,357 vs 3,367）：UTC 版的 28 天是「台北 9 月 1 日 08:00 到 9 月 29 日 08:00」—— **少了 9 月 1 日的凌晨、多了 9 月 29 日的凌晨**，兩者相差 10 張。

**這個錯誤的形狀，是「每天差幾張」而不是「差很多」。** 它不會讓任何人在看報表時覺得奇怪 —— 直到月底跟金流的撥款對帳，差了 10 張訂單的錢，而且**沒有辦法從報表上看出是哪 10 張**。

**寫法二：結果對了，但用不到索引的範圍。**

`WHERE DATE(CONVERT_TZ(created_at, ...)) BETWEEN ? AND ?` 把函式套在欄位上。EXPLAIN：`type=ref`、`rows=20900` —— 最佳化器只能用索引的第一欄（`seller_id = 2`），然後**把這個賣家的所有訂單**讀出來、逐列算函式、再比較。
寫法三把邊界換算成 UTC（`created_at >= '2026-08-31 16:00' AND created_at < '2026-09-28 16:00'`），`type=range`、`rows=3367`：**只讀這 28 天的訂單**。

在種子資料上兩者都只要幾十毫秒（3.9）。但寫法二的成本跟「**這個賣家有史以來的訂單數**」成正比、寫法三只跟「**查詢區間內的訂單數**」成正比 —— 三年後，差距就是 36 倍（3 年 / 1 個月）。

> 📌 **這一節要帶走的**：時區錯誤在程式碼裡**看不出來** —— `DATE(created_at)` 是一句完全合法、完全合理的 SQL。它在測試裡也**看不出來**，除非你的測試資料剛好有「台北凌晨」的訂單。
> 本專題的規則：**切日的邊界在 Java 裡用 `ZoneId.of("Asia/Taipei")` 算好**，SQL 裡只出現 `欄位 >= ? AND 欄位 < ?`（3.7.1）。


---

## 3.3 本章的 API 與模組形狀

### 3.3.1 16 支 API

0.8 的 API 草案裡，本章實作這些（下單、付款、狀態轉移在第 04 章；登入、註冊在第 05 章）：

| 方法 | 路徑 | 角色 | 故事 | 模組 |
|---|---|---|---|---|
| `GET` | `/api/products` | 公開 | PRD-2 | catalog |
| `GET` | `/api/products/{id}` | 公開（DRAFT / OFF_SHELF 只有賣家本人） | PRD-3 | catalog |
| `GET` `POST` | `/api/seller/products` | SELLER | PRD-1 | catalog |
| `PATCH` | `/api/seller/products/{id}` | SELLER | PRD-1 | catalog |
| `POST` | `/api/seller/products/{id}/publish`、`/unpublish` | SELLER | PRD-1、PRD-4 | catalog |
| `POST` | `/api/seller/products/{id}/restock` | SELLER | PRD-5 | catalog → inventory |
| `GET` | `/api/cart` | BUYER | CART-2 | cart |
| `POST` | `/api/cart/items` | BUYER | CART-1 | cart |
| `PATCH` `DELETE` | `/api/cart/items/{productId}` | BUYER | CART-1 | cart |
| `GET` | `/api/orders`、`/api/orders/{orderNo}` | BUYER | ORD-5 | ordering |
| `GET` | `/api/seller/orders` | SELLER | ORD-5 AC-5 | ordering |
| `GET` | `/api/seller/reports/daily-sales` | SELLER | RPT-1 | reporting |

> 📌 **路徑裡的訂單識別碼是 `orderNo`，不是 `id`。** 0.8 的草案寫的是 `/api/orders/{id}`，但 0.6.7 說「訂單對外用 `orderNo`，不暴露連續 id」。
> 本章把 `{id}` 落實為 `{orderNo}`（例如 `/api/orders/20260929-780005`）。內部的 `id` 不出現在任何回應裡。

### 3.3.2 每個模組的內部：Service 在 `internal`、Controller 在 `internal.web`

1.4.2 說過 Controller 放在模組的 `internal/` 裡。以 catalog 為例，本章結束時它長這樣：

```
catalog/
├── CatalogApi.java              ← 公開：給 cart、ordering 用
├── ProductSnapshot.java         ← 公開：CatalogApi 的回傳型別
├── ProductStatus.java           ← 公開
└── internal/
    ├── Category.java, Product.java                    ← Entity（package-private）
    ├── CategoryRepository.java, ProductRepository.java ← package-private
    ├── ProductSpecs.java                              ← 搜尋條件（package-private）
    ├── ProductDtos.java                               ← public：HTTP 的輸入輸出（Controller 在子套件，要用它）
    ├── ProductService.java                            ← public：同上；實作 CatalogApi
    └── web/
        ├── ProductController.java                     ← package-private
        └── SellerProductController.java               ← package-private
```

**依賴方向是 `web → internal`，不是反過來**：DTO 放在 Service 旁邊（`internal`），Controller 從子套件引用它們。
Service 不知道 HTTP 的存在 —— 它的參數是 `long sellerId` 與 DTO，不是 `HttpServletRequest`，也不是 `CurrentUser`。

`ProductService` 與 `ProductDtos` 是 `public` 的 —— 1.4.3 預言過：「一旦模組內部長出子套件，模組內部彼此呼叫的類別就被迫改成 `public`」。
（`CatalogApi`、`ProductSnapshot`、`CategoryRepository`、`ProductRepository` 都很短，完整內容在 3.10.1。）

所以它們**別的模組也看得到**。擋住它們的是 ArchUnit 規則二（`NotTouchOtherModulesInternals`）：cart 模組如果 `import com.example.shop.catalog.internal.ProductService`，`mvn test` 會紅。cart 只能用 `CatalogApi`。

### 3.3.3 一次依賴表的變更：catalog → inventory

US-PRD-1 AC-1：「建立商品 … `inventory.onHand = initialStock`；`inventory_ledger` 一筆 `reason=INITIAL`」。
**商品與它的庫存列必須一起建立** —— 商品建好、庫存列沒建，那個商品就永遠不能被加入購物車（`available` 查不到）。所以它們必須在**同一個交易**裡。

1.5.1 的判斷問題：「如果對方失敗了，我的操作應該算成功還是失敗？」—— 庫存列建不起來，商品就不該存在。**同步呼叫，同一個交易。**
所以 catalog 要呼叫 inventory。但 1.6.2 的依賴表寫的是 `catalog` 只能用 `shared`：

```
where layer 'shared' may not access any layer' was violated (10 times):
Constructor <com.example.shop.catalog.internal.ProductService.<init>(..., com.example.shop.inventory.InventoryApi, java.time.Clock)> has parameter of type <com.example.shop.inventory.InventoryApi> in (ProductService.java:0)
Field <com.example.shop.catalog.internal.ProductService.inventory> has type <com.example.shop.inventory.InventoryApi> in (ProductService.java:0)
Method <com.example.shop.catalog.internal.ProductService.create(long, ...CreateProductRequest)> calls method <com.example.shop.inventory.InventoryApi.initialize(long, int, java.lang.String)> in (ProductService.java:46)
Method <com.example.shop.catalog.internal.ProductService.detail(long, java.lang.Long)> calls method <com.example.shop.inventory.InventoryApi.available(long)> in (ProductService.java:97)
...
```

（訊息的第一行是整條規則描述的**最後一段**：ArchUnit 會把 `layeredArchitecture()` 的每一個 `whereLayer(...)` 串成一句長長的規則名稱，前面省略的部分裡有 `where layer 'catalog' may only access layers ['shared']`。紅的是 catalog 那一條，不是 shared。）

**這正是 1.5.6 說的「那一行改動本身就是一次架構變更，會出現在 code review 裡」。** 改 `ModuleBoundaryTest` 的一行：

```java
            .whereLayer("catalog").mayOnlyAccessLayers("inventory", "shared")          // 第 03 章：建立商品要同時建庫存列（US-PRD-1 AC-1）
```

**會不會產生循環？** inventory 依賴 shared，不依賴任何業務模組（它的 `product_id` 只是一個 `long`，1.5.5）。`catalog → inventory → shared`，沒有環 —— 規則四（無循環）照樣是綠的。

> 📌 1.6.3 違規二的「商品頁要顯示『已售出 N 件』」被拒絕了，這一次卻被接受了。差別在哪？
> 那一次是 `catalog → ordering`，而 `ordering → catalog` 已經存在 —— **會形成循環**。這一次的方向上沒有反向的依賴。
> **依賴表不是「不能改」，是「每一次改都要回答：會不會有環？這個方向合不合理？」** 商品依賴庫存（「賣的東西有沒有貨」）是合理的；庫存依賴商品就不合理（庫存不需要知道商品叫什麼名字）。

`InventoryApi` 為此多了兩個方法：

```java
package com.example.shop.inventory;

import java.util.Collection;
import java.util.List;
import java.util.Map;

/**
 * 庫存模組唯一的對外入口。其他模組只能透過這個介面改變庫存。
 * 每一個會改變數量的方法，都會在同一個交易裡寫一筆 inventory_ledger（INV-3）。
 */
public interface InventoryApi {

    /**
     * 建立一個商品的庫存列（US-PRD-1 AC-1），並記一筆 INITIAL。
     * 必須在呼叫端既有的交易內呼叫（Propagation.MANDATORY）：商品沒建成，庫存列也不能存在。
     */
    void initialize(long productId, int onHand, String note);

    /**
     * 為一張訂單預留庫存。全有或全無：任何一個品項不足就丟例外，呼叫端的交易應該 rollback。
     * 必須在呼叫端既有的交易內呼叫（Propagation.MANDATORY）。
     */
    void reserve(long orderId, List<ReserveLine> lines);

    /** 補貨：onHand 增加，並記一筆 RESTOCK。自己開交易。 */
    void restock(long productId, int quantity, String note);

    /** 批次補貨：一個交易、兩句 batch（UPDATE + ledger INSERT）。給匯入功能用。 */
    void restockBatch(List<RestockLine> lines, String note);

    record RestockLine(long productId, int quantity) {}

    /** 可售庫存 = onHand - reserved。 */
    int available(long productId);

    /** 一次查多個商品的可售庫存（一句 SQL）。沒有庫存列的商品不會出現在結果裡。 */
    Map<Long, Integer> available(Collection<Long> productIds);
}
```

```java
    @Override
    @Transactional(propagation = Propagation.MANDATORY)
    public void initialize(long productId, int onHand, String note) {
        if (onHand < 0) throw new IllegalArgumentException("onHand must not be negative");
        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, ?, 0)", productId, onHand);
        if (onHand > 0) ledger(productId, onHand, 0, "INITIAL", note);     // ck_ledger_delta：數量為 0 就不記帳
    }
```

```java
    @Override
    @Transactional(readOnly = true)
    public Map<Long, Integer> available(Collection<Long> productIds) {
        Map<Long, Integer> result = new HashMap<>();
        if (productIds.isEmpty()) return result;
        String in = String.join(",", productIds.stream().map(id -> "?").toList());
        jdbc.query("SELECT product_id, on_hand - reserved FROM inventory WHERE product_id IN (" + in + ")",
                rs -> { result.put(rs.getLong(1), rs.getInt(2)); }, productIds.toArray());
        return result;
    }
```

（`JdbcInventoryService` 的 import 多了 `java.util.Collection`、`java.util.HashMap`、`java.util.Map`，完整的 import 區塊在 3.10.1。）

`initialize` 用 `MANDATORY`（跟 `reserve` 同一個理由，1.5.2 ④）；`onHand = 0` 時不記帳 —— 2.5 的 `ck_ledger_delta` 會擋下一筆「什麼都沒變」的帳。
`available(Collection)` 是給購物車與賣家商品列表用的：**一次查一頁的商品，一句 SQL**，而不是每個商品呼叫一次 `available(long)`（那就是跨模組的 N+1）。

> ⚠️ `"... IN (" + in + ")"` 是字串拼接 —— 但拼進去的只有 `?`（佔位符的數量），**值**全部走參數綁定。這跟 3.7.3 禁止的 `${}` 不一樣：`${}` 拼的是**值**。

### 3.3.4 暫時的身分：`CurrentUser`，以及一個 fail-open 的洞

登入是第 05 章的事，但本章的每一支 API 都需要知道「你是誰、你是什麼角色」。所以先定義**型別**，暫時用一個除錯用的 header 產生它：

```java
package com.example.shop.shared.web;

/** 0.3.2 的三種人類角色 */
public enum Role { BUYER, SELLER, ADMIN }
```

```java
package com.example.shop.shared.web;

import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;

import java.util.Set;

/** 目前的使用者。第 03 章由除錯用的 header 產生（CurrentUserResolver），第 05 章改由 JWT 產生，型別不變。 */
public record CurrentUser(long id, Set<Role> roles) {

    public CurrentUser require(Role role) {
        if (!roles.contains(role)) throw new ShopException(ProblemType.FORBIDDEN, "需要 " + role + " 角色");
        return this;
    }

    public boolean has(Role role) { return roles.contains(role); }
}
```

**第一版的解析器**是這樣寫的 —— 「誰都能冒充誰」的東西，只讓它存在於本機：

```java
@Configuration
@Profile("local")                                  // ← 只在本機存在
class CurrentUserResolver implements HandlerMethodArgumentResolver, WebMvcConfigurer {
    // ... 從 X-Debug-User-Id / X-Debug-Roles 讀出 CurrentUser；角色檢查的 interceptor 也註冊在這裡
}
```

看起來很安全：正式環境沒有 `local` profile，解析器不存在，任何需要 `CurrentUser` 的 API「應該會失敗」。**實測一次**：用一個不是 `local` 的 profile（`noauth`，沒有對應的 `application-noauth.yml`）啟動。
資料庫、RabbitMQ 的帳密與 JWT 金鑰平常都在 `application-local.yml` 裡，這裡要從命令列給 —— 尤其是 `shop.security.jwt-secret`：`ShopProperties` 要求它**至少 32 bytes**（1.7.3），少了它應用程式根本起不來：

```bash
mvn -q package -DskipTests
java -jar target/shop-0.0.1-SNAPSHOT.jar --spring.profiles.active=noauth --server.port=18081 \
     --spring.datasource.url='jdbc:mysql://localhost:3306/shop?useSSL=false&allowPublicKeyRetrieval=true&connectionTimeZone=UTC&rewriteBatchedStatements=true' \
     --spring.datasource.username=shop --spring.datasource.password=shop \
     --spring.rabbitmq.username=shop --spring.rabbitmq.password=shop \
     --shop.security.jwt-secret=noauth-test-secret-0123456789abcdef
```

另開一個終端機：

```bash
curl -s "localhost:18081/api/orders?size=1"
curl -s "localhost:18081/api/orders?size=1&id=1001&roles=BUYER"
curl -s -X POST -H "Content-Type: application/json" \
     -d '{"name":"x","price":1,"categoryId":11,"initialStock":1}' \
     "localhost:18081/api/seller/products?id=2&roles=SELLER"
curl -s -H 'X-Debug-User-Id: 1001' "localhost:18081/api/orders?size=1"
```

用第一版的解析器，它在這個 profile 下不存在，Spring 會用 `@ModelAttribute` 的預設行為、從 query 參數組出 `CurrentUser`：第三個請求（`?id=2&roles=SELLER`）就能以賣家 2 的身分建立商品。**「只在本機存在」是 fail-open 的。** 照下面三個設計決定修好之後（本章結束時的程式碼），同樣的四個請求：

```
{"type":"/problems/unauthenticated","title":"需要登入","status":401,"detail":"需要登入","instance":"/api/orders"}
{"type":"/problems/unauthenticated","title":"需要登入","status":401,"detail":"需要登入","instance":"/api/orders"}
{"type":"/problems/unauthenticated","title":"需要登入","status":401,"detail":"需要登入","instance":"/api/seller/products"}
{"type":"/problems/unauthenticated","title":"需要登入","status":401,"detail":"需要登入","instance":"/api/orders"}
```

四個請求依序：不帶身分、用 query 參數假冒、用 query 參數假冒賣家、帶除錯 header —— **一律 401**。header 在非 `local` 的 profile 也不算數，因為 `debug-headers` 預設是 `false`。

（這一段的指令與輸出是在本章結束時的程式碼上跑的。有一個環境上的坑：compose 裡的 `shop` 庫如果已經被後面章節的程式碼 migrate 過，第 03 章的 Flyway 會因為看不到歷史表而拒絕啟動（`Found non-empty schema(s) \`shop\` but no schema history table`）。照著本章做的你，`shop` 庫就停在 V10，不會遇到；如果遇到了，把 URL 的資料庫名稱換成一個空的資料庫即可。）

**第二道保險**：有人在正式環境打開它的話，應用程式直接起不來：

```bash
SHOP_DB_HOST=localhost SHOP_DB_USER=shop SHOP_DB_PASSWORD=shop \
SHOP_REDIS_HOST=localhost SHOP_REDIS_PASSWORD= \
SHOP_RABBIT_HOST=localhost SHOP_RABBIT_USER=shop SHOP_RABBIT_PASSWORD=shop \
SHOP_JWT_SECRET=prod-like-secret-0123456789abcdef \
java -jar target/shop-0.0.1-SNAPSHOT.jar --spring.profiles.active=prod --shop.security.debug-headers=true
```

```
Caused by: org.springframework.beans.BeanInstantiationException: Failed to instantiate [com.example.shop.shared.web.CurrentUserResolver$$SpringCGLIB$$0]: Constructor threw exception
Caused by: java.lang.IllegalStateException: shop.security.debug-headers 不可以在 prod 打開
```

（`application-prod.yml` 的 URL 是 `${SHOP_DB_NAME:shop}`；遇到上面那個 Flyway 的坑，就另外給 `SHOP_DB_NAME`，指向第 03 章狀態的資料庫。）

（`application-prod.yml` 的每一個 `${SHOP_...}` 都要有值，否則第 01 章的 `UnresolvedPlaceholderCheck`（1.7.4）會先擋下；`SHOP_REDIS_PASSWORD=` 給空字串即可，本機的 Redis 沒有密碼。）

**這一節的三個設計決定**：

1. **Controller 的參數是 `CurrentUser` 這個型別**，它不知道身分是從 header、Session 還是 JWT 來的。第 05 章換掉 `CurrentUserResolver`，**所有 Controller 一行都不用改**。
2. **危險的功能用「開關」而不是「存在與否」控制**，而且開關的預設值是安全的那一邊。解析器永遠存在，所以 Spring 的 `@ModelAttribute` 預設行為永遠不會接手 `CurrentUser`。
3. **角色檢查放在 interceptor，依路徑前綴**（`/api/seller/**` 要 SELLER）—— 這是 0.8「以角色分前綴，讓權限規則可以用路徑表達」的落實，理由在 3.4.4。

> 📌 **這個洞要實測才看得到**：`CurrentUserResolver` 的第一版通過了本機所有的測試（本機的 profile 就是 `local`）。
> 它只有在「**不是本機**」的環境才會出現 —— 也就是正式環境。第 05 章的 Spring Security 會把「預設拒絕」寫成 `anyRequest().denyAll()`，這是同一個原則的框架版。

用法（本機）：先 `docker compose up -d --wait`，再 `mvn spring-boot:run`（沒有指定 profile 時就是 `local`，`application.yml` 的 `spring.profiles.default`），應用程式在 8080：

```bash
curl -s -H "X-Debug-User-Id: 1001" localhost:8080/api/orders?size=2
curl -s -H "X-Debug-User-Id: 2" -H "X-Debug-Roles: BUYER,SELLER" "localhost:8080/api/seller/reports/daily-sales?from=2026-09-20&to=2026-09-22"
```

---

## 3.4 錯誤回應：一個出口

### 3.4.1 `ProblemType`：0.4.1 的那張表，變成一個 enum

```java
package com.example.shop.shared.error;

import org.springframework.http.HttpStatus;

import java.net.URI;

/**
 * 0.4.1 的錯誤型別表。前端依 type 判斷怎麼處理，title 給人看。
 * 新增一種錯誤 = 在這裡加一個值；OpenAPI 文件與前端的錯誤處理都從這張表來。
 */
public enum ProblemType {
    VALIDATION(HttpStatus.BAD_REQUEST, "/problems/validation", "請求內容不正確"),
    UNAUTHENTICATED(HttpStatus.UNAUTHORIZED, "/problems/unauthenticated", "需要登入"),
    FORBIDDEN(HttpStatus.FORBIDDEN, "/problems/forbidden", "沒有權限"),
    NOT_FOUND(HttpStatus.NOT_FOUND, "/problems/not-found", "找不到資源"),
    INSUFFICIENT_STOCK(HttpStatus.CONFLICT, "/problems/insufficient-stock", "庫存不足"),
    INVALID_STATE(HttpStatus.CONFLICT, "/problems/invalid-state", "目前的狀態不允許這個動作"),
    PRICE_CHANGED(HttpStatus.CONFLICT, "/problems/price-changed", "價格已變動"),
    PRODUCT_UNAVAILABLE(HttpStatus.CONFLICT, "/problems/product-unavailable", "商品目前無法購買"),
    IDEMPOTENCY_IN_PROGRESS(HttpStatus.CONFLICT, "/problems/idempotency-in-progress", "相同的請求正在處理中"),
    IDEMPOTENCY_KEY_REUSED(HttpStatus.UNPROCESSABLE_ENTITY, "/problems/idempotency-key-reused", "冪等鍵已用於不同的請求"),
    RATE_LIMITED(HttpStatus.TOO_MANY_REQUESTS, "/problems/rate-limited", "請求太頻繁"),
    TEMPORARILY_UNAVAILABLE(HttpStatus.SERVICE_UNAVAILABLE, "/problems/temporarily-unavailable", "服務暫時無法使用"),
    INTERNAL(HttpStatus.INTERNAL_SERVER_ERROR, "/problems/internal", "系統發生錯誤");

    private final HttpStatus status;
    private final URI type;
    private final String title;

    ProblemType(HttpStatus status, String type, String title) {
        this.status = status;
        this.type = URI.create(type);
        this.title = title;
    }

    public HttpStatus status() { return status; }
    public URI type() { return type; }
    public String title() { return title; }
}
```

0.4.1 那張表有 13 列，本章實作其中 12 種（`/problems/email-unavailable` 是註冊用的，第 05 章補上），加上一個 `INTERNAL`（500）。**前端的錯誤處理是照這張表寫的**：`type` 是給程式判斷的（「`/problems/insufficient-stock` 就在那個品項旁邊顯示『庫存不足』」），`title` 與 `detail` 是給人看的。

### 3.4.2 `ShopException`：放在 `shared`，不是 `shared.web`

```java
package com.example.shop.shared.error;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 所有「業務上可預期」的失敗的共同父類別。每一個都帶著一個 ProblemType。
 *
 * 放在 shared（而不是 shared.web）：模組的例外是業務概念，不應該依賴 Web 層。
 * 模組依賴 shared 是允許的（1.6.2 規則一），所以 inventory 的 InsufficientStockException 可以繼承它，
 * 而 shared.web 的全域例外處理器只需要認識這一個類別 —— 不需要認識任何模組。
 */
public class ShopException extends RuntimeException {

    private final ProblemType type;
    private final Map<String, Object> properties = new LinkedHashMap<>();

    public ShopException(ProblemType type, String detail) {
        super(detail);
        this.type = type;
    }

    public ShopException with(String key, Object value) {
        properties.put(key, value);
        return this;
    }

    public ProblemType type() { return type; }
    public Map<String, Object> properties() { return Collections.unmodifiableMap(properties); }

    public static ShopException notFound(String what) {
        return new ShopException(ProblemType.NOT_FOUND, what + "不存在");
    }
}
```

**問題**：全域例外處理器在 `shared.web`，而 `InsufficientStockException` 在 `inventory`。處理器要把「庫存不足」轉成 409 `/problems/insufficient-stock` —— 它需要認識 `InsufficientStockException` 嗎？

如果需要，`shared` 就依賴了 `inventory` —— **違反 1.5.7「`shared` 不依賴任何業務模組」**，ArchUnit 規則一會紅（`whereLayer("shared").mayNotAccessAnyLayer()`）。

**解法是反過來**：`shared.error` 定義一個父類別 `ShopException`，每一個模組的業務例外**繼承它**，並在建構時告訴它自己是哪一種 `ProblemType`：

```java
package com.example.shop.inventory;

import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;

public class InsufficientStockException extends ShopException {
    private final long productId;

    public InsufficientStockException(long productId) {
        super(ProblemType.INSUFFICIENT_STOCK, "商品 " + productId + " 的可售庫存不足");
        this.productId = productId;
        with("productId", productId);
    }

    public long productId() { return productId; }
}
```

依賴方向：`inventory → shared.error`（允許），`shared.web → shared.error`（同一個模組）。**處理器只認識 `ShopException` 一個類別**，永遠不需要知道有哪些模組。
第 01 章的 `InsufficientStockException` 原本繼承 `RuntimeException`，現在改繼承 `ShopException` —— 呼叫端（`catch (InsufficientStockException e)`、`e.productId()`）完全不受影響。

> 📌 **為什麼 `ShopException` 不放在 `shared.web`？** 因為庫存不足是一個**業務**概念，不是 Web 概念。任何不經過 HTTP 的呼叫端 —— 排程、訊息消費者、測試直接呼叫 Service —— 都可能碰到它，它們不該因此依賴 Web 層。
> `ProblemType` 裡的 `HttpStatus` 是一個妥協：它讓 `shared.error` 依賴了 `spring-web` 的一個 enum。另一種做法是在 `shared.web` 裡再放一張「`ProblemType` → 狀態碼」的對照表 —— 多一層間接，換一個更乾淨的依賴。本專題選擇簡單。

### 3.4.3 `GlobalExceptionHandler`

```java
package com.example.shop.shared.web;

import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import jakarta.validation.ConstraintViolationException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.mapping.PropertyReferenceException;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.WebRequest;
import org.springframework.web.method.annotation.HandlerMethodValidationException;
import org.springframework.web.servlet.mvc.method.annotation.ResponseEntityExceptionHandler;

import java.util.List;
import java.util.Map;

/**
 * 3.4 全站唯一的錯誤出口。三條規則：
 *  ① 每一個錯誤回應都是 Problem Details，type 來自 ProblemType（0.4.1）
 *  ② 回應裡「不含」堆疊、類別名、SQL、表名（0.6.5）—— 例外的 getMessage() 只能進日誌，不能進回應
 *  ③ 業務例外（ShopException）照它自己說的回；其他任何例外一律 500，而且一定要記日誌
 */
@RestControllerAdvice
class GlobalExceptionHandler extends ResponseEntityExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    static ProblemDetail problem(ProblemType type, String detail) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(type.status(), detail);
        pd.setType(type.type());
        pd.setTitle(type.title());
        return pd;
    }

    @ExceptionHandler(ShopException.class)
    ResponseEntity<ProblemDetail> handleShop(ShopException e) {
        ProblemDetail pd = problem(e.type(), e.getMessage());
        e.properties().forEach(pd::setProperty);
        return ResponseEntity.status(e.type().status()).body(pd);
    }

    /** @RequestBody 的 Bean Validation 失敗：列出每一個欄位 */
    @Override
    protected ResponseEntity<Object> handleMethodArgumentNotValid(MethodArgumentNotValidException ex, HttpHeaders headers,
                                                                  HttpStatusCode status, WebRequest request) {
        ProblemDetail pd = problem(ProblemType.VALIDATION, "有 %d 個欄位不正確".formatted(ex.getErrorCount()));
        pd.setProperty("errors", ex.getFieldErrors().stream()
                .map(f -> Map.of("field", f.getField(), "message", String.valueOf(f.getDefaultMessage())))
                .toList());
        return ResponseEntity.badRequest().body(pd);
    }

    /** @RequestParam / @PathVariable 上的約束（Spring 6.1 起由 MVC 自己驗證） */
    @Override
    protected ResponseEntity<Object> handleHandlerMethodValidationException(HandlerMethodValidationException ex, HttpHeaders headers,
                                                                            HttpStatusCode status, WebRequest request) {
        ProblemDetail pd = problem(ProblemType.VALIDATION, "請求參數不正確");
        pd.setProperty("errors", ex.getAllValidationResults().stream()
                .flatMap(r -> r.getResolvableErrors().stream().map(err -> Map.of(
                        "field", String.valueOf(r.getMethodParameter().getParameterName()),
                        "message", String.valueOf(err.getDefaultMessage()))))
                .toList());
        return ResponseEntity.badRequest().body(pd);
    }

    @ExceptionHandler(ConstraintViolationException.class)
    ResponseEntity<ProblemDetail> handleConstraintViolation(ConstraintViolationException e) {
        ProblemDetail pd = problem(ProblemType.VALIDATION, "請求參數不正確");
        pd.setProperty("errors", e.getConstraintViolations().stream()
                .map(v -> Map.of("field", v.getPropertyPath().toString(), "message", v.getMessage())).toList());
        return ResponseEntity.badRequest().body(pd);
    }

    /** JSON 格式錯誤、型別不符。預設的 detail 是 "Failed to read request"，這裡改成中文，但一樣不帶 Jackson 的原始訊息 */
    @Override
    protected ResponseEntity<Object> handleHttpMessageNotReadable(HttpMessageNotReadableException ex, HttpHeaders headers,
                                                                  HttpStatusCode status, WebRequest request) {
        log.debug("無法解析的請求內容", ex);
        return ResponseEntity.badRequest().body(problem(ProblemType.VALIDATION, "請求內容無法解析（JSON 格式或欄位型別不正確）"));
    }

    /** 排序欄位不存在（US-PRD-2 AC-3）。原始訊息會帶 Entity 的類別名，絕對不能回給客戶端 */
    @ExceptionHandler(PropertyReferenceException.class)
    ResponseEntity<ProblemDetail> handleBadSort(PropertyReferenceException e) {
        ProblemDetail pd = problem(ProblemType.VALIDATION, "不支援的排序欄位");
        pd.setProperty("errors", List.of(Map.of("field", "sort", "message", "不支援的排序欄位")));
        return ResponseEntity.badRequest().body(pd);
    }

    /** 其他所有例外：這是 bug。回 500、不帶任何細節，但一定要進日誌 */
    @ExceptionHandler(Exception.class)
    ResponseEntity<ProblemDetail> handleUnexpected(Exception e) {
        log.error("未預期的例外", e);
        return ResponseEntity.internalServerError().body(problem(ProblemType.INTERNAL, "系統發生錯誤，請稍後再試"));
    }
}
```

**每一個 handler 都想遵守同一條規則**：`detail` 與 `errors[].message` 是**我們寫的字串**，不是例外的 `getMessage()`。刻意的例外是 `ShopException` —— 它的訊息**本來就是我們寫給使用者看的**（`"商品 42 的可售庫存不足"`）。

**但這條規則有一個沒守住的地方**：`handleMethodArgumentNotValid` 回傳的是 `f.getDefaultMessage()`。Bean Validation 的錯誤，那是 DTO 上我們寫的 `message`；但**綁定失敗**（型別轉換錯誤，`f.isBindingFailure()` 為 true）時，那是 Spring 自己產生的訊息，帶著 Java 的型別名。
3.3.4 第一版的解析器在非 `local` 的 profile 下，第一個請求的回應就是反例：`"message":"Failed to convert value of type 'null' to required type 'long'; ..."`。本專題目前只有 `@ModelAttribute` 綁定會走到這條路（3.3.4 修好之後，就沒有任何 Controller 參數會這樣綁定了），所以程式碼沒改；
要徹底守住，就在這個 handler 裡對 `isBindingFailure()` 的欄位改用固定字串（例如「格式不正確」）。

| 例外 | 回應 | 備註 |
|---|---|---|
| `ShopException` 與它的子類別 | 它自己的 `type`、訊息、`properties` | `InsufficientStockException` 帶著 `productId` |
| `MethodArgumentNotValidException`（`@Valid @RequestBody`） | 400 `validation`，`errors[]` 逐欄列出 | 訊息來自 DTO 上的 `message = "..."`（1.7.3 的教訓：不要用 Hibernate Validator 的預設訊息） |
| `HandlerMethodValidationException`（`@RequestParam` 上的 `@Min` 等） | 400 `validation` | Spring 6.1 起，MVC 自己會驗證 Controller 方法參數上的約束 |
| `HttpMessageNotReadableException`（JSON 壞掉、型別不對） | 400 `validation`，**固定的中文訊息** | 原始訊息帶 Jackson 的類別名（3.2.2 ③） |
| `PropertyReferenceException`（排序欄位不存在） | 400 `validation` | 原始訊息帶 Entity 類別名（3.2.2 ①）。本專題有 `SortWhitelist`（3.5.4），這是第二道防線 |
| **其他任何例外** | 500 `internal`，「系統發生錯誤，請稍後再試」 | **一定要 `log.error`** —— 回應裡沒有細節，日誌是唯一的線索（第 09 章會加上 `traceId`，讓使用者回報時能對到那一行日誌） |

實際的回應（本機，`curl`）：

```json
{"type":"/problems/unauthenticated","title":"需要登入","status":401,"detail":"需要登入","instance":"/api/orders"}
```

```json
{"type":"/problems/validation","title":"請求內容不正確","status":400,"detail":"有 1 個欄位不正確","instance":"/api/seller/products","errors":[{"message":"價格最多 2 位小數","field":"price"}]}
```

```json
{"type":"/problems/validation","title":"請求內容不正確","status":400,"detail":"同一個商品最多 99 件","instance":"/api/cart/items","productId":1}
```

最後一個的 `productId` 來自 `ShopException.with("productId", ...)` —— Problem Details（RFC 9457）允許**擴充欄位**，前端可以用它標出是哪一個品項。

### 3.4.4 驗證跑在權限前面

第一版的角色檢查寫在 Controller 方法裡：

```java
    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    ProductDetail create(CurrentUser user, @Valid @RequestBody CreateProductRequest req) {
        return service.create(user.require(Role.SELLER).id(), req);
    }
```

3.9 的測試「買家呼叫賣家 API → 403」是紅的：

```
[ERROR] CatalogCartApiTest.roles -- Time elapsed: 0.008 s <<< FAILURE!
java.lang.AssertionError: Status expected:<403> but was:<400>
```

**買家送了一個空的 body（`{}`），拿到的是 400 —— 而且回應裡列出了每一個必填欄位。**

原因是執行順序。Spring MVC 呼叫 Controller 方法之前，要先**解析每一個參數**：`CurrentUser` 由 resolver 產生、`@Valid @RequestBody` 由 Jackson 反序列化**並且驗證**。驗證失敗 → `MethodArgumentNotValidException` → 400。
`user.require(Role.SELLER)` 在**方法本體**裡，根本沒有機會執行。

這有兩個後果：狀態碼錯了（沒有權限的人應該先被告知「沒有權限」），以及**一個沒有權限的人，可以從 400 的 `errors[]` 裡讀出這支 API 的完整欄位規則**。

**修法：把角色檢查移到參數解析之前。** Spring MVC 的 `HandlerInterceptor.preHandle()` 在參數解析之前執行 —— 3.3.4 的 `CurrentUserResolver.addInterceptors()` 就是這樣做的：

```java
        registry.addInterceptor(requireRole(Role.SELLER)).addPathPatterns("/api/seller/**");
        registry.addInterceptor(requireRole(Role.ADMIN)).addPathPatterns("/api/admin/**");
        registry.addInterceptor(requireRole(Role.BUYER)).addPathPatterns("/api/cart/**", "/api/orders/**");
```

Controller 方法裡的 `user.require(...)` 保留下來 —— 它是第二道檢查，而且讓讀 Controller 的人一眼看到「這支 API 要什麼角色」。

> 📌 **第 05 章的 Spring Security 天生就是這個順序**：`SecurityFilterChain` 是 Servlet filter，比 `DispatcherServlet` 還早執行（[04-controller/04](../04-controller/04-filter-interceptor-and-lifecycle.md) 的生命週期圖）。
> 這張「路徑前綴 → 角色」的表會原封不動地搬進 `authorizeHttpRequests(...)`。


---

## 3.5 商品（catalog）

### 3.5.1 DTO：API 的形狀是一份清單

```java
package com.example.shop.catalog.internal;

import com.example.shop.catalog.ProductStatus;
import jakarta.validation.constraints.*;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * catalog 模組對 HTTP 的輸入與輸出。放在 internal（跟 Service 同一個套件），Controller 在 internal.web 裡使用它們。
 * 每一個輸出 DTO 都是「這支 API 要回什麼」的明確清單 —— Entity 多了一個欄位，API 不會跟著多一個。
 */
public final class ProductDtos {

    private ProductDtos() {}

    /** 搜尋結果的一列（US-PRD-2）。沒有 available：列表頁不需要，也就不必為每個商品查庫存 */
    public record ProductSummary(long id, String name, BigDecimal price, long categoryId) {}

    /** 商品詳情（US-PRD-3 AC-1）：有 available，沒有 onHand 與 reserved */
    public record ProductDetail(long id, long sellerId, String name, String description, BigDecimal price,
                                long categoryId, ProductStatus status, int available) {}

    /** 賣家自己的商品列表 */
    public record SellerProductView(long id, String name, BigDecimal price, ProductStatus status, long categoryId,
                                    int available, Instant updatedAt) {}

    /** US-PRD-1。注意沒有 sellerId、沒有 status —— 那兩個不能由客戶端決定 */
    public record CreateProductRequest(
            @NotBlank(message = "商品名稱不可空白") @Size(max = 200, message = "商品名稱最多 200 字") String name,
            @Size(max = 5000, message = "商品說明最多 5000 字") String description,
            @NotNull(message = "價格必填")
            @DecimalMin(value = "0.01", message = "價格必須大於 0")
            @DecimalMax(value = "1000000", message = "價格不可超過 1,000,000")
            @Digits(integer = 7, fraction = 2, message = "價格最多 2 位小數") BigDecimal price,
            @NotNull(message = "分類必填") Long categoryId,
            @NotNull(message = "期初庫存必填") @Min(value = 0, message = "期初庫存不可為負") @Max(value = 100_000, message = "期初庫存不可超過 100,000") Integer initialStock) {}

    /** 部分更新：null 代表「不改」 */
    public record UpdateProductRequest(
            @Size(min = 1, max = 200, message = "商品名稱 1～200 字") String name,
            @Size(max = 5000, message = "商品說明最多 5000 字") String description,
            @DecimalMin(value = "0.01", message = "價格必須大於 0")
            @DecimalMax(value = "1000000", message = "價格不可超過 1,000,000")
            @Digits(integer = 7, fraction = 2, message = "價格最多 2 位小數") BigDecimal price,
            Long categoryId) {}

    /** US-PRD-5：減少庫存不走這支 API（AC-2） */
    public record RestockRequest(
            @NotNull(message = "數量必填") @Min(value = 1, message = "補貨數量必須大於 0") @Max(value = 100_000, message = "一次最多補 100,000") Integer quantity,
            @Size(max = 80, message = "備註最多 80 字") String note) {}

    public record SearchCriteria(String q, Long categoryId, BigDecimal minPrice, BigDecimal maxPrice) {}
}
```

**輸出 DTO 回答「這支 API 回傳什麼」**，而且是一份**封閉的清單**：`ProductDetail` 有 `available`、沒有 `onHand` 與 `reserved`（US-PRD-3 AC-1）、沒有 `version`、沒有 `createdAt`。
Entity 將來多了任何欄位，這支 API 都不會跟著多一個 —— 3.2.1 的「每一個 getter 都變成 API」在這裡不會發生。

**輸入 DTO 回答「客戶端可以決定什麼」**。`CreateProductRequest` 刻意**沒有** `sellerId` 與 `status`：

```bash
curl -s -X POST -H "X-Debug-User-Id: 2" -H "X-Debug-Roles: BUYER,SELLER" -H "Content-Type: application/json" \
     -d '{"name":"測試商品","price":299,"categoryId":11,"initialStock":10,"sellerId":999,"status":"ON_SALE"}' \
     localhost:8080/api/seller/products
```

```json
{"id":10001,"sellerId":2,"name":"測試商品","description":null,"price":299.00,"categoryId":11,"status":"DRAFT","available":10}
```

（`"price"` 這一欄依本章程式碼修正為 `299.00`，不是重新實測的輸出：3.5.2 的 `Product.draft()` 會先把價格正規化成 2 位小數，建立的回應用的就是那個值。）

`"sellerId":999` 與 `"status":"ON_SALE"` 被**安靜地忽略**：Spring Boot 的 Jackson 預設 `FAIL_ON_UNKNOWN_PROPERTIES = false`，DTO 上沒有的欄位不會被讀。
`sellerId` 來自目前的使用者（2），狀態一律 `DRAFT`。這就是 0.4.2 的 📌 說的「**大量指派**（mass assignment）漏洞的需求版」—— 如果 Controller 的 `@RequestBody` 是 Entity，這兩個欄位都會被寫進去。

**驗證訊息都自己寫**（1.7.3 的教訓：Hibernate Validator 的預設訊息跟著 JVM 語系走）。`@Digits(integer = 7, fraction = 2)` 就是 2.5.4 ① 說的「小數位數，資料庫擋不住」的那一道：

```json
{"type":"/problems/validation","title":"請求內容不正確","status":400,"detail":"有 1 個欄位不正確","instance":"/api/seller/products","errors":[{"message":"價格最多 2 位小數","field":"price"}]}
```

### 3.5.2 Entity 的行為，以及 `299` 與 `299.00`

第 02 章的 `Product` 只有對應。本章加上它的行為 —— **狀態只能透過這些方法改變**：

```java
    /** US-PRD-1 AC-1：新商品一律是 DRAFT；sellerId 由呼叫端（目前使用者）決定，不從請求 body 來 */
    static Product draft(long sellerId, Category category, String name, String description, BigDecimal price, Instant now) {
        Product p = new Product();
        p.sellerId = sellerId;
        p.category = category;
        p.name = name;
        p.description = description;
        p.price = money(price);
        p.status = ProductStatus.DRAFT;
        p.createdAt = now;
        p.updatedAt = now;
        return p;
    }

    void update(String name, String description, BigDecimal price, Category category, Instant now) {
        if (name != null) this.name = name;
        if (description != null) this.description = description;
        if (price != null) this.price = money(price);
        if (category != null) this.category = category;
        this.updatedAt = now;
    }

    /** DRAFT / OFF_SHELF → ON_SALE；已經是 ON_SALE 就什麼都不做（冪等） */
    void publish(Instant now) {
        if (status == ProductStatus.ON_SALE) return;
        status = ProductStatus.ON_SALE;
        updatedAt = now;
    }

    /** ON_SALE → OFF_SHELF；DRAFT 不能下架（它根本沒上架過） */
    boolean unpublish(Instant now) {
        if (status == ProductStatus.OFF_SHELF) return true;
        if (status == ProductStatus.DRAFT) return false;
        status = ProductStatus.OFF_SHELF;
        updatedAt = now;
        return true;
    }

    boolean ownedBy(long userId) { return sellerId == userId; }

    /** 金額一律兩位小數：299 與 299.00 在 BigDecimal 裡是兩個「不相等」的值（equals 會比 scale，第 04 章） */
    private static BigDecimal money(BigDecimal v) { return v.setScale(2, java.math.RoundingMode.UNNECESSARY); }
```

`money()` 為什麼要存在？想像 `draft()` 直接寫 `p.price = price`：建立的那一次，回應用的是**請求裡的那個 `BigDecimal`**（`299`，scale = 0）。**同一個商品，重新查一次**：

```json
{"id":10001,"sellerId":2,"name":"測試商品","description":null,"price":299.00,"categoryId":11,"status":"DRAFT","available":10}
```

查詢的那一次，是從 `DECIMAL(12,2)` 讀回來的（scale = 2）。**沒有 `money()` 的話，同一個商品建立時是 `299`、查詢時是 `299.00`。** 有了 `money()`，建立的回應（3.5.1）與查詢的回應一樣是 `299.00`。

在 JSON 裡它們是同一個數字，看起來無害。但在 Java 裡：

```java
new BigDecimal("299").equals(new BigDecimal("299.00"))    // false —— equals 會比較 scale
new BigDecimal("299").compareTo(new BigDecimal("299.00")) // 0
```

第 04 章的 US-ORD-1 AC-6「客戶端帶的單價與資料庫不同 → 409 price-changed」就是一個價格比較。**用 `equals` 比，就會出現「價格明明一樣，卻說價格變了」**。第 04 章會實測它的影響。
本章先做兩件事：Entity 的 `money()` 把每一個進來的金額**正規化成 2 位小數**（`RoundingMode.UNNECESSARY`：超過 2 位會丟例外，但 DTO 的 `@Digits` 已經先擋了），以及購物車的 `priceChanged` 用 `compareTo`（3.6.1）。

### 3.5.3 `ProductService`

**先建一個 `Clock` bean。** `ProductService` 的建構子要一個 `java.time.Clock`，而第 02 章的專案裡沒有任何一個 —— 少了它，**所有** Spring context 都起不來（`No qualifying bean of type 'java.time.Clock'`）。
`shared/config/ClockConfig.java` 只有一個 `@Bean Clock clock() { return Clock.systemUTC(); }`（完整內容在 3.10.1）。為什麼不直接呼叫 `Instant.now()`？因為「現在」是一個**依賴**：第 04 章的付款逾時測試要把它換成一個固定的、可以快轉的時鐘。
`ProductService` 用到的 `PageResponse`（分頁回應的固定格式）、`CatalogApi`、`ProductSnapshot`、兩個 Repository 也都在 3.10.1。

```java
package com.example.shop.catalog.internal;

import com.example.shop.catalog.CatalogApi;
import com.example.shop.catalog.ProductSnapshot;
import com.example.shop.catalog.ProductStatus;
import com.example.shop.catalog.internal.ProductDtos.*;
import com.example.shop.inventory.InventoryApi;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import com.example.shop.shared.web.PageResponse;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Clock;
import java.util.*;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * catalog 模組的應用層。public 是因為 internal.web 的 Controller 要用它（1.4.3：子套件之間要 public），
 * 別的模組不能用它 —— ModuleBoundaryTest 規則二。別的模組只能用 CatalogApi。
 */
@Service
public class ProductService implements CatalogApi {

    private final ProductRepository products;
    private final CategoryRepository categories;
    private final InventoryApi inventory;
    private final Clock clock;

    ProductService(ProductRepository products, CategoryRepository categories, InventoryApi inventory, Clock clock) {
        this.products = products;
        this.categories = categories;
        this.inventory = inventory;
        this.clock = clock;
    }

    @Transactional
    public ProductDetail create(long sellerId, CreateProductRequest req) {
        Category category = categories.findById(req.categoryId())
                .orElseThrow(() -> new ShopException(ProblemType.VALIDATION, "分類不存在").with("field", "categoryId"));
        Product p = products.save(Product.draft(sellerId, category, req.name().strip(), req.description(), req.price(), clock.instant()));
        inventory.initialize(p.getId(), req.initialStock(), "product-created");      // 同一個交易（MANDATORY）
        return detailOf(p, req.initialStock());
    }

    @Transactional
    public ProductDetail update(long sellerId, long productId, UpdateProductRequest req) {
        Product p = owned(sellerId, productId);
        Category category = req.categoryId() == null ? null : categories.findById(req.categoryId())
                .orElseThrow(() -> new ShopException(ProblemType.VALIDATION, "分類不存在").with("field", "categoryId"));
        p.update(req.name() == null ? null : req.name().strip(), req.description(), req.price(), category, clock.instant());
        return detailOf(p, inventory.available(productId));
    }

    @Transactional
    public ProductDetail publish(long sellerId, long productId) {
        Product p = owned(sellerId, productId);
        p.publish(clock.instant());
        return detailOf(p, inventory.available(productId));
    }

    @Transactional
    public ProductDetail unpublish(long sellerId, long productId) {
        Product p = owned(sellerId, productId);
        if (!p.unpublish(clock.instant()))
            throw new ShopException(ProblemType.INVALID_STATE, "草稿狀態的商品不能下架").with("status", p.getStatus());   // ⚠️ 第 04 章 4.6.5：這個名字會跟 Problem Details 的 status 撞名
        return detailOf(p, inventory.available(productId));
    }

    @Transactional
    public ProductDetail restock(long sellerId, long productId, RestockRequest req) {
        owned(sellerId, productId);
        inventory.restock(productId, req.quantity(), req.note() == null ? "seller-restock" : "seller-restock:" + req.note());
        return detailOf(products.getReferenceById(productId), inventory.available(productId));
    }

    @Transactional(readOnly = true)
    public PageResponse<ProductSummary> search(SearchCriteria c, Pageable pageable) {
        Specification<Product> spec = Specification.where(ProductSpecs.onSale())
                .and(ProductSpecs.inCategory(c.categoryId()))
                .and(ProductSpecs.priceBetween(c.minPrice(), c.maxPrice()))
                .and(ProductSpecs.nameContains(c.q()));
        Page<Product> page = products.findAll(spec, pageable);
        return PageResponse.of(page, p -> new ProductSummary(p.getId(), p.getName(), p.getPrice(), p.getCategory().getId()));
    }

    /** US-PRD-3 AC-2：非 ON_SALE 的商品，只有賣家本人看得到；其他人一律 404（跟「不存在」長得一模一樣） */
    @Transactional(readOnly = true)
    public ProductDetail detail(long productId, Long viewerId) {
        Product p = products.findById(productId).orElseThrow(() -> ShopException.notFound("商品"));
        boolean visible = p.getStatus() == ProductStatus.ON_SALE || (viewerId != null && p.ownedBy(viewerId));
        if (!visible) throw ShopException.notFound("商品");
        return detailOf(p, inventory.available(productId));
    }

    @Transactional(readOnly = true)
    public PageResponse<SellerProductView> mine(long sellerId, Pageable pageable) {
        Page<Product> page = products.findBySellerId(sellerId, pageable);
        Map<Long, Integer> available = inventory.available(page.getContent().stream().map(Product::getId).toList());
        return PageResponse.of(page, p -> new SellerProductView(p.getId(), p.getName(), p.getPrice(), p.getStatus(),
                p.getCategory().getId(), available.getOrDefault(p.getId(), 0), p.getUpdatedAt()));
    }

    @Override
    @Transactional(readOnly = true)
    public Map<Long, ProductSnapshot> snapshots(Collection<Long> productIds) {
        if (productIds.isEmpty()) return Map.of();
        return products.findAllById(productIds).stream()
                .map(p -> new ProductSnapshot(p.getId(), p.getSellerId(), p.getName(), p.getPrice(), p.getStatus(), p.isHot()))
                .collect(Collectors.toMap(ProductSnapshot::id, Function.identity()));
    }

    /** US-PRD-1 AC-4：別人的商品 → 404，不是 403 */
    private Product owned(long sellerId, long productId) {
        return products.findById(productId).filter(p -> p.ownedBy(sellerId))
                .orElseThrow(() -> ShopException.notFound("商品"));
    }

    private static ProductDetail detailOf(Product p, int available) {
        return new ProductDetail(p.getId(), p.getSellerId(), p.getName(), p.getDescription(), p.getPrice(),
                p.getCategory().getId(), p.getStatus(), available);
    }
}
```

逐一對照需求：

| 方法 | 需求 | 怎麼做到的 |
|---|---|---|
| `create` | PRD-1 AC-1 | `Product.draft(sellerId, ...)` —— `sellerId` 是參數，不是 DTO 的欄位；`inventory.initialize()` 在同一個交易（3.3.3） |
| `create` / `update` | 分類不存在 | 400 `validation` 並指出 `field: categoryId` —— **不是**讓資料庫的外鍵擋（3.2.2 ②） |
| `owned()` | PRD-1 AC-4 | 別人的商品 → `ShopException.notFound("商品")`，跟「不存在」**一字不差** |
| `unpublish` | PRD-4 | `DRAFT` 不能下架 → 409 `invalid-state` |
| `detail` | PRD-3 AC-2 | 非 `ON_SALE` 的商品只有賣家本人看得到，其他人 404 |
| `mine` | —— | 一頁商品的可售庫存用 `inventory.available(ids)` **一次查完**（3.3.3） |
| `snapshots` | 給 cart、ordering | `findAllById` —— 一句 `WHERE id IN (...)` |

> 📌 **Service 的參數是 `long sellerId`，不是 `CurrentUser`。** 「目前使用者是誰」是 Web 層的事，Service 只需要「以誰的身分做這件事」。
> 這讓 Service 可以被排程、訊息消費者、測試直接呼叫，而不需要偽造一個 HTTP 身分。

### 3.5.4 搜尋：跳脫、排序白名單、頁面大小上限

```java
package com.example.shop.catalog.internal;

import com.example.shop.catalog.ProductStatus;
import org.springframework.data.jpa.domain.Specification;

import java.math.BigDecimal;

/** US-PRD-2 的搜尋條件。每一個條件都是可選的；null 就不加。 */
final class ProductSpecs {

    private ProductSpecs() {}

    static Specification<Product> onSale() {
        return (root, q, cb) -> cb.equal(root.get("status"), ProductStatus.ON_SALE);
    }

    static Specification<Product> inCategory(Long categoryId) {
        return categoryId == null ? null : (root, q, cb) -> cb.equal(root.get("category").get("id"), categoryId);
    }

    static Specification<Product> priceBetween(BigDecimal min, BigDecimal max) {
        return (root, q, cb) -> {
            if (min == null && max == null) return null;
            if (min == null) return cb.lessThanOrEqualTo(root.get("price"), max);
            if (max == null) return cb.greaterThanOrEqualTo(root.get("price"), min);
            return cb.between(root.get("price"), min, max);
        };
    }

    /** US-PRD-2 AC-4：% 與 _ 是字面字元，不是萬用字元 */
    static Specification<Product> nameContains(String keyword) {
        if (keyword == null || keyword.isBlank()) return null;
        String pattern = "%" + escapeLike(keyword.strip()) + "%";
        return (root, q, cb) -> cb.like(root.get("name"), pattern, '\\');
    }

    /** 把 LIKE 的三個特殊字元（跳脫字元本身、%、_）前面都加上跳脫字元 */
    static String escapeLike(String s) {
        return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
    }
}
```

`escapeLike` 處理三個字元：**跳脫字元本身**（`\`）、`%`、`_`，而且**順序很重要** —— 先處理 `\`，否則後面加上的 `\` 會被再跳脫一次。
`cb.like(..., pattern, '\\')` 的第三個參數告訴資料庫「`\` 是跳脫字元」，產生的 SQL 是 `like ? escape '\'`。3.9 的測試用「`100% 純棉`」與「`zq_`」兩個關鍵字守著它。

> 📌 `inCategory` 只比對**完全相同**的分類 id。種子資料的商品都在葉分類（`11`、`12`、`21`……，2.8.2），所以 `categoryId=3`（頂層的「居家生活」）會回傳 **0 筆** —— 0.4.3 US-PRD-2 AC-1 的範例請求用的正是 `categoryId=3`。
> 本專題的決定是「篩選只比對葉分類」；要讓頂層分類也能篩，條件要改成 `category.id = ? OR category.parent.id = ?`。`create` 目前也不擋把商品建在頂層分類下，這是同一個決定的另一面。

**排序白名單**：

```java
package com.example.shop.shared.web;

import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;

import java.util.Set;

/**
 * US-PRD-2 AC-3：只允許白名單上的排序欄位。
 * 不在白名單上的欄位，就算 Entity 上真的有（例如 description），也一律 400 —— 客戶端不該能決定「用哪個沒有索引的欄位排序」。
 */
public final class SortWhitelist {

    private SortWhitelist() {}

    public static Pageable check(Pageable pageable, Set<String> allowed) {
        for (Sort.Order o : pageable.getSort()) {
            if (!allowed.contains(o.getProperty())) {
                throw new ShopException(ProblemType.VALIDATION, "不支援的排序欄位")
                        .with("errors", java.util.List.of(java.util.Map.of("field", "sort", "message", "可用的排序欄位：" + String.join("、", allowed))));
            }
        }
        return pageable;
    }
}
```

US-PRD-2 AC-3 只要求「不存在的欄位 → 400」。白名單更嚴格：**存在但不在清單上的欄位也是 400**。`sort=description` —— `description` 是真的欄位，但它是 `TEXT`、沒有索引，對 1 萬個商品排序就是一次 filesort。
**客戶端不應該能決定「用哪一個沒有索引的欄位排序」。**

> 📌 錯誤訊息裡的「可用的排序欄位：createdAt、price、name」是 `String.join("、", allowed)` 組出來的，而 `Set.of(...)` 的迭代順序**每次 JVM 啟動都可能不同**。你看到的順序可能跟 3.2.2 的輸出不一樣；想要固定，就在 join 之前排序（例如 `new TreeSet<>(allowed)`）。

**頁面大小上限**（US-PRD-2 AC-2：`size=500` 以 100 處理，不回 400）：一行設定。

```yaml
spring:
  data:
    web:
      pageable:
        max-page-size: 100         # US-PRD-2 AC-2：size=500 以 100 處理（不回 400）
```

```bash
curl -s "localhost:8080/api/products?size=500" | jq '.size, .totalElements'
# 100
# 9486
```

### 3.5.5 Controller：只做 HTTP 的事

```java
package com.example.shop.catalog.internal.web;

import com.example.shop.catalog.internal.ProductDtos.ProductDetail;
import com.example.shop.catalog.internal.ProductDtos.ProductSummary;
import com.example.shop.catalog.internal.ProductDtos.SearchCriteria;
import com.example.shop.catalog.internal.ProductService;
import com.example.shop.shared.web.CurrentUser;
import com.example.shop.shared.web.PageResponse;
import com.example.shop.shared.web.SortWhitelist;
import io.swagger.v3.oas.annotations.Parameter;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Size;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springdoc.core.annotations.ParameterObject;
import org.springframework.data.web.PageableDefault;
import org.springframework.web.bind.annotation.*;

import java.math.BigDecimal;
import java.util.Optional;
import java.util.Set;

/** 公開的商品 API：瀏覽不需要登入（US-PRD-2 AC-5） */
@RestController
@RequestMapping("/api/products")
class ProductController {

    static final Set<String> SORTABLE = Set.of("price", "createdAt", "name");

    private final ProductService service;

    ProductController(ProductService service) { this.service = service; }

    @GetMapping
    PageResponse<ProductSummary> search(@RequestParam(required = false) @Size(max = 50, message = "關鍵字最多 50 字") String q,
                                        @RequestParam(required = false) Long categoryId,
                                        @RequestParam(required = false) @DecimalMin(value = "0", message = "價格下限不可為負") BigDecimal minPrice,
                                        @RequestParam(required = false) @DecimalMin(value = "0", message = "價格上限不可為負") BigDecimal maxPrice,
                                        @ParameterObject @PageableDefault(size = 20, sort = "createdAt", direction = Sort.Direction.DESC) Pageable pageable) {
        return service.search(new SearchCriteria(q, categoryId, minPrice, maxPrice), SortWhitelist.check(pageable, SORTABLE));
    }

    @GetMapping("/{id}")
    ProductDetail detail(@PathVariable long id, @Parameter(hidden = true) Optional<CurrentUser> user) {
        return service.detail(id, user.map(CurrentUser::id).orElse(null));
    }
}
```

```java
package com.example.shop.catalog.internal.web;

import com.example.shop.catalog.internal.ProductDtos.*;
import com.example.shop.catalog.internal.ProductService;
import com.example.shop.shared.web.CurrentUser;
import com.example.shop.shared.web.PageResponse;
import com.example.shop.shared.web.Role;
import com.example.shop.shared.web.SortWhitelist;
import jakarta.validation.Valid;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springdoc.core.annotations.ParameterObject;
import org.springframework.data.web.PageableDefault;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

import java.util.Set;

/** 賣家的商品管理（US-PRD-1、4、5）。每一支都先確認角色，再由 Service 確認「是不是你的商品」 */
@RestController
@RequestMapping("/api/seller/products")
class SellerProductController {

    private final ProductService service;

    SellerProductController(ProductService service) { this.service = service; }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    ProductDetail create(CurrentUser user, @Valid @RequestBody CreateProductRequest req) {
        return service.create(user.require(Role.SELLER).id(), req);
    }

    @PatchMapping("/{id}")
    ProductDetail update(CurrentUser user, @PathVariable long id, @Valid @RequestBody UpdateProductRequest req) {
        return service.update(user.require(Role.SELLER).id(), id, req);
    }

    @PostMapping("/{id}/publish")
    ProductDetail publish(CurrentUser user, @PathVariable long id) {
        return service.publish(user.require(Role.SELLER).id(), id);
    }

    @PostMapping("/{id}/unpublish")
    ProductDetail unpublish(CurrentUser user, @PathVariable long id) {
        return service.unpublish(user.require(Role.SELLER).id(), id);
    }

    @PostMapping("/{id}/restock")
    ProductDetail restock(CurrentUser user, @PathVariable long id, @Valid @RequestBody RestockRequest req) {
        return service.restock(user.require(Role.SELLER).id(), id, req);
    }

    @GetMapping
    PageResponse<SellerProductView> mine(CurrentUser user,
                                         @ParameterObject @PageableDefault(size = 20, sort = "createdAt", direction = Sort.Direction.DESC) Pageable pageable) {
        return service.mine(user.require(Role.SELLER).id(), SortWhitelist.check(pageable, Set.of("createdAt", "price", "name")));
    }
}
```

Controller 裡**沒有任何業務判斷**：取出目前使用者、檢查角色、把參數交給 Service、回傳 Service 給的 DTO。
`@ParameterObject` 與 `@Parameter(hidden = true)` 是給 OpenAPI 文件看的，3.8.1 會說明為什麼需要它們。

---

## 3.6 購物車與訂單查詢

### 3.6.1 購物車：一句 upsert，以及一個接不到的例外

```java
package com.example.shop.cart.internal;

import com.example.shop.cart.internal.CartDtos.*;
import com.example.shop.catalog.CatalogApi;
import com.example.shop.catalog.ProductSnapshot;
import com.example.shop.inventory.InventoryApi;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import com.example.shop.shared.error.ConstraintViolations;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.util.*;

/**
 * 購物車。只有一張表、沒有關聯、寫入需要「不存在就新增、存在就相加」—— 這正是 JPA 表達不好的東西，
 * 所以這個模組直接用 JdbcTemplate（08-jpa-mybatis/09 的選型：用最能表達這個操作的工具）。
 */
@Service
public class CartService {

    static final int MAX_DISTINCT_ITEMS = 50;          // US-CART-1 AC-3

    private final JdbcTemplate jdbc;
    private final CatalogApi catalog;
    private final InventoryApi inventory;

    CartService(JdbcTemplate jdbc, CatalogApi catalog, InventoryApi inventory) {
        this.jdbc = jdbc;
        this.catalog = catalog;
        this.inventory = inventory;
    }

    record Row(long productId, int quantity, BigDecimal priceAtAdd) {}

    List<Row> rows(long buyerId) {
        return jdbc.query("SELECT product_id, quantity, unit_price_at_add FROM cart_items WHERE buyer_id = ? ORDER BY added_at, product_id",
                (rs, i) -> new Row(rs.getLong(1), rs.getInt(2), rs.getBigDecimal(3)), buyerId);
    }

    /** US-CART-1 AC-1：已存在就數量相加。一句 SQL，沒有「先查再寫」的競態（3.6.1） */
    @Transactional
    public CartView add(long buyerId, AddItemRequest req) {
        ProductSnapshot p = catalog.snapshots(List.of(req.productId())).get(req.productId());
        if (p == null || !p.purchasable()) throw new ShopException(ProblemType.PRODUCT_UNAVAILABLE, "商品目前無法購買").with("productId", req.productId());
        Integer distinct = jdbc.queryForObject("SELECT COUNT(*) FROM cart_items WHERE buyer_id = ? AND product_id <> ?",
                Integer.class, buyerId, req.productId());
        if (distinct >= MAX_DISTINCT_ITEMS)
            throw new ShopException(ProblemType.VALIDATION, "購物車最多 " + MAX_DISTINCT_ITEMS + " 種商品");
        try {
            jdbc.update("""
                    INSERT INTO cart_items (buyer_id, product_id, quantity, unit_price_at_add) VALUES (?, ?, ?, ?) AS new
                    ON DUPLICATE KEY UPDATE quantity = cart_items.quantity + new.quantity, updated_at = CURRENT_TIMESTAMP(3)""",
                    buyerId, req.productId(), req.quantity(), p.price());
        } catch (DataAccessException e) {
            // 相加之後超過 99：由 ck_cart_items_quantity 在資料庫裡原子地判斷（兩個請求同時加，也只會有一個成功）。
            // 注意接的是 DataAccessException：CHECK 違反在 Spring 眼中是 UncategorizedSQLException，不是 DataIntegrityViolationException（3.6.1）
            if (!ConstraintViolations.isViolationOf(e, "ck_cart_items_quantity")) throw e;
            throw new ShopException(ProblemType.VALIDATION, "同一個商品最多 99 件").with("productId", req.productId());
        }
        return view(buyerId);
    }

    @Transactional
    public CartView change(long buyerId, long productId, ChangeQuantityRequest req) {
        int n = jdbc.update("UPDATE cart_items SET quantity = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE buyer_id = ? AND product_id = ?",
                req.quantity(), buyerId, productId);
        if (n == 0) throw ShopException.notFound("購物車品項");
        return view(buyerId);
    }

    @Transactional
    public CartView remove(long buyerId, long productId) {
        jdbc.update("DELETE FROM cart_items WHERE buyer_id = ? AND product_id = ?", buyerId, productId);   // 冪等：刪不存在的也回 200
        return view(buyerId);
    }

    /** US-CART-2：最新的價格、可購買狀態、庫存提示，依賣家分組 */
    @Transactional(readOnly = true)
    public CartView view(long buyerId) {
        List<Row> rows = rows(buyerId);
        List<Long> ids = rows.stream().map(Row::productId).toList();
        Map<Long, ProductSnapshot> products = catalog.snapshots(ids);      // 一句 SQL（不是每個品項一句）
        Map<Long, Integer> available = inventory.available(ids);          // 一句 SQL
        Map<Long, List<CartLine>> bySeller = new LinkedHashMap<>();
        for (Row r : rows) {
            ProductSnapshot p = products.get(r.productId());
            if (p == null) continue;                                       // 商品不存在（本專題不硬刪，理論上不會發生）
            boolean changed = p.price().compareTo(r.priceAtAdd()) != 0;    // compareTo，不是 equals（第 04 章會看到為什麼）
            List<String> warnings = new ArrayList<>();
            if (available.getOrDefault(p.id(), 0) < r.quantity()) warnings.add("INSUFFICIENT_STOCK");   // AC-5：提醒，不擋
            bySeller.computeIfAbsent(p.sellerId(), k -> new ArrayList<>()).add(new CartLine(p.id(), p.name(), p.price(), r.quantity(),
                    changed, changed ? r.priceAtAdd() : null, !p.purchasable(), warnings));
        }
        List<SellerGroup> groups = bySeller.entrySet().stream().map(e -> new SellerGroup(e.getKey(), e.getValue(),
                e.getValue().stream().filter(l -> !l.unavailable())
                        .map(l -> l.unitPrice().multiply(BigDecimal.valueOf(l.quantity()))).reduce(BigDecimal.ZERO, BigDecimal::add))).toList();
        return new CartView(groups, rows.size());
    }
}
```

（`CartDtos` —— `AddItemRequest`、`ChangeQuantityRequest`、`CartLine`、`SellerGroup`、`CartView` —— 與 `CartController` 的完整內容在 3.10.1。測試會直接斷言 JSON 的欄位名：`groups`、`items`、`unitPrice`、`priceChanged`、`previousPrice`、`unavailable`、`warnings`。）

**`add` 是一句 SQL**：

```sql
INSERT INTO cart_items (buyer_id, product_id, quantity, unit_price_at_add) VALUES (?, ?, ?, ?) AS new
ON DUPLICATE KEY UPDATE quantity = cart_items.quantity + new.quantity, updated_at = CURRENT_TIMESTAMP(3)
```

2.3.2 的複合主鍵 `(buyer_id, product_id)` 讓它成立：同一個買家、同一個商品已經有一列時，走 `UPDATE` 分支把數量相加。
**沒有「先 SELECT 看看有沒有、再決定 INSERT 或 UPDATE」**—— 那種寫法在使用者連點兩次「加入購物車」時，兩個請求都會看到「沒有」、都去 INSERT，第二個撞上主鍵重複 → 500。
（`AS new` 是 MySQL 8.0.19 起的寫法；舊的 `VALUES(quantity)` 在 8.0.20 起被標為 deprecated。）

**相加之後超過 99 呢？** 讓 2.3.2 的 `ck_cart_items_quantity CHECK (quantity BETWEEN 1 AND 99)` 在資料庫裡判斷 —— 兩個請求同時加，**也只會有一個成功**，因為 CHECK 是在寫入的那一刻、拿著行鎖檢查的。

**第一版是這樣接的**：

```java
        } catch (DataIntegrityViolationException e) {
            throw new ShopException(ProblemType.VALIDATION, "同一個商品最多 99 件").with("productId", req.productId());
        }
```

實測（先加 2 件，再加 98 件）：

```json
{"type":"/problems/internal","title":"系統發生錯誤","status":500,"detail":"系統發生錯誤，請稍後再試","instance":"/api/cart/items"}
```

**500，不是 400。** 日誌：

```
ERROR c.e.s.shared.web.GlobalExceptionHandler  : 未預期的例外
org.springframework.jdbc.UncategorizedSQLException: PreparedStatementCallback; uncategorized SQLException for SQL [INSERT INTO cart_items (buyer_id, product_id, quantity, unit_price_at_add) VALUES (?, ?, ?, ?) AS new ...
Caused by: java.sql.SQLException: Check constraint 'ck_cart_items_quantity' is violated.
```

**`UncategorizedSQLException`，不是 `DataIntegrityViolationException`。** Spring 的 `SQLErrorCodeSQLExceptionTranslator` 用 MySQL 的錯誤碼決定要翻譯成哪一個例外：
UNIQUE 違反（1062）→ `DuplicateKeyException`、外鍵違反（1452）→ `DataIntegrityViolationException` —— 但 **CHECK 違反（3819，SQLState `HY000`）不在它的表上**，所以變成「未分類」。

2.5.2 的 22 個案例裡，**有 15 個是被 CHECK 擋下的**。每一個「接 `DataIntegrityViolationException` 來處理約束違反」的地方，對這 15 種都是無效的。

**修正**：接 `DataAccessException`（所有 Spring 資料存取例外的父類別），再用一個小工具看**最底層的 `SQLException`** 是不是「這個約束」：

```java
package com.example.shop.shared.error;

import java.sql.SQLException;

/**
 * 3.6.1：判斷一個例外是不是「某一個具名約束」被違反了。
 *
 * 為什麼需要它：Spring 把 MySQL 的 UNIQUE 違反（1062）翻譯成 DuplicateKeyException、外鍵違反（1452）翻譯成
 * DataIntegrityViolationException —— 但 CHECK 違反（3819，SQLState HY000）它不認得，翻譯成 UncategorizedSQLException。
 * 所以「接 DataIntegrityViolationException」接不到 CHECK。這裡直接看最底層的 SQLException。
 */
public final class ConstraintViolations {

    static final int ER_DUP_ENTRY = 1062;
    static final int ER_CHECK_CONSTRAINT_VIOLATED = 3819;

    private ConstraintViolations() {}

    /**
     * 1062：Duplicate entry 'x' for key 'orders.uk_orders_order_no'
     * 3819：Check constraint 'ck_cart_items_quantity' is violated.
     */
    public static boolean isViolationOf(Throwable e, String constraintName) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (t instanceof SQLException sql && sql.getMessage() != null
                    && (sql.getErrorCode() == ER_CHECK_CONSTRAINT_VIOLATED || sql.getErrorCode() == ER_DUP_ENTRY)
                    && (sql.getMessage().contains("'" + constraintName + "'") || sql.getMessage().contains("." + constraintName + "'"))) {
                return true;
            }
        }
        return false;
    }
}
```

```json
{"type":"/problems/validation","title":"請求內容不正確","status":400,"detail":"同一個商品最多 99 件","instance":"/api/cart/items","productId":1}
```

**`throw e` 那一行很重要**：如果不是這個約束（例如資料庫斷線），就原樣丟出去，讓 `GlobalExceptionHandler` 記日誌、回 500。**只把你認得的錯誤翻譯成業務錯誤。**

> 📌 **50 種商品的上限（AC-3）不在資料庫裡**，是 `add` 開頭的一句 `COUNT(*)`。它是「先查再寫」，所以在極端的併發下（同一個買家同時送出兩個加入不同商品的請求）可能變成 51 種。
> 這是一個**刻意接受的**軟上限：它的目的是擋住濫用（腳本塞 10,000 個商品），不是精確到個位數。**寫下來它是軟的**，比假裝它是硬的好。
> ⚠️ **這一章沒有替 AC-3 寫測試**（3.9.1 的追溯表只列了 AC-1、AC-2、AC-5）。
> 補上的測試 `CatalogCartApiTest.cartDistinctItemLimit` 實測第 51 種商品回 **400** `/problems/validation`，`detail` 是「購物車最多 50 種商品」；參考實作的 `ch03`～`ch09` 分支上都沒有這個測試。

**`view` 的三句 SQL**：購物車的列（1 句）、這些商品的快照（`CatalogApi.snapshots`，1 句）、可售庫存（`InventoryApi.available`，1 句）。
**不管購物車有幾個品項，都是 3 句。** 跨模組的 N+1（每個品項各呼叫一次 `CatalogApi`）在這裡被介面的形狀擋掉了：`CatalogApi` 只提供「一次查多個」的方法。

### 3.6.2 訂單查詢：一頁固定 3 句 SQL

3.2.1 的四種失敗之後，正確的做法其實很樸素 —— **兩次查詢，在 Java 裡組起來**：

```java
package com.example.shop.ordering.internal;

import com.example.shop.ordering.OrderStatus;
import com.example.shop.ordering.internal.OrderDtos.OrderLineView;
import com.example.shop.ordering.internal.OrderDtos.OrderView;
import com.example.shop.shared.error.ShopException;
import com.example.shop.shared.web.PageResponse;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * 訂單的查詢面（US-ORD-5）。寫入面（下單、狀態轉移）在第 04 章。
 * 一頁訂單固定 3 句 SQL：訂單、總數、這一頁所有訂單的明細（驗收 Q4）。
 */
@Service
public class OrderQueryService {

    static final Sort NEWEST_FIRST = Sort.by(Sort.Direction.DESC, "createdAt");

    private final OrderRepository orders;
    private final OrderItemRepository items;

    OrderQueryService(OrderRepository orders, OrderItemRepository items) {
        this.orders = orders;
        this.items = items;
    }

    @Transactional(readOnly = true)
    public PageResponse<OrderView> buyerOrders(long buyerId, OrderStatus status, int page, int size) {
        PageRequest pr = PageRequest.of(page, size, NEWEST_FIRST);
        return withItems(status == null ? orders.findByBuyerId(buyerId, pr) : orders.findByBuyerIdAndStatus(buyerId, status, pr));
    }

    @Transactional(readOnly = true)
    public PageResponse<OrderView> sellerOrders(long sellerId, OrderStatus status, int page, int size) {
        PageRequest pr = PageRequest.of(page, size, NEWEST_FIRST);
        return withItems(status == null ? orders.findBySellerId(sellerId, pr) : orders.findBySellerIdAndStatus(sellerId, status, pr));
    }

    /** US-ORD-5 AC-3：別人的訂單 → 404，跟「不存在」一模一樣（稽核日誌在第 05 章加上） */
    @Transactional(readOnly = true)
    public OrderView buyerOrder(long buyerId, String orderNo) {
        Order o = orders.findByOrderNo(orderNo).filter(x -> x.getBuyerId() == buyerId)
                .orElseThrow(() -> ShopException.notFound("訂單"));
        return view(o, items.findByOrderIds(List.of(o.getId())));
    }

    private PageResponse<OrderView> withItems(Page<Order> page) {
        List<Long> ids = page.getContent().stream().map(Order::getId).toList();
        Map<Long, List<OrderItem>> byOrder = ids.isEmpty() ? Map.of()
                : items.findByOrderIds(ids).stream().collect(Collectors.groupingBy(OrderItem::orderId));
        return PageResponse.of(page, page.getContent().stream()
                .map(o -> view(o, byOrder.getOrDefault(o.getId(), List.of()))).toList());
    }

    private static OrderView view(Order o, List<OrderItem> lines) {
        return new OrderView(o.getOrderNo(), o.getStatus(), o.getTotalAmount(), o.getCreatedAt(), o.getPaymentDeadline(),
                lines.stream().map(i -> new OrderLineView(i.getProductId(), i.getProductName(), i.getUnitPrice(),
                        i.getQuantity(), i.getLineAmount())).toList());
    }
}
```

```java
package com.example.shop.ordering.internal;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.Collection;
import java.util.List;

interface OrderItemRepository extends JpaRepository<OrderItem, Long> {

    /** 一頁訂單的所有明細，一句 SQL（3.6.2） */
    @Query("select i from OrderItem i where i.order.id in :orderIds order by i.id")
    List<OrderItem> findByOrderIds(@Param("orderIds") Collection<Long> orderIds);
}
```

```
① SELECT ... FROM orders WHERE buyer_id = ? ORDER BY created_at DESC LIMIT ?        ← 這一頁的訂單（idx_orders_buyer_created，2.7.2）
② SELECT COUNT(o.id) FROM orders o WHERE o.buyer_id = ?                            ← 總數（Spring Data 為分頁自動產生）
③ SELECT ... FROM order_items WHERE order_id IN (?, ?, ..., ?) ORDER BY id           ← 這一頁「所有」訂單的明細，一句
```

**`LIMIT` 在 ① 上，是對訂單分頁**，不是對「訂單 × 明細」的列分頁 —— 3.2.1 ④ 那個在記憶體裡分頁的問題不存在。③ 的 `IN` 最多 100 個 id（頁面大小的上限）。
`OrderItem.orderId()` 對 `order` 這個 LAZY 關聯取 id —— Hibernate 的 proxy **取 id 不會觸發載入**，所以組裝時不會多出任何 SQL。這是本章在 `OrderItem` 加的唯一一行：

```java
    Long orderId() { return order.getId(); }       // 對 proxy 取 id 不會觸發載入
```

`OrderDtos`（`OrderView`、`OrderLineView`）、`OrderRepository`、`OrderQueryController`（`/api/orders`、`/api/orders/{orderNo}`、`/api/seller/orders`）的完整內容在 3.10.1。

整個方法在 `@Transactional(readOnly = true)` 裡，**回傳的是已經組好的 `OrderView` record**。Jackson 序列化的時候，交易已經結束、Session 已經關了 —— 而它不需要任何 Session。

### 3.6.3 驗收 Q4

打開 `CapstoneAcceptanceTest`，**拿掉 `q4_noNPlusOne` 上的 `@Disabled("ch03 / ch08：N+1")`**，把空的方法本體換成下面這段。檔案開頭要多 9 個 import：

```java
import jakarta.persistence.EntityManagerFactory;
import org.hibernate.SessionFactory;
import org.hibernate.stat.Statistics;
import org.springframework.boot.web.context.WebServerApplicationContext;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
```

（再加上 `org.springframework.jdbc.core.JdbcTemplate` 與 AssertJ 的 `assertThat` —— 第 02 章的 Q6 已經用到它們，如果你的檔案裡已經有，就不用重複。）

```java
    @Test
    @DisplayName("Q4 訂單列表一頁 20 筆：SQL 次數固定，不隨筆數成長")
    void q4_noNPlusOne() throws Exception {
        long buyer = 990_004L;                                             // 專屬這個測試的買家，結束時清掉
        try (var ctx = new SpringApplicationBuilder(ShopApplication.class).run("--server.port=0",
                "--spring.jpa.properties.hibernate.generate_statistics=true",
                "--spring.main.banner-mode=off", "--logging.level.root=WARN")) {
            JdbcTemplate jdbc = ctx.getBean(JdbcTemplate.class);
            try {
                for (int i = 1; i <= 45; i++) {                             // US-ORD-5 AC-1：一位有 45 張訂單的買家
                    jdbc.update("""
                            INSERT INTO orders (id, order_no, buyer_id, seller_id, status, total_amount, payment_deadline, created_at)
                            VALUES (?, ?, ?, 2, 'PENDING_PAYMENT', 300, NOW(3), NOW(3) - INTERVAL ? MINUTE)""",
                            9_904_000L + i, "20990104-9%05d".formatted(i), buyer, i);
                    for (int k = 1; k <= 3; k++)
                        jdbc.update("INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity) VALUES (?, ?, 'q4', 100, 1)",
                                9_904_000L + i, k);
                }
                Statistics stats = ctx.getBean(EntityManagerFactory.class).unwrap(SessionFactory.class).getStatistics();
                int port = ((WebServerApplicationContext) ctx).getWebServer().getPort();
                HttpClient http = HttpClient.newHttpClient();
                for (int size : new int[]{5, 20, 45}) {
                    stats.clear();
                    HttpResponse<String> r = http.send(HttpRequest.newBuilder(URI.create(
                                    "http://localhost:" + port + "/api/orders?page=0&size=" + size))
                            .header("X-Debug-User-Id", String.valueOf(buyer)).build(), HttpResponse.BodyHandlers.ofString());
                    int orders = r.body().split("\"orderNo\"", -1).length - 1;
                    int items = r.body().split("\"productName\"", -1).length - 1;
                    System.out.printf("Q4：size=%-3d → HTTP %d，%d 張訂單、%d 個明細，SQL %d 句%n",
                            size, r.statusCode(), orders, items, stats.getPrepareStatementCount());
                    assertThat(r.statusCode()).isEqualTo(200);
                    assertThat(orders).isEqualTo(size);
                    assertThat(items).isEqualTo(size * 3);
                    assertThat(stats.getPrepareStatementCount()).as("US-ORD-5 AC-2：SQL 次數 ≤ 3").isLessThanOrEqualTo(3);
                }
            } finally {
                jdbc.update("DELETE i FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.buyer_id = ?", buyer);
                jdbc.update("DELETE FROM orders WHERE buyer_id = ?", buyer);
            }
        }
    }
```

**它量的是「SQL 次數不隨頁面大小成長」**：同一位買家（45 張訂單、每張 3 個明細），`size` 分別是 5、20、45。
Hibernate 的 `Statistics.getPrepareStatementCount()` 數的是**這段期間準備了幾句 SQL** —— 它不在乎是誰觸發的（Repository、lazy load、Jackson），全部算進去。

```
Q4：size=5   → HTTP 200，5 張訂單、15 個明細，SQL 3 句
Q4：size=20  → HTTP 200，20 張訂單、60 個明細，SQL 3 句
Q4：size=45  → HTTP 200，45 張訂單、135 個明細，SQL 3 句
```

**5、20、45 筆都是 3 句。** 3.2.1 ③ 的寫法在這裡會是 7、22、47。

> 📌 **為什麼用真的 HTTP，而不是直接呼叫 `OrderQueryService`？** 因為 3.2.1 ③ 的 N+1 發生在 **Jackson 序列化的時候** —— 直接呼叫 Service，那一段根本不會執行。
> **驗收測試要量的是使用者經歷的整條路徑。** 這也是為什麼它啟動一個真的 Tomcat（`server.port=0`），而不是用 MockMvc 呼叫。

> 📌 測試資料用一個專屬的買家 id（`990_004`）寫進 `shop`，`finally` 裡刪掉。第 08 章改用 Testcontainers 之後，整次建置共用一組容器，這種清理仍然需要（8.5）。


---

## 3.7 報表：MyBatis

### 3.7.1 賣家日報表

0.9.2 ② 的選型在這裡落地：**寫入走 JPA，報表走 MyBatis**。報表是「一句你要看得到、調得動的 SQL」，而且它要跨模組讀 `orders` 與 `refunds` —— 0.3.4 唯一被允許的例外。

```xml
<dependency>
  <groupId>org.mybatis.spring.boot</groupId>
  <artifactId>mybatis-spring-boot-starter</artifactId>
  <version>3.0.3</version>
</dependency>
```

```yaml
mybatis:
  mapper-locations: classpath:mapper/**/*.xml
  configuration:
    local-cache-scope: statement   # 3.7.2：同一個交易裡 JPA 寫、MyBatis 讀時，不要讓 MyBatis 回傳快取的舊值
```

（`local-cache-scope` 的理由在 3.7.2。）

```java
package com.example.shop.reporting.internal;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;

/** SQL 在 resources/mapper/reporting/SalesReportMapper.xml。reporting 是唯一可以跨模組「讀」表的模組（0.3.4） */
@Mapper
interface SalesReportMapper {

    record DailyRow(LocalDate day, long orderCount, BigDecimal paidAmount, BigDecimal refundAmount) {}

    List<DailyRow> dailySales(@Param("sellerId") long sellerId, @Param("fromUtc") Instant fromUtc, @Param("toUtc") Instant toUtc);
}
```

```xml
<?xml version="1.0" encoding="UTF-8" ?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "https://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="com.example.shop.reporting.internal.SalesReportMapper">

  <resultMap id="dailyRow" type="com.example.shop.reporting.internal.SalesReportMapper$DailyRow">
    <constructor>
      <arg column="day" javaType="java.time.LocalDate"/>
      <arg column="order_count" javaType="_long"/>
      <arg column="paid_amount" javaType="java.math.BigDecimal"/>
      <arg column="refund_amount" javaType="java.math.BigDecimal"/>
    </constructor>
  </resultMap>

  <!--
    US-RPT-1：賣家日報表。三個數字各自依「發生的那一刻」歸到台北時間的某一天：
      訂單數 = 當天成立的訂單（created_at）
      付款   = 當天付款成功的金額（paid_at）
      退款   = 當天完成的退款（refunds.created_at）
    範圍條件一律寫成 `欄位 >= 起點 AND 欄位 < 終點`，起點與終點由 Java 換算成 UTC —— 欄位上不套函式，才用得到索引（3.2.4、3.7.1）。
    台灣沒有日光節約時間，所以分組時用固定的 '+08:00'；有日光節約的時區要改用具名時區（需要 MySQL 載入時區表）。
  -->
  <select id="dailySales" resultMap="dailyRow">
    SELECT day,
           SUM(order_count)   AS order_count,
           SUM(paid_amount)   AS paid_amount,
           SUM(refund_amount) AS refund_amount
      FROM (
            SELECT DATE(CONVERT_TZ(o.created_at, '+00:00', '+08:00')) AS day,
                   COUNT(*) AS order_count, 0 AS paid_amount, 0 AS refund_amount
              FROM orders o
             WHERE o.seller_id = #{sellerId}
               AND o.created_at &gt;= #{fromUtc} AND o.created_at &lt; #{toUtc}
             GROUP BY day
            UNION ALL
            SELECT DATE(CONVERT_TZ(o.paid_at, '+00:00', '+08:00')) AS day,
                   0, SUM(o.total_amount), 0
              FROM orders o
             WHERE o.seller_id = #{sellerId}
               AND o.created_at &gt;= #{fromUtc} - INTERVAL 1 DAY AND o.created_at &lt; #{toUtc}   <!-- 讓 (seller_id, created_at) 索引能用：付款一定在成立之後 15 分鐘內 -->
               AND o.paid_at &gt;= #{fromUtc} AND o.paid_at &lt; #{toUtc}
             GROUP BY day
            UNION ALL
            SELECT DATE(CONVERT_TZ(r.created_at, '+00:00', '+08:00')) AS day,
                   0, 0, SUM(r.amount)
              FROM refunds r
              JOIN orders o ON o.id = r.order_id
             WHERE o.seller_id = #{sellerId}
               AND r.status = 'SUCCEEDED'
               AND r.created_at &gt;= #{fromUtc} AND r.created_at &lt; #{toUtc}
             GROUP BY day
           ) x
     GROUP BY day
     ORDER BY day
  </select>
</mapper>
```

**這句 SQL 裡的三個決定**：

1. **三個數字各自依「發生的那一刻」歸日**。「9 月 1 日的營收」是 9 月 1 日**成立**的訂單金額，還是 9 月 1 日**付款**的金額？退款算在訂單成立那天，還是退款完成那天？
   0.4.7 的 AC-1 只說「已付款金額、退款金額、淨額」—— **這是一個需求沒寫清楚的地方**。本專題選「現金基礎」：錢在哪一天進來、哪一天出去，就算哪一天。這個決定寫在 SQL 的註解裡，也應該回寫到 0.4.7。
   ⚠️ 退款那一段用的是 `refunds.created_at` —— 那是**建立退款請求**的時間，不是退款**成功**的時間（退款會重試，`refunds` 有 `attempts`）。SQL 註解寫的「當天完成的退款」並不精確；要做到真正的現金基礎，要改用成功那一刻的時間（例如 `updated_at`，或另加一個成功時間欄位）。
2. **範圍條件永遠是 `欄位 >= ? AND 欄位 < ?`**，邊界在 Java 算（3.2.4 寫法三）。`GROUP BY` 裡的 `CONVERT_TZ` 沒關係 —— 分組是對**已經篩選出來的列**做的，不影響用不用得到索引。
3. **付款的那一段多了一個 `created_at` 的條件**：`paid_at` 沒有索引，只有 `(seller_id, created_at)`。付款一定發生在成立之後 15 分鐘內（US-ORD-3），所以「成立時間在 `[起點 − 1 天, 終點)`」是一個**一定成立、而且用得到索引**的額外條件。
   它不改變結果，只讓 MySQL 能用 `range` 掃描而不是掃這個賣家的全部訂單。

```java
package com.example.shop.reporting.internal;

import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

@Service
public class SalesReportService {

    /** US-RPT-1 AC-2：以台北的日曆日為準 */
    static final ZoneId REPORT_ZONE = ZoneId.of("Asia/Taipei");
    static final int MAX_DAYS = 366;                                        // AC-3

    public record DailySales(LocalDate day, long orderCount, BigDecimal paidAmount, BigDecimal refundAmount, BigDecimal netAmount) {}

    public record DailySalesReport(LocalDate from, LocalDate to, String timeZone, List<DailySales> days,
                                   long totalOrders, BigDecimal totalPaid, BigDecimal totalRefund, BigDecimal totalNet) {}

    private final SalesReportMapper mapper;

    SalesReportService(SalesReportMapper mapper) { this.mapper = mapper; }

    @Transactional(readOnly = true)
    public DailySalesReport dailySales(long sellerId, LocalDate from, LocalDate to) {
        if (to.isBefore(from)) throw new ShopException(ProblemType.VALIDATION, "結束日不可早於開始日");
        long days = ChronoUnit.DAYS.between(from, to) + 1;
        if (days > MAX_DAYS) throw new ShopException(ProblemType.VALIDATION, "區間最多 " + MAX_DAYS + " 天").with("days", days);

        // 「台北的 9 月 1 日」= UTC 8 月 31 日 16:00 起。邊界在 Java 算好，SQL 裡只做「欄位 >= ? AND 欄位 < ?」
        Instant fromUtc = from.atStartOfDay(REPORT_ZONE).toInstant();
        Instant toUtc = to.plusDays(1).atStartOfDay(REPORT_ZONE).toInstant();
        Map<LocalDate, SalesReportMapper.DailyRow> rows = mapper.dailySales(sellerId, fromUtc, toUtc).stream()
                .collect(Collectors.toMap(SalesReportMapper.DailyRow::day, Function.identity()));

        List<DailySales> result = new ArrayList<>();
        for (LocalDate d = from; !d.isAfter(to); d = d.plusDays(1)) {           // AC-1：每日一列，沒有訂單的日子也要有
            SalesReportMapper.DailyRow r = rows.get(d);
            BigDecimal paid = r == null ? BigDecimal.ZERO : r.paidAmount();
            BigDecimal refund = r == null ? BigDecimal.ZERO : r.refundAmount();
            result.add(new DailySales(d, r == null ? 0 : r.orderCount(), paid, refund, paid.subtract(refund)));
        }
        return new DailySalesReport(from, to, REPORT_ZONE.getId(), result,
                result.stream().mapToLong(DailySales::orderCount).sum(),
                result.stream().map(DailySales::paidAmount).reduce(BigDecimal.ZERO, BigDecimal::add),
                result.stream().map(DailySales::refundAmount).reduce(BigDecimal.ZERO, BigDecimal::add),
                result.stream().map(DailySales::netAmount).reduce(BigDecimal.ZERO, BigDecimal::add));
    }
}
```

```java
package com.example.shop.reporting.internal.web;

import com.example.shop.reporting.internal.SalesReportService;
import com.example.shop.reporting.internal.SalesReportService.DailySalesReport;
import com.example.shop.shared.web.CurrentUser;
import com.example.shop.shared.web.Role;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.LocalDate;

/** US-RPT-1 */
@RestController
class SellerReportController {

    private final SalesReportService service;

    SellerReportController(SalesReportService service) { this.service = service; }

    @GetMapping("/api/seller/reports/daily-sales")
    DailySalesReport dailySales(CurrentUser user,
                                @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate from,
                                @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate to) {
        return service.dailySales(user.require(Role.SELLER).id(), from, to);
    }
}
```

```bash
curl -s -H "X-Debug-User-Id: 2" -H "X-Debug-Roles: BUYER,SELLER" \
     "localhost:8080/api/seller/reports/daily-sales?from=2026-09-20&to=2026-09-22"
```

```json
{"from":"2026-09-20","to":"2026-09-22","timeZone":"Asia/Taipei","days":[
  {"day":"2026-09-20","orderCount":110,"paidAmount":187472.40,"refundAmount":0.00,"netAmount":187472.40},
  {"day":"2026-09-21","orderCount":106,"paidAmount":162124.90,"refundAmount":8635.00,"netAmount":153489.90},
  {"day":"2026-09-22","orderCount":113,"paidAmount":205084.40,"refundAmount":0.00,"netAmount":205084.40}],
 "totalOrders":329,"totalPaid":554681.70,"totalRefund":8635.00,"totalNet":546046.70}
```

（輸出已排版。）回應裡的 `"timeZone":"Asia/Taipei"` 不是裝飾：**報表的每一個日期都是相對於某個時區的**，把它寫在回應裡，讀的人（和前端）就不用猜。

> 📌 **為什麼 `Instant` 參數直接傳給 MyBatis 沒問題？** MyBatis 3.5 內建 `InstantTypeHandler`，它用 `Timestamp.from(instant)` 綁定 ——
> 而 JDBC URL 的 `connectionTimeZone=UTC`（2.4.3）保證驅動用 UTC 解讀那個 `Timestamp`：`Timestamp` 本身是一個**時間點**，驅動（預設 `preserveInstants=true`）依 `connectionTimeZone` 把它寫成 UTC 的字面值 —— 就算你的 JVM 時區是台北，也不會差 8 小時。**三層（Java 的 `Instant`、驅動、資料庫）都是 UTC，中間沒有任何一層在轉換。**

#### US-RPT-2 AC-1 與 US-RPT-3

0.8 的 ⚠️ 說過：銷售排行（US-RPT-2 AC-1）與管理員的全站報表（US-RPT-3）**這一章沒有做，之後的章節也沒有**。下面補在第 09 章結束時的程式碼上，參考實作的 `ch03`～`ch09` 分支上都沒有。三支 API：

| 方法 | 路徑 | 角色 | 參數 | 回應 |
|---|---|---|---|---|
| `GET` | `/api/seller/reports/top-products` | SELLER | `from`、`to` | `TopProductsReport` |
| `GET` | `/api/admin/reports/top-products` | ADMIN | `from`、`to`、`sellerId?` | `TopProductsReport` |
| `GET` | `/api/admin/reports/daily-sales` | ADMIN | `from`、`to`、`sellerId?`、`groupBy=seller?` | `SiteDailySalesReport` |

需求沒寫清楚的地方，決定如下（都寫在 `TopProductsService` 與 `SalesReportService` 的註解裡）：

- **區間跟 RPT-1 一樣**：台北的日曆日 `[from, to]`、最多 366 天。換算 UTC 的那段從 `SalesReportService` 抽成 `ReportRange`，三張報表共用，錯誤訊息一個字都沒改。
- **「已出貨」看 `shipped_at` 落在區間內**，不看成立時間：9/28 成立、10/02 出貨的那一單算 10/02 —— 跟上面 RPT-1「事情在哪一天發生就算哪一天」是同一個口徑。`SHIPPED`、`COMPLETED` 都算；出貨後的退款只有「重複付款」那一種（0.5.3 的 ↺），貨還是出了，照算。
- **並列**：數量相同依 `productId` 由小到大；名次用競賽排名（1、2、2、4）；回應最多 20 列，第 20 名有並列也不會變成 23 列。
- **下架的商品照樣列出**，名稱與狀態用商品現在的 —— 這是「賣過什麼」，不是首頁的熱門排行（6.8 才濾 `ON_SALE`）。`products` 裡找不到的，名稱退回明細上的快照。
- **賣家只看自己的**：`sellerId` 來自 token，帶 `?sellerId=別人` 會被忽略（有測試）。管理員指定一位不存在的賣家，回一份全是 0 的報表而不是 404 —— 管理員本來就看得到所有賣家，5.8 的 404 保護的是「別人的資源」。
- **「依賣家分組」是每位賣家一列整個區間的小計**，不是「每位賣家 × 每天」（366 天 × 500 位賣家是 18 萬列）；要看某一位賣家每天的數字，用 `sellerId` 查 —— 結果跟他自己查 RPT-1 一模一樣（`AdminReportApiTest` 比對過）。
- **全站與指定賣家用同一句 SQL**：上面那份 XML 的三段各多一個 `<if test="sellerId != null">AND o.seller_id = #{sellerId}</if>`，沒有另寫一份全站版（8.7.2 抓過兩份 SQL 漂移的例子）。所以從這裡起，上面那份 XML 跟 repo 裡的不完全一樣。

排行的 SQL 從 `orders` 出發（條件全在它身上：出貨時間、賣家），`order_items` 用 `uk_order_items_order_product` 的 `order_id` 接上，`LIMIT 20` 在子查詢裡，只有 20 列去 JOIN `products`。2.7.1 的索引規劃表寫的 `idx_order_items_product (product_id)` 是「從商品出發」的形狀，這裡用不上。

**一個加了又拿掉的索引。** 為「指定賣家」加 `(seller_id, status, shipped_at)`（量測時編號 V26）。10 萬張種子訂單上 `EXPLAIN ANALYZE`（2.8.3 的種子資料，最大的賣家 2，2026-07-01～09-28）：

| 查詢 | V26 開 | V26 關（invisible） |
|---|---|---|
| 賣家 2 的排行 | `idx_orders_seller_created`，讀這位賣家 10,928 張、過濾出 9,088 張出貨的 | 同一個計畫 |
| RPT-1 賣家日報表的成立段（交錯兩次） | **`idx_orders_seller_status_shipped`**，12.0、10.5 ms | `idx_orders_seller_created`，5.67、5.65 ms |

排行根本沒用它（最大的賣家 90 天內出貨的就是他大部分的訂單，範圍縮不了多少）；反而 RPT-1 的計畫被它搶走 —— 只用得上 `seller_id` 前綴，再回表一列一列過濾 `created_at`，慢了一倍。**沒有用、還有害，拿掉了。** 它只套用過拿來量測的臨時資料庫，所以是直接刪掉檔案，不是再加一個 `DROP INDEX` 的 migration（2.9.5：刪了 migration，要 `mvn clean`）。這是 2.7.1 規則的另一面：**加索引之前先看最佳化器會不會用它，也要看它會不會被別的查詢誤用。**

全站的排行走 `idx_orders_status_shipped`（2.7.1 原本給自動完成用的）的範圍掃描：90 天、82,844 張出貨的訂單、24 萬列明細，第一次 313 ms。0.6.2 沒有給排行 SLO；全站 366 天、550 萬張訂單的量級沒有量。全站日報表的成立段走第 06 章 V12 的 `idx_orders_created`。

測試：`TopProductsApiTest`（5 個：台北午夜、並列、Top 20、空區間、權限）、`AdminReportApiTest`（6 個：全站、指定賣家等於 RPT-1、分組、參數、權限），以及三個不起 Spring 的單元測試（`ReportRangeTest`、`TopProductsRankTest`、`SiteSalesReportTest`，各 3 個）。`OpenApiContractTest` 的快照多了三個 operation。

### 3.7.2 JPA 與 MyBatis 在同一個交易裡

0.9.2 ② 說：「兩者共用同一個 `DataSource` 與同一個交易管理器（第 03 章加入 MyBatis 時設定並驗證）」。**「設定」不用做** —— `mybatis-spring-boot-starter` 會用 Spring 的 `DataSource`，並透過 `SpringManagedTransaction` 加入目前的交易。**「驗證」要做。**

情境：同一個交易裡，JPA 改了價格，接著用 MyBatis 讀。（真實的例子：第 04 章的下單交易改了庫存，然後同一個交易裡用 MyBatis 查一個彙總。）

```java
package com.example.shop.catalog.internal;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Select;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.TestPropertySource;
import org.springframework.transaction.support.TransactionTemplate;

import jakarta.persistence.EntityManager;
import java.math.BigDecimal;
import java.time.Instant;

/**
 * 3.7.2 JPA 與 MyBatis 在同一個交易裡：寫入走 JPA、讀取走 MyBatis 時，MyBatis 讀到的是什麼？
 * 放在 catalog.internal 套件裡，才能直接用 package-private 的 Product 與 ProductRepository。
 */
@Tag("experiment")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE)
@TestPropertySource(properties = "mybatis.configuration.local-cache-scope=session")     // MyBatis 的預設值
class D5JpaMybatisSameTransactionTest {

    @Mapper
    interface PriceProbe {
        @Select("SELECT price FROM products WHERE id = #{id}")
        BigDecimal price(long id);

        @Select("SELECT CONNECTION_ID()")
        long connectionId();
    }

    @Autowired ProductRepository products;
    @Autowired PriceProbe mybatis;
    @Autowired JdbcTemplate jdbc;
    @Autowired EntityManager em;
    @Autowired TransactionTemplate tx;
    @Value("${mybatis.configuration.local-cache-scope:session}") String cacheScope;

    BigDecimal jdbcPrice() { return jdbc.queryForObject("SELECT price FROM products WHERE id = 1", BigDecimal.class); }

    @Test
    void sameTransaction() {
        System.out.printf("═══ 3.7.2 JPA 改價，同一個交易裡用 MyBatis 讀（local-cache-scope = %s）═══%n", cacheScope);
        tx.executeWithoutResult(s -> {
            s.setRollbackOnly();
            Product p = products.findById(1L).orElseThrow();
            System.out.printf("  JPA 連線 %d、MyBatis 連線 %d、JdbcTemplate 連線 %d（同一條 → 同一個交易）%n",
                    (Long) em.createNativeQuery("SELECT CONNECTION_ID()").getSingleResult(), mybatis.connectionId(),
                    jdbc.queryForObject("SELECT CONNECTION_ID()", Long.class));
            System.out.printf("  ① 改價之前           MyBatis %s   JdbcTemplate %s%n", mybatis.price(1L), jdbcPrice());
            p.update(null, null, new BigDecimal("999.00"), null, Instant.now());
            System.out.printf("  ② JPA 改成 999（未 flush） MyBatis %s   JdbcTemplate %s%n", mybatis.price(1L), jdbcPrice());
            em.flush();
            System.out.printf("  ③ em.flush() 之後      MyBatis %s   JdbcTemplate %s%n", mybatis.price(1L), jdbcPrice());
        });
        System.out.printf("  rollback 之後           MyBatis %s   JdbcTemplate %s%n", mybatis.price(1L), jdbcPrice());
    }
}
```

```java
package com.example.shop.catalog.internal;

import org.springframework.test.context.TestPropertySource;

/** 同一個實驗，把 MyBatis 的 local cache 範圍從 SESSION 改成 STATEMENT */
@TestPropertySource(properties = "mybatis.configuration.local-cache-scope=statement")
class D5bLocalCacheStatementTest extends D5JpaMybatisSameTransactionTest {}
```

```
═══ 3.7.2 JPA 改價，同一個交易裡用 MyBatis 讀（local-cache-scope = session）═══
  JPA 連線 3892、MyBatis 連線 3892、JdbcTemplate 連線 3892（同一條 → 同一個交易）
  ① 改價之前                 MyBatis 149.00   JdbcTemplate 149.00
  ② JPA 改成 999（未 flush）  MyBatis 149.00   JdbcTemplate 149.00
  ③ em.flush() 之後          MyBatis 149.00   JdbcTemplate 999.00
  rollback 之後              MyBatis 149.00   JdbcTemplate 149.00
═══ 3.7.2 JPA 改價，同一個交易裡用 MyBatis 讀（local-cache-scope = statement）═══
  JPA 連線 3913、MyBatis 連線 3913、JdbcTemplate 連線 3913（同一條 → 同一個交易）
  ① 改價之前                 MyBatis 149.00   JdbcTemplate 149.00
  ② JPA 改成 999（未 flush）  MyBatis 149.00   JdbcTemplate 149.00
  ③ em.flush() 之後          MyBatis 999.00   JdbcTemplate 999.00
  rollback 之後              MyBatis 149.00   JdbcTemplate 149.00
```

**第一行證明了「共用交易」**：三個工具的 `CONNECTION_ID()` 相同 —— 它們用的是同一條連線，所以是同一個交易。

**兩個陷阱，各在一行：**

**② 陷阱一：JPA 還沒 flush。** `p.update(...)` 只改了**記憶體裡的 Entity**（persistence context），Hibernate 要到 flush 時才送出 `UPDATE`。
Hibernate 會在**執行 JPQL / HQL 查詢之前**自動 flush（auto flush）—— 但它**不知道 MyBatis 和 `JdbcTemplate` 的存在**，所以不會為它們 flush。兩者都讀到 149。

**③ 陷阱二（只有 MyBatis）：flush 之後，MyBatis 還是 149。** `JdbcTemplate` 讀到了 999，證明資料庫裡（在這個交易內）已經是 999 了。MyBatis 讀到的是 **①那一次查詢的快取**。

MyBatis 的 **local cache**（一級快取）預設範圍是 `SESSION`：同一個 `SqlSession` 裡，**同一個 statement + 同一個參數**的查詢，第二次起直接回傳快取的結果。
而在 Spring 的交易裡，**整個交易共用同一個 `SqlSession`** —— 所以只要同一個交易裡查過一次，之後不管別人（JPA、`JdbcTemplate`、另一個 mapper 的 `UPDATE` 之外的任何東西）改了什麼，它都看不見。

（MyBatis 自己的 `INSERT` / `UPDATE` / `DELETE` 會清掉 local cache —— 問題只出在「**別的工具**」寫入的時候。而那正是 JPA + MyBatis 混用的情境。）

**本專題的設定**：

| 陷阱 | 對策 |
|---|---|
| JPA 沒 flush | 在同一個交易裡、用 JPA 以外的工具讀之前，**明確 `em.flush()`**。更好的是：**讀寫分開** —— 本專題的 MyBatis 只用在唯讀的報表，報表的交易裡沒有 JPA 寫入 |
| MyBatis local cache | `mybatis.configuration.local-cache-scope: statement`：快取只活在一句查詢之內，等於關掉。報表每個請求只查一次，這個快取本來就沒有幫助 |

> 📌 [08-jpa-mybatis/09](../08-jpa-mybatis/09-choosing-and-mixing-in-practice.md) 講過混用的原則。這一節是那些原則在本專題上的**實測**：三條連線 id 相同（共用交易 ✅）、flush 要自己來（⚠️）、MyBatis 的快取要關（⚠️）。

### 3.7.3 禁用 `${}`

0.6.5：「MyBatis 禁用 `${}`（由測試掃描 mapper XML 檢查）」。

```java
package com.example.shop.architecture;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 0.6.5：MyBatis 禁用 ${}。#{} 會變成 PreparedStatement 的參數；${} 是「把字串直接拼進 SQL」——SQL injection 的入口。
 * 需要動態的欄位名或排序時，在 Java 裡用白名單選出一個常數，再用 <choose> 分支，而不是 ${}。
 */
class MapperXmlSafetyTest {

    @Test
    void noStringSubstitutionInMappers() throws IOException {
        List<String> violations = new ArrayList<>();
        int files = 0;
        try (Stream<Path> s = Files.walk(Path.of("src/main/resources/mapper"))) {
            for (Path p : s.filter(f -> f.toString().endsWith(".xml")).toList()) {
                files++;
                List<String> lines = Files.readAllLines(p);
                for (int i = 0; i < lines.size(); i++)
                    if (lines.get(i).contains("${")) violations.add("%s:%d  %s".formatted(p.getFileName(), i + 1, lines.get(i).strip()));
            }
        }
        System.out.printf("掃描 %d 個 mapper XML%n", files);
        violations.forEach(v -> System.out.println("  ✗ " + v));
        assertThat(violations).as("mapper XML 裡不可以有 ${}").isEmpty();
    }
}
```

```
掃描 1 個 mapper XML
```

`#{sellerId}` 變成 `PreparedStatement` 的 `?`，值用參數綁定；`${sellerId}` 會**把字串直接拼進 SQL**。報表最常見的誘惑是「排序欄位讓前端決定」—— `ORDER BY ${sort}` —— 那就是一個 SQL injection 的入口。
需要動態排序時，在 Java 裡用白名單（3.5.4 的 `SortWhitelist` 的同一個想法）選出一個**常數**，再用 `<choose>` 分支。

---

## 3.8 OpenAPI 文件

### 3.8.1 產生文件，以及它第一次說錯的三件事

0.6.8：「OpenAPI 由程式碼產生」。

```xml
<dependency>
  <groupId>org.springdoc</groupId>
  <artifactId>springdoc-openapi-starter-webmvc-ui</artifactId>
  <version>2.5.0</version>
</dependency>
```

加了依賴，`/v3/api-docs`（JSON）與 `/swagger-ui.html`（瀏覽器介面）就有了。**然後讀一次它產生的東西。** `GET /api/seller/products` 的參數：

```json
"parameters": [{"name": "user", "in": "query", "required": true, "schema": {"$ref": "#/components/schemas/CurrentUser"}}, ...
```

**第一件：`CurrentUser` 被當成一個必填的 query 參數。** springdoc 看到一個沒有註解的物件參數，就推論它是 query 參數 —— 跟 3.3.4 的 Spring MVC 做了**同一個推論**。
文件上它是無害的錯誤，但它在告訴讀文件的人「這支 API 可以用 `?id=...&roles=...` 指定使用者」—— 3.3.4 修好之前，**這句話是真的**。

`GET /api/products` 的參數：

```json
[{"name": "q", ...}, {"name": "categoryId", ...}, {"name": "minPrice", ...}, {"name": "maxPrice", ...},
 {"name": "pageable", "in": "query", "required": true, "schema": {"$ref": "#/components/schemas/Pageable"}}]
```

**第二件：`Pageable` 被寫成一個叫 `pageable`、必填的物件參數。** 實際上 API 接受的是 `page`、`size`、`sort` 三個獨立的 query 參數。照著文件產生的前端 client 會送出 `?pageable=...`，然後分頁完全沒有作用。

**第三件：`GET /api/products/{id}` 的 `Optional<CurrentUser>` 也出現了**，而且 `CurrentUser` 的 schema（`id`、`roles`）被放進了 `components`。

**修正**：

```java
package com.example.shop.shared.web;

import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Info;
import org.springdoc.core.utils.SpringDocUtils;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** 3.8 OpenAPI 文件由程式碼產生（0.6.8） */
@Configuration(proxyBeanMethods = false)
class OpenApiConfig {

    static {
        // CurrentUser 由 CurrentUserResolver 從 header 產生，不是 query 參數 —— 不要讓它出現在文件裡。
        // （只對「CurrentUser」這個型別有效；Optional<CurrentUser> 要在參數上加 @Parameter(hidden = true)）
        SpringDocUtils.getConfig().addRequestWrapperToIgnore(CurrentUser.class);
    }

    @Bean
    OpenAPI shopOpenApi() {
        return new OpenAPI().info(new Info().title("Shop API").version("v1")
                .description("期末專題：小型電商訂單系統。錯誤回應一律是 Problem Details（type 見 ProblemType）。"));
    }
}
```

- `addRequestWrapperToIgnore(CurrentUser.class)`：所有型別是 `CurrentUser` 的參數不出現在文件裡。
- **`Optional<CurrentUser>` 不在它的範圍內**，要在參數上加 `@Parameter(hidden = true)`（3.5.5 的 `ProductController.detail`）。
  （試過另一條路：註冊一個 `ParameterCustomizer`，對這種參數回傳 `null`。springdoc 2.5.0 會在 `ParameterId.<init>` 丟 `NullPointerException`，**整份文件變成 500**。）
- `Pageable` 參數加上 springdoc 的 `@ParameterObject`：把它展開成 `page`、`size`、`sort`（3.5.5）。

修正後：

```
GET /api/products       的參數：['q', 'categoryId', 'minPrice', 'maxPrice', 'page', 'size', 'sort']
GET /api/products/{id}  的參數：['id']
components 裡的 CurrentUser、Pageable：（沒有了）
```

> 📌 **「由程式碼產生」不等於「正確」。** 產生器是根據**型別推論**的，而它的推論規則跟 Spring MVC 的推論規則一樣 —— 包括錯的那些。**產生的文件要被讀過一次**，而下一節讓它「被讀過」這件事變成一個測試。

### 3.8.2 API 契約的快照

0.6.8 的另一半：「CI 檢查文件與上一版相比有沒有破壞性變更」。

```java
package com.example.shop.api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.web.servlet.MockMvc;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

/**
 * 3.8.2 API 契約的快照（0.6.8：「文件與上一版相比有沒有破壞性變更」）。
 * 程式碼產生的 OpenAPI 跟 repo 裡的快照比對：任何一支 API 的形狀變了，這個測試就紅，並列出哪幾個 operation 變了。
 * 變更是刻意的 → 用 -Dopenapi.update=true 重跑一次更新快照，快照的 diff 會出現在 PR 裡被 review。
 */
@SpringBootTest
@AutoConfigureMockMvc
class OpenApiContractTest {

    static final Path SNAPSHOT = Path.of("src/test/resources/openapi/shop-api.json");
    static final ObjectMapper JSON = new ObjectMapper().enable(SerializationFeature.INDENT_OUTPUT)
            .enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS);

    @Autowired MockMvc mvc;

    @Test
    void apiContractMatchesSnapshot() throws Exception {
        var response = mvc.perform(get("/v3/api-docs")).andReturn().getResponse();
        assertThat(response.getStatus()).as("OpenAPI 文件產生失敗").isEqualTo(200);
        String body = response.getContentAsString(java.nio.charset.StandardCharsets.UTF_8);
        ObjectNode current = (ObjectNode) JSON.readTree(body);
        current.remove("servers");                                        // 每次啟動的 port 不同，不是契約的一部分
        String normalized = JSON.writeValueAsString(JSON.treeToValue(current, Object.class));

        if (!Files.exists(SNAPSHOT) || Boolean.getBoolean("openapi.update")) {
            Files.writeString(SNAPSHOT, normalized);
            System.out.println("已寫入 API 快照：" + SNAPSHOT + "（請 review 之後 commit）");
            return;
        }
        JsonNode previous = JSON.readTree(Files.readString(SNAPSHOT));
        List<String> changes = diff(previous.path("paths"), current.path("paths"));
        if (!previous.path("components").equals(current.path("components"))) changes.add("components（DTO 的欄位）有變動");
        changes.forEach(c -> System.out.println("  △ " + c));
        assertThat(changes).as("API 契約跟快照不一致；若是刻意的，用 -Dopenapi.update=true 更新快照").isEmpty();
    }

    static List<String> diff(JsonNode before, JsonNode after) {
        List<String> out = new ArrayList<>();
        Set<String> paths = new TreeSet<>();
        before.fieldNames().forEachRemaining(paths::add);
        after.fieldNames().forEachRemaining(paths::add);
        for (String p : paths) {
            Set<String> methods = new TreeSet<>();
            before.path(p).fieldNames().forEachRemaining(methods::add);
            after.path(p).fieldNames().forEachRemaining(methods::add);
            for (String m : methods) {
                JsonNode b = before.path(p).path(m), a = after.path(p).path(m);
                String op = m.toUpperCase(Locale.ROOT) + " " + p;
                if (b.isMissingNode()) out.add("新增 " + op);
                else if (a.isMissingNode()) out.add("⚠ 刪除 " + op + "（破壞性變更）");
                else if (!a.equals(b)) out.add("變更 " + op);
            }
        }
        return out;
    }
}
```

**它做的事**：產生目前的 OpenAPI → 跟 repo 裡的 `src/test/resources/openapi/shop-api.json` 比對 → 列出每一個變了的 operation。

**第一次跑之前，先 `mkdir -p src/test/resources/openapi`**：快照不存在時，測試會把目前的文件寫成快照，但 `Files.writeString` 不會幫你建目錄 —— 目錄不在，第一次就是 `NoSuchFileException`。寫出來的快照要 review 之後 commit。

**第一次寫它時的兩個錯誤**，都是它自己抓到的：

- 沒有檢查狀態碼。`OpenApiConfig` 有 bug（上面的 `ParameterCustomizer`）時，`/v3/api-docs` 回的是 500 的 Problem Details —— **然後那份錯誤回應被當成「API 快照」寫進了檔案**。所以現在第一行就是 `assertThat(response.getStatus()).isEqualTo(200)`。
- `getContentAsString()` 預設用 ISO-8859-1 解碼，中文的 `description` 變成了亂碼。要明確傳 `StandardCharsets.UTF_8`。

**故意改一個參數名**（`ProductController.search` 的 `q` 改成 `@RequestParam(name = "keyword")`）：

```
  △ 變更 GET /api/products
[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0
[API 契約跟快照不一致；若是刻意的，用 -Dopenapi.update=true 更新快照]
Expecting empty but was: ["變更 GET /api/products"]
```

**改參數名是破壞性變更**：所有送 `?q=耳機` 的舊前端，搜尋從此失效（而且不會報錯 —— 只是變成「沒有關鍵字的搜尋」）。
這個測試不判斷「這個變更破不破壞相容性」（那需要逐欄比對 schema，[03-rest-api/06](../03-rest-api/06-versioning-and-compatibility.md) 講過判斷規則）—— 它只保證**任何變更都會被看見**：
要讓它變綠，你必須執行 `-Dopenapi.update=true`，而那會讓快照檔出現在 PR 的 diff 裡，**被 review 的人看見**。

---

## 3.9 API 測試與延遲

### 3.9.1 MockMvc：把追溯表的 PRD、CART 填上

```java
package com.example.shop.api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 0.12.2 追溯表：PRD-1～5、CART-1～2 的 MockMvc 驗證。
 * @Transactional：MockMvc 在測試的執行緒上跑，Service 的交易加入測試的交易，測試結束一起 rollback —— 不留下任何資料。
 */
@SpringBootTest
@AutoConfigureMockMvc
@Transactional
class CatalogCartApiTest {

    static final long SELLER = 90_001, OTHER_SELLER = 90_002, BUYER = 90_101;

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;

    static MockHttpServletRequestBuilder as(long userId, String roles, MockHttpServletRequestBuilder b) {
        return b.header("X-Debug-User-Id", userId).header("X-Debug-Roles", roles)
                .contentType(MediaType.APPLICATION_JSON).characterEncoding(StandardCharsets.UTF_8);
    }

    JsonNode body(ResultActions r) throws Exception {
        return json.readTree(r.andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8));
    }

    long createProduct(String name, String price, int stock) throws Exception {
        JsonNode p = body(mvc.perform(as(SELLER, "BUYER,SELLER", post("/api/seller/products")
                .content("""
                        {"name": "%s", "price": %s, "categoryId": 11, "initialStock": %d}""".formatted(name, price, stock)))));
        return p.get("id").asLong();
    }

    long createPublished(String name, String price, int stock) throws Exception {
        long id = createProduct(name, price, stock);
        mvc.perform(as(SELLER, "SELLER", post("/api/seller/products/" + id + "/publish"))).andExpect(status().isOk());
        return id;
    }

    @Test @DisplayName("PRD-1 AC-1：sellerId 來自目前使用者、狀態一律 DRAFT、庫存列與 INITIAL 帳同時建立")
    void createProduct_ownerAndStatusComeFromServer() throws Exception {
        JsonNode p = body(mvc.perform(as(SELLER, "SELLER", post("/api/seller/products").content("""
                        {"name": "藍牙耳機", "price": 1290, "categoryId": 11, "initialStock": 30,
                         "sellerId": 999, "status": "ON_SALE"}"""))).andExpect(status().isCreated()));
        assertThat(p.get("sellerId").asLong()).isEqualTo(SELLER);            // body 的 999 被忽略（DTO 沒有這個欄位）
        assertThat(p.get("status").asText()).isEqualTo("DRAFT");             // body 的 ON_SALE 也被忽略
        assertThat(p.get("available").asInt()).isEqualTo(30);
        assertThat(p.get("price").decimalValue()).isEqualByComparingTo("1290.00");
        assertThat(jdbc.queryForObject("SELECT CONCAT(reason, ':', delta_on_hand) FROM inventory_ledger WHERE product_id = ?",
                String.class, p.get("id").asLong())).isEqualTo("INITIAL:30");
    }

    @Test @DisplayName("PRD-1 AC-2：價格 ≤ 0、超過 2 位小數、> 1,000,000 → 400，errors 指出 price")
    void createProduct_priceValidation() throws Exception {
        for (String price : new String[]{"0", "-1", "99.999", "1000000.01"}) {
            mvc.perform(as(SELLER, "SELLER", post("/api/seller/products").content("""
                            {"name": "x", "price": %s, "categoryId": 11, "initialStock": 1}""".formatted(price))))
                    .andExpect(status().isBadRequest())
                    .andExpect(jsonPath("$.type").value("/problems/validation"))
                    .andExpect(jsonPath("$.errors[0].field").value("price"));
        }
    }

    @Test @DisplayName("PRD-1 AC-4：賣家 B 改賣家 A 的商品 → 404（不是 403）")
    void otherSellersProductIsNotFound() throws Exception {
        long id = createProduct("A 的商品", "100", 1);
        mvc.perform(as(OTHER_SELLER, "SELLER", patch("/api/seller/products/" + id).content("{\"price\": 1}")))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.type").value("/problems/not-found"));
    }

    @Test @DisplayName("買家呼叫賣家 API → 403；沒帶身分 → 401")
    void roles() throws Exception {
        mvc.perform(as(BUYER, "BUYER", post("/api/seller/products").content("{}"))).andExpect(status().isForbidden());
        mvc.perform(get("/api/cart")).andExpect(status().isUnauthorized()).andExpect(jsonPath("$.type").value("/problems/unauthenticated"));
    }

    @Test @DisplayName("PRD-2 AC-2、AC-3、AC-4：size 上限 100；不存在的排序欄位 400 且不洩漏類別名；% 是字面字元")
    void search() throws Exception {
        long literal = createPublished("100% 純棉 T 恤 zq9", "390", 5);
        createPublished("純棉 T 恤 zq9", "290", 5);
        mvc.perform(get("/api/products").param("size", "500")).andExpect(jsonPath("$.size").value(100));
        String bad = mvc.perform(get("/api/products").param("sort", "sellerPassword,asc"))
                .andExpect(status().isBadRequest()).andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat(bad).doesNotContain("Product").doesNotContain("sellerPassword'");
        JsonNode r = body(mvc.perform(get("/api/products").param("q", "100% 純棉")));
        assertThat(r.get("totalElements").asLong()).isEqualTo(1);
        assertThat(r.get("content").get(0).get("id").asLong()).isEqualTo(literal);
        assertThat(body(mvc.perform(get("/api/products").param("q", "zq_"))).get("totalElements").asLong()).isZero();
    }

    @Test @DisplayName("PRD-3 AC-2：DRAFT 商品，別人 404、賣家本人 200")
    void draftVisibility() throws Exception {
        long id = createProduct("草稿商品", "100", 1);
        mvc.perform(get("/api/products/" + id)).andExpect(status().isNotFound());
        mvc.perform(as(BUYER, "BUYER", get("/api/products/" + id))).andExpect(status().isNotFound());
        mvc.perform(as(SELLER, "SELLER", get("/api/products/" + id))).andExpect(status().isOk());
    }

    @Test @DisplayName("CART-1 AC-1、AC-2、AC-5：數量相加、上限 99、庫存不足只提醒不擋")
    void cart() throws Exception {
        long id = createPublished("購物車測試", "150", 3);
        mvc.perform(as(BUYER, "BUYER", post("/api/cart/items").content("{\"productId\": %d, \"quantity\": 2}".formatted(id))));
        JsonNode c = body(mvc.perform(as(BUYER, "BUYER", post("/api/cart/items").content("{\"productId\": %d, \"quantity\": 3}".formatted(id))))
                .andExpect(status().isOk()));
        JsonNode line = c.get("groups").get(0).get("items").get(0);
        assertThat(line.get("quantity").asInt()).isEqualTo(5);
        assertThat(line.get("warnings").toString()).contains("INSUFFICIENT_STOCK");      // 可售 3、要 5
        mvc.perform(as(BUYER, "BUYER", post("/api/cart/items").content("{\"productId\": %d, \"quantity\": 100}".formatted(id))))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.errors[0].field").value("quantity"));
        mvc.perform(as(BUYER, "BUYER", post("/api/cart/items").content("{\"productId\": %d, \"quantity\": 95}".formatted(id))))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.detail").value("同一個商品最多 99 件"));
    }

    @Test @DisplayName("CART-2 AC-1、PRD-4 AC-2：改價後顯示新價與 priceChanged；下架後標記 unavailable")
    void cartSeesPriceChangeAndUnpublish() throws Exception {
        long id = createPublished("改價測試", "100", 10);
        mvc.perform(as(BUYER, "BUYER", post("/api/cart/items").content("{\"productId\": %d, \"quantity\": 1}".formatted(id))));
        mvc.perform(as(SELLER, "SELLER", patch("/api/seller/products/" + id).content("{\"price\": 120}"))).andExpect(status().isOk());
        JsonNode line = body(mvc.perform(as(BUYER, "BUYER", get("/api/cart")))).get("groups").get(0).get("items").get(0);
        assertThat(line.get("unitPrice").decimalValue()).isEqualByComparingTo("120");
        assertThat(line.get("priceChanged").asBoolean()).isTrue();
        assertThat(line.get("previousPrice").decimalValue()).isEqualByComparingTo("100");
        mvc.perform(as(SELLER, "SELLER", post("/api/seller/products/" + id + "/unpublish"))).andExpect(status().isOk());
        line = body(mvc.perform(as(BUYER, "BUYER", get("/api/cart")))).get("groups").get(0).get("items").get(0);
        assertThat(line.get("unavailable").asBoolean()).isTrue();
    }
}
```

```
[INFO] Tests run: 8, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 1.183 s -- in com.example.shop.api.CatalogCartApiTest
```

**`@Transactional` 讓每一個測試都不留下資料**：MockMvc 在測試的執行緒上呼叫 Controller，Service 的 `@Transactional` 加入測試的交易，測試結束時整個 rollback。
這在第 02 章的真 schema 上跑 —— 24 個 CHECK、10 條外鍵全部生效 —— 所以測試過了，代表**真的資料庫接受這些寫入**。

**對照 0.12.2 的追溯表**，本章填上的列：

| 需求 | 測試 |
|---|---|
| PRD-1 AC-1（sellerId、DRAFT、INITIAL 帳） | `createProduct_ownerAndStatusComeFromServer` |
| PRD-1 AC-2（價格驗證） | `createProduct_priceValidation`（4 種非法價格） |
| PRD-1 AC-4（別人的商品 404） | `otherSellersProductIsNotFound` |
| PRD-2 AC-2、AC-3、AC-4 | `search`（size 上限、排序白名單且不洩漏類別名、`%` 與 `_` 是字面字元） |
| PRD-3 AC-2（草稿的可見性） | `draftVisibility` |
| CART-1 AC-1、AC-2、AC-5 | `cart`（相加、上限 99、庫存不足只提醒） |
| CART-2 AC-1、PRD-4 AC-2 | `cartSeesPriceChangeAndUnpublish` |
| 角色（401、403） | `roles` —— 3.4.4 那個「驗證比權限先跑」就是它抓到的 |
| ORD-5 AC-2（N+1） | 驗收 **Q4**（3.6.3） |

### 3.9.2 單一請求的延遲

0.6.2 的 SLO 是在**負載**下定義的（例如「搜尋 100 rps，p99 300 ms」）。壓測在第 04、06 章；這裡先量**一次一個請求**的延遲分布，確認沒有任何一支 API 在「沒有負載」時就已經超標：

```java
package com.example.shop.ch03;

import com.example.shop.ShopApplication;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.context.WebServerApplicationContext;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Random;
import java.util.function.IntFunction;

/**
 * 3.9 單一請求的延遲分布（不是壓測：一次一個請求、依序送 300 次）。第 02 章的種子資料。
 * 壓測（0.6.2 的「100 rps」「1,000 rps」）在第 04、06 章。
 */
@Tag("experiment")
class D6LatencyTest {

    static final HttpClient HTTP = HttpClient.newHttpClient();
    static final String[] WORDS = {"耳機", "充電器", "鍵盤", "T 恤", "洋裝", "慢跑鞋", "平底鍋", "枕", "精華", "唇膏", "堅果", "咖啡", "#12", "無線"};

    static void measure(int port, String label, int n, IntFunction<String> path, String... headers) throws Exception {
        for (int i = 0; i < 30; i++) send(port, path.apply(i), headers);          // 暖機
        long[] t = new long[n];
        for (int i = 0; i < n; i++) { long s = System.nanoTime(); send(port, path.apply(i), headers); t[i] = System.nanoTime() - s; }
        Arrays.sort(t);
        System.out.printf("  %-44s p50 %6.1f ms   p95 %6.1f ms   p99 %6.1f ms   最慢 %6.1f ms%n", label,
                t[n / 2] / 1e6, t[(int) (n * 0.95)] / 1e6, t[(int) (n * 0.99)] / 1e6, t[n - 1] / 1e6);
    }

    static void send(int port, String path, String... headers) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://localhost:" + port + path));
        for (int i = 0; i < headers.length; i += 2) b.header(headers[i], headers[i + 1]);
        HttpResponse<Void> r = HTTP.send(b.build(), HttpResponse.BodyHandlers.discarding());
        if (r.statusCode() != 200) throw new IllegalStateException(path + " → " + r.statusCode());
    }

    @Test
    void latency() throws Exception {
        try (var ctx = new SpringApplicationBuilder(ShopApplication.class).run("--server.port=0", "--spring.main.banner-mode=off", "--logging.level.root=WARN")) {
            int port = ((WebServerApplicationContext) ctx).getWebServer().getPort();
            Random r = new Random(3);
            System.out.println("═══ 3.9 單一請求的延遲（依序 300 次；本機 docker compose，10 萬張訂單）═══");
            measure(port, "GET /api/products（隨機關鍵字 + 分類 + 排序）", 300, i -> "/api/products?q="
                    + URLEncoder.encode(WORDS[r.nextInt(WORDS.length)], StandardCharsets.UTF_8) + "&categoryId=" + (new int[]{11, 12, 13, 21, 22})[r.nextInt(5)]
                    + "&sort=price,asc&size=20");
            java.util.List<Long> onSale = ctx.getBean(org.springframework.jdbc.core.JdbcTemplate.class)
                    .queryForList("SELECT id FROM products WHERE status = 'ON_SALE'", Long.class);
            measure(port, "GET /api/products/{id}（隨機的上架商品）", 300, i -> "/api/products/" + onSale.get(r.nextInt(onSale.size())));
            measure(port, "GET /api/orders（買家 1001：3,000 張，第 1 頁 20 筆）", 300, i -> "/api/orders?size=20", "X-Debug-User-Id", "1001");
            measure(port, "GET /api/orders（隨機的一般買家）", 300, i -> "/api/orders?size=20", "X-Debug-User-Id", String.valueOf(1004 + r.nextInt(19_000)));
            measure(port, "GET 日報表（賣家 2、90 天）", 300, i -> "/api/seller/reports/daily-sales?from=2026-07-01&to=2026-09-28",
                    "X-Debug-User-Id", "2", "X-Debug-Roles", "SELLER");
        }
    }
}
```

```
═══ 3.9 單一請求的延遲（依序 300 次；本機 docker compose，10 萬張訂單）═══
  GET /api/products（隨機關鍵字 + 分類 + 排序）          p50    6.4 ms   p95   14.3 ms   p99   28.1 ms   最慢   29.1 ms
  GET /api/products/{id}（隨機的上架商品）               p50    2.9 ms   p95    5.8 ms   p99    8.2 ms   最慢    9.4 ms
  GET /api/orders（買家 1001：3,000 張，第 1 頁 20 筆）   p50    8.1 ms   p95   13.6 ms   p99   25.9 ms   最慢   98.9 ms
  GET /api/orders（隨機的一般買家）                      p50    4.0 ms   p95    7.4 ms   p99   12.8 ms   最慢   57.4 ms
  GET 日報表（賣家 2、90 天）                            p50   19.1 ms   p95   25.3 ms   p99   30.9 ms   最慢  112.6 ms
```

| API | SLO（0.6.2） | 單一請求實測 | 餘裕 |
|---|---|---|---|
| 搜尋 | p99 300 ms（100 rps） | p99 28.1 ms | 10 倍 |
| 我的訂單 | p99 200 ms（100 rps） | p99 25.9 ms（最重度的買家） | 7 倍 |
| 賣家日報表（90 天） | **p95 1 s**（US-RPT-1 AC-4） | **p95 25.3 ms** | 40 倍 |

**US-RPT-1 AC-4 在單一請求下通過**，而且有 40 倍的餘裕 —— 那個餘裕是 3.7.1 的「範圍條件用得到索引」換來的。
「最慢」那一欄的 98.9 ms、112.6 ms 是單一的離群值（JIT、GC、Docker Desktop 的 I/O），**它們正是 p99 以外的那 1%**。負載下它們會變成什麼樣子，是壓測要回答的。

> ⚠️ **上面「隨機的一般買家」那一列，其實不是隨機的**。
> `String.valueOf(1004 + r.nextInt(19_000))` 是 `measure(...)` 的**參數**，在呼叫 `measure` 的那一刻就算好了 —— 300 次請求（加上 30 次暖機）用的是同一位買家。
> lambda 裡的 `path` 每次都重算，旁邊的 `headers` 卻只算一次：兩個東西寫在同一行，看起來一樣「隨機」。
>
> 修法：`measure` 多一個接 `IntFunction<String[]> headers` 的版本，每個請求各自抽一位買家。同時把「組請求」移到計時之前，因為第 05 章之後每個請求要簽一張 JWT，簽 token 的時間不該算進延遲：
>
> ```java
> for (int i = 0; i < n; i++) {
>     HttpRequest req = request(port, path.apply(i), headers.apply(i));
>     long s = System.nanoTime(); send(req); t[i] = System.nanoTime() - s;
> }
> ```
>
> 參考實作的 `ch03`～`ch09` 分支上還是改之前的寫法。
> 修好之後，在第 09 章結束時的程式碼上（身分改用 JWT），舊版與新版交錯各跑 3 輪。舊版那一位固定的買家是 12571。
> 本章上面那次（第 03 章的程式碼、`X-Debug-User-Id`）是不是也是 12571 —— **推測是**，因為 `Random(3)` 在那之前抽的次數相同，但沒有驗證。
>
> | 輪次 | 舊版（固定買家 12571）p50 ／ p95 ／ p99 | 新版（每個請求各抽一位）p50 ／ p95 ／ p99 | 開始時的 load（1 分鐘） |
> |---|---|---|---|
> | 1 | 4.4 ／ 7.5 ／ 12.7 ms | 6.2 ／ 14.3 ／ 26.2 ms | 2.95 ／ 3.80 |
> | 2 | 5.4 ／ 8.7 ／ 12.7 ms | 4.9 ／ 7.2 ／ 10.0 ms | 4.62 ／ 4.98 |
> | 3 | 4.3 ／ 7.4 ／ 16.5 ms | 5.3 ／ 8.8 ／ 12.8 ms | 4.62 ／ 6.09 |
>
> 新版 330 個請求抽到 **326 位**不同的買家（從 19,000 位裡抽 330 次，預期大約重複 3 次，數字對得上）。
> **3 輪裡看不出一致的差別**：第 2、3 輪新版的 p99（10.0、12.8 ms）不比舊版（12.7、16.5 ms）高；第 1 輪新版偏高（26.2 ms）。
> 同一輪 1001 那一列的 p99 23.8 ms 也是 6 輪裡最高的，load 也從 2.95 爬到 3.80，但搜尋、日報表那一輪並沒有一致偏高 —— 第 1 輪是雜訊還是真的差別，3 輪分不出來。
> 兩版還有一個差別混在一起：新版把組請求（拼 URL）也移出了計時。舊版的 JWT 本來就只簽一次、在計時之外，所以混進來的只有拼字串，**推測**是微秒級，沒有量。
> 所以上面「我的訂單 p99 有 7 倍餘裕」的結論不受影響 —— 那是用 1001（3,000 張的重度買家）那一列算的，本來就不靠這一列。
> 為什麼「一位買家」和「三百多位買家」量起來差不多：**推測**是 10 萬張訂單整個裝得進 buffer pool，換不同的買家也不會多讀磁碟，沒有查 `Innodb_buffer_pool_reads` 驗證。

---

## 3.10 本章完成後的專案

```
shop/
├── pom.xml                                          ← + mybatis-spring-boot-starter 3.0.3、springdoc-openapi-starter-webmvc-ui 2.5.0
└── src/
    ├── main/
    │   ├── java/com/example/shop/
    │   │   ├── catalog/
    │   │   │   ├── CatalogApi.java、ProductSnapshot.java           ← 新增：給 cart、ordering 用
    │   │   │   └── internal/
    │   │   │       ├── Product.java                               ← + draft / update / publish / unpublish、money()
    │   │   │       ├── ProductDtos.java、ProductService.java        ← 新增
    │   │   │       ├── ProductRepository.java、CategoryRepository.java、ProductSpecs.java
    │   │   │       └── web/ProductController.java、SellerProductController.java
    │   │   ├── cart/internal/{CartDtos,CartService}.java、web/CartController.java
    │   │   ├── inventory/
    │   │   │   ├── InventoryApi.java                              ← + initialize、available(Collection)
    │   │   │   ├── InsufficientStockException.java                ← 改繼承 ShopException
    │   │   │   └── internal/JdbcInventoryService.java
    │   │   ├── ordering/internal/
    │   │   │   ├── OrderRepository.java、OrderItemRepository.java、OrderDtos.java、OrderQueryService.java
    │   │   │   └── web/OrderQueryController.java
    │   │   ├── reporting/internal/{SalesReportMapper,SalesReportService}.java、web/SellerReportController.java
    │   │   └── shared/
    │   │       ├── config/ClockConfig.java                       ← 新增
    │   │       ├── config/ShopProperties.java                    ← + security.debugHeaders
    │   │       ├── error/{ProblemType,ShopException,ConstraintViolations}.java
    │   │       └── web/{GlobalExceptionHandler,CurrentUser,CurrentUserResolver,Role,PageResponse,SortWhitelist,OpenApiConfig}.java
    │   └── resources/
    │       ├── application.yml                            ← + pageable.max-page-size、mybatis
    │       ├── application-local.yml                      ← + shop.security.debug-headers: true
    │       └── mapper/reporting/SalesReportMapper.xml
    └── test/
        ├── java/com/example/
        │   ├── lab/ch03/…                                  ← 3.2 的「照教學寫」迷你應用程式
        │   └── shop/
        │       ├── acceptance/CapstoneAcceptanceTest        ← Q4 變綠
        │       ├── api/{CatalogCartApiTest,OpenApiContractTest}.java      ← 新增
        │       ├── architecture/MapperXmlSafetyTest.java                   ← 新增
        │       ├── architecture/ModuleBoundaryTest.java                    ← catalog → inventory
        │       ├── catalog/internal/D5*.java                               ← 3.7.2 的實驗（要用 package-private 的類別）
        │       └── ch03/D0～D6                                             ← 本章的實驗
        └── resources/openapi/shop-api.json                  ← API 契約的快照
```

```bash
mvn clean test
```

```
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 4.940 s -- in com.example.shop.schema.SchemaConstraintTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.040 s -- in com.example.shop.schema.EntitySchemaDriftTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 5.059 s -- in com.example.shop.schema.InvariantReconciliationTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.042 s -- in com.example.shop.architecture.TableOwnershipTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.009 s -- in com.example.shop.architecture.MigrationOwnershipTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.004 s -- in com.example.shop.architecture.MapperXmlSafetyTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.042 s -- in com.example.shop.architecture.ConfigKeyGuardTest
Q6：從空資料庫套用 10 個 migration → 20 張表（含 flyway_schema_history）、CHECK 24 / 24、具名索引 31 / 31；validate 通過
Q4：size=5   → HTTP 200，5 張訂單、15 個明細，SQL 3 句
Q4：size=20  → HTTP 200，20 張訂單、60 個明細，SQL 3 句
Q4：size=45  → HTTP 200，45 張訂單、135 個明細，SQL 3 句
[WARNING] Tests run: 11, Failures: 0, Errors: 0, Skipped: 9, Time elapsed: 16.10 s -- in com.example.shop.acceptance.CapstoneAcceptanceTest
[INFO] Tests run: 8, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 1.183 s -- in com.example.shop.api.CatalogCartApiTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.328 s -- in com.example.shop.api.OpenApiContractTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.892 s -- in com.example.shop.architecture.EntityTableOwnershipTest
[INFO] Tests run: 6, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.083 s -- in com.example.shop.architecture.ModuleBoundaryTest
[WARNING] Tests run: 34, Failures: 0, Errors: 0, Skipped: 9
[INFO] BUILD SUCCESS
[INFO] Total time:  32.580 s
```

在本章結束時的程式碼上、用一套全新的 compose（空的資料庫，Flyway 從第一個 migration 開始）跑 `mvn clean verify`：

```bash
mvn clean verify
```

```
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 4.030 s -- in com.example.shop.schema.SchemaConstraintTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.015 s -- in com.example.shop.schema.EntitySchemaDriftTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.024 s -- in com.example.shop.schema.InvariantReconciliationTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.019 s -- in com.example.shop.architecture.TableOwnershipTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.005 s -- in com.example.shop.architecture.MigrationOwnershipTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.003 s -- in com.example.shop.architecture.MapperXmlSafetyTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.030 s -- in com.example.shop.architecture.ConfigKeyGuardTest
[WARNING] Tests run: 11, Failures: 0, Errors: 0, Skipped: 9, Time elapsed: 14.61 s -- in com.example.shop.acceptance.CapstoneAcceptanceTest
[INFO] Tests run: 8, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.966 s -- in com.example.shop.api.CatalogCartApiTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.258 s -- in com.example.shop.api.OpenApiContractTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.651 s -- in com.example.shop.architecture.EntityTableOwnershipTest
[INFO] Tests run: 6, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.091 s -- in com.example.shop.architecture.ModuleBoundaryTest
[WARNING] Tests run: 34, Failures: 0, Errors: 0, Skipped: 9
[INFO] ...
[INFO] Building jar: …/target/shop-0.0.1-SNAPSHOT.jar
[INFO] ...
[INFO] BUILD SUCCESS
[INFO] ...
[INFO] Total time:  24.703 s
```

34 個測試、跳過 9 個 —— 跟上面一樣。`verify` 比 `test` 多做的是打包 jar（`spring-boot:repackage`）；覆蓋率門檻要到第 08 章才有。

**34 個測試、`Skipped: 9`（Q4 變綠）、33 秒。** 驗收測試花了 16 秒：Q6 與 Q4 各自啟動一個完整的應用程式（Q4 還啟動了 Tomcat）。
第 08 章會處理「每個驗收題各起一個 context」這件事 —— 現在它們的獨立性比速度重要。

**追溯表更新**（0.12.2）：

| 需求 | 驗證方式 | 狀態 |
|---|---|---|
| PRD-1 AC-1、AC-2、AC-4 | `CatalogCartApiTest` | ✅ 03 |
| PRD-2 AC-2、AC-3、AC-4 | `CatalogCartApiTest.search`（size 上限、排序白名單、`escapeLike`） | ✅ 03 |
| PRD-3 AC-2、PRD-4 AC-2 | `draftVisibility`、`cartSeesPriceChangeAndUnpublish` | ✅ 03 |
| PRD-1 AC-3、PRD-2 AC-1、AC-5 | 只被間接用到（`createPublished` 之後搜尋、未登入搜尋），沒有專門的斷言 | 部分 |
| PRD-4 AC-1、PRD-5 | 有實作（3.5.3），**沒有測試** | ❌ |
| PRD-3 AC-3、AC-4（快取） | —— | 06 |
| CART-1 AC-1、AC-2、AC-5、CART-2 AC-1 | `CatalogCartApiTest.cart`、`cartSeesPriceChangeAndUnpublish` | ✅ 03 |
| CART-1 AC-3、AC-4、CART-2 AC-3 | 有實作（3.6.1），**沒有測試**（AC-3 見 3.6.1 的 ⚠️） | ❌ |
| CART-2 AC-2（結帳排除下架商品） | —— | 04 |
| ORD-5 AC-1、AC-2 | 驗收 **Q4**（`status` 篩選沒有測） | ✅ 03 |
| ORD-5 AC-3（404 + 稽核） | 404 有實作、沒有測試；稽核在 05 | 部分 |
| RPT-1 AC-1～3 | `SalesReportService`（每日一列、台北切日、366 天上限）—— **這是實作，不是測試**；AC-2 只有實驗 D4 | ❌ 沒有自動化測試 |
| RPT-1 AC-4 | 3.9.2 單一請求 p95 25 ms（實驗 D6，不在 `mvn test` 裡） | 部分（負載下在 08） |
| 0.6.5 MyBatis 禁用 `${}` | `MapperXmlSafetyTest` | ✅ 03 |
| 0.6.5 錯誤回應不含堆疊、類別名、SQL | `GlobalExceptionHandler` + 3.2.2 的對照 | ✅ 03 |
| 0.6.8 OpenAPI 由程式碼產生、檢查變更 | `OpenApiContractTest` | ✅ 03 |

### 3.10.1 本章其餘檔案的完整內容

正文為了專注在設計決定，沒有貼出下面這些檔案。它們都很短，但少了任何一個，專案就編譯不過或起不來。以下是參考實作（`ch03` 分支）的完整內容。

#### catalog

**`catalog/CatalogApi.java`**

```java
package com.example.shop.catalog;

import java.util.Collection;
import java.util.Map;

/** 商品模組的對外入口（給 cart、ordering 用）。 */
public interface CatalogApi {

    /** 一次取多個商品的快照（一句 SQL）。不存在的 id 不會出現在結果裡。 */
    Map<Long, ProductSnapshot> snapshots(Collection<Long> productIds);
}
```

**`catalog/ProductSnapshot.java`**

```java
package com.example.shop.catalog;

import java.math.BigDecimal;

/** 其他模組看到的商品：只有它們需要的欄位，而且是「讀的那一刻」的值。 */
public record ProductSnapshot(long id, long sellerId, String name, BigDecimal price, ProductStatus status, boolean hot) {
    public boolean purchasable() { return status == ProductStatus.ON_SALE; }
}
```

**`catalog/internal/CategoryRepository.java`**

```java
package com.example.shop.catalog.internal;

import org.springframework.data.jpa.repository.JpaRepository;

interface CategoryRepository extends JpaRepository<Category, Long> {}
```

**`catalog/internal/ProductRepository.java`**

```java
package com.example.shop.catalog.internal;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.JpaSpecificationExecutor;

interface ProductRepository extends JpaRepository<Product, Long>, JpaSpecificationExecutor<Product> {

    Page<Product> findBySellerId(long sellerId, Pageable pageable);
}
```

#### cart

**`cart/internal/CartDtos.java`**

```java
package com.example.shop.cart.internal;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;

import java.math.BigDecimal;
import java.util.List;

public final class CartDtos {

    private CartDtos() {}

    public record AddItemRequest(
            @NotNull(message = "商品必填") Long productId,
            @NotNull(message = "數量必填") @Min(value = 1, message = "數量 1～99") @Max(value = 99, message = "數量 1～99") Integer quantity) {}

    public record ChangeQuantityRequest(
            @NotNull(message = "數量必填") @Min(value = 1, message = "數量 1～99") @Max(value = 99, message = "數量 1～99") Integer quantity) {}

    /**
     * 購物車的一個品項（US-CART-2）。unitPrice 是「現在」的價格；
     * priceChanged / previousPrice 讓前端提醒使用者；unavailable 表示已下架（US-PRD-4 AC-2）。
     */
    public record CartLine(long productId, String name, BigDecimal unitPrice, int quantity,
                           boolean priceChanged, BigDecimal previousPrice, boolean unavailable, List<String> warnings) {}

    /** US-CART-2 AC-3：依賣家分組；結帳一次只能結一組 */
    public record SellerGroup(long sellerId, List<CartLine> items, BigDecimal subtotal) {}

    public record CartView(List<SellerGroup> groups, int itemCount) {}
}
```

**`cart/internal/web/CartController.java`**

```java
package com.example.shop.cart.internal.web;

import com.example.shop.cart.internal.CartDtos.*;
import com.example.shop.cart.internal.CartService;
import com.example.shop.shared.web.CurrentUser;
import com.example.shop.shared.web.Role;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.*;

/** US-CART-1、US-CART-2 */
@RestController
@RequestMapping("/api/cart")
class CartController {

    private final CartService service;

    CartController(CartService service) { this.service = service; }

    @GetMapping
    CartView view(CurrentUser user) {
        return service.view(user.require(Role.BUYER).id());
    }

    @PostMapping("/items")
    CartView add(CurrentUser user, @Valid @RequestBody AddItemRequest req) {
        return service.add(user.require(Role.BUYER).id(), req);
    }

    @PatchMapping("/items/{productId}")
    CartView change(CurrentUser user, @PathVariable long productId, @Valid @RequestBody ChangeQuantityRequest req) {
        return service.change(user.require(Role.BUYER).id(), productId, req);
    }

    @DeleteMapping("/items/{productId}")
    CartView remove(CurrentUser user, @PathVariable long productId) {
        return service.remove(user.require(Role.BUYER).id(), productId);
    }
}
```

#### ordering

**`ordering/internal/OrderDtos.java`**

```java
package com.example.shop.ordering.internal;

import com.example.shop.ordering.OrderStatus;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;

public final class OrderDtos {

    private OrderDtos() {}

    /** 訂單對外只用 orderNo 識別，不暴露內部 id（0.6.7） */
    public record OrderView(String orderNo, OrderStatus status, BigDecimal totalAmount, Instant createdAt,
                            Instant paymentDeadline, List<OrderLineView> items) {}

    public record OrderLineView(long productId, String productName, BigDecimal unitPrice, int quantity, BigDecimal lineAmount) {}
}
```

**`ordering/internal/OrderRepository.java`**

```java
package com.example.shop.ordering.internal;

import com.example.shop.ordering.OrderStatus;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Optional;

interface OrderRepository extends JpaRepository<Order, Long> {

    Page<Order> findByBuyerId(long buyerId, Pageable pageable);

    Page<Order> findByBuyerIdAndStatus(long buyerId, OrderStatus status, Pageable pageable);

    Page<Order> findBySellerId(long sellerId, Pageable pageable);

    Page<Order> findBySellerIdAndStatus(long sellerId, OrderStatus status, Pageable pageable);

    Optional<Order> findByOrderNo(String orderNo);
}
```

**`ordering/internal/web/OrderQueryController.java`**

```java
package com.example.shop.ordering.internal.web;

import com.example.shop.ordering.OrderStatus;
import com.example.shop.ordering.internal.OrderDtos.OrderView;
import com.example.shop.ordering.internal.OrderQueryService;
import com.example.shop.shared.web.CurrentUser;
import com.example.shop.shared.web.PageResponse;
import com.example.shop.shared.web.Role;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import org.springframework.web.bind.annotation.*;

/** US-ORD-5：買家查自己的訂單、賣家查自己商品的訂單 */
@RestController
class OrderQueryController {

    private final OrderQueryService service;

    OrderQueryController(OrderQueryService service) { this.service = service; }

    @GetMapping("/api/orders")
    PageResponse<OrderView> mine(CurrentUser user,
                                 @RequestParam(required = false) OrderStatus status,
                                 @RequestParam(defaultValue = "0") @Min(value = 0, message = "page 不可為負") int page,
                                 @RequestParam(defaultValue = "20") @Min(value = 1, message = "size 1～100") @Max(value = 100, message = "size 1～100") int size) {
        return service.buyerOrders(user.require(Role.BUYER).id(), status, page, size);
    }

    @GetMapping("/api/orders/{orderNo}")
    OrderView one(CurrentUser user, @PathVariable String orderNo) {
        return service.buyerOrder(user.require(Role.BUYER).id(), orderNo);
    }

    @GetMapping("/api/seller/orders")
    PageResponse<OrderView> sellerOrders(CurrentUser user,
                                         @RequestParam(required = false) OrderStatus status,
                                         @RequestParam(defaultValue = "0") @Min(value = 0, message = "page 不可為負") int page,
                                         @RequestParam(defaultValue = "20") @Min(value = 1, message = "size 1～100") @Max(value = 100, message = "size 1～100") int size) {
        return service.sellerOrders(user.require(Role.SELLER).id(), status, page, size);
    }
}
```

`OrderItem` 只多一行 `orderId()`（3.6.2）。

#### inventory

`JdbcInventoryService` 的新方法在 3.3.3；檔案開頭到類別宣告之前的部分（import 多了 `Collection`、`HashMap`、`Map`）：

```java
package com.example.shop.inventory.internal;

import com.example.shop.inventory.InsufficientStockException;
import com.example.shop.inventory.InventoryApi;
import com.example.shop.inventory.ReserveLine;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
```

#### shared

**`shared/config/ClockConfig.java`**

```java
package com.example.shop.shared.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.time.Clock;

/** 全站唯一的「現在」。測試可以換成固定的 Clock（第 04 章的付款逾時會用到）。 */
@Configuration(proxyBeanMethods = false)
class ClockConfig {
    @Bean
    Clock clock() { return Clock.systemUTC(); }
}
```

**`shared/web/PageResponse.java`**

```java
package com.example.shop.shared.web;

import org.springframework.data.domain.Page;

import java.util.List;
import java.util.function.Function;

/**
 * 分頁回應的固定格式（US-PRD-2 AC-1）。不直接回傳 Spring Data 的 Page：
 * 它的 JSON 形狀是實作細節（pageable、sort、empty、numberOfElements……），升級 Spring Data 時可能改變。
 */
public record PageResponse<T>(List<T> content, int page, int size, long totalElements, int totalPages) {

    public static <E, T> PageResponse<T> of(Page<E> page, Function<E, T> mapper) {
        return new PageResponse<>(page.getContent().stream().map(mapper).toList(),
                page.getNumber(), page.getSize(), page.getTotalElements(), page.getTotalPages());
    }

    public static <T> PageResponse<T> of(Page<?> page, List<T> content) {
        return new PageResponse<>(content, page.getNumber(), page.getSize(), page.getTotalElements(), page.getTotalPages());
    }
}
```

#### 3.2 的實驗（`src/test/java`）

**`lab/ch03/LabProduct.java`**

```java
package com.example.lab.ch03;

import jakarta.persistence.*;

import java.math.BigDecimal;

@Entity
@Table(name = "products")
public class LabProduct {
    @Id Long id;
    long sellerId;
    String name;
    BigDecimal price;
    String status;

    public Long getId() { return id; }
    public String getName() { return name; }
    public BigDecimal getPrice() { return price; }
}
```

**`lab/ch03/LabOrderItemRepository.java`**

```java
package com.example.lab.ch03;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;

public interface LabOrderItemRepository extends JpaRepository<LabOrderItem, Long> {
    @Modifying
    @Transactional
    @Query(value = "insert into order_items (id, order_id, product_id, product_name, unit_price, quantity) values (:id, :orderId, :productId, :name, :price, :qty)",
           nativeQuery = true)
    void insert(long id, long orderId, long productId, String name, BigDecimal price, int qty);
}
```

**`shop/ch03/D0OsivWarningTest.java`**

```java
package com.example.shop.ch03;

import com.example.lab.ch03.LabShopApp;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.boot.builder.SpringApplicationBuilder;

/** 3.2.1：不設定 spring.jpa.open-in-view 時，Boot 啟動會印出什麼 */
@Tag("experiment")
class D0OsivWarningTest {
    @Test
    void osivDefaultWarning() {
        try (var ctx = new SpringApplicationBuilder(LabShopApp.class).run("--spring.config.name=no-such-config",            // 不讀 application*.yml：看 Boot 的預設行為
                "--spring.datasource.url=jdbc:mysql://localhost:3306/shop?useSSL=false&allowPublicKeyRetrieval=true&connectionTimeZone=UTC",
                "--spring.datasource.username=shop", "--spring.datasource.password=shop",
                "--server.port=0", "--spring.flyway.enabled=false",
                "--spring.jpa.hibernate.ddl-auto=none", "--spring.main.banner-mode=off", "--logging.level.root=WARN")) {
            System.out.println("open-in-view 預設值 = " + ctx.getEnvironment().getProperty("spring.jpa.open-in-view", "（未設定 → true）"));
        }
    }
}
```

---

## 3.11 常見誤區

**① 「Controller 直接回傳 Entity 最簡單」**

3.2.1：雙向關聯 → **HTTP 200 + 殘缺的 JSON**；lazy 集合 → 500；打開 OSIV → 22 / 102 句 SQL。而且每一個 getter 都變成了公開的 API 欄位。**回傳 DTO，在交易裡組好。**

**② 「N+1 就用 `JOIN FETCH` 解決」**

3.2.1 ④：`JOIN FETCH` + 分頁 → `HHH90003004`，Hibernate 把**所有**列讀進記憶體再分頁 —— 為了回傳 20 筆，載入 11,969 個 Entity。**分頁的查詢，集合用第二句 `IN` 查詢載入**（3.6.2）。

**③ 「open-in-view 開著比較方便」**

它讓 N+1 發生在 Jackson 裡、讓資料庫連線在整個請求期間被佔住、讓「查詢在哪裡發生」變得不可見。Spring Boot 自己都會印一行 WARN。**關掉它，讓 lazy loading 的錯誤在開發時就出現。**

**④ 「錯誤回應裡放 `e.getMessage()`，方便前端除錯」**

3.2.2：SQL、資料庫名、表名、外鍵名、Java 類別名 —— 全部送到使用者的瀏覽器。而且接 `Exception.class` 會把 400 變成 500。
**前端要的是「哪個欄位、什麼問題」（`errors[]`）與「可以被程式判斷的類型」（`type`），不是例外訊息。**

**⑤ 「Spring Data JPA 會幫我處理 `LIKE`」**

3.2.3：**只有衍生查詢（`...Containing`）會跳脫**。`@Query` 的 `%:q%` 與 Criteria 的 `cb.like` 都不會 —— `%` 會回傳全部 9,486 筆。

**⑥ 「資料庫存 UTC，`DATE(created_at)` 就是那一天」**

3.2.4：那是 UTC 的那一天。28 天裡 25 天錯、9.8% 的訂單被算到前一天。**切日的邊界在 Java 用台北時區算，SQL 只做範圍比較。**

**⑦ 「危險的功能用 `@Profile("local")` 關在本機就好」**

3.3.4：它不存在的時候，Spring 的預設行為（`@ModelAttribute` 綁定）接手了 —— `?id=2&roles=SELLER` 就能冒充賣家。**危險的功能要「永遠存在、預設關閉」，而不是「只在某些環境存在」。**

**⑧ 「權限檢查寫在 Controller 方法的第一行」**

3.4.4：`@Valid @RequestBody` 在方法執行**之前**就驗證了。沒有權限的人拿到 400 和完整的欄位規則。**權限要在參數解析之前檢查**（interceptor、Security filter）。

**⑨ 「接 `DataIntegrityViolationException` 就能處理約束違反」**

3.6.1：MySQL 的 CHECK 違反（3819）在 Spring 裡是 `UncategorizedSQLException`。**接 `DataAccessException`，再用錯誤碼與約束名辨認**；不認得的原樣丟出去。

**⑩ 「JPA 和 MyBatis 共用交易，所以它們看到的是一樣的資料」**

3.7.2：共用交易 ✅，但 JPA 沒 flush 時 MyBatis 看不到；flush 之後 MyBatis 的 local cache 還會回傳舊值。**讀寫分開，並把 `local-cache-scope` 設成 `statement`。**

**⑪ 「OpenAPI 是自動產生的，所以一定是對的」**

3.8.1：`CurrentUser` 變成必填的 query 參數、`Pageable` 變成一個叫 `pageable` 的物件。**產生器用的是跟 Spring MVC 一樣的推論規則 —— 包括錯的那些。讀它一次，然後用快照守住它。**

**⑫ 「`BigDecimal` 的價格用 `equals` 比較」**

3.5.2：`299` 與 `299.00` 不 `equals`。**金額在進入系統時就正規化 scale，比較一律用 `compareTo`。** 第 04 章會量出用錯的代價。

---

## 3.12 本章小結

**這一章建立了五件事**：

1. **一條界線**（3.2.1、3.5.1）：Controller 回傳 DTO、在交易裡組好；Entity 永遠不出現在 HTTP 上。輸入 DTO 決定「客戶端可以決定什麼」，輸出 DTO 決定「API 回傳什麼」。
2. **一個錯誤出口**（3.4）：`ProblemType` + `ShopException` + `GlobalExceptionHandler`；`shared` 不依賴任何模組；回應裡沒有任何一個字來自例外的原始訊息。
3. **一組實測過的坑**（3.2.2～3.2.4、3.3.4、3.4.4、3.6.1、3.7.2）：錯誤訊息洩漏、`LIKE` 萬用字元、UTC 切日、fail-open 的身分、驗證比權限先跑、CHECK 的例外型別、MyBatis 的快取。
4. **一個固定成本的查詢**（3.6.2、3.6.3）：訂單列表一頁固定 3 句 SQL，**驗收 Q4 變綠**。
5. **一份被守著的契約**（3.8）：OpenAPI 由程式碼產生、修正了三個推論錯誤、並用快照讓每一個 API 變更都出現在 PR 裡。

**如果這一章只能記一句話**：

> **API 層的 bug 不會讓程式當掉 —— 它會回 200、回傳全部、回傳昨天的數字、或讓任何人變成任何人。每一個「成功」都要驗證它給出去的是什麼。**

### 3.12.1 驗收清單

做得到才往下走：

- [ ] 跑完 3.2.1，說出四種設定的 HTTP 狀態、SQL 句數、載入的 Entity 數，以及 ① 為什麼是 200。
- [ ] 說出 `HHH90003004` 的意思，以及 3.6.2 的三句 SQL 分別是什麼。
- [ ] 跑完 3.2.2，列出「好心」處理器洩漏的四類資訊，以及它為什麼把 400 變成 500。
- [ ] 說出三種 JPA `LIKE` 寫法哪一種會跳脫，並解釋 `escapeLike` 的三個 `replace` 為什麼要照那個順序。
- [ ] 跑完 3.2.4，說出 25 天錯、329 張訂單的來源，以及寫法二與寫法三的 EXPLAIN 差在哪。
- [ ] 說出 `@Profile("local")` 的解析器為什麼是 fail-open，並用非 local 的 profile 實測一次修正後的 401。
- [ ] 說出為什麼 `ShopException` 放在 `shared.error`，以及 `shared.web` 的處理器怎麼做到不認識任何模組。
- [ ] 說出為什麼買家呼叫賣家 API 第一版拿到的是 400，以及 interceptor 為什麼能修好它。
- [ ] 用 `curl` 送一個帶 `sellerId` 與 `status` 的建立商品請求，確認兩者都被忽略。
- [ ] 說出 CHECK 違反在 `JdbcTemplate` 裡是哪一個例外，以及 `ConstraintViolations` 為什麼最後要 `throw e`。
- [ ] 跑完 3.7.2，說出兩個陷阱各在哪一行出現，以及本專題的對策。
- [ ] 打開 `/swagger-ui.html`，確認 `GET /api/products` 的參數是 `page`、`size`、`sort`，而且沒有 `user`。
- [ ] 改一支 API 的參數名，看 `OpenApiContractTest` 紅；改回來。
- [ ] `mvn clean verify` 顯示 `Tests run: 34, Failures: 0, Errors: 0, Skipped: 9`。

### 3.12.2 本章練習

**練習一（20 分鐘）：購物車的連點**

寫一個 JPA 版的 `add`：先 `findById((buyerId, productId))`，有就 `quantity += n`，沒有就 `save(new CartItem(...))`。
用 `CountDownLatch` 讓 10 條執行緒同時對同一個商品加 1 件。**最後的數量是多少？有幾個請求失敗、失敗的例外是什麼？** 跟 3.6.1 的一句 upsert 比較。

**練習二（15 分鐘）：`@BatchSize` 也是一種答案**

把 3.2.1 的迷你應用程式的 `LabOrder.items` 加上 `@BatchSize(size = 100)`（或設定 `hibernate.default_batch_fetch_size=100`），打開 OSIV，重跑 ③。
SQL 變成幾句？**它跟 3.6.2 的明確 `IN` 查詢比，各有什麼優缺點？**（提示：想想「誰看得出這支 API 會執行幾句 SQL」。）

**練習三（15 分鐘）：報表的另一種歸日**

把 `SalesReportMapper.xml` 的付款那一段改成「依**訂單成立日**歸日」（`GROUP BY DATE(CONVERT_TZ(o.created_at, ...))`，條件改成 `created_at` 的範圍）。
用賣家 2 的 9 月資料比較兩種版本的每日 `paidAmount`：**哪幾天不一樣？差多少？** 寫下你會怎麼跟產品經理解釋這兩種數字各自的用途。

**練習四（20 分鐘）：`HandlerMethodValidationException` 的訊息**

`GET /api/orders?size=500`、`GET /api/orders?size=abc`、`GET /api/orders?status=REFUNDED` —— 三個請求各回什麼？
其中哪兩個的訊息**不是**我們寫的（提示：`MethodArgumentTypeMismatchException` —— `OrderStatus` 沒有 `REFUNDED`）？在 `GlobalExceptionHandler` 補上它，讓三個都回乾淨的 400。

**練習五（20 分鐘）：OpenAPI 的錯誤回應**

目前的 OpenAPI 文件沒有描述任何錯誤回應（只有 200）。用 springdoc 的 `OpenApiCustomizer`，
**為每一個 operation 加上 `400`、`401`、`404` 的 `ProblemDetail` schema**，並讓 `type` 欄位的 enum 來自 `ProblemType.values()`。
更新快照，看它在 PR 裡的 diff 有多大。

**練習六（15 分鐘）：換一個 profile 再看一次**

用 `--spring.profiles.active=noauth`（加上資料庫的命令列參數）啟動，打開 `/swagger-ui.html`。
**文件還看得到嗎？在正式環境要不要讓它看得到？** 寫出你的決定，並用 `springdoc.api-docs.enabled` / `springdoc.swagger-ui.enabled` 實作它（記得 `ConfigKeyGuardTest` 會檢查你的鍵名）。

**練習七（進階，30 分鐘）：把「好心」的需求做對**

前端的需求其實是合理的：「出錯時，我想知道要給使用者看什麼、要不要重試、要回報什麼給客服。」
設計一個欄位（例如 `errorId`）：伺服器在 `handleUnexpected` 時產生一個 UUID、寫進日誌、放進回應；客服拿著這個 id 就能在日誌裡找到那一行。
**這個 id 洩漏了什麼、沒洩漏什麼？** 第 09 章的 `traceId` 會取代它 —— 比較兩者的差異。

**練習八（進階，30 分鐘）：Q4 的另一半**

驗收 Q4 只量了買家的列表。為 `GET /api/seller/orders`（賣家 2，1 萬多張訂單）寫同樣的斷言，
並加一個 `status=PICKING` 的版本。**SQL 還是 3 句嗎？**用 `EXPLAIN ANALYZE` 看它實際讀了幾列，回頭檢查第 02 章練習四的索引決定。

---

## 3.13 下一章預告

下一章（04）是這個專題的**第一個重頭戲**：下單。

到目前為止，所有 API 都是「讀」或「只影響一個人的寫」（購物車、自己的商品）。下單不一樣 —— 它在**一個交易裡**寫 5 張表、預留別人也在搶的庫存、而且會被重送、被重複點擊、被排程與金流回呼**同時**改狀態。

下一章會回答 0.12 的前三題驗收：

- **Q1 交易邊界**：下單失敗時，訂單、明細、預留、庫存帳都沒有殘留 —— 包括一個「接住了例外、卻讓整個請求變成 500」的經典寫法。
- **Q2 防超賣**：100 條執行緒搶最後 1 件。**四種寫法**（讀了再寫、`@Version` 樂觀鎖、`SELECT ... FOR UPDATE`、條件式 UPDATE）各跑一次，量它們的超賣數、500 數與 p99。
- **Q3 冪等下單**：同一個 `Idempotency-Key` 同時送兩次、先後送兩次、送一次失敗再送一次。

以及 0.5 那張 6 × 9 的狀態轉移表：`OrderStateMachine` 與 54 個參數化測試、付款回呼的驗簽與冪等、付款逾時排程（兩個實例同時跑也不重複取消），
還有 US-ORD-3 AC-5 —— 整個專題最難的那一條 AC：**排程取消與付款回呼在同一毫秒撞上**。

本章留下的兩個伏筆也會在那裡回收：3.5.2 的 `299` vs `299.00`（價格比對用錯方法會發生什麼事），以及 3.6.1 的 CHECK 例外（下單時違反 `ck_inventory_reserved` 會長什麼樣子）。

門窗裝好了。下一章讓人開始搶購。
