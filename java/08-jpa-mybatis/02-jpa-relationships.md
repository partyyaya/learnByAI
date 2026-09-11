# 第 02 章：關聯映射

> 01 章結束時，`Order` 裡有這麼一行：
>
> ```java
> @OneToMany(mappedBy = "order", cascade = CascadeType.ALL, orphanRemoval = true)
> private List<OrderItem> items = new ArrayList<>();
> ```
>
> **這一行有四個決定，而 01 章把它抄下來、一個都沒有解釋。**
>
> ⚠️ 這一章要做的，不是「介紹四個註解參數」。
> 而是證明一件事：
>
> > **這四個決定裡，每一個選錯都會產生一個「不報錯、但資料是錯的」結果。**
>
> 這一章有**九個實測**：
>
> - 少寫一行 `item.setOrder(this)`，明細**一筆都沒進資料庫**
> - 同一段程式碼，**「之前有沒有碰過那個集合」決定了它看不看得到新資料**
> - 沒設 `cascade`，`save(order)` **成功了，而明細靜默不見**
> - 設了 `cascade = ALL` 但沒設 `orphanRemoval`，從集合移除一筆明細——**什麼都沒發生**
> - 改一筆明細的數量，寫法一：**14 句 SQL**；寫法二：**3 句**
> - `@ManyToOne` 不寫 `fetch`，撈 1 筆明細打出 **3 句 SQL**
> - `@OneToOne` 寫了 `LAZY`——**而它沒有生效**
> - 兩個 `List` 一起 `join fetch` → **`MultipleBagFetchException`**
> - `@ManyToMany` 移除一個標籤：`Set` 版 **3 句**、`List` 版 **7 句**（先全刪再重插）
>
> 📌 這一章的主線：
>
> > **關聯映射的本質，是「一個資料庫外鍵」與「兩個 Java 欄位」之間的落差。**
> > **資料庫只有一個 `order_id`；Java 有 `order.items` 與 `item.order` 兩個方向。**
> > **這一章所有的坑，都是這個落差造成的。**

---

## 2.1 學習目標

完成本章後，你應該可以：

- 說出**擁有方（owning side）**是什麼，並指出 `mappedBy` 這個字**真正的意思**。
- 用實測解釋為什麼「只 `items.add(item)`、沒有 `item.setOrder(this)`」會讓明細**一筆都存不進去**（2.3.2）。
- 寫出正確的**雙向同步輔助方法**，並說明為什麼它必須成對出現。
- 解釋 2.4 那個實測：**同一段程式碼，集合有時看得到新資料、有時看不到**——而差別在幾行之前。
- 列出六種 `cascade`，說出 `save(order)` 在沒有 `cascade` 時會發生什麼（2.5.2：**明細靜默消失**）。
- 分辨 `cascade = REMOVE` 與 `orphanRemoval = true`，並說出**兩者都不設**時「從集合移除」的結果。
- 回答 06 站 03 章 3.7 那個問題：**JPA 更新明細是「全刪重插」還是「逐筆 diff」**
  （2.6.3 實測：**兩種都會，取決於你怎麼寫**——14 句 vs 3 句）。
- 說出四種關聯的**預設 fetch 策略**，並解釋為什麼 `@ManyToOne` 的預設值是一個問題（2.7.2）。
- 說明 `@OneToOne` 的 `LAZY` 在什麼情況下**無效**，以及為什麼（2.7.3）。
- 解釋 `MultipleBagFetchException` 的成因，並說出三種解法各自的代價（2.8）。
- 說出 `@ManyToMany` 在 `List` 與 `Set` 下的行為差異（2.9.1：**7 句 vs 3 句**），
  以及為什麼本課建議用**中間實體**取代它。
- 說明「把雙向關聯的實體直接回傳給前端」會遇到的**三個不同的錯誤**，並知道它們要分別怎麼解（2.10）。
- 判斷一個關聯**該不該做成雙向**——並知道「單向」通常是更好的預設（2.11）。

---

## 2.2 那一行的四個決定

先把問題攤開。01 章 1.16.5 那一行：

```java
@OneToMany(mappedBy = "order", cascade = CascadeType.ALL, orphanRemoval = true)
private List<OrderItem> items = new ArrayList<>();
```

| 這一段 | 它在決定什麼 | 本章哪一節 |
|---|---|---|
| `@OneToMany` | 這是「一對多」，而且**這一側不是擁有方** | 2.3 |
| `mappedBy = "order"` | **外鍵由 `OrderItem.order` 那一側管** | 2.3 |
| `cascade = CascadeType.ALL` | 對 `Order` 做的操作，**要不要傳遞**到明細上 | 2.5 |
| `orphanRemoval = true` | 從集合**移除**一筆明細，要不要**刪掉那一列** | 2.6 |
| `List<OrderItem>` | 用 `List` 還是 `Set`——**這也是一個決定** | 2.8 |
| （沒寫 `fetch`） | `@OneToMany` 的預設是 `LAZY`——**而 `@ManyToOne` 不是** | 2.7 |

⚠️ **注意最後兩列**：`List` 與「沒寫 `fetch`」看起來不像決定，**但它們是**。

### 2.2.1 這一章共用的模型

**表結構**（`ch02` 資料庫；07 站 1.12 的子集，加兩張這一章需要的）——
跟 01 章一樣，這一章的實體是**同一張表的多種映射變體**（`OrderTwoBags` / `OrderTwoSets`、
`ProductM2M` / `ProductWithTags`……），所以它要自己一個庫，不能跟 `shop` 混：

```sql
CREATE DATABASE ch02 CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE ch02;

CREATE TABLE customer (
  id           BINARY(16)   NOT NULL,
  email        VARCHAR(255) NOT NULL,
  display_name VARCHAR(64)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_customer_email (email)
) ENGINE=InnoDB;

CREATE TABLE product (
  id         BINARY(16)    NOT NULL,
  sku        VARCHAR(32)   NOT NULL,
  name       VARCHAR(200)  NOT NULL,
  unit_price DECIMAL(19,4) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_product_sku (sku)
) ENGINE=InnoDB;

-- 一對一：共用主鍵（2.7.3）
CREATE TABLE stock (
  product_id   BINARY(16) NOT NULL,
  qty          INT        NOT NULL DEFAULT 0,
  reserved_qty INT        NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id),
  CONSTRAINT fk_stock_product FOREIGN KEY (product_id) REFERENCES product(id)
) ENGINE=InnoDB;

CREATE TABLE orders (
  id           BINARY(16)    NOT NULL,
  order_no     VARCHAR(32)   NOT NULL,
  customer_id  BINARY(16)    NOT NULL,
  status       VARCHAR(16)   NOT NULL,
  total_amount DECIMAL(19,4) NOT NULL,
  placed_at    DATETIME(3)   NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_orders_order_no (order_no),
  KEY idx_orders_customer (customer_id),
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customer(id)
) ENGINE=InnoDB;

CREATE TABLE order_item (
  id           BINARY(16)    NOT NULL,
  order_id     BINARY(16)    NOT NULL,      -- ★ 全章的主角：【一個】外鍵欄位
  product_id   BINARY(16)    NOT NULL,
  product_name VARCHAR(200)  NOT NULL,
  unit_price   DECIMAL(19,4) NOT NULL,
  qty          INT           NOT NULL,
  line_amount  DECIMAL(19,4) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_order_item_order (order_id),
  CONSTRAINT fk_order_item_orders  FOREIGN KEY (order_id)   REFERENCES orders(id),
  CONSTRAINT fk_order_item_product FOREIGN KEY (product_id) REFERENCES product(id)
) ENGINE=InnoDB;

-- 訂單備註：2.8 需要「第二個一對多」
CREATE TABLE order_note (
  id       BINARY(16)   NOT NULL,
  order_id BINARY(16)   NOT NULL,
  note     VARCHAR(200) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_note_order (order_id),
  CONSTRAINT fk_note_orders FOREIGN KEY (order_id) REFERENCES orders(id)
) ENGINE=InnoDB;

-- 多對多（2.9）
CREATE TABLE tag (
  id   BINARY(16)  NOT NULL,
  name VARCHAR(32) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_tag_name (name)
) ENGINE=InnoDB;

-- 純中間表：給 @ManyToMany 用
CREATE TABLE product_tag (
  product_id BINARY(16) NOT NULL,
  tag_id     BINARY(16) NOT NULL,
  PRIMARY KEY (product_id, tag_id),
  CONSTRAINT fk_pt_product FOREIGN KEY (product_id) REFERENCES product(id),
  CONSTRAINT fk_pt_tag     FOREIGN KEY (tag_id)     REFERENCES tag(id)
) ENGINE=InnoDB;

-- 有屬性的中間表：給「中間實體」用（2.9.2）
CREATE TABLE product_tag_rel (
  id         BINARY(16)  NOT NULL,
  product_id BINARY(16)  NOT NULL,
  tag_id     BINARY(16)  NOT NULL,
  sort_order INT         NOT NULL DEFAULT 0,
  tagged_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_ptr (product_id, tag_id),
  CONSTRAINT fk_ptr_product FOREIGN KEY (product_id) REFERENCES product(id),
  CONSTRAINT fk_ptr_tag     FOREIGN KEY (tag_id)     REFERENCES tag(id)
) ENGINE=InnoDB;
```

📌 **命名慣例見 00 章 0.3.0.1**：這一章的 `com.example.lab.ch02` 全是**對照組**——
`Customer2` / `Order2` 是為了跟 01 章的成品區隔，
而 `OrderNoCas` / `OrderCasOnly` / `OrderCasOrphan` 三個類別**映射到同一張 `orders` 表**，
只為了比較三種 `cascade` 設定。**成品在 2.12。**

**共用的基礎類別**（跟 01 章 1.16.1 的 `BaseEntity` 相同，原樣搬來）：

```java
package com.example.lab.ch02;

import jakarta.persistence.*;
import org.hibernate.Hibernate;
import org.springframework.data.domain.Persistable;

import java.util.UUID;

@MappedSuperclass
public abstract class Base2 implements Persistable<UUID> {
    @Id private UUID id;
    @Transient private boolean isNew = true;

    protected Base2() {}
    protected Base2(UUID id) { this.id = id; }

    @Override public UUID getId() { return id; }
    @Override public boolean isNew() { return isNew; }

    @PostPersist @PostLoad
    void markNotNew() { this.isNew = false; }

    @Override public final boolean equals(Object o) {
        if (this == o) return true;
        if (o == null || Hibernate.getClass(this) != Hibernate.getClass(o)) return false;
        UUID mine = getId();
        return mine != null && mine.equals(((Base2) o).getId());
    }
    @Override public final int hashCode() { return Hibernate.getClass(this).hashCode(); }
}
```

```java
package com.example.lab.ch02;

import jakarta.persistence.*;
import java.util.UUID;

@Entity @Table(name = "customer")
public class Customer2 extends Base2 {
    @Column(nullable = false) private String email;
    @Column(name = "display_name", nullable = false) private String displayName;

    protected Customer2() {}
    public Customer2(UUID id, String email, String displayName) {
        super(id); this.email = email; this.displayName = displayName;
    }
    public String getDisplayName() { return displayName; }
}
```

```java
package com.example.lab.ch02;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.util.UUID;

@Entity @Table(name = "product")
public class Product2 extends Base2 {
    @Column(nullable = false, length = 32) private String sku;
    @Column(nullable = false, length = 200) private String name;
    @Column(name = "unit_price", nullable = false, precision = 19, scale = 4)
    private BigDecimal unitPrice;

    protected Product2() {}
    public Product2(UUID id, String sku, String name, BigDecimal unitPrice) {
        super(id); this.sku = sku; this.name = name; this.unitPrice = unitPrice;
    }
    public String getName() { return name; }
    public BigDecimal getUnitPrice() { return unitPrice; }
}
```

📌 **SQL 都用 00 章 0.10.3 的 `SqlSpy` 量。** 環境與 00 章 0.10 相同。

---

### 2.2.2 這一章的測試骨架

**先是三個 repository**（放在 `com.example.lab.ch02`，各一行）：

```java
package com.example.lab.ch02;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.UUID;

public interface Customer2Repo extends JpaRepository<Customer2, UUID> {}
```

```java
package com.example.lab.ch02;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.UUID;

public interface Product2Repo extends JpaRepository<Product2, UUID> {}
```

```java
package com.example.lab.ch02;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.UUID;

public interface Order2Repo extends JpaRepository<Order2, UUID> {}
```

📌 **後面幾節的變體（`OrderTwoBagsRepo`、`ProductM2MRepo`……）是同一個形狀**，
不再逐一列出。⚠️ **注意它們不能寫成巢狀介面** ——
Spring Data 掃描不到，啟動會報 `No qualifying bean`（03 章 3.11.2 踩過）。

**這一章的實測，每一個都是下面這種類別裡的一個 `@Test` 方法。**
後面小節的程式碼片段只貼「方法裡面那幾行」，
而它們用到的 `orders` / `products` / `em` / `jdbc` / `tx` 都在這裡：

```java
package com.example.lab;

import com.example.lab.ch02.*;
import jakarta.persistence.EntityManager;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;

import java.math.BigDecimal;
import java.util.UUID;

@SpringBootTest(properties = {
  "spring.datasource.url=jdbc:mysql://127.0.0.1:33306/ch02"
      + "?connectionTimeZone=UTC&forceConnectionTimeZoneToSession=true"
      + "&preserveInstants=true&characterEncoding=UTF-8"
})
class D1Owning {

    @Autowired Customer2Repo customers;
    @Autowired Product2Repo  products;
    @Autowired Order2Repo    orders;
    @Autowired EntityManager em;         // ★ persist / flush / clear 要直接下
    @Autowired JdbcTemplate  jdbc;       // ★ 繞過 JPA 看資料庫【真正】幾筆
    @Autowired TransactionTemplate tx;   // ★ 交易邊界自己畫（理由見 03 章 3.11.2）

    private UUID cid, pid;

    /**
     * ⚠️ 刪除順序 = 外鍵的反方向，而且【子表要先刪】。
     *    order_note 是 2.9 才加的表 —— 少刪它，2.3 的測試會在
     *    「刪 orders」那一行撞 fk_order_note_orders。
     */
    private void seed() {
        jdbc.update("DELETE FROM order_note");
        jdbc.update("DELETE FROM order_item");
        jdbc.update("DELETE FROM orders");
        jdbc.update("DELETE FROM stock");
        jdbc.update("DELETE FROM product_tag");
        jdbc.update("DELETE FROM product_tag_rel");
        jdbc.update("DELETE FROM product");
        jdbc.update("DELETE FROM customer");

        cid = Uuid7.next(); pid = Uuid7.next();
        tx.executeWithoutResult(s -> {
            customers.save(new Customer2(cid, "a@x.com", "小明"));
            products.save(new Product2(pid, "SKU-1", "機械鍵盤", new BigDecimal("2990.0000")));
        });
    }

    /** 直接問資料庫，不經過持久化情境 —— 後面幾節都會用到。 */
    private long countRows() {
        return jdbc.queryForObject("SELECT COUNT(*) FROM order_item", Long.class);
    }

    @Test
    void 只加到集合沒設反向() {
        seed();
        // …（2.3.2 的內容）
    }
}
```

📌 **`SqlSpy` 是 00 章 0.10.3 建的**，這一章直接用（`SqlSpy.start()` / `SqlSpy.stop()`）。
**「打了幾句 SQL」在這一章不是裝飾** —— 2.3.2 那三種寫法的差別就是句數。

---

## 2.3 擁有方：外鍵在誰手上 ★★

### 2.3.1 一個外鍵，兩個 Java 欄位

**資料庫這一側只有一個東西**：

```sql
order_item.order_id BINARY(16) NOT NULL
```

**Java 這一側有兩個**：

```java
class Order2     { List<OrderItem2> items; }    // 「這張訂單有哪些明細」
class OrderItem2 { Order2 order; }              // 「這筆明細屬於哪張訂單」
```

⚠️ **兩個 Java 欄位，一個資料庫欄位。所以必須有人決定：以誰為準？**

**JPA 的答案：有 `@JoinColumn` 的那一側是【擁有方】，它說了算。**

```java
// ★ 擁有方：這一側有 @JoinColumn，也就是【真的那個外鍵欄位】
@Entity @Table(name = "order_item")
public class OrderItem2 extends Base2 {

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "order_id", nullable = false)      // ← 外鍵在這裡
    private Order2 order;
    // ...
}

// 反向側（inverse side）：mappedBy 的意思是「我不管外鍵，去看 OrderItem2.order」
@Entity @Table(name = "orders")
public class Order2 extends Base2 {

    @OneToMany(mappedBy = "order", cascade = CascadeType.ALL, orphanRemoval = true)
    private List<OrderItem2> items = new ArrayList<>();
    // ...
}
```

> 📌 **`mappedBy = "order"` 這個字串，指的是【對方類別裡那個欄位的名字】。**
> 不是資料庫欄位名（`order_id`），是 `OrderItem2` 裡那個叫 `order` 的 Java 欄位。
>
> **它的意思是**：「這個集合不擁有外鍵。要知道外鍵的值，去看 `OrderItem2.order`。」

⚠️⚠️ **這句話有一個很少被明說、但決定一切的推論**：

> **Hibernate 在產生 `INSERT` / `UPDATE` 時，【只看擁有方】。**
> **反向側的集合，對 SQL 沒有任何影響。**

### 2.3.2 實測：三種寫法 ★★

**完整的實體**（`addItemBroken` 是刻意寫壞的版本）：

```java
package com.example.lab.ch02;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

@Entity @Table(name = "orders")
public class Order2 extends Base2 {
    @Column(name = "order_no", nullable = false) private String orderNo;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "customer_id", nullable = false)
    private Customer2 customer;

    @Column(nullable = false, length = 16) private String status = "PENDING";
    @Column(name = "total_amount", nullable = false, precision = 19, scale = 4)
    private BigDecimal totalAmount = BigDecimal.ZERO;
    @Column(name = "placed_at", nullable = false) private Instant placedAt = Instant.now();

    @OneToMany(mappedBy = "order", cascade = CascadeType.ALL, orphanRemoval = true)
    private List<OrderItem2> items = new ArrayList<>();

    protected Order2() {}
    public Order2(UUID id, String orderNo, Customer2 customer) {
        super(id); this.orderNo = orderNo; this.customer = customer;
    }

    /** 🔴 只加到集合，【沒有】設反向。 */
    public void addItemBroken(OrderItem2 item) {
        items.add(item);
        totalAmount = totalAmount.add(item.getLineAmount());
    }

    /** ✅ 兩邊都設。 */
    public void addItem(OrderItem2 item) {
        items.add(item);
        item.setOrder(this);
        totalAmount = totalAmount.add(item.getLineAmount());
    }

    public void removeItem(OrderItem2 item) {
        items.remove(item);
        item.setOrder(null);
        totalAmount = totalAmount.subtract(item.getLineAmount());
    }

    public String getOrderNo() { return orderNo; }
    public Customer2 getCustomer() { return customer; }
    public List<OrderItem2> getItems() { return items; }
    public BigDecimal getTotalAmount() { return totalAmount; }
}
```

```java
package com.example.lab.ch02;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.util.UUID;

@Entity @Table(name = "order_item")
public class OrderItem2 extends Base2 {

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "order_id", nullable = false)
    private Order2 order;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "product_id", nullable = false)
    private Product2 product;

    @Column(name = "product_name", nullable = false) private String productName;
    @Column(name = "unit_price", nullable = false, precision = 19, scale = 4)
    private BigDecimal unitPrice;
    @Column(nullable = false) private int qty;
    @Column(name = "line_amount", nullable = false, precision = 19, scale = 4)
    private BigDecimal lineAmount;

    protected OrderItem2() {}
    public OrderItem2(UUID id, Product2 product, int qty) {
        super(id);
        this.product = product;
        this.productName = product.getName();
        this.unitPrice = product.getUnitPrice();
        this.qty = qty;
        this.lineAmount = product.getUnitPrice().multiply(BigDecimal.valueOf(qty));
    }
    /** ★ package-private：只有同一個聚合裡的 Order2 可以呼叫（01 章 1.3.2 的理由）。 */
    void setOrder(Order2 o) { this.order = o; }
    public Order2 getOrder() { return order; }
    public BigDecimal getLineAmount() { return lineAmount; }
}
```

**① 只加到集合，沒設反向**

```java
tx.executeWithoutResult(s -> {
    Order2 o = new Order2(oid, "SO-1", customers.getReferenceById(cid));
    o.addItemBroken(new OrderItem2(Uuid7.next(), products.getReferenceById(pid), 2));
    orders.save(o);
});
```

```
  🔴 DataIntegrityViolationException
     Column 'order_id' cannot be null
── SQL → 3 句 SQL
   1) select p1_0.id,p1_0.name,p1_0.sku,p1_0.unit_price from product p1_0 where p1_0.id=?
   2) insert into orders (customer_id,order_no,placed_at,status,total_amount,id) values (?,?,?,?,?,?)
   3) insert into order_item (line_amount,order_id,product_id,product_name,qty,unit_price,id) values (?,?,?,?,?,?,?)
  DB order_item: [{c=0}]
```

⚠️⚠️ **看清楚發生了什麼**：

```
cascade 有生效  →  它【真的】送出了 order_item 的 INSERT
但 order_id 是 null  →  因為那個值來自【擁有方】，而擁有方的 order 欄位沒人設
```

📌 **是資料庫的 `NOT NULL` 擋下來的，不是 JPA。**

> 🔴 **如果 `order_id` 允許 `NULL`（很多老 schema 是這樣），
> 這一段程式碼會【成功】——留下一筆 `order_id IS NULL` 的孤兒明細，
> 而畫面上那張訂單顯示「0 筆明細」。**
>
> **這就是 07 站那些 `NOT NULL` 約束的價值**（01 章 1.11 的第三層）。

**② 只設反向，沒加到集合**

```java
tx.executeWithoutResult(s -> {
    Order2 o = new Order2(oid, "SO-3", customers.getReferenceById(cid));
    orders.save(o);
    OrderItem2 item = new OrderItem2(iid, products.getReferenceById(pid), 2);
    item.setOrder(o);          // 只設擁有方
    em.persist(item);          // 因為沒進集合，cascade 不會幫它，要自己 persist
});
```

```
── SQL → 共 3 句
   ×1  select p1_0.id,... from product p1_0 where p1_0.id=?
   ×1  insert into orders (...) values (...)
   ×1  insert into order_item (...) values (...)
  DB order_item: [{product_name=機械鍵盤, qty=2}]

  ⚠️ 但是【同一個交易裡】的記憶體呢：
    重新查出來 o.getItems().size() = 1
```

✅ **資料庫是對的**——因為擁有方設了。
⚠️ **但你得自己 `em.persist(item)`**，因為 `cascade` 是掛在集合上的，而它沒進集合。

**③ 兩邊都設**

```
── SQL → 共 3 句
  DB order_item: [{product_name=機械鍵盤, qty=2, oid=01A07A207D26735DB2D96D547FDADBBD}]
```

✅ **正確，而且 `cascade` 也生效了**（不用自己 `persist`）。

**三種寫法的對照**：

| | 資料庫對嗎 | 記憶體對嗎 | `cascade` 有用嗎 |
|---|---|---|---|
| ① 只 `add` 到集合 | 🔴 **`order_id` 是 null** | ✅ | ✅ |
| ② 只設擁有方 | ✅ | 🔴 **集合是空的** | 🔴 要自己 `persist` |
| ③ **兩邊都設** | ✅ | ✅ | ✅ |

> 📌 **結論很簡單，但值得寫在牆上**：
> **雙向關聯，兩邊都要設。而且不能靠工程師記得——要包成一個方法。**

### 2.3.3 實測：搬移一筆既有的明細 ★★

2.3.2 測的是「**新增**一筆明細」。**既有的明細呢？**

**情境**：把一筆明細從訂單 A 搬到訂單 B——**只操作集合，不碰擁有方**。

```java
tx.executeWithoutResult(s -> {
    Order2 a = orders.findById(oidA).orElseThrow();
    Order2 b = orders.findById(oidB).orElseThrow();
    OrderItem2 item = a.getItems().get(0);
    a.getItems().remove(item);      // 從 A 的集合移除
    b.getItems().add(item);         // 加進 B 的集合 —— 只碰集合，沒碰擁有方
});
```

```
  搬之前：[{qty=1, order_no=SO-A}]
── SQL → 共 3 句，2 種形狀
   ×2  select o1_0.id,... from orders o1_0 where o1_0.id=?
   ×1  select i1_0.order_id,... from order_item i1_0 where i1_0.order_id=?
  UPDATE 句數 = 0
  搬之後：[{qty=1, order_no=SO-A}]        ← 🔴 沒搬成，而且【完全沒有錯誤】
```

🔴🔴 **三句 SQL 全是 `SELECT`。一句 `UPDATE` 都沒有，一句 `DELETE` 也沒有。
那筆明細還在 A 訂單上。**

⚠️ **這比 2.3.2 那個更危險**，因為 2.3.2 至少被資料庫的 `NOT NULL` 擋下來了。
**這一個完全靜默：程式跑完、交易提交、沒有任何例外，而什麼都沒發生。**

**兩個對照，把機制講完**：

```
═══ 對照 ①：只從 A 移除，【不】加進 B ═══
   ×1  delete from order_item where id=?          ← ✅ orphanRemoval 生效了
  order_item 剩 0 筆

═══ 對照 ②：正確的搬法 —— 兩邊都動（b.addItem 裡有 item.setOrder(this)）═══
   ×1  update order_item set line_amount=?,order_id=?,... where id=?    ← ✅
  搬之後：[{qty=1, order_no=SO-B}]
```

📌 **所以那個「什麼都沒發生」是兩件事疊在一起**：

```
① 擁有方（item.order）沒有變  →  不會有 UPDATE（2.3.1 的推論）
② orphanRemoval 本來要刪它，但它【又被加進另一個被管理的集合】
   →  Hibernate 判斷它不是孤兒，取消了刪除
   →  結果：兩個動作互相抵銷，淨效果是零
```

> ⚠️⚠️ **這正是 01 章 1.19 預告的那一句**：
> **「`mappedBy` 寫錯（或只動集合），`items.add()` 不會產生任何 `UPDATE`。」**
>
> **而它的可怕之處在於「淨效果是零」**——
> 不是報錯、不是刪錯、不是搬到一半，是**完全沒有痕跡**。
> 你的測試如果只斷言「沒有拋例外」，它會通過。

### 2.3.4 雙向同步的輔助方法

```java
/** ✅ 加明細：集合 + 擁有方，一次做完。 */
public void addItem(OrderItem2 item) {
    items.add(item);
    item.setOrder(this);          // ★ 這一行是重點
    totalAmount = totalAmount.add(item.getLineAmount());
}

/** ✅ 移除明細：也要兩邊。 */
public void removeItem(OrderItem2 item) {
    items.remove(item);
    item.setOrder(null);          // ★ 沒有這一行，orphanRemoval 仍會刪，但記憶體不一致
    totalAmount = totalAmount.subtract(item.getLineAmount());
}
```

**三個設計要點**：

```
① setOrder 是 package-private
   → 外面的人【沒有辦法】只設一邊（01 章 1.3.2：實體不要有 public setter）

② 集合的 getter 回傳 unmodifiableList（01 章 1.16.5 就是這樣做的）
   → 外面的人【沒有辦法】直接 items.add(...) 繞過這個方法

③ 這兩個方法同時維護 totalAmount
   → 07 站不變量 #3「訂單金額 = 明細總和」（01 章 1.13）
```

⚠️ **② 有一個代價**：`Collections.unmodifiableList(items)` 回傳的是一個**包裝**，
而 Hibernate 需要的是**原本那個 `PersistentBag`**。
**只要你不把包裝過的那個交給 Hibernate（例如不要 `setItems(...)`），就沒問題**——
Hibernate 讀寫的是欄位本身（01 章 1.3.2 的欄位存取）。

---
## 2.4 實測：集合會過時 ★★

2.3.2 的寫法 ② 留下一個問題：**只設擁有方時，記憶體裡的集合是空的。**
那如果我在**同一個交易裡**，先讀了集合、再從擁有方那側加一筆呢？

```java
tx.executeWithoutResult(s -> {
    Order2 o = orders.findById(oid).orElseThrow();
    System.out.println("一開始 o.getItems().size() = " + o.getItems().size());

    OrderItem2 fresh = new OrderItem2(Uuid7.next(), products.getReferenceById(pid), 5);
    fresh.setOrder(o);      // 只設擁有方
    em.persist(fresh);
    em.flush();             // 強迫 INSERT 送出去

    System.out.println("flush 之後 DB 有 " + countRows() + " 筆");
    System.out.println("但 o.getItems().size() = " + o.getItems().size());
});
```

```
  一開始 o.getItems().size() = 1
  flush 之後 DB 有 2 筆
  但 o.getItems().size() = 1   ← 🔴 集合還是舊的
  o.getTotalAmount() = 100.0000   ← 🔴 總額也沒跟上
```

⚠️ **`flush()` 已經把 `INSERT` 送出去了、資料庫確實有 2 筆，而記憶體裡的集合還是 1 筆。**

### 2.4.1 而它會不會發生，取決於幾行之前 ★★

**把同一段程式碼跑兩次，唯一的差別是「有沒有先讀一次集合」**：

```java
Order2 o = orders.findById(oid).orElseThrow();
if (touchFirst) {
    o.getItems().size();       // ★ 先碰一下 → 集合被初始化
}
// ...接著從擁有方加一筆、flush，再讀集合
```

```
═══ 同一段程式碼，差別只在「之前有沒有碰過那個集合」 ═══
  ① 先碰過集合：先讀了一次，size = 1
    集合初始化了嗎？ true
    DB 現在有 2 筆
    o.getItems().size() = 1   🔴 看不到

  ② 沒碰過集合：完全沒碰集合
    集合初始化了嗎？ false
    DB 現在有 2 筆
    o.getItems().size() = 2   ✅ 看得到
```

🔴🔴 **同一段程式碼，兩種答案。**

**為什麼**：

```
集合是【延遲載入】的。它第一次被存取時，才去資料庫撈。

① 先碰過 → 集合已經載入，裡面有 1 筆。之後 Hibernate【不會】再去撈一次，
            所以它永遠不知道有人從另一側加了東西。

② 沒碰過 → 集合到最後那一行才第一次載入，而那時候 INSERT 已經 flush 了，
            所以它撈到 2 筆。
```

> ⚠️⚠️ **這是這一章最陰險的一個行為**，因為：
>
> **「這段程式碼對不對」取決於「呼叫它的人之前有沒有碰過那個集合」**——
> 而那可能發生在另一個類別、另一個方法裡。
>
> **加一行日誌 `log.debug("明細數：{}", order.getItems().size())` 就足以改變後面程式碼的行為。**

### 2.4.2 `em.refresh()` 能救，但有代價

```java
em.refresh(o);
System.out.println("refresh 後 size = " + o.getItems().size());   // ✅ 2
```

⚠️ **`refresh()` 會把這個實體上【所有】未 flush 的修改丟掉**，
從資料庫重讀一遍。它是一把很鈍的刀。

> 📌 **正解不是 `refresh()`，是 2.3.4 的輔助方法**：
> **永遠透過 `order.addItem(...)` 加明細，不要從擁有方那側偷偷塞。**
>
> 而「不要從擁有方那側偷偷塞」這件事，靠的是 2.3.4 的三個設計要點：
> **`setOrder` 是 package-private、集合的 getter 是唯讀的。**

⚠️ **注意 `totalAmount` 那一列**：它是一個**存在欄位裡的值**（07 站不變量 #3）。
集合過時只是暫時的（換個交易重查就對了），
**但 `totalAmount` 一旦算錯，就永久錯在資料庫裡**：

```
  換一個交易重新查：
    o.getItems().size() = 2   ✅
    o.getTotalAmount()  = 100.0000   ← 🔴 但總額【永遠】是錯的
```

**這正是 01 章 1.13 說「不變量 #3 守在 `Order.addItem()`」的意思**——
繞過那個方法，不變量就失守了。

---

## 2.5 `cascade` ★★

### 2.5.1 六種 cascade

```java
CascadeType.PERSIST    // em.persist(order)  → 也 persist 明細
CascadeType.MERGE      // em.merge(order)    → 也 merge 明細
CascadeType.REMOVE     // em.remove(order)   → 也 remove 明細
CascadeType.REFRESH    // em.refresh(order)  → 也 refresh 明細
CascadeType.DETACH     // em.detach(order)   → 也 detach 明細
CascadeType.ALL        // 以上全部
// （JPA 沒有 CascadeType.SAVE —— save() 是 Spring Data 的方法，它底下走 persist 或 merge）
```

📌 **`cascade` 的意思是「我對父物件做的操作，要不要傳遞給子物件」。**
**它跟「外鍵」「刪除」在資料庫層的行為【沒有關係】**——
它是純粹的 JPA 概念，發生在 Java 這一側。

### 2.5.2 實測：沒有 `cascade`，`save(order)` 會怎樣

```java
@OneToMany(mappedBy = "order")           // ★ 沒有 cascade
private List<ItemNoCas> items = new ArrayList<>();
```

```java
tx.executeWithoutResult(s -> {
    OrderNoCas o = new OrderNoCas(oid, "SO-1", customers.getReferenceById(cid));
    o.addItem(new ItemNoCas(Uuid7.next(), products.getReferenceById(pid), 2));
    noCas.save(o);
});
```

```
  存進去了。orders=1  order_item=0   🔴 明細不見了
```

⚠️⚠️ **沒有例外、沒有警告。訂單存進去了，明細一筆都沒有。**

📌 **這是這一章「不報錯但資料是錯的」的第二個例子**（第一個是 2.3.2 那個 `order_id` null——
而那一個至少還被資料庫擋下來了，**這一個連擋都沒有**）。

### 2.5.3 實測：刪掉整張訂單

**① 沒有 `cascade`**：

```java
tx.executeWithoutResult(s -> noCas.deleteById(oid));
```

```
  🔴 DataIntegrityViolationException
     Cannot delete or update a parent row: a foreign key constraint fails
     (`ch02`.`order_item`, CONSTRAINT `fk_order_item_orders`
      FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`))
```

✅ **資料庫擋住了**（07 站 1.10.3 的外鍵）。

**② `cascade = ALL`**：

```
  ② cascade=ALL：刪除前 orders=1 order_item=1
    刪除後 orders=0 order_item=0   ✅
──     SQL → 共 6 句
   ×1  select oco1_0.id,... from orders oco1_0 where oco1_0.id=?
   ×1  select i1_0.order_id,... from order_item i1_0 where i1_0.order_id=?
   ×1  delete from order_item where id=?
   ×1  delete from orders where id=?
```

📌 **注意它的做法**：先把明細**全部載入記憶體**，再**一筆一筆** `DELETE`，最後刪訂單。

⚠️ **這在明細很多時是一個效能問題**：

```
一張有 5000 筆明細的訂單 →  1 句 SELECT（撈 5000 筆進記憶體）
                          + 5000 句 DELETE
                          + 1 句 DELETE
```

**而一句 `DELETE FROM order_item WHERE order_id = ?` 就能做完。**

> 📌 **這是 `cascade = REMOVE` 的本質代價**：
> **它是「以物件為單位」的刪除，而資料庫是「以集合為單位」的。**
>
> ✅ **大量刪除要繞過它**——用 JPQL 的 `delete` 或原生 SQL（05 章），
> 或是交給資料庫的 `ON DELETE CASCADE`（07 站 1.10.3）。
> ⚠️ 但那兩種做法都**不會更新持久化情境**，要小心 03 章的一級快取。

### 2.5.4 `cascade` 該設在哪些關聯上

**判準只有一個**：

> **這兩個東西是不是同一個【聚合】？**
> **也就是：子物件離開父物件之後，還有意義嗎？**

| 關聯 | 同一個聚合嗎 | `cascade` |
|---|---|---|
| `Order` → `OrderItem` | ✅ 明細離開訂單沒有意義 | ✅ `ALL` |
| `Order` → `Customer` | 🔴 客戶不屬於訂單 | 🔴 **不要**——刪一張訂單不該刪客戶 |
| `OrderItem` → `Product` | 🔴 商品不屬於明細 | 🔴 **不要** |
| `Product` → `Stock` | ✅ 庫存離開商品沒有意義 | ✅ `ALL` |

🔴 **在 `@ManyToOne` 上設 `cascade = ALL` 是一個經典災難**：

```java
// 🔴🔴 絕對不要
@ManyToOne(cascade = CascadeType.ALL)
@JoinColumn(name = "customer_id")
private Customer2 customer;
```

**因為 `em.remove(order)` 會連帶刪掉那個客戶**——而那個客戶還有 50 張別的訂單。

📌 **06 站 00 章 0.4.3 那張「Repository vs DAO」的表，這裡有一個直接的對應**：

> **`cascade` 的邊界，就是【聚合】的邊界。**
> **而聚合的邊界，就是 Repository 的邊界**——
> `OrderRepository` 存的是「訂單這個整體」，所以明細跟著走；
> 客戶有自己的 `CustomerRepository`，所以不跟著走。

---

## 2.6 `orphanRemoval` ★★

### 2.6.1 它跟 `cascade = REMOVE` 差在哪

**兩者處理的是【兩件不同的事】**：

```
cascade = REMOVE     ：你刪【父物件】時，要不要一起刪子物件
orphanRemoval = true ：你把子物件【從集合移除】時，要不要刪掉那一列
```

⚠️ **「從集合移除」不等於「刪除父物件」。** 這是兩個完全不同的動作：

```java
orderRepository.delete(order);        // ← cascade = REMOVE 管這個
order.getItems().remove(item);        // ← orphanRemoval 管這個
```

### 2.6.2 實測：從集合移除一筆明細

**① `cascade = ALL`，沒有 `orphanRemoval`**

```java
@OneToMany(mappedBy = "order", cascade = CascadeType.ALL)
private List<ItemCasOnly> items = new ArrayList<>();
```

```java
tx.executeWithoutResult(s -> {
    OrderCasOnly o = casOnly.findById(oid1).orElseThrow();
    o.getItems().remove(0);
});
```

```
  cascade=ALL（無 orphanRemoval）：移除前 order_item=2
    移除後 order_item=2   🔴 沒有刪掉
──     SQL → 共 3 句
   ×1  select oco1_0.id,... from orders oco1_0 where oco1_0.id=?
   ×1  select i1_0.order_id,... from order_item i1_0 where i1_0.order_id=?
   （沒有 DELETE，也沒有 UPDATE）
```

🔴 **什麼都沒發生。** 那一筆明細還在資料庫裡，`order_id` 也還指著這張訂單。

⚠️ **注意這裡的「什麼都沒發生」比想像中合理**：
你只是從**反向側的集合**移除了它，而 2.3.1 說過——**Hibernate 產生 SQL 時只看擁有方。**
擁有方（`item.order`）沒有變，所以沒有任何 SQL。

**② `cascade = ALL` + `orphanRemoval = true`**

```
  cascade=ALL + orphanRemoval：移除前 order_item=2
    移除後 order_item=1   ✅ 刪掉了
──     SQL → 共 4 句
   ×1  select oco1_0.id,... from orders oco1_0 where oco1_0.id=?
   ×1  select i1_0.order_id,... from order_item i1_0 where i1_0.order_id=?
   ×1  delete from order_item where id=?
```

✅ **`orphanRemoval` 就是在補這個洞**：它讓「從集合移除」變成一個**有意義的動作**。

**四種組合的完整對照**：

| `cascade` | `orphanRemoval` | `save(父)` 存子嗎 | `delete(父)` 刪子嗎 | `集合.remove(子)` 刪嗎 |
|---|---|---|---|---|
| 無 | `false` | 🔴 靜默不存 | 🔴 FK 錯誤 | 🔴 什麼都沒發生 |
| `ALL` | `false` | ✅ | ✅ | 🔴 **什麼都沒發生** |
| 無 | `true` | 🔴 靜默不存 | ✅（孤兒也算） | ✅ |
| **`ALL`** | **`true`** | ✅ | ✅ | ✅ |

📌 **本課用最後一行**（01 章 1.16.5 那一行），因為 `Order` 與 `OrderItem` 是同一個聚合。

### 2.6.3 回答 06 站 03 章 3.7：全刪重插，還是逐筆 diff ★★

**06 站 03 章 3.7 留下的問題**：更新一張訂單的明細，
資料層是「把舊的全刪、新的全插」還是「比對差異、只動有變的」？

**當時的結論是「等 08 站」。現在來測。**

**情境**：一張有 5 筆明細的訂單，**只改其中一筆的數量**。

**寫法 ①：`clear()` 之後重建**（非常常見，尤其是「從 DTO 重建聚合」的寫法）

```java
tx.executeWithoutResult(s -> {
    OrderCasOrphan o = repo.findById(oid).orElseThrow();
    o.getItems().clear();                       // 🔴 全刪
    for (int i = 0; i < 5; i++) {
        o.addItem(new ItemCasOrphan(Uuid7.next(),
                products.getReferenceById(pid), i == 2 ? 99 : i + 1));
    }
});
```

```
── ① clear() 之後重建 5 筆 → 共 14 句，6 種形狀
   ×1  select ... from orders ...
   ×1  select ... from order_item ...
   ×1  select ... from product ...
   ×5  delete from order_item where id=?
   ×5  insert into order_item (...) values (...)
   ×1  update orders set ... where id=?
```

**寫法 ②：只改那一筆**

```java
tx.executeWithoutResult(s -> {
    OrderCasOrphan o = repo.findById(oid).orElseThrow();
    o.getItems().get(2).changeQty(99);           // ✅ 只動一筆
});
```

```
── ② 只改第 3 筆的數量 → 共 3 句，3 種形狀
   ×1  select ... from orders ...
   ×1  select ... from order_item ...
   ×1  update order_item set line_amount=?,order_id=?,product_id=?,
             product_name=?,qty=?,unit_price=? where id=?
```

**寫法 ③：移除一筆、新增一筆**

```
── ③ 移除一筆 + 新增一筆 → 共 6 句，6 種形狀
   ×1  delete from order_item where id=?
   ×1  insert into order_item (...) values (...)
   ×1  update orders set ... where id=?
```

**所以 06 站 3.7 的答案是**：

> ⚠️ **JPA 做的是【逐筆 diff】——但那個 diff 是在「物件」層次做的，不是「資料」層次。**
>
> **它比對的是「持久化情境裡的那些物件實例，有沒有變」**（03 章的髒檢查），
> **不是「新資料跟舊資料的欄位值有沒有差」。**
>
> 所以：
> - **改物件** → 它看到同一個實例的欄位變了 → 1 句 `UPDATE`
> - **`clear()` 之後放新物件進去** → 它看到 5 個舊實例不見了、5 個新實例出現 → 5 刪 5 插
>
> **即使那 5 筆新資料裡有 4 筆跟舊的一模一樣。**

📌 **這對「從 DTO 重建聚合」這種寫法是一個嚴重的警告**：

```java
// 🔴 這段程式碼在功能上是對的，在 SQL 上是災難
public void updateOrder(OrderDto dto) {
    Order o = repo.findById(dto.id()).orElseThrow();
    o.getItems().clear();
    dto.items().forEach(i -> o.addItem(toEntity(i)));
}
```

**一張 200 筆明細的訂單，改一個數量 → 400 句 SQL。**

✅ **正解**：在 Service 層做 diff，只動真的變了的：

```java
public void updateOrder(OrderDto dto) {
    Order o = repo.findById(dto.id()).orElseThrow();
    Map<UUID, OrderItem> existing = o.getItems().stream()
            .collect(toMap(OrderItem::getId, it -> it));

    for (ItemDto d : dto.items()) {
        OrderItem cur = existing.remove(d.id());
        if (cur == null) o.addItem(newItem(d));      // 新增的
        else cur.changeQty(d.qty());                 // 改過的（沒變的話髒檢查也不會發 UPDATE）
    }
    existing.values().forEach(o::removeItem);        // 剩下的就是被刪掉的
}
```

⚠️ **注意最後那個括號裡的話**：**沒變的那幾筆，`changeQty` 設回同一個值，髒檢查【不會】產生 `UPDATE`。**

**實測**（3 筆明細，每一筆都 `changeQty(i.getQty())` 設回原值）：

```
═══ 把每一筆的 qty 都【設回原本的值】 ═══
── SQL → 共 2 句
   ×1  select ... from orders ...
   ×1  select ... from order_item ...
  UPDATE 句數 = 0        ← ✅ 一句都沒有

═══ 對照：真的改一筆 ═══
  UPDATE 句數 = 1
```

📌 **因為 Hibernate 比對的是【載入時的快照】，值一樣就不算變更**（03 章）。
**所以那段 diff 程式碼不需要自己判斷「這一筆有沒有變」——交給髒檢查就好。**

---
## 2.7 `fetch`：兩個不一樣的預設值 ★★

### 2.7.1 四種關聯的預設策略

**這張表值得背起來，因為它不對稱**：

| 關聯 | 預設 `fetch` | 直覺上合理嗎 |
|---|---|---|
| `@OneToMany` | `LAZY` | ✅ 合理——一張訂單可能有 1000 筆明細 |
| `@ManyToMany` | `LAZY` | ✅ 合理 |
| **`@ManyToOne`** | 🔴 **`EAGER`** | 🔴 **不合理，而且是預設值** |
| **`@OneToOne`** | 🔴 **`EAGER`** | 🔴 同上 |

⚠️ **規格這樣定的邏輯是「多的那一端很大，一的那一端很小」**——
但「小」不代表「免費」，**它代表「每一筆都要多打一句 SQL」**。

### 2.7.2 實測：`@ManyToOne` 不寫 `fetch`

```java
/** ⚠️ 完全不寫 fetch —— 看預設值是什麼。 */
@Entity @Table(name = "order_item")
public class ItemEager extends Base2 {

    @ManyToOne @JoinColumn(name = "order_id", nullable = false)      // 沒寫 fetch
    private OrderCasOrphan order;

    @ManyToOne @JoinColumn(name = "product_id", nullable = false)    // 沒寫 fetch
    private Product2 product;
    // ...
}
```

```java
tx.executeWithoutResult(s -> {
    var list = itemsEager.findAll();
    System.out.println("撈了 " + list.size() + " 筆明細，【什麼關聯都沒碰】");
});
```

```
── 不寫 fetch（= EAGER） → 共 3 句，3 種形狀
   ×1  select ie1_0.id,... from order_item ie1_0
   ×1  select oco1_0.id,... from orders oco1_0 where oco1_0.id=?
   ×1  select p1_0.id,... from product p1_0 where p1_0.id=?

── 明確寫 fetch = LAZY → 共 1 句，1 種形狀
   ×1  select oi1_0.id,... from order_item oi1_0
```

⚠️ **撈 1 筆明細，打了 3 句 SQL——而程式碼裡【什麼關聯都沒碰】。**

📌 **把它放大**：撈 200 筆明細（每筆屬於不同訂單、不同商品）——

```
LAZY  →  1 句
EAGER →  1 + 200 + 200 = 401 句
```

**這就是 00 章 0.3.2 那個 N+1 的另一種來源**——
而且它比那一個更糟，因為 **00 章那個至少是你自己寫了 `o.getCustomer()`**，
**這一個你什麼都沒寫。**

> 📌 **一條可以直接執行的規則**：
> **每一個 `@ManyToOne` 與 `@OneToOne` 都要明確寫 `fetch = FetchType.LAZY`。**
> **沒有例外。** 需要那個關聯的時候，用 `JOIN FETCH` 或 `@EntityGraph` 明確要（04 章）。

**把它變成一條 ArchUnit 規則**（延續 01 章 1.9.4 的做法）：

```java
@Test
void ManyToOne與OneToOne一律要寫LAZY() {
    fields().that().areAnnotatedWith(jakarta.persistence.ManyToOne.class)
            .should(new ArchCondition<JavaField>("有 fetch = LAZY") {
                @Override public void check(JavaField f, ConditionEvents events) {
                    var a = f.getAnnotationOfType(jakarta.persistence.ManyToOne.class);
                    if (a.fetch() != jakarta.persistence.FetchType.LAZY) {
                        events.add(SimpleConditionEvent.violated(f,
                                f.getFullName() + " 的 @ManyToOne 沒有寫 fetch = LAZY（2.7.2）"));
                    }
                }
            }).check(classes);
}
```

### 2.7.3 `@OneToOne` 的 `LAZY` 陷阱 ★★

**07 站 1.12 的 `stock` 表跟 `product` 是一對一，而且共用主鍵。**

```java
/** 擁有方：stock 這一側有外鍵（product_id 同時也是主鍵）。 */
@Entity @Table(name = "stock")
public class StockOpt {
    @Id @Column(name = "product_id") private UUID productId;

    @OneToOne(fetch = FetchType.LAZY)
    @MapsId                                    // ★ 主鍵就是外鍵
    @JoinColumn(name = "product_id")
    private Product2 product;

    @Column(nullable = false) private int qty;
    @Column(name = "reserved_qty", nullable = false) private int reservedQty;
    // ...
}

/** 反向側：product 這一側【沒有】外鍵欄位。 */
@Entity @Table(name = "product")
public class ProductWithStock extends Base2 {
    // ...
    @OneToOne(mappedBy = "product", fetch = FetchType.LAZY)     // ★ 寫了 LAZY
    private StockOpt stock;
}
```

**兩邊各查一次，只讀本身的欄位、不碰關聯**：

```
═══ @OneToOne 反向側（mappedBy）的 LAZY ═══
  只讀 product.getName() = 鍵盤
── 反向側 @OneToOne(mappedBy, LAZY) → 共 2 句
   ×1  select pws1_0.id,pws1_0.name,pws1_0.sku,pws1_0.unit_price from product pws1_0 where pws1_0.id=?
   ×1  select so1_0.product_id,so1_0.qty,so1_0.reserved_qty from stock so1_0 where so1_0.product_id=?   ← 🔴

═══ 對照：擁有方（有 @JoinColumn）的 LAZY ═══
  只讀 stock.getQty() = 100
── 擁有方 @OneToOne(LAZY) + @MapsId → 共 1 句
   ×1  select so1_0.product_id,so1_0.qty,so1_0.reserved_qty from stock so1_0 where so1_0.product_id=?   ✅
```

🔴 **反向側寫了 `LAZY`，而它沒有生效。**

**為什麼**：

```
擁有方（stock）：它自己就有 product_id 這一欄。
  → 要不要載入 product？Hibernate 可以先給一個【代理】，反正 id 已經在手上。
  → LAZY 成立 ✅

反向側（product）：product 表【沒有】任何欄位指向 stock。
  → 「這個商品有沒有庫存資料」這件事，不查 stock 表【根本不知道】。
  → 而 stock 欄位的型別是 StockOpt，不是 Optional<StockOpt>——
     Hibernate 必須決定要放一個代理還是放 null。
  → 要決定，就得查。
  → LAZY 不可能成立 🔴
```

> 📌 **一句話**：
> **`@OneToOne` 的反向側，`LAZY` 永遠無效。**
> **`@ManyToOne` 沒有這個問題**（它永遠是擁有方，外鍵一定在手上）。

**三個解法**：

```
✅ ① 不要做雙向 —— 只留 stock → product 這一側（本課採用，2.11）
     需要「某商品的庫存」時，用 stockRepository.findById(productId)

🟡 ② 加 optional = false
     → 告訴 Hibernate「一定有」，它就可以直接給代理，不用查
     → ⚠️ 但只要有一筆商品沒有 stock 列，讀出來就是 EntityNotFoundException

🟡 ③ 開啟 bytecode enhancement（Hibernate 的 Maven / Gradle plugin）
     → 它會改寫 class 檔，讓反向側也能 lazy
     → ⚠️ 代價是建置多一個步驟，而且除錯時看到的是被改寫過的程式碼
```

⚠️ **解法 ② 值得展開一句**：`optional = false` 是一個**對資料的承諾**。
07 站 1.12 的 `stock` 表用外鍵指向 `product`，
**但那只保證「stock 的 product 一定存在」，不保證「每個 product 都有 stock」**。
**方向是反的**，所以 ② 在這裡不成立。

---

## 2.8 `List` / `Set` / Bag ★★

01 章 1.19 留了一個問題：**`List` 而不是 `Set`，1.14.2 那個 `HashSet` 問題會不會發生？**

### 2.8.1 Hibernate 眼中的三種集合

```
Bag   ：List，【沒有】 @OrderColumn      → 允許重複、沒有順序保證（本課用的）
List  ：List，【有】 @OrderColumn        → 順序存進一個額外的欄位
Set   ：Set                              → 靠 equals 去重
```

⚠️ **大多數人寫 `List` 的時候，得到的是 Bag。**

### 2.8.2 實測：`MultipleBagFetchException`

**一張訂單有兩個一對多：明細與備註。**

```java
@Entity @Table(name = "orders")
public class OrderTwoBags extends Base2 {
    // ...
    @OneToMany(mappedBy = "order", cascade = CascadeType.ALL)
    private List<ItemTwoBags> items = new ArrayList<>();

    @OneToMany(mappedBy = "order", cascade = CascadeType.ALL)
    private List<OrderNote> notes = new ArrayList<>();
}
```

**一句 JPQL 同時 fetch 兩個**（這是 04 章解 N+1 的標準做法）：

```java
em.createQuery("""
        select o from OrderTwoBags o
          left join fetch o.items
          left join fetch o.notes
         where o.id = :id
        """, OrderTwoBags.class).setParameter("id", oid).getResultList();
```

```
  DB: order_item=2  order_note=2
  🔴 MultipleBagFetchException
     cannot simultaneously fetch multiple bags:
     [com.example.lab.ch02.OrderTwoBags.items, com.example.lab.ch02.OrderTwoBags.notes]
```

### 2.8.3 為什麼：看一眼 JOIN 出來的列數

```sql
SELECT o.order_no, i.qty, n.note
  FROM orders o
  LEFT JOIN order_item i ON i.order_id = o.id
  LEFT JOIN order_note n ON n.order_id = o.id
```

```
  2 筆明細 × 2 筆備註 = 4 列
    {order_no=SO-1, qty=1, note=統編 12345678}
    {order_no=SO-1, qty=1, note=客戶要求包裝}
    {order_no=SO-1, qty=2, note=統編 12345678}
    {order_no=SO-1, qty=2, note=客戶要求包裝}
```

📌 **這是一個笛卡兒積。** 而 Hibernate 要從這 4 列還原出「2 筆明細 + 2 筆備註」。

```
Set  →  可以。丟進 Set，重複的自然被 equals 吃掉。
Bag  →  不行。List【允許重複】，Hibernate 無法判斷
        「這 4 筆裡哪些是真的重複、哪些是本來就有兩筆一樣的」。
```

**所以它直接拒絕，而不是給你錯的答案。**

> ✅ **這是一個【好】的設計**：它在你會拿到錯資料之前就爆掉。
> 對照 2.3.2 與 2.5.2 那兩個「靜默出錯」，這個例外反而是善意的。

### 2.8.4 三種解法

**① 改成 `Set`**

```java
@OneToMany(mappedBy = "order", cascade = CascadeType.ALL)
private Set<ItemTwoSets> items = new LinkedHashSet<>();

@OneToMany(mappedBy = "order", cascade = CascadeType.ALL)
private Set<NoteTwoSets> notes = new LinkedHashSet<>();
```

```
═══ 兩個 Set 同時 join fetch ═══
  ✅ 沒有拋 MultipleBagFetchException
  items=2  notes=2
── SQL → 共 1 句
   ×1  select ots1_0.id,...,i1_0.*,n1_0.* from orders ots1_0
       left join order_item i1_0 on ots1_0.id=i1_0.order_id
       left join order_note n1_0 on ots1_0.id=n1_0.order_id where ots1_0.id=?
```

⚠️⚠️ **但注意這句 SQL 撈回來的列數**：

```
  4 列（2 × 2 的笛卡兒積）—— Set 只是幫你【去重】，不是避免了它
```

🔴 **這是 `Set` 解法的隱藏代價**：
**20 筆明細 × 30 筆備註 = 600 列從資料庫傳到應用**，然後去重成 50 個物件。
**04 章 4.7 會回到這個問題**（`@BatchSize`、分兩次查）。

**② 分成兩句查**

```java
tx.executeWithoutResult(s -> {
    OrderTwoBags o = em.createQuery(
        "select o from OrderTwoBags o left join fetch o.items where o.id = :id",
        OrderTwoBags.class).setParameter("id", oid).getSingleResult();
    o.getNotes().size();          // 第二個集合另外載入
});
```

```
── SQL → 共 2 句
   ×1  select ... from orders otb1_0 left join order_item i1_0 on ... where otb1_0.id=?
   ×1  select n1_0.order_id,n1_0.id,n1_0.note from order_note n1_0 where n1_0.order_id=?
```

✅ **2 句 SQL，沒有笛卡兒積。** 資料量大時這通常是**更好**的選擇。

**③ 保持 `List`，但一次只 fetch 一個**——跟 ② 是同一件事，只是不用改實體。

### 2.8.5 那 01 章 1.14.2 的 `HashSet` 問題呢

01 章 1.14.2 實測過：**用 id 做 `hashCode` 的實體，存進資料庫之後會從自己的 `HashSet` 裡消失。**

**在 `@OneToMany` 的集合上，這個問題會不會發生？**

📌 **會——如果你用 `Set` 而且 `hashCode` 不穩定。**

```java
Set<OrderItem> items = new LinkedHashSet<>();
OrderItem item = new OrderItem(...);      // id == null（如果用 IDENTITY）
order.getItems().add(item);               // 放進去時 hashCode 用 null 算
em.flush();                               // id 變成 1，hashCode 變了
order.getItems().contains(item);          // 🔴 false
order.getItems().remove(item);            // 🔴 移除不掉 → orphanRemoval 也不會觸發
```

✅ **而本課的 `Base2`（= 01 章的 `BaseEntity`）已經解決了它**：

```java
/** ★ 常數 hashCode：id 變了也不會讓物件從 HashSet 裡「消失」。 */
@Override public final int hashCode() { return Hibernate.getClass(this).hashCode(); }
```

**加上 07 站選的「應用端指定 UUIDv7」——id 從物件建立那一刻就有、而且永不改變。**
**兩個保險，這個問題在本課不會發生。**

### 2.8.6 `List` 還是 `Set`：本課的選擇

| | `List`（Bag） | `Set` |
|---|---|---|
| 允許重複 | ✅ | 🔴 靠 `equals` 去重 |
| 保留順序 | 🟡 只在同一次查詢內（要順序得加 `@OrderBy`） | 🟡 用 `LinkedHashSet` + `@OrderBy` |
| 兩個一起 `join fetch` | 🔴 `MultipleBagFetchException` | ✅ |
| 笛卡兒積 | — | ⚠️ **一樣有**，只是被去重了 |
| 依賴 `equals`/`hashCode` | 🔴 不依賴 | ⚠️ **高度依賴**（2.8.5） |
| 移除一筆的成本 | O(n) | O(1) |

> 📌 **本課用 `List`**（01 章 1.16.5 那一行），理由是：
>
> **① 訂單只有一個一對多集合**（明細），碰不到 `MultipleBagFetchException`。
> **② `List` 不依賴 `equals`/`hashCode`**——少一個出錯的地方。
> **③ 明細本來就可能有「兩筆一模一樣的商品」**，`Set` 的語意反而是錯的。
>
> ⚠️ **如果你的實體有兩個以上的一對多集合，而且需要一起 fetch**——
> 那就改 `Set`，或用 2.8.4 的解法 ②。

---

## 2.9 `@ManyToMany`：為什麼本課不用它 ★

### 2.9.1 實測：`Set` 版與 `List` 版差很多

```java
@ManyToMany
@JoinTable(name = "product_tag",
           joinColumns = @JoinColumn(name = "product_id"),
           inverseJoinColumns = @JoinColumn(name = "tag_id"))
private Set<Tag> tags = new LinkedHashSet<>();      // 或 List<Tag>
```

**一個商品掛 5 個標籤，移除其中一個**：

```
═══ Set 版 ═══
  移除前 product_tag = 5 列
── 移除一個標籤 → 共 3 句
   ×1  select pmm1_0.id,... from product pmm1_0 where pmm1_0.id=?
   ×1  select t1_0.product_id,t1_1.id,t1_1.name from product_tag t1_0
       join tag t1_1 on t1_1.id=t1_0.tag_id where t1_0.product_id=?
   ×1  delete from product_tag where product_id=? and tag_id=?     ← ✅ 精準刪一列
  移除後 product_tag = 4 列

═══ 🔴 List 版 ═══
  移除前 product_tag = 5 列
── 移除一個標籤 → 共 7 句，4 種形狀
   ×1  select pmm1_0.id,... from product pmm1_0 where pmm1_0.id=?
   ×1  select t1_0.product_id,... from product_tag t1_0 join tag ... where t1_0.product_id=?
   ×1  delete from product_tag where product_id=?                  ← 🔴 全部刪掉
   ×4  insert into product_tag (product_id,tag_id) values (?,?)     ← 🔴 再插回去 4 筆
  移除後 product_tag = 4 列
```

🔴 **`List` 版：先把這個商品的所有關聯全刪，再重新插入剩下的。**

**原因跟 2.8.3 一樣**：Bag 允許重複，Hibernate 無法判斷「哪一列該刪」，
只好整組重來。

⚠️ **這在標籤有 500 個時，就是 1 句 `DELETE` + 499 句 `INSERT`。**
**而且那個 `DELETE FROM product_tag WHERE product_id = ?` 會鎖住整組列**（07 站 04 章）。

### 2.9.2 更根本的問題：中間表遲早會長出欄位

**`@ManyToMany` 的前提是「中間表只有兩個外鍵」。**

⚠️ **而這個前提，在真實專案裡的存活時間大約是六個月。**

```
「標籤要能排序」        → 中間表要一個 sort_order
「要記錄誰貼的、什麼時候」→ 要 tagged_by / tagged_at
「要能軟刪除」          → 要 deleted_at
```

**只要多一個欄位，`@ManyToMany` 就用不了了**，你得改成兩個一對多——
**而那是一次會動到所有呼叫端的改動。**

### 2.9.3 本課的做法：把中間表變成實體

```sql
CREATE TABLE product_tag_rel (
  id         BINARY(16)  NOT NULL,
  product_id BINARY(16)  NOT NULL,
  tag_id     BINARY(16)  NOT NULL,
  sort_order INT         NOT NULL DEFAULT 0,          -- ★ 中間表自己的欄位
  tagged_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_ptr (product_id, tag_id),
  CONSTRAINT fk_ptr_product FOREIGN KEY (product_id) REFERENCES product(id),
  CONSTRAINT fk_ptr_tag     FOREIGN KEY (tag_id)     REFERENCES tag(id)
) ENGINE=InnoDB;
```

```java
package com.example.lab.ch02;

import jakarta.persistence.*;
import java.util.UUID;

@Entity @Table(name = "tag")
public class Tag extends Base2 {
    @Column(nullable = false, length = 32) private String name;

    protected Tag() {}
    public Tag(UUID id, String name) { super(id); this.name = name; }
    public String getName() { return name; }
}
```

```java
package com.example.lab.ch02;

import jakarta.persistence.*;
import java.time.Instant;
import java.util.UUID;

/** ✅ 把中間表變成一個【實體】：它可以有自己的欄位。 */
@Entity @Table(name = "product_tag_rel")
public class ProductTagRel extends Base2 {

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "product_id", nullable = false)
    private ProductWithTags product;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "tag_id", nullable = false)
    private Tag tag;

    @Column(name = "sort_order", nullable = false) private int sortOrder;
    @Column(name = "tagged_at", insertable = false, updatable = false) private Instant taggedAt;

    protected ProductTagRel() {}
    ProductTagRel(UUID id, ProductWithTags product, Tag tag, int sortOrder) {
        super(id); this.product = product; this.tag = tag; this.sortOrder = sortOrder;
    }
    public Tag getTag() { return tag; }
    public int getSortOrder() { return sortOrder; }
    public Instant getTaggedAt() { return taggedAt; }
}
```

```java
package com.example.lab.ch02;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** ✅ 用兩個一對多取代 @ManyToMany。 */
@Entity @Table(name = "product")
public class ProductWithTags extends Base2 {
    @Column(nullable = false, length = 32) private String sku;
    @Column(nullable = false, length = 200) private String name;
    @Column(name = "unit_price", nullable = false, precision = 19, scale = 4) private BigDecimal unitPrice;

    @OneToMany(mappedBy = "product", cascade = CascadeType.ALL, orphanRemoval = true)
    private List<ProductTagRel> tagLinks = new ArrayList<>();

    protected ProductWithTags() {}
    public ProductWithTags(UUID id, String sku, String name, BigDecimal price) {
        super(id); this.sku = sku; this.name = name; this.unitPrice = price;
    }

    public void addTag(UUID linkId, Tag tag, int sortOrder) {
        tagLinks.add(new ProductTagRel(linkId, this, tag, sortOrder));
    }
    public void removeTag(Tag tag) {
        tagLinks.removeIf(l -> l.getTag().equals(tag));
    }
    public List<ProductTagRel> getTagLinks() { return tagLinks; }
}
```

**實測**：

```
═══ ✅ 中間實體版：移除一個標籤 ═══
  移除前 product_tag_rel = 5 列
── 移除一個標籤 → 共 8 句，4 種形狀
   ×1  select pwt1_0.id,... from product pwt1_0 where pwt1_0.id=?
   ×1  select tl1_0.product_id,tl1_0.id,tl1_0.sort_order,tl1_0.tag_id,tl1_0.tagged_at
       from product_tag_rel tl1_0 where tl1_0.product_id=?
   ×5  select t1_0.id,t1_0.name from tag t1_0 where t1_0.id=?        ← ⚠️ N+1
   ×1  delete from product_tag_rel where id=?                        ← ✅ 精準刪一列
  移除後 product_tag_rel = 4 列

  ★ 而且中間表可以有自己的欄位：
  [{sort_order=0, tagged_at=...}, {sort_order=1, ...}, {sort_order=3, ...}, {sort_order=4, ...}]
```

⚠️ **誠實地看那 5 句 `select tag`**：那是一個 N+1，來自 `removeTag` 裡的
`l.getTag().equals(tag)`——每個 `tag` 都是 lazy 代理，比較時被逐一初始化。

📌 **兩個修法**（04 章會完整處理）：
**① 改用 `l.getTag().getId().equals(tagId)`**——代理的 `getId()` 不需要初始化。
**② 查的時候 `join fetch tagLinks.tag`。**

**三種做法的對照**：

| | `@ManyToMany` + `Set` | `@ManyToMany` + `List` | **中間實體** |
|---|---|---|---|
| 移除一筆的 SQL | 3 句，精準 `DELETE` | 🔴 7 句，全刪重插 | 3 句，精準 `DELETE` |
| 中間表能有欄位嗎 | 🔴 不行 | 🔴 不行 | ✅ |
| 要多寫一個類別 | ✅ 不用 | ✅ 不用 | 🔴 要 |
| 需求變動時 | 🔴 要重寫 | 🔴 要重寫 | ✅ 加一個欄位就好 |

> 📌 **本課的立場**：
> **`@ManyToMany` 只在「中間表確定永遠只有兩個外鍵」時才用**——
> 例如「使用者 ↔ 角色」這種很穩定的關聯。
> **其他一律用中間實體。**
>
> ⚠️ **而且如果真的要用 `@ManyToMany`，一定要用 `Set`**（2.9.1 那 7 句 vs 3 句）。

---
## 2.10 雙向關聯 × Jackson ★★

**把一個有雙向關聯的實體直接回傳給前端，會遇到【三個不同的錯誤】**——
而且它們是有順序的：解掉一個，才會看到下一個。

### 2.10.1 錯誤一：代理沒有 Session

```java
// Service 回傳實體，Controller 序列化
Order2 o = tx.execute(s -> orders.findById(oid).orElseThrow());
mapper.writeValueAsString(o);
```

```
🔴 com.fasterxml.jackson.databind.JsonMappingException
   could not initialize proxy [Customer2#01a07a27-...] - no Session
   (through reference chain: Order2["customer"]->Customer2$HibernateProxy$He3wVVex["displayName"])
```

📌 **這是 00 章 0.3.4 那個 `LazyInitializationException` 的 Jackson 版**。
序列化會**碰到每一個 getter**，包含所有 lazy 的關聯。

### 2.10.2 錯誤二：Jackson 看不懂代理

**就算在交易內、而且先把關聯都初始化了**：

```java
tx.executeWithoutResult(s -> {
    Order2 o = orders.findById(oid).orElseThrow();
    Hibernate.initialize(o.getCustomer());
    o.getItems().forEach(i -> Hibernate.initialize(i.getOrder()));
    mapper.writeValueAsString(o);
});
```

```
🔴 com.fasterxml.jackson.databind.exc.InvalidDefinitionException
   No serializer found for class org.hibernate.proxy.pojo.bytebuddy.ByteBuddyInterceptor
   and no properties discovered to create BeanSerializer
   (through reference chain: Order2["customer"]->Customer2$HibernateProxy$...)
```

⚠️ **代理是一個子類別，它多了一個 `hibernateLazyInitializer` 屬性**——
Jackson 看到這個屬性，試著序列化它，然後爆掉。

**解法：註冊 `Hibernate6Module`**

```xml
<dependency>
  <groupId>com.fasterxml.jackson.datatype</groupId>
  <artifactId>jackson-datatype-hibernate6</artifactId>
</dependency>
```

```java
ObjectMapper mapper = new ObjectMapper()
        .registerModule(new com.fasterxml.jackson.datatype.hibernate6.Hibernate6Module());
```

### 2.10.3 錯誤三：無限遞迴

**現在代理的問題解決了。再試一次**：

```
🔴 com.fasterxml.jackson.databind.JsonMappingException
   Infinite recursion (StackOverflowError)
   (through reference chain:
    Order2["items"]
      ->PersistentBag[0]
      ->OrderItem2["order"]
      ->Order2["items"]
      ->PersistentBag[0]
      ->OrderItem2["order"]-> ...)
```

📌 **這就是雙向關聯的本質**：`order.items[0].order.items[0].order...`
**在物件圖裡這是一個環，而 JSON 是一棵樹。**

### 2.10.4 五種解法，與它們真正在解決什麼

| 解法 | 怎麼做 | 代價 |
|---|---|---|
| ① `@JsonIgnore` | 在 `OrderItem.order` 上加 | 🟡 那一側**永遠**不出現在 JSON 裡，連你想要的時候也不行 |
| ② `@JsonManagedReference` / `@JsonBackReference` | 一邊「管理」、一邊「背向」 | 🟡 同上，而且**只能有一組** |
| ③ `@JsonIdentityInfo` | 第二次出現時只輸出 id | 🟡 JSON 結構變得很奇怪，前端要處理 |
| ④ `@JsonView` | 依情境決定輸出哪些欄位 | 🟡 情境一多就爆炸 |
| ✅ ⑤ **不要序列化實體** | 轉成 DTO 再回傳 | 需要多寫一層 |

⚠️ **前四種都是「把實體修改成適合當 JSON」**，而這件事本身就是問題：

> 🔴 **`@JsonIgnore` 是一個【展示層的關注點】，被寫進了【持久化層的類別】。**
>
> 於是那個類別同時要滿足三組互相衝突的需求：
> **Hibernate 的（無參數建構子、不能 final）、
> Jackson 的（getter、避免遞迴）、
> 以及領域模型的（不變量、狀態機）。**
>
> **而每次前端改需求，你都要去改一個資料庫映射類別。**

### 2.10.5 本課的立場：實體不出資料層

**這正是 06 站 00 章 0.5 那張「抽象洩漏清單」與 06 站 03 章 3.5「Entity 不是領域模型」的延續**：

```
Controller  ←→  OrderResponse（DTO，03-rest-api 站設計的）
                     ↑ 轉換
Service     ←→  Order（領域物件）
                     ↑ 轉換（或就是同一個）
Repository  ←→  OrderEntity（JPA 實體）
```

📌 **只要實體不離開資料層，2.10 這一整節的問題【全部不存在】**：

```
✅ 沒有代理沒有 Session 的問題（DTO 是在交易內組好的）
✅ 沒有 Jackson 看不懂代理的問題（DTO 是普通 POJO）
✅ 沒有無限遞迴的問題（DTO 是一棵樹，你決定它長什麼樣）
✅ 而且前端要什麼欄位，跟資料庫有哪些欄位【解耦】了
```

⚠️ **代價是真的**：要多寫一層 DTO 與轉換。
**05 章 5.8 會示範用 JPQL 的建構子投影直接查出 DTO**——
那時候你會發現，**很多情境根本不需要先查實體再轉。**

> 📌 **一句話**：
> **`@JsonIgnore` 是在治症狀。症狀是「實體出現在它不該出現的地方」。**

---

## 2.11 該不該做成雙向

**看完 2.3 到 2.10，一個合理的問題是：那不要雙向不就好了？**

✅ **通常是的。單向應該是預設值。**

### 2.11.1 雙向的成本清單

```
① 要寫同步方法，而且不能有人繞過（2.3.4）
② 集合會過時，而且時機取決於幾行之前（2.4）
③ 反向側的 @OneToOne LAZY 無效（2.7.3）
④ 兩個以上的 List 不能一起 fetch（2.8.2）
⑤ Jackson 無限遞迴（2.10.3）
⑥ equals / hashCode 要小心（2.8.5）
```

### 2.11.2 什麼時候雙向是值得的

**判準**：

> **父物件需不需要「用集合來維護一個不變量」？**

```
✅ Order → items 值得雙向
   因為 07 站不變量 #3（總額 = 明細總和）與 #5（已付款不可加明細）
   都需要「訂單這一側看得到所有明細」（01 章 1.13）

🔴 Customer → orders 不值得
   客戶不需要為了維護任何不變量而知道自己有哪些訂單
   → 需要時用 orderRepository.findByCustomerId(id)

🔴 Product → orderItems 不值得（而且很危險）
   一個熱銷商品可能有幾百萬筆明細
```

⚠️ **`Customer → orders` 這種「看起來很自然」的雙向，是最常見的多餘關聯。**
它讓 `Customer` 這個實體背上一個**可能有幾萬筆**的集合，
而 99% 的程式碼只是想拿到客戶的名字。

### 2.11.3 本課 shop-service 的關聯全圖

```
customer  ←──────┐
                 │  @ManyToOne(LAZY, optional=false)   單向
              orders
                 │
                 │  @OneToMany(mappedBy, cascade=ALL, orphanRemoval=true)   雙向 ★
                 ↓
            order_item
                 │
                 │  @ManyToOne(LAZY, optional=false)   單向
                 ↓
              product
                 ↑
                 │  @OneToOne(LAZY) + @MapsId          單向（從 stock 這一側）
               stock
```

**四個關聯，只有一個是雙向的。**

| 關聯 | 方向 | 為什麼 |
|---|---|---|
| `orders → customer` | 單向 `@ManyToOne` | 訂單需要知道客戶；客戶不需要背著訂單集合（2.11.2） |
| `orders ↔ order_item` | **雙向** | 唯一需要雙向的：不變量 #3、#5 要靠集合守（01 章 1.13） |
| `order_item → product` | 單向 `@ManyToOne` | 明細需要商品；商品不需要背著明細集合 |
| `stock → product` | 單向 `@OneToOne` + `@MapsId` | 反向側的 LAZY 無效（2.7.3），所以不做反向 |

📌 **`stock` 這個選擇值得說明**：`Product` 上**沒有** `stock` 欄位。
要查一個商品的庫存，用 `stockRepository.findById(productId)`——
**因為它們共用主鍵，這一句是走主鍵索引的，成本跟走關聯一樣。**

### 2.11.4 單向時，怎麼拿到「另一側」

**單向不代表拿不到。它代表「用查詢拿，而不是用物件圖走」**：

```java
// 🔴 雙向：customer.getOrders()  —— 一個可能有幾萬筆的集合
// ✅ 單向：用 Repository 查，而且可以分頁
Page<Order> orders = orderRepository.findByCustomer(customer, PageRequest.of(0, 20));
```

> 📌 **這其實是 06 站 00 章 0.11.7 那條「不要 `findAll()`」的同一個道理**：
> **`customer.getOrders()` 就是一個偽裝成 getter 的 `findAll()`。**
> 它沒有分頁、沒有排序、沒有條件，而且看起來免費。

### 2.11.5 用唯讀的外鍵欄位，避開不必要的關聯

**很多時候你只需要一個 id，不需要整個關聯物件**（01 章 1.8.1 ③ 預告過）：

```java
@Entity @Table(name = "order_item")
public class ItemWithFk extends Base2 {

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "order_id", nullable = false)
    private OrderCasOrphan order;

    /** ★ 同一欄映射兩次：一次當關聯、一次當唯讀的 UUID。 */
    @Column(name = "order_id", insertable = false, updatable = false)
    private UUID orderId;
    // product 同理
}
```

```
═══ 只要 productId，不要整個 Product ═══
── 讀唯讀的 UUID 欄位 → 共 1 句   ✅
```

⚠️ **`insertable = false, updatable = false` 是必要的**——
同一個欄位映射兩次，只能有一個負責寫，否則 Hibernate 會抱怨重複的欄位。

📌 **不過在這個特定的例子上，還有一個更簡單的做法**：

```
═══ 只呼叫代理的 getId() ═══
  初始化了嗎（呼叫前）？ false
  proxy.getId() = 01a07a30-7700-77ed-a16f-32fc83abd8b8
  初始化了嗎（getId 後）？ false        ← ✅ 沒有初始化
── SQL → 共 1 句

═══ 對照：呼叫 getName() ═══
  proxy.getName() = 鍵盤
  初始化了嗎？ true
── SQL → 共 2 句                        ← 🔴 多一句
```

> ✅ **代理的 `getId()` 不需要初始化**——因為外鍵的值本來就在手上。
> **所以 `item.getProduct().getId()` 是免費的，`item.getProduct().getName()` 不是。**
>
> **這讓 2.9.3 那個 N+1 有了一個一行的修法**：
> `l.getTag().equals(tag)` → `l.getTag().getId().equals(tagId)`。

---

## 2.12 shop-service 的關聯定案

01 章 1.16 交出了一組 `validate` 通得過的實體。**這一節把 02 章的結論套回去，並補上兩個缺口。**

### 2.12.1 01 章那組實體，已經符合這一章的哪些結論

| 這一章的規則 | 01 章 1.16 的實體 |
|---|---|
| 每個 `@ManyToOne` 都要 `fetch = LAZY`（2.7.2） | ✅ 三個關聯都有 |
| `optional = false`（07 站不變量 #2） | ✅ |
| `@OneToMany` 用 `mappedBy` + `cascade = ALL` + `orphanRemoval`（2.5、2.6） | ✅ |
| 加明細時**兩邊都要設**（2.3） | ✅ **但寫法不一樣**，見下 |
| 集合的 getter 是唯讀的（2.3.4 設計要點 ②） | ✅ `Collections.unmodifiableList` |

⚠️ **「寫法不一樣」值得說清楚**。2.3.4 用的是 setter：

```java
public void addItem(OrderItem2 item) {
    items.add(item);
    item.setOrder(this);          // ← 用 setter 設擁有方
}
```

**而 01 章 1.16 用的是【建構子】**：

```java
// Order（01 章 1.16.5）
public OrderItem addItem(UUID itemId, Product product, int qty) {
    requireStatus(OrderStatus.PENDING, "只有 PENDING 的訂單可以加明細");
    OrderItem item = new OrderItem(itemId, this, product, qty);   // ★ this 傳進建構子
    items.add(item);
    totalAmount = totalAmount.add(item.getLineAmount());
    return item;
}

// OrderItem（01 章 1.16.6）
OrderItem(UUID id, Order order, Product product, int qty) {
    super(id);
    this.order = order;                                            // ★ 擁有方在這裡設好
    // ...
}
```

✅ **兩者效果相同，而建構子版本更好**：

```
① 沒有 setOrder 這個方法 → 【不可能】只設一邊（2.3.2 的三種寫法只剩正確的那一種）
② OrderItem 一出生就是完整的 → 不存在「order 還是 null」的中間狀態
③ 建構子是 package-private → 只有同一個聚合裡的 Order 叫得動它
```

📌 **2.3.4 之所以用 setter 版，是因為要示範「少寫一行會怎樣」**——
**正式的設計應該用建構子版，讓那一行不可能被少寫。**

### 2.12.2 缺口一：`Order` 少了 `removeItem`

2.6.3 那段 diff 的程式碼呼叫了 `o::removeItem`，**而 01 章 1.16.5 沒有這個方法**。補上：

```java
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
```

⚠️ **注意註解裡那句「不需要 `item.setOrder(null)`」**——這跟 2.3.4 的 `removeItem` 不一樣。
**因為建構子版的 `OrderItem` 根本沒有 setter**，而 `orphanRemoval` 是靠「從集合移除」觸發的
（2.3.3 對照 ① 實測：只從集合移除，`DELETE` 照樣發出）。

### 2.12.3 缺口二：`Stock` 實體

01 章 1.2.1 說「`stock` 交給 02 章處理」。**依 2.7.3 與 2.11.3 的結論，它是【單向】的**：

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

    public UUID getProductId() { return productId; }
    public Product getProduct() { return product; }
    public int getQty() { return qty; }
    public int getReservedQty() { return reservedQty; }
}
```

📌 **三個決定**：

```
① @MapsId          → 主鍵就是外鍵（07 站 1.12 的共用主鍵設計）
② optional = false → stock 一定有 product（外鍵的方向保證了這件事）
③ Product 上【沒有】stock 欄位 → 反向側的 LAZY 無效（2.7.3），所以不做反向
```

```java
package com.example.lab.shop;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.UUID;

public interface StockRepository extends JpaRepository<Stock, UUID> {}
```

### 2.12.4 驗收

```
═══ ① 加了 Stock 之後，validate 仍然通過 ═══

═══ ② Stock：@MapsId 共用主鍵 ═══
── 建客戶 + 商品 + 庫存 → 共 3 句，3 種形狀
   ×1  insert into customer (...) values (...)
   ×1  insert into product (...) values (...)
   ×1  insert into stock (qty,reserved_qty,version,product_id) values (?,?,?,?)
  DB stock: [{qty=500, reserved_qty=0, version=0}]

═══ ③ 讀庫存：單向、走主鍵 ═══
── stocks.findById(productId) → 共 1 句      ← ✅ 跟走關聯一樣便宜

═══ ④ addItem 靠建構子設擁有方 ═══
── 建訂單 + 2 筆明細 → 共 4 句，3 種形狀
   ×1  select ... from product ...           ← 快照要讀 name / unit_price
   ×1  insert into orders (...)
   ×2  insert into order_item (...)
  DB: [{order_no=SO-2026-00000001, total_amount=500.0000, n=2}]

═══ ⑤ removeItem + orphanRemoval ═══
── 移除一筆明細 → 共 4 句，4 種形狀
   ×1  update orders set ...,total_amount=?,version=? where id=? and version=?
   ×1  delete from order_item where id=?
  DB: [{order_no=SO-2026-00000001, total_amount=300.0000, n=1}]   ← ✅ 總額跟著降

═══ ⑥ getItems() 是唯讀的，繞不過 removeItem ═══
  ✅ UnsupportedOperationException —— 只能走 removeItem()
```

⚠️⚠️ **⑤ 與 ⑥ 合起來，就是這一章與 01 章 1.13 的交集**：

> **`removeItem()` 同時做了兩件事**：從集合移除（讓 `orphanRemoval` 發 `DELETE`）、
> 以及更新 `totalAmount`（守住 07 站不變量 #3）。
>
> **而 ⑥ 保證了「沒有人能繞過它」**——
> `getItems()` 回傳唯讀清單，直接 `remove()` 會拋 `UnsupportedOperationException`。
>
> 🔴 **如果 getter 回傳的是原本那個 `List`，2.4 那個「集合過時」與
> 「`totalAmount` 永遠算錯」就會從「要小心」變成「遲早發生」。**

---

## 2.13 常見誤區

**誤區 1：「加到集合裡就會存進去」**

→ 2.3.2：只 `items.add(item)`、沒有 `item.setOrder(this)`，
`INSERT` 會送出去，**而 `order_id` 是 `null`**。
本課的 schema 有 `NOT NULL` 擋住它；**沒有那個約束的話，你會得到一筆孤兒明細。**

**誤區 2：「`mappedBy` 是設在有外鍵的那一側」**

→ 反了。**`mappedBy` 設在【沒有】外鍵的那一側**，
它的意思是「我不管外鍵，去看對方那個欄位」。

**誤區 3：「集合就是資料庫的現況」**

→ 2.4：集合一旦被初始化，**就不會再更新**。
而 2.4.1 更糟：**它會不會過時，取決於幾行之前有沒有人碰過它。**

**誤區 4：「`cascade = ALL` 就包含了 `orphanRemoval`」**

→ 2.6.2：`cascade = ALL`（含 `REMOVE`）之下，
從集合移除一筆明細——**什麼都沒發生**。
`REMOVE` 管的是「刪父物件」，`orphanRemoval` 管的是「從集合移除」。

**誤區 5：「在 `@ManyToOne` 上設 `cascade = ALL` 比較保險」**

→ 2.5.4：`em.remove(order)` 會**連帶刪掉那個客戶**——而他還有 50 張別的訂單。
**`cascade` 的邊界就是聚合的邊界。**

**誤區 6：「JPA 更新明細是全刪重插，所以效能很差」**

→ 2.6.3：**兩種都會，取決於你怎麼寫。**
改物件 → 1 句 `UPDATE`；`clear()` 之後重建 → 5 刪 5 插。
**問題不在 JPA，在「從 DTO 重建聚合」那個寫法。**

**誤區 7：「不寫 `fetch` 就是 `LAZY`」**

→ 2.7.1：`@OneToMany` 與 `@ManyToMany` 是 `LAZY`，
**而 `@ManyToOne` 與 `@OneToOne` 是 `EAGER`**。
2.7.2 實測：撈 1 筆明細打 3 句 SQL，而程式碼什麼關聯都沒碰。

**誤區 8：「寫了 `fetch = LAZY` 就一定是 lazy」**

→ 2.7.3：**`@OneToOne` 的反向側（`mappedBy`），`LAZY` 永遠無效。**
因為「有沒有」這件事不查就不知道。

**誤區 9：「`List` 跟 `Set` 只是喜好問題」**

→ 2.8.2：兩個 `List` 一起 `join fetch` → `MultipleBagFetchException`。
→ 2.9.1：`@ManyToMany` 用 `List` 移除一筆 → **全刪重插（7 句 vs 3 句）**。

**誤區 10：「改成 `Set` 就解決了笛卡兒積」**

→ 2.8.4：**沒有。** `Set` 只是幫你去重，
**那 4 列（20 × 30 = 600 列）還是從資料庫傳過來了。**

**誤區 11：「`@JsonIgnore` 是無限遞迴的正解」**

→ 2.10.4：它是在治症狀。而且在你看到遞迴之前，
還有**兩個更早的錯誤**（代理沒 Session、Jackson 看不懂代理）。
**正解是實體不要離開資料層。**

**誤區 12：「關聯做成雙向比較方便，反正用不到就不碰」**

→ 2.11.1：雙向有六項成本，而且**每一項都是在你「不碰它」的時候發作的**。
**單向應該是預設值；做成雙向要有理由**（本課只有 `orders ↔ order_item` 一個）。

---

## 2.14 本章小結

**這一章的主線，用一句話講**：

> **資料庫只有一個 `order_id`，Java 有 `order.items` 與 `item.order` 兩個方向——
> 這一章所有的坑，都是這個落差造成的。**

**九個實測，收斂成三個形狀**：

```
① 「Hibernate 只看擁有方」
   → 2.3.2 少設反向 → order_id 是 null
   → 2.6.2 從集合移除 → 沒有 orphanRemoval 就什麼都沒發生
   → 2.4   集合是反向側 → 它過時了也不影響 SQL

② 「集合是延遲載入的，而它只載入一次」
   → 2.4.1 同一段程式碼兩種答案
   → 2.7.2 @ManyToOne 的 EAGER 讓你在「還沒決定要不要用」時就付錢
   → 2.8.2 一次 fetch 兩個 bag，Hibernate 無法還原

③ 「JPA 的操作單位是物件，資料庫的是集合」
   → 2.5.3 刪一張訂單 = N 句 DELETE
   → 2.6.3 clear() 重建 = 5 刪 5 插（而 diff 只要 1 句 UPDATE）
   → 2.9.1 @ManyToMany 的 List 版 = 全刪重插
```

**如果只能帶走三句話**：

> **① 雙向關聯要兩邊都設，而且要包成方法、不能靠人記得。**
> `setOrder` 是 package-private、集合的 getter 是唯讀的——
> **讓「只設一邊」在編譯期就做不到。**
>
> **② 每一個 `@ManyToOne` / `@OneToOne` 都要明確寫 `fetch = LAZY`。**
> 預設值是 `EAGER`，而它會在你什麼都沒做的時候多打 N 句 SQL。
>
> **③ 單向是預設值，雙向要有理由。**
> 判準是「父物件需不需要用集合來維護一個不變量」。
> 本課四個關聯，只有 `orders ↔ order_item` 一個是雙向的。

---

### 2.14.1 驗收清單

**概念**：

```
□ 說得出「擁有方」是什麼，以及 mappedBy 那個字串指的是什麼
□ 說得出「只 add 到集合」與「只設擁有方」各自會發生什麼
□ 說得出集合什麼時候會過時，以及為什麼它取決於幾行之前
□ 說得出 cascade = REMOVE 與 orphanRemoval 的差別
□ 說得出四種關聯的預設 fetch，以及哪兩個是危險的
□ 說得出 @OneToOne 反向側的 LAZY 為什麼無效
□ 說得出 MultipleBagFetchException 的成因與三種解法
□ 說得出為什麼 @ManyToMany 用 List 會全刪重插
□ 說得出「把實體回傳給前端」會遇到的三個錯誤，以及正解為什麼是 DTO
□ 說得出一個關聯該不該做成雙向的判準
```

**動手**：

```
□ 重現 2.3.2：拿掉 item.setOrder(this)，確認 order_id cannot be null
□ 重現 2.4.1：同一段程式碼，加一行 o.getItems().size() 讓後面的行為改變
□ 重現 2.5.2：拿掉 cascade，確認 save(order) 之後 order_item = 0 而且【沒有例外】
□ 重現 2.6.2：cascade=ALL 但沒有 orphanRemoval，從集合移除一筆 → 什麼都沒發生
□ 重現 2.6.3：同一個需求，用 clear() 重建（14 句）與只改一筆（3 句）各跑一次
□ 重現 2.7.2：拿掉 fetch = LAZY，確認撈 1 筆明細變成 3 句 SQL
□ 重現 2.8.2：加第二個 List 集合，一起 join fetch，看 MultipleBagFetchException
□ 重現 2.9.1：@ManyToMany 的 Set 版與 List 版各移除一個標籤，數 SQL
□ 【重點】重現 2.10：依序解掉三個 Jackson 錯誤，體會「解一個才看到下一個」
```

### 2.14.2 本章練習

**練習一（暖身）：把 2.5.3 的刪除改成一句 SQL**

`cascade = REMOVE` 刪一張有 5000 筆明細的訂單，會打 5002 句 SQL。
**用 JPQL 的批次刪除改寫它**：

```java
@Modifying
@Query("delete from OrderItem i where i.order.id = :orderId")
int deleteItemsByOrderId(@Param("orderId") UUID orderId);
```

**然後回答**：
- 這樣做之後，持久化情境裡那些已經載入的 `OrderItem` 物件會怎樣？（提示：03 章的一級快取）
- 為什麼 `@Modifying` 通常要配 `clearAutomatically = true`？

**練習二：把 2.3.4 的同步方法變成一條測試**

寫一個測試，斷言「`Order` 的每一個修改集合的方法，都同時維護了兩邊」：

```java
@Test
void addItem_必須同時設好兩邊() {
    Order o = new Order(...);
    OrderItem it = new OrderItem(...);
    o.addItem(it);
    assertThat(o.getItems()).contains(it);
    assertThat(it.getOrder()).isSameAs(o);      // ★ 這一行是重點
}
```

**再寫一條 ArchUnit 規則**：`OrderItem` 不可以有 `public` 的 `setOrder`。

**練習三：量一次笛卡兒積的真實代價**

2.8.4 說「`Set` 只是幫你去重，笛卡兒積還在」。**把它量出來**：

```
建一張有 20 筆明細、30 筆備註的訂單
① 兩個 Set 一起 join fetch → 量 SQL 回傳的列數與耗時
② 分成兩句查 → 同樣量一次
```

**判準**：什麼時候 ① 比較快？什麼時候 ②？（提示：跟「兩個集合的大小乘積」有關）

**練習四（進階）：把 2.6.3 的 diff 寫完並測試**

2.6.3 給了一段 diff 的骨架。把它寫完，然後用 `SqlSpy` 斷言：

```
① 完全沒改 → 0 句 UPDATE / INSERT / DELETE
② 只改一筆數量 → 1 句 UPDATE
③ 新增一筆 → 1 句 INSERT
④ 刪掉一筆 → 1 句 DELETE
⑤ 200 筆明細，改其中 1 筆 → 總 SQL 句數【不隨明細數成長】
```

⚠️ **⑤ 是重點**——它就是 00 章 0.10.3 那條「句數不隨資料量成長」的斷言。

**練習五（思考題）：`Customer → orders` 到底該不該做**

2.11.2 說它「不值得」。但實務上總會有人提出需求：
「客戶詳情頁要顯示他最近 5 張訂單」。

**要回答的問題**：
- 用 `customer.getOrders()` 拿最近 5 張，會發生什麼？
- 如果加上 `@OrderBy("placedAt DESC")`，情況會變好嗎？
- Hibernate 有一個 `@BatchSize`，它能解決這件事嗎？
- 為什麼 `orderRepository.findTop5ByCustomerOrderByPlacedAtDesc(customer)` 是更好的答案？

📌 **這一題的答案會在 04 章 4.8 完整展開**（分頁 + 集合的陷阱）。

---

## 2.15 下一章預告

**03 章：持久化情境（核心章）。**

這兩章一直在用一些沒有解釋的詞：

```
「持久化情境」    「髒檢查」      「一級快取」
「flush」        「代理」        「detached」
```

**而且這兩章有五個地方，答案都是「因為持久化情境是這樣運作的」**：

| 這兩章留下的 | 03 章怎麼回答 |
|---|---|
| 00 章 0.3.1：沒呼叫 `save()`，資料卻改了 | **3.4 髒檢查**：它比對的是什麼、什麼時候比對 |
| 2.4.1：集合過不過時，取決於幾行之前 | **3.3 一級快取**：實體與集合的載入狀態 |
| 2.6.3：`clear()` 重建 = 5 刪 5 插 | **3.4**：diff 是在「物件實例」層次做的 |
| 2.6.3：設回同一個值 → 0 句 `UPDATE` | **3.4**：快照比對 |
| 00 章 0.3.3：`save()` 多一句 `SELECT` | **3.6 `persist` vs `merge`**：兩者的完整差異 |

**還有三個這兩章刻意沒碰的**：

```
① 實體的【四種狀態】：transient / managed / detached / removed
   —— 2.10.1 那個「no Session」就是 detached 狀態
② flush 的三個時機，以及「SQL 送出的順序 ≠ 你程式碼的順序」
③ 一級快取讓 findById 不打 SQL —— 而它什麼時候會【騙你】
```

📌 **03 章是這一站的轉折點**：
00～02 章都在講「怎麼把東西對應起來」，
**03 章開始講「這個東西在執行期到底怎麼運作」**——
而 04 章那個 N+1（00 章 0.3.2 的 251 句 SQL）**要等到 03 章講完才修得動。**
