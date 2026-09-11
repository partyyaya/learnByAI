# 第 03 章：持久化情境與生命週期

> 00 章的六個事故裡，有四個的答案是同一句話。
> 02 章的九個實測裡，有三個的答案也是同一句話。
>
> 而那句話，這兩章都刻意沒有解釋：
>
> > **「因為持久化情境（Persistence Context）是這樣運作的。」**
>
> ---
>
> ⚠️ **這一章跟前兩章有一個根本的差別。**
>
> 00～02 章講的是**映射**：把 Java 的類別對到資料庫的表。
> 那是**靜態**的——你寫下註解，Hibernate 產生 SQL，看得懂、對得上。
>
> **這一章講的是執行期**：你的實體在一個交易裡，到底被誰管著、
> 什麼時候被比對、什麼時候被寫出去、順序又是誰決定的。
>
> 而這一層看不見。你的程式碼裡沒有任何一行提到它。
>
> ---
>
> 這一章有 **40 個實測**。挑七個先講結果：
>
> - 一段**完全沒有 `save()`** 的程式碼，把資料庫改掉了
> - 一句 **JPQL 真的送到資料庫、資料庫回了新值**，而你拿到的物件是**舊的**
> - 同一段程式碼，`READ COMMITTED` 下有**一層**快取騙你，
>   MySQL 預設的 `REPEATABLE READ` 下有**兩層**
> - 一個「改名 API」的三行程式碼，把使用者的 `nickname` **靜默清成 null**
> - `merge()` 回傳的**不是**你傳進去的那個物件——對傳進去的那個再改一次，**改動消失**
> - 程式碼寫「先刪、再插」，實際送出去的 SQL 是「**先插、再刪**」→ **唯一鍵衝突**
> - `@PostUpdate` 裡寫一行 `em.flush()` → **StackOverflowError**，
>   而 `@PostUpdate` 裡寫一行 `em.persist(...)` → **那一列靜默不見**
>
> 📌 **這一章的主線只有一句**：
>
> > **JPA 不是「你叫它寫，它就寫」。**
> > **它是「你改物件，它在某個時間點自己決定要寫什麼、寫多少、按什麼順序寫」。**
> > **這一章就是把那個「某個時間點」和「自己決定」攤開來。**

---

## 3.1 學習目標

完成本章後，你應該可以：

- 說出**持久化情境**是什麼、由誰建立、活多久，並指出它在執行期是哪一個類別（3.2.2）。
- 解釋一級快取的**保證**（同一個交易、同一個 id → 同一個 Java 物件）與它的**三個破口**（3.3）。
- 說明為什麼「JPQL 明明重新查了資料庫，我拿到的還是舊值」——並知道這**不是 bug**（3.3.3）。
- 分辨「一級快取騙你」與「InnoDB 快照騙你」是**兩件不同的事**，並知道各自的解法（3.3.4）。
- 回答 00 章 0.3.1：**為什麼沒有呼叫 `save()`，資料卻改了**（3.4.1）。
- 說出髒檢查**比對的是什麼**、**什麼時候比對**、以及它的**成本怎麼隨快取大小成長**（3.4）。
- 解釋為什麼「設回同一個值」不會產生 `UPDATE`，而 `BigDecimal` 換一個 scale **也不會**（3.4.4、3.4.5）。
- 說出實體的**四種狀態**，並解釋為什麼在「應用端指定主鍵」的專案裡，
  `transient` 與 `detached` **從物件本身分不出來**（3.5.3）。
- 說出 `persist` 與 `merge` 的**五個差異**，並指出 `merge` 造成**靜默資料遺失**的機制（3.6.5）。
- 說出 `flush` 的三個時機、**哪些查詢會觸發它、哪些不會**（3.7.2），
  並回答 00 章 0.9 規則二為什麼存在（3.7.3）。
- 解釋 Hibernate 送出 SQL 的**固定順序**，並說出它造成唯一鍵衝突的場景與解法（3.7.5、3.7.6）。
- 說明 `@Transactional` 的傳播行為怎麼影響持久化情境的**個數**（3.8.2、3.8.3）。
- 說出七個生命週期回呼的觸發順序，以及**在回呼裡碰 `EntityManager` 的四種下場**（3.9.5）。
- 用 `PcSpy` 把「這個用例 flush 了幾次、載入了幾個實體」變成 **CI 裡的斷言**（3.10）。
- 寫出一個**完全沒有 `save()`** 的 Service，並說明它為什麼是對的（3.11）。

---

## 3.2 持久化情境是什麼

### 3.2.1 一句話定義

> **持久化情境 = 一個交易期間，Hibernate 用來放「它正在管的實體」的那一張表。**

它就是一個 `Map`：

```
key                              value
────────────────────────────────────────────────────────────
(Customer, 01a07a93-…)     →     Customer 物件 @7b0f5814
(Order,    01a07a94-…)     →     Order    物件 @4a0934a8
```

而「放在這張表裡」帶來三個後果，這一章的每一節都在講其中一個：

| 後果 | 一般叫法 | 本章 |
|---|---|---|
| 同一個 id 撈幾次，都給你**同一個 Java 物件** | 一級快取 | 3.3 |
| 進來的時候拍一份**快照**，離開前比對一次 | 髒檢查 | 3.4 |
| 這張表裡的東西**有狀態**（進來了 / 要刪了 / 走了） | 實體生命週期 | 3.5 |

⚠️ **注意「一個交易期間」這五個字**。持久化情境**不是**一個全域快取，
它跟你的交易一樣短命——這是它跟 06 章要講的二級快取最大的差別。

### 3.2.2 實測：執行期的三層物件

先確認一件事：你注入的那個 `EntityManager`，到底是什麼？

```java
package com.example.lab.ch03;

import org.hibernate.Session;
import org.hibernate.engine.spi.SessionImplementor;
import org.junit.jupiter.api.Test;

class A1Runtime extends Base03 {          // Base03 見 3.2.5

    @Test
    void 執行期的三層物件() {
        System.out.println("  注入的 em         : " + em.getClass().getName());
        tx.executeWithoutResult(s -> {
            Object delegate = em.getDelegate();
            System.out.println("  em.getDelegate()  : " + delegate.getClass().getName());
            System.out.println("  em.unwrap(Session): "
                + em.unwrap(Session.class).getClass().getName());
            SessionImplementor si = em.unwrap(SessionImplementor.class);
            System.out.println("  持久化情境本身     : "
                + si.getPersistenceContext().getClass().getName());
            System.out.println("  PC 裡有幾個實體    : "
                + si.getPersistenceContext().getNumberOfManagedEntities());
        });
    }
}
```

```
═══ 注入的 EntityManager、它背後的 Session、以及 PersistenceContext ═══
  注入的 em            : jdk.proxy2.$Proxy147
  em.getDelegate()     : org.hibernate.internal.SessionImpl
  em.unwrap(Session)   : jdk.proxy2.$Proxy147
  持久化情境本身        : org.hibernate.engine.internal.StatefulPersistenceContext
  PC 裡有幾個實體       : 0
```

**這裡有四層**，而且每一層都是 00 章 0.4 那三個名字的延伸：

```
① jdk.proxy2.$Proxy147                       ← Spring 給你的【共用代理】
       │                                        每次呼叫都去找「當前執行緒的交易」裡那一個真的 EM
       ▼
② org.hibernate.internal.SessionImpl          ← Hibernate 的實作
       │                                        它【同時】實作 EntityManager 與 Session
       ▼
③ org.hibernate.engine.spi.SessionImplementor ← 內部 SPI（拿得到內部狀態）
       │
       ▼
④ StatefulPersistenceContext                  ← 持久化情境本人，就是那張 Map
```

⚠️ **注意 ② 那一行**：`em.getDelegate()` 拿到的是 `SessionImpl`，
而 `em.unwrap(Session.class)` 拿到的**還是代理**。

這個差別很實際：**你不能用 `em.unwrap(Session.class)` 來比較「是不是同一個 Session」**，
因為那個代理是單例，永遠是同一個。要比身分，得用 `em.getDelegate()`。

### 3.2.3 實測：一個交易，一個持久化情境

```java
    @Test
    void 一個交易一個持久化情境() {
        tx.executeWithoutResult(s -> {
            System.out.println("  第一次 em.getDelegate() : " + id(em.getDelegate()));
            System.out.println("  第一次 PC               : " + id(pcOf()));
            System.out.println("  第二次 em.getDelegate() : " + id(em.getDelegate()));
            System.out.println("  第二次 PC               : " + id(pcOf()));
        });

        final String[] a = new String[2];
        tx.executeWithoutResult(s -> { a[0] = id(em.getDelegate()); a[1] = id(pcOf()); });
        tx.executeWithoutResult(s -> {
            System.out.println("  交易 A Session / PC : " + a[0] + " / " + a[1]);
            System.out.println("  交易 B Session / PC : " + id(em.getDelegate()) + " / " + id(pcOf()));
        });
    }

    private Object pcOf() {
        return em.unwrap(SessionImplementor.class).getPersistenceContext();
    }
    private static String id(Object o) {
        return o.getClass().getSimpleName() + "@" + Integer.toHexString(System.identityHashCode(o));
    }
```

```
═══ 同一個交易內，兩次拿到的是同一個 Session / PC 嗎 ═══
  第一次 em.getDelegate() : SessionImpl@659f5f32
  第一次 PC               : StatefulPersistenceContext@20fdd484
  第二次 em.getDelegate() : SessionImpl@659f5f32
  第二次 PC               : StatefulPersistenceContext@20fdd484

═══ 換一個交易呢 ═══
  交易 A Session / PC : SessionImpl@65a86de0 / StatefulPersistenceContext@745e1fb7
  交易 B Session / PC : SessionImpl@497d9489 / StatefulPersistenceContext@6f9c272b
```

**同一個交易內：同一個。換一個交易：全新的。**

📌 這就是為什麼這一章所有的實測都必須明講「在哪一個交易裡」——
**跨交易的兩行程式碼，等於在跟兩張不同的 Map 說話。**

### 3.2.4 實測：沒有交易的時候

```java
    @Test
    void 沒有交易的時候() {
        seed();
        System.out.println("  em 是 : " + em.getClass().getName());
        // Pc.managedCount / em.getTransaction 在沒有交易時各自會怎樣（見輸出）

        var sqls = spy(() -> {
            Cust3 a = customers.findById(cid).orElseThrow();
            Cust3 b = customers.findById(cid).orElseThrow();
            System.out.println("  a == b ? " + (a == b));
        });
        System.out.println("  → " + sqls.size() + " 句 SQL");
    }
```

```
═══ 完全沒有交易，注入的 em 是什麼狀態 ═══
  em 是 : jdk.proxy2.$Proxy147
  Pc.managedCount(em) → 🔴 IllegalStateException: No transactional EntityManager available
  em.getDelegate()    → SessionImpl@4eef2522
  em.getTransaction() → 🔴 IllegalStateException: Not allowed to create transaction on
                           shared EntityManager - use Spring transactions or EJB CMT instead

═══ 沒有交易時，findById 兩次 ═══
  a == b ? false   ← 🔴 不是同一個物件
  → 2 句 SQL
     select c1_0.id,c1_0.display_name,c1_0.email from customer c1_0 where c1_0.id=?
     select c1_0.id,c1_0.display_name,c1_0.email from customer c1_0 where c1_0.id=?
```

⚠️ **沒有交易時，「持久化情境」這個概念根本不存在。**

`findById` 還是能跑（Spring Data 的每個 `SimpleJpaRepository` 方法上都有 `@Transactional`），
但那是**一個方法一個交易**——所以：

```
兩次 findById = 兩個交易 = 兩個持久化情境 = 兩句 SQL = 兩個不同的 Java 物件
                                                       ▲
                                    而它們【都是 detached】（3.5）
```

🔴 **這是新手最容易寫出來的災難形狀**：

```java
// ❌ 沒有 @Transactional 的 Service 方法
public void payOrder(UUID id) {
    Order o = orders.findById(id).orElseThrow();   // 交易 1：撈出來，然後 detached
    o.pay();                                        // 改的是一個沒人管的物件
    // 什麼都不會發生
}
```

它**不會報錯**，也**不會寫入**。

### 3.2.5 這一章共用的模型與量尺

**表結構**（`ch03` 資料庫；07 站 01 章 1.12 那份 schema 的子集，
加一個可以是 null 的 `nickname` 欄位，3.6.4 要用）：

```sql
CREATE DATABASE ch03 CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE ch03;

CREATE TABLE customer (
  id           binary(16)   NOT NULL,
  email        varchar(255) NOT NULL,
  display_name varchar(64)  NOT NULL,
  nickname     varchar(64)  NULL,          -- ★ 3.6.5：merge 會把它清成 null
  PRIMARY KEY (id),
  UNIQUE KEY uk_customer_email (email)     -- ★ 3.7.6：先刪再插會撞這個
) ENGINE=InnoDB;

CREATE TABLE product (
  id         binary(16)    NOT NULL,
  sku        varchar(32)   NOT NULL,
  name       varchar(200)  NOT NULL,
  unit_price decimal(19,4) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_product_sku (sku)
) ENGINE=InnoDB;

CREATE TABLE stock (
  product_id   binary(16) NOT NULL,
  qty          int NOT NULL DEFAULT 0,
  reserved_qty int NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id),
  CONSTRAINT fk_stock_product FOREIGN KEY (product_id) REFERENCES product(id)
) ENGINE=InnoDB;

CREATE TABLE orders (
  id              binary(16)    NOT NULL,
  order_no        varchar(32)   NOT NULL,
  customer_id     binary(16)    NOT NULL,
  status          varchar(16)   NOT NULL,
  total_amount    decimal(19,4) NOT NULL,
  discount_amount decimal(19,4) NOT NULL DEFAULT 0.0000,
  currency        char(3)       NOT NULL DEFAULT 'TWD',
  placed_at       datetime(3)   NOT NULL,
  paid_at         datetime(3)   DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_orders_order_no (order_no),
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
  PRIMARY KEY (id),
  KEY idx_order_item_order (order_id),
  KEY fk_order_item_product (product_id),
  CONSTRAINT fk_order_item_orders  FOREIGN KEY (order_id)   REFERENCES orders(id),
  CONSTRAINT fk_order_item_product FOREIGN KEY (product_id) REFERENCES product(id)
) ENGINE=InnoDB;

CREATE TABLE audit_log (               -- ★ 3.9.5 的稽核回呼要用
  id     bigint AUTO_INCREMENT PRIMARY KEY,
  entity varchar(64) NOT NULL,
  event  varchar(32) NOT NULL,
  note   varchar(255)
) ENGINE=InnoDB;
```

**實體**。這一章的實體刻意**沒有**實作 `Persistable`（01 章 1.6.6），
因為 3.6.3 要親眼量一次「那句多餘的 `SELECT`」：

```java
package com.example.lab.ch03;

import jakarta.persistence.Id;
import jakarta.persistence.MappedSuperclass;
import org.hibernate.Hibernate;
import java.util.UUID;

/** 03 章共用基礎：應用端指定 UUID 主鍵（刻意【不】實作 Persistable）。 */
@MappedSuperclass
public abstract class Base3 {

    @Id
    private UUID id;

    protected Base3() {}
    protected Base3(UUID id) { this.id = id; }

    public UUID getId() { return id; }

    // ★ 對代理安全的 equals / hashCode（01 章 1.14.3、1.14.4）
    @Override public final boolean equals(Object o) {
        if (this == o) return true;
        if (o == null || Hibernate.getClass(this) != Hibernate.getClass(o)) return false;
        UUID mine = getId();
        return mine != null && mine.equals(((Base3) o).getId());
    }
    @Override public final int hashCode() { return Hibernate.getClass(this).hashCode(); }
}
```

```java
package com.example.lab.ch03;

public enum St3 { PENDING, PAID, PACKED, SHIPPED, DELIVERED, CANCELLED, REFUNDED }
```

```java
package com.example.lab.ch03;

import jakarta.persistence.*;
import java.util.UUID;

@Entity @Table(name = "customer")
public class Cust3 extends Base3 {

    @Column(nullable = false, length = 255)
    private String email;

    @Column(name = "display_name", nullable = false, length = 64)
    private String displayName;

    /** ★ 可以是 null 的欄位——3.6.5 要用它示範「merge 靜默清空」。 */
    @Column(length = 64)
    private String nickname;

    protected Cust3() {}
    public Cust3(UUID id, String email, String displayName) {
        super(id); this.email = email; this.displayName = displayName;
    }

    public String getEmail() { return email; }
    public String getDisplayName() { return displayName; }
    public void rename(String n) { this.displayName = n; }
    public void setEmail(String e) { this.email = e; }
    public String getNickname() { return nickname; }
    public void setNickname(String n) { this.nickname = n; }
}
```

```java
package com.example.lab.ch03;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.util.UUID;

@Entity @Table(name = "product")
public class Prod3 extends Base3 {

    @Column(nullable = false, length = 32)  private String sku;
    @Column(nullable = false, length = 200) private String name;

    @Column(name = "unit_price", nullable = false, precision = 19, scale = 4)
    private BigDecimal unitPrice;

    protected Prod3() {}
    public Prod3(UUID id, String sku, String name, BigDecimal unitPrice) {
        super(id); this.sku = sku; this.name = name; this.unitPrice = unitPrice;
    }

    public String getSku() { return sku; }
    public String getName() { return name; }
    public BigDecimal getUnitPrice() { return unitPrice; }
    public void rename(String n) { this.name = n; }
    public void setUnitPrice(BigDecimal p) { this.unitPrice = p; }
}
```

```java
package com.example.lab.ch03;

import jakarta.persistence.*;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;

@Entity @Table(name = "orders")
public class Ord3 extends Base3 {

    @Column(name = "order_no", nullable = false, length = 32) private String orderNo;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "customer_id", nullable = false)
    private Cust3 customer;

    @Enumerated(EnumType.STRING) @JdbcTypeCode(SqlTypes.VARCHAR)
    @Column(nullable = false, length = 16) private St3 status;

    @Column(name = "total_amount", nullable = false, precision = 19, scale = 4)
    private BigDecimal totalAmount = BigDecimal.ZERO;
    @Column(name = "discount_amount", nullable = false, precision = 19, scale = 4)
    private BigDecimal discountAmount = BigDecimal.ZERO;
    @Column(nullable = false, length = 3) @JdbcTypeCode(SqlTypes.CHAR)
    private String currency = "TWD";
    @Column(name = "placed_at", nullable = false) private Instant placedAt;
    @Column(name = "paid_at") private Instant paidAt;

    @OneToMany(mappedBy = "order", cascade = CascadeType.ALL, orphanRemoval = true)
    private List<Item3> items = new ArrayList<>();

    protected Ord3() {}
    public Ord3(UUID id, String orderNo, Cust3 customer) {
        super(id); this.orderNo = orderNo; this.customer = customer;
        this.status = St3.PENDING;
        // ★ 固定時間，讓實測輸出可重現
        this.placedAt = Instant.parse("2026-09-01T00:00:00Z");
    }

    public Item3 addItem(Item3 item) {
        items.add(item);
        item.setOrder(this);                                  // 02 章 2.3.4 的雙向同步
        totalAmount = totalAmount.add(item.getLineAmount());
        return item;
    }
    public void removeItem(Item3 item) {
        if (items.remove(item)) totalAmount = totalAmount.subtract(item.getLineAmount());
    }
    public void pay() { this.status = St3.PAID; this.paidAt = Instant.parse("2026-09-02T00:00:00Z"); }
    public void applyDiscount(BigDecimal d) { this.discountAmount = d; }
    public void setStatus(St3 s) { this.status = s; }
    public void setTotalAmount(BigDecimal t) { this.totalAmount = t; }
    public void setOrderNo(String n) { this.orderNo = n; }

    public String getOrderNo() { return orderNo; }
    public Cust3 getCustomer() { return customer; }
    public St3 getStatus() { return status; }
    public BigDecimal getTotalAmount() { return totalAmount; }
    public BigDecimal getDiscountAmount() { return discountAmount; }
    public String getCurrency() { return currency; }
    public Instant getPlacedAt() { return placedAt; }
    public Instant getPaidAt() { return paidAt; }
    public List<Item3> getItems() { return Collections.unmodifiableList(items); }

    /** ★ 只給實測用：要檢查「集合初始化了嗎」必須拿到原本那個 PersistentBag，
     *    不能拿 unmodifiableList 包過的（3.3.6 會解釋為什麼）。 */
    public List<Item3> itemsRaw() { return items; }
}
```

```java
package com.example.lab.ch03;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.util.UUID;

@Entity @Table(name = "order_item")
public class Item3 extends Base3 {

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "order_id", nullable = false)
    private Ord3 order;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "product_id", nullable = false)
    private Prod3 product;

    @Column(name = "product_name", nullable = false, length = 200) private String productName;
    @Column(name = "unit_price", nullable = false, precision = 19, scale = 4) private BigDecimal unitPrice;
    @Column(nullable = false) private int qty;
    @Column(name = "line_amount", nullable = false, precision = 19, scale = 4) private BigDecimal lineAmount;

    protected Item3() {}
    public Item3(UUID id, Prod3 product, int qty) {
        super(id);
        this.product = product;
        this.productName = product.getName();
        this.unitPrice = product.getUnitPrice();
        this.qty = qty;
        this.lineAmount = product.getUnitPrice().multiply(BigDecimal.valueOf(qty));
    }

    void setOrder(Ord3 o) { this.order = o; }               // package-private（02 章 2.3.4）
    public Ord3 getOrder() { return order; }
    public Prod3 getProduct() { return product; }
    public String getProductName() { return productName; }
    public int getQty() { return qty; }
    public BigDecimal getUnitPrice() { return unitPrice; }
    public BigDecimal getLineAmount() { return lineAmount; }
    public void changeQty(int q) {
        this.qty = q;
        this.lineAmount = unitPrice.multiply(BigDecimal.valueOf(q));
    }
}
```

四個 Repository，**每個一個檔案**：

```java
package com.example.lab.ch03;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.UUID;

public interface Cust3Repo extends JpaRepository<Cust3, UUID> {}
```

```java
package com.example.lab.ch03;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.UUID;

public interface Prod3Repo extends JpaRepository<Prod3, UUID> {}
```

```java
package com.example.lab.ch03;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.UUID;

public interface Ord3Repo extends JpaRepository<Ord3, UUID> {}
```

```java
package com.example.lab.ch03;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.UUID;

public interface Item3Repo extends JpaRepository<Item3, UUID> {}
```

⚠️ **一個踩過的坑**：不要為了省事把這幾個介面寫成一個介面裡的巢狀介面
（`interface Repos3 { interface Cust3Repo extends … }`）。
Spring Data 的 repository 掃描**找不到**它們，啟動時會是
`No qualifying bean of type 'Repos3$Cust3Repo' available`。**一個 repository 一個檔案。**

---

**量尺一：`Pc`——把「持久化情境裡發生了什麼」變成字串。**

這是這一章的主要工具。它用了 Hibernate 的內部 SPI，所以**只在教學／測試裡用，不要進產品程式碼**：

```java
package com.example.lab.ch03;

import jakarta.persistence.EntityManager;
import org.hibernate.engine.spi.EntityEntry;
import org.hibernate.engine.spi.PersistenceContext;
import org.hibernate.engine.spi.SessionImplementor;
import org.hibernate.engine.spi.Status;

import java.util.Arrays;

/** 把「持久化情境裡發生了什麼」變成看得見的字串。全 03 章共用。 */
public final class Pc {

    private static PersistenceContext pc(EntityManager em) {
        return em.unwrap(SessionImplementor.class).getPersistenceContext();
    }

    /** 一個物件現在是四種狀態的哪一種（3.5）。 */
    public static String state(EntityManager em, Object entity) {
        if (entity == null) return "null";
        EntityEntry e = pc(em).getEntry(entity);
        if (e == null) {
            return "TRANSIENT / DETACHED（不在 PC 裡，PC 本身分不出來）";
        }
        Status s = e.getStatus();
        return switch (s) {
            case MANAGED   -> "MANAGED";
            case READ_ONLY -> "MANAGED (read-only：不做髒檢查)";
            case DELETED   -> "REMOVED（已排程刪除，還沒 flush）";
            case GONE      -> "REMOVED（DELETE 已送出）";
            default        -> s.name();
        };
    }

    /** PC 裡目前管著幾個實體、幾個集合。 */
    public static int managedCount(EntityManager em) {
        return pc(em).getNumberOfManagedEntities();
    }
    public static int collectionCount(EntityManager em) {
        return pc(em).getCollectionEntriesSize();
    }

    /** 這個實體「載入當時」的快照——髒檢查比對的那一份（3.4.2）。 */
    public static Object[] snapshot(EntityManager em, Object entity) {
        EntityEntry e = pc(em).getEntry(entity);
        return e == null ? null : e.getLoadedState();
    }

    /** 印出快照的每一格：屬性名 → 載入時的值。 */
    public static void dumpSnapshot(EntityManager em, Object entity) {
        EntityEntry e = pc(em).getEntry(entity);
        if (e == null) { System.out.println("    （不在 PC 裡，沒有快照）"); return; }
        Object[] loaded = e.getLoadedState();
        if (loaded == null) { System.out.println("    （沒有快照：read-only 或剛 persist 的）"); return; }
        String[] names = e.getPersister().getPropertyNames();
        for (int i = 0; i < names.length; i++) {
            System.out.printf("    %-16s = %s%n", names[i], show(loaded[i]));
        }
    }

    private static String show(Object v) {
        if (v == null) return "null";
        if (v.getClass().isArray()) return Arrays.deepToString(new Object[]{v});
        String s = v.toString();
        return s.length() > 60 ? s.substring(0, 60) + "…" : s;
    }

    /** 這個實體現在是不是「髒」的（跟快照有差），以及哪些屬性髒了。 */
    public static boolean isDirty(EntityManager em, Object entity) {
        SessionImplementor s = em.unwrap(SessionImplementor.class);
        EntityEntry e = s.getPersistenceContext().getEntry(entity);
        if (e == null || e.getLoadedState() == null) return false;
        Object[] current = e.getPersister().getValues(entity);
        int[] dirty = e.getPersister().findDirty(current, e.getLoadedState(), entity, s);
        return dirty != null && dirty.length > 0;
    }

    public static String dirtyProps(EntityManager em, Object entity) {
        SessionImplementor s = em.unwrap(SessionImplementor.class);
        EntityEntry e = s.getPersistenceContext().getEntry(entity);
        if (e == null || e.getLoadedState() == null) return "（沒有快照）";
        Object[] current = e.getPersister().getValues(entity);
        int[] dirty = e.getPersister().findDirty(current, e.getLoadedState(), entity, s);
        if (dirty == null || dirty.length == 0) return "（沒有髒屬性）";
        String[] names = e.getPersister().getPropertyNames();
        StringBuilder sb = new StringBuilder();
        for (int i : dirty) sb.append(sb.isEmpty() ? "" : ", ").append(names[i]);
        return sb.toString();
    }

    /** 這個實體是不是代理，以及代理有沒有初始化。 */
    public static String proxy(Object entity) {
        boolean isProxy = entity instanceof org.hibernate.proxy.HibernateProxy;
        return isProxy
            ? "代理（初始化=" + org.hibernate.Hibernate.isInitialized(entity) + "）"
            : "真的實體";
    }

    private Pc() {}
}
```

**量尺二：`SqlSpy`——00 章 0.10.3 那個，原樣沿用。**

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

/** 把每一句真的送到 JDBC 的 SQL 記下來。全課共用的量尺（00 章 0.10.3，原樣搬來）。 */
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

    public static void dump(String title, List<String> sqls) {
        System.out.println("── " + title + " → " + sqls.size() + " 句 SQL");
        for (int i = 0; i < sqls.size(); i++) {
            System.out.println("   " + (i + 1) + ") " + sqls.get(i));
        }
    }

    @Bean
    public static BeanPostProcessor dataSourceSpy() {     // ★ 一定要 static（00 章 0.10.3）
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

**測試基底類別。** 這一章每一個實測都繼承它：

```java
package com.example.lab.ch03;

import com.example.lab.SqlSpy;
import com.example.lab.Uuid7;
import jakarta.persistence.EntityManager;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;

import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;

@SpringBootTest(properties = {
  "spring.datasource.url=jdbc:mysql://127.0.0.1:33306/ch03"
      + "?connectionTimeZone=UTC&forceConnectionTimeZoneToSession=true"
      + "&preserveInstants=true&characterEncoding=UTF-8",
  "spring.jpa.properties.hibernate.generate_statistics=true"
})
public abstract class Base03 {

    @Autowired protected Cust3Repo customers;
    @Autowired protected Prod3Repo products;
    @Autowired protected Ord3Repo  orders;
    @Autowired protected Item3Repo items;
    @Autowired protected EntityManager em;
    @Autowired protected JdbcTemplate jdbc;
    @Autowired protected TransactionTemplate tx;

    protected UUID cid, cid2, pid, pid2, oid, iid;

    protected void clean() {
        jdbc.update("DELETE FROM order_item");
        jdbc.update("DELETE FROM orders");
        jdbc.update("DELETE FROM stock");
        jdbc.update("DELETE FROM product");
        jdbc.update("DELETE FROM customer");
        jdbc.update("DELETE FROM audit_log");
    }

    /** 兩個客戶（第二個沒有訂單）、兩個商品、一張訂單（含一筆明細）。 */
    protected void seed() {
        clean();
        cid = Uuid7.next(); cid2 = Uuid7.next();
        pid = Uuid7.next(); pid2 = Uuid7.next();
        oid = Uuid7.next(); iid = Uuid7.next();
        tx.executeWithoutResult(s -> {
            Cust3 c = new Cust3(cid, "ming@x.com", "小明");
            c.setNickname("阿明");
            customers.save(c);
            customers.save(new Cust3(cid2, "hua@x.com", "小華"));   // 沒有訂單的客戶
            Prod3 p = products.save(new Prod3(pid, "SKU-1", "機械鍵盤", new BigDecimal("100.0000")));
            products.save(new Prod3(pid2, "SKU-2", "滑鼠", new BigDecimal("50.0000")));
            Ord3 o = new Ord3(oid, "SO-1", c);
            o.addItem(new Item3(iid, p, 2));
            orders.save(o);
        });
    }

    protected long rows(String table) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM " + table, Long.class);
    }
    protected String nameInDb(UUID id) {
        return jdbc.queryForObject("SELECT display_name FROM customer WHERE id = ?",
                String.class, Uuid7.toBytes(id));
    }
    protected String nickInDb(UUID id) {
        return jdbc.queryForObject("SELECT nickname FROM customer WHERE id = ?",
                String.class, Uuid7.toBytes(id));
    }
    protected String statusInDb(UUID id) {
        return jdbc.queryForObject("SELECT status FROM orders WHERE id = ?",
                String.class, Uuid7.toBytes(id));
    }
    protected void head(String title) {
        System.out.println("\n═══ " + title + " ═══");
    }

    /** 量一段程式碼打了幾句 SQL。 */
    protected List<String> spy(Runnable body) {
        SqlSpy.start();
        try {
            body.run();
            return SqlSpy.stop();
        } catch (RuntimeException | Error e) {
            SqlSpy.stop();
            throw e;              // ★ 不要在 finally 裡 return，會把例外整個吃掉
        }
    }
}
```

> ⚠️ **最後那個註解是一個真的踩到的坑，而且它值得單獨講一次。**
>
> 這個 helper 的第一版是這樣寫的：
>
> ```java
> protected List<String> spy(Runnable body) {
>     SqlSpy.start();
>     try { body.run(); } finally { return SqlSpy.stop(); }   // ❌
> }
> ```
>
> 看起來很整潔。而 `finally` 裡的 `return` 會**吞掉正在往外拋的例外**——
> 這是 Java 語言規範定義的行為，不是 bug。
>
> 結果：3.9.5 有一個實測，第一次跑出來的是「**494 句 SQL**」，
> 而真相是「**`StackOverflowError`，而且那 494 句根本沒有 commit**」。
> **一個測試工具的瑕疵，讓一個實測結論完全反了。**
>
> 📌 這件事的教訓不只在 JPA：**任何用來「觀測」的程式碼，
> 它自己不能改變被觀測對象的行為**——包括「不能把例外藏起來」。

**`application.yml`**（00 章 0.10.2 那份，這一章多開一個統計）：

```yaml
spring:
  jpa:
    hibernate:
      ddl-auto: none          # ★ schema 由 SQL 管（01 章 1.5）
    open-in-view: false       # ★ 本課一律 false（3.8.7）
    properties:
      hibernate:
        format_sql: false
        generate_statistics: true    # ★ 3.10 的 PcSpy 要用
logging:
  level:
    root: WARN
    com.example.lab: INFO
```

---

## 3.3 一級快取 ★★

### 3.3.1 實測：同一個交易撈兩次

```java
package com.example.lab.ch03;

import org.junit.jupiter.api.Test;

class A2Cache extends Base03 {

    @Test
    void 同一個交易撈兩次() {
        seed();
        head("同一個交易裡，findById 同一個 id 兩次");
        tx.executeWithoutResult(s -> {
            var sqls = spy(() -> {
                Cust3 a = customers.findById(cid).orElseThrow();
                Cust3 b = customers.findById(cid).orElseThrow();
                System.out.println("  a == b ?  " + (a == b));
                System.out.println("  PC 管幾個 : " + Pc.managedCount(em));
            });
            System.out.println("  → " + sqls.size() + " 句 SQL");
            sqls.forEach(q -> System.out.println("     " + q));
        });
    }
}
```

```
═══ 同一個交易裡，findById 同一個 id 兩次 ═══
  a == b ?  true
  PC 管幾個 : 1
  → 1 句 SQL
     select c1_0.id,c1_0.display_name,c1_0.email from customer c1_0 where c1_0.id=?
```

跟 3.2.4 那個「沒有交易 → 2 句 SQL、`a == b` 是 `false`」**恰好相反**。

> 📌 **一級快取的核心保證**：
>
> > **在同一個持久化情境裡，同一個 `(實體類別, id)` 永遠對到同一個 Java 物件。**
>
> 這個保證比「省一句 SQL」重要得多。它意味著：
> **你在方法 A 裡改的那個 `Order`，跟方法 B 裡撈到的那個 `Order`，是同一個物件。**
> 02 章 2.3.4 那些雙向同步的輔助方法之所以有意義，靠的就是這一條。

### 3.3.2 實測：四種撈法都進同一個快取

```java
    @Test
    void 四種撈法都進同一個快取() {
        seed();
        head("四種不同的撈法，第二次之後都不打 SQL 了嗎");
        tx.executeWithoutResult(s -> {
            var sqls = spy(() -> {
                Cust3 a = customers.findById(cid).orElseThrow();
                Cust3 b = em.find(Cust3.class, cid);
                Cust3 c = customers.getReferenceById(cid);
                Cust3 d = em.createQuery("select c from Cust3 c where c.id = :id", Cust3.class)
                            .setParameter("id", cid).getSingleResult();
                System.out.println("  findById         : " + id(a));
                System.out.println("  em.find          : " + id(b) + "  同一個? " + (a == b));
                System.out.println("  getReferenceById : " + id(c) + "  同一個? " + (a == c));
                System.out.println("  JPQL             : " + id(d) + "  同一個? " + (a == d));
            });
            System.out.println("  → 共 " + sqls.size() + " 句 SQL");
            sqls.forEach(q -> System.out.println("     " + q));
        });
    }

    private static String id(Object o) {
        return o.getClass().getSimpleName() + "@" + Integer.toHexString(System.identityHashCode(o));
    }
```

```
═══ 四種不同的撈法，第二次之後都不打 SQL 了嗎 ═══
  findById            : Cust3@7b0f5814
  em.find             : Cust3@7b0f5814  同一個? true
  getReferenceById    : Cust3@7b0f5814  同一個? true
  JPQL                : Cust3@7b0f5814  同一個? true
  → 共 2 句 SQL
     select c1_0.id,c1_0.display_name,c1_0.email from customer c1_0 where c1_0.id=?
     select c1_0.id,c1_0.display_name,c1_0.email from customer c1_0 where c1_0.id=?
```

**四個變數都是同一個物件（`@7b0f5814`）。但 SQL 是 2 句，不是 1 句。**

⚠️⚠️ **這是這一節最重要的一行**，把它拆開來看：

| 撈法 | 有先查一級快取嗎 | 這次打了 SQL 嗎 |
|---|---|---|
| `findById(id)` | ✅ 有 | 第一次有，之後沒有 |
| `em.find(類別, id)` | ✅ 有 | ❌ 沒有（快取命中） |
| `getReferenceById(id)` | ✅ 有 | ❌ 沒有（快取命中，直接給那個物件） |
| **JPQL / Criteria / 原生 SQL** | 🔴 **沒有** | ✅ **一定打** |

> 🔴 **`findById` 走快取，JPQL 不走。**
>
> **為什麼**：一級快取的 key 是 `(類別, 主鍵)`。
> `findById` 手上就有主鍵，可以直接查那張 Map。
> 而 `select o from Ord3 o where o.status = 'PENDING'` **手上沒有主鍵**——
> Hibernate 唯一能知道「誰符合這個條件」的辦法，就是**問資料庫**。
>
> 📌 記法：**一級快取是一個「用 id 查」的快取，不是一個「用條件查」的快取。**

而下一節要講的，是這兩件事**撞在一起**時發生什麼。

### 3.3.3 實測：一級快取什麼時候會騙你 ★★

3.3.2 留下一個問題：

```
JPQL 一定會打 SQL、資料庫一定會回一列資料。
那如果【資料庫回的那一列】跟【一級快取裡那個物件】不一樣呢？
```

```java
    @Test
    void JPQL不看一級快取但回傳快取裡的物件() {
        seed();
        head("🔴 一級快取什麼時候會騙你");
        tx.executeWithoutResult(s -> {
            Cust3 c = customers.findById(cid).orElseThrow();
            System.out.println("  ① 先撈一次，記憶體裡的名字 = " + c.getDisplayName());

            // 同一個交易裡，用 JdbcTemplate 直接改資料庫（繞過 JPA）
            jdbc.update("UPDATE customer SET display_name = ? WHERE id = ?",
                    "小華", Uuid7.toBytes(cid));
            System.out.println("  ② 用 JdbcTemplate 把資料庫改成 小華（同一個交易、同一條連線）");
            System.out.println("     資料庫現在是 : " + nameInDb(cid));

            var sqls = spy(() -> {
                Cust3 again = em.createQuery(
                        "select c from Cust3 c where c.id = :id", Cust3.class)
                        .setParameter("id", cid).getSingleResult();
                System.out.println("  ③ 用 JPQL 重新查一次（這句【真的】送到資料庫）");
                System.out.println("     拿到的物件 : " + id(again) + "  跟 ① 同一個? " + (again == c));
                System.out.println("     名字       : " + again.getDisplayName());

                String scalar = em.createQuery(
                        "select c.displayName from Cust3 c where c.id = :id", String.class)
                        .setParameter("id", cid).getSingleResult();
                System.out.println("  ④ 同一句查詢改成【投影】(select c.displayName)");
                System.out.println("     拿到的字串 : " + scalar);
            });
            System.out.println("  → ③④ 共 " + sqls.size() + " 句 SQL");
            sqls.forEach(q -> System.out.println("     " + q));
        });
    }
```

```
═══ 🔴 一級快取什麼時候會騙你 ═══
  ① 先撈一次，記憶體裡的名字 = 小明
  ② 用 JdbcTemplate 把資料庫改成 小華（同一個交易、同一條連線）
     資料庫現在是 : 小華
  ③ 用 JPQL 重新查一次（這句【真的】送到資料庫）
     拿到的物件 : Cust3@24bd88df  跟 ① 同一個? true
     名字       : 小明   ← 🔴 資料庫回的是 小華，但你拿到 小明
  ④ 同一句查詢改成【投影】(select c.displayName)
     拿到的字串 : 小華   ← ✅ 這證明 ③ 那句 SQL 真的看到了 小華
  → ③④ 共 2 句 SQL
     select c1_0.id,c1_0.display_name,c1_0.email from customer c1_0 where c1_0.id=?
     select c1_0.display_name from customer c1_0 where c1_0.id=?
```

🔴🔴 **③ 和 ④ 是同一列資料、同一個交易、相鄰兩行程式碼，答案不一樣。**

**為什麼**：

```
③ select c from Cust3 c        ← 查【實體】
   SQL 送出去了、資料庫回了 (id, "小華", …)
   Hibernate 拿到這一列，準備組一個 Cust3 物件……
   ↓
   「等一下，(Cust3, 01a07a93-…) 這個 key 我快取裡【已經有了】。」
   ↓
   把資料庫回的那一列【丟掉】，回傳快取裡那個物件。   ← 就是這裡騙你

④ select c.displayName from Cust3 c    ← 查【一個字串】
   字串不是實體，沒有主鍵、不進一級快取
   → 資料庫回什麼就是什麼
```

> 📌 **這個行為有名字：一級快取的「repeatable read」保證。**
>
> Hibernate **刻意**這樣做。理由是 3.3.1 那個核心保證：
> **同一個交易裡，同一個 id 必須永遠是同一個 Java 物件。**
>
> 如果 ③ 回傳一個新的、內容不同的 `Cust3`，那你手上會有**兩個代表同一列資料的物件**，
> 而你對其中一個做的修改會被另一個蓋掉。**那比「拿到舊值」糟糕得多。**
>
> **所以這不是 bug，是設計。而它的代價就是：**
> **「查詢的結果」跟「你拿到的物件」可以不一樣。**

⚠️ **這一條在什麼時候真的會咬你**：

```
① JPA 與 MyBatis / JdbcTemplate 混用，而且【同一個交易裡】兩邊都碰同一張表
      → 00 章 0.9 的三條規則就是為了避免這個
② 你自己寫了 UPDATE / DELETE 的 JPQL（@Modifying）
      → 那種 SQL 直接打資料庫，【完全不經過】持久化情境
      → 06 章會講，而且 Spring Data 有 clearAutomatically 這個選項就是為了它
③ 交易裡有人呼叫了預存程序、或觸發器改了資料
```

**②的最小重現**：

```java
// ❌ 這種寫法在同一個交易裡會讓你的實體「跟資料庫不一致」
@Modifying
@Query("update Ord3 o set o.status = 'CANCELLED' where o.placedAt < :t")
int cancelOld(@Param("t") Instant t);
// 執行完，PC 裡那些 Ord3 物件的 status 全部【還是舊的】
// 解法：@Modifying(clearAutomatically = true, flushAutomatically = true)
```

### 3.3.4 實測：兩層快取（PC + InnoDB 快照）

3.3.3 是「同一個交易裡自己打自己」。那如果是**別人**改的呢？

⚠️ **這裡會出現一個很容易被誤診的現象**，所以要把隔離等級明講。

```java
    @Test
    void 外部改了資料庫快取不知道() {
        seed();
        head("READ COMMITTED：別的交易 commit 了，你的一級快取知道嗎");
        txWith(java.sql.Connection.TRANSACTION_READ_COMMITTED).executeWithoutResult(s -> {
            Cust3 c = customers.findById(cid).orElseThrow();
            System.out.println("  ① 撈到          : " + c.getDisplayName());
            outsideUpdate("小華");
            System.out.println("  ② 外面有人改成   : 小華（另一個交易，已 commit）");
            System.out.println("  ③ 投影查詢      : " + scalarName());
            System.out.println("  ④ 再 findById   : "
                    + customers.findById(cid).orElseThrow().getDisplayName());
            System.out.println("  ⑤ 再跑 JPQL     : " + jpqlName());
            em.refresh(c);
            System.out.println("  ⑥ em.refresh(c) : " + c.getDisplayName());
        });

        seed();
        head("REPEATABLE READ（MySQL 預設）：同一段程式碼，連 ③ 都變了");
        txWith(java.sql.Connection.TRANSACTION_REPEATABLE_READ).executeWithoutResult(s -> {
            Cust3 c = customers.findById(cid).orElseThrow();
            System.out.println("  ① 撈到          : " + c.getDisplayName());
            outsideUpdate("小華");
            System.out.println("  ② 外面有人改成   : 小華（另一個交易，已 commit）");
            System.out.println("  ③ 投影查詢      : " + scalarName());
            em.refresh(c);
            System.out.println("  ⑥ em.refresh(c) : " + c.getDisplayName());
        });
    }

    private String scalarName() {
        return em.createQuery("select c.displayName from Cust3 c where c.id = :id", String.class)
                .setParameter("id", cid).getSingleResult();
    }
    private String jpqlName() {
        return em.createQuery("select c from Cust3 c where c.id = :id", Cust3.class)
                .setParameter("id", cid).getSingleResult().getDisplayName();
    }

    /** 用一個【獨立的新交易】改資料，模擬「外面有人動了」。 */
    private void outsideUpdate(String name) {
        var t = new org.springframework.transaction.support.TransactionTemplate(tmRef);
        t.setPropagationBehavior(
                org.springframework.transaction.TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        t.executeWithoutResult(st ->
                new org.springframework.jdbc.core.JdbcTemplate(ds).update(
                        "UPDATE customer SET display_name = ? WHERE id = ?",
                        name, Uuid7.toBytes(cid)));
    }

    /** 指定隔離等級的 TransactionTemplate。 */
    private org.springframework.transaction.support.TransactionTemplate txWith(int isolation) {
        var t = new org.springframework.transaction.support.TransactionTemplate(tmRef);
        t.setIsolationLevel(isolation);
        return t;
    }

    @org.springframework.beans.factory.annotation.Autowired
    org.springframework.transaction.PlatformTransactionManager tmRef;
    @org.springframework.beans.factory.annotation.Autowired
    javax.sql.DataSource ds;
```

```
═══ READ COMMITTED：別的交易 commit 了，你的一級快取知道嗎 ═══
  ① 撈到          : 小明
  ② 外面有人改成   : 小華（另一個交易，已 commit）
  ③ 投影查詢      : 小華   ← ✅ 資料庫確實已經是小華
  ④ 再 findById   : 小明   ← 🔴
  ⑤ 再跑 JPQL     : 小明   ← 🔴
  ⑥ em.refresh(c) : 小華   ← ✅

═══ REPEATABLE READ（MySQL 預設）：同一段程式碼，連 ③ 都變了 ═══
  ① 撈到          : 小明
  ② 外面有人改成   : 小華（另一個交易，已 commit）
  ③ 投影查詢      : 小明   ← 🔴 連資料庫都說是小明（InnoDB 快照）
  ⑥ em.refresh(c) : 小明   ← 🔴 refresh 也救不了
```

🔴🔴 **有兩層東西在騙你，而它們是不同的東西、有不同的解法。**

| | 是誰 | 在哪一層 | 解法 |
|---|---|---|---|
| **第一層** | 一級快取 | **應用程式**（JVM 記憶體） | `em.refresh()` / `em.clear()` |
| **第二層** | InnoDB 的一致性讀快照 | **資料庫**（07 站 04 章） | 換隔離等級 / `SELECT … FOR UPDATE` |

> ⚠️ **這一節的診斷順序很重要，因為兩層的症狀一模一樣。**
>
> ```
> 症狀：「我明明看到 DB 裡是新值，程式撈出來還是舊的」
>
> Step 1  在同一個交易裡跑一句【投影】查詢（select c.displayName …）
>            → 拿到新值 → 是【一級快取】在騙你（第一層）
>            → 拿到舊值 → 是【資料庫快照】在騙你（第二層）
> Step 2  第一層 → em.refresh() 或把那個實體從 PC 清掉
>         第二層 → 這是 MySQL 的 REPEATABLE READ，要動隔離等級或縮短交易
> ```
>
> 📌 **注意 REPEATABLE READ 那組的 ⑥**：`em.refresh()` 打了 SQL、
> 也真的重新讀了，**但它讀到的還是快照裡的舊值**。
> 「`refresh` 解決不了」本身就是第二層的一個判準。

**這也是為什麼本課的長流程一律不用長交易**（3.8.7）：
交易越長，你手上那份快照離現實越遠——**而這一點跟 JPA 完全無關，是資料庫的事。**

### 3.3.5 `getReference` 與 `find`

```java
    @Test
    void getReference跟find的差別() {
        seed();
        head("getReferenceById：拿到什麼、打幾句 SQL");
        tx.executeWithoutResult(s -> {
            var sqls = spy(() -> {
                Cust3 ref = customers.getReferenceById(cid);
                System.out.println("  拿到 : " + ref.getClass().getSimpleName());
                System.out.println("  是   : " + Pc.proxy(ref));
                System.out.println("  getId()          → "
                        + (ref.getId() != null ? "有值" : "null")
                        + "、初始化=" + org.hibernate.Hibernate.isInitialized(ref));
                System.out.println("  getDisplayName() → " + ref.getDisplayName()
                        + "、初始化=" + org.hibernate.Hibernate.isInitialized(ref));
            });
            System.out.println("  → " + sqls.size() + " 句 SQL");
        });

        head("先 find 再 getReference，拿到的是代理還是真的實體");
        tx.executeWithoutResult(s -> {
            Cust3 real = customers.findById(cid).orElseThrow();
            Cust3 ref = customers.getReferenceById(cid);
            System.out.println("  find      : " + Pc.proxy(real));
            System.out.println("  getRef    : " + Pc.proxy(ref));
            System.out.println("  同一個嗎   : " + (real == ref));
        });

        head("反過來：先 getReference 再 find");
        tx.executeWithoutResult(s -> {
            Cust3 ref = customers.getReferenceById(cid);
            Cust3 real = customers.findById(cid).orElseThrow();
            System.out.println("  getRef    : " + Pc.proxy(ref));
            System.out.println("  find      : " + Pc.proxy(real));
            System.out.println("  同一個嗎   : " + (real == ref));
        });
    }
```

```
═══ getReferenceById：拿到什麼、打幾句 SQL ═══
  拿到 : Cust3$HibernateProxy$4agxr5zt
  是   : 代理（初始化=false）
  getId()          → 有值、初始化=false
  getDisplayName() → 小明、初始化=true
  → 1 句 SQL（getId 沒打、getDisplayName 才打）

═══ 先 find 再 getReference，拿到的是代理還是真的實體 ═══
  find      : 真的實體
  getRef    : 真的實體
  同一個嗎   : true

═══ 反過來：先 getReference 再 find ═══
  getRef    : 代理（初始化=true）
  find      : 代理（初始化=true）   ← 🔴 也是代理
  同一個嗎   : true
```

⚠️ **注意第三組**：先 `getReference` 之後，連 `find` 都回傳代理。

**為什麼**：一級快取的核心保證是「同一個 id → 同一個物件」。
代理已經在 Map 裡了，`find` 只能把它交出來（並順手初始化它），
**不能換一個物件給你**——否則保證就破了。

📌 這就是 02 章 2.7.3 那個「`@OneToOne` 反向側的 LAZY 無效」的另外一半：
**你在一個交易裡拿到什麼型別的物件，取決於那個交易裡「誰先碰它」。**

**三個實用結論**：

| 情境 | 用 | 為什麼 |
|---|---|---|
| 只是要**設一個外鍵**（`new Ord3(id, no, customer)`） | `getReferenceById` | 不需要真的撈那一列，省一句 SQL |
| 要**讀它的欄位**、或要做業務判斷 | `findById` | 反正一定要撈，`getReference` 只是延後 |
| 要**確認它存在** | `findById` | `getReferenceById` 對不存在的 id **不會**立刻報錯 |

🔴 **最後一條的坑**：

```java
Cust3 ghost = customers.getReferenceById(UUID.randomUUID());  // 不存在的 id
// 這一行不會炸
ghost.getDisplayName();     // ← 這一行才炸：EntityNotFoundException
```

### 3.3.6 實測：PC 也管集合（回答 02 章 2.4.1）

02 章 2.4.1 留了一個問題：**同一段程式碼，集合有時看得到新資料、有時看不到，
而差別在「幾行之前有沒有碰過它」。** 現在可以回答了。

```java
    @Test
    void 集合的初始化狀態也在PC裡() {
        seed();
        head("PC 除了管實體，也管集合（回答 02 章 2.4.1）");
        tx.executeWithoutResult(s -> {
            Ord3 o = orders.findById(oid).orElseThrow();
            System.out.println("  剛撈到訂單        : 實體 " + Pc.managedCount(em)
                    + " 個、集合 " + Pc.collectionCount(em) + " 個");
            System.out.println("  集合初始化了嗎     : "
                    + org.hibernate.Hibernate.isInitialized(o.itemsRaw()));
            o.getItems().size();   // 碰一下
            System.out.println("  碰過集合之後      : 實體 " + Pc.managedCount(em)
                    + " 個、集合 " + Pc.collectionCount(em) + " 個");
            System.out.println("  集合初始化了嗎     : "
                    + org.hibernate.Hibernate.isInitialized(o.itemsRaw()));
        });
    }
```

```
═══ PC 除了管實體，也管集合（回答 02 章 2.4.1） ═══
  剛撈到訂單        : 實體 1 個、集合 1 個
  集合初始化了嗎     : false
  碰過集合之後      : 實體 2 個、集合 1 個
  集合初始化了嗎     : true
```

**答案**：持久化情境裡有**兩張表**，不是一張：

```
① entitiesByKey        (類別, id)  →  實體物件            ← 3.3.1 講的那張
② collectionEntries    集合物件    →  CollectionEntry     ← 這一張
                                        └─ initialized: true / false
                                        └─ 載入時的快照（給髒檢查用）
```

而 02 章 2.4.1 的兩種答案，就是 `initialized` 這個布林值的兩種值：

```
② 那張表裡的 initialized = false  →  下次碰它才去撈 → 撈到的是【現在】的資料 → 看得到
                          = true   →  已經有內容了，不會再撈 → 看不到後來的變更
```

⚠️ **注意「集合 1 個」在碰之前就已經是 1**：
`CollectionEntry` 在撈到 `Ord3` 的那一刻就建好了（此時 `initialized=false`），
**不是**在初始化的時候才建。這就是為什麼 Hibernate 有辦法知道「這個集合是延遲的」。

📌 **順便解釋一個 3.2.5 裡埋的細節**：這個實測用的是 `o.itemsRaw()` 而不是 `o.getItems()`。

```java
public List<Item3> getItems() { return Collections.unmodifiableList(items); }
```

`unmodifiableList` 是一個**包裝物件**，不是 Hibernate 的 `PersistentBag`。
把它丟給 `Hibernate.isInitialized()`，會得到 **`true`**——因為對一個「不是持久化集合」的東西，
它的答案就是「已初始化」。

🔴 **這是一個很容易寫出來的假實測**：`isInitialized(order.getItems())` 永遠回 `true`，
你會以為集合永遠是載入好的。**要檢查初始化狀態，必須拿到 Hibernate 塞進去的那個集合本人。**

### 3.3.7 一級快取不能關，只能清

```java
    @Test
    void 快取只能清不能關() {
        seed();
        head("clear / detach / contains");
        tx.executeWithoutResult(s -> {
            Cust3 c = customers.findById(cid).orElseThrow();
            Ord3 o = orders.findById(oid).orElseThrow();
            System.out.println("  撈了兩個     : PC 管 " + Pc.managedCount(em) + " 個");
            System.out.println("  contains(c)  : " + em.contains(c));
            em.detach(c);
            System.out.println("  detach(c) 後 : PC 管 " + Pc.managedCount(em)
                    + " 個、contains(c) = " + em.contains(c));
            em.clear();
            System.out.println("  clear() 後   : PC 管 " + Pc.managedCount(em)
                    + " 個、contains(o) = " + em.contains(o));

            var sqls = spy(() -> customers.findById(cid).orElseThrow());
            System.out.println("  clear 之後再 findById → " + sqls.size() + " 句 SQL");
        });
    }
```

```
═══ clear / detach / contains ═══
  撈了兩個     : PC 管 2 個
  contains(c)  : true
  detach(c) 後 : PC 管 1 個、contains(c) = false
  clear() 後   : PC 管 0 個、contains(o) = false
  clear 之後再 findById → 1 句 SQL
```

⚠️ **JPA 沒有「關掉一級快取」這個選項。** 它是持久化情境的**定義**的一部分，
不是一個可以開關的功能。你只有三個工具：

| API | 範圍 | 未 flush 的修改會怎樣 |
|---|---|---|
| `em.detach(entity)` | 一個實體 | 🔴 **丟掉** |
| `em.clear()` | 全部 | 🔴 **全部丟掉** |
| `em.refresh(entity)` | 一個實體 | 🔴 **丟掉**，並從資料庫重讀 |

🔴 **三個都會丟掉修改**，所以它們**不能在「改完但還沒 flush」的時候呼叫**。
正確的順序是 `flush()` 再 `clear()`：

```java
// 06 章批次寫入的標準寫法（這裡先看一眼）
for (int i = 0; i < rows.size(); i++) {
    em.persist(toEntity(rows.get(i)));
    if (i % 500 == 0) {
        em.flush();     // ★ 先把 500 筆送出去
        em.clear();     // ★ 再清掉，否則 PC 會長到 100 萬個實體
    }
}
```

**而「為什麼要清」，3.4.8 會給一個數字。**

### 3.3.8 一級快取的六條規則

```
① 同一個持久化情境裡，同一個 (類別, id) → 永遠是同一個 Java 物件
② findById / em.find / getReferenceById 【走】快取
③ JPQL / Criteria / 原生 SQL 【不走】快取——一定打 SQL
④ 但 ③ 查【實體】時，回傳的仍然是快取裡那個物件（資料庫回的值被丟掉）★★
⑤ 快取不知道外面的世界。別人改了，你要 refresh
⑥ 快取不能關，只能 detach / clear / refresh，而三者都會丟掉未 flush 的修改
```

⚠️ **第 ④ 條是這一節唯一「反直覺」的**，也是最值得記的一條。
如果你只能記一句話，記這個：

> **JPQL 會重新查資料庫，但不會重新填你的物件。**

---

## 3.4 髒檢查與快照 ★★

### 3.4.1 實測：回答 00 章 0.3.1

00 章的事故一是這樣的：

> 一段程式碼裡**沒有任何一行** `save()`、`persist()`、`merge()`，
> 而資料庫被改掉了。

```java
package com.example.lab.ch03;

import org.junit.jupiter.api.Test;

class A3Dirty extends Base03 {

    @Test
    void 沒有呼叫save資料卻改了() {
        seed();
        head("回答 00 章 0.3.1：整段程式碼沒有 save()");
        var sqls = spy(() -> tx.executeWithoutResult(s -> {
            Cust3 c = customers.findById(cid).orElseThrow();
            c.rename("小華");
            // 沒有 customers.save(c)、沒有 em.persist、沒有 em.merge
        }));
        System.out.println("  → " + sqls.size() + " 句 SQL");
        sqls.forEach(q -> System.out.println("     " + q));
        System.out.println("  資料庫現在 : " + nameInDb(cid));
    }
}
```

```
═══ 回答 00 章 0.3.1：整段程式碼沒有 save() ═══
  → 2 句 SQL
     select c1_0.id,c1_0.display_name,c1_0.email from customer c1_0 where c1_0.id=?
     update customer set display_name=?,email=? where id=?
  資料庫現在 : 小華
```

**答案**：

```
findById 把那一列撈出來 → Hibernate 做了兩件事：
   ① 把物件放進一級快取（3.3）
   ② 【額外】留了一份「載入當時每個欄位的值」的陣列 —— 快照

交易 commit 之前，Hibernate 把 PC 裡每一個實體
   拿現在的值 vs 快照 比對一次   ← 這就是【髒檢查】

有差的，產生一句 UPDATE。
```

> 📌 **這才是 JPA 的核心觀念，而它跟大部分人第一次學到的「ORM = 幫你寫 SQL」完全不同**：
>
> > **你不是「告訴 JPA 要寫什麼」，你是「改一個物件」。**
> > **JPA 自己去比對你改了什麼，然後決定要寫什麼。**
>
> 這句話會在這一章反覆出現，因為它同時解釋了 JPA 的**方便**與 JPA 的**每一個坑**。

⚠️ **這也意味著一件反直覺的事：`save()` 對一個 managed 實體是【多餘的】。**

```java
// 這兩段程式碼的行為【完全一樣】，SQL 也一字不差
tx(() -> { Cust3 c = customers.findById(cid).get(); c.rename("小華"); });
tx(() -> { Cust3 c = customers.findById(cid).get(); c.rename("小華"); customers.save(c); });
```

而多寫那個 `save(c)` **不是無害的**——3.6 會證明它在某些情況下會**吃掉你的資料**。

### 3.4.2 實測：快照長什麼樣

「快照」不是一個抽象概念，它是一個 `Object[]`，可以印出來：

```java
    @Test
    void 快照長什麼樣() {
        seed();
        head("髒檢查比對的那一份「快照」");
        tx.executeWithoutResult(s -> {
            Ord3 o = orders.findById(oid).orElseThrow();
            System.out.println("  載入當時的快照（EntityEntry.loadedState）：");
            Pc.dumpSnapshot(em, o);
            o.pay();
            o.applyDiscount(new BigDecimal("10.0000"));
            System.out.println("  改了 status / paidAt / discountAmount 之後：");
            System.out.println("    快照還是舊的 → status = "
                    + Pc.snapshot(em, o)[indexOf(em, o, "status")]);
            System.out.println("    物件是新的   → status = " + o.getStatus());
            System.out.println("    髒屬性       : " + Pc.dirtyProps(em, o));
        });
    }

    private static int indexOf(EntityManager em, Object entity, String prop) {
        var e = em.unwrap(org.hibernate.engine.spi.SessionImplementor.class)
                .getPersistenceContext().getEntry(entity);
        String[] names = e.getPersister().getPropertyNames();
        for (int i = 0; i < names.length; i++) if (names[i].equals(prop)) return i;
        return -1;
    }
```

```
═══ 髒檢查比對的那一份「快照」 ═══
  載入當時的快照（EntityEntry.loadedState）：
    currency         = TWD
    customer         = com.example.lab.ch03.Cust3@7d3fb0ef
    discountAmount   = 0.0000
    items            = [com.example.lab.ch03.Item3@3e3315d9]
    orderNo          = SO-1
    paidAt           = null
    placedAt         = 2026-09-01T00:00:00Z
    status           = PENDING
    totalAmount      = 200.0000
  改了 status / paidAt / discountAmount 之後：
    快照還是舊的 → status = PENDING
    物件是新的   → status = PAID
    髒屬性       : discountAmount, paidAt, status
```

**三個要注意的地方**：

**① 快照裡沒有 `id`。** 主鍵不在髒檢查的範圍裡——它不能改。

**② 快照裡有 `customer` 與 `items`（關聯）。** 而它們存的**不是**內容，是**物件參考**。
這正是 02 章 2.6.3 那個「14 句 vs 3 句」的機制：

```
快照裡 items = [Item3@3e3315d9]     ← 存的是【物件實例的參考】

寫法一：items.clear() 再重建 → 集合裡是 5 個【新】物件
        → 跟快照裡的 5 個參考【一個都對不上】
        → Hibernate 只能：5 句 DELETE + 5 句 INSERT

寫法二：item.changeQty(3)         → 集合裡還是【同一個】物件
        → 跟快照對得上，只有那個物件自己的 qty 屬性髒了
        → 1 句 UPDATE
```

📌 **02 章 2.6.3 的完整答案**：「JPA 到底是全刪重插還是逐筆 diff」——
**是逐筆 diff，而 diff 的單位是「物件實例」，不是「主鍵值」。**
你把集合清掉重建，即使新物件的 id 跟舊的一模一樣，對 Hibernate 來說**它們就是不同的東西**。

**③ 髒屬性剛好是三個，跟我改的三個對得上。** 而**它們的順序是屬性名的字母序**，不是宣告序。
這件事在 3.4.6 會變得重要。

### 3.4.3 實測：髒檢查什麼時候做

```java
    @Test
    void 髒檢查是在flush的時候做的() {
        seed();
        head("改了之後，什麼時候才「算」髒");
        tx.executeWithoutResult(s -> {
            Cust3 c = customers.findById(cid).orElseThrow();
            System.out.println("  剛撈到      : 髒嗎=" + Pc.isDirty(em, c)
                    + "、髒屬性=" + Pc.dirtyProps(em, c));
            c.rename("小華");
            System.out.println("  改完 setter : 髒嗎=" + Pc.isDirty(em, c)
                    + "、髒屬性=" + Pc.dirtyProps(em, c));
            System.out.println("  但這時候資料庫還是 : " + nameInDb(cid));
            var sqls = spy(() -> em.flush());
            System.out.println("  em.flush() → " + sqls.size() + " 句 SQL");
            System.out.println("  flush 之後  : 髒嗎=" + Pc.isDirty(em, c)
                    + "、資料庫=" + nameInDb(cid));
        });
    }
```

```
═══ 改了之後，什麼時候才「算」髒 ═══
  剛撈到      : 髒嗎=false、髒屬性=（沒有髒屬性）
  改完 setter : 髒嗎=true、髒屬性=displayName
  但這時候資料庫還是 : 小明
  em.flush() → 1 句 SQL
  flush 之後  : 髒嗎=false、資料庫=小華
```

⚠️ **要分清兩件事**：

```
「這個實體是不是髒的」   ← 隨時都可以【算】出來（比對物件 vs 快照）
「Hibernate 什麼時候算」 ← 只在 flush 的時候（3.7）
```

📌 換句話說：**setter 不會做任何事。** 它就是一個普通的 Java 賦值。
沒有攔截、沒有事件、沒有標記（除非你開啟 bytecode enhancement，見 3.4.8 末）。

**而 `flush()` 之後髒旗標消失了**——因為 `flush` 會**把快照更新成新值**。
這是一個常被忽略的細節，它解釋了「為什麼 flush 兩次不會 UPDATE 兩次」。

### 3.4.4 實測：設回同一個值（回答 02 章 2.6.3）

```java
    @Test
    void 設回同一個值() {
        seed();
        head("回答 02 章 2.6.3：設回同一個值，會不會打 UPDATE");
        var sqls = spy(() -> tx.executeWithoutResult(s -> {
            Cust3 c = customers.findById(cid).orElseThrow();
            c.rename("小明");                      // 本來就叫小明
            System.out.println("  設回同一個【字串內容】：髒嗎=" + Pc.isDirty(em, c));
            c.rename(new String("小明"));          // 不同的 String 物件、一樣的內容
            System.out.println("  換一個 String 物件    ：髒嗎=" + Pc.isDirty(em, c));
        }));
        System.out.println("  → 整個交易 " + sqls.size() + " 句 SQL");
        sqls.forEach(q -> System.out.println("     " + q));
    }
```

```
═══ 回答 02 章 2.6.3：設回同一個值，會不會打 UPDATE ═══
  設回同一個【字串內容】：髒嗎=false
  換一個 String 物件    ：髒嗎=false
  → 整個交易 1 句 SQL
     select c1_0.id,c1_0.display_name,c1_0.email from customer c1_0 where c1_0.id=?
```

**0 句 `UPDATE`。而且用 `new String("小明")`（不同的物件、`==` 不成立）也一樣不髒。**

📌 **重點在「比對用什麼」**：Hibernate 對每個屬性型別都有一個 `JavaType`，
而髒檢查用的是那個型別的 **`areEqual`**，不是 `==`：

| 型別 | 用什麼比 |
|---|---|
| `String`、`Integer`、`enum` … | `equals()` |
| `BigDecimal` | **`compareTo() == 0`**（3.4.5） |
| 實體關聯（`@ManyToOne`） | **`==`**（物件參考） |
| 集合（`@OneToMany`） | 逐一比對元素的**參考**（3.4.2 的 ②） |

⚠️ **「關聯用 `==` 比」有一個實際後果**：

```java
// ❌ 這一行會產生一句 UPDATE，即使客戶完全沒變
order.setCustomer(customers.findById(order.getCustomer().getId()).get());
// 為什麼？在同一個 PC 裡，findById 會回傳同一個物件 → 其實不會髒
// 但如果中間有 em.clear()，就會拿到【新物件】 → customer 屬性被判定為髒 → UPDATE
```

### 3.4.5 實測：`BigDecimal` 的 scale 算不算髒

這是一個流傳很廣的說法：「`BigDecimal` 的 `equals` 會比 scale，所以 `100.00` 跟 `100.0000`
在 Hibernate 眼裡是不同的值，會造成無意義的 `UPDATE`。」

**實測一次**：

```java
    @Test
    void BigDecimal的scale算不算髒() {
        seed();
        head("🔴 同一個金額，不同的 scale");
        tx.executeWithoutResult(s -> {
            Prod3 p = products.findById(pid).orElseThrow();
            System.out.println("  載入的單價           : " + p.getUnitPrice()
                    + " (scale=" + p.getUnitPrice().scale() + ")");
            p.setUnitPrice(new BigDecimal("100.00"));
            System.out.println("  設成 100.00 (scale=2)");
            System.out.println("    equals?          : "
                    + new BigDecimal("100.0000").equals(new BigDecimal("100.00")));
            System.out.println("    compareTo == 0?  : "
                    + (new BigDecimal("100.0000").compareTo(new BigDecimal("100.00")) == 0));
            System.out.println("    Hibernate 認為髒嗎 : " + Pc.isDirty(em, p)
                    + "   （髒屬性：" + Pc.dirtyProps(em, p) + "）");
            var sqls = spy(() -> em.flush());
            System.out.println("  flush → " + sqls.size() + " 句 SQL");
        });
    }
```

```
═══ 🔴 同一個金額，不同的 scale ═══
  載入的單價           : 100.0000 (scale=4)
  設成 100.00 (scale=2)
    equals?          : false
    compareTo == 0?  : true
    Hibernate 認為髒嗎 : false   （髒屬性：（沒有髒屬性））
  flush → 0 句 SQL
```

**那個說法是錯的。**

`BigDecimal.equals` 確實會比 scale（`false`），
但 Hibernate 6 的 `BigDecimalJavaType.areEqual` 用的是 **`compareTo() == 0`**，
所以 scale 不同、數值相同 → **不髒、0 句 SQL**。

> ⚠️ **這件事本身沒什麼了不起，值得學的是「怎麼確認」。**
>
> 「`BigDecimal` 的 `equals` 會比 scale」是**真的**。
> 「所以 Hibernate 會判定它髒」是一個**看起來很合理的推論**。
> 而中間少了一步：**Hibernate 有沒有用 `equals`？**
>
> 📌 這種「從一條正確的事實出發，推出一個不存在的問題」的錯誤，
> 在 ORM 這種「中間隔了一層你看不見的東西」的題目上特別常見。
> **這一章給你的 `Pc.isDirty` 就是為了讓你能三行程式碼確認一次，而不是相信推論。**

**而 01 章 1.10.1 那個 `BigDecimal` 的坑是真的**，只是它不在髒檢查這一層：
`precision`/`scale` 跟 DB 不一致時，**寫進去的值會被靜默四捨五入**。
兩件事不要混在一起。

### 3.4.6 實測：改一個欄位，`UPDATE` 幾個欄位

```java
    @Test
    void 改一個欄位UPDATE幾個欄位() {
        seed();
        head("改一個欄位（status），UPDATE 幾個欄位");
        var a = spy(() -> tx.executeWithoutResult(s ->
                orders.findById(oid).orElseThrow().setStatus(St3.PAID)));
        a.stream().filter(q -> q.startsWith("update")).forEach(q ->
                System.out.println("  沒有 @DynamicUpdate : " + q));

        head("同一張表，換成有 @DynamicUpdate 的實體");
        var b = spy(() -> tx.executeWithoutResult(s ->
                em.find(OrdDyn.class, oid).setStatus(St3.PACKED)));
        b.stream().filter(q -> q.startsWith("update")).forEach(q ->
                System.out.println("  有 @DynamicUpdate   : " + q));
    }
```

`OrdDyn` 是**同一張 `orders` 表的另一個映射**（02 章那個「一表多映射」的手法）：

```java
package com.example.lab.ch03;

import jakarta.persistence.*;
import org.hibernate.annotations.DynamicUpdate;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

/** 跟 Ord3 同一張表，唯一的差別是 @DynamicUpdate。 */
@Entity @Table(name = "orders") @DynamicUpdate
public class OrdDyn extends Base3 {

    @Column(name = "order_no", nullable = false, length = 32) private String orderNo;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "customer_id", nullable = false)
    private Cust3 customer;

    @Enumerated(EnumType.STRING) @JdbcTypeCode(SqlTypes.VARCHAR)
    @Column(nullable = false, length = 16) private St3 status;

    @Column(name = "total_amount", nullable = false, precision = 19, scale = 4)
    private BigDecimal totalAmount = BigDecimal.ZERO;
    @Column(name = "discount_amount", nullable = false, precision = 19, scale = 4)
    private BigDecimal discountAmount = BigDecimal.ZERO;
    @Column(nullable = false, length = 3) @JdbcTypeCode(SqlTypes.CHAR)
    private String currency = "TWD";
    @Column(name = "placed_at", nullable = false) private Instant placedAt;
    @Column(name = "paid_at") private Instant paidAt;

    protected OrdDyn() {}
    public OrdDyn(UUID id, String orderNo, Cust3 customer) {
        super(id); this.orderNo = orderNo; this.customer = customer;
        this.status = St3.PENDING; this.placedAt = Instant.parse("2026-09-01T00:00:00Z");
    }
    public void setStatus(St3 s) { this.status = s; }
    public St3 getStatus() { return status; }
    public String getOrderNo() { return orderNo; }
}
```

```java
package com.example.lab.ch03;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.UUID;

public interface OrdDynRepo extends JpaRepository<OrdDyn, UUID> {}
```

```
═══ 改一個欄位（status），UPDATE 幾個欄位 ═══
  沒有 @DynamicUpdate : update orders set currency=?,customer_id=?,discount_amount=?,
                        order_no=?,paid_at=?,placed_at=?,status=?,total_amount=? where id=?

═══ 同一張表，換成有 @DynamicUpdate 的實體 ═══
  有 @DynamicUpdate   : update orders set status=? where id=?
```

**預設會更新全部 8 個欄位，只為了改 1 個。**

**為什麼 Hibernate 預設這樣做**：那句 `UPDATE` 的 SQL 字串是**在啟動時就準備好的**，
每次都是同一句 → JDBC PreparedStatement 可以快取、可以批次（06 章）。
如果每次都按「這次髒了哪幾個欄位」現組 SQL，就會產生 2⁸ 種不同的 SQL 字串。

**`@DynamicUpdate` 的三個代價**：

| 代價 | 說明 |
|---|---|
| ① SQL 每次現組 | 不能重用 PreparedStatement，**批次寫入會失效**（06 章會量） |
| ② 快取命中率下降 | 資料庫端的 statement cache 也一樣 |
| ③ 觸發器行為可能改變 | 依賴 `OLD.col != NEW.col` 的觸發器會看到不同的東西 |

**什麼時候值得開**：

```
✅ 表很寬（30+ 欄位）、而每次只改 1～2 個
✅ 有 TEXT / BLOB / JSON 大欄位，重寫它們的成本很高
✅ 有並行的欄位級更新，全欄位 UPDATE 會互相覆蓋
      （不過這種情況真正的解法是 @Version 樂觀鎖，06 章）
❌ 一般的表：不要開。預設值是對的
```

⚠️ **一個常見的誤診**：「我看到 `UPDATE` 更新了所有欄位，
是不是我不小心用了 `merge` / 把整個 DTO 蓋上去了？」

**不是。這就是預設行為。** 判斷「有沒有多改到欄位」不能看 SQL 的欄位列表，
要看**參數的值**——或者更簡單，用 `Pc.dirtyProps()` 看髒屬性清單。

### 3.4.7 實測：唯讀交易不做髒檢查

```java
    @Test
    void 唯讀交易不做髒檢查() {
        seed();
        head("@Transactional(readOnly = true) 裡改一個實體");
        var sqls = spy(() -> svc.readOnlyRename(cid, "小華"));
        System.out.println("  → " + sqls.size() + " 句 SQL");
        sqls.forEach(q -> System.out.println("     " + q));
        System.out.println("  資料庫現在 : " + nameInDb(cid) + "   ← 改的東西沒有寫回去");

        head("查詢層級的 readOnly hint：連快照都不建");
        tx.executeWithoutResult(s -> {
            Cust3 c = em.createQuery("select c from Cust3 c where c.id = :id", Cust3.class)
                    .setParameter("id", cid)
                    .setHint("org.hibernate.readOnly", true)
                    .getSingleResult();
            System.out.println("  狀態     : " + Pc.state(em, c));
            System.out.println("  有快照嗎  : " + (Pc.snapshot(em, c) != null));
            c.rename("小美");
            var sqls2 = spy(() -> em.flush());
            System.out.println("  改了再 flush → " + sqls2.size() + " 句 SQL");
        });
    }

    @org.springframework.beans.factory.annotation.Autowired TxSvc svc;
```

⚠️ **這裡有一個一定會踩到的坑，先講**：

> 🔴 **`@Transactional` 寫在測試類別自己的方法上，然後從另一個測試方法直接呼叫它——**
> **那是【自我呼叫】，Spring 的代理完全不會生效。**
>
> 症狀非常誤導：`flush mode` 印出來是 `AUTO`（不是 `MANUAL`）、
> 修改也「沒有寫回去」——看起來好像唯讀生效了，
> **實際上是「根本沒有交易」**，實體撈出來就 detached 了（3.2.4）。
>
> **要測 `@Transactional`，交易方法必須在另一個 bean 上。**

```java
package com.example.lab.ch03;

import jakarta.persistence.EntityManager;
import org.hibernate.Session;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.util.UUID;
import java.util.function.Consumer;

/**
 * 03 章需要「真的經過 Spring 代理」的 @Transactional 方法。
 * ⚠️ 從測試類別自己呼叫自己的 @Transactional 方法是【自我呼叫】，代理不會生效。
 */
@Component
public class TxSvc {

    private final EntityManager em;
    private final Cust3Repo customers;
    public TxSvc(EntityManager em, Cust3Repo customers) { this.em = em; this.customers = customers; }

    @Transactional(readOnly = true)
    public void readOnly(Consumer<EntityManager> body) { body.accept(em); }

    @Transactional
    public void readWrite(Consumer<EntityManager> body) { body.accept(em); }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void requiresNew(Consumer<EntityManager> body) { body.accept(em); }

    /** 唯讀交易裡改一個實體。 */
    @Transactional(readOnly = true)
    public void readOnlyRename(UUID id, String name) {
        Cust3 c = customers.findById(id).orElseThrow();
        System.out.println("  Hibernate flush mode : "
                + em.unwrap(Session.class).getHibernateFlushMode());
        System.out.println("  session 預設唯讀嗎     : "
                + em.unwrap(Session.class).isDefaultReadOnly());
        System.out.println("  實體狀態              : " + Pc.state(em, c));
        System.out.println("  有快照嗎              : " + (Pc.snapshot(em, c) != null));
        c.rename(name);
        System.out.println("  改完，髒嗎            : " + Pc.isDirty(em, c));
    }

    /** 兩層 @Transactional（預設 REQUIRED）：是同一個 PC 嗎（3.8.2）。 */
    @Transactional
    public void outer(Runnable inner) {
        System.out.println("  外層 Session / PC : " + tag(em));
        inner.run();
        System.out.println("  回到外層          : " + tag(em));
    }

    @Transactional
    public void innerRequired() {
        System.out.println("  內層 REQUIRED     : " + tag(em));
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void innerRequiresNew(Object entityFromOuter) {
        System.out.println("  內層 REQUIRES_NEW : " + tag(em));
        System.out.println("  外層那個實體，在這裡是 : " + Pc.state(em, entityFromOuter));
        System.out.println("  em.contains(它)      : " + em.contains(entityFromOuter));
    }

    public static String tag(EntityManager em) {
        Object d = em.getDelegate();
        Object pc = em.unwrap(org.hibernate.engine.spi.SessionImplementor.class)
                .getPersistenceContext();
        return "Session@" + Integer.toHexString(System.identityHashCode(d))
             + " / PC@" + Integer.toHexString(System.identityHashCode(pc));
    }
}
```

```
═══ @Transactional(readOnly = true) 裡改一個實體 ═══
  Hibernate flush mode : MANUAL
  session 預設唯讀嗎     : true
  實體狀態              : MANAGED (read-only：不做髒檢查)
  有快照嗎              : false
  改完，髒嗎            : false
  → 1 句 SQL
     select c1_0.id,c1_0.display_name,c1_0.email from customer c1_0 where c1_0.id=?
  資料庫現在 : 小明   ← 改的東西沒有寫回去

═══ 查詢層級的 readOnly hint：連快照都不建 ═══
  狀態     : MANAGED (read-only：不做髒檢查)
  有快照嗎  : false
  改了再 flush → 0 句 SQL
```

**`@Transactional(readOnly = true)` 做了三件事**（前兩件是 Spring 做的，第三件是 Hibernate）：

```
① session.setDefaultReadOnly(true)     → 之後撈出來的實體都是 READ_ONLY 狀態
② session.setHibernateFlushMode(MANUAL) → 連 commit 都不 flush
③ READ_ONLY 的實體【不建快照】          → 省一半記憶體、省掉髒檢查
④ 順便：JDBC 連線也標成唯讀（有些資料庫會用它做最佳化）
```

> 📌 **所以 `readOnly = true` 不是一個「文件註記」，它是一個真的最佳化。**
>
> 而它的代價是 🔴 **在唯讀交易裡改實體，會靜默失效**——
> 不報錯、不寫入。這一點在「一個方法慢慢長大，某天多了一行寫入」時很致命。
>
> ⚠️ **本課的規則**：`readOnly = true` 只給**純查詢**的方法。
> 一旦一個方法可能寫入，就不要標它——**不要靠 `readOnly` 來「保護」資料。**

### 3.4.8 實測：髒檢查的成本

3.3.7 說「批次寫入要記得 `em.clear()`」。這一節給那句話一個數字。

```java
    @Test
    void 髒檢查的成本() {
        head("一級快取裡有 N 個實體時，一次髒檢查要掃多久");
        System.out.println("  （沒有任何實體是髒的 → 每次都必須把 N 個實體全部比對完）");
        bulkSeed(20000);
        for (int n : new int[]{100, 100, 1000, 5000, 20000}) {
            tx.executeWithoutResult(s -> {
                em.createQuery("select c from Cust3 c", Cust3.class)
                        .setMaxResults(n).getResultList();
                Session session = em.unwrap(Session.class);
                for (int i = 0; i < 20; i++) session.isDirty();       // 暖機
                long best = Long.MAX_VALUE;
                for (int i = 0; i < 50; i++) {
                    long t0 = System.nanoTime();
                    session.isDirty();
                    best = Math.min(best, System.nanoTime() - t0);
                }
                System.out.printf("  PC 裡 %6d 個實體 → 一次髒檢查最快 %,9d ns%n",
                        Pc.managedCount(em), best);
            });
        }
    }

    private void bulkSeed(int n) {
        clean();
        StringBuilder sb = new StringBuilder(
                "INSERT INTO customer (id, email, display_name) VALUES ");
        for (int i = 0; i < n; i++) {
            if (i > 0) sb.append(',');
            sb.append("(UNHEX(REPLACE(UUID(),'-','')), 'c").append(i).append("@x.com','客戶")
              .append(i).append("')");
        }
        jdbc.update(sb.toString());
    }
```

```
═══ 一級快取裡有 N 個實體時，一次髒檢查要掃多久 ═══
  （沒有任何實體是髒的 → 每次都必須把 N 個實體全部比對完）
  PC 裡    100 個實體 → 一次髒檢查最快    73,417 ns
  PC 裡    100 個實體 → 一次髒檢查最快    43,375 ns
  PC 裡   1000 個實體 → 一次髒檢查最快   178,958 ns
  PC 裡   5000 個實體 → 一次髒檢查最快   392,083 ns
  PC 裡  20000 個實體 → 一次髒檢查最快 1,521,541 ns
```

| PC 裡的實體數 | 一次髒檢查 | 每個實體 |
|---|---|---|
| 100 | 43 µs | 0.43 µs |
| 1,000 | 179 µs | 0.18 µs |
| 5,000 | 392 µs | 0.08 µs |
| 20,000 | **1.52 ms** | 0.08 µs |

⚠️ **兩個要注意的量測細節**（這一段的量測方法比數字本身更值得學）：

```
① 前兩列都是 100 個實體，數字差了 1.7 倍 → 那是 JIT 暖機
      → 所以要先跑 20 次不計時的，再取 50 次裡的【最快】
      （這跟 06 站 06 章的微基準規則一致）
② 【不能改任何實體】
      → session.isDirty() 找到第一個髒的就會【提早回傳】
      → 一開始版本先改了一個實體，結果 5000 與 20000 的數字一樣，
        因為它掃到第 1 個就跳出來了。修掉之後才變成線性
```

📌 **這個線性成長是重點**：髒檢查是 **O(PC 裡的實體數 × 每個實體的屬性數)**。

**它在什麼場景會咬你**：

```
🔴 場景一：批次匯入 10 萬筆，沒有 clear
     PC 長到 10 萬個實體，而 flush 是【每 batch 一次】
     → 10 萬 × 每次掃全部 = 二次成長
     → 06 章會量：這種寫法從幾秒變成幾十分鐘

🔴 場景二：一支 API 撈了 5000 列做報表，然後在同一個交易裡寫了一筆 log
     → 那一筆 log 的 flush，要順便掃過 5000 個實體
     → 解法：報表用【唯讀交易】（3.4.7：READ_ONLY 不建快照、不掃）
             或用 DTO 投影（05 章），根本不要把它們變成實體
```

**三個解法，依偏好排序**：

| 解法 | 適用 | 效果 |
|---|---|---|
| ① 查詢直接回 **DTO 投影**（05 章） | 唯讀報表 | 實體根本不進 PC，成本 = 0 |
| ② `@Transactional(readOnly = true)` | 唯讀用例 | 不建快照、不做髒檢查 |
| ③ `flush()` + `clear()` 分段 | 批次寫入 | PC 大小有上界（06 章） |

**還有一個第四條路：bytecode enhancement（自我追蹤髒檢查）。**

```xml
<!-- pom.xml：讓 Hibernate 在編譯期改寫你的實體 -->
<plugin>
  <groupId>org.hibernate.orm.tooling</groupId>
  <artifactId>hibernate-enhance-maven-plugin</artifactId>
  <configuration>
    <enableDirtyTracking>true</enableDirtyTracking>
  </configuration>
</plugin>
```

它會在每個 setter 裡插一行「把我標記成髒」，於是 flush 時**不需要掃、也不需要快照**。

⚠️ **本課不用它**，三個理由：

```
① 它改寫你的 .class，出問題時 debug 的東西跟你寫的不一樣
② 它跟「欄位存取 vs 屬性存取」（01 章 1.3.2）互動很微妙
③ 上面那三個解法已經解決了 99% 的問題，而且它們是【設計】層次的改善
```

### 3.4.9 髒檢查的六條規則

```
① 髒檢查比對的是「現在的物件」vs「載入當時的快照」
② setter 什麼都不做。比對只發生在 flush 的時候（3.7）
③ 比對用的是型別的 areEqual：String 用 equals、BigDecimal 用 compareTo、
   關聯用 ==、集合逐一比對元素的參考
④ 設回同一個值 → 0 句 UPDATE
⑤ 預設 UPDATE 全部欄位（@DynamicUpdate 可改，但有代價）
⑥ 成本 = O(PC 裡的實體數)。唯讀交易 / DTO 投影 / flush+clear 三種解法
```

---

## 3.5 實體的四種狀態 ★★

### 3.5.1 四種狀態

```
                       ┌──────────────────────────────────────┐
                       │                                      │
      new Xxx()        │        em.persist(x)                 │
   ────────────────►  transient  ──────────────►  managed  ────┤
                          ▲                        │  ▲       │
                          │                        │  │       │ commit / flush
       em.merge(x) 回傳 ──┼── 新的 managed 物件     │  │       │ 產生 SQL
                          │                        │  │       │
                          │           em.remove(x) │  │ em.find / JPQL
                          │                        ▼  │       │
                          │                     removed│      │
                          │                        │  │       │
                          │            flush → DELETE │      │
                          │                        ▼  │       │
                          └───────────────────────────┴───────┘
                                                       │
                     em.detach / em.clear / 交易結束    │
                                                       ▼
                                                   detached
```

| 狀態 | 定義 | `em.contains` | 改了會寫回去嗎 |
|---|---|---|---|
| **transient**（暫時） | `new` 出來、從沒交給 JPA | `false` | ❌ |
| **managed**（受管） | 在持久化情境裡 | `true` | ✅ |
| **removed**（已移除） | 排程要刪除了 | `true` | —（會被刪掉） |
| **detached**（分離） | 曾經 managed，現在不在 PC 裡 | `false` | ❌ |

⚠️ **JPA 規格用的是 `transient` / `persistent` / `removed` / `detached`；
Hibernate 的內部狀態枚舉是 `MANAGED` / `READ_ONLY` / `DELETED` / `GONE`。**
兩套詞說的是同一件事，本課用 JPA 那一套，只有印 `Pc.state()` 時會看到 Hibernate 的。

### 3.5.2 實測：一個實體走完一輪

```java
package com.example.lab.ch03;

import com.example.lab.Uuid7;
import org.junit.jupiter.api.Test;

import java.util.UUID;

class A4States extends Base03 {

    @Test
    void 一個實體走完一輪() {
        seed();
        head("同一個物件，一路印它的狀態");
        UUID nid = Uuid7.next();
        final Cust3[] hold = new Cust3[1];
        tx.executeWithoutResult(s -> {
            Cust3 c = new Cust3(nid, "new@x.com", "新客戶");
            hold[0] = c;
            System.out.println("  ① new 出來              : " + Pc.state(em, c));
            em.persist(c);
            System.out.println("  ② em.persist 之後        : " + Pc.state(em, c)
                    + "、PC 管 " + Pc.managedCount(em) + " 個");
            System.out.println("     資料庫有這一列嗎        : " + existsInDb(nid));
            em.flush();
            System.out.println("  ③ em.flush 之後          : " + Pc.state(em, c)
                    + "、資料庫有了嗎 " + existsInDb(nid));
            em.remove(c);
            System.out.println("  ④ em.remove 之後         : " + Pc.state(em, c));
            em.flush();
            System.out.println("  ⑤ 再 flush（DELETE 送出） : " + Pc.state(em, c)
                    + "、PC 管 " + Pc.managedCount(em) + " 個");
        });
        System.out.println("  ⑥ 交易結束後（同一個物件） : " + txState(hold[0]));
    }

    private boolean existsInDb(UUID id) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM customer WHERE id = ?",
                Long.class, Uuid7.toBytes(id)) > 0;
    }
    private String txState(Object o) {
        final String[] r = new String[1];
        tx.executeWithoutResult(s -> r[0] = Pc.state(em, o));
        return r[0];
    }
}
```

```
═══ 同一個物件，一路印它的狀態 ═══
  ① new 出來              : TRANSIENT / DETACHED（不在 PC 裡，PC 本身分不出來）
  ② em.persist 之後        : MANAGED、PC 管 1 個
     資料庫有這一列嗎        : false
  ③ em.flush 之後          : MANAGED、資料庫有了嗎 true
  ④ em.remove 之後         : REMOVED（已排程刪除，還沒 flush）
  ⑤ 再 flush（DELETE 送出） : TRANSIENT / DETACHED（不在 PC 裡，PC 本身分不出來）、PC 管 0 個
  ⑥ 交易結束後（同一個物件） : TRANSIENT / DETACHED（不在 PC 裡，PC 本身分不出來）
```

**三個值得停下來看的地方**：

**② `persist` 之後，資料庫還沒有那一列。**
`persist` 只做一件事：**把物件放進 PC，並排程一個 INSERT**。真正的 `INSERT` 要等 flush。

⚠️ 這意味著**在同一個交易裡，`persist` 之後用原生 SQL / MyBatis 查那一列，會查不到**——
這正是 00 章 0.9 規則二存在的原因（3.7.3 會完整量一次）。

**⑤ `DELETE` 送出去之後，實體從 PC 裡消失了。**
Hibernate 有一個 `GONE` 狀態，但在這個版本上，`flush` 完成後 entry 就被移除了，
所以 `Pc.state` 看到的是「不在 PC 裡」。

**⑥ 交易結束後，狀態跟 ① 一模一樣。** 這就是下一節的問題。

### 3.5.3 實測：`transient` 與 `detached` 分不出來

```java
    @Test
    void transient跟detached分不出來() {
        seed();
        head("PC 分不出 transient 與 detached —— 而它們的下場完全不同");
        tx.executeWithoutResult(s -> {
            Cust3 brandNew = new Cust3(Uuid7.next(), "n@x.com", "從沒存過");
            Cust3 detached = new Cust3(cid, "ming@x.com", "存過、只是離開了 PC");
            System.out.println("  全新的       : " + Pc.state(em, brandNew));
            System.out.println("  detached 的  : " + Pc.state(em, detached));
            System.out.println("  em.contains  : " + em.contains(brandNew)
                    + " / " + em.contains(detached));
            System.out.println("  id 是不是 null : " + (brandNew.getId() == null)
                    + " / " + (detached.getId() == null));
        });

        head("而 persist 它們的結果完全不同");
        try {
            tx.executeWithoutResult(s -> {
                em.persist(new Cust3(cid, "dup@x.com", "撞了"));
                em.flush();
                System.out.println("  persist 一個 detached → 沒事？");
            });
        } catch (Exception e) {
            System.out.println("  persist 一個 detached → 🔴 "
                    + rootName(e) + ": " + firstLine(rootMsg(e)));
        }
    }
```

```
═══ PC 分不出 transient 與 detached —— 而它們的下場完全不同 ═══
  全新的       : TRANSIENT / DETACHED（不在 PC 裡，PC 本身分不出來）
  detached 的  : TRANSIENT / DETACHED（不在 PC 裡，PC 本身分不出來）
  em.contains  : false / false
  id 是不是 null : false / false   ← 🔴 應用端指定主鍵時，這個判準完全失效

═══ 而 persist 它們的結果完全不同 ═══
  persist 一個 detached → 🔴 SQLIntegrityConstraintViolationException:
                            Duplicate entry '…' for key 'customer.PRIMARY'
```

🔴🔴 **這是 01 章 1.6.6 那個 `Persistable` 之所以存在的根本原因。**

**JPA 判斷「這是新的還是既有的」只有兩個工具**：

```
工具一：id 是 null 嗎？
    → 只在【資料庫產生主鍵】（IDENTITY / SEQUENCE）時有用
    → 本課用【應用端指定 UUIDv7】（07 站 1.8.4）→ 永遠不是 null → 🔴 完全失效

工具二：@Version 欄位是 null 嗎？
    → 只在有 @Version 而且它是包裝型別（Long 不是 long）時有用
```

**兩個工具都失效時，Spring Data 的 `save()` 只剩一條路**：

```
去資料庫【問一句】：這個 id 存在嗎？
   存在   → merge
   不存在 → persist
```

**那就是 00 章 0.3.3 那句多餘的 `SELECT`**，3.6.3 會把它量出來。

⚠️ **注意 `em.persist` 對 detached 物件的行為**：它**沒有**拋 `EntityExistsException`，
而是一路走到 `INSERT`，然後撞主鍵。

**為什麼**：`persist` 的規格是「把這個 transient 物件變成 managed」。
Hibernate 用「id 是不是 null」判斷它是不是 transient——
而我們的 id 從來不是 null，所以它**相信你**，直接排程 `INSERT`。

📌 **實務上的分辨方法**（依可靠度排序）：

| 方法 | 可靠嗎 |
|---|---|
| `Persistable.isNew()` + `@PostLoad`/`@PostPersist` 翻旗標（01 章 1.6.6） | ✅ 最可靠 |
| 有一個 `@Version Long`（包裝型別）欄位 | ✅ 可靠 |
| 資料庫產生主鍵 + 判斷 `id == null` | ✅ 可靠，但本課不用這種主鍵 |
| 「這個物件是我剛剛 new 的嗎」——靠程式流程自己知道 | ⚠️ 靠紀律 |
| 從物件本身看 | 🔴 **不可能** |

### 3.5.4 實測：`removed` 之後還能做什麼

```java
    @Test
    void removed之後還能做什麼() {
        seed();
        head("em.remove 之後，這個物件還能改嗎");
        var sqls = spy(() -> tx.executeWithoutResult(s -> {
            Cust3 c = customers.findById(cid2).orElseThrow();     // cid2 沒有訂單
            em.remove(c);
            System.out.println("  remove 後狀態 : " + Pc.state(em, c));
            c.rename("刪掉之前再改一次");
            System.out.println("  改完還是      : " + Pc.state(em, c));
        }));
        System.out.println("  → " + sqls.size() + " 句 SQL");
        sqls.forEach(q -> System.out.println("     " + q));
        System.out.println("  這一列還在嗎 : " + existsInDb(cid2));

        seed();
        head("remove 之後再 persist 同一個物件");
        tx.executeWithoutResult(s -> {
            Cust3 c = customers.findById(cid2).orElseThrow();
            em.remove(c);
            System.out.println("  remove 後 : " + Pc.state(em, c));
            em.persist(c);
            System.out.println("  再 persist : " + Pc.state(em, c) + "   ← 復活了");
        });
        System.out.println("  這一列還在嗎 : " + existsInDb(cid2));
    }
```

```
═══ em.remove 之後，這個物件還能改嗎 ═══
  remove 後狀態 : REMOVED（已排程刪除，還沒 flush）
  改完還是      : REMOVED（已排程刪除，還沒 flush）
  → 2 句 SQL
     select c1_0.id,c1_0.display_name,c1_0.email from customer c1_0 where c1_0.id=?
     delete from customer where id=?
  這一列還在嗎 : false

═══ remove 之後再 persist 同一個物件 ═══
  remove 後 : REMOVED（已排程刪除，還沒 flush）
  再 persist : MANAGED   ← 復活了
  這一列還在嗎 : true
```

**兩個結論**：

**① `removed` 之後改欄位，改動被丟掉、沒有 `UPDATE`。**
只有 `DELETE`。這很合理（既然要刪，更新它沒有意義），但如果你**期待**那個 `UPDATE`
（例如「刪除前先寫一個 `deleted_by`」），它會靜默不發生。

🔴 **軟刪除不要靠 `em.remove`**。01 章 1.8.3 那個做法（改 `deleted_at` 欄位）是對的。

**② `remove` 之後 `persist` 可以「復活」。** JPA 規格明文允許。
但這個技巧幾乎沒有正當用途，看到它通常代表流程亂了。

⚠️ **另一個實測時撞到的事**：第一次跑這個測試時，`DELETE` 失敗了：

```
Cannot delete or update a parent row: a foreign key constraint fails
(`ch03`.`orders`, CONSTRAINT `fk_orders_customer` FOREIGN KEY (`customer_id`) …)
```

因為那個客戶有訂單。所以 `seed()` 才會多建一個**沒有訂單的** `cid2`。

📌 這件事本身是一個提醒：**`em.remove` 不會幫你處理外鍵。**
`cascade = REMOVE` 只在**有映射關聯**的那條路上傳遞（02 章 2.5.3）——
`Cust3` 上沒有 `orders` 集合，所以 Hibernate 完全不知道那些訂單存在。

### 3.5.5 實測：`detached` 的三個症狀

```java
    @Test
    void detached的三個症狀() {
        seed();
        head("症狀一：改了不會寫回去");
        final Cust3[] hold = new Cust3[1];
        tx.executeWithoutResult(s -> hold[0] = customers.findById(cid).orElseThrow());
        hold[0].rename("在交易外改的");
        System.out.println("  改完，資料庫 : " + nameInDb(cid));

        head("症狀二：延遲載入炸掉");
        final Ord3[] o = new Ord3[1];
        tx.executeWithoutResult(s -> o[0] = orders.findById(oid).orElseThrow());
        try {
            System.out.println("  o.getItems().size() = " + o[0].getItems().size());
        } catch (Exception e) {
            System.out.println("  🔴 " + e.getClass().getSimpleName()
                    + ": " + firstLine(e.getMessage()));
        }

        head("症狀三：em.contains 是 false，而它「看起來」很正常");
        tx.executeWithoutResult(s -> {
            System.out.println("  contains  : " + em.contains(o[0]));
            System.out.println("  狀態      : " + Pc.state(em, o[0]));
            System.out.println("  訂單編號   : " + o[0].getOrderNo() + "（讀得到）");
            o[0].setStatus(St3.CANCELLED);
            System.out.println("  改了 status 之後，髒嗎 : " + Pc.isDirty(em, o[0]));
        });
        System.out.println("  資料庫的 status : " + statusInDb(oid) + "   ← 🔴 沒改到");
    }
```

```
═══ 症狀一：改了不會寫回去 ═══
  改完，資料庫 : 小明

═══ 症狀二：延遲載入炸掉 ═══
  🔴 LazyInitializationException: failed to lazily initialize a collection of role:
     com.example.lab.ch03.Ord3.items: could not initialize proxy …

═══ 症狀三：em.contains 是 false，而它「看起來」很正常 ═══
  contains  : false
  狀態      : TRANSIENT / DETACHED（不在 PC 裡，PC 本身分不出來）
  訂單編號   : SO-1（讀得到）
  改了 status 之後，髒嗎 : false
  資料庫的 status : PENDING   ← 🔴 沒改到
```

📌 **症狀二就是 02 章 2.10.1 那個「no Session」。它的正式名稱是：你手上這個實體是 detached。**

⚠️ **三個症狀裡，最危險的是症狀三**，因為：

```
症狀二會【炸】     → 你會發現
症狀一、三【靜默】 → 你不會發現
```

而症狀三的陰險之處在於：**那個 detached 物件被帶進了一個新的交易裡**。
`em` 是活的、交易是活的、物件的欄位讀得到——**唯一的問題是這個物件不在這個 PC 裡**。

🔴 **這是「把實體從一層傳到另一層」的專案裡最常見的資料遺失形狀**：

```java
// ❌ Controller 拿到一個 detached 的 Order（從 cache / session / 上一個交易）
@PostMapping("/orders/{id}/cancel")
public void cancel(@PathVariable UUID id, Order fromSomewhere) {
    fromSomewhere.cancel();       // 改的是一個沒人管的物件
    orderService.touch(id);       // 有交易，但跟上面那個物件無關
}   // 200 OK，什麼都沒改
```

**本課的解法是結構性的，不是紀律性的**（3.11 會完整寫）：

```
✅ 實體【不出資料層】。跨層傳的是 DTO（02 章 2.10.5）
✅ 要改資料 → 在交易裡【重新撈一次】，改那個 managed 的
✅ 不要用 merge 把 detached 物件「接回來」（3.6.5 會證明為什麼）
```

### 3.5.6 每個 API 對應的狀態轉換

| API | transient | managed | removed | detached |
|---|---|---|---|---|
| `em.persist(x)` | → **managed** | 忽略 | → **managed**（復活） | 🔴 一路走到 INSERT → 撞主鍵 |
| `em.merge(x)` | **回傳**新的 managed | 回傳 x 自己 | `IllegalArgumentException` | **回傳**新的 managed |
| `em.remove(x)` | 忽略（或拋例外） | → **removed** | 忽略 | 🔴 `IllegalArgumentException` |
| `em.detach(x)` | 忽略 | → **detached** | 取消刪除 | 忽略 |
| `em.refresh(x)` | 🔴 例外 | 重讀，丟掉修改 | — | 🔴 例外 |
| `em.contains(x)` | `false` | `true` | `true` | `false` |
| `em.clear()` | — | 全部 → **detached** | 取消刪除 | — |
| 交易 commit | — | → **detached** | → 刪掉 + detached | — |

⚠️ **表格裡有兩格值得單獨記**：

```
🔴 em.remove(detached 物件)  → IllegalArgumentException: Removing a detached instance
      → 要刪一個 detached 的東西，先 find 再 remove，或用 deleteById

🔴 em.merge(x) 的每一格都寫「回傳新的 managed」
      → merge 的回傳值不能丟掉。3.6.2 會證明丟掉它的後果
```

---

## 3.6 `persist` / `merge` / `save` ★★

00 章 0.3.3 留了一個問題：**`save()` 一筆全新的資料，為什麼打了兩句 SQL？**
01 章 1.6.6 給了解法（`Persistable`），但沒有解釋 `save()` 到底在做什麼。
這一節把三個 API 攤開來比。

### 3.6.1 `persist` 的語意

```java
package com.example.lab.ch03;

import com.example.lab.Uuid7;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.util.UUID;

class A5Merge extends Base03 {

    @Autowired CustPRepo customersP;

    @Test
    void persist的語意() {
        seed();
        head("em.persist：什麼時候有 id、什麼時候有那一列");
        UUID nid = Uuid7.next();
        tx.executeWithoutResult(s -> {
            Cust3 c = new Cust3(nid, "p@x.com", "persist");
            var sqls = spy(() -> em.persist(c));
            System.out.println("  persist 打了 " + sqls.size() + " 句 SQL（主鍵是應用端指定的）");
            System.out.println("  回傳值     : persist 是 void");
            System.out.println("  狀態       : " + Pc.state(em, c));
            var f = spy(() -> em.flush());
            System.out.println("  flush 打了 " + f.size() + " 句：" + (f.isEmpty() ? "" : f.get(0)));
        });
    }
}
```

```
═══ em.persist：什麼時候有 id、什麼時候有那一列 ═══
  persist 打了 0 句 SQL（主鍵是應用端指定的）
  回傳值     : persist 是 void
  狀態       : MANAGED
  flush 打了 1 句：insert into customer (display_name,email,nickname,id) values (?,?,?,?)
```

**`persist` 的四條語意**：

```
① 它是 void。傳進去的【那個物件】變成 managed —— 不會給你另一個物件
② 它不打任何 SQL（除非主鍵策略是 IDENTITY，那時候必須立刻 INSERT 才拿得到 id）
③ 它只認 transient。對 detached 物件呼叫它 = 一路走到 INSERT（3.5.3）
④ cascade = PERSIST 會沿著關聯傳遞（02 章 2.5.2）
```

⚠️ **② 那個「除非 IDENTITY」是 01 章 1.6.4 那個實測的根源**：
`IDENTITY` 主鍵讓 `persist` 必須立刻送 `INSERT`，所以**批次寫入完全失效**。
本課用應用端指定的 UUIDv7，所以 `persist` 是純記憶體操作。

### 3.6.2 實測：`merge` 傳進去的不是回傳的

```java
    @Test
    void merge傳進去的不是回傳的() {
        seed();
        head("🔴 merge 最容易踩的一件事");
        tx.executeWithoutResult(s -> {
            Cust3 detached = new Cust3(cid, "ming@x.com", "改過的名字");
            System.out.println("  傳進去的物件 : " + id(detached));
            Cust3 merged = em.merge(detached);
            System.out.println("  merge 回傳的 : " + id(merged));
            System.out.println("  同一個嗎      : " + (detached == merged));
            System.out.println("  傳進去的狀態  : " + Pc.state(em, detached));
            System.out.println("  回傳的狀態    : " + Pc.state(em, merged));
            System.out.println("  em.contains(傳進去的) : " + em.contains(detached));
            System.out.println("  em.contains(回傳的)   : " + em.contains(merged));

            detached.rename("再改一次");        // 對「傳進去的那個」再改一次
            System.out.println("\n  對【傳進去的那個】再改一次 → \"再改一次\"");
        });
        System.out.println("  資料庫最後是 : " + nameInDb(cid));
    }

    private static String id(Object o) {
        return o.getClass().getSimpleName() + "@" + Integer.toHexString(System.identityHashCode(o));
    }
```

```
═══ 🔴 merge 最容易踩的一件事 ═══
  傳進去的物件 : Cust3@4a0934a8
  merge 回傳的 : Cust3@754acbad
  同一個嗎      : false
  傳進去的狀態  : TRANSIENT / DETACHED（不在 PC 裡，PC 本身分不出來）
  回傳的狀態    : MANAGED
  em.contains(傳進去的) : false
  em.contains(回傳的)   : true

  對【傳進去的那個】再改一次 → "再改一次"
  資料庫最後是 : 改過的名字   ← 🔴 第二次的修改整個消失
```

🔴🔴 **`merge` 不會把你的物件變成 managed。它是「把你的物件的值，複製到 PC 裡那一個」。**

```
你的物件 (detached)                PC 裡的物件 (managed)
   @4a0934a8                          @754acbad
   displayName = "改過的名字"  ──複製──►  displayName = "改過的名字"
   ▲                                    ▲
   │                                    │
   還是 detached                         這一個才會被髒檢查、才會產生 UPDATE
   對它再改，沒人在看
```

⚠️ **所以 `merge` 的正確用法只有一種**：

```java
Cust3 managed = em.merge(detached);   // ✅ 一定要接住回傳值
managed.rename("接下來都改這個");       // ✅ 之後只碰 managed
// ❌ 不要再碰 detached
```

**而 `em.merge(x);` 這種「不接回傳值」的寫法，是一個明確的 bug 訊號**——
它幾乎總是代表寫的人以為 `merge` 會把 `x` 變成 managed。

📌 **這也是 `merge` 跟 `persist` 最大的介面差異，而它是刻意的**：
`persist` 回 `void`（因為它就是改你那個物件），`merge` 回 `T`（因為它給你另一個）。
**API 的簽章已經在講這件事了。**

### 3.6.3 實測：回答 00 章 0.3.3

```java
    @Test
    void save一筆全新資料要幾句SQL() {
        seed();
        head("回答 00 章 0.3.3：save() 一筆全新的資料");
        UUID a = Uuid7.next();
        var s1 = spy(() -> tx.executeWithoutResult(s ->
                customers.save(new Cust3(a, "a@x.com", "沒實作 Persistable"))));
        System.out.println("  Cust3（沒實作 Persistable）→ " + s1.size() + " 句");
        s1.forEach(q -> System.out.println("     " + q));

        UUID b = Uuid7.next();
        var s2 = spy(() -> tx.executeWithoutResult(s ->
                customersP.save(new CustP(b, "b@x.com", "有實作 Persistable"))));
        System.out.println("  CustP（有實作 Persistable）→ " + s2.size() + " 句");
        s2.forEach(q -> System.out.println("     " + q));

        head("而 em.persist 從來不需要那一句 SELECT");
        UUID c = Uuid7.next();
        var s3 = spy(() -> tx.executeWithoutResult(s ->
                em.persist(new Cust3(c, "c@x.com", "直接 persist"))));
        System.out.println("  em.persist → " + s3.size() + " 句");
        s3.forEach(q -> System.out.println("     " + q));
    }
```

`CustP` 是**同一張 `customer` 表**的另一個映射，差別只在實作了 `Persistable`：

```java
package com.example.lab.ch03;

import jakarta.persistence.*;
import org.springframework.data.domain.Persistable;
import java.util.UUID;

/** 跟 Cust3 同一張表，差別是實作 Persistable（01 章 1.6.6 的做法）。 */
@Entity @Table(name = "customer")
public class CustP implements Persistable<UUID> {

    @Id private UUID id;
    @Column(nullable = false, length = 255) private String email;
    @Column(name = "display_name", nullable = false, length = 64) private String displayName;

    @Transient private boolean isNew = true;

    protected CustP() {}
    public CustP(UUID id, String email, String displayName) {
        this.id = id; this.email = email; this.displayName = displayName;
    }

    @Override public UUID getId() { return id; }
    @Override public boolean isNew() { return isNew; }

    /** ★ 撈回來的 / 存過的，一律不是新的（01 章 1.6.6） */
    @PostPersist @PostLoad void markNotNew() { this.isNew = false; }

    public void rename(String n) { this.displayName = n; }
    public String getDisplayName() { return displayName; }
}
```

```java
package com.example.lab.ch03;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.UUID;

public interface CustPRepo extends JpaRepository<CustP, UUID> {}
```

```
═══ 回答 00 章 0.3.3：save() 一筆全新的資料 ═══
  Cust3（沒實作 Persistable）→ 2 句
     select c1_0.id,c1_0.display_name,c1_0.email,c1_0.nickname from customer c1_0 where c1_0.id=?
     insert into customer (display_name,email,nickname,id) values (?,?,?,?)
  CustP（有實作 Persistable）→ 1 句
     insert into customer (display_name,email,id) values (?,?,?)

═══ 而 em.persist 從來不需要那一句 SELECT ═══
  em.persist → 1 句
     insert into customer (display_name,email,nickname,id) values (?,?,?,?)
```

### 3.6.4 Spring Data `save()` 到底做了什麼

現在可以把 `save()` 的原始碼講清楚了。`SimpleJpaRepository`：

```java
@Transactional
@Override
public <S extends T> S save(S entity) {
    if (entityInformation.isNew(entity)) {
        em.persist(entity);
        return entity;
    } else {
        return em.merge(entity);
    }
}
```

**三行程式碼，三個陷阱**：

```
① isNew(entity) 怎麼判斷？
      有實作 Persistable → 問 entity.isNew()            → 0 句 SQL
      有 @Version（包裝型別）→ 看它是不是 null            → 0 句 SQL
      否則 → 看 id 是不是 null
             id 是 null    → 新的 → persist
             id 不是 null  → 🔴【不新】→ merge → merge 要先 SELECT ← 那句多的

② 回傳值
      persist 那條路：回傳【你傳進去的那個】
      merge   那條路：回傳【另一個物件】
      → 所以 save() 的回傳值【有時候是你傳進去的、有時候不是】🔴

③ 對一個【已經 managed】的實體呼叫 save()
      → 它走 merge 那條路（因為 id 不是 null）
      → merge 對 managed 物件會直接回傳它自己，不 SELECT
      → 所以【沒有害處，但完全多餘】（3.4.1）
```

⚠️ **② 是一個很多人不知道的行為**，它讓 `save()` 的回傳值變成一個必須注意的東西：

```java
// ⚠️ 這一行在「新增」時是對的，在「更新」時 c 不會變成 managed
Cust3 c = new Cust3(id, email, name);
customers.save(c);
c.rename("之後改的");     // 新增時有效（persist 路徑）、更新時無效（merge 路徑）🔴

// ✅ 一律接住回傳值
Cust3 managed = customers.save(c);
managed.rename("之後改的");
```

📌 **本課的立場（01 章 1.16.1 的 `BaseEntity` 就是為了這個）**：

```
① 全部實體實作 Persistable → save() 永遠走 persist 那條路 → 沒有那句 SELECT
② 更新資料【不用 save()】，用「撈出 managed 實體 + 呼叫方法」（3.4.1）
③ 於是 save() 在整個專案裡只出現在【新增】的路徑上，語意單一
```

### 3.6.5 實測：`merge` 會靜默清掉你沒設的欄位

**這是 `merge` 最貴的一個坑，而它在真實專案裡非常常見。**

場景：一個「改名 API」。前端只送 `{id, displayName}`。

```java
    @Test
    void merge會靜默清掉你沒設的欄位() {
        seed();
        System.out.println("  資料庫原本 : display_name=" + nameInDb(cid)
                + "、nickname=" + nickInDb(cid));

        head("🔴 一個「改名 API」：前端只送 id 與新名字");
        var sqls = spy(() -> tx.executeWithoutResult(s -> {
            // 這就是無數專案裡的那三行
            Cust3 fromDto = new Cust3(cid, "ming@x.com", "小明改名");
            customers.save(fromDto);
        }));
        sqls.forEach(q -> System.out.println("     " + q));
        System.out.println("  資料庫現在 : display_name=" + nameInDb(cid)
                + "、nickname=" + nickInDb(cid));

        seed();
        head("✅ 正解：載入 managed 實體，只改要改的欄位");
        var sqls2 = spy(() -> tx.executeWithoutResult(s -> {
            Cust3 c = customers.findById(cid).orElseThrow();
            c.rename("小明改名");
        }));
        sqls2.forEach(q -> System.out.println("     " + q));
        System.out.println("  資料庫現在 : display_name=" + nameInDb(cid)
                + "、nickname=" + nickInDb(cid));
    }
```

```
  資料庫原本 : display_name=小明、nickname=阿明

═══ 🔴 一個「改名 API」：前端只送 id 與新名字 ═══
     select c1_0.id,c1_0.display_name,c1_0.email,c1_0.nickname from customer c1_0 where c1_0.id=?
     update customer set display_name=?,email=?,nickname=? where id=?
  資料庫現在 : display_name=小明改名、nickname=null   ← 🔴 nickname 被清掉了

═══ ✅ 正解：載入 managed 實體，只改要改的欄位 ═══
     select c1_0.id,c1_0.display_name,c1_0.email,c1_0.nickname from customer c1_0 where c1_0.id=?
     update customer set display_name=?,email=?,nickname=? where id=?
  資料庫現在 : display_name=小明改名、nickname=阿明   ← ✅ nickname 還在
```

🔴🔴 **兩個版本打的 SQL 一字不差（同樣 2 句、同樣的 `UPDATE` 欄位列表），
而一個把 `nickname` 清成 `null`、一個沒有。**

**為什麼**：

```
❌ merge 版
   new Cust3(cid, email, "小明改名")   ← nickname 這個欄位【你沒設】，所以是 null
   ↓ merge
   把【你這個物件的每一個屬性】複製到 PC 裡那個物件上
   ↓
   nickname: 阿明 ← null      ← 這一格就是資料遺失
   ↓ 髒檢查：nickname 從「阿明」變成 null → 髒了
   UPDATE … nickname = NULL

✅ 撈出來改
   findById → PC 裡的物件，nickname = 阿明
   c.rename("小明改名")        ← 只碰 displayName
   ↓ 髒檢查：只有 displayName 髒了
   UPDATE … nickname = '阿明'（值沒變，但 3.4.6：預設會寫全部欄位）
```

⚠️ **注意兩個版本的 SQL 一模一樣**，這件事有兩個含意：

```
① 你【不能】從 SQL 的欄位列表判斷有沒有資料遺失
      → 因為預設就是寫全部欄位（3.4.6）
② 所以這個 bug 在 code review、在 SQL log、在 APM 上【都看不出來】
      → 只有比對「改之前 / 改之後的那一列」才看得到
```

> 📌 **這就是為什麼本課的規則是「不要用 `merge`」，而不是「小心地用 `merge`」。**
>
> 「小心地用」的意思是：**你的 DTO 必須完整覆蓋實體的每一個欄位，而且永遠保持同步。**
> 那在有人加一個新欄位的那一天就會失守——而且是靜默失守。
>
> **而「撈出來改」這個做法，對「有人加了一個新欄位」是免疫的。**

**如果你真的接手了一個滿是 `merge` 的專案**，兩個立即可用的防護：

```java
// 防護一：把「哪些欄位可以改」寫進 DTO → 實體的映射方法，一個一個 setter
public void applyTo(Cust3 c) {          // 在實體所在的套件裡
    if (displayName != null) c.rename(displayName);
    if (nickname != null) c.setNickname(nickname);
    // 沒送的欄位【什麼都不做】—— 這是關鍵
}

// 防護二：ArchUnit 直接禁掉 merge（05 站 05 章的手法）
@ArchTest
static final ArchRule 不准用merge = noClasses()
    .should().callMethod(EntityManager.class, "merge", Object.class)
    .because("merge 會用 DTO 的 null 覆蓋既有欄位（03 章 3.6.5）");
```

### 3.6.6 實測：`merge` 一張有明細的訂單

```java
    @Test
    void merge一張有明細的訂單() {
        seed();
        head("merge 一個 detached 的訂單（含 1 筆明細）");
        final Ord3[] hold = new Ord3[1];
        tx.executeWithoutResult(s -> {
            Ord3 o = orders.findById(oid).orElseThrow();
            o.getItems().size();       // 把明細也載進來
            hold[0] = o;
        });
        hold[0].setStatus(St3.PAID);
        var sqls = spy(() -> tx.executeWithoutResult(s -> em.merge(hold[0])));
        System.out.println("  → " + sqls.size() + " 句 SQL");
        sqls.forEach(q -> System.out.println("     " + q));

        head("同一件事，改成「載入 + 改 setter」");
        seed();
        var sqls2 = spy(() -> tx.executeWithoutResult(s ->
                orders.findById(oid).orElseThrow().setStatus(St3.PAID)));
        System.out.println("  → " + sqls2.size() + " 句 SQL");
        sqls2.forEach(q -> System.out.println("     " + q));
    }
```

```
═══ merge 一個 detached 的訂單（含 1 筆明細） ═══
  → 2 句 SQL
     select o1_0.id,o1_0.currency,o1_0.customer_id,o1_0.discount_amount,o1_0.order_no,
            o1_0.paid_at,o1_0.placed_at,o1_0.status,o1_0.total_amount,
            i1_0.order_id,i1_0.id,i1_0.line_amount,i1_0.product_id,i1_0.product_name,
            i1_0.qty,i1_0.unit_price
       from orders o1_0 left join order_item i1_0 on o1_0.id=i1_0.order_id where o1_0.id=?
     update orders set currency=?,customer_id=?,discount_amount=?,order_no=?,paid_at=?,
            placed_at=?,status=?,total_amount=? where id=?

═══ 同一件事，改成「載入 + 改 setter」 ═══
  → 2 句 SQL
     select o1_0.id,o1_0.currency,… from orders o1_0 where o1_0.id=?
     update orders set currency=?,… where id=?
```

**句數一樣（2 句），但第一句差很多。**

**`merge` 那句 `SELECT` 帶了一個 `LEFT JOIN order_item`**，因為
`@OneToMany(cascade = CascadeType.ALL)` **包含 `MERGE`**——
Hibernate 必須把明細也一起撈出來，才能逐筆比對「你這個 detached 集合裡有什麼」。

⚠️ **這一點在明細多的時候會很痛**：

```
merge 一張有 200 筆明細的訂單
   → SELECT 要 join 出 200 列（笛卡兒積，02 章 2.8.3）
   → 然後逐筆比對 200 個【物件參考】（3.4.2 的 ②）
   → 而你的 detached 集合裡那 200 個物件，跟 PC 剛撈出來的是【不同的物件實例】
   → 🔴 全部判定為「新的」→ 200 句 INSERT + 200 句 DELETE（如果有 orphanRemoval）
```

**這就是 02 章 2.6.3 那個「14 句 vs 3 句」在 `merge` 上的放大版**：
你只是想改一個 `status`，結果整張訂單的明細被重建一次。

📌 **結論**：`merge` 的成本**不是** O(1)，它是 **O(這個實體的 cascade 圖有多大)**。

### 3.6.7 `merge` 一個全新的物件

```java
    @Test
    void merge一個全新的物件() {
        seed();
        head("merge 一個從來沒存過的物件");
        UUID nid = Uuid7.next();
        var sqls = spy(() -> tx.executeWithoutResult(s -> {
            Cust3 brandNew = new Cust3(nid, "brand@x.com", "全新");
            Cust3 m = em.merge(brandNew);
            System.out.println("  傳進去 == 回傳 ? " + (brandNew == m));
            System.out.println("  傳進去的狀態 : " + Pc.state(em, brandNew));
            System.out.println("  回傳的狀態   : " + Pc.state(em, m));
        }));
        System.out.println("  → " + sqls.size() + " 句 SQL");
        sqls.forEach(q -> System.out.println("     " + q));
    }
```

```
═══ merge 一個從來沒存過的物件 ═══
  傳進去 == 回傳 ? false
  傳進去的狀態 : TRANSIENT / DETACHED（不在 PC 裡，PC 本身分不出來）
  回傳的狀態   : MANAGED
  → 2 句 SQL
     select c1_0.id,c1_0.display_name,c1_0.email,c1_0.nickname from customer c1_0 where c1_0.id=?
     insert into customer (display_name,email,nickname,id) values (?,?,?,?)
```

**`merge` 一個全新的物件是「可以」的**——它會先 `SELECT`（發現不存在），再 `INSERT`。

⚠️ **所以有人會說「`merge` 比 `persist` 安全，新增更新都能用」。**

**代價就是那句 `SELECT`**，而它在批次寫入時是致命的：

```
用 merge 寫 1000 筆新資料 → 1000 句 SELECT + 1000 句 INSERT
用 persist 寫 1000 筆     → 1000 句 INSERT（而且可以批次，06 章）
```

📌 **「安全」在這裡的真正意思是「我不知道這筆是新的還是舊的」。**
而那是一個**設計問題**，不該用 `merge` 的 `SELECT` 去掩蓋——
用例層面永遠知道自己是在新增還是更新。

### 3.6.8 `refresh` / `detach` / `clear` / `contains`

```java
    @Test
    void refresh與detach() {
        seed();
        head("refresh 會丟掉未 flush 的修改");
        tx.executeWithoutResult(s -> {
            Cust3 c = customers.findById(cid).orElseThrow();
            c.rename("改了但還沒 flush");
            c.setNickname("也改了 nickname");
            System.out.println("  改完      : " + c.getDisplayName() + " / " + c.getNickname());
            var sqls = spy(() -> em.refresh(c));
            System.out.println("  refresh → " + sqls.size() + " 句 SQL");
            System.out.println("  refresh 後 : " + c.getDisplayName() + " / " + c.getNickname());
        });

        head("detach 之後改，什麼都不會發生");
        tx.executeWithoutResult(s -> {
            Cust3 c = customers.findById(cid).orElseThrow();
            em.detach(c);
            c.rename("detach 後改的");
        });
        System.out.println("  資料庫 : " + nameInDb(cid));
    }
```

```
═══ refresh 會丟掉未 flush 的修改 ═══
  改完      : 改了但還沒 flush / 也改了 nickname
  refresh → 1 句 SQL
  refresh 後 : 小明 / 阿明   ← 🔴 兩個修改都不見了

═══ detach 之後改，什麼都不會發生 ═══
  資料庫 : 小明
```

**六個 API 的完整對照**：

| API | 做什麼 | 未 flush 的修改 | 常見用途 |
|---|---|---|---|
| `persist(x)` | transient → managed | — | **新增** |
| `merge(x)` | 把 x 的值複製到 PC 裡那個，**回傳那個** | — | ⚠️ 本課不用 |
| `remove(x)` | managed → removed | 丟掉 | 刪除（軟刪除除外） |
| `refresh(x)` | 從 DB 重讀這個實體 | 🔴 **丟掉** | 3.3.4 那種「別人改了」 |
| `detach(x)` | managed → detached | 🔴 **丟掉** | 幾乎不用 |
| `clear()` | 全部 → detached | 🔴 **全部丟掉** | 批次寫入（配 `flush()`） |
| `contains(x)` | 它在 PC 裡嗎 | — | 除錯 |

🔴 **`refresh` 的一個補充坑**：它只 refresh **那一個實體自己**。
關聯的集合會被重置成「未初始化」（下次碰它才重撈），
但**已經載入的關聯實體本身不會被 refresh**。所以 `refresh` 不是「把整個物件圖弄乾淨」。

要整個弄乾淨，只有 `em.clear()` 再重撈。

### 3.6.9 `persist` 與 `merge` 的五個差異

| | `persist` | `merge` |
|---|---|---|
| **回傳值** | `void`——改的是**你那個物件** | `T`——給你**另一個**物件（3.6.2） |
| **傳進去的物件** | 變成 managed | **還是 detached**（3.6.2） |
| **SQL** | 0 句（除非 `IDENTITY` 主鍵） | **一定先 `SELECT`**（3.6.3、3.6.7） |
| **成本** | O(1) | **O(cascade 圖大小)**（3.6.6） |
| **你沒設的欄位** | 就是你物件裡的值 | 🔴 **覆蓋掉資料庫既有的值**（3.6.5） |

**四條規則**：

```
① 新增用 persist（或實作 Persistable 的 save()）。它是 void，改的就是你那個物件
② 更新【不要用 save / merge】：撈出 managed 實體，呼叫它的業務方法（3.4.1）
③ 如果非得用 merge：一定接住回傳值，而且【只碰回傳的那個】
④ merge 的成本是 O(cascade 圖大小)，而且會用你 DTO 的 null 覆蓋既有欄位
```

---

## 3.7 `flush` ★★

前面每一節都在說「flush 的時候」。這一節把 flush 本身講完。

> **`flush` = 「把 PC 裡累積的變更，轉換成 SQL 送出去」。**
>
> ⚠️ **它不是 commit。** 送出去的 SQL 還在交易裡，還可以 rollback（3.7.7）。

### 3.7.1 三個時機

```java
package com.example.lab.ch03;

import com.example.lab.Uuid7;
import jakarta.persistence.FlushModeType;
import org.junit.jupiter.api.Test;

import java.util.UUID;

class A6Flush extends Base03 {

    @Test
    void 三個時機() {
        seed();
        head("時機一：交易 commit 前");
        var a = spy(() -> tx.executeWithoutResult(s ->
                customers.findById(cid).orElseThrow().rename("A")));
        a.forEach(q -> System.out.println("     " + q));

        seed();
        head("時機二：跑一句 JPQL 之前");
        tx.executeWithoutResult(s -> {
            Cust3 c = customers.findById(cid).orElseThrow();
            c.rename("B");
            System.out.println("  改完，資料庫還是 : " + nameInDb(cid));
            var sqls = spy(() -> em.createQuery("select count(c) from Cust3 c", Long.class)
                    .getSingleResult());
            System.out.println("  跑一句【完全無關】的 count JPQL → " + sqls.size() + " 句 SQL：");
            sqls.forEach(q -> System.out.println("     " + q));
            System.out.println("  資料庫現在 : " + nameInDb(cid) + "   ← UPDATE 被擠出去了");
        });

        seed();
        head("時機三：自己叫 em.flush()");
        tx.executeWithoutResult(s -> {
            customers.findById(cid).orElseThrow().rename("C");
            var sqls = spy(() -> em.flush());
            System.out.println("  em.flush() → " + sqls.size() + " 句");
        });
    }
}
```

```
═══ 時機一：交易 commit 前 ═══
     select c1_0.id,c1_0.display_name,c1_0.email,c1_0.nickname from customer c1_0 where c1_0.id=?
     update customer set display_name=?,email=?,nickname=? where id=?

═══ 時機二：跑一句 JPQL 之前 ═══
  改完，資料庫還是 : 小明
  跑一句【完全無關】的 count JPQL → 2 句 SQL：
     update customer set display_name=?,email=?,nickname=? where id=?
     select count(c1_0.id) from customer c1_0
  資料庫現在 : B   ← UPDATE 被擠出去了

═══ 時機三：自己叫 em.flush() ═══
  em.flush() → 1 句
```

⚠️ **注意時機二那句 JPQL 是 `select count(c) from Cust3 c`——它跟我改的那一列毫無關係。**

**Hibernate 沒有做「這句查詢會不會受到我未 flush 的變更影響」的分析。**
它的規則很簡單：**要跑 JPQL 了？先把所有東西 flush 掉。**

📌 **這個行為叫 `FlushModeType.AUTO`，是 JPA 的預設值，而它的目的是「查詢的一致性」**：
你剛剛把一個訂單改成 `PAID`，接著查「有幾張 `PAID` 的訂單」——
如果不先 flush，那句查詢會少算你剛改的那一張。

### 3.7.2 實測：哪些查詢會觸發 flush

```java
    @Test
    void 哪些查詢會觸發flush() {
        for (String kind : new String[]{"JPQL", "Criteria", "原生SQL(em)", "JdbcTemplate", "findById"}) {
            seed();
            tx.executeWithoutResult(s -> {
                customers.findById(cid).orElseThrow().rename("改過了");
                var sqls = spy(() -> runQuery(kind));
                boolean flushed = sqls.stream().anyMatch(q -> q.startsWith("update"));
                System.out.printf("  %-14s → 打了 %d 句，有 UPDATE 嗎 %s%n",
                        kind, sqls.size(), flushed ? "✅ 有（被 flush 了）" : "🔴 沒有");
                sqls.forEach(q -> System.out.println("        " + q));
            });
        }
    }

    private void runQuery(String kind) {
        switch (kind) {
            case "JPQL" -> em.createQuery("select count(c) from Cust3 c", Long.class).getSingleResult();
            case "Criteria" -> {
                var cb = em.getCriteriaBuilder();
                var q = cb.createQuery(Long.class);
                q.select(cb.count(q.from(Cust3.class)));
                em.createQuery(q).getSingleResult();
            }
            case "原生SQL(em)" -> em.createNativeQuery("SELECT COUNT(*) FROM customer").getSingleResult();
            case "JdbcTemplate" -> jdbc.queryForObject("SELECT COUNT(*) FROM customer", Long.class);
            case "findById" -> customers.findById(cid2).orElseThrow();
            default -> throw new IllegalStateException();
        }
    }
```

```
  JPQL           → 打了 2 句，有 UPDATE 嗎 ✅ 有（被 flush 了）
        update customer set display_name=?,email=?,nickname=? where id=?
        select count(c1_0.id) from customer c1_0
  Criteria       → 打了 2 句，有 UPDATE 嗎 ✅ 有（被 flush 了）
        update customer set display_name=?,email=?,nickname=? where id=?
        select count(c1_0.id) from customer c1_0
  原生SQL(em)      → 打了 2 句，有 UPDATE 嗎 ✅ 有（被 flush 了）
        update customer set display_name=?,email=?,nickname=? where id=?
        SELECT COUNT(*) FROM customer
  JdbcTemplate   → 打了 1 句，有 UPDATE 嗎 🔴 沒有
        SELECT COUNT(*) FROM customer
  findById       → 打了 1 句，有 UPDATE 嗎 🔴 沒有
        select c1_0.id,c1_0.display_name,c1_0.email,c1_0.nickname from customer c1_0 where c1_0.id=?
```

**一張很有用的表**：

| 怎麼查 | 會 flush 嗎 | 為什麼 |
|---|---|---|
| JPQL（`em.createQuery`） | ✅ | 走 Hibernate 的查詢管線 |
| Criteria API | ✅ | 同上（Criteria 最後也變成 JPQL） |
| **`em.createNativeQuery`** | ✅ | Hibernate 不知道你的 SQL 碰哪些表，**所以全部 flush** |
| **`JdbcTemplate` / MyBatis** | 🔴 **不會** | 它們**根本不知道 Hibernate 存在** |
| `findById` / `em.find` | 🔴 不會 | 走一級快取，不是查詢 |

⚠️ **`findById` 不 flush 這件事很少被提到，但它有一個實際後果**：

```java
tx(() -> {
    Cust3 a = customers.findById(cid).get();
    a.setEmail("new@x.com");                // 改了 email（有唯一鍵）
    Cust3 b = customers.findById(cid2).get();  // 🔴 不會 flush
    b.setEmail("new@x.com");                // 兩個人同一個 email
    // 直到 commit 才 flush → 唯一鍵衝突發生在【交易結束時】
    // 而錯誤訊息裡的堆疊完全指不到上面哪一行是兇手
});
```

📌 **這就是「flush 延後」的一般性代價：錯誤發生的地方，離錯誤的原因很遠。**
3.7.6 會看到一個更嚴重的版本。

### 3.7.3 實測：MyBatis 讀不到（回答 00 章 0.9 規則二）

00 章 0.9 定了混用的三條規則，規則二是：

> **JPA 寫完、MyBatis 讀之前，要 `flush`。**

現在有了 3.7.2 那張表，這條規則的理由就很清楚了。用 `JdbcTemplate` 代替 MyBatis
（兩者在這件事上完全一樣：都是純 JDBC，都不認識 Hibernate）：

```java
    @Test
    void MyBatis讀不到JPA還沒flush的東西() {
        seed();
        head("回答 00 章 0.9 規則二：同一個交易裡，JPA 改、JdbcTemplate 讀");
        tx.executeWithoutResult(s -> {
            customers.findById(cid).orElseThrow().rename("JPA 改的");
            System.out.println("  ① JPA 改完，JdbcTemplate 讀到 : " + nameInDb(cid) + "   🔴");
            em.flush();
            System.out.println("  ② em.flush() 之後再讀        : " + nameInDb(cid) + "   ✅");
        });
    }
```

```
═══ 回答 00 章 0.9 規則二：同一個交易裡，JPA 改、JdbcTemplate 讀 ═══
  ① JPA 改完，JdbcTemplate 讀到 : 小明   🔴
  ② em.flush() 之後再讀        : JPA 改的   ✅
```

⚠️ **注意這裡沒有隔離等級的問題**：`JdbcTemplate` 跟 JPA **共用同一條連線、同一個交易**
（Spring 的 `DataSourceUtils` 保證了這一點）。它讀不到，純粹是因為**那句 `UPDATE` 還沒送出去**。

**規則二的三種實作方式**，依可靠度排序：

```java
// ✅ 做法一：在混用的邊界上明確 flush（最清楚，但靠紀律）
@Transactional
public void mixed(UUID id) {
    orders.findById(id).orElseThrow().pay();
    em.flush();                                    // ★ 邊界
    reportMapper.recalcCustomerTotals(id);         // MyBatis
}

// ✅ 做法二：把 MyBatis 的讀放到【另一個交易】（結構性解法）
//    → 那時候 JPA 的交易已經 commit，沒有可見性問題
//    → 但要注意這樣就沒有原子性了

// ⚠️ 做法三：Hibernate 的 @Synchronize（告訴它「這個查詢碰這些表」）
//    → 只對 @Query(nativeQuery = true) 那種走 Hibernate 的原生查詢有效
//    → 對 MyBatis / JdbcTemplate 【無效】
```

📌 **本課採做法一，並且用 00 章 0.9 規則三（套件分層）讓「邊界在哪」看得見。**

### 3.7.4 實測：`FlushModeType.COMMIT`

```java
    @Test
    void FlushModeCOMMIT() {
        seed();
        head("把 flush mode 改成 COMMIT，查詢前就不 flush 了");
        tx.executeWithoutResult(s -> {
            em.setFlushMode(FlushModeType.COMMIT);
            Cust3 c = customers.findById(cid).orElseThrow();
            c.rename("改成小華");
            long n = em.createQuery(
                    "select count(c) from Cust3 c where c.displayName = '改成小華'", Long.class)
                    .getSingleResult();
            System.out.println("  改完之後用 JPQL 查「叫改成小華的有幾個」→ " + n);
            System.out.println("  但物件本身是 : " + c.getDisplayName());
            em.setFlushMode(FlushModeType.AUTO);
        });
        System.out.println("  交易結束後資料庫 : " + nameInDb(cid) + "   ← commit 時還是寫了");
    }
```

```
═══ 把 flush mode 改成 COMMIT，查詢前就不 flush 了 ═══
  改完之後用 JPQL 查「叫改成小華的有幾個」→ 0   ← 🔴 查不到自己剛改的
  但物件本身是 : 改成小華
  交易結束後資料庫 : 改成小華   ← commit 時還是寫了
```

**三個 flush mode**：

| 值 | 什麼時候 flush | 用途 |
|---|---|---|
| `AUTO`（預設） | commit 前 + **每次查詢前** | 一般 |
| `COMMIT` | 只在 commit 前 | ⚠️ 見下 |
| `MANUAL`（Hibernate 專屬） | **只在你自己叫 `flush()` 時** | `readOnly = true` 交易（3.4.7） |

🔴 **`COMMIT` 看起來像個效能最佳化（少了很多次 flush），而它的代價是「查詢讀不到自己剛改的」。**

**這在「一個方法慢慢長大」時特別危險**：

```java
@Transactional
public void process(UUID id) {
    em.setFlushMode(FlushModeType.COMMIT);   // 三年前某人為了「效能」加的
    Ord3 o = orders.findById(id).get();
    o.pay();
    // ... 兩年後有人在這裡加了一段
    long paid = countPaidOrders();           // 🔴 少算了剛剛那一張
    if (paid > threshold) { … }              // 🔴 業務邏輯就錯了
}
```

📌 **本課的規則**：

```
✅ 寫入的交易：一律用預設的 AUTO，不要碰它
✅ 唯讀的交易：用 @Transactional(readOnly = true)，Spring 會幫你設成 MANUAL
❌ 不要手動設 COMMIT。它省下的 flush 次數，遠比不上它造成的邏輯錯誤
```

### 3.7.5 實測：SQL 的順序不是程式碼的順序 ★★

```java
    @Test
    void SQL的順序不是程式碼的順序() {
        seed();
        head("程式碼順序：先 remove、再 persist、再改一個既有的");
        var sqls = spy(() -> tx.executeWithoutResult(s -> {
            em.remove(customers.findById(cid2).orElseThrow());
            System.out.println("  程式碼 ① em.remove(小華)");
            em.persist(new Cust3(Uuid7.next(), "new@x.com", "新來的"));
            System.out.println("  程式碼 ② em.persist(新來的)");
            customers.findById(cid).orElseThrow().rename("改過的小明");
            System.out.println("  程式碼 ③ rename(小明 → 改過的小明)");
        }));
        System.out.println("\n  實際送出去的 SQL 順序：");
        int i = 1;
        for (String q : sqls) System.out.println("     " + (i++) + ") " + q);
    }
```

```
═══ 程式碼順序：先 remove、再 persist、再改一個既有的 ═══
  程式碼 ① em.remove(小華)
  程式碼 ② em.persist(新來的)
  程式碼 ③ rename(小明 → 改過的小明)

  實際送出去的 SQL 順序：
     1) select c1_0.id,… from customer c1_0 where c1_0.id=?
     2) select c1_0.id,… from customer c1_0 where c1_0.id=?
     3) insert into customer (display_name,email,nickname,id) values (?,?,?,?)
     4) update customer set display_name=?,email=?,nickname=? where id=?
     5) delete from customer where id=?
```

🔴🔴 **程式碼寫「刪、插、改」，SQL 送出「插、改、刪」。**

**Hibernate 的 `ActionQueue` 有一個固定的順序，跟你的程式碼順序無關**：

```
① OrphanRemovalAction        ← orphanRemoval 的刪除（02 章 2.6）
② EntityInsertAction         ← INSERT
③ EntityUpdateAction         ← UPDATE
④ QueuedOperationCollectionAction
⑤ CollectionRemoveAction     ← 集合的刪除（中間表）
⑥ CollectionUpdateAction
⑦ CollectionRecreateAction
⑧ EntityDeleteAction         ← DELETE（最後）
```

**為什麼是這個順序**：主要是為了**外鍵**。

```
先 INSERT 再 DELETE 的理由：
   如果先刪 parent、再插 child，child 的外鍵會指向一個不存在的 parent
   → 所以 INSERT 排在前面

而 DELETE 排最後的理由：
   要刪 parent，得先確定沒有 child 指著它
   → 所以其他所有動作都做完了才刪
```

⚠️ **這個順序有一個很重要的例外要知道**：**它只在「同一次 flush 裡」有效**。

```java
em.remove(a);
em.flush();        // ★ 這裡切成兩次 flush
em.persist(b);
// → DELETE 先送、INSERT 後送。順序回到你的程式碼順序
```

**這就是下一節那個坑的解法。**

### 3.7.6 實測：先刪再插同一個唯一鍵 ★★

**這是 3.7.5 那個固定順序造成的、最常見的真實事故。**

場景：把一個客戶的 email 換給另一個新客戶（email 有唯一索引）。

```java
    @Test
    void 先刪再插同一個唯一鍵() {
        seed();
        head("🔴 把一個客戶的 email 換給另一個新客戶");
        try {
            tx.executeWithoutResult(s -> {
                em.remove(customers.findById(cid2).orElseThrow());          // 放掉 hua@x.com
                em.persist(new Cust3(Uuid7.next(), "hua@x.com", "接手的")); // 拿走 hua@x.com
            });
            System.out.println("  成功");
        } catch (Exception e) {
            System.out.println("  🔴 " + rootName(e) + ": " + firstLine(rootMsg(e)));
        }

        seed();
        head("✅ 中間補一句 em.flush()");
        try {
            tx.executeWithoutResult(s -> {
                em.remove(customers.findById(cid2).orElseThrow());
                em.flush();                                                 // ★ 強迫 DELETE 先走
                em.persist(new Cust3(Uuid7.next(), "hua@x.com", "接手的"));
            });
            System.out.println("  ✅ 成功，hua@x.com 現在屬於 : "
                    + jdbc.queryForObject(
                        "SELECT display_name FROM customer WHERE email='hua@x.com'", String.class));
        } catch (Exception e) {
            System.out.println("  🔴 " + rootName(e) + ": " + firstLine(rootMsg(e)));
        }
    }
```

```
═══ 🔴 把一個客戶的 email 換給另一個新客戶 ═══
  🔴 SQLIntegrityConstraintViolationException:
     Duplicate entry 'hua@x.com' for key 'customer.uk_customer_email'

═══ ✅ 中間補一句 em.flush() ═══
  ✅ 成功，hua@x.com 現在屬於 : 接手的
```

🔴 **同一段程式碼，中間多一行 `em.flush()`，從失敗變成成功。**

**這個坑的完整形狀**：

```
你的程式碼            Hibernate 送出的            結果
───────────────────────────────────────────────────────────────
remove(舊的)          INSERT 新的 (hua@x.com)     🔴 舊的還在，唯一鍵撞了
persist(新的)         DELETE 舊的                  ← 這一句根本沒機會跑
```

⚠️ **這個坑的三個常見變形**（形狀都一樣）：

```
① 「換一個唯一編號」    ：把 SO-001 從一張訂單換到另一張
② 「重建關聯」          ：clear() 集合再重建，中間表有唯一鍵 (02 章 2.9.1)
③ 「軟刪除 + 唯一索引」  ：01 章 1.8.3 那個實測就是這個坑的近親
```

**四種解法，依偏好排序**：

| 解法 | 怎麼做 | 評價 |
|---|---|---|
| ① **不要刪，改那一列** | `old.setEmail(...)` 而不是 remove + persist | ✅ 最好——**根本不需要兩個動作** |
| ② 中間 `em.flush()` | 如上面實測 | ✅ 有效，但要加註解說明為什麼 |
| ③ 唯一索引改成 deferrable | PostgreSQL 有，**MySQL 沒有** | 🔴 MySQL 不能用 |
| ④ 拆成兩個交易 | 先刪並 commit，再插 | 🔴 中間有一段時間資料是不一致的 |

📌 **① 才是真正的解法，而它是一個設計層次的觀察**：

```
「把 email 換給另一個人」在資料庫層次不需要「刪一列、插一列」。
如果你的模型迫使你這樣做，通常是【主鍵選錯了】——
你把「業務上會變的東西」跟「身分」綁在一起了。

07 站 01 章 1.8 那個「主鍵要用沒有業務含意的值（UUIDv7）」的規則，
在這裡收到了一次回報：id 不變、email 只是一個普通欄位 → 一句 UPDATE 解決。
```

⚠️ **而如果你真的用了解法 ②，一定要寫下為什麼**：

```java
em.remove(old);
em.flush();   // ★ 必要：Hibernate 的 flush 順序是 INSERT 先於 DELETE（03 章 3.7.5），
              //   不先送出 DELETE 的話，下一行會撞 uk_customer_email
em.persist(fresh);
```

**因為那一行 `em.flush()` 看起來像是多餘的**，下一個人很可能會「順手清掉」。

### 3.7.7 實測：`flush` 不是 `commit`

```java
    @Test
    void flush不是commit() {
        seed();
        head("flush 之後 rollback");
        UUID nid = Uuid7.next();
        try {
            tx.executeWithoutResult(s -> {
                em.persist(new Cust3(nid, "rb@x.com", "會被 rollback"));
                em.flush();
                System.out.println("  flush 後，同一條連線看得到 : "
                        + jdbc.queryForObject("SELECT COUNT(*) FROM customer WHERE id=?",
                                Long.class, Uuid7.toBytes(nid)));
                throw new IllegalStateException("故意炸掉");
            });
        } catch (IllegalStateException e) {
            System.out.println("  交易 rollback：" + e.getMessage());
        }
        System.out.println("  交易外再看 : "
                + jdbc.queryForObject("SELECT COUNT(*) FROM customer WHERE id=?",
                        Long.class, Uuid7.toBytes(nid)) + " 筆   ← INSERT 沒了");
    }
```

```
═══ flush 之後 rollback ═══
  flush 後，同一條連線看得到 : 1
  交易 rollback：故意炸掉
  交易外再看 : 0 筆   ← INSERT 沒了
```

**三層可見性，要分清楚**：

```
① PC 裡（記憶體）      ：persist 之後就看得到
② 同一個交易的連線     ：flush 之後看得到（JdbcTemplate / MyBatis 也是）
③ 其他交易             ：commit 之後才看得到
```

⚠️ **一個常見的誤解**：「我 flush 了，所以資料安全了。」
**不是。** flush 只是把 SQL 送出去，**它還在交易裡**，
任何後續的例外都會讓它全部回滾。

📌 而 flush 有一個**真正的**副作用要知道：**它會拿鎖。**

```
flush 送出 UPDATE → InnoDB 在那些列上加了排他鎖（07 站 04 章）
   → 從 flush 到 commit 這段時間，別人改同一列會被卡住
   → 所以【提早 flush = 提早拿鎖 = 鎖持有時間變長 = 併發變差】

🔴 這就是為什麼「在迴圈裡每一筆都 flush」不只是慢，還會傷併發。
```

### 3.7.8 flush 的六條規則

```
① flush = 把 PC 的變更轉成 SQL 送出。【不是 commit】
② 三個時機：commit 前、查詢前（AUTO）、你自己叫
③ JPQL / Criteria / em.createNativeQuery 會觸發；
   JdbcTemplate / MyBatis / findById 【不會】★
④ SQL 順序是固定的（orphan → INSERT → UPDATE → 集合 → DELETE），
   跟程式碼順序無關 ★★
⑤ 「先刪再插同一個唯一鍵」會撞唯一鍵。正解是「不要刪，改它」
⑥ flush 會拿鎖。不要在迴圈裡每一筆都 flush
```

---

## 3.8 交易邊界與 `EntityManager` 的生命週期

3.2.3 證明了「一個交易，一個持久化情境」。這一節處理**交易不只一層**的情況。

### 3.8.1 誰開的持久化情境

```
你的 Service 方法上有 @Transactional
   ↓
Spring 的 TransactionInterceptor 攔到這次呼叫
   ↓
JpaTransactionManager.doBegin()
   ├─ 從 EntityManagerFactory 開一個【新的】EntityManager
   ├─ 從它拿一條 JDBC 連線、開一個交易
   ├─ 把 (EMF → EntityManager) 綁到【當前執行緒】(TransactionSynchronizationManager)
   └─ readOnly = true 的話：setDefaultReadOnly(true) + FlushMode.MANUAL（3.4.7）
   ↓
你注入的那個 em 代理（3.2.2 的第 ① 層），每次呼叫都去執行緒上找那一個
   ↓
方法正常結束 → flush + commit + 【關掉 EntityManager】→ 所有實體變 detached
方法拋例外   → rollback + 關掉 EntityManager
```

📌 **兩個關鍵字**：

```
「綁到當前執行緒」 → 所以同一個交易裡不管在幾個類別、幾層深，拿到的都是同一個 PC
「關掉」           → 所以交易結束後，你手上的實體全部 detached（3.5.5）
```

### 3.8.2 實測：兩層 `@Transactional`

```java
package com.example.lab.ch03;

import com.example.lab.Uuid7;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.util.UUID;

class A7Tx extends Base03 {

    @Autowired TxSvc svc;         // 3.4.7 那個，原樣沿用

    @Test
    void 兩層Transactional是同一個持久化情境嗎() {
        seed();
        head("外層 @Transactional 呼叫內層 @Transactional（都是預設的 REQUIRED）");
        svc.outer(() -> svc.innerRequired());
    }
}
```

```
═══ 外層 @Transactional 呼叫內層 @Transactional（都是預設的 REQUIRED） ═══
  外層 Session / PC : Session@541c32de / PC@22120799
  內層 REQUIRED     : Session@541c32de / PC@22120799
  回到外層          : Session@541c32de / PC@22120799
```

**`REQUIRED`（預設）= 加入既有的交易 = 同一個持久化情境。**

📌 這一條讓「Service 呼叫 Service」變得安全：
外層撈出來的實體，在內層還是 managed，改了照樣會寫回去。

⚠️ **但它也意味著一件事：`@Transactional` 不保證你「開了一個新交易」。**
如果上層已經有交易，你的 `@Transactional` 只是**加入**它——
包含 `rollbackFor`、`timeout`、`readOnly` 這些設定，**全部被忽略**，
用的是最外層那個的設定。

### 3.8.3 實測：`REQUIRES_NEW` 是另一個持久化情境

```java
    @Test
    void REQUIRES_NEW是另一個持久化情境() {
        seed();
        head("外層撈了一個實體，交給 REQUIRES_NEW 的內層");
        svc.readWrite(em0 -> {
            Cust3 c = em0.find(Cust3.class, cid);
            System.out.println("  外層              : " + TxSvc.tag(em0));
            System.out.println("  外層那個實體      : " + Pc.state(em0, c));
            svc.innerRequiresNew(c);
            System.out.println("  回到外層，它還是   : " + Pc.state(em0, c));
        });
    }
```

```
═══ 外層撈了一個實體，交給 REQUIRES_NEW 的內層 ═══
  外層              : Session@28516b2d / PC@2c7fb24c
  外層那個實體      : MANAGED
  內層 REQUIRES_NEW : Session@51ce8293 / PC@23043ba
  外層那個實體，在這裡是 : TRANSIENT / DETACHED（不在 PC 裡，PC 本身分不出來）
  em.contains(它)      : false
  回到外層，它還是   : MANAGED
```

🔴 **同一個 Java 物件，在外層是 `MANAGED`、在內層是 `DETACHED`、回到外層又是 `MANAGED`。**

> ⚠️⚠️ **「一個物件是什麼狀態」不是物件的屬性，是「物件 × 持久化情境」的關係。**
>
> 這是 3.5 那張狀態圖最容易被誤讀的地方。
> 「這個 `Order` 是 detached 嗎」**不是一個完整的問題**，
> 完整的問題是「這個 `Order` 對**現在這個 PC** 來說是 detached 嗎」。

**所以「把實體傳進 `REQUIRES_NEW` 的方法裡」是一個 bug 形狀**：

```java
// ❌ 內層改的東西不會寫回去（那個物件在內層是 detached）
@Transactional
public void outer(UUID id) {
    Ord3 o = orders.findById(id).get();
    auditService.logAndTouch(o);        // @Transactional(REQUIRES_NEW)
}

@Transactional(propagation = Propagation.REQUIRES_NEW)
public void logAndTouch(Ord3 o) {
    o.setStatus(St3.PACKED);            // 🔴 detached，什麼都不會發生
    auditRepo.save(new Audit(o.getId()));
}

// ✅ 傳 id，讓內層自己撈
@Transactional(propagation = Propagation.REQUIRES_NEW)
public void logAndTouch(UUID orderId) {
    Ord3 o = orders.findById(orderId).orElseThrow();   // 內層 PC 的 managed 實體
    o.setStatus(St3.PACKED);
    auditRepo.save(new Audit(orderId));
}
```

📌 **一條很好用的規則：跨交易邊界只傳 id 與不可變值，不傳實體。**

### 3.8.4 實測：內層改了，外層看不到

```java
    @Test
    void 內層改了外層看不到() {
        seed();
        head("外層先撈進一級快取，內層 REQUIRES_NEW 改完並 commit");
        svc.readWrite(em0 -> {
            Cust3 c = em0.find(Cust3.class, cid);
            System.out.println("  外層撈到 : " + c.getDisplayName());
            svc.requiresNew(em1 -> {
                Cust3 inner = em1.find(Cust3.class, cid);
                inner.rename("內層改的");
                em1.flush();
                System.out.println("  內層改完並 flush");
            });
            System.out.println("  外層 c.getDisplayName()      : " + c.getDisplayName());
            System.out.println("  外層再 find                  : "
                    + em0.find(Cust3.class, cid).getDisplayName());
        });
        System.out.println("  交易全部結束，資料庫 : " + nameInDb(cid));
    }
```

```
═══ 外層先撈進一級快取，內層 REQUIRES_NEW 改完並 commit ═══
  外層撈到 : 小明
  內層改完並 flush
  外層 c.getDisplayName()      : 小明   🔴
  外層再 find                  : 小明   🔴
  交易全部結束，資料庫 : 內層改的
```

**這是 3.3.4 那個實驗的「內部版本」**：內層就是「外面有人改了」。

⚠️ **而它比 3.3.4 更容易發生**，因為 `REQUIRES_NEW` 通常是自己的程式碼：
稽核日誌、通知寄送、失敗計數——這些「不管主流程成敗都要記」的東西，
標 `REQUIRES_NEW` 是對的，**而它們如果順手改了主流程的實體，外層就看不到。**

📌 **規則**：`REQUIRES_NEW` 的方法**只寫自己的表**，不要碰主流程的實體。

### 3.8.5 實測：沒有交易的 Repository

```java
    @Test
    void 沒有交易的Repository每次一個EntityManager() {
        seed();
        head("沒有 @Transactional：連續三次 findById");
        var sqls = spy(() -> {
            Cust3 a = customers.findById(cid).orElseThrow();
            Cust3 b = customers.findById(cid).orElseThrow();
            Cust3 c = customers.findById(cid).orElseThrow();
            System.out.println("  a==b : " + (a == b) + "、b==c : " + (b == c));
        });
        System.out.println("  → " + sqls.size() + " 句 SQL（每次一個新的 EntityManager）");

        head("沒有交易時撈出來的實體，狀態是什麼");
        Cust3 x = customers.findById(cid).orElseThrow();
        try {
            Ord3 o = orders.findById(oid).orElseThrow();
            o.getItems().size();
        } catch (Exception e) {
            System.out.println("  🔴 " + e.getClass().getSimpleName());
        }
        x.rename("沒有交易時改的");
        System.out.println("  改完，資料庫 : " + nameInDb(cid) + "   ← 沒寫回去");
    }
```

```
═══ 沒有 @Transactional：連續三次 findById ═══
  a==b : false、b==c : false
  → 3 句 SQL（每次一個新的 EntityManager）

═══ 沒有交易時撈出來的實體，狀態是什麼 ═══
  🔴 LazyInitializationException
  改完，資料庫 : 小明   ← 沒寫回去
```

**這是 3.2.4 的完整版**。三個後果，全部是靜默的或延後的：

```
① 一級快取完全失效     → N 次 findById = N 句 SQL
② 撈出來就 detached    → 改了不會寫回（靜默）
③ 延遲載入一定炸       → LazyInitializationException（會炸，但在很遠的地方）
```

⚠️ **`@Transactional` 加在哪一層**：

| 加在哪 | 好嗎 |
|---|---|
| **Service 的 public 方法**（一個用例一個交易） | ✅ **本課的做法** |
| Repository | 🔴 每個 repository 呼叫一個交易，回到上面那三個後果 |
| Controller | 🔴 交易包含了序列化、外部呼叫，交易太長（3.8.7） |

🔴 **一個特別容易漏的地方**：`@Transactional` 加在 **`private` 方法**、
或**同類別的自我呼叫**上——**完全沒有效果**（3.4.7 那個踩到的坑）。

**怎麼在 CI 裡抓到「Service 方法忘了標 @Transactional」**（05 站的 ArchUnit 手法）：

```java
@ArchTest
static final ArchRule Service的public方法都要有交易註解 =
    methods().that().areDeclaredInClassesThat().resideInAPackage("..service..")
             .and().arePublic()
             .should().beAnnotatedWith(Transactional.class)
             .because("沒有交易 = 撈出來就 detached，改了不會寫回（03 章 3.8.5）");
```

### 3.8.6 實測：例外之後的持久化情境

```java
    @Test
    void 例外之後的持久化情境() {
        seed();
        head("🔴 在交易裡吃掉一個 PersistenceException，然後繼續用同一個 em");
        try {
            tx.executeWithoutResult(s -> {
                try {
                    em.persist(new Cust3(Uuid7.next(), "ming@x.com", "email 撞了"));
                    em.flush();
                } catch (Exception e) {
                    System.out.println("  ① 被我吃掉了 : " + e.getClass().getSimpleName());
                }
                System.out.println("  ② 繼續用同一個 em 撈一筆...");
                try {
                    Cust3 c = customers.findById(cid).orElseThrow();
                    c.rename("接著改");
                    System.out.println("     撈到了，也改了");
                } catch (Exception e) {
                    System.out.println("     🔴 " + e.getClass().getSimpleName());
                }
            });
            System.out.println("  ③ 交易正常結束了？");
        } catch (Exception e) {
            System.out.println("  ③ 🔴 " + e.getClass().getSimpleName() + ": " + firstLine(e.getMessage()));
        }
        System.out.println("  資料庫 : " + nameInDb(cid));
    }
```

```
═══ 🔴 在交易裡吃掉一個 PersistenceException，然後繼續用同一個 em ═══
  ① 被我吃掉了 : ConstraintViolationException
  ② 繼續用同一個 em 撈一筆...
     撈到了，也改了
  ③ 🔴 UnexpectedRollbackException: Transaction silently rolled back because it has
        been marked as rollback-only
  資料庫 : 小明
```

🔴🔴 **「② 撈到了，也改了」是最誤導的一行**：例外被吃掉之後，
`em` **看起來還能用**——撈得到、改得動、不報錯。

**而整個交易在 ① 那一刻就已經注定要回滾了。**

**兩件事同時發生**：

```
① Spring 那一層：TransactionAspectSupport 看到 PersistenceException
      → 把當前交易標成 rollback-only
      → 之後不管你做了什麼，commit 時一律拋 UnexpectedRollbackException

② Hibernate 那一層：JPA 規格明文說
      「flush 失敗後，PersistenceContext 進入【未定義】狀態」
      → 它裡面的實體、快照、動作佇列可能已經不一致
      → 規格要求你【放棄這個 EntityManager】，不要再用
```

⚠️ **所以「在交易裡 try-catch 一個資料庫例外然後繼續」這件事，本質上是錯的。**

**三種正確的處理方式**：

```java
// ✅ 方式一：讓它往外拋。交易回滾，上層決定要不要重試
@Transactional
public void register(String email) {
    customers.save(new Cust3(Uuid7.next(), email, email));
    // 撞唯一鍵 → 例外往外拋 → 回滾。乾淨
}

// ✅ 方式二：【事前檢查】而不是事後 catch（但要知道它有競態）
@Transactional
public void register(String email) {
    if (customers.existsByEmail(email)) throw new EmailTakenException(email);
    customers.save(new Cust3(Uuid7.next(), email, email));
}
// ⚠️ 兩個請求同時進來還是會有一個撞唯一鍵 → 唯一索引仍然是最後防線（07 站 1.10）

// ✅ 方式三：真的要「試了失敗就換一個」→ 用 REQUIRES_NEW 把失敗隔離在【另一個交易】
@Transactional(propagation = Propagation.REQUIRES_NEW)
public boolean tryRegister(String email) { … }
// 內層交易自己回滾，不會汙染外層
```

📌 **記法**：

> **資料庫例外之後，那個 `EntityManager` 就是報廢的。**
> **要「繼續」，你需要的不是 try-catch，是【另一個交易】。**

### 3.8.7 `open-in-view`：為什麼本課設 `false`

```java
    @Test
    void 交易外面的實體是detached() {
        seed();
        head("open-in-view = false（本課的設定）：Service 回傳實體給上層");
        final Ord3[] hold = new Ord3[1];
        svc.readOnly(em0 -> hold[0] = em0.find(Ord3.class, oid));
        System.out.println("  拿到訂單     : " + hold[0].getOrderNo());
        try {
            System.out.println("  o.getItems() : " + hold[0].getItems().size());
        } catch (Exception e) {
            System.out.println("  o.getItems() : 🔴 " + e.getClass().getSimpleName());
        }
        System.out.println("  📌 這就是 02 章 2.10.1 那個「no Session」——它的正式名稱是 detached");
    }
```

```
═══ open-in-view = false（本課的設定）：Service 回傳實體給上層 ═══
  拿到訂單     : SO-1
  o.getItems() : 🔴 LazyInitializationException
  📌 這就是 02 章 2.10.1 那個「no Session」——它的正式名稱是 detached
```

**`spring.jpa.open-in-view`（預設 `true`）做的事**：
用一個 Servlet Filter 把 `EntityManager` 開在**整個 HTTP 請求**的範圍，
於是延遲載入在 Controller、在 Jackson 序列化時**都還能用**。

**它會讓上面那個 `LazyInitializationException` 消失。而這正是問題。**

| | `open-in-view = true` | `open-in-view = false`（本課） |
|---|---|---|
| Controller 裡碰延遲關聯 | ✅ 可以 | 🔴 炸 |
| Jackson 序列化實體 | ✅ 可以 | 🔴 炸 |
| **那些 SQL 在哪裡發出的** | 🔴 **在序列化的時候**（你看不見） | ✅ 全部在 Service 裡 |
| **N+1 什麼時候被發現** | 🔴 **上線後**（00 章 0.3.2 的 251 句） | ✅ **開發時就炸** |
| **連線持有時間** | 🔴 整個請求（含序列化） | ✅ 只有交易期間 |

> 📌 **這是一個「讓錯誤提早發生」的取捨，而它是本課最重要的組態之一。**
>
> `open-in-view = true` 的問題不是「它會慢」，
> 而是 **它讓「哪些 SQL 會被打出來」變成一件在 Controller 之外、
> 由序列化器決定的事**——那是你完全看不見、也無法測試的地方。
>
> **關掉它，你會在寫程式的第一天就撞上 `LazyInitializationException`，
> 而那個例外是在告訴你：「你的 Service 沒有把這個用例需要的資料撈齊。」**
>
> 而「把資料撈齊」正是 04 章（`JOIN FETCH` / `@EntityGraph`）與 05 章（DTO 投影）的主題。

⚠️ **Spring Boot 在啟動時會警告你**（如果你沒明確設它）：

```
spring.jpa.open-in-view is enabled by default. Therefore, database queries may be
performed during view rendering. Explicitly configure spring.jpa.open-in-view to disable
this warning
```

**這個警告不是「請你關掉」，是「請你做一個決定」。本課的決定是 `false`。**

---

## 3.9 生命週期回呼

### 3.9.1 七個回呼

```java
@PrePersist    INSERT 之前     @PostPersist   INSERT 之後
@PreUpdate     UPDATE 之前     @PostUpdate    UPDATE 之後
@PreRemove     DELETE 之前     @PostRemove    DELETE 之後
                               @PostLoad      SELECT 載入之後
```

**兩種寫法**：

```java
// ① 寫在實體自己身上（方法可以是 private / package-private，回傳 void、無參數）
@PrePersist void beforeInsert() { … }

// ② 寫在一個獨立的監聽器類別上（方法要接一個參數：那個實體）
@Entity @EntityListeners(MyListener.class)
public class Cust3 { … }

public class MyListener {
    @PrePersist void beforeInsert(Cust3 c) { … }
}
```

**這一節的實驗實體**（同一張 `customer` 表，第三個映射）：

```java
package com.example.lab.ch03;

import jakarta.persistence.*;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** 跟 Cust3 同一張表；七個生命週期回呼各記一行（3.9）。 */
@Entity @Table(name = "customer")
@EntityListeners(CustCb.Listener.class)
public class CustCb {

    /** 全部回呼的觸發紀錄，測試讀它來檢查順序。 */
    public static final List<String> TRACE = new ArrayList<>();
    /** 測試可以插一段程式碼進 @PrePersist / @PreUpdate 裡（3.9.5）。 */
    public static java.util.function.Consumer<CustCb> HOOK = c -> {};
    public static java.util.function.Consumer<CustCb> POST_HOOK = c -> {};
    public static void reset() { TRACE.clear(); HOOK = c -> {}; POST_HOOK = c -> {}; }

    @Id private UUID id;
    @Column(nullable = false, length = 255) private String email;
    @Column(name = "display_name", nullable = false, length = 64) private String displayName;

    protected CustCb() {}
    public CustCb(UUID id, String email, String displayName) {
        this.id = id; this.email = email; this.displayName = displayName;
    }
    public UUID getId() { return id; }
    public String getDisplayName() { return displayName; }
    public void rename(String n) { this.displayName = n; }

    @PrePersist  void prePersist()  { TRACE.add("@PrePersist  (實體上)"); HOOK.accept(this); }
    @PostPersist void postPersist() { TRACE.add("@PostPersist (實體上)"); POST_HOOK.accept(this); }
    @PreUpdate   void preUpdate()   { TRACE.add("@PreUpdate   (實體上)"); HOOK.accept(this); }
    @PostUpdate  void postUpdate()  { TRACE.add("@PostUpdate  (實體上)"); POST_HOOK.accept(this); }
    @PreRemove   void preRemove()   { TRACE.add("@PreRemove   (實體上)"); }
    @PostRemove  void postRemove()  { TRACE.add("@PostRemove  (實體上)"); }
    @PostLoad    void postLoad()    { TRACE.add("@PostLoad    (實體上)"); }

    /** 外部監聽器：跟實體上的回呼比先後（3.9.2）。 */
    public static class Listener {
        @PrePersist  void prePersist(CustCb c)  { TRACE.add("@PrePersist  (Listener)"); }
        @PostPersist void postPersist(CustCb c) { TRACE.add("@PostPersist (Listener)"); }
        @PreUpdate   void preUpdate(CustCb c)   { TRACE.add("@PreUpdate   (Listener)"); }
        @PostUpdate  void postUpdate(CustCb c)  { TRACE.add("@PostUpdate  (Listener)"); }
        @PreRemove   void preRemove(CustCb c)   { TRACE.add("@PreRemove   (Listener)"); }
        @PostRemove  void postRemove(CustCb c)  { TRACE.add("@PostRemove  (Listener)"); }
        @PostLoad    void postLoad(CustCb c)    { TRACE.add("@PostLoad    (Listener)"); }
    }
}
```

```java
package com.example.lab.ch03;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.UUID;

public interface CustCbRepo extends JpaRepository<CustCb, UUID> {}
```

### 3.9.2 實測：觸發順序

```java
package com.example.lab.ch03;

import com.example.lab.Uuid7;
import org.junit.jupiter.api.Test;

import java.util.UUID;

class A8Callbacks extends Base03 {

    @Test
    void 七個回呼的觸發順序() {
        seed();
        UUID nid = Uuid7.next();

        head("INSERT：em.persist + flush");
        CustCb.reset();
        tx.executeWithoutResult(s -> {
            em.persist(new CustCb(nid, "cb@x.com", "回呼"));
            System.out.println("  persist 之後、flush 之前 : " + CustCb.TRACE);
            em.flush();
            System.out.println("  flush 之後               : " + CustCb.TRACE);
        });

        head("SELECT：撈回來");
        CustCb.reset();
        tx.executeWithoutResult(s -> {
            em.find(CustCb.class, nid);
            System.out.println("  " + CustCb.TRACE);
        });

        head("UPDATE：改一個欄位");
        CustCb.reset();
        tx.executeWithoutResult(s -> {
            em.find(CustCb.class, nid).rename("改過");
            System.out.println("  改完、flush 之前 : " + CustCb.TRACE);
            em.flush();
            System.out.println("  flush 之後       : " + CustCb.TRACE);
        });

        head("DELETE：em.remove");
        CustCb.reset();
        tx.executeWithoutResult(s -> {
            em.remove(em.find(CustCb.class, nid));
            System.out.println("  remove 之後、flush 之前 : " + CustCb.TRACE);
            em.flush();
            System.out.println("  flush 之後              : " + CustCb.TRACE);
        });
    }
}
```

```
═══ INSERT：em.persist + flush ═══
  persist 之後、flush 之前 : [@PrePersist  (Listener), @PrePersist  (實體上)]
  flush 之後               : [@PrePersist  (Listener), @PrePersist  (實體上),
                             @PostPersist (Listener), @PostPersist (實體上)]

═══ SELECT：撈回來 ═══
  [@PostLoad    (Listener), @PostLoad    (實體上)]

═══ UPDATE：改一個欄位 ═══
  改完、flush 之前 : [@PostLoad (Listener), @PostLoad (實體上)]
  flush 之後       : [@PostLoad (Listener), @PostLoad (實體上),
                     @PreUpdate (Listener), @PreUpdate (實體上),
                     @PostUpdate (Listener), @PostUpdate (實體上)]

═══ DELETE：em.remove ═══
  remove 之後、flush 之前 : [@PostLoad (Listener), @PostLoad (實體上),
                            @PreRemove (Listener), @PreRemove (實體上)]
  flush 之後              : [… @PostRemove (Listener), @PostRemove (實體上)]
```

**三個結論**：

**① 監聽器（`@EntityListeners`）永遠先於實體上的回呼。**
JPA 規格定義的順序是「先父類別的監聽器 → 子類別的監聽器 → 實體自己的方法」。

**② `@PrePersist` 與 `@PreRemove` 在 `persist()` / `remove()` 那一刻就跑了，不用等 flush。**

```
em.persist(x)  → 【立刻】@PrePersist
em.flush()     →  INSERT，然後 @PostPersist
```

⚠️ 這一點跟 `@PreUpdate` **不一樣**：

```
x.setFoo(1)    → 什麼都不會發生（3.4.3：setter 什麼都不做）
em.flush()     → 髒檢查 → @PreUpdate → UPDATE → @PostUpdate
```

📌 **所以 `@PrePersist` 適合填「建立時間」，而 `@PreUpdate` 是唯一能填「更新時間」的地方**——
這正是 01 章 1.15.1 那個 Spring Data Auditing 的實作方式。

**③ `@PostLoad` 在撈出來的那一刻就跑了。**
而它也是 01 章 1.6.6 那個 `Persistable` 的關鍵：

```java
@PostPersist @PostLoad void markNotNew() { this.isNew = false; }
//            ▲
//            撈回來的一律不是新的 → save() 走 merge 那條路的問題就不會發生
```

### 3.9.3 實測：沒有變更就沒有 `@PreUpdate`

```java
    @Test
    void 沒有變更就沒有PreUpdate() {
        seed();
        UUID nid = Uuid7.next();
        tx.executeWithoutResult(s -> em.persist(new CustCb(nid, "cb2@x.com", "回呼2")));

        head("撈出來但什麼都不改");
        CustCb.reset();
        tx.executeWithoutResult(s -> em.find(CustCb.class, nid));
        System.out.println("  " + CustCb.TRACE);

        head("撈出來、設回同一個值");
        CustCb.reset();
        tx.executeWithoutResult(s -> em.find(CustCb.class, nid).rename("回呼2"));
        System.out.println("  " + CustCb.TRACE);
    }
```

```
═══ 撈出來但什麼都不改 ═══
  [@PostLoad    (Listener), @PostLoad    (實體上)]

═══ 撈出來、設回同一個值 ═══
  [@PostLoad    (Listener), @PostLoad    (實體上)]   ← 🔴 沒有 @PreUpdate
```

**`@PreUpdate` 只在「髒檢查判定它髒了」時才跑。**

⚠️ **這件事在「用 `@PreUpdate` 填 `updated_at`」時是好事**（沒改就不該動更新時間），
**但在「用 `@PreUpdate` 寫稽核日誌」時是坑**：

```java
// 🔴 「每次有人碰這筆資料就記一筆」—— 做不到
@PreUpdate void audit() { … }
// 設回同一個值 → 不髒 → 沒有 UPDATE → 沒有這個回呼 → 沒有稽核
```

📌 「誰讀了 / 誰碰了」這種稽核，要在 **Service 層**做，不能靠 `@PreUpdate`。

### 3.9.4 實測：在回呼裡改自己的欄位

```java
    @Test
    void 在回呼裡改自己的欄位() {
        seed();
        UUID nid = Uuid7.next();

        head("@PrePersist 裡改自己的欄位，會進 INSERT 嗎");
        CustCb.reset();
        CustCb.HOOK = c -> c.rename("被 @PrePersist 改掉");
        var a = spy(() -> tx.executeWithoutResult(s ->
                em.persist(new CustCb(nid, "cb3@x.com", "原本的名字"))));
        a.forEach(q -> System.out.println("     " + q));
        System.out.println("  資料庫 : " + nameInDb(nid));

        head("@PreUpdate 裡改自己的欄位，會進 UPDATE 嗎");
        CustCb.reset();
        CustCb.HOOK = c -> c.rename("被 @PreUpdate 改掉");
        var b = spy(() -> tx.executeWithoutResult(s ->
                em.find(CustCb.class, nid).rename("我改的")));
        b.forEach(q -> System.out.println("     " + q));
        System.out.println("  資料庫 : " + nameInDb(nid));
        CustCb.reset();
    }
```

```
═══ @PrePersist 裡改自己的欄位，會進 INSERT 嗎 ═══
     insert into customer (display_name,email,id) values (?,?,?)
  資料庫 : 被 @PrePersist 改掉

═══ @PreUpdate 裡改自己的欄位，會進 UPDATE 嗎 ═══
     select cc1_0.id,cc1_0.display_name,cc1_0.email from customer cc1_0 where cc1_0.id=?
     update customer set display_name=?,email=? where id=?
  資料庫 : 被 @PreUpdate 改掉
```

**✅ `@PrePersist` / `@PreUpdate` 裡改自己的欄位是有效的**，改的值會進 SQL。

📌 **這是回呼唯一「安全而且該用」的用途**：填自己的審計欄位。

```java
@PrePersist void onCreate() {
    this.createdAt = Instant.now();
    this.updatedAt = this.createdAt;
}
@PreUpdate void onUpdate() {
    this.updatedAt = Instant.now();
}
```

⚠️ **但 01 章 1.15 比較過兩種做法，本課選的是「資料庫填」**
（`DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`），理由是
**「不管誰寫的（JPA / MyBatis / 手動 SQL / DBA 修資料），時間都會對」**。
回呼只在應用端寫入時才跑。

### 3.9.5 實測：在回呼裡碰 `EntityManager` 的四種下場 ★★

「回呼裡不要碰 `EntityManager`」是每份文件都會寫的一句話，
但很少說明**碰了會怎樣**。實測四種寫法：

```java
package com.example.lab.ch03;

import com.example.lab.Uuid7;
import org.junit.jupiter.api.Test;

import java.util.UUID;

/** 3.9.5：在回呼裡碰 EntityManager 的四種寫法，各自的下場。 */
class A9CbDanger extends Base03 {

    @Test
    void 四種寫法() {
        probe("① @PreUpdate 裡 em.flush()（遞迴 flush）",
                c -> em.flush(), null);
        probe("② @PreUpdate 裡 em.persist(新實體)",
                c -> em.persist(new Cust3(Uuid7.next(), "s1@x.com", "回呼新增")), null);
        probe("③ @PostUpdate 裡 em.persist(新實體)",
                null, c -> em.persist(new Cust3(Uuid7.next(), "s2@x.com", "回呼新增")));
        probe("④ @PostUpdate 裡 em.flush()",
                null, c -> em.flush());
    }

    private void probe(String title,
                       java.util.function.Consumer<CustCb> pre,
                       java.util.function.Consumer<CustCb> post) {
        seed();
        UUID nid = Uuid7.next();
        tx.executeWithoutResult(s -> em.persist(new CustCb(nid, "cb@x.com", "原本")));
        CustCb.reset();
        if (pre != null) CustCb.HOOK = pre;
        if (post != null) CustCb.POST_HOOK = post;
        head(title);
        try {
            var sqls = spy(() -> tx.executeWithoutResult(s ->
                    em.find(CustCb.class, nid).rename("我改的")));
            System.out.println("  → " + sqls.size() + " 句 SQL");
            java.util.LinkedHashMap<String, Integer> m = new java.util.LinkedHashMap<>();
            for (String q : sqls) m.merge(q.length() > 70 ? q.substring(0, 70) + "…" : q, 1, Integer::sum);
            m.forEach((k, v) -> System.out.println("     ×" + v + "  " + k));
            System.out.println("  改完，display_name = " + nameInDb(nid));
            System.out.println("  customer 表有 " + rows("customer") + " 筆");
        } catch (Throwable e) {                       // ★ StackOverflowError 是 Error，不是 Exception
            System.out.println("  🔴 " + rootName(e) + ": " + firstLine(rootMsg(e)));
        } finally {
            CustCb.reset();
        }
    }

    /** 這一節的例外要挖到最底層才看得到真正的原因。 */
    private static Throwable root(Throwable e) {
        while (e.getCause() != null && e.getCause() != e) e = e.getCause();
        return e;
    }
    private static String rootName(Throwable e) { return root(e).getClass().getSimpleName(); }
    private static String rootMsg(Throwable e)  { return root(e).getMessage(); }
    private static String firstLine(String s) {
        if (s == null) return "null";
        int i = s.indexOf('\n');
        String t = i < 0 ? s : s.substring(0, i);
        return t.length() > 130 ? t.substring(0, 130) + "…" : t;
    }
}
```

```
═══ ① @PreUpdate 裡 em.flush()（遞迴 flush） ═══
  🔴 StackOverflowError: null

═══ ② @PreUpdate 裡 em.persist(新實體) ═══
  → 3 句 SQL
     ×1  select cc1_0.id,cc1_0.display_name,cc1_0.email from customer cc1_0 whe…
     ×1  insert into customer (display_name,email,nickname,id) values (?,?,?,?)
     ×1  update customer set display_name=?,email=? where id=?
  改完，display_name = 我改的
  customer 表有 4 筆                        ← ✅ INSERT 進去了

═══ ③ @PostUpdate 裡 em.persist(新實體) ═══
  → 2 句 SQL
     ×1  select cc1_0.id,cc1_0.display_name,cc1_0.email from customer cc1_0 whe…
     ×1  update customer set display_name=?,email=? where id=?
  改完，display_name = 我改的
  customer 表有 3 筆                        ← 🔴🔴 INSERT 靜默不見了

═══ ④ @PostUpdate 裡 em.flush() ═══
  🔴 StackOverflowError: null
     （同時在 log 裡：SQLNonTransientConnectionException:
       Communications link failure during rollback(). Transaction resolution unknown.）
```

**四種寫法，三種不同的失敗模式**：

| | 寫法 | 結果 | 為什麼 |
|---|---|---|---|
| ① | `@PreUpdate` 裡 `flush()` | 🔴 **`StackOverflowError`** | flush → 髒檢查 → `@PreUpdate` → flush → … |
| ② | `@PreUpdate` 裡 `persist()` | ✅ 有效（**但是巧合**） | 新實體排在 `@PreUpdate` 之後的 INSERT 階段，剛好還來得及 |
| ③ | `@PostUpdate` 裡 `persist()` | 🔴🔴 **靜默不見** | `@PostUpdate` 跑的時候，flush 的動作佇列**已經跑完了** |
| ④ | `@PostUpdate` 裡 `flush()` | 🔴 **`StackOverflowError` + 連線壞掉** | 同 ① |

🔴🔴 **③ 是這四個裡最危險的**：**沒有例外、沒有警告、沒有 log，那一列就是不見。**

```
你寫了一個「改單時自動寫一筆稽核」的 @PostUpdate
   → 測試環境跑起來「好像有效」（因為測試常常有第二次 flush 把它帶出去）
   → 上線後某些路徑靜默漏記
   → 三個月後有人問「為什麼稽核表少了一半的紀錄」
```

> ⚠️ **這一節的量測本身有一段值得記的故事。**
>
> ①④ 這兩格，**第一次跑出來的結果是「494 句 SQL、資料沒改到」**——
> 看起來像「遞迴 flush 把同一句 UPDATE 送了 493 次」。
>
> 真相是 `StackOverflowError`，而它被**我自己的測試工具吃掉了**：
> `spy()` 的第一版在 `finally` 裡 `return`（3.2.5 那個註解），
> 而 `finally` 裡的 `return` 會吞掉正在往外拋的 `Throwable`。
>
> 加上 `StackOverflowError` 是 `Error` **不是 `Exception`**，
> 所以連 `catch (Exception e)` 也接不到。
>
> 📌 **兩個一般性的教訓**：
> **① 觀測工具不能改變被觀測對象的行為（包含不能藏例外）。**
> **② 「SQL 打了 N 句」跟「這件事成功了」是兩件不同的事——要分別驗證。**

### 3.9.6 回呼該用來做什麼

```
✅ 該用
   ① 填自己的審計欄位（createdAt / updatedAt / createdBy）
   ② 翻自己的旗標（Persistable 的 isNew，01 章 1.6.6）
   ③ 計算自己的衍生欄位（例如 fullName = firstName + lastName）
   ④ 純粹的驗證（丟例外阻止寫入）—— 但 Bean Validation 更適合（01 章 1.11）

🔴 不該用
   ① 碰 EntityManager（persist / merge / flush / 查詢）★★
   ② 寫另一張表（稽核、事件）→ 用 Spring 的 @TransactionalEventListener
   ③ 呼叫外部系統（寄信、發訊息、HTTP）→ 交易還沒 commit，你可能寄了一封
      「訂單已成立」然後交易回滾了
   ④ 任何需要「一定會執行」的邏輯 → 3.9.3：沒有變更就不會跑
```

**②③ 的正解**（Spring 的交易事件，比回呼安全得多）：

```java
// 實體只【記下】發生了什麼，不做副作用
public void pay() {
    this.status = St3.PAID;
    this.paidAt = Instant.now();
}

// Service 在改完之後發事件
@Transactional
public void pay(UUID id) {
    Ord3 o = orders.findById(id).orElseThrow();
    o.pay();
    events.publishEvent(new OrderPaid(id));         // ApplicationEventPublisher
}

// 監聽者在【commit 之後】才跑 —— 這才是寄信的正確位置
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
public void onPaid(OrderPaid e) {
    mailer.send(e.orderId());
}
```

📌 `AFTER_COMMIT` 保證了「交易真的成功了才做副作用」——
這是 `@PostPersist` / `@PostUpdate` **給不了**的保證（3.7.7：flush 之後還可以 rollback）。

---

## 3.10 把這一章變成可斷言的

00 章 0.10.3 的 `SqlSpy` 讓「打了幾句 SQL」變成一個數字。
這一章需要**第二把尺**：「持久化情境做了什麼」。

### 3.10.1 `PcSpy`

```java
package com.example.lab.ch03;

import jakarta.persistence.EntityManager;
import jakarta.persistence.EntityManagerFactory;
import org.hibernate.SessionFactory;
import org.hibernate.stat.Statistics;

/**
 * 3.10：把「持久化情境做了什麼」變成可以寫進 CI 的數字。
 * 跟 00 章 0.10.3 的 SqlSpy 是兩把不同的尺：
 *   SqlSpy → 真的送到 JDBC 的每一句 SQL（MyBatis / JdbcTemplate 也看得到）
 *   PcSpy  → Hibernate 自己的計數器：flush 幾次、載入幾個實體、更新幾筆
 */
public final class PcSpy {

    private final Statistics stats;

    public PcSpy(EntityManagerFactory emf) {
        this.stats = emf.unwrap(SessionFactory.class).getStatistics();
    }

    public void reset() { stats.clear(); }

    public long flushes()         { return stats.getFlushCount(); }
    public long entityLoads()     { return stats.getEntityLoadCount(); }
    public long entityFetches()   { return stats.getEntityFetchCount(); }
    public long collectionLoads() { return stats.getCollectionLoadCount(); }
    public long inserts()         { return stats.getEntityInsertCount(); }
    public long updates()         { return stats.getEntityUpdateCount(); }
    public long deletes()         { return stats.getEntityDeleteCount(); }
    public long statements()      { return stats.getPrepareStatementCount(); }

    public String summary() {
        return String.format(
            "flush=%d  load=%d  fetch=%d  collLoad=%d  insert=%d  update=%d  delete=%d  stmt=%d",
            flushes(), entityLoads(), entityFetches(), collectionLoads(),
            inserts(), updates(), deletes(), statements());
    }

    /** 檢查：PC 裡不該還有沒 flush 的髒實體。 */
    public static void assertNothingDirty(EntityManager em) {
        if (em.unwrap(org.hibernate.Session.class).isDirty()) {
            throw new AssertionError("持久化情境裡還有髒實體沒有 flush");
        }
    }
}
```

要打開它，`application.yml` 需要一行（3.2.5 已經加了）：

```yaml
spring:
  jpa:
    properties:
      hibernate:
        generate_statistics: true
```

⚠️ **這是全域統計，不是「這個交易」的統計**——所以每次量之前要 `reset()`，
而且**不能平行跑測試**。

### 3.10.2 實測：兩把尺對得上

```java
package com.example.lab.ch03;

import jakarta.persistence.EntityManagerFactory;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import static org.junit.jupiter.api.Assertions.assertEquals;

class B2PcSpy extends Base03 {

    @Autowired EntityManagerFactory emf;
    @Autowired TxSvc svc;

    @Test
    void 兩把尺量同一件事() {
        seed();
        PcSpy pc = new PcSpy(emf);

        head("場景：撈一張訂單、讀它的明細、改狀態");
        pc.reset();
        var sqls = spy(() -> tx.executeWithoutResult(s -> {
            Ord3 o = orders.findById(oid).orElseThrow();
            o.getItems().size();
            o.setStatus(St3.PAID);
        }));
        System.out.println("  SqlSpy : " + sqls.size() + " 句");
        sqls.forEach(q -> System.out.println("     " + q));
        System.out.println("  PcSpy  : " + pc.summary());

        head("兩把尺對得上嗎");
        System.out.println("  SqlSpy 句數        = " + sqls.size());
        System.out.println("  PcSpy  statements  = " + pc.statements());
        assertEquals(sqls.size(), pc.statements());
        System.out.println("  ✅ 對得上");
    }
}
```

```
═══ 場景：撈一張訂單、讀它的明細、改狀態 ═══
  SqlSpy : 3 句
     select o1_0.id,… from orders o1_0 where o1_0.id=?
     select i1_0.order_id,… from order_item i1_0 where i1_0.order_id=?
     update orders set currency=?,… where id=?
  PcSpy  : flush=1  load=2  fetch=0  collLoad=1  insert=0  update=1  delete=0  stmt=3

═══ 兩把尺對得上嗎 ═══
  SqlSpy 句數        = 3
  PcSpy  statements  = 3
  ✅ 對得上
```

**兩把尺各自看得到什麼**：

| | `SqlSpy` | `PcSpy`（Hibernate Statistics） |
|---|---|---|
| JPA 的 SQL | ✅ | ✅ |
| **MyBatis / JdbcTemplate 的 SQL** | ✅ | 🔴 看不到 |
| **flush 了幾次** | 🔴 推不出來 | ✅ |
| **SQL 是「載入實體」還是「載入集合」** | 🔴 要自己讀 SQL 猜 | ✅ `load` vs `collLoad` |
| 批次的真實筆數 | ✅（`[batch ×N]`） | ⚠️ 部分 |

📌 **兩把都要用**：
`SqlSpy` 回答「總共打了幾句」（唯一能公平比較 JPA 與 MyBatis 的尺，00 章 0.7），
`PcSpy` 回答「**為什麼**打了那麼多句」——這在 04 章診斷 N+1 時是決定性的。

### 3.10.3 五條可以寫進 CI 的斷言

```java
    @Test
    void 五條可以寫進CI的斷言() {
        seed();
        PcSpy pc = new PcSpy(emf);

        head("斷言一：一個用例只 flush 一次");
        pc.reset();
        tx.executeWithoutResult(s -> orders.findById(oid).orElseThrow().setStatus(St3.PAID));
        System.out.println("  flush 次數 = " + pc.flushes());
        assertEquals(1, pc.flushes());

        head("斷言二：唯讀用例一句 UPDATE 都不能有");
        pc.reset();
        svc.readOnly(em0 -> em0.find(Cust3.class, cid).rename("唯讀交易裡亂改"));
        System.out.println("  update = " + pc.updates() + "、flush = " + pc.flushes());
        assertEquals(0, pc.updates());

        head("斷言三：新增一筆不該有 SELECT");
        pc.reset();
        var sqls = spy(() -> tx.executeWithoutResult(s ->
                em.persist(new Cust3(com.example.lab.Uuid7.next(), "ci@x.com", "CI"))));
        long selects = sqls.stream().filter(q -> q.startsWith("select")).count();
        System.out.println("  SELECT 句數 = " + selects + "、insert = " + pc.inserts());
        assertEquals(0, selects);

        head("斷言四：撈 N 張訂單，collectionLoad 不能等於 N（那就是 N+1）");
        pc.reset();
        tx.executeWithoutResult(s -> {
            var all = em.createQuery("select o from Ord3 o", Ord3.class).getResultList();
            for (Ord3 o : all) o.getItems().size();
            System.out.println("  訂單數 = " + all.size()
                    + "、collectionLoad = " + pc.collectionLoads());
        });
        System.out.println("  📌 04 章要修的就是這一條");

        head("斷言五：交易結束時不該還有髒實體");
        tx.executeWithoutResult(s -> {
            orders.findById(oid).orElseThrow().setStatus(St3.PACKED);
            em.flush();
            PcSpy.assertNothingDirty(em);
            System.out.println("  ✅ flush 過了，沒有髒實體");
        });
    }
```

```
═══ 斷言一：一個用例只 flush 一次 ═══
  flush 次數 = 1

═══ 斷言二：唯讀用例一句 UPDATE 都不能有 ═══
  update = 0、flush = 0

═══ 斷言三：新增一筆不該有 SELECT ═══
  SELECT 句數 = 0、insert = 1

═══ 斷言四：撈 N 張訂單，collectionLoad 不能等於 N（那就是 N+1） ═══
  訂單數 = 1、collectionLoad = 1
  📌 04 章要修的就是這一條

═══ 斷言五：交易結束時不該還有髒實體 ═══
  ✅ flush 過了，沒有髒實體
```

**這五條各自在防什麼**：

| 斷言 | 防的是 | 對應本章 |
|---|---|---|
| ① `flushes() == 1` | 迴圈裡 flush、`COMMIT` 模式被亂設 | 3.7.1、3.7.7 |
| ② 唯讀用例 `updates() == 0` | 「查詢方法偷偷寫了東西」 | 3.4.7 |
| ③ 新增沒有 `SELECT` | `Persistable` 被拿掉、實體改成用 `merge` | 3.6.3 |
| ④ `collectionLoads()` vs 筆數 | **N+1** | 04 章 |
| ⑤ 結束時不髒 | 「以為改了，其實那個物件是 detached」 | 3.5.5 |

📌 **④ 是這五條裡最有價值的一條，而它是 04 章的主題**：
`collectionLoad = 訂單數` 就是 N+1 的**定義**。
`SqlSpy` 只會告訴你「251 句」，`PcSpy` 會告訴你「250 次 collectionLoad」——
**後者直接指出兇手是哪一個集合。**

---

## 3.11 shop-service 的落地

前面十節每一節都在指出「什麼會出錯」。這一節把它們合成**四條規則**與**一份程式碼**。

### 3.11.1 四條規則

```
① 交易邊界在 Service 的 public 方法上，一個用例一個交易      （3.8.5）
② 改資料 = 撈出 managed 實體 + 呼叫它的業務方法。
   不用 save、不用 merge                                    （3.4.1、3.6.5）
③ 新增資料 = persist（實體實作 Persistable，save() 就是 persist）（3.6.3）
④ 出資料層的是 DTO，實體不離開交易                            （3.5.5、3.8.7）
```

⚠️ **② 的完整意思是：整個 Service 類別裡，`save()` 只會出現在「新增」的路徑上。**

### 3.11.2 `OrderView`：出去的東西

```java
package com.example.lab.shop;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/** 出資料層的是這個，不是 Order（02 章 2.10.5、本章規則四）。 */
public record OrderView(
        UUID id, String orderNo, String customerName,
        OrderStatus status, BigDecimal totalAmount, Instant placedAt,
        List<Line> lines) {

    public record Line(String productName, int qty, BigDecimal lineAmount) {}

    static OrderView of(Order o) {
        return new OrderView(
                o.getId(), o.getOrderNo(), o.getCustomer().getDisplayName(),
                o.getStatus(), o.getTotalAmount(), o.getPlacedAt(),
                o.getItems().stream()
                        .map(i -> new Line(i.getProductName(), i.getQty(), i.getLineAmount()))
                        .toList());
    }
}
```

📌 **`of()` 是 package-private 的**：只有同套件（資料層）叫得到它，
所以「把實體轉成 DTO」這件事一定發生在資料層裡面、也就是**交易裡面**。

### 3.11.3 `OrderService`：整個類別沒有一次 `save()` 用在更新上

這裡用的是 01 章 1.16 與 02 章 2.12 定案的那組 `shop` 實體
（`BaseEntity` 實作 `Persistable`、`Order.addItem` 守不變量、`Order` 的 `items`
是 `cascade = ALL, orphanRemoval = true`）：

```java
package com.example.lab.shop;

import jakarta.persistence.EntityManager;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.UUID;

/**
 * 03 章 3.11 的落地。四條規則：
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
        Customer c = customers.getReferenceById(customerId);   // 不需要真的撈出來（3.3.5）
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

    /** ④ 讀：唯讀交易（不建快照、flush mode MANUAL），回傳 DTO。 */
    @Transactional(readOnly = true)
    public OrderView view(UUID orderId) {
        Order o = orders.findById(orderId)
                .orElseThrow(() -> new IllegalArgumentException("訂單不存在：" + orderId));
        return OrderView.of(o);        // ★ 在交易裡就轉成 DTO，關聯還讀得到
    }

    private Order order(UUID id) {
        return orders.findById(id)
                .orElseThrow(() -> new IllegalArgumentException("訂單不存在：" + id));
    }
}
```

### 3.11.4 驗收：四個用例各打幾句 SQL

```java
package com.example.lab.ch03;

import com.example.lab.SqlSpy;
import com.example.lab.Uuid7;
import com.example.lab.shop.*;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;

@SpringBootTest(properties = {
  "spring.datasource.url=jdbc:mysql://127.0.0.1:33306/shop"
      + "?connectionTimeZone=UTC&forceConnectionTimeZoneToSession=true"
      + "&preserveInstants=true&characterEncoding=UTF-8"
})
class B1Service {

    @Autowired OrderService service;
    @Autowired CustomerRepository customers;
    @Autowired ProductRepository products;
    @Autowired JdbcTemplate jdbc;

    private UUID cid, pid, pid2;

    private void seed() {
        jdbc.update("DELETE FROM order_item");
        jdbc.update("DELETE FROM orders");
        jdbc.update("DELETE FROM stock");
        jdbc.update("DELETE FROM product");
        jdbc.update("DELETE FROM customer");
        cid = Uuid7.next(); pid = Uuid7.next(); pid2 = Uuid7.next();
        customers.save(new Customer(cid, "ming@x.com", "小明"));
        products.save(new Product(pid, "SKU-1", "機械鍵盤", new BigDecimal("100.0000")));
        products.save(new Product(pid2, "SKU-2", "滑鼠", new BigDecimal("50.0000")));
    }

    private List<String> spy(Runnable r) {
        SqlSpy.start();
        try { r.run(); return SqlSpy.stop(); }
        catch (RuntimeException | Error e) { SqlSpy.stop(); throw e; }
    }

    @Test
    void 四個用例各打幾句SQL() {
        seed();
        UUID oid = Uuid7.next();

        dump("place（新增一張訂單 + 1 筆明細）", spy(() ->
                service.place(oid, "SO-2026-0001", cid, pid, 2, Uuid7.next())));
        dump("addItem（加第二筆明細）", spy(() ->
                service.addItem(oid, pid2, 1, Uuid7.next())));
        dump("pay（改狀態）", spy(() -> service.pay(oid)));

        final OrderView[] v = new OrderView[1];
        dump("view（回傳 DTO）", spy(() -> v[0] = service.view(oid)));
        System.out.println("  DTO : " + v[0]);
    }

    @Test
    void DTO在交易外面用不會炸() {
        seed();
        UUID oid = Uuid7.next();
        service.place(oid, "SO-2026-0002", cid, pid, 2, Uuid7.next());
        OrderView v = service.view(oid);
        System.out.println("\n═══ 交易已經結束，在外面用這個 DTO ═══");
        System.out.println("  客戶     : " + v.customerName());
        System.out.println("  明細筆數  : " + v.lines().size());
        System.out.println("  ✅ 沒有 LazyInitializationException");
    }

    private void dump(String title, List<String> sqls) {
        System.out.println("\n═══ " + title + " → " + sqls.size() + " 句 SQL ═══");
        int i = 1;
        for (String q : sqls) System.out.println("  " + (i++) + ") "
                + (q.length() > 150 ? q.substring(0, 150) + "…" : q));
    }
}
```

```
═══ place（新增一張訂單 + 1 筆明細） → 3 句 SQL ═══
  1) select p1_0.id,p1_0.is_active,p1_0.name,p1_0.sku,p1_0.unit_price,p1_0.version
       from product p1_0 where p1_0.id=?
  2) insert into orders (currency,customer_id,discount_amount,order_no,paid_at,placed_at,
       status,total_amount,version,id) values (?,?,?,?,?,?,?,?,?,?)
  3) insert into order_item (line_amount,order_id,product_id,product_name,qty,unit_price,id)
       values (?,?,?,?,?,?,?)

═══ addItem（加第二筆明細） → 4 句 SQL ═══
  1) select p1_0.id,… from product p1_0 where p1_0.id=?
  2) select o1_0.id,… from orders o1_0 where o1_0.id=?
  3) insert into order_item (…) values (?,?,?,?,?,?,?)
  4) update orders set currency=?,…,version=? where id=? and version=?

═══ pay（改狀態） → 2 句 SQL ═══
  1) select o1_0.id,… from orders o1_0 where o1_0.id=?
  2) update orders set currency=?,…,version=? where id=? and version=?

═══ view（回傳 DTO） → 3 句 SQL ═══
  1) select o1_0.id,… from orders o1_0 where o1_0.id=?
  2) select c1_0.id,c1_0.created_at,c1_0.display_name,c1_0.email,c1_0.version
       from customer c1_0 where c1_0.id=?
  3) select i1_0.order_id,i1_0.id,… from order_item i1_0 where i1_0.order_id=?
  DTO : OrderView[id=01a07af5-…, orderNo=SO-2026-0001, customerName=小明, status=PAID,
        totalAmount=250.0000, placedAt=2026-09-07T08:22:11.298Z,
        lines=[Line[productName=機械鍵盤, qty=2, lineAmount=200.0000],
               Line[productName=滑鼠, qty=1, lineAmount=50.0000]]]

═══ 交易已經結束，在外面用這個 DTO ═══
  客戶     : 小明
  明細筆數  : 1
  ✅ 沒有 LazyInitializationException
```

**逐個確認**：

| 用例 | 句數 | 檢查 |
|---|---|---|
| `place` | **3** | ✅ 沒有那句多餘的 `SELECT`（`Persistable` 生效，3.6.3）。`customer` 用 `getReferenceById` → 沒有撈客戶 |
| `addItem` | 4 | ✅ 撈商品 + 撈訂單 + INSERT 明細 + UPDATE 總額（`totalAmount` 是存的，07 站不變量 #3） |
| `pay` | **2** | ✅ 一個 `SELECT` 一個 `UPDATE`。**沒有 `save()` 卻寫了**（3.4.1） |
| `view` | 3 | ⚠️ **見下** |

🔴 **`view` 的 3 句是這一節唯一還沒解決的問題**：

```
1) SELECT orders     ← 主查詢
2) SELECT customer   ← OrderView.of() 讀了 o.getCustomer().getDisplayName()
3) SELECT order_item ← OrderView.of() 讀了 o.getItems()
```

**這是「一張訂單 3 句」。如果是「列出 50 張訂單」呢？**

```
1 + 50 + 50 = 101 句     ← 這就是 00 章 0.3.2 那個 251 句的形狀
```

📌 **而它不是一個 bug，它是一個「還沒最佳化」的狀態**——
`view` 現在的正確性是 100% 的（DTO 在交易外可以用、關聯都讀到了），
它只是**每個關聯各打一句**。

> **04 章要做的事，就是把這 3 句變成 1 句**（`JOIN FETCH` / `@EntityGraph`），
> 並且用 3.10.3 的斷言四把它**釘在 CI 裡**，讓它不會偷偷長回 101 句。

### 3.11.5 四個反例

把這一章的坑寫成四段「看起來很正常」的程式碼，逐個對照它們錯在哪：

```java
// ❌ 反例一：忘了 @Transactional
public void pay(UUID orderId) {                         // 沒有 @Transactional
    Order o = orders.findById(orderId).orElseThrow();   // 交易 1，結束後 detached
    o.pay();                                             // 改一個沒人管的物件
}                                                        // 靜默什麼都沒發生（3.2.4、3.8.5）

// ❌ 反例二：用 DTO 建實體再 save
@Transactional
public void rename(UUID id, RenameRequest req) {
    Customer c = new Customer(id, req.email(), req.displayName());
    customers.save(c);          // → merge → 你沒設的欄位全部變 null（3.6.5）
}

// ❌ 反例三：回傳實體給上層
@Transactional(readOnly = true)
public Order find(UUID id) {
    return orders.findById(id).orElseThrow();
}
// 上層碰 o.getItems() → LazyInitializationException（3.5.5、3.8.7）
// 上層改 o.setStatus(...) → 靜默無效（3.5.5 症狀三）
// 上層丟給 Jackson → 02 章 2.10 的三個錯誤

// ❌ 反例四：在交易裡吃掉資料庫例外然後繼續
@Transactional
public void register(String email) {
    try {
        customers.save(new Customer(Uuid7.next(), email, email));
        em.flush();
    } catch (DataIntegrityViolationException e) {
        log.warn("email 重複，跳過");     // 交易已經是 rollback-only 了
    }
    stats.increment();                    // 這一行【一定會白做】
}                                          // commit 時 UnexpectedRollbackException（3.8.6）
```

**四個反例的共同點**：

```
它們都【編譯得過】、都【不報錯】（除了反例四是在很後面才報）、
在「只有一筆資料、只有一條路徑」的測試裡都【看起來會過】。

而它們錯的地方，全部在「持久化情境」這一層 ——
也就是你的程式碼裡沒有任何一行提到的那一層。
```

---

## 3.12 常見誤區

**誤區一：「改完要記得 `save()`，不然不會寫進去。」**

🔴 反了。managed 實體改完**不需要** `save()`（3.4.1），
而對 detached 實體呼叫 `save()` 反而會**吃掉你沒設的欄位**（3.6.5）。

正確的心智模型是：**「這個實體是 managed 的嗎？」**

```
是 managed  → 改完就好，不用 save
是 detached → 不要 save 它，去撈一個 managed 的來改
```

---

**誤區二：「`save()` 就是 `INSERT`，`saveAndFlush()` 才會馬上寫。」**

🔴 `save()` 是 `persist` **或** `merge`（3.6.4），而它**兩者都不保證馬上寫**——
真正的 SQL 在 flush 的時候（3.7.1）。

而 `saveAndFlush()` 只是幫你多叫一次 `flush()`，
**它不會 commit**（3.7.7），而且會讓你提早拿鎖。

---

**誤區三：「一級快取會讓資料變舊，所以應該關掉它。」**

🔴 它不能關（3.3.7）。而且它「讓資料變舊」是**刻意的**：
它保證「同一個交易、同一個 id → 同一個物件」（3.3.1），
那個保證比「看到最新的值」重要——沒有它，你手上會有兩個代表同一列的物件。

要看新的值，用 `em.refresh()`。而如果 `refresh` 也給你舊值，
問題在資料庫的隔離等級，不在 JPA（3.3.4）。

---

**誤區四：「JPQL 會重新查資料庫，所以它一定拿到最新的值。」**

🔴 **它會重新查，但不會重新填你的物件**（3.3.3）。
資料庫回的那一列在「這個 id 已經在快取裡」時會被丟掉。

判斷方法：**同一句查詢改成投影（`select c.displayName`）**。
投影拿到新值、實體拿到舊值 → 那就是一級快取在騙你。

---

**誤區五：「`UPDATE` 更新了所有欄位，一定是我哪裡寫錯了。」**

🔴 那是**預設行為**（3.4.6）。Hibernate 的 `UPDATE` 語句在啟動時就準備好了，
永遠包含全部欄位。

要看「到底改了什麼」，看髒屬性（`Pc.dirtyProps`）或參數值，
**不要看 SQL 的欄位列表**。而 3.6.5 證明了：**資料遺失的 SQL 跟正確的 SQL 一字不差。**

---

**誤區六：「`BigDecimal` 的 scale 不一致會造成無意義的 `UPDATE`。」**

🔴 實測是 **0 句 SQL**（3.4.5）。Hibernate 6 的 `BigDecimal` 髒檢查用 `compareTo`，不是 `equals`。

⚠️ 但 `BigDecimal` 的 `precision`/`scale` 跟 DB 不一致，
**寫入時會被靜默四捨五入**（01 章 1.10.1）——那是**另一件事**，而它是真的。

---

**誤區七：「`flush()` 之後資料就安全了。」**

🔴 `flush` 不是 `commit`（3.7.7）。SQL 送出去了，但還在交易裡，
任何後續的例外都會讓它全部回滾。

而 `flush` 有一個**真的**副作用：**它會拿鎖**，
所以提早 flush = 鎖持有時間變長 = 併發變差。

---

**誤區八：「SQL 是按我程式碼的順序送出去的。」**

🔴 順序是固定的：`orphan → INSERT → UPDATE → 集合 → DELETE`（3.7.5）。
所以「先刪再插同一個唯一鍵」會撞唯一鍵（3.7.6）。

---

**誤區九：「在 `@PostPersist` 裡寫稽核日誌很方便。」**

🔴 三個問題：
① `em.persist` 在 `@PostUpdate` / `@PostPersist` 裡會**靜默不生效**（3.9.5 的 ③）；
② `em.flush` 在裡面會 `StackOverflowError`（3.9.5 的 ①④）；
③ 「設回同一個值」不會觸發 `@PreUpdate`，所以會**漏記**（3.9.3）。

正解是 `@TransactionalEventListener(AFTER_COMMIT)`（3.9.6）。

---

**誤區十：「`@Transactional` 加了就有交易。」**

🔴 三個例外：
① 加在 `private` 方法上 → 沒效果；
② **同類別自我呼叫** → 代理沒被經過 → 沒效果（3.4.7 那個踩到的坑）；
③ 上層已經有交易 → 你的 `readOnly`、`timeout`、`rollbackFor` **全部被忽略**（3.8.2）。

---

**誤區十一：「把實體傳到 `REQUIRES_NEW` 的方法裡改，比較安全。」**

🔴 那個實體在內層是 **detached**（3.8.3），改了什麼都不會發生。

規則：**跨交易邊界只傳 id 與不可變值。**

---

**誤區十二：「`open-in-view = true` 比較方便，關掉只是為了效能。」**

🔴 關掉它的主要理由**不是效能，是可觀測性**（3.8.7）：
開著的時候，「哪些 SQL 會被打出來」由 Jackson 的序列化過程決定——
那是你看不見、也測不到的地方。

**關掉它，N+1 會在開發的第一天就炸給你看，而不是上線後。**

---

## 3.13 本章小結

**一句話**：

> **JPA 的核心不是「幫你寫 SQL」，是「一個交易期間，替你保管一群物件，
> 並在某個時間點自己決定要寫什麼」。**
> **這一章的 40 個實測，全部是「那個時間點」與「自己決定」造成的。**

**四個機制與它們各自的坑**：

```
一級快取（3.3）
   保證：同一交易、同一 id → 同一物件
   坑  ：JPQL 查了資料庫，但回傳快取裡的舊物件 ★★
         快取不知道外面的世界，而 refresh 只解得掉【一層】

髒檢查（3.4）
   保證：改了物件就會寫回去，不用 save
   坑  ：比對是在 flush 時做的、預設寫全部欄位、
         成本 = O(PC 裡的實體數) ★★

生命週期（3.5、3.6）
   保證：managed 的實體改了就會寫回去
   坑  ：transient 與 detached 從物件本身分不出來 ★★
         merge 回傳的不是你傳進去的、而且會用 null 覆蓋你沒設的欄位 ★★

flush（3.7）
   保證：交易 commit 前一定會寫出去
   坑  ：順序固定、不是你的程式碼順序 ★★
         JdbcTemplate / MyBatis 不觸發它
         它不是 commit，而且它會拿鎖
```

**這一章回答了前面留下的七個問題**：

| 哪裡留的 | 答案在 |
|---|---|
| 00 章 0.3.1：沒呼叫 `save()`，資料卻改了 | **3.4.1** 髒檢查 |
| 00 章 0.3.3：`save()` 一筆全新資料多一句 `SELECT` | **3.6.3、3.6.4** `save()` = `persist` 或 `merge` |
| 00 章 0.3.4：實體離開交易就不能用 | **3.5.5** detached 的三個症狀 |
| 00 章 0.9 規則二：JPA 寫完要 `flush` 才輪到 MyBatis | **3.7.2、3.7.3** 只有走 Hibernate 的查詢會觸發 flush |
| 02 章 2.4.1：集合過不過時，取決於幾行之前 | **3.3.6** PC 也管集合的初始化狀態 |
| 02 章 2.6.3：`clear()` 重建 = 5 刪 5 插 | **3.4.2** diff 的單位是「物件實例」 |
| 02 章 2.6.3：設回同一個值 → 0 句 `UPDATE` | **3.4.4** 快照比對用型別的 `areEqual` |

### 3.13.1 驗收清單

**觀念**

- [ ] 說出持久化情境是什麼、誰建立它、活多久（3.2）
- [ ] 說出注入的 `EntityManager` 為什麼是一個代理，以及它跟 `SessionImpl` 的關係（3.2.2）
- [ ] 說出一級快取的核心保證與它「不走快取」的三種查詢（3.3.2）
- [ ] 解釋為什麼 JPQL 查了資料庫卻回傳舊物件，而這**不是** bug（3.3.3）
- [ ] 區分「一級快取騙你」與「InnoDB 快照騙你」，並說出各自的判準與解法（3.3.4）
- [ ] 說出髒檢查比對什麼、什麼時候比對、成本怎麼成長（3.4）
- [ ] 說出四種狀態，以及為什麼 transient 與 detached 從物件本身分不出來（3.5.3）
- [ ] 說出 `persist` 與 `merge` 的五個差異（3.6）
- [ ] 說出 flush 的三個時機、以及哪些查詢**不會**觸發它（3.7.2）
- [ ] 說出 Hibernate 送 SQL 的固定順序，以及它造成的唯一鍵衝突（3.7.5、3.7.6）

**動手**

- [ ] 用 `Pc.state()` 印出一個實體走完 transient → managed → removed → detached 的每一步
- [ ] 重現一次「一級快取騙你」，並用投影查詢證明資料庫回的是新值（3.3.3）
- [ ] 重現一次「`merge` 把 `nickname` 清成 null」，並改成正解（3.6.5）
- [ ] 重現一次「先刪再插同一個唯一鍵」，並用 `em.flush()` 修掉（3.7.6）
- [ ] 量一次「PC 裡 100 / 1000 / 20000 個實體時，一次髒檢查多久」（3.4.8）
- [ ] 把 3.10.3 的五條斷言寫進你自己的專案，讓它們在 CI 裡跑

**能不用查資料就回答**

- [ ] `em.merge(x)` 之後，`x` 是什麼狀態？
- [ ] 一個 `@Transactional(readOnly = true)` 的方法裡改了實體，會發生什麼？
- [ ] `em.remove(detachedEntity)` 會發生什麼？
- [ ] 程式碼寫 `remove(a); persist(b);`，SQL 的順序是什麼？
- [ ] `@PostUpdate` 裡呼叫 `em.persist(new Foo())`，那一列會進資料庫嗎？

### 3.13.2 本章練習

**練習一（★）：狀態偵測器**

`Pc.state()` 用了 Hibernate 的內部 SPI。
寫一個**只用 JPA 標準 API** 的版本，並列出它**分辨不出**的情況。

```java
public static String stateJpaOnly(EntityManager em, Object entity) {
    // 只能用 em.contains() 與實體自己的 getter
    // 提示：至少有兩組狀態它分不出來
}
```

<details>
<summary>提示</summary>

`em.contains()` 只能區分「在 PC 裡」與「不在」。
`managed` 與 `removed` **都在** PC 裡（`contains` 都回 `true`）；
`transient` 與 `detached` **都不在**（都回 `false`）。

所以標準 API 能分出的只有兩組，不是四種。
而要在「應用端指定主鍵」的專案裡分出 transient / detached，
唯一的辦法是實體自己記（`Persistable.isNew()`，01 章 1.6.6）。

</details>

**練習二（★★）：把 3.6.5 那個 bug 變成一個會失敗的測試**

寫一個測試，證明「用 DTO 建實體再 `save()`」會清掉未提及的欄位。
然後寫一個 ArchUnit 規則，讓**任何**新的 `em.merge` 呼叫在 CI 裡失敗。

<details>
<summary>提示</summary>

測試的關鍵是**比對「改之前」與「改之後」那一列的每一個欄位**，
而不是看 SQL——因為 3.6.5 證明了兩者的 SQL 一字不差。

```java
Map<String, Object> before = jdbc.queryForMap("SELECT * FROM customer WHERE id=?", bytes);
// … 執行那個「改名 API」
Map<String, Object> after  = jdbc.queryForMap("SELECT * FROM customer WHERE id=?", bytes);
// 斷言：除了 display_name，其他欄位都要一樣
```

</details>

**練習三（★★）：找出你專案裡的 detached 修改**

寫一個測試工具，在**交易結束前**檢查「有沒有實體被改了但不在 PC 裡」。

<details>
<summary>提示</summary>

這件事**沒有**通用解法（detached 物件本來就不在 PC 裡，你無從列舉它們）。
可行的方向有兩個：

**① 反過來檢查**：用 `PcSpy.assertNothingDirty(em)` 在交易結束前確認
「PC 裡沒有未 flush 的髒實體」——這抓不到 detached 的修改，但抓得到「忘了 flush」。

**② 結構性防護（本課的選擇）**：ArchUnit 規則
「Service 的 public 方法不得回傳實體型別」。
detached 修改的根源是「實體離開了交易」——**在源頭擋掉比事後偵測可行得多。**

```java
@ArchTest
static final ArchRule Service不得回傳實體 = methods()
    .that().areDeclaredInClassesThat().resideInAPackage("..service..")
    .and().arePublic()
    .should().notHaveRawReturnType(
        DescribedPredicate.describe("被 @Entity 標註的型別",
            c -> c.isAnnotatedWith(jakarta.persistence.Entity.class)));
```

</details>

**練習四（★★★）：flush 順序的第三個受害者**

3.7.6 示範了「先刪再插同一個唯一鍵」。
**再找出兩個**被 `INSERT → UPDATE → DELETE` 這個固定順序咬到的場景，
各寫一個會失敗的測試，並提出解法。

<details>
<summary>提示</summary>

方向一：**「把明細從 A 訂單搬到 B 訂單」**，而 `(order_id, product_id)` 上有唯一鍵。
（02 章 2.3.3 已經測過搬移，把唯一鍵加上去就會撞。）

方向二：**「交換兩列的唯一值」**——把訂單 A 的 `order_no` 給 B、B 的給 A。
兩句 `UPDATE`，不管誰先跑都會中途撞唯一鍵。
這一個連 `em.flush()` 都救不了，正解是「先改成一個暫時值」三步走，
或是重新想「為什麼業務編號需要互換」。

方向三：**軟刪除 + 唯一索引**（01 章 1.8.3）。
「刪掉舊的、建一個同 email 的新的」，在軟刪除下變成「UPDATE 舊的 + INSERT 新的」——
而 `UPDATE` 排在 `INSERT` **後面**，所以照樣撞。

</details>

**練習五（★★★）：一個 250 ms 的謎題**

某支 API 在正式環境要 250 ms，但它只打了 **3 句** SQL，
而那 3 句在資料庫上加起來只有 4 ms。剩下的 246 ms 在哪裡？

<details>
<summary>提示</summary>

用 3.10 的兩把尺一起看。幾個本章提到的候選：

```
① PC 裡有幾個實體？（3.4.8：20000 個 → 一次髒檢查 1.5 ms，而如果它 flush 了很多次…）
② flush 了幾次？（PcSpy.flushes()。迴圈裡改東西 + 迴圈裡查詢 = 每圈一次 flush）
③ entityLoads 是多少？3 句 SQL 可以載入 20000 個實體（一句 select 全表）
④ 那 3 句是不是有一句 join 出了笛卡兒積？（02 章 2.8.3：SQL 只有 1 句，
   但回來 10000 列、組出 10000 個物件、每個都進 PC、每個都建快照）
```

📌 這個練習的重點：**「SQL 句數」不是唯一的成本**。
把實體放進持久化情境本身有成本，而它跟句數無關。

</details>

---

## 3.14 下一章預告

**04 章：延遲載入與 N+1（核心章）。**

這一章結束時，3.11.4 留下了一個明確的缺口：

```
view（一張訂單）→ 3 句 SQL
   1) SELECT orders
   2) SELECT customer      ← 讀 o.getCustomer().getDisplayName() 打的
   3) SELECT order_item    ← 讀 o.getItems() 打的

而「列出 50 張訂單」= 1 + 50 + 50 = 101 句
   「列出 250 張」 = 501 句     ← 00 章 0.3.2 那個 251 句就是這個形狀
```

📌 **而現在你有了修它需要的每一個概念**：

| 04 章要用的 | 這一章哪裡講的 |
|---|---|
| 代理是什麼、什麼時候初始化 | 3.3.5 |
| 為什麼「碰過的集合不會再更新」 | 3.3.6 |
| `LazyInitializationException` 的真正原因 | 3.5.5、3.8.7 |
| 怎麼量「是幾個集合被逐一載入」 | 3.10.3 斷言四 |
| 為什麼 `open-in-view = false` 能讓 N+1 提早爆 | 3.8.7 |

**04 章要處理的五件事**：

```
① fetch 策略的四種預設值（02 章 2.7 講了「是什麼」，04 章講「怎麼繞過它」）
② LazyInitializationException 的【三種解法】，以及為什麼其中兩種是錯的
③ JOIN FETCH：一句解決，但它跟【分頁】放在一起會出事 ★★
④ @EntityGraph：把「這個用例要撈哪些關聯」從查詢裡搬出來
⑤ @BatchSize：不消滅 N+1，而是把 251 句變成 3 句
```

⚠️ **04 章會有一個這一章沒有的東西：一張「怎麼選」的決策表。**

因為 N+1 的解法不是唯一的——`JOIN FETCH`、`@EntityGraph`、`@BatchSize`、
DTO 投影（05 章）、二級快取（06 章）**各自解決不同形狀的 N+1**，
而選錯的代價是：**你以為修好了，實際上把 251 句 SQL 換成了一句撈回 10000 列的查詢。**

📌 **而 05 章會再回頭問一個更根本的問題**：

> 這個列表頁，**真的需要「實體」嗎？**
> 如果它只是要顯示 6 個欄位，把 50 張訂單 + 400 筆明細變成物件、
> 放進持久化情境、建 450 份快照——**這些工作有任何價值嗎？**

**那就是 05 章 DTO 投影要回答的。**
