# 第 05 章：查詢技術 —— JPQL、Criteria、QueryDSL、原生 SQL 與 DTO 投影

> 04 章用五種工具把那個列表頁的 251 句 SQL 修成 1 句。
> 而 4.9.1 那張對照表的最後一欄，寫著一個沒有人動過的數字：
>
> ```
> 寫法                        SQL     DB列數       PC實體       ms
> ① 天真（LAZY）                251      200        650       62
> ② JOIN FETCH                1      400        650        6
> ③ @EntityGraph              1      400        650        6
> ④ @BatchSize(25)           11      200        650        9
> ⑤ SUBSELECT(只集合)            2      200        600        5
> ```
>
> **五種解法，持久化情境裡的實體數全部都是 650。**
>
> 而那一頁真正要顯示的，是每一列五個值：
> 訂單編號、狀態、金額、客戶名稱、明細筆數。
>
> ---
>
> **這一章的第一句話是**：
>
> > **這一頁不需要實體。**
>
> 200 個 `Ord5`、400 個 `Item5`、50 個 `Cust5`，
> 每一個都配一份快照（03 章 3.4.2）、一個 `PersistentBag`（04 章 4.3.4），
> 而且在交易結束前全部要做一次髒檢查（03 章 3.4.7）——
> **為了 1000 個字串跟數字。**

---

這一章有 **51 個實測**。挑十個先講結果：

- `select o.orderNo, o.rep.name from Ord5 o` —— 資料庫裡 30 張訂單，**它只回 20 列**。
  沒有 `where`、沒有錯誤訊息 🔴
- `select o from Ord5 o join o.items i` 回傳 **10 筆**，
  而 `select count(o) from Ord5 o join o.items i` 回傳 **30** ——
  **同一句查詢，結果筆數跟它的 count 對不上**。
  換成 Spring Data 的 `Page`，總筆數就是 **60 vs 實際的 30** ★★
- 每一份教學都教你寫的 `count(o.id)` 而不是 `count(o)`：**Hibernate 6 兩者產生一模一樣的 SQL**
- JPQL 規格裡沒有窗口函式、沒有 `union`、沒有 CTE ——
  **Hibernate 6 的 HQL 八個全部都有**，而它們不是 JPQL
- `where o.id in :ids` —— **清單長度 1～20 就是 20 種 SQL**。
  一行組態讓它變成 **6 種**
- 一句批次 `update` vs 逐筆髒檢查：**1 句 / 3 ms vs 151 句 / 52 ms**，
  而那句 `update` 會讓**持久化情境裡的資料變成錯的**，
  **`@Version` 也不會動** 🔴
- 同一句 JOIN、同一份資料：實體 **650 個 / 10 ms** → DTO 投影 **0 個 / 2 ms**。
  00 章 0.7 那個「MyBatis 3 ms、JPA 9 ms」的差距，在這裡收掉 ★★
- 介面投影（interface projection）看起來最省事 ——
  **封閉式會撈回介面上根本沒有的欄位（PC 裡 50 個實體）；
  開放式（`@Value`）的 SQL 跟 `select o` 一字不差（150 個）** 🔴
- QueryDSL 5.0.0 遇到 01 章教的 `@Embeddable record`：**整個建置炸掉**
- 一句打錯字的 `@Query`，Spring Boot 在**啟動時**就會拒絕開機 ——
  而同樣的錯字寫在 Criteria 裡，是**編譯期**就過不了

📌 **這一章的主線**：

> **「查詢」有兩個問題，不是一個。**
> **第一個是「怎麼把條件講清楚」—— 那是 JPQL / Criteria / QueryDSL 在解的。**
> **第二個是「查回來的東西要長什麼樣」—— 那是投影在解的。**
> **前面四章都在解第一個。這一章從第二個開始。**

---

## 5.1 學習目標

完成本章後，你應該可以：

- 說出 JPQL 與 SQL 的**六個根本差異**（5.3.7），並解釋為什麼
  「把 SQL 的字改一改」是學不會 JPQL 的。
- 指出一句 JPQL 裡的**隱式 join**，並說明它在可為 null 的關聯上
  **會靜默吃掉資料**（5.3.3）。
- 區分 `join` 與 `join fetch`，並解釋為什麼「結果筆數」與 `count` **可以對不上**（5.3.5）。
- 寫出含聚合、`group by`、`having`、子查詢與 `case` 的 JPQL（5.4）。
- 分辨哪些語法是 **JPQL 規格**、哪些是 **Hibernate 的 HQL 擴充**（5.4.8）。
- 說明參數繫結除了防注入以外的**第二個理由**，並用 `in_clause_parameter_padding`
  把一個查詢的 SQL 形狀數量砍掉 3/4（5.5.3）。
- 用 JPQL 的批次 `update` / `delete` 改一萬筆資料，
  並說出它**繞過了什麼**、以及不處理會出什麼事（5.6）。
- 在衍生查詢、`@Query`、Criteria、QueryDSL 之間，
  依「條件是不是動態的」與「誰會來改這段程式碼」做選擇（5.12）。
- 寫出 **DTO 投影的四種寫法**，說出各自的 SQL 差異與代價，
  並知道**集合（明細）要怎麼放進 DTO**（5.8）。
- 說明原生 SQL 回傳實體與回傳 DTO 的差別，
  以及原生 SQL 改資料時對持久化情境的影響（5.11）。
- 寫出一個**啟動時就會擋下錯字**的查詢定義方式，並解釋為什麼這件事值錢（5.13）。

---

## 5.2 這一章的模型與量尺

### 5.2.1 表結構

`ch05` 資料庫。跟 04 章那份的差別有三個，每一個都是為了某個實驗：

- 多一張 `sales_rep`，而 `orders.rep_id` **可以是 null** —— 5.3.3 的隱式 join 實驗要用。
- `customer` 多一個 `tier`（會員等級）、`product` 多一個 `category` ——
  5.4.5 的 `group by` 與 5.8 的報表要用。
- 沒有 04 章那個 `spec_text`（那是 `@Basic(fetch = LAZY)` 的實驗用的，這一章用不到）。

```sql
DROP DATABASE IF EXISTS ch05;
CREATE DATABASE ch05 DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE ch05;

CREATE TABLE customer (
  id            binary(16)   NOT NULL,
  email         varchar(255) NOT NULL,
  display_name  varchar(64)  NOT NULL,
  tier          varchar(16)  NOT NULL DEFAULT 'NORMAL',
  PRIMARY KEY (id),
  UNIQUE KEY uk_customer_email (email)
) ENGINE=InnoDB;

CREATE TABLE sales_rep (
  id      binary(16)  NOT NULL,
  name    varchar(64) NOT NULL,
  region  varchar(32) NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB;

CREATE TABLE product (
  id          binary(16)     NOT NULL,
  sku         varchar(32)    NOT NULL,
  name        varchar(200)   NOT NULL,
  category    varchar(32)    NOT NULL,
  unit_price  decimal(19,4)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_product_sku (sku)
) ENGINE=InnoDB;

CREATE TABLE stock (
  product_id   binary(16) NOT NULL,
  qty          int NOT NULL DEFAULT 0,
  reserved_qty int NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id),
  CONSTRAINT fk_stock_product FOREIGN KEY (product_id) REFERENCES product (id)
) ENGINE=InnoDB;

CREATE TABLE orders (
  id            binary(16)     NOT NULL,
  order_no      varchar(32)    NOT NULL,
  customer_id   binary(16)     NOT NULL,
  rep_id        binary(16)     NULL,          -- ★ 可以是 null：5.3.3 的隱式 join 實驗
  status        varchar(16)    NOT NULL,
  total_amount  decimal(19,4)  NOT NULL,
  placed_at     datetime(3)    NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_orders_order_no (order_no),
  KEY idx_orders_status_placed (status, placed_at),
  KEY idx_orders_customer (customer_id),
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customer (id),
  CONSTRAINT fk_orders_rep      FOREIGN KEY (rep_id)      REFERENCES sales_rep (id)
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

CREATE TABLE order_note (
  id       binary(16)   NOT NULL,
  order_id binary(16)   NOT NULL,
  note     varchar(500) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_order_note_order (order_id),
  CONSTRAINT fk_order_note_orders FOREIGN KEY (order_id) REFERENCES orders (id)
) ENGINE=InnoDB;
```

### 5.2.2 實體

跟 04 章一樣：**所有關聯一律 `LAZY`**（02 章 2.7 的決定，04 章 4.4.3 補上了根據）。

```java
package com.example.lab.ch05;

import jakarta.persistence.Id;
import jakarta.persistence.MappedSuperclass;
import org.hibernate.Hibernate;
import java.util.UUID;

/** 對代理安全的 equals / hashCode（01 章 1.14.4）。 */
@MappedSuperclass
public abstract class Base5 {

    @Id private UUID id;

    protected Base5() {}
    protected Base5(UUID id) { this.id = id; }

    public UUID getId() { return id; }

    @Override public final boolean equals(Object o) {
        if (this == o) return true;
        if (o == null || Hibernate.getClass(this) != Hibernate.getClass(o)) return false;
        UUID mine = getId();
        return mine != null && mine.equals(((Base5) o).getId());
    }
    @Override public final int hashCode() { return Hibernate.getClass(this).hashCode(); }
}
```

```java
package com.example.lab.ch05;
public enum St5 { PENDING, PAID, PACKED, SHIPPED, DELIVERED, CANCELLED }
```

```java
package com.example.lab.ch05;
public enum Tier5 { NORMAL, SILVER, GOLD }
```

```java
package com.example.lab.ch05;

import jakarta.persistence.*;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

@Entity @Table(name = "customer")
public class Cust5 extends Base5 {

    @Column(nullable = false, length = 255) private String email;
    @Column(name = "display_name", nullable = false, length = 64) private String displayName;

    /** @Enumerated(STRING) 在 MySQL 上要配 @JdbcTypeCode(VARCHAR)（01 章 1.7.4）。 */
    @Enumerated(EnumType.STRING) @JdbcTypeCode(SqlTypes.VARCHAR)
    @Column(nullable = false, length = 16) private Tier5 tier = Tier5.NORMAL;

    /** ★ 5.4.5 的 left join + count 要用。一律 LAZY（02 章 2.7）。 */
    @OneToMany(mappedBy = "customer") private List<Ord5> orders = new ArrayList<>();

    protected Cust5() {}
    public Cust5(UUID id, String email, String displayName, Tier5 tier) {
        super(id); this.email = email; this.displayName = displayName; this.tier = tier;
    }
    public String getEmail() { return email; }
    public String getDisplayName() { return displayName; }
    public Tier5 getTier() { return tier; }
    public List<Ord5> getOrders() { return orders; }
}
```

```java
package com.example.lab.ch05;

import jakarta.persistence.*;
import java.util.UUID;

/** 業務員。訂單的 rep_id 是【可以為 null 的】外鍵 —— 5.3.3 的隱式 join 實驗要用。 */
@Entity @Table(name = "sales_rep")
public class Rep5 extends Base5 {

    @Column(nullable = false, length = 64) private String name;
    @Column(nullable = false, length = 32) private String region;

    protected Rep5() {}
    public Rep5(UUID id, String name, String region) {
        super(id); this.name = name; this.region = region;
    }
    public String getName() { return name; }
    public String getRegion() { return region; }
}
```

```java
package com.example.lab.ch05;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.util.UUID;

@Entity @Table(name = "product")
public class Prod5 extends Base5 {

    @Column(nullable = false, length = 32)  private String sku;
    @Column(nullable = false, length = 200) private String name;
    @Column(nullable = false, length = 32)  private String category;
    @Column(name = "unit_price", nullable = false, precision = 19, scale = 4)
    private BigDecimal unitPrice;

    protected Prod5() {}
    public Prod5(UUID id, String sku, String name, String category, BigDecimal unitPrice) {
        super(id); this.sku = sku; this.name = name;
        this.category = category; this.unitPrice = unitPrice;
    }
    public String getSku() { return sku; }
    public String getName() { return name; }
    public String getCategory() { return category; }
    public BigDecimal getUnitPrice() { return unitPrice; }
}
```

```java
package com.example.lab.ch05;

import jakarta.persistence.*;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** 05 章的訂單。跟 04 章那個一樣三個關聯全 LAZY，多一個【可為 null】的業務員。 */
@Entity @Table(name = "orders")
public class Ord5 extends Base5 {

    @Column(name = "order_no", nullable = false, length = 32) private String orderNo;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "customer_id", nullable = false) private Cust5 customer;

    /** ★ optional = true（預設）：這一列的 rep_id 可以是 null。 */
    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "rep_id") private Rep5 rep;

    @Enumerated(EnumType.STRING) @JdbcTypeCode(SqlTypes.VARCHAR)
    @Column(nullable = false, length = 16) private St5 status;

    @Column(name = "total_amount", nullable = false, precision = 19, scale = 4)
    private BigDecimal totalAmount = BigDecimal.ZERO;
    @Column(name = "placed_at", nullable = false) private Instant placedAt;

    @OneToMany(mappedBy = "order") private List<Item5> items = new ArrayList<>();
    @OneToMany(mappedBy = "order") private List<Note5> notes = new ArrayList<>();

    protected Ord5() {}

    public String getOrderNo() { return orderNo; }
    public Cust5 getCustomer() { return customer; }
    public Rep5 getRep() { return rep; }
    public St5 getStatus() { return status; }
    public BigDecimal getTotalAmount() { return totalAmount; }
    public Instant getPlacedAt() { return placedAt; }
    public List<Item5> getItems() { return items; }
    public List<Note5> getNotes() { return notes; }
}
```

```java
package com.example.lab.ch05;

import jakarta.persistence.*;
import java.math.BigDecimal;

@Entity @Table(name = "order_item")
public class Item5 extends Base5 {

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "order_id", nullable = false) private Ord5 order;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "product_id", nullable = false) private Prod5 product;

    @Column(name = "product_name", nullable = false, length = 200) private String productName;
    @Column(name = "unit_price", nullable = false, precision = 19, scale = 4) private BigDecimal unitPrice;
    @Column(nullable = false) private int qty;
    @Column(name = "line_amount", nullable = false, precision = 19, scale = 4) private BigDecimal lineAmount;

    protected Item5() {}
    public Ord5 getOrder() { return order; }
    public Prod5 getProduct() { return product; }
    public String getProductName() { return productName; }
    public BigDecimal getUnitPrice() { return unitPrice; }
    public int getQty() { return qty; }
    public BigDecimal getLineAmount() { return lineAmount; }
}
```

```java
package com.example.lab.ch05;

import jakarta.persistence.*;

@Entity @Table(name = "order_note")
public class Note5 extends Base5 {

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "order_id", nullable = false) private Ord5 order;

    @Column(nullable = false, length = 500) private String note;

    protected Note5() {}
    public Ord5 getOrder() { return order; }
    public String getNote() { return note; }
}
```

### 5.2.3 repository

**這一章所有的查詢方法都在這一個介面上。**
每一個方法的意思會在對應的小節解釋——現在先掃過去就好，
**它的長度本身就是這一章的一部分**（5.7.1 會回來談這件事）。

```java
package com.example.lab.ch05;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Slice;
import org.springframework.data.domain.Sort;
import org.springframework.data.jpa.repository.EntityGraph;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.JpaSpecificationExecutor;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

public interface Ord5Repo extends JpaRepository<Ord5, UUID>, JpaSpecificationExecutor<Ord5>,
                                 org.springframework.data.querydsl.QuerydslPredicateExecutor<Ord5> {

    // ── 5.7.1 衍生查詢 ───────────────────────────────────────────────
    List<Ord5> findByStatus(St5 status);
    List<Ord5> findByStatusAndTotalAmountGreaterThan(St5 status, BigDecimal amount);
    List<Ord5> findByCustomer_TierAndPlacedAtBetweenOrderByPlacedAtDesc(
            Tier5 tier, Instant from, Instant to);
    long countByStatus(St5 status);
    boolean existsByOrderNo(String orderNo);
    List<Ord5> findTop3ByStatusOrderByTotalAmountDesc(St5 status);

    // ── 5.7.2 @Query ─────────────────────────────────────────────────
    @Query("select o from Ord5 o where o.status = :st and o.totalAmount > :amt")
    List<Ord5> search(@Param("st") St5 status, @Param("amt") BigDecimal amount);

    @Query(value = "select * from orders where status = :st", nativeQuery = true)
    List<Ord5> searchNative(@Param("st") String status);

    /** SpEL：#{#entityName} 會被換成實體名，抽共用基底介面時很有用。 */
    @Query("select count(o) from #{#entityName} o where o.status = :st")
    long countBySpel(@Param("st") St5 status);

    // ── 5.7.3 分頁 ────────────────────────────────────────────────────
    Page<Ord5> findByStatus(St5 status, Pageable page);
    Slice<Ord5> findByStatusOrderByPlacedAtDesc(St5 status, Pageable page);
    List<Ord5> findByStatusOrderByOrderNo(St5 status, Pageable page);

    /** 🔴 join 集合 + Page：自動生成的 count 會放大（5.3.5） */
    @Query("select o from Ord5 o join o.items i where i.qty > :q")
    Page<Ord5> findWithItems(@Param("q") int qty, Pageable page);

    /** ✅ 自己寫 countQuery */
    @Query(value = "select o from Ord5 o join o.items i where i.qty > :q",
           countQuery = "select count(distinct o) from Ord5 o join o.items i where i.qty > :q")
    Page<Ord5> findWithItemsFixed(@Param("q") int qty, Pageable page);

    // ── 5.7.5 批次 ────────────────────────────────────────────────────
    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("update Ord5 o set o.status = :to where o.status = :from")
    int changeStatus(@Param("from") St5 from, @Param("to") St5 to);

    // ── 5.8 投影 ──────────────────────────────────────────────────────
    /** ① 建構子表達式 */
    @Query("""
           select new com.example.lab.ch05.OrderRow(
                    o.id, o.orderNo, c.displayName, o.status, o.totalAmount, o.placedAt,
                    (select count(i) from Item5 i where i.order = o))
             from Ord5 o join o.customer c
            where o.status = :st
            order by o.placedAt desc
           """)
    List<OrderRow> rows(@Param("st") St5 status);

    @Query("""
           select new com.example.lab.ch05.OrderRow(
                    o.id, o.orderNo, c.displayName, o.status, o.totalAmount, o.placedAt,
                    (select count(i) from Item5 i where i.order = o))
             from Ord5 o join o.customer c
            where o.status = :st
           """)
    Page<OrderRow> rowsPage(@Param("st") St5 status, Pageable page);

    /** ② 介面投影（封閉式） */
    List<OrderRowView> findViewByStatus(St5 status);

    /** ②b 介面投影（開放式，帶 SpEL） */
    List<OrderOpenView> findOpenByStatus(St5 status);

    /** ③ Object[] */
    @Query("select o.id, o.orderNo, c.displayName, o.status, o.totalAmount, o.placedAt"
         + "  from Ord5 o join o.customer c where o.status = :st")
    List<Object[]> tuples(@Param("st") St5 status);

    /** ④ Hibernate 6：不寫 new，直接指定回傳型別 */
    @Query("select o.id, o.orderNo, c.displayName, o.status, o.totalAmount, o.placedAt, 0L"
         + "  from Ord5 o join o.customer c where o.status = :st")
    List<OrderRow> implicitRows(@Param("st") St5 status);

    /** 報表 */
    @Query("""
           select new com.example.lab.ch05.CustomerSales(c.displayName, c.tier, count(o), sum(o.totalAmount))
             from Ord5 o join o.customer c
            group by c.displayName, c.tier
            order by sum(o.totalAmount) desc
           """)
    List<CustomerSales> salesByCustomer();

    /** 5.8.8：明細怎麼進 DTO —— 第一段只查訂單 */
    @Query("""
           select new com.example.lab.ch05.OrderRow(
                    o.id, o.orderNo, c.displayName, o.status, o.totalAmount, o.placedAt, 0L)
             from Ord5 o join o.customer c where o.id in :ids
           """)
    List<OrderRow> rowsByIds(@Param("ids") List<UUID> ids);

    @Query("select o.id from Ord5 o where o.status = :st order by o.placedAt desc")
    List<UUID> idsByStatus(@Param("st") St5 status, Pageable page);

    // ── 5.7.6 動態排序 ────────────────────────────────────────────────
    List<Ord5> findByStatus(St5 status, Sort sort);

    /** ★ JpaSort.unsafe 只在 @Query 的方法上有效（衍生查詢會先過 PropertyPath 檢查） */
    @Query("select o from Ord5 o where o.status = :st")
    List<Ord5> searchSorted(@Param("st") St5 status, Sort sort);
}
```

```java
package com.example.lab.ch05;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.UUID;

public interface Item5Repo extends JpaRepository<Item5, UUID> {

    /** 5.8.8 第二段：一句撈齊這些訂單的所有明細 */
    @Query("select i.order.id, i.productName, i.qty, i.lineAmount"
         + "  from Item5 i where i.order.id in :ids order by i.productName")
    List<Object[]> linesOf(@Param("ids") List<UUID> ids);
}
```

其餘四個 repository 都是空的：

```java
package com.example.lab.ch05;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.UUID;

public interface Cust5Repo extends JpaRepository<Cust5, UUID> {}
```

```java
package com.example.lab.ch05;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.UUID;

public interface Prod5Repo extends JpaRepository<Prod5, UUID> {}
```

```java
package com.example.lab.ch05;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.UUID;

public interface Rep5Repo extends JpaRepository<Rep5, UUID> {}
```

```java
package com.example.lab.ch05;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.UUID;

public interface OrdVer5Repo extends JpaRepository<OrdVer5, UUID> {}
```

### 5.2.4 量尺：這一章多了一把

前四章的兩把尺照舊（00 章 0.10、03 章 3.10）：

| 量尺 | 看得到什麼 | 這一章用在哪 |
|---|---|---|
| `SqlSpy`（datasource-proxy） | **每一句真的送到 JDBC 的 SQL**，含 MyBatis / JdbcTemplate | 全章 |
| Hibernate `Statistics` | `entityLoad` / `entityFetch` / `collectionLoad` | 5.6、5.8 |

**而這一章要看第三個數字：持久化情境裡有幾個實體。**
04 章 4.9.1 已經印過它，這一章它是主角：

```java
/** 持久化情境裡有幾個 managed 實體（必須在交易內呼叫）。 */
protected int managedEntities() {
    return em.unwrap(org.hibernate.engine.spi.SessionImplementor.class)
             .getPersistenceContext().getNumberOfManagedEntities();
}
```

本章所有實測共用的測試基底（`seed` 的規則寫在註解裡，
每一條都對應到某一個實驗）：

```java
package com.example.lab.ch05;

import com.example.lab.SqlSpy;
import com.example.lab.Uuid7;
import jakarta.persistence.EntityManager;
import jakarta.persistence.EntityManagerFactory;
import org.hibernate.engine.spi.SessionImplementor;
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
  "spring.datasource.url=jdbc:mysql://127.0.0.1:33306/ch05?connectionTimeZone=UTC"
      + "&forceConnectionTimeZoneToSession=true&preserveInstants=true&characterEncoding=UTF-8",
  "spring.jpa.properties.hibernate.generate_statistics=true"
})
public abstract class Base05 {

    @Autowired protected EntityManager em;
    @Autowired protected EntityManagerFactory emf;
    @Autowired protected JdbcTemplate jdbc;
    @Autowired protected TransactionTemplate tx;

    protected final List<UUID> orderIds = new ArrayList<>();
    protected final List<UUID> customerIds = new ArrayList<>();
    protected final List<UUID> productIds = new ArrayList<>();
    protected final List<UUID> repIds = new ArrayList<>();

    protected static final String[] CATEGORIES = {"3C", "書籍", "生鮮"};

    protected void clean() {
        jdbc.update("DELETE FROM order_note");
        jdbc.update("DELETE FROM order_item");
        jdbc.update("DELETE FROM orders");
        jdbc.update("DELETE FROM stock");
        jdbc.update("DELETE FROM product");
        jdbc.update("DELETE FROM sales_rep");
        jdbc.update("DELETE FROM customer");
    }

    /**
     * orderCount 張訂單、customerCount 個客戶、每張 itemsPer 筆明細 + notesPer 筆備註。
     * ★ 每 3 張訂單就有 1 張【沒有業務員】（rep_id = null）—— 5.3.3 要用。
     * ★ 每 4 張訂單有 1 張是 CANCELLED，其餘 PENDING —— 5.4.5 的 group by 要用。
     * ★ 金額 = 100 × itemsPer + (i % 7) × 10 —— 讓 group by 的數字不會全部一樣。
     */
    protected void seed(int orderCount, int customerCount, int itemsPer, int notesPer) {
        clean();
        orderIds.clear(); customerIds.clear(); productIds.clear(); repIds.clear();

        List<Object[]> cRows = new ArrayList<>();
        Tier5[] tiers = Tier5.values();
        for (int i = 0; i < customerCount; i++) {
            UUID id = Uuid7.next(); customerIds.add(id);
            cRows.add(new Object[]{Uuid7.toBytes(id), "c" + i + "@x.com",
                    "客戶" + i, tiers[i % tiers.length].name()});
        }
        jdbc.batchUpdate("INSERT INTO customer (id,email,display_name,tier) VALUES (?,?,?,?)", cRows);

        List<Object[]> rRows = new ArrayList<>();
        String[] regions = {"北區", "南區"};
        for (int i = 0; i < 4; i++) {
            UUID id = Uuid7.next(); repIds.add(id);
            rRows.add(new Object[]{Uuid7.toBytes(id), "業務" + i, regions[i % 2]});
        }
        jdbc.batchUpdate("INSERT INTO sales_rep (id,name,region) VALUES (?,?,?)", rRows);

        List<Object[]> pRows = new ArrayList<>(), sRows = new ArrayList<>();
        for (int i = 0; i < 6; i++) {
            UUID id = Uuid7.next(); productIds.add(id);
            pRows.add(new Object[]{Uuid7.toBytes(id), "SKU-" + i, "商品" + i,
                    CATEGORIES[i % 3], new BigDecimal((100 + i * 50) + ".0000")});
            sRows.add(new Object[]{Uuid7.toBytes(id), 100 + i});
        }
        jdbc.batchUpdate("INSERT INTO product (id,sku,name,category,unit_price) VALUES (?,?,?,?,?)", pRows);
        jdbc.batchUpdate("INSERT INTO stock (product_id,qty) VALUES (?,?)", sRows);

        List<Object[]> oRows = new ArrayList<>(), iRows = new ArrayList<>(), nRows = new ArrayList<>();
        Instant t0 = Instant.parse("2026-09-01T00:00:00Z");
        for (int i = 0; i < orderCount; i++) {
            UUID oid = Uuid7.next(); orderIds.add(oid);
            byte[] rep = (i % 3 == 0) ? null : Uuid7.toBytes(repIds.get(i % 4));
            String st = (i % 4 == 3) ? "CANCELLED" : "PENDING";
            BigDecimal total = new BigDecimal((100 * itemsPer + (i % 7) * 10) + ".0000");
            oRows.add(new Object[]{Uuid7.toBytes(oid), String.format("SO-2026-%06d", i + 1),
                    Uuid7.toBytes(customerIds.get(i % customerCount)), rep, st, total,
                    java.sql.Timestamp.from(t0.plusSeconds(i * 60L))});
            for (int k = 0; k < itemsPer; k++) {
                UUID pid = productIds.get((i + k) % 6);
                iRows.add(new Object[]{Uuid7.toBytes(Uuid7.next()), Uuid7.toBytes(oid),
                        Uuid7.toBytes(pid), "商品" + ((i + k) % 6),
                        new BigDecimal("100.0000"), 1 + (k % 3), new BigDecimal("100.0000")});
            }
            for (int k = 0; k < notesPer; k++) {
                nRows.add(new Object[]{Uuid7.toBytes(Uuid7.next()), Uuid7.toBytes(oid),
                        "備註 " + k + " / 訂單 " + i});
            }
        }
        jdbc.batchUpdate("INSERT INTO orders (id,order_no,customer_id,rep_id,status,total_amount,placed_at)"
                + " VALUES (?,?,?,?,?,?,?)", oRows);
        jdbc.batchUpdate("INSERT INTO order_item (id,order_id,product_id,product_name,unit_price,qty,line_amount)"
                + " VALUES (?,?,?,?,?,?,?)", iRows);
        if (!nRows.isEmpty())
            jdbc.batchUpdate("INSERT INTO order_note (id,order_id,note) VALUES (?,?,?)", nRows);
    }

    /** 讓明細筆數有變化：每 3 張訂單就砍掉一筆明細（5.4.3 的 size() 要用）。 */
    protected void varyItems() {
        List<byte[]> ids = jdbc.query(
            "SELECT i.id FROM order_item i JOIN orders o ON o.id = i.order_id"
            + " WHERE MOD(CAST(SUBSTRING(o.order_no, 9) AS UNSIGNED), 3) = 1"
            + " GROUP BY i.order_id, i.id",
            (rs, n) -> rs.getBytes(1));
        java.util.Set<String> seen = new java.util.HashSet<>();
        List<Object[]> del = new ArrayList<>();
        for (byte[] id : ids) {
            String oid = jdbc.queryForObject("SELECT HEX(order_id) FROM order_item WHERE id = ?",
                    String.class, (Object) id);
            if (seen.add(oid)) del.add(new Object[]{id});
        }
        jdbc.batchUpdate("DELETE FROM order_item WHERE id = ?", del);
    }

    /** 04 章 4.9.1 的那一頁：200 張訂單、50 個客戶、每張 2 筆明細。 */
    protected void seedPage() { seed(200, 50, 2, 0); }

    protected void head(String t) { System.out.println("\n═══ " + t + " ═══"); }

    protected List<String> spy(Runnable body) {
        SqlSpy.start();
        try { body.run(); return SqlSpy.stop(); }
        catch (RuntimeException | Error e) { SqlSpy.stop(); throw e; }   // ★ 03 章踩過的坑
    }

    /** 印出這一段跑了哪些 SQL。 */
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

    protected static String cut(String s) {
        return s.length() > 150 ? s.substring(0, 150) + "…" : s;
    }

    /** 持久化情境裡有幾個 managed 實體（必須在交易內呼叫）。 */
    protected int managedEntities() {
        return em.unwrap(SessionImplementor.class).getPersistenceContext().getNumberOfManagedEntities();
    }

    protected Stats stats() { return new Stats(emf); }

    protected static class Stats {
        private final org.hibernate.stat.Statistics s;
        Stats(EntityManagerFactory emf) {
            s = emf.unwrap(org.hibernate.SessionFactory.class).getStatistics();
        }
        public void reset() { s.clear(); }
        public long stmt() { return s.getPrepareStatementCount(); }
        public long entityLoad() { return s.getEntityLoadCount(); }
        public long entityFetch() { return s.getEntityFetchCount(); }
        public long collLoad() { return s.getCollectionLoadCount(); }
        public String summary() {
            return String.format("stmt=%d entityLoad=%d entityFetch=%d collLoad=%d",
                    s.getPrepareStatementCount(), s.getEntityLoadCount(),
                    s.getEntityFetchCount(), s.getCollectionLoadCount());
        }
    }

    /** 暖機 warmup 次、取之後最快的一次（跟 00 章 0.7 / 04 章同一個做法）。 */
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

    protected long bestMicros(Runnable r, int warmup, int rounds) {
        for (int i = 0; i < warmup; i++) r.run();
        long best = Long.MAX_VALUE;
        for (int i = 0; i < rounds; i++) {
            long t0 = System.nanoTime();
            r.run();
            best = Math.min(best, System.nanoTime() - t0);
        }
        return best / 1_000;
    }
}
```

⚠️ **跑本章的測試**（04 章 4.2.2 踩過的坑：Surefire 預設只認 `*Test` 之類的名字）：

```bash
mvn test -Dtest='F*,G*' -Dsurefire.failIfNoSpecifiedTests=false
```

---

## 5.3 JPQL 不是 SQL ★★

大部分人第一次寫 JPQL，是把一句 SQL 貼進 `createQuery()`，看它報什麼錯再改。
**這條路走不遠**，因為 JPQL 跟 SQL 的差異不在語法，在**它操作的東西**：

```
SQL  操作的是【表】與【欄位】。表之間靠【外鍵的值】連起來，你要自己寫 on。
JPQL 操作的是【實體】與【屬性】。實體之間已經靠【關聯】連好了，你只要寫一個點號。
```

這一節有 **9 個實測**，每一個都在同一個地方：**那個點號**。

### 5.3.1 實測：`from` 後面接的是實體名

```java
package com.example.lab.ch05;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/** 5.3：JPQL 查的是物件，不是表。 */
class F1Jpql extends Base05 {

    @BeforeEach void setUp() { seed(30, 5, 2, 0); }

    @Test @Transactional
    void 實體名不是表名() {
        head("5.3.1 from 後面接的是【實體名】");
        showSql("select o from Ord5 o where o.status = PENDING", () ->
            em.createQuery("select o from Ord5 o where o.status = :st", Ord5.class)
              .setParameter("st", St5.PENDING).getResultList());

        // 表名是 orders、實體名是 Ord5。用表名會炸：
        try {
            em.createQuery("select o from orders o", Ord5.class).getResultList();
        } catch (Exception e) {
            System.out.println("── 用表名 orders → " + e.getClass().getSimpleName());
            System.out.println("   " + cut(String.valueOf(e.getMessage())));
        }
        // 欄位名也一樣：JPQL 認的是屬性名 orderNo，不是欄位名 order_no
        try {
            em.createQuery("select o from Ord5 o where o.order_no = 'x'", Ord5.class).getResultList();
        } catch (Exception e) {
            System.out.println("── 用欄位名 order_no → " + e.getClass().getSimpleName());
            System.out.println("   " + cut(String.valueOf(e.getMessage())));
        }
    }
}
```

```
═══ 5.3.1 from 後面接的是【實體名】 ═══
── select o from Ord5 o where o.status = PENDING → 1 句 SQL
   select o1_0.id,o1_0.customer_id,o1_0.order_no,o1_0.placed_at,o1_0.rep_id,
          o1_0.status,o1_0.total_amount from orders o1_0 where o1_0.status=?
── 用表名 orders → IllegalArgumentException
   org.hibernate.query.sqm.UnknownEntityException: Could not resolve root entity 'orders'
── 用欄位名 order_no → IllegalArgumentException
   org.hibernate.query.sqm.UnknownPathException:
   Could not resolve attribute 'order_no' of 'com.example.lab.ch05.Ord5'
```

**三個觀察**：

**① `Ord5` 是【類別名】，不是表名。**
（更精確地說是**實體名**，預設等於類別的簡單名稱，可以用 `@Entity(name = "...")` 改。）

**② `o.status` 是【屬性名】。** 欄位叫 `status` 只是巧合；
`o.orderNo` 對到的欄位是 `order_no`，而你在 JPQL 裡**永遠不會寫到 `order_no` 這四個字**。

**③ `select o` 展開成七個欄位。**
JPQL 說「給我這個實體」，Hibernate 決定「那就是這七欄」。
**這是這一章後面所有投影討論的起點**：`select o` 是一個很強的宣告，
它說的是「把這一列的每一個欄位都撈回來，變成一個有身分的物件」。

> 📌 **一句話**：
> **JPQL 是寫給【物件模型】看的，SQL 是寫給【資料表】看的。**
> **兩者之間那層翻譯，就是 01 / 02 章那些映射註解。**

### 5.3.2 實測：一個點號 = 一個 join

```java
    @Test @Transactional
    void 路徑表達式會自動join() {
        head("5.3.2 一個點號 = 一個 join");
        showSql("select o.customer.displayName from Ord5 o", () ->
            em.createQuery("select o.customer.displayName from Ord5 o", String.class).getResultList());

        showSql("兩層路徑 o.customer.tier + o.customer.displayName", () ->
            em.createQuery("select o.customer.displayName, o.customer.tier from Ord5 o", Object[].class)
              .getResultList());

        showSql("只取外鍵 o.customer.id（★ 不會 join）", () ->
            em.createQuery("select o.customer.id from Ord5 o", java.util.UUID.class).getResultList());
    }
```

```
═══ 5.3.2 一個點號 = 一個 join ═══
── select o.customer.displayName from Ord5 o → 1 句 SQL
   select c1_0.display_name from orders o1_0 join customer c1_0 on c1_0.id=o1_0.customer_id
── 兩層路徑 o.customer.tier + o.customer.displayName → 1 句 SQL
   select c1_0.display_name,c1_0.tier from orders o1_0 join customer c1_0 on c1_0.id=o1_0.customer_id
── 只取外鍵 o.customer.id（★ 不會 join） → 1 句 SQL
   select o1_0.customer_id from orders o1_0
```

**三個觀察**：

**① `o.customer.displayName` 這個「路徑表達式」（path expression）
自己長出了一個 `join customer`。** 你沒寫 `on`，它也知道要接哪一欄——
因為 `@JoinColumn(name = "customer_id")` 已經講過了。

**② 同一個關聯用兩次，只 join 一次。** Hibernate 6 會重用同一個 join。
（Hibernate 5 在某些寫法下會產生兩個 join，這件事在 6 已經修好。）

**③ `o.customer.id` 不 join。**
因為外鍵的值就在 `orders` 這張表上（`customer_id`），不必去 `customer` 撈。

> 📌 **這第三點是一個實用技巧**：
> **需要關聯物件的 id 時，寫 `o.customer.id`，不要寫 `o.getCustomer().getId()`。**
> 前者不 join；後者在 04 章 4.3.2 證明過**也**不會初始化代理，
> 但你得先把 `Ord5` 撈成實體才能呼叫它。

### 5.3.3 🔴 實測：隱式 join 是 INNER JOIN

**這是這一章最危險的一個字。**

```java
    @Test @Transactional
    void 隱式join在可為null的關聯上會吃掉資料() {
        head("5.3.3 🔴 隱式 join 是 INNER JOIN");

        long all = em.createQuery("select count(o) from Ord5 o", Long.class).getSingleResult();
        long noRep = em.createQuery("select count(o) from Ord5 o where o.rep is null", Long.class)
                       .getSingleResult();
        System.out.println("── 資料庫裡：訂單 " + all + " 張，其中 rep_id 是 null 的有 " + noRep + " 張");

        List<Object[]> implicitJoin =
            em.createQuery("select o.orderNo, o.rep.name from Ord5 o", Object[].class).getResultList();
        System.out.println("── select o.orderNo, o.rep.name from Ord5 o     → " + implicitJoin.size() + " 列");

        List<Object[]> leftJoin =
            em.createQuery("select o.orderNo, r.name from Ord5 o left join o.rep r", Object[].class)
              .getResultList();
        System.out.println("── select o.orderNo, r.name … left join o.rep r → " + leftJoin.size() + " 列");

        showSql("隱式 join 的 SQL", () ->
            em.createQuery("select o.orderNo, o.rep.name from Ord5 o", Object[].class).getResultList());
        showSql("left join 的 SQL", () ->
            em.createQuery("select o.orderNo, r.name from Ord5 o left join o.rep r", Object[].class)
              .getResultList());

        // where 裡的隱式 join 一樣會吃掉資料
        long viaPath = em.createQuery(
            "select count(o) from Ord5 o where o.rep.name <> '不存在'", Long.class).getSingleResult();
        System.out.println("── count(o) where o.rep.name <> '不存在' → " + viaPath + "（不是 " + all + "）");
    }
```

```
═══ 5.3.3 🔴 隱式 join 是 INNER JOIN ═══
── 資料庫裡：訂單 30 張，其中 rep_id 是 null 的有 10 張
── select o.orderNo, o.rep.name from Ord5 o     → 20 列
── select o.orderNo, r.name … left join o.rep r → 30 列
── 隱式 join 的 SQL → 1 句 SQL
   select o1_0.order_no,r1_0.name from orders o1_0 join sales_rep r1_0 on r1_0.id=o1_0.rep_id
── left join 的 SQL → 1 句 SQL
   select o1_0.order_no,r1_0.name from orders o1_0 left join sales_rep r1_0 on r1_0.id=o1_0.rep_id
── count(o) where o.rep.name <> '不存在' → 20（不是 30）
```

**這一段值得停下來看清楚**：

```
你要的是：「列出所有訂單，順便顯示業務員的名字（沒有就空白）」
你寫的是：select o.orderNo, o.rep.name from Ord5 o
你得到的是：只有【有業務員】的那 20 張。

沒有例外。沒有警告。少掉的那 10 張，只有你去數才會發現。
```

🔴 **而最後那一行更糟**：
`where o.rep.name <> '不存在'` 這個條件在**邏輯上**應該是「永遠成立」，
所以應該回 30。**它回 20** ——因為在條件被計算之前，
那個 `o.rep.` 已經先把 10 張訂單 join 掉了。

**兩條規則**：

> ✅ **規則一：關聯是 `optional = true`（可為 null）時，路徑表達式一律改成顯式 `left join`。**
>
> ```java
> // 🔴 不要
> select o.orderNo, o.rep.name from Ord5 o
> // ✅ 要
> select o.orderNo, r.name from Ord5 o left join o.rep r
> ```

> ✅ **規則二：`@ManyToOne(optional = false)` 的關聯，隱式 join 是安全的。**
> `o.customer.displayName` 沒有這個問題，因為 `customer_id` 是 `NOT NULL`。
>
> ⚠️ 而「安全」的前提是那個 `optional = false` **講的是真的**——
> 01 章 1.13 的三層檢查裡，資料庫的 `NOT NULL` 才是真正的保證。

📌 **這也解釋了 5.4.4 那個看起來很無辜的 `coalesce`**：

```java
// 想「把 null 的業務員換成『（無業務）』」
select o.orderNo, coalesce(o.rep.name, '（無業務）') from Ord5 o
```

**`coalesce` 一次都不會被觸發**——因為那 10 張訂單根本沒進到結果集裡。
5.4.4 有這個實測。

### 5.3.4 join 的五種寫法

JPQL 的 join 有五種，而它們解決的是不同的問題：

| 寫法 | 意思 | 什麼時候用 |
|---|---|---|
| `join o.items i` | 沿著**關聯**做 inner join | 要用明細當條件 |
| `left join o.rep r` | 沿著關聯做 outer join | 關聯可為 null（5.3.3） |
| `join fetch o.items` | join **並且**把集合載入物件 | 要用明細的資料（04 章 4.5） |
| `join Prod5 p on ...` | 跟**沒有關聯的實體**做 join | 兩個實體之間沒映射關聯 |
| `join o.items i with i.qty > 1` | 在 **join 條件**上加限制 | 見下面的 ⚠️ |

⚠️ **`with`（HQL）／ `on`（JPA 2.1 起）加在 join 條件上，
跟加在 `where` 上是【不同的意思】** ——這在 `left join` 上差很多：

```sql
-- 條件在 join 上：客戶全部保留，只是「符合條件的訂單」才接上來
from Cust5 c left join c.orders o with o.status = CANCELLED
-- 條件在 where 上：沒有取消單的客戶【整個消失】（等於變回 inner join）
from Cust5 c left join c.orders o where o.status = CANCELLED
```

⚠️ 而 04 章 4.6.7 證明過：**`join fetch` 不能加 `with` / `on`**
（`SemanticException: Fetch join has a 'with' clause`），
硬把條件放 `where` 會得到**被靜默過濾的集合**。

### 5.3.5 實測：`join` 不等於 `join fetch`，而 `count` 會對不上 ★★

```java
package com.example.lab.ch05;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/** 5.3.5：join 到底回傳幾筆？ */
class F1bJoin extends Base05 {

    @BeforeEach void setUp() { seed(10, 2, 3, 0); }

    private void one(String jpql, java.util.function.Supplier<Integer> f) {
        List<String> sqls = spy(() -> f.get());
        int n = f.get();
        System.out.printf("  %-52s → %2d 筆%n", jpql, n);
        System.out.println("      SQL: " + cut(sqls.get(0)));
        em.clear();
    }

    @Test @Transactional
    void join回傳幾筆() {
        head("5.3.5 join 的結果筆數（10 張訂單，每張 3 筆明細 → SQL 會回 30 列）");

        Long rows = jdbc.queryForObject(
            "select count(*) from orders o join order_item i on i.order_id = o.id", Long.class);
        System.out.println("  【對照】SQL 直接跑 inner join → " + rows + " 列\n");

        one("select o from Ord5 o join o.items i", () ->
            em.createQuery("select o from Ord5 o join o.items i", Ord5.class).getResultList().size());

        one("select distinct o from Ord5 o join o.items i", () ->
            em.createQuery("select distinct o from Ord5 o join o.items i", Ord5.class)
              .getResultList().size());

        one("select o.orderNo from Ord5 o join o.items i", () ->
            em.createQuery("select o.orderNo from Ord5 o join o.items i", String.class)
              .getResultList().size());

        one("select o, i from Ord5 o join o.items i", () ->
            em.createQuery("select o, i from Ord5 o join o.items i", Object[].class)
              .getResultList().size());

        one("select count(o) from Ord5 o join o.items i", () ->
            em.createQuery("select count(o) from Ord5 o join o.items i", Long.class)
              .getSingleResult().intValue());

        one("select count(distinct o) from Ord5 o join o.items i", () ->
            em.createQuery("select count(distinct o) from Ord5 o join o.items i", Long.class)
              .getSingleResult().intValue());

        System.out.println("\n  ★ 一個查詢的【結果筆數】與它的【count】對不上 —— 分頁會算錯。");
    }

    @Test @Transactional
    void join沒有載入集合() {
        head("5.3.5 join 不會載入集合");
        List<Ord5> os = em.createQuery("select o from Ord5 o join o.items i", Ord5.class).getResultList();
        System.out.println("  join      → items 初始化了嗎？"
            + org.hibernate.Hibernate.isInitialized(os.get(0).getItems()));
        em.clear();
        List<Ord5> fs = em.createQuery("select o from Ord5 o join fetch o.items i", Ord5.class).getResultList();
        System.out.println("  join fetch → items 初始化了嗎？"
            + org.hibernate.Hibernate.isInitialized(fs.get(0).getItems()));
        System.out.println("\n  ★ join 決定【SQL 怎麼連表】；join fetch 決定【要不要把關聯載進物件】。");
    }
}
```

```
═══ 5.3.5 join 的結果筆數（10 張訂單，每張 3 筆明細 → SQL 會回 30 列） ═══
  【對照】SQL 直接跑 inner join → 30 列

  select o from Ord5 o join o.items i                  → 10 筆
      SQL: select o1_0.id,…,o1_0.total_amount from orders o1_0 join order_item i1_0 on o1_0.id=i1_0.order_id
  select distinct o from Ord5 o join o.items i         → 10 筆
      SQL: select distinct o1_0.id,… from orders o1_0 join order_item i1_0 on …
  select o.orderNo from Ord5 o join o.items i          → 30 筆
      SQL: select o1_0.order_no from orders o1_0 join order_item i1_0 on o1_0.id=i1_0.order_id
  select o, i from Ord5 o join o.items i               → 30 筆
      SQL: select o1_0.id,…,i1_0.id,… from orders o1_0 join order_item i1_0 on …
  select count(o) from Ord5 o join o.items i           → 30 筆
      SQL: select count(o1_0.id) from orders o1_0 join order_item i1_0 on o1_0.id=i1_0.order_id
  select count(distinct o) from Ord5 o join o.items i  → 10 筆
      SQL: select count(distinct o1_0.id) from orders o1_0 join order_item i1_0 on …

  ★ 一個查詢的【結果筆數】與它的【count】對不上 —— 分頁會算錯。

═══ 5.3.5 join 不會載入集合 ═══
  join      → items 初始化了嗎？false
  join fetch → items 初始化了嗎？true
```

**四個觀察**：

**① `select o … join o.items i` 回 10 筆，而 SQL 回 30 列。**
資料庫回了 30 列，Hibernate 6 把「同一個實體」去重成 10 個。
（04 章 4.5.3 已經測過同一件事：**Hibernate 6 的實體查詢自動去重，
`distinct` 不再需要**。這裡確認了它不只在 `join fetch` 上成立，
在普通的 `join` 上也一樣。）

**② 而「去重」只發生在【單一實體】的結果上。**
`select o.orderNo`（純量）與 `select o, i`（tuple）都是 30 筆。

> 📌 **判準**：`select` 後面**只有一個實體別名**時去重；
> 其他情況（純量、tuple、DTO）**照 SQL 的列數回傳**。

**③ 🔴 `count(o)` 回 30，而 `select o` 回 10。**

```
同一個 from + where，兩個問題：
  「這個查詢有幾筆結果？」   → 10
  「count 這個查詢是多少？」 → 30
```

**這就是分頁總筆數算錯的機制。** Spring Data 的 `Page` 會自動生一句 count（5.7.4），
而那句 count 是照 `from` 子句生的——**只要 `from` 裡有 to-many 的 join，
總筆數就會被放大**。要修，得自己寫 `countQuery` 用 `count(distinct o)`。

**④ `join` 不會初始化集合。**
這是 04 章反覆講的那件事的另一面：
`join` 是**給 SQL 看的**（要不要連表），`join fetch` 是**給物件看的**（要不要載進來）。

> ⚠️ **所以 `select o from Ord5 o join o.items i` 是一個很常見的 N+1 溫床**：
> 你以為「都 join 了應該有資料吧」，接著在迴圈裡 `o.getItems()`，
> 於是打出 04 章那 200 句。

### 5.3.6 實測：`select` 什麼，決定持久化情境裡有什麼

```java
    @Test @Transactional
    void 查實體進pc查投影不進pc() {
        head("5.3.6 select 什麼，決定了持久化情境裡有什麼");
        em.clear();
        System.out.println("── 起點：PC 裡 " + managedEntities() + " 個實體");

        em.createQuery("select o from Ord5 o", Ord5.class).getResultList();
        System.out.println("── select o          → PC 裡 " + managedEntities() + " 個實體");

        em.clear();
        em.createQuery("select o.orderNo, o.totalAmount from Ord5 o", Object[].class).getResultList();
        System.out.println("── select o.orderNo… → PC 裡 " + managedEntities() + " 個實體");

        em.clear();
        em.createQuery("select o.customer from Ord5 o", Cust5.class).getResultList();
        System.out.println("── select o.customer → PC 裡 " + managedEntities() + " 個實體（★ 也是實體）");
    }
```

```
═══ 5.3.6 select 什麼，決定了持久化情境裡有什麼 ═══
── 起點：PC 裡 0 個實體
── select o          → PC 裡 30 個實體
── select o.orderNo… → PC 裡 0 個實體
── select o.customer → PC 裡 5 個實體（★ 也是實體）
```

**三個觀察**：

**① `select o` 把 30 個實體放進持久化情境。**
於是它們有一級快取、有快照、會被髒檢查、交易結束時可能產生 `UPDATE`（03 章）。

**② `select o.orderNo, o.totalAmount` 放進去 0 個。**
回來的是兩個 `Object`，**它們不是實體、沒有身分、改了也不會寫回資料庫**。

**③ `select o.customer` 放進去 5 個** —— 30 張訂單、5 個客戶，
而一級快取保證「同一個 id 只有一個物件」（03 章 3.2），所以是 5 不是 30。

> 📌 **這一格就是 5.8 的全部理由**：
> **「要不要進持久化情境」不是設定出來的，是你在 `select` 後面寫什麼決定的。**

### 5.3.7 六個根本差異

| # | SQL | JPQL |
|---|---|---|
| 1 | `from orders` —— **表名** | `from Ord5` —— **實體名**（5.3.1） |
| 2 | `o.order_no` —— **欄位名** | `o.orderNo` —— **屬性名**（5.3.1） |
| 3 | `join customer c on c.id = o.customer_id` | `o.customer` 或 `join o.customer c` —— **關聯已經定義好了**（5.3.2） |
| 4 | join 一定寫得出 `inner` / `left` | **點號的隱式 join 一律是 inner** 🔴（5.3.3） |
| 5 | `select *` 回來的是**列**，你自己決定怎麼用 | `select o` 回來的是**有身分的實體**，它會進持久化情境（5.3.6） |
| 6 | 結果筆數 = SQL 的列數 | **單一實體的結果會去重**，跟列數可能不同（5.3.5） |

📌 **而第 7 個差異，是這一章要花最多篇幅的**：

```
SQL  沒有「回傳型別」這個概念 —— 回來就是一堆列，你自己組。
JPQL 有 —— 而且它有【四種】：實體、純量、tuple、DTO。
     選錯的代價，就是 4.9.1 那 650 個實體。（5.8）
```

---

## 5.4 JPQL 語法全覽

### 5.4.1 一句 JPQL 的骨架

```
select   ← 要什麼（實體 / 屬性 / 聚合 / 建構子表達式）
from     ← 從哪個實體出發
  join   ← 沿著哪些關聯展開
where    ← 條件
group by ← 分組
having   ← 分組後的條件
order by ← 排序
```

跟 SQL 一模一樣的七段。**而每一段裡都有一兩件跟 SQL 不一樣的事**，
這一節逐段測過去。本節的測試類別：

```java
package com.example.lab.ch05;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/** 5.4：JPQL 語法全覽。 */
class F2Syntax extends Base05 {

    @BeforeEach void setUp() {
        seed(30, 5, 2, 1);
        varyItems();                       // 三分之一的訂單只剩 1 筆明細
        jdbc.update("""
            DELETE n FROM order_note n JOIN orders o ON o.id = n.order_id
             WHERE MOD(CAST(SUBSTRING(o.order_no, 9) AS UNSIGNED), 2) = 0
            """);                          // 一半的訂單沒有備註
        // 一個名字裡真的有底線與百分比的商品：5.4.2 的 escape 要用
        jdbc.update("UPDATE product SET name = '100%_純棉毛巾' WHERE sku = 'SKU-0'");
    }

    private void sql(String label, String jpql) {
        List<String> sqls = spy(() -> em.createQuery(jpql).getResultList());
        System.out.printf("  %s%n    JPQL: %s%n    SQL : %s%n", label,
                jpql.replaceAll("\\s+", " ").trim(), cut(sqls.get(0)));
        em.clear();
    }

    private long count(String jpql) {
        return em.createQuery(jpql, Long.class).getSingleResult();
    }

    // …以下每一節一個 @Test
}
```

### 5.4.2 實測：`where` 能寫什麼

```java
    @Test @Transactional
    void where的運算子() {
        head("5.4.2 where 能寫什麼");
        System.out.println("  between  → " + count(
            "select count(o) from Ord5 o where o.totalAmount between 200 and 250"));
        System.out.println("  in       → " + em.createQuery(
            "select count(o) from Ord5 o where o.status in (:sts)", Long.class)
            .setParameter("sts", List.of(St5.PENDING, St5.CANCELLED)).getSingleResult());
        System.out.println("  like     → " + count(
            "select count(o) from Ord5 o where o.orderNo like 'SO-2026-00001%'"));
        System.out.println("  is null  → " + count("select count(o) from Ord5 o where o.rep is null"));
        System.out.println("  比較實體  → " + em.createQuery(
            "select count(o) from Ord5 o where o.customer = :c", Long.class)
            .setParameter("c", em.getReference(Cust5.class, customerIds.get(0))).getSingleResult()
            + "   ★ 參數可以直接是【實體】，不必拆成 id");

        List<String> s = spy(() -> em.createQuery(
            "select count(o) from Ord5 o where o.customer = :c", Long.class)
            .setParameter("c", em.getReference(Cust5.class, customerIds.get(0))).getSingleResult());
        System.out.println("    → SQL: " + cut(s.get(0)));

        System.out.println("\n  escape：商品名稱是 '100%_純棉毛巾'");
        System.out.println("  like '%_%'               → " + count(
            "select count(p) from Prod5 p where p.name like '%_%'")
            + " 🔴 _ 是萬用字元，配到全部 6 個商品");
        System.out.println("  like '%!_%' escape '!'   → " + count(
            "select count(p) from Prod5 p where p.name like '%!_%' escape '!'") + " ✅ 只配到那一個");
        System.out.println("  like '%!%!_%' escape '!' → " + count(
            "select count(p) from Prod5 p where p.name like '%!%!_%' escape '!'") + " ✅ %_ 兩個都跳脫");
    }
```

```
═══ 5.4.2 where 能寫什麼 ═══
  between  → 26
  in       → 30
  like     → 10
  is null  → 10
  比較實體  → 6   ★ 參數可以直接是【實體】，不必拆成 id
    → SQL: select count(o1_0.id) from orders o1_0 where o1_0.customer_id=?

  escape：商品名稱是 '100%_純棉毛巾'
  like '%_%'               → 6 🔴 _ 是萬用字元，配到全部 6 個商品
  like '%!_%' escape '!'   → 1 ✅ 只配到那一個
  like '%!%!_%' escape '!' → 1 ✅ %_ 兩個都跳脫
```

**三個觀察**：

**① `where o.customer = :c` 的參數可以直接是實體。**
產生的 SQL 是 `where o1_0.customer_id = ?`——**它只用了 id，沒有 join**。
所以傳一個 `getReference()` 拿到的代理進去也完全沒問題（04 章 4.3.2）。

**② `like` 裡的 `_` 是萬用字元。**
`'%_%'` 配到全部 6 個商品，因為每個名字都至少有一個字。
要找**真的有底線的**，得用 `escape` 明講。

> ⚠️ **不要靠反斜線。** MySQL 預設把 `\` 當跳脫字元，
> 但那是 MySQL 的行為、不是 SQL 標準，換成 PostgreSQL 的
> `standard_conforming_strings` 就不一樣了。
> **`escape '!'`（或任何一個不會出現在資料裡的字元）是唯一可攜的寫法。**

**③ 使用者輸入的搜尋字串要先跳脫。**
使用者打 `100%`，你組出 `like '%100%%'`，**那個 `%` 是萬用字元**——
搜尋結果會多出一堆不相干的東西。5.9.4 的動態搜尋會處理這件事。

**其他 `where` 能用的**：

```
=  <>  >  >=  <  <=        比較
between … and              區間（含兩端）
in (…)  not in (…)         列舉（參數可以是集合）
like  not like  … escape   字串比對
is null  is not null       null 檢查（★ 不能寫 = null）
and  or  not               邏輯
```

### 5.4.3 實測：集合怎麼寫條件

**SQL 沒有「集合」這個概念，JPQL 有** —— 所以它多了三個運算子。

```java
    @Test @Transactional
    void 集合的條件() {
        head("5.4.3 集合怎麼寫條件");
        System.out.println("  size(o.items) = 1  → " + count(
            "select count(o) from Ord5 o where size(o.items) = 1"));
        System.out.println("  size(o.items) = 2  → " + count(
            "select count(o) from Ord5 o where size(o.items) = 2"));
        sql("size() 產生的 SQL：", "select o.orderNo from Ord5 o where size(o.items) = 1");

        System.out.println("\n  o.notes is empty     → " + count(
            "select count(o) from Ord5 o where o.notes is empty"));
        System.out.println("  o.notes is not empty → " + count(
            "select count(o) from Ord5 o where o.notes is not empty"));
        sql("is empty 產生的 SQL：", "select o.orderNo from Ord5 o where o.notes is empty");

        Item5 anItem = em.createQuery("select i from Item5 i", Item5.class)
                         .setMaxResults(1).getResultList().get(0);
        System.out.println("\n  :i member of o.items → " + em.createQuery(
            "select count(o) from Ord5 o where :i member of o.items", Long.class)
            .setParameter("i", anItem).getSingleResult());
        List<String> s = spy(() -> em.createQuery(
            "select count(o) from Ord5 o where :i member of o.items", Long.class)
            .setParameter("i", anItem).getSingleResult());
        System.out.println("    → SQL: " + cut(s.get(0)));
        em.clear();
    }
```

```
═══ 5.4.3 集合怎麼寫條件 ═══
  size(o.items) = 1  → 10
  size(o.items) = 2  → 20
  size() 產生的 SQL：
    JPQL: select o.orderNo from Ord5 o where size(o.items) = 1
    SQL : select o1_0.order_no from orders o1_0
           where (select count(1) from order_item i1_0 where o1_0.id=i1_0.order_id)=1

  o.notes is empty     → 15
  o.notes is not empty → 15
  is empty 產生的 SQL：
    JPQL: select o.orderNo from Ord5 o where o.notes is empty
    SQL : select o1_0.order_no from orders o1_0
           where not exists(select 1 from order_note n1_0 where o1_0.id=n1_0.order_id)

  :i member of o.items → 1
    → SQL: select count(o1_0.id) from orders o1_0
            where ? in (select i1_0.id from order_item i1_0 where o1_0.id=i1_0.order_id)
```

**三個觀察**：

**① `size(o.items)` 變成一句相關子查詢的 `count`。**
它**不會**把集合載入（04 章 4.3.4 的 `Hibernate.size()` 是同一件事）。

**② `is empty` 變成 `not exists`，不是 `count(...) = 0`。**
這是對的：`not exists` 一旦找到一列就可以停，`count` 要數完。

**③ `member of` 變成 `? in (子查詢)`。**

⚠️ **這三個都是子查詢，都會對每一列跑一次。**
30 張訂單無感；30 萬張訂單上，`where size(o.items) = 1` 會很慘。
**要在大表上做這種條件，改成 `group by … having count(…)` 或用投影（5.8）。**

### 5.4.4 實測：函式

```java
    @Test @Transactional
    void 函式() {
        head("5.4.4 JPQL 內建函式");
        // ★ SO-2026-000002 有業務員（i=1）；SO-2026-000001 沒有（i=0）
        Object[] r = em.createQuery("""
                select concat(o.orderNo, ' / ', str(o.status)),
                       substring(o.orderNo, 4, 4),
                       length(o.orderNo),
                       upper(o.customer.displayName),
                       o.totalAmount * 1.05,
                       abs(o.totalAmount - 300)
                  from Ord5 o where o.orderNo = 'SO-2026-000002'
                """, Object[].class).getSingleResult();
        String[] names = {"concat", "substring", "length", "upper", "算術", "abs"};
        for (int i = 0; i < r.length; i++) System.out.printf("  %-10s → %s%n", names[i], r[i]);

        System.out.println("\n  coalesce（把 null 換掉）：");
        List<Object[]> co = em.createQuery("""
                select o.orderNo, coalesce(r.name, '（無業務）')
                  from Ord5 o left join o.rep r order by o.orderNo
                """, Object[].class).setMaxResults(3).getResultList();
        co.forEach(x -> System.out.println("    " + x[0] + " → " + x[1]));

        System.out.println("\n  🔴 但是寫成 coalesce(o.rep.name, …) 就沒有用了：");
        long a = count("select count(o) from Ord5 o");
        long b = count("select count(o) from Ord5 o left join o.rep r"
                     + " where coalesce(r.name,'X') is not null");
        long c = count("select count(o) from Ord5 o where coalesce(o.rep.name,'X') is not null");
        System.out.println("    全部訂單                                → " + a);
        System.out.println("    left join o.rep r + coalesce(r.name…)  → " + b + " ✅");
        System.out.println("    coalesce(o.rep.name, 'X')              → " + c
            + " 🔴（隱式 join 在 coalesce 算之前就把資料濾掉了）");

        System.out.println("\n  case：");
        em.createQuery("""
                select o.orderNo,
                       case when o.totalAmount > 240 then '大單'
                            when o.totalAmount > 210 then '中單'
                            else '小單' end
                  from Ord5 o order by o.orderNo
                """, Object[].class).setMaxResults(4).getResultList()
          .forEach(x -> System.out.println("    " + x[0] + " → " + x[1]));

        System.out.println("\n  日期：");
        Object[] d = em.createQuery("""
                select year(o.placedAt), month(o.placedAt), day(o.placedAt),
                       extract(hour from o.placedAt), current_date
                  from Ord5 o where o.orderNo = 'SO-2026-000002'
                """, Object[].class).getSingleResult();
        System.out.println("    year=" + d[0] + " month=" + d[1] + " day=" + d[2]
            + " hour=" + d[3] + " current_date=" + d[4]);
        sql("year() 產生的 SQL：", "select year(o.placedAt) from Ord5 o");
    }
```

```
═══ 5.4.4 JPQL 內建函式 ═══
  concat     → SO-2026-000002 / PENDING
  substring  → 2026
  length     → 14
  upper      → 客戶1
  算術         → 220.5
  abs        → 90.0000

  coalesce（把 null 換掉）：
    SO-2026-000001 → （無業務）
    SO-2026-000002 → 業務1
    SO-2026-000003 → 業務2

  🔴 但是寫成 coalesce(o.rep.name, …) 就沒有用了：
    全部訂單                                → 30
    left join o.rep r + coalesce(r.name…)  → 30 ✅
    coalesce(o.rep.name, 'X')              → 20 🔴（隱式 join 在 coalesce 算之前就把資料濾掉了）

  case：
    SO-2026-000001 → 小單
    SO-2026-000002 → 小單
    SO-2026-000003 → 中單
    SO-2026-000004 → 中單

  日期：
    year=2026 month=9 day=1 hour=0 current_date=2026-09-07
  year() 產生的 SQL：
    JPQL: select year(o.placedAt) from Ord5 o
    SQL : select year(o1_0.placed_at) from orders o1_0
```

**兩個觀察**：

**① 🔴 `coalesce(o.rep.name, 'X')` 那一格，就是 5.3.3 的後果。**

```
你寫 coalesce 的動機是：「rep 可能是 null，我來處理它」
而 o.rep. 這個點號的效果是：「rep 是 null 的那些列，先刪掉」
   ↓
coalesce 一次都沒被觸發。而查詢不會報錯。
```

**這是 5.3.3 那條規則值得背下來的原因**：**看到可為 null 的關聯，先寫 `left join`。**

**② `substring` 的索引從 1 開始，不是 0。**
`substring(o.orderNo, 4, 4)` 拿到 `2026`（`SO-2026-000002` 的第 4～7 個字元）。
**這跟 Java 的 `String.substring` 不一樣**，而且第三個參數是**長度**不是結束位置。

**JPQL 規格內建的函式清單**（Jakarta Persistence 3.1）：

| 類別 | 函式 |
|---|---|
| 字串 | `concat` `substring` `trim` `lower` `upper` `length` `locate` `replace` `left` `right` |
| 數值 | `abs` `sqrt` `mod` `ceiling` `floor` `round` `exp` `ln` `power` `sign` |
| 日期 | `current_date` `current_time` `current_timestamp` `local date` `local time` `extract` `year` `month` `day` `hour` `minute` `second` |
| 其他 | `coalesce` `nullif` `case … when … then … else … end` `size` `index` `type` `cast` `str` |

⚠️ **不在這張表上的函式，用 `function('名字', 參數…)` 呼叫**：

```java
// MySQL 的 JSON_EXTRACT，JPQL 沒有
select function('json_extract', o.payload, '$.trackingNo') from Ord5 o
```

**代價是**：這句 JPQL 綁死了 MySQL。換資料庫要改查詢。
**這是「JPQL 的可攜性」開始漏水的第一個地方**——而 5.4.8 是第二個。

### 5.4.5 實測：聚合與分組

```java
    @Test @Transactional
    void 聚合與分組() {
        head("5.4.5 聚合、group by、having");

        List<Object[]> byTier = em.createQuery("""
                select c.tier, count(o), sum(o.totalAmount), avg(o.totalAmount),
                       min(o.totalAmount), max(o.totalAmount)
                  from Ord5 o join o.customer c
                 group by c.tier
                 order by c.tier
                """, Object[].class).getResultList();
        System.out.printf("  %-8s %5s %12s %14s %10s %10s%n",
                "等級", "張數", "總額", "平均", "最小", "最大");
        for (Object[] r : byTier)
            System.out.printf("  %-8s %5s %12s %14s %10s %10s%n", r[0], r[1], r[2], r[3], r[4], r[5]);

        System.out.println("\n  having：只留張數 > 10 的等級");
        em.createQuery("""
                select c.tier, count(o) from Ord5 o join o.customer c
                 group by c.tier having count(o) > 10
                """, Object[].class).getResultList()
          .forEach(r -> System.out.println("    " + r[0] + " → " + r[1]));

        System.out.println("\n  left join + count（每個客戶有幾張金額 > 250 的訂單；客戶4 一張也沒有）：");
        System.out.printf("    %-8s %10s %12s%n", "客戶", "count(o)", "count(o.id)");
        List<Object[]> bad = em.createQuery("""
                select c.displayName, count(o), count(o.id)
                  from Cust5 c left join c.orders o with o.totalAmount > 250
                 group by c.displayName order by c.displayName
                """, Object[].class).getResultList();
        for (Object[] r : bad) System.out.printf("    %-8s %10s %12s%n", r[0], r[1], r[2]);

        List<String> s = spy(() -> em.createQuery("""
                select c.displayName, count(o), count(o.id)
                  from Cust5 c left join c.orders o with o.totalAmount > 250
                 group by c.displayName
                """, Object[].class).getResultList());
        System.out.println("    → SQL: " + cut(s.get(0)));
        System.out.println("    ★ Hibernate 6 把 count(o) 直接翻成 count(o.id) —— 兩欄一模一樣。");

        System.out.println("\n  count(distinct …) 與 sum 的 null：");
        Object[] x = em.createQuery("""
                select count(distinct o.customer), sum(o.totalAmount), count(o.rep)
                  from Ord5 o left join o.rep
                """, Object[].class).getSingleResult();
        System.out.println("    不重複客戶=" + x[0] + "  總額=" + x[1] + "  有業務的訂單=" + x[2]);
    }
```

```
═══ 5.4.5 聚合、group by、having ═══
  等級          張數           總額             平均         最小         最大
  GOLD         6    1370.0000   228.33333333   200.0000   260.0000
  NORMAL      12    2750.0000   229.16666667   200.0000   260.0000
  SILVER      12    2730.0000          227.5   200.0000   260.0000

  having：只留張數 > 10 的等級
    SILVER → 12
    NORMAL → 12

  left join + count（每個客戶有幾張金額 > 250 的訂單；客戶4 一張也沒有）：
    客戶         count(o)  count(o.id)
    客戶0               1            1
    客戶1               1            1
    客戶2               1            1
    客戶3               1            1
    客戶4               0            0
    → SQL: select c1_0.display_name,count(o1_0.id),count(o1_0.id) from customer c1_0
           left join orders o1_0 on c1_0.id=o1_0.customer_id and o1_0.total_amount>250 group by …
    ★ Hibernate 6 把 count(o) 直接翻成 count(o.id) —— 兩欄一模一樣。

  count(distinct …) 與 sum 的 null：
    不重複客戶=5  總額=6850.0000  有業務的訂單=20
```

**四個觀察**：

**① ★ 一條流傳很廣的規則，在 Hibernate 6 已經不成立了。**

那條規則是：

> 「`left join` 之後要寫 `count(o.id)` 不能寫 `count(o)`，
> 否則沒有關聯資料的那一列會被算成 1。」

**它的來源是真的**：`count(*)` 會把 outer join 產生的 null 列算進去。
**而 Hibernate 6 把 `count(o)` 翻譯成 `count(o1_0.id)`** ——
`count(欄位)` 忽略 null，所以「客戶4」那一列拿到 0，是對的。

實測那兩欄**一模一樣**，連 SQL 都是 `count(o1_0.id),count(o1_0.id)`。

> ⚠️ **但這不代表你可以不管它。**
> 真正會出事的是 **`count(*)`**（JPQL 沒有這個寫法，但原生 SQL 有，5.11），
> 以及 **Spring Data 自動生成的 count 查詢**（5.7.4）——
> 那一句是 Hibernate 照 `from` 生的，遇到 to-many 的 join 就會放大（5.3.5 的第 ③ 點）。

**② `avg` 回來的是 `Double`，不是 `BigDecimal`。**
上面 `228.33333333` 那個值——`sum` 保持 `BigDecimal`，`avg` 變 `Double`。
**做金額報表時這是一個實際的坑**：`avg` 的結果再拿去加總會有浮點誤差。
要精確就自己算 `sum / count`。

**③ `group by` 後面只能放 `select` 裡有的東西**（跟 SQL 一樣的規則），
而 JPQL 有一個 SQL 沒有的方便處：**`group by c` 可以直接分組整個實體**，
Hibernate 會展開成主鍵。

**④ `count(o.rep)` = 20** —— 聚合函式忽略 null，這跟 SQL 一致。

### 5.4.6 實測：子查詢

```java
    @Test @Transactional
    void 子查詢() {
        head("5.4.6 子查詢");

        System.out.println("  exists（有買過 3C 的客戶）→ " + count("""
                select count(c) from Cust5 c
                 where exists (select 1 from Ord5 o join o.items i
                                where o.customer = c and i.product.category = '3C')
                """));

        System.out.println("  = (select max(...))       → " + count("""
                select count(o) from Ord5 o
                 where o.totalAmount = (select max(o2.totalAmount) from Ord5 o2)
                """));

        System.out.println("\n  相關子查詢（每張訂單的明細數）：");
        em.createQuery("""
                select o.orderNo, (select count(i) from Item5 i where i.order = o)
                  from Ord5 o order by o.orderNo
                """, Object[].class).setMaxResults(3).getResultList()
          .forEach(r -> System.out.println("    " + r[0] + " → " + r[1] + " 筆"));

        System.out.println("\n  > all（比【每一張】取消單都貴）→ " + em.createQuery("""
                select count(o) from Ord5 o
                 where o.totalAmount > all (select o2.totalAmount from Ord5 o2 where o2.status = :st)
                """, Long.class).setParameter("st", St5.CANCELLED).getSingleResult());
        System.out.println("  > any（比【任何一張】取消單貴）→ " + em.createQuery("""
                select count(o) from Ord5 o
                 where o.totalAmount > any (select o2.totalAmount from Ord5 o2 where o2.status = :st)
                """, Long.class).setParameter("st", St5.CANCELLED).getSingleResult());

        System.out.println("\n  🔴 JPA 規格：子查詢【不能】出現在 from。Hibernate 6 呢？");
        try {
            List<Object[]> r = em.createQuery("""
                select x.no, x.n from (select o.orderNo as no, size(o.items) as n from Ord5 o) x
                 where x.n = 1
                """, Object[].class).setMaxResults(2).getResultList();
            System.out.println("    ✅ Hibernate 6 支援 from 子查詢，回了 " + r.size() + " 列：");
            r.forEach(y -> System.out.println("      " + y[0] + " / " + y[1]));
        } catch (Exception e) {
            System.out.println("    " + e.getClass().getSimpleName() + ": "
                + cut(String.valueOf(e.getMessage())));
        }
    }
```

```
═══ 5.4.6 子查詢 ═══
  exists（有買過 3C 的客戶）→ 5
  = (select max(...))       → 4

  相關子查詢（每張訂單的明細數）：
    SO-2026-000001 → 1 筆
    SO-2026-000002 → 2 筆
    SO-2026-000003 → 2 筆

  > all（比【每一張】取消單都貴）→ 0
  > any（比【任何一張】取消單貴）→ 25

  🔴 JPA 規格：子查詢【不能】出現在 from。Hibernate 6 呢？
    ✅ Hibernate 6 支援 from 子查詢，回了 2 列：
      SO-2026-000001 / 1
      SO-2026-000004 / 1
```

**三個觀察**：

**① 子查詢裡可以直接比較實體**：`where o.customer = c` ——
`c` 是外層的別名，這是相關子查詢（correlated subquery）。

**② `> all` 回 0 是對的**：資料裡的最大金額 260 也出現在取消單裡，
所以「比每一張取消單都貴」沒有任何一張符合。
`> any` 是「比最小的那一張貴」，25 張符合。

**③ JPA 規格明文禁止 `from` 裡放子查詢，而 Hibernate 6 支援它。**
這是 5.4.8 的預告：**你寫的東西能跑，不代表它是 JPQL。**

### 5.4.7 實測：排序與分頁

```java
    @Test @Transactional
    void 排序與分頁() {
        head("5.4.7 order by 與分頁");
        sql("order by 兩個欄位：",
            "select o.orderNo from Ord5 o order by o.status asc, o.placedAt desc");

        System.out.println("  null 排在哪（nulls first）：");
        em.createQuery("""
                select o.orderNo, r.name from Ord5 o left join o.rep r
                 order by r.name nulls first, o.orderNo
                """, Object[].class).setMaxResults(3).getResultList()
          .forEach(r -> System.out.println("    " + r[0] + " rep=" + r[1]));
        sql("nulls first 的 SQL：",
            "select o.orderNo from Ord5 o left join o.rep r order by r.name nulls first");
        sql("nulls last 的 SQL：",
            "select o.orderNo from Ord5 o left join o.rep r order by r.name nulls last");

        System.out.println("\n  分頁靠 setFirstResult / setMaxResults，不是 JPQL 語法：");
        List<String> sqls = spy(() -> em.createQuery(
                "select o.orderNo from Ord5 o order by o.placedAt", String.class)
                .setFirstResult(10).setMaxResults(5).getResultList());
        System.out.println("    " + cut(sqls.get(0)));

        System.out.println("\n  Hibernate 6 的 HQL 也可以直接寫 limit / offset：");
        List<String> h = spy(() -> em.createQuery(
            "select o.orderNo from Ord5 o order by o.placedAt offset 10 rows fetch first 5 rows only",
            String.class).getResultList());
        System.out.println("    ✅ " + cut(h.get(0)));
    }
```

```
═══ 5.4.7 order by 與分頁 ═══
  order by 兩個欄位：
    SQL : select o1_0.order_no from orders o1_0 order by o1_0.status,o1_0.placed_at desc
  null 排在哪（nulls first）：
    SO-2026-000001 rep=null
    SO-2026-000004 rep=null
    SO-2026-000007 rep=null
  nulls first 的 SQL：
    SQL : select o1_0.order_no from orders o1_0 left join sales_rep r1_0 on r1_0.id=o1_0.rep_id
           order by r1_0.name
  nulls last 的 SQL：
    SQL : select o1_0.order_no from orders o1_0 left join sales_rep r1_0 on r1_0.id=o1_0.rep_id
           order by case when (r1_0.name) is null then 1 else 0 end,r1_0.name

  分頁靠 setFirstResult / setMaxResults，不是 JPQL 語法：
    select o1_0.order_no from orders o1_0 order by o1_0.placed_at limit ?,?

  Hibernate 6 的 HQL 也可以直接寫 limit / offset：
    ✅ select o1_0.order_no from orders o1_0 order by o1_0.placed_at limit 10,5
```

**三個觀察**：

**① `nulls first` 在 MySQL 上什麼都沒生成，`nulls last` 生成了一個 `case`。**
因為 MySQL 的 `ORDER BY ... ASC` 本來就把 null 排前面——
Hibernate 知道方言的預設行為，**只在需要改變它時才產生額外的 SQL**。
（PostgreSQL 的預設相反，同一句 JPQL 會生成不同的 SQL。這是 ORM 有價值的地方之一。）

**② 分頁不是 JPQL 的語法，是 API。**
`setFirstResult` / `setMaxResults` 會被翻成方言對應的 `limit` / `offset` / `fetch first`。
**這是好事**：同一句 JPQL 在 MySQL、PostgreSQL、Oracle 上都能分頁。

**③ 而 Hibernate 6 的 HQL 支援直接寫 `offset … fetch first … rows only`。**
它一樣是**擴充**，不是 JPQL。

⚠️ **`order by` 少了會出事**：
沒有 `order by` 的分頁查詢，資料庫**不保證**兩次查詢的順序一樣——
第 1 頁和第 2 頁可能出現同一筆、也可能有一筆兩頁都沒出現。
**分頁查詢一定要有一個唯一的排序尾（例如 `order by o.placedAt desc, o.id desc`）。**
（06-repository 04 章 keyset 分頁講過同一件事。）

### 5.4.8 實測：JPQL 沒有、而 HQL 有的東西 ★

**這一格的價值不在「這些語法多好用」，而在「你要知道你正在用哪一種語言」。**

```java
package com.example.lab.ch05;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/** 5.4.8：JPQL 沒有的東西，HQL（Hibernate 6）有嗎？ */
class F3Hql extends Base05 {

    @BeforeEach void setUp() { seed(30, 5, 2, 1); varyItems(); }

    private void probe(String label, String jpql, Class<?> type) {
        try {
            List<?> r = em.createQuery(jpql, type).setMaxResults(3).getResultList();
            List<String> sqls = spy(() -> em.createQuery(jpql, type).setMaxResults(3).getResultList());
            System.out.println("  ✅ " + label + " → " + r.size() + " 列");
            System.out.println("     SQL: " + cut(sqls.get(0)));
            for (Object o : r) {
                System.out.println("     " + (o instanceof Object[] a ? java.util.Arrays.toString(a) : o));
            }
        } catch (Exception e) {
            System.out.println("  ❌ " + label + " → " + e.getClass().getSimpleName());
            System.out.println("     " + cut(String.valueOf(e.getMessage()).replaceAll("\\s+", " ")));
        }
        em.clear();
        System.out.println();
    }

    @Test @Transactional
    void hibernate六的hql擴充() {
        head("5.4.8 JPQL 規格沒有、但 Hibernate 6 的 HQL 有的東西");

        probe("窗口函式 row_number() over", """
            select o.orderNo, o.totalAmount,
                   row_number() over (partition by o.customer.id order by o.totalAmount desc)
              from Ord5 o
            """, Object[].class);

        probe("窗口函式 sum() over", """
            select o.orderNo, sum(o.totalAmount) over (order by o.placedAt)
              from Ord5 o
            """, Object[].class);

        probe("union", """
            select o.orderNo from Ord5 o where o.status = com.example.lab.ch05.St5.CANCELLED
            union
            select o.orderNo from Ord5 o where o.totalAmount > 255
            """, String.class);

        probe("CTE（with … as）", """
            with big as (select o.id as oid, o.totalAmount as amt from Ord5 o where o.totalAmount > 250)
            select b.oid, b.amt from big b
            """, Object[].class);

        probe("cast", "select cast(o.totalAmount as string), cast(o.orderNo as string) from Ord5 o",
            Object[].class);

        probe("id() 函式", "select id(o), o.orderNo from Ord5 o", Object[].class);

        probe("字串聚合 listagg", """
            select o.orderNo, listagg(i.productName, ',') within group (order by i.productName)
              from Ord5 o join o.items i group by o.orderNo
            """, Object[].class);

        probe("filter（條件式聚合）", """
            select c.displayName,
                   count(o) filter (where o.status = com.example.lab.ch05.St5.CANCELLED),
                   count(o)
              from Cust5 c join c.orders o group by c.displayName
            """, Object[].class);
    }
}
```

```
═══ 5.4.8 JPQL 規格沒有、但 Hibernate 6 的 HQL 有的東西 ═══
  ✅ 窗口函式 row_number() over → 3 列
     SQL: select o1_0.order_no,o1_0.total_amount,
                 row_number() over(partition by o1_0.customer_id order by o1_0.total_amount desc)
          from orders o1_0 limit ?
     [SO-2026-000014, 260.0000, 1]
     [SO-2026-000019, 240.0000, 2]
     [SO-2026-000004, 230.0000, 3]

  ✅ 窗口函式 sum() over → 3 列
     SQL: select o1_0.order_no,sum(o1_0.total_amount) over(order by o1_0.placed_at) from orders o1_0 limit ?
     [SO-2026-000001, 200.0000]
     [SO-2026-000002, 410.0000]
     [SO-2026-000003, 630.0000]

  ✅ union → 3 列
     SQL: select o1_0.order_no from orders o1_0 where o1_0.status='CANCELLED'
          union select o2_0.order_no from orders o2_0 where o2_0.total_amount>255 limit ?
     SO-2026-000004
     SO-2026-000008
     SO-2026-000012

  ✅ CTE（with … as） → 3 列
     SQL: with big (oid,amt) as (select o1_0.id,o1_0.total_amount from orders o1_0
                                  where o1_0.total_amount>250 limit ?)
          select b1_0.oid,b1_0.amt from big b1_0 limit ?
     [01a07b49-84bc-7161-8628-969e9c0a172a, 260.0000]

  ✅ cast → 3 列
     SQL: select cast(o1_0.total_amount as char),cast(o1_0.order_no as char) from orders o1_0 limit ?

  ✅ id() 函式 → 3 列
     SQL: select o1_0.id,o1_0.order_no from orders o1_0 limit ?

  ✅ 字串聚合 listagg → 3 列
     SQL: select o1_0.order_no,
                 group_concat(i1_0.product_name order by i1_0.product_name separator ',')
          from orders o1_0 join order_item i1_0 on o1_0.id=i1_0.order_id …
     [SO-2026-000001, 商品0]
     [SO-2026-000002, 商品1,商品2]

  ✅ filter（條件式聚合） → 3 列
     SQL: select c1_0.display_name,
                 count(case when o1_0.status='CANCELLED' then o1_0.id else null end),
                 count(o1_0.id)
          from customer c1_0 join orders o1_0 on …
     [客戶3, 2, 6]
```

**八個全部都能跑。** 而 **JPA 規格（Jakarta Persistence 3.1）的 JPQL 文法裡
一個都沒有**——沒有 `over`、沒有 `union`、沒有 `with`、沒有 `listagg`、沒有 `filter`。

**三個觀察**：

**① `listagg` 與 `filter` 是「翻譯層」在做事。**
`listagg` 在 MySQL 上變成 `group_concat`、在 PostgreSQL 上變成 `string_agg`；
`filter` 在支援它的資料庫上就是 `filter`，在 MySQL 上變成 `count(case when …)`。
**這是 HQL 擴充最有價值的部分：它是可攜的。**

**② 而它們讓「換一個 JPA 實作」變得不可能。**
不是「換一個資料庫」——那沒問題。是**換 EclipseLink**。
現實中極少人真的換 JPA 實作，**所以這件事的重要性通常被高估**。

> 📌 **實務上的判準不是「這是不是 JPQL」，是**：
>
> ```
> 這一句用了 HQL 擴充嗎？
>    沒有 → 沒事
>    有   → 團隊裡的人知道嗎？出事的時候查得到文件嗎？
>          （Hibernate 的文件叫「HQL」，你去查 JPQL 的教學會找不到 over）
> ```

**③ 而這件事有一個具體的成本**：**IDE 與工具的支援**。
IntelliJ 的 JPQL 檢查、`hibernate-jpamodelgen` 的 `@Query` 驗證（5.13.1），
對這些擴充的支援程度不一。**寫了會紅，但能跑。**

📌 **一句話**：

> **JPQL 是規格，HQL 是 Hibernate 對它的超集。**
> **`em.createQuery()` 收下的是 HQL。**
> **你可以用擴充，但要知道自己在用，而且要在 code review 上講得出來。**

---

## 5.5 參數：不只是為了防注入

### 5.5.1 實測：兩種參數寫法

```java
package com.example.lab.ch05;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/** 5.5：參數。 */
class F4Params extends Base05 {

    @BeforeEach void setUp() { seed(30, 5, 2, 0); }

    @Test @Transactional
    void 具名與位置參數() {
        head("5.5.1 兩種參數寫法");
        long a = em.createQuery("select count(o) from Ord5 o where o.status = :st", Long.class)
                   .setParameter("st", St5.PENDING).getSingleResult();
        long b = em.createQuery("select count(o) from Ord5 o where o.status = ?1", Long.class)
                   .setParameter(1, St5.PENDING).getSingleResult();
        System.out.println("  具名 :st  → " + a);
        System.out.println("  位置 ?1   → " + b);

        List<String> s = spy(() -> em.createQuery(
            "select count(o) from Ord5 o where o.status = :st and o.totalAmount > :amt", Long.class)
            .setParameter("st", St5.PENDING).setParameter("amt", new java.math.BigDecimal("200"))
            .getSingleResult());
        System.out.println("  SQL: " + cut(s.get(0)) + "   ★ 兩個都是 ?");

        System.out.println("\n  🔴 參數不能放在【欄位名】的位置：");
        try {
            em.createQuery("select o.orderNo from Ord5 o order by :col", String.class)
              .setParameter("col", "placedAt").getResultList();
            System.out.println("    …居然沒炸（但它是照【字串常數】排序，不是照欄位）");
        } catch (Exception e) {
            System.out.println("    " + e.getClass().getSimpleName() + ": "
                + cut(String.valueOf(e.getMessage()).replaceAll("\\s+", " ")));
        }
    }
}
```

```
═══ 5.5.1 兩種參數寫法 ═══
  具名 :st  → 23
  位置 ?1   → 23
  SQL: select count(o1_0.id) from orders o1_0 where o1_0.status=? and o1_0.total_amount>?   ★ 兩個都是 ?

  🔴 參數不能放在【欄位名】的位置：
    …居然沒炸（但它是照【字串常數】排序，不是照欄位）
```

**三個觀察**：

**① 具名（`:st`）與位置（`?1`）都可以，而具名的可讀性壓倒性地好。**
位置參數在 JPQL 從 `?1` 開始（不是 `?0`），而且加一個條件就要重編號。
**這一課從頭到尾只用具名參數。**

**② 兩種都變成 SQL 的 `?`。** 也就是 `PreparedStatement`——
值走的是**協定的參數通道**，不是 SQL 文字，所以不可能改變 SQL 的結構。
（07 站 00 章 0.7.4 量過 `PreparedStatement` 與拼字串在資料庫端的成本差 22 倍。）

**③ 🔴 而參數只能放在【值】的位置。**
`order by :col` 不會報錯，但它排序的是**一個字串常數**——
所有列的排序鍵都一樣，等於沒排序。

> 📌 **這一點很重要，因為它是 5.9（Criteria）與 5.10（QueryDSL）存在的理由之一**：
> **「欄位名」與「條件的有無」不能參數化，只能靠【組出不同的查詢】。**
> 而「組出不同的查詢」用字串拼是災難，所以才有了 Criteria。

### 5.5.2 實測：拼字串的兩個代價

```java
    @Test @Transactional
    void 字串拼接的兩個代價() {
        head("5.5.2 🔴 為什麼不能把值拼進 JPQL");

        String userInput = "PENDING";
        long ok = em.createQuery(
            "select count(o) from Ord5 o where o.status = '" + userInput + "'", Long.class)
            .getSingleResult();
        System.out.println("  正常輸入 'PENDING' → " + ok + " 張");

        // 代價一：注入。JPQL 的注入面比 SQL 小，但不是沒有。
        String evil = "PENDING' or '1'='1";
        try {
            long n = em.createQuery(
                "select count(o) from Ord5 o where o.status = '" + evil + "'", Long.class)
                .getSingleResult();
            System.out.println("  惡意輸入          → " + n + " 張 🔴 條件被改寫了");
        } catch (Exception e) {
            System.out.println("  惡意輸入          → " + e.getClass().getSimpleName());
        }

        // 代價二：每一個值都是一句全新的 SQL
        Set<String> shapes = new LinkedHashSet<>();
        for (int i = 0; i < 20; i++) {
            String jpql = "select count(o) from Ord5 o where o.totalAmount > " + (200 + i);
            shapes.addAll(spy(() -> em.createQuery(jpql, Long.class).getSingleResult()));
        }
        System.out.println("\n  拼字串跑 20 次不同的金額 → " + shapes.size() + " 種 SQL 形狀");

        Set<String> shapes2 = new LinkedHashSet<>();
        for (int i = 0; i < 20; i++) {
            final int v = 200 + i;
            shapes2.addAll(spy(() -> em.createQuery(
                "select count(o) from Ord5 o where o.totalAmount > :a", Long.class)
                .setParameter("a", new java.math.BigDecimal(v)).getSingleResult()));
        }
        System.out.println("  用參數跑 20 次        → " + shapes2.size() + " 種 SQL 形狀");
        shapes2.forEach(x -> System.out.println("    " + cut(x)));
    }
```

```
═══ 5.5.2 🔴 為什麼不能把值拼進 JPQL ═══
  正常輸入 'PENDING' → 23 張
  惡意輸入          → 30 張 🔴 條件被改寫了

  拼字串跑 20 次不同的金額 → 20 種 SQL 形狀
  用參數跑 20 次        → 1 種 SQL 形狀
    select count(o1_0.id) from orders o1_0 where o1_0.total_amount>?
```

**代價一：注入。**

```
輸入：PENDING' or '1'='1
組出：select count(o) from Ord5 o where o.status = 'PENDING' or '1'='1'
                                                              ▲
                                                  這個 or 是使用者加的
結果：23 → 30。條件被繞過了。
```

⚠️ **有人會說「JPQL 又不能 `; drop table`，注入不嚴重」。**
`drop table` 確實做不到（JPQL 不支援多語句、也沒有 DDL），
**而「把 `where` 條件改成永遠為真」已經足夠了**——
那句 `where tenant_id = :t` 被繞過，就是跨租戶的資料外洩。
（00 章 0.9 的第六個事故是 MyBatis 的 `${}`，機制不同、後果一樣。）

**代價二：每一個值都是一句全新的 SQL。**

這比注入更常見，因為**它不需要有惡意的使用者，只需要一個正常的查詢**。
而它的代價分成兩層：

```
第一層：資料庫端。每一句都是新的 SQL 文字
       → 執行計畫快取（MySQL 的 prepared statement cache、Oracle 的 shared pool）全部沒中
       → 07 站 00 章 0.7.4 量過：22 倍

第二層：應用程式端。Hibernate 要把 JPQL 剖析成執行計畫（SQM → SQL AST → SQL）
       → 它有一個快取（hibernate.query.plan_cache_max_size，預設 2048）
       → 每一句新的 JPQL 都是一次 miss，而且會把別人的計畫擠出去
```

第二層可以直接量：

```java
package com.example.lab.ch05;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;

/** 5.5.2：字串拼接的第二個代價 —— Hibernate 的查詢計畫快取。 */
class F4cPlanCache extends Base05 {

    @BeforeEach void setUp() { seed(30, 5, 2, 0); }

    private org.hibernate.stat.Statistics st() {
        return emf.unwrap(org.hibernate.SessionFactory.class).getStatistics();
    }

    @Test @Transactional
    void 查詢計畫快取() {
        head("5.5.2 查詢計畫快取（Hibernate 要把 JPQL 剖析成執行計畫，那不便宜）");

        st().clear();
        for (int i = 0; i < 200; i++) {
            em.createQuery("select count(o) from Ord5 o where o.totalAmount > " + (200 + i), Long.class)
              .getSingleResult();
        }
        System.out.printf("  拼字串 200 次 → 計畫快取 命中 %d / 沒中 %d%n",
                st().getQueryPlanCacheHitCount(), st().getQueryPlanCacheMissCount());

        st().clear();
        for (int i = 0; i < 200; i++) {
            em.createQuery("select count(o) from Ord5 o where o.totalAmount > :a", Long.class)
              .setParameter("a", new BigDecimal(200 + i)).getSingleResult();
        }
        System.out.printf("  用參數 200 次 → 計畫快取 命中 %d / 沒中 %d%n",
                st().getQueryPlanCacheHitCount(), st().getQueryPlanCacheMissCount());

        // 只量「把 JPQL 變成執行計畫」的成本，不送到資料庫（否則會被網路來回蓋掉）。
        // ★ 每一句的金額都不一樣、而且【跨輪次也不重複】，否則第二輪就全部命中快取了。
        final int N = 500;
        final java.util.concurrent.atomic.AtomicInteger seq = new java.util.concurrent.atomic.AtomicInteger();
        long a = bestMicros(() -> {
            for (int i = 0; i < N; i++)
                em.createQuery("select o from Ord5 o join o.customer c left join o.rep r"
                             + " where o.totalAmount > " + seq.incrementAndGet()
                             + " order by o.placedAt", Ord5.class);
        }, 2, 5);
        long b = bestMicros(() -> {
            for (int i = 0; i < N; i++)
                em.createQuery("select o from Ord5 o join o.customer c left join o.rep r"
                             + " where o.totalAmount > :a order by o.placedAt", Ord5.class)
                  .setParameter("a", new BigDecimal(seq.incrementAndGet()));
        }, 2, 5);
        System.out.printf("%n  只做剖析（不送 DB）%d 句：拼字串 %d µs、用參數 %d µs（%.0f 倍）%n",
                N, a, b, a / (double) b);
        System.out.printf("  平均一句：拼字串 %.1f µs、用參數 %.2f µs%n", a / (double) N, b / (double) N);
    }
}
```

```
═══ 5.5.2 查詢計畫快取（Hibernate 要把 JPQL 剖析成執行計畫，那不便宜） ═══
  拼字串 200 次 → 計畫快取 命中 0 / 沒中 400
  用參數 200 次 → 計畫快取 命中 398 / 沒中 2

  只做剖析（不送 DB）500 句：拼字串 15358 µs、用參數 1291 µs（12 倍）
  平均一句：拼字串 30.7 µs、用參數 2.58 µs
```

**三個觀察**：

**① 拼字串 200 次 = 400 次 miss、0 次命中。用參數 = 398 次命中、2 次 miss。**
（一句查詢會查兩次快取：一次是 HQL 的語意模型、一次是它的執行計畫。）

**② 每一句多 28 µs。** 這個數字看起來很小，
**而它是 CPU 時間，不是等待時間**——它佔的是應用伺服器的執行緒。
一個每秒 500 次查詢的 API：`500 × 28 µs = 14 ms/s`，
大約是一顆核心的 1.4%。**單看不痛，而它的真正代價在第三點。**

**③ 🔴 計畫快取被塞滿之後，【所有】查詢都變慢。**
`plan_cache_max_size` 預設 2048。一個拼字串的查詢跑過 2048 個不同的值，
就會把整個系統其他查詢的計畫全部擠掉——
**症狀是「某個報表頁一跑，全站的 API 都變慢一點」，而且非常難查。**

⚠️ **量測方法的注意事項**：
第一版的量測寫成「跑 5 輪、每輪 500 個 `200+i`」——**第二輪開始全部命中快取**，
量到的是 1.9 µs vs 2.27 µs，看起來「沒有差別」。
**要量快取沒中的成本，被量的東西每一次都必須是新的**（上面那個 `AtomicInteger`）。

### 5.5.3 實測：`in` 子句的參數個數爆炸 ★

上一格說「用參數就只有一種 SQL 形狀」。**`in` 是例外。**

```java
    @Test @Transactional
    void in子句的參數爆炸() {
        head("5.5.3 in 子句：清單長度不同 = 不同的 SQL");
        List<UUID> ids = new ArrayList<>(orderIds);

        Set<String> shapes = new LinkedHashSet<>();
        for (int n = 1; n <= 20; n++) {
            List<UUID> sub = ids.subList(0, n);
            shapes.addAll(spy(() -> em.createQuery(
                "select count(o) from Ord5 o where o.id in :ids", Long.class)
                .setParameter("ids", sub).getSingleResult()));
        }
        System.out.println("  清單長度 1～20 → " + shapes.size() + " 種 SQL 形狀");
        int shown = 0;
        for (String s : shapes) {
            if (shown++ < 4) System.out.println("    " + cut(s));
        }
        System.out.println("    …（每多一個 id 就是一句新的 SQL）");
    }
```

```
═══ 5.5.3 in 子句：清單長度不同 = 不同的 SQL ═══
  清單長度 1～20 → 20 種 SQL 形狀
    select count(o1_0.id) from orders o1_0 where o1_0.id in (?)
    select count(o1_0.id) from orders o1_0 where o1_0.id in (?,?)
    select count(o1_0.id) from orders o1_0 where o1_0.id in (?,?,?)
    select count(o1_0.id) from orders o1_0 where o1_0.id in (?,?,?,?)
    …（每多一個 id 就是一句新的 SQL）
```

**清單長度 1～20，就是 20 種 SQL。**
而這種查詢在真實系統裡到處都是——`findAllById`、
04 章 4.7 的 `@BatchSize`（它產生的就是 `in (?,?,…)`）、
04 章 4.5.6 的兩段式查詢。**每一種長度都吃掉一格計畫快取。**

**Hibernate 有一個開關可以解**：

```java
package com.example.lab.ch05;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/** 5.5.3：一個開關讓 in 子句的 SQL 形狀變少。 */
@SpringBootTest(properties = {
  "spring.datasource.url=jdbc:mysql://127.0.0.1:33306/ch05?connectionTimeZone=UTC"
      + "&forceConnectionTimeZoneToSession=true&preserveInstants=true&characterEncoding=UTF-8",
  "spring.jpa.properties.hibernate.generate_statistics=true",
  "spring.jpa.properties.hibernate.query.in_clause_parameter_padding=true"   // ★ 這一行
})
class F4bPadding extends Base05 {

    @BeforeEach void setUp() { seed(30, 5, 2, 0); }

    @Test @Transactional
    void 開了padding之後() {
        head("5.5.3 hibernate.query.in_clause_parameter_padding = true");
        List<UUID> ids = new ArrayList<>(orderIds);

        Set<String> shapes = new LinkedHashSet<>();
        for (int n = 1; n <= 20; n++) {
            List<UUID> sub = ids.subList(0, n);
            shapes.addAll(spy(() -> em.createQuery(
                "select count(o) from Ord5 o where o.id in :ids", Long.class)
                .setParameter("ids", sub).getSingleResult()));
        }
        System.out.println("  清單長度 1～20 → " + shapes.size() + " 種 SQL 形狀");
        shapes.forEach(s -> System.out.println("    " + cut(s)));

        System.out.println("\n  結果還是對的嗎？（湊數的參數是把最後一個 id 重複填）");
        long n5 = em.createQuery("select count(o) from Ord5 o where o.id in :ids", Long.class)
                    .setParameter("ids", ids.subList(0, 5)).getSingleResult();
        long n7 = em.createQuery("select count(o) from Ord5 o where o.id in :ids", Long.class)
                    .setParameter("ids", ids.subList(0, 7)).getSingleResult();
        System.out.println("    5 個 id → " + n5 + " 張；7 個 id → " + n7 + " 張");
    }
}
```

```
═══ 5.5.3 hibernate.query.in_clause_parameter_padding = true ═══
  清單長度 1～20 → 6 種 SQL 形狀
    select count(o1_0.id) from orders o1_0 where o1_0.id in (?)
    select count(o1_0.id) from orders o1_0 where o1_0.id in (?,?)
    select count(o1_0.id) from orders o1_0 where o1_0.id in (?,?,?,?)
    select count(o1_0.id) from orders o1_0 where o1_0.id in (?,?,?,?,?,?,?,?)
    select count(o1_0.id) from orders o1_0 where o1_0.id in (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    select count(o1_0.id) from orders o1_0 where o1_0.id in (?,?,?,?,?,?,?,?,?,?,…共 32 個)

  結果還是對的嗎？（湊數的參數是把最後一個 id 重複填）
    5 個 id → 5 張；7 個 id → 7 張
```

**20 種形狀 → 6 種。**

**它怎麼做到的**：把參數個數**向上補到 2 的次方**（1, 2, 4, 8, 16, 32…），
**多出來的位置重複填最後一個值**。
`in (a, b, c, d, e)` 變成 `in (a, b, c, d, e, e, e, e)` ——
`in` 對重複值不敏感，所以**結果一模一樣**（實測 5 個 id → 5 張、7 個 id → 7 張）。

✅ **這是一行組態、不用改任何程式碼、沒有副作用的改善。**
跟 04 章 4.7.5 的 `hibernate.default_batch_fetch_size` 一樣，
屬於「接手一個舊系統時可以先打開的東西」。

```yaml
spring:
  jpa:
    properties:
      hibernate:
        query:
          in_clause_parameter_padding: true
```

⚠️ **它不能解決「`in` 清單有一萬個 id」這件事。**
那是另一個問題（SQL 長度上限、`max_allowed_packet`），
解法是分批（每 500 個一句）或改成 join 一張暫存表。

---

## 5.6 批次 `update` / `delete`：JPQL 的另一面 🔴

前面所有的 JPQL 都在查。**JPQL 也可以改。**
而「可以改」這件事，跟前四章講的每一件事都衝突。

### 5.6.1 實測：一句 `update` vs 逐筆

```java
package com.example.lab.ch05;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** 5.6：JPQL 的另一面 —— 批次 update / delete。 */
class F5Bulk extends Base05 {

    @BeforeEach void setUp() { seed(200, 50, 2, 0); }

    /** 每一輪都先把資料還原（不計時），再量 body。取最快的一次。 */
    private long timed(Runnable body, int rounds) {
        long best = Long.MAX_VALUE;
        for (int i = 0; i < rounds; i++) {
            seed(200, 50, 2, 0);
            long t0 = System.nanoTime();
            tx.executeWithoutResult(s -> body.run());
            best = Math.min(best, System.nanoTime() - t0);
        }
        return best / 1_000_000;
    }

    private List<String> sqlOf(Runnable body) {
        seed(200, 50, 2, 0);
        List<String> out = new ArrayList<>();
        tx.executeWithoutResult(s -> out.addAll(spy(body)));
        return out;
    }

    @Test
    void 逐筆改與一句update() {
        head("5.6.1 把所有 PENDING 的訂單改成 CANCELLED（200 張裡有 150 張）");

        Runnable a = () -> {
            List<Ord5> os = em.createQuery("select o from Ord5 o where o.status = :st", Ord5.class)
                              .setParameter("st", St5.PENDING).getResultList();
            for (Ord5 o : os) {
                em.createQuery("update Ord5 x set x.status = :c where x.id = :id")
                  .setParameter("c", St5.CANCELLED).setParameter("id", o.getId()).executeUpdate();
            }
        };
        Runnable b = () -> em.createQuery("update Ord5 o set o.status = :c where o.status = :st")
                             .setParameter("c", St5.CANCELLED).setParameter("st", St5.PENDING)
                             .executeUpdate();
        Runnable c = () -> {
            List<OrdVer5> os = em.createQuery("select o from OrdVer5 o where o.status = :st", OrdVer5.class)
                                 .setParameter("st", St5.PENDING).getResultList();
            os.forEach(o -> o.setStatus(St5.CANCELLED));
            em.flush();
        };

        System.out.printf("  %-28s %6s %8s%n", "寫法", "SQL", "ms");
        System.out.printf("  %-28s %6d %8d%n", "① 撈出來 + 逐筆 update",
                sqlOf(a).size(), timed(a, 3));
        List<String> bs = sqlOf(b);
        System.out.printf("  %-28s %6d %8d%n", "② 一句批次 update", bs.size(), timed(b, 3));
        System.out.printf("  %-28s %6d %8d%n", "③ 撈出來改物件（髒檢查）",
                sqlOf(c).size(), timed(c, 3));
        System.out.println("\n  ② 的那一句：" + cut(bs.get(0)));

        System.out.println("\n  批次 update 也可以用運算式（全部漲價 5%）：");
        List<String> up = sqlOf(() -> {
            int n = em.createQuery("update Ord5 o set o.totalAmount = o.totalAmount * 1.05"
                                 + " where o.status = :st")
                      .setParameter("st", St5.PENDING).executeUpdate();
            System.out.println("    影響 " + n + " 列");
        });
        up.forEach(s -> System.out.println("    " + cut(s)));
    }
}
```

```
═══ 5.6.1 把所有 PENDING 的訂單改成 CANCELLED（200 張裡有 150 張） ═══
  寫法                              SQL       ms
  ① 撈出來 + 逐筆 update               151       79
  ② 一句批次 update                     1        3
  ③ 撈出來改物件（髒檢查）                   151       52

  ② 的那一句：update orders set status=? where status=?

  批次 update 也可以用運算式（全部漲價 5%）：
    影響 150 列
    update orders set total_amount=(total_amount*1.05) where status=?
```

**151 句 / 52 ms → 1 句 / 3 ms。**

**兩個觀察**：

**① ③ 才是這一課到目前為止教的寫法**（03 章 3.11：撈出來、呼叫方法、讓髒檢查寫回去）。
它 52 ms，而且**它是對的**——回呼、樂觀鎖、cascade 全部有效。

**② 而在「把 150 張訂單的狀態換掉」這件事上，它比一句 `update` 慢 17 倍。**
因為它做了三件多餘的事：把 150 張訂單變成物件、建 150 份快照、比對 150 次。

> 📌 **這就是批次操作存在的理由**：
> **有些用例根本不需要「物件」這個中間產物。**
> **而 JPA 的預設路徑一定會建出它來。**

⚠️ **注意 ① 的 151 句跟 ③ 的 151 句是不一樣的東西**：
① 是 1 句 select + 150 句手寫的 `update`；
③ 是 1 句 select + 150 句髒檢查產生的 `update`。
**同樣的句數，②「一句」的優勢跟句數無關，跟【要不要建物件】有關。**

### 5.6.2 🔴 實測：批次 `update` 不知道持久化情境的存在

**這是這一節真正的重點。**

```java
    @Test
    void 批次update繞過持久化情境() {
        head("5.6.2 🔴 批次 update 不知道持久化情境的存在");
        tx.executeWithoutResult(s -> {
            UUID id = orderIds.get(0);
            Ord5 o = em.find(Ord5.class, id);
            System.out.println("  ① 撈出來                    → status = " + o.getStatus());

            int n = em.createQuery("update Ord5 x set x.status = :c where x.id = :id")
                      .setParameter("c", St5.SHIPPED).setParameter("id", id).executeUpdate();
            System.out.println("  ② 批次 update 影響 " + n + " 列");

            System.out.println("  ③ 同一個物件                → status = " + o.getStatus() + "  🔴");

            Ord5 again = em.find(Ord5.class, id);
            System.out.println("  ④ 再 find 一次（一級快取）  → status = " + again.getStatus() + "  🔴");
            System.out.println("     是同一個物件嗎？ " + (o == again));

            String db = jdbc.queryForObject("select status from orders where id = ?",
                    String.class, com.example.lab.Uuid7.toBytes(id));
            System.out.println("  ⑤ 直接問資料庫              → status = " + db);

            List<Ord5> jpql = em.createQuery(
                "select x from Ord5 x where x.id = :id", Ord5.class).setParameter("id", id)
                .getResultList();
            System.out.println("  ⑥ 用 JPQL 再查一次          → status = " + jpql.get(0).getStatus()
                + "  🔴（03 章 3.2.4：SQL 打了，回來的還是快取裡那個）");

            em.refresh(o);
            System.out.println("  ⑦ em.refresh(o) 之後        → status = " + o.getStatus() + "  ✅");
        });
    }
```

```
═══ 5.6.2 🔴 批次 update 不知道持久化情境的存在 ═══
  ① 撈出來                    → status = PENDING
  ② 批次 update 影響 1 列
  ③ 同一個物件                → status = PENDING  🔴
  ④ 再 find 一次（一級快取）  → status = PENDING  🔴
     是同一個物件嗎？ true
  ⑤ 直接問資料庫              → status = SHIPPED
  ⑥ 用 JPQL 再查一次          → status = PENDING  🔴（SQL 打了，回來的還是快取裡那個）
  ⑦ em.refresh(o) 之後        → status = SHIPPED  ✅
```

**這一格是 03 章 3.2.4 那個實測的重演，而這次的元兇是你自己寫的 `update`**：

```
批次 update 走的是【JDBC 直達車】：JPQL → SQL → 資料庫。
它【完全沒有經過】持久化情境。
   ↓
於是持久化情境裡那個 Ord5 物件，還是 PENDING。
而一級快取的保證是「同一個 id 只有一個物件」（03 章 3.2）——
   ↓
所以你【再查一次也拿不到新值】：
  em.find      → 直接從快取拿，連 SQL 都不打
  JPQL 查詢    → SQL 真的送出去了，但組裝結果時發現「這個 id 我有」，回快取那個
```

⚠️ **⑥ 是最容易騙到人的一格**：
你在 log 裡**看得到那句 SQL**，資料庫**回的是新值**，
而你的變數裡是舊值。**這種 bug 用讀 SQL 的方式永遠查不出來。**

**兩個解法**：

```java
// 解法一：把持久化情境清掉（Spring Data 的 clearAutomatically 做的就是這件事）
em.clear();

// 解法二：只重新載入受影響的那幾個（範圍小的時候）
em.refresh(o);
```

> ✅ **實務上的規則**：
> **批次 `update` / `delete` 應該是一個交易裡的【最後一件事】，
> 或者做完就 `em.clear()`。**
> **不要在同一個交易裡「先撈實體、再批次改、再繼續用那些實體」。**

### 5.6.3 🔴 實測：批次 `update` 還繞過了什麼

```java
    @Test
    void 批次update繞過的其他東西() {
        head("5.6.3 🔴 批次 update 還繞過了什麼");
        tx.executeWithoutResult(s -> {
            UUID id = orderIds.get(0);
            OrdVer5.resetCallbacks();

            OrdVer5 o = em.find(OrdVer5.class, id);
            System.out.println("  起點：version = " + o.getVersion());

            o.setStatus(St5.PAID);
            em.flush();
            System.out.printf("  ① 改物件 + flush   → @PreUpdate %d 次、@PostUpdate %d 次、version = %d ✅%n",
                    OrdVer5.preUpdate, OrdVer5.postUpdate, o.getVersion());

            OrdVer5.resetCallbacks();
            em.createQuery("update OrdVer5 x set x.status = :c where x.id = :id")
              .setParameter("c", St5.SHIPPED).setParameter("id", id).executeUpdate();
            long vDb = jdbc.queryForObject("select version from orders where id = ?",
                    Long.class, com.example.lab.Uuid7.toBytes(id));
            System.out.printf("  ② 批次 update      → @PreUpdate %d 次、@PostUpdate %d 次、"
                    + "資料庫的 version = %d  🔴（沒變）%n",
                    OrdVer5.preUpdate, OrdVer5.postUpdate, vDb);

            em.createQuery("update versioned OrdVer5 x set x.status = :c where x.id = :id")
              .setParameter("c", St5.PACKED).setParameter("id", id).executeUpdate();
            long vDb2 = jdbc.queryForObject("select version from orders where id = ?",
                    Long.class, com.example.lab.Uuid7.toBytes(id));
            System.out.printf("  ③ update versioned → 資料庫的 version = %d  ✅（HQL 擴充，JPQL 沒有）%n", vDb2);
        });
    }
```

這一格用的是**同一張 `orders` 表的另一個映射**（02 章用過的手法），
它多了 `@Version` 與四個生命週期回呼：

```java
package com.example.lab.ch05;

import jakarta.persistence.*;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * 同一張 orders 表的另一個映射（02 章用過的手法）：
 * 多了 @Version 與四個生命週期回呼 —— 5.6.3 要量「批次 update 繞過了什麼」。
 */
@Entity @Table(name = "orders")
public class OrdVer5 extends Base5 {

    /** 回呼被呼叫幾次（測試會 reset）。 */
    public static int preUpdate = 0, postUpdate = 0, preRemove = 0, postRemove = 0;
    public static void resetCallbacks() { preUpdate = postUpdate = preRemove = postRemove = 0; }

    @Column(name = "order_no", nullable = false, length = 32) private String orderNo;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "customer_id", nullable = false) private Cust5 customer;

    @Enumerated(EnumType.STRING) @JdbcTypeCode(SqlTypes.VARCHAR)
    @Column(nullable = false, length = 16) private St5 status;

    @Column(name = "total_amount", nullable = false, precision = 19, scale = 4)
    private BigDecimal totalAmount = BigDecimal.ZERO;
    @Column(name = "placed_at", nullable = false) private Instant placedAt;

    @Version private long version;

    protected OrdVer5() {}

    @PreUpdate  void onPreUpdate()  { preUpdate++; }
    @PostUpdate void onPostUpdate() { postUpdate++; }
    @PreRemove  void onPreRemove()  { preRemove++; }
    @PostRemove void onPostRemove() { postRemove++; }

    public String getOrderNo() { return orderNo; }
    public St5 getStatus() { return status; }
    public void setStatus(St5 s) { this.status = s; }
    public BigDecimal getTotalAmount() { return totalAmount; }
    public long getVersion() { return version; }
}
```

（`orders` 表要多一欄 `version bigint NOT NULL DEFAULT 0`。
`Ord5` 沒有映射它，所以兩個實體可以共存。）

```
═══ 5.6.3 🔴 批次 update 還繞過了什麼 ═══
  起點：version = 0
  ① 改物件 + flush   → @PreUpdate 1 次、@PostUpdate 1 次、version = 1 ✅
  ② 批次 update      → @PreUpdate 0 次、@PostUpdate 0 次、資料庫的 version = 1  🔴（沒變）
  ③ update versioned → 資料庫的 version = 2  ✅（HQL 擴充，JPQL 沒有）
```

**兩個觀察**：

**① 🔴 `@Version` 不會動 —— 而這比「回呼沒被呼叫」嚴重得多。**

```
樂觀鎖的機制是：update … where id = ? and version = ?
                如果影響 0 列，代表有人先改了 → 拋 OptimisticLockException

而批次 update 把 version 留在原地。
   ↓
另一個交易裡那個「version = 1」的舊物件，等一下寫回去會【成功】，
因為資料庫裡的 version 也還是 1。
   ↓
【你剛剛用批次 update 改的東西，被靜默覆蓋掉了。】
```

⚠️ **這正是 00 章 0.3.5 那個事故的機制**（「混用讓樂觀鎖靜默失效」）——
那裡的兇手是 MyBatis，**這裡的兇手是 JPQL 自己**。

**解法是 Hibernate 的 `update versioned`**（③）：它會把 `version = version + 1` 加進 SQL。
⚠️ **它是 HQL 擴充，JPQL 規格沒有**（5.4.8），而且**它只對 `@Version` 是數字型別的有效**
（`@Version` 用 `Timestamp` 的話不支援）。

**② 回呼一次都不會被呼叫。**
`@PreUpdate` / `@PostUpdate` 是**持久化情境的事件**，
而批次 update 沒有經過持久化情境。
**如果你的審計欄位（`updated_at`、`updated_by`）是靠 `@PreUpdate` 或
`@LastModifiedDate` 填的（01 章 1.16），批次 update 之後它們就是舊的。**

> ✅ **對策**：批次 update 自己把審計欄位寫進去。
>
> ```java
> update Ord5 o set o.status = :c, o.updatedAt = :now where o.status = :st
> ```

### 5.6.4 實測：批次 `delete`

```java
    @Test
    void 批次delete() {
        head("5.6.4 批次 delete");

        System.out.println("  ① 直接刪有子資料的訂單（cascade / orphanRemoval 幫不上忙）：");
        try {
            tx.executeWithoutResult(s ->
                em.createQuery("delete from Ord5 o where o.status = :st")
                  .setParameter("st", St5.CANCELLED).executeUpdate());
        } catch (Exception e) {
            Throwable root = e; while (root.getCause() != null) root = root.getCause();
            System.out.println("     🔴 " + root.getClass().getSimpleName() + ": "
                + cut(String.valueOf(root.getMessage()).replaceAll("\\s+", " ")));
        }

        seed(200, 50, 2, 0);
        System.out.println("\n  ② 先刪子表再刪父表：");
        tx.executeWithoutResult(s -> {
            OrdVer5.resetCallbacks();
            List<String> sqls = spy(() -> {
                int a = em.createQuery(
                    "delete from Item5 i where i.order in (select o from Ord5 o where o.status = :st)")
                    .setParameter("st", St5.CANCELLED).executeUpdate();
                int b = em.createQuery("delete from Ord5 o where o.status = :st")
                    .setParameter("st", St5.CANCELLED).executeUpdate();
                System.out.println("     明細 " + a + " 筆、訂單 " + b + " 張");
            });
            sqls.forEach(x -> System.out.println("     " + cut(x)));
            System.out.println("     @PreRemove 被呼叫 " + OrdVer5.preRemove + " 次 🔴");
        });
    }
```

```
═══ 5.6.4 批次 delete ═══
  ① 直接刪有子資料的訂單（cascade / orphanRemoval 幫不上忙）：
     🔴 SQLIntegrityConstraintViolationException: Cannot delete or update a parent row:
        a foreign key constraint fails (`ch05`.`order_item`,
        CONSTRAINT `fk_order_item_orders` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`))

  ② 先刪子表再刪父表：
     明細 100 筆、訂單 50 張
     delete from order_item where order_id in (select o2_0.id from orders o2_0 where o2_0.status=?)
     delete from orders where status=?
     @PreRemove 被呼叫 0 次 🔴
```

**這一格回答了 02 章 2.7 留下的問題**（「大量刪除要繞過 cascade —— 用 JPQL 的 delete 或原生 SQL，05 章」）：

**① `Order.items` 上的 `cascade = ALL, orphanRemoval = true` 完全沒有作用。**
批次 `delete` 直接送 `delete from orders`，於是撞上外鍵約束。

**② 要自己按依賴順序刪。** 而且要注意**刪的順序跟 `flush` 的順序無關**
（03 章 3.7.3 那個「flush 的動作順序固定」講的是持久化情境的 flush，
批次 delete 是照你寫的順序送出去的）。

**③ `@PreRemove` 一次都沒被呼叫**——跟 5.6.3 同一個理由。

> 📌 **判準**：
>
> ```
> 要刪的東西【有沒有】cascade / orphanRemoval / 回呼 / 樂觀鎖要顧？
>    有，而且筆數不多（幾十筆）  → 用 repository.delete(entity)，讓 JPA 走完整流程
>    有，而且筆數很多            → 🔴 這是一個設計問題：想清楚那些機制在批次場景要不要生效
>    沒有                       → 批次 delete，並且自己處理子表
> ```

### 5.6.5 實測：`@Modifying` 的兩個開關

Spring Data 的批次操作要標 `@Modifying`：

```java
public interface Ord5Repo extends JpaRepository<Ord5, UUID> {

    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("update Ord5 o set o.status = :to where o.status = :from")
    int changeStatus(@Param("from") St5 from, @Param("to") St5 to);
}
```

**`@Modifying` 本身**是在告訴 Spring Data「這句要用 `executeUpdate()` 跑，
不是 `getResultList()`」——**沒標會直接拋例外**。

**那兩個屬性在解的，就是 5.6.2 那個問題**：

```java
    @Test
    void modifying的兩個開關() {
        head("5.6.5 @Modifying(clearAutomatically / flushAutomatically) 在解什麼");

        tx.executeWithoutResult(s -> {
            System.out.println("  【clearAutomatically】");
            UUID id = orderIds.get(0);
            Ord5 o = em.find(Ord5.class, id);
            System.out.println("    撈出來                 → " + o.getStatus());
            em.createQuery("update Ord5 x set x.status = :c where x.id = :id")
              .setParameter("c", St5.DELIVERED).setParameter("id", id).executeUpdate();
            System.out.println("    批次 update 之後，PC 裡 → " + o.getStatus() + " 🔴");
            em.clear();                                   // ★ clearAutomatically 做的事
            System.out.println("    em.clear() 之後再 find  → "
                + em.find(Ord5.class, id).getStatus() + " ✅");
        });

        seed(200, 50, 2, 0);
        tx.executeWithoutResult(s -> {
            System.out.println("\n  【flushAutomatically】：PC 裡有還沒寫回去的修改，批次 update 看得到嗎？");
            UUID id = orderIds.get(0);
            OrdVer5 o = em.find(OrdVer5.class, id);
            o.setStatus(St5.PAID);            // ★ 只改物件，還沒 flush
            System.out.println("    改成 PAID（沒 flush）。資料庫裡現在是 "
                + jdbc.queryForObject("select status from orders where id = ?",
                        String.class, com.example.lab.Uuid7.toBytes(id)));

            List<String> sqls = spy(() -> {
                int n = em.createQuery("update OrdVer5 x set x.totalAmount = 999 where x.status = :st")
                          .setParameter("st", St5.PAID).executeUpdate();
                System.out.println("    update … where status = PAID → 影響 " + n + " 列");
            });
            sqls.forEach(x -> System.out.println("      " + cut(x)));
            BigDecimal amt = jdbc.queryForObject("select total_amount from orders where id = ?",
                    BigDecimal.class, com.example.lab.Uuid7.toBytes(id));
            System.out.println("    那一張的金額 → " + amt);
        });
    }
```

```
═══ 5.6.5 @Modifying(clearAutomatically / flushAutomatically) 在解什麼 ═══
  【clearAutomatically】
    撈出來                 → PENDING
    批次 update 之後，PC 裡 → PENDING 🔴
    em.clear() 之後再 find  → DELIVERED ✅

  【flushAutomatically】：PC 裡有還沒寫回去的修改，批次 update 看得到嗎？
    改成 PAID（沒 flush）。資料庫裡現在是 PENDING
    update … where status = PAID → 影響 1 列
      update orders set customer_id=?,order_no=?,placed_at=?,status=?,total_amount=?,version=?
             where id=? and version=?
      update orders set total_amount=999 where status=?
    那一張的金額 → 999.0000
```

**兩個觀察**：

**① `clearAutomatically = true` 就是幫你呼叫 `em.clear()`。**
✅ **批次 update 一律要開它**，除非你確定同一個交易後面不會再用到那些實體。

⚠️ **代價是真的**：`em.clear()` 會把**整個**持久化情境清空，
包含你在這個交易前半段撈出來、還沒 flush 的**其他**實體的修改——
**那些修改會直接消失**（變成 detached，03 章 3.5）。
所以「批次 update 放在交易的最後」比「開 `clearAutomatically`」更安全。

**② ★ `flushAutomatically` 在 Hibernate 上通常是多餘的。**

實測結果很清楚：**那句自動的 `update orders set … where id=? and version=?` 出現在批次 update 之前**。
Hibernate 在執行任何會碰到 `orders` 這張表的查詢之前，
**會自動 flush 掉持久化情境裡跟這張表有關的修改**（03 章 3.6.2 的 auto-flush）。
所以那張還沒寫回去的訂單**被批次 update 抓到了**（金額變成 999）。

> 📌 **那還要不要寫 `flushAutomatically = true`？**
> **要，但理由不是「不寫會出錯」，是「不寫的話這件事只是碰巧成立」。**
> auto-flush 的觸發條件是「查詢碰到的表跟待寫入的修改有交集」，
> 而那個判斷由 Hibernate 決定；`@Transactional(readOnly = true)` 之下
> flush mode 是 `MANUAL`（03 章 3.8.3），auto-flush **不會發生**。
> **明寫出來，讓它不依賴推論。**

### 5.6.6 批次操作的五條規則

```
① 用它之前先問：這件事真的不需要「物件」嗎？
   要跑回呼、要動樂觀鎖、要 cascade → 不要用批次。

② 一定加 @Modifying(clearAutomatically = true, flushAutomatically = true)。

③ 放在交易的最後，或者做完就當作「持久化情境已經報廢」。

④ 自己處理子表（外鍵）與審計欄位。

⑤ 有 @Version 的實體，用 Hibernate 的 update versioned —— 並且知道它不是 JPQL。
```

---

## 5.7 Spring Data 的三種查詢定義

前面兩節都在 `em.createQuery(...)`。**實務上你大部分時候不會這樣寫**——
06 站 03 章已經把 repository 介面講完了，這一節只補「查詢是怎麼被定義出來的」，
以及**它們各自的錯字什麼時候會被發現**。

```java
package com.example.lab.ch05;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;

/** 5.7：Spring Data 的三種查詢定義。 */
class F6SpringData extends Base05 {

    @Autowired Ord5Repo orders;

    @BeforeEach void setUp() { seed(30, 5, 2, 0); }

    // …以下每一節一個 @Test
}
```

### 5.7.1 實測：衍生查詢

```java
    @Test @Transactional
    void 衍生查詢() {
        head("5.7.1 衍生查詢：方法名就是查詢");
        System.out.println("  findByStatus(PENDING)                       → "
            + orders.findByStatus(St5.PENDING).size() + " 張");
        System.out.println("  findByStatusAndTotalAmountGreaterThan       → "
            + orders.findByStatusAndTotalAmountGreaterThan(St5.PENDING, new BigDecimal("230")).size());
        System.out.println("  findByCustomer_TierAndPlacedAtBetween…      → "
            + orders.findByCustomer_TierAndPlacedAtBetweenOrderByPlacedAtDesc(
                Tier5.GOLD, Instant.parse("2026-09-01T00:00:00Z"),
                Instant.parse("2026-09-02T00:00:00Z")).size());
        System.out.println("  countByStatus(CANCELLED)                    → "
            + orders.countByStatus(St5.CANCELLED));
        System.out.println("  existsByOrderNo(\"SO-2026-000001\")           → "
            + orders.existsByOrderNo("SO-2026-000001"));
        System.out.println("  findTop3ByStatusOrderByTotalAmountDesc      → "
            + orders.findTop3ByStatusOrderByTotalAmountDesc(St5.PENDING).size());

        showSql("findByCustomer_TierAndPlacedAtBetweenOrderByPlacedAtDesc 產生的 SQL", () ->
            orders.findByCustomer_TierAndPlacedAtBetweenOrderByPlacedAtDesc(
                Tier5.GOLD, Instant.parse("2026-09-01T00:00:00Z"),
                Instant.parse("2026-09-02T00:00:00Z")));
    }
```

```
═══ 5.7.1 衍生查詢：方法名就是查詢 ═══
  findByStatus(PENDING)                       → 23 張
  findByStatusAndTotalAmountGreaterThan       → 9
  findByCustomer_TierAndPlacedAtBetween…      → 6
  countByStatus(CANCELLED)                    → 7
  existsByOrderNo("SO-2026-000001")           → true
  findTop3ByStatusOrderByTotalAmountDesc      → 3
── findByCustomer_TierAndPlacedAtBetweenOrderByPlacedAtDesc 產生的 SQL → 1 句 SQL
   select o1_0.id,…,o1_0.total_amount from orders o1_0
     join customer c1_0 on c1_0.id=o1_0.customer_id
    where c1_0.tier=? and o1_0.placed_at between ? and ? order by o1_0.placed_at desc
```

**三個觀察**：

**① 底線是「路徑分隔」的明確寫法。**
`findByCustomer_Tier` = `o.customer.tier`。
不寫底線也常常會通（`findByCustomerTier`），
**而如果實體上剛好有一個叫 `customerTier` 的屬性，它就會解析到別的地方去。**
✅ **跨關聯的路徑一律寫底線。**

**② 而它一樣是隱式 join（5.3.3）**：那句 SQL 是 `join customer`，**不是 `left join`**。
🔴 **所以 `findByRep_Name(...)` 會漏掉 `rep_id` 是 null 的訂單**——
衍生查詢**寫不出 `left join`**，這是它的能力邊界之一。

**③ 方法名會爆炸。** 上面那個名字有 55 個字元，而它只表達了三個條件。
再加兩個可選條件，你需要的是 **2⁵ = 32 個方法**——
**這就是 5.9（Criteria）與 5.10（QueryDSL）存在的理由。**

> 📌 **衍生查詢的適用範圍**：
> **1～3 個【固定】條件的查詢。**
> 超過就換 `@Query`；條件是**動態的**就換 Specification / QueryDSL。

### 5.7.2 實測：`@Query`

```java
    @Test @Transactional
    void query註解() {
        head("5.7.2 @Query");
        System.out.println("  JPQL   → " + orders.search(St5.PENDING, new BigDecimal("230")).size());
        System.out.println("  原生   → " + orders.searchNative("PENDING").size());
        System.out.println("  SpEL   → " + orders.countBySpel(St5.PENDING)
            + "  （#{#entityName} 被換成 Ord5）");
        showSql("原生查詢的 SQL", () -> orders.searchNative("PENDING"));
    }
```

```
═══ 5.7.2 @Query ═══
  JPQL   → 9
  原生   → 23
  SpEL   → 23  （#{#entityName} 被換成 Ord5）
── 原生查詢的 SQL → 1 句 SQL
   select * from orders where status = ?
```

對應的 repository 定義：

```java
    @Query("select o from Ord5 o where o.status = :st and o.totalAmount > :amt")
    List<Ord5> search(@Param("st") St5 status, @Param("amt") BigDecimal amount);

    @Query(value = "select * from orders where status = :st", nativeQuery = true)
    List<Ord5> searchNative(@Param("st") String status);

    /** SpEL：#{#entityName} 會被換成實體名，抽共用基底介面時很有用。 */
    @Query("select count(o) from #{#entityName} o where o.status = :st")
    long countBySpel(@Param("st") St5 status);
```

⚠️ **注意原生查詢那個參數的型別是 `String` 不是 `St5`**：
原生 SQL 不經過 JPA 的型別轉換，**列舉要自己轉成字串**。
（5.11 會完整處理原生查詢。）

⚠️ **`@Param` 在 Java 21 上可以省略**（`-parameters` 編譯選項，Spring Boot 預設有開），
**而省略之後，`@Query` 裡的 `:st` 就跟參數名綁死了**——
改參數名不會編譯錯誤，會在**啟動時**才炸（5.7.7）。**寫出來比較安全。**

### 5.7.3 實測：`Page` / `Slice` / `List`

```java
    @Test @Transactional
    void 分頁的三種回傳型別() {
        head("5.7.3 Page / Slice / List：差在那一句 count");
        var pg = PageRequest.of(0, 10);

        List<String> a = spy(() -> orders.findByStatus(St5.PENDING, pg));
        System.out.println("  Page  → " + a.size() + " 句 SQL");
        a.forEach(s -> System.out.println("     " + cut(s)));

        List<String> b = spy(() -> orders.findByStatusOrderByPlacedAtDesc(St5.PENDING, pg));
        System.out.println("  Slice → " + b.size() + " 句 SQL");
        b.forEach(s -> System.out.println("     " + cut(s)));

        List<String> c = spy(() -> orders.findByStatusOrderByOrderNo(St5.PENDING, pg));
        System.out.println("  List  → " + c.size() + " 句 SQL");
        c.forEach(s -> System.out.println("     " + cut(s)));

        var slice = orders.findByStatusOrderByPlacedAtDesc(St5.PENDING, pg);
        System.out.println("\n  Slice 知道「有沒有下一頁」：hasNext = " + slice.hasNext()
            + "（它多撈了一筆，limit 11）");
        var page = orders.findByStatus(St5.PENDING, pg);
        System.out.println("  Page  知道「總共幾筆」：totalElements = " + page.getTotalElements());
    }
```

```
═══ 5.7.3 Page / Slice / List：差在那一句 count ═══
  Page  → 2 句 SQL
     select o1_0.id,…,o1_0.total_amount from orders o1_0 where o1_0.status=? limit ?,?
     select count(o1_0.id) from orders o1_0 where o1_0.status=?
  Slice → 1 句 SQL
     select o1_0.id,…,o1_0.total_amount from orders o1_0 where o1_0.status=? order by … limit ?,?
  List  → 1 句 SQL
     select o1_0.id,…,o1_0.total_amount from orders o1_0 where o1_0.status=? order by … limit ?,?

  Slice 知道「有沒有下一頁」：hasNext = true（它多撈了一筆，limit 11）
  Page  知道「總共幾筆」：totalElements = 23
```

| 回傳型別 | SQL 句數 | 你拿得到 | 什麼時候用 |
|---|---|---|---|
| `List<T>` + `Pageable` | 1 | 這一頁的內容 | 你根本不需要總筆數（無限捲動、匯出） |
| `Slice<T>` | 1 | 內容 + `hasNext()` | 「載入更多」按鈕。**它多撈一筆來判斷有沒有下一頁** |
| `Page<T>` | **2** | 內容 + 總筆數 + 總頁數 | 要顯示「第 3 / 87 頁」 |

> 📌 **`Page` 的第二句 count 在大表上很貴。**
> `count(*)` 在 InnoDB 上沒有捷徑：它要掃過一個索引
> （越窄越好 —— 07 站 03 章 3.6 的覆蓋索引），
> 一張千萬列的表上這一句可能比主查詢還慢。
> **問清楚前端到底要不要那個總筆數** —— 很多時候不要。

⚠️ **一個容易誤判的優化**：Spring Data 在
「`offset = 0` 而且結果**不滿一頁**」時**會跳過 count 查詢**，
直接用結果筆數當總數（`PageableExecutionUtils`）。
**所以你在小資料量上測不到那一句 count。**
（下一格的實驗因此一定要用「第二頁」。）

### 5.7.4 🔴 實測：自動生成的 count 會算錯

這是 5.3.5 那個「結果筆數跟 count 對不上」的實務版本。

```java
    @Test @Transactional
    void 自動生成的count會算錯() {
        head("5.7.4 🔴 join 集合 + Page：自動生成的 count");
        // ★ 一定要用「第二頁」：offset = 0 而且結果不滿一頁時，
        //   Spring Data 會【跳過 count 查詢】直接用結果筆數當總數（PageableExecutionUtils）。
        var pg = PageRequest.of(1, 5);

        var bad = orders.findWithItems(0, pg);
        System.out.println("  findWithItems       → 這一頁 " + bad.getContent().size()
            + " 筆、totalElements = " + bad.getTotalElements() + "  🔴");
        List<String> s1 = spy(() -> orders.findWithItems(0, pg));
        s1.forEach(x -> System.out.println("     " + cut(x)));

        var good = orders.findWithItemsFixed(0, pg);
        System.out.println("\n  findWithItemsFixed  → 這一頁 " + good.getContent().size()
            + " 筆、totalElements = " + good.getTotalElements() + "  ✅");
        List<String> s2 = spy(() -> orders.findWithItemsFixed(0, pg));
        s2.forEach(x -> System.out.println("     " + cut(x)));

        System.out.println("\n  實際上有 " + orders.count() + " 張訂單、"
            + jdbc.queryForObject("select count(*) from order_item", Long.class) + " 筆明細。");
    }
```

repository 的兩個定義只差一個 `countQuery`：

```java
    /** 🔴 join 集合 + Page：自動生成的 count 會放大（5.3.5） */
    @Query("select o from Ord5 o join o.items i where i.qty > :q")
    Page<Ord5> findWithItems(@Param("q") int qty, Pageable page);

    /** ✅ 自己寫 countQuery */
    @Query(value = "select o from Ord5 o join o.items i where i.qty > :q",
           countQuery = "select count(distinct o) from Ord5 o join o.items i where i.qty > :q")
    Page<Ord5> findWithItemsFixed(@Param("q") int qty, Pageable page);
```

```
═══ 5.7.4 🔴 join 集合 + Page：自動生成的 count ═══
  findWithItems       → 這一頁 5 筆、totalElements = 60  🔴
     select o1_0.id,…,o1_0.total_amount from orders o1_0
       join order_item i1_0 on o1_0.id=i1_0.order_id where i1_0.qty>? limit ?,?
     select count(o1_0.id) from orders o1_0 join order_item i1_0 on o1_0.id=i1_0.order_id where i1_0.qty>?

  findWithItemsFixed  → 這一頁 5 筆、totalElements = 30  ✅
     select o1_0.id,… from orders o1_0 join order_item i1_0 on … where i1_0.qty>? limit ?,?
     select count(distinct o1_0.id) from orders o1_0 join order_item i1_0 on … where i1_0.qty>?

  實際上有 30 張訂單、60 筆明細。
```

**總筆數 60，實際 30。前端會顯示「共 12 頁」，而第 7 頁之後全部是空的。**

🔴 **而這個 bug 幾乎不可能在開發時被發現**：
你看到第一頁有 5 筆，翻到第二頁也有 5 筆，一切正常。
**要翻到後面才會看到空頁。**

> ✅ **規則**：`Page<T>` 的查詢裡只要 `from` 有 **to-many 的 join**，
> **就一定要自己寫 `countQuery`**，而且要用 `count(distinct o)`。

⚠️ **注意「這一頁 5 筆」也是碰巧**：`limit 5` 拿到 5 列 SQL 結果，
去重之後可能只剩 3 張訂單（5.3.5 的第 ① 點）。
**join 集合 + 分頁，內容跟總數兩邊都是錯的** ——
04 章 4.5.5 已經證明過 `join fetch` 版本更慘（記憶體分頁）。
**正解還是 04 章 4.9.3 那一列：`@EntityGraph` 只含 `@ManyToOne` + 集合靠 `@BatchSize`。**

### 5.7.5 批次操作

（5.6 已經量過。這裡只放 repository 的寫法。）

```java
    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("update Ord5 o set o.status = :to where o.status = :from")
    int changeStatus(@Param("from") St5 from, @Param("to") St5 to);
```

### 5.7.6 實測：`Sort` —— 唯一能「動態」的部分

```java
    @Test @Transactional
    void 動態排序() {
        head("5.7.6 Sort：唯一能「動態」的部分");
        showSql("Sort.by(\"placedAt\").descending()", () ->
            orders.findByStatus(St5.PENDING, Sort.by("placedAt").descending()));
        showSql("Sort.by(\"customer.displayName\")", () ->
            orders.findByStatus(St5.PENDING, Sort.by("customer.displayName")));

        System.out.println("\n  🔴 屬性名不存在會怎樣：");
        try {
            orders.findByStatus(St5.PENDING, Sort.by("totalAmout"));
        } catch (Exception e) {
            System.out.println("    " + e.getClass().getSimpleName() + ": "
                + cut(String.valueOf(e.getMessage()).replaceAll("\\s+", " ")));
        }

        System.out.println("\n  Sort 只收【屬性名】，所以 length(orderNo) 這種排序寫不出來：");
        try {
            orders.findByStatus(St5.PENDING, Sort.by("length(orderNo)"));
        } catch (Exception e) {
            System.out.println("    " + e.getClass().getSimpleName() + ": "
                + cut(String.valueOf(e.getMessage()).replaceAll("\\s+", " ")));
        }

        System.out.println("\n  🔴 JpaSort.unsafe 會把字串【原樣】放進 order by（只對 @Query 有效）：");
        showSql("JpaSort.unsafe(\"length(o.orderNo)\")", () ->
            orders.searchSorted(St5.PENDING,
                org.springframework.data.jpa.domain.JpaSort.unsafe("length(o.orderNo)")));
        showSql("JpaSort.unsafe(\"(select count(i) from Item5 i where i.order = o)\")", () ->
            orders.searchSorted(St5.PENDING, org.springframework.data.jpa.domain.JpaSort.unsafe(
                "(select count(i) from Item5 i where i.order = o)")));
    }
```

```
═══ 5.7.6 Sort：唯一能「動態」的部分 ═══
── Sort.by("placedAt").descending() → 1 句 SQL
   select … from orders o1_0 where o1_0.status=? order by o1_0.placed_at desc
── Sort.by("customer.displayName") → 1 句 SQL
   select … from orders o1_0 join customer c1_0 on c1_0.id=o1_0.customer_id order by c1_0.display_name

  🔴 屬性名不存在會怎樣：
    PropertyReferenceException: No property 'totalAmout' found for type 'Ord5'; Did you mean 'totalAmount'

  Sort 只收【屬性名】，所以 length(orderNo) 這種排序寫不出來：
    PropertyReferenceException: No property 'length(orderNo)' found for type 'Ord5'

  🔴 JpaSort.unsafe 會把字串【原樣】放進 order by（只對 @Query 有效）：
── JpaSort.unsafe("length(o.orderNo)") → 1 句 SQL
   select … from orders o1_0 where o1_0.status=? order by character_length(o1_0.order_no)
── JpaSort.unsafe("(select count(i) from Item5 i where i.order = o)") → 1 句 SQL
   select … from orders o1_0 where o1_0.status=?
    order by (select count(i1_0.id) from order_item i1_0 where o1_0.id=i1_0.order_id)
```

**三個觀察**：

**① `Sort` 是唯一可以「動態」而且安全的部分。**
它收的是**屬性名**，Spring Data 會拿實體的中繼資料檢查——
打錯字拋 `PropertyReferenceException`，而且訊息會告訴你「你是不是要寫 totalAmount」。

**② 它也只能收屬性名。** `length(orderNo)` 這種表達式排序寫不出來。

**③ 🔴 `JpaSort.unsafe` 把字串原樣放進 `order by`。**
上面第二個例子直接塞了一整句子查詢進去，**而且它跑起來了**。

> 🔴 **`JpaSort.unsafe` 是一個注入點。**
> 如果那個字串有任何一部分來自使用者輸入（例如前端傳來的 `sort=xxx`），
> **它就是 5.5.2 的注入，而且是在你以為「Spring Data 幫我擋掉了」的地方。**
>
> ✅ **前端傳來的排序欄位，一律過一個白名單**：
>
> ```java
> private static final Set<String> SORTABLE = Set.of("placedAt", "totalAmount", "orderNo");
>
> Sort sort = SORTABLE.contains(field) ? Sort.by(field) : Sort.by("placedAt");
> ```

### 5.7.7 實測：錯字什麼時候會被發現 ★

**這一格是這一節真正的重點，也是 5.9 / 5.10 的前提。**

```java
package com.example.lab.ch05;

import org.junit.jupiter.api.Test;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;

import java.io.OutputStream;
import java.io.PrintStream;

/**
 * 5.7.7：查詢的錯字什麼時候會被發現。
 * ★ 這個測試【不能】繼承 Base05（也不能有 @SpringBootTest）——
 *   否則它自己啟動的那兩個 context 會被 Spring Test 當成本測試類別的組態，
 *   於是「啟動失敗」變成整個測試類別失敗。
 */
class F6bStartup {

    private static final PrintStream REAL_OUT = System.out;

    private static String cut(String s) {
        return s == null ? "null" : (s.length() > 170 ? s.substring(0, 170) + "…" : s);
    }

    /** 啟動失敗會印一整頁 stack trace；這一格要看的是「有沒有失敗」，不是那一頁。 */
    private void boot(String label, Class<?> cfg) {
        PrintStream out = System.out, err = System.err;
        PrintStream sink = new PrintStream(OutputStream.nullOutputStream());
        System.setOut(sink); System.setErr(sink);
        String result;
        try (var ctx = new SpringApplicationBuilder(cfg)
                .web(WebApplicationType.NONE).bannerMode(org.springframework.boot.Banner.Mode.OFF)
                .properties("spring.datasource.url=jdbc:mysql://127.0.0.1:33306/ch05",
                            "spring.datasource.username=root", "spring.datasource.password=root",
                            "spring.jpa.hibernate.ddl-auto=none")
                .run()) {
            result = "context 起來了 🔴（沒抓到）";
        } catch (Exception e) {
            Throwable root = e; while (root.getCause() != null) root = root.getCause();
            result = "✅ 啟動失敗：" + root.getClass().getSimpleName() + "\n     "
                   + cut(String.valueOf(root.getMessage()).replaceAll("\\s+", " "));
        } finally {
            System.setOut(out); System.setErr(err);
        }
        REAL_OUT.println("  " + label + "\n     → " + result);
    }

    @Test
    void 打錯字在啟動時就會被抓到() {
        REAL_OUT.println("\n═══ 5.7.7 ★ 查詢的錯字什麼時候會被發現 ═══");
        boot("① @Query 裡的屬性名打錯（o.totalAmout）", com.example.badrepo.q.BadCfg.class);
        boot("② 衍生查詢的屬性名打錯（findByStatuss）", com.example.badrepo.d.BadDerivedCfg.class);
    }
}
```

兩個「壞掉的」repository 與它們各自的組態
（**放在 `com.example.badrepo` 底下 —— 不能讓主應用程式掃到它們**）：

```java
package com.example.badrepo.q;

import com.example.lab.ch05.Ord5;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

import java.util.List;
import java.util.UUID;

/** ★ 故意打錯字：totalAmout 少一個 n。 */
public interface BadRepo extends JpaRepository<Ord5, UUID> {

    @Query("select o from Ord5 o where o.totalAmout > 100")
    List<Ord5> typo();
}
```

```java
package com.example.badrepo.q;

import com.example.lab.ch05.Ord5;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.autoconfigure.domain.EntityScan;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.jpa.repository.config.EnableJpaRepositories;

@Configuration @EnableAutoConfiguration
@EntityScan(basePackageClasses = Ord5.class)
@EnableJpaRepositories(basePackageClasses = BadRepo.class)
public class BadCfg {}
```

```java
package com.example.badrepo.d;

import com.example.lab.ch05.Ord5;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

/** ★ 衍生查詢的屬性名打錯：Statuss。 */
public interface BadDerivedRepo extends JpaRepository<Ord5, UUID> {
    List<Ord5> findByStatuss(String s);
}
```

```java
package com.example.badrepo.d;

import com.example.lab.ch05.Ord5;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.autoconfigure.domain.EntityScan;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.jpa.repository.config.EnableJpaRepositories;

@Configuration @EnableAutoConfiguration
@EntityScan(basePackageClasses = Ord5.class)
@EnableJpaRepositories(basePackageClasses = BadDerivedRepo.class)
public class BadDerivedCfg {}
```

```
═══ 5.7.7 ★ 查詢的錯字什麼時候會被發現 ═══
  ① @Query 裡的屬性名打錯（o.totalAmout）
     → ✅ 啟動失敗：PathElementException
     Could not resolve attribute 'totalAmout' of 'com.example.lab.ch05.Ord5'
  ② 衍生查詢的屬性名打錯（findByStatuss）
     → ✅ 啟動失敗：PropertyReferenceException
     No property 'statuss' found for type 'Ord5'; Did you mean 'status'
```

**兩種都在【啟動時】就炸，不是等到有人呼叫那個方法。**

這件事的價值比它看起來大：

```
一個沒被任何測試涵蓋、一年只在月結跑一次的查詢方法，
如果它的錯字要等到「有人呼叫」才會發現 → 你會在月結那天的凌晨兩點發現。
而 Spring Data 讓它在【每一次啟動】都會被檢查一次。
   ↓
你的 CI 只要跑得起一個 @SpringBootTest，就等於檢查過【全部】的查詢定義。
```

📌 **這是 5.13.1 那條 CI 斷言的基礎。**

⚠️ **而有兩種東西【不會】在啟動時被檢查**：

| | 啟動時檢查嗎 | 為什麼 |
|---|---|---|
| 衍生查詢的屬性名 | ✅ | Spring Data 用實體中繼資料解析方法名 |
| `@Query` 的 JPQL | ✅ | Hibernate 會把它剖析成 SQM |
| **`@Query(nativeQuery = true)` 的 SQL** | 🔴 **不會** | 那是一個字串，沒有人看得懂它 |
| **`em.createQuery("…")` 寫在 Service 裡的 JPQL** | 🔴 **不會** | 它在方法被呼叫時才剖析 |

> ✅ **這就是「查詢應該定義在 repository 介面上」的第三個理由**
> （前兩個是 06 站 03 章的「一個地方找得到」與「可測試」；
> 06 站 03 章 3.4.3 也量過同一件事，這裡補上 `@Query` 與原生 SQL 的差別）：
> **它會在啟動時被驗證。**

---

## 5.8 DTO 投影 ★★

**這一節是這一章的主線。**

### 5.8.1 那一頁到底需要什麼

回到 04 章 4.9.1 那個列表頁。它的每一列要顯示：

```
訂單編號   狀態    金額      客戶名稱   明細筆數
SO-…001   PENDING  250.00   客戶0      2
```

**五個值。** 而 04 章的五種解法，每一種都建了 650 個實體。

```
650 個實體 = 200 個 Ord5 + 400 個 Item5 + 50 個 Cust5

每一個實體的成本（00 章 0.7 結論三、03 章 3.4）：
   ① 註冊進持久化情境（一個 Map 的項目）
   ② 拍一份快照（一個 Object[]，每一個欄位一格）
   ③ 集合包成 PersistentBag
   ④ 交易結束前，逐欄位比對一次快照
```

**而這一頁從頭到尾都不會改任何東西。**

### 5.8.2 寫法一：建構子表達式

```java
package com.example.lab.ch05;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

/** 列表頁那一列真正需要的東西。它不是實體 —— 不進持久化情境、沒有快照。 */
public record OrderRow(
        UUID id, String orderNo, String customerName,
        St5 status, BigDecimal totalAmount, Instant placedAt, long itemCount) {}
```

```java
    @Query("""
           select new com.example.lab.ch05.OrderRow(
                    o.id, o.orderNo, c.displayName, o.status, o.totalAmount, o.placedAt,
                    (select count(i) from Item5 i where i.order = o))
             from Ord5 o join o.customer c
            where o.status = :st
            order by o.placedAt desc
           """)
    List<OrderRow> rows(@Param("st") St5 status);
```

**四條規則**：

```
① 要寫【完整的類別名】（含 package）。JPQL 沒有 import。
② 建構子的參數順序、個數要對得上 select 的順序。
③ record 完全可以用 —— 它的正規建構子就是那個建構子。
④ 型別要【相容】（不必完全一樣）：上面那個子查詢回 Long，而 itemCount 是 long，可以。
```

### 5.8.3 寫法二：介面投影

Spring Data 的做法：**宣告一個只有 getter 的介面**，它會產生一個代理實作。

```java
package com.example.lab.ch05;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

/** 封閉式介面投影：只有 getter，Spring Data 會產生代理實作。 */
public interface OrderRowView {
    UUID getId();
    String getOrderNo();
    St5 getStatus();
    BigDecimal getTotalAmount();
    Instant getPlacedAt();
    CustomerView getCustomer();          // 巢狀投影

    interface CustomerView {
        String getDisplayName();
        Tier5 getTier();
    }
}
```

```java
    /** 連 @Query 都不用寫：方法名 + 回傳型別就夠了 */
    List<OrderRowView> findViewByStatus(St5 status);
```

**而它還有一個「開放式」的版本**，可以用 SpEL 組值：

```java
package com.example.lab.ch05;

import org.springframework.beans.factory.annotation.Value;

import java.math.BigDecimal;

/** 開放式介面投影：帶 @Value 的 SpEL —— 5.8.3 要量它的代價。 */
public interface OrderOpenView {
    String getOrderNo();
    BigDecimal getTotalAmount();

    @Value("#{target.customer.displayName + '（' + target.status + '）'}")
    String getLabel();
}
```

**看起來開放式版本只是「多一點方便」。5.8.6 會量出它的代價。**

### 5.8.4 寫法三：`Object[]` 與 `Tuple`

```java
    @Query("select o.id, o.orderNo, c.displayName, o.status, o.totalAmount, o.placedAt"
         + "  from Ord5 o join o.customer c where o.status = :st")
    List<Object[]> tuples(@Param("st") St5 status);
```

```java
        List<Tuple> tuples = em.createQuery(
            "select o.orderNo as no, o.totalAmount as amt from Ord5 o where o.status = :st", Tuple.class)
            .setParameter("st", St5.PENDING).setMaxResults(1).getResultList();
        System.out.println("  ④b Tuple → no=" + tuples.get(0).get("no")
            + " amt=" + tuples.get(0).get("amt"));
```

`Tuple` 比 `Object[]` 好一點：可以用**別名**取值，不用數位置。
**而兩者都沒有型別安全**——`get("amt")` 回的是 `Object`。

### 5.8.5 實測：寫法四 —— Hibernate 6 的隱式建構

Hibernate 6 可以**不寫 `select new`**，直接指定回傳型別：

```java
package com.example.lab.ch05;

import java.math.BigDecimal;
import java.util.UUID;

/** 5.8.5 的隱式建構要用：每一個元件的型別都跟 select 出來的【完全一樣】。 */
public record OrderMini(UUID id, String orderNo, String customerName, BigDecimal totalAmount) {}
```

```java
        showSql("⑤ Hibernate 6 隱式建構（走 EntityManager）", () -> em.createQuery(
            "select o.id, o.orderNo, c.displayName, o.totalAmount"
          + "  from Ord5 o join o.customer c where o.status = :st", OrderMini.class)
            .setParameter("st", St5.PENDING).getResultList());
        em.clear();

        System.out.println("\n  🔴 隱式建構要求型別【完全吻合】（OrderRow 的 itemCount 是 long）：");
        try {
            em.createQuery("select o.id, o.orderNo, c.displayName, o.status, o.totalAmount,"
                         + " o.placedAt, 0L from Ord5 o join o.customer c", OrderRow.class)
              .setMaxResults(1).getResultList();
            System.out.println("     跑掉了");
        } catch (Exception e) {
            System.out.println("     " + e.getClass().getSimpleName() + ": "
                + cut(String.valueOf(e.getMessage()).replaceAll("\\s+", " ")));
        }
        em.clear();
        System.out.println("  ✅ 而同一組欄位用 select new，同一個 record 就沒問題（② 已經證明了）");

        System.out.println("\n  🔴 隱式建構放進 Spring Data 的 @Query（回傳 List<OrderRow>）：");
        try {
            orders.implicitRows(St5.PENDING);
            System.out.println("     跑掉了");
        } catch (Exception e) {
            System.out.println("     " + e.getClass().getSimpleName() + ": "
                + cut(String.valueOf(e.getMessage()).replaceAll("\\s+", " ")));
        }
```

```
── ⑤ Hibernate 6 隱式建構（走 EntityManager） → 1 句 SQL
   select o1_0.id,o1_0.order_no,c1_0.display_name,o1_0.total_amount
     from orders o1_0 join customer c1_0 on c1_0.id=o1_0.customer_id where o1_0.status=?

  🔴 隱式建構要求型別【完全吻合】（OrderRow 的 itemCount 是 long）：
     InstantiationException: Cannot instantiate query result type 'com.example.lab.ch05.OrderRow'
     due to: com.example.lab.ch05.OrderRow.<init>(java.util.UUID,java.lang.String,…,java.lang.Long)
  ✅ 而同一組欄位用 select new，同一個 record 就沒問題（② 已經證明了）

  🔴 隱式建構放進 Spring Data 的 @Query（回傳 List<OrderRow>）：
     ConverterNotFoundException: No converter found capable of converting from type
     [AbstractJpaQuery$TupleConverter$TupleBackedMap] to type [com.example.lab.ch05.OrderRow]
```

**兩個限制，都值得記住**：

**① 🔴 隱式建構要求型別【完全吻合】。**
`select … 0L`（`Long`）配上 `record OrderRow(…, long itemCount)`（原始型別 `long`）
→ `NoSuchMethodException`。**而同一組欄位用 `select new` 就沒事**，
因為建構子表達式會找**相容**的建構子。

**② 🔴 它在 Spring Data 的 `@Query` 上不能用。**
Spring Data 看到「回傳型別是一個非實體的類別」，會啟動它自己的投影機制
（把結果當成 `Tuple` 再轉），於是撞上 `ConverterNotFoundException`。

> 📌 **結論**：
> **隱式建構是寫 `em.createQuery` 時的一個便利；
> repository 介面上還是老老實實寫 `select new`。**

### 5.8.6 實測：同一頁，六種回傳型別 ★★

```java
package com.example.lab.ch05;

import jakarta.persistence.Tuple;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.PageRequest;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** 5.8：DTO 投影。 */
class F7Projection extends Base05 {

    @Autowired Ord5Repo orders;
    @Autowired Item5Repo items;

    @BeforeEach void setUp() { seedPage(); }        // 200 張訂單 / 50 客戶 / 400 明細

    /** 量一個寫法：SQL 句數、PC 實體數、結果筆數、最快毫秒。 */
    private void row(String label, java.util.function.Supplier<List<?>> body) {
        int[] sql = new int[1]; int[] pc = new int[1]; int[] n = new int[1];
        tx.executeWithoutResult(s -> {
            em.clear();
            List<String> sqls = spy(() -> n[0] = body.get().size());
            sql[0] = sqls.size();
            pc[0] = managedEntities();
        });
        long ms = bestMs(() -> tx.executeWithoutResult(s -> { em.clear(); body.get(); }), 3, 5);
        System.out.printf("  %-30s %5d %8d %7d %6d%n", label, sql[0], pc[0], n[0], ms);
    }

    @Test
    void 六種回傳型別() {
        head("5.8.6 同一頁（200 張 PENDING 訂單），六種回傳型別");
        System.out.printf("  %-30s %5s %8s %7s %6s%n", "寫法", "SQL", "PC實體", "筆數", "ms");

        row("① select o（實體）", () -> orders.findByStatus(St5.PENDING));
        row("② 建構子表達式 → record", () -> orders.rows(St5.PENDING));
        row("③ 介面投影（封閉）", () -> orders.findViewByStatus(St5.PENDING));
        row("③b 介面投影（開放 @Value）", () -> orders.findOpenByStatus(St5.PENDING));
        row("④ Object[]", () -> orders.tuples(St5.PENDING));
        row("⑤ Hibernate 6 隱式建構", () -> em.createQuery(
            "select o.id, o.orderNo, c.displayName, o.totalAmount"
          + "  from Ord5 o join o.customer c where o.status = :st", OrderMini.class)
            .setParameter("st", St5.PENDING).getResultList());
    }
}
```

```
═══ 5.8.6 同一頁（200 張 PENDING 訂單），六種回傳型別 ═══
  寫法                               SQL     PC實體      筆數     ms
  ① select o（實體）                     1      150     150      4
  ② 建構子表達式 → record                  1        0     150      1
  ③ 介面投影（封閉）                         1       50     150      2
  ③b 介面投影（開放 @Value）                 1      150     150      4
  ④ Object[]                         1        0     150      1
  ⑤ Hibernate 6 隱式建構                 1        0     150      1
```

**而它們產生的 SQL 差很多**：

```
── ① select o（實體）
   select o1_0.id,o1_0.customer_id,o1_0.order_no,o1_0.placed_at,o1_0.rep_id,
          o1_0.status,o1_0.total_amount from orders o1_0 where o1_0.status=?

── ② 建構子表達式
   select o1_0.id,o1_0.order_no,c1_0.display_name,o1_0.status,o1_0.total_amount,o1_0.placed_at,
          (select count(i1_0.id) from order_item i1_0 where i1_0.order_id=o1_0.id)
     from orders o1_0 join customer c1_0 on c1_0.id=o1_0.customer_id where o1_0.status=?

── ③ 介面投影（封閉）
   select o1_0.id,o1_0.order_no,o1_0.status,o1_0.total_amount,o1_0.placed_at,
          c1_0.id,c1_0.display_name,c1_0.email,c1_0.tier
     from orders o1_0 join customer c1_0 on … where o1_0.status=?
                            ▲ 介面上沒有 email，而它被撈回來了

── ③b 介面投影（開放，帶 @Value SpEL）
   select o1_0.id,o1_0.customer_id,o1_0.order_no,o1_0.placed_at,o1_0.rep_id,
          o1_0.status,o1_0.total_amount from orders o1_0 where o1_0.status=?
                            ▲ 跟 ① 一模一樣 —— 它撈的是【整個實體】
```

**四個觀察**：

**① ② / ④ / ⑤ 的 `PC實體` 是 0。**
150 筆結果，持久化情境裡一個實體都沒有。
**沒有快照、沒有髒檢查、交易結束時什麼事都不用做。**

**② 🔴 ③（封閉介面投影）的 PC 裡有 50 個實體。**
那 50 個是 `Cust5`。因為 `getCustomer()` 回的是一個**巢狀投影**，
而 Hibernate 為了組出它，把整個 `Cust5` 撈成實體了——
注意 SQL 裡有 `c1_0.email`，**那個欄位介面上根本沒有**。

> ⚠️ **規則**：**封閉介面投影碰到「關聯」的時候，會退化成載入整個關聯實體。**
> 只投影**根實體自己的欄位**時它是乾淨的；一旦有巢狀投影就不是了。

**③ 🔴 ③b（開放介面投影）的 SQL 跟「查實體」一模一樣，PC 裡 150 個實體。**

```
@Value("#{target.customer.displayName + …}")
              ▲
        target 是【那個實體】。
        SpEL 可以呼叫它任何一個方法 → Spring Data 沒辦法知道你會用到哪些欄位
           ↓
        只好把整個實體撈出來。
```

**開放投影的方便，代價是「投影」這件事整個消失了。**
它跟 `select o` 之後在 Java 端組字串，**完全一樣**。

**④ 時間差是 4 ms → 1 ms。** 在 150 筆上是 3 ms，看起來不多。
**而下一格會證明它不是常數。**

> 📌 **一張可以背下來的表**：
>
> | 寫法 | 型別安全 | PC 實體 | 只撈需要的欄位 | 建議 |
> |---|---|---|---|---|
> | 建構子表達式 → record | ✅ | 0 | ✅ | **★ 預設選它** |
> | 介面投影（封閉、無關聯） | ✅ | 0 | ✅ | 可以，少寫一個 record |
> | 介面投影（封閉、有巢狀） | ✅ | **關聯實體** | 🔴 | 小心 |
> | 介面投影（開放 `@Value`） | ✅ | **全部** | 🔴 | **不要用它做效能優化** |
> | `Object[]` / `Tuple` | 🔴 | 0 | ✅ | 臨時查詢、動態欄位 |
> | Hibernate 隱式建構 | ✅ | 0 | ✅ | 只在 `em.createQuery` 上 |

### 5.8.7 實測：報表

```java
package com.example.lab.ch05;

import java.math.BigDecimal;

/** 5.8.7 的報表：一列 = 一個客戶。 */
public record CustomerSales(String customerName, Tier5 tier, long orderCount, BigDecimal total) {}
```

```java
    @Query("""
           select new com.example.lab.ch05.CustomerSales(c.displayName, c.tier, count(o), sum(o.totalAmount))
             from Ord5 o join o.customer c
            group by c.displayName, c.tier
            order by sum(o.totalAmount) desc
           """)
    List<CustomerSales> salesByCustomer();
```

```
═══ 5.8.7 報表：一列 = 一個客戶 ═══
  50 列，前 5 列：
    客戶24     NORMAL     4 張     980.0000
    客戶3      NORMAL     4 張     980.0000
    客戶38     GOLD       4 張     980.0000
    客戶17     GOLD       4 張     980.0000
    客戶31     SILVER     4 張     980.0000
  PC 裡 0 個實體
── SQL → 1 句 SQL
   select c1_0.display_name,c1_0.tier,count(o1_0.id),sum(o1_0.total_amount)
     from orders o1_0 join customer c1_0 on c1_0.id=o1_0.customer_id group by c1_0.display_name,c1_0.tier
```

📌 **報表是投影最沒有爭議的場景**：
`count(o)` 與 `sum(o.totalAmount)` **根本不對應到任何實體的任何欄位**。
你連「要不要用實體」這個問題都不用問。

### 5.8.8 實測：DTO 裡面要有集合的時候 🔴

**這是 DTO 投影最真實的限制**：

> **`select new` 的參數只能是【純量】。你不能在裡面放一個集合。**

那怎麼辦？兩種做法。

```java
package com.example.lab.ch05;

import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;

/** 5.8.8：DTO 裡面要有明細的時候。 */
public record OrderDetailRow(UUID id, String orderNo, String customerName,
                             BigDecimal totalAmount, List<Line> lines) {
    public record Line(String productName, int qty, BigDecimal lineAmount) {}
}
```

```java
    @Test
    void 明細怎麼進dto() {
        head("5.8.8 DTO 裡面要有集合的時候");

        // 做法一：一句 join，自己在 Java 端 group
        tx.executeWithoutResult(s -> {
            em.clear();
            List<String> sqls = spy(() -> {
                List<Object[]> flat = em.createQuery("""
                        select o.id, o.orderNo, c.displayName, o.totalAmount,
                               i.productName, i.qty, i.lineAmount
                          from Ord5 o join o.customer c left join o.items i
                         where o.status = :st
                        """, Object[].class).setParameter("st", St5.PENDING).getResultList();
                System.out.println("  ① 一句 join → SQL 回 " + flat.size() + " 列");
                Map<UUID, OrderDetailRow> m = new LinkedHashMap<>();
                for (Object[] x : flat) {
                    OrderDetailRow row = m.computeIfAbsent((UUID) x[0], k -> new OrderDetailRow(
                            (UUID) x[0], (String) x[1], (String) x[2],
                            (java.math.BigDecimal) x[3], new ArrayList<>()));
                    if (x[4] != null) row.lines().add(new OrderDetailRow.Line(
                            (String) x[4], (Integer) x[5], (java.math.BigDecimal) x[6]));
                }
                System.out.println("     組出 " + m.size() + " 個 DTO，第一個有 "
                    + m.values().iterator().next().lines().size() + " 筆明細");
            });
            System.out.println("     " + sqls.size() + " 句 SQL、PC 裡 " + managedEntities() + " 個實體");
        });

        // 做法二：兩段式（先訂單、再一句撈全部明細）
        tx.executeWithoutResult(s -> {
            em.clear();
            List<String> sqls = spy(() -> {
                List<UUID> ids = orders.idsByStatus(St5.PENDING, PageRequest.of(0, 20));
                List<OrderRow> heads = orders.rowsByIds(ids);
                List<Object[]> lines = items.linesOf(ids);
                Map<UUID, List<OrderDetailRow.Line>> byOrder = new LinkedHashMap<>();
                for (Object[] x : lines) {
                    byOrder.computeIfAbsent((UUID) x[0], k -> new ArrayList<>())
                           .add(new OrderDetailRow.Line((String) x[1], (Integer) x[2],
                                   (java.math.BigDecimal) x[3]));
                }
                List<OrderDetailRow> out = heads.stream().map(h -> new OrderDetailRow(
                        h.id(), h.orderNo(), h.customerName(), h.totalAmount(),
                        byOrder.getOrDefault(h.id(), List.of()))).toList();
                System.out.println("\n  ② 兩段式（第一頁 20 張）→ " + out.size() + " 個 DTO，第一個有 "
                    + out.get(0).lines().size() + " 筆明細");
            });
            System.out.println("     " + sqls.size() + " 句 SQL、PC 裡 " + managedEntities() + " 個實體");
            sqls.forEach(x -> System.out.println("       " + cut(x)));
        });
    }
```

```
═══ 5.8.8 DTO 裡面要有集合的時候 ═══
  ① 一句 join → SQL 回 300 列
     組出 150 個 DTO，第一個有 2 筆明細
     1 句 SQL、PC 裡 0 個實體

  ② 兩段式（第一頁 20 張）→ 20 個 DTO，第一個有 2 筆明細
     3 句 SQL、PC 裡 0 個實體
       select o1_0.id from orders o1_0 where o1_0.status=? order by o1_0.placed_at desc limit ?,?
       select o1_0.id,o1_0.order_no,c1_0.display_name,…,0 from orders o1_0 join customer c1_0 on …
       select i1_0.order_id,i1_0.product_name,i1_0.qty,i1_0.line_amount
         from order_item i1_0 where i1_0.order_id in (?,?,?,…共 20 個)
```

**兩種做法的比較**：

| | ① 一句 join + Java 端 group | ② 兩段式 |
|---|---|---|
| SQL | 1 句 | 2～3 句 |
| 回來的列數 | **訂單 × 明細**（笛卡兒積還在） | 訂單 + 明細（相加，不是相乘） |
| **能不能分頁** | 🔴 **不能**（跟 04 章 4.5.5 同一個理由） | ✅ **可以** |
| 程式碼 | 一段 `computeIfAbsent` 的迴圈 | 三段，要自己 join |

> 📌 **判準跟 04 章 4.9.2 完全一樣**：
> **要不要分頁？要 → 兩段式。不要（單筆、匯出）→ 一句 join。**
>
> ⚠️ 差別只在：04 章那時候你在處理「實體」，這裡你在處理「列」。
> **`join fetch` + 分頁會被 Hibernate 靜默改成記憶體分頁（`HHH90003004`）；
> 而投影 + 分頁只是【資料錯了】—— `limit 20` 砍在明細的列上，
> 你會拿到 12 張訂單，其中一張還少了明細。連警告都沒有。**

⚠️ **做法 ① 的那個 `computeIfAbsent` 迴圈，就是 MyBatis 的巢狀 `resultMap` 在做的事**
（00 章 0.7 的 ④）。**差別只在誰來寫**——
而 MyBatis 那邊要 `ORDER BY o.id`（同一張訂單的列必須相鄰），
用 `Map` 的話沒有這個限制。**08 章 8.5 會回來比較這兩種寫法。**

### 5.8.9 實測：投影 + 分頁

```java
    @Test @Transactional
    void 投影配分頁() {
        head("5.8.9 投影 + 分頁（04 章 4.5.5 那個記憶體分頁的問題還在嗎）");
        em.clear();
        List<String> sqls = spy(() -> {
            var page = orders.rowsPage(St5.PENDING, PageRequest.of(0, 20));
            System.out.println("  這一頁 " + page.getContent().size() + " 筆、共 "
                + page.getTotalElements() + " 筆、" + page.getTotalPages() + " 頁");
        });
        sqls.forEach(x -> System.out.println("    " + x));
        System.out.println("  PC 裡 " + managedEntities() + " 個實體");
    }
```

```
═══ 5.8.9 投影 + 分頁（04 章 4.5.5 那個記憶體分頁的問題還在嗎） ═══
  這一頁 20 筆、共 150 筆、8 頁
    select o1_0.id,o1_0.order_no,c1_0.display_name,o1_0.status,o1_0.total_amount,o1_0.placed_at,
           (select count(i1_0.id) from order_item i1_0 where i1_0.order_id=o1_0.id)
      from orders o1_0 join customer c1_0 on c1_0.id=o1_0.customer_id where o1_0.status=? limit ?,?
    select count(o1_0.id) from orders o1_0 where o1_0.status=?
  PC 裡 0 個實體
```

✅ **`limit ?,?` 真的在 SQL 裡**，沒有記憶體分頁的警告，PC 裡 0 個實體。

📌 **因為投影的每一列就是結果的一筆**——沒有「一個實體對應多列」的問題，
所以 `limit` 砍在正確的地方。**這是投影配分頁的天然優勢**，
而它的前提是 **`select` 裡沒有 to-many 的 join**（5.8.8 的做法 ① 就有）。

### 5.8.10 實測：收掉 00 章 0.7 的第三個結論 ★★

00 章 0.7 量到一個沒有解釋完的差距：

```
② JPA + JOIN FETCH        1 句 SQL，9～10 ms
④ MyBatis 巢狀 resultMap   1 句 SQL， 3 ms
```

那裡的說法是「這是有狀態的價格，按實體數量計價」。**現在可以驗證它了**：
把 ② 的**實體**換成**投影**，其他都不動——同一句 JOIN、同一份資料。

```java
    /** 5.8.10：回到 00 章 0.7 結論三 —— 同一句 JOIN，實體版 vs DTO 版。 */
    @Test
    void 收掉零點七的第三個結論() {
        head("5.8.10 同一句 JOIN、同一份資料（200 張訂單 + 400 筆明細）");

        Runnable entityWay = () -> {
            List<Ord5> os = em.createQuery("""
                    select o from Ord5 o
                      join fetch o.customer
                      left join fetch o.items
                    """, Ord5.class).getResultList();
            // 跟 00 章 0.7 的 ② 一樣：真的去讀那些值
            os.forEach(o -> { o.getCustomer().getDisplayName(); o.getItems().size(); });
        };

        Runnable dtoWay = () -> {
            List<Object[]> flat = em.createQuery("""
                    select o.id, o.orderNo, c.displayName, o.totalAmount,
                           i.productName, i.qty, i.lineAmount
                      from Ord5 o join o.customer c left join o.items i
                    """, Object[].class).getResultList();
            Map<UUID, OrderDetailRow> m = new LinkedHashMap<>();
            for (Object[] x : flat) {
                OrderDetailRow row = m.computeIfAbsent((UUID) x[0], k -> new OrderDetailRow(
                        (UUID) x[0], (String) x[1], (String) x[2],
                        (java.math.BigDecimal) x[3], new ArrayList<>()));
                if (x[4] != null) row.lines().add(new OrderDetailRow.Line(
                        (String) x[4], (Integer) x[5], (java.math.BigDecimal) x[6]));
            }
        };

        int[] pcE = new int[1], pcD = new int[1];
        int[] sqlE = new int[1], sqlD = new int[1];
        tx.executeWithoutResult(s -> { em.clear(); sqlE[0] = spy(entityWay).size(); pcE[0] = managedEntities(); });
        tx.executeWithoutResult(s -> { em.clear(); sqlD[0] = spy(dtoWay).size();    pcD[0] = managedEntities(); });
        long msE = bestMs(() -> tx.executeWithoutResult(s -> { em.clear(); entityWay.run(); }), 3, 7);
        long msD = bestMs(() -> tx.executeWithoutResult(s -> { em.clear(); dtoWay.run(); }), 3, 7);

        System.out.printf("  %-34s %5s %8s %6s%n", "寫法", "SQL", "PC實體", "ms");
        System.out.printf("  %-34s %5d %8d %6d%n", "② JPA + JOIN FETCH（實體）", sqlE[0], pcE[0], msE);
        System.out.printf("  %-34s %5d %8d %6d%n", "⑥ JPA + DTO 投影（同一句 JOIN）", sqlD[0], pcD[0], msD);
        System.out.println("\n  （00 章 0.7 的對照：② 9～10 ms、④ MyBatis 巢狀 resultMap 3 ms）");
    }
```

```
═══ 5.8.10 同一句 JOIN、同一份資料（200 張訂單 + 400 筆明細） ═══
  寫法                                   SQL     PC實體     ms
  ② JPA + JOIN FETCH（實體）                 1      650     10
  ⑥ JPA + DTO 投影（同一句 JOIN）               1        0      2

  （00 章 0.7 的對照：② 9～10 ms、④ MyBatis 巢狀 resultMap 3 ms）
```

**② 量到 10 ms，跟 00 章 0.7 的 9～10 ms 對得上。**
**而同一個 JPA、同一句 JOIN，換成投影是 2 ms —— 比 MyBatis 那個 3 ms 還快一點。**

📌 **所以 00 章 0.7 結論三那個「JPA 比 MyBatis 慢 3 倍」，
真正的變數不是【框架】，是【實體 vs 列】**：

```
JPA 撈實體    650 個實體  10 ms   ← 慢的是這個
JPA 撈投影      0 個實體   2 ms
MyBatis        600 個 DTO  3 ms   ← 它從來就沒有「實體」這個概念
```

> 📌 **這是這一章最重要的一句話**：
>
> > **「JPA 比較慢」這個說法，在絕大多數情況下量到的其實是
> > 「我在一個唯讀查詢上建了一堆有狀態的物件」。**
> > **那不是框架的成本，是【你選錯回傳型別】的成本。**

⚠️ **而 00 章 0.8.4 那個「報表用 MyBatis」的決定，還是成立的**——
理由從來就不是「MyBatis 比較快」（判準三），
而是**判準一（查詢導向）與 0.6.3 的「形狀自由」**。
**09 章會拿這一格的數字回去重新檢查那個決定。**

### 5.8.11 🔴 投影的三個代價

**代價一：它不是實體，所以改不回去。**

```java
    @Test
    void 投影不進pc所以改不回去() {
        head("5.8.11 🔴 投影的代價：它不是實體");
        tx.executeWithoutResult(s -> {
            em.clear();
            OrderRow r = orders.rows(St5.PENDING).get(0);
            System.out.println("  拿到 " + r.orderNo() + "，金額 " + r.totalAmount());
            System.out.println("  PC 裡 " + managedEntities() + " 個實體 → 沒有東西可以改");
            System.out.println("  record 是不可變的，連 setter 都沒有。");
            System.out.println("  要改資料，還是得 em.find(Ord5.class, r.id())（多一句 SQL）");
        });
    }
```

```
═══ 5.8.11 🔴 投影的代價：它不是實體 ═══
  拿到 SO-2026-000199，金額 220.0000
  PC 裡 0 個實體 → 沒有東西可以改
  record 是不可變的，連 setter 都沒有。
  要改資料，還是得 em.find(Ord5.class, r.id())（多一句 SQL）
```

**這不是缺點，是這個選擇的定義。**
而它的意思是：**投影只適合唯讀路徑**。
一個「列出來、勾選、批次改狀態」的畫面，
列表用投影、改的時候用 id 再撈實體——**這是正確的做法，不是妥協。**

**代價二：DTO 會爆炸。**

```
列表頁要 5 個欄位          → OrderRow
明細頁要 12 個欄位 + 明細   → OrderDetailRow
匯出要 20 個欄位           → OrderExportRow
報表要 4 個聚合值          → CustomerSales
```

**每一個用例一個 DTO。** 這是真實的成本，而它是**有邊界的**成本——
DTO 是 plain record，不會互相影響，改一個不會弄壞別的。

⚠️ **而「共用一個大 DTO」是錯的解法**：那會讓你回到「撈了不需要的欄位」，
而且**沒有任何一個欄位可以安全地刪掉**（你不知道誰在用）。

**代價三：JPQL 字串裡那個完整類別名。**

```java
select new com.example.lab.ch05.OrderRow(…)
```

**改 package 或改類別名，這句話不會編譯錯誤。**
它會在**啟動時**炸（5.7.7），這比執行期好，**但還是比編譯期差。**
📌 **這是 5.10（QueryDSL）要解的問題之一。**

---

## 5.9 Criteria API

### 5.9.1 它為什麼存在：先看沒有它的樣子

**需求**：一個訂單搜尋 API，六個條件**每一個都可以不填**。

```java
package com.example.lab.ch05;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * 搜尋條件：六個欄位【每一個都可以是 null】（= 使用者沒填）。
 * 2^6 = 64 種組合 —— 這就是動態查詢的問題規模。
 */
public record OrderSearch(St5 status, String customerKeyword, Instant from, Instant to,
                          BigDecimal minAmount, Boolean hasRep) {

    public static OrderSearch empty() { return new OrderSearch(null, null, null, null, null, null); }

    public OrderSearch withStatus(St5 s) {
        return new OrderSearch(s, customerKeyword, from, to, minAmount, hasRep);
    }
    public OrderSearch withCustomerKeyword(String k) {
        return new OrderSearch(status, k, from, to, minAmount, hasRep);
    }
    public OrderSearch withMinAmount(BigDecimal a) {
        return new OrderSearch(status, customerKeyword, from, to, a, hasRep);
    }
    public OrderSearch withHasRep(Boolean b) {
        return new OrderSearch(status, customerKeyword, from, to, minAmount, b);
    }
    public OrderSearch withRange(Instant f, Instant t) {
        return new OrderSearch(status, customerKeyword, f, t, minAmount, hasRep);
    }
}
```

**5.7.1 已經說了衍生查詢做不到（要 64 個方法）。那就拼字串吧**：

```java
package com.example.lab.ch05;

import jakarta.persistence.criteria.CriteriaBuilder;
import jakarta.persistence.criteria.CriteriaQuery;
import jakarta.persistence.criteria.JoinType;
import jakarta.persistence.criteria.Predicate;
import jakarta.persistence.criteria.Root;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** 5.9：Criteria API。 */
class F8Criteria extends Base05 {

    @Autowired Ord5Repo orders;

    @BeforeEach void setUp() { seed(30, 5, 2, 0); }

    // ── 5.9.1 對照組：字串拼 JPQL ────────────────────────────────────
    private List<Ord5> byStringConcat(OrderSearch s) {
        StringBuilder jpql = new StringBuilder("select o from Ord5 o where 1 = 1");
        Map<String, Object> params = new LinkedHashMap<>();
        if (s.status() != null)          { jpql.append(" and o.status = :st");   params.put("st", s.status()); }
        if (s.customerKeyword() != null) { jpql.append(" and o.customer.displayName like :kw");
                                           params.put("kw", "%" + s.customerKeyword() + "%"); }
        if (s.minAmount() != null)       { jpql.append(" and o.totalAmount >= :amt"); params.put("amt", s.minAmount()); }
        if (s.hasRep() != null)          { jpql.append(s.hasRep() ? " and o.rep is not null"
                                                                  : " and o.rep is null"); }
        var q = em.createQuery(jpql.toString(), Ord5.class);
        params.forEach(q::setParameter);
        return q.getResultList();
    }

    @Test @Transactional
    void 字串拼接的動態查詢() {
        head("5.9.1 對照組：字串拼 JPQL");
        System.out.println("  空條件         → " + byStringConcat(OrderSearch.empty()).size() + " 張");
        System.out.println("  只有狀態       → "
            + byStringConcat(OrderSearch.empty().withStatus(St5.PENDING)).size());
        System.out.println("  狀態 + 關鍵字   → "
            + byStringConcat(OrderSearch.empty().withStatus(St5.PENDING)
                             .withCustomerKeyword("客戶1")).size());
        System.out.println("  沒有業務員     → "
            + byStringConcat(OrderSearch.empty().withHasRep(false)).size());

        showSql("空條件產生的 SQL", () -> byStringConcat(OrderSearch.empty()));
    }
}
```

```
═══ 5.9.1 對照組：字串拼 JPQL ═══
  空條件         → 30 張
  只有狀態       → 23
  狀態 + 關鍵字   → 5
  沒有業務員     → 10
── 空條件產生的 SQL → 1 句 SQL
   select o1_0.id,…,o1_0.total_amount from orders o1_0 where 1=1
```

**它會動。而它有五個問題**：

```
① where 1 = 1 —— 一個【為了字串拼接方便】而存在的條件。
② 少一個空白（" and o.status" 寫成 "and o.status"）就是執行期錯誤，
   而且要【湊齊那個組合】才會發生 —— 64 種組合，你的測試蓋得到幾種？
③ o.customer.displayName 是隱式 join（5.3.3）。這裡剛好安全（customer 不可為 null），
   而換成 o.rep.name 就會靜默吃掉資料，【而且沒有任何東西會提醒你】。
④ 改一個屬性名（rename），這段字串不會編譯錯誤。
⑤ 而如果有人把 s.customerKeyword() 直接 append 進去（不是用參數）→ 5.5.2 的注入。
```

> 📌 **Criteria API 存在的理由，是把上面那五個問題裡的四個，
> 從【執行期】搬到【編譯期】。**

### 5.9.2 實測：一句 Criteria 逐行解剖

```java
    @Test @Transactional
    void 第一個criteria查詢() {
        head("5.9.2 一句 Criteria 逐行解剖");
        CriteriaBuilder cb = em.getCriteriaBuilder();              // ① 工廠
        CriteriaQuery<Ord5> q = cb.createQuery(Ord5.class);        // ② 一句查詢，回傳 Ord5
        Root<Ord5> o = q.from(Ord5.class);                         // ③ from Ord5 o
        q.select(o)                                                // ④ select o
         .where(cb.equal(o.get("status"), St5.PENDING))            // ⑤ where o.status = ?
         .orderBy(cb.desc(o.get("placedAt")));                     // ⑥ order by o.placedAt desc

        showSql("Criteria 產生的 SQL", () -> em.createQuery(q).getResultList());
        System.out.println("  結果 " + em.createQuery(q).getResultList().size() + " 張");
    }
```

```
═══ 5.9.2 一句 Criteria 逐行解剖 ═══
── Criteria 產生的 SQL → 1 句 SQL
   select o1_0.id,…,o1_0.total_amount from orders o1_0 where o1_0.status=? order by o1_0.placed_at desc
  結果 23 張
```

**六行對應到 JPQL 的六個部分。逐項對照**：

| Criteria | JPQL |
|---|---|
| `cb.createQuery(Ord5.class)` | 回傳型別 |
| `q.from(Ord5.class)` → `Root<Ord5>` | `from Ord5 o` |
| `q.select(o)` | `select o` |
| `cb.equal(o.get("status"), …)` | `where o.status = :st` |
| `o.join("customer")` | `join o.customer c` |
| `cb.desc(o.get("placedAt"))` | `order by o.placedAt desc` |

⚠️ **注意這裡的參數**：`cb.equal(o.get("status"), St5.PENDING)` 那個值
會**自動變成一個 SQL 參數**（SQL 裡是 `?`）——
**Criteria 不可能寫出 5.5.2 那種注入**，因為它根本沒有「拼字串」這個動作。

### 5.9.3 實測：metamodel 讓它有型別安全

上一格的 `o.get("status")` 還是一個**字串**。這是 Criteria 的一半。
另一半是 **metamodel** —— 一組由 annotation processor 產生的類別：

```java
// 產生出來的（target/generated-sources/annotations/…/Ord5_.java）
@StaticMetamodel(Ord5.class)
public abstract class Ord5_ extends Base5_ {
    public static volatile SingularAttribute<Ord5, St5> status;
    public static volatile SingularAttribute<Ord5, Cust5> customer;
    public static volatile SingularAttribute<Ord5, BigDecimal> totalAmount;
    public static volatile ListAttribute<Ord5, Item5> items;
    // …
}
```

```xml
<!-- pom.xml -->
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-compiler-plugin</artifactId>
  <configuration>
    <annotationProcessorPaths>
      <path>
        <groupId>org.hibernate.orm</groupId>
        <artifactId>hibernate-jpamodelgen</artifactId>
        <version>6.4.4.Final</version>
      </path>
    </annotationProcessorPaths>
  </configuration>
</plugin>
```

```java
    @Test @Transactional
    void metamodel讓它有型別安全() {
        head("5.9.3 metamodel：字串 vs 產生出來的 Ord5_");
        CriteriaBuilder cb = em.getCriteriaBuilder();

        // ① 字串版：打錯字要到執行期才知道
        try {
            CriteriaQuery<Ord5> q = cb.createQuery(Ord5.class);
            Root<Ord5> o = q.from(Ord5.class);
            q.select(o).where(cb.equal(o.get("statuss"), St5.PENDING));
            em.createQuery(q).getResultList();
        } catch (Exception e) {
            System.out.println("  字串版 o.get(\"statuss\") → " + e.getClass().getSimpleName()
                + ": " + cut(String.valueOf(e.getMessage()).replaceAll("\\s+", " ")));
        }

        // ② metamodel 版：o.get(Ord5_.status) —— 打錯字【編譯不過】
        CriteriaQuery<Ord5> q2 = cb.createQuery(Ord5.class);
        Root<Ord5> o2 = q2.from(Ord5.class);
        q2.select(o2).where(cb.equal(o2.get(Ord5_.status), St5.PENDING));
        System.out.println("  metamodel 版 o.get(Ord5_.status) → "
            + em.createQuery(q2).getResultList().size() + " 張（而且回傳型別是 St5，不是 Object）");
    }
```

```
═══ 5.9.3 metamodel：字串 vs 產生出來的 Ord5_ ═══
  字串版 o.get("statuss") → PathElementException:
     Could not resolve attribute 'statuss' of 'com.example.lab.ch05.Ord5'
  metamodel 版 o.get(Ord5_.status) → 23 張（而且回傳型別是 St5，不是 Object）
```

**兩件事同時發生**：

```
① 打錯字 → 編譯不過（不是執行期例外）
② o.get(Ord5_.status) 的靜態型別是 Path<St5>，不是 Path<Object>
       ↓
   cb.equal(o.get(Ord5_.status), "PENDING")  ← 傳字串進去，編譯就會擋
   cb.greaterThan(o.get(Ord5_.orderNo), 100) ← 拿字串跟數字比，編譯就會擋
```

⚠️ **沒有 metamodel 的 Criteria，只換到了「不會有注入」與「可以組合」，
沒有換到型別安全。** 而 metamodel 是免費的（一個 annotation processor）。
**要用 Criteria 就一定要開它。**

### 5.9.4 實測：動態條件

```java
    private List<Ord5> byCriteria(OrderSearch s) {
        CriteriaBuilder cb = em.getCriteriaBuilder();
        CriteriaQuery<Ord5> q = cb.createQuery(Ord5.class);
        Root<Ord5> o = q.from(Ord5.class);

        List<Predicate> ps = new ArrayList<>();
        if (s.status() != null) ps.add(cb.equal(o.get(Ord5_.status), s.status()));
        if (s.customerKeyword() != null) {
            ps.add(cb.like(o.join(Ord5_.customer).get(Cust5_.displayName),
                           "%" + s.customerKeyword() + "%"));
        }
        if (s.from() != null && s.to() != null) ps.add(cb.between(o.get(Ord5_.placedAt), s.from(), s.to()));
        if (s.minAmount() != null) ps.add(cb.greaterThanOrEqualTo(o.get(Ord5_.totalAmount), s.minAmount()));
        if (s.hasRep() != null) {
            var rep = o.join(Ord5_.rep, JoinType.LEFT);          // ★ 明確的 left join
            ps.add(s.hasRep() ? cb.isNotNull(rep.get(Rep5_.id)) : cb.isNull(rep.get(Rep5_.id)));
        }
        q.select(o).where(cb.and(ps.toArray(Predicate[]::new)))   // ★ 空陣列 = 沒有條件
         .orderBy(cb.desc(o.get(Ord5_.placedAt)));
        return em.createQuery(q).getResultList();
    }

    @Test @Transactional
    void criteria的動態條件() {
        head("5.9.4 Criteria 的動態條件");
        System.out.println("  空條件       → " + byCriteria(OrderSearch.empty()).size() + " 張");
        System.out.println("  只有狀態     → "
            + byCriteria(OrderSearch.empty().withStatus(St5.PENDING)).size());
        System.out.println("  沒有業務員   → " + byCriteria(OrderSearch.empty().withHasRep(false)).size());
        System.out.println("  五個條件全上 → " + byCriteria(new OrderSearch(
            St5.PENDING, "客戶", Instant.parse("2026-09-01T00:00:00Z"),
            Instant.parse("2026-09-02T00:00:00Z"), new BigDecimal("200"), true)).size());

        showSql("空條件的 SQL（★ 一樣有 where 1=1）", () -> byCriteria(OrderSearch.empty()));
        showSql("沒有業務員的 SQL（★ left join）", () ->
            byCriteria(OrderSearch.empty().withHasRep(false)));
    }
```

```
═══ 5.9.4 Criteria 的動態條件 ═══
  空條件       → 30 張
  只有狀態     → 23
  沒有業務員   → 10
  五個條件全上 → 16
── 空條件的 SQL（★ 一樣有 where 1=1） → 1 句 SQL
   select … from orders o1_0 where 1=1 order by o1_0.placed_at desc
── 沒有業務員的 SQL（★ left join） → 1 句 SQL
   select … from orders o1_0 left join sales_rep r1_0 on r1_0.id=o1_0.rep_id
    where r1_0.id is null order by o1_0.placed_at desc
```

**兩個觀察，第一個可能跟你預期的相反**：

**① ★ Criteria 一樣產生了 `where 1=1`。**
`cb.and(空陣列)` 就是一個「永遠成立的合取」，Hibernate 把它翻成 `1=1`。

> 📌 **所以 Criteria 的價值【不在】它產生比較漂亮的 SQL。**
> 5.9.1 的字串版跟這一版產生的 SQL 幾乎一樣。
> **差別全部在 Java 這一側**：型別安全、不可能注入、條件可以當成物件傳遞。

**② 而 `hasRep` 那個條件用了明確的 `JoinType.LEFT`。**
字串版寫的是 `o.rep is null`（也對，因為它問的是外鍵本身）；
**而只要你寫成 `o.rep.name is null`，字串版就會靜默錯掉，Criteria 版則是你必須先決定 join 型別。**

### 5.9.5 實測：Criteria 也可以投影

```java
    @Test @Transactional
    void criteria的投影() {
        head("5.9.5 Criteria 也可以投影");
        CriteriaBuilder cb = em.getCriteriaBuilder();
        CriteriaQuery<OrderRow> q = cb.createQuery(OrderRow.class);
        Root<Ord5> o = q.from(Ord5.class);
        var c = o.join(Ord5_.customer);

        var sub = q.subquery(Long.class);
        var i = sub.from(Item5.class);
        sub.select(cb.count(i)).where(cb.equal(i.get(Item5_.order), o));

        q.select(cb.construct(OrderRow.class,                       // ★ 對應 select new
                o.get(Ord5_.id), o.get(Ord5_.orderNo), c.get(Cust5_.displayName),
                o.get(Ord5_.status), o.get(Ord5_.totalAmount), o.get(Ord5_.placedAt),
                sub.getSelection()))
         .where(cb.equal(o.get(Ord5_.status), St5.PENDING));

        List<OrderRow> rows = em.createQuery(q).getResultList();
        System.out.println("  " + rows.size() + " 筆，第一筆：" + rows.get(0));
        System.out.println("  PC 裡 " + managedEntities() + " 個實體");
        showSql("SQL", () -> em.createQuery(q).getResultList());
    }
```

```
═══ 5.9.5 Criteria 也可以投影 ═══
  23 筆，第一筆：OrderRow[id=…, orderNo=SO-2026-000013, customerName=客戶2,
                        status=PENDING, totalAmount=250.0000, placedAt=…, itemCount=2]
  PC 裡 0 個實體
── SQL → 1 句 SQL
   select o1_0.id,o1_0.order_no,c1_0.display_name,o1_0.status,o1_0.total_amount,o1_0.placed_at,
          (select count(i1_0.id) from order_item i1_0 where i1_0.order_id=o1_0.id) from …
```

**`cb.construct(...)` 就是 `select new`**——產生的 SQL 跟 5.8.2 一字不差，PC 裡 0 個實體。

📌 **也就是說「動態條件」與「投影」是兩個獨立的選擇，可以任意組合。**
一個「條件動態、回傳 DTO」的搜尋 API，這兩件事都做得到。

### 5.9.6 實測：`Specification`（實務上真正會用的）

**直接寫 Criteria 有一個很煩的地方**：每一個條件都需要 `cb`、`q`、`root` 三個東西，
所以條件**沒辦法抽成獨立的方法**（除非把三個參數都傳進去）。

**Spring Data 的 `Specification` 就是那個包裝**：

```java
@FunctionalInterface
public interface Specification<T> {
    Predicate toPredicate(Root<T> root, CriteriaQuery<?> query, CriteriaBuilder cb);
}
```

**於是每一個條件變成一個可以獨立命名、獨立測試、獨立組合的東西**：

```java
package com.example.lab.ch05;

import jakarta.persistence.criteria.JoinType;
import org.springframework.data.jpa.domain.Specification;

import java.util.ArrayList;
import java.util.List;

/** 5.9.6：把每一個條件寫成一個 Specification，再組起來。 */
public final class OrderSpecs {

    private OrderSpecs() {}

    public static Specification<Ord5> statusIs(St5 s) {
        return (root, q, cb) -> cb.equal(root.get(Ord5_.status), s);
    }

    /** ★ 使用者輸入要跳脫 like 的萬用字元（5.4.2） */
    public static Specification<Ord5> customerLike(String kw) {
        String pattern = "%" + kw.replace("!", "!!").replace("%", "!%").replace("_", "!_") + "%";
        return (root, q, cb) -> cb.like(
                root.join(Ord5_.customer).get(Cust5_.displayName), pattern, '!');
    }

    public static Specification<Ord5> placedBetween(java.time.Instant from, java.time.Instant to) {
        return (root, q, cb) -> cb.between(root.get(Ord5_.placedAt), from, to);
    }

    public static Specification<Ord5> amountAtLeast(java.math.BigDecimal a) {
        return (root, q, cb) -> cb.greaterThanOrEqualTo(root.get(Ord5_.totalAmount), a);
    }

    /** ★ 這一條要 left join（5.3.3）：問的是「有沒有業務員」 */
    public static Specification<Ord5> hasRep(boolean yes) {
        return (root, q, cb) -> {
            var rep = root.join(Ord5_.rep, JoinType.LEFT);
            return yes ? cb.isNotNull(rep.get(Rep5_.id)) : cb.isNull(rep.get(Rep5_.id));
        };
    }

    /** 把「使用者填了什麼」翻譯成一組條件。沒填的就不加。 */
    public static Specification<Ord5> of(OrderSearch s) {
        List<Specification<Ord5>> parts = new ArrayList<>();
        if (s.status() != null)          parts.add(statusIs(s.status()));
        if (s.customerKeyword() != null) parts.add(customerLike(s.customerKeyword()));
        if (s.from() != null && s.to() != null) parts.add(placedBetween(s.from(), s.to()));
        if (s.minAmount() != null)       parts.add(amountAtLeast(s.minAmount()));
        if (s.hasRep() != null)          parts.add(hasRep(s.hasRep()));

        Specification<Ord5> out = null;
        for (Specification<Ord5> p : parts) out = (out == null) ? p : out.and(p);
        return out;                       // null = 沒有任何條件，Spring Data 收得下
    }
}
```

repository 只要多繼承一個介面：

```java
public interface Ord5Repo extends JpaRepository<Ord5, UUID>, JpaSpecificationExecutor<Ord5> { … }
```

```java
    @Test @Transactional
    void specification() {
        head("5.9.6 Spring Data 的 Specification");
        System.out.println("  空條件（of() 回 null）→ "
            + orders.findAll(OrderSpecs.of(OrderSearch.empty())).size());
        showSql("  空條件的 SQL（★ Specification 是 null 時連 where 都沒有）", () ->
            orders.findAll(OrderSpecs.of(OrderSearch.empty())));
        System.out.println("  只有狀態     → "
            + orders.findAll(OrderSpecs.of(OrderSearch.empty().withStatus(St5.PENDING))).size());
        System.out.println("  沒有業務員   → "
            + orders.findAll(OrderSpecs.of(OrderSearch.empty().withHasRep(false))).size());

        Specification<Ord5> spec = OrderSpecs.statusIs(St5.PENDING)
                .and(OrderSpecs.amountAtLeast(new BigDecimal("230")))
                .or(OrderSpecs.statusIs(St5.CANCELLED));
        System.out.println("  (PENDING and >=230) or CANCELLED → " + orders.findAll(spec).size());

        System.out.println("\n  ★ Specification 免費附贈分頁與計數：");
        var page = orders.findAll(OrderSpecs.of(OrderSearch.empty().withStatus(St5.PENDING)),
                org.springframework.data.domain.PageRequest.of(0, 5));
        System.out.println("    這一頁 " + page.getContent().size() + " 筆、共 "
            + page.getTotalElements() + " 筆");
        System.out.println("    count(spec) = "
            + orders.count(OrderSpecs.of(OrderSearch.empty().withStatus(St5.PENDING))));

        showSql("使用者輸入含 % 的關鍵字（★ 有跳脫）", () ->
            orders.findAll(OrderSpecs.of(OrderSearch.empty().withCustomerKeyword("100%"))));
    }
```

```
═══ 5.9.6 Spring Data 的 Specification ═══
  空條件（of() 回 null）→ 30
──   空條件的 SQL（★ Specification 是 null 時連 where 都沒有） → 1 句 SQL
   select o1_0.id,…,o1_0.total_amount from orders o1_0
  只有狀態     → 23
  沒有業務員   → 10
  (PENDING and >=230) or CANCELLED → 19

  ★ Specification 免費附贈分頁與計數：
    這一頁 5 筆、共 23 筆
    count(spec) = 23
```

**四個觀察**：

**① 空條件時 `of()` 回 `null`，而 Spring Data 收得下**——
產生的 SQL **連 `where` 都沒有**（比 5.9.4 的 `where 1=1` 乾淨）。

**② 條件可以用 `and` / `or` / `not` 組合。**
而它們是**普通的 Java 物件**：可以放進 `Map`、可以當參數傳、
**可以單獨為 `hasRep(false)` 寫一個測試。**

**③ 免費得到分頁與計數。**
`JpaSpecificationExecutor` 有 `findAll(spec, Pageable)`、`count(spec)`、`exists(spec)`。
⚠️ 而 5.7.4 那個 count 陷阱**還在**：Specification 裡如果 join 了集合，
`count(spec)` 一樣會放大。（`Specification` 的 `toPredicate` 拿得到 `query`，
可以用 `query.getResultType() == Long.class` 判斷「現在是不是在生 count」，
在 count 時跳過那個 join。這是一個常見的技巧，也是一個訊號：**你的條件太複雜了**。）

**④ `customerLike` 裡那三行 `replace` 是 5.4.2 的跳脫。**
**使用者輸入 `100%` 時，`%` 必須被跳脫**，否則搜尋結果會多出一堆不相干的東西。
📌 **把它寫在 `OrderSpecs` 裡，代表「每一個用到這個條件的地方都跳脫了」**——
這正是「條件可以抽成方法」帶來的好處。

### 5.9.7 🔴 Criteria 的三個代價

**代價一：可讀性。**

```java
// JPQL
select o from Ord5 o join o.customer c
 where o.status = :st and c.tier = :tier and o.totalAmount >= :amt
 order by o.placedAt desc

// Criteria
CriteriaBuilder cb = em.getCriteriaBuilder();
CriteriaQuery<Ord5> q = cb.createQuery(Ord5.class);
Root<Ord5> o = q.from(Ord5.class);
var c = o.join(Ord5_.customer);
q.select(o).where(cb.and(
        cb.equal(o.get(Ord5_.status), St5.PENDING),
        cb.equal(c.get(Cust5_.tier), Tier5.GOLD),
        cb.greaterThanOrEqualTo(o.get(Ord5_.totalAmount), new BigDecimal("220"))))
 .orderBy(cb.desc(o.get(Ord5_.placedAt)));
```

**三行 vs 九行，而且第二個要讀兩遍才知道它在查什麼。**
📌 **這是 QueryDSL 存在的唯一理由**（5.10）。

**代價二：`group by` / 子查詢 / `case` 寫起來非常痛苦。**
5.9.5 那個子查詢用了 5 行；JPQL 是括號裡一句話。

**代價三：除錯的時候你看不到查詢。**
JPQL 的字串可以直接印出來、貼進工具裡跑。
**Criteria 只有一堆物件**——你只能看它產生的 SQL（`SqlSpy`），
**而 SQL 跟你寫的東西之間隔了一層。**

> 📌 **判準**：
>
> ```
> 條件是【固定】的      → JPQL（@Query）。不要用 Criteria。
> 條件是【動態】的      → Specification（不要裸寫 Criteria）
> 動態、而且很多、常改   → QueryDSL（5.10）
> ```

---

## 5.10 QueryDSL

### 5.10.1 實測：同一個查詢，三種寫法

```java
package com.example.lab.ch05;

import com.querydsl.core.BooleanBuilder;
import com.querydsl.core.types.Projections;
import com.querydsl.core.types.dsl.BooleanExpression;
import com.querydsl.jpa.impl.JPAQueryFactory;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;

/** 5.10：QueryDSL。 */
class F9QueryDsl extends Base05 {

    @Autowired Ord5Repo orders;
    @Autowired JPAQueryFactory query;

    private static final QOrd5 O = QOrd5.ord5;
    private static final QCust5 C = QCust5.cust5;
    private static final QItem5 I = QItem5.item5;

    @BeforeEach void setUp() { seed(30, 5, 2, 0); }

    @Test @Transactional
    void 同一個查詢三種寫法() {
        head("5.10.1 同一個查詢，三種寫法");

        List<Ord5> a = em.createQuery("""
                select o from Ord5 o join o.customer c
                 where o.status = :st and c.tier = :tier and o.totalAmount >= :amt
                 order by o.placedAt desc
                """, Ord5.class)
                .setParameter("st", St5.PENDING).setParameter("tier", Tier5.GOLD)
                .setParameter("amt", new BigDecimal("220")).getResultList();

        var cb = em.getCriteriaBuilder();
        var q = cb.createQuery(Ord5.class);
        var o = q.from(Ord5.class);
        var c = o.join(Ord5_.customer);
        q.select(o).where(cb.and(
                cb.equal(o.get(Ord5_.status), St5.PENDING),
                cb.equal(c.get(Cust5_.tier), Tier5.GOLD),
                cb.greaterThanOrEqualTo(o.get(Ord5_.totalAmount), new BigDecimal("220"))))
         .orderBy(cb.desc(o.get(Ord5_.placedAt)));
        List<Ord5> b = em.createQuery(q).getResultList();

        List<Ord5> d = query.selectFrom(O).join(O.customer, C)
                .where(O.status.eq(St5.PENDING),
                       C.tier.eq(Tier5.GOLD),
                       O.totalAmount.goe(new BigDecimal("220")))
                .orderBy(O.placedAt.desc())
                .fetch();

        System.out.println("  JPQL     → " + a.size() + " 張");
        System.out.println("  Criteria → " + b.size() + " 張");
        System.out.println("  QueryDSL → " + d.size() + " 張");
        showSql("QueryDSL 產生的 SQL", () -> query.selectFrom(O).join(O.customer, C)
                .where(O.status.eq(St5.PENDING), C.tier.eq(Tier5.GOLD),
                       O.totalAmount.goe(new BigDecimal("220")))
                .orderBy(O.placedAt.desc()).fetch());
    }
}
```

```
═══ 5.10.1 同一個查詢，三種寫法 ═══
  JPQL     → 3 張
  Criteria → 3 張
  QueryDSL → 3 張
── QueryDSL 產生的 SQL → 1 句 SQL
   select o1_0.id,…,o1_0.total_amount from orders o1_0
     join customer c1_0 on c1_0.id=o1_0.customer_id
    where o1_0.status=? and c1_0.tier=? and o1_0.total_amount>=? order by o1_0.placed_at desc
```

**三個一樣的結果、一樣的 SQL。差別在寫起來長什麼樣**：

```java
// QueryDSL
query.selectFrom(O).join(O.customer, C)
     .where(O.status.eq(St5.PENDING),
            C.tier.eq(Tier5.GOLD),
            O.totalAmount.goe(new BigDecimal("220")))
     .orderBy(O.placedAt.desc())
     .fetch();
```

> 📌 **QueryDSL = Criteria 的型別安全 + JPQL 的可讀性。**
> **它的每一個方法名都對應到 JPQL 的一個關鍵字。**

### 5.10.2 實測：那些 `O.status.eq(...)` 是什麼

```java
    @Test @Transactional
    void querydsl會做的事情() {
        head("5.10.2 QueryDSL 的表達式長什麼樣");
        System.out.println("  O.status.eq(PENDING)            → " + O.status.eq(St5.PENDING));
        System.out.println("  O.totalAmount.goe(220)          → " + O.totalAmount.goe(new BigDecimal("220")));
        System.out.println("  O.customer.displayName.contains → " + O.customer.displayName.contains("客戶"));
        System.out.println("  O.rep.isNull()                  → " + O.rep.isNull());
        System.out.println("  組合                             → "
            + O.status.eq(St5.PENDING).and(O.totalAmount.goe(new BigDecimal("220"))));
    }
```

```
═══ 5.10.2 QueryDSL 的表達式長什麼樣 ═══
  O.status.eq(PENDING)            → ord5.status = PENDING
  O.totalAmount.goe(220)          → ord5.totalAmount >= 220
  O.customer.displayName.contains → contains(ord5.customer.displayName,客戶)
  O.rep.isNull()                  → ord5.rep is null
  組合                             → ord5.status = PENDING && ord5.totalAmount >= 220
```

**每一個條件都是一個 `BooleanExpression` 物件。**
它可以存進變數、當參數傳、放進 `List`、**單獨寫測試**——
跟 `Specification` 一樣，**而不需要 `cb` / `root` / `query` 這三個東西。**

**`QOrd5` 是 QueryDSL 的 annotation processor 產生的**（跟 metamodel 同一個機制）：

```xml
<dependency>
  <groupId>com.querydsl</groupId>
  <artifactId>querydsl-jpa</artifactId>
  <version>5.0.0</version>
  <classifier>jakarta</classifier>          <!-- ★ Jakarta EE 一定要這個 classifier -->
</dependency>
```

```xml
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-compiler-plugin</artifactId>
  <configuration>
    <annotationProcessorPaths>
      <path><groupId>org.hibernate.orm</groupId>
            <artifactId>hibernate-jpamodelgen</artifactId><version>6.4.4.Final</version></path>
      <path><groupId>com.querydsl</groupId><artifactId>querydsl-apt</artifactId>
            <version>5.0.0</version><classifier>jakarta</classifier></path>
      <path><groupId>jakarta.persistence</groupId>
            <artifactId>jakarta.persistence-api</artifactId><version>3.1.0</version></path>
    </annotationProcessorPaths>
    <annotationProcessors>
      <proc>org.hibernate.jpamodelgen.JPAMetaModelEntityProcessor</proc>
      <proc>com.querydsl.apt.jpa.JPAAnnotationProcessor</proc>
    </annotationProcessors>
  </configuration>
</plugin>
```

還要一個 `JPAQueryFactory` 的 bean：

```java
package com.example.lab.ch05;

import com.querydsl.jpa.impl.JPAQueryFactory;
import jakarta.persistence.EntityManager;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class QueryDslConfig {
    @Bean
    public JPAQueryFactory jpaQueryFactory(EntityManager em) {
        return new JPAQueryFactory(em);
    }
}
```

⚠️ **這個組態有一個地雷，5.10.6 會講。**

### 5.10.3 實測：動態條件 —— `null` 就是「沒有這個條件」

**這是 QueryDSL 最好用的一個設計**：

```java
    // ── 5.10.3 動態條件：一個條件一個方法，沒填就回 null ──────────────
    private BooleanExpression statusIs(St5 s)        { return s == null ? null : O.status.eq(s); }
    private BooleanExpression customerLike(String k) {
        return k == null ? null : O.customer.displayName.contains(k);
    }
    private BooleanExpression amountAtLeast(BigDecimal a) {
        return a == null ? null : O.totalAmount.goe(a);
    }
    private BooleanExpression placedBetween(Instant f, Instant t) {
        return (f == null || t == null) ? null : O.placedAt.between(f, t);
    }
    private BooleanExpression hasRep(Boolean b) {
        return b == null ? null : (b ? O.rep.isNotNull() : O.rep.isNull());
    }

    private List<Ord5> byQueryDsl(OrderSearch s) {
        return query.selectFrom(O)
                .where(statusIs(s.status()),                 // ★ null 會被【忽略】
                       customerLike(s.customerKeyword()),
                       amountAtLeast(s.minAmount()),
                       placedBetween(s.from(), s.to()),
                       hasRep(s.hasRep()))
                .orderBy(O.placedAt.desc())
                .fetch();
    }

    @Test @Transactional
    void querydsl的動態條件() {
        head("5.10.3 QueryDSL 的動態條件：null = 沒有這個條件");
        System.out.println("  空條件       → " + byQueryDsl(OrderSearch.empty()).size() + " 張");
        System.out.println("  只有狀態     → "
            + byQueryDsl(OrderSearch.empty().withStatus(St5.PENDING)).size());
        System.out.println("  沒有業務員   → " + byQueryDsl(OrderSearch.empty().withHasRep(false)).size());
        System.out.println("  五個條件全上 → " + byQueryDsl(new OrderSearch(
            St5.PENDING, "客戶", Instant.parse("2026-09-01T00:00:00Z"),
            Instant.parse("2026-09-02T00:00:00Z"), new BigDecimal("200"), true)).size());

        showSql("空條件的 SQL", () -> byQueryDsl(OrderSearch.empty()));
        showSql("沒有業務員的 SQL", () -> byQueryDsl(OrderSearch.empty().withHasRep(false)));

        System.out.println("\n  BooleanBuilder（要 or 的時候）：");
        BooleanBuilder bb = new BooleanBuilder();
        bb.or(O.status.eq(St5.CANCELLED));
        bb.or(O.totalAmount.goe(new BigDecimal("250")));
        System.out.println("    CANCELLED or >=250 → " + query.selectFrom(O).where(bb).fetch().size());
    }
```

```
═══ 5.10.3 QueryDSL 的動態條件：null = 沒有這個條件 ═══
  空條件       → 30 張
  只有狀態     → 23
  沒有業務員   → 10
  五個條件全上 → 16
── 空條件的 SQL → 1 句 SQL
   select o1_0.id,…,o1_0.total_amount from orders o1_0 order by o1_0.placed_at desc
── 沒有業務員的 SQL → 1 句 SQL
   select o1_0.id,…,o1_0.total_amount from orders o1_0 where o1_0.rep_id is null order by …
```

**三個觀察**：

**① `where(a, b, c)` 的多參數版本會把 `null` 直接【忽略】。**
於是「有沒有這個條件」變成一個 `?:` 運算式，
**整個 `if` 區塊消失了**——比 5.9.4 的 `List<Predicate>` 乾淨很多。

**② 空條件的 SQL 【完全沒有 where】。** 比 Criteria 的 `where 1=1` 好。

**③ ★ `O.rep.isNull()` 產生的是 `where o1_0.rep_id is null` —— 沒有 join。**
比 5.9.6 那個 `left join sales_rep … where r1_0.id is null` 更有效率
（少一個 join，而語意一樣）。
📌 **這是 5.3.2 的第三點在 QueryDSL 上的應用**：**問外鍵本身，不要問關聯物件。**

**④ `BooleanBuilder` 是「要 `or`」時的工具。**
多參數的 `where(...)` 之間永遠是 `and`；`or` 要用 `BooleanBuilder` 或
`expr1.or(expr2)`（而後者遇到 `null` 會 NPE，所以動態的 `or` 用 `BooleanBuilder`）。

### 5.10.4 實測：QueryDSL 的投影

```java
    @Test @Transactional
    void querydsl的投影() {
        head("5.10.4 QueryDSL 的投影");
        List<OrderRow> rows = query
                .select(Projections.constructor(OrderRow.class,
                        O.id, O.orderNo, C.displayName, O.status, O.totalAmount, O.placedAt,
                        com.querydsl.jpa.JPAExpressions.select(I.count()).from(I).where(I.order.eq(O))))
                .from(O).join(O.customer, C)
                .where(O.status.eq(St5.PENDING))
                .fetch();
        System.out.println("  " + rows.size() + " 筆，第一筆：" + rows.get(0));
        System.out.println("  PC 裡 " + managedEntities() + " 個實體");

        System.out.println("\n  聚合報表：");
        query.select(Projections.constructor(CustomerSales.class,
                     C.displayName, C.tier, O.count(), O.totalAmount.sum()))
             .from(O).join(O.customer, C)
             .groupBy(C.displayName, C.tier)
             .orderBy(O.totalAmount.sum().desc())
             .fetch().stream().limit(3)
             .forEach(x -> System.out.println("    " + x));
    }
```

```
═══ 5.10.4 QueryDSL 的投影 ═══
  23 筆，第一筆：OrderRow[id=…, orderNo=SO-2026-000002, customerName=客戶1,
                        status=PENDING, totalAmount=210.0000, placedAt=…, itemCount=2]
  PC 裡 0 個實體

  聚合報表：
    CustomerSales[customerName=客戶0, tier=NORMAL, orderCount=6, total=1390.0000]
    CustomerSales[customerName=客戶1, tier=SILVER, orderCount=6, total=1380.0000]
    CustomerSales[customerName=客戶2, tier=GOLD, orderCount=6, total=1370.0000]
```

**`Projections` 有三種**：

| | 怎麼填值 | DTO 要有什麼 |
|---|---|---|
| `Projections.constructor(X.class, …)` | 呼叫建構子 | 一個對得上的建構子（**record 可以**） |
| `Projections.bean(X.class, …)` | 呼叫 setter | 無參建構子 + setter |
| `Projections.fields(X.class, …)` | 直接寫欄位（反射） | 什麼都不用 |

✅ **用 `constructor` + `record`。** 另外兩個會讓 DTO 變成可變的。

📌 **注意 `select new com.example.lab.ch05.OrderRow(...)` 那個字串
在這裡變成 `OrderRow.class`** —— 5.8.11 的代價三解決了：
**改 package 或改類別名，編譯器會跟著改。**

### 5.10.5 實測：跟 Spring Data 整合

```java
    @Test @Transactional
    void 跟springdata整合() {
        head("5.10.5 QuerydslPredicateExecutor");
        System.out.println("  findAll(predicate)      → "
            + ((List<Ord5>) orders.findAll(O.status.eq(St5.PENDING))).size());
        var page = orders.findAll(O.status.eq(St5.PENDING),
                org.springframework.data.domain.PageRequest.of(0, 5));
        System.out.println("  findAll(predicate, page) → 這一頁 " + page.getContent().size()
            + " 筆、共 " + page.getTotalElements() + " 筆");
        System.out.println("  count(predicate)        → " + orders.count(O.status.eq(St5.PENDING)));
        System.out.println("  exists(predicate)       → " + orders.exists(O.orderNo.eq("SO-2026-000001")));
    }
```

```
═══ 5.10.5 QuerydslPredicateExecutor ═══
  findAll(predicate)      → 23
  findAll(predicate, page) → 這一頁 5 筆、共 23 筆
  count(predicate)        → 23
  exists(predicate)       → true
```

repository 多繼承一個介面就好：

```java
public interface Ord5Repo extends JpaRepository<Ord5, UUID>,
                                 JpaSpecificationExecutor<Ord5>,
                                 QuerydslPredicateExecutor<Ord5> { … }
```

⚠️ **而 `QuerydslPredicateExecutor` 只能回【實體】**，不能回投影。
要投影就得注入 `JPAQueryFactory` 自己寫（5.10.4）——
**實務上常見的做法是「自訂 repository 實作」**
（`OrderRepositoryCustom` 介面 + `OrderRepositoryImpl` 實作類別，
Spring Data 會自動把它併進同一個 repository bean）。

### 5.10.6 🔴 實測：QueryDSL 的三個代價

**代價一：多一個建置步驟，而它會壞。**

01 章 1.14 教過用 `@Embeddable record` 寫值物件：

```java
package com.example.lab.ch01;

import jakarta.persistence.Column;
import jakarta.persistence.Embeddable;

import java.math.BigDecimal;
import java.util.Objects;

/** 值物件：沒有 id，由「值」定義身分。 */
@Embeddable
public record Money(
        @Column(name = "amount_value",    precision = 19, scale = 4) BigDecimal value,
        @Column(name = "amount_currency", length = 3)                String currency) {

    public Money {
        Objects.requireNonNull(value);
        Objects.requireNonNull(currency);
        if (value.signum() < 0) throw new IllegalArgumentException("金額不可為負：" + value);
        if (currency.length() != 3) throw new IllegalArgumentException("幣別要 3 碼：" + currency);
    }
}
```

**把 QueryDSL 的 annotation processor 加進這個專案，`mvn compile` 直接失敗**：

```
[ERROR] Failed to execute goal …:maven-compiler-plugin:3.11.0:compile (default-compile)
        on project lab08: Fatal error compiling:
        java.lang.IllegalArgumentException: Illegal type: com.example.lab.ch01.Money
```

隔離出來確認過，堆疊是這樣的：

```
java.lang.IllegalArgumentException: Illegal type: p.MoneyRec
	at com.querydsl.apt.TypeExtractor.visitDeclared(TypeExtractor.java:56)
	at com.querydsl.apt.AbstractQuerydslProcessor.handleEmbeddedType(AbstractQuerydslProcessor.java:344)
	at com.querydsl.apt.AbstractQuerydslProcessor.getEmbeddedTypes(AbstractQuerydslProcessor.java:323)
```

**同一個 `@Embeddable` 改寫成 `class` 就通過了**（一樣的欄位、一樣的註解）。
**QueryDSL 5.0.0 的 APT 不認得 Java record 當 `@Embeddable`。**

⚠️ **而 `-Aquerydsl.includedPackages` / `excludedPackages` 都擋不住它**——
那兩個選項只決定「幫誰產生 Q 類別」，
**而 APT 在那之前就已經把所有 `@Embeddable` 掃過一遍了。**

```
你的選擇：
  ① 把 @Embeddable 從 record 改回 class（放棄 01 章 1.14 的寫法）
  ② 升級到有支援的版本（QueryDSL 6.x / OpenFeign 的 fork）
  ③ 只對特定套件跑 APT（本課的實驗專案用這個：一個獨立的 javac -proc:only）
```

**③ 的做法**（本課用這一個，所以 5.10 那些程式碼跑得起來）——
**把 APT 從 Maven 的編譯流程裡拿掉，改成自己呼叫一次 `javac -proc:only`**，
只餵給它 `ch05` 這個套件的檔案：

```bash
#!/bin/zsh
# qgen.sh —— 只對 com.example.lab.ch05 跑 QueryDSL APT，產出的 Q 類別放回 src/main/java
set -e
L=${0:a:h}                       # 專案根目錄
M=~/.m2/repository

# ★ 注意 classifier 是 jakarta —— 5.0.0 的預設版本是 javax，對不上 Boot 3
APT=$M/com/querydsl/querydsl-apt/5.0.0/querydsl-apt-5.0.0-jakarta.jar
APTCP=$APT\
:$M/com/querydsl/querydsl-codegen/5.0.0/querydsl-codegen-5.0.0.jar\
:$M/com/querydsl/codegen-utils/5.0.0/codegen-utils-5.0.0.jar\
:$M/javax/inject/javax.inject/1/javax.inject-1.jar\
:$M/com/google/guava/guava/16.0.1/guava-16.0.1.jar

# 專案自己的 classpath：mvn dependency:build-classpath -Dmdep.outputFile=cp.txt
CP=$(cat $L/cp.txt)

rm -rf $L/target/qgen && mkdir -p $L/target/qgen
javac -proc:only \
  -cp "$CP" -processorpath "$APTCP:$CP" \
  -processor com.querydsl.apt.jpa.JPAAnnotationProcessor \
  -s $L/target/qgen -d $L/target/qgen \
  $(ls $L/src/main/java/com/example/lab/ch05/*.java | grep -v "/Q[A-Z]")

cp $L/target/qgen/com/example/lab/ch05/Q*.java $L/src/main/java/com/example/lab/ch05/
```

⚠️ **兩個要注意的地方**：

```
① grep -v "/Q[A-Z]" —— 要把【上一次產生出來的 Q 類別】排除掉，
   否則第二次跑會拿舊的 Q 類別當輸入。
② 產出物進了 src/main/java，所以它會【進版控】——
   而 5.10.6 那個「Q 類別跟實體不同步」的風險就從建置期搬到了 code review。
   這是這個做法的代價，不是它的好處。
```

📌 **而這正好說明了為什麼 ①（把 `@Embeddable` 改回 class）通常是比較好的答案**：
它讓 APT 留在 Maven 裡，`mvn clean` 就保證同步。

> 📌 **這一格的教訓比 QueryDSL 本身重要**：
> **annotation processor 是建置期的相依，而它跟你的語言版本、
> 其他 processor、以及【你程式碼裡任何一個角落】都會互動。**
> **評估一個要 APT 的工具時，「它在我們現有的程式碼上跑得起來嗎」是第一個問題。**

**代價二：Q 類別跟實體不同步的時候，錯誤訊息很難懂。**
改了實體卻沒有重新編譯，`QOrd5` 還是舊的——
症狀是 `NoSuchFieldError` 或「查詢少一個條件」。
✅ **CI 一定要 `mvn clean`，不要用 IDE 的增量編譯結果。**

**代價三：它是一個第三方依賴，而 JPA 不是。**
QueryDSL 官方版在 2021 年之後幾乎停止維護
（社群 fork `io.github.openfeign.querydsl` 接手）。
**這是選型時要評估的東西**，而它跟「好不好用」是兩回事。

> 📌 **給一個具體的判準**：
>
> ```
> 專案裡動態查詢【少於三處】 → Specification 就夠了，不要引入 QueryDSL
> 動態查詢是【核心功能】（後台管理、報表平台） → QueryDSL 值得
> 已經在用 QueryDSL     → 留著，它很好用
> ```

---

## 5.11 原生 SQL

前面五節都在 JPA 的世界裡。**這一節是那個世界的出口。**

### 5.11.1 實測：三種入口

```java
package com.example.lab.ch05;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

/** 5.11：原生 SQL。 */
class FANative extends Base05 {

    @Autowired Ord5Repo orders;

    @BeforeEach void setUp() { seed(30, 5, 2, 0); }

    @Test @Transactional
    void 三種入口() {
        head("5.11.1 原生 SQL 的三種入口");
        em.clear();

        @SuppressWarnings("unchecked")
        List<Ord5> a = em.createNativeQuery("select * from orders where status = :st", Ord5.class)
                .setParameter("st", "PENDING").getResultList();
        System.out.println("  ① em.createNativeQuery(…, Ord5.class) → " + a.size()
            + " 張、PC 裡 " + managedEntities() + " 個實體  ★ 是實體");
        em.clear();

        List<?> b = em.createNativeQuery("select order_no, total_amount from orders where status = :st")
                .setParameter("st", "PENDING").getResultList();
        System.out.println("  ② 不指定型別 → " + b.size() + " 筆 Object[]、PC 裡 "
            + managedEntities() + " 個實體");
        em.clear();

        List<String> c = jdbc.queryForList(
                "select order_no from orders where status = ?", String.class, "PENDING");
        System.out.println("  ③ JdbcTemplate → " + c.size() + " 筆、PC 裡 "
            + managedEntities() + " 個實體  ★ 它根本不知道 JPA 的存在");
    }
}
```

```
═══ 5.11.1 原生 SQL 的三種入口 ═══
  ① em.createNativeQuery(…, Ord5.class) → 23 張、PC 裡 23 個實體  ★ 是實體
  ② 不指定型別 → 23 筆 Object[]、PC 裡 0 個實體
  ③ JdbcTemplate → 23 筆、PC 裡 0 個實體  ★ 它根本不知道 JPA 的存在
```

**三種入口，三種身分**：

| 入口 | 回來的是 | 進持久化情境嗎 | 改了會寫回去嗎 |
|---|---|---|---|
| `em.createNativeQuery(sql, Ord5.class)` | **實體** | ✅ | ✅（髒檢查照樣運作） |
| `em.createNativeQuery(sql)` | `Object[]` | 🔴 | 🔴 |
| `JdbcTemplate` / MyBatis | 你自己決定 | 🔴 | 🔴 |

📌 **第一列很值得注意**：**原生 SQL 一樣可以回傳「有身分的實體」。**
撈回來的 `Ord5` 跟 `em.find()` 撈的完全一樣——一級快取、髒檢查、`@Version` 全部有效。
**「用原生 SQL 就等於放棄 ORM」是錯的。**

⚠️ **而它有一個前提**：`select *` 要**涵蓋實體映射的每一個欄位**。
少一欄會拋 `SQLException: Column 'xxx' not found`（Hibernate 6 的訊息還算清楚）。

### 5.11.2 實測：`@SqlResultSetMapping` 與 `@NamedNativeQuery`

**`Object[]` 難用，而原生 SQL 沒有 `select new`。JPA 的答案是宣告一個對映**：

```java
package com.example.lab.ch05;

import jakarta.persistence.ColumnResult;
import jakarta.persistence.ConstructorResult;
import jakarta.persistence.Entity;
import jakarta.persistence.NamedNativeQuery;
import jakarta.persistence.SqlResultSetMapping;
import jakarta.persistence.Table;

/**
 * 5.11.2：@SqlResultSetMapping 掛在一個實體上（規格要求），
 * 而它描述的是「一句原生 SQL 的結果要怎麼變成物件」。
 * 這裡沿用同一張 orders 表，只是借它掛註解。
 */
@Entity @Table(name = "orders")
@SqlResultSetMapping(
    name = "OrderRowMapping",
    classes = @ConstructorResult(
        targetClass = OrderRow.class,
        columns = {
            @ColumnResult(name = "id",           type = java.util.UUID.class),
            @ColumnResult(name = "order_no",     type = String.class),
            @ColumnResult(name = "customer_name", type = String.class),
            @ColumnResult(name = "status",       type = St5.class),
            @ColumnResult(name = "total_amount", type = java.math.BigDecimal.class),
            @ColumnResult(name = "placed_at",    type = java.time.Instant.class),
            @ColumnResult(name = "item_count",   type = Long.class)
        }))
@NamedNativeQuery(
    name = "Ord5Native.rows",
    resultSetMapping = "OrderRowMapping",
    query = """
            SELECT o.id, o.order_no, c.display_name AS customer_name, o.status,
                   o.total_amount, o.placed_at,
                   (SELECT COUNT(*) FROM order_item i WHERE i.order_id = o.id) AS item_count
              FROM orders o JOIN customer c ON c.id = o.customer_id
             WHERE o.status = :st
            """)
public class Ord5Native extends Base5 {
    protected Ord5Native() {}
}
```

```java
    @Test @Transactional
    void 具名原生查詢與結果集映射() {
        head("5.11.2 @SqlResultSetMapping + @NamedNativeQuery");
        em.clear();
        @SuppressWarnings("unchecked")
        List<OrderRow> rows = em.createNamedQuery("Ord5Native.rows")
                .setParameter("st", "PENDING").getResultList();
        System.out.println("  " + rows.size() + " 筆，第一筆：" + rows.get(0));
        System.out.println("  PC 裡 " + managedEntities() + " 個實體");
        showSql("SQL", () -> em.createNamedQuery("Ord5Native.rows")
                .setParameter("st", "PENDING").getResultList());
    }
```

```
═══ 5.11.2 @SqlResultSetMapping + @NamedNativeQuery ═══
  23 筆，第一筆：OrderRow[id=…, orderNo=SO-2026-000002, customerName=客戶1,
                        status=PENDING, totalAmount=210.0000, placedAt=…, itemCount=2]
  PC 裡 0 個實體
── SQL → 1 句 SQL
   SELECT o.id, o.order_no, c.display_name AS customer_name, o.status, o.total_amount, o.placed_at,
          (SELECT COUNT(*) FROM order_item i WHERE i.order_id = o.id) AS item_count …
```

✅ **原生 SQL 也可以回 DTO、也可以不建實體。**

⚠️ **而看看它的成本**：那個 `@SqlResultSetMapping` 有 **20 行**，
只為了描述「這七欄對到那七個建構子參數」。
JPQL 的 `select new …(...)` 是**一行**。

> 📌 **這就是「什麼時候該交給 MyBatis」的第一個訊號**（5.11.5）：
> **當你發現自己在用註解描述一句 SQL 的結果形狀時，
> 你正在重寫 MyBatis 的 `resultMap`，而且比它囉唆。**

### 5.11.3 🔴 實測：原生 SQL 改資料，持久化情境不知道

```java
    @Test
    void 原生sql改資料pc不知道() {
        head("5.11.3 🔴 原生 SQL 改資料，持久化情境不知道");
        tx.executeWithoutResult(s -> {
            UUID id = orderIds.get(0);
            Ord5 o = em.find(Ord5.class, id);
            System.out.println("  ① 撈出來 → " + o.getStatus());

            jdbc.update("update orders set status = 'SHIPPED' where id = ?",
                    (Object) com.example.lab.Uuid7.toBytes(id));
            System.out.println("  ② JdbcTemplate 改成 SHIPPED（繞過 Hibernate）");
            System.out.println("  ③ PC 裡的物件 → " + o.getStatus() + " 🔴");

            em.refresh(o);
            System.out.println("  ④ refresh 之後 → " + o.getStatus() + " ✅");
        });
    }
```

```
═══ 5.11.3 🔴 原生 SQL 改資料，持久化情境不知道 ═══
  ① 撈出來 → PENDING
  ② JdbcTemplate 改成 SHIPPED（繞過 Hibernate）
  ③ PC 裡的物件 → PENDING 🔴
  ④ refresh 之後 → SHIPPED ✅
```

**跟 5.6.2 完全一樣的機制、完全一樣的後果。**
差別只在這次連 Hibernate 都沒經過。

⚠️ **而它比 5.6.2 更危險，因為 `@Version` 也不會動。**
📌 **這就是 00 章 0.3.5 那個「混用讓樂觀鎖靜默失效」的事故**——
**09 章會完整處理混用，而它的第一條規則就在這裡**：
**同一個交易裡，不要一邊用 JPA 改、一邊用 MyBatis 改同一張表。**

### 5.11.4 實測：原生查詢會不會觸發 auto-flush ★

**這一格的結果跟很多人的直覺相反。**

```java
    /** ★ 三種查詢各自跑在【自己的交易】裡：同一個交易裡跑第二次，第一次已經把它 flush 掉了。 */
    private void probeFlush(String label,
                            java.util.function.Function<jakarta.persistence.EntityManager, Object> q,
                            String note) {
        seed(30, 5, 2, 0);
        tx.executeWithoutResult(s -> {
            UUID id = orderIds.get(0);
            OrdVer5 o = em.find(OrdVer5.class, id);
            o.setStatus(St5.PAID);                            // 只改物件，還沒 flush
            List<String> sqls = spy(() -> System.out.println("  " + label + " = " + q.apply(em)));
            System.out.println("     → " + sqls.size() + " 句 SQL " + note);
            sqls.forEach(x -> System.out.println("       " + cut(x)));
        });
    }

    @Test
    void 原生查詢會不會觸發autoflush() {
        head("5.11.4 原生查詢會不會觸發 auto-flush");
        probeFlush("① JPQL   count(status = PAID)",
                e -> e.createQuery("select count(o) from OrdVer5 o where o.status = :st", Long.class)
                      .setParameter("st", St5.PAID).getSingleResult(), "");
        probeFlush("② 原生   count(status = 'PAID')",
                e -> e.createNativeQuery("select count(*) from orders where status = 'PAID'")
                      .getSingleResult(), "");
        probeFlush("③ 原生（查一張【不相干】的表 customer）",
                e -> e.createNativeQuery("select count(*) from customer").getSingleResult(), "");
        probeFlush("④ 原生 + addSynchronizedEntityClass(Cust5)",
                e -> e.createNativeQuery("select count(*) from customer")
                      .unwrap(org.hibernate.query.NativeQuery.class)
                      .addSynchronizedEntityClass(Cust5.class)
                      .getSingleResult(), "");
    }
```

```
═══ 5.11.4 原生查詢會不會觸發 auto-flush ═══
  起點：資料庫裡是 PENDING，等一下每一格都會先把它改成 PAID（不 flush）
  ① JPQL   count(status = PAID) = 1
     → 2 句 SQL
       update orders set …,status=?,… where id=? and version=?
       select count(ov1_0.id) from orders ov1_0 where ov1_0.status=?
  ② 原生   count(status = 'PAID') = 1
     → 2 句 SQL
       update orders set …,status=?,… where id=? and version=?
       select count(*) from orders where status = 'PAID'
  ③ 原生（查一張【不相干】的表 customer） = 5
     → 2 句 SQL
       update orders set …,status=?,… where id=? and version=?
       select count(*) from customer
  ④ 原生 + addSynchronizedEntityClass(Cust5) = 5
     → 1 句 SQL
       select count(*) from customer
```

**三個觀察**：

**① 原生查詢【會】觸發 auto-flush。** ②那一格看得到那筆還沒寫回去的修改。
（一個常見的說法是「原生查詢繞過 Hibernate，所以看不到未 flush 的修改」——**它是錯的**。）

**② 🔴 而它是【無差別】的**：③ 查的是 `customer`，跟 `orders` 一點關係都沒有，
**Hibernate 還是把 `orders` 的修改 flush 出去了。**

```
JPQL：Hibernate 剖析過它，知道它碰哪幾張表（query space）
      → 只 flush 跟那些表有關的修改
原生：那是一個【字串】。Hibernate 不知道它碰什麼
      → 保守起見，全部 flush
```

**③ 而你可以告訴它。** `addSynchronizedEntityClass` / `addSynchronizedQuerySpace`
明講「這句只碰 customer」，於是 ④ 只有一句 SQL。

> ⚠️ **這件事在什麼時候會痛**：
> 一個交易裡改了幾百個實體、中間穿插一句「跟這些完全無關的」原生查詢
> （例如查一張組態表）——**那一句會逼出一次完整的 flush**。
> 而 03 章 3.4.7 量過髒檢查的成本：20000 個實體 → 1.5 ms。

### 5.11.5 實測：原生查詢的分頁與參數

```java
    @Test @Transactional
    void 原生查詢的分頁與參數() {
        head("5.11.5 原生查詢：分頁與參數");

        List<?> a = em.createNativeQuery("select order_no from orders order by placed_at")
                .setFirstResult(10).setMaxResults(5).getResultList();
        System.out.println("  ① setFirstResult/setMaxResults 在原生查詢上有效嗎？→ " + a.size() + " 筆");
        showSql("   SQL", () -> em.createNativeQuery("select order_no from orders order by placed_at")
                .setFirstResult(10).setMaxResults(5).getResultList());

        System.out.println("\n  ② UUID 參數：");
        UUID id = orderIds.get(0);
        Object n = em.createNativeQuery("select count(*) from orders where id = :id")
                .setParameter("id", id).getSingleResult();
        System.out.println("     直接傳 UUID → " + n + " 筆");
        Object m = em.createNativeQuery("select count(*) from orders where id = :id")
                .setParameter("id", com.example.lab.Uuid7.toBytes(id)).getSingleResult();
        System.out.println("     傳 byte[]    → " + m + " 筆");

        System.out.println("\n  ③ 列舉參數：");
        Object k = em.createNativeQuery("select count(*) from orders where status = :st")
                .setParameter("st", St5.PENDING.name()).getSingleResult();
        System.out.println("     傳 .name()   → " + k + " 筆（原生查詢沒有 @Enumerated 的轉換）");
    }
```

```
═══ 5.11.5 原生查詢：分頁與參數 ═══
  ① setFirstResult/setMaxResults 在原生查詢上有效嗎？→ 5 筆
──    SQL → 1 句 SQL
   select order_no from orders order by placed_at limit ?,?

  ② UUID 參數：
     直接傳 UUID → 1 筆
     傳 byte[]    → 1 筆

  ③ 列舉參數：
     傳 .name()   → 23 筆（原生查詢沒有 @Enumerated 的轉換）
```

**兩個好消息、一個要注意的**：

**① ✅ `setFirstResult` / `setMaxResults` 在原生查詢上【有效】**——
Hibernate 6 會照方言把 `limit ?,?` 接在你的 SQL 後面。
（另一個流傳的說法「原生查詢要自己寫 limit」在 Hibernate 6 已經不成立。
⚠️ 但如果你的 SQL 本身有 `limit`，或者它是一個 `union`，就要自己處理。）

**② ✅ `UUID` 參數直接傳就好**——Hibernate 6 知道怎麼把它變成 `binary(16)`。

**③ ⚠️ 列舉要自己 `.name()`。** 原生查詢完全不經過 `@Enumerated` 的轉換
（01 章 1.7）——**`@Convert` 的轉換器也一樣不會生效。**
📌 **這是一個很實際的地雷**：一個用 `@Convert` 加密的欄位，
原生 SQL 讀出來的是**密文**，寫進去的是**明文**。

### 5.11.6 什麼時候該交給 MyBatis

**這一節示範了原生 SQL 在 JPA 裡可以走多遠。而它有一個明確的邊界**：

| 需求 | JPA 的原生查詢 | 什麼時候該換 |
|---|---|---|
| 一句手寫 SQL 回實體 | ✅ 很好用 | — |
| 一句手寫 SQL 回幾個欄位 | ✅ `Object[]`，湊合 | — |
| **回一個有結構的 DTO** | 🟡 `@SqlResultSetMapping`，20 行註解 | **DTO 一多就該換** |
| **DTO 裡有巢狀集合** | 🔴 做不到（要自己 group，5.8.8） | **MyBatis 的巢狀 `resultMap`** |
| **SQL 本身是動態的**（欄位、表名會變） | 🔴 只能拼字串 | **MyBatis 的 `<if>` / `<choose>`（08 章）** |
| **一句 300 行的報表 SQL** | 🟡 塞在 `@Query` 字串裡 | **MyBatis 的 XML（有語法高亮、可以貼進工具跑）** |

> 📌 **判準寫成一句話**：
>
> > **「這句 SQL 的【結果形狀】需要被描述嗎？」**
> > 不需要（回實體、回幾個純量）→ 留在 JPA。
> > 需要，而且形狀不簡單 → **那是 MyBatis 的主場（07 / 08 章）。**

⚠️ **而 09 章會補上混用的代價**——5.11.3 那個「持久化情境不知道」
就是混用的第一號地雷，00 章 0.3.5 已經演過一次了。

---

## 5.12 五種查詢技術的對照與決策表 ★★

### 5.12.1 五個維度

| | 衍生查詢 | `@Query`（JPQL） | Criteria / Specification | QueryDSL | 原生 SQL |
|---|---|---|---|---|---|
| **錯字什麼時候發現** | 啟動時 | 啟動時 | **編譯期**（要 metamodel） | **編譯期** | 🔴 執行期 |
| **條件可以動態嗎** | 🔴 不行 | 🔴 不行 | ✅ | ✅ | 🟡 拼字串 |
| **可讀性** | ✅ 方法名就是條件 | ✅ 像 SQL | 🔴 很差 | ✅ 好 | ✅ 就是 SQL |
| **能不能投影** | ✅ 介面投影 | ✅ `select new` | ✅ `cb.construct` | ✅ `Projections` | 🟡 `@SqlResultSetMapping` |
| **要不要多裝東西** | — | — | jpamodelgen | **querydsl-apt + 依賴** | — |
| **能用資料庫特有語法嗎** | 🔴 | 🟡 `function(...)` | 🔴 | 🟡 `Expressions.template` | ✅ |

### 5.12.2 決策表

| 場景 | 用什麼 | 為什麼 |
|---|---|---|
| **1～3 個固定條件的查詢** | **衍生查詢** | 方法名就是文件；啟動時驗證（5.7.7） |
| 4 個以上固定條件、或有 join / 聚合 | **`@Query`（JPQL）** | 衍生查詢的方法名會爆炸（5.7.1） |
| **唯讀列表 / 報表** ★ | **`@Query` + `select new` DTO** | 0 個實體（5.8.6）、分頁正確（5.8.9） |
| **條件是動態的**（搜尋畫面） | **`Specification`** | 條件可以命名、組合、單獨測試（5.9.6） |
| 動態查詢是**核心功能**、而且很多 | **QueryDSL** | Criteria 的型別安全 + JPQL 的可讀性（5.10.1） |
| **一次改很多筆、不需要回呼與樂觀鎖** | **JPQL 批次 `update` / `delete`** | 151 句 → 1 句（5.6.1），而代價要懂（5.6.2/3） |
| **DTO 裡要有巢狀集合** | **兩段式投影**（5.8.8）或 **MyBatis**（08 章） | `select new` 的參數只能是純量 |
| 要用資料庫特有語法（`JSON_EXTRACT`、CTE、窗口函式） | **HQL 擴充**（5.4.8）或 **原生 SQL** | 而要知道自己放棄了什麼 |
| **一句 300 行的報表 SQL** | **MyBatis**（07/08 章） | `@SqlResultSetMapping` 會比 SQL 還長（5.11.6） |

### 5.12.3 三個常見的錯誤選擇

**錯誤一：「先全部用 `@Query` 拼字串，動態條件用 `if` 加上去。」**

🔴 5.9.1 那五個問題會全部發生，而且**它們都在執行期**。
✅ **動態條件 = Specification 或 QueryDSL，沒有例外。**

---

**錯誤二：「為了型別安全，全部改成 Criteria。」**

🔴 5.9.7 的代價一：三行 JPQL 變九行 Criteria，而**它們的 SQL 一模一樣**。
✅ **固定條件的查詢用 `@Query`。它的錯字在【啟動時】就會被抓到（5.7.7），
這對絕大多數專案已經足夠。**

---

**錯誤三：「列表頁很慢，改用原生 SQL 應該會比較快。」**

🔴 5.8.10 證明了慢的原因是**建了 650 個實體**，不是 JPQL 翻譯得不好。
**改成原生 SQL 回實體 → 一樣 650 個 → 一樣慢。**
✅ **先換回傳型別（投影），再考慮換查詢語言。**

---

## 5.13 把這一章的規則變成 CI 會擋下來的東西

04 章 4.10 把 N+1 變成一個跟資料量無關的分數。這一章有三條類似的規則。

### 5.13.1 斷言一：所有查詢定義在啟動時被驗證

5.7.7 已經證明：`@Query` 與衍生查詢的錯字**都會讓 context 起不來**。

**所以這條斷言你其實已經有了**——只要 CI 裡有**任何一個** `@SpringBootTest`
會載入完整的 repository 層，全部的查詢定義就都被檢查過一次。

```java
@SpringBootTest
class ContextLoadsTest {
    @Test void 全部的查詢定義都合法() { }     // ★ 空的。它的價值在「context 起得來」
}
```

⚠️ **而它有兩個涵蓋不到的地方（5.7.7 那張表）**：

```
🔴 @Query(nativeQuery = true) 的 SQL —— 那是一個字串
🔴 寫在 Service 裡的 em.createQuery("…")
```

**第一個沒辦法在啟動時檢查**（要真的送到資料庫才知道），
**第二個可以用下一條斷言擋掉。**

### 5.13.2 斷言二：查詢不准寫在 Service 裡

```java
package com.example.lab.ch05;

import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.lang.syntax.ArchRuleDefinition;
import org.junit.jupiter.api.Test;

/** 5.13.2：查詢只能定義在 repository 層。 */
class GArch {

    @Test
    void service不准直接寫查詢() {
        var classes = new ClassFileImporter().importPackages("com.example.lab.shop");

        ArchRuleDefinition.noClasses()
                .that().haveSimpleNameEndingWith("Service")
                .should().dependOnClassesThat().haveFullyQualifiedName("jakarta.persistence.Query")
                .because("查詢要定義在 repository 上，才會在啟動時被驗證（05 章 5.7.7）")
                .check(classes);

        ArchRuleDefinition.noClasses()
                .that().haveSimpleNameEndingWith("Service")
                .should().callMethodWhere(
                        com.tngtech.archunit.base.DescribedPredicate.describe(
                            "是 EntityManager.createQuery / createNativeQuery",
                            t -> t.getTarget().getOwner().getFullName()
                                    .equals("jakarta.persistence.EntityManager")
                                 && t.getTarget().getName().startsWith("create")
                                 && t.getTarget().getName().endsWith("Query")))
                .because("同上")
                .check(classes);
    }
}
```

```
═══ 5.13.2 ArchUnit：Service 不准直接寫查詢 ═══
  ✅ com.example.lab.shop 通過
```

📌 **這條規則的價值不是「風格統一」，是 5.7.7**：
**查詢寫在 repository 介面上，才會在每一次啟動時被驗證。**

### 5.13.3 斷言三：唯讀的用例不准建實體 ★

**這是這一章專屬的一條，而且它跟資料量無關。**

```java
        var stats = emf.unwrap(org.hibernate.SessionFactory.class).getStatistics();
        stats.clear();
        service.list(OrderStatus.PENDING, 0, 20);
        if (stats.getEntityLoadCount() != 0) throw new AssertionError("列表頁不該建實體");
```

**`entityLoadCount == 0`** 的意思是「這個用例沒有把任何一列變成實體」。

> 📌 **它抓得到什麼**：
> 有人為了「順便顯示折扣」，把 `select new OrderListRow(...)` 改回 `select o`——
> **SQL 句數不會變（都是 2 句），時間也只差幾毫秒，
> 而 `entityLoadCount` 會從 0 變成 20。**
>
> ⚠️ **這正是 04 章 4.10.4 那個「有人加了一行」的同一類問題**，
> 只是這一次那一行改的不是 fetch 策略，是**回傳型別**。

**寫成一個可以重複使用的守則**（跟 04 章的 `NPlus1Spy` 同一個形狀）：

```java
package com.example.lab.ch05;

import jakarta.persistence.EntityManagerFactory;
import org.hibernate.SessionFactory;
import org.hibernate.stat.Statistics;

/**
 * 5.13.3：把「這個用例該不該建實體」變成一個斷言。
 *
 *   entityLoadCount —— 有幾列被變成【實體】（含快照、髒檢查、一級快取）
 * 唯讀的列表頁與報表，這個數字應該是 0。
 */
public final class ReadOnlySpy {

    private final Statistics s;

    public ReadOnlySpy(EntityManagerFactory emf) {
        this.s = emf.unwrap(SessionFactory.class).getStatistics();
        if (!s.isStatisticsEnabled()) {
            throw new IllegalStateException("要先開 hibernate.generate_statistics=true");
        }
    }

    public Result watch(Runnable body) {
        s.clear();
        body.run();
        return new Result(s.getPrepareStatementCount(), s.getEntityLoadCount(),
                          s.getCollectionLoadCount());
    }

    public record Result(long statements, long entityLoad, long collectionLoad) {

        /** 這個用例是唯讀的：一個實體都不該建。 */
        public Result assertNoEntities() {
            if (entityLoad > 0) {
                throw new AssertionError(String.format(
                    "這個唯讀用例建了 %d 個實體（%d 句 SQL）。"
                    + "改用 DTO 投影（05 章 5.8），或者說明為什麼需要實體。",
                    entityLoad, statements));
            }
            return this;
        }

        /** 這個用例要改資料，實體是必要的 —— 但不該超過 max 個。 */
        public Result assertAtMostEntities(long max) {
            if (entityLoad > max) {
                throw new AssertionError(String.format(
                    "建了 %d 個實體，超過上限 %d。", entityLoad, max));
            }
            return this;
        }

        @Override public String toString() {
            return String.format("stmt=%d  entityLoad=%d  collLoad=%d",
                    statements, entityLoad, collectionLoad);
        }
    }
}
```

### 5.13.4 三條斷言的分工

```
04 章 NPlus1Spy.assertNoNPlus1()      —— 這個用例的資料是【一次撈齊】的嗎
05 章 ReadOnlySpy.assertNoEntities()  —— 這個用例【需要實體】嗎
5.13.2 的 ArchUnit                     —— 查詢有沒有定義在會被驗證的地方
```

⚠️ **三條都不是「效能測試」**：
它們不量時間、不看資料量，**只問「這段程式碼在做的事情，跟它宣稱要做的事情一致嗎」**。
**所以它們在 CI 上穩定、不會 flaky。**

---

## 5.14 shop-service 的落地

### 5.14.1 04 章留下的缺口

04 章 4.11.4 把列表頁修到「3 句 SQL、`limit` 有效」，然後停在這裡：

```
list（200 張訂單裡取第一頁 20 筆）
   3 句 SQL：主查詢（join customer）+ count + items 的 @BatchSize
   而它建了【80 個實體】：20 張訂單 + 40 筆明細 + 20 個客戶
```

**而那一頁要顯示的是 6 個值。**

### 5.14.2 三個改動

**改動一：列表頁回傳投影，不是實體。**

```java
package com.example.lab.shop;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

/**
 * 05 章 5.14：列表頁那一列。它【不是實體】——
 * 04 章 4.11.4 的列表頁為了這 6 個值建了 80 個實體，這裡是 0 個。
 */
public record OrderListRow(
        UUID id, String orderNo, String customerName,
        OrderStatus status, BigDecimal totalAmount, Instant placedAt, long itemCount) {}
```

```java
package com.example.lab.shop;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.EntityGraph;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface OrderRepository extends JpaRepository<Order, UUID>,
                                        org.springframework.data.jpa.repository.JpaSpecificationExecutor<Order> {

    List<Order> findByStatus(OrderStatus status);      // ★ 參數是 enum，不是 String
    Optional<Order> findByOrderNo(String orderNo);

    /**
     * ★ 04 章 4.11：明細頁要「客戶 + 明細 + 每筆明細的商品」，一句撈齊。
     *   跟 findById 分成兩個方法，因為【不同用例要的關聯不一樣】（04 章 4.6.1）。
     */
    @EntityGraph(attributePaths = {"customer", "items", "items.product"})
    Optional<Order> findDetailById(UUID id);

    /**
     * ★ 04 章 4.11：列表頁只 fetch 客戶（@ManyToOne 可以 join 而不影響分頁），
     *   明細交給 Order.items 上的 @BatchSize（04 章 4.5.5 / 4.7.5）。
     *   ★ 05 章 5.14 之後，這個方法只剩下「跟投影版對照」的用途。
     */
    @EntityGraph(attributePaths = {"customer"})
    Page<Order> findByStatusOrderByPlacedAtDesc(OrderStatus status, Pageable page);

    /**
     * ★ 05 章 5.14：列表頁改成投影。
     *   04 章那一版回傳的是 Page<Order>（80 個實體），這一版回傳 Page<OrderListRow>（0 個）。
     *   itemCount 用相關子查詢算，不需要把明細撈回來。
     */
    @org.springframework.data.jpa.repository.Query("""
           select new com.example.lab.shop.OrderListRow(
                    o.id, o.orderNo, c.displayName, o.status, o.totalAmount, o.placedAt,
                    (select count(i) from OrderItem i where i.order = o))
             from Order o join o.customer c
            where o.status = :status
            order by o.placedAt desc
           """)
    Page<OrderListRow> listRows(
            @org.springframework.data.repository.query.Param("status") OrderStatus status,
            Pageable page);
}
```

**改動二：搜尋 API 用 `Specification`。**

```java
package com.example.lab.shop;

import java.math.BigDecimal;
import java.time.Instant;

/** 05 章 5.14：搜尋條件，每一個都可以是 null。 */
public record OrderSearchCriteria(OrderStatus status, String customerKeyword,
                                  Instant from, Instant to, BigDecimal minAmount) {
    public static OrderSearchCriteria empty() {
        return new OrderSearchCriteria(null, null, null, null, null);
    }
}
```

```java
package com.example.lab.shop;

import org.springframework.data.jpa.domain.Specification;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/** 05 章 5.14：一個條件一個方法（05 章 5.9.6）。 */
public final class OrderSpecifications {

    private OrderSpecifications() {}

    public static Specification<Order> statusIs(OrderStatus s) {
        return (root, q, cb) -> cb.equal(root.get("status"), s);
    }

    /** ★ 使用者輸入要跳脫 like 的萬用字元（05 章 5.4.2） */
    public static Specification<Order> customerLike(String kw) {
        String p = "%" + kw.replace("!", "!!").replace("%", "!%").replace("_", "!_") + "%";
        return (root, q, cb) -> cb.like(root.join("customer").get("displayName"), p, '!');
    }

    public static Specification<Order> placedBetween(Instant from, Instant to) {
        return (root, q, cb) -> cb.between(root.get("placedAt"), from, to);
    }

    public static Specification<Order> amountAtLeast(BigDecimal a) {
        return (root, q, cb) -> cb.greaterThanOrEqualTo(root.get("totalAmount"), a);
    }

    /**
     * ★ 沒有任何條件時回「永遠成立」，不是 null：
     *   findAll(Specification) 收得下 null，而 findBy(Specification, …) 會拋
     *   IllegalArgumentException: Specification must not be null（05 章 5.14.5）。
     */
    public static Specification<Order> of(OrderSearchCriteria c) {
        List<Specification<Order>> parts = new ArrayList<>();
        if (c.status() != null)          parts.add(statusIs(c.status()));
        if (c.customerKeyword() != null) parts.add(customerLike(c.customerKeyword()));
        if (c.from() != null && c.to() != null) parts.add(placedBetween(c.from(), c.to()));
        if (c.minAmount() != null)       parts.add(amountAtLeast(c.minAmount()));
        Specification<Order> out = (root, q, cb) -> cb.conjunction();
        for (Specification<Order> p : parts) out = out.and(p);
        return out;
    }
}
```

⚠️ **注意這裡沒有用 metamodel（`root.get("status")` 是字串）。**
`shop-service` 沒有引入 `hibernate-jpamodelgen`——
**這是一個真實專案裡常見的取捨**：只有兩三個 Specification 的時候，
多一個 annotation processor 的成本大於它擋下的錯字。
📌 **而只要 Specification 超過五個，就該把 metamodel 加回來（5.9.3）。**

**改動三：`OrderService` 的三個方法。**

```java
package com.example.lab.shop;

import jakarta.persistence.EntityManager;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import org.springframework.data.domain.PageRequest;

import java.util.List;
import java.util.UUID;

/**
 * 03 章 3.11 的落地：整個類別裡【沒有一次 save()】。
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
    private final EntityManager em;

    public OrderService(OrderRepository orders, CustomerRepository customers,
                        ProductRepository products, EntityManager em) {
        this.orders = orders; this.customers = customers;
        this.products = products; this.em = em;
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
        return o.getId();
    }

    /** ② 改資料：撈出來、呼叫方法、結束。沒有 save。 */
    @Transactional
    public void pay(UUID orderId) {
        order(orderId).pay();
    }

    @Transactional
    public void cancel(UUID orderId) {
        order(orderId).cancel();
    }

    @Transactional
    public void addItem(UUID orderId, UUID productId, int qty, UUID itemId) {
        Product p = products.findById(productId)
                .orElseThrow(() -> new IllegalArgumentException("商品不存在：" + productId));
        order(orderId).addItem(itemId, p, qty);
    }

    /**
     * ④ 讀：唯讀交易（不建快照、flush mode MANUAL），回傳 DTO。
     * ★ 04 章 4.11：改用 findDetailById —— 一句 SQL 撈齊客戶 + 明細 + 商品。
     * ★ 05 章沒有改它：明細頁【需要】完整的訂單內容，實體是合理的（5.14.6 量到 6 個）。
     */
    @Transactional(readOnly = true)
    public OrderView view(UUID orderId) {
        Order o = orders.findDetailById(orderId)
                .orElseThrow(() -> new IllegalArgumentException("訂單不存在：" + orderId));
        return OrderView.of(o);        // ★ 在交易裡就轉成 DTO，關聯還讀得到
    }

    /**
     * ④b 列表頁。
     * ★ 05 章 5.14 的改動：回傳【投影】，不是實體。
     *   04 章那一版的兩個決定（@EntityGraph 撈客戶、明細靠 @BatchSize）
     *   解的是「幾句 SQL」；這一版解的是「建幾個實體」——
     *   一句 SQL、0 個實體、limit 有效（05 章 5.8.9）。
     */
    @Transactional(readOnly = true)
    public List<OrderListRow> list(OrderStatus status, int page, int size) {
        return orders.listRows(status, PageRequest.of(page, size)).getContent();
    }

    /**
     * ④b′ 04 章 4.11.2 當時的列表頁 —— 保留下來，05 章 5.14 要拿它做對照。
     *   兩者的 SQL 句數一樣，差別在【建了幾個實體】。
     */
    @Transactional(readOnly = true)
    public List<OrderView> listAsEntities(OrderStatus status, int page, int size) {
        return orders.findByStatusOrderByPlacedAtDesc(status, PageRequest.of(page, size))
                .map(OrderView::of)
                .getContent();
    }

    /**
     * ④c 搜尋（05 章 5.14）：五個條件都可以不填。
     * ★ 用 Specification 而不是字串拼 JPQL（05 章 5.9.1 的五個問題）。
     * ★ project("customer") 等同 @EntityGraph(customer) —— 沒有它，
     *   OrderView.of() 讀客戶名稱會多打幾句（5.14.5）。
     */
    @Transactional(readOnly = true)
    public List<OrderView> search(OrderSearchCriteria criteria, int page, int size) {
        return orders.findBy(OrderSpecifications.of(criteria),
                        q -> q.project("customer")          // ★ 等同 @EntityGraph(customer)
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

### 5.14.3 這一節的測試基底

`shop-service` 用的是 `shop` 資料庫（不是 `ch05`），所以它有自己的基底：

```java
package com.example.lab.ch05;

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
import java.util.List;
import java.util.UUID;

@SpringBootTest(properties = {
  "spring.datasource.url=jdbc:mysql://127.0.0.1:33306/shop?connectionTimeZone=UTC"
      + "&forceConnectionTimeZoneToSession=true&preserveInstants=true&characterEncoding=UTF-8",
  "spring.jpa.properties.hibernate.generate_statistics=true"
})
public abstract class G1ShopBase {

    @Autowired protected EntityManager em;
    @Autowired protected EntityManagerFactory emf;
    @Autowired protected JdbcTemplate jdbc;
    @Autowired protected TransactionTemplate tx;

    /** 隨便一張訂單的 id（binary(16) → UUID）。 */
    protected UUID anyOrderId() {
        byte[] b = jdbc.queryForObject("select id from orders limit 1", byte[].class);
        return com.example.lab.Uuid7.fromBytes(b);
    }

    protected void seed(int orderCount, int customerCount) {
        jdbc.update("DELETE FROM order_item");
        jdbc.update("DELETE FROM orders");
        jdbc.update("DELETE FROM stock");
        jdbc.update("DELETE FROM product");
        jdbc.update("DELETE FROM customer");

        List<UUID> cs = new ArrayList<>();
        List<Object[]> cRows = new ArrayList<>();
        for (int i = 0; i < customerCount; i++) {
            UUID id = Uuid7.next(); cs.add(id);
            cRows.add(new Object[]{Uuid7.toBytes(id), "c" + i + "@x.com", "客戶" + i});
        }
        jdbc.batchUpdate("INSERT INTO customer (id,email,display_name) VALUES (?,?,?)", cRows);

        List<UUID> ps = new ArrayList<>();
        List<Object[]> pRows = new ArrayList<>(), sRows = new ArrayList<>();
        for (int i = 0; i < 3; i++) {
            UUID id = Uuid7.next(); ps.add(id);
            pRows.add(new Object[]{Uuid7.toBytes(id), "SKU-" + i, "商品" + i,
                    new BigDecimal((100 + i * 50) + ".0000")});
            sRows.add(new Object[]{Uuid7.toBytes(id), 100 + i});
        }
        jdbc.batchUpdate("INSERT INTO product (id,sku,name,unit_price) VALUES (?,?,?,?)", pRows);
        jdbc.batchUpdate("INSERT INTO stock (product_id,qty) VALUES (?,?)", sRows);

        List<Object[]> oRows = new ArrayList<>(), iRows = new ArrayList<>();
        Instant t0 = Instant.parse("2026-09-01T00:00:00Z");
        for (int i = 0; i < orderCount; i++) {
            UUID oid = Uuid7.next();
            oRows.add(new Object[]{Uuid7.toBytes(oid), String.format("SO-2026-%06d", i + 1),
                    Uuid7.toBytes(cs.get(i % customerCount)), "PENDING",
                    new BigDecimal("250.0000"), new BigDecimal("0.0000"), "TWD",
                    java.sql.Timestamp.from(t0.plusSeconds(i * 60L)), 0L});
            for (int k = 0; k < 2; k++) {
                iRows.add(new Object[]{Uuid7.toBytes(Uuid7.next()), Uuid7.toBytes(oid),
                        Uuid7.toBytes(ps.get(k % 3)), "商品" + (k % 3),
                        new BigDecimal("100.0000"), 1, new BigDecimal("100.0000")});
            }
        }
        jdbc.batchUpdate("INSERT INTO orders"
                + " (id,order_no,customer_id,status,total_amount,discount_amount,currency,placed_at,version)"
                + " VALUES (?,?,?,?,?,?,?,?,?)", oRows);
        jdbc.batchUpdate("INSERT INTO order_item"
                + " (id,order_id,product_id,product_name,unit_price,qty,line_amount)"
                + " VALUES (?,?,?,?,?,?,?)", iRows);
    }
}
```

而 5.14 的三個測試共用這幾個小工具（跟 `Base05` 一樣）：

```java
package com.example.lab.ch05;

import com.example.lab.SqlSpy;
import com.example.lab.shop.*;
import org.hibernate.engine.spi.SessionImplementor;
import org.springframework.beans.factory.annotation.Autowired;

import java.util.List;

/** 5.14：shop-service 的落地。 */
class G1Shop extends G1ShopBase {

    @Autowired OrderService service;
    @Autowired OrderRepository orders;

    private void head(String t) { System.out.println("\n═══ " + t + " ═══"); }
    private static String cut(String s) { return s.length() > 150 ? s.substring(0, 150) + "…" : s; }

    private List<String> spy(Runnable body) {
        SqlSpy.start();
        try { body.run(); return SqlSpy.stop(); }
        catch (RuntimeException | Error e) { SqlSpy.stop(); throw e; }
    }

    /** 持久化情境裡有幾個 managed 實體（必須在交易內呼叫）。 */
    private int pc() {
        return em.unwrap(SessionImplementor.class).getPersistenceContext().getNumberOfManagedEntities();
    }

    private long bestMs(Runnable r, int warmup, int rounds) {
        for (int i = 0; i < warmup; i++) r.run();
        long best = Long.MAX_VALUE;
        for (int i = 0; i < rounds; i++) {
            long t0 = System.nanoTime();
            r.run();
            best = Math.min(best, System.nanoTime() - t0);
        }
        return best / 1_000_000;
    }

    // …5.14.4 與 5.14.5 的兩個 @Test
}
```

### 5.14.4 實測：列表頁從 80 個實體變成 0 個

```java
    @Test
    void 列表頁從八十個實體變成零個() {
        seed(200, 50);
        head("5.14.4 列表頁：04 章那一版 vs 05 章這一版（200 張訂單取第一頁 20 筆）");

        int[] sqlA = new int[1], pcA = new int[1];
        int[] sqlB = new int[1], pcB = new int[1];
        List<String> sa = new ArrayList<>(), sb = new ArrayList<>();

        tx.executeWithoutResult(s -> {
            em.clear();
            sa.addAll(spy(() -> service.listAsEntities(OrderStatus.PENDING, 0, 20)));
            sqlA[0] = sa.size(); pcA[0] = pc();
        });
        tx.executeWithoutResult(s -> {
            em.clear();
            sb.addAll(spy(() -> service.list(OrderStatus.PENDING, 0, 20)));
            sqlB[0] = sb.size(); pcB[0] = pc();
        });
        long msA = bestMs(() -> service.listAsEntities(OrderStatus.PENDING, 0, 20), 3, 7);
        long msB = bestMs(() -> service.list(OrderStatus.PENDING, 0, 20), 3, 7);

        System.out.printf("  %-34s %5s %8s %6s%n", "版本", "SQL", "PC實體", "ms");
        System.out.printf("  %-34s %5d %8d %6d%n", "04 章：@EntityGraph + @BatchSize", sqlA[0], pcA[0], msA);
        System.out.printf("  %-34s %5d %8d %6d%n", "05 章：DTO 投影", sqlB[0], pcB[0], msB);

        System.out.println("\n  04 章那一版的 SQL：");
        sa.forEach(x -> System.out.println("    " + cut(x)));
        System.out.println("  05 章這一版的 SQL：");
        sb.forEach(x -> System.out.println("    " + cut(x)));

        var rows = tx.execute(t -> service.list(OrderStatus.PENDING, 0, 20));
        System.out.println("\n  拿到 " + rows.size() + " 筆，第一筆：" + rows.get(0));
        System.out.println("  limit 有效嗎：" + sb.get(0).contains("limit"));
    }
```

```
═══ 5.14.4 列表頁：04 章那一版 vs 05 章這一版（200 張訂單取第一頁 20 筆） ═══
  版本                                   SQL     PC實體     ms
  04 章：@EntityGraph + @BatchSize         3       80      5
  05 章：DTO 投影                            2        0      2

  04 章那一版的 SQL：
    select o1_0.id,o1_0.created_at,o1_0.currency,o1_0.customer_id,c1_0.id,c1_0.created_at,
           c1_0.display_name,c1_0.email,c1_0.version,o1_0.discount_amount,… （27 欄）
    select count(o1_0.id) from orders o1_0 where o1_0.status=?
    select i1_0.order_id,i1_0.id,i1_0.line_amount,i1_0.product_id,i1_0.product_name,i1_0.qty,
           i1_0.unit_price from order_item i1_0 where i1_0.order_id in (…20 個)
  05 章這一版的 SQL：
    select o1_0.id,o1_0.order_no,c1_0.display_name,o1_0.status,o1_0.total_amount,o1_0.placed_at,
           (select count(oi1_0.id) from order_item oi1_0 where oi1_0.order_id=o1_0.id)
      from orders o1_0 join customer c1_0 on … where o1_0.status=? order by o1_0.placed_at desc limit ?,?
    select count(o1_0.id) from orders o1_0 where o1_0.status=?

  拿到 20 筆，第一筆：OrderListRow[id=…, orderNo=SO-2026-000200, customerName=客戶49,
                                status=PENDING, totalAmount=250.0000, placedAt=…, itemCount=2]
  limit 有效嗎：true
```

**三個觀察**：

**① 3 句 → 2 句。** 少掉的那一句是 `@BatchSize` 撈明細的——
**因為投影版根本不需要明細物件，`itemCount` 是一個子查詢算出來的。**

**② 80 個實體 → 0 個。** 這是 04 章那五種解法都沒能改變的數字。

**③ SQL 的欄位數：27 欄 → 7 欄。**
04 章那一版把 `orders` 與 `customer` 的**每一個欄位**都撈回來
（因為 `select o` 的意思就是「這個實體的全部」），
而列表頁只用得到其中 6 個。

> 📌 **注意時間只從 5 ms 變成 2 ms。**
> **這一節的價值不在那 3 ms**，在：
>
> ```
> ① 這一頁的成本【不再隨著實體數成長】——
>    交易結束時沒有 80 份快照要比對（03 章 3.4.7）
> ② 撈回來的東西【就是要顯示的東西】——
>    沒有人可以在 Controller 裡對它多呼叫一個 getter 而打出新的 SQL
> ③ 它可以加 @Transactional(readOnly = true) 之外的東西了：
>    快取、非同步、跨服務傳輸 —— 因為它是一個【值】，不是一個有狀態的實體
> ```

### 5.14.5 實測：五個條件的搜尋 API

```java
    @Test
    void 搜尋api() {
        seed(200, 50);
        head("5.14.5 搜尋 API：五個條件都可以不填");
        tx.executeWithoutResult(s -> {
            System.out.printf("  %-22s → 共 %3d 筆%n", "空條件",
                orders.count(OrderSpecifications.of(OrderSearchCriteria.empty())));
            System.out.printf("  %-22s → 共 %3d 筆%n", "只有狀態",
                orders.count(OrderSpecifications.of(
                    new OrderSearchCriteria(OrderStatus.PENDING, null, null, null, null))));
            System.out.printf("  %-20s → 共 %3d 筆%n", "狀態 + 客戶關鍵字 客戶1",
                orders.count(OrderSpecifications.of(
                    new OrderSearchCriteria(OrderStatus.PENDING, "客戶1", null, null, null))));
            System.out.printf("  %-20s → 共 %3d 筆%n", "再加時間區間",
                orders.count(OrderSpecifications.of(
                    new OrderSearchCriteria(OrderStatus.PENDING, "客戶1",
                        Instant.parse("2026-09-01T00:00:00Z"),
                        Instant.parse("2026-09-01T01:00:00Z"), null))));
            System.out.printf("  %-20s → 共 %3d 筆%n", "再加金額下限 300",
                orders.count(OrderSpecifications.of(
                    new OrderSearchCriteria(OrderStatus.PENDING, "客戶1",
                        Instant.parse("2026-09-01T00:00:00Z"),
                        Instant.parse("2026-09-01T01:00:00Z"), new BigDecimal("300")))));
        });
        tx.executeWithoutResult(s -> {
            var sqls = spy(() -> service.search(
                new OrderSearchCriteria(OrderStatus.PENDING, "客戶1", null, null, null), 0, 5));
            System.out.println("\n  SQL（" + sqls.size() + " 句）：");
            sqls.forEach(x -> System.out.println("    " + cut(x)));
        });
    }
```

```
═══ 5.14.5 搜尋 API：五個條件都可以不填 ═══
  空條件                    → 共 200 筆
  只有狀態                   → 共 200 筆
  狀態 + 客戶關鍵字 客戶1       → 共  44 筆
  再加時間區間               → 共  13 筆
  再加金額下限 300           → 共   0 筆

  SQL（3 句）：
    select o1_0.id,…,c1_0.display_name,… from orders o1_0 join customer c1_0 on …
     where 1=1 and o1_0.status=? and c1_0.display_name like ? escape '!' order by … limit ?,?
    select count(o1_0.id) from orders o1_0 join customer c1_0 on …
     where 1=1 and o1_0.status=? and c1_0.display_name like ? escape '!'
    select i1_0.order_id,… from order_item i1_0 where i1_0.order_id in (?,?,?,?,?)
```

**三個觀察**：

**① 條件是疊加上去的**，200 → 200 → 44 → 13 → 0，
而**只有一個 `of()` 方法**，不是 32 個。

**② `like ? escape '!'` —— 跳脫有效。**

**③ 那 3 句 SQL 是：主查詢 + count + 明細的 `@BatchSize`。**

⚠️ **第三句是 04 章的 `@BatchSize` 在做事**——
因為 `search` 回傳的是 `OrderView`（含明細），所以明細還是要撈。
**這是一個刻意的取捨**：搜尋結果要顯示明細，所以它需要實體。
📌 **如果搜尋結果只要顯示摘要，就該跟 `list()` 一樣改成投影。**

**而第一版的 `search` 打了 8 句**，因為它用了 `orders.findAll(spec, pageable)`——
**沒有 fetch 客戶，於是 `OrderView.of()` 裡的 `getCustomer().getDisplayName()`
打出 5 句額外的 SQL（04 章的 N+1 回來了）。**

修法是 Spring Data 3.x 的 fluent API：

```java
orders.findBy(spec, q -> q.project("customer")     // ★ 等同 @EntityGraph(customer)
                          .sortBy(sort)
                          .page(pageable))
```

⚠️ **實測到的三個 `Specification` 細節**：

| | 結果 |
|---|---|
| `findBy(spec, q -> q.as(OrderListRow.class))`（record DTO） | 🔴 `UnsupportedOperationException: Class-based DTOs are not yet supported.` |
| `findBy(spec, q -> q.as(某個介面))`（介面投影） | ✅ 可以 |
| `findBy(null, …)` | 🔴 `IllegalArgumentException: Specification must not be null`（而 `findAll(null)` 可以） |

📌 **所以「動態條件 + record DTO 投影」在 Spring Data JPA 3.2 上做不到**，
要嘛用介面投影、要嘛用 QueryDSL 的 `Projections.constructor`（5.10.4）、
要嘛自己注入 `EntityManager` 寫 Criteria 的 `cb.construct`（5.9.5）。

### 5.14.6 實測：兩條寫進 CI 的斷言

```java
package com.example.lab.ch05;

import com.example.lab.shop.OrderService;
import com.example.lab.shop.OrderStatus;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/** 5.14.6：把 5.13.3 的 ReadOnlySpy 用在 shop-service 上。 */
class G3ReadOnly extends G1ShopBase {

    @Autowired OrderService service;

    @Test
    void 唯讀用例不准建實體() {
        seed(200, 50);
        System.out.println("\n═══ 5.14.6 ReadOnlySpy：唯讀用例不准建實體 ═══");
        var spy = new ReadOnlySpy(emf);

        var a = spy.watch(() -> service.list(OrderStatus.PENDING, 0, 20));
        System.out.println("  05 章版 list()          → " + a);
        a.assertNoEntities();
        System.out.println("  ✅ assertNoEntities() 通過");

        var b = spy.watch(() -> service.listAsEntities(OrderStatus.PENDING, 0, 20));
        System.out.println("  04 章版 listAsEntities() → " + b);
        try {
            b.assertNoEntities();
            System.out.println("  🔴 沒擋下來");
        } catch (AssertionError e) {
            System.out.println("  ✅ 被擋下來：" + e.getMessage());
        }

        var c = spy.watch(() -> service.view(anyOrderId()));
        System.out.println("\n  明細頁 view()           → " + c);
        c.assertAtMostEntities(10);
        System.out.println("  ✅ assertAtMostEntities(10) 通過"
            + "（明細頁【需要】實體：它要回傳完整的訂單內容）");
    }
}
```

```
═══ 5.14.6 ReadOnlySpy：唯讀用例不准建實體 ═══
  05 章版 list()          → stmt=2  entityLoad=0  collLoad=0
  ✅ assertNoEntities() 通過
  04 章版 listAsEntities() → stmt=3  entityLoad=80  collLoad=20
  ✅ 被擋下來：這個唯讀用例建了 80 個實體（3 句 SQL）。改用 DTO 投影（05 章 5.8），或者說明為什麼需要實體。

  明細頁 view()           → stmt=1  entityLoad=6  collLoad=1
  ✅ assertAtMostEntities(10) 通過（明細頁【需要】實體：它要回傳完整的訂單內容）
```

**注意最後那一格**：**`view()` 建了 6 個實體，而它通過了。**

```
明細頁要回傳一張訂單的完整內容：訂單 + 客戶 + 2 筆明細 + 2 個商品 = 6 個實體
   ↓
它【需要】那些物件。斷言不是「實體越少越好」，是
「這個用例建的實體數，跟它宣稱要做的事情一致嗎」。
```

> 📌 **這一節的四個方法，正好是四種答案**：
>
> | 方法 | 建幾個實體 | 為什麼 |
> |---|---|---|
> | `place` / `pay` / `cancel` | 少數幾個 | **要改資料**，非實體不可 |
> | `view` | 6 個 | 要回傳完整內容，而數量**跟資料量無關**（一張訂單） |
> | `list` | **0 個** | 唯讀、而且**數量跟頁大小成正比** → 投影 |
> | `search` | 一頁份 | 唯讀，而它要顯示明細 → 這是一個**可以再優化**的地方 |

---

## 5.15 常見誤區

**誤區 1：「JPQL 就是 SQL 換個寫法。」**

🔴 5.3.7 那六個差異，每一個都會咬人。最貴的是第四個：
**`o.rep.name` 這個點號是一個 inner join，它會靜默吃掉資料**（5.3.3）。

---

**誤區 2：「查詢的結果筆數就是 SQL 的列數。」**

🔴 5.3.5：`select o … join o.items` 回 10 筆，而 SQL 回 30 列。
**而 `count(o)` 回 30。** 分頁的總筆數就是這樣算錯的（5.7.4：60 vs 30）。

---

**誤區 3：「`count(o)` 要寫成 `count(o.id)`，不然 left join 的 null 會被算成 1。」**

🔴 **這條規則在 Hibernate 6 已經不成立**（5.4.5）：
`count(o)` 被翻成 `count(o.id)`，兩者產生**一模一樣的 SQL**。
✅ **真正要處理的是 Spring Data【自動生成】的那句 count**（5.7.4）。

---

**誤區 4：「用了參數就沒有效能問題。」**

🔴 5.5.3：`in :ids` 的清單長度不同就是不同的 SQL，20 種長度 = 20 種形狀。
✅ 一行 `hibernate.query.in_clause_parameter_padding: true` → 6 種。

---

**誤區 5：「批次 `update` 只是比較快的 `update`。」**

🔴 5.6.2/5.6.3：它繞過持久化情境、繞過 `@Version`、繞過回呼。
**其中 `@Version` 不動這件事會讓樂觀鎖靜默失效**——那是 00 章 0.3.5 那個事故。

---

**誤區 6：「介面投影比較省事，效果跟 DTO 一樣。」**

🔴 5.8.6：**封閉式**投影碰到巢狀關聯會把整個關聯實體撈出來（PC 裡 50 個）；
**開放式**（帶 `@Value` SpEL）的 SQL 跟 `select o` **一模一樣**，PC 裡 150 個。
✅ **要確定「不建實體」，就用建構子表達式 + record。**

---

**誤區 7：「唯讀查詢加 `@Transactional(readOnly = true)` 就夠了。」**

🟡 它省掉了快照與髒檢查（03 章 3.8.3），**而實體還是建出來了**。
5.8.6 那 150 個實體、5.14.4 那 80 個，都是在 `readOnly = true` 之下發生的。
✅ **`readOnly` 省的是「比對」，投影省的是「建立」。**

---

**誤區 8：「Criteria 產生的 SQL 比較乾淨。」**

🔴 5.9.4：`cb.and(空陣列)` 一樣產生 `where 1=1`。
✅ **Criteria 換到的是【Java 這一側】的型別安全與可組合性，不是 SQL。**

---

**誤區 9：「JPA 比 MyBatis 慢。」**

🔴 5.8.10：同一句 JOIN、同一份資料——
**JPA 撈實體 10 ms、JPA 撈投影 2 ms、MyBatis 3 ms。**
✅ **慢的是「實體」，不是「JPA」。**

---

**誤區 10：「原生查詢繞過 Hibernate，所以看不到還沒 flush 的修改。」**

🔴 5.11.4：**原生查詢一樣會觸發 auto-flush**，而且是**無差別的**——
連查一張完全不相干的表都會逼出一次完整的 flush。

---

## 5.16 本章小結

**這一章從一句話開始**：

> **那一頁不需要實體。**

**而它的完整版是**：

```
「查詢」有兩個獨立的問題：
   ① 怎麼把【條件】講清楚  → JPQL / Criteria / QueryDSL / 原生 SQL
   ② 查回來的東西【長什麼樣】 → 實體 / 投影 / tuple

前四章都在解 ①，而 4.9.1 那 650 個實體是 ② 的答案錯了。
```

**六個要記住的數字**：

```
5.3.3   30 張訂單 → 20 列          一個點號，靜默吃掉 10 張
5.5.3   20 種 SQL 形狀 → 6 種       一行組態（in_clause_parameter_padding）
5.6.1   151 句 / 52 ms → 1 句 / 3 ms  批次 update，而它繞過四件事
5.7.4   totalElements 60 → 30      join 集合 + Page，要自己寫 countQuery
5.8.6   150 個實體 → 0 個           建構子表達式；而介面投影是 50 / 150
5.8.10  10 ms → 2 ms               同一句 JOIN，換掉回傳型別（MyBatis 是 3 ms）
```

### 5.16.1 驗收清單

**JPQL**

- [ ] 我可以說出 JPQL 與 SQL 的六個根本差異（5.3.7）
- [ ] 看到 `o.rep.name` 這種路徑，我會先問「那個關聯可以是 null 嗎」（5.3.3）
- [ ] 我知道 `join` 與 `join fetch` 是兩件事，而且 `join` 不會載入集合（5.3.5）
- [ ] 我知道一個查詢的結果筆數可以跟它的 `count` 對不上，以及為什麼（5.3.5）
- [ ] 我分得出哪些語法是 JPQL 規格、哪些是 Hibernate 的 HQL 擴充（5.4.8）

**參數與批次**

- [ ] 我可以說出「用參數」除了防注入以外的第二個理由（5.5.2）
- [ ] 我知道 `in` 子句為什麼是參數化的例外，以及那一行組態（5.5.3）
- [ ] 我可以列出批次 `update` 繞過的四件事，並說出哪一件最危險（5.6.3）
- [ ] 我知道 `@Modifying` 那兩個屬性各自在解什麼（5.6.5）

**Spring Data**

- [ ] 我知道衍生查詢的能力邊界（寫不出 `left join`、方法名會爆炸）（5.7.1）
- [ ] 我知道 `Page` / `Slice` / `List` 差在哪一句 SQL（5.7.3）
- [ ] 我知道什麼時候必須自己寫 `countQuery`（5.7.4）
- [ ] 我知道 `JpaSort.unsafe` 是一個注入點（5.7.6）
- [ ] 我知道哪些查詢定義會在啟動時被驗證、哪些不會（5.7.7）

**投影 ★**

- [ ] 我可以寫出建構子表達式、介面投影、`Tuple` 三種投影
- [ ] 我知道封閉式與開放式介面投影的差別，以及後者為什麼沒有省到（5.8.6）
- [ ] 我知道「DTO 裡要有集合」的兩種做法，以及哪一種可以分頁（5.8.8）
- [ ] 我可以解釋 00 章 0.7 那個「JPA 9 ms、MyBatis 3 ms」真正的變數是什麼（5.8.10）
- [ ] 我知道投影的三個代價（5.8.11）

**動態查詢**

- [ ] 我可以列出「字串拼 JPQL」的五個問題（5.9.1）
- [ ] 我知道 metamodel 是什麼、以及沒有它的 Criteria 少了什麼（5.9.3）
- [ ] 我可以用 `Specification` 寫一個五條件的搜尋，而且處理了 `like` 的跳脫（5.9.6）
- [ ] 我知道 QueryDSL 相對於 Specification 換到了什麼、付出了什麼（5.10.6）

**原生 SQL 與守則**

- [ ] 我知道原生查詢回實體與回 `Object[]` 的差別（5.11.1）
- [ ] 我知道原生查詢會觸發**無差別的** auto-flush（5.11.4）
- [ ] 我可以說出「什麼時候該把這句查詢交給 MyBatis」的判準（5.11.6）
- [ ] 我可以寫出一條「這個唯讀用例不准建實體」的 CI 斷言（5.13.3）

### 5.16.2 本章練習

**練習一（5.3）**：
下面這句 JPQL 回傳的筆數，跟 `select count(o) from Ord5 o join o.notes n` 一樣嗎？

```java
select o from Ord5 o join o.notes n
```

不跑程式先回答，再用 `SqlSpy` 驗證。**接著解釋為什麼**。

---

**練習二（5.3.3）**：
把 `shop-service` 的 `Order` 加一個可為 null 的 `@ManyToOne Coupon coupon`，
然後寫一個「列出所有訂單與它的優惠券代碼（沒有就空白）」的查詢。
**先用路徑表達式寫一次、數筆數，再用 `left join` 寫一次。**

---

**練習三（5.5.3）**：
在你自己的專案上打開 `hibernate.query.in_clause_parameter_padding`，
用 `SqlSpy` 數一支「批次載入」的 API 在開之前與開之後的 SQL 形狀數量。

---

**練習四（5.6）**：
寫一個「把三個月前的 `PENDING` 訂單全部標成 `EXPIRED`」的批次操作。
要求：
- 用一句 JPQL `update`
- `@Version` 要跟著加一（提示：5.6.3 的 ③）
- 交易結束後，持久化情境裡不能有過時的資料
- 寫一個測試證明上面三件事

---

**練習五（5.7.4）**：
找出你專案裡所有回傳 `Page<T>` 而且 `@Query` 裡有 `join` 集合的方法。
**每一個都補上 `countQuery`，並寫一個測試斷言 `totalElements` 等於實際筆數。**

---

**練習六（5.8）** ★：
把 `shop-service` 的**明細頁**（`view`）也改成投影，要求：
- 一句 SQL 或兩句（兩段式）
- `ReadOnlySpy.assertNoEntities()` 通過
- 明細（`lines`）要在 DTO 裡

**做完之後回答**：你覺得這個改動值得嗎？
（提示：比較 5.14.6 那張表的第二列與第三列——
`view` 的實體數**跟資料量無關**，`list` 的**成正比**。）

---

**練習七（5.9 / 5.10）**：
把 5.14 的 `OrderSpecifications` 改寫成 QueryDSL 版本，然後回答：
- 哪一個比較短？
- 哪一個在「加一個新條件」時要改的地方比較少？
- 你的專案值得為此多裝一個 annotation processor 嗎？

---

**練習八（5.13）**：
把 `ReadOnlySpy` 加進你的專案，然後**對每一個唯讀的 Service 方法都下一條斷言**。
**先不要改任何程式碼，只是把現況記錄下來**——
你會得到一張「哪些查詢在建不需要的實體」的清單。

---

## 5.17 下一章預告

**06 章：效能與並行控制。**

這一章把「一次查詢」壓到了 2 ms、0 個實體。**而它有一個沒有被質疑的前提**：

> **這個查詢一秒只跑一次。**

📌 **06 章的第一句話是**：

```
5.8.10 那個 2 ms，乘上每秒 500 次 = 1 秒。
而那一秒裡，資料庫做的是【同一件事 500 次】。
```

**06 章會處理五件事**：

```
① 批次寫入：saveAll() 為什麼不是批次，以及【四件事會讓 batch_size 靜默失效】
   （01 章 1.8.3 已經證明過一件：IDENTITY 主鍵讓批次【完全】失效）
② 二級快取：它跟一級快取的關係、什麼東西適合放、以及它會怎麼騙你
③ 查詢快取：為什麼它預設是關的，而且開了常常更慢
④ 樂觀鎖 @Version：5.6.3 那個「批次 update 不動 version」的完整後果
⑤ 悲觀鎖：什麼時候真的需要它，以及 select … for update 的代價
```

⚠️ **而 06 章會回頭修改這一章的一個東西**：

| 這一章說 | 06 章會補上 |
|---|---|
| 5.6.3：批次 `update` 不動 `@Version`，要用 `update versioned` | **樂觀鎖的完整機制**，以及為什麼「靜默覆蓋」比「拋例外」糟糕得多 |
| 5.8.6：投影不進持久化情境 → 沒有一級快取 | 而它**也不能用二級快取**（那是實體的快取）—— 唯讀報表要快取，得用**查詢快取**或應用層快取 |
| 5.13.3：`ReadOnlySpy` 只看 `entityLoadCount` | 加上 `secondLevelCacheHitCount`：**一個「不建實體」的查詢，也可能是「每次都打資料庫」的查詢** |

📌 **而 07 章開始換一個世界**：

```
05 章結束時，shop-service 的每一個查詢都是 JPA 寫的。
而 00 章 0.8.4 的決定是「報表與列表查詢用 MyBatis」。
   ↓
07 / 08 章要把 MyBatis 學完，
09 章再回來問一次：【看完 5.8.10 那三個數字之後，那個決定還成立嗎？】
```
