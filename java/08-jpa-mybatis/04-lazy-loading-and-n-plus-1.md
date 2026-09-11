# 第 04 章：延遲載入與 N+1

> 00 章 0.3.2 有一段這樣的程式碼：
>
> ```java
> for (Ord4 o : orders.findByStatus(St4.PENDING)) {
>     o.getCustomer().getDisplayName();     // 顯示客戶名
>     o.getItems().size();                  // 顯示明細筆數
> }
> ```
>
> **它打出 251 句 SQL。**
>
> 而那段程式碼裡**沒有任何一個字看起來像資料庫操作**——
> 它是一個迴圈，取兩個屬性。
>
> ---
>
> 00 章只說了「這叫 N+1，04 章會處理」。
> 03 章解釋了機制（代理、一級快取、持久化情境）。
> **這一章把它修好，並且讓它不會再回來。**
>
> ---
>
> 這一章有 **31 個實測**。挑八個先講結果：
>
> - 同一段程式碼、同樣 200 張訂單，**只有客戶數不同** → **204 / 251 / 401 句**
>   （這就是「本機測不出來」的機制）
> - 一個 `new HashSet<>()`，**只有 `add`、沒讀任何欄位** → **51 句 SQL**
>   （而改成用 id 去重 → **1 句**）
> - 把 `LAZY` 改成 `EAGER`：撈一張訂單變 1 句 ✅，撈 200 張**還是 251 句** 🔴
> - `@Basic(fetch = LAZY)` 貼在欄位上——**它沒有生效**
> - 每份教學都叫你寫的 `select distinct`：**Hibernate 6 已經不需要它了**，
>   而它還是會讓資料庫多做一次去重
> - `JOIN FETCH` + 分頁：SQL **沒有 `limit`**。2000 張訂單取第一頁 20 筆 →
>   **107 ms、持久化情境裡 6000 個實體**（正解是 **9 ms、80 個**）
> - `@BatchSize(25)`：**251 句 → 11 句**，而且**分頁還能用**
> - 手動把 400 筆明細撈進一級快取，再跑迴圈 → **還是 200 句**
>
> 📌 **這一章的主線**：
>
> > **N+1 不是一個 bug，是一個【預設值的後果】。**
> > **JPA 的預設是「需要的時候再撈」，而「需要」是在迴圈裡逐一發生的。**
> > **所以解法永遠是同一句話：把「這個用例需要什麼」講清楚，一次撈齊。**
> > **這一章的五種工具，都是「怎麼把那句話講出來」的不同寫法。**

---

## 4.1 學習目標

完成本章後，你應該可以：

- 給出 N+1 的**定義**，並說出它的**四種來源**（4.2.5）。
- 解釋為什麼同一段程式碼的 SQL 句數**會隨資料分布改變**，
  以及這件事為什麼讓 N+1 在開發環境「測不出來」（4.2.4）。
- 說出代理（proxy）是什麼、**哪些呼叫會觸發它初始化、哪些不會**（4.3.2），
  並解釋為什麼「把實體放進 `HashSet`」是一個 N+1（4.3.3）。
- 說明 `@OneToOne` 反向側的 `LAZY` **為什麼**無效（4.3.5），
  以及 `@Basic(fetch = LAZY)` 為什麼在沒有 bytecode enhancement 時無效（4.3.6）。
- 列出 `LazyInitializationException` 的**四種解法**，並說出**其中三種為什麼是錯的**（4.4）。
- 用 `JOIN FETCH` 把 251 句變 1 句，並說出它的**三個代價**：
  笛卡兒積、`MultipleBagFetchException`、**分頁失效**（4.5）。
- 說出 Hibernate 6 對 `distinct` 的行為改變，並知道**現在該不該寫它**（4.5.3）。
- 解釋 `HHH90003004` 這個警告在說什麼，以及**不理它的代價**（4.5.5）。
- 用 `@EntityGraph` 讓**同一個查詢方法**服務不同用例，
  並說出 `fetchgraph` 與 `loadgraph` 的差別（4.6.3）。
- 說明 `@BatchSize` **不消滅** N+1、而是把句數從 `N` 變成 `⌈N/size⌉`，
  並解釋為什麼它在**分頁**場景是最好的解（4.7.6）。
- 面對一個 N+1，用 4.9.3 那張決策表選出**這個場景該用哪一種解法**。
- 寫出一條 CI 斷言，讓「有人加了一行 `o.getNotes().size()`」在**合併前**就被擋下來（4.10）。

---

## 4.2 N+1：先把它量出來

### 4.2.1 一個定義

> **N+1 = 為了取得 N 筆資料的關聯資料，打了 N 句（或更多）額外的 SQL。**

那個「1」是主查詢，那個「N」是關聯。而它的**本質**是：

```
主查詢回來的時候，Hibernate 只知道【外鍵的值】，不知道【外鍵指向的那一列】。
   ↓
它把那個位置放一個【代理】（4.3），並記著「有人要用的時候再去撈」。
   ↓
而「有人要用」在迴圈裡發生了 N 次。
```

⚠️ **注意這個定義裡沒有「幾句 SQL 算太多」這種門檻。**
`1 + 3 = 4` 句和 `1 + 200 = 201` 句是**同一個問題**，
差別只在你的資料量——而資料量會長大。

### 4.2.2 這一章共用的模型與量尺

**表結構**（`ch04` 資料庫。跟 03 章那份幾乎一樣，
多一張 `order_note`（4.5 要用**兩個集合**做笛卡兒積），
`product` 多一個很大的 `spec_text`（4.3.6 要用）：

```sql
CREATE DATABASE ch04 CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE ch04;

CREATE TABLE customer (
  id           binary(16)   NOT NULL,
  email        varchar(255) NOT NULL,
  display_name varchar(64)  NOT NULL,
  PRIMARY KEY (id), UNIQUE KEY uk_customer_email (email)
) ENGINE=InnoDB;

CREATE TABLE product (
  id         binary(16)    NOT NULL,
  sku        varchar(32)   NOT NULL,
  name       varchar(200)  NOT NULL,
  unit_price decimal(19,4) NOT NULL,
  spec_text  mediumtext    NULL,          -- ★ 4.3.6：@Basic(fetch = LAZY) 的實驗對象
  PRIMARY KEY (id), UNIQUE KEY uk_product_sku (sku)
) ENGINE=InnoDB;

CREATE TABLE stock (                       -- ★ 4.3.5：一對一（共用主鍵）
  product_id   binary(16) NOT NULL,
  qty          int NOT NULL DEFAULT 0,
  reserved_qty int NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id),
  CONSTRAINT fk_stock_product FOREIGN KEY (product_id) REFERENCES product(id)
) ENGINE=InnoDB;

CREATE TABLE orders (
  id           binary(16)    NOT NULL,
  order_no     varchar(32)   NOT NULL,
  customer_id  binary(16)    NOT NULL,
  status       varchar(16)   NOT NULL,
  total_amount decimal(19,4) NOT NULL,
  placed_at    datetime(3)   NOT NULL,
  PRIMARY KEY (id), UNIQUE KEY uk_orders_order_no (order_no),
  KEY idx_orders_status_placed (status, placed_at),   -- ★ 分頁要用（07 站 03 章）
  KEY idx_orders_customer (customer_id),
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customer(id)
) ENGINE=InnoDB;

CREATE TABLE order_item (
  id           binary(16)    NOT NULL,
  order_id     binary(16)    NOT NULL,
  product_id   binary(16)    NOT NULL,
  product_name varchar(200)  NOT NULL,
  unit_price   decimal(19,4) NOT NULL,
  qty          int           NOT NULL,
  line_amount  decimal(19,4) NOT NULL,
  PRIMARY KEY (id), KEY idx_order_item_order (order_id),
  KEY fk_order_item_product (product_id),
  CONSTRAINT fk_order_item_orders  FOREIGN KEY (order_id)   REFERENCES orders(id),
  CONSTRAINT fk_order_item_product FOREIGN KEY (product_id) REFERENCES product(id)
) ENGINE=InnoDB;

CREATE TABLE order_note (                  -- ★ 4.5.2：第二個集合
  id       binary(16)   NOT NULL,
  order_id binary(16)   NOT NULL,
  note     varchar(500) NOT NULL,
  PRIMARY KEY (id), KEY idx_order_note_order (order_id),
  CONSTRAINT fk_order_note_orders FOREIGN KEY (order_id) REFERENCES orders(id)
) ENGINE=InnoDB;
```

**實體。** 這一章的實體是**唯讀用的**（沒有業務方法、沒有 cascade），
因為這一章的主題是查詢：

```java
package com.example.lab.ch04;

public enum St4 { PENDING, PAID, PACKED, SHIPPED, DELIVERED, CANCELLED }
```

```java
package com.example.lab.ch04;

import jakarta.persistence.Id;
import jakarta.persistence.MappedSuperclass;
import org.hibernate.Hibernate;
import java.util.UUID;

@MappedSuperclass
public abstract class Base4 {

    @Id private UUID id;

    protected Base4() {}
    protected Base4(UUID id) { this.id = id; }

    public UUID getId() { return id; }

    // ★ 01 章 1.14.4 那個「對代理安全」的寫法。
    //   ⚠️ 4.3.2 會證明它有一個代價：equals 會【初始化代理】。
    @Override public final boolean equals(Object o) {
        if (this == o) return true;
        if (o == null || Hibernate.getClass(this) != Hibernate.getClass(o)) return false;
        UUID mine = getId();
        return mine != null && mine.equals(((Base4) o).getId());
    }
    @Override public final int hashCode() { return Hibernate.getClass(this).hashCode(); }
}
```

```java
package com.example.lab.ch04;

import jakarta.persistence.*;
import java.util.UUID;

@Entity @Table(name = "customer")
public class Cust4 extends Base4 {

    @Column(nullable = false, length = 255) private String email;
    @Column(name = "display_name", nullable = false, length = 64) private String displayName;

    protected Cust4() {}
    public Cust4(UUID id, String email, String displayName) {
        super(id); this.email = email; this.displayName = displayName;
    }
    public String getEmail() { return email; }
    public String getDisplayName() { return displayName; }
}
```

```java
package com.example.lab.ch04;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.util.UUID;

@Entity @Table(name = "product")
public class Prod4 extends Base4 {

    @Column(nullable = false, length = 32)  private String sku;
    @Column(nullable = false, length = 200) private String name;
    @Column(name = "unit_price", nullable = false, precision = 19, scale = 4)
    private BigDecimal unitPrice;

    /** ★ 一個很大的欄位：4.3.6 要測「@Basic(fetch = LAZY) 有沒有效」。 */
    @Basic(fetch = FetchType.LAZY)
    @Column(name = "spec_text") private String specText;

    protected Prod4() {}
    public Prod4(UUID id, String sku, String name, BigDecimal unitPrice) {
        super(id); this.sku = sku; this.name = name; this.unitPrice = unitPrice;
    }
    public String getSku() { return sku; }
    public String getName() { return name; }
    public BigDecimal getUnitPrice() { return unitPrice; }
    public String getSpecText() { return specText; }
}
```

```java
package com.example.lab.ch04;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.util.UUID;

@Entity @Table(name = "order_item")
public class Item4 extends Base4 {

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "order_id", nullable = false) private Ord4 order;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "product_id", nullable = false) private Prod4 product;

    @Column(name = "product_name", nullable = false, length = 200) private String productName;
    @Column(name = "unit_price", nullable = false, precision = 19, scale = 4) private BigDecimal unitPrice;
    @Column(nullable = false) private int qty;
    @Column(name = "line_amount", nullable = false, precision = 19, scale = 4) private BigDecimal lineAmount;

    protected Item4() {}
    public Ord4 getOrder() { return order; }
    public Prod4 getProduct() { return product; }
    public String getProductName() { return productName; }
    public int getQty() { return qty; }
    public BigDecimal getLineAmount() { return lineAmount; }
}
```

```java
package com.example.lab.ch04;

import jakarta.persistence.*;

@Entity @Table(name = "order_note")
public class Note4 extends Base4 {

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "order_id", nullable = false) private Ord4 order;

    @Column(nullable = false, length = 500) private String note;

    protected Note4() {}
    public String getNote() { return note; }
}
```

```java
package com.example.lab.ch04;

import jakarta.persistence.*;
import java.util.UUID;

/** 共用主鍵的一對一（擁有方）。 */
@Entity @Table(name = "stock")
public class Stk4 {

    @Id @Column(name = "product_id") private UUID productId;

    @OneToOne(fetch = FetchType.LAZY, optional = false)
    @MapsId @JoinColumn(name = "product_id")
    private Prod4 product;

    @Column(nullable = false) private int qty;

    protected Stk4() {}
    public Stk4(Prod4 product, int qty) { this.product = product; this.qty = qty; }
    public UUID getProductId() { return productId; }
    public Prod4 getProduct() { return product; }
    public int getQty() { return qty; }
}
```

**主角實體 `Ord4`：三個關聯全部 `LAZY`**，並且預先掛好 4.6 要用的三個具名 graph：

```java
package com.example.lab.ch04;

import jakarta.persistence.*;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/** 04 章的基準訂單：三個關聯全部 LAZY。 */
@Entity @Table(name = "orders")
@NamedEntityGraph(name = "Ord4.withCustomer",
    attributeNodes = @NamedAttributeNode("customer"))
@NamedEntityGraph(name = "Ord4.withCustomerAndItems",
    attributeNodes = { @NamedAttributeNode("customer"), @NamedAttributeNode("items") })
@NamedEntityGraph(name = "Ord4.full",
    attributeNodes = {
        @NamedAttributeNode("customer"),
        @NamedAttributeNode(value = "items", subgraph = "itemWithProduct") },
    subgraphs = @NamedSubgraph(name = "itemWithProduct",
        attributeNodes = @NamedAttributeNode("product")))
public class Ord4 extends Base4 {

    @Column(name = "order_no", nullable = false, length = 32) private String orderNo;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "customer_id", nullable = false) private Cust4 customer;

    @Enumerated(EnumType.STRING) @JdbcTypeCode(SqlTypes.VARCHAR)
    @Column(nullable = false, length = 16) private St4 status;

    @Column(name = "total_amount", nullable = false, precision = 19, scale = 4)
    private BigDecimal totalAmount = BigDecimal.ZERO;
    @Column(name = "placed_at", nullable = false) private Instant placedAt;

    @OneToMany(mappedBy = "order") private List<Item4> items = new ArrayList<>();
    @OneToMany(mappedBy = "order") private List<Note4> notes = new ArrayList<>();

    protected Ord4() {}

    public String getOrderNo() { return orderNo; }
    public Cust4 getCustomer() { return customer; }
    public St4 getStatus() { return status; }
    public BigDecimal getTotalAmount() { return totalAmount; }
    public Instant getPlacedAt() { return placedAt; }
    public List<Item4> getItems() { return items; }
    public List<Note4> getNotes() { return notes; }
}
```

**Repository。** 這一章的每一種解法都是這個介面上的一個方法——
**把它們放在一起看，就是這一章的目錄**：

```java
package com.example.lab.ch04;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.EntityGraph;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.UUID;

public interface Ord4Repo extends JpaRepository<Ord4, UUID> {

    /** ① 天真寫法：什麼都不做（4.2.3） */
    List<Ord4> findByStatus(St4 status);

    /** ② JOIN FETCH（4.5.1） */
    @Query("""
           select distinct o from Ord4 o
             join fetch o.customer
             left join fetch o.items
            where o.status = :st
           """)
    List<Ord4> fetchAll(@Param("st") St4 status);

    /** ②b 兩個 List 一起 fetch（4.5.4：MultipleBagFetchException） */
    @Query("""
           select distinct o from Ord4 o
             left join fetch o.items
             left join fetch o.notes
            where o.status = :st
           """)
    List<Ord4> fetchTwoBags(@Param("st") St4 status);

    /** ②c 沒有 distinct（4.5.3） */
    @Query("select o from Ord4 o left join fetch o.items where o.status = :st")
    List<Ord4> fetchNoDistinct(@Param("st") St4 status);

    /** 🔴 JOIN FETCH + 分頁（4.5.5） */
    @Query("""
           select distinct o from Ord4 o
             left join fetch o.items
            where o.status = :st
           """)
    List<Ord4> fetchPaged(@Param("st") St4 status, Pageable page);

    /** ③ @EntityGraph（4.6） */
    @EntityGraph(attributePaths = {"customer"})
    List<Ord4> findByStatusOrderByPlacedAt(St4 status);

    @EntityGraph(value = "Ord4.withCustomerAndItems")
    List<Ord4> findByStatusOrderByOrderNo(St4 status);

    @EntityGraph(value = "Ord4.full")
    List<Ord4> findByOrderNo(String orderNo);

    /** 🔴 @EntityGraph 含集合 + Pageable（4.6.5） */
    @EntityGraph(attributePaths = {"customer", "items"})
    Page<Ord4> findByStatus(St4 status, Pageable page);

    /** ✅ 兩段式查詢的第一段：只撈 id（4.5.6） */
    @Query("select o.id from Ord4 o where o.status = :st order by o.placedAt")
    List<UUID> pageIds(@Param("st") St4 status, Pageable page);

    /** ✅ 第二段：用 id 清單 join fetch（4.5.6） */
    @Query("""
           select distinct o from Ord4 o
             join fetch o.customer
             left join fetch o.items
            where o.id in :ids
           """)
    List<Ord4> fetchByIds(@Param("ids") List<UUID> ids);
}
```

另外五個 repository，**每個一個檔案**（03 章 3.2.5 那個坑：不要寫成巢狀介面）：

```java
package com.example.lab.ch04;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.UUID;

public interface Cust4Repo extends JpaRepository<Cust4, UUID> {}
```

```java
package com.example.lab.ch04;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.UUID;

public interface Prod4Repo extends JpaRepository<Prod4, UUID> {}
```

```java
package com.example.lab.ch04;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.UUID;

public interface Item4Repo extends JpaRepository<Item4, UUID> {}
```

```java
package com.example.lab.ch04;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.UUID;

public interface Stk4Repo extends JpaRepository<Stk4, UUID> {}
```

```java
package com.example.lab.ch04;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.UUID;

public interface Note4Repo extends JpaRepository<Note4, UUID> {}
```

---

**量尺。** 這一章用**三把**：

| 尺 | 回答的問題 | 哪裡定義的 |
|---|---|---|
| `SqlSpy` | 打了**幾句** SQL、**什麼形狀** | 00 章 0.10.3（03 章 3.2.5 原樣搬過） |
| Hibernate `Statistics` | **為什麼**打了那麼多句 | 03 章 3.10.1 |
| `NPlus1Spy` | 這個用例**有沒有** N+1（一個布林值） | **4.10.2**（這一章新增） |

⚠️ **第二把是這一章的關鍵**，因為 `SqlSpy` 只會告訴你「251 句」，
而你需要知道的是「**這 251 句裡，哪些是 N+1、兇手是哪一個關聯**」。
Hibernate 的統計裡有兩個計數器剛好回答這件事，4.10.1 會完整說明：

```
entityFetchCount     —— 有幾個實體是「代理初始化」時【額外】撈的  → @ManyToOne / @OneToOne 的 N+1
collectionFetchCount —— 有幾個集合是【另外一句 SQL】撈的          → @OneToMany 的 N+1
```

**測試基底類別**（這一章每個實測都繼承它）：

```java
package com.example.lab.ch04;

import com.example.lab.SqlSpy;
import com.example.lab.Uuid7;
import jakarta.persistence.EntityManager;
import jakarta.persistence.EntityManagerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.UUID;

@SpringBootTest(properties = {
  "spring.datasource.url=jdbc:mysql://127.0.0.1:33306/ch04"
      + "?connectionTimeZone=UTC&forceConnectionTimeZoneToSession=true"
      + "&preserveInstants=true&characterEncoding=UTF-8",
  "spring.jpa.properties.hibernate.generate_statistics=true"
})
public abstract class Base04 {

    @Autowired protected Ord4Repo orders;
    @Autowired protected Cust4Repo customers;
    @Autowired protected Prod4Repo products;
    @Autowired protected Item4Repo items;
    @Autowired protected Stk4Repo stocks;
    @Autowired protected EntityManager em;
    @Autowired protected EntityManagerFactory emf;
    @Autowired protected JdbcTemplate jdbc;
    @Autowired protected TransactionTemplate tx;

    protected List<UUID> orderIds = new ArrayList<>();
    protected List<UUID> productIds = new ArrayList<>();
    protected UUID firstOrderId;

    protected void clean() {
        jdbc.update("DELETE FROM order_note");
        jdbc.update("DELETE FROM order_item");
        jdbc.update("DELETE FROM orders");
        jdbc.update("DELETE FROM stock");
        jdbc.update("DELETE FROM product");
        jdbc.update("DELETE FROM customer");
    }

    /**
     * 00 章 0.7 那一頁：orderCount 張訂單、customerCount 個客戶、
     * 每張 itemsPer 筆明細 + notesPer 筆備註。
     * ★ 用 JDBC 批次塞，不經過 JPA —— 免得 seed 本身的 SQL 混進實測數字裡。
     */
    protected void seed(int orderCount, int customerCount, int itemsPer, int notesPer) {
        clean();
        orderIds.clear(); productIds.clear();

        List<UUID> cs = new ArrayList<>();
        List<Object[]> cRows = new ArrayList<>();
        for (int i = 0; i < customerCount; i++) {
            UUID id = Uuid7.next(); cs.add(id);
            cRows.add(new Object[]{Uuid7.toBytes(id), "c" + i + "@x.com", "客戶" + i});
        }
        jdbc.batchUpdate("INSERT INTO customer (id,email,display_name) VALUES (?,?,?)", cRows);

        List<Object[]> pRows = new ArrayList<>(), sRows = new ArrayList<>();
        for (int i = 0; i < 3; i++) {
            UUID id = Uuid7.next(); productIds.add(id);
            pRows.add(new Object[]{Uuid7.toBytes(id), "SKU-" + i, "商品" + i,
                    new java.math.BigDecimal((100 + i * 50) + ".0000"), "規格".repeat(200)});
            sRows.add(new Object[]{Uuid7.toBytes(id), 100 + i});
        }
        jdbc.batchUpdate("INSERT INTO product (id,sku,name,unit_price,spec_text)"
                + " VALUES (?,?,?,?,?)", pRows);
        jdbc.batchUpdate("INSERT INTO stock (product_id,qty) VALUES (?,?)", sRows);

        List<Object[]> oRows = new ArrayList<>(), iRows = new ArrayList<>(), nRows = new ArrayList<>();
        for (int i = 0; i < orderCount; i++) {
            UUID oid = Uuid7.next(); orderIds.add(oid);
            oRows.add(new Object[]{Uuid7.toBytes(oid), String.format("SO-2026-%06d", i + 1),
                    Uuid7.toBytes(cs.get(i % customerCount)), "PENDING",
                    new java.math.BigDecimal("250.0000"),
                    java.sql.Timestamp.from(
                        java.time.Instant.parse("2026-09-01T00:00:00Z").plusSeconds(i))});
            for (int k = 0; k < itemsPer; k++) {
                iRows.add(new Object[]{Uuid7.toBytes(Uuid7.next()), Uuid7.toBytes(oid),
                        Uuid7.toBytes(productIds.get(k % 3)), "商品" + (k % 3),
                        new java.math.BigDecimal("100.0000"), 1,
                        new java.math.BigDecimal("100.0000")});
            }
            for (int k = 0; k < notesPer; k++) {
                nRows.add(new Object[]{Uuid7.toBytes(Uuid7.next()), Uuid7.toBytes(oid),
                        "備註 " + k + " / 訂單 " + i});
            }
        }
        jdbc.batchUpdate("INSERT INTO orders"
                + " (id,order_no,customer_id,status,total_amount,placed_at)"
                + " VALUES (?,?,?,?,?,?)", oRows);
        jdbc.batchUpdate("INSERT INTO order_item"
                + " (id,order_id,product_id,product_name,unit_price,qty,line_amount)"
                + " VALUES (?,?,?,?,?,?,?)", iRows);
        if (!nRows.isEmpty())
            jdbc.batchUpdate("INSERT INTO order_note (id,order_id,note) VALUES (?,?,?)", nRows);
        firstOrderId = orderIds.get(0);
    }

    /** 00 章 0.7 的那一頁：200 張訂單、50 個客戶、每張 2 筆明細。 */
    protected void seedPage() { seed(200, 50, 2, 0); }

    protected void head(String t) { System.out.println("\n═══ " + t + " ═══"); }

    protected List<String> spy(Runnable body) {
        SqlSpy.start();
        try {
            body.run();
            return SqlSpy.stop();
        } catch (RuntimeException | Error e) {
            SqlSpy.stop();
            throw e;                 // ★ 不要在 finally 裡 return（03 章 3.2.5）
        }
    }

    /** 只印出「不同形狀」的 SQL 與次數。 */
    protected void grouped(String title, List<String> sqls) {
        LinkedHashMap<String, Integer> m = new LinkedHashMap<>();
        for (String s : sqls) m.merge(s, 1, Integer::sum);
        System.out.println("── " + title + " → 共 " + sqls.size() + " 句，" + m.size() + " 種形狀");
        m.forEach((k, v) -> System.out.println("   ×" + v + "  " + cut(k)));
    }

    protected static String cut(String s) {
        return s.length() > 132 ? s.substring(0, 132) + "…" : s;
    }

    /** Hibernate 統計（03 章 3.10 的 PcSpy，這裡多印兩個 fetch 計數器）。 */
    protected Stats stats() { return new Stats(emf); }

    protected static class Stats {
        private final org.hibernate.stat.Statistics s;
        Stats(EntityManagerFactory emf) {
            s = emf.unwrap(org.hibernate.SessionFactory.class).getStatistics();
        }
        public void reset() { s.clear(); }
        public String summary() {
            return String.format("stmt=%d  entityLoad=%d  entityFetch=%d  collLoad=%d  collFetch=%d",
                s.getPrepareStatementCount(), s.getEntityLoadCount(), s.getEntityFetchCount(),
                s.getCollectionLoadCount(), s.getCollectionFetchCount());
        }
        public long stmt() { return s.getPrepareStatementCount(); }
        public long collLoad() { return s.getCollectionLoadCount(); }
        public long entityFetch() { return s.getEntityFetchCount(); }
        public long entityLoad() { return s.getEntityLoadCount(); }
    }

    /** 暖機 warmup 次、再取 rounds 次裡最快的一次（跟 00 章 0.7 同一個做法）。 */
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

⚠️ **一個會讓你以為「測試都過了」的陷阱**：
這一章（以及 00～03 章）的測試類別叫 `C1NPlus1`、`A2Cache`、`D1Shop`……
而 **Maven Surefire 預設只跑名字符合 `Test*` / `*Test` / `*Tests` / `*TestCase` 的類別**。

```
mvn test          → 【0 個測試】，而且 BUILD SUCCESS，不會有任何警告 🔴
```

**兩個解法，選一個**：

```bash
# ① 每次明確指定（本課實測時用的方式）
mvn -Dtest='C1NPlus1' test
mvn -Dtest='A*,B*,C*,D*' -Dsurefire.failIfNoSpecifiedTests=false test
```

```xml
<!-- ② 或者在 pom.xml 裡放寬 include（自己的專案建議這樣做） -->
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-surefire-plugin</artifactId>
  <configuration>
    <includes><include>**/*.java</include></includes>
  </configuration>
</plugin>
```

📌 **這個陷阱值得單獨提出來，因為它的形狀跟這一章的主題一樣**：
**「沒有錯誤訊息」不等於「沒有問題」。**
`mvn test` 跑了 0 個測試，回報的是 `BUILD SUCCESS`。

---

### 4.2.3 實測：重現 00 章那 251 句

```java
package com.example.lab.ch04;

import org.junit.jupiter.api.Test;

class C1NPlus1 extends Base04 {

    @Test
    void 重現00章的251句() {
        seedPage();                                   // 200 張訂單、50 個客戶、每張 2 筆明細
        head("① JPA 天真寫法：200 張訂單的列表頁");
        var st = stats(); st.reset();
        var sqls = spy(() -> tx.executeWithoutResult(s -> {
            for (Ord4 o : orders.findByStatus(St4.PENDING)) {
                o.getCustomer().getDisplayName();     // 顯示客戶名
                o.getItems().size();                  // 顯示明細筆數
            }
        }));
        grouped("JPA 天真寫法", sqls);
        System.out.println("   PcSpy : " + st.summary());
    }
}
```

```
═══ ① JPA 天真寫法：200 張訂單的列表頁 ═══
── JPA 天真寫法 → 共 251 句，3 種形狀
   ×1    select o1_0.id,o1_0.customer_id,o1_0.order_no,o1_0.placed_at,o1_0.status,
           o1_0.total_amount from orders o1_0 where o1_0.status=?
   ×50   select c1_0.id,c1_0.display_name,c1_0.email from customer c1_0 where c1_0.id=?
   ×200  select i1_0.order_id,i1_0.id,i1_0.line_amount,i1_0.product_id,i1_0.product_name,
           i1_0.qty,i1_0.unit_price from order_item i1_0 where i1_0.order_id=?
   PcSpy : stmt=251  entityLoad=650  entityFetch=50  collLoad=200  collFetch=200
```

**`1 + 50 + 200 = 251`**，跟 00 章 0.7 一字不差。

⚠️ **注意那個 `50`**：200 張訂單，但客戶只查了 50 次——
因為這批資料只有 50 個客戶，而**同一個持久化情境裡同一個 id 只會查一次**（03 章 3.3.1）。

**而 `PcSpy` 那一行才是這一章真正要用的東西**：

```
entityFetch = 50    ← 有 50 個實體是「代理初始化」時額外撈的  → @ManyToOne 的 N+1
collFetch   = 200   ← 有 200 個集合是另外一句 SQL 撈的        → @OneToMany 的 N+1
                    ─────
                      250 = 251 - 1（主查詢）
```

📌 **`entityFetch + collectionFetch` 就是「N+1 的分數」**，
4.10 會把它變成一條 CI 斷言。

### 4.2.4 實測：句數取決於資料分布 ★★

```java
    @Test
    void 句數取決於資料分布() {
        head("同一段程式碼、同樣 200 張訂單，只有【客戶數】不同");
        for (int customers : new int[]{3, 50, 200}) {
            seed(200, customers, 2, 0);
            var st = stats(); st.reset();
            var sqls = spy(() -> tx.executeWithoutResult(s -> {
                for (Ord4 o : orders.findByStatus(St4.PENDING)) {
                    o.getCustomer().getDisplayName();
                    o.getItems().size();
                }
            }));
            System.out.printf("  %3d 個客戶 → %3d 句 SQL   (%s)%n",
                    customers, sqls.size(), st.summary());
        }
    }
```

```
═══ 同一段程式碼、同樣 200 張訂單，只有【客戶數】不同 ═══
    3 個客戶 → 204 句 SQL   (stmt=204  entityLoad=603  entityFetch=3    collLoad=200  collFetch=200)
   50 個客戶 → 251 句 SQL   (stmt=251  entityLoad=650  entityFetch=50   collLoad=200  collFetch=200)
  200 個客戶 → 401 句 SQL   (stmt=401  entityLoad=800  entityFetch=200  collLoad=200  collFetch=200)
```

🔴🔴 **同一段程式碼，句數從 204 到 401，差了將近兩倍。程式碼一個字都沒改。**

> ⚠️⚠️ **這是「N+1 為什麼在開發環境測不出來」最重要的一個機制。**
>
> ```
> 你在本機用【3 個客戶】的測試資料 → 204 句，而且很快（資料只有一點）
> 正式環境【3 萬個客戶】           → 401 句，而且每一句都要走網路 + 磁碟
> ```
>
> 而更糟的是：**這個差異不是線性的，它取決於「一頁裡有幾個不同的客戶」**——
> 那是一個**業務資料的性質**，不是你控制得了的東西。
>
> 📌 **所以「在測試環境量一下 SQL 句數」是不夠的。**
> 你需要的是一個**跟資料量無關的斷言**：
> **「這個用例的 `entityFetch + collectionFetch` 必須是 0」**（4.10）。
> 那一條在 3 個客戶和 3 萬個客戶下**都會抓到**。

⚠️ **注意 `collFetch` 那一欄一直是 200**：集合的那 200 句**跟資料分布無關**，
因為每張訂單都有自己的明細集合，沒有「共用」的機會。

**這給了一個很實用的診斷順序**：

```
entityFetch 隨資料分布變動 → 兇手是 @ManyToOne / @OneToOne（去重效果來自一級快取）
collFetch   等於根實體筆數 → 兇手是集合（一定是 1:1 對應，沒有去重的可能）
```

### 4.2.5 實測：N+1 的四種來源

```java
    @Test
    void N加1的四種來源() {
        seed(20, 20, 2, 1);
        head("來源一：@ManyToOne（訂單 → 客戶）");
        var a = spy(() -> tx.executeWithoutResult(s ->
            orders.findByStatus(St4.PENDING).forEach(o -> o.getCustomer().getDisplayName())));
        System.out.println("  → " + a.size() + " 句");

        head("來源二：@OneToMany（訂單 → 明細）");
        var b = spy(() -> tx.executeWithoutResult(s ->
            orders.findByStatus(St4.PENDING).forEach(o -> o.getItems().size())));
        System.out.println("  → " + b.size() + " 句");

        head("來源三：@OneToOne（商品 → 庫存，共用主鍵）");
        var c = spy(() -> tx.executeWithoutResult(s ->
            stocks.findAll().forEach(k -> k.getProduct().getName())));
        System.out.println("  → " + c.size() + " 句（3 個商品）");

        head("來源四：兩層關聯（訂單 → 明細 → 商品）");
        var d = spy(() -> tx.executeWithoutResult(s ->
            orders.findByStatus(St4.PENDING).forEach(o ->
                o.getItems().forEach(i -> i.getProduct().getName()))));
        grouped("兩層", d);
    }
```

```
═══ 來源一：@ManyToOne（訂單 → 客戶） ═══
  → 21 句
═══ 來源二：@OneToMany（訂單 → 明細） ═══
  → 21 句
═══ 來源三：@OneToOne（商品 → 庫存，共用主鍵） ═══
  → 4 句（3 個商品）
═══ 來源四：兩層關聯（訂單 → 明細 → 商品） ═══
── 兩層 → 共 23 句，3 種形狀
   ×1   select o1_0.id,… from orders o1_0 where o1_0.status=?
   ×20  select i1_0.order_id,… from order_item i1_0 where i1_0.order_id=?
   ×2   select p1_0.id,p1_0.name,p1_0.sku,p1_0.spec_text,p1_0.unit_price
          from product p1_0 where p1_0.id=?
```

**四種來源，同一個形狀**：

| 來源 | 觸發的那一行 | 句數 |
|---|---|---|
| `@ManyToOne` | `o.getCustomer().getDisplayName()` | `1 + 不同客戶數` |
| `@OneToMany` | `o.getItems().size()` | `1 + 訂單數` |
| `@OneToOne` | `stock.getProduct().getName()` | `1 + 不同商品數` |
| **兩層關聯** | `o.getItems().forEach(i -> i.getProduct()…)` | `1 + N + M` |

⚠️ **來源四值得停一下**：它是 `1 + 20 + 2 = 23`。
那個 `2` 很小，因為這批資料只用了 2 個不同商品。
**換成一個真實的訂單系統（每張訂單的商品都不一樣），它會是 `1 + 20 + 40`。**

📌 **而「兩層」是 N+1 最常被漏掉的形狀**，因為你可能已經
`join fetch o.items` 修好了第一層，**然後在 DTO 轉換裡讀了 `i.getProduct().getName()`**——
第二層又長出來了。4.6.4 的 subgraph 就是為了這個。

### 4.2.6 為什麼「看程式碼」看不出來

回頭看那段程式碼：

```java
for (Ord4 o : orders.findByStatus(St4.PENDING)) {
    o.getCustomer().getDisplayName();
    o.getItems().size();
}
```

**這裡面有幾個「看起來會打 SQL」的東西？**

```
orders.findByStatus(...)     ← 1 個。它叫 repository，很明顯

o.getCustomer()              ← 0 個。它是一個 getter
      .getDisplayName()      ← 0 個。它是一個 getter
o.getItems()                 ← 0 個。它是一個 getter
      .size()                ← 0 個。它是 List 的方法
```

> 🔴 **250 句 SQL 藏在四個「看起來是 getter 的東西」裡。**
>
> 而它們**真的是 getter**——`Ord4.getCustomer()` 就是 `return customer;`，
> 一行、沒有任何魔法。
>
> **魔法在 `customer` 這個欄位裡放的那個物件上。**

**下一節就是講那個物件。**

---

## 4.3 代理：那個 getter 為什麼會打 SQL ★★

### 4.3.1 實測：`o.getCustomer()` 拿到的是什麼

```java
package com.example.lab.ch04;

import org.hibernate.Hibernate;
import org.hibernate.proxy.HibernateProxy;
import org.junit.jupiter.api.Test;

class C2Proxy extends Base04 {

    @Test
    void 實體的代理() {
        seed(1, 1, 2, 0);
        head("o.getCustomer() 拿到的是什麼");
        tx.executeWithoutResult(s -> {
            Ord4 o = orders.findById(firstOrderId).orElseThrow();
            Cust4 c = o.getCustomer();
            System.out.println("  宣告型別      : Cust4");
            System.out.println("  執行期類別    : " + c.getClass().getName());
            System.out.println("  是 HibernateProxy 嗎 : " + (c instanceof HibernateProxy));
            System.out.println("  instanceof Cust4     : " + (c instanceof Cust4));
            System.out.println("  getClass() == Cust4  : " + (c.getClass() == Cust4.class));
        });
    }
}
```

```
═══ o.getCustomer() 拿到的是什麼 ═══
  宣告型別      : Cust4
  執行期類別    : com.example.lab.ch04.Cust4$HibernateProxy$zicWG5xR
  是 HibernateProxy 嗎 : true
  instanceof Cust4     : true
  getClass() == Cust4  : false
```

**它是一個執行期產生的 `Cust4` 子類別**，由 ByteBuddy 生成，
每個方法都被攔截成「如果還沒載入，先去資料庫撈，再轉呼叫真身」。

```
你的 Ord4 物件
  customer ──► Cust4$HibernateProxy$zicWG5xR
                 ├─ id = 01a07a93-…            ← 這個它【知道】（外鍵的值）
                 ├─ email = null               ← 其他欄位【都是 null】
                 ├─ displayName = null
                 └─ $$_hibernate_interceptor   ← 攔截器：第一次有人呼叫方法時去撈
```

⚠️ **注意 `getClass() == Cust4.class` 是 `false`**。這有兩個實際後果：

```
🔴 用 getClass() 比型別的 equals 會壞掉（01 章 1.14.3 那個實測）
🔴 一個代理物件【自己的欄位永遠是 null】——只有 getter 會被攔截
      → 所以 equals 裡不能寫 ((Cust4) o).displayName，要寫 ((Cust4) o).getDisplayName()
```

（這兩點 01 章 1.14 已經用實測處理過，這裡只是給它一個機制上的解釋。）

### 4.3.2 實測：哪些呼叫會觸發初始化 ★★

```java
    @Test
    void 哪些呼叫不會觸發初始化() {
        head("對一個未初始化的代理做各種事，哪些會打 SQL");
        String[] names = {"getId()", "equals(自己)", "equals(別人)", "hashCode()",
                          "toString()", "instanceof Cust4", "Hibernate.getClass()",
                          "Hibernate.unproxy()", "getDisplayName()"};
        for (String what : names) {
            seed(1, 1, 2, 0);
            tx.executeWithoutResult(s -> {
                Cust4 c = orders.findById(firstOrderId).orElseThrow().getCustomer();
                var sqls = spy(() -> {
                    switch (what) {
                        case "getId()"              -> c.getId();
                        case "equals(自己)"          -> c.equals(c);
                        case "equals(別人)"          -> c.equals(new Cust4(
                                java.util.UUID.randomUUID(), "x@x.com", "別人"));
                        case "hashCode()"           -> c.hashCode();
                        case "toString()"           -> c.toString();
                        case "instanceof Cust4"     -> { boolean b = c instanceof Cust4; }
                        case "Hibernate.getClass()" -> Hibernate.getClass(c);
                        case "Hibernate.unproxy()"  -> Hibernate.unproxy(c);
                        default                     -> c.getDisplayName();
                    }
                });
                System.out.printf("  %-20s → %d 句 SQL，初始化=%s%n",
                        what, sqls.size(), Hibernate.isInitialized(c));
            });
        }
    }
```

```
═══ 對一個未初始化的代理做各種事，哪些會打 SQL ═══
  getId()              → 0 句 SQL，初始化=false
  equals(自己)          → 0 句 SQL，初始化=false
  equals(別人)          → 1 句 SQL，初始化=true      ← 🔴
  hashCode()           → 1 句 SQL，初始化=true      ← 🔴
  toString()           → 1 句 SQL，初始化=true
  instanceof Cust4     → 0 句 SQL，初始化=false
  Hibernate.getClass() → 1 句 SQL，初始化=true      ← 🔴
  Hibernate.unproxy()  → 1 句 SQL，初始化=true
  getDisplayName()     → 1 句 SQL，初始化=true
```

**`getId()` 不會觸發，這是唯一的例外**——因為代理**已經知道** id（那就是外鍵的值）。

📌 **這一條有一個很實用的用途**（02 章 2.11.5 提過，這裡是它的根據）：

```java
// ✅ 只要外鍵值 → 0 句 SQL
UUID customerId = order.getCustomer().getId();

// 🔴 要客戶名字 → 1 句 SQL
String name = order.getCustomer().getDisplayName();
```

🔴🔴 **而 `hashCode()`、`equals(別人)`、`Hibernate.getClass()` 都會觸發，這是意外的。**

**原因在我們自己的 `Base4`（也就是 01 章 1.14.4 那個「對代理安全」的寫法）**：

```java
@Override public final boolean equals(Object o) {
    if (this == o) return true;                                  // ← equals(自己) 在這裡就回去了
    if (o == null || Hibernate.getClass(this) != Hibernate.getClass(o)) return false;
    //               ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲ 這一行會初始化代理
    …
}
@Override public final int hashCode() { return Hibernate.getClass(this).hashCode(); }
//                                             ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲ 這裡也會
```

**為什麼 `Hibernate.getClass()` 會初始化**：它的實作是
「如果是代理，就去拿**真身**的類別」——而「拿真身」就是初始化。

> 📌 **這是一個「兩個正確的決定撞在一起」的例子**：
>
> ```
> 01 章 1.14.4 選 Hibernate.getClass()  → 為了讓 a.equals(b) == b.equals(a)（對稱性）
> 04 章發現它的代價                      → equals / hashCode 會觸發載入
> ```
>
> **兩個都是對的，而你需要知道它們相加的結果。**
> 下一節就是那個結果。

### 4.3.3 實測：一個 `HashSet` 就能打出 51 句 ★★

```java
package com.example.lab.ch04;

import org.junit.jupiter.api.Test;

import java.util.HashSet;
import java.util.stream.Collectors;

class C3EqualsNPlus1 extends Base04 {

    @Test
    void 把代理丟進HashSet() {
        seed(200, 50, 2, 0);
        head("🔴 只是想「去重複」：把 200 張訂單的客戶收進一個 HashSet");
        var st = stats(); st.reset();
        var sqls = spy(() -> tx.executeWithoutResult(s -> {
            var set = new HashSet<Cust4>();
            for (Ord4 o : orders.findByStatus(St4.PENDING)) {
                set.add(o.getCustomer());          // 只有 add，沒有讀任何欄位
            }
            System.out.println("  set.size() = " + set.size());
        }));
        grouped("HashSet 版", sqls);
        System.out.println("   PcSpy : " + st.summary());
    }

    @Test
    void 改成用id去重() {
        seed(200, 50, 2, 0);
        head("✅ 改成用 id 去重（getId() 不觸發初始化）");
        var sqls = spy(() -> tx.executeWithoutResult(s -> {
            var ids = orders.findByStatus(St4.PENDING).stream()
                    .map(o -> o.getCustomer().getId())
                    .collect(Collectors.toSet());
            System.out.println("  ids.size() = " + ids.size());
        }));
        grouped("id 去重版", sqls);
    }
}
```

```
═══ 🔴 只是想「去重複」：把 200 張訂單的客戶收進一個 HashSet ═══
  set.size() = 50
── HashSet 版 → 共 51 句，2 種形狀
   ×1   select o1_0.id,… from orders o1_0 where o1_0.status=?
   ×50  select c1_0.id,c1_0.display_name,c1_0.email from customer c1_0 where c1_0.id=?
   PcSpy : stmt=51  entityLoad=250  entityFetch=50  collLoad=0  collFetch=0

═══ ✅ 改成用 id 去重（getId() 不觸發初始化） ═══
  ids.size() = 50
── id 去重版 → 共 1 句，1 種形狀
   ×1   select o1_0.id,… from orders o1_0 where o1_0.status=?
```

🔴🔴 **`set.add(o.getCustomer())` —— 只有 `add`，一個欄位都沒讀 —— 51 句 SQL。**

**因為 `HashSet.add` 要算 `hashCode()`，而 `hashCode()` 會初始化代理。**

⚠️ **這一節要強調的不是「不要用 HashSet」，而是**：

> **N+1 可以由任何「不小心呼叫了代理的方法」的程式碼造成，
> 而那些程式碼看起來跟資料庫毫無關係。**

**同一個形狀的其他寫法**（都會觸發）：

```java
list.contains(order.getCustomer())          // 呼叫 equals
new HashSet<>(customers)                    // 呼叫 hashCode
customers.stream().distinct().toList()      // 呼叫 equals / hashCode
Map<Cust4, X> map; map.get(proxy);          // 呼叫 hashCode
log.debug("客戶：{}", order.getCustomer())   // 呼叫 toString ★★
assertEquals(expected, order.getCustomer()) // 呼叫 equals
```

🔴 **`log.debug(...)` 那一行特別值得記**：即使日誌等級設成 INFO、
那句話**不會被印出來**，`{}` 的參數還是會被**傳進去**——
而某些日誌框架的實作會在判斷等級之前就 `toString()`。

📌 **實務規則**：

```
✅ 要「識別」一個關聯實體 → 用 getId()
✅ 要 log → log 的是 id，不是實體
✅ 要放進集合去重 → 放 id
🔴 不要把延遲載入的實體放進 Set / Map 的 key / 拿去 contains
```

### 4.3.4 實測：集合的代理是另一種東西

```java
    @Test
    void 集合的代理() {
        seed(1, 1, 3, 0);
        head("o.getItems() 拿到的是什麼");
        tx.executeWithoutResult(s -> {
            Ord4 o = orders.findById(firstOrderId).orElseThrow();
            var list = o.getItems();
            System.out.println("  宣告型別          : List<Item4>");
            System.out.println("  執行期類別        : " + list.getClass().getName());
            System.out.println("  是 PersistentCollection 嗎 : "
                    + (list instanceof org.hibernate.collection.spi.PersistentCollection));
            System.out.println("  是 HibernateProxy 嗎       : "
                    + (list instanceof org.hibernate.proxy.HibernateProxy));
            System.out.println("  初始化了嗎        : " + Hibernate.isInitialized(list));
            System.out.println("  list == null ?    : " + (list == null));

            var a = spy(() -> { boolean b = list.isEmpty(); });
            System.out.println("  isEmpty()  → " + a.size() + " 句、初始化="
                    + Hibernate.isInitialized(list));
        });

        head("Hibernate.size()：不初始化也能知道筆數");
        tx.executeWithoutResult(s -> {
            Ord4 o = orders.findById(firstOrderId).orElseThrow();
            var b = spy(() -> System.out.println("  Hibernate.size() = "
                    + Hibernate.size(o.getItems())));
            System.out.println("  → " + b.size() + " 句 SQL，初始化="
                    + Hibernate.isInitialized(o.getItems()));
            grouped("那一句是什麼", b);
        });
    }
```

```
═══ o.getItems() 拿到的是什麼 ═══
  宣告型別          : List<Item4>
  執行期類別        : org.hibernate.collection.spi.PersistentBag
  是 PersistentCollection 嗎 : true
  是 HibernateProxy 嗎       : false
  初始化了嗎        : false
  list == null ?    : false
  isEmpty()  → 1 句、初始化=true

═══ Hibernate.size()：不初始化也能知道筆數 ═══
  Hibernate.size() = 3
  → 1 句 SQL，初始化=false
── 那一句是什麼 → 共 1 句，1 種形狀
   ×1  select count(id) from order_item where order_id=?
```

**集合的代理是「另一個 `List` 實作」，不是子類別。**

| | 實體代理 | 集合代理 |
|---|---|---|
| 是什麼 | `Cust4` 的**動態子類別** | `PersistentBag`（Hibernate 自己的 `List` 實作） |
| `instanceof HibernateProxy` | `true` | **`false`** |
| 未初始化時 | 可以取 `getId()` | **沒有任何方法可以安全呼叫**（除了 `Hibernate.size()`） |
| 未初始化時是 null 嗎 | 不是 | **不是**（所以 `if (items != null)` 完全無用） |

⚠️ **`Hibernate.size()` 是一個很少人知道的好東西**：
它產生 `select count(id) …`，**不把集合載入記憶體**。

```java
// 🔴 只是要顯示「明細筆數」，卻把 200 筆明細全部變成物件
int n = order.getItems().size();

// ✅ 一句 count，集合維持未初始化
int n = Hibernate.size(order.getItems());
```

📌 **但注意它還是 `1 + N` 句**（每張訂單一句 count）。
它解決的是**記憶體**，不是 N+1。要解 N+1 還是得靠 4.5 起的工具。

### 4.3.5 實測：`@OneToOne` 反向側的 `LAZY` 為什麼無效

02 章 2.7.3 測到了這個現象，但沒有解釋原因。現在可以了。

**先看擁有方**（`Stk4.product`，有 `@MapsId`）：

```java
    @Test
    void OneToOne擁有方() {
        seed(1, 1, 2, 0);
        head("擁有方（Stk4 → Prod4，@MapsId）：LAZY 有效嗎");
        tx.executeWithoutResult(s -> {
            var sqls = spy(() -> {
                var k = stocks.findById(productIds.get(0)).orElseThrow();
                System.out.println("  k.getProduct() 是 : "
                    + (k.getProduct() instanceof org.hibernate.proxy.HibernateProxy
                       ? "代理（初始化=" + Hibernate.isInitialized(k.getProduct()) + "）"
                       : "真的實體"));
            });
            grouped("撈一個 Stk4", sqls);
        });
    }
```

```
═══ 擁有方（Stk4 → Prod4，@MapsId）：LAZY 有效嗎 ═══
  k.getProduct() 是 : 代理（初始化=false）
── 撈一個 Stk4 → 共 1 句，1 種形狀
   ×1  select s1_0.product_id,s1_0.qty from stock s1_0 where s1_0.product_id=?
```

✅ **擁有方的 `LAZY` 完全有效**：1 句 SQL，`product` 是未初始化的代理。

**再看反向側。** 需要一組平行的實體（同一張表，但把關聯做成雙向）：

```java
package com.example.lab.ch04;

import jakarta.persistence.*;
import java.math.BigDecimal;

/** 跟 Prod4 同一張表，但多了【反向側】的 stock（4.3.5：這一側的 LAZY 無效）。 */
@Entity @Table(name = "product")
public class Prod4Bi extends Base4 {

    @Column(nullable = false, length = 32)  private String sku;
    @Column(nullable = false, length = 200) private String name;
    @Column(name = "unit_price", nullable = false, precision = 19, scale = 4)
    private BigDecimal unitPrice;

    /** ★ 反向側（mappedBy）。寫了 LAZY，而它【不會】生效。 */
    @OneToOne(mappedBy = "product", fetch = FetchType.LAZY)
    private Stk4Bi stock;

    protected Prod4Bi() {}
    public String getName() { return name; }
    public Stk4Bi getStock() { return stock; }
}
```

```java
package com.example.lab.ch04;

import jakarta.persistence.*;
import java.util.UUID;

/** 跟 Stk4 同一張表；配 Prod4Bi 做「雙向一對一」的實驗（4.3.5）。 */
@Entity @Table(name = "stock")
public class Stk4Bi {

    @Id @Column(name = "product_id") private UUID productId;

    @OneToOne(fetch = FetchType.LAZY, optional = false)
    @MapsId @JoinColumn(name = "product_id")
    private Prod4Bi product;

    @Column(nullable = false) private int qty;

    protected Stk4Bi() {}
    public Prod4Bi getProduct() { return product; }
    public int getQty() { return qty; }
}
```

```java
package com.example.lab.ch04;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.UUID;

public interface Prod4BiRepo extends JpaRepository<Prod4Bi, UUID> {}
```

```java
    @org.springframework.beans.factory.annotation.Autowired Prod4BiRepo biProducts;

    @Test
    void 反向側的一對一() {
        seed(1, 1, 2, 0);
        head("反向側（Prod4Bi.stock，mappedBy）：寫了 LAZY，有效嗎");
        tx.executeWithoutResult(s -> {
            var sqls = spy(() -> {
                var p = biProducts.findById(productIds.get(0)).orElseThrow();
                System.out.println("  p.getStock() 是 : "
                    + (p.getStock() == null ? "null"
                       : (p.getStock() instanceof org.hibernate.proxy.HibernateProxy
                          ? "代理（初始化=" + Hibernate.isInitialized(p.getStock()) + "）"
                          : "真的實體 —— 🔴 LAZY 沒有生效")));
            });
            grouped("撈一個 Prod4Bi", sqls);
        });
    }
```

```
═══ 反向側（Prod4Bi.stock，mappedBy）：寫了 LAZY，有效嗎 ═══
  p.getStock() 是 : 真的實體 —— 🔴 LAZY 沒有生效
── 撈一個 Prod4Bi → 共 2 句，2 種形狀
   ×1  select pb1_0.id,pb1_0.name,pb1_0.sku,pb1_0.unit_price from product pb1_0 where pb1_0.id=?
   ×1  select sb1_0.product_id,sb1_0.qty from stock sb1_0 where sb1_0.product_id=?
```

🔴 **2 句 SQL，而且拿到的是真的實體。`fetch = LAZY` 被完全忽略。**

**為什麼——關鍵在「誰手上有外鍵」**：

```
擁有方 Stk4.product
   stock 這一列裡【有 product_id】
   → Hibernate 撈完 stock 就知道 product 的主鍵是什麼
   → 它可以放一個「id 已知、內容未載入」的代理    ✅ LAZY 可行

反向側 Prod4Bi.stock
   product 這一列裡【沒有任何指向 stock 的欄位】
   → Hibernate 撈完 product，【不知道有沒有對應的 stock】
   → 而 stock 這個欄位是 null 還是一個物件，是兩件完全不同的事
   → 它【必須去查一次】才能決定放 null 還是放代理    🔴 LAZY 不可行
```

> 📌 **一句話**：
> **`LAZY` 的前提是「我知道它的主鍵」。反向側的一對一不知道，所以它必須查。**

**三個解法**（依偏好排序）：

| 解法 | 做法 | 評價 |
|---|---|---|
| ① **不要做成雙向**（本課的選擇） | `Product` 上不要有 `stock` 欄位，要庫存就 `stockRepo.findById(productId)` | ✅ 02 章 2.12.3 就是這樣定案的 |
| ② `optional = false` + bytecode enhancement | 告訴 Hibernate「一定有」，它就敢放代理 | ⚠️ 要開 enhancement，而且「一定有」必須為真 |
| ③ 每次都 `join fetch` | 反正它一定會查，至少合成一句 | ⚠️ 治症狀 |

⚠️ **注意 ①**：這也是為什麼 02 章 2.11 說「**單向才是預設值**」——
雙向不只是「多一個欄位」，它可能讓你**永遠多一句 SQL**。

### 4.3.6 實測：`@Basic(fetch = LAZY)` 沒有生效

`Prod4.specText` 上有這一行：

```java
@Basic(fetch = FetchType.LAZY)
@Column(name = "spec_text") private String specText;
```

意圖很清楚：那是一個 `mediumtext`，列表頁不需要它，希望撈商品時不要帶它。

```java
    @Test
    void 欄位層級的LAZY有沒有效() {
        seed(1, 1, 2, 0);
        head("Prod4.specText 上有 @Basic(fetch = LAZY)");
        tx.executeWithoutResult(s -> {
            var sqls = spy(() -> products.findById(productIds.get(0)).orElseThrow());
            grouped("撈一個商品", sqls);
            System.out.println("  spec_text 有出現在 SELECT 裡嗎 : "
                    + sqls.get(0).contains("spec_text"));
        });
    }
```

```
═══ Prod4.specText 上有 @Basic(fetch = LAZY) ═══
── 撈一個商品 → 共 1 句，1 種形狀
   ×1  select p1_0.id,p1_0.name,p1_0.sku,p1_0.spec_text,p1_0.unit_price
         from product p1_0 where p1_0.id=?
  spec_text 有出現在 SELECT 裡嗎 : true
```

🔴 **`spec_text` 還是在 `SELECT` 裡。那一行註解完全沒有效果。**

**為什麼**：關聯的延遲載入靠**代理**（放一個假物件在欄位裡）。
而 `String` 沒辦法做代理——`specText` 就是一個 `String` 欄位，
Hibernate 沒有地方掛攔截器。

**要讓它生效，必須讓 Hibernate 改寫你的 class**（bytecode enhancement）：

```xml
<!-- pom.xml -->
<plugin>
  <groupId>org.hibernate.orm.tooling</groupId>
  <artifactId>hibernate-enhance-maven-plugin</artifactId>
  <version>${hibernate.version}</version>
  <executions><execution><goals><goal>enhance</goal></goals>
    <configuration>
      <enableLazyInitialization>true</enableLazyInitialization>   <!-- ★ 欄位層級延遲 -->
    </configuration>
  </execution></executions>
</plugin>
```

⚠️ **本課不用它**（03 章 3.4.8 已經拒絕過同一個外掛一次），
而這一節要留下的是**替代方案**：

```
✅ 方案一：把大欄位【拆到另一張表】，做成 @OneToOne 擁有方在那一側
      product / product_spec 兩張表 → 關聯的 LAZY 是真的有效的（4.3.5 的擁有方）

✅ 方案二：查詢時用【DTO 投影】，根本不要 select 那一欄（05 章）
      select new ProductRow(p.id, p.sku, p.name, p.unitPrice) from Prod4 p

🔴 方案三：@Basic(fetch = LAZY) —— 不開 enhancement 的話，它只是一行註解
```

📌 **這一節的一般性教訓**：

> **JPA 的註解不全都是「一定會生效」的指令。**
> **有些是「請求」——而 `@Basic(fetch = LAZY)` 與 `@OneToOne(mappedBy, fetch = LAZY)`
> 都是被靜默忽略的請求。**
>
> ⚠️ 而它們**不會**警告你。所以「我加了註解」跟「它生效了」之間，
> **永遠需要一次實測**。

---

## 4.4 `LazyInitializationException` 的四種解法（三種是錯的）★★

### 4.4.1 先重現一次

```java
package com.example.lab.ch04;

import org.junit.jupiter.api.Test;

import java.util.List;

class C4Lie extends Base04 {

    @Test
    void 先重現一次() {
        seed(1, 1, 2, 0);
        head("Service 回傳實體，上層才碰關聯");
        final Ord4[] hold = new Ord4[1];
        tx.executeWithoutResult(s -> hold[0] = orders.findById(firstOrderId).orElseThrow());
        System.out.println("  訂單編號（已載入的欄位）: " + hold[0].getOrderNo());
        for (String what : new String[]{"getCustomer().getDisplayName()", "getItems().size()"}) {
            try {
                if (what.startsWith("getCustomer")) hold[0].getCustomer().getDisplayName();
                else hold[0].getItems().size();
                System.out.println("  " + what + " → 沒炸");
            } catch (Exception e) {
                System.out.println("  " + what + " → 🔴 " + e.getClass().getSimpleName());
            }
        }
    }
}
```

```
═══ Service 回傳實體，上層才碰關聯 ═══
  訂單編號（已載入的欄位）: SO-2026-000001
  getCustomer().getDisplayName() → 🔴 LazyInitializationException
  getItems().size() → 🔴 LazyInitializationException
```

**這個例外在說的是**（03 章 3.5.5 已經給了正式名稱）：

> **「你手上這個實體是 detached，而代理需要一個 Session 才能去撈資料。」**

**而網路上搜這個例外，你會找到四個答案。這一節把四個都測一次。**

### 4.4.2 解法一：把交易撐大（`open-in-view`）

`spring.jpa.open-in-view = true`（Spring Boot 的預設值）
會把 `EntityManager` 開在整個 HTTP 請求的範圍。
效果等於「連上層也在交易裡」：

```java
    @Test
    void 解法一_把交易撐到上層() {
        seed(200, 50, 2, 0);
        head("解法一：把交易範圍撐到「上層也在裡面」（open-in-view 的效果）");
        var st = stats(); st.reset();
        var sqls = spy(() -> tx.executeWithoutResult(s -> {
            List<Ord4> os = orders.findByStatus(St4.PENDING);      // 「Service」
            // 「Controller / 序列化」在同一個交易裡
            os.forEach(o -> { o.getCustomer().getDisplayName(); o.getItems().size(); });
        }));
        System.out.println("  → " + sqls.size() + " 句 SQL   (" + st.summary() + ")");
    }
```

```
═══ 解法一：把交易範圍撐到「上層也在裡面」（open-in-view 的效果） ═══
  → 251 句 SQL   (stmt=251  entityLoad=650  entityFetch=50  collLoad=200  collFetch=200)
```

⚠️ **例外消失了。而 251 句一句都沒有少。**

> 🔴 **這就是 `open-in-view` 最大的問題，而它不是「效能」**：
>
> **它把一個「會炸的錯誤」變成一個「不會炸的效能問題」。**
>
> ```
> open-in-view = false → 開發的第一天就炸 → 你會去修
> open-in-view = true  → 什麼都沒發生 → 上線三個月後 DBA 來問你
> ```
>
> 03 章 3.8.7 已經用一張表比較過兩者，這裡是那張表的**數字版**。

### 4.4.3 解法二：改成 `EAGER` ★★

```java
package com.example.lab.ch04;

import jakarta.persistence.*;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/** 跟 Ord4 同一張表：把 LAZY 全部改成 EAGER（4.4.3）。 */
@Entity @Table(name = "orders")
public class Ord4Eager extends Base4 {

    @Column(name = "order_no", nullable = false, length = 32) private String orderNo;

    @ManyToOne(fetch = FetchType.EAGER, optional = false)
    @JoinColumn(name = "customer_id", nullable = false) private Cust4 customer;

    @Enumerated(EnumType.STRING) @JdbcTypeCode(SqlTypes.VARCHAR)
    @Column(nullable = false, length = 16) private St4 status;

    @Column(name = "total_amount", nullable = false, precision = 19, scale = 4)
    private BigDecimal totalAmount = BigDecimal.ZERO;
    @Column(name = "placed_at", nullable = false) private Instant placedAt;

    @OneToMany(mappedBy = "order", fetch = FetchType.EAGER)
    private List<Item4> items = new ArrayList<>();

    protected Ord4Eager() {}
    public String getOrderNo() { return orderNo; }
    public Cust4 getCustomer() { return customer; }
    public List<Item4> getItems() { return items; }
}
```

```java
package com.example.lab.ch04;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface Ord4EagerRepo extends JpaRepository<Ord4Eager, UUID> {
    List<Ord4Eager> findByStatus(St4 status);
}
```

```java
    @org.springframework.beans.factory.annotation.Autowired Ord4EagerRepo eagerOrders;

    @Test
    void 解法二_改成EAGER() {
        seed(1, 1, 2, 0);
        head("解法二：改成 EAGER —— 撈【一張】訂單");
        var a = spy(() -> tx.executeWithoutResult(s ->
                eagerOrders.findById(firstOrderId).orElseThrow()));
        grouped("EAGER，findById 一張", a);

        seed(200, 50, 2, 0);
        head("同一個 EAGER 實體，撈【200 張】");
        var st = stats(); st.reset();
        var b = spy(() -> tx.executeWithoutResult(s -> {
            var os = eagerOrders.findByStatus(St4.PENDING);
            System.out.println("  拿到 " + os.size() + " 張訂單（什麼都沒碰）");
        }));
        grouped("EAGER，findByStatus 200 張", b);
        System.out.println("   PcSpy : " + st.summary());

        head("🔴 EAGER 的第二個問題：你【關不掉】它");
        var c = spy(() -> tx.executeWithoutResult(s -> {
            em.createQuery("select o from Ord4Eager o where o.status = :st", Ord4Eager.class)
                    .setParameter("st", St4.PENDING).setMaxResults(5).getResultList();
            System.out.println("  只要 5 張、而且完全不需要明細");
        }));
        grouped("JPQL 只要 5 張，不碰任何關聯", c);
    }
```

```
═══ 解法二：改成 EAGER —— 撈【一張】訂單 ═══
── EAGER，findById 一張 → 共 1 句，1 種形狀
   ×1  select oe1_0.id,oe1_0.customer_id,c1_0.id,c1_0.display_name,c1_0.email,
         oe1_0.order_no,oe1_0.placed_at,oe1_0.status,oe1_0.total_amount,… （一句 JOIN）

═══ 同一個 EAGER 實體，撈【200 張】 ═══
  拿到 200 張訂單（什麼都沒碰）
── EAGER，findByStatus 200 張 → 共 251 句，3 種形狀
   ×1    select oe1_0.id,… from orders oe1_0 where oe1_0.status=?
   ×50   select c1_0.id,c1_0.display_name,c1_0.email from customer c1_0 where c1_0.id=?
   ×200  select i1_0.order_id,… from order_item i1_0 where i1_0.order_id=?
   PcSpy : stmt=251  entityLoad=650  entityFetch=50  collLoad=200  collFetch=200

═══ 🔴 EAGER 的第二個問題：你【關不掉】它 ═══
  只要 5 張、而且完全不需要明細
── JPQL 只要 5 張，不碰任何關聯 → 共 11 句，3 種形狀
   ×1  select oe1_0.id,… from orders oe1_0 where oe1_0.status=?
   ×5  select c1_0.id,… from customer c1_0 where c1_0.id=?
   ×5  select i1_0.order_id,… from order_item i1_0 where i1_0.order_id=?
```

🔴🔴 **`EAGER` 有兩個問題，而第一個是致命的：**

**問題一：`EAGER` 只在 `find(id)` 那條路上會 JOIN。查詢不會。**

```
eagerOrders.findById(id)         → 1 句（JOIN）        ✅ 看起來有效
eagerOrders.findByStatus(...)    → 251 句              🔴 跟 LAZY 一模一樣
```

**為什麼**：`find(id)` 是 Hibernate 自己組的 SQL，它知道要 join 什麼。
而 `findByStatus` 是一句 **JPQL**——Hibernate 先照你寫的執行，
**再**去把每一個 EAGER 的關聯補齊。補齊的方式就是逐一查詢。

> 📌 **這一條非常重要，因為它讓「改成 EAGER」變成一個【假的修復】**：
>
> ```
> 你在 findById 的單元測試裡看到 1 句 → 以為修好了
> 而列表頁那條路完全沒變 → 251 句還在
> ```

**問題二：`EAGER` 是「永遠」，而你沒有辦法在某個用例關掉它。**

那句 JPQL 只要 5 張訂單、完全不需要明細，還是打了 11 句。
**你的實體上寫了 `EAGER`，就等於對【所有】用例宣告了「我一定要這些關聯」。**

⚠️ **一個例外**：4.6.3 會證明 `fetchgraph` **可以**在單一查詢裡把 `EAGER` 關掉。
但那是一個要逐個查詢加上去的補救，不是預設行為。

**結論**：

```
🔴 不要把 LAZY 改成 EAGER 來解 LazyInitializationException。
   它在最重要的那條路（列表查詢）上完全無效，
   而它在其他所有路上都讓你多撈資料。

📌 02 章 2.7.1 的規則沒有改：所有關聯一律 LAZY。
   「這個用例要哪些關聯」是【查詢】的事，不是【映射】的事。
```

### 4.4.4 解法三：`enable_lazy_load_no_trans`

Hibernate 有一個組態，一行就能讓 `LazyInitializationException` 消失：

```java
package com.example.lab.ch04;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;

/** 4.4.4：hibernate.enable_lazy_load_no_trans —— 那個「一行組態解決 LIE」的選項。 */
@SpringBootTest(properties = {
  "spring.datasource.url=jdbc:mysql://127.0.0.1:33306/ch04"
      + "?connectionTimeZone=UTC&forceConnectionTimeZoneToSession=true"
      + "&preserveInstants=true&characterEncoding=UTF-8",
  "spring.jpa.properties.hibernate.generate_statistics=true",
  "spring.jpa.properties.hibernate.enable_lazy_load_no_trans=true"
})
class C4bNoTrans extends Base04 {

    @Test
    void 它真的讓LIE消失了() {
        seed(20, 20, 2, 0);
        head("開了 enable_lazy_load_no_trans，在交易外碰延遲關聯");
        final Ord4[] hold = new Ord4[1];
        tx.executeWithoutResult(s -> hold[0] = orders.findById(firstOrderId).orElseThrow());
        var sqls = spy(() -> {
            System.out.println("  交易外 getCustomer().getDisplayName() = "
                    + hold[0].getCustomer().getDisplayName());
            System.out.println("  交易外 getItems().size()             = "
                    + hold[0].getItems().size());
        });
        System.out.println("  ✅ 沒有 LazyInitializationException");
        grouped("而它打了什麼", sqls);
    }

    @Test
    void 代價是每一次存取都是一個新交易() {
        seed(20, 20, 2, 0);
        head("🔴 在交易【外面】跑那個列表頁");
        var st = stats(); st.reset();
        var sqls = spy(() -> {
            for (Ord4 o : orders.findByStatus(St4.PENDING)) {
                o.getCustomer().getDisplayName();
                o.getItems().size();
            }
        });
        System.out.println("  → " + sqls.size() + " 句 SQL   (" + st.summary() + ")");
    }
}
```

```
═══ 開了 enable_lazy_load_no_trans，在交易外碰延遲關聯 ═══
  交易外 getCustomer().getDisplayName() = 客戶0
  交易外 getItems().size()             = 2
  ✅ 沒有 LazyInitializationException
── 而它打了什麼 → 共 2 句，2 種形狀
   ×1  select c1_0.id,c1_0.display_name,c1_0.email from customer c1_0 where c1_0.id=?
   ×1  select i1_0.order_id,… from order_item i1_0 where i1_0.order_id=?

═══ 🔴 在交易【外面】跑那個列表頁 ═══
  → 41 句 SQL   (stmt=41  entityLoad=80  entityFetch=20  collLoad=20  collFetch=20)
```

**它確實有效。而它是這四個解法裡最糟的一個，理由有三個**：

```
🔴 ① 每一次延遲載入都開【一個自己的交易、借一條自己的連線】
      → 20 張訂單的列表頁 = 41 個交易
      → 連線池會被打爆，而且症狀是「隨機的 timeout」

🔴 ② 那 41 個交易之間【沒有一致性】
      → 你讀到的客戶是 T1 的快照、明細是 T2 的
      → 03 章 3.3.4 那兩層快取的問題全部回來，而且更亂

🔴 ③ 它讓「實體離開交易」這件事【看起來是安全的】
      → 於是實體會被傳到更遠的地方，直到有人在 Controller 裡跑一個迴圈
```

📌 **這個選項的存在，幾乎只是為了「讓一個爛掉的舊系統先跑起來」。**
Hibernate 的文件自己就把它標為不建議使用。

### 4.4.5 解法四：在交易裡撈齊（正解）

```java
    @Test
    void 解法三_在交易裡撈齊() {
        seed(200, 50, 2, 0);
        head("解法四：在交易裡就把這個用例需要的撈齊（正解，4.5 起的主題）");
        var st = stats(); st.reset();
        var sqls = spy(() -> tx.executeWithoutResult(s -> {
            var os = orders.fetchAll(St4.PENDING);
            os.forEach(o -> { o.getCustomer().getDisplayName(); o.getItems().size(); });
        }));
        grouped("JOIN FETCH", sqls);
        System.out.println("   PcSpy : " + st.summary());
    }
```

```
═══ 解法四：在交易裡就把這個用例需要的撈齊（正解，4.5 起的主題） ═══
── JOIN FETCH → 共 1 句，1 種形狀
   ×1  select distinct o1_0.id,o1_0.customer_id,c1_0.id,c1_0.display_name,c1_0.email,
         i1_0.order_id,i1_0.id,i1_0.line_amount,i1_0.product_id,… （一句 JOIN）
   PcSpy : stmt=1  entityLoad=650  entityFetch=0  collLoad=200  collFetch=0
```

✅ **1 句 SQL、`entityFetch = 0`、`collFetch = 0`。**

📌 **注意 `collLoad = 200` 但 `collFetch = 0`**：
200 個集合都載入了，但**沒有一個是「另外一句 SQL」撈的**——
它們都在那一句 JOIN 裡。**這兩個計數器的差別就是 4.10 那條斷言的基礎。**

### 4.4.6 四種解法的對照

| | 解法 | LIE 解掉了嗎 | SQL 句數 | 為什麼不該用 |
|---|---|---|---|---|
| ① | `open-in-view = true` | ✅ | **不變（251）** | 🔴 把「會炸的錯」變成「不會炸的效能問題」 |
| ② | 改成 `EAGER` | ✅ | **列表查詢不變（251）** | 🔴 只在 `find(id)` 有效；而且所有用例都關不掉 |
| ③ | `enable_lazy_load_no_trans` | ✅ | 41 個**交易** | 🔴 連線池、一致性、把壞習慣變得安全 |
| ④ | **在交易裡撈齊** | ✅ | **1** | ✅ **正解** |

> ⚠️⚠️ **①②③ 的共同點，比它們各自的缺點更重要**：
>
> **它們都在回答「怎麼讓這個例外不要出現」，
> 而 `LazyInitializationException` 真正在說的是：**
>
> > **「你的 Service 沒有把這個用例需要的資料撈齊。」**
>
> **①②③ 讓那句話閉嘴，④ 回答那句話。**

**而「在交易裡撈齊」有五種寫法，那就是 4.5 到 4.8**：

```
4.5  JOIN FETCH        —— 在查詢裡寫
4.6  @EntityGraph      —— 在查詢外面宣告
4.7  @BatchSize        —— 不撈齊，但把 N 句合成 N/size 句
4.8  @Fetch(SUBSELECT) —— 用子查詢一次撈全部集合
05 章 DTO 投影          —— 根本不要實體
```

---

## 4.5 `JOIN FETCH` ★★

### 4.5.1 實測：251 句 → 1 句

```java
package com.example.lab.ch04;

import org.junit.jupiter.api.Test;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;

import java.util.List;

class C5Fetch extends Base04 {

    @Test
    void 兩百五十一句變一句() {
        seed(200, 50, 2, 0);
        head("① 天真寫法");
        long msA = bestMs(() -> tx.executeWithoutResult(s -> {
            for (Ord4 o : orders.findByStatus(St4.PENDING)) {
                o.getCustomer().getDisplayName(); o.getItems().size();
            }
        }), 3, 3);
        var a = spy(() -> tx.executeWithoutResult(s -> {
            for (Ord4 o : orders.findByStatus(St4.PENDING)) {
                o.getCustomer().getDisplayName(); o.getItems().size();
            }
        }));
        System.out.println("  → " + a.size() + " 句、" + msA + " ms");

        head("② JOIN FETCH");
        long msB = bestMs(() -> tx.executeWithoutResult(s -> {
            for (Ord4 o : orders.fetchAll(St4.PENDING)) {
                o.getCustomer().getDisplayName(); o.getItems().size();
            }
        }), 3, 3);
        var b = spy(() -> tx.executeWithoutResult(s -> {
            for (Ord4 o : orders.fetchAll(St4.PENDING)) {
                o.getCustomer().getDisplayName(); o.getItems().size();
            }
        }));
        System.out.println("  → " + b.size() + " 句、" + msB + " ms");
        grouped("那一句", b);
    }
}
```

⚠️ **方法名不能以數字開頭**——這是 Java 的規則，
而中文方法名很容易讓人忘記（`void 251句變1句()` 編譯不過：`<identifier> expected`）。

```
═══ ① 天真寫法 ═══
  → 251 句、68 ms
═══ ② JOIN FETCH ═══
  → 1 句、7 ms
── 那一句 → 共 1 句，1 種形狀
   ×1  select distinct o1_0.id,o1_0.customer_id,c1_0.id,c1_0.display_name,c1_0.email,
         i1_0.order_id,i1_0.id,i1_0.line_amount,i1_0.product_id,…
```

**251 句 68 ms → 1 句 7 ms。省下 61 ms，將近 10 倍。**

📌 這對得上 00 章 0.7 那張表（`251 句 66～74 ms` / `1 句 9～10 ms`）。

**`JOIN FETCH` 的語法只有一件事要注意**：

```sql
join fetch o.customer          -- 內連接 + fetch
left join fetch o.items        -- 外連接 + fetch  ← ★ 集合幾乎一律用 left
```

⚠️ **集合要用 `left join fetch`**，否則「沒有明細的訂單」會**整張消失**——
那是一個很典型的「資料看起來少了幾筆」的 bug。

### 4.5.2 實測：笛卡兒積

`JOIN FETCH` 的第一個代價，在 SQL 回來的**列數**上：

```java
    @Test
    void 笛卡兒積() {
        seed(1, 1, 3, 2);        // 1 張訂單、3 筆明細、2 筆備註
        head("一張訂單 × 3 明細 × 2 備註，JOIN 出來幾列");
        long rows = jdbc.queryForObject("""
                SELECT COUNT(*) FROM orders o
                  LEFT JOIN order_item i ON i.order_id = o.id
                  LEFT JOIN order_note n ON n.order_id = o.id
                """, Long.class);
        System.out.println("  兩個集合一起 JOIN → " + rows + " 列（3 × 2）");
        long rows1 = jdbc.queryForObject("""
                SELECT COUNT(*) FROM orders o LEFT JOIN order_item i ON i.order_id = o.id
                """, Long.class);
        System.out.println("  只 JOIN 明細       → " + rows1 + " 列");

        head("200 張訂單 × 2 明細 × 2 備註");
        seed(200, 50, 2, 2);
        long big = jdbc.queryForObject("""
                SELECT COUNT(*) FROM orders o
                  LEFT JOIN order_item i ON i.order_id = o.id
                  LEFT JOIN order_note n ON n.order_id = o.id
                """, Long.class);
        System.out.println("  → " + big + " 列（原本 200 列的訂單資料，被複製了 "
                + (big / 200) + " 倍）");
    }
```

```
═══ 一張訂單 × 3 明細 × 2 備註，JOIN 出來幾列 ═══
  兩個集合一起 JOIN → 6 列（3 × 2）
  只 JOIN 明細       → 3 列
═══ 200 張訂單 × 2 明細 × 2 備註 ═══
  → 800 列（原本 200 列的訂單資料，被複製了 4 倍）
```

**兩個集合一起 `join fetch`，列數是它們的【乘積】。**

```
訂單 1 筆
  × 明細 3 筆
  × 備註 2 筆
  = 6 列，而每一列都重複帶了整份訂單的欄位
```

⚠️ **這個乘積長得比你想的快**：

| 明細 | 備註 | 列數 | 訂單欄位被複製 |
|---|---|---|---|
| 3 | 2 | 6 | 6 倍 |
| 20 | 10 | **200** | 200 倍 |
| 50 | 50 | **2,500** | 2,500 倍 |

🔴 **而網路的頻寬與 JDBC 的解析成本，是按【列數】計價的。**
一句 SQL 不代表便宜——它可能比 200 句加起來還貴。

📌 **所以 `JOIN FETCH` 的規則是**：

```
✅ 一次只 fetch【一個】集合
✅ @ManyToOne / @OneToOne 可以隨便 fetch（它們不會增加列數）
🔴 兩個以上的集合 → 用 4.7 的 @BatchSize，或拆成兩個查詢
```

而下一節會看到，Hibernate 對「兩個 `List`」這件事**直接拒絕**。

### 4.5.3 實測：`distinct` 在 Hibernate 6 已經不需要了 ★★

**幾乎每一份 JPA 教學都會告訴你**：`join fetch` 集合時要加 `distinct`，
否則父實體會重複出現 N 次。

**實測一次**：

```java
package com.example.lab.ch04;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;

import java.util.List;

@SpringBootTest(properties = {
  "spring.datasource.url=jdbc:mysql://127.0.0.1:33306/ch04"
      + "?connectionTimeZone=UTC&forceConnectionTimeZoneToSession=true"
      + "&preserveInstants=true&characterEncoding=UTF-8",
  "spring.jpa.properties.hibernate.generate_statistics=true"
})
class C5bDistinct extends Base04 {

    @Test
    void 沒有distinct會不會重複() {
        for (int per : new int[]{2, 3, 5}) {
            seed(10, 10, per, 0);
            tx.executeWithoutResult(s -> {
                List<Ord4> os = orders.fetchNoDistinct(St4.PENDING);
                long rows = jdbc.queryForObject(
                    "SELECT COUNT(*) FROM orders o LEFT JOIN order_item i ON i.order_id=o.id",
                    Long.class);
                System.out.printf("  每張 %d 筆明細：SQL 回 %d 列 → List 大小 %d、不同物件 %d%n",
                        per, rows, os.size(), os.stream().distinct().count());
            });
        }
    }
}
```

```
═══ 沒有 distinct 的 JOIN FETCH ═══
  每張 2 筆明細：SQL 回 20 列 → List 大小 10、不同物件 10
  每張 3 筆明細：SQL 回 30 列 → List 大小 10、不同物件 10
  每張 5 筆明細：SQL 回 50 列 → List 大小 10、不同物件 10
```

🔴🔴 **沒有重複。SQL 回 50 列，`List` 是 10 筆。**

**Hibernate 6 會自動把根實體去重**（這是從 6.0 開始的行為改變）。
在 Hibernate 5 上，同樣的查詢會給你一個 50 筆、每張訂單重複 5 次的 `List`——
**所以那些教學在當年是對的，現在不是了。**

**那加了 `distinct` 會怎樣？**

```java
    @Test
    void distinct的代價() {
        seed(200, 50, 2, 0);
        head("只差 distinct 的兩句（同樣都 fetch items）");
        tx.executeWithoutResult(s -> {
            var a = spy(() -> orders.fetchNoDistinct(St4.PENDING));
            System.out.println("  沒 distinct : " + cut(a.get(0)));
            var b = spy(() -> em.createQuery(
                    "select distinct o from Ord4 o left join fetch o.items where o.status = :st",
                    Ord4.class).setParameter("st", St4.PENDING).getResultList());
            System.out.println("  有 distinct : " + cut(b.get(0)));
        });
    }
```

```
═══ 只差 distinct 的兩句（同樣都 fetch items）═══
  沒 distinct : select o1_0.id,o1_0.customer_id,i1_0.order_id,i1_0.id,i1_0.line_amount,…
  有 distinct : select distinct o1_0.id,o1_0.customer_id,i1_0.order_id,i1_0.id,i1_0.line_amount,…
```

⚠️ **那個 `distinct` 會傳到 SQL 裡。** 而它在做的事是：

```
資料庫拿到 400 列（每列都是「訂單欄位 + 明細欄位」的寬列）
   ↓ DISTINCT
比對每一列的【每一個欄位】，找出重複的
   ↓
而它們【本來就沒有重複】（明細的 id 各不相同）
   ↓
400 列原封不動回來 —— 那次 DISTINCT 是純浪費
```

**在 200 張訂單 / 400 列這個規模上，兩者的時間都是 6 ms（差異在雜訊裡）。**
但那次去重的成本是**按列數與欄位數成長**的，
而且它通常會讓 MySQL 多做一次排序或建一張暫存表（07 站 03 章的 `Using temporary`）。

> 📌 **結論（Hibernate 6）**：
>
> ```
> 🔴 不要為了「去重父實體」而寫 distinct —— Hibernate 已經幫你做了
> ✅ 只有在你【真的要 SQL 層級去重】時才寫（例如 select distinct o.status）
> ```
>
> ⚠️ **如果你在維護一個 Hibernate 5 的專案，規則是反過來的。**
> Hibernate 5.2～5.6 還有一個 `hibernate.query.passDistinctThrough=false` 的開關，
> 讓你「在 Java 端去重、但不要把 distinct 傳給 SQL」——
> **那個開關在 Hibernate 6 被移除了，因為它變成了預設行為。**

**這一節值得記的不是結論，是方法**：

> 「`join fetch` 要加 `distinct`」是一條**曾經正確**的規則。
> 而它在版本升級時**靜默地過期了**——沒有警告、沒有棄用訊息。
>
> **判斷方法只有一個：印出 `List.size()`，看它是 10 還是 50。**

### 4.5.4 實測：`MultipleBagFetchException`

```java
    @Test
    void 兩個List一起fetch() {
        seed(20, 20, 2, 2);
        head("兩個 List 一起 join fetch");
        try {
            tx.executeWithoutResult(s -> orders.fetchTwoBags(St4.PENDING));
            System.out.println("  沒事？");
        } catch (Exception e) {
            Throwable r = e; while (r.getCause() != null && r.getCause() != r) r = r.getCause();
            System.out.println("  🔴 " + r.getClass().getSimpleName());
            System.out.println("     " + r.getMessage());
        }
    }
```

```
═══ 兩個 List 一起 join fetch ═══
  🔴 MultipleBagFetchException
     cannot simultaneously fetch multiple bags:
     [com.example.lab.ch04.Ord4.items, com.example.lab.ch04.Ord4.notes]
```

02 章 2.8.2 測過這個例外，也列了三種解法。**現在可以說清楚它為什麼存在**：

```
「bag」= 沒有 index 的 List（02 章 2.8.1）
   → Hibernate 不知道每個元素該放在第幾格
   → 它只能「照 SQL 回來的順序往後塞」

兩個 bag 一起 join → 每個明細出現 2 次、每個備註出現 3 次（笛卡兒積）
   → 照順序塞的話，items 會有 6 個元素（3 個明細各 2 份）
   → 而 Hibernate【沒辦法】判斷哪些是重複的（bag 允許重複！）
   → 所以它選擇【直接拒絕】
```

📌 **「直接拒絕」在這裡是好設計**：如果它照塞，你會拿到一個
`items.size() == 6` 而資料庫只有 3 筆的集合——**那比一個例外糟得多。**

**換成 `Set` 就可以**（因為 `Set` 天生去重）：

```java
package com.example.lab.ch04;

import jakarta.persistence.*;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.LinkedHashSet;
import java.util.Set;

/** 跟 Ord4 同一張表：兩個集合都是 Set（4.5.4）。 */
@Entity @Table(name = "orders")
public class Ord4Sets extends Base4 {

    @Column(name = "order_no", nullable = false, length = 32) private String orderNo;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "customer_id", nullable = false) private Cust4 customer;

    @Enumerated(EnumType.STRING) @JdbcTypeCode(SqlTypes.VARCHAR)
    @Column(nullable = false, length = 16) private St4 status;

    @Column(name = "total_amount", nullable = false, precision = 19, scale = 4)
    private BigDecimal totalAmount = BigDecimal.ZERO;
    @Column(name = "placed_at", nullable = false) private Instant placedAt;

    @OneToMany(mappedBy = "order") private Set<Item4> items = new LinkedHashSet<>();
    @OneToMany(mappedBy = "order") private Set<Note4> notes = new LinkedHashSet<>();

    protected Ord4Sets() {}
    public Set<Item4> getItems() { return items; }
    public Set<Note4> getNotes() { return notes; }
}
```

```java
package com.example.lab.ch04;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.UUID;

public interface Ord4SetsRepo extends JpaRepository<Ord4Sets, UUID> {}
```

```java
    @Test
    void 兩個Set一起fetch() {
        seed(20, 20, 2, 2);
        head("同一件事，兩個集合都改成 Set");
        tx.executeWithoutResult(s -> {
            var sqls = spy(() -> {
                var os = em.createQuery("""
                        select distinct o from Ord4Sets o
                          left join fetch o.items
                          left join fetch o.notes
                         where o.status = :st
                        """, Ord4Sets.class).setParameter("st", St4.PENDING).getResultList();
                System.out.println("  ✅ 沒有例外，拿到 " + os.size() + " 張訂單");
                System.out.println("     第一張的明細 " + os.get(0).getItems().size()
                        + " 筆、備註 " + os.get(0).getNotes().size() + " 筆");
            });
            System.out.println("  → " + sqls.size() + " 句 SQL");
            System.out.println("  ⚠️ 但資料庫回了 " + jdbc.queryForObject("""
                    SELECT COUNT(*) FROM orders o
                      LEFT JOIN order_item i ON i.order_id = o.id
                      LEFT JOIN order_note n ON n.order_id = o.id
                     WHERE o.status = 'PENDING'
                    """, Long.class) + " 列");
        });
    }
```

```
═══ 同一件事，兩個集合都改成 Set ═══
  ✅ 沒有例外，拿到 20 張訂單
     第一張的明細 2 筆、備註 2 筆
  → 1 句 SQL
  ⚠️ 但資料庫回了 80 列
```

⚠️⚠️ **`Set` 讓例外消失，而笛卡兒積還在**（20 張 × 2 × 2 = 80 列）。

> 📌 **這是這一節最重要的一句話**：
>
> **`MultipleBagFetchException` 不是「`List` 的問題」，它是「一次 fetch 兩個集合」的問題。**
> **換成 `Set` 只是把「拒絕」換成「靜默地做那件貴的事」。**

**02 章 2.8.4 選了 `List`，那個決定不變。** 而正確的解法是**不要一次 fetch 兩個集合**：

| 解法 | 做法 |
|---|---|
| ① **只 fetch 一個，另一個交給 `@BatchSize`** | 4.7 —— **本課的預設做法** |
| ② 拆成兩個查詢 | 各自 fetch 一個集合，靠一級快取組合（⚠️ 4.8.2 會證明這對集合無效） |
| ③ 兩個都用 `@BatchSize`，一個都不 fetch | 4.7.6 —— 分頁時的做法 |
| ④ 改用 DTO 投影，兩個集合各查一次 | 05 章 |

### 4.5.5 🔴 實測：`JOIN FETCH` + 分頁 ★★

**這是這一章最重要的一個實測。**

```java
    @Test
    void JOIN_FETCH加分頁() {
        seed(200, 50, 2, 0);
        head("🔴 JOIN FETCH + 分頁（每頁 20 筆）");
        tx.executeWithoutResult(s -> {
            var sqls = spy(() -> {
                List<Ord4> os = orders.fetchPaged(St4.PENDING,
                        PageRequest.of(0, 20, Sort.by("placedAt")));
                System.out.println("  程式拿到 : " + os.size() + " 筆");
            });
            String sql = sqls.get(0);
            System.out.println("  有 limit 嗎 : " + sql.contains("limit"));
            long rows = jdbc.queryForObject(
                "SELECT COUNT(*) FROM orders o LEFT JOIN order_item i ON i.order_id=o.id"
                + " WHERE o.status='PENDING'", Long.class);
            System.out.println("  🔴 而資料庫回了 : " + rows + " 列（全部）");
        });
    }
```

```
═══ 🔴 JOIN FETCH + 分頁：SQL 沒有 limit，那它回了幾列 ═══
2026-09-07T17:00:50.623+08:00  WARN --- org.hibernate.orm.query :
    HHH90003004: firstResult/maxResults specified with collection fetch; applying in memory
  程式拿到 : 20 筆
  有 limit 嗎 : false
  🔴 而資料庫回了 : 400 列（全部）
```

🔴🔴 **程式拿到 20 筆，而資料庫回了 400 列。SQL 裡沒有 `limit`。**

**Hibernate 做的事**：

```
① 把 WHERE 條件的【全部】資料撈回來（200 張訂單 × 2 明細 = 400 列）
② 在【記憶體裡】組成 200 個 Ord4 物件（全部進持久化情境、全部建快照）
③ 在【記憶體裡】切出第 0～19 個
④ 把剩下 180 個丟掉（但它們還在持久化情境裡！）
```

**為什麼它不能加 `limit`**：因為 `limit 20` 會切在**列**上，不是切在**訂單**上。
400 列的第 20 列是「第 10 張訂單的第 2 筆明細」——
`limit 20` 會給你 10 張完整的訂單，而不是 20 張。**那是錯的答案。**

📌 **所以 Hibernate 選擇「給你對的答案，但很慢」，並且印一行警告。**

⚠️⚠️ **`HHH90003004` 這個警告，是這一章最該記住的字串。**

```
HHH90003004: firstResult/maxResults specified with collection fetch; applying in memory
                                                                     ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲
                                                                     「在記憶體裡分頁」
```

**它在正式環境的 log 裡是 `WARN` 等級，而且一天可能出現幾萬次——
所以它通常被過濾掉了。**

**把資料量放大 10 倍**：

```java
        head("資料量放大 10 倍呢");
        seed(2000, 50, 2, 0);
        tx.executeWithoutResult(s -> {
            long t0 = System.nanoTime();
            List<Ord4> os = orders.fetchPaged(St4.PENDING,
                    PageRequest.of(0, 20, Sort.by("placedAt")));
            long ms = (System.nanoTime() - t0) / 1_000_000;
            System.out.println("  2000 張訂單裡取第一頁 20 筆 → " + ms + " ms、拿到 " + os.size() + " 筆");
            System.out.println("  PC 裡現在有 "
                    + em.unwrap(org.hibernate.engine.spi.SessionImplementor.class)
                        .getPersistenceContext().getNumberOfManagedEntities() + " 個實體");
        });
```

```
═══ 資料量放大 10 倍呢 ═══
  HHH90003004: firstResult/maxResults specified with collection fetch; applying in memory
  2000 張訂單裡取第一頁 20 筆 → 107 ms、拿到 20 筆
  PC 裡現在有 6000 個實體
```

🔴🔴 **取 20 筆資料，載入了 6000 個實體、花了 107 ms。**

**而那 6000 個實體不是「用完就丟」**——它們在持久化情境裡，所以：

```
① 6000 份快照（03 章 3.4.2）占著記憶體
② 交易結束前要對 6000 個實體做髒檢查（03 章 3.4.8：20000 個要 1.5 ms）
③ 這一切都是為了回傳 20 筆
```

⚠️ **而它會隨資料量【線性】惡化，而且沒有任何症狀**——
除了那一行被過濾掉的 `WARN`。

> 📌 **一個判斷法則**：
>
> > **只要一個查詢同時有「`fetch` 一個集合」與「分頁」，它就是壞的。**
> > **這兩件事在 SQL 層次是互斥的，沒有例外。**
>
> **而 `@ManyToOne` 的 `fetch` 跟分頁【不衝突】**——
> 它不增加列數，所以 `limit` 切得對。4.11 的列表頁就是靠這一條。

### 4.5.6 實測：分頁的正解之一 —— 兩段式

```java
    @Test
    void 分頁的正解_兩段式() {
        seed(2000, 50, 2, 0);
        head("✅ 兩段式：第一段只撈 id（可以真的 limit），第二段用 id 清單 fetch");
        tx.executeWithoutResult(s -> {
            long t0 = System.nanoTime();
            var ids = orders.pageIds(St4.PENDING, PageRequest.of(0, 20));
            var os = orders.fetchByIds(ids);
            long ms = (System.nanoTime() - t0) / 1_000_000;
            os.forEach(o -> { o.getCustomer().getDisplayName(); o.getItems().size(); });
            System.out.println("  → " + ms + " ms、拿到 " + os.size() + " 筆");
            System.out.println("  PC 裡現在有 "
                    + em.unwrap(org.hibernate.engine.spi.SessionImplementor.class)
                        .getPersistenceContext().getNumberOfManagedEntities() + " 個實體");
        });
    }
```

```
═══ ✅ 兩段式：第一段只撈 id（可以真的 limit），第二段用 id 清單 fetch ═══
  → 9 ms、拿到 20 筆
  PC 裡現在有 80 個實體
```

**兩段的 SQL**：

```
×1  select o1_0.id from orders o1_0 where o1_0.status=? order by o1_0.placed_at limit ?,?
                                                                                ▲▲▲▲▲
                                                            ★ 真的 limit —— 因為沒有 fetch 集合
×1  select distinct o1_0.id,o1_0.customer_id,c1_0.id,…,i1_0.order_id,…
      from orders o1_0 join customer c1_0 … left join order_item i1_0 …
     where o1_0.id in (?,?,?,…)
```

**跟 4.5.5 的對照**：

| | SQL 句數 | 時間 | PC 裡的實體 |
|---|---|---|---|
| `JOIN FETCH` + 分頁 | 1 | **107 ms** | **6,000** |
| **兩段式** | 2 | **9 ms** | **80** |

**2 句比 1 句快 12 倍、少用 75 倍的記憶體。**

> 📌 **這是這一章最反直覺的一個結論**：
> **「SQL 句數」不是唯一的成本，也不總是最重要的成本。**
>
> 03 章 3.13.2 的練習五問過「3 句 SQL 為什麼要 250 ms」——
> **這裡就是答案的一種形狀：把不需要的資料變成了實體。**

⚠️ **兩段式的三個細節**：

```
① 第一段要有【穩定的排序】，否則兩次查詢可能對不上（07 站 03 章的 keyset 分頁）
② 第二段的 in (?,?,…) 有長度上限（Oracle 是 1000，MySQL 受 max_allowed_packet 限制）
      → 頁大小不要超過幾百筆，本來也不該
③ 第二段【不需要】order by ——但你的程式要自己照 ids 的順序重排！
      → in 查詢回來的順序是不保證的
```

**③ 是一個很常見的 bug**。正確的寫法：

```java
List<UUID> ids = orders.pageIds(status, page);
Map<UUID, Ord4> byId = orders.fetchByIds(ids).stream()
        .collect(Collectors.toMap(Ord4::getId, o -> o));
List<Ord4> sorted = ids.stream().map(byId::get).toList();   // ★ 照第一段的順序重排
```

**而 4.7.6 會給一個更簡單的分頁解法（不需要兩段、也不需要重排）。**

### 4.5.7 `JOIN FETCH` 的六條規則

```
① 集合一律 left join fetch，否則「沒有子資料的父」會消失
② @ManyToOne / @OneToOne 可以隨便 fetch（不增加列數）
③ 一次只 fetch【一個】集合。兩個 List → MultipleBagFetchException；
   兩個 Set → 不報錯，但笛卡兒積照樣發生
④ Hibernate 6 不需要 distinct（它自動去重父實體）；寫了反而讓 DB 多做一次去重
⑤ 🔴 fetch 集合 + 分頁 = 記憶體分頁（HHH90003004）。這兩件事互斥
⑥ 「1 句 SQL」不等於「便宜」—— 要同時看【回了幾列】與【建了幾個實體】
```

---

## 4.6 `@EntityGraph`

### 4.6.1 為什麼需要它

`JOIN FETCH` 有一個結構性的問題：**它把「要撈什麼」寫進了查詢字串裡。**

```java
// 明細頁要：客戶 + 明細 + 每筆明細的商品
@Query("select o from Ord4 o join fetch o.customer left join fetch o.items where o.id = :id")
Optional<Ord4> findForDetailPage(@Param("id") UUID id);

// 列表頁只要：客戶
@Query("select o from Ord4 o join fetch o.customer where o.status = :st")
List<Ord4> findForListPage(@Param("st") St4 status);

// 匯出報表要：客戶 + 明細 + 商品 + 備註
@Query("...")
List<Ord4> findForExport(@Param("st") St4 status);
```

🔴 **三個用例，三句幾乎一樣的 JPQL。** 而它們的 `where` 條件是一樣的——
**真正不同的只有「要撈哪些關聯」。**

📌 **`@EntityGraph` 把這兩件事分開**：

```
查詢（where / order by）  → 由 JPQL 或衍生查詢方法決定
要撈哪些關聯              → 由 EntityGraph 決定，寫在查詢【外面】
```

### 4.6.2 實測：三種寫法

**寫法一：`attributePaths`（最常用，寫在 repository 方法上）**

```java
@EntityGraph(attributePaths = {"customer"})
List<Ord4> findByStatusOrderByPlacedAt(St4 status);
```

**寫法二與三：具名 graph（宣告在實體上，4.2.2 那三個）**

```java
@Entity @Table(name = "orders")
@NamedEntityGraph(name = "Ord4.withCustomerAndItems",
    attributeNodes = { @NamedAttributeNode("customer"), @NamedAttributeNode("items") })
@NamedEntityGraph(name = "Ord4.full",
    attributeNodes = {
        @NamedAttributeNode("customer"),
        @NamedAttributeNode(value = "items", subgraph = "itemWithProduct") },
    subgraphs = @NamedSubgraph(name = "itemWithProduct",
        attributeNodes = @NamedAttributeNode("product")))     // ★ 兩層：明細 → 商品
public class Ord4 extends Base4 { … }
```

```java
package com.example.lab.ch04;

import org.junit.jupiter.api.Test;

class C6Graph extends Base04 {

    @Test
    void 三個具名graph() {
        seed(200, 50, 2, 0);
        head("① attributePaths = {\"customer\"}（只 fetch 客戶）");
        tx.executeWithoutResult(s -> {
            var sqls = spy(() -> orders.findByStatusOrderByPlacedAt(St4.PENDING)
                    .forEach(o -> o.getCustomer().getDisplayName()));
            grouped("SQL", sqls);
        });

        head("② 具名 graph Ord4.withCustomerAndItems");
        tx.executeWithoutResult(s -> {
            var sqls = spy(() -> orders.findByStatusOrderByOrderNo(St4.PENDING)
                    .forEach(o -> { o.getCustomer().getDisplayName(); o.getItems().size(); }));
            grouped("SQL", sqls);
        });

        head("③ 帶 subgraph 的 Ord4.full（訂單 → 明細 → 商品）");
        tx.executeWithoutResult(s -> {
            var sqls = spy(() -> orders.findByOrderNo("SO-2026-000001")
                    .forEach(o -> o.getItems().forEach(i -> i.getProduct().getName())));
            grouped("SQL", sqls);
        });
    }
}
```

```
═══ ① attributePaths = {"customer"}（只 fetch 客戶） ═══
── SQL → 共 1 句，1 種形狀
   ×1  select o1_0.id,o1_0.customer_id,c1_0.id,c1_0.display_name,c1_0.email,
         o1_0.order_no,o1_0.placed_at,o1_0.status,o1_0.total_amount from orders o1_0 …

═══ ② 具名 graph Ord4.withCustomerAndItems ═══
── SQL → 共 1 句，1 種形狀
   ×1  select o1_0.id,o1_0.customer_id,c1_0.id,c1_0.display_name,c1_0.email,
         i1_0.order_id,i1_0.id,i1_0.line_amount,i1_0.product_id,i1_0.pro…

═══ ③ 帶 subgraph 的 Ord4.full（訂單 → 明細 → 商品） ═══
── SQL → 共 1 句，1 種形狀
   ×1  select o1_0.id,o1_0.customer_id,c1_0.id,c1_0.display_name,c1_0.email,
         i1_0.order_id,i1_0.id,i1_0.line_amount,i1_0.product_id,p1_0.id,…
```

**三個都是 1 句。** ③ 那一句同時 join 了 `customer`、`order_item`、`product`——
**這就是 4.2.5「兩層關聯」那個 N+1 的解法。**

⚠️ **注意 `@EntityGraph` 產生的 SQL 跟 `JOIN FETCH` 是一樣的**（都是 join）。
所以 **4.5 的每一個代價它都繼承**：笛卡兒積、一次只能一個集合、分頁失效。
4.6.5 會確認最後一項。

**「graph 沒包含的關聯」行為不變**：

```java
    @Test
    void 只fetch客戶時集合還是LAZY() {
        seed(20, 20, 2, 0);
        head("只 fetch 了客戶，那 items 呢");
        tx.executeWithoutResult(s -> {
            var os = orders.findByStatusOrderByPlacedAt(St4.PENDING);
            Ord4 o = os.get(0);
            System.out.println("  customer 初始化了嗎 : "
                    + org.hibernate.Hibernate.isInitialized(o.getCustomer()));
            System.out.println("  items 初始化了嗎    : "
                    + org.hibernate.Hibernate.isInitialized(o.getItems()));
            var sqls = spy(() -> o.getItems().size());
            System.out.println("  碰 items → " + sqls.size() + " 句（graph 沒包含的，行為不變）");
        });
    }
```

```
═══ 只 fetch 了客戶，那 items 呢 ═══
  customer 初始化了嗎 : true
  items 初始化了嗎    : false
  碰 items → 1 句（graph 沒包含的，行為不變）
```

### 4.6.3 實測：`fetchgraph` vs `loadgraph` ★★

JPA 規格定義了**兩種** graph 語意，而它們的差別只在「graph 沒提到的屬性怎麼辦」：

```
jakarta.persistence.fetchgraph  → graph 裡有的 = EAGER，【沒有的一律 LAZY】
jakarta.persistence.loadgraph   → graph 裡有的 = EAGER，沒有的【照實體上宣告的】
```

**用 `Ord4Eager`（`items` 是 `EAGER`）配一個「只有 customer」的 graph 來測**：

```java
    @Test
    void fetchgraph跟loadgraph差在哪() {
        seed(20, 20, 2, 0);
        head("拿【EAGER 的實體】搭配兩種 graph（graph 裡只有 customer，沒有 items）");
        tx.executeWithoutResult(s -> {
            jakarta.persistence.EntityGraph<Ord4Eager> g = em.createEntityGraph(Ord4Eager.class);
            g.addAttributeNodes("customer");

            em.clear();
            var a = spy(() -> {
                var os = em.createQuery(
                        "select o from Ord4Eager o where o.status = :st", Ord4Eager.class)
                        .setParameter("st", St4.PENDING)
                        .setHint("jakarta.persistence.loadgraph", g)
                        .getResultList();
                System.out.println("  loadgraph  : items 初始化了嗎 = "
                        + org.hibernate.Hibernate.isInitialized(os.get(0).getItems()));
            });
            System.out.println("  loadgraph  → " + a.size() + " 句");

            em.clear();
            var b = spy(() -> {
                var os = em.createQuery(
                        "select o from Ord4Eager o where o.status = :st", Ord4Eager.class)
                        .setParameter("st", St4.PENDING)
                        .setHint("jakarta.persistence.fetchgraph", g)
                        .getResultList();
                System.out.println("  fetchgraph : items 初始化了嗎 = "
                        + org.hibernate.Hibernate.isInitialized(os.get(0).getItems()));
            });
            System.out.println("  fetchgraph → " + b.size() + " 句");
        });
    }
```

```
═══ 拿【EAGER 的實體】搭配兩種 graph（graph 裡只有 customer，沒有 items） ═══
  loadgraph  : items 初始化了嗎 = true
  loadgraph  → 21 句
  fetchgraph : items 初始化了嗎 = false
  fetchgraph → 1 句
```

🔴 **同一個查詢、同一個 graph，只換一個 hint 的名字：21 句 vs 1 句。**

**這也是 4.4.3 那個「`EAGER` 關不掉」的一個補充**：

```
用 JPQL 撈 EAGER 的實體         → 關不掉（21 句）
用 JPQL + fetchgraph            → ✅ 關掉了（1 句）
```

⚠️ **但這不改變 4.4.3 的結論**：

```
🔴 「所有關聯 LAZY + 用 graph 指定要撈什麼」→ 預設安全，忘了寫也只是慢
🔴 「所有關聯 EAGER + 用 fetchgraph 關掉不要的」→ 預設危險，忘了寫就多撈
```

📌 **Spring Data 的 `@EntityGraph` 預設用哪一個？**
`@EntityGraph(type = ...)` 的預設值是 **`FETCH`**（也就是 `fetchgraph`）。
所以你在 4.6.2 看到的都是 `fetchgraph` 的行為。

```java
@EntityGraph(attributePaths = {"customer"}, type = EntityGraphType.LOAD)   // 要 loadgraph 得明講
```

### 4.6.4 實測：動態 graph

同一個查詢方法，不同用例要不同的關聯——**這是 `@EntityGraph` 真正的用途**：

```java
    @Test
    void 動態graph() {
        seed(20, 20, 2, 0);
        head("同一個查詢，兩個用例要不同的關聯 → 動態組 graph");
        tx.executeWithoutResult(s -> {
            for (String usecase : new String[]{"列表頁（只要客戶名）", "明細頁（要客戶＋明細＋商品）"}) {
                em.clear();
                jakarta.persistence.EntityGraph<Ord4> g = em.createEntityGraph(Ord4.class);
                g.addAttributeNodes("customer");
                if (usecase.startsWith("明細頁")) {
                    g.addSubgraph("items").addAttributeNodes("product");
                }
                var sqls = spy(() -> em.createQuery(
                        "select o from Ord4 o where o.status = :st", Ord4.class)
                        .setParameter("st", St4.PENDING)
                        .setHint("jakarta.persistence.fetchgraph", g)
                        .getResultList());
                System.out.println("  " + usecase + " → " + sqls.size() + " 句");
            }
        });
    }
```

```
═══ 同一個查詢，兩個用例要不同的關聯 → 動態組 graph ═══
  列表頁（只要客戶名） → 1 句
  明細頁（要客戶＋明細＋商品） → 1 句
```

**同一句 JPQL，兩個用例，各自 1 句 SQL。**

📌 **這在 05 章（複雜查詢）會再用到**：
一個 `Specification` 組出 `where`，一個 `EntityGraph` 組出 `fetch`，
兩者互不干擾——**這是 JPA 少數真的很優雅的地方。**

### 4.6.5 實測：`@EntityGraph` 含集合 + 分頁 = 同一個陷阱

```java
    @Test
    void EntityGraph加分頁() {
        seed(200, 50, 2, 0);
        head("🔴 @EntityGraph 含集合 + Pageable");
        tx.executeWithoutResult(s -> {
            var sqls = spy(() -> {
                var page = orders.findByStatus(St4.PENDING,
                        org.springframework.data.domain.PageRequest.of(0, 20));
                System.out.println("  拿到 " + page.getNumberOfElements()
                        + " 筆、總數 " + page.getTotalElements());
            });
            grouped("SQL", sqls);
            System.out.println("  第一句有 limit 嗎 : " + sqls.get(0).contains("limit"));
        });
    }
```

```
═══ 🔴 @EntityGraph 含集合 + Pageable ═══
  拿到 20 筆、總數 200
── SQL → 共 2 句，2 種形狀
   ×1  select o1_0.id,o1_0.customer_id,c1_0.id,c1_0.display_name,c1_0.email,
         i1_0.order_id,i1_0.id,i1_0.line_amount,i1_0.product_id,i1_0.pro…
   ×1  select count(o1_0.id) from orders o1_0 where o1_0.status=?
  第一句有 limit 嗎 : false
```

🔴 **一模一樣的陷阱**：`limit` 消失、`HHH90003004`、記憶體分頁。

**因為 `@EntityGraph` 產生的就是 `JOIN FETCH`。** 它是一個更好的**寫法**，
不是一個不同的**機制**。

> ⚠️ **這一節要留下的規則**：
>
> > **`@EntityGraph` 的 `attributePaths` 裡出現集合，就不能配 `Pageable`。**
> > **而它不會編譯失敗、不會拋例外——只會慢，而且只在資料多的時候慢。**
>
> 📌 **這正好是 4.10 那條 CI 斷言要抓的東西之一**：
> 「這個分頁查詢的 SQL 裡必須有 `limit`」。

### 4.6.6 `@EntityGraph` 與 `JOIN FETCH` 怎麼選

| | `JOIN FETCH` | `@EntityGraph` |
|---|---|---|
| 產生的 SQL | join | **一樣是 join** |
| 寫在哪 | 查詢字串裡 | 查詢**外面**（註解或動態組） |
| 能不能配衍生查詢方法 | 🔴 不行（要自己寫 JPQL） | ✅ **可以**（`findByStatus…`） |
| 能不能配 `Specification` / Criteria | ⚠️ 很麻煩 | ✅ 可以 |
| 兩層關聯（明細 → 商品） | `join fetch o.items.product`（⚠️ 語法受限） | ✅ `subgraph` 很自然 |
| 可讀性 | 集合多的時候字串很長 | ✅ 清單式 |
| 一次 fetch 兩個集合 | 🔴 同樣的問題 | 🔴 同樣的問題 |
| 配分頁 | 🔴 同樣的問題 | 🔴 同樣的問題 |

📌 **本課的選擇**：

```
✅ 預設用 @EntityGraph —— 因為它可以配衍生查詢方法，也不用重複寫 where
✅ 只在需要「有條件的 join」時才自己寫 JPQL（而 4.6.7 會說明「有條件的 fetch」做不到）
```

### 4.6.7 實測：「只 fetch 符合條件的明細」做不到 🔴

一個很自然的需求：**「撈訂單，但只要數量大於 10 的明細」**。

```java
package com.example.lab.ch04;

import org.junit.jupiter.api.Test;

class C6bWith extends Base04 {

    @Test
    void 帶條件的fetchJoin() {
        seed(20, 20, 3, 0);
        for (String hql : new String[]{
            "select o from Ord4 o left join fetch o.items i with i.qty > 0 where o.status = :st",
            "select o from Ord4 o left join fetch o.items i on i.qty > 0 where o.status = :st",
            "select o from Ord4 o left join fetch o.items i where o.status = :st and i.qty > 0"
        }) {
            head(hql.substring(hql.indexOf("left join"),
                    Math.min(hql.length(), hql.indexOf("where"))));
            try {
                tx.executeWithoutResult(s -> {
                    var os = em.createQuery(hql, Ord4.class)
                            .setParameter("st", St4.PENDING).getResultList();
                    System.out.println("  ✅ 可以，拿到 " + os.size() + " 張");
                });
            } catch (Exception e) {
                Throwable r = e; while (r.getCause() != null && r.getCause() != r) r = r.getCause();
                System.out.println("  🔴 " + r.getClass().getSimpleName() + ": " + r.getMessage());
            }
        }
    }
}
```

```
═══ left join fetch o.items i with i.qty > 0  ═══
  🔴 SemanticException: Fetch join has a 'with' clause (use a filter instead)
═══ left join fetch o.items i on i.qty > 0  ═══
  🔴 SemanticException: Fetch join has a 'with' clause (use a filter instead)
═══ left join fetch o.items i  ═══
  ✅ 可以，拿到 20 張
```

**Hibernate 直接拒絕在 fetch join 上加條件。** 而它拒絕得很有道理：

```
「訂單」這個實體有一個屬性叫 items，它的定義是【這張訂單的所有明細】。
如果 fetch 回來的 items 只有一部分，那個物件就【不是】一個正確的 Ord4 ——
它是一個「看起來正常、但集合是殘缺的」東西。
```

⚠️⚠️ **而如果你把條件挪到 `where`（第三種寫法，它不報錯），Hibernate 就攔不住你了。**

```java
    @Test
    void 把條件放在where會怎樣() {
        seed(5, 5, 3, 0);       // 每張 3 筆明細：商品0 / 商品1 / 商品2
        head("🔴 用 where 過濾被 fetch 的集合");
        tx.executeWithoutResult(s -> {
            var os = em.createQuery("""
                    select o from Ord4 o
                      left join fetch o.items i
                     where o.status = :st and i.productName = '商品0'
                    """, Ord4.class).setParameter("st", St4.PENDING).getResultList();
            System.out.println("  拿到 " + os.size() + " 張訂單");
            System.out.println("  第一張的 items.size() = " + os.get(0).getItems().size()
                    + "   ← 資料庫實際有 " + jdbc.queryForObject(
                        "SELECT COUNT(*) FROM order_item WHERE order_id = ?",
                        Long.class, com.example.lab.Uuid7.toBytes(os.get(0).getId())) + " 筆");
        });

        head("換一個交易重新查（不過濾）");
        tx.executeWithoutResult(s -> {
            var o = orders.findById(firstOrderId).orElseThrow();
            System.out.println("  items.size() = " + o.getItems().size() + "   ✅");
        });
    }
```

```
═══ 🔴 用 where 過濾被 fetch 的集合 ═══
  拿到 5 張訂單
  第一張的 items.size() = 1   ← 資料庫實際有 3 筆
═══ 換一個交易重新查（不過濾） ═══
  items.size() = 3   ✅
```

🔴🔴 **`items.size()` 是 1，資料庫有 3 筆。而那個集合看起來完全正常。**

> ⚠️⚠️ **這不只是「讀到錯的資料」，它可能是【資料遺失】。**
>
> 把 02 章的定案接上來：`shop-service` 的 `Order.items` 是
> `cascade = ALL, orphanRemoval = true`。
>
> ```
> 你用上面那句 JPQL 撈出一張訂單（items 只有 1 筆，資料庫有 3 筆）
>    ↓
> 在同一個交易裡改了訂單的 status
>    ↓
> 交易 commit → 髒檢查（03 章 3.4）比對集合：
>    快照是「1 筆」（載入時就是 1 筆），現在也是 1 筆 → 集合不髒 → 這次沒事
> ```
>
> 這一次僥倖沒事，**因為快照是在「已被過濾」之後拍的**。
> 🔴 **但只要有任何一行程式碼碰了那個集合**
> （`order.addItem(...)`、`items.clear()` 再重建、甚至把它複製出去再設回來），
> **`orphanRemoval` 就會把「不在集合裡」的那 2 筆明細刪掉**（02 章 2.6.2）。

**要「只要符合條件的子資料」，正確的做法有三個**：

| 做法 | 說明 |
|---|---|
| ① **查子實體，不查父實體** | `select i from Item4 i where i.order.status = :st and i.qty > 10`——你想要的本來就是明細 |
| ② **DTO 投影**（05 章） | 回傳「訂單 + 符合條件的明細」的 DTO；那不是實體，沒有不變量要守 |
| ③ `@Filter`（Hibernate 專屬） | 例外訊息建議的做法。⚠️ 它是 **session 層級**的開關，會影響那個 session 裡所有查詢 |

📌 **① 是本課的選擇**，而它背後是一個更一般性的判斷：

> **「我要一個殘缺的實體」這個需求，通常代表你要的不是實體。**
> **那是 05 章 DTO 投影的主題。**

---

## 4.7 `@BatchSize` ★★

### 4.7.1 它不消滅 N+1

前面兩節的思路是「**把關聯 join 進主查詢**」。
`@BatchSize` 的思路完全不同：

> **關聯還是分開撈，但【一次撈 25 個】，而不是一次撈 1 個。**

```
沒有 @BatchSize：
   select … from order_item where order_id = ?     ← ×200

有 @BatchSize(25)：
   select … from order_item where order_id in (?,?,?,…25 個…)   ← ×8
```

📌 **所以它不是「解決」N+1，是「把 N 除以 25」**：

```
句數 = 1 + ⌈不同的 @ManyToOne 目標數 / size⌉ + ⌈集合數 / size⌉
```

⚠️ **而這個「不解決、只是除以 25」的性質，正是它最大的優點**：
**因為它不 join，所以它跟分頁完全相容**（4.7.6）。

### 4.7.2 實測：251 句 → 11 句

`@BatchSize` 要標在**兩個不同的地方**，這是最容易搞錯的一點：

```java
package com.example.lab.ch04;

import jakarta.persistence.*;
import org.hibernate.annotations.BatchSize;
import java.util.UUID;

/**
 * 跟 Cust4 同一張表，差別是類別上有 @BatchSize（4.7）。
 * ★ @ManyToOne 的批次抓取，@BatchSize 要標在【目標實體的類別】上，
 *   不是標在 @ManyToOne 那個欄位上。
 */
@Entity @Table(name = "customer")
@BatchSize(size = 25)
public class Cust4B extends Base4 {

    @Column(nullable = false, length = 255) private String email;
    @Column(name = "display_name", nullable = false, length = 64) private String displayName;

    protected Cust4B() {}
    public Cust4B(UUID id, String email, String displayName) {
        super(id); this.email = email; this.displayName = displayName;
    }
    public String getDisplayName() { return displayName; }
}
```

```java
package com.example.lab.ch04;

import jakarta.persistence.*;
import org.hibernate.annotations.BatchSize;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/** 跟 Ord4 同一張表：關聯上加 @BatchSize（4.7）。 */
@Entity @Table(name = "orders")
public class Ord4Batch extends Base4 {

    @Column(name = "order_no", nullable = false, length = 32) private String orderNo;

    /** 目標是 Cust4B —— 它的【類別】上有 @BatchSize(25)。 */
    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "customer_id", nullable = false) private Cust4B customer;

    @Enumerated(EnumType.STRING) @JdbcTypeCode(SqlTypes.VARCHAR)
    @Column(nullable = false, length = 16) private St4 status;

    @Column(name = "total_amount", nullable = false, precision = 19, scale = 4)
    private BigDecimal totalAmount = BigDecimal.ZERO;
    @Column(name = "placed_at", nullable = false) private Instant placedAt;

    /** ★ 集合的批次抓取：@BatchSize 標在【集合欄位】上。 */
    @OneToMany(mappedBy = "order")
    @BatchSize(size = 25)
    private List<Item4> items = new ArrayList<>();

    protected Ord4Batch() {}
    public String getOrderNo() { return orderNo; }
    public Cust4B getCustomer() { return customer; }
    public List<Item4> getItems() { return items; }
}
```

```java
package com.example.lab.ch04;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface Ord4BatchRepo extends JpaRepository<Ord4Batch, UUID> {
    List<Ord4Batch> findByStatus(St4 status);
    Page<Ord4Batch> findByStatusOrderByPlacedAt(St4 status, Pageable page);
}
```

```java
package com.example.lab.ch04;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.UUID;

public interface Cust4BRepo extends JpaRepository<Cust4B, UUID> {}
```

```java
package com.example.lab.ch04;

import org.junit.jupiter.api.Test;
import org.springframework.data.domain.PageRequest;

class C7Batch extends Base04 {

    @org.springframework.beans.factory.annotation.Autowired Ord4BatchRepo batchOrders;

    @Test
    void 兩百五十一句變幾句() {
        seed(200, 50, 2, 0);
        head("同一頁，換成有 @BatchSize(25) 的實體");
        var st = stats(); st.reset();
        var sqls = spy(() -> tx.executeWithoutResult(s -> {
            for (Ord4Batch o : batchOrders.findByStatus(St4.PENDING)) {
                o.getCustomer().getDisplayName();
                o.getItems().size();
            }
        }));
        grouped("@BatchSize(25)", sqls);
        System.out.println("   PcSpy : " + st.summary());
    }
}
```

```
═══ 同一頁，換成有 @BatchSize(25) 的實體 ═══
── @BatchSize(25) → 共 11 句，3 種形狀
   ×1  select ob1_0.id,ob1_0.customer_id,ob1_0.order_no,ob1_0.placed_at,ob1_0.status,
         ob1_0.total_amount from orders ob1_0 where ob1_0.status=?
   ×2  select cb1_0.id,cb1_0.display_name,cb1_0.email from customer cb1_0
         where cb1_0.id in (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
   ×8  select i1_0.order_id,i1_0.id,… from order_item i1_0 where i1_0.order_id in (?,?,…)
   PcSpy : stmt=11  entityLoad=650  entityFetch=2  collLoad=200  collFetch=8
```

**251 句 → 11 句。而程式碼一個字都沒改** —— 只加了兩個註解。

**算一下那 11 句**：

```
1  主查詢
2  客戶：50 個不同的客戶 ÷ 25 = ⌈2⌉ 句
8  明細：200 個集合 ÷ 25 = 8 句
──
11
```

📌 **注意 `PcSpy` 的變化**：

```
沒 @BatchSize：entityFetch=50   collFetch=200   → N+1 分數 250
有 @BatchSize：entityFetch=2    collFetch=8     → N+1 分數 10
```

⚠️ **N+1 的分數變成 10，不是 0。**
所以 4.10 那條斷言對 `@BatchSize` 要用「上限」而不是「必須為 0」——
這是一個要**明確做出的決定**，不是漏掉。

### 4.7.3 實測：那句 `in` 長什麼樣

```java
    @Test
    void 那一句in長什麼樣() {
        seed(200, 50, 2, 0);
        head("批次抓取的 SQL 形狀");
        tx.executeWithoutResult(s -> {
            var sqls = spy(() -> {
                var os = batchOrders.findByStatus(St4.PENDING);
                os.get(0).getItems().size();          // 只碰第一張
            });
            grouped("只碰第一張訂單的明細", sqls);
        });
    }
```

```
═══ 批次抓取的 SQL 形狀 ═══
── 只碰第一張訂單的明細 → 共 2 句，2 種形狀
   ×1  select ob1_0.id,… from orders ob1_0 where ob1_0.status=?
   ×1  select i1_0.order_id,… from order_item i1_0 where i1_0.order_id in (?,?,…)
```

⚠️ **我只碰了第一張訂單，而它把 25 張訂單的明細都撈了。**

**這是 `@BatchSize` 的運作方式**：

```
你碰 orders[0].getItems()
   ↓
Hibernate 看一眼持久化情境：「還有哪些 Ord4Batch 的 items 是未初始化的？」
   ↓
挑出最多 25 個（包含 orders[0]），組一句 in 查詢，一次撈回來
   ↓
所以下一次你碰 orders[1..24] 的 items，都是 0 句 SQL
```

📌 **兩個推論**：

```
✅ 如果你【只需要第一張】的明細，@BatchSize 讓你多撈了 24 張的（浪費）
✅ 如果你要跑迴圈碰【全部】，@BatchSize 幫你省了 24 句（划算）
```

**而列表頁永遠是後者**——所以它很適合。

### 4.7.4 batch size 怎麼挑

```java
    @Test
    void batch大小怎麼影響句數() {
        head("200 張訂單 + 50 個客戶，不同 batch size 的句數");
        System.out.println("  batch  客戶(50 個)  明細(200 個)  合計");
        for (int b : new int[]{1, 10, 25, 50, 100}) {
            int c = (int) Math.ceil(50.0 / b), i = (int) Math.ceil(200.0 / b);
            System.out.printf("  %4d %10d %13d %6d%n", b, c, i, 1 + c + i);
        }
    }
```

```
═══ 200 張訂單 + 50 個客戶，不同 batch size 的句數 ═══
  batch  客戶(50 個)  明細(200 個)  合計
     1         50           200    251        ← 等於沒開
    10          5            20     26
    25          2             8     11
    50          1             4      6
   100          1             2      4
```

**看起來越大越好。而它有三個上界**：

```
🔴 ① SQL 的參數個數上限
      Oracle 的 in 最多 1000 個；MySQL 受 max_allowed_packet 與解析成本限制
🔴 ② 每一個不同的參數個數，都是一句【不同形狀】的 SQL
      Hibernate 會為 25、13、7、3、1 … 各準備一句
      → statement cache 被塞滿，命中率下降
🔴 ③ 一次撈太多，就是在做「你可能不需要的工作」（4.7.3 那個「只碰第一張」的情況）
```

**②值得說明一下。** 你可能以為 Hibernate 會用 25 個參數配 `null` 補齊，
但實測的那句 `in (?,?,…)` 剛好是 25 個，
而**最後一批只剩 200 - 8×25 = 0 個**，所以這個例子看不出來。
如果是 210 個集合，最後一批只有 10 個 → Hibernate 會另外組一句 10 參數的 SQL。

📌 **實務建議**：

```
✅ 一般用 10～50。本課用 25
✅ 資料量大、迴圈一定會跑完全部 → 用 50～100
🔴 不要超過 100 —— 邊際效益很小（4 句 vs 6 句），而 SQL 形狀爆炸
```

### 4.7.5 實測：全域的 `default_batch_fetch_size`

**你不需要在每個關聯上貼註解**：

```java
package com.example.lab.ch04;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;

/** 4.7.5：全域的 default_batch_fetch_size —— 不用改任何實體。 */
@SpringBootTest(properties = {
  "spring.datasource.url=jdbc:mysql://127.0.0.1:33306/ch04"
      + "?connectionTimeZone=UTC&forceConnectionTimeZoneToSession=true"
      + "&preserveInstants=true&characterEncoding=UTF-8",
  "spring.jpa.properties.hibernate.generate_statistics=true",
  "spring.jpa.properties.hibernate.default_batch_fetch_size=25"
})
class C7bGlobalBatch extends Base04 {

    @Test
    void 完全沒有註解的Ord4也批次了() {
        seed(200, 50, 2, 0);
        head("Ord4 上一個 @BatchSize 都沒有，只加了一行組態");
        var st = stats(); st.reset();
        var sqls = spy(() -> tx.executeWithoutResult(s -> {
            for (Ord4 o : orders.findByStatus(St4.PENDING)) {
                o.getCustomer().getDisplayName();
                o.getItems().size();
            }
        }));
        grouped("default_batch_fetch_size=25", sqls);
        System.out.println("   PcSpy : " + st.summary());
    }
}
```

```
═══ Ord4 上一個 @BatchSize 都沒有，只加了一行組態 ═══
── default_batch_fetch_size=25 → 共 11 句，3 種形狀
   ×1  select o1_0.id,… from orders o1_0 where o1_0.status=?
   ×2  select c1_0.id,… from customer c1_0 where c1_0.id in (?,?,…25 個…)
   ×8  select i1_0.order_id,… from order_item i1_0 where i1_0.order_id in (?,?,…)
   PcSpy : stmt=11  entityLoad=650  entityFetch=2  collLoad=200  collFetch=8
```

**跟 4.7.2 一字不差的 11 句，而 `Ord4` 上一個註解都沒有。**

```yaml
spring:
  jpa:
    properties:
      hibernate:
        default_batch_fetch_size: 25     # ★ 一行，全站生效
```

> 📌 **這是本課最推薦的一個組態，理由有三個**：
>
> ```
> ① 它是【安全網】：即使你漏了一個 @EntityGraph，最壞情況也是 ⌈N/25⌉ 而不是 N
> ② 它不改變任何語意 —— 撈到的資料一模一樣，只是撈的次數少了
> ③ 它對「已經寫好的舊程式碼」立刻生效，不需要改任何一行 Java
> ```
>
> ⚠️ **而它不能取代 4.5／4.6**：
> 11 句還是比 1 句慢，而且 `@BatchSize` **不會**幫你解決
> 4.2.5 那個「兩層關聯」的問題（`items → product` 還是要 subgraph）。
>
> **它是安全網，不是解法。**

### 4.7.6 實測：`@BatchSize` + 分頁 —— 分頁場景的最佳解 ★★

4.5.5 證明了「fetch 集合 + 分頁」是壞的。
4.5.6 給了一個兩段式的解法（2 句、要自己重排順序）。
**這一節給一個更好的。**

（下面這個方法屬於 4.7.2 那個 `C7Batch` 類別，它已經宣告了 `batchOrders`。）

```java
    @Test
    void BatchSize加分頁() {
        seed(2000, 50, 2, 0);
        head("✅ @BatchSize + 分頁");
        var st = stats(); st.reset();
        var sqls = spy(() -> tx.executeWithoutResult(s -> {
            var page = batchOrders.findByStatusOrderByPlacedAt(St4.PENDING,
                    PageRequest.of(0, 20));
            page.forEach(o -> { o.getCustomer().getDisplayName(); o.getItems().size(); });
            System.out.println("  拿到 " + page.getNumberOfElements()
                    + " 筆／總數 " + page.getTotalElements());
        }));
        grouped("SQL", sqls);
        System.out.println("   PcSpy : " + st.summary());
        System.out.println("   第一句有 limit 嗎 : " + sqls.get(0).contains("limit"));
        tx.executeWithoutResult(s -> {
            var page = batchOrders.findByStatusOrderByPlacedAt(St4.PENDING,
                    PageRequest.of(0, 20));
            page.forEach(o -> { o.getCustomer().getDisplayName(); o.getItems().size(); });
            System.out.println("   PC 裡有 "
                    + em.unwrap(org.hibernate.engine.spi.SessionImplementor.class)
                        .getPersistenceContext().getNumberOfManagedEntities() + " 個實體");
        });
    }
```

```
═══ ✅ @BatchSize + 分頁 ═══
  拿到 20 筆／總數 2000
── SQL → 共 4 句，4 種形狀
   ×1  select ob1_0.id,… from orders ob1_0 where ob1_0.status=? order by … limit ?,?
   ×1  select count(ob1_0.id) from orders ob1_0 where ob1_0.status=?
   ×1  select cb1_0.id,… from customer cb1_0 where cb1_0.id in (?,?,…)
   ×1  select i1_0.order_id,… from order_item i1_0 where i1_0.order_id in (?,?,…)
   PcSpy : stmt=4  entityLoad=80  entityFetch=1  collFetch=1  collLoad=20
   第一句有 limit 嗎 : true
   PC 裡有 80 個實體
```

✅✅ **4 句、`limit` 在 SQL 裡、PC 裡只有 80 個實體。**

**跟 4.5.5 / 4.5.6 三種寫法的完整對照**（2000 張訂單，第一頁 20 筆）：

| 寫法 | SQL 句數 | 有 `limit` | 時間 | PC 裡的實體 | 要自己重排順序 |
|---|---|---|---|---|---|
| `JOIN FETCH` + 分頁 | 1 | 🔴 **沒有** | **107 ms** | **6,000** | — |
| 兩段式（4.5.6） | 2 | ✅ | **9 ms** | 80 | 🔴 **要** |
| **`@BatchSize` + 分頁** | 4 | ✅ | ~10 ms | 80 | ✅ **不用** |

> 📌 **這是這一章最實用的一個結論**：
>
> > **分頁的列表頁：`@ManyToOne` 用 `@EntityGraph` join 進來，
> > 集合完全不 fetch，交給 `@BatchSize`。**
>
> 那 4 句分別是：**資料（有 limit）、`count`、客戶（一句 `in`）、明細（一句 `in`）**。
> **每一句都是必要的，而且沒有一句會隨資料總量成長。**

⚠️ **那句 `count` 是 `Page` 帶來的**。如果你不需要總筆數，
改回傳 `Slice` 或 `List` 就少一句（07 站 03 章討論過 `count` 在大表上的成本）。

**4.11 的 `shop-service` 列表頁就是這個做法。**

---

## 4.8 另外兩種解法

### 4.8.1 實測：`@Fetch(SUBSELECT)`

```java
package com.example.lab.ch04;

import jakarta.persistence.*;
import org.hibernate.annotations.Fetch;
import org.hibernate.annotations.FetchMode;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/** 跟 Ord4 同一張表：集合用 @Fetch(SUBSELECT)（4.8.1）。 */
@Entity @Table(name = "orders")
public class Ord4Sub extends Base4 {

    @Column(name = "order_no", nullable = false, length = 32) private String orderNo;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "customer_id", nullable = false) private Cust4 customer;

    @Enumerated(EnumType.STRING) @JdbcTypeCode(SqlTypes.VARCHAR)
    @Column(nullable = false, length = 16) private St4 status;

    @Column(name = "total_amount", nullable = false, precision = 19, scale = 4)
    private BigDecimal totalAmount = BigDecimal.ZERO;
    @Column(name = "placed_at", nullable = false) private Instant placedAt;

    @OneToMany(mappedBy = "order")
    @Fetch(FetchMode.SUBSELECT)
    private List<Item4> items = new ArrayList<>();

    protected Ord4Sub() {}
    public Cust4 getCustomer() { return customer; }
    public List<Item4> getItems() { return items; }
}
```

```java
package com.example.lab.ch04;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.UUID;

public interface Ord4SubRepo extends JpaRepository<Ord4Sub, UUID> {}
```

```java
package com.example.lab.ch04;

import org.junit.jupiter.api.Test;

class C8Compare extends Base04 {

    @org.springframework.beans.factory.annotation.Autowired Ord4BatchRepo batchOrders;
    @org.springframework.beans.factory.annotation.Autowired Ord4SubRepo   subOrders;

    @Test
    void subselect() {
        seed(200, 50, 2, 0);
        head("@Fetch(FetchMode.SUBSELECT)");
        var st = stats(); st.reset();
        var sqls = spy(() -> tx.executeWithoutResult(s -> {
            var os = em.createQuery("select o from Ord4Sub o where o.status = :st", Ord4Sub.class)
                    .setParameter("st", St4.PENDING).getResultList();
            os.forEach(o -> o.getItems().size());
        }));
        grouped("SQL", sqls);
        System.out.println("   PcSpy : " + st.summary());
    }
}
```

```
═══ @Fetch(FetchMode.SUBSELECT) ═══
── SQL → 共 2 句，2 種形狀
   ×1  select os1_0.id,os1_0.customer_id,… from orders os1_0 where os1_0.status=?
   ×1  select i1_0.order_id,i1_0.id,… from order_item i1_0
         where i1_0.order_id in (select … from orders where status = ?)   ← 子查詢
   PcSpy : stmt=2  entityLoad=600  entityFetch=0  collFetch=1  collLoad=200
```

**2 句，而且第二句用「原本那個查詢」當子查詢，把 200 個集合一次撈回來。**

**它跟 `@BatchSize` 的差別**：

| | `@BatchSize(25)` | `@Fetch(SUBSELECT)` |
|---|---|---|
| 集合的句數 | `⌈200/25⌉ = 8` | **1** |
| 那一句的 `where` | `in (?,?,…25 個 id…)` | `in (原本的查詢)` |
| **配分頁** | ✅ 可以 | 🔴 **不行**（見下） |
| 適用範圍 | 所有情況 | **只有「集合的擁有者是剛剛那個查詢撈出來的」** |

🔴 **`SUBSELECT` 不能配分頁**，而且它的失敗方式很陰險：

```
你的主查詢是 … where status = ? limit 20
   ↓
SUBSELECT 的子查詢會【重跑主查詢的 where，但不帶 limit】
   ↓
於是它撈回【2000 張訂單】的明細，而你只要 20 張的
```

📌 **所以 `SUBSELECT` 的定位很窄**：
「**不分頁的、把整批資料撈出來處理**」——例如批次作業、匯出報表。
而那種場景通常 `JOIN FETCH` 也可以，`SUBSELECT` 的優勢只在「避免笛卡兒積」。

⚠️ **另一個限制**：`@Fetch` 是 **Hibernate 專屬**的註解，不是 JPA 規格。
如果你的專案有「不綁 Hibernate」的要求（00 章 0.6.6 那條軸），它不能用。

### 4.8.2 實測：手動預熱一級快取 —— 對 `@ManyToOne` 有效，對集合無效 ★★

一個很自然的想法：既然一級快取「同一個 id 只查一次」（03 章 3.3.1），
那我**先把所有關聯資料撈進持久化情境**，迴圈不就一句 SQL 都不用打了？

```java
    @Test
    void 手動預熱一級快取() {
        seed(200, 50, 2, 0);
        head("① 先把【客戶】全部撈進一級快取，再跑迴圈");
        tx.executeWithoutResult(s -> {
            List<Ord4> os = orders.findByStatus(St4.PENDING);
            em.createQuery("select c from Cust4 c where c.id in "
                    + "(select o.customer.id from Ord4 o where o.status = :st)", Cust4.class)
                    .setParameter("st", St4.PENDING).getResultList();
            var after = spy(() -> os.forEach(o -> o.getCustomer().getDisplayName()));
            System.out.println("  迴圈讀 customer → " + after.size() + " 句");
        });

        head("② 先把【明細】全部撈進一級快取，再跑迴圈");
        tx.executeWithoutResult(s -> {
            List<Ord4> os = orders.findByStatus(St4.PENDING);
            List<java.util.UUID> ids = os.stream().map(Ord4::getId).toList();
            var loaded = em.createQuery(
                    "select i from Item4 i where i.order.id in :ids", Item4.class)
                    .setParameter("ids", ids).getResultList();
            System.out.println("  已經撈進 PC 的明細 : " + loaded.size() + " 筆");
            var after = spy(() -> os.forEach(o -> o.getItems().size()));
            System.out.println("  迴圈讀 items → " + after.size() + " 句");
        });
    }
```

```
═══ ① 先把【客戶】全部撈進一級快取，再跑迴圈 ═══
  迴圈讀 customer → 0 句   ✅ 一級快取命中

═══ ② 先把【明細】全部撈進一級快取，再跑迴圈 ═══
  已經撈進 PC 的明細 : 400 筆
  迴圈讀 items → 200 句   🔴 完全沒有命中
```

🔴🔴 **400 筆明細已經在持久化情境裡了，而迴圈還是打了 200 句。**

**為什麼——這是 03 章 3.3.6 的直接後果**：

```
持久化情境裡有【兩張表】（03 章 3.3.6）：

① entitiesByKey       (類別, id) → 實體物件
      → 「這個客戶我有了」查得到      → ① 命中 ✅

② collectionEntries   集合物件 → { initialized: true/false, 快照 }
      → 「Ord4#123 的 items 載入了嗎」是【這一張】上的旗標
      → 而你把 400 個 Item4 放進①，完全不會動到②
      → 所以那 200 個集合還是 initialized = false  → 各撈一次 🔴
```

> 📌 **一句話**：
> **一級快取的 key 是「實體的 id」，不是「關聯的內容」。**
> **所以它幫得了 `@ManyToOne`（那就是一個 id 查詢），幫不了集合。**

⚠️ **這也解釋了 4.7 的 `@BatchSize` 為什麼要分兩個地方標**：

```
@ManyToOne 的批次 → 標在【目標實體類別】上（它處理的是「一批 id」）
集合的批次        → 標在【集合欄位】上（它處理的是「一批未初始化的集合」）
```

**兩者是不同的機制，所以 `@BatchSize` 要標兩次。**

📌 **而 ① 那個「先撈客戶」的技巧本身是有用的**：

```java
// 一個沒有 @BatchSize、又不想改實體的舊系統，可以這樣救 @ManyToOne 的 N+1
List<Ord4> os = orders.findByStatus(status);
customers.findAllById(os.stream().map(o -> o.getCustomer().getId()).toList());  // 一句 in
// 之後迴圈讀 o.getCustomer().getXxx() → 0 句
```

⚠️ 但它**只對 `@ManyToOne` / `@OneToOne` 有效**，而且它比 `@BatchSize` 囉唆得多。

### 4.8.3 DTO 投影（05 章）

還有一個這一章刻意沒用的解法：

```java
// 05 章的寫法：根本不要實體
select new com.example.OrderRow(o.id, o.orderNo, o.status, o.totalAmount, c.displayName)
  from Ord4 o join o.customer c
 where o.status = :st
```

**它的句數是 1，而且**：

```
① 沒有實體 → 不進持久化情境 → 沒有快照、沒有髒檢查（03 章 3.4.8）
② 沒有集合 → 沒有笛卡兒積、沒有 MultipleBagFetchException
③ 可以分頁 → 因為 limit 切在「一列 = 一筆結果」上
```

📌 **00 章 0.7 結論三那個「同樣 1 句 SQL，JPA 比 MyBatis 慢 3 倍」的差距，
就是 DTO 投影可以消掉的部分。**

⚠️ **而它的代價是「你拿到的東西不能改」**——這正是它的優點（唯讀查詢本來就不該改）。
**05 章會完整處理，包含「明細怎麼辦」（一個 DTO 裡要不要有集合）。**

---

## 4.9 五種解法對照與決策表 ★★

### 4.9.1 實測：同一頁，五種寫法

（下面兩個方法屬於 4.8.1 那個 `C8Compare` 類別。）

```java
    @Test
    void 五種解法對照() {
        seed(200, 50, 2, 0);
        head("同一頁（200 張訂單 / 50 客戶 / 400 明細），五種寫法");
        System.out.printf("  %-22s %6s %8s %10s %8s%n", "寫法", "SQL", "DB列數", "PC實體", "ms");

        row("① 天真（LAZY）", () -> {
            for (Ord4 o : orders.findByStatus(St4.PENDING)) {
                o.getCustomer().getDisplayName(); o.getItems().size();
            }
        }, 200);

        row("② JOIN FETCH", () -> {
            for (Ord4 o : orders.fetchAll(St4.PENDING)) {
                o.getCustomer().getDisplayName(); o.getItems().size();
            }
        }, 400);

        row("③ @EntityGraph", () -> {
            for (Ord4 o : orders.findByStatusOrderByOrderNo(St4.PENDING)) {
                o.getCustomer().getDisplayName(); o.getItems().size();
            }
        }, 400);

        row("④ @BatchSize(25)", () -> {
            for (Ord4Batch o : batchOrders.findByStatus(St4.PENDING)) {
                o.getCustomer().getDisplayName(); o.getItems().size();
            }
        }, 200);

        row("⑤ SUBSELECT(只集合)", () -> {
            var os = em.createQuery("select o from Ord4Sub o where o.status = :st", Ord4Sub.class)
                    .setParameter("st", St4.PENDING).getResultList();
            os.forEach(o -> o.getItems().size());
        }, 200);

        row("⑤b SUBSELECT+客戶", () -> {
            var os = em.createQuery("select o from Ord4Sub o where o.status = :st", Ord4Sub.class)
                    .setParameter("st", St4.PENDING).getResultList();
            os.forEach(o -> { o.getCustomer().getDisplayName(); o.getItems().size(); });
        }, 200);
    }

    private void row(String label, Runnable body, int dbRows) {
        final int[] sqlCount = new int[1];
        final int[] pcSize = new int[1];
        tx.executeWithoutResult(s -> {
            var sqls = spy(body);
            sqlCount[0] = sqls.size();
            pcSize[0] = em.unwrap(org.hibernate.engine.spi.SessionImplementor.class)
                    .getPersistenceContext().getNumberOfManagedEntities();
        });
        long ms = bestMs(() -> tx.executeWithoutResult(s -> body.run()), 3, 5);
        System.out.printf("  %-22s %6d %8d %10d %8d%n", label, sqlCount[0], dbRows, pcSize[0], ms);
    }
```

```
═══ 同一頁（200 張訂單 / 50 客戶 / 400 明細），五種寫法 ═══
  寫法                        SQL     DB列數       PC實體       ms
  ① 天真（LAZY）                251      200        650       62
  ② JOIN FETCH                1      400        650        6
  ③ @EntityGraph              1      400        650        6
  ④ @BatchSize(25)           11      200        650        9
  ⑤ SUBSELECT(只集合)            2      200        600        5
  ⑤b SUBSELECT+客戶            52      200        650       14
```

**五個觀察**：

**① 只有天真寫法是「錯的」。** 其他四種都在 5～14 ms，而它是 62 ms。

> 📌 **這是這張表最重要的訊息**：
> **修好 N+1 的收益（62 → 6 ms）遠大於「選對哪一種解法」的收益（6 → 5 ms）。**
> **先修，再優化。**

**② `JOIN FETCH` 與 `@EntityGraph` 的數字一模一樣**——因為它們產生同一句 SQL（4.6.6）。

**③ `SUBSELECT` 最快（5 ms），但只解了集合。**
`⑤b` 加上客戶就變成 52 句、14 ms——因為 `Ord4Sub` 的 `customer` 上**沒有** `@BatchSize`。

> ⚠️ **這是一個很值得記的陷阱**：
> **你「修好」了集合的 N+1，而 `@ManyToOne` 的 N+1 還在。**
> 而 `SqlSpy` 會告訴你「52 句」，`PcSpy` 會告訴你 `entityFetch = 50`——**兇手是誰一目了然。**

**④ `DB列數` 那一欄是 `JOIN FETCH` 的代價**：200 → 400。
在這個規模上無感，而 4.5.2 算過它會長成幾千倍。

**⑤ `PC實體` 全部是 650**（200 訂單 + 400 明細 + 50 客戶）。

> 📌 **這一欄提醒了一件事：五種解法都沒有減少「載入的實體數」。**
> **它們只改變了「用幾句 SQL 載入」。**
> **要減少實體數，只有 DTO 投影（05 章）—— 而那是下一章的主題。**

### 4.9.2 先問四個問題

面對一個 N+1，**不要直接選工具，先回答四個問題**：

```
Q1. 這個查詢【要不要分頁】？
       要 → 集合就不能 fetch（4.5.5）。跳到 Q3
       不要 → 可以 fetch

Q2. 要撈【幾個】集合？
       0 個 → JOIN FETCH / @EntityGraph（@ManyToOne 隨便 fetch）
       1 個 → JOIN FETCH / @EntityGraph
       2 個以上 → 只 fetch 最大的那一個，其餘交給 @BatchSize（4.5.4）

Q3. 這個結果【要不要修改】？
       不要（唯讀） → 認真考慮 DTO 投影（05 章）—— 它連實體都不建
       要 → 需要實體，往下

Q4. 每一筆的關聯資料【平均幾筆】？
       很少（1～5） → 什麼都可以
       很多（幾十上百） → 🔴 不要 fetch 集合（笛卡兒積）。用 @BatchSize
                          或者：這個用例真的需要「全部明細」嗎？
```

### 4.9.3 決策表

| 場景 | 用什麼 | 為什麼 |
|---|---|---|
| **單筆明細頁**（一張訂單 + 客戶 + 明細 + 商品） | **`@EntityGraph` + `subgraph`** | 1 句撈齊；沒有分頁問題；子集合數量可控（4.6.2 的 ③） |
| **不分頁的列表**（匯出、批次） | **`JOIN FETCH` 一個集合** | 1 句；明細多的時候改 `@BatchSize` |
| **分頁列表** ★ | **`@EntityGraph`(只含 `@ManyToOne`) + 集合靠 `@BatchSize`** | 唯一同時滿足 `limit` 與少句數的組合（4.7.6） |
| **只讀幾個欄位的列表 / 報表** | **DTO 投影**（05 章） | 不建實體、不進 PC、可分頁 |
| **兩個以上集合** | 只 fetch 一個 + 其餘 `@BatchSize` | 避免笛卡兒積（4.5.2） |
| **要「只撈符合條件的子資料」** | 🔴 **改成查子實體** | fetch join 不能加條件，硬做會得到殘缺的集合（4.6.7） |
| **接手一個到處都 N+1 的舊系統** | 先加 `default_batch_fetch_size: 25` | 一行組態、不改 Java、立刻把 N 變成 N/25（4.7.5） |
| **關聯很大的欄位（`TEXT`/`BLOB`）** | 拆表 + 一對一擁有方，或 DTO 投影 | `@Basic(fetch = LAZY)` 沒有 enhancement 就無效（4.3.6） |

📌 **本課 `shop-service` 的兩條路，就是這張表的第 1 列與第 3 列**（4.11）。

### 4.9.4 三個常見的錯誤選擇

**錯誤一：「先全部改成 `EAGER`，之後再調整。」**

🔴 4.4.3 證明了它在列表查詢上**完全無效**（還是 251 句），
而它在所有其他路徑上都讓你多撈。**它是負收益的。**

---

**錯誤二：「`JOIN FETCH` 最快，所以全部用它。」**

🔴 4.5.5：一碰到分頁就變成記憶體分頁（107 ms / 6000 個實體）。
🔴 4.5.2：兩個集合就是笛卡兒積。

📌 **`JOIN FETCH` 的適用範圍是「單筆」與「不分頁的小批次」。**

---

**錯誤三：「加了 `default_batch_fetch_size` 就不用管 N+1 了。」**

🔴 它把 251 變成 11，那是很好的**保底**。而 11 句還是比 1 句慢，
**而且它對「兩層關聯」（4.2.5 的來源四）幫助有限**——
`items → product` 這一層還是要 subgraph。

📌 **`@BatchSize` 是安全網，不是設計。**
**一個用例該撈什麼，還是要在那個用例上講清楚。**

---

## 4.10 把 N+1 變成 CI 會擋下來的東西 ★★

4.2.4 證明了「在測試環境數 SQL 句數」是不可靠的：
同一段程式碼在 3 個客戶時是 204 句、在 200 個客戶時是 401 句。

**所以斷言不能寫「必須少於 20 句」。** 它必須寫成一個**跟資料量無關**的東西。

### 4.10.1 兩個關鍵計數器

Hibernate 的統計裡剛好有這兩個：

| 計數器 | 意思 |
|---|---|
| `entityFetchCount` | 有幾個實體是**代理初始化時額外撈的** → `@ManyToOne` / `@OneToOne` 的 N+1 |
| `collectionFetchCount` | 有幾個集合是**另外一句 SQL 撈的** → `@OneToMany` 的 N+1 |

⚠️ **要跟另外兩個很像的計數器分清楚**：

```
entityLoadCount       = 一共建了幾個實體物件（包含 join 進來的）→ 【不是】N+1 指標
collectionLoadCount   = 一共載入了幾個集合（包含 join 進來的）  → 【不是】N+1 指標

entityFetchCount      = 其中有幾個是【額外一句 SQL】撈的        → ★ 這個才是
collectionFetchCount  = 其中有幾個是【額外一句 SQL】撈的        → ★ 這個才是
```

**回頭看 4.4.5 那組數字，這個區別就很清楚了**：

```
JOIN FETCH：collLoad = 200、collFetch = 0
            └─ 200 個集合都載入了，但沒有一個是額外查詢 → 沒有 N+1 ✅
```

📌 **所以 N+1 的定義可以寫成一個數字**：

> **N+1 分數 = `entityFetchCount + collectionFetchCount`**
> **一次撈齊 = 0。**

**這個數字跟資料量無關**——3 個客戶時是 0，300 萬個客戶時還是 0。

### 4.10.2 `NPlus1Spy`

```java
package com.example.lab.ch04;

import jakarta.persistence.EntityManagerFactory;
import org.hibernate.SessionFactory;
import org.hibernate.stat.Statistics;

/**
 * 4.10：把 N+1 變成一個可以斷言的數字。
 *
 * 關鍵在 Hibernate 統計裡這兩個計數器：
 *   entityFetchCount     —— 有幾個實體是「代理初始化」時【額外】撈的
 *   collectionFetchCount —— 有幾個集合是【另外一句 SQL】撈的
 * 兩者都是 0，代表這個用例需要的資料是【一次撈齊】的。
 */
public final class NPlus1Spy {

    private final Statistics s;

    public NPlus1Spy(EntityManagerFactory emf) {
        this.s = emf.unwrap(SessionFactory.class).getStatistics();
        if (!s.isStatisticsEnabled()) {
            throw new IllegalStateException("要先開 hibernate.generate_statistics=true");
        }
    }

    public Result watch(Runnable body) {
        s.clear();
        body.run();
        return new Result(s.getPrepareStatementCount(),
                          s.getEntityFetchCount(),
                          s.getCollectionFetchCount(),
                          s.getEntityLoadCount(),
                          s.getCollectionLoadCount());
    }

    public record Result(long statements, long entityFetch, long collectionFetch,
                         long entityLoad, long collectionLoad) {

        /** N+1 的分數：0 = 一次撈齊。 */
        public long nPlus1Score() { return entityFetch + collectionFetch; }

        /** 這個用例必須一次撈齊。 */
        public Result assertNoNPlus1() {
            if (nPlus1Score() > 0) {
                throw new AssertionError(String.format(
                    "N+1：額外撈了 %d 個實體、%d 個集合（共 %d 句 SQL）。%s",
                    entityFetch, collectionFetch, statements, hint()));
            }
            return this;
        }

        /** 允許批次抓取，但額外的查詢不能超過 max 次。 */
        public Result assertAtMostExtraQueries(int max) {
            if (nPlus1Score() > max) {
                throw new AssertionError(String.format(
                    "額外查詢 %d 次，超過上限 %d。%s", nPlus1Score(), max, hint()));
            }
            return this;
        }

        /** ★ 錯誤訊息直接指出兇手是哪一類關聯。 */
        private String hint() {
            if (entityFetch > 0 && collectionFetch > 0) return "兩個都要處理：@ManyToOne 與集合";
            if (entityFetch > 0) return "兇手是 @ManyToOne / @OneToOne（4.5 或 4.7）";
            return "兇手是集合（4.5、4.7 或 4.8）";
        }

        @Override public String toString() {
            return String.format("stmt=%d  entityFetch=%d  collFetch=%d  → N+1 分數 %d",
                    statements, entityFetch, collectionFetch, nPlus1Score());
        }
    }
}
```

⚠️ **兩個使用上的限制**：

```
🔴 ① Hibernate 的統計是【全域】的，不是「這個交易」的
      → 每次量之前要 clear()（watch() 幫你做了）
      → 而測試【不能平行跑】

🔴 ② 它只看得到 Hibernate
      → MyBatis / JdbcTemplate 的 SQL 完全不在裡面（00 章 0.10.3 那把尺才看得到）
```

### 4.10.3 實測：五種寫法的分數

```java
package com.example.lab.ch04;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertThrows;

class C9Guard extends Base04 {

    @org.springframework.beans.factory.annotation.Autowired Ord4BatchRepo batchOrders;

    @Test
    void N加1分數() {
        seed(200, 50, 2, 0);
        var spy = new NPlus1Spy(emf);
        head("五種寫法的 N+1 分數");

        var a = spy.watch(() -> tx.executeWithoutResult(s ->
            orders.findByStatus(St4.PENDING).forEach(o -> {
                o.getCustomer().getDisplayName(); o.getItems().size(); })));
        System.out.println("  ① 天真        : " + a);

        var b = spy.watch(() -> tx.executeWithoutResult(s ->
            orders.fetchAll(St4.PENDING).forEach(o -> {
                o.getCustomer().getDisplayName(); o.getItems().size(); })));
        System.out.println("  ② JOIN FETCH  : " + b);

        var c = spy.watch(() -> tx.executeWithoutResult(s ->
            orders.findByStatusOrderByOrderNo(St4.PENDING).forEach(o -> {
                o.getCustomer().getDisplayName(); o.getItems().size(); })));
        System.out.println("  ③ EntityGraph : " + c);

        var d = spy.watch(() -> tx.executeWithoutResult(s ->
            batchOrders.findByStatus(St4.PENDING).forEach(o -> {
                o.getCustomer().getDisplayName(); o.getItems().size(); })));
        System.out.println("  ④ @BatchSize  : " + d);
    }
}
```

```
═══ 五種寫法的 N+1 分數 ═══
  ① 天真        : stmt=251  entityFetch=50  collFetch=200  → N+1 分數 250
  ② JOIN FETCH  : stmt=1    entityFetch=0   collFetch=0    → N+1 分數 0
  ③ EntityGraph : stmt=1    entityFetch=0   collFetch=0    → N+1 分數 0
  ④ @BatchSize  : stmt=11   entityFetch=2   collFetch=8    → N+1 分數 10
```

### 4.10.4 實測：它抓得到「有人加了一行」

**這是這個工具真正的價值**：不是「量一次」，而是**擋住未來的退化**。

```java
    @Test
    void 斷言會擋下天真寫法() {
        seed(200, 50, 2, 0);
        var spy = new NPlus1Spy(emf);
        head("assertNoNPlus1() 對兩種寫法");

        var err = assertThrows(AssertionError.class, () ->
            spy.watch(() -> tx.executeWithoutResult(s ->
                orders.findByStatus(St4.PENDING).forEach(o -> {
                    o.getCustomer().getDisplayName(); o.getItems().size(); })))
                .assertNoNPlus1());
        System.out.println("  ① 天真 → 🔴 " + err.getMessage());

        spy.watch(() -> tx.executeWithoutResult(s ->
            orders.fetchAll(St4.PENDING).forEach(o -> {
                o.getCustomer().getDisplayName(); o.getItems().size(); })))
            .assertNoNPlus1();
        System.out.println("  ② JOIN FETCH → ✅ 通過");

        spy.watch(() -> tx.executeWithoutResult(s ->
            batchOrders.findByStatus(St4.PENDING).forEach(o -> {
                o.getCustomer().getDisplayName(); o.getItems().size(); })))
            .assertAtMostExtraQueries(10);
        System.out.println("  ④ @BatchSize → ✅ 通過（上限 10）");
    }

    @Test
    void 只換一個關聯就被抓到() {
        var spy = new NPlus1Spy(emf);
        head("模擬「有人加了一行 o.getNotes().size()」");
        seed(200, 50, 2, 2);
        var err = assertThrows(AssertionError.class, () ->
            spy.watch(() -> tx.executeWithoutResult(s ->
                orders.fetchAll(St4.PENDING).forEach(o -> {
                    o.getCustomer().getDisplayName();
                    o.getItems().size();
                    o.getNotes().size();          // ★ 新加的這一行
                })))
                .assertNoNPlus1());
        System.out.println("  🔴 " + err.getMessage());
    }
```

```
═══ assertNoNPlus1() 對兩種寫法 ═══
  ① 天真 → 🔴 N+1：額外撈了 50 個實體、200 個集合（共 251 句 SQL）。
             兩個都要處理：@ManyToOne 與集合
  ② JOIN FETCH → ✅ 通過
  ④ @BatchSize → ✅ 通過（上限 10）

═══ 模擬「有人加了一行 o.getNotes().size()」 ═══
  🔴 N+1：額外撈了 0 個實體、200 個集合（共 201 句 SQL）。兇手是集合（4.5、4.7 或 4.8）
```

✅✅ **這正是我們要的**：

```
一個已經修好的查詢（JOIN FETCH，分數 0）
   ↓
三個月後有人在 DTO 轉換裡加了一行 o.getNotes().size()
   ↓
測試立刻失敗，而且訊息告訴你「兇手是集合」
```

⚠️ **注意那個錯誤訊息裡的 `entityFetch=0`**：客戶還是好的，**只有 `notes` 壞了**。
這比「201 句 SQL」有用得多——**它直接指出要去修哪一個關聯。**

### 4.10.5 三條可以寫進 CI 的斷言

```java
// 斷言一：明細頁必須一次撈齊
@Test
void 明細頁沒有N加1() {
    new NPlus1Spy(emf)
        .watch(() -> orderService.view(orderId))
        .assertNoNPlus1();
}

// 斷言二：分頁列表頁允許批次，但額外查詢不超過 2 次（客戶一句 + 明細一句）
@Test
void 列表頁最多兩次額外查詢() {
    new NPlus1Spy(emf)
        .watch(() -> orderService.list(OrderStatus.PENDING, 0, 20))
        .assertAtMostExtraQueries(2);
}

// 斷言三：分頁查詢的 SQL 裡【必須】有 limit（4.5.5 / 4.6.5 那個陷阱）
@Test
void 分頁查詢必須真的分頁() {
    var sqls = spy(() -> orderService.list(OrderStatus.PENDING, 0, 20));
    assertTrue(sqls.get(0).contains("limit"),
        "分頁查詢的第一句沒有 limit —— 大概是 fetch 了集合（04 章 4.5.5）");
}
```

📌 **三條各自在防什麼**：

| 斷言 | 防的退化 |
|---|---|
| ① `assertNoNPlus1()` | 有人在單筆查詢後面多碰了一個沒 fetch 的關聯 |
| ② `assertAtMostExtraQueries(2)` | 有人把 `@BatchSize` 拿掉、或加了第三個關聯 |
| ③ SQL 有 `limit` | 有人在分頁查詢的 `@EntityGraph` 裡**加了一個集合**（4.6.5） |

⚠️ **③ 是唯一抓得到「記憶體分頁」的斷言**，
因為記憶體分頁的 N+1 分數是 **0**（它一句 SQL 撈齊了，只是撈太多）——
**①② 完全抓不到它。**

> 📌 **這件事本身值得記**：
> **「N+1 分數 0」不等於「這個查詢是好的」。**
> **一句撈回 6000 個實體的 SQL 分數也是 0。兩條斷言防的是兩種不同的病。**

---

## 4.11 shop-service 的落地

### 4.11.1 03 章留下的缺口

03 章 3.11.4 量到四個用例：

```
place    3 句  ✅
addItem  4 句  ✅
pay      2 句  ✅
view     3 句  ⚠️  ← 1) SELECT orders  2) SELECT customer  3) SELECT order_item
```

而 03 章明確說了那 3 句的意義：

```
「一張訂單 3 句」，如果是「列出 50 張訂單」= 1 + 50 + 50 = 101 句
```

**這一節把它補掉。**

### 4.11.2 三個改動

**改動一：`Order.items` 加 `@BatchSize`。**

⚠️ 只有集合那一段是新的，其餘跟 01 章 1.16.5 與 02 章 2.12.2 定案的一樣。
這裡整份貼出來，因為它是後面章節會一直用到的那一份：

```java
package com.example.lab.shop;

import jakarta.persistence.*;
import org.hibernate.annotations.BatchSize;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;

@Entity @Table(name = "orders")           // ★ 不叫 order：保留字（07 站 1.11）
public class Order extends BaseEntity {

    @Column(name = "order_no", nullable = false, length = 32)
    private String orderNo;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "customer_id", nullable = false)
    private Customer customer;

    /**
     * ★ 一定要 STRING，不能 ORDINAL（1.7.2 實測）。
     * ★ 而且要加 @JdbcTypeCode(VARCHAR)：Hibernate 6 在 MySQL 上會把 STRING 映射成
     *   【原生的 MySQL ENUM 型別】，對上 VARCHAR(16) 的欄位會 validate 失敗（1.7.4）。
     */
    @Enumerated(EnumType.STRING)
    @JdbcTypeCode(SqlTypes.VARCHAR)
    @Column(nullable = false, length = 16)
    private OrderStatus status;

    @Column(name = "total_amount", nullable = false, precision = 19, scale = 4)
    private BigDecimal totalAmount = BigDecimal.ZERO;

    @Column(name = "discount_amount", nullable = false, precision = 19, scale = 4)
    private BigDecimal discountAmount = BigDecimal.ZERO;

    /** ★ CHAR(3) 要明講，否則 validate 會說它期待 varchar(255)（1.12.2）。 */
    @Column(nullable = false, length = 3)
    @JdbcTypeCode(SqlTypes.CHAR)
    private String currency = "TWD";

    /** ★ 一律 Instant，不要 LocalDateTime（1.9.2 實測）。 */
    @Column(name = "placed_at", nullable = false)
    private Instant placedAt;

    @Column(name = "paid_at")
    private Instant paidAt;

    @Column(name = "created_at", insertable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", insertable = false, updatable = false)
    private Instant updatedAt;

    @Version
    private long version;

    /**
     * ★ 04 章 4.11 加上 @BatchSize：列表頁分頁時，20 張訂單的明細用【一句】撈回來，
     *   而不是 20 句（04 章 4.7.5）。它不影響單筆查詢（那條路走 @EntityGraph）。
     */
    @OneToMany(mappedBy = "order", cascade = CascadeType.ALL, orphanRemoval = true)
    @BatchSize(size = 25)
    private List<OrderItem> items = new ArrayList<>();

    protected Order() {}
    public Order(UUID id, String orderNo, Customer customer) {
        super(id);
        this.orderNo = orderNo;
        this.customer = customer;
        this.status = OrderStatus.PENDING;
        this.placedAt = Instant.now();
    }

    public OrderItem addItem(UUID itemId, Product product, int qty) {
        requireStatus(OrderStatus.PENDING, "只有 PENDING 的訂單可以加明細");
        OrderItem item = new OrderItem(itemId, this, product, qty);
        items.add(item);
        totalAmount = totalAmount.add(item.getLineAmount());
        return item;
    }

    /**
     * ★ 移除一筆明細。orphanRemoval 會把那一列刪掉（02 章 2.6.2）。
     *   注意這裡【不需要】item.setOrder(null)：明細的 order 是建構子設的、之後不再變，
     *   而 orphanRemoval 是靠「從集合移除」觸發的（02 章 2.3.3 實測）。
     */
    public void removeItem(OrderItem item) {
        requireStatus(OrderStatus.PENDING, "只有 PENDING 的訂單可以移除明細");
        if (items.remove(item)) {
            totalAmount = totalAmount.subtract(item.getLineAmount());
        }
    }

    public void pay() {
        requireStatus(OrderStatus.PENDING, "只有 PENDING 的訂單可以付款");
        this.status = OrderStatus.PAID;
        this.paidAt = Instant.now();
    }

    public void cancel() {
        if (status == OrderStatus.SHIPPED || status == OrderStatus.DELIVERED) {
            throw new IllegalStateException("已出貨的訂單不能取消，目前是 " + status);
        }
        this.status = OrderStatus.CANCELLED;
    }

    public void applyDiscount(BigDecimal amount) {
        if (amount.signum() < 0) throw new IllegalArgumentException("折扣不可為負");
        if (amount.compareTo(totalAmount) > 0) {
            throw new IllegalArgumentException("折扣 " + amount + " 超過總額 " + totalAmount);
        }
        this.discountAmount = amount;
    }

    private void requireStatus(OrderStatus expected, String message) {
        if (status != expected) throw new IllegalStateException(message + "，目前是 " + status);
    }

    public String getOrderNo() { return orderNo; }
    public Customer getCustomer() { return customer; }
    public OrderStatus getStatus() { return status; }
    public BigDecimal getTotalAmount() { return totalAmount; }
    public BigDecimal getDiscountAmount() { return discountAmount; }
    public String getCurrency() { return currency; }
    public Instant getPlacedAt() { return placedAt; }
    public Instant getPaidAt() { return paidAt; }
    public Instant getCreatedAt() { return createdAt; }
    public long getVersion() { return version; }
    public List<OrderItem> getItems() { return Collections.unmodifiableList(items); }
}
```

**改動二：`OrderRepository` 加兩個方法。**

```java
package com.example.lab.shop;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.EntityGraph;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface OrderRepository extends JpaRepository<Order, UUID> {

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
     *   明細交給 Order.items 上的 @BatchSize（04 章 4.5.5 / 4.7.6）。
     */
    @EntityGraph(attributePaths = {"customer"})
    Page<Order> findByStatusOrderByPlacedAtDesc(OrderStatus status, Pageable page);
}
```

**改動三：`OrderService` 改一個方法（`view`）、加一個方法（`list`）。**

整份貼出來（`place` / `pay` / `cancel` / `addItem` 跟 03 章 3.11.3 一字不差）：

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
     * ★ 04 章 4.11：改用 findDetailById —— 一句 SQL 撈齊客戶 + 明細 + 商品，
     *   把 03 章 3.11.4 那個「一張訂單 3 句」補掉。
     */
    @Transactional(readOnly = true)
    public OrderView view(UUID orderId) {
        Order o = orders.findDetailById(orderId)
                .orElseThrow(() -> new IllegalArgumentException("訂單不存在：" + orderId));
        return OrderView.of(o);        // ★ 在交易裡就轉成 DTO，關聯還讀得到
    }

    /**
     * ④b 列表頁（04 章 4.11.2）。
     * ★ 兩個決定：
     *   ① 客戶用 @EntityGraph join 進來 —— @ManyToOne 不會破壞分頁
     *   ② 明細【不】join —— 那會讓 limit 失效（4.5.5），改靠 @BatchSize（4.7.5）
     */
    @Transactional(readOnly = true)
    public List<OrderView> list(OrderStatus status, int page, int size) {
        return orders.findByStatusOrderByPlacedAtDesc(status, PageRequest.of(page, size))
                .map(OrderView::of)
                .getContent();
    }

    private Order order(UUID id) {
        return orders.findById(id)
                .orElseThrow(() -> new IllegalArgumentException("訂單不存在：" + id));
    }
}
```

⚠️ **注意 `attributePaths` 裡的 `"items.product"`**：
`@EntityGraph` 的 `attributePaths` 支援用點號寫兩層，
**不需要自己宣告 `@NamedSubgraph`**（4.6.2 的 ③ 那個寫法是給具名 graph 用的）。

### 4.11.3 實測：`view` 從 3 句變 1 句

```java
package com.example.lab.ch04;

import com.example.lab.shop.*;
import org.junit.jupiter.api.Test;

/** 4.11：shop-service 補上 03 章 3.11.4 的缺口。 */
class D1Shop {   // ★ 這個測試連 shop 資料庫，完整版見本節末

    @Test
    void view從三句變一句() {
        seed(5, 5);
        System.out.println("\n═══ view（一張訂單）—— 03 章是 3 句 ═══");
        final OrderView[] v = new OrderView[1];
        var sqls = spy(() -> v[0] = service.view(orderIds.get(0)));
        grouped("SQL", sqls);
        System.out.println("  DTO 完整嗎 : 客戶=" + v[0].customerName()
                + "、明細 " + v[0].lines().size() + " 筆");
        new NPlus1Spy(emf).watch(() -> service.view(orderIds.get(0))).assertNoNPlus1();
        System.out.println("  ✅ assertNoNPlus1() 通過");
    }
}
```

```
═══ view（一張訂單）—— 03 章是 3 句 ═══
── SQL → 共 1 句，1 種形狀
   ×1  select o1_0.id,o1_0.created_at,o1_0.currency,o1_0.customer_id,
         c1_0.id,c1_0.created_at,c1_0.display_name,c1_0.email,c1_0.version,o1_0…
  DTO 完整嗎 : 客戶=客戶0、明細 2 筆
  ✅ assertNoNPlus1() 通過
```

✅ **3 句 → 1 句，而 DTO 的內容一模一樣。**

### 4.11.4 實測：列表頁分頁

```java
    @Test
    void 列表頁200張分頁20筆() {
        seed(200, 50);
        System.out.println("\n═══ list（200 張訂單裡取第一頁 20 筆）═══");
        final List<OrderView>[] r = new List[1];
        var sqls = spy(() -> r[0] = service.list(OrderStatus.PENDING, 0, 20));
        grouped("SQL", sqls);
        System.out.println("  拿到 " + r[0].size() + " 筆，第一筆 : 客戶="
                + r[0].get(0).customerName() + "、明細 " + r[0].get(0).lines().size() + " 筆");
        System.out.println("  第一句有 limit 嗎 : " + sqls.get(0).contains("limit"));
        var res = new NPlus1Spy(emf).watch(() -> service.list(OrderStatus.PENDING, 0, 20));
        System.out.println("  N+1 分數 : " + res);
        res.assertAtMostExtraQueries(2);
        System.out.println("  ✅ assertAtMostExtraQueries(2) 通過");
    }
```

```
═══ list（200 張訂單裡取第一頁 20 筆）═══
── SQL → 共 3 句，3 種形狀
   ×1  select o1_0.id,…,c1_0.display_name,… from orders o1_0 join customer c1_0 …
         where o1_0.status=? order by o1_0.placed_at desc limit ?,?
   ×1  select count(o1_0.id) from orders o1_0 where o1_0.status=?
   ×1  select i1_0.order_id,i1_0.id,… from order_item i1_0 where i1_0.order_id in (?,?,…)
  拿到 20 筆，第一筆 : 客戶=客戶49、明細 2 筆
  第一句有 limit 嗎 : true
  N+1 分數 : stmt=3  entityFetch=0  collFetch=1  → N+1 分數 1
  ✅ assertAtMostExtraQueries(2) 通過
```

**3 句。而且 `limit` 在 SQL 裡。**

**放大到 2000 張訂單**：

```
✅ @EntityGraph(customer) + @BatchSize(items) : 21 ms、3 句、拿到 20 筆
```

**對照 4.5.5 那個「全部 fetch」的版本**（同樣 2000 張、第一頁 20 筆）：

| | SQL | 時間 | PC 裡的實體 |
|---|---|---|---|
| `@EntityGraph` 含 `items` | 1 | **107 ms** | **6,000** |
| **本課的做法** | 3 | **21 ms** | **80** |

### 4.11.5 為什麼列表頁不用 `JOIN FETCH`

**把 4.11 的兩條路放在一起，這一章的結論就完整了**：

```
view（單筆明細頁）
   → @EntityGraph(customer, items, items.product)
   → 1 句，撈齊三層
   → ✅ 沒有分頁，所以 fetch 集合完全安全

list（分頁列表頁）
   → @EntityGraph(customer)       ← 只有 @ManyToOne，不影響 limit
   → items 交給 @BatchSize(25)     ← 集合不 join，所以 limit 有效
   → 3 句，而且句數【不隨資料總量成長】
```

> 📌 **同一個實體、同一組關聯，兩個用例用了兩種不同的策略。**
>
> **而那正是 4.6.1 說「`@EntityGraph` 把『要撈什麼』從查詢裡搬出來」的價值**：
> **`Order` 這個實體上沒有任何一個地方寫著「要不要撈 items」——
> 那是每個用例自己的決定。**

⚠️ **`OrderView.of()` 沒有改一個字。** 它還是那樣讀 `o.getCustomer().getDisplayName()`
與 `o.getItems()`。

**這是 `@EntityGraph` 的另一個好處：它不侵入業務程式碼。**
DTO 的組裝邏輯完全不知道那些資料是怎麼撈來的——
**所以你可以隨時換策略，而不用改任何一行組裝程式碼。**

**完整的測試檔案**（連 `shop` 資料庫，含 seed）：

```java
package com.example.lab.ch04;

import com.example.lab.SqlSpy;
import com.example.lab.Uuid7;
import com.example.lab.shop.*;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.UUID;

@SpringBootTest(properties = {
  "spring.datasource.url=jdbc:mysql://127.0.0.1:33306/shop"
      + "?connectionTimeZone=UTC&forceConnectionTimeZoneToSession=true"
      + "&preserveInstants=true&characterEncoding=UTF-8",
  "spring.jpa.properties.hibernate.generate_statistics=true"
})
class D1Shop {

    @Autowired OrderService service;
    @Autowired CustomerRepository customerRepo;
    @Autowired ProductRepository productRepo;
    @Autowired JdbcTemplate jdbc;
    @Autowired jakarta.persistence.EntityManagerFactory emf;

    private final List<UUID> orderIds = new ArrayList<>();

    private void seed(int orderCount, int customerCount) {
        jdbc.update("DELETE FROM order_item");
        jdbc.update("DELETE FROM orders");
        jdbc.update("DELETE FROM stock");
        jdbc.update("DELETE FROM product");
        jdbc.update("DELETE FROM customer");
        orderIds.clear();

        List<UUID> cs = new ArrayList<>();
        List<Object[]> cRows = new ArrayList<>();
        for (int i = 0; i < customerCount; i++) {
            UUID id = Uuid7.next(); cs.add(id);
            cRows.add(new Object[]{Uuid7.toBytes(id), "c" + i + "@x.com", "客戶" + i});
        }
        jdbc.batchUpdate("INSERT INTO customer (id,email,display_name) VALUES (?,?,?)", cRows);

        List<UUID> ps = new ArrayList<>();
        List<Object[]> pRows = new ArrayList<>();
        for (int i = 0; i < 3; i++) {
            UUID id = Uuid7.next(); ps.add(id);
            pRows.add(new Object[]{Uuid7.toBytes(id), "SKU-" + i, "商品" + i,
                    new BigDecimal((100 + i * 50) + ".0000")});
        }
        jdbc.batchUpdate("INSERT INTO product (id,sku,name,unit_price) VALUES (?,?,?,?)", pRows);

        List<Object[]> oRows = new ArrayList<>(), iRows = new ArrayList<>();
        for (int i = 0; i < orderCount; i++) {
            UUID oid = Uuid7.next(); orderIds.add(oid);
            oRows.add(new Object[]{Uuid7.toBytes(oid), String.format("SO-2026-%06d", i + 1),
                    Uuid7.toBytes(cs.get(i % customerCount)), "PENDING",
                    new BigDecimal("250.0000"),
                    Timestamp.from(Instant.parse("2026-09-01T00:00:00Z").plusSeconds(i))});
            for (int k = 0; k < 2; k++) {
                iRows.add(new Object[]{Uuid7.toBytes(Uuid7.next()), Uuid7.toBytes(oid),
                        Uuid7.toBytes(ps.get(k % 3)), "商品" + (k % 3),
                        new BigDecimal("100.0000"), 1, new BigDecimal("100.0000")});
            }
        }
        jdbc.batchUpdate("INSERT INTO orders"
                + " (id,order_no,customer_id,status,total_amount,placed_at)"
                + " VALUES (?,?,?,?,?,?)", oRows);
        jdbc.batchUpdate("INSERT INTO order_item"
                + " (id,order_id,product_id,product_name,unit_price,qty,line_amount)"
                + " VALUES (?,?,?,?,?,?,?)", iRows);
    }

    private List<String> spy(Runnable r) {
        SqlSpy.start();
        try { r.run(); return SqlSpy.stop(); }
        catch (RuntimeException | Error e) { SqlSpy.stop(); throw e; }
    }
    private void grouped(String t, List<String> sqls) {
        LinkedHashMap<String, Integer> m = new LinkedHashMap<>();
        for (String s : sqls) m.merge(s, 1, Integer::sum);
        System.out.println("── " + t + " → 共 " + sqls.size() + " 句，" + m.size() + " 種形狀");
        m.forEach((k, v) -> System.out.println("   ×" + v + "  "
                + (k.length() > 132 ? k.substring(0, 132) + "…" : k)));
    }

    @Test
    void view從三句變一句() {
        seed(5, 5);
        System.out.println("\n═══ view（一張訂單）—— 03 章是 3 句 ═══");
        final OrderView[] v = new OrderView[1];
        var sqls = spy(() -> v[0] = service.view(orderIds.get(0)));
        grouped("SQL", sqls);
        System.out.println("  DTO 完整嗎 : 客戶=" + v[0].customerName()
                + "、明細 " + v[0].lines().size() + " 筆");
        new NPlus1Spy(emf).watch(() -> service.view(orderIds.get(0))).assertNoNPlus1();
        System.out.println("  ✅ assertNoNPlus1() 通過");
    }

    @Test
    void 列表頁200張分頁20筆() {
        seed(200, 50);
        System.out.println("\n═══ list（200 張訂單裡取第一頁 20 筆）═══");
        final List<OrderView>[] r = new List[1];
        var sqls = spy(() -> r[0] = service.list(OrderStatus.PENDING, 0, 20));
        grouped("SQL", sqls);
        System.out.println("  拿到 " + r[0].size() + " 筆，第一筆 : 客戶="
                + r[0].get(0).customerName() + "、明細 " + r[0].get(0).lines().size() + " 筆");
        System.out.println("  第一句有 limit 嗎 : " + sqls.get(0).contains("limit"));
        var res = new NPlus1Spy(emf).watch(() -> service.list(OrderStatus.PENDING, 0, 20));
        System.out.println("  N+1 分數 : " + res);
        res.assertAtMostExtraQueries(2);
        System.out.println("  ✅ assertAtMostExtraQueries(2) 通過");
    }

    @Test
    void 兩千張訂單取第一頁() {
        seed(2000, 50);
        System.out.println("\n═══ 2000 張訂單，第一頁 20 筆 ═══");
        long t0 = System.nanoTime();
        var ok = service.list(OrderStatus.PENDING, 0, 20);
        long ms = (System.nanoTime() - t0) / 1_000_000;
        var res = new NPlus1Spy(emf).watch(() -> service.list(OrderStatus.PENDING, 0, 20));
        System.out.println("  ✅ @EntityGraph(customer) + @BatchSize(items) : "
                + ms + " ms、" + res.statements() + " 句、拿到 " + ok.size() + " 筆");
    }
}
```

---

## 4.12 常見誤區

**誤區一：「N+1 是 ORM 的問題，用 MyBatis 就沒有。」**

🔴 00 章 0.7 已經實測過：MyBatis 的巢狀 `select` 版是 **201 句**。
差別在**你看不看得見**，不在會不會發生。

📌 而這一章給了 JPA 這一側的答案：**你需要一把尺**（4.10），
因為「看程式碼」在 JPA 上是無效的（4.2.6）。

---

**誤區二：「加了 `JOIN FETCH` 就沒事了。」**

🔴 三個反例：
① 配分頁 → 記憶體分頁（4.5.5）；
② 兩個集合 → 笛卡兒積或例外（4.5.2、4.5.4）；
③ 只修了一層 → `items → product` 那一層還在（4.2.5 來源四）。

---

**誤區三：「`LazyInitializationException` 表示我該把關聯改成 `EAGER`。」**

🔴 4.4.3 實測：`EAGER` 在**列表查詢**上完全無效（還是 251 句），
只有 `find(id)` 那條路看起來有效——**所以它是一個假的修復。**

📌 那個例外真正在說的是「**你的 Service 沒把這個用例需要的資料撈齊**」。

---

**誤區四：「`@Basic(fetch = LAZY)` 可以讓大欄位不被撈。」**

🔴 4.3.6 實測：`spec_text` 還是在 `SELECT` 裡。
沒有 bytecode enhancement，那一行只是註解。

---

**誤區五：「`join fetch` 集合要記得加 `distinct`。」**

🔴 這在 Hibernate 5 是對的，在 **Hibernate 6 已經不需要**（4.5.3 實測：
不加 `distinct`，10 張訂單就是 10 筆）。
而加了它會讓資料庫**多做一次沒有意義的去重**。

📌 這一條的教訓是：**規則會隨版本過期，而且是靜默過期。**

---

**誤區六：「SQL 句數越少越好。」**

🔴 4.5.6 實測：**2 句（9 ms、80 個實體）比 1 句（107 ms、6000 個實體）好 12 倍。**

📌 要同時看三個數字：**幾句 SQL、資料庫回了幾列、建了幾個實體。**

---

**誤區七：「`getItems()` 回傳 null 就表示沒載入。」**

🔴 4.3.4 實測：未初始化的集合**不是 null**，它是一個 `PersistentBag`。
`if (items != null)` 這種檢查完全無效——要用 `Hibernate.isInitialized()`。

---

**誤區八：「把實體放進 `Set` 或 `Map` 沒有副作用。」**

🔴 4.3.3 實測：`set.add(o.getCustomer())` → **51 句 SQL**，
而那段程式碼一個欄位都沒讀。

📌 `hashCode()` / `equals(別人)` / `toString()` **都會**初始化代理（4.3.2）。
要識別一個關聯實體，用 `getId()`。

---

**誤區九：「`@OneToOne(fetch = LAZY)` 寫了就會延遲。」**

🔴 4.3.5 實測：**反向側（`mappedBy`）永遠無效**，因為 Hibernate
不知道對面那一列存不存在，必須查一次才能決定放 `null` 還是放代理。

---

**誤區十：「先把明細撈進一級快取，迴圈就不會打 SQL 了。」**

🔴 4.8.2 實測：400 筆明細已經在持久化情境裡，迴圈**還是 200 句**。
一級快取的 key 是「實體的 id」，而**集合的初始化狀態是另一張表上的旗標**（03 章 3.3.6）。

📌 這個技巧**只對 `@ManyToOne` 有效**。

---

**誤區十一：「N+1 分數 0 就代表這個查詢沒問題。」**

🔴 4.10.5：記憶體分頁的 N+1 分數**也是 0**——
它一句 SQL 撈齊了，只是撈了 6000 個實體回來給你 20 筆。

📌 **兩條斷言防兩種病**：分數 0 防「撈太多次」，SQL 有 `limit` 防「撈太多筆」。

---

## 4.13 本章小結

**一句話**：

> **N+1 不是 bug，是「需要的時候再撈」這個預設值在迴圈裡的自然結果。**
> **所以解法永遠是同一件事：在交易裡，把這個用例需要的東西一次講清楚。**
> **這一章的五種工具，都是「怎麼講清楚」的不同寫法。**

**這一章解掉的三個東西**：

| 哪裡留的 | 答案 |
|---|---|
| 00 章 0.3.2 / 0.7：一支列表 API 打出 251 句 | **4.5～4.7**：五種解法，最好的組合是 `@EntityGraph` + `@BatchSize` |
| 03 章 3.11.4：`view` 一張訂單 3 句、50 張就 101 句 | **4.11.3**：`@EntityGraph` 含 `items.product` → **1 句** |
| 02 章 2.7.3：`@OneToOne` 反向側 LAZY 無效（現象） | **4.3.5**：機制（那一側手上沒有外鍵，必須查才知道是不是 null） |

**五種工具的一句話總結**：

```
JOIN FETCH        一句撈齊。🔴 一次只能一個集合、🔴 不能配分頁
@EntityGraph      同一句 SQL，但把「撈什麼」搬到查詢外面。★ 本課的預設
@BatchSize        不撈齊，把 N 句變 ⌈N/size⌉ 句。★ 唯一能配分頁的集合解法
@Fetch(SUBSELECT) 集合一句撈齊。🔴 不能配分頁、Hibernate 專屬
DTO 投影（05 章）   根本不建實體。★ 唯讀查詢的最佳解
```

**三個「不能同時成立」的組合**（這一章一半的坑都在這裡）：

```
🔴 fetch 集合  +  分頁            → 記憶體分頁（HHH90003004）
🔴 fetch 集合  +  fetch 另一個集合 → 笛卡兒積（List 還會直接拋例外）
🔴 fetch 集合  +  對集合加條件      → 做不到；硬做會得到殘缺的集合，配 orphanRemoval 會刪資料
```

### 4.13.1 驗收清單

**觀念**

- [ ] 說出 N+1 的定義與四種來源（4.2.1、4.2.5）
- [ ] 解釋為什麼同一段程式碼的句數會隨資料分布改變（4.2.4）
- [ ] 說出哪些對代理的呼叫**不會**觸發初始化，以及為什麼 `hashCode()` 會（4.3.2）
- [ ] 解釋 `@OneToOne` 反向側的 `LAZY` 為什麼無效（4.3.5）
- [ ] 說出 `LazyInitializationException` 的四種解法，以及三種為什麼是錯的（4.4）
- [ ] 說出 `JOIN FETCH` 的三個代價（4.5.7）
- [ ] 解釋 `HHH90003004` 在說什麼，以及它的代價（4.5.5）
- [ ] 說出 `fetchgraph` 與 `loadgraph` 的差別（4.6.3）
- [ ] 說出 `@BatchSize` 要標在哪兩個地方，以及為什麼是兩個（4.7.2、4.8.2）
- [ ] 說出「分頁列表頁」的正確組合，並解釋每一句 SQL 為什麼必要（4.11.5）

**動手**

- [ ] 在你的專案裡重現一次 N+1，並用 `entityFetch` / `collFetch` 指出兇手
- [ ] 量一次「同一段程式碼、不同資料分布」的句數差異（4.2.4）
- [ ] 用 `JOIN FETCH` 修好它，再加上分頁，觀察 `HHH90003004` 出現（4.5.5）
- [ ] 改成 `@EntityGraph`(只含 `@ManyToOne`) + `@BatchSize`，確認 SQL 裡有 `limit`
- [ ] 把 `NPlus1Spy` 與 4.10.5 那三條斷言加進你的專案
- [ ] 加一行 `default_batch_fetch_size: 25`，量一次全站的句數變化

**能不用查資料就回答**

- [ ] `order.getCustomer().getId()` 會打幾句 SQL？`getDisplayName()` 呢？
- [ ] 一個 `@EntityGraph(attributePaths = {"customer", "items"})` 配 `Pageable`，SQL 裡有 `limit` 嗎？
- [ ] 兩個 `List` 一起 `join fetch` 會怎樣？兩個 `Set` 呢？
- [ ] `@BatchSize(size = 25)` 對 200 個集合、50 個不同客戶，各產生幾句 SQL？
- [ ] Hibernate 6 的 `join fetch` 還需要 `distinct` 嗎？

### 4.13.2 本章練習

**練習一（★）：把 4.2.5 的「兩層關聯」修好**

`o.getItems().forEach(i -> i.getProduct().getName())` 是 `1 + N + M`。
用**三種**不同的方式修它（`@EntityGraph` 的 `attributePaths`、具名 `subgraph`、`@BatchSize`），
各量一次句數，並說出哪一種在「訂單很多」時最好。

<details>
<summary>提示</summary>

```
① @EntityGraph(attributePaths = {"items", "items.product"})  → 1 句，但笛卡兒積
② 具名 graph + @NamedSubgraph                                 → 同上，只是寫法不同
③ 在 Prod4 類別上加 @BatchSize(25)                            → 1 + N + ⌈M/25⌉
```

「訂單很多」時 ①② 的笛卡兒積會爆——所以答案是「**看 items 的平均筆數**」，
而這正是 4.9.2 的 Q4。

</details>

**練習二（★★）：找出你專案裡所有「分頁 + fetch 集合」的查詢**

寫一個測試，掃過所有 repository 方法，找出**同時**滿足這兩個條件的：
① 參數含 `Pageable`；② `@EntityGraph` 的 `attributePaths` 裡有集合屬性。

<details>
<summary>提示</summary>

用反射 + JPA 的 `Metamodel` 判斷一個屬性是不是集合：

```java
Metamodel mm = emf.getMetamodel();
EntityType<?> et = mm.entity(Ord4.class);
Attribute<?, ?> attr = et.getAttribute("items");
boolean isCollection = attr.isCollection();     // ★ 就是這個
```

然後對每個 repository 方法：`method.getAnnotation(EntityGraph.class)`
配上 `Arrays.stream(m.getParameterTypes()).anyMatch(Pageable.class::isAssignableFrom)`。

⚠️ 記得也要處理 `attributePaths` 裡的兩層路徑（`"items.product"`）——
第一段是集合就已經有問題了。

</details>

**練習三（★★）：`@BatchSize` 的最佳值**

在你自己的資料上，量出 `batch size` 從 1 到 200 的句數與時間，畫出曲線。
找出「時間不再明顯下降」的那個點，並解釋為什麼**再往上加沒有幫助**。

<details>
<summary>提示</summary>

4.7.4 的表算的是**句數上界**，而時間不會照句數線性下降——
因為每一句 `in (…)` 的成本本身也隨參數個數成長。

量的時候要注意 03 章 3.4.8 那兩個陷阱：**先暖機**、以及
**每一輪都要清一級快取**（否則第二輪 0 句）。

</details>

**練習四（★★★）：一個不會被 `NPlus1Spy` 抓到的效能問題**

4.10.5 說「N+1 分數 0 不代表查詢是好的」。
**再找出兩個「分數是 0、但很慢」的查詢形狀**，各寫一個測試，
並提出一條能抓到它們的斷言。

<details>
<summary>提示</summary>

方向一：**記憶體分頁**（4.5.5）。斷言：SQL 裡必須有 `limit`。

方向二：**笛卡兒積**（4.5.2）。兩個 `Set` 一起 fetch → 1 句、分數 0、
而資料庫回了 `N × M × K` 列。
斷言：比較「`entityLoad`」與「你預期的筆數」——
或者更直接，用 `SqlSpy` 記下 SQL，另外跑一次 `SELECT COUNT(*)` 看它回幾列。

方向三：**撈了不需要的欄位**（4.3.6 那個 `mediumtext`）。
分數 0、句數 1，而每一列多帶幾 KB。
斷言：`SELECT` 裡不能出現某些欄位名——或者根本改用 DTO 投影（05 章）。

📌 這個練習的重點：**任何單一指標都可以被繞過。**
你需要的是一組互補的斷言，而不是一個「效能分數」。

</details>

**練習五（★★★）：把 `HHH90003004` 變成一個測試失敗**

那個警告是 `WARN` 等級，在正式環境會被淹掉。
寫一個 JUnit 擴充或 `Appender`，讓**任何一個測試**只要觸發那行警告就失敗。

<details>
<summary>提示</summary>

Logback 的做法：自訂一個 `AppenderBase<ILoggingEvent>`，
掛到 `org.hibernate.orm.query` 這個 logger 上，
在 `append()` 裡檢查 `event.getMessage().contains("HHH90003004")`，記到一個
`ThreadLocal<List<String>>`，然後在 `@AfterEach` 裡斷言它是空的。

⚠️ 兩個細節：
① 這種「全域斷言」要能被單一測試**明確關閉**（因為 4.5.5 那個實測**故意**要觸發它）；
② 訊息代碼比訊息文字可靠——文字會隨版本改，代碼不會。

📌 而這個練習真正的價值是那個做法本身：
**把「一個沒人看的 WARN」變成「一個沒人能忽略的紅燈」**，
是處理這類問題最有效的一步。

</details>

---

## 4.14 下一章預告

**05 章：查詢技術（JPQL、Criteria、QueryDSL、原生 SQL、DTO 投影）。**

這一章從頭到尾都在做同一件事：**把實體撈得更有效率**。
而它有一個從來沒被質疑的前提：

> **我們需要「實體」。**

**而 4.9.1 那張表的最後一欄，已經在問這個問題了**：

```
五種解法，PC 裡的實體數【全部都是 650】。
它們只改變了「用幾句 SQL 載入 650 個實體」，沒有一個減少了 650。
```

📌 **而那個列表頁真正需要的是什麼？**

```
每一列要顯示：訂單編號、狀態、金額、客戶名稱、明細筆數
              ▲
              5 個值。
而我們為了這 5 個值，建了 650 個實體、650 份快照（03 章 3.4.2）、
201 個 PersistentBag，然後在交易結束時把它們全部做一次髒檢查。
```

**05 章的第一句話就是**：

> **這一頁不需要實體。**

**05 章會處理五件事**：

```
① JPQL 的完整語法，以及它跟 SQL 不一樣的地方（它操作的是【物件】，不是表）
② DTO 投影的三種寫法（constructor expression / interface / Tuple），
   以及它們各自的成本 —— 00 章 0.7 結論三那個「9 ms vs 3 ms」的差距在這裡收掉
③ Criteria API：為什麼它存在、為什麼它這麼難寫、什麼時候值得
④ QueryDSL：把 Criteria 變成人類可讀的東西
⑤ 原生 SQL 與 @SqlResultSetMapping —— 以及「什麼時候該直接交給 MyBatis」（09 章）
```

⚠️ **而 05 章會回頭修改這一章的一個結論**：

| 這一章說 | 05 章會補上 |
|---|---|
| 4.9.3 決策表：「只讀幾個欄位的列表 → DTO 投影」 | **怎麼寫**，以及「明細（集合）怎麼放進 DTO」 |
| 4.6.7：「要殘缺的實體 → 改成查子實體」 | DTO 沒有不變量，所以它**可以**只帶一部分 |
| 4.13 小結：「五種工具都沒有減少實體數」 | 第六種工具：**一個都不建** |

📌 **而 06 章會再回來一次**：
這一章量到的「62 ms → 6 ms」是**單次查詢**的改善。
**06 章要處理「同樣的查詢每秒跑 500 次」**——那時候 1 句 SQL 也嫌多，
而答案是二級快取與查詢快取，**以及它們各自會騙你的地方。**
