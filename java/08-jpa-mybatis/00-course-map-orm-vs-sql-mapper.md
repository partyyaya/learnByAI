# 第 00 章：課程地圖、ORM 與 SQL Mapper 的分歧點

> 07-mysql 站結束時，你手上有一份 schema、一組索引、一份慢查詢 SOP、一套 Flyway 遷移腳本。
> 06-repository 站結束時，你手上有一組**埠與轉接器**、一個 `JdbcOrderRepository`、
> 十七條契約測試、六條 ArchUnit 規則。
>
> 這一站要做的事，用一句話講完就是：
>
> > **把那個 `JdbcOrderRepository` 換掉。**
>
> 換成 JPA，或換成 MyBatis。兩個都學，因為**實務上你兩種專案都會遇到**。
>
> ⚠️ 但這一章開場要講的，不是「怎麼換」。
> 而是一件在換之前就必須先想清楚的事：
>
> **這兩個東西不是「同一件事的兩種寫法」，而是「兩種不同的世界觀」。**
>
> 這一章有**六個實測事故**——沒有呼叫 `save()` 資料卻改了、
> 一支列表 API 打出 251 句 SQL、存一筆全新的資料要打兩句 SQL、
> 實體離開交易就不能用了、兩個框架改同一張表讓樂觀鎖靜默失效、
> 一個 `${}` 讓 `WHERE` 條件整個消失——
> **六個事故的 Java 程式碼全部「看起來是對的」，六個都是世界觀的差異造成的。**
>
> 📌 所以這一章的順序是刻意的：
> **先把「這兩個東西到底是什麼」講完，再開始教任何一個的語法。**
> 因為選錯了、或是選對了卻用錯世界觀，後面九章教的每一個技巧都只是在補破網。

---

## 0.1 學習目標

完成本章後，你應該可以：

- 說出 **JPA / Hibernate / Spring Data JPA** 三者的關係，
  並指出**同一件事在三個層次各自怎麼寫、產出的 SQL 一不一樣**（0.4.2 實測：一模一樣）。
- 說明 `javax.persistence` → `jakarta.persistence` 的改名發生了什麼，
  以及為什麼**網路上大多數 JPA 教學的第一行 import 就已經不能用了**。
- 說出 MyBatis 為什麼**不是 ORM**，並描述一句 SQL 從 Mapper 介面走到 JDBC 的完整路徑。
- 指認出 `OrderRepo` 與 `OrderMapper` 這兩個「沒有實作的介面」在執行期**分別是什麼東西**
  （0.4.3、0.5.3 實測：兩個都是 JDK 動態代理，但背後的目標完全不同）。
- 用**六個根本差異**（誰決定 SQL、有沒有狀態、查詢的單位、寫入時機、誰主導 schema、換資料庫的成本）
  說明 ORM 與 SQL Mapper 的分歧，而不是只會講「JPA 比較方便、MyBatis 比較自由」。
- 解釋為什麼「**沒有呼叫 `save()`，資料卻進去了**」——並知道這件事在 06 站的契約測試上是**紅燈**。
- 解釋為什麼 `customers.save(新的實體)` 會打出 **`SELECT` + `INSERT` 兩句**，
  以及這件事跟 07 站選的 **`BINARY(16)` UUIDv7 主鍵**有直接關係。
- 讀懂一份 SQL 計數報表，並用它判斷一段程式碼有沒有 N+1
  （0.7 實測：同一頁 200 張訂單，四種寫法分別是 **251 / 1 / 201 / 1** 句 SQL）。
- 說明 **MyBatis 也會 N+1**，並指出它跟 JPA 的 N+1 在「你看不看得見」這件事上的差別。
- 用一張**七個判準的決策表**替一個新專案選型，並說出你的理由——
  而不是「公司都用這個」。
- 說明 JPA 與 MyBatis **混用**時的三條規則，
  並解釋 0.3.5 那個實測事故（樂觀鎖靜默失效）為什麼是混用的第一號地雷。
- 建好本站的基準專案：`pom.xml`、`application.yml`、**一個會把每一句 SQL 記下來的 `SqlSpy`**，
  以及一組讓「SQL 句數」變成可測試斷言的工具。

---

## 0.2 這一站在整條路線的位置

```
           01-java-core     語言 + JVM + 建置 + 測試（已完成）
                ↓
           02-spring-boot   IoC / DI / 自動組態 / AOP / 設定 / 部署（已完成）
                ↓
           03-rest-api      介面契約設計（已完成，orders-api.yaml）
                ↓
           04-controller    Web 層：接請求、驗參數、回錯誤（已完成）
                ↓
           05-service       商業邏輯層：交易、不變量、快取、非同步（已完成）
                ↓
           06-repository    資料存取層：埠與轉接器、JdbcTemplate、契約測試（已完成）
                ↓
           07-mysql         資料庫本體：環境、建模、索引、鎖、調校、遷移（已完成）
                ↓
[你在這裡] 08-jpa-mybatis   ★ 兩種存取實作：ORM vs SQL Mapper
                ↓
           09 / 10 / 11     Spring Security / Redis / 訊息佇列
                ↓
           12-capstone      整合成一個可上線的服務
```

⚠️ **注意這一站的位置**：它在 06（資料層抽象）與 07（資料庫本體）**之後**。

這個順序是刻意的，而且它決定了這一站的教法：

> **你已經知道 SQL 該長什麼樣（07 站），也知道資料層的介面該怎麼設計（06 站）。**
> **這一站不是要教你「不用寫 SQL 也可以」，而是要教你**
> **「當有一個框架幫你寫 SQL 的時候，它到底寫了什麼、什麼時候寫、以及它什麼時候會寫錯」。**

📌 **如果你是跳著讀的**：這一章可以獨立看，但 0.3 的六個事故裡有四個
會直接引用 06 站的契約測試與 07 站的 schema。看不懂那些引用不影響理解事故本身。

### 0.2.1 06 與 07 站留下的「等 08 站」

前兩站每一章結尾都有一張「本章沒有驗證到的」表。跟這一站有關的攤開來看：

| 前面留下的問題 | 它真正在問什麼 | 本站哪一章 |
|---|---|---|
| 「兩次 `findById` 回傳的是不是同一個物件」三種實作三種答案（**06 站** 00 章 0.10.3） | **JPA 的「身分」是誰定義的** | **00（0.6.2）**、03 |
| 「改了物件但忘記 `save()`」在 JPA 上**會生效**（**06 站** 00 章 0.10.3 ①） | **髒檢查是什麼、什麼時候跑** | **00（0.3.1）**、03 |
| 埠的簽章不可洩漏持久化型別，「08 站換 JPA 時要改 Service」（**06 站** 00 章 ArchUnit 規則 6） | **JPA 的實體可不可以當領域模型** | 01、09 |
| `saveAll()` 為什麼不是批次（**06 站** 05 章 5.7） | **Hibernate 的批次要開什麼、以及什麼會讓它靜默失效** | 06 |
| `Entity` 不是領域模型（**06 站** 03 章 3.5） | **兩層模型要不要分、分了誰來轉** | 01、09 |
| 明細「全刪重插 vs 逐筆 diff」（**06 站** 03 章 3.7） | **`cascade` 與 `orphanRemoval` 實際上做了什麼** | 02 |
| Open Session In View（**06 站** 05 章 5.6） | **`LazyInitializationException` 的三種解法** | **00（0.3.4）**、04 |
| H2 與 MySQL 的 21 根探針裡，12 根兩邊不一樣（**06 站** 06 章 6.4） | **換方言之後 ORM 產出的 SQL 會變成什麼** | **00（0.6.6）** |
| `BINARY(16)` 的 UUIDv7 主鍵（**07 站** 01 章 1.8.4、1.12） | **應用端指定主鍵，ORM 怎麼知道這筆是新的** | **00（0.3.3）**、01 |
| 11 條不變量裡，資料庫只守得住 6 條（**07 站** 01 章 1.10.5） | **剩下 5 條在 ORM 的世界裡守在哪** | 01、06 |
| 樂觀鎖 `version` 欄位（**07 站** 01 章 1.12） | **誰負責把它 +1** | **00（0.3.5）**、06 |

⚠️ **注意這張表的分布**：十一處裡有**五處落在這一章**，
而且五處全部都不是「語法」——**全部都是「這個框架的世界觀跟你原本的不一樣」**。

> 📌 **這說明了一件事**：
> 從 `JdbcTemplate` 換到 JPA，**真正會咬你的不是 API 不熟**，
> 而是「**有一些你以為自己在控制的事，換過去之後由框架決定了**」——
> 什麼時候寫、寫哪些欄位、寫幾次、兩次查回來是不是同一個物件。
>
> **這一章的六個事故，全部都是這一句話的實例。**

### 0.2.2 這一站的產出

```
第 00 章  課程地圖：三個名字、MyBatis 定位、六個根本差異、選型決策表   ← 你在這裡
第 01 章  Entity 映射基礎：@Entity / @Table / @Column、主鍵策略、列舉與時間、@Embedded、審計
第 02 章  關聯映射：@OneToMany / @ManyToOne / @ManyToMany、擁有方、cascade、orphanRemoval
第 03 章  持久化情境（核心章）：四種狀態、一級快取、髒檢查、flush 時機、merge vs persist
第 04 章  延遲載入與 N+1（核心章）：fetch 策略、JOIN FETCH、@EntityGraph、@BatchSize、分頁陷阱
第 05 章  查詢技術：JPQL、Criteria API、QueryDSL、原生 SQL 與 DTO 投影
第 06 章  效能與並行控制：批次插入、saveAll 的真相、二級快取、@Version、悲觀鎖
第 07 章  MyBatis 基礎：Spring Boot 整合、Mapper 介面、XML vs 註解、#{} 與 ${}
第 08 章  MyBatis 進階：動態 SQL、resultMap 關聯與巢狀、分頁、批次、快取
第 09 章  實務選型與混用：什麼場景誰快、同專案共存的架構、遷移成本評估
```

**結束時你會有**：

```
✅ 一份 JPA 版的 shop-service 資料層 —— 實作 06 站那一組【一字未改】的埠
✅ 一份 MyBatis 版的同一組埠 —— 兩份實作都跑得過 06 站那十七條契約測試
✅ 一個 SqlSpy 工具 + 一組「SQL 句數」的斷言 —— 讓 N+1 在 CI 就會紅，而不是上線才發現
✅ 一份 N+1 偵測 / 修復的實驗報告，含四種解法的實測對照
✅ 一份兩者的效能對照表 —— 同一組場景、同一個資料庫、同一份資料
✅ 一份選型說明書 —— 寫給三年後接手的人看「我們為什麼選這個」
```

### 0.2.3 這一站**不**處理的六件事

⚠️ 這六件事很容易在這裡被順手講掉，但它們各自屬於別的地方：

| 不在這一站 | 在哪裡 | 為什麼分開 |
|---|---|---|
| **SQL 本身怎麼寫、索引怎麼設計、`EXPLAIN` 怎麼看** | 07-mysql（已完成） | 本站教「框架幫你產出的 SQL 對不對」，前提是你已經看得懂 SQL |
| **資料層的介面該怎麼設計、埠與轉接器** | 06-repository（已完成） | 本站只換轉接器的實作，**埠一字不改**——那正是 06 站那組抽象的驗收 |
| **交易邊界該切在哪、`@Transactional` 的傳播行為** | 05-service、06-repository 05 章（已完成） | 本站假設交易邊界已經在 Service；只補「持久化情境跟交易邊界的關係」 |
| **連線池怎麼調、`HikariCP` 的參數** | 06-repository 01 章（已完成） | JPA 與 MyBatis 底下都是同一個 `DataSource` |
| **二級快取要不要接 Redis** | 10-redis | 那是「MySQL 之外多一層」的問題；本站 06 章只講 Hibernate 內建的二級快取 |
| **jOOQ、Spring Data JDBC、Exposed 等其他選擇** | 09 章（只做比較，不教） | 台灣的 Java 後端職缺，實務上就是 JPA 與 MyBatis 兩大陣營 |

> ⚠️ **一個要先講清楚的定位**：
> 這一站**不是 Hibernate 原始碼課**。你不會學到 `ActionQueue` 的內部結構、
> 或是 `StatefulPersistenceContext` 怎麼實作。
>
> 這一站教的是 **「一個寫 Java 的人，需要知道多少 ORM 的運作方式，
> 才不會寫出『在開發環境完全正常、上線就崩』的程式」**。
>
> 判準跟 07 站一樣簡單：**只要一個框架行為會改變你程式碼的正確性或效能量級，它就在這一站。**
> 本章的六個事故，全部符合這個判準。

---

## 0.3 先看見痛：六個「程式碼看起來完全正確」的事故

⚠️ **這一節的每一段輸出都是實際跑出來的**，環境見 0.10。
每個事故的程式碼都是**自足的**——你可以照著建一個專案跑一次。

### 0.3.0 六個事故共用的場景

全部用 07 站 01 章 1.12 那份 schema 的一個子集：

```sql
-- 07 站 01 章 1.12 的 schema，取這一章用得到的五張表
-- 主鍵一律 BINARY(16) 的 UUIDv7（07 站 1.8.4）
-- 時間一律 DATETIME(3)，語意上是 UTC（07 站 0.6.2）
-- 金額一律 DECIMAL(19,4)（07 站 1.3.8）

CREATE TABLE customer (
  id            BINARY(16)   NOT NULL,
  email         VARCHAR(255) NOT NULL,
  display_name  VARCHAR(64)  NOT NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  version       BIGINT       NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uk_customer_email (email)
) ENGINE=InnoDB;

CREATE TABLE product (
  id          BINARY(16)    NOT NULL,
  sku         VARCHAR(32)   NOT NULL COLLATE utf8mb4_bin,
  name        VARCHAR(200)  NOT NULL,
  unit_price  DECIMAL(19,4) NOT NULL,
  is_active   BOOLEAN       NOT NULL DEFAULT TRUE,
  version     BIGINT        NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uk_product_sku (sku)
) ENGINE=InnoDB;

CREATE TABLE stock (
  product_id   BINARY(16) NOT NULL,
  qty          INT        NOT NULL DEFAULT 0,
  reserved_qty INT        NOT NULL DEFAULT 0,
  version      BIGINT     NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id),
  CONSTRAINT fk_stock_product FOREIGN KEY (product_id) REFERENCES product(id)
) ENGINE=InnoDB;

CREATE TABLE orders (                            -- ★ 不叫 order：保留字（07 站 1.11）
  id              BINARY(16)    NOT NULL,
  order_no        VARCHAR(32)   NOT NULL,
  customer_id     BINARY(16)    NOT NULL,
  status          VARCHAR(16)   NOT NULL,
  total_amount    DECIMAL(19,4) NOT NULL,
  discount_amount DECIMAL(19,4) NOT NULL DEFAULT 0.0000,
  currency        CHAR(3)       NOT NULL DEFAULT 'TWD',
  placed_at       DATETIME(3)   NOT NULL,
  paid_at         DATETIME(3)   NULL,
  created_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                         ON UPDATE CURRENT_TIMESTAMP(3),
  version         BIGINT        NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uk_orders_order_no (order_no),
  KEY idx_orders_customer_placed (customer_id, placed_at),
  KEY idx_orders_status_placed (status, placed_at),
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customer(id)
) ENGINE=InnoDB;

CREATE TABLE order_item (
  id           BINARY(16)    NOT NULL,
  order_id     BINARY(16)    NOT NULL,
  product_id   BINARY(16)    NOT NULL,
  product_name VARCHAR(200)  NOT NULL,          -- ★ 下單當下的快照
  unit_price   DECIMAL(19,4) NOT NULL,          -- ★ 下單當下的快照
  qty          INT           NOT NULL,
  line_amount  DECIMAL(19,4) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_order_item_order (order_id),
  CONSTRAINT fk_order_item_orders  FOREIGN KEY (order_id)   REFERENCES orders(id),
  CONSTRAINT fk_order_item_product FOREIGN KEY (product_id) REFERENCES product(id)
) ENGINE=InnoDB;
```

📌 **這一章從頭到尾用的都是這份 schema，而且它是「先有 schema、後有實體」**。
這個方向本身就是一個選擇（0.6.5 會回來處理「誰主導 schema」這個問題）。

### 0.3.0.1 全站的程式碼命名慣例

⚠️ **這一站的每一章都會出現「同一個領域、不同名字」的類別。先把規則講清楚，之後就不會混淆**：

| 套件 | 用途 | 命名 | 例子 |
|---|---|---|---|
| `com.example.lab` | 全站共用的工具 | 原名 | `Uuid7`、`SqlSpy`、`Fixtures` |
| `com.example.lab.jpa` | **00 章**的示範實體 | 加後綴 `E` | `CustomerE`、`OrderE` |
| `com.example.lab.mybatis` | MyBatis 這一側 | `...Mapper` / `...Row` | `OrderMapper`、`OrderRow` |
| `com.example.lab.ch01` / `ch02` | **各章的實驗變體** | 加編號或描述 | `PkUuid7P`、`Customer2`、`OrderCasOrphan` |
| **`com.example.lab.shop`** | ★ **正式的成品實體** | **乾淨的領域名** | **`Customer`、`Order`、`OrderItem`、`Stock`** |

> 📌 **只有 `com.example.lab.shop` 那一組是「要帶走的東西」。**
> 其他套件裡的類別都是**為了做對照實驗而存在的**——
> 例如 02 章會有 `OrderNoCas` / `OrderCasOnly` / `OrderCasOrphan` 三個類別
> **映射到同一張 `orders` 表**，只為了比較三種 `cascade` 設定的差別。
>
> ⚠️ **「同一張表映射成多個實體類別」在正式專案裡是不該做的事**，
> 這裡純粹是為了讓對照組跑在同一個資料庫上。

📌 **成品實體在哪裡**：
**01 章 1.16**（映射定案）→ **02 章 2.12**（關聯定案）。

---

**JPA 這一側的實體**（01、02 章會逐項解釋每一個註解；這裡先能跑就好）：

```java
package com.example.lab.jpa;

import jakarta.persistence.*;
import java.time.Instant;
import java.util.UUID;

@Entity @Table(name = "customer")
public class CustomerE {
    @Id private UUID id;                       // ★ 應用端產生，不是資料庫產生（0.3.3 的主角）
    private String email;
    @Column(name = "display_name") private String displayName;
    @Column(name = "created_at", insertable = false, updatable = false) private Instant createdAt;
    @Version private long version;             // ★ 樂觀鎖（0.3.5 的主角）

    protected CustomerE() {}                   // JPA 需要一個無參數建構子
    public CustomerE(UUID id, String email, String displayName) {
        this.id = id; this.email = email; this.displayName = displayName;
    }
    public UUID getId() { return id; }
    public String getEmail() { return email; }
    public String getDisplayName() { return displayName; }
    public void setDisplayName(String n) { this.displayName = n; }
    public long getVersion() { return version; }
}
```

```java
package com.example.lab.jpa;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.util.UUID;

@Entity @Table(name = "product")
public class ProductE {
    @Id private UUID id;
    private String sku;
    private String name;
    @Column(name = "unit_price") private BigDecimal unitPrice;
    @Column(name = "is_active") private boolean active = true;
    @Version private long version;

    protected ProductE() {}
    public ProductE(UUID id, String sku, String name, BigDecimal unitPrice) {
        this.id = id; this.sku = sku; this.name = name; this.unitPrice = unitPrice;
    }
    public UUID getId() { return id; }
    public String getSku() { return sku; }
    public String getName() { return name; }
    public BigDecimal getUnitPrice() { return unitPrice; }
}
```

```java
package com.example.lab.jpa;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

@Entity @Table(name = "orders")
public class OrderE {
    @Id private UUID id;
    @Column(name = "order_no") private String orderNo;

    @ManyToOne(fetch = FetchType.LAZY)          // ★ 0.3.2、0.3.4 的主角
    @JoinColumn(name = "customer_id")
    private CustomerE customer;

    private String status;
    @Column(name = "total_amount")    private BigDecimal totalAmount = BigDecimal.ZERO;
    @Column(name = "discount_amount") private BigDecimal discountAmount = BigDecimal.ZERO;
    private String currency = "TWD";
    @Column(name = "placed_at") private Instant placedAt;
    @Column(name = "paid_at")   private Instant paidAt;
    @Column(name = "created_at", insertable = false, updatable = false) private Instant createdAt;
    @Column(name = "updated_at", insertable = false, updatable = false) private Instant updatedAt;
    @Version private long version;

    @OneToMany(mappedBy = "order", cascade = CascadeType.ALL, orphanRemoval = true)
    private List<OrderItemE> items = new ArrayList<>();

    protected OrderE() {}
    public OrderE(UUID id, String orderNo, CustomerE customer) {
        this.id = id; this.orderNo = orderNo; this.customer = customer;
        this.status = "PENDING"; this.placedAt = Instant.now();
    }

    public void addItem(OrderItemE item) {
        items.add(item);
        totalAmount = totalAmount.add(item.getLineAmount());
    }
    public void pay()    { this.status = "PAID"; this.paidAt = Instant.now(); }
    public void cancel() { this.status = "CANCELLED"; }

    public UUID getId() { return id; }
    public String getOrderNo() { return orderNo; }
    public CustomerE getCustomer() { return customer; }
    public String getStatus() { return status; }
    public void setStatus(String s) { this.status = s; }
    public BigDecimal getTotalAmount() { return totalAmount; }
    public List<OrderItemE> getItems() { return items; }
    public long getVersion() { return version; }
}
```

```java
package com.example.lab.jpa;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.util.UUID;

@Entity @Table(name = "order_item")
public class OrderItemE {
    @Id private UUID id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "order_id")
    private OrderE order;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "product_id")
    private ProductE product;

    @Column(name = "product_name") private String productName;
    @Column(name = "unit_price")   private BigDecimal unitPrice;
    private int qty;
    @Column(name = "line_amount")  private BigDecimal lineAmount;

    protected OrderItemE() {}
    public OrderItemE(UUID id, OrderE order, ProductE product, int qty) {
        this.id = id; this.order = order; this.product = product;
        this.productName = product.getName();          // ★ 快照（07 站 1.12）
        this.unitPrice   = product.getUnitPrice();     // ★ 快照
        this.qty = qty;
        this.lineAmount = product.getUnitPrice().multiply(BigDecimal.valueOf(qty));
    }
    public UUID getId() { return id; }
    public OrderE getOrder() { return order; }
    public ProductE getProduct() { return product; }
    public String getProductName() { return productName; }
    public BigDecimal getLineAmount() { return lineAmount; }
    public int getQty() { return qty; }
}
```

**四個 Spring Data 的介面**（0.4.3 會解釋這些「沒有實作的介面」是怎麼跑起來的）：

```java
package com.example.lab.jpa;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface CustomerRepo  extends JpaRepository<CustomerE, UUID> {}
```

```java
package com.example.lab.jpa;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.UUID;

public interface ProductRepo extends JpaRepository<ProductE, UUID> {}
```

```java
package com.example.lab.jpa;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface OrderRepo extends JpaRepository<OrderE, UUID> {
    List<OrderE> findByStatus(String status);
    Optional<OrderE> findByOrderNo(String orderNo);
}
```

```java
package com.example.lab.jpa;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.UUID;

public interface OrderItemRepo extends JpaRepository<OrderItemE, UUID> {}
```

**MyBatis 這一側**（07、08 章會完整處理；這裡先看它長什麼樣）：

```java
package com.example.lab.mybatis;

import org.apache.ibatis.annotations.*;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

@Mapper
public interface OrderMapper {

    @Update("UPDATE orders SET status = 'PAID', paid_at = #{paidAt} WHERE id = #{id}")
    int markPaid(@Param("id") UUID id, @Param("paidAt") Instant paidAt);

    /** ⚠️ 對照組：把 UUID 交給 MyBatis 的預設處理（沒有 TypeHandler 時就是這樣）。0.5.4 的主角。 */
    @Update("UPDATE orders SET status = 'PAID', paid_at = #{paidAt} "
          + "WHERE id = #{id, typeHandler=org.apache.ibatis.type.ObjectTypeHandler}")
    int markPaidNoHandler(@Param("id") UUID id, @Param("paidAt") Instant paidAt);

    /** 一句 JOIN 就把「列表要顯示的東西」全部拿到。 */
    @Select("""
            SELECT o.id, o.order_no, o.status, o.total_amount, o.placed_at,
                   c.display_name AS customer_name
            FROM orders o JOIN customer c ON c.id = o.customer_id
            WHERE o.status = #{status}
            ORDER BY o.placed_at
            """)
    List<OrderRow> findByStatus(@Param("status") String status);

    /** ⚠️ 反例：${} 是字串拼接。0.3.6 的主角。 */
    @Select("SELECT o.id, o.order_no, o.status, o.total_amount, o.placed_at, "
          + "c.display_name AS customer_name "
          + "FROM orders o JOIN customer c ON c.id = o.customer_id WHERE o.status = '${status}'")
    List<OrderRow> findByStatusUnsafe(@Param("status") String status);

    @Select("SELECT COUNT(*) FROM orders WHERE status = #{status}")
    long countByStatus(@Param("status") String status);
}
```

```java
package com.example.lab.mybatis;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

/** ★ MyBatis 這一側沒有「實體」，只有【查詢結果的形狀】。 */
public class OrderRow {
    private UUID id;
    private String orderNo;
    private String status;
    private BigDecimal totalAmount;
    private Instant placedAt;
    private String customerName;      // ← 來自 JOIN，不對應 orders 的任何一欄

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }
    public String getOrderNo() { return orderNo; }
    public void setOrderNo(String v) { this.orderNo = v; }
    public String getStatus() { return status; }
    public void setStatus(String v) { this.status = v; }
    public BigDecimal getTotalAmount() { return totalAmount; }
    public void setTotalAmount(BigDecimal v) { this.totalAmount = v; }
    public Instant getPlacedAt() { return placedAt; }
    public void setPlacedAt(Instant v) { this.placedAt = v; }
    public String getCustomerName() { return customerName; }
    public void setCustomerName(String v) { this.customerName = v; }

    @Override public String toString() {
        return orderNo + "/" + status + "/" + totalAmount + "/" + customerName;
    }
}
```

**還有一個 06 站的 `JdbcTemplate` 對照組**：

```java
package com.example.lab.jdbc;

import com.example.lab.Uuid7;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** 06 站的做法：手寫 SQL + JdbcTemplate。這一站拿它當對照組。 */
@Repository
public class JdbcOrderDao {

    private final JdbcTemplate jdbc;
    public JdbcOrderDao(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    public int markPaid(UUID id, Instant paidAt) {
        return jdbc.update("UPDATE orders SET status = 'PAID', paid_at = ? WHERE id = ?",
                Timestamp.from(paidAt), Uuid7.toBytes(id));
    }

    public List<Map<String, Object>> findByStatus(String status) {
        return jdbc.queryForList("""
                SELECT o.order_no, o.status, o.total_amount, c.display_name AS customer_name
                FROM orders o JOIN customer c ON c.id = o.customer_id
                WHERE o.status = ? ORDER BY o.placed_at
                """, status);
    }
}
```

⚠️ **注意 `JdbcOrderDao.markPaid` 裡的 `Uuid7.toBytes(id)`**：
`JdbcTemplate` 不知道 `UUID` 該怎麼變成 `BINARY(16)`，**你得自己轉**。
這件事會在 0.5.4 變成一個事故——**MyBatis 也不知道，而它不會報錯。**

```java
package com.example.lab;

import java.nio.ByteBuffer;
import java.security.SecureRandom;
import java.util.UUID;

/** 最小可用的 UUIDv7 產生器（07 站 01 章 1.8.4）。 */
public final class Uuid7 {
    private static final SecureRandom RND = new SecureRandom();

    public static UUID next() {
        byte[] b = new byte[16];
        RND.nextBytes(b);
        long ts = System.currentTimeMillis();
        b[0] = (byte) (ts >>> 40); b[1] = (byte) (ts >>> 32);
        b[2] = (byte) (ts >>> 24); b[3] = (byte) (ts >>> 16);
        b[4] = (byte) (ts >>> 8);  b[5] = (byte) ts;
        b[6] = (byte) ((b[6] & 0x0F) | 0x70);            // version 7
        b[8] = (byte) ((b[8] & 0x3F) | 0x80);            // variant
        ByteBuffer bb = ByteBuffer.wrap(b);
        return new UUID(bb.getLong(), bb.getLong());
    }

    public static byte[] toBytes(UUID u) {
        return ByteBuffer.allocate(16).putLong(u.getMostSignificantBits())
                .putLong(u.getLeastSignificantBits()).array();
    }

    public static UUID fromBytes(byte[] b) {
        ByteBuffer bb = ByteBuffer.wrap(b);
        return new UUID(bb.getLong(), bb.getLong());
    }

    private Uuid7() {}
}
```

---

### 0.3.1 事故一：沒有呼叫 `save()`，資料卻改了 ★★

**需求**：把一張訂單標記為已付款。三種寫法並排：

```java
// ① JdbcTemplate（06 站的做法）
tx.executeWithoutResult(s -> dao.markPaid(orderId, Instant.now()));

// ② Spring Data JPA —— ★ 注意：【沒有】呼叫 save()
tx.executeWithoutResult(s -> {
    OrderE o = orders.findById(orderId).orElseThrow();
    o.pay();                       // 只改了記憶體裡的物件，就這樣
});

// ③ MyBatis
tx.executeWithoutResult(s -> mapper.markPaid(orderId, Instant.now()));
```

**實測產出的 SQL**：

```
── ① JdbcTemplate → 1 句 SQL
   1) UPDATE orders SET status = 'PAID', paid_at = ? WHERE id = ?

── ② Spring Data JPA（沒有呼叫 save） → 2 句 SQL
   1) select oe1_0.id,oe1_0.created_at,oe1_0.currency,oe1_0.customer_id,
             oe1_0.discount_amount,oe1_0.order_no,oe1_0.paid_at,oe1_0.placed_at,
             oe1_0.status,oe1_0.total_amount,oe1_0.updated_at,oe1_0.version
      from orders oe1_0 where oe1_0.id=?
   2) update orders set currency=?,customer_id=?,discount_amount=?,order_no=?,
             paid_at=?,placed_at=?,status=?,total_amount=?,version=?
      where id=? and version=?

── ③ MyBatis → 1 句 SQL
   1) UPDATE orders SET status = 'PAID', paid_at = ? WHERE id = ?
```

**三張訂單跑完之後的狀態**：

```
order_no          status  paid_at                    version
SO-2026-00000001  PAID    2026-09-07T03:11:36.120    0        ← ① JdbcTemplate
SO-2026-00000002  PAID    2026-09-07T03:11:36.139    1        ← ② JPA
SO-2026-00000003  PAID    2026-09-07T03:11:36.159    0        ← ③ MyBatis
```

⚠️⚠️ **這一段輸出裡有四件事值得停下來看**：

**① 沒有呼叫 `save()`，`UPDATE` 還是發出去了。**

這叫**髒檢查（dirty checking）**：JPA 在交易結束時，
會把「載入當下的快照」與「現在的物件」逐欄位比對，有差就自動產生 `UPDATE`。
**03 章會完整處理它**（包含它什麼時候跑、比對的成本、以及怎麼關掉）。

**② JPA 的 `UPDATE` 寫了【九個欄位】，而你只改了兩個。**

`currency`、`customer_id`、`order_no`、`placed_at`、`total_amount`……
這些你根本沒碰的欄位全部被重寫了一遍。這是 Hibernate 的預設行為
（`@DynamicUpdate` 可以改，但它有代價）——**06 章 6.4 會處理**。

> ⚠️ **這件事有一個立即的後果**：
> 如果有另一個交易在你讀出來之後改了 `total_amount`，
> **你的 `UPDATE` 會把它蓋回舊值**——即使你根本沒碰那一欄。
> 擋住這件事的是第 ③ 點。

**③ 只有 JPA 那一列的 `version` 變成 1。**

看 SQL 的最後：`where id=? and version=?`——這是**樂觀鎖**。
JPA 看到 `@Version` 就自動接管了它：讀的時候記住舊版號，
寫的時候用它當條件，並且把新版號 +1。**影響 0 列就拋 `OptimisticLockException`。**

🔴 **而 `JdbcTemplate` 與 MyBatis 那兩句，`version` 停在 0。**
07 站 01 章把 `version BIGINT NOT NULL DEFAULT 0` 寫進 schema 的時候，
**它只是一個欄位**；是 JPA 讓它變成一個機制。
**0.3.5 會示範這個落差怎麼變成一個資料正確性事故。**

**④ 三種寫法的結果「看起來」都對。**

三張訂單都是 `PAID`，都有 `paid_at`。
**如果你的驗收條件只有「狀態有沒有變」，這三個實作全部會通過。**

> 📌 **這就是這一章要講的第一件事**：
> **JPA 不是「幫你把 SQL 寫出來」，而是「幫你決定什麼時候寫、寫什麼」。**
> 而「決定」這個動作，意味著**它有可能決定得跟你想的不一樣**。

⚠️ **一個立刻要面對的問題**：06 站 00 章 0.10.2 那組契約測試裡，有這麼一條：

```java
@Test
void 改了查出來的物件_不應該影響已經存進去的資料() {
    Order saved = repository.save(newOrder("SO-1"));
    Order found = repository.findById(saved.getId()).orElseThrow();
    found.cancel();                                     // ★ 改了，但沒有 save

    Order again = repository.findById(saved.getId()).orElseThrow();
    assertThat(again.getStatus()).isEqualTo(OrderStatus.PENDING);   // ← 期待「沒有生效」
}
```

**這條測試在 fake 上是紅的（06 站抓到的第一個 bug），修好之後在 JDBC 上是綠的。**
**而它在 JPA 上會【再度變紅】。**

📌 06 站 00 章 0.10.3 那張表當時就預告了這件事：

| # | 程式碼 | 在 fake 上 | 在 JDBC 上 | 在 JPA 上 |
|---|---|---|---|---|
| ① | 改了物件但**忘記 `save()`** | 🔴 生效（測試綠） | ✅ 不生效 | ⚠️ **生效**（髒檢查） |

> ⚠️⚠️ **注意這三個答案的順序：生效 / 不生效 / 生效。**
> 從 fake 換到 JDBC，這類 bug 會**暴露**；從 JDBC 換到 JPA，它又**消失**。
>
> 🔴 **而「消失」比「暴露」危險**——因為它讓「忘記 `save()`」的程式碼看起來是對的，
> 直到有一天那個方法被搬到交易外面（**那時 0.3.4 的事故就會發生**）。
>
> **這一站 03 章會把它講完，而處理方式不是「讓它變回去」，
> 是「承認世界觀變了，並且把契約測試改成新世界觀的樣子」。**

---

### 0.3.2 事故二：一支列表 API 打出 251 句 SQL ★★

**需求**：訂單列表頁，每一列要顯示訂單編號、狀態、金額、**客戶名稱**、**明細筆數**。

```java
tx.executeWithoutResult(s -> {
    for (OrderE o : orders.findByStatus("PENDING")) {
        o.getCustomer().getDisplayName();     // 顯示客戶名
        o.getItems().size();                  // 顯示明細筆數
    }
});
```

⚠️ **這段程式碼裡沒有任何一個字看起來像資料庫操作**——
它只是一個迴圈，取兩個屬性。

**20 張訂單的實測**：

```
── JPA：20 張訂單的列表頁 → 共 41 句，3 種形狀
   ×1   select oe1_0.id,...,oe1_0.version from orders oe1_0 where oe1_0.status=?
   ×20  select ce1_0.id,ce1_0.created_at,ce1_0.display_name,ce1_0.email,ce1_0.version
        from customer ce1_0 where ce1_0.id=?
   ×20  select i1_0.order_id,i1_0.id,i1_0.line_amount,i1_0.product_id,
               i1_0.product_name,i1_0.qty,i1_0.unit_price
        from order_item i1_0 where i1_0.order_id=?

── MyBatis：同一頁（一句 JOIN） → 共 1 句，1 種形狀
   ×1   SELECT o.id, o.order_no, o.status, o.total_amount, o.placed_at,
               c.display_name AS customer_name
        FROM orders o JOIN customer c ON c.id = o.customer_id
        WHERE o.status = ? ORDER BY o.placed_at
```

**`1 + 20 + 20 = 41`。這就是 N+1**（準確地說是 1 + 2N）。

**把資料量放大到一頁 200 張訂單**：

```
① JPA 天真寫法           251 句 SQL，66 ms
④ MyBatis 巢狀 resultMap   1 句 SQL，3 ms
```

⚠️ **注意 251 這個數字怎麼來的**：`1 + 200 + 50 = 251`。

- `1` —— 撈 200 張訂單
- `200` —— 每張訂單撈一次明細
- `50` —— 撈客戶。**不是 200，是 50**，因為這批資料只有 50 個客戶，
  而**同一個持久化情境裡，同一個 id 只會查一次**（一級快取，03 章）。

> 📌 **這第三個數字很重要，因為它是「N+1 為什麼在開發環境看不出來」的原因之一**：
> **N+1 的實際句數取決於資料的分布**，而測試資料的分布通常比正式環境「集中」得多。
> 你在本機用 3 個客戶測，看到的是 `1 + 3 + 3 = 7`；
> 正式環境 3 萬個客戶，看到的是 `1 + 200 + 200 = 401`。

⚠️ **這個事故的關鍵不是「JPA 比較慢」，而是**：

> **那段迴圈裡，沒有任何一個字告訴你它會打資料庫。**
>
> `o.getCustomer()` 看起來就是一個 getter。它是一個 getter。
> **只是它背後那個物件是一個代理，而代理的 `getDisplayName()` 會發一句 SQL。**

**04 章會完整處理 N+1**（`JOIN FETCH`、`@EntityGraph`、`@BatchSize`、分頁 + fetch 的陷阱）。
這裡只先建立一個認知：**你需要一個工具，讓「這一頁打了幾句 SQL」變成一個可以斷言的數字**——
那就是 0.10.3 的 `SqlSpy`。

⚠️⚠️ **而且不要把這件事讀成「所以要用 MyBatis」**：
**MyBatis 一樣會 N+1**，0.7 會實測給你看（201 句）。
差別在**你看不看得見**——這是 0.6.1 要處理的問題。

---

### 0.3.3 事故三：`save()` 一筆全新的資料，打出兩句 SQL ★★

```java
tx.executeWithoutResult(s ->
        customers.save(new CustomerE(Uuid7.next(), "new@x.com", "全新的客戶")));
```

**這是一個全新的物件**，`id` 是剛剛才 `Uuid7.next()` 產生的，
資料庫裡不可能有這一筆。**實測**：

```
── customers.save(全新的實體)，id 由應用產生 → 2 句 SQL
   1) select ce1_0.id,ce1_0.created_at,ce1_0.display_name,ce1_0.email,ce1_0.version
      from customer ce1_0 where ce1_0.id=?
   2) insert into customer (display_name,email,version,id) values (?,?,?,?)
```

🔴 **它先去查了一次「這筆存不存在」。**

**放大到 200 筆**：

```
── 200 次 save()，耗時 151 ms → 共 400 句，2 種形狀
   ×200  select ce1_0.id,... from customer ce1_0 where ce1_0.id=?
   ×200  insert into customer (display_name,email,version,id) values (?,?,?,?)
```

**400 句 SQL，其中 200 句是純粹浪費的。**

**為什麼**：Spring Data 的 `save()` 實作大致是這樣（`SimpleJpaRepository`）：

```java
// org.springframework.data.jpa.repository.support.SimpleJpaRepository（示意）
public <S extends T> S save(S entity) {
    if (entityInformation.isNew(entity)) {
        em.persist(entity);       // 直接 INSERT
        return entity;
    } else {
        return em.merge(entity);  // ★ merge 要先知道「資料庫裡現在長怎樣」→ SELECT
    }
}
```

而 `isNew()` 的預設判斷是——**「`@Id` 欄位是不是 `null`」**。

```
主鍵策略                        isNew() 怎麼判斷           save() 的行為
─────────────────────────────────────────────────────────────────────────
@GeneratedValue(IDENTITY)      id == null → 新的          ✅ persist，1 句 INSERT
@GeneratedValue(SEQUENCE)      id == null → 新的          ✅ persist，1 句 INSERT
@Id（應用端指定）★              id != null → 【不是新的】   🔴 merge，SELECT + INSERT
```

⚠️⚠️ **而 07 站 01 章 1.8.4 選的正是「應用端指定的 UUIDv7」。**

也就是說：**這不是一個「新手寫錯」的問題，而是「一個在 07 站有充分理由的決定，
在 08 站產生了一個沒人預期的代價」。**

📌 07 站當時選 UUIDv7 的理由（1.8.4）完全成立：

- 應用端就能產生 id，**不用等資料庫回傳**（對 outbox、對分散式追蹤都重要）
- 時間有序，**不會像 UUIDv4 那樣讓 B+Tree 到處分裂**
- 16 bytes，比 `CHAR(36)` 省一半以上

**這些理由今天依然成立。改變的只是「現在多了一個 ORM，而它用 id 是否為 null 來猜這筆是不是新的」。**

**三種解法**（01 章 1.6 會完整比較，這裡先各講一句）：

```java
// ✅ ① 讓實體自己回答「我是不是新的」—— 實作 Persistable
@Entity @Table(name = "customer")
public class CustomerE implements Persistable<UUID> {
    @Id private UUID id;
    @Transient private boolean isNew = true;          // ★ 不映射到欄位

    @Override public UUID getId() { return id; }
    @Override public boolean isNew() { return isNew; }

    @PostPersist @PostLoad
    void markNotNew() { this.isNew = false; }         // 存過或載入過，就不是新的了
}

// ✅ ② 繞過 Spring Data，直接用 EntityManager
em.persist(newCustomer);        // 明確表達「這是新的」→ 1 句 INSERT

// 🟡 ③ 改用資料庫產生的主鍵
@Id @GeneratedValue(strategy = GenerationType.IDENTITY) private Long id;
//   → 但這會推翻 07 站 1.8.4 的所有理由，而且 IDENTITY 會讓批次插入失效（06 章）
```

**實測 ② 的效果**（0.8.1 的場景 B，建立一張含 3 筆明細的訂單）：

```
── JPA（orders.save，cascade = ALL） → 共 11 句
── JPA（em.persist）                → 共 7 句
```

> 📌 **這個事故要建立的認知**：
> **`save()` 這個名字騙了你。** 它不是「存進去」，它是「把這個物件同步到持久化情境」——
> 而同步的第一步，是**搞清楚資料庫現在是什麼狀態**。
>
> **03 章會把 `persist` / `merge` / `save` 三者的差別講到底。**

---

### 0.3.4 事故四：實體離開交易之後就不能用了

```java
// Service 讀出一張訂單，回傳給 Controller
OrderE o = tx.execute(s -> orders.findById(orderId).orElseThrow());

// Controller 要組回應
System.out.println("orderNo = " + o.getOrderNo());                     // ?
System.out.println("客戶 = "  + o.getCustomer().getDisplayName());     // ?
```

**實測**：

```
交易外能讀到 orderNo = SO-2026-00000001（這是欄位，沒問題）
🔴 org.hibernate.LazyInitializationException
   could not initialize proxy [com.example.lab.jpa.CustomerE#01a06686-b67a-7e19-af43-40baa1890d5b] - no Session
```

⚠️ **注意這個例外的形狀**：

- `getOrderNo()` —— **可以**。那是一個已經載入的欄位。
- `getCustomer().getDisplayName()` —— **炸**。那是一個還沒載入的代理，
  而它需要的那個 `Session` 已經隨著交易結束關掉了。

**同一個物件，有些方法可以呼叫、有些不行，而且「哪些可以」取決於它是怎麼被查出來的。**

> ⚠️ **這是 ORM 最反直覺的一件事**：
> 在 Java 的世界裡，一個物件的方法能不能呼叫，是**編譯期**決定的。
> 在 JPA 的世界裡，多了一個**執行期**的條件：**「你還在那個持久化情境裡嗎」**。
>
> **06 站 00 章 0.4 那張「集合 vs 資料庫」的表，這裡要再加一列**：

| | 記憶體裡的集合 | 資料庫 | **JPA 的實體** |
|---|---|---|---|
| 拿到物件之後 | 隨時可以用 | —— | ⚠️ **只在持久化情境還活著的時候可以完整使用** |

**三種解法**（04 章 4.4 會完整處理）：

```
🔴 ① open-in-view: true（Spring Boot 的預設值）
     → 讓 Session 活到 HTTP 回應寫完。例外消失了，N+1 也跟著搬到 View 層，
       而且連線被佔住的時間變成「整個請求」而不是「交易」（06 站 05 章 5.6）

✅ ② 在交易內就把要用的東西撈好（JOIN FETCH / @EntityGraph）  ← 04 章的主線

✅ ③ 在交易內就轉成 DTO，讓實體【永遠不要】離開資料層         ← 01 章 1.9、09 章的架構建議
```

📌 **本課的 `application.yml` 從第一行就寫死 `open-in-view: false`**，
理由與代價見 0.10.2。

⚠️ **順帶注意**：`open-in-view` 的預設值是 `true`，而且 Spring Boot 啟動時
**會印一行 WARN 提醒你**。那行 WARN 存在的理由，就是這個事故的另一面。

---

### 0.3.5 事故五：兩個框架改同一張表，樂觀鎖靜默失效 ★★

這是**混用**的第一號地雷，而且它非常安靜。

```java
// A 交易讀出訂單（拿到 version = 0），把實體帶出來（例如放進一個非同步流程）
OrderE detached = tx.execute(s -> {
    OrderE o = orders.findById(id).orElseThrow();
    em.detach(o);
    return o;
});

// B 用 MyBatis 直接改同一張訂單
tx.executeWithoutResult(s -> mapper.markPaid(id, Instant.now()));

// A 現在拿手上那個【舊的】實體寫回去
tx.executeWithoutResult(s -> {
    detached.setStatus("CANCELLED");
    orders.save(detached);
});
```

**這正是樂觀鎖要擋的情境**：A 讀了、B 改了、A 用舊資料覆蓋。

**實測**：

```
初始 version = 0
A 手上的實體 version = 0
B（MyBatis）改完，DB 的 version = 0，status = PAID
🔴 A 的寫入【成功】了 —— 樂觀鎖沒有擋住
最後 DB 狀態：[{status=CANCELLED, paid_at=null, version=1}]
```

⚠️⚠️ **看最後那一列，三件事同時發生了**：

1. **B 的 `PAID` 不見了** —— 被 A 蓋回 `CANCELLED`
2. **`paid_at` 變回 `null`** —— A 手上那個實體的 `paid_at` 是 `null`（0.3.1 講過：JPA 寫全部欄位）
3. **`version` 是 1** —— 看起來「有經過樂觀鎖」，實際上它從 0 跳到 1，
   而中間 B 的那次修改**完全沒有留下痕跡**

**為什麼擋不住**：

```
時間軸                            DB.version    A 手上的 version
─────────────────────────────────────────────────────────────────
A 讀出來                              0                0
B 用 MyBatis UPDATE（不碰 version）    0  ← 🔴 沒有 +1     0
A 寫回：WHERE id=? AND version=0      0  ← 條件成立！      0
                                      ↓
                                      1
```

> 🔴 **樂觀鎖的整個機制，建立在「每一次寫入都會讓 version +1」這個前提上。**
> **只要有一個寫入路徑不遵守這個約定，整個機制就靜默失效。**
>
> 而 `JdbcTemplate` 與 MyBatis **預設不遵守**——因為它們根本不知道 `version` 是幹嘛的
> （0.3.1 已經看過：那兩句 `UPDATE` 之後 `version` 都停在 0）。

**解法**（09 章 9.5 會完整處理混用的規則，這裡先給結論）：

```sql
-- ✅ 所有【非 JPA】的寫入路徑，都必須自己維護 version
UPDATE orders
   SET status = 'PAID', paid_at = ?, version = version + 1
 WHERE id = ? AND version = ?;
--                          ↑ 而且要自己檢查影響列數，0 列就要當成衝突處理
```

⚠️ **注意這個解法的代價**：你把一個「框架自動處理的機制」變成了
「**每一個工程師在每一句 UPDATE 都要記得的約定**」。
**這種約定的壽命，通常等於寫下它的那個人待在團隊的時間。**

> 📌 **所以 0.9 那三條混用規則的第一條會是**：
> **同一張表，只讓一個框架寫。** 讀可以兩邊都來，**寫只能有一個主人。**

---

### 0.3.6 事故六：一個 `${}` 讓 `WHERE` 條件整個消失

MyBatis 有兩種參數寫法，長得幾乎一樣：

```java
@Select("... WHERE o.status = #{status}")     // ← 井字號
@Select("... WHERE o.status = '${status}'")   // ← 錢字號
```

**兩者在正常輸入下的行為完全相同**：

```
正常呼叫（#{}）：2 筆
正常呼叫（${}）：2 筆
```

**傳入 `PENDING' OR '1'='1`**：

```
── 傳入 PENDING' OR '1'='1 → 1 句 SQL
   1) SELECT o.id, o.order_no, o.status, o.total_amount, o.placed_at,
             c.display_name AS customer_name
      FROM orders o JOIN customer c ON c.id = o.customer_id
      WHERE o.status = 'PENDING' OR '1'='1'
   撈到 2 筆（資料庫裡總共 2 筆）        ← 🔴 WHERE 條件形同不存在

── 同樣的輸入走 #{} → 1 句 SQL
   1) ... WHERE o.status = ? ORDER BY o.placed_at
   撈到 0 筆                             ← ✅ 它就只是一個查不到的字串
```

**差別在哪**：

```
#{status}   →  產生 ?，值透過 PreparedStatement.setString() 送出   ← 值就只是值
${status}   →  【字串拼接】，直接變成 SQL 文字的一部分              ← 值可以變成語法
```

⚠️ **這個事故跟前面五個不一樣**：前五個是「世界觀差異造成的意外」，
**這一個是「一個看起來只差一個字元的選擇，造成的安全漏洞」**。

📌 **但它為什麼要放進這一章**，而不是留到 07 章講 MyBatis 語法時再說？

> 因為它示範了 SQL Mapper 這個世界觀的**代價的另一面**：
> **當 SQL 由你掌控，SQL 的每一個坑也由你負責。**
>
> JPA 這一側沒有 `${}` 這個問題——因為**你根本沒有機會拼接 SQL 字串**。
> 這不是「JPA 比較安全」，這是「**JPA 沒有給你這個自由，所以也沒有這個風險**」。
> **0.6.1 會把這個取捨講清楚。**

⚠️ **`${}` 不是一個「絕對不能用」的東西**——有些地方**只能**用它：

```java
// 🔴 這些位置不能參數化，因為它們不是「值」，是「語法」
ORDER BY ${sortColumn} ${sortDirection}
SELECT * FROM ${tableName}
```

06 站 00 章 0.11.4 已經講過這件事的正解：**對照表，而不是字串檢查**。
**07 章 7.6 會用 MyBatis 的語法把它完整寫一次。**

---

### 0.3.7 六個事故的共同形狀

把六個攤在一起：

| # | 事故 | 表面症狀 | 真正的原因 | 哪一章處理 |
|---|---|---|---|---|
| 1 | 沒 `save()` 資料卻改了 | 契約測試變紅 | **髒檢查**：JPA 決定什麼時候寫 | 03 |
| 2 | 列表頁 251 句 SQL | 頁面變慢 | **延遲載入**：getter 背後是 SQL | 04 |
| 3 | `save()` 打兩句 SQL | 寫入量翻倍 | **`isNew()` 用 id 是否為 null 猜** | 01、03 |
| 4 | 交易外用實體就炸 | `LazyInitializationException` | **物件的可用性綁在持久化情境上** | 03、04 |
| 5 | 樂觀鎖靜默失效 | 資料被覆蓋，沒有任何錯誤 | **`version` 的約定只有 JPA 遵守** | 06、09 |
| 6 | `${}` 讓 `WHERE` 消失 | SQL Injection | **SQL 由你掌控 = 風險由你承擔** | 07 |

**看第四欄。六個原因可以歸成三句話**：

```
① JPA 把「什麼時候寫、寫什麼」的決定權拿走了      → 事故 1、3、5
② JPA 把「這個屬性從哪來」變成執行期的問題        → 事故 2、4
③ MyBatis 把 SQL 的全部權力【與責任】還給你       → 事故 6
```

⚠️⚠️ **而這三句話，就是這一站要教的全部東西**：

> **ORM 與 SQL Mapper 的差別，不在語法，在【決定權在誰手上】。**
>
> - **JPA 拿走決定權，換來的是「你不用管」**——直到它決定得跟你想的不一樣。
> - **MyBatis 把決定權還給你，換來的是「你什麼都要管」**——包含你不知道自己需要管的那些。
>
> **兩邊都不是免費的。這一站要教的，是讓你知道自己付的是哪一種代價。**

📌 **還有一個共同點值得單獨拉出來**：

```
六個事故裡，有【五個】在單機、小資料量、單執行緒的開發環境下完全看不出來。
```

| # | 在本機測得出來嗎 |
|---|---|
| 1 沒 `save()` 卻生效 | 🔴 **看不出來**——結果是「對的」，只是不該對 |
| 2 251 句 SQL | 🔴 **看不出來**——3 筆測試資料只會多 6 句，快得像沒發生 |
| 3 `save()` 兩句 SQL | 🔴 **看不出來**——結果完全正確，只是慢一倍 |
| 4 `LazyInitializationException` | ✅ **看得出來**——它會直接炸 |
| 5 樂觀鎖失效 | 🔴 **看不出來**——需要兩個交易交錯才會發生 |
| 6 `${}` | 🔴 **看不出來**——正常輸入下行為一模一樣 |

> 📌 **這正是 06 站 00 章 0.3.4 那個結論的延續**：
> **「之後再調效能」的前提是「之後看得出來」。**
>
> **所以這一站從第 00 章就開始建 `SqlSpy`（0.10.3）**——
> 因為上面那五個「看不出來」裡，有三個（事故 1、2、3）
> **只要你能數 SQL，它們就會變成「看得出來」。**

---
## 0.4 三個名字：JPA、Hibernate、Spring Data JPA ★

實務上這三個字幾乎被當成同義詞用。**它們不是。**
而且分不清楚它們會造成三種具體的困擾：

```
🔴 查資料查到一半，發現看的文章講的是另一層的東西
🔴 遇到問題不知道該去哪個專案的 issue tracker 找答案
🔴 面試被問「JPA 跟 Hibernate 差在哪」，答不出來
```

### 0.4.1 一句話定位

```
┌─────────────────────────────────────────────────────────────┐
│  Spring Data JPA        「我幫你把 Repository 介面實作出來」    │
│  （org.springframework.data:spring-data-jpa）                │
│   ↓ 它底下呼叫的是 ↓                                          │
├─────────────────────────────────────────────────────────────┤
│  Jakarta Persistence    「這是規格。EntityManager 該長這樣」   │
│  （jakarta.persistence:jakarta.persistence-api）             │
│   ↑ 規格只有介面與註解，沒有任何可以執行的東西 ↑                 │
├─────────────────────────────────────────────────────────────┤
│  Hibernate ORM          「我來實作這份規格，順便多給你一些東西」 │
│  （org.hibernate.orm:hibernate-core）                        │
│   ↓ 它產生 SQL，交給 ↓                                        │
├─────────────────────────────────────────────────────────────┤
│  JDBC + Driver          「我把 SQL 送到資料庫」                │
└─────────────────────────────────────────────────────────────┘
```

用一句話各自定位：

| 名字 | 它是什麼 | 誰做的 | 沒有它會怎樣 |
|---|---|---|---|
| **Jakarta Persistence**（舊名 JPA） | **一份規格**。只有介面、註解、與一份 PDF 說明書 | Eclipse Foundation（原 Oracle / JCP） | 每一家 ORM 的 API 都不一樣，換一家等於重寫 |
| **Hibernate ORM** | **一個實作**。真的會產生 SQL 的那個 | Red Hat | 規格只是一堆介面，跑不起來 |
| **Spring Data JPA** | **一層抽象**。把「寫 Repository 實作」這件事自動化 | VMware / Spring 團隊 | 你要自己寫 `SimpleJpaRepository` 裡那些 `em.find(...)` |

⚠️ **注意第三列的措辭：Spring Data JPA 不是 ORM，它是「ORM 的使用者」。**
你把它拿掉，JPA 還是可以用（0.4.2 的寫法 ①）；
你把 Hibernate 拿掉，**什麼都不剩**。

**實測：四個名字對應四個 jar**

```
jakarta.persistence.EntityManager
  → .m2/repository/jakarta/persistence/jakarta.persistence-api/3.1.0/jakarta.persistence-api-3.1.0.jar
org.hibernate.Session
  → .m2/repository/org/hibernate/orm/hibernate-core/6.4.4.Final/hibernate-core-6.4.4.Final.jar
org.springframework.data.jpa.repository.JpaRepository
  → .m2/repository/org/springframework/data/spring-data-jpa/3.2.5/spring-data-jpa-3.2.5.jar
org.apache.ibatis.session.SqlSession
  → .m2/repository/org/mybatis/mybatis/3.5.14/mybatis-3.5.14.jar
```

📌 **一個 `spring-boot-starter-data-jpa` 就把前三個一起拉進來了**，
所以大多數人從來沒有機會意識到它們是三個東西。

### 0.4.2 實測：同一件事的三個層次

**需求還是那個「把訂單標記為已付款」。三種寫法**：

```java
// ① 規格：只用 jakarta.persistence 的 API
tx.executeWithoutResult(s -> {
    OrderE o = em.find(OrderE.class, id);         // ← jakarta.persistence.EntityManager
    o.pay();
});

// ② 實作：Hibernate 專有 API
tx.executeWithoutResult(s -> {
    Session session = em.unwrap(Session.class);   // ← org.hibernate.Session
    OrderE o = session.get(OrderE.class, id);
    o.pay();
});

// ③ 抽象：Spring Data JPA
tx.executeWithoutResult(s -> orders.findById(id).ifPresent(OrderE::pay));
```

**三者產出的 SQL**：

```
── ① JPA 規格（jakarta.persistence.EntityManager） → 2 句 SQL
   1) select oe1_0.id,oe1_0.created_at,...,oe1_0.version from orders oe1_0 where oe1_0.id=?
   2) update orders set currency=?,customer_id=?,discount_amount=?,order_no=?,paid_at=?,
             placed_at=?,status=?,total_amount=?,version=? where id=? and version=?

── ② Hibernate 實作（org.hibernate.Session） → 2 句 SQL
   1) select oe1_0.id,oe1_0.created_at,...,oe1_0.version from orders oe1_0 where oe1_0.id=?
   2) update orders set currency=?,customer_id=?,discount_amount=?,order_no=?,paid_at=?,
             placed_at=?,status=?,total_amount=?,version=? where id=? and version=?

── ③ Spring Data JPA（OrderRepo） → 2 句 SQL
   1) select oe1_0.id,oe1_0.created_at,...,oe1_0.version from orders oe1_0 where oe1_0.id=?
   2) update orders set currency=?,customer_id=?,discount_amount=?,order_no=?,paid_at=?,
             placed_at=?,status=?,total_amount=?,version=? where id=? and version=?
```

⚠️ **一字不差。三種寫法，同一句 SQL。**

> 📌 **這個實測要建立的認知**：
> **`orders.findById()` 不是「另一種查法」，它就是 `em.find()`，只是外面包了一層。**
>
> 所以當你的 Spring Data 查詢產生了奇怪的 SQL，
> **去 Hibernate 的文件與 issue 找答案，不是 Spring Data 的**——
> 因為 SQL 是 Hibernate 產的，Spring Data 從頭到尾沒有碰過 SQL 字串。

### 0.4.3 實測：這些「沒有實作的介面」執行期是什麼

`OrderRepo` 是一個**介面**，你沒有寫任何實作類別，
但 `@Autowired` 進來就能用。**它到底是什麼**：

```
  em             → jdk.proxy2.$Proxy102
  em.unwrap      → jdk.proxy2.$Proxy102
  emf            → jdk.proxy2.$Proxy98
  orders(介面)    → com.example.lab.jpa.OrderRepo
  orders(實例)    → jdk.proxy2.$Proxy109
  orders 的目標   → org.springframework.data.jpa.repository.support.SimpleJpaRepository
```

**拆開來看**：

| 你拿到的東西 | 執行期的真實身分 | 誰做的 |
|---|---|---|
| `EntityManager em` | **JDK 動態代理**，每次呼叫都去找「當前交易綁定的那個真的 EntityManager」 | Spring（`SharedEntityManagerCreator`） |
| `OrderRepo orders` | **JDK 動態代理**，目標是 `SimpleJpaRepository` | Spring Data（`JpaRepositoryFactory`） |

⚠️ **`em` 是代理這件事很重要**，因為它解釋了一個常見的困惑：

```java
@PersistenceContext                    // 或 @Autowired
private EntityManager em;              // ★ 這是一個【單例】的欄位

// 但 EntityManager 不是執行緒安全的，為什麼可以當單例注入？
```

**因為它不是真的 `EntityManager`，是一個代理**。
每一次你呼叫 `em.find(...)`，代理會去 `TransactionSynchronizationManager`
拿「當前執行緒、當前交易」綁定的那一個真的 `EntityManager`。

> 📌 這跟 02-spring-boot 站講的 AOP 代理是同一套機制。
> **06 站 00 章 0.9.3 那個「`new JdbcOrderRepository(...)` 的話 `MANDATORY` 沒有作用」的坑，
> 在這裡是同一個原因**——繞過 Spring，代理就不存在。

**`SimpleJpaRepository` 是理解 Spring Data 的關鍵**。
0.3.3 已經看過它的 `save()`；它的 `findById()` 長這樣：

```java
// org.springframework.data.jpa.repository.support.SimpleJpaRepository（示意）
public Optional<T> findById(ID id) {
    Assert.notNull(id, "The given id must not be null");
    Class<T> domainType = getDomainClass();
    // ...省略 metadata / hints 的處理...
    return Optional.ofNullable(em.find(domainType, id));      // ★ 就是 em.find
}
```

**那 `findByStatus(String)` 呢？那個方法 `SimpleJpaRepository` 裡沒有。**

📌 **06 站 03 章 3.2「沒有實作的介面是怎麼跑起來的」已經完整處理過這件事**，
一句話複習：**Spring Data 在啟動時解析方法名，產生一個 `PartTreeJpaQuery`，
把 `findByStatus` 翻譯成 JPQL `select o from OrderE o where o.status = ?1`**，
代理攔截到這個方法時就執行那個查詢。

⚠️ **「啟動時」這三個字很重要**：方法名打錯是**啟動失敗**，不是執行期才炸。
**0.5.3 會把這件事跟 MyBatis 並排實測一次**——兩邊的答案不一樣。

### 0.4.4 `javax` → `jakarta`：那個把所有舊教學變成過期的改名

如果你在網路上找 JPA 教學，**你會看到兩種第一行**：

```java
import javax.persistence.Entity;      // 🔴 2019 年以前的世界
import jakarta.persistence.Entity;    // ✅ 現在
```

**這不是「新舊寫法」，是兩個不同的套件，完全不相容。**

**發生了什麼**：

```
2017  Oracle 把 Java EE 捐給 Eclipse Foundation
2018  改名為 Jakarta EE（因為 Oracle 保留 "Java" 商標）
2019  Jakarta EE 8 發布 —— ★ 套件名還是 javax.*（協議上只能沿用，不能修改）
2020  Jakarta EE 9  —— ★★ javax.* 全部改名成 jakarta.*
      這一版【沒有任何新功能】，唯一的內容就是改名
2022  Spring Framework 6 / Spring Boot 3 —— 只支援 jakarta.*，不再支援 javax.*
      Hibernate 6 —— 只支援 jakarta.*
```

⚠️ **對你的實際影響**：

| 你在用 | 那你要看的 import | 你能用的 Hibernate |
|---|---|---|
| Spring Boot 2.x | `javax.persistence.*` | Hibernate 5.x |
| **Spring Boot 3.x（本課）** | **`jakarta.persistence.*`** | **Hibernate 6.x** |

> 🔴 **這是一個「無聲的搜尋陷阱」**：
> 你 Google「JPA @OneToMany 教學」，前十筆有八筆是 2018～2021 年的文章，
> **它們的程式碼在 Spring Boot 3 上一行都跑不了**——
> 而錯誤訊息是 `package javax.persistence does not exist`，
> 不會有任何人告訴你「你看的是舊世界的文章」。
>
> 📌 **一個實用的過濾技巧**：搜尋時直接加上 `jakarta`，
> 或是把時間範圍限制在 2023 年之後。

**另一個要小心的地方**：`jakarta.persistence` 與 `jakarta.validation` 是**兩份不同的規格**，
改名時間也不同。04-controller 站用的 `@NotNull` / `@Size` 來自 `jakarta.validation`，
跟這一站的 `@Column` / `@Entity` 沒有關係——**但它們常常出現在同一個類別上**：

```java
import jakarta.persistence.*;      // Entity、Column、Id……
import jakarta.validation.constraints.*;   // NotNull、Size……   ★ 兩份不同的規格

@Entity @Table(name = "customer")
public class CustomerE {
    @Id private UUID id;
    @Column(nullable = false) @NotNull @Size(max = 255)     // ★ 一個給 DDL，一個給驗證
    private String email;
}
```

⚠️ **`@Column(nullable = false)` 與 `@NotNull` 不是同一件事**：

```
@Column(nullable = false)  →  影響【Hibernate 產生 DDL】時的 NOT NULL；
                              本課 ddl-auto: none，所以它【什麼都不做】
@NotNull                   →  Bean Validation。Hibernate 在 flush 前會跑一次，
                              不通過就拋 ConstraintViolationException（不會送到資料庫）
```

**01 章 1.11 會完整處理這兩者的分工，以及它們跟 07 站那份 schema 的關係。**

### 0.4.5 版本對照表

**這張表是這一站的環境基準**，也是你之後查資料時的座標：

| 你在用 | Jakarta Persistence | Hibernate | Spring Data JPA | 套件名 |
|---|---|---|---|---|
| Spring Boot 2.7 | JPA 2.2 | 5.6 | 2.7 | `javax.persistence` |
| Spring Boot 3.0 / 3.1 | 3.1 | 6.1 / 6.2 | 3.0 / 3.1 | `jakarta.persistence` |
| **Spring Boot 3.2（本課）** | **3.1** | **6.4** | **3.2** | **`jakarta.persistence`** |
| Spring Boot 3.3 / 3.4 | 3.1 / 3.2 | 6.5 / 6.6 | 3.3 / 3.4 | `jakarta.persistence` |

**本課實測的確切版本**（0.10 的專案跑出來的）：

```
  jakarta.persistence 規格 → 3.1.0
  Hibernate                → 6.4.4.Final
  Spring Data JPA          → 3.2.5
  MyBatis                  → 3.5.14
  Spring Boot              → 3.2.5
```

📌 **Jakarta Persistence 3.1 帶進來一個跟這一站直接相關的東西**：

```java
// JPA 3.1 新增的主鍵策略（JPA 3.0 以前沒有）
@Id @GeneratedValue(strategy = GenerationType.UUID)
private UUID id;
```

**實測 `GenerationType` 現在有五個值**：

```
GenerationType.TABLE
GenerationType.SEQUENCE
GenerationType.IDENTITY
GenerationType.UUID        ← ★ JPA 3.1 新增
GenerationType.AUTO
```

⚠️ **但 `GenerationType.UUID` 產生的是 UUIDv4，不是 07 站要的 UUIDv7**——
所以本課還是自己產生 id（`Uuid7.next()`），也就一起繼承了 0.3.3 那個 `merge` 問題。
**01 章 1.6 會把「主鍵策略」的五個選項與各自的代價完整比較。**

### 0.4.6 你的程式碼該寫在哪一層

看一眼本課實體類別的**所有** import：

```
import jakarta.persistence.*;         ← 全部的註解都來自這裡
import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
```

⚠️ **一個 `org.hibernate.*` 都沒有。** 這是刻意的。

**一條實務原則**：

```
✅ 預設寫規格的 API（jakarta.persistence）
      → em.find / em.persist / @Entity / @Column / JPQL

✅ Repository 介面用 Spring Data
      → 它省下的樣板程式碼是真的，而且它【不會擋住】你往下鑽

🟡 需要 Hibernate 專有功能時，明確地、局部地用它
      → @BatchSize、@SQLRestriction、Statistics、Session.doWork(...)
      → ★ 而且要在程式碼裡【註明】為什麼需要它

🔴 不要「因為看到範例這樣寫」就 em.unwrap(Session.class)
```

**為什麼**：不是因為「換 ORM 很重要」（實務上幾乎沒人換），
而是因為 —— **規格 API 的行為是被文件定義的，Hibernate 專有 API 的行為是被實作定義的**。
後者升級時比較容易變。

⚠️ **但也不要走到另一個極端**。有些事**只有** Hibernate 做得到，
而為了「保持可攜性」放棄它們是本末倒置：

| 只有 Hibernate 有的 | 為什麼你會需要 | 哪一章 |
|---|---|---|
| `@BatchSize` | N+1 的第三種解法 | 04 |
| `Statistics` | **在測試裡斷言「這一頁只能打 3 句 SQL」** | 00（0.10.3 的替代方案）、04 |
| `@SQLRestriction`（舊名 `@Where`） | 軟刪除的過濾（07 站 1.10.4） | 01 |
| `hibernate.jdbc.batch_size` | 批次插入 | 06 |
| `@DynamicUpdate` | 只寫改過的欄位（0.3.1 那九個欄位） | 06 |

> 📌 **這一站的立場**：
> **規格是預設值，不是教條。用到 Hibernate 專有功能時，
> 在程式碼裡寫一行註解說明理由——這樣三年後的人才知道那不是隨手寫的。**

---

## 0.5 MyBatis 的定位：它不是 ORM ★

### 0.5.1 三個名字（又是三個）

```
mybatis                          核心。SqlSession、Mapper、動態 SQL、TypeHandler
  ↑
mybatis-spring                   把 MyBatis 接進 Spring：交易同步、Mapper 變成 Bean
  ↑
mybatis-spring-boot-starter      自動組態：掃描 @Mapper、讀 application.yml 的設定
```

⚠️ **注意版本號的獨立性**：本課用的是
`mybatis-spring-boot-starter:3.0.3`，它拉進來的是 `mybatis:3.5.14` 與 `mybatis-spring:3.0.3`。
**這三個版本號沒有對齊，而且 MyBatis 不在 Spring Boot 的 BOM 裡**——
所以你**必須自己寫版本號**：

```xml
<!-- ⚠️ Spring Boot 的 dependencyManagement 不管 MyBatis，版本要自己指定 -->
<dependency>
  <groupId>org.mybatis.spring.boot</groupId>
  <artifactId>mybatis-spring-boot-starter</artifactId>
  <version>3.0.3</version>            <!-- ★ 這一行不能省 -->
</dependency>
```

📌 **對照組**：`spring-boot-starter-data-jpa` 不用寫版本號，
因為它在 Spring Boot 的 BOM 裡。**這個差別會在升級 Spring Boot 時咬你一口**——
Boot 升上去了，MyBatis starter 還停在舊版，而**相容性要你自己查**。

**對照表**（MyBatis 官方的相容矩陣，本課只需要記最後一列）：

| mybatis-spring-boot-starter | Spring Boot | MyBatis-Spring | Java |
|---|---|---|---|
| 2.2.x / 2.3.x | 2.5 / 2.7 | 2.x | 8+ |
| **3.0.x（本課）** | **3.0 ～ 3.2** | **3.0** | **17+** |

### 0.5.2 為什麼說它「不是 ORM」

**ORM（Object-Relational Mapping）這個詞裡的 M，指的是「映射」——
把【物件圖】與【關聯式資料表】兩種結構互相對應起來。**

**MyBatis 做的事比這個小得多**：

```
ORM（Hibernate）做的事：
  ① 把 SQL 產生出來                              ★ MyBatis 不做
  ② 把結果集變成物件                              ✅ MyBatis 做
  ③ 追蹤物件的狀態變化，自動產生 UPDATE            ★ MyBatis 不做
  ④ 管理物件的身分（同一列 = 同一個實例）           ★ MyBatis 不做
  ⑤ 管理關聯的載入時機（lazy / eager）             🟡 MyBatis 有簡化版
  ⑥ 決定寫入的順序與時機（flush、ActionQueue）      ★ MyBatis 不做
```

⚠️ **MyBatis 官方自己的定位是「SQL Mapper」**，而不是 ORM：

> **它映射的不是「物件與資料表」，是「SQL 的參數與結果」和「Java 的方法簽章」。**

**看一眼就懂了**：

```java
@Select("SELECT o.id, o.order_no, o.status, o.total_amount, o.placed_at, "
      + "       c.display_name AS customer_name "
      + "FROM orders o JOIN customer c ON c.id = o.customer_id "
      + "WHERE o.status = #{status}")
List<OrderRow> findByStatus(@Param("status") String status);
```

```
  #{status}        ←→   方法的 status 參數        （參數映射）
  一列結果          ←→   一個 OrderRow            （結果映射）
  customer_name    ←→   OrderRow.customerName    （欄位映射，靠底線轉駝峰）
```

📌 **注意 `OrderRow` 這個類別的性質**：

```java
public class OrderRow {
    private UUID id;
    private String orderNo;
    private String status;
    private BigDecimal totalAmount;
    private Instant placedAt;
    private String customerName;      // ← 來自 customer 表，不屬於 orders
}
```

> **它不對應任何一張表。它對應的是【這一句 SQL 的結果形狀】。**
>
> 這是 MyBatis 世界觀的核心：
> **不存在「Order 這個實體」，只存在「這一次查詢我要什麼形狀的資料」。**
> 同一張 `orders` 表，列表頁用 `OrderRow`、詳情頁用 `OrderDetailRow`、
> 報表用 `CustomerSalesRow`——**三個類別，互相沒有關係，這是正常的。**

⚠️ **這也解釋了為什麼 MyBatis 的專案常常「類別很多」**——
它們不是重複，是**不同查詢的不同形狀**。

### 0.5.3 實測：`@Mapper` 介面執行期是什麼

跟 `OrderRepo` 一樣，`OrderMapper` 也是一個沒有實作的介面：

```
  mapper(介面)    → com.example.lab.mybatis.OrderMapper
  mapper(實例)    → jdk.proxy2.$Proxy116
  mapper 是 JDK proxy？ true
  mapper 的 handler → org.apache.ibatis.binding.MapperProxy
```

**兩邊都是 JDK 動態代理，但代理背後的東西完全不同**：

| | Spring Data JPA | MyBatis |
|---|---|---|
| 代理類別 | `jdk.proxy2.$Proxy109` | `jdk.proxy2.$Proxy116` |
| 攔截器 | Spring AOP `→ SimpleJpaRepository` + `PartTreeJpaQuery` | `org.apache.ibatis.binding.MapperProxy` |
| 方法怎麼變成 SQL | **解析方法名**，產生 JPQL，再由 Hibernate 產生 SQL | **查 `MappedStatement` 註冊表**，拿出你寫的 SQL |
| SQL 從哪來 | Hibernate 產生 | **你寫的**（註解或 XML） |
| 打錯字什麼時候發現 | **啟動時** | 🔴 **呼叫時** |

⚠️ **最後一列是一個真實的、而且比想像中更大的差異。實測兩邊各打錯一次**：

**Spring Data：欄位名打錯**

```java
public interface BadRepo extends JpaRepository<OrderE, UUID> {
    List<OrderE> findByStatuz(String s);       // ★ status 打成 statuz
}
```

```
org.springframework.beans.factory.BeanCreationException:
  Error creating bean with name 'badRepo' ...
Caused by: org.springframework.data.repository.query.QueryCreationException:
  Could not create query for ... BadRepo.findByStatuz(java.lang.String)
Caused by: org.springframework.data.mapping.PropertyReferenceException:
  No property 'statuz' found for type 'OrderE'; Did you mean 'status'
```

✅ **應用【啟動不起來】**，而且它直接告訴你「你是不是要打 `status`」。

**MyBatis：介面上有一個 XML 裡不存在的方法**

```java
@Mapper
public interface OrderDetailMapper {
    List<OrderDetailRow> listJoined(@Param("status") String status);
    /** ⚠️ 這個方法在 XML 裡【沒有】對應的 statement。 */
    List<OrderDetailRow> methodWithNoStatement(@Param("status") String status);
}
```

```
═══ 應用【啟動成功】了嗎？ → 是（你正在看這行）═══
🔴 呼叫的時候才炸：org.apache.ibatis.binding.BindingException
   Invalid bound statement (not found): com.example.lab.mybatis.OrderDetailMapper.methodWithNoStatement
```

🔴 **應用照常啟動、健康檢查照常通過、其他 API 照常運作**——
**只有走到那一行的那個請求會爆 500。**

⚠️ 而 SQL 內容本身的錯誤（欄位名打錯、JOIN 條件寫反）**更晚**：

```java
@Select("SELECT * FROM orders WHERE statuz = #{status}")     // 🔴 Unknown column 'statuz'
List<OrderRow> findByStatus(@Param("status") String status);
```

這一句要等到**真的送到 MySQL** 才會知道錯了。

> 📌 **這是選型判準之一（0.8.2 判準 5）**：
> **MyBatis 把 SQL 的正確性推遲到執行期，所以它【更需要】測試。**
> 一個沒有資料層測試的 MyBatis 專案，等於把「SQL 對不對」交給使用者去發現。
>
> **06 站 06 章那組「跑在真 MySQL 上」的資料層測試，在 MyBatis 專案裡不是加分項，是必需品。**

**一句 SQL 的完整路徑**：

```
你呼叫 orderMapper.findByStatus("PENDING")
   ↓
MapperProxy.invoke()                    ← JDK 動態代理攔截
   ↓
MapperMethod.execute()                  ← 判斷是 SELECT / INSERT / UPDATE / DELETE
   ↓
SqlSession.selectList("com.example.lab.mybatis.OrderMapper.findByStatus", args)
   ↓                                      ★ 這個字串就是 MappedStatement 的 id
Configuration.getMappedStatement(id)    ← 從註冊表拿出你寫的 SQL
   ↓
BoundSql                                ← 動態 SQL（<if>、<foreach>）在這一步展開
   ↓
Executor  →  StatementHandler  →  ParameterHandler（#{} 用 TypeHandler 綁參數）
   ↓
java.sql.PreparedStatement.execute()
   ↓
ResultSetHandler（用 resultMap / resultType 把列變成物件）
   ↓
List<OrderRow>
```

⚠️ **注意這條路徑上【沒有】的東西**：

```
沒有「持久化情境」          → 回傳的物件是普通 POJO，改了它什麼事都不會發生
沒有「髒檢查」              → 你不呼叫 update，就沒有 UPDATE
沒有「身分管理」            → 查兩次同一列，回來兩個【不同】的物件
沒有「flush 時機」          → 呼叫 mapper 方法，SQL 就送出去了
```

📌 **這四個「沒有」，就是 0.6 那六個根本差異的一半。**

### 0.5.4 實測：誰知道 `UUID` 該怎麼變成 `BINARY(16)` ★

07 站 01 章選了 `BINARY(16)` 存 UUIDv7。**現在來看三個框架各自怎麼處理它。**

```java
// ① 沒有 TypeHandler —— 把 UUID 交給 MyBatis 的預設處理
@Update("UPDATE orders SET status = 'PAID', paid_at = #{paidAt} "
      + "WHERE id = #{id, typeHandler=org.apache.ibatis.type.ObjectTypeHandler}")
int markPaidNoHandler(@Param("id") UUID id, @Param("paidAt") Instant paidAt);

// ② 有 TypeHandler
@Update("UPDATE orders SET status = 'PAID', paid_at = #{paidAt} WHERE id = #{id}")
int markPaid(@Param("id") UUID id, @Param("paidAt") Instant paidAt);
```

**實測**：

```
── 同樣一句 UPDATE，差別只在「誰把 UUID 轉成位元組」
① 沒有 TypeHandler → 影響 0 列   🔴 不報錯，只是【什麼都沒發生】
② 有 TypeHandler   → 影響 1 列
③ JPA：完全沒有這個問題（Hibernate 內建 UUID ↔ binary(16)）
```

⚠️⚠️ **`影響 0 列`，而且【沒有任何例外】。**

`ObjectTypeHandler` 走的是 `PreparedStatement.setObject(i, uuid)`，
驅動把 `UUID` 當成一個不認識的物件，最後用它的**字串形式**送出去。
`'01a06686-b67a-7e19-af43-40baa1890d5b'` 這個字串，
跟 `BINARY(16)` 欄位裡那 16 個位元組**當然對不起來**——
於是 `WHERE` 條件不成立，`UPDATE` 影響 0 列，**一切風平浪靜**。

📌 **如果那個方法的回傳型別是 `void`（很常見），你連 `0` 都看不到。**

**正解：寫一個 `TypeHandler`**：

```java
package com.example.lab.mybatis;

import com.example.lab.Uuid7;
import org.apache.ibatis.type.*;

import java.sql.*;
import java.util.UUID;

/**
 * ★ JPA 知道 UUID 該怎麼存進 BINARY(16)；MyBatis 不知道。
 *   沒有這個 TypeHandler，`WHERE id = #{id}` 會送出一個【字串】，
 *   跟 BINARY(16) 比對不上 —— 不會報錯，只會【更新 0 列】。
 */
@MappedTypes(UUID.class)
public class UuidTypeHandler extends BaseTypeHandler<UUID> {

    @Override
    public void setNonNullParameter(PreparedStatement ps, int i, UUID p, JdbcType t) throws SQLException {
        ps.setBytes(i, Uuid7.toBytes(p));
    }

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
  type-handlers-package: com.example.lab.mybatis     # ★ 註冊它
```

**三個框架在這件事上的立場**：

| | 誰負責轉換 | 忘了會怎樣 |
|---|---|---|
| `JdbcTemplate`（06 站） | **你**，每一次呼叫都要寫 `Uuid7.toBytes(id)` | 🟡 編譯期就錯（型別對不上） |
| **MyBatis** | **你**，寫一次 `TypeHandler`，全域生效 | 🔴 **靜默失敗**，影響 0 列 |
| **JPA / Hibernate** | **框架**，內建 `UUID` ↔ `binary(16)` | ✅ 不會發生 |

> 📌 **這是 0.6 那六個差異裡「誰決定」這條軸的一個小切面**：
> **JPA 知道你的 Java 型別與 SQL 型別，因為你在 `@Entity` 上告訴過它。**
> **MyBatis 不知道，因為你從來沒有告訴過它——它只看到一句 SQL 字串。**

⚠️ **同一類問題還會出現在**：`Instant` / `LocalDateTime`、`enum`、
`JSON` 欄位、加密欄位、`Money` 這種值物件。
**07 章 7.5 會把 `TypeHandler` 完整處理一次。**

### 0.5.5 MyBatis 不做的六件事（以及它給你什麼作為交換）

| MyBatis 不做 | 代價 | 交換到的東西 |
|---|---|---|
| 產生 SQL | 每一句都要自己寫 | **SQL 就是你看到的那樣**，不用猜 |
| 髒檢查 | 忘記呼叫 `update` 就沒有寫入 | **不會有「意外的 UPDATE」** |
| 身分管理 | 查兩次得到兩個物件 | **不會有「別的地方改到我手上這個物件」** |
| 決定 flush 時機 | —— | **呼叫就送出，時序完全可預測** |
| 方言轉換 | 換資料庫要改 SQL | **可以用該資料庫的所有特性**（視窗函式、`ON DUPLICATE KEY`、CTE……） |
| 關聯的自動載入 | 要自己寫 `resultMap` | **不會有「不小心 lazy 載入」的 N+1** |

⚠️ **最後一列要打一個折扣**：MyBatis 提供了「巢狀 select」，
而它**就是 N+1**——只是那個 N+1 是**你自己寫進 XML 裡的**。
**0.7 會實測。**

---
## 0.6 分歧點：六個根本差異 ★★

0.3.7 已經把六個事故收斂成三句話。這一節把它展開成**六條軸**——
**這六條軸就是這一站的骨架，後面九章每一章都在處理其中一條。**

### 0.6.1 差異一：誰決定 SQL

```
MyBatis    你寫 SQL          →  框架照著送
JPA        你寫【意圖】       →  框架決定 SQL
```

**「意圖」長什麼樣**：

```java
orders.findByStatus("PENDING")        // 意圖：我要狀態是 PENDING 的訂單
o.pay()                               // 意圖：這張訂單付款了
o.getCustomer().getDisplayName()      // 意圖：我要這張訂單的客戶名稱
```

**這三行沒有一行提到 SQL，而它們各自產生了 1 句、1 句、1 句 SQL。**

⚠️ **這條軸的關鍵不是「誰比較會寫 SQL」，是【可預測性】**：

| | 你看著程式碼，猜得到會送出什麼 SQL 嗎 |
|---|---|
| MyBatis | ✅ **猜得到，因為 SQL 就在那裡** |
| JPA | 🔴 **猜不到，除非你知道 fetch 策略、持久化情境的狀態、以及這個物件是不是代理** |

📌 **0.3.2 那個事故是這條軸的直接後果**：
`o.getCustomer().getDisplayName()` 這一行，
**在「customer 已經在持久化情境裡」時是 0 句 SQL，在「還沒載入」時是 1 句 SQL。**
同一行程式碼，**兩種行為，而差別不在這一行**，在幾行之前發生了什麼。

⚠️ **但不要把這條軸讀成「MyBatis 比較好」。** 反過來的代價是：

```
🔴 MyBatis：需求變一點，SQL 就要改一句。
   「訂單列表要多顯示一個欄位」→ 改 SQL、改 resultMap、改 Row 類別
   「訂單列表要多一個篩選條件」→ 改 SQL（而且要用 <if> 處理「沒傳這個條件」的情況）

✅ JPA：需求變一點，通常改一個方法簽章。
   「訂單列表要多顯示一個欄位」→ 實體本來就有那個欄位，不用改
   「訂單列表要多一個篩選條件」→ findByStatusAndCustomerId(...)，或 Specification
```

> 📌 **一句話總結這條軸**：
> **MyBatis 用「每次需求變動的成本」，換「每次執行的可預測性」。**
> **JPA 反過來。**
>
> 而這個交換划不划算，**取決於你的專案是「查詢形狀很固定」還是「一直在變」**——
> 這是 0.8 決策表的第一個判準。

### 0.6.2 差異二：有沒有「狀態」

**這是六條軸裡最根本的一條**，因為它決定了另外三條。

```
MyBatis    無狀態。呼叫 → 送 SQL → 回傳物件 → 【結束，框架忘記這件事】
JPA        有狀態。查出來的每一個實體，都被【持久化情境】記著
```

**「被記著」意味著什麼**——三個可觀察的後果：

**① 同一個 id 查兩次，回來同一個實例**

```java
tx.executeWithoutResult(s -> {
    OrderE a = orders.findById(id).orElseThrow();
    OrderE b = orders.findById(id).orElseThrow();
    System.out.println(a == b);        // JPA: true      MyBatis/JDBC: 不適用（是不同物件）
});
```

**而且第二次查詢【不會送 SQL】**——這叫**一級快取**（03 章）。

**② 改了物件，交易結束時自動寫回**（0.3.1 的髒檢查）

**③ 兩個地方拿到同一張訂單，其中一個改了，另一個看得見**

📌 06 站 00 章 0.10.3 那張表的四列，現在全部有答案了：

| # | 程式碼 | fake | JDBC | **JPA** |
|---|---|---|---|---|
| ① | 改了物件但忘記 `save()` | 🔴 生效 | ✅ 不生效 | ⚠️ **生效**（0.3.1 實測） |
| ② | `findById(x) == findById(x)` | 🔴 true | ✅ false | ⚠️ **true**（同一個持久化情境內） |
| ③ | 兩個 Service 各自 `findById` 同一張單，各自改 | 🔴 互相看得見 | ✅ 各改各的 | ⚠️ **互相看得見** |
| ④ | 把查出來的物件放進快取 | 🔴 危險 | ✅ 安全 | 🔴 **危險** |

⚠️⚠️ **注意 JPA 那一欄跟 fake 那一欄幾乎一樣。**

> 📌 **這是一個很有用的心智模型**：
> **JPA 的持久化情境，行為上就像 06 站那個「天真的 Map fake」——**
> **一個以 id 為 key、存著物件【本身】（不是拷貝）的 Map。**
>
> 06 站說那個 fake 是錯的，因為它跟真實作行為不同。
> **現在真實作變成 JPA 了，所以那個 fake 反而變成對的**——
> 這正是 06 站 00 章 0.10.2 為什麼要把契約測試留下來：
> **它讓「換實作時行為變了」這件事變成一個紅燈，而不是一個上線後的驚喜。**

⚠️ **「同一個持久化情境內」這個限定詞非常重要**：

```
持久化情境的生命週期  =  交易的生命週期（在 Spring 的預設設定下）

→ 所以 ① ② ③ 只在【同一個交易內】成立
→ 跨交易？兩次查詢回來兩個不同的物件，跟 MyBatis 一樣
→ 交易結束後那些實體變成 detached（0.3.4 那個例外的來源）
```

**03 章會把「四種狀態」（transient / managed / detached / removed）完整處理。**

### 0.6.3 差異三：查詢的單位是「實體」還是「結果集」

```
JPA        查詢的單位是【實體】。你查 OrderE，回來 OrderE
MyBatis    查詢的單位是【一句 SQL 的結果】。你要什麼形狀，就定義什麼形狀
```

**這個差異在「報表查詢」上最明顯。實測一個真實的報表需求**：

> 客戶銷售報表：每個客戶的訂單數、總額、平均額，
> **以及他最常買的商品**；只算 30 天內、排除取消的單；
> 總額低於門檻的不列；按總額排序取前 N 名。

**MyBatis 版**：

```java
@Mapper
public interface ReportMapper {

    @Select("""
            SELECT c.display_name                             AS customer_name,
                   COUNT(DISTINCT o.id)                       AS order_count,
                   SUM(o.total_amount)                        AS amount,
                   ROUND(AVG(o.total_amount), 2)              AS avg_amount,
                   (SELECT i2.product_name
                      FROM order_item i2 JOIN orders o2 ON o2.id = i2.order_id
                     WHERE o2.customer_id = c.id
                     GROUP BY i2.product_name
                     ORDER BY SUM(i2.qty) DESC, i2.product_name
                     LIMIT 1)                                 AS top_product
              FROM customer c
              JOIN orders o ON o.customer_id = c.id
             WHERE o.placed_at >= #{from}
               AND o.status <> 'CANCELLED'
             GROUP BY c.id, c.display_name
            HAVING SUM(o.total_amount) >= #{minAmount}
             ORDER BY amount DESC
             LIMIT #{limit}
            """)
    List<CustomerSalesRow> customerSales(@Param("from") Instant from,
                                         @Param("minAmount") BigDecimal minAmount,
                                         @Param("limit") int limit);
}
```

```java
package com.example.lab.mybatis;

import java.math.BigDecimal;

/** 報表的一列：它不對應任何一張表，也不對應任何一個實體。 */
public class CustomerSalesRow {
    private String customerName;
    private long orderCount;
    private BigDecimal amount;
    private BigDecimal avgAmount;
    private String topProduct;

    public String getCustomerName() { return customerName; }
    public void setCustomerName(String v) { this.customerName = v; }
    public long getOrderCount() { return orderCount; }
    public void setOrderCount(long v) { this.orderCount = v; }
    public BigDecimal getAmount() { return amount; }
    public void setAmount(BigDecimal v) { this.amount = v; }
    public BigDecimal getAvgAmount() { return avgAmount; }
    public void setAvgAmount(BigDecimal v) { this.avgAmount = v; }
    public String getTopProduct() { return topProduct; }
    public void setTopProduct(String v) { this.topProduct = v; }

    @Override public String toString() {
        return customerName + " 訂單 " + orderCount + " 張，合計 " + amount
             + "，平均 " + avgAmount + "，最常買 " + topProduct;
    }
}
```

**實測**（30 個客戶、300 張訂單）：

```
── MyBatis（17 ms） → 共 1 句，1 種形狀
   ×1  SELECT c.display_name AS customer_name, COUNT(DISTINCT o.id) AS order_count, ...
   客戶2 訂單 10 張，合計 7000.0000，平均 700.00，最常買 商品2
   客戶29 訂單 10 張，合計 7000.0000，平均 700.00，最常買 商品2
   ...
```

**同一份報表，JPQL 版**：

```java
List<Object[]> rows = em.createQuery("""
        select c.displayName, count(distinct o.id), sum(o.totalAmount), avg(o.totalAmount)
          from OrderE o join o.customer c
         where o.placedAt >= :from and o.status <> 'CANCELLED'
         group by c.id, c.displayName
        having sum(o.totalAmount) >= :minAmount
         order by sum(o.totalAmount) desc
        """, Object[].class)
        .setParameter("from", from)
        .setParameter("minAmount", minAmount)
        .setMaxResults(5)
        .getResultList();
```

```
── JPQL（不含 top_product 那個子查詢） → 共 1 句，1 種形狀
   ×1  select c1_0.display_name,count(distinct oe1_0.id),sum(oe1_0.total_amount),
              avg(oe1_0.total_amount)
       from orders oe1_0 join customer c1_0 on c1_0.id=oe1_0.customer_id
       where oe1_0.placed_at>=? and oe1_0.status<>'CANCELLED'
       group by c1_0.id,c1_0.display_name having sum(oe1_0.total_amount)>=?
       order by sum(oe1_0.total_amount) desc limit ?
   [客戶29, 10, 7000.0000, 700.0]
   [客戶2, 10, 7000.0000, 700.0]
```

⚠️ **JPQL 完全做得到 `GROUP BY` / `HAVING` / 聚合 / 排序 / `LIMIT`，也是 1 句 SQL。**
**「JPA 不能寫報表」是一個常見的錯誤印象。**

**那 `top_product` 那個相關子查詢呢？實測**：

```
─── 加上 top_product（相關子查詢 + LIMIT 1）
   ✅ JPQL 接受
```

📌 **Hibernate 6 的 JPQL 支援子查詢裡的 `limit`**（這是 Hibernate 的擴充，不在 JPA 規格裡）。
**也就是說：這個報表用 JPQL 寫得出來。**

> ⚠️ **所以這條軸的差別【不是】「能不能」，是「代價」**：

| | MyBatis | JPQL |
|---|---|---|
| 寫得出來嗎 | ✅ | ✅ |
| 回傳的形狀 | `List<CustomerSalesRow>`，**每個欄位有名字有型別** | `List<Object[]>`，**要自己記得第 3 欄是 `avg`** |
| 要多寫的東西 | 一個 `CustomerSalesRow`（28 行） | 一個 DTO + `select new com.x.Dto(...)` 建構子投影 |
| 用資料庫特有語法（視窗函式、CTE、`JSON_TABLE`） | ✅ 直接寫 | 🟡 要 `createNativeQuery`，那就等於 MyBatis 了 |
| SQL 長什麼樣 | ✅ 就是你寫的 | 🟡 要看 log 才知道 |
| 這段查詢會不會被實體結構綁住 | ✅ 完全不會 | 🔴 **會**——JPQL 只能查 `@Entity` 上有的東西 |

⚠️ **最後一列是實務上最容易低估的一項**。舉例：

```
需求：報表要 JOIN 一張【沒有實體】的表（例如第三方匯入的 raw 資料表、或一個 VIEW）

MyBatis  →  直接 JOIN，沒事
JPQL     →  🔴 做不到。JPQL 只認識 @Entity
            → 要嘛替那張表也建一個 @Entity（就算你只是要 JOIN 一下）
            → 要嘛改用 native query
```

📌 **本課的立場**（09 章會展開）：

> **報表與統計查詢，本來就不該用實體去查。**
> 不管你用 JPA 還是 MyBatis，**都應該有一組獨立的「查詢模型」**——
> 這正是 06 站 00 章 0.4.3 那張表裡 **Repository 與 DAO 分工**的用意：
> **寫入走 Repository（聚合、不變量），查詢走 DAO（形狀、效能）。**

### 0.6.4 差異四：寫入的時機

```
MyBatis    你呼叫 mapper.update(...) →  SQL 立刻送出
JPA        你改了物件               →  ??? 什麼時候送出？
```

**JPA 的答案是「flush 的時候」，而 flush 發生在三個時機**：

```
① 交易 commit 前                                    ← 最常見
② 執行一個查詢之前，而那個查詢會碰到「有待寫入變更」的表   ← ★ 最容易被忽略
③ 你手動呼叫 em.flush()
```

⚠️ **時機 ② 造成一個很有意思的現象**：

```java
tx.executeWithoutResult(s -> {
    OrderE o = orders.findById(id).orElseThrow();
    o.cancel();                                     // 只改了記憶體

    long n = orders.count();                        // ★ 這裡會先 flush！
    //          ↑ 因為 count() 要掃 orders 表，而 orders 有待寫入的變更
    //            Hibernate 必須先把 UPDATE 送出去，count 才會正確
});
```

📌 **06 站 05 章 5.4「flush 什麼時候發生」已經完整處理過這件事**，
這裡只補一句它的後果：

> **「SQL 送出的順序」與「你程式碼的順序」不一樣。**
>
> 這在單純的 CRUD 上不痛不癢，但只要牽涉到**鎖**，它就很致命：
> 你以為你在 A 行取得了鎖，實際上 SQL 是在 B 行才送出去的——
> **而 A 到 B 之間有一個外部 API 呼叫。**

⚠️ **另一個後果是「例外在哪裡拋出」**：

```java
tx.executeWithoutResult(s -> {
    customers.save(new CustomerE(id, "duplicate@x.com", "重複的 email"));
    // ★ 這一行【不會】拋 DataIntegrityViolationException
    doSomethingElse();
});
// ← 唯一索引的錯誤在【這裡】才炸（交易 commit 時 flush）
```

**在 MyBatis / JdbcTemplate 上，那個例外會在 `save` 那一行就拋出來。**
📌 這件事會直接影響你的 `try / catch` 該包在哪裡——**05 站 04 章的例外分層要重新檢視一次。**

### 0.6.5 差異五：誰主導 schema

```
JPA        實體 →（可以）產生 schema        「code first」
MyBatis    schema →  你自己寫 SQL 對上它     「database first」（唯一選項）
```

**Hibernate 真的會建表。實測**：把資料來源換成 H2、`ddl-auto: create-drop`，
**一行 DDL 都不用寫，五張表就出現了**（0.6.6 的實驗就是這樣跑的）。

⚠️ **但本課的 `application.yml` 寫的是**：

```yaml
spring:
  jpa:
    hibernate:
      ddl-auto: none        # ★ 生產環境唯一可接受的值
```

**理由在 07 站 06 章（Flyway）已經講完了**，這裡只複述結論：

| `ddl-auto` | 做什麼 | 可以用在哪 |
|---|---|---|
| `none` | 什麼都不做 | ✅ **所有環境**（本課） |
| `validate` | 啟動時檢查實體與 schema 對不對得上，對不上就啟動失敗 | ✅ **強烈建議**，見下方 |
| `update` | 試著把 schema 改成實體的樣子 | 🔴 **絕對不要**：它不會刪欄位、不會改型別、不可重現、沒有回滾 |
| `create` / `create-drop` | 每次啟動重建 | 🟡 只在**測試**用 |

📌 **`validate` 值得特別推薦**，它給你一個很便宜的守門人：

```yaml
spring:
  jpa:
    hibernate:
      ddl-auto: validate      # Flyway 遷移完之後，檢查實體跟 schema 對不對得上
```

```
Schema-validation: wrong column type encountered in column [total_amount] in table [orders];
  found [decimal (Types#DECIMAL)], but expecting [numeric(38,2) (Types#NUMERIC)]
```

> **它抓的是「有人改了 schema 卻忘了改實體」與「有人改了實體卻忘了寫遷移腳本」。**
> 這兩件事在多人專案裡每個月都會發生一次。

⚠️ **`validate` 有一個代價**：它比 `none` 嚴格，
**而「嚴格」意味著一些你原本不在乎的差異會擋住啟動**
（`BOOLEAN` vs `TINYINT(1)`、`DATETIME(3)` 的精度、生成欄位……）。
**01 章 1.12 會把本課這份 schema 調到 `validate` 通得過，並列出過程中撞到的每一個坑。**

📌 **MyBatis 這一側完全沒有這個議題**——它不知道有 schema 這回事，
**它只知道「你給我的這句 SQL」**。這是缺點也是優點：

```
🔴 缺點：沒有任何機制能告訴你「這句 SQL 引用的欄位已經被刪掉了」
✅ 優點：schema 有 VIEW、有 stored procedure、有別人管的表，它都無所謂
```

### 0.6.6 差異六：換資料庫的成本

**實測：同一份 Java 程式碼，底下從 MySQL 換成 H2，只改 `application.yml`。**

```java
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:lab;MODE=MySQL;DATABASE_TO_LOWER=TRUE;QUERY_CACHE_SIZE=0",
        "spring.datasource.username=sa",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.jpa.hibernate.ddl-auto=create-drop"
})
class E4Dialect { /* ... */ }
```

**在 MySQL 上**：

```
  目前的 Dialect → org.hibernate.dialect.MySQLDialect
── orders.findAll(PageRequest.of(1, 5)) → 2 句 SQL
   1) select oe1_0.id,... from orders oe1_0 limit ?,?
   2) select count(oe1_0.id) from orders oe1_0
```

**在 H2 上**（**同一行 Java**）：

```
  Dialect → org.hibernate.dialect.H2Dialect
── ① Spring Data JPA：orders.findAll(PageRequest.of(1, 5)) → 2 句 SQL
   1) select oe1_0.id,... from orders oe1_0 offset ? rows fetch first ? rows only
   2) select count(oe1_0.id) from orders oe1_0
```

```
MySQL:  limit ?,?
H2:     offset ? rows fetch first ? rows only
```

⚠️ **同一行 `orders.findAll(PageRequest.of(1, 5))`，兩種 SQL 語法。**
這就是 `Dialect` 在做的事，**而你完全不用管它**。

**MyBatis 那一側**：

```
② MyBatis：countByStatus → 0
──    MyBatis 那句 SQL → 1 句 SQL
   1) SELECT COUNT(*) FROM orders WHERE status = ?
```

✅ 這一句在兩邊都能跑——**因為它剛好只用了標準 SQL**。

🔴 **但 0.6.3 那個報表查詢就不行了**，它用了 `LIMIT #{limit}`、
`ROUND(AVG(...), 2)`、以及一個 `LIMIT 1` 的相關子查詢——
**換到 SQL Server 或 Oracle，這句要重寫。**

> 📌 **這條軸要小心不要高估**：
>
> 🔴 **「以後可能要換資料庫」在實務上幾乎不會發生。**
> 用它當選 JPA 的理由，是 0.8.3 三個「不該拿來當理由」的第一個。
>
> ✅ **但有一個場景它是真的**，而且每個專案都會遇到：
> **測試用 H2、正式用 MySQL。**
>
> 而 06 站 06 章 6.4 已經用**21 根探針**證明了那條路有多危險
> （**12 根兩邊行為不一樣**）。所以本課的立場是：
> **不要靠方言抽象來「省下一個真的資料庫」——用 Docker 跑一個真的 MySQL（06 站 6.5）。**
> **JPA 的方言抽象是一個好東西，但它不是「測試不用真資料庫」的許可證。**

### 0.6.7 六條軸的總表

| # | 軸 | JPA / Hibernate | MyBatis | 本站哪一章 |
|---|---|---|---|---|
| 1 | **誰決定 SQL** | 框架（你寫意圖） | **你** | 04、05 / 07、08 |
| 2 | **有沒有狀態** | **有**（持久化情境、髒檢查、一級快取） | 無 | **03** |
| 3 | **查詢的單位** | 實體（要跳出來得用投影 / native） | 一句 SQL 的結果形狀 | 05 / 08 |
| 4 | **寫入時機** | flush 時（三個時機） | 呼叫時 | 03、06 |
| 5 | **誰主導 schema** | 可以 code first；本課 database first + `validate` | 只能 database first | 01 |
| 6 | **換資料庫** | `Dialect` 自動處理 | 自己改 SQL | 00 |

⚠️ **這六條不是獨立的。看一下依賴關係**：

```
        ② 有沒有狀態  ← 最根本
       ╱      │      ╲
      ↓       ↓        ↓
  ① 誰決定   ④ 寫入    ③ 查詢
     SQL      時機      單位
      ↓
  ⑥ 換資料庫
```

> 📌 **如果只能記一件事，記②**：
> **JPA 在你的程式與資料庫之間，放了一個「會記住東西、會自己做決定」的中間層。**
>
> 這一站的其他一切——N+1、`LazyInitializationException`、
> 髒檢查、`merge` vs `persist`、批次為什麼失效、樂觀鎖怎麼運作——
> **全部都是這一句話的推論。**

---

## 0.7 實測：四種寫法跑同一頁 ★★

**需求**：一頁 200 張訂單，每一列要顯示**客戶名稱**與**明細**。
（環境見 0.10；四種寫法各先暖機 3 次，取之後的一次。）

**① JPA 天真寫法**

```java
tx.executeWithoutResult(s -> {
    for (OrderE o : orders.findByStatus("PENDING")) {
        o.getCustomer().getDisplayName();
        o.getItems().size();
    }
});
```

**② JPA + `JOIN FETCH`**

```java
tx.executeWithoutResult(s -> {
    List<OrderE> os = em.createQuery("""
            select distinct o from OrderE o
              join fetch o.customer
              left join fetch o.items
             where o.status = :st
            """, OrderE.class).setParameter("st", "PENDING").getResultList();
    os.forEach(o -> { o.getCustomer().getDisplayName(); o.getItems().size(); });
});
```

**③④ 兩者共用的結果形狀**

```java
package com.example.lab.mybatis;

import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;

public class OrderDetailRow {
    private UUID id;
    private String orderNo;
    private String status;
    private BigDecimal totalAmount;
    private String customerName;
    private List<ItemRow> items;

    public UUID getId() { return id; }
    public void setId(UUID v) { this.id = v; }
    public String getOrderNo() { return orderNo; }
    public void setOrderNo(String v) { this.orderNo = v; }
    public String getStatus() { return status; }
    public void setStatus(String v) { this.status = v; }
    public BigDecimal getTotalAmount() { return totalAmount; }
    public void setTotalAmount(BigDecimal v) { this.totalAmount = v; }
    public String getCustomerName() { return customerName; }
    public void setCustomerName(String v) { this.customerName = v; }
    public List<ItemRow> getItems() { return items; }
    public void setItems(List<ItemRow> v) { this.items = v; }

    public static class ItemRow {
        private String productName;
        private int qty;
        private BigDecimal lineAmount;
        public String getProductName() { return productName; }
        public void setProductName(String v) { this.productName = v; }
        public int getQty() { return qty; }
        public void setQty(int v) { this.qty = v; }
        public BigDecimal getLineAmount() { return lineAmount; }
        public void setLineAmount(BigDecimal v) { this.lineAmount = v; }
    }
}
```

```java
package com.example.lab.mybatis;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.util.List;
import java.util.UUID;

/** SQL 寫在 resources/mapper/OrderDetailMapper.xml。 */
@Mapper
public interface OrderDetailMapper {
    /** 🔴 巢狀 select 版：MyBatis 這一側的 N+1。 */
    List<OrderDetailRow> listNPlus1(@Param("status") String status);
    /** ✅ 巢狀 resultMap（一句 JOIN，靠 id 把列組回物件）。 */
    List<OrderDetailRow> listJoined(@Param("status") String status);
    List<OrderDetailRow.ItemRow> itemsOf(@Param("orderId") UUID orderId);
}
```

**③④ 的 SQL 都寫在同一個檔案：`src/main/resources/mapper/OrderDetailMapper.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN"
        "https://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="com.example.lab.mybatis.OrderDetailMapper">

  <!-- ═══ ③ 巢狀 select：每一張訂單再打一句 SQL 去撈明細 ═══ -->

  <resultMap id="nPlus1Map" type="com.example.lab.mybatis.OrderDetailRow">
    <id     property="id"           column="id"/>
    <result property="orderNo"      column="order_no"/>
    <result property="status"       column="status"/>
    <result property="totalAmount"  column="total_amount"/>
    <result property="customerName" column="customer_name"/>
    <!-- 🔴 就是這一行：select= 讓每一張訂單各自再打一句 SQL -->
    <collection property="items" ofType="com.example.lab.mybatis.OrderDetailRow$ItemRow"
                select="itemsOf" column="{orderId=id}"/>
  </resultMap>

  <select id="listNPlus1" resultMap="nPlus1Map">
    SELECT o.id, o.order_no, o.status, o.total_amount, c.display_name AS customer_name
      FROM orders o JOIN customer c ON c.id = o.customer_id
     WHERE o.status = #{status}
  </select>

  <select id="itemsOf" resultType="com.example.lab.mybatis.OrderDetailRow$ItemRow">
    SELECT product_name, qty, line_amount FROM order_item WHERE order_id = #{orderId}
  </select>

  <!-- ═══ ④ 巢狀 resultMap：一句 JOIN，靠 <id> 把列組回物件 ═══ -->

  <resultMap id="joinedMap" type="com.example.lab.mybatis.OrderDetailRow">
    <!-- ★ <id> 是關鍵：MyBatis 用它判斷「這幾列屬於同一張訂單」 -->
    <id     property="id"           column="id"/>
    <result property="orderNo"      column="order_no"/>
    <result property="status"       column="status"/>
    <result property="totalAmount"  column="total_amount"/>
    <result property="customerName" column="customer_name"/>
    <!-- ✅ 沒有 select=，明細直接從同一個結果集的欄位組出來 -->
    <collection property="items" ofType="com.example.lab.mybatis.OrderDetailRow$ItemRow">
      <result property="productName" column="i_product_name"/>
      <result property="qty"         column="i_qty"/>
      <result property="lineAmount"  column="i_line_amount"/>
    </collection>
  </resultMap>

  <select id="listJoined" resultMap="joinedMap">
    SELECT o.id, o.order_no, o.status, o.total_amount, c.display_name AS customer_name,
           i.product_name AS i_product_name, i.qty AS i_qty, i.line_amount AS i_line_amount
      FROM orders o
      JOIN customer c        ON c.id = o.customer_id
      LEFT JOIN order_item i ON i.order_id = o.id
     WHERE o.status = #{status}
     ORDER BY o.id
  </select>
</mapper>
```

⚠️ **兩個 `resultMap` 的差別只有一行**——`<collection>` 上有沒有 `select=`。
**而那一行就是 201 句與 1 句的差別。**

📌 **④ 需要 `ORDER BY o.id`**：巢狀 `resultMap` 是靠「連續的列有相同的 `<id>`」
來判斷分組的，**同一張訂單的列必須相鄰**。
忘了排序不會報錯，只會讓同一張訂單被拆成好幾筆——**這是 08 章 8.5 的一個常見坑**。

**結果**（連跑兩輪，數字穩定）：

```
① JPA 天真寫法            251 句 SQL，66～74 ms
② JPA + JOIN FETCH          1 句 SQL， 9～10 ms
③ MyBatis 巢狀 select     201 句 SQL，47～53 ms
④ MyBatis 巢狀 resultMap    1 句 SQL，  3 ms
```

⚠️ **這張表有三個結論，而第三個最容易被忽略。**

**結論一：N+1 跟框架無關，跟【你怎麼寫】有關。**

```
① 251 句（JPA）   vs   ③ 201 句（MyBatis）      ← 兩個都 N+1
② 1 句（JPA）     vs   ④ 1 句（MyBatis）        ← 兩個都可以修好
```

> 🔴 **「用 MyBatis 就不會 N+1」是錯的。**
> ③ 那個 `<collection select="itemsOf">` 就是一個 N+1，而且它是**你自己寫進 XML 的**。

**結論二：差別在「你看不看得見」。**

| | N+1 藏在哪 | 你怎麼發現 |
|---|---|---|
| ① JPA | **藏在 `o.getItems()` 這個 getter 裡** | 🔴 看程式碼看不出來。要看 log、要數 SQL |
| ③ MyBatis | **寫在 XML 的 `select="itemsOf"` 上** | 🟡 看得出來——**如果你知道那個屬性代表什麼** |

📌 **這是 0.6.1「可預測性」那條軸的具體代價**。
但注意 ③ 只是「比較看得見」，不是「不會發生」——
**一個 200 行的 XML mapper 裡藏一個 `select=`，一樣沒人會注意到。**

**結論三：同樣 1 句 SQL，② 比 ④ 慢 3 倍。** ★

```
② JPA + JOIN FETCH        1 句 SQL，9～10 ms
④ MyBatis 巢狀 resultMap   1 句 SQL， 3 ms
```

**同一句 JOIN、同一份資料、同一個資料庫。差別在 SQL 之後**：

```
MyBatis 拿到結果集之後：
   → 建 200 個 OrderDetailRow + 400 個 ItemRow
   → 【結束】

JPA 拿到結果集之後：
   → 建 200 個 OrderE + 400 個 OrderItemE + 50 個 CustomerE
   → 每一個都【註冊進持久化情境】（0.6.2 差異二）
   → 每一個都【拍一份快照】，供交易結束時做髒檢查（0.3.1）
   → 每一個集合都包成 PersistentBag（可追蹤增刪的集合代理）
   → 交易結束時，把 650 個實體【逐欄位】比對一次快照
```

> 📌 **這就是「有狀態」的價格，而且它是【按實體數量】計價的。**
>
> ⚠️ **所以一個常見的建議在這裡有了實測依據**：
> **唯讀查詢用投影（DTO）而不是實體。**
> 05 章會示範 `select new com.example.OrderRowDto(...)` 的寫法，
> 以及 `@Transactional(readOnly = true)` 為什麼能省掉快照
> （06 站 05 章 5.3 已經測過那一段）。

⚠️ **不要把「慢 3 倍」讀成「JPA 不能用」**：
**9 ms 對一支 API 來說完全可以接受**，而 ① 的 66 ms 才是真正的問題。
**這張表真正的訊息是**：

```
251 句 → 1 句     ：  解決 N+1，省下 57 ms      ← ★ 這是你 90% 的效能問題
9 ms → 3 ms       ：  換掉整個框架，省下 6 ms    ← 這不是你該優先處理的事
```

> 📌 **一句實務結論**：
> **選型不會決定你的效能，怎麼寫才會。**
> **一個懂 N+1 的 JPA 專案，遠快過一個不懂的 MyBatis 專案。**

---
## 0.8 選型：一張決策表 ★★

### 0.8.1 六個場景，各自誰佔優勢

**把 0.7 與 0.6.3 的實測，加上另外四個場景**（場景 A、D 的數字來自 0.10 的同一個專案）：

| 場景 | JPA | MyBatis | 誰佔優勢 |
|---|---|---|---|
| **A 讀出一個聚合、改狀態、寫回**<br/>（訂單 + 明細 → `cancel()`） | **3 句 SQL**，`o.cancel()` 一行 | 讀 2 句 + 自己寫 `UPDATE`；狀態機邏輯要自己搬進 Service | ✅ **JPA** |
| **B 建立一個聚合**（1 張單 + 3 筆明細） | `em.persist(o)` **7 句**（`orders.save` 是 11 句，見 0.3.3；⚠️ 那 11 句在 **01 章 1.6.6** 用 `Persistable` 修掉之後也是 7 句） | 自己寫 1 + 3 句 `INSERT`（或 1 句 `foreach` 批次）**4 句** | 🟡 **MyBatis 略勝**（句數），**JPA 略勝**（程式碼量） |
| **C 列表頁 + 關聯**（200 張訂單） | 1 句 / **9 ms**（要會寫 `JOIN FETCH`） | 1 句 / **3 ms** | ✅ **MyBatis**（但差距是 6 ms） |
| **D 報表**（`GROUP BY` + `HAVING` + 相關子查詢） | JPQL 做得到，但回 `Object[]` 或要寫 DTO 投影 | 1 句 SQL + 1 個 Row 類別，**形狀完全自由** | ✅ **MyBatis** |
| **E 批次寫入 5 萬筆** | 要開 `batch_size`，還有**四件事會讓它靜默失效**（06 站 05 章 5.8） | `<foreach>` 或 `ExecutorType.BATCH`，行為直接 | ✅ **MyBatis** |
| **F 條件式搜尋**（6 個可選篩選條件） | `Specification` / QueryDSL，**型別安全** | `<if>` 動態 SQL，**直觀但字串** | 🟡 **平手**（看團隊偏好） |

⚠️ **注意這張表的形狀**：

```
JPA 贏的地方   →  【寫入一個有結構的東西】（聚合、狀態機、不變量）
MyBatis 贏的地方 →  【讀出一個特定形狀的東西】（列表、報表、匯出）
```

> 📌 **這不是巧合，這是 0.6.3 那條軸的直接後果**：
> **JPA 的世界裡「單位」是實體，所以寫入一個實體圖很自然、查出一個奇怪形狀很彆扭。**
> **MyBatis 的世界裡「單位」是一句 SQL 的結果，所以查什麼形狀都自然、
> 但「維護一個聚合的完整性」完全要靠你自己。**

### 0.8.2 七個判準

**選型不該從「哪個比較好」開始，該從「我的專案長什麼樣」開始。七個問題**：

**判準 1：這個系統是「寫入導向」還是「查詢導向」？**

```
寫入導向（訂單、庫存、帳務、工單）
  → 有狀態機、有不變量、有「一個東西必須整體一致」的概念
  → ✅ 偏 JPA

查詢導向（報表、BI、資料匯出、搜尋、對外 API 聚合）
  → 每個需求一種形狀，沒有「聚合」這個概念
  → ✅ 偏 MyBatis
```

**判準 2：schema 是你的嗎？**

```
是你的，而且你可以改      → ✅ 兩者都行，JPA 的 validate 是加分
不是你的（既有系統、別的團隊管、有 VIEW / stored procedure / 沒有外鍵的老表）
                        → ✅ 偏 MyBatis（JPA 映射一張「設計不良的老表」非常痛苦）
```

⚠️ **判準 2 是實務上最常見的決定因素**，而且它常常不是技術決定：
**「我們接手了一個十年的資料庫」這句話，基本上就等於選了 MyBatis。**

**判準 3：團隊的 SQL 能力，與 ORM 能力，哪一個比較強？**

```
🔴 這一題沒有「正確答案」，但它有一個【錯誤答案】：
   「團隊不熟 SQL，所以用 JPA 這樣就不用寫 SQL 了」

→ 0.3 的六個事故裡有五個，需要【看得懂 SQL】才能診斷。
→ JPA 不會讓你不用懂 SQL，它只會讓你在出事的時候【更難看到 SQL】。
```

**判準 4：查詢的形狀會一直變嗎？**

```
會（產品期、需求每週變）    → ✅ 偏 JPA（改一個方法簽章 vs 改 SQL + resultMap + Row 類別）
不會（成熟系統、報表固定）  → ✅ 偏 MyBatis
```

**判準 5：有沒有資料層測試？**

```
有，而且跑在真的資料庫上（06 站 06 章）  → ✅ 兩者都行
沒有                                  → 🔴 選 MyBatis 的風險更高
```

📌 **理由是 0.5.3 那個實測**：
**MyBatis 把「SQL 對不對」推遲到執行期**，
`Invalid bound statement`、`Unknown column`、
還有 0.5.4 那個「靜默影響 0 列」，**全部只有測試抓得到**。

**判準 6：效能敏感的部分佔多少？**

```
95% 是普通 CRUD，5% 是熱點查詢    → ✅ JPA + 那 5% 用 native query / MyBatis（0.9 混用）
大部分查詢都在效能邊緣            → ✅ 偏 MyBatis
```

**判準 7：三年後接手的人，比較容易找到哪一種？**

```
⚠️ 這是一個【真的】判準，不是玩笑。

台灣的 Java 後端市場：兩者都很常見，JPA / Spring Data 略多（尤其是新專案）。
中國大陸市場：MyBatis 佔壓倒性多數（MyBatis-Plus 幾乎是預設）。
歐美市場：Hibernate / JPA 佔壓倒性多數。

→ 你的招募池在哪裡，是一個合理的技術決策輸入。
```

### 0.8.3 三個「不該拿來當理由」的理由

**🔴 理由一：「以後可能要換資料庫」**

→ 0.6.6 已經說了：**實務上幾乎不會發生**。
而且真的要換的時候，`Dialect` 只解決語法，**不解決行為差異**
（06 站 06 章那 21 根探針，12 根在 H2 與 MySQL 之間就已經不一樣了）。

**🔴 理由二：「JPA 不用寫 SQL，開發比較快」**

→ 前半句在**簡單 CRUD** 上是真的。
但「開發比較快」如果指的是**整個專案生命週期**，這句話沒有證據——
**0.3 那六個事故的排查時間，全部要算進來。**

⚠️ 一個更誠實的說法是：
**JPA 讓前 80% 的功能快很多，讓後 20% 慢很多；MyBatis 全程速度一致。**

**🔴 理由三：「MyBatis 效能比較好」**

→ 0.7 的實測：**同一句 SQL，MyBatis 3 ms、JPA 9 ms。**
差距是真的，但**跟 N+1 造成的 66 ms 相比，它是次要的**。

> 📌 **把三個理由換成一句可以拿去開會用的話**：
>
> **「選型的差別是常數倍，寫法的差別是量級。」**
> 先確保團隊會避免 N+1、會數 SQL、會寫資料層測試——
> **這三件事帶來的效益，遠大於選哪一個框架。**

### 0.8.4 shop-service 的選擇

**本課的決定**：

```
✅ 主線用 JPA / Spring Data JPA
      理由：判準 1（訂單系統是寫入導向、有狀態機、有 11 條不變量）
            判準 2（schema 是我們自己的，07 站設計的）
            判準 4（這是一個還在長的系統）

✅ 報表與列表查詢用 MyBatis
      理由：判準 1（那些是查詢導向）
            0.6.3 實測（形狀自由、不被實體結構綁住）
            0.7 實測（同一頁 3 ms vs 9 ms，而報表的資料量大得多）

✅ 兩份實作都要跑得過 06 站那十七條契約測試
      理由：那是「換實作」這件事唯一的安全網（06 站 00 章 0.10.2）
```

⚠️ **這個決定會讓 09 章有事情做**：混用不是免費的，
而 **0.3.5 那個樂觀鎖事故就是混用的第一號地雷**。

📌 **這一站要示範的是「怎麼做選擇」，不是「哪個選擇對」**。
你的專案如果全部用 MyBatis 或全部用 JPA，只要理由講得出來，都是好決定。

---

## 0.9 混用：可以，但有三條規則

**同一個 Spring Boot 專案裡同時用 JPA 與 MyBatis，技術上非常簡單**——
兩個 starter 放進去就好，**它們共用同一個 `DataSource`、同一個 `PlatformTransactionManager`**，
所以 `@Transactional` 對兩邊都有效，寫入會在同一個交易裡。

⚠️ **但「能跑」跟「不會出事」是兩件事。三條規則**：

### 規則一：同一張表，只讓一個框架【寫】

```
✅ 讀：兩邊都可以，愛怎麼讀怎麼讀
🔴 寫：一張表只能有一個主人
```

**理由就是 0.3.5 那個實測**：`version` 的約定只有 JPA 遵守，
**一旦有第二個寫入路徑，樂觀鎖靜默失效。**

⚠️ **如果真的不得不讓兩邊都寫**（例如批次匯入要走 MyBatis 的批次），
那就**兩邊都要遵守約定**：

```sql
-- MyBatis 這一側也必須自己維護 version
UPDATE orders
   SET status = #{status}, version = version + 1
 WHERE id = #{id} AND version = #{version};
-- ★ 而且要檢查影響列數，0 列要當成 OptimisticLockException 處理
```

📌 **並且要寫一個測試把這個約定釘住**（06 站 00 章 0.5.3 的「方式 B：釘住它」）：

```java
@Test
void 每一句更新orders的SQL都必須維護version() {
    // 掃描所有 mapper XML 與註解，找出 UPDATE orders 的語句
    // 斷言：每一句都包含 "version = version + 1"
    // ★ 這是一個【會在有人加新 SQL 時變紅】的守門測試
}
```

### 規則二：JPA 寫完、MyBatis 讀之前，要 `flush`

**這是 0.6.4「寫入時機」那條軸的直接後果**：

```java
@Transactional
public void demo(UUID id) {
    OrderE o = orderRepo.findById(id).orElseThrow();
    o.pay();                                  // ★ 只改了記憶體，UPDATE 還沒送出

    long n = orderMapper.countByStatus("PAID");
    //       ↑ 🔴 MyBatis 直接送 SQL 給資料庫，它【看不到】JPA 還沒 flush 的變更
    //         這個 count 會少算這一張
}
```

⚠️ **注意這件事的不對稱**：

```
JPA 查詢   →  Hibernate 知道「有待寫入的變更」，會【自動先 flush】（0.6.4 時機②）
MyBatis 查詢 →  🔴 Hibernate 完全不知道這件事發生了，不會 flush
```

**解法**：

```java
@Transactional
public void demo(UUID id) {
    OrderE o = orderRepo.findById(id).orElseThrow();
    o.pay();

    orderRepo.flush();                        // ✅ 明確地把變更推到資料庫
    long n = orderMapper.countByStatus("PAID");
}
```

📌 **反過來也有一個坑**：MyBatis 寫完、JPA 讀，
**JPA 可能從一級快取拿到舊的物件**（0.6.2 差異二）——
那就要 `em.refresh(o)` 或 `em.clear()`。**09 章 9.5 會把四種組合列全。**

### 規則三：讓「哪一邊管什麼」出現在套件結構上

```
com.example.shop
  ├── domain/                    領域模型（不碰持久化，06 站 ArchUnit 規則 1）
  ├── application/
  │     └── port/                埠（06 站的那一組，08 站【一字不改】）
  └── infrastructure/
        └── persistence/
              ├── jpa/           ★ 寫入路徑：Entity + Spring Data Repository
              │     ├── entity/
              │     └── repository/
              └── mybatis/       ★ 查詢路徑：Mapper + Row（唯讀）
                    ├── mapper/
                    └── row/
```

**並且用 ArchUnit 把它釘住**（延續 06 站那六條規則）：

```java
@Test
void 規則7_MyBatis只能出現在查詢路徑() {
    noClasses().that().resideInAPackage("..persistence.mybatis..")
            .should().dependOnClassesThat().resideInAPackage("..persistence.jpa..")
            .because("查詢路徑不該依賴寫入路徑的實體；它有自己的 Row 形狀（0.6.3）")
            .check(classes);
}

@Test
void 規則8_MyBatis的mapper不可以有寫入方法() {
    methods().that().areDeclaredInClassesThat().resideInAPackage("..persistence.mybatis..")
            .should().notBeAnnotatedWith(org.apache.ibatis.annotations.Insert.class)
            .andShould().notBeAnnotatedWith(org.apache.ibatis.annotations.Update.class)
            .andShould().notBeAnnotatedWith(org.apache.ibatis.annotations.Delete.class)
            .because("規則一：orders / order_item 的寫入只由 JPA 負責（0.3.5 的事故）")
            .check(classes);
}
```

**實測：把規則 8 跑在這一章的實驗專案上**（`OrderMapper` 有兩個 `@Update` 的示範方法）：

```
Architecture Violation [Priority: MEDIUM] - Rule 'methods that are declared in classes
that reside in a package '..mybatis..' should not be annotated with @Insert and should not
be annotated with @Update and should not be annotated with @Delete, because
規則一：orders / order_item 的寫入只由 JPA 負責（0.3.5 的事故）' was violated (2 times):
Method <com.example.lab.mybatis.OrderMapper.markPaid(java.util.UUID, java.time.Instant)>
  is annotated with @Update in (OrderMapper.java:0)
Method <com.example.lab.mybatis.OrderMapper.markPaidNoHandler(java.util.UUID, java.time.Instant)>
  is annotated with @Update in (OrderMapper.java:0)
```

✅ **規則抓到了**——而且訊息直接指出是哪兩個方法。
（本章的實驗專案刻意違規，因為 0.3.1 與 0.5.4 需要那兩個方法。
**這正是「例外要具名」的使用時機**，見下。）

⚠️ **規則 8 的例外要具名**（06 站 00 章 0.11.2 講過的反模式：不要用 `allowEmptyShould(true)` 或刪規則）：

```java
// 如果批次匯入真的需要 MyBatis 寫入，就開一個【具名】的例外
.that().resideInAPackage("..persistence.mybatis..")
.and().doNotHaveFullyQualifiedName("com.example.shop.infrastructure.persistence.mybatis.BulkImportMapper")
.because("BulkImportMapper 是唯一的例外：批次匯入走 MyBatis 的 ExecutorType.BATCH，"
       + "它自己維護 version（規則一的例外條款），並由 BulkImportVersionContractTest 守住")
```

---

## 0.10 本站的基準專案

**這一節給你一個可以直接跑的專案**，這一章所有實測都是在它上面跑出來的。

### 0.10.1 起一個 MySQL

07 站 00 章已經給過完整的 `docker-compose.yml`（含 `shop.cnf`、healthcheck、初始化腳本）。
**這一站沿用它**；如果你只想快速跑這一章的實驗，一行就夠：

```bash
docker run -d --name jpa-lab -p 33306:3306 \
  -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=shop \
  mysql:8.0 \
  --character-set-server=utf8mb4 --collation-server=utf8mb4_0900_ai_ci \
  --default-time-zone=+00:00
```

⚠️ **那四個啟動參數不是裝飾**，每一個都對應 07 站 00 章的一個事故：

```
--character-set-server=utf8mb4              07 站 0.5.1：utf8 不是 UTF-8
--collation-server=utf8mb4_0900_ai_ci       07 站 0.5.6：字串相等是誰定義的
--default-time-zone=+00:00                  07 站 0.6：四個時區在打架
（+ 07 站 0.8 的 sql_mode，用的是 MySQL 8 的預設值，已經包含 STRICT_TRANS_TABLES）
```

**確認它真的可用**（07 站 0.4.2：容器 `running` ≠ 資料庫可用）：

```bash
for i in $(seq 1 30); do
  docker exec jpa-lab mysqladmin ping -h 127.0.0.1 -uroot -proot --silent >/dev/null 2>&1 \
    && echo "ready after ${i}s" && break
  sleep 1
done

docker exec jpa-lab mysql -uroot -proot \
  -e "SELECT VERSION(), @@character_set_server, @@collation_server, @@time_zone, @@sql_mode\G"
```

```
ready after 1s
             VERSION(): 8.0.46
@@character_set_server: utf8mb4
    @@collation_server: utf8mb4_0900_ai_ci
           @@time_zone: +00:00
            @@sql_mode: ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,
                        ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION
```

**然後把 0.3.0 那份 schema 灌進去**：

```bash
docker exec -i jpa-lab mysql -uroot -proot shop < schema.sql
```

### 0.10.2 `pom.xml` 與 `application.yml`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.2.5</version>
    <relativePath/>
  </parent>
  <groupId>com.example</groupId>
  <artifactId>lab08</artifactId>
  <version>1.0</version>
  <properties>
    <java.version>21</java.version>
  </properties>
  <dependencies>
    <!-- JPA：一個 starter 拉進 jakarta.persistence + Hibernate + Spring Data JPA（0.4.1） -->
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-data-jpa</artifactId>
    </dependency>
    <!-- 06 站的對照組 -->
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-jdbc</artifactId>
    </dependency>
    <!-- ★ MyBatis 不在 Spring Boot 的 BOM 裡，版本要自己寫（0.5.1） -->
    <dependency>
      <groupId>org.mybatis.spring.boot</groupId>
      <artifactId>mybatis-spring-boot-starter</artifactId>
      <version>3.0.3</version>
    </dependency>
    <dependency>
      <groupId>com.mysql</groupId>
      <artifactId>mysql-connector-j</artifactId>
      <scope>runtime</scope>
    </dependency>
    <!-- 只用來做 0.6.6 的方言對照實驗；正式環境不要靠它測試（06 站 06 章 6.4） -->
    <dependency>
      <groupId>com.h2database</groupId>
      <artifactId>h2</artifactId>
      <scope>runtime</scope>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-test</artifactId>
      <scope>test</scope>
    </dependency>
    <!-- ★ 0.10.3 的 SqlSpy 靠它攔截每一句 SQL -->
    <dependency>
      <groupId>net.ttddyy</groupId>
      <artifactId>datasource-proxy</artifactId>
      <version>1.10</version>
    </dependency>
  </dependencies>
</project>
```

```yaml
spring:
  datasource:
    # ★ 這一串參數的每一個，07 站 00 章 0.7.3 都有解釋
    url: jdbc:mysql://127.0.0.1:33306/shop?connectionTimeZone=UTC&forceConnectionTimeZoneToSession=true&preserveInstants=true&characterEncoding=UTF-8
    username: root
    password: root
    hikari:
      maximum-pool-size: 10
  jpa:
    hibernate:
      ddl-auto: none          # ★ 0.6.5：schema 由 Flyway 管（07 站 06 章）
    open-in-view: false       # ★ 0.3.4：不要用「延長 Session」來掩蓋 N+1
    properties:
      hibernate:
        format_sql: false

mybatis:
  mapper-locations: classpath:mapper/*.xml
  type-handlers-package: com.example.lab.mybatis    # ★ 0.5.4：註冊 UuidTypeHandler
  configuration:
    map-underscore-to-camel-case: true              # order_no → orderNo

logging:
  level:
    root: WARN
    com.example.lab: INFO
```

⚠️ **`open-in-view: false` 的代價要講清楚**：
它會讓 0.3.4 那個 `LazyInitializationException` **變成一個你必須處理的問題**，
而不是一個被自動掩蓋的問題。

> 📌 **這是刻意的。** 那個例外是一個**訊號**：
> 「你正在交易外面存取一個沒有載入的關聯」。
> **把訊號關掉不會讓問題消失，只會讓它變成一個效能問題**（在 View 層打 N+1），
> 而效能問題比例外難發現得多（0.3.7 那張「在本機測得出來嗎」的表）。

### 0.10.3 `SqlSpy`：把「打了幾句 SQL」變成一個數字 ★

**這是這一章最重要的產出。** 0.3.7 說過：
六個事故裡有五個在本機看不出來，**而只要能數 SQL，其中三個就會變成看得出來**。

```java
package com.example.lab;

import net.ttddyy.dsproxy.ExecutionInfo;
import net.ttddyy.dsproxy.QueryInfo;
import net.ttddyy.dsproxy.listener.QueryExecutionListener;
import net.ttddyy.dsproxy.support.ProxyDataSourceBuilder;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import javax.sql.DataSource;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

/** 把每一句真的送到 JDBC 的 SQL 記下來。全課共用的量尺。 */
@Configuration
public class SqlSpy {

    private static final List<String> LOG = new ArrayList<>();
    private static final AtomicBoolean ON = new AtomicBoolean(false);

    public static void start() { synchronized (LOG) { LOG.clear(); } ON.set(true); }

    public static List<String> stop() {
        ON.set(false);
        synchronized (LOG) { return new ArrayList<>(LOG); }
    }

    public static int count() { synchronized (LOG) { return LOG.size(); } }

    /** 印出一次觀測的結果；`title` 是場景名。 */
    public static void dump(String title, List<String> sqls) {
        System.out.println("── " + title + " → " + sqls.size() + " 句 SQL");
        for (int i = 0; i < sqls.size(); i++) {
            System.out.println("   " + (i + 1) + ") " + sqls.get(i));
        }
    }

    /** 只印出「不同形狀」的 SQL 與各自次數 —— 診斷 N+1 就靠這個。 */
    public static void dumpGrouped(String title, List<String> sqls) {
        java.util.LinkedHashMap<String, Integer> m = new java.util.LinkedHashMap<>();
        for (String s : sqls) m.merge(s, 1, Integer::sum);
        System.out.println("── " + title + " → 共 " + sqls.size() + " 句，" + m.size() + " 種形狀");
        m.forEach((k, v) -> System.out.println("   ×" + v + "  " + k));
    }

    // ★ 必須是 static —— 否則 Spring 會警告這個 BeanPostProcessor
    //   所在的組態類別無法被完整處理（non-static factory method）
    @Bean
    public static BeanPostProcessor dataSourceSpy() {
        return new BeanPostProcessor() {
            @Override
            public Object postProcessAfterInitialization(Object bean, String name) {
                if (!(bean instanceof DataSource ds)
                        || bean instanceof net.ttddyy.dsproxy.support.ProxyDataSource) {
                    return bean;
                }
                return ProxyDataSourceBuilder.create(ds).listener(new QueryExecutionListener() {
                    @Override public void beforeQuery(ExecutionInfo e, List<QueryInfo> q) {}
                    @Override public void afterQuery(ExecutionInfo e, List<QueryInfo> queries) {
                        if (!ON.get()) return;
                        synchronized (LOG) {
                            for (QueryInfo qi : queries) {
                                int batch = Math.max(1, qi.getParametersList().size());
                                String sql = qi.getQuery().replaceAll("\\s+", " ").trim();
                                if (e.isBatch() && batch > 1) {
                                    sql = sql + "   [batch ×" + batch + "]";
                                }
                                LOG.add(sql);
                            }
                        }
                    }
                }).build();
            }
        };
    }
}
```

⚠️ **為什麼要包 `DataSource` 而不是看 log**：

```
🔴 spring.jpa.show-sql: true
     → 印的是 Hibernate【準備要送】的 SQL，不含 MyBatis、不含 JdbcTemplate
     → 而且它印到 stdout，沒辦法斷言

🔴 logging.level.org.hibernate.SQL: DEBUG
     → 同上，只看得到 Hibernate 這一側

✅ 包 DataSource
     → 看得到【所有】走 JDBC 的東西：Hibernate、MyBatis、JdbcTemplate、Flyway
     → 是一個【可以斷言的數字】
     → ★ 這是唯一能公平比較兩個框架的量尺（0.7 就是靠它）
```

📌 **它還有一個附加價值：`[batch ×N]` 標記。**
06 章要處理「`saveAll()` 為什麼不是批次」時，
**你需要能區分「50 句 INSERT」與「1 句 INSERT，batch ×50」**——
這兩者在資料庫端的成本差 20 倍以上（07 站 00 章 0.7.4 測到 22 倍）。

**怎麼用**：

```java
SqlSpy.start();
tx.executeWithoutResult(s -> {
    for (OrderE o : orders.findByStatus("PENDING")) {
        o.getCustomer().getDisplayName();
        o.getItems().size();
    }
});
SqlSpy.dumpGrouped("訂單列表頁", SqlSpy.stop());
```

**而在測試裡，它變成一個斷言**：

```java
@Test
void 訂單列表頁不可以有N加一() {
    fx.seed(50, 200);

    SqlSpy.start();
    List<OrderDetailRow> rows = details.listJoined("PENDING");
    List<String> sqls = SqlSpy.stop();

    assertThat(rows).hasSize(200);
    // ★ 這一行讓 N+1 在 CI 就變紅，而不是上線之後才被使用者發現
    assertThat(sqls)
            .as("列表頁的 SQL 句數不可以隨資料量成長")
            .hasSize(1);
}
```

> 📌 **這條斷言是這一站最有價值的一行程式碼。**
> 它把「N+1」從一個「需要有經驗的人 code review 才看得出來的問題」，
> 變成一個**任何人改壞了都會立刻知道的紅燈**。
>
> ⚠️ **而且要注意 `hasSize(1)` 這個寫法**：不要寫 `isLessThan(10)`。
> **N+1 的本質是「句數隨資料量成長」**，所以正確的斷言是一個**固定的數字**——
> 一旦有人加了一個 lazy 的關聯存取，這條測試就會紅。

**替代方案：Hibernate 的 `Statistics`**

如果你的專案只用 JPA，Hibernate 內建的統計就夠了，而且它**告訴你更多**：

```yaml
spring:
  jpa:
    properties:
      hibernate:
        generate_statistics: true      # ⚠️ 有效能成本，只在測試 profile 開
```

```java
Statistics st = emf.unwrap(SessionFactory.class).getStatistics();
st.clear();

tx.executeWithoutResult(s -> {
    for (OrderE o : orders.findByStatus("PENDING")) {
        o.getCustomer().getDisplayName();
        o.getItems().size();
    }
});

System.out.println("  prepared statements = " + st.getPrepareStatementCount());
System.out.println("  查詢執行次數         = " + st.getQueryExecutionCount());
System.out.println("  實體載入次數         = " + st.getEntityLoadCount());
System.out.println("  集合載入次數         = " + st.getCollectionLoadCount());
System.out.println("  實體 fetch 次數      = " + st.getEntityFetchCount());
```

**同一個場景（20 張訂單、20 個客戶）的實測**：

```
═══ Hibernate Statistics ═══
  prepared statements = 41
  查詢執行次數         = 1
  實體載入次數         = 80
  集合載入次數         = 20
  實體 fetch 次數      = 20
```

⚠️ **`prepared statements = 41` 跟 `SqlSpy` 數到的 41 完全一致**（0.3.2）。
**但 `Statistics` 多告訴你 N+1 是【怎麼來的】**：

```
查詢執行次數 = 1       ← 你只寫了一個查詢
集合載入次數 = 20      ← 🔴 o.getItems() 觸發了 20 次集合載入
實體 fetch 次數 = 20   ← 🔴 o.getCustomer() 觸發了 20 次實體 fetch
實體載入次數 = 80      ← 20 orders + 40 items + 20 customers
                        1 + 20 + 20 = 41 句 SQL
```

📌 **兩個工具的分工**：

| | `SqlSpy`（datasource-proxy） | Hibernate `Statistics` |
|---|---|---|
| 看得到 MyBatis / JdbcTemplate | ✅ | 🔴 看不到 |
| 看得到實際的 SQL 字串 | ✅ | 🔴 只有數字 |
| 分辨 batch | ✅ `[batch ×N]` | 🟡 有 `getPrepareStatementCount` 但看不出形狀 |
| **告訴你 N+1 的來源** | 🔴 要自己看 SQL 猜 | ✅ **`collectionLoad` / `entityFetch` 直接指出來** |
| 二級快取命中率 | 🔴 | ✅ |

> **本課兩個都用**：`SqlSpy` 當公平的量尺（要跟 MyBatis 比較），
> `Statistics` 當 JPA 的診斷工具（04、06 章）。

### 0.10.4 測試資料的固定裝置

```java
package com.example.lab;

import com.example.lab.jpa.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** 每個實驗開始前，把資料庫回到一個已知狀態。 */
@Component
public class Fixtures {

    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;
    private final CustomerRepo customers;
    private final ProductRepo products;
    private final OrderRepo orders;

    public Fixtures(JdbcTemplate jdbc, TransactionTemplate tx,
                    CustomerRepo customers, ProductRepo products, OrderRepo orders) {
        this.jdbc = jdbc; this.tx = tx;
        this.customers = customers; this.products = products; this.orders = orders;
    }

    public void clean() {
        // ⚠️ 順序不能反：有外鍵（07 站 1.10.3）
        jdbc.update("DELETE FROM order_item");
        jdbc.update("DELETE FROM orders");
        jdbc.update("DELETE FROM stock");
        jdbc.update("DELETE FROM product");
        jdbc.update("DELETE FROM customer");
    }

    /** 建 customerCount 個客戶、3 個商品、orderCount 張訂單（每張 2 筆明細）。回傳訂單 id。 */
    public List<UUID> seed(int customerCount, int orderCount) {
        clean();
        List<UUID> orderIds = new ArrayList<>();
        tx.executeWithoutResult(s -> {
            List<CustomerE> cs = new ArrayList<>();
            for (int i = 0; i < customerCount; i++) {
                cs.add(customers.save(new CustomerE(Uuid7.next(), "c" + i + "@x.com", "客戶" + i)));
            }
            List<ProductE> ps = new ArrayList<>();
            for (int i = 0; i < 3; i++) {
                ps.add(products.save(new ProductE(Uuid7.next(), "SKU-" + i, "商品" + i,
                        new BigDecimal((100 + i * 50) + ".0000"))));
            }
            for (int i = 0; i < orderCount; i++) {
                UUID oid = Uuid7.next();
                OrderE o = new OrderE(oid, String.format("SO-2026-%08d", i + 1),
                                      cs.get(i % cs.size()));
                o.addItem(new OrderItemE(Uuid7.next(), o, ps.get(i % 3), 1 + i % 3));
                o.addItem(new OrderItemE(Uuid7.next(), o, ps.get((i + 1) % 3), 1));
                orders.save(o);
                orderIds.add(oid);
            }
        });
        return orderIds;
    }
}
```

⚠️ **注意 `seed` 是用 JPA 寫入的，所以它自己就會踩到 0.3.3 那個 `merge` 問題**——
`seed(50, 200)` 會打出大約 `(50 + 3 + 200×(1+1)) × 2` 句 SQL。
**這在測試固定裝置裡完全可以接受**（它只是慢，不是錯），
但它是一個很好的提醒：**那個問題是全域的，不只發生在你注意到的地方。**

📌 **06 站 06 章 6.7、6.8 已經完整處理過「測試資料怎麼準備」與「測試之間怎麼清乾淨」**，
本站沿用那一套，不重複。

---

### 0.10.5 這一站的兩個閱讀體例

**一、實測輸出的標頭就是節號。**
本站每一個實測都會印一行 `═══ 節號 標題 ═══`，
所以**你看到的輸出，可以直接對回課文的哪一節**：

```
═══ 6.3.7 讓批次失效的第四件事 ═══      ← 這一段輸出來自 6.3.7
```

📌 **而一個小節裡有好幾組實驗的時候，後面幾組會加一個字母**：

```
6.3.4   IDENTITY 主鍵讓批次失效
6.3.4b  ← 同一節裡的第二組實驗（不是另一個小節，目錄裡找不到它）
8.6.8   keyset 的教科書寫法
8.6.8b  ← 同一節裡的第二組
```

**所以看到 `6.3.4b` 這種編號，去 `6.3.4` 那一節裡找那段輸出。**
（少數幾個 `b` 大到需要自己一個標題 —— 例如 `8.3.11b`、`9.3.1b` —— 那就在目錄裡。）

**二、「實驗變體」與「成品」用套件名分開。**

```
com.example.lab.chNN   ← 第 NN 章的【實驗變體】：常常是同一張表的好幾種映射，
                          而且有些是【刻意寫壞的】（例如 6.4 的 Wide6 / WideDyn6）
com.example.lab.shop   ← shop-service 的【成品】：01 章開始長，09 章結束
```

⚠️ **不要把 `chNN` 的類別當成建議寫法**——
它們存在的目的是「讓兩種寫法的差別變成一個可以量的數字」。
**每一章最後那個「shop-service 落地」小節，才是本站建議的樣子。**

---

## 0.11 常見誤區

**誤區 1：「JPA 跟 Hibernate 是一樣的東西」**

→ 0.4.1：**規格 vs 實作**。而且這個分不清楚有實際後果——
**你的 SQL 是 Hibernate 產的**，所以查資料、看 issue、讀 release note
都要去 Hibernate 那邊，不是 Spring Data。

**誤區 2：「Spring Data JPA 是一個 ORM」**

→ 0.4.1：它是 **ORM 的使用者**。0.4.2 實測：
`orders.findById()` 產出的 SQL 跟 `em.find()` **一字不差**。

**誤區 3：「用了 ORM 就不用懂 SQL」**

→ 0.3 那六個事故裡有五個，**要看得懂 SQL 才診斷得出來**。
JPA 不會讓你不用懂 SQL，**它讓你更難看到 SQL**——
所以本課第 00 章就先建 `SqlSpy`（0.10.3）。

**誤區 4：「用 MyBatis 就不會 N+1」**

→ 0.7 實測：MyBatis 的巢狀 `select` 打了 **201 句**。
**N+1 跟框架無關，跟你怎麼寫有關。**
差別只在「你看不看得見」（0.7 結論二）。

**誤區 5：「`save()` 就是把資料存進去」**

→ 0.3.3：它是「把物件同步到持久化情境」，
而同步的第一步是**搞清楚資料庫現在什麼狀態**——所以應用端指定主鍵時它會多一句 `SELECT`。
而且 0.3.1 反過來也成立：**不呼叫 `save()`，資料一樣會存進去。**

**誤區 6：「`@Transactional` 加了就安全了」**

→ 0.3.5：交易保證的是**原子性**，不是**沒有覆蓋**。
`version` 的約定只有 JPA 遵守，**混用時樂觀鎖會靜默失效**，
而且 0.6.4 說明了例外可能在你意想不到的那一行才拋出來。

**誤區 7：「先用 `ddl-auto: update`，之後再換成 Flyway」**

→ 0.6.5：它**不會刪欄位、不會改型別、不可重現、沒有回滾**。
而「之後再換」的意思是「等到那個資料庫已經有生產資料的時候再換」——
**那正是最不該做 schema 實驗的時刻。**

**誤區 8：「以後可能要換資料庫，所以要用 JPA」**

→ 0.8.3 理由一。**實務上幾乎不會發生**，而且 `Dialect` 只解決語法、不解決行為差異
（06 站 06 章 21 根探針裡有 12 根在 H2 與 MySQL 之間就不一樣）。

**誤區 9：「測試用 H2 就好，JPA 的方言會處理差異」**

→ 0.6.6 最後一段。**方言抽象不是「測試不用真資料庫」的許可證。**
06 站 06 章已經證明了那條路的代價：**3 根探針推翻了先前章節寫下的結論。**

**誤區 10：「效能不好就換 MyBatis」**

→ 0.7 的兩個數字：
**修 N+1 省 57 ms，換框架省 6 ms。**
**選型是常數倍，寫法是量級。**

**誤區 11：「MyBatis 的 SQL 都在眼前，所以比較不會出錯」**

→ 0.5.3 實測：MyBatis 的錯誤**全部推遲到執行期**
（`Invalid bound statement` 在呼叫時才炸，Spring Data 是啟動就失敗）。
0.5.4 更狠：`UUID` 少一個 `TypeHandler`，**影響 0 列，一個例外都沒有。**

**誤區 12：「兩個框架混用會有交易問題」**

→ 反過來：**混用的交易是最不用擔心的部分**（共用 `DataSource` 與交易管理器）。
真正的地雷是 0.9 那三條規則——**`version` 的約定、`flush` 的時機、一級快取的舊資料。**

---

## 0.12 本章小結

**這一章沒有教任何一個 JPA 或 MyBatis 的語法。** 它做的是三件事：

**① 讓你看見六個「程式碼看起來完全正確」的事故**（0.3），
並且證明其中五個**在單機、小資料量的開發環境下看不出來**（0.3.7）。

**② 把三個名字與兩個世界觀講清楚**（0.4、0.5、0.6）：

```
Jakarta Persistence  =  規格（介面與註解）
Hibernate ORM        =  實作（真的產生 SQL 的那個）
Spring Data JPA      =  抽象（幫你把 Repository 實作出來，是 ORM 的【使用者】）
MyBatis              =  SQL Mapper（映射「SQL 的參數與結果」，不是「物件與資料表」）
```

**③ 給你一把量尺**（0.10.3 的 `SqlSpy`），
讓「這一頁打了幾句 SQL」從一個模糊的感覺，變成一個**可以寫進 CI 的斷言**。

**如果只能帶走三句話**：

> **① ORM 與 SQL Mapper 的差別不在語法，在【決定權在誰手上】。**
> JPA 拿走決定權（什麼時候寫、寫什麼、從哪載入），換來「你不用管」；
> MyBatis 把決定權還給你，換來「你什麼都要管」。**兩邊都不是免費的。**
>
> **② 六條軸裡最根本的是「有沒有狀態」（0.6.2）。**
> JPA 在你的程式與資料庫之間放了一個「會記住東西、會自己做決定」的中間層——
> N+1、`LazyInitializationException`、髒檢查、`merge` vs `persist`、
> 批次為什麼失效、樂觀鎖怎麼運作，**全部都是這一句話的推論。**
>
> **③ 選型是常數倍，寫法是量級。**
> 0.7 實測：修 N+1 省 57 ms，換掉整個框架省 6 ms。
> **一個懂 N+1 的 JPA 專案，遠快過一個不懂的 MyBatis 專案。**

---

### 0.12.1 驗收清單

**概念**：

```
□ 說得出 JPA / Hibernate / Spring Data JPA 三者的關係，以及各自對應哪一個 jar
□ 說得出 javax → jakarta 發生了什麼，以及它為什麼讓大部分網路教學失效
□ 說得出 MyBatis 為什麼不是 ORM，以及它「映射」的到底是什麼
□ 說得出 0.6.7 那六條軸，並且知道哪一條是其他幾條的根源
□ 說得出 0.8.2 的七個判準，並能用它們替一個假想專案選型
□ 說得出 0.8.3 那三個「不該拿來當理由」的理由，以及為什麼
```

**動手**：

```
□ 起一個 MySQL 8，灌進 0.3.0 那份 schema，並確認字元集 / 定序 / 時區都正確
□ 建好 0.10.2 那個專案，四個版本號印出來跟本章一致
□ 把 SqlSpy 接上去，重現 0.3.1（JPA 那句 UPDATE 有九個欄位、version 變 1）
□ 重現 0.3.2 的 N+1，並用 dumpGrouped 看到「×20」那兩列
□ 重現 0.3.3（save 全新實體 = SELECT + INSERT），並用 em.persist 讓它變成 1 句
□ 重現 0.3.5 的樂觀鎖失效，然後把 MyBatis 那句 UPDATE 加上 version = version + 1，
  確認 A 這次會被 ObjectOptimisticLockingFailureException 擋住
□ 寫出 0.10.3 那條 hasSize(1) 的斷言，然後【刻意把它改壞】
  （把 listJoined 換成 listNPlus1），確認它真的會紅
```

⚠️ **最後一項是這一章的重點練習。**
06 站 00 章講過：**每一條守門測試，都應該有一個「我讓它紅過」的紀錄。**
一條從來沒有紅過的測試，你不知道它到底有沒有在守門。

### 0.12.2 本章練習

**練習一（暖身）：把 0.3.1 的九個欄位變成兩個**

`@DynamicUpdate` 加在 `OrderE` 上，重跑 0.3.1，觀察 `UPDATE` 的欄位數。
**然後回答**：既然它「只寫改過的欄位」看起來明顯更好，
為什麼 Hibernate 不把它設成預設值？（提示：它要為每一次 `UPDATE` 做什麼事？06 章 6.4）

**練習二：找出你自己專案裡的 N+1**

把 `SqlSpy` 接進一個你手上的專案（或 06 站的 shop-service），
挑三支「列表類」的 API，各跑一次，用 `dumpGrouped` 看句數。

**判準**：任何一個 `×N` 而 N 跟資料量有關的，就是 N+1。
**把它們列出來**——04 章會逐一修掉。

**練習三：替三個假想專案選型**

用 0.8.2 的七個判準，各寫 200 字的選型說明：

```
① 一個新的訂單系統，團隊 4 人，schema 自己設計，需求每兩週一次改動
② 接手一個十年的保險核保系統，300 張表、沒有外鍵、大量 stored procedure
③ 一個 BI 報表服務，唯讀，資料來自三個不同的資料庫，查詢形狀固定但很複雜
```

⚠️ **評分標準不是「選對」，是「理由跟判準對得上」。**
（參考答案：① JPA ② MyBatis ③ MyBatis 或直接 `JdbcTemplate`；
但如果你的理由充分，選別的也可以。）

**練習四（進階）：讓混用的約定變成一個測試**

0.9 規則一說「非 JPA 的寫入路徑必須自己維護 `version`」。
**寫一個測試把這個約定釘住**：

```java
@Test
void 每一句更新orders的SQL都必須維護version() {
    // 提示一：MyBatis 的 Configuration 拿得到所有 MappedStatement
    //         sqlSessionFactory.getConfiguration().getMappedStatements()
    // 提示二：MappedStatement.getBoundSql(null).getSql() 拿得到 SQL 字串
    //         （注意動態 SQL 需要給參數；先用最簡單的情況）
    // 提示三：先過濾出 SqlCommandType.UPDATE 且 SQL 含 "orders" 的
    // 斷言：每一句都包含 "version = version + 1"
}
```

**然後刻意加一句違規的 `UPDATE`，確認它會紅。**

**練習五（思考題）：那條斷言該寫幾**

0.10.3 那條斷言寫的是 `hasSize(1)`。
**但如果那一頁本來就合理需要 3 句 SQL**（例如：查訂單、查明細、查一個統計數字），
你會怎麼寫？

**要回答的問題**：
- 寫 `hasSize(3)` 的話，別人加了一個合理的第 4 句查詢，測試會紅——這是好事還是壞事？
- 寫 `isLessThanOrEqualTo(5)` 的話，你失去了什麼？
- 有沒有辦法讓斷言表達「句數不隨資料量成長」而不是「句數等於某個常數」？
  （提示：跑兩次，一次 10 筆資料、一次 100 筆，斷言兩次的句數**相等**）

📌 **練習五的第三個提示，是這一站最實用的 N+1 測試模式。**
04 章 4.9 會把它寫成一個可以重複使用的工具。

---

## 0.13 下一章預告

**01 章：Entity 映射基礎。**

這一章講完了「JPA 是什麼」，01 章開始動手：
把 07 站 01 章 1.12 那份 schema，**一張表一張表地映射成實體**。

⚠️ **而它會立刻撞上這一章留下的問題**：

| 這一章留下的 | 01 章怎麼處理 |
|---|---|
| 0.3.3：應用端指定主鍵 → `save()` 多一句 `SELECT` | **1.6**：五種主鍵策略的完整比較，以及 `Persistable` 的兩個坑 |
| 0.4.5：`GenerationType.UUID` 產的是 v4 不是 v7 | **1.6.8**：自訂 `IdentifierGenerator`，或乾脆不用 `@GeneratedValue` |
| 0.6.5：`ddl-auto: validate` 通不過 | **1.12**：把這份 schema 調到 `validate` 通過，並列出撞到的每一個坑 |
| 0.4.4：`@Column(nullable=false)` 與 `@NotNull` 是兩件事 | **1.11**：兩份規格的分工，以及它們跟 07 站約束的三層關係 |
| 07 站 1.10.5：11 條不變量，資料庫只守得住 6 條 | **1.13**：剩下 5 條在 JPA 的世界裡守在哪 |
| 07 站 1.12：`email_active` 那個生成欄位 | **1.8**：生成欄位怎麼映射（以及為什麼不能讓 JPA 寫它） |

**還有三個這一章刻意沒提的映射問題**：

```
① status VARCHAR(16) 對應 Java 的 enum —— @Enumerated 的兩個選項，
   其中一個會讓你的資料在「有人重排 enum 順序」時全部錯掉
② DATETIME(3) 對應 Instant / LocalDateTime / OffsetDateTime ——
   三個選一個，而 07 站 00 章 0.6 那四個時區會再打一次架
③ DECIMAL(19,4) 對應 BigDecimal —— 精度與 scale 不一致時，
   Hibernate 會【靜默】四捨五入
```

📌 **01 章結束時，你會有一份完整的、`validate` 通得過的實體對應**，
而 0.3.1 那個「九個欄位的 `UPDATE`」還會在——**它要等 06 章。**
