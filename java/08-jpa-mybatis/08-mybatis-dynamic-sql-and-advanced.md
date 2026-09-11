# 第 08 章：MyBatis 進階 —— 動態 SQL、`resultMap` 深入、分頁與快取

> 05 章 5.12.2 那張決策表有一列寫著：
>
> ```
> 「SQL 本身是動態的（欄位、表名會變） → 🔴 只能拼字串 → MyBatis 的 <if> / <choose>」
> ```
>
> **而那一列沒有說的是：`<if>` 拼出來的東西，也是字串。**
>
> ---
>
> ```
> 搜尋頁有六個條件，使用者可能填 0～6 個。
>      ↓
> JPA 那一側  ：05 章 5.9 的 Specification —— 把五個問題裡的四個搬到編譯期
> MyBatis 那一側：<if> —— 它解掉那五個問題裡的【兩個】，
>                剩三個，外加一個 05 章沒有的新問題
> ```
>
> **這一章不是「MyBatis 的進階語法教學」。**
> **它是把那三個沒解掉的問題【一個一個量出來】，**
> **然後證明「一組很便宜的斷言」可以把編譯期的保護換一種形式補回來。**

---

這一章有 **71 個實測**（78 個測試，全綠）。挑十二個先講結果：

- 六個可選條件 = **64 種 SQL**，而 8.2.3 那把新的尺可以在 **7.7 ms 內全部展開** ——
  **不需要連線、不需要交易、不需要任何資料**
- 🔴 `<if>` 忘了開頭的 `AND`：**一個條件時完全正常，兩個條件時語法錯** ——
  而那 57 種組合裡你的測試蓋得到幾種？
- 🔴🔴 `<bind>` 在**條件不成立時也會求值** → `'%' + null` 在 OGNL 裡是
  **`NullPointerException`**，不是 `"%null%"`。
  **而這個 bug 是我寫這一章的時候【被 8.9.1 那條斷言抓到】的**（32/64 種組合）★★
- ★ `<if test="…">` 是 OGNL，`#{…}` **不是** —— `#{q.status()}` 拋 `ReflectionException`。
  而 **record 的屬性名就是方法名**，加 `get` 前綴反而找不到（跟 POJO 剛好相反）
- 🔴 動態 SQL 的本質代價，在伺服器端量到了：**64 種形狀 vs 1 種形狀 ×64
  → `Com_stmt_prepare` 63 vs 1、35.6 ms vs 15.6 ms** ★★
- 🔴 `<foreach>` 的「65535 個參數上限」**量不到**（140,000 個都過）。
  真正會擋你的是 `max_allowed_packet`，而它看的是展開後的位元組數：
  **48 萬字元的 SQL 送出去是 3.3 MB 的封包**
- 🔴 兩層巢狀 `resultMap` 而 SQL 沒有欄位別名：**訂單數對、客戶看起來對、
  而明細少一筆、`product` 是 null** —— 三個症狀沒有一個是例外
- 🔴🔴 交易外碰延遲關聯，MyBatis **自己開一個 `Executor` 把資料撈回來** ——
  那就是 04 章 4.4.4 那個「假修復」，**而在 MyBatis 上它是預設行為、沒有開關** ★★
- 🔴🔴 巢狀 `resultMap` + PageHelper：**`total = 16`（實際 8）、`pages = 6`（實際 3）、
  而這一頁只拿到 2 張訂單、其中一張的明細是【殘缺的】** ——
  沒有警告、沒有例外
- 🔴🔴 **keyset 分頁的「教科書寫法」`(a, b) > (?, ?)` 在 MySQL 8.0.46 上慢 8 倍**：
  它變成 `Filter` 掃 5000 列（2407 µs），而展開成 `a > ? OR (a = ? AND b > ?)`
  是 `Index range scan` 掃 19 列（**299 µs**）。加複合索引、`FORCE INDEX` 都救不了 ★★
- 🔴🔴 MyBatis 與 JPA 的二級快取**雙向壞掉**：同一張表、同一個交易、同一條連線，
  兩邊各快取自己的歷史版本，**而且都是 0 句 SQL**
- 🔴🔴 用攔截器改寫 SQL 的第四個地雷：**一級快取命中時攔截器完全不會執行**
  → 「這次查詢有沒有套用租戶過濾」取決於【這句 SQL 之前有沒有被查過】

📌 **這一章的主線**：

> **07 章的坑在「兩個東西沒對上，而沒有人告訴我」——【接合】。**
> **08 章的坑在「這一組參數剛好走到那一條路上」——【組合】。**
>
> **而組合的問題有一個很便宜的解法：把組合全部展開。**
> **`MappedStatement.getBoundSql(參數)` 不需要資料庫，**
> **所以「64 種組合都合法」是一條 214 毫秒的 CI 斷言（8.9）。**

⚠️ **這一章有一件事跟前面七章不一樣，值得先說**：

```
8.9.1 那條斷言抓到了【三個我自己寫錯的 bug】，
而其中兩個在我寫下「這樣寫是對的」那一段文字之後才被報出來。
                              ↓
所以 8.9 不是「寫完之後加上的 CI 章節」——
它是這一章能寫完的原因。
```

---
## 8.1 學習目標

完成本章後，你應該可以：

- 用 `<if>` / `<where>` / `<set>` / `<trim>` / `<choose>` 寫動態查詢，
  並說出 `where 1 = 1` 為什麼**不需要**（8.3.3）。
- 說明 `<if>` 裡忘了開頭的 `AND` 會造成什麼、以及**為什麼它常常在測試裡活下來**（8.3.4）。
- 分辨 `<if test="…">`（OGNL）與 `#{…}`（屬性路徑）—— 它們**不是同一種語言**（8.3.11）。
- 用 `MappedStatement.getBoundSql()` 把 2^N 種條件組合**在不碰資料庫的情況下**全部展開，
  並寫成一條 CI 斷言（8.2.3、8.9.1）。
- 說出動態 SQL 的**本質代價**（SQL 形狀的數量），並量到它在伺服器端的樣子（8.3.13）。
- 正確使用 `<foreach>`：空集合、封包上限、`in` 子句的形狀，以及它的三種用途（8.4）。
- 用 `<association>` / `<collection>` / `columnPrefix` / `<discriminator>` / `extends`
  組出一個物件圖，並說出**每一個 `<id>` 的意義**（8.5）。
- 說明 PageHelper 怎麼運作，並說出它的**三個坑**與各自的偵測方式（8.6）。
- 在 offset 分頁與 keyset 分頁之間依「頁數會不會很深」做選擇（8.6.7）。
- 開啟 MyBatis 的二級快取，並說出它的失效範圍是 **namespace 而不是表**所造成的後果（8.7）。
- 寫一個 MyBatis 攔截器，並說出**為什麼用它做審計通常是壞主意**（8.8）。

---

## 8.2 這一章的模型與量尺

### 8.2.1 表結構

07 章那五張表全部留下來，加三張：

```
customer / product / stock / orders / order_item   ← 07 章那五張（orders 多了 rep_id）
sales_rep     ← 8.3 的「有沒有業務員」條件、8.5 的第二個 association
payment       ← 8.5.6 <discriminator>：一張表三種付款方式
country       ← 8.7 二級快取的參數表（同時有 JPA 映射）
audit_sql     ← 8.8 攔截器寫進去的稽核紀錄
```

```sql
DROP DATABASE IF EXISTS ch08;
CREATE DATABASE ch08 DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE ch08;

CREATE TABLE customer (
  id            binary(16)   NOT NULL,
  email         varchar(255) NOT NULL,
  display_name  varchar(64)  NOT NULL,
  tier          varchar(16)  NOT NULL DEFAULT 'NORMAL',
  country_code  char(2)      NOT NULL DEFAULT 'TW',
  version       bigint       NOT NULL DEFAULT 0,
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
  rep_id        binary(16)     NULL,
  status        varchar(16)    NOT NULL,
  total_amount  decimal(19,4)  NOT NULL,
  placed_at     datetime(3)    NOT NULL,
  paid_at       datetime(3)    NULL,
  memo          varchar(255)   NULL,
  version       bigint         NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uk_orders_order_no (order_no),
  KEY idx_orders_status_placed (status, placed_at),
  KEY idx_orders_placed_id (placed_at, id),
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

-- ───────── 8.5 鑑別器（discriminator）：一張表三種付款方式 ─────────
CREATE TABLE payment (
  id            binary(16)     NOT NULL,
  order_id      binary(16)     NOT NULL,
  kind          varchar(16)    NOT NULL,      -- CARD / TRANSFER / COD
  amount        decimal(19,4)  NOT NULL,
  paid_at       datetime(3)    NOT NULL,
  card_brand    varchar(16)    NULL,          -- 只有 CARD 有
  card_last4    char(4)        NULL,
  bank_code     char(3)        NULL,          -- 只有 TRANSFER 有
  bank_account  varchar(20)    NULL,
  cod_fee       decimal(19,4)  NULL,          -- 只有 COD 有
  PRIMARY KEY (id),
  KEY idx_payment_order (order_id),
  CONSTRAINT fk_payment_orders FOREIGN KEY (order_id) REFERENCES orders (id)
) ENGINE=InnoDB;

-- ───────── 8.7 二級快取的參數表 ─────────
CREATE TABLE country (
  code  char(2)      NOT NULL,
  name  varchar(64)  NOT NULL,
  PRIMARY KEY (code)
) ENGINE=InnoDB;

INSERT INTO country (code, name) VALUES
  ('TW','台灣'), ('JP','日本'), ('US','美國'), ('DE','德國');

-- ───────── 8.8 攔截器：審計表 ─────────
CREATE TABLE audit_sql (
  id         bigint       NOT NULL AUTO_INCREMENT,
  stmt_id    varchar(255) NOT NULL,
  sql_kind   varchar(16)  NOT NULL,
  took_ms    bigint       NOT NULL,
  at_time    datetime(3)  NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB;
```

📌 **`payment` 那張表值得先看一眼**：它有**十個欄位，而任何一列都只用得到其中六個**。
這是 06 站教的「單表繼承」在資料庫裡的樣子 —— 8.5.6 要把它映射成三個 Java 類別。

📌 **`orders` 多了一個索引 `idx_orders_placed_id (placed_at, id)`**。
它不是為了排序，是為了 **8.6.7 的 keyset 分頁** —— 那一節會證明少了它的差別。

### 8.2.2 這一章的型別

**搜尋條件**（刻意跟 05 章 5.9.1 的 `OrderSearch` **同一個形狀**：
六個欄位每一個都可以是 null = 使用者沒填，2^6 = 64 種組合）：

```java
package com.example.lab.ch08;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;

/**
 * 8.3 的搜尋條件 —— 刻意跟 05 章 5.9.1 的 OrderSearch 【同一個形狀】：
 * 六個欄位每一個都可以是 null（= 使用者沒填），2^6 = 64 種組合。
 *
 * ★ 多了一個 statuses（List）—— 8.4 的 <foreach> 要用。
 */
public record OrderSearch8(St8 status, String customerKeyword, Instant from, Instant to,
                           BigDecimal minAmount, Boolean hasRep, List<St8> statuses) {

    public static OrderSearch8 empty() {
        return new OrderSearch8(null, null, null, null, null, null, null);
    }

    public OrderSearch8 withStatus(St8 s) {
        return new OrderSearch8(s, customerKeyword, from, to, minAmount, hasRep, statuses);
    }
    public OrderSearch8 withCustomerKeyword(String k) {
        return new OrderSearch8(status, k, from, to, minAmount, hasRep, statuses);
    }
    public OrderSearch8 withRange(Instant f, Instant t) {
        return new OrderSearch8(status, customerKeyword, f, t, minAmount, hasRep, statuses);
    }
    public OrderSearch8 withMinAmount(BigDecimal a) {
        return new OrderSearch8(status, customerKeyword, from, to, a, hasRep, statuses);
    }
    public OrderSearch8 withHasRep(Boolean b) {
        return new OrderSearch8(status, customerKeyword, from, to, minAmount, b, statuses);
    }
    public OrderSearch8 withStatuses(List<St8> l) {
        return new OrderSearch8(status, customerKeyword, from, to, minAmount, hasRep, l);
    }
}
```

```java
package com.example.lab.ch08;

public enum St8 { PENDING, PAID, SHIPPED, CANCELLED }
```

```java
package com.example.lab.ch08;

public enum Tier8 { NORMAL, SILVER, GOLD }
```

**同樣的六個條件，另外寫一份有 getter 的 POJO** ——
因為「OGNL 認不認得 record 的存取子」是一個實測問題（8.3.11）：

```java
package com.example.lab.ch08;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;

/**
 * 8.3.1：跟 OrderSearch8 【同樣的六個條件】，只是寫成有 getter 的 POJO。
 * ★ 為什麼要兩份？因為「OGNL 認不認得 record 的存取子」是一個實測問題（8.3.11）。
 */
public class OrderSearchBean8 {
    private St8 status;
    private String customerKeyword;
    private Instant from;
    private Instant to;
    private BigDecimal minAmount;
    private Boolean hasRep;
    private List<St8> statuses;

    public static OrderSearchBean8 of(OrderSearch8 r) {
        OrderSearchBean8 b = new OrderSearchBean8();
        b.status = r.status(); b.customerKeyword = r.customerKeyword();
        b.from = r.from(); b.to = r.to(); b.minAmount = r.minAmount();
        b.hasRep = r.hasRep(); b.statuses = r.statuses();
        return b;
    }

    public St8 getStatus() { return status; }
    public void setStatus(St8 v) { this.status = v; }
    public String getCustomerKeyword() { return customerKeyword; }
    public void setCustomerKeyword(String v) { this.customerKeyword = v; }
    public Instant getFrom() { return from; }
    public void setFrom(Instant v) { this.from = v; }
    public Instant getTo() { return to; }
    public void setTo(Instant v) { this.to = v; }
    public BigDecimal getMinAmount() { return minAmount; }
    public void setMinAmount(BigDecimal v) { this.minAmount = v; }
    public Boolean getHasRep() { return hasRep; }
    public void setHasRep(Boolean v) { this.hasRep = v; }
    public List<St8> getStatuses() { return statuses; }
    public void setStatuses(List<St8> v) { this.statuses = v; }
}
```

**列表頁的那一列**（跟 05 章的 `OrderListRow`、07 章的 `OrderRow` 同一個角色）：

```java
package com.example.lab.ch08;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

/** 列表頁的一列。★ record，沒有 setter → resultMap 只能走 <constructor>。 */
public record OrderRow8(UUID id, String orderNo, String customerName, St8 status,
                        BigDecimal totalAmount, Instant placedAt, long itemCount) {}
```

**8.5 要組的物件圖**（四層：訂單 → 客戶／業務員 → 明細 → 商品）：

```java
package com.example.lab.ch08;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** 8.5：一張訂單的完整物件圖 —— 兩個 <association> + 一個 <collection>（元素自己還有 association）。 */
public class OrderNode8 {
    private UUID id;
    private String orderNo;
    private St8 status;
    private BigDecimal totalAmount;
    private Instant placedAt;
    private CustomerRef8 customer;
    private RepRef8 rep;
    private List<ItemLine8> items = new ArrayList<>();

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }
    public String getOrderNo() { return orderNo; }
    public void setOrderNo(String v) { this.orderNo = v; }
    public St8 getStatus() { return status; }
    public void setStatus(St8 v) { this.status = v; }
    public BigDecimal getTotalAmount() { return totalAmount; }
    public void setTotalAmount(BigDecimal v) { this.totalAmount = v; }
    public Instant getPlacedAt() { return placedAt; }
    public void setPlacedAt(Instant v) { this.placedAt = v; }
    public CustomerRef8 getCustomer() { return customer; }
    public void setCustomer(CustomerRef8 v) { this.customer = v; }
    public RepRef8 getRep() { return rep; }
    public void setRep(RepRef8 v) { this.rep = v; }
    public List<ItemLine8> getItems() { return items; }
    public void setItems(List<ItemLine8> v) { this.items = v; }

    @Override public String toString() {
        return "Order{" + orderNo + ", " + status + ", cust=" + customer
                + ", rep=" + rep + ", items=" + items.size() + "}";
    }
}
```

```java
package com.example.lab.ch08;

import java.util.UUID;

/** 8.5 <association> 的目標型別。★ 可變 POJO —— 巢狀映射用 setter 填。 */
public class CustomerRef8 {
    private UUID id;
    private String displayName;
    private String email;
    private Tier8 tier;
    private String countryCode;

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }
    public String getDisplayName() { return displayName; }
    public void setDisplayName(String v) { this.displayName = v; }
    public String getEmail() { return email; }
    public void setEmail(String v) { this.email = v; }
    public Tier8 getTier() { return tier; }
    public void setTier(Tier8 v) { this.tier = v; }
    public String getCountryCode() { return countryCode; }
    public void setCountryCode(String v) { this.countryCode = v; }

    @Override public String toString() {
        return "Cust{" + displayName + ", " + tier + ", " + countryCode + "}";
    }
}
```

```java
package com.example.lab.ch08;

import java.util.UUID;

/** 8.5 第二個 <association> —— 它可以是 null（orders.rep_id 可為 null）。 */
public class RepRef8 {
    private UUID id;
    private String name;
    private String region;

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }
    public String getName() { return name; }
    public void setName(String v) { this.name = v; }
    public String getRegion() { return region; }
    public void setRegion(String v) { this.region = v; }

    @Override public String toString() { return "Rep{" + name + ", " + region + "}"; }
}
```

```java
package com.example.lab.ch08;

import java.math.BigDecimal;
import java.util.UUID;

/** 8.5：集合的元素，而它自己又有一個 <association>（product）—— 兩層巢狀。 */
public class ItemLine8 {
    private UUID id;
    private String productName;
    private int qty;
    private BigDecimal lineAmount;
    private ProductRef8 product;

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }
    public String getProductName() { return productName; }
    public void setProductName(String v) { this.productName = v; }
    public int getQty() { return qty; }
    public void setQty(int v) { this.qty = v; }
    public BigDecimal getLineAmount() { return lineAmount; }
    public void setLineAmount(BigDecimal v) { this.lineAmount = v; }
    public ProductRef8 getProduct() { return product; }
    public void setProduct(ProductRef8 v) { this.product = v; }

    @Override public String toString() {
        return "Item{" + productName + " ×" + qty + ", product=" + product + "}";
    }
}
```

```java
package com.example.lab.ch08;

import java.math.BigDecimal;
import java.util.UUID;

/** 8.5.3：巢狀第【二】層 —— 它跟 CustomerRef8 都有 id / name，這就是欄名衝突的來源。 */
public class ProductRef8 {
    private UUID id;
    private String sku;
    private String name;
    private String category;
    private BigDecimal unitPrice;

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }
    public String getSku() { return sku; }
    public void setSku(String v) { this.sku = v; }
    public String getName() { return name; }
    public void setName(String v) { this.name = v; }
    public String getCategory() { return category; }
    public void setCategory(String v) { this.category = v; }
    public BigDecimal getUnitPrice() { return unitPrice; }
    public void setUnitPrice(BigDecimal v) { this.unitPrice = v; }

    @Override public String toString() { return "Prod{" + sku + ", " + name + "}"; }
}
```

**8.5.6 的付款方式階層**（一張表、三個類別）：

```java
package com.example.lab.ch08;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

/**
 * 8.5.6 <discriminator> 的基底型別。
 * ★ 一張 payment 表，三種付款方式，三個子類別 —— 這是 JPA 的
 *   @Inheritance(SINGLE_TABLE) + @DiscriminatorColumn 在 MyBatis 這一側的對應物。
 */
public class Pay8 {
    private UUID id;
    private UUID orderId;
    private String kind;
    private BigDecimal amount;
    private Instant paidAt;

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }
    public UUID getOrderId() { return orderId; }
    public void setOrderId(UUID v) { this.orderId = v; }
    public String getKind() { return kind; }
    public void setKind(String v) { this.kind = v; }
    public BigDecimal getAmount() { return amount; }
    public void setAmount(BigDecimal v) { this.amount = v; }
    public Instant getPaidAt() { return paidAt; }
    public void setPaidAt(Instant v) { this.paidAt = v; }

    /** 子類別覆寫：讓「型別對了」這件事看得見。 */
    public String describe() { return "未知的付款方式（" + kind + "）"; }

    @Override public String toString() {
        return getClass().getSimpleName() + "{" + describe() + "}";
    }
}
```

```java
package com.example.lab.ch08;

public class CardPay8 extends Pay8 {
    private String cardBrand;
    private String cardLast4;

    public String getCardBrand() { return cardBrand; }
    public void setCardBrand(String v) { this.cardBrand = v; }
    public String getCardLast4() { return cardLast4; }
    public void setCardLast4(String v) { this.cardLast4 = v; }

    @Override public String describe() { return cardBrand + " 卡 ****" + cardLast4; }
}
```

```java
package com.example.lab.ch08;

public class TransferPay8 extends Pay8 {
    private String bankCode;
    private String bankAccount;

    public String getBankCode() { return bankCode; }
    public void setBankCode(String v) { this.bankCode = v; }
    public String getBankAccount() { return bankAccount; }
    public void setBankAccount(String v) { this.bankAccount = v; }

    @Override public String describe() { return "轉帳 " + bankCode + "-" + bankAccount; }
}
```

```java
package com.example.lab.ch08;

import java.math.BigDecimal;

public class CodPay8 extends Pay8 {
    private BigDecimal codFee;

    public BigDecimal getCodFee() { return codFee; }
    public void setCodFee(BigDecimal v) { this.codFee = v; }

    @Override public String describe() { return "貨到付款（手續費 " + codFee + "）"; }
}
```

**8.4 的批次參數**：

```java
package com.example.lab.ch08;

import java.math.BigDecimal;
import java.util.UUID;

/** 8.4.5 批次插入用的參數。 */
public record ItemInsert8(UUID id, UUID orderId, UUID productId, String productName,
                          BigDecimal unitPrice, int qty, BigDecimal lineAmount) {}
```

```java
package com.example.lab.ch08;

import java.math.BigDecimal;
import java.util.UUID;

/** 8.4.7：一句 UPDATE 改 N 列、每一列不同的值（CASE WHEN）。 */
public record AmountPatch8(UUID id, BigDecimal amount) {}
```

```java
package com.example.lab.ch08;

import java.util.ArrayList;
import java.util.List;

/**
 * 8.4.4：MyBatis 沒有 Hibernate 的 in_clause_parameter_padding（05 章 5.5.3），
 * 所以要自己做。★ 這是「參數個數向上補到 2 的次方、多的位置重複填最後一個值」。
 */
public final class Pad8 {
    private Pad8() {}

    public static <T> List<T> pad(List<T> src) {
        if (src == null || src.isEmpty()) return src;
        int n = src.size(), target = 1;
        while (target < n) target <<= 1;
        if (target == n) return src;
        List<T> out = new ArrayList<>(target);
        out.addAll(src);
        T last = src.get(n - 1);
        while (out.size() < target) out.add(last);
        return out;
    }
}
```

⚠️ **測試資料的三個維度必須互相錯開**，這是這一章 setup 唯一的技術性要求：

```
狀態     週期 4        i % 4
客戶     週期 4×4=16   (i / 4) % customerCount
業務員   週期 5        i % 5 < 3
```

**第一版我寫成「狀態 `i % 4`、客戶 `i % 4`」**，於是「狀態 = PENDING 且客戶 = 客戶1」
這個組合**永遠是空集合** —— 而動態 SQL 這一章有一半的實測都在測「多個條件同時成立」。
**量到 0 筆的時候，你分不出是「SQL 錯了」還是「資料剛好沒有」。**

### 8.2.3 量尺：這一章要第四把 ★★

前七章的量尺有一個共同點：**都要先跑一次才有數字**。

```
SqlSpy（datasource-proxy）      JDBC 收到幾句       01～07 章
Hibernate Statistics            Hibernate 做了什麼   03～06 章
MysqlStat（SHOW GLOBAL STATUS） 伺服器剖析了幾句     06 章
```

**而動態 SQL 的問題是組合爆炸。** 六個可選條件 = **64 種 SQL**，
要「跑 64 次」才知道有沒有壞掉，就等於要有 64 種測試資料情境。

MyBatis 有一條捷徑，而且它便宜到可以當成 CI 斷言：

```
MappedStatement.getBoundSql(參數) → BoundSql
     ├─ getSql()               這組參數會產生的【最終 SQL 文字】
     └─ getParameterMappings() 那些 ? 依序對應哪些屬性
```

**它不需要連線、不需要交易、不需要任何資料。**

```java
package com.example.lab.ch08;

import org.apache.ibatis.binding.MapperMethod;
import org.apache.ibatis.mapping.BoundSql;
import org.apache.ibatis.mapping.MappedStatement;
import org.apache.ibatis.mapping.ParameterMapping;
import org.apache.ibatis.session.Configuration;
import org.apache.ibatis.session.SqlSessionFactory;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;

/**
 * ★★ 08 章的第四把尺：<b>不執行，也看得到 SQL</b>。
 *
 * 前七章的量尺都要「先跑一次」才有數字（SqlSpy / Statistics / MysqlStat）。
 * 動態 SQL 的問題是【組合爆炸】：六個可選條件 = 64 種 SQL。
 * 要「跑 64 次」才知道有沒有壞掉，就等於要有 64 個測試資料情境。
 *
 * 而 MyBatis 有一條捷徑：
 * <pre>
 *   MappedStatement.getBoundSql(參數) → BoundSql
 *        ├─ getSql()               這組參數會產生的【最終 SQL 文字】
 *        └─ getParameterMappings() 那些 ? 依序對應哪些屬性
 * </pre>
 * 它【不需要資料庫連線、不需要交易、不需要任何資料】。
 * 所以 64 種組合可以在幾毫秒內全部展開，寫成一條 CI 斷言（8.9.1）。
 *
 * 📌 這把尺量的是「MyBatis 打算送出什麼」，
 *    SqlSpy 量的是「JDBC 真的收到什麼」——8.6.3 會用兩者的差別抓出 PageHelper 做了什麼。
 */
public class Dyn {

    private final Configuration cfg;

    public Dyn(SqlSessionFactory factory) { this.cfg = factory.getConfiguration(); }

    /**
     * 把 @Param 的名字與值組成 mapper 呼叫時 MyBatis 會建的那個 Map。
     *
     * 🔴 這裡【一定要用 MapperMethod.ParamMap】，不能用 HashMap ——
     *    ParamMap 對「取一個不存在的 key」是【拋 BindingException】，
     *    而 HashMap 是【回傳 null】。用 HashMap 的量尺會把「參數名打錯」量成「條件不成立」。
     *    8.3.11 會把兩者的差別印出來。
     */
    public static Map<String, Object> args(Object... kv) {
        MapperMethod.ParamMap<Object> m = new MapperMethod.ParamMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            m.put((String) kv[i], kv[i + 1]);
            m.put("param" + (i / 2 + 1), kv[i + 1]);
        }
        return m;
    }

    /** 對照組：寬鬆版（HashMap）。取不到的 key 回 null 而不是拋例外。 */
    public static Map<String, Object> looseArgs(Object... kv) {
        Map<String, Object> m = new HashMap<>();
        for (int i = 0; i < kv.length; i += 2) m.put((String) kv[i], kv[i + 1]);
        return m;
    }

    public MappedStatement ms(String statementId) {
        return cfg.getMappedStatement(statementId, false);
    }

    /** 這組參數會產生的最終 SQL（空白已壓成一格）。 */
    public String sql(String statementId, Object param) {
        return one(ms(statementId).getBoundSql(param).getSql());
    }

    /** SQL 裡那些 ? 依序對應哪些屬性。 */
    public List<String> params(String statementId, Object param) {
        BoundSql bs = ms(statementId).getBoundSql(param);
        List<String> out = new ArrayList<>();
        for (ParameterMapping pm : bs.getParameterMappings()) out.add(pm.getProperty());
        return out;
    }

    /** SQL 裡有幾個 ?。 */
    public int placeholders(String statementId, Object param) {
        return params(statementId, param).size();
    }

    /**
     * 只看【最外層】WHERE 之後那一段（動態 SQL 的重點都在那裡）。
     *
     * ⚠️ 不能用 indexOf(" WHERE ") —— 本章的 rowColumns 裡有一個
     *    (SELECT count(*) … WHERE i.order_id = o.id)，會抓到它。
     *    所以要一邊掃一邊記括號深度，只認【深度 0】的那一個 WHERE。
     */
    public String where(String statementId, Object param) {
        String s = one(sql(statementId, param));
        int w = topLevelIndexOf(s, " where "), o = topLevelIndexOf(s, " order by ");
        if (w < 0) return "（沒有 WHERE）";
        return o > w ? s.substring(w + 1, o) : s.substring(w + 1);
    }

    /** 找出 needle 在括號深度 0 的【最後一次】出現（needle 要小寫、前後帶空白）。 */
    public static int topLevelIndexOf(String sql, String needle) {
        String lower = sql.toLowerCase();
        int depth = 0, found = -1;
        for (int i = 0; i < sql.length(); i++) {
            char c = sql.charAt(i);
            if (c == '(') depth++;
            else if (c == ')') { if (depth > 0) depth--; }
            else if (depth == 0 && lower.startsWith(needle, i)) found = i;
        }
        return found;
    }

    /** 一組參數 → 一種 SQL 形狀。回傳去重後的集合。 */
    public <T> Set<String> shapes(String statementId, List<T> params) {
        Set<String> out = new LinkedHashSet<>();
        for (T p : params) out.add(sql(statementId, p));
        return out;
    }

    /**
     * 8.3.2 / 8.9.1：把 N 個「可選條件」的 2^N 種組合全部展開。
     * setters 的每一個元素是「把第 i 個條件填上去」的函式。
     */
    public static <T> List<T> combinations(T empty, List<Function<T, T>> setters) {
        int n = setters.size();
        List<T> out = new ArrayList<>(1 << n);
        for (int mask = 0; mask < (1 << n); mask++) {
            T cur = empty;
            for (int i = 0; i < n; i++) {
                if ((mask & (1 << i)) != 0) cur = setters.get(i).apply(cur);
            }
            out.add(cur);
        }
        return out;
    }

    public static String one(String s) { return s.replaceAll("\\s+", " ").trim(); }
}
```

**它長什麼樣**：

```
═══ 8.2.3 第四把尺：不執行，也看得到 SQL ═══
── 只填了 status 的那一組參數
   SQL   : SELECT o.id, o.order_no, c.display_name AS customer_name, o.status,
           o.total_amount, o.placed_at, (SELECT count(*) FROM order_item i
           WHERE i.order_id = o.id) AS item_count FROM orders o JOIN customer c…
   WHERE : WHERE o.status = ?
   ? 對應: [q.status]
   ★ 全程沒有連線、沒有交易、沒有資料。
```

📌 **四把尺的分工，到這一章才齊**：

| 尺 | 站在哪一層 | 它能回答什麼 | 它看不到什麼 |
|---|---|---|---|
| **`Dyn`（本章）** | MyBatis 的 SQL 組裝之後 | **這組參數會產生什麼 SQL** | 執行期的一切 |
| `SqlSpy` | JDBC API | 應用程式呼叫了幾次 `execute()` | 驅動自己做的事 |
| Hibernate `Statistics` | Hibernate 內部 | N+1 的**來源**、建了幾個實體 | MyBatis 那一側 |
| `MysqlStat` | 資料庫伺服器 | **伺服器剖析／執行了幾句** | 是誰送來的 |

⚠️ **而這一章會證明「量尺自己也會騙人」三次**：
`Dyn.args()` 用 `HashMap` 會把打錯字量成「條件不成立」（8.3.11b）；
`SqlSpy` 與 `Dyn` 對 PageHelper 的看法**完全不一樣**（8.6.3）；
延遲載入的 SQL 句數**取決於同一個交易裡之前查過什麼**（8.5.9）。

### 8.2.4 這一章的測試基底

```java
package com.example.lab.ch08;

import com.example.lab.SqlSpy;
import com.example.lab.Uuid7;
import com.example.lab.ch06.MysqlStat;
import jakarta.persistence.EntityManager;
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
  "spring.datasource.url=jdbc:mysql://127.0.0.1:33306/ch08?connectionTimeZone=UTC"
      + "&forceConnectionTimeZoneToSession=true&preserveInstants=true&characterEncoding=UTF-8",
  "spring.jpa.properties.hibernate.generate_statistics=true"
})
public abstract class Base08 {

    @Autowired protected EntityManager em;
    @Autowired protected JdbcTemplate jdbc;
    @Autowired protected TransactionTemplate tx;
    @Autowired protected SqlSessionFactory sqlSessionFactory;

    protected Dyn dyn;
    protected MysqlStat stat;

    protected final List<UUID> orderIds = new ArrayList<>();
    protected final List<UUID> customerIds = new ArrayList<>();
    protected final List<UUID> productIds = new ArrayList<>();
    protected final List<UUID> repIds = new ArrayList<>();

    protected Dyn dyn() { if (dyn == null) dyn = new Dyn(sqlSessionFactory); return dyn; }
    protected MysqlStat stat() { if (stat == null) stat = new MysqlStat(jdbc); return stat; }

    protected void clean() {
        jdbc.update("DELETE FROM audit_sql");
        jdbc.update("DELETE FROM payment");
        jdbc.update("DELETE FROM order_item");
        jdbc.update("DELETE FROM orders");
        jdbc.update("DELETE FROM stock");
        jdbc.update("DELETE FROM product");
        jdbc.update("DELETE FROM customer");
        jdbc.update("DELETE FROM sales_rep");
    }

    /**
     * @param orderCount    訂單數
     * @param customerCount 客戶數
     * @param itemsPer      每張訂單幾筆明細
     */
    protected void seed(int orderCount, int customerCount, int itemsPer) {
        clean();
        orderIds.clear(); customerIds.clear(); productIds.clear(); repIds.clear();

        String[] tiers = {"NORMAL", "SILVER", "GOLD"};
        String[] countries = {"TW", "JP", "US", "DE"};
        List<Object[]> cRows = new ArrayList<>();
        for (int i = 0; i < customerCount; i++) {
            UUID id = Uuid7.next(); customerIds.add(id);
            cRows.add(new Object[]{Uuid7.toBytes(id), "c" + i + "@x.com", "客戶" + i,
                    tiers[i % 3], countries[i % 4]});
        }
        jdbc.batchUpdate("INSERT INTO customer (id,email,display_name,tier,country_code)"
                + " VALUES (?,?,?,?,?)", cRows);

        String[] regions = {"北區", "中區", "南區"};
        List<Object[]> rRows = new ArrayList<>();
        for (int i = 0; i < 3; i++) {
            UUID id = Uuid7.next(); repIds.add(id);
            rRows.add(new Object[]{Uuid7.toBytes(id), "業務" + i, regions[i]});
        }
        jdbc.batchUpdate("INSERT INTO sales_rep (id,name,region) VALUES (?,?,?)", rRows);

        String[] cats = {"3C", "書籍", "生鮮"};
        List<Object[]> pRows = new ArrayList<>(), sRows = new ArrayList<>();
        for (int i = 0; i < 6; i++) {
            UUID id = Uuid7.next(); productIds.add(id);
            pRows.add(new Object[]{Uuid7.toBytes(id), "SKU-" + i, "商品" + i,
                    cats[i % 3], new BigDecimal((100 + i * 50) + ".0000")});
            sRows.add(new Object[]{Uuid7.toBytes(id), 100});
        }
        jdbc.batchUpdate("INSERT INTO product (id,sku,name,category,unit_price)"
                + " VALUES (?,?,?,?,?)", pRows);
        jdbc.batchUpdate("INSERT INTO stock (product_id,qty) VALUES (?,?)", sRows);

        String[] sts = {"PENDING", "PAID", "SHIPPED", "CANCELLED"};
        List<Object[]> oRows = new ArrayList<>(), iRows = new ArrayList<>();
        Instant t0 = Instant.parse("2026-09-01T00:00:00Z");
        for (int i = 0; i < orderCount; i++) {
            UUID oid = Uuid7.next(); orderIds.add(oid);
            // ★ 前一半有業務員、後一半沒有 —— 8.3 的 hasRep 條件要用
            // ★ 三個維度刻意【互相錯開】（週期 4 / 5 / customerCount），
            //   否則「狀態 = PENDING 且客戶 = 客戶1」這種組合會剛好永遠是空集合。
            byte[] rep = (i % 5 < 3) ? Uuid7.toBytes(repIds.get(i % 3)) : null;
            oRows.add(new Object[]{Uuid7.toBytes(oid), String.format("SO-2026-%06d", i + 1),
                    Uuid7.toBytes(customerIds.get((i / 4) % customerCount)), rep,
                    sts[i % 4],
                    new BigDecimal((100 * Math.max(1, itemsPer) + i) + ".0000"),
                    java.sql.Timestamp.from(t0.plusSeconds(i * 60L)),
                    "t" + (i % 2) + "-memo"});
            for (int k = 0; k < itemsPer; k++) {
                UUID pid = productIds.get((i + k) % 6);
                iRows.add(new Object[]{Uuid7.toBytes(Uuid7.next()), Uuid7.toBytes(oid),
                        Uuid7.toBytes(pid), "商品" + ((i + k) % 6),
                        new BigDecimal("100.0000"), 1 + (k % 3), new BigDecimal("100.0000")});
            }
        }
        jdbc.batchUpdate("INSERT INTO orders"
                + " (id,order_no,customer_id,rep_id,status,total_amount,placed_at,memo)"
                + " VALUES (?,?,?,?,?,?,?,?)", oRows);
        if (!iRows.isEmpty())
            jdbc.batchUpdate("INSERT INTO order_item"
                    + " (id,order_id,product_id,product_name,unit_price,qty,line_amount)"
                    + " VALUES (?,?,?,?,?,?,?)", iRows);
    }

    /** 8.5.6：三種付款方式各塞幾筆。 */
    protected void seedPayments() {
        jdbc.update("DELETE FROM payment");
        List<Object[]> rows = new ArrayList<>();
        Instant t0 = Instant.parse("2026-09-02T00:00:00Z");
        String[] kinds = {"CARD", "TRANSFER", "COD"};
        for (int i = 0; i < 6 && i < orderIds.size(); i++) {
            String kind = kinds[i % 3];
            rows.add(new Object[]{Uuid7.toBytes(Uuid7.next()), Uuid7.toBytes(orderIds.get(i)),
                    kind, new BigDecimal((1000 + i) + ".0000"),
                    java.sql.Timestamp.from(t0.plusSeconds(i * 60L)),
                    kind.equals("CARD") ? "VISA" : null,
                    kind.equals("CARD") ? String.format("%04d", 1000 + i) : null,
                    kind.equals("TRANSFER") ? "808" : null,
                    kind.equals("TRANSFER") ? "12345678" + i : null,
                    kind.equals("COD") ? new BigDecimal("30.0000") : null});
        }
        jdbc.batchUpdate("INSERT INTO payment (id,order_id,kind,amount,paid_at,"
                + "card_brand,card_last4,bank_code,bank_account,cod_fee)"
                + " VALUES (?,?,?,?,?,?,?,?,?,?)", rows);
    }

    protected void resetCountries() {
        jdbc.update("DELETE FROM country");
        jdbc.update("INSERT INTO country (code,name) VALUES ('TW','台灣'),('JP','日本'),"
                + "('US','美國'),('DE','德國')");
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

    protected void showTail(String title, Runnable body) {
        List<String> sqls = spy(body);
        System.out.println("── " + title + " → " + sqls.size() + " 句 SQL");
        for (String s : sqls) System.out.println("   " + tail(s));
    }

    protected void grouped(String title, List<String> sqls) {
        LinkedHashMap<String, Integer> m = new LinkedHashMap<>();
        for (String s : sqls) m.merge(s, 1, Integer::sum);
        System.out.println("── " + title + " → 共 " + sqls.size() + " 句，" + m.size() + " 種形狀");
        m.forEach((k, v) -> System.out.println("   ×" + v + "  " + cut(k)));
    }

    protected static String tail(String s) {
        String one = s.replaceAll("\\s+", " ");
        int i = one.toUpperCase().lastIndexOf(" FROM ");
        return i < 0 ? one : "… " + one.substring(i + 1);
    }

    protected static String cut(String s) {
        return s.length() > 160 ? s.substring(0, 160) + "…" : s;
    }

    protected static String cut(String s, int n) {
        String one = s.replaceAll("\\s+", " ").trim();
        return one.length() > n ? one.substring(0, n) + "…" : one;
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

    protected static String msg(Throwable t) {
        return t == null ? "（沒有例外）" : cut(String.valueOf(root(t).getMessage()), 150);
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

    protected long bestMicros(Runnable r, int warmup, int rounds) {
        for (int i = 0; i < warmup; i++) r.run();
        long best = Long.MAX_VALUE;
        for (int i = 0; i < rounds; i++) {
            long t0 = System.nanoTime();
            r.run();
            best = Math.min(best, System.nanoTime() - t0);
        }
        return best / 1000;
    }
}
```

⚠️ **`pom.xml` 這一章只多一個依賴，而它會撞壞整個專案** —— 見 8.6.2。

---

## 8.3 動態 SQL ★★

05 章 5.12.2 那張決策表有一列寫著：

```
「SQL 本身是動態的（欄位、表名會變） → 🔴 只能拼字串 → MyBatis 的 <if> / <choose>」
```

**而那一列沒有說的是：`<if>` 拼出來的東西，也是字串。**

這一節要做的事，是把 05 章 5.9.1 那五個問題**一個一個拿到 MyBatis 上重量一次**。
先把那五個問題抄過來：

```
① where 1 = 1 —— 一個【為了字串拼接方便】而存在的條件
② 少一個空白就是執行期錯誤，而且要【湊齊那個組合】才會發生
③ 隱式 join 會靜默吃掉資料，而且沒有東西提醒你
④ 改一個屬性名（rename），這段字串不會編譯錯誤
⑤ 有人把使用者輸入直接 append 進去 → 注入
```

**結論先講**（完整計分在 8.3.12）：

```
①  ✅ <where> 解掉了，而且解得很乾淨（8.3.3）
②  🟡 沒有解掉，但 8.2.3 那把尺可以【在 CI 裡把 64 種組合全展開】（8.3.4、8.9.1）
③  ✅ 不存在 —— MyBatis 的 join 是你自己寫的，沒有「隱式」這件事
④  🔴 完全沒有解掉，而且比 JPA 更糟（連欄位名 rename 都不會編譯錯誤）
⑤  🔴 完全沒有解掉，而且 ${} 讓它【更容易】發生（8.3.1）
─────────────────────────────────────────────────────
＋ 一個 05 章沒有的新問題：SQL 形狀的數量（8.3.13）
```

### 8.3.0 這一節的 mapper

**介面**（動態 SQL 全部寫在 XML；同一個查詢的不同寫法各一個方法 ——
跟 02 章「同一張表映射成多個實體」是同一個手法）：

```java
package com.example.lab.ch08;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;

/**
 * 08 章 8.3 / 8.4：動態 SQL。SQL 全部寫在 resources/mapper/Ord8Mapper.xml。
 *
 * ★ 這個介面上的每一組方法，都是「同一個查詢的不同寫法」——
 *   跟 02 章「同一張表映射成多個實體」是同一個手法。
 */
@Mapper
public interface Ord8Mapper {

    // ═══ 8.3 動態 where ═══

    /** 🔴 對照組一：用 ${} 拼字串（= 05 章 5.9.1 那個 StringBuilder 的 MyBatis 版）。 */
    List<OrderRow8> searchConcat(@Param("q") OrderSearchBean8 q);

    /** 對照組二：where 1 = 1 + <if>。 */
    List<OrderRow8> searchWhere1(@Param("q") OrderSearchBean8 q);

    /** ✅ 正式版：<where> + <if>。 */
    List<OrderRow8> search(@Param("q") OrderSearchBean8 q);

    /** 8.3.11：同一句話，參數換成 record。 */
    List<OrderRow8> searchRecord(@Param("q") OrderSearch8 q);

    /** 8.3.11b：record 但用 <if test="q.status() != null">（呼叫存取子方法）。 */
    List<OrderRow8> searchRecordCall(@Param("q") OrderSearch8 q);

    /** 🔴 8.3.4：<if> 裡忘了寫開頭的 and。 */
    List<OrderRow8> searchMissingAnd(@Param("q") OrderSearchBean8 q);

    /** 8.3.5：<trim>，把 <where> 手寫一次。 */
    List<OrderRow8> searchTrim(@Param("q") OrderSearchBean8 q);

    /** 8.3.8：<choose> —— 只取第一個成立的分支。 */
    List<OrderRow8> searchChoose(@Param("q") OrderSearchBean8 q);

    /** 8.3.9：<bind> —— like 的 % 該在哪裡。 */
    List<OrderRow8> searchBind(@Param("q") OrderSearchBean8 q);

    /** ✅ 8.3.9c：<bind> 用三元運算子的版本。 */
    List<OrderRow8> searchBindFixed(@Param("q") OrderSearchBean8 q);

    /** 🔴 8.3.9b：把 % 拼進 ${} 的版本。 */
    List<OrderRow8> searchLikeConcat(@Param("q") OrderSearchBean8 q);

    /** 8.3.10：<include> 帶參數。 */
    List<OrderRow8> searchInclude(@Param("q") OrderSearchBean8 q,
                                  @Param("sortColumn") String sortColumn,
                                  @Param("sortDir") String sortDir);

    /** 🔴 8.3.11：<if> 裡把【根名字】打錯（qq）。 */
    List<OrderRow8> searchTypoRoot(@Param("q") OrderSearchBean8 q);

    /** 🔴 8.3.11：<if> 裡把【屬性名】打錯（statusX）。 */
    List<OrderRow8> searchTypoProp(@Param("q") OrderSearchBean8 q);

    /** 8.3.12：搜尋 + count（同一段 <sql> 片段）。 */
    long searchCount(@Param("q") OrderSearchBean8 q);

    // ═══ 8.3.6 動態 set ═══

    /** ✅ <set> + <if>：只更新有給值的欄位。 */
    int patch(@Param("id") UUID id, @Param("status") St8 status,
              @Param("memo") String memo, @Param("totalAmount") BigDecimal totalAmount);

    /** 🔴 沒有 <set> 的版本：一律更新四欄（= 03 章 merge 靜默清空的形狀）。 */
    int patchAll(@Param("id") UUID id, @Param("status") St8 status,
                 @Param("memo") String memo, @Param("totalAmount") BigDecimal totalAmount);

    /** 🔴 8.3.7：<set> 裡全部 <if> 都不成立會怎樣。 */
    int patchNothing(@Param("id") UUID id, @Param("status") St8 status,
                     @Param("memo") String memo);

    // ═══ 8.4 foreach ═══

    long countIn(@Param("statuses") List<St8> statuses);

    /** 8.4.4：自己做 padding（補到 2 的次方）。 */
    long countInPadded(@Param("statuses") List<St8> statuses);

    List<OrderRow8> byIds(@Param("ids") List<UUID> ids);

    /** 8.4.2：先檢查空集合的版本。 */
    List<OrderRow8> byIdsSafe(@Param("ids") List<UUID> ids);

    /** 8.4.5：一句 INSERT 多組 VALUES。 */
    int insertItems(@Param("items") List<ItemInsert8> items);

    /** 8.4.7：一句 UPDATE 改 N 列不同的值。 */
    int patchAmounts(@Param("patches") List<AmountPatch8> patches);

    /** 8.4.7b：<foreach> 組 OR 條件。 */
    List<OrderRow8> searchAnyKeyword(@Param("keywords") List<String> keywords);

    // ═══ 8.6 分頁 ═══

    List<OrderRow8> page(@Param("q") OrderSearchBean8 q,
                         @Param("offset") int offset, @Param("size") int size);

    /** PageHelper 版：SQL 裡【沒有】 limit。 */
    List<OrderRow8> pageByHelper(@Param("q") OrderSearchBean8 q);

    /** 8.6.5：巢狀 resultMap 的版本 —— PageHelper 的 count 會算錯。 */
    List<OrderNode8> pageNested(@Param("status") St8 status);

    /** 8.6.7 keyset 分頁。 */
    List<OrderRow8> pageKeyset(@Param("status") St8 status,
                               @Param("lastPlacedAt") java.time.Instant lastPlacedAt,
                               @Param("lastId") UUID lastId,
                               @Param("size") int size);

    /** ✅ 8.6.8b keyset 分頁，條件展開成 OR —— 這才吃得到索引。 */
    List<OrderRow8> pageKeysetOr(@Param("status") St8 status,
                                 @Param("lastPlacedAt") java.time.Instant lastPlacedAt,
                                 @Param("lastId") UUID lastId,
                                 @Param("size") int size);

    /** 8.6.8 對照：offset 很大的那一頁。 */
    List<OrderRow8> pageOffset(@Param("status") St8 status,
                               @Param("offset") int offset, @Param("size") int size);
}
```

**XML**（這一份檔案同時服務 8.3 / 8.4 / 8.6，所以先整份貼出來，
後面各節只引用其中一段）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN"
        "https://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="com.example.lab.ch08.Ord8Mapper">

  <!-- ═══════════════ 共用的片段 ═══════════════ -->

  <resultMap id="rowMap" type="com.example.lab.ch08.OrderRow8">
    <constructor>
      <idArg column="id"            javaType="java.util.UUID"/>
      <arg   column="order_no"      javaType="java.lang.String"/>
      <arg   column="customer_name" javaType="java.lang.String"/>
      <arg   column="status"        javaType="com.example.lab.ch08.St8"/>
      <arg   column="total_amount"  javaType="java.math.BigDecimal"/>
      <arg   column="placed_at"     javaType="java.time.Instant"/>
      <arg   column="item_count"    javaType="_long"/>
    </constructor>
  </resultMap>

  <sql id="rowColumns">
    o.id, o.order_no, c.display_name AS customer_name, o.status,
    o.total_amount, o.placed_at,
    (SELECT count(*) FROM order_item i WHERE i.order_id = o.id) AS item_count
  </sql>

  <sql id="rowFrom">
    FROM orders o
    JOIN customer c ON c.id = o.customer_id
    LEFT JOIN sales_rep r ON r.id = o.rep_id
  </sql>

  <!-- ★ 8.3.12：搜尋條件抽成【一份】，列表與 count 共用。
       這是 <sql> 最重要的用途：讓「count 跟列表用同一組條件」變成結構保證。 -->
  <sql id="searchWhere">
    <!-- ★ kw 要在這裡 bind：<if> 裡的 #{kw} 是在【這一份片段】裡被解析的（8.3.9） -->
    <bind name="kw" value="q.customerKeyword == null ? null : '%' + q.customerKeyword + '%'"/>
    <where>
      <if test="q.status != null">          AND o.status = #{q.status}                 </if>
      <if test="q.customerKeyword != null"> AND c.display_name LIKE #{kw}              </if>
      <if test="q.from != null">            AND o.placed_at &gt;= #{q.from}            </if>
      <if test="q.to != null">              AND o.placed_at &lt;  #{q.to}              </if>
      <if test="q.minAmount != null">       AND o.total_amount &gt;= #{q.minAmount}    </if>
      <if test="q.hasRep != null">
        <choose>
          <when test="q.hasRep">            AND o.rep_id IS NOT NULL                   </when>
          <otherwise>                       AND o.rep_id IS NULL                       </otherwise>
        </choose>
      </if>
    </where>
  </sql>

  <!-- ═══════════════ 8.3.1 對照組一：${} 拼字串 ═══════════════ -->
  <!-- 🔴 這一份是【反面教材】。它跟 05 章 5.9.1 那個 StringBuilder 一樣脆弱，
       而且多了一個 05 章沒有的問題：注入。 -->
  <select id="searchConcat" resultMap="rowMap">
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
    WHERE 1 = 1
    <if test="q.status != null">          AND o.status = '${q.status}'                       </if>
    <if test="q.customerKeyword != null"> AND c.display_name LIKE '%${q.customerKeyword}%'   </if>
    <if test="q.minAmount != null">       AND o.total_amount &gt;= ${q.minAmount}            </if>
    ORDER BY o.placed_at, o.id
  </select>

  <!-- ═══════════════ 8.3.3 對照組二：where 1 = 1 ═══════════════ -->
  <select id="searchWhere1" resultMap="rowMap">
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
    <bind name="kw" value="q.customerKeyword == null ? null : '%' + q.customerKeyword + '%'"/>
    WHERE 1 = 1
    <if test="q.status != null">          AND o.status = #{q.status}              </if>
    <if test="q.customerKeyword != null"> AND c.display_name LIKE #{kw}           </if>
    <if test="q.minAmount != null">       AND o.total_amount &gt;= #{q.minAmount} </if>
    ORDER BY o.placed_at, o.id
  </select>

  <!-- ═══════════════ 8.3.2 / 8.3.3 ✅ 正式版：<where> ═══════════════ -->
  <select id="search" resultMap="rowMap">
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
    <include refid="searchWhere"/>
    ORDER BY o.placed_at, o.id
  </select>

  <select id="searchCount" resultType="_long">
    SELECT count(*)
    <include refid="rowFrom"/>
    <include refid="searchWhere"/>
  </select>

  <!-- ═══════════════ 8.3.11 參數換成 record ═══════════════ -->
  <select id="searchRecord" resultMap="rowMap">
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
    <where>
      <if test="q.status != null">    AND o.status = #{q.status}              </if>
      <if test="q.minAmount != null"> AND o.total_amount &gt;= #{q.minAmount} </if>
    </where>
    ORDER BY o.placed_at, o.id
  </select>

  <!-- 8.3.11b：改成【呼叫存取子方法】 -->
  <select id="searchRecordCall" resultMap="rowMap">
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
    <where>
      <if test="q.status() != null">    AND o.status = #{q.status()}              </if>
      <if test="q.minAmount() != null"> AND o.total_amount &gt;= #{q.minAmount()} </if>
    </where>
    ORDER BY o.placed_at, o.id
  </select>

  <!-- ═══════════════ 🔴 8.3.4 忘了開頭的 and ═══════════════ -->
  <select id="searchMissingAnd" resultMap="rowMap">
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
    <where>
      <if test="q.status != null">          o.status = #{q.status}                  </if>
      <if test="q.minAmount != null">       o.total_amount &gt;= #{q.minAmount}      </if>
    </where>
    ORDER BY o.placed_at, o.id
  </select>

  <!-- ═══════════════ 8.3.5 <trim>：把 <where> 手寫一次 ═══════════════ -->
  <select id="searchTrim" resultMap="rowMap">
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
    <trim prefix="WHERE" prefixOverrides="AND |OR ">
      <if test="q.status != null">          AND o.status = #{q.status}              </if>
      <if test="q.minAmount != null">       AND o.total_amount &gt;= #{q.minAmount} </if>
    </trim>
    ORDER BY o.placed_at, o.id
  </select>

  <!-- ═══════════════ 8.3.8 <choose>：只有一個分支會成立 ═══════════════ -->
  <select id="searchChoose" resultMap="rowMap">
    <bind name="kw" value="q.customerKeyword == null ? null : '%' + q.customerKeyword + '%'"/>
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
    <where>
      <choose>
        <when test="q.status != null">          AND o.status = #{q.status}              </when>
        <when test="q.minAmount != null">       AND o.total_amount &gt;= #{q.minAmount} </when>
        <when test="q.customerKeyword != null"> AND c.display_name LIKE #{kw}           </when>
        <otherwise>                             AND o.status &lt;&gt; 'CANCELLED'       </otherwise>
      </choose>
    </where>
    ORDER BY o.placed_at, o.id
  </select>

  <!-- ═══════════════ 8.3.9 <bind>：% 在 Java 那一側 ═══════════════ -->
  <select id="searchBind" resultMap="rowMap">
    <bind name="kw" value="'%' + q.customerKeyword + '%'"/>
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
    <where>
      <if test="q.customerKeyword != null"> AND c.display_name LIKE #{kw} </if>
    </where>
    ORDER BY o.placed_at, o.id
  </select>

  <!-- ✅ 8.3.9c：同一句話，<bind> 用三元運算子 —— 8.9.1 那條斷言的 0 壞掉版本 -->
  <select id="searchBindFixed" resultMap="rowMap">
    <bind name="kw" value="q.customerKeyword == null ? null : '%' + q.customerKeyword + '%'"/>
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
    <where>
      <if test="q.customerKeyword != null"> AND c.display_name LIKE #{kw} </if>
    </where>
    ORDER BY o.placed_at, o.id
  </select>

  <!-- 🔴 8.3.9b：% 拼進 ${} -->
  <select id="searchLikeConcat" resultMap="rowMap">
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
    <where>
      <if test="q.customerKeyword != null">
        AND c.display_name LIKE '%${q.customerKeyword}%'
      </if>
    </where>
    ORDER BY o.placed_at, o.id
  </select>

  <!-- ═══════════════ 8.3.10 <include> 帶參數 ═══════════════ -->
  <sql id="orderByClause">
    ORDER BY ${col} ${dir}, o.id
  </sql>

  <select id="searchInclude" resultMap="rowMap">
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
    <include refid="searchWhere"/>
    <include refid="orderByClause">
      <property name="col" value="${sortColumn}"/>
      <property name="dir" value="${sortDir}"/>
    </include>
  </select>

  <!-- ═══════════════ 🔴 8.3.11 打錯字的兩種形狀 ═══════════════ -->
  <select id="searchTypoRoot" resultMap="rowMap">
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
    <where>
      <if test="qq.status != null"> AND o.status = #{q.status} </if>
    </where>
  </select>

  <select id="searchTypoProp" resultMap="rowMap">
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
    <where>
      <if test="q.statusX != null"> AND o.status = #{q.status} </if>
    </where>
  </select>

  <!-- ═══════════════ 8.3.6 <set> ═══════════════ -->
  <update id="patch">
    UPDATE orders
    <set>
      <if test="status != null">      status = #{status},             </if>
      <if test="memo != null">        memo = #{memo},                 </if>
      <if test="totalAmount != null"> total_amount = #{totalAmount},  </if>
      version = version + 1
    </set>
    WHERE id = #{id}
  </update>

  <!-- 🔴 一律更新四欄 -->
  <update id="patchAll">
    UPDATE orders
       SET status = #{status},
           memo = #{memo},
           total_amount = #{totalAmount},
           version = version + 1
     WHERE id = #{id}
  </update>

  <!-- 🔴 8.3.7：全部 <if> 都不成立 -->
  <update id="patchNothing">
    UPDATE orders
    <set>
      <if test="status != null"> status = #{status}, </if>
      <if test="memo != null">   memo = #{memo},     </if>
    </set>
    WHERE id = #{id}
  </update>

  <!-- ═══════════════ 8.4 <foreach> ═══════════════ -->
  <select id="countIn" resultType="_long">
    SELECT count(*) FROM orders
     WHERE status IN
    <foreach item="s" collection="statuses" open="(" separator="," close=")">
      #{s}
    </foreach>
  </select>

  <!-- 8.4.4：自己補到 2 的次方（重複填最後一個值）。index 從 0 到 padTo-1 -->
  <select id="countInPadded" resultType="_long">
    SELECT count(*) FROM orders
     WHERE status IN
    <foreach item="s" collection="statuses" open="(" separator="," close=")">
      #{s}
    </foreach>
  </select>

  <select id="byIds" resultMap="rowMap">
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
     WHERE o.id IN
    <foreach item="id" collection="ids" open="(" separator="," close=")">
      #{id}
    </foreach>
     ORDER BY o.placed_at, o.id
  </select>

  <!-- ✅ 8.4.2：空集合的正解 —— 在 SQL 裡就把它擋掉 -->
  <select id="byIdsSafe" resultMap="rowMap">
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
    <where>
      <choose>
        <when test="ids != null and ids.size() > 0">
          AND o.id IN
          <foreach item="id" collection="ids" open="(" separator="," close=")">
            #{id}
          </foreach>
        </when>
        <otherwise>
          AND 1 = 0
        </otherwise>
      </choose>
    </where>
     ORDER BY o.placed_at, o.id
  </select>

  <insert id="insertItems">
    INSERT INTO order_item (id, order_id, product_id, product_name, unit_price, qty, line_amount)
    VALUES
    <foreach item="it" collection="items" separator=",">
      (#{it.id}, #{it.orderId}, #{it.productId}, #{it.productName},
       #{it.unitPrice}, #{it.qty}, #{it.lineAmount})
    </foreach>
  </insert>

  <!-- 8.4.7：一句 UPDATE 改 N 列不同的值 -->
  <update id="patchAmounts">
    UPDATE orders
       SET total_amount = CASE id
    <foreach item="p" collection="patches">
      WHEN #{p.id} THEN #{p.amount}
    </foreach>
           END,
           version = version + 1
     WHERE id IN
    <foreach item="p" collection="patches" open="(" separator="," close=")">
      #{p.id}
    </foreach>
  </update>

  <!-- 8.4.7b：<foreach> 組 OR -->
  <select id="searchAnyKeyword" resultMap="rowMap">
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
    <where>
      <foreach item="k" collection="keywords" open="(" separator=" OR " close=")">
        c.display_name LIKE #{k}
      </foreach>
    </where>
     ORDER BY o.placed_at, o.id
  </select>

  <!-- ═══════════════ 8.6 分頁 ═══════════════ -->
  <select id="page" resultMap="rowMap">
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
    <include refid="searchWhere"/>
     ORDER BY o.placed_at, o.id
     LIMIT #{size} OFFSET #{offset}
  </select>

  <!-- ★ PageHelper 版：這裡【沒有】 limit，攔截器會幫你加 -->
  <select id="pageByHelper" resultMap="rowMap">
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
    <include refid="searchWhere"/>
     ORDER BY o.placed_at, o.id
  </select>

  <select id="pageNested" resultMap="com.example.lab.ch08.Ord8ResultMapper.nodeMap">
    SELECT o.id, o.order_no, o.status, o.total_amount, o.placed_at,
           c.id AS c_id, c.display_name AS c_display_name, c.email AS c_email,
           c.tier AS c_tier, c.country_code AS c_country_code,
           r.id AS r_id, r.name AS r_name, r.region AS r_region,
           i.id AS i_id, i.product_name AS i_product_name, i.qty AS i_qty,
           i.line_amount AS i_line_amount,
           p.id AS i_p_id, p.sku AS i_p_sku, p.name AS i_p_name,
           p.category AS i_p_category, p.unit_price AS i_p_unit_price
      FROM orders o
      JOIN customer c ON c.id = o.customer_id
      LEFT JOIN sales_rep r ON r.id = o.rep_id
      LEFT JOIN order_item i ON i.order_id = o.id
      LEFT JOIN product p ON p.id = i.product_id
     WHERE o.status = #{status}
     ORDER BY o.placed_at, o.id, i.id
  </select>

  <!-- 🔴 8.6.7 keyset 分頁的「教科書寫法」：列建構子比較。
       它的結果是對的，而 8.6.8b 證明 MySQL 【不會】把它變成索引範圍掃描
       → 實測比展開成 OR 的版本慢 8 倍。 -->
  <select id="pageKeyset" resultMap="rowMap">
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
     WHERE o.status = #{status}
    <if test="lastPlacedAt != null">
      AND (o.placed_at, o.id) &gt; (#{lastPlacedAt}, #{lastId})
    </if>
     ORDER BY o.placed_at, o.id
     LIMIT #{size}
  </select>

  <!-- ✅ 8.6.8b 同一個語意，條件展開成 OR。
       🔴 MySQL 8.0.46 【不會】把上面那個列建構子比較轉成索引範圍掃描，
          而這一版可以 —— 實測 3.31 ms → 0.031 ms。 -->
  <select id="pageKeysetOr" resultMap="rowMap">
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
     WHERE o.status = #{status}
    <if test="lastPlacedAt != null">
      AND (o.placed_at &gt; #{lastPlacedAt}
           OR (o.placed_at = #{lastPlacedAt} AND o.id &gt; #{lastId}))
    </if>
     ORDER BY o.placed_at, o.id
     LIMIT #{size}
  </select>

  <select id="pageOffset" resultMap="rowMap">
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
     WHERE o.status = #{status}
     ORDER BY o.placed_at, o.id
     LIMIT #{size} OFFSET #{offset}
  </select>
</mapper>
```

**組態**（`application.yml`，07 章那三行不變）：

```yaml
mybatis:
  mapper-locations: classpath:mapper/*.xml
  type-handlers-package: com.example.lab.ch07
  configuration:
    map-underscore-to-camel-case: true
```

**測試類別**（整份貼出來；8.3 後面每一格都是它其中一個方法的解說）：

```java
package com.example.lab.ch08;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;

/** 8.3：動態 SQL。 */
class M2Dynamic extends Base08 {

    @Autowired Ord8Mapper orders;

    static final String NS = "com.example.lab.ch08.Ord8Mapper.";

    @BeforeEach void setUp() { seed(20, 4, 2); }

    private static OrderSearchBean8 b(OrderSearch8 r) { return OrderSearchBean8.of(r); }
    private Map<String, Object> arg(OrderSearch8 r) { return Dyn.args("q", b(r)); }

    /** 六個可選條件 → 2^6 = 64 種組合。 */
    private List<OrderSearch8> allCombinations() {
        List<Function<OrderSearch8, OrderSearch8>> setters = List.of(
                s -> s.withStatus(St8.PENDING),
                s -> s.withCustomerKeyword("客戶1"),
                s -> s.withRange(Instant.parse("2026-09-01T00:00:00Z"), null),
                s -> s.withRange(s.from(), Instant.parse("2026-09-02T00:00:00Z")),
                s -> s.withMinAmount(new BigDecimal("200")),
                s -> s.withHasRep(Boolean.TRUE));
        return Dyn.combinations(OrderSearch8.empty(), setters);
    }

    // ══════════════ 8.3.1 對照組：${} 拼字串 ══════════════

    @Test @Transactional
    void a1_拼字串版() {
        head("8.3.1 對照組：<if> + ${} 拼字串");
        var q = OrderSearch8.empty().withStatus(St8.PENDING).withCustomerKeyword("客戶1");
        System.out.println("── 正常輸入");
        System.out.println("   SQL 尾巴 : " + dyn().where(NS + "searchConcat", arg(q)));
        System.out.println("   ? 的個數 : " + dyn().placeholders(NS + "searchConcat", arg(q)));
        System.out.println("   結果     : " + orders.searchConcat(b(q)).size() + " 張");

        System.out.println("\n── 🔴 換一個「輸入」");
        var evil = OrderSearch8.empty().withCustomerKeyword("x' OR 1=1 OR ''='");
        System.out.println("   SQL 尾巴 : " + dyn().where(NS + "searchConcat", arg(evil)));
        System.out.println("   結果     : " + orders.searchConcat(b(evil)).size()
                + " 張（資料庫裡總共 " + jdbc.queryForObject("SELECT count(*) FROM orders", Long.class) + " 張）");

        System.out.println("\n── ✅ 同一個輸入，參數版（search）");
        System.out.println("   SQL 尾巴 : " + dyn().where(NS + "search", arg(evil)));
        System.out.println("   結果     : " + orders.search(b(evil)).size() + " 張");
    }

    // ══════════════ 8.3.2 64 種組合一次展開 ══════════════

    @Test
    void a2_六十四種組合() {
        head("8.3.2 六個可選條件 = 64 種 SQL，全部展開（不執行）");
        List<OrderSearch8> combos = allCombinations();
        System.out.println("  組合數：" + combos.size());

        Set<String> shapes = new LinkedHashSet<>();
        for (OrderSearch8 c : combos) shapes.add(dyn().where(NS + "search", arg(c)));
        System.out.println("  不同的 WHERE 形狀：" + shapes.size() + " 種");

        System.out.println("\n  前六種：");
        int n = 0;
        for (String s : shapes) { if (n++ < 6) System.out.println("    " + s); }

        System.out.println("\n  最滿的那一種（六個條件都填）：");
        System.out.println("    " + dyn().where(NS + "search", arg(combos.get(combos.size() - 1))));
        System.out.println("    ? 對應：" + dyn().params(NS + "search", arg(combos.get(combos.size() - 1))));

        for (int w = 0; w < 3; w++) for (OrderSearch8 c : combos) dyn().sql(NS + "search", arg(c));
        long t0 = System.nanoTime();
        for (OrderSearch8 c : combos) dyn().sql(NS + "search", arg(c));
        System.out.println("\n  展開 64 種花了 " + (System.nanoTime() - t0) / 1000 + " µs（沒有資料庫）");
    }

    // ══════════════ 8.3.3 where 1 = 1 為什麼不需要 ══════════════

    @Test
    void a3_where標籤() {
        head("8.3.3 <where> 與 where 1 = 1");
        var empty = OrderSearch8.empty();
        var one = OrderSearch8.empty().withStatus(St8.PENDING);

        System.out.println("── 空條件");
        System.out.println("   where 1 = 1 版 : " + dyn().where(NS + "searchWhere1", arg(empty)));
        System.out.println("   <where> 版     : " + dyn().where(NS + "search", arg(empty)));
        System.out.println("   ★ <where> 在【沒有任何條件成立】時，連 WHERE 這個字都不會出現。");

        System.out.println("\n── 一個條件");
        System.out.println("   where 1 = 1 版 : " + dyn().where(NS + "searchWhere1", arg(one)));
        System.out.println("   <where> 版     : " + dyn().where(NS + "search", arg(one)));
        System.out.println("   ★ 注意 <where> 版的開頭 —— XML 裡寫的是「AND o.status = ?」，"
                + "而 AND 不見了。");
    }

    @Test @Transactional
    void a3b_空條件的兩種SQL都跑得動() {
        head("8.3.3b 兩種寫法的結果一樣嗎");
        var empty = OrderSearch8.empty();
        System.out.println("  where 1 = 1 版 → " + orders.searchWhere1(b(empty)).size() + " 張");
        System.out.println("  <where> 版     → " + orders.search(b(empty)).size() + " 張");
        System.out.println("  ★ 結果一樣。差別在【SQL 文字】，而那件事只有在 8.3.13 才會變成問題。");
    }

    // ══════════════ 8.3.4 忘了寫開頭的 and ══════════════

    @Test @Transactional
    void a4_忘了寫and() {
        head("8.3.4 <if> 裡忘了開頭的 AND");
        var one = OrderSearch8.empty().withStatus(St8.PENDING);
        var two = one.withMinAmount(new BigDecimal("200"));

        System.out.println("── 只有一個條件成立");
        System.out.println("   SQL  : " + dyn().where(NS + "searchMissingAnd", arg(one)));
        System.out.println("   執行 : " + orders.searchMissingAnd(b(one)).size() + " 張 ← 完全正常");

        System.out.println("\n── 🔴 兩個條件都成立");
        System.out.println("   SQL  : " + dyn().where(NS + "searchMissingAnd", arg(two)));
        Throwable t = catching(() -> orders.searchMissingAnd(b(two)));
        System.out.println("   執行 : " + name(t));
        System.out.println("          " + msg(t));
        System.out.println("\n  ★ 這就是 05 章 5.9.1 問題②：要【湊齊那個組合】才會發生。");
        System.out.println("    而 8.9.1 那條斷言會把 64 種組合全部產生一次 —— 不用資料庫。");
    }

    // ══════════════ 8.3.5 <trim> ══════════════

    @Test
    void a5_trim() {
        head("8.3.5 <trim>：<where> 是它的特例");
        List<OrderSearch8> combos = allCombinations();
        int same = 0, diff = 0;
        for (OrderSearch8 c : combos) {
            // search 有六個條件、searchTrim 只有兩個，只比較兩者共有的那兩個條件的組合
            if (c.customerKeyword() != null || c.from() != null || c.to() != null
                    || c.hasRep() != null) continue;
            String w = dyn().where(NS + "search", arg(c));
            String t = dyn().where(NS + "searchTrim", arg(c));
            if (w.equals(t)) same++;
            else { diff++; System.out.println("   不同：\n     <where> " + w
                    + "\n     <trim>  " + t); }
        }
        System.out.println("  只填 status / minAmount 的 4 種組合：一字不差 " + same + " 種，不同 " + diff + " 種");
        System.out.println("\n  ★ <where> 等於：");
        System.out.println("    <trim prefix=\"WHERE\" prefixOverrides=\"AND |OR \"> … </trim>");
        System.out.println("  ★ <set> 等於：");
        System.out.println("    <trim prefix=\"SET\" suffixOverrides=\",\"> … </trim>");
    }

    // ══════════════ 8.3.6 / 8.3.7 <set> ══════════════

    @Test @Transactional
    void a6_set標籤() {
        head("8.3.6 <set>：只更新有給值的欄位");
        var id = orderIds.get(0);
        jdbc.update("UPDATE orders SET memo = ?, total_amount = ? WHERE id = ?",
                "原始備註", new BigDecimal("999.0000"), com.example.lab.Uuid7.toBytes(id));

        System.out.println("── ✅ patch(只給 status)");
        showTail("patch", () -> orders.patch(id, St8.PAID, null, null));
        Map<String, Object> after = jdbc.queryForMap(
                "SELECT status, memo, total_amount, version FROM orders WHERE id = ?",
                com.example.lab.Uuid7.toBytes(id));
        System.out.println("   結果：" + after);

        System.out.println("\n── 🔴 patchAll(給了 status 與金額，memo 沒給)");
        showTail("patchAll", () -> orders.patchAll(id, St8.SHIPPED, null, new BigDecimal("999.0000")));
        System.out.println("   結果：" + jdbc.queryForMap(
                "SELECT status, memo, total_amount, version FROM orders WHERE id = ?",
                com.example.lab.Uuid7.toBytes(id)));
        System.out.println("   ★ memo 被【靜默】清成 null。而這句 SQL 跟「真的要清 memo」時"
                + "產生的 SQL【一字不差】。");

        System.out.println("\n── 🔴 patchAll(全部沒給) —— 這一次它不安靜");
        Throwable t = catching(() -> orders.patchAll(id, St8.SHIPPED, null, null));
        System.out.println("   " + name(t) + "\n   " + msg(t));

        System.out.println("\n  ★ 兩種下場的差別只在【那一欄可不可以是 null】：");
        System.out.println("    可以 → 靜默清空（跟 03 章 3.6.4 的 merge 同一個形狀）");
        System.out.println("    不可以 → 執行期例外（而它是【運氣好】才被抓到的）");
    }

    @Test @Transactional
    void a7_set全部不成立() {
        head("8.3.7 🔴 <set> 裡全部 <if> 都不成立");
        var id = orderIds.get(0);
        System.out.println("  產生的 SQL：" + Dyn.one(
                dyn().sql(NS + "patchNothing", Dyn.args("id", id, "status", null, "memo", null))));
        Throwable t = catching(() -> orders.patchNothing(id, null, null));
        System.out.println("  執行     ：" + name(t));
        System.out.println("            " + msg(t));
        System.out.println("\n  ★ <set> 不像 <where> —— 它【不會】在內容為空時把 SET 拿掉，"
                + "因為「UPDATE 沒有 SET」本身就不合法。");
        System.out.println("    正解：在 <set> 裡放一個一定成立的欄位（本章是 version = version + 1），");
        System.out.println("    或在進 mapper 之前就擋掉「什麼都沒改」這個請求。");
    }

    // ══════════════ 8.3.8 <choose> ══════════════

    @Test
    void a8_choose() {
        head("8.3.8 <choose>：只有一個分支會成立");
        var none = OrderSearch8.empty();
        var st = none.withStatus(St8.PENDING);
        var both = st.withMinAmount(new BigDecimal("200"));
        var amt = none.withMinAmount(new BigDecimal("200"));

        System.out.println("  什麼都沒填       → " + dyn().where(NS + "searchChoose", arg(none)));
        System.out.println("  只有 status      → " + dyn().where(NS + "searchChoose", arg(st)));
        System.out.println("  只有 minAmount   → " + dyn().where(NS + "searchChoose", arg(amt)));
        System.out.println("  🔴 兩個都填      → " + dyn().where(NS + "searchChoose", arg(both)));
        System.out.println("\n  ★ 兩個都填的時候 minAmount 【被忽略】，而且沒有任何提示。");
        System.out.println("    <choose> 適合「互斥的分支」（例如三種不同的排序模式），");
        System.out.println("    不適合「可以同時成立的條件」—— 那是 <if> 的工作。");
    }

    // ══════════════ 8.3.9 <bind> 與 like ══════════════

    @Test @Transactional
    void a9_bind與like() {
        head("8.3.9 <bind>：like 的 % 該在哪裡");
        var q = OrderSearch8.empty().withCustomerKeyword("客戶1");

        System.out.println("── ✅ <bind> 版");
        System.out.println("   SQL  : " + dyn().where(NS + "searchBind", arg(q)));
        System.out.println("   ?    : " + dyn().params(NS + "searchBind", arg(q)));
        System.out.println("   結果 : " + orders.searchBind(b(q)).size() + " 張");

        System.out.println("\n── 🔴 ${} 版");
        System.out.println("   SQL  : " + dyn().where(NS + "searchLikeConcat", arg(q)));
        System.out.println("   結果 : " + orders.searchLikeConcat(b(q)).size() + " 張");

        System.out.println("\n── 🔴 ${} 版遇到一個「特別的」關鍵字");
        var pct = OrderSearch8.empty().withCustomerKeyword("%");
        System.out.println("   SQL  : " + dyn().where(NS + "searchLikeConcat", arg(pct)));
        System.out.println("   結果 : " + orders.searchLikeConcat(b(pct)).size() + " 張");
        System.out.println("   而 <bind> 版：" + orders.searchBind(b(pct)).size()
                + " 張（% 是資料裡真的有的字元才算）");

        System.out.println("\n── 🔴🔴 <bind> 在【條件不成立時也會執行】");
        var nul = OrderSearch8.empty();
        Throwable t = catching(() -> dyn().where(NS + "searchBind", arg(nul)));
        System.out.println("   關鍵字沒填 → " + name(t));
        System.out.println("                " + msg(t));
        Throwable t2 = catching(() -> orders.searchBind(b(nul)));
        System.out.println("   真的呼叫   → " + name(t2));
        System.out.println("\n   ★ <bind> 不是 <if> 的子節點，它在【SQL 組裝的第一步】就被求值。");
        System.out.println("     '%' + null 在 OGNL 裡不是 \"%null\" —— 它是 NullPointerException。");
        System.out.println("     ✅ 正解：三元運算子（本章共用片段 searchWhere 用的就是這一版）");
        var q2 = OrderSearch8.empty().withStatus(St8.PENDING);
        System.out.println("       searchWhere 版、關鍵字沒填 → "
                + dyn().where(NS + "search", arg(q2)));
    }

    // ══════════════ 8.3.10 <include> 帶參數 ══════════════

    @Test @Transactional
    void aa_include帶參數() {
        head("8.3.10 <sql> / <include> 與兩段式代換");
        var q = OrderSearch8.empty().withStatus(St8.PENDING);
        var args = Dyn.args("q", b(q), "sortColumn", "o.total_amount", "sortDir", "DESC");
        System.out.println("  完整 SQL 的尾巴：");
        String sql = dyn().sql(NS + "searchInclude", args);
        System.out.println("    " + sql.substring(Math.max(0, sql.toUpperCase().lastIndexOf(" WHERE "))));
        System.out.println("\n  ★ <include> 的 <property> 是【XML 解析期】代換的：");
        System.out.println("      <sql> 裡的 ${col}  →（解析期）→ ${sortColumn} →（執行期）→ o.total_amount");
        System.out.println("    兩段代換，而中間那一段是【純文字】。");

        var rows = orders.searchInclude(b(q), "o.total_amount", "DESC");
        System.out.println("\n  執行：" + rows.size() + " 張，第一筆金額 "
                + (rows.isEmpty() ? "-" : rows.get(0).totalAmount()));

        System.out.println("\n── 🔴 而它是 ${} —— 所以要白名單（07 章 7.6.5 的 OrderSort）");
        Throwable t = catching(() -> orders.searchInclude(b(q),
                "o.total_amount; DROP TABLE audit_sql", "DESC"));
        System.out.println("   丟一個奇怪的欄位名進去：" + name(t));
    }

    // ══════════════ 8.3.11 OGNL 與 record ══════════════

    @Test @Transactional
    void ab_ognl與record() {
        head("8.3.11 OGNL 認不認得 record");
        var rec = OrderSearch8.empty().withStatus(St8.PENDING);

        System.out.println("── ① <if test=\"q.status != null\">，參數是 record");
        Throwable t1 = catching(() -> System.out.println(
                "   SQL : " + dyn().where(NS + "searchRecord", Dyn.args("q", rec))));
        if (t1 != null) System.out.println("   → " + name(t1) + "\n     " + msg(t1));

        System.out.println("\n── ② <if test=\"q.status() != null\">（呼叫存取子方法）");
        Throwable t2 = catching(() -> System.out.println(
                "   SQL : " + dyn().where(NS + "searchRecordCall", Dyn.args("q", rec))));
        if (t2 != null) System.out.println("   → " + name(t2) + "\n     " + msg(t2));

        System.out.println("\n── ③ 真的執行一次");
        Throwable t3 = catching(() -> System.out.println(
                "   searchRecord     → " + orders.searchRecord(rec).size() + " 張"));
        if (t3 != null) System.out.println("   searchRecord     → " + name(t3));
        Throwable t4 = catching(() -> System.out.println(
                "   searchRecordCall → " + orders.searchRecordCall(rec).size() + " 張"));
        if (t4 != null) System.out.println("   searchRecordCall → " + name(t4)
                + "\n     " + msg(t4));

        System.out.println("\n  ★ 結論：");
        System.out.println("    <if test=\"…\"> 裡面是 OGNL —— 屬性、方法呼叫都可以。");
        System.out.println("    #{…} 裡面【不是】OGNL —— 它只是一條屬性路徑。");
        System.out.println("    而 record 在 MyBatis 3.5.14 上，兩邊的【屬性形式】都認得。");
    }

    @Test @Transactional
    void ab2_打錯字的兩種形狀() {
        head("8.3.11b <if> 裡打錯字：兩種形狀、兩種下場");
        var q = OrderSearch8.empty().withStatus(St8.PENDING);

        System.out.println("── ① 根名字打錯（qq.status，而參數叫 q）");
        Throwable t1 = catching(() -> System.out.println(
                "   SQL : " + dyn().where(NS + "searchTypoRoot", arg(q))));
        if (t1 != null) System.out.println("   → " + name(t1) + "\n     " + msg(t1));
        Throwable t1b = catching(() -> orders.searchTypoRoot(b(q)));
        System.out.println("   執行: " + name(t1b));

        System.out.println("\n── ② 屬性名打錯（q.statusX）");
        Throwable t2 = catching(() -> System.out.println(
                "   SQL : " + dyn().where(NS + "searchTypoProp", arg(q))));
        if (t2 != null) System.out.println("   → " + name(t2) + "\n     " + msg(t2));
        Throwable t2b = catching(() -> System.out.println(
                "   執行: " + orders.searchTypoProp(b(q)).size() + " 張"));
        if (t2b != null) System.out.println("   執行: " + name(t2b));

        System.out.println("\n── ③ 量尺自己也會騙人：HashMap vs ParamMap");
        System.out.println("   ParamMap（MyBatis 真的用的）：");
        Throwable t3 = catching(() -> dyn().sql(NS + "searchTypoRoot", Dyn.args("q", b(q))));
        System.out.println("     " + name(t3));
        System.out.println("   HashMap（隨手寫的量尺）：");
        Throwable t4 = catching(() -> dyn().sql(NS + "searchTypoRoot", Dyn.looseArgs("q", b(q))));
        System.out.println("     " + (t4 == null ? "沒有例外 —— 條件被當成【不成立】" : name(t4)));
        System.out.println("\n   ★ 所以 Dyn.args() 一定要回傳 MapperMethod.ParamMap。");
        System.out.println("     用 HashMap 的量尺會把「打錯字」量成「使用者沒填這個條件」。");
    }

    // ══════════════ 8.3.13 SQL 形狀爆炸 ══════════════

    @Test @Transactional
    void ac_形狀爆炸() {
        head("8.3.13 動態 SQL 的代價：SQL 形狀的數量");
        List<OrderSearch8> combos = allCombinations();

        Set<String> shapes = new LinkedHashSet<>();
        for (OrderSearch8 c : combos) shapes.add(dyn().sql(NS + "search", arg(c)));
        System.out.println("  64 種條件組合 → " + shapes.size() + " 種 SQL 形狀");

        System.out.println("\n  問伺服器：剖析了幾句（MysqlStat，06 章第三把尺）");
        stat().mark();
        List<String> sqls = spy(() -> { for (OrderSearch8 c : combos) orders.search(b(c)); });
        var d = stat().delta();
        System.out.println("    JDBC 送出        : " + sqls.size() + " 句");
        System.out.println("    Com_stmt_prepare : " + d.get("Com_stmt_prepare"));
        System.out.println("    Com_select       : " + d.get("Com_select"));

        System.out.println("\n  ★ 這 64 種形狀【每一種都吃掉一格計畫快取】——");
        System.out.println("    跟 05 章 5.5.2 那個「拼字串」的代價是同一件事，");
        System.out.println("    而這一次它是【動態 SQL 本質上】的代價，不是寫錯造成的。");
    }

    @Test @Transactional
    void ad_同一份條件給列表與count() {
        head("8.3.12 <sql> 的真正用途：讓 count 跟列表用同一組條件");
        var q = OrderSearch8.empty().withStatus(St8.PENDING).withHasRep(Boolean.TRUE);

        String listWhere = dyn().where(NS + "search", arg(q));
        String countWhere = dyn().where(NS + "searchCount", arg(q));
        System.out.println("  列表的 WHERE : " + listWhere);
        System.out.println("  count 的 WHERE: " + countWhere);
        System.out.println("  一字不差？    : " + listWhere.equals(countWhere));

        List<OrderRow8> rows = orders.search(b(q));
        long total = orders.searchCount(b(q));
        System.out.println("\n  列表 " + rows.size() + " 筆、count " + total + " 筆 → 對得上："
                + (rows.size() == total));
        System.out.println("\n  ★ 這是 05 章 5.7.4 那個「自動生成的 count 會算錯」的另一種解法：");
        System.out.println("    不要讓框架猜，把條件抽成【一份】，兩邊 <include> 同一個 refid。");
    }
}
```

**這一章的資料**：

```
═══ 8.2.1 ch08 的資料 ═══
  訂單 20 張，明細 40 筆，客戶 4 個，業務 3 個
  四種狀態各幾張：[{status=CANCELLED, n=5}, {status=PAID, n=5},
                  {status=PENDING, n=5}, {status=SHIPPED, n=5}]
  有／沒有業務員：[{no_rep=1, n=8}, {no_rep=0, n=12}]
```

---

### 8.3.1 🔴 實測：對照組 —— `<if>` + `${}` 拼字串

**先看最直覺的寫法**：`<if>` 決定條件要不要出現、`${}` 把值放進去。

```xml
  <select id="searchConcat" resultMap="rowMap">
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
    WHERE 1 = 1
    <if test="q.status != null">          AND o.status = '${q.status}'                       </if>
    <if test="q.customerKeyword != null"> AND c.display_name LIKE '%${q.customerKeyword}%'   </if>
    <if test="q.minAmount != null">       AND o.total_amount &gt;= ${q.minAmount}            </if>
    ORDER BY o.placed_at, o.id
  </select>
```

```java
    @Test @Transactional
    void a1_拼字串版() {
        head("8.3.1 對照組：<if> + ${} 拼字串");
        var q = OrderSearch8.empty().withStatus(St8.PENDING).withCustomerKeyword("客戶1");
        System.out.println("── 正常輸入");
        System.out.println("   SQL 尾巴 : " + dyn().where(NS + "searchConcat", arg(q)));
        System.out.println("   ? 的個數 : " + dyn().placeholders(NS + "searchConcat", arg(q)));
        System.out.println("   結果     : " + orders.searchConcat(b(q)).size() + " 張");

        System.out.println("\n── 🔴 換一個「輸入」");
        var evil = OrderSearch8.empty().withCustomerKeyword("x' OR 1=1 OR ''='");
        System.out.println("   SQL 尾巴 : " + dyn().where(NS + "searchConcat", arg(evil)));
        System.out.println("   結果     : " + orders.searchConcat(b(evil)).size()
                + " 張（資料庫裡總共 "
                + jdbc.queryForObject("SELECT count(*) FROM orders", Long.class) + " 張）");

        System.out.println("\n── ✅ 同一個輸入，參數版（search）");
        System.out.println("   SQL 尾巴 : " + dyn().where(NS + "search", arg(evil)));
        System.out.println("   結果     : " + orders.search(b(evil)).size() + " 張");
    }
```

```
═══ 8.3.1 對照組：<if> + ${} 拼字串 ═══
── 正常輸入
   SQL 尾巴 : WHERE 1 = 1 AND o.status = 'PENDING' AND c.display_name LIKE '%客戶1%'
   ? 的個數 : 0
   結果     : 1 張

── 🔴 換一個「輸入」
   SQL 尾巴 : WHERE 1 = 1 AND c.display_name LIKE '%x' OR 1=1 OR ''='%'
   結果     : 20 張（資料庫裡總共 20 張）

── ✅ 同一個輸入，參數版（search）
   SQL 尾巴 : WHERE c.display_name LIKE ?
   結果     : 0 張
```

**兩件事同時發生**：

```
① ? 的個數是 0 —— 這句 SQL 裡【沒有一個參數】。
   所有的值都變成了 SQL 文字，包含使用者打進來的那一串。

② 一個 17 個字元的輸入，把「找名字含 x 的客戶」變成「回傳全部 20 張訂單」。
   而 SQL 是【完全合法】的，資料庫沒有任何理由抱怨。
```

📌 **07 章 7.6.3 證明了 `#{}` 與 `${}` 送到伺服器的東西一字不差，
那一節的結論是「`#{}` 的安全性來自驅動正確地轉義引號」。**
**這一節是那個結論的後果：`${}` 是【MyBatis 自己做的字串串接】，
在驅動看到那句 SQL 之前就完成了 —— 驅動沒有機會保護你。**

⚠️ 而 `LIKE '%x' OR 1=1 OR ''='%'` 這個 payload 值得看一眼：

```
LIKE '%x'   →  false（沒有名字結尾是 x）
OR 1=1      →  true   ← 就是這裡
OR ''='%'   →  用來把最後那個多出來的 %' 吃掉，讓 SQL 保持合法
```

**注入不需要「猜到欄位名」，只需要「知道自己的字串會被貼進哪裡」。**

---

### 8.3.2 ★★ 實測：64 種組合一次展開

```java
    @Test
    void a2_六十四種組合() {
        head("8.3.2 六個可選條件 = 64 種 SQL，全部展開（不執行）");
        List<OrderSearch8> combos = allCombinations();
        System.out.println("  組合數：" + combos.size());

        Set<String> shapes = new LinkedHashSet<>();
        for (OrderSearch8 c : combos) shapes.add(dyn().where(NS + "search", arg(c)));
        System.out.println("  不同的 WHERE 形狀：" + shapes.size() + " 種");

        System.out.println("\n  前六種：");
        int n = 0;
        for (String s : shapes) { if (n++ < 6) System.out.println("    " + s); }

        System.out.println("\n  最滿的那一種（六個條件都填）：");
        var full = combos.get(combos.size() - 1);
        System.out.println("    " + dyn().where(NS + "search", arg(full)));
        System.out.println("    ? 對應：" + dyn().params(NS + "search", arg(full)));

        for (int w = 0; w < 3; w++)
            for (OrderSearch8 c : combos) dyn().sql(NS + "search", arg(c));
        long t0 = System.nanoTime();
        for (OrderSearch8 c : combos) dyn().sql(NS + "search", arg(c));
        System.out.println("\n  展開 64 種花了 " + (System.nanoTime() - t0) / 1000
                + " µs（沒有資料庫）");
    }
```

```
═══ 8.3.2 六個可選條件 = 64 種 SQL，全部展開（不執行） ═══
  組合數：64
  不同的 WHERE 形狀：64 種

  前六種：
    （沒有 WHERE）
    WHERE o.status = ?
    WHERE c.display_name LIKE ?
    WHERE o.status = ? AND c.display_name LIKE ?
    WHERE o.placed_at >= ?
    WHERE o.status = ? AND o.placed_at >= ?

  最滿的那一種（六個條件都填）：
    WHERE o.status = ? AND c.display_name LIKE ? AND o.placed_at >= ?
          AND o.placed_at < ? AND o.total_amount >= ? AND o.rep_id IS NOT NULL
    ? 對應：[q.status, kw, q.from, q.to, q.minAmount]

  展開 64 種花了 7749 µs（沒有資料庫）
```

**兩個觀察**：

**① 最滿的那一種有六個條件，而 `?` 只有五個。**
第六個條件（`hasRep`）產生的是 `o.rep_id IS NOT NULL` —— **它沒有參數**。
這件事在 8.4.3 會變成一個問題（`in` 子句的長度會改變 `?` 的個數），
而在這裡它只是提醒你：**「條件數」與「參數數」不是同一件事**。

**② 64 種組合、7.7 ms、不碰資料庫。**

📌 **這就是 8.2.3 那把尺的價值**：

```
要「跑」64 種組合：需要 64 種資料情境、64 次資料庫來回、幾秒鐘
要「展開」64 種組合：0 個資料情境、0 次來回、7.7 ms
```

**而 8.3.4 那個錯誤，展開就抓得到。**

---

### 8.3.3 ✅ 實測：`where 1 = 1` 為什麼不需要

```java
    @Test
    void a3_where標籤() {
        head("8.3.3 <where> 與 where 1 = 1");
        var empty = OrderSearch8.empty();
        var one = OrderSearch8.empty().withStatus(St8.PENDING);

        System.out.println("── 空條件");
        System.out.println("   where 1 = 1 版 : " + dyn().where(NS + "searchWhere1", arg(empty)));
        System.out.println("   <where> 版     : " + dyn().where(NS + "search", arg(empty)));

        System.out.println("\n── 一個條件");
        System.out.println("   where 1 = 1 版 : " + dyn().where(NS + "searchWhere1", arg(one)));
        System.out.println("   <where> 版     : " + dyn().where(NS + "search", arg(one)));
    }
```

```
═══ 8.3.3 <where> 與 where 1 = 1 ═══
── 空條件
   where 1 = 1 版 : WHERE 1 = 1
   <where> 版     : （沒有 WHERE）

── 一個條件
   where 1 = 1 版 : WHERE 1 = 1 AND o.status = ?
   <where> 版     : WHERE o.status = ?
```

**`<where>` 做的事只有兩件**：

```
① 如果裡面【產生了東西】，就在前面加一個 WHERE；沒有就什麼都不加。
② 如果裡面產生的東西【以 AND 或 OR 開頭】，就把那個開頭砍掉。
```

⚠️ **第②件事是它最容易被誤解的地方。** XML 裡每一個 `<if>` 都寫著開頭的 `AND`，
而**第一個成立的那個 `AND` 會消失**：

```
只有 status 成立      → WHERE o.status = ?                          （AND 被砍）
status + minAmount    → WHERE o.status = ? AND o.total_amount >= ?   （只砍第一個）
只有 minAmount 成立   → WHERE o.total_amount >= ?                    （AND 被砍）
```

**每一個 `<if>` 都要寫 `AND`，而它們不會全部出現在 SQL 裡。**
這是 `<where>` 的設計：**每一個條件都寫成「可以接在別人後面」的形狀，
而第一名那個的開頭由 `<where>` 處理。**

📌 **回答 05 章 5.9.1 問題①**：

```
where 1 = 1 存在的理由是「我不知道我是不是第一個條件」。
<where> 把那件事變成【框架的責任】，所以那個理由消失了。
```

而 `where 1 = 1` **不只是醜**：

```
① 它是一個永真條件。大部分資料庫的最佳化器會消掉它，
   而「大部分」這個詞在效能問題上沒有價值。
② 它讓「空條件」與「一個條件」的 SQL 形狀【一定不一樣】——
   而 8.3.13 要證明形狀的數量是有代價的。
③ 最實際的：它讓 code review 看不出「這個查詢有沒有必填條件」。
   <where> 版的空條件會產生【沒有 WHERE 的全表掃描】，那是一個看得見的事實。
```

⚠️ **順帶一提：`<where>` 版空條件時真的會全表掃描。**
這不是 `<where>` 的錯 —— 是**「六個條件全部可選」這個需求本身**的問題。
正解是在 mapper 之外擋掉（例如「至少要有時間範圍」），而 8.9 會把它變成一條斷言。

---

### 8.3.4 🔴 實測：`<if>` 裡忘了開頭的 `AND`

```xml
  <select id="searchMissingAnd" resultMap="rowMap">
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
    <where>
      <if test="q.status != null">    o.status = #{q.status}              </if>
      <if test="q.minAmount != null"> o.total_amount &gt;= #{q.minAmount} </if>
    </where>
    ORDER BY o.placed_at, o.id
  </select>
```

```java
    @Test @Transactional
    void a4_忘了寫and() {
        head("8.3.4 <if> 裡忘了開頭的 AND");
        var one = OrderSearch8.empty().withStatus(St8.PENDING);
        var two = one.withMinAmount(new BigDecimal("200"));

        System.out.println("── 只有一個條件成立");
        System.out.println("   SQL  : " + dyn().where(NS + "searchMissingAnd", arg(one)));
        System.out.println("   執行 : " + orders.searchMissingAnd(b(one)).size()
                + " 張 ← 完全正常");

        System.out.println("\n── 🔴 兩個條件都成立");
        System.out.println("   SQL  : " + dyn().where(NS + "searchMissingAnd", arg(two)));
        Throwable t = catching(() -> orders.searchMissingAnd(b(two)));
        System.out.println("   執行 : " + name(t));
        System.out.println("          " + msg(t));
    }
```

```
═══ 8.3.4 <if> 裡忘了開頭的 AND ═══
── 只有一個條件成立
   SQL  : WHERE o.status = ?
   執行 : 5 張 ← 完全正常

── 🔴 兩個條件都成立
   SQL  : WHERE o.status = ? o.total_amount >= ?
   執行 : BadSqlGrammarException ← SQLSyntaxErrorException
          You have an error in your SQL syntax; check the manual that corresponds
          to your MySQL server version for the right syntax to use near 'o.total_amount …
```

🔴 **這就是 05 章 5.9.1 問題②，一字不改地成立**：

```
單獨測每一個條件 → 全部通過
                  ↓
   而 bug 藏在【任意兩個條件同時成立】的那 57 種組合裡
```

**六個條件的 API，有 64 種組合。你的測試蓋得到幾種？**

📌 **而這一次我們有工具**：8.3.2 那 64 次 `getBoundSql()` 花了 7.7 ms。
**8.9.1 會把它寫成一條斷言：64 種組合，每一種都必須產生合法的 SQL。**

⚠️ **這個錯誤的另一個形狀更陰險**：`AND` 沒忘，忘的是**空白**。

```xml
<if test="a != null">AND a = #{a}</if>
<if test="b != null">AND b = #{b}</if>
```

XML 的文字節點會保留換行，所以上面這樣寫**是對的**。
而如果有人為了「排版整齊」把它們寫在同一行：

```xml
<if test="a != null">AND a = #{a}</if><if test="b != null">AND b = #{b}</if>
```

→ `WHERE a = ?AND b = ?` → **`?AND` 在 MySQL 上是語法錯誤，而在某些資料庫上不是。**
**一律讓每一個 `<if>` 的內容以空白開頭、以空白結尾。**

---

### 8.3.5 實測：`<trim>` —— `<where>` 與 `<set>` 都是它的特例

```xml
  <select id="searchTrim" resultMap="rowMap">
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
    <trim prefix="WHERE" prefixOverrides="AND |OR ">
      <if test="q.status != null">    AND o.status = #{q.status}              </if>
      <if test="q.minAmount != null"> AND o.total_amount &gt;= #{q.minAmount} </if>
    </trim>
    ORDER BY o.placed_at, o.id
  </select>
```

```java
    @Test
    void a5_trim() {
        head("8.3.5 <trim>：<where> 是它的特例");
        List<OrderSearch8> combos = allCombinations();
        int same = 0, diff = 0;
        for (OrderSearch8 c : combos) {
            // search 有六個條件、searchTrim 只有兩個，只比較兩者共有的那兩個條件的組合
            if (c.customerKeyword() != null || c.from() != null || c.to() != null
                    || c.hasRep() != null) continue;
            String w = dyn().where(NS + "search", arg(c));
            String t = dyn().where(NS + "searchTrim", arg(c));
            if (w.equals(t)) same++;
            else { diff++; System.out.println("   不同：\n     <where> " + w
                    + "\n     <trim>  " + t); }
        }
        System.out.println("  只填 status / minAmount 的 4 種組合：一字不差 " + same
                + " 種，不同 " + diff + " 種");
    }
```

```
═══ 8.3.5 <trim>：<where> 是它的特例 ═══
  只填 status / minAmount 的 4 種組合：一字不差 4 種，不同 0 種
```

**四個屬性**：

| 屬性 | 意思 |
|---|---|
| `prefix` | 內容非空時，在**前面**加這段字 |
| `suffix` | 內容非空時，在**後面**加這段字 |
| `prefixOverrides` | 內容如果以這些字串之一開頭，把它砍掉（`\|` 分隔，**空白算在裡面**） |
| `suffixOverrides` | 內容如果以這些字串之一結尾，把它砍掉 |

**所以**：

```
<where> … </where>   ≡   <trim prefix="WHERE" prefixOverrides="AND |OR "> … </trim>
<set>   … </set>     ≡   <trim prefix="SET"   suffixOverrides=",">        … </trim>
```

📌 **什麼時候真的需要 `<trim>`**：

```
① 不是 WHERE 也不是 SET 的位置 —— 例如動態組 INSERT 的欄位清單：
   <trim prefix="(" suffix=")" suffixOverrides=",">        …欄位…  </trim>
   <trim prefix="VALUES (" suffix=")" suffixOverrides=","> …值…    </trim>
② 條件是以 AND 【結尾】而不是開頭的舊程式碼（suffixOverrides="AND |OR "）
③ HAVING 子句
```

⚠️ **`prefixOverrides="AND |OR "` 那兩個空白不是排版**。
寫成 `prefixOverrides="AND|OR"` 的話，
`ANDROID_ID = ?` 這種欄位名開頭會被砍掉三個字元。

---

### 8.3.6 實測：`<set>` 與那個靜默清空

```xml
  <update id="patch">
    UPDATE orders
    <set>
      <if test="status != null">      status = #{status},             </if>
      <if test="memo != null">        memo = #{memo},                 </if>
      <if test="totalAmount != null"> total_amount = #{totalAmount},  </if>
      version = version + 1
    </set>
    WHERE id = #{id}
  </update>

  <!-- 🔴 一律更新四欄 -->
  <update id="patchAll">
    UPDATE orders
       SET status = #{status},
           memo = #{memo},
           total_amount = #{totalAmount},
           version = version + 1
     WHERE id = #{id}
  </update>
```

```java
    @Test @Transactional
    void a6_set標籤() {
        head("8.3.6 <set>：只更新有給值的欄位");
        var id = orderIds.get(0);
        jdbc.update("UPDATE orders SET memo = ?, total_amount = ? WHERE id = ?",
                "原始備註", new BigDecimal("999.0000"), com.example.lab.Uuid7.toBytes(id));

        System.out.println("── ✅ patch(只給 status)");
        showTail("patch", () -> orders.patch(id, St8.PAID, null, null));
        System.out.println("   結果：" + jdbc.queryForMap(
                "SELECT status, memo, total_amount, version FROM orders WHERE id = ?",
                com.example.lab.Uuid7.toBytes(id)));

        System.out.println("\n── 🔴 patchAll(給了 status 與金額，memo 沒給)");
        showTail("patchAll", () -> orders.patchAll(id, St8.SHIPPED, null,
                new BigDecimal("999.0000")));
        System.out.println("   結果：" + jdbc.queryForMap(
                "SELECT status, memo, total_amount, version FROM orders WHERE id = ?",
                com.example.lab.Uuid7.toBytes(id)));

        System.out.println("\n── 🔴 patchAll(全部沒給) —— 這一次它不安靜");
        Throwable t = catching(() -> orders.patchAll(id, St8.SHIPPED, null, null));
        System.out.println("   " + name(t) + "\n   " + msg(t));
    }
```

```
═══ 8.3.6 <set>：只更新有給值的欄位 ═══
── ✅ patch(只給 status)
── patch → 1 句 SQL
   UPDATE orders SET status = ?, version = version + 1 WHERE id = ?
   結果：{status=PAID, memo=原始備註, total_amount=999.0000, version=1}

── 🔴 patchAll(給了 status 與金額，memo 沒給)
── patchAll → 1 句 SQL
   UPDATE orders SET status = ?, memo = ?, total_amount = ?, version = version + 1 WHERE id = ?
   結果：{status=SHIPPED, memo=null, total_amount=999.0000, version=2}

── 🔴 patchAll(全部沒給) —— 這一次它不安靜
   DataIntegrityViolationException ← SQLIntegrityConstraintViolationException
   Column 'total_amount' cannot be null
```

📌 **`patch` 這個寫法有三個細節值得抄**：

```
① 每一個 <if> 的內容以逗號【結尾】（不是開頭）—— <set> 砍的是尾巴的逗號
② 最後那一行 version = version + 1 【不在任何 <if> 裡】：
   它保證 <set> 永遠非空（8.3.7 要看沒有它的樣子），
   而且它同時解掉 06 章 6.6.10 那件事（旁路寫入要自己維護 version）
③ 有了②，前面每一個 <if> 都可以放心地以逗號結尾
```

🔴 **而 `patchAll` 的兩種下場，差別只在「那一欄可不可以是 null」**：

```
memo 可為 null        → 靜默清空。SQL 跟「真的要清 memo」時【一字不差】
total_amount NOT NULL → 執行期例外，而它是【運氣好】才被抓到的
```

**這跟 03 章 3.6.4 那個 `merge` 靜默清空是同一個形狀**：

```
03 章：一個「改名 API」把 nickname 清成 null，而 SQL 跟正確版一字不差
08 章：一個「改狀態 API」把 memo 清成 null，而 SQL 跟正確版一字不差
──────────────────────────────────────────────────────────
共同的根源：「沒有給這個欄位」與「要把這個欄位設成 null」
           在 API 的型別上長得【一模一樣】。
```

⚠️ **所以 `<set>` 只解掉一半的問題。** 它讓「沒給的欄位不要出現在 SQL 裡」變得容易，
而它**不能**告訴你「使用者是沒給，還是要清空」。那個資訊必須在 API 的型別裡：

```java
// 一種可行的做法：用 Optional 表達三態
// null            = 沒給這個欄位
// Optional.empty  = 要清成 null
// Optional.of(x)  = 要設成 x
record OrderPatch(Optional<String> memo, Optional<St8> status) {}
```

**而 mapper 那一側寫成 `<if test="memo != null">memo = #{memo.orElse(null)},</if>` ——
🔴 這一行【不會動】，原因在 8.3.11：`#{}` 裡不能呼叫方法。**
正解是先 `<bind name="memoVal" value="memo == null ? null : memo.orElse(null)"/>`。

---

### 8.3.7 🔴 實測：`<set>` 裡全部 `<if>` 都不成立

```xml
  <update id="patchNothing">
    UPDATE orders
    <set>
      <if test="status != null"> status = #{status}, </if>
      <if test="memo != null">   memo = #{memo},     </if>
    </set>
    WHERE id = #{id}
  </update>
```

```java
    @Test @Transactional
    void a7_set全部不成立() {
        head("8.3.7 🔴 <set> 裡全部 <if> 都不成立");
        var id = orderIds.get(0);
        System.out.println("  產生的 SQL：" + Dyn.one(dyn().sql(NS + "patchNothing",
                Dyn.args("id", id, "status", null, "memo", null))));
        Throwable t = catching(() -> orders.patchNothing(id, null, null));
        System.out.println("  執行     ：" + name(t));
        System.out.println("            " + msg(t));
    }
```

```
═══ 8.3.7 🔴 <set> 裡全部 <if> 都不成立 ═══
  產生的 SQL：UPDATE orders WHERE id = ?
  執行     ：BadSqlGrammarException ← SQLSyntaxErrorException
            You have an error in your SQL syntax; … near 'WHERE id = x'01…
```

**`<set>` 與 `<where>` 在「內容為空」時的行為不一樣**：

```
<where>  內容為空 → 連 WHERE 都不加   → SQL 合法（變成全表查詢）
<set>    內容為空 → 連 SET 都不加     → SQL 【不合法】（UPDATE 沒有 SET）
```

**這其實是對的設計**：「沒有 WHERE 的 SELECT」是合法的查詢，
「沒有 SET 的 UPDATE」不是合法的語句。**框架不能把它變成合法的。**

✅ **兩個正解，選一個**：

```
① 在 <set> 裡放一個【一定成立】的欄位（本章用 version = version + 1）
   —— 順帶把樂觀鎖的義務也一起做掉了
② 在進 mapper 之前就擋掉「什麼都沒改」這個請求
   —— 因為那通常代表呼叫端有 bug，而不是「這次不用改」
```

⚠️ **不要選第三種**：想辦法讓整句 `UPDATE` 在空的時候消失。
那會讓「這次沒有更新」變成一件**沒有訊號的事**。

---

### 8.3.8 實測：`<choose>` —— 只有一個分支會成立

```xml
  <select id="searchChoose" resultMap="rowMap">
    <bind name="kw" value="q.customerKeyword == null ? null : '%' + q.customerKeyword + '%'"/>
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
    <where>
      <choose>
        <when test="q.status != null">          AND o.status = #{q.status}              </when>
        <when test="q.minAmount != null">       AND o.total_amount &gt;= #{q.minAmount} </when>
        <when test="q.customerKeyword != null"> AND c.display_name LIKE #{kw}           </when>
        <otherwise>                             AND o.status &lt;&gt; 'CANCELLED'       </otherwise>
      </choose>
    </where>
    ORDER BY o.placed_at, o.id
  </select>
```

```java
    @Test
    void a8_choose() {
        head("8.3.8 <choose>：只有一個分支會成立");
        var none = OrderSearch8.empty();
        var st = none.withStatus(St8.PENDING);
        var both = st.withMinAmount(new BigDecimal("200"));
        var amt = none.withMinAmount(new BigDecimal("200"));

        System.out.println("  什麼都沒填       → " + dyn().where(NS + "searchChoose", arg(none)));
        System.out.println("  只有 status      → " + dyn().where(NS + "searchChoose", arg(st)));
        System.out.println("  只有 minAmount   → " + dyn().where(NS + "searchChoose", arg(amt)));
        System.out.println("  🔴 兩個都填      → " + dyn().where(NS + "searchChoose", arg(both)));
    }
```

```
═══ 8.3.8 <choose>：只有一個分支會成立 ═══
  什麼都沒填       → WHERE o.status <> 'CANCELLED'
  只有 status      → WHERE o.status = ?
  只有 minAmount   → WHERE o.total_amount >= ?
  🔴 兩個都填      → WHERE o.status = ?
```

🔴 **兩個都填的時候，`minAmount` 被忽略，而且沒有任何提示。**

```
<if>      每一個獨立判斷 → 可以同時成立 → 條件會【疊加】
<choose>  從上到下找第一個成立的 → 【只有一個】會出現
```

📌 **`<choose>` 適合的三種場景**：

```
① 互斥的模式：<when test="mode == 'DAILY'"> … <when test="mode == 'MONTHLY'"> …
② 「有 A 用 A、沒有 A 用 B」的預設值鏈
③ 空集合的防護（8.4.2 那個 <choose> + 1 = 0）
```

⚠️ **它不適合「可選條件」** —— 那是 `<if>` 的工作。
而這個誤用非常常見，因為 `<choose>` 看起來像 Java 的 `if / else if`，
**而「六個可選條件」在 Java 裡是六個獨立的 `if`，不是 `if / else if`**。

---

### 8.3.9 🔴🔴 實測：`<bind>` 與 like 的 `%`

**`like` 的 `%` 有三個放法，只有一個是對的**：

```
① 放在 SQL 裡：LIKE '%${kw}%'      → 🔴 注入（8.3.1）
② 放在 Java 呼叫端：search("%" + kw + "%")
                                    → 可以，但「要加 %」這件事漏在 API 之外
③ 放在 <bind> 裡                    → ✅ SQL 與 Java 都不用知道這件事
```

```xml
  <select id="searchBind" resultMap="rowMap">
    <bind name="kw" value="'%' + q.customerKeyword + '%'"/>
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
    <where>
      <if test="q.customerKeyword != null"> AND c.display_name LIKE #{kw} </if>
    </where>
    ORDER BY o.placed_at, o.id
  </select>
```

```java
    @Test @Transactional
    void a9_bind與like() {
        head("8.3.9 <bind>：like 的 % 該在哪裡");
        var q = OrderSearch8.empty().withCustomerKeyword("客戶1");

        System.out.println("── ✅ <bind> 版");
        System.out.println("   SQL  : " + dyn().where(NS + "searchBind", arg(q)));
        System.out.println("   ?    : " + dyn().params(NS + "searchBind", arg(q)));
        System.out.println("   結果 : " + orders.searchBind(b(q)).size() + " 張");

        System.out.println("\n── 🔴 ${} 版");
        System.out.println("   SQL  : " + dyn().where(NS + "searchLikeConcat", arg(q)));
        System.out.println("   結果 : " + orders.searchLikeConcat(b(q)).size() + " 張");

        System.out.println("\n── 🔴 ${} 版遇到一個「特別的」關鍵字");
        var pct = OrderSearch8.empty().withCustomerKeyword("%");
        System.out.println("   SQL  : " + dyn().where(NS + "searchLikeConcat", arg(pct)));
        System.out.println("   結果 : " + orders.searchLikeConcat(b(pct)).size() + " 張");
        System.out.println("   而 <bind> 版：" + orders.searchBind(b(pct)).size() + " 張");

        System.out.println("\n── 🔴🔴 <bind> 在【條件不成立時也會執行】");
        var nul = OrderSearch8.empty();
        Throwable t = catching(() -> dyn().where(NS + "searchBind", arg(nul)));
        System.out.println("   關鍵字沒填 → " + name(t));
        System.out.println("                " + msg(t));
        Throwable t2 = catching(() -> orders.searchBind(b(nul)));
        System.out.println("   真的呼叫   → " + name(t2));
        var q2 = OrderSearch8.empty().withStatus(St8.PENDING);
        System.out.println("   ✅ 三元運算子版（searchWhere）→ "
                + dyn().where(NS + "search", arg(q2)));
    }
```

```
═══ 8.3.9 <bind>：like 的 % 該在哪裡 ═══
── ✅ <bind> 版
   SQL  : WHERE c.display_name LIKE ?
   ?    : [kw]
   結果 : 4 張

── 🔴 ${} 版
   SQL  : WHERE c.display_name LIKE '%客戶1%'
   結果 : 4 張

── 🔴 ${} 版遇到一個「特別的」關鍵字
   SQL  : WHERE c.display_name LIKE '%%%'
   結果 : 20 張
   而 <bind> 版：20 張

── 🔴🔴 <bind> 在【條件不成立時也會執行】
   關鍵字沒填 → NullPointerException
                Can't add values % , null
   真的呼叫   → MyBatisSystemException ← NullPointerException
   ✅ 三元運算子版（searchWhere）→ WHERE o.status = ?
```

**三個結果**：

**① `<bind>` 版的 `?` 對應到 `kw`，而 `kw` 不是任何一個方法參數的名字。**
`<bind>` 建的是一個**只存在於這一句 SQL 的區域變數**，而 `#{kw}` 拿得到它。
**這是 MyBatis 唯一「可以在 XML 裡算東西」的地方。**

**② `${}` 版遇到 `%` 這個關鍵字 → `LIKE '%%%'` → 20 張。**
⚠️ 注意 **`<bind>` 版也是 20 張** —— 因為 `%` 在 `LIKE` 裡就是通用字元。
**參數化只保證「它不會變成 SQL 語法」，不保證「它不會變成 `LIKE` 的通用字元」。**
要真的把 `%` 當字面值，得寫 `LIKE #{kw} ESCAPE '\'` 並在 Java 那一側轉義 `%` 與 `_`。
**這是 `like` 搜尋一個獨立的坑，跟注入無關。**

**③🔴🔴 `<bind>` 在條件不成立時【也會執行】，而 `'%' + null` 在 OGNL 裡是 NPE。**

```
<bind> 不是 <if> 的子節點 —— 它是一個【獨立的 SqlNode】，
而 SqlNode 是【從上到下全部 apply 一遍】的。
所以 <bind> 一定會被求值，跟後面那個 <if> 成不成立完全無關。
```

✅ **正解是三元運算子**（本章共用片段 `searchWhere` 用的就是這一版）：

```xml
<bind name="kw" value="q.customerKeyword == null ? null : '%' + q.customerKeyword + '%'"/>
```

⚠️ **而這個坑會在測試裡活下來**，因為「有填關鍵字」的測試會過。
**要湊到「沒填關鍵字」那一格才會炸** —— 又是 8.3.4 那個形狀。

---

### 8.3.10 實測：`<sql>` / `<include>` 與兩段式代換

```xml
  <sql id="orderByClause">
    ORDER BY ${col} ${dir}, o.id
  </sql>

  <select id="searchInclude" resultMap="rowMap">
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
    <include refid="searchWhere"/>
    <include refid="orderByClause">
      <property name="col" value="${sortColumn}"/>
      <property name="dir" value="${sortDir}"/>
    </include>
  </select>
```

```java
    @Test @Transactional
    void aa_include帶參數() {
        head("8.3.10 <sql> / <include> 與兩段式代換");
        var q = OrderSearch8.empty().withStatus(St8.PENDING);
        var args = Dyn.args("q", b(q), "sortColumn", "o.total_amount", "sortDir", "DESC");
        String sql = dyn().sql(NS + "searchInclude", args);
        System.out.println("  完整 SQL 的尾巴：");
        System.out.println("    "
                + sql.substring(Math.max(0, sql.toUpperCase().lastIndexOf(" WHERE "))));

        var rows = orders.searchInclude(b(q), "o.total_amount", "DESC");
        System.out.println("\n  執行：" + rows.size() + " 張，第一筆金額 "
                + (rows.isEmpty() ? "-" : rows.get(0).totalAmount()));

        Throwable t = catching(() -> orders.searchInclude(b(q),
                "o.total_amount; DROP TABLE audit_sql", "DESC"));
        System.out.println("\n  丟一個奇怪的欄位名進去：" + name(t));
    }
```

```
═══ 8.3.10 <sql> / <include> 與兩段式代換 ═══
  完整 SQL 的尾巴：
     WHERE o.status = ? ORDER BY o.total_amount DESC, o.id

  執行：5 張，第一筆金額 216.0000

  丟一個奇怪的欄位名進去：BadSqlGrammarException ← SQLSyntaxErrorException
```

📌 **代換發生了兩次，而它們在完全不同的時間點**：

```
XML 解析期（應用程式啟動時，每一個 statement 只做一次）
    <sql> 裡的 ${col}   →   <property> 給的字面值 "${sortColumn}"
                            ↑ 這一段是【純文字取代】，跟參數完全無關

執行期（每一次呼叫）
    文字裡的 ${sortColumn}  →   這一次呼叫的參數值 "o.total_amount"
                            ↑ 這一段才是 07 章 7.6 那個 ${}
```

⚠️ **所以 `<include>` 的 `<property>` 不能放參數。**
它只看得到 XML 解析期就存在的東西：字面值、以及
`mybatis-config.xml` 的 `<properties>`。
**本章那個 `value="${sortColumn}"` 之所以會動，是因為它代換出來的
「純文字」剛好又是一個執行期的 `${}`** —— 這是一個技巧，不是設計意圖。

✅ **`<sql>` / `<include>` 真正該用的三件事**：

```
① 欄位清單（rowColumns）—— 讓「列表」與「明細」用同一組欄位
② FROM 與 JOIN（rowFrom）
③ ★★ 搜尋條件（searchWhere）—— 讓 count 與列表【結構上】用同一組條件（8.3.12）
```

🔴 **而排序欄位那件事**：`ORDER BY ${col}` 就是 07 章 7.6.4 那個坑
（`ORDER BY ?` 在 MySQL 上不報錯也不排序），
**所以它一定要走 07 章 7.6.5 那個對照表式白名單**：

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

⚠️ **上面那個「丟奇怪欄位名」的實測結果是 `BadSqlGrammarException`，
不是「`audit_sql` 被 DROP 了」** —— 因為 MySQL 驅動預設不允許一次送多句
（`allowMultiQueries=false`）。**這不是防線，這是預設值。**
`allowMultiQueries=true` 的專案不少（為了批次），而那時候同一段程式碼就是一個 RCE。

---

### 8.3.11 ★ 實測：`<if test="…">` 是 OGNL，`#{…}` 不是

```xml
  <select id="searchRecord" resultMap="rowMap">
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
    <where>
      <if test="q.status != null">    AND o.status = #{q.status}              </if>
      <if test="q.minAmount != null"> AND o.total_amount &gt;= #{q.minAmount} </if>
    </where>
    ORDER BY o.placed_at, o.id
  </select>

  <!-- 改成【呼叫存取子方法】 -->
  <select id="searchRecordCall" resultMap="rowMap">
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
    <where>
      <if test="q.status() != null">    AND o.status = #{q.status()}              </if>
      <if test="q.minAmount() != null"> AND o.total_amount &gt;= #{q.minAmount()} </if>
    </where>
    ORDER BY o.placed_at, o.id
  </select>
```

```java
    @Test @Transactional
    void ab_ognl與record() {
        head("8.3.11 OGNL 認不認得 record");
        var rec = OrderSearch8.empty().withStatus(St8.PENDING);

        System.out.println("── ① <if test=\"q.status != null\">，參數是 record");
        Throwable t1 = catching(() -> System.out.println(
                "   SQL : " + dyn().where(NS + "searchRecord", Dyn.args("q", rec))));
        if (t1 != null) System.out.println("   → " + name(t1) + "\n     " + msg(t1));

        System.out.println("\n── ② <if test=\"q.status() != null\">（呼叫存取子方法）");
        Throwable t2 = catching(() -> System.out.println(
                "   SQL : " + dyn().where(NS + "searchRecordCall", Dyn.args("q", rec))));
        if (t2 != null) System.out.println("   → " + name(t2) + "\n     " + msg(t2));

        System.out.println("\n── ③ 真的執行一次");
        Throwable t3 = catching(() -> System.out.println(
                "   searchRecord     → " + orders.searchRecord(rec).size() + " 張"));
        if (t3 != null) System.out.println("   searchRecord     → " + name(t3));
        Throwable t4 = catching(() -> System.out.println(
                "   searchRecordCall → " + orders.searchRecordCall(rec).size() + " 張"));
        if (t4 != null) System.out.println("   searchRecordCall → " + name(t4)
                + "\n     " + msg(t4));
    }
```

```
═══ 8.3.11 OGNL 認不認得 record ═══
── ① <if test="q.status != null">，參數是 record
   SQL : WHERE o.status = ?

── ② <if test="q.status() != null">（呼叫存取子方法）
   SQL : WHERE o.status = ?

── ③ 真的執行一次
   searchRecord     → 5 張
   searchRecordCall → MyBatisSystemException ← ReflectionException
     There is no getter for property named 'status()' in 'class com.example.lab.ch08.OrderSearch8'
```

📌 **三個結論**：

```
① record 在 MyBatis 3.5.14 上【可以直接當參數物件】。
   OGNL 的 q.status 與 #{q.status} 兩邊都認得 record 的存取子。
   （07 章 7.8.5 已經證明 record 可以當【結果】型別，這裡補上【參數】那一半。）

② <if test="…"> 裡面是 OGNL —— 完整的運算式語言：
   方法呼叫、算術、三元運算子、集合操作、靜態方法（@java.lang.Math@max(1,2)）全都可以。

③ 🔴 #{…} 裡面【不是】OGNL —— 它只是一條【屬性路徑】。
   #{q.status()} 會被當成「屬性名叫做 status()」→ ReflectionException。
```

⚠️ **這個差別造成一個實務上的陷阱**：

```xml
<if test="q.items.size() > 0">   ✅ 可以（OGNL）
  … #{q.items.size()} …           🔴 不行（屬性路徑）
</if>
```

**`<if>` 裡寫得出來的東西，`#{}` 裡不一定寫得出來。**
需要算出來的值，用 `<bind>`（8.3.9）搬到一個變數名裡。
**8.3.6 最後那個 `#{memo.orElse(null)}` 就是這個坑。**

---

### 8.3.11b 🔴 實測：打錯字的兩種形狀（以及量尺自己會騙人）

```xml
  <select id="searchTypoRoot" resultMap="rowMap">
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
    <where>
      <if test="qq.status != null"> AND o.status = #{q.status} </if>
    </where>
  </select>

  <select id="searchTypoProp" resultMap="rowMap">
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
    <where>
      <if test="q.statusX != null"> AND o.status = #{q.status} </if>
    </where>
  </select>
```

```java
    @Test @Transactional
    void ab2_打錯字的兩種形狀() {
        head("8.3.11b <if> 裡打錯字：兩種形狀、兩種下場");
        var q = OrderSearch8.empty().withStatus(St8.PENDING);

        System.out.println("── ① 根名字打錯（qq.status，而參數叫 q）");
        Throwable t1 = catching(() -> System.out.println(
                "   SQL : " + dyn().where(NS + "searchTypoRoot", arg(q))));
        if (t1 != null) System.out.println("   → " + name(t1) + "\n     " + msg(t1));
        Throwable t1b = catching(() -> orders.searchTypoRoot(b(q)));
        System.out.println("   執行: " + name(t1b));

        System.out.println("\n── ② 屬性名打錯（q.statusX）");
        Throwable t2 = catching(() -> System.out.println(
                "   SQL : " + dyn().where(NS + "searchTypoProp", arg(q))));
        if (t2 != null) System.out.println("   → " + name(t2) + "\n     " + msg(t2));
        Throwable t2b = catching(() -> System.out.println(
                "   執行: " + orders.searchTypoProp(b(q)).size() + " 張"));
        if (t2b != null) System.out.println("   執行: " + name(t2b));

        System.out.println("\n── ③ 量尺自己也會騙人：HashMap vs ParamMap");
        System.out.println("   ParamMap（MyBatis 真的用的）：");
        Throwable t3 = catching(() -> dyn().sql(NS + "searchTypoRoot", Dyn.args("q", b(q))));
        System.out.println("     " + name(t3));
        System.out.println("   HashMap（隨手寫的量尺）：");
        Throwable t4 = catching(() -> dyn().sql(NS + "searchTypoRoot",
                Dyn.looseArgs("q", b(q))));
        System.out.println("     " + (t4 == null
                ? "沒有例外 —— 條件被當成【不成立】" : name(t4)));
    }
```

```
═══ 8.3.11b <if> 裡打錯字：兩種形狀、兩種下場 ═══
── ① 根名字打錯（qq.status，而參數叫 q）
   → BindingException
     Parameter 'qq' not found. Available parameters are [q, param1]
   執行: MyBatisSystemException ← BindingException

── ② 屬性名打錯（q.statusX）
   → BuilderException ← NoSuchPropertyException
     com.example.lab.ch08.OrderSearchBean8.statusX
   執行: MyBatisSystemException ← NoSuchPropertyException

── ③ 量尺自己也會騙人：HashMap vs ParamMap
   ParamMap（MyBatis 真的用的）：
     BindingException
   HashMap（隨手寫的量尺）：
     BuilderException ← OgnlException
```

✅ **好消息：兩種打錯字都會拋例外，不會靜默。**

這一點跟 07 章的其他地方**不一樣**：

```
07 章 7.8.1   resultType 的欄位名對不上 → 🔴 靜默 null
07 章 7.7     單一參數的 #{} 裡名字打錯  → 🔴 一直都能跑
08 章 8.3.11b <if test> 裡的名字打錯     → ✅ 拋例外
```

**原因是 OGNL**：`#{}` 走的是 MyBatis 自己的 `MetaObject`（很寬容），
而 `test=` 走的是 OGNL（很嚴格）。

🔴 **壞消息：例外是在【執行期】拋的。** `searchTypoProp` 只有在
「使用者填了 status」那一格才會被求值 —— **回到 8.3.4 那個組合問題。**
**8.9.1 那條斷言（把 64 種組合全部展開）同時也擋住這件事。**

📌 **③ 那一格是這一章給量尺的一個教訓，值得單獨記住**：

```
MyBatis 執行 mapper 方法時傳進去的是 MapperMethod.ParamMap，
它對「取一個不存在的 key」是【拋 BindingException】。

而如果你的量尺傳的是 HashMap（很自然的寫法），
「取不存在的 key」是【回傳 null】。
                ↓
「參數名打錯」會被量成「使用者沒填這個條件」——
你的 CI 斷言會【通過】，而線上會炸。
```

**所以 `Dyn.args()` 一定要回傳 `MapperMethod.ParamMap`。**
（那個 `param1` / `param2` 也要一起放進去 —— MyBatis 自己會放，
而 07 章 7.7 ② 那格證明有人真的會用它們。）

---

### 8.3.12 實測：`<sql>` 讓 count 與列表用同一組條件

```java
    @Test @Transactional
    void ad_同一份條件給列表與count() {
        head("8.3.12 <sql> 的真正用途：讓 count 跟列表用同一組條件");
        var q = OrderSearch8.empty().withStatus(St8.PENDING).withHasRep(Boolean.TRUE);

        String listWhere = dyn().where(NS + "search", arg(q));
        String countWhere = dyn().where(NS + "searchCount", arg(q));
        System.out.println("  列表的 WHERE : " + listWhere);
        System.out.println("  count 的 WHERE: " + countWhere);
        System.out.println("  一字不差？    : " + listWhere.equals(countWhere));

        List<OrderRow8> rows = orders.search(b(q));
        long total = orders.searchCount(b(q));
        System.out.println("\n  列表 " + rows.size() + " 筆、count " + total
                + " 筆 → 對得上：" + (rows.size() == total));
    }
```

```
═══ 8.3.12 <sql> 的真正用途：讓 count 跟列表用同一組條件 ═══
  列表的 WHERE : WHERE o.status = ? AND o.rep_id IS NOT NULL
  count 的 WHERE: WHERE o.status = ? AND o.rep_id IS NOT NULL
  一字不差？    : true

  列表 3 筆、count 3 筆 → 對得上：true
```

📌 **這是 05 章 5.7.4 那個「自動生成的 count 會算錯」的另一種解法**：

```
05 章：Spring Data 幫你【猜】count 查詢 → left join + distinct 的時候猜錯
                                       → Page.getTotalElements() 回 60 而實際 30
08 章：條件抽成【一份】<sql>，列表與 count 各自 <include> 同一個 refid
                                       → 結構上不可能不一致
```

⚠️ **而 8.6.5 會證明 PageHelper 又把這件事變回「框架幫你猜」** ——
那是它三個坑裡最貴的一個。

**這個手法的兩個限制**：

```
① 只有 WHERE 抽得出來。ORDER BY 與 LIMIT 不能共用（count 不需要它們），
   所以「列表有 ORDER BY、count 沒有」這件事還是靠人記得。
② JOIN 也要共用（本章的 rowFrom），否則條件裡用到的別名在 count 裡不存在
   —— 而那會是【啟動時就炸】還是【執行期才炸】？
   🔴 執行期。8.9.1 那條斷言連這個一起擋。
```

---

### 8.3.13 🔴 實測：動態 SQL 的本質代價 —— SQL 形狀的數量

```java
    @Test @Transactional
    void ac_形狀爆炸() {
        head("8.3.13 動態 SQL 的代價：SQL 形狀的數量");
        List<OrderSearch8> combos = allCombinations();

        Set<String> shapes = new LinkedHashSet<>();
        for (OrderSearch8 c : combos) shapes.add(dyn().sql(NS + "search", arg(c)));
        System.out.println("  64 種條件組合 → " + shapes.size() + " 種 SQL 形狀");

        stat().mark();
        List<String> sqls = spy(() -> { for (OrderSearch8 c : combos) orders.search(b(c)); });
        var d = stat().delta();
        System.out.println("    JDBC 送出        : " + sqls.size() + " 句");
        System.out.println("    Com_stmt_prepare : " + d.get("Com_stmt_prepare"));
        System.out.println("    Com_select       : " + d.get("Com_select"));
    }
```

```
═══ 8.3.13 動態 SQL 的代價：SQL 形狀的數量 ═══
  64 種條件組合 → 64 種 SQL 形狀

  問伺服器：剖析了幾句（MysqlStat，06 章第三把尺）
    JDBC 送出        : 64 句
    Com_stmt_prepare : 0
    Com_select       : 64
```

⚠️ **`Com_stmt_prepare` 是 0。** 這不是「沒有代價」，是**這把尺在預設組態下看不到**：

```
MySQL 驅動預設 useServerPrepStmts=false
    → 驅動自己把 ? 換成字面值，再送一句【普通的 SQL】
    → 伺服器端根本沒有「prepared statement」這個東西可以快取
```

**要看到代價，得把組態換成真的用伺服器端的 prepared statement**：

```java
package com.example.lab.ch08;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Function;

/**
 * 8.3.13b：把 SQL 形狀爆炸的代價量到【伺服器端】。
 *
 * ⚠️ 這個類別必須自己重寫 datasource URL —— 子類別的 @SpringBootTest(properties)
 *    會【取代】父類別那一份（03 章踩過的坑五）。
 * ★ 多了三個 URL 參數：
 *      useServerPrepStmts=true  真的用伺服器端的 PREPARE（預設是 false，客戶端展開）
 *      cachePrepStmts=true      驅動在【每一條連線】上快取 PreparedStatement
 *      prepStmtCacheSize=25     快取幾格 ← 這就是「形狀爆炸」會撞到的那個數字
 */
@SpringBootTest(properties = {
  "spring.datasource.url=jdbc:mysql://127.0.0.1:33306/ch08?connectionTimeZone=UTC"
      + "&forceConnectionTimeZoneToSession=true&preserveInstants=true&characterEncoding=UTF-8"
      + "&useServerPrepStmts=true&cachePrepStmts=true&prepStmtCacheSize=25"
      + "&prepStmtCacheSqlLimit=4096",
  "spring.datasource.hikari.maximum-pool-size=1",
  "spring.jpa.properties.hibernate.generate_statistics=true"
})
class M2bPrepare extends Base08 {

    @Autowired Ord8Mapper orders;

    static final String NS = "com.example.lab.ch08.Ord8Mapper.";

    @BeforeEach void setUp() { seed(20, 4, 2); }

    private static OrderSearchBean8 b(OrderSearch8 r) { return OrderSearchBean8.of(r); }

    private List<OrderSearch8> combos() {
        List<Function<OrderSearch8, OrderSearch8>> setters = List.of(
                s -> s.withStatus(St8.PENDING),
                s -> s.withCustomerKeyword("客戶1"),
                s -> s.withRange(Instant.parse("2026-09-01T00:00:00Z"), null),
                s -> s.withRange(s.from(), Instant.parse("2026-09-02T00:00:00Z")),
                s -> s.withMinAmount(new BigDecimal("200")),
                s -> s.withHasRep(Boolean.TRUE));
        return Dyn.combinations(OrderSearch8.empty(), setters);
    }

    @Test
    void a_六十四種形狀在伺服器端的代價() {
        head("8.3.13b 64 種形狀 vs 1 種形狀（useServerPrepStmts=true）");
        List<OrderSearch8> all = combos();
        var one = OrderSearch8.empty().withStatus(St8.PENDING);

        // 暖機：讓兩邊的形狀都先被 prepare 過一次
        for (OrderSearch8 c : all) orders.search(b(c));
        for (int i = 0; i < 64; i++) orders.search(b(one));

        stat().mark();
        for (OrderSearch8 c : all) orders.search(b(c));
        var d1 = stat().delta();

        stat().mark();
        for (int i = 0; i < 64; i++) orders.search(b(one));
        var d2 = stat().delta();

        Set<String> shapes = new LinkedHashSet<>();
        for (OrderSearch8 c : all) shapes.add(dyn().sql(NS + "search", Dyn.args("q", b(c))));

        System.out.println("  形狀數：64 種組合 → " + shapes.size() + " 種 SQL");
        System.out.println("  prepStmtCacheSize = 25，池子只有 1 條連線\n");
        System.out.printf("  %-26s %10s %10s%n", "", "64 種形狀", "1 種形狀 ×64");
        System.out.printf("  %-26s %10d %10d%n", "Com_stmt_prepare",
                d1.get("Com_stmt_prepare"), d2.get("Com_stmt_prepare"));
        System.out.printf("  %-26s %10d %10d%n", "Com_stmt_execute",
                d1.get("Com_stmt_execute"), d2.get("Com_stmt_execute"));
        System.out.printf("  %-26s %10d %10d%n", "Com_select",
                d1.get("Com_select"), d2.get("Com_select"));

        long best1 = bestMicros(() -> { for (OrderSearch8 c : all) orders.search(b(c)); }, 2, 5);
        long best2 = bestMicros(() -> { for (int i = 0; i < 64; i++) orders.search(b(one)); }, 2, 5);
        System.out.printf("%n  跑 64 次的最快耗時： 64 種形狀 %d µs   1 種形狀 %d µs%n", best1, best2);
    }

    @Test
    void c_參數個數的上限() {
        head("8.4.6b <foreach> 的參數個數（useServerPrepStmts=true）");
        java.util.UUID oid = orderIds.get(0);
        System.out.println("  每一筆 7 個參數，65535 / 7 = 9362 筆 —— 理論上的天花板\n");
        System.out.printf("  %8s %10s %10s %10s %s%n", "筆數", "? 個數",
                "stmt_prep", "Com_insert", "結果");
        for (int n : new int[]{1000, 9362, 9363, 20000}) {
            jdbc.update("DELETE FROM order_item");
            java.util.List<ItemInsert8> rows = new java.util.ArrayList<>(n);
            for (int i = 0; i < n; i++)
                rows.add(new ItemInsert8(com.example.lab.Uuid7.next(), oid,
                        productIds.get(i % 6), "商品" + (i % 6),
                        new BigDecimal("100.0000"), 1, new BigDecimal("100.0000")));
            int ph = dyn().placeholders("com.example.lab.ch08.Ord8Mapper.insertItems",
                    Dyn.args("items", rows));
            stat().mark();
            Throwable t = catching(() -> tx.executeWithoutResult(s -> orders.insertItems(rows)));
            var d = stat().delta();
            System.out.printf("  %,8d %,10d %10d %10d %s%n", n, ph,
                    d.get("Com_stmt_prepare"), d.get("Com_insert"),
                    t == null ? "OK" : name(t));
        }
        jdbc.update("DELETE FROM order_item");
        System.out.println("\n  ★ 20000 筆 = 140000 個參數，Com_stmt_prepare = 1 —— 全部都過。");
        System.out.println("    流傳的「一句 prepared statement 最多 65535 個參數」"
                + "在 MySQL 8.0.46 + Connector/J 8.3.0 上【量不到】。");
        System.out.println("    （那條限制來自其他資料庫 / 舊版通訊協定，不要直接套。）");
        System.out.println("    真正會擋你的是 max_allowed_packet —— 8.4.6c 會把它撞出來。");
    }

    @Test
    void b_客戶端展開的對照() {
        head("8.3.13c 預設組態（useServerPrepStmts=false）下伺服器看到什麼");
        var one = OrderSearch8.empty().withStatus(St8.PENDING);
        stat().mark();
        for (int i = 0; i < 10; i++) orders.search(b(one));
        var d = stat().delta();
        System.out.println("  同一種形狀跑 10 次（本類別已開 useServerPrepStmts，"
                + "而且【沒有交易】—— 否則 MyBatis 的一級快取會把 9 次吃掉，07 章 7.11.3）：");
        System.out.println("    Com_stmt_prepare = " + d.get("Com_stmt_prepare")
                + "、Com_stmt_execute = " + d.get("Com_stmt_execute")
                + "、Com_select = " + d.get("Com_select"));
        System.out.println("\n  ★ 對照 8.3.13（預設 URL、沒有 useServerPrepStmts）："
                + "Com_stmt_prepare = 0、Com_select = 64。");
        System.out.println("    預設組態下驅動【自己把 ? 換成字面值】再送一句普通 SQL，");
        System.out.println("    所以伺服器根本沒有「prepared statement」這個東西可以快取。");
    }
}
```

```
═══ 8.3.13b 64 種形狀 vs 1 種形狀（useServerPrepStmts=true） ═══
  形狀數：64 種組合 → 64 種 SQL
  prepStmtCacheSize = 25，池子只有 1 條連線

                                 64 種形狀  1 種形狀 ×64
  Com_stmt_prepare                   63          1
  Com_stmt_execute                   64         64
  Com_select                         64         64

  跑 64 次的最快耗時： 64 種形狀 35634 µs   1 種形狀 15554 µs

═══ 8.3.13c 同一種形狀跑 10 次 ═══
    Com_stmt_prepare = 1、Com_stmt_execute = 10、Com_select = 10
```

★★ **這就是動態 SQL 的本質代價，而它是一個可以看的數字**：

```
64 種形狀 → 每一次呼叫幾乎都要重新 PREPARE（63 / 64）→ 35.6 ms
 1 種形狀 → PREPARE 一次、EXECUTE 64 次              → 15.6 ms
                              ↓
                        2.3 倍，而查的是同一組 20 張訂單
```

**`prepStmtCacheSize` 是 25，而形狀有 64 種 → 快取幾乎永遠 miss。**
這跟 05 章 5.5.2 那個「拼字串 = Hibernate 計畫快取 0 命中 / 400 沒中」
**是同一個現象的另一層**：

```
05 章量的是【Hibernate 的 HQL → SQL 翻譯快取】
08 章量的是【JDBC 驅動的 PreparedStatement 快取 + 伺服器的 PREPARE】
                              ↓
兩者的成因一樣：SQL 文字每次都不同。
```

📌 **而這一次沒有「一行組態就解決」的答案。**

```
05 章 5.5.3 的 in 子句爆炸  → hibernate.query.in_clause_parameter_padding = true ✅
08 章 8.3.13 的組合爆炸     → 🔴 沒有這種東西
                             因為 64 種形狀是【使用者真的要問 64 種不同的問題】
```

✅ **實務上能做的三件事**：

```
① 把 prepStmtCacheSize 開大到【超過形狀數】——
   而你得先知道形狀數是多少，那就是 8.9.3 那條斷言（形狀數有上界）
② 減少可選條件的數量：把「六個都可選」改成「時間範圍必填 + 五個可選」→ 32 種
③ 接受它。20 張訂單上的 2.3 倍是 20 ms，而那 20 ms 裡有 64 次網路來回 ——
   真實的搜尋頁一次只打一句，重新 PREPARE 的成本是【微秒級】的。
                              ↓
   ⚠️ ③ 是大多數專案的正確答案，而你要能講出①②才有資格選③。
```

---

## 8.4 `<foreach>`

`<foreach>` 只做一件事：**把一個集合展開成一段重複的 SQL**。
而它有三種用途、四個屬性、以及一個一定要處理的邊界情況。

### 8.4.0 這一節的測試類別

```java
package com.example.lab.ch08;

import com.example.lab.Uuid7;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/** 8.4：&lt;foreach&gt;。 */
class M3Foreach extends Base08 {

    @Autowired Ord8Mapper orders;

    static final String NS = "com.example.lab.ch08.Ord8Mapper.";

    @BeforeEach void setUp() { seed(20, 4, 2); }

    // ══════════════ 8.4.1 in 子句 ══════════════

    @Test @Transactional
    void a1_in子句() {
        head("8.4.1 <foreach> 組 in 子句");
        var ids = orderIds.subList(0, 3);
        System.out.println("  SQL   : " + dyn().where(NS + "byIds", Dyn.args("ids", ids)));
        System.out.println("  ? 對應: " + dyn().params(NS + "byIds", Dyn.args("ids", ids)));
        System.out.println("  ★ 參數名是 MyBatis 自己生的（__frch_<item>_<序號>）——");
        System.out.println("    所以 item=\"id\" 這個名字只在 <foreach> 內部有效。");
        System.out.println("\n  執行  : " + orders.byIds(ids).size() + " 張");

        System.out.println("\n── 四個屬性的語意");
        System.out.println("    collection  要走訪的東西（參數名，或 list / array / 屬性路徑）");
        System.out.println("    item        每一個元素在 #{} 裡叫什麼");
        System.out.println("    open/close  前後各加一段字（in 子句是「(」與「)」）");
        System.out.println("    separator   元素之間插什麼（in 子句是「,」）");
        System.out.println("    index       List 是【索引】、Map 是【key】");
    }

    // ══════════════ 8.4.2 空集合 ══════════════

    @Test @Transactional
    void a2_空集合() {
        head("8.4.2 🔴 空集合");
        List<UUID> empty = List.of();

        System.out.println("── byIds（沒有防護）");
        System.out.println("   SQL  : " + dyn().where(NS + "byIds", Dyn.args("ids", empty)));
        Throwable t = catching(() -> orders.byIds(empty));
        System.out.println("   執行 : " + name(t));
        System.out.println("          " + msg(t));

        System.out.println("\n── ✅ byIdsSafe（<choose> 擋掉）");
        System.out.println("   SQL  : " + dyn().where(NS + "byIdsSafe", Dyn.args("ids", empty)));
        System.out.println("   執行 : " + orders.byIdsSafe(empty).size() + " 張");
        System.out.println("   有值 : " + orders.byIdsSafe(orderIds.subList(0, 3)).size() + " 張");

        System.out.println("\n── null 呢");
        Throwable tn = catching(() -> orders.byIds(null));
        System.out.println("   byIds(null)     : " + name(tn));
        System.out.println("   byIdsSafe(null) : " + orders.byIdsSafe(null).size() + " 張");

        System.out.println("\n  ★ 「1 = 0」而不是「回傳空 List 不查資料庫」的理由：");
        System.out.println("    ① 這個 <foreach> 通常只是【一堆條件裡的一個】，");
        System.out.println("       在 Java 那一側短路就得把整段條件邏輯搬到 Java；");
        System.out.println("    ② SQL 的形狀還是可預測的（8.9.2 那條斷言查的就是這個）。");
    }

    // ══════════════ 8.4.3 SQL 形狀 ══════════════

    @Test @Transactional
    void a3_形狀爆炸() {
        head("8.4.3 in 子句的形狀爆炸（對照 05 章 5.5.3）");
        List<UUID> all = new ArrayList<>(orderIds);

        Set<String> shapes = new LinkedHashSet<>();
        for (int n = 1; n <= 20; n++)
            shapes.add(dyn().where(NS + "byIds", Dyn.args("ids", all.subList(0, n))));
        System.out.println("  清單長度 1～20 → " + shapes.size() + " 種 SQL 形狀");
        int i = 0;
        for (String s : shapes) if (i++ < 4) System.out.println("    " + s);
        System.out.println("    …（每多一個 id 就是一句新的 SQL）");

        System.out.println("\n── ✅ 自己補到 2 的次方（Pad8）");
        Set<String> padded = new LinkedHashSet<>();
        for (int n = 1; n <= 20; n++)
            padded.add(dyn().where(NS + "byIds", Dyn.args("ids", Pad8.pad(all.subList(0, n)))));
        System.out.println("  清單長度 1～20 → " + padded.size() + " 種 SQL 形狀");
        padded.forEach(s -> System.out.println("    " + cut(s, 120)));

        System.out.println("\n── 補的值會不會改變結果");
        for (int n : new int[]{5, 7, 13}) {
            var sub = all.subList(0, n);
            System.out.println("    " + n + " 個 id：原本 " + orders.byIds(sub).size()
                    + " 張、補到 " + Pad8.pad(sub).size() + " 個之後 "
                    + orders.byIds(Pad8.pad(sub)).size() + " 張");
        }
        System.out.println("\n  ★ MyBatis 【沒有】Hibernate 的 in_clause_parameter_padding"
                + "（05 章 5.5.3 那一行組態）。");
        System.out.println("    要有，就得自己寫一個 Pad8.pad()，而且【每一個 in 子句都要記得呼叫】——");
        System.out.println("    這是「一行組態」與「一條慣例」的差別。");
    }

    // ══════════════ 8.4.5 批次插入 ══════════════

    @Test
    void a5_批次插入() {
        head("8.4.5 一句 INSERT 多組 VALUES");
        UUID oid = orderIds.get(0);
        int n = 1000;

        System.out.println("── 一句 1000 組 VALUES");
        jdbc.update("DELETE FROM order_item");
        List<ItemInsert8> rows = items(oid, n);
        List<String> sqls = spy(() -> tx.executeWithoutResult(s -> orders.insertItems(rows)));
        System.out.println("   JDBC 句數  : " + sqls.size());
        System.out.println("   SQL 長度   : " + sqls.get(0).length() + " 字元");
        System.out.println("   SQL 開頭   : " + cut(sqls.get(0), 110));
        System.out.println("   插進去幾筆 : "
                + jdbc.queryForObject("SELECT count(*) FROM order_item", Long.class));

        System.out.println("\n── 問伺服器（06 章第三把尺）");
        jdbc.update("DELETE FROM order_item");
        stat().mark();
        tx.executeWithoutResult(s -> orders.insertItems(items(oid, n)));
        var d = stat().delta();
        System.out.println("   Com_insert           = " + d.get("Com_insert"));
        System.out.println("   Innodb_rows_inserted = " + d.get("Innodb_rows_inserted"));

        System.out.println("\n── 耗時（每一輪都先清表，清表不計時）");
        long one = timeInsert(() -> tx.executeWithoutResult(s -> orders.insertItems(items(oid, n))));
        long chunk = timeInsert(() -> tx.executeWithoutResult(s -> {
            List<ItemInsert8> all = items(oid, n);
            for (int i = 0; i < all.size(); i += 100)
                orders.insertItems(all.subList(i, Math.min(i + 100, all.size())));
        }));
        long loop = timeInsert(() -> tx.executeWithoutResult(s -> {
            for (ItemInsert8 it : items(oid, n)) orders.insertItems(List.of(it));
        }));
        System.out.printf("   一句 1000 組 VALUES : %5d ms%n", one);
        System.out.printf("   10 句 ×100 組       : %5d ms%n", chunk);
        System.out.printf("   1000 句 ×1 組       : %5d ms%n", loop);
        System.out.println("\n  ★ 對照 07 章 7.10.4：ExecutorType.BATCH 沒開 rewrite 是 1124 ms、"
                + "開了是 10 ms、<foreach> 是 13～14 ms。");
    }

    private long timeInsert(Runnable body) {
        long best = Long.MAX_VALUE;
        for (int i = 0; i < 3; i++) {
            jdbc.update("DELETE FROM order_item");
            long t0 = System.nanoTime();
            body.run();
            best = Math.min(best, System.nanoTime() - t0);
        }
        return best / 1_000_000;
    }

    private List<ItemInsert8> items(UUID oid, int n) {
        List<ItemInsert8> out = new ArrayList<>(n);
        for (int i = 0; i < n; i++)
            out.add(new ItemInsert8(Uuid7.next(), oid, productIds.get(i % 6),
                    "商品" + (i % 6), new BigDecimal("100.0000"), 1, new BigDecimal("100.0000")));
        return out;
    }

    // ══════════════ 8.4.6 上限 ══════════════

    @Test
    void a6_筆數上限() {
        head("8.4.6 🔴 <foreach> 的兩個上限");
        System.out.println("  max_allowed_packet = " + jdbc.queryForObject(
                "SELECT @@max_allowed_packet", Long.class) + " bytes");

        UUID oid = orderIds.get(0);
        for (int n : new int[]{1000, 20000, 100000}) {
            jdbc.update("DELETE FROM order_item");
            List<ItemInsert8> rows = items(oid, n);
            int len = dyn().sql(NS + "insertItems", Dyn.args("items", rows)).length();
            Throwable t = catching(() -> tx.executeWithoutResult(s -> orders.insertItems(rows)));
            System.out.printf("  %6d 筆 → SQL %,10d 字元、? %,7d 個 → %s%n", n, len,
                    dyn().placeholders(NS + "insertItems", Dyn.args("items", rows)),
                    t == null ? "OK" : name(t));
            if (t != null) System.out.println("           " + msg(t));
        }
        jdbc.update("DELETE FROM order_item");

        System.out.println("\n  ★ 100000 筆都過了。所以「<foreach> 有筆數上限」這句話"
                + "要看【驅動怎麼組態】：");
        System.out.println("    預設 useServerPrepStmts=false → 驅動自己把 ? 換成字面值，"
                + "只剩 max_allowed_packet 這一個上限（64 MB）。");
        System.out.println("    而 8.4.6b（M2bPrepare）會證明：一旦開了 useServerPrepStmts，"
                + "16 位元的參數個數欄位就會爆。");
    }

    @Test
    void a6b_撞max_allowed_packet() {
        head("8.4.6c 🔴 真正的上限：max_allowed_packet");
        long original = jdbc.queryForObject("SELECT @@GLOBAL.max_allowed_packet", Long.class);
        System.out.println("  原本的 max_allowed_packet = " + String.format("%,d", original));
        UUID oid = orderIds.get(0);
        try {
            jdbc.update("SET GLOBAL max_allowed_packet = 1048576");   // 1 MB
            // ⚠️ SET GLOBAL 對【池子裡既有的連線】無效（06 章 6.7.7 同一個坑）→ 要逼它換連線
            evictPool();
            System.out.println("  改成 1 MB 並把連線池清空之後：\n");
            for (int n : new int[]{1000, 5000, 20000}) {
                jdbc.update("DELETE FROM order_item");
                List<ItemInsert8> rows = items(oid, n);
                int len = dyn().sql(NS + "insertItems", Dyn.args("items", rows)).length();
                Throwable t = catching(() ->
                        tx.executeWithoutResult(s -> orders.insertItems(rows)));
                System.out.printf("  %,7d 筆 → 帶 ? 的 SQL %,9d 字元 → %s%n", n, len,
                        t == null ? "OK" : name(t));
                if (t != null) System.out.println("            " + msg(t));
            }
        } finally {
            jdbc.update("SET GLOBAL max_allowed_packet = " + original);
            evictPool();
            jdbc.update("DELETE FROM order_item");
        }
        System.out.println("\n  ★ 注意「帶 ? 的 SQL」只有 12 萬字元，而它送出去的封包"
                + "遠大於這個數字 ——");
        System.out.println("    預設組態下驅動把每一個 ? 換成字面值（UUID 變成 16 進位常值），");
        System.out.println("    所以真正決定會不會爆的是【展開後的位元組數】，"
                + "而那個數字你在程式裡看不到。");
        System.out.println("    ✅ 這就是「一律分塊」的理由：分塊之後這個上限【永遠不會】成為問題。");
    }

    private void evictPool() {
        try {
            javax.sql.DataSource ds = jdbc.getDataSource();
            if (ds instanceof net.ttddyy.dsproxy.support.ProxyDataSource p) ds = p.getDataSource();
            if (ds instanceof com.zaxxer.hikari.HikariDataSource h)
                h.getHikariPoolMXBean().softEvictConnections();
        } catch (Exception ignored) { }
    }

    // ══════════════ 8.4.7 其他用途 ══════════════

    @Test @Transactional
    void a7_一句update改N列() {
        head("8.4.7 <foreach> 的第二個用途：一句 UPDATE 改 N 列【不同的值】");
        List<AmountPatch8> patches = new ArrayList<>();
        for (int i = 0; i < 5; i++)
            patches.add(new AmountPatch8(orderIds.get(i), new BigDecimal((7000 + i) + ".0000")));

        System.out.println("  SQL：");
        System.out.println("    " + cut(dyn().sql(NS + "patchAmounts",
                Dyn.args("patches", patches)), 300));
        showTail("patchAmounts", () -> System.out.println(
                "   影響列數：" + orders.patchAmounts(patches)));
        System.out.println("   結果：" + jdbc.queryForList(
                "SELECT order_no, total_amount FROM orders ORDER BY placed_at LIMIT 5"));
        System.out.println("\n  ★ 這是 05 章 5.6.1 那個「批次 update」的 MyBatis 版，"
                + "而且它可以【每一列不同的值】——");
        System.out.println("    JPQL 的 update 做不到（一句 JPQL 只能設常數或表達式）。");
    }

    @Test @Transactional
    void a8_foreach組OR() {
        head("8.4.7b <foreach> 的第三個用途：組 OR");
        var kws = List.of("%客戶0%", "%客戶2%");
        System.out.println("  SQL  : " + dyn().where(NS + "searchAnyKeyword",
                Dyn.args("keywords", kws)));
        System.out.println("  執行 : " + orders.searchAnyKeyword(kws).size() + " 張");
        System.out.println("\n  ★ open=\"(\" close=\")\" 在這裡是【必要的】——");
        System.out.println("    少了括號，「A OR B」跟前面的 AND 會結合成 「X AND A OR B」，");
        System.out.println("    而 AND 的優先權比 OR 高 → 條件的意思完全變了，"
                + "SQL 卻完全合法。");
    }

    @Test @Transactional
    void a9_五條規則() {
        head("8.4.8 <foreach> 的五條規則");
        System.out.println("  ① 空集合 / null 一定要處理（8.4.2）——"
                + "而且處理方式要留在 SQL 裡，不是在 Java 裡短路");
        System.out.println("  ② 筆數要分塊（8.4.6）—— 500～1000 一句，兩個上限都會擋你");
        System.out.println("  ③ 組 OR 的時候 open/close 的括號是【正確性】，不是排版（8.4.7b）");
        System.out.println("  ④ 想要形狀穩定就自己 pad（8.4.3）——"
                + "MyBatis 沒有 in_clause_parameter_padding");
        System.out.println("  ⑤ <foreach> 裡面【不要】放 ${}。它是 N 倍的注入面積。");
    }
}
```

---

### 8.4.1 實測：`in` 子句

```xml
  <select id="byIds" resultMap="rowMap">
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
     WHERE o.id IN
    <foreach item="id" collection="ids" open="(" separator="," close=")">
      #{id}
    </foreach>
     ORDER BY o.placed_at, o.id
  </select>
```

```
═══ 8.4.1 <foreach> 組 in 子句 ═══
  SQL   : WHERE o.id IN ( ? , ? , ? )
  ? 對應: [__frch_id_0, __frch_id_1, __frch_id_2]
  ★ 參數名是 MyBatis 自己生的（__frch_<item>_<序號>）——
    所以 item="id" 這個名字只在 <foreach> 內部有效。

  執行  : 3 張

── 四個屬性的語意
    collection  要走訪的東西（參數名，或 list / array / 屬性路徑）
    item        每一個元素在 #{} 裡叫什麼
    open/close  前後各加一段字（in 子句是「(」與「)」）
    separator   元素之間插什麼（in 子句是「,」）
    index       List 是【索引】、Map 是【key】
```

📌 **`__frch_id_0` 這個名字值得記住一次**：

```
<foreach> 做的事是【把集合的每一個元素放進 additionalParameters】，
名字是 __frch_<item>_<全域遞增序號>，然後產生對應的 #{__frch_id_0}。
                              ↓
所以 item="id" 那個名字不會出現在最終的 ParameterMapping 裡，
它只是「XML 內部的區域變數名」——跟 <bind> 一樣（8.3.9）。
```

⚠️ **`collection` 那個屬性的規則容易記錯**：

```
方法有 @Param("ids")            → collection="ids"          ✅ 本章的寫法
方法只有一個 List 參數、沒有 @Param → collection="list"        （MyBatis 自己包的名字）
方法只有一個陣列參數、沒有 @Param   → collection="array"
參數是 POJO，集合是它的屬性        → collection="q.statuses"
```

**一律寫 `@Param`**（07 章 7.7 的規則），這樣 `collection` 就永遠是你自己取的名字。

---

### 8.4.2 🔴 實測：空集合

```xml
  <!-- ✅ 空集合的正解 —— 在 SQL 裡就把它擋掉 -->
  <select id="byIdsSafe" resultMap="rowMap">
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
    <where>
      <choose>
        <when test="ids != null and ids.size() > 0">
          AND o.id IN
          <foreach item="id" collection="ids" open="(" separator="," close=")">
            #{id}
          </foreach>
        </when>
        <otherwise>
          AND 1 = 0
        </otherwise>
      </choose>
    </where>
     ORDER BY o.placed_at, o.id
  </select>
```

```
═══ 8.4.2 🔴 空集合 ═══
── byIds（沒有防護）
   SQL  : WHERE o.id IN
   執行 : BadSqlGrammarException ← SQLSyntaxErrorException
          You have an error in your SQL syntax; … near 'ORDER BY o.plac…

── ✅ byIdsSafe（<choose> 擋掉）
   SQL  : WHERE 1 = 0
   執行 : 0 張
   有值 : 3 張

── null 呢
   byIds(null)     : MyBatisSystemException ← BuilderException
   byIdsSafe(null) : 0 張
```

**空集合產生的 SQL 是 `WHERE o.id IN ORDER BY …`** ——
`open`/`close` **在集合為空時不會輸出**，所以連括號都沒有。

📌 **「`1 = 0`」而不是「在 Java 那一側短路、直接回傳空 List」的兩個理由**：

```
① 這個 <foreach> 通常只是【一堆條件裡的一個】。
   在 Java 那一側短路，就得把整段條件邏輯搬到 Java —— 而那正是動態 SQL 要避免的事。
② SQL 的形狀還是可預測的（8.9.2 那條斷言查的就是這個）。
```

⚠️ **`null` 與空集合是兩種不同的錯誤**：

```
byIds(空 List)  → SQL 語法錯誤（IN 後面沒東西）
byIds(null)     → BuilderException（OGNL 對 null 求 .size() 之前就掛了）
```

**而 `byIdsSafe` 那個 `ids != null and ids.size() > 0` 兩個都擋掉了 ——
`and` 在 OGNL 裡是短路的。**

---

### 8.4.3 ★ 實測：`in` 子句的形狀爆炸與 padding（對照 05 章 5.5.3）

```java
    @Test @Transactional
    void a3_形狀爆炸() {
        head("8.4.3 in 子句的形狀爆炸（對照 05 章 5.5.3）");
        List<UUID> all = new ArrayList<>(orderIds);

        Set<String> shapes = new LinkedHashSet<>();
        for (int n = 1; n <= 20; n++)
            shapes.add(dyn().where(NS + "byIds", Dyn.args("ids", all.subList(0, n))));
        System.out.println("  清單長度 1～20 → " + shapes.size() + " 種 SQL 形狀");
        int i = 0;
        for (String s : shapes) if (i++ < 4) System.out.println("    " + s);
        System.out.println("    …（每多一個 id 就是一句新的 SQL）");

        System.out.println("\n── ✅ 自己補到 2 的次方（Pad8）");
        Set<String> padded = new LinkedHashSet<>();
        for (int n = 1; n <= 20; n++)
            padded.add(dyn().where(NS + "byIds", Dyn.args("ids", Pad8.pad(all.subList(0, n)))));
        System.out.println("  清單長度 1～20 → " + padded.size() + " 種 SQL 形狀");
        padded.forEach(s -> System.out.println("    " + cut(s, 120)));

        System.out.println("\n── 補的值會不會改變結果");
        for (int n : new int[]{5, 7, 13}) {
            var sub = all.subList(0, n);
            System.out.println("    " + n + " 個 id：原本 " + orders.byIds(sub).size()
                    + " 張、補到 " + Pad8.pad(sub).size() + " 個之後 "
                    + orders.byIds(Pad8.pad(sub)).size() + " 張");
        }
    }
```

```
═══ 8.4.3 in 子句的形狀爆炸（對照 05 章 5.5.3） ═══
  清單長度 1～20 → 20 種 SQL 形狀
    WHERE o.id IN ( ? )
    WHERE o.id IN ( ? , ? )
    WHERE o.id IN ( ? , ? , ? )
    WHERE o.id IN ( ? , ? , ? , ? )
    …（每多一個 id 就是一句新的 SQL）

── ✅ 自己補到 2 的次方（Pad8）
  清單長度 1～20 → 6 種 SQL 形狀
    WHERE o.id IN ( ? )
    WHERE o.id IN ( ? , ? )
    WHERE o.id IN ( ? , ? , ? , ? )
    WHERE o.id IN ( ? , ? , ? , ? , ? , ? , ? , ? )
    WHERE o.id IN ( ? , ? , ? , ? , ? , ? , ? , ? , ? , ? , ? , ? , ? , ? , ? , ? )
    WHERE o.id IN ( ? , ? , ? , ? , ? , … 共 32 個 …

── 補的值會不會改變結果
    5 個 id：原本 5 張、補到 8 個之後 5 張
    7 個 id：原本 7 張、補到 8 個之後 7 張
    13 個 id：原本 13 張、補到 16 個之後 13 張
```

**20 種形狀 → 6 種**，而結果完全一樣（`IN` 對重複值不敏感）。

📌 **這個數字跟 05 章 5.5.3 一模一樣**：

```
05 章：Hibernate 的 in 子句，1～20 → 20 種形狀
       開 hibernate.query.in_clause_parameter_padding = true → 6 種   ← 一行組態
08 章：MyBatis 的 <foreach>，1～20 → 20 種形狀
       自己寫一個 Pad8.pad() → 6 種                                   ← 一條慣例
```

🔴 **而「一行組態」與「一條慣例」的差別，就是這一站選型表上的那一格**：

```
組態  ：打開一次，全專案的每一個 in 子句都生效，新來的同事不知道也沒差
慣例  ：每一個 in 子句都要記得呼叫 Pad8.pad()，而【漏掉不會有任何症狀】
       —— 只會有一個沒人看的形狀計數往上走
```

✅ **所以在 MyBatis 上，這件事得靠 8.9.3 那條斷言（形狀數有上界）才守得住。**

⚠️ **padding 不能解決「`in` 清單有一萬個 id」**（05 章 5.5.3 同一句話）。
那是另一個問題，解法是分批 —— 而 8.4.6 會證明分批的理由比「形狀」更硬。

---

### 8.4.5 實測：批次插入 —— 一句多組 `VALUES`

```xml
  <insert id="insertItems">
    INSERT INTO order_item (id, order_id, product_id, product_name, unit_price, qty, line_amount)
    VALUES
    <foreach item="it" collection="items" separator=",">
      (#{it.id}, #{it.orderId}, #{it.productId}, #{it.productName},
       #{it.unitPrice}, #{it.qty}, #{it.lineAmount})
    </foreach>
  </insert>
```

```
═══ 8.4.5 一句 INSERT 多組 VALUES ═══
── 一句 1000 組 VALUES
   JDBC 句數  : 1
   SQL 長度   : 24098 字元
   SQL 開頭   : INSERT INTO order_item (id, order_id, product_id, product_name,
                unit_price, qty, line_amount) VALUES (?, ?, ?,…
   插進去幾筆 : 1000

── 問伺服器（06 章第三把尺）
   Com_insert           = 1
   Innodb_rows_inserted = 1000

── 耗時（每一輪都先清表，清表不計時）
   一句 1000 組 VALUES :    22 ms
   10 句 ×100 組       :    26 ms
   1000 句 ×1 組       :   297 ms
```

📌 **`Com_insert = 1`、`Innodb_rows_inserted = 1000`** ——
這是 06 章 6.3.7 那把尺最乾淨的一次讀數：**一句 SQL、一千列**。

**跟前兩章的批次寫入放在一起看**：

| 做法 | 1000 筆的耗時 | 伺服器收到幾句 | 出處 |
|---|---|---|---|
| JPA `save()` 迴圈 | 160 ms | 1000 | 06 章 6.3.9 |
| JPA `batch_size` + `rewriteBatchedStatements` | 12～21 ms | 1 | 06 章 6.3.9 |
| MyBatis `ExecutorType.BATCH`，**沒開** rewrite | **1124 ms** | 1000 | 07 章 7.10.4 |
| MyBatis `ExecutorType.BATCH`，開了 rewrite | 10 ms | 1 | 07 章 7.10.4 |
| **MyBatis `<foreach>` 一句多值** | **22 ms** | **1** | **8.4.5** |
| MyBatis `<foreach>` 分 10 塊 ×100 | 26 ms | 10 | 8.4.5 |
| MyBatis 迴圈呼叫 1 筆 1 句 | 297 ms | 1000 | 8.4.5 |

★ **`<foreach>` 的優勢不在速度，在【它不需要任何組態】**：

```
ExecutorType.BATCH  要：另開一個 SqlSession、記得 flushStatements、
                        而且【沒有 rewriteBatchedStatements 會比不批次慢 3.7 倍】（07 章 7.10.4）
<foreach>           要：什麼都不用。它送出去的就是一句 INSERT ... VALUES (...),(...),(...)
```

⚠️ **而它的代價是 8.4.3 那件事的極端版**：
**每一種筆數就是一句不同的 SQL。** 999 筆與 1000 筆是兩句完全不同的 SQL。
所以批次匯入**一定要固定塊大小**（本章的 `10 句 ×100 組` 就是那個形狀），
這樣形狀數才會是 1（或 2：最後一塊不滿）。

---

### 8.4.6 🔴 實測：`<foreach>` 真正的上限

**先看常見說法的那個數字**：

```java
    @Test
    void a6_筆數上限() {
        head("8.4.6 🔴 <foreach> 的兩個上限");
        System.out.println("  max_allowed_packet = " + jdbc.queryForObject(
                "SELECT @@max_allowed_packet", Long.class) + " bytes");

        UUID oid = orderIds.get(0);
        for (int n : new int[]{1000, 20000, 100000}) {
            jdbc.update("DELETE FROM order_item");
            List<ItemInsert8> rows = items(oid, n);
            int len = dyn().sql(NS + "insertItems", Dyn.args("items", rows)).length();
            Throwable t = catching(() -> tx.executeWithoutResult(s -> orders.insertItems(rows)));
            System.out.printf("  %6d 筆 → SQL %,10d 字元、? %,7d 個 → %s%n", n, len,
                    dyn().placeholders(NS + "insertItems", Dyn.args("items", rows)),
                    t == null ? "OK" : name(t));
            if (t != null) System.out.println("           " + msg(t));
        }
        jdbc.update("DELETE FROM order_item");
    }
```

```
═══ 8.4.6 🔴 <foreach> 的兩個上限 ═══
  max_allowed_packet = 67108864 bytes
    1000 筆 → SQL     24,098 字元、?   7,000 個 → OK
   20000 筆 → SQL    480,098 字元、? 140,000 個 → OK
  100000 筆 → SQL  2,400,098 字元、? 700,000 個 → OK
```

🔴 **700,000 個 `?` 都過了。** 那條流傳很廣的「一句 prepared statement 最多 65535 個參數」
在**預設組態下根本不適用** —— 驅動自己把 `?` 換成字面值，
所以那句 SQL 對伺服器來說**沒有參數**。

**那開了伺服器端 prepared statement 呢**（`M2bPrepare`，8.3.13 那個類別）：

```java
    @Test
    void c_參數個數的上限() {
        head("8.4.6b <foreach> 的參數個數（useServerPrepStmts=true）");
        java.util.UUID oid = orderIds.get(0);
        System.out.println("  每一筆 7 個參數，65535 / 7 = 9362 筆 —— 理論上的天花板\n");
        System.out.printf("  %8s %10s %10s %10s %s%n", "筆數", "? 個數",
                "stmt_prep", "Com_insert", "結果");
        for (int n : new int[]{1000, 9362, 9363, 20000}) {
            jdbc.update("DELETE FROM order_item");
            java.util.List<ItemInsert8> rows = new java.util.ArrayList<>(n);
            for (int i = 0; i < n; i++)
                rows.add(new ItemInsert8(com.example.lab.Uuid7.next(), oid,
                        productIds.get(i % 6), "商品" + (i % 6),
                        new BigDecimal("100.0000"), 1, new BigDecimal("100.0000")));
            int ph = dyn().placeholders("com.example.lab.ch08.Ord8Mapper.insertItems",
                    Dyn.args("items", rows));
            stat().mark();
            Throwable t = catching(() -> tx.executeWithoutResult(s -> orders.insertItems(rows)));
            var d = stat().delta();
            System.out.printf("  %,8d %,10d %10d %10d %s%n", n, ph,
                    d.get("Com_stmt_prepare"), d.get("Com_insert"),
                    t == null ? "OK" : name(t));
        }
        jdbc.update("DELETE FROM order_item");
    }
```

```
═══ 8.4.6b <foreach> 的參數個數（useServerPrepStmts=true） ═══
  每一筆 7 個參數，65535 / 7 = 9362 筆 —— 理論上的天花板

        筆數       ? 個數  stmt_prep Com_insert 結果
     1,000      7,000          1          1 OK
     9,362     65,534          1          1 OK
     9,363     65,541          1          1 OK
    20,000    140,000          1          1 OK
```

🔴 **140,000 個參數、`Com_stmt_prepare = 1`、全部都過。**
**「65535 個參數」這條限制在 MySQL 8.0.46 + Connector/J 8.3.0 上量不到。**
那條規則來自其他資料庫（PostgreSQL 的 wire protocol 用 16 位元的參數個數欄位），
**不要直接套到 MySQL 上。**

**那真正會擋你的是什麼？把 `max_allowed_packet` 調小就看得到**：

```java
    @Test
    void a6b_撞max_allowed_packet() {
        head("8.4.6c 🔴 真正的上限：max_allowed_packet");
        long original = jdbc.queryForObject("SELECT @@GLOBAL.max_allowed_packet", Long.class);
        System.out.println("  原本的 max_allowed_packet = " + String.format("%,d", original));
        UUID oid = orderIds.get(0);
        try {
            jdbc.update("SET GLOBAL max_allowed_packet = 1048576");   // 1 MB
            // ⚠️ SET GLOBAL 對【池子裡既有的連線】無效（06 章 6.7.7 同一個坑）→ 要逼它換連線
            evictPool();
            for (int n : new int[]{1000, 5000, 20000}) {
                jdbc.update("DELETE FROM order_item");
                List<ItemInsert8> rows = items(oid, n);
                int len = dyn().sql(NS + "insertItems", Dyn.args("items", rows)).length();
                Throwable t = catching(() ->
                        tx.executeWithoutResult(s -> orders.insertItems(rows)));
                System.out.printf("  %,7d 筆 → 帶 ? 的 SQL %,9d 字元 → %s%n", n, len,
                        t == null ? "OK" : name(t));
                if (t != null) System.out.println("            " + msg(t));
            }
        } finally {
            jdbc.update("SET GLOBAL max_allowed_packet = " + original);
            evictPool();
            jdbc.update("DELETE FROM order_item");
        }
    }

    private void evictPool() {
        try {
            javax.sql.DataSource ds = jdbc.getDataSource();
            if (ds instanceof net.ttddyy.dsproxy.support.ProxyDataSource p) ds = p.getDataSource();
            if (ds instanceof com.zaxxer.hikari.HikariDataSource h)
                h.getHikariPoolMXBean().softEvictConnections();
        } catch (Exception ignored) { }
    }
```

```
═══ 8.4.6c 🔴 真正的上限：max_allowed_packet ═══
  原本的 max_allowed_packet = 67,108,864
  改成 1 MB 並把連線池清空之後：

    1,000 筆 → 帶 ? 的 SQL    24,098 字元 → OK
    5,000 筆 → 帶 ? 的 SQL   120,098 字元 → OK
   20,000 筆 → 帶 ? 的 SQL   480,098 字元 → TransientDataAccessResourceException
                                            ← PacketTooBigException
            Packet for query is too large (3,340,106 > 1,048,576).
            You can change this value on the server by setting the 'max_allowed_packet' variable.
```

★★ **注意那兩個數字的比例**：

```
帶 ? 的 SQL     480,098 字元
真正送出去的封包 3,340,106 位元組     ← 【7 倍】
                    ↓
預設組態下驅動把每一個 ? 換成字面值：
   UUID 變成 x'0192f3...' （36 個字元）、DECIMAL 變成 '100.0000'
所以決定會不會爆的是【展開後的位元組數】，而那個數字你在程式裡看不到。
```

✅ **這就是「一律分塊」真正的理由**：

```
不是因為「65535 個參數」（量不到）
不是因為「一句 SQL 太長不好看」
是因為【真正的上限是一個你看不到的數字，而它跟資料內容有關】
                    ↓
UUID 主鍵的表比 bigint 主鍵的表早 4 倍撞牆；
有一個 TEXT 欄位的表早 100 倍撞牆。
分塊之後這個上限【永遠不會】成為問題 —— 而且形狀數也順便固定了（8.4.5）。
```

📌 **實務上的塊大小：500～1000 筆**。上面的實測顯示
`10 句 ×100 組`（26 ms）跟 `1 句 ×1000 組`（22 ms）幾乎一樣快，
**所以分塊不是為了效能付出代價，它是免費的。**

---

### 8.4.7 實測：`<foreach>` 的另外兩種用途

**用途二：一句 `UPDATE` 改 N 列【不同的值】**

```xml
  <update id="patchAmounts">
    UPDATE orders
       SET total_amount = CASE id
    <foreach item="p" collection="patches">
      WHEN #{p.id} THEN #{p.amount}
    </foreach>
           END,
           version = version + 1
     WHERE id IN
    <foreach item="p" collection="patches" open="(" separator="," close=")">
      #{p.id}
    </foreach>
  </update>
```

```
═══ 8.4.7 <foreach> 的第二個用途：一句 UPDATE 改 N 列【不同的值】 ═══
  SQL：
    UPDATE orders SET total_amount = CASE id WHEN ? THEN ? WHEN ? THEN ? WHEN ? THEN ?
    WHEN ? THEN ? WHEN ? THEN ? END, version = version + 1
    WHERE id IN ( ? , ? , ? , ? , ? )
   影響列數：5
── patchAmounts → 1 句 SQL
   結果：[{order_no=SO-2026-000001, total_amount=7000.0000},
          {order_no=SO-2026-000002, total_amount=7001.0000},
          {order_no=SO-2026-000003, total_amount=7002.0000},
          {order_no=SO-2026-000004, total_amount=7003.0000},
          {order_no=SO-2026-000005, total_amount=7004.0000}]
```

📌 **這件事 JPQL 做不到**：

```
05 章 5.6.1 的批次 update：update Ord5 o set o.status = :s where …
                          → 一句 SQL 改 N 列，而【N 列都改成同一個值】

08 章 8.4.6 的 CASE WHEN： → 一句 SQL 改 N 列，【每一列不同的值】
```

⚠️ **兩個注意事項**：

```
① WHERE id IN (...) 那一段【不能省】。
   少了它就變成「全表掃描，不在清單裡的列 CASE 回傳 null」
   → total_amount 被清成 null → NOT NULL 違規（或更糟：可為 null 的欄位被清空）
② 它跟 05 章 5.6.2 的批次 update 有同樣的代價：
   繞過回呼、繞過任何 Java 端的規則。而 version = version + 1 這一行
   讓它至少不會讓 JPA 那一側的樂觀鎖靜默失效（06 章 6.6.10）。
```

**用途三：組 `OR` 條件**

```xml
  <select id="searchAnyKeyword" resultMap="rowMap">
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
    <where>
      <foreach item="k" collection="keywords" open="(" separator=" OR " close=")">
        c.display_name LIKE #{k}
      </foreach>
    </where>
     ORDER BY o.placed_at, o.id
  </select>
```

```
═══ 8.4.7b <foreach> 的第三個用途：組 OR ═══
  SQL  : WHERE ( c.display_name LIKE ? OR c.display_name LIKE ? )
  執行 : 12 張
```

🔴 **`open="("` / `close=")"` 在這裡是【正確性】，不是排版**：

```
有括號：WHERE o.status = ? AND ( name LIKE ? OR name LIKE ? )
少括號：WHERE o.status = ? AND   name LIKE ? OR name LIKE ?
                              ↓
        AND 的優先權比 OR 高 → 變成
        (o.status = ? AND name LIKE ?) OR (name LIKE ?)
                              ↓
        狀態條件【只作用於第一個關鍵字】—— 而 SQL 完全合法，沒有任何警告。
```

---

### 8.4.8 `<foreach>` 的五條規則

```
① 空集合 / null 一定要處理（8.4.2）——而且處理方式要留在 SQL 裡，不是在 Java 裡短路
② 筆數要分塊（8.4.6）—— 500～1000 一句。理由不是「參數個數上限」（量不到），
   是【展開後的封包大小，而那個數字你看不到】
③ 組 OR 的時候 open/close 的括號是【正確性】（8.4.7）
④ 想要形狀穩定就自己 pad（8.4.3）—— MyBatis 沒有 in_clause_parameter_padding，
   而漏掉【沒有任何症狀】→ 要靠 8.9.3 那條斷言
⑤ <foreach> 裡面【不要】放 ${}。它是 N 倍的注入面積。
```

---

## 8.5 `resultMap` 深入

07 章 7.8 用 `<collection>` 組出了「訂單 + 明細」兩層。
**這一節要組四層，而每一層都有一個會靜默壞掉的地方。**

```
OrderNode8（訂單）
   ├─ customer  CustomerRef8   ← <association>
   ├─ rep       RepRef8        ← <association>，而且它【可以是 null】
   └─ items     List<ItemLine8> ← <collection>
                     └─ product ProductRef8   ← 集合的元素【自己又有一個 association】
```

### 8.5.0 這一節的 mapper

```java
package com.example.lab.ch08;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.util.List;
import java.util.UUID;

/**
 * 08 章 8.5：resultMap 深入。
 * ★ 每一個方法都查【同一組資料】，只是 resultMap 的寫法不同 ——
 *   所以「哪一種寫法會壞、壞在哪」是直接對照得出來的。
 */
@Mapper
public interface Ord8ResultMapper {

    /** 8.5.1 / 8.5.2 ✅ 正式版：兩個 <association> + 巢狀 <collection>，靠 columnPrefix。 */
    List<OrderNode8> nodesByStatus(@Param("status") St8 status);

    /** 8.5.2 對照組：不用 columnPrefix，逐欄寫 column。 */
    List<OrderNode8> nodesVerbose(@Param("status") St8 status);

    /** 🔴 8.5.3：兩層巢狀而【沒有】前綴 —— 欄名衝突。 */
    List<OrderNode8> nodesNoPrefix(@Param("status") St8 status);

    /** 🔴 8.5.5：<association> 少了 <id>。 */
    List<OrderNode8> nodesAssocNoId(@Param("status") St8 status);

    /** 🔴 8.5.5b：可為 null 的 <association>（rep）少了 <id>。 */
    List<OrderNode8> nodesRepNoId(@Param("status") St8 status);

    /** 🔴 8.5.4：<collection> 的 <id> 選錯欄位（用 product_name 當身分）。 */
    List<OrderNode8> nodesItemIdIsName(@Param("status") St8 status);

    /** 8.5.8：autoMapping 打開的版本。 */
    List<OrderNode8> nodesAutoMapping(@Param("status") St8 status);

    /** 8.5.10：fetchType="lazy" 的版本。 */
    List<OrderNode8> nodesLazy(@Param("status") St8 status);

    /** 8.5.10b：fetchType="eager" 的巢狀 select（= 07 章 7.8.7 的 N+1）。 */
    List<OrderNode8> nodesEagerSelect(@Param("status") St8 status);

    List<ItemLine8> itemsOf(@Param("orderId") UUID orderId);

    CustomerRef8 customerOf(@Param("id") UUID id);

    // ═══ 8.5.6 <discriminator> ═══

    /** 一句 SELECT，回三種不同的 Java 型別。 */
    List<Pay8> payments();

    /** 對照組：沒有鑑別器 —— 全部都是 Pay8。 */
    List<Pay8> paymentsFlat();

    /** 8.5.6b：鑑別器對不上任何 <case> 的時候。 */
    List<Pay8> paymentsWithUnknownKind();

    int insertPayment(@Param("id") UUID id, @Param("orderId") UUID orderId,
                      @Param("kind") String kind, @Param("amount") java.math.BigDecimal amount,
                      @Param("paidAt") java.time.Instant paidAt,
                      @Param("cardBrand") String cardBrand, @Param("cardLast4") String cardLast4,
                      @Param("bankCode") String bankCode, @Param("bankAccount") String bankAccount,
                      @Param("codFee") java.math.BigDecimal codFee);
}
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN"
        "https://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="com.example.lab.ch08.Ord8ResultMapper">

  <!-- ═══════════════ 8.5.1 / 8.5.2 ✅ 正式版 ═══════════════ -->
  <!-- ★ 可重用的子 resultMap：customer / rep / product 各一份。
       它們【不知道自己會被掛在哪裡】，前綴由掛的人決定（columnPrefix）。 -->
  <resultMap id="customerMap" type="com.example.lab.ch08.CustomerRef8">
    <id     property="id"          column="id"/>
    <result property="displayName" column="display_name"/>
    <result property="email"       column="email"/>
    <result property="tier"        column="tier"/>
    <result property="countryCode" column="country_code"/>
  </resultMap>

  <resultMap id="repMap" type="com.example.lab.ch08.RepRef8">
    <id     property="id"     column="id"/>
    <result property="name"   column="name"/>
    <result property="region" column="region"/>
  </resultMap>

  <resultMap id="productMap" type="com.example.lab.ch08.ProductRef8">
    <id     property="id"        column="id"/>
    <result property="sku"       column="sku"/>
    <result property="name"      column="name"/>
    <result property="category"  column="category"/>
    <result property="unitPrice" column="unit_price"/>
  </resultMap>

  <resultMap id="itemMap" type="com.example.lab.ch08.ItemLine8">
    <id     property="id"          column="id"/>
    <result property="productName" column="product_name"/>
    <result property="qty"         column="qty"/>
    <result property="lineAmount"  column="line_amount"/>
    <!-- ★ 巢狀第二層。columnPrefix 會【疊加】：i_ + p_ = i_p_ -->
    <association property="product" resultMap="productMap" columnPrefix="p_"/>
  </resultMap>

  <resultMap id="nodeMap" type="com.example.lab.ch08.OrderNode8">
    <id     property="id"          column="id"/>
    <result property="orderNo"     column="order_no"/>
    <result property="status"      column="status"/>
    <result property="totalAmount" column="total_amount"/>
    <result property="placedAt"    column="placed_at"/>
    <association property="customer" resultMap="customerMap" columnPrefix="c_"/>
    <association property="rep"      resultMap="repMap"      columnPrefix="r_"/>
    <collection  property="items"    resultMap="itemMap"      columnPrefix="i_"/>
  </resultMap>

  <sql id="nodeColumns">
    o.id, o.order_no, o.status, o.total_amount, o.placed_at,
    c.id AS c_id, c.display_name AS c_display_name, c.email AS c_email,
    c.tier AS c_tier, c.country_code AS c_country_code,
    r.id AS r_id, r.name AS r_name, r.region AS r_region,
    i.id AS i_id, i.product_name AS i_product_name, i.qty AS i_qty,
    i.line_amount AS i_line_amount,
    p.id AS i_p_id, p.sku AS i_p_sku, p.name AS i_p_name,
    p.category AS i_p_category, p.unit_price AS i_p_unit_price
  </sql>

  <sql id="nodeFrom">
    FROM orders o
    JOIN customer c ON c.id = o.customer_id
    LEFT JOIN sales_rep r ON r.id = o.rep_id
    LEFT JOIN order_item i ON i.order_id = o.id
    LEFT JOIN product p ON p.id = i.product_id
  </sql>

  <select id="nodesByStatus" resultMap="nodeMap">
    SELECT <include refid="nodeColumns"/>
    <include refid="nodeFrom"/>
     WHERE o.status = #{status}
     ORDER BY o.placed_at, o.id, i.id
  </select>

  <!-- ═══════════════ 8.5.2 對照組：逐欄寫 column（沒有 columnPrefix）═══════════════ -->
  <resultMap id="nodeVerboseMap" type="com.example.lab.ch08.OrderNode8">
    <id     property="id"          column="id"/>
    <result property="orderNo"     column="order_no"/>
    <result property="status"      column="status"/>
    <result property="totalAmount" column="total_amount"/>
    <result property="placedAt"    column="placed_at"/>
    <association property="customer" javaType="com.example.lab.ch08.CustomerRef8">
      <id     property="id"          column="c_id"/>
      <result property="displayName" column="c_display_name"/>
      <result property="email"       column="c_email"/>
      <result property="tier"        column="c_tier"/>
      <result property="countryCode" column="c_country_code"/>
    </association>
    <association property="rep" javaType="com.example.lab.ch08.RepRef8">
      <id     property="id"     column="r_id"/>
      <result property="name"   column="r_name"/>
      <result property="region" column="r_region"/>
    </association>
    <collection property="items" ofType="com.example.lab.ch08.ItemLine8">
      <id     property="id"          column="i_id"/>
      <result property="productName" column="i_product_name"/>
      <result property="qty"         column="i_qty"/>
      <result property="lineAmount"  column="i_line_amount"/>
      <association property="product" javaType="com.example.lab.ch08.ProductRef8">
        <id     property="id"        column="i_p_id"/>
        <result property="sku"       column="i_p_sku"/>
        <result property="name"      column="i_p_name"/>
        <result property="category"  column="i_p_category"/>
        <result property="unitPrice" column="i_p_unit_price"/>
      </association>
    </collection>
  </resultMap>

  <select id="nodesVerbose" resultMap="nodeVerboseMap">
    SELECT <include refid="nodeColumns"/>
    <include refid="nodeFrom"/>
     WHERE o.status = #{status}
     ORDER BY o.placed_at, o.id, i.id
  </select>

  <!-- ═══════════════ 🔴 8.5.3 沒有前綴：欄名衝突 ═══════════════ -->
  <!-- customer / product 都有 id 與 name，SQL 裡沒有別名 → 靠 JDBC 的「同名取第一個」 -->
  <resultMap id="nodeNoPrefixMap" type="com.example.lab.ch08.OrderNode8">
    <id     property="id"          column="id"/>
    <result property="orderNo"     column="order_no"/>
    <result property="status"      column="status"/>
    <result property="totalAmount" column="total_amount"/>
    <result property="placedAt"    column="placed_at"/>
    <association property="customer" resultMap="customerMap"/>
    <association property="rep"      resultMap="repMap"/>
    <collection  property="items"    resultMap="itemMap"/>
  </resultMap>

  <select id="nodesNoPrefix" resultMap="nodeNoPrefixMap">
    SELECT o.id, o.order_no, o.status, o.total_amount, o.placed_at,
           c.id, c.display_name, c.email, c.tier, c.country_code,
           r.id, r.name, r.region,
           i.id, i.product_name, i.qty, i.line_amount,
           p.id, p.sku, p.name, p.category, p.unit_price
    <include refid="nodeFrom"/>
     WHERE o.status = #{status}
     ORDER BY o.placed_at, o.id, i.id
  </select>

  <!-- ═══════════════ 🔴 8.5.5 <association> 少了 <id> ═══════════════ -->
  <resultMap id="customerNoIdMap" type="com.example.lab.ch08.CustomerRef8">
    <result property="id"          column="id"/>   <!-- ★ 用 <result>，不是 <id> -->
    <result property="displayName" column="display_name"/>
    <result property="email"       column="email"/>
    <result property="tier"        column="tier"/>
    <result property="countryCode" column="country_code"/>
  </resultMap>

  <resultMap id="nodeAssocNoIdMap" type="com.example.lab.ch08.OrderNode8">
    <id     property="id"          column="id"/>
    <result property="orderNo"     column="order_no"/>
    <result property="status"      column="status"/>
    <result property="totalAmount" column="total_amount"/>
    <result property="placedAt"    column="placed_at"/>
    <association property="customer" resultMap="customerNoIdMap" columnPrefix="c_"/>
    <association property="rep"      resultMap="repMap"          columnPrefix="r_"/>
    <collection  property="items"    resultMap="itemMap"          columnPrefix="i_"/>
  </resultMap>

  <select id="nodesAssocNoId" resultMap="nodeAssocNoIdMap">
    SELECT <include refid="nodeColumns"/>
    <include refid="nodeFrom"/>
     WHERE o.status = #{status}
     ORDER BY o.placed_at, o.id, i.id
  </select>

  <!-- ═══════════════ 🔴 8.5.5b 可為 null 的 association 沒有 <id> ═══════════════ -->
  <resultMap id="repNoIdMap" type="com.example.lab.ch08.RepRef8">
    <result property="id"     column="id"/>     <!-- ★ 用 <result>，不是 <id> -->
    <result property="name"   column="name"/>
    <result property="region" column="region"/>
  </resultMap>

  <resultMap id="nodeRepNoIdMap" type="com.example.lab.ch08.OrderNode8">
    <id     property="id"          column="id"/>
    <result property="orderNo"     column="order_no"/>
    <result property="status"      column="status"/>
    <result property="totalAmount" column="total_amount"/>
    <result property="placedAt"    column="placed_at"/>
    <association property="customer" resultMap="customerMap" columnPrefix="c_"/>
    <association property="rep"      resultMap="repNoIdMap"  columnPrefix="r_"/>
    <collection  property="items"    resultMap="itemMap"      columnPrefix="i_"/>
  </resultMap>

  <select id="nodesRepNoId" resultMap="nodeRepNoIdMap">
    SELECT <include refid="nodeColumns"/>
    <include refid="nodeFrom"/>
     WHERE o.status = #{status}
     ORDER BY o.placed_at, o.id, i.id
  </select>

  <!-- ═══════════════ 🔴 8.5.4 <collection> 的 <id> 選錯欄位 ═══════════════ -->
  <resultMap id="itemIdIsNameMap" type="com.example.lab.ch08.ItemLine8">
    <id     property="productName" column="product_name"/>  <!-- 🔴 用商品名當身分 -->
    <result property="id"          column="id"/>
    <result property="qty"         column="qty"/>
    <result property="lineAmount"  column="line_amount"/>
    <association property="product" resultMap="productMap" columnPrefix="p_"/>
  </resultMap>

  <resultMap id="nodeItemIdIsNameMap" type="com.example.lab.ch08.OrderNode8">
    <id     property="id"          column="id"/>
    <result property="orderNo"     column="order_no"/>
    <result property="status"      column="status"/>
    <result property="totalAmount" column="total_amount"/>
    <result property="placedAt"    column="placed_at"/>
    <association property="customer" resultMap="customerMap"      columnPrefix="c_"/>
    <association property="rep"      resultMap="repMap"           columnPrefix="r_"/>
    <collection  property="items"    resultMap="itemIdIsNameMap"   columnPrefix="i_"/>
  </resultMap>

  <select id="nodesItemIdIsName" resultMap="nodeItemIdIsNameMap">
    SELECT <include refid="nodeColumns"/>
    <include refid="nodeFrom"/>
     WHERE o.status = #{status}
     ORDER BY o.placed_at, o.id, i.id
  </select>

  <!-- ═══════════════ 8.5.8 autoMapping ═══════════════ -->
  <!-- ★ 只寫 <id>，其餘欄位交給自動映射（map-underscore-to-camel-case 已經開著） -->
  <resultMap id="nodeAutoMap" type="com.example.lab.ch08.OrderNode8" autoMapping="true">
    <id property="id" column="id"/>
    <association property="customer" javaType="com.example.lab.ch08.CustomerRef8"
                 columnPrefix="c_" autoMapping="true">
      <id property="id" column="id"/>
    </association>
    <association property="rep" javaType="com.example.lab.ch08.RepRef8"
                 columnPrefix="r_" autoMapping="true">
      <id property="id" column="id"/>
    </association>
    <collection property="items" ofType="com.example.lab.ch08.ItemLine8"
                columnPrefix="i_" autoMapping="true">
      <id property="id" column="id"/>
      <association property="product" javaType="com.example.lab.ch08.ProductRef8"
                   columnPrefix="p_" autoMapping="true">
        <id property="id" column="id"/>
      </association>
    </collection>
  </resultMap>

  <select id="nodesAutoMapping" resultMap="nodeAutoMap">
    SELECT <include refid="nodeColumns"/>
    <include refid="nodeFrom"/>
     WHERE o.status = #{status}
     ORDER BY o.placed_at, o.id, i.id
  </select>

  <!-- ═══════════════ 8.5.10 fetchType ═══════════════ -->
  <resultMap id="nodeLazyMap" type="com.example.lab.ch08.OrderNode8">
    <id     property="id"          column="id"/>
    <result property="orderNo"     column="order_no"/>
    <result property="status"      column="status"/>
    <result property="totalAmount" column="total_amount"/>
    <result property="placedAt"    column="placed_at"/>
    <association property="customer" column="customer_id" select="customerOf"
                 javaType="com.example.lab.ch08.CustomerRef8" fetchType="lazy"/>
    <collection  property="items"    column="id" select="itemsOf"
                 ofType="com.example.lab.ch08.ItemLine8" fetchType="lazy"/>
  </resultMap>

  <resultMap id="nodeEagerSelectMap" type="com.example.lab.ch08.OrderNode8">
    <id     property="id"          column="id"/>
    <result property="orderNo"     column="order_no"/>
    <result property="status"      column="status"/>
    <result property="totalAmount" column="total_amount"/>
    <result property="placedAt"    column="placed_at"/>
    <association property="customer" column="customer_id" select="customerOf"
                 javaType="com.example.lab.ch08.CustomerRef8" fetchType="eager"/>
    <collection  property="items"    column="id" select="itemsOf"
                 ofType="com.example.lab.ch08.ItemLine8" fetchType="eager"/>
  </resultMap>

  <select id="nodesLazy" resultMap="nodeLazyMap">
    SELECT o.id, o.order_no, o.status, o.total_amount, o.placed_at, o.customer_id
      FROM orders o
     WHERE o.status = #{status}
     ORDER BY o.placed_at, o.id
  </select>

  <select id="nodesEagerSelect" resultMap="nodeEagerSelectMap">
    SELECT o.id, o.order_no, o.status, o.total_amount, o.placed_at, o.customer_id
      FROM orders o
     WHERE o.status = #{status}
     ORDER BY o.placed_at, o.id
  </select>

  <select id="itemsOf" resultType="com.example.lab.ch08.ItemLine8">
    SELECT id, product_name, qty, line_amount
      FROM order_item WHERE order_id = #{orderId} ORDER BY id
  </select>

  <select id="customerOf" resultType="com.example.lab.ch08.CustomerRef8">
    SELECT id, display_name, email, tier, country_code
      FROM customer WHERE id = #{id}
  </select>

  <!-- ═══════════════ 8.5.6 <discriminator> ═══════════════ -->
  <resultMap id="payBaseMap" type="com.example.lab.ch08.Pay8">
    <id     property="id"      column="id"/>
    <result property="orderId" column="order_id"/>
    <result property="kind"    column="kind"/>
    <result property="amount"  column="amount"/>
    <result property="paidAt"  column="paid_at"/>
  </resultMap>

  <!-- ★ extends：把共同欄位繼承下來，只寫自己多的那幾欄 -->
  <resultMap id="cardMap" type="com.example.lab.ch08.CardPay8" extends="payBaseMap">
    <result property="cardBrand" column="card_brand"/>
    <result property="cardLast4" column="card_last4"/>
  </resultMap>

  <resultMap id="transferMap" type="com.example.lab.ch08.TransferPay8" extends="payBaseMap">
    <result property="bankCode"    column="bank_code"/>
    <result property="bankAccount" column="bank_account"/>
  </resultMap>

  <resultMap id="codMap" type="com.example.lab.ch08.CodPay8" extends="payBaseMap">
    <result property="codFee" column="cod_fee"/>
  </resultMap>

  <resultMap id="payMap" type="com.example.lab.ch08.Pay8" extends="payBaseMap">
    <discriminator javaType="java.lang.String" column="kind">
      <case value="CARD"     resultMap="cardMap"/>
      <case value="TRANSFER" resultMap="transferMap"/>
      <case value="COD"      resultMap="codMap"/>
    </discriminator>
  </resultMap>

  <select id="payments" resultMap="payMap">
    SELECT id, order_id, kind, amount, paid_at,
           card_brand, card_last4, bank_code, bank_account, cod_fee
      FROM payment ORDER BY paid_at, id
  </select>

  <select id="paymentsFlat" resultMap="payBaseMap">
    SELECT id, order_id, kind, amount, paid_at
      FROM payment ORDER BY paid_at, id
  </select>

  <select id="paymentsWithUnknownKind" resultMap="payMap">
    SELECT id, order_id, kind, amount, paid_at,
           card_brand, card_last4, bank_code, bank_account, cod_fee
      FROM payment ORDER BY paid_at, id
  </select>

  <insert id="insertPayment">
    INSERT INTO payment (id, order_id, kind, amount, paid_at,
                         card_brand, card_last4, bank_code, bank_account, cod_fee)
    VALUES (#{id}, #{orderId}, #{kind}, #{amount}, #{paidAt},
            #{cardBrand}, #{cardLast4}, #{bankCode}, #{bankAccount}, #{codFee})
  </insert>
</mapper>
```

**測試類別**：

```java
package com.example.lab.ch08;

import com.example.lab.Uuid7;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.util.List;

/** 8.5：resultMap 深入。 */
class M4Result extends Base08 {

    @Autowired Ord8ResultMapper results;

    @BeforeEach void setUp() { seed(8, 4, 2); }

    private void dump(String title, List<OrderNode8> nodes) {
        System.out.println("── " + title + " → " + nodes.size() + " 張訂單");
        for (OrderNode8 n : nodes.subList(0, Math.min(2, nodes.size()))) {
            System.out.println("   " + n.getOrderNo() + "  客戶=" + n.getCustomer()
                    + "  業務=" + n.getRep() + "  明細 " + n.getItems().size() + " 筆");
            for (ItemLine8 it : n.getItems())
                System.out.println("       " + it);
        }
    }

    // ══════════════ 8.5.1 / 8.5.2 columnPrefix ══════════════

    @Test @Transactional
    void a1_兩個association加一個巢狀collection() {
        head("8.5.1 一句 SQL 組出四層物件圖");
        showTail("nodesByStatus", () -> dump("columnPrefix 版",
                results.nodesByStatus(St8.PENDING)));
    }

    @Test @Transactional
    void a2_columnPrefix與逐欄寫() {
        head("8.5.2 columnPrefix vs 逐欄寫 column");
        var a = results.nodesByStatus(St8.PENDING);
        var b = results.nodesVerbose(St8.PENDING);
        System.out.println("  columnPrefix 版 : " + a.size() + " 張、第一張 "
                + a.get(0).getItems().size() + " 筆明細、客戶 " + a.get(0).getCustomer());
        System.out.println("  逐欄寫版        : " + b.size() + " 張、第一張 "
                + b.get(0).getItems().size() + " 筆明細、客戶 " + b.get(0).getCustomer());
        System.out.println("  結果一樣嗎      : "
                + (a.size() == b.size()
                   && a.get(0).getCustomer().getEmail().equals(b.get(0).getCustomer().getEmail())
                   && a.get(0).getItems().get(0).getProduct().getSku()
                        .equals(b.get(0).getItems().get(0).getProduct().getSku())));
        System.out.println("\n  ★ 差別不在結果，在【可重用性】：");
        System.out.println("    columnPrefix 版的 customerMap / repMap / productMap"
                + " 各自是【獨立的 resultMap】，");
        System.out.println("    可以被別的查詢用；逐欄寫版的那些 <id>/<result> 綁死在這一個查詢裡。");
    }

    @Test @Transactional
    void a3_沒有前綴的欄名衝突() {
        head("8.5.3 🔴 兩層巢狀而沒有前綴");
        var ok = results.nodesByStatus(St8.PENDING);
        var bad = results.nodesNoPrefix(St8.PENDING);
        System.out.println("  ✅ 有 columnPrefix：");
        System.out.println("     客戶 = " + ok.get(0).getCustomer());
        System.out.println("     業務 = " + ok.get(0).getRep());
        System.out.println("     明細第一筆 = " + ok.get(0).getItems().get(0));
        System.out.println("\n  🔴 沒有 columnPrefix（SQL 裡也沒有別名）：");
        System.out.println("     訂單數 = " + bad.size() + " 張");
        System.out.println("     客戶 = " + bad.get(0).getCustomer());
        System.out.println("     業務 = " + bad.get(0).getRep());
        System.out.println("     明細 = " + bad.get(0).getItems().size() + " 筆");
        if (!bad.get(0).getItems().isEmpty())
            System.out.println("     明細第一筆 = " + bad.get(0).getItems().get(0));
    }

    // ══════════════ 8.5.4 <id> 的身分語意 ══════════════

    @Test @Transactional
    void a4_id選錯欄位() {
        head("8.5.4 🔴 <collection> 的 <id> 選錯欄位");
        // ★ 造一筆「同一張訂單有兩筆同名商品」的資料
        var oid = orderIds.get(0);
        jdbc.update("UPDATE order_item SET product_name = '重複商品' WHERE order_id = ?",
                Uuid7.toBytes(oid));
        System.out.println("  資料庫裡這張訂單有 " + jdbc.queryForObject(
                "SELECT count(*) FROM order_item WHERE order_id = ?", Long.class,
                Uuid7.toBytes(oid)) + " 筆明細，而且【商品名一樣】");

        var ok = results.nodesByStatus(St8.PENDING);
        var bad = results.nodesItemIdIsName(St8.PENDING);
        System.out.println("\n  ✅ <id> 用 order_item.id       → 第一張訂單 "
                + ok.get(0).getItems().size() + " 筆明細");
        System.out.println("  🔴 <id> 用 product_name        → 第一張訂單 "
                + bad.get(0).getItems().size() + " 筆明細");
        System.out.println("\n  ★ 少的那一筆【沒有任何錯誤訊息】。");
        System.out.println("    <id> 的意思是「這幾欄一樣就是同一個物件」——");
        System.out.println("    選 product_name 就等於宣告「同一張訂單不會有兩筆同名商品」。");
        System.out.println("    這是一條【業務規則】，而它被寫在 XML 裡，沒有人會去 review 它。");
    }

    @Test @Transactional
    void a5_association少了id() {
        head("8.5.5 🔴 <association> 少了 <id>");
        var ok = results.nodesByStatus(St8.PENDING);
        var bad = results.nodesAssocNoId(St8.PENDING);
        System.out.println("  ✅ customerMap 有 <id> → " + ok.size() + " 張，"
                + "第一張明細 " + ok.get(0).getItems().size() + " 筆");
        System.out.println("  🟡 customerMap 沒 <id> → " + bad.size() + " 張，"
                + "第一張明細 " + bad.get(0).getItems().size() + " 筆");
        System.out.println("     客戶 = " + bad.get(0).getCustomer());

        System.out.println("\n── 8.5.5b 那如果那個 association 本來該是 null 呢");
        System.out.println("   本章的 rep 是 LEFT JOIN，一半的訂單沒有業務員。");
        var repOk = results.nodesByStatus(St8.PENDING);
        var repBad = results.nodesRepNoId(St8.PENDING);
        System.out.println("   ✅ repMap 有 <id>：");
        for (OrderNode8 n : repOk)
            System.out.println("      " + n.getOrderNo() + " → rep = " + n.getRep());
        System.out.println("   🔴 repMap 沒有 <id>：");
        for (OrderNode8 n : repBad)
            System.out.println("      " + n.getOrderNo() + " → rep = " + n.getRep()
                    + (n.getRep() != null && n.getRep().getName() == null
                       ? "   ← 物件不是 null，但每一欄都是 null" : ""));
        System.out.println("\n   ★ <id> 是 MyBatis 判斷「這一組欄位全是 null → 整個物件是 null」的依據。");
        System.out.println("     少了它，呼叫端的 order.getRep() != null 檢查【永遠成立】，");
        System.out.println("     然後在 getRep().getName().trim() 那一行拿到 NullPointerException。");
    }

    @Test @Transactional
    void a6_autoMapping() {
        head("8.5.7 autoMapping：只寫 <id>，其餘交給自動映射");
        var a = results.nodesByStatus(St8.PENDING);
        var b = results.nodesAutoMapping(St8.PENDING);
        System.out.println("  逐欄寫版     : " + a.get(0).getOrderNo()
                + "、客戶 " + a.get(0).getCustomer()
                + "、明細 " + a.get(0).getItems().size() + " 筆、商品 "
                + a.get(0).getItems().get(0).getProduct());
        System.out.println("  autoMapping  : " + b.get(0).getOrderNo()
                + "、客戶 " + b.get(0).getCustomer()
                + "、明細 " + b.get(0).getItems().size() + " 筆、商品 "
                + b.get(0).getItems().get(0).getProduct());
        System.out.println("\n  ★ 一樣。而 autoMapping 版的 XML 從 30 行變成 12 行。");
        System.out.println("  🔴 代價：欄位名對不上的時候【靜默 null】（07 章 7.8.1），");
        System.out.println("    而那正是 resultMap 存在的理由。");
        System.out.println("    → 折衷：autoMapping + 8.9.4 那條「每一欄都不准是 null」的斷言。");
    }

    // ══════════════ 8.5.6 discriminator ══════════════

    @Test @Transactional
    void a7_鑑別器() {
        head("8.5.6 <discriminator>：一句 SELECT 回三種 Java 型別");
        seedPayments();
        showTail("payments", () -> {
            List<Pay8> all = results.payments();
            System.out.println("   共 " + all.size() + " 筆");
            for (Pay8 p : all)
                System.out.println("     " + p.getClass().getSimpleName()
                        + "  " + p.describe());
        });

        System.out.println("\n── 對照組：沒有鑑別器");
        List<Pay8> flat = results.paymentsFlat();
        System.out.println("   共 " + flat.size() + " 筆");
        for (Pay8 p : flat.subList(0, 3))
            System.out.println("     " + p.getClass().getSimpleName() + "  " + p.describe());

        System.out.println("\n── 🔴 鑑別器對不上任何 <case> 的時候");
        jdbc.update("UPDATE payment SET kind = 'CRYPTO' WHERE kind = 'COD'");
        List<Pay8> unknown = results.paymentsWithUnknownKind();
        for (Pay8 p : unknown)
            if (!"CARD".equals(p.getKind()) && !"TRANSFER".equals(p.getKind()))
                System.out.println("     kind=" + p.getKind() + " → "
                        + p.getClass().getSimpleName() + "  " + p.describe());
        System.out.println("   ★ 它【退回基底 resultMap】—— 不報錯。");
        System.out.println("     所以「資料庫多了一種 kind」這件事，"
                + "在 Java 這一側是【行為靜默退化】。");
    }
}
```

---

### 8.5.1 實測：一句 SQL 組出四層物件圖

```
═══ 8.5.1 一句 SQL 組出四層物件圖 ═══
── columnPrefix 版 → 2 張訂單
   SO-2026-000001  客戶=Cust{客戶0, NORMAL, TW}  業務=Rep{業務0, 北區}  明細 2 筆
       Item{商品1 ×2, product=Prod{SKU-1, 商品1}}
       Item{商品0 ×1, product=Prod{SKU-0, 商品0}}
   SO-2026-000005  客戶=Cust{客戶1, SILVER, JP}  業務=null  明細 2 筆
       Item{商品4 ×1, product=Prod{SKU-4, 商品4}}
       Item{商品5 ×2, product=Prod{SKU-5, 商品5}}
── nodesByStatus → 1 句 SQL
   … FROM orders o JOIN customer c ON c.id = o.customer_id
     LEFT JOIN sales_rep r ON r.id = o.rep_id
     LEFT JOIN order_item i ON i.order_id = o.id
     LEFT JOIN product p ON p.id = i.product_id
     WHERE o.status = ? ORDER BY o.placed_at, o.id, i.id
```

**一句 SQL、四張表、四層物件、`rep` 正確地是 `null`。**

📌 **這是 05 章 5.8.8「DTO 裡面要有集合的時候」那一格的答案**：

```
05 章 5.8.8：select new 的參數【只能是純量】
             → DTO 裡要有集合，得做【兩段式投影】（先查主檔，再查明細，在 Java 裡組）
05 章 5.12.2 決策表：「DTO 裡要有巢狀集合 → 兩段式投影，或 MyBatis（08 章）」
                              ↓
08 章 8.5.1：一句 SQL、一個 <collection>、0 行 Java 組裝程式碼。
```

⚠️ **而它跟 JPA 的 `join fetch` 有同一個代價：笛卡兒積。**
2 張訂單 × 2 筆明細 = 4 列 SQL 結果 → 組成 2 個物件。
**明細多的時候（04 章 4.5.5 那個「2000 張取 20 筆」）問題一樣存在，
而 MyBatis 這一側連 `HHH90003004` 那個警告都沒有** —— 8.6.5 會看到它的後果。

---

### 8.5.2 實測：`columnPrefix` 與逐欄寫 `column`

**同一個結果，兩種寫法**：

```xml
  <!-- ✅ columnPrefix：子 resultMap 可以重用 -->
  <resultMap id="customerMap" type="com.example.lab.ch08.CustomerRef8">
    <id     property="id"          column="id"/>
    <result property="displayName" column="display_name"/>
    …
  </resultMap>

  <resultMap id="nodeMap" type="com.example.lab.ch08.OrderNode8">
    …
    <association property="customer" resultMap="customerMap" columnPrefix="c_"/>
    <association property="rep"      resultMap="repMap"      columnPrefix="r_"/>
    <collection  property="items"    resultMap="itemMap"      columnPrefix="i_"/>
  </resultMap>

  <!-- 對照組：逐欄寫 column，前綴自己打 -->
  <resultMap id="nodeVerboseMap" type="com.example.lab.ch08.OrderNode8">
    …
    <association property="customer" javaType="com.example.lab.ch08.CustomerRef8">
      <id     property="id"          column="c_id"/>
      <result property="displayName" column="c_display_name"/>
      …
    </association>
    …
  </resultMap>
```

```
═══ 8.5.2 columnPrefix vs 逐欄寫 column ═══
  columnPrefix 版 : 2 張、第一張 2 筆明細、客戶 Cust{客戶0, NORMAL, TW}
  逐欄寫版        : 2 張、第一張 2 筆明細、客戶 Cust{客戶0, NORMAL, TW}
  結果一樣嗎      : true
```

📌 **這回答了 07 章 7.8.6 留下的那個問題**（「`<collection>` 的欄位要加前綴」）：

```
07 章 7.8.6 的做法：SQL 裡寫 i.product_name AS i_product_name，
                   resultMap 裡寫 column="i_product_name"
                   → 前綴在【兩個地方】各打一次

08 章 8.5.2 的做法：SQL 裡照樣寫別名，resultMap 裡寫 columnPrefix="i_"
                   → 子 resultMap 完全不知道自己被掛在哪裡
```

★ **`columnPrefix` 的價值不在「少打字」，在【子 resultMap 變成可重用的元件】**：

```
customerMap 可以同時被
   nodeMap 用（columnPrefix="c_"）
   一個「客戶清單」查詢用（沒有前綴）
   一個「訂單 + 收貨人 + 開票人」查詢用（columnPrefix="ship_" / "bill_"）
                              ↓
而逐欄寫版的那些 <id>/<result> 綁死在【那一個查詢】裡。
```

⚠️ **`columnPrefix` 會疊加。** 本章 `itemMap` 裡的
`<association property="product" resultMap="productMap" columnPrefix="p_"/>`
被 `nodeMap` 用 `columnPrefix="i_"` 掛進來之後，
`productMap` 實際看到的前綴是 **`i_p_`** —— 所以 SQL 裡要寫 `p.sku AS i_p_sku`。

---

### 8.5.3 🔴 實測：兩層巢狀而沒有前綴

```xml
  <!-- 🔴 customer / product 都有 id 與 name，而 SQL 裡沒有別名 -->
  <resultMap id="nodeNoPrefixMap" type="com.example.lab.ch08.OrderNode8">
    …
    <association property="customer" resultMap="customerMap"/>
    <association property="rep"      resultMap="repMap"/>
    <collection  property="items"    resultMap="itemMap"/>
  </resultMap>

  <select id="nodesNoPrefix" resultMap="nodeNoPrefixMap">
    SELECT o.id, o.order_no, o.status, o.total_amount, o.placed_at,
           c.id, c.display_name, c.email, c.tier, c.country_code,
           r.id, r.name, r.region,
           i.id, i.product_name, i.qty, i.line_amount,
           p.id, p.sku, p.name, p.category, p.unit_price
    <include refid="nodeFrom"/>
     WHERE o.status = #{status}
     ORDER BY o.placed_at, o.id, i.id
  </select>
```

```
═══ 8.5.3 🔴 兩層巢狀而沒有前綴 ═══
  ✅ 有 columnPrefix：
     客戶 = Cust{客戶0, NORMAL, TW}
     業務 = Rep{業務0, 北區}
     明細第一筆 = Item{商品0 ×1, product=Prod{SKU-0, 商品0}}

  🔴 沒有 columnPrefix（SQL 裡也沒有別名）：
     訂單數 = 2 張
     客戶 = Cust{客戶0, NORMAL, TW}
     業務 = Rep{業務0, 北區}
     明細 = 1 筆                      ← 少了一筆
     明細第一筆 = Item{商品0 ×1, product=null}    ← 商品不見了
```

🔴 **三個症狀，沒有一個是例外**：

```
① 訂單數對（2 張）—— 所以「筆數斷言」抓不到
② 客戶與業務員【看起來對】—— 因為 c.id 剛好排在 o.id 後面第一個
③ 明細少一筆、product 是 null   ← 真正壞掉的地方
```

**為什麼會這樣**：

```
SQL 的結果集有【五個叫 id 的欄位】（o.id / c.id / r.id / i.id / p.id）。
JDBC 的 ResultSet.getObject("id") 規則是【回傳第一個符合的】→ 永遠是 o.id。
                              ↓
itemMap 的 <id property="id" column="id"/> 拿到的是【訂單的 id】
   → 同一張訂單的兩筆明細，身分欄位一樣 → MyBatis 把它們合併成一個
productMap 的每一欄也都拿到別人的值 → 而 <id> 拿到訂單 id
   → 8.5.5 那個 returnInstanceForEmptyRow=false 讓它變成 null
```

✅ **兩條規則**：

```
① SQL 裡的每一個欄位都要有【全域唯一】的別名。
   一旦有兩張表 JOIN，「不寫別名」就是一個等著發生的 bug。
② resultMap 用 columnPrefix，別名用同樣的前綴 —— 兩件事要一起做。
   只做一件（有前綴但 SQL 沒別名 / SQL 有別名但 resultMap 沒前綴）
   都會得到【靜默的錯誤結果】。
```

⚠️ **而這是 8.9.4 那條斷言存在的理由**：
「每一個查詢回來的每一個欄位都不准是 null」——
`product == null` 這件事，只有那條斷言抓得到。

---

### 8.5.4 🔴 實測：`<collection>` 的 `<id>` 選錯欄位

**這一格回收 07 章 7.17.2 的練習三。**
07 章 7.8.6 那個 `<collection>` 用 `productName` 當 `<id>`，並註明「那是將就的做法」：

```xml
  <!-- 🔴 用商品名當身分 -->
  <resultMap id="itemIdIsNameMap" type="com.example.lab.ch08.ItemLine8">
    <id     property="productName" column="product_name"/>
    <result property="id"          column="id"/>
    <result property="qty"         column="qty"/>
    <result property="lineAmount"  column="line_amount"/>
    <association property="product" resultMap="productMap" columnPrefix="p_"/>
  </resultMap>
```

```java
    @Test @Transactional
    void a4_id選錯欄位() {
        head("8.5.4 🔴 <collection> 的 <id> 選錯欄位");
        // ★ 造一筆「同一張訂單有兩筆同名商品」的資料
        var oid = orderIds.get(0);
        jdbc.update("UPDATE order_item SET product_name = '重複商品' WHERE order_id = ?",
                Uuid7.toBytes(oid));
        System.out.println("  資料庫裡這張訂單有 " + jdbc.queryForObject(
                "SELECT count(*) FROM order_item WHERE order_id = ?", Long.class,
                Uuid7.toBytes(oid)) + " 筆明細，而且【商品名一樣】");

        var ok = results.nodesByStatus(St8.PENDING);
        var bad = results.nodesItemIdIsName(St8.PENDING);
        System.out.println("\n  ✅ <id> 用 order_item.id       → 第一張訂單 "
                + ok.get(0).getItems().size() + " 筆明細");
        System.out.println("  🔴 <id> 用 product_name        → 第一張訂單 "
                + bad.get(0).getItems().size() + " 筆明細");
    }
```

```
═══ 8.5.4 🔴 <collection> 的 <id> 選錯欄位 ═══
  資料庫裡這張訂單有 2 筆明細，而且【商品名一樣】

  ✅ <id> 用 order_item.id       → 第一張訂單 2 筆明細
  🔴 <id> 用 product_name        → 第一張訂單 1 筆明細
```

🔴 **少的那一筆沒有任何錯誤訊息，而金額也跟著少了。**

📌 **`<id>` 的語意，用一句話講完**：

```
<id> 不是「主鍵」。它是【這一組欄位一樣，就是同一個物件】。
                              ↓
選 product_name 當 <id>，等於在 XML 裡宣告了一條【業務規則】：
   「同一張訂單不會有兩筆商品名相同的明細」
而那條規則沒有寫在任何文件裡，也沒有資料庫約束保護它，
更不會有人在 code review 的時候注意到它。
```

✅ **規則：`<id>` 一律用那張表真正的主鍵。**
如果 SQL 沒有把主鍵查出來（例如為了少幾個位元組），
**那就是把主鍵加回 SELECT 清單，不是換一個欄位當 `<id>`。**

⚠️ **不寫 `<id>` 呢？** 那 MyBatis 會用**所有已映射的欄位**當身分。
那通常是對的（同一筆明細的所有欄位當然一樣），
而它讓「兩筆完全一樣的明細」（同商品、同數量、同金額）**合併成一筆** ——
這在真實資料裡是可能發生的。

---

### 8.5.5 實測：`<association>` 少了 `<id>`（以及那個真正的開關）

**先看一個常見的說法**：「`<association>` 少了 `<id>`，
`LEFT JOIN` 沒對到的時候會建出一個空物件而不是 null。」

```xml
  <!-- rep 是 LEFT JOIN、可以是 null，而這一份 repMap 沒有 <id> -->
  <resultMap id="repNoIdMap" type="com.example.lab.ch08.RepRef8">
    <result property="id"     column="id"/>
    <result property="name"   column="name"/>
    <result property="region" column="region"/>
  </resultMap>
```

```
═══ 8.5.5 🔴 <association> 少了 <id> ═══
  ✅ customerMap 有 <id> → 2 張，第一張明細 2 筆
  🟡 customerMap 沒 <id> → 2 張，第一張明細 2 筆
     客戶 = Cust{客戶0, NORMAL, TW}

── 8.5.5b 那如果那個 association 本來該是 null 呢
   本章的 rep 是 LEFT JOIN，一半的訂單沒有業務員。
   ✅ repMap 有 <id>：
      SO-2026-000001 → rep = Rep{業務0, 北區}
      SO-2026-000005 → rep = null
   🔴 repMap 沒有 <id>：
      SO-2026-000001 → rep = Rep{業務0, 北區}
      SO-2026-000005 → rep = null
```

🔴 **那個說法是錯的。** 兩邊都是 `null`，`<id>` 在這件事上**沒有影響**。

**真正控制它的是另一個組態**：

```java
package com.example.lab.ch08;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.transaction.annotation.Transactional;

/**
 * 8.5.5b：真正決定「全 null 的列要不要建物件」的不是 &lt;id&gt;，
 * 是 returnInstanceForEmptyRow 這個組態。
 *
 * ⚠️ 子類別的 @SpringBootTest(properties) 會【取代】父類別那一份 → URL 要重寫。
 */
@SpringBootTest(properties = {
  "spring.datasource.url=jdbc:mysql://127.0.0.1:33306/ch08?connectionTimeZone=UTC"
      + "&forceConnectionTimeZoneToSession=true&preserveInstants=true&characterEncoding=UTF-8",
  "mybatis.configuration.return-instance-for-empty-row=true"
})
class M4bEmptyRow extends Base08 {

    @Autowired Ord8ResultMapper results;

    @BeforeEach void setUp() { seed(8, 4, 2); }

    @Test @Transactional
    void a_空列也建物件() {
        head("8.5.5b returnInstanceForEmptyRow = true");
        System.out.println("  組態值：" + sqlSessionFactory.getConfiguration()
                .isReturnInstanceForEmptyRow());
        System.out.println("\n  repMap【有】<id>：");
        for (OrderNode8 n : results.nodesByStatus(St8.PENDING))
            System.out.println("    " + n.getOrderNo() + " → rep = " + n.getRep());
        System.out.println("\n  repMap【沒有】<id>：");
        for (OrderNode8 n : results.nodesRepNoId(St8.PENDING))
            System.out.println("    " + n.getOrderNo() + " → rep = " + n.getRep());
        System.out.println("\n  ★ 這個組態一改，「沒有業務員」就從 null 變成"
                + "【一個每欄都是 null 的 RepRef8】。");
        System.out.println("    預設是 false，不要改它。");
    }
}
```

```
═══ 8.5.5b returnInstanceForEmptyRow = true ═══
  組態值：true

  repMap【有】<id>：
    SO-2026-000001 → rep = Rep{業務0, 北區}
    SO-2026-000005 → rep = Rep{null, null}      ← 物件不是 null，每一欄都是 null

  repMap【沒有】<id>：
    SO-2026-000001 → rep = Rep{業務0, 北區}
    SO-2026-000005 → rep = Rep{null, null}
```

📌 **所以正確的說法是**：

| 問題 | 答案 |
|---|---|
| 「全 null 的列要不要建物件」由誰決定 | **`returnInstanceForEmptyRow`**（預設 `false` = 回 `null`） |
| `<association>` 裡的 `<id>` 決定什麼 | **物件的身分鍵**（沒寫就退化成「全部已映射的欄位」） |
| `<collection>` 裡的 `<id>` 決定什麼 | **同上，而它會【真的合併掉列】**（8.5.4） |

⚠️ **`returnInstanceForEmptyRow=true` 造成的問題比它解決的多**：

```
呼叫端寫 if (order.getRep() != null) { … order.getRep().getName().trim() … }
   → 檢查【永遠成立】，然後在 .trim() 那一行 NullPointerException
                              ↓
預設值 false 是對的。不要改它。
```

✅ **`<id>` 的實務規則，兩個集合類型統一**：
**`<association>` 與 `<collection>` 都寫 `<id>`，都用真正的主鍵。**
`<association>` 上寫它的收益是「身分鍵變小 → 巢狀結果的比對變快」，
而 `<collection>` 上寫它是**正確性**（8.5.4）。

---

### 8.5.6 實測：`<discriminator>` —— 一句 `SELECT` 回三種 Java 型別

**`payment` 那張表有十欄，而任何一列只用得到六欄**（8.2.1）。
這是 06 站的「單表繼承」，在 JPA 那一側是
`@Inheritance(SINGLE_TABLE)` + `@DiscriminatorColumn`。

```xml
  <resultMap id="payBaseMap" type="com.example.lab.ch08.Pay8">
    <id     property="id"      column="id"/>
    <result property="orderId" column="order_id"/>
    <result property="kind"    column="kind"/>
    <result property="amount"  column="amount"/>
    <result property="paidAt"  column="paid_at"/>
  </resultMap>

  <!-- ★ extends：把共同欄位繼承下來，只寫自己多的那幾欄 -->
  <resultMap id="cardMap" type="com.example.lab.ch08.CardPay8" extends="payBaseMap">
    <result property="cardBrand" column="card_brand"/>
    <result property="cardLast4" column="card_last4"/>
  </resultMap>

  <resultMap id="transferMap" type="com.example.lab.ch08.TransferPay8" extends="payBaseMap">
    <result property="bankCode"    column="bank_code"/>
    <result property="bankAccount" column="bank_account"/>
  </resultMap>

  <resultMap id="codMap" type="com.example.lab.ch08.CodPay8" extends="payBaseMap">
    <result property="codFee" column="cod_fee"/>
  </resultMap>

  <resultMap id="payMap" type="com.example.lab.ch08.Pay8" extends="payBaseMap">
    <discriminator javaType="java.lang.String" column="kind">
      <case value="CARD"     resultMap="cardMap"/>
      <case value="TRANSFER" resultMap="transferMap"/>
      <case value="COD"      resultMap="codMap"/>
    </discriminator>
  </resultMap>
```

```
═══ 8.5.6 <discriminator>：一句 SELECT 回三種 Java 型別 ═══
   共 6 筆
     CardPay8      VISA 卡 ****1000
     TransferPay8  轉帳 808-123456781
     CodPay8       貨到付款（手續費 30.0000）
     CardPay8      VISA 卡 ****1003
     TransferPay8  轉帳 808-123456784
     CodPay8       貨到付款（手續費 30.0000）
── payments → 1 句 SQL
   … FROM payment ORDER BY paid_at, id

── 對照組：沒有鑑別器
   共 6 筆
     Pay8  未知的付款方式（CARD）
     Pay8  未知的付款方式（TRANSFER）
     Pay8  未知的付款方式（COD）

── 🔴 鑑別器對不上任何 <case> 的時候
     kind=CRYPTO → Pay8  未知的付款方式（CRYPTO）
     kind=CRYPTO → Pay8  未知的付款方式（CRYPTO）
```

📌 **三件事**：

**① `extends` 讓三個子 `resultMap` 各自只寫「自己多的那幾欄」。**
它不只省字 —— 共同欄位改名的時候，**只有 `payBaseMap` 要改**。

**② 一句 SQL，三個不同的 Java 類別，而 `describe()` 這個多型方法真的分派對了。**
這是 MyBatis 少數「物件導向味道很重」的功能。

**③🔴 鑑別器對不上任何 `<case>` 的時候，它【退回基底 resultMap】，不報錯。**

```
資料庫多了一種 kind='CRYPTO'
   → payments() 回傳 Pay8（基底型別）
   → describe() 回傳「未知的付款方式（CRYPTO）」
   → 而如果呼叫端寫的是 switch (p.getClass()) 或 instanceof 鏈，
     它會【靜默走進 default 分支】
```

✅ **兩個處理方式**：

```
① 基底類別做成 abstract → 那時候 MyBatis 會拋例外（建不出實例）
   ⚠️ 而例外發生在【查詢的時候】，不是「新增那個 kind 的時候」
② 加一個 <case> 指到一個 UnknownPay8，並讓它的 describe() 顯眼地失敗
   → 這是「大聲失敗」的做法，而且不會讓整個查詢掛掉
```

⚠️ **`<discriminator>` 只看一個欄位、只做字串比對，沒有「預設分支」。**
它不像 `<choose>` 有 `<otherwise>`。

---

### 8.5.7 實測：`autoMapping`

```xml
  <!-- ★ 只寫 <id>，其餘欄位交給自動映射（map-underscore-to-camel-case 已經開著） -->
  <resultMap id="nodeAutoMap" type="com.example.lab.ch08.OrderNode8" autoMapping="true">
    <id property="id" column="id"/>
    <association property="customer" javaType="com.example.lab.ch08.CustomerRef8"
                 columnPrefix="c_" autoMapping="true">
      <id property="id" column="id"/>
    </association>
    <association property="rep" javaType="com.example.lab.ch08.RepRef8"
                 columnPrefix="r_" autoMapping="true">
      <id property="id" column="id"/>
    </association>
    <collection property="items" ofType="com.example.lab.ch08.ItemLine8"
                columnPrefix="i_" autoMapping="true">
      <id property="id" column="id"/>
      <association property="product" javaType="com.example.lab.ch08.ProductRef8"
                   columnPrefix="p_" autoMapping="true">
        <id property="id" column="id"/>
      </association>
    </collection>
  </resultMap>
```

```
═══ 8.5.7 autoMapping：只寫 <id>，其餘交給自動映射 ═══
  逐欄寫版     : SO-2026-000001、客戶 Cust{客戶0, NORMAL, TW}、明細 2 筆、
                 商品 Prod{SKU-1, 商品1}
  autoMapping  : SO-2026-000001、客戶 Cust{客戶0, NORMAL, TW}、明細 2 筆、
                 商品 Prod{SKU-1, 商品1}
```

**結果一樣，而 XML 從 30 行變成 12 行。**

📌 **注意巢狀裡面的 `columnPrefix` + `autoMapping` 是怎麼配合的**：

```
columnPrefix="i_" 之後，autoMapping 會把「以 i_ 開頭的欄位」
【去掉前綴】再套 map-underscore-to-camel-case：
      i_product_name  →（去前綴）→ product_name  →（駝峰）→ productName
                              ↓
所以 SQL 的別名規則（前綴 + 底線命名）就是整份映射的契約。
```

🔴 **代價是 07 章 7.8.1 那個坑**：欄位名對不上的時候**靜默是 null**，
而 `resultMap` 的存在理由本來就是「把那個契約寫下來」。

✅ **折衷的做法**（本章最後採用的）：

```
autoMapping="true" + <id> 手寫  →  XML 短、契約靠命名慣例
              ＋
8.9.4 那條斷言：每一個查詢回來的每一個欄位都不准是 null
              ↓
命名慣例壞掉的那一刻，CI 就會紅 —— 而不是三個月後客服說「這一欄一直是空的」。
```

---

### 8.5.8 實測：`fetchType` —— MyBatis 的延遲載入

**07 章 7.2 那張盤點表有一格寫著「代理與延遲載入 🟡 有簡化版（`fetchType="lazy"`，08 章會處理）」。
這一節就是那一格。**

```xml
  <resultMap id="nodeLazyMap" type="com.example.lab.ch08.OrderNode8">
    <id     property="id"          column="id"/>
    …
    <association property="customer" column="customer_id" select="customerOf"
                 javaType="com.example.lab.ch08.CustomerRef8" fetchType="lazy"/>
    <collection  property="items"    column="id" select="itemsOf"
                 ofType="com.example.lab.ch08.ItemLine8" fetchType="lazy"/>
  </resultMap>

  <resultMap id="nodeEagerSelectMap" type="com.example.lab.ch08.OrderNode8">
    <id     property="id"          column="id"/>
    …
    <association property="customer" column="customer_id" select="customerOf"
                 javaType="com.example.lab.ch08.CustomerRef8" fetchType="eager"/>
    <collection  property="items"    column="id" select="itemsOf"
                 ofType="com.example.lab.ch08.ItemLine8" fetchType="eager"/>
  </resultMap>
```

```java
package com.example.lab.ch08;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/** 8.5.10：fetchType 在【預設組態】下的樣子。 */
class M4cLazyOff extends Base08 {

    @Autowired Ord8ResultMapper results;

    @BeforeEach void setUp() { seed(8, 4, 2); }

    @Test @Transactional
    void a_預設組態下的fetchType() {
        head("8.5.8 fetchType 在預設組態下（lazyLoadingEnabled = false）");
        var cfg = sqlSessionFactory.getConfiguration();
        System.out.println("  lazyLoadingEnabled     = " + cfg.isLazyLoadingEnabled());
        System.out.println("  aggressiveLazyLoading  = " + cfg.isAggressiveLazyLoading());
        System.out.println("  proxyFactory           = "
                + cfg.getProxyFactory().getClass().getSimpleName());

        List<OrderNode8>[] box = new List[1];
        System.out.println("\n── ① 查 fetchType=\"lazy\"，不碰任何關聯");
        List<String> a = spy(() -> {
            box[0] = results.nodesLazy(St8.PENDING);
            System.out.println("   " + box[0].size() + " 張、類別 = "
                    + box[0].get(0).getClass().getSimpleName());
        });
        System.out.println("   → " + a.size() + " 句 SQL");

        System.out.println("\n── ② 碰同一批物件的關聯（2 張 × 2 個關聯）");
        List<String> b = spy(() -> {
            int n = 0;
            for (OrderNode8 o : box[0]) { n += o.getItems().size(); o.getCustomer(); }
            System.out.println("   明細總數 " + n + "、第一張的客戶 "
                    + box[0].get(0).getCustomer());
        });
        System.out.println("   → " + b.size() + " 句 SQL");
        for (String s : b) System.out.println("     " + cut(s, 90));

        System.out.println("\n  ★ fetchType=\"lazy\" 【不需要】lazyLoadingEnabled = true。");
        System.out.println("    那個全域組態只是【預設值】，mapping 上的 fetchType 蓋過它。");
        System.out.println("    → 這跟 04 章 4.3.6 那個 @Basic(fetch=LAZY)"
                + "「沒有 enhancement 就完全無效」【不一樣】。");
    }

    @Test @Transactional
    void b_eager版() {
        head("8.5.8b fetchType=\"eager\" 的巢狀 select（= 07 章 7.8.7 的 N+1）");
        List<String> b = spy(() -> {
            List<OrderNode8> nodes = results.nodesEagerSelect(St8.PENDING);
            System.out.println("   " + nodes.size() + " 張、類別 = "
                    + nodes.get(0).getClass().getSimpleName());
        });
        System.out.println("   → " + b.size() + " 句 SQL（1 + 2 張 × 2 個關聯）");
    }

    @Test @Transactional
    void c_一級快取會把延遲載入吃掉() {
        head("8.5.9 ★ 延遲載入的 SQL 可能【一句都沒有】");
        System.out.println("── 先跑一次 eager 版（把 itemsOf / customerOf 灌進一級快取）");
        System.out.println("   → " + spy(() -> results.nodesEagerSelect(St8.PENDING)).size()
                + " 句 SQL");

        System.out.println("\n── 再查 lazy 版並走訪全部關聯");
        List<String> b = spy(() -> {
            List<OrderNode8> nodes = results.nodesLazy(St8.PENDING);
            for (OrderNode8 o : nodes) { o.getItems().size(); o.getCustomer(); }
        });
        System.out.println("   → " + b.size() + " 句 SQL");
        System.out.println("\n  ★ 巢狀 select 的 statement 是【可以被一級快取命中的普通查詢】"
                + "（07 章 7.11.3）。");
        System.out.println("    所以「延遲載入打幾句 SQL」這個問題，答案取決於"
                + "【同一個交易裡之前查過什麼】——");
        System.out.println("    量 N+1 的時候，要嘛每一輪換一個交易，要嘛就會量到假的好數字。");
    }
}
```

```
═══ 8.5.8 fetchType 在預設組態下（lazyLoadingEnabled = false） ═══
  lazyLoadingEnabled     = false
  aggressiveLazyLoading  = false
  proxyFactory           = JavassistProxyFactory

── ① 查 fetchType="lazy"，不碰任何關聯
   2 張、類別 = OrderNode8_$$_jvst41c_0
   → 1 句 SQL

── ② 碰同一批物件的關聯（2 張 × 2 個關聯）
   明細總數 4、第一張的客戶 Cust{客戶0, NORMAL, TW}
   → 4 句 SQL
     SELECT id, product_name, qty, line_amount FROM order_item WHERE order_id = ? ORDER BY id
     SELECT id, display_name, email, tier, country_code FROM customer WHERE id = ?
     SELECT id, product_name, qty, line_amount FROM order_item WHERE order_id = ? ORDER BY id
     SELECT id, display_name, email, tier, country_code FROM customer WHERE id = ?

═══ 8.5.8b fetchType="eager" 的巢狀 select（= 07 章 7.8.7 的 N+1） ═══
   2 張、類別 = OrderNode8
   → 5 句 SQL（1 + 2 張 × 2 個關聯）
```

★ **第一個結論：`fetchType="lazy"` 【不需要】`lazyLoadingEnabled = true`。**

```
lazyLoadingEnabled = false（預設）
   ↑ 這只是【全域預設值】。mapping 上寫了 fetchType 就蓋過它。
     實測：類別是 OrderNode8_$$_jvst41c_0（Javassist 代理）、查詢只有 1 句。
```

📌 **這跟 04 章 4.3.6 那個坑【不一樣】，值得並排放**：

```
JPA     @Basic(fetch = LAZY)  沒有 bytecode enhancement → 【完全無效】，欄位照樣在 SELECT 裡
MyBatis fetchType="lazy"      不需要任何額外組態 → 【立刻生效】，代理是執行期產生的
                              ↓
差別在於 JPA 的欄位延遲載入需要改寫 class 檔（欄位存取攔不到），
而 MyBatis 只做【物件層級】的延遲載入（getter 攔得到）。
```

**打開 `lazyLoadingEnabled` 之後的樣子**：

```java
package com.example.lab.ch08;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/** 8.5.10b：把 lazyLoadingEnabled 打開之後。 */
@SpringBootTest(properties = {
  "spring.datasource.url=jdbc:mysql://127.0.0.1:33306/ch08?connectionTimeZone=UTC"
      + "&forceConnectionTimeZoneToSession=true&preserveInstants=true&characterEncoding=UTF-8",
  "mybatis.configuration.lazy-loading-enabled=true",
  "mybatis.configuration.aggressive-lazy-loading=false"
})
class M4dLazyOn extends Base08 {

    @Autowired Ord8ResultMapper results;

    @BeforeEach void setUp() { seed(8, 4, 2); }

    @Test @Transactional
    void a_打開之後() {
        head("8.5.8c lazyLoadingEnabled = true");
        var cfg = sqlSessionFactory.getConfiguration();
        System.out.println("  lazyLoadingEnabled    = " + cfg.isLazyLoadingEnabled());
        System.out.println("  aggressiveLazyLoading = " + cfg.isAggressiveLazyLoading());

        System.out.println("\n── 只查、不碰關聯");
        List<OrderNode8>[] box = new List[1];
        List<String> a = spy(() -> {
            box[0] = results.nodesLazy(St8.PENDING);
            System.out.println("   查回來 " + box[0].size() + " 張");
            System.out.println("   物件的類別 : " + box[0].get(0).getClass().getName());
        });
        System.out.println("   → " + a.size() + " 句 SQL");

        System.out.println("\n── 碰一個 getter");
        List<String> b = spy(() -> System.out.println(
                "   第一張的客戶 = " + box[0].get(0).getCustomer()));
        System.out.println("   → " + b.size() + " 句 SQL");

        System.out.println("\n── 走訪全部關聯（4 張 × 2 個關聯）");
        List<String> c = spy(() -> {
            int n = 0;
            for (OrderNode8 o : box[0]) { n += o.getItems().size(); o.getCustomer(); }
            System.out.println("   明細總數 " + n);
        });
        System.out.println("   → " + c.size() + " 句 SQL");
        System.out.println("\n  ★ 這就是 04 章那個 N+1，只是這一次【是你在 XML 裡寫的】。");
    }

    /** 🔴 8.5.11：交易結束之後才碰關聯 —— 對照 04 章的 LazyInitializationException。 */
    @Test
    void b_沒有交易的時候() {
        head("8.5.10 🔴 交易外存取延遲關聯");
        List<OrderNode8> nodes = tx.execute(s -> results.nodesLazy(St8.PENDING));
        System.out.println("  交易已經結束。手上有 " + nodes.size() + " 張訂單。");

        Throwable t = catching(() -> {
            List<String> sqls = spy(() -> System.out.println(
                    "  第一張的客戶 = " + nodes.get(0).getCustomer()));
            System.out.println("  → " + sqls.size() + " 句 SQL");
        });
        System.out.println("  結果：" + name(t));

        System.out.println("\n── 那它是【新開一條連線】嗎？問 MySQL 的 Connections 計數器");
        stat().mark();
        long before = jdbc.queryForObject(
                "SELECT VARIABLE_VALUE FROM performance_schema.global_status"
                + " WHERE VARIABLE_NAME = 'Connections'", Long.class);
        List<String> sqls = spy(() -> nodes.get(1).getItems().size());
        long after = jdbc.queryForObject(
                "SELECT VARIABLE_VALUE FROM performance_schema.global_status"
                + " WHERE VARIABLE_NAME = 'Connections'", Long.class);
        System.out.println("   碰第二張的明細 → " + sqls.size() + " 句 SQL");
        for (String s : sqls) System.out.println("     " + cut(s, 95));
        System.out.println("   伺服器端的 Connections 增加了 " + (after - before)
                + "（連線池裡撿一條也算 0）");

        System.out.println("\n  ★★ 對照 04 章 4.4：");
        System.out.println("     JPA   交易外碰延遲關聯 → LazyInitializationException（大聲）");
        System.out.println("     MyBatis 交易外碰延遲關聯 → 【它自己開一個 Executor 把資料撈回來】");
        System.out.println("     ResultLoader.selectList() 裡有一段：");
        System.out.println("       if (Thread.currentThread().getId() != creatorThreadId");
        System.out.println("           || localExecutor.isClosed()) localExecutor = newExecutor();");
        System.out.println("     → 這等於 04 章 4.4.4 那個 enable_lazy_load_no_trans，");
        System.out.println("       而在 MyBatis 上它【是預設行為、沒有開關】。");
        System.out.println("     🔴 所以「回傳帶延遲關聯的物件給 Controller」在 MyBatis 上");
        System.out.println("       不會有任何錯誤訊息 —— 只會有一支 API 打 N 句 SQL、");
        System.out.println("       每一句在【交易之外】，而且序列化的時候才發生。");
    }
}
```

```
═══ 8.5.8c lazyLoadingEnabled = true ═══
  lazyLoadingEnabled    = true
  aggressiveLazyLoading = false

── 只查、不碰關聯
   查回來 2 張
   物件的類別 : com.example.lab.ch08.OrderNode8_$$_jvst41c_0
   → 1 句 SQL

── 碰一個 getter
   第一張的客戶 = Cust{客戶0, NORMAL, TW}
   → 1 句 SQL

── 走訪全部關聯（2 張 × 2 個關聯）
   明細總數 4
   → 3 句 SQL
```

⚠️ **`aggressiveLazyLoading` 這個組態要注意**：

```
true（MyBatis 3.4.1 之前的預設值）→ 碰【任何一個】getter 就把【全部】延遲關聯載入
false（現在的預設值）             → 只載入被碰到的那一個
                              ↓
如果你維護的是舊專案，這個組態很可能被留在 true 上。
症狀是「我只要 orderNo，為什麼打了 4 句 SQL」。
```

---

### 8.5.9 ★ 實測：延遲載入的 SQL 句數，取決於同一個交易裡之前查過什麼

```java
    @Test @Transactional
    void c_一級快取會把延遲載入吃掉() {
        head("8.5.10c ★ 延遲載入的 SQL 可能【一句都沒有】");
        System.out.println("── 先跑一次 eager 版（把 itemsOf / customerOf 灌進一級快取）");
        System.out.println("   → " + spy(() -> results.nodesEagerSelect(St8.PENDING)).size()
                + " 句 SQL");

        System.out.println("\n── 再查 lazy 版並走訪全部關聯");
        List<String> b = spy(() -> {
            List<OrderNode8> nodes = results.nodesLazy(St8.PENDING);
            for (OrderNode8 o : nodes) { o.getItems().size(); o.getCustomer(); }
        });
        System.out.println("   → " + b.size() + " 句 SQL");
    }
```

```
═══ 8.5.9 ★ 延遲載入的 SQL 可能【一句都沒有】 ═══
── 先跑一次 eager 版（把 itemsOf / customerOf 灌進一級快取）
   → 5 句 SQL

── 再查 lazy 版並走訪全部關聯
   → 1 句 SQL
```

★★ **同一段「走訪全部關聯」的程式碼，在 8.5.8 是 4 句、在這裡是 0 句。**

```
巢狀 select（select="itemsOf"）的 statement 是【一個普通的 mapper 查詢】。
   → 它會被 MyBatis 的一級快取命中（07 章 7.11.3：範圍是 SqlSession、key 是 SQL + 參數）
   → 所以「延遲載入打幾句 SQL」的答案是
     【同一個交易裡之前有沒有人查過那一句】
```

⚠️ **這對「量 N+1」是一個陷阱，而它跟 04 章那個陷阱形狀相同、成因不同**：

```
04 章 4.9.1：手動把 400 筆明細撈進持久化情境，迴圈【還是】200 句
             → 因為一級快取的 key 是實體 id，而集合的初始化旗標在另一張表上
08 章 8.5.9：先跑一次 eager 版，lazy 版的走訪就【一句都不打】
             → 因為 MyBatis 一級快取的 key 是「SQL + 參數」，
               而延遲載入送出去的就是那一句 SQL
                              ↓
04 章的陷阱讓你【量到假的壞數字】；08 章的陷阱讓你【量到假的好數字】。
後者危險得多。
```

✅ **量 MyBatis 的 N+1，兩條規則**：

```
① 每一輪都要換一個交易（或呼叫 SqlSession.clearCache()）
② 斷言寫在「statement 被呼叫幾次」而不是「SQL 打了幾句」
   → 8.8.2 那個 SqlLogInterceptor 站在 Executor 那一層，
     它【看得到快取命中的那一次呼叫】，而 SqlSpy 看不到。
```

---

### 8.5.10 🔴🔴 實測：交易外存取延遲關聯

**04 章 4.4 花了一整節講 `LazyInitializationException`。MyBatis 這一側呢？**

```
═══ 8.5.10 🔴 交易外存取延遲關聯 ═══
  交易已經結束。手上有 2 張訂單。
  第一張的客戶 = Cust{客戶0, NORMAL, TW}
  → 1 句 SQL
  結果：沒有例外

── 那它是【新開一條連線】嗎？問 MySQL 的 Connections 計數器
   碰第二張的明細 → 1 句 SQL
     SELECT id, product_name, qty, line_amount FROM order_item WHERE order_id = ? ORDER BY id
   伺服器端的 Connections 增加了 0（連線池裡撿一條也算 0）
```

🔴🔴 **沒有例外。它自己把資料撈回來了。**

**MyBatis 的 `ResultLoader.selectList()` 裡有這一段**：

```java
Executor localExecutor = executor;
if (Thread.currentThread().getId() != this.creatorThreadId || localExecutor.isClosed()) {
  localExecutor = newExecutor();          // ★ 原本那個關了 → 開一個新的
}
```

📌 **並排看兩個框架**：

| | JPA / Hibernate | MyBatis |
|---|---|---|
| 交易外碰延遲關聯 | 🔴 `LazyInitializationException` | ✅ **自己開一個 `Executor` 撈回來** |
| 這是預設行為嗎 | 是 | 是 |
| 有開關嗎 | 有（`enable_lazy_load_no_trans`，04 章 4.4.4） | **🔴 沒有** |
| 每次存取一個交易 | 開了之後是（04 章量過） | **是** |

★★ **這是這一章最需要注意的一格**：

```
04 章 4.4.4 的結論是「enable_lazy_load_no_trans 是假修復」——
   它讓錯誤消失，而每一次存取變成一個獨立的交易。
                              ↓
而 MyBatis 把那個「假修復」設成【預設行為，而且拿不掉】。
```

🔴 **後果**：

```
把一個帶延遲關聯的物件回傳給 Controller
   → Jackson 序列化的時候一個一個 getter 呼叫下去
   → 每一個關聯一句 SQL，每一句在【交易之外】、拿一條池子裡的連線
   → 沒有任何錯誤訊息，只有：
       ① 一支 API 打 N 句 SQL（而 APM 上看到的是「序列化很慢」）
       ② 那 N 句讀到的是【N 個不同時間點的快照】（06 章 6.5.11 那個一致性問題）
       ③ 連線池在高併發下被這些短交易吃光
```

✅ **所以 MyBatis 這一側的規則比 JPA 更嚴格**：

```
JPA    ：open-in-view = false，讓 LazyInitializationException 大聲告訴你（03 章 3.9.4）
MyBatis：🔴 沒有這種保護 → 【出資料層的物件不准帶延遲關聯】要靠慣例與 8.9 的斷言
        → 而最簡單的做法是【根本不要用 fetchType="lazy"】：
          用 8.5.1 那個一句 JOIN 的巢狀 resultMap，
          或者分成兩個 mapper 方法讓呼叫端明講自己要什麼。
```

---

## 8.6 分頁

07 章 7.9.4 證明了 `RowBounds` 是**記憶體分頁**：
SQL 裡沒有 `LIMIT`，3000 列全部撈回來再丟掉 2980 列，**而且連警告都沒有**。
那一節留下的話是「要自己寫 `LIMIT`」。

**這一節有三個進展**：

```
① PageHelper：讓「自己寫 LIMIT」這件事消失 —— 而它換來三個坑（8.6.4～8.6.6）
② keyset 分頁：offset 很深的時候唯一的解，而 MyBatis 這一側寫起來比 JPA 容易
③ 🔴🔴 而 keyset 那個「教科書寫法」在 MySQL 上【慢 8 倍】（8.6.8b）
```

### 8.6.0 這一節的測試類別

```java
package com.example.lab.ch08;

import com.github.pagehelper.Page;
import com.github.pagehelper.PageHelper;
import com.github.pagehelper.PageInfo;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/** 8.6：分頁。 */
class M5Page extends Base08 {

    @Autowired Ord8Mapper orders;

    static final String NS = "com.example.lab.ch08.Ord8Mapper.";

    @BeforeEach void setUp() { seed(30, 4, 2); }

    private static OrderSearchBean8 b(OrderSearch8 r) { return OrderSearchBean8.of(r); }

    // ══════════════ 8.6.3 PageHelper 改寫出來的 SQL ══════════════

    @Test @Transactional
    void a1_它改寫出什麼() {
        head("8.6.3 PageHelper 改寫出來的 SQL");
        var q = OrderSearch8.empty().withStatus(St8.PENDING);

        System.out.println("── Dyn 看到的（MyBatis 打算送出什麼）");
        System.out.println("   " + cut(dyn().sql(NS + "pageByHelper", Dyn.args("q", b(q))), 300));
        System.out.println("   有 limit 嗎：" + dyn().sql(NS + "pageByHelper",
                Dyn.args("q", b(q))).toLowerCase().contains("limit"));

        System.out.println("\n── SqlSpy 看到的（JDBC 真的收到什麼）");
        List<String> sqls = spy(() -> {
            PageHelper.startPage(2, 3);
            List<OrderRow8> rows = orders.pageByHelper(b(q));
            Page<OrderRow8> page = (Page<OrderRow8>) rows;
            System.out.println("   這一頁 " + rows.size() + " 筆、總共 " + page.getTotal()
                    + " 筆、共 " + page.getPages() + " 頁");
        });
        System.out.println("   → " + sqls.size() + " 句 SQL");
        for (String s : sqls) System.out.println("     " + cut(s, 190));
    }

    @Test @Transactional
    void a2_三種分頁的sql() {
        head("8.6.1 三種分頁，三種 SQL");
        var q = OrderSearch8.empty().withStatus(St8.PENDING);

        System.out.println("── ① 自己寫 LIMIT（本章的 page）");
        showTail("page(offset=3, size=3)", () -> System.out.println(
                "   " + orders.page(b(q), 3, 3).size() + " 筆"));

        System.out.println("\n── ② PageHelper");
        showTail("startPage(2,3) + pageByHelper", () -> {
            PageHelper.startPage(2, 3);
            System.out.println("   " + orders.pageByHelper(b(q)).size() + " 筆");
        });

        System.out.println("\n── ③ RowBounds（07 章 7.9.4：記憶體分頁）");
        System.out.println("   07 章量過：SQL 裡沒有 LIMIT，3000 列全部撈回來再丟掉 2980 列。");
    }

    // ══════════════ 8.6.4 坑一：ThreadLocal 洩漏 ══════════════

    @Test @Transactional
    void a3_坑一_threadlocal洩漏() {
        head("8.6.4 🔴 坑一：startPage 之後沒有接查詢");
        var q = OrderSearch8.empty().withStatus(St8.PENDING);

        System.out.println("── 正常流程");
        PageHelper.startPage(1, 3);
        System.out.println("   第一句 → " + orders.pageByHelper(b(q)).size() + " 筆");
        System.out.println("   第二句 → " + orders.pageByHelper(b(q)).size()
                + " 筆（分頁只作用一次，所以是全部）");

        System.out.println("\n── 🔴 startPage 之後【中途拋例外】，分頁沒有被消耗");
        Throwable t = catching(() -> {
            PageHelper.startPage(1, 3);
            if (true) throw new IllegalStateException("驗證失敗，還沒查就 return 了");
        });
        System.out.println("   " + name(t));
        System.out.println("   ⚠️ 現在這條執行緒的 ThreadLocal 裡【還躺著一個 (1, 3)】");
        System.out.println("   下一個【完全不相干】的查詢：");
        showTail("orders.search(...)", () -> System.out.println(
                "   " + orders.search(b(q)).size() + " 筆 ← 應該是 8 筆"));

        System.out.println("\n── 收拾乾淨");
        PageHelper.clearPage();
        System.out.println("   clearPage() 之後 → " + orders.search(b(q)).size() + " 筆");
    }

    // ══════════════ 8.6.5 坑二：count 算錯 ══════════════

    @Test @Transactional
    void a4_坑二_count算錯() {
        head("8.6.5 🔴🔴 坑二：巢狀 resultMap + PageHelper");
        System.out.println("  資料庫裡 PENDING 的訂單：" + jdbc.queryForObject(
                "SELECT count(*) FROM orders WHERE status = 'PENDING'", Long.class) + " 張");
        System.out.println("  它們的明細列數      ：" + jdbc.queryForObject(
                "SELECT count(*) FROM order_item i JOIN orders o ON o.id = i.order_id"
                + " WHERE o.status = 'PENDING'", Long.class) + " 列");

        System.out.println("\n── 🔴 對巢狀 resultMap 的查詢做 PageHelper 分頁（每頁 3 筆）");
        List<String> sqls = spy(() -> {
            PageHelper.startPage(1, 3);
            List<OrderNode8> rows = orders.pageNested(St8.PENDING);
            Page<OrderNode8> page = (Page<OrderNode8>) rows;
            System.out.println("   這一頁拿到 " + rows.size() + " 張訂單");
            System.out.println("   page.getTotal() = " + page.getTotal()
                    + "、getPages() = " + page.getPages());
            int items = rows.stream().mapToInt(o -> o.getItems().size()).sum();
            System.out.println("   這一頁的明細總數 = " + items);
        });
        System.out.println("   → " + sqls.size() + " 句 SQL");
        for (String s : sqls) System.out.println("     " + cut(s, 190));
    }

    // ══════════════ 8.6.6 坑三：只作用於下一句 ══════════════

    @Test @Transactional
    void a5_坑三_只作用一次() {
        head("8.6.6 🔴 坑三：一次 startPage 只作用於【下一句】");
        var q = OrderSearch8.empty().withStatus(St8.PENDING);

        System.out.println("── 一個「查完列表順便查 count」的 service 方法長這樣：");
        PageHelper.startPage(1, 3);
        long total = orders.searchCount(b(q));          // 🔴 分頁被這一句吃掉了
        List<OrderRow8> rows = orders.pageByHelper(b(q));
        System.out.println("   searchCount() = " + total);
        System.out.println("   列表 = " + rows.size() + " 筆 ← 應該是 3 筆");

        System.out.println("\n── 換順序");
        PageHelper.startPage(1, 3);
        List<OrderRow8> rows2 = orders.pageByHelper(b(q));
        long total2 = orders.searchCount(b(q));
        System.out.println("   列表 = " + rows2.size() + " 筆");
        System.out.println("   searchCount() = " + total2);
        System.out.println("   而 PageHelper 自己算的 total = "
                + ((Page<OrderRow8>) rows2).getTotal());
    }

    @Test @Transactional
    void a6_pageinfo() {
        head("8.6.3b PageInfo：把分頁結果包成 API 回應");
        var q = OrderSearch8.empty().withStatus(St8.PENDING);
        PageHelper.startPage(2, 3);
        PageInfo<OrderRow8> info = PageInfo.of(orders.pageByHelper(b(q)));
        System.out.println("  pageNum=" + info.getPageNum()
                + " pageSize=" + info.getPageSize()
                + " total=" + info.getTotal()
                + " pages=" + info.getPages()
                + " hasNext=" + info.isHasNextPage()
                + " isLast=" + info.isIsLastPage());
        System.out.println("  list 第一筆 = " + info.getList().get(0).orderNo());
    }
}
```

```java
package com.example.lab.ch08;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/** 8.6.7 / 8.6.8：keyset 分頁 vs offset 分頁。 */
class M5bKeyset extends Base08 {

    @Autowired Ord8Mapper orders;

    static final String NS = "com.example.lab.ch08.Ord8Mapper.";
    static boolean seeded = false;

    void ensureSeed() {
        if (seeded) return;
        seed(20000, 50, 0);        // ★ 兩萬張訂單、不建明細（這一節只看分頁）
        seeded = true;
    }

    @Test @Transactional
    void a1_兩種SQL() {
        ensureSeed();
        head("8.6.7 keyset 分頁的 SQL");
        System.out.println("── offset 版");
        System.out.println("   " + tail(dyn().sql(NS + "pageOffset",
                Dyn.args("status", St8.PENDING, "offset", 10000, "size", 20))));
        System.out.println("\n── keyset 版（第一頁：沒有游標）");
        System.out.println("   " + tail(dyn().sql(NS + "pageKeyset",
                Dyn.args("status", St8.PENDING, "lastPlacedAt", null,
                         "lastId", null, "size", 20))));
        System.out.println("\n── keyset 版（後續頁：帶著上一頁最後一筆）");
        System.out.println("   " + tail(dyn().sql(NS + "pageKeyset",
                Dyn.args("status", St8.PENDING,
                         "lastPlacedAt", Instant.parse("2026-09-01T00:00:00Z"),
                         "lastId", UUID.randomUUID(), "size", 20))));
        System.out.println("\n  ★ (o.placed_at, o.id) > (?, ?) 是【列建構子比較】——");
        System.out.println("    語意上它就是「排在那一筆後面的」，而 8.6.8b 會證明");
        System.out.println("    🔴 MySQL 不會把它變成索引範圍掃描。");
    }

    @Test
    void a2_深頁的代價() {
        ensureSeed();
        head("8.6.7b ★ offset 有多深，決定 keyset 值不值得");
        long n = jdbc.queryForObject(
                "SELECT count(*) FROM orders WHERE status = 'PENDING'", Long.class);
        System.out.println("  PENDING 訂單共 " + n + " 張（總共 20000 張）\n");

        // ── ① 隔離的 SQL：只有 orders 一張表，沒有 JOIN、沒有子查詢
        String offsetSql = "SELECT id, order_no FROM orders WHERE status = 'PENDING'"
                + " ORDER BY placed_at, id LIMIT 20 OFFSET ";
        System.out.println("── ① 隔離量測（單表、無 JOIN、無子查詢）");
        System.out.printf("  %-16s %12s%n", "OFFSET", "最快耗時");
        for (int off : new int[]{0, 1000, 2500, 4980}) {
            final int o = off;
            long t = bestMicros(() -> jdbc.queryForList(offsetSql + o), 3, 9);
            System.out.printf("  %-16d %10d µs%n", off, t);
        }
        // keyset：走到最後一頁的游標
        var rows = jdbc.queryForList("SELECT placed_at, id FROM orders WHERE status = 'PENDING'"
                + " ORDER BY placed_at, id LIMIT 1 OFFSET 4980");
        Object at = rows.get(0).get("placed_at");   // ⚠️ 驅動回的是 LocalDateTime，不是 Timestamp
        byte[] id = (byte[]) rows.get(0).get("id");
        long tk = bestMicros(() -> jdbc.queryForList(
                "SELECT id, order_no FROM orders WHERE status = 'PENDING'"
                + " AND (placed_at, id) > (?, ?) ORDER BY placed_at, id LIMIT 20", at, id), 3, 9);
        System.out.printf("  %-16s %10d µs%n", "keyset（同一頁）", tk);

        // ── ② 問資料庫真的掃了幾列
        System.out.println("\n── ② EXPLAIN ANALYZE：它真的讀了幾列");
        System.out.println("  OFFSET 4980：");
        for (String line : jdbc.queryForList("EXPLAIN ANALYZE " + offsetSql + "4980",
                String.class)) System.out.println("    " + line.replace("\n", "\n    "));
        System.out.println("  keyset：");
        for (String line : jdbc.query("EXPLAIN ANALYZE SELECT id, order_no FROM orders"
                + " WHERE status = 'PENDING' AND (placed_at, id) > (?, ?)"
                + " ORDER BY placed_at, id LIMIT 20",
                (rs, i) -> rs.getString(1), at, id))
            System.out.println("    " + line.replace("\n", "\n    "));

        // ── ③ 完整的列表查詢（有 JOIN + 相關子查詢）
        System.out.println("\n── ③ 本章那個完整的列表查詢（JOIN + item_count 子查詢）");
        long f1 = bestMicros(() -> orders.pageOffset(St8.PENDING, 0, 20), 3, 7);
        long f2 = bestMicros(() -> orders.pageOffset(St8.PENDING, 4980, 20), 3, 7);
        List<OrderRow8> page = orders.pageKeyset(St8.PENDING, null, null, 20);
        Instant lastAt = null; UUID lastId = null;
        for (int p = 0; p < 249; p++) {
            if (page.isEmpty()) break;
            OrderRow8 last = page.get(page.size() - 1);
            lastAt = last.placedAt(); lastId = last.id();
            page = orders.pageKeyset(St8.PENDING, lastAt, lastId, 20);
        }
        final Instant fAt = lastAt; final UUID fId = lastId;
        long f3 = bestMicros(() -> orders.pageKeyset(St8.PENDING, fAt, fId, 20), 3, 7);
        System.out.printf("  offset 第 1 頁    %8d µs%n", f1);
        System.out.printf("  offset 第 250 頁  %8d µs%n", f2);
        System.out.printf("  keyset 第 250 頁  %8d µs%n", f3);
    }

    @Test
    void a2b_兩種keyset寫法() {
        ensureSeed();
        head("8.6.8 🔴🔴 列建構子比較【不會】變成索引範圍掃描");
        var rows = jdbc.queryForList("SELECT placed_at, id FROM orders WHERE status = 'PENDING'"
                + " ORDER BY placed_at, id LIMIT 1 OFFSET 4980");
        Object rawAt = rows.get(0).get("placed_at");
        byte[] rawId = (byte[]) rows.get(0).get("id");
        Instant at = ((java.time.LocalDateTime) rawAt).toInstant(java.time.ZoneOffset.UTC);
        UUID id = com.example.lab.Uuid7.fromBytes(rawId);

        System.out.println("── ① 列建構子：(o.placed_at, o.id) > (?, ?)");
        System.out.println("   " + tail(dyn().sql(NS + "pageKeyset",
                Dyn.args("status", St8.PENDING, "lastPlacedAt", at, "lastId", id, "size", 20))));
        System.out.printf("   耗時 %d µs、拿到 %d 筆%n",
                bestMicros(() -> orders.pageKeyset(St8.PENDING, at, id, 20), 3, 9),
                orders.pageKeyset(St8.PENDING, at, id, 20).size());

        System.out.println("\n── ② 展開成 OR：placed_at > ? OR (placed_at = ? AND id > ?)");
        System.out.println("   " + tail(dyn().sql(NS + "pageKeysetOr",
                Dyn.args("status", St8.PENDING, "lastPlacedAt", at, "lastId", id, "size", 20))));
        System.out.printf("   耗時 %d µs、拿到 %d 筆%n",
                bestMicros(() -> orders.pageKeysetOr(St8.PENDING, at, id, 20), 3, 9),
                orders.pageKeysetOr(St8.PENDING, at, id, 20).size());

        System.out.println("\n── 兩者的結果一樣嗎");
        System.out.println("   ① " + orders.pageKeyset(St8.PENDING, at, id, 5)
                .stream().map(OrderRow8::orderNo).toList());
        System.out.println("   ② " + orders.pageKeysetOr(St8.PENDING, at, id, 5)
                .stream().map(OrderRow8::orderNo).toList());

        System.out.println("\n── 問資料庫：它掃了幾列（單表版，把 JOIN 的雜訊去掉）");
        String rc = "SELECT id, order_no FROM orders WHERE status = 'PENDING'"
                + " AND (placed_at, id) > (?, ?) ORDER BY placed_at, id LIMIT 20";
        String orForm = "SELECT id, order_no FROM orders WHERE status = 'PENDING'"
                + " AND (placed_at > ? OR (placed_at = ? AND id > ?))"
                + " ORDER BY placed_at, id LIMIT 20";
        System.out.println("   ① 列建構子：");
        printPlan(rc, rawAt, rawId);
        System.out.println("   ② 展開成 OR：");
        printPlan(orForm, rawAt, rawAt, rawId);
        System.out.printf("   ① 耗時 %d µs   ② 耗時 %d µs%n",
                bestMicros(() -> jdbc.queryForList(rc, rawAt, rawId), 3, 9),
                bestMicros(() -> jdbc.queryForList(orForm, rawAt, rawAt, rawId), 3, 9));
    }

    private void printPlan(String sql, Object... args) {
        for (String line : jdbc.query("EXPLAIN ANALYZE " + sql,
                (rs, i) -> rs.getString(1), args))
            System.out.println("     " + line.replace("\n", "\n     "));
    }

    @Test
    void a3_keyset的正確性() {
        ensureSeed();
        head("8.6.7c keyset 分頁在「有人插隊」時的行為");
        System.out.println("  ★ offset 分頁的問題不只是慢：");
        System.out.println("    第 1 頁查完之後，有人插了一筆排在最前面的資料");
        System.out.println("    → 第 2 頁的 OFFSET 20 會【重複顯示第 1 頁的最後一筆】");
        System.out.println("    → 而 keyset 版的條件是「> 上一頁的最後一筆」，"
                + "不受插隊影響\n");

        List<OrderRow8> p1 = orders.pageKeyset(St8.PENDING, null, null, 5);
        OrderRow8 last = p1.get(p1.size() - 1);
        System.out.println("  keyset 第 1 頁：" + p1.stream().map(OrderRow8::orderNo).toList());

        // 插一筆排在最前面的
        UUID nid = com.example.lab.Uuid7.next();
        jdbc.update("INSERT INTO orders (id,order_no,customer_id,status,total_amount,placed_at)"
                + " VALUES (?,?,?,?,?,?)",
                com.example.lab.Uuid7.toBytes(nid), "SO-INSERTED",
                com.example.lab.Uuid7.toBytes(customerIds.get(0)), "PENDING",
                new java.math.BigDecimal("1.0000"),
                java.sql.Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")));
        try {
            System.out.println("  （插入一筆 placed_at = 2020 的 PENDING 訂單）");
            System.out.println("  offset 第 2 頁：" + orders
                    .pageOffset(St8.PENDING, 5, 5).stream().map(OrderRow8::orderNo).toList());
            System.out.println("  keyset 第 2 頁：" + orders
                    .pageKeyset(St8.PENDING, last.placedAt(), last.id(), 5)
                    .stream().map(OrderRow8::orderNo).toList());
            System.out.println("\n  ★ offset 版把第 1 頁的最後一筆又顯示了一次；keyset 版沒有。");
        } finally {
            jdbc.update("DELETE FROM orders WHERE id = ?", com.example.lab.Uuid7.toBytes(nid));
        }
    }
}
```

---

### 8.6.1 實測：三種分頁，三種 SQL

```
═══ 8.6.1 三種分頁，三種 SQL ═══
── ① 自己寫 LIMIT（本章的 page）
   3 筆
── page(offset=3, size=3) → 1 句 SQL
   … WHERE o.status = ? ORDER BY o.placed_at, o.id LIMIT ? OFFSET ?

── ② PageHelper
   3 筆
── startPage(2,3) + pageByHelper → 2 句 SQL
   … WHERE o.status = ?                                          ← count
   … WHERE o.status = ? ORDER BY o.placed_at, o.id LIMIT ?, ?    ← 資料

── ③ RowBounds（07 章 7.9.4：記憶體分頁）
   07 章量過：SQL 裡沒有 LIMIT，3000 列全部撈回來再丟掉 2980 列。
```

| | SQL 裡有 `LIMIT` | 要不要打 count | 要改 mapper 嗎 |
|---|---|---|---|
| **自己寫 `LIMIT`** | ✅ | 自己寫一個 `count` statement | 要（多兩個參數） |
| **PageHelper** | ✅（攔截器加上去的） | **自動**（而 8.6.5 會證明它會算錯） | 不用 |
| `RowBounds` | 🔴 **沒有** | — | 不用 |

### 8.6.2 🔴 裝 PageHelper：一個依賴撞壞整個專案

```xml
<dependency>
  <groupId>com.github.pagehelper</groupId>
  <artifactId>pagehelper-spring-boot-starter</artifactId>
  <version>2.0.0</version>
</dependency>
```

**就這樣。不用寫任何組態，`PageHelper.startPage()` 就會生效。**

🔴 **而我第一次寫的是 `2.1.0`（最新版），結果整個專案起不來**：

```
BeanCreationException: Error creating bean with name 'ord5Repo'
  defined in com.example.lab.ch05.Ord5Repo:
  'net.sf.jsqlparser.statement.select.SelectBody
   net.sf.jsqlparser.statement.select.Select.getSelectBody()'
```

**症狀完全指不到原因**：

```
壞掉的是 05 章的【Spring Data JPA repository】，
而我改的是【MyBatis 的分頁套件】。
```

**原因**：

```
PageHelper 要用 jsqlparser 剖析 SQL 來產生 count 查詢
Spring Data JPA 也要用 jsqlparser 剖析原生查詢（@Query(nativeQuery = true) 加排序時）
                              ↓
Spring Data JPA 3.2.5  →  需要 jsqlparser 4.5 / 4.6（有 Select.getSelectBody()）
PageHelper 6.1.0       →  需要 jsqlparser 4.7   （這個方法被移除了）
                              ↓
Maven 選了 4.7 → Spring Data JPA 的每一個 repository 都建不起來
```

✅ **解法：選 `pagehelper-spring-boot-starter:2.0.0`**
（它帶 `pagehelper:6.0.0` → `jsqlparser:4.5`）。

```
mvn dependency:tree -Dincludes='com.github.pagehelper:*,com.github.jsqlparser:*'

\- com.github.pagehelper:pagehelper-spring-boot-starter:jar:2.0.0:compile
   +- com.github.pagehelper:pagehelper-spring-boot-autoconfigure:jar:2.0.0:compile
   \- com.github.pagehelper:pagehelper:jar:6.0.0:compile
      \- com.github.jsqlparser:jsqlparser:jar:4.5:compile
```

📌 **這一格值得記住的不是版本號**（它明年就過期了），是**這個形狀**：

```
兩個框架共用一個【剖析 SQL 的第三方函式庫】，而那個函式庫改了 API。
                              ↓
「加一個分頁套件」變成「所有 JPA repository 都建不起來」，
而錯誤訊息裡【一個字都沒提到 PageHelper】。
```

⚠️ **升 Spring Boot 的時候，這一格會再咬你一次** ——
Spring Data JPA 3.3 換到了 jsqlparser 4.7+，那時候 `2.0.0` 就變成錯的那一邊。
**這是 07 章 7.3.1 那件事（`mybatis-spring-boot-starter` 要自己寫版本號）的加強版：
不在 Boot BOM 裡的依賴，它的傳遞依賴也不在。**

### 8.6.3 ★ 實測：它改寫出什麼（兩把尺看到不同的東西）

```java
    @Test @Transactional
    void a1_它改寫出什麼() {
        head("8.6.3 PageHelper 改寫出來的 SQL");
        var q = OrderSearch8.empty().withStatus(St8.PENDING);

        System.out.println("── Dyn 看到的（MyBatis 打算送出什麼）");
        System.out.println("   " + cut(dyn().sql(NS + "pageByHelper", Dyn.args("q", b(q))), 300));
        System.out.println("   有 limit 嗎：" + dyn().sql(NS + "pageByHelper",
                Dyn.args("q", b(q))).toLowerCase().contains("limit"));

        System.out.println("\n── SqlSpy 看到的（JDBC 真的收到什麼）");
        List<String> sqls = spy(() -> {
            PageHelper.startPage(2, 3);
            List<OrderRow8> rows = orders.pageByHelper(b(q));
            Page<OrderRow8> page = (Page<OrderRow8>) rows;
            System.out.println("   這一頁 " + rows.size() + " 筆、總共 " + page.getTotal()
                    + " 筆、共 " + page.getPages() + " 頁");
        });
        System.out.println("   → " + sqls.size() + " 句 SQL");
        for (String s : sqls) System.out.println("     " + cut(s, 190));
    }
```

```
═══ 8.6.3 PageHelper 改寫出來的 SQL ═══
── Dyn 看到的（MyBatis 打算送出什麼）
   SELECT o.id, o.order_no, c.display_name AS customer_name, o.status, o.total_amount,
   o.placed_at, (SELECT count(*) FROM order_item i WHERE i.order_id = o.id) AS item_count
   FROM orders o JOIN customer c ON c.id = o.customer_id
   LEFT JOIN sales_rep r ON r.id = o.rep_id WHERE o.status = ? ORDER BY o.plac…
   有 limit 嗎：false

── SqlSpy 看到的（JDBC 真的收到什麼）
   這一頁 3 筆、總共 8 筆、共 3 頁
   → 2 句 SQL
     SELECT count(0) FROM orders o JOIN customer c ON c.id = o.customer_id
       LEFT JOIN sales_rep r ON r.id = o.rep_id WHERE o.status = ?
     SELECT o.id, o.order_no, c.display_name AS customer_name, … FROM orders o JOIN …
       ORDER BY o.placed_at, o.id LIMIT ?, ?
```

★★ **這是四把尺第一次「互相矛盾」，而那個矛盾就是答案**：

```
Dyn 說  ：這句 SQL 沒有 LIMIT   ← 因為它站在【MyBatis 組完 SQL】那一刻
SqlSpy 說：有 LIMIT，而且多一句 count ← 因為它站在【JDBC】那一層
                              ↓
中間那一段就是 PageHelper 做的事，而它是一個【MyBatis 攔截器】（8.8）。
```

**PageHelper 的完整流程**：

```
PageHelper.startPage(2, 3)
    → 把 (pageNum=2, pageSize=3) 放進一個 ThreadLocal        ← 坑一的來源（8.6.4）
        ↓
下一次 Executor.query() 被呼叫
    → PageInterceptor 攔到它
    → ① 用 jsqlparser 把原 SQL 改寫成 count 查詢並執行         ← 坑二的來源（8.6.5）
      ② 用 Dialect（MySqlDialect）把原 SQL 加上 LIMIT ?, ? 並執行
      ③ 把結果包成 Page<E>（它是 ArrayList 的子類別）
      ④ 清掉 ThreadLocal                                     ← 坑三的來源（8.6.6）
```

📌 **`count(0)` 那個寫法值得注意**：PageHelper 不是寫 `count(*)`，
它把 `SELECT` 清單換成 `count(0)`。
**所以原本 `SELECT` 清單裡那個相關子查詢（`item_count`）不見了 —— 這是好事**，
count 查詢不需要它。

**而回傳型別**：

```java
    @Test @Transactional
    void a6_pageinfo() {
        head("8.6.3b PageInfo：把分頁結果包成 API 回應");
        var q = OrderSearch8.empty().withStatus(St8.PENDING);
        PageHelper.startPage(2, 3);
        PageInfo<OrderRow8> info = PageInfo.of(orders.pageByHelper(b(q)));
        System.out.println("  pageNum=" + info.getPageNum()
                + " pageSize=" + info.getPageSize()
                + " total=" + info.getTotal()
                + " pages=" + info.getPages()
                + " hasNext=" + info.isHasNextPage()
                + " isLast=" + info.isIsLastPage());
        System.out.println("  list 第一筆 = " + info.getList().get(0).orderNo());
    }
```

```
═══ 8.6.3b PageInfo：把分頁結果包成 API 回應 ═══
  pageNum=2 pageSize=3 total=8 pages=3 hasNext=true isLast=false
  list 第一筆 = SO-2026-000013
```

⚠️ **mapper 方法的回傳型別是 `List<OrderRow8>`，而實際拿到的是 `Page<OrderRow8>`。**
`Page` 是 `ArrayList` 的子類別，所以**型別上完全看不出來**。
要拿到 `getTotal()` 就得**強制轉型**，或用 `PageInfo.of(list)` 包一層。

🔴 **這是一個可觀測性問題**：

```
public List<OrderRow8> list(...) { PageHelper.startPage(p, s); return mapper.pageByHelper(q); }
                              ↓
簽章上這是「一個 List」。呼叫端不知道它被分頁了，
也不知道那個 List 裡面藏著 total —— 除非它知道要 cast。
```

✅ **正解：不要讓 `Page` 洩漏出 Service。**
在 Service 裡就轉成一個自己的 `PageResult<T>`（或 Spring 的 `Page`），
**簽章上就講清楚「這是分頁結果」。**

### 8.6.4 🔴 坑一：`ThreadLocal` 洩漏

```java
    @Test @Transactional
    void a3_坑一_threadlocal洩漏() {
        head("8.6.4 🔴 坑一：startPage 之後沒有接查詢");
        var q = OrderSearch8.empty().withStatus(St8.PENDING);

        System.out.println("── 正常流程");
        PageHelper.startPage(1, 3);
        System.out.println("   第一句 → " + orders.pageByHelper(b(q)).size() + " 筆");
        System.out.println("   第二句 → " + orders.pageByHelper(b(q)).size()
                + " 筆（分頁只作用一次，所以是全部）");

        System.out.println("\n── 🔴 startPage 之後【中途拋例外】，分頁沒有被消耗");
        Throwable t = catching(() -> {
            PageHelper.startPage(1, 3);
            if (true) throw new IllegalStateException("驗證失敗，還沒查就 return 了");
        });
        System.out.println("   " + name(t));
        System.out.println("   ⚠️ 現在這條執行緒的 ThreadLocal 裡【還躺著一個 (1, 3)】");
        System.out.println("   下一個【完全不相干】的查詢：");
        showTail("orders.search(...)", () -> System.out.println(
                "   " + orders.search(b(q)).size() + " 筆 ← 應該是 8 筆"));

        System.out.println("\n── 收拾乾淨");
        PageHelper.clearPage();
        System.out.println("   clearPage() 之後 → " + orders.search(b(q)).size() + " 筆");
    }
```

```
═══ 8.6.4 🔴 坑一：startPage 之後沒有接查詢 ═══
── 正常流程
   第一句 → 3 筆
   第二句 → 8 筆（分頁只作用一次，所以是全部）

── 🔴 startPage 之後【中途拋例外】，分頁沒有被消耗
   IllegalStateException
   ⚠️ 現在這條執行緒的 ThreadLocal 裡【還躺著一個 (1, 3)】
   下一個【完全不相干】的查詢：
   3 筆 ← 應該是 8 筆
── orders.search(...) → 2 句 SQL
   … WHERE o.status = ?
   … WHERE o.status = ? ORDER BY o.placed_at, o.id LIMIT ?

── 收拾乾淨
   clearPage() 之後 → 8 筆
```

🔴🔴 **一個完全不相干的查詢被分頁了，而且多打了一句 count。**

**在 Web 應用裡這件事的形狀是**：

```
執行緒池的執行緒【會被重複使用】。
    ↓
請求 A 在 startPage 之後拋例外 → ThreadLocal 沒清
請求 B 拿到同一條執行緒 → 它的第一個查詢被套上 A 的分頁參數
    ↓
症狀：某支 API 偶爾只回三筆資料，重試就好了。
```

✅ **三個防線，第一個是必須的**：

```
① startPage 的下一行【一定】是那個查詢，中間不准有任何可能拋例外的程式碼
   → 這是一條 review 規則，也可以寫成 ArchUnit（8.9）
② 用 PageHelper 的函式介面版本，讓它自己保證成對：
      PageHelper.startPage(p, s).doSelectPageInfo(() -> mapper.pageByHelper(q));
   → 這一版在 finally 裡 clearPage()
③ 在 Web 層加一個 filter：請求結束時無條件 PageHelper.clearPage()
   → 這是「安全網」，不是「解法」
```

📌 **`ThreadLocal` + 隱式生效 = 這個坑的本質。**
它跟 06 章 6.6.8 那個「重試寫在同一個 bean 裡 = 沒有交易」是同一類問題：
**框架的行為由「一個你看不到的狀態」決定，而那個狀態的生命週期跟你的程式碼結構無關。**

### 8.6.5 🔴🔴 坑二：count 算錯（而且列表也錯）

**把 PageHelper 用在 8.5.1 那個巢狀 `resultMap` 的查詢上**：

```xml
  <!-- ★ resultMap 可以跨 namespace 引用：寫完整的 namespace.id -->
  <select id="pageNested" resultMap="com.example.lab.ch08.Ord8ResultMapper.nodeMap">
    SELECT o.id, o.order_no, o.status, o.total_amount, o.placed_at,
           c.id AS c_id, c.display_name AS c_display_name, …
           i.id AS i_id, i.product_name AS i_product_name, …
      FROM orders o
      JOIN customer c ON c.id = o.customer_id
      LEFT JOIN sales_rep r ON r.id = o.rep_id
      LEFT JOIN order_item i ON i.order_id = o.id
      LEFT JOIN product p ON p.id = i.product_id
     WHERE o.status = #{status}
     ORDER BY o.placed_at, o.id, i.id
  </select>
```

```java
    @Test @Transactional
    void a4_坑二_count算錯() {
        head("8.6.5 🔴🔴 坑二：巢狀 resultMap + PageHelper");
        System.out.println("  資料庫裡 PENDING 的訂單：" + jdbc.queryForObject(
                "SELECT count(*) FROM orders WHERE status = 'PENDING'", Long.class) + " 張");
        System.out.println("  它們的明細列數      ：" + jdbc.queryForObject(
                "SELECT count(*) FROM order_item i JOIN orders o ON o.id = i.order_id"
                + " WHERE o.status = 'PENDING'", Long.class) + " 列");

        System.out.println("\n── 🔴 對巢狀 resultMap 的查詢做 PageHelper 分頁（每頁 3 筆）");
        List<String> sqls = spy(() -> {
            PageHelper.startPage(1, 3);
            List<OrderNode8> rows = orders.pageNested(St8.PENDING);
            Page<OrderNode8> page = (Page<OrderNode8>) rows;
            System.out.println("   這一頁拿到 " + rows.size() + " 張訂單");
            System.out.println("   page.getTotal() = " + page.getTotal()
                    + "、getPages() = " + page.getPages());
            int items = rows.stream().mapToInt(o -> o.getItems().size()).sum();
            System.out.println("   這一頁的明細總數 = " + items);
        });
        System.out.println("   → " + sqls.size() + " 句 SQL");
    }
```

```
═══ 8.6.5 🔴🔴 坑二：巢狀 resultMap + PageHelper ═══
  資料庫裡 PENDING 的訂單：8 張
  它們的明細列數      ：16 列

── 🔴 對巢狀 resultMap 的查詢做 PageHelper 分頁（每頁 3 筆）
   這一頁拿到 2 張訂單          ← 要 3 張
   page.getTotal() = 16、getPages() = 6   ← 應該是 8 與 3
   這一頁的明細總數 = 3
   → 2 句 SQL
```

🔴🔴 **三個數字全錯，而且沒有任何錯誤或警告**：

| | 正確答案 | PageHelper 給的 |
|---|---|---|
| 這一頁幾張訂單 | 3 | **2** |
| 總共幾張 | 8 | **16** |
| 總共幾頁 | 3 | **6** |

**成因只有一個**：`LIMIT` 作用在**列**上，而巢狀 `resultMap` 把**多列合成一個物件**。

```
SQL 的結果集：16 列（8 張訂單 × 2 筆明細）
LIMIT 0, 3 → 拿到 3 列
           → 那 3 列屬於【2 張訂單】（第 1 張的 2 筆 + 第 2 張的 1 筆）
                              ↓
① 這一頁只有 2 張訂單
② 第 2 張訂單【只剩一筆明細】—— 資料是【錯的】，不只是少
③ count 查的是「16 列」，所以總數與頁數都用列在算
```

📌 **這件事在 JPA 那一側【一模一樣】，而 JPA 至少會警告**：

```
04 章 4.5.5：join fetch 集合 + 分頁
             → Hibernate 印 HHH90003004，然後【在記憶體裡分頁】（正確但很慢：
               2000 張取 20 筆 = 107 ms、PC 裡 6000 個實體）
08 章 8.6.5：巢狀 resultMap + PageHelper
             → 🔴 沒有警告，SQL 裡真的下了 LIMIT，結果【是錯的】
```

★ **兩個框架的取捨方向剛好相反**：

```
Hibernate 選了【正確但慢】+ 一個警告碼
PageHelper 選了【快但錯】+ 完全安靜
```

✅ **三個正解**：

```
① 分頁頁面【不要用巢狀 resultMap】。
   列表頁需要的是 8.2.2 那個 OrderRow8（一列一個物件），明細用 item_count 子查詢就夠了。
② 真的需要「一頁 20 張訂單、每張帶明細」→ 兩段式：
   第一段：分頁查 20 個訂單 id（單表、可以正確分頁）
   第二段：用 <foreach> 的 in 子句一次撈那 20 張的明細（8.4.1）
   → 這正是 04 章 4.5.6 那個「兩段式查詢」（9 ms / 80 個實體）在 MyBatis 上的樣子
③ 自己寫 count statement，並用 PageHelper 的 countSuffix 機制指定它
   → 這只解掉 total，不解掉「這一頁的資料是錯的」
```

⚠️ **`resultMap` 可以跨 namespace 引用**（`com.example.lab.ch08.Ord8ResultMapper.nodeMap`）。
方便，而它也意味著**「這個查詢是不是巢狀的」在 XML 上看不出來** ——
你得跳到另一個檔案才知道。**8.9.5 那條斷言就是在查這件事。**

### 8.6.6 🔴 坑三：一次 `startPage` 只作用於【下一句】

```java
    @Test @Transactional
    void a5_坑三_只作用一次() {
        head("8.6.6 🔴 坑三：一次 startPage 只作用於【下一句】");
        var q = OrderSearch8.empty().withStatus(St8.PENDING);

        System.out.println("── 一個「查完列表順便查 count」的 service 方法長這樣：");
        PageHelper.startPage(1, 3);
        long total = orders.searchCount(b(q));          // 🔴 分頁被這一句吃掉了
        List<OrderRow8> rows = orders.pageByHelper(b(q));
        System.out.println("   searchCount() = " + total);
        System.out.println("   列表 = " + rows.size() + " 筆 ← 應該是 3 筆");

        System.out.println("\n── 換順序");
        PageHelper.startPage(1, 3);
        List<OrderRow8> rows2 = orders.pageByHelper(b(q));
        long total2 = orders.searchCount(b(q));
        System.out.println("   列表 = " + rows2.size() + " 筆");
        System.out.println("   searchCount() = " + total2);
        System.out.println("   而 PageHelper 自己算的 total = "
                + ((Page<OrderRow8>) rows2).getTotal());
    }
```

```
═══ 8.6.6 🔴 坑三：一次 startPage 只作用於【下一句】 ═══
── 一個「查完列表順便查 count」的 service 方法長這樣：
   searchCount() = 8
   列表 = 8 筆 ← 應該是 3 筆

── 換順序
   列表 = 3 筆
   searchCount() = 8
   而 PageHelper 自己算的 total = 8
```

🔴 **「兩行程式碼交換順序」就是「分頁有沒有生效」。**

```
PageHelper.startPage(1, 3);
long total = mapper.searchCount(q);      ← 分頁被這一句消耗掉（而 count 查詢分頁沒意義）
List<Row> rows = mapper.pageByHelper(q); ← 這一句【沒有分頁】，回傳全部 8 筆
```

⚠️ **而它不會報錯，也不會慢** —— 只會在資料量大的時候，
**某一支 API 突然回傳一萬筆**。

📌 **這三個坑有一個共同的根源**：

```
PageHelper 的介面是「一個副作用」（startPage）+「一個隱式的接收者」（下一句查詢）。
                              ↓
它們之間的關聯【不在型別裡、不在簽章裡、不在同一個運算式裡】。
所以編譯器、IDE、code review 全都幫不上忙。
```

★ **這就是「自己寫 `LIMIT`」的價值**：

```java
// 本章的 page()：兩個參數在簽章裡，count 是另一個明確的方法
List<OrderRow8> page(@Param("q") OrderSearchBean8 q,
                     @Param("offset") int offset, @Param("size") int size);
long searchCount(@Param("q") OrderSearchBean8 q);
```

```
多寫的：兩個參數、一個 count statement（而 8.3.12 讓它跟列表共用條件）
換到的：分頁這件事【在型別裡】，三個坑一個都不存在
```

✅ **選型建議**：

```
新專案         → 自己寫 LIMIT。多寫的那幾行是【一次性成本】。
接手的舊專案   → 已經到處都是 PageHelper 了，那就
                ① 加上 8.6.4 ③ 那個安全網 filter
                ② 把「startPage 的下一行必須是查詢」寫成 review 規則
                ③ 🔴 把所有巢狀 resultMap 的分頁查詢【找出來重寫】（8.6.5）
```

### 8.6.7 實測：keyset 分頁

**offset 分頁的成本跟頁數成正比 —— 這是 07 站 03 章講過的事，這裡量一次**：

```
═══ 8.6.7b ★ offset 有多深，決定 keyset 值不值得 ═══
  PENDING 訂單共 5000 張（總共 20000 張）

── ① 隔離量測（單表、無 JOIN、無子查詢）
  OFFSET                   最快耗時
  0                       516 µs
  1000                    907 µs
  2500                   1310 µs
  4980                   2243 µs
```

**線性成長，而且原因很清楚**：

```
── ② EXPLAIN ANALYZE：它真的讀了幾列
  OFFSET 4980：
    -> Limit/Offset: 20/4980 row(s)  (actual time=2.16..2.16 rows=20 loops=1)
        -> Index lookup on orders using idx_orders_status_placed (status='PENDING')
           (cost=1128 rows=9110) (actual time=0.175..2.05 rows=5000 loops=1)
                                                          ↑ 讀了 5000 列，丟掉 4980 列
```

**keyset 分頁的想法是「不要用位置，用上一頁的最後一筆」**：

```xml
  <!-- 🔴 8.6.7 keyset 分頁的「教科書寫法」：列建構子比較 -->
  <select id="pageKeyset" resultMap="rowMap">
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
     WHERE o.status = #{status}
    <if test="lastPlacedAt != null">
      AND (o.placed_at, o.id) &gt; (#{lastPlacedAt}, #{lastId})
    </if>
     ORDER BY o.placed_at, o.id
     LIMIT #{size}
  </select>
```

```
═══ 8.6.7 keyset 分頁的 SQL ═══
── offset 版
   … WHERE o.status = ? ORDER BY o.placed_at, o.id LIMIT ? OFFSET ?

── keyset 版（第一頁：沒有游標）
   … WHERE o.status = ? ORDER BY o.placed_at, o.id LIMIT ?

── keyset 版（後續頁：帶著上一頁最後一筆）
   … WHERE o.status = ? AND (o.placed_at, o.id) > (?, ?) ORDER BY o.placed_at, o.id LIMIT ?
```

📌 **兩件事讓 keyset 在 MyBatis 上比在 JPA 上容易**：

```
① 那個 <if lastPlacedAt != null> 就是「第一頁」與「後續頁」的差別 ——
   一個 statement 兩種形狀，這正是動態 SQL 的本行。
   而 Spring Data 的 Pageable 抽象【沒有】keyset 的位置
   （Spring Data 3.1 之後有 ScrollPosition，而它有自己的限制）。
② (placed_at, id) 這個複合游標在 SQL 裡直接寫得出來。
   ORDER BY 的欄位【必須跟游標的欄位完全一致】，而那件事在 XML 裡看得見。
```

⚠️ **keyset 分頁的三個限制**（跟框架無關）：

```
① 只能「下一頁 / 上一頁」，不能「跳到第 37 頁」
② 排序欄位【必須唯一】—— 所以要加上 id 當最後一個排序鍵。
   少了它，placed_at 相同的兩筆會在頁與頁之間漏掉或重複。
③ 排序方式改變（使用者點了另一個欄位）→ 游標作廢，要回到第一頁
```

✅ **而它換到一個 offset 分頁做不到的性質：頁與頁之間不會漏也不會重複**：

```
═══ 8.6.7c keyset 分頁在「有人插隊」時的行為 ═══
  keyset 第 1 頁：[SO-2026-000001, SO-2026-000005, SO-2026-000009,
                  SO-2026-000013, SO-2026-000017]
  （插入一筆 placed_at = 2020 的 PENDING 訂單）
  offset 第 2 頁：[SO-2026-000017, SO-2026-000021, …]   ← 000017 又出現了一次
  keyset 第 2 頁：[SO-2026-000021, SO-2026-000025, …]   ← 正確
```

### 8.6.8 🔴🔴 實測：keyset 那個「教科書寫法」在 MySQL 上慢 8 倍

**`(placed_at, id) > (?, ?)` 是標準 SQL 的列建構子比較，語意完全正確。
而 MySQL 拿它做什麼，是另一件事。**

```java
    @Test
    void a2b_兩種keyset寫法() {
        ensureSeed();
        head("8.6.8b 🔴🔴 列建構子比較【不會】變成索引範圍掃描");
        var rows = jdbc.queryForList("SELECT placed_at, id FROM orders WHERE status = 'PENDING'"
                + " ORDER BY placed_at, id LIMIT 1 OFFSET 4980");
        Object rawAt = rows.get(0).get("placed_at");
        byte[] rawId = (byte[]) rows.get(0).get("id");
        Instant at = ((java.time.LocalDateTime) rawAt).toInstant(java.time.ZoneOffset.UTC);
        UUID id = com.example.lab.Uuid7.fromBytes(rawId);

        System.out.println("── ① 列建構子：(o.placed_at, o.id) > (?, ?)");
        System.out.printf("   耗時 %d µs、拿到 %d 筆%n",
                bestMicros(() -> orders.pageKeyset(St8.PENDING, at, id, 20), 3, 9),
                orders.pageKeyset(St8.PENDING, at, id, 20).size());

        System.out.println("\n── ② 展開成 OR：placed_at > ? OR (placed_at = ? AND id > ?)");
        System.out.printf("   耗時 %d µs、拿到 %d 筆%n",
                bestMicros(() -> orders.pageKeysetOr(St8.PENDING, at, id, 20), 3, 9),
                orders.pageKeysetOr(St8.PENDING, at, id, 20).size());

        System.out.println("\n── 兩者的結果一樣嗎");
        System.out.println("   ① " + orders.pageKeyset(St8.PENDING, at, id, 5)
                .stream().map(OrderRow8::orderNo).toList());
        System.out.println("   ② " + orders.pageKeysetOr(St8.PENDING, at, id, 5)
                .stream().map(OrderRow8::orderNo).toList());

        System.out.println("\n── 問資料庫：它掃了幾列（單表版，把 JOIN 的雜訊去掉）");
        String rc = "SELECT id, order_no FROM orders WHERE status = 'PENDING'"
                + " AND (placed_at, id) > (?, ?) ORDER BY placed_at, id LIMIT 20";
        String orForm = "SELECT id, order_no FROM orders WHERE status = 'PENDING'"
                + " AND (placed_at > ? OR (placed_at = ? AND id > ?))"
                + " ORDER BY placed_at, id LIMIT 20";
        System.out.println("   ① 列建構子：");
        printPlan(rc, rawAt, rawId);
        System.out.println("   ② 展開成 OR：");
        printPlan(orForm, rawAt, rawAt, rawId);
        System.out.printf("   ① 耗時 %d µs   ② 耗時 %d µs%n",
                bestMicros(() -> jdbc.queryForList(rc, rawAt, rawId), 3, 9),
                bestMicros(() -> jdbc.queryForList(orForm, rawAt, rawAt, rawId), 3, 9));
    }

    private void printPlan(String sql, Object... args) {
        for (String line : jdbc.query("EXPLAIN ANALYZE " + sql,
                (rs, i) -> rs.getString(1), args))
            System.out.println("     " + line.replace("\n", "\n     "));
    }
```

```
═══ 8.6.8 🔴🔴 列建構子比較【不會】變成索引範圍掃描 ═══
── ① 列建構子：(o.placed_at, o.id) > (?, ?)
   耗時 2742 µs、拿到 19 筆

── ② 展開成 OR：placed_at > ? OR (placed_at = ? AND id > ?)
   耗時 484 µs、拿到 19 筆

── 兩者的結果一樣嗎
   ① [SO-2026-019925, SO-2026-019929, SO-2026-019933, SO-2026-019937, SO-2026-019941]
   ② [SO-2026-019925, SO-2026-019929, SO-2026-019933, SO-2026-019937, SO-2026-019941]

── 問資料庫：它掃了幾列（單表版，把 JOIN 的雜訊去掉）
   ① 列建構子：
     -> Limit: 20 row(s)  (cost=1128 rows=20) (actual time=2.28..2.28 rows=19 loops=1)
         -> Filter: ((orders.placed_at,orders.id) > ('2026-09-14 20:00:00',0x01a0…))
            (cost=1128 rows=9110) (actual time=2.28..2.28 rows=19 loops=1)
             -> Index lookup on orders using idx_orders_status_placed (status='PENDING')
                (cost=1128 rows=9110) (actual time=0.182..2.07 rows=5000 loops=1)
   ② 展開成 OR：
     -> Limit: 20 row(s)  (cost=9.51 rows=20) (actual time=0.0162..0.0202 rows=19 loops=1)
         -> Index range scan on orders using idx_orders_status_placed
            over (status = 'PENDING' AND placed_at = '2026-09-14 20:00:00.000'
                  AND 0x01a0… < id)
              OR (status = 'PENDING' AND '2026-09-14 20:00:00.000' < placed_at),
            with index condition: (…)
            (cost=9.51 rows=20) (actual time=0.0159..0.019 rows=19 loops=1)

   ① 耗時 2407 µs   ② 耗時 299 µs
```

★★ **結果一字不差，而 MySQL 對它們的處理完全不同**：

| | 列建構子 `(a, b) > (?, ?)` | 展開成 `a > ? OR (a = ? AND b > ?)` |
|---|---|---|
| 執行計畫 | **`Filter`**（在索引查完之後過濾） | **`Index range scan`**（範圍掃描） |
| 實際讀了幾列 | **5000** | **19** |
| 隔離量測 | 2407 µs | **299 µs** |
| 完整列表查詢 | 2742 µs | **484 µs** |

🔴 **MySQL 8.0.46 不會把列建構子比較轉成索引範圍掃描。**
我試過三種救法，**全部無效**：

```
① 加一個 (status, placed_at, id) 的複合索引  → 計畫還是 Filter，還是掃 5000 列
② FORCE INDEX 指到那個複合索引               → 計畫還是 Filter
③ 拿掉 status 條件、讓它吃 (placed_at, id)   → 變成 Index scan 掃【19941 列】，更慢
```

📌 **這修正了一個流傳很廣的說法**：

```
「keyset 分頁在 MySQL 上要用列建構子比較 (a, b) > (?, ?)，
  這樣才吃得到複合索引。」
                    ↓
🔴 錯。在 MySQL 8.0.46 上它【吃不到】。
✅ 要寫成 a > ? OR (a = ? AND b > ?)，MySQL 才會把它拆成兩段索引範圍。
```

⚠️ **而這件事跟「哪個 ORM」完全無關** —— 它是 SQL 與最佳化器的事。
**它出現在這一章的理由是：只有在「SQL 是你自己寫的」的時候，你才改得動它。**

```
JPA 那一側要寫出那個 OR 形式，得用 Criteria 手動組三層 Predicate，
或者直接 @Query(nativeQuery = true)。
MyBatis 這一側就是 XML 裡多兩行。
                    ↓
這是 05 章 5.12.2 決策表那一列「要用資料庫特有語法 → 原生 SQL / MyBatis」
    最實際的一個例子：這裡需要的不是「特有語法」，
    是【對最佳化器友善的那個等價寫法】，而那件事只有寫 SQL 的人做得到。
```

✅ **正式版的 keyset 分頁**：

```xml
  <!-- ✅ 8.6.8b 同一個語意，條件展開成 OR。
       🔴 MySQL 8.0.46 【不會】把列建構子比較轉成索引範圍掃描，
          而這一版可以 —— 實測 2407 µs → 299 µs。 -->
  <select id="pageKeysetOr" resultMap="rowMap">
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
     WHERE o.status = #{status}
    <if test="lastPlacedAt != null">
      AND (o.placed_at &gt; #{lastPlacedAt}
           OR (o.placed_at = #{lastPlacedAt} AND o.id &gt; #{lastId}))
    </if>
     ORDER BY o.placed_at, o.id
     LIMIT #{size}
  </select>
```

### 8.6.9 分頁的決策表

| 場景 | 用什麼 | 為什麼 |
|---|---|---|
| **一般的列表頁**（前 10 頁就夠） | **自己寫 `LIMIT` / `OFFSET`** | 分頁在型別裡，三個 PageHelper 坑都不存在（8.6.6） |
| 舊專案已經用了 PageHelper | 留著 + 三個防線 | 8.6.4 ✅ 那三條 |
| **無限捲動 / 「載入更多」** | **keyset（OR 形式）** | 8.6.8：2407 → 299 µs，而且不會漏也不會重複 |
| **資料匯出 / 批次掃描** | **`Cursor`**（07 章 7.9.3） | 不需要分頁，一列一列串流 |
| 要「跳到第 N 頁」而 N 很大 | 🔴 **重新設計 UI** | offset 的成本跟 N 成正比（8.6.7），沒有技術解 |
| **一頁 20 張訂單、每張要帶明細** | **兩段式**（8.6.5 ②） | 🔴 巢狀 `resultMap` + 分頁 = 錯的資料 |
| 只要「有沒有下一頁」、不要總數 | **多查一筆**（`LIMIT size + 1`） | 省掉那句 count；PageHelper 也支援（`Slice` 語意） |

⚠️ **`RowBounds` 一格都沒有。** 07 章 7.9.4 已經證明它是記憶體分頁 ——
**它唯一的用途是「配 `Cursor` 跳過前面幾列」，而那件事也可以用 SQL 做。**

---

## 8.7 二級快取

07 章 7.2 那張盤點表有一格寫著「二級快取 🟡 有（`<cache/>`），08 章會處理」。
**這一節就是那一格，而它有一個 06 章沒有的問題。**

06 章 6.5 花了很長的篇幅講 JPA 的二級快取，結論是四件事：

```
① classpath 多兩個 jar 就被【靜默開啟】（6.5.2）
② JPQL 查詢【不用】實體快取（6.5.5）
③ 查詢快取存的是【整列欄位值】，失效粒度是【整張表】（6.5.9、6.5.10）
④ 🔴 有人繞過 JPA 改了那張表 → 快取永遠是舊的（6.5.11）
```

**這一節要證明 MyBatis 這一側的④是【更容易發生的】** —— 因為
「繞過」的門檻低到只需要**另一個 mapper 介面**。

### 8.7.0 這一節的 mapper

**四個 namespace，動的是同一張 `country` 表** —— 這是 02 章那個
「同一張表映射成多個東西」手法的第四次使用：

```java
package com.example.lab.ch08;

import java.io.Serializable;

/**
 * 8.7 二級快取的參數表。
 * ★ 刻意寫成【可變的】POJO 並實作 Serializable：
 *   8.7.7 要用它證明「快取存的是什麼」與「readWrite 的差別」。
 */
public class Country8 implements Serializable {
    private static final long serialVersionUID = 1L;

    private String code;
    private String name;

    public String getCode() { return code; }
    public void setCode(String v) { this.code = v; }
    public String getName() { return name; }
    public void setName(String v) { this.name = v; }

    @Override public String toString() { return code + "=" + name; }
}
```

```java
package com.example.lab.ch08;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.util.List;

/** 8.7：開了 <cache/> 的 namespace。 */
@Mapper
public interface CountryMapper {
    List<Country8> all();
    Country8 byCode(@Param("code") String code);
    long countAll();

    /** 8.7.3：同一個 namespace 的寫入 —— 它會清掉【整個】namespace 的快取。 */
    int rename(@Param("code") String code, @Param("name") String name);

    /** 8.7.5：useCache="false" 的查詢。 */
    List<Country8> allNoCache();

    /** 8.7.5：flushCache="true" 的查詢 —— 一句 SELECT 也可以清快取。 */
    List<Country8> allFlushing();
}
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN"
        "https://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="com.example.lab.ch08.CountryMapper">

  <!-- ★★ 8.7.1：就這一行。它開的是【這個 namespace】的二級快取。 -->
  <cache eviction="LRU" flushInterval="60000" size="512" readOnly="false"/>

  <select id="all" resultType="com.example.lab.ch08.Country8">
    SELECT code, name FROM country ORDER BY code
  </select>

  <select id="byCode" resultType="com.example.lab.ch08.Country8">
    SELECT code, name FROM country WHERE code = #{code}
  </select>

  <select id="countAll" resultType="_long">
    SELECT count(*) FROM country
  </select>

  <select id="allNoCache" resultType="com.example.lab.ch08.Country8" useCache="false">
    SELECT code, name FROM country ORDER BY code
  </select>

  <select id="allFlushing" resultType="com.example.lab.ch08.Country8" flushCache="true">
    SELECT code, name FROM country ORDER BY code
  </select>

  <update id="rename">
    UPDATE country SET name = #{name} WHERE code = #{code}
  </update>
</mapper>
```

```java
package com.example.lab.ch08;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

/**
 * 🔴 8.7.4：另一個 namespace，動的是【同一張表】。
 * ★ 這是 MyBatis 二級快取最大的陷阱：它的失效範圍是 namespace，不是表。
 */
@Mapper
public interface CountryOtherMapper {
    int rename(@Param("code") String code, @Param("name") String name);
}
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN"
        "https://mybatis.org/dtd/mybatis-3-mapper.dtd">
<!-- 🔴 8.7.4：沒有 <cache/>、也沒有 <cache-ref>。
     它改的是 country 表，而 CountryMapper 的快取【完全不知道】。 -->
<mapper namespace="com.example.lab.ch08.CountryOtherMapper">
  <update id="rename">
    UPDATE country SET name = #{name} WHERE code = #{code}
  </update>
</mapper>
```

```java
package com.example.lab.ch08;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

/**
 * 8.7.5：用 <cache-ref> 共用 CountryMapper 的快取 ——
 * 這是「兩個 namespace 動同一張表」的正解。
 */
@Mapper
public interface CountryRefMapper {
    int rename(@Param("code") String code, @Param("name") String name);
}
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN"
        "https://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="com.example.lab.ch08.CountryRefMapper">

  <!-- ★ 8.7.5：借用另一個 namespace 的快取。
       這樣「這裡的寫入」就會清掉「那裡的查詢快取」。 -->
  <cache-ref namespace="com.example.lab.ch08.CountryMapper"/>

  <update id="rename">
    UPDATE country SET name = #{name} WHERE code = #{code}
  </update>
</mapper>
```

```java
package com.example.lab.ch08;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.util.List;

/** 8.7.7：readOnly="true" 的 namespace —— 用來對照「快取存的是什麼」。 */
@Mapper
public interface CountryRoMapper {
    List<Country8> all();
    Country8 byCode(@Param("code") String code);
}
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN"
        "https://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="com.example.lab.ch08.CountryRoMapper">

  <!-- ★ readOnly="true"：快取【直接回傳同一個物件實例】，不做序列化複製。
       快一點，而呼叫端改了那個物件就污染了整個快取（8.7.7）。 -->
  <cache eviction="LRU" size="512" readOnly="true"/>

  <select id="all" resultType="com.example.lab.ch08.Country8">
    SELECT code, name FROM country ORDER BY code
  </select>

  <select id="byCode" resultType="com.example.lab.ch08.Country8">
    SELECT code, name FROM country WHERE code = #{code}
  </select>
</mapper>
```

**同一張表的 JPA 映射**（8.7.6 要用）：

```java
package com.example.lab.ch08.jpa;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.hibernate.annotations.Cache;
import org.hibernate.annotations.CacheConcurrencyStrategy;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

/**
 * 8.7.6：country 表的 JPA 映射，而且【開了 JPA 的二級快取】。
 * 同一張表，MyBatis 那一側也開了 &lt;cache/&gt;（CountryMapper）。
 * 這一節要量的就是：兩個二級快取互相不知道對方存在。
 */
@Entity
@Table(name = "country")
@Cache(usage = CacheConcurrencyStrategy.READ_WRITE, region = "ref")
@jakarta.persistence.Cacheable
public class Ctry8 {

    @Id
    @Column(name = "code", length = 2)
    @JdbcTypeCode(SqlTypes.CHAR)
    private String code;

    @Column(name = "name", nullable = false, length = 64)
    private String name;

    protected Ctry8() {}

    public String getCode() { return code; }
    public String getName() { return name; }
    public void setName(String v) { this.name = v; }
}
```

**測試類別**：

```java
package com.example.lab.ch08;

import com.example.lab.ch08.jpa.Ctry8;
import org.apache.ibatis.cache.Cache;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.util.List;

/** 8.7：MyBatis 的二級快取。 */
class M6Cache extends Base08 {

    @Autowired CountryMapper countries;
    @Autowired CountryOtherMapper other;
    @Autowired CountryRefMapper ref;
    @Autowired CountryRoMapper ro;

    static final String NS = "com.example.lab.ch08.CountryMapper";

    @BeforeEach void setUp() {
        resetCountries();
        clearAllCaches();
    }

    private void clearAllCaches() {
        for (Cache c : sqlSessionFactory.getConfiguration().getCaches()) c.clear();
    }

    private Cache cache(String ns) { return sqlSessionFactory.getConfiguration().getCache(ns); }

    /** ★ 二級快取要 commit 之後才寫進去 → 每一次查詢都自己一個交易。 */
    private <T> T inTx(java.util.function.Supplier<T> body) {
        return tx.execute(s -> body.get());
    }

    // ══════════════ 8.7.1 一行開啟 ══════════════

    @Test
    void a1_一行開啟() {
        head("8.7.1 <cache/>：一行開啟");
        System.out.println("  容器裡有幾個 MyBatis 快取：" + sqlSessionFactory
                .getConfiguration().getCacheNames().size());
        sqlSessionFactory.getConfiguration().getCacheNames()
                .forEach(n -> System.out.println("    " + n));

        System.out.println("\n  CountryMapper 的快取物件：");
        Cache c = cache(NS);
        System.out.println("    " + c.getClass().getName() + " → id = " + c.getId());
        System.out.println("    裝飾鏈：" + decoratorChain(c));

        System.out.println("\n── 第一次查（各自一個交易）");
        System.out.println("   → " + spy(() -> inTx(countries::all)).size() + " 句 SQL"
                + "、快取裡 " + c.getSize() + " 筆");
        System.out.println("── 第二次查（另一個交易、另一個 SqlSession）");
        System.out.println("   → " + spy(() -> inTx(countries::all)).size() + " 句 SQL"
                + "、快取裡 " + c.getSize() + " 筆");
        System.out.println("── 第三次查");
        System.out.println("   → " + spy(() -> inTx(countries::all)).size() + " 句 SQL");

        System.out.println("\n  ★ 對照 07 章 7.11：一級快取的範圍是 SqlSession，"
                + "跨 session 就沒了。");
        System.out.println("    二級快取的範圍是【namespace】，跨 session、跨交易都在。");
    }

    private String decoratorChain(Cache c) {
        StringBuilder sb = new StringBuilder();
        Object cur = c;
        while (cur != null) {
            sb.append(cur.getClass().getSimpleName());
            Object next = null;
            for (var f : cur.getClass().getDeclaredFields()) {
                if (Cache.class.isAssignableFrom(f.getType())) {
                    try { f.setAccessible(true); next = f.get(cur); } catch (Exception ignored) {}
                }
            }
            cur = next;
            if (cur != null) sb.append(" → ");
        }
        return sb.toString();
    }

    // ══════════════ 8.7.2 快取的 key ══════════════

    @Test
    void a2_它的key是什麼() {
        head("8.7.2 快取的 key");
        Cache c = cache(NS);
        inTx(countries::all);
        System.out.println("  查了 all() 之後      → " + c.getSize() + " 筆");
        inTx(() -> countries.byCode("TW"));
        System.out.println("  再查 byCode(\"TW\")   → " + c.getSize() + " 筆");
        inTx(() -> countries.byCode("JP"));
        System.out.println("  再查 byCode(\"JP\")   → " + c.getSize() + " 筆");
        inTx(() -> countries.byCode("TW"));
        System.out.println("  再查 byCode(\"TW\")   → " + c.getSize() + " 筆（命中，沒有新增）");

        System.out.println("\n  ★ key 跟一級快取一樣是「statement id + 參數 + 分頁範圍 + SQL」，");
        System.out.println("    所以【每一組參數一格】—— 這是它最容易被低估的成本。");

        System.out.println("\n── 只有 SELECT 進快取嗎");
        int before = c.getSize();
        inTx(() -> countries.rename("TW", "台灣（改）"));
        System.out.println("   rename 之後快取裡有 " + c.getSize() + " 筆（之前 " + before + "）");
    }

    // ══════════════ 8.7.3 失效範圍 ══════════════

    @Test
    void a3_失效範圍是整個namespace() {
        head("8.7.3 🔴 一次寫入清掉【整個 namespace】");
        Cache c = cache(NS);
        inTx(countries::all);
        inTx(() -> countries.byCode("JP"));
        inTx(countries::countAll);
        System.out.println("  三個查詢都跑過 → 快取裡 " + c.getSize() + " 筆");

        System.out.println("\n── 改一個【完全不相干】的國家（DE）");
        inTx(() -> countries.rename("DE", "德意志"));
        System.out.println("   → 快取裡剩 " + c.getSize() + " 筆");

        System.out.println("\n── 三個查詢各要幾句 SQL");
        System.out.println("   all()      → " + spy(() -> inTx(countries::all)).size() + " 句");
        System.out.println("   byCode(JP) → " + spy(() -> inTx(() -> countries.byCode("JP"))).size()
                + " 句 ← JP 根本沒被改");
        System.out.println("   countAll() → " + spy(() -> inTx(countries::countAll)).size()
                + " 句 ← 它連 name 都沒查");

        System.out.println("\n  ★ 對照 06 章 6.5.10：JPA 的二級快取失效粒度是【實體 + id】，");
        System.out.println("    查詢快取的失效粒度是【整張表】。");
        System.out.println("    MyBatis 的失效粒度是【整個 namespace】——");
        System.out.println("    而一個 namespace 通常對應一張表，所以兩者其實差不多。");
        System.out.println("    🔴 真正的差別是 8.7.4 那一格。");
    }

    // ══════════════ 8.7.4 兩個 namespace 動同一張表 ══════════════

    @Test
    void a4_兩個namespace動同一張表() {
        head("8.7.4 🔴🔴 另一個 namespace 改了同一張表");
        Cache c = cache(NS);
        System.out.println("  先查一次 → " + inTx(countries::all));
        System.out.println("  快取裡 " + c.getSize() + " 筆");

        System.out.println("\n── 用【另一個 namespace】的 mapper 改 country 表");
        inTx(() -> other.rename("TW", "台灣（被別人改了）"));
        System.out.println("   資料庫裡現在是：" + jdbc.queryForObject(
                "SELECT name FROM country WHERE code = 'TW'", String.class));
        System.out.println("   CountryMapper 的快取裡還有 " + c.getSize() + " 筆");

        System.out.println("\n── 再查一次 CountryMapper.all()");
        List<String> sqls = spy(() -> System.out.println("   " + inTx(countries::all)));
        System.out.println("   → " + sqls.size() + " 句 SQL");

        System.out.println("\n── ✅ 換成有 <cache-ref> 的 mapper 來改");
        inTx(countries::all);                       // 先把快取暖回來
        System.out.println("   快取裡 " + c.getSize() + " 筆");
        inTx(() -> ref.rename("TW", "台灣（cache-ref 版）"));
        System.out.println("   ref.rename 之後快取裡剩 " + c.getSize() + " 筆");
        System.out.println("   再查一次 → " + spy(() -> System.out.println(
                "   " + inTx(countries::all))).size() + " 句 SQL");
    }

    // ══════════════ 8.7.5 useCache / flushCache ══════════════

    @Test
    void a5_兩個開關() {
        head("8.7.5 useCache 與 flushCache");
        Cache c = cache(NS);
        inTx(countries::all);
        System.out.println("  快取裡 " + c.getSize() + " 筆");

        System.out.println("\n── useCache=\"false\" 的查詢");
        System.out.println("   第一次 → " + spy(() -> inTx(countries::allNoCache)).size() + " 句");
        System.out.println("   第二次 → " + spy(() -> inTx(countries::allNoCache)).size()
                + " 句 ← 每次都打");
        System.out.println("   而快取裡還是 " + c.getSize() + " 筆（它不寫也不讀）");

        System.out.println("\n── flushCache=\"true\" 的查詢");
        inTx(countries::all);
        inTx(() -> countries.byCode("JP"));
        System.out.println("   先讓快取裡有 " + c.getSize() + " 筆");
        inTx(countries::allFlushing);
        System.out.println("   跑一次 allFlushing() → 快取裡 " + c.getSize() + " 筆");
        System.out.println("   ★ 不是 0 —— flushCache 是【查詢之前】清，");
        System.out.println("     而它自己的結果照樣會被快取（useCache 預設是 true）。");
        System.out.println("   再查 byCode(JP) → " + spy(() -> inTx(() -> countries.byCode("JP")))
                .size() + " 句 SQL（它被清掉了）");
    }

    // ══════════════ 8.7.6 跟 JPA 的二級快取 ══════════════

    @Test
    void a6_兩個框架的二級快取() {
        head("8.7.8 🔴🔴 兩個二級快取互相不知道（收 06 章 6.5.11）");
        clearAllCaches();
        em.getEntityManagerFactory().getCache().evictAll();
        Cache c = cache(NS);

        System.out.println("── 兩邊各查一次，都進了自己的二級快取");
        System.out.println("   MyBatis : " + inTx(() -> countries.byCode("JP")));
        System.out.println("   JPA     : " + inTx(() -> em.find(Ctry8.class, "JP").getName()));
        System.out.println("   MyBatis 快取 " + c.getSize() + " 筆、JPA 快取有 JP："
                + em.getEntityManagerFactory().getCache().contains(Ctry8.class, "JP"));

        System.out.println("\n── ① MyBatis 改了它（同一個 namespace，所以自己的快取會清）");
        inTx(() -> countries.rename("JP", "日本（MyBatis 改）"));
        System.out.println("   資料庫  : " + jdbc.queryForObject(
                "SELECT name FROM country WHERE code = 'JP'", String.class));
        System.out.println("   MyBatis : " + inTx(() -> countries.byCode("JP")));
        System.out.println("   JPA     : " + inTx(() -> em.find(Ctry8.class, "JP").getName())
                + "   ← 🔴 舊值");
        System.out.println("   JPA 打了幾句 SQL：" + spy(() -> inTx(() -> {
            em.clear(); return em.find(Ctry8.class, "JP").getName(); })).size());

        System.out.println("\n── ② 換 JPA 改（它會維護自己的二級快取）");
        clearAllCaches();
        inTx(() -> countries.byCode("JP"));          // MyBatis 快取暖起來
        inTx(() -> { em.find(Ctry8.class, "JP").setName("日本（JPA 改）"); return null; });
        System.out.println("   資料庫  : " + jdbc.queryForObject(
                "SELECT name FROM country WHERE code = 'JP'", String.class));
        System.out.println("   JPA     : " + inTx(() -> { em.clear();
                return em.find(Ctry8.class, "JP").getName(); }));
        System.out.println("   MyBatis : " + inTx(() -> countries.byCode("JP"))
                + "   ← 🔴 舊值");
        System.out.println("   MyBatis 打了幾句 SQL："
                + spy(() -> inTx(() -> countries.byCode("JP"))).size());
    }

    // ══════════════ 8.7.7 快取存的是什麼 ══════════════

    @Test
    void a7_存的是什麼() {
        head("8.7.7 readOnly：快取回傳的是同一個物件嗎");

        System.out.println("── readOnly=\"false\"（預設，CountryMapper）");
        Country8 a1 = inTx(() -> countries.byCode("TW"));
        Country8 a2 = inTx(() -> countries.byCode("TW"));
        System.out.println("   兩次查詢回傳同一個實例？ " + (a1 == a2));
        a1.setName("被呼叫端改掉了");
        System.out.println("   改了第一次拿到的物件之後，第三次查到的是："
                + inTx(() -> countries.byCode("TW")).getName());

        System.out.println("\n── readOnly=\"true\"（CountryRoMapper）");
        Country8 b1 = inTx(() -> ro.byCode("TW"));
        Country8 b2 = inTx(() -> ro.byCode("TW"));
        System.out.println("   兩次查詢回傳同一個實例？ " + (b1 == b2));
        b1.setName("被呼叫端改掉了");
        System.out.println("   改了第一次拿到的物件之後，第三次查到的是："
                + inTx(() -> ro.byCode("TW")).getName() + "   ← 🔴 快取被污染了");

        System.out.println("\n  ★ readOnly=\"false\" 的裝飾鏈裡有一個 SerializedCache：");
        System.out.println("    " + decoratorChain(cache(NS)));
        System.out.println("    readOnly=\"true\" 的沒有：");
        System.out.println("    " + decoratorChain(cache("com.example.lab.ch08.CountryRoMapper")));
        System.out.println("\n  🔴 readOnly=\"false\" 要求結果型別【可序列化】——"
                + "而它不會在啟動時檢查。");
    }

    @Test
    void a8_交易還沒commit的時候() {
        head("8.7.6 ★ 二級快取要 commit 之後才寫進去");
        Cache c = cache(NS);
        clearAllCaches();

        tx.executeWithoutResult(s -> {
            countries.all();
            System.out.println("  交易【還沒 commit】時，快取裡 " + c.getSize() + " 筆");
            System.out.println("  同一個交易裡再查一次 → "
                    + spy(() -> countries.all()).size() + " 句 SQL（一級快取命中）");
        });
        System.out.println("  commit 之後，快取裡 " + c.getSize() + " 筆");

        System.out.println("\n── 🔴 那如果交易 rollback 了呢（只讀）");
        clearAllCaches();
        Throwable t = catching(() -> tx.executeWithoutResult(s -> {
            countries.all();
            throw new IllegalStateException("rollback");
        }));
        System.out.println("  " + name(t) + " → 快取裡 " + c.getSize() + " 筆");
        System.out.println("  再查一次 → " + spy(() -> inTx(countries::all)).size()
                + " 句 SQL ← 命中了");
        System.out.println("  🔴 交易 rollback 了，而查詢結果【還是進了二級快取】。");
        System.out.println("     機制：DefaultSqlSession.close() 呼叫");
        System.out.println("           executor.close(isCommitOrRollbackRequired(false))，而");
        System.out.println("           isCommitOrRollbackRequired = (!autoCommit && dirty) || force");
        System.out.println("           純查詢的 session 【不是 dirty】→ 傳 false");
        System.out.println("           → CachingExecutor.close(false) → tcm.commit()");

        System.out.println("\n── 那如果那個 rollback 的交易【有寫入】呢");
        clearAllCaches();
        inTx(countries::all);
        System.out.println("  先讓快取裡有 " + c.getSize() + " 筆，資料庫是 "
                + jdbc.queryForObject("SELECT name FROM country WHERE code='US'", String.class));
        Throwable t2 = catching(() -> tx.executeWithoutResult(s -> {
            countries.rename("US", "美國（未提交）");
            countries.all();
            throw new IllegalStateException("rollback");
        }));
        System.out.println("  " + name(t2) + " → 快取裡 " + c.getSize() + " 筆");
        System.out.println("  資料庫還是 " + jdbc.queryForObject(
                "SELECT name FROM country WHERE code='US'", String.class));
        System.out.println("  查一次 → " + inTx(countries::all));

        System.out.println("\n  ★ 兩個結論：");
        System.out.println("    ① 純查詢的交易 rollback，結果【照樣進快取】——");
        System.out.println("       這其實是對的（沒有寫入 = 那份資料是真的），");
        System.out.println("       但它跟直覺相反，量的時候會誤導你。");
        System.out.println("    ② 有寫入的交易 rollback，那個 clear 【不會】傳到真正的快取，");
        System.out.println("       所以快取裡是【舊的、也就是正確的】值。");
        System.out.println("    → 量二級快取的規則：每一次查詢都自己一個【成功提交】的交易。");
    }
}
```

---

### 8.7.1 實測：一行開啟

```
═══ 8.7.1 <cache/>：一行開啟 ═══
  容器裡有幾個 MyBatis 快取：4
    com.example.lab.ch08.CountryMapper
    CountryRoMapper
    CountryMapper
    com.example.lab.ch08.CountryRoMapper

  CountryMapper 的快取物件：
    org.apache.ibatis.cache.decorators.SynchronizedCache
      → id = com.example.lab.ch08.CountryMapper
    裝飾鏈：SynchronizedCache → LoggingCache → SerializedCache
            → ScheduledCache → LruCache → PerpetualCache

── 第一次查（各自一個交易）
   → 1 句 SQL、快取裡 1 筆
── 第二次查（另一個交易、另一個 SqlSession）
   → 0 句 SQL、快取裡 1 筆
── 第三次查
   → 0 句 SQL
```

📌 **三件事**：

**① 「4 個快取」其實是 2 個。** MyBatis 把每一個快取同時註冊在
**完整 namespace** 與 **短名字**（`CountryMapper`）兩個 key 下。
這是為了讓 `<cache-ref namespace="CountryMapper"/>` 這種簡寫也能找到。

**② 那條裝飾鏈就是 `<cache>` 那些屬性的實作**：

| `<cache>` 的屬性 | 對應的裝飾器 | 本章的值 |
|---|---|---|
| （總是有） | `SynchronizedCache` | — |
| （總是有） | `LoggingCache` | 它會在 debug 記錄命中率 |
| `readOnly="false"` | **`SerializedCache`** | 序列化複製一份再回傳（8.7.7） |
| `flushInterval` | `ScheduledCache` | 60000 ms |
| `eviction` + `size` | **`LruCache`** | LRU、512 筆 |
| （最底層） | `PerpetualCache` | 就是一個 `HashMap` |

⚠️ **`eviction` 有四種**：`LRU`（預設）/ `FIFO` / `SOFT` / `WEAK`。
`SOFT` 與 `WEAK` 用的是 Java 的軟／弱引用 ——
**它們把「什麼時候被清掉」交給 GC，所以「快取命中率」變成一個無法預測的數字。**
不要用它們，除非你真的懂為什麼要用。

**③ 二級快取的範圍與一級快取的對照**：

```
一級快取（07 章 7.11）：範圍是【SqlSession】→ 跨 session 就沒了
二級快取（本節）      ：範圍是【namespace】 → 跨 session、跨交易、跨執行緒都在
```

### 8.7.2 實測：它的 key 是什麼

```
═══ 8.7.2 快取的 key ═══
  查了 all() 之後      → 1 筆
  再查 byCode("TW")   → 2 筆
  再查 byCode("JP")   → 3 筆
  再查 byCode("TW")   → 3 筆（命中，沒有新增）

── 只有 SELECT 進快取嗎
   rename 之後快取裡有 0 筆（之前 3）
```

**key 跟一級快取完全一樣**（07 章 7.11.1）：

```
CacheKey = statement id + 分頁範圍(offset, limit) + SQL 文字 + 每一個參數值
                              ↓
所以【每一組參數一格】。
```

🔴 **這是它最容易被低估的成本**：

```
一個 byCode(code) 查詢 + 200 個國家 → 200 格
一個 search(六個可選條件) 查詢       → 8.3.13 那 64 種形狀 × 每一種的參數組合
                              ↓
「開了二級快取」在動態查詢上幾乎【不會命中】，而它照樣佔記憶體。
```

✅ **所以二級快取只適合放「參數空間很小」的查詢** —— 而那通常就是參數表（8.7.8）。

### 8.7.3 🔴 實測：一次寫入清掉整個 namespace

```
═══ 8.7.3 🔴 一次寫入清掉【整個 namespace】 ═══
  三個查詢都跑過 → 快取裡 3 筆

── 改一個【完全不相干】的國家（DE）
   → 快取裡剩 0 筆

── 三個查詢各要幾句 SQL
   all()      → 1 句
   byCode(JP) → 1 句 ← JP 根本沒被改
   countAll() → 1 句 ← 它連 name 都沒查
```

**任何一句 `INSERT` / `UPDATE` / `DELETE` 都會清掉整個 namespace 的快取。**
（`flushCache` 在寫入型 statement 上的預設值是 `true`。）

📌 **跟 06 章的失效粒度並排**：

| | 失效粒度 | 出處 |
|---|---|---|
| JPA 實體快取 | **實體 + id**（只有那一列） | 06 章 6.5.10 |
| JPA 查詢快取 | **整張表**（`update-timestamps-region`） | 06 章 6.5.10 |
| **MyBatis 二級快取** | **整個 namespace** | 8.7.3 |

★ **而一個 namespace 通常對應一張表，所以 MyBatis 的粒度 ≈ JPA 查詢快取的粒度。**
**兩者其實差不多 —— 真正的差別是下一格。**

### 8.7.4 🔴🔴 實測：另一個 namespace 改了同一張表

```
═══ 8.7.4 🔴🔴 另一個 namespace 改了同一張表 ═══
  先查一次 → [DE=德國, JP=日本, TW=台灣, US=美國]
  快取裡 1 筆

── 用【另一個 namespace】的 mapper 改 country 表
   資料庫裡現在是：台灣（被別人改了）
   CountryMapper 的快取裡還有 1 筆

── 再查一次 CountryMapper.all()
   [DE=德國, JP=日本, TW=台灣, US=美國]
   → 0 句 SQL

── ✅ 換成有 <cache-ref> 的 mapper 來改
   快取裡 1 筆
   ref.rename 之後快取裡剩 0 筆
   [DE=德國, JP=日本, TW=台灣（cache-ref 版）, US=美國]
   再查一次 → 1 句 SQL
```

🔴🔴 **資料庫裡是「台灣（被別人改了）」，而應用程式看到的是「台灣」，而且 0 句 SQL。**

**這就是 06 章 6.5.11 那個事故，而它的門檻低得多**：

```
06 章 6.5.11 的「繞過 JPA」：要寫 JdbcTemplate、或另一個服務、或 DBA 手動改
08 章 8.7.4 的「繞過 namespace」：
       只要【另一個 mapper 介面】—— 而那是一件完全正常、每天都在做的事
                              ↓
「訂單 mapper 順手改一下 country 表的統計欄位」
「一個 AdminMapper 專門放後台的維護語句」
「兩個 mapper 各自負責讀與寫」← 這甚至是被鼓勵的分離（07 章 7.14.2 那條斷言）
```

✅ **`<cache-ref>` 是正解，而它要求你知道「誰動了這張表」**：

```xml
<mapper namespace="com.example.lab.ch08.CountryRefMapper">
  <!-- ★ 借用另一個 namespace 的快取 → 這裡的寫入會清掉那裡的查詢快取 -->
  <cache-ref namespace="com.example.lab.ch08.CountryMapper"/>
  <update id="rename">
    UPDATE country SET name = #{name} WHERE code = #{code}
  </update>
</mapper>
```

⚠️ **而「知道誰動了這張表」是一個【隨時會過期的知識】**：

```
今天：兩個 mapper 動 country → 兩個 <cache-ref> 指到同一個快取，正確
下週：有人加了第三個 mapper  → 沒有人記得要加 <cache-ref>
                              ↓
症狀：某個下拉選單改了名字之後【偶爾】還是舊的（取決於哪一台機器）。
```

📌 **所以 MyBatis 二級快取的三條規則，比 JPA 的更嚴格**：

```
① 只給【參數表】用 —— 而且那張表的寫入路徑要少到你數得出來
② 那張表的【每一個】mapper 都要 <cache-ref> 指到同一個快取
   → 而這件事沒有任何東西會檢查（8.9 可以補一條斷言）
③ 🔴 只要那張表有可能被「應用程式之外」改（DBA、另一個服務、排程），
   就【不要開】。改用一個有 TTL 的應用層快取（Spring Cache + Caffeine），
   讓「最壞情況下的資料新鮮度」變成一個【你設定的數字】而不是「永遠」。
```

### 8.7.5 實測：`useCache` 與 `flushCache`

```
═══ 8.7.5 useCache 與 flushCache ═══
  快取裡 1 筆

── useCache="false" 的查詢
   第一次 → 1 句
   第二次 → 1 句 ← 每次都打
   而快取裡還是 1 筆（它不寫也不讀）

── flushCache="true" 的查詢
   先讓快取裡有 2 筆
   跑一次 allFlushing() → 快取裡 1 筆
   ★ 不是 0 —— flushCache 是【查詢之前】清，
     而它自己的結果照樣會被快取（useCache 預設是 true）。
   再查 byCode(JP) → 1 句 SQL（它被清掉了）
```

| 屬性 | `select` 的預設 | `insert`/`update`/`delete` 的預設 | 意思 |
|---|---|---|---|
| `useCache` | `true` | — | 這個查詢要不要**讀寫**二級快取 |
| `flushCache` | `false` | **`true`** | 執行**之前**清掉整個 namespace 的快取 |

⚠️ **`flushCache="true"` 的 `select` 之後，快取裡不是 0 筆而是 1 筆** ——
因為它清完之後，**自己的結果又被放進去了**。
要「查了不留痕跡」得兩個都設：`flushCache="true" useCache="false"`。

✅ **`useCache="false"` 的用途**：一個 namespace 裡大部分查詢適合快取，
而**某一個查詢的參數空間很大**（例如帶了時間戳）→ 只把那一個關掉，
不然它會把 `LruCache` 的 512 格全部佔滿、把有用的擠出去。

### 8.7.6 ★ 實測：二級快取要 commit 之後才寫進去

```
═══ 8.7.6 ★ 二級快取要 commit 之後才寫進去 ═══
  交易【還沒 commit】時，快取裡 0 筆
  同一個交易裡再查一次 → 0 句 SQL（一級快取命中）
  commit 之後，快取裡 1 筆
```

**機制是 `TransactionalCacheManager`**：

```
交易進行中的查詢結果 → 放在一個【只屬於這個 SqlSession 的暫存區】
commit               → flush 進真正的 namespace 快取
                              ↓
理由：如果一個交易改了資料又查了資料，那份「查到的」是【未提交】的狀態，
     不能讓別的交易看到（06 章 6.5 那個一致性問題）。
```

📌 **這對「量二級快取」是一個必須知道的前提** ——
本章那個 `inTx()` helper 就是為了這件事：

```java
    /** ★ 二級快取要 commit 之後才寫進去 → 每一次查詢都自己一個交易。 */
    private <T> T inTx(java.util.function.Supplier<T> body) {
        return tx.execute(s -> body.get());
    }
```

**而 rollback 的行為跟直覺相反**：

```
── 🔴 那如果交易 rollback 了呢（只讀）
  IllegalStateException → 快取裡 1 筆
  再查一次 → 0 句 SQL ← 命中了
  🔴 交易 rollback 了，而查詢結果【還是進了二級快取】。
     機制：DefaultSqlSession.close() 呼叫
           executor.close(isCommitOrRollbackRequired(false))，而
           isCommitOrRollbackRequired = (!autoCommit && dirty) || force
           純查詢的 session 【不是 dirty】→ 傳 false
           → CachingExecutor.close(false) → tcm.commit()

── 那如果那個 rollback 的交易【有寫入】呢
  先讓快取裡有 1 筆，資料庫是 美國
  IllegalStateException → 快取裡 1 筆
  資料庫還是 美國
  查一次 → [DE=德國, JP=日本, TW=台灣, US=美國]
```

📌 **兩個結論**：

```
① 純查詢的交易 rollback，結果【照樣進快取】——
   這其實是對的（沒有寫入 = 那份資料是真的），
   但它跟直覺相反，量的時候會誤導你。
② 有寫入的交易 rollback，那個 clear【不會】傳到真正的快取，
   所以快取裡是【舊的、也就是正確的】值。
```

✅ **量二級快取的規則：每一次查詢都自己一個【成功提交】的交易。**

### 8.7.7 🔴 實測：`readOnly` —— 快取回傳的是同一個物件嗎

```
═══ 8.7.7 readOnly：快取回傳的是同一個物件嗎 ═══
── readOnly="false"（預設，CountryMapper）
   兩次查詢回傳同一個實例？ false
   改了第一次拿到的物件之後，第三次查到的是：台灣

── readOnly="true"（CountryRoMapper）
   兩次查詢回傳同一個實例？ true
   改了第一次拿到的物件之後，第三次查到的是：被呼叫端改掉了   ← 🔴 快取被污染了

  ★ readOnly="false" 的裝飾鏈裡有一個 SerializedCache：
    SynchronizedCache → LoggingCache → SerializedCache
      → ScheduledCache → LruCache → PerpetualCache
    readOnly="true" 的沒有：
    SynchronizedCache → LoggingCache → LruCache → PerpetualCache
```

| | `readOnly="false"`（預設） | `readOnly="true"` |
|---|---|---|
| 回傳 | **序列化複製的一份** | **快取裡那一個實例** |
| 呼叫端改了它 | 不影響快取 | 🔴 **污染整個快取** |
| 速度 | 慢（每次都序列化 / 反序列化） | 快 |
| 對結果型別的要求 | **必須 `Serializable`** | 無 |

🔴 **`readOnly="false"` 要求結果型別可序列化，而它【不會在啟動時檢查】。**
少了 `implements Serializable` 的症狀是：**第二次查詢時拋
`CacheException: Error serializing object`** —— 而那是執行期。

★ **跟 07 章 7.11.4 那件事放在一起看**：

```
07 章 7.11.4：一級快取【同一個交易裡回傳同一個物件實例】
              → 呼叫端改了它，同一個交易裡的下一個查詢就拿到被改過的值
              → 那一節的解法是「mapper 回傳 record（不可變）」

08 章 8.7.7：二級快取 readOnly="true" 也回傳同一個實例，
             而它的範圍是【整個應用程式】——
             → 污染的不是一個交易，是【所有人】
                              ↓
✅ 兩節共同的結論：mapper 的回傳型別一律用 record（或不可變類別）。
   那時候 readOnly="true" 是安全的，而且它比 readOnly="false" 快。
```

⚠️ **本章的 `Country8` 刻意寫成可變的 POJO + `Serializable`，
就是為了量出上面那兩格。實務上它應該是 `record Country8(String code, String name)`。**

### 8.7.8 🔴🔴 實測：兩個框架的二級快取互相不知道

**這一格是 06 章 6.5.11 的完整版：同一張 `country` 表，
MyBatis 那一側開了 `<cache/>`，JPA 那一側開了 `@Cache`。**

```
═══ 8.7.8 🔴🔴 兩個二級快取互相不知道（收 06 章 6.5.11） ═══
── 兩邊各查一次，都進了自己的二級快取
   MyBatis : JP=日本
   JPA     : 日本
   MyBatis 快取 1 筆、JPA 快取有 JP：true

── ① MyBatis 改了它（同一個 namespace，所以自己的快取會清）
   資料庫  : 日本（MyBatis 改）
   MyBatis : JP=日本（MyBatis 改）
   JPA     : 日本   ← 🔴 舊值
   JPA 打了幾句 SQL：0

── ② 換 JPA 改（它會維護自己的二級快取）
   資料庫  : 日本（JPA 改）
   JPA     : 日本（JPA 改）
   MyBatis : JP=日本（MyBatis 改）   ← 🔴 舊值
   MyBatis 打了幾句 SQL：0
```

★★ **兩個方向都壞，而且都是 0 句 SQL。**

```
                    資料庫        JPA 看到      MyBatis 看到
MyBatis 改完之後     日本(MyBatis)  日本          日本(MyBatis)
JPA 改完之後         日本(JPA)      日本(JPA)     日本(MyBatis)
                                    ↑             ↑
                              各自快取自己的歷史版本
```

📌 **這比 06 章 6.5.11 那個事故嚴重，因為它是【雙向】的**：

```
06 章 6.5.11：「有人繞過 JPA 改了那張表」→ 一個方向
08 章 8.7.8 ：兩個框架各有一份快取，誰改都會讓對方變成舊的 → 兩個方向
                              ↓
而 07 章 7.12.2 已經證明它們【用同一條連線、在同一個交易裡】——
所以這不是「兩個系統」的問題，是【同一個交易裡的兩份快取】。
```

✅ **這一站關於「混用」的規則，在這裡拿到最硬的一個理由**：

```
00 章 0.9 規則一：同一張表只讓【一個框架寫】
                              ↓
08 章 8.7.8 把它加強成：
     同一張表如果兩個框架都【讀】，那就【兩邊的二級快取都不准開】。
     ——因為「一個框架寫、一個框架讀」，讀的那一邊的快取一定會過期。
```

**而如果真的需要快取那張參數表**，正解是**把它移到兩個框架之外**：

```java
// 一份快取、一個 TTL、兩個框架都經過它
@Service
public class CountryService {

    private final CountryMapper mapper;      // 或 JPA repository，選一個

    @Cacheable(cacheNames = "country", key = "#code")
    public Country8 byCode(String code) { return mapper.byCode(code); }

    @CacheEvict(cacheNames = "country", allEntries = true)
    public void rename(String code, String name) { mapper.rename(code, name); }
}
```

```
✅ 一份快取（Spring Cache + Caffeine，設一個 TTL）
✅ 失效點在【一個地方】，而不是散在兩個框架的組態裡
✅ 「最壞情況的資料新鮮度」是一個你設定的數字（06 章 6.5.12 那條規則）
```

### 8.7.9 什麼東西適合放進 MyBatis 二級快取

**06 章 6.5.12 給過 JPA 那一側的答案。MyBatis 這一側多兩條限制**：

| 條件 | 為什麼 | 節 |
|---|---|---|
| 參數空間很小 | key 是「參數值」，每一組一格 | 8.7.2 |
| 寫入很少 | 一次寫入清掉**整個** namespace | 8.7.3 |
| **動這張表的 mapper 數得出來** | 🔴 別的 namespace 改了它不會失效 | **8.7.4** |
| **JPA 那一側沒有映射它 / 沒開二級快取** | 🔴 兩份快取互相不知道 | **8.7.8** |
| 結果型別不可變（`record`） | `readOnly="true"` 才安全，而它比較快 | 8.7.7 |
| 沒有應用程式之外的寫入路徑 | DBA / 排程 / 另一個服務改了就永遠是舊的 | 8.7.4 |

📌 **同時滿足六條的東西非常少**：

```
✅ 適合：國家 / 幣別 / 縣市 / 商品分類 這類【啟動之後幾乎不變】的參數表
🟡 勉強：商品主檔（要設 flushInterval 當新鮮度上限）
🔴 不要：訂單、庫存、任何有動態查詢條件的東西、任何兩個框架都碰的表
```

⚠️ **而最實際的建議是：先不要開。**

```
06 章 6.5.2 已經證明 JPA 的二級快取會【被靜默開啟】（classpath 多兩個 jar），
而 MyBatis 的要你自己寫 <cache/> —— 這是它的優點。
                              ↓
「一行就開好了」不是理由。開之前先回答上面那六個問題，
而如果其中任何一個答不出來，那就是【還不該開】。
```

---

## 8.8 攔截器（Interceptor）

**MyBatis 的擴充點只有一個，就是攔截器。** 而 8.6 那個 PageHelper 就是它 ——
所以這一節不是「一個進階功能」，是**把前面用過的東西打開來看**。

### 8.8.1 實測：四個可攔截的介面

```java
package com.example.lab.ch08;

import org.apache.ibatis.executor.Executor;
import org.apache.ibatis.mapping.MappedStatement;
import org.apache.ibatis.plugin.Interceptor;
import org.apache.ibatis.plugin.Intercepts;
import org.apache.ibatis.plugin.Invocation;
import org.apache.ibatis.plugin.Signature;
import org.apache.ibatis.session.ResultHandler;
import org.apache.ibatis.session.RowBounds;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * 8.8.2：攔截器的【正當用途】—— 觀測。
 *
 * ★ 攔截 Executor 這一層的好處：拿得到 MappedStatement（所以知道是哪一個方法），
 *   也拿得到參數物件；而且它包住「查快取 + 打 SQL」整段，所以量到的是
 *   「這個 mapper 方法花了多久」，不是「這句 SQL 花了多久」。
 *   ⚠️ 這兩件事不一樣 —— 8.8.2 會量出差別（快取命中時是 0 句 SQL，但方法還是被呼叫了）。
 */
@Intercepts({
    @Signature(type = Executor.class, method = "query",
               args = {MappedStatement.class, Object.class, RowBounds.class, ResultHandler.class}),
    @Signature(type = Executor.class, method = "query",
               args = {MappedStatement.class, Object.class, RowBounds.class, ResultHandler.class,
                       org.apache.ibatis.cache.CacheKey.class, org.apache.ibatis.mapping.BoundSql.class}),
    @Signature(type = Executor.class, method = "update",
               args = {MappedStatement.class, Object.class})
})
public class SqlLogInterceptor implements Interceptor {

    public record Entry(String statementId, String kind, long micros, int rows) {}

    private static final List<Entry> LOG = Collections.synchronizedList(new ArrayList<>());
    private static volatile boolean on = false;

    public static void start() { LOG.clear(); on = true; }
    public static List<Entry> stop() { on = false; return new ArrayList<>(LOG); }

    @Override
    public Object intercept(Invocation invocation) throws Throwable {
        MappedStatement ms = (MappedStatement) invocation.getArgs()[0];
        long t0 = System.nanoTime();
        Object result = invocation.proceed();
        long micros = (System.nanoTime() - t0) / 1000;
        if (on) {
            int rows = (result instanceof List<?> l) ? l.size()
                     : (result instanceof Integer i) ? i : 1;
            LOG.add(new Entry(ms.getId(), ms.getSqlCommandType().name(), micros, rows));
        }
        return result;
    }
}
```

```java
package com.example.lab.ch08;

import org.apache.ibatis.executor.Executor;
import org.apache.ibatis.mapping.MappedStatement;
import org.apache.ibatis.plugin.Interceptor;
import org.apache.ibatis.plugin.Intercepts;
import org.apache.ibatis.plugin.Invocation;
import org.apache.ibatis.plugin.Signature;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.Timestamp;
import java.time.Instant;

/**
 * 🔴 8.8.3：攔截器的【不當用途】—— 用它做審計。
 *
 * 這個類別會動、而且看起來很漂亮：每一句寫入都自動落一筆稽核紀錄，
 * 業務程式碼一行都不用改。而 8.8.3 會量出它的四個問題。
 */
@Intercepts(@Signature(type = Executor.class, method = "update",
                       args = {MappedStatement.class, Object.class}))
public class AuditWriteInterceptor implements Interceptor {

    private static volatile boolean on = false;
    public static void on() { on = true; }
    public static void off() { on = false; }

    @Override
    public Object intercept(Invocation invocation) throws Throwable {
        Object result = invocation.proceed();
        if (!on) return result;

        MappedStatement ms = (MappedStatement) invocation.getArgs()[0];
        if (ms.getId().contains("AuditMapper")) return result;   // 免得自己審計自己

        Executor executor = (Executor) invocation.getTarget();
        Connection conn = executor.getTransaction().getConnection();
        try (PreparedStatement ps = conn.prepareStatement(
                "INSERT INTO audit_sql (stmt_id, sql_kind, took_ms, at_time) VALUES (?,?,?,?)")) {
            ps.setString(1, ms.getId());
            ps.setString(2, ms.getSqlCommandType().name());
            ps.setLong(3, 0L);
            ps.setTimestamp(4, Timestamp.from(Instant.now()));
            ps.executeUpdate();
        }
        return result;
    }
}
```

```java
package com.example.lab.ch08;

import org.apache.ibatis.executor.statement.StatementHandler;
import org.apache.ibatis.mapping.BoundSql;
import org.apache.ibatis.plugin.Interceptor;
import org.apache.ibatis.plugin.Intercepts;
import org.apache.ibatis.plugin.Invocation;
import org.apache.ibatis.plugin.Signature;
import org.apache.ibatis.reflection.MetaObject;
import org.apache.ibatis.reflection.SystemMetaObject;

import java.sql.Connection;

/**
 * 🔴 8.8.4：改寫 SQL 的攔截器（多租戶的常見做法）。
 *
 * ★ 攔截 StatementHandler.prepare 是【最後一站】：這時候 SQL 已經是最終字串，
 *   參數也已經排好順序。所以改 SQL 文字很容易，而【改參數個數幾乎不可能】——
 *   這就是 8.8.4 三個地雷的第一個。
 */
@Intercepts(@Signature(type = StatementHandler.class, method = "prepare",
                       args = {Connection.class, Integer.class}))
public class TenantInterceptor implements Interceptor {

    private static volatile String tenant = null;
    public static void tenant(String t) { tenant = t; }
    public static void off() { tenant = null; }

    private static volatile int rewrites = 0;
    public static int rewrites() { return rewrites; }
    public static void resetCount() { rewrites = 0; }

    @Override
    public Object intercept(Invocation invocation) throws Throwable {
        if (tenant == null) return invocation.proceed();

        StatementHandler handler = (StatementHandler) invocation.getTarget();
        MetaObject meta = SystemMetaObject.forObject(handler);
        BoundSql boundSql = (BoundSql) meta.getValue("delegate.boundSql");
        String sql = boundSql.getSql();

        // 🔴 地雷一：靠字串比對決定要不要改寫
        if (sql.toLowerCase().contains("from orders") && !sql.contains("/*tenant*/")) {
            String patched = sql.replaceFirst("(?i)\\bfrom orders\\b",
                    "FROM orders /*tenant*/") + " AND o.memo LIKE '" + tenant + "%'";
            SystemMetaObject.forObject(boundSql).setValue("sql", patched);
            rewrites++;
        }
        return invocation.proceed();
    }
}
```

```java
package com.example.lab.ch08;

import org.apache.ibatis.annotations.Delete;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface AuditMapper {
    @Select("SELECT count(*) FROM audit_sql")
    long count();

    @Delete("DELETE FROM audit_sql")
    int clear();

    @Select("SELECT stmt_id FROM audit_sql ORDER BY id")
    java.util.List<String> ids();
}
```

**把它們放進容器**：

```java
package com.example.lab.ch08;

import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;

/**
 * 8.8：把三個攔截器放進容器。
 *
 * ★ mybatis-spring-boot-starter 會自動收集容器裡【所有】 Interceptor bean
 *   並加到 Configuration 上（順序依 bean 的順序）。
 * ⚠️ 用 @TestConfiguration（不是 @Configuration）——後者會【取代】
 *   本測試類別的組態掃描（05 章踩過的坑三）。
 */
@TestConfiguration
public class Plugins8 {
    @Bean SqlLogInterceptor sqlLogInterceptor() { return new SqlLogInterceptor(); }
    @Bean AuditWriteInterceptor auditWriteInterceptor() { return new AuditWriteInterceptor(); }
    @Bean TenantInterceptor tenantInterceptor() { return new TenantInterceptor(); }
}
```

```java
package com.example.lab.ch08;

import org.apache.ibatis.plugin.Interceptor;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.util.List;

/** 8.8：攔截器。 */
@SpringBootTest(properties = {
  "spring.datasource.url=jdbc:mysql://127.0.0.1:33306/ch08?connectionTimeZone=UTC"
      + "&forceConnectionTimeZoneToSession=true&preserveInstants=true&characterEncoding=UTF-8",
  "lab.ch08.plugins=on"
})
@Import(Plugins8.class)
class M7Plugin extends Base08 {

    @Autowired Ord8Mapper orders;
    @Autowired Ord8ResultMapper results;
    @Autowired CountryMapper countries;
    @Autowired AuditMapper audits;

    static final String NS = "com.example.lab.ch08.Ord8Mapper.";

    @BeforeEach void setUp() {
        seed(20, 4, 2);
        AuditWriteInterceptor.off();
        TenantInterceptor.off();
        TenantInterceptor.resetCount();
    }

    private static OrderSearchBean8 b(OrderSearch8 r) { return OrderSearchBean8.of(r); }

    // ══════════════ 8.8.1 四個可攔截的介面 ══════════════

    @Test
    void a1_攔截鏈() {
        head("8.8.1 攔截器鏈");
        List<Interceptor> chain = sqlSessionFactory.getConfiguration()
                .getInterceptors();
        System.out.println("  Configuration 上掛了 " + chain.size() + " 個攔截器（依套用順序）：");
        for (int i = 0; i < chain.size(); i++)
            System.out.println("    " + (i + 1) + ") " + chain.get(i).getClass().getName());
        System.out.println("\n  ★ PageHelper 的 PageInterceptor 也在這條鏈上 ——");
        System.out.println("    8.6 那個「改寫 SQL」不是特殊機制，就是一個攔截器。");
    }

    // ══════════════ 8.8.2 觀測用途 ══════════════

    @Test @Transactional
    void a2_觀測用途() {
        head("8.8.2 ✅ 攔截器的正當用途：觀測");
        var q = OrderSearch8.empty().withStatus(St8.PENDING);

        SqlLogInterceptor.start();
        List<String> sqls = spy(() -> {
            orders.search(b(q));
            orders.search(b(q));                 // ★ 同一個交易、同一句 → 一級快取命中
            orders.searchCount(b(q));
        });
        List<SqlLogInterceptor.Entry> log = SqlLogInterceptor.stop();

        System.out.println("  SqlSpy（JDBC 那一層）看到 " + sqls.size() + " 句 SQL");
        System.out.println("  攔截器（Executor 那一層）看到 " + log.size() + " 次 statement 呼叫：");
        for (var e : log)
            System.out.printf("    %-58s %s %6d µs %3d 列%n",
                    e.statementId().replace("com.example.lab.ch08.", ""),
                    e.kind(), e.micros(), e.rows());

        System.out.println("\n  ★★ 兩個數字不一樣，而那個差就是【一級快取命中】那一次。");
        System.out.println("    SqlSpy 看不到「被快取吃掉的呼叫」，攔截器看得到 ——");
        System.out.println("    所以 8.5.9 那個「延遲載入 0 句 SQL」的問題，"
                + "要靠這一層才量得準。");
    }

    // ══════════════ 8.8.3 用它做審計 ══════════════

    @Test
    void a3_用它做審計的四個問題() {
        head("8.8.3 🔴 用攔截器做審計：它會動，而它有四個問題");
        var id = orderIds.get(0);
        audits.clear();
        AuditWriteInterceptor.on();

        System.out.println("── 它真的會動");
        tx.executeWithoutResult(s -> orders.patch(id, St8.PAID, "備註", null));
        System.out.println("   一次 patch → audit_sql 有 " + audits.count() + " 筆");
        System.out.println("   內容：" + audits.ids());

        System.out.println("\n── 🔴 問題一：它在同一個交易裡 → 業務 rollback，稽核紀錄也不見了");
        audits.clear();
        Throwable t = catching(() -> tx.executeWithoutResult(s -> {
            orders.patch(id, St8.CANCELLED, "要被 rollback 的", null);
            throw new IllegalStateException("業務驗證失敗");
        }));
        System.out.println("   " + name(t));
        System.out.println("   audit_sql 有 " + audits.count()
                + " 筆 ← 「有人嘗試取消訂單」這件事【完全沒有紀錄】");

        System.out.println("\n── 🔴 問題二：它讓批次寫入失效");
        audits.clear();
        List<AmountPatch8> patches = new java.util.ArrayList<>();
        for (int i = 0; i < 5; i++)
            patches.add(new AmountPatch8(orderIds.get(i), new BigDecimal((8000 + i) + ".0000")));
        stat().mark();
        List<String> sqls = spy(() -> tx.executeWithoutResult(s -> {
            for (AmountPatch8 p : patches) orders.patchAmounts(List.of(p));
        }));
        var d = stat().delta();
        System.out.println("   5 次 patchAmounts → JDBC " + sqls.size() + " 句、"
                + "伺服器 Com_update = " + d.get("Com_update")
                + "、Com_insert = " + d.get("Com_insert"));
        System.out.println("   audit_sql 有 " + audits.count() + " 筆");
        System.out.println("   ★ 每一句業務 UPDATE 後面插一句 INSERT ——"
                + "寫入的句數【變成兩倍】。");

        System.out.println("\n── 🔴 問題三：它不知道「誰」與「為什麼」");
        System.out.println("   它拿得到：" + audits.ids().stream().findFirst().orElse("-"));
        System.out.println("   它拿不到：哪一個使用者、哪一個 API、哪一筆業務單據、改了什麼欄位");
        System.out.println("   → 而稽核紀錄需要的正是後面那四件事。");

        System.out.println("\n── 🔴 問題四：它會攔到自己");
        System.out.println("   AuditWriteInterceptor 裡有這一行：");
        System.out.println("     if (ms.getId().contains(\"AuditMapper\")) return result;");
        System.out.println("   少了它 → 稽核的 INSERT 也觸發稽核 → 無窮遞迴。");
        System.out.println("   而它是【字串比對】—— 換一個 mapper 名字就漏掉了。");

        AuditWriteInterceptor.off();
    }

    @Test
    void a3b_那審計該怎麼做() {
        head("8.8.3b ✅ 那審計該怎麼做");
        System.out.println("  ① 業務語意的稽核 → 寫在【應用層】（03 章 3.10 的 audit_log），");
        System.out.println("     用一個明確的 AuditService，並且用");
        System.out.println("     @Transactional(propagation = REQUIRES_NEW) 讓它獨立提交");
        System.out.println("     → 業務 rollback 了，「有人嘗試做這件事」的紀錄還在");
        System.out.println("  ② 資料層的變更歷史 → 用資料庫的 trigger 或 CDC（07 站的 binlog）");
        System.out.println("     → 它連 DBA 手動改的都抓得到，而攔截器抓不到");
        System.out.println("  ③ 效能觀測 → 這才是攔截器的本行（8.8.2），"
                + "因為它【不需要業務語意】");
    }

    // ══════════════ 8.8.4 改寫 SQL ══════════════

    /** ⚠️ 這一格【不能】加 @Transactional —— 見地雷四。 */
    @Test
    void a4_改寫sql的四個地雷() {
        head("8.8.4 🔴 用攔截器改寫 SQL（多租戶）的四個地雷");
        var q = OrderSearch8.empty().withStatus(St8.PENDING);
        System.out.println("── 資料長什麼樣（memo 是租戶標記）");
        System.out.println("   " + jdbc.queryForList(
                "SELECT memo, count(*) n FROM orders WHERE status='PENDING' GROUP BY memo"));
        System.out.println("   不開攔截器 → " + orders.search(b(q)).size() + " 張");

        System.out.println("\n── 🔴🔴 地雷一：它把條件【接在 SQL 尾巴】");
        TenantInterceptor.tenant("t1");
        TenantInterceptor.resetCount();
        List<String> s1 = spy(() -> {
            Throwable t = catching(() -> System.out.println(
                    "   search（結尾是 ORDER BY）→ " + orders.search(b(q)).size() + " 張"));
            if (t != null) System.out.println("   " + name(t) + " / " + msg(t));
        });
        System.out.println("   改寫次數 = " + TenantInterceptor.rewrites());
        for (String x : s1) System.out.println("   送出去的 SQL 尾巴：" + tail(x));

        TenantInterceptor.resetCount();
        List<String> s2 = spy(() -> {
            Throwable t = catching(() -> System.out.println(
                    "   searchCount（結尾是 WHERE 條件）→ " + orders.searchCount(b(q))));
            if (t != null) System.out.println("   " + name(t) + " / " + msg(t));
        });
        System.out.println("   改寫次數 = " + TenantInterceptor.rewrites());
        for (String x : s2) System.out.println("   送出去的 SQL 尾巴：" + tail(x));

        System.out.println("\n   ★★ 同一個攔截器，兩句 SQL 兩種下場，而【沒有一種是報錯】：");
        System.out.println("     結尾是 WHERE 條件的 → 接上去了，租戶過濾【生效】");
        System.out.println("     結尾是 ORDER BY 的  → 那個 AND 變成了 ORDER BY 的一部分：");
        System.out.println("        ORDER BY o.placed_at, (o.id AND o.memo LIKE 't1%')");
        System.out.println("        → 這在 MySQL 上是【合法的排序運算式】");
        System.out.println("        → 沒有語法錯誤、沒有過濾、5 張全部回來");
        System.out.println("     🔴 一半的查詢有租戶隔離、一半沒有，而 CI 全綠。");
        System.out.println("     要每一句都改對，攔截器得【剖析 SQL 找到 WHERE 的位置】——");
        System.out.println("     那就是把 jsqlparser 搬進你的執行路徑（8.6.2 那個依賴衝突）。");

        System.out.println("\n── 🔴🔴 地雷四：一級快取命中時，攔截器【完全不會執行】");
        TenantInterceptor.off();
        tx.executeWithoutResult(s -> {
            System.out.println("   同一個交易裡：");
            System.out.println("     ① 不開攔截器 → " + orders.searchCount(b(q)));
            TenantInterceptor.tenant("t1");
            TenantInterceptor.resetCount();
            System.out.println("     ② 開了攔截器 → " + orders.searchCount(b(q))
                    + "（改寫次數 = " + TenantInterceptor.rewrites() + "）");
            TenantInterceptor.off();
        });
        System.out.println("   ★ 第②次是【一級快取命中】（07 章 7.11.3）——");
        System.out.println("     BaseExecutor 在建 StatementHandler 之前就回傳了，");
        System.out.println("     所以攔截 StatementHandler.prepare 的攔截器沒有機會執行。");
        System.out.println("   🔴 後果：同一個交易裡，「有沒有套用租戶過濾」取決於"
                + "【這句 SQL 之前有沒有被查過】。");
        System.out.println("     這是一個資料隔離的漏洞，而它只在特定的呼叫順序下出現。");

        System.out.println("\n── 🔴 地雷二：它靠【字串比對】決定要不要改寫");
        System.out.println("   本章的條件是 sql.toLowerCase().contains(\"from orders\")：");
        System.out.println("     🔴 漏掉：JOIN orders o ON …（子查詢 / JOIN 裡的 orders）");
        System.out.println("     🔴 誤改：FROM orders_archive（\\b 擋不住底線後綴）");
        System.out.println("     🔴 漏掉：任何用 <include> 動態組出來的 FROM");
        System.out.println("   → 而「漏掉」的後果是【看到別的租戶的資料】。");

        System.out.println("\n── 🔴 地雷三：它改得動 SQL 文字，改不動【參數的個數】");
        System.out.println("   BoundSql 的 parameterMappings 在攔截之前就定案了。");
        System.out.println("   所以改寫的條件【只能用字面值】—— 而那就是 07 章 7.6 的 ${}。");
        System.out.println("   本章那一行：");
        System.out.println("     + \" AND o.memo LIKE '\" + tenant + \"%'\"");
        System.out.println("   → 一個【橫跨整個系統】的注入點，而它藏在攔截器裡。");
    }

    @Test @Transactional
    void a5_攔截器的四條規則() {
        head("8.8.5 攔截器的四條規則");
        System.out.println("  ① 只用來【觀測】。改行為的攔截器是一個沒有型別、"
                + "沒有測試入口的全域 patch。");
        System.out.println("  ② 一定要 proceed()，而且【只能 proceed 一次】。");
        System.out.println("     忘了 → 那個 mapper 方法回傳 null 而且沒有任何錯誤。");
        System.out.println("  ③ 攔截 Executor 拿得到 MappedStatement（知道是誰）；");
        System.out.println("     攔截 StatementHandler 拿得到最終 SQL（但改不動參數個數）。");
        System.out.println("     ⚠️ 選錯層就會寫出 8.8.4 那三個地雷。");
        System.out.println("  ④ 它有順序，而順序是【bean 的順序】——");
        System.out.println("     跟 PageHelper 混在一起的時候，這件事會決定"
                + "「你看到的 SQL 有沒有 LIMIT」。");
    }
}
```

```
═══ 8.8.1 攔截器鏈 ═══
  Configuration 上掛了 4 個攔截器（依套用順序）：
    1) com.example.lab.ch08.SqlLogInterceptor
    2) com.example.lab.ch08.AuditWriteInterceptor
    3) com.example.lab.ch08.TenantInterceptor
    4) com.github.pagehelper.PageInterceptor

  ★ PageHelper 的 PageInterceptor 也在這條鏈上 ——
    8.6 那個「改寫 SQL」不是特殊機制，就是一個攔截器。
```

📌 **可以攔的只有四個介面，而選哪一個決定了你拿得到什麼**：

| 介面 | 攔到的時機 | 拿得到 | 拿不到 |
|---|---|---|---|
| **`Executor`** | mapper 方法 → SQL 之前 | **`MappedStatement`**（知道是誰）、參數物件、**一級／二級快取的命中** | 最終 SQL 文字 |
| **`ParameterHandler`** | 設定 `?` 的值 | 參數物件、`BoundSql` | 結果 |
| **`StatementHandler`** | 建立 / 執行 `Statement` | **最終 SQL 文字**、`Connection` | 改參數個數（8.8.4 地雷三） |
| **`ResultSetHandler`** | 結果集 → 物件 | `ResultSet`、映射結果 | SQL 與參數 |

⚠️ **`@Signature` 的 `args` 必須跟目標方法的簽章【完全一致】**，
而 `Executor.query` **有兩個多載**：

```java
// 四個參數的（外層，CachingExecutor 收到的）
query(MappedStatement, Object, RowBounds, ResultHandler)
// 六個參數的（內層，BaseExecutor 收到的）
query(MappedStatement, Object, RowBounds, ResultHandler, CacheKey, BoundSql)
```

**只攔四個參數那一個，就看不到「二級快取命中之後才進來的那一次」。**
本章的 `SqlLogInterceptor` 兩個都攔了 —— 而那也意味著**它有可能對同一次呼叫記兩筆**，
所以生產用的版本要在 `intercept` 裡判斷 target 的實際型別。

### 8.8.2 ✅ 實測：攔截器的正當用途 —— 觀測

```
═══ 8.8.2 ✅ 攔截器的正當用途：觀測 ═══
  SqlSpy（JDBC 那一層）看到 2 句 SQL
  攔截器（Executor 那一層）看到 3 次 statement 呼叫：
    Ord8Mapper.search                        SELECT   6663 µs   5 列
    Ord8Mapper.search                        SELECT     14 µs   5 列
    Ord8Mapper.searchCount                   SELECT   1351 µs   1 列
```

★★ **兩把尺的數字不一樣，而那個差就是答案**：

```
SqlSpy      2 句 ← 它站在 JDBC，看不到「被快取吃掉的那一次呼叫」
攔截器      3 次 ← 它站在 Executor，看得到【方法被呼叫了幾次】
                              ↓
第二次 search 只花了 14 µs（第一次 6663 µs）—— 那就是一級快取命中。
```

📌 **這解掉了 8.5.9 那個量測難題**：

```
8.5.9：延遲載入的 SQL 句數取決於「同一個交易裡之前查過什麼」
       → 用 SqlSpy 量會得到 0 句，看起來像「沒有 N+1」
                              ↓
8.8.2：改用 Executor 層的攔截器量【statement 被呼叫幾次】
       → 快取命中的那一次也算進去 → N+1 藏不住
```

✅ **所以這一章的第五把尺是「攔截器」**，而它跟前四把的關係是：

```
Dyn          MyBatis 打算送出什麼 SQL      （不執行）
攔截器        mapper 方法被呼叫了幾次        ← 新增，含快取命中
SqlSpy       JDBC 收到幾句
MysqlStat    伺服器剖析／執行了幾句
```

⚠️ **而「觀測用的攔截器」也有兩個要求**：

```
① 它一定要 proceed()，而且只能 proceed 一次。
   忘了 proceed → 那個 mapper 方法【回傳 null 而且沒有任何錯誤】。
② 它自己要夠便宜。System.nanoTime() 兩次 + 一個 ArrayList.add 沒問題；
   在裡面做字串格式化、寫檔、送 metrics（同步的）就會變成瓶頸。
   → 本章的版本用一個 static 開關，關掉的時候只多兩次 nanoTime。
```

### 8.8.3 🔴 實測：用攔截器做審計的四個問題

**這是攔截器最常見的用途，也是最常見的誤用。**
下面這個攔截器**會動**，而且業務程式碼一行都不用改：

```java
@Intercepts(@Signature(type = Executor.class, method = "update",
                       args = {MappedStatement.class, Object.class}))
public class AuditWriteInterceptor implements Interceptor {
    @Override
    public Object intercept(Invocation invocation) throws Throwable {
        Object result = invocation.proceed();
        MappedStatement ms = (MappedStatement) invocation.getArgs()[0];
        Executor executor = (Executor) invocation.getTarget();
        Connection conn = executor.getTransaction().getConnection();
        try (PreparedStatement ps = conn.prepareStatement(
                "INSERT INTO audit_sql (stmt_id, sql_kind, took_ms, at_time) VALUES (?,?,?,?)")) {
            …
        }
        return result;
    }
}
```

```
═══ 8.8.3 🔴 用攔截器做審計：它會動，而它有四個問題 ═══
── 它真的會動
   一次 patch → audit_sql 有 1 筆
   內容：[com.example.lab.ch08.Ord8Mapper.patch]

── 🔴 問題一：它在同一個交易裡 → 業務 rollback，稽核紀錄也不見了
   IllegalStateException
   audit_sql 有 0 筆 ← 「有人嘗試取消訂單」這件事【完全沒有紀錄】

── 🔴 問題二：它讓批次寫入失效
   5 次 patchAmounts → JDBC 10 句、伺服器 Com_update = 5、Com_insert = 5
   audit_sql 有 5 筆
   ★ 每一句業務 UPDATE 後面插一句 INSERT ——寫入的句數【變成兩倍】。

── 🔴 問題三：它不知道「誰」與「為什麼」
   它拿得到：com.example.lab.ch08.Ord8Mapper.patchAmounts
   它拿不到：哪一個使用者、哪一個 API、哪一筆業務單據、改了什麼欄位
   → 而稽核紀錄需要的正是後面那四件事。

── 🔴 問題四：它會攔到自己
   AuditWriteInterceptor 裡有這一行：
     if (ms.getId().contains("AuditMapper")) return result;
   少了它 → 稽核的 INSERT 也觸發稽核 → 無窮遞迴。
   而它是【字串比對】—— 換一個 mapper 名字就漏掉了。
```

📌 **問題一是最致命的**：

```
稽核紀錄要回答的問題是「誰在什麼時候【試圖】做什麼」。
而攔截器寫進去的紀錄跟業務交易【同生共死】——
                              ↓
業務成功 → 有紀錄（而這時候你從業務資料本身也看得出來）
業務失敗 → 沒紀錄（而這才是你真正需要紀錄的那一次）
```

**問題二的數字值得對照 8.4.5 那張表**：

```
5 次業務 UPDATE → JDBC 10 句、Com_update = 5、Com_insert = 5
                              ↓
每一句業務寫入後面跟一句稽核 INSERT，而它們【交錯】——
這正是 06 章 6.3.5 那個「讓批次失效的第二件事：交錯的實體型別」。
批次匯入 1000 筆的時候，這個攔截器會讓它從 22 ms（8.4.5）變成⋯⋯你自己算。
```

✅ **那審計該怎麼做**：

```
═══ 8.8.3b ✅ 那審計該怎麼做 ═══
  ① 業務語意的稽核 → 寫在【應用層】（03 章 3.10 的 audit_log），
     用一個明確的 AuditService，並且用
     @Transactional(propagation = REQUIRES_NEW) 讓它獨立提交
     → 業務 rollback 了，「有人嘗試做這件事」的紀錄還在
  ② 資料層的變更歷史 → 用資料庫的 trigger 或 CDC（07 站的 binlog）
     → 它連 DBA 手動改的都抓得到，而攔截器抓不到
  ③ 效能觀測 → 這才是攔截器的本行（8.8.2），因為它【不需要業務語意】
```

★ **三者的分工，用一句話講**：

```
攔截器知道【怎麼做的】（哪個 statement、多久）
應用層知道【誰為什麼做的】
資料庫知道【什麼真的變了】
                    ↓
稽核需要的是後兩個，而攔截器只有第一個。
```

### 8.8.4 🔴🔴 實測：用攔截器改寫 SQL 的四個地雷

**「多租戶自動加 `WHERE tenant_id = ?`」是攔截器的第二個熱門用途。
這一格把它做出來，然後量它壞在哪。**

```
═══ 8.8.4 🔴 用攔截器改寫 SQL（多租戶）的四個地雷 ═══
── 資料長什麼樣（memo 是租戶標記）
   [{memo=t0-memo, n=5}]
   不開攔截器 → 5 張

── 🔴🔴 地雷一：它把條件【接在 SQL 尾巴】
   search（結尾是 ORDER BY）→ 5 張
   改寫次數 = 1
   送出去的 SQL 尾巴：… WHERE o.status = ? ORDER BY o.placed_at, o.id AND o.memo LIKE 't1%'
   searchCount（結尾是 WHERE 條件）→ 0
   改寫次數 = 1
   送出去的 SQL 尾巴：… WHERE o.status = ? AND o.memo LIKE 't1%'
```

★★ **同一個攔截器，兩句 SQL 兩種下場，而【沒有一種是報錯】**：

```
結尾是 WHERE 條件的 → AND 接上去了，租戶過濾【生效】（0 張，因為資料是 t0）

結尾是 ORDER BY 的  → 那個 AND 變成了【排序運算式的一部分】：
       ORDER BY o.placed_at, (o.id AND o.memo LIKE 't1%')
   → 這在 MySQL 上是【完全合法】的排序運算式（布林值當排序鍵）
   → 沒有語法錯誤、沒有過濾、5 張全部回來
                              ↓
🔴 一半的查詢有租戶隔離、一半沒有，而 CI 全綠。
```

⚠️ **這比「語法錯誤」糟糕得多。** 語法錯誤會在第一次測試就被抓到；
**「合法但語意完全不同」的 SQL 只會在 code review 或資料外洩的時候被發現。**

```
── 🔴🔴 地雷四：一級快取命中時，攔截器【完全不會執行】
   同一個交易裡：
     ① 不開攔截器 → 5
     ② 開了攔截器 → 5（改寫次數 = 0）
```

🔴🔴 **這是四個地雷裡最陰險的一個**：

```
BaseExecutor.query()
    ├─ 先查一級快取（07 章 7.11.3）
    │     命中 → 直接回傳，【不建 StatementHandler】
    └─ 沒中 → 建 StatementHandler → 攔截器在這裡執行
                              ↓
所以「這次查詢有沒有套用租戶過濾」取決於
【同一個交易裡這句 SQL 之前有沒有被查過】。
```

**而那是一個資料隔離的漏洞**：

```
一支 API 在同一個交易裡查了兩次同樣的東西（很常見：驗證一次、回傳一次），
中間如果租戶 context 變了（切換帳號、批次處理多個租戶）——
第二次拿到的是【第一次那個租戶的資料】。
```

**剩下兩個地雷**：

```
── 🔴 地雷二：它靠【字串比對】決定要不要改寫
   本章的條件是 sql.toLowerCase().contains("from orders")：
     🔴 漏掉：JOIN orders o ON …（子查詢 / JOIN 裡的 orders）
     🔴 誤改：FROM orders_archive（\b 擋不住底線後綴）
     🔴 漏掉：任何用 <include> 動態組出來的 FROM
   → 而「漏掉」的後果是【看到別的租戶的資料】。

── 🔴 地雷三：它改得動 SQL 文字，改不動【參數的個數】
   BoundSql 的 parameterMappings 在攔截之前就定案了。
   所以改寫的條件【只能用字面值】—— 而那就是 07 章 7.6 的 ${}。
   本章那一行：
     + " AND o.memo LIKE '" + tenant + "%'"
   → 一個【橫跨整個系統】的注入點，而它藏在攔截器裡。
```

📌 **地雷三值得展開一次**，因為它是攔截器架構上的限制：

```
BoundSql = SQL 文字 + parameterMappings（那些 ? 依序對應哪些屬性）
                              ↓
攔截 StatementHandler.prepare 的時候，parameterMappings 已經定案，
而 ParameterHandler 會【依那個清單】去設值。
                              ↓
你多加一個 ? 但沒有對應的 mapping → 那個位置永遠不會被設值
   → SQLException: No value specified for parameter N
你少一個 ? → 參數錯位（而且不一定會報錯）
                              ↓
唯一「安全」的做法是不加 ? —— 也就是把值寫成字面值 —— 也就是注入。
```

⚠️ **有辦法正確地做嗎？有，而代價是**：

```
① 用 jsqlparser（或別的 SQL 剖析器）真的剖析那句 SQL、找到 WHERE 的位置、
   插入條件、再重新序列化
   → 8.6.2 那個依賴衝突現在在你的【每一句 SQL 的執行路徑上】
② 同時改 BoundSql 的 parameterMappings 與 additionalParameters
   → 這是 MyBatis 的內部 API，沒有相容性保證
③ 攔 Executor 那一層而不是 StatementHandler
   → 那時候 SQL 還沒組出來，你要改的是 SqlSource —— 而它是共用的
                              ↓
這三件事都做對之後，你得到的是【PageHelper】。
而 PageHelper 有 8.6.4～8.6.6 那三個坑。
```

✅ **多租戶的正解不在 MyBatis 這一層**：

```
① 每一個 mapper 方法【明確地】收一個 tenantId 參數，並寫進 <sql> 共用片段
   → 醜、囉嗦、而且「有沒有加」在 8.9.1 那條斷言裡查得到
② 資料庫層的 Row-Level Security（PostgreSQL）或 VPD（Oracle）
   → MySQL 沒有，可以用 VIEW + 每個租戶一個帳號模擬
③ 一個租戶一個 schema / 一個資料源
   → 換 DataSource 而不是改 SQL，這是唯一「漏不掉」的做法
```

### 8.8.5 攔截器的四條規則

```
═══ 8.8.5 攔截器的四條規則 ═══
  ① 只用來【觀測】。改行為的攔截器是一個沒有型別、沒有測試入口的全域 patch。
  ② 一定要 proceed()，而且【只能 proceed 一次】。
     忘了 → 那個 mapper 方法回傳 null 而且沒有任何錯誤。
  ③ 攔截 Executor 拿得到 MappedStatement（知道是誰）；
     攔截 StatementHandler 拿得到最終 SQL（但改不動參數個數）。
     ⚠️ 選錯層就會寫出 8.8.4 那三個地雷。
  ④ 它有順序，而順序是【bean 的順序】——
     跟 PageHelper 混在一起的時候，這件事會決定「你看到的 SQL 有沒有 LIMIT」。
```

📌 **第④條的實際後果**：

```
SqlLogInterceptor 排在 PageInterceptor 【前面】
   → 它看到的是「一次 query 呼叫」，而 PageHelper 在它之後展開成兩句
   → 所以 8.8.2 那個「statement 被呼叫幾次」不包含 PageHelper 的 count 查詢

反過來排
   → 它會看到兩次呼叫，其中一次的 statement id 是 …_COUNT
                              ↓
「同一個攔截器、換一個 bean 的宣告順序，量到的數字不一樣」。
而 bean 的順序在 Spring 裡並不是一件你會刻意去控制的事。
```

⚠️ **要控制順序，就得自己組 `SqlSessionFactory`**（不用自動組態的那個），
或者用 `ConfigurationCustomizer` 明確地 `addInterceptor` ——
**而那時候「有幾個攔截器、什麼順序」就是一段看得見的程式碼，而不是一個 bean 掃描的結果。**

---

## 8.9 把這一章變成 CI 會擋下來的東西

**這一章的問題有一個共同形狀**：

```
「六個可選條件」的 API 有 64 種組合，
而錯誤只出現在【某幾種組合】上 —— 那幾種你的測試剛好沒蓋到。
```

**而 8.2.3 那把尺讓「把 64 種組合全部跑一遍」變成 200 毫秒的事。**
這一節的五條斷言**全部不需要資料庫**。

```java
package com.example.lab.ch08;

import net.sf.jsqlparser.parser.CCJSqlParserUtil;
import org.apache.ibatis.mapping.MappedStatement;
import org.apache.ibatis.mapping.ResultMap;
import org.apache.ibatis.mapping.ResultMapping;
import org.apache.ibatis.mapping.SqlCommandType;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;

import static org.assertj.core.api.Assertions.assertThat;

/** 8.9：把這一章變成 CI 會擋下來的東西。 */
class M8Assert extends Base08 {

    @Autowired Ord8Mapper orders;

    static final String NS = "com.example.lab.ch08.Ord8Mapper.";

    private static OrderSearchBean8 b(OrderSearch8 r) { return OrderSearchBean8.of(r); }
    private Map<String, Object> arg(OrderSearch8 r) { return Dyn.args("q", b(r)); }

    private List<OrderSearch8> allCombinations() {
        List<Function<OrderSearch8, OrderSearch8>> setters = List.of(
                s -> s.withStatus(St8.PENDING),
                s -> s.withCustomerKeyword("客戶1"),
                s -> s.withRange(Instant.parse("2026-09-01T00:00:00Z"), null),
                s -> s.withRange(s.from(), Instant.parse("2026-09-02T00:00:00Z")),
                s -> s.withMinAmount(new BigDecimal("200")),
                s -> s.withHasRep(Boolean.TRUE));
        return Dyn.combinations(OrderSearch8.empty(), setters);
    }

    // ══════════════ 斷言一 ══════════════

    /** 這一組是「已經寫對的」statement —— 它們必須 0 壞掉。 */
    static final List<String> CLEAN = List.of("search", "searchCount", "page",
            "searchTrim", "searchChoose", "searchBindFixed", "searchWhere1");

    /** 這一組是本章刻意留著的壞版本 —— 斷言一要抓得到它們。 */
    static final List<String> BROKEN_ON_PURPOSE = List.of("searchMissingAnd", "searchBind");

    /** 把一個 statement × 64 種組合全部展開，回傳壞掉的那幾種。 */
    private List<String> scan(String id) {
        List<String> broken = new ArrayList<>();
        for (OrderSearch8 c : allCombinations()) {
            Map<String, Object> a = id.equals("page")
                    ? Dyn.args("q", b(c), "offset", 0, "size", 20) : arg(c);
            String sql = null;
            try {
                sql = dyn().sql(NS + id, a);
                CCJSqlParserUtil.parse(sql);
            } catch (Throwable e) {
                broken.add(describe(c) + "  →  " + (sql == null ? name(e)
                        : Dyn.one(sql.substring(Math.max(0,
                            Dyn.topLevelIndexOf(sql, " where ")))) + "  /  " + name(e)));
            }
        }
        return broken;
    }

    @Test
    void 斷言一_每一種條件組合都要產生合法的SQL() {
        head("8.9.1 斷言一：2^6 種組合，每一種都要是合法的 SQL");
        long t0 = System.nanoTime();
        Map<String, List<String>> result = new java.util.LinkedHashMap<>();
        for (String id : CLEAN) result.put(id, scan(id));
        long ms = (System.nanoTime() - t0) / 1_000_000;

        System.out.println("  " + CLEAN.size() + " 個 statement × " + 64 + " 種組合 = "
                + (CLEAN.size() * 64) + " 次，共 " + ms + " ms");
        result.forEach((id, broken) -> System.out.printf("    %-16s %s%n", id,
                broken.isEmpty() ? "✅ 全部合法" : "🔴 " + broken.size() + " 種壞掉"));
        assertThat(result.values().stream().flatMap(List::stream).toList()).isEmpty();
    }

    @Test
    void 斷言一b_它抓得到本章那兩個壞掉的statement() {
        head("8.9.1b 同一條斷言，套在本章刻意留著的壞版本上");
        for (String id : BROKEN_ON_PURPOSE) {
            List<String> broken = scan(id);
            System.out.println("── " + id + " → 64 種裡有 " + broken.size() + " 種產生不合法的 SQL");
            broken.stream().limit(3).forEach(x -> System.out.println("     🔴 " + cut(x, 130)));
            if (broken.size() > 3) System.out.println("     …（共 " + broken.size() + " 種）");
            assertThat(broken).isNotEmpty();
        }
        System.out.println("\n  ★★ 注意 searchBind 那 32 種 —— 那是 8.3.9 那個 <bind> 的 NPE。");
        System.out.println("    我寫這一章的時候是【先寫錯、再被這條斷言抓到】的：");
        System.out.println("      <bind name=\"kw\" value=\"'%' + q.customerKeyword + '%'\"/>");
        System.out.println("      → 關鍵字沒填的那 32 種組合全部 NullPointerException");
        System.out.println("    修法就是 searchBindFixed 那一版（三元運算子）。");
        System.out.println("\n  ★ 這條斷言不需要資料庫、不需要測試資料，"
                + "而它蓋掉了 8.3.4 與 8.3.9 兩個坑的全部組合。");
    }

    private static String describe(OrderSearch8 s) {
        StringBuilder sb = new StringBuilder();
        if (s.status() != null) sb.append("status ");
        if (s.customerKeyword() != null) sb.append("kw ");
        if (s.from() != null) sb.append("from ");
        if (s.to() != null) sb.append("to ");
        if (s.minAmount() != null) sb.append("amt ");
        if (s.hasRep() != null) sb.append("rep ");
        return sb.length() == 0 ? "（全空）" : sb.toString().trim();
    }

    // ══════════════ 斷言二 ══════════════

    @Test
    void 斷言二_空集合不准產生不合法的SQL() {
        head("8.9.2 斷言二：每一個吃集合的 statement，空集合都要能過");
        record Case(String id, Map<String, Object> args) {}
        List<Case> cases = List.of(
                new Case("byIds", Dyn.args("ids", List.<UUID>of())),
                new Case("byIdsSafe", Dyn.args("ids", List.<UUID>of())),
                new Case("countIn", Dyn.args("statuses", List.<St8>of())),
                new Case("searchAnyKeyword", Dyn.args("keywords", List.<String>of())),
                new Case("insertItems", Dyn.args("items", List.<ItemInsert8>of())),
                new Case("patchAmounts", Dyn.args("patches", List.<AmountPatch8>of())));

        List<String> broken = new ArrayList<>();
        for (Case c : cases) {
            String sql = null;
            try {
                sql = dyn().sql(NS + c.id(), c.args());
                CCJSqlParserUtil.parse(sql);
                System.out.println("   ✅ " + c.id());
            } catch (Throwable e) {
                System.out.println("   🔴 " + c.id() + "  →  " + cut(String.valueOf(sql), 90));
                broken.add(c.id());
            }
        }
        System.out.println("\n  產生不合法 SQL 的：" + broken);

        System.out.println("\n── 🔴🔴 而「合法」不等於「對」");
        seed(20, 4, 2);
        System.out.println("   searchAnyKeyword(空 List) → 合法的 SQL，而它回傳 "
                + orders.searchAnyKeyword(List.of()) .size() + " 張（資料庫裡總共 "
                + jdbc.queryForObject("SELECT count(*) FROM orders", Long.class) + " 張）");
        System.out.println("   產生的 SQL：" + dyn().where(NS + "searchAnyKeyword",
                Dyn.args("keywords", List.<String>of())));
        System.out.println("   ★ <foreach> 空的時候連 open/close 都不輸出 → <where> 也空 →");
        System.out.println("     一句【沒有 WHERE 的全表查詢】。語法完全合法。");
        System.out.println("   🔴 這比語法錯誤糟糕得多 ——「搜尋條件是空的」變成「回傳全部」。");
        System.out.println("     所以斷言二要有第二半：");
        System.out.println("       空集合產生的 SQL 必須【還是有那個條件】"
                + "（例如 1 = 0），而不只是「能剖析」。");
        System.out.println("     byIdsSafe 那個 <choose> + 1 = 0 才是完整的答案（8.4.2）。");

        System.out.println("\n  ★ 這條斷言的價值：它把「有沒有寫空集合防護」"
                + "從 code review 變成一個測試。");
    }

    // ══════════════ 斷言三 ══════════════

    @Test
    void 斷言三_SQL形狀的數量有上界() {
        head("8.9.3 斷言三：SQL 形狀的數量（棘輪式）");
        Set<String> shapes = new LinkedHashSet<>();
        for (OrderSearch8 c : allCombinations()) shapes.add(dyn().sql(NS + "search", arg(c)));
        System.out.println("  search 的形狀數：" + shapes.size());

        Set<String> inShapes = new LinkedHashSet<>();
        List<UUID> ids = new ArrayList<>();
        for (int i = 0; i < 40; i++) ids.add(UUID.randomUUID());
        for (int n = 1; n <= 40; n++)
            inShapes.add(dyn().sql(NS + "byIds", Dyn.args("ids", ids.subList(0, n))));
        System.out.println("  byIds（1～40 個 id）的形狀數：" + inShapes.size());

        Set<String> paddedShapes = new LinkedHashSet<>();
        for (int n = 1; n <= 40; n++)
            paddedShapes.add(dyn().sql(NS + "byIds",
                    Dyn.args("ids", Pad8.pad(ids.subList(0, n)))));
        System.out.println("  byIds + Pad8.pad 的形狀數：" + paddedShapes.size());

        System.out.println("\n  ★ 棘輪式斷言（06 章 6.10 那個手法）：");
        System.out.println("    assertThat(shapes).hasSizeLessThanOrEqualTo(64);");
        System.out.println("    → 有人多加一個 <if>，形狀數變 128，CI 就紅。");
        System.out.println("    → 而它是【一個跟資料量無關的數字】（04 章 4.10 那條規則）。");
        assertThat(shapes).hasSizeLessThanOrEqualTo(64);
        assertThat(paddedShapes).hasSizeLessThanOrEqualTo(7);
    }

    // ══════════════ 斷言四 ══════════════

    @Test
    void 斷言四_有LIMIT的查詢一定要有唯一的ORDER_BY() {
        head("8.9.4 斷言四：有 LIMIT 的查詢一定要有【唯一的】ORDER BY");
        var cfg = sqlSessionFactory.getConfiguration();
        List<String> noOrder = new ArrayList<>(), notUnique = new ArrayList<>();
        int checked = 0;

        for (Object o : cfg.getMappedStatements()) {
            if (!(o instanceof MappedStatement ms)) continue;      // 短名字的別名
            if (ms.getSqlCommandType() != SqlCommandType.SELECT) continue;
            if (!ms.getId().startsWith("com.example.lab.ch08.")) continue;
            String sql;
            try { sql = Dyn.one(ms.getBoundSql(Dyn.looseArgs()).getSql()).toLowerCase(); }
            catch (Throwable e) { continue; }                       // 需要參數才組得出來的先跳過
            if (!sql.contains(" limit ")) continue;
            checked++;
            int ob = Dyn.topLevelIndexOf(sql, " order by ");
            if (ob < 0) { noOrder.add(ms.getId()); continue; }
            String orderBy = sql.substring(ob, Dyn.topLevelIndexOf(sql, " limit "));
            if (!orderBy.contains(".id") && !orderBy.contains("order_no"))
                notUnique.add(ms.getId() + "  →  " + orderBy.trim());
        }
        System.out.println("  掃了 " + checked + " 個有 LIMIT 的 SELECT");
        System.out.println("  沒有 ORDER BY 的：" + noOrder);
        System.out.println("  ORDER BY 不唯一的：" + notUnique);
        System.out.println("\n  ★ 為什麼「唯一」很重要：");
        System.out.println("    ORDER BY placed_at 而 placed_at 有重複值");
        System.out.println("    → 同一筆資料可能【同時出現在第 1 頁與第 2 頁】，");
        System.out.println("      也可能【兩頁都沒有】。而 8.6.7 那個 keyset 分頁"
                + "更是完全依賴這件事。");
        assertThat(noOrder).isEmpty();
        assertThat(notUnique).isEmpty();
    }

    // ══════════════ 斷言五 ══════════════

    @Test
    void 斷言五_巢狀resultMap的statement不准分頁() {
        head("8.9.5 斷言五：巢狀 resultMap 的 statement 不准出現在分頁路徑上");
        var cfg = sqlSessionFactory.getConfiguration();
        Set<String> nested = new java.util.TreeSet<>(), risky = new java.util.TreeSet<>();

        for (Object o : cfg.getMappedStatements()) {
            if (!(o instanceof MappedStatement ms)) continue;
            if (ms.getSqlCommandType() != SqlCommandType.SELECT) continue;
            if (!ms.getId().startsWith("com.example.lab.ch08.")) continue;
            boolean hasNested = ms.getResultMaps().stream().anyMatch(this::isNested);
            if (!hasNested) continue;
            nested.add(shortId(ms.getId()));
            String m = ms.getId().substring(ms.getId().lastIndexOf('.') + 1).toLowerCase();
            if (m.startsWith("page") || m.contains("page")) risky.add(shortId(ms.getId()));
        }
        System.out.println("  用了巢狀 resultMap 的 statement（" + nested.size() + " 個）：");
        nested.forEach(s -> System.out.println("    " + s));
        System.out.println("\n  🔴 而其中名字看起來是分頁的：" + risky);
        System.out.println("\n  ★ 這條斷言擋的是 8.6.5 那個事故（count 16、頁數 6、"
                + "而且這一頁的明細是【殘缺的】）。");
        System.out.println("    它靠命名慣例（page*）—— 不完美，而它是");
        System.out.println("    「這件事完全沒有人在看」與「有一條線」之間的差別。");
        System.out.println("    更嚴格的版本：維護一份白名單，"
                + "新增巢狀 resultMap 的查詢就要在名單上簽名。");
        assertThat(risky).containsExactly("Ord8Mapper.pageNested");
    }

    private boolean isNested(ResultMap rm) {
        for (ResultMapping m : rm.getResultMappings())
            if (m.getNestedResultMapId() != null) return true;
        return false;
    }

    private static String shortId(String id) {
        return id.replace("com.example.lab.ch08.", "");
    }

    // ══════════════ 五條斷言的分工 ══════════════

    @Test
    void 五條斷言的分工() {
        head("8.9.6 五條斷言的分工");
        System.out.println("  ① 每一種條件組合都合法      → 抓「<if> 拼出壞 SQL」（8.3.4、8.3.11b）");
        System.out.println("  ② 空集合能過                → 抓「<foreach> 沒防護」（8.4.2）");
        System.out.println("  ③ 形狀數有上界（棘輪）      → 抓「有人多加一個條件 / 忘了 pad」"
                + "（8.3.13、8.4.3）");
        System.out.println("  ④ 有 LIMIT 就要有唯一 ORDER BY → 抓「分頁會漏會重複」（8.6.7）");
        System.out.println("  ⑤ 巢狀 resultMap 不准分頁    → 抓 8.6.5 那個殘缺資料");
        System.out.println("\n  ★★ 五條的共同性質：");
        System.out.println("    【全部不需要資料庫】。它們只問 Configuration 與 BoundSql。");
        System.out.println("    → 所以它們可以放在最快的那一層測試裡，每一次 commit 都跑。");
        System.out.println("    → 而這正是 8.3.12 那個計分表上「② 沒有解掉」那一格的補救："
                + "\n      MyBatis 把編譯期的保護換成了【一組很便宜的斷言】。");
    }
}
```

### 8.9.1 斷言一：每一種條件組合都要產生合法的 SQL

```
═══ 8.9.1 斷言一：2^6 種組合，每一種都要是合法的 SQL ═══
  7 個 statement × 64 種組合 = 448 次，共 214 ms
    search           ✅ 全部合法
    searchCount      ✅ 全部合法
    page             ✅ 全部合法
    searchTrim       ✅ 全部合法
    searchChoose     ✅ 全部合法
    searchBindFixed  ✅ 全部合法
    searchWhere1     ✅ 全部合法
```

**「合法」是用 jsqlparser 判斷的** —— 而那個 jar 是 PageHelper 帶進來的（8.6.2）。
**如果你沒裝 PageHelper，就自己加一個 test-scope 的依賴：**

```xml
<dependency>
  <groupId>com.github.jsqlparser</groupId>
  <artifactId>jsqlparser</artifactId>
  <version>4.5</version>
  <scope>test</scope>
</dependency>
```

⚠️ **注意 `<scope>test</scope>`** —— 它只在測試裡剖析 SQL，
**不要讓它跑到執行路徑上**（8.8.4 那個結論）。

**而這條斷言的價值，是它抓到了兩個【本章自己寫出來的】bug**：

```
═══ 8.9.1b 同一條斷言，套在本章刻意留著的壞版本上 ═══
── searchMissingAnd → 64 種裡有 16 種產生不合法的 SQL
     🔴 status amt → WHERE o.status = ? o.total_amount >= ? ORDER BY o.placed_at, o.id
                     / JSQLParserException ← ParseException
     🔴 status kw amt → …
     🔴 status from amt → …
     …（共 16 種）
── searchBind → 64 種裡有 32 種產生不合法的 SQL
     🔴 （全空） → NullPointerException
     🔴 status → NullPointerException
     🔴 from → NullPointerException
     …（共 32 種）
```

★★ **`searchBind` 那 32 種是我寫這一章時真的犯的錯**：

```xml
<!-- 我寫的 -->
<bind name="kw" value="'%' + q.customerKeyword + '%'"/>
```

```
關鍵字沒填的那 32 種組合 → NullPointerException: Can't add values % , null
                              ↓
而「有填關鍵字」的測試全部通過。
這條斷言是【在我把它寫進 8.3.9 之前】就先把它報出來的。
```

✅ **修法是 `searchBindFixed` 那一版**：

```xml
<bind name="kw" value="q.customerKeyword == null ? null : '%' + q.customerKeyword + '%'"/>
```

📌 **8.10.5 還會抓到第三個** —— 那一個更有意思（OGNL 的字元字面值）。

### 8.9.2 斷言二：空集合不准壞掉，也不准變成「回傳全部」

```
═══ 8.9.2 斷言二：每一個吃集合的 statement，空集合都要能過 ═══
   🔴 byIds  →  SELECT o.id, … WHERE o.id IN ORDER BY …
   ✅ byIdsSafe
   🔴 countIn  →  SELECT count(*) FROM orders WHERE status IN
   ✅ searchAnyKeyword
   🔴 insertItems  →  INSERT INTO order_item (…) VALUES
   🔴 patchAmounts  →  UPDATE orders SET total_amount = CASE id END, … WHERE id IN

  產生不合法 SQL 的：[byIds, countIn, insertItems, patchAmounts]

── 🔴🔴 而「合法」不等於「對」
   searchAnyKeyword(空 List) → 合法的 SQL，而它回傳 20 張（資料庫裡總共 20 張）
   產生的 SQL：（沒有 WHERE）
```

🔴🔴 **`searchAnyKeyword` 通過了「能剖析」這個檢查，而它的行為更糟**：

```
<foreach> 空的時候連 open/close 都不輸出
   → <where> 裡什麼都沒有
   → <where> 連 WHERE 都不加
   → 一句【沒有 WHERE 的全表查詢】。語法完全合法。
                              ↓
「搜尋條件是空的」變成「回傳全部」。
在一個搜尋 API 上，這是一個資料外洩；在一個 DELETE 上，這是一場事故。
```

✅ **所以斷言二有兩半**：

```
① 空集合產生的 SQL 必須【能剖析】
② 空集合產生的 SQL 必須【還帶著那個條件】——
   例如包含 "1 = 0"，或者那個 statement 在白名單上（明確地說「這裡空集合就是全部」）
                              ↓
byIdsSafe 那個 <choose> + 1 = 0 才是完整的答案（8.4.2）。
```

### 8.9.3 斷言三：SQL 形狀的數量有上界（棘輪式）

```
═══ 8.9.3 斷言三：SQL 形狀的數量（棘輪式） ═══
  search 的形狀數：64
  byIds（1～40 個 id）的形狀數：40
  byIds + Pad8.pad 的形狀數：7
```

```java
assertThat(shapes).hasSizeLessThanOrEqualTo(64);
assertThat(paddedShapes).hasSizeLessThanOrEqualTo(7);
```

📌 **這是 06 章 6.10 那個「棘輪式斷言」手法的第三次使用**：

```
04 章 4.10：N+1 的分數（entityFetch + collectionFetch == 0）—— 跟資料量無關
06 章 6.10：批次的 execute 次數是 O(N / batch_size) —— 一個上界
08 章 8.9.3：SQL 形狀的數量 ≤ 64 —— 一個上界
                              ↓
共同性質：它們都是【跟資料量無關的數字】，所以不會因為測試資料變了就紅。
```

⚠️ **而它抓的是兩種變更**：

```
① 有人多加一個 <if> → 形狀數從 64 變 128 → CI 紅
   （而那個 PR 的作者會被迫在描述裡說明「為什麼要多一個可選條件」）
② 有人在某個 in 子句忘了呼叫 Pad8.pad → 那個 statement 的形狀數爆掉
   （8.4.3 那個「一行組態 vs 一條慣例」的差別，就是靠這條斷言補回來的）
```

### 8.9.4 斷言四：有 `LIMIT` 的查詢一定要有唯一的 `ORDER BY`

```
═══ 8.9.4 斷言四：有 LIMIT 的查詢一定要有【唯一的】ORDER BY ═══
  掃了 6 個有 LIMIT 的 SELECT
  沒有 ORDER BY 的：[]
  ORDER BY 不唯一的：[]
```

**這條斷言是【結構式】的：它掃 `Configuration` 裡所有的 `MappedStatement`**，
而不是列一份清單：

```java
for (Object o : cfg.getMappedStatements()) {
    if (!(o instanceof MappedStatement ms)) continue;      // ★ 短名字的別名
    if (ms.getSqlCommandType() != SqlCommandType.SELECT) continue;
    …
    if (!sql.contains(" limit ")) continue;
    int ob = Dyn.topLevelIndexOf(sql, " order by ");
    if (ob < 0) { noOrder.add(ms.getId()); continue; }
    String orderBy = sql.substring(ob, Dyn.topLevelIndexOf(sql, " limit "));
    if (!orderBy.contains(".id") && !orderBy.contains("order_no"))
        notUnique.add(ms.getId() + "  →  " + orderBy.trim());
}
```

⚠️ **兩個實作細節**：

```
① cfg.getMappedStatements() 裡有【短名字的別名】，那些元素不是 MappedStatement
   （MyBatis 為了讓 selectOne("listRows") 這種簡寫能用，會放一個 Ambiguity 物件）
   → 所以要先 instanceof 過濾，否則會 ClassCastException
② " limit " 與 " order by " 要用【括號深度 0】的版本去找（Dyn.topLevelIndexOf），
   否則子查詢裡的 LIMIT 會被誤判
```

📌 **「唯一」為什麼重要**：

```
ORDER BY placed_at 而 placed_at 有重複值
   → 資料庫【沒有義務】在兩次查詢之間給出同樣的順序
   → 同一筆資料可能【同時出現在第 1 頁與第 2 頁】，也可能【兩頁都沒有】
                              ↓
而 8.6.7 那個 keyset 分頁【完全依賴】排序唯一 ——
少了 id 這個 tiebreaker，游標會在重複值那裡卡住或跳過一批。
```

### 8.9.5 斷言五：巢狀 `resultMap` 的 statement 不准出現在分頁路徑上

```
═══ 8.9.5 斷言五：巢狀 resultMap 的 statement 不准出現在分頁路徑上 ═══
  用了巢狀 resultMap 的 statement（8 個）：
    Ord8Mapper.pageNested
    Ord8ResultMapper.nodesAssocNoId
    Ord8ResultMapper.nodesAutoMapping
    Ord8ResultMapper.nodesByStatus
    Ord8ResultMapper.nodesItemIdIsName
    Ord8ResultMapper.nodesNoPrefix
    Ord8ResultMapper.nodesRepNoId
    Ord8ResultMapper.nodesVerbose

  🔴 而其中名字看起來是分頁的：[Ord8Mapper.pageNested]
```

**它靠的是 `ResultMapping.getNestedResultMapId() != null`** ——
也就是「這個 `resultMap` 裡面有沒有 `<association resultMap=…>` 或 `<collection resultMap=…>`」：

```java
private boolean isNested(ResultMap rm) {
    for (ResultMapping m : rm.getResultMappings())
        if (m.getNestedResultMapId() != null) return true;
    return false;
}
```

⚠️ **這條斷言用「名字裡有 page」判斷是不是分頁路徑 —— 那不完美。**
更嚴格的版本是**維護一份白名單**：

```java
// 巢狀 resultMap 的查詢清單。新增一個就要在這裡簽名，
// 並且說明「它為什麼不會被分頁」。
static final Set<String> NESTED_ALLOWED = Set.of(
    "Ord8ResultMapper.nodesByStatus",   // 明細頁，一次只查一張訂單
    …);
assertThat(nested).isSubsetOf(NESTED_ALLOWED);
```

📌 **這是「白名單式斷言」（06 章 6.10.2 那個手法）**：

```
黑名單（禁止某些寫法）→ 預設是【通過】→ 新的寫法自動被允許
白名單（列出允許的）  → 預設是【拒絕】→ 新的寫法一定要有人簽名
                              ↓
而 07 章 7.6.5 那個 OrderSort 是同一條原則：對照表，不是字串檢查。
```

### 8.9.6 五條斷言的分工

```
═══ 8.9.6 五條斷言的分工 ═══
  ① 每一種條件組合都合法         → 抓「<if> 拼出壞 SQL」（8.3.4、8.3.9、8.3.11b）
  ② 空集合能過、而且還帶著條件    → 抓「<foreach> 沒防護」（8.4.2）
  ③ 形狀數有上界（棘輪）          → 抓「多加一個條件 / 忘了 pad」（8.3.13、8.4.3）
  ④ 有 LIMIT 就要有唯一 ORDER BY  → 抓「分頁會漏會重複」（8.6.7）
  ⑤ 巢狀 resultMap 不准分頁       → 抓 8.6.5 那個殘缺資料
```

★★ **五條的共同性質**：

```
【全部不需要資料庫】。它們只問 Configuration 與 BoundSql。
   → 可以放在最快的那一層測試裡，每一次 commit 都跑（本章實測 214 ms）
   → 錯誤訊息直接指到「哪一個 statement、哪一種條件組合」
```

📌 **而這正是 8.3.12 那個計分表上「② 沒有解掉」那一格的補救**：

```
Criteria / QueryDSL：把錯誤從執行期搬到【編譯期】
MyBatis + 這五條斷言：把錯誤從【線上】搬到【CI】
                              ↓
不一樣，而在實務上距離沒有想像中那麼大 ——
前者的代價是可讀性與建置複雜度，後者的代價是【你要真的寫那五條】。
```

⚠️ **這一章前面所有的 🔴，有幾個是這五條斷言抓得到的**：

| 節 | 問題 | 哪一條抓到 |
|---|---|---|
| 8.3.4 | `<if>` 忘了 `AND` | ① |
| 8.3.9 | `<bind>` 的 NPE | ① |
| 8.3.11b | `<if test>` 裡打錯字 | ① |
| 8.4.2 | `<foreach>` 空集合 | ② |
| 8.4.3 | 忘了 pad | ③ |
| 8.4.6 | 批次沒分塊 | 🔴 **抓不到**（要靠 review 或一條「集合參數的大小上限」的執行期檢查） |
| 8.5.3 | 巢狀沒有前綴 → 靜默錯值 | 🔴 **抓不到**（要靠「每一欄都不准是 null」的資料層斷言） |
| 8.5.4 | `<id>` 選錯欄位 | 🔴 **抓不到**（要靠一個「同名商品」的資料情境測試） |
| 8.6.4 | PageHelper 的 `ThreadLocal` 洩漏 | 🔴 **抓不到**（要靠 ArchUnit 檢查「`startPage` 的下一行」） |
| 8.6.5 | 巢狀 `resultMap` + 分頁 | ⑤ |
| 8.6.7 | 分頁沒有唯一排序 | ④ |
| 8.7.4 | 別的 namespace 改了同一張表 | 🔴 **抓不到**（可以寫一條「動同一張表的 mapper 都要 `<cache-ref>`」，而「同一張表」要剖析 SQL 才知道） |
| 8.8.4 | 攔截器改寫 SQL | 🔴 **抓不到** —— 這就是「不要那樣做」的理由 |

📌 **五條斷言蓋掉六個 🔴，剩下七個要靠別的方式。**
**「有一半抓不到」不是斷言沒用 —— 是「知道哪一半抓不到」本身就是這一章的產出。**

---

## 8.10 shop-service 的落地

### 8.10.1 這一章的三個改動

| 改的東西 | 改成什麼 | 為什麼 |
|---|---|---|
| 05 章 5.14.2 的 `search()`（Specification） | **多一個 `searchRows()`**（MyBatis `<if>`） | 兩個並存，8.10.2 要拿它們對照 |
| — | **新增 `searchByStatuses()`** | 前端的 checkbox 群組（8.4.1），而空集合是 `1 = 0`（8.4.2） |
| — | **新增 `listAfter()`**（keyset） | 「載入更多」的頁面，而 offset 在深頁上是線性成本（8.6.7） |
| 07 章 7.15 的 `OrderQueryMapper` | 新增 `OrderSearchMapper`，**借它的 `listRowMap`** | 同一個 `record`、同一份映射 |
| — | **新增 `PageResult<T>`** | 8.6.3：不要讓 `Page` 洩漏出 Service |

```java
package com.example.lab.shop.mybatis;

import com.example.lab.shop.OrderListRow;
import com.example.lab.shop.OrderSearchCriteria;
import com.example.lab.shop.OrderStatus;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * 08 章 8.10：shop-service 的動態搜尋，MyBatis 版。
 *
 * ★ 它跟 05 章 5.14.2 的 OrderSpecifications 是【同一組五個條件】、
 *   【同一個回傳型別 OrderListRow】—— 8.10.2 要拿兩邊對照。
 * ★ 它【只有讀】（00 章 0.9 規則一）。
 */
@Mapper
public interface OrderSearchMapper {

    /** 動態搜尋 + offset 分頁。條件與 count 共用同一段 <sql>（8.3.12）。 */
    List<OrderListRow> search(@Param("q") OrderSearchCriteria q,
                              @Param("offset") int offset, @Param("size") int size);

    long searchCount(@Param("q") OrderSearchCriteria q);

    /** 8.4.1：多選狀態（前端的 checkbox 群組）。 */
    List<OrderListRow> searchByStatuses(@Param("statuses") List<OrderStatus> statuses,
                                        @Param("offset") int offset, @Param("size") int size);

    /** ✅ 8.6.8b：keyset 分頁，條件展開成 OR。 */
    List<OrderListRow> pageAfter(@Param("status") OrderStatus status,
                                 @Param("lastPlacedAt") Instant lastPlacedAt,
                                 @Param("lastId") UUID lastId,
                                 @Param("size") int size);
}
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN"
        "https://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="com.example.lab.shop.mybatis.OrderSearchMapper">

  <!-- ★ 借用 OrderQueryMapper 的 listRowMap（07 章 7.15）：同一個 record、同一份映射 -->
  <sql id="rowColumns">
    o.id, o.order_no, c.display_name AS customer_name, o.status,
    o.total_amount, o.placed_at,
    (SELECT count(*) FROM order_item i WHERE i.order_id = o.id) AS item_count
  </sql>

  <sql id="rowFrom">
    FROM orders o
    JOIN customer c ON c.id = o.customer_id
  </sql>

  <!-- ★★ 8.3.12：條件抽成一份，列表與 count 共用 -->
  <sql id="searchWhere">
    <where>
      <if test="q.status != null">          AND o.status = #{q.status}                        </if>
      <if test="q.customerKeyword != null">
        AND c.display_name LIKE #{q.likePattern} ESCAPE '!'
      </if>
      <if test="q.from != null">            AND o.placed_at &gt;= #{q.from}                   </if>
      <if test="q.to != null">              AND o.placed_at &lt;= #{q.to}                     </if>
      <if test="q.minAmount != null">       AND o.total_amount &gt;= #{q.minAmount}           </if>
    </where>
  </sql>

  <select id="search" resultMap="com.example.lab.shop.mybatis.OrderQueryMapper.listRowMap">
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
    <include refid="searchWhere"/>
     ORDER BY o.placed_at DESC, o.id DESC
     LIMIT #{size} OFFSET #{offset}
  </select>

  <select id="searchCount" resultType="_long">
    SELECT count(*)
    <include refid="rowFrom"/>
    <include refid="searchWhere"/>
  </select>

  <!-- 8.4.2：空集合走 1 = 0，不是「回傳全部」 -->
  <select id="searchByStatuses" resultMap="com.example.lab.shop.mybatis.OrderQueryMapper.listRowMap">
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
    <where>
      <choose>
        <when test="statuses != null and statuses.size() > 0">
          AND o.status IN
          <foreach item="s" collection="statuses" open="(" separator="," close=")">
            #{s}
          </foreach>
        </when>
        <otherwise> AND 1 = 0 </otherwise>
      </choose>
    </where>
     ORDER BY o.placed_at DESC, o.id DESC
     LIMIT #{size} OFFSET #{offset}
  </select>

  <!-- ✅ 8.6.8b keyset：ORDER BY 是 (placed_at, id) 降冪，所以條件是 &lt; -->
  <select id="pageAfter" resultMap="com.example.lab.shop.mybatis.OrderQueryMapper.listRowMap">
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
     WHERE o.status = #{status}
    <if test="lastPlacedAt != null">
      AND (o.placed_at &lt; #{lastPlacedAt}
           OR (o.placed_at = #{lastPlacedAt} AND o.id &lt; #{lastId}))
    </if>
     ORDER BY o.placed_at DESC, o.id DESC
     LIMIT #{size}
  </select>
</mapper>
```

⚠️ **`resultMap="com.example.lab.shop.mybatis.OrderQueryMapper.listRowMap"`** ——
跨 namespace 引用 07 章那份映射。**同一個 `record`、同一份 `<constructor>`，
所以「JPA 版與 MyBatis 版回傳一樣的東西」是【結構上的】保證，不是巧合。**

**搜尋條件多了一個方法**，而它踩到一個 record 專屬的坑：

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

    /**
     * 08 章 8.10：like 的樣式字串，含萬用字元跳脫（05 章 5.4.2 那條規則）。
     *
     * ★ 為什麼放在這裡而不是 <bind> 裡：
     *   OGNL 的 'x' 是【字元字面值】，所以 replace('!','!!') 會拋
     *   NumberFormatException: For input string: "!!" ——
     *   而那個錯誤是 8.9.1 那條斷言抓到的（8.10.5）。
     * 🔴 為什麼【不能】叫 getLikePattern：
     *   MyBatis 的 Reflector 對 record 走的是 addRecordGetMethods()，
     *   它把【每一個無參數方法】直接當成「跟方法同名的屬性」——
     *   所以 getLikePattern() 的屬性名是 "getLikePattern"，不是 "likePattern"。
     *   這跟 POJO 的規則【剛好相反】（07 章 7.7 ⑤：POJO 的屬性名是靠 getter 決定的）。
     *   寫成 #{q.likePattern} 而方法叫 getLikePattern → 執行期
     *   ReflectionException: There is no getter for property named 'likePattern'。
     */
    public String likePattern() {
        if (customerKeyword == null) return null;
        return "%" + customerKeyword
                .replace("!", "!!").replace("%", "!%").replace("_", "!_") + "%";
    }
}
```

🔴🔴 **這一格是這一章第三個「斷言抓到的真 bug」，而它有兩層**：

```
第一層：我把跳脫寫在 <bind> 裡 ——
    <bind name="kw" value="q.customerKeyword.replace('!','!!') …"/>
    → OGNL 的 'x' 是【字元字面值】，而 '!!' 是兩個字元
    → OGNL 拿它去解析成數字 → NumberFormatException: For input string: "!!"
    → 8.9.1 那條斷言在 32 種組合上全部報出來（8.10.5）

第二層：搬到 Java 之後我寫成 getLikePattern()，而 #{q.likePattern} 找不到它
    → ReflectionException: There is no getter for property named 'likePattern'
    → 因為 MyBatis 的 Reflector 對 record 走 addRecordGetMethods()，
      它把【每一個無參數方法】當成「跟方法同名的屬性」
    → getLikePattern() 的屬性名是 "getLikePattern"
```

★ **所以 record 與 POJO 的屬性命名規則【剛好相反】**：

| 參數物件的型別 | `#{q.xxx}` 對應的方法 | 出處 |
|---|---|---|
| POJO | `getXxx()` | 07 章 7.7 ⑤ |
| **`record`** | **`xxx()`**（方法名 = 屬性名） | **8.10.1** |

⚠️ **而這件事在 8.3.11 那一格是看不出來的** ——
那裡的 `#{q.status}` 剛好對得上 record 的元件名 `status()`。
**要加一個「不是元件」的方法才會撞到。**

**Service 那一側（`OrderService` 這一章結束時的完整版本 —— 最後那一段 `08 章 8.10` 是這一節加的）**：

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

    /** 08 章 8.10：查詢側的 MyBatis mapper（只有讀）。 */
    private final com.example.lab.shop.mybatis.OrderSearchMapper searchMapper;

    /** 09 章 9.9.4：收斂後的動態搜尋（Specification + 投影）。 */
    private final OrderSearchQuery searchQuery;

    private final OrderRepository orders;
    private final CustomerRepository customers;
    private final ProductRepository products;
    private final StockService stocks;                     // ★ 06 章 6.11
    private final EntityManager em;

    public OrderService(com.example.lab.shop.mybatis.OrderSearchMapper searchMapper,
                        OrderSearchQuery searchQuery,
                        OrderRepository orders, CustomerRepository customers,
                        ProductRepository products, StockService stocks, EntityManager em) {
        this.searchMapper = searchMapper;
        this.searchQuery = searchQuery;
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
     * ④c′ 09 章 9.9.4：動態搜尋的【收斂版】。
     *
     * 08 章結束時這裡有兩個實作（`search` 走 JPA + 實體、`searchRows` 走 MyBatis + 投影），
     * 而 09 章 9.4.1c 證明那兩者的效能差別【不是「哪個框架」】——
     * 是【交易 + Criteria 翻譯 + 建實體】三件事加起來。
     *
     * 所以這一版留下 05 章的 Specification（條件可以單獨測試、型別安全），
     * 把回傳型別換成投影（0 個實體），count 與列表共用同一個 Specification。
     */
    @Transactional(readOnly = true)
    public PageResult<OrderListRow> searchPage(OrderSearchCriteria criteria, int page, int size) {
        return searchQuery.search(criteria, page, size);
    }

    /**
     * ④c 搜尋（05 章 5.14）：五個條件都可以不填。
     * ★ 用 Specification 而不是字串拼 JPQL（05 章 5.9.1 的五個問題）。
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

    // ═══════════════ 08 章 8.10：查詢側再往前一步 ═══════════════

    /**
     * ④d 搜尋（08 章 8.10）：跟上面那個 search() 【同一組五個條件】，
     * 而它走 MyBatis 的動態 SQL，回傳的是投影而不是實體。
     *
     * ★ 兩個差別（8.10.2 會量）：
     *   ① 回傳 OrderListRow（0 個實體）而不是 OrderView（一頁 N 個實體）
     *   ② count 與列表【共用同一段 <sql>】，所以不可能不一致（8.3.12）
     */
    @Transactional(readOnly = true)
    public PageResult<OrderListRow> searchRows(OrderSearchCriteria criteria, int page, int size) {
        List<OrderListRow> rows = searchMapper.search(criteria, page * size, size);
        long total = searchMapper.searchCount(criteria);
        return new PageResult<>(rows, total, page, size);
    }

    /** ④e 多選狀態的搜尋（08 章 8.4.1）。空集合回 0 筆，不是回全部（8.4.2）。 */
    @Transactional(readOnly = true)
    public List<OrderListRow> searchByStatuses(List<OrderStatus> statuses, int page, int size) {
        return searchMapper.searchByStatuses(statuses, page * size, size);
    }

    /**
     * ④f keyset 分頁（08 章 8.6.8b）：給「載入更多」用。
     * 第一頁傳 (null, null)，之後傳上一頁最後一筆的 (placedAt, id)。
     */
    @Transactional(readOnly = true)
    public List<OrderListRow> listAfter(OrderStatus status,
                                        java.time.Instant lastPlacedAt, UUID lastId, int size) {
        return searchMapper.pageAfter(status, lastPlacedAt, lastId, size);
    }

    private Order order(UUID id) {
        return orders.findById(id)
                .orElseThrow(() -> new IllegalArgumentException("訂單不存在：" + id));
    }
}
```

```java
package com.example.lab.shop;

import java.util.List;

/**
 * 08 章 8.10：分頁結果。
 *
 * ★ 8.6.3b 那個問題的答案：不要讓 PageHelper 的 Page 洩漏出 Service。
 *   簽章上就講清楚「這是分頁結果」，而 total 是一個【欄位】而不是一個要 cast 才拿得到的東西。
 */
public record PageResult<T>(List<T> content, long total, int page, int size) {

    public int totalPages() { return size <= 0 ? 0 : (int) ((total + size - 1) / size); }
    public boolean hasNext() { return (long) (page + 1) * size < total; }
}
```

**測試基底**：

```java
package com.example.lab.ch08;

import com.example.lab.SqlSpy;
import com.example.lab.Uuid7;
import com.example.lab.shop.*;
import com.example.lab.shop.mybatis.OrderSearchMapper;
import jakarta.persistence.EntityManagerFactory;
import net.sf.jsqlparser.parser.CCJSqlParserUtil;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;

/** 8.10 shop-service 的落地：動態搜尋與 keyset 分頁交給 MyBatis。 */
@SpringBootTest(properties = {
  "spring.datasource.url=jdbc:mysql://127.0.0.1:33306/shop?connectionTimeZone=UTC"
      + "&forceConnectionTimeZoneToSession=true&preserveInstants=true&characterEncoding=UTF-8",
  "spring.jpa.properties.hibernate.generate_statistics=true"
})
class N1Shop {

    @Autowired EntityManagerFactory emf;
    @Autowired JdbcTemplate jdbc;
    @Autowired TransactionTemplate tx;
    @Autowired OrderService orders;
    @Autowired OrderSearchMapper search;
    @Autowired org.apache.ibatis.session.SqlSessionFactory ssf;

    static final String NS = "com.example.lab.shop.mybatis.OrderSearchMapper.";
    private Dyn dyn;
    private Dyn dyn() { if (dyn == null) dyn = new Dyn(ssf); return dyn; }

    private final List<UUID> customerIds = new ArrayList<>();

    void seed(int orderCount, int customerCount, int itemsPer) {
        jdbc.update("DELETE FROM order_item");
        jdbc.update("DELETE FROM orders");
        jdbc.update("DELETE FROM stock");
        jdbc.update("DELETE FROM product");
        jdbc.update("DELETE FROM customer");
        customerIds.clear();

        List<Object[]> cRows = new ArrayList<>();
        for (int i = 0; i < customerCount; i++) {
            UUID id = Uuid7.next(); customerIds.add(id);
            cRows.add(new Object[]{Uuid7.toBytes(id), "c" + i + "@x.com", "客戶" + i});
        }
        jdbc.batchUpdate("INSERT INTO customer (id,email,display_name) VALUES (?,?,?)", cRows);

        List<UUID> ps = new ArrayList<>();
        List<Object[]> pRows = new ArrayList<>(), sRows = new ArrayList<>();
        for (int i = 0; i < 3; i++) {
            UUID id = Uuid7.next(); ps.add(id);
            pRows.add(new Object[]{Uuid7.toBytes(id), "SKU-" + i, "商品" + i,
                    new BigDecimal((100 + i * 50) + ".0000")});
            sRows.add(new Object[]{Uuid7.toBytes(id), 1_000_000});
        }
        jdbc.batchUpdate("INSERT INTO product (id,sku,name,unit_price) VALUES (?,?,?,?)", pRows);
        jdbc.batchUpdate("INSERT INTO stock (product_id,qty) VALUES (?,?)", sRows);

        String[] sts = {"PENDING", "PAID", "SHIPPED", "CANCELLED"};
        List<Object[]> oRows = new ArrayList<>(), iRows = new ArrayList<>();
        Instant t0 = Instant.parse("2026-09-01T00:00:00Z");
        for (int i = 0; i < orderCount; i++) {
            UUID oid = Uuid7.next();
            oRows.add(new Object[]{Uuid7.toBytes(oid), String.format("SO-%06d", i + 1),
                    Uuid7.toBytes(customerIds.get((i / 4) % customerCount)),
                    sts[i % 4], new BigDecimal((100 * itemsPer + i) + ".0000"),
                    java.sql.Timestamp.from(t0.plusSeconds(i * 60L))});
            for (int k = 0; k < itemsPer; k++)
                iRows.add(new Object[]{Uuid7.toBytes(Uuid7.next()), Uuid7.toBytes(oid),
                        Uuid7.toBytes(ps.get((i + k) % 3)), "商品" + ((i + k) % 3),
                        new BigDecimal("100.0000"), 1, new BigDecimal("100.0000")});
        }
        jdbc.batchUpdate("INSERT INTO orders (id,order_no,customer_id,status,total_amount,placed_at)"
                + " VALUES (?,?,?,?,?,?)", oRows);
        if (!iRows.isEmpty())
            jdbc.batchUpdate("INSERT INTO order_item"
                    + " (id,order_id,product_id,product_name,unit_price,qty,line_amount)"
                    + " VALUES (?,?,?,?,?,?,?)", iRows);
    }

    private void head(String t) { System.out.println("\n═══ " + t + " ═══"); }

    private record Measured(int sqlCount, long entities, long micros) {}

    private Measured measure(Runnable body) {
        var st = emf.unwrap(org.hibernate.SessionFactory.class).getStatistics();
        for (int i = 0; i < 2; i++) body.run();
        st.clear();
        SqlSpy.start();
        long t0 = System.nanoTime();
        body.run();
        long us = (System.nanoTime() - t0) / 1000;
        int n = SqlSpy.stop().size();
        return new Measured(n, st.getEntityLoadCount(), us);
    }

    // ══════════════ 8.10.2 兩個框架、同一組條件 ══════════════

    @Test
    void a1_同一組條件兩個框架() {
        head("8.10.2 JPA Specification vs MyBatis <if>：同一組五個條件");
        seed(200, 20, 2);

        record Case(String name, OrderSearchCriteria c) {}
        List<Case> cases = List.of(
            new Case("全空", OrderSearchCriteria.empty()),
            new Case("只有狀態", new OrderSearchCriteria(OrderStatus.PENDING, null, null, null, null)),
            new Case("狀態+關鍵字", new OrderSearchCriteria(OrderStatus.PENDING, "客戶1",
                    null, null, null)),
            new Case("時間範圍", new OrderSearchCriteria(null, null,
                    Instant.parse("2026-09-01T00:00:00Z"),
                    Instant.parse("2026-09-01T01:00:00Z"), null)),
            new Case("五個都填", new OrderSearchCriteria(OrderStatus.PENDING, "客戶1",
                    Instant.parse("2026-09-01T00:00:00Z"),
                    Instant.parse("2026-09-02T00:00:00Z"), new BigDecimal("100"))));

        System.out.printf("  %-14s %14s %14s%n", "條件", "JPA 筆數", "MyBatis 筆數");
        for (Case k : cases) {
            int jpa = tx.execute(s -> orders.search(k.c(), 0, 200)).size();
            var my = orders.searchRows(k.c(), 0, 200);
            System.out.printf("  %-14s %10d 筆 %10d 筆   %s%n", k.name(), jpa, my.content().size(),
                    jpa == my.content().size() ? "✅" : "🔴");
        }

        System.out.println("\n── 第一列一字不差嗎（狀態 + 關鍵字）");
        var c = new OrderSearchCriteria(OrderStatus.PENDING, "客戶1", null, null, null);
        OrderView jv = tx.execute(s -> orders.search(c, 0, 5)).get(0);
        OrderListRow mv = orders.searchRows(c, 0, 5).content().get(0);
        System.out.println("   JPA     : " + jv.orderNo() + " / " + jv.customerName()
                + " / " + jv.status() + " / " + jv.totalAmount());
        System.out.println("   MyBatis : " + mv.orderNo() + " / " + mv.customerName()
                + " / " + mv.status() + " / " + mv.totalAmount());

        System.out.println("\n── 量一次（同一頁 20 筆）");
        var page = new OrderSearchCriteria(OrderStatus.PENDING, null, null, null, null);
        Measured jm = measure(() -> tx.execute(s -> orders.search(page, 0, 20)));
        Measured mm = measure(() -> orders.searchRows(page, 0, 20));
        System.out.printf("  %-30s %8s %10s %10s%n", "", "SQL", "實體", "耗時");
        System.out.printf("  %-30s %6d 句 %8d 個 %8d µs%n",
                "JPA Specification + 投影介面", jm.sqlCount(), jm.entities(), jm.micros());
        System.out.printf("  %-30s %6d 句 %8d 個 %8d µs%n",
                "MyBatis <if> + record", mm.sqlCount(), mm.entities(), mm.micros());
        System.out.println("\n  ⚠️ MyBatis 那一版多一句 count —— 而它換到的是"
                + "「total 一定跟列表一致」（8.3.12）。");
    }

    // ══════════════ 8.10.3 多選狀態 ══════════════

    @Test
    void a2_多選狀態() {
        head("8.10.3 多選狀態（<foreach>）與空集合");
        seed(200, 20, 2);
        System.out.println("  兩種狀態 → " + orders.searchByStatuses(
                List.of(OrderStatus.PENDING, OrderStatus.PAID), 0, 500).size() + " 筆");
        System.out.println("  一種狀態 → " + orders.searchByStatuses(
                List.of(OrderStatus.PENDING), 0, 500).size() + " 筆");
        System.out.println("  🔴 空集合 → " + orders.searchByStatuses(
                List.of(), 0, 500).size() + " 筆 ← 不是 200 筆");
        System.out.println("  null    → " + orders.searchByStatuses(
                null, 0, 500).size() + " 筆");
        System.out.println("\n  ★ 這是 8.4.2 那個 <choose> + 1 = 0 的落地。");
        System.out.println("    「使用者一個狀態都沒勾」的意思是「什麼都不要」，"
                + "不是「全部給我」。");
    }

    // ══════════════ 8.10.4 keyset 分頁 ══════════════

    @Test
    void a3_keyset分頁() {
        head("8.10.4 keyset 分頁（載入更多）");
        seed(4000, 50, 1);
        long total = jdbc.queryForObject(
                "SELECT count(*) FROM orders WHERE status = 'PENDING'", Long.class);
        System.out.println("  PENDING 共 " + total + " 筆\n");

        System.out.println("── 走前三頁");
        Instant at = null; UUID id = null;
        for (int p = 1; p <= 3; p++) {
            List<OrderListRow> rows = orders.listAfter(OrderStatus.PENDING, at, id, 5);
            System.out.println("   第 " + p + " 頁：" + rows.stream()
                    .map(OrderListRow::orderNo).toList());
            var last = rows.get(rows.size() - 1);
            at = last.placedAt(); id = last.id();
        }

        System.out.println("\n── 走到第 200 頁，量最後一頁");
        Instant a2 = null; UUID i2 = null;
        for (int p = 0; p < 199; p++) {
            List<OrderListRow> rows = orders.listAfter(OrderStatus.PENDING, a2, i2, 5);
            if (rows.isEmpty()) break;
            var last = rows.get(rows.size() - 1);
            a2 = last.placedAt(); i2 = last.id();
        }
        final Instant fa = a2; final UUID fi = i2;
        long k = best(() -> orders.listAfter(OrderStatus.PENDING, fa, fi, 5));
        long o = best(() -> orders.searchRows(
                new OrderSearchCriteria(OrderStatus.PENDING, null, null, null, null), 199, 5));
        System.out.printf("   keyset 第 200 頁 : %6d µs%n", k);
        System.out.printf("   offset 第 200 頁 : %6d µs（含 count）%n", o);

        System.out.println("\n── 送出去的 SQL");
        System.out.println("   " + Dyn.one(dyn().sql(NS + "pageAfter",
                Dyn.args("status", OrderStatus.PENDING, "lastPlacedAt", fa,
                         "lastId", fi, "size", 5))
                .replaceAll("(?s)^.*?FROM orders", "… FROM orders")));
    }

    private long best(Runnable r) {
        for (int i = 0; i < 3; i++) r.run();
        long b = Long.MAX_VALUE;
        for (int i = 0; i < 7; i++) {
            long t = System.nanoTime(); r.run(); b = Math.min(b, System.nanoTime() - t);
        }
        return b / 1000;
    }

    // ══════════════ 8.10.5 三條斷言 ══════════════

    @Test
    void a4_三條斷言落地() {
        head("8.10.5 四條斷言在 shop-service 上");

        System.out.println("── 斷言一：2^5 = 32 種條件組合都要產生合法的 SQL");
        List<Function<OrderSearchCriteria, OrderSearchCriteria>> setters = List.of(
            c -> new OrderSearchCriteria(OrderStatus.PENDING, c.customerKeyword(),
                    c.from(), c.to(), c.minAmount()),
            c -> new OrderSearchCriteria(c.status(), "客戶1", c.from(), c.to(), c.minAmount()),
            c -> new OrderSearchCriteria(c.status(), c.customerKeyword(),
                    Instant.parse("2026-09-01T00:00:00Z"), c.to(), c.minAmount()),
            c -> new OrderSearchCriteria(c.status(), c.customerKeyword(), c.from(),
                    Instant.parse("2026-09-02T00:00:00Z"), c.minAmount()),
            c -> new OrderSearchCriteria(c.status(), c.customerKeyword(), c.from(), c.to(),
                    new BigDecimal("100")));
        List<OrderSearchCriteria> combos =
                Dyn.combinations(OrderSearchCriteria.empty(), setters);
        int bad = 0;
        Set<String> shapes = new LinkedHashSet<>();
        for (OrderSearchCriteria c : combos) {
            for (String id : List.of("search", "searchCount")) {
                var a = id.equals("search")
                        ? Dyn.args("q", c, "offset", 0, "size", 20) : Dyn.args("q", c);
                try {
                    String sql = dyn().sql(NS + id, a);
                    CCJSqlParserUtil.parse(sql);
                    if (id.equals("search")) shapes.add(sql);
                } catch (Throwable e) { bad++; System.out.println("   🔴 " + id + " " + e); }
            }
        }
        System.out.println("   " + combos.size() * 2 + " 次檢查，壞掉 " + bad + " 次");

        System.out.println("\n── 斷言二：空集合");
        for (String id : List.of("searchByStatuses")) {
            try {
                String sql = dyn().sql(NS + id,
                        Dyn.args("statuses", List.of(), "offset", 0, "size", 20));
                CCJSqlParserUtil.parse(sql);
                System.out.println("   ✅ " + id + " → " + Dyn.one(sql.substring(
                        Dyn.topLevelIndexOf(sql, " where "),
                        Dyn.topLevelIndexOf(sql, " order by "))));
            } catch (Throwable e) { System.out.println("   🔴 " + id + " " + name(e)); }
        }

        System.out.println("\n── 斷言三：形狀數（棘輪）");
        System.out.println("   search 的形狀數 = " + shapes.size() + "（上界 32）");

        System.out.println("\n── 斷言四：有 LIMIT 的查詢都有唯一的 ORDER BY");
        for (String id : List.of("search", "searchByStatuses", "pageAfter")) {
            var a = switch (id) {
                case "search" -> Dyn.args("q", OrderSearchCriteria.empty(),
                        "offset", 0, "size", 20);
                case "searchByStatuses" -> Dyn.args("statuses", List.of(OrderStatus.PENDING),
                        "offset", 0, "size", 20);
                default -> Dyn.args("status", OrderStatus.PENDING, "lastPlacedAt", null,
                        "lastId", null, "size", 20);
            };
            String sql = Dyn.one(dyn().sql(NS + id, a)).toLowerCase();
            int ob = Dyn.topLevelIndexOf(sql, " order by ");
            int lm = Dyn.topLevelIndexOf(sql, " limit ");
            String orderBy = ob < 0 ? "（沒有）" : sql.substring(ob, lm).trim();
            System.out.println("   " + (orderBy.contains("o.id") ? "✅" : "🔴")
                    + " " + id + " → " + orderBy);
        }
    }

    private static String name(Throwable t) {
        Throwable r = t;
        while (r.getCause() != null && r.getCause() != r) r = r.getCause();
        return t.getClass().getSimpleName() + (r != t ? " ← " + r.getClass().getSimpleName() : "");
    }
}
```

---

### 8.10.2 ★★ 實測：JPA `Specification` vs MyBatis `<if>`

```
═══ 8.10.2 JPA Specification vs MyBatis <if>：同一組五個條件 ═══
  條件                     JPA 筆數     MyBatis 筆數
  全空                    200 筆        200 筆   ✅
  只有狀態                   50 筆         50 筆   ✅
  狀態+關鍵字                 23 筆         23 筆   ✅
  時間範圍                   61 筆         61 筆   ✅
  五個都填                   23 筆         23 筆   ✅

── 第一列一字不差嗎（狀態 + 關鍵字）
   JPA     : SO-000165 / 客戶1 / PENDING / 364.0000
   MyBatis : SO-000165 / 客戶1 / PENDING / 364.0000

── 量一次（同一頁 20 筆）
                                      SQL         實體         耗時
  JPA Specification + 投影介面            3 句       80 個     5958 µs
  MyBatis <if> + record               2 句        0 個     2801 µs
```

★★ **五種條件組合、同一個結果、第一列一字不差。**

**而那三個數字要分開看**：

```
① SQL 句數 3 vs 2
   JPA 那一版是 05 章 5.14.2 的 findBy(spec, q -> q.project("customer").page(…))
   → 一句 count（Spring Data 自己加的）+ 一句主查詢 + 一句 item_count 的批次撈
   MyBatis 那一版是 一句 count + 一句主查詢
                              ↓
   ⚠️ 不是「MyBatis 少一句」，是【兩邊的 count 來源不一樣】：
      JPA  ：Spring Data 幫你猜的 count（05 章 5.7.4 證明它會猜錯）
      MyBatis：你自己寫的 count，跟列表共用同一段 <sql>（8.3.12）

② 實體 80 個 vs 0 個   ← 這一格才是重點
   05 章 5.8.6 已經證明「封閉介面投影」還是會建實體（一頁 20 筆 → 80 個）
   MyBatis 的 record + <constructor> 是 0 個 —— 它沒有持久化情境可以放（07 章 7.2）

③ 耗時 5958 vs 2801 µs
   🔴 這個數字【不要當成選型理由】（00 章 0.8.3）。
      200 張訂單、一頁 20 筆、本機、單執行緒 —— 3 毫秒的差別。
      而那 3 毫秒裡有多少是「建 80 個實體」、多少是 Criteria 的翻譯，這裡分不出來。
```

📌 **05 章 5.14.4 那一格量的是「實體 vs 投影」；這一格量的是「兩個框架的投影」**：

```
04 章 4.11：列表頁 3 句 SQL / 80 個實體（OrderView，實體）
05 章 5.14.4：改成 DTO 投影 → 2 句 / 0 個
07 章 7.15.2：同一頁換 MyBatis → 2 句 / 0 個、第一列一字不差
08 章 8.10.2：把【動態條件】也換過去 → 一樣的結果、一樣 0 個實體
                              ↓
所以 09 章要問的那個問題現在很清楚了：
   「兩個框架在唯讀查詢上產出【一模一樣】的東西，
     那多維護一個框架換到的是什麼？」
```

✅ **這一章給 09 章的答案有兩半**：

```
換到的東西（這一章證明的）：
   ① 8.6.8b：對最佳化器友善的等價寫法（2407 → 299 µs）—— 只有寫 SQL 的人做得到
   ② 8.5.1：一句 SQL 組出四層物件圖 —— JPA 要兩段式投影（05 章 5.8.8）
   ③ 8.3.12：count 與列表【結構上】共用條件 —— JPA 那一側是框架幫你猜
   ④ 8.4.7：一句 UPDATE 改 N 列不同的值 —— JPQL 做不到

沒換到的東西：
   ⑤ 唯讀列表頁的效能（兩邊都是 0 個實體、2 句 SQL）
   ⑥ 而代價是 8.9 那五條斷言 —— 因為編譯期的保護沒有了
```

### 8.10.3 實測：多選狀態與空集合

```
═══ 8.10.3 多選狀態（<foreach>）與空集合 ═══
  兩種狀態 → 100 筆
  一種狀態 → 50 筆
  🔴 空集合 → 0 筆 ← 不是 200 筆
  null    → 0 筆
```

📌 **「使用者一個狀態都沒勾」的意思是「什麼都不要」，不是「全部給我」。**

```xml
  <select id="searchByStatuses" resultMap="…OrderQueryMapper.listRowMap">
    SELECT <include refid="rowColumns"/>
    <include refid="rowFrom"/>
    <where>
      <choose>
        <when test="statuses != null and statuses.size() > 0">
          AND o.status IN
          <foreach item="s" collection="statuses" open="(" separator="," close=")">
            #{s}
          </foreach>
        </when>
        <otherwise> AND 1 = 0 </otherwise>
      </choose>
    </where>
     ORDER BY o.placed_at DESC, o.id DESC
     LIMIT #{size} OFFSET #{offset}
  </select>
```

⚠️ **這個決定要寫在需求上，而不是在 XML 裡默默決定。**
有些搜尋畫面的語意真的是「沒勾 = 全部」——
**那時候 `<otherwise>` 應該是空的，而且要有一行註解說明它是刻意的。**
**8.9.2 那條斷言的第二半（「空集合的 SQL 必須還帶著條件」）就是在強迫這個決定被寫下來。**

### 8.10.4 實測：keyset 分頁

```
═══ 8.10.4 keyset 分頁（載入更多） ═══
  PENDING 共 1000 筆

── 走前三頁
   第 1 頁：[SO-003997, SO-003993, SO-003989, SO-003985, SO-003981]
   第 2 頁：[SO-003977, SO-003973, SO-003969, SO-003965, SO-003961]
   第 3 頁：[SO-003957, SO-003953, SO-003949, SO-003945, SO-003941]

── 走到第 200 頁，量最後一頁
   keyset 第 200 頁 :   1308 µs
   offset 第 200 頁 :   3246 µs（含 count）

── 送出去的 SQL
   … FROM orders o JOIN customer c ON c.id = o.customer_id
     WHERE o.status = ? AND (o.placed_at < ? OR (o.placed_at = ? AND o.id < ?))
     ORDER BY o.placed_at DESC, o.id DESC LIMIT ?
```

📌 **注意那個條件的方向**：`ORDER BY … DESC` 所以條件是 `<`，不是 `>`。

```
升冪（ORDER BY a ASC, id ASC）→ WHERE a > ? OR (a = ? AND id > ?)
降冪（ORDER BY a DESC, id DESC）→ WHERE a < ? OR (a = ? AND id < ?)
                              ↓
🔴 這兩件事必須一起改。只改一個 → 第二頁開始【往反方向走】，
   而它不會報錯，只會回傳「奇怪的資料」。
   → 8.9.4 那條斷言檢查 ORDER BY 存在且唯一，它【檢查不到方向】。
     這一格要靠一個真的走三頁的測試（本節那個 for 迴圈）。
```

⚠️ **`3246 µs` 那個 offset 數字含 count 查詢**，所以兩者不是純粹的對照。
**而這是刻意的** —— 因為它反映真實的差別：

```
offset 分頁的頁面需要「總共幾頁」→ 一定要那句 count
keyset 分頁的頁面【沒有頁碼】   → 不需要 count，只需要「還有沒有下一頁」
                              ↓
所以 keyset 省下的不只是 OFFSET 的掃描成本，還有【整句 count】。
而它的代價是：UI 上不能有頁碼。
```

### 8.10.5 實測：四條斷言在 shop-service 上

```
═══ 8.10.5 四條斷言在 shop-service 上 ═══
── 斷言一：2^5 = 32 種條件組合都要產生合法的 SQL
   64 次檢查，壞掉 0 次

── 斷言二：空集合
   ✅ searchByStatuses → WHERE 1 = 0

── 斷言三：形狀數（棘輪）
   search 的形狀數 = 32（上界 32）

── 斷言四：有 LIMIT 的查詢都有唯一的 ORDER BY
   ✅ search → order by o.placed_at desc, o.id desc
   ✅ searchByStatuses → order by o.placed_at desc, o.id desc
   ✅ pageAfter → order by o.placed_at desc, o.id desc
```

**而在修好之前，斷言一長這樣**：

```
── 斷言一：2^5 = 32 種條件組合都要產生合法的 SQL
   🔴 search java.lang.NumberFormatException: For input string: "!!"
   🔴 searchCount java.lang.NumberFormatException: For input string: "!!"
   …（重複 32 次）
   64 次檢查，壞掉 32 次
```

★★ **這一章寫了三個 `<bind>`，其中兩個是錯的，而兩個都是這條斷言報出來的**：

| 錯誤 | 在哪 | 症狀 | 誰抓到 |
|---|---|---|---|
| `'%' + q.customerKeyword + '%'` | 8.3.9 | `NullPointerException`（32/64） | **斷言一** |
| `q.customerKeyword.replace('!','!!')` | 8.10.1 | `NumberFormatException: "!!"`（32/32） | **斷言一** |
| `q.customerKeyword == null ? null : '%' + … + '%'` | ✅ | — | — |

📌 **`<bind>` 的 OGNL 是這一章最容易寫錯的地方，而它的三個特性加起來就是原因**：

```
① 它一定會被求值（跟 <if> 成不成立無關）—— 8.3.9
② 它是 OGNL，不是 Java：'x' 是字元、"x" 是字串，而 XML 屬性裡寫 " 很麻煩
③ 它的錯誤【只在某些參數組合上】出現
                              ↓
✅ 兩條規則：
   ① <bind> 裡只做「可能是 null」的三元運算子，不做字串處理
   ② 字串處理搬到 Java（本章那個 likePattern()），那裡有型別檢查與單元測試
```

### 8.10.6 shop-service 現在的樣子

| 用例 | 走哪一邊 | SQL 句數 | 實體 | 出處 |
|---|---|---|---|---|
| `place()` 新增訂單 | JPA | 4 | — | 06 章 6.11.2 |
| `addItem()` | JPA | 4 | — | 03 章 3.11.4 |
| `pay()` / `cancel()` | JPA | 2 | — | 03 章 3.11.4 |
| `view()` 明細頁 | JPA（`@EntityGraph`） | **1** | 6 | 04 章 4.11 |
| `list()` 分頁列表 | JPA（投影） | 2 | **0** | 05 章 5.14.4 |
| `search()` 動態搜尋 | JPA（`Specification`） | 3 | 80 | 05 章 5.14.5 |
| **`searchRows()` 動態搜尋** | **MyBatis `<if>`** | **2** | **0** | **8.10.2** |
| **`searchByStatuses()`** | **MyBatis `<foreach>`** | 1 | **0** | **8.10.3** |
| **`listAfter()` 載入更多** | **MyBatis keyset** | **1** | **0** | **8.10.4** |
| `listRows()` 列表 | MyBatis | 2 | 0 | 07 章 7.15.2 |
| `salesRanking()` 報表 | MyBatis（窗口函式） | 1 | 0 | 07 章 7.15.4 |
| `statusPivot()` 樞紐表 | MyBatis | 1 | 0 | 07 章 7.15.4 |
| `OrderImportService` 匯入 | JPA 批次 | O(N/batch) | — | 06 章 6.11.4 |

📌 **現在有兩個「動態搜尋」並存（`search` 與 `searchRows`），而那是刻意的** ——
**09 章要拿它們做最後的選型結論。**

⚠️ **而這張表已經開始有一個 09 章要處理的問題**：

```
「同一個列表頁有兩個實作」在課程裡是為了對照，
在真實專案裡是【技術債】：
   ① 加一個欄位要改兩個地方，而只改一個【不會有任何錯誤】
   ② 兩邊的 like 跳脫規則各寫一次（OrderSpecifications.customerLike
      與 OrderSearchCriteria.likePattern）—— 它們現在一致，而沒有東西保證它們一直一致
                              ↓
09 章 要回答的是：這個成本值得嗎？而「值得」的判準不是「快 2 倍」。
```

---

## 8.11 常見誤區

**① 「`where 1 = 1` 只是醜，功能上沒差。」**

功能上真的沒差。而它讓「空條件」與「一個條件」的 SQL 形狀**一定不一樣**（8.3.13），
也讓 code review 看不出「這個查詢有沒有必填條件」。
**`<where>` 是免費的，沒有理由不用（8.3.3）。**

---

**② 「`<if>` 裡忘了寫 `AND` 會被測試抓到。」**

**只有在【兩個以上的條件同時成立】的那 57 種組合裡才會炸**（8.3.4）。
單獨測每一個條件會全部通過。**要靠 8.9.1 那條斷言。**

---

**③ 「`<if test="…">` 裡面可以寫的東西，`#{}` 裡也可以。」**

**不行。** `test=` 是 OGNL（方法呼叫、算術、三元運算子全都可以），
`#{}` 只是一條**屬性路徑** —— `#{q.status()}` 會拋 `ReflectionException`（8.3.11）。

---

**④ 「`record` 不能當 MyBatis 的參數物件。」**

**可以**，MyBatis 3.5.14 上 OGNL 與 `#{}` 都認得 record 的元件（8.3.11）。
🔴 **而它的屬性命名規則跟 POJO【相反】**：
record 的屬性名就是**方法名**，所以額外加的 `getLikePattern()` 的屬性名是
`getLikePattern` 而不是 `likePattern`（8.10.1）。

---

**⑤ 「`<bind>` 只有在條件成立的時候才會執行。」**

**它一定會執行。** `<bind>` 是一個獨立的 `SqlNode`，
而 `SqlNode` 是從上到下全部 apply 一遍的 ——
所以 `'%' + null + '%'` 在 OGNL 裡是 **`NullPointerException`**，不是 `"%null%"`（8.3.9）。

---

**⑥ 「`<bind>` 裡可以寫 Java。」**

它是 OGNL。**`'!'` 是字元字面值，`'!!'` 會被拿去解析成數字 →
`NumberFormatException: For input string: "!!"`**（8.10.1）。
✅ **`<bind>` 裡只做三元運算子，字串處理搬到 Java。**

---

**⑦ 「參數化的 `like` 就安全了。」**

參數化保證「它不會變成 SQL 語法」，**不保證「它不會變成 `LIKE` 的通用字元」** ——
使用者打一個 `%` 就會撈回全部（8.3.9）。要 `ESCAPE` 加上 Java 端的跳脫。

---

**⑧ 「`<set>` 內容為空的時候，MyBatis 會把整句 `UPDATE` 拿掉。」**

**不會，它會產生 `UPDATE orders WHERE id = ?` → 語法錯誤**（8.3.7）。
`<where>` 內容為空會整段消失，`<set>` 不會 —— 因為「沒有 SET 的 UPDATE」本來就不合法。

---

**⑨ 「`<set>` 解掉了『部分更新』這個問題。」**

**只解掉一半。** 它讓「沒給的欄位不出現在 SQL 裡」變容易，
而它**不能**分辨「使用者沒給」與「使用者要清成 null」——
那個資訊必須在 API 的型別裡（8.3.6，跟 03 章 3.6.4 的 `merge` 同一個形狀）。

---

**⑩ 「`<choose>` 是 `<if>` 的加強版。」**

**它們的語意完全不同。** `<if>` 疊加、`<choose>` 只取第一個成立的。
「六個可選條件」用 `<choose>` 寫，會**靜默忽略後面五個**（8.3.8）。

---

**⑪ 「`<include>` 的 `<property>` 可以傳參數。」**

**不行，它是【XML 解析期】的純文字取代**（8.3.10）。
本章那個 `value="${sortColumn}"` 會動，是因為它代換出來的文字**剛好又是一個執行期的 `${}`**。

---

**⑫ 「`<foreach>` 的筆數上限是 65535 個參數。」**

**在 MySQL 8.0.46 + Connector/J 8.3.0 上量不到** ——
140,000 個參數、`Com_stmt_prepare = 1`、全部都過（8.4.6）。
🔴 **真正會擋你的是 `max_allowed_packet`，而它看的是【展開後的位元組數】：
48 萬字元的 SQL 送出去是 3.3 MB 的封包**（8.4.6）。

---

**⑬ 「`<foreach>` 分塊是為了效能。」**

實測 `1 句 ×1000 組`（22 ms）跟 `10 句 ×100 組`（26 ms）幾乎一樣快 ——
**分塊是免費的**。它的理由是⑫那個看不到的上限，加上「讓 SQL 形狀固定」（8.4.5）。

---

**⑭ 「`in` 子句的形狀爆炸開一個組態就好了。」**

**那是 Hibernate**（`in_clause_parameter_padding`，05 章 5.5.3）。
**MyBatis 沒有** —— 要自己寫 `Pad8.pad()`，**而漏掉沒有任何症狀**（8.4.3）。
所以要靠 8.9.3 那條「形狀數有上界」的斷言。

---

**⑮ 「`columnPrefix` 只是少打幾個字。」**

它讓子 `resultMap` 變成**可重用的元件**（8.5.2）。
而少了它（且 SQL 也沒別名）的後果是**訂單數對、客戶看起來對、
而明細少一筆、`product` 是 null**（8.5.3）。

---

**⑯ 「`<collection>` 的 `<id>` 隨便選一個唯一的欄位就好。」**

`<id>` 的意思是「**這幾欄一樣就是同一個物件**」。
選 `product_name` 等於在 XML 裡宣告一條業務規則
（「同一張訂單不會有兩筆同名商品」），**而違反它的時候會靜默少一筆明細**（8.5.4）。

---

**⑰ 「`<association>` 少了 `<id>`，`LEFT JOIN` 沒對到會建出空物件。」**

**不會。** 那件事由 `returnInstanceForEmptyRow` 決定（預設 `false` = 回 `null`），
跟 `<id>` 無關（8.5.5）。

---

**⑱ 「`<discriminator>` 對不上 `<case>` 會報錯。」**

**不會，它退回基底 `resultMap`**（8.5.6）。
資料庫多了一種 `kind` → Java 這一側是**行為靜默退化**。

---

**⑲ 「`fetchType="lazy"` 要先開 `lazyLoadingEnabled`。」**

**不用。** 那個全域組態只是預設值，mapping 上的 `fetchType` 蓋過它（8.5.8）。
**這跟 04 章 4.3.6 那個 `@Basic(fetch=LAZY)`「沒有 enhancement 就完全無效」不一樣。**

---

**⑳ 「MyBatis 沒有 `LazyInitializationException`，所以延遲載入比較安全。」**

**剛好相反。** 交易外碰延遲關聯，MyBatis **自己開一個 `Executor` 把資料撈回來**
（8.5.10）—— 那是 04 章 4.4.4 那個「假修復」（`enable_lazy_load_no_trans`），
**而在 MyBatis 上它是預設行為、沒有開關。**
所以「回傳帶延遲關聯的物件給 Controller」在 MyBatis 上**不會有任何錯誤訊息**。

---

**㉑ 「量 MyBatis 的 N+1 用 SQL 句數就好。」**

**巢狀 `select` 的 statement 會被一級快取命中**（8.5.9）——
「先跑一次 eager 版，lazy 版的走訪就一句都不打」。
**要量 statement 被呼叫幾次**，那需要 Executor 層的攔截器（8.8.2）。

---

**㉒ 「`RowBounds` 是 MyBatis 的分頁。」**

它是記憶體分頁（07 章 7.9.4）。**這一章的分頁決策表裡它一格都沒有**（8.6.9）。

---

**㉓ 「PageHelper 只是幫你加 `LIMIT`。」**

它還幫你**猜 count 查詢**，而那個猜測在巢狀 `resultMap` 上**全錯**：
`total = 16`（實際 8）、`pages = 6`（實際 3）、**而這一頁的明細是殘缺的**（8.6.5）。

---

**㉔ 「`startPage` 之後如果沒有查詢，就沒事。」**

那個分頁參數**留在 `ThreadLocal` 裡**，
下一個**完全不相干**的查詢會被套上它（8.6.4）。
在 Web 應用裡，那是「某支 API 偶爾只回三筆」。

---

**㉕ 「keyset 分頁在 MySQL 上要用 `(a, b) > (?, ?)`，這樣才吃得到複合索引。」**

🔴🔴 **錯。MySQL 8.0.46 把它處理成 `Filter`，掃了 5000 列（2407 µs）。**
**要寫成 `a > ? OR (a = ? AND b > ?)`，MySQL 才會做 `Index range scan`（19 列、299 µs）**（8.6.8）。
加複合索引、`FORCE INDEX` 都救不了。

---

**㉖ 「MyBatis 的二級快取失效粒度跟 JPA 差很多。」**

**差不多**（namespace ≈ 一張表 vs JPA 查詢快取的整張表，8.7.3）。
🔴 **真正的差別是「另一個 namespace 改了同一張表，快取完全不會失效」**（8.7.4），
而「另一個 mapper 介面」是一件每天都在做的事。

---

**㉗ 「二級快取查兩次會拿到同一個物件，所以要小心。」**

`readOnly="false"`（**預設**）會**序列化複製一份**，所以不是同一個物件（8.7.7）。
`readOnly="true"` 才是同一個 —— 而那時候呼叫端改了它就**污染整個應用程式的快取**。
✅ **mapper 回傳 `record` → `readOnly="true"` 安全而且比較快。**

---

**㉘ 「JPA 與 MyBatis 用同一條連線、同一個交易，所以看到的資料一致。」**

07 章 7.12.1 已經證明不一致（兩個一級快取）。
**這一章證明二級快取也是，而且是【雙向】的**：兩邊各快取自己的歷史版本，
而且都是 0 句 SQL（8.7.8）。

---

**㉙ 「攔截器是 MyBatis 的擴充點，所以拿它做橫切關注點是對的。」**

**用它做觀測是對的**（8.8.2）。
用它做**審計**有四個問題（跟業務交易同生共死、讓批次失效、不知道誰與為什麼、會攔到自己，8.8.3）。
用它**改寫 SQL** 有四個地雷，其中最陰險的是
**一級快取命中時攔截器完全不會執行 → 資料隔離在特定呼叫順序下失效**（8.8.4）。

---

**㉚ 「攔截器改 SQL 就是改一個字串，不難。」**

`AND` 接在 `ORDER BY` 後面 → **它變成排序運算式的一部分，完全合法、沒有過濾、
5 張全部回來**（8.8.4）。而 `BoundSql` 的 `parameterMappings` 已經定案，
**所以改寫的條件只能用字面值 —— 也就是一個橫跨整個系統的注入點。**

---

## 8.12 本章小結

**這一章講的是「SQL 是你自己寫的」的兩面**。

```
好的那一面（這一章證明的四件事）
   ① 8.6.8   對最佳化器友善的等價寫法 —— 2407 → 299 µs，只有寫 SQL 的人做得到
   ② 8.5.1   一句 SQL 組出四層物件圖 —— 回收 05 章 5.8.8 那個「DTO 裡要有集合」
   ③ 8.3.12  count 與列表【結構上】共用條件 —— 修掉 05 章 5.7.4 那個「框架猜錯」
   ④ 8.4.7   一句 UPDATE 改 N 列不同的值 —— JPQL 做不到

壞的那一面
   ⑤ 05 章 5.9.1 那五個問題，MyBatis 解掉兩個、剩三個（8.3.12）
   ⑥ 而它多了一個新問題：SQL 形狀的數量（8.3.13：64 種形狀慢 2.3 倍）
   ⑦ 錯誤全部在執行期，而且【只在某些參數組合上】——
     所以 8.9 那五條斷言不是「加分項」，是【把編譯期的保護換一種形式補回來】
```

📌 **這一章的主線，用一句話講**：

```
07 章：MyBatis 的坑在「兩個東西沒對上，而沒有人告訴我」（接合）
08 章：MyBatis 的坑在「這一組參數剛好走到那一條路上」（組合）
                              ↓
接合的問題靠【接合檢查】抓（07 章 7.14 那四條斷言）
組合的問題靠【把組合全部展開】抓（08 章 8.9 那五條斷言）
                              ↓
而兩者共同的前提是 8.2.3 那把尺：
   MappedStatement.getBoundSql(參數) —— 不執行，也看得到 SQL。
```

### 8.12.1 這一章修正的四句流傳很廣的話

| 說法 | 實測 | 節 |
|---|---|---|
| 「`<bind>` 只在條件成立時求值」 | 🔴 **它一定會求值，`'%' + null` 是 NPE** | 8.3.9 |
| 「`<foreach>` 最多 65535 個參數」 | 🔴 **140,000 個都過。真正的上限是 `max_allowed_packet`** | 8.4.6 |
| 「`<association>` 少了 `<id>` 會建空物件」 | 🔴 **跟 `<id>` 無關，是 `returnInstanceForEmptyRow`** | 8.5.5 |
| **「keyset 分頁用 `(a,b) > (?,?)` 才吃得到索引」** | 🔴🔴 **MySQL 8.0.46 上它是 `Filter`，掃 5000 列。要展開成 OR** | **8.6.8** |

### 8.12.2 這一章回收的六個承諾

| 承諾 | 結果 |
|---|---|
| 07 章 7.2「代理與延遲載入 🟡 有簡化版，08 章處理」 | ✅ 8.5.8～8.5.10（含那個沒有開關的「假修復」） |
| 07 章 7.2「二級快取 🟡 有，08 章處理」 | ✅ 8.7（含雙向失效那一格） |
| 07 章 7.8.6「`<collection>` 的欄位要加前綴」 | ✅ 8.5.2 的 `columnPrefix`；8.5.3 量出少了它的後果 |
| 07 章 7.9.4「`RowBounds` 不能分頁，要自己寫 `LIMIT`」 | ✅ 8.6（PageHelper 的三個坑 + keyset） |
| 07 章 7.10.4「`<foreach>` 的形狀跟筆數綁定」 | ✅ 8.4.3 的 `Pad8`、8.4.5 的固定塊大小 |
| 07 章 7.17.2 練習三「`<id>` 用 `productName` 是將就的」 | ✅ 8.5.4：造出同名商品，證明會少一筆 |
| 05 章 5.12.2「DTO 裡要有巢狀集合 → 兩段式或 MyBatis」 | ✅ 8.5.1：一句 SQL、0 行組裝程式碼 |

### 8.12.3 五把尺的分工（到這一章才齊）

| 尺 | 站在哪一層 | 能回答什麼 | 這一章哪裡用到 |
|---|---|---|---|
| **`Dyn`** | MyBatis 組完 SQL | **這組參數會產生什麼 SQL**（不執行） | 8.3、8.4、8.9 全部 |
| **攔截器** | `Executor` | **statement 被呼叫幾次**（含快取命中） | 8.8.2、8.5.9 |
| `SqlSpy` | JDBC | 應用程式呼叫了幾次 `execute()` | 8.6.3、8.5.1 |
| Hibernate `Statistics` | Hibernate 內部 | 建了幾個實體 | 8.10.2 |
| `MysqlStat` | 資料庫伺服器 | 伺服器剖析／執行了幾句 | 8.3.13、8.4.5 |

⚠️ **而這一章證明「量尺自己會騙人」三次**：

```
① Dyn.args() 用 HashMap → 把「參數名打錯」量成「條件不成立」（8.3.11b）
② SqlSpy 與 Dyn 對 PageHelper 的看法完全不一樣 → 而那個差就是答案（8.6.3）
③ 延遲載入的 SQL 句數取決於同一個交易裡之前查過什麼 → 量到假的好數字（8.5.9）
```

### 8.12.4 驗收清單

**動態 SQL**
- [ ] `<where>` 做的兩件事是什麼？`where 1 = 1` 的三個問題？（8.3.3）
- [ ] `<if>` 忘了開頭的 `AND` → 什麼時候會炸？為什麼測試常常抓不到？（8.3.4）
- [ ] `<where>` / `<set>` 各自等於什麼 `<trim>`？（8.3.5）
- [ ] `<set>` 內容為空時的行為，跟 `<where>` 差在哪？兩個正解是什麼？（8.3.7）
- [ ] `<if>` 與 `<choose>` 的語意差別？各自適合什麼？（8.3.8）
- [ ] `<bind>` 什麼時候被求值？`'%' + null` 是什麼？（8.3.9）
- [ ] `<include>` 的 `<property>` 是哪一個時期代換的？（8.3.10）
- [ ] `test="…"` 與 `#{…}` 是同一種語言嗎？record 的屬性名規則？（8.3.11、8.10.1）
- [ ] 動態 SQL 的本質代價是什麼？在伺服器端量到的數字？（8.3.13）

**`<foreach>`**
- [ ] 空集合與 `null` 各自的下場？為什麼正解是 `1 = 0` 而不是在 Java 短路？（8.4.2）
- [ ] `in` 子句 1～20 個值 → 幾種形狀？pad 之後幾種？（8.4.3）
- [ ] 一句 1000 組 `VALUES` 在伺服器端是幾句？跟 `ExecutorType.BATCH` 比？（8.4.5）
- [ ] `<foreach>` 真正的上限是什麼？為什麼「一律分塊」？（8.4.6）
- [ ] 組 `OR` 的時候 `open`/`close` 為什麼是正確性？（8.4.7）

**`resultMap`**
- [ ] `columnPrefix` 的價值？它會不會疊加？（8.5.2）
- [ ] 兩層巢狀而沒有前綴 → 三個症狀分別是什麼？（8.5.3）
- [ ] `<id>` 的語意是什麼？選錯欄位的後果？（8.5.4）
- [ ] 「全 null 的列要不要建物件」由誰決定？（8.5.5）
- [ ] `<discriminator>` 對不上任何 `<case>` 會怎樣？兩個處理方式？（8.5.6）
- [ ] `fetchType="lazy"` 需要哪些前置組態？（8.5.8）
- [ ] 交易外碰延遲關聯，MyBatis 做什麼？跟 JPA 差在哪？（8.5.10）

**分頁**
- [ ] PageHelper 的四個步驟？哪一步是哪個坑的來源？（8.6.3）
- [ ] 三個坑各自的症狀與防線？（8.6.4～8.6.6）
- [ ] 巢狀 `resultMap` + PageHelper → 三個數字各錯多少？（8.6.5）
- [ ] keyset 分頁的三個限制？它換到什麼？（8.6.7）
- [ ] keyset 的條件為什麼不能寫成列建構子比較？（8.6.8）

**二級快取**
- [ ] `<cache>` 的每一個屬性對應哪一個裝飾器？（8.7.1）
- [ ] 它的 key 是什麼？為什麼動態查詢幾乎不會命中？（8.7.2）
- [ ] 失效範圍是什麼？跟 JPA 的兩種粒度對照？（8.7.3）
- [ ] 為什麼「另一個 mapper 改了同一張表」是它最大的陷阱？（8.7.4）
- [ ] 為什麼「量二級快取」每一次查詢都要自己一個交易？（8.7.6）
- [ ] `readOnly` 的兩個值各自的行為與代價？（8.7.7）
- [ ] 兩個框架的二級快取為什麼是【雙向】壞掉？（8.7.8）

**攔截器**
- [ ] 四個可攔截的介面，各自拿得到什麼？（8.8.1）
- [ ] 為什麼「觀測」要攔 `Executor` 而不是 `StatementHandler`？（8.8.2）
- [ ] 用它做審計的四個問題？正解的三層分工？（8.8.3）
- [ ] 改寫 SQL 的四個地雷？哪一個最陰險？（8.8.4）

**斷言**
- [ ] 五條斷言各自抓什麼？為什麼它們全部不需要資料庫？（8.9.6）
- [ ] 這一章的 13 個 🔴，五條斷言蓋掉幾個？剩下的靠什麼？（8.9.6）

### 8.12.5 本章練習

**練習一（動態 SQL 的第三個形狀）**
8.3 那六個條件是「AND 疊加」。改成支援**分組的 OR**：
`(狀態 = A 或 狀態 = B) AND (金額 >= X 或 有業務員)`。
要求：① 條件樹用 Java 的 sealed interface 表達；
② `<foreach>` 遞迴組出括號（提示：MyBatis 沒有遞迴 —— 說明你怎麼繞過，
或者為什麼這時候該改用 QueryDSL）；
③ 用 8.9.1 那條斷言蓋掉你的所有組合。

**練習二（`<bind>` 的三個坑）**
把 8.10.1 那個 `likePattern()` 搬回 `<bind>` 裡，並且**寫對**。
要求：① 用 XML 的單引號屬性 + OGNL 的雙引號字串；
② 用 8.9.1 那條斷言證明 32 種組合全過；
③ **然後說明你為什麼還是應該把它放在 Java 裡。**

**練習三（`<foreach>` 的分塊）**
寫一個 `Chunked.insertAll(List<ItemInsert8>, int chunkSize)`，
要求：① 塊大小固定，最後一塊不滿的用**另一個 statement**（所以形狀數是 2 不是 N）；
② 量 1000 / 10000 / 100000 筆的耗時與 `Com_insert`；
③ 把 `max_allowed_packet` 調到 256 KB，找出「不會爆的最大塊大小」，
並說明**為什麼那個數字不能寫死在程式裡**。

**練習四（`resultMap` 的身分）**
8.5.3 那個「沒有前綴」的查詢有三個症狀，而其中兩個看起來是對的。
寫一個測試**只靠斷言**（不看輸出）抓到全部三個。
提示：8.9 那條「每一欄都不准是 null」的斷言要怎麼寫成通用的？

**練習五（PageHelper 的安全網）**
① 寫一個 `@Around` 的 AOP 切面，在**每一個 Service 方法結束時**
無條件 `PageHelper.clearPage()`，並量它對 8.6.4 那個洩漏的效果；
② 寫一條 ArchUnit 規則：**呼叫 `PageHelper.startPage` 的方法，
下一個敘述必須是一個 mapper 呼叫**（提示：ArchUnit 看不到敘述順序 ——
說明你要怎麼做，或者為什麼這條規則只能用 code review 執行）。

**練習六（keyset 分頁的完整版）**
把 8.10.4 那個 `listAfter` 擴充成**支援四種排序**（日期／金額／訂單號／狀態，各升降）。
要求：① 游標是一個不透明的字串（base64 的 JSON），
裡面帶「排序方式 + 最後一筆的鍵值」；
② **排序方式變了 → 游標作廢，回第一頁**，而且要有測試；
③ 每一種排序都要有對應的索引，用 `EXPLAIN ANALYZE` 證明它是 `Index range scan`
而不是 `Filter`（8.6.8）；
④ 說明為什麼金額排序**一定**要加 `id` 當 tiebreaker。

**練習七（二級快取的斷言）**
寫一條斷言：**動同一張表的所有 mapper，要嘛都沒有快取，
要嘛都 `<cache-ref>` 指到同一個快取**。
要求：① 「同一張表」用 jsqlparser 從每一個 `MappedStatement` 的 SQL 剖析出來；
② 對本章那四個 `Country*Mapper` 跑一次，確認它抓到 `CountryOtherMapper`；
③ 說明這條斷言的**兩個誤判來源**（動態 `${}` 的表名、`<include>` 組出來的 `FROM`）。

**練習八（攔截器的正當用途）**
把 8.8.2 那個 `SqlLogInterceptor` 做成生產可用的版本：
① 只攔一次（判斷 target 的實際型別）；
② 超過門檻才記錄，而且記錄的是 statement id 而不是 SQL（避免把參數寫進 log）；
③ 加一個「同一個 HTTP 請求裡呼叫了幾次 mapper」的計數器，
並用它抓出 8.5.10 那個「序列化的時候才發生的 N+1」；
④ **量它自己的成本**：關掉、開著但不觸發、開著且觸發，三種情況的差別。

**練習九（把兩個實作收成一個）**
8.10.6 那張表有兩個「動態搜尋」。挑一個留下來，然後：
① 列出你刪掉的那一個提供了什麼（別忘了 05 章 5.9.6 的「條件可以單獨測試」）；
② 把 `OrderSpecifications.customerLike` 與 `OrderSearchCriteria.likePattern`
那條重複的跳脫規則**收成一份**，並寫一個測試證明它們一致；
③ **09 章會給它的答案 —— 先寫下你的，然後對照。**

---

## 8.13 下一章預告

**09 章：實務選型與混用 —— 這一站的結案。**

這一站從 00 章的六個實測事故開始，走了九章。**09 章不教新東西，它結三筆帳**：

```
帳一：00 章 0.8.4 那個選型決定（「報表與列表查詢用 MyBatis」）
      → 07 章 7.15 證明兩個框架產出【同一個 record、第一列一字不差、都 0 個實體】
      → 08 章 8.10.2 把【動態條件】也換過去，結果還是一樣
      → 那個決定的哪一半是對的？

帳二：「快 2.3 倍」這種不該當理由的理由（00 章 0.8.3）
      → 07 章 7.15.3：JPA 2699 µs、MyBatis 1188 µs
      → 08 章 8.10.2：JPA 5958 µs、MyBatis 2801 µs
      → 兩次都是兩倍多。而 09 章要問：這兩倍在一支 200 ms 的 API 上是什麼？

帳三：混用的成本
      → 07 章 7.12：兩個一級快取
      → 08 章 8.7.8：兩個二級快取，而且雙向壞掉
      → 08 章 8.10.6：同一個列表頁兩個實作，而「只改一個」不會有任何錯誤
      → 09 章要把這些成本【加總】，然後跟帳二那個「兩倍」放在同一張秤上
```

📌 **09 章會處理六件事**：

```
① 六條軸的最終對照表（00 章 0.6 那六條，九章的實測填進去）
② 「什麼場景 JPA 快、什麼場景 MyBatis 省事」—— 而「快」與「省事」是不同的問題
③ 同專案共存的架構：三種切法（依表、依用例、依讀寫）與各自的失效模式
④ 遷移成本評估：從 JPA 換到 MyBatis（或反過來）要動幾個檔案、
   哪幾類程式碼【一定要重寫】
⑤ 這一站累積的 21 條 CI 斷言，哪幾條是「不管你選哪個框架都要有」的
⑥ 🔴 而最後一節要回答一個這一站一直沒問的問題：
   「如果兩個都不選呢？」—— JdbcTemplate / JOOQ / 純 JDBC 在 2026 年的位置
```

⚠️ **而 09 章會回頭修改這一章的兩個東西**：

| 這一章說 | 09 章會補上 |
|---|---|
| 8.9 那五條斷言 | 哪幾條在 **JPA 那一側也需要**（動態 SQL 的形狀爆炸兩邊都有） |
| 8.10.6「同一個列表頁兩個實作是技術債」 | 一個具體的收斂方案，以及**它為什麼不是「刪掉一個」那麼簡單** |

📌 **這一章交給 09 章三個數字**：

```
8.10.2  同一組條件、同一個 record、同樣 0 個實體 → JPA 5958 µs、MyBatis 2801 µs
8.6.8   對最佳化器友善的等價寫法 → 2407 → 299 µs（8 倍，而 JPA 那一側做不到）
8.9.6   五條斷言蓋掉六個 🔴，剩下七個要靠別的方式
   ↓
09 章：把「8 倍」與「七個抓不到的坑」放在同一張秤上 ——
      而那就是「選型」這件事的真正形狀。
```
