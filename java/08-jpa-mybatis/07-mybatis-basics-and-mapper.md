# 第 07 章：MyBatis 基礎 —— Mapper、TypeHandler、參數與結果映射

> 前面六章教了十四個機制。把它們拿到 MyBatis 上盤點一次：
>
> ```
> 持久化情境？   🔴 沒有。撈回來的是普通 POJO，改了它什麼都不會發生。
> 髒檢查？      🔴 沒有。你不呼叫 update，就沒有 UPDATE。
> flush 時機？   🔴 沒有。呼叫 mapper 方法，SQL 就送出去了。
> 樂觀鎖？      🔴 沒有。version = version + 1 要你自己寫（7.10.3）
> ─────────────────────────────────────────────────────────────
> 一級快取？    🟡 有，而且跟 JPA 的【完全不是同一個東西】（7.11）
> 二級快取？    🟡 有，而且它跟 JPA 的那個【互相不知道對方存在】（7.11.6）
> 批次？        🟡 有，而且它需要跟 06 章【同一個】JDBC URL 參數（7.10.4）
> N+1？        🟡 有，而且它是【你自己寫進 XML 的】（7.8.7）
> ─────────────────────────────────────────────────────────────
> 悲觀鎖？      ✅ 直接寫 FOR UPDATE，比 JPA 直白（7.10.5）
> DTO 投影？    ✅ 這是它的預設行為，不需要「投影」這個概念（7.8）
> ```
>
> **完整的十四格在 7.2。**
>
> ---
>
> **這一章不是「用另一個工具做同一件事」。**
> **它是把上面那三格【一格一格量出來】——**
> **尤其是中間那六格，因為「有，但不是同一個東西」是這一章最多坑的地方。**

---

這一章有 **46 個實測**。挑十個先講結果：

- 一個 `@Mapper` 介面在執行期是 **JDK 動態代理**，背後是一張
  「**字串 → SQL**」的註冊表。這一章會把那張表印出來（47 個 statement）
- `#{}` 與 `${}` 送到 MySQL 的東西 —— **打開 general log 看，兩者都是
  `WHERE o.status = 'PENDING'` 這個字面值** ★★
  （所以 `#{}` 的安全性**不是**「值不會變成 SQL 文字」）
- 🔴 `ORDER BY ${sortColumn}` 只能用 `${}`；而**改用 `#{}` 的話 MySQL
  不會報錯、也不會排序** —— 比報錯更糟
- 🔴 少一個 `TypeHandler`：`UPDATE` 影響 **0 列**、`count` 回 **0**、
  而回傳 `void` 的方法**連那個 0 都看不到**（收掉 00 章 0.5.4）
- `javaType="long"` 在 MyBatis 裡是 **`java.lang.Long`**，
  對上 record 的 `long` 欄位 → `NoSuchMethodException`。要寫 **`_long`**
  （05 章 5.8.5 那個 `long` / `Long` 的坑，換一個入口又出現一次）
- 巢狀 `resultMap` 與巢狀 `select` 的差別是 XML 裡**一行**：
  **1 句 SQL / 2 ms   vs   39 句 SQL / 15 ms**
- ★ 每一份教學都說「巢狀 `resultMap` 忘了 `ORDER BY` 會把訂單拆開」——
  **預設組態下不會**。要 `resultOrdered="true"` 才會，
  而那時候「2 張訂單」會變成「**4 個物件**」★★
- 🔴🔴 `ExecutorType.BATCH` 插 1000 筆：**1124 ms**，
  而不批次是 **301 ms** —— **批次比不批次慢 3.7 倍**。
  加上 06 章 6.3.7 那個 URL 參數之後是 **10 ms**（112 倍）★★
- ★ MyBatis 的一級快取：**同一個交易裡查兩次，回來的是【同一個物件實例】**——
  這修正了 00 章 0.5.3 那句「查兩次得到兩個不同的物件」
- shop-service 的列表頁，**兩個框架回傳同一個 `record`、第一列一字不差**、
  都是 **0 個實體**：JPA 2 句 SQL / 2699 µs，MyBatis 2 句 / 1188 µs

📌 **這一章的主線**：

> **MyBatis 只做兩件事：**
> **① 把方法的參數塞進你寫的 SQL（`#{}` / `${}` / `TypeHandler`）**
> **② 把結果集的列變成你指定的 Java 型別（`resultType` / `resultMap`）**
>
> **而這一章的每一個坑，都出現在【那兩個「把 X 變成 Y」的邊界上】。**
> **JPA 的坑在「狀態什麼時候被寫回去」；MyBatis 的坑在「型別對不對得上」。**
> **兩者都很安靜。**

---

## 7.1 學習目標

完成本章後，你應該可以：

- 說出 `mybatis-spring-boot-starter` 為什麼**要自己寫版本號**，以及升 Boot 時要檢查什麼（7.3.1）。
- 印出 `MappedStatement` 註冊表，並用它回答「這個方法的 SQL 到底從哪來」（7.4.2）。
- 說明打錯字在 Spring Data JPA 與 MyBatis 上**分別什麼時候被發現**，
  以及這件事對測試的意義（7.4.5）。
- 寫一個 `TypeHandler`，並說出**沒有它的症狀是什麼**（7.5）。
- 說明 `#{}` 與 `${}` 的差別，並解釋為什麼那個差別**不是**
  「值有沒有出現在 SQL 文字裡」（7.6.3）。
- 對「只能用 `${}`」的位置寫出一個**對照表式**的白名單（7.6.5）。
- 在自動映射、`resultMap`、建構子映射之間做選擇，
  並讓 `record` 當結果型別（7.8）。
- 分辨巢狀 `resultMap` 與巢狀 `select`，並說出後者就是 N+1（7.8.7）。
- 說明 `resultOrdered` 的作用，以及它跟「SQL 要不要 `ORDER BY`」的關係（7.8.8）。
- 用 `Cursor` 處理一百萬列，並說出 `RowBounds` **不能**用來分頁的理由（7.9）。
- 用 `ExecutorType.BATCH` 寫批次，並說出**它可能比不批次還慢**的原因（7.10.4）。
- 說明 MyBatis 的一級快取跟 JPA 的**三個差異**，
  以及「同一個交易裡查兩次拿到同一個物件」會造成什麼問題（7.11）。
- 讓 JPA 與 MyBatis 在同一個交易裡正確地共存（7.12）。

---

## 7.2 換一個世界：前面六章的東西有多少還在

先把帳算清楚。**這是 00 章 0.6 那六條軸的一次盤點**：

| 前六章教的機制 | MyBatis 這一側 | 在哪一節 |
|---|---|---|
| 持久化情境（03 章） | 🔴 **沒有**。回傳的是普通 POJO，改了它什麼都不會發生 | 7.2.1 |
| 髒檢查與自動 `UPDATE`（03 章 3.4） | 🔴 **沒有** | 7.2.1 |
| 一級快取（03 章 3.3） | 🟡 **有，但機制不一樣**（範圍是 `SqlSession`，key 是「SQL + 參數」） | **7.11** |
| 身分保證（同一列 = 同一個實例） | 🟡 **同一個 `SqlSession` 裡有，跨 session 沒有** | **7.11.4** |
| 代理與延遲載入（04 章） | 🟡 有簡化版（`fetchType="lazy"`，08 章會處理） | 08 章 |
| N+1（04 章） | 🔴 **有，而且是你自己寫進 XML 的** | **7.8.7** |
| DTO 投影（05 章 5.8） | ✅ **這是它的預設行為**，不需要「投影」這個概念 | 7.8 |
| `flush` 時機（03 章 3.7） | 🔴 **沒有**。呼叫就送出 | 7.2.1 |
| 批次寫入（06 章 6.3） | 🟡 **有，`ExecutorType.BATCH`**，而且踩同一個坑 | **7.10.4** |
| 二級快取（06 章 6.5） | 🟡 有（`<cache/>`），08 章會處理 | 08 章 |
| 樂觀鎖 `@Version`（06 章 6.6） | 🔴 **沒有**。`version = version + 1` 自己寫 | **7.10.3** |
| 悲觀鎖（06 章 6.7） | ✅ **直接寫 `FOR UPDATE`**，比 JPA 直白 | 7.10.5 |
| 方言轉換（00 章 0.6.6） | 🔴 **沒有**。SQL 就是你寫的那樣 | 7.15.3 |
| 型別轉換 | 🟡 **`TypeHandler`，而且要自己註冊** | **7.5** |

### 7.2.1 實測：那三個「沒有」長什麼樣

```java
    @Test
    void a_那三個沒有() {
        head("7.2.1 沒有持久化情境、沒有髒檢查、沒有 flush");
        seed(3, 1, 0);
        String no = mapper.findAllOrderNos().get(0);

        // ① 撈出來的東西是什麼
        OrderRow row = mapper.findOne(no);
        System.out.println("   撈回來的型別 = " + row.getClass().getName());
        System.out.println("   是代理嗎？ " + java.lang.reflect.Proxy.isProxyClass(row.getClass()));

        // ② 改了它會怎樣
        tx.executeWithoutResult(s -> {
            OrderRow r = mapper.findOne(no);
            r.setCustomerName("我改了");
            r.setTotalAmount(new java.math.BigDecimal("99999"));
        });
        System.out.println("   在交易裡改了它、交易提交之後，資料庫裡是："
                + jdbc.queryForMap("SELECT total_amount FROM orders WHERE order_no = ?", no));
        System.out.println("   ★ 0 句 UPDATE。這就是 00 章 0.3.1 那個事故【不會發生】的世界。");

        // ③ 呼叫就送出
        List<String> sqls = spy(() -> tx.executeWithoutResult(s -> {
            System.out.println("   呼叫 markPaid 之前，SqlSpy 記到 " + SqlSpy.count() + " 句");
            mapper.markPaid(orderIds.get(0), St7Status.PAID, java.time.Instant.now());
            System.out.println("   呼叫 markPaid 之後，SqlSpy 記到 " + SqlSpy.count()
                    + " 句 —— 還沒 commit，SQL 已經送出去了");
        }));
        System.out.println("   → 整段共 " + sqls.size() + " 句");
    }
```

**實測**：

```
   撈回來的型別 = com.example.lab.ch07.OrderRow
   是代理嗎？ false
   在交易裡改了它、交易提交之後，資料庫裡是：{total_amount=100.0000}
   ★ 0 句 UPDATE。這就是 00 章 0.3.1 那個事故【不會發生】的世界。
   呼叫 markPaid 之前，SqlSpy 記到 0 句
   呼叫 markPaid 之後，SqlSpy 記到 1 句 —— 還沒 commit，SQL 已經送出去了
   → 整段共 1 句
```

> 📌 **這三行輸出就是 00 章 0.6 那六條軸的「另一端」**：
>
> ```
> 03 章 3.4.1：「我沒有呼叫 save，資料為什麼變了？」
>              → 在 MyBatis 上這個問題【問不出來】。
>
> 03 章 3.7：  「flush 什麼時候發生？」
>              → 在 MyBatis 上這個問題【沒有意義】。呼叫的那一刻就是。
> ```
>
> ⚠️ **而「呼叫就送出」不代表「呼叫就提交」**：
> 那句 `UPDATE` 是在交易裡送出的，回滾一樣會把它撤掉（7.12 會量）。
> **送出（execute）與提交（commit）是兩件事** —— 07 站 04 章 4.2.6 講過這個區別。

---

## 7.3 整合

### 7.3.1 依賴：版本要自己寫

00 章 0.5.1 已經講過這件事，這裡把它收成一段可以複製的組態。

```xml
<!-- ⚠️ Spring Boot 的 dependencyManagement【不管】MyBatis，版本要自己指定 -->
<dependency>
  <groupId>org.mybatis.spring.boot</groupId>
  <artifactId>mybatis-spring-boot-starter</artifactId>
  <version>3.0.3</version>            <!-- ★ 這一行不能省 -->
</dependency>
```

**它拉進來三個東西**：

```
mybatis-spring-boot-starter 3.0.3
  ├─ mybatis-spring-boot-autoconfigure 3.0.3
  ├─ mybatis-spring        3.0.3
  └─ mybatis               3.5.14        ← 核心
```

**三個版本號沒有對齊，這是正常的。** 而相容矩陣要自己查：

| mybatis-spring-boot-starter | Spring Boot | Java |
|---|---|---|
| 2.2.x / 2.3.x | 2.5 / 2.7 | 8+ |
| **3.0.x（本課）** | **3.0 ～ 3.2** | **17+** |

> ⚠️ **升級 Spring Boot 時要做的事**：
> `spring-boot-starter-data-jpa` 會跟著 parent 一起升，**MyBatis 不會**。
> 所以升級清單上一定要有一行「檢查 mybatis-spring-boot-starter 的相容版本」。
> **而它出問題的方式通常是啟動失敗**（好事）——
> 比 04 章 4.5.4 那種「行為靜默改變」的升級問題好處理。

### 7.3.2 實測：自動組態放了什麼進容器

```java
    @Test
    void a_自動組態放了什麼進容器() {
        head("7.3.2 mybatis-spring-boot-starter 放了什麼 bean 進容器");
        for (String n : List.of("sqlSessionFactory", "sqlSessionTemplate")) {
            System.out.printf("   %-20s → %s%n", n, ctx.getBean(n).getClass().getName());
        }
        System.out.println("   mapper（介面）  → " + Ord7Mapper.class.getName());
        System.out.println("   mapper（實例）  → " + mapper.getClass().getName());
        System.out.println("   是 JDK proxy？  → "
                + java.lang.reflect.Proxy.isProxyClass(mapper.getClass()));
        System.out.println("   handler        → "
                + java.lang.reflect.Proxy.getInvocationHandler(mapper).getClass().getName());
        System.out.println("   mapper bean 的定義 → "
                + ((org.springframework.context.ConfigurableApplicationContext) ctx)
                        .getBeanFactory().getBeanDefinition("ord7Mapper").getBeanClassName());
    }
```

**實測**：

```
   sqlSessionFactory    → org.apache.ibatis.session.defaults.DefaultSqlSessionFactory
   sqlSessionTemplate   → org.mybatis.spring.SqlSessionTemplate
   mapper（介面）  → com.example.lab.ch07.Ord7Mapper
   mapper（實例）  → jdk.proxy2.$Proxy278
   是 JDK proxy？  → true
   handler        → org.apache.ibatis.binding.MapperProxy
   mapper bean 的定義 → org.mybatis.spring.mapper.MapperFactoryBean
```

**四層，各自的職責**：

```
① SqlSessionFactory      讀完所有組態（mapper XML、TypeHandler、設定）之後產生的【工廠】
                         它持有那個 Configuration —— 7.4.2 要印的就是它

② SqlSessionTemplate     ★ 這是 mybatis-spring 的核心，也是它「接進 Spring」的地方。
                         它是【執行緒安全的 SqlSession 代理】：
                           有交易 → 用交易綁定的那個 SqlSession（7.11.3）
                           沒交易 → 開一個、用完就關（7.11.2）

③ MapperFactoryBean      每一個 @Mapper 介面對應一個 FactoryBean，
                         它 getObject() 回傳的就是 ④

④ MapperProxy            JDK 動態代理的 InvocationHandler。
                         把「方法呼叫」翻成「SqlSession.selectList(id, args)」
```

📌 **對照 00 章 0.4.3 那個 Spring Data 的四層**：
兩邊在**這一層的結構上非常像**（都是 JDK proxy + FactoryBean），
**差別在代理背後做什麼** —— 一個解析方法名產生 JPQL，一個查註冊表拿你寫的 SQL。

### 7.3.3 組態項總覽

```yaml
mybatis:
  # ① mapper XML 在哪
  mapper-locations: classpath:mapper/*.xml

  # ② TypeHandler 掃哪個套件（7.5）
  type-handlers-package: com.example.lab.ch07

  # ③ MyBatis 自己的設定（對應 mybatis-config.xml 的 <settings>）
  configuration:
    map-underscore-to-camel-case: true      # order_no → orderNo（7.8.1）
    # 下面這些是預設值，寫出來只為了「讓它出現在程式碼裡」
    cache-enabled: true                     # 二級快取的總開關（08 章）
    local-cache-scope: SESSION              # 一級快取的範圍（7.11.1）
    default-executor-type: SIMPLE           # 7.10.4
    default-statement-timeout: 30           # ★ 預設是【沒有】超時，強烈建議設
    auto-mapping-unknown-column-behavior: NONE   # 🔴 7.8.1 會講為什麼要改它
```

⚠️ **兩個「預設值不好」的設定，值得現在就改**：

```yaml
mybatis:
  configuration:
    # ① 預設是 null（不設超時）→ 一句失控的報表 SQL 可以把連線卡到 innodb 超時（06 章 6.7.7）
    default-statement-timeout: 30

    # ② 預設是 NONE（SQL 有欄位對不上屬性時【完全不說】）→ 7.8.1 那個 null 的來源
    auto-mapping-unknown-column-behavior: WARNING
```

📌 **`map-underscore-to-camel-case` 要不要開**：
**開。** 不開的話每一句 SQL 都要寫別名（`order_no AS orderNo`），
而**忘了寫的下場是那個屬性靜默地是 null**（7.8.1）。

---

## 7.4 Mapper 介面：一個方法怎麼變成一句 SQL

### 7.4.1 這一章的模型

```java
package com.example.lab.ch07;

public enum St7Status { PENDING, PAID, PACKED, SHIPPED, DELIVERED, CANCELLED, REFUNDED }
```

**結果的形狀**。注意它**不對應任何一張表**（00 章 0.5.2）：

```java
package com.example.lab.ch07;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

/**
 * 列表頁那一列。
 * ★ 它【不對應任何一張表】，它對應的是「這一句 SQL 的結果形狀」（00 章 0.5.2）。
 *   customerName 來自 customer 表，不屬於 orders。
 */
public class OrderRow {

    private UUID id;
    private String orderNo;
    private St7Status status;
    private BigDecimal totalAmount;
    private Instant placedAt;
    private String customerName;
    private long itemCount;

    public UUID getId() { return id; }
    public void setId(UUID v) { this.id = v; }
    public String getOrderNo() { return orderNo; }
    public void setOrderNo(String v) { this.orderNo = v; }
    public St7Status getStatus() { return status; }
    public void setStatus(St7Status v) { this.status = v; }
    public BigDecimal getTotalAmount() { return totalAmount; }
    public void setTotalAmount(BigDecimal v) { this.totalAmount = v; }
    public Instant getPlacedAt() { return placedAt; }
    public void setPlacedAt(Instant v) { this.placedAt = v; }
    public String getCustomerName() { return customerName; }
    public void setCustomerName(String v) { this.customerName = v; }
    public long getItemCount() { return itemCount; }
    public void setItemCount(long v) { this.itemCount = v; }

    @Override public String toString() {
        return "OrderRow{" + orderNo + ", " + status + ", " + totalAmount
                + ", 客戶=" + customerName + ", 明細=" + itemCount + "}";
    }
}
```

**同一個形狀的 `record` 版本**（7.8.5 要用）：

```java
package com.example.lab.ch07;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

/** 同一個形狀，換成 record —— 7.8.5 要看 MyBatis 3.5.14 支不支援它。 */
public record OrderRec(UUID id, String orderNo, St7Status status,
                       BigDecimal totalAmount, Instant placedAt, String customerName) {}
```

**明細與詳情頁的形狀**（7.8.6 要用）：

```java
package com.example.lab.ch07;

import java.math.BigDecimal;

public class ItemRow {
    private String productName;
    private int qty;
    private BigDecimal lineAmount;

    public String getProductName() { return productName; }
    public void setProductName(String v) { this.productName = v; }
    public int getQty() { return qty; }
    public void setQty(int v) { this.qty = v; }
    public BigDecimal getLineAmount() { return lineAmount; }
    public void setLineAmount(BigDecimal v) { this.lineAmount = v; }

    @Override public String toString() { return productName + "×" + qty + "=" + lineAmount; }
}
```

```java
package com.example.lab.ch07;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** 詳情頁那一個形狀：一張訂單 + 它的明細集合。 */
public class OrderDetail {

    private UUID id;
    private String orderNo;
    private St7Status status;
    private BigDecimal totalAmount;
    private Instant placedAt;
    private String customerName;
    private List<ItemRow> items = new ArrayList<>();

    public UUID getId() { return id; }
    public void setId(UUID v) { this.id = v; }
    public String getOrderNo() { return orderNo; }
    public void setOrderNo(String v) { this.orderNo = v; }
    public St7Status getStatus() { return status; }
    public void setStatus(St7Status v) { this.status = v; }
    public BigDecimal getTotalAmount() { return totalAmount; }
    public void setTotalAmount(BigDecimal v) { this.totalAmount = v; }
    public Instant getPlacedAt() { return placedAt; }
    public void setPlacedAt(Instant v) { this.placedAt = v; }
    public String getCustomerName() { return customerName; }
    public void setCustomerName(String v) { this.customerName = v; }
    public List<ItemRow> getItems() { return items; }
    public void setItems(List<ItemRow> v) { this.items = v; }

    @Override public String toString() {
        return "OrderDetail{" + orderNo + ", 客戶=" + customerName + ", 明細=" + items + "}";
    }
}
```

**表結構**：跟 06 章那五張表一樣，多兩張實驗表。

```sql
DROP DATABASE IF EXISTS ch07;
CREATE DATABASE ch07 DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE ch07;

CREATE TABLE customer (
  id            binary(16)   NOT NULL,
  email         varchar(255) NOT NULL,
  display_name  varchar(64)  NOT NULL,
  tier          varchar(16)  NOT NULL DEFAULT 'NORMAL',
  version       bigint       NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uk_customer_email (email)
) ENGINE=InnoDB;

CREATE TABLE product (
  id          binary(16)     NOT NULL,
  sku         varchar(32)    NOT NULL,
  name        varchar(200)   NOT NULL,
  category    varchar(32)    NOT NULL,
  unit_price  decimal(19,4)  NOT NULL,
  version     bigint         NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uk_product_sku (sku)
) ENGINE=InnoDB;

CREATE TABLE stock (
  product_id   binary(16) NOT NULL,
  qty          int NOT NULL DEFAULT 0,
  reserved_qty int NOT NULL DEFAULT 0,
  version      bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id),
  CONSTRAINT fk_stock_product FOREIGN KEY (product_id) REFERENCES product (id)
) ENGINE=InnoDB;

CREATE TABLE orders (
  id            binary(16)     NOT NULL,
  order_no      varchar(32)    NOT NULL,
  customer_id   binary(16)     NOT NULL,
  status        varchar(16)    NOT NULL,
  total_amount  decimal(19,4)  NOT NULL,
  placed_at     datetime(3)    NOT NULL,
  paid_at       datetime(3)    NULL,
  memo          varchar(255)   NULL,
  version       bigint         NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uk_orders_order_no (order_no),
  KEY idx_orders_status_placed (status, placed_at),
  KEY idx_orders_customer (customer_id),
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customer (id)
) ENGINE=InnoDB;

CREATE TABLE order_item (
  id            binary(16)     NOT NULL,
  order_id      binary(16)     NOT NULL,
  product_id    binary(16)     NOT NULL,
  product_name  varchar(200)   NOT NULL,
  unit_price    decimal(19,4)  NOT NULL,
  qty           int            NOT NULL,
  line_amount   decimal(19,4)  NOT NULL,
  PRIMARY KEY (id),
  KEY idx_order_item_order (order_id),
  KEY fk_order_item_product (product_id),
  CONSTRAINT fk_order_item_orders  FOREIGN KEY (order_id)   REFERENCES orders (id),
  CONSTRAINT fk_order_item_product FOREIGN KEY (product_id) REFERENCES product (id)
) ENGINE=InnoDB;

-- ───────── 7.5 TypeHandler 的實驗表：六個欄位，六種型別轉換問題 ─────────
CREATE TABLE evt (
  id          binary(16)   NOT NULL,          -- UUID ↔ BINARY(16)
  kind        varchar(24)  NOT NULL,          -- enum ↔ VARCHAR（存名字）
  kind_ord    tinyint      NOT NULL DEFAULT 0,-- enum ↔ ORDINAL（存序數：定時炸彈）
  payload     json         NULL,              -- JSON ↔ Java record
  amount      decimal(19,4) NOT NULL DEFAULT 0,
  occurred_at datetime(3)  NOT NULL,          -- Instant ↔ datetime(3)
  local_at    datetime(3)  NOT NULL,          -- LocalDateTime ↔ datetime(3)
  PRIMARY KEY (id),
  KEY idx_evt_kind (kind)
) ENGINE=InnoDB;

-- ───────── 7.10 取回主鍵的實驗表 ─────────
CREATE TABLE seq_row (
  id     bigint       NOT NULL AUTO_INCREMENT,
  code   varchar(32)  NOT NULL,
  amount decimal(19,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (id)
) ENGINE=InnoDB;

CREATE TABLE uuid_row (
  id     binary(16)   NOT NULL,
  code   varchar(32)  NOT NULL,
  amount decimal(19,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (id)
) ENGINE=InnoDB;
```

**測試的基底**（這一章共用）：

```java
package com.example.lab.ch07;

import com.example.lab.SqlSpy;
import com.example.lab.Uuid7;
import jakarta.persistence.EntityManager;
import jakarta.persistence.EntityManagerFactory;
import org.apache.ibatis.session.Configuration;
import org.apache.ibatis.session.SqlSessionFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.UUID;

@SpringBootTest(properties = {
  "spring.datasource.url=jdbc:mysql://127.0.0.1:33306/ch07?connectionTimeZone=UTC"
      + "&forceConnectionTimeZoneToSession=true&preserveInstants=true&characterEncoding=UTF-8",
  "spring.jpa.properties.hibernate.generate_statistics=true"
})
public abstract class Base07 {

    @Autowired protected EntityManager em;
    @Autowired protected EntityManagerFactory emf;
    @Autowired protected JdbcTemplate jdbc;
    @Autowired protected TransactionTemplate tx;
    @Autowired protected SqlSessionFactory sqlSessionFactory;

    protected final List<UUID> orderIds = new ArrayList<>();
    protected final List<UUID> customerIds = new ArrayList<>();
    protected final List<UUID> productIds = new ArrayList<>();

    /** ★ 這一章最重要的一個入口：MyBatis 的所有組態都在這個物件裡。 */
    protected Configuration mybatisConfig() { return sqlSessionFactory.getConfiguration(); }

    protected void clean() {
        jdbc.update("DELETE FROM order_item");
        jdbc.update("DELETE FROM orders");
        jdbc.update("DELETE FROM stock");
        jdbc.update("DELETE FROM product");
        jdbc.update("DELETE FROM customer");
        jdbc.update("DELETE FROM evt");
        jdbc.update("DELETE FROM seq_row");
        jdbc.update("DELETE FROM uuid_row");
    }

    /** orderCount 張訂單、customerCount 個客戶、每張 itemsPer 筆明細。 */
    protected void seed(int orderCount, int customerCount, int itemsPer) {
        clean();
        orderIds.clear(); customerIds.clear(); productIds.clear();

        List<Object[]> cRows = new ArrayList<>();
        for (int i = 0; i < customerCount; i++) {
            UUID id = Uuid7.next(); customerIds.add(id);
            cRows.add(new Object[]{Uuid7.toBytes(id), "c" + i + "@x.com", "客戶" + i, "NORMAL"});
        }
        jdbc.batchUpdate("INSERT INTO customer (id,email,display_name,tier) VALUES (?,?,?,?)", cRows);

        String[] cats = {"3C", "書籍", "生鮮"};
        List<Object[]> pRows = new ArrayList<>(), sRows = new ArrayList<>();
        for (int i = 0; i < 6; i++) {
            UUID id = Uuid7.next(); productIds.add(id);
            pRows.add(new Object[]{Uuid7.toBytes(id), "SKU-" + i, "商品" + i,
                    cats[i % 3], new BigDecimal((100 + i * 50) + ".0000")});
            sRows.add(new Object[]{Uuid7.toBytes(id), 100});
        }
        jdbc.batchUpdate("INSERT INTO product (id,sku,name,category,unit_price) VALUES (?,?,?,?,?)", pRows);
        jdbc.batchUpdate("INSERT INTO stock (product_id,qty) VALUES (?,?)", sRows);

        List<Object[]> oRows = new ArrayList<>(), iRows = new ArrayList<>();
        Instant t0 = Instant.parse("2026-09-01T00:00:00Z");
        for (int i = 0; i < orderCount; i++) {
            UUID oid = Uuid7.next(); orderIds.add(oid);
            oRows.add(new Object[]{Uuid7.toBytes(oid), String.format("SO-2026-%06d", i + 1),
                    Uuid7.toBytes(customerIds.get(i % customerCount)),
                    (i % 4 == 3) ? "CANCELLED" : "PENDING",
                    new BigDecimal((100 * itemsPer + i) + ".0000"),
                    java.sql.Timestamp.from(t0.plusSeconds(i * 60L))});
            for (int k = 0; k < itemsPer; k++) {
                UUID pid = productIds.get((i + k) % 6);
                iRows.add(new Object[]{Uuid7.toBytes(Uuid7.next()), Uuid7.toBytes(oid),
                        Uuid7.toBytes(pid), "商品" + ((i + k) % 6),
                        new BigDecimal("100.0000"), 1 + (k % 3), new BigDecimal("100.0000")});
            }
        }
        jdbc.batchUpdate("INSERT INTO orders (id,order_no,customer_id,status,total_amount,placed_at)"
                + " VALUES (?,?,?,?,?,?)", oRows);
        if (!iRows.isEmpty())
            jdbc.batchUpdate("INSERT INTO order_item"
                    + " (id,order_id,product_id,product_name,unit_price,qty,line_amount)"
                    + " VALUES (?,?,?,?,?,?,?)", iRows);
    }

    protected void head(String t) { System.out.println("\n═══ " + t + " ═══"); }

    protected List<String> spy(Runnable body) {
        SqlSpy.start();
        try { body.run(); return SqlSpy.stop(); }
        catch (RuntimeException | Error e) { SqlSpy.stop(); throw e; }
    }

    protected void showSql(String title, Runnable body) {
        List<String> sqls = spy(body);
        System.out.println("── " + title + " → " + sqls.size() + " 句 SQL");
        for (String s : sqls) System.out.println("   " + cut(s));
    }

    protected void grouped(String title, List<String> sqls) {
        LinkedHashMap<String, Integer> m = new LinkedHashMap<>();
        for (String s : sqls) m.merge(s, 1, Integer::sum);
        System.out.println("── " + title + " → 共 " + sqls.size() + " 句，" + m.size() + " 種形狀");
        m.forEach((k, v) -> System.out.println("   ×" + v + "  " + cut(k)));
    }

    /** 只印 SQL 的尾巴（WHERE / ORDER BY 那一段才是重點）。 */
    protected static String tail(String s) {
        String one = s.replaceAll("\\s+", " ");
        int i = one.toUpperCase().lastIndexOf(" FROM ");
        return i < 0 ? one : "… " + one.substring(i + 1);
    }

    protected void showTail(String title, Runnable body) {
        List<String> sqls = spy(body);
        System.out.println("── " + title + " → " + sqls.size() + " 句 SQL");
        for (String s : sqls) System.out.println("   " + tail(s));
    }

    protected static String cut(String s) {
        return s.length() > 150 ? s.substring(0, 150) + "…" : s;
    }

    protected Throwable catching(Runnable body) {
        try { body.run(); return null; }
        catch (Throwable e) { return e; }
    }

    protected Throwable catchingTx(Runnable body) {
        try { tx.executeWithoutResult(s -> body.run()); return null; }
        catch (Throwable e) { return e; }
    }

    protected static String name(Throwable t) {
        if (t == null) return "沒有例外";
        Throwable r = root(t);
        return t.getClass().getSimpleName() + (r != t ? " ← " + r.getClass().getSimpleName() : "");
    }

    protected static Throwable root(Throwable t) {
        while (t.getCause() != null && t.getCause() != t) t = t.getCause();
        return t;
    }

    /** 讀 MySQL 的 general log，看真正進到伺服器的是什麼（06 章 6.2.4）。 */
    protected void withGeneralLog(String title, Runnable body) {
        jdbc.update("SET GLOBAL log_output = 'TABLE'");
        jdbc.update("TRUNCATE TABLE mysql.general_log");
        jdbc.update("SET GLOBAL general_log = 'ON'");
        try { body.run(); } finally { jdbc.update("SET GLOBAL general_log = 'OFF'"); }
        List<String> rows = jdbc.query(
                "SELECT CONVERT(argument USING utf8mb4) FROM mysql.general_log"
                        + " WHERE command_type = 'Query' ORDER BY event_time, thread_id",
                (rs, n) -> rs.getString(1));
        System.out.println("── " + title + " → 伺服器收到 " + rows.size() + " 句");
        for (String r : rows) System.out.println("   " + tail(r));
    }

    protected long bestMs(Runnable r, int warmup, int rounds) {
        for (int i = 0; i < warmup; i++) r.run();
        long best = Long.MAX_VALUE;
        for (int i = 0; i < rounds; i++) {
            long t0 = System.nanoTime();
            r.run();
            best = Math.min(best, System.nanoTime() - t0);
        }
        return best / 1_000_000;
    }
}
```

⚠️ **注意 `@SpringBootTest` 裡【沒有】MyBatis 的組態**——
它們在 `application.yml` 裡（7.3.3），而 MyBatis 的組態**不能靠
`@SpringBootTest(properties = ...)` 逐個測試覆寫**得那麼乾淨：
`mybatis.configuration.*` 這一組是在 `SqlSessionFactory` 建立時一次讀完的，
所以要做「同一段程式碼、兩種設定」的對照，**得開兩個 context**（跟 06 章一樣的手法）。

### 7.4.2 實測：那個「方法 → SQL」的註冊表

```java
    @Test
    void b_MappedStatement_註冊表() {
        head("7.4.2 那個「方法 → SQL」的註冊表長什麼樣");
        var cfg = mybatisConfig();
        List<String> names = cfg.getMappedStatementNames().stream()
                .filter(n -> n.startsWith("com.example.lab.ch07"))
                .sorted().toList();
        System.out.println("   ch07 一共註冊了 " + names.size() + " 個 MappedStatement，前 8 個：");
        names.stream().limit(8).forEach(n -> System.out.println("      " + n));

        var ms = cfg.getMappedStatement("com.example.lab.ch07.Ord7Mapper.findByStatus");
        System.out.println("   ── 拿一個出來看 ──");
        System.out.println("   id            = " + ms.getId());
        System.out.println("   SQL 指令型別   = " + ms.getSqlCommandType());
        System.out.println("   來源           = " + ms.getResource());
        System.out.println("   resultMap 數量 = " + ms.getResultMaps().size()
                + "，型別 = " + ms.getResultMaps().get(0).getType().getSimpleName());
        System.out.println("   statementType = " + ms.getStatementType());
        System.out.println("   ── XML 那一側 ──");
        var ms2 = cfg.getMappedStatement("com.example.lab.ch07.Ord7XmlMapper.listByStatus");
        System.out.println("   來源           = " + ms2.getResource());
    }
```

**實測**：

```
   ch07 一共註冊了 47 個 MappedStatement，前 8 個：
      com.example.lab.ch07.EvtMapper.count
      com.example.lab.ch07.EvtMapper.countById
      com.example.lab.ch07.EvtMapper.countByIdNoHandler
      com.example.lab.ch07.EvtMapper.deleteAll
      com.example.lab.ch07.EvtMapper.findById
      com.example.lab.ch07.EvtMapper.insert
      com.example.lab.ch07.EvtMapper.kindOrdOf
      com.example.lab.ch07.EvtMapper.rawKind
   ── 拿一個出來看 ──
   id            = com.example.lab.ch07.Ord7Mapper.findByStatus
   SQL 指令型別   = SELECT
   來源           = com/example/lab/ch07/Ord7Mapper.java (best guess)
   resultMap 數量 = 1，型別 = OrderRow
   statementType = PREPARED
   ── XML 那一側 ──
   來源           = file [/…/target/classes/mapper/Ord7XmlMapper.xml]
```

> 📌 **`id` 就是「完整類別名 + 方法名」那個字串。**
> **這是整個 MyBatis 最重要的一個設計決定**：
>
> ```
> XML 的 <mapper namespace="com.example.lab.ch07.Ord7XmlMapper">
>   +  <select id="listByStatus">
>   ────────────────────────────────────────────────────
>   =  com.example.lab.ch07.Ord7XmlMapper.listByStatus
>      ↑ 這個字串必須跟【介面的方法】對得起來，靠的是【字串比對】
> ```
>
> **而字串比對沒有編譯期檢查。** 這就是 7.4.5 那個坑的來源。

📌 **`getResource()` 那個 `(best guess)` 值得注意**：
註解版的 statement，MyBatis **不知道它在哪一行** —— 它只能猜是那個 `.java` 檔。
**XML 版有完整路徑。** 排查「這句 SQL 到底寫在哪」的時候，這個差別很有感。

### 7.4.3 實測：`BoundSql` —— `#{}` 變成什麼

```java
    @Test
    void c_BoundSql_把_SQL_跟參數分開() {
        head("7.4.3 BoundSql：#{} 變成什麼");
        var ms = mybatisConfig().getMappedStatement("com.example.lab.ch07.Ord7Mapper.findByStatus");
        var bound = ms.getBoundSql(java.util.Map.of("status", St7Status.PENDING));
        System.out.println("   送出去的 SQL：");
        System.out.println("      " + bound.getSql().replaceAll("\\s+", " "));
        System.out.println("   參數對應：");
        bound.getParameterMappings().forEach(pm -> System.out.printf(
                "      #{%s} → javaType=%s  typeHandler=%s%n",
                pm.getProperty(),
                pm.getJavaType() == null ? "?" : pm.getJavaType().getSimpleName(),
                pm.getTypeHandler() == null ? "?" : pm.getTypeHandler().getClass().getSimpleName()));
    }
```

**實測**：

```
   送出去的 SQL：
      SELECT o.id, o.order_no, o.status, o.total_amount, o.placed_at,
             c.display_name AS customer_name,
             (SELECT count(*) FROM order_item i WHERE i.order_id = o.id) AS item_count
        FROM orders o JOIN customer c ON c.id = o.customer_id
       WHERE o.status = ? ORDER BY o.placed_at
   參數對應：
      #{status} → javaType=St7Status  typeHandler=EnumTypeHandler
```

**`BoundSql` 是 MyBatis 世界觀的核心物件**，它把一句 SQL 拆成兩半：

```
sql                 →  "… WHERE o.status = ? …"      ← 給 PreparedStatement 的字串
parameterMappings   →  [#{status} → EnumTypeHandler]   ← 「第 1 個 ? 要用哪個 handler 填」
```

> 📌 **這兩半各自對應這一章的一節**：
> **`sql` 那一半是 7.6（`#{}` / `${}`）；`parameterMappings` 那一半是 7.5（`TypeHandler`）。**
>
> ⚠️ 而 08 章的動態 SQL（`<if>` / `<foreach>`）改的是**第一半** ——
> `<foreach>` 會讓 `sql` 裡的 `?` 個數隨參數變，`parameterMappings` 也跟著長。
> **這就是 05 章 5.5.3 那個「20 種 SQL 形狀」在 MyBatis 上的樣子。**

### 7.4.4 一句 SQL 的完整路徑

```
你呼叫 mapper.findByStatus(PENDING)
   ↓
MapperProxy.invoke()                    ← JDK 動態代理攔截（7.3.2 ④）
   ↓
MapperMethod.execute()                  ← 看 SqlCommandType 決定走 select / insert / update / delete
   ↓
SqlSessionTemplate.selectList("com.example.lab.ch07.Ord7Mapper.findByStatus", args)
   ↓                                      ★ 那個字串就是 MappedStatement 的 id（7.4.2）
   ├─ 有交易 → 用交易綁定的那個 SqlSession（7.11.3）
   └─ 沒交易 → 開一個新的（7.11.2）
   ↓
Executor（SIMPLE / REUSE / BATCH —— 7.10.4）
   ↓
   ├─ 先問一級快取：這個「id + 參數 + 分頁」查過了嗎？（7.11）
   ↓
Configuration.getMappedStatement(id)    ← 從註冊表拿出你寫的 SQL
   ↓
BoundSql                                ← 動態 SQL（<if>、<foreach>）在這一步展開（7.4.3）
   ↓
StatementHandler → ParameterHandler     ← #{} 用 TypeHandler 綁參數（7.5）
   ↓
java.sql.PreparedStatement.execute()
   ↓
ResultSetHandler                        ← 用 resultMap / resultType 把列變成物件（7.8）
   ↓
List<OrderRow>
```

⚠️ **這條路徑上沒有的東西**（也就是 7.2 那張表的「🔴 沒有」那幾列）：

```
沒有「把結果放進持久化情境」
沒有「建快照」
沒有「註冊到 flush 佇列」
沒有「決定寫入順序」
```

📌 **而路徑上【有】一個很多人不知道的東西：一級快取**（那個「先問」的步驟）。
**7.11 整節在講它**，因為它是這一章唯一一個「MyBatis 也有狀態」的地方。

### 7.4.5 🔴 實測：打錯字什麼時候被發現

00 章 0.5.3 那張表的最後一列，這裡把它跑完整。

**`Ord7XmlMapper` 這一章結束時的完整版本**（7.8 之後的每一節都往這個介面加一個方法，
而它們的 `<select>` 都在同一份 `Ord7XmlMapper.xml` 裡）：

```java
package com.example.lab.ch07;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.util.List;
import java.util.UUID;

/** XML 版：SQL 寫在 resources/mapper/Ord7XmlMapper.xml。 */
@Mapper
public interface Ord7XmlMapper {

    /** 7.8.3：resultMap 逐欄指定。 */
    List<OrderRow> listByStatus(@Param("status") St7Status status);

    /** 7.8.4：建構子映射（不需要 setter）。 */
    List<OrderRec> listRecByStatus(@Param("status") St7Status status);

    /** 7.8.6：巢狀 resultMap —— 一句 JOIN，把明細組回集合。 */
    List<OrderDetail> detailByStatus(@Param("status") St7Status status);

    /** 🔴 7.8.7：巢狀 select —— 這就是 MyBatis 這一側的 N+1，而它是你自己寫的。 */
    List<OrderDetail> detailNPlus1(@Param("status") St7Status status);

    /** 🔴 7.8.8：同一個 resultMap，只是 SQL 沒有按訂單排序。 */
    List<OrderDetail> detailUnordered(@Param("status") St7Status status);

    /** 🔴 7.8.8b：同一句沒排序的 SQL，加上 resultOrdered="true"。 */
    List<OrderDetail> detailUnorderedOrderedFlag(@Param("status") St7Status status);

    /** ✅ 7.8.8b：resultOrdered="true" + 正確的排序。 */
    List<OrderDetail> detailOrderedFlagSorted(@Param("status") St7Status status);

    List<ItemRow> itemsOf(@Param("orderId") UUID orderId);

    /** ⚠️ 7.4.5：這個方法在 XML 裡【沒有】對應的 statement。 */
    List<OrderRow> methodWithNoStatement(@Param("status") String status);
}
```

⚠️ **注意最後一個方法** —— 它是這一節的主角：**介面上有、XML 裡沒有**。

```java
    @Test
    void d_XML_裡沒有的方法() {
        head("7.4.5 介面上有、XML 裡沒有的方法");
        System.out.println("   ═══ 應用【啟動成功】了嗎？ → 是（你正在看這行）═══");
        Throwable err = catching(() -> xmlMapper.methodWithNoStatement("PENDING"));
        System.out.println("   🔴 呼叫的時候才炸：" + name(err));
        System.out.println("      " + root(err).getMessage());
        System.out.println("   ── 對照：SQL 內容本身寫錯，要更晚才知道 ──");
        Throwable err2 = catching(() -> jdbc.queryForList("SELECT * FROM orders WHERE statuz = 'X'"));
        System.out.println("   → " + name(err2) + " │ " + cut(root(err2).getMessage()));
    }
```

**實測**：

```
   ═══ 應用【啟動成功】了嗎？ → 是（你正在看這行）═══
   🔴 呼叫的時候才炸：BindingException
      Invalid bound statement (not found): com.example.lab.ch07.Ord7XmlMapper.methodWithNoStatement
   ── 對照：SQL 內容本身寫錯，要更晚才知道 ──
   → BadSqlGrammarException ← SQLSyntaxErrorException │ Unknown column 'statuz' in 'where clause'
```

**三個階段，三種錯誤**：

| 錯的東西 | Spring Data JPA | MyBatis |
|---|---|---|
| 方法名 / 屬性名打錯 | ✅ **啟動失敗**，而且告訴你「你是不是要打 `status`」 | 🔴 **呼叫時** `BindingException` |
| SQL / JPQL 語法錯 | ✅ **啟動失敗**（`@Query` 在啟動時被剖析 —— 05 章 5.7.7） | 🔴 **執行時** `BadSqlGrammarException` |
| 欄位名對不上結果型別 | ✅ 啟動失敗（建構子表達式）或編譯失敗（Criteria） | 🔴🔴 **不報錯，那個屬性靜默是 null**（7.8.1） |

> 📌 **這張表就是 00 章 0.8.2 判準 5 的完整版本**：
> **MyBatis 把三種錯誤全部推遲到執行期，其中一種還完全不報。**
>
> **所以「MyBatis 專案要不要寫資料層測試」不是一個問題，是一個前提。**
> **06 站 06 章那組「跑在真 MySQL 上」的測試，在 MyBatis 專案裡是必需品。**
>
> ⚠️ 而 7.14 會給一條斷言，**把「所有 mapper 方法都要能被剖析」變成啟動檢查**——
> 那條斷言可以把上面第一列從「呼叫時」拉回「啟動時」。

---
## 7.5 `TypeHandler`（收掉 00 章 0.5.4）

00 章 0.5.4 留下一句話：

> 「同一類問題還會出現在 `Instant` / `LocalDateTime`、`enum`、`JSON` 欄位、
> 加密欄位、`Money` 這種值物件。**07 章 7.5 會把 `TypeHandler` 完整處理一次。**」

**這一節用一張表、六個欄位，把六種型別轉換問題一次跑完。**

```sql
CREATE TABLE evt (
  id          binary(16)   NOT NULL,          -- UUID ↔ BINARY(16)
  kind        varchar(24)  NOT NULL,          -- enum ↔ VARCHAR（存名字）
  kind_ord    tinyint      NOT NULL DEFAULT 0,-- enum ↔ ORDINAL（存序數：定時炸彈）
  payload     json         NULL,              -- JSON ↔ Java record
  amount      decimal(19,4) NOT NULL DEFAULT 0,
  occurred_at datetime(3)  NOT NULL,          -- Instant ↔ datetime(3)
  local_at    datetime(3)  NOT NULL,          -- LocalDateTime ↔ datetime(3)
  PRIMARY KEY (id),
  KEY idx_evt_kind (kind)
) ENGINE=InnoDB;
```

```java
package com.example.lab.ch07;

/** 7.5.3 的主角：列舉的兩種映射（名字 vs 序數）。 */
public enum EvtKind { CREATED, PAID, SHIPPED, CANCELLED }
```

```java
package com.example.lab.ch07;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDateTime;
import java.util.UUID;

/** 7.5 的實驗載體：六個欄位，六種型別轉換問題。 */
public class Evt {

    private UUID id;
    private EvtKind kind;
    private EvtKind kindOrd;
    private Payload payload;
    private BigDecimal amount;
    private Instant occurredAt;
    private LocalDateTime localAt;

    /** 存進 json 欄位的東西。 */
    public record Payload(String actor, int retries, java.util.List<String> tags) {}

    public UUID getId() { return id; }
    public void setId(UUID v) { this.id = v; }
    public EvtKind getKind() { return kind; }
    public void setKind(EvtKind v) { this.kind = v; }
    public EvtKind getKindOrd() { return kindOrd; }
    public void setKindOrd(EvtKind v) { this.kindOrd = v; }
    public Payload getPayload() { return payload; }
    public void setPayload(Payload v) { this.payload = v; }
    public BigDecimal getAmount() { return amount; }
    public void setAmount(BigDecimal v) { this.amount = v; }
    public Instant getOccurredAt() { return occurredAt; }
    public void setOccurredAt(Instant v) { this.occurredAt = v; }
    public LocalDateTime getLocalAt() { return localAt; }
    public void setLocalAt(LocalDateTime v) { this.localAt = v; }

    @Override public String toString() {
        return "Evt{kind=" + kind + ", kindOrd=" + kindOrd + ", payload=" + payload
                + ", amount=" + amount + ", occurredAt=" + occurredAt + ", localAt=" + localAt + "}";
    }
}
```

```java
package com.example.lab.ch07;

import org.apache.ibatis.annotations.*;

import java.util.List;
import java.util.UUID;

/** 7.5 TypeHandler 的實驗。 */
@Mapper
public interface EvtMapper {

    /** ✅ 全部靠已註冊的 TypeHandler（UUID / Instant / enum 名稱 / JSON）。 */
    @Insert("""
            INSERT INTO evt (id, kind, kind_ord, payload, amount, occurred_at, local_at)
            VALUES (#{id}, #{kind},
                    #{kindOrd, typeHandler=org.apache.ibatis.type.EnumOrdinalTypeHandler},
                    #{payload, typeHandler=com.example.lab.ch07.JsonTypeHandler},
                    #{amount}, #{occurredAt}, #{localAt})
            """)
    int insert(Evt e);

    @Select("""
            SELECT id, kind, kind_ord AS kindOrd, payload, amount, occurred_at AS occurredAt,
                   local_at AS localAt
              FROM evt WHERE id = #{id}
            """)
    @Results({
        @Result(property = "kindOrd", column = "kindOrd",
                typeHandler = org.apache.ibatis.type.EnumOrdinalTypeHandler.class),
        @Result(property = "payload", column = "payload",
                typeHandler = JsonTypeHandler.class)
    })
    Evt findById(@Param("id") UUID id);

    /** 🔴 沒有 TypeHandler 的查詢：UUID 被當成字串送出去。 */
    @Select("SELECT count(*) FROM evt "
          + "WHERE id = #{id, typeHandler=org.apache.ibatis.type.ObjectTypeHandler}")
    long countByIdNoHandler(@Param("id") UUID id);

    @Select("SELECT count(*) FROM evt WHERE id = #{id}")
    long countById(@Param("id") UUID id);

    /** 7.5.3：讀出資料庫裡真正的值，用來看列舉存成什麼。 */
    @Select("SELECT kind FROM evt WHERE id = #{id}")
    String rawKind(@Param("id") UUID id);

    @Select("SELECT kind_ord FROM evt WHERE id = #{id}")
    int rawKindOrd(@Param("id") UUID id);

    @Select("SELECT payload FROM evt WHERE id = #{id}")
    String rawPayload(@Param("id") UUID id);

    @Select("SELECT DATE_FORMAT(occurred_at, '%Y-%m-%d %H:%i:%s.%f') FROM evt WHERE id = #{id}")
    String rawOccurredAt(@Param("id") UUID id);

    @Select("SELECT DATE_FORMAT(local_at, '%Y-%m-%d %H:%i:%s.%f') FROM evt WHERE id = #{id}")
    String rawLocalAt(@Param("id") UUID id);

    @Delete("DELETE FROM evt")
    int deleteAll();

    @Select("SELECT count(*) FROM evt")
    long count();
}
```

⚠️ **注意 `#{id, typeHandler=…ObjectTypeHandler}` 這個寫法**。
要示範「沒有 handler 的樣子」**不能只是「不註冊」**——
`type-handlers-package` 一掃到，全域就生效了。
**所以要【明寫】一個什麼都不做的 handler 才量得到那個壞掉的版本。**
（用 `UnknownTypeHandler` 沒有用：它會去註冊表找，然後找到我們註冊的那個。）

### 7.5.1 🔴 實測：誰知道 `UUID` 該怎麼變成 `BINARY(16)`

```java
    @Test
    void a_誰知道_UUID_怎麼變成_binary() {
        head("7.5.1 收掉 00 章 0.5.4：誰知道 UUID 該怎麼變成 BINARY(16)");
        UUID id = seedEvt();
        System.out.println("   資料庫裡有 " + evts.count() + " 筆");
        System.out.println("   ✅ 有 TypeHandler：countById   = " + evts.countById(id));
        System.out.println("   🔴 沒 TypeHandler：countByIdNoHandler = " + evts.countByIdNoHandler(id));
        System.out.println("      —— 不報錯，只是【什麼都找不到】");

        seed(2, 1, 0);
        UUID oid = orderIds.get(0);
        System.out.println("   ── 換成 UPDATE ──");
        System.out.println("   ✅ 有 handler：markPaid 影響 "
                + orders.markPaid(oid, St7Status.PAID, Instant.now()) + " 列");
        System.out.println("   🔴 沒 handler：markPaidNoHandler 影響 "
                + orders.markPaidNoHandler(oid, "PACKED") + " 列");
        System.out.println("   🔴🔴 回傳 void 的版本：");
        orders.setMemoNoHandlerVoid(oid, "改到了嗎");
        System.out.println("      連「0 列」都看不到。DB 裡的 memo = "
                + jdbc.queryForObject("SELECT memo FROM orders WHERE id = ?", String.class,
                        (Object) Uuid7.toBytes(oid)));
    }

    private UUID seedEvt() {
        clean();
        UUID id = Uuid7.next();
        Evt e = new Evt();
        e.setId(id);
        e.setKind(EvtKind.SHIPPED);
        e.setKindOrd(EvtKind.SHIPPED);
        e.setPayload(new Evt.Payload("gary", 3, List.of("urgent", "vip")));
        e.setAmount(new BigDecimal("1234.5600"));
        e.setOccurredAt(Instant.parse("2026-09-08T02:30:00Z"));
        e.setLocalAt(LocalDateTime.parse("2026-09-08T10:30:00"));
        evts.insert(e);
        return id;
    }
```

**實測**：

```
   資料庫裡有 1 筆
   ✅ 有 TypeHandler：countById   = 1
   🔴 沒 TypeHandler：countByIdNoHandler = 0
      —— 不報錯，只是【什麼都找不到】
   ── 換成 UPDATE ──
   ✅ 有 handler：markPaid 影響 1 列
   🔴 沒 handler：markPaidNoHandler 影響 0 列
   🔴🔴 回傳 void 的版本：
      連「0 列」都看不到。DB 裡的 memo = null
```

**三個層次的「安靜」**：

```
① 查詢：count 回 0            → 你可能會以為「就是沒有資料」
② 更新：影響 0 列              → 只有在你【檢查回傳值】的時候才看得到
③ 回傳 void 的更新：什麼都沒有  → 🔴🔴 完全不可能發現
```

> 📌 **③ 是這一節最重要的一格，而它是一個【方法簽章】的決定。**
>
> ```java
> void markPaid(UUID id, …);      // 🔴 放棄了唯一的錯誤訊號
> int  markPaid(UUID id, …);      // ✅ 你至少【可以】檢查
> ```
>
> **規則：MyBatis 的 `update` / `delete` / `insert`，回傳型別一律寫 `int`。**
> 而 7.14 會給一條斷言把這件事變成建置檢查。

**`TypeHandler` 長什麼樣**：

```java
package com.example.lab.ch07;

import com.example.lab.Uuid7;
import org.apache.ibatis.type.BaseTypeHandler;
import org.apache.ibatis.type.JdbcType;
import org.apache.ibatis.type.MappedTypes;

import java.sql.CallableStatement;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.UUID;

/**
 * ★ JPA 知道 UUID 該怎麼存進 BINARY(16)；MyBatis 不知道（00 章 0.5.4）。
 *   沒有這個 TypeHandler，`WHERE id = #{id}` 會送出一個【字串】，
 *   跟 BINARY(16) 比對不上 —— 不會報錯，只會【影響 0 列】。
 */
@MappedTypes(UUID.class)
public class UuidTypeHandler extends BaseTypeHandler<UUID> {

    /** 寫出去：Java → JDBC。 */
    @Override
    public void setNonNullParameter(PreparedStatement ps, int i, UUID p, JdbcType t) throws SQLException {
        ps.setBytes(i, Uuid7.toBytes(p));
    }

    /** 讀回來：JDBC → Java。三個多載都要寫（按欄位名、按索引、預存程序）。 */
    @Override public UUID getNullableResult(ResultSet rs, String name) throws SQLException {
        return bytes(rs.getBytes(name));
    }
    @Override public UUID getNullableResult(ResultSet rs, int idx) throws SQLException {
        return bytes(rs.getBytes(idx));
    }
    @Override public UUID getNullableResult(CallableStatement cs, int idx) throws SQLException {
        return bytes(cs.getBytes(idx));
    }

    private static UUID bytes(byte[] b) { return b == null ? null : Uuid7.fromBytes(b); }
}
```

```yaml
mybatis:
  type-handlers-package: com.example.lab.ch07     # ★ 註冊它
```

📌 **`BaseTypeHandler` 已經處理了 null**（`setParameter` 遇到 null 會 `setNull`），
所以你只要寫 `setNonNullParameter` 與三個 `getNullableResult`。
**四個方法，一個都不能少** —— 少了「按索引讀」那一個，
在**建構子映射**（7.8.4）與 `resultType` 的自動映射上會踩到。

### 7.5.2 實測：註冊表裡有什麼

```java
    @Test
    void b_註冊表裡有什麼() {
        head("7.5.2 TypeHandler 的註冊表");
        var reg = mybatisConfig().getTypeHandlerRegistry();
        System.out.println("   我們自己註冊的：");
        for (Class<?> t : List.of(UUID.class, Instant.class, Evt.Payload.class)) {
            var h = reg.getTypeHandler(t);
            System.out.printf("      %-24s → %s%n", t.getSimpleName(),
                    h == null ? "（沒有）" : h.getClass().getSimpleName());
        }
        System.out.println("   MyBatis 內建的（抽幾個看）：");
        for (Class<?> t : List.of(String.class, BigDecimal.class, LocalDateTime.class,
                                  java.time.LocalDate.class, byte[].class, Object.class)) {
            var h = reg.getTypeHandler(t);
            System.out.printf("      %-24s → %s%n", t.getSimpleName(),
                    h == null ? "（沒有）" : h.getClass().getSimpleName());
        }
        System.out.println("   列舉的預設 handler → "
                + reg.getTypeHandler(EvtKind.class).getClass().getName());
    }
```

**實測**：

```
   我們自己註冊的：
      UUID                     → UuidTypeHandler
      Instant                  → InstantTypeHandler
      Payload                  → JsonTypeHandler
   MyBatis 內建的（抽幾個看）：
      String                   → StringTypeHandler
      BigDecimal               → BigDecimalTypeHandler
      LocalDateTime            → LocalDateTypeHandler
      LocalDate                → LocalDateTypeHandler
      byte[]                   → ByteArrayTypeHandler
      Object                   → UnknownTypeHandler
   列舉的預設 handler → org.apache.ibatis.type.EnumTypeHandler
```

**三件事**：

```
① 內建的 handler 很齊：String / 數字 / BigDecimal / byte[] / java.time 全部有。
   ★ 所以【大部分專案根本不需要寫 TypeHandler】——會需要的是那些
     「Java 型別與欄位型別不是一對一」的欄位：UUID↔binary、JSON↔物件、
     值物件（Money）↔decimal、加密欄位。

② Object → UnknownTypeHandler。
   ★ 這是那個「一切都看起來正常」的來源：MyBatis 對它不認識的型別
     不會抱怨，它會 setObject() 交給驅動決定（然後就是 7.5.1 那個 0 列）。

③ 列舉的預設是 EnumTypeHandler —— 存【名字】。這是好的預設值，下一節說為什麼。
```

### 7.5.3 🔴 實測：列舉的兩種存法

01 章 1.7.2 那個「`@Enumerated(ORDINAL)` 的定時炸彈」，在 MyBatis 上有一模一樣的版本。

```java
    @Test
    void c_列舉的兩種存法() {
        head("7.5.3 🔴 列舉：名字 vs 序數（01 章 1.7.2 那個定時炸彈的 MyBatis 版）");
        UUID id = seedEvt();
        System.out.println("   Java 那一側存的都是 EvtKind.SHIPPED");
        System.out.println("   資料庫裡 kind     = '" + evts.rawKind(id) + "'   ← EnumTypeHandler（名字）");
        System.out.println("   資料庫裡 kind_ord = " + evts.rawKindOrd(id)
                + "     ← EnumOrdinalTypeHandler（序數）");
        System.out.println("   讀回來：" + evts.findById(id).getKind()
                + " / " + evts.findById(id).getKindOrd());
        System.out.println("   ── 現在有人在列舉中間插一個常數 ──");
        System.out.println("   enum EvtKind { CREATED, PAID, 【REVIEWED】, SHIPPED, CANCELLED }");
        System.out.println("   那筆資料的 kind_ord 還是 " + evts.rawKindOrd(id)
                + "，而序數 " + evts.rawKindOrd(id) + " 現在指的是【REVIEWED】");
        System.out.println("   🔴 SHIPPED 的事件，讀出來會變成 REVIEWED。");
        System.out.println("   而 kind = '" + evts.rawKind(id) + "' 那一欄完全不受影響。");
    }
```

**實測**：

```
   Java 那一側存的都是 EvtKind.SHIPPED
   資料庫裡 kind     = 'SHIPPED'   ← EnumTypeHandler（名字）
   資料庫裡 kind_ord = 2     ← EnumOrdinalTypeHandler（序數）
   讀回來：SHIPPED / SHIPPED
   ── 現在有人在列舉中間插一個常數 ──
   enum EvtKind { CREATED, PAID, 【REVIEWED】, SHIPPED, CANCELLED }
   那筆資料的 kind_ord 還是 2，而序數 2 現在指的是【REVIEWED】
   🔴 SHIPPED 的事件，讀出來會變成 REVIEWED。
   而 kind = 'SHIPPED' 那一欄完全不受影響。
```

> 📌 **MyBatis 與 JPA 在這件事上的立場【不一樣，而且 MyBatis 比較好】**：
>
> | | 預設 | 要序數怎麼寫 |
> |---|---|---|
> | **JPA** | 🔴 **`ORDINAL`** | 預設就是（所以要記得寫 `@Enumerated(STRING)`） |
> | **MyBatis** | ✅ **名字**（`EnumTypeHandler`） | 要明寫 `EnumOrdinalTypeHandler` |
>
> **JPA 的預設值是那個危險的選項，MyBatis 的預設值是安全的那個。**
> 這是 01 章 1.7.2 那個坑在 MyBatis 上「不容易踩到」的原因 ——
> **不是因為它比較聰明，是因為它的預設值剛好對。**

⚠️ **而 MyBatis 有一個 JPA 沒有的問題**：
`@Enumerated` 是**標在實體的欄位上**（一個地方寫一次），
而 MyBatis 的 `typeHandler=` 是**標在每一句 SQL 的每一個 `#{}` / `@Result` 上**。
**同一個列舉在十句 SQL 裡可能有十種寫法，而且沒有東西會檢查它們一致。**

**修法：把它註冊成該型別的全域 handler**，就不用逐句寫：

```java
// 如果整個系統的 EvtKind 都要存序數（通常不該，但假設有這個需求）
@MappedTypes(EvtKind.class)
public class EvtKindOrdinalHandler
        extends org.apache.ibatis.type.EnumOrdinalTypeHandler<EvtKind> {
    public EvtKindOrdinalHandler() { super(EvtKind.class); }
}
```

📌 **規則：列舉一律存名字，而且欄位型別用 `VARCHAR`。**
理由跟 01 章 1.7.3 一字不差：**序數的意義由 Java 原始碼的行序決定，
而那是一個沒有人會去保護的東西。**

### 7.5.4 實測：`Instant` 與 `LocalDateTime`

```java
    @Test
    void d_時間型別() {
        head("7.5.4 Instant 與 LocalDateTime：同一個時刻，兩種欄位");
        UUID id = seedEvt();
        System.out.println("   JVM 時區          = " + java.util.TimeZone.getDefault().getID());
        System.out.println("   Java: occurredAt  = " + Instant.parse("2026-09-08T02:30:00Z")
                + "（Instant，UTC 的 02:30）");
        System.out.println("   Java: localAt     = " + LocalDateTime.parse("2026-09-08T10:30:00")
                + "（LocalDateTime，沒有時區）");
        System.out.println("   DB:   occurred_at = " + evts.rawOccurredAt(id));
        System.out.println("   DB:   local_at    = " + evts.rawLocalAt(id));
        Evt back = evts.findById(id);
        System.out.println("   讀回來 occurredAt = " + back.getOccurredAt());
        System.out.println("   讀回來 localAt    = " + back.getLocalAt());
        System.out.println("   連線的 connectionTimeZone = UTC，session 時區 = "
                + jdbc.queryForObject("SELECT @@session.time_zone", String.class));
    }
```

**實測**：

```
   JVM 時區          = Asia/Taipei
   Java: occurredAt  = 2026-09-08T02:30:00Z（Instant，UTC 的 02:30）
   Java: localAt     = 2026-09-08T10:30（LocalDateTime，沒有時區）
   DB:   occurred_at = 2026-09-08 02:30:00.000000
   DB:   local_at    = 2026-09-08 10:30:00.000000
   讀回來 occurredAt = 2026-09-08T02:30:00Z
   讀回來 localAt    = 2026-09-08T10:30
   連線的 connectionTimeZone = UTC，session 時區 = +00:00
```

**兩個欄位存的是【同一個時刻】（台北 10:30 = UTC 02:30），而資料庫裡的值差 8 小時。**

```
Instant       → 「絕對時刻」→ 存成 UTC 的牆上時間  → 02:30
LocalDateTime → 「牆上時間」→ 原封不動存進去      → 10:30
```

> 📌 **這正是 01 章 1.9.2 那個結論**，只是這一次負責換算的不是 Hibernate，是 `TypeHandler`：

```java
package com.example.lab.ch07;

import org.apache.ibatis.type.BaseTypeHandler;
import org.apache.ibatis.type.JdbcType;
import org.apache.ibatis.type.MappedTypes;

import java.sql.CallableStatement;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;

/**
 * 7.5.4：Instant ↔ datetime(3)。
 *
 * ⚠️ MyBatis 內建的 InstantTypeHandler 走 ps.setObject(i, instant)，
 *    交給驅動決定 —— 而驅動的決定跟 connectionTimeZone 有關（01 章 1.9.2）。
 *    這一份【明確】用 UTC 換算，讓行為跟 JVM 時區、跟連線參數都無關。
 */
@MappedTypes(Instant.class)
public class InstantTypeHandler extends BaseTypeHandler<Instant> {

    private static final java.util.TimeZone UTC = java.util.TimeZone.getTimeZone("UTC");

    @Override
    public void setNonNullParameter(PreparedStatement ps, int i, Instant p, JdbcType t)
            throws SQLException {
        ps.setTimestamp(i, java.sql.Timestamp.from(p), java.util.Calendar.getInstance(UTC));
    }

    @Override public Instant getNullableResult(ResultSet rs, String name) throws SQLException {
        return ts(rs.getTimestamp(name, java.util.Calendar.getInstance(UTC)));
    }
    @Override public Instant getNullableResult(ResultSet rs, int idx) throws SQLException {
        return ts(rs.getTimestamp(idx, java.util.Calendar.getInstance(UTC)));
    }
    @Override public Instant getNullableResult(CallableStatement cs, int idx) throws SQLException {
        return ts(cs.getTimestamp(idx, java.util.Calendar.getInstance(UTC)));
    }

    private static Instant ts(java.sql.Timestamp t) { return t == null ? null : t.toInstant(); }
}
```

⚠️ **要不要寫自己的 `InstantTypeHandler`**：
MyBatis 內建的那個在「連線有設 `connectionTimeZone=UTC`」的環境下**行為是對的**。
**寫自己的理由是：讓正確性不依賴一個 JDBC URL 上的參數。**
01 章 1.9.3 那個「換一台機器差 8 小時」的事故，就是因為
**那個參數在某個環境的組態檔裡漏掉了。**

📌 **`amount` 那一欄不需要 handler**（`BigDecimalTypeHandler` 是內建的），
**而 01 章 1.10.1 那個「靜默四捨五入」的問題在 MyBatis 上還在**——
它取決於 `DECIMAL(19,4)` 這個欄位定義，跟哪個框架完全無關。

### 7.5.5 實測：JSON 欄位

```java
package com.example.lab.ch07;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.ibatis.type.BaseTypeHandler;
import org.apache.ibatis.type.JdbcType;
import org.apache.ibatis.type.MappedJdbcTypes;
import org.apache.ibatis.type.MappedTypes;

import java.sql.CallableStatement;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;

/**
 * 7.5.5：JSON 欄位 ↔ Java record。
 *
 * ★ 這個 handler 在 SQL 裡要【逐欄指定】（typeHandler=…），因為
 *   Evt.Payload 這種型別只出現在一個欄位上，全域註冊反而讓意圖不明顯。
 */
@MappedTypes(Evt.Payload.class)
@MappedJdbcTypes(JdbcType.VARCHAR)
public class JsonTypeHandler extends BaseTypeHandler<Evt.Payload> {

    private static final ObjectMapper M = new ObjectMapper();

    @Override
    public void setNonNullParameter(PreparedStatement ps, int i, Evt.Payload p, JdbcType t)
            throws SQLException {
        try { ps.setString(i, M.writeValueAsString(p)); }
        catch (Exception e) { throw new SQLException("payload 轉 JSON 失敗", e); }
    }

    @Override public Evt.Payload getNullableResult(ResultSet rs, String name) throws SQLException {
        return read(rs.getString(name));
    }
    @Override public Evt.Payload getNullableResult(ResultSet rs, int idx) throws SQLException {
        return read(rs.getString(idx));
    }
    @Override public Evt.Payload getNullableResult(CallableStatement cs, int idx) throws SQLException {
        return read(cs.getString(idx));
    }

    private static Evt.Payload read(String s) throws SQLException {
        if (s == null) return null;
        try { return M.readValue(s, Evt.Payload.class); }
        catch (Exception e) { throw new SQLException("JSON 轉 payload 失敗：" + s, e); }
    }
}
```

**實測**：

```
   Java 那一側：Payload[actor=gary, retries=3, tags=[urgent, vip]]
   資料庫裡：  {"tags": ["urgent", "vip"], "actor": "gary", "retries": 3}
   讀回來：    Payload[actor=gary, retries=3, tags=[urgent, vip]]
   ── 而 MySQL 那一側也能查它 ──
   payload->>'$.actor'   = gary
   JSON_LENGTH(tags)     = 2
```

> 📌 **最後兩行是 MyBatis 這個世界觀真正的優勢，而且它跟 JSON 沒什麼關係**：
>
> **`payload->>'$.actor'` 這種 MySQL 專屬語法，你可以直接寫。**
> JPA 那一側要嘛用原生查詢（05 章 5.11）、要嘛用 Hibernate 的
> `@JdbcTypeCode(SqlTypes.JSON)` 加一堆函式註冊 ——
> **而那正是 00 章 0.6.6「換資料庫的成本」那條軸的另一面**：
> **不能換方言，換到的是「這個資料庫的全部能力」。**

⚠️ **注意 MySQL 把 JSON 的 key 順序重排了**（`tags` 跑到最前面）。
MySQL 的 `JSON` 型別**不保留 key 的順序**（它存的是一個排序過的二元結構）。
**所以「把 JSON 欄位當字串比對」永遠是錯的** ——
要比較就用 `JSON_CONTAINS` / `->>`，或者在 Java 那一側比較物件。

### 7.5.6 三個框架的立場（並修正 00 章 0.5.4 的一格）

```java
    @Test
    void f_三個框架的立場() {
        head("7.5.6 同一件事，三個框架的立場");
        UUID id = Uuid7.next();
        clean();
        jdbc.update("INSERT INTO uuid_row (id, code) VALUES (?, ?)", Uuid7.toBytes(id), "A");
        System.out.println("   ① JdbcTemplate：自己寫 Uuid7.toBytes(id) → "
                + jdbc.queryForObject("SELECT count(*) FROM uuid_row WHERE id = ?", Long.class,
                        (Object) Uuid7.toBytes(id)) + " 筆");
        Throwable err = catching(() -> jdbc.queryForObject(
                "SELECT count(*) FROM uuid_row WHERE id = ?", Long.class, id));
        System.out.println("      忘了轉 → " + (err == null
                ? "沒有例外（回 " + jdbc.queryForObject(
                        "SELECT count(*) FROM uuid_row WHERE id = ?", Long.class, id) + " 筆）"
                : name(err)));
        System.out.println("   ② MyBatis：寫一次 TypeHandler，全域生效；忘了 → 🔴 影響 0 列（7.5.1）");
        System.out.println("   ③ JPA：框架內建 UUID ↔ binary(16)，不會發生");
    }
```

**實測**：

```
   ① JdbcTemplate：自己寫 Uuid7.toBytes(id) → 1 筆
      忘了轉 → 沒有例外（回 0 筆）
   ② MyBatis：寫一次 TypeHandler，全域生效；忘了 → 🔴 影響 0 列（7.5.1）
   ③ JPA：框架內建 UUID ↔ binary(16)，不會發生
```

> ⚠️ **修正 00 章 0.5.4 那張表的第一列。**
>
> 那裡寫的是：
>
> | | 誰負責轉換 | 忘了會怎樣 |
> |---|---|---|
> | `JdbcTemplate` | 你 | 🟡 **編譯期就錯（型別對不上）** |
>
> **這是錯的。** `JdbcTemplate.queryForObject(sql, Class, Object... args)` 的參數是
> **`Object...`** —— 傳一個 `UUID` 進去**編譯得過**，執行也不報錯，
> 它跟 MyBatis 一樣**回 0 筆**。
>
> **正確的表是**：
>
> | | 誰負責轉換 | 忘了會怎樣 |
> |---|---|---|
> | `JdbcTemplate` | **你，每一次呼叫** | 🔴 **靜默失敗，回 0 筆 / 影響 0 列** |
> | **MyBatis** | **你，寫一次 `TypeHandler` 全域生效** | 🔴 **靜默失敗** |
> | **JPA / Hibernate** | **框架** | ✅ 不會發生 |
>
> **而修正之後，那張表的結論更強了**：
> 三個框架裡有**兩個**會靜默失敗，而 MyBatis 的優勢是
> **「你只要寫對一次」**，而不是「它會提醒你」。
>
> 📌 **這個錯誤的來源值得記下來**：
> 原本那一格是**推論**出來的（「`JdbcTemplate` 的 API 有型別，所以應該會擋」），
> 而不是量出來的。**「應該會擋」與「量過它擋了」是兩件事。**

### 7.5.7 寫 `TypeHandler` 的四條規則

```
① 四個方法都要寫：setNonNullParameter + 三個 getNullableResult。
   少了「按索引讀」的那一個，建構子映射（7.8.4）會壞。

② 註冊方式二選一，不要混：
   - 全域（type-handlers-package + @MappedTypes）→ 適合「這個型別永遠這樣轉」
   - 逐欄（#{x, typeHandler=…} / @Result(typeHandler=…)）→ 適合「同一型別有兩種存法」
   ⚠️ 混用的下場是「同一個列舉在十句 SQL 裡有十種寫法」（7.5.3）

③ 不要在 TypeHandler 裡做業務邏輯。
   它應該是【純函數】：同樣的輸入永遠同樣的輸出，而且不碰資料庫、不看時鐘。
   （加密欄位是唯一常見的例外，而那時候金鑰要從外面注入。）

④ 🔴 一定要為它寫一個【round-trip 測試】：寫進去、讀回來、比對相等。
   理由：TypeHandler 壞掉的方式是【靜默】的（7.5.1），
        而 round-trip 測試是唯一能同時檢查兩個方向的東西。
```

---

## 7.6 `#{}` 與 `${}`（收掉 00 章 0.3.6）

00 章 0.3.6 那個事故留下一句話：

> 「06 站 00 章 0.11.4 已經講過這件事的正解：**對照表，而不是字串檢查**。
> **07 章 7.6 會用 MyBatis 的語法把它完整寫一次。**」

### 7.6.1 實測：正常輸入下兩者相同

```java
    @Select("""
            SELECT o.id, o.order_no, o.status, o.total_amount, o.placed_at,
                   c.display_name AS customer_name,
                   (SELECT count(*) FROM order_item i WHERE i.order_id = o.id) AS item_count
              FROM orders o JOIN customer c ON c.id = o.customer_id
             WHERE o.status = #{status}
             ORDER BY o.placed_at
            """)
    List<OrderRow> findByStatus(@Param("status") St7Status status);

    /** 🔴 7.6：字串拼接版。同一句話，差一個字元。 */
    @Select("""
            SELECT o.id, o.order_no, o.status, o.total_amount, o.placed_at,
                   c.display_name AS customer_name, 0 AS item_count
              FROM orders o JOIN customer c ON c.id = o.customer_id
             WHERE o.status = '${status}'
             ORDER BY o.placed_at
            """)
    List<OrderRow> findByStatusUnsafe(@Param("status") String status);
```

**實測**：

```
   資料庫裡總共 4 張訂單
   #{} 查 PENDING → 3 筆
   ${} 查 PENDING → 3 筆
```

### 7.6.2 🔴 實測：注入

```java
    @Test
    void b_注入() {
        head("7.6.2 🔴 傳入 PENDING' OR '1'='1");
        seed(4, 2, 1);
        String evil = "PENDING' OR '1'='1";

        List<String> a = spy(() -> {
            int n = mapper.findByStatusUnsafe(evil).size();
            System.out.println("   ${} 撈到 " + n + " 筆（資料庫裡總共 4 筆，PENDING 只有 3 筆）");
        });
        a.forEach(q -> System.out.println("      " + tail(q)));

        List<String> b = spy(() -> {
            int n = mapper.findByStatus(St7Status.PENDING).size();
            System.out.println("   #{} 傳合法的 PENDING → " + n + " 筆");
        });
        b.forEach(q -> System.out.println("      " + tail(q)));

        System.out.println("   ── #{} 傳那個字串會怎樣（列舉擋在型別那一層）──");
        Throwable err = catching(() -> mapper.countByStatus(St7Status.valueOf(evil)));
        System.out.println("   → " + name(err) + " │ " + cut(root(err).getMessage()));
    }
```

**實測**：

```
   ${} 撈到 4 筆（資料庫裡總共 4 筆，PENDING 只有 3 筆）
      … FROM orders o JOIN customer c ON c.id = o.customer_id
        WHERE o.status = 'PENDING' OR '1'='1' ORDER BY o.placed_at
   #{} 傳合法的 PENDING → 3 筆
      … FROM orders o JOIN customer c ON c.id = o.customer_id
        WHERE o.status = ? ORDER BY o.placed_at
   ── #{} 傳那個字串會怎樣（列舉擋在型別那一層）──
   → IllegalArgumentException │ No enum constant com.example.lab.ch07.St7Status.PENDING' OR '1'='1
```

**`WHERE o.status = 'PENDING' OR '1'='1'` —— `WHERE` 條件形同不存在。**

📌 **最後那三行值得展開**：那個惡意字串在 `#{}` 這一側**根本進不來**，
因為方法簽章是 `St7Status`（列舉），而不是 `String`。

> **這是一條被低估的防線：讓參數的型別【不是 `String`】。**
>
> ```java
> List<OrderRow> findByStatus(@Param("status") St7Status status);   // ✅ 列舉
> List<OrderRow> findByStatus(@Param("status") String status);      // 🟡 靠 #{} 保護
> ```
>
> 兩者都安全（因為都用 `#{}`），**而第一個連「有人以後把它改成 `${}`」都擋掉了**——
> 列舉的 `toString()` 永遠是那七個名字之一。
> 06 站 00 章 0.11.4 那條「對照表」的規則，在這裡的最強形式就是**用列舉當參數型別**。

### 7.6.3 ★ 實測：兩者送到伺服器的是什麼（一個常見的誤解）

**大部分人對 `#{}` 的理解是「值不會變成 SQL 文字的一部分」。打開 general log 看看。**

```java
    @Test
    void c_伺服器收到什麼() {
        head("7.6.3 兩者送到伺服器的到底是什麼");
        seed(2, 1, 0);
        withGeneralLog("#{} 版", () -> mapper.findByStatus(St7Status.PENDING));
        withGeneralLog("${} 版", () -> mapper.findByStatusUnsafe("PENDING"));
    }
```

**實測**：

```
── #{} 版 → 伺服器收到 2 句
   … FROM orders o JOIN customer c ON c.id = o.customer_id
     WHERE o.status = 'PENDING' ORDER BY o.placed_at
── ${} 版 → 伺服器收到 2 句
   … FROM orders o JOIN customer c ON c.id = o.customer_id
     WHERE o.status = 'PENDING' ORDER BY o.placed_at
```

> ★★ **兩者送到 MySQL 的東西【一字不差】。**
>
> **因為 MySQL 的 JDBC 驅動預設用【客戶端預備敘述】**（`useServerPrepStmts=false`）：
> 它拿到 `WHERE o.status = ?` 與參數 `"PENDING"`，
> **在客戶端把它們組成完整的 SQL 文字**，然後用一個普通的 `COM_QUERY` 送出去。
>
> **所以 `#{}` 的安全性不是「值沒有出現在 SQL 文字裡」。**
> **它是「值在被放進那個文字之前，被驅動【正確地轉義與引號化】了」。**

**同一個實驗，把惡意字串餵進 `#{}`**（用一個 `String` 參數的版本）：

```
#{}  參數 = PENDING' OR '1'='1
     → WHERE o.status = 'PENDING\' OR \'1\'=\'1'      ← 引號被轉義了，它就是一個字串
${}  參數 = PENDING' OR '1'='1
     → WHERE o.status = 'PENDING' OR '1'='1'          ← 引號原封不動，變成語法
```

📌 **這個區別為什麼重要**（三個實務後果）：

```
① 你在 general log / 慢查詢 log 裡看到的 SQL【是完整的、可以直接複製去跑的】。
   這是 MySQL 開發體驗上一個很大的方便，而它跟 #{} / ${} 無關。

② 「用 PreparedStatement 就一定安全」這句話少了半句：
   安全的是【驅動的轉義】，而 ${} 走的是【MyBatis 的字串串接】，
   它在驅動看到那句 SQL 之前就已經完成了。驅動沒有機會保護你。

③ 如果你把 useServerPrepStmts 設成 true（真正的伺服器端預備敘述），
   #{} 會變成兩次來回（PREPARE + EXECUTE），而值真的不會出現在 SQL 文字裡。
   ⚠️ 安全性【不會因此改變】——因為 ${} 那一側依然是串接。
```

### 7.6.4 🔴 實測：那些只能用 `${}` 的位置

```java
    @Select("""
            SELECT o.id, o.order_no, o.status, o.total_amount, o.placed_at,
                   c.display_name AS customer_name, 0 AS item_count
              FROM orders o JOIN customer c ON c.id = o.customer_id
             ORDER BY ${sortColumn} ${sortDir}
            """)
    List<OrderRow> findAllSorted(@Param("sortColumn") String sortColumn,
                                 @Param("sortDir") String sortDir);
```

**實測**：

```
   ✅ 合法排序：
── ORDER BY total_amount DESC → 1 句 SQL
   … FROM orders o JOIN customer c ON c.id = o.customer_id ORDER BY total_amount DESC

   🔴 注入（sortDir 傳 "DESC, (SELECT count(*) FROM customer)"）：
   → 沒有例外
      … FROM orders o JOIN customer c ON c.id = o.customer_id
        ORDER BY total_amount DESC, (SELECT count(*) FROM customer)
```

**那句子查詢真的被執行了。** `ORDER BY` 後面可以放任意運算式 ——
包含子查詢、包含 `SLEEP(10)`、包含把資料拿出來的技巧
（`ORDER BY IF((SELECT password FROM users LIMIT 1) LIKE 'a%', 1, 2)` 是一個經典的盲注）。

**那改用 `#{}` 呢？**

```java
    @Test
    void d_ORDER_BY_只能用_dollar() {
        …
        System.out.println("      每張訂單的金額："
                + jdbc.queryForList("SELECT order_no, total_amount FROM orders ORDER BY order_no"));
        System.out.println("      ORDER BY ? DESC（值 = 'total_amount'）→ "
                + jdbc.queryForList("SELECT order_no FROM orders ORDER BY ? DESC", "total_amount"));
        System.out.println("      直接寫 ORDER BY total_amount DESC     → "
                + jdbc.queryForList("SELECT order_no FROM orders ORDER BY total_amount DESC"));
    }
```

**實測**：

```
   每張訂單的金額：[{order_no=SO-2026-000001, total_amount=0.0000},
                   {order_no=SO-2026-000002, total_amount=1.0000},
                   {order_no=SO-2026-000003, total_amount=2.0000},
                   {order_no=SO-2026-000004, total_amount=3.0000}]
   ORDER BY ? DESC（值 = 'total_amount'）→ [000001, 000002, 000003, 000004]   ← 🔴 沒有排序
   直接寫 ORDER BY total_amount DESC     → [000004, 000003, 000002, 000001]   ← ✅
```

> 🔴 **`ORDER BY ?` 不會報錯，也不會排序。**
>
> **機制**：SQL 的 `?` 是一個【值】的位置。
> `ORDER BY '一個字串常數'` 在 MySQL 上是合法的 ——
> 它的意思是「**每一列都按同一個常數排序**」，也就是「不排序」。
>
> **這比報錯糟糕得多**：一個「排序功能壞掉但沒有人發現」的 API。

**所以規則是**：

| 位置 | 能用 `#{}` 嗎 | 為什麼 |
|---|---|---|
| `WHERE x = ?` 的值 | ✅ **一律用 `#{}`** | 它就是一個值 |
| `IN (?, ?, ?)` 的值 | ✅ `<foreach>` + `#{}`（08 章） | 同上 |
| `LIMIT ? OFFSET ?` | ✅ **可以用 `#{}`** | MySQL 支援參數化的 LIMIT |
| **`ORDER BY <欄位>`** | 🔴 **不行** | 它是一個【識別字】，不是值 |
| **`ORDER BY <方向>`** | 🔴 **不行** | 它是【語法關鍵字】 |
| **表名 / schema 名** | 🔴 **不行** | 識別字 |
| `AND` / `OR` 這種連接詞 | 🔴 不行（而且該用 `<if>`，08 章） | 語法 |

### 7.6.5 實測：對照表，而不是字串檢查

```java
package com.example.lab.ch07;

import java.util.Map;

/**
 * 7.6.5：排序欄位的白名單。
 *
 * ★ 06 站 00 章 0.11.4 的規則：【對照表，而不是字串檢查】。
 *   字串檢查（黑名單、正則）永遠會漏；對照表的預設結果是「拒絕」。
 */
public record OrderSort(String column, String dir) {

    /** ★ key 是【前端說的話】，value 是【資料庫的欄位名】—— 兩者刻意不一樣。 */
    private static final Map<String, String> COLUMNS = Map.of(
            "no",     "o.order_no",
            "amount", "o.total_amount",
            "date",   "o.placed_at",
            "status", "o.status");

    private static final Map<String, String> DIRS = Map.of("asc", "ASC", "desc", "DESC");

    public static OrderSort of(String field) { return of(field, "asc"); }

    public static OrderSort of(String field, String dir) {
        String col = COLUMNS.get(field == null ? "" : field.trim().toLowerCase());
        if (col == null) throw new IllegalArgumentException(
                "不支援的排序欄位：" + field + "（可用：" + COLUMNS.keySet() + "）");
        String d = DIRS.get(dir == null ? "" : dir.trim().toLowerCase());
        if (d == null) throw new IllegalArgumentException("不支援的排序方向：" + dir);
        return new OrderSort(col, d);
    }
}
```

**實測**：

```
   前端傳 "amount"                         → o.total_amount ASC（4 筆）
   前端傳 "date"                           → o.placed_at ASC（4 筆）
   前端傳 "no"                             → o.order_no ASC（4 筆）
   前端傳 "amount DESC; DROP TABLE orders" → 🔴 不支援的排序欄位：…（可用：[date, amount, no, status]）
   前端傳 ""                               → 🔴 不支援的排序欄位：（可用：[date, amount, no, status]）
```

**這個設計有四個刻意的決定**：

```
① key 與 value 【刻意不一樣】（"amount" → "o.total_amount"）。
   ★ 這讓「前端傳的字串」與「資料庫的欄位名」解耦：
     改欄位名不會影響 API，而且前端也看不到你的 schema。

② 對照表【找不到就拋例外】，不是「用預設值」。
   ★ 用預設值會讓「前端傳錯」變成靜默的行為改變。

③ 排序【方向】也走對照表 —— 不要用 `if ("desc".equals(d)) "DESC" else "ASC"`，
   那樣「傳一個奇怪的值」會靜默變成 ASC。

④ 它是一個 record，而且是【值物件】：一旦建好，裡面的字串就一定是安全的。
   ★ 這讓「安全」變成一個【型別】，而不是一個「要記得呼叫的檢查」。
     mapper 方法的參數如果宣告成 OrderSort，就不可能傳進一個沒檢查過的字串。
```

📌 **對照 05 章 5.7.6 那個 `JpaSort.unsafe`**：
Spring Data 在同一個問題上給的是「一個名字裡有 `unsafe` 的方法」，
**而它的正解也是同一張對照表。** 兩個框架在這件事上**沒有差別**——
**因為這不是框架的問題，是「識別字不能參數化」這個 SQL 的性質。**

### 7.6.6 `${}` 的四條規則

```
① 預設一律 #{}。看到 ${} 就當成一個要解釋的例外。
② ${} 只准出現在【識別字】與【語法關鍵字】的位置（7.6.4 那張表）。
③ 🔴 每一個 ${} 的值，都必須來自一張【對照表】，而且對照表的 key 是前端的詞彙。
④ 讓那個值的型別【不是 String】——包成 record / 列舉，讓安全變成型別（7.6.5 ④、7.6.2）。
```

⚠️ **`${}` 還有一個不在安全清單上的問題：它讓 SQL 的形狀變多。**
05 章 5.5.2 量過拼字串的代價（計畫快取 0 命中、每句多 28 µs）——
**`ORDER BY ${col} ${dir}` 有 4 × 2 = 8 種形狀。**
形狀數量是可控的（因為有對照表），**這也是對照表的第五個好處**。

---
## 7.7 參數傳遞的五種方式

```java
    /** 7.7 ①：單一參數不用 @Param。 */
    @Select("SELECT count(*) FROM orders WHERE status = #{whateverName}")
    long countByStatus(St7Status status);

    /** 7.7 ②：多個參數沒有 @Param 會怎樣。 */
    @Select("SELECT count(*) FROM orders WHERE status = #{param1} AND total_amount >= #{param2}")
    long countByStatusAndAmountPositional(St7Status status, java.math.BigDecimal min);

    /** 7.7 ④：整個 Map 當參數。 */
    @Select("SELECT count(*) FROM orders WHERE status = #{st} AND total_amount >= #{min}")
    long countByMap(Map<String, Object> params);

    /** 7.7 ⑤：POJO 當參數 —— #{} 裡寫的是它的【屬性名】。 */
    @Select("SELECT count(*) FROM orders WHERE status = #{status} AND total_amount >= #{minAmount}")
    long countByCriteria(OrderQuery q);
```

```java
package com.example.lab.ch07;

import java.math.BigDecimal;

/** 7.7 ⑤：POJO 當參數。#{} 裡寫的是屬性名，而屬性名是靠 getter 決定的。 */
public class OrderQuery {
    private St7Status status;
    private BigDecimal minAmount;

    public OrderQuery(St7Status status, BigDecimal minAmount) {
        this.status = status; this.minAmount = minAmount;
    }
    public St7Status getStatus() { return status; }
    public BigDecimal getMinAmount() { return minAmount; }
}
```

**實測**：

```
   ① 單一參數：#{} 裡的名字【隨便寫都會通】
      countByStatus(PENDING) = 6
   ② 多個參數沒有 @Param → 只能用 param1 / param2
      countByStatusAndAmountPositional = 4
   ③ 有 @Param → 用名字（findByStatus 就是）
   ④ 整個 Map
      countByMap = 4
   ⑤ POJO：#{} 裡寫的是【屬性名】
      countByCriteria = 4
   ── 🔴 沒有 @Param、用真的參數名會怎樣 ──
      那句 SQL 的參數對應：
         #{param1}
         #{param2}
```

**五種方式的對照**：

| 方式 | `#{}` 裡寫什麼 | 什麼時候用 |
|---|---|---|
| ① 單一參數 | **任何名字都會通** | 一個參數的時候。⚠️ 而它讓「名字寫錯」不會被發現 |
| ② 多參數、無 `@Param` | `param1`、`param2`…（也接受 `arg0`、`arg1`） | 🔴 **不要用** |
| ③ 多參數 + `@Param` | `@Param` 給的名字 | ✅ **預設就用這個** |
| ④ `Map` | Map 的 key | 🟡 條件是真的動態的時候（而 08 章有更好的做法） |
| ⑤ POJO / record | **屬性名**（走 getter，或 record 的存取子） | ✅ 參數超過三四個的時候 |

⚠️ **① 那一格值得展開**：

```java
@Select("SELECT count(*) FROM orders WHERE status = #{whateverName}")
long countByStatus(St7Status status);           // ← 參數叫 status，SQL 裡寫 whateverName
```

**它可以跑。** 單一參數的時候 MyBatis **不看名字**，直接把那個唯一的參數塞進去。
**所以「`#{}` 裡的名字打錯」在單一參數的方法上永遠不會被發現**——
直到有一天有人加了第二個參數，那時候整個方法會突然開始拋
`BindingException: Parameter 'whateverName' not found`。

📌 **規則：即使只有一個參數，也寫 `@Param`。**
它讓「名字」變成一個**真的有意義的東西**，而不是一個裝飾。

⚠️ **② 那個 `param1` / `param2` 為什麼不能用**：
它跟**參數的位置**綁定。有人重排參數順序（一個看起來完全安全的重構），
SQL 的意思就反了 —— **而型別剛好一樣的時候，編譯器也不會擋。**

```java
// 重構前
long count(St7Status status, String memo);        // #{param1} = status
// 重構後（只是換了順序）
long count(String memo, St7Status status);        // #{param1} = memo  🔴 靜默錯誤
```

📌 **`-parameters` 編譯選項**：
Java 8 之後，用 `-parameters` 編譯的話 MyBatis **可以讀到真的參數名**，
於是 `#{status}` 也會通。**而本課不建議依賴它**——
它是一個編譯選項，而**編譯選項會在別人的 IDE、別人的 CI 上不一樣**。
`@Param` 是寫在原始碼裡的，它到哪裡都一樣。

⚠️ **兩個保留名稱**：`collection` 與 `list`。
單一參數是 `Collection` 的時候，`#{collection}` / `#{list}` 都指向它
（陣列則是 `array`）。**08 章的 `<foreach collection="list">` 就是靠這個。**
而加了 `@Param("ids")` 之後就要寫 `collection="ids"` —— **兩種寫法不能混。**

---

## 7.8 結果映射

### 7.8.1 實測：自動映射，以及那個安靜的 null

```java
    /** 沒有別名的話會怎樣（display_name 不是 customer_name）。 */
    @Select("""
            SELECT o.id, o.order_no, o.status, o.total_amount, o.placed_at,
                   c.display_name, 0 AS item_count
              FROM orders o JOIN customer c ON c.id = o.customer_id
             WHERE o.order_no = #{orderNo}
            """)
    OrderRow findOneNoAlias(@Param("orderNo") String orderNo);
```

**實測**：

```
   ① 欄位名 = 屬性名（status）→ 自動對上
   ② 底線轉駝峰（order_no → orderNo）→ 靠 map-underscore-to-camel-case
      目前設定 mapUnderscoreToCamelCase = true
   ③ SQL 別名（c.display_name AS customer_name）→ 再走 ② 的規則
   結果：OrderRow{SO-2026-000001, PENDING, 100.0000, 客戶=客戶0, 明細=0}

   ── 🔴 沒有別名的時候（display_name 不是 customer_name）──
   結果：OrderRow{SO-2026-000001, PENDING, 100.0000, 客戶=null, 明細=0}
      customerName 是 null，而且【沒有任何警告】
   autoMappingUnknownColumnBehavior = NONE
```

> 🔴 **`customerName` 是 null，日誌上一個字都沒有。**
>
> **自動映射的規則**：對結果集的每一個欄位，找一個同名（或底線轉駝峰後同名）的屬性。
> **找到就填，找不到就【什麼都不做】。**
>
> ⚠️ **這是 7.4.5 那張表的第三列**，也是 MyBatis 最安靜的一個錯誤：
> **它跟「SQL 打錯字」不一樣 —— SQL 是對的、查詢是成功的、只有那個欄位是 null。**

**修法有三個層次**：

```yaml
# ① 最便宜的：讓 MyBatis 至少抱怨一聲
mybatis:
  configuration:
    auto-mapping-unknown-column-behavior: WARNING     # 或 FAILING
```

```
NONE      （預設）什麼都不做           🔴
WARNING   在 log 印一行警告            🟡 至少查得到
FAILING   直接拋 SqlSessionException    ✅ 最安全，但既有專案打開會炸一片
```

📌 **注意它的名字**：`unknown-column` —— 它抓的是
「**結果集有一個欄位，而目標型別沒有對應的屬性**」。
**它抓不到反過來的情況**（目標型別有一個屬性，而結果集沒有那個欄位）——
**而 7.8.1 那個 null 正是反過來的情況。**

```
② 用 resultMap 逐欄指定（7.8.3）→ 對應關係變成一個【可以被讀、被搜尋的東西】
③ 🔴 為每一個 mapper 方法寫一個測試，斷言【每一個欄位都不是 null】（7.14）
```

> **③ 是唯一真正有效的那個。** 理由跟 7.4.5 一樣：
> **MyBatis 把正確性推遲到執行期，所以測試不是加分項。**

### 7.8.2 三種寫法的選擇

```
① resultType + 自動映射     → SQL 的欄位名（或別名）就是契約
② resultMap                → 對應關係寫在 XML 裡
③ resultMap + <constructor> → 走建構子（record 只能用這個或 ①）
```

| | 寫起來 | 改欄位名時 | 適合 |
|---|---|---|---|
| ① 自動映射 | 最短 | 🔴 **靜默 null** | 註解版的簡單查詢、只有幾個欄位 |
| ② `resultMap` | 最長 | ✅ 對應關係集中在一處 | 欄位多、多個查詢共用、有巢狀 |
| ③ 建構子 | 中等 | ✅ **型別對不上就炸**（7.8.5） | `record` / 不可變的 DTO |

📌 **本課的建議**：

```
簡單查詢（5 個欄位以內、一個地方用）  → ① resultType，而且【SQL 一定要寫別名】
需要巢狀集合 / 多處共用             → ② resultMap
DTO 是 record（本課的預設）          → ③ <constructor>，或 ① （7.8.5 會證明 ① 也可以）
```

### 7.8.3 實測：`resultMap`

📌 **下面這份 `src/main/resources/mapper/Ord7XmlMapper.xml` 是【這一節結束時】的樣子。**
**7.8.4～7.8.8b 每一節都會再往這個 `<mapper>` 裡加一個 `<select>`**
（那些小節的 XML 片段就是加進來的東西，縮排兩格的那些），
而 `<resultMap>` 與 `<sql>` 是共用的，只寫這一次。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN"
        "https://mybatis.org/dtd/mybatis-3-mapper.dtd">
<!-- ★ namespace 必須是 mapper 介面的【完整類別名】，一個字都不能錯 -->
<mapper namespace="com.example.lab.ch07.Ord7XmlMapper">

  <!-- ═══ 7.8.3 resultMap：逐欄指定 ═══ -->
  <resultMap id="rowMap" type="com.example.lab.ch07.OrderRow">
    <id     property="id"           column="id"/>
    <result property="orderNo"      column="order_no"/>
    <result property="status"       column="status"/>
    <result property="totalAmount"  column="total_amount"/>
    <result property="placedAt"     column="placed_at"/>
    <result property="customerName" column="customer_name"/>
    <result property="itemCount"    column="item_count"/>
  </resultMap>

  <!-- ★ 抽出來的 SQL 片段，多個查詢共用 -->
  <sql id="rowColumns">
    o.id, o.order_no, o.status, o.total_amount, o.placed_at,
    c.display_name AS customer_name,
    (SELECT count(*) FROM order_item i WHERE i.order_id = o.id) AS item_count
  </sql>

  <select id="listByStatus" resultMap="rowMap">
    SELECT <include refid="rowColumns"/>
      FROM orders o JOIN customer c ON c.id = o.customer_id
     WHERE o.status = #{status}
     ORDER BY o.placed_at
  </select>
</mapper>
```

**實測**：

```
   撈到 3 筆
      OrderRow{SO-2026-000001, PENDING, 200.0000, 客戶=客戶0, 明細=2}
      OrderRow{SO-2026-000002, PENDING, 201.0000, 客戶=客戶1, 明細=2}
      OrderRow{SO-2026-000003, PENDING, 202.0000, 客戶=客戶0, 明細=2}
```

**`<id>` 與 `<result>` 的差別，比看起來重要**：

```
<id>      這一欄（或這幾欄）是【這個物件的身分】
<result>  普通欄位

★ <id> 有兩個作用：
  ① 巢狀映射時，用它判斷「這一列還是同一個物件嗎」（7.8.6、7.8.8）
  ② 一級快取的 key 也用它（7.11）
```

📌 **`<sql>` + `<include>` 是 MyBatis 最被低估的功能**：
它讓「一組欄位」變成一個可以命名的東西。
**列表頁與匯出功能共用同一組欄位時，這是唯一能保證兩者一致的方式。**

⚠️ **`<sql>` 片段【不是】巨集，它是【字串拼接】**。
所以片段裡不能有 `${}` 以外的動態部分，
而且**片段裡的欄位名要考慮呼叫端的 alias**（上面的 `o.` 與 `c.` 就是一個隱含契約）。

### 7.8.4 建構子映射

```xml
  <!-- ═══ 7.8.4 建構子映射：record 沒有 setter，只能走這條 ═══ -->
  <resultMap id="recMap" type="com.example.lab.ch07.OrderRec">
    <constructor>
      <idArg     column="id"            javaType="java.util.UUID"/>
      <arg       column="order_no"      javaType="java.lang.String"/>
      <arg       column="status"        javaType="com.example.lab.ch07.St7Status"/>
      <arg       column="total_amount"  javaType="java.math.BigDecimal"/>
      <arg       column="placed_at"     javaType="java.time.Instant"/>
      <arg       column="customer_name" javaType="java.lang.String"/>
    </constructor>
  </resultMap>

  <select id="listRecByStatus" resultMap="recMap">
    SELECT o.id, o.order_no, o.status, o.total_amount, o.placed_at,
           c.display_name AS customer_name
      FROM orders o JOIN customer c ON c.id = o.customer_id
     WHERE o.status = #{status}
     ORDER BY o.placed_at
  </select>
```

**三條規則**：

```
① <arg> 的【順序】就是建構子參數的順序。名字不重要，順序重要。
   ★ 這是它最大的風險：兩個相鄰的 String 參數換了順序，編譯器不會擋。
② javaType 一定要寫。它是 MyBatis 用來找建構子的依據。
③ <idArg> 取代 <id>，用在身分欄位上。
```

### 7.8.5 🔴 實測：`record` 能不能用（以及那個 `long` / `Long`）

```java
    @Test
    void c_record_能不能用() {
        head("7.8.5 record 能不能當結果型別？");
        seed(3, 1, 1);
        String no = mapper.findAllOrderNos().get(0);

        System.out.println("   ① 註解 + resultType（靠自動映射）：");
        Throwable err = catching(() -> System.out.println("      " + mapper.findRec(no)));
        if (err != null) System.out.println("      🔴 " + name(err) + " │ " + cut(root(err).getMessage()));

        System.out.println("   ② XML + <constructor> 明確指定：");
        List<OrderRec> recs = xmlMapper.listRecByStatus(St7Status.PENDING);
        System.out.println("      撈到 " + recs.size() + " 筆");
        recs.forEach(r -> System.out.println("      " + r));
    }
```

**實測**：

```
   ① 註解 + resultType（靠自動映射）：
      OrderRec[id=01a07ff6-…, orderNo=SO-2026-000001, status=PENDING,
               totalAmount=100.0000, placedAt=2026-09-01T00:00:00Z, customerName=客戶0]
   ② XML + <constructor> 明確指定：
      撈到 3 筆
      OrderRec[id=01a07ff6-…, orderNo=SO-2026-000001, …]
```

> ✅ **兩種都可以。** MyBatis 3.5.14 **認得 `record`**：
> `resultType` 就能用（它會去找一個參數對得上的建構子），
> 不需要 `<constructor>`。
>
> 📌 **對照 05 章 5.8.5 那個 Hibernate 的「隱式建構」**：
> 兩邊在這件事上**都支援 record**，而 Hibernate 那一側有一個額外的限制
> （不能用在 Spring Data 的 `@Query` 上）。**MyBatis 沒有那個限制。**

**而它有一個一模一樣的坑。** 7.15 那個 `OrderListRow`：

```java
public record OrderListRow(
        UUID id, String orderNo, String customerName,
        OrderStatus status, BigDecimal totalAmount, Instant placedAt, long itemCount) {}
//                                                                    ↑ 原始型別 long
```

**第一版的 XML 寫的是 `javaType="long"`，結果是**：

```
org.apache.ibatis.reflection.ReflectionException:
  Error instantiating class com.example.lab.shop.OrderListRow
  with invalid types (UUID,String,String,OrderStatus,BigDecimal,Instant,Long)
  or values (01a07ffe-…,SO-2026-000198,客戶17,PENDING,330.0000,2026-07-09T05:00:00Z,2).
Cause: java.lang.NoSuchMethodException:
  com.example.lab.shop.OrderListRow.<init>(…,java.lang.Long)
```

> 🔴 **`javaType="long"` 在 MyBatis 裡是 `java.lang.Long`。**
> **原始型別的別名要加底線：`_long`。**
>
> ```xml
> <arg column="item_count" javaType="_long"/>     <!-- ✅ 對應 long -->
> <arg column="item_count" javaType="long"/>      <!-- 🔴 對應 Long -->
> ```
>
> **MyBatis 的型別別名表**（`TypeAliasRegistry`）：
>
> | 別名 | 實際型別 | | 別名 | 實際型別 |
> |---|---|---|---|---|
> | `_byte` `_short` `_int` `_long` | **原始型別** | | `byte` `short` `int` `long` | 包裝型別 |
> | `_float` `_double` `_boolean` | 原始型別 | | `float` `double` `boolean` | 包裝型別 |
> | `string` | `String` | | `decimal` / `bigdecimal` | `BigDecimal` |
>
> 📌 **這是 05 章 5.8.5 那個坑的第二次出現**：
> 那裡是 Hibernate 的隱式建構（`long` vs `Long` 就掛），這裡是 MyBatis 的 `<constructor>`。
> **兩個框架、同一個根本原因：`record` 的建構子簽章是精確的，而「型別的名字」有兩套系統。**
>
> ⚠️ **而錯誤訊息很好** —— 它把「你給的型別」與「找不到的建構子」都印出來了。
> 對照 7.8.1 那個「靜默 null」：**建構子映射的失敗是【吵的】，這是它比自動映射好的地方。**

### 7.8.6 實測：巢狀集合 —— 一句 JOIN 組出物件圖

```xml
  <!-- ═══ 7.8.6 巢狀 resultMap：一句 JOIN，靠 <id> 把列組回物件 ═══ -->
  <resultMap id="detailMap" type="com.example.lab.ch07.OrderDetail">
    <id     property="id"           column="id"/>
    <result property="orderNo"      column="order_no"/>
    <result property="status"       column="status"/>
    <result property="totalAmount"  column="total_amount"/>
    <result property="placedAt"     column="placed_at"/>
    <result property="customerName" column="customer_name"/>
    <!-- ★ collection：把多列組成一個集合。ofType 是【元素】的型別 -->
    <collection property="items" ofType="com.example.lab.ch07.ItemRow">
      <id     property="productName" column="i_product_name"/>
      <result property="qty"         column="i_qty"/>
      <result property="lineAmount"  column="i_line_amount"/>
    </collection>
  </resultMap>

  <select id="detailByStatus" resultMap="detailMap">
    SELECT o.id, o.order_no, o.status, o.total_amount, o.placed_at,
           c.display_name  AS customer_name,
           i.product_name  AS i_product_name,
           i.qty           AS i_qty,
           i.line_amount   AS i_line_amount
      FROM orders o
      JOIN customer c    ON c.id = o.customer_id
      LEFT JOIN order_item i ON i.order_id = o.id
     WHERE o.status = #{status}
     ORDER BY o.placed_at, i.id
  </select>
```

**實測**：

```
   撈到 3 張訂單
      OrderDetail{SO-2026-000001, 客戶=客戶0, 明細=[商品0×1=100.0000, 商品1×2=100.0000]}
      OrderDetail{SO-2026-000002, 客戶=客戶0, 明細=[商品1×1=100.0000, 商品2×2=100.0000]}
      OrderDetail{SO-2026-000003, 客戶=客戶0, 明細=[商品3×2=100.0000, 商品2×1=100.0000]}
   → 1 句 SQL
      … FROM orders o JOIN customer c ON c.id = o.customer_id
        LEFT JOIN order_item i ON i.order_id = o.id WHERE o.status = ? ORDER BY o.placed_at, i.id
```

**一句 SQL，組出「訂單 + 明細集合」的物件圖。**

📌 **兩個實作細節**：

```
① 欄位【一定要加前綴】（i_product_name）。
   ★ 理由：JOIN 之後 orders 與 order_item 都有 id 這個欄位名。
     MyBatis 是按欄位名找的，撞名會靜默拿到錯的值。
     ⚠️ 而 columnPrefix="i_" 這個屬性可以省掉逐欄寫前綴（08 章 8.5 會用）。

② <collection> 裡的 <id> 是【元素的身分】。
   ★ 這裡用 productName 當身分是【將就】的做法（同一張訂單裡商品名可能重複）。
     正確做法是把 order_item.id 也 SELECT 出來當 <id>。
     08 章 8.5 會處理「巢狀映射的身分欄位要選什麼」。
```

> 📌 **對照 04 章 4.5 那個 `JOIN FETCH`**：
> **兩者送出的 SQL 幾乎一樣，而後續完全不同**：
>
> ```
> JPA JOIN FETCH  → 400 列 → 650 個【實體】（含快照、髒檢查、一級快取）
> MyBatis 巢狀 map → 400 列 → 200 個【POJO】+ 400 個 ItemRow，沒有任何額外的東西
> ```
>
> **這是 05 章 5.8.10 那個結論的另一種說法**：
> **慢的是「實體」，而 MyBatis 從來沒有實體這個概念。**

### 7.8.7 🔴 實測：巢狀 `select` 就是 N+1

```xml
  <!-- ═══ 🔴 7.8.7 巢狀 select：MyBatis 這一側的 N+1 ═══ -->
  <resultMap id="nPlus1Map" type="com.example.lab.ch07.OrderDetail">
    <id     property="id"           column="id"/>
    <result property="orderNo"      column="order_no"/>
    <result property="status"       column="status"/>
    <result property="totalAmount"  column="total_amount"/>
    <result property="placedAt"     column="placed_at"/>
    <result property="customerName" column="customer_name"/>
    <!-- ★ select="itemsOf"：每一張訂單【再打一句 SQL】 -->
    <collection property="items" column="id" select="itemsOf"
                ofType="com.example.lab.ch07.ItemRow"/>
  </resultMap>

  <select id="detailNPlus1" resultMap="nPlus1Map">
    SELECT o.id, o.order_no, o.status, o.total_amount, o.placed_at,
           c.display_name AS customer_name
      FROM orders o JOIN customer c ON c.id = o.customer_id
     WHERE o.status = #{status}
     ORDER BY o.placed_at
  </select>

  <select id="itemsOf" resultType="com.example.lab.ch07.ItemRow">
    SELECT product_name AS productName, qty, line_amount AS lineAmount
      FROM order_item WHERE order_id = #{orderId}
     ORDER BY id
  </select>
```

**實測（50 張訂單，其中 38 張 PENDING）**：

```
   巢狀 resultMap（一句 JOIN）→ 1 句 SQL
   巢狀 select              → 39 句 SQL
── 巢狀 select 的形狀 → 共 39 句，2 種形狀
   ×1   SELECT o.id, o.order_no, … FROM orders o JOIN customer c ON …
   ×38  SELECT product_name AS productName, qty, line_amount AS lineAmount
        FROM order_item WHERE order_id = ? ORDER BY id
   耗時：JOIN 版 2 ms，巢狀 select 版 15 ms
   ⚠️ 而兩者的【Java 那一側完全一樣】——差別只在 XML 裡那一行
```

> 🔴 **`1 + 38 = 39`。這就是 04 章那個 N+1，一字不差的同一個形狀。**
>
> **而它跟 JPA 的 N+1 有一個關鍵差別**：
>
> ```
> JPA 的 N+1：   你【沒有寫】任何東西。它是 lazy 載入的副作用（04 章 4.1）。
>               所以它會在你完全沒有預期的地方出現。
>
> MyBatis 的 N+1：你【寫了】 select="itemsOf" 這一行。
>               它出現在你寫的地方，而且只出現在那裡。
> ```
>
> **00 章 0.5.5 那張表的最後一列（「不會有『不小心 lazy 載入』的 N+1」）
> 在這裡要打一個折扣，也只要打這一個折扣**：
> **MyBatis 的 N+1 是【可以靠讀 XML 找出來的】**——`grep 'select='` 就找到了。
> **而 JPA 的 N+1 要靠 04 章那把 `NPlus1Spy` 才量得出來。**

⚠️ **那 `select=` 這個功能有存在的理由嗎？** 有兩個：

```
① fetchType="lazy"：集合真的很少被用到的時候（08 章會處理）
② 分頁：巢狀 JOIN 的結果沒辦法用 LIMIT 分頁 —— 這正是 04 章 4.5.6 那個
   「fetch 集合 + 分頁 = 記憶體分頁」的同一個問題。
   ★ 兩邊的正解也一樣：分兩段查（先查 id、再查明細）。08 章 8.5 會寫完整。
```

### 7.8.8 ★ 實測：`resultOrdered` 與「列的順序」

**每一份 MyBatis 教學都會說**（包含 00 章 0.7 的那一段）：

> 「巢狀 `resultMap` 是靠『連續的列有相同的 `<id>`』來分組的，
> **同一張訂單的列必須相鄰**。忘了排序不會報錯，只會讓同一張訂單被拆成好幾筆。」

**這句話在預設組態下是【錯的】。** 量一次。

```java
    @Test
    void f_忘記排序會怎樣() {
        head("7.8.8 🔴 巢狀 resultMap 與「列的順序」");
        seed(2, 1, 2);
        // ★ 把明細的商品名改成【交錯】的：按名字排序時，兩張訂單的列會夾在一起
        List<byte[]> oids = jdbc.query("SELECT id FROM orders ORDER BY order_no",
                (rs, n) -> rs.getBytes(1));
        rename(oids.get(0), "A1", "A3");
        rename(oids.get(1), "A2", "A4");

        System.out.println("   資料庫回的列（真的交錯了）：");
        jdbc.queryForList("SELECT o.order_no, i.product_name FROM orders o"
                + " JOIN order_item i ON i.order_id = o.id"
                + " WHERE o.status = 'PENDING' ORDER BY i.product_name")
            .forEach(r -> System.out.println("      " + r));

        System.out.println("   ── ① 預設（resultOrdered 未設，也就是 false）──");
        dump(xmlMapper.detailUnordered(St7Status.PENDING));

        System.out.println("   ── ② 同一句 SQL，加上 resultOrdered=\"true\" ──");
        dump(xmlMapper.detailUnorderedOrderedFlag(St7Status.PENDING));

        System.out.println("   ── ③ resultOrdered=\"true\" + 正確的排序 ──");
        dump(xmlMapper.detailOrderedFlagSorted(St7Status.PENDING));
    }

    private void rename(byte[] orderId, String a, String b) {
        List<byte[]> ids = jdbc.query("SELECT id FROM order_item WHERE order_id = ? ORDER BY id",
                (rs, n) -> rs.getBytes(1), (Object) orderId);
        jdbc.update("UPDATE order_item SET product_name = ? WHERE id = ?", a, ids.get(0));
        jdbc.update("UPDATE order_item SET product_name = ? WHERE id = ?", b, ids.get(1));
    }

    private static void dump(List<OrderDetail> ds) {
        System.out.println("      → " + ds.size() + " 個 OrderDetail（資料庫裡只有 2 張訂單）");
        ds.forEach(d -> System.out.println("         " + d.getOrderNo()
                + " → " + d.getItems().size() + " 筆明細 " + d.getItems()));
    }
```

**三個 `<select>`，同一個 `resultMap`**：

```xml
  <!-- ① 沒有排序、resultOrdered 未設（預設 false） -->
  <select id="detailUnordered" resultMap="detailMap">
    SELECT o.id, o.order_no, o.status, o.total_amount, o.placed_at,
           c.display_name AS customer_name,
           i.product_name AS i_product_name, i.qty AS i_qty, i.line_amount AS i_line_amount
      FROM orders o
      JOIN customer c ON c.id = o.customer_id
      LEFT JOIN order_item i ON i.order_id = o.id
     WHERE o.status = #{status}
     ORDER BY i.product_name           <!-- 🔴 故意只按商品名排，同一張訂單的列會被拆開 -->
  </select>

  <!-- ② 同一句 SQL，加上 resultOrdered="true" -->
  <select id="detailUnorderedOrderedFlag" resultMap="detailMap" resultOrdered="true">
    …（SQL 與 ① 一字不差）…
  </select>

  <!-- ③ resultOrdered="true" + 正確的排序 -->
  <select id="detailOrderedFlagSorted" resultMap="detailMap" resultOrdered="true">
    …（同上，但 ORDER BY o.placed_at, i.id）…
  </select>
```

**實測**：

```
   資料庫回的列（真的交錯了）：
      {order_no=SO-2026-000001, product_name=A1}
      {order_no=SO-2026-000002, product_name=A2}
      {order_no=SO-2026-000001, product_name=A3}
      {order_no=SO-2026-000002, product_name=A4}

   ── ① 預設（resultOrdered 未設，也就是 false）──
      → 2 個 OrderDetail（資料庫裡只有 2 張訂單）
         SO-2026-000001 → 2 筆明細 [A1×2=100.0000, A3×1=100.0000]
         SO-2026-000002 → 2 筆明細 [A2×2=100.0000, A4×1=100.0000]      ✅ 完全正確

   ── ② 同一句 SQL，加上 resultOrdered="true" ──
      → 4 個 OrderDetail（資料庫裡只有 2 張訂單）                      🔴🔴
         SO-2026-000001 → 1 筆明細 [A1×2=100.0000]
         SO-2026-000002 → 1 筆明細 [A2×2=100.0000]
         SO-2026-000001 → 1 筆明細 [A3×1=100.0000]
         SO-2026-000002 → 1 筆明細 [A4×1=100.0000]

   ── ③ resultOrdered="true" + 正確的排序 ──
      → 2 個 OrderDetail（資料庫裡只有 2 張訂單）
         SO-2026-000001 → 2 筆明細 [A1×2=100.0000, A3×1=100.0000]
         SO-2026-000002 → 2 筆明細 [A2×2=100.0000, A4×1=100.0000]      ✅
```

**機制**：

| | `resultOrdered="false"`（預設） | `resultOrdered="true"` |
|---|---|---|
| MyBatis 記得什麼 | **一張 map**：`<id> → 已經組好的物件` | **只記得上一列的 `<id>`** |
| 列的順序要緊嗎 | ❌ **不要緊** | ✅ **要緊** |
| 記憶體 | 🔴 **整個結果集的物件都要留著** | ✅ **一次只留一個** |
| 適合 | 一般的巢狀查詢 | **配 `ResultHandler` 或 `Cursor` 做流式處理** |

> ★ **所以那句流傳的話要改成**：
>
> **「巢狀 `resultMap` 【預設不需要】排序，而它的代價是把整個結果集留在記憶體裡。
> 要流式處理（`resultOrdered="true"` + `Cursor`）的時候，排序才變成必要條件 ——
> 而那時候忘了排序會讓一個物件被拆成好幾個。」**
>
> 📌 **這修正了 00 章 0.7 那一段的一句話**（「④ 需要 `ORDER BY o.id`」）：
> 那句 `ORDER BY` **不是正確性的必要條件**，它只是一個好習慣
> （而且它讓結果的順序是穩定的，那本身有價值）。
>
> ⚠️ **而 `resultOrdered="true"` 是一個真正危險的選項**：
> **它只有在「SQL 保證分組相鄰」的前提下才正確，而那個前提【沒有任何東西會檢查】。**
> 有人以後改了 `ORDER BY`（一個看起來完全無害的改動），結果就從 2 筆變成 4 筆。
>
> **判準：除非你正在用 `Cursor` 處理很大的結果集，不要碰 `resultOrdered`。**
> **而如果碰了，那句 SQL 的 `ORDER BY` 就是它的一部分 —— 要在旁邊寫下來。**

---

## 7.9 回傳型別

### 7.9.1 實測：八種

```java
    @Test
    void g_回傳型別() {
        head("7.9 回傳型別：八種");
        seed(4, 2, 1);
        String no = mapper.findAllOrderNos().get(0);

        System.out.println("   ① 單一物件      findOne      = " + mapper.findOne(no));
        System.out.println("   ② Optional      findOptional = " + mapper.findOptional(no).isPresent());
        System.out.println("      查不到的時候  findOne      = " + mapper.findOne("不存在"));
        System.out.println("      查不到的時候  findOptional = " + mapper.findOptional("不存在"));
        System.out.println("   ③ List          findByStatus = "
                + mapper.findByStatus(St7Status.PENDING).size() + " 筆");
        System.out.println("   ④ 純量          countByStatus= " + mapper.countByStatus(St7Status.PENDING));
        System.out.println("   ⑤ List<String>  findAllOrderNos = " + mapper.findAllOrderNos());
        System.out.println("   ⑥ Map（@MapKey）findAllAsMap 的 key = " + mapper.findAllAsMap().keySet());
        System.out.println("   ⑦ List<Map>     findAllAsMaps[0]    = " + mapper.findAllAsMaps().get(0));

        System.out.println("   🔴 查到三筆卻宣告成單一物件：");
        Throwable err = catching(() -> mapper.findOneButManyRows(St7Status.PENDING));
        System.out.println("      → " + name(err) + " │ " + cut(String.valueOf(root(err).getMessage())));
    }
```

**實測**：

```
   ① 單一物件      findOne      = OrderRow{SO-2026-000001, PENDING, 100.0000, 客戶=客戶0, 明細=0}
   ② Optional      findOptional = true
      查不到的時候  findOne      = null
      查不到的時候  findOptional = Optional.empty
   ③ List          findByStatus = 3 筆
   ④ 純量          countByStatus= 3
   ⑤ List<String>  findAllOrderNos = [SO-2026-000001, …000002, …000003, …000004]
   ⑥ Map（@MapKey）findAllAsMap 的 key = [SO-2026-000001, SO-2026-000004, SO-2026-000002, SO-2026-000003]
   ⑦ List<Map>     findAllAsMaps[0]    = {order_no=SO-2026-000001, total_amount=100.0000, status=PENDING}
   🔴 查到三筆卻宣告成單一物件：
      → MyBatisSystemException ← TooManyResultsException │
        Expected one result (or null) to be returned by selectOne(), but found: 3
   ⚠️ 對照：查不到的時候 findOne 回 null（不拋例外）
      —— 所以【查不到】與【查到很多】兩件事的回報方式完全不同
```

**那三個特別的**：

```java
    /** @MapKey：把 List 變成 Map，key 是某個屬性。 */
    @MapKey("orderNo")
    @Select("SELECT … FROM orders o JOIN customer c ON c.id = o.customer_id")
    Map<String, OrderRow> findAllAsMap();

    /** 每一列變成一個 Map（沒有 DTO 類別的時候）。 */
    @Select("SELECT order_no, status, total_amount FROM orders ORDER BY placed_at")
    List<Map<String, Object>> findAllAsMaps();

    /** 只要一欄。 */
    @Select("SELECT order_no FROM orders ORDER BY placed_at")
    List<String> findAllOrderNos();
```

⚠️ **`List<Map<String, Object>>` 那一個要小心**：

```
① 它的 key 是【資料庫的欄位名】，不走 mapUnderscoreToCamelCase
   → 上面實測的 key 是 order_no，不是 orderNo
② 值的型別由驅動決定（decimal → BigDecimal、datetime → LocalDateTime）
③ 🔴 它完全沒有型別檢查 —— 欄位改名、型別改變，編譯期與啟動期都不會知道

★ 用它的唯一合理場合是「欄位是動態的」（例如使用者自訂的報表）。
  其他時候寫一個 record，成本很低而收益是型別安全（7.8.5）。
```

📌 **`@MapKey` 有一個陷阱**：實測的 key 順序是
`[000001, 000004, 000002, 000003]` —— **不是 SQL 的順序**。
它回的是 `HashMap`，**`ORDER BY` 完全白寫**。
要保序就自己收：`list.stream().collect(toMap(…, …, (a,b)->a, LinkedHashMap::new))`。

### 7.9.2 「查不到」與「查到很多」

**這兩件事的回報方式不一樣，而且是刻意的**：

| 情況 | `OrderRow findOne(...)` | `Optional<OrderRow>` | `List<OrderRow>` |
|---|---|---|---|
| 0 筆 | `null` | `Optional.empty()` | 空 List |
| 1 筆 | 那個物件 | `Optional.of(...)` | 1 個元素 |
| **3 筆** | 🔴 **`TooManyResultsException`** | 🔴 **同樣拋例外** | 3 個元素 |

> 📌 **本課的建議**：
> **回傳單筆的查詢，一律宣告 `Optional<T>`。**
>
> 理由跟 06 站 00 章 0.11.5 那條「不該吞例外、回 null」一樣：
> `null` 會被傳下去、被存進 Map、被塞進 stream，
> **然後在一個離出事點很遠的地方拋 `NullPointerException`。**
>
> ⚠️ **而 `TooManyResultsException` 是好事，不要試圖繞過它**：
> 它代表「你以為這個條件唯一，而它不是」——那通常是一個**資料或約束的問題**，
> 而不是一個「加個 `LIMIT 1` 就好」的問題。
> **加 `LIMIT 1` 是把一個明確的錯誤換成一個隨機的答案。**

### 7.9.3 實測：`Cursor` —— 不把整個結果集放進記憶體

```java
    @Select("SELECT … FROM orders o JOIN customer c ON c.id = o.customer_id")
    @Options(fetchSize = Integer.MIN_VALUE,
             resultSetType = org.apache.ibatis.mapping.ResultSetType.FORWARD_ONLY)
    org.apache.ibatis.cursor.Cursor<OrderRow> streamAll();
```

```java
    @Test
    void h_Cursor_流式處理() {
        head("7.9.3 Cursor：不把整個結果集放進記憶體");
        seed(200, 20, 1);
        // ★ Cursor 一定要在【交易裡】用，而且要關掉
        tx.executeWithoutResult(s -> {
            try (var cursor = mapper.streamAll()) {
                int n = 0;
                java.math.BigDecimal sum = java.math.BigDecimal.ZERO;
                for (OrderRow r : cursor) {
                    n++;
                    sum = sum.add(r.getTotalAmount());
                    if (n == 1) System.out.println("   第 1 列就開始處理了，cursor 已開啟 = "
                            + cursor.isOpen() + "，目前索引 = " + cursor.getCurrentIndex());
                }
                System.out.println("   跑完 " + n + " 列，總金額 = " + sum);
            } catch (java.io.IOException e) { throw new RuntimeException(e); }
        });
        System.out.println("   ── 沒有交易的話 ──");
        Throwable err = catching(() -> {
            try (var c = mapper.streamAll()) { c.iterator().next(); }
            catch (java.io.IOException e) { throw new RuntimeException(e); }
        });
        System.out.println("   → " + name(err) + " │ " + cut(String.valueOf(root(err).getMessage())));
    }
```

**實測**：

```
   第 1 列就開始處理了，cursor 已開啟 = true，目前索引 = 0
   跑完 200 列，總金額 = 39900.0000
   ── 沒有交易的話 ──
   → IllegalStateException │ A Cursor is already closed.
```

**`Cursor` 的四個必要條件**：

```
① 一定要在【交易裡】用。
   ★ 沒有交易的話，mapper 方法回傳的那一刻 SqlSession 就關了（7.11.2），
     游標跟著關 —— 而錯誤訊息是「A Cursor is already closed」，
     它【不會】告訴你「你忘了開交易」。

② 一定要 try-with-resources 關掉它。不關就是一條連線洩漏。

③ MySQL 要 fetchSize = Integer.MIN_VALUE 才是真的流式。
   ★ 這是 MySQL 驅動的一個特殊約定（06 站 02 章 2.5 講過，06 站 06 章的探針 ⑲ 證實過）：
     只有這個值會讓驅動【一列一列】從 socket 讀；
     其他值（包含 100、1000）都會讓它把整個結果集先讀進記憶體。
   ⚠️ 而流式的期間，那條連線【不能做別的事】。

④ 只能往前走一次。它是 FORWARD_ONLY。
```

📌 **對照 05 章那個 `Stream<T>`**（Spring Data JPA 也支援流式），
以及 06 章 6.3.10 那個 `flush() + clear()`：
**三者解的是同一個問題 —— 讓記憶體使用量跟資料量脫鉤。**

### 7.9.4 🔴 實測：`RowBounds` 是記憶體分頁

```java
    /** 🔴 RowBounds 是【記憶體分頁】。 */
    @Select("SELECT … FROM orders o JOIN customer c ON c.id = o.customer_id ORDER BY o.placed_at")
    List<OrderRow> pageByRowBounds(RowBounds bounds);

    /** ✅ 真正的分頁：limit 寫在 SQL 裡。 */
    @Select("SELECT … ORDER BY o.placed_at LIMIT #{size} OFFSET #{offset}")
    List<OrderRow> pageBySql(@Param("offset") int offset, @Param("size") int size);
```

**實測（資料庫裡 3000 筆）**：

```
   RowBounds(0, 20) → 拿到 20 筆
      … FROM orders o JOIN customer c ON c.id = o.customer_id ORDER BY o.placed_at
                                                                     ↑ 🔴 沒有 limit
   LIMIT/OFFSET 寫在 SQL 裡 → 拿到 20 筆
      … FROM orders o JOIN customer c ON c.id = o.customer_id ORDER BY o.placed_at LIMIT ? OFFSET ?
   耗時：RowBounds 4 ms，SQL limit 2 ms（資料庫裡 3000 筆）
   ⚠️ RowBounds 那一句【沒有 limit】：3000 列全部撈回 JVM，然後丟掉 2980 列
```

> 🔴 **`RowBounds` 不會產生 `LIMIT`。它把全部的列撈回來，然後在 Java 裡跳過與截斷。**
>
> **這是 04 章 4.5.6 那個「fetch 集合 + 分頁 = 記憶體分頁」的 MyBatis 版**——
> 而它比 JPA 那個更糟一點：
>
> ```
> JPA 記憶體分頁：Hibernate 至少會【印一行警告】（HHH90003004）
> MyBatis RowBounds：一個字都沒有
> ```
>
> ⚠️ **3000 筆只差 2 ms，所以它在測試環境永遠不會被發現。**
> 換成 300 萬筆就是一次 OOM。**這是「跟資料量有關的缺陷」的標準形狀**——
> 04 章 4.2.2 講過為什麼這種缺陷的斷言要寫在「SQL 的形狀」上，而不是時間上。

📌 **正解只有一個：`LIMIT` / `OFFSET` 寫進 SQL。**
而實務上會用 `PageHelper` 這類外掛（它用攔截器改寫 SQL、自動補 `LIMIT`）——
**08 章 8.6 會處理它，包含它的兩個坑。**

⚠️ **而 `OFFSET` 本身在大偏移量上是慢的**（06 站 04 章 4.7 講過深分頁，
06 站 06 章 6.4.3 量到 keyset 的兩種寫法差 4762 倍）。**keyset 分頁才是那個問題的解**，
而 MyBatis 寫 keyset 分頁**比 JPA 容易得多** —— 那是它的主場之一。

---
## 7.10 寫入

### 7.10.1 實測：回傳值與取回主鍵

```java
package com.example.lab.ch07;

import java.math.BigDecimal;

public class SeqRow {
    private Long id;
    private String code;
    private BigDecimal amount;

    public SeqRow() {}
    public SeqRow(String code, BigDecimal amount) { this.code = code; this.amount = amount; }

    public Long getId() { return id; }
    public void setId(Long v) { this.id = v; }
    public String getCode() { return code; }
    public void setCode(String v) { this.code = v; }
    public BigDecimal getAmount() { return amount; }
    public void setAmount(BigDecimal v) { this.amount = v; }
}
```

```java
package com.example.lab.ch07;

import org.apache.ibatis.annotations.*;

import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;

/** 7.10 寫入與取回主鍵。 */
@Mapper
public interface KeyMapper {

    /** 🔴 不設 useGeneratedKeys：insert 之後 id 還是 null。 */
    @Insert("INSERT INTO seq_row (code, amount) VALUES (#{code}, #{amount})")
    int insertNoKey(SeqRow r);

    /** ✅ useGeneratedKeys：把自增的 id 寫回物件。 */
    @Insert("INSERT INTO seq_row (code, amount) VALUES (#{code}, #{amount})")
    @Options(useGeneratedKeys = true, keyProperty = "id")
    int insertWithKey(SeqRow r);

    /** 批次插入一句多值 —— 順便看 useGeneratedKeys 在多值 INSERT 上的行為。 */
    @Insert("""
            <script>
            INSERT INTO seq_row (code, amount) VALUES
            <foreach collection="rows" item="r" separator=",">
              (#{r.code}, #{r.amount})
            </foreach>
            </script>
            """)
    @Options(useGeneratedKeys = true, keyProperty = "rows.id")
    int insertMany(@Param("rows") List<SeqRow> rows);

    /** UUID 主鍵：不需要取回，因為是應用端給的（07 站 1.8.4）。 */
    @Insert("INSERT INTO uuid_row (id, code, amount) VALUES (#{id}, #{code}, #{amount})")
    int insertUuid(@Param("id") UUID id, @Param("code") String code,
                   @Param("amount") BigDecimal amount);

    @Select("SELECT count(*) FROM seq_row")
    long countSeq();

    @Select("SELECT count(*) FROM uuid_row")
    long countUuid();

    @Delete("DELETE FROM seq_row")
    int clearSeq();

    @Delete("DELETE FROM uuid_row")
    int clearUuid();
}
```

**實測**：

```
   insert 回傳 = 1（影響列數）
   🔴 而 r.getId() = null（沒設 useGeneratedKeys）
   ── 加上 @Options(useGeneratedKeys = true, keyProperty = "id") ──
   insert 回傳 = 1，而 r2.getId() = 15002 ✅
   ── 批次插入 + useGeneratedKeys ──
   insertMany 回傳 = 3
      C0 → id = 15003
      C1 → id = 15004
      C2 → id = 15005
── 那一句多值 INSERT → 1 句 SQL
   INSERT INTO seq_row (code, amount) VALUES (?, ?) , (?, ?) , (?, ?)
```

**三件事**：

```
① insert / update / delete 的回傳型別是 int，值是【影響列數】。
   ★ 7.5.1 已經證明過：寫成 void 就放棄了唯一的錯誤訊號。

② useGeneratedKeys + keyProperty 才會把自增 id 寫回物件。
   ★ 它做的事是 JDBC 的 getGeneratedKeys()，跟 06 章 6.3.4 那個
     「IDENTITY 讓批次失效」是同一個機制。

③ 多值 INSERT 也能取回主鍵（keyProperty="rows.id"）。
   ★ 靠的是 MySQL 的 LAST_INSERT_ID() 加上「自增是連續的」這個性質。
   ⚠️ 而 innodb_autoinc_lock_mode = 2（interleaved）的時候
     多值 INSERT 拿到的 id 【不保證連續】—— 這一格在雲端託管的 MySQL 上要驗一次。
```

📌 **不是自增主鍵的時候用 `<selectKey>`**：

```xml
<insert id="insertWithSelectKey">
  <!-- order="BEFORE"：先取號再插入（Oracle 的 sequence、或自訂的號碼產生器） -->
  <selectKey keyProperty="orderNo" resultType="string" order="BEFORE">
    SELECT CONCAT('SO-', DATE_FORMAT(NOW(), '%Y%m%d'), '-',
                  LPAD(nextval, 6, '0')) FROM order_no_seq FOR UPDATE
  </selectKey>
  INSERT INTO orders (order_no, …) VALUES (#{orderNo}, …)
</insert>
```

⚠️ **`order="BEFORE"` vs `order="AFTER"`**：
`BEFORE` 是「先查號、再插入」（適合序列）；
`AFTER` 是「先插入、再查」（適合 `LAST_INSERT_ID()`，也就是 `useGeneratedKeys` 的手動版）。
**寫錯的下場：`BEFORE` 配 `LAST_INSERT_ID()` 會拿到【上一次】插入的 id。**

### 7.10.2 實測：UUID 主鍵根本沒有「取回」這件事

```java
    @Test
    void b_UUID_主鍵不需要取回() {
        head("7.10.2 UUID 主鍵：根本沒有「取回」這件事");
        clean();
        UUID id = Uuid7.next();
        showSql("insertUuid", () -> keys.insertUuid(id, "X", new BigDecimal("1.0000")));
        System.out.println("   id 從一開始就在 Java 這一側：" + id);
        System.out.println("   資料庫裡 " + keys.countUuid() + " 筆");
    }
```

**實測**：

```
── insertUuid → 1 句 SQL
   INSERT INTO uuid_row (id, code, amount) VALUES (?, ?, ?)
   id 從一開始就在 Java 這一側：01a07ff9-acea-7528-a486-63872342cf34
   資料庫裡 1 筆
```

> 📌 **這是 07 站 1.8.4 選 UUIDv7 的第五個理由**（06 章 6.3.4 是第四個）：
> **它讓「取回主鍵」這個問題消失，而且【不管用哪個框架】。**
>
> ```
> IDENTITY + JPA      → persist 就得立刻送 INSERT，批次完全失效（06 章 6.3.4）
> IDENTITY + MyBatis  → 要記得寫 useGeneratedKeys，忘了就是 null（7.10.1）
> UUIDv7（應用端指定） → 兩個框架都不需要做任何事
> ```

### 7.10.3 實測：收掉 06 章 6.6.10 —— 那句 `UPDATE` 長什麼樣

06 章 6.6.10 那三條規則（非 JPA 的寫入路徑要自己維護 `version`），
**這裡是它在 MyBatis 上的完整寫法**。

```java
    @Update("UPDATE orders SET status = #{status}, paid_at = #{paidAt} WHERE id = #{id}")
    int markPaid(@Param("id") UUID id, @Param("status") St7Status status,
                 @Param("paidAt") Instant paidAt);

    /** ✅ 06 章 6.6.10：旁路寫入必須自己維護 version。 */
    @Update("""
            UPDATE orders
               SET status = #{status}, version = version + 1
             WHERE id = #{id} AND version = #{version}
            """)
    int markPaidVersioned(@Param("id") UUID id, @Param("status") St7Status status,
                          @Param("version") long version);
```

**實測**：

```
   一開始 version = 0
   🔴 不維護 version 的寫法：
── markPaid → 1 句 SQL
   UPDATE orders SET status = ?, paid_at = ? WHERE id = ?
      改完 version = 0（沒有動）
   ✅ 維護 version 的寫法：
      影響 1 列
── markPaidVersioned（帶對的 version） → 1 句 SQL
   UPDATE orders SET status = ?, version = version + 1 WHERE id = ? AND version = ?
      改完 version = 1
   ── 帶一個過期的 version ──
      影響 0 列 → 這就是衝突（要自己拋例外）
      DB 現在的狀態：{status=PACKED, version=1}
```

**把它包成一個可以重用的形狀**：

```java
@Service
public class OrderCommandService {

    private final Ord7Mapper mapper;

    public OrderCommandService(Ord7Mapper mapper) { this.mapper = mapper; }

    /**
     * ★ 06 章 6.6.10 的三條規則，全部寫在這一個方法裡：
     *   ① version = version + 1
     *   ② WHERE 帶上讀到的 version
     *   ③ 影響 0 列 → 拋【跟 JPA 那一側同一個】例外，讓重試邏輯可以共用（06 章 6.6.2）
     */
    @Transactional
    public void markPaid(UUID id, long expectedVersion) {
        int rows = mapper.markPaidVersioned(id, St7Status.PAID, expectedVersion);
        if (rows == 0) {
            throw new org.springframework.orm.ObjectOptimisticLockingFailureException(
                    "orders", id);
        }
    }
}
```

> 📌 **注意那個例外的選擇**：
> `ObjectOptimisticLockingFailureException` 是 **Spring 的**，不是 JPA 的、也不是 MyBatis 的。
> **這讓 06 章 6.6.8 那個 `Retry6` 可以同時服務兩個框架的寫入路徑。**
>
> ⚠️ **而 7.14 會給一條斷言**：掃 mapper 裡所有對「有 `@Version` 的表」的 `UPDATE`，
> 沒有維護 `version` 的就讓建置失敗 —— 06 章 6.10.3 那條斷言的 MyBatis 版。

### 7.10.4 🔴🔴 實測：`ExecutorType.BATCH`

MyBatis 有三種 `Executor`：

```
SIMPLE （預設）  每一次呼叫開一個新的 PreparedStatement，執行、關掉
REUSE           重用同一句 SQL 的 PreparedStatement
BATCH           把同一句 SQL 的呼叫【攢起來】，等 flushStatements() 才送
```

⚠️ **`@Mapper` 注入進來的那個是 `SIMPLE`。** 要用 `BATCH` 得自己開一個 `SqlSession`：

```java
    /** ExecutorType.BATCH 要自己開 SqlSession —— @Mapper 注入進來的那個是 SIMPLE。 */
    private void batchInsert(List<SeqRow> data) {
        try (var session = sqlSessionFactory.openSession(
                org.apache.ibatis.session.ExecutorType.BATCH, false)) {
            KeyMapper m = session.getMapper(KeyMapper.class);
            for (SeqRow r : data) m.insertNoKey(r);
            session.flushStatements();      // ★ 送出攢著的那一批
            session.commit();
        }
    }

    /** BATCH executor，但每 50 筆 flush 一次（跟 06 章 6.3.10 同一個做法）。 */
    private void batchInsertChunked(List<SeqRow> data) {
        try (var session = sqlSessionFactory.openSession(
                org.apache.ibatis.session.ExecutorType.BATCH, false)) {
            KeyMapper m = session.getMapper(KeyMapper.class);
            int n = 0;
            for (SeqRow r : data) {
                m.insertNoKey(r);
                if (++n % 50 == 0) session.flushStatements();
            }
            session.flushStatements();
            session.commit();
        }
    }
```

**先在 `Base07` 那個 context（【沒有】 `rewriteBatchedStatements`）上量**：

```java
    @Test
    void d_批次執行器() {
        head("7.10.4c 同樣三種寫法，【沒有】 rewriteBatchedStatements");
        clean();
        int n = 1000;
        long t1 = timeOnly(data -> tx.executeWithoutResult(s -> data.forEach(keys::insertNoKey)), n);
        long t2 = timeOnly(this::batchInsert, n);
        long t3 = timeOnly(data -> keys.insertMany(data), n);
        keys.clearSeq();
        List<String> b = spy(() -> batchInsert(rows(n)));
        System.out.printf("   ① SIMPLE（一筆一句）           %4d ms%n", t1);
        System.out.printf("   ② BATCH（最後 flush 一次）      %4d ms   ← 🔴 比 ① 還慢%n", t2);
        System.out.printf("   ③ <foreach> 一句多值            %4d ms%n", t3);
        System.out.println("   ② 的 JDBC execute 次數 = " + b.size() + "（"
                + b.stream().distinct().toList() + "）");
    }

    private List<SeqRow> rows(int n) {
        List<SeqRow> l = new ArrayList<>(n);
        for (int i = 0; i < n; i++) l.add(new SeqRow("S", BigDecimal.ONE));
        return l;
    }

    /** ★ 把「準備資料」與「清表」放在計時之外。 */
    private long timeOnly(java.util.function.Consumer<List<SeqRow>> body, int n) {
        long best = Long.MAX_VALUE;
        for (int i = 0; i < 4; i++) {                 // 第一輪當暖機
            keys.clearSeq();
            List<SeqRow> data = rows(n);
            long t0 = System.nanoTime();
            body.accept(data);
            long ms = System.nanoTime() - t0;
            if (i > 0) best = Math.min(best, ms);
        }
        return best / 1_000_000;
    }
```

**實測（1000 筆，沒有 `rewriteBatchedStatements`）**：

```
   ① SIMPLE（一筆一句）            301 ms
   ② BATCH（最後 flush 一次）      1124 ms   ← 🔴 比 ① 還慢
   ③ <foreach> 一句多值              14 ms
   ② 的 JDBC execute 次數 = 1（[INSERT INTO seq_row (code, amount) VALUES (?, ?)   [batch ×1000]]）
```

> 🔴🔴 **`ExecutorType.BATCH` 比不批次【慢 3.7 倍】，而它的 JDBC `execute()` 只有 1 次。**

**現在把 06 章 6.3.7 那個 URL 參數加上去，同一段程式碼再跑一次**：

```java
@SpringBootTest(properties = {
  "spring.datasource.url=jdbc:mysql://127.0.0.1:33306/ch07?rewriteBatchedStatements=true"
      + "&connectionTimeZone=UTC&forceConnectionTimeZoneToSession=true"
      + "&preserveInstants=true&characterEncoding=UTF-8",
  "spring.jpa.properties.hibernate.generate_statistics=true"
})
class K5Batch extends Base07 { … }
```

**實測（同樣 1000 筆，只多了那個 URL 參數）**：

```
   ① SIMPLE（一筆一句）           execute 1000 次、 282 ms
   ② BATCH（最後才 flush 一次）    execute    1 次、  10 ms      ← 從 1124 變 10
   ③ BATCH（每 50 筆 flush）       execute   20 次、  35 ms
   ④ <foreach> 一句 1000 個 VALUES execute    1 次、  13 ms
```

**再問伺服器**（06 章 6.2.4 那第三把尺）：

```
   BATCH 一次 flush       → 伺服器剖析 1 句 INSERT（1000 列）
   BATCH 每 50 筆         → 伺服器剖析 20 句 INSERT（1000 列）
   <foreach> 一句         → 伺服器剖析 1 句 INSERT（1000 列）
```

> ★★ **`1124 ms → 10 ms`，112 倍，而 Java 那一側一個字都沒改。**
>
> **這是 06 章 6.3.7 那個結論在 MyBatis 上一字不差的重演**：
>
> ```
> JDBC 層的 batch（executeBatch）預設【只是把 N 句 SQL 攢起來，然後一句一句送】。
> 把它們合併成一句多值 INSERT 的，是 MySQL 驅動的 rewriteBatchedStatements。
> ```
>
> **而在 MyBatis 上它更戲劇化**：
> JPA 那一側沒開 rewrite 的時候是「快一點點」（198 → 153 ms，1.3 倍）；
> **MyBatis 這一側是「慢很多」（301 → 1124 ms）。**
>
> ⚠️ **所以「MyBatis 的批次很慢」這個印象，來源跟 06 章那個
> 「批次是玄學」的印象是同一個東西：兩件事只做了一件。**

📌 **`<foreach>` 那一版（③ / ④）為什麼在兩種組態下都是十幾毫秒**：
**因為它不依賴 JDBC 的 batch —— 它本來就是一句多值 `INSERT`**（7.10.1 實測看得到）。
**它是唯一一個「不管有沒有那個 URL 參數都快」的寫法。**

**四種寫法的決策表**：

| 寫法 | 要 `rewriteBatchedStatements` 嗎 | 1000 筆 | 適合 |
|---|---|---|---|
| ① 逐筆呼叫 mapper | — | 282～301 ms | 幾十筆以內 |
| ② `ExecutorType.BATCH`，一次 flush | 🔴 **必須** | 10 ms / 1124 ms | 大量、單一 SQL 形狀 |
| ③ `BATCH` + 每 N 筆 flush | 🔴 必須 | 35 ms | 同上，而且要控制記憶體 |
| ④ `<foreach>` 一句多值 | ❌ 不需要 | 13～14 ms | ✅ **預設選這個** |

⚠️ **④ 的兩個上限**：

```
① max_allowed_packet（預設 64 MB）—— 一句 SQL 太長會被拒絕。
   ★ 所以還是要分批：每 500 或 1000 筆組一句。
② 🔴 SQL 的形狀跟筆數綁定：insertMany(3 筆) 與 insertMany(1000 筆) 是【兩句不同的 SQL】。
   ★ 這正是 05 章 5.5.3 那個「in 子句的參數個數爆炸」——
     而 MyBatis 【沒有】 in_clause_parameter_padding 這種東西。
     修法：自己把批次大小固定（例如一律補到 500 筆，不足的用重複值填）。
```

📌 **`ExecutorType.BATCH` 還有兩個坑，08 章 8.7 會處理**：

```
① BATCH 模式下，insert / update 的【回傳值不是影響列數】——
   它是 Integer.MIN_VALUE（因為那一刻還沒送出去）。
   ⚠️ 所以 7.10.3 那個「影響 0 列 = 衝突」的判斷【在 BATCH 模式下完全不能用】。
② 它跟 Spring 的交易同步要小心：openSession() 開的是一個【獨立的】SqlSession，
   它【不參與】外面那個 Spring 交易（7.12）。
```

### 7.10.5 悲觀鎖：比 JPA 直白

06 章 6.7 花了整節講 `LockModeType` 對應到什麼 SQL。**在 MyBatis 上你直接寫**：

```java
    @Select("SELECT product_id, qty, reserved_qty, version FROM stock "
          + "WHERE product_id = #{id} FOR UPDATE")
    StockRow findForUpdate(@Param("id") UUID id);

    @Select("SELECT product_id, qty FROM stock WHERE qty > 0 "
          + "ORDER BY product_id LIMIT #{n} FOR UPDATE SKIP LOCKED")
    List<StockRow> claimBatch(@Param("n") int n);
```

| | JPA | MyBatis |
|---|---|---|
| `FOR UPDATE` | `find(…, PESSIMISTIC_WRITE)` 或 `@Lock` | 直接寫在 SQL 裡 |
| `NOWAIT` | `hint("jakarta.persistence.lock.timeout", 0)` | 直接寫 |
| `SKIP LOCKED` | `hint(…, -2)` | 直接寫 |
| **`FOR UPDATE OF <表>`** | 🔴 **表達不出來**（06 章 6.7.1） | ✅ 直接寫 |
| **等 n 秒** | 🔴 MySQL 上被靜默忽略（06 章 6.7.3） | 🔴 MySQL 沒有這個語法，兩邊一樣 |

> 📌 **這一格是 00 章 0.6.6 那條軸最清楚的展示**：
> **不能換方言，換到的是「這個資料庫的全部語法」。**
> 06 章 6.7.1 那個「`join fetch` + `for update` 會鎖到兩張表」的問題，
> 在 MyBatis 上只要寫 `FOR UPDATE OF o` 就解決了。

---

## 7.11 MyBatis 自己的一級快取

**這是這一章唯一一個「MyBatis 也有狀態」的地方，也是最容易出事的一節。**

### 7.11.1 實測：預設是開的

```java
    @Test
    void a_預設是開的嗎() {
        head("7.11.1 MyBatis 的一級快取：預設是開的嗎？");
        System.out.println("   localCacheScope     = " + mybatisConfig().getLocalCacheScope());
        System.out.println("   cacheEnabled（二級） = " + mybatisConfig().isCacheEnabled());
    }
```

**實測**：

```
   localCacheScope     = SESSION
   cacheEnabled（二級） = true
```

```
localCacheScope = SESSION   ← 一級快取【開著】，範圍是一個 SqlSession
                STATEMENT   ← 關掉（每一句查詢自己一份，查完就丟）

cacheEnabled = true         ← 二級快取的【總開關】是開的，
                              而它只對有寫 <cache/> 的 mapper 生效（08 章）
```

⚠️ **`cacheEnabled = true` 這一格跟 06 章 6.5.2 是同一種陷阱**：
**「總開關是開的」不等於「有東西被快取」。**
兩個框架都把「開關」與「宣告要快取什麼」分成兩件事，
**而兩個框架的「開關」預設值都是【開】。**

### 7.11.2 實測：沒有交易的時候

```java
    @Test
    void b_沒有交易的時候() {
        head("7.11.2 沒有交易：同一句查詢連呼叫兩次");
        seed(3, 1, 0);
        List<String> sqls = spy(() -> {
            var a = mapper.findByStatus(St7Status.PENDING);
            var b = mapper.findByStatus(St7Status.PENDING);
            System.out.println("   兩次都撈到 " + a.size() + " / " + b.size() + " 筆");
            System.out.println("   是同一個物件嗎？ " + (a.get(0) == b.get(0)));
        });
        System.out.println("   → " + sqls.size() + " 句 SQL");
    }
```

**實測**：

```
   兩次都撈到 3 / 3 筆
   是同一個物件嗎？ false
   → 2 句 SQL
   ★ 每一次 mapper 呼叫都是一個【新的 SqlSession】
```

### 7.11.3 ★ 實測：有交易的時候

```java
    @Test
    void c_有交易的時候() {
        head("7.11.3 ★ 有交易：同一句查詢連呼叫兩次");
        seed(3, 1, 0);
        List<String> sqls = spy(() -> tx.executeWithoutResult(s -> {
            var a = mapper.findByStatus(St7Status.PENDING);
            var b = mapper.findByStatus(St7Status.PENDING);
            System.out.println("   兩次都撈到 " + a.size() + " / " + b.size() + " 筆");
            System.out.println("   🔴 是同一個物件嗎？ " + (a.get(0) == b.get(0)));
        }));
        System.out.println("   → " + sqls.size() + " 句 SQL");
    }
```

**實測**：

```
   兩次都撈到 3 / 3 筆
   🔴 是同一個物件嗎？ true
   → 1 句 SQL
   ★ 交易期間整個共用一個 SqlSession → 一級快取生效
```

> ★ **同一段程式碼，有交易與沒交易的行為完全不同**：
>
> ```
> 沒有交易：2 句 SQL、兩個不同的物件
> 有交易：  1 句 SQL、【同一個物件】
> ```
>
> **機制在 `SqlSessionTemplate`**（7.3.2 ②）：
> ```
> 沒有交易 → 每次 mapper 呼叫：openSession() → 執行 → close()
> 有交易   → 第一次呼叫時開一個 SqlSession，【綁到交易上】，
>           交易結束才 close。整個交易期間所有 mapper 呼叫共用它。
> ```
>
> 📌 **而一級快取的 key 是**：
> ```
> MappedStatement 的 id + 參數 + RowBounds + 那句 SQL 的字串
> ```
> **注意它【不是】實體的 id**（對照 03 章 3.3.2 的 JPA 一級快取）——
> **它是「這一句查詢」的快取，不是「這一列資料」的快取。**

### 7.11.4 🔴 實測：它回傳同一個實例

```java
    @Test
    void d_同一個物件會被改到() {
        head("7.11.4 🔴 快取回傳的是【同一個實例】");
        seed(3, 1, 0);
        tx.executeWithoutResult(s -> {
            var a = mapper.findByStatus(St7Status.PENDING);
            a.get(0).setCustomerName("被我改掉了");            // 有人「順手」改了一下
            var b = mapper.findByStatus(St7Status.PENDING);    // 另一段程式碼再查一次
            System.out.println("   第二次查到的客戶名 = " + b.get(0).getCustomerName());
            System.out.println("   而資料庫裡是 " + jdbc.queryForObject(
                    "SELECT display_name FROM customer LIMIT 1", String.class));
        });
    }
```

**實測**：

```
   第二次查到的客戶名 = 被我改掉了
   而資料庫裡是 客戶0
```

> 🔴 **一段程式碼改了那個 POJO，另一段程式碼查到的就是被改過的值。**
>
> ⚠️ **這修正了 00 章 0.5.3 那張表的一句話**。那裡寫的是：
>
> ```
> 沒有「身分管理」→ 查兩次同一列，回來兩個【不同】的物件
> ```
>
> **這句話只在「跨 `SqlSession`」時成立**（也就是 7.11.2）。
> **在同一個交易裡，MyBatis 【有】身分管理，而且它比 JPA 的更危險 ——
> 因為沒有人預期它存在。**
>
> **對照 03 章那個 JPA 的一級快取**：
>
> | | JPA 一級快取 | MyBatis 一級快取 |
> |---|---|---|
> | key | **實體型別 + id** | **SQL 的 id + 參數** |
> | 快取的東西 | 一個【managed 實體】 | 一個【查詢的結果 List】 |
> | 改了它會怎樣 | ✅ **髒檢查會把它寫回資料庫**（那是設計） | 🔴 **不會寫回去，但會污染後續的查詢** |
> | 大家知道它存在嗎 | ✅ 知道（它是 JPA 的核心概念） | 🔴 **通常不知道** |
> | 怎麼清 | `em.clear()` / `em.refresh()` | 一次寫入（7.11.5）或 `flushCache="true"` |

**兩條規則**：

```
① 🔴 mapper 回傳的物件【當成不可變的】。要改就複製一份。
   ★ 最好的做法：DTO 用 record（7.8.5 證明過 MyBatis 支援）。
     record 沒有 setter，這個問題【從型別層面消失】。

② 🔴 不要把 mapper 回傳的物件直接傳給會修改它的程式碼。
   ★ 這跟 02 章 2.11 / 05 章 5.8.11 那條「出資料層的是 DTO」是同一條規則，
     只是理由不同：那裡是「實體不該離開交易」，
     這裡是「這個物件可能被別人共用」。
```

📌 **要關掉它**：

```yaml
mybatis:
  configuration:
    local-cache-scope: STATEMENT     # 每一句查詢自己一份，查完就丟
```

⚠️ **而本課【不建議】關掉它**，理由有兩個：
① 它在「同一個交易裡重複查同一件事」的情況下真的省 SQL；
② **關掉它不能解決 7.11.4 那個問題** —— 那個問題的根源是
「回傳可變的 POJO」，而不是快取。**用 `record` 才是解。**

### 7.11.5 實測：一次寫入清掉整個快取

```java
    @Test
    void e_寫入會清掉快取() {
        head("7.11.5 一次寫入會清掉整個 SqlSession 的快取");
        seed(3, 1, 0);
        UUID oid = orderIds.get(0);
        List<String> sqls = spy(() -> tx.executeWithoutResult(s -> {
            mapper.findByStatus(St7Status.PENDING);
            mapper.findByStatus(St7Status.PENDING);                 // 命中，0 句
            mapper.markPaid(oid, St7Status.PAID, Instant.now());    // ← 寫入
            var after = mapper.findByStatus(St7Status.PENDING);     // 重新查
            System.out.println("   寫入之後再查 → " + after.size() + " 筆（本來 3 筆）");
        }));
        System.out.println("   → " + sqls.size() + " 句 SQL");
        sqls.forEach(q -> System.out.println("      " + tail(q)));
    }
```

**實測**：

```
   寫入之後再查 → 2 筆（本來 3 筆）
   → 3 句 SQL
      … FROM orders o JOIN customer c ON c.id = o.customer_id WHERE o.status = ? ORDER BY o.placed_at
      UPDATE orders SET status = ?, paid_at = ? WHERE id = ?
      … FROM orders o JOIN customer c ON c.id = o.customer_id WHERE o.status = ? ORDER BY o.placed_at
```

**四次呼叫、3 句 SQL**：第二次查詢命中快取（0 句），寫入之後那次重新查了。

```
insert / update / delete 的 flushCache 預設是 true
   → 清掉【整個 SqlSession】的一級快取，不是只清那一張表
```

> 📌 **「清掉整個」是一個保守但正確的選擇**：
> MyBatis **不知道**你那句 `UPDATE` 動了哪張表
> （它只有一個 SQL 字串，沒有 03 章那個 query space 的概念）。
> **所以它只能全部清掉。**
>
> **對照 06 章 6.9.3 那個 auto-flush**：
> Hibernate 知道每一句查詢碰哪些表（因為它產生 SQL），所以它能做精確的判斷 ——
> **而那個「精確」正是 6.9.3 那個坑的來源**（跨表就不 flush）。
> **MyBatis 的粗糙在這件事上反而更安全。**

⚠️ **可以逐句覆寫**：

```java
@Select("SELECT CONNECTION_ID()")
@Options(flushCache = Options.FlushCachePolicy.TRUE)   // 每次都重新查
long connectionId();
```

```xml
<select id="alwaysFresh" flushCache="true" resultType="…">…</select>
```

📌 **什麼時候需要 `flushCache="true"` 在一個 `<select>` 上**：
那句查詢的結果**會在同一個交易裡改變**，而改變的原因不是 MyBatis 的寫入 ——
例如 7.11.6 那個情況。

### 7.11.6 🔴 實測：旁路寫入

```java
    @Test
    void f_旁路寫入會騙你() {
        head("7.11.6 🔴 交易裡有人用 JdbcTemplate 改了同一張表");
        seed(3, 1, 0);
        UUID oid = orderIds.get(0);
        tx.executeWithoutResult(s -> {
            System.out.println("   ① MyBatis 查 → "
                    + mapper.findByStatus(St7Status.PENDING).size() + " 筆");
            jdbc.update("UPDATE orders SET status = 'PAID' WHERE id = ?", Uuid7.toBytes(oid));
            System.out.println("   ② JdbcTemplate 改掉一張的狀態（同一個交易、同一條連線）");
            System.out.println("   🔴 ③ MyBatis 再查 → "
                    + mapper.findByStatus(St7Status.PENDING).size() + " 筆（快取還在）");
            System.out.println("      而直接問資料庫 → " + jdbc.queryForObject(
                    "SELECT count(*) FROM orders WHERE status = 'PENDING'", Long.class) + " 筆");
        });
    }
```

**實測**：

```
   ① MyBatis 查 → 3 筆
   ② JdbcTemplate 改掉一張的狀態（同一個交易、同一條連線）
   🔴 ③ MyBatis 再查 → 3 筆（快取還在）
      而直接問資料庫 → 2 筆
```

> 🔴 **同一個交易、同一條連線，MyBatis 讀到的是舊資料。**
>
> **這跟 06 章 6.5.11 是同一個形狀**（那裡是 JPA 的二級快取讀到舊值），
> **只是快取換了一個：**
>
> ```
> 06 章 6.5.11：MyBatis / JdbcTemplate 寫 → JPA 的【二級快取】不知道
> 03 章 3.3.4：  別的交易寫              → JPA 的【一級快取】不知道
> 本節：        JdbcTemplate 寫          → MyBatis 的【一級快取】不知道
>
> ★ 三個都是同一條規則的三個實例：
>   「快取是一個【假設沒有人繞過我】的機制。」
> ```
>
> ⚠️ **而這一格特別容易發生，因為它【在同一個交易裡】。**
> 前兩個至少要跨交易或跨框架的寫入才會出現；
> **這一個只要「同一個 Service 方法裡混用 mapper 與 `JdbcTemplate`」就會出現。**

**三種修法**：

```java
// ① 那句查詢加 flushCache="true"（最精準，但要記得）
@Options(flushCache = Options.FlushCachePolicy.TRUE)

// ② 不要混用。同一張表的讀寫走同一個 mapper（00 章 0.9 規則一的細粒度版）

// ③ 需要的時候手動清（很少用到，因為需要拿到 SqlSession）
sqlSessionTemplate.clearCache();
```

📌 **本課選 ②。** 理由跟 00 章 0.9 規則一一樣：
**「記得加某個註解」這種約定的壽命，等於寫下它的那個人待在團隊的時間。**

### 7.11.7 兩個一級快取的對照

| | JPA（03 章 3.3） | MyBatis（本節） |
|---|---|---|
| 範圍 | `EntityManager` = 一個交易 | `SqlSession` ＝ **有交易時是一個交易，沒交易時是一次呼叫** |
| key | 實體型別 + id | **SQL 的 id + 參數 + 分頁 + SQL 字串** |
| 存什麼 | managed 實體（含快照） | **查詢的結果物件** |
| `find(id)` 命中 | ✅ 0 句 SQL | ❌ **不會**（key 不是 id） |
| 同一句查詢查兩次 | 🟡 **會打 SQL，但回傳快取裡的物件**（3.3.3 ★★） | ✅ **0 句 SQL** |
| 改了回傳的物件 | ✅ 髒檢查寫回資料庫 | 🔴 污染後續查詢，但不寫回去 |
| 旁路寫入之後 | 🔴 讀到舊值（3.3.4） | 🔴 讀到舊值（7.11.6） |
| 怎麼關 | **關不掉**（3.3.7） | `local-cache-scope: STATEMENT` |

> ★ **第五列那個對比很有意思，而且它是兩個框架世界觀的直接後果**：
>
> ```
> JPA：  「我快取【實體】」→ 同一句 JPQL 查兩次會打兩次 SQL，
>        但第二次的結果會被一級快取裡的舊物件取代（03 章 3.3.3 那個 ★★）
>
> MyBatis：「我快取【查詢】」→ 同一句查兩次只打一次 SQL，
>        而不同的查詢即使碰同一列，也各自打一次
> ```
>
> **兩者都會「騙你」，而騙的方式剛好相反。**

---
## 7.12 跟 JPA 共用交易

00 章 0.9 那三條混用規則，這一節把**規則二**（JPA 寫完、MyBatis 讀之前要 `flush`）跑完整，
並補上它反過來的情況。

### 7.12.1 實測：四種組合

```java
    @Test
    void g_跟_JPA_共用交易() {
        head("7.12 JPA 與 MyBatis 在同一個交易裡");
        seed(2, 1, 0);
        UUID oid = orderIds.get(0);

        System.out.println("   ── 規則二（00 章 0.9）：JPA 寫完、MyBatis 讀之前要 flush ──");
        tx.executeWithoutResult(s -> {
            var o = em.find(com.example.lab.ch07.jpa.Ord7.class, oid);
            o.setMemo("JPA 改的");
            System.out.println("   🔴 沒有 flush，MyBatis 讀到的 memo = " + jdbc.queryForObject(
                    "SELECT memo FROM orders WHERE id = ?", String.class, (Object) Uuid7.toBytes(oid)));
            em.flush();
            System.out.println("   ✅ flush 之後 = " + jdbc.queryForObject(
                    "SELECT memo FROM orders WHERE id = ?", String.class, (Object) Uuid7.toBytes(oid)));
        });

        System.out.println("   ── 反過來：MyBatis 寫完、JPA 讀 ──");
        tx.executeWithoutResult(s -> {
            var o = em.find(com.example.lab.ch07.jpa.Ord7.class, oid);
            System.out.println("   JPA 先讀一次 memo = " + o.getMemo());
            mapper.markPaid(oid, St7Status.SHIPPED, Instant.now());
            System.out.println("   MyBatis 改成 SHIPPED 之後，JPA 手上那個物件的 status = "
                    + o.getStatus() + " 🔴（一級快取，03 章 3.3.3）");
            em.refresh(o);
            System.out.println("   em.refresh(o) 之後 = " + o.getStatus());
        });

        System.out.println("   ── 一起回滾 ──");
        String before = jdbc.queryForObject("SELECT status FROM orders WHERE id = ?",
                String.class, (Object) Uuid7.toBytes(oid));
        Throwable err = catchingTx(() -> {
            mapper.markPaid(oid, St7Status.DELIVERED, Instant.now());
            System.out.println("   交易裡 MyBatis 改成 DELIVERED、影響 1 列，然後拋例外");
            throw new IllegalStateException("故意炸");
        });
        String after = jdbc.queryForObject("SELECT status FROM orders WHERE id = ?",
                String.class, (Object) Uuid7.toBytes(oid));
        System.out.println("   " + name(err) + " → status：" + before + " → " + after
                + "（" + (before.equals(after) ? "✅ 回滾了" : "🔴 沒有回滾") + "）");
    }
```

**實測**：

```
   ── 規則二（00 章 0.9）：JPA 寫完、MyBatis 讀之前要 flush ──
   🔴 沒有 flush，MyBatis 讀到的 memo = null
   ✅ flush 之後 = JPA 改的
   ── 反過來：MyBatis 寫完、JPA 讀 ──
   JPA 先讀一次 memo = JPA 改的
   MyBatis 改成 SHIPPED 之後，JPA 手上那個物件的 status = PENDING 🔴（一級快取，03 章 3.3.3）
   em.refresh(o) 之後 = SHIPPED
   ── 一起回滾 ──
   交易裡 MyBatis 改成 DELIVERED、影響 1 列，然後拋例外
   IllegalStateException → status：SHIPPED → SHIPPED（✅ 回滾了）
```

**四種組合的完整表**（00 章 0.9 規則二承諾「09 章 9.5 會把四種組合列全」，這裡先給前四格）：

| 誰先做什麼 | 症狀 | 修法 |
|---|---|---|
| **JPA 寫 → MyBatis 讀** | 🔴 MyBatis 讀不到（那次修改還在持久化情境裡） | `em.flush()`，或讓 JPA 的寫入在另一個方法裡（讓交易邊界幫你 flush） |
| **MyBatis 寫 → JPA 讀（同一列）** | 🔴 JPA 讀到快取裡的舊物件 | `em.refresh(o)` 或 `em.clear()` |
| **MyBatis 寫 → JPA 讀（沒讀過的列）** | ✅ 正常（一級快取裡沒有它） | — |
| **兩邊都寫、然後回滾** | ✅ 一起回滾 | — |

📌 **第一格為什麼是「讀不到」而不是「讀到舊值」**：
那張訂單的 `memo` 本來是 `null`，JPA 改成 `"JPA 改的"` **但還沒 flush**——
所以資料庫裡還是 `null`。**MyBatis 讀的是資料庫，它讀到 `null` 是完全正確的行為。**

⚠️ **而 03 章 3.7.2 那個 auto-flush 在這裡【幫不上忙】**：
auto-flush 只在**透過 Hibernate 執行查詢**時才會觸發。
`JdbcTemplate` 與 MyBatis 的查詢**不經過 Hibernate**，所以它完全不知道要 flush。

> 📌 **這一格是 00 章 0.9 規則二存在的全部理由**，而它有一個更好的版本：
>
> ```
> 規則二（原版）：JPA 寫完、MyBatis 讀之前要 flush
> 規則二（更好）：【不要在同一個交易裡讓兩個框架碰同一張表】
> ```
>
> 因為「記得 flush」是一個約定，而**約定會被下一個人破壞**。
> 而 7.15 的做法是**讓 MyBatis 只讀那些「JPA 在這個交易裡不會寫」的東西**——
> 也就是「查詢側」與「寫入側」在**用例層級**分開，不只是在表層級。

### 7.12.2 實測：它們真的用同一條連線嗎

```java
    @Test
    void h_連線是不是同一條() {
        head("7.12.2 它們真的用同一條連線嗎？");
        seed(1, 1, 0);
        tx.executeWithoutResult(s -> {
            // ★ 問 MySQL 自己：這一句是哪一條連線送來的
            long viaJpa = em.createNativeQuery("SELECT CONNECTION_ID()")
                            .getSingleResult() instanceof Number n ? n.longValue() : -1;
            long viaJdbc = jdbc.queryForObject("SELECT CONNECTION_ID()", Long.class);
            long viaMyBatis = mapper.connectionId();
            System.out.println("   JPA     的 CONNECTION_ID() = " + viaJpa);
            System.out.println("   JDBC    的 CONNECTION_ID() = " + viaJdbc);
            System.out.println("   MyBatis 的 CONNECTION_ID() = " + viaMyBatis);
            System.out.println("   三者同一條？ " + (viaJpa == viaJdbc && viaJdbc == viaMyBatis));
        });
    }
```

**實測**：

```
   JPA     的 CONNECTION_ID() = 2637
   JDBC    的 CONNECTION_ID() = 2637
   MyBatis 的 CONNECTION_ID() = 2637
   三者同一條？ true
```

> 📌 **這個實驗值得學會，因為它是排查混用問題的第一步。**
> **不要比較 Java 那一側的 `Connection` 物件** —— 那裡有三層代理
> （Hikari 的、datasource-proxy 的、Spring 的），
> **比出來永遠是 `false`，而那個 `false` 什麼都不代表。**
> **要問資料庫自己。**

**機制**：三者都從 Spring 的 `TransactionSynchronizationManager` 拿連線。

```
DataSourceTransactionManager / JpaTransactionManager
   → 交易開始時從 DataSource 拿一條連線，綁到 ThreadLocal
   ↓
   ├─ Hibernate           經由 SpringSessionSynchronization
   ├─ JdbcTemplate        經由 DataSourceUtils.getConnection()
   └─ SqlSessionTemplate  經由 SpringManagedTransaction → DataSourceUtils
                          ★ 這是 mybatis-spring 的核心：它【不自己管交易】
```

⚠️ **兩個會破壞這件事的寫法**：

```java
// ① 自己 openSession（7.10.4 的 BATCH 就是）→ 它【不參與】外面那個交易
try (var s = sqlSessionFactory.openSession(ExecutorType.BATCH, false)) { … }
//                                                            ↑ autoCommit = false，
//                                                              而它是【另一條連線、另一個交易】

// ② @Transactional(propagation = REQUIRES_NEW) → 那是另一條連線（03 章 3.9.4）
```

📌 **① 那個坑在 7.10.4 是刻意的**（批次匯入本來就該是獨立交易），
**而它在別的場合是災難**：外面的交易回滾了，那個 `BATCH` session 已經 commit 了。
**要讓 BATCH 參與外面的交易，得用 `SqlSessionTemplate` 的
`ExecutorType` 建構子並讓它走 Spring 的交易同步** ——
或者更簡單：**用 `<foreach>`（7.10.4 ④），它不需要另一個 session。**

---

## 7.13 XML vs 註解

### 7.13.1 實測：同一個方法兩邊都寫會怎樣

```java
    @Test
    void e_註解跟_XML_能不能同時定義() {
        head("7.13.1 同一個方法，註解與 XML 都寫了會怎樣");
        var cfg = mybatisConfig();
        System.out.println("   Ord7Mapper.findByStatus 來源 = "
                + cfg.getMappedStatement("com.example.lab.ch07.Ord7Mapper.findByStatus").getResource());
        System.out.println("   Ord7XmlMapper.listByStatus 來源 = "
                + cfg.getMappedStatement("com.example.lab.ch07.Ord7XmlMapper.listByStatus").getResource());
    }
```

**實測**：

```
   Ord7Mapper.findByStatus 來源 = com/example/lab/ch07/Ord7Mapper.java (best guess)
   Ord7XmlMapper.listByStatus 來源 = file [/…/target/classes/mapper/Ord7XmlMapper.xml]
```

**兩種可以共存（不同的方法各用一種），而同一個方法兩邊都寫會在【啟動時】失敗**：

```
java.lang.IllegalArgumentException:
  Mapped Statements collection already contains value for
  com.example.lab.ch07.Ord7Mapper.findByStatus. please check
  com/example/lab/ch07/Ord7Mapper.java (best guess) and mapper/Ord7Mapper.xml
```

> ✅ **這是 MyBatis 少數幾個「啟動時就擋下來」的錯誤**，值得記住。

### 7.13.2 選擇的判準

| | 註解（`@Select` 等） | XML |
|---|---|---|
| SQL 在哪 | 跟方法在一起 | 另一個檔案 |
| 動態 SQL | 🟡 要包 `<script>`，很難讀 | ✅ **它的主場**（08 章） |
| 巢狀 `resultMap` | 🔴 `@Results` + `@Many` 寫起來非常痛 | ✅ |
| `<sql>` 片段共用 | 🔴 沒有 | ✅ |
| 長 SQL | 🟡 Java 21 有 `"""`，比以前好很多 | ✅ |
| 找 SQL 在哪一行 | 🔴 `(best guess)` | ✅ 完整路徑 |
| IDE 的 SQL 語法高亮 | 🟡 看 IDE | ✅ |
| 重構（改方法名） | ✅ IDE 會一起改 | 🔴 **XML 裡那個 id 不會跟著改** |

**本課的規則**：

```
① 簡單、固定的 SQL（尤其 count / exists / 單筆查詢）→ 註解
② 有動態部分、有巢狀映射、SQL 超過十行         → XML
③ 🔴 不要為了「統一風格」把 ② 硬塞進註解 ——
   一個包在 <script> 裡的 <foreach> 寫在 Java 字串裡，是這個生態系裡最難讀的東西。
④ 🔴 也不要為了「統一風格」把 ① 塞進 XML ——
   為了一句 SELECT count(*) 開一個 XML 檔案不值得。
```

⚠️ **表格最後一列是唯一一個「註解真的贏」的地方，而它很重要**：
XML 裡那個 `id="listByStatus"` 跟介面方法名是**字串比對**（7.4.2）。
**改方法名 → 啟動一樣成功 → 呼叫時 `BindingException`。**
**7.14 那條斷言就是為了它。**

---

## 7.14 把這一章變成 CI 會擋下來的東西

MyBatis 把三種錯誤推遲到執行期（7.4.5），**而其中兩種可以在啟動時抓回來。**

### 7.14.1 斷言一：每一個 mapper 方法都要有對應的 statement

```java
package com.example.lab.ch07;

import org.apache.ibatis.session.SqlSessionFactory;
import org.springframework.beans.factory.annotation.Autowired;

import java.util.ArrayList;
import java.util.List;

/**
 * 7.14.1：把 7.4.5 那個「呼叫時才炸」拉回【啟動時】。
 *
 * ★ 做法：掃所有 @Mapper 介面的方法，逐一去註冊表裡找對應的 MappedStatement。
 *   找不到就是 XML 的 id 打錯、或者方法被改名而 XML 沒跟著改（7.13.2）。
 */
public final class MapperSanity {

    private MapperSanity() {}

    public static List<String> unboundMethods(SqlSessionFactory factory, String packagePrefix) {
        var cfg = factory.getConfiguration();
        List<String> bad = new ArrayList<>();
        for (Class<?> mapperType : cfg.getMapperRegistry().getMappers()) {
            if (!mapperType.getName().startsWith(packagePrefix)) continue;
            for (var m : mapperType.getDeclaredMethods()) {
                if (m.isDefault() || m.isSynthetic()) continue;
                String id = mapperType.getName() + "." + m.getName();
                if (!cfg.hasStatement(id, false)) bad.add(id);
            }
        }
        return bad;
    }

    /** 斷言二：寫入方法的回傳型別不准是 void（7.5.1 那個「連 0 列都看不到」）。 */
    public static List<String> voidWrites(SqlSessionFactory factory, String packagePrefix) {
        var cfg = factory.getConfiguration();
        List<String> bad = new ArrayList<>();
        for (String id : cfg.getMappedStatementNames()) {
            if (!id.startsWith(packagePrefix) || !id.contains(".")) continue;
            org.apache.ibatis.mapping.MappedStatement ms;
            try { ms = cfg.getMappedStatement(id); } catch (Exception e) { continue; }
            if (ms.getSqlCommandType() == org.apache.ibatis.mapping.SqlCommandType.SELECT) continue;
            String cls = id.substring(0, id.lastIndexOf('.'));
            String method = id.substring(id.lastIndexOf('.') + 1);
            try {
                Class<?> t = Class.forName(cls);
                for (var m : t.getDeclaredMethods()) {
                    if (m.getName().equals(method) && m.getReturnType() == void.class) bad.add(id);
                }
            } catch (Exception ignore) {}
        }
        return bad;
    }
}
```

```java
    @Test
    void 每一個_mapper_方法都要能對上一句_SQL() {
        var bad = MapperSanity.unboundMethods(sqlSessionFactory, "com.example.lab.ch07");
        if (!bad.isEmpty()) throw new AssertionError(
                "這些方法在 XML / 註解裡找不到對應的 statement（7.4.5）：" + bad);
    }

    @Test
    void 寫入方法不准回傳_void() {
        var bad = MapperSanity.voidWrites(sqlSessionFactory, "com.example.lab.ch07");
        if (!bad.isEmpty()) throw new AssertionError(
                "這些寫入方法回傳 void，放棄了唯一的錯誤訊號（7.5.1）：" + bad);
    }
```

⚠️ **注意 `cfg.hasStatement(id, false)` 那個 `false`**：
它的意思是「**不要嘗試載入還沒解析完的 statement**」。
用 `true`（預設）的話，有些情況下它會回報「有」而實際上那個 statement 是壞的。

📌 **這條斷言抓得到 7.13.2 那個坑**：
有人用 IDE 改了介面的方法名，XML 裡的 `id` 沒跟著改 ——
**建置失敗，而不是上線之後某個 API 爆 500。**

### 7.14.2 斷言二：讀寫分離的邊界

```java
    /**
     * 7.14.2：MyBatis 這一側【只准讀】。
     * ★ 掃 MappedStatement 的 SqlCommandType —— 比讀 XML 可靠，
     *   因為它掃的是【執行期真的註冊了什麼】。
     */
    private void assertOnlySelect() {
        var cfg = sqlSessionFactory.getConfiguration();
        List<String> writes = cfg.getMappedStatementNames().stream()
                .filter(n -> n.startsWith("com.example.lab.shop."))
                .distinct()
                .filter(n -> {
                    try {
                        return cfg.getMappedStatement(n).getSqlCommandType()
                                != org.apache.ibatis.mapping.SqlCommandType.SELECT;
                    } catch (Exception e) { return false; }
                })
                .sorted().toList();
        System.out.println("   shop.mybatis 裡非 SELECT 的 statement：" + writes
                + (writes.isEmpty() ? "  ✅" : "  🔴"));
    }
```

**實測**：

```
   shop.mybatis 裡非 SELECT 的 statement：[]  ✅
```

> 📌 **這是 00 章 0.9 規則一（「同一張表只讓一個框架寫」）第一次變成一條可執行的斷言。**
> 而它的形狀值得注意：**它斷言的不是「SQL 對不對」，是「這個套件的職責邊界」。**
> 跟 05 章 5.13.2（「查詢不准寫在 Service 裡」）是同一類斷言。

### 7.14.3 斷言三：旁路寫入要維護 `version`

**06 章 6.10.3 那條斷言的 MyBatis 版**，而它在 MyBatis 上**比在 JPA 上好做**——
因為 SQL 都在 `MappedStatement` 裡，不需要掃原始碼。

```java
    @Test
    void 旁路寫入必須維護_version() {
        var cfg = sqlSessionFactory.getConfiguration();
        // ① 哪些表有 @Version（問 JPA 的 metamodel，06 章 6.10.2）
        Set<String> versioned = emf.getMetamodel().getEntities().stream()
                .filter(e -> hasVersion(e.getJavaType()))
                .map(e -> {
                    var t = e.getJavaType().getAnnotation(jakarta.persistence.Table.class);
                    return (t != null ? t.name() : e.getName()).toLowerCase();
                })
                .collect(java.util.stream.Collectors.toSet());

        // ② 掃 MyBatis 的每一句 UPDATE
        List<String> bad = new ArrayList<>();
        for (String id : cfg.getMappedStatementNames()) {
            if (!id.startsWith("com.example.lab")) continue;
            org.apache.ibatis.mapping.MappedStatement ms;
            try { ms = cfg.getMappedStatement(id); } catch (Exception e) { continue; }
            if (ms.getSqlCommandType() != org.apache.ibatis.mapping.SqlCommandType.UPDATE) continue;
            String sql = ms.getBoundSql(new org.apache.ibatis.binding.MapperMethod.ParamMap<>())
                           .getSql().toLowerCase().replaceAll("\\s+", " ");
            for (String table : versioned) {
                if (sql.contains("update " + table) && !sql.contains("version")) {
                    bad.add(id + " → " + cut(sql));
                }
            }
        }
        bad.forEach(b -> System.out.println("   🔴 " + b));
        System.out.println("   → " + (bad.isEmpty() ? "✅ 沒有違例" : bad.size() + " 處違例"));
    }
```

📌 **它比 06 章 6.10.3 那個「掃原始碼」的版本好三點**：

```
① 它掃的是【執行期真的註冊了什麼】，不是原始碼的字串 —— 註解與 XML 都掃到。
② 動態 SQL（<if> / <set>）展開後的樣子也掃得到（getBoundSql 會展開）。
③ 它不會有「註解裡的 SQL 被誤判」這種偽陽性。
```

⚠️ **而它有一個 06 章那個版本沒有的限制**：
`getBoundSql(空參數)` 對含 `<if test="...">` 的動態 SQL **可能展開不完整**
（條件為 false 的分支不會出現）。
**所以它是一個「抓得到大部分」的檢查，不是一個完備的證明。**
📌 **08 章 8.4 講完動態 SQL 之後會給一個更完整的版本。**

### 7.14.4 斷言四：每一個查詢的每一個欄位都不是 null

**這是 7.8.1 那個「靜默 null」唯一有效的防線。**

```java
    /**
     * 7.14.4：一個查詢的結果，【每一個欄位都要有值】。
     * ★ 它抓的是「SQL 忘了寫別名」、「欄位改名了」這一類
     *   自動映射靜默失敗的情況（7.8.1）。
     *
     * ⚠️ 它只適用於「這個查詢的每一個欄位在測試資料上都不該是 null」的情況。
     *    真的可以為 null 的欄位（memo、paid_at）要明確排除。
     */
    static <T> void assertNoNullFields(T obj, String... allowNull) {
        var allowed = java.util.Set.of(allowNull);
        for (var f : obj.getClass().getDeclaredFields()) {
            if (java.lang.reflect.Modifier.isStatic(f.getModifiers())) continue;
            if (allowed.contains(f.getName())) continue;
            try {
                f.setAccessible(true);
                if (f.get(obj) == null) throw new AssertionError(
                        obj.getClass().getSimpleName() + "." + f.getName()
                        + " 是 null —— SQL 的別名對不上屬性名嗎？（7.8.1）");
            } catch (IllegalAccessException ignore) {}
        }
    }
```

```java
    @Test
    void 列表頁的每一個欄位都要有值() {
        seed(3, 1, 1);
        String no = mapper.findAllOrderNos().get(0);
        assertNoNullFields(mapper.findOne(no));                 // ✅ 通過
        // assertNoNullFields(mapper.findOneNoAlias(no));       // 🔴 customerName 是 null
    }
```

### 7.14.5 四條斷言的分工

| 斷言 | 抓什麼 | 什麼時候跑 |
|---|---|---|
| **7.14.1** 每個方法都有 statement | XML 的 id 打錯、方法改名 | **啟動 / 建置** |
| **7.14.2** 只准 SELECT | 有人在查詢側加了寫入 | 建置 |
| **7.14.3** 旁路寫入維護 `version` | 有人繞過 JPA 的樂觀鎖（06 章 6.6.10） | 建置 |
| **7.14.4** 欄位不准是 null | SQL 忘了別名、欄位改名（7.8.1） | **每個查詢一個測試** |

> 📌 **對照前面各章那五把尺**（`SqlSpy` / `PcSpy` / `NPlus1Spy` / `ReadOnlySpy` / `CacheSpy`）：
>
> ```
> 01～06 章的斷言問的是：「這段程式碼的【行為】對不對？」（幾句 SQL、幾個實體、帳對不對）
> 07 章的斷言問的是：  「這段程式碼【接得起來】嗎？」（方法對得上 SQL 嗎、欄位對得上屬性嗎）
> ```
>
> **這個差別直接來自 7.4.5 那張表**：
> **JPA 的錯誤大多在啟動時就被擋下來，所以它的斷言可以專心看行為；**
> **MyBatis 沒有那道防線，所以它的斷言要先把那道防線補回來。**

---

## 7.15 shop-service 的落地

### 7.15.1 這一章的改動

00 章 0.8.4 的決定是：

> **「報表與列表查詢用 MyBatis，寫入與領域邏輯用 JPA。」**

**這一節是那個決定的落地，而它只加了一個套件、沒有動任何既有的東西。**

```
com.example.lab.shop            ← 01～06 章的成品（實體、Service、Repository）
com.example.lab.shop.mybatis    ← ★ 本章新增：【只有讀】
   ├─ OrderQueryMapper          （介面）
   ├─ CustomerSalesRow          （報表的結果形狀）
   └─ StatusPivotRow            （樞紐表的結果形狀）
resources/mapper/
   └─ OrderQueryMapper.xml
```

```java
package com.example.lab.shop.mybatis;

import com.example.lab.shop.OrderListRow;
import com.example.lab.shop.OrderStatus;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.time.Instant;
import java.util.List;

/**
 * 07 章 7.15：shop-service 的查詢側，MyBatis 版。
 *
 * ★ 00 章 0.8.4 的決定是「報表與列表查詢用 MyBatis」。這個介面是那個決定的落地。
 * ★ 它【只有讀】—— 00 章 0.9 規則一：同一張表只讓一個框架寫，而寫的那一邊是 JPA。
 *   （7.14.2 那條斷言就是在守這件事。）
 *
 * ⚠️ 回傳型別刻意用 05 章那個 OrderListRow（record）：
 *    同一個 DTO，兩個框架都填得出來 —— 09 章要拿它做對照。
 */
@Mapper
public interface OrderQueryMapper {

    /** 跟 05 章 5.14.2 的 OrderRepository.listRows 同一個結果形狀。 */
    List<OrderListRow> listRows(@Param("status") OrderStatus status,
                                @Param("offset") int offset,
                                @Param("size") int size);

    long countByStatus(@Param("status") OrderStatus status);

    /**
     * 報表：每個客戶的訂單數、總金額、以及【在全體裡的排名】。
     * ★ 窗口函式 —— 05 章 5.4.8 證明過 JPQL 規格沒有它（HQL 有，而 HQL 不是 JPQL）。
     *   這是「該交給 MyBatis」的第一類查詢。
     */
    List<CustomerSalesRow> salesRanking(@Param("from") Instant from, @Param("to") Instant to);

    /**
     * 報表：狀態 × 月份的樞紐表。
     * ★ 一句 SQL 產生一個【橫向展開】的結果 —— 沒有實體對得上它。
     */
    List<StatusPivotRow> statusPivot();
}
```

```java
package com.example.lab.shop.mybatis;

import java.math.BigDecimal;
import java.util.UUID;

/**
 * 07 章 7.15 的報表結果。
 * ★ 它不對應任何一張表，也不對應任何一個實體 —— 它對應【那一句 SQL 的形狀】（00 章 0.5.2）。
 */
public record CustomerSalesRow(UUID customerId, String customerName,
                               long orderCount, BigDecimal totalAmount,
                               long rank, BigDecimal pctOfTotal) {}
```

```java
package com.example.lab.shop.mybatis;

import java.math.BigDecimal;

/** 狀態 × 月份的樞紐表。欄位是【橫向展開】的，沒有實體對得上。 */
public record StatusPivotRow(String ym, long pending, long paid, long cancelled,
                             BigDecimal pendingAmount, BigDecimal paidAmount) {}
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN"
        "https://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="com.example.lab.shop.mybatis.OrderQueryMapper">

  <!-- ═══ 列表頁：跟 05 章 5.14.2 的 listRows 同一個形狀 ═══ -->
  <!-- ★ OrderListRow 是 record，沒有 setter → 走 <constructor>（7.8.4） -->
  <!-- 🔴 itemCount 是 long（原始型別）→ javaType 要寫 _long，不是 long（7.8.5） -->
  <resultMap id="listRowMap" type="com.example.lab.shop.OrderListRow">
    <constructor>
      <idArg column="id"            javaType="java.util.UUID"/>
      <arg   column="order_no"      javaType="java.lang.String"/>
      <arg   column="customer_name" javaType="java.lang.String"/>
      <arg   column="status"        javaType="com.example.lab.shop.OrderStatus"/>
      <arg   column="total_amount"  javaType="java.math.BigDecimal"/>
      <arg   column="placed_at"     javaType="java.time.Instant"/>
      <arg   column="item_count"    javaType="_long"/>
    </constructor>
  </resultMap>

  <select id="listRows" resultMap="listRowMap">
    SELECT o.id, o.order_no, c.display_name AS customer_name, o.status,
           o.total_amount, o.placed_at,
           (SELECT count(*) FROM order_item i WHERE i.order_id = o.id) AS item_count
      FROM orders o
      JOIN customer c ON c.id = o.customer_id
     WHERE o.status = #{status}
     ORDER BY o.placed_at DESC
     LIMIT #{size} OFFSET #{offset}       <!-- ★ 分頁寫在 SQL 裡，不用 RowBounds（7.9.4）-->
  </select>

  <select id="countByStatus" resultType="long">
    SELECT count(*) FROM orders WHERE status = #{status}
  </select>

  <!-- ═══ 報表一：CTE + 窗口函式（JPQL 規格沒有，05 章 5.4.8）═══ -->
  <resultMap id="salesMap" type="com.example.lab.shop.mybatis.CustomerSalesRow">
    <constructor>
      <idArg column="customer_id"   javaType="java.util.UUID"/>
      <arg   column="customer_name" javaType="java.lang.String"/>
      <arg   column="order_count"   javaType="_long"/>
      <arg   column="total_amount"  javaType="java.math.BigDecimal"/>
      <arg   column="rnk"           javaType="_long"/>
      <arg   column="pct_of_total"  javaType="java.math.BigDecimal"/>
    </constructor>
  </resultMap>

  <select id="salesRanking" resultMap="salesMap">
    WITH per_customer AS (
      SELECT c.id                AS customer_id,
             c.display_name      AS customer_name,
             count(*)            AS order_count,
             sum(o.total_amount) AS total_amount
        FROM orders o
        JOIN customer c ON c.id = o.customer_id
       WHERE o.placed_at &gt;= #{from}
         AND o.placed_at &lt;  #{to}
         AND o.status &lt;&gt; 'CANCELLED'
       GROUP BY c.id, c.display_name
    )
    SELECT customer_id, customer_name, order_count, total_amount,
           RANK() OVER (ORDER BY total_amount DESC)                       AS rnk,
           ROUND(100 * total_amount / SUM(total_amount) OVER (), 2)       AS pct_of_total
      FROM per_customer
     ORDER BY rnk
  </select>

  <!-- ═══ 報表二：樞紐表 ═══ -->
  <resultMap id="pivotMap" type="com.example.lab.shop.mybatis.StatusPivotRow">
    <constructor>
      <idArg column="ym"             javaType="java.lang.String"/>
      <arg   column="pending"        javaType="_long"/>
      <arg   column="paid"           javaType="_long"/>
      <arg   column="cancelled"      javaType="_long"/>
      <arg   column="pending_amount" javaType="java.math.BigDecimal"/>
      <arg   column="paid_amount"    javaType="java.math.BigDecimal"/>
    </constructor>
  </resultMap>

  <select id="statusPivot" resultMap="pivotMap">
    SELECT DATE_FORMAT(placed_at, '%Y-%m')                                AS ym,
           SUM(status = 'PENDING')                                        AS pending,
           SUM(status = 'PAID')                                           AS paid,
           SUM(status = 'CANCELLED')                                      AS cancelled,
           COALESCE(SUM(CASE WHEN status = 'PENDING' THEN total_amount END), 0) AS pending_amount,
           COALESCE(SUM(CASE WHEN status = 'PAID'    THEN total_amount END), 0) AS paid_amount
      FROM orders
     GROUP BY ym
     ORDER BY ym
  </select>
</mapper>
```

⚠️ **XML 裡的 `>=` 與 `<` 要寫成 `&gt;=` 與 `&lt;`**。
這是 XML 的規則，不是 MyBatis 的。**忘了的下場是啟動時解析失敗**（好事）。
📌 **或者用 `<![CDATA[ … ]]>` 包起來**——而那樣裡面就不能有 `<if>` 了。

### 7.15.2 實測：同一個列表頁，兩個框架

**這一節的測試類別跟 `Base07` 不同 context**（它連 `shop` 庫），所以量尺要自己接：

```java
@SpringBootTest(properties = {
  "spring.datasource.url=jdbc:mysql://127.0.0.1:33306/shop?connectionTimeZone=UTC"
      + "&forceConnectionTimeZoneToSession=true&preserveInstants=true&characterEncoding=UTF-8",
  "spring.jpa.properties.hibernate.generate_statistics=true"
})
class L1Shop {

    @Autowired EntityManagerFactory emf;
    @Autowired JdbcTemplate jdbc;
    @Autowired TransactionTemplate tx;
    @Autowired OrderService orders;              // JPA 那一側（05 章 5.14、06 章 6.11）
    @Autowired OrderQueryMapper query;           // MyBatis 那一側（本章）
    @Autowired org.apache.ibatis.session.SqlSessionFactory sqlSessionFactory;

    /** ★ 05 章 5.13.3 那把尺：這個用例建了幾個實體。 */
    private long entityLoad() {
        return emf.unwrap(org.hibernate.SessionFactory.class).getStatistics().getEntityLoadCount();
    }

    private void resetStats() {
        emf.unwrap(org.hibernate.SessionFactory.class).getStatistics().clear();
    }

    private List<String> spy(Runnable r) {
        SqlSpy.start();
        try { r.run(); return SqlSpy.stop(); }
        catch (RuntimeException | Error e) { SqlSpy.stop(); throw e; }
    }

    private void head(String t) { System.out.println("\n═══ " + t + " ═══"); }
    private static String cut(String s) { return s.length() > 130 ? s.substring(0, 130) + "…" : s; }

    /** 06 章 6.10.2 那個「有沒有 @Version」的檢查，這裡也要用。 */
    private static boolean hasVersion(Class<?> t) {
        for (Class<?> k = t; k != null && k != Object.class; k = k.getSuperclass())
            for (var f : k.getDeclaredFields())
                if (f.isAnnotationPresent(jakarta.persistence.Version.class)) return true;
        return false;
    }

    // …（seed 跟 Base07 的一樣，只是塞的是 shop 庫那五張表，這裡略）…
}
```

```java
    @Test
    void a_同一頁兩個框架() {
        head("7.15.1 同一個列表頁，JPA 投影 vs MyBatis");
        seed(200, 20, 2);

        resetStats();
        List<String> a = spy(() -> {
            var rows = orders.list(OrderStatus.PENDING, 0, 20);
            System.out.println("   JPA 投影（05 章 5.14）→ " + rows.size() + " 筆");
            System.out.println("      第一列：" + rows.get(0));
        });
        System.out.println("   → " + a.size() + " 句 SQL、建了 " + entityLoad() + " 個實體");
        a.forEach(q -> System.out.println("      " + cut(q)));

        resetStats();
        List<String> b = spy(() -> {
            var rows = query.listRows(OrderStatus.PENDING, 0, 20);
            System.out.println("   MyBatis（本章）→ " + rows.size() + " 筆");
            System.out.println("      第一列：" + rows.get(0));
        });
        System.out.println("   → " + b.size() + " 句 SQL、建了 " + entityLoad() + " 個實體");
        b.forEach(q -> System.out.println("      " + cut(q)));
    }
```

**實測**：

```
   JPA 投影（05 章 5.14）→ 20 筆
      第一列：OrderListRow[id=01a07ffe-fcae-7c11-906a-af407865cf7f, orderNo=SO-2026-000198,
                          customerName=客戶17, status=PENDING, totalAmount=330.0000,
                          placedAt=2026-07-09T05:00:00Z, itemCount=2]
   → 2 句 SQL、建了 0 個實體
      select o1_0.id,o1_0.order_no,c1_0.display_name,o1_0.status,o1_0.total_amount,
             o1_0.placed_at,(select count(oi1_0.id) from order_ite…
      select count(o1_0.id) from orders o1_0 where o1_0.status=?

   MyBatis（本章）→ 20 筆
      第一列：OrderListRow[id=01a07ffe-fcae-7c11-906a-af407865cf7f, orderNo=SO-2026-000198,
                          customerName=客戶17, status=PENDING, totalAmount=330.0000,
                          placedAt=2026-07-09T05:00:00Z, itemCount=2]
   → 1 句 SQL、建了 0 個實體
      SELECT o.id, o.order_no, c.display_name AS customer_name, o.status, o.total_amount,
             o.placed_at, (SELECT count(*) FROM order_item …
   ★ 兩者回傳的是【同一個 record】：com.example.lab.shop.OrderListRow
```

> ★★ **兩邊回傳的 `record` 是同一個類別，而第一列的內容【一字不差】。**
>
> **這是這一站兩個框架第一次產出完全相同的東西**，而它是刻意設計的：
> **它把「哪個框架比較好」這個問題，變成一個【可以量的問題】**——
> 因為輸出已經固定了，剩下的只有成本。
>
> ```
> JPA 投影    2 句 SQL（資料 + count）、0 個實體
> MyBatis     1 句 SQL（只有資料）、  0 個實體
> ```
>
> 📌 **注意「0 個實體」那一欄兩邊一樣。**
> 05 章 5.8.10 那個結論（「慢的是實體，不是 JPA」）在這裡拿到最後一塊拼圖：
> **當 JPA 也不建實體的時候，它跟 MyBatis 產出的東西是完全一樣的。**

### 7.15.3 實測：量時間

```java
    @Test
    void b_量時間() {
        head("7.15.2 同一頁，兩個框架各花多久");
        seed(200, 20, 2);
        long jpa = best(() -> orders.list(OrderStatus.PENDING, 0, 20));
        long myb1 = best(() -> query.listRows(OrderStatus.PENDING, 0, 20));
        long myb2 = best(() -> {
            query.listRows(OrderStatus.PENDING, 0, 20);
            query.countByStatus(OrderStatus.PENDING);
        });
        System.out.printf("   JPA 投影（Page → 2 句：資料 + count）  %4d µs%n", jpa);
        System.out.printf("   MyBatis（1 句，只有資料）              %4d µs%n", myb1);
        System.out.printf("   MyBatis（2 句，資料 + count）          %4d µs%n", myb2);
        System.out.printf("   → %.1f 倍%n", jpa / (double) myb2);
    }

    /** 暖機 5 次，取 20 次裡最快的一次（跟 00 章 0.7 同一個做法）。 */
    private long best(Runnable r) {
        for (int i = 0; i < 5; i++) r.run();
        long best = Long.MAX_VALUE;
        for (int i = 0; i < 20; i++) {
            long t0 = System.nanoTime(); r.run();
            best = Math.min(best, System.nanoTime() - t0);
        }
        return best / 1000;
    }
```

**實測**：

```
   JPA 投影（Page → 2 句：資料 + count）  2699 µs
   MyBatis（1 句，只有資料）              1074 µs
   MyBatis（2 句，資料 + count）          1188 µs
   ⚠️ 只有第一列與第三列可以直接比 —— 它們做的事一樣（2 句 SQL）
   → 2.3 倍
```

> ⚠️ **這個 2.3 倍【不是「MyBatis 比較快」的證據】，要說清楚為什麼**：
>
> ```
> 兩邊的 SQL 幾乎一樣（都是一句 JOIN + 一個相關子查詢）
> 兩邊回傳的 record 一樣
> 兩邊都是 0 個實體
>    ↓
> 差的 1.5 ms【不在資料庫那一側】，它在 Spring Data 那一層：
>    Pageable → CriteriaQuery / @Query 剖析 → 參數繫結 → Page 包裝 → map(::of)
> ```
>
> 📌 **而 05 章 5.8.6 已經量過那一層的一部分**（150 筆投影 1 ms）。
> **09 章會把這個差距拆開來看，並且問一個更重要的問題**：
> **「1.5 ms 值得為它多維護一個框架嗎？」**
>
> ⚠️ **這裡刻意【不下結論】。** 00 章 0.8.3 講過三個「不該拿來當理由的理由」，
> 而「快 2.3 倍」在還沒問「這支 API 一秒跑幾次」之前，**就是其中一個**。

### 7.15.4 實測：報表 —— JPQL 寫不出來的那一類

```java
    @Test
    void c_報表() {
        head("7.15.3 報表：JPQL 寫不出來的那一類");
        seed(200, 5, 2);
        List<String> sqls = spy(() -> {
            var rows = query.salesRanking(Instant.parse("2026-07-01T00:00:00Z"),
                                          Instant.parse("2027-01-01T00:00:00Z"));
            System.out.println("   客戶銷售排名（含窗口函式的 RANK 與佔比）：");
            rows.forEach(r -> System.out.printf(
                    "      #%d %-8s 訂單 %2d 筆、金額 %10s、佔 %s%%%n",
                    r.rank(), r.customerName(), r.orderCount(), r.totalAmount(), r.pctOfTotal()));
        });
        System.out.println("   → " + sqls.size() + " 句 SQL");
        …
    }
```

**實測**：

```
   客戶銷售排名（含窗口函式的 RANK 與佔比）：
      #1 客戶1      訂單 40 筆、金額 12147.0000、佔 25.15%
      #2 客戶3      訂單 40 筆、金額 12082.0000、佔 25.01%
      #3 客戶0      訂單 40 筆、金額 12069.0000、佔 24.99%
      #4 客戶2      訂單 40 筆、金額 12004.0000、佔 24.85%
   → 1 句 SQL

   狀態 × 月份樞紐表：
      月份     PENDING  PAID  CANCELLED   PENDING金額     PAID金額
      2026-07     106    54       40     31873.0000   16429.0000
   → 1 句 SQL
   ★ 這兩句都用了 05 章 5.4.8 證明「JPQL 規格沒有」的東西：
     CTE（WITH）、窗口函式（RANK() OVER）、SUM(條件式)
```

> ★ **這才是「該交給 MyBatis」的那一類查詢，而理由不是效能**：
>
> | 這句 SQL 用到的 | JPQL 規格 | Hibernate HQL | MyBatis |
> |---|---|---|---|
> | `WITH`（CTE） | 🔴 沒有 | ✅ 有（05 章 5.4.8） | ✅ 直接寫 |
> | `RANK() OVER` | 🔴 沒有 | ✅ 有 | ✅ 直接寫 |
> | `SUM(…) OVER ()` | 🔴 沒有 | ✅ 有 | ✅ 直接寫 |
> | `SUM(status = 'PENDING')`（MySQL 的布林轉數字） | 🔴 沒有 | 🔴 **沒有** | ✅ 直接寫 |
> | `DATE_FORMAT` | 🔴 沒有（要註冊函式） | 🟡 要註冊 | ✅ 直接寫 |
>
> 📌 **注意第四、五列**：連 **HQL 也沒有**。
> 05 章 5.4.8 那八個 HQL 擴充很強，**而它們還是一個「跨資料庫的子集」**——
> `SUM(布林)`、`DATE_FORMAT` 這種 MySQL 專屬的東西，Hibernate 不可能都收進來。
>
> **這是 00 章 0.6.6 那條軸最誠實的一個結論**：
> **「不能換方言」的另一面是「這個資料庫的每一個功能你都用得到」，**
> **而報表就是最需要那些功能的地方。**

### 7.15.5 實測：寫入路徑沒有變

```java
    @Test
    void d_寫入還是_JPA_的() {
        head("7.15.4 寫入路徑沒有變：還是 JPA");
        seed(0, 5, 0);
        UUID pid = jdbc.query("SELECT id FROM product LIMIT 1",
                (rs, n) -> Uuid7.fromBytes(rs.getBytes(1))).get(0);
        List<String> sqls = spy(() -> orders.place(Uuid7.next(), "SO-X-1",
                customerIds.get(0), pid, 2, Uuid7.next()));
        System.out.println("   place() → " + sqls.size() + " 句 SQL（06 章 6.11.2 量過是 4 句）");
        assertOnlySelect();
    }
```

**實測**：

```
   place() → 4 句 SQL（06 章 6.11.2 量過是 4 句）
   ★ 00 章 0.9 規則一：orders 這張表【只有 JPA 寫】。
     MyBatis 這一側的 OrderQueryMapper 從頭到尾只有 select。
   ── 把這條規則變成一個斷言 ──
   shop.mybatis 裡非 SELECT 的 statement：[]  ✅
```

**shop-service 目前的樣子**：

```
用例                            誰做          幾句 SQL      在哪一章定案
────────────────────────────────────────────────────────────────────────
place（下單 + 扣庫存）           JPA           4            06 章 6.11
pay / cancel / addItem          JPA           2 / 2 / 4     03 章 3.11、06 章 6.11
view（訂單明細）                 JPA           1            04 章 4.11
list（列表頁）                   JPA 投影      2            05 章 5.14
search（五個條件）               JPA Spec      2            05 章 5.14
importOrders（批次匯入 1000 張）  JPA           100          06 章 6.11
──────────────── 本章新增 ────────────────
listRows（同一個列表頁）          MyBatis       1            07 章 7.15  ← 對照組
salesRanking（客戶排名報表）      MyBatis       1            07 章 7.15
statusPivot（狀態樞紐表）         MyBatis       1            07 章 7.15
```

⚠️ **注意 `list` 與 `listRows` 是【兩個並存的實作】。**
這在真實專案裡是不該留下的（同一個功能兩份程式碼），
**這裡刻意留著，因為 09 章要用它回答那個問題**：

```
00 章 0.8.4 決定「列表查詢用 MyBatis」。
05 章 5.8.10 證明「慢的是實體，不是 JPA」。
07 章 7.15.2 量到「兩邊產出一字不差，而 JPA 慢 2.3 倍」。
   ↓
09 章：這個決定的哪一半還成立？
```

---
## 7.16 常見誤區

**① 「MyBatis 沒有狀態，所以不會有快取問題。」**

它有一級快取，**預設開著**，而且**同一個交易裡回傳同一個物件實例**（7.11.3、7.11.4）。

**② 「查兩次同一列，MyBatis 會回兩個不同的物件。」**

跨 `SqlSession` 是對的，**同一個交易裡不是**（7.11.4）。
**這修正了 00 章 0.5.3 的一句話。**

**③ 「`#{}` 安全是因為值不會出現在 SQL 文字裡。」**

打開 general log 看：**兩者送到 MySQL 的一字不差**（7.6.3）。
`#{}` 安全是因為**驅動正確地轉義了引號**。

**④ 「用了 `PreparedStatement` 就不會被注入。」**

`${}` 走的是 **MyBatis 的字串串接**，在驅動看到那句 SQL 之前就完成了 ——
**驅動沒有機會保護你**（7.6.3）。

**⑤ 「排序欄位改用 `#{}` 就安全了。」**

`ORDER BY ?` 在 MySQL 上**不報錯、也不排序**（7.6.4）。
比報錯糟糕得多。

**⑥ 「`${}` 前面加一個字串檢查（正則 / 黑名單）就好。」**

**要對照表**（7.6.5）。字串檢查的預設結果是「通過」，對照表的預設結果是「拒絕」。

**⑦ 「少一個 `TypeHandler` 會報錯。」**

**不會。** `count` 回 0、`UPDATE` 影響 0 列，
而**回傳 `void` 的方法連那個 0 都看不到**（7.5.1）。

**⑧ 「`JdbcTemplate` 忘了轉 UUID 會編譯失敗。」**

`queryForObject(sql, Class, Object...)` —— **編譯得過，回 0 筆**（7.5.6）。
**這修正了 00 章 0.5.4 那張表的第一列。**

**⑨ 「列舉用序數存比較省空間。」**

省的是幾個位元組，換來的是「插一個常數就靜默錯位」（7.5.3）。
**MyBatis 的預設值（存名字）是對的，不要改它。**

**⑩ 「`resultType` 對不上欄位會報錯。」**

**不會，那個屬性靜默是 null**（7.8.1），而且
`auto-mapping-unknown-column-behavior` 的預設值 `NONE` **連警告都沒有**。
**而它抓的還是反方向的問題** —— 那個 null 它抓不到。

**⑪ 「`record` 不能當 MyBatis 的結果型別。」**

**可以**，`resultType` 就行（7.8.5）。
**而 `javaType="long"` 是 `Long`，原始型別要寫 `_long`。**

**⑫ 「巢狀 `resultMap` 忘了 `ORDER BY` 會把物件拆開。」**

**預設不會**（7.8.8）。要 `resultOrdered="true"` 才會 ——
而那個屬性的代價是「順序變成正確性的前提，而沒有東西會檢查它」。

**⑬ 「`RowBounds` 是 MyBatis 的分頁。」**

它是**記憶體分頁**：SQL 裡沒有 `LIMIT`，3000 列全部撈回來再丟掉 2980 列（7.9.4）。
**而它連警告都沒有**（JPA 那一側至少有 `HHH90003004`）。

**⑭ 「`ExecutorType.BATCH` 一定比較快。」**

沒有 `rewriteBatchedStatements` 的話它**慢 3.7 倍**（1124 ms vs 301 ms，7.10.4）。
加上那個 URL 參數之後是 **10 ms**。

**⑮ 「`BATCH` 模式下也可以靠影響列數判斷成敗。」**

**不行。** `BATCH` 模式的 `update` 回傳 `Integer.MIN_VALUE`（7.10.4 最後）。

**⑯ 「巢狀 `select` 只是另一種寫法。」**

它就是 N+1：**39 句 SQL / 15 ms，而巢狀 `resultMap` 是 1 句 / 2 ms**（7.8.7）。

**⑰ 「MyBatis 不需要樂觀鎖，因為它沒有那個機制。」**

只要那張表有 `@Version`（因為 JPA 那一側在用），
**MyBatis 的每一句 `UPDATE` 都必須自己 `version = version + 1`**（7.10.3、06 章 6.6.10）。
不然 JPA 那一側的樂觀鎖**靜默失效**。

**⑱ 「打錯字會在啟動時被發現。」**

那是 Spring Data JPA。**MyBatis 的三種錯誤全部推遲到執行期**（7.4.5），
其中一種**完全不報**。**7.14 那四條斷言是把防線補回來。**

**⑲ 「`@Param` 只有多參數才需要。」**

單一參數的方法上，`#{}` 裡的名字**打錯也會通**（7.7）——
直到有人加了第二個參數。**一律寫 `@Param`。**

**⑳ 「兩個框架共用同一個交易，所以看到的資料一定一致。」**

**不一定。** JPA 寫完沒 flush，MyBatis 讀不到（7.12.1）；
MyBatis 寫完，JPA 手上那個實體還是舊的（7.12.1）。
**同一條連線、同一個交易，兩個快取。**

---

## 7.17 本章小結

**MyBatis 只做兩件事**：

```
① 把參數塞進你寫的 SQL      →  #{} / ${} / TypeHandler      →  7.5、7.6、7.7
② 把結果集變成 Java 物件     →  resultType / resultMap        →  7.8、7.9
```

**而這一章的每一個坑都在那兩個邊界上**：

| 邊界 | 壞掉的方式 | 節 |
|---|---|---|
| 參數 → SQL | 少一個 `TypeHandler` → **影響 0 列** | 7.5.1 |
| 參數 → SQL | 用 `${}` → **注入** | 7.6.2 |
| 參數 → SQL | 用 `#{}` 排序 → **不排序、不報錯** | 7.6.4 |
| 參數 → SQL | 單參數的名字打錯 → **一直都能跑** | 7.7 |
| SQL → 物件 | 欄位名對不上 → **屬性靜默是 null** | 7.8.1 |
| SQL → 物件 | `javaType="long"` → **`NoSuchMethodException`** | 7.8.5 |
| SQL → 物件 | 一句變 N 句（`select=`） | 7.8.7 |
| SQL → 物件 | 分頁在記憶體裡（`RowBounds`） | 7.9.4 |
| **方法 → SQL** | **XML 的 id 打錯 → 呼叫時才炸** | **7.4.5** |

📌 **跟前六章對比，這一章的錯誤有一個共同的形狀**：

```
01～06 章（JPA）：錯誤大多在【行為】上 ——「它做了我沒預期的事」
                （沒 save 卻寫入、251 句 SQL、樂觀鎖靜默失效）

07 章（MyBatis）：錯誤大多在【接合】上 ——「這兩個東西沒對上，而沒有人告訴我」
                （方法對不上 SQL、欄位對不上屬性、型別對不上建構子）
```

**而兩者的處理方式因此不同**：

```
JPA 的錯誤靠【量】抓（SqlSpy / PcSpy / NPlus1Spy / ReadOnlySpy / CacheSpy）
MyBatis 的錯誤靠【接合檢查】抓（7.14 那四條斷言）
```

**這一章也回收了兩個 00 章的承諾、修正了三句話**：

| 承諾 / 說法 | 結果 |
|---|---|
| 00 章 0.5.3「`@Mapper` 執行期是什麼」 | ✅ 7.3.2 + 7.4（四層、註冊表、`BoundSql`、完整路徑） |
| 00 章 0.5.4「`TypeHandler` 完整處理一次」 | ✅ 7.5（六個欄位、六種問題） |
| 00 章 0.3.6「`${}` 的正解完整寫一次」 | ✅ 7.6（含 `ORDER BY` 白名單） |
| 00 章 0.5.3「查兩次得到兩個不同的物件」 | 🔴 **修正**：同一個交易裡是同一個（7.11.4） |
| 00 章 0.5.4「`JdbcTemplate` 忘了轉會編譯失敗」 | 🔴 **修正**：編譯得過、回 0 筆（7.5.6） |
| 00 章 0.7「巢狀 `resultMap` 需要 `ORDER BY`」 | 🔴 **修正**：預設不需要（7.8.8） |

**還有兩個 06 章的結論在這裡拿到第二個證據**：

```
06 章 6.3.7  rewriteBatchedStatements 是批次的關鍵
   → 7.10.4：在 MyBatis 上是 1124 ms → 10 ms（112 倍）

06 章 6.6.10 非 JPA 的寫入路徑要自己維護 version
   → 7.10.3：那句 SQL 長什麼樣，以及怎麼包成一個可重用的 Service
```

### 7.17.1 驗收清單

**整合與 Mapper**
- [ ] `mybatis-spring-boot-starter` 為什麼要自己寫版本號？升 Boot 時要檢查什麼？（7.3.1）
- [ ] `SqlSessionTemplate` 解決什麼問題？（7.3.2 ②）
- [ ] `MappedStatement` 的 `id` 是什麼字串？它為什麼是 7.4.5 那個坑的來源？（7.4.2）
- [ ] `BoundSql` 的兩半各自對應這一章的哪一節？（7.4.3）
- [ ] 三種錯誤（方法名 / SQL 語法 / 欄位對不上）各自什麼時候被發現？（7.4.5）

**TypeHandler**
- [ ] 少一個 `TypeHandler` 的三種症狀（7.5.1）
- [ ] 為什麼寫入方法的回傳型別一律要 `int`？（7.5.1）
- [ ] MyBatis 與 JPA 在「列舉存名字還是序數」上的預設值，哪一個是安全的？（7.5.3）
- [ ] `Instant` 與 `LocalDateTime` 存進 `datetime(3)` 差在哪？（7.5.4）
- [ ] 寫 `TypeHandler` 的四條規則（7.5.7）

**參數**
- [ ] `#{}` 與 `${}` 送到伺服器的東西一樣嗎？那 `#{}` 的安全性是什麼？（7.6.3）
- [ ] 哪些位置只能用 `${}`？（7.6.4）
- [ ] `ORDER BY ?` 會發生什麼？（7.6.4）
- [ ] 白名單為什麼要用「對照表」而不是字串檢查？key 為什麼要跟欄位名不一樣？（7.6.5）
- [ ] 為什麼即使只有一個參數也要寫 `@Param`？（7.7）

**結果映射**
- [ ] 自動映射對不上的時候會怎樣？怎麼讓它至少抱怨一聲？（7.8.1）
- [ ] `<id>` 與 `<result>` 差在哪？（7.8.3）
- [ ] `record` 怎麼當結果型別？`long` 的 `javaType` 要寫什麼？（7.8.5）
- [ ] 巢狀 `resultMap` 與巢狀 `select` 的 SQL 句數（7.8.6、7.8.7）
- [ ] `resultOrdered` 的兩種值各自的行為與代價（7.8.8）

**回傳型別與寫入**
- [ ] 「查不到」與「查到很多」的回報方式（7.9.2）
- [ ] `Cursor` 的四個必要條件（7.9.3）
- [ ] `RowBounds` 為什麼不能用來分頁？（7.9.4）
- [ ] `useGeneratedKeys` 與 `<selectKey>` 各自什麼時候用？（7.10.1）
- [ ] `ExecutorType.BATCH` 為什麼可能比不批次還慢？（7.10.4）
- [ ] MyBatis 這一側那句「維護 `version`」的 `UPDATE` 長什麼樣？（7.10.3）

**快取與交易**
- [ ] MyBatis 一級快取的 key 是什麼？它跟 JPA 的差在哪三點？（7.11.7）
- [ ] 同一個交易裡查兩次，回來的是同一個物件嗎？這造成什麼問題？（7.11.4）
- [ ] 一次寫入清掉多少快取？為什麼是「整個」？（7.11.5）
- [ ] JPA 與 MyBatis 混用的四種組合（7.12.1）
- [ ] 怎麼確認兩個框架真的用同一條連線？（7.12.2）

### 7.17.2 本章練習

**練習一（TypeHandler）**
寫一個 `MoneyTypeHandler`：Java 那一側是 `record Money(BigDecimal amount, String currency)`，
資料庫那一側是**兩個欄位**（`amount` `DECIMAL(19,4)` + `currency` `CHAR(3)`）。
要求：① 寫一個 round-trip 測試（7.5.7 ④）；
② 說明為什麼「一個 Java 型別對兩個欄位」**不能**用 `TypeHandler` 做，該用什麼做。

**練習二（安全）**
把 7.6.5 那個 `OrderSort` 擴充成「多欄排序」（`ORDER BY a ASC, b DESC`）。
要求：① 前端傳的是一個字串（`"amount:desc,date:asc"`）；
② **對照表不能被繞過**；③ 寫一個測試，餵 20 個惡意輸入，斷言 SQL 裡永遠只有白名單裡的欄位。

**練習三（結果映射）**
7.8.6 那個 `<collection>` 用 `productName` 當 `<id>`（7.8.6 說那是將就的做法）。
把它改成用 `order_item.id`，然後**造一筆「同一張訂單有兩筆同名商品」的資料**，
證明改之前會少一筆明細。

**練習四（`resultOrdered`）**
把 7.8.6 那個查詢改成 `Cursor<OrderDetail>` + `resultOrdered="true"`，
處理 10 萬張訂單。量三件事：① 記憶體用量（`Runtime.totalMemory - freeMemory`）；
② 跟不用 `Cursor` 的版本比；③ **把 `ORDER BY` 拿掉，看結果錯成什麼樣子。**

**練習五（批次）**
7.10.4 那個 `<foreach>` 的形狀跟筆數綁定（每一種筆數一句不同的 SQL）。
寫一個「固定批次大小」的版本：一律組 500 個 `VALUES`，不足的用**重複的最後一筆**填，
然後靠主鍵衝突或 `INSERT IGNORE` 處理。
**然後回答：這樣做值得嗎？** 用 05 章 5.5.2 的方法量「SQL 形狀的數量」與「剖析成本」。

**練習六（快取）**
7.11.4 那個坑（回傳同一個實例）：
① 把 `OrderRow` 改成 `record`，證明那個坑消失了；
② 找出你的專案裡所有「mapper 回傳可變 POJO」的地方，寫一條 ArchUnit 規則擋住它。

**練習七（斷言）**
把 7.14 那四條斷言加進專案，然後**刻意製造四個違例**（改一個方法名、
把某個 `int` 改成 `void`、在查詢 mapper 裡加一句 `UPDATE`、拿掉一個 SQL 別名），
確認四條都會失敗、而且**訊息足以讓人直接修好它**。

**練習八（回頭看）**
把 7.15.5 那張「shop-service 目前的樣子」表補上一欄：**「這個用例如果換成另一個框架，
會變成幾句 SQL、要多寫多少程式碼」**。
**然後標出哪幾列你會真的想換。** 09 章會拿你的答案跟它的結論對照。

---

## 7.18 下一章預告

**08 章：MyBatis 進階 —— 動態 SQL、`resultMap` 深入、分頁與快取。**

這一章的 SQL 全部是**固定的**。而真實系統的查詢不是：

```
搜尋頁有五個條件，使用者可能填 0～5 個。
   ↓
JPA 那一側：05 章 5.9 的 Specification（那一節花了 500 行講它為什麼存在）
MyBatis 那一側：<if> —— 而它有一個 05 章 5.9.1 那五個問題【全部沒有】的版本，
              以及一個 05 章完全沒有的新問題
```

📌 **08 章的第一句話是**：

```
05 章 5.12.2 那張決策表有一列寫著：
   「SQL 本身是動態的（欄位、表名會變） → 🔴 只能拼字串 → MyBatis 的 <if> / <choose>」
而那一列沒有說的是：<if> 拼出來的東西，也是字串。
```

**08 章會處理六件事**：

```
① <if> / <choose> / <where> / <set> / <trim>：以及那個「where 1 = 1」為什麼不需要
② 🔴 <foreach>：in 子句、批次插入，以及它跟 05 章 5.5.3 那個「SQL 形狀爆炸」的關係
③ resultMap 深入：association / columnPrefix / 鑑別器（discriminator）、
   以及 7.8.6 那個「身分欄位該選什麼」
④ 分頁：PageHelper 怎麼運作（攔截器改寫 SQL）、它的兩個坑，
   以及 keyset 分頁在 MyBatis 上為什麼比 JPA 容易
⑤ 二級快取：<cache/>、它的失效範圍，以及它跟 06 章 6.5 那個
   「兩個快取互相不知道」的完整版本
⑥ 攔截器（Interceptor）：MyBatis 唯一的擴充點 ——
   以及為什麼「用它做審計」通常是個壞主意
```

⚠️ **而 08 章會回頭修改這一章的三個東西**：

| 這一章說 | 08 章會補上 |
|---|---|
| 7.8.6：`<collection>` 的欄位要加前綴 | **`columnPrefix`** 可以省掉逐欄寫；以及巢狀兩層以上時它為什麼是必需的 |
| 7.9.4：`RowBounds` 不能分頁，要自己寫 `LIMIT` | **PageHelper** 怎麼幫你寫，以及它在什麼情況下會**寫錯** |
| 7.10.4：`<foreach>` 的 SQL 形狀跟筆數綁定 | 這件事在 `in` 子句上的完整後果，以及 MyBatis 有沒有 `padding` 的替代品 |

📌 **而 09 章會回來收這一站最大的一筆帳。這一章交給它三個數字**：

```
7.15.2  同一個列表頁、同一個 record、同樣 0 個實體 → JPA 2699 µs、MyBatis 1188 µs
7.15.4  報表用到的五個 SQL 功能，JPQL 沒有五個、HQL 沒有兩個
7.10.4  批次匯入：MyBatis 的 <foreach> 13 ms，JPA 的 batch 21 ms（06 章 6.3.9）
   ↓
09 章：00 章 0.8.4 那個「報表與列表查詢用 MyBatis」的決定，
      哪一半是對的、哪一半是「快 2.3 倍」這種不該當理由的理由（00 章 0.8.3）？
```
