# 第 06 章：效能與並行控制 —— 批次寫入、二級快取、樂觀鎖與悲觀鎖

> 05 章把那個列表頁壓到了 **2 ms、0 個實體**。
> 而它有一個從頭到尾沒有被質疑的前提：
>
> ```
> 這個查詢一秒只跑一次。
> ```
>
> **2 ms × 每秒 500 次 = 1 秒。**
> 而那一秒裡，資料庫做的是**同一件事 500 次**。
>
> ---
>
> 前面五章都在問「**這一次**操作打了幾句 SQL、建了幾個物件」。
> 這一章換一個問法：
>
> > **同樣的一句 SQL，跑 1000 次的時候，它還是同一件事嗎？**
> > **而兩個人同時跑它的時候，誰會贏？**

---

這一章有 **60 個實測**。挑十二個先講結果：

- `repository.saveAll(一千筆全新資料)` —— **2000 句 SQL**。
  多出來的那 1000 句是 `SELECT`（00 章 0.3.3 那個事故，乘一千倍）
- 打開 `hibernate.jdbc.batch_size=50` 之後，`execute()` 從 2000 次掉到 1020 次 ——
  🔴🔴 **而 MySQL 伺服器剖析的 INSERT 還是 1000 句，一句都沒少**。
  真正讓它變成 20 句的，是一個**不在任何 Java 程式碼裡**的 JDBC URL 參數 ★★
- 1000 筆資料，四種寫法：**160 ms / 21 ms / 12 ms / 12 ms**
- 迴圈裡多一句 `count(*)`，批次從 4 次 `execute` 變成 **400 次**
- `@DynamicUpdate` 讓 `UPDATE` 從 20 欄變 1 欄 ——
  🔴 而它**跟批次寫入互斥**，同一份工作從 316 ms 變成 **384 ms**（更慢）
- 二級快取「預設是關的」——**只對一半**：
  classpath 上多一個 jar，`isSecondLevelCacheEnabled()` 就變 `true`，而你沒有寫任何一行組態
- 六個商品全部在二級快取裡，`select p from ProdC6 p` 還是打了 **1 句 SQL**；
  換成 6 次 `find(id)` 是 **0 句** ★★
- 🔴 每一份教學都說「查詢快取只存 id，所以一定要搭配實體快取」——
  **Hibernate 6 的查詢快取裡存的是整列的欄位值**，實測給你看
- 集合的二級快取開起來之後，同一段程式碼從 **2 句 SQL 變成 3 句**（變糟了）
- 🔴🔴 `LockModeType.OPTIMISTIC` 在 **MySQL 的預設隔離等級下完全無效** ——
  它在交易裡重讀 `version`，而那次重讀命中的是**自己的快照**（03 章 3.3.4）。
  換成 `READ COMMITTED` 就會拋例外 ★★
- 死鎖被 Hibernate 包成 **`OptimisticLockException`** ——
  一個跟樂觀鎖完全無關的錯誤，用了樂觀鎖的名字
- 🔴 `@Modifying(clearAutomatically = true)` 會**把還沒 flush 的 `INSERT` 整個丟掉**。
  症狀：**庫存扣掉了、訂單不見了、沒有任何錯誤訊息**。
  這一節會修正 05 章 5.6.5 的一個結論 ★★

📌 **這一章的主線**：

> **前面五章解的是「一次操作的成本」。**
> **這一章解的是兩個新問題：**
>
> **① 一萬次同樣的操作，能不能不要付一萬次成本？**（6.3～6.5）
> **② 兩個人同時做同一件事，怎麼保證帳是對的？**（6.6～6.8）
>
> **而這兩個問題有一個共同的答案形狀：**
> **它們的解法都【不在你的 Java 程式碼裡】。**
> **一個在組態檔與 JDBC URL 上，一個在 SQL 的 `WHERE` 條件裡。**

⚠️ **這一章跟前面五章有一個重要的差別**：

```
01～05 章的實測，同一段程式碼跑一百次，結果都一樣。
06 章 6.6 之後的實測【每次跑的數字都會不一樣】——
因為它們量的是【兩條執行緒誰先誰後】。
```

所以 6.6 之後的每一個實驗，**斷言都不能寫在「成功幾個」上面**，
要寫在「**帳對不對**」上面。6.8 會把這件事變成一張表。

---

## 6.1 學習目標

完成本章後，你應該可以：

- 說出 `saveAll()` 為什麼**不是**批次，並算出它對 N 筆全新資料會打幾句 SQL（6.3.1）。
- 列出讓 JDBC 批次**靜默失效**的四件事，並說明其中哪一件**跟 Hibernate 完全無關**（6.3.4～6.3.7）。
- 用三把不同層次的尺，分辨「Hibernate 準備了幾個 statement」、
  「JDBC 呼叫了幾次 `execute()`」、「**資料庫伺服器剖析了幾句 SQL**」（6.2.4）。
- 說明 `@DynamicUpdate` 的兩面，並回答 01 章 1.16.2 的練習：
  **既然它明顯更好，為什麼 Hibernate 不設成預設值**（6.4）。
- 開起二級快取，並說出**哪三種東西適合放**、哪三種**放了會出事**（6.5.11）。
- 解釋為什麼「一個不建實體的查詢」也可能是「每次都打資料庫的查詢」，
  並用 `secondLevelCacheHitCount` 把它變成斷言（6.5.12）。
- 用 `@Version` 擋住 lost update，並說明**為什麼「靜默覆蓋」比「拋例外」糟糕得多**（6.6.3）。
- 說出 `LockModeType.OPTIMISTIC` 的前提條件，並解釋它在 MySQL 上為什麼常常無效（6.6.7）。
- 把重試寫在**正確的交易邊界**上，並說出寫錯的症狀（6.6.8）。
- 讀懂 `PESSIMISTIC_READ` / `PESSIMISTIC_WRITE` / `PESSIMISTIC_FORCE_INCREMENT`
  各自產生的 SQL，並用 `NOWAIT` / `SKIP LOCKED` 避免整支 API 卡住（6.7）。
- 在**無鎖 / 樂觀鎖 / 悲觀鎖 / 原子 `UPDATE`** 之間，
  依「衝突窗口有多長」與「失敗要怎麼回報」做選擇（6.8.6）。
- 說明交易除了正確性以外的另一個成本：**它抓著一條連線**（6.9）。

---

## 6.2 這一章的模型與量尺

### 6.2.1 表結構

`ch06` 這個資料庫在前面五章那五張表之外，多了**六張專門用來做實驗的表**。

```sql
DROP DATABASE IF EXISTS ch06;
CREATE DATABASE ch06 DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE ch06;

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

-- 庫存：6.8 的四種扣減做法都打這張表
CREATE TABLE stock (
  product_id   binary(16) NOT NULL,
  qty          int NOT NULL DEFAULT 0,
  reserved_qty int NOT NULL DEFAULT 0,
  version      bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id),
  CONSTRAINT fk_stock_product FOREIGN KEY (product_id) REFERENCES product (id)
) ENGINE=InnoDB;

CREATE TABLE orders (
  id               binary(16)     NOT NULL,
  order_no         varchar(32)    NOT NULL,
  customer_id      binary(16)     NOT NULL,
  status           varchar(16)    NOT NULL,
  total_amount     decimal(19,4)  NOT NULL,
  discount_amount  decimal(19,4)  NOT NULL DEFAULT 0,
  currency         char(3)        NOT NULL DEFAULT 'TWD',
  placed_at        datetime(3)    NOT NULL,
  paid_at          datetime(3)    NULL,
  memo             varchar(255)   NULL,
  version          bigint         NOT NULL DEFAULT 0,
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

-- ───────── 6.3 批次寫入的實驗表 ─────────

-- 應用端指定主鍵（UUIDv7）：批次可以生效
CREATE TABLE bulk_uuid (
  id      binary(16)    NOT NULL,
  code    varchar(32)   NOT NULL,
  amount  decimal(19,4) NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB;

-- IDENTITY 主鍵：批次【完全】失效
CREATE TABLE bulk_identity (
  id      bigint        NOT NULL AUTO_INCREMENT,
  code    varchar(32)   NOT NULL,
  amount  decimal(19,4) NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB;

-- 表序列（MySQL 沒有真序列，Hibernate 用一張表模擬）
CREATE TABLE bulk_seq (
  id      bigint        NOT NULL,
  code    varchar(32)   NOT NULL,
  amount  decimal(19,4) NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB;
CREATE TABLE bulk_seq_seq (next_val bigint) ENGINE=InnoDB;
INSERT INTO bulk_seq_seq (next_val) VALUES (1);

-- 有 @Version 的批次
CREATE TABLE bulk_ver (
  id      binary(16)    NOT NULL,
  code    varchar(32)   NOT NULL,
  amount  decimal(19,4) NOT NULL,
  version bigint        NOT NULL DEFAULT 0,
  PRIMARY KEY (id)
) ENGINE=InnoDB;

-- 交錯型別：6.3.5 的 order_inserts 要用
CREATE TABLE bulk_child (
  id         binary(16)  NOT NULL,
  parent_id  binary(16)  NOT NULL,
  label      varchar(32) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_bulk_child_parent (parent_id),
  CONSTRAINT fk_bulk_child_parent FOREIGN KEY (parent_id) REFERENCES bulk_uuid (id)
) ENGINE=InnoDB;

-- ───────── 6.4 @DynamicUpdate 的寬表 ─────────
CREATE TABLE wide_row (
  id   binary(16)  NOT NULL,
  c01  varchar(64) NOT NULL DEFAULT '', c02 varchar(64) NOT NULL DEFAULT '',
  c03  varchar(64) NOT NULL DEFAULT '', c04 varchar(64) NOT NULL DEFAULT '',
  c05  varchar(64) NOT NULL DEFAULT '', c06 varchar(64) NOT NULL DEFAULT '',
  c07  varchar(64) NOT NULL DEFAULT '', c08 varchar(64) NOT NULL DEFAULT '',
  c09  varchar(64) NOT NULL DEFAULT '', c10 varchar(64) NOT NULL DEFAULT '',
  c11  varchar(64) NOT NULL DEFAULT '', c12 varchar(64) NOT NULL DEFAULT '',
  c13  varchar(64) NOT NULL DEFAULT '', c14 varchar(64) NOT NULL DEFAULT '',
  c15  varchar(64) NOT NULL DEFAULT '', c16 varchar(64) NOT NULL DEFAULT '',
  c17  varchar(64) NOT NULL DEFAULT '', c18 varchar(64) NOT NULL DEFAULT '',
  c19  varchar(64) NOT NULL DEFAULT '', c20 varchar(64) NOT NULL DEFAULT '',
  PRIMARY KEY (id)
) ENGINE=InnoDB;

-- ───────── 6.5 二級快取的參數表（read-mostly） ─────────
CREATE TABLE country (
  code      char(2)     NOT NULL,
  name      varchar(64) NOT NULL,
  currency  char(3)     NOT NULL,
  PRIMARY KEY (code)
) ENGINE=InnoDB;
INSERT INTO country (code, name, currency) VALUES
  ('TW','台灣','TWD'), ('JP','日本','JPY'), ('US','美國','USD'),
  ('HK','香港','HKD'), ('SG','新加坡','SGD');
```

📌 **注意 `orders` 這張表比 05 章多了三欄**：`discount_amount`、`currency`、`memo`、`paid_at`。
它們**沒有任何業務意義**，唯一的用途是讓「這張表有八個以上的欄位」——
6.4 要量的就是「改一欄、`UPDATE` 幾欄」。

⚠️ **`bulk_seq_seq` 那張表要手動建**。
01 章那個坑還在：`GenerationType.SEQUENCE` 在 MySQL 上會去找一張 `<名稱>` 表，
`ddl-auto: none` 的時候啟動就炸。

### 6.2.2 實體

三個共用的東西先給。**基礎類別跟 05 章的 `Base5` 一樣**（原樣搬來，只改了名字）：

```java
package com.example.lab.ch06;

import jakarta.persistence.Id;
import jakarta.persistence.MappedSuperclass;
import org.hibernate.Hibernate;
import java.util.UUID;

@MappedSuperclass
public abstract class Base6 {

    @Id private UUID id;

    protected Base6() {}
    protected Base6(UUID id) { this.id = id; }

    public UUID getId() { return id; }

    /** ★ 對代理安全的 equals（01 章 1.14.3）。代價見 04 章 4.3.2。 */
    @Override public final boolean equals(Object o) {
        if (this == o) return true;
        if (o == null || Hibernate.getClass(this) != Hibernate.getClass(o)) return false;
        UUID mine = getId();
        return mine != null && mine.equals(((Base6) o).getId());
    }
    @Override public final int hashCode() { return Hibernate.getClass(this).hashCode(); }
}
```

```java
package com.example.lab.ch06;

public enum St6Status { PENDING, PAID, PACKED, SHIPPED, DELIVERED, CANCELLED, REFUNDED }
```

**主鍵產生器**（`Uuid7`，跟 00 章 0.3.0 那份一字不差，原樣搬來）：

```java
package com.example.lab;

import java.nio.ByteBuffer;
import java.security.SecureRandom;
import java.util.UUID;

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

**訂單與明細**。跟 05 章的 `Ord5` 比，差別是**多了三個欄位與 `@Version`**：

```java
package com.example.lab.ch06;

import jakarta.persistence.*;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** 06 章的訂單：有 @Version、十個欄位（6.4 的 @DynamicUpdate 對照要用）。 */
@Entity @Table(name = "orders")
public class Ord6 extends Base6 {

    @Column(name = "order_no", nullable = false, length = 32) private String orderNo;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "customer_id", nullable = false) private Cust6 customer;

    @Enumerated(EnumType.STRING) @JdbcTypeCode(SqlTypes.VARCHAR)
    @Column(nullable = false, length = 16) private St6Status status = St6Status.PENDING;

    @Column(name = "total_amount", nullable = false, precision = 19, scale = 4)
    private BigDecimal totalAmount = BigDecimal.ZERO;
    @Column(name = "discount_amount", nullable = false, precision = 19, scale = 4)
    private BigDecimal discountAmount = BigDecimal.ZERO;
    @Column(nullable = false, length = 3) @JdbcTypeCode(SqlTypes.CHAR)
    private String currency = "TWD";
    @Column(name = "placed_at", nullable = false) private Instant placedAt;
    @Column(name = "paid_at") private Instant paidAt;
    @Column(length = 255) private String memo;

    @Version private long version;

    @OneToMany(mappedBy = "order", cascade = CascadeType.ALL, orphanRemoval = true)
    private List<Item6> items = new ArrayList<>();

    protected Ord6() {}
    public Ord6(UUID id, String orderNo, Cust6 customer) {
        super(id); this.orderNo = orderNo; this.customer = customer;
        this.placedAt = Instant.parse("2026-09-01T00:00:00Z");
    }

    public void pay() { this.status = St6Status.PAID; this.paidAt = Instant.now(); }
    public void cancel() { this.status = St6Status.CANCELLED; }
    public void setMemo(String m) { this.memo = m; }
    public void addItem(Item6 i) { items.add(i); totalAmount = totalAmount.add(i.getLineAmount()); }

    public String getOrderNo() { return orderNo; }
    public Cust6 getCustomer() { return customer; }
    public St6Status getStatus() { return status; }
    public void setStatus(St6Status s) { this.status = s; }
    public BigDecimal getTotalAmount() { return totalAmount; }
    public BigDecimal getDiscountAmount() { return discountAmount; }
    public String getCurrency() { return currency; }
    public Instant getPlacedAt() { return placedAt; }
    public Instant getPaidAt() { return paidAt; }
    public String getMemo() { return memo; }
    public long getVersion() { return version; }
    public List<Item6> getItems() { return items; }
}
```

```java
package com.example.lab.ch06;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.util.UUID;

@Entity @Table(name = "order_item")
public class Item6 extends Base6 {

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "order_id", nullable = false) private Ord6 order;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "product_id", nullable = false) private Prod6 product;

    @Column(name = "product_name", nullable = false, length = 200) private String productName;
    @Column(name = "unit_price", nullable = false, precision = 19, scale = 4) private BigDecimal unitPrice;
    @Column(nullable = false) private int qty;
    @Column(name = "line_amount", nullable = false, precision = 19, scale = 4) private BigDecimal lineAmount;

    protected Item6() {}
    public Item6(UUID id, Ord6 order, Prod6 product, int qty) {
        super(id);
        this.order = order; this.product = product;
        this.productName = product.getName(); this.unitPrice = product.getUnitPrice();
        this.qty = qty;
        this.lineAmount = product.getUnitPrice().multiply(BigDecimal.valueOf(qty));
    }

    public Ord6 getOrder() { return order; }
    public Prod6 getProduct() { return product; }
    public String getProductName() { return productName; }
    public BigDecimal getUnitPrice() { return unitPrice; }
    public int getQty() { return qty; }
    public BigDecimal getLineAmount() { return lineAmount; }
}
```

**客戶與商品**（都有 `@Version`）：

```java
package com.example.lab.ch06;

import jakarta.persistence.*;
import java.util.UUID;

@Entity @Table(name = "customer")
public class Cust6 extends Base6 {

    @Column(nullable = false, length = 255) private String email;
    @Column(name = "display_name", nullable = false, length = 64) private String displayName;
    @Column(nullable = false, length = 16) private String tier = "NORMAL";
    @Version private long version;

    protected Cust6() {}
    public Cust6(UUID id, String email, String displayName) {
        super(id); this.email = email; this.displayName = displayName;
    }

    public String getEmail() { return email; }
    public String getDisplayName() { return displayName; }
    public void rename(String n) { this.displayName = n; }
    public String getTier() { return tier; }
    public void setTier(String t) { this.tier = t; }
    public long getVersion() { return version; }
}
```

```java
package com.example.lab.ch06;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.util.UUID;

@Entity @Table(name = "product")
public class Prod6 extends Base6 {

    @Column(nullable = false, length = 32) private String sku;
    @Column(nullable = false, length = 200) private String name;
    @Column(nullable = false, length = 32) private String category;
    @Column(name = "unit_price", nullable = false, precision = 19, scale = 4)
    private BigDecimal unitPrice;
    @Version private long version;

    protected Prod6() {}
    public Prod6(UUID id, String sku, String name, String category, BigDecimal price) {
        super(id); this.sku = sku; this.name = name; this.category = category; this.unitPrice = price;
    }

    public String getSku() { return sku; }
    public String getName() { return name; }
    public String getCategory() { return category; }
    public BigDecimal getUnitPrice() { return unitPrice; }
    public void setUnitPrice(BigDecimal p) { this.unitPrice = p; }
    public long getVersion() { return version; }
}
```

**庫存**。它是 6.6～6.8 的主角，`reserve()` 就是那條「庫存不為負」的不變量：

```java
package com.example.lab.ch06;

import jakarta.persistence.*;
import java.util.UUID;

/** 有 @Version 的庫存：6.6 樂觀鎖、6.8 扣減實驗的主角。 */
@Entity @Table(name = "stock")
public class St6 {

    @Id @Column(name = "product_id") private UUID productId;

    /** ★ 共用主鍵的一對一，而且單向（02 章 2.7.3：反向側的 LAZY 無效）。 */
    @OneToOne(fetch = FetchType.LAZY, optional = false) @MapsId
    @JoinColumn(name = "product_id") private Prod6 product;

    @Column(nullable = false) private int qty;
    @Column(name = "reserved_qty", nullable = false) private int reservedQty;
    @Version private long version;

    protected St6() {}
    public St6(Prod6 product, int qty) { this.product = product; this.qty = qty; }

    /** 領域規則：庫存不可為負。 */
    public void reserve(int n) {
        if (n <= 0) throw new IllegalArgumentException("數量必須大於 0");
        if (qty - n < 0) throw new IllegalStateException("庫存不足：剩 " + qty + " 要 " + n);
        qty -= n;
        reservedQty += n;
    }
    public void restock(int n) { qty += n; }

    public UUID getProductId() { return productId; }
    public Prod6 getProduct() { return product; }
    public int getQty() { return qty; }
    public int getReservedQty() { return reservedQty; }
    public long getVersion() { return version; }
}
```

**repository**。每一個一個檔案（03 章那個坑：**巢狀介面掃不到**）：

```java
package com.example.lab.ch06;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.UUID;

public interface Ord6Repo extends JpaRepository<Ord6, UUID> {
    java.util.List<Ord6> findByStatus(St6Status status);
}
```

```java
package com.example.lab.ch06;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.UUID;

public interface St6Repo extends JpaRepository<St6, UUID> {}
```

（`Cust6Repo`、`Prod6Repo`、`Item6Repo` 同一個形狀，都是空的 `JpaRepository`。）

### 6.2.3 「同一張表多個映射」的變體

02 章那個手法在這一章用得最兇：**九個實體，映射到五張表**。
每一個變體只跟本體差一個註解，這樣「差別是那個註解造成的」就沒有第二種解釋。

| 變體 | 對應的表 | 跟本體差什麼 | 哪一節要用 |
|---|---|---|---|
| `StNoVer6` | `stock` | **沒有 `@Version`**，連 `version` 欄位都不映射 | 6.6.3 |
| `Wide6` | `wide_row` | 20 個欄位，預設行為 | 6.4.1 |
| `WideDyn6` | `wide_row` | 只多一個 **`@DynamicUpdate`** | 6.4.1 |
| `Bulk6` | `bulk_uuid` | 應用端指定 UUID 主鍵 | 6.3 全部 |
| `BulkId6` | `bulk_identity` | **`GenerationType.IDENTITY`** | 6.3.4 |
| `BulkSeq6` | `bulk_seq` | **表序列，`allocationSize = 50`** | 6.3.4 |
| `BulkVer6` | `bulk_ver` | UUID 主鍵 **+ `@Version`** | 6.3.12 / 6.6.11 |
| `BulkChild6` | `bulk_child` | `Bulk6` 的子實體 | 6.3.5 |
| `ProdC6` | `product` | 多一個 **`@Cache(READ_WRITE)`** | 6.5 |
| `CustC6` | `customer` | `@Cache` **+ 集合上也有 `@Cache`** | 6.5.7 |
| `Ord6C` | `orders` | **故意沒有 `@Cache`**（`CustC6.orders` 的元素） | 6.5.7 |
| `Country6` | `country` | `@Immutable` + `@Cache(READ_ONLY)` | 6.5 |

先給 6.6.3 要用的那個「沒有 `@Version`」的版本，因為它是這一章最重要的對照組：

```java
package com.example.lab.ch06;

import jakarta.persistence.*;
import java.util.UUID;

/**
 * 同一張 stock 表的另一個映射（02 章的手法）：【沒有 @Version】。
 * 6.6.3 用它量「沒有樂觀鎖的下場」——而它連 version 欄位都不映射，
 * 所以它的 UPDATE 不會碰那一欄（這正是 00 章事故五那個形狀）。
 */
@Entity @Table(name = "stock")
public class StNoVer6 {

    @Id @Column(name = "product_id") private UUID productId;
    @Column(nullable = false) private int qty;
    @Column(name = "reserved_qty", nullable = false) private int reservedQty;

    protected StNoVer6() {}

    public void reserve(int n) {
        if (qty - n < 0) throw new IllegalStateException("庫存不足：剩 " + qty + " 要 " + n);
        qty -= n; reservedQty += n;
    }

    public UUID getProductId() { return productId; }
    public int getQty() { return qty; }
    public int getReservedQty() { return reservedQty; }
}
```

⚠️ **有一個坑要先說**：`StNoVer6` 跟 `St6` 映射到**同一張表**，
而 `St6` 有 `@Version`。這代表**兩個實體對同一列的並行保護等級不一樣**——
在真實專案裡這是災難（00 章事故五的同一個形狀）。
**這裡是刻意的，而且只用在實驗**。6.10.3 會給一條把它擋在 CI 的斷言。

其餘的變體會在各自的小節裡整份貼出來。

### 6.2.4 量尺：這一章要三把 ★★

前面五章用兩把尺：`SqlSpy`（datasource-proxy，看得到 MyBatis）與
Hibernate 的 `Statistics`（分得出 `entityFetch` / `collectionLoad`）。
**這一章要第三把，而且第三把是這一章最重要的工具。**

先說為什麼要第三把。看這個問題：

```
「1000 筆資料，打開 batch_size=50 之後，變成幾句 SQL？」
```

這個問題有**三個都對的答案**，取決於你問誰：

```
① 問 Hibernate      →「我準備了 1 個 PreparedStatement」
② 問 JDBC           →「我呼叫了 20 次 executeBatch()，裡面夾了 1000 句敘述」
③ 問 MySQL 伺服器    →「我剖析並執行了 1000 句 INSERT」    ← 🔴 一句都沒少
```

**前兩把尺都站在 JDBC API 之上，而 6.3.7 那件事發生在 JDBC 驅動【裡面】。**
只有問伺服器才看得到。

第三把尺長這樣：

```java
package com.example.lab.ch06;

import org.springframework.jdbc.core.JdbcTemplate;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * 第三把尺：問【資料庫伺服器】自己「你剖析了幾句 SQL」。
 *
 * Com_insert 這類計數器是【每一句進到伺服器的敘述 +1】，不是每一列 +1，
 * 而 Innodb_rows_inserted 是每一列 +1 —— 兩個一起看就知道
 * 「1000 列資料，最後變成幾句 SQL 進到伺服器」。
 */
public class MysqlStat {

    private static final List<String> KEYS = List.of(
            "Com_insert", "Com_update", "Com_delete", "Com_select", "Com_commit",
            "Com_stmt_prepare", "Com_stmt_execute",
            "Innodb_rows_inserted", "Innodb_rows_updated", "Innodb_rows_deleted",
            "Innodb_rows_read");

    private final JdbcTemplate jdbc;
    private Map<String, Long> base = Map.of();

    public MysqlStat(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    /**
     * ⚠️ 一定要用 SHOW GLOBAL STATUS，不能用 performance_schema.global_status：
     *    那張表【沒有 Com_* 這些計數器】（本機 MySQL 8.0.46 上 323 個變數裡
     *    只有 Com_stmt_reprepare 一個 Com_），查了會全部拿到 0 而不會報錯。
     */
    private Map<String, Long> read() {
        Map<String, Long> m = new LinkedHashMap<>();
        KEYS.forEach(k -> m.put(k, 0L));
        jdbc.query("SHOW GLOBAL STATUS", rs -> {
            String k = rs.getString(1);
            if (m.containsKey(k)) m.put(k, (long) Double.parseDouble(rs.getString(2)));
        });
        return m;
    }

    public void mark() { base = read(); }

    public Map<String, Long> delta() {
        Map<String, Long> now = read(), d = new LinkedHashMap<>();
        base.forEach((k, v) -> d.put(k, now.get(k) - v));
        return d;
    }

    public long delta(String key) { return delta().getOrDefault(key, 0L); }

    /** 只印非零的計數器。 */
    public String line() {
        return delta().entrySet().stream().filter(e -> e.getValue() != 0)
                .map(e -> e.getKey().replace("Innodb_rows_", "列.").replace("Com_", "")
                        + "=" + e.getValue())
                .collect(Collectors.joining("  "));
    }

    public void dump(String title) {
        System.out.println("── " + title + " │ 伺服器端：" + line());
    }
}
```

⚠️ **這裡有一個「量測工具自己騙了我」的實例，值得記下來**：

```
第一版用的是 performance_schema.global_status（比較「現代」的做法）。
它【不會報錯】，它只是把 Com_insert 回成 0。
於是所有的實驗都顯示「伺服器端沒有任何 INSERT」——
一個明顯荒謬、但看起來很像「批次真的把 SQL 合併掉了」的結論。

換成老派的 SHOW GLOBAL STATUS 才拿到真實的數字。
```

> 📌 **這是 03 章那條教訓的另一個形狀**：
> **觀測工具給了一個數字，不代表那個數字量到了你以為的東西。**
> 判準是：**先讓工具在一個你已經知道答案的情境上跑一次。**
> 「insert 1000 筆，`Com_insert` 應該大於 0」——這個檢查花三十秒，省了一整章的錯誤結論。

**把三把尺印在一起**，就是這一章大部分實測的輸出格式：

```java
    /** 一段程式碼在三個層次各留下什麼。 */
    protected Layers layers(String title, Runnable body) {
        MysqlStat ms = mysql();
        Stats st = stats();
        st.reset();
        ms.mark();
        List<String> sqls = spy(body);
        Layers r = new Layers(title, sqls, st, ms.delta());
        System.out.println(r);
        return r;
    }

    protected static class Layers {
        public final String title;
        public final List<String> sqls;
        /** JDBC 層：呼叫了幾次 execute()/executeBatch()。 */
        public final int executes;
        /** JDBC 層：那些 execute 裡總共夾了幾句敘述（batch ×N 展開）。 */
        public final int statements;
        /** JDBC 層：其中有幾次是 executeBatch()。 */
        public final int batches;
        public final long hbInsert, hbUpdate, hbDelete, hbStmt;
        public final Map<String, Long> server;

        Layers(String title, List<String> sqls, Stats st, Map<String, Long> server) {
            this.title = title;
            this.sqls = sqls;
            this.executes = sqls.size();
            int stm = 0, b = 0;
            for (String s : sqls) {
                int i = s.indexOf("[batch ×");
                if (i < 0) { stm++; }
                else {
                    b++;
                    stm += Integer.parseInt(s.substring(i + 8, s.indexOf(']', i)).trim());
                }
            }
            this.statements = stm;
            this.batches = b;
            this.hbInsert = st.entityInsert(); this.hbUpdate = st.entityUpdate();
            this.hbDelete = st.entityDelete(); this.hbStmt = st.stmt();
            this.server = server;
        }

        /** 伺服器端真正剖析了幾句 DML。 */
        public long serverDml() {
            return server.getOrDefault("Com_insert", 0L)
                 + server.getOrDefault("Com_update", 0L)
                 + server.getOrDefault("Com_delete", 0L);
        }

        @Override public String toString() {
            StringBuilder sb = new StringBuilder();
            sb.append("── ").append(title).append('\n');
            sb.append(String.format("   ① Hibernate  準備 %d 個 statement（insert %d / update %d / delete %d 個實體）%n",
                    hbStmt, hbInsert, hbUpdate, hbDelete));
            sb.append(String.format("   ② JDBC       execute() %d 次，其中 executeBatch() %d 次，共夾 %d 句敘述%n",
                    executes, batches, statements));
            sb.append("   ③ MySQL      ").append(
                    server.entrySet().stream().filter(e -> e.getValue() != 0)
                        .map(e -> e.getKey().replace("Innodb_rows_", "列.").replace("Com_", "")
                                  + "=" + e.getValue())
                        .reduce((a, x) -> a + "  " + x).orElse("（沒有變化）"));
            return sb.toString();
        }
    }
```

而 `SqlSpy` 那一側要能分辨「一次 `executeBatch()` 夾了幾句」。
**00 章 0.10.3 那份 `SqlSpy` 已經做了這件事**，這裡把它整份搬過來（原樣，沒有改）：

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

    @Bean
    public static BeanPostProcessor dataSourceSpy() {           // ★ 要 static
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
                                // ★ 一次 executeBatch() 夾了幾句，記在後面
                                if (e.isBatch() && batch > 1) sql = sql + "   [batch ×" + batch + "]";
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

📌 **還有第四把尺，只在關鍵處用一次：MySQL 的 general log。**
它記下**每一個字節**進到伺服器的東西，是 6.3.7 那個結論的最終證據：

```java
    private void withGeneralLog(String title, Runnable body) {
        jdbc.update("SET GLOBAL log_output = 'TABLE'");
        jdbc.update("TRUNCATE TABLE mysql.general_log");
        jdbc.update("SET GLOBAL general_log = 'ON'");
        try { body.run(); } finally { jdbc.update("SET GLOBAL general_log = 'OFF'"); }
        List<String> rows = jdbc.query(
                "SELECT command_type, CONVERT(argument USING utf8mb4) FROM mysql.general_log"
                        + " WHERE command_type <> 'Quit' ORDER BY event_time, thread_id",
                (rs, n) -> rs.getString(1) + " │ " + rs.getString(2));
        System.out.println("── " + title + " → 伺服器收到 " + rows.size() + " 筆");
        for (String r : rows) System.out.println("   " + cut(r));
    }
```

⚠️ **general log 只能開來做實驗**：它會把每一句 SQL 寫進 `mysql.general_log`，
正式環境開了就是自己 DDoS 自己。

**測試的基底**（這一章所有實驗共用）：

```java
package com.example.lab.ch06;

import com.example.lab.SqlSpy;
import com.example.lab.Uuid7;
import jakarta.persistence.EntityManager;
import jakarta.persistence.EntityManagerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@SpringBootTest(properties = {
  "spring.datasource.url=jdbc:mysql://127.0.0.1:33306/ch06?connectionTimeZone=UTC"
      + "&forceConnectionTimeZoneToSession=true&preserveInstants=true&characterEncoding=UTF-8",
  "spring.jpa.properties.hibernate.generate_statistics=true"
})
public abstract class Base06 {

    @Autowired protected EntityManager em;
    @Autowired protected EntityManagerFactory emf;
    @Autowired protected JdbcTemplate jdbc;
    @Autowired protected TransactionTemplate tx;

    protected final List<UUID> orderIds = new ArrayList<>();
    protected final List<UUID> customerIds = new ArrayList<>();
    protected final List<UUID> productIds = new ArrayList<>();

    protected void cleanBulk() {
        jdbc.update("DELETE FROM bulk_child");
        jdbc.update("DELETE FROM bulk_uuid");
        jdbc.update("DELETE FROM bulk_identity");
        jdbc.update("DELETE FROM bulk_seq");
        jdbc.update("DELETE FROM bulk_ver");
        jdbc.update("UPDATE bulk_seq_seq SET next_val = 1");
    }

    protected void clean() {
        jdbc.update("DELETE FROM order_item");
        jdbc.update("DELETE FROM orders");
        jdbc.update("DELETE FROM stock");
        jdbc.update("DELETE FROM product");
        jdbc.update("DELETE FROM customer");
        jdbc.update("DELETE FROM wide_row");
    }

    /**
     * orderCount 張訂單、customerCount 個客戶、每張 itemsPer 筆明細。
     * ★ 用 JDBC batchUpdate 塞資料，不經過 JPA —— 免得 seed 的 SQL 混進實測數字
     *   （跟 04 章 Base04.seed 同一個做法）。
     */
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
                    new BigDecimal((100 * itemsPer) + ".0000"),
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

    /** 只留一個商品、庫存 qty，給 6.8 的並行實驗用。 */
    protected UUID seedOneStock(int qty) {
        seed(0, 1, 0);
        UUID pid = productIds.get(0);
        jdbc.update("UPDATE stock SET qty = ?, reserved_qty = 0, version = 0 WHERE product_id = ?",
                qty, Uuid7.toBytes(pid));
        return pid;
    }

    protected void head(String t) { System.out.println("\n═══ " + t + " ═══"); }

    /** ★ catch (RuntimeException | Error)：03 章那個坑，finally 裡 return 會吞例外。 */
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

    protected static String cut(String s) {
        return s.length() > 150 ? s.substring(0, 150) + "…" : s;
    }

    protected MysqlStat mysql() { return new MysqlStat(jdbc); }
    protected CacheSpy cache() { return new CacheSpy(emf); }
    protected Stats stats() { return new Stats(emf); }

    protected static class Stats {
        private final org.hibernate.stat.Statistics s;
        Stats(EntityManagerFactory emf) {
            s = emf.unwrap(org.hibernate.SessionFactory.class).getStatistics();
        }
        public void reset() { s.clear(); }
        public long stmt() { return s.getPrepareStatementCount(); }
        public long entityInsert() { return s.getEntityInsertCount(); }
        public long entityUpdate() { return s.getEntityUpdateCount(); }
        public long entityDelete() { return s.getEntityDeleteCount(); }
        public long entityLoad() { return s.getEntityLoadCount(); }
        public long optimisticFailure() { return s.getOptimisticFailureCount(); }
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

（`Layers`、`layers()`、以及 6.6 之後才需要的並行工具 `race()` / `outside()` / `catching()`
也在這個類別裡，分別在 6.2.4 上面與 6.6.2 貼出。）

---
## 6.3 批次寫入 ★★

### 6.3.1 實測：`saveAll(1000)` 打了幾句 SQL

先問一個看起來不用問的問題。

```java
    @Test
    void a_saveAll_的真相() {
        head("6.3.1 saveAll(1000) 打了幾句 SQL？（沒有任何批次組態）");
        cleanBulk();
        List<Bulk6> data = rows(1000);
        Layers r = layers("saveAll(1000 筆)",
                () -> tx.executeWithoutResult(s -> bulks.saveAll(data)));
        System.out.println("   → 第一句是：" + cut(r.sqls.get(0)));
        System.out.println("   資料庫裡："
                + jdbc.queryForObject("SELECT count(*) FROM bulk_uuid", Integer.class) + " 筆");
    }

    private static List<Bulk6> rows(int n) {
        List<Bulk6> list = new ArrayList<>(n);
        for (int i = 0; i < n; i++)
            list.add(new Bulk6(Uuid7.next(), "C-" + i, new BigDecimal(i + ".0000")));
        return list;
    }
```

而 `Bulk6` 是這一節所有實驗的主角：

```java
package com.example.lab.ch06;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.util.UUID;

/** 應用端指定主鍵（UUIDv7）：批次插入的基準版。 */
@Entity @Table(name = "bulk_uuid")
public class Bulk6 {

    @Id private UUID id;
    @Column(nullable = false, length = 32) private String code;
    @Column(nullable = false, precision = 19, scale = 4) private BigDecimal amount;

    protected Bulk6() {}
    public Bulk6(UUID id, String code, BigDecimal amount) {
        this.id = id; this.code = code; this.amount = amount;
    }

    public UUID getId() { return id; }
    public String getCode() { return code; }
    public void setCode(String c) { this.code = c; }
    public BigDecimal getAmount() { return amount; }
    public void setAmount(BigDecimal a) { this.amount = a; }
}
```

**實測**：

```
── saveAll(1000 筆)
   ① Hibernate  準備 2000 個 statement（insert 1000 / update 0 / delete 0 個實體）
   ② JDBC       execute() 2000 次，其中 executeBatch() 0 次，共夾 2000 句敘述
   ③ MySQL      insert=1000  select=1000  commit=1  列.inserted=1000
   → 第一句是：select b1_0.id,b1_0.amount,b1_0.code from bulk_uuid b1_0 where b1_0.id=?
   資料庫裡：1000 筆
```

🔴🔴 **兩件事同時發生了**：

**第一件：`executeBatch()` 是 0 次。** `saveAll` 完全沒有批次。

**第二件：2000 句，不是 1000 句。**
而第一句是 **`SELECT`** ——這就是 **00 章 0.3.3 那個事故三，乘一千倍**。

回顧一下那個機制（00 章 0.3.3 講過，這裡是它的後果）：

```
SimpleJpaRepository.save(entity) {
    if (entityInformation.isNew(entity)) em.persist(entity);
    else                                 return em.merge(entity);
}
```

而 `isNew()` 的預設判斷是「**id 是不是 null**」。
`Bulk6` 的 id 是應用端指定的 UUIDv7 —— **它從來不是 null**。
所以每一筆都走 `merge`，而 `merge` 對「不在持久化情境裡的實體」要先 `SELECT` 一次
才知道它是新的還是舊的。

> 📌 **01 章 1.6.6 的 `Persistable` 就是為了這件事**。
> `shop-service` 的 `BaseEntity` 有實作，所以 `save()` 不會多查；
> 而 `Bulk6` **刻意沒有實作**——這樣才量得到那 1000 句。

### 6.3.2 實測：`saveAll`、`save` 迴圈、`persist` 迴圈

```java
    @Test
    void b_saveAll_跟_for_迴圈_完全一樣() {
        head("6.3.2 saveAll 跟自己寫 for 迴圈有差別嗎？");
        cleanBulk();
        Layers a = layers("saveAll(200)", () ->
                tx.executeWithoutResult(s -> bulks.saveAll(rows(200))));
        cleanBulk();
        Layers b = layers("for 迴圈 save(200)", () ->
                tx.executeWithoutResult(s -> { for (Bulk6 x : rows(200)) bulks.save(x); }));
        cleanBulk();
        Layers c = layers("for 迴圈 em.persist(200)", () ->
                tx.executeWithoutResult(s -> { for (Bulk6 x : rows(200)) em.persist(x); }));
        System.out.printf("%n   三者 JDBC execute 次數：saveAll=%d  save 迴圈=%d  persist 迴圈=%d%n",
                a.executes, b.executes, c.executes);
    }
```

**實測**：

```
── saveAll(200)
   ② JDBC       execute() 400 次，其中 executeBatch() 0 次，共夾 400 句敘述
── for 迴圈 save(200)
   ② JDBC       execute() 400 次，其中 executeBatch() 0 次，共夾 400 句敘述
── for 迴圈 em.persist(200)
   ② JDBC       execute() 200 次，其中 executeBatch() 0 次，共夾 200 句敘述

   三者 JDBC execute 次數：saveAll=400  save 迴圈=400  persist 迴圈=200
```

> 📌 **`saveAll` 就是一個 `for` 迴圈**。看 Spring Data 的原始碼就知道：
>
> ```java
> public <S extends T> List<S> saveAll(Iterable<S> entities) {
>     List<S> result = new ArrayList<>();
>     for (S entity : entities) result.add(save(entity));    // ← 就這樣
>     return result;
> }
> ```
>
> **`saveAll` 這個名字暗示了「一次做完」，而它做的事跟你自己寫迴圈一模一樣。**
> **批次不是 API 的事，是【組態】的事。**

而 `em.persist` 比 `save` 少一半，因為它**不做那個存在性檢查**——
`persist` 的語義就是「這是新的」，它不需要問。

> 📌 **這是「寫入路徑該用哪一個 API」的第一個判準**：
> **你確定它是新的 → `em.persist`。**
> **你不確定 → `save`，並且付一句 `SELECT`（或實作 `Persistable`）。**

### 6.3.3 實測：打開 `batch_size`

Hibernate 的批次是一個組態：

```yaml
spring:
  jpa:
    properties:
      hibernate:
        jdbc:
          batch_size: 50
```

它也可以在 session 層級動態設定，這樣同一個測試裡就可以兩種都量：

```java
    @Test
    void c_開_batch_size_之後() {
        head("6.3.3 同一段程式碼，只把 JDBC batch size 從 0 改成 50");
        cleanBulk();
        List<Bulk6> d1 = rows(1000);
        Layers off = layers("batchSize 未設定", () -> tx.executeWithoutResult(s -> bulks.saveAll(d1)));

        cleanBulk();
        List<Bulk6> d2 = rows(1000);
        Layers on = layers("batchSize = 50（session 層級）", () -> tx.executeWithoutResult(s -> {
            em.unwrap(Session.class).setJdbcBatchSize(50);      // ★ Hibernate 6 的 API
            bulks.saveAll(d2);
        }));
        System.out.printf("%n   execute() 次數：%d → %d%n", off.executes, on.executes);
        System.out.printf("   伺服器剖析的 DML：%d → %d 句%n", off.serverDml(), on.serverDml());
    }
```

**實測**：

```
── batchSize 未設定
   ① Hibernate  準備 2000 個 statement（insert 1000 個實體）
   ② JDBC       execute() 2000 次，其中 executeBatch() 0 次，共夾 2000 句敘述
   ③ MySQL      insert=1000  select=1000  commit=1  列.inserted=1000
── batchSize = 50（session 層級）
   ① Hibernate  準備 1001 個 statement（insert 1000 個實體）
   ② JDBC       execute() 1020 次，其中 executeBatch() 20 次，共夾 2000 句敘述
   ③ MySQL      insert=1000  select=1020  commit=1  列.inserted=1000

   execute() 次數：2000 → 1020
   伺服器剖析的 DML：1000 → 1000 句
```

三個層次都要讀：

```
① Hibernate 準備的 statement：2000 → 1001
   1000 句 SELECT 還在（那是 save 的問題，跟批次無關），
   而 1000 句 INSERT 變成【1 個】PreparedStatement —— 它被重複使用了 1000 次。

② JDBC execute()：2000 → 1020
   1000 次 SELECT + 20 次 executeBatch()。1000 / 50 = 20，公式對得上。

③ 🔴 MySQL 的 Com_insert：1000 → 1000
   一句都沒少。
```

> 🔴 **這就是這一章最容易被誤解的地方。**
> **`batch_size` 減少的是「JDBC 呼叫的次數」，不是「進到資料庫的 SQL 句數」。**
> **為什麼會這樣，6.3.7 會用 general log 給你看。**

### 6.3.4 🔴 讓批次失效的第一件事：`IDENTITY` 主鍵

01 章 1.8.3 說過「`IDENTITY` 讓批次完全失效」。量一次。

```java
package com.example.lab.ch06;

import jakarta.persistence.*;
import java.math.BigDecimal;

/** IDENTITY 主鍵：01 章 1.8.3 說它會讓批次失效，6.3.4 把那句話量出來。 */
@Entity @Table(name = "bulk_identity")
public class BulkId6 {

    @Id @GeneratedValue(strategy = GenerationType.IDENTITY) private Long id;
    @Column(nullable = false, length = 32) private String code;
    @Column(nullable = false, precision = 19, scale = 4) private BigDecimal amount;

    protected BulkId6() {}
    public BulkId6(String code, BigDecimal amount) { this.code = code; this.amount = amount; }

    public Long getId() { return id; }
    public String getCode() { return code; }
}
```

```java
package com.example.lab.ch06;

import jakarta.persistence.*;
import java.math.BigDecimal;

/**
 * 表序列（MySQL 沒有真的 SEQUENCE，Hibernate 用一張 bulk_seq_seq 表模擬）。
 * allocationSize = 50：一次取 50 個號碼回來，所以插 1000 筆只需要 20 次取號。
 */
@Entity @Table(name = "bulk_seq")
public class BulkSeq6 {

    @Id
    @GeneratedValue(strategy = GenerationType.SEQUENCE, generator = "bulk_seq_gen")
    @SequenceGenerator(name = "bulk_seq_gen", sequenceName = "bulk_seq_seq", allocationSize = 50)
    private Long id;

    @Column(nullable = false, length = 32) private String code;
    @Column(nullable = false, precision = 19, scale = 4) private BigDecimal amount;

    protected BulkSeq6() {}
    public BulkSeq6(String code, BigDecimal amount) { this.code = code; this.amount = amount; }

    public Long getId() { return id; }
    public String getCode() { return code; }
}
```

```java
    @Test
    void d_IDENTITY_讓批次完全失效() {
        head("6.3.4 🔴 IDENTITY 主鍵：01 章 1.8.3 說它讓批次失效，量一次");
        cleanBulk();
        Layers uuid = layers("Bulk6（應用端 UUID 主鍵）+ batchSize 50", () ->
                tx.executeWithoutResult(s -> {
                    em.unwrap(Session.class).setJdbcBatchSize(50);
                    for (int i = 0; i < 500; i++)
                        em.persist(new Bulk6(Uuid7.next(), "U-" + i, BigDecimal.ONE));
                }));
        cleanBulk();
        Layers ident = layers("BulkId6（IDENTITY 主鍵）+ batchSize 50", () ->
                tx.executeWithoutResult(s -> {
                    em.unwrap(Session.class).setJdbcBatchSize(50);
                    for (int i = 0; i < 500; i++)
                        em.persist(new BulkId6("I-" + i, BigDecimal.ONE));
                }));
        cleanBulk();
        Layers seq = layers("BulkSeq6（表序列，allocationSize=50）+ batchSize 50", () ->
                tx.executeWithoutResult(s -> {
                    em.unwrap(Session.class).setJdbcBatchSize(50);
                    for (int i = 0; i < 500; i++)
                        em.persist(new BulkSeq6("S-" + i, BigDecimal.ONE));
                }));
        System.out.printf("%n   500 筆，三種主鍵策略的 execute() 次數：UUID=%d  IDENTITY=%d  SEQUENCE=%d%n",
                uuid.executes, ident.executes, seq.executes);
    }
```

**實測**：

```
── Bulk6（應用端 UUID 主鍵）+ batchSize 50
   ① Hibernate  準備 1 個 statement（insert 500 個實體）
   ② JDBC       execute() 10 次，其中 executeBatch() 10 次，共夾 500 句敘述
   ③ MySQL      insert=500  select=10  commit=1  列.inserted=500
── BulkId6（IDENTITY 主鍵）+ batchSize 50
   ① Hibernate  準備 500 個 statement（insert 500 個實體）
   ② JDBC       execute() 500 次，其中 executeBatch() 0 次，共夾 500 句敘述   ← 🔴
   ③ MySQL      insert=500  commit=1  列.inserted=500
── BulkSeq6（表序列，allocationSize=50）+ batchSize 50
   ① Hibernate  準備 1 個 statement（insert 500 個實體）
   ② JDBC       execute() 32 次，其中 executeBatch() 10 次，共夾 522 句敘述
   ③ MySQL      insert=500  update=11  select=21  commit=12  列.inserted=500  列.updated=11

   500 筆，三種主鍵策略的 execute() 次數：UUID=10  IDENTITY=500  SEQUENCE=32
```

**`IDENTITY` 是 500 次，`executeBatch()` 一次都沒有。** 為什麼？

```java
    @Test
    void e_persist_一筆就冒出_id() {
        head("6.3.4b 為什麼 IDENTITY 一定不能批次");
        cleanBulk();
        tx.executeWithoutResult(s -> {
            em.unwrap(Session.class).setJdbcBatchSize(50);
            BulkId6 x = new BulkId6("X", BigDecimal.ONE);
            System.out.println("   persist 之前 id = " + x.getId());
            List<String> sqls = spy(() -> em.persist(x));
            System.out.println("   persist 之後 id = " + x.getId() + "（還沒 commit、也還沒 flush）");
            System.out.println("   而 persist 那一行就打了 " + sqls.size() + " 句 SQL：");
            sqls.forEach(q -> System.out.println("      " + cut(q)));

            Bulk6 y = new Bulk6(Uuid7.next(), "Y", BigDecimal.ONE);
            List<String> sqls2 = spy(() -> em.persist(y));
            System.out.println("   對照：UUID 主鍵 persist 打了 " + sqls2.size() + " 句 SQL");
        });
    }
```

**實測**：

```
   persist 之前 id = null
   persist 之後 id = 1（還沒 commit、也還沒 flush）
   而 persist 那一行就打了 1 句 SQL：
      insert into bulk_identity (amount,code) values (?,?)
   對照：UUID 主鍵 persist 打了 0 句 SQL
```

> 🔴 **`IDENTITY` 的 id 是【資料庫在 INSERT 的時候】決定的。**
> 而 JPA 規格要求 `persist()` 之後實體必須有 id
> （因為它要進一級快取，而一級快取的 key 就是 id —— 03 章 3.3.2）。
>
> 所以 Hibernate **沒有選擇**：`persist()` 必須立刻送出那句 `INSERT`，
> 並且用 `getGeneratedKeys()` 把 id 拿回來。
>
> **而「立刻送出」跟「攢起來一起送」是互斥的。**
> **這不是 Hibernate 的實作缺陷，是 `IDENTITY` 這個策略的定義決定的。**

**`SEQUENCE`（表序列）為什麼是 32 次？**

```
10 次 executeBatch()（500 / 50）
+ 11 次 SELECT next_val + 11 次 UPDATE next_val   ← 取號（500/50 = 10 次，加開場 1 次）
= 32
```

而那 11 次取號各自是一個獨立的小交易（`commit=12`），
因為序號**不能跟著業務交易回滾**——否則兩個交易可能拿到同一個號碼。

> 📌 **`allocationSize` 是這裡唯一的旋鈕**：
> `allocationSize = 1` 的話，500 筆要 500 次取號 —— 那就跟 `IDENTITY` 一樣糟了。
> **所以「用 SEQUENCE 就能批次」這句話少了半句：`allocationSize` 也要調大。**

**三種策略的總表**：

| 主鍵策略 | 500 筆的 `execute()` | 能批次 | 額外成本 |
|---|---|---|---|
| 應用端指定（UUIDv7） | **10** | ✅ | 無 |
| `SEQUENCE` + `allocationSize=50` | 32 | ✅ | 每 50 筆 2 句取號 SQL |
| `SEQUENCE` + `allocationSize=1`（預設值） | ~1010 | ✅（但沒意義） | 每一筆 2 句 |
| **`IDENTITY`** | **500** | 🔴 **完全不能** | 每一筆一次來回 |

> 📌 **這張表就是 07 站 1.8.4 選 UUIDv7 的第四個理由**（前三個在那一章）。
> **而它也是 01 章 1.16.2 那個練習的答案的一半**——另一半在 6.4.5。

### 6.3.5 🔴 讓批次失效的第二件事：交錯的實體型別

批次的前提是「連續好幾筆用**同一個** `PreparedStatement`」。
只要中間換了一個型別，前面那一批就得先送出去。

```java
package com.example.lab.ch06;

import jakarta.persistence.*;
import java.util.UUID;

/** 交錯型別的另一半：6.3.5 的 order_inserts 要用。 */
@Entity @Table(name = "bulk_child")
public class BulkChild6 {

    @Id private UUID id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "parent_id", nullable = false) private Bulk6 parent;

    @Column(nullable = false, length = 32) private String label;

    protected BulkChild6() {}
    public BulkChild6(UUID id, Bulk6 parent, String label) {
        this.id = id; this.parent = parent; this.label = label;
    }

    public UUID getId() { return id; }
    public Bulk6 getParent() { return parent; }
    public String getLabel() { return label; }
}
```

```java
    @Test
    void f_交錯型別讓批次碎掉() {
        head("6.3.5 🔴 兩種實體交錯 persist（沒有 order_inserts）");
        cleanBulk();
        Layers grouped = layers("先 100 個父、再 100 個子", () -> tx.executeWithoutResult(s -> {
            em.unwrap(Session.class).setJdbcBatchSize(50);
            List<Bulk6> ps = new ArrayList<>();
            for (int i = 0; i < 100; i++) {
                Bulk6 p = new Bulk6(Uuid7.next(), "P-" + i, BigDecimal.ONE);
                ps.add(p); em.persist(p);
            }
            for (int i = 0; i < 100; i++)
                em.persist(new BulkChild6(Uuid7.next(), ps.get(i), "L-" + i));
        }));
        cleanBulk();
        Layers inter = layers("父、子、父、子…交錯 persist", () -> tx.executeWithoutResult(s -> {
            em.unwrap(Session.class).setJdbcBatchSize(50);
            for (int i = 0; i < 100; i++) {
                Bulk6 p = new Bulk6(Uuid7.next(), "Q-" + i, BigDecimal.ONE);
                em.persist(p);
                em.persist(new BulkChild6(Uuid7.next(), p, "M-" + i));
            }
        }));
        System.out.printf("%n   同樣 200 筆：分組 execute=%d，交錯 execute=%d%n",
                grouped.executes, inter.executes);
    }
```

**實測**：

```
── 先 100 個父、再 100 個子
   ① Hibernate  準備 2 個 statement（insert 200 個實體）
   ② JDBC       execute() 4 次，其中 executeBatch() 4 次，共夾 200 句敘述
── 父、子、父、子…交錯 persist
   ① Hibernate  準備 200 個 statement（insert 200 個實體）
   ② JDBC       execute() 200 次，其中 executeBatch() 0 次，共夾 200 句敘述   ← 🔴

   同樣 200 筆：分組 execute=4，交錯 execute=200
```

**同樣的 200 筆資料、同樣的 `batch_size`，只因為 `persist` 的順序不同，
一個是 4 次、一個是 200 次。**

而修法**不是改程式碼**：

```yaml
spring:
  jpa:
    properties:
      hibernate:
        order_inserts: true      # ★ flush 時把同型別的 INSERT 排在一起
        order_updates: true      # ★ UPDATE 同理
```

```java
    @Test
    void e_order_inserts_修好交錯() {
        head("6.3.5c order_inserts=true：同一段交錯的程式碼");
        cleanBulk();
        Layers inter = layers("父、子、父、子…交錯 persist（order_inserts 已開）", () ->
            tx.executeWithoutResult(s -> {
                for (int i = 0; i < 100; i++) {
                    Bulk6 p = new Bulk6(Uuid7.next(), "Q-" + i, BigDecimal.ONE);
                    em.persist(p);
                    em.persist(new BulkChild6(Uuid7.next(), p, "M-" + i));
                }
            }));
        System.out.println("   → execute=" + inter.executes + "（沒開的時候是 200）");
    }
```

**實測**（這個 context 開了 `order_inserts=true` + `batch_size=50` + rewrite）：

```
── 父、子、父、子…交錯 persist（order_inserts 已開）
   ① Hibernate  準備 2 個 statement（insert 200 個實體）
   ② JDBC       execute() 4 次，其中 executeBatch() 4 次，共夾 200 句敘述
   ③ MySQL      insert=4  select=4  commit=1  列.inserted=200

   → execute=4（沒開的時候是 200）
```

> 📌 **`order_inserts` 為什麼不是預設值？**
> 因為它要**改變 flush 的順序**，而 03 章 3.8.4 證明過
> 「flush 的動作順序是固定的、而且會影響正確性」——
> 排序 `INSERT` 需要先把整批攢在記憶體裡分類，這件事有記憶體成本，
> 而且**在外鍵約束下不是永遠安全的**（父一定要在子之前，Hibernate 靠型別的依賴圖處理）。
>
> ⚠️ **實務上這兩個開關幾乎一定要開**，而且**跟 `batch_size` 一起開才有意義**：
> `batch_size` 沒設的時候，`order_inserts` 什麼事都不做。

### 6.3.6 🔴 讓批次失效的第三件事：迴圈裡夾一句查詢

```java
    @Test
    void g_中間夾一句查詢() {
        head("6.3.5b 🔴 迴圈裡夾一句查詢：auto-flush 把 batch 切碎");
        cleanBulk();
        Layers clean = layers("純 persist 200 筆", () -> tx.executeWithoutResult(s -> {
            em.unwrap(Session.class).setJdbcBatchSize(50);
            for (int i = 0; i < 200; i++) em.persist(new Bulk6(Uuid7.next(), "T-" + i, BigDecimal.ONE));
        }));
        cleanBulk();
        Layers dirty = layers("每 persist 一筆就 count 一次 bulk_uuid", () -> tx.executeWithoutResult(s -> {
            em.unwrap(Session.class).setJdbcBatchSize(50);
            for (int i = 0; i < 200; i++) {
                em.persist(new Bulk6(Uuid7.next(), "V-" + i, BigDecimal.ONE));
                em.createQuery("select count(b) from Bulk6 b", Long.class).getSingleResult();
            }
        }));
        System.out.printf("%n   execute()：%d → %d%n", clean.executes, dirty.executes);
    }
```

**實測**：

```
── 純 persist 200 筆
   ② JDBC       execute() 4 次，其中 executeBatch() 4 次，共夾 200 句敘述
── 每 persist 一筆就 count 一次 bulk_uuid
   ① Hibernate  準備 400 個 statement（insert 200 個實體）
   ② JDBC       execute() 400 次，其中 executeBatch() 0 次，共夾 400 句敘述

   execute()：4 → 400
```

**4 → 400。** 那句 `count` 觸發了 **auto-flush**（03 章 3.7.2）：
Hibernate 發現「你要查 `bulk_uuid`，而我手上有還沒寫出去的 `bulk_uuid` 修改」，
於是先 flush ——**而一次 flush 就是一個 batch 的邊界**。

⚠️ **這個坑在真實程式碼裡長這樣**：

```java
for (Row r : rows) {
    // 「順手」檢查一下有沒有重複
    if (repo.existsByCode(r.code())) continue;     // 🔴 每一圈一次 auto-flush
    em.persist(toEntity(r));
}
```

**修法是把查詢移到迴圈外**：

```java
Set<String> existing = repo.findAllCodes();        // ✅ 一句查完
for (Row r : rows) {
    if (existing.contains(r.code())) continue;
    em.persist(toEntity(r));
}
```

> 📌 **04 章 4.8 那個「手動預熱一級快取」的手法，在這裡是【必要】的**，
> 不是最佳化。差別是那裡省的是 `SELECT` 句數，這裡省的是**整個批次機制**。

### 6.3.7 🔴🔴 讓批次失效的第四件事：批次其實沒有發生 ★★

回到 6.3.3 那個沒有解釋的數字：

```
② JDBC       execute() 20 次
③ MySQL      insert=1000       ← 一句都沒少
```

**打開 general log，看伺服器到底收到什麼。**

```java
    @Test
    void a_三筆_batch_到底送了什麼() {
        head("6.3.6 前置：3 筆 batch，伺服器收到什麼？");
        cleanBulk();
        withGeneralLog("batchSize=50、persist 3 筆", () -> tx.executeWithoutResult(s -> {
            em.unwrap(Session.class).setJdbcBatchSize(50);
            for (int i = 0; i < 3; i++)
                em.persist(new Bulk6(Uuid7.next(), "B-" + i, BigDecimal.ONE));
        }));
    }
```

**實測**：

```
── batchSize=50、persist 3 筆 → 伺服器收到 8 筆
   Query │ SET autocommit=0
   Query │ SELECT @@session.transaction_read_only
   Query │ insert into bulk_uuid (amount,code,id) values (1,'B-0',x'01a07f20ea4e738ba5bf…')
   Query │ insert into bulk_uuid (amount,code,id) values (1,'B-1',x'01a07f20ea5371ccb5de…')
   Query │ insert into bulk_uuid (amount,code,id) values (1,'B-2',x'01a07f20ea537b439d19…')
   Query │ commit
   Query │ SET autocommit=1
```

**對照沒有 batch 的版本**：

```
── batchSize 未設定、persist 3 筆 → 伺服器收到 7 筆
   Query │ SET autocommit=0
   Query │ insert into bulk_uuid (amount,code,id) values (1,'N-0',x'01a07f20ea7c7d5086…')
   Query │ insert into bulk_uuid (amount,code,id) values (1,'N-1',x'01a07f20ea7c7634a1…')
   Query │ insert into bulk_uuid (amount,code,id) values (1,'N-2',x'01a07f20ea7c7b969a…')
   Query │ commit
   Query │ SET autocommit=1
```

> 🔴🔴 **兩者送給伺服器的 `INSERT` 一字不差。**
> **「JDBC 批次」預設只是「把 N 句 SQL 攢起來，然後一句一句送出去」。**
> **它省掉的是 Java 端每一句的 API 開銷，不是網路來回，也不是伺服器的剖析成本。**
>
> （順帶解釋了 6.3.3 那個 `select=1020`：
> **每一次 `executeBatch()`，MySQL 驅動會多送一句 `SELECT @@session.transaction_read_only`。**
> 20 次 batch = 20 句多出來的 SELECT。）

**真正把 1000 句變成 20 句的，是這個**：

```
jdbc:mysql://127.0.0.1:33306/ch06?rewriteBatchedStatements=true
                                   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
```

**它是 MySQL 驅動的參數。Hibernate 完全不知道它存在。**

```java
@SpringBootTest(properties = {
  "spring.datasource.url=jdbc:mysql://127.0.0.1:33306/ch06?rewriteBatchedStatements=true"
      + "&connectionTimeZone=UTC&forceConnectionTimeZoneToSession=true"
      + "&preserveInstants=true&characterEncoding=UTF-8",
  "spring.jpa.properties.hibernate.generate_statistics=true",
  "spring.jpa.properties.hibernate.jdbc.batch_size=50",
  "spring.jpa.properties.hibernate.order_inserts=true",
  "spring.jpa.properties.hibernate.order_updates=true"
})
class H2Rewrite extends Base06 {

    @Test
    void a_rewrite_之後伺服器收到什麼() {
        head("6.3.6 rewriteBatchedStatements=true：3 筆 batch");
        cleanBulk();
        withGeneralLog("rewrite + batchSize=50、persist 3 筆", () -> tx.executeWithoutResult(s -> {
            for (int i = 0; i < 3; i++)
                em.persist(new Bulk6(Uuid7.next(), "R-" + i, BigDecimal.ONE));
        }));
    }
}
```

**實測**：

```
── rewrite + batchSize=50、persist 3 筆 → 伺服器收到 6 筆
   Query │ SET autocommit=0
   Query │ SELECT @@session.transaction_read_only
   Query │ insert into bulk_uuid (amount,code,id) values
          (1,'R-0',x'01a07f218f847dc797ff…'),(1,'R-1',x'01a07f218f857c64b50a…'),(1,'R-2',…)
   Query │ commit
   Query │ SET autocommit=1
```

**驅動把三句 `INSERT` 改寫成一句多值 `INSERT`。**

**1000 筆的三層數字**：

```java
    @Test
    void b_一千筆的三層數字() {
        head("6.3.6 rewrite + batch 50：1000 筆的三層數字");
        cleanBulk();
        Layers r = layers("rewrite + batchSize 50、persist 1000 筆", () ->
                tx.executeWithoutResult(s -> {
                    for (int i = 0; i < 1000; i++)
                        em.persist(new Bulk6(Uuid7.next(), "K-" + i, BigDecimal.ONE));
                }));
        System.out.println("   → 伺服器剖析的 DML：" + r.serverDml() + " 句（1000 列資料）");
    }
```

```
── rewrite + batchSize 50、persist 1000 筆
   ① Hibernate  準備 1 個 statement（insert 1000 個實體）
   ② JDBC       execute() 20 次，其中 executeBatch() 20 次，共夾 1000 句敘述
   ③ MySQL      insert=20  select=20  commit=1  列.inserted=1000

   → 伺服器剖析的 DML：20 句（1000 列資料）
```

**三個層次終於一致了**：1000 列資料 → 20 句 SQL。

**時間上的差別**：

```java
    @Test
    void i_沒有_rewrite_的時間() {
        head("6.3.6b batch 有用嗎？（沒有 rewriteBatchedStatements）");
        for (int bs : new int[]{1, 50, 1000}) {
            long ms = bestMs(() -> { cleanBulk(); tx.executeWithoutResult(s -> {
                em.unwrap(Session.class).setJdbcBatchSize(bs);
                for (int i = 0; i < 1000; i++)
                    em.persist(new Bulk6(Uuid7.next(), "S", BigDecimal.ONE));
            }); }, 1, 3);
            cleanBulk();
            Layers r = layers("batchSize=" + bs + "（無 rewrite）", () -> tx.executeWithoutResult(s -> {
                em.unwrap(Session.class).setJdbcBatchSize(bs);
                for (int i = 0; i < 1000; i++)
                    em.persist(new Bulk6(Uuid7.next(), "S", BigDecimal.ONE));
            }));
            System.out.printf("   batchSize=%-5d execute=%-5d 伺服器 DML=%-5d %4d ms%n",
                    bs, r.executes, r.serverDml(), ms);
        }
    }
```

**實測（1000 筆，同一台機器、同一個容器）**：

```
沒有 rewriteBatchedStatements
   batchSize=1     execute=1000  伺服器 DML=1000   198 ms
   batchSize=50    execute=20    伺服器 DML=1000   167 ms
   batchSize=1000  execute=1     伺服器 DML=1000   153 ms

有 rewriteBatchedStatements=true
   batchSize=1     execute=1000  伺服器 DML=1000   186 ms
   batchSize=5     execute=200   伺服器 DML=200     93 ms
   batchSize=10    execute=100   伺服器 DML=100     50 ms
   batchSize=25    execute=40    伺服器 DML=40      31 ms
   batchSize=50    execute=20    伺服器 DML=20      24 ms
   batchSize=100   execute=10    伺服器 DML=10      18 ms
   batchSize=500   execute=2     伺服器 DML=2       17 ms
   batchSize=1000  execute=1     伺服器 DML=1       14 ms
```

> 🔴 **只開 `batch_size`：198 → 153 ms（1.3 倍）。**
> **`batch_size` + `rewriteBatchedStatements`：198 → 24 ms（8 倍）。**
>
> **而「1.3 倍」這個數字，正是「批次好像沒什麼用」這個印象的來源。**
> 有人開了 `batch_size`、量了一次、發現差不多，於是結論是「批次是玄學」。
> **真相是他只做了兩件事裡的一件，而那一件剛好是效果小的那一件。**

⚠️ **`rewriteBatchedStatements` 的三個注意事項**：

```
① 它是【MySQL 專屬】的。PostgreSQL 的驅動預設就會做等價的事（reWriteBatchedInserts）。
② 改寫後的 SQL 有長度上限（max_allowed_packet，預設 64 MB）。
   batch_size 開太大 + 欄位很寬時，驅動會自己再切開。
③ 🔴 它【只改寫 INSERT … VALUES】。UPDATE 與 DELETE 不會被合併 —— 6.3.11 會量。
```

### 6.3.8 `batch_size` 要開多大

看 6.3.7 那張表的最後三列：

```
batchSize=50    伺服器 DML=20     24 ms
batchSize=100   伺服器 DML=10     18 ms
batchSize=500   伺服器 DML=2      17 ms
batchSize=1000  伺服器 DML=1      14 ms
```

**收益是遞減的**：50 → 100 省 6 ms，100 → 1000 省 4 ms。
而代價**不是線性的**：

| `batch_size` 開大的代價 | 說明 |
|---|---|
| 記憶體 | 一批的參數全部要留在 JDBC 驅動的緩衝區裡 |
| **一次失敗的代價** | batch 裡有一句違反約束 → **整批回滾**，而你不知道是第幾句（6.6.11 會看到） |
| 鎖持有時間 | 一句 1000 個 `VALUES` 的 `INSERT` 會一次鎖 1000 列 |
| `max_allowed_packet` | 超過就被驅動切開，等於白開 |

> 📌 **實務建議：25～100，然後不要再調它。**
> `50` 是一個好起點。**再往上調的收益，遠小於「你花在調它上面的時間」的價值。**
>
> ⚠️ **而 `batch_size` 是【全域】的**（`hibernate.jdbc.batch_size`）。
> 匯入作業想用大一點的值，就在那個 session 上覆寫：
> `em.unwrap(Session.class).setJdbcBatchSize(500)` —— 這是 Hibernate 6 的 API，
> 而且**只影響當前 session**。

### 6.3.9 實測：四種寫法的耗時

```java
    @Test
    void c_四種寫法的時間() {
        head("6.3.7 1000 筆，四種寫法的耗時（rewrite 已開）");
        int n = 1000;

        long tPersist = bestMs(() -> { cleanBulk(); tx.executeWithoutResult(s -> {
            em.unwrap(Session.class).setJdbcBatchSize(1);
            for (int i = 0; i < n; i++) em.persist(new Bulk6(Uuid7.next(), "A", BigDecimal.ONE));
        }); }, 1, 3);

        long tBatch = bestMs(() -> { cleanBulk(); tx.executeWithoutResult(s -> {
            for (int i = 0; i < n; i++) em.persist(new Bulk6(Uuid7.next(), "B", BigDecimal.ONE));
        }); }, 1, 3);

        long tJdbc = bestMs(() -> { cleanBulk();
            List<Object[]> args = new java.util.ArrayList<>();
            for (int i = 0; i < n; i++)
                args.add(new Object[]{Uuid7.toBytes(Uuid7.next()), "C", BigDecimal.ONE});
            jdbc.batchUpdate("INSERT INTO bulk_uuid (id,code,amount) VALUES (?,?,?)", args);
        }, 1, 3);

        long tMulti = bestMs(() -> { cleanBulk();
            StringBuilder sb = new StringBuilder("INSERT INTO bulk_uuid (id,code,amount) VALUES ");
            List<Object> args = new java.util.ArrayList<>();
            for (int i = 0; i < n; i++) {
                if (i > 0) sb.append(',');
                sb.append("(?,?,?)");
                args.add(Uuid7.toBytes(Uuid7.next())); args.add("D"); args.add(BigDecimal.ONE);
            }
            jdbc.update(sb.toString(), args.toArray());
        }, 1, 3);

        System.out.printf("%n   ① 逐筆 persist（batchSize=1）  %4d ms%n", tPersist);
        System.out.printf("   ② persist + batch 50 + rewrite %4d ms%n", tBatch);
        System.out.printf("   ③ JdbcTemplate.batchUpdate     %4d ms%n", tJdbc);
        System.out.printf("   ④ 自己拼一句 1000 個 VALUES     %4d ms%n", tMulti);
    }
```

**實測**：

```
   ① 逐筆 persist（batchSize=1）   160 ms
   ② persist + batch 50 + rewrite   21 ms
   ③ JdbcTemplate.batchUpdate       12 ms
   ④ 自己拼一句 1000 個 VALUES       12 ms
```

**讀法**：

```
① → ②   7.6 倍   ← 兩行組態換來的
② → ③   1.75 倍  ← 「不經過 JPA」換來的
③ → ④   1.0 倍   ← 自己拼字串【一點都沒有更快】
```

> 📌 **③ 到 ④ 那一格是這張表最有價值的一格。**
> `rewriteBatchedStatements` 開了之後，`batchUpdate` 送出去的**就是**那句多值 `INSERT`——
> **你自己拼一次，只是把驅動已經做好的事再做一遍，而且順便得到 SQL Injection 的風險。**
>
> ⚠️ 04 章 00 章都出現過的那種「自己來比較快」的直覺，在這裡是錯的。
> **判準：先確認驅動有沒有幫你做，再決定要不要自己做。**

**而 ② → ③ 那 1.75 倍是什麼？**

```
JPA 那一側多做的事（03 章講過每一項）：
  ① 為 1000 個實體各建一份快照（3.4.2）
  ② 把 1000 個實體放進一級快取（3.3.2）
  ③ flush 前對 1000 個實體做髒檢查（3.4.7：20000 個實體 1.5 ms）
  ④ 生命週期回呼（3.10）
```

> 📌 **所以「純資料匯入」這件事，是這一站少數 MyBatis / JdbcTemplate
> 真的比 JPA 好的場景之一**（00 章 0.8.1 的六個場景之一）。
> **理由不是「JPA 慢」，是「匯入這件事完全不需要實體」——
> 跟 05 章 5.8.10 那個結論是同一個形狀。**

### 6.3.10 實測：`flush` + `clear` 分段

批次解決了「幾句 SQL」，**沒有解決「記憶體裡有幾個物件」**。

```java
    @Test
    void h_flush_clear_分段() {
        head("6.3.9 flush + clear：持久化情境的大小");
        cleanBulk();
        tx.executeWithoutResult(s -> {
            em.unwrap(Session.class).setJdbcBatchSize(50);
            for (int i = 0; i < 500; i++) em.persist(new Bulk6(Uuid7.next(), "W-" + i, BigDecimal.ONE));
            System.out.println("   不分段：500 筆之後 PC 裡有 " + managed() + " 個實體");
        });
        cleanBulk();
        tx.executeWithoutResult(s -> {
            em.unwrap(Session.class).setJdbcBatchSize(50);
            for (int i = 0; i < 500; i++) {
                em.persist(new Bulk6(Uuid7.next(), "X-" + i, BigDecimal.ONE));
                if (i % 50 == 49) { em.flush(); em.clear(); }      // ★ 跟 batch_size 一致
            }
            System.out.println("   每 50 筆 flush+clear：500 筆之後 PC 裡有 " + managed() + " 個實體");
        });
        System.out.println("   兩者資料庫裡都是 "
                + jdbc.queryForObject("SELECT count(*) FROM bulk_uuid", Integer.class) + " 筆");
    }

    private int managed() {
        return em.unwrap(org.hibernate.engine.spi.SessionImplementor.class)
                 .getPersistenceContext().getNumberOfManagedEntities();
    }
```

**實測**：

```
   不分段：500 筆之後 PC 裡有 500 個實體
   每 50 筆 flush+clear：500 筆之後 PC 裡有 0 個實體
   兩者資料庫裡都是 500 筆
```

> 📌 **這就是 03 章 3.9.5 那張表裡「`flush()` + `clear()` 分段」那一列的用途**：
> **它讓持久化情境的大小有一個【上界】，而那個上界跟資料量無關。**
>
> 沒有它，匯入一百萬筆就是**記憶體裡一百萬個實體 + 一百萬份快照**，
> 而且**每一次 flush 都要對全部的實體做髒檢查**——
> 03 章 3.4.7 量過髒檢查是線性的（20000 個實體 1.5 ms），
> 但「每 50 筆 flush 一次 × 一百萬筆」= **兩萬次髒檢查，而每一次掃的實體愈來愈多**。
> 這就是 03 章 3.9.3 那句「從幾秒變成幾十分鐘」的機制。

⚠️ **`clear()` 有代價，而且不小**：

```
① clear() 之後，你手上所有的實體都變成 detached（03 章 3.5.2）。
   迴圈裡如果還持有前面的實體引用，之後對它們的修改【不會寫回去】。
② 被 clear 掉的還包含【代理與已經撈出來的關聯物件】——
   下一批要用的商品、客戶會被重新撈一次（6.11.4 會量到這個成本）。
③ clear() 不會 rollback。它只是「忘記」——已經 flush 出去的 SQL 還在交易裡。
```

**所以匯入迴圈的標準形狀是**：

```java
int n = 0;
for (Row r : rows) {
    em.persist(toEntity(r));
    if (++n % BATCH == 0) { em.flush(); em.clear(); }   // ★ BATCH == batch_size
}
em.flush();
em.clear();                                              // ★ 最後一批
```

📌 **`BATCH` 要跟 `hibernate.jdbc.batch_size` 一樣**。
設成 `batch_size` 的整數倍也可以；設成不是倍數的值（例如 `batch_size=50`、`BATCH=30`）
會讓每一批都有一個「零頭」，白白多幾次 `executeBatch()`。

### 6.3.11 實測：`UPDATE` 與 `DELETE` 會批次嗎

```java
    @Test
    void j_批次_update_與_delete() {
        head("6.3.10 UPDATE 與 DELETE 也會批次嗎？");
        cleanBulk();
        List<Bulk6> data = rows(300);
        tx.executeWithoutResult(s -> {
            em.unwrap(Session.class).setJdbcBatchSize(50); data.forEach(em::persist);
        });

        Layers up = layers("撈出 300 筆、每筆改一個欄位", () -> tx.executeWithoutResult(s -> {
            em.unwrap(Session.class).setJdbcBatchSize(50);
            em.createQuery("select b from Bulk6 b", Bulk6.class).getResultList()
              .forEach(b -> b.setCode("Z-" + b.getCode()));
        }));
        Layers del = layers("撈出 300 筆、逐筆 remove", () -> tx.executeWithoutResult(s -> {
            em.unwrap(Session.class).setJdbcBatchSize(50);
            em.createQuery("select b from Bulk6 b", Bulk6.class).getResultList().forEach(em::remove);
        }));
        System.out.printf("%n   UPDATE：execute=%d 伺服器=%d 句%n", up.executes, up.serverDml());
        System.out.printf("   DELETE：execute=%d 伺服器=%d 句%n", del.executes, del.serverDml());
        Layers bulk = layers("delete from Bulk6", () -> tx.executeWithoutResult(s ->
                em.createQuery("delete from Bulk6").executeUpdate()));
        System.out.println("   → " + bulk.executes + " 句");
    }
```

**實測（`rewriteBatchedStatements=true` 已開）**：

```
── 300 筆逐筆改一個欄位（rewrite 已開）
   ② JDBC       execute() 7 次，其中 executeBatch() 6 次，共夾 301 句敘述
   ③ MySQL      update=300  select=13  commit=1  列.updated=300  列.read=600
── 300 筆逐筆 remove（rewrite 已開）
   ② JDBC       execute() 7 次，其中 executeBatch() 6 次，共夾 301 句敘述
   ③ MySQL      delete=300  select=13  commit=1  列.deleted=300  列.read=600

   UPDATE：JDBC execute=7，伺服器剖析 300 句
   DELETE：JDBC execute=7，伺服器剖析 300 句
```

> 🔴 **`UPDATE` / `DELETE` 在 JDBC 層有批次（7 次 `execute`），
> 而伺服器端還是 300 句 —— `rewriteBatchedStatements` 對它們無效。**
>
> **原因是 SQL 的形狀**：`INSERT … VALUES (…),(…),(…)` 是合法的合併，
> 而「300 個不同 id、不同新值的 `UPDATE`」**沒有等價的單句寫法**
> （硬要寫就是一串 `CASE WHEN`，驅動不會幫你做這件事）。

**對照 05 章 5.6.4 那句批次 `delete`**：

```
── delete from Bulk6
   ② JDBC       execute() 1 次，其中 executeBatch() 0 次，共夾 1 句敘述
   ③ MySQL      delete=1  commit=1
   → 1 句
```

| 做法 | JDBC `execute` | 伺服器剖析 | 走不走持久化情境 |
|---|---|---|---|
| 撈出來逐筆 `remove` | 7 | **300 句** | ✅ 走（回呼、`@Version`、`orphanRemoval` 都有效） |
| 一句 JPQL `delete from` | 1 | **1 句** | 🔴 不走（05 章 5.6.2、5.6.3 列了它繞過的四件事） |

> 📌 **這張表就是「批次寫入」與「批次操作」的分界**：
> **前者讓「一筆一筆」變便宜，後者讓「一筆一筆」消失。**
> 而後者的代價是**你放棄了整個物件層**——05 章 5.6.6 那五條規則講的就是這件事。

### 6.3.12 實測：`@Version` 與批次 —— 一條已經過期的規則

網路上（包含很多還在維護的文章）流傳這條規則：

> 「實體有 `@Version` 的時候，`UPDATE` **不會**批次，
> 除非你設 `hibernate.jdbc.batch_versioned_data=true`。」

**這條規則在 Hibernate 5 是對的，在 Hibernate 6 已經不成立了。**

```java
package com.example.lab.ch06;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.util.UUID;

/** 有 @Version 的批次：6.3.12 的主角。 */
@Entity @Table(name = "bulk_ver")
public class BulkVer6 {

    @Id private UUID id;
    @Column(nullable = false, length = 32) private String code;
    @Column(nullable = false, precision = 19, scale = 4) private BigDecimal amount;
    @Version private long version;

    protected BulkVer6() {}
    public BulkVer6(UUID id, String code, BigDecimal amount) {
        this.id = id; this.code = code; this.amount = amount;
    }

    public UUID getId() { return id; }
    public String getCode() { return code; }
    public void setCode(String c) { this.code = c; }
    public long getVersion() { return version; }
}
```

**把它明確關掉，看會不會壞**：

```java
@SpringBootTest(properties = {
  "spring.datasource.url=jdbc:mysql://127.0.0.1:33306/ch06?rewriteBatchedStatements=true"
      + "&connectionTimeZone=UTC&forceConnectionTimeZoneToSession=true"
      + "&preserveInstants=true&characterEncoding=UTF-8",
  "spring.jpa.properties.hibernate.generate_statistics=true",
  "spring.jpa.properties.hibernate.jdbc.batch_size=50",
  "spring.jpa.properties.hibernate.jdbc.batch_versioned_data=false"    // ★ 明確關掉
})
class H3Ver extends Base06 {

    @Test
    void a_batch_versioned_data_關掉() {
        head("6.3.11 batch_versioned_data=false：有 @Version 的實體改 300 筆");
        var opts = emf.unwrap(org.hibernate.engine.spi.SessionFactoryImplementor.class)
                      .getSessionFactoryOptions();
        System.out.println("   SessionFactoryOptions.isJdbcBatchVersionedData() = "
                + opts.isJdbcBatchVersionedData());     // ★ 先確認組態真的生效了

        cleanBulk();
        tx.executeWithoutResult(s -> {
            for (int i = 0; i < 300; i++)
                em.persist(new BulkVer6(Uuid7.next(), "V-" + i, BigDecimal.ONE));
        });
        Layers r = layers("300 筆有 @Version 的 UPDATE（batch_versioned_data=false）", () ->
                tx.executeWithoutResult(s ->
                    em.createQuery("select b from BulkVer6 b", BulkVer6.class).getResultList()
                      .forEach(b -> b.setCode("Z-" + b.getCode()))));
        System.out.println("   → JDBC execute=" + r.executes + "，executeBatch=" + r.batches);
        r.sqls.stream().filter(q -> q.startsWith("update")).distinct()
              .forEach(q -> System.out.println("      " + cut(q)));
    }
}
```

**實測**：

```
   SessionFactoryOptions.isJdbcBatchVersionedData() = false
   組態裡的值 = false
── 300 筆有 @Version 的 UPDATE（batch_versioned_data=false）
   ① Hibernate  準備 2 個 statement（update 300 個實體）
   ② JDBC       execute() 7 次，其中 executeBatch() 6 次，共夾 301 句敘述
   → JDBC execute=7，executeBatch=6
      update bulk_ver set amount=?,code=?,version=? where id=? and version=?   [batch ×50]
```

**用預設值跑同一份**：

```
── 300 筆有 @Version 的 UPDATE（預設）
   ② JDBC       execute() 7 次，其中 executeBatch() 6 次，共夾 301 句敘述
      update bulk_ver set amount=?,code=?,version=? where id=? and version=?   [batch ×50]
```

**一模一樣。**

> 📌 **這條規則為什麼會存在，以及為什麼過期了**：
>
> 樂觀鎖的檢查靠「`UPDATE … WHERE version = ?` 影響了幾列」。
> **Hibernate 5 的判斷是：批次執行拿不到可靠的逐句影響列數，所以不敢批次。**
> Hibernate 6 改成**檢查 `executeBatch()` 回傳的 `int[]`**，
> 每一格就是那一句的影響列數 —— **它拿得到，所以它敢批次了。**
>
> **6.6.11 會證明它真的抓得到**（那裡會刻意讓其中一筆的版本過期）。

> ⚠️ **這是這一站第三條「流傳的規則已經過期」**：
> 04 章 4.5.4（`join fetch` 要不要寫 `distinct`）、
> 05 章 5.4.5（`count(o)` 還是 `count(o.id)`）、
> **本節（`batch_versioned_data`）。**
>
> **三條的共同點：它們在 Hibernate 5 都是對的。**
> 判準只有一個：**在你自己的版本上量一次。**
> 而「量一次」的第一步是**先確認組態真的生效了**——
> 上面那句 `isJdbcBatchVersionedData()` 就是為了這件事。
> 少了它，你會分不清「這個設定沒有效果」與「這個設定沒有被讀到」。

### 6.3.13 批次寫入的組態清單

**四個開關，一次講完**：

```yaml
spring:
  datasource:
    # 🔴 第一個、也是效果最大的一個：它不在 jpa 底下，它是【驅動】的參數（6.3.7）
    url: jdbc:mysql://host:3306/db?rewriteBatchedStatements=true
  jpa:
    properties:
      hibernate:
        jdbc:
          batch_size: 50          # 沒有這個，下面兩個完全無效（6.3.3）
        order_inserts: true       # 交錯型別時才有差別，但差 50 倍（6.3.5）
        order_updates: true
```

**而程式碼那一側只有兩條規則**：

```
① 主鍵不能是 IDENTITY（6.3.4）
② 迴圈裡不能有查詢，而且每 batch_size 筆要 flush + clear（6.3.6、6.3.10）
```

**檢查表：「我開了批次，但好像沒有變快」的六個原因**

| 症狀（用 6.2.4 那三把尺看） | 原因 | 修 |
|---|---|---|
| `executeBatch()` = 0 次 | `batch_size` 沒設 / 主鍵是 `IDENTITY` | 6.3.3 / 6.3.4 |
| `executeBatch()` 次數 ≈ 資料筆數 | 型別交錯 | `order_inserts=true`（6.3.5） |
| `executeBatch()` = 0 且 SQL 句數是兩倍 | 迴圈裡有查詢（auto-flush） | 6.3.6 |
| **`executeBatch()` 正常，但伺服器 `Com_insert` = 資料筆數** | **`rewriteBatchedStatements` 沒開** | **6.3.7** |
| SQL 句數是資料筆數的兩倍 | 用 `save()` 而實體沒有 `Persistable` | 6.3.1 |
| 記憶體一路往上，最後 OOM | 沒有 `flush()` + `clear()` | 6.3.10 |

---
## 6.4 `@DynamicUpdate`：收掉 00 章 0.3.1 那個「改一欄、`UPDATE` 九欄」

00 章 0.3.1 那個事故留下一句話：

> 「JPA 的 `UPDATE` 會寫全部的欄位。`@DynamicUpdate` 可以改，**但它有代價**——06 章 6.4 會處理。」

01 章 1.16.2 那個練習問得更直接：

> 「既然明顯更好，**為什麼 Hibernate 不設成預設值**？」

這一節把兩個問題一起回答。

### 6.4.1 實測：改一個欄位，`UPDATE` 裡有幾欄

兩個實體，映射到**同一張 20 欄的表**，只差一個註解：

```java
package com.example.lab.ch06;

import jakarta.persistence.*;

import java.util.UUID;

/** 20 個欄位的寬表：預設行為（每次 UPDATE 全部欄位）。 */
@Entity @Table(name = "wide_row")
public class Wide6 {

    @Id private UUID id;

    @Column(nullable = false, length = 64) private String c01 = "";
    @Column(nullable = false, length = 64) private String c02 = "";
    @Column(nullable = false, length = 64) private String c03 = "";
    @Column(nullable = false, length = 64) private String c04 = "";
    @Column(nullable = false, length = 64) private String c05 = "";
    @Column(nullable = false, length = 64) private String c06 = "";
    @Column(nullable = false, length = 64) private String c07 = "";
    @Column(nullable = false, length = 64) private String c08 = "";
    @Column(nullable = false, length = 64) private String c09 = "";
    @Column(nullable = false, length = 64) private String c10 = "";
    @Column(nullable = false, length = 64) private String c11 = "";
    @Column(nullable = false, length = 64) private String c12 = "";
    @Column(nullable = false, length = 64) private String c13 = "";
    @Column(nullable = false, length = 64) private String c14 = "";
    @Column(nullable = false, length = 64) private String c15 = "";
    @Column(nullable = false, length = 64) private String c16 = "";
    @Column(nullable = false, length = 64) private String c17 = "";
    @Column(nullable = false, length = 64) private String c18 = "";
    @Column(nullable = false, length = 64) private String c19 = "";
    @Column(nullable = false, length = 64) private String c20 = "";

    protected Wide6() {}
    public Wide6(UUID id) { this.id = id; }

    public UUID getId() { return id; }
    public String getC01() { return c01; }
    public String getC02() { return c02; }
    public String getC03() { return c03; }
    public String getC04() { return c04; }
    public String getC05() { return c05; }
    public String getC06() { return c06; }
    public String getC07() { return c07; }
    public String getC08() { return c08; }
    public String getC09() { return c09; }
    public String getC10() { return c10; }
    public String getC11() { return c11; }
    public String getC12() { return c12; }
    public String getC13() { return c13; }
    public String getC14() { return c14; }
    public String getC15() { return c15; }
    public String getC16() { return c16; }
    public String getC17() { return c17; }
    public String getC18() { return c18; }
    public String getC19() { return c19; }
    public String getC20() { return c20; }
    public void setC01(String v) { this.c01 = v; }
    public void setC02(String v) { this.c02 = v; }
    public void setC03(String v) { this.c03 = v; }
    public void setC04(String v) { this.c04 = v; }
    public void setC05(String v) { this.c05 = v; }
    public void setC06(String v) { this.c06 = v; }
    public void setC07(String v) { this.c07 = v; }
    public void setC08(String v) { this.c08 = v; }
    public void setC09(String v) { this.c09 = v; }
    public void setC10(String v) { this.c10 = v; }
    public void setC11(String v) { this.c11 = v; }
    public void setC12(String v) { this.c12 = v; }
    public void setC13(String v) { this.c13 = v; }
    public void setC14(String v) { this.c14 = v; }
    public void setC15(String v) { this.c15 = v; }
    public void setC16(String v) { this.c16 = v; }
    public void setC17(String v) { this.c17 = v; }
    public void setC18(String v) { this.c18 = v; }
    public void setC19(String v) { this.c19 = v; }
    public void setC20(String v) { this.c20 = v; }
}
```

`WideDyn6` **跟上面完全一樣**，只有類別宣告那兩行不同：

```java
package com.example.lab.ch06;

import jakarta.persistence.*;
import org.hibernate.annotations.DynamicUpdate;

import java.util.UUID;

/** 同一張 wide_row 表，只多一個 @DynamicUpdate —— 6.4 要量它的兩面。 */
@Entity @Table(name = "wide_row") @DynamicUpdate
public class WideDyn6 {

    @Id private UUID id;

    @Column(nullable = false, length = 64) private String c01 = "";
    // …… c02 ～ c20 與 Wide6 一字不差，20 個欄位、20 組 getter / setter ……

    protected WideDyn6() {}
    public WideDyn6(UUID id) { this.id = id; }

    public UUID getId() { return id; }
    // …… getC01() ～ getC20()、setC01() ～ setC20() 與 Wide6 一字不差 ……
}
```

**這一節的三個 helper**（`Wide6` 有 20 個欄位，所以要一個「改第 n 欄」的分派）：

```java
    /** 塞 n 列 wide_row，每一欄都填 "v<欄號>"。★ 用 JDBC，不經過 JPA。 */
    private List<UUID> seedWide(int n) {
        jdbc.update("DELETE FROM wide_row");
        List<Object[]> rows = new ArrayList<>();
        List<UUID> ids = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            UUID id = Uuid7.next(); ids.add(id);
            Object[] a = new Object[21];
            a[0] = Uuid7.toBytes(id);
            for (int c = 1; c <= 20; c++) a[c] = "v" + c;
            rows.add(a);
        }
        StringBuilder sql = new StringBuilder("INSERT INTO wide_row (id");
        for (int c = 1; c <= 20; c++) sql.append(String.format(",c%02d", c));
        sql.append(") VALUES (?");
        for (int c = 1; c <= 20; c++) sql.append(",?");
        sql.append(')');
        jdbc.batchUpdate(sql.toString(), rows);
        return ids;
    }

    /** 改第 n 個欄位（1～20）。兩個變體各一份，因為它們是【不同的類別】。 */
    private static void setNth(Wide6 w, int n, String v) {
        switch (n) {
            case 1 -> w.setC01(v); case 2 -> w.setC02(v); case 3 -> w.setC03(v);
            case 4 -> w.setC04(v); case 5 -> w.setC05(v); case 6 -> w.setC06(v);
            case 7 -> w.setC07(v); case 8 -> w.setC08(v); case 9 -> w.setC09(v);
            case 10 -> w.setC10(v); case 11 -> w.setC11(v); case 12 -> w.setC12(v);
            case 13 -> w.setC13(v); case 14 -> w.setC14(v); case 15 -> w.setC15(v);
            case 16 -> w.setC16(v); case 17 -> w.setC17(v); case 18 -> w.setC18(v);
            case 19 -> w.setC19(v); default -> w.setC20(v);
        }
    }

    private static void setNthDyn(WideDyn6 w, int n, String v) {
        switch (n) {
            case 1 -> w.setC01(v); case 2 -> w.setC02(v); case 3 -> w.setC03(v);
            case 4 -> w.setC04(v); case 5 -> w.setC05(v); case 6 -> w.setC06(v);
            case 7 -> w.setC07(v); case 8 -> w.setC08(v); case 9 -> w.setC09(v);
            case 10 -> w.setC10(v); case 11 -> w.setC11(v); case 12 -> w.setC12(v);
            case 13 -> w.setC13(v); case 14 -> w.setC14(v); case 15 -> w.setC15(v);
            case 16 -> w.setC16(v); case 17 -> w.setC17(v); case 18 -> w.setC18(v);
            case 19 -> w.setC19(v); default -> w.setC20(v);
        }
    }
```

```java
    @Test
    void a_改一欄_更新幾欄() {
        head("6.4.1 改一個欄位，UPDATE 裡有幾欄？（20 欄的寬表）");
        List<UUID> ids = seedWide(1);
        UUID id = ids.get(0);

        showSql("Wide6（預設）：只改 c01", () -> tx.executeWithoutResult(s ->
                em.find(Wide6.class, id).setC01("changed")));
        showSql("WideDyn6（@DynamicUpdate）：只改 c01", () -> tx.executeWithoutResult(s ->
                em.find(WideDyn6.class, id).setC01("changed2")));
    }
```

**實測**：

```
── Wide6（預設）：只改 c01 → 2 句 SQL
   select w1_0.id,w1_0.c01,…,w1_0.c20 from wide_row w1_0 where w1_0.id=?
   update wide_row set c01=?,c02=?,c03=?,c04=?,c05=?,c06=?,c07=?,c08=?,c09=?,c10=?,
                       c11=?,c12=?,c13=?,c14=?,c15=?,c16=?,c17=?,c18=?,c19=?,c20=? where id=?
── WideDyn6（@DynamicUpdate）：只改 c01 → 2 句 SQL
   select wd1_0.id,wd1_0.c01,…,wd1_0.c20 from wide_row wd1_0 where wd1_0.id=?
   update wide_row set c01=? where id=?
```

**回到 00 章 0.3.1 那張訂單**：

```java
    @Test
    void b_八欄的訂單() {
        head("6.4.1b 回到 00 章 0.3.1：一張訂單改一個狀態");
        seed(1, 1, 0);
        UUID oid = orderIds.get(0);
        showSql("Ord6.pay()（沒有 @DynamicUpdate）", () -> tx.executeWithoutResult(s ->
                em.find(Ord6.class, oid).pay()));
    }
```

```
── Ord6.pay()（沒有 @DynamicUpdate） → 2 句 SQL
   select o1_0.id,o1_0.currency,o1_0.customer_id,o1_0.discount_amount,o1_0.memo,
          o1_0.order_no,o1_0.paid_at,o1_0.placed_at,o1_0.status,o1_0.total_amount,o1_0.version …
   update orders set currency=?,customer_id=?,discount_amount=?,memo=?,order_no=?,
          paid_at=?,placed_at=?,status=?,total_amount=?,version=? where id=? and version=?
```

**`pay()` 只改了 `status` 與 `paid_at` 兩欄，`UPDATE` 寫了十欄。**
（順帶：那個 `where id=? and version=?` 就是 6.6 的主題。）

> 📌 **為什麼預設是「全部欄位」**（03 章 3.4.9 已經給了一半答案）：
> **因為那樣 SQL 的形狀是固定的**，一個實體類別對應**一句** `UPDATE`。
> 固定的形狀可以：被 Hibernate 快取、被 JDBC 驅動重用、被資料庫的敘述快取命中、
> **而且可以批次**（6.3）。

### 6.4.2 實測：代價一 —— SQL 形狀爆炸

```java
    @Test
    void c_SQL_形狀爆炸() {
        head("6.4.2 🔴 @DynamicUpdate 的代價：SQL 形狀的數量");
        List<UUID> ids = seedWide(30);
        Set<String> plain = new LinkedHashSet<>(), dyn = new LinkedHashSet<>();

        List<String> a = spy(() -> tx.executeWithoutResult(s -> {
            for (int i = 0; i < 30; i++) {
                Wide6 w = em.find(Wide6.class, ids.get(i));
                setNth(w, i % 20 + 1, "x" + i);                 // 每次改不同的欄位
            }
        }));
        a.stream().filter(q -> q.startsWith("update")).forEach(q -> plain.add(strip(q)));

        List<String> b = spy(() -> tx.executeWithoutResult(s -> {
            for (int i = 0; i < 30; i++) {
                WideDyn6 w = em.find(WideDyn6.class, ids.get(i));
                setNthDyn(w, i % 20 + 1, "y" + i);
            }
        }));
        b.stream().filter(q -> q.startsWith("update")).forEach(q -> dyn.add(strip(q)));

        System.out.println("   Wide6（預設）      SQL 形狀：" + plain.size() + " 種");
        System.out.println("   WideDyn6（動態）    SQL 形狀：" + dyn.size() + " 種");
        dyn.stream().limit(3).forEach(q -> System.out.println("      " + cut(q)));
    }

    private static String strip(String q) {
        int i = q.indexOf("[batch");
        return i < 0 ? q : q.substring(0, i).trim();
    }
```

**實測**：

```
   Wide6（預設）      SQL 形狀：1 種
   WideDyn6（動態）    SQL 形狀：20 種
   → 動態版的前三種：
      update wide_row set c07=? where id=?
      update wide_row set c13=? where id=?
      update wide_row set c10=? where id=?
```

**20 個欄位 → 最多 2²⁰ − 1 = 1048575 種可能的 `UPDATE` 形狀。**
這裡因為每次只改一欄，所以只看到 20 種；真實系統裡改兩三欄的組合會更多。

> 📌 **05 章 5.5.2 已經把「形狀變多」的代價量過了**：
> 拼字串 vs 參數 → Hibernate 的查詢計畫快取 **0 命中 / 400 沒中**，每句多 28 µs。
> **`@DynamicUpdate` 造成的是同一件事，只是換一個入口。**
>
> 而 05 章 5.5.3 那個 `in_clause_parameter_padding`（20 種形狀 → 6 種）
> 是**同一個問題的另一個解**——注意那一節是**費力把形狀變少**，
> 而這一節是**主動把形狀變多**。

### 6.4.3 🔴🔴 實測：代價二 —— 它跟批次寫入互斥

```java
    @Test
    void d_DynamicUpdate_把批次打碎() {
        head("6.4.3 🔴🔴 @DynamicUpdate 與批次寫入【互斥】");
        List<UUID> ids = seedWide(200);

        Layers plain = layers("Wide6：200 筆各改一個【相同】欄位", () -> tx.executeWithoutResult(s -> {
            for (UUID id : ids) em.find(Wide6.class, id).setC01("same");
        }));
        Layers dynSame = layers("WideDyn6：200 筆各改一個【相同】欄位", () -> tx.executeWithoutResult(s -> {
            for (UUID id : ids) em.find(WideDyn6.class, id).setC01("same2");
        }));
        Layers dynDiff = layers("WideDyn6：200 筆各改一個【不同】欄位", () -> tx.executeWithoutResult(s -> {
            int i = 0;
            for (UUID id : ids) setNthDyn(em.find(WideDyn6.class, id), (i++ % 20) + 1, "z");
        }));
        System.out.printf("%n   execute()：預設=%d  動態(同欄)=%d  動態(不同欄)=%d%n",
                plain.executes, dynSame.executes, dynDiff.executes);
    }
```

**實測**（`batch_size=50`、`order_updates=true`、`rewrite=true` 全開）：

```
── Wide6：200 筆各改一個【相同】欄位
   ① Hibernate  準備 201 個 statement（update 200 個實體）
   ② JDBC       execute() 204 次，其中 executeBatch() 4 次，共夾 400 句敘述
── WideDyn6：200 筆各改一個【相同】欄位
   ① Hibernate  準備 400 個 statement（update 200 個實體）
   ② JDBC       execute() 400 次，其中 executeBatch() 0 次，共夾 400 句敘述   ← 🔴
── WideDyn6：200 筆各改一個【不同】欄位
   ② JDBC       execute() 400 次，其中 executeBatch() 0 次，共夾 400 句敘述

   execute()：預設=204  動態(同欄)=400  動態(不同欄)=400
```

（`204` = 200 句 `SELECT` + 4 次 `executeBatch()`；`400` = 200 句 `SELECT` + 200 句 `UPDATE`。）

> 🔴 **注意中間那一列**：200 筆**全部改同一個欄位**，
> 所以 SQL 形狀只有一種 —— **它還是不批次。**
>
> **因為批次是在 flush【之前】就要決定的事**：
> Hibernate 必須先知道「接下來 50 句長什麼樣」才能把它們攢進同一個 `PreparedStatement`。
> **而 `@DynamicUpdate` 的定義就是「SQL 要等到那一刻才組出來」。**
> 兩者在時間上互斥，跟形狀實際上是不是一樣無關。

### 6.4.4 實測：量一次時間

```java
    @Test
    void e_量一次時間() {
        head("6.4.4 20 欄的寬表，改一欄，兩種寫法各花多久（1000 次）");
        List<UUID> ids = seedWide(1000);
        long tPlain = bestMs(() -> tx.executeWithoutResult(s -> {
            em.unwrap(Session.class).setJdbcBatchSize(50);
            for (UUID id : ids) em.find(Wide6.class, id).setC01("p" + System.nanoTime() % 97);
        }), 1, 3);
        long tDyn = bestMs(() -> tx.executeWithoutResult(s -> {
            em.unwrap(Session.class).setJdbcBatchSize(50);
            for (UUID id : ids) em.find(WideDyn6.class, id).setC01("d" + System.nanoTime() % 97);
        }), 1, 3);
        System.out.printf("   Wide6（預設，UPDATE 20 欄、可批次）  %4d ms%n", tPlain);
        System.out.printf("   WideDyn6（動態，UPDATE 1 欄、不批次） %4d ms%n", tDyn);
    }
```

**實測**：

```
   Wide6（預設，UPDATE 20 欄、可批次）   316 ms
   WideDyn6（動態，UPDATE 1 欄、不批次）  384 ms
```

> 🔴 **`@DynamicUpdate` 比較【慢】。**
> **20 欄的表、只改 1 欄——這是它最有利的情境，而它還是輸了 20%。**

**這就是 01 章 1.16.2 那個練習的答案**：

> **問：既然「只更新改過的欄位」明顯更好，為什麼 Hibernate 不設成預設值？**
>
> **答：因為它不是「明顯更好」。它是一個交易：**
>
> ```
> 換到的：  UPDATE 語句短一點（少傳幾個參數）
> 付出的：  ① SQL 形狀從 1 種變成 2ⁿ 種 → 各層快取全部失效
>          ② 【完全不能批次寫入】
>          ③ 每一次 flush 都要現組一次 SQL 字串
> ```
>
> **而「換到的」那一項，在絕大多數表上根本不值錢**——
> InnoDB 寫的是**整個 row**（`UPDATE` 一欄和 `UPDATE` 二十欄，
> 寫進 redo log 與 buffer pool 的頁面是同一個），
> 網路上多傳的也只是十幾個參數。

### 6.4.5 那什麼時候該用它

**三個情境，`@DynamicUpdate` 是對的**：

| 情境 | 為什麼 |
|---|---|
| 表上有 **`@Lob` / `TEXT` / `BLOB` 欄位** | 每次 `UPDATE` 都把一份 MB 級的內容傳過去、寫一次 —— 這個代價是真的 |
| 表上有 **`UPDATE` 觸發器**，或有稽核工具在看「哪些欄位變了」 | 全欄位 `UPDATE` 會讓每一次修改都看起來像「改了全部」 |
| 有**其他系統在寫同一張表**，而你只想動自己那幾欄 | 全欄位 `UPDATE` 會用你手上那份（可能過期的）值覆蓋別人的欄位 —— **00 章 0.3.5 事故五那個 `paid_at` 變回 null，就是這個機制** |

⚠️ **第三個情境要特別小心**：`@DynamicUpdate` **不是**那個問題的解，
它只是**讓症狀變小**。真正的解是 6.6.10（讓所有寫入路徑都維護 `version`）
或 00 章 0.9 規則一（一張表只讓一個框架寫）。

📌 **而如果你的動機是「這張表有 60 個欄位，全部寫太浪費」——
先問一次為什麼一張表會有 60 個欄位。**
02 章 2.12 講過聚合邊界，01 章 1.4 講過值物件；
**很多時候那 60 欄應該是兩三張表，或者一個 `@Embeddable`。**

**決策**：

```
表裡有 @Lob / TEXT / BLOB ────────── 是 ──→ ✅ 用 @DynamicUpdate
        │
        否
        ↓
有觸發器 / 稽核在看欄位差異 ────────── 是 ──→ ✅ 用
        │
        否
        ↓
這張表【每秒要寫幾百次】？ ─────────── 是 ──→ 🔴 不要用（它不能批次）
        │
        否
        ↓
                                        不用。預設值就是對的。
```

---

## 6.5 二級快取

### 6.5.1 它跟一級快取的關係

03 章 3.2 花了整節講一級快取，並且留下一句話：

> 「它跟你的交易一樣短命 —— **這是它跟 06 章要講的二級快取最大的差別**。」

```
                         一級快取                    二級快取
────────────────────────────────────────────────────────────────────
住在哪裡              EntityManager（Session）     SessionFactory
活多久                一個交易                     整個應用程式（或到過期）
誰共用                只有這個交易                 【所有交易、所有執行緒】
要不要設定            不用，關不掉                 要，而且預設沒有實作
key                   實體型別 + id                實體型別 + id（一樣）
存什麼                【物件本身】                 【欄位值的陣列】（6.5.4）
```

**先量一次差別**：

```java
    @Test
    void a_一級跟二級的差別() {
        head("6.5.1 一級快取 vs 二級快取：兩個【不同的交易】各查一次");
        seed(0, 3, 0);
        evictAll();
        CacheSpy c = cache(); c.reset();

        UUID pid = productIds.get(0);
        List<String> a = spy(() -> tx.executeWithoutResult(s -> em.find(Prod6.class, pid)));
        List<String> b = spy(() -> tx.executeWithoutResult(s -> em.find(Prod6.class, pid)));
        System.out.printf("   Prod6（沒有 @Cache）：第一個交易 %d 句、第二個交易 %d 句%n", a.size(), b.size());

        c.reset();
        List<String> d = spy(() -> tx.executeWithoutResult(s -> em.find(ProdC6.class, pid)));
        System.out.printf("   ProdC6（有 @Cache）：第一個交易 %d 句 │ %s%n", d.size(), c.summary());
        c.reset();
        List<String> e = spy(() -> tx.executeWithoutResult(s -> em.find(ProdC6.class, pid)));
        System.out.printf("   ProdC6（有 @Cache）：第二個交易 %d 句 │ %s%n", e.size(), c.summary());
    }

    private void evictAll() {
        emf.getCache().evictAll();
        emf.unwrap(org.hibernate.SessionFactory.class).getCache().evictQueryRegions();
    }
```

**實測**：

```
   Prod6（沒有 @Cache）：第一個交易 1 句、第二個交易 1 句
   ProdC6（有 @Cache）：第一個交易 1 句 │ SQL=1 實體=1 │ 二級快取 hit=0 miss=1 put=1
   ProdC6（有 @Cache）：第二個交易 0 句 │ SQL=0 實體=0 │ 二級快取 hit=1 miss=0 put=0
```

**第二個交易 0 句 SQL。** 這就是二級快取的全部價值，也是它全部風險的來源。

**量尺**（05 章 5.13.3 的 `ReadOnlySpy` 只看 `entityLoadCount`，這裡補上快取那一側）：

```java
package com.example.lab.ch06;

import jakarta.persistence.EntityManagerFactory;
import org.hibernate.SessionFactory;
import org.hibernate.stat.CacheRegionStatistics;
import org.hibernate.stat.Statistics;

/**
 * 05 章 5.13.3 的 ReadOnlySpy 只看 entityLoadCount ——
 * 「一個不建實體的查詢，也可能是每次都打資料庫的查詢」。
 * 這一把尺補上二級快取那一側：命中 / 沒中 / 放進去。
 *
 * ⚠️ Hibernate 6 把「實體快取」與「集合快取」的計數器【合併】成
 * getSecondLevelCache*Count() 一組，要分開看只能問 region（byRegion）。
 */
public class CacheSpy {

    private final Statistics s;

    public CacheSpy(EntityManagerFactory emf) {
        this.s = emf.unwrap(SessionFactory.class).getStatistics();
    }

    public void reset() { s.clear(); }

    public long hit()  { return s.getSecondLevelCacheHitCount(); }
    public long miss() { return s.getSecondLevelCacheMissCount(); }
    public long put()  { return s.getSecondLevelCachePutCount(); }

    public long qHit()  { return s.getQueryCacheHitCount(); }
    public long qMiss() { return s.getQueryCacheMissCount(); }
    public long qPut()  { return s.getQueryCachePutCount(); }

    /** 查詢快取靠這個「哪張表什麼時候被改過」的時間戳表決定要不要信自己（6.5.9）。 */
    public long tsHit()  { return s.getUpdateTimestampsCacheHitCount(); }
    public long tsMiss() { return s.getUpdateTimestampsCacheMissCount(); }
    public long tsPut()  { return s.getUpdateTimestampsCachePutCount(); }

    public long stmt() { return s.getPrepareStatementCount(); }
    public long entityLoad() { return s.getEntityLoadCount(); }

    /** 某一個 region 的 hit/miss/put/筆數。 */
    public long[] byRegion(String region) {
        CacheRegionStatistics r = s.getCacheRegionStatistics(region);
        if (r == null) return new long[]{-1, -1, -1, -1};
        return new long[]{r.getHitCount(), r.getMissCount(), r.getPutCount(),
                          r.getElementCountInMemory()};
    }

    public String summary() {
        return String.format("SQL=%d 實體=%d │ 二級快取 hit=%d miss=%d put=%d",
                stmt(), entityLoad(), hit(), miss(), put());
    }

    public String full() {
        return String.format(
                "SQL=%d │ 二級快取 %d/%d/%d │ 查詢快取 %d/%d/%d │ 時間戳 %d/%d/%d  (hit/miss/put)",
                stmt(), hit(), miss(), put(), qHit(), qMiss(), qPut(), tsHit(), tsMiss(), tsPut());
    }

    public String[] regions() { return s.getSecondLevelCacheRegionNames(); }

    public void dumpRegions() {
        for (String r : s.getSecondLevelCacheRegionNames()) {
            CacheRegionStatistics st = s.getCacheRegionStatistics(r);
            long n = st.getElementCountInMemory();
            System.out.printf("   region %-34s 筆數=%s  hit=%d miss=%d put=%d%n",
                    r, n == Long.MIN_VALUE ? "n/a" : String.valueOf(n),
                    st.getHitCount(), st.getMissCount(), st.getPutCount());
        }
    }
}
```

⚠️ **`getElementCountInMemory()` 在 JCache 上會回 `Long.MIN_VALUE`**（表示「不支援」），
不是 0，也不會拋例外。上面那個 `n/a` 就是為了它。

### 6.5.2 🔴 「二級快取預設是關的」——這句話只對一半

每一份教學都說「Hibernate 的二級快取預設是關閉的」。量一次。

```java
/** 6.5.2：什麼組態都沒設的預設狀態（用 Base06 那份組態，沒有任何 cache.* 屬性）。 */
class H6Off extends Base06 {

    @Test
    void a_什麼都沒設的時候() {
        head("6.5.2 什麼都沒設：二級快取是開的還是關的？");
        System.out.println("   use_second_level_cache = "
                + emf.getProperties().get("hibernate.cache.use_second_level_cache"));
        var opts = emf.unwrap(org.hibernate.engine.spi.SessionFactoryImplementor.class)
                      .getSessionFactoryOptions();
        System.out.println("   isSecondLevelCacheEnabled() = " + opts.isSecondLevelCacheEnabled());
        System.out.println("   isQueryCacheEnabled()       = " + opts.isQueryCacheEnabled());
        System.out.println("   RegionFactory 實作 = "
                + emf.unwrap(org.hibernate.engine.spi.SessionFactoryImplementor.class)
                     .getCache().getRegionFactory().getClass().getName());
        System.out.println("   region 清單 = " + java.util.Arrays.toString(cache().regions()));

        seed(0, 1, 0);
        UUID pid = productIds.get(0);
        CacheSpy c = cache(); c.reset();
        int a = spy(() -> tx.executeWithoutResult(s -> em.find(ProdC6.class, pid))).size();
        int b = spy(() -> tx.executeWithoutResult(s -> em.find(ProdC6.class, pid))).size();
        System.out.printf("   ProdC6（類別上有 @Cache）：兩個交易各 %d / %d 句 SQL │ %s%n",
                a, b, c.summary());
    }
}
```

**實測**：

```
   use_second_level_cache = true
   isSecondLevelCacheEnabled() = true
   isQueryCacheEnabled()       = false
   RegionFactory 實作 = org.hibernate.cache.jcache.internal.JCacheRegionFactory
   region 清單 = [ref, custOrders, prod, cust]
   ProdC6（類別上有 @Cache）：兩個交易各 1 / 0 句 SQL │ SQL=1 實體=1 │ 二級快取 hit=1 miss=1 put=1
```

> 🔴 **這個 context【沒有任何一行 cache 組態】，而二級快取是開的、而且真的在快取。**
>
> **為什麼**：Hibernate 啟動時會用 `ServiceLoader` 找 `RegionFactory` 的實作。
> 找不到 → 用 `NoCachingRegionFactory` → 二級快取關閉。
> **找到了 → 它就把 `use_second_level_cache` 設成 `true`。**
>
> 而「找到了」的條件只有一個：**classpath 上有 `hibernate-jcache` 與一個 JCache 提供者**。
> 也就是說 —— **在 `pom.xml` 加兩個 dependency，二級快取就開了。**

⚠️ **這件事的實務意義**：

```
「我沒有開二級快取」這句話，在你的 pom.xml 有 hibernate-jcache / hibernate-ehcache
（或某個 starter 間接帶進來）的時候，是【錯的】。

而它會不會真的快取任何東西，取決於【有沒有實體標了 @Cache】。
所以症狀是：平常什麼事都沒有，直到有人在某個實體上加了一行 @Cache ——
然後那個實體就開始回傳過期的資料，而且沒有人記得專案有二級快取。
```

📌 **注意 `isQueryCacheEnabled()` 是 `false`。**
**查詢快取是真的預設關閉**，而且**它不會被 classpath 自動開啟**——
它一定要明寫 `hibernate.cache.use_query_cache=true`。這個區別很重要（6.5.8）。

**要明確地關掉，就明確地寫**：

```yaml
spring:
  jpa:
    properties:
      hibernate:
        cache:
          use_second_level_cache: false     # ★ 不用就明講，不要靠「沒設」
          use_query_cache: false
```

### 6.5.3 怎麼開

**三件事**：依賴、組態、標註。

```xml
<!-- ① 依賴：Hibernate 只定義介面，實作要自己選 -->
<dependency>
  <groupId>org.hibernate.orm</groupId>
  <artifactId>hibernate-jcache</artifactId>
</dependency>
<dependency>
  <groupId>org.ehcache</groupId>
  <artifactId>ehcache</artifactId>
  <version>3.10.8</version>
  <classifier>jakarta</classifier>          <!-- ★ 一定要 jakarta 版（00 章 0.4.4）-->
</dependency>
<dependency>
  <groupId>javax.cache</groupId>
  <artifactId>cache-api</artifactId>
  <version>1.1.1</version>
</dependency>
```

⚠️ **`<classifier>jakarta</classifier>` 不能漏**。
00 章 0.4.4 那個 `javax` → `jakarta` 的斷層在這裡又出現一次：
Ehcache 3.10 同時出兩份 jar，拿錯的那份在啟動時才會炸。

```yaml
# ② 組態
spring:
  jpa:
    properties:
      hibernate:
        cache:
          use_second_level_cache: true
          use_query_cache: true                # ★ 查詢快取要另外開（6.5.8）
          region:
            factory_class: jcache
        javax:
          cache:
            provider: org.ehcache.jsr107.EhcacheCachingProvider
            uri: ehcache.xml
```

```xml
<!-- ③ src/main/resources/ehcache.xml：每一個 region 的大小與存活時間 -->
<config xmlns="http://www.ehcache.org/v3"
        xmlns:jsr107="http://www.ehcache.org/v3/jsr107">

  <service>
    <jsr107:defaults enable-management="false" enable-statistics="true"/>
  </service>

  <!-- 參數表：不會變、筆數少、永不過期 -->
  <cache alias="ref">
    <expiry><none/></expiry>
    <heap unit="entries">1000</heap>
  </cache>

  <!-- 商品：會變，設一個存活時間當「最壞情況下的資料新鮮度上限」 -->
  <cache alias="prod">
    <expiry><ttl unit="minutes">10</ttl></expiry>
    <heap unit="entries">5000</heap>
  </cache>

  <cache alias="cust">
    <expiry><ttl unit="minutes">10</ttl></expiry>
    <heap unit="entries">5000</heap>
  </cache>

  <cache alias="custOrders">
    <expiry><ttl unit="minutes">10</ttl></expiry>
    <heap unit="entries">3</heap>
  </cache>

  <!-- 查詢快取的兩個內建 region -->
  <cache alias="default-query-results-region">
    <expiry><ttl unit="minutes">5</ttl></expiry>
    <heap unit="entries">2000</heap>
  </cache>
  <cache alias="default-update-timestamps-region">
    <expiry><none/></expiry>
    <heap unit="entries">2000</heap>
  </cache>
</config>
```

⚠️ **`ehcache.xml` 裡沒有定義的 region，Hibernate 會用提供者的預設值幫你建一個**，
並印一行警告：

```
HHH90001006: Missing cache[prod] was created on-the-fly. The created cache will use
a provider-specific default configuration: make sure you defined one.
```

**「provider-specific default configuration」在 Ehcache 上是「不限大小、不過期」——
也就是一個記憶體洩漏。** 這行警告一定要處理掉，不要用
`hibernate.javax.cache.missing_cache_strategy=create` 把它藏起來。

**④ 在實體上標註**：

```java
package com.example.lab.ch06;

import jakarta.persistence.*;
import org.hibernate.annotations.Cache;
import org.hibernate.annotations.CacheConcurrencyStrategy;

import java.math.BigDecimal;
import java.util.UUID;

/**
 * 同一張 product 表的另一個映射：這一份【有二級快取】，而且是可以改的（READ_WRITE）。
 * 對照組是沒有快取的 Prod6。
 */
@Entity @Table(name = "product")
@Cache(usage = CacheConcurrencyStrategy.READ_WRITE, region = "prod")
public class ProdC6 {

    @Id private UUID id;
    @Column(nullable = false, length = 32) private String sku;
    @Column(nullable = false, length = 200) private String name;
    @Column(nullable = false, length = 32) private String category;
    @Column(name = "unit_price", nullable = false, precision = 19, scale = 4) private BigDecimal unitPrice;
    @Version private long version;

    protected ProdC6() {}

    public UUID getId() { return id; }
    public String getSku() { return sku; }
    public String getName() { return name; }
    public void setName(String n) { this.name = n; }
    public String getCategory() { return category; }
    public BigDecimal getUnitPrice() { return unitPrice; }
    public void setUnitPrice(BigDecimal p) { this.unitPrice = p; }
    public long getVersion() { return version; }
}
```

```java
package com.example.lab.ch06;

import jakarta.persistence.*;
import org.hibernate.annotations.Cache;
import org.hibernate.annotations.CacheConcurrencyStrategy;
import org.hibernate.annotations.Immutable;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

/**
 * 參數表：幾乎不會變、每支 API 都要讀。
 * 二級快取的教科書用例，而且可以用最便宜的 READ_ONLY 策略。
 */
@Entity @Table(name = "country")
@Immutable
@Cache(usage = CacheConcurrencyStrategy.READ_ONLY, region = "ref")
public class Country6 {

    @Id @Column(length = 2) @JdbcTypeCode(SqlTypes.CHAR) private String code;
    @Column(nullable = false, length = 64) private String name;
    @Column(nullable = false, length = 3) @JdbcTypeCode(SqlTypes.CHAR) private String currency;

    protected Country6() {}

    public String getCode() { return code; }
    public String getName() { return name; }
    public String getCurrency() { return currency; }
}
```

📌 **`@Cache` 是 Hibernate 的註解，不是 JPA 的。**
JPA 規格只有 `@Cacheable`（一個布林值）與 `shared-cache-mode`，
**它沒有辦法表達「用哪一種並行策略」**——而那正是 6.5.6 要選的東西。
`@Cacheable` 因此在實務上幾乎不會單獨用。

### 6.5.4 實測：快取裡存的不是物件

```java
    @Test
    void b_快取裡存的是什麼() {
        head("6.5.4 二級快取裡存的不是物件");
        seed(2, 1, 0);
        evictAll();
        UUID pid = productIds.get(0);
        tx.executeWithoutResult(s -> em.find(ProdC6.class, pid));   // 讓它進快取

        javax.cache.Cache<Object, Object> jcache = jcache("prod");
        jcache.forEach(entry -> {
            System.out.println("   key   = " + entry.getKey());
            Object v = entry.getValue();
            System.out.println("   value = " + v.getClass().getName());
            dumpDeep("           ", v, 0);
        });
    }

    /** 直接拿到底層那個 JCache，看它到底存了什麼。 */
    private javax.cache.Cache<Object, Object> jcache(String region) {
        var rf = (org.hibernate.cache.jcache.internal.JCacheRegionFactory)
                emf.unwrap(org.hibernate.engine.spi.SessionFactoryImplementor.class)
                   .getCache().getRegionFactory();
        return rf.getCacheManager().getCache(region);
    }

    /** 把快取值裡的欄位攤開來看（只走兩層，夠看出「有沒有存欄位值」）。 */
    private void dumpDeep(String pad, Object o, int depth) {
        if (o == null || depth > 2) return;
        for (var f : o.getClass().getDeclaredFields()) {
            if (java.lang.reflect.Modifier.isStatic(f.getModifiers())) continue;
            try {
                f.setAccessible(true);
                Object v = f.get(o);
                String show = (v instanceof Object[] arr)
                        ? java.util.Arrays.deepToString(arr) : String.valueOf(v);
                System.out.println(pad + f.getName() + " = " + cut(show));
                if (v != null && v.getClass().getName().startsWith("org.hibernate"))
                    dumpDeep(pad + "  ", v, depth + 1);
                if (v instanceof java.util.List<?> l && !l.isEmpty()) {
                    Object first = l.get(0);
                    System.out.println(pad + "  [0] " + first.getClass().getName() + " → "
                            + cut(first instanceof Object[] a2
                                    ? java.util.Arrays.deepToString(a2) : String.valueOf(first)));
                }
            } catch (Exception ignore) {}
        }
    }
```

**實測**：

```
   key   = com.example.lab.ch06.ProdC6#01a07f27-08e0-779a-99b7-4c9fd6250e2c
   value = org.hibernate.cache.spi.support.AbstractReadWriteAccess$Item
           value = CacheEntry(com.example.lab.ch06.ProdC6)
             disassembledState = [3C, 商品0, SKU-0, 100.0000, 0]
             version = 0
             subclass = com.example.lab.ch06.ProdC6
           version = 0
           timestamp = 7327087246413825
```

**三件事**：

```
① key 是「型別 + id」，跟一級快取一樣。
② value 裡沒有 ProdC6 這個【物件】，只有一個【欄位值的陣列】
   ——Hibernate 管它叫「disassembled state」（解構後的狀態）。
   注意裡面【沒有 id】：id 在 key 裡，不需要存兩次。
③ 外面包了一層 Item，帶著 version 與 timestamp ——
   那是 READ_WRITE 策略用來做「軟鎖」的（6.5.6）。
```

> 📌 **「存值不存物件」有三個直接的後果**：
>
> **① 快取命中之後，Hibernate 還是要【組一個新的實體出來】**
> （把陣列填回欄位、放進一級快取、建快照）。
> 快取省掉的是 SQL 與網路，**不是**「建物件」那一段（05 章 5.8 講的那個成本）。
>
> **② 關聯不會被存進去，存的是外鍵的 id。**
> 所以「快取命中了、然後它去撈關聯」是完全正常的 —— 6.5.7 會看到。
>
> **③ 快取的內容可以跨 JVM 傳輸**（因為它就是一堆值）。
> 這是分散式快取（Redis / Hazelcast / Infinispan）能當二級快取用的原因。

### 6.5.5 🔴 實測：JPQL 查詢不會用實體快取

**這是二級快取最常被誤解的一點。**

```java
    @Test
    void c_查詢不會用實體快取() {
        head("6.5.5 🔴 JPQL 查詢【不會】用二級快取");
        seed(0, 1, 0);
        evictAll();
        CacheSpy c = cache();

        tx.executeWithoutResult(s ->
                em.createQuery("select p from ProdC6 p", ProdC6.class).getResultList());
        c.reset();
        List<String> sqls = spy(() -> tx.executeWithoutResult(s ->
                em.createQuery("select p from ProdC6 p", ProdC6.class).getResultList()));
        System.out.printf("   6 個商品全部在快取裡，再查一次 select p from ProdC6 p → %d 句 SQL%n",
                sqls.size());
        System.out.println("   " + c.full());

        c.reset();
        List<String> byId = spy(() -> tx.executeWithoutResult(s -> {
            for (UUID pid : productIds) em.find(ProdC6.class, pid);
        }));
        System.out.printf("   換成 6 次 find(id) → %d 句 SQL │ %s%n", byId.size(), c.summary());
    }
```

**實測**：

```
   6 個商品全部在快取裡，再查一次 select p from ProdC6 p → 1 句 SQL
   SQL=1 │ 二級快取 0/0/0 │ 查詢快取 0/0/0 │ 時間戳 0/0/0  (hit/miss/put)
   換成 6 次 find(id) → 0 句 SQL │ SQL=0 實體=0 │ 二級快取 hit=6 miss=0 put=0
```

> 🔴 **同樣六個商品、同樣全部在快取裡：**
> **`select p from ProdC6 p` 打了 1 句 SQL、二級快取 0 命中；**
> **6 次 `find(id)` 打了 0 句 SQL、6 次命中。**

**為什麼**：

```
二級快取的 key 是【型別 + id】。
而 select p from ProdC6 p 這句話，在執行之前【不知道有哪些 id】。
   ↓
所以它一定要問資料庫「有哪些 id」——這一句 SQL 省不掉。
```

⚠️ **不過查詢跑完之後，Hibernate 會把撈回來的實體【放進】二級快取**
（上面第一次跑的時候 put 就發生了）。所以：

```
實體快取加速的是【按 id 取】：find()、getReferenceById()、以及【關聯的載入】。
它完全不加速【按條件查】。
```

> 📌 **這一條解釋了一個常見的失望**：
> 有人在列表頁的實體上加了 `@Cache`，量了一次，發現一句 SQL 都沒少。
> **因為列表頁是「按條件查」。**
>
> 而 **04 章那個 N+1**（迴圈裡 `order.getCustomer().getName()`）
> **是按 id 取** —— 那正是二級快取真的有用的地方。
> **`@Cache` 是 04 章那五種 N+1 解法之外的第六種**，而且它是唯一一種
> 「**跨交易也有效**」的。

### 6.5.6 四種並行策略

`@Cache(usage = ...)` 有四個值。**選錯的後果是資料錯，不是變慢。**

| 策略 | 什麼時候用 | 機制 | 代價 |
|---|---|---|---|
| **`READ_ONLY`** | 資料**永遠不會改**（參數表、國別、幣別、稅率歷史） | 沒有任何協調機制，就是一個 map | 🔴 **改它會拋 `UnsupportedOperationException`** |
| **`NONSTRICT_READ_WRITE`** | 極少改，而且**短時間讀到舊值可以接受** | 交易提交**之後**把那一筆從快取移除 | 🔴 提交與移除之間有一個窗口，其他交易會讀到舊值 |
| **`READ_WRITE`** | 會改，而且**不能讀到舊值** | 「軟鎖」：改的時候先把快取項標成鎖定，提交後才放新值進去 | 每次寫要多兩次快取操作 |
| **`TRANSACTIONAL`** | 需要快取跟資料庫在**同一個 XA 交易**裡 | 交給 JTA | 要 JTA 環境，而且大多數提供者的支援很弱 |

**實務上只有兩個選擇**：

```
資料不會改 ────→ READ_ONLY       （而且加上 @Immutable，讓「改它」在編譯期就看起來很怪）
資料會改  ────→ READ_WRITE      （NONSTRICT 省的那一點成本，不值得它帶來的不確定性）
```

⚠️ **`READ_WRITE` 也不是「絕對正確」**：
它保證的是「**同一個 SessionFactory 內的寫入，不會讓別人讀到中間狀態**」。
它**不保證**「別的行程／別的框架改了資料庫，快取會知道」——那是 6.5.10。

📌 **`region` 屬性要不要寫**：
不寫的話 region 名稱就是實體的 FQCN（`com.example.lab.ch06.ProdC6`），
`ehcache.xml` 裡也要用那個全名。
**寫一個短名字的好處是「一組實體可以共用一份大小與過期設定」**——
上面 `Country6` 用 `region = "ref"`，其他參數表也可以掛同一個 region。

### 6.5.7 實測：集合的快取要單獨開，而且可能讓事情變糟

**實體上的 `@Cache` 不涵蓋它的集合。** 集合要自己標。

```java
package com.example.lab.ch06;

import jakarta.persistence.*;
import org.hibernate.annotations.Cache;
import org.hibernate.annotations.CacheConcurrencyStrategy;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * 同一張 customer 表的另一個映射：實體本身有快取，
 * 而 orders 這個【集合】也單獨掛了一個 @Cache —— 6.5.7 要量它到底快取了什麼。
 */
@Entity @Table(name = "customer")
@Cache(usage = CacheConcurrencyStrategy.READ_WRITE, region = "cust")
public class CustC6 {

    @Id private UUID id;
    @Column(nullable = false, length = 255) private String email;
    @Column(name = "display_name", nullable = false, length = 64) private String displayName;
    @Column(nullable = false, length = 16) private String tier = "NORMAL";
    @Version private long version;

    /** ★ 集合的二級快取【要單獨開】：實體上的 @Cache 不會涵蓋它。 */
    @OneToMany(fetch = FetchType.LAZY)
    @JoinColumn(name = "customer_id", insertable = false, updatable = false)
    @Cache(usage = CacheConcurrencyStrategy.READ_WRITE, region = "custOrders")
    private List<Ord6C> orders = new ArrayList<>();

    protected CustC6() {}

    public UUID getId() { return id; }
    public String getEmail() { return email; }
    public String getDisplayName() { return displayName; }
    public void rename(String n) { this.displayName = n; }
    public String getTier() { return tier; }
    public long getVersion() { return version; }
    public List<Ord6C> getOrders() { return orders; }
}
```

```java
package com.example.lab.ch06;

import jakarta.persistence.*;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

/**
 * 同一張 orders 表的另一個映射：【故意不加 @Cache】。
 * CustC6.orders 的集合快取指向它 —— 6.5.7 要看「集合有快取、元素沒有」會發生什麼。
 */
@Entity @Table(name = "orders")
public class Ord6C {

    @Id private UUID id;
    @Column(name = "order_no", nullable = false, length = 32) private String orderNo;
    @Enumerated(EnumType.STRING) @JdbcTypeCode(SqlTypes.VARCHAR)
    @Column(nullable = false, length = 16) private St6Status status;
    @Column(name = "total_amount", nullable = false, precision = 19, scale = 4) private BigDecimal totalAmount;
    @Column(name = "placed_at", nullable = false) private Instant placedAt;
    @Version private long version;

    protected Ord6C() {}

    public UUID getId() { return id; }
    public String getOrderNo() { return orderNo; }
    public St6Status getStatus() { return status; }
    public BigDecimal getTotalAmount() { return totalAmount; }
    public Instant getPlacedAt() { return placedAt; }
}
```

```java
    @Test
    void f_集合快取要單獨開() {
        head("6.5.6 集合的二級快取");
        seed(6, 2, 0);
        evictAll();
        CacheSpy c = cache();
        UUID cid = customerIds.get(0);

        c.reset();
        List<String> a = spy(() -> tx.executeWithoutResult(s -> {
            CustC6 x = em.find(CustC6.class, cid);
            x.getOrders().size();
        }));
        System.out.printf("   第一次（客戶 + orders 集合）→ %d 句 SQL%n", a.size());
        System.out.println("   " + c.full());
        c.dumpRegions();

        c.reset();
        List<String> b = spy(() -> tx.executeWithoutResult(s -> {
            CustC6 x = em.find(CustC6.class, cid);
            x.getOrders().size();
        }));
        System.out.printf("   第二次 → %d 句 SQL%n", b.size());
        b.forEach(q -> System.out.println("      " + cut(q)));
        System.out.println("   " + c.full());
    }
```

**實測**：

```
   第一次（客戶 + orders 集合）→ 2 句 SQL
   SQL=2 │ 二級快取 0/2/2 │ 查詢快取 0/0/0 │ 時間戳 0/0/0  (hit/miss/put)
   region ref             筆數=n/a  hit=0 miss=0 put=0
   region prod            筆數=n/a  hit=0 miss=0 put=0
   region custOrders      筆數=n/a  hit=0 miss=1 put=1
   region cust            筆數=n/a  hit=0 miss=1 put=1
   第二次 → 3 句 SQL
      select oc1_0.id,oc1_0.order_no,oc1_0.placed_at,oc1_0.status,… from orders oc1_0 where oc1_0.id=?
      select oc1_0.id,oc1_0.order_no,oc1_0.placed_at,oc1_0.status,… from orders oc1_0 where oc1_0.id=?
      select oc1_0.id,oc1_0.order_no,oc1_0.placed_at,oc1_0.status,… from orders oc1_0 where oc1_0.id=?
   SQL=3 │ 二級快取 2/0/0 │ 查詢快取 0/0/0 │ 時間戳 0/0/0  (hit/miss/put)
```

> 🔴🔴 **第一次 2 句，第二次 3 句 —— 快取讓它【變糟了】。**

**機制**（6.5.4 已經鋪好了）：

```
第一次：
  ① select customer where id = ?                  ← 1 句
  ② select * from orders where customer_id = ?    ← 1 句，一次撈回 3 張訂單
  兩個都放進快取：cust（客戶）、custOrders（集合）

第二次：
  ① 客戶 → 二級快取命中，0 句
  ② 集合 → 二級快取命中，拿到【三個 id】：[o1, o2, o3]     ← 集合快取只存 id
  ③ 然後要把那三個 id 變成 Ord6C 物件。
     Ord6C【沒有 @Cache】→ 只能一個一個去資料庫撈 → 🔴 3 句 SQL
```

> 📌 **集合的二級快取存的是【元素的 id 清單】，不是元素本身。**
> **所以它只有在「元素自己也有 `@Cache`」的時候才划算。**
>
> 這是一個非常標準的「最佳化把事情弄糟」的例子，而且它的形狀值得記住：
> **原本一句 `IN` 或 `WHERE fk = ?` 就能撈完的東西，變成 N 句按 id 取。**
> **這就是 04 章那個 N+1，只是這一次是【快取造成的】。**

**修法：讓 `Ord6C` 也有 `@Cache`。** 但在那之前先問一個問題：

> **「客戶的訂單清單」這個集合，適合放進快取嗎？**
>
> 它會變（每下一張單就變）、它會長（一個老客戶幾千張）、
> 而且**它的失效條件是「這個客戶有新訂單」**——
> 而 `orders` 這張表**每秒都有人在寫**。
>
> **答案是不適合。** 6.5.11 有一張表。

### 6.5.8 實測：查詢快取

實體快取解決不了「按條件查」（6.5.5）。**查詢快取就是為了那個。**

```java
    @Test
    void d_查詢快取() {
        head("6.5.7 查詢快取：要自己開，而且要逐句標 cacheable");
        seed(0, 1, 0);
        evictAll();
        CacheSpy c = cache();

        c.reset();
        List<String> first = spy(() -> tx.executeWithoutResult(s ->
            em.createQuery("select p from ProdC6 p where p.category = :c", ProdC6.class)
              .setParameter("c", "3C")
              .setHint("org.hibernate.cacheable", true)      // ★ 一句一句標
              .getResultList()));
        System.out.printf("   第一次（cacheable）  → %d 句 SQL │ %s%n", first.size(), c.full());

        c.reset();
        List<String> second = spy(() -> tx.executeWithoutResult(s ->
            em.createQuery("select p from ProdC6 p where p.category = :c", ProdC6.class)
              .setParameter("c", "3C")
              .setHint("org.hibernate.cacheable", true).getResultList()));
        System.out.printf("   第二次（cacheable）  → %d 句 SQL │ %s%n", second.size(), c.full());
    }
```

**實測**：

```
   第一次（cacheable）  → 1 句 SQL │ SQL=1 │ 二級快取 0/0/2 │ 查詢快取 0/1/1 │ 時間戳 0/0/0
   第二次（cacheable）  → 0 句 SQL │ SQL=0 │ 二級快取 0/0/0 │ 查詢快取 1/0/0 │ 時間戳 0/1/0
```

**在 Spring Data 上要這樣寫**：

```java
public interface Prod6CacheRepo extends JpaRepository<ProdC6, UUID> {

    @QueryHints(@jakarta.persistence.QueryHint(name = "org.hibernate.cacheable", value = "true"))
    List<ProdC6> findByCategory(String category);
}
```

⚠️ **每一句都要標。** 沒有「這個 repository 全部快取」這種開關 ——
這是刻意的，因為**絕大多數查詢不該被快取**（6.5.11）。

### 6.5.9 🔴 實測：查詢快取裡存的是什麼（一條過期的規則）

流傳最廣的一句話：

> 「查詢快取**只存 id**，所以一定要搭配實體快取，否則命中之後還是會 N+1。」

```java
    @Test
    void i_查詢快取裡到底存了什麼() {
        head("6.5.7b 查詢快取裡存的是 id，還是整份資料？");
        seed(0, 1, 0);
        evictAll();
        // ★ 注意用的是 Prod6（【沒有】實體快取的那個）
        tx.executeWithoutResult(s ->
            em.createQuery("select p from Prod6 p where p.category = :c", Prod6.class)
              .setParameter("c", "3C").setHint("org.hibernate.cacheable", true).getResultList());
        jcache("default-query-results-region").forEach(e -> {
            System.out.println("   key   = " + String.valueOf(e.getKey()));
            System.out.println("   value = " + e.getValue().getClass().getName());
            dumpDeep("           ", e.getValue(), 0);
        });
        System.out.println("   時間戳 region：");
        jcache("default-update-timestamps-region").forEach(e ->
            System.out.println("      " + e.getKey() + " → " + e.getValue()));
    }
```

**實測**：

```
   key   = org.hibernate.cache.spi.QueryKey@fcd0b1d7
   value = org.hibernate.cache.internal.QueryResultsCacheImpl$CacheItem
           timestamp = 7327087246061568
           results = [[Ljava.lang.Object;@4c0410a7, [Ljava.lang.Object;@4b684a63]
             [0] [Ljava.lang.Object; → [01a07f27-0889-7284-8f5d-c37758be3fae, 3C, 商品3, SKU-3, 250.0000, 0]
   時間戳 region：
```

> 🔴 **`[01a07f27-…, 3C, 商品3, SKU-3, 250.0000, 0]` —— 那是整列的欄位值，不是 id。**

**再量一次它的行為**：

```java
        // 換成沒有實體快取的 Prod6：如果「只存 id」，這裡應該要打 N 句撈實體
        evictAll();
        spy(() -> tx.executeWithoutResult(s ->
            em.createQuery("select p from Prod6 p where p.category = :c", Prod6.class)
              .setParameter("c", "3C").setHint("org.hibernate.cacheable", true).getResultList()));
        c.reset();
        List<String> noEntityCache = spy(() -> tx.executeWithoutResult(s ->
            em.createQuery("select p from Prod6 p where p.category = :c", Prod6.class)
              .setParameter("c", "3C").setHint("org.hibernate.cacheable", true).getResultList()));
        System.out.printf("   🔴 Prod6（實體【沒有】快取）第二次 → %d 句 SQL │ %s%n",
                noEntityCache.size(), c.full());
```

```
   🔴 Prod6（實體【沒有】快取）第二次 → 0 句 SQL │ SQL=0 │ 二級快取 0/0/0 │ 查詢快取 1/0/0 │ 時間戳 0/1/0
```

> **實體完全沒有二級快取，查詢快取命中之後還是 0 句 SQL。**
> **那條規則在 Hibernate 6.4 已經不成立了。**

⚠️ **但不要因此就覺得「查詢快取變好用了」**——
它真正的問題不在這裡，在下一節。

### 6.5.10 🔴 實測：一次寫入讓整區失效

```java
    @Test
    void e_一次寫入讓整區失效() {
        head("6.5.8 🔴 查詢快取的失效範圍：改一列，整張表的快取查詢全部失效");
        seed(0, 1, 0);
        evictAll();
        CacheSpy c = cache();

        Runnable q1 = () -> tx.executeWithoutResult(s ->
            em.createQuery("select p from ProdC6 p where p.category = '3C'", ProdC6.class)
              .setHint("org.hibernate.cacheable", true).getResultList());
        Runnable q2 = () -> tx.executeWithoutResult(s ->
            em.createQuery("select p from ProdC6 p where p.category = '書籍'", ProdC6.class)
              .setHint("org.hibernate.cacheable", true).getResultList());
        q1.run(); q2.run();                       // 兩句都進快取

        c.reset();
        int n1 = spy(() -> { q1.run(); q2.run(); }).size();
        System.out.printf("   都命中時：兩句查詢共 %d 句 SQL │ %s%n", n1, c.full());

        // 改【生鮮】那一個商品，跟上面兩句查詢的結果完全無關
        tx.executeWithoutResult(s -> {
            ProdC6 p = em.createQuery("select p from ProdC6 p where p.category = '生鮮'", ProdC6.class)
                         .setMaxResults(1).getSingleResult();
            p.setName(p.getName() + "!");
        });

        c.reset();
        int n2 = spy(() -> { q1.run(); q2.run(); }).size();
        System.out.printf("   改了一個【生鮮】商品之後：兩句查詢共 %d 句 SQL │ %s%n", n2, c.full());
    }
```

**實測**：

```
   都命中時：兩句查詢共 0 句 SQL │ SQL=0 │ 查詢快取 2/0/0 │ 時間戳 0/2/0
   改了一個【生鮮】商品之後：兩句查詢共 2 句 SQL │ SQL=2 │ 查詢快取 0/2/2 │ 時間戳 2/0/0
```

> 🔴 **改了一個「生鮮」商品，「3C」與「書籍」那兩句查詢的快取【全部失效】。**

**機制就是那個「時間戳 region」**：

```
default-update-timestamps-region 存的是「每一張表【最後被寫】的時間」：
    product → 2026-09-08T12:00:00.123

而每一筆快取的查詢結果也帶著一個 timestamp（它被放進去的時間）。

命中的判斷是：
    這句查詢碰到的每一張表，最後被寫的時間  <  這筆結果被快取的時間？
        是 → 命中
        否 → 丟掉，重查

★ 粒度是【表】，不是【列】，更不是【查詢條件】。
```

> 📌 **這就是查詢快取的真正代價，而它比「只存 id」嚴重得多**：
>
> **一張每分鐘都有寫入的表，它上面的所有快取查詢的命中率都是 0，
> 而你還要付「每次查完都塞進快取」的成本。**
>
> **判準因此非常明確**：
> **查詢快取只適合「幾乎不寫」的表。**
> 而「幾乎不寫的表」通常筆數也少 —— **那你為什麼不直接快取實體，用 `find(id)` 取？**
>
> **這就是查詢快取預設關閉、而且在實務上很少開的原因。**
> 它不是壞掉的功能，它是**適用範圍非常窄的功能**，而那個範圍
> 通常已經被「實體快取 + 按 id 取」或「應用層自己快取一個 `List`」蓋掉了。

### 6.5.11 🔴 實測：有人繞過 JPA 改了那張表

```java
    @Test
    void g_旁路寫入會騙你() {
        head("6.5.9 🔴 有人繞過 JPA 改了那張表");
        seed(0, 1, 0);
        evictAll();
        UUID pid = productIds.get(0);

        String before = tx.execute(s -> em.find(ProdC6.class, pid).getName());
        System.out.println("   JPA 讀到（並放進二級快取）：" + before);

        jdbc.update("UPDATE product SET name = ? WHERE id = ?", "被 MyBatis 改掉了", Uuid7.toBytes(pid));
        System.out.println("   繞過 JPA 直接 UPDATE 之後，DB 裡是："
                + jdbc.queryForObject("SELECT name FROM product WHERE id = ?", String.class,
                        (Object) Uuid7.toBytes(pid)));

        CacheSpy c = cache(); c.reset();
        String after = tx.execute(s -> em.find(ProdC6.class, pid).getName());
        System.out.println("   🔴 新的交易用 find() 讀到的是：" + after + " │ " + c.summary());

        emf.getCache().evict(ProdC6.class, pid);
        System.out.println("   evict 那一筆之後再讀：" + tx.execute(s -> em.find(ProdC6.class, pid).getName()));
    }
```

**實測**：

```
   JPA 讀到（並放進二級快取）：商品0
   繞過 JPA 直接 UPDATE 之後，DB 裡是：被 MyBatis 改掉了
   🔴 新的交易用 find() 讀到的是：商品0 │ SQL=0 實體=0 │ 二級快取 hit=1 miss=0 put=0
   evict 那一筆之後再讀：
   → 被 MyBatis 改掉了
```

> 🔴 **資料庫裡是新值，應用程式讀到的是舊值，而且【永遠】讀到舊值**——
> 直到快取過期，或者有人手動 `evict`。

**這跟 00 章 0.3.5 事故五是同一個形狀**：

```
事故五：MyBatis 寫入 → JPA 的【樂觀鎖】失效
本節：  MyBatis 寫入 → JPA 的【二級快取】失效

共同點：JPA 的兩個機制都建立在「所有的寫入都經過我」這個前提上。
```

**三種處理方式**：

| 做法 | 適用 | 代價 |
|---|---|---|
| **同一張表只讓一個框架寫**（00 章 0.9 規則一） | 一般情況 | 需要團隊紀律；09 章 9.5 會給架構上的做法 |
| **旁路寫入之後主動 `evict`** | 少數必要的旁路（批次作業、資料修正） | 每一個旁路路徑都要記得，而且**忘了不會報錯** |
| **只快取「本應用程式獨佔寫入」的表** | 參數表、設定表 | 這是最省事、也最不會錯的一條 |

```java
// 旁路寫入之後主動 evict 的三個粒度
emf.getCache().evict(ProdC6.class, pid);   // 一筆
emf.getCache().evict(ProdC6.class);        // 一個實體型別
emf.getCache().evictAll();                 // 全部（重新載入參數表之後可以用）
```

⚠️ **`evict` 只清掉【這個 JVM】的快取。**
多台機器的時候，A 機器 evict 了，B 機器的快取還是舊的 ——
**這就是「二級快取一旦上多台就要換成分散式快取」的原因**，
而分散式快取又帶來序列化、網路延遲、以及「快取比資料庫還慢」的新問題。

### 6.5.12 什麼東西適合放進二級快取

**四個問題，全部答「是」才放**：

```
① 這張表【幾乎不寫】嗎？                      → 否：不要放（6.5.10 的時間戳機制）
② 這個應用程式是它【唯一的寫入者】嗎？          → 否：不要放（6.5.11）
③ 讀它的方式主要是【按 id 取】嗎？              → 否：實體快取幫不上忙（6.5.5）
④ 全部放進記憶體【放得下】嗎？                  → 否：不要放（或設 heap 上限並接受 miss）
```

| 東西 | 適合嗎 | 理由 |
|---|---|---|
| 國別 / 幣別 / 稅率 / 設定參數 | ✅✅ `READ_ONLY` | 四個問題全過 |
| 商品主檔（電商，每天更新一次） | ✅ `READ_WRITE` | 過，但要注意批次更新後 `evict` |
| 客戶（會員資料） | 🟡 看情況 | 寫入頻率低、按 id 取為主 → 可以；但筆數可能很大 |
| **訂單** | 🔴 | 每秒都在寫，而且列表頁是按條件查 |
| **庫存** | 🔴🔴 | 每秒都在寫，**而且讀到舊值會直接造成超賣**（6.8） |
| 「客戶的訂單清單」這種集合 | 🔴 | 6.5.7 量過：會變、會長，而且集合快取只存 id |
| 報表的查詢結果 | 🔴 用查詢快取 | 而查詢快取的失效粒度是整張表（6.5.10）→ 通常改用應用層快取 |

> 📌 **最後一列值得展開**：
> 「這份報表每五分鐘算一次就好」——這個需求**不該用 Hibernate 的查詢快取**，
> 因為它的失效條件是「表被寫過」，而你要的是「時間到了」。
> **用 Spring 的 `@Cacheable` 快取那個 DTO 的 `List`**，
> 設 `ttl = 5 分鐘`，語義才對得上。
>
> **這是一條分界**：
> **Hibernate 的快取管的是「實體與資料庫的一致性」；
> 應用層的快取管的是「這個結果可以舊多久」。**
> **兩件事，不要用其中一個去做另一個。**

### 6.5.13 補上 05 章的 `ReadOnlySpy`

05 章 5.17 留了一個承諾：

> 「`ReadOnlySpy` 只看 `entityLoadCount` —— 06 章會加上 `secondLevelCacheHitCount`：
> **一個「不建實體」的查詢，也可能是「每次都打資料庫」的查詢。**」

```java
package com.example.lab.ch06;

import jakarta.persistence.EntityManagerFactory;
import org.hibernate.SessionFactory;
import org.hibernate.stat.Statistics;

/**
 * 05 章 5.13.3 的 ReadOnlySpy，加上二級快取那一側。
 *
 *   entityLoad     ——「這個用例把幾列變成了實體」（05 章的問題）
 *   statements     ——「這個用例打了幾句 SQL」
 *   cacheHit/Miss  ——「其中有幾句【本來可以不用打】」（06 章的問題）
 */
public final class ReadOnlySpy2 {

    private final Statistics s;

    public ReadOnlySpy2(EntityManagerFactory emf) {
        this.s = emf.unwrap(SessionFactory.class).getStatistics();
        if (!s.isStatisticsEnabled()) {
            throw new IllegalStateException("要先開 hibernate.generate_statistics=true");
        }
    }

    public Result watch(Runnable body) {
        s.clear();
        body.run();
        return new Result(s.getPrepareStatementCount(), s.getEntityLoadCount(),
                s.getSecondLevelCacheHitCount(), s.getSecondLevelCacheMissCount());
    }

    public record Result(long statements, long entityLoad, long cacheHit, long cacheMiss) {

        /** 05 章那一條：唯讀用例不該建實體。 */
        public Result assertNoEntities() {
            if (entityLoad > 0) throw new AssertionError(String.format(
                    "這個唯讀用例建了 %d 個實體（%d 句 SQL）。改用 DTO 投影（05 章 5.8）。",
                    entityLoad, statements));
            return this;
        }

        /**
         * 06 章加的一條：這個用例的 SQL 句數不該超過 max。
         * ★ 為什麼不寫「快取命中率要大於 x%」：
         *   命中率跟【前面跑過什麼】有關，是一個不穩定的斷言。
         *   「這個用例最多打 N 句 SQL」跟資料量與快取狀態都無關，才適合寫進 CI。
         */
        public Result assertAtMostStatements(long max) {
            if (statements > max) throw new AssertionError(String.format(
                    "打了 %d 句 SQL，上限 %d（二級快取 hit=%d miss=%d）。",
                    statements, max, cacheHit, cacheMiss));
            return this;
        }

        /** 這個用例應該完全靠快取。用在「參數表一定要在啟動時預熱」這種場景。 */
        public Result assertAllFromCache() {
            if (cacheMiss > 0 || statements > 0) throw new AssertionError(String.format(
                    "有 %d 次快取沒中、打了 %d 句 SQL —— 預熱沒有生效。", cacheMiss, statements));
            return this;
        }

        @Override public String toString() {
            return String.format("stmt=%d entityLoad=%d 快取 hit=%d miss=%d",
                    statements, entityLoad, cacheHit, cacheMiss);
        }
    }
}
```

**三條斷言的分工**（接續 05 章 5.13.4 那張表）：

| 斷言 | 抓什麼 | 跟資料量有關嗎 |
|---|---|---|
| 04 章 `NPlus1Spy`：`entityFetch + collectionFetch == 0` | 有人加了一行 `getXxx()` | ❌ 無關 |
| 05 章 `assertNoEntities()`：`entityLoad == 0` | 有人把投影改回實體 | ❌ 無關 |
| **06 章 `assertAtMostStatements(n)`** | **有人拿掉了 `@Cache`，或者改成「按條件查」** | ❌ 無關 |

---
## 6.6 樂觀鎖 `@Version` ★★

從這裡開始，這一章換一個問題：**兩個人同時做同一件事，誰會贏？**

### 6.6.0 先把工具準備好

並行的實驗有一個坑，**踩到的話結論會完全相反**，所以先講。

```java
    // ───────── 並行實驗的工具（6.6～6.8） ─────────

    /**
     * 開 n 條執行緒，每一條跑一次 task，【全部到齊才一起開始】。
     * 回傳每一條的結果或它拋出的例外。
     */
    protected List<Object> race(int n, java.util.function.IntFunction<Object> task) {
        java.util.concurrent.ExecutorService pool = java.util.concurrent.Executors.newFixedThreadPool(n);
        java.util.concurrent.CountDownLatch ready = new java.util.concurrent.CountDownLatch(n);
        java.util.concurrent.CountDownLatch go = new java.util.concurrent.CountDownLatch(1);
        List<java.util.concurrent.Future<Object>> fs = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            final int idx = i;
            fs.add(pool.submit(() -> {
                ready.countDown();
                go.await();
                try { return task.apply(idx); }
                catch (Throwable t) { return t; }
            }));
        }
        try {
            ready.await();
            go.countDown();
            List<Object> out = new ArrayList<>();
            for (var f : fs) out.add(f.get(60, java.util.concurrent.TimeUnit.SECONDS));
            return out;
        } catch (Exception e) { throw new RuntimeException(e); }
        finally { pool.shutdownNow(); }
    }

    /** 把 race() 的結果整理成「成功幾個、各種例外幾個」。 */
    protected String tally(List<Object> results) {
        LinkedHashMap<String, Integer> m = new LinkedHashMap<>();
        for (Object o : results) {
            m.merge(o instanceof Throwable t ? t.getClass().getSimpleName() : "成功", 1, Integer::sum);
        }
        return m.toString();
    }

    /** 在另一條執行緒上跑一個完整的交易，等它做完（提交或回滾）。 */
    protected void otherTx(Runnable body) {
        Thread t = new Thread(() -> tx.executeWithoutResult(s -> body.run()));
        t.start();
        try { t.join(60_000); } catch (InterruptedException e) { throw new RuntimeException(e); }
    }

    /**
     * 在【另一條執行緒的獨立交易】裡讀資料庫。
     * ⚠️ 一定要這樣讀：MySQL 預設 REPEATABLE READ，
     *    在自己的交易裡讀，看到的是自己那份快照（03 章 3.3.4），
     *    別人剛提交的東西【看不到】——會讓實驗結論完全相反。
     */
    protected <T> T outside(java.util.function.Supplier<T> body) {
        var box = new java.util.concurrent.atomic.AtomicReference<Object>();
        Thread t = new Thread(() -> {
            try { box.set(tx.execute(s -> body.get())); }
            catch (Throwable e) { box.set(e); }
        });
        t.start();
        try { t.join(60_000); } catch (InterruptedException e) { throw new RuntimeException(e); }
        Object v = box.get();
        if (v instanceof Throwable e) throw new RuntimeException(e);
        @SuppressWarnings("unchecked") T r = (T) v;
        return r;
    }

    /** 跑一個交易，把它拋出的例外收下來（含 commit 時才拋的那些）。 */
    protected Throwable catching(Runnable body) {
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
```

⚠️ **`outside()` 那個註解就是那個坑。** 第一版的實驗長這樣：

```java
    tx.executeWithoutResult(s -> {
        Ord6 mine = em.find(Ord6.class, oid);
        otherTx(() -> em.find(Ord6.class, oid).setMemo("B 改的"));    // B 改完並提交
        long v = jdbc.queryForObject("SELECT version FROM orders WHERE id = ?", …);
        System.out.println("B 改完，DB 的 version = " + v);            // 印出 0
        …
    });
```

**它印出 `version = 0`，而 B 真的提交了、DB 裡真的是 1。**
因為那句 `jdbc.queryForObject` 跑在 **A 自己的交易裡**，讀到的是 A 那份快照。

> 📌 **這正是 03 章 3.3.4 那個「兩層騙你」在實驗程式碼上咬人**。
> **並行實驗的第一條規則：驗證用的讀取，一定要在另一個交易裡。**

另外一個坑：**`catching()` 為什麼要包整個交易，而不是只包 `flush()`**。
樂觀鎖的例外**可以在 commit 的時候才拋**，而 commit 發生在 `tx.execute` 的**外面**。
只 catch `flush()` 的話，測試會在 `tx.execute` 那一行掛掉，
訊息是 `UnexpectedRollback: Transaction silently rolled back because it has been
marked as rollback-only` —— 一個完全指不到真正原因的訊息。

### 6.6.1 實測：`@Version` 在 SQL 裡長什麼樣

```java
    @Test
    void a_version_長在_SQL_的哪裡() {
        head("6.6.1 @Version 在 SQL 裡長什麼樣");
        seed(1, 1, 0);
        UUID oid = orderIds.get(0);
        System.out.println("   一開始 version = " + versionOf(oid));
        showSql("改一次狀態", () -> tx.executeWithoutResult(s -> em.find(Ord6.class, oid).pay()));
        System.out.println("   改完 version = " + versionOf(oid));
    }

    private long versionOf(UUID oid) {
        return outside(() -> jdbc.queryForObject("SELECT version FROM orders WHERE id = ?",
                Long.class, (Object) Uuid7.toBytes(oid)));
    }
```

**實測**：

```
   一開始 version = 0
── 改一次狀態 → 2 句 SQL
   select o1_0.id,o1_0.currency,…,o1_0.version from orders o1_0 where o1_0.id=?
   update orders set currency=?,customer_id=?,discount_amount=?,memo=?,order_no=?,
          paid_at=?,placed_at=?,status=?,total_amount=?,version=? where id=? and version=?
   改完 version = 1
```

**`version` 出現在兩個地方**：

```
set … version = ?            ← 寫入新的版本（舊版 + 1）
where id = ? and version = ? ← 🔴 用【讀出來的那個版本】當條件
```

**整個樂觀鎖就是這一行 `where`**：

```
① 我讀的時候 version 是 0
② 我寫的時候要求「現在還是 0」
③ 影響列數 = 1 → 沒有人動過，我贏了，version 變成 1
   影響列數 = 0 → 有人在我之前改了（version 已經不是 0）→ 拋例外
```

> 📌 **它為什麼叫「樂觀」**：
> **它不阻止任何人。** 它讓所有人都去做，只在最後一刻檢查「我讀的東西還算數嗎」。
> 對照組是 6.7 的悲觀鎖：**先把門鎖起來，其他人排隊。**

### 6.6.2 實測：兩個交易搶同一列

```java
    @Test
    void b_兩個交易搶同一列() {
        head("6.6.2 兩個交易讀同一張訂單，各改各的");
        seed(1, 1, 0);
        UUID oid = orderIds.get(0);

        Throwable err = catching(() -> {
            Ord6 mine = em.find(Ord6.class, oid);            // A 讀出來，version = 0
            System.out.println("   A 讀到 version = " + mine.getVersion());

            otherTx(() -> em.find(Ord6.class, oid).setMemo("B 改的"));   // B 改完並提交
            System.out.println("   B 改完，DB 的 version = " + versionOf(oid)
                    + "（⚠️ 一定要用另一個交易去讀：A 自己的快照看到的還是 0）");

            mine.cancel();                                    // A 拿舊資料寫回去
        });
        System.out.println("   🔴 A 提交時：" + name(err));
        if (err != null) System.out.println("      訊息：" + root(err).getMessage());
        System.out.println("   最後 DB：" + outside(() -> jdbc.queryForMap(
                "SELECT status, memo, version FROM orders WHERE id = ?", (Object) Uuid7.toBytes(oid))));
    }
```

**實測**：

```
   A 讀到 version = 0
   B 改完，DB 的 version = 1（⚠️ 一定要用另一個交易去讀：A 自己的快照看到的還是 0）
   🔴 A 提交時：ObjectOptimisticLockingFailureException ← StaleObjectStateException
      訊息：Row was updated or deleted by another transaction
            (or unsaved-value mapping was incorrect) : [com.example.lab.ch06.Ord6#01a07f29-…]
   最後 DB：{status=PENDING, memo=B 改的, version=1}
```

**A 的修改被完整地拒絕了，B 的留下來了。**

**兩個例外，兩個層次**：

```
StaleObjectStateException             ← Hibernate 的（org.hibernate）
   ↓ 被 Spring 的例外轉譯攔下來
ObjectOptimisticLockingFailureException ← Spring 的（org.springframework.orm）
   繼承自 ConcurrencyFailureException → DataAccessException
```

> 📌 **接哪一個**：
> **`ObjectOptimisticLockingFailureException`**（Spring 的那個）。
> 理由跟 06 站一樣：**它是框架無關的**，MyBatis / JdbcTemplate 那一側
> 如果自己維護 version 並拋這個，重試邏輯可以共用。
>
> ⚠️ **不要接 `jakarta.persistence.OptimisticLockException`**：
> 在 Spring Data 的路徑上，你收到的**通常已經被轉譯過了**，
> 接 JPA 那個會漏掉。（而 `em.merge()` 直接呼叫時收到的是 JPA 那個 —— 6.6.5。）

### 6.6.3 🔴 實測：沒有 `@Version` 的下場

```java
    @Test
    void c_沒有_version_的下場() {
        head("6.6.3 🔴 同樣的情境，實體上沒有 @Version");
        UUID pid = seedOneStock(100);

        tx.executeWithoutResult(s -> {
            StNoVer6 mine = em.find(StNoVer6.class, pid);      // A 讀到 qty = 100
            System.out.println("   A 讀到 qty = " + mine.getQty());
            otherTx(() -> em.find(StNoVer6.class, pid).reserve(30));   // B 扣 30 → 70
            System.out.println("   B 扣完，DB 的 qty = " + outside(() ->
                    jdbc.queryForObject("SELECT qty FROM stock WHERE product_id = ?", Integer.class,
                            (Object) Uuid7.toBytes(pid))));
            mine.reserve(20);                                  // A 用舊的 100 算成 80
        });
        System.out.println("   🔴 A 提交後 DB：" + outside(() -> jdbc.queryForMap(
                "SELECT qty, reserved_qty, version FROM stock WHERE product_id = ?",
                (Object) Uuid7.toBytes(pid))));
        System.out.println("   兩人各扣一次（30 + 20），正確答案是 50，而且【沒有任何錯誤訊息】");

        System.out.println("   ── 換成有 @Version 的 St6，同樣的劇本 ──");
        seedOneStock2(pid, 100);
        Throwable err = catching(() -> {
            St6 mine = em.find(St6.class, pid);
            otherTx(() -> em.find(St6.class, pid).reserve(30));
            mine.reserve(20);
        });
        System.out.println("   → " + name(err));
        System.out.println("   DB：" + outside(() -> jdbc.queryForMap(
                "SELECT qty, reserved_qty, version FROM stock WHERE product_id = ?",
                (Object) Uuid7.toBytes(pid))));
    }

    private void seedOneStock2(UUID pid, int qty) {
        outside(() -> jdbc.update(
                "UPDATE stock SET qty = ?, reserved_qty = 0, version = 0 WHERE product_id = ?",
                qty, Uuid7.toBytes(pid)));
    }
```

**實測**：

```
   A 讀到 qty = 100
   B 扣完，DB 的 qty = 70
   🔴 A 提交後 DB：{qty=80, reserved_qty=20, version=0}
   兩人各扣一次（30 + 20），正確答案是 50，而且【沒有任何錯誤訊息】
   ── 換成有 @Version 的 St6，同樣的劇本 ──
   → ObjectOptimisticLockingFailureException ← StaleObjectStateException
   DB：{qty=70, reserved_qty=30, version=1}
```

**這就是 lost update**：

```
時間軸                     DB.qty     A 手上      B 手上
──────────────────────────────────────────────────────
A 讀                        100        100
B 讀                        100        100        100
B 扣 30、提交                 70        100         70
A 扣 20（用手上的 100）        70         80
A 提交：UPDATE stock SET qty = 80  ← 🔴 直接覆蓋，B 的扣減消失了
                             80
```

⚠️ **注意「正確答案」是什麼**：
不是「A 應該失敗」，而是「**這兩次扣減之中有一次必須被察覺到**」。
有 `@Version` 的版本裡，A 拿到了例外 —— **那才有機會重試、或者告訴使用者**。

> 🔴 **「靜默覆蓋」為什麼比「拋例外」糟糕得多**：
>
> ```
> 拋例外：  你【知道】發生了衝突。你可以重試、可以回報、可以記 log。
>          它是一個【當下就會被發現】的問題。
>
> 靜默覆蓋：帳少了 20 件。三天後盤點的時候發現對不上。
>          而那時候你手上有：三天份的 log、幾萬筆訂單、
>          以及一段【看起來完全正確】的程式碼。
> ```
>
> **這一站的六個事故（00 章 0.3）有五個是「靜默」的。**
> **而 05 章 5.17 那句預告——「靜默覆蓋比拋例外糟糕得多」——講的就是這件事。**

### 6.6.4 `@Version` 該放哪、該用什麼型別

**放哪**：

```
放在【聚合根】上（02 章 2.12 講的那個邊界）。
   Order 有，OrderItem 沒有       ← 明細的並行保護靠訂單的 version
   Product 有，Stock 有            ← 它們是兩個獨立的聚合（06 站 03 章）
```

**型別**：

| 型別 | 可以嗎 | 備註 |
|---|---|---|
| `int` / `Integer` / `long` / `Long` | ✅ | **用 `long`**。`int` 在極高頻更新的列上理論上會繞回 |
| `short` / `Short` | ✅ | 別用，32767 很容易到 |
| `java.sql.Timestamp` / `Instant` | 🟡 規格允許 | 🔴 **不要用**：兩個交易在同一毫秒提交 → 版本一樣 → 檢查失效 |

**五條規則**：

```
① 型別用 long，欄位 NOT NULL DEFAULT 0。
② 【永遠不要自己改它】。setVersion() 不要寫出來。
③ 它是【技術欄位】，不要出現在 DTO、不要回給前端當「資料版本」。
   （前端要的「我改的是不是最新的」是另一回事，通常用 ETag / updated_at。）
④ 已經上線的表要加 @Version：欄位先加上 DEFAULT 0，再部署程式碼。
   反過來（先部署程式碼）會讓所有既有的列 version 是 null → 全部炸。
⑤ 🔴 一張表如果有【非 JPA 的寫入路徑】，@Version 就不完整（6.6.10）。
```

⚠️ **關於 ③，有一個例外要講清楚**：
「使用者打開編輯畫面 → 十分鐘後按儲存 → 中間別人改了」這個需求
（有時候叫 offline optimistic lock），**確實需要把版本帶到前端再帶回來**。
那時候 `@Version` 這個欄位可以拿來用（把它放進 DTO、回傳時比對），
**而 6.6.5 會示範那條路真正的樣子**。

### 6.6.5 實測：detached 的實體 `merge` 回去

```java
    @Test
    void d_detached_merge_也會檢查() {
        head("6.6.5 detached 的實體 merge 回去，版本一樣會被檢查");
        seed(1, 1, 0);
        UUID oid = orderIds.get(0);
        Ord6 detached = tx.execute(s -> { Ord6 o = em.find(Ord6.class, oid); em.detach(o); return o; });
        System.out.println("   手上這個 detached 實體的 version = " + detached.getVersion());

        otherTx(() -> em.find(Ord6.class, oid).setMemo("別人先改了"));
        System.out.println("   別人改完，DB 的 version = " + versionOf(oid));

        detached.setMemo("我後改的");
        Throwable err = catching(() -> em.merge(detached));
        System.out.println("   merge 的結果：" + name(err));
        System.out.println("   DB：" + outside(() -> jdbc.queryForMap(
                "SELECT memo, version FROM orders WHERE id = ?", (Object) Uuid7.toBytes(oid))));
    }
```

**實測**：

```
   手上這個 detached 實體的 version = 0
   別人改完，DB 的 version = 1
   merge 的結果：OptimisticLockException ← StaleObjectStateException
   DB：{memo=別人先改了, version=1}
```

**這就是 `@Version` 唯一能跨越「交易邊界」的用法**：

```
① 交易 1：讀出訂單、轉成 DTO（DTO 裡帶著 version）
② HTTP 回應 → 使用者編輯十分鐘 → HTTP 請求帶著 version 回來
③ 交易 2：把 DTO 的值套回實體、把 version 也套回去 → merge
   → 中間有人改過的話，這裡會拋例外
```

⚠️ **注意 `em.merge()` 拋的是 `jakarta.persistence.OptimisticLockException`（JPA 的）**，
不是 6.6.2 那個 Spring 的 `ObjectOptimisticLockingFailureException`。
差別在於**誰呼叫的**：走 Spring Data 的 repository 會被轉譯，直接用 `EntityManager` 不會。
**所以重試的 `catch` 要接兩個**，或者統一走 repository。

📌 **而 03 章 3.6.4 那個「`merge` 靜默清空 `nickname`」的坑還在**：
把 DTO 套回實體的時候，**沒有出現在 DTO 裡的欄位會被寫成 null**。
**正確的做法不是 `merge` 一個新建的實體，而是**：

```java
    @Transactional
    public void update(UUID id, OrderEditForm form) {
        Ord6 o = repo.findById(id).orElseThrow();      // ① 撈出 managed 實體
        if (o.getVersion() != form.version()) {         // ② 自己比對版本
            throw new ObjectOptimisticLockingFailureException(Ord6.class, id);
        }
        o.setMemo(form.memo());                         // ③ 只改該改的欄位
    }                                                   // ④ 髒檢查寫回去，version 自己 +1
```

**這條路同時解決了兩件事**：版本檢查是明確的，而且**沒有欄位會被意外清空**。

### 6.6.6 🔴 實測：只改集合，不會動父的版本

```java
    @Test
    void e_只改集合不會動父的版本() {
        head("6.6.6 🔴 只改集合（加一筆明細），父實體的 version 會動嗎？");
        seed(1, 1, 1);
        UUID oid = orderIds.get(0);
        UUID pid = productIds.get(0);
        long v0 = versionOf(oid);

        showSql("加一筆明細（cascade PERSIST）", () -> tx.executeWithoutResult(s -> {
            Ord6 o = em.find(Ord6.class, oid);
            o.getItems().size();
            o.getItems().add(new Item6(Uuid7.next(), o, em.find(Prod6.class, pid), 1));
        }));
        long v1 = versionOf(oid);
        System.out.println("   version：" + v0 + " → " + v1);

        System.out.println("   ── 換成 OPTIMISTIC_FORCE_INCREMENT ──");
        showSql("再加一筆，這次鎖住父", () -> tx.executeWithoutResult(s -> {
            Ord6 o = em.find(Ord6.class, oid, LockModeType.OPTIMISTIC_FORCE_INCREMENT);
            o.getItems().size();
            o.getItems().add(new Item6(Uuid7.next(), o, em.find(Prod6.class, pid), 1));
        }));
        System.out.println("   version：" + v1 + " → " + versionOf(oid));
    }
```

**實測**：

```
── 加一筆明細（cascade PERSIST） → 4 句 SQL
   select o1_0.id,… from orders o1_0 where o1_0.id=?
   select i1_0.order_id,… from order_item i1_0 where i1_0.order_id=?
   select p1_0.id,… from product p1_0 where p1_0.id=?
   insert into order_item (…) values (?,?,?,?,?,?,?)
   version：0 → 0                                        ← 🔴 沒有動

── 換成 OPTIMISTIC_FORCE_INCREMENT ──
── 再加一筆，這次鎖住父 → 5 句 SQL
   select … from orders o1_0 where o1_0.id=?
   select … from order_item i1_0 where i1_0.order_id=?
   select … from product p1_0 where p1_0.id=?
   insert into order_item (…) values (?,?,?,?,?,?,?)
   update orders set version=? where id=? and version=?   ← ★ 多這一句
   version：0 → 1
```

> 🔴 **為什麼這是個問題**：
>
> ```
> A 讀出訂單（總額 250、兩筆明細），準備審核
> B 同時加了一筆 500 元的明細
> A 審核通過，把 status 改成 APPROVED 並提交
>    → A 的 version 檢查【通過】，因為 B 根本沒有動 orders 那一列
>    → 結果：一張「審核過的、總額 750」的訂單，而審核的人只看過 250 那一版
> ```
>
> **`@Version` 保護的是【那一列】，不是【那個聚合】。**
> 而 02 章 2.12 講的聚合邊界說「訂單與它的明細是一個整體」——
> **兩者對不上的地方，就是 `OPTIMISTIC_FORCE_INCREMENT` 存在的理由。**

**兩種寫法**：

```java
// ① 明確地在讀的時候要求「這次操作要動到聚合根的版本」
Ord6 o = em.find(Ord6.class, id, LockModeType.OPTIMISTIC_FORCE_INCREMENT);

// ② Spring Data：在 repository 方法上標
public interface Ord6Repo extends JpaRepository<Ord6, UUID> {
    @Lock(LockModeType.OPTIMISTIC_FORCE_INCREMENT)
    @Query("select o from Ord6 o where o.id = :id")
    Optional<Ord6> findByIdForUpdateAggregate(@Param("id") UUID id);
}
```

📌 **另一種做法是讓「加明細」這個動作本身就改到父**——
`Ord6.addItem()` 有更新 `totalAmount`，那就會動 version。
**這也是為什麼「聚合根上要有一個會隨子實體變動的欄位」是個好設計**：
它讓版本控制自然發生，不需要記得標註解。

⚠️ **注意上面實測那一段 `o.getItems().add(...)` 是【直接操作集合】**，
繞過了 `addItem()` —— 這在真實程式碼裡就是不該做的事（02 章 2.4）。
**這裡是為了把「只動集合」這個情境隔離出來**。

### 6.6.7 🔴🔴 實測：`LockModeType.OPTIMISTIC` 在 MySQL 上常常無效 ★★

還有一個情境：**我只是讀它，但我的決定依賴它**。

```
讀訂單的 status（PENDING）→ 決定「可以出貨」→ 建立出貨單
   而在這中間，有人把訂單取消了。
   我【沒有改訂單】，所以我的交易裡沒有任何 version 檢查。
```

JPA 對這個情境的答案是 `LockModeType.OPTIMISTIC`：
「**我讀了它，請在我提交的時候幫我確認它還沒被改過。**」

```java
    @Test
    void f_只讀也要檢查() {
        head("6.6.7 LockModeType.OPTIMISTIC：我只是讀，但我的決定依賴它");
        seed(1, 1, 0);
        UUID oid = orderIds.get(0);

        Throwable plain = catching(() -> {
            Ord6 o = em.find(Ord6.class, oid);                       // 不加鎖，純讀
            System.out.println("   ① 純讀，讀到 status = " + o.getStatus());
            otherTx(() -> em.find(Ord6.class, oid).cancel());
        });
        System.out.println("   ① 交易結束：" + name(plain));

        seed(1, 1, 0);
        UUID oid2 = orderIds.get(0);
        Throwable opt = catching(() -> {
            Ord6 o = em.find(Ord6.class, oid2, LockModeType.OPTIMISTIC);
            System.out.println("   ② OPTIMISTIC 讀，讀到 status = " + o.getStatus());
            otherTx(() -> em.find(Ord6.class, oid2).cancel());
        });
        System.out.println("   ② 交易結束：" + name(opt));
        showSql("OPTIMISTIC 在 commit 時多打的那一句", () -> tx.executeWithoutResult(s ->
                em.find(Ord6.class, oid2, LockModeType.OPTIMISTIC)));
    }
```

**實測（MySQL 預設隔離等級 = REPEATABLE READ）**：

```
   ① 純讀，讀到 status = PENDING
   ① 交易結束：沒有例外
   ② OPTIMISTIC 讀，讀到 status = PENDING
   ② 交易結束：沒有例外                              ← 🔴🔴 它沒有擋住
── OPTIMISTIC 在 commit 時多打的那一句 → 2 句 SQL
   select o1_0.id,o1_0.currency,…,o1_0.version from orders o1_0 where o1_0.id=?
   select version as version_ from orders where id=?     ← ★ 它確實多查了一次
```

**它確實多打了一句 `select version`，而它還是沒有擋住。** 為什麼？

```java
    @Test
    void j_OPTIMISTIC_在_REPEATABLE_READ_下() {
        head("6.6.7b 🔴 OPTIMISTIC 的那句 select version，讀的是哪一份資料？");
        seed(1, 1, 0);
        UUID oid = orderIds.get(0);
        System.out.println("   目前的隔離等級 = " + jdbc.queryForObject(
                "SELECT @@transaction_isolation", String.class));
        Throwable err = catching(() -> {
            em.find(Ord6.class, oid, LockModeType.OPTIMISTIC);
            otherTx(() -> em.find(Ord6.class, oid).cancel());
            System.out.println("   別人改完，DB（另一個交易讀）version = " + versionOf(oid));
            System.out.println("   而 A 自己在交易裡讀 version = " + jdbc.queryForObject(
                    "SELECT version FROM orders WHERE id = ?", Long.class,
                    (Object) Uuid7.toBytes(oid)) + "  ← 同一個 SQL、不同答案");
        });
        System.out.println("   → " + name(err));
    }
```

**實測**：

```
   目前的隔離等級 = REPEATABLE-READ
   別人改完，DB（另一個交易讀）version = 1
   而 A 自己在交易裡讀 version = 0  ← 同一個 SQL、不同答案
   → 沒有例外
```

> 🔴🔴 **機制**：
> `OPTIMISTIC` 的檢查方式是「**在提交前，用一句 `SELECT version` 重讀一次**」。
> 而在 **REPEATABLE READ** 下，那次重讀命中的是**這個交易自己的快照** ——
> **快照裡的 version 永遠等於我讀到的那一個。檢查必然通過。**
>
> **一個永遠會通過的檢查，就是沒有檢查。**

**換成 `READ COMMITTED` 再跑一次**：

```java
@SpringBootTest(properties = {
  "spring.datasource.url=jdbc:mysql://127.0.0.1:33306/ch06?connectionTimeZone=UTC"
      + "&forceConnectionTimeZoneToSession=true&preserveInstants=true&characterEncoding=UTF-8"
      + "&sessionVariables=transaction_isolation='READ-COMMITTED'",
  "spring.jpa.properties.hibernate.generate_statistics=true"
})
class H7LockRc extends Base06 {

    @Test
    void a_read_committed_下的_OPTIMISTIC() {
        head("6.6.7c READ COMMITTED 下的 LockModeType.OPTIMISTIC");
        seed(1, 1, 0);
        UUID oid = orderIds.get(0);
        System.out.println("   隔離等級 = " + jdbc.queryForObject(
                "SELECT @@transaction_isolation", String.class));

        Throwable err = catching(() -> {
            Ord6 o = em.find(Ord6.class, oid, LockModeType.OPTIMISTIC);
            System.out.println("   A 讀到 status = " + o.getStatus() + " version = " + o.getVersion());
            otherTx(() -> em.find(Ord6.class, oid).cancel());
            System.out.println("   A 在交易裡再讀 version = " + jdbc.queryForObject(
                    "SELECT version FROM orders WHERE id = ?", Long.class,
                    (Object) Uuid7.toBytes(oid)));
        });
        System.out.println("   → " + name(err));
    }

    @Test
    void b_read_committed_下的純讀() {
        head("6.6.7d 對照：READ COMMITTED、不加鎖");
        seed(1, 1, 0);
        UUID oid = orderIds.get(0);
        Throwable err = catching(() -> {
            em.find(Ord6.class, oid);
            otherTx(() -> em.find(Ord6.class, oid).cancel());
        });
        System.out.println("   → " + name(err));
    }
}
```

**實測**：

```
── READ COMMITTED、OPTIMISTIC
   隔離等級 = READ-COMMITTED
   A 讀到 status = PENDING version = 0
   A 在交易裡再讀 version = 1                    ← ★ 這次看得到別人的修改
   → ObjectOptimisticLockingFailureException ← OptimisticEntityLockException

── READ COMMITTED、不加鎖
   → 沒有例外
```

**整理成一張表**：

| 隔離等級 | 不加鎖 | `LockModeType.OPTIMISTIC` |
|---|---|---|
| **`REPEATABLE READ`**（MySQL 預設） | 沒有例外 | 🔴 **沒有例外**（檢查永遠通過） |
| `READ COMMITTED`（Oracle / SQL Server 預設） | 沒有例外 | ✅ `OptimisticEntityLockException` |

> 📌 **這條結論的三個實務後果**：
>
> **① 在 MySQL 預設組態上，`LockModeType.OPTIMISTIC` 是一個【只會產生額外 SQL、
> 不會產生任何保護】的註解。** 它每次讀多打一句 `SELECT version`，然後永遠說「沒問題」。
>
> **② 大部分教學不會提這件事**，因為 JPA 規格是在
> 「`READ COMMITTED` 是常態」的世界裡寫的（Oracle、SQL Server 都是）。
> **MySQL 的 `REPEATABLE READ` 才是那個異類。**
>
> **③ 在 MySQL 上，「我只是讀它，但我的決定依賴它」要用別的做法**：
> ```
> ① 把它從「讀」變成「寫」：讓那個操作也去動聚合根（OPTIMISTIC_FORCE_INCREMENT，6.6.6）
> ② 用悲觀鎖讀：find(…, PESSIMISTIC_READ) —— 鎖定讀【會繞過快照】（6.7.4）
> ③ 整個應用改成 READ COMMITTED（要先確認沒有任何邏輯依賴 REPEATABLE READ）
> ```
>
> ⚠️ 而這件事**跟 03 章 3.3.4 是同一條**：
> 那裡是「一級快取騙你 vs InnoDB 快照騙你」，這裡是
> **「Hibernate 想去問資料庫，而資料庫回的是同一份快照」**。
> **判準也一樣：印出 `@@transaction_isolation`，然後在另一個交易裡讀一次比對。**

### 6.6.8 重試：邊界在交易外

樂觀鎖的完整用法是「衝突 → 重試」。**而重試寫在哪裡，決定它會不會生效。**

```java
package com.example.lab.ch06;

import org.springframework.orm.ObjectOptimisticLockingFailureException;
import org.springframework.stereotype.Component;

import java.util.function.Consumer;

/**
 * 樂觀鎖的重試器。
 *
 * ⚠️ 它為什麼要是【另一個 bean】：
 * 重試的每一次都必須是一個新的交易，而「交易的開始」是 Spring 的代理做的。
 * 把重試迴圈寫在 Stock6Service 自己身上、迴圈裡呼叫自己的 @Transactional 方法
 * ——那是自我呼叫，代理不生效（03 章 3.9.3）。
 */
@Component
public class Retry6 {

    public static class Result {
        public int attempts;
        public boolean gaveUp;
        @Override public String toString() {
            return "嘗試 " + attempts + " 次" + (gaveUp ? "、放棄" : "");
        }
    }

    /** 重試 body，直到成功或用完次數。body 自己必須是一個完整的交易。 */
    public Result run(int maxAttempts, Runnable body) {
        Result r = new Result();
        for (int i = 1; i <= maxAttempts; i++) {
            r.attempts = i;
            try { body.run(); return r; }
            catch (ObjectOptimisticLockingFailureException e) {
                if (i == maxAttempts) { r.gaveUp = true; throw e; }
                // ★ 加一點隨機退避，否則失敗的那些會同時再撞一次
                try { Thread.sleep(1 + (long) (Math.random() * 5)); }
                catch (InterruptedException ignore) { Thread.currentThread().interrupt(); }
            }
        }
        return r;
    }

    public <T> Result run(int maxAttempts, T arg, Consumer<T> body) {
        return run(maxAttempts, () -> body.accept(arg));
    }
}
```

**寫錯的樣子，以及它的症狀**。第一版的實驗程式碼長這樣：

```java
@Service
public class Stock6Service {

    @Transactional
    public void reserveOptimistic(UUID productId, int n) {
        St6 s = em.find(St6.class, productId);
        s.reserve(n);
    }

    /** 🔴 錯的：重試迴圈跟被重試的方法在【同一個 bean】裡 */
    public void reserveWithRetry(UUID productId, int n, int maxAttempts) {
        for (int i = 1; i <= maxAttempts; i++) {
            try { reserveOptimistic(productId, n); return; }        // ← 自我呼叫
            catch (ObjectOptimisticLockingFailureException e) { /* 再試 */ }
        }
    }
}
```

**它跑出來的實測**：

```
   ②′ 樂觀鎖+重試  回報成功 20 / 20 │ 最後 qty=100 reserved=0 version=0 │ 4 ms
                  總嘗試次數 = 20（20 個人，平均 1.0 次）
```

> 🔴🔴 **「20 個人全部成功、平均 1 次就過、只花 4 ms」——
> 而庫存從 100 變成 100，`version` 還是 0。什麼事都沒有發生。**
>
> **機制**（03 章 3.9.3 那個坑）：
> 自我呼叫走的是 `this.reserveOptimistic(...)`，**不經過 Spring 的代理** → 沒有交易。
> 沒有交易的 `em.find()` 會開一個「臨時的」EntityManager 撈出實體，
> 而那個實體**不是 managed 的** → `s.reserve(n)` 改的是一個純 Java 物件 →
> **沒有髒檢查、沒有 UPDATE、也沒有任何錯誤。**
>
> ⚠️ **這個症狀特別惡毒的地方是：它看起來像「重試機制運作得非常好」。**
> **判準：並行實驗的斷言，永遠要寫在「資料庫最後的值」上，不能寫在「成功幾個」上。**
> 6.8 那張表的最後一欄「帳對不對」就是為了這件事。

**正確的形狀**：

```java
    // 呼叫端（另一個 bean，或者 Service 之外的一層）
    retry.run(30, () -> stocks.reserveOptimistic(productId, 1));
    //         ↑ 每一次 run 進去的 body 都是【一次完整的交易】
```

📌 **實務上會用 Spring Retry 而不是自己寫**：

```java
@Retryable(retryFor = ObjectOptimisticLockingFailureException.class,
           maxAttempts = 5, backoff = @Backoff(delay = 20, multiplier = 2, random = true))
@Transactional
public void reserve(UUID productId, int n) { … }
```

⚠️ **而 `@Retryable` 跟 `@Transactional` 標在同一個方法上時，順序很重要**：
`@Retryable` 的代理必須在**外面**（先重試、再開交易），
否則就是「在同一個已經標記為 rollback-only 的交易裡重試」——**每一次都會直接失敗**。
Spring Retry 的 `RetryOperationsInterceptor` 預設的 order 是 `Ordered.LOWEST_PRECEDENCE`，
而 `@Transactional` 也是 —— **兩個都用預設值的時候順序是未定義的**。
**要明確設定**：`@EnableRetry(order = Ordered.HIGHEST_PRECEDENCE)`。

**重試的四條規則**：

```
① 重試的邊界【一定】在交易外面。
② 只重試【樂觀鎖失敗】。不要 catch (Exception) —— 業務例外（庫存不足）重試一百次還是失敗。
③ 要有退避（backoff）而且要隨機。沒有隨機的話，衝突的那幾個會同時再撞一次。
④ 要有次數上限，而且用完之後【要往外拋】。無限重試會把連線池吃光。
```

### 6.6.9 實測：批次 `update` 繞過 `version`

05 章 5.6.3 已經量過這件事，這裡把它跟解法一起放。

```java
    @Test
    void g_批次_update_繞過_version() {
        head("6.6.9 回收 05 章 5.6.3：批次 update 不動 version");
        seed(5, 1, 0);
        showSql("update Ord6 set status = CANCELLED", () -> tx.executeWithoutResult(s ->
                em.createQuery("update Ord6 o set o.status = :st")
                  .setParameter("st", St6Status.CANCELLED).executeUpdate()));
        System.out.println("   版本：" + jdbc.queryForList("SELECT version FROM orders", Long.class));

        showSql("update versioned Ord6 …（HQL 擴充）", () -> tx.executeWithoutResult(s ->
                em.createQuery("update versioned Ord6 o set o.memo = :m")
                  .setParameter("m", "bulk").executeUpdate()));
        System.out.println("   版本：" + jdbc.queryForList("SELECT version FROM orders", Long.class));
    }
```

**實測**：

```
── update Ord6 set status = CANCELLED → 1 句 SQL
   update orders set status=?
   版本：[0, 0, 0, 0, 0]                                  ← 🔴 沒有動

── update versioned Ord6 …（HQL 擴充） → 1 句 SQL
   update orders set memo=?,version=(version+1)          ← ★ version 自己加一
   版本：[1, 1, 1, 1, 1]
```

⚠️ **`update versioned` 是 HQL 的擴充，不是 JPQL 規格**（05 章 5.4.8 那張表的第九項）。
**而它只做「把 version +1」，它不做「檢查 version」**——
批次操作沒有「我讀到的版本」這個東西，所以沒有東西可以檢查。

> 📌 **`update versioned` 的用途是【讓別人的樂觀鎖生效】**：
> 你這句批次改了 5000 列，而某個交易手上正拿著其中一列的舊版本。
> **有 `versioned` → 他提交時會失敗（好事）。**
> **沒有 `versioned` → 他的修改會覆蓋你這次批次的結果（壞事，而且靜默）。**
>
> **所以規則是：只要那張表有 `@Version`，批次 `update` 就一定要寫 `versioned`。**
> 6.10.3 會把這條變成一個可以掃出來的斷言。

### 6.6.10 收掉 00 章事故五：非 JPA 的寫入路徑

```java
    @Test
    void h_旁路寫入不動_version() {
        head("6.6.10 收掉 00 章事故五：JdbcTemplate 寫入不會動 version");
        seed(1, 1, 0);
        UUID oid = orderIds.get(0);
        Ord6 detached = tx.execute(s -> { Ord6 o = em.find(Ord6.class, oid); em.detach(o); return o; });
        System.out.println("   A 手上的 version = " + detached.getVersion());

        jdbc.update("UPDATE orders SET status = 'PAID', paid_at = NOW(3) WHERE id = ?",
                Uuid7.toBytes(oid));
        System.out.println("   B（JdbcTemplate）改完："
                + jdbc.queryForMap("SELECT status, version FROM orders WHERE id = ?",
                        (Object) Uuid7.toBytes(oid)));

        detached.cancel();
        Object err = tx.execute(s -> {
            try { em.merge(detached); em.flush(); return "成功"; }
            catch (RuntimeException e) { return e.getClass().getSimpleName(); }
        });
        System.out.println("   🔴 A 寫回去：" + err);
        System.out.println("   最後 DB：" + jdbc.queryForMap(
                "SELECT status, paid_at, version FROM orders WHERE id = ?", (Object) Uuid7.toBytes(oid)));

        System.out.println("   ── 正確的旁路寫法：自己維護 version ──");
        int rows = jdbc.update(
                "UPDATE orders SET status = 'PAID', version = version + 1 WHERE id = ? AND version = ?",
                Uuid7.toBytes(oid), 99L);
        System.out.println("   用一個過期的 version=99 去改，影響列數 = " + rows + " → 這就是衝突");
    }
```

**實測**：

```
   A 手上的 version = 0
   B（JdbcTemplate）改完：{status=PAID, version=0}
   🔴 A 寫回去：成功
   最後 DB：{status=CANCELLED, paid_at=null, version=1}
   ── 正確的旁路寫法：自己維護 version ──
   用一個過期的 version=99 去改，影響列數 = 0 → 這就是衝突
```

**跟 00 章 0.3.5 那一段實測一字不差。** 三件事同時發生了：

```
① B 的 PAID 不見了 —— 被 A 蓋回 CANCELLED
② paid_at 變回 null —— A 手上那個實體的 paid_at 是 null，而 JPA 寫全部欄位（6.4.1）
③ version 是 1 —— 看起來「有經過樂觀鎖」，實際上它從 0 跳到 1，
   而中間 B 的那次修改完全沒有留下痕跡
```

**旁路寫入的三條規則**：

```sql
-- ① 一定要維護 version
UPDATE orders SET status = 'PAID', paid_at = ?, version = version + 1
 WHERE id = ? AND version = ?;

-- ② 一定要檢查影響列數，0 就是衝突
--    （MyBatis 的 update 回傳 int，JdbcTemplate.update 也是 —— 沒有藉口不看）

-- ③ 🔴 只寫【你真的要改的欄位】。不要用 SELECT * 撈出來再全部寫回去。
```

> ⚠️ **這三條規則的壽命，等於「寫下它的那個人待在團隊的時間」。**
> **所以 00 章 0.9 規則一才是那個真正的答案：同一張表，只讓一個框架寫。**
> **09 章 9.5 會給架構上怎麼落實。**

📌 **而 6.10.3 會給一條 CI 斷言**：
掃出「有 `@Version` 的表」清單，再掃 MyBatis mapper 與 `JdbcTemplate` 的字串，
**任何一句對那些表的 `UPDATE` 沒有 `version = version + 1` 就讓建置失敗。**

### 6.6.11 實測：批次寫入時，樂觀鎖的失敗還抓得到嗎

6.3.12 說 Hibernate 6 改用 `executeBatch()` 的回傳值來檢查。驗證它。

```java
    @Test
    void i_批次裡的樂觀鎖失敗抓得到嗎() {
        head("6.6.11 批次寫入時，樂觀鎖的失敗還抓得到嗎？");
        for (int bs : new int[]{1, 50}) {
            cleanBulk();
            List<UUID> ids = new java.util.ArrayList<>();
            tx.executeWithoutResult(s -> {
                for (int i = 0; i < 10; i++) {
                    UUID id = Uuid7.next(); ids.add(id);
                    em.persist(new BulkVer6(id, "B-" + i, BigDecimal.ONE));
                }
            });

            Throwable err = catching(() -> {
                em.unwrap(org.hibernate.Session.class).setJdbcBatchSize(bs);
                // ★ 順序很重要：先【讀出來】（拿到 version = 0），再讓別人去改
                List<BulkVer6> all = em.createQuery("select b from BulkVer6 b", BulkVer6.class)
                                       .getResultList();
                outside(() -> jdbc.update("UPDATE bulk_ver SET version = 99 WHERE id = ?",
                        Uuid7.toBytes(ids.get(5))));
                all.forEach(b -> b.setCode("Z"));
            });
            long changed = outside(() -> jdbc.queryForObject(
                    "SELECT count(*) FROM bulk_ver WHERE code = 'Z'", Long.class));
            System.out.printf("   batchSize=%-3d → %-58s 真的被改掉 %d / 10 列%n",
                    bs, name(err), changed);
        }
    }
```

**實測**：

```
   batchSize=1   → ObjectOptimisticLockingFailureException ← StaleObjectStateException   真的被改掉 0 / 10 列
   batchSize=50  → ObjectOptimisticLockingFailureException ← StaleStateException          真的被改掉 0 / 10 列
```

而 batch 那一次，log 裡多了一行：

```
HHH100501: Exception executing batch [org.hibernate.StaleStateException:
Batch update returned unexpected row count from update [5]; actual row count: 0; expected: 1;
statement executed: update bulk_ver set amount=?,code=?,version=? where id=? and version=?]
```

> ✅ **抓得到，而且訊息還告訴你是第幾句（`from update [5]`）。**
> **兩者都是 0 / 10 列 —— 整個交易回滾，不會出現「改了一半」。**

⚠️ **兩個例外的名字不一樣**：

| | 例外 | 訊息裡有什麼 |
|---|---|---|
| 逐筆 | `StaleObjectStateException` | **實體型別 + id**（`Ord6#01a07f29-…`） |
| 批次 | `StaleStateException`（父類別） | **批次裡的索引**（`update [5]`），**沒有 id** |

📌 **這是 6.3.8「`batch_size` 不要開太大」的第二個理由**：
`batch_size = 500` 的時候，訊息會說「第 387 句失敗」——
**而你沒有辦法從那個數字回推是哪一筆資料**。
批次大小愈小，出事時的訊息愈有用。

### 6.6.12 樂觀鎖的六條規則

```
① 會被兩個人同時改的表，聚合根上就要有 @Version（型別 long，NOT NULL DEFAULT 0）。
② 永遠不要自己寫 version。
③ 只改集合不會動父的 version → 需要的話用 OPTIMISTIC_FORCE_INCREMENT（6.6.6）。
④ 🔴 LockModeType.OPTIMISTIC 在 MySQL 預設隔離等級下【無效】（6.6.7）。
⑤ 批次 update 要寫 `update versioned`（6.6.9）。
⑥ 🔴 任何非 JPA 的寫入路徑，都要自己 version = version + 1 並檢查影響列數（6.6.10）。
   —— 而更好的答案是「不要有那條路徑」。
```

**它保護得了什麼、保護不了什麼**：

| 情境 | `@Version` 擋得住嗎 |
|---|---|
| 兩個交易讀同一列、各自修改 | ✅ 後提交的那個失敗 |
| detached 實體隔十分鐘 merge 回去 | ✅（6.6.5） |
| 兩個交易各自加一筆明細到同一張訂單 | 🔴 **擋不住**（6.6.6，除非 FORCE_INCREMENT） |
| 「我讀了它、我的決定依賴它」（MySQL） | 🔴 **擋不住**（6.6.7） |
| 有人用 MyBatis 改同一張表 | 🔴 **擋不住**（6.6.10） |
| 一句批次 `update` 改了那一列 | 🔴 **擋不住**（6.6.9，除非 `versioned`） |
| **「不能超賣」這種【跨列的不變量】** | 🔴 **從頭到尾就不是它的工作**（6.8） |

---
## 6.7 悲觀鎖

樂觀鎖的態度是「大家都去做，最後一刻檢查」。
**悲觀鎖的態度相反：先把門鎖起來，其他人排隊。**

### 6.7.1 實測：三種模式各自產生什麼 SQL

```java
    @Test
    void a_三種鎖模式的_SQL() {
        head("6.7.1 三種悲觀鎖模式，各自產生什麼 SQL");
        UUID pid = seedOneStock(100);
        for (LockModeType m : List.of(LockModeType.NONE, LockModeType.PESSIMISTIC_READ,
                LockModeType.PESSIMISTIC_WRITE, LockModeType.PESSIMISTIC_FORCE_INCREMENT)) {
            showSql("find(St6, id, " + m + ")", () -> tx.executeWithoutResult(s ->
                    em.find(St6.class, pid, m)));
        }
        showSql("JPQL + setLockMode(PESSIMISTIC_WRITE)", () -> tx.executeWithoutResult(s ->
                em.createQuery("select s from St6 s", St6.class)
                  .setLockMode(LockModeType.PESSIMISTIC_WRITE).getResultList()));

        seed(2, 1, 1);
        List<String> jf = spy(() -> tx.executeWithoutResult(s ->
                em.createQuery("select o from Ord6 o join fetch o.items", Ord6.class)
                  .setLockMode(LockModeType.PESSIMISTIC_WRITE).getResultList()));
        System.out.println("── 🔴 join fetch + for update → " + jf.size() + " 句 SQL，尾巴是：");
        jf.forEach(q -> System.out.println("   …" + q.substring(Math.max(0, q.length() - 110))));
    }
```

**實測**：

```
── find(St6, id, NONE) → 1 句 SQL
   select s1_0.product_id,s1_0.qty,s1_0.reserved_qty,s1_0.version from stock s1_0 where s1_0.product_id=?
── find(St6, id, PESSIMISTIC_READ) → 1 句 SQL
   select … from stock s1_0 where s1_0.product_id=? for share
── find(St6, id, PESSIMISTIC_WRITE) → 1 句 SQL
   select … from stock s1_0 where s1_0.product_id=? for update
── find(St6, id, PESSIMISTIC_FORCE_INCREMENT) → 2 句 SQL
   select … from stock s1_0 where s1_0.product_id=? for update nowait
   update stock set version=? where product_id=? and version=?
── JPQL + setLockMode(PESSIMISTIC_WRITE) → 1 句 SQL
   select … from stock s1_0 for update                    ← 🔴 沒有 where：整張表都鎖了
── 🔴 join fetch + for update → 1 句 SQL，尾巴是：
   …from orders o1_0 join order_item i1_0 on o1_0.id=i1_0.order_id for update
```

**四種模式的對照**：

| `LockModeType` | MySQL 產生的 SQL | 語義 | 別人能不能讀 | 別人能不能寫 |
|---|---|---|---|---|
| `NONE` | （沒有後綴） | 一致性讀（讀快照） | ✅ | ✅ |
| `PESSIMISTIC_READ` | `for share` | 共享鎖 | ✅（也能 `for share`） | 🔴 要等 |
| `PESSIMISTIC_WRITE` | `for update` | 排他鎖 | ✅ 一般讀可以（讀快照） | 🔴 要等 |
| `PESSIMISTIC_FORCE_INCREMENT` | `for update nowait` **+ `update version`** | 排他鎖 + 版本 +1 | ✅ | 🔴 |

📌 **`PESSIMISTIC_FORCE_INCREMENT` 的 SQL 有兩個驚喜**：

```
① 它自動加了 nowait —— 也就是「搶不到就立刻失敗」，不排隊。
   （這是 Hibernate 6 在 MySQL 方言上的選擇，不是 JPA 規格要求的。）
② 它額外打一句 update version —— 所以它【一定會寫】，
   即使你只是讀。用在唯讀交易上會拋錯（readOnly = true 的 flush mode 是 MANUAL，03 章 3.9.2）。
```

🔴 **兩個容易踩到的地方**：

```
① JPQL + setLockMode 的那一句【沒有 where】→ 它鎖了 stock 這張表的每一列。
   「查詢加鎖」的鎖定範圍等於「查詢掃到的範圍」，而不是「查詢回傳的範圍」。
   （07 站 04 章 4.5 已經處理過這件事：沒有索引的條件會鎖更多。）

② join fetch + for update → for update 套在【兩張表】上。
   你以為在鎖訂單，實際上連 order_item 的列也一起鎖了。
   MySQL 有 `for update of <table>` 可以指定，而 JPA 沒有辦法表達它。
```

### 6.7.2 實測：別人要等多久

```java
    @Test
    void b_鎖住之後別人要等多久() {
        head("6.7.2 A 鎖住那一列，B 要等多久？");
        UUID pid = seedOneStock(100);
        CountDownLatch locked = new CountDownLatch(1);
        CountDownLatch done = new CountDownLatch(1);

        Thread a = new Thread(() -> tx.executeWithoutResult(s -> {
            em.find(St6.class, pid, LockModeType.PESSIMISTIC_WRITE);
            locked.countDown();
            try { done.await(10, TimeUnit.SECONDS); } catch (InterruptedException ignore) {}
        }));
        a.start();
        try { locked.await(5, TimeUnit.SECONDS); } catch (InterruptedException ignore) {}

        long t0 = System.nanoTime();
        Thread b = new Thread(() -> tx.executeWithoutResult(s ->
                em.find(St6.class, pid, LockModeType.PESSIMISTIC_WRITE)));
        b.start();
        try { Thread.sleep(700); } catch (InterruptedException ignore) {}
        System.out.println("   700 ms 後 B 還活著嗎？ " + b.isAlive() + "（true = 還在等鎖）");
        done.countDown();
        try { a.join(5000); b.join(5000); } catch (InterruptedException ignore) {}
        System.out.printf("   A 放掉鎖之後，B 總共等了 %d ms%n", (System.nanoTime() - t0) / 1_000_000);
    }
```

**實測**：

```
   700 ms 後 B 還活著嗎？ true（true = 還在等鎖）
   A 放掉鎖之後，B 總共等了 710 ms
```

> 📌 **B 等的是【A 的整個交易】，不是「A 那句 SQL」。**
> 行鎖在 InnoDB 裡**一直持有到交易結束**（07 站 04 章 4.5）。
>
> **所以悲觀鎖的成本 = 交易有多長。**
> 而 6.9.2 會量到：**交易裡多一件慢的事，會把整個連線池拖垮。**
> **兩者疊起來就是「悲觀鎖 + 長交易」這個組合為什麼是災難。**

### 6.7.3 實測：不想等 —— `NOWAIT` 與 `SKIP LOCKED`

```java
    @Test
    void c_nowait_與_skip_locked() {
        head("6.7.3 不想等：NOWAIT 與 SKIP LOCKED");
        seed(3, 1, 0);
        UUID pid2 = productIds.get(0);
        outside(() -> jdbc.update("UPDATE stock SET qty = 100 WHERE product_id = ?", Uuid7.toBytes(pid2)));

        showSql("timeout = 0（NOWAIT）", () -> tx.executeWithoutResult(s ->
                em.find(St6.class, pid2, LockModeType.PESSIMISTIC_WRITE,
                        Map.of("jakarta.persistence.lock.timeout", 0))));
        showSql("timeout = -2（SKIP LOCKED）", () -> tx.executeWithoutResult(s ->
                em.createQuery("select s from St6 s", St6.class)
                  .setLockMode(LockModeType.PESSIMISTIC_WRITE)
                  .setHint("jakarta.persistence.lock.timeout", -2).getResultList()));
        showSql("timeout = 3000（MySQL 支援等 n 秒嗎？）", () -> tx.executeWithoutResult(s ->
                em.find(St6.class, pid2, LockModeType.PESSIMISTIC_WRITE,
                        Map.of("jakarta.persistence.lock.timeout", 3000))));

        // 真的搶一次
        CountDownLatch locked = new CountDownLatch(1), done = new CountDownLatch(1);
        Thread a = new Thread(() -> tx.executeWithoutResult(s -> {
            em.find(St6.class, pid2, LockModeType.PESSIMISTIC_WRITE);
            locked.countDown();
            try { done.await(10, TimeUnit.SECONDS); } catch (InterruptedException ignore) {}
        }));
        a.start();
        try { locked.await(5, TimeUnit.SECONDS); } catch (InterruptedException ignore) {}

        Throwable nowait = catching(() -> em.find(St6.class, pid2, LockModeType.PESSIMISTIC_WRITE,
                Map.of("jakarta.persistence.lock.timeout", 0)));
        System.out.println("   NOWAIT 搶不到 → " + name(nowait));

        Object skipped = tx.execute(s -> em.createQuery("select s from St6 s", St6.class)
                .setLockMode(LockModeType.PESSIMISTIC_WRITE)
                .setHint("jakarta.persistence.lock.timeout", -2).getResultList().size());
        System.out.println("   SKIP LOCKED 撈到 " + skipped + " 筆（資料庫裡有 "
                + outside(() -> jdbc.queryForObject("SELECT count(*) FROM stock", Integer.class))
                + " 筆，其中 1 筆被鎖住）");
        done.countDown();
        try { a.join(5000); } catch (InterruptedException ignore) {}
    }
```

**實測**：

```
── timeout = 0（NOWAIT） → 1 句 SQL
   select … from stock s1_0 where s1_0.product_id=? for update nowait
── timeout = -2（SKIP LOCKED） → 1 句 SQL
   select … from stock s1_0 for update skip locked
── timeout = 3000（MySQL 支援等 n 秒嗎？） → 1 句 SQL
   select … from stock s1_0 where s1_0.product_id=? for update     ← 🔴 3000 被【靜默忽略】

   NOWAIT 搶不到 → LockTimeoutException ← SQLException
   SKIP LOCKED 撈到 5 筆（資料庫裡有 6 筆，其中 1 筆被鎖住）
```

**`jakarta.persistence.lock.timeout` 的三個值**：

| 值 | 常數 | MySQL 產生的 SQL | 行為 |
|---|---|---|---|
| `0` | `Timeouts.NO_WAIT` | `for update nowait` | 搶不到 → `LockTimeoutException` |
| `-2` | `Timeouts.SKIP_LOCKED` | `for update skip locked` | 搶不到的**跳過**，回傳搶到的 |
| 正整數（毫秒） | — | 🔴 **`for update`（沒有後綴）** | **參數被忽略**，等到 `innodb_lock_wait_timeout` |

> 🔴 **「等 3 秒」在 MySQL 上做不到，而且它不會告訴你。**
> MySQL 沒有 `SELECT … FOR UPDATE WAIT 3` 這個語法（Oracle 有），
> 所以 Hibernate 的 MySQL 方言**直接把那個值丟掉**。
>
> **判準**：任何「我設了一個組態，行為好像沒變」的懷疑，
> **都先把產生的 SQL 印出來看**。這一章已經用這招抓到兩次
> （這裡，以及 6.3.12 那個 `batch_versioned_data`）。

📌 **`SKIP LOCKED` 是「用資料庫當任務佇列」的關鍵**：

```java
// 每一個 worker 撈自己那一批，不會撈到別人正在處理的
@Query("select t from Task t where t.status = 'READY' order by t.createdAt")
@Lock(LockModeType.PESSIMISTIC_WRITE)
@QueryHints(@QueryHint(name = "jakarta.persistence.lock.timeout", value = "-2"))
List<Task> claimBatch(Pageable page);
```

⚠️ **它是「輪詢式任務佇列」的正解，而不是「訊息隊列」的替代品**：
沒有重試策略、沒有死信、沒有訂閱。05 站 06 章那個 outbox 才是完整的做法。

### 6.7.4 ★ 實測：悲觀鎖為什麼在 `REPEATABLE READ` 下有效

6.6.7 那個 `OPTIMISTIC` 的失敗，原因是「重讀命中自己的快照」。
**那悲觀鎖為什麼沒有同一個問題？**

```java
    @Test
    void d_鎖定讀看到的是最新的資料() {
        head("6.7.4 ★ 悲觀鎖為什麼在 REPEATABLE READ 下有效");
        UUID pid = seedOneStock(100);

        tx.executeWithoutResult(s -> {
            System.out.println("   A 先普通讀一次 qty = " + em.find(St6.class, pid).getQty());
            otherTx(() -> em.find(St6.class, pid).reserve(30));       // B 扣 30 並提交
            em.clear();                                                // 清掉一級快取
            System.out.println("   B 提交後，A 普通讀 qty = " + em.find(St6.class, pid).getQty()
                    + "  ← 快照，看不到 B");
            em.clear();
            System.out.println("   A 改成【鎖定讀】qty = "
                    + em.find(St6.class, pid, LockModeType.PESSIMISTIC_WRITE).getQty()
                    + "  ← 🔴 鎖定讀繞過快照，看到最新已提交的值");
        });
    }
```

**實測**：

```
   A 先普通讀一次 qty = 100
   B 提交後，A 普通讀 qty = 100  ← 快照，看不到 B
   A 改成【鎖定讀】qty = 70  ← 🔴 鎖定讀繞過快照，看到最新已提交的值
```

> ★ **這是整個 6.6 / 6.7 的分水嶺**：
>
> ```
> 一般的 SELECT（一致性讀）    → 讀【交易開始時的快照】
> SELECT … FOR UPDATE / SHARE  → 讀【最新已提交的版本】（current read）
> ```
>
> **這是 InnoDB 的規則，不是 JPA 的**——07 站 04 章 4.3.6 把它叫做
> 「**快照讀 vs 當前讀**」，而那一節那個「`SELECT` 說 1000、`UPDATE … balance + 1` 算出 1501」
> 的實測，跟這裡是同一件事。
> 而它解釋了兩件事：
>
> **① 為什麼 `OPTIMISTIC` 在 MySQL 上無效（6.6.7）**：它用的是一般 `SELECT`。
> **② 為什麼悲觀鎖在 MySQL 上有效**：它讀的就是最新的值。
>
> 📌 **所以在 MySQL 上，「我讀了它、我的決定依賴它」的正解是
> `find(…, PESSIMISTIC_READ)`（`for share`），不是 `OPTIMISTIC`。**

⚠️ **而這也是一個非常容易寫錯的組合**：

```java
// 🔴 錯的：先普通讀，再根據那個值做決定，然後才鎖
St6 s = repo.findById(pid).orElseThrow();
if (s.getQty() >= n) {                        // ← 用的是快照的值
    St6 locked = repo.findByIdForUpdate(pid).orElseThrow();
    locked.reserve(n);
}
```

**這段程式碼的 `if` 判斷用的是舊值。** 下一節就是它。

### 6.7.5 🔴 實測：先 `find` 再 `lock`

```java
    @Test
    void e_先_find_再_lock_的破口() {
        head("6.7.5 🔴 先 find 再 lock：手上那份資料還是舊的");
        UUID pid = seedOneStock(100);

        Throwable err = catching(() -> {
            St6 st = em.find(St6.class, pid);                          // 先讀（沒有鎖）
            otherTx(() -> em.find(St6.class, pid).reserve(30));        // 別人扣 30 並提交
            List<String> sqls = spy(() -> em.lock(st, LockModeType.PESSIMISTIC_WRITE));
            System.out.println("   em.lock() 打的 SQL：");
            sqls.forEach(q -> System.out.println("      " + cut(q)));
            System.out.println("   lock 之後手上的 qty = " + st.getQty());
        });
        System.out.println("   → em.lock() 的結果：" + name(err));

        System.out.println("   ── 換成 refresh(…, PESSIMISTIC_WRITE) ──");
        seedOneStock2(pid, 100);
        tx.executeWithoutResult(s -> {
            St6 st = em.find(St6.class, pid);
            otherTx(() -> em.find(St6.class, pid).reserve(30));
            List<String> sqls = spy(() -> em.refresh(st, LockModeType.PESSIMISTIC_WRITE));
            sqls.forEach(q -> System.out.println("      " + cut(q)));
            System.out.println("   ✅ refresh 之後 qty = " + st.getQty());
        });

        System.out.println("   ── 或者一開始就鎖 ──");
        seedOneStock2(pid, 100);
        tx.executeWithoutResult(s -> {
            St6 st = em.find(St6.class, pid, LockModeType.PESSIMISTIC_WRITE);
            System.out.println("   ✅ find(…, PESSIMISTIC_WRITE) 直接讀到 qty = " + st.getQty());
        });
    }
```

**實測**：

```
   → em.lock() 的結果：OptimisticLockException ← StaleObjectStateException

   ── 換成 refresh(…, PESSIMISTIC_WRITE) ──
      select … from stock s1_0 where s1_0.product_id=? for update
   ✅ refresh 之後 qty = 70

   ── 或者一開始就鎖 ──
   ✅ find(…, PESSIMISTIC_WRITE) 直接讀到 qty = 100
```

**三件事**：

```
① em.lock() 【會】檢查版本，而且拋 OptimisticLockException。
   ★ 這是好消息：這個破口不是靜默的（前提是實體有 @Version）。
   ⚠️ 而如果實體【沒有】@Version，em.lock() 就只是加鎖、不檢查
      → 破口變成靜默的。這是 6.6.12 那張表沒有列到的第七格。

② em.lock() 【不會】更新手上那份資料。它只加鎖。
   要拿到最新值，得用 em.refresh(entity, lockMode)。

③ 最乾淨的寫法是【一開始就用對的鎖模式讀】：
   find(…, PESSIMISTIC_WRITE) —— 一句 SQL、資料是最新的、鎖也拿到了。
```

> 📌 **規則：鎖要在【讀之前】決定，不能在讀之後補。**
> 這跟 04 章 4.6.1 那條「不同用例要的關聯不一樣，所以要兩個 repository 方法」
> 是同一個形狀 —— **不同用例要的鎖也不一樣**：
>
> ```java
> public interface St6Repo extends JpaRepository<St6, UUID> {
>
>     // 唯讀路徑：不加鎖
>     // findById(…)
>
>     // 要扣庫存的路徑：一開始就 for update
>     @Lock(LockModeType.PESSIMISTIC_WRITE)
>     @Query("select s from St6 s where s.productId = :id")
>     Optional<St6> findByIdForUpdate(@Param("id") UUID id);
> }
> ```

### 6.7.6 實測：死鎖

```java
    @Test
    void f_死鎖() {
        head("6.7.6 死鎖：兩個交易用相反的順序鎖兩列");
        seed(0, 2, 0);
        UUID p1 = productIds.get(0), p2 = productIds.get(1);
        outside(() -> jdbc.update("UPDATE stock SET qty = 100"));

        List<Object> r = race(2, i -> {
            UUID first = (i == 0) ? p1 : p2, second = (i == 0) ? p2 : p1;
            return tx.execute(s -> {
                em.find(St6.class, first, LockModeType.PESSIMISTIC_WRITE);
                try { Thread.sleep(300); } catch (InterruptedException ignore) {}
                em.find(St6.class, second, LockModeType.PESSIMISTIC_WRITE);
                return "成功";
            });
        });
        System.out.println("   結果：" + tally(r));
        for (Object o : r) if (o instanceof Throwable t)
            System.out.println("   → " + name(t) + " │ " + cut(root(t).getMessage()));
        System.out.println("   MySQL 的鎖等待上限 innodb_lock_wait_timeout = "
                + outside(() -> jdbc.queryForObject("SELECT @@innodb_lock_wait_timeout", Integer.class))
                + " 秒");
    }
```

**實測**：

```
   結果：{OptimisticLockException=1, 成功=1}
   → OptimisticLockException ← MySQLTransactionRollbackException │
     Deadlock found when trying to get lock; try restarting transaction
   MySQL 的鎖等待上限 innodb_lock_wait_timeout = 50 秒
```

> 🔴🔴 **死鎖被包成 `OptimisticLockException`。**
> **一個跟樂觀鎖完全無關的錯誤，用了樂觀鎖的名字。**
>
> **為什麼會這樣**：MySQL 的死鎖錯誤（1213）在 JDBC 那一層是
> `SQLTransactionRollbackException`，而 Hibernate 的例外轉換把
> 「交易被回滾了」對應到 `OptimisticLockException`
> （它的父類別是 `PersistenceException`，而語義上「你的交易被系統回滾了、請重試」
> 確實跟樂觀鎖失敗一樣）。
>
> ⚠️ **實務後果**：
> **你的 `catch (ObjectOptimisticLockingFailureException)` 重試邏輯，
> 會【順便】把死鎖也重試掉。** ——這通常是好事（死鎖就是該重試），
> **但它會讓你的監控裡看不到死鎖**。要區分就得看 cause：
>
> ```java
> catch (ObjectOptimisticLockingFailureException e) {
>     if (root(e) instanceof java.sql.SQLTransactionRollbackException) {
>         log.warn("死鎖，重試", e);          // ← 這個要另外記，它代表鎖順序有問題
>     } else {
>         log.debug("樂觀鎖衝突，重試");       // ← 這個是正常運作
>     }
> }
> ```

**死鎖的四條預防規則**（07 站 04 章 4.6 從資料庫那一側講過，這裡是應用層的做法）：

```
① 🔴 用【固定的順序】鎖多筆資料。
   最常見的做法：按主鍵排序之後再鎖。
       ids.stream().sorted().forEach(id -> repo.findByIdForUpdate(id));
   本節的實驗就是刻意違反這一條。

② 一個交易裡鎖的列數愈少愈好。

③ 交易愈短愈好（6.9.2）。

④ 🔴 innodb_lock_wait_timeout 預設 50 秒 —— 對 HTTP 請求來說太長了。
   ⚠️ 而 MySQL 【偵測到死鎖時會立刻挑一個回滾】，不會等 50 秒
      （上面那個實驗是瞬間就結束的）。
      50 秒等的是【單純的鎖等待】，不是死鎖 —— 6.7.7 就是它。
```

### 6.7.7 實測：等超過 `innodb_lock_wait_timeout`

```java
    @Test
    void g_等超時的例外() {
        head("6.7.7 等超過 innodb_lock_wait_timeout 會發生什麼");
        UUID pid = seedOneStock(100);
        CountDownLatch locked = new CountDownLatch(1), done = new CountDownLatch(1);
        Thread a = new Thread(() -> tx.executeWithoutResult(s -> {
            em.find(St6.class, pid, LockModeType.PESSIMISTIC_WRITE);
            locked.countDown();
            try { done.await(30, TimeUnit.SECONDS); } catch (InterruptedException ignore) {}
        }));
        a.start();
        try { locked.await(5, TimeUnit.SECONDS); } catch (InterruptedException ignore) {}

        long t0 = System.nanoTime();
        var box = new java.util.concurrent.atomic.AtomicReference<Throwable>();
        Thread b = new Thread(() -> box.set(catching(() -> {
            // ★ 一定要 SET SESSION：SET GLOBAL 只影響【之後才建立】的連線，
            //   而連線池裡那些早就開好了（實測 SET GLOBAL 完全沒有效果）
            jdbc.update("SET SESSION innodb_lock_wait_timeout = 2");
            em.find(St6.class, pid, LockModeType.PESSIMISTIC_WRITE);
        })));
        b.start();
        try { b.join(30_000); } catch (InterruptedException ignore) {}
        System.out.printf("   等了 %d ms 之後：%s%n",
                (System.nanoTime() - t0) / 1_000_000, name(box.get()));
        if (box.get() != null) System.out.println("      " + cut(root(box.get()).getMessage()));
        done.countDown();
        try { a.join(5000); } catch (InterruptedException ignore) {}
    }
```

**實測**：

```
   等了 2026 ms 之後：PessimisticLockException ← MySQLTransactionRollbackException
      Lock wait timeout exceeded; try restarting transaction
   預設值 innodb_lock_wait_timeout = 50 秒 —— 🔴 一支 API 卡 50 秒，連線池會先被拖垮
```

⚠️ **那行註解是踩過的坑**：第一版用 `SET GLOBAL innodb_lock_wait_timeout = 2`，
**結果等了 15 秒都沒有超時**。因為 `innodb_lock_wait_timeout` 是
**連線建立時就從全域值複製到 session 的**，而 HikariCP 池子裡那些連線早就開好了。

> 📌 **這條教訓比這個參數本身重要**：
> **「`SET GLOBAL` 之後行為沒變」在有連線池的環境裡是常態，不是異常。**
> 要立刻生效只有兩條路：**`SET SESSION`**，或者**把池子裡的連線全部丟掉重建**。
> （同樣的道理適用於 `transaction_isolation`、`sql_mode`、`time_zone` ——
> 06 站 06 章那 21 根探針裡有幾根就是這樣被誤導的。）

**兩個超時，兩個例外**：

| 情境 | 例外 | 重試有用嗎 |
|---|---|---|
| `NOWAIT` 搶不到 | `LockTimeoutException` | ✅ 有用（別人可能已經放掉了） |
| 等超過 `innodb_lock_wait_timeout` | `PessimisticLockException` | 🟡 有用，但要先問「為什麼會等 50 秒」 |
| 死鎖 | 🔴 `OptimisticLockException`（6.7.6） | ✅ 有用 |

📌 **`innodb_lock_wait_timeout` 該設多少**：
**跟你的 HTTP 超時對齊，而且要比它短。**
一支 API 的超時是 10 秒，那鎖等待設 3～5 秒是合理的 ——
**「快速失敗並回報衝突」比「卡住一條連線 50 秒」好得多**，
因為後者在流量高的時候會讓整個連線池排隊（6.9.2 會量到這件事的規模）。

### 6.7.8 悲觀鎖的五條規則

```
① 鎖要在【讀之前】決定：find(…, PESSIMISTIC_WRITE) 或 @Lock，不要先 find 再 lock（6.7.5）。
② 鎖多筆時用【固定順序】（通常是主鍵排序）（6.7.6）。
③ 鎖住之後的交易要【短】——不要在裡面呼叫外部 API、不要算報表（6.9.2）。
④ 設一個比 HTTP 超時更短的 innodb_lock_wait_timeout（6.7.7）。
⑤ 🔴 「查詢加鎖」的範圍是【查詢掃到的範圍】，不是回傳的範圍（6.7.1）。
```

**樂觀鎖 vs 悲觀鎖**：

| | 樂觀鎖 `@Version` | 悲觀鎖 `for update` |
|---|---|---|
| 誰付成本 | **衝突的那一方**（重試） | **所有人**（排隊） |
| 沒有衝突時的成本 | 幾乎為零 | 一次額外的鎖、以及鎖持有期間別人不能寫 |
| 適合的衝突率 | **低** | **高** |
| 讀到的資料 | 快照（可能舊） | **最新已提交**（6.7.4） |
| 失敗長什麼樣 | 提交時拋例外 | 讀的時候等待 / 超時 |
| 跨交易（使用者編輯十分鐘） | ✅ 唯一的選擇（6.6.5） | 🔴 不可能（不能鎖十分鐘） |
| 在 MySQL 上「只讀但依賴它」 | 🔴 無效（6.6.7） | ✅ `for share` |

---

## 6.8 庫存扣減：四種做法的對照 ★★

01 章 1.13 那張「11 條不變量的新位置」表裡，有一列一直沒有交代：

| # | 不變量 | 誰保證 | 備註 |
|---|---|---|---|
| 4 | 庫存不為負 | ✅ 原子 `UPDATE` | 資料庫（**不能**用 JPA 的髒檢查做，06 章） |

**這一節把那一列做完，而且把「為什麼不能用髒檢查」量出來。**

### 6.8.0 四種做法，寫在同一個 Service 裡

```java
package com.example.lab.ch06;

import jakarta.persistence.EntityManager;
import jakarta.persistence.LockModeType;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.util.UUID;

/**
 * 6.8 的四種庫存扣減做法，寫在同一個類別裡好對照。
 *
 * ⚠️ 交易邊界一定要在【被代理的 public 方法】上：
 * 03 章那個坑（自我呼叫 → 代理不生效 → 根本沒有交易）在這裡會讓四種做法
 * 全部退化成「沒有交易」，而且症狀是「看起來都不會超賣」（因為每句都自動提交）。
 */
@Service
public class Stock6Service {

    private final EntityManager em;

    public Stock6Service(EntityManager em) { this.em = em; }

    /** ① 讀-改-寫，沒有任何鎖，而且實體上沒有 @Version。 */
    @Transactional
    public void reserveNoLock(UUID productId, int n) {
        StNoVer6 s = em.find(StNoVer6.class, productId);
        s.reserve(n);
    }

    /** ② 樂觀鎖：靠 @Version，衝突時拋例外。 */
    @Transactional
    public void reserveOptimistic(UUID productId, int n) {
        St6 s = em.find(St6.class, productId);
        s.reserve(n);
    }

    /** ③ 悲觀鎖：SELECT … FOR UPDATE，其他交易排隊。 */
    @Transactional
    public void reservePessimistic(UUID productId, int n) {
        St6 s = em.find(St6.class, productId, LockModeType.PESSIMISTIC_WRITE);
        s.reserve(n);
    }

    /** ④ 一句原子 UPDATE：條件寫在 WHERE 裡，靠影響列數判斷成功或失敗。 */
    @Transactional
    public boolean reserveAtomic(UUID productId, int n) {
        int rows = em.createQuery("""
                    update St6 s
                       set s.qty = s.qty - :n, s.reservedQty = s.reservedQty + :n,
                           s.version = s.version + 1
                     where s.productId = :id and s.qty >= :n
                    """)
                .setParameter("n", n).setParameter("id", productId)
                .executeUpdate();
        return rows == 1;
    }

    /**
     * ②a 樂觀鎖，但【讀到寫之間停一下】。
     * 這一段時間就是樂觀鎖的「衝突窗口」——6.8.3 要量它有多要緊。
     */
    @Transactional
    public void reserveOptimisticSlow(UUID productId, int n, long holdMs) {
        St6 s = em.find(St6.class, productId);
        try { Thread.sleep(holdMs); } catch (InterruptedException ignore) {}
        s.reserve(n);
    }

    /** ③a 悲觀鎖，同樣停一下（對照組：它不會衝突，只會排隊）。 */
    @Transactional
    public void reservePessimisticSlow(UUID productId, int n, long holdMs) {
        St6 s = em.find(St6.class, productId, LockModeType.PESSIMISTIC_WRITE);
        try { Thread.sleep(holdMs); } catch (InterruptedException ignore) {}
        s.reserve(n);
    }

    /** 讀出目前庫存（獨立交易，不受呼叫端的持久化情境影響）。 */
    @Transactional(propagation = Propagation.REQUIRES_NEW, readOnly = true)
    public int qtyNow(UUID productId) {
        em.clear();
        return em.find(St6.class, productId).getQty();
    }
}
```

**斷言的形狀（這一節最重要的設計）**：

```java
    private void report(String name, int threads, int qty0, List<Object> r, long ms) {
        var row = outside(() -> jdbc.queryForMap(
                "SELECT qty, reserved_qty, version FROM stock WHERE product_id = ?",
                (Object) Uuid7.toBytes(productIds.get(0))));
        long ok = r.stream().filter(o -> !(o instanceof Throwable)).count();
        int qty = ((Number) row.get("qty")).intValue();
        int taken = qty0 - qty;
        // ★ 唯一有意義的斷言：【回報成功的筆數】要等於【實際扣掉的件數】，而且不能是負庫存
        boolean sound = (ok == taken) && qty >= 0;
        System.out.printf("   %-16s 回報成功 %2d / %-2d │ 實際扣掉 %2d 件 │ "
                        + "最後 qty=%-3d reserved=%-3d version=%-3s │ %4d ms  %s%n",
                name, ok, threads, taken, qty, row.get("reserved_qty"), row.get("version"), ms,
                sound ? "✅" : "🔴 帳不對");
        System.out.println("                    " + tally(r));
    }
```

> 📌 **為什麼斷言要寫成「成功筆數 == 實際扣掉的件數」**：
> 並行實驗每次跑的數字都不一樣（誰先誰後是隨機的），
> **所以「成功了幾個」不能當斷言**。
> 而「**我告訴了幾個人成功，就要真的扣掉幾件**」這條**跟排程無關**，
> 它在任何一次執行裡都必須成立。
>
> **6.6.8 那個「重試寫在同一個 bean 裡」的坑，就是被這條斷言抓出來的**——
> 那一版顯示「20 個全部成功」，而實際扣掉 0 件。

### 6.8.1 實測：20 個人搶 10 件

```java
    @Test
    void a_二十個人搶十件() {
        head("6.8.1 20 個執行緒各扣 1 件，庫存只有 10 件");
        int T = 20, Q = 10;

        UUID p1 = reset(Q);
        long t1 = System.nanoTime();
        List<Object> r1 = race(T, i -> { stocks.reserveNoLock(p1, 1); return "ok"; });
        report("① 無鎖", T, Q, r1, (System.nanoTime() - t1) / 1_000_000);

        UUID p2 = reset(Q);
        long t2 = System.nanoTime();
        List<Object> r2 = race(T, i -> { stocks.reserveOptimistic(p2, 1); return "ok"; });
        report("② 樂觀鎖", T, Q, r2, (System.nanoTime() - t2) / 1_000_000);

        UUID p3 = reset(Q);
        long t3 = System.nanoTime();
        List<Object> r3 = race(T, i -> { stocks.reservePessimistic(p3, 1); return "ok"; });
        report("③ 悲觀鎖", T, Q, r3, (System.nanoTime() - t3) / 1_000_000);

        UUID p4 = reset(Q);
        long t4 = System.nanoTime();
        List<Object> r4 = race(T, i -> {
            if (!stocks.reserveAtomic(p4, 1)) throw new IllegalStateException("庫存不足");
            return "ok";
        });
        report("④ 原子 UPDATE", T, Q, r4, (System.nanoTime() - t4) / 1_000_000);
    }

    private UUID reset(int qty) {
        UUID pid = productIds.isEmpty() ? seedOneStock(qty) : productIds.get(0);
        outside(() -> jdbc.update(
                "UPDATE stock SET qty = ?, reserved_qty = 0, version = 0 WHERE product_id = ?",
                qty, Uuid7.toBytes(pid)));
        return pid;
    }
```

**實測**：

```
   ① 無鎖             回報成功 20 / 20 │ 實際扣掉  2 件 │ 最後 qty=8   reserved=2   version=0   │  16 ms  🔴 帳不對
                    {成功=20}
   ② 樂觀鎖            回報成功  2 / 20 │ 實際扣掉  2 件 │ 最後 qty=8   reserved=2   version=2   │  17 ms  ✅
                    {成功=2, ObjectOptimisticLockingFailureException=18}
   ③ 悲觀鎖            回報成功 10 / 20 │ 實際扣掉 10 件 │ 最後 qty=0   reserved=10  version=10  │  25 ms  ✅
                    {成功=10, IllegalStateException=10}
   ④ 原子 UPDATE      回報成功 10 / 20 │ 實際扣掉 10 件 │ 最後 qty=0   reserved=10  version=10  │  19 ms  🔴→✅
                    {成功=10, IllegalStateException=10}
```

**逐列讀**：

**① 無鎖 —— 這是超賣。**

```
20 個人被告知「訂單成立」，而庫存只扣掉 2 件。
18 個人的訂單【沒有對應的庫存】。
而 qty + reserved = 10 —— 帳面上「看起來」是平的，
所以你在資料庫裡【看不出來】出了事。
```

⚠️ 注意 `version=0`：`StNoVer6` 連 version 欄位都不映射，所以那一欄完全沒動——
**這正是 6.6.10 那個「旁路寫入」的形狀，只是這裡的旁路是「一個沒有 `@Version` 的映射」**。

**② 樂觀鎖 —— 正確，但只有 2 個人成功。**

```
帳是對的（回報 2、扣掉 2）。
而 18 個人拿到的是【技術性的例外】，不是「庫存不足」——
   對使用者要說「系統忙碌，請重試」，而不是「賣完了」。
   兩者的差別在 6.8.6 那張表。
```

**③ 悲觀鎖 —— 完全正確。**

```
10 個成功、10 個拿到 IllegalStateException（庫存不足，我們的領域例外）。
每一個人都被【正確地】告知結果。
```

**④ 原子 `UPDATE` —— 也完全正確，而且最快。**

```
10 個成功、10 個影響 0 列 → 我們自己拋庫存不足。
```

### 6.8.2 實測：庫存夠的時候誰快

```java
    @Test
    void b_庫存夠的時候誰快() {
        head("6.8.2 庫存足夠（100 件、20 個人各扣 1）：只比效能與正確性");
        int T = 20, Q = 100;

        UUID p2 = reset(Q);
        long t2 = System.nanoTime();
        List<Object> r2 = race(T, i -> { stocks.reserveOptimistic(p2, 1); return "ok"; });
        report("② 樂觀鎖", T, Q, r2, (System.nanoTime() - t2) / 1_000_000);

        UUID p2b = reset(Q);
        var att = new java.util.concurrent.atomic.AtomicInteger();
        long t2b = System.nanoTime();
        List<Object> r2b = race(T, i ->
                att.addAndGet(retry.run(30, () -> stocks.reserveOptimistic(p2b, 1)).attempts));
        report("②′ 樂觀鎖+重試", T, Q, r2b, (System.nanoTime() - t2b) / 1_000_000);
        System.out.printf("                    總嘗試次數 = %d（%d 個人，平均 %.1f 次）%n",
                att.get(), T, att.get() / (double) T);

        UUID p3 = reset(Q);
        long t3 = System.nanoTime();
        List<Object> r3 = race(T, i -> { stocks.reservePessimistic(p3, 1); return "ok"; });
        report("③ 悲觀鎖", T, Q, r3, (System.nanoTime() - t3) / 1_000_000);

        UUID p4 = reset(Q);
        long t4 = System.nanoTime();
        List<Object> r4 = race(T, i -> { stocks.reserveAtomic(p4, 1); return "ok"; });
        report("④ 原子 UPDATE", T, Q, r4, (System.nanoTime() - t4) / 1_000_000);
    }
```

**實測**：

```
   ② 樂觀鎖            回報成功  2 / 20 │ 實際扣掉  2 件 │ 最後 qty=98  reserved=2   version=2   │  31 ms  ✅
                    {ObjectOptimisticLockingFailureException=18, 成功=2}
   ②′ 樂觀鎖+重試        回報成功 20 / 20 │ 實際扣掉 20 件 │ 最後 qty=80  reserved=20  version=20  │ 119 ms  ✅
                    {成功=20}
                    總嘗試次數 = 120（20 個人，平均 6.0 次）
   ③ 悲觀鎖            回報成功 20 / 20 │ 實際扣掉 20 件 │ 最後 qty=80  reserved=20  version=20  │  36 ms  ✅
                    {成功=20}
   ④ 原子 UPDATE      回報成功 20 / 20 │ 實際扣掉 20 件 │ 最後 qty=80  reserved=20  version=20  │  37 ms  ✅
```

> 🔴 **② 那一列是關鍵**：庫存有 100 件、只有 20 個人各要 1 件 ——
> **完全不缺貨，而樂觀鎖還是讓 18 個人失敗。**
>
> **樂觀鎖的失敗率跟「庫存夠不夠」無關，只跟「同時有幾個人碰同一列」有關。**

**②′ 加上重試就對了，代價是**：

```
平均每個人要試 6 次        ← 6 倍的資料庫往返
119 ms  vs  悲觀鎖 36 ms   ← 3.3 倍慢
```

> 📌 **這就是「熱點單列」上樂觀鎖的極限**。
> 而它跟 6.8.1 的 ② 合起來說明了一件事：
> **樂觀鎖不是「比較輕量的鎖」，它是「假設不會衝突的鎖」。**
> **假設錯了的時候，它比悲觀鎖貴得多。**

### 6.8.3 ★ 實測：衝突窗口有多長，決定樂觀鎖能不能用

```java
    @Test
    void c_衝突變激烈() {
        head("6.8.3 ★ 衝突窗口有多長，決定樂觀鎖能不能用");
        int T = 20, Q = 1000;
        for (long hold : new long[]{0, 5, 50}) {
            UUID p = reset(Q);
            long t = System.nanoTime();
            List<Object> r = race(T, i -> { stocks.reserveOptimisticSlow(p, 1, hold); return "ok"; });
            long ms = (System.nanoTime() - t) / 1_000_000;
            long ok = r.stream().filter(o -> !(o instanceof Throwable)).count();
            System.out.printf("   讀到寫之間停 %2d ms │ 樂觀鎖     成功 %2d / %d、%4d ms  %s%n",
                    hold, ok, T, ms, tally(r));

            UUID p2 = reset(Q);
            var att = new java.util.concurrent.atomic.AtomicInteger();
            long t2 = System.nanoTime();
            List<Object> r2 = race(T, i -> att.addAndGet(
                    retry.run(100, () -> stocks.reserveOptimisticSlow(p2, 1, hold)).attempts));
            long ms2 = (System.nanoTime() - t2) / 1_000_000;
            long taken2 = outside(() -> Q - jdbc.queryForObject(
                    "SELECT qty FROM stock WHERE product_id = ?", Integer.class,
                    (Object) Uuid7.toBytes(p2)));
            System.out.printf("                     │ 樂觀+重試 成功 %2d / %d（實際扣 %d）、%4d ms、"
                            + "總嘗試 %d 次（平均 %.1f）%n",
                    r2.stream().filter(o -> !(o instanceof Throwable)).count(), T, taken2, ms2,
                    att.get(), att.get() / (double) T);

            UUID p3 = reset(Q);
            long t3 = System.nanoTime();
            List<Object> r3 = race(T, i -> { stocks.reservePessimisticSlow(p3, 1, hold); return "ok"; });
            System.out.printf("                     │ 悲觀鎖     成功 %2d / %d、%4d ms%n%n",
                    r3.stream().filter(o -> !(o instanceof Throwable)).count(), T,
                    (System.nanoTime() - t3) / 1_000_000);
        }
    }
```

**實測**：

```
   讀到寫之間停  0 ms │ 樂觀鎖     成功  3 / 20、  74 ms  {ObjectOptimisticLockingFailureException=17, 成功=3}
                     │ 樂觀+重試 成功 20 / 20（實際扣 20）、 115 ms、總嘗試 108 次（平均 5.4）
                     │ 悲觀鎖     成功 20 / 20、  53 ms

   讀到寫之間停  5 ms │ 樂觀鎖     成功  2 / 20、  31 ms
                     │ 樂觀+重試 成功 20 / 20（實際扣 20）、 269 ms、總嘗試 147 次（平均 7.4）
                     │ 悲觀鎖     成功 20 / 20、 156 ms

   讀到寫之間停 50 ms │ 樂觀鎖     成功  2 / 20、 120 ms
                     │ 樂觀+重試 成功 20 / 20（實際扣 20）、1274 ms、總嘗試 155 次（平均 7.8）
                     │ 悲觀鎖     成功 20 / 20、1168 ms
```

**兩條曲線，形狀不一樣**：

```
悲觀鎖：       53 → 156 → 1168 ms      ← 【線性】：20 人 × 50 ms = 1000 ms，對得上
                                          它把所有人排成一列，總時間 = 人數 × 每個人的時間

樂觀+重試：   115 → 269 → 1274 ms      ← 也變慢，而且【總嘗試次數也在增加】（5.4 → 7.8）
                                          它付兩份錢：排隊的時間 + 白做的次數
```

> ★ **這一格是 6.8 最重要的結論**：
>
> **「讀到寫之間那段時間」（衝突窗口）決定一切。**
>
> ```
> 窗口很短（一句 SQL 之內）  → 樂觀鎖與悲觀鎖差不多，選哪個都行
> 窗口很長（中間有計算、有外部呼叫）→ 兩個都會爛掉，而樂觀鎖爛得更快
> ```
>
> **而「窗口」是你寫的程式碼決定的，不是框架決定的。**
> `reserveOptimisticSlow` 裡那個 `Thread.sleep(50)`，在真實系統裡叫做
> **「順便呼叫一下風控 API」、「順便算一下優惠」、「順便寫一筆 log 到 ES」**。
>
> 📌 **所以第一個問題永遠是「這個交易裡有沒有不該在裡面的東西」**，
> 而不是「該用樂觀鎖還是悲觀鎖」。6.9.2 會把這件事量到連線池上。

### 6.8.4 🔴 實測：原子 `UPDATE` 的代價

④ 看起來全面勝出。**它的代價在別的地方。**

```java
    @Test
    void d_原子_update_的代價() {
        head("6.8.4 原子 UPDATE 的代價：持久化情境不知道它做了什麼");
        UUID pid = reset(100);
        tx.executeWithoutResult(s -> {
            St6 st = em.find(St6.class, pid);
            System.out.println("   PC 裡的 qty = " + st.getQty() + " version = " + st.getVersion());
            em.createQuery("update St6 x set x.qty = x.qty - 5 where x.productId = :id")
              .setParameter("id", pid).executeUpdate();
            System.out.println("   一句 update 之後，PC 裡的 qty 還是 " + st.getQty()
                    + " 🔴（05 章 5.6.2 的形狀）");
            em.refresh(st);
            System.out.println("   refresh 之後 = " + st.getQty());
        });
        System.out.println("   而且它【沒有經過領域規則】——庫存不為負是誰保證的？");
        Throwable err = catching(() -> em.createQuery(
                "update St6 x set x.qty = x.qty - 500 where x.productId = :id")
                .setParameter("id", pid).executeUpdate());
        System.out.println("   扣 500（庫存只有 95）→ " + name(err));
        System.out.println("   DB：" + outside(() -> jdbc.queryForMap(
                "SELECT qty FROM stock WHERE product_id = ?", (Object) Uuid7.toBytes(pid))));
    }
```

**實測**：

```
   PC 裡的 qty = 100 version = 0
   一句 update 之後，PC 裡的 qty 還是 100 🔴（05 章 5.6.2 的形狀）
   refresh 之後 = 95
   而且它【沒有經過領域規則】——庫存不為負是誰保證的？
   扣 500（庫存只有 95）→ 沒有例外
   DB：{qty=-405}
```

> 🔴🔴 **`qty = -405`。**
> **`St6.reserve()` 那個 `if (qty - n < 0) throw` 完全沒有被執行。**

**兩個代價，都在 05 章 5.6 講過，這裡是它們在這個具體場景的樣子**：

```
① 持久化情境裡的值變成錯的（05 章 5.6.2）
   → 修法：@Modifying(clearAutomatically = true)，或者手動 em.refresh()
   → ⚠️ 而 6.9.3 會證明 clearAutomatically 有一個危險的副作用

② 🔴 它繞過領域模型
   → 「庫存不為負」這條不變量，寫在 St6.reserve() 裡是【沒有用的】，
     因為原子 UPDATE 根本不呼叫那個方法。
   → 修法：把條件寫進 WHERE（6.8.5），而且【只留這一條路】
```

📌 **這就是 01 章 1.13 那張表為什麼把「庫存不為負」標成「資料庫保證」的原因**：

```
不變量寫在哪裡，決定了「有幾條路可以違反它」。

寫在 St6.reserve() 裡：      只有走 JPA 髒檢查的路徑會檢查它
寫在 UPDATE 的 WHERE 裡：    只有這一句 UPDATE 會檢查它
寫在資料庫的 CHECK 約束裡：   ✅ 【每一條路】都會檢查它
```

**所以正解是兩層都有**：

```sql
ALTER TABLE stock ADD CONSTRAINT ck_stock_qty CHECK (qty >= 0);
```

```
WHERE qty >= :n     ← 讓失敗變成「影響 0 列」，可以優雅回報
CHECK (qty >= 0)    ← 讓任何漏掉那個 WHERE 的路徑【硬性失敗】
```

⚠️ **01 章 1.12 那條「三層檢查」在這裡完整出現**：
`@Column` / Bean Validation 這一層對「跨列的不變量」完全無能為力
（它只看得到單一欄位的值），**所以第三層（資料庫約束）在這裡不是備援，是主力**。

### 6.8.5 實測：條件寫在 `WHERE` 裡

```java
    @Test
    void e_WHERE_裡的條件才是保證() {
        head("6.8.5 條件寫在 WHERE 裡：不足就是 0 列");
        UUID pid = reset(3);
        System.out.println("   庫存 3 件，連續扣 4 次 1 件：");
        for (int i = 1; i <= 4; i++) {
            boolean ok = stocks.reserveAtomic(pid, 1);
            System.out.printf("      第 %d 次：%s（DB qty = %s）%n", i, ok ? "✅ 成功" : "🔴 影響 0 列",
                    outside(() -> jdbc.queryForObject("SELECT qty FROM stock WHERE product_id = ?",
                            Integer.class, (Object) Uuid7.toBytes(pid))));
        }
        System.out.println("   最後：" + outside(() -> jdbc.queryForMap(
                "SELECT qty, reserved_qty, version FROM stock WHERE product_id = ?",
                (Object) Uuid7.toBytes(pid))));
    }
```

**實測**：

```
   庫存 3 件，連續扣 4 次 1 件：
      第 1 次：✅ 成功（DB qty = 2）
      第 2 次：✅ 成功（DB qty = 1）
      第 3 次：✅ 成功（DB qty = 0）
      第 4 次：🔴 影響 0 列（DB qty = 0）
   最後：{qty=0, reserved_qty=3, version=3}
```

**這句 SQL 的四個設計決定**：

```sql
UPDATE stock
   SET qty          = qty - :n,          -- ① 用【相對值】，不用絕對值
       reserved_qty = reserved_qty + :n,
       version      = version + 1        -- ③ 自己維護 version（6.6.10）
 WHERE product_id = :id
   AND qty >= :n;                        -- ② 條件寫在 WHERE 裡
--                                       -- ④ 靠影響列數判斷成敗
```

```
① qty = qty - :n 而不是 qty = 95
   → 不需要先讀，也就沒有「讀到寫之間」那個窗口（6.8.3）。窗口長度是【零】。

② AND qty >= :n
   → 「檢查」與「修改」在同一句 SQL 裡，資料庫保證它是原子的。

③ version = version + 1
   → 讓【別人】手上的樂觀鎖生效（6.6.9 的 `update versioned` 是同一件事）。

④ rows == 0 → 庫存不足
   → ⚠️ 而 rows == 0 也可能是「商品不存在」。要分開回報（6.11.1 會處理）。
```

> ★ **這句 SQL 為什麼快、也為什麼正確，是【同一個原因】**：
> **它沒有「讀到寫之間」那段時間。**
>
> ```
> ① 無鎖：      讀 → （窗口） → 寫             🔴 窗口裡別人改了 → 超賣
> ② 樂觀鎖：    讀 → （窗口） → 寫 + 檢查      ✅ 正確，但窗口愈長失敗愈多
> ③ 悲觀鎖：    讀 + 鎖 → （窗口） → 寫        ✅ 正確，但窗口裡別人全部在等
> ④ 原子 UPDATE：            寫 + 檢查         ✅ 沒有窗口
> ```

### 6.8.6 四種做法的決策表

| | ① 無鎖 | ② 樂觀鎖 | ③ 悲觀鎖 | ④ 原子 `UPDATE` |
|---|---|---|---|---|
| 20 人搶 10 件的結果 | 🔴 **超賣 18 筆** | ✅ 2 成功 | ✅ 10 成功 | ✅ 10 成功 |
| 100 件、20 人（不缺貨） | 🔴 超賣 | 🔴 **只有 2 個成功** | ✅ 20 / 36 ms | ✅ 20 / 37 ms |
| 加上重試之後 | — | ✅ 20 / 119 ms（平均試 6 次） | — | — |
| 衝突窗口 50 ms 時 | 🔴 | 1274 ms | 1168 ms | 不受影響 |
| 失敗時能不能說「賣完了」 | — | 🔴 **不能**（它只知道「有人先改了」） | ✅ 能 | ✅ 能 |
| 走不走領域模型 | ✅ | ✅ | ✅ | 🔴 **不走** |
| 持久化情境正確嗎 | ✅ | ✅ | ✅ | 🔴 要 `refresh` / `clear` |
| 需要 `@Version` | 🔴 沒有 | ✅ 必須 | 不需要 | 自己維護 |

**決策**：

```
這個操作是「把某個數量加減一個相對值，而且有下界」嗎？
（庫存、餘額、額度、票數、剩餘名額）
   │
   ├─ 是 ──→ ④ 原子 UPDATE
   │         ＋ 資料庫的 CHECK 約束（6.8.4）
   │         ＋ rows == 0 要分辨「不存在」與「不足」
   │
   └─ 否（要讀出整個物件、跑一段邏輯、再寫回去）
        │
        ├─ 這一列會被【很多人同時】改嗎？（熱點）
        │    ├─ 是 ──→ ③ 悲觀鎖（find(…, PESSIMISTIC_WRITE)）
        │    │          ＋ 交易要短（6.7.8）
        │    └─ 否 ──→ ② 樂觀鎖 @Version ＋ 重試（6.6.8）
        │
        └─ 使用者會「打開表單、十分鐘後儲存」嗎？
             └─ 是 ──→ ② 樂觀鎖（唯一的選擇，6.6.5）
```

⚠️ **④ 有一個常見的誤用**：

```java
// 🔴 錯的：把整段業務邏輯都塞進一句 update
em.createQuery("""
    update Ord6 o set o.status = 'PAID', o.paidAt = :now
     where o.id = :id and o.status = 'PENDING'
    """)…
```

看起來很聰明（原子、一句 SQL、條件在 `WHERE`），**而它繞過了 `Order.pay()` 裡的所有規則**——
而付款這件事的規則以後一定會變多（要不要記錄付款方式、要不要發事件、要不要檢查金額）。

> 📌 **判準**：
> **④ 只用在「不變量是一個數值的上下界」這種情況。**
> **一旦邏輯裡有第二個 `if`，就回去用 ② 或 ③。**
>
> **理由**：④ 把不變量從 Java 移到 SQL 的 `WHERE` 裡。
> 一個條件搬得過去，五個條件搬過去就變成一句沒有人看得懂的 SQL，
> 而那正是 06 站 03 章 3.5 講「領域模型該放哪」時要避免的東西。

---
## 6.9 交易的另一個成本：它抓著一條連線

前面八節都在講「交易裡發生了什麼」。**這一節講「交易存在的時候，別人在做什麼」。**

### 6.9.1 實測：`readOnly = true` 到底送了什麼

03 章 3.9.2 量過 `@Transactional(readOnly = true)` 在 **Hibernate 那一側**做的事
（`setDefaultReadOnly(true)`、flush mode 變 `MANUAL`、實體是 `READ_ONLY` 狀態、連快照都不建）。
**它在資料庫那一側做什麼？**

```java
    @Test
    void a_readOnly_到底送了什麼() {
        head("6.9.1 @Transactional(readOnly = true) 對資料庫送了什麼？");
        seed(1, 1, 0);
        UUID oid = orderIds.get(0);

        TransactionTemplate ro = new TransactionTemplate(tx.getTransactionManager());
        ro.setReadOnly(true);
        withGeneralLog("readOnly = true 的交易", () ->
                ro.executeWithoutResult(s -> em.find(Ord6.class, oid)));
        withGeneralLog("readOnly = false 的交易", () ->
                tx.executeWithoutResult(s -> em.find(Ord6.class, oid)));
    }
```

**實測**：

```
── readOnly = true 的交易 → 伺服器收到 7 筆
   set session transaction read only          ← ★ 多這一句
   SET autocommit=0
   select o1_0.id,…,o1_0.version from orders o1_0 where o1_0.id=?
   commit
   SET autocommit=1
   set session transaction read write         ← ★ 還原，又一句

── readOnly = false 的交易 → 伺服器收到 5 筆
   SET autocommit=0
   select o1_0.id,…,o1_0.version from orders o1_0 where o1_0.id=?
   commit
   SET autocommit=1
```

**`readOnly = true` 多了兩次網路來回。**

> 📌 **那它值得嗎？值得，而且理由跟效能無關**：
>
> ```
> ① 它讓「這個方法不會寫資料」變成一個【資料庫層面的保證】，而不是一個註解上的宣告。
>    在 readOnly 交易裡執行 UPDATE，MySQL 會直接拒絕。
> ② Hibernate 那一側省掉的東西是真的（不建快照、髒檢查不跑）——
>    05 章 5.8.6 量到「同一頁 150 個實體 4 ms」，那 4 ms 裡有一部分是快照。
> ③ 讀寫分離的架構下，它是【路由到 replica】的判斷依據。
> ```
>
> ⚠️ **而它有一個代價，03 章 3.9.2 講過**：
> **在 readOnly 交易裡改實體是【靜默失效】的**（flush mode 是 `MANUAL`）。
> 所以「順手在查詢方法裡改個欄位」這種事，在 readOnly 交易裡不會報錯、也不會生效。

### 6.9.2 實測：交易裡多做一件慢的事

```java
    @Test
    void b_連線被抓著多久() {
        head("6.9.2 交易裡多做一件慢的事，會怎麼影響別人");
        seed(1, 1, 0);
        UUID oid = orderIds.get(0);
        int pool = 10;    // application.yml 的 maximum-pool-size

        long slowInside = time(() -> race(20, i -> tx.execute(s -> {
            Ord6 o = em.find(Ord6.class, oid);
            sleep(100);                                   // 假裝呼叫一支外部 API
            return o.getStatus();
        })));
        System.out.printf("   ① 慢的事【在交易裡】 20 個請求共 %4d ms（連線池 %d 條）%n", slowInside, pool);

        long slowOutside = time(() -> race(20, i -> {
            Object st = tx.execute(s -> em.find(Ord6.class, oid).getStatus());
            sleep(100);                                   // 交易已經結束、連線已經還回去
            return st;
        }));
        System.out.printf("   ② 慢的事【在交易外】 20 個請求共 %4d ms%n", slowOutside);
        System.out.printf("   → 差 %.1f 倍。20 × 100 ms ÷ %d 條連線 ≈ %d ms，跟 ① 對得上%n",
                slowInside / (double) slowOutside, pool, 20 * 100 / pool);
    }

    private static long time(Runnable r) {
        long t0 = System.nanoTime(); r.run(); return (System.nanoTime() - t0) / 1_000_000;
    }
    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException ignore) {}
    }
```

**實測**：

```
   ① 慢的事【在交易裡】 20 個請求共  254 ms（連線池 10 條）
   ② 慢的事【在交易外】 20 個請求共  116 ms
   → 差 2.2 倍。20 × 100 ms ÷ 10 條連線 ≈ 200 ms，跟 ① 對得上
```

**算式**：

```
① 每一個請求抓著連線 100 ms，池子只有 10 條
   → 20 個請求要分兩批 → 200 ms（實測 254，多的是啟動與排程）
   ★ 而且【池子被塞滿的那段時間，其他任何需要資料庫的請求都在排隊】

② 每一個請求抓著連線大約 1 ms，那 100 ms 花在池子外面
   → 20 個請求幾乎同時完成 → 116 ms（就是那一次 sleep 的時間）
```

> 📌 **這是「交易邊界」除了正確性以外的第二個理由，而且它更容易被忽略**：
>
> ```
> 交易 = 一條資料庫連線的租約。
> 連線池的大小是【並行度的上限】。
> 交易裡每多一毫秒，那個上限就少一點。
> ```
>
> **而連線池的大小不能靠調大解決**：連線在資料庫那一側也是資源
> （每一條連線在 MySQL 上是一個執行緒），`maximum-pool-size` 開到 200
> 通常會讓資料庫更慢，而不是更快。

⚠️ **這一條跟 04 章 4.4.2 那個 `open-in-view` 的討論是同一件事的兩半**：

```
04 章 4.4.2 的結論：open-in-view = false 的真正理由是【可觀測性】
                    （SQL 出現在你看得到的地方）

本節補上第二個理由：open-in-view = true 會讓連線【一直持有到 View 渲染完】
                    —— 而那段時間包含 Jackson 序列化、模板渲染、
                       甚至（如果有人不小心）呼叫外部 API。
```

**四條規則**：

```
① 交易裡不要呼叫外部 API、不要發訊息、不要寫檔案。
   要做的話：交易裡寫一筆 outbox 記錄，交易外（或另一個排程）去做（05 站 06 章 6.8）。
② 交易裡不要算報表、不要跑迴圈裡的 I/O。
③ open-in-view = false（04 章 4.4.2、本節）。
④ readOnly = true 用在唯讀路徑上 —— 除了 6.9.1 那三個理由，
   它也讓「這個方法要不要開交易」這件事的意圖出現在程式碼上。
```

### 6.9.3 🔴 實測：`clearAutomatically` 會丟掉還沒 flush 的修改

05 章 5.6.5 有一個結論：

> 「`flushAutomatically` 在 Hibernate 上通常多餘（auto-flush 本來就會發生），
> 而 `clearAutomatically` 必要。」

**前半句在一個特定情況下是錯的，而那個情況剛好是 6.11 會遇到的。**

```java
/**
 * 6.9.3：@Modifying(clearAutomatically = true) 會把【還沒 flush 的修改】丟掉。
 */
class HBClear extends Base06 {

    @Test
    void a_丟掉還沒_flush_的新實體() {
        head("6.9.3 一句批次 update 之後 em.clear()，前面 persist 的東西還在嗎？");
        cleanBulk();
        seed(0, 1, 0);
        UUID pid = productIds.get(0);

        // ① 兩者碰的是【不同的表】→ 不會 auto-flush
        tx.executeWithoutResult(s -> {
            em.persist(new Bulk6(Uuid7.next(), "會不見", BigDecimal.ONE));
            System.out.println("   persist 之後，PC 裡有 " + managed() + " 個實體");
            var sqls = spy(() -> em.createQuery(
                    "update St6 x set x.qty = x.qty - 1 where x.productId = :id")
                    .setParameter("id", pid).executeUpdate());
            System.out.println("   那一段打的 SQL：");
            sqls.forEach(q -> System.out.println("      " + cut(q)));
            em.clear();                          // ← @Modifying(clearAutomatically=true) 做的事
            System.out.println("   clear() 之後，PC 裡有 " + managed() + " 個實體");
        });
        System.out.println("   🔴 bulk_uuid 裡有 " + outside(() -> jdbc.queryForObject(
                "SELECT count(*) FROM bulk_uuid", Long.class)) + " 筆（persist 過一筆）");

        // ② 兩者碰的是【同一張表】→ auto-flush 會發生
        cleanBulk();
        tx.executeWithoutResult(s -> {
            em.persist(new Bulk6(Uuid7.next(), "不會不見", BigDecimal.ONE));
            var sqls = spy(() -> em.createQuery("update Bulk6 b set b.code = 'x'").executeUpdate());
            System.out.println("   ── 換成一句碰【同一張表】的批次 update ──");
            sqls.forEach(q -> System.out.println("      " + cut(q)));
            em.clear();
        });
        System.out.println("   ✅ bulk_uuid 裡有 " + outside(() -> jdbc.queryForObject(
                "SELECT count(*) FROM bulk_uuid", Long.class)) + " 筆");

        // ③ 先 flush 再 clear
        cleanBulk();
        tx.executeWithoutResult(s -> {
            em.persist(new Bulk6(Uuid7.next(), "先 flush", BigDecimal.ONE));
            em.flush();                          // ← @Modifying(flushAutomatically=true) 做的事
            em.createQuery("update St6 x set x.qty = x.qty - 1 where x.productId = :id")
              .setParameter("id", pid).executeUpdate();
            em.clear();
        });
        System.out.println("   ✅ 加上 flushAutomatically 之後：" + outside(() -> jdbc.queryForObject(
                "SELECT count(*) FROM bulk_uuid", Long.class)) + " 筆");
    }

    private int managed() {
        return em.unwrap(org.hibernate.engine.spi.SessionImplementor.class)
                 .getPersistenceContext().getNumberOfManagedEntities();
    }
}
```

**實測**：

```
   persist 之後，PC 裡有 1 個實體
   ── 執行一句只碰 stock 表的批次 update ──
   那一段打的 SQL：
      update stock set qty=(qty-1) where product_id=?      ← 🔴 只有這一句，沒有 insert
   clear() 之後，PC 裡有 0 個實體
   🔴 bulk_uuid 裡有 0 筆（persist 過一筆）

   ── 換成一句碰【同一張表】的批次 update ──
      insert into bulk_uuid (amount,code,id) values (?,?,?)   ← ★ auto-flush 先送出去了
      update bulk_uuid set code='x'
   ✅ bulk_uuid 裡有 1 筆

   ✅ 加上 flushAutomatically 之後：1 筆
```

> 🔴🔴 **`persist()` 過的那一筆資料，沒有進資料庫、沒有拋任何例外、交易正常提交。**

**機制**（03 章 3.7.2 講過 auto-flush 的判斷條件，這裡是它的反面）：

```
auto-flush 的觸發條件不是「有沒有未寫出的修改」，
而是「這個查詢碰到的表，跟未寫出的修改碰到的表，有沒有交集」（查詢空間 query space）。

① update St6（碰 stock）+ 未寫出的 Bulk6（碰 bulk_uuid）
   → 沒有交集 → 不 auto-flush
   → 接著 clear() 把那個 pending 的 INSERT 【一起忘掉】
   → ⚠️ clear() 的語義是「忘記」，不是「回滾」，也不是「先寫出去」

② update Bulk6（碰 bulk_uuid）+ 未寫出的 Bulk6（碰 bulk_uuid）
   → 有交集 → auto-flush → INSERT 先送出去 → 安全
```

**所以 `@Modifying` 的兩個開關都要開**：

```java
    /*
     * ★ flushAutomatically 一定要開（06 章 6.9.3 實測）：
     *   這句 update 只碰 stock 表，而呼叫端在它之前 persist 的 Order / OrderItem
     *   碰的是 orders / order_item —— 查詢空間沒有交集，所以【auto-flush 不會發生】，
     *   接著 clearAutomatically 就把那兩個還沒寫出去的 INSERT 整個丟掉。
     *   症狀：庫存扣掉了、訂單不見了，而且沒有任何錯誤訊息。
     */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query("update Stock s set s.qty = s.qty - :n … ")
    int reserveAtomically(@Param("id") UUID id, @Param("n") int n);
```

> 📌 **修正 05 章 5.6.5**：
>
> | 05 章說 | 06 章補上 |
> |---|---|
> | `flushAutomatically` 在 Hibernate 上通常多餘 | **只有在「批次操作碰的表 = 待寫出的修改碰的表」時才多餘。**<br>跨表的時候它是**必要的**，而且少了它會**靜默掉資料** |
> | `clearAutomatically` 必要 | 這句不變 —— 而它**必須跟 `flushAutomatically` 一起開** |
>
> **一句話的規則**：`@Modifying` 就把兩個都開。
> `flushAutomatically` 多做的那一次 flush 幾乎沒有成本
> （沒有待寫出的東西時它什麼都不做），而少了它的代價是資料遺失。

⚠️ **這個坑不是假想的**。它是 6.11 的 `place()` 在第一次跑併發測試時
真的發生的事：**庫存正確地扣了 10 件、`orders` 表裡有 0 張訂單、10 個請求全部回報成功。**
而抓到它的是 6.8.0 那條斷言（「回報成功的筆數要等於實際的結果」），
**不是任何一個看程式碼的人。**

---

## 6.10 把這一章變成 CI 會擋下來的東西

前面幾章各留了一把尺：
`SqlSpy`（00 章 0.10.3）、`PcSpy`（03 章 3.12）、`NPlus1Spy`（04 章 4.10）、
`ReadOnlySpy`（05 章 5.13.3）、`ReadOnlySpy2`（本章 6.5.13）。

**這一節加三條，而且三條都跟資料量無關。**

### 6.10.1 斷言一：批次匯入的 `execute` 次數必須是 `O(N / batch_size)`

```java
        // ① 批次匯入：JDBC execute 次數必須遠小於資料筆數
        cleanBulk();
        Layers r = layers("匯入 500 筆", () -> tx.executeWithoutResult(s -> {
            em.unwrap(org.hibernate.Session.class).setJdbcBatchSize(50);
            for (int i = 0; i < 500; i++)
                em.persist(new Bulk6(Uuid7.next(), "CI", BigDecimal.ONE));
        }));
        System.out.printf("   ① 500 筆 → JDBC execute %d 次（斷言：<= 500/50 + 2 = 12）→ %s%n",
                r.executes, r.executes <= 12 ? "✅" : "🔴");
```

**實測**：

```
── 匯入 500 筆
   ① Hibernate  準備 1 個 statement（insert 500 個實體）
   ② JDBC       execute() 10 次，其中 executeBatch() 10 次，共夾 500 句敘述
   ③ MySQL      insert=500  select=10  commit=1  列.inserted=500
   ① 500 筆 → JDBC execute 10 次（斷言：<= 500/50 + 2 = 12）→ ✅
```

> 📌 **它抓得到什麼**：
> 有人在匯入迴圈裡加了一句「順手檢查有沒有重複」（6.3.6）——
> `execute` 會從 10 變成 1000，而**時間只從 20 ms 變成 200 ms**。
> 在測試資料只有 20 筆的環境裡，200 ms 跟 20 ms 都是「很快」，
> **沒有人會發現，直到正式環境匯入十萬筆。**
>
> ⚠️ **注意這條斷言【不能】寫成「時間要小於 X ms」**——
> 那會在 CI 機器上隨機失敗。**要寫在「句數」上。**
> （這跟 04 章 4.10.3 那條「不能寫『少於 N 句』要寫 `entityFetch == 0`」是同一個原則：
> **找一個跟環境無關的量。**）

⚠️ **但這條斷言看不到 6.3.7 那件事**（`rewriteBatchedStatements` 沒開）。
要抓那個，斷言要寫在第三把尺上：

```java
        // ①b 更嚴格的版本：伺服器端剖析的 SQL 句數
        System.out.printf("   ①b 伺服器剖析 %d 句（斷言：<= 12）→ %s%n",
                r.serverDml(), r.serverDml() <= 12 ? "✅" : "🔴 rewriteBatchedStatements 沒開");
```

📌 **這一條要不要放進 CI，取決於你的 CI 有沒有真的 MySQL。**
如果測試跑在 H2 上，`Com_insert` 這個計數器根本不存在 ——
**而那也正是 06 站 06 章那 21 根探針要說的事：H2 與 MySQL 有 12 根不一樣。**

### 6.10.2 斷言二：所有「會被改」的實體都要有 `@Version`

```java
        // ② 所有可變實體都要有 @Version
        var meta = emf.getMetamodel().getEntities();
        List<String> noVersion = meta.stream()
                .filter(e -> e.getJavaType().getPackageName().equals("com.example.lab.ch06"))
                .filter(e -> !hasVersion(e.getJavaType()))
                .map(jakarta.persistence.metamodel.EntityType::getName)
                .sorted().toList();
        System.out.println("   ② ch06 裡沒有 @Version 的實體：" + noVersion);

    private static boolean hasVersion(Class<?> t) {
        for (Class<?> k = t; k != null && k != Object.class; k = k.getSuperclass())
            for (var f : k.getDeclaredFields())
                if (f.isAnnotationPresent(jakarta.persistence.Version.class)) return true;
        return false;
    }
```

**實測**：

```
   ② ch06 裡沒有 @Version 的實體：[Bulk6, BulkChild6, BulkId6, BulkSeq6, Country6, Item6, Wide6, WideDyn6]
```

**清單長這樣的時候，斷言不能寫成「清單必須是空的」。**
`Country6` 是 `@Immutable`、`Item6` 的並行保護靠聚合根、`Bulk*` 是實驗用的。

**所以斷言要寫成「白名單」**：

```java
    /**
     * 沒有 @Version 的實體，必須明確地列在這裡並寫上理由。
     * ★ 這條斷言的價值不在「擋下錯誤」，在【逼人寫下理由】——
     *   新加一個實體而忘了想並行問題時，建置會失敗，而修法是「決定它屬於哪一類」。
     */
    private static final Map<String, String> NO_VERSION_OK = Map.of(
        "Country6",   "@Immutable 參數表，永遠不改",
        "Item6",      "聚合的一部分，並行保護靠 Ord6 的 version（6.6.4）",
        "Wide6",      "6.4 的實驗用",
        "WideDyn6",   "6.4 的實驗用",
        "Bulk6",      "6.3 的實驗用",
        "BulkId6",    "6.3 的實驗用",
        "BulkSeq6",   "6.3 的實驗用",
        "BulkChild6", "6.3 的實驗用");

    @Test
    void 所有可變實體都要有_Version() {
        List<String> unexplained = emf.getMetamodel().getEntities().stream()
                .filter(e -> e.getJavaType().getPackageName().equals("com.example.lab.ch06"))
                .filter(e -> !hasVersion(e.getJavaType()))
                .map(jakarta.persistence.metamodel.EntityType::getName)
                .filter(n -> !NO_VERSION_OK.containsKey(n))
                .sorted().toList();
        if (!unexplained.isEmpty()) throw new AssertionError(
                "這些實體沒有 @Version，而且沒有寫下理由：" + unexplained
                + "\n要嘛加 @Version（6.6.4），要嘛在 NO_VERSION_OK 裡寫下它屬於哪一類。");
    }
```

> 📌 **這是這一站第一條「白名單式」的斷言，而它的形狀值得記住**：
>
> ```
> 「清單必須是空的」   → 有例外的時候就得關掉這條斷言
> 「清單必須被解釋」   → 例外變成程式碼的一部分，而且有理由
> ```
>
> **前者的壽命是「直到第一個合理的例外出現」。後者可以一直活著。**

### 6.10.3 斷言三：非 JPA 的寫入路徑要維護 `version`

6.6.10 那三條規則「壽命等於寫下它的人待在團隊的時間」。**把它變成一條掃描。**

```java
    /**
     * 6.6.10 的規則變成建置檢查：
     * 對「有 @Version 的表」的每一句非 JPA 的 UPDATE，都必須自己維護 version。
     *
     * ⚠️ 它是字串比對，不是語意分析 —— 它會有偽陽性（例如註解裡的 SQL），
     *    也會漏掉動態拼出來的 SQL。
     *    ★ 而這正是它有價值的地方：它讓「動態拼 UPDATE」變成一件【要繞過檢查】的事。
     */
    @Test
    void 旁路寫入必須維護_version() throws Exception {
        // ① 哪些表有 @Version
        Set<String> versionedTables = emf.getMetamodel().getEntities().stream()
                .filter(e -> hasVersion(e.getJavaType()))
                .map(e -> {
                    var t = e.getJavaType().getAnnotation(jakarta.persistence.Table.class);
                    return t != null ? t.name() : e.getName().toLowerCase();
                })
                .collect(java.util.stream.Collectors.toSet());
        System.out.println("   有 @Version 的表：" + versionedTables);

        // ② 掃 mapper XML 與 java 原始碼裡的 UPDATE
        List<String> violations = new ArrayList<>();
        java.nio.file.Path root = java.nio.file.Path.of("src/main");
        try (var walk = java.nio.file.Files.walk(root)) {
            for (java.nio.file.Path p : walk.filter(java.nio.file.Files::isRegularFile).toList()) {
                String f = p.toString();
                if (!f.endsWith(".xml") && !f.endsWith(".java")) continue;
                if (f.contains("/shop/") || f.contains("/ch0")) { /* 都要檢查 */ }
                String src = java.nio.file.Files.readString(p);
                for (String table : versionedTables) {
                    // 很粗的比對：UPDATE <table> … 而附近沒有 version
                    var m = java.util.regex.Pattern
                            .compile("(?is)update\\s+" + table + "\\b(.{0,400}?)(?:;|\"\"\"|</update>|\")")
                            .matcher(src);
                    while (m.find()) {
                        String body = m.group(1);
                        if (!body.toLowerCase().contains("version")) {
                            violations.add(p.getFileName() + " → UPDATE " + table
                                    + " 沒有維護 version：" + cut(m.group().replaceAll("\\s+", " ")));
                        }
                    }
                }
            }
        }
        violations.forEach(v -> System.out.println("   🔴 " + v));
        System.out.println("   → " + (violations.isEmpty() ? "✅ 沒有違例" : violations.size() + " 處違例"));
    }
```

📌 **這條斷言的正確使用方式**：
**它不該一開始就設成「必須為零」。**
在一個既有專案上跑它，第一次通常會找出幾十處 —— 那時候的做法是
**把數字記下來，然後斷言「不准變多」**：

```java
        // 既有專案的起點。每修掉一處就把數字調小，而它【只能變小】。
        int baseline = 0;
        if (violations.size() > baseline) throw new AssertionError(
                "旁路寫入的違例從 " + baseline + " 變成 " + violations.size() + " 處：" + violations);
```

> **這是把「技術債」變成「棘輪」的標準手法**：
> 不要求一次還完，只要求不能再借。

### 6.10.4 四條斷言的分工

| 斷言 | 在哪一章 | 抓什麼 | 形狀 |
|---|---|---|---|
| `entityFetch + collectionFetch == 0` | 04 章 4.10 | 有人加了一行 `getXxx()` → N+1 | 硬性 |
| `entityLoad == 0` | 05 章 5.13.3 | 有人把投影改回實體 | 硬性 |
| `assertAtMostStatements(n)` | 06 章 6.5.13 | 有人拿掉 `@Cache`，或改成按條件查 | 硬性 |
| `execute <= N / batch_size + 2` | **6.10.1** | **有人在匯入迴圈裡加了查詢** | 硬性 |
| 「沒有 `@Version` 的實體要有理由」 | **6.10.2** | **新實體沒想過並行問題** | **白名單** |
| 「旁路 `UPDATE` 要維護 `version`」 | **6.10.3** | **有人繞過 JPA 寫入** | **棘輪** |

---

## 6.11 shop-service 的落地

### 6.11.1 三個改動

**改動一：`Stock` 長出領域方法，以及一個業務例外。**

```java
package com.example.lab.shop;

import jakarta.persistence.*;
import java.util.UUID;

/**
 * 庫存：跟 Product 是一對一，而且【共用主鍵】（07 站 1.12）。
 * ★ 單向：Product 上【沒有】stock 欄位——因為反向側的 LAZY 無效（02 章 2.7.3）。
 */
@Entity @Table(name = "stock")
public class Stock {

    @Id @Column(name = "product_id")
    private UUID productId;

    @OneToOne(fetch = FetchType.LAZY, optional = false)
    @MapsId                                        // ★ 主鍵就是外鍵
    @JoinColumn(name = "product_id")
    private Product product;

    @Column(nullable = false) private int qty;
    @Column(name = "reserved_qty", nullable = false) private int reservedQty;
    @Version private long version;

    protected Stock() {}
    public Stock(Product product, int qty) {
        this.product = product;
        this.qty = qty;
    }

    /**
     * ★ 06 章 6.11：庫存不為負這條不變量，01 章 1.13 那張表就把它標成
     *   「不能用 JPA 的髒檢查做」——因為【檢查與寫入之間有一段時間】（6.8.5）。
     *   這個方法本身只保證「單一交易內看到的值是對的」，
     *   真正擋住併發的是呼叫端選的那個機制（@Version 或 WHERE 條件）。
     */
    public void reserve(int n) {
        if (n <= 0) throw new IllegalArgumentException("數量必須大於 0，收到 " + n);
        if (qty - n < 0) throw new InsufficientStockException(productId, qty, n);
        qty -= n;
        reservedQty += n;
    }

    public void release(int n) {
        if (n <= 0) throw new IllegalArgumentException("數量必須大於 0，收到 " + n);
        if (reservedQty - n < 0) throw new IllegalStateException("預留量不足");
        reservedQty -= n;
        qty += n;
    }

    public void restock(int n) {
        if (n <= 0) throw new IllegalArgumentException("數量必須大於 0，收到 " + n);
        qty += n;
    }

    public UUID getProductId() { return productId; }
    public Product getProduct() { return product; }
    public int getQty() { return qty; }
    public int getReservedQty() { return reservedQty; }
    public long getVersion() { return version; }
}
```

```java
package com.example.lab.shop;

import java.util.UUID;

/** 庫存不足。它是【業務例外】，不是技術例外——呼叫端要能分辨它跟樂觀鎖衝突。 */
public class InsufficientStockException extends RuntimeException {

    private final UUID productId;
    private final int available;
    private final int requested;

    public InsufficientStockException(UUID productId, int available, int requested) {
        super("庫存不足：商品 " + productId + " 剩 " + available + "，要 " + requested);
        this.productId = productId;
        this.available = available;
        this.requested = requested;
    }

    public UUID getProductId() { return productId; }
    public int getAvailable() { return available; }
    public int getRequested() { return requested; }
}
```

📌 **為什麼要有一個專門的例外類別**（6.8.6 那張表的第五列）：

```
InsufficientStockException            → 「賣完了」   → HTTP 409，訊息給使用者看
ObjectOptimisticLockingFailureException → 「系統忙碌」 → 重試，重試完還失敗才回 HTTP 503
```

**兩者都是「這次下單失敗」，而處理方式完全不同。**
用 `IllegalStateException` 或 `RuntimeException` 的話，這兩件事在 `catch` 裡分不開。

**改動二：`StockRepository` 加兩個方法 —— 兩條不同的鎖路徑。**

```java
package com.example.lab.shop;

import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.Optional;
import java.util.UUID;

public interface StockRepository extends JpaRepository<Stock, UUID> {

    /**
     * ★ 06 章 6.11：悲觀鎖版本。@Lock 會讓這個查詢變成 select … for update（6.7.1）。
     *   要另開一個方法，不能改 findById——【不同用例要的鎖不一樣】，
     *   跟 04 章 4.6.1「不同用例要的關聯不一樣」是同一條理由（6.7.5）。
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select s from Stock s where s.productId = :id")
    Optional<Stock> findByIdForUpdate(@Param("id") UUID id);

    /**
     * ★ 06 章 6.11：原子 UPDATE 版本。條件寫在 WHERE 裡，靠影響列數判斷成敗（6.8.5）。
     * ⚠️ 它【繞過持久化情境、繞過領域方法、繞過 @Version 的自動維護】——
     *   所以 version 要自己 +1（6.6.10），而且呼叫端之後不能再用同一個 Stock 實體。
     *
     * ★ flushAutomatically 一定要開（06 章 6.9.3 實測）：
     *   這句 update 只碰 stock 表，而 place() 在它之前 persist 的 Order / OrderItem
     *   碰的是 orders / order_item —— 查詢空間沒有交集，所以【auto-flush 不會發生】，
     *   接著 clearAutomatically 就把那兩個還沒寫出去的 INSERT 整個丟掉。
     *   症狀：庫存扣掉了、訂單不見了，而且沒有任何錯誤訊息。
     *   （這修正了 05 章 5.6.5「flushAutomatically 在 Hibernate 上通常多餘」那個結論。）
     */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query("""
           update Stock s
              set s.qty = s.qty - :n,
                  s.reservedQty = s.reservedQty + :n,
                  s.version = s.version + 1
            where s.productId = :id
              and s.qty >= :n
           """)
    int reserveAtomically(@Param("id") UUID id, @Param("n") int n);
}
```

**改動三：`StockService` —— 而且它要寫下「為什麼選這條路」。**

```java
package com.example.lab.shop;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.UUID;

/**
 * 06 章 6.11：庫存扣減。
 *
 * 6.8 量完四種做法之後，shop-service 選的是【原子 UPDATE】，理由有三個：
 *   ① 它是唯一「回報成功的筆數 = 實際扣掉的件數」而且不需要重試的做法（6.8.1）。
 *   ② 熱門商品的併發度不可預測，而樂觀鎖的成本跟衝突率成正比（6.8.3：平均要試 6～8 次）。
 *   ③ 悲觀鎖會把所有人排成一列，一支 API 慢下來就會把連線池吃光（6.9.2）。
 *
 * ⚠️ 它的代價寫在 reserve() 的註解裡：這條路【不經過領域模型】。
 */
@Service
public class StockService {

    private final StockRepository stocks;

    public StockService(StockRepository stocks) { this.stocks = stocks; }

    /**
     * 扣庫存。
     * ★ 這是整個 shop-service 裡【唯一】不走「撈出實體、呼叫方法」的寫入路徑，
     *   所以它的註解要寫清楚為什麼——否則下一個人會照抄到不該抄的地方（6.8.6 最後那段）。
     */
    @Transactional
    public void reserve(UUID productId, int qty) {
        if (qty <= 0) throw new IllegalArgumentException("數量必須大於 0，收到 " + qty);
        int rows = stocks.reserveAtomically(productId, qty);
        if (rows == 0) {
            // ★ 0 列有兩種可能：商品不存在，或庫存不足。要分開回報（6.8.5 第四點）。
            Stock s = stocks.findById(productId)
                    .orElseThrow(() -> new IllegalArgumentException("商品不存在：" + productId));
            throw new InsufficientStockException(productId, s.getQty(), qty);
        }
    }

    /** 對照組：悲觀鎖版本。需要「扣完之後還要用那個實體做別的事」時才用它。 */
    @Transactional
    public Stock reserveAndReturn(UUID productId, int qty) {
        Stock s = stocks.findByIdForUpdate(productId)
                .orElseThrow(() -> new IllegalArgumentException("商品不存在：" + productId));
        s.reserve(qty);
        return s;
    }

    @Transactional(readOnly = true)
    public int available(UUID productId) {
        return stocks.findById(productId)
                .orElseThrow(() -> new IllegalArgumentException("商品不存在：" + productId))
                .getQty();
    }
}
```

**而 `OrderService.place()` 現在多一行**（其餘完全不變，這是 05 章 5.14 那一版）：

```java
package com.example.lab.shop;

import jakarta.persistence.EntityManager;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

/**
 * 03 章 3.11 的落地：整個類別裡【沒有一次 save()】（除了 place 那一次 persist）。
 *
 * 四條規則：
 *   ① 交易邊界在 Service 的 public 方法上，一個用例一個交易。
 *   ② 改資料 = 撈出 managed 實體 + 呼叫它的方法。不 merge、不 save。
 *   ③ 新增資料 = em.persist（或 repository.save 一次，因為它就是 persist）。
 *   ④ 出去的是 DTO，實體不離開交易。
 */
@Service
public class OrderService {

    private final OrderRepository orders;
    private final CustomerRepository customers;
    private final ProductRepository products;
    private final StockService stocks;                     // ★ 06 章 6.11
    private final EntityManager em;

    public OrderService(OrderRepository orders, CustomerRepository customers,
                        ProductRepository products, StockService stocks, EntityManager em) {
        this.orders = orders; this.customers = customers;
        this.products = products; this.stocks = stocks; this.em = em;
    }

    /** ③ 新增：這是整個類別裡唯一呼叫 save 的地方，而它等價於 persist。 */
    @Transactional
    public UUID place(UUID orderId, String orderNo, UUID customerId,
                      UUID productId, int qty, UUID itemId) {
        Customer c = customers.getReferenceById(customerId);   // 不需要真的撈出來
        Product p = products.findById(productId)
                .orElseThrow(() -> new IllegalArgumentException("商品不存在：" + productId));
        Order o = new Order(orderId, orderNo, c);
        o.addItem(itemId, p, qty);
        orders.save(o);                                        // Persistable → 直接 persist
        stocks.reserve(productId, qty);                        // ★ 06 章 6.11：扣庫存
        return o.getId();
    }

    /** ② 改資料：撈出來、呼叫方法、結束。沒有 save。 */
    @Transactional
    public void pay(UUID orderId) { order(orderId).pay(); }

    @Transactional
    public void cancel(UUID orderId) { order(orderId).cancel(); }

    @Transactional
    public void addItem(UUID orderId, UUID productId, int qty, UUID itemId) {
        Product p = products.findById(productId)
                .orElseThrow(() -> new IllegalArgumentException("商品不存在：" + productId));
        order(orderId).addItem(itemId, p, qty);
    }

    /**
     * ④ 讀：唯讀交易（不建快照、flush mode MANUAL），回傳 DTO。
     * ★ 04 章 4.11：用 findDetailById —— 一句 SQL 撈齊客戶 + 明細 + 商品。
     */
    @Transactional(readOnly = true)
    public OrderView view(UUID orderId) {
        Order o = orders.findDetailById(orderId)
                .orElseThrow(() -> new IllegalArgumentException("訂單不存在：" + orderId));
        return OrderView.of(o);        // ★ 在交易裡就轉成 DTO，關聯還讀得到
    }

    /** ④b 列表頁：05 章 5.14 改成回傳【投影】，不是實體。 */
    @Transactional(readOnly = true)
    public List<OrderListRow> list(OrderStatus status, int page, int size) {
        return orders.listRows(status, PageRequest.of(page, size)).getContent();
    }

    /** ④b′ 04 章 4.11.2 當時的列表頁 —— 保留下來做對照（05 章 5.14）。 */
    @Transactional(readOnly = true)
    public List<OrderView> listAsEntities(OrderStatus status, int page, int size) {
        return orders.findByStatusOrderByPlacedAtDesc(status, PageRequest.of(page, size))
                .map(OrderView::of)
                .getContent();
    }

    /** ④c 搜尋（05 章 5.14）：五個條件都可以不填。 */
    @Transactional(readOnly = true)
    public List<OrderView> search(OrderSearchCriteria criteria, int page, int size) {
        return orders.findBy(OrderSpecifications.of(criteria),
                        q -> q.project("customer")
                              .sortBy(org.springframework.data.domain.Sort.by("placedAt").descending())
                              .page(PageRequest.of(page, size)))
                .map(OrderView::of)
                .getContent();
    }

    private Order order(UUID id) {
        return orders.findById(id)
                .orElseThrow(() -> new IllegalArgumentException("訂單不存在：" + id));
    }
}
```

**改動四：批次匯入的路徑。**

```java
package com.example.lab.shop;

import jakarta.persistence.EntityManager;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

/**
 * 06 章 6.11：批次匯入。
 *
 * 三個決定，每一個都對應 6.3 的一個實測：
 *   ① 用 em.persist 而不是 repository.saveAll —— saveAll 對每一筆多打一句 SELECT（6.3.1）。
 *      （shop 的 BaseEntity 有 Persistable，所以 save 也不會多查；但匯入路徑寫死 persist 更明確。）
 *   ② 每 BATCH 筆 flush + clear —— 否則持久化情境會長到跟資料量一樣大（6.3.10）。
 *   ③ 主鍵是應用端指定的 UUIDv7 —— 這是批次能成立的前提（6.3.4）。
 *
 * ⚠️ 而真正把「1000 句 INSERT」變成「20 句」的，是 JDBC URL 上的
 *    rewriteBatchedStatements=true（6.3.7）——它不在這個檔案裡，也不在任何 Java 程式碼裡。
 */
@Service
public class OrderImportService {

    /** 跟 hibernate.jdbc.batch_size 設成一樣的值（6.3.10）。 */
    private static final int BATCH = 50;

    private final EntityManager em;
    private final CustomerRepository customers;
    private final ProductRepository products;

    public OrderImportService(EntityManager em, CustomerRepository customers,
                              ProductRepository products) {
        this.em = em; this.customers = customers; this.products = products;
    }

    public record Row(UUID orderId, String orderNo, UUID customerId,
                      UUID productId, int qty, UUID itemId) {}

    @Transactional
    public int importOrders(List<Row> rows) {
        int n = 0;
        for (Row r : rows) {
            // ★ getReferenceById：不需要真的把客戶撈出來（03 章 3.11）
            Customer c = customers.getReferenceById(r.customerId());
            Product p = products.getReferenceById(r.productId());
            Order o = new Order(r.orderId(), r.orderNo(), c);
            o.addItem(r.itemId(), p, r.qty());
            em.persist(o);
            if (++n % BATCH == 0) { em.flush(); em.clear(); }
        }
        em.flush();
        em.clear();
        return n;
    }
}
```

**改動五：`shop` 這個 profile 的組態。**

```yaml
spring:
  datasource:
    url: jdbc:mysql://127.0.0.1:33306/shop?rewriteBatchedStatements=true&connectionTimeZone=UTC&forceConnectionTimeZoneToSession=true&preserveInstants=true&characterEncoding=UTF-8
  jpa:
    open-in-view: false                     # 04 章 4.4.2、06 章 6.9.2
    properties:
      hibernate:
        jdbc:
          batch_size: 50                    # 6.3.3
        order_inserts: true                 # 6.3.5
        order_updates: true
        generate_statistics: true           # 04/05/06 章的量尺都要它
        cache:
          use_second_level_cache: false     # ★ 明確關掉（6.5.2）
          use_query_cache: false
```

📌 **注意最後那兩行**：shop-service **不用二級快取**。
理由在 6.5.12 那張表：這個系統裡最常讀的是訂單，而訂單每秒都在寫。
**而「明確地關掉」比「沒有設定」重要**（6.5.2 那個實測）。

### 6.11.2 實測：`place()` 現在多了什麼

```java
    @Test
    void a_下單現在多了什麼() {
        head("6.11.1 place() 加上扣庫存之後");
        seed(100);
        List<String> sqls = spy(() -> orders.place(Uuid7.next(), "SO-A-1", customerIds.get(0),
                productIds.get(0), 2, Uuid7.next()));
        System.out.println("── place() → " + sqls.size() + " 句 SQL");
        sqls.forEach(s -> System.out.println("   " + cut(s)));
        System.out.println("   庫存剩 " + stocks.available(productIds.get(0)));
    }
```

**實測**：

```
── place() → 4 句 SQL
   select p1_0.id,p1_0.is_active,p1_0.name,p1_0.sku,p1_0.unit_price,p1_0.version from product p1_0 where p1_0.id=?
   insert into orders (currency,customer_id,discount_amount,order_no,paid_at,placed_at,status,total_amount,version,id) values (…)
   insert into order_item (line_amount,order_id,product_id,product_name,qty,unit_price,id) values (?,?,?,?,?,?,?)
   update stock set qty=(qty-?),reserved_qty=(reserved_qty+?),version=(version+1) where product_id=? and qty>=?
   庫存剩 98
```

**跟 03 章 3.11.4 那張表對照**：

| 用例 | 03 章 | 04 章 | 05 章 | **06 章** |
|---|---|---|---|---|
| `place()` | 3 句 | 3 句 | 3 句 | **4 句**（多了扣庫存那一句） |
| `pay()` | 2 句 | 2 句 | 2 句 | 2 句 |
| `view()` | 3 句 | **1 句** | 1 句 | 1 句 |
| 列表頁（20 筆） | — | 3 句 / 80 個實體 | **2 句 / 0 個實體** | 2 句 / 0 個實體 |

📌 **`place()` 從 3 句變 4 句是【往上走】的第一次。**
這一站前五章都在減少句數，這裡多了一句 —— **而它換到的是「不會超賣」。**

> **這件事本身是這一章最重要的一課**：
> **不是每一個「多一句 SQL」都是缺陷。**
> **判準是「這一句買到了什麼」，而不是「句數變多了」。**
>
> 而 6.10 那幾條斷言正是為了讓這個判斷**留在程式碼裡**：
> `place()` 的斷言應該寫成「4 句」，那麼下一次有人把它變成 5 句時，
> 建置會失敗，而修法是**在斷言旁邊寫下第五句買到了什麼**。

### 6.11.3 實測：100 個人搶 10 件

```java
    @Test
    void b_一百個人搶十件() {
        head("6.11.2 100 個併發下單，庫存只有 10 件");
        seed(10);
        UUID pid = productIds.get(0);

        var pool = java.util.concurrent.Executors.newFixedThreadPool(32);
        var go = new java.util.concurrent.CountDownLatch(1);
        List<java.util.concurrent.Future<Object>> fs = new ArrayList<>();
        for (int i = 0; i < 100; i++) {
            final int n = i;
            fs.add(pool.submit(() -> {
                go.await();
                try {
                    return orders.place(Uuid7.next(), "SO-B-" + n, customerIds.get(n % 20),
                            pid, 1, Uuid7.next());
                } catch (Throwable t) { return t; }
            }));
        }
        long t0 = System.nanoTime();
        go.countDown();
        int ok = 0, insufficient = 0, other = 0;
        for (var f : fs) {
            Object o = f.get(60, java.util.concurrent.TimeUnit.SECONDS);
            if (o instanceof InsufficientStockException) insufficient++;
            else if (o instanceof Throwable t) { other++; System.out.println("   其他例外：" + t); }
            else ok++;
        }
        pool.shutdownNow();
        long ms = (System.nanoTime() - t0) / 1_000_000;
        var row = jdbc.queryForMap("SELECT qty, reserved_qty, version FROM stock WHERE product_id = ?",
                (Object) Uuid7.toBytes(pid));
        long placed = jdbc.queryForObject("SELECT count(*) FROM orders", Long.class);
        System.out.printf("   成功 %d、庫存不足 %d、其他 %d，共 %d ms%n", ok, insufficient, other, ms);
        System.out.println("   庫存：" + row);
        System.out.println("   訂單表裡有 " + placed + " 張訂單");
        System.out.println("   " + (ok == 10 && placed == 10
                ? "✅ 成功筆數 = 實際扣掉 = 訂單數" : "🔴 對不上"));
    }
```

**實測**：

```
   成功 10、庫存不足 90、其他 0，共 263 ms
   庫存：{qty=0, reserved_qty=10, version=10}
   訂單表裡有 10 張訂單
   ✅ 成功筆數 = 實際扣掉 = 訂單數
```

**三個數字要同時對**：

```
回報成功的請求數  = 10
實際扣掉的件數    = 10   （qty 從 10 變 0）
資料庫裡的訂單數  = 10
```

⚠️ **而這個測試第一次跑出來的結果是**：

```
   成功 10、庫存不足 90、其他 0
   庫存：{qty=0, reserved_qty=10, version=10}
   訂單表裡有 0 張訂單               ← 🔴🔴
   🔴 對不上
```

**庫存完全正確地扣了 10 件，而 10 張訂單全部不見了。**
那就是 6.9.3 那個 `clearAutomatically` 的坑 —— 而**抓到它的是第三個數字**。

> 📌 **這是這一章最後、也最重要的方法論**：
>
> **並行的正確性沒有辦法靠讀程式碼確認。**
> **它只能靠「跑一次，然後檢查【好幾個】獨立的量對不對」。**
>
> **而「好幾個」是關鍵**：
> 只看「成功幾個」會漏掉 6.6.8 那個坑（沒有交易）。
> 只看「庫存對不對」會漏掉這裡這個坑（訂單不見了）。
> **要三個一起看。**

### 6.11.4 實測：匯入 1000 張訂單

```java
    @Test
    void c_匯入一千張訂單() {
        head("6.11.3 匯入 1000 張訂單（每張 1 筆明細）");
        seed(1_000_000);
        List<OrderImportService.Row> rows = new ArrayList<>();
        for (int i = 0; i < 1000; i++) {
            rows.add(new OrderImportService.Row(Uuid7.next(), "SO-C-" + i,
                    customerIds.get(i % 20), productIds.get(i % 3), 1, Uuid7.next()));
        }
        var stats = emf.unwrap(org.hibernate.SessionFactory.class).getStatistics();
        stats.clear();
        long t0 = System.nanoTime();
        List<String> sqls = spy(() -> importer.importOrders(rows));
        long ms = (System.nanoTime() - t0) / 1_000_000;

        int batches = 0, statements = 0;
        for (String s : sqls) {
            int i = s.indexOf("[batch ×");
            if (i < 0) statements++;
            else { batches++; statements += Integer.parseInt(s.substring(i + 8, s.indexOf(']', i)).trim()); }
        }
        System.out.printf("   2000 個實體（1000 訂單 + 1000 明細）→ "
                        + "JDBC execute %d 次（其中 batch %d 次）、%d ms%n", sqls.size(), batches, ms);
        System.out.println("   Hibernate 準備了 " + stats.getPrepareStatementCount() + " 個 statement");
        System.out.println("   SQL 形狀：");
        sqls.stream().map(s -> s.replaceAll("\\[batch ×\\d+\\]", "").trim()).distinct()
            .forEach(s -> System.out.println("      " + cut(s)));
        System.out.println("   資料庫裡：" + jdbc.queryForObject("SELECT count(*) FROM orders", Long.class)
                + " 張訂單、" + jdbc.queryForObject("SELECT count(*) FROM order_item", Long.class) + " 筆明細");
    }
```

**實測**：

```
   2000 個實體（1000 訂單 + 1000 明細）→ JDBC execute 100 次（其中 batch 40 次）、396 ms
   Hibernate 準備了 100 個 statement
   SQL 形狀：
      select p1_0.id,p1_0.is_active,p1_0.name,p1_0.sku,p1_0.unit_price,p1_0.version from product p1_0 where p1_0.id=?
      insert into orders (currency,customer_id,discount_amount,order_no,paid_at,placed_at,status,total_amount,version,id) values (…)
      insert into order_item (line_amount,order_id,product_id,product_name,qty,unit_price,id) values (?,?,?,?,?,?,?)
   資料庫裡：1000 張訂單、1000 筆明細
```

**把 100 拆開**：

```
20 次 flush（1000 / BATCH=50）
  × 2 個 batch（訂單一個、明細一個 —— order_inserts 把它們分好組了）   =  40
+ 20 次 flush × 3 句 select product                                    =  60
                                                                        ───
                                                                         100
```

🔴 **那 60 句 `select product` 是哪裡來的？**

```
importOrders 用 products.getReferenceById(id) 拿商品 —— 那是一個代理，不打 SQL。
而 o.addItem(itemId, p, qty) 裡面呼叫了 p.getName() 與 p.getUnitPrice()（做快照）
   → 代理初始化 → 1 句 SELECT（04 章 4.3.2）

只有 3 個商品，所以第一批只要 3 句（後面 47 筆命中一級快取）。
而【em.clear() 把它們清掉了】（6.3.10 的代價②）→ 下一批又要 3 句。
   → 20 批 × 3 = 60 句
```

**兩種修法**：

```java
// ① 匯入前把用得到的商品一次撈出來，放在一個 Map 裡（自己管，不受 clear 影響）
Map<UUID, Product> cache = products.findAllById(distinctProductIds).stream()
        .collect(Collectors.toMap(Product::getId, p -> p));
//  → 1 句 SELECT，之後 clear() 也不影響（它們變成 detached，但我們只讀值）
//  ⚠️ 而 new OrderItem(…) 需要一個 managed 的 Product 來設外鍵 →
//     要改成 em.getReference(Product.class, id) 或者接受 detached（外鍵只需要 id）

// ② 讓 BATCH 大一點（例如 500）→ 從 20 批變 2 批 → 6 句
//    ⚠️ 代價是 PC 更大、出錯時訊息更難用（6.3.8、6.6.11）
```

📌 **而在寫任何修法之前，先看那個數字值不值得修**：

```
60 句 select product，其中 57 句是重複的。
1000 張訂單 396 ms。改掉之後大概是 380 ms。

→ 這個最佳化的收益是 4%。
→ 如果匯入的是十萬張，商品有五千種，那就完全是另一回事了（那時候是 2000 批 × 5000 句）。
```

**判準：先量「它跟資料量的關係」，再決定要不要修。**
`60 = 20 批 × 3 個商品` —— **兩個因子都會長**，所以在真實資料量下它會變成問題。
**這是 04 章 4.2.2 那條「句數隨資料分布變，所以斷言不能寫『少於 N 句』」的另一個應用。**

### 6.11.5 實測：三條斷言

```java
    @Test
    void d_三條斷言() {
        head("6.11.4 寫進 CI 的三條斷言");
        seed(1_000_000);

        // 斷言一：匯入 N 筆，JDBC execute 次數必須是 O(N / batch_size)
        List<OrderImportService.Row> rows = new ArrayList<>();
        for (int i = 0; i < 500; i++)
            rows.add(new OrderImportService.Row(Uuid7.next(), "SO-D-" + i,
                    customerIds.get(i % 20), productIds.get(i % 3), 1, Uuid7.next()));
        List<String> sqls = spy(() -> importer.importOrders(rows));
        // 每 50 張 flush 一次 → 10 次 flush，每次 2 個 batch（訂單 + 明細）= 20
        // 再加上每次 flush 之後 em.clear() 把商品代理也清掉 → 每一批要重新撈 3 個商品 = 30
        int expected = (500 / 50) * 2 + (500 / 50) * 3 + 2;
        System.out.printf("   ① 匯入 500 張（= 1000 個實體）→ execute %d 次，上限 %d → %s%n",
                sqls.size(), expected, sqls.size() <= expected ? "✅" : "🔴");

        // 斷言二：扣庫存永遠只有一句 SQL，而且跟商品數無關
        List<String> one = spy(() -> stocks.reserve(productIds.get(0), 1));
        System.out.printf("   ② 扣庫存 → %d 句 SQL → %s%n", one.size(), one.size() == 1 ? "✅" : "🔴");
        one.forEach(s -> System.out.println("      " + cut(s)));

        // 斷言三：所有【會被改】的實體都要有 @Version
        List<String> missing = emf.getMetamodel().getEntities().stream()
                .filter(e -> e.getJavaType().getPackageName().equals("com.example.lab.shop"))
                .filter(e -> !hasVersion(e.getJavaType()))
                .map(e -> e.getJavaType().getSimpleName()).sorted().toList();
        System.out.println("   ③ shop 裡沒有 @Version 的實體：" + missing);
    }
```

**實測**：

```
   ① 匯入 500 張（= 1000 個實體）→ execute 50 次，上限 52 → ✅
   ② 扣庫存 → 1 句 SQL → ✅
      update stock set qty=(qty-?),reserved_qty=(reserved_qty+?),version=(version+1) where product_id=? and qty>=?
   ③ shop 裡沒有 @Version 的實體：[OrderItem]
      （OrderItem 沒有是刻意的：它的生命週期完全由 Order 這個聚合根管，並發保護靠 Order 的 version）
```

📌 **斷言一那個 `expected` 的算式，本身就是文件。**
它把「為什麼是 50 次」寫成一個式子 ——
下一次有人改了 `BATCH`、或者把 `em.clear()` 拿掉，
**這個式子會跟實際數字對不上，而修它的人必須先理解那三個因子。**

⚠️ **注意斷言一寫的是 `<=` 而不是 `==`**。
`==` 會讓「Hibernate 少打了一句」也變成失敗 ——
**斷言要擋的是「變差」，不是「變化」。**

---

## 6.12 常見誤區

**① 「`saveAll()` 是批次。」**

不是。它是一個 `for` 迴圈（6.3.2）。
而對「應用端指定主鍵」的實體，它還會**對每一筆多打一句 `SELECT`**（6.3.1）。

**② 「開了 `batch_size` 就有批次了。」**

JDBC 層有了，**資料庫那一側一句都沒少**（6.3.7）。
還要 `rewriteBatchedStatements=true`，而它在 JDBC URL 上，不在 `spring.jpa` 底下。

**③ 「批次沒什麼用，我量過了。」**

只開 `batch_size` 是 1.3 倍，加上 rewrite 是 8 倍（6.3.7）。
**「我量過了」如果只做了兩件事裡的一件，量到的就是那個小數字。**

**④ 「`@DynamicUpdate` 明顯更好，應該全部加上。」**

它在 20 欄的寬表上**比較慢**（384 vs 316 ms），因為它**不能批次**（6.4.3、6.4.4）。
只有三種情況該用它（6.4.5）。

**⑤ 「我們沒有開二級快取。」**

classpath 上有 `hibernate-jcache` + 一個提供者，它就是開的（6.5.2）。
**不用就明確地寫 `use_second_level_cache: false`。**

**⑥ 「在列表頁的實體上加 `@Cache`，列表頁就會變快。」**

不會。實體快取只加速**按 id 取**（6.5.5）。
列表頁是**按條件查**，它一句 SQL 都省不掉。

**⑦ 「集合也加上 `@Cache` 會更快。」**

集合快取存的是**元素的 id 清單**。元素自己沒有快取的話，
同一段程式碼會從 **2 句 SQL 變成 3 句**（6.5.7）。

**⑧ 「查詢快取只存 id，所以一定要配實體快取。」**

Hibernate 6 存的是**整列的欄位值**（6.5.9）。
**而它真正的問題是失效粒度是「整張表」**（6.5.10）——
一張每分鐘有寫入的表，命中率是 0。

**⑨ 「加了 `@Version` 就不會有並行問題了。」**

它擋不住：只改集合（6.6.6）、非 JPA 的寫入（6.6.10）、批次 `update`（6.6.9）、
以及**「不能超賣」這種跨列的不變量**（6.8）。6.6.12 那張表有七格。

**⑩ 「`LockModeType.OPTIMISTIC` 可以保護『我只是讀它』的情境。」**

**在 MySQL 的預設隔離等級下它完全無效**（6.6.7）——
它重讀 `version` 時命中自己的快照，檢查永遠通過。

**⑪ 「重試就寫在 Service 裡，用 `for` 迴圈包起來。」**

**跟被重試的 `@Transactional` 方法在同一個 bean 裡 = 自我呼叫 = 沒有交易。**
症狀是「每一次都成功，而資料庫完全沒變」（6.6.8）。

**⑫ 「`catch (Exception)` 然後重試。」**

業務例外（庫存不足）重試一百次還是失敗，而你白打了一百次資料庫。
**只重試 `ObjectOptimisticLockingFailureException`**（6.6.8 規則②）。

**⑬ 「悲觀鎖比較慢，所以用樂觀鎖。」**

在熱點單列上**反過來**：樂觀鎖 + 重試 119 ms，悲觀鎖 36 ms（6.8.2）。
**判準是衝突率，不是「哪個聽起來比較輕」**（6.8.3）。

**⑭ 「用 `find()` 讀出來、檢查、再用 `findByIdForUpdate()` 鎖起來改。」**

那個 `if` 用的是**快照的值**（6.7.4、6.7.5）。
**鎖要在讀之前決定。**

**⑮ 「`jakarta.persistence.lock.timeout = 3000` 就是等三秒。」**

MySQL 沒有這個語法，Hibernate **把那個值丟掉**，SQL 裡什麼都沒有（6.7.3）。

**⑯ 「死鎖會拋 `PessimisticLockException`。」**

它拋 **`OptimisticLockException`**（6.7.6）。

**⑰ 「`SET GLOBAL innodb_lock_wait_timeout = 2` 就生效了。」**

連線池裡那些連線是之前建立的，它們的 session 值還是舊的（6.7.7）。

**⑱ 「`@Modifying(clearAutomatically = true)` 就夠了。」**

那句批次操作碰的表跟待寫出的修改不同表時，**auto-flush 不會發生**，
接著 `clear()` 會把那些 `INSERT` **靜默丟掉**（6.9.3）。
**兩個開關都要開。**

**⑲ 「交易只影響正確性。」**

它抓著一條連線。交易裡多 100 ms，20 個請求就從 116 ms 變成 254 ms（6.9.2）。

**⑳ 「並行的程式碼看得出對不對。」**

看不出來。**要跑，而且要同時檢查三個獨立的量**（6.11.3）。
只檢查「成功幾個」會漏掉 6.6.8 那個坑；
只檢查「庫存對不對」會漏掉 6.11.3 那個「訂單全部不見」的坑。

---

## 6.13 本章小結

**這一章解了兩個問題，而兩個問題的答案都不在 Java 程式碼裡。**

**問題一：一萬次同樣的操作，能不能不要付一萬次成本？**

```
① 批次寫入   → 四個開關（rewriteBatchedStatements 最重要），
              加兩條程式碼規則（主鍵不能是 IDENTITY、迴圈裡不能有查詢）
② 二級快取   → 只對「幾乎不寫、按 id 取、本應用獨佔寫入」的表有用
③ 查詢快取   → 失效粒度是整張表 → 適用範圍極窄
```

**問題二：兩個人同時做同一件事，怎麼保證帳是對的？**

```
④ 樂觀鎖     → 適合低衝突。成本落在衝突的那一方（重試）
⑤ 悲觀鎖     → 適合高衝突。成本落在所有人（排隊）。而它讀得到最新值
⑥ 原子 UPDATE → 「數量有上下界」這一類不變量的正解。它沒有衝突窗口
```

**而貫穿全章的一條線是「衝突窗口」**：

```
讀到寫之間那段時間有多長，決定了：
  ① 無鎖會不會出事          （會，只要窗口 > 0）
  ② 樂觀鎖的失敗率有多高     （成正比）
  ③ 悲觀鎖會讓多少人排隊     （成正比）
  ④ 原子 UPDATE 有沒有意義   （它把窗口變成 0）

而「窗口」是你寫的程式碼決定的（6.8.3），不是框架決定的。
```

📌 **這一章最後留下的方法論**：

```
① 三把尺，缺一不可（6.2.4）
   Hibernate 準備了幾個 statement / JDBC 呼叫了幾次 execute / 【伺服器剖析了幾句】
   —— 6.3.7 那個結論只有第三把尺看得到。

② 「我設了組態、行為沒變」→ 先把 SQL 印出來，再確認組態真的生效了
   —— 這一章用這招抓到三次（batch_versioned_data、lock.timeout=3000、SET GLOBAL）。

③ 並行的斷言要寫在【好幾個獨立的量】上，不能寫在「成功幾個」上
   —— 6.6.8 與 6.11.3 兩個坑，各只有其中一個量抓得到。

④ 觀測工具自己會騙你 → 先讓它在一個你已經知道答案的情境上跑一次
   —— 6.2.4 那個 performance_schema.global_status 全部回 0 而不報錯。
```

### 6.13.1 驗收清單

**能回答就算過**：

**批次寫入**
- [ ] `saveAll(1000)` 對「應用端指定主鍵」的實體打幾句 SQL？為什麼？（6.3.1）
- [ ] 讓 JDBC 批次靜默失效的四件事是什麼？（6.3.4～6.3.7）
- [ ] 為什麼 `IDENTITY` **一定**不能批次？（6.3.4 的第二組實驗 `6.3.4b`）
- [ ] `batch_size` 開了、`Com_insert` 沒少 —— 少了什麼？（6.3.7）
- [ ] `rewriteBatchedStatements` 對 `UPDATE` 有效嗎？（6.3.11）
- [ ] 匯入迴圈的標準形狀，以及 `em.clear()` 的三個代價（6.3.10）

**`@DynamicUpdate`**
- [ ] 為什麼它不是預設值？（三個代價，6.4.5）
- [ ] 為什麼它連「200 筆都改同一欄」也不批次？（6.4.3）

**二級快取**
- [ ] 「預設是關的」在什麼情況下是錯的？（6.5.2）
- [ ] 六個商品全在快取裡，`select p from ProdC6 p` 打幾句 SQL？為什麼？（6.5.5）
- [ ] 集合快取為什麼可能讓句數變多？（6.5.7）
- [ ] 查詢快取的失效粒度是什麼？它適合什麼表？（6.5.10）
- [ ] `@Cacheable`（JPA）與 `@Cache`（Hibernate）差在哪？（6.5.3）

**樂觀鎖**
- [ ] `version` 出現在 `UPDATE` 的哪兩個位置？（6.6.1）
- [ ] 「靜默覆蓋」為什麼比「拋例外」糟糕得多？（6.6.3）
- [ ] `@Version` 擋不住的六件事（6.6.12）
- [ ] `LockModeType.OPTIMISTIC` 在 MySQL 上為什麼無效？（6.6.7）
- [ ] 重試寫在同一個 bean 裡的症狀是什麼？（6.6.8）
- [ ] 批次 `update` 為什麼要寫 `versioned`？（6.6.9）

**悲觀鎖**
- [ ] 四種 `LockModeType` 各自產生什麼 SQL？（6.7.1）
- [ ] 為什麼悲觀鎖在 `REPEATABLE READ` 下有效、而 `OPTIMISTIC` 無效？（6.7.4）
- [ ] `em.lock()` 與 `em.refresh(e, lockMode)` 差在哪？（6.7.5）
- [ ] 死鎖拋什麼例外？怎麼跟樂觀鎖衝突區分？（6.7.6）

**庫存**
- [ ] 20 人搶 10 件，四種做法各自的結果（6.8.1）
- [ ] 「衝突窗口」是什麼？誰決定它？（6.8.3）
- [ ] 原子 `UPDATE` 的兩個代價（6.8.4）
- [ ] 為什麼「庫存不為負」要寫在資料庫的 `CHECK` 裡？（6.8.4）

**交易與斷言**
- [ ] `@Transactional(readOnly = true)` 對資料庫送了什麼？值得嗎？（6.9.1）
- [ ] 為什麼「交易裡呼叫外部 API」是一個效能問題？（6.9.2）
- [ ] `@Modifying` 為什麼兩個開關都要開？（6.9.3）
- [ ] 「白名單式斷言」與「棘輪式斷言」各解什麼問題？（6.10.2、6.10.3）

### 6.13.2 本章練習

**練習一（批次）**
把 6.11.4 那 60 句 `select product` 修掉，要求：
① 匯入 1000 張訂單的 `execute` 次數 ≤ 45；
② 商品種類從 3 種變成 500 種時，`execute` 次數**不能跟著長**；
③ 寫一條斷言表達 ②（提示：跑兩次不同的商品種類數，比較兩者的句數）。

**練習二（批次的邊界）**
把 `batch_size` 設成 500、匯入 1000 筆，其中第 387 筆違反唯一約束。
量三件事：例外訊息裡有什麼、資料庫裡有幾筆、以及**你能不能從訊息回推是哪一筆**。
然後把 `batch_size` 改成 20 再跑一次。寫下你會怎麼設計「匯入失敗的回報」。

**練習三（`@DynamicUpdate`）**
在 `wide_row` 上加一個 `mediumtext` 欄位、塞 1 MB 的內容，
然後重跑 6.4.4 那個實驗。`@DynamicUpdate` 現在贏了嗎？贏多少？
**然後回答：這個結果會不會讓你改變 6.4.5 那張表？**

**練習四（二級快取）**
把 `Country6` 的 5 筆資料做成「啟動時預熱」，並用 6.5.13 的
`assertAllFromCache()` 寫一條斷言：任何一支 API 都不該為了讀國別打 SQL。
**然後刻意用 `jdbc.update` 改一筆國別，看斷言會不會失敗**——
如果不會，說明為什麼，以及你會怎麼處理。

**練習五（樂觀鎖）**
6.6.5 那個「使用者編輯十分鐘」的流程，完整實作一次：
`GET /orders/{id}` 回傳含 `version` 的 DTO，`PUT /orders/{id}` 帶回來。
要求：**衝突時回 HTTP 409，而且訊息要能告訴使用者「誰改了什麼」**。
（提示：那需要比 `version` 更多的資訊 —— 想一想那份資訊要從哪裡來。）

**練習六（悲觀鎖）**
用 `SKIP LOCKED` 實作一個「10 個 worker 搶同一張任務表」的迴圈。
量三件事：① 有沒有任務被處理兩次；② 有沒有任務永遠沒被撈到；
③ worker 數從 10 加到 50 時，總吞吐量的變化。

**練習七（並行）**
把 6.8 的四種做法各自加上「同時扣兩個商品」的版本
（一張訂單有兩筆明細，兩個不同商品）。
**跑 20 個併發，其中一半的順序是 A→B、一半是 B→A。**
量：哪幾種做法會死鎖？為什麼原子 `UPDATE` 那一種也會？怎麼修？

**練習八（回頭看）**
把 6.11.2 那張「四章的句數對照表」補完
（`place` / `pay` / `addItem` / `view` / 列表頁 / 搜尋，四章各一欄）。
然後對每一個「句數變多」的格子，寫一句「它買到了什麼」。
**如果有格子寫不出來，那就是一個該修的地方。**

---

## 6.14 下一章預告

**07 章：MyBatis 基礎。**

這一站的前七章（00～06）都在同一個世界裡：

```
你描述【物件與表的對應關係】，框架決定 SQL。
   ↓
於是你要學的東西是：持久化情境、髒檢查、代理、fetch 策略、
                  快照、flush 時機、二級快取、@Version……
```

**07 章開始，那些東西【全部不存在】。**

```
00 章 0.6.2 那條軸的另一端：

     JPA / Hibernate                MyBatis
  ─────────────────────────────────────────────────
     有狀態（持久化情境）            無狀態
     框架產 SQL                    你寫 SQL
     實體                          結果集 → 你指定的型別
     髒檢查自動寫回                 你呼叫 update，它就 update
```

📌 **07 章的第一句話是**：

```
把 01～06 章教的十四個機制拿去 MyBatis 上盤點：
   五個【根本不存在】（持久化情境、髒檢查、flush 時機、方言轉換、樂觀鎖）
   六個【有，但完全是另一個東西】（一級快取、二級快取、批次、N+1、延遲載入、型別轉換）
   兩個【MyBatis 反而更直白】（悲觀鎖、DTO 投影）
而那十四格會換成另外一組問題 —— 07 章 7.2 是那張表。
```

**07 章會處理六件事**：

```
① Spring Boot 整合：starter 的版本要自己寫（它不在 Boot BOM 裡），
   以及自動組態到底做了什麼
② @Mapper 介面執行期是什麼（收掉 00 章 0.5.3 的承諾）
③ 🔴 #{} 與 ${}：收掉 00 章 0.3.6 那個「一個字元的安全漏洞」，
   以及【那些只能用 ${} 的位置】怎麼寫才安全
④ TypeHandler：收掉 00 章 0.5.4 那個「UUID ↔ BINARY(16) 靜默影響 0 列」
⑤ resultMap 與自動映射：三種寫法，以及 record 能不能用
⑥ MyBatis 自己的一級快取 —— 它跟 JPA 的【完全不是同一個東西】，
   而且它預設是開的
```

⚠️ **而 07 章會回頭修改這一章的兩個結論**：

| 這一章說 | 07 章會補上 |
|---|---|
| 6.3.9：`JdbcTemplate.batchUpdate` 比 JPA 快 1.75 倍，因為「不建實體」 | **MyBatis 的批次要怎麼寫**，以及它跟 `JdbcTemplate` 的差別在哪 |
| 6.6.10：非 JPA 的寫入路徑要自己維護 `version` | **在 MyBatis 上那句 SQL 長什麼樣**，以及怎麼讓「忘記寫」變成建置失敗 |
| 6.5.11：有人繞過 JPA 改資料 → 二級快取讀到舊值 | MyBatis 自己也有快取，**而兩個快取互相不知道對方存在** |

📌 **而 09 章會回來收這一站最大的一筆帳**：

```
00 章 0.8.4 決定「報表與列表查詢用 MyBatis」。
05 章 5.8.10 證明了「慢的是實體，不是 JPA」（DTO 投影 2 ms vs MyBatis 3 ms）。
06 章 6.3.9 證明了「純資料匯入，不經過 JPA 真的快 1.75 倍」。
   ↓
09 章：那個決定還成立嗎？成立的部分是哪一半？
```
