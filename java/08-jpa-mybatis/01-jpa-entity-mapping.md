# 第 01 章：Entity 映射基礎

> 00 章講完了「JPA 是什麼」與「它跟 MyBatis 的六條分歧軸」。
> 這一章開始動手：**把 07 站 01 章 1.12 那份 schema，一張表一張表地映射成實體。**
>
> ⚠️ 聽起來像是「照著欄位貼註解」的工作。**它不是。**
>
> 這一章有**七個實測**，每一個都是「註解貼對了、程式跑得起來、資料是錯的」：
>
> - 有人在 `enum` 中間插了一個常數，**三個月前的訂單從「已取消」變成「已送達」**
> - 同一列資料，程式部署到容器之後**讀出來差 8 小時**——而資料庫一個位元組都沒改
> - `DECIMAL(19,4)` 收到 `100.12345`，**靜默存成 `100.1235`**，在 `STRICT_TRANS_TABLES` 下也不報錯
> - 選錯主鍵策略，**批次插入完全失效**（200 筆 = 200 句 SQL，一句都沒有批次）
> - 一個物件存進資料庫之後，**從它自己的 `HashSet` 裡消失了**
> - `a.equals(b)` 是 `false`，`b.equals(a)` 是 `true`——**同樣兩個物件**
> - `ddl-auto: validate` 通過了，**而實體與 schema 有六處不一致**
>
> 📌 這一章的主線是一句話：
>
> > **映射不是「把欄位對起來」，是「決定 Java 的型別系統與 SQL 的型別系統在哪裡對齊、在哪裡放棄對齊」。**
>
> 而每一個「放棄對齊」的地方，就是上面那七個實測的來源。

---

## 1.1 學習目標

完成本章後，你應該可以：

- 說出一個 JPA 實體的**五個硬性要求**，以及「欄位存取 vs 屬性存取」的差別與它的實際後果。
- 說明 `ddl-auto` 的五個值各自做什麼，並解釋為什麼 `update` 在任何環境都不該用。
- 比較**五種主鍵策略**（`IDENTITY` / `TABLE` / `SEQUENCE` / `UUID` / 應用端指定），
  並用實測數據說明**為什麼 `IDENTITY` 會讓批次插入完全失效**（1.6.2：200 筆 = 200 句、0 批次）。
- 解釋 MySQL 上宣告 `GenerationType.SEQUENCE` 會發生什麼（1.6.3：Hibernate 幫你建一張表來模擬）。
- 用 `Persistable` 解掉 00 章 0.3.3 那個「`save()` 多一句 `SELECT`」的問題
  （1.6.6 實測：**204 句 / 182 ms → 4 句 / 19 ms**），並說出它的**兩個坑**。
- 說明 `@Enumerated` 的兩個選項，並用實測解釋為什麼 `ORDINAL` 是一顆定時炸彈
  （1.7.2：插一個常數，`SHIPPED` 變成 `PACKED`、`CANCELLED` 變成 `DELIVERED`）。
- 說出 Hibernate 6 在 MySQL 上對 `EnumType.STRING` 做了什麼**跟 Hibernate 5 不一樣的事**（1.7.4）。
- 在 `Instant` / `LocalDateTime` / `OffsetDateTime` 之間做出選擇，
  並用實測說明**為什麼 `LocalDateTime` 會讓同一列資料在不同機器上讀出不同的時間**（1.9.2）。
- 讓 `BigDecimal` 的 `precision` / `scale` 與 `DECIMAL(19,4)` 對齊，
  並說明對不齊時會發生什麼（1.10.1：**靜默四捨五入**）。
- 映射**生成欄位**（07 站 1.10.4 的 `email_active`），並說出 `@Generated` 的代價（1.8.2：多一句 `SELECT`）。
- 用 `@Embedded` 把值物件攤平進同一張表，並讓**不變量守在型別的建構子裡**。
- 分辨 **`@Column(nullable=false)` / Bean Validation / 資料庫約束**三層各自在什麼時候作用（1.11）。
- 讓 `ddl-auto: validate` 通過，並且**知道它抓不到什麼**
  （1.12.3 實測：注入九種漂移，**抓到三種、漏掉六種**）。
- 寫出對**代理**安全、對 **`HashSet`** 安全的 `equals` / `hashCode`，
  並解釋 1.14.3 那個「`equals` 不對稱」的實測是怎麼發生的。
- 說出 07 站 1.10.5 那 11 條不變量，**在 JPA 的世界裡分別守在哪一層**。

---

## 1.2 起點：07 站那份 schema

### 1.2.1 這一章的方向是 database first

00 章 0.6.5 講過「誰主導 schema」是六條分歧軸之一。**這一章的方向已經定了**：

```
07 站 01 章 1.12  ──→  CREATE TABLE（已經存在，而且是深思熟慮過的）
                          ↓
01 章（你在這裡）  ──→  把它映射成實體
                          ↓
                       ddl-auto: validate 守住兩邊不會漂移
```

⚠️ **這個方向會讓一些「JPA 教學的標準寫法」在這裡行不通**，因為那些教學預設的是相反的方向
（先寫實體、讓 Hibernate 產生 schema）。**這一章的七個實測，有四個來自這個方向差異。**

📌 **為什麼選這個方向**：07 站那份 schema 有太多「JPA 產不出來」的東西——
`BINARY(16)` 的 UUIDv7 主鍵、`utf8mb4_0900_as_cs` 的單欄定序、
生成欄位、`CHECK` 約束、覆蓋索引的欄位順序。
**那些不是裝飾，是 07 站八章的結論。**

📌 **命名慣例見 00 章 0.3.0.1**：這一章的 `com.example.lab.ch01` 是**實驗用的變體**
（`PkIdentity`、`PkUuid7P`、`EqUuid`……各自只為了示範一件事），
而 **1.16 的 `com.example.lab.shop` 才是成品**。

**這一章要映射的五張表**（07 站 1.12 的子集，00 章 0.3.0 已經列過完整的 `CREATE TABLE`）：

```
customer     客戶      —— 生成欄位 email_active（1.8.3）、樂觀鎖 version
product      商品      —— DECIMAL(19,4) 單價（1.10.1）、BOOLEAN
stock        庫存      —— 02 章處理（它跟 product 是一對一）
orders       訂單      —— enum status（1.7）、CHAR(3) 幣別（1.12.2）、時間欄位（1.9）
order_item   訂單明細  —— 快照欄位、02 章處理關聯
```

### 1.2.2 這一章要交出什麼

```
✅ 一組 ddl-auto: validate 通得過的實體（1.16）
✅ 一個 BaseEntity —— 解決主鍵、Persistable、equals/hashCode 三件事
✅ 一份「07 站 11 條不變量 × JPA 守在哪一層」的對照表（1.13）
✅ 一組把不變量守在【實體方法】裡的狀態機（1.16 驗收）
```

⚠️ **這一章【不】處理的**：

| 不在這一章 | 在哪裡 |
|---|---|
| `@OneToMany` / `@ManyToOne` 怎麼設、擁有方是誰、`cascade` | **02 章** |
| 為什麼 `o.getItems()` 會突然打一句 SQL | **03、04 章** |
| 00 章 0.3.1 那個「`UPDATE` 寫了九個欄位」 | **06 章**（`@DynamicUpdate`） |
| Entity 該不該直接當領域模型、要不要兩層 | **09 章**（06 站 03 章 3.5 已經先談過） |

---

### 1.2.3 這一章的實驗環境

**這一章有兩個資料庫**，而它們的角色不一樣：

```
shop  ← 07 站 01 章 1.12 那份 schema（00 章 0.10.1 已經建好）
        1.16 的成品實體跑在這裡，而 1.15 的 ddl-auto: validate 也是對著它跑
ch01  ← 這一章的【實驗變體】專用：每一組實驗一張小表
        （列舉、主鍵策略、時間、金額、生成欄位、@Embedded、審計、equals）
```

📌 **為什麼要分開**：實驗表是**刻意寫壞的**（`e_ord` 用 `INT` 存列舉、
`pk_seq` 用 MySQL 不支援的序列……）。**把它們跟成品放在同一個庫，
`validate` 就永遠不會通過**，而 1.15 那個實測就做不出來。

**建立 `ch01`**（容器與連線見 00 章 0.10.1）：

```sql
CREATE DATABASE ch01 CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE ch01;

-- ① 列舉：ORDINAL 與 STRING 各一張（1.7）
CREATE TABLE e_ord (id INT AUTO_INCREMENT PRIMARY KEY, status INT NOT NULL);
CREATE TABLE e_str (id INT AUTO_INCREMENT PRIMARY KEY, status VARCHAR(16) NOT NULL);

-- ② 主鍵策略：五種各一張（1.6）
CREATE TABLE pk_identity (id BIGINT AUTO_INCREMENT PRIMARY KEY, v VARCHAR(20) NOT NULL);
CREATE TABLE pk_table    (id BIGINT PRIMARY KEY, v VARCHAR(20) NOT NULL);
CREATE TABLE pk_seq      (id BIGINT PRIMARY KEY, v VARCHAR(20) NOT NULL);
CREATE TABLE pk_uuid4    (id BINARY(16) PRIMARY KEY, v VARCHAR(20) NOT NULL);
CREATE TABLE pk_uuid7    (id BINARY(16) PRIMARY KEY, v VARCHAR(20) NOT NULL);
CREATE TABLE pk_gen7     (id BINARY(16) PRIMARY KEY, v VARCHAR(20) NULL);
CREATE TABLE pk_uuid7p   (id BINARY(16) PRIMARY KEY, v VARCHAR(20) NOT NULL);  -- Persistable（1.6.6）

-- ★ TABLE 策略要的那張表，Hibernate 6 的預設名字
CREATE TABLE hibernate_sequences (sequence_name VARCHAR(255) NOT NULL,
                                  next_val BIGINT, PRIMARY KEY (sequence_name));
-- ★ 而 SEQUENCE 策略在 MySQL 上會去找【這一張】—— 1.6.3 那個「啟動就炸」的原因
CREATE TABLE pk_seq_seq (next_val BIGINT);

-- ③ 時間：四種型別對同一欄（1.9）
CREATE TABLE t_time (
  id INT AUTO_INCREMENT PRIMARY KEY,
  as_instant DATETIME(3) NULL,
  as_ldt     DATETIME(3) NULL,
  as_odt     DATETIME(3) NULL,
  as_ts      TIMESTAMP(3) NULL
);

-- ④ 金額精度（1.10.1）
CREATE TABLE t_money (id INT AUTO_INCREMENT PRIMARY KEY, amt DECIMAL(19,4) NOT NULL);

-- ⑤ 生成欄位 + 軟刪除唯一索引（1.8.3）
CREATE TABLE gen_customer (
  id           BINARY(16)   NOT NULL,
  email        VARCHAR(255) NOT NULL,
  deleted_at   DATETIME(3)  NULL,
  email_active VARCHAR(255) GENERATED ALWAYS AS (IF(deleted_at IS NULL, email, NULL)) VIRTUAL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_gen_email_active (email_active)
) ENGINE=InnoDB;

-- ⑥ @Embedded 值物件攤平之後長什麼樣（1.10.3 / 1.14）
CREATE TABLE emb_address (
  id              BINARY(16)   NOT NULL,
  recipient       VARCHAR(64)  NOT NULL,
  postal_code     VARCHAR(10)  NOT NULL,
  line1           VARCHAR(200) NOT NULL,
  line2           VARCHAR(200) NULL,
  amount_value    DECIMAL(19,4) NOT NULL,
  amount_currency CHAR(3)       NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB;

-- ⑦ 審計欄位兩種做法：應用端寫 vs 資料庫寫（1.12）
CREATE TABLE aud_doc (
  id         BINARY(16)   NOT NULL,
  title      VARCHAR(100) NOT NULL,
  created_at DATETIME(3)  NOT NULL,
  updated_at DATETIME(3)  NOT NULL,
  created_by VARCHAR(64)  NULL,
  updated_by VARCHAR(64)  NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB;

CREATE TABLE db_doc (
  id         BINARY(16)   NOT NULL,
  title      VARCHAR(100) NOT NULL,
  created_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                          ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id)
) ENGINE=InnoDB;

-- ⑧ equals / hashCode 四種寫法各一張（1.11）
CREATE TABLE eq_default (id BIGINT AUTO_INCREMENT PRIMARY KEY, v VARCHAR(20) NULL);
CREATE TABLE eq_id      (id BIGINT AUTO_INCREMENT PRIMARY KEY, v VARCHAR(20) NULL);
CREATE TABLE eq_uuid    (id BINARY(16) PRIMARY KEY, v VARCHAR(20) NULL);
CREATE TABLE eq_uuid2   (id BINARY(16) PRIMARY KEY, v VARCHAR(20) NULL);

-- ⑨ 值物件 / 驗證用的小表（1.13）
CREATE TABLE v_user (
  id       BINARY(16)   NOT NULL,
  email    VARCHAR(255) NOT NULL,
  nickname VARCHAR(20)  NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB;
```

**每一組實驗要的 repository 都是一行**（放在 `com.example.lab.ch01`）：

```java
package com.example.lab.ch01;

import org.springframework.data.jpa.repository.JpaRepository;

public interface EOrdRepo extends JpaRepository<EOrd, Integer> {}
```

```java
package com.example.lab.ch01;

import org.springframework.data.jpa.repository.JpaRepository;

public interface EStrRepo extends JpaRepository<EStr, Integer> {}
```

📌 **後面幾節的 `PkIdentityRepo` / `TTimeRepo` / `EqIdRepo`……全部是同一個形狀**，
不再逐一列出：`interface XxxRepo extends JpaRepository<Xxx, 主鍵型別> {}`。

**這一章的測試骨架** —— 每一個實驗類別長這樣，
後面小節的程式碼片段都是它裡面的一個 `@Test` 方法：

```java
package com.example.lab;

import com.example.lab.ch01.*;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * ★ 連到 ch01（實驗庫），不是 shop。
 *   1.15 那個 ddl-auto: validate 的實驗是【另一個】測試類別，它連 shop。
 */
@SpringBootTest(properties = {
  "spring.datasource.url=jdbc:mysql://127.0.0.1:33306/ch01"
      + "?connectionTimeZone=UTC&forceConnectionTimeZoneToSession=true"
      + "&preserveInstants=true&characterEncoding=UTF-8"
})
class C1Enum {

    @Autowired EOrdRepo ords;            // 這一組實驗要用的 repository
    @Autowired EStrRepo strs;
    @Autowired JdbcTemplate jdbc;        // ★ 繞過 JPA 看資料庫【真正】存了什麼
    @Autowired TransactionTemplate tx;   // ★ 交易邊界要自己畫，理由見 03 章 3.11.2

    @Test
    void 兩種列舉映射存進去長什麼樣() {
        // …（1.7.2 的內容）
    }
}
```

⚠️ **`ddl-auto` 必須是 `none`**（00 章 0.10.2 的 `application.yml` 已經這樣設）——
上面那些表是**刻意跟實體不一致**的，讓 Hibernate 去建它們，這一章的實測全部會消失。

---

## 1.3 一個實體最少要有什麼

### 1.3.1 五個硬性要求

```java
@Entity                              // ① 必須有
@Table(name = "customer")            //   （表名跟類名不同時要寫）
public class Customer {              // ② 不能是 final，不能是 enum / interface

    @Id                              // ③ 必須有一個 @Id
    private UUID id;

    private String email;            // ④ 欄位不能是 final

    protected Customer() {}          // ⑤ 必須有一個【無參數建構子】，至少 protected
}
```

**每一條的理由，都是「Hibernate 要在執行期對它做手腳」**：

| # | 要求 | 為什麼 | 違反時 |
|---|---|---|---|
| ① | `@Entity` | 沒有它，Hibernate 根本不知道這個類別存在 | 啟動時 `Not a managed type` |
| ② | 不能 `final` | **延遲載入的代理是一個子類別**（04 章） | 啟動失敗或 lazy 靜默失效 |
| ③ | `@Id` | 持久化情境用 id 當 key（00 章 0.6.2） | 啟動時 `No identifier specified` |
| ④ | 欄位不能 `final` | Hibernate 用反射填值，`final` 填不了 | 讀出來是 null |
| ⑤ | 無參數建構子 | Hibernate 先 `newInstance()` 再填欄位 | 啟動時 `No default constructor` |

⚠️ **第 ⑤ 條有一個實務上的糾結**：無參數建構子讓實體可以被建立成「半成品」，
這跟「建構子保證物件一定合法」的原則衝突。

📌 **本課的折衷**（1.16 會用到）：

```java
protected Customer() {}                                       // 給 Hibernate 用，宣告成 protected
public Customer(UUID id, String email, String displayName) {  // 給【人】用的，才是真的建構子
    super(id);
    this.email = email;
    this.displayName = displayName;
}
```

**`protected` 讓 IDE 的自動完成不會把它推給呼叫端**，而 Hibernate 照樣用得到。

### 1.3.2 欄位存取 vs 屬性存取

**`@Id` 貼在哪裡，決定了 Hibernate 怎麼讀寫【所有】欄位**：

```java
// ① 欄位存取（field access）—— @Id 貼在欄位上
@Entity
public class A {
    @Id private UUID id;           // ★ Hibernate 直接用反射讀寫【欄位】，不呼叫 getter/setter
    private String name;
}

// ② 屬性存取（property access）—— @Id 貼在 getter 上
@Entity
public class B {
    private UUID id;
    @Id public UUID getId() { return id; }    // ★ Hibernate 呼叫 getter / setter
    public void setId(UUID id) { this.id = id; }
}
```

⚠️ **不能混用**（同一個實體裡有些貼欄位、有些貼 getter），除非明確用 `@Access` 標註。

**兩者的實際差別**：

| | 欄位存取 | 屬性存取 |
|---|---|---|
| 需要 setter 嗎 | ✅ **不需要**——可以完全沒有 setter | 🔴 需要（至少 `protected`） |
| getter 裡的邏輯會被執行嗎 | ✅ 不會 | ⚠️ **會**——包含你在裡面寫的防禦性拷貝、`null` 處理 |
| 可以只暴露計算後的值嗎 | ✅ | 🔴 難 |
| 代理初始化的時機 | 存取任何屬性時 | 同左 |

> 📌 **本課一律用欄位存取**（`@Id` 貼欄位），理由是第一列：
> **它讓實體可以沒有 setter。**
>
> 沒有 setter 的實體，改狀態只能透過**具名的方法**（`order.pay()`、`order.cancel()`），
> 而那正是 1.13 要談的「不變量守在哪」——
> **一個有 `setStatus(String)` 的實體，狀態機就等於不存在。**

⚠️ **屬性存取有一個真實的陷阱**：

```java
@Entity
public class C {
    private String name;

    @Id public UUID getId() { return id; }

    // 🔴 Hibernate 會呼叫這個 getter 去取值來寫進資料庫
    public String getName() { return name == null ? "（未命名）" : name; }
}
```

**結果：資料庫裡永遠不會有 `NULL`，全部是「（未命名）」**——
而寫這個 getter 的人只是想讓畫面好看一點。

---

## 1.4 `@Column`、命名策略與 `@Transient`

**Hibernate 有一套預設的命名策略，猜得到大部分欄位名**：

```java
private String displayName;        // → display_name    ✅ 猜得到
private String email;              // → email           ✅ 猜得到
private BigDecimal unitPrice;      // → unit_price      ✅ 猜得到
private Instant placedAt;          // → placed_at       ✅ 猜得到
```

📌 **Spring Boot 的預設是 `CamelCaseToUnderscoresNamingStrategy`**——
駝峰轉底線、全部小寫。**07 站 1.11 的命名慣例（小寫 + 底線）剛好跟它對得上**，
所以本課大部分欄位**不需要寫 `@Column(name = ...)`**。

**什麼時候一定要寫**：

```java
// ① 名字對不上
@Column(name = "order_no") private String orderNo;          // orderNo → order_no ✅ 其實猜得到
@Column(name = "is_active") private boolean active;         // active → active 🔴 猜不到 is_active

// ② 要限制長度（會影響 DDL 與 validate，1.12）
@Column(length = 64) private String displayName;

// ③ 數值精度（1.10.1 —— 這個【一定】要寫）
@Column(precision = 19, scale = 4) private BigDecimal unitPrice;

// ④ 唯讀欄位（1.8）
@Column(insertable = false, updatable = false) private Instant createdAt;
```

⚠️ **一個很容易錯的地方**：`boolean active` 對應 `is_active` 欄位。
命名策略只會把 `active` 轉成 `active`，**不會自動加 `is_` 前綴**。
07 站 1.11 的慣例是布林欄位加 `is_` / `has_` 前綴，所以這裡**每一個布林欄位都要寫 `@Column`**。

**不想映射的欄位用 `@Transient`**：

```java
@jakarta.persistence.Transient        // ★ 注意：不是 java 的 transient 關鍵字
private boolean isNew = true;         // 1.6.5 的 Persistable 會用到
```

📌 **`jakarta.persistence.Transient` 與 Java 的 `transient` 關鍵字都可以**，
但兩者語意不同（一個是「不要存進資料庫」，一個是「不要 Java 序列化」）。
**本課一律用註解，因為意圖比較明確。**

---

## 1.5 `ddl-auto`：五個值

在往下之前，先把這個設定講清楚，因為 1.12 整節都靠它。

| 值 | 做什麼 | 可以用在哪 |
|---|---|---|
| `none` | 什麼都不做 | ✅ **所有環境**（本課；schema 由 Flyway 管，07 站 06 章） |
| `validate` | 啟動時檢查實體與 schema 對不對得上，對不上就**啟動失敗** | ✅ **強烈建議**，見 1.12 |
| `update` | 試著把 schema 改成實體的樣子 | 🔴 **絕對不要**，見下 |
| `create` | 每次啟動先 `DROP` 再 `CREATE` | 🟡 只在**測試**用 |
| `create-drop` | 同上，而且關閉時再 `DROP` 一次 | 🟡 只在**測試**用 |

🔴 **`update` 為什麼不能用**（07 站 06 章已經完整處理，這裡複述四個理由）：

```
① 它【不會刪】任何東西 —— 你把欄位從實體拿掉，資料庫那一欄永遠留著
② 它【不會改】型別與長度 —— VARCHAR(50) 改成 VARCHAR(200)，它不動
③ 它【不可重現】 —— 同一份程式碼，跑在不同的既有 schema 上，結果不同
④ 它【沒有回滾】 —— 而且 MySQL 沒有 DDL 交易（07 站 06 章），做到一半失敗就是半套
```

📌 **本課的組合**：

```yaml
spring:
  jpa:
    hibernate:
      ddl-auto: none          # 正式環境：Flyway 負責 schema
```

```yaml
# 而 CI 的驗證 profile 用 validate（1.12）
spring:
  jpa:
    hibernate:
      ddl-auto: validate
```

⚠️ **兩者的分工**：`none` 讓應用啟動不去碰 schema；
`validate` 是一個**獨立的檢查**，讓「實體與 schema 漂移」在 CI 就被抓到。
**1.12.3 會實測它到底抓得到什麼。**

---
## 1.6 主鍵策略 ★★

00 章 0.3.3 留下一個問題：**應用端指定 UUIDv7 主鍵，讓 `save()` 每次多打一句 `SELECT`。**
這一節把五種策略全部攤開量一次，再回來解那個問題。

### 1.6.1 五個候選

```java
// ① IDENTITY —— 靠資料庫的 AUTO_INCREMENT
@Id @GeneratedValue(strategy = GenerationType.IDENTITY) private Long id;

// ② TABLE —— 用一張表當計數器
@Id
@GeneratedValue(strategy = GenerationType.TABLE, generator = "tg")
@TableGenerator(name = "tg", table = "hibernate_sequences",
                pkColumnName = "sequence_name", valueColumnName = "next_val",
                pkColumnValue = "pk_table", allocationSize = 50)
private Long id;

// ③ SEQUENCE —— 資料庫的 sequence 物件（MySQL 沒有，見 1.6.3）
@Id @GeneratedValue(strategy = GenerationType.SEQUENCE) private Long id;

// ④ UUID —— JPA 3.1 新增（00 章 0.4.5）
@Id @GeneratedValue(strategy = GenerationType.UUID) private UUID id;

// ⑤ 應用端指定 —— 沒有 @GeneratedValue（07 站 1.8.4 的選擇）
@Id private UUID id;
```

### 1.6.2 實測：存第一筆，各打幾句 SQL

```
── ① IDENTITY → 1 句 SQL
   1) insert into pk_identity (v) values (?)

── ② TABLE (allocationSize=50) → 4 句 SQL
   1) select tbl.next_val from hibernate_sequences tbl where tbl.sequence_name=? for update
   2) insert into hibernate_sequences (sequence_name, next_val) values (?,?)
   3) update hibernate_sequences set next_val=? where next_val=? and sequence_name=?
   4) insert into pk_table (v,id) values (?,?)

── ③ SEQUENCE（MySQL 沒有 sequence）→ 3 句 SQL
   1) select next_val as id_val from pk_seq_seq for update
   2) update pk_seq_seq set next_val= ? where next_val=?
   3) insert into pk_seq (v,id) values (?,?)

── ④ UUID（JPA 3.1）→ 1 句 SQL
   1) insert into pk_uuid4 (v,id) values (?,?)

── ⑤ 應用端指定的 UUIDv7 → 2 句 SQL
   1) select pu1_0.id,pu1_0.v from pk_uuid7 pu1_0 where pu1_0.id=?     ← 🔴 多出來的
   2) insert into pk_uuid7 (v,id) values (?,?)
```

**產出的 id 長什麼樣**：

```
  IDENTITY : 202
  TABLE    : 1        hibernate_sequences = [{sequence_name=pk_table, next_val=50}]
  SEQUENCE : 1        pk_seq_seq          = [{next_val=51}]
  UUIDv4   : 8E8BC18707AC4D97BB21672489623E2B
  UUIDv7   : 01A079FD4D9F7A80B5E04FB9E6CDAD96
```

⚠️ **注意 ② 那個 `for update`**：`TABLE` 策略每次配號都要**鎖一列**。
`allocationSize=50` 讓它每 50 筆才鎖一次（看 `next_val=50`），
**但那 50 個號碼是在記憶體裡發的**——應用重啟就跳號。

⚠️ **注意最後兩行的差別**（07 站 1.8.4 的重點）：

```
UUIDv4:  8E8BC187 07AC 4D97 ...   ← 開頭是【隨機】的
UUIDv7:  01A079FD 4D9F 7A80 ...   ← 開頭是【毫秒時間戳】，所以是遞增的
```

**這個差別決定了 InnoDB 聚簇索引會不會到處分裂**（07 站 1.8.4 量過）。

### 1.6.3 MySQL 沒有 `SEQUENCE`，那 ③ 是怎麼跑的

⚠️ **第一次跑的時候它是直接爆的**：

```
java.sql.SQLSyntaxErrorException: Table 'ch01.pk_seq_seq' doesn't exist
```

📌 **Hibernate 6 在 MySQL 上遇到 `GenerationType.SEQUENCE`，會【幫你建一張表來模擬】**——
表名是 `<表名>_seq`（這裡是 `pk_seq_seq`），裡面只有一欄 `next_val`。

**如果 `ddl-auto` 是 `create` 它會自己建；`ddl-auto: none`（本課）它不會，於是啟動就炸。**

> 🔴 **所以「MySQL 專案不要用 `SEQUENCE`」不是因為它不能用，
> 是因為它會【偷偷多一張你沒有寫進 Flyway 的表】。**
>
> 而那張表在 07 站 06 章的「黃金 schema 守門」下會是一個漂移。

### 1.6.4 實測：批次插入 —— `IDENTITY` 的致命傷 ★★

**設定**（06 章會完整處理，這裡先開起來）：

```yaml
spring:
  datasource:
    url: jdbc:mysql://...?rewriteBatchedStatements=true    # ★ 07 站 00 章 0.7.4
  jpa:
    properties:
      hibernate:
        jdbc:
          batch_size: 50
        order_inserts: true
```

**一個交易裡存 200 筆**：

```
① IDENTITY       共 200 句（insert 200 / select   0 / 其中批次 0），135 ms
② TABLE(50)      共  15 句（insert   5 / select   5 / 其中批次 4）， 40 ms
④ UUID(v4)       共   4 句（insert   4 / select   0 / 其中批次 4）， 28 ms
⑤ 指定 UUIDv7    共 204 句（insert   4 / select 200 / 其中批次 4），114 ms
```

⚠️⚠️ **看 ① 那一列：200 句 insert，批次 0。批次設定完全沒有作用。**

**為什麼**：`IDENTITY` 的 id 是**資料庫在 `INSERT` 之後才給**的。
而 JPA 規定 `persist()` 回來之後實體就要有 id（它要拿 id 當持久化情境的 key，00 章 0.6.2）。

```
批次的意思是「攢一批，最後一次送出去」
IDENTITY 的意思是「每一句都要【立刻】送出去，才拿得到 id」

→ 兩者【邏輯上不相容】。Hibernate 選擇放棄批次。
```

> 📌 **這是一個沒有 workaround 的取捨**（除非改用 `TABLE` / `SEQUENCE` / 應用端指定）。
> **而它不會有任何警告**——你設了 `batch_size=50`，看起來一切正常，
> **只是它一句都沒有批次。**
>
> ⚠️ **這也是 00 章 0.3.7 那張表的又一個例子**：
> 在本機存 10 筆，200 ms 跟 210 ms 你分不出來。
> 上線之後每天匯入 50 萬筆，差的是**小時**。

**④ 為什麼是 4 句**：200 筆 ÷ `batch_size` 50 = 4 批，每批一句 `[batch ×50]`。
**這是批次正常運作時該有的樣子。**

**⑤ 為什麼有 200 句 `select`**：就是 00 章 0.3.3 那個 `merge` 問題。
**注意它的 insert 只有 4 句、而且有批次**——
**問題不在插入，在那 200 句多餘的查詢。** 1.6.6 會解掉它。

### 1.6.5 五種策略的對照表

| | `IDENTITY` | `TABLE` | `SEQUENCE` | `UUID`(v4) | **指定 UUIDv7** |
|---|---|---|---|---|---|
| MySQL 支援 | ✅ 原生 | ✅ | 🟡 **偷偷建一張表**（1.6.3） | ✅ | ✅ |
| 存一筆的 SQL | 1 | 4（首次） | 3（首次） | 1 | 2 🔴 |
| **批次插入** | 🔴 **完全失效** | ✅ | ✅ | ✅ | ✅ |
| id 什麼時候拿得到 | `INSERT` 之後 | **之前** | **之前** | **之前** | **之前** |
| 索引友善（07 站 1.8.4） | ✅ 遞增 | ✅ 遞增 | ✅ 遞增 | 🔴 **隨機** | ✅ 遞增 |
| 佔用空間 | 8 bytes | 8 bytes | 8 bytes | 16 bytes | 16 bytes |
| 跨資料庫產生 id | 🔴 | 🟡 | 🟡 | ✅ | ✅ |
| 會不會跳號 | 會（07 站 1.8） | 會（allocation） | 會 | — | — |
| 額外的表 | — | 🔴 一張 | 🔴 一張 | — | — |

📌 **「id 什麼時候拿得到」這一列比想像中重要**。
`IDENTITY` 之外的四種，你在 `INSERT` 之前就有 id，這讓三件事變簡單：

```
① Outbox：訂單 id 要寫進事件 payload，而事件跟訂單在同一個交易（05 站 06 章 6.8）
② 一次建一整個聚合：明細要指向訂單 id，不用等訂單先 flush（1.16 驗收）
③ 日誌與追蹤：請求一進來就有 id 可以寫進 log
```

### 1.6.6 `Persistable`：把那 200 句 `SELECT` 拿掉 ★★

**問題的根源**（00 章 0.3.3 已經分析過）：
`SimpleJpaRepository.save()` 用 `isNew()` 決定要 `persist` 還是 `merge`，
而預設的 `isNew()` 就是「**`@Id` 欄位是不是 `null`**」。
應用端指定 id ⇒ 永遠不是 null ⇒ 永遠走 `merge` ⇒ 永遠先 `SELECT`。

**解法：讓實體自己回答。**

```java
package com.example.lab.ch01;

import jakarta.persistence.*;
import org.springframework.data.domain.Persistable;

import java.util.UUID;

@Entity @Table(name = "pk_uuid7p")
public class PkUuid7P implements Persistable<UUID> {

    @Id private UUID id;
    private String v;

    @Transient                       // ★ jakarta.persistence.Transient：不映射到欄位
    private boolean isNew = true;

    protected PkUuid7P() {}
    public PkUuid7P(UUID id, String v) { this.id = id; this.v = v; }

    @Override public UUID getId() { return id; }
    @Override public boolean isNew() { return isNew; }

    @PostPersist @PostLoad
    void markNotNew() { this.isNew = false; }   // 存過或載入過，就不是新的了
}
```

**實測（存 200 筆，批次設定與 1.6.4 相同：`batch_size=50` + `rewriteBatchedStatements=true`）**：

```
🔴 沒有 Persistable      共 204 句（insert 4 / select 200），182 ms
✅ 有 Persistable        共   4 句（insert 4 / select   0）， 19 ms
```

**204 句 → 4 句，182 ms → 19 ms（9.6 倍）。**

📌 **注意 `insert` 兩邊都是 4 句**（200 ÷ 50 = 4 批）——
**`Persistable` 沒有改善插入，它拿掉的是那 200 句多餘的 `SELECT`。**

⚠️ **這也解釋了為什麼這裡的數字跟 00 章 0.3.3 不一樣**：
00 章那個實驗**沒有開批次**，所以是 200 句 `INSERT` + 200 句 `SELECT` = 400 句。
**同一個問題，在不同的批次設定下有不同的數字——但那 200 句 `SELECT` 是一樣的。**

📌 **`@PostPersist` 與 `@PostLoad` 這兩個標註是關鍵**：

```
@PostPersist  →  這個實體剛被 INSERT 進去 → 它不再是「新的」
@PostLoad     →  這個實體是從資料庫【讀出來】的 → 它從來就不是「新的」
```

**少了任何一個，都會出事**：

```
🔴 少了 @PostLoad   → 讀出來的實體 isNew() 還是 true
                     → save() 走 persist → Duplicate entry
🔴 少了 @PostPersist → 同一個交易裡存兩次，第二次還是 persist → Duplicate entry
```

### 1.6.7 `Persistable` 的兩個坑

**坑一：`detached` 的實體是安全的**（先確認這個**不是**坑）

```java
// 交易 A 載入，帶出來
PkUuid7P detached = tx.execute(s -> repo.findById(id).orElseThrow());
// 交易 B 存回去
tx.executeWithoutResult(s -> repo.save(detached));
```

```
   detached.isNew() = false   ← @PostLoad 已經翻成 false
── save(detached) → 1 句 SQL
   1) select pup1_0.id,pup1_0.v from pk_uuid7p pup1_0 where pup1_0.id=?
   DB: [{v=原始}]
```

✅ **正確**：它走 `merge`（所以有那句 `SELECT`），而那正是 detached 實體該有的行為。

**坑二：繞過一圈序列化再回來 🔴**

**這才是真的坑。** 實體被 Jackson 序列化成 JSON（放進 Redis 快取、送進 MQ、經過 HTTP），
再反序列化回來——**`@PostLoad` 從來沒有跑過**：

```
   載入的那個  isNew() = false
   反序列化的  isNew() = true   ← 🔴 @PostLoad 沒有跑過，它以為自己是新的
   🔴 DataIntegrityViolationException
   could not execute statement [Duplicate entry '\x01\xA0y\xFE\xFA\x00w\x80...' for key 'pk_uuid7p.PRIMARY']
```

⚠️ **同樣的機制還有第三種觸發方式，而且更常見**：
**「從 DTO 組回一個實體再存」**——

```java
// 🔴 這段程式碼在【沒有】Persistable 時是對的（走 merge → UPDATE）
//    加上 Persistable 之後，它變成 persist → Duplicate entry
public void update(OrderDto dto) {
    repository.save(new Order(dto.id(), dto.orderNo(), ...));
}
```

> 📌 **這兩個坑的共同形狀**：
> **`Persistable` 把「這筆是不是新的」從一個【可以推導的事實】變成一個【要維護的狀態】。**
> 而狀態會在你沒注意到的地方被重置。
>
> ✅ **本課的做法**（1.16 的 `BaseEntity`）：
> **接受 `Persistable`，但同時要求「更新一定要先 `findById` 載入」**——
> 也就是 06 站 00 章 0.4.3 那條 Repository 的規矩：
> **`findById` → 改領域物件 → 靠髒檢查寫回**，而不是 `new` 一個再 `save`。
>
> ⚠️ 如果你的團隊守不住這條規矩，**那就不要用 `Persistable`**，
> 多那一句 `SELECT` 換一個不會靜默壞掉的語意，通常是划算的。

### 1.6.8 為什麼不用 `GenerationType.UUID`

JPA 3.1 的 `@GeneratedValue(strategy = GenerationType.UUID)` 看起來完美——
1 句 SQL、可以批次、id 在 `INSERT` 前就有、也不需要 `Persistable`。

🔴 **但它產的是 UUIDv4**（1.6.2 實測：`8E8BC18707AC4D97...`，開頭是隨機的），
**而 07 站 1.8.4 選 UUIDv7 的整個理由就是「不要隨機」。**

**如果你想要「JPA 幫你產、而且是 v7」，要自己寫一個產生器**：

```java
package com.example.lab.ch01;

import org.hibernate.engine.spi.SharedSessionContractImplementor;
import org.hibernate.id.IdentifierGenerator;

import java.util.UUID;

/** 讓 Hibernate 幫你產 UUIDv7（Uuid7 的實作見 00 章 0.3.0）。 */
public class Uuid7Generator implements IdentifierGenerator {
    @Override
    public Object generate(SharedSessionContractImplementor session, Object object) {
        return com.example.lab.Uuid7.next();
    }
}
```

```java
@Id
@GeneratedValue(generator = "uuid7")
@org.hibernate.annotations.GenericGenerator(
        name = "uuid7", type = com.example.lab.ch01.Uuid7Generator.class)
private UUID id;
```

**實測**：

```
── 存一筆（不需要 Persistable） → 1 句 SQL
   1) insert into pk_gen7 (v,id) values (?,?)
  產出的 id: 01A07A106C8C7738930E0D3274150D3E     ← ✅ 開頭是時間戳，是 v7
  存 200 筆: 4 句（批次 4），39 ms
```

📌 **這樣就不需要 `Persistable` 了**——因為 id 是 Hibernate 產的，
它自己知道這筆是新的（`persist` 路徑）。
**1 句 SQL、批次正常、UUIDv7**——三個好處一次拿到。

⚠️ **代價**：`@GenericGenerator` 是 **Hibernate 專有的**（00 章 0.4.6 的 🟡 那一格），
而且**應用端在呼叫 `save()` 之前拿不到 id**——
1.6.5 那張表「id 什麼時候拿得到」的三個好處就沒了。

> **本課選擇「應用端指定 + `Persistable`」**，因為 05 站 06 章的 Outbox
> 需要「在 `save()` 之前就有訂單 id」。
> **如果你的系統沒有這個需求，自訂產生器是更省事的選擇。**

---

## 1.7 列舉映射 ★★

07 站 1.12 的 `orders.status` 是 `VARCHAR(16)`，
`COMMENT` 寫著「對應 `OrderStatus` enum」。**現在要把它對起來。**

```java
package com.example.lab.ch01;

public enum OrderStatus {
    PENDING, PAID, PACKED, SHIPPED, DELIVERED, CANCELLED, REFUNDED
}
```

### 1.7.1 兩個選項

```java
@Enumerated(EnumType.ORDINAL) private OrderStatus status;   // 存序數 0,1,2...（★ 預設值）
@Enumerated(EnumType.STRING)  private OrderStatus status;   // 存名字 "PENDING"
```

⚠️ **`ORDINAL` 是預設值**——也就是說，**你什麼都不寫的時候，用的是危險的那一個。**

```java
private OrderStatus status;      // 🔴 等同 @Enumerated(EnumType.ORDINAL)
```

**實測：兩者存進去長什麼樣**

**兩個實體、同一個列舉、映射到 1.2.3 建的兩張小表**：

```java
package com.example.lab.ch01;

import jakarta.persistence.*;

@Entity @Table(name = "e_ord")
public class EOrd {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY) private Integer id;
    @Enumerated(EnumType.ORDINAL) private OrderStatus status;   // 🔴 存序數

    protected EOrd() {}
    public EOrd(OrderStatus s) { this.status = s; }
    public Integer getId() { return id; }
    public OrderStatus getStatus() { return status; }
}
```

```java
package com.example.lab.ch01;

import jakarta.persistence.*;

@Entity @Table(name = "e_str")
public class EStr {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY) private Integer id;
    @Enumerated(EnumType.STRING) private OrderStatus status;    // ✅ 存名字

    protected EStr() {}
    public EStr(OrderStatus s) { this.status = s; }
    public Integer getId() { return id; }
    public OrderStatus getStatus() { return status; }
}
```

```
═══ enum 常數的順序 ═══
   0 = PENDING
   1 = PAID
   2 = PACKED
   3 = SHIPPED
   4 = DELIVERED
   5 = CANCELLED
   6 = REFUNDED

═══ 資料庫裡實際存的值 ═══
ORDINAL: [{id=1, status=0}, {id=2, status=3}, {id=3, status=5}]
STRING : [{id=1, status=PENDING}, {id=2, status=SHIPPED}, {id=3, status=CANCELLED}]

═══ 讀回來 ═══
ORDINAL: [PENDING, SHIPPED, CANCELLED]     ✅
STRING : [PENDING, SHIPPED, CANCELLED]     ✅
```

**兩個都對。到目前為止，`ORDINAL` 甚至比較省空間。**

### 1.7.2 實測：三個月後，有人在中間插了一個常數 ★★

**需求來了**：要區分「已下單未付款」與「等待金流回呼」。
有人很自然地在 `PENDING` 後面加一個：

```java
public enum OrderStatus {
    PENDING, AWAITING_PAYMENT, PAID, PACKED, SHIPPED, DELIVERED, CANCELLED, REFUNDED
    //       ^^^^^^^^^^^^^^^^ 新增的
}
```

**這是一個看起來完全無害的改動。它通過 code review，它通過所有測試。**

```
═══ 新的 enum 順序 ═══
   0 = PENDING
   1 = AWAITING_PAYMENT
   2 = PAID
   3 = PACKED
   4 = SHIPPED
   5 = DELIVERED
   6 = CANCELLED
   7 = REFUNDED

═══ 資料庫【一個位元組都沒有改】═══
ORDINAL: [{id=1, status=0}, {id=2, status=3}, {id=3, status=5}]
STRING : [{id=1, status=PENDING}, {id=2, status=SHIPPED}, {id=3, status=CANCELLED}]

═══ 但是讀回來 ═══
ORDINAL: [PENDING, PACKED, DELIVERED]     ← 原本是 [PENDING, SHIPPED, CANCELLED]   🔴
STRING : [PENDING, SHIPPED, CANCELLED]    ← 原本是 [PENDING, SHIPPED, CANCELLED]   ✅
```

🔴🔴 **`SHIPPED` 變成了 `PACKED`。`CANCELLED` 變成了 `DELIVERED`。**

**一張三個月前取消的訂單，現在系統認為它已經送達。**

⚠️ **這個事故的四個性質，每一個都讓它更難發現**：

```
① 資料庫沒有任何變化 —— 你去查資料，值還是 5，「資料是對的」
② 沒有任何錯誤、警告、日誌
③ 新資料完全正常 —— 只有【改動之前】存的資料是錯的
④ 改動本身看起來無害 —— 加一個 enum 常數，誰會覺得這需要資料遷移？
```

📌 **而且它會蔓延**：`CANCELLED` 的訂單被當成 `DELIVERED`，
於是它進了對帳報表、觸發了結算、發了通知信。
**等到有人發現的時候，錯誤已經流出資料庫了。**

### 1.7.3 三種做法

| | 存什麼 | 空間 | 加常數在中間 | 可讀性 | DB 端看得懂 |
|---|---|---|---|---|---|
| 🔴 `ORDINAL` | `0` `1` `2` | 最小 | 🔴 **資料全錯** | 🔴 要查程式碼 | 🔴 |
| ✅ `STRING` | `PENDING` | `VARCHAR(16)` | ✅ 沒事 | ✅ | ✅ |
| 🟡 自訂轉換 | 自己定的碼 | 可小可大 | ✅ 沒事 | 🟡 | 🟡 |

**做法三：`AttributeConverter`**——當你想要「短碼」又要「安全」。

⚠️ **這個做法會【取代】1.7 開頭那個 `OrderStatus`**（多了一個明確宣告的 `code`）：

```java
package com.example.lab.ch01;

public enum OrderStatus {
    PENDING("P"), PAID("A"), PACKED("K"), SHIPPED("S"),
    DELIVERED("D"), CANCELLED("C"), REFUNDED("R");

    private final String code;                     // ★ 明確宣告，跟順序無關
    OrderStatus(String code) { this.code = code; }
    public String getCode() { return code; }
}
```

**然後寫一個轉換器**：

```java
package com.example.lab.ch01;

import jakarta.persistence.AttributeConverter;
import jakarta.persistence.Converter;

import java.util.Arrays;

/** 存一個【明確宣告】的短碼，而不是依賴宣告順序。 */
@Converter(autoApply = true)
public class OrderStatusConverter implements AttributeConverter<OrderStatus, String> {

    @Override
    public String convertToDatabaseColumn(OrderStatus s) {
        return s == null ? null : s.getCode();
    }

    @Override
    public OrderStatus convertToEntityAttribute(String code) {
        if (code == null) return null;
        return Arrays.stream(OrderStatus.values())
                .filter(s -> s.getCode().equals(code))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException("未知的訂單狀態代碼：" + code));
    }
}
```

⚠️ **`AttributeConverter` 的價值不只是短碼**，它還給你一個 `ORDINAL` 與 `STRING` 都沒有的東西：

```
🔴 ORDINAL / STRING：資料庫裡出現一個【程式不認識】的值時，Hibernate 拋一個很難懂的例外
✅ Converter      ：你可以自己決定 —— 拋一個看得懂的例外，或是回一個 UNKNOWN
```

> 📌 **本課的選擇：`STRING`。**
>
> 理由是 07 站 1.12 已經把欄位定成 `VARCHAR(16)` 並加了
> `CHECK (status IN ('PENDING','PAID',...))`——
> **資料庫那一側已經用「名字」定義了合法值**，Java 這一側跟著用名字才對得起來。
>
> ⚠️ **而且 `CHECK` 約束是一個額外的保險**：
> 就算有人把 `@Enumerated` 改成 `ORDINAL`，
> **`INSERT` 一個 `0` 進去會被 `CHECK` 擋下來**（1.13 會回到這件事）。
> 這是 07 站那些約束的價值——**它們擋的是「Java 這一側改壞了」。**

### 1.7.4 ⚠️ Hibernate 6 在 MySQL 上的一個變化

**把 `@Enumerated(EnumType.STRING)` 貼上去、`ddl-auto: validate` 跑起來**：

```
Schema-validation: wrong column type encountered in column [status] in table [orders];
  found [varchar (Types#VARCHAR)],
  but expecting [enum ('pending','paid','packed','shipped','delivered','cancelled','refunded') (Types#ENUM)]
```

🔴 **Hibernate 6 在 MySQL 上，預設把 `EnumType.STRING` 映射成【原生的 MySQL `ENUM` 型別】**，
不是 `VARCHAR`。這跟 Hibernate 5 的行為不同。

**而 07 站 1.12 那份 schema 用的是 `VARCHAR(16)` + `CHECK`**
（理由見 07 站 1.6.3：`ENUM` 型別的排序規則藏在 `CREATE TABLE` 裡，查詢的人看不到）。

**修法**：

```java
@Enumerated(EnumType.STRING)
@JdbcTypeCode(SqlTypes.VARCHAR)        // ★ 明確要求 VARCHAR
@Column(nullable = false, length = 16)
private OrderStatus status;
```

📌 **這是本章第二個「Hibernate 想產生的型別 ≠ schema 實際的型別」**
（第一個是 1.12.2 的 `CHAR(3)`）。**兩個都只有 `validate` 抓得到。**

---
## 1.8 生成欄位與唯讀欄位 ★

07 站 1.10.4 用一個**生成欄位**解決了「軟刪除 + 唯一索引」的問題：

```sql
CREATE TABLE gen_customer (
  id           BINARY(16)   NOT NULL,
  email        VARCHAR(255) NOT NULL,
  deleted_at   DATETIME(3)  NULL,
  -- ★ 只有「未刪除」時才有值 → 只有未刪除的列參與唯一性
  email_active VARCHAR(255) GENERATED ALWAYS AS (IF(deleted_at IS NULL, email, NULL)) VIRTUAL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_gen_email_active (email_active)
) ENGINE=InnoDB;
```

**這一欄的值是資料庫算的。JPA 絕對不可以寫它**——寫了會直接被 MySQL 拒絕。

### 1.8.1 `insertable = false, updatable = false`

**這組參數的意思是「這一欄我只讀，不寫」**，它有三個用途：

```java
// ① 生成欄位（資料庫算的）
@Column(name = "email_active", insertable = false, updatable = false)
private String emailActive;

// ② 資料庫預設值（07 站 1.12 的 DEFAULT CURRENT_TIMESTAMP(3)）
@Column(name = "created_at", insertable = false, updatable = false)
private Instant createdAt;

// ③ 唯讀的關聯外鍵（02 章會用到）
@Column(name = "customer_id", insertable = false, updatable = false)
private UUID customerId;
```

⚠️ **少了它會怎樣**：Hibernate 會把這一欄放進 `INSERT` 的欄位清單，
送一個 `null` 過去，然後 MySQL 回：

```
ERROR 3105 (HY000): The value specified for generated column 'email_active' in table 'gen_customer' is not allowed.
```

📌 **對 ② 來說症狀更隱蔽**：`created_at` 有 `DEFAULT CURRENT_TIMESTAMP(3)`，
但 Hibernate 明確送了一個 `null` 過去，**`DEFAULT` 只在「欄位沒有出現在 `INSERT` 裡」時才生效**——
於是你會拿到 `NOT NULL` 違反，或是（在非嚴格模式下）一個零值時間。

### 1.8.2 `@Generated`：讓 JPA 把算好的值讀回來

`insertable = false` 只解決了「不要寫」。**但寫完之後，記憶體裡那個實體的 `emailActive` 是 `null`**——
因為 JPA 沒有理由知道資料庫算了什麼。

```java
import org.hibernate.annotations.Generated;
import org.hibernate.generator.EventType;

@Column(name = "email_active", insertable = false, updatable = false)
@Generated(event = {EventType.INSERT, EventType.UPDATE})     // ★ Hibernate 專有
private String emailActive;
```

⚠️ **`@Generated` 是 Hibernate 專有的**（00 章 0.4.6 那張「只有 Hibernate 有」的表要再加一列），
而且**它有代價**。實測：

```
── save → 3 句 SQL
   1) select gc1_0.id,gc1_0.deleted_at,gc1_0.email,gc1_0.email_active from gen_customer gc1_0 where gc1_0.id=?
   2) insert into gen_customer (deleted_at,email,id) values (?,?,?)
   3) select gc1_0.email_active from gen_customer gc1_0 where gc1_0.id=?     ← ★ 多出來的
```

📌 **每一次 `INSERT` 或 `UPDATE` 之後，都多一句 `SELECT`** 去把生成欄位讀回來。

> ⚠️ **所以 `@Generated` 要按需使用**：
> **只有當「應用程式真的需要讀那一欄」的時候才加。**
>
> 而 `email_active` 這一欄的用途是**給唯一索引用的**——
> 應用程式從來不需要讀它。**所以本課【不】加 `@Generated`**，
> 甚至可以完全不把它映射進實體（1.12.3 實測：`validate` 不管 DB 多出來的欄位）。

### 1.8.3 實測：軟刪除 + 唯一索引，在 JPA 上跑一次

**07 站 1.10.4 的行為，透過 JPA 走一遍**：

```java
@Entity @Table(name = "gen_customer")
public class GenCustomer {
    @Id private UUID id;
    private String email;
    @Column(name = "deleted_at") private Instant deletedAt;

    @Column(name = "email_active", insertable = false, updatable = false)
    @Generated(event = {EventType.INSERT, EventType.UPDATE})
    private String emailActive;

    protected GenCustomer() {}
    public GenCustomer(UUID id, String email) { this.id = id; this.email = email; }
    public UUID getId() { return id; }
    public String getEmailActive() { return emailActive; }
    public void softDelete() { this.deletedAt = Instant.now(); }
}
```

```
─── 註冊
  save 之後，記憶體裡的 emailActive = null      ← ⚠️ 因為還沒 flush（00 章 0.6.4）
  DB: [{email=a@x.com, deleted_at=null, email_active=a@x.com}]

─── 軟刪除之後
── softDelete → 3 句 SQL
   2) update gen_customer set deleted_at=?,email=? where id=?     ← ★ 沒有 email_active
  DB: [{email=a@x.com, deleted_at=2026-09-07T03:54:33.313, email_active=null}]

─── 同一個 email 重新註冊
  ✅ 可以重新註冊
  DB: [{email=a@x.com, deleted_at=2026-09-07T03:54:33.313, email_active=null},
       {email=a@x.com, deleted_at=null,                    email_active=a@x.com}]
```

✅ **07 站 1.10.4 那個設計，在 JPA 上原封不動地work。**

⚠️ **注意第一行那個 `null`**：`save()` 回來的當下，`emailActive` 還是 `null`。
**因為 `INSERT` 根本還沒送出去**（00 章 0.6.4「寫入時機」）。
要在同一個交易裡讀到它，得先 `flush()`。

---

## 1.9 時間映射 ★★

07 站 1.12 把所有時間欄位定成 `DATETIME(3)`，並且說「**語意上是 UTC**」。
07 站 00 章 0.6 花了一整節處理「四個時區在打架」。

**現在 Java 這一側要選一個型別，而這個選擇會決定第五個時區。**

### 1.9.1 四個候選

```java
private Instant        placedAt;    // 絕對時刻，沒有時區概念（就是一個 epoch 毫秒）
private LocalDateTime  placedAt;    // 牆上的時間，【不帶】時區
private OffsetDateTime placedAt;    // 帶固定位移（+08:00）
private ZonedDateTime  placedAt;    // 帶具名時區（Asia/Taipei）
```

📌 **`java.util.Date` 與 `java.sql.Timestamp` 不在候選名單**——
它們是 Java 8 之前的東西，可變、語意混亂。**新專案不要用。**

### 1.9.2 實測：同一列資料，換一個 JVM 時區 ★★

**環境**（本課的標準設定，07 站 00 章 0.6.3）：

```
  JVM 預設時區       = Asia/Taipei
  connectionTimeZone = UTC
  MySQL @@time_zone  = +00:00
```

**存進去：同一個絕對時刻的三種表達**

```
  Instant        = 2026-09-07T03:30:00.123Z
  LocalDateTime  = 2026-09-07T11:30:00.123        ← 台北牆上的時間，【不帶】時區
  OffsetDateTime = 2026-09-07T11:30:00.123+08:00
```

**資料庫裡實際存的字面值**：

```
  as_instant = 2026-09-07 03:30:00.123
  as_ldt     = 2026-09-07 03:30:00.123
  as_odt     = 2026-09-07 03:30:00.123
```

✅ **三個都存成 UTC 的 03:30。到目前為止一切正常。**

**現在把程式部署到一個 UTC 的容器**（`user.timezone=UTC`），**讀同一列**：

```
########## JVM = Asia/Taipei ##########
  資料庫裡的字面值：[{i=2026-09-07 03:30:00.123, l=2026-09-07 03:30:00.123, ...}]
  Instant        = 2026-09-07T03:30:00.123Z
  LocalDateTime  = 2026-09-07T11:30:00.123
  OffsetDateTime = 2026-09-07T03:30:00.123Z

########## JVM = UTC （模擬部署到容器）##########
  資料庫裡的字面值：[{i=2026-09-07 03:30:00.123, l=2026-09-07 03:30:00.123, ...}]
  Instant        = 2026-09-07T03:30:00.123Z        ✅ 一樣
  LocalDateTime  = 2026-09-07T03:30:00.123         🔴 差 8 小時
  OffsetDateTime = 2026-09-07T03:30:00.123Z        ✅ 一樣
```

🔴🔴 **同一列資料，資料庫的字面值一個位元組都沒變，
`LocalDateTime` 讀出來差 8 小時。**

**為什麼**：`LocalDateTime` 沒有時區資訊，
所以驅動程式只能拿**「當下的 JVM 預設時區」**去解釋它。
JVM 時區一變，同一個位元組就代表不同的時刻。

⚠️ **這個事故的形狀跟 1.7.2 的 `ORDINAL` 一模一樣**：

```
資料沒變  +  程式碼沒變  +  只是環境變了  →  讀出來的意思變了
```

**而它最容易在什麼時候發生**：

```
🔴 本機開發（Asia/Taipei）→ 部署到 Docker 容器（預設 UTC）
🔴 同一套系統跑在台灣與新加坡兩個機房
🔴 有人在 K8s 的 deployment 裡加了 TZ 環境變數
🔴 JDK 升級（時區資料庫更新）
```

### 1.9.3 `OffsetDateTime` 的一個細節

**注意上面 `OffsetDateTime` 的輸出**：存進去的是 `11:30+08:00`，讀回來是 `03:30Z`。

✅ **絕對時刻是對的**（`11:30+08:00` 與 `03:30Z` 是同一瞬間）。
🔴 **但 `+08:00` 這個位移不見了。**

**因為 `DATETIME(3)` 只有一個欄位，存不下位移。**
如果你的業務需要知道「使用者當時在哪個時區下的單」，
**那是另一個欄位的事**（存一個 `VARCHAR` 的 `Asia/Taipei`），不是時間型別能解決的。

### 1.9.4 四個型別的對照與本課的選擇

| | `Instant` | `LocalDateTime` | `OffsetDateTime` | `ZonedDateTime` |
|---|---|---|---|---|
| 代表什麼 | **絕對時刻** | 牆上的時間 | 絕對時刻 + 位移 | 絕對時刻 + 時區 |
| 換 JVM 時區 | ✅ 不變 | 🔴 **差 8 小時** | ✅ 不變 | ✅ 不變 |
| 存進 `DATETIME(3)` | ✅ | ✅ | 🟡 位移遺失 | 🟡 時區遺失 |
| 適合什麼 | **事件發生的時刻** | 生日、營業時間、「每天 9 點」 | 需要記錄位移 | 需要記錄具名時區 |
| JPA 規格支援 | ✅ 3.1 起 | ✅ | ✅ | ✅ |

> 📌 **本課的規則**（跟 07 站 1.5.4、1.5.5 一致）：
>
> **① 「某件事發生的時刻」一律用 `Instant`。**
> `placed_at`、`paid_at`、`created_at`、`updated_at`——全部都是。
>
> **② 只有「跟時刻無關的日期時間」才用 `LocalDate` / `LocalDateTime`。**
> 生日（`LocalDate`）、店家的營業時間（`LocalTime`）、
> 「這張優惠券在每天的 00:00 重置」（`LocalTime`）。
>
> **③ 需要位移或時區時，多開一個欄位存它**，不要指望時間型別。

⚠️ **一條可以拿去做 code review 的規則**：

> **`@Column` 名稱以 `_at` 結尾的（07 站 1.11 的命名慣例），型別一律是 `Instant`。**
> **看到 `_at` 對到 `LocalDateTime`，就是一個 bug。**

📌 **這條規則可以寫成 ArchUnit 測試**（延續 06 站那六條）：

```java
@Test
void 時刻欄位一律用Instant() {
    fields().that().areDeclaredInClassesThat().resideInAPackage("..shop..")
            // ⚠️ 05 章 5.9.3 會加 hibernate-jpamodelgen（Criteria 的 metamodel），
            //   它會產生 Order_ / Customer_ 這種類別，而它們的欄位是 SingularAttribute。
            //   沒有這一行，這條規則會在加了那個產生器之後開始失敗。
            .and().areDeclaredInClassesThat().haveSimpleNameNotEndingWith("_")
            .and().haveNameMatching(".*(At|Time)$")
            .should().haveRawType(java.time.Instant.class)
            .because("_at 欄位代表【絕對時刻】；LocalDateTime 會跟著 JVM 時區跑（1.9.2）")
            .check(classes);
}
```

---

## 1.10 數值、金額與 `@Embedded` 值物件

### 1.10.1 實測：`DECIMAL(19,4)` 的靜默四捨五入 ★

07 站 1.3.8 把金額定成 `DECIMAL(19,4)`。**Java 這一側對應 `BigDecimal`。**

```java
@Column(name = "unit_price", nullable = false, precision = 19, scale = 4)
private BigDecimal unitPrice;
```

**存各種 scale 進去，看會發生什麼**：

```
  存進去      → 資料庫裡     → 讀回來
  100         → 100.0000     → 100.0000      ✅ 數值相同
  100.5       → 100.5000     → 100.5000      ✅ 數值相同
  100.12345   → 100.1235     → 100.1235      🔴 數值變了
  100.99999   → 101.0000     → 101.0000      🔴 數值變了
  0.00005     → 0.0001       → 0.0001        🔴 數值變了
```

🔴 **`100.12345` 被靜默四捨五入成 `100.1235`。沒有例外、沒有警告。**

⚠️⚠️ **而且這是在 `STRICT_TRANS_TABLES` 底下發生的**
（07 站 00 章 0.8 那個「嚴格模式」）。
**嚴格模式管的是「字串太長」「數字超出範圍」，不管小數位數的截斷**——
小數位截斷在 SQL 標準裡就是允許的行為。

📌 **`0.00005 → 0.0001` 這一列特別值得看**：一個「非常小但不是零」的值，
變成了一個**大一倍**的值。在計算利息、匯率、分潤的場景，這種誤差會累積。

**怎麼防**：

```java
// ✅ ① 在【進入實體之前】就把 scale 訂死（本課採用）
public record Money(BigDecimal value, String currency) {
    public Money {
        value = value.setScale(4, RoundingMode.HALF_UP);   // ★ 明確地、可見地捨入
    }
}

// ✅ ② 或者在建構子拒絕
if (value.scale() > 4) throw new IllegalArgumentException("金額最多四位小數：" + value);
```

> **重點不是「不要捨入」，是「不要【靜默】捨入」。**
> 捨入這件事本身沒問題——問題是它發生在你看不到的地方，而且規則由資料庫決定。

⚠️ **`precision` / `scale` 一定要寫。** 不寫的話 Hibernate 認定的型別是 **`DECIMAL(38,2)`**。

**實測**——請 Hibernate 把它「想要的」DDL 印出來
（`jakarta.persistence.schema-generation.scripts.action=create`）：

```sql
create table no_prec (
  id             integer not null auto_increment,
  no_annotation  decimal(38,2),      -- 🔴 完全不寫 → 38 位整數、2 位小數
  with_prec      decimal(19,4),      -- ✅ 有寫 → 跟 schema 一致
  primary key (id)
) engine=InnoDB;
```

🔴 **`DECIMAL(38,2)` 只有兩位小數**——而 07 站要的是四位。
**在一個沒寫 `scale` 的欄位上，`100.1234` 會被存成 `100.12`。**

⚠️⚠️ **而 1.12.3 的實測會告訴你：`validate` 抓不到這個不一致。**

📌 **這個「印出 Hibernate 想要的 DDL」的技巧本身很有用**，
因為它讓你看見**兩邊的落差**。把本課 00 章那組（還沒修過的）實體印出來：

```sql
create table orders (
  discount_amount decimal(38,2),      -- 🔴 schema 是 DECIMAL(19,4)
  total_amount    decimal(38,2),      -- 🔴 同上
  created_at      datetime(6),        -- 🔴 schema 是 DATETIME(3)
  paid_at         datetime(6),        -- 🔴 同上
  placed_at       datetime(6),        -- 🔴 同上
  updated_at      datetime(6),        -- 🔴 同上
  version         bigint not null,
  customer_id     binary(16),
  id              binary(16) not null,
  currency        varchar(255),       -- 🔴 schema 是 CHAR(3)
  order_no        varchar(255),       -- 🔴 schema 是 VARCHAR(32)
  status          varchar(255),       -- 🔴 schema 是 VARCHAR(16)
  primary key (id)
) engine=InnoDB;
```

**十一處不一致。而 `validate` 只會抱怨其中一處（`currency`）。**
**1.12 就是在處理這件事。**

### 1.10.2 `BigDecimal` 的 `equals` 陷阱

```
  存進去 100 (scale=0)，讀回來是 100.0000 (scale=4)

  new BigDecimal("100").equals(new BigDecimal("100.0000"))    = false
  new BigDecimal("100").compareTo(new BigDecimal("100.0000")) = 0
```

⚠️ **`BigDecimal.equals()` 比較的是「值 **和** scale」。**

**這會咬到三個地方**：

```
🔴 ① 單元測試：assertThat(order.getTotal()).isEqualTo(new BigDecimal("100"))  → 失敗
      ✅ 改用 assertThat(...).isEqualByComparingTo("100")

🔴 ② 髒檢查：Hibernate 用 equals 判斷欄位有沒有變
      → 把 100.0000 設成 100，它認為【變了】，於是發一句沒有意義的 UPDATE

🔴 ③ 你自己寫的 equals / 快取 key
```

📌 **對 ② 的處理**：讓實體裡的 `BigDecimal` **永遠是同一個 scale**——
這正是 1.10.1 那個 `Money` 值物件在做的事。

### 1.10.3 `@Embedded`：把值物件攤平

`unit_price` 與 `currency` 是兩個欄位，但它們在概念上是**一個東西**：一筆錢。

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

    public Money plus(Money o) {
        if (!currency.equals(o.currency)) {
            throw new IllegalArgumentException("幣別不同不能相加：" + currency + " vs " + o.currency);
        }
        return new Money(value.add(o.value), currency);
    }
}
```

```java
@Entity @Table(name = "emb_address")
public class EmbAddress {
    @Id private UUID id;
    private String recipient;
    @Column(name = "postal_code") private String postalCode;
    private String line1;
    private String line2;

    @Embedded private Money amount;      // ★ 兩個欄位攤平進同一張表
    // ...
}
```

📌 **Hibernate 6.2 起，`record` 可以直接當 `@Embeddable`**——
這讓值物件變得非常自然（不可變、自動有 `equals`/`hashCode`/`toString`）。

**實測**：

```
── save（Money 是一個 record） → 2 句 SQL
   insert into emb_address (amount_value,amount_currency,line1,line2,postal_code,recipient,id)
   values (?,?,?,?,?,?,?)

  DB: [{recipient=小明, amount_value=2990.0000, amount_currency=TWD}]
  讀回來: Money[value=2990.0000, currency=TWD]
  值物件的相等性: true
```

**而它真正的價值在這裡**：

```
═══ 值物件的建構子把不變量守在【型別】裡 ═══
  負數 → IllegalArgumentException: 金額不可為負：-1
  幣別 6 碼 → IllegalArgumentException: 幣別要 3 碼：TAIWAN
  TWD + USD → IllegalArgumentException: 幣別不同不能相加：TWD vs USD
```

> 📌 **這是 07 站 1.10.5 那張表的一個重要補充**：
> 07 站說「11 條不變量，資料庫只守得住 6 條」。
> **值物件是第七條的守門人**——它守的是**「這個值本身合不合法」**，
> 而且守在**最早的地方：物件被建立的那一瞬間**。
>
> **`new Money(-1, "TWD")` 根本組不出來，所以它永遠不會有機會被存進資料庫。**

⚠️ **`@Embedded` 的三個限制**：

```
🔴 ① 一個實體裡放兩個同型別的值物件，欄位名會撞
      → 要用 @AttributeOverrides 改名
🔴 ② 值物件不能有自己的 @Id，也不能被單獨查詢
🔴 ③ 全部欄位都 null 時，Hibernate 會把整個值物件讀成 null（不是一個「全 null 的物件」）
```

---
## 1.11 三層檢查：`@Column` / Bean Validation / 資料庫約束 ★

00 章 0.4.4 提過 `@Column(nullable = false)` 與 `@NotNull` 是兩件事。**現在把三層都攤開。**

```java
@Entity @Table(name = "v_user")
public class VUser {
    @Id private UUID id;

    @Column(nullable = false, length = 255)      // ① 只影響【產生 DDL】
    @NotBlank                                    // ② Bean Validation：flush 前檢查
    private String email;                        // ③ 資料庫還有 NOT NULL

    @Column(length = 20)
    @Size(max = 20)                              // ②
    private String nickname;                     // ③ 資料庫還有 VARCHAR(20)
}
```

### 1.11.1 三層各自在什麼時候作用

| | 誰執行 | 什麼時候 | `ddl-auto: none` 時還有用嗎 |
|---|---|---|---|
| ① `@Column(nullable, length)` | Hibernate | **產生 DDL 時**，以及 `validate` 時 | 🔴 **產 DDL 那部分完全沒作用**；只剩 `validate` 會看它 |
| ② `@NotNull` / `@Size`（Bean Validation） | Hibernate Validator | **flush 之前**（`pre-persist` / `pre-update`） | ✅ 有 |
| ③ `NOT NULL` / `VARCHAR(20)` / `CHECK` | **MySQL** | SQL 真的送到資料庫時 | ✅ 有 |

⚠️⚠️ **第一列是最多人誤會的地方**：

> **`@Column(nullable = false)` 在 `ddl-auto: none` 的專案裡，【擋不住任何東西】。**
>
> 它不是一個驗證，它是一個**「請幫我把 DDL 產成 NOT NULL」的指示**。
> 而本課根本不讓 Hibernate 產 DDL。

📌 **那為什麼還要寫它**？兩個理由：

```
① validate 會看它（1.12）—— 它是「實體與 schema 一致」宣告的一部分
② 它是給【讀程式碼的人】看的文件 —— 讓你不用去翻 schema 就知道這一欄不可為空
```

### 1.11.2 實測：三層各自擋住什麼

```
═══ email：@Column(nullable=false) + @NotBlank + DB NOT NULL ═══
  email = null                       🔴 TransactionSystemException（打了 1 句 SQL）
                                        Validation failed for classes [VUser] during persist time
  email = "" （空字串）               🔴 TransactionSystemException（打了 1 句 SQL）
                                        Validation failed for classes [VUser] during persist time

═══ nickname：@Size(max=20) + DB VARCHAR(20) ═══
  nickname 21 字（超過 @Size）        🔴 TransactionSystemException（打了 1 句 SQL）
  nickname 20 字（剛好）              ✅ 存進去了（打了 2 句 SQL）

═══ 繞過 Bean Validation，直接下 SQL ═══
  ✅ 資料庫擋住了：Data truncation: Data too long for column 'nickname' at row 1

  最後 DB 有 1 列
```

⚠️ **注意「打了 1 句 SQL」**：Bean Validation 失敗時，**`INSERT` 根本沒有送出去**
（那 1 句是 `merge` 的 `SELECT`）。**它擋在資料庫之前。**

📌 **注意兩個層次抓到的東西不一樣**：

```
② Bean Validation 抓到了「空字串」 —— 而資料庫的 NOT NULL 【抓不到】，'' 不是 NULL
③ 資料庫抓到了「繞過應用層的寫入」 —— 而 Bean Validation 【看不到】那句 SQL
```

> 📌 **所以三層不是「重複」，是「守不同的東西」**：
>
> | 層 | 它守的是 |
> |---|---|
> | Bean Validation | **使用者輸入的合法性**——而且錯誤訊息可以回給前端（04 站） |
> | 資料庫約束 | **任何路徑寫進來的資料**——包含 MyBatis、批次腳本、DBA 手動下的 SQL |
> | `@Column` + `validate` | **這兩層的定義有沒有漂移** |
>
> ⚠️ **少了資料庫那一層，00 章 0.3.5 那個混用事故就沒有最後防線。**

### 1.11.3 `@NotNull` 的一個副作用

⚠️ **如果你的專案有 `ddl-auto: create`（測試環境常見），
Hibernate 會把 `@NotNull` 也翻譯成 `NOT NULL`**——
於是「測試環境的 schema」跟「正式環境的 schema」不一樣。

```yaml
# 關掉這個行為，讓 DDL 只由 @Column 決定
spring:
  jpa:
    properties:
      hibernate:
        validator:
          apply_to_ddl: false
```

📌 **本課用 `ddl-auto: none` + Flyway，所以碰不到這個問題**——
但如果你的專案還在用 `create-drop` 跑測試，這一行值得加。

---

## 1.12 `validate`：把 schema 與實體釘在一起 ★★

### 1.12.1 它在防什麼

```
🔴 有人改了 schema（Flyway 加了一個 NOT NULL 欄位），忘了改實體
🔴 有人改了實體（多了一個欄位），忘了寫遷移腳本
🔴 兩個人在不同的分支上各改一邊，合併之後沒人發現
```

**這三件事在多人專案裡每個月都會發生。而它們的共同點是：
在開發環境不一定會出事（那個欄位剛好沒被用到），上線之後才炸。**

### 1.12.2 實測：讓 00 章那組實體通過 `validate`

**把 00 章 0.3.0 那五個實體，配上 07 站那份 schema，跑 `ddl-auto: validate`**：

```
Schema-validation: wrong column type encountered in column [currency] in table [orders];
  found [char (Types#CHAR)], but expecting [varchar(255) (Types#VARCHAR)]
```

**修法**：

```java
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

@Column(nullable = false, length = 3)
@JdbcTypeCode(SqlTypes.CHAR)          // ★ 明確說「這是 CHAR 不是 VARCHAR」
private String currency = "TWD";
```

**再跑一次 → 通過。**

⚠️ **然後把 `status` 改成 `@Enumerated(EnumType.STRING)`（1.7 的結論），它又紅了**：

```
Schema-validation: wrong column type encountered in column [status] in table [orders];
  found [varchar (Types#VARCHAR)],
  but expecting [enum ('pending','paid',...) (Types#ENUM)]
```

**修法就是 1.7.4 的 `@JdbcTypeCode(SqlTypes.VARCHAR)`。**

📌 **所以整份 schema，`validate` 一共只抱怨了【兩處】**，
而且兩處都是同一類問題：**Hibernate 想要的 JDBC 型別，跟 schema 實際的型別不同。**

⚠️ **`validate` 一次只報一個錯。** 它遇到第一個不一致就啟動失敗，
所以修的過程是「改一個、跑一次、再改一個」。**這在有幾十張表時很痛苦**，
但也表示**它不會讓你一次看到全部問題**。

### 1.12.3 實測：注入九種漂移，`validate` 抓到幾種 ★★

**這一節才是重點。** 上面說「只抱怨兩處」聽起來像好消息——
**但 1.10.1 那張 DDL 對照表明明有十一處不一致。**

**所以：`validate` 到底在檢查什麼？** 逐一注入，實測：

```
═══ 注入九種漂移，看 validate 抓到幾種 ═══
① 長度不符（DB 255，實體 50）           🔴 沒抓到
② nullable 不符（DB NOT NULL）          🔴 沒抓到
③ DECIMAL 精度不符（DB 19,4 實體 10,2）  🔴 沒抓到
④ DB 有欄位、實體沒有                    🔴 沒抓到
⑤ 實體宣告 unique=true                  🔴 沒抓到
⑥ 實體宣告 status 唯一（DB 沒有）        🔴 沒抓到
⑦ 實體有欄位、DB 沒有                    ✅ missing column [nickname] in table [customer]
⑧ 表名打錯（customer→customers）         ✅ missing table [customers]
⑨ 型別不符（VARCHAR 宣告成 Integer）     ✅ wrong column type encountered in column [email]
   in table [customer]; found [varchar (Types#VARCHAR)], but expecting [integer (Types#INTEGER)]
```

**九種裡抓到三種、漏掉六種。**

📌 **看抓到的那三種，形狀很清楚**：

```
✅ validate 檢查的是「【存在性】與【JDBC 型別】」
     → 表在不在、欄位在不在、型別大類對不對

🔴 validate 【不】檢查：
     → 長度、精度、scale
     → nullable
     → 唯一約束、索引、外鍵、CHECK
     → DB 多出來的欄位（它是單向的：只看「實體要的，DB 有沒有」）
```

⚠️⚠️ **③ 那一條特別危險**：實體宣告 `DECIMAL(10,2)`、資料庫是 `DECIMAL(19,4)`，
**`validate` 通過，然後 1.10.1 那個靜默四捨五入每天都在發生。**

> 📌 **這跟 07 站 06 章的結論一致**（那裡測的是「9 種漂移只抓到 2 種」）。
> **兩章測的漂移不完全一樣，但結論相同：**
>
> **`validate` 是一個【很淺】的檢查。它值得開，但不要以為開了就安全。**

### 1.12.4 那另外六種誰來守

| 漏掉的 | 誰來守 |
|---|---|
| 長度、精度、scale | 🟡 **1.10.1 的「印出 Hibernate 想要的 DDL」+ 人工比對**；或 07 站 06 章的黃金 schema 比對 |
| nullable | 🟡 同上；另外 Bean Validation（1.11）在應用層守一次 |
| 唯一約束、外鍵、`CHECK` | ✅ **它們在資料庫裡，本來就會生效**——只是實體不知道而已 |
| DB 多出來的欄位 | ✅ 通常無害（生成欄位 `email_active` 就是刻意不映射的，1.8.2） |

📌 **最實用的一招：把「Hibernate 想要的 DDL」也納入 CI**。

```yaml
# 產生一份 DDL，跟 Flyway 產生的 schema 做 diff
spring:
  jpa:
    properties:
      jakarta.persistence.schema-generation.scripts.action: create
      jakarta.persistence.schema-generation.scripts.create-target: target/hibernate-wants.sql
```

⚠️ **不要直接拿它去建表**（那就變成 `ddl-auto: update` 的變形）——
**拿它去【比對】**，然後人工判斷每一處差異是「刻意的」還是「漂移」。

**本課那十一處差異，全部都是刻意的**（`CHAR(3)`、`DATETIME(3)`、`DECIMAL(19,4)`、
`VARCHAR(16)`……都是 07 站的決定），
**而 1.16 那組實體把它們一一標註出來，讓下一個人知道那不是忘了寫。**

---

## 1.13 07 站那 11 條不變量，在 JPA 的世界守在哪 ★

07 站 1.10.5 給了一張表：**11 條不變量，資料庫能守 6 條，應用層要守 5 條。**
現在應用層有了 JPA，**那 5 條有了新的去處。**

| # | 不變量 | 07 站的結論 | **JPA 世界裡守在哪** |
|---|---|---|---|
| 1 | 訂單編號唯一 | ✅ `UNIQUE KEY` | 資料庫（不變） |
| 2 | 訂單一定屬於一個客戶 | ✅ 外鍵 | 資料庫 + `@ManyToOne(optional = false)`（02 章） |
| 3 | 訂單金額 = 明細總和 | 🔴 應用層 | ✅ **`Order.addItem()`**——加明細時同步累加（1.16） |
| 4 | 庫存不為負 | ✅ 原子 `UPDATE` | 資料庫（**不能**用 JPA 的髒檢查做，06 章） |
| 5 | 已付款的訂單不可修改金額 | 🟡 應用層 | ✅ **`Order` 的狀態機**——`addItem()` 檢查 `status == PENDING` |
| 6 | 折扣不超過總額 | ✅ `CHECK` | 資料庫 + **`Order.applyDiscount()`** |
| 7 | 一個使用者一個 email | ✅ 生成欄位 + 唯一索引 | 資料庫（1.8.3 已驗證在 JPA 上正常） |
| 8 | 出貨日 >= 下單日 | ✅ `CHECK` | 資料庫 |
| 9 | 冪等鍵不重複 | ✅ 唯一索引 | 資料庫 |
| 10 | outbox 訊息不重送 | ✅ 唯一索引 + 狀態 | 資料庫 + 04 章的 `SKIP LOCKED` |
| 11 | 訂單狀態只能單向轉移 | 🔴 應用層 | ✅ **`Order.pay()` / `cancel()` 的狀態機**（1.16） |

⚠️ **注意 3、5、11 這三條的變化**：07 站說「資料庫守不住，要靠應用層」，
**而現在它們有了一個很具體的位置：實體自己的方法裡。**

```java
public void pay() {
    requireStatus(OrderStatus.PENDING, "只有 PENDING 的訂單可以付款");   // #11
    this.status = OrderStatus.PAID;
    this.paidAt = Instant.now();
}

public OrderItem addItem(UUID itemId, Product product, int qty) {
    requireStatus(OrderStatus.PENDING, "只有 PENDING 的訂單可以加明細");  // #5
    OrderItem item = new OrderItem(itemId, this, product, qty);
    items.add(item);
    totalAmount = totalAmount.add(item.getLineAmount());                  // #3
    return item;
}
```

> 📌 **這就是 06 站 00 章 0.4.3「Repository vs DAO」那張表裡「部分更新」那一列的意義**：
>
> **`orderDao.updateStatus(id, "PAID")` 繞過了狀態機；
> `order.pay()` 沒有辦法繞過。**
>
> 而讓「繞不過」成立的前提是 1.3.2 那個決定：
> **實體【沒有 setter】。** 有了 `setStatus(String)`，上面這三條全部失守。

⚠️ **但要誠實**：實體的狀態機守的是**「單一交易內、透過這個物件」**的路徑。
它守不住：

```
🔴 別人用 MyBatis 直接 UPDATE（00 章 0.3.5 那個事故）
🔴 併發：兩個交易各自讀到 PENDING、各自 pay() —— 那是樂觀鎖的事（06 章）
🔴 DBA 手動下 SQL
```

**所以資料庫那 6 條約束仍然是必要的**——它們是**最後一道防線**，
而實體的狀態機是**第一道、也是錯誤訊息最好的一道**。

---

## 1.14 `equals` 與 `hashCode` ★★

**這一節處理一個看起來跟映射無關、但每個 JPA 專案都會踩的問題。**

00 章 0.6.2 說過：JPA 用 id 定義「身分」——同一個持久化情境裡，
同一個 id 只會有一個實例。**那跨情境呢？**

### 1.14.1 三個候選做法

```java
// ① 完全不覆寫（用 Object 的同一性）
@Entity public class EqDefault { @Id @GeneratedValue private Long id; }

// 🔴 ② 用 id 做 equals/hashCode，而 id 是資料庫產生的
@Entity public class EqId {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY) private Long id;
    @Override public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof EqId other)) return false;
        return Objects.equals(id, other.id);          // 🔴 id 一開始是 null
    }
    @Override public int hashCode() { return Objects.hash(id); }   // 🔴 會變
}

// ✅ ③ 應用端指定 id + 常數 hashCode
@Entity public class EqUuid {
    @Id private UUID id;
    @Override public boolean equals(Object o) { /* 見 1.14.4 */ }
    @Override public int hashCode() { return getClass().hashCode(); }
}
```

### 1.14.2 實測：物件從自己的 `HashSet` 裡消失

```java
EqId a = new EqId("a");
Set<EqId> set = new HashSet<>();
set.add(a);
System.out.println("存之前 set.contains(a) = " + set.contains(a));
ids.saveAndFlush(a);
System.out.println("存之後 set.contains(a) = " + set.contains(a));
```

```
② id-based：存之前 id=null  set.contains(a) = true
② id-based：存之後 id=1     set.contains(a) = false   ← 🔴 同一個物件，從自己的 HashSet 裡消失了

③ UUID + 常數 hashCode：存之前 set.contains(b) = true
③ UUID + 常數 hashCode：存之後 set.contains(b) = true   ✅
```

⚠️ **為什麼**：`HashSet` 在放進去的當下用 `hashCode()` 算出一個桶。
`id` 從 `null` 變成 `1`，`hashCode()` 就變了，**於是它去錯的桶裡找**。

📌 **這不是一個假想的問題**——`@OneToMany` 的集合如果宣告成 `Set`（02 章會討論），
**你加進去的明細會在 flush 之後找不到。**

### 1.14.3 實測：`equals` 不對稱 ★★

```
═══ 🔴 equals 裡直接讀 ((X) o).id ═══
  real.equals(proxy) = false
  proxy.equals(real) = true
  🔴 兩個方向答案不一樣 —— 違反 equals 的對稱性契約
```

**同樣兩個物件，`a.equals(b)` 與 `b.equals(a)` 給出不同答案。**

**為什麼**——直接反射看一眼就懂了：

```
═══ 為什麼：代理【自己的欄位】是空的 ═══
  直接反射讀代理的 id 欄位 = null                                    ← 🔴
  透過 getter 讀           = 01a07a07-3ab0-75f1-8e0c-4c473650bf4b    ✅
```

📌 **Hibernate 的延遲載入代理是一個子類別，它【自己的欄位永遠是 null】**——
真正的值在它內部包著的那個實例裡，**只有 getter 會被攔截、轉發過去**。

```java
// 🔴 直接讀欄位 → 讀到代理自己的 null
return Objects.equals(id, ((EqUuid) o).id);

// ✅ 走 getter → 攔截器會去取真身
return getId() != null && getId().equals(((EqUuidFixed) o).getId());
```

**修好之後**：

```
═══ ✅ equals 裡走 getId() ═══
  real.equals(proxy) = true
  proxy.equals(real) = true
```

⚠️ **還有一個相關的坑：`getClass()` 比較。**

```
  real.getClass()  = EqUuid
  proxy.getClass() = EqUuid$HibernateProxy$ClvHWX5p
  兩者是同一個類別嗎？ false   ← 🔴 所以 getClass() != o.getClass() 的 equals 會直接回 false
  Hibernate.getClass(proxy) = EqUuid                                  ← ✅ 用這個
```

**IDE 自動產生的 `equals` 幾乎都是 `if (o == null || getClass() != o.getClass()) return false;`——
那一行在 JPA 實體上是錯的。**

### 1.14.4 本課的寫法

```java
@Override
public final boolean equals(Object o) {
    if (this == o) return true;
    if (o == null || Hibernate.getClass(this) != Hibernate.getClass(o)) return false;
    // ★ 一定要走 getId()：代理【自己的欄位是 null】（1.14.3 實測）
    UUID mine = getId();
    return mine != null && mine.equals(((BaseEntity) o).getId());
}

/** ★ 常數：id 不會變，但常數保證物件不會從 HashSet 裡「消失」（1.14.2 實測）。 */
@Override
public final int hashCode() { return Hibernate.getClass(this).hashCode(); }
```

**四個決定，每一個都對應一個實測**：

| 決定 | 為什麼 |
|---|---|
| `Hibernate.getClass()` 而不是 `getClass()` | 1.14.3：代理是子類別 |
| `getId()` 而不是 `o.id` | 1.14.3：代理的欄位是 null |
| `hashCode()` 回傳**常數** | 1.14.2：id 變了不會讓物件走失 |
| 兩個都 `final` | 子類別不可以再覆寫掉這個契約 |

⚠️ **常數 `hashCode` 的代價**：一個 `HashSet` 裡放 1000 個實體，
**全部落在同一個桶**，`contains()` 退化成 O(n)。

> 📌 **這個代價在實務上通常可以接受**，因為：
> **一個聚合裡的集合很少超過幾十個元素**（一張訂單幾十筆明細）。
> 如果你真的要在 `HashSet` 裡放上萬個實體，那個設計本身要先檢討（06 站 00 章 0.11.7）。
>
> ✅ **而 07 站選的「應用端指定 UUIDv7」讓另一個選項也成立**：
> **因為 id 從物件建立的那一刻就有、而且永遠不變，
> 你其實可以安全地用 `Objects.hash(id)`。**
> 本課仍然用常數，是為了讓 `BaseEntity` 對「未來有人改用 `IDENTITY`」也是安全的。

---

## 1.15 審計欄位

07 站 1.12 的每張表都有 `created_at` / `updated_at`。**有兩種填法。**

### 1.15.1 做法一：應用填（Spring Data JPA Auditing）

```java
package com.example.lab.ch01;

import jakarta.persistence.*;
// ⚠️ 不可以寫 import org.springframework.data.annotation.*;
//    它裡面也有一個 Id，會跟 jakarta.persistence.Id 撞成 "reference to Id is ambiguous"
import org.springframework.data.annotation.CreatedBy;
import org.springframework.data.annotation.CreatedDate;
import org.springframework.data.annotation.LastModifiedBy;
import org.springframework.data.annotation.LastModifiedDate;
import org.springframework.data.jpa.domain.support.AuditingEntityListener;

import java.time.Instant;
import java.util.UUID;

@Entity @Table(name = "aud_doc")
@EntityListeners(AuditingEntityListener.class)
public class AudDoc {
    @Id private UUID id;
    private String title;

    @CreatedDate      @Column(name = "created_at", updatable = false) private Instant createdAt;
    @LastModifiedDate @Column(name = "updated_at")                    private Instant updatedAt;
    @CreatedBy        @Column(name = "created_by", updatable = false) private String  createdBy;
    @LastModifiedBy   @Column(name = "updated_by")                    private String  updatedBy;

    protected AudDoc() {}
    public AudDoc(UUID id, String title) { this.id = id; this.title = title; }
    public void rename(String t) { this.title = t; }
}
```

```java
package com.example.lab.ch01;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.domain.AuditorAware;
import org.springframework.data.jpa.repository.config.EnableJpaAuditing;

import java.util.Optional;

@Configuration
@EnableJpaAuditing                       // ★ 沒有這一行，@CreatedDate 完全不會生效
public class AuditConfig {
    /** 實務上從 SecurityContext 拿（09 站）。 */
    @Bean
    public AuditorAware<String> auditorAware() {
        return () -> Optional.of("gary");
    }
}
```

⚠️ **`@EnableJpaAuditing` 少了會怎樣**：**什麼都不會發生，也不會報錯。**
`created_at` 是 `NOT NULL` 的話，你會得到一個很難懂的 `NOT NULL` 違反。

### 1.15.2 做法二：資料庫填（07 站 1.12 的 `DEFAULT CURRENT_TIMESTAMP`）

```java
@Entity @Table(name = "db_doc")
public class DbDoc {
    @Id private UUID id;
    private String title;

    // ★ insertable/updatable = false：交給資料庫；JPA 只讀（1.8.1）
    @Column(name = "created_at", insertable = false, updatable = false) private Instant createdAt;
    @Column(name = "updated_at", insertable = false, updatable = false) private Instant updatedAt;
}
```

### 1.15.3 實測：兩者的差別

```
═══ ① 應用填（Spring Data JPA Auditing）═══
── save → 2 句 SQL
   insert into aud_doc (created_at,created_by,title,updated_at,updated_by,id) values (?,?,?,?,?,?)
  DB: [{title=第一版, created_at=...22.566, updated_at=...22.566, created_by=gary, updated_by=gary}]

── rename → 2 句 SQL
   update aud_doc set title=?,updated_at=?,updated_by=? where id=?
  DB: [{title=第二版, created_at=...22.566, updated_at=...22.644, created_by=gary, updated_by=gary}]

═══ ② 資料庫填（DEFAULT CURRENT_TIMESTAMP）═══
  save 之後，記憶體裡的 createdAt = null
── save → 2 句 SQL
   insert into db_doc (title,id) values (?,?)          ← ★ 沒有時間欄位
  DB: [{title=第一版, created_at=...22.655, updated_at=...22.655}]
  ⚠️ 交易結束後那個實體的 createdAt 還是 null   ← 🔴 要重新查才拿得到
```

**關鍵差別在這裡**：

```
═══ ⚠️ 繞過 JPA、直接下 SQL ═══
  UPDATE db_doc SET title = '第三版（直接下 SQL）' WHERE id = ?
  DB: [{title=第三版（直接下 SQL）, created_at=...22.655, updated_at=...22.721}]   ✅ 更新了

  UPDATE aud_doc SET title = '第三版（直接下 SQL）' WHERE id = ?
  aud_doc: [{title=第三版（直接下 SQL）, updated_at=...22.644, updated_by=gary}]   ← 🔴 updated_at 沒動
```

| | ① 應用填 | ② 資料庫填 |
|---|---|---|
| 記得「誰改的」 | ✅ `created_by` / `updated_by` | 🔴 **資料庫不知道使用者是誰** |
| 繞過 JPA 的寫入 | 🔴 **不會更新**（`updated_at` 停在舊值） | ✅ **一定正確** |
| `save()` 之後記憶體裡有值嗎 | ✅ 有 | 🔴 **`null`，要重查**（或加 `@Generated`，1.8.2） |
| 時鐘來源 | 應用伺服器（**多台機器可能不同步**） | 資料庫（**單一時鐘**） |
| 跟 00 章 0.3.5 的混用事故 | 🔴 同一類問題 | ✅ 免疫 |

> 📌 **本課的選擇：時間用②（資料庫填），人用①（應用填）。**
>
> ```java
> // 時間：資料庫的 DEFAULT CURRENT_TIMESTAMP —— 任何路徑寫入都正確、單一時鐘
> @Column(name = "created_at", insertable = false, updatable = false) private Instant createdAt;
> @Column(name = "updated_at", insertable = false, updatable = false) private Instant updatedAt;
>
> // 人：只有應用知道 —— 而且它本來就只在應用寫入時才有意義
> @CreatedBy  @Column(name = "created_by", updatable = false) private String createdBy;
> ```
>
> ⚠️ **理由是那張表的第二列與第四列**：
> **「多台應用伺服器的時鐘不同步」是真的會發生的**，
> 而 `updated_at` 常常被拿來做增量同步的游標——**時鐘倒退會漏資料。**

---
## 1.16 shop-service 的完整實體

把這一章的每一個決定合起來。**這組實體 `ddl-auto: validate` 通得過**，
而且每一個「看起來多餘」的註解都對應本章的一個實測。

### 1.16.1 `BaseEntity`：一次解決三件事

```java
package com.example.lab.shop;

import jakarta.persistence.Id;
import jakarta.persistence.MappedSuperclass;
import jakarta.persistence.PostLoad;
import jakarta.persistence.PostPersist;
import jakarta.persistence.Transient;
import org.hibernate.Hibernate;
import org.springframework.data.domain.Persistable;

import java.util.UUID;

/**
 * 所有實體的共同基礎。它解決三件事：
 *   ① 應用端指定 UUIDv7 主鍵（07 站 1.8.4）
 *   ② Persistable：省掉 save() 那一句多餘的 SELECT（00 章 0.3.3、本章 1.6.6）
 *   ③ 對代理安全、對 HashSet 安全的 equals / hashCode（1.14）
 */
@MappedSuperclass
public abstract class BaseEntity implements Persistable<UUID> {

    @Id
    private UUID id;

    @Transient
    private boolean isNew = true;

    protected BaseEntity() {}
    protected BaseEntity(UUID id) { this.id = id; }

    @Override public UUID getId() { return id; }
    @Override public boolean isNew() { return isNew; }

    @PostPersist @PostLoad
    void markNotNew() { this.isNew = false; }

    @Override
    public final boolean equals(Object o) {
        if (this == o) return true;
        if (o == null || Hibernate.getClass(this) != Hibernate.getClass(o)) return false;
        // ★ 一定要走 getId()：代理【自己的欄位是 null】（1.14.3 實測）
        UUID mine = getId();
        return mine != null && mine.equals(((BaseEntity) o).getId());
    }

    /** ★ 常數：id 不會變，但常數保證物件不會從 HashSet 裡「消失」（1.14.2 實測）。 */
    @Override
    public final int hashCode() { return Hibernate.getClass(this).hashCode(); }
}
```

### 1.16.2 `OrderStatus`

```java
package com.example.lab.shop;

/** 對應 orders.status VARCHAR(16)（07 站 1.12 的 ck_orders_status）。 */
public enum OrderStatus {
    PENDING, PAID, PACKED, SHIPPED, DELIVERED, CANCELLED, REFUNDED
}
```

### 1.16.3 `Customer`

```java
package com.example.lab.shop;

import jakarta.persistence.*;
import java.time.Instant;
import java.util.UUID;

@Entity @Table(name = "customer")
public class Customer extends BaseEntity {

    @Column(nullable = false, length = 255)
    private String email;

    @Column(name = "display_name", nullable = false, length = 64)
    private String displayName;

    /** 資料庫填的（DEFAULT CURRENT_TIMESTAMP(3)）；JPA 只讀（1.11.1）。 */
    @Column(name = "created_at", insertable = false, updatable = false)
    private Instant createdAt;

    @Version
    private long version;

    protected Customer() {}
    public Customer(UUID id, String email, String displayName) {
        super(id);
        this.email = email;
        this.displayName = displayName;
    }

    public String getEmail() { return email; }
    public String getDisplayName() { return displayName; }
    public void rename(String n) { this.displayName = n; }
    public Instant getCreatedAt() { return createdAt; }
    public long getVersion() { return version; }
}
```

### 1.16.4 `Product`

```java
package com.example.lab.shop;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.util.UUID;

@Entity @Table(name = "product")
public class Product extends BaseEntity {

    @Column(nullable = false, length = 32)
    private String sku;

    @Column(nullable = false, length = 200)
    private String name;

    /** ★ precision / scale 要跟 DECIMAL(19,4) 一致，否則靜默四捨五入（1.10.1）。 */
    @Column(name = "unit_price", nullable = false, precision = 19, scale = 4)
    private BigDecimal unitPrice;

    @Column(name = "is_active", nullable = false)
    private boolean active = true;

    @Version
    private long version;

    protected Product() {}
    public Product(UUID id, String sku, String name, BigDecimal unitPrice) {
        super(id);
        this.sku = sku;
        this.name = name;
        this.unitPrice = unitPrice;
    }

    public String getSku() { return sku; }
    public String getName() { return name; }
    public BigDecimal getUnitPrice() { return unitPrice; }
    public boolean isActive() { return active; }
}
```

### 1.16.5 `Order`：不變量守在方法裡

📌 `removeItem` 的設計理由（為什麼不需要 `item.setOrder(null)`）在 **02 章 2.12.2**。

```java
package com.example.lab.shop;

import jakarta.persistence.*;
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

    @OneToMany(mappedBy = "order", cascade = CascadeType.ALL, orphanRemoval = true)
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

### 1.16.6 `OrderItem`

```java
package com.example.lab.shop;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.util.UUID;

@Entity @Table(name = "order_item")
public class OrderItem extends BaseEntity {

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "order_id", nullable = false)
    private Order order;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "product_id", nullable = false)
    private Product product;

    /** ★ 快照：下單當下的商品名與單價，不能 JOIN 商品表拿現在的值（07 站 1.12）。 */
    @Column(name = "product_name", nullable = false, length = 200)
    private String productName;

    @Column(name = "unit_price", nullable = false, precision = 19, scale = 4)
    private BigDecimal unitPrice;

    @Column(nullable = false)
    private int qty;

    @Column(name = "line_amount", nullable = false, precision = 19, scale = 4)
    private BigDecimal lineAmount;

    protected OrderItem() {}

    OrderItem(UUID id, Order order, Product product, int qty) {
        super(id);
        if (qty <= 0) throw new IllegalArgumentException("數量必須大於 0，收到 " + qty);
        this.order = order;
        this.product = product;
        this.productName = product.getName();
        this.unitPrice = product.getUnitPrice();
        this.qty = qty;
        this.lineAmount = product.getUnitPrice().multiply(BigDecimal.valueOf(qty));
    }

    public Order getOrder() { return order; }
    public Product getProduct() { return product; }
    public String getProductName() { return productName; }
    public BigDecimal getUnitPrice() { return unitPrice; }
    public int getQty() { return qty; }
    public BigDecimal getLineAmount() { return lineAmount; }
}
```

### 1.16.7 四個 Repository 介面

```java
package com.example.lab.shop;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.UUID;

public interface CustomerRepository extends JpaRepository<Customer, UUID> {}
```

```java
package com.example.lab.shop;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.UUID;

public interface ProductRepository extends JpaRepository<Product, UUID> {}
```

```java
package com.example.lab.shop;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface OrderRepository extends JpaRepository<Order, UUID> {
    List<Order> findByStatus(OrderStatus status);      // ★ 參數是 enum，不是 String
    Optional<Order> findByOrderNo(String orderNo);
}
```

```java
package com.example.lab.shop;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.UUID;

public interface OrderItemRepository extends JpaRepository<OrderItem, UUID> {}
```

📌 **注意 `findByStatus(OrderStatus status)` 的參數型別是 `enum` 而不是 `String`**——
Spring Data 會用 1.7 那個映射把它轉成 `'PAID'`。
**寫成 `String` 也能跑，但你就失去了編譯期的檢查。**

### 1.16.8 驗收：這組實體真的能跑嗎

```java
@SpringBootTest(properties = {
  "spring.datasource.url=jdbc:mysql://127.0.0.1:33306/shop?connectionTimeZone=UTC"
      + "&forceConnectionTimeZoneToSession=true&preserveInstants=true&characterEncoding=UTF-8",
  "spring.jpa.hibernate.ddl-auto=validate"          // ★ 啟動得起來，就代表 1.12 通過
})
class ShopEntityTest {

    @Configuration
    @EnableAutoConfiguration
    @EntityScan("com.example.lab.shop")
    @EnableJpaRepositories("com.example.lab.shop")
    @Import(SqlSpy.class)                            // 00 章 0.10.3
    static class OnlyShop {}

    @Autowired CustomerRepository customers;
    @Autowired ProductRepository products;
    @Autowired OrderRepository orders;
    @Autowired JdbcTemplate jdbc;
    @Autowired TransactionTemplate tx;

    @Test
    void 驗收() {
        UUID cid = Uuid7.next(), pid = Uuid7.next(), oid = Uuid7.next();

        SqlSpy.start();
        tx.executeWithoutResult(s -> {
            Customer c = customers.save(new Customer(cid, "a@x.com", "小明"));
            Product p = products.save(new Product(pid, "SKU-1", "機械鍵盤", new BigDecimal("2990.0000")));
            Order o = new Order(oid, "SO-2026-00000001", c);
            o.addItem(Uuid7.next(), p, 2);
            orders.save(o);
        });
        SqlSpy.dumpGrouped("建立 1 客戶 + 1 商品 + 1 訂單 + 1 明細", SqlSpy.stop());

        tx.executeWithoutResult(s -> {
            Order o = orders.findById(oid).orElseThrow();
            try { o.applyDiscount(new BigDecimal("99999")); } catch (Exception e) { print(e); }
            try { o.addItem(Uuid7.next(), products.findById(pid).orElseThrow(), 0); } catch (Exception e) { print(e); }
            o.pay();
            try { o.pay(); } catch (Exception e) { print(e); }
            try { o.addItem(Uuid7.next(), products.findById(pid).orElseThrow(), 1); } catch (Exception e) { print(e); }
        });

        Order a = tx.execute(s -> orders.findById(oid).orElseThrow());
        Order b = tx.execute(s -> orders.findById(oid).orElseThrow());
        assertThat(a).isNotSameAs(b).isEqualTo(b);                 // 1.14
        assertThat(new HashSet<>(List.of(a, b))).hasSize(1);       // 1.14
    }
}
```

**實測輸出**：

```
═══ ① ddl-auto=validate 通過（你正在看這行）═══

═══ ② Persistable：建立三筆資料各打幾句 SQL ═══
── 建立 1 客戶 + 1 商品 + 1 訂單 + 1 明細 → 共 4 句，4 種形狀
   ×1  insert into customer (display_name,email,version,id) values (?,?,?,?)
   ×1  insert into product (is_active,name,sku,unit_price,version,id) values (?,?,?,?,?,?)
   ×1  insert into orders (currency,customer_id,discount_amount,order_no,paid_at,
                           placed_at,status,total_amount,version,id) values (?,?,?,?,?,?,?,?,?,?)
   ×1  insert into order_item (line_amount,order_id,product_id,product_name,
                               qty,unit_price,id) values (?,?,?,?,?,?,?)

═══ ③ 存進去的樣子 ═══
  orders: [{order_no=SO-2026-00000001, status=PENDING, total_amount=5980.0000,
            currency=TWD, version=0}]
  item  : [{product_name=機械鍵盤, qty=2, line_amount=5980.0000}]

═══ ④ 狀態機把不變量守在實體裡 ═══
  折扣 > 總額     → 折扣 99999 超過總額 5980.0000
  數量 0          → 數量必須大於 0，收到 0
  重複付款        → 只有 PENDING 的訂單可以付款，目前是 PAID
  付款後加明細    → 只有 PENDING 的訂單可以加明細，目前是 PAID
  最後: [{status=PAID, paid=1, version=1}]

═══ ⑤ enum 存的是名字 ═══
  [{status=PAID}]

═══ ⑥ equals / hashCode ═══
  兩個交易讀同一列: a == b ? false   a.equals(b) ? true
  放進 HashSet: 1 個元素
```

⚠️ **上面那 4 句是「四個物件都是新建的」**——客戶、商品、訂單、明細都在同一個交易裡建立，
所以連商品都不用查。**這不能直接拿去跟 00 章 0.8.1 場景 B 比。**

**要公平比較，得跑【完全相同】的情境**：客戶與商品**已經存在**，只新增 1 張訂單 + 3 筆明細。

```
── 01 章實體 + orders.save() → 共 7 句，3 種形狀
   ×3  select p1_0.id,...,p1_0.version from product p1_0 where p1_0.id=?
   ×1  insert into orders (...) values (...)
   ×3  insert into order_item (...) values (...)

─── 對照：改用 em.persist
── 01 章實體 + em.persist() → 共 7 句，3 種形狀    ← ★ 一模一樣
```

**所以誠實的對照是**：

| 同一個情境（客戶與商品已存在，建 1 張訂單 + 3 筆明細） | SQL 句數 |
|---|---|
| 00 章的實體 + `orders.save()` | **11 句** |
| 00 章的實體 + `em.persist()` | 7 句 |
| **01 章的實體 + `orders.save()`** | **7 句** |
| 01 章的實體 + `em.persist()` | 7 句 |

📌 **兩個結論**：

**① `Persistable` 拿掉的是那 4 句 `merge` 相關的查詢**（1 句 `orders` 的 `LEFT JOIN` 查詢
＋ 3 句 `order_item` 的存在性查詢），**11 → 7**。

**② 加上 `Persistable` 之後，`save()` 與 `em.persist()` 產出【完全一樣】。**
00 章 0.3.3 說「繞過 Spring Data、直接用 `EntityManager`」是解法之一——
**現在你不需要繞過它了。**

⚠️ **剩下那 3 句 `select product` 是拿不掉的**，而且它跟主鍵策略無關：
`OrderItem` 的建構子要讀 `product.getName()` 與 `getUnitPrice()` 來做快照（07 站 1.12），
**而那三個商品是 `getReferenceById` 拿到的代理**——讀非 id 的屬性就一定要初始化（02 章 2.11.5）。

📌 **要拿掉它們，得換一個做法**：讓呼叫端傳入「已經查好的商品」，
或是把快照需要的欄位用一句查詢先撈出來（05 章 5.8 的投影）。

---

## 1.17 常見誤區

**誤區 1：「`@Column(nullable = false)` 可以擋住 null」**

→ 1.11.1：在 `ddl-auto: none` 的專案裡，**它擋不住任何東西**。
它是「請幫我把 DDL 產成 `NOT NULL`」的指示，不是驗證。
擋 null 的是 **Bean Validation（應用層）** 與 **資料庫的 `NOT NULL`**。

**誤區 2：「`@Enumerated` 不用寫，反正有預設值」**

→ 1.7.1：**預設值是 `ORDINAL`，也就是危險的那一個。**
1.7.2 實測：有人在 enum 中間插一個常數，**`CANCELLED` 變成 `DELIVERED`**。

**誤區 3：「時間就用 `LocalDateTime`，反正大家都這樣寫」**

→ 1.9.2 實測：**同一列資料，JVM 時區從 `Asia/Taipei` 換成 `UTC`，讀出來差 8 小時。**
`_at` 結尾的欄位一律用 `Instant`。

**誤區 4：「`BigDecimal` 不用寫 `precision` / `scale`」**

→ 1.10.1：不寫的話 Hibernate 認定 `DECIMAL(38,2)`——**只有兩位小數**。
而且 `validate` 抓不到（1.12.3 ③）。

**誤區 5：「`ddl-auto: validate` 過了就代表實體跟 schema 一致」**

→ 1.12.3 實測：**九種漂移抓到三種、漏掉六種。**
長度、精度、nullable、唯一約束、索引——**它一個都不檢查。**

**誤區 6：「`ddl-auto: update` 先用著，之後再換 Flyway」**

→ 1.5：它**不刪欄位、不改型別、不可重現、沒有回滾**，
而且 MySQL 沒有 DDL 交易（07 站 06 章）。
「之後再換」的意思是「等到有生產資料的時候再換」——**那正是最糟的時機。**

**誤區 7：「`IDENTITY` 最簡單，用它就對了」**

→ 1.6.4 實測：**它讓批次插入完全失效**（200 筆 = 200 句、0 批次）。
而且**沒有任何警告**——你設了 `batch_size=50`，它一句都沒有批次。

**誤區 8：「`save()` 就是存進去，多打一句 `SELECT` 而已，沒差」**

→ 1.6.6 實測：200 筆的差別是 **204 句 / 182 ms vs 4 句 / 19 ms**。
而且那 200 句是**純粹浪費的**——它們查的是「這筆存不存在」，而你明明知道它不存在。

**誤區 9：「IDE 幫我產生的 `equals` / `hashCode` 應該沒問題」**

→ 1.14.3：IDE 產的是 `getClass() != o.getClass()` + 直接讀欄位，
**兩個在 JPA 實體上都是錯的**——代理是子類別，而且**代理自己的欄位是 `null`**。
實測結果是 `a.equals(b)` 與 `b.equals(a)` **給出不同答案**。

**誤區 10：「用 `id` 做 `hashCode` 很自然」**

→ 1.14.2 實測：id 從 `null` 變成 `1` 之後，
**物件從它自己的 `HashSet` 裡消失了。**

**誤區 11：「`@CreatedDate` 貼上去就會生效」**

→ 1.15.1：**少了 `@EnableJpaAuditing`，什麼都不會發生，而且不會報錯。**
你會拿到一個很難懂的 `NOT NULL` 違反。

**誤區 12：「審計欄位用應用填比較好，可以記錄是誰改的」**

→ 1.15.3 實測：**應用填的 `updated_at`，在別人繞過 JPA 下 SQL 時不會更新。**
而 `updated_at` 常常被拿來做增量同步的游標——**漏更新等於漏資料。**
本課的選擇是**時間交給資料庫、人交給應用**。

**誤區 13：「生成欄位映射進來就好，反正只是多一欄」**

→ 1.8.2：加了 `@Generated` 之後，**每一次 `INSERT` / `UPDATE` 都多一句 `SELECT`**。
應用程式不需要讀的欄位（例如純粹給唯一索引用的 `email_active`），
**根本不要映射它。**

---

## 1.18 本章小結

**這一章做的事，用一句話講**：

> **把 07 站那份 schema 映射成實體——而每一個「對齊」的動作，都是一個要做的決定。**

**十一個決定，以及做錯的後果**：

| 決定 | 選什麼 | 選錯會怎樣 |
|---|---|---|
| 存取方式 | 欄位存取 | getter 裡的邏輯被寫進資料庫（1.3.2） |
| 主鍵策略 | 指定 UUIDv7 + `Persistable` | 批次失效（`IDENTITY`）或每次多一句 `SELECT`（1.6） |
| 列舉 | `STRING` + `@JdbcTypeCode(VARCHAR)` | **舊資料整批錯位**（1.7.2） |
| 時間 | `Instant` | **換機器差 8 小時**（1.9.2） |
| 金額 | `BigDecimal` + 明確的 `precision`/`scale` | **靜默四捨五入**（1.10.1） |
| 值物件 | `@Embeddable record` | 不變量散落在各處 |
| 生成欄位 | `insertable=false`，不加 `@Generated` | 寫入被 MySQL 拒絕；或每次多一句 `SELECT`（1.8） |
| 三層檢查 | 三層都要 | 少了資料庫那層，混用時沒有最後防線（1.11） |
| `ddl-auto` | `none` + CI 跑 `validate` | schema 漂移沒人發現（1.12） |
| `equals`/`hashCode` | `Hibernate.getClass()` + `getId()` + 常數 | **equals 不對稱、物件從 `HashSet` 消失**（1.14） |
| 審計欄位 | 時間給資料庫、人給應用 | 繞過 JPA 的寫入不更新 `updated_at`（1.15） |

**如果只能帶走三句話**：

> **① 映射的錯誤，幾乎都是「今天正確、以後才錯」。**
> `ORDINAL` 今天對、加一個 enum 常數之後錯；
> `LocalDateTime` 今天對、部署到容器之後錯；
> 沒寫 `scale` 今天對、遇到五位小數才錯。
> **所以判準不是「現在跑得對嗎」，是「什麼情況下它會開始錯」。**
>
> **② `validate` 值得開，但它很淺。**
> 九種漂移抓三種。**它守的是「存在性與型別」，不是「一致性」。**
> 長度、精度、nullable、約束——**全部要靠別的機制。**
>
> **③ 不變量要往【最早】的地方放。**
> 值物件的建構子（`new Money(-1)` 組不出來）＞
> 實體的方法（`order.pay()` 檢查狀態）＞
> Bean Validation（flush 前）＞ 資料庫約束（最後一道）。
> **越早擋住，錯誤訊息越好、影響範圍越小——但最後那一道永遠不能省。**

---

### 1.18.1 驗收清單

**概念**：

```
□ 說得出一個 JPA 實體的五個硬性要求，以及每一條的理由
□ 說得出欄位存取與屬性存取的差別，以及為什麼本課選欄位存取
□ 說得出五種主鍵策略，以及為什麼 IDENTITY 不能批次
□ 說得出 Persistable 解決什麼、以及它的兩個坑怎麼觸發
□ 說得出 @Enumerated 的預設值是什麼，以及它為什麼危險
□ 說得出 Instant / LocalDateTime / OffsetDateTime 各自適合什麼
□ 說得出 @Column(nullable=false) 在 ddl-auto: none 下做了什麼（答案：幾乎什麼都沒做）
□ 說得出 validate 檢查什麼、不檢查什麼
□ 說得出 JPA 實體的 equals 為什麼不能用 IDE 產生的版本
□ 說得出 07 站那 11 條不變量，現在分別守在哪一層
```

**動手**：

```
□ 把 00 章那組實體加上 ddl-auto: validate，重現那兩個型別錯誤，並修好它們
□ 重現 1.7.2：存三筆 ORDINAL 資料，然後在 enum 中間插一個常數，再讀一次
□ 重現 1.9.2：用 -Duser.timezone=UTC 讀同一列，看 LocalDateTime 差 8 小時
□ 重現 1.10.1：存 100.12345 進 DECIMAL(19,4)，確認它變成 100.1235 而且沒有例外
□ 重現 1.6.4：把 batch_size 開起來，用 IDENTITY 存 200 筆，數 SQL 句數
□ 重現 1.14.2：用 id-based hashCode 的實體，存進去之後從 HashSet 裡找它
□ 把 1.16 那組實體建起來，讓 validate 通過，並確認建立四個物件只打 4 句 SQL
□ 【重點】把 1.12.3 那九種漂移逐一注入，自己數一次 validate 抓到幾種
```

⚠️ **最後一項是這一章的重點練習**，理由跟 00 章一樣：
**一個你沒有親手試過邊界的工具，你不會知道它守不住什麼。**

### 1.18.2 本章練習

**練習一（暖身）：把 `@DynamicUpdate` 加上去**

00 章 0.3.1 那個「`UPDATE` 寫了九個欄位」的問題，
在 `Order` 上加 `@org.hibernate.annotations.DynamicUpdate` 再跑一次 `o.pay()`。

**你應該會看到欄位數從 9 降到 3。**
**然後回答**：既然明顯更好，為什麼 Hibernate 不設成預設值？（06 章 6.4）

**練習二：把 `AttributeConverter` 寫完並驗證它的價值**

1.7.3 的 `OrderStatusConverter` 只寫了骨架。把它完成，然後：

```
① 存一筆 PAID 進去，確認資料庫裡是 'A'
② 手動 UPDATE 成一個不存在的代碼 'Z'，再讀出來
③ 比較它跟 @Enumerated(STRING) 遇到未知值時的錯誤訊息
```

**判準**：哪一個的錯誤訊息，讓半夜被叫起來的人比較快找到問題？

**練習三：找出你自己專案裡的 `ORDINAL`**

```bash
# 一個很粗暴但很有效的檢查
grep -rn "@Enumerated" --include="*.java" . | grep -v STRING
grep -rn -B2 "private .*Status\|private .*Type\|private .*Kind" --include="*.java" . \
  | grep -A2 "@Enumerated(EnumType.ORDINAL)"
```

⚠️ **還要找「完全沒寫 `@Enumerated` 的 enum 欄位」**——那些也是 `ORDINAL`。

**找到的話，先不要急著改。** 改成 `STRING` 會讓**既有資料全部讀不出來**，
你需要一個遷移腳本（07 站 06 章）。**練習的一部分就是寫出那個腳本。**

**練習四（進階）：把 1.9.4 那條 ArchUnit 規則加進專案**

```java
@Test
void 時刻欄位一律用Instant() {
    fields().that().areDeclaredInClassesThat().resideInAPackage("..shop..")
            // ⚠️ 05 章 5.9.3 會加 hibernate-jpamodelgen（Criteria 的 metamodel），
            //   它會產生 Order_ / Customer_ 這種類別，而它們的欄位是 SingularAttribute。
            //   沒有這一行，這條規則會在加了那個產生器之後開始失敗。
            .and().areDeclaredInClassesThat().haveSimpleNameNotEndingWith("_")
            .and().haveNameMatching(".*(At|Time)$")
            .should().haveRawType(java.time.Instant.class)
            .because("_at 欄位代表【絕對時刻】；LocalDateTime 會跟著 JVM 時區跑（1.9.2）")
            .check(classes);
}
```

**然後刻意把一個欄位改成 `LocalDateTime`，確認它會紅。**

**再寫兩條**：

```
① 所有 @Enumerated 都必須是 STRING
② 所有 BigDecimal 欄位都必須有 @Column(precision = ..., scale = ...)
```

**練習五（思考題）：`Persistable` 該不該用**

1.6.7 說 `Persistable` 有兩個坑，而且它們的根源是
「把可推導的事實變成要維護的狀態」。

**要回答的問題**：
- 如果你的團隊有一半的更新是走「從 DTO `new` 一個實體再 `save`」，你會怎麼選？
- 1.6.8 的自訂 `IdentifierGenerator` 沒有這個坑——那為什麼本課不用它？
- 有沒有第三條路，可以同時拿到「1 句 SQL」與「不需要維護 `isNew` 狀態」？
  （提示：`save()` 不是唯一的寫入方式。`EntityManager` 有兩個不同的方法。）

---

## 1.19 下一章預告

**02 章：關聯映射。**

這一章刻意迴避了一件事：**`Order` 與 `OrderItem` 之間那個 `@OneToMany`。**

```java
@OneToMany(mappedBy = "order", cascade = CascadeType.ALL, orphanRemoval = true)
private List<OrderItem> items = new ArrayList<>();
```

**這一行有四個決定，而 1.16 只是把它抄下來、沒有解釋任何一個**：

| 這一行裡的 | 02 章要處理的問題 |
|---|---|
| `mappedBy = "order"` | **誰是擁有方**？只動集合的話，`items.add()` 不會產生任何 `UPDATE`（2.3.3 實測：淨效果是零） |
| `cascade = ALL` | 它包含 `REMOVE`——**刪一張訂單會連帶刪掉什麼**？ |
| `orphanRemoval = true` | 它跟 `cascade = REMOVE` 差在哪？（**兩者都設會怎樣**） |
| `List` 而不是 `Set` | 1.14.2 那個 `HashSet` 問題在這裡會不會發生？ |

**還有四個這一章沒提的關聯問題**：

```
① 雙向關聯：Order 有 items、OrderItem 有 order —— 誰負責維持兩邊同步？
   （忘了同步的後果：記憶體裡是對的，資料庫裡是錯的）
② 把雙向關聯直接回傳給前端 → Jackson 無限遞迴 → StackOverflowError
③ @ManyToOne 的預設 fetch 是 EAGER —— 而 @OneToMany 的預設是 LAZY
   （一撈訂單順便把全世界關聯拉出來，就是這個預設值造成的）
④ 06 站 03 章 3.7 那個「明細全刪重插 vs 逐筆 diff」—— orphanRemoval 會選哪一個
```

📌 **02 章結束時，你會知道為什麼 1.16 那一行要那樣寫**，
而 00 章 0.3.2 那個 N+1（`o.getItems()` 打 20 句 SQL）**還會在**——
**它要等 04 章。**
