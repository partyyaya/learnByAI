# 第 02 章：資料庫設計與 Flyway 遷移

> 第 01 章結束時，模組的形狀定了：九個模組、每張表有主人、四道防線守著邊界。
> 但資料庫裡只有一份 `ch01-schema.sql` —— 三張表、沒有外鍵、沒有索引規劃，由測試用 `@Sql` 手動建出來。
>
> **這一章要把 0.3.4 那 19 張表真的建出來，而且讓它們「只能用一種方式被改變」。**
>
> 這一章結束時，你手上會有：
>
> - 一張 **19 張表的 ERD**，以及每一個欄位型別背後的理由（2.3、2.4）。
> - **24 個 CHECK 約束、31 個具名索引**，每一個都對回 0.4 的某一條需求或不變量；
>   以及一個**直接寫入 22 種非法資料、預期全部被資料庫擋下**的守門員測試（2.5）。
> - 一條實測過的規則：**同模組的表之間要外鍵，跨模組不要**（2.6）。
> - 一套從 API 與 SLO **反推**出來、用 `EXPLAIN ANALYZE` 驗證過的索引（2.7）。
> - 一份 **10 萬張訂單、190 萬列、34 秒產生、而且滿足每一條不變量**的種子資料（2.8）。
> - **10 個 Flyway migration**，以及三個讓它們「破不了」的守門員：檔名與模組歸屬、Entity 的 `@Table` 歸屬、Entity 與 schema 的漂移（2.9）。
> - **驗收 Q6 變綠**：空資料庫啟動 → Flyway 由 V1 跑到 V10 → `ddl-auto=validate` 通過 → 每一個 CHECK 與索引都在（2.10）。

---

## 2.1 學習目標

完成本章後，你應該可以：

- 用 2.2.1 的輸出說明**為什麼本專題的 schema 只由 Flyway 管理**，以及 `ddl-auto=update` 在第二版會怎麼壞。
- 說出 Hibernate 6 在 MySQL 上把 `@Enumerated(STRING)` 對應成什麼型別，以及為什麼每個 enum 欄位都要加 `@JdbcTypeCode(SqlTypes.VARCHAR)`（2.4.2）。
- 列出 **`ddl-auto=validate` 看得到的 7 種不一致、看不到的 5 種**，並用 `EntitySchemaDriftTest` 補上後者（2.4.2）。
- 說明**金額、時間、狀態、主鍵、對外編號**五類欄位的型別選擇，並用 2.4.3 的實測說出少了 `connectionTimeZone=UTC` 會差幾小時（2.4）。
- 說明**訂單編號為什麼不用「每日流水號」**，並用生日問題估算隨機編號一天會撞幾次（2.4.4）。
- 把 0.4.6 的不變量翻譯成 **CHECK、UNIQUE、外鍵**三種約束，並說出 **CHECK 遇到 `NULL` 會怎樣**（2.5）。
- 列出 **MySQL 約束擋不住的四類規則**（小數位數、`NULL` 參與的 UNIQUE、跨列 / 跨表、跟時間有關的），以及每一類改由誰負責（2.5.4）。
- 用 2.2.3 的數字說明**跨模組外鍵的鎖成本**，以及同模組外鍵為什麼要「**先動父表、再寫子表**」（2.6）。
- 從 0.8 的 API 與 0.6.2 的 SLO **反推**每張表的索引，並用 `EXPLAIN ANALYZE` 驗證（2.7）。
- 用 **invisible index** 在不刪索引的情況下比較執行計畫（2.7.5）。
- 寫一份**可重現、滿足不變量**的種子資料，並說出 JPA `IDENTITY` 為什麼沒辦法批次寫入（2.8）。
- 說出 Flyway 在 MySQL 上的**四條硬規則**：不改已執行的檔、一個檔一句 DDL、版本號衝突時改名不 `outOfOrder`、刪檔之後要 `mvn clean`（2.9）。
- 讓**驗收 Q6** 變綠（2.10）。

---

## 2.2 先看見痛：schema 是「誰、何時、怎麼改」的問題

### 2.2.0 實驗環境：`shop_lab`

> 📌 **動手順序。** 這一章的節是照「講解」排的，不是照「動手」排的。
> 2.2 的實驗要用的 JPA 與 Flyway 在 2.9.1 才加進 pom、`-Pexperiments` 在 2.11.1 才定義 —— 而 `src/test` 底下的類別是**一起編譯**的，少一個依賴，連一個實驗都跑不了。
> 從第 01 章結束時的專案出發，照這個順序做：
>
> 1. `docker/mysql-init/01-databases.sql` 與 `compose.yaml` 的掛載，然後手動執行一次（2.2.0，本節）。
> 2. `pom.xml`：加 `spring-boot-starter-data-jpa`、`flyway-core`、`flyway-mysql`（2.9.1），以及 surefire 分組與 `experiments` / `seed` 兩個 profile（2.11.1）。
> 3. `application.yml` 加 jpa 與 flyway 的設定（2.9.1）。
> 4. `src/test/resources/application-lab.yml`，並照 2.9.3 的表處理第 00、01 章的六個實驗類別（2.9.3）。
> 5. V1～V9（2.3.2）；6 個 Entity 與 3 個 enum（2.4.2，課文沒有貼的完整內容在 2.11.3）。
> 6. 刪掉第 01 章的 `PlaceOrderService`（2.9.3 最後的 📌）。
> 7. `DROP DATABASE shop` 再建回來，啟動一次：Flyway 跑完 V1～V9、`validate` 通過（2.9.3）。
> 8. 守門員：`EntitySchemaDriftTest`（2.4.2）、`SchemaConstraintTest`（2.5.2）、`InvariantReconciliationTest`（2.5.5）、`MigrationOwnershipTest`（2.9.4）、`EntityTableOwnershipTest`（2.9.7），以及驗收 Q6（2.10）。
>    這時 `SchemaConstraintTest` 會有一條是紅的 —— 那正是 2.5.4 的故事。
> 9. V10（2.5.4）。`mvn clean test` 應該跟 2.11.1 的輸出一樣。
> 10. 只用 `shop_lab` / `shop_c2` 的實驗：C1～C6、C9（2.2、2.4、2.5、2.6，`mvn test -Pexperiments -Dtest=...`）。
> 11. 種子資料 `SeedData`（2.8），然後跑需要 `shop` 裡有資料的實驗：C7（2.7.2）、C8（2.7.4）、C10（2.9.6）。

從這一章開始，`shop` 資料庫**只歸 Flyway 管**（2.9）。任何會自己建表、刪表的實驗，都不能再碰它。

所以先多建幾個實驗用的資料庫。在專案根目錄建 `docker/mysql-init/01-databases.sql`：

```sql
-- 實驗與驗收測試用的資料庫。只在空 volume 第一次啟動時自動執行；
-- 已經有 volume 的人手動跑一次：docker compose exec -T mysql mysql -uroot -proot < docker/mysql-init/01-databases.sql
CREATE DATABASE IF NOT EXISTS shop_lab;
GRANT ALL PRIVILEGES ON `shop_lab`.* TO 'shop'@'%';   -- 第 00～02 章的實驗
GRANT ALL PRIVILEGES ON `shop_c2`.*  TO 'shop'@'%';   -- 2.2.2 Flyway 實驗（測試自己建、自己刪）
GRANT ALL PRIVILEGES ON `shop_q6`.*  TO 'shop'@'%';   -- 驗收 Q6：每次從空資料庫開始
FLUSH PRIVILEGES;
```

`compose.yaml` 的 `mysql` 服務把它掛進映像的初始化目錄：

```yaml
    volumes:
      - mysql-data:/var/lib/mysql
      - ./docker/mysql-init:/docker-entrypoint-initdb.d:ro   # 第 02 章：shop_lab、shop_c2、shop_q6
```

> ⚠️ `docker-entrypoint-initdb.d` **只在 volume 是空的時候執行一次**。你從第 00 章就在用的 volume 已經初始化過了，
> 所以要手動跑一次（上面註解那一行）。這是 0.10.1 那個「臨時 MySQL」機制的另一面。

> 📌 `shop_c2` 與 `shop_q6` 不用先建 —— 測試會自己 `DROP DATABASE` / `CREATE DATABASE`。
> `GRANT ... ON shop_q6.*` 在資料庫還不存在時就可以下，它授權的是「這個名字」。

本章的實驗放在 `src/test/java/com/example/shop/ch02/`，全部標 `@Tag("experiment")`（2.11 會說明怎麼讓預設的 `mvn test` 不跑它們）。
單獨跑一個實驗：

```bash
mvn test -Pexperiments -Dtest=C1DdlAutoUpdateTest
```

> ⚠️ **寫這一章的實驗時會踩到的兩個坑**，先講，免得你踩：
>
> **① `SpringApplicationBuilder.properties()` 是最低優先序。**
> 實驗如果用 `.properties("spring.datasource.url=...shop_lab")` 指定資料庫，**每一個實驗都會跑在 `shop` 裡** ——
> `.properties()` 設定的是 *default properties*，排在 1.7.2 那五層的**最底下**，被 `application-local.yml` 的 `spring.datasource.url` 蓋掉了。
> 而且沒有任何錯誤：連線成功、表建成功、只是建在另一個資料庫。改成 `.run("--spring.datasource.url=...")`（命令列參數，最高優先序）才對。
> （第 01 章的 `B2ConfigTypoTest` 用 `.properties("spring.config.name=...")` 沒事，是因為 `spring.config.name` 本來就沒有人設。）
>
> **② 實驗用的 `@Entity` 不能放在 `com.example.shop` 底下。**
> `@SpringBootApplication` 的 Entity 掃描範圍是它所在的套件**以及所有子套件** —— **包括 `src/test` 裡的類別**（它們在同一個 classpath 上）。
> 實驗的 `LabOrder` 放在 `com.example.shop.ch02.v1` 時，正式的 `ShopApplication` 一啟動就炸：
>
> ```
> Entity classes [com.example.shop.ch02.v1.LabOrder] and [com.example.shop.ch02.v2.LabOrder] share the entity name 'LabOrder'
> ```
>
> 所以本章實驗用的 Entity 一律放在 **`com.example.lab.ch02`**，在正式程式的掃描範圍之外。

### 2.2.1 事故一：讓 Hibernate 管 schema ★★★

最省事的做法是讓 Hibernate 根據 Entity 自動建表：開發時 `ddl-auto=create`，上線後改成 `update`，「以後加欄位它會自己處理」。

來試試看。第一版的訂單有三個狀態：

```java
package com.example.lab.ch02.v1;

import jakarta.persistence.*;

import java.math.BigDecimal;
import java.time.Instant;

/** 第一版：三個狀態 */
@Entity
@Table(name = "lab_orders")
public class LabOrder {
    public enum Status { PENDING_PAYMENT, PAID, CANCELLED }

    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    Long id;
    String orderNo;
    @Enumerated(EnumType.STRING)
    Status status;
    BigDecimal totalAmount;
    Instant createdAt;

    protected LabOrder() {}
    public LabOrder(String orderNo, Status status, BigDecimal totalAmount) {
        this.orderNo = orderNo; this.status = status; this.totalAmount = totalAmount; this.createdAt = Instant.now();
    }
}
```

第二版，產品經理加了 0.2.2 定案的「撿貨中」—— `com.example.lab.ch02.v2.LabOrder` 跟上面一模一樣，只差一行：

```java
    public enum Status { PENDING_PAYMENT, PAID, PICKING, CANCELLED }
```

實驗：第一版用 `create` 啟動、寫一筆訂單；第二版用 `update` 啟動、寫一筆 `PICKING` 的訂單。

```java
package com.example.shop.ch02;

import com.example.lab.ch02.v1.LabOrder;
import jakarta.persistence.EntityManager;
import jakarta.persistence.EntityManagerFactory;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.ImportAutoConfiguration;
import org.springframework.boot.autoconfigure.domain.EntityScan;
import org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration;
import org.springframework.boot.autoconfigure.jdbc.JdbcTemplateAutoConfiguration;
import org.springframework.boot.autoconfigure.orm.jpa.HibernateJpaAutoConfiguration;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;

import java.math.BigDecimal;

/**
 * 2.2.1 讓 Hibernate 管 schema：第一版用 ddl-auto=create 建表，
 * 第二版（enum 多了一個 PICKING）用 ddl-auto=update 「自動更新」。
 */
@Tag("experiment")
class C1DdlAutoUpdateTest {

    @ImportAutoConfiguration({DataSourceAutoConfiguration.class, JdbcTemplateAutoConfiguration.class, HibernateJpaAutoConfiguration.class})
    @EntityScan(basePackageClasses = com.example.lab.ch02.v1.LabOrder.class)
    static class Version1 {}

    @ImportAutoConfiguration({DataSourceAutoConfiguration.class, JdbcTemplateAutoConfiguration.class, HibernateJpaAutoConfiguration.class})
    @EntityScan(basePackageClasses = com.example.lab.ch02.v2.LabOrder.class)
    static class Version2 {}

    static ConfigurableApplicationContext start(Class<?> app, String ddlAuto) {
        // 注意：用 run(args) 傳「命令列參數」，不要用 .properties()——後者是最低優先序，會被 application-local.yml 蓋掉
        return new SpringApplicationBuilder(app).web(WebApplicationType.NONE).run(
                "--spring.datasource.url=jdbc:mysql://localhost:3306/shop_lab?useSSL=false&allowPublicKeyRetrieval=true&connectionTimeZone=UTC",
                "--spring.jpa.hibernate.ddl-auto=" + ddlAuto,
                "--spring.main.banner-mode=off", "--logging.level.root=OFF");
    }

    @Test
    void ddlAutoUpdate() {
        System.out.println("═══ 2.2.1 讓 Hibernate 管 schema ═══");
        try (var ctx = start(Version1.class, "create")) {
            System.out.println("── 第一版上線（ddl-auto=create）：Hibernate 建出來的表 ──");
            System.out.println(ctx.getBean(JdbcTemplate.class).queryForMap("SHOW CREATE TABLE lab_orders").get("Create Table"));
            EntityManager em = ctx.getBean(EntityManagerFactory.class).createEntityManager();
            em.getTransaction().begin();
            em.persist(new LabOrder("20260923-000001", LabOrder.Status.PAID, new BigDecimal("1234.5")));
            em.getTransaction().commit();
            em.close();
        }
        try (var ctx = start(Version2.class, "update")) {
            System.out.println("\n── 第二版上線（enum 加了 PICKING；ddl-auto=update）：表變成 ──");
            System.out.println(ctx.getBean(JdbcTemplate.class).queryForMap("SHOW CREATE TABLE lab_orders").get("Create Table"));
            EntityManager em = ctx.getBean(EntityManagerFactory.class).createEntityManager();
            em.getTransaction().begin();
            try {
                em.persist(new com.example.lab.ch02.v2.LabOrder("20260923-000002",
                        com.example.lab.ch02.v2.LabOrder.Status.PICKING, new BigDecimal("99")));
                em.getTransaction().commit();
                System.out.println("\n賣家按下「開始撿貨」→ 成功");
            } catch (Exception e) {
                Throwable root = e;
                while (root.getCause() != null) root = root.getCause();
                System.out.println("\n賣家按下「開始撿貨」→ " + e.getClass().getSimpleName() + "\n  根因：" + root);
            }
        }
    }
}
```

**輸出**：

```
═══ 2.2.1 讓 Hibernate 管 schema ═══
── 第一版上線（ddl-auto=create）：Hibernate 建出來的表 ──
CREATE TABLE `lab_orders` (
  `total_amount` decimal(38,2) DEFAULT NULL,
  `created_at` datetime(6) DEFAULT NULL,
  `id` bigint NOT NULL AUTO_INCREMENT,
  `order_no` varchar(255) DEFAULT NULL,
  `status` enum('PENDING_PAYMENT','PAID','CANCELLED') DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci

── 第二版上線（enum 加了 PICKING；ddl-auto=update）：表變成 ──
CREATE TABLE `lab_orders` (
  `total_amount` decimal(38,2) DEFAULT NULL,
  `created_at` datetime(6) DEFAULT NULL,
  `id` bigint NOT NULL AUTO_INCREMENT,
  `order_no` varchar(255) DEFAULT NULL,
  `status` enum('PENDING_PAYMENT','PAID','CANCELLED') DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci

賣家按下「開始撿貨」→ GenericJDBCException
  根因：java.sql.SQLException: Data truncated for column 'status' at row 1
```

**先看第二版的錯誤。**

兩次 `SHOW CREATE TABLE` 一個字都沒變。`status` 還是 `enum('PENDING_PAYMENT','PAID','CANCELLED')` —— 沒有 `PICKING`。
`ddl-auto=update` 的行為是「**表不存在就建、欄位不存在就加**」，它**不會修改一個已經存在的欄位**：不改型別、不改長度、不改 enum 的值、不改 `NULL` / `NOT NULL`。
（它也不會刪任何東西 —— 這一點倒是好事。）

錯誤訊息 `Data truncated for column 'status'` 很容易誤導人：它聽起來像「字串太長」，實際上是「**這個值不在 enum 的清單裡**」。
MySQL 8 預設的 `sql_mode` 有 `STRICT_TRANS_TABLES`，所以這是一個錯誤；在非嚴格模式下，它會**默默存成空字串 `''`**，連錯誤都沒有。

**再看第一版：Hibernate 建出來的表，跟 0.6.7 的要求差多少？**

| 欄位 | Hibernate 建的 | 本專題的需求 | 差在哪 |
|---|---|---|---|
| `total_amount` | `decimal(38,2)`、可為 `NULL` | `DECIMAL(12,2) NOT NULL` | `BigDecimal` 沒寫 `precision` 時預設 38 位。金額可以是 `NULL` —— 「這張訂單多少錢？不知道。」 |
| `created_at` | `datetime(6)`、可為 `NULL` | `DATETIME(3) NOT NULL` | 微秒精度（MySQL 在 fsync 之前就四捨五入了，Java 的 `Instant` 又是奈秒 —— 三個精度都不一樣） |
| `order_no` | `varchar(255)`、可為 `NULL`、**沒有 UNIQUE** | `VARCHAR(15) NOT NULL UNIQUE` | 兩張訂單同一個編號，資料庫不會擋 |
| `status` | MySQL 原生 `enum(...)` | `VARCHAR(20)` + `CHECK` | 就是上面那個錯誤的來源 |
| 索引 | **只有主鍵** | 6 個（2.7） | 「我的訂單」全表掃描 |
| CHECK | **一個都沒有** | 6 個（2.5） | 0.2.2 的非法組合，資料庫全部放行 |

**你可以在 Entity 上補 `@Column(nullable = false, length = 15, unique = true)` 讓 Hibernate 建得更好**，這樣上面前四列會改善。
但事故的根源不在「建得好不好」，而在「**建完之後誰負責改**」：

```
ddl-auto=update 會做的   ：新增表、新增欄位
ddl-auto=update 不會做的 ：改型別、改長度、改 enum、改 NULL、加 CHECK、加 / 刪索引、刪欄位、改名、搬資料
正式環境需要的變更       ：幾乎都在第二行
```

**這一節要帶走的**：

1. **`ddl-auto=update` 只做 schema 變更裡「最簡單的那 10%」**，而且對另外 90% 保持沉默 —— 不報錯、不警告，直到某一筆資料寫不進去。
2. **schema 的每一次變更都要是一個「看得到、審得了、跑過測試」的檔案。** 這就是 Flyway（2.9）。
   `ddl-auto` 在本專題只剩一個值：**`validate`** —— Hibernate 不改 schema，只**檢查** Entity 跟 schema 對不對得上。
3. ⚠️ **而 `validate` 也有它看不到的東西。** 2.4.2 會實測 12 種不一致，它只抓到其中 7 種。

> 📌 **Hibernate 6.2 起，MySQL 上的 `@Enumerated(STRING)` 預設對應成原生 `enum` 型別**（6.1 以前是 `varchar(255)`）。
> 這個改變會在另一個地方咬你：當 schema 由 Flyway 建成 `VARCHAR(20)` 時，`validate` 會**拒絕啟動** ——
> 因為它預期的是 `enum`。2.4.2 會看到那個錯誤訊息，以及修法（`@JdbcTypeCode(SqlTypes.VARCHAR)`）。

### 2.2.2 事故二：Flyway 在 MySQL 上的三個坑 ★★★

`ddl-auto=update` 不行，那就用 Flyway：每一次 schema 變更寫成一個 `V<版本>__<說明>.sql`，Flyway 依版本號執行、記在 `flyway_schema_history` 表裡、每個檔只執行一次。
[07-mysql/06](../07-mysql/06-schema-migration-flyway.md) 已經講過基本用法。

這一節看它在 MySQL 上**最常出事的三個地方**。實驗直接用 Flyway 的 Java API，對一個臨時資料庫 `shop_c2`、以一個臨時資料夾當 migration 來源：

```java
package com.example.shop.ch02;

import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.stream.Stream;

/**
 * 2.2.2 Flyway 在 MySQL 上的三個坑：改了跑過的腳本、跑到一半的腳本、兩個分支同一個版本號。
 * 用一個臨時資料夾當 migration 來源，對 shop_c2 執行。
 */
@Tag("experiment")
class C2FlywayPitfallsTest {

    static final Path DIR = Path.of("target/ch02-flyway");
    static final DriverManagerDataSource DS = new DriverManagerDataSource(
            "jdbc:mysql://localhost:3306/shop_c2?useSSL=false&allowPublicKeyRetrieval=true", "shop", "shop");
    static final JdbcTemplate JDBC = new JdbcTemplate(DS);
    static final JdbcTemplate ADMIN = new JdbcTemplate(new DriverManagerDataSource(
            "jdbc:mysql://localhost:3306/?useSSL=false&allowPublicKeyRetrieval=true", "shop", "shop"));

    static Flyway flyway() {
        return Flyway.configure().dataSource(DS).locations("filesystem:" + DIR).load();
    }

    static void write(String file, String sql) throws Exception {
        Files.writeString(DIR.resolve(file), sql);
    }

    static void migrate(String label) {
        System.out.println("  $ flyway migrate    # " + label);
        try {
            var r = flyway().migrate();
            System.out.printf("    ✓ 成功執行 %d 個 migration，目前版本 %s%n", r.migrationsExecuted, r.targetSchemaVersion);
        } catch (Exception e) {
            String msg = e.getMessage().lines().filter(l -> !l.isBlank()).limit(8)
                    .map(l -> "      " + l.strip()).reduce((a, b) -> a + "\n" + b).orElse("");
            System.out.println("    ✗ " + e.getClass().getSimpleName() + "\n" + msg);
        }
    }

    static void history() {
        System.out.println("    flyway_schema_history：");
        for (MigrationInfo i : flyway().info().applied()) {
            System.out.printf("      V%-3s %-28s %s%n", i.getVersion(), i.getDescription(), i.getState());
        }
    }

    static void columns() {
        System.out.println("    c2_orders 目前的欄位：" + JDBC.queryForList(
                "SELECT column_name FROM information_schema.columns WHERE table_schema='shop_c2' AND table_name='c2_orders' ORDER BY ordinal_position",
                String.class));
    }

    @Test
    void flywayPitfalls() throws Exception {
        if (Files.exists(DIR)) try (Stream<Path> s = Files.walk(DIR)) { s.sorted(Comparator.reverseOrder()).forEach(p -> p.toFile().delete()); }
        Files.createDirectories(DIR);
        ADMIN.execute("DROP DATABASE IF EXISTS shop_c2");
        ADMIN.execute("CREATE DATABASE shop_c2");

        System.out.println("═══ 2.2.2 Flyway 在 MySQL 上的三個坑 ═══");
        System.out.println("\n── 坑一：改了一個已經跑過的 migration ──");
        write("V1__create_orders.sql", """
                CREATE TABLE c2_orders (
                  id BIGINT AUTO_INCREMENT PRIMARY KEY,
                  buyer_id BIGINT NOT NULL,
                  created_at DATETIME(3) NOT NULL);
                """);
        write("V2__add_seller_id.sql", "ALTER TABLE c2_orders ADD COLUMN seller_id BIGINT NOT NULL DEFAULT 0;\n");
        migrate("正式環境：V1、V2 上線");
        write("V2__add_seller_id.sql", """
                ALTER TABLE c2_orders ADD COLUMN seller_id BIGINT NOT NULL DEFAULT 0;
                -- code review 時有人說「順便加個索引吧」，就直接改在 V2 裡
                CREATE INDEX idx_c2_orders_seller ON c2_orders(seller_id, created_at);
                """);
        migrate("下一次部署：V2 被改過了");
        write("V2__add_seller_id.sql", "ALTER TABLE c2_orders ADD COLUMN seller_id BIGINT NOT NULL DEFAULT 0;\n");

        System.out.println("\n── 坑二：一個腳本兩句 DDL，第二句失敗 ──");
        write("V3__add_paid_at.sql", """
                ALTER TABLE c2_orders ADD COLUMN paid_at DATETIME(3) NULL;
                CREATE INDEX idx_c2_orders_paid ON c2_orders(paid_atx);
                """);
        migrate("V3：第二句的欄位名打錯了");
        columns();
        history();
        write("V3__add_paid_at.sql", """
                ALTER TABLE c2_orders ADD COLUMN paid_at DATETIME(3) NULL;
                CREATE INDEX idx_c2_orders_paid ON c2_orders(paid_at);
                """);
        migrate("修好錯字，重新部署");
        System.out.println("  $ flyway repair");
        flyway().repair();
        history();
        migrate("repair 之後再部署");
        columns();

        System.out.println("\n── 坑三：兩個分支各自加了 V4 ──");
        JDBC.execute("ALTER TABLE shop_c2.c2_orders DROP COLUMN paid_at");
        flyway().repair();
        migrate("手動收拾 paid_at、repair 之後");
        write("V4__add_carrier.sql", "ALTER TABLE c2_orders ADD COLUMN carrier VARCHAR(30) NULL;\n");
        write("V4__add_cancel_reason.sql", "ALTER TABLE c2_orders ADD COLUMN cancel_reason VARCHAR(30) NULL;\n");
        migrate("兩個分支合併進 main");
        Files.delete(DIR.resolve("V4__add_cancel_reason.sql"));
        write("V5__add_cancel_reason.sql", "ALTER TABLE c2_orders ADD COLUMN cancel_reason VARCHAR(30) NULL;\n");
        Files.delete(DIR.resolve("V4__add_carrier.sql"));
        migrate("分支 B 改名成 V5 先上線，分支 A 的 V4 還沒合併");
        write("V4__add_carrier.sql", "ALTER TABLE c2_orders ADD COLUMN carrier VARCHAR(30) NULL;\n");
        migrate("一週後分支 A（V4）才合併");
        history();
    }
}
```

**輸出**（Flyway 自己的 INFO / WARN 日誌行已刪去，`Location` 的絕對路徑也省略）：

```
═══ 2.2.2 Flyway 在 MySQL 上的三個坑 ═══

── 坑一：改了一個已經跑過的 migration ──
  $ flyway migrate    # 正式環境：V1、V2 上線
    ✓ 成功執行 2 個 migration，目前版本 2
  $ flyway migrate    # 下一次部署：V2 被改過了
    ✗ FlywayValidateException
      Validate failed: Migrations have failed validation
      Migration checksum mismatch for migration version 2
      -> Applied to database : -840795005
      -> Resolved locally    : 1981751347
      Either revert the changes to the migration, or run repair to update the schema history.
      Need more flexibility with validation rules? Learn more: https://rd.gt/3AbJUZE

── 坑二：一個腳本兩句 DDL，第二句失敗 ──
  $ flyway migrate    # V3：第二句的欄位名打錯了
    ✗ FlywayMigrateException
      Migration V3__add_paid_at.sql failed
      ------------------------------------
      SQL State  : 42000
      Error Code : 1072
      Message    : Key column 'paid_atx' doesn't exist in table
      Location   : target/ch02-flyway/V3__add_paid_at.sql
      Line       : 2
      Statement  : CREATE INDEX idx_c2_orders_paid ON c2_orders(paid_atx)
    c2_orders 目前的欄位：[id, buyer_id, created_at, seller_id, paid_at]
    flyway_schema_history：
      V1   create orders                SUCCESS
      V2   add seller id                SUCCESS
      V3   add paid at                  FAILED
  $ flyway migrate    # 修好錯字，重新部署
    ✗ FlywayValidateException
      Validate failed: Migrations have failed validation
      Detected failed migration to version 3 (add paid at).
      Please remove any half-completed changes then run repair to fix the schema history.
      Need more flexibility with validation rules? Learn more: https://rd.gt/3AbJUZE
  $ flyway repair
    flyway_schema_history：
      V1   create orders                SUCCESS
      V2   add seller id                SUCCESS
  $ flyway migrate    # repair 之後再部署
    ✗ FlywayMigrateException
      Migration V3__add_paid_at.sql failed
      ------------------------------------
      SQL State  : 42S21
      Error Code : 1060
      Message    : Duplicate column name 'paid_at'
      Location   : target/ch02-flyway/V3__add_paid_at.sql
      Line       : 1
      Statement  : ALTER TABLE c2_orders ADD COLUMN paid_at DATETIME(3) NULL
    c2_orders 目前的欄位：[id, buyer_id, created_at, seller_id, paid_at]

── 坑三：兩個分支各自加了 V4 ──
  $ flyway migrate    # 手動收拾 paid_at、repair 之後
    ✓ 成功執行 1 個 migration，目前版本 3
  $ flyway migrate    # 兩個分支合併進 main
    ✗ FlywayException
      Found more than one migration with version 4
      Offenders:
      -> .../target/ch02-flyway/V4__add_cancel_reason.sql (SQL)
      -> .../target/ch02-flyway/V4__add_carrier.sql (SQL)
  $ flyway migrate    # 分支 B 改名成 V5 先上線，分支 A 的 V4 還沒合併
    ✓ 成功執行 1 個 migration，目前版本 5
  $ flyway migrate    # 一週後分支 A（V4）才合併
    ✗ FlywayValidateException
      Validate failed: Migrations have failed validation
      Detected resolved migration not applied to database: 4.
      To ignore this migration, set -ignoreMigrationPatterns='*:ignored'. To allow executing this migration, set -outOfOrder=true.
      Need more flexibility with validation rules? Learn more: https://rd.gt/3AbJUZE
    flyway_schema_history：
      V1   create orders                SUCCESS
      V2   add seller id                SUCCESS
      V3   add paid at                  SUCCESS
      V5   add cancel reason            SUCCESS
```

**坑一：改了已經跑過的檔 → 拒絕啟動。**

Flyway 對每個執行過的檔記一個 **checksum**（CRC32）。下一次啟動時，本地檔案的 checksum 跟 `flyway_schema_history` 裡的不一樣 → `FlywayValidateException` → Spring Boot 的 `flywayInitializer` bean 建立失敗 → **應用程式起不來**。

這是一個**好的**失敗。它擋住的情況是：開發環境的 V2 有索引、正式環境的 V2 沒有 —— **同一個版本號，兩種 schema**。
錯誤訊息建議的 `repair` 在這裡是**錯的**解法：它會把 checksum 改成新的值，讓 Flyway 閉嘴，但正式環境**還是沒有那個索引**。
正確的做法是**把 V2 改回原樣，索引寫成新的 V3**。

> 📌 **規則一：一個 migration 一旦離開你的筆電（合併進 main、跑過任何共用環境），就不再修改。** 要改，就寫下一版。

**坑二：一個檔案兩句 DDL，第二句失敗 → 三次部署、三種錯誤。**

這是本節最重要的一個坑。順著時間看：

| 次 | 發生什麼 | 資料庫的狀態 | `flyway_schema_history` |
|---|---|---|---|
| 1 | 第 1 句 `ADD COLUMN paid_at` 成功；第 2 句欄位名打錯，失敗 | **`paid_at` 已經加上了** | V3 = `FAILED` |
| 2 | 修好錯字重新部署 → Flyway 看到 V3 是 `FAILED`，**拒絕執行任何東西** | 同上 | 同上 |
| 3 | 照訊息的建議 `repair`（把 `FAILED` 那一列刪掉），再部署 → 從第 1 句重跑 | `Duplicate column name 'paid_at'` | V3 又是 `FAILED` |

**為什麼第 1 句沒有被 rollback？** 因為 **MySQL 的 DDL 會隱式 commit**（implicit commit）。
每一句 `ALTER TABLE`、`CREATE INDEX` 執行前後，MySQL 都會自動 commit 目前的交易 —— DDL **不能被 rollback**。
Flyway 在 PostgreSQL 上會把整個 V3 包在一個交易裡，失敗就全部回滾；**在 MySQL 上它做不到**，所以它只能把 V3 標成 `FAILED`，然後要你「**先手動清掉做到一半的變更**」（第 2 次的訊息第三行寫得很清楚）。

注意第 2 次的訊息是有提示的：`Please remove any half-completed changes then run repair`。
**但它不會告訴你「做到一半的變更」是哪些。** 你要自己去比對 V3 的內容和資料庫的現狀。
兩句的 V3 還好比對；二十句的 V3（「順便把這一季的 schema 變更都放進來」）失敗在第 13 句時，你要一句一句查前 12 句的結果。

> 📌 **規則二：在 MySQL 上，一個 migration 檔只放一句 DDL。**
> 這樣「失敗」只有一種意思：**那一句沒有做**。清理的步驟永遠是「`repair`、修好、重新部署」，不需要猜。
> 2.9.4 會用 `MigrationOwnershipTest` 把這條規則寫成測試。
>
> （DML —— `INSERT`、`UPDATE` —— 會在交易裡。多句 DML 放一個檔案沒有這個問題；DDL 與 DML 混在同一個檔案裡，DDL 仍然會把前面的 DML 隱式 commit 掉。）

**坑三：兩個分支、同一個版本號。**

兩個工程師同時開分支，各自看了一下 main 上最新的版本是 V3，各自加了 V4。合併之後：

- **兩個都合併進來** → `Found more than one migration with version 4` → 啟動失敗。這個好處理：CI 就會抓到（2.10 的 Q6 會紅）。
- **比較陰險的情況**：分支 B 先合併、而且發現撞號了，就改成 V5 **先上線**。一週後分支 A（V4）才合併 ——
  正式環境的版本已經是 5，Flyway 看到一個「版本比目前小、卻從來沒有執行過」的 V4 → `Detected resolved migration not applied to database: 4` → 啟動失敗。

錯誤訊息給了兩條路：`ignoreMigrationPatterns`（**永遠不執行** V4 —— carrier 欄位就不存在了）和 `outOfOrder=true`（允許在 V5 之後執行 V4）。
`outOfOrder` 看起來無害，但它讓「版本號」不再代表「執行順序」：

```
開發環境：V3 → V4 → V5     （照版本號）
正式環境：V3 → V5 → V4     （照上線順序）
```

**只要 V4 和 V5 碰到同一張表，兩個環境的結果就可能不一樣**，而你沒辦法從 `flyway_schema_history` 的版本號看出來。

> 📌 **規則三：版本號衝突時，改名（rebase 到最新版本號之後），不開 `outOfOrder`。**
> 後合併的那一方負責改名 —— 就像 git 的 rebase。V4 → V6，重新跑一次測試，再合併。

**這一節要帶走的**：

1. **Flyway 的每一個錯誤都是在保護你。** checksum 不符、`FAILED`、版本號重複、順序錯亂 —— 它們都讓應用程式**起不來**，而不是讓它帶著錯的 schema 起來。
2. **MySQL 的 DDL 不在交易裡**，這是本章所有 migration 規則的根源。
3. 三條規則：**不改已執行的檔、一個檔一句 DDL、衝突時改名**。第四條（刪了檔要 `mvn clean`）在 2.9.5。

### 2.2.3 事故三：跨模組外鍵，讓賣家改價時全站無法下單 ★★★

1.5.5 說過：**`order_items.product_id` 不會有指向 `products` 的外鍵**，並且承諾「第 02 章會實測『要』的時候會發生什麼事」。這一節就是那個實測。

先講直覺上的反對意見 —— 它是對的，只是不完整：

> 「外鍵保護資料完整性。沒有外鍵，`order_items` 裡可能出現一個不存在的 `product_id`。」

沒錯。那外鍵的**代價**是什麼？InnoDB 在子表 INSERT 一列時，要確認父表那一列存在，而且**在交易結束前它不能被刪掉** ——
所以它會對父表的那一列加一把**共享鎖（S lock）**，一直持有到 commit（[07-mysql/04](../07-mysql/04-transaction-isolation-and-lock.md)）。

共享鎖跟共享鎖不衝突，所以平常沒事。**但共享鎖跟排他鎖（X lock）衝突** —— 而 `UPDATE products SET price = ...` 拿的正是排他鎖。

**情境**：賣家 7 有 500 個商品，他在後台按下「全館漲價 5%」。這個動作在一個交易裡逐筆更新 500 個商品，每一筆順便做 2 ms 的其他事（寫稽核、清快取 —— 第 06 章的事），整個交易約 1.5 秒。
同一時間，16 條執行緒持續在下單（買的都是賣家 7 的商品）。

```java
package com.example.shop.ch02;

import com.zaxxer.hikari.HikariDataSource;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 2.2.3 跨模組外鍵：order_items.product_id → products.id。
 * 賣家在一個交易裡批次改價 500 個商品（每個商品 2 ms 的「其他處理」，整個交易約 1.5 秒），
 * 同時有 16 條執行緒在下單。比較有 / 沒有外鍵時，下單的延遲。
 */
@Tag("experiment")
class C3CrossModuleForeignKeyTest {

    static HikariDataSource ds;
    static JdbcTemplate jdbc;
    static TransactionTemplate tx;

    @BeforeAll
    static void setUp() {
        ds = new HikariDataSource();
        ds.setJdbcUrl("jdbc:mysql://localhost:3306/shop_lab?useSSL=false&allowPublicKeyRetrieval=true&connectionTimeZone=UTC&rewriteBatchedStatements=true");
        ds.setUsername("shop");
        ds.setPassword("shop");
        ds.setMaximumPoolSize(24);
        jdbc = new JdbcTemplate(ds);
        tx = new TransactionTemplate(new DataSourceTransactionManager(ds));
    }

    @AfterAll
    static void tearDown() { ds.close(); }

    static void schema(boolean withFk) {
        jdbc.execute("DROP TABLE IF EXISTS c3_order_items");
        jdbc.execute("DROP TABLE IF EXISTS c3_orders");
        jdbc.execute("DROP TABLE IF EXISTS c3_products");
        jdbc.execute("""
            CREATE TABLE c3_products (
              id BIGINT PRIMARY KEY, seller_id BIGINT NOT NULL, name VARCHAR(200) NOT NULL,
              price DECIMAL(12,2) NOT NULL, updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3))""");
        jdbc.execute("CREATE TABLE c3_orders (id BIGINT AUTO_INCREMENT PRIMARY KEY, buyer_id BIGINT NOT NULL)");
        jdbc.execute("""
            CREATE TABLE c3_order_items (
              id BIGINT AUTO_INCREMENT PRIMARY KEY, order_id BIGINT NOT NULL, product_id BIGINT NOT NULL,
              unit_price DECIMAL(12,2) NOT NULL, quantity INT NOT NULL,
              CONSTRAINT fk_c3_items_order FOREIGN KEY (order_id) REFERENCES c3_orders(id),
              KEY idx_c3_items_product (product_id)
              %s)""".formatted(withFk ? ", CONSTRAINT fk_c3_items_product FOREIGN KEY (product_id) REFERENCES c3_products(id)" : ""));
        List<Object[]> rows = new ArrayList<>();
        for (long id = 1; id <= 1000; id++) rows.add(new Object[]{id, id <= 500 ? 7L : 8L, "商品 " + id, 100});
        jdbc.batchUpdate("INSERT INTO c3_products(id, seller_id, name, price) VALUES (?,?,?,?)", rows);
    }

    record Result(double p50, double p99, double max, int orders, double sellerTxMs, int slow, int[] timeline) {}

    static Result run(boolean withFk) throws Exception {
        schema(withFk);
        ExecutorService pool = Executors.newFixedThreadPool(17);
        AtomicBoolean stop = new AtomicBoolean();
        List<Future<List<Long>>> buyers = new ArrayList<>();
        long t0 = System.nanoTime();
        ConcurrentLinkedQueue<Long> doneAt = new ConcurrentLinkedQueue<>();
        for (int t = 0; t < 16; t++) {
            buyers.add(pool.submit(() -> {
                List<Long> lat = new ArrayList<>();
                ThreadLocalRandom r = ThreadLocalRandom.current();
                while (!stop.get()) {
                    long productId = 1 + r.nextInt(500);                 // 買的是賣家 7 的商品
                    long s = System.nanoTime();
                    tx.executeWithoutResult(st -> {
                        jdbc.update("INSERT INTO c3_orders(buyer_id) VALUES (?)", r.nextLong(1, 10_000));
                        Long orderId = jdbc.queryForObject("SELECT LAST_INSERT_ID()", Long.class);
                        jdbc.update("INSERT INTO c3_order_items(order_id, product_id, unit_price, quantity) VALUES (?,?,100,1)",
                                orderId, productId);
                    });
                    long e = System.nanoTime();
                    lat.add(e - s);
                    doneAt.add(e - t0);
                }
                return lat;
            }));
        }
        Thread.sleep(1000);                                            // 先讓下單跑 1 秒
        long s0 = System.nanoTime();
        long sellerStart = s0 - t0;
        tx.executeWithoutResult(st -> {                                // 賣家 7：「全館商品漲價 5%」
            for (long id = 1; id <= 500; id++) {
                jdbc.update("UPDATE c3_products SET price = price * 1.05, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?", id);
                try { Thread.sleep(2); } catch (InterruptedException e) { throw new RuntimeException(e); } // 每筆 2 ms：寫稽核、清快取……
            }
        });
        double sellerMs = (System.nanoTime() - s0) / 1e6;
        Thread.sleep(1000);
        stop.set(true);
        List<Long> all = new ArrayList<>();
        for (Future<List<Long>> f : buyers) all.addAll(f.get());
        pool.shutdown();
        Collections.sort(all);
        int[] timeline = new int[12];                                  // 從賣家交易開始前 0.5 秒起，每 250 ms 一格
        for (long d : doneAt) {
            int b = (int) ((d - sellerStart + 500_000_000L) / 250_000_000L);
            if (b >= 0 && b < timeline.length) timeline[b]++;
        }
        int slow = (int) all.stream().filter(v -> v > 100_000_000L).count();
        return new Result(all.get(all.size() / 2) / 1e6, all.get((int) (all.size() * 0.99)) / 1e6,
                all.get(all.size() - 1) / 1e6, all.size(), sellerMs, slow, timeline);
    }

    @Test
    void crossModuleForeignKey() throws Exception {
        System.out.println("═══ 2.2.3 跨模組外鍵：賣家批次改價 × 16 條執行緒下單 ═══");
        for (boolean fk : new boolean[]{false, true}) {
            Result r = run(fk);
            System.out.printf("%n  ── %s ──%n", fk ? "有外鍵 order_items.product_id → products.id" : "沒有跨模組外鍵");
            System.out.printf("  賣家改價交易 %,.0f ms；下單 %,d 筆：p50 %.2f ms、p99 %.2f ms、最慢 %,.0f ms；超過 100 ms 的 %,d 筆%n",
                    r.sellerTxMs, r.orders, r.p50, r.p99, r.max, r.slow);
            System.out.println("  每 250 ms 完成的下單數（▼ = 賣家交易開始，▲ = 約略結束）：");
            StringBuilder sb = new StringBuilder("   ");
            for (int i = 0; i < r.timeline.length; i++) {
                String mark = i == 2 ? "▼" : (i == 2 + (int) Math.round(r.sellerTxMs / 250) ? "▲" : " ");
                sb.append(mark).append("%4d".formatted(r.timeline[i]));
            }
            System.out.println(sb);
        }
    }
}
```

> 📌 表結構刻意簡化成三張 `c3_*` 表，只保留跟這個問題有關的欄位，而且**兩個版本唯一的差別就是那一行 `fk_c3_items_product`**。
> 兩個版本的 `product_id` 都有索引（外鍵本來就需要，MySQL 會自動建；沒外鍵的版本手動建一個），排除「索引不同」這個變數。

**輸出**：

```
═══ 2.2.3 跨模組外鍵：賣家批次改價 × 16 條執行緒下單 ═══

  ── 沒有跨模組外鍵 ──
  賣家改價交易 1,521 ms；下單 6,797 筆：p50 7.02 ms、p99 46.90 ms、最慢 139 ms；超過 100 ms 的 21 筆
  每 250 ms 完成的下單數（▼ = 賣家交易開始，▲ = 約略結束）：
     810  480▼ 484  567  455  528  547  669▲ 685  468  318  504

  ── 有外鍵 order_items.product_id → products.id ──
  賣家改價交易 1,542 ms；下單 5,318 筆：p50 6.07 ms、p99 14.76 ms、最慢 1,491 ms；超過 100 ms 的 16 筆
  每 250 ms 完成的下單數（▼ = 賣家交易開始，▲ = 約略結束）：
    1270  622▼ 284    0    0    0    0    0▲ 504  501  712  731
```

（同一台機器跑了五次。「有外鍵」的版本**五次都出現連續 5 格的 0**，最慢的一筆在 1,491～1,594 ms 之間；p99 在 14.8～71.6 ms 之間跳動。）

**先看時間軸，這是本節最重要的一行。**

```
沒有外鍵：  810  480▼ 484  567  455  528  547  669▲ 685 ...
有外鍵：   1270  622▼ 284    0    0    0    0    0▲ 504 ...
                          └──────── 1.25 秒 ────────┘
```

賣家交易開始後的第一個 250 ms，下單還有 284 筆；**接下來的 1.25 秒，16 條執行緒一筆都沒有完成**。賣家 commit 的那一刻，才一口氣恢復。

**為什麼會全部卡住，而不是只卡一部分？**

賣家的交易從商品 1 改到商品 500，**每改一個就對那一列加一把 X 鎖，一直握到 commit**：

```
t = 0.00 s  賣家鎖住商品 1
t = 0.25 s  賣家已經鎖住商品 1～100 左右
            → 任何一條下單執行緒只要抽到這 100 個商品之一，INSERT order_items 時的 S 鎖就要等
            → 那條執行緒卡住，直到賣家 commit
t = 0.50 s  鎖住 1～200；更多執行緒抽中被鎖的商品、卡住
...         每一條沒卡住的執行緒，下一筆有更高的機率抽中被鎖的商品
t ≈ 0.4 s   16 條執行緒全部卡住 → 下單量 = 0
t = 1.54 s  賣家 commit，所有鎖一起釋放
```

**卡住一條執行緒，只需要「抽中一個被鎖的商品」一次。** 而下單是一個不停重複的動作 —— 每一條執行緒遲早都會抽中。
所以結果不是「部分商品下不了單」，而是「**所有執行緒都卡在某一個被鎖的商品上，連沒被鎖的商品也下不了單**」。

**再看 p99：14.76 ms，比沒有外鍵的 46.90 ms 還低。**

這不是實驗出錯。被卡住的請求**只有 16 個**（每條執行緒卡一次，一次卡 1.3 秒左右），佔全部 5,318 筆的 **0.3%** —— 在 p99 的外面。
剩下 99.7% 的請求沒有碰到被鎖的商品，它們的延遲分布跟沒有外鍵時是同一個量級：
五次執行裡，有外鍵的 p99 在 14.8～71.6 ms 之間跳、沒有外鍵的在 18.9～46.9 ms 之間跳 —— **兩者互有高低，這個差異是雜訊**。
真正的訊號在「最慢一筆」和「時間軸上的 0」，而那 16 筆太少，推不動 p99。

在監控上，這 1.5 秒長這樣：

| 指標 | 沒有外鍵 | 有外鍵 | 你會怎麼解讀 |
|---|---|---|---|
| p50 | 7.02 ms | **6.07 ms** | 「變快了」 |
| p99 | 46.90 ms | **14.76 ms** | 「變快了」 |
| 最慢一筆 | 139 ms | **1,491 ms** | 大部分的看板不顯示這一格 |
| 總下單數（同樣 3.5 秒） | 6,797 | **5,318（−22%）** | 要跟上週同時段比才看得出來 |

**p99 會把這個事故藏起來，因為它的形狀是「少數請求等很久」而不是「所有請求慢一點」。**
0.6.6 的指標裡，能抓到它的是 `hikaricp.connections.pending`（16 條執行緒都拿著連線在等鎖）與 MySQL 的 `Innodb_row_lock_waits` —— 第 09 章會把後者加進告警。

**放回真實的量級：**

實驗只有 16 條執行緒，所以「全部卡住」的代價是 16 個請求各等 1.5 秒。
正式環境的 Tomcat 有 200 條執行緒（0.6.1 的瞬間尖峰 250 rps）：

```
賣家批次改價 1.5 秒
→ 200 條執行緒在前 0.x 秒內陸續卡在被鎖的商品上
→ 第 201 個請求開始排隊（不只是下單，連 /api/ping、商品頁都沒有執行緒可用）
→ 這 1.5 秒內，整台機器對外等同當機
```

這跟 1.2.2 的 `timeot` 是同一種結局，只是原因從「Redis 逾時 60 秒」變成了「一個看起來完全無害的外鍵」。
而且這次**你沒辦法說賣家做錯了什麼** —— 在一個交易裡批次改價是合理的（改到一半失敗，要全部回滾，不能一半漲價一半沒漲）。

**那沒有外鍵，`product_id` 的完整性誰來保護？**

| 威脅 | 外鍵能擋嗎 | 本專題怎麼擋 |
|---|---|---|
| 下單時寫了一個不存在的 `product_id` | ✅ | 下單流程**先讀商品**（要價格、要名稱快照、要檢查 `ON_SALE`）—— 不存在的商品在那一步就 404 了（第 04 章） |
| 商品被刪掉，明細變成孤兒 | ✅ | **商品不硬刪**（US-PRD-4 AC-4）。本來就沒有 `DELETE FROM products` 這件事 |
| 某個 bug 寫進錯的 `product_id` | ✅（只要那個 id 不存在） | 如果寫錯成另一個**存在的**商品，外鍵也擋不住。這一類靠對帳（2.5.5） |

**外鍵能擋的三件事，在本專題的設計裡要嘛已經被擋在前面，要嘛本來就不會發生。** 而它的代價是上面那 1.25 秒的 0。

**這一節要帶走的**：

1. **外鍵不是免費的完整性。** 子表每一次 INSERT，都要對父表那一列拿一把共享鎖、握到 commit。
2. **當父表屬於另一個模組時，這把鎖讓兩個模組的交易互相卡住** —— 賣家在商品模組裡的一個合理操作，讓訂單模組停擺。這就是 1.5.5 說的「**跨模組的外鍵，是資料庫層級的跨模組依賴**」的具體樣子。
3. **p99 看不到它。** 少數請求等很久的事故，要看最大值、看連線池的等待數、看總量跟基準比。
4. 那**同模組**的外鍵呢？`order_items.order_id → orders.id` 也會對 `orders` 加 S 鎖 —— 但那一列是**同一個交易剛剛 INSERT 的**，沒有別人會去鎖它。2.6 會把「要 / 不要」整理成一張表，並實測同模組外鍵的另一個坑（語句順序 → 死鎖）。

### 2.2.4 事故四：同樣是「批次」，一個 10 秒、一個 0.47 秒 ★★

US-RPT-1 AC-4 要求「10 萬張訂單、30 萬筆明細，查 90 天的報表 p95 < 1 秒」。要驗證它，你需要 10 萬張訂單。
第 01 章 1.11 預告過這個問題：**用 JPA 一筆一筆塞會花多久？**

「一筆一筆」當然慢，所以第一個反應是**開批次**：

```yaml
spring.jpa.properties.hibernate.jdbc.batch_size: 1000
spring.jpa.properties.hibernate.order_inserts: true
```

這一節比較四種寫法，每一種都寫 1 萬張訂單、每張 3 個品項（共 4 萬列），並用 MySQL 的 `Com_insert` 狀態變數數出**伺服器實際收到幾句 INSERT**。

實驗用的 Entity（放在 `com.example.lab.ch02.seed`，理由見 2.2.0）：

```java
package com.example.lab.ch02.seed;

import jakarta.persistence.*;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/** 主鍵用 IDENTITY（AUTO_INCREMENT）—— 本專題 0.6.7 的選擇 */
@Entity
@Table(name = "c4_orders")
public class SeedOrder {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    Long id;
    long buyerId;
    BigDecimal totalAmount;
    Instant createdAt;
    @OneToMany(mappedBy = "order", cascade = CascadeType.PERSIST)
    List<SeedOrderItem> items = new ArrayList<>();

    protected SeedOrder() {}
    public SeedOrder(long buyerId, Instant createdAt) { this.buyerId = buyerId; this.createdAt = createdAt; this.totalAmount = BigDecimal.ZERO; }
    public void add(long productId, BigDecimal price, int qty) {
        items.add(new SeedOrderItem(this, productId, price, qty));
        totalAmount = totalAmount.add(price.multiply(BigDecimal.valueOf(qty)));
    }
}
```

`SeedOrderItem` 同樣用 `IDENTITY`；另外還有一組 `AssignedOrder` / `AssignedOrderItem` 對應**同一張表**，差別只在主鍵是 `@Id Long id` —— **由程式指定，沒有 `@GeneratedValue`**。
（`SeedOrderItem`、`AssignedOrder`、`AssignedOrderItem` 的完整內容在 2.11.3。）

```java
package com.example.shop.ch02;

import com.example.lab.ch02.seed.AssignedOrder;
import com.example.lab.ch02.seed.SeedOrder;
import com.zaxxer.hikari.HikariDataSource;
import jakarta.persistence.EntityManager;
import jakarta.persistence.EntityManagerFactory;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.ImportAutoConfiguration;
import org.springframework.boot.autoconfigure.domain.EntityScan;
import org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration;
import org.springframework.boot.autoconfigure.orm.jpa.HibernateJpaAutoConfiguration;
import org.springframework.boot.autoconfigure.transaction.TransactionAutoConfiguration;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Random;

/**
 * 2.2.4 種子資料：同樣 1 萬張訂單（每張 3 個品項，共 4 萬列），四種寫法。
 */
@Tag("experiment")
class C4SeedDataTest {

    static final int ORDERS = 10_000;
    static final int ITEMS_PER_ORDER = 3;
    static final String URL = "jdbc:mysql://localhost:3306/shop_lab?useSSL=false&allowPublicKeyRetrieval=true&connectionTimeZone=UTC";

    @ImportAutoConfiguration({DataSourceAutoConfiguration.class, HibernateJpaAutoConfiguration.class, TransactionAutoConfiguration.class})
    @EntityScan(basePackageClasses = SeedOrder.class)
    static class Jpa {}

    static HikariDataSource ds(boolean rewrite) {
        HikariDataSource ds = new HikariDataSource();
        ds.setJdbcUrl(URL + (rewrite ? "&rewriteBatchedStatements=true" : ""));
        ds.setUsername("shop");
        ds.setPassword("shop");
        return ds;
    }

    static void resetTables(JdbcTemplate jdbc) {
        jdbc.execute("DROP TABLE IF EXISTS c4_order_items");
        jdbc.execute("DROP TABLE IF EXISTS c4_orders");
        jdbc.execute("""
            CREATE TABLE c4_orders (id BIGINT AUTO_INCREMENT PRIMARY KEY, buyer_id BIGINT NOT NULL,
              total_amount DECIMAL(12,2) NOT NULL, created_at DATETIME(6) NOT NULL)""");
        jdbc.execute("""
            CREATE TABLE c4_order_items (id BIGINT AUTO_INCREMENT PRIMARY KEY, order_id BIGINT NOT NULL,
              product_id BIGINT NOT NULL, unit_price DECIMAL(12,2) NOT NULL, quantity INT NOT NULL,
              CONSTRAINT fk_c4_items_order FOREIGN KEY (order_id) REFERENCES c4_orders(id))""");
    }

    /** 伺服器從啟動以來收到的 INSERT 句數；前後相減 = 這段期間收到幾句 */
    static long comInsert(JdbcTemplate jdbc) {
        return Long.parseLong(jdbc.queryForMap("SHOW GLOBAL STATUS LIKE 'Com_insert'").get("Value").toString());
    }

    static void report(String name, long ms, long statements, int orders) {
        int rows = orders * (1 + ITEMS_PER_ORDER);
        System.out.printf("  %-44s %,7d ms   %,8.0f 列/秒   伺服器收到 INSERT %,6d 句%n",
                name, ms, rows / (ms / 1000.0), statements);
    }

    @Test
    void seedFourWays() {
        System.out.printf("═══ 2.2.4 種子資料：%,d 張訂單 × %d 品項 = %,d 列 ═══%n", ORDERS, ITEMS_PER_ORDER, ORDERS * (1 + ITEMS_PER_ORDER));
        try (HikariDataSource plain = ds(false); HikariDataSource rewrite = ds(true)) {
            JdbcTemplate admin = new JdbcTemplate(plain);

            // ① JPA + IDENTITY：設了 batch_size 也沒用
            resetTables(admin);
            try (var ctx = new SpringApplicationBuilder(Jpa.class).web(WebApplicationType.NONE)
                    .run("--spring.datasource.url=" + URL + "&rewriteBatchedStatements=true",
                            "--spring.datasource.username=shop", "--spring.datasource.password=shop",
                            "--spring.jpa.hibernate.ddl-auto=none",
                            "--spring.jpa.properties.hibernate.jdbc.batch_size=1000",
                            "--spring.jpa.properties.hibernate.order_inserts=true",
                            "--spring.main.banner-mode=off", "--logging.level.root=WARN")) {
                EntityManagerFactory emf = ctx.getBean(EntityManagerFactory.class);
                long before = comInsert(admin), t0 = System.nanoTime();
                Random r = new Random(42);
                EntityManager em = emf.createEntityManager();
                em.getTransaction().begin();
                for (int i = 0; i < ORDERS; i++) {
                    SeedOrder o = new SeedOrder(1 + r.nextInt(5000), Instant.now());
                    for (int k = 0; k < ITEMS_PER_ORDER; k++) o.add(1 + r.nextInt(1000), new BigDecimal("199.00"), 1 + r.nextInt(3));
                    em.persist(o);
                    if (i % 1000 == 999) { em.flush(); em.clear(); }
                }
                em.getTransaction().commit();
                em.close();
                report("① JPA persist，IDENTITY 主鍵（batch_size=1000）", (System.nanoTime() - t0) / 1_000_000, comInsert(admin) - before, ORDERS);

                // ② JPA + 程式指定主鍵：batch 生效
                resetTables(admin);
                before = comInsert(admin);
                t0 = System.nanoTime();
                r = new Random(42);
                em = emf.createEntityManager();
                em.getTransaction().begin();
                long itemId = 1;
                for (int i = 0; i < ORDERS; i++) {
                    AssignedOrder o = new AssignedOrder(i + 1, 1 + r.nextInt(5000), Instant.now());
                    for (int k = 0; k < ITEMS_PER_ORDER; k++) o.add(itemId++, 1 + r.nextInt(1000), new BigDecimal("199.00"), 1 + r.nextInt(3));
                    em.persist(o);
                    if (i % 1000 == 999) { em.flush(); em.clear(); }
                }
                em.getTransaction().commit();
                em.close();
                report("② JPA persist，程式指定主鍵（batch_size=1000）", (System.nanoTime() - t0) / 1_000_000, comInsert(admin) - before, ORDERS);
            }

            // ③ ④ JdbcTemplate.batchUpdate，有 / 沒有 rewriteBatchedStatements
            for (boolean rw : new boolean[]{false, true}) {
                resetTables(admin);
                JdbcTemplate jdbc = new JdbcTemplate(rw ? rewrite : plain);
                TransactionTemplate tx = new TransactionTemplate(new DataSourceTransactionManager(rw ? rewrite : plain));
                long before = comInsert(admin), t0 = System.nanoTime();
                jdbcSeed(jdbc, tx, ORDERS);
                report(rw ? "④ JdbcTemplate.batchUpdate，rewrite=true" : "③ JdbcTemplate.batchUpdate，rewrite=false",
                        (System.nanoTime() - t0) / 1_000_000, comInsert(admin) - before, ORDERS);
            }

            // ⑤ 同 ④，規模放大到 10 萬張
            resetTables(admin);
            JdbcTemplate jdbc = new JdbcTemplate(rewrite);
            TransactionTemplate tx = new TransactionTemplate(new DataSourceTransactionManager(rewrite));
            long before = comInsert(admin), t0 = System.nanoTime();
            jdbcSeed(jdbc, tx, 100_000);
            report("⑤ 同 ④，10 萬張訂單（40 萬列）", (System.nanoTime() - t0) / 1_000_000, comInsert(admin) - before, 100_000);
        }
    }

    /** 每 1,000 張訂單一個交易、一次 batch */
    static void jdbcSeed(JdbcTemplate jdbc, TransactionTemplate tx, int orders) {
        Random r = new Random(42);
        long itemId = 1;
        for (int base = 0; base < orders; base += 1000) {
            List<Object[]> os = new ArrayList<>(1000), is = new ArrayList<>(3000);
            for (int i = base; i < Math.min(base + 1000, orders); i++) {
                long orderId = i + 1;
                BigDecimal total = BigDecimal.ZERO;
                long buyer = 1 + r.nextInt(5000);
                for (int k = 0; k < ITEMS_PER_ORDER; k++) {
                    int qty = 1 + r.nextInt(3);
                    BigDecimal price = new BigDecimal("199.00");
                    is.add(new Object[]{itemId++, orderId, 1 + r.nextInt(1000), price, qty});
                    total = total.add(price.multiply(BigDecimal.valueOf(qty)));
                }
                os.add(new Object[]{orderId, buyer, total, Timestamp.from(Instant.now())});
            }
            tx.executeWithoutResult(s -> {
                jdbc.batchUpdate("INSERT INTO c4_orders(id, buyer_id, total_amount, created_at) VALUES (?,?,?,?)", os);
                jdbc.batchUpdate("INSERT INTO c4_order_items(id, order_id, product_id, unit_price, quantity) VALUES (?,?,?,?,?)", is);
            });
        }
    }
}
```

**輸出**（手動對齊了欄位）：

```
═══ 2.2.4 種子資料：10,000 張訂單 × 3 品項 = 40,000 列 ═══
  ① JPA persist，IDENTITY 主鍵（batch_size=1000）   10,128 ms     3,949 列/秒   伺服器收到 INSERT 40,000 句
  ② JPA persist，程式指定主鍵（batch_size=1000）       971 ms    41,195 列/秒   伺服器收到 INSERT     40 句
  ③ JdbcTemplate.batchUpdate，rewrite=false         6,538 ms     6,118 列/秒   伺服器收到 INSERT 40,000 句
  ④ JdbcTemplate.batchUpdate，rewrite=true            470 ms    85,106 列/秒   伺服器收到 INSERT     20 句
  ⑤ 同 ④，10 萬張訂單（40 萬列）                     3,594 ms   111,297 列/秒   伺服器收到 INSERT    200 句
```

（另一次執行：① 6,977 ms、② 1,276 ms、③ 6,153 ms、④ 1,004 ms、⑤ 3,068 ms。**絕對值會跳，句數一句都不會差。**）

**最右邊那一欄，是整張表的答案。**

| | 伺服器收到的 INSERT | 為什麼 |
|---|---|---|
| ① JPA + `IDENTITY` | **40,000**（一列一句） | 見下 |
| ② JPA + 程式指定主鍵 | **40**（每次 `flush`：`c4_orders` 1,000 列 = 1 句、`c4_order_items` 3,000 列 = 3 句 × 10 次 `flush`） | `batch_size` 生效，而且 `rewriteBatchedStatements` 把一個 batch（最多 1,000 列）改寫成一句多值 INSERT |
| ③ JDBC batch，`rewrite=false` | **40,000** | JDBC 的「batch」只是**把 40,000 句 INSERT 一起送出去**，伺服器還是一句一句執行 |
| ④ JDBC batch，`rewrite=true` | **20**（10 個交易 × 2 張表） | 驅動把 1,000 列改寫成 `INSERT ... VALUES (...), (...), ...` 一句 |

**① 為什麼設了 `batch_size=1000` 還是一列一句？**

`IDENTITY` 的意思是「主鍵由資料庫的 `AUTO_INCREMENT` 產生」。Hibernate 在 `persist()` 的時候**就需要知道這個 id** ——
因為 persistence context 是用 id 當 key 來管理 Entity 的（[08-jpa-mybatis/03](../08-jpa-mybatis/03-persistence-context-and-lifecycle.md)），
而 `SeedOrderItem` 的 `order_id` 欄位也要填進父訂單的 id。

要知道 `AUTO_INCREMENT` 產生了什麼，唯一的辦法是**先把 INSERT 送出去，再讀回產生的 key**。所以 Hibernate 對 `IDENTITY` 的 Entity 會**在 `persist()` 時立刻執行 INSERT**，而且**悄悄地停用 JDBC batch** —— 不報錯、不警告。

**② 把主鍵改成程式指定，batch 就生效了。** 但這在正式程式碼裡不是一個好選項：你要自己保證 id 不重複（併發下單時誰發號？）。
MySQL 沒有 sequence，Hibernate 的替代方案 `GenerationType.TABLE` 會用一張表當計數器 —— **形狀跟 2.4.4 的「每日流水號」一樣：一列計數器，每次發號都要更新它**。
Hibernate 的 pooled optimizer（`allocationSize` 預設 50）讓它每 50 個 id 才更新一次那一列，熱點的頻率小了 50 倍；但它仍然是一列被所有寫入者搶的鎖（多個 Entity 共用同一個 generator 時，就是全站共用），而且應用程式重啟時，沒用完的那一段 id 會跳號。

**③ 和 ④ 的差別，就是 0.10.4 那個 `rewriteBatchedStatements=true`。**

同樣是 `batchUpdate`，同樣 40,000 列，**13 倍**的差距完全來自驅動有沒有改寫。
沒有改寫時，驅動把 40,000 句 INSERT 一次送出去 —— 減少了「一來一回」，但伺服器仍然要解析 40,000 句、執行 40,000 次。

**⑤ 放大到 10 萬張，吞吐反而更高**（111,297 vs 85,106 列/秒）：JIT 暖機完成、InnoDB 的 buffer pool 也熱了。10 萬張訂單 + 30 萬明細 = **3.6 秒**。

**所以本專題的種子資料這樣做**（2.8）：

1. **用 `JdbcTemplate.batchUpdate`**，不用 JPA。種子資料不需要 Entity 的任何行為（髒檢查、關聯、生命週期回呼），只需要把列寫進去。
2. **主鍵由產生器自己指定**（1, 2, 3, ...）。種子資料是在**空表**上、由**單一執行緒**寫入，自己發號沒有任何併發問題 —— 這個前提在正式程式碼裡不成立，在這裡成立。
3. **`rewriteBatchedStatements=true`**（0.10.4 就已經開了）。
4. **每 5,000 列一個交易**：交易太小 → fsync 太多次；交易太大 → undo log 膨脹、失敗時回滾很久。

> 📌 **那正式程式碼的下單呢？** 一次下單只有 1 張訂單 + 1～5 個明細，`IDENTITY` 一列一句完全沒問題 ——
> 0.11 量過，瓶頸是熱點行鎖，不是 INSERT 的句數。**`IDENTITY` 的代價只在「一次寫很多列」時才出現**：種子資料、匯入、批次作業。
> 1.2.1 的 `restockBatch()` 用 `JdbcTemplate` 而不是 JPA，也是同樣的理由。

---

## 2.3 ERD：19 張表

### 2.3.1 全貌

0.3.4 把 19 張表分給了 9 個模組。畫成圖（實線 = 同模組內的外鍵；點線 `┄┄▶` = 跨模組的邏輯參照，**只存 id、不建外鍵**）：

```
┌─ account ──────────────────┐   ┌─ catalog ───────────────────┐   ┌─ inventory ─────────────────────────┐
│ users ◀──── user_roles     │   │ categories ◀─┐ parent_id    │   │ inventory ◀──── inventory_          │
│   ▲   ◀──── refresh_tokens │   │   ▲ ─────────┘              │   │  (product_id)   reservations        │
│   │                        │   │   │ category_id             │   │   ▲   ◀──────── inventory_ledger    │
└───┼────────────────────────┘   │ products                    │   └───┼─────────────────┬───────────────┘
    │                            └───▲─────────────────────────┘       │ product_id      │ order_id
    ┆ seller_id / buyer_id ...       ┆ product_id                      ┆ ┄┄▶ products.id ┆ ┄┄▶ orders.id
    ┆                                ┆
┌─ ordering ────────────────────────────────────────────┐   ┌─ cart ──────────────────┐
│ orders ◀──── order_items         （product_id ┄┄▶ products）│   │ cart_items              │
│   ▲    ◀──── order_status_history                      │   │  buyer_id  ┄┄▶ users    │
│   ▲    ◀──── idempotency_keys   （buyer_id ┄┄▶ users）  │   │  product_id┄┄▶ products │
│  buyer_id, seller_id ┄┄▶ users                         │   └─────────────────────────┘
└───▲───────────────────────────────────────────────────┘
    ┆ order_id
┌─ payment ──────────────────┐   ┌─ notification ─────────┐   ┌─ shared ───────────────────────────┐
│ payments ◀──── refunds     │   │ notifications          │   │ outbox_events                      │
│  order_id ┄┄▶ orders       │   │  user_id ┄┄▶ users     │   │ processed_messages                 │
└────────────────────────────┘   └────────────────────────┘   │ audit_logs (actor_id ┄┄▶ users)    │
                                                               └────────────────────────────────────┘
```

**兩種線的數量**：

| | 條數 | 列表 |
|---|---|---|
| 同模組外鍵（實線） | **10** | `user_roles`→`users`、`refresh_tokens`→`users`、`categories`→`categories`、`products`→`categories`、`inventory_reservations`→`inventory`、`inventory_ledger`→`inventory`、`order_items`→`orders`、`order_status_history`→`orders`、`idempotency_keys`→`orders`、`refunds`→`payments` |
| 跨模組參照（點線） | **15** | `products.seller_id`、`inventory.product_id`、`inventory_reservations.order_id`、`cart_items.buyer_id`、`cart_items.product_id`、`orders.buyer_id`、`orders.seller_id`、`order_items.product_id`、`order_status_history.actor_id`、`idempotency_keys.buyer_id`、`payments.order_id`、`refunds.order_id`、`notifications.user_id`、`audit_logs.actor_id`、`inventory_ledger.ref`（字串 `order:123`） |

**15 條跨模組參照，0 個跨模組外鍵。** 每一條點線在 DDL 裡都有一行註解（`-- account：不建外鍵`），讓讀 schema 的人知道**這是刻意的，不是忘了**。

> 📌 注意 `inventory.product_id` 是**主鍵**，同時是指向 `products` 的跨模組參照。
> 「一個商品一列庫存」—— 庫存模組不需要自己的 id，它用商品的 id 當主鍵。這讓 `InventoryApi.available(productId)` 是一次主鍵查詢。

### 2.3.2 每個模組的 DDL

下面就是 `src/main/resources/db/migration/` 底下的 V1～V9（V10 在 2.5.4 才出現）。
每一個欄位旁邊的註解都指回它的需求；**沒有註解的欄位，是你一看就知道為什麼的欄位**。

**V1 — account**

```sql
-- account 模組：users、user_roles、refresh_tokens（0.3.4）
CREATE TABLE users (
  id             BIGINT        NOT NULL AUTO_INCREMENT,
  email          VARCHAR(254)  NOT NULL,                 -- RFC 5321 的上限；_ci 定序讓 UNIQUE 不分大小寫（US-ACC-1 AC-2）
  password_hash  VARCHAR(100)  NOT NULL,                 -- BCrypt 是 60 字元；留空間給將來換演算法
  display_name   VARCHAR(50)   NOT NULL,
  status         VARCHAR(20)   NOT NULL DEFAULT 'ACTIVE',
  created_at     DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  version        INT           NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uk_users_email (email),
  CONSTRAINT ck_users_status CHECK (status IN ('ACTIVE', 'SUSPENDED'))
);

CREATE TABLE user_roles (
  user_id     BIGINT       NOT NULL,
  role        VARCHAR(20)  NOT NULL,
  granted_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  granted_by  BIGINT       NULL,                         -- NULL = 系統（註冊時的 BUYER、啟動時建立的管理員）
  PRIMARY KEY (user_id, role),
  CONSTRAINT fk_user_roles_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT ck_user_roles_role CHECK (role IN ('BUYER', 'SELLER', 'ADMIN'))
);

CREATE TABLE refresh_tokens (
  id          BIGINT       NOT NULL AUTO_INCREMENT,
  user_id     BIGINT       NOT NULL,
  token_hash  VARCHAR(64)  NOT NULL,                     -- SHA-256 hex；資料庫不存明文（US-ACC-2 AC-1）
  expires_at  DATETIME(3)  NOT NULL,
  used_at     DATETIME(3)  NULL,                         -- rotation：用過一次就填上；再被用 = 重放（AC-5）
  revoked_at  DATETIME(3)  NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_refresh_tokens_hash (token_hash),
  KEY idx_refresh_tokens_user (user_id),
  CONSTRAINT fk_refresh_tokens_user FOREIGN KEY (user_id) REFERENCES users (id)
);
```

> 📌 **`uk_users_email` 為什麼能做到「不分大小寫」？** 因為 0.10.1 把伺服器定序設成 `utf8mb4_0900_ai_ci` —— `ci` 是 case-insensitive。
> `'Gary@Example.com'` 與 `'gary@example.com'` 在這個定序下**相等**，UNIQUE 索引會擋下第二個（2.5.2 實測）。
> 不用另外存一個 `email_lower` 欄位。但這是一個**依賴定序的行為** —— 所以它一定要有一個測試守著，不然某天有人把欄位定序改成 `utf8mb4_bin`，這條 AC 就默默失效了。

**V2 — catalog**

```sql
-- catalog 模組：categories、products（0.3.4）
CREATE TABLE categories (
  id          BIGINT       NOT NULL AUTO_INCREMENT,
  parent_id   BIGINT       NULL,
  name        VARCHAR(50)  NOT NULL,
  sort_order  INT          NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uk_categories_parent_name (parent_id, name),
  CONSTRAINT fk_categories_parent FOREIGN KEY (parent_id) REFERENCES categories (id)
);

CREATE TABLE products (
  id           BIGINT         NOT NULL AUTO_INCREMENT,
  seller_id    BIGINT         NOT NULL,                  -- account.users.id：跨模組，不建外鍵（2.2.3）
  category_id  BIGINT         NOT NULL,
  name         VARCHAR(200)   NOT NULL,
  description  TEXT           NULL,
  price        DECIMAL(12,2)  NOT NULL,
  status       VARCHAR(20)    NOT NULL DEFAULT 'DRAFT',
  hot          BOOLEAN        NOT NULL DEFAULT FALSE,    -- 熱點商品：第 06 章改走 Redis 預扣
  created_at   DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  version      INT            NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_products_status_category_price (status, category_id, price),
  KEY idx_products_seller_created (seller_id, created_at),
  CONSTRAINT fk_products_category FOREIGN KEY (category_id) REFERENCES categories (id),
  CONSTRAINT ck_products_price  CHECK (price > 0 AND price <= 1000000),
  CONSTRAINT ck_products_status CHECK (status IN ('DRAFT', 'ON_SALE', 'OFF_SHELF'))
);
```

> ⚠️ `uk_categories_parent_name` 有一個洞：兩個 `parent_id` 都是 `NULL` 的**同名頂層分類**，它擋不住。
> 這個洞是在 2.5.4 寫約束測試時才發現的 —— V10 會補上它。這裡保留原樣，因為 **V2 已經「上線」了，不能改**（2.2.2 規則一）。

**V3 — inventory**

```sql
-- inventory 模組：inventory、inventory_reservations、inventory_ledger（0.3.4）
CREATE TABLE inventory (
  product_id  BIGINT       NOT NULL,                     -- catalog.products.id：跨模組，不建外鍵
  on_hand     INT          NOT NULL,
  reserved    INT          NOT NULL DEFAULT 0,
  updated_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (product_id),
  CONSTRAINT ck_inventory_reserved CHECK (reserved >= 0 AND reserved <= on_hand)   -- INV-1
);

CREATE TABLE inventory_reservations (
  id          BIGINT       NOT NULL AUTO_INCREMENT,
  order_id    BIGINT       NOT NULL,                     -- ordering.orders.id：跨模組，不建外鍵
  product_id  BIGINT       NOT NULL,
  quantity    INT          NOT NULL,
  status      VARCHAR(20)  NOT NULL DEFAULT 'HELD',
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_reservations_order_product (order_id, product_id),                 -- INV-4
  KEY idx_reservations_product_status (product_id, status),                        -- INV-2 對帳
  CONSTRAINT fk_reservations_inventory FOREIGN KEY (product_id) REFERENCES inventory (product_id),
  CONSTRAINT ck_reservations_quantity CHECK (quantity > 0),
  CONSTRAINT ck_reservations_status CHECK (status IN ('HELD', 'CONFIRMED', 'CONSUMED', 'RELEASED'))
);

CREATE TABLE inventory_ledger (
  id              BIGINT        NOT NULL AUTO_INCREMENT,
  product_id      BIGINT        NOT NULL,
  delta_on_hand   INT           NOT NULL,
  delta_reserved  INT           NOT NULL,
  reason          VARCHAR(20)   NOT NULL,
  ref             VARCHAR(100)  NULL,                    -- 'order:123'、'import:2026-09-24.csv'……
  created_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_ledger_product (product_id, id),
  CONSTRAINT fk_ledger_inventory FOREIGN KEY (product_id) REFERENCES inventory (product_id),
  CONSTRAINT ck_ledger_reason CHECK (reason IN ('INITIAL', 'RESTOCK', 'RESERVE', 'RELEASE', 'SHIP')),
  CONSTRAINT ck_ledger_delta  CHECK (delta_on_hand <> 0 OR delta_reserved <> 0)
);
```

**第 01 章 1.11 的第一個問題：「`inventory_reservations` 需要哪些欄位才能支撐 0.5 的狀態機？」**

| 欄位 | 支撐什麼 |
|---|---|
| `order_id` + `product_id` + UNIQUE | INV-4：一張訂單對一個商品最多一筆預留 |
| `quantity` | 釋放 / 出貨時要減回多少（**不能**從訂單明細推算 —— 那是另一個模組的表） |
| `status`（4 個值） | 0.5.1 表的第三欄：`PENDING_PAYMENT`↔`HELD`、`PAID`/`PICKING`↔`CONFIRMED`、`SHIPPED`/`COMPLETED`↔`CONSUMED`、`CANCELLED`↔`RELEASED` |
| `(product_id, status)` 索引 | INV-2 對帳：`SUM(quantity) WHERE status IN ('HELD','CONFIRMED') GROUP BY product_id` |

**沒有**的欄位同樣重要：**沒有 `expires_at`**。預留逾時是「**訂單**逾時」的結果（US-ORD-3），由訂單模組的排程觸發、呼叫庫存模組釋放 ——
庫存模組自己不判斷「這筆預留該不該過期」。如果兩個模組各自有一個逾時時間，它們遲早會不一致（15 分鐘 vs 15 分 01 秒），然後出現「訂單還在待付款、預留已經被釋放」的組合 —— 那正是 US-ORD-3 AC-5 要防的。

> 📌 `inventory_ledger` 沒有 `CONFIRM` 這個 reason。0.3.5 定義 ledger 是「`onHand` 或 `reserved` 的每一次變化」，
> 而 `HELD → CONFIRMED` **兩個數字都不變**（預留還是預留，只是不能被逾時釋放了）—— 它只改 `inventory_reservations.status`。
> `ck_ledger_delta` 會擋下任何「兩個 delta 都是 0」的帳，保證每一筆帳都真的有東西變了。

**V4 — cart**

```sql
-- cart 模組：cart_items（0.3.4）
CREATE TABLE cart_items (
  buyer_id           BIGINT         NOT NULL,            -- account：不建外鍵
  product_id         BIGINT         NOT NULL,            -- catalog：不建外鍵
  quantity           INT            NOT NULL,
  unit_price_at_add  DECIMAL(12,2)  NOT NULL,            -- US-CART-2 AC-1：加入當下的單價，用來判斷 priceChanged
  added_at           DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (buyer_id, product_id),
  CONSTRAINT ck_cart_items_quantity CHECK (quantity BETWEEN 1 AND 99)
);
```

複合主鍵 `(buyer_id, product_id)` 直接表達了 US-CART-1 AC-1「若已存在則數量相加」—— 一個買家對一個商品只有一列。
第 03 章會用 `INSERT ... ON DUPLICATE KEY UPDATE quantity = quantity + ?` 實作它，**一句 SQL、沒有「先查再寫」的競態**。

「購物車最多 50 種商品」（AC-3）**不在 schema 裡** —— 它是跨列的規則，CHECK 寫不出來（2.5.4）。

**V5 — ordering**

```sql
-- ordering 模組：orders、order_items、order_status_history、idempotency_keys（0.3.4）
CREATE TABLE orders (
  id                BIGINT         NOT NULL AUTO_INCREMENT,
  order_no          VARCHAR(15)    NOT NULL,             -- yyyyMMdd-nnnnnn，對外顯示用（0.3.5）
  buyer_id          BIGINT         NOT NULL,             -- account：不建外鍵
  seller_id         BIGINT         NOT NULL,             -- account：不建外鍵；一張訂單只屬於一位賣家（0.3.5）
  status            VARCHAR(20)    NOT NULL,
  total_amount      DECIMAL(12,2)  NOT NULL,
  payment_deadline  DATETIME(3)    NOT NULL,
  cancel_reason     VARCHAR(30)    NULL,
  carrier           VARCHAR(30)    NULL,
  tracking_no       VARCHAR(50)    NULL,
  paid_at           DATETIME(3)    NULL,
  shipped_at        DATETIME(3)    NULL,
  completed_at      DATETIME(3)    NULL,
  cancelled_at      DATETIME(3)    NULL,
  created_at        DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  version           INT            NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uk_orders_order_no (order_no),
  KEY idx_orders_buyer_created (buyer_id, created_at),           -- US-ORD-5 AC-1：我的訂單
  KEY idx_orders_seller_created (seller_id, created_at),         -- US-ORD-5 AC-5、US-RPT-1
  KEY idx_orders_status_deadline (status, payment_deadline),     -- US-ORD-3：逾時掃描
  KEY idx_orders_status_shipped (status, shipped_at),            -- US-ORD-6 AC-4：7 天自動完成
  CONSTRAINT ck_orders_status CHECK (status IN
      ('PENDING_PAYMENT', 'PAID', 'PICKING', 'SHIPPED', 'COMPLETED', 'CANCELLED')),
  CONSTRAINT ck_orders_total CHECK (total_amount >= 0),
  CONSTRAINT ck_orders_cancel_reason CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL)),
  CONSTRAINT ck_orders_cancel_reason_values CHECK (cancel_reason IN
      ('BUYER', 'PAYMENT_TIMEOUT', 'SELLER_OUT_OF_STOCK', 'SELLER_OTHER')),
  CONSTRAINT ck_orders_paid CHECK (status NOT IN ('PAID', 'PICKING', 'SHIPPED', 'COMPLETED') OR paid_at IS NOT NULL),
  CONSTRAINT ck_orders_shipment CHECK (status NOT IN ('SHIPPED', 'COMPLETED')
      OR (tracking_no IS NOT NULL AND carrier IS NOT NULL AND shipped_at IS NOT NULL))
);

CREATE TABLE order_items (
  id            BIGINT         NOT NULL AUTO_INCREMENT,
  order_id      BIGINT         NOT NULL,
  product_id    BIGINT         NOT NULL,                 -- catalog：不建外鍵（2.2.3）
  product_name  VARCHAR(200)   NOT NULL,                 -- 下單當下的快照（1.5.5）
  unit_price    DECIMAL(12,2)  NOT NULL,                 -- 價格快照（0.3.5）
  quantity      INT            NOT NULL,
  line_amount   DECIMAL(12,2)  AS (unit_price * quantity) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uk_order_items_order_product (order_id, product_id),
  KEY idx_order_items_product (product_id),
  CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders (id),
  CONSTRAINT ck_order_items_quantity CHECK (quantity BETWEEN 1 AND 99),
  CONSTRAINT ck_order_items_price CHECK (unit_price > 0)
);

CREATE TABLE order_status_history (
  id           BIGINT       NOT NULL AUTO_INCREMENT,
  order_id     BIGINT       NOT NULL,
  from_status  VARCHAR(20)  NULL,                        -- NULL = 建立
  to_status    VARCHAR(20)  NOT NULL,
  event        VARCHAR(30)  NOT NULL,                    -- PLACE_ORDER、PAY_SUCCEEDED……（0.5.2）
  actor_type   VARCHAR(20)  NOT NULL,
  actor_id     BIGINT       NULL,
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_history_order (order_id, id),
  CONSTRAINT fk_history_order FOREIGN KEY (order_id) REFERENCES orders (id),
  CONSTRAINT ck_history_actor CHECK (actor_type IN ('BUYER', 'SELLER', 'ADMIN', 'SYSTEM', 'PAYMENT_PROVIDER'))
);

CREATE TABLE idempotency_keys (
  buyer_id      BIGINT       NOT NULL,                   -- 冪等鍵的範圍是「每位買家」（US-ORD-1a AC-5）
  idem_key      VARCHAR(64)  NOT NULL,
  request_hash  VARCHAR(64)  NOT NULL,                   -- body 的 SHA-256：同鍵不同 body → 422（AC-2）
  order_id      BIGINT       NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at    DATETIME(3)  NOT NULL,                   -- 24 小時（AC-6）
  PRIMARY KEY (buyer_id, idem_key),
  KEY idx_idem_expires (expires_at),
  CONSTRAINT fk_idem_order FOREIGN KEY (order_id) REFERENCES orders (id)
);
```

**第 01 章 1.11 的第二個問題：「`orders` 的 `version` 欄位是給誰用的？」**

0.5.5 的硬規則：狀態轉移一律用 `UPDATE orders SET status = :to, version = version + 1 WHERE id = :id AND status = :from`。
`WHERE status = :from` 已經足以防止兩個轉移同時成功（US-ORD-3 AC-5），那 `version` 多保護了什麼？

**它保護的是「不改狀態的修改」。** 例如賣家在 `PICKING` 時填物流單號、又改了一次；或者第 04 章的 JPA 版本用 `@Version` 做樂觀鎖。
那些修改的 `WHERE` 裡沒有狀態可以比對，`version` 讓「我讀到的是第 3 版，寫回去時它還是第 3 版嗎？」有一個答案。
第 04 章會同時實作兩種寫法，並用 `CountDownLatch` 讓它們在同一瞬間撞上去。

> 📌 那 `inventory` 為什麼**沒有** `version`？因為庫存的每一次修改都是**相對的**（`reserved = reserved + ?`）、**帶條件的**（`WHERE on_hand - reserved >= ?`）。
> 條件式 UPDATE 本身就是原子的「讀 + 判斷 + 寫」，不需要樂觀鎖。第 04 章會把「用 `@Version` 扣庫存」當成四種寫法之一，量給你看它在搶購時有多差。

**V6～V8 — payment、notification、shared**

```sql
-- payment 模組：payments、refunds（0.3.4）
CREATE TABLE payments (
  id               BIGINT         NOT NULL AUTO_INCREMENT,
  order_id         BIGINT         NOT NULL,              -- ordering：不建外鍵
  amount           DECIMAL(12,2)  NOT NULL,
  status           VARCHAR(20)    NOT NULL DEFAULT 'PENDING',
  provider         VARCHAR(20)    NOT NULL,
  provider_txn_id  VARCHAR(64)    NULL,                  -- 回呼的冪等鍵（0.3.5）；建立付款時還沒有，所以可為 NULL
  failure_reason   VARCHAR(200)   NULL,
  created_at       DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  version          INT            NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uk_payments_provider_txn (provider, provider_txn_id),
  KEY idx_payments_order (order_id),
  CONSTRAINT ck_payments_status CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED')),
  CONSTRAINT ck_payments_amount CHECK (amount > 0)
);

CREATE TABLE refunds (
  id                  BIGINT         NOT NULL AUTO_INCREMENT,
  payment_id          BIGINT         NOT NULL,
  order_id            BIGINT         NOT NULL,           -- 冗餘一份，報表不用 JOIN payments
  amount              DECIMAL(12,2)  NOT NULL,
  reason              VARCHAR(30)    NOT NULL,
  status              VARCHAR(20)    NOT NULL DEFAULT 'PENDING',
  attempts            INT            NOT NULL DEFAULT 0,
  provider_refund_id  VARCHAR(64)    NULL,
  created_at          DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_refunds_payment (payment_id),            -- 本專題只做全額退款：一筆付款最多一筆退款
  KEY idx_refunds_status (status, created_at),
  KEY idx_refunds_order (order_id),
  CONSTRAINT fk_refunds_payment FOREIGN KEY (payment_id) REFERENCES payments (id),
  CONSTRAINT ck_refunds_reason CHECK (reason IN ('BUYER_CANCEL', 'SELLER_CANCEL', 'LATE_PAYMENT', 'DUPLICATE_PAYMENT')),
  CONSTRAINT ck_refunds_status CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED'))
);
```

```sql
-- notification 模組：notifications（0.3.4）
CREATE TABLE notifications (
  id          BIGINT        NOT NULL AUTO_INCREMENT,
  user_id     BIGINT        NOT NULL,
  type        VARCHAR(30)   NOT NULL,
  dedup_key   VARCHAR(100)  NOT NULL,                    -- 事件 id + 通知類型：同一事件只通知一次（US-NTF-1 AC-3）
  payload     JSON          NOT NULL,
  status      VARCHAR(20)   NOT NULL DEFAULT 'PENDING',
  attempts    INT           NOT NULL DEFAULT 0,
  created_at  DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  sent_at     DATETIME(3)   NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_notifications_dedup (dedup_key),
  KEY idx_notifications_user (user_id, created_at),
  CONSTRAINT ck_notifications_status CHECK (status IN ('PENDING', 'SENT', 'FAILED'))
);
```

```sql
-- shared：outbox_events、processed_messages、audit_logs（0.3.4）
CREATE TABLE outbox_events (
  id              BIGINT       NOT NULL AUTO_INCREMENT,
  event_id        VARCHAR(36)  NOT NULL,                 -- UUID：消費端冪等用（第 07 章）
  aggregate_type  VARCHAR(30)  NOT NULL,
  aggregate_id    BIGINT       NOT NULL,
  event_type      VARCHAR(50)  NOT NULL,
  payload         JSON         NOT NULL,
  trace_id        VARCHAR(32)  NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  published_at    DATETIME(3)  NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_outbox_event_id (event_id),
  KEY idx_outbox_unpublished (published_at, id)
);

CREATE TABLE processed_messages (
  consumer      VARCHAR(50)  NOT NULL,
  message_id    VARCHAR(36)  NOT NULL,
  processed_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (consumer, message_id),
  KEY idx_processed_at (processed_at)
);

CREATE TABLE audit_logs (
  id           BIGINT       NOT NULL AUTO_INCREMENT,
  actor_id     BIGINT       NULL,
  actor_role   VARCHAR(20)  NULL,
  action       VARCHAR(50)  NOT NULL,
  target_type  VARCHAR(30)  NULL,
  target_id    VARCHAR(64)  NULL,
  detail       JSON         NULL,
  ip           VARCHAR(45)  NULL,                        -- IPv6 文字表示的最大長度
  trace_id     VARCHAR(32)  NULL,
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_audit_actor (actor_id, created_at),
  KEY idx_audit_action (action, created_at)
);
```

> 📌 **第 07 章才用得到的表（`outbox_events`、`processed_messages`、`notifications`）為什麼現在就建？**
> 兩個理由。第一，**ERD 要一次畫完才看得出關係** —— 例如 `notifications.dedup_key` 與 `processed_messages` 是兩層冪等（通知層與訊息層），分開設計很容易重複或遺漏。
> 第二，它們是**純新增的表**，現在建和第 07 章建的風險一樣低。
> 但**欄位會變** —— 第 07 章很可能會發現 `outbox_events` 少了一個欄位。那時候寫 V11，這正是 migration 存在的意義。

**V9 — 參考資料**

```sql
-- 參考資料：商品分類。正式環境也需要，所以放在 versioned migration（2.8.1）
INSERT INTO categories (id, parent_id, name, sort_order) VALUES
  (1,  NULL, '3C 家電', 10),
  (2,  NULL, '服飾',    20),
  (3,  NULL, '居家生活', 30),
  (4,  NULL, '美妝保養', 40),
  (5,  NULL, '食品',    50),
  (11, 1,    '耳機',    10),
  (12, 1,    '手機配件', 20),
  (13, 1,    '電腦周邊', 30),
  (21, 2,    '男裝',    10),
  (22, 2,    '女裝',    20),
  (23, 2,    '鞋類',    30),
  (31, 3,    '廚房用品', 10),
  (32, 3,    '寢具',    20),
  (41, 4,    '保養',    10),
  (42, 4,    '彩妝',    20),
  (51, 5,    '零食',    10),
  (52, 5,    '飲品',    20);
```

---

## 2.4 欄位設計的規則

### 2.4.1 五類欄位的型別

| 類別 | 本專題的型別 | 為什麼不是別的 |
|---|---|---|
| **金額** | `DECIMAL(12,2)` ↔ Java `BigDecimal` | `DOUBLE` 會讓 `0.1 + 0.2 = 0.30000000000000004`，對帳差幾分錢（0.6.7）。**12 位**：單價上限 100 萬 × 數量 99 × 購物車 50 項 = 49.5 億，`DECIMAL(12,2)` 的上限是 99.9 億 |
| **時間** | `DATETIME(3)`，存 **UTC** ↔ Java `Instant` | 見 2.4.3。`(3)` 是毫秒：前端的 `Date` 是毫秒，`Instant` 的奈秒在這裡被截掉是可以接受的 |
| **狀態** | `VARCHAR(20)` + `CHECK (status IN (...))` ↔ Java `enum` | 見下 |
| **主鍵** | `BIGINT AUTO_INCREMENT` | `INT` 的上限 21 億，庫存帳三年 5,000 萬筆（0.6.1）還夠，但 `BIGINT` 只多 4 bytes，**永遠不用擔心**。UUID 當主鍵會讓 InnoDB 的叢集索引隨機插入（[07-mysql/03](../07-mysql/03-index-and-explain.md)） |
| **對外編號** | 獨立欄位 `order_no VARCHAR(15)` + UNIQUE | 見 2.4.4 |

**狀態為什麼不用 MySQL 的 `ENUM`？** 2.2.1 已經看過一個理由（Hibernate + `ddl-auto=update`），但就算不用 `ddl-auto`，還有三個：

| | `ENUM('A','B')` | `VARCHAR(20)` + `CHECK` |
|---|---|---|
| 寫入不在清單內的值 | 嚴格模式：`Data truncated`（訊息誤導）；**非嚴格模式：默默存成 `''`** | 永遠是 `Check constraint 'ck_...' is violated`（2.5.2 實測），訊息指名道姓 |
| `ORDER BY status` | 依**宣告順序**排序（`'PAID' < 'CANCELLED'` 如果它先宣告） | 依字母排序 —— 跟 Java 的 `enum.name()` 比較一致 |
| 新增一個值 | `ALTER TABLE ... MODIFY COLUMN` 重寫整個清單；加在清單**尾端**、而且儲存大小不變時，MySQL 8 可以 `ALGORITHM=INSTANT` | `ALTER TABLE ... DROP CHECK`、`ADD CONSTRAINT` —— **一樣要重寫整個 `IN (...)` 清單**；`ADD` 時要掃描既有資料、重建整張表（2.9.6 ⑤：10 萬列 1,411 ms） |

兩者**都需要一個 migration** 才能新增狀態 —— 這是好事：「多一個狀態」是 0.5 的狀態機要改的事，它**應該**是一個被審查的變更。
單看「新增一個值」的成本，**ENUM 反而比較便宜**。本專題仍然選 `VARCHAR` + `CHECK`，理由是錯誤訊息的品質，以及「非嚴格模式下默默寫壞」這個風險。

**字串長度**不是隨便寫的：`email` 254（RFC 5321）、`ip` 45（IPv6 最長的文字表示）、`order_no` 15（`yyyyMMdd-nnnnnn`）、`token_hash` 64（SHA-256 的 hex）。
**寫不出理由的長度，就寫 `VARCHAR(200)` 並在 Bean Validation 上用 `@Size` 限制** —— 讓真正的限制在應用程式裡、有錯誤訊息，資料庫只當最後的保險。

### 2.4.2 Entity 對應，以及 `validate` 看不到的東西

本章建的 Entity 只有**對應**，沒有行為（行為在第 03、04 章）。以 `Product` 與 `Order` 為例：

```java
package com.example.shop.catalog.internal;

import com.example.shop.catalog.ProductStatus;
import jakarta.persistence.*;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.math.BigDecimal;
import java.time.Instant;

@Entity
@Table(name = "products")
class Product {

    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private long sellerId;                         // 跨模組：只存 id（1.5.5）

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "category_id")
    private Category category;                     // 同模組：可以用關聯

    @Column(nullable = false, length = 200)
    private String name;

    @Column(columnDefinition = "text")
    private String description;

    @Column(nullable = false, precision = 12, scale = 2)
    private BigDecimal price;

    @Enumerated(EnumType.STRING)
    @JdbcTypeCode(SqlTypes.VARCHAR)                // 2.4.2：不加這行，validate 會要求 MySQL 的 enum 型別
    @Column(nullable = false, length = 20)
    private ProductStatus status;

    @Column(nullable = false)
    private boolean hot;

    @Column(nullable = false, updatable = false)
    private Instant createdAt;

    @Column(nullable = false)
    private Instant updatedAt;

    @Version
    private int version;

    protected Product() {}

    Long getId() { return id; }
    long getSellerId() { return sellerId; }
    Category getCategory() { return category; }
    String getName() { return name; }
    String getDescription() { return description; }
    BigDecimal getPrice() { return price; }
    ProductStatus getStatus() { return status; }
    boolean isHot() { return hot; }
    Instant getCreatedAt() { return createdAt; }
    Instant getUpdatedAt() { return updatedAt; }
}
```

```java
package com.example.shop.ordering.internal;

import com.example.shop.ordering.OrderStatus;
import jakarta.persistence.*;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

@Entity
@Table(name = "orders")                            // ORDER 是 SQL 保留字：表名用複數
class Order {

    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, length = 15, updatable = false)
    private String orderNo;

    @Column(nullable = false, updatable = false)
    private long buyerId;

    @Column(nullable = false, updatable = false)
    private long sellerId;

    @Enumerated(EnumType.STRING)
    @JdbcTypeCode(SqlTypes.VARCHAR)
    @Column(nullable = false, length = 20)
    private OrderStatus status;

    @Column(nullable = false, precision = 12, scale = 2, updatable = false)
    private BigDecimal totalAmount;

    @Column(nullable = false)
    private Instant paymentDeadline;

    @Column(length = 30)
    private String cancelReason;

    @Column(length = 30)
    private String carrier;

    @Column(length = 50)
    private String trackingNo;

    private Instant paidAt;
    private Instant shippedAt;
    private Instant completedAt;
    private Instant cancelledAt;

    @Column(nullable = false, updatable = false)
    private Instant createdAt;

    @Column(nullable = false)
    private Instant updatedAt;

    @Version
    private int version;

    @OneToMany(mappedBy = "order", cascade = CascadeType.PERSIST)
    @OrderBy("id")
    private List<OrderItem> items = new ArrayList<>();   // 同一個模組、同一個聚合：可以用關聯

    protected Order() {}

    Long getId() { return id; }
    String getOrderNo() { return orderNo; }
    long getBuyerId() { return buyerId; }
    long getSellerId() { return sellerId; }
    OrderStatus getStatus() { return status; }
    BigDecimal getTotalAmount() { return totalAmount; }
    Instant getPaymentDeadline() { return paymentDeadline; }
    Instant getCreatedAt() { return createdAt; }
    List<OrderItem> getItems() { return items; }
}
```

其他四個 Entity（`Category`、`Inventory`、`Reservation`、`OrderItem`）形狀一樣；它們與三個 enum（`ProductStatus`、`OrderStatus`、`ReservationStatus`）的完整內容在 2.11.3。
`EntitySchemaDriftTest` 後面的「50 個欄位」，就是這 6 個 Entity 的欄位數，所以要照 2.11.3 一個欄位都不差地寫。幾個對應上的決定：

| 決定 | 理由 |
|---|---|
| 類別是 **package-private**，放在 `internal` | 1.4.3：別的模組在編譯期就看不到 Entity |
| `ProductStatus`、`OrderStatus` 放在模組**根套件**（`public`） | 它們會出現在模組的公開 API 裡（第 03 章查詢訂單時要回傳狀態）；`ReservationStatus` 不會，所以留在 `internal` |
| **同模組**用 `@ManyToOne`（`Product.category`、`OrderItem.order`），**跨模組**只存 `long`（`sellerId`、`productId`） | 1.5.5 的四個理由 |
| `OrderItem.lineAmount` 是 `insertable = false, updatable = false` | 它是資料庫的產生欄位（2.4.5），Hibernate 寫它會被 MySQL 拒絕 |
| `Order` 沒有 setter | 狀態只能透過第 04 章的狀態機方法改變 —— 0.2.2 版本一的 `pay() { paid = true; }` 不會在這裡出現 |

> ⚠️ **沒有 `@JdbcTypeCode(SqlTypes.VARCHAR)` 會怎樣？** 把 `Product.status` 上那一行拿掉，啟動：
>
> ```
> Schema-validation: wrong column type encountered in column [status] in table [products];
>   found [varchar (Types#VARCHAR)], but expecting [enum ('draft','on_sale','off_shelf') (Types#ENUM)]
> ```
>
> 這就是 2.2.1 最後那個 📌：Hibernate 6.2 起，MySQL 上的 `@Enumerated(STRING)` 預設對應成原生 `enum`，而我們的 schema 是 `VARCHAR`。
> Hibernate 6.4 **沒有全域設定**可以改這個預設，所以每個 enum 欄位都要加。漏加的會在啟動時被 `validate` 抓到（這一條它抓得到），不會溜進正式環境。

**`ddl-auto=validate` 到底檢查什麼？** 實測：同一個 Entity，對 12 種「跟它不一致」的表各啟動一次。

```java
package com.example.lab.ch02.v3;

import jakarta.persistence.*;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.math.BigDecimal;
import java.time.Instant;

@Entity
@Table(name = "lab_orders")
public class LabOrder {
    public enum Status { PENDING_PAYMENT, PAID, CANCELLED }

    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    Long id;
    @Column(nullable = false, length = 15)
    String orderNo;
    @Enumerated(EnumType.STRING)
    @JdbcTypeCode(SqlTypes.VARCHAR)
    @Column(nullable = false, length = 20)
    Status status;
    @Column(nullable = false, precision = 12, scale = 2)
    BigDecimal totalAmount;
    @Column(nullable = false)
    Instant createdAt;
}
```

```java
package com.example.shop.ch02;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.ImportAutoConfiguration;
import org.springframework.boot.autoconfigure.domain.EntityScan;
import org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration;
import org.springframework.boot.autoconfigure.orm.jpa.HibernateJpaAutoConfiguration;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

/**
 * 2.4.2 ddl-auto=validate 看得到什麼、看不到什麼：
 * 同一個 Entity（com.example.lab.ch02.v3.LabOrder），對 12 種「跟它不一致」的表各啟動一次。
 */
@Tag("experiment")
class C9ValidateBlindSpotsTest {

    @ImportAutoConfiguration({DataSourceAutoConfiguration.class, HibernateJpaAutoConfiguration.class})
    @EntityScan(basePackageClasses = com.example.lab.ch02.v3.LabOrder.class)
    static class App {}

    static final JdbcTemplate LAB = new JdbcTemplate(new DriverManagerDataSource(
            "jdbc:mysql://localhost:3306/shop_lab?useSSL=false&allowPublicKeyRetrieval=true", "shop", "shop"));

    /** 與 Entity 完全一致的表 */
    static final String OK = """
            CREATE TABLE lab_orders (id BIGINT AUTO_INCREMENT PRIMARY KEY, order_no VARCHAR(15) NOT NULL,
              status VARCHAR(20) NOT NULL, total_amount DECIMAL(12,2) NOT NULL, created_at DATETIME(3) NOT NULL)""";

    static void validate(String label, String ddl) {
        LAB.execute("DROP TABLE IF EXISTS lab_orders");
        LAB.execute(ddl);
        try (var ctx = new SpringApplicationBuilder(App.class).web(WebApplicationType.NONE).run(
                "--spring.datasource.url=jdbc:mysql://localhost:3306/shop_lab?useSSL=false&allowPublicKeyRetrieval=true&connectionTimeZone=UTC",
                "--spring.jpa.hibernate.ddl-auto=validate", "--spring.main.banner-mode=off", "--logging.level.root=OFF")) {
            System.out.printf("  %-34s ✓ 啟動成功%n", label);
        } catch (Exception e) {
            Throwable t = e;
            String msg = e.getMessage();
            while (t != null) { if (t.getClass().getSimpleName().equals("SchemaManagementException")) msg = t.getMessage(); t = t.getCause(); }
            System.out.printf("  %-34s ✗ %s%n", label, msg.replace("Schema-validation: ", ""));
        }
    }

    static void variant(String label, String from, String to) { validate(label, OK.replace(from, to)); }

    @Test
    void validateBlindSpots() {
        System.out.println("═══ 2.4.2 ddl-auto=validate 看得到什麼 ═══");
        validate("基準：與 Entity 完全一致", OK);
        variant("① id 是 INT", "id BIGINT", "id INT");
        variant("② total_amount 是 DOUBLE", "DECIMAL(12,2)", "DOUBLE");
        variant("③ total_amount 是 VARCHAR", "total_amount DECIMAL(12,2)", "total_amount VARCHAR(20)");
        variant("④ order_no 是 CHAR(15)", "VARCHAR(15)", "CHAR(15)");
        variant("⑤ created_at 是 DATE", "created_at DATETIME(3)", "created_at DATE");
        variant("⑥ status 是 INT", "status VARCHAR(20)", "status INT");
        variant("⑦ 少了 total_amount 欄位", "total_amount DECIMAL(12,2) NOT NULL,", "");
        variant("⑧ total_amount 是 DECIMAL(5,0)", "DECIMAL(12,2)", "DECIMAL(5,0)");
        variant("⑨ order_no 只有 VARCHAR(3)、可為 NULL", "order_no VARCHAR(15) NOT NULL", "order_no VARCHAR(3) NULL");
        variant("⑩ created_at 是 TIMESTAMP(3)", "DATETIME(3)", "TIMESTAMP(3)");
        variant("⑪ 多了一個 NOT NULL 欄位", "created_at DATETIME(3) NOT NULL)", "created_at DATETIME(3) NOT NULL, seller_id BIGINT NOT NULL)");
        variant("⑫ 多了 UNIQUE、索引、CHECK", "created_at DATETIME(3) NOT NULL)",
                "created_at DATETIME(3) NOT NULL, UNIQUE KEY uk(order_no), KEY k(status, created_at), CHECK (total_amount >= 0))");
    }
}
```

**輸出**（`in table [lab_orders]` 已省略）：

```
═══ 2.4.2 ddl-auto=validate 看得到什麼 ═══
  基準：與 Entity 完全一致                  ✓ 啟動成功
  ① id 是 INT                              ✗ wrong column type encountered in column [id]; found [int (Types#INTEGER)], but expecting [bigint (Types#BIGINT)]
  ② total_amount 是 DOUBLE                 ✗ wrong column type encountered in column [total_amount]; found [double (Types#DOUBLE)], but expecting [decimal(12,2) (Types#NUMERIC)]
  ③ total_amount 是 VARCHAR                ✗ wrong column type encountered in column [total_amount]; found [varchar (Types#VARCHAR)], but expecting [decimal(12,2) (Types#NUMERIC)]
  ④ order_no 是 CHAR(15)                   ✗ wrong column type encountered in column [order_no]; found [char (Types#CHAR)], but expecting [varchar(15) (Types#VARCHAR)]
  ⑤ created_at 是 DATE                     ✗ wrong column type encountered in column [created_at]; found [date (Types#DATE)], but expecting [datetime(6) (Types#TIMESTAMP_UTC)]
  ⑥ status 是 INT                          ✗ wrong column type encountered in column [status]; found [int (Types#INTEGER)], but expecting [varchar(20) (Types#VARCHAR)]
  ⑦ 少了 total_amount 欄位                  ✗ missing column [total_amount]
  ⑧ total_amount 是 DECIMAL(5,0)           ✓ 啟動成功
  ⑨ order_no 只有 VARCHAR(3)、可為 NULL     ✓ 啟動成功
  ⑩ created_at 是 TIMESTAMP(3)             ✓ 啟動成功
  ⑪ 多了一個 NOT NULL 欄位                  ✓ 啟動成功
  ⑫ 多了 UNIQUE、索引、CHECK                ✓ 啟動成功
```

**規則很清楚：`validate` 比對的是「欄位存不存在」與「JDBC 型別家族」（`Types#BIGINT`、`Types#NUMERIC`……），其他什麼都不看。**

| `validate` 抓得到（7 種） | `validate` 抓不到（5 種） | 抓不到的後果 |
|---|---|---|
| ① `INT` vs `BIGINT` | ⑧ `DECIMAL(5,0)` vs `(12,2)` | **99.99 被存成 100、100000 存不進去** —— 精度與小數位數不看 |
| ② `DOUBLE` vs `DECIMAL` | ⑨ `VARCHAR(3)`、可為 `NULL` | **長度與 NOT NULL 不看**：寫第一筆就 `Data too long`；Entity 以為不會是 `null` 的欄位，資料庫允許 |
| ③ `VARCHAR` vs `DECIMAL` | ⑩ `TIMESTAMP` vs `DATETIME` | 同一個型別家族。`TIMESTAMP` 會做 session 時區轉換、2038 年溢位（2.4.3） |
| ④ `CHAR` vs `VARCHAR` | ⑪ Entity 沒對應到的 `NOT NULL` 欄位 | **每一次 INSERT 都失敗**（Hibernate 不知道那個欄位存在，不會寫它） |
| ⑤ `DATE` vs `DATETIME` | ⑫ UNIQUE、索引、CHECK | 約束與索引**完全不看** |
| ⑥ `INT` vs `VARCHAR` | | |
| ⑦ 缺欄位 | | |

⑪ 是最陰險的一個：啟動成功、所有查詢都正常，**只有 INSERT 會失敗**，而且是在某個使用者第一次下單的時候。

**所以本專題有兩個測試補上 `validate` 看不到的部分**：

- **⑫ 約束與索引** → 驗收 Q6（2.10）：從空資料庫建出來之後，逐一確認 migration 裡宣告的每一個 CHECK 與索引都存在。
- **⑧ ⑨ 精度、長度、NOT NULL** → `EntitySchemaDriftTest`：把每個 Entity 欄位上的宣告，跟 `information_schema.columns` 逐欄比對。

```java
package com.example.shop.schema;

import jakarta.persistence.*;
import jakarta.persistence.metamodel.EntityType;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.math.BigDecimal;
import java.util.*;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 2.4.2：ddl-auto=validate 只比對「型別家族」。它看不到 NOT NULL、VARCHAR 長度、DECIMAL 精度。
 * 這個測試把 Entity 上的宣告跟 information_schema 逐欄比對，補上那一塊。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE)
class EntitySchemaDriftTest {

    @Autowired EntityManagerFactory emf;
    @Autowired JdbcTemplate jdbc;

    record DbColumn(boolean nullable, Long length, Integer precision, Integer scale, boolean hasDefault, boolean generated) {}

    Map<String, DbColumn> columnsOf(String table) {
        Map<String, DbColumn> m = new HashMap<>();
        jdbc.query("""
                SELECT column_name, is_nullable, character_maximum_length, numeric_precision, numeric_scale,
                       column_default, extra, data_type
                  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?""",
                rs -> {
                    String extra = rs.getString("extra");
                    m.put(rs.getString("column_name"), new DbColumn(
                            "YES".equals(rs.getString("is_nullable")),
                            rs.getString("data_type").endsWith("text") ? null : (Long) rs.getObject("character_maximum_length", Long.class),
                            (Integer) rs.getObject("numeric_precision", Integer.class),
                            (Integer) rs.getObject("numeric_scale", Integer.class),
                            rs.getString("column_default") != null || extra.contains("auto_increment"),
                            extra.contains("GENERATED")));
                }, table);
        return m;
    }

    static String snake(String camel) { return camel.replaceAll("([a-z0-9])([A-Z])", "$1_$2").toLowerCase(Locale.ROOT); }

    @Test
    void entityDeclarationsMatchTheSchema() {
        List<String> drift = new ArrayList<>();
        int checked = 0;
        for (EntityType<?> et : emf.getMetamodel().getEntities()) {
            Class<?> type = et.getJavaType();
            String table = type.getAnnotation(Table.class).name();
            Map<String, DbColumn> db = columnsOf(table);
            for (Field f : type.getDeclaredFields()) {
                if (Modifier.isStatic(f.getModifiers()) || f.isAnnotationPresent(Transient.class)
                        || f.isAnnotationPresent(OneToMany.class) || f.isAnnotationPresent(ManyToMany.class)) continue;
                Column col = f.getAnnotation(Column.class);
                JoinColumn jc = f.getAnnotation(JoinColumn.class);
                String name = col != null && !col.name().isEmpty() ? col.name() : jc != null && !jc.name().isEmpty() ? jc.name() : snake(f.getName());
                DbColumn c = db.get(name);
                if (c == null) continue;                                     // 缺欄位：validate 會抓，這裡不重複
                checked++;
                String where = "%s.%s（%s.%s）".formatted(type.getSimpleName(), f.getName(), table, name);
                if (col != null && !col.insertable()) continue;               // 唯讀 / 產生欄位
                boolean entityNotNull = f.getType().isPrimitive() || f.isAnnotationPresent(Id.class) || f.isAnnotationPresent(Version.class)
                        || (col != null && !col.nullable())
                        || (f.isAnnotationPresent(ManyToOne.class) && !f.getAnnotation(ManyToOne.class).optional());
                if (!entityNotNull && !c.nullable() && !c.hasDefault())
                    drift.add(where + "：Entity 允許 null，資料庫是 NOT NULL 而且沒有預設值 → 存一個 null 就是執行期錯誤");
                if (entityNotNull && c.nullable())
                    drift.add(where + "：Entity 當它不會是 null，資料庫卻允許 NULL → 別的路徑寫進 NULL 時，讀回來就炸");
                if (f.getType() == String.class && c.length() != null) {
                    int len = col == null ? 255 : col.length();
                    if (col != null && !col.columnDefinition().isEmpty()) continue;
                    if (len != c.length()) drift.add(where + "：Entity length=%d，資料庫 VARCHAR(%d)".formatted(len, c.length()));
                }
                if (f.getType() == BigDecimal.class && c.precision() != null) {
                    int p = col == null ? 0 : col.precision(), s = col == null ? 0 : col.scale();
                    if (p == 0)
                        drift.add(where + "：Entity 沒寫 precision / scale（Hibernate 會當成 DECIMAL(38,2)），資料庫 DECIMAL(%d,%d)".formatted(c.precision(), c.scale()));
                    else if (p != c.precision() || s != c.scale())
                        drift.add(where + "：Entity DECIMAL(%d,%d)，資料庫 DECIMAL(%d,%d)".formatted(p, s, c.precision(), c.scale()));
                }
            }
        }
        System.out.printf("比對了 %d 個 Entity、%d 個欄位%n", emf.getMetamodel().getEntities().size(), checked);
        drift.forEach(d -> System.out.println("  ✗ " + d));
        assertThat(drift).isEmpty();
    }
}
```

現在的 6 個 Entity 全部通過：

```
比對了 6 個 Entity、50 個欄位
```

**故意弄壞三個地方**：`Product.name` 的 `length = 200` 拿掉（變成預設的 255）、`Product.price` 的 `precision = 12, scale = 2` 拿掉、`Reservation.quantity` 從 `int` 改成 `Integer` 而且拿掉 `nullable = false`：

```
比對了 6 個 Entity、50 個欄位
  ✗ Reservation.quantity（inventory_reservations.quantity）：Entity 允許 null，資料庫是 NOT NULL 而且沒有預設值 → 存一個 null 就是執行期錯誤
  ✗ Product.name（products.name）：Entity length=255，資料庫 VARCHAR(200)
  ✗ Product.price（products.price）：Entity 沒寫 precision / scale（Hibernate 會當成 DECIMAL(38,2)），資料庫 DECIMAL(12,2)
[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0
```

**同一次執行裡，Spring context 是成功啟動的** —— 也就是說 `ddl-auto=validate` 對這三處完全沒有意見。

> 📌 為什麼 Entity 上的 `length` 很重要，就算 Hibernate 不拿它建表？
> 因為它是**程式碼裡唯一一個寫著「這個欄位最多幾個字」的地方**。第 03 章的 DTO 驗證（`@Size(max = 200)`）應該要跟它一致；
> 讓 `length` 跟 schema 對齊，你就有一條「schema → Entity → DTO」的追溯鏈。

### 2.4.3 時間：存 UTC，而且要「真的」是 UTC

0.6.7 的規則是「儲存一律 UTC」。0.10.1 讓 MySQL 的時區是 `+00:00`，0.10.4 在 JDBC URL 加了 `connectionTimeZone=UTC`。
**第二個設定少了會怎樣？** 實測：JVM 時區設成 `Asia/Taipei`（你的筆電），寫入同一個 `Instant`，一次有 `connectionTimeZone=UTC`、一次沒有。

```java
    @Test
    void timeZone() throws Exception {
        System.out.println("═══ 2.4.3 同一個 Instant，兩種連線設定 ═══");
        TimeZone.setDefault(TimeZone.getTimeZone("Asia/Taipei"));         // 你的筆電
        Instant t = Instant.parse("2026-09-23T16:30:00Z");                // UTC 16:30 = 台北 00:30（隔天）
        try (Connection c = DriverManager.getConnection(URL, "shop", "shop"); Statement st = c.createStatement()) {
            st.execute("DROP TABLE IF EXISTS c5_times");
            st.execute("CREATE TABLE c5_times (label VARCHAR(40), at DATETIME(3))");
        }
        for (String opt : new String[]{"", "&connectionTimeZone=UTC"}) {
            try (Connection c = DriverManager.getConnection(URL + opt, "shop", "shop");
                 PreparedStatement ps = c.prepareStatement("INSERT INTO c5_times VALUES (?, ?)")) {
                ps.setString(1, opt.isEmpty() ? "沒設 connectionTimeZone" : "connectionTimeZone=UTC");
                ps.setObject(2, t);
                ps.executeUpdate();
            }
        }
        try (Connection c = DriverManager.getConnection(URL + "&connectionTimeZone=UTC", "shop", "shop");
             ResultSet rs = c.createStatement().executeQuery(
                     "SELECT label, DATE_FORMAT(at, '%Y-%m-%d %H:%i:%s') AS raw, DATE(at) AS utc_day FROM c5_times")) {
            System.out.println("  寫入的 Instant：" + t + "（台北時間 2026-09-24 00:30）");
            while (rs.next()) System.out.printf("  %-24s → 資料庫裡的值 %s   DATE() = %s%n", rs.getString(1), rs.getString(2), rs.getString(3));
        }
    }
```

（`C5WhatTheDatabaseCannotStopTest` 的一部分，`URL` 指向 `shop_lab`。這裡只是一個方法，直接貼進新檔案會編譯失敗 —— 完整檔案在 2.11.3。）

```
═══ 2.4.3 同一個 Instant，兩種連線設定 ═══
  寫入的 Instant：2026-09-23T16:30:00Z（台北時間 2026-09-24 00:30）
  沒設 connectionTimeZone    → 資料庫裡的值 2026-09-24 00:30:00   DATE() = 2026-09-24
  connectionTimeZone=UTC   → 資料庫裡的值 2026-09-23 16:30:00   DATE() = 2026-09-23
```

**同一個 `Instant`，資料庫裡差了 8 小時，而且連日期都不一樣。**

沒設 `connectionTimeZone` 時，Connector/J 8.x 的預設是 `LOCAL` —— 用 **JVM 的時區**把 `Instant` 轉成「當地時間」再寫進 `DATETIME`。
你的筆電是台北時間，所以寫進去的是 `00:30`。部署到正式環境的容器（通常是 UTC）時，同一段程式碼寫進去的是 `16:30` ——
**同一張表裡，一半的資料是台北時間、一半是 UTC，而且沒有任何欄位記錄是哪一種。**

`DATETIME` 本身**不帶時區資訊**，它只是一個「年月日時分秒」。所以「它是 UTC」這件事，完全靠**每一個寫入它的連線都用同一個時區**來保證。
這就是為什麼本專題的每一個 JDBC URL（local、prod、測試、實驗）都帶著 `connectionTimeZone=UTC`。

**為什麼不用 `TIMESTAMP`？** `TIMESTAMP` 存的是 UTC 秒數，看起來更適合 —— 但它**會依 session 時區自動轉換**，讓「資料庫裡存的是什麼」依賴於「誰在查」；
而且它的上限是 **2038-01-19**（32 位元秒數）。`created_at` 不會碰到 2038，但 `expires_at`、`payment_deadline` 這類「未來的時間」，在一個 10 年的長期訂閱裡就會碰到。

> 📌 **報表的「9 月 1 日」是台北的 9 月 1 日**（US-RPT-1 AC-2），資料庫裡存的是 UTC。
> 「DB 存 UTC、查詢時依使用者的時區切日」這件事，第 03 章的日報表會正面處理 —— 而那裡有另一個 8 小時的坑在等著（2.8 的種子資料刻意在台北凌晨 0～8 點安排了訂單，就是為了讓它現形）。

### 2.4.4 主鍵與對外編號

**內部主鍵** `id BIGINT AUTO_INCREMENT`：給 JOIN、外鍵、索引用。**對外編號** `order_no`：給人看、給客服查、印在出貨單上。
0.6.7 要求「不對外暴露連續 id 的業務意義」—— 訂單 id 是連續的，對外暴露它等於告訴競爭對手你一天有幾張訂單。

那 `order_no` 的格式 `yyyyMMdd-nnnnnn` 裡，`nnnnnn` 怎麼產生？最直覺的是**每日流水號**：一張 `(day, last_no)` 的計數器表，每下一張單就 +1。

**直覺上它有兩個問題**：`nnnnnn` 也洩漏了每天的訂單量（`000123` = 今天第 123 張）；而且它是一個**全站共用的熱點行** —— 0.11 量過，同一列的更新吞吐上限是幾百次/秒。

實測：16 條執行緒下單（**分散在不同商品**，所以沒有庫存熱點），比較三種寫法：

```java
    @Test
    void orderNumberStrategies() throws Exception {
        jdbc.execute("DROP TABLE IF EXISTS c6_orders");
        jdbc.execute("DROP TABLE IF EXISTS c6_order_no_seq");
        jdbc.execute("""
            CREATE TABLE c6_orders (id BIGINT AUTO_INCREMENT PRIMARY KEY, order_no VARCHAR(15) NULL, buyer_id BIGINT NOT NULL,
              UNIQUE KEY uk_c6_order_no (order_no))""");
        jdbc.execute("CREATE TABLE c6_order_no_seq (day CHAR(8) PRIMARY KEY, last_no INT NOT NULL)");
        jdbc.update("INSERT INTO c6_order_no_seq VALUES ('20260929', 0)");
        System.out.println("═══ 2.4.4 訂單編號怎麼產生：16 條執行緒下單（分散在不同商品），各 5 秒 ═══");
        measure(3, r -> tx.executeWithoutResult(s ->                      // 暖機 3 秒（JIT、連線池、buffer pool）
                jdbc.update("INSERT INTO c6_orders (buyer_id) VALUES (?)", r.nextLong(1, 100_000))));
        jdbc.update("TRUNCATE c6_orders");
        Stat none = measure(5, r -> tx.executeWithoutResult(s ->
                jdbc.update("INSERT INTO c6_orders (buyer_id) VALUES (?)", r.nextLong(1, 100_000))));
        Stat seq = measure(5, r -> tx.executeWithoutResult(s -> {
            jdbc.update("UPDATE c6_order_no_seq SET last_no = LAST_INSERT_ID(last_no + 1) WHERE day = '20260929'");
            long n = jdbc.queryForObject("SELECT LAST_INSERT_ID()", Long.class);
            jdbc.update("INSERT INTO c6_orders (order_no, buyer_id) VALUES (?, ?)", "20260929-%06d".formatted(n), r.nextLong(1, 100_000));
        }));
        jdbc.update("TRUNCATE c6_orders");
        Stat random = measure(5, r -> tx.executeWithoutResult(s ->
                jdbc.update("INSERT INTO c6_orders (order_no, buyer_id) VALUES (?, ?)",
                        "20260929-%06d".formatted(r.nextInt(1_000_000)), r.nextLong(1, 100_000))));
        System.out.printf("  不產生編號（基準）          : %,6.0f 筆/秒  p99 %6.2f ms%n", none.tps, none.p99);
        System.out.printf("  每日流水號（一列計數器）     : %,6.0f 筆/秒  p99 %6.2f ms%n", seq.tps, seq.p99);
        System.out.printf("  隨機 6 碼 + UNIQUE          : %,6.0f 筆/秒  p99 %6.2f ms  撞號 %d 次（共 %,d 筆）%n", random.tps, random.p99, random.dup, random.ok);
    }
```

（`C6LockSideEffectsTest` 的一部分，完整檔案（含 `measure()` 與 `Stat`）在 2.11.3。`measure()` 用 16 條執行緒反覆執行、統計成功筆數、`DuplicateKeyException` 次數與 p99，跟 0.11 的 `measure()` 同一個寫法。
`UPDATE ... SET last_no = LAST_INSERT_ID(last_no + 1)` 是 MySQL 的慣用法：更新的同時把新值存進這條連線的 `LAST_INSERT_ID()`，不用再 `SELECT` 一次那一列。）

```
═══ 2.4.4 訂單編號怎麼產生：16 條執行緒下單（分散在不同商品），各 5 秒 ═══
  不產生編號（基準）          :  2,136 筆/秒  p99  41.17 ms
  每日流水號（一列計數器）     :    577 筆/秒  p99  57.87 ms
  隨機 6 碼 + UNIQUE          :  2,962 筆/秒  p99  16.29 ms  撞號 118 次（共 14,812 筆）
```

（跑了四次：基準 1,683～3,226、流水號 **493～577**、隨機 2,433～3,395 筆/秒。基準與隨機兩者互有高低 —— Docker Desktop 上的 fsync 雜訊；**流水號四次都在 600 以下**。）

**每日流水號讓「沒有任何熱點商品」的下單，也被壓到 600 筆/秒以下。** 因為每一張訂單都要更新**同一列**，而那一列的鎖要握到整個下單交易 commit。
對照 0.11：熱點商品的上限是 678 筆/秒 —— **流水號讓全站的下單都變成了熱點商品**。

**隨機 6 碼**沒有這個問題，代價是**會撞號**：14,812 筆撞了 118 次。這個數字可以預先算出來 —— 生日問題：

```
一天內 n 張訂單、m = 1,000,000 種號碼，預期撞號次數 ≈ n² / (2m)
  n = 14,812（這次實驗）  → 14,812² / 2,000,000 ≈ 110   實測 118
  n =  5,000（0.6.1 的一般日） →  5,000² / 2,000,000 ≈  12.5 次/天
  n =  1,111（2.8 的種子資料，10 萬張 / 90 天） → 約 0.6 次/天 → 90 天約 55 次   實測 61（2.8.3）
```

每天 12 次撞號，每次的代價是**重抽一次號碼、重做一次 INSERT**。第 04 章的下單會在 `DuplicateKeyException`（而且是 `uk_orders_order_no` 這個鍵）時重試。

**本專題的決定**：`order_no = 台北日期 + "-" + 隨機 6 碼`，`UNIQUE` 擋撞號，撞了就重試。

> 📌 **日期部分用台北日期**，不是 UTC —— 編號是給人看的，台北時間 9 月 24 日凌晨 00:30 成立的訂單，編號應該是 `20260924-...`，而不是 `20260923-...`。
> 這是本專題**唯一一個**在資料庫裡存「當地日期」的地方，而且它存在一個字串裡、不參與任何時間計算。

> 📌 如果一天超過 30 萬張訂單，撞號次數會到每天 4.5 萬次、重試開始變貴 —— 那時候把 `nnnnnn` 加長成 8 碼（`VARCHAR(17)`），撞號就降到 1/100。
> **這是一個有數字的「什麼時候要改」**，而不是「以防萬一先做複雜一點」。

### 2.4.5 快照欄位與產生欄位

`order_items` 有三個「看起來重複」的欄位：

| 欄位 | 重複了誰 | 為什麼要存 |
|---|---|---|
| `product_name` | `products.name` | 賣家改名後，一年前的訂單明細**不能**跟著變（1.5.5「語意」） |
| `unit_price` | `products.price` | 0.3.5 的價格快照：商品改價，訂單金額不變 |
| `line_amount` | `unit_price * quantity` | 報表要 `SUM(line_amount)`；而且它**不可能**跟前兩欄不一致 |

`line_amount` 是 MySQL 的**產生欄位**（generated column）：`DECIMAL(12,2) AS (unit_price * quantity) STORED`。
`STORED` 代表它在寫入時就算好、真的存在磁碟上，可以被索引、被 `SUM` 時不用重算。**它不可能被寫錯** —— 你連寫它都不行：

```
INSERT INTO order_items (..., line_amount) VALUES (..., 999)
→ ERROR 3105 (HY000): The value specified for generated column 'line_amount' in table 'order_items' is not allowed.
```

所以 Entity 上它是 `insertable = false, updatable = false`（2.4.2 的表格）。

**那 `orders.total_amount` 為什麼不也做成產生欄位？** 因為它是**跨列**的（Σ 所有明細的 `line_amount`），產生欄位只能引用同一列的欄位。
它由第 04 章的下單程式計算、寫入，並由 2.5.5 的對帳 SQL 檢查「`total_amount` = Σ `line_amount`」。

> 📌 跨模組的快照只存「下單當下需要的」。`order_items` **沒有** `category_id`、沒有 `seller_name` —— 訂單明細頁不需要它們。
> 快照多存一個欄位，就多一個「它跟來源不一致算不算 bug」的問題。**只為一個已知的需求存快照。**

---

## 2.5 約束就是不變量

### 2.5.1 從需求到約束

0.4.6 的五條不變量，加上 0.5 狀態機隱含的幾條規則，對應到三種資料庫約束：

| 規則 | 來源 | 約束 | 名稱 |
|---|---|---|---|
| `0 ≤ reserved ≤ onHand` | INV-1 | CHECK | `ck_inventory_reserved` |
| 一張訂單對一個商品最多一筆預留 | INV-4 | UNIQUE | `uk_reservations_order_product` |
| 預留只有四種狀態 | 0.3.5 | CHECK | `ck_reservations_status` |
| 每一筆庫存帳都真的改變了某個數字 | 0.3.5 | CHECK | `ck_ledger_delta` |
| 訂單只有六種狀態 | 0.5.1 | CHECK | `ck_orders_status` |
| **已取消 ⇔ 有取消原因** | 0.5.4 | CHECK（跨欄位） | `ck_orders_cancel_reason` |
| 已付款以後的狀態必須有 `paid_at` | 0.5.4 | CHECK（跨欄位） | `ck_orders_paid` |
| 已出貨以後的狀態必須有物流資訊 | US-ORD-6 AC-2 | CHECK（跨欄位） | `ck_orders_shipment` |
| 同一筆金流交易只能記一次 | US-ORD-2 AC-5 | UNIQUE | `uk_payments_provider_txn` |
| email 不分大小寫唯一 | US-ACC-1 AC-2 | UNIQUE + `_ci` 定序 | `uk_users_email` |
| 預留、帳、明細不能指向不存在的父列 | —— | 外鍵（同模組） | `fk_*` |
| `reserved` = Σ 有效預留 | INV-2 | ❌ **CHECK 寫不出來** | 對帳（2.5.5） |
| `onHand` = Σ ledger | INV-3 | ❌ **CHECK 寫不出來** | 對帳（2.5.5） |
| ledger 只能新增 | INV-5 | ❌ 不是約束，是**權限** | 第 09 章 |

**第 01 章 1.11 的問題：「MySQL 8.0 的 `CHECK` 真的會被執行嗎？」**

MySQL 在 **8.0.16 以前**會解析 `CHECK` 語法、然後**默默忽略它** —— 你寫了約束，資料庫說「好」，然後什麼都不擋。
本專題的版本是 8.0.46（0.10.1 查過）。**不要相信版本號，要實測** —— 下一節就是。

### 2.5.2 `SchemaConstraintTest`：直接寫入非法資料

```java
package com.example.shop.schema;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 2.5 約束就是不變量：直接用 SQL 寫入非法資料，預期資料庫拒絕。
 * 每個案例都在一個會 rollback 的交易裡跑，不會留下任何資料。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE)
class SchemaConstraintTest {

    @Autowired JdbcTemplate jdbc;
    @Autowired TransactionTemplate tx;

    record Case(String rule, String setupSql, String illegalSql) {}

    static final String PRODUCT = """
            INSERT INTO products (id, seller_id, category_id, name, price, status)
            VALUES (900001, 1, 11, '測試耳機', 100, 'ON_SALE')""";
    static final String INVENTORY = "INSERT INTO inventory (product_id, on_hand, reserved) VALUES (900001, 10, 3)";
    static final String ORDER = """
            INSERT INTO orders (id, order_no, buyer_id, seller_id, status, total_amount, payment_deadline)
            VALUES (900001, '20260929-900001', 1, 2, 'PENDING_PAYMENT', 100, NOW(3) + INTERVAL 15 MINUTE)""";

    static final List<Case> CASES = List.of(
        new Case("INV-1 reserved 不可超過 on_hand", INVENTORY, "UPDATE inventory SET reserved = 11 WHERE product_id = 900001"),
        new Case("INV-1 reserved 不可為負", INVENTORY, "UPDATE inventory SET reserved = reserved - 4 WHERE product_id = 900001"),
        new Case("INV-1 出貨不可讓 on_hand < reserved", INVENTORY, "UPDATE inventory SET on_hand = on_hand - 8 WHERE product_id = 900001"),
        new Case("INV-4 同一訂單同一商品只能一筆預留", INVENTORY + ";" +
                "INSERT INTO inventory_reservations (order_id, product_id, quantity) VALUES (1, 900001, 1)",
                "INSERT INTO inventory_reservations (order_id, product_id, quantity, status) VALUES (1, 900001, 2, 'HELD')"),
        new Case("預留狀態只能是四個值之一", INVENTORY,
                "INSERT INTO inventory_reservations (order_id, product_id, quantity, status) VALUES (1, 900001, 1, 'DONE')"),
        new Case("預留不可指向不存在的庫存列（同模組外鍵）", "",
                "INSERT INTO inventory_reservations (order_id, product_id, quantity) VALUES (1, 424242, 1)"),
        new Case("庫存帳的 reason 只能是五個值之一", INVENTORY,
                "INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason) VALUES (900001, 5, 0, 'FIX')"),
        new Case("庫存帳不可寫一筆「什麼都沒變」", INVENTORY,
                "INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason) VALUES (900001, 0, 0, 'RESTOCK')"),
        new Case("訂單狀態只能是 0.5 的六個值", "",
                ORDER.replace("'PENDING_PAYMENT'", "'REFUNDED'")),
        new Case("已取消的訂單必須有取消原因", ORDER, "UPDATE orders SET status = 'CANCELLED' WHERE id = 900001"),
        new Case("未取消的訂單不可有取消原因", ORDER, "UPDATE orders SET cancel_reason = 'BUYER' WHERE id = 900001"),
        new Case("已付款的訂單必須有 paid_at", ORDER, "UPDATE orders SET status = 'PAID' WHERE id = 900001"),
        new Case("已出貨的訂單必須有物流資訊", ORDER,
                "UPDATE orders SET status = 'SHIPPED', paid_at = NOW(3) WHERE id = 900001"),
        new Case("訂單編號不可重複", ORDER, ORDER.replace("900001, '20260929-900001'", "900002, '20260929-900001'")),
        new Case("明細不可指向不存在的訂單（同模組外鍵）", "",
                "INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity) VALUES (424242, 1, 'x', 100, 1)"),
        new Case("明細數量 1～99", ORDER,
                "INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity) VALUES (900001, 1, 'x', 100, 100)"),
        new Case("商品價格必須 > 0", "", PRODUCT.replace("'測試耳機', 100", "'測試耳機', 0")),
        new Case("商品價格不可超過 100 萬", "", PRODUCT.replace("'測試耳機', 100", "'測試耳機', 1000000.01")),
        new Case("email 不分大小寫唯一（US-ACC-1 AC-2）",
                "INSERT INTO users (email, password_hash, display_name) VALUES ('Gary@Example.com', 'x', 'g')",
                "INSERT INTO users (email, password_hash, display_name) VALUES ('gary@example.com', 'x', 'g2')"),
        new Case("購物車數量 1～99", "",
                "INSERT INTO cart_items (buyer_id, product_id, quantity, unit_price_at_add) VALUES (1, 1, 0, 100)"),
        new Case("頂層分類名稱不可重複（parent_id 為 NULL）",
                "INSERT INTO categories (id, parent_id, name) VALUES (900001, NULL, '寵物用品')",
                "INSERT INTO categories (id, parent_id, name) VALUES (900002, NULL, '寵物用品')"),
        new Case("同一筆金流交易只能記一次", "INSERT INTO payments (order_id, amount, provider, provider_txn_id) VALUES (1, 100, 'SIMULATED', 'tx-1')",
                "INSERT INTO payments (order_id, amount, provider, provider_txn_id) VALUES (2, 100, 'SIMULATED', 'tx-1')")
    );

    @BeforeEach
    void clean() {
        jdbc.update("DELETE FROM users WHERE email IN ('Gary@Example.com', 'gary@example.com')");
    }

    @Test
    void illegalDataIsRejectedByTheDatabase() {
        List<String> leaked = new ArrayList<>();
        System.out.println("═══ 2.5 約束就是不變量：直接寫入非法資料 ═══");
        for (Case c : CASES) {
            String outcome = tx.execute(s -> {
                s.setRollbackOnly();
                for (String sql : c.setupSql().split(";")) if (!sql.isBlank()) jdbc.execute(sql);
                try {
                    jdbc.execute(c.illegalSql());
                    return null;
                } catch (DataAccessException e) {
                    return e.getMostSpecificCause().getMessage();
                }
            });
            if (outcome == null) leaked.add(c.rule());
            System.out.printf("  %s %-30s %s%n", outcome == null ? "✗" : "✓", c.rule(), outcome == null ? "← 寫進去了！" : "→ " + outcome);
        }
        assertThat(leaked).as("這些規則資料庫沒擋住").isEmpty();
    }
}
```

**幾個寫法上的選擇**：

- **每個案例一個交易，最後 `setRollbackOnly()`**：前置資料（`INVENTORY`、`ORDER`）與非法寫入都在同一個交易裡，結束時整個回滾。
  這個測試跑在 `shop`（Flyway 管的真 schema）上，**不能**留下任何資料。
- **MySQL 的約束錯誤不會中止交易**：一句 UPDATE 違反 CHECK，只有那一句失敗（statement-level rollback），同一個交易還能繼續用。所以一個交易裡可以「先建前置資料、再試非法寫入」。
- **斷言的是「全部都被擋下」，而且印出每一條的錯誤訊息** —— 這份輸出本身就是一份「約束清單」文件。

```
═══ 2.5 約束就是不變量：直接寫入非法資料 ═══
  ✓ INV-1 reserved 不可超過 on_hand             → Check constraint 'ck_inventory_reserved' is violated.
  ✓ INV-1 reserved 不可為負                     → Check constraint 'ck_inventory_reserved' is violated.
  ✓ INV-1 出貨不可讓 on_hand < reserved          → Check constraint 'ck_inventory_reserved' is violated.
  ✓ INV-4 同一訂單同一商品只能一筆預留             → Duplicate entry '1-900001' for key 'inventory_reservations.uk_reservations_order_product'
  ✓ 預留狀態只能是四個值之一                       → Check constraint 'ck_reservations_status' is violated.
  ✓ 預留不可指向不存在的庫存列（同模組外鍵）        → Cannot add or update a child row: a foreign key constraint fails (`shop`.`inventory_reservations`, CONSTRAINT `fk_reservations_inventory` FOREIGN KEY (`product_id`) REFERENCES `inventory` (`product_id`))
  ✓ 庫存帳的 reason 只能是五個值之一               → Check constraint 'ck_ledger_reason' is violated.
  ✓ 庫存帳不可寫一筆「什麼都沒變」                  → Check constraint 'ck_ledger_delta' is violated.
  ✓ 訂單狀態只能是 0.5 的六個值                    → Check constraint 'ck_orders_status' is violated.
  ✓ 已取消的訂單必須有取消原因                      → Check constraint 'ck_orders_cancel_reason' is violated.
  ✓ 未取消的訂單不可有取消原因                      → Check constraint 'ck_orders_cancel_reason' is violated.
  ✓ 已付款的訂單必須有 paid_at                     → Check constraint 'ck_orders_paid' is violated.
  ✓ 已出貨的訂單必須有物流資訊                      → Check constraint 'ck_orders_shipment' is violated.
  ✓ 訂單編號不可重複                               → Duplicate entry '20260929-900001' for key 'orders.uk_orders_order_no'
  ✓ 明細不可指向不存在的訂單（同模組外鍵）           → Cannot add or update a child row: a foreign key constraint fails (`shop`.`order_items`, CONSTRAINT `fk_order_items_order` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`))
  ✓ 明細數量 1～99                                → Check constraint 'ck_order_items_quantity' is violated.
  ✓ 商品價格必須 > 0                              → Check constraint 'ck_products_price' is violated.
  ✓ 商品價格不可超過 100 萬                        → Check constraint 'ck_products_price' is violated.
  ✓ email 不分大小寫唯一（US-ACC-1 AC-2）          → Duplicate entry 'gary@example.com' for key 'users.uk_users_email'
  ✓ 購物車數量 1～99                              → Check constraint 'ck_cart_items_quantity' is violated.
  ✓ 頂層分類名稱不可重複（parent_id 為 NULL）       → Duplicate entry '寵物用品' for key 'categories.uk_categories_top_level_name'
  ✓ 同一筆金流交易只能記一次                        → Duplicate entry 'SIMULATED-tx-1' for key 'payments.uk_payments_provider_txn'
```

**22 條全部擋下。** 8.0.46 的 CHECK 是真的會執行的。

注意第 3 條「出貨不可讓 `on_hand < reserved`」：它用的是**同一個** `ck_inventory_reserved`。
`reserved <= on_hand` 這一個條件同時守住了兩個方向 —— 預留太多、和實體庫存減太多。**一條約束，兩種 bug。**

> 📌 **這份輸出裡倒數第二條，第一次跑的時候是紅的。** 2.5.4 會說它怎麼被發現、怎麼被修好。

### 2.5.3 跨欄位的 CHECK，以及 `NULL`

`ck_orders_cancel_reason` 是本專題最有意思的一條約束：

```sql
CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL))
```

它是一個**雙向**的條件：「是取消」和「有原因」必須**同真同假**。左右兩邊都是布林值，用 `=` 比較，就是「若且唯若」。
這一條直接擋下了 0.2.2 版本一的一種非法組合 —— 「已取消、但不知道為什麼取消」與「沒取消、卻有取消原因」。

**但另一條 `ck_orders_cancel_reason_values` 呢？**

```sql
CHECK (cancel_reason IN ('BUYER', 'PAYMENT_TIMEOUT', 'SELLER_OUT_OF_STOCK', 'SELLER_OTHER'))
```

當 `cancel_reason` 是 `NULL`（訂單沒有取消）時，`NULL IN (...)` 的結果是 **`NULL`（unknown）**，不是 `FALSE`。
**SQL 標準規定：CHECK 的結果是 `NULL` 時，視為通過。** 所以這條約束對「沒有取消原因」的訂單不會有任何意見 —— 這正是我們要的。

這個規則是一把雙面刃：

| 條件 | 結果是 `NULL` 時 | 你要的是 |
|---|---|---|
| `cancel_reason IN (...)` | 通過 | ✅ 沒有原因的訂單不用檢查原因 |
| `price > 0` | 通過（如果 `price` 可以是 `NULL`） | ❌ —— 所以 `price` 一定要 `NOT NULL` |

**CHECK 永遠要跟 `NOT NULL` 一起想**：一個可以是 `NULL` 的欄位，它的 CHECK 對 `NULL` 是完全不設防的。

### 2.5.4 資料庫擋不住的規則

寫 `SchemaConstraintTest` 的時候，也順便試了幾條**寫不出來**或**擋不住**的規則（`C5WhatTheDatabaseCannotStopTest`，在 `shop_lab` 裡跑）：

```java
    @Test
    void whatTheDatabaseCannotStop() {
        System.out.println("═══ 2.5.4 資料庫擋不住的規則 ═══");
        JDBC.execute("DROP TABLE IF EXISTS c5_products");
        JDBC.execute("DROP TABLE IF EXISTS c5_categories");
        JDBC.execute("CREATE TABLE c5_products (id INT PRIMARY KEY, price DECIMAL(12,2) NOT NULL, CHECK (price > 0))");
        attempt("① 價格 99.999（小數 3 位）", "INSERT INTO c5_products VALUES (1, 99.999)");
        System.out.println("      存進去的值：" + JDBC.queryForObject("SELECT price FROM c5_products WHERE id = 1", String.class));
        JDBC.execute("CREATE TABLE c5_categories (id INT PRIMARY KEY, parent_id INT NULL, name VARCHAR(50) NOT NULL, UNIQUE KEY uk (parent_id, name))");
        attempt("② 第一個頂層分類「服飾」", "INSERT INTO c5_categories VALUES (1, NULL, '服飾')");
        attempt("   第二個頂層分類「服飾」", "INSERT INTO c5_categories VALUES (2, NULL, '服飾')");
        attempt("   子分類「男裝」×2（parent 相同）", "INSERT INTO c5_categories VALUES (3, 1, '男裝'), (4, 1, '男裝')");
        System.out.println("      頂層的「服飾」有幾個：" + JDBC.queryForObject("SELECT COUNT(*) FROM c5_categories WHERE parent_id IS NULL AND name = '服飾'", Integer.class));
        JDBC.execute("DELETE FROM c5_categories WHERE id = 2");
        attempt("②' 改用函式索引（MySQL 8.0.13+）", "CREATE UNIQUE INDEX uk_top_name ON c5_categories ((IF(parent_id IS NULL, name, NULL)))");
        attempt("   再建一個頂層「服飾」", "INSERT INTO c5_categories VALUES (2, NULL, '服飾')");
        attempt("   「男裝」底下的「服飾」", "INSERT INTO c5_categories VALUES (5, 3, '服飾')");
        attempt("③ CHECK 裡用子查詢（INV-2）", """
                ALTER TABLE c5_products ADD CONSTRAINT ck_inv2
                  CHECK (price <= (SELECT MAX(price) FROM c5_products))""");
        attempt("④ CHECK 裡用 NOW()（付款期限在未來）", """
                ALTER TABLE c5_products ADD COLUMN deadline DATETIME(3) NULL,
                  ADD CONSTRAINT ck_future CHECK (deadline > NOW())""");
        attempt("⑤ UNIQUE 帶 WHERE（部分索引）", "CREATE UNIQUE INDEX uk_partial ON c5_categories (name) WHERE parent_id IS NULL");
    }
```

```
═══ 2.5.4 資料庫擋不住的規則 ═══
  ① 價格 99.999（小數 3 位）                → 成功執行
      存進去的值：100.00
  ② 第一個頂層分類「服飾」                   → 成功執行
     第二個頂層分類「服飾」                  → 成功執行
     子分類「男裝」×2（parent 相同）          → Duplicate entry '1-男裝' for key 'c5_categories.uk'
      頂層的「服飾」有幾個：2
  ②' 改用函式索引（MySQL 8.0.13+）          → 成功執行
     再建一個頂層「服飾」                     → Duplicate entry '服飾' for key 'c5_categories.uk_top_name'
     「男裝」底下的「服飾」                   → 成功執行
  ③ CHECK 裡用子查詢（INV-2）               → ALTER command denied to user 'shop'@'192.168.65.1' for table 'c5_products'
  ④ CHECK 裡用 NOW()（付款期限在未來）       → An expression of a check constraint 'ck_future' contains disallowed function: now.
  ⑤ UNIQUE 帶 WHERE（部分索引）             → You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near 'WHERE parent_id IS NULL' at line 1
```

逐條看：

**① 小數位數：資料庫默默四捨五入。** `99.999` 存成 `100.00`，沒有錯誤。在 `mysql` 客戶端裡執行同一句，`SHOW WARNINGS` 會看到一個 **Note**（不是 Warning、更不是 Error）：

```
Level  Code  Message
Note   1265  Data truncated for column 'price' at row 1
```

**嚴格模式（`STRICT_TRANS_TABLES`）也不會擋它** —— 嚴格模式只擋「整數部分放不下」，小數多出來的部分一律四捨五入。
US-PRD-1 AC-2「小數超過 2 位 → 400」**只能在應用程式裡做**：第 03 章 DTO 的 `@Digits(integer = 7, fraction = 2)`。

**② `NULL` 參與的 UNIQUE：兩個 `NULL` 不相等。** `UNIQUE (parent_id, name)` 對子分類有效（`1-男裝` 被擋），**對頂層分類無效** —— 兩個 `parent_id` 都是 `NULL`，在 UNIQUE 的眼中它們是「兩個不同的未知值」。

**而本專題的 V2 就是這樣寫的。** 這條就是 2.5.2 那個「第一次跑是紅的」：

```
  ✗ 頂層分類名稱不可重複（parent_id 為 NULL）   ← 寫進去了！
[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0
[這些規則資料庫沒擋住]
Expecting empty but was: ["頂層分類名稱不可重複（parent_id 為 NULL）"]
```

**⑤ 的標準解法（部分索引 `UNIQUE ... WHERE parent_id IS NULL`）MySQL 不支援**，是語法錯誤。
**②' 是 MySQL 的替代方案**：**函式索引**（functional index，8.0.13 起）。索引的內容是 `IF(parent_id IS NULL, name, NULL)`：

- 頂層分類 → 索引值 = `name` → 同名的會衝突 ✅
- 子分類 → 索引值 = `NULL` → 多個 `NULL` 不衝突 ✅（子分類的唯一性由原本的 `(parent_id, name)` 負責）

V2 已經上線、不能改（2.2.2 規則一），所以寫一個新的 migration —— **而且只有一句 DDL**（規則二）：

```sql
-- V10__catalog_unique_top_level_category_name.sql
-- 2.5.4：UNIQUE (parent_id, name) 擋不住兩個 parent_id 為 NULL 的同名頂層分類（NULL 彼此不相等）。
-- MySQL 沒有部分索引（UNIQUE ... WHERE），改用函式索引：只有頂層分類會產生非 NULL 的鍵。
CREATE UNIQUE INDEX uk_categories_top_level_name ON categories ((IF(parent_id IS NULL, name, NULL)));
```

重新跑 `SchemaConstraintTest`（Flyway 在測試啟動時自動套用 V10）：

```
... o.f.core.internal.command.DbMigrate      : Migrating schema `shop` to version "10 - catalog unique top level category name"
  ✓ 頂層分類名稱不可重複（parent_id 為 NULL）   → Duplicate entry '寵物用品' for key 'categories.uk_categories_top_level_name'
```

**這就是「先寫測試」在 schema 上的樣子**：一條需求 → 一個會紅的案例 → 一個 migration → 變綠。
而且這個洞**不是想出來的，是測試寫出來的** —— 寫案例的時候必須決定「頂層分類的前置資料怎麼寫」，才發現 `parent_id` 是 `NULL`。

> 📌 那 `uk_payments_provider_txn (provider, provider_txn_id)` 呢？`provider_txn_id` 也可以是 `NULL`（建立付款時還沒有交易編號）。
> **在那裡，「兩個 `NULL` 不衝突」正是我們要的**：同一筆訂單可以有好幾筆還沒拿到交易編號的 `PENDING` 付款。
> 同樣的規則，一個地方是洞、一個地方是功能。**每一個可為 `NULL` 的 UNIQUE 欄位，都要問一次「兩個 `NULL` 該不該衝突」。**

**③ ④ 子查詢與 `NOW()`：CHECK 只能看同一列。**

CHECK 的條件只能引用**同一列**的欄位與**確定性的**函式。不能查別的表（③）、不能用 `NOW()`、`RAND()` 這種每次結果不一樣的函式（④）。

③ 的錯誤訊息很奇怪 —— `ALTER command denied`，明明 `shop` 有 `shop_lab` 的 ALL 權限。用 `root` 執行同一句，才看到真正的原因：

```
ERROR 3815 (HY000): An expression of a check constraint 'ck_inv2' contains disallowed function.
```

（MySQL 在權限檢查時就被子查詢裡的表參照絆住了，錯誤訊息在不同帳號下不一樣。**看到莫名其妙的權限錯誤時，換 root 試一次。**）

**所以 INV-2（`reserved` = Σ 有效預留）與 INV-3（`onHand` = Σ ledger）永遠不可能是約束** —— 它們是**跨表**的。
它們只能靠兩件事：寫入的程式碼只有一個主人（`InventoryApi`，1.5.2），以及**對帳**。

**把「擋不住」的規則分給誰：**

| 擋不住的規則 | 例子 | 由誰負責 | 哪一章 |
|---|---|---|---|
| 小數位數、字串格式 | 價格最多 2 位小數、email 格式 | Bean Validation（DTO） | 03 |
| 跨列 | 購物車最多 50 項、每位買家每分鐘 10 次下單 | Service 層 + 限流 | 03、06 |
| 跨表 | INV-2、INV-3、`total_amount` = Σ `line_amount` | 單一寫入者 + **對帳 SQL** | 2.5.5、07 |
| 跟時間有關 | 付款期限在未來、15 分鐘未付款要取消 | 應用程式（建立時計算）+ 排程 | 04 |
| 只能新增不能修改 | INV-5 | **資料庫權限** | 09 |

### 2.5.5 對帳：約束的最後一道網

0.4.6 說 INV-2、INV-3 要「每小時對帳，差異 ≠ 0 即告警」。對帳排程是第 07 章的事，但**對帳的 SQL** 現在就可以寫，而且現在就可以當測試跑：

```java
package com.example.shop.schema;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.LinkedHashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 0.4.6 的不變量裡，CHECK 寫不出來的那幾條（2.5.4），改用對帳 SQL 檢查。
 * 空資料庫會直接通過；跑完種子資料（2.8）之後再跑一次，差異也必須是 0。
 * 第 07 章會把同樣的 SQL 放進每小時的對帳排程。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE)
class InvariantReconciliationTest {

    @Autowired JdbcTemplate jdbc;

    static final Map<String, String> CHECKS = new LinkedHashMap<>();
    static {
        CHECKS.put("INV-2 reserved = Σ 有效預留", """
                SELECT COUNT(*) FROM inventory i
                  LEFT JOIN (SELECT product_id, SUM(quantity) AS q FROM inventory_reservations
                              WHERE status IN ('HELD', 'CONFIRMED') GROUP BY product_id) r ON r.product_id = i.product_id
                 WHERE i.reserved <> COALESCE(r.q, 0)""");
        CHECKS.put("INV-3 on_hand = Σ ledger.delta_on_hand", """
                SELECT COUNT(*) FROM inventory i
                  LEFT JOIN (SELECT product_id, SUM(delta_on_hand) AS s FROM inventory_ledger GROUP BY product_id) l
                         ON l.product_id = i.product_id
                 WHERE i.on_hand <> COALESCE(l.s, 0)""");
        CHECKS.put("INV-3' reserved = Σ ledger.delta_reserved", """
                SELECT COUNT(*) FROM inventory i
                  LEFT JOIN (SELECT product_id, SUM(delta_reserved) AS s FROM inventory_ledger GROUP BY product_id) l
                         ON l.product_id = i.product_id
                 WHERE i.reserved <> COALESCE(l.s, 0)""");
        CHECKS.put("訂單金額 = Σ 明細金額", """
                SELECT COUNT(*) FROM orders o
                  JOIN (SELECT order_id, SUM(line_amount) AS s FROM order_items GROUP BY order_id) x ON x.order_id = o.id
                 WHERE o.total_amount <> x.s""");
        CHECKS.put("每張訂單至少一個明細", """
                SELECT COUNT(*) FROM orders o WHERE NOT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id)""");
    }

    @Test
    void invariantsHold() {
        long orders = jdbc.queryForObject("SELECT COUNT(*) FROM orders", Long.class);
        System.out.printf("═══ 對帳（目前 %,d 張訂單）═══%n", orders);
        CHECKS.forEach((name, sql) -> {
            long t0 = System.nanoTime();
            long diff = jdbc.queryForObject(sql, Long.class);
            System.out.printf("  %-38s 差異 %,d 筆   %,6.0f ms%n", name, diff, (System.nanoTime() - t0) / 1e6);
            assertThat(diff).as(name).isZero();
        });
    }
}
```

**INV-3' 是 0.4.6 沒有列出來的**：ledger 同時記了 `delta_on_hand` 與 `delta_reserved`，所以 `reserved` 也可以從帳上加總出來。
這給了 `reserved` **兩個獨立的驗證**：跟預留表比（INV-2）、跟帳比（INV-3'）。兩者都通過，才代表「預留表、帳、庫存數字」三者一致。

跑在種子資料（2.8）上：

```
═══ 對帳（目前 100,000 張訂單）═══
  INV-2 reserved = Σ 有效預留                 差異 0 筆      425 ms
  INV-3 on_hand = Σ ledger.delta_on_hand      差異 0 筆      901 ms
  INV-3' reserved = Σ ledger.delta_reserved   差異 0 筆      529 ms
  訂單金額 = Σ 明細金額                         差異 0 筆      466 ms
  每張訂單至少一個明細                          差異 0 筆      171 ms
```

**全部 0，而且全部在 1 秒內。** 61 萬筆庫存帳的加總 0.9 秒 —— 每小時跑一次沒有任何負擔。

> ⚠️ **這個測試在第 01 章的 `JdbcInventoryService` 上會是紅的**（如果有任何一筆經過 `reserve()` 的資料）。
> 因為 1.5.3 的 `reserve()` 只做了 `UPDATE inventory SET reserved = reserved + ?` 與寫 ledger，**沒有寫 `inventory_reservations`** —— 那張表是這一章才有的。
> 所以 INV-2 會對每一個被預留過的商品報差異。**這是對的**：第 01 章的 `reserve()` 本來就不完整，第 04 章會換掉它。
> 對帳在這裡抓到的，正是一個「程式碼還沒跟上 schema」的地方。

---

## 2.6 外鍵：同模組要，跨模組不要

### 2.6.1 決策表

2.2.3 量過跨模組外鍵的代價。把它跟同模組外鍵放在一起比：

| | 同模組（`order_items.order_id → orders`） | 跨模組（`order_items.product_id → products`） |
|---|---|---|
| 子表 INSERT 時對父列加 S 鎖 | 父列是**同一個交易剛 INSERT 的**，沒有別人會鎖它 | 父列屬於**別的模組**，那個模組的交易隨時可能對它加 X 鎖（2.2.3：1.25 秒的 0） |
| 擋住的 bug | 明細指向不存在的訂單（2.5.2 實測） | 明細指向不存在的商品 —— 但下單流程會先讀商品，這個 bug 在那一步就擋掉了 |
| 父列刪除時 | 訂單不刪（0.6.7） | 商品不刪（US-PRD-4 AC-4） |
| 將來拆服務時 | 同一個服務，外鍵保留 | 兩個服務，**外鍵必須刪掉** —— 而且刪之前要先確認沒有程式碼依賴它 |
| 讓誰依賴誰 | 模組內部的事 | **資料庫層級的跨模組依賴**：catalog「刪不掉一個商品」的原因藏在 ordering 的表裡 |

**本專題：同模組 10 條外鍵，跨模組 0 條。**

`MigrationOwnershipTest`（2.9.4）會把這條規則寫成測試：migration 裡的 `REFERENCES x`，`x` 必須是同一個模組的表。

### 2.6.2 同模組外鍵的坑：語句順序錯了就死鎖

同模組的外鍵沒有 2.2.3 的問題，但它有另一個：**你自己的交易裡，先寫子表、再改父表**。

`inventory_ledger.product_id → inventory.product_id` 是同模組外鍵。補貨時要做兩件事：`UPDATE inventory`（改數字）與 `INSERT inventory_ledger`（記帳）。
**這兩句誰先？** 1.5.3 的 `JdbcInventoryService` 是「先 UPDATE、再 INSERT」。如果反過來呢？

實測（`C6LockSideEffectsTest`，16 條執行緒同時補貨**同一個商品**，各 5 秒）：

```java
    @Test
    void foreignKeyStatementOrder() throws Exception {
        jdbc.execute("DROP TABLE IF EXISTS c6_ledger");
        jdbc.execute("DROP TABLE IF EXISTS c6_inventory");
        jdbc.execute("CREATE TABLE c6_inventory (product_id BIGINT PRIMARY KEY, on_hand INT NOT NULL)");
        jdbc.execute("""
            CREATE TABLE c6_ledger (id BIGINT AUTO_INCREMENT PRIMARY KEY, product_id BIGINT NOT NULL, delta INT NOT NULL,
              CONSTRAINT fk_c6 FOREIGN KEY (product_id) REFERENCES c6_inventory (product_id))""");
        jdbc.update("INSERT INTO c6_inventory VALUES (1, 0)");
        System.out.println("═══ 2.6.2 同模組外鍵：補貨（同一個商品），兩種語句順序，16 條執行緒各 5 秒 ═══");
        measure(3, r -> jdbc.update("UPDATE c6_inventory SET on_hand = on_hand WHERE product_id = 1"));   // 暖機
        Stat wrong = measure(5, r -> tx.executeWithoutResult(s -> {
            jdbc.update("INSERT INTO c6_ledger (product_id, delta) VALUES (1, 1)");        // 子表先：對父列加 S 鎖
            jdbc.update("UPDATE c6_inventory SET on_hand = on_hand + 1 WHERE product_id = 1"); // 再升級成 X 鎖
        }));
        Stat right = measure(5, r -> tx.executeWithoutResult(s -> {
            jdbc.update("UPDATE c6_inventory SET on_hand = on_hand + 1 WHERE product_id = 1"); // 父表先：直接拿 X 鎖
            jdbc.update("INSERT INTO c6_ledger (product_id, delta) VALUES (1, 1)");
        }));
        System.out.printf("  先 INSERT 帳、再 UPDATE 庫存 : 成功 %,6d 筆（%,5.0f 筆/秒）  死鎖 %,5d 次  p99 %6.2f ms%n", wrong.ok, wrong.tps, wrong.deadlocks, wrong.p99);
        System.out.printf("  先 UPDATE 庫存、再 INSERT 帳 : 成功 %,6d 筆（%,5.0f 筆/秒）  死鎖 %,5d 次  p99 %6.2f ms%n", right.ok, right.tps, right.deadlocks, right.p99);
        System.out.println("  對帳：on_hand = " + jdbc.queryForObject("SELECT on_hand FROM c6_inventory", Integer.class)
                + "，Σ ledger = " + jdbc.queryForObject("SELECT SUM(delta) FROM c6_ledger", Integer.class));
    }
```

```
═══ 2.6.2 同模組外鍵：補貨（同一個商品），兩種語句順序，16 條執行緒各 5 秒 ═══
  先 INSERT 帳、再 UPDATE 庫存 : 成功    704 筆（  141 筆/秒）  死鎖 9,062 次  p99  31.65 ms
  先 UPDATE 庫存、再 INSERT 帳 : 成功  3,171 筆（  634 筆/秒）  死鎖     0 次  p99  55.47 ms
  對帳：on_hand = 3875，Σ ledger = 3875
```

（另一次：704 / 9,062 → 549 / 7,120 與 866 / 11,496；正確順序三次都是 **0 次死鎖**。）

**同樣兩句 SQL，只是換了順序：死鎖 9,062 次 vs 0 次。** 錯誤的順序下，**每成功 1 筆就死鎖 13 次**。

**為什麼？** 兩個交易 A、B 同時補貨商品 1：

```
A：INSERT ledger       → 外鍵檢查，對 inventory 第 1 列加 S 鎖         ✓
B：INSERT ledger       → 對同一列加 S 鎖（S 與 S 相容）                  ✓
A：UPDATE inventory    → 要 X 鎖，但 B 拿著 S 鎖 → 等 B
B：UPDATE inventory    → 要 X 鎖，但 A 拿著 S 鎖 → 等 A
                         ↑ 互相等待 = 死鎖。InnoDB 偵測到，殺掉其中一個
```

「**先拿 S 鎖、再升級成 X 鎖**」是 InnoDB 死鎖最典型的形狀（[07-mysql/04](../07-mysql/04-transaction-isolation-and-lock.md)）。
正確的順序是**先 UPDATE 父表**（直接拿 X 鎖，其他人排隊），**再 INSERT 子表**（外鍵檢查要的 S 鎖，自己已經有 X 鎖了，不用等）。

注意最後一行：**兩種寫法的對帳都是平的**（3,875 = 3,875）。死鎖的交易被整個回滾了，沒有留下半筆帳。
**死鎖不是資料錯誤，是吞吐的損失** —— 以及每一次死鎖在應用程式裡都是一個 `CannotAcquireLockException`，如果沒有重試，就是一個 500。

> 📌 **Spring 6 的死鎖例外是 `CannotAcquireLockException`**，不是舊版的 `DeadlockLoserDataAccessException`（已標為 deprecated）。
> 兩者都是 `PessimisticLockingFailureException` 的子類別 —— **要接住死鎖，接 `PessimisticLockingFailureException`**。接錯了類別，死鎖會直接變成測試錯誤。

**本專題的規則**：

> **同一個交易裡，先改父表、再寫子表。**
> `InventoryApi` 的每一個方法都是「`UPDATE inventory` → `INSERT inventory_ledger` / `inventory_reservations`」；
> 下單是「`INSERT orders` → `INSERT order_items`」（父列是剛建的，沒有人跟你搶）。

第 04 章的下單交易會碰到**另一種**死鎖（兩張訂單以不同順序預留同樣兩個商品），那一種跟外鍵無關，解法是「依 `product_id` 排序後再預留」。

### 2.6.3 外鍵會自動建索引

InnoDB 要求外鍵欄位**必須有索引**（外鍵檢查要能快速找到子列）。如果你沒建，**它會自動幫你建一個**，名字就是外鍵的名字：

```sql
SHOW INDEX FROM products;
-- ... fk_products_category  (category_id)   ← 沒有寫在 V2 裡，是外鍵自動建的
```

這個自動索引**會被最佳化器拿來用** —— 2.7.2 的商品搜尋在沒有 `idx_products_status_category_price` 時，就是用它（`key=fk_products_category`）。
它也會佔空間、拖慢寫入（2.7.4）。**建外鍵之前，先想想那個欄位是不是本來就在某個複合索引的最左邊**：
`order_items` 的 `fk_order_items_order` 就沒有額外建索引，因為 `uk_order_items_order_product (order_id, product_id)` 的最左欄位就是 `order_id`，InnoDB 直接拿它來用。

---

## 2.7 索引規劃

### 2.7.1 從 API 反推索引

索引不是「看哪個欄位常用就加」。**每一個索引都要能回答「它服務哪一支 API、那支 API 的 SLO 是多少」**。
從 0.8 的 API 草案與 0.6.2 的 SLO 出發：

| API / 排程 | 查詢的形狀 | SLO | 索引 |
|---|---|---|---|
| `GET /api/orders`（我的訂單） | `WHERE buyer_id = ? [AND status = ?] ORDER BY created_at DESC LIMIT 20` | p99 200 ms | `idx_orders_buyer_created (buyer_id, created_at)` |
| `GET /api/seller/orders` | `WHERE seller_id = ? ORDER BY created_at DESC LIMIT 20` | —— | `idx_orders_seller_created (seller_id, created_at)` |
| 賣家日報表 | `WHERE seller_id = ? AND created_at >= ? AND created_at < ?` | p95 1 s | 同上（範圍掃描） |
| 付款逾時排程（每 30 秒） | `WHERE status = 'PENDING_PAYMENT' AND payment_deadline < NOW()` | 60 秒內取消（US-ORD-3 AC-2） | `idx_orders_status_deadline (status, payment_deadline)` |
| 自動完成排程 | `WHERE status = 'SHIPPED' AND shipped_at < NOW() - 7 天` | —— | `idx_orders_status_shipped (status, shipped_at)` |
| 用 `orderNo` 查訂單（客服） | `WHERE order_no = ?` | —— | `uk_orders_order_no`（UNIQUE 本身就是索引） |
| `GET /api/products`（搜尋） | `WHERE status = 'ON_SALE' AND category_id = ? AND price BETWEEN ? AND ? [AND name LIKE ?] ORDER BY price` | p99 300 ms | `idx_products_status_category_price` |
| 賣家的商品列表 | `WHERE seller_id = ? ORDER BY created_at DESC` | —— | `idx_products_seller_created` |
| INV-2 對帳 | `WHERE status IN (...) GROUP BY product_id` | 每小時 | `idx_reservations_product_status (product_id, status)` |
| 商品銷量排行（US-RPT-2） | `order_items ... GROUP BY product_id` | —— | `idx_order_items_product` |

**複合索引的欄位順序**，三條規則：

1. **等值條件在前、範圍條件在後**：`(status, payment_deadline)` —— `status =` 是等值、`payment_deadline <` 是範圍。反過來的 `(payment_deadline, status)` 會先用範圍掃過所有過期的訂單（包括已付款的），再逐列過濾狀態。
2. **`ORDER BY` 的欄位接在等值條件後面**：`(buyer_id, created_at)` —— 找到 `buyer_id = ?` 的那一段之後，資料**已經照 `created_at` 排好了**，不用再排序（2.7.2 會看到 `Using filesort` 消失）。
3. **範圍條件之後的欄位，索引幫不上忙**：`(status, category_id, price)` 裡，`price BETWEEN` 之後就算還有欄位，也只能用來過濾，不能用來縮小範圍。

### 2.7.2 `EXPLAIN ANALYZE` 實測

在 2.8 的種子資料上（10 萬張訂單），用 MySQL 8 的 **invisible index**（2.7.5）把索引「關掉」再「打開」，比較執行計畫與實際延遲。

```java
package com.example.shop.ch02;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.Arrays;
import java.util.List;
import java.util.Map;

/**
 * 2.7 索引規劃：在 10 萬張訂單的種子資料上（先跑 SeedData），
 * 用 MySQL 8 的 invisible index 開關索引，比較 EXPLAIN 與實際延遲。
 */
@Tag("experiment")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE)
class C7IndexPlanningTest {

    @Autowired JdbcTemplate jdbc;

    void visible(String table, String index, boolean on) {
        jdbc.execute("ALTER TABLE %s ALTER INDEX %s %s".formatted(table, index, on ? "VISIBLE" : "INVISIBLE"));
    }

    String explain(String sql, Object... args) {
        Map<String, Object> m = jdbc.queryForList("EXPLAIN " + sql, args).get(0);
        return "type=%-6s key=%-34s rows=%7s  Extra=%s".formatted(m.get("type"), m.get("key"), m.get("rows"), m.get("Extra"));
    }

    /** EXPLAIN ANALYZE 的前幾行：實際讀了幾列、花了多久 */
    String analyze(String sql, Object... args) {
        String plan = jdbc.queryForObject("EXPLAIN ANALYZE " + sql, String.class, args);
        return plan.lines().map(String::strip).limit(4).reduce((a, b) -> a + "\n        " + b).orElse("");
    }

    double millis(int n, String sql, Object... args) {
        for (int i = 0; i < 20; i++) jdbc.queryForList(sql, args);          // 暖機
        long[] t = new long[n];
        for (int i = 0; i < n; i++) { long s = System.nanoTime(); jdbc.queryForList(sql, args); t[i] = System.nanoTime() - s; }
        Arrays.sort(t);
        return t[n / 2] / 1e6;
    }

    void compare(String title, String sql, List<String[]> variants, Object... args) {
        System.out.println("\n── " + title + " ──");
        System.out.println("  " + sql.strip().replaceAll("\\s+", " "));
        try {
            for (String[] v : variants) {
                // v = {說明, 要打開的索引（逗號分隔）, 要關掉的索引, 表}
                for (String idx : v[2].split(",")) if (!idx.isBlank()) visible(v[3], idx, false);
                for (String idx : v[1].split(",")) if (!idx.isBlank()) visible(v[3], idx, true);
                System.out.printf("  [%s]%n    %s%n    p50 %.3f ms%n", v[0], explain(sql, args), millis(200, sql, args));
                System.out.println("    實際：" + analyze(sql, args));
            }
        } finally {
            for (String[] v : variants) for (String idx : (v[1] + "," + v[2]).split(",")) if (!idx.isBlank()) visible(v[3], idx, true);
        }
    }

    @Test
    void indexPlanning() {
        long heavy = jdbc.queryForObject("SELECT COUNT(*) FROM orders WHERE buyer_id = 1001", Long.class);
        long topSeller = jdbc.queryForObject("SELECT COUNT(*) FROM orders WHERE seller_id = 2", Long.class);
        System.out.printf("═══ 2.7 索引規劃（orders %,d 列；買家 1001 有 %,d 張、賣家 2 有 %,d 張）═══%n",
                jdbc.queryForObject("SELECT COUNT(*) FROM orders", Long.class), heavy, topSeller);

        jdbc.execute("CREATE INDEX idx_tmp_buyer ON orders (buyer_id)");            // 對照組：單欄索引
        try {
            compare("US-ORD-5 AC-1 我的訂單（最重度的買家）", """
                    SELECT id, order_no, status, total_amount, created_at FROM orders
                     WHERE buyer_id = ? ORDER BY created_at DESC LIMIT 20""",
                    List.of(new String[]{"沒有 buyer 相關索引", "", "idx_orders_buyer_created,idx_tmp_buyer", "orders"},
                            new String[]{"單欄 (buyer_id)", "idx_tmp_buyer", "idx_orders_buyer_created", "orders"},
                            new String[]{"複合 (buyer_id, created_at)", "idx_orders_buyer_created", "idx_tmp_buyer", "orders"}),
                    1001L);
        } finally {
            jdbc.execute("DROP INDEX idx_tmp_buyer ON orders");
        }

        compare("同上，加狀態篩選 status = 'CANCELLED'", """
                SELECT id, order_no, status, total_amount, created_at FROM orders
                 WHERE buyer_id = ? AND status = 'CANCELLED' ORDER BY created_at DESC LIMIT 20""",
                List.<String[]>of(new String[]{"複合 (buyer_id, created_at)", "idx_orders_buyer_created", "", "orders"}),
                1001L);

        compare("US-ORD-3 逾時掃描（排程每 30 秒一次）", """
                SELECT id FROM orders WHERE status = 'PENDING_PAYMENT' AND payment_deadline < NOW(3)
                 ORDER BY payment_deadline LIMIT 100""",
                List.of(new String[]{"沒有 (status, payment_deadline)", "", "idx_orders_status_deadline,idx_orders_status_shipped", "orders"},
                        new String[]{"有 (status, payment_deadline)", "idx_orders_status_deadline", "", "orders"}));

        compare("US-RPT-1 賣家 90 天報表的範圍（最大的賣家）", """
                SELECT COUNT(*), SUM(total_amount) FROM orders
                 WHERE seller_id = ? AND created_at >= NOW(3) - INTERVAL 90 DAY""",
                List.of(new String[]{"沒有 (seller_id, created_at)", "", "idx_orders_seller_created", "orders"},
                        new String[]{"有 (seller_id, created_at)", "idx_orders_seller_created", "", "orders"}),
                2L);

        compare("US-PRD-2 商品搜尋（分類 + 價格區間 + 關鍵字）", """
                SELECT id, name, price FROM products
                 WHERE status = 'ON_SALE' AND category_id = 11 AND price BETWEEN 100 AND 2000
                   AND name LIKE '%耳機%' ORDER BY price LIMIT 20""",
                List.of(new String[]{"沒有 (status, category_id, price)", "", "idx_products_status_category_price", "products"},
                        new String[]{"有 (status, category_id, price)", "idx_products_status_category_price", "", "products"}));
    }
}
```

> ⚠️ **`finally` 裡把索引設回 visible 不是潔癖。** 如果 `compare()` 的中間丟了例外（例如一個格式字串的錯誤），
> 那時候 `idx_orders_buyer_created` 已經被設成 invisible，**而且不會被設回來**。
> invisible 的索引會繼續被維護（每一次寫入都更新它），只是最佳化器不用它。所以**不會有任何錯誤**，只是「我的訂單」從此變成全表掃描。
> 修法是在實驗之後查一次 `information_schema.statistics WHERE is_visible = 'NO'`（2.7.5）。

**輸出**（`EXPLAIN ANALYZE` 的 `cost=` 欄位已刪去，只保留實際的時間與列數）：

```
═══ 2.7 索引規劃（orders 100,000 列；買家 1001 有 3,000 張、賣家 2 有 10,928 張）═══

── US-ORD-5 AC-1 我的訂單（最重度的買家） ──
  SELECT id, order_no, status, total_amount, created_at FROM orders WHERE buyer_id = ? ORDER BY created_at DESC LIMIT 20
  [沒有 buyer 相關索引]
    type=ALL    key=null                               rows=  99544  Extra=Using where; Using filesort
    p50 20.685 ms
    實際：-> Limit: 20 row(s)  (actual time=23.7..23.7 rows=20 loops=1)
        -> Sort: orders.created_at DESC, limit input to 20 row(s) per chunk  (actual time=23.7..23.7 rows=20 loops=1)
        -> Filter: (orders.buyer_id = 1001)  (actual time=0.0342..22.9 rows=3000 loops=1)
        -> Table scan on orders  (actual time=0.0324..19.9 rows=100000 loops=1)
  [單欄 (buyer_id)]
    type=ref    key=idx_tmp_buyer                      rows=   3000  Extra=Using filesort
    p50 2.231 ms
    實際：-> Limit: 20 row(s)  (actual time=1.83..1.83 rows=20 loops=1)
        -> Sort: orders.created_at DESC, limit input to 20 row(s) per chunk  (actual time=1.83..1.83 rows=20 loops=1)
        -> Index lookup on orders using idx_tmp_buyer (buyer_id=1001)  (actual time=0.0969..1.56 rows=3000 loops=1)
  [複合 (buyer_id, created_at)]
    type=ref    key=idx_orders_buyer_created           rows=   3000  Extra=Backward index scan
    p50 0.386 ms
    實際：-> Limit: 20 row(s)  (actual time=0.0867..0.0891 rows=20 loops=1)
        -> Index lookup on orders using idx_orders_buyer_created (buyer_id=1001) (reverse)  (actual time=0.0863..0.088 rows=20 loops=1)

── 同上，加狀態篩選 status = 'CANCELLED' ──
  [複合 (buyer_id, created_at)]
    type=ref    key=idx_orders_buyer_created           rows=   3000  Extra=Using where; Backward index scan
    p50 0.429 ms
    實際：-> Limit: 20 row(s)  (actual time=0.131..0.142 rows=20 loops=1)
        -> Filter: (orders.`status` = 'CANCELLED')  (actual time=0.131..0.141 rows=20 loops=1)
        -> Index lookup on orders using idx_orders_buyer_created (buyer_id=1001) (reverse)  (actual time=0.126..0.134 rows=128 loops=1)

── US-ORD-3 逾時掃描（排程每 30 秒一次） ──
  [沒有 (status, payment_deadline)]
    type=ALL    key=null                               rows=  99544  Extra=Using where; Using filesort
    p50 16.249 ms
    實際：-> Limit: 100 row(s)  (actual time=18.5..18.5 rows=25 loops=1)
        -> Sort: orders.payment_deadline, limit input to 100 row(s) per chunk  (actual time=18.5..18.5 rows=25 loops=1)
        -> Filter: ((orders.`status` = 'PENDING_PAYMENT') and (orders.payment_deadline < <cache>(now(3))))  (actual time=18.5..18.5 rows=25 loops=1)
        -> Table scan on orders  (actual time=0.0688..14.6 rows=100000 loops=1)
  [有 (status, payment_deadline)]
    type=range  key=idx_orders_status_deadline         rows=     25  Extra=Using where; Using index
    p50 0.242 ms
    實際：-> Limit: 100 row(s)  (actual time=0.0272..0.0431 rows=25 loops=1)
        -> Filter: ((orders.`status` = 'PENDING_PAYMENT') and (orders.payment_deadline < <cache>(now(3))))  (actual time=0.0264..0.0408 rows=25 loops=1)
        -> Covering index range scan on orders using idx_orders_status_deadline over (status = 'PENDING_PAYMENT' AND payment_deadline < '2026-09-29 09:06:58.036')  (actual time=0.0239..0.0304 rows=25 loops=1)

── US-RPT-1 賣家 90 天報表的範圍（最大的賣家） ──
  [沒有 (seller_id, created_at)]
    type=ALL    key=null                               rows=  99544  Extra=Using where
    p50 15.706 ms
    實際：-> Aggregate: count(0), sum(orders.total_amount)  (actual time=18.9..18.9 rows=1 loops=1)
        -> Filter: ((orders.seller_id = 2) and (orders.created_at >= <cache>((now(3) - interval 90 day))))  (actual time=0.0355..18.4 rows=10928 loops=1)
        -> Table scan on orders  (actual time=0.0305..14.7 rows=100000 loops=1)
  [有 (seller_id, created_at)]
    type=range  key=idx_orders_seller_created          rows=  20900  Extra=Using index condition
    p50 5.921 ms
    實際：-> Aggregate: count(0), sum(orders.total_amount)  (actual time=7.5..7.5 rows=1 loops=1)
        -> Index range scan on orders using idx_orders_seller_created over (seller_id = 2 AND '2026-07-01 09:07:03.287' <= created_at), with index condition: (...)  (actual time=0.108..6.9 rows=10928 loops=1)

── US-PRD-2 商品搜尋（分類 + 價格區間 + 關鍵字） ──
  [沒有 (status, category_id, price)]
    type=ref    key=fk_products_category               rows=    876  Extra=Using where; Using filesort
    p50 0.935 ms
    實際：-> Limit: 20 row(s)  (actual time=0.592..0.594 rows=20 loops=1)
        -> Sort: products.price, limit input to 20 row(s) per chunk  (actual time=0.592..0.593 rows=20 loops=1)
        -> Filter: ((products.`status` = 'ON_SALE') and (products.price between 100 and 2000) and (products.`name` like '%耳機%'))  (actual time=0.0429..0.528 rows=684 loops=1)
        -> Index lookup on products using fk_products_category (category_id=11)  (actual time=0.0421..0.394 rows=876 loops=1)
  [有 (status, category_id, price)]
    type=range  key=idx_products_status_category_price rows=    684  Extra=Using index condition; Using where
    p50 0.316 ms
    實際：-> Limit: 20 row(s)  (actual time=0.0645..0.0689 rows=20 loops=1)
        -> Filter: (products.`name` like '%耳機%')  (actual time=0.0643..0.0677 rows=20 loops=1)
        -> Index range scan on products using idx_products_status_category_price over (status = 'ON_SALE' AND category_id = 11 AND 100.00 <= price <= 2000.00), with index condition: (...)  (actual time=0.0637..0.0653 rows=20 loops=1)
```

**讀 `EXPLAIN ANALYZE`：由下往上讀，看每一步的 `rows=`（實際列數）。**

**「我的訂單」三個版本：**

| 索引 | 實際讀了幾列 | 排序 | p50 |
|---|---|---|---|
| 沒有 | **100,000**（全表） → 過濾出 3,000 | `Using filesort`（排 3,000 列取前 20） | 20.7 ms |
| `(buyer_id)` | **3,000**（這位買家的全部） | `Using filesort`（排 3,000 列） | 2.2 ms |
| `(buyer_id, created_at)` | **20** | **沒有排序** —— `Backward index scan`（倒著讀索引） | **0.39 ms** |

單欄索引已經快了 9 倍，為什麼還要複合索引？看「實際讀了幾列」：**3,000 → 20**。
單欄索引找到的 3,000 列在索引裡是依**主鍵**排的，要全部讀出來、依 `created_at` 排序，才知道最新的 20 筆是哪些。
複合索引裡，`buyer_id = 1001` 的那一段**已經依 `created_at` 排好了** —— 從尾巴倒著讀 20 列就結束（`LIMIT 20` 直接生效）。

**這個差距跟買家的訂單數成正比。** 一般買家（平均 5 張訂單）三個版本都在 1 ms 以內，**只有重度使用者看得出差別**。見 2.7.3。

**加上 `status = 'CANCELLED'` 篩選：不需要把 `status` 加進索引。**

`Index lookup ... rows=128` → `Filter ... rows=20`：倒著讀了 128 列索引，過濾出 20 筆已取消的 —— 0.43 ms。
因為已取消的訂單佔 15%，平均每 6～7 列就有一筆。**只有當篩選條件非常稀少時**（例如一個 3,000 張訂單的買家，只有 1 張是 `PICKING`），`(buyer_id, status, created_at)` 才值得多建一個索引。本專題不建。

**逾時掃描：`Covering index range scan`。**

「covering」代表**所需的欄位全部在索引裡**（`SELECT id` —— InnoDB 的次要索引自帶主鍵），完全不用回表。
沒有索引時，每 30 秒一次的排程要掃 10 萬列（16 ms）；有索引只讀 25 列（0.24 ms）。
**16 ms 看起來不多，但它每 30 秒一次、而且表會長大** —— 0.6.1 算過三年 550 萬張訂單，那時候就是每 30 秒掃一次 550 萬列。

**賣家報表：範圍掃描，10,928 列。**

有索引時 5.9 ms，實際讀了 10,928 列（這個賣家 90 天的全部訂單）—— 報表**本來就要讀全部**，索引只是讓它不用讀其他賣家的 89,072 列。
注意 `rows=20900` 是最佳化器的**估計**，實際是 10,928 —— `EXPLAIN` 的 `rows` 是估計值，`EXPLAIN ANALYZE` 的 `actual rows` 才是真的。

> ⚠️ **這一段的數字，只有在 2026-09-29 前後跑才重現得出來。**
> 種子資料的「現在」固定在 `SEED_NOW = 2026-09-29T04:00:00Z`（2.8.2），但 `C7IndexPlanningTest` 的報表查詢用的是**真的** `NOW(3) - INTERVAL 90 DAY` ——
> 上面輸出裡的 `'2026-07-01 09:07:03.287'`，代表它是在 2026-09-29 跑的。
> 之後才跑的人，90 天的窗口會往後移、蓋到的種子訂單越來越少：10,928 列與 5.9 ms 都會變小，**2026-12-28 之後是 0 列** —— 有沒有索引看起來「都一樣快」，其實是因為沒有資料。
> 逾時掃描那一段不受影響：25 張 `PENDING_PAYMENT` 的付款期限都在 `SEED_NOW` 之後 15 分鐘內，對之後的任何時間都已經過期。
> 要自己重現這一段，把報表查詢裡的 `NOW(3)` 換成 `SEED_NOW` 的值（`'2026-09-29 04:00:00'`）。
> 這跟 2.8.2 的原則一是同一件事：**種子資料固定了「現在」，查詢也要用同一個「現在」。**

> 📌 **修法：C7 改成用 `SEED_NOW`。** 參考實作的 `ch02` 分支上還是改之前的寫法。報表那一句改成綁參數：
>
> ```java
> compare("US-RPT-1 賣家 90 天報表的範圍（最大的賣家）", """
>         SELECT COUNT(*), SUM(total_amount) FROM orders
>          WHERE seller_id = ? AND created_at >= ? - INTERVAL 90 DAY""",
>         /* ……兩組索引照舊…… */, 2L, Timestamp.from(SeedData.SEED_NOW));   // SeedData 與 SEED_NOW 改成 public（C7 在另一個套件）
> ```
>
> 綁 `Timestamp`：連線是 `connectionTimeZone=UTC`，跟 `SeedData` 寫入 `created_at` 的方式一樣，送出去的就是 `'2026-09-29 04:00:00'`。逾時掃描那一句照舊用 `NOW(3)`（上面說過，它不受影響）。
> 在第 09 章結束時的程式碼上、一個全新的資料庫灌好種子資料之後重跑：
>
> ```
>     type=range  key=idx_orders_seller_created          rows=  20900  Extra=Using index condition
>     p50 5.508 ms
>     實際：-> Aggregate: count(0), sum(orders.total_amount)  (cost=11495 rows=1) (actual time=5.18..5.18 rows=1 loops=1)
>         -> Index range scan on orders using idx_orders_seller_created over (seller_id = 2 AND '2026-07-01 04:00:00.000' <= created_at), …
> ```
>
> 10,928 列 —— 跟上面一樣，而跑的那天已經是 2026-10-12。同一個資料庫、同一天，用 `NOW(3)` 數一次：**9,454 列**，窗口已經開始往後移了。
> （那一次的其他段落跟 2.7.2 不一樣，原因都在後面的章節：逾時掃描是 0 列 —— 第 04 章起應用程式一啟動，逾時排程就把那 25 張取消了；「沒有 buyer 相關索引」那一組改走 `idx_orders_created` —— 第 06 章的 V12 加了它。另外 C7 開關索引是 DDL，第 09 章 INV-5（9.11）之後應用程式的帳號沒有這個權限，改用 root 執行。）

**商品搜尋：有沒有複合索引都很快。**

1 萬個商品，就算退回用外鍵自動建的 `fk_products_category`，也只要 0.94 ms。複合索引讓它變成 0.32 ms。
注意 `name LIKE '%耳機%'` 永遠只是 `Filter` —— 前後都有 `%` 的 `LIKE` 用不了 B-tree 索引。
0.7 第 9 項「不做全文搜尋引擎」的理由在這裡有了數字：**1 萬個商品，`LIKE` 掃一遍 876 列、0.5 ms**。

### 2.7.3 看最壞的那個使用者

種子資料裡刻意放了三位重度買家（2.8.2）：`buyer 1001` 有 3,000 張訂單、`1002` 有 1,000 張、`1003` 有 300 張。其他 19,997 位平均 4.8 張。

如果種子資料是「每位買家隨機 5 張」，上面的實驗會得出結論：「三種索引都小於 1 ms，單欄索引就夠了」。
**然後上線後，某個代購帳號的「我的訂單」頁面要 20 ms、而且隨著他下單越多越慢。**

> 📌 **索引設計要看分布的尾巴，不是平均。** 種子資料的分布決定了你的效能測試能發現什麼 ——
> 一份「每個人都一樣」的種子資料，永遠測不出「某個人特別多」的問題。這跟 0.11 的「p99 而不是平均」是同一件事。

### 2.7.4 索引的寫入代價

索引讓讀變快，代價是**每一次寫入都要更新每一個索引**。`orders` 有主鍵 + 1 個 UNIQUE + 4 個次要索引，代價是多少？

```java
package com.example.shop.ch02;

import com.zaxxer.hikari.HikariDataSource;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.ArrayList;
import java.util.List;
import java.util.Random;

/** 2.7.4 索引不是免費的：同樣插入 10 萬張訂單，orders 的索引全開 vs 只有主鍵 */
@Tag("experiment")
class C8IndexWriteCostTest {

    @Test
    void indexWriteCost() {
        try (HikariDataSource ds = new HikariDataSource()) {
            ds.setJdbcUrl("jdbc:mysql://localhost:3306/shop_lab?useSSL=false&allowPublicKeyRetrieval=true&connectionTimeZone=UTC&rewriteBatchedStatements=true");
            ds.setUsername("shop");
            ds.setPassword("shop");
            JdbcTemplate jdbc = new JdbcTemplate(ds);
            TransactionTemplate tx = new TransactionTemplate(new DataSourceTransactionManager(ds));
            System.out.println("═══ 2.7.4 索引的寫入代價：插入 10 萬張訂單（每 1,000 張一個交易） ═══");
            for (int round = 0; round < 2; round++) {                     // 第一輪是暖機，只印第二輪
                for (String variant : new String[]{"只有主鍵", "主鍵 + UNIQUE(order_no)", "orders 的全部 6 個索引"}) {
                    jdbc.execute("DROP TABLE IF EXISTS c8_orders");
                    jdbc.execute("CREATE TABLE c8_orders LIKE shop.orders");        // 同樣的欄位、同樣的 CHECK、同樣的索引
                    if (!variant.startsWith("orders")) {
                        for (String idx : List.of("idx_orders_buyer_created", "idx_orders_seller_created",
                                "idx_orders_status_deadline", "idx_orders_status_shipped")) jdbc.execute("DROP INDEX " + idx + " ON c8_orders");
                        if (variant.equals("只有主鍵")) jdbc.execute("DROP INDEX uk_orders_order_no ON c8_orders");
                    }
                    Random r = new Random(7);
                    long t0 = System.nanoTime();
                    for (int base = 0; base < 100_000; base += 1000) {
                        List<Object[]> rows = new ArrayList<>(1000);
                        for (int i = base; i < base + 1000; i++) {
                            rows.add(new Object[]{"20260929-%06d".formatted(i), 1001 + r.nextInt(20_000), 2 + r.nextInt(500),
                                    r.nextInt(100) < 10 ? "PENDING_PAYMENT" : "COMPLETED", 199});
                        }
                        tx.executeWithoutResult(s -> jdbc.batchUpdate("""
                                INSERT INTO c8_orders (order_no, buyer_id, seller_id, status, total_amount, payment_deadline, paid_at,
                                                       carrier, tracking_no, shipped_at, completed_at)
                                VALUES (?, ?, ?, ?, ?, NOW(3), NOW(3), 'x', 'x', NOW(3), NOW(3))""", rows));
                    }
                    long ms = (System.nanoTime() - t0) / 1_000_000;
                    if (round == 1) System.out.printf("  %-26s %,6d ms   %,7.0f 列/秒%n", variant, ms, 100_000 / (ms / 1000.0));
                }
            }
        }
    }
}
```

```
═══ 2.7.4 索引的寫入代價：插入 10 萬張訂單（每 1,000 張一個交易） ═══
  只有主鍵                        1,250 ms    80,000 列/秒
  主鍵 + UNIQUE(order_no)         1,447 ms    69,109 列/秒
  orders 的全部 6 個索引          2,136 ms    46,816 列/秒
```

**主鍵之外多出來的 5 個索引，讓批次寫入的吞吐掉了 41%**（80,000 → 46,816 列/秒），平均每個約 8%。

放回本專題的量級：一般下單 0.2 張/秒（0.6.1），這 41% 完全感覺不到；
而搶購時的瓶頸是**熱點行鎖**（0.11），不是 `orders` 的索引維護 —— `orders` 的 INSERT 分散在不同的列上，不會搶同一把鎖。
**所以 `orders` 的 6 個索引是划算的。** 但這個數字讓「再加一個索引吧」有了價格：每一個都要能指回 2.7.1 表格裡的某一列。

> 📌 注意 UNIQUE 本身就不便宜：只加一個 `UNIQUE(order_no)`，插入時間就 +16%（1,250 → 1,447 ms，多 197 ms）；
> 另外 4 個一般索引合計多 689 ms，平均每個約 172 ms —— UNIQUE 比一個一般索引貴一點。插入前要先確認沒有重複，那個確認要讀索引頁；
> 如果**真的撞到**重複的值，InnoDB 還會在那筆索引記錄上加一把共享的 next-key 鎖。
> 第 04 章的冪等鍵（`idempotency_keys` 的主鍵）會碰到這把鎖的另一面。

### 2.7.5 invisible index：不刪索引也能做實驗

2.7.2 的實驗沒有 `DROP INDEX`，而是：

```sql
ALTER TABLE orders ALTER INDEX idx_orders_buyer_created INVISIBLE;   -- 最佳化器不再使用它（但寫入時仍然維護它）
ALTER TABLE orders ALTER INDEX idx_orders_buyer_created VISIBLE;     -- 恢復
```

這兩句都是**只改中繼資料**的操作，在 10 萬列的表上也是瞬間完成。

它在正式環境有一個重要的用途：**刪索引之前的試用期**。

```
懷疑某個索引沒有用
→ 設成 INVISIBLE，觀察一週（慢查詢日誌、p99）
→ 沒有任何查詢變慢 → 寫一個 migration DROP 它
→ 有查詢變慢 → 一秒內改回 VISIBLE，不用重建索引
```

直接 `DROP INDEX` 的話，發現刪錯時要重建 —— 在一張 5,000 萬列的 `inventory_ledger` 上，那是幾分鐘的 I/O（[07-mysql/06](../07-mysql/06-schema-migration-flyway.md) 的線上 DDL）。

**但它也有一個陷阱**（上面的 ⚠️）：invisible 的索引**不會報任何錯**。忘了改回來，查詢就默默變慢。
所以每一次實驗之後、以及第 09 章的上線檢查清單裡，都有這一句：

```sql
SELECT table_name, index_name FROM information_schema.statistics
 WHERE table_schema = DATABASE() AND is_visible = 'NO';
-- 正式環境：這個查詢應該永遠回傳 0 列，除非你正在做「刪除前的試用期」
```


---

## 2.8 種子資料

### 2.8.1 三種資料，三個地方

「種子資料」其實是三種不同的東西，它們的生命週期完全不同：

| 種類 | 例子 | 正式環境需要嗎 | 放哪裡 |
|---|---|---|---|
| **參考資料** | 商品分類 | ✅ 需要 —— 沒有分類就不能上架商品 | **Flyway versioned migration**（V9） |
| **示範資料** | 帳號、商品、10 萬張訂單 | ❌ **絕對不能出現** | `src/test` 裡的產生器（本節） |
| **測試資料** | 某個測試需要的 3 張訂單 | ❌ | 測試自己建、自己清（`@Sql`、交易回滾） |

**參考資料為什麼放 versioned migration，而不是 `R__`（repeatable）？** Flyway 的 `R__` 檔案在內容改變時會**重新執行一次** ——
對 `INSERT INTO categories` 來說，重新執行就是「主鍵重複」。參考資料的每一次變更（新增一個分類、改一個名稱）都是一個新的 V 檔。

**示範資料為什麼不放 Flyway？** 你可以用 `spring.flyway.locations` 讓 local profile 多讀一個 `db/local` 資料夾 —— 但那代表**正式環境的 jar 裡有一份示範資料的 SQL**，
只差一個設定就會被執行。放在 `src/test` 裡，它**物理上就不在 jar 裡**（Maven 打包不含測試類別），不可能在正式環境被誤執行。

### 2.8.2 `SeedData`：10 萬張訂單，而且滿足每一條不變量

設計的四個原則：

1. **可重現**：固定的亂數種子（`new Random(2026)`）與固定的「現在」（`SEED_NOW = 2026-09-29T04:00:00Z`）。每個人跑出來的資料**一模一樣** —— 這一章與下兩章的實驗數字才對得上。
2. **分布要像真的**：賣家的銷量是 Zipf 分布（少數賣家佔大部分訂單）；**三位重度買家**（3,000 / 1,000 / 300 張，2.7.3 需要他們）；
   下單時間依台北時間的**每小時權重**（晚上 9 點最高，**凌晨 0～8 點也有** —— 第 03 章的時區事故需要它們）。
3. **狀態要走過狀態機**：每張訂單依它的「年齡」決定走到哪一個狀態，每一次轉移都寫一筆 `order_status_history`，
   付款、退款、預留、庫存帳都跟著狀態寫。**種子資料也要滿足 0.5.3 的轉移表與 2.5 的每一條 CHECK。**
4. **最後再算庫存**：先知道每個商品被賣掉、被預留了多少，才能反推一個滿足 INV-1 的期初量。

```java
package com.example.shop.tools;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.sql.Timestamp;
import java.time.*;
import java.time.format.DateTimeFormatter;
import java.util.*;

/**
 * 2.8 本機的種子資料：10 萬張訂單，而且「滿足每一條不變量」。
 *
 *   mvn test -Pseed -Dtest=SeedData      （類別名不是 *Test，surefire 預設不會掃到它，所以要用 -Dtest 指名）
 *
 * 固定的亂數種子與固定的「現在」（SEED_NOW）：每個人產生出來的資料一模一樣。
 * 只寫本機的 shop 資料庫；正式環境永遠不會跑它（它在 src/test 裡，不會進 jar）。
 */
@Tag("seed")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE)
class SeedData {

    static final Instant SEED_NOW = Instant.parse("2026-09-29T04:00:00Z");      // 台北時間 2026-09-29 12:00
    static final ZoneId TAIPEI = ZoneId.of("Asia/Taipei");
    static final int DAYS = 90;
    static final int SELLERS = 500, PRODUCTS_PER_SELLER = 20, BUYERS = 20_000, ORDERS = 100_000;
    static final long FIRST_SELLER = 2, FIRST_BUYER = 1001;
    /** 本機所有種子帳號的密碼都是 password123（BCrypt cost 10）。算 2 萬次 BCrypt 要十幾到二十幾分鐘，所以共用一個雜湊值 */
    static final String PASSWORD_HASH = "$2a$10$.Qqx4uLp33ami.WRNP./QedMLbVyOPUqXUuwqU7cbdiY9zOafkQQO";
    static final long[] LEAF_CATEGORIES = {11, 12, 13, 21, 22, 23, 31, 32, 41, 42, 51, 52};
    static final Map<Long, String[]> WORDS = Map.ofEntries(
            Map.entry(11L, new String[]{"無線藍牙耳機", "降噪耳罩式耳機", "運動頸掛耳機"}),
            Map.entry(12L, new String[]{"快充充電器", "磁吸手機殼", "行動電源"}),
            Map.entry(13L, new String[]{"機械鍵盤", "無線滑鼠", "USB-C 集線器"}),
            Map.entry(21L, new String[]{"素面 T 恤", "牛仔褲", "連帽外套"}),
            Map.entry(22L, new String[]{"雪紡洋裝", "針織上衣", "高腰長裙"}),
            Map.entry(23L, new String[]{"慢跑鞋", "帆布鞋", "拖鞋"}),
            Map.entry(31L, new String[]{"不沾平底鍋", "陶瓷刀", "保鮮盒組"}),
            Map.entry(32L, new String[]{"記憶枕", "天絲床包", "羽絨被"}),
            Map.entry(41L, new String[]{"保濕精華", "防曬乳", "洗面乳"}),
            Map.entry(42L, new String[]{"霧面唇膏", "眼影盤", "氣墊粉餅"}),
            Map.entry(51L, new String[]{"綜合堅果", "手工餅乾", "海苔脆片"}),
            Map.entry(52L, new String[]{"冷泡茶包", "濾掛咖啡", "氣泡水"}));
    static final BigDecimal[] PRICES = Arrays.stream(new String[]{
            "99", "149", "199", "299", "349", "399", "499", "590", "690", "799", "990", "1290", "1490", "1990", "2490", "3990", "129.5", "259.9"})
            .map(BigDecimal::new).map(p -> p.setScale(2, RoundingMode.HALF_UP)).toArray(BigDecimal[]::new);
    /** 台北時間每個小時的下單權重：晚上 9 點最高，凌晨也有（2.4.3 與第 03 章的時區事故需要它們） */
    static final int[] HOUR_WEIGHT = {3, 2, 1, 1, 1, 1, 2, 3, 4, 5, 6, 6, 7, 6, 6, 6, 6, 7, 8, 9, 11, 13, 12, 7};

    @Autowired JdbcTemplate jdbc;
    @Autowired TransactionTemplate tx;

    final Random r = new Random(2026);

    record Product(long id, long sellerId, String name, BigDecimal price, String status) {}

    static final class Line { long productId; String name; BigDecimal unitPrice; int qty; }

    static final class Order {
        long id, buyerId, sellerId;
        String orderNo, status, cancelReason;
        Instant createdAt, paidAt, pickAt, shippedAt, completedAt, cancelledAt;
        boolean autoCompleted;
        String refundReason;
        final List<Line> lines = new ArrayList<>();
        BigDecimal total = BigDecimal.ZERO;
        Instant updatedAt() {
            return Collections.max(Arrays.asList(createdAt, paidAt == null ? createdAt : paidAt,
                    pickAt == null || pickAt.isAfter(SEED_NOW) ? createdAt : pickAt,
                    shippedAt == null || !"SHIPPED,COMPLETED".contains(status) ? createdAt : shippedAt,
                    completedAt == null || !status.equals("COMPLETED") ? createdAt : completedAt,
                    cancelledAt == null ? createdAt : cancelledAt));
        }
    }

    @Test
    void seed() {
        long t0 = System.nanoTime();
        truncate();
        seedUsers();
        List<Product> products = seedProducts();
        List<Order> orders = generateOrders(products);
        writeOrders(orders);
        seedInventory(products, orders);
        System.out.printf("種子資料完成：%,.1f 秒%n", (System.nanoTime() - t0) / 1e9);
        for (String t : List.of("users", "user_roles", "products", "inventory", "orders", "order_items",
                "inventory_reservations", "inventory_ledger", "order_status_history", "payments", "refunds")) {
            System.out.printf("  %-24s %,9d 列%n", t, jdbc.queryForObject("SELECT COUNT(*) FROM " + t, Long.class));
        }
    }

    void truncate() {
        jdbc.execute("SET FOREIGN_KEY_CHECKS = 0");
        for (String t : List.of("refunds", "payments", "order_status_history", "idempotency_keys", "order_items", "orders",
                "inventory_ledger", "inventory_reservations", "inventory", "cart_items", "products",
                "refresh_tokens", "user_roles", "users", "notifications", "outbox_events", "processed_messages", "audit_logs")) {
            jdbc.execute("TRUNCATE TABLE " + t);
        }
        jdbc.execute("SET FOREIGN_KEY_CHECKS = 1");
    }

    static Timestamp ts(Instant i) { return i == null ? null : Timestamp.from(i); }

    void batch(String sql, List<Object[]> rows) {
        for (int i = 0; i < rows.size(); i += 5_000) {
            List<Object[]> chunk = rows.subList(i, Math.min(i + 5_000, rows.size()));
            tx.executeWithoutResult(s -> jdbc.batchUpdate(sql, chunk));
        }
    }

    void seedUsers() {
        Instant created = SEED_NOW.minus(Duration.ofDays(180));
        List<Object[]> users = new ArrayList<>(), roles = new ArrayList<>();
        users.add(new Object[]{1L, "admin@example.com", PASSWORD_HASH, "管理員", ts(created), ts(created)});
        roles.add(new Object[]{1L, "ADMIN", ts(created), null});
        for (int i = 0; i < SELLERS; i++) {
            long id = FIRST_SELLER + i;
            users.add(new Object[]{id, "seller%03d@example.com".formatted(i + 1), PASSWORD_HASH, "賣家 %03d".formatted(i + 1), ts(created), ts(created)});
            roles.add(new Object[]{id, "BUYER", ts(created), null});
            roles.add(new Object[]{id, "SELLER", ts(created), 1L});
        }
        for (int i = 0; i < BUYERS; i++) {
            long id = FIRST_BUYER + i;
            users.add(new Object[]{id, "buyer%05d@example.com".formatted(i + 1), PASSWORD_HASH, "買家 %05d".formatted(i + 1), ts(created), ts(created)});
            roles.add(new Object[]{id, "BUYER", ts(created), null});
        }
        batch("INSERT INTO users (id, email, password_hash, display_name, created_at, updated_at) VALUES (?,?,?,?,?,?)", users);
        batch("INSERT INTO user_roles (user_id, role, granted_at, granted_by) VALUES (?,?,?,?)", roles);
    }

    List<Product> seedProducts() {
        List<Product> ps = new ArrayList<>();
        List<Object[]> rows = new ArrayList<>();
        long id = 1;
        for (int s = 0; s < SELLERS; s++) {
            long sellerId = FIRST_SELLER + s;
            for (int k = 0; k < PRODUCTS_PER_SELLER; k++, id++) {
                long cat = LEAF_CATEGORIES[r.nextInt(LEAF_CATEGORIES.length)];
                String[] w = WORDS.get(cat);
                String name = w[r.nextInt(w.length)] + " #" + id;
                BigDecimal price = PRICES[r.nextInt(PRICES.length)];
                double u = r.nextDouble();
                String status = u < 0.02 ? "DRAFT" : u < 0.05 ? "OFF_SHELF" : "ON_SALE";
                Instant created = SEED_NOW.minus(Duration.ofDays(100 + r.nextInt(20)));
                ps.add(new Product(id, sellerId, name, price, status));
                rows.add(new Object[]{id, sellerId, cat, name, "「" + name + "」的商品說明。", price, status, id == 1, ts(created), ts(created)});
            }
        }
        batch("""
              INSERT INTO products (id, seller_id, category_id, name, description, price, status, hot, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)""", rows);
        return ps;
    }

    /** Zipf 分布：排名第 k 的權重 = 1 / k^s */
    static double[] zipfCdf(int n, double s) {
        double[] cdf = new double[n];
        double sum = 0;
        for (int k = 1; k <= n; k++) { sum += 1 / Math.pow(k, s); cdf[k - 1] = sum; }
        for (int k = 0; k < n; k++) cdf[k] /= sum;
        return cdf;
    }

    static int pick(double[] cdf, double u) {
        int i = Arrays.binarySearch(cdf, u);
        return i >= 0 ? i : Math.min(-i - 1, cdf.length - 1);
    }

    Instant randomCreatedAt() {
        LocalDate today = SEED_NOW.atZone(TAIPEI).toLocalDate();
        while (true) {
            LocalDate day = today.minusDays(r.nextInt(DAYS));
            int total = Arrays.stream(HOUR_WEIGHT).sum(), x = r.nextInt(total), hour = 0;
            while (x >= HOUR_WEIGHT[hour]) x -= HOUR_WEIGHT[hour++];
            Instant at = day.atTime(hour, r.nextInt(60), r.nextInt(60)).atZone(TAIPEI).toInstant().plusMillis(r.nextInt(1000));
            if (at.isBefore(SEED_NOW.minus(Duration.ofMinutes(16)))) return at;
        }
    }

    static Instant plus(Instant i, Random r, Duration min, Duration max) {
        long span = max.toMillis() - min.toMillis();
        return i.plusMillis(min.toMillis() + (long) (r.nextDouble() * span));
    }

    List<Order> generateOrders(List<Product> products) {
        Map<Long, List<Product>> bySeller = new HashMap<>();
        for (Product p : products) if (!p.status().equals("DRAFT")) bySeller.computeIfAbsent(p.sellerId(), k -> new ArrayList<>()).add(p);
        double[] sellerCdf = zipfCdf(SELLERS, 0.9);
        List<Order> os = new ArrayList<>(ORDERS);
        for (int i = 0; i < ORDERS; i++) {
            Order o = new Order();
            o.buyerId = i < 3000 ? FIRST_BUYER : i < 4000 ? FIRST_BUYER + 1 : i < 4300 ? FIRST_BUYER + 2   // 三位重度買家
                    : FIRST_BUYER + 3 + r.nextInt(BUYERS - 3);
            o.sellerId = FIRST_SELLER + pick(sellerCdf, r.nextDouble());
            o.createdAt = i < 25 ? SEED_NOW.minus(Duration.ofSeconds(30 + r.nextInt(14 * 60))) : randomCreatedAt();  // 25 張還在付款期限內
            List<Product> shelf = new ArrayList<>(bySeller.get(o.sellerId));
            Collections.shuffle(shelf, r);
            int n = 1 + Math.min(r.nextInt(5), shelf.size() - 1);
            for (int k = 0; k < n; k++) {
                Product p = shelf.get(k);
                Line l = new Line();
                l.productId = p.id();
                l.name = p.name();
                l.unitPrice = r.nextDouble() < 0.05 ? p.price().multiply(new BigDecimal("0.9")).setScale(2, RoundingMode.HALF_UP) : p.price();
                double q = r.nextDouble();
                l.qty = q < 0.75 ? 1 : q < 0.93 ? 2 : 3;
                o.lines.add(l);
                o.total = o.total.add(l.unitPrice.multiply(BigDecimal.valueOf(l.qty)));
            }
            decideLifecycle(o, i < 25);
            os.add(o);
        }
        os.sort(Comparator.comparing(o -> o.createdAt));                  // AUTO_INCREMENT 的 id 會隨時間遞增
        Set<String> used = new HashSet<>();
        int collisions = 0;
        DateTimeFormatter day = DateTimeFormatter.ofPattern("yyyyMMdd");
        for (int i = 0; i < os.size(); i++) {
            Order o = os.get(i);
            o.id = i + 1;
            String prefix = o.createdAt.atZone(TAIPEI).format(day);          // 編號上的日期是台北日期（給人看的）
            while (true) {
                String no = prefix + "-%06d".formatted(r.nextInt(1_000_000));
                if (used.add(no)) { o.orderNo = no; break; }
                collisions++;
            }
        }
        System.out.printf("訂單編號：隨機 6 碼，%,d 張訂單撞號 %d 次（重抽）%n", os.size(), collisions);
        return os;
    }

    void decideLifecycle(Order o, boolean pending) {
        if (pending) { o.status = "PENDING_PAYMENT"; return; }
        double u = r.nextDouble();
        if (u < 0.12) { cancel(o, "PAYMENT_TIMEOUT", o.createdAt.plus(Duration.ofMinutes(15)).plusMillis(r.nextInt(60_000))); return; }
        if (u < 0.15) { cancel(o, "BUYER", plus(o.createdAt, r, Duration.ofMinutes(1), Duration.ofMinutes(14))); return; }
        o.paidAt = plus(o.createdAt, r, Duration.ofMinutes(1), Duration.ofMinutes(10));
        double v = r.nextDouble();
        if (v < 0.010) {
            Instant at = plus(o.paidAt, r, Duration.ofMinutes(1), Duration.ofMinutes(60));
            if (at.isBefore(SEED_NOW)) { cancel(o, "BUYER", at); o.refundReason = "BUYER_CANCEL"; return; }
        } else if (v < 0.015) {
            Instant at = plus(o.paidAt, r, Duration.ofHours(1), Duration.ofHours(24));
            if (at.isBefore(SEED_NOW)) { cancel(o, "SELLER_OUT_OF_STOCK", at); o.refundReason = "SELLER_CANCEL"; return; }
        }
        o.pickAt = plus(o.paidAt, r, Duration.ofHours(1), Duration.ofHours(12));
        o.shippedAt = plus(o.pickAt, r, Duration.ofHours(1), Duration.ofHours(12));
        o.autoCompleted = r.nextDouble() < 0.4;
        o.completedAt = o.autoCompleted ? o.shippedAt.plus(Duration.ofDays(7)) : plus(o.shippedAt, r, Duration.ofDays(1), Duration.ofDays(6));
        o.status = o.pickAt.isAfter(SEED_NOW) ? "PAID" : o.shippedAt.isAfter(SEED_NOW) ? "PICKING"
                : o.completedAt.isAfter(SEED_NOW) ? "SHIPPED" : "COMPLETED";
    }

    static void cancel(Order o, String reason, Instant at) {
        o.status = "CANCELLED";
        o.cancelReason = reason;
        o.cancelledAt = at;
    }

    static String reservationStatus(String orderStatus) {
        return switch (orderStatus) {
            case "PENDING_PAYMENT" -> "HELD";
            case "PAID", "PICKING" -> "CONFIRMED";
            case "SHIPPED", "COMPLETED" -> "CONSUMED";
            default -> "RELEASED";
        };
    }

    void writeOrders(List<Order> os) {
        List<Object[]> orders = new ArrayList<>(), items = new ArrayList<>(), res = new ArrayList<>(),
                hist = new ArrayList<>(), pays = new ArrayList<>(), refunds = new ArrayList<>();
        long itemId = 1, resId = 1, payId = 1, refundId = 1;
        for (Order o : os) {
            boolean shipped = o.status.equals("SHIPPED") || o.status.equals("COMPLETED");
            orders.add(new Object[]{o.id, o.orderNo, o.buyerId, o.sellerId, o.status, o.total,
                    ts(o.createdAt.plus(Duration.ofMinutes(15))), o.cancelReason,
                    shipped ? "黑貓宅急便" : null, shipped ? "TW%010d".formatted(o.id) : null,
                    ts(o.paidAt), ts(shipped ? o.shippedAt : null), ts(o.status.equals("COMPLETED") ? o.completedAt : null),
                    ts(o.cancelledAt), ts(o.createdAt), ts(o.updatedAt())});
            String rs = reservationStatus(o.status);
            for (Line l : o.lines) {
                items.add(new Object[]{itemId++, o.id, l.productId, l.name, l.unitPrice, l.qty});
                res.add(new Object[]{resId++, o.id, l.productId, l.qty, rs, ts(o.createdAt), ts(o.updatedAt())});
            }
            hist.add(new Object[]{o.id, null, "PENDING_PAYMENT", "PLACE_ORDER", "BUYER", o.buyerId, ts(o.createdAt)});
            if (o.paidAt != null) {
                hist.add(new Object[]{o.id, "PENDING_PAYMENT", "PAID", "PAY_SUCCEEDED", "PAYMENT_PROVIDER", null, ts(o.paidAt)});
                pays.add(new Object[]{payId, o.id, o.total, "SUCCEEDED", "SIMULATED", "sim-%08d".formatted(o.id),
                        ts(o.paidAt.minusSeconds(30)), ts(o.paidAt)});
                if (o.refundReason != null) {
                    refunds.add(new Object[]{refundId++, payId, o.id, o.total, o.refundReason, "SUCCEEDED", 1,
                            "simr-%08d".formatted(o.id), ts(o.cancelledAt), ts(o.cancelledAt.plusSeconds(60))});
                }
                payId++;
            }
            if (o.status.equals("CANCELLED")) {
                String from = o.paidAt == null ? "PENDING_PAYMENT" : "PAID";
                String event = switch (o.cancelReason) {
                    case "PAYMENT_TIMEOUT" -> "PAYMENT_TIMEOUT";
                    case "BUYER" -> "BUYER_CANCEL";
                    default -> "SELLER_CANCEL";
                };
                String actor = switch (event) { case "PAYMENT_TIMEOUT" -> "SYSTEM"; case "BUYER_CANCEL" -> "BUYER"; default -> "SELLER"; };
                Long actorId = actor.equals("BUYER") ? (Long) o.buyerId : actor.equals("SELLER") ? (Long) o.sellerId : null;
                hist.add(new Object[]{o.id, from, "CANCELLED", event, actor, actorId, ts(o.cancelledAt)});
            }
            if (List.of("PICKING", "SHIPPED", "COMPLETED").contains(o.status))
                hist.add(new Object[]{o.id, "PAID", "PICKING", "START_PICKING", "SELLER", o.sellerId, ts(o.pickAt)});
            if (shipped)
                hist.add(new Object[]{o.id, "PICKING", "SHIPPED", "SHIP", "SELLER", o.sellerId, ts(o.shippedAt)});
            if (o.status.equals("COMPLETED"))
                hist.add(new Object[]{o.id, "SHIPPED", "COMPLETED", o.autoCompleted ? "AUTO_COMPLETE" : "CONFIRM_RECEIPT",
                        o.autoCompleted ? "SYSTEM" : "BUYER", o.autoCompleted ? null : (Long) o.buyerId, ts(o.completedAt)});
        }
        batch("""
              INSERT INTO orders (id, order_no, buyer_id, seller_id, status, total_amount, payment_deadline, cancel_reason,
                                  carrier, tracking_no, paid_at, shipped_at, completed_at, cancelled_at, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", orders);
        batch("INSERT INTO order_items (id, order_id, product_id, product_name, unit_price, quantity) VALUES (?,?,?,?,?,?)", items);
        batch("INSERT INTO order_status_history (order_id, from_status, to_status, event, actor_type, actor_id, created_at) VALUES (?,?,?,?,?,?,?)", hist);
        batch("""
              INSERT INTO payments (id, order_id, amount, status, provider, provider_txn_id, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?)""", pays);
        batch("""
              INSERT INTO refunds (id, payment_id, order_id, amount, reason, status, attempts, provider_refund_id, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)""", refunds);
        this.pendingReservations = res;
    }

    List<Object[]> pendingReservations;

    /** 庫存最後才寫：先知道每個商品被賣掉、被預留了多少，才能算出一個滿足 INV-1 的期初量 */
    void seedInventory(List<Product> products, List<Order> orders) {
        Map<Long, int[]> agg = new HashMap<>();                         // [consumed, reserved]
        List<Object[]> ledger = new ArrayList<>();
        for (Order o : orders) {
            for (Line l : o.lines) {
                int[] a = agg.computeIfAbsent(l.productId, k -> new int[2]);
                String ref = "order:" + o.id;
                ledger.add(new Object[]{l.productId, 0, l.qty, "RESERVE", ref, ts(o.createdAt)});
                switch (reservationStatus(o.status)) {
                    case "HELD", "CONFIRMED" -> a[1] += l.qty;
                    case "CONSUMED" -> { a[0] += l.qty; ledger.add(new Object[]{l.productId, -l.qty, -l.qty, "SHIP", ref, ts(o.shippedAt)}); }
                    case "RELEASED" -> ledger.add(new Object[]{l.productId, 0, -l.qty, "RELEASE", ref, ts(o.cancelledAt)});
                }
            }
        }
        List<Object[]> inv = new ArrayList<>(), initial = new ArrayList<>();
        for (Product p : products) {
            int[] a = agg.getOrDefault(p.id(), new int[2]);
            int start = a[0] + a[1] + 20 + r.nextInt(280);                 // 期初量 = 已賣 + 預留中 + 20～300 件
            inv.add(new Object[]{p.id(), start - a[0], a[1], ts(SEED_NOW)});
            initial.add(new Object[]{p.id(), start, 0, "INITIAL", "seed", ts(SEED_NOW.minus(Duration.ofDays(120)))});
        }
        batch("INSERT INTO inventory (product_id, on_hand, reserved, updated_at) VALUES (?,?,?,?)", inv);
        batch("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref, created_at) VALUES (?,?,?,?,?,?)", initial);
        batch("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref, created_at) VALUES (?,?,?,?,?,?)", ledger);
        batch("""
              INSERT INTO inventory_reservations (id, order_id, product_id, quantity, status, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?)""", pendingReservations);
    }
}
```

**幾個值得多看一眼的地方**：

- **`PASSWORD_HASH` 是預先算好的一個 BCrypt 雜湊**（`htpasswd -bnBC 10 "" password123` 產生，把前綴 `$2y$` 改成 `$2a$`，兩者演算法相同）。
  BCrypt cost 10 在一般筆電上一次要數十毫秒（這正是它的目的 —— 讓暴力破解變慢），2 萬個帳號各算一次要**十幾到二十幾分鐘**。共用一個雜湊，2 萬個帳號 0 秒。
- **`os.sort(Comparator.comparing(o -> o.createdAt))` 之後才發 id**：正式環境的 `AUTO_INCREMENT` id 是隨時間遞增的。
  種子資料如果不照時間發 id，「`ORDER BY id DESC` 等於最新的訂單」這個性質就不成立 —— 某些查詢在種子資料上的表現就會跟正式環境不一樣。
- **訂單編號用 `Set<String> used` 在記憶體裡偵測撞號**，並計數。這就是 2.4.4 那個生日問題的實測。
- **`TRUNCATE` 前後的 `SET FOREIGN_KEY_CHECKS = 0 / 1`**：被其他表的外鍵參照的表（`users`、`orders`、`inventory`……）不能直接 `TRUNCATE`（即使子表是空的）。這個開關**只影響這條連線**，而且只在這個工具裡用（但「這條連線」在這段程式碼裡其實沒有被保證，見下面的 ⚠️）。
- **`@Tag("seed")`**：預設的 `mvn test` 不跑它（2.11），要明確用 `-Pseed -Dtest=SeedData`。一個會 `TRUNCATE` 18 張表的「測試」，絕對不能在每次 `mvn test` 時自動執行。

> ⚠️ **`truncate()` 沒有保證它用的是同一條連線。** `jdbc` 背後是 HikariCP 連線池：`SET FOREIGN_KEY_CHECKS = 0`、18 句 `TRUNCATE`、`SET FOREIGN_KEY_CHECKS = 1` 是 20 次**各自借、各自還**連線的呼叫。
> 它現在能動，是因為 Hikari 會優先把同一條執行緒上次還回去的那條連線再借給它 —— 這是連線池的實作細節，不是保證。
> 萬一拿到不同的連線：`TRUNCATE` 會因為外鍵而失敗（看得到的錯）；更糟的是 `FOREIGN_KEY_CHECKS = 0` 留在某一條連線上被還回連線池，之後借到它的 INSERT 都不檢查外鍵（**看不到的錯**）。
> 穩當的寫法是把整段放進同一條連線：`jdbc.execute((ConnectionCallback<Void>) c -> { try (Statement st = c.createStatement()) { ... } return null; })`。
> 上面的 `SeedData` 與參考實作的 `ch02` 分支上還是改之前的寫法；你自己寫的時候，用下面改好的 `truncate()`。
>
> 📌 **改好的 `truncate()`。** 整段改成一個 `ConnectionCallback`，`SET FOREIGN_KEY_CHECKS = 1` 放在 `finally`：
>
> ```java
> void truncate() {
>     jdbc.execute((ConnectionCallback<Void>) c -> {
>         try (Statement st = c.createStatement()) {
>             st.execute("SET FOREIGN_KEY_CHECKS = 0");
>             try {
>                 for (String t : List.of("refunds", "payments", /* ……同樣的 18 張表…… */ "audit_logs")) st.execute("TRUNCATE TABLE " + t);
>             } finally {
>                 st.execute("SET FOREIGN_KEY_CHECKS = 1");    // 中途失敗，這條連線也不會帶著 0 回到連線池
>             }
>         }
>         return null;
>     });
> }
> ```
>
> 在第 09 章結束時的程式碼、一個全新的資料庫上跑 2.8.3，會直接失敗在 `DROP command denied to user 'shop'`：`TRUNCATE` 要 DROP 權限，第 09 章 INV-5（9.11）之後應用程式的帳號只拿 `shop_app` 這個角色，沒有它。所以 `truncate()` 要改用 root（測試清理用的同一個管理帳號，9.11）。改用 root 之後：
>
> ```
> 訂單編號：隨機 6 碼，100,000 張訂單撞號 61 次（重抽）
> 種子資料完成：31.2 秒
>   users                       20,501 列
>   ……（與 2.8.3 相同）
>   order_status_history       447,183 列
>   ……（與 2.8.3 相同）
> ```
>
> 撞號次數與每一張表的列數都跟 2.8.3 一樣，只有 `order_status_history` 多了 125 列：同一份日誌裡，應用程式的排程在灌完的那一刻跑了 `PAYMENT_TIMEOUT`（25 張）與 `AUTO_COMPLETE`（100 張）—— 第 02 章還沒有這兩個排程。

### 2.8.3 跑起來

```bash
mvn test -Pseed -Dtest=SeedData
```

> ⚠️ **只寫 `mvn test -Pseed` 會跑 0 個測試**（`Tests run: 0`）。surefire 預設只掃描名字是 `*Test`、`Test*`、`*Tests`、`*TestCase` 的類別，
> 而 `SeedData` 刻意不叫 `SeedDataTest` —— 它不是測試。`-Dtest=SeedData` 會覆蓋這個預設。
> profile 設對了、tag 也對了，就是什麼都沒跑，而且 `BUILD SUCCESS`。

```
訂單編號：隨機 6 碼，100,000 張訂單撞號 61 次（重抽）
種子資料完成：34.1 秒
  users                       20,501 列
  user_roles                  21,001 列
  products                    10,000 列
  inventory                   10,000 列
  orders                     100,000 列
  order_items                300,468 列
  inventory_reservations     300,468 列
  inventory_ledger           609,822 列
  order_status_history       447,058 列
  payments                    85,031 列
  refunds                      1,296 列
```

**約 190 萬列、34 秒，而且每一列都通過了 24 個 CHECK 與 10 條外鍵。**

**然後跑一次對帳**（2.5.5）：

```bash
mvn test -Dtest=InvariantReconciliationTest
```

```
═══ 對帳（目前 100,000 張訂單）═══
  INV-2 reserved = Σ 有效預留                 差異 0 筆      425 ms
  INV-3 on_hand = Σ ledger.delta_on_hand      差異 0 筆      901 ms
  INV-3' reserved = Σ ledger.delta_reserved   差異 0 筆      529 ms
  訂單金額 = Σ 明細金額                         差異 0 筆      466 ms
  每張訂單至少一個明細                          差異 0 筆      171 ms
```

**撞號 61 次** —— 2.4.4 估算的是 55 次（每天約 1,111 張、90 天），實測在同一個量級。

> 📌 **CHECK 約束在種子資料上的價值。** 這個產生器通過了所有約束 —— 但「通過」這件事本身是有資訊的：
> 它代表 `decideLifecycle()` 產生的每一張訂單，都滿足「取消 ⇔ 有原因」「已付款 ⇒ 有 `paid_at`」「已出貨 ⇒ 有物流資訊」。
> 反過來試一次：把 `writeOrders()` 裡的 `shipped ? "黑貓宅急便" : null` 改成 `null`（「忘了填物流商」）再跑，第一批 INSERT 就停在 `Check constraint 'ck_orders_shipment' is violated.`（練習五）。
> **沒有這些約束，這種 bug 會變成「種子資料裡有 0.2.2 版本一的非法組合」**，然後第 03 章的報表會用這些資料算出一個看起來合理的數字。

---

## 2.9 Flyway 工作流程

### 2.9.1 加進專案

`pom.xml`：

```xml
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-data-jpa</artifactId>
</dependency>
<dependency>
  <groupId>org.flywaydb</groupId>
  <artifactId>flyway-core</artifactId>
</dependency>
<dependency>
  <groupId>org.flywaydb</groupId>
  <artifactId>flyway-mysql</artifactId>
</dependency>
```

> 📌 **`flyway-mysql` 不能少。** Flyway 8.2 起（Maven Central 上 `flyway-mysql` 最早的版本是 8.2.1），MySQL 的支援從 `flyway-core` 拆出去成獨立的模組；本專題用的 9.22.3 當然也是。只有 `flyway-core` 時，啟動會失敗在 `Unsupported Database: MySQL 8.0`。
> Boot 3.2.5 管理的版本是 **Flyway 9.22.3**（兩個都不用寫版本號）。

`application.yml`（共用的那一份）加上：

```yaml
spring:
  jpa:
    open-in-view: false            # 第 03 章會說為什麼
    hibernate:
      ddl-auto: validate           # schema 只由 Flyway 管理（0.6.7）；Hibernate 只負責「檢查」
  flyway:
    locations: classpath:db/migration
```

`spring.flyway.locations` 的值其實就是預設值，**明寫是為了讓讀設定的人知道 migration 在哪裡**。
`open-in-view: false` 現在先關掉，第 03 章的第一個事故就是它。

**啟動順序**：Spring Boot 保證 **Flyway 在 JPA 之前執行**（`FlywayMigrationInitializer` 是 `EntityManagerFactory` 的依賴）。
所以一次啟動會依序：連資料庫 → Flyway 套用所有待執行的 migration → Hibernate 用 `validate` 檢查 Entity → 應用程式開始接請求。
**任何一步失敗，應用程式都起不來** —— 2.2.2 的三個坑都是在這裡擋下的。

### 2.9.2 檔名：一個檔案一個模組

一個常見的做法是一個 `V1__baseline.sql` 大檔案包含所有的表。本專題**拆成了九個**（第 01 章 1.11 預告的「每個模組一支」）：

```
src/main/resources/db/migration/
├── V1__account_create_tables.sql
├── V2__catalog_create_tables.sql
├── V3__inventory_create_tables.sql
├── V4__cart_create_tables.sql
├── V5__ordering_create_tables.sql
├── V6__payment_create_tables.sql
├── V7__notification_create_tables.sql
├── V8__shared_create_tables.sql
├── V9__catalog_reference_categories.sql
└── V10__catalog_unique_top_level_category_name.sql
```

**命名規則**：`V<版本>__<模組>_<說明>.sql`。模組名放在檔名裡，是為了讓**表的歸屬延伸到 migration** ——
1.6.4 的 `TableOwnershipTest` 保證「Java 程式碼只碰自己模組的表」，2.9.4 的 `MigrationOwnershipTest` 保證「migration 只碰檔名上那個模組的表」。

版本號是**全域的**（整個專案一條序列），不是每個模組各自一條 —— Flyway 只有一張 `flyway_schema_history`，模組化單體**只有一個資料庫**。
這也代表 2.2.2 的坑三（兩個分支撞號）在模組化單體裡**更容易發生**：九個模組的人都在往同一條序列上加檔案。

> 📌 **V1～V8 大多數檔案有好幾句 DDL**（V4、V7 各只有一句 `CREATE TABLE`；V9 只有 `INSERT`），違反了 2.2.2 的規則二。這是刻意的例外：它們是**在空資料庫上建新表**，失敗時的復原方式是「砍掉資料庫重來」（沒有資料可以丟）。
> **從 V10 開始**，每個檔案只有一句 DDL —— 因為從這裡開始，migration 面對的是**有資料的**資料庫。`MigrationOwnershipTest` 會強制這條分界。

### 2.9.3 第一次啟動：`shop` 不是空的

照著前兩章走過來的人，第一次用 Flyway 啟動時**一定**會看到這個：

```
Error creating bean with name 'flywayInitializer' ... Found non-empty schema(s) `shop` but no schema history table.
  Use baseline() or set baselineOnMigrate to true to initialize the schema history table.
```

`shop` 裡已經有東西了：第 00 章的 `ch00_stock`、`ch00_order`，以及第 01 章 `ch01-schema.sql` 建的 `inventory`、`inventory_ledger`、`orders`。
Flyway 看到一個「有表、但沒有 `flyway_schema_history`」的資料庫，**拒絕猜測**這些表是從哪一個版本來的。

錯誤訊息建議了 `baselineOnMigrate`。**試一次，看它做了什麼**：

```bash
mvn spring-boot:run -Dspring-boot.run.arguments="--spring.flyway.baseline-on-migrate=true"
```

```
o.f.c.i.s.JdbcTableSchemaHistory : Creating Schema History table `shop`.`flyway_schema_history` with baseline ...
o.f.core.internal.command.DbBaseline : Successfully baselined schema with version: 1
o.f.core.internal.command.DbMigrate  : Current version of schema `shop`: 1
o.f.core.internal.command.DbMigrate  : Migrating schema `shop` to version "2 - catalog create tables"
o.f.core.internal.command.DbMigrate  : Migrating schema `shop` to version "3 - inventory create tables"
o.f.core.internal.command.DbMigrate  : Migration of schema `shop` to version "3 - inventory create tables" failed! Please restore backups and roll back database and code!
...
Caused by: java.sql.SQLSyntaxErrorException: Table 'inventory' already exists
```

```sql
SELECT installed_rank, version, description, success FROM flyway_schema_history;
-- 1  1  << Flyway Baseline >>        1
-- 2  2  catalog create tables         1
-- 3  3  inventory create tables       0
SHOW TABLES;
-- categories, ch00_order, ch00_stock, flyway_schema_history, inventory, inventory_ledger, orders, products
```

**`baselineOnMigrate` 的意思是「把目前的資料庫當成 V1，從 V2 開始跑」。** 所以：

- **V1 被跳過了** —— `users`、`user_roles`、`refresh_tokens` **永遠不會被建立**。Flyway 認為它們「已經在 baseline 裡了」。
- V2 成功（建了 `categories`、`products`）。
- V3 失敗在 `inventory` 已經存在 —— 那是第 01 章的暫時版本，欄位跟 V3 不一樣。

如果第 01 章剛好沒有建 `inventory`，**V3～V9 會全部成功，應用程式會正常啟動** —— 直到第 05 章有人第一次註冊帳號時，才發現 `users` 表不存在。

**`baselineOnMigrate` 是給「一個已經在正式環境運作多年、schema 從來沒有用過 Flyway 管理的資料庫」用的**：
你先把現有的 schema 匯出成 V1，然後告訴 Flyway「這個資料庫已經是 V1 了，從 V2 開始」。**它不是「清掉雜物」的工具。**

**本機的正解：把雜物清掉，從空的資料庫開始。**

```bash
docker compose exec -T mysql mysql -uroot -proot -e "DROP DATABASE shop; CREATE DATABASE shop;"
```

（`shop` 使用者對 `shop` 資料庫的權限是用**資料庫名稱**授權的，刪掉重建之後權限還在。）

```
o.f.c.i.s.JdbcTableSchemaHistory : Creating Schema History table `shop`.`flyway_schema_history` ...
o.f.core.internal.command.DbMigrate : Current version of schema `shop`: << Empty Schema >>
o.f.core.internal.command.DbMigrate : Migrating schema `shop` to version "1 - account create tables"
o.f.core.internal.command.DbMigrate : Migrating schema `shop` to version "2 - catalog create tables"
...
o.f.core.internal.command.DbMigrate : Migrating schema `shop` to version "9 - catalog reference categories"
o.f.core.internal.command.DbMigrate : Successfully applied 9 migrations to schema `shop`, now at version v9 (execution time 00:00.245s)
com.example.shop.ShopApplication    : Started ShopApplication in 3.451 seconds (process running for 3.623)
```

**9 個 migration、0.245 秒**，然後 Hibernate 的 `validate` 通過、應用程式啟動。
（照 2.2.0 的「動手順序」走，這時還沒有 V10，就是這 9 個；如果你已經寫了 2.5.4 的 V10，這裡會是 `Successfully applied 10 migrations ... now at version v10`。）

**但第 00、01 章的實驗還在，而且它們會自己建表、刪表。** `B1BypassOwnerTest` 的 `@Sql("/ch01-schema.sql")` 會 `DROP TABLE inventory` —— 在 `shop` 裡執行它，就是親手把 Flyway 建的表換成第 01 章的暫時版本。

把它們搬到 `shop_lab`：`src/test/resources/application-lab.yml`

```yaml
# 第 00～01 章的實驗用：它們會自己建、自己刪表（@Sql("/ch01-schema.sql")），
# 所以連到 shop_lab，而且不跑 Flyway、不驗證 schema —— 絕對不能碰 Flyway 管理的 shop。
spring:
  datasource:
    url: jdbc:mysql://localhost:3306/shop_lab?useSSL=false&allowPublicKeyRetrieval=true&connectionTimeZone=UTC&rewriteBatchedStatements=true
  flyway:
    enabled: false
  jpa:
    hibernate:
      ddl-auto: none
```

會碰資料庫、而且用 `@SpringBootTest` 的實驗類別，加上兩個註解。以 `B1BypassOwnerTest` 為例：

```java
@Tag("experiment")
@SpringBootTest
@ActiveProfiles({"local", "lab"})          // ← 第 02 章加上：實驗改連 shop_lab
@Sql("/ch01-schema.sql")
class B1BypassOwnerTest {
```

`@ActiveProfiles` 會**取代**預設的 profile，所以 `local` 要一起寫（`lab` 只覆蓋 datasource 與 Flyway 的設定，其餘仍然用 `application-local.yml`）。
沒有用 Spring context 的 `A3HotRowCeilingTest`，把它 `HikariConfig` 裡的 JDBC URL 從 `/shop` 改成 `/shop_lab`。

**第 00、01 章的六個實驗類別，逐一處理：**

| 類別 | 它怎麼連資料庫 | 第 02 章要做的事 |
|---|---|---|
| `A1WhenToDeductTest` | 不連（純 Java 的離散事件模擬） | 加 `@Tag("experiment")` |
| `A2FlagsVsStateMachineTest` | 不連（純 Java） | 加 `@Tag("experiment")` |
| `A3HotRowCeilingTest` | 自己建 `HikariConfig`，連 `/shop` | 加 `@Tag("experiment")`（第 01 章練習一已經加過就略過）；JDBC URL 改成 `/shop_lab` |
| `B1BypassOwnerTest` | `@SpringBootTest` + `@Sql("/ch01-schema.sql")` | 加 `@Tag("experiment")` 與 `@ActiveProfiles({"local", "lab"})`（上面的例子） |
| `B2ConfigTypoTest` | 不連 MySQL：`new SpringApplicationBuilder(RedisOnly.class)` 只匯入 `RedisAutoConfiguration`，而且用 `spring.config.name` 只讀 `ch01-correct.yml` / `ch01-typo.yml` | 只加 `@Tag("experiment")`。`@ActiveProfiles` 是給 Spring 測試框架用的，對 `SpringApplicationBuilder` 無效 —— 它也不需要 |
| `B3InProcessVsHttpTest` | `@SpringBootTest(RANDOM_PORT)` + `@Sql("/ch01-schema.sql")` | 加 `@Tag("experiment")` 與 `@ActiveProfiles({"local", "lab"})` —— 它的 `@Sql` 一樣會 `DROP TABLE inventory` |

**`A1`、`A2` 不碰資料庫，為什麼也要標？** 因為從 2.11.1 開始，**預設的 `mvn test` 只跑守門員與驗收測試**。
它們不標的話，`mvn clean test` 會多出這兩個，變成 26 個測試，而不是 2.13.1 驗收清單上的 `Tests run: 24`。

確認 `B1` 真的改連 `shop_lab` 了：在它的測試方法開頭加一行

```java
        System.out.println("B1 在 " + jdbc.queryForObject("SELECT DATABASE()", String.class) + " 裡執行");
```

再用 `mvn test -Pexperiments -Dtest=B1BypassOwnerTest` 跑一次，輸出裡應該有：

```
B1 在 shop_lab 裡執行
```

> 📌 **第 01 章的 `PlaceOrderService` 在新 schema 下會失敗**：
>
> ```
> UncategorizedSQLException: Field 'order_no' doesn't have a default value
> ```
>
> 它的 `INSERT INTO orders(buyer_id, status)` 只給了兩個欄位，而 V5 的 `orders` 還有 4 個 `NOT NULL` 且沒有預設值的欄位（`order_no`、`seller_id`、`total_amount`、`payment_deadline`）。**這是 schema 在做它該做的事**：擋下一張不完整的訂單。
> `PlaceOrderService` 完成了它在 1.5 的任務（示範跨模組的同一個交易），**本章把它刪掉**，`OrderingApi` 介面保留 —— 第 04 章寫完整的實作。

### 2.9.4 `MigrationOwnershipTest`：migration 也要守邊界

```java
package com.example.shop.architecture;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 2.9.4 migration 檔也是程式碼，也要守邊界：
 *  ① 檔名一律 V<版本>__<模組>_<說明>.sql
 *  ② 一個檔案只能動它所屬模組的表（對照 TableOwnershipTest.OWNER）
 *  ③ V10 之後，一個檔案最多一句 DDL（2.2.2 坑二：MySQL 的 DDL 不在交易裡）
 */
class MigrationOwnershipTest {

    static final Path DIR = Path.of("src/main/resources/db/migration");
    static final Pattern FILE = Pattern.compile("V(\\d+)__([a-z]+)_\\w+\\.sql");
    static final Pattern TOUCH = Pattern.compile(
            "(?i)\\b(?:CREATE\\s+TABLE|ALTER\\s+TABLE|DROP\\s+TABLE|INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|RENAME\\s+TABLE|TRUNCATE\\s+TABLE|REFERENCES|ON)\\s+`?(\\w+)`?");
    static final Pattern DDL = Pattern.compile("(?i)^\\s*(CREATE|ALTER|DROP|RENAME|TRUNCATE)\\b");
    static final int ONE_DDL_PER_FILE_FROM = 10;

    @Test
    void migrationsFollowModuleOwnership() throws IOException {
        Set<String> modules = new HashSet<>(TableOwnershipTest.OWNER.values());
        List<String> violations = new ArrayList<>();
        List<Path> files;
        try (Stream<Path> s = Files.list(DIR)) { files = s.sorted().toList(); }
        for (Path p : files) {
            String name = p.getFileName().toString();
            Matcher f = FILE.matcher(name);
            if (!f.matches() || !modules.contains(f.group(2))) {
                violations.add(name + "：檔名要是 V<版本>__<模組>_<說明>.sql，模組是 " + new TreeSet<>(modules) + " 之一");
                continue;
            }
            int version = Integer.parseInt(f.group(1));
            String module = f.group(2);
            String sql = Files.readString(p).replaceAll("--[^\\n]*", "");            // 去掉註解
            List<String> statements = Arrays.stream(sql.split(";")).map(String::strip).filter(x -> !x.isEmpty()).toList();
            long ddl = statements.stream().filter(st -> DDL.matcher(st).find()).count();
            if (version >= ONE_DDL_PER_FILE_FROM && ddl > 1)
                violations.add("%s：有 %d 句 DDL；V%d 之後一個檔案只能有一句（MySQL 的 DDL 會各自 commit）".formatted(name, ddl, ONE_DDL_PER_FILE_FROM));
            Matcher m = TOUCH.matcher(sql);
            while (m.find()) {
                String table = m.group(1).toLowerCase(Locale.ROOT);
                String owner = TableOwnershipTest.OWNER.get(table);
                if (owner != null && !owner.equals(module))
                    violations.add("%s：屬於 %s 模組，卻動了 %s 模組的表 `%s`".formatted(name, module, owner, table));
            }
        }
        System.out.printf("檢查了 %d 個 migration%n", files.size());
        violations.forEach(v -> System.out.println("  ✗ " + v));
        assertThat(violations).isEmpty();
    }
}
```

它檢查三件事，每一件都對應本章的一個教訓：

| 檢查 | 對應 |
|---|---|
| 檔名格式 `V<版本>__<模組>_<說明>.sql` | 2.9.2 |
| 檔案裡提到的每一張表（`CREATE`、`ALTER`、`INSERT`、`REFERENCES`、`CREATE INDEX ... ON`……）都屬於檔名上的模組 | 2.2.3（`REFERENCES` 別人的表 = 跨模組外鍵） |
| V10 之後一個檔案最多一句 DDL | 2.2.2 坑二 |

現在的 10 個 migration 全部通過：

```
檢查了 10 個 migration
```

**故意加一個「補上跨模組外鍵」的 V11**：

```sql
-- V11__ordering_add_product_fk.sql
-- 「外鍵不是保護資料完整性的嗎？」—— 有人想把 order_items.product_id 補上外鍵
ALTER TABLE order_items ADD CONSTRAINT fk_order_items_product FOREIGN KEY (product_id) REFERENCES products (id);
CREATE INDEX idx_order_items_created ON order_items (id, product_id);
```

```
檢查了 11 個 migration
  ✗ V11__ordering_add_product_fk.sql：有 2 句 DDL；V10 之後一個檔案只能有一句（MySQL 的 DDL 會各自 commit）
  ✗ V11__ordering_add_product_fk.sql：屬於 ordering 模組，卻動了 catalog 模組的表 `products`
```

**兩條規則同時紅。** 第二條就是 2.2.3 的那個外鍵 —— 它在 code review 之前就會被 `mvn test` 擋下，而且錯誤訊息直接說出「ordering 動了 catalog 的表」。

### 2.9.5 第四條規則：刪了 migration，要 `mvn clean`

上一節的 V11 是一個示範，跑完就刪掉了（`rm src/main/resources/db/migration/V11__...sql`）。接著跑 `EntitySchemaDriftTest` —— 它會啟動 Spring context，也就會跑 Flyway。然後跑驗收 Q6：

```
Expected size: 10 but was: 11 in:
[org.flywaydb.core.internal.info.MigrationInfoImpl@a3e9bc73,
    ...
```

**Q6 從空資料庫套用了 11 個 migration。** 但 `src/main/resources/db/migration/` 裡只有 10 個檔案。

```bash
ls target/classes/db/migration/
# V10__catalog_unique_top_level_category_name.sql
# V11__ordering_add_product_fk.sql                   ← 還在這裡
# V1__account_create_tables.sql
# ...
```

**Maven 的 `resources` 階段只會複製與覆蓋檔案，不會刪除已經不存在的檔案。** Flyway 讀的是 classpath（`target/classes`），不是 `src/main`。
所以那個被刪掉的 V11 在 `target/classes` 裡繼續存在，而且**被執行了兩次**：一次在 `shop_q6`、一次在 `shop`（`EntitySchemaDriftTest` 啟動時）。

```sql
SELECT version, description FROM flyway_schema_history ORDER BY installed_rank DESC LIMIT 2;
-- 11  ordering add product fk
-- 10  catalog unique top level category name
SELECT constraint_name FROM information_schema.referential_constraints WHERE table_name = 'order_items';
-- fk_order_items_order
-- fk_order_items_product       ← 2.2.3 的那個跨模組外鍵，真的建出來了
```

**`mvn clean` 之後再啟動呢？** V11 從 classpath 上消失了，但資料庫的歷史裡有它：

```
o.f.core.internal.command.DbValidate : Successfully validated 11 migrations (execution time 00:00.029s)
o.f.core.internal.command.DbMigrate  : Current version of schema `shop`: 11
o.f.core.internal.command.DbMigrate  : Schema `shop` has a version (11) that is newer than the latest available migration (10) !
o.f.core.internal.command.DbMigrate  : Schema `shop` is up to date. No migration necessary.
```

**只是一行 WARN，應用程式正常啟動。** 那個跨模組外鍵留在本機資料庫裡，沒有任何檔案記錄它是怎麼來的。

這個行為是 Flyway **刻意的**：`ignoreMigrationPatterns` 的預設值是 `*:future` —— 「資料庫的版本比程式碼新」會被容忍。
它是為了**正式環境的回滾**設計的：新版程式（帶著 V11）上線、跑了 V11、發現 bug、回滾成舊版程式（只認識到 V10）—— 舊版程式要能啟動。
**在正式環境是救命的設計，在本機是讓漂移無聲無息的設計。**

收拾（只在本機，而且要先確認它真的是一個不該存在的 migration）：

```sql
ALTER TABLE order_items DROP FOREIGN KEY fk_order_items_product;
DROP INDEX idx_order_items_created ON order_items;
DELETE FROM flyway_schema_history WHERE version = '11';
```

> 📌 **規則四：刪除或改名任何 migration 之後，`mvn clean`。**
> 更好的做法：**不要刪 migration**。一個 migration 如果已經跑過任何共用環境，就用一個新的 migration 反向操作（2.2.2 規則一）；
> 如果只在你的筆電上跑過，刪掉它、`mvn clean`、並清掉本機資料庫裡它留下的東西。
> CI 永遠從 `mvn clean verify` 開始（第 08 章），所以這個坑只會出現在本機 —— 但它會讓你本機的資料庫跟所有人的都不一樣。

### 2.9.6 從開發到正式環境：加一個欄位要經過哪些關卡

README 驗收的第 6 題：「**資料庫要加一個欄位，從開發到正式環境的流程是什麼？**」

以「訂單要能記錄買家的備註」為例（`orders.note VARCHAR(200)`）：

```
① 寫 V11__ordering_add_order_note.sql（一句 DDL）
② 本機：mvn test
     → MigrationOwnershipTest（檔名、歸屬、一句 DDL）
     → 驗收 Q6（從空資料庫跑到 V11，validate 通過，約束與索引都在）
     → EntitySchemaDriftTest（Entity 的 length 跟 VARCHAR(200) 一致）
③ 本機：在 10 萬張訂單的種子資料上試跑那句 DDL，要求 ALGORITHM=INSTANT / INPLACE（見下）
④ PR：SQL 是 review 的重點。CI 從空資料庫重跑 ②
⑤ 上線：新版程式啟動時，Flyway 先跑 V11，再開始接請求
     → 多個實例同時啟動時，Flyway 用 MySQL 的 GET_LOCK 讓只有一個實例執行 migration，其他的等它
⑥ 滾動部署期間，舊版程式與新版程式同時在跑 —— 它們面對的是「已經有 note 欄位」的 schema
```

**③ 為什麼要在種子資料上試跑？** 因為**同樣是 `ALTER TABLE`，代價可以差 60 倍**。實測（在 10 萬張訂單的複本上）：

```java
package com.example.shop.ch02;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;

/**
 * 2.9.6 同樣是「改 schema」，在 10 萬張訂單上要多久、會不會鎖表？（先跑 SeedData）
 * 在 shop_lab 裡複製 shop.orders（連同索引與 CHECK），逐一執行常見的 ALTER，並「要求」MySQL 用指定的演算法：
 * 做不到時，MySQL 會直接拒絕，而不是默默改用更慢、會鎖表的做法。
 */
@Tag("experiment")
class C10OnlineDdlTest {

    static final JdbcTemplate LAB = new JdbcTemplate(new SingleConnectionDataSource(
            "jdbc:mysql://localhost:3306/shop_lab?useSSL=false&allowPublicKeyRetrieval=true&connectionTimeZone=UTC", "shop", "shop", true));

    static void copyOrders(String table) {
        LAB.execute("DROP TABLE IF EXISTS " + table);
        LAB.execute("CREATE TABLE " + table + " LIKE shop.orders");
        LAB.execute("INSERT INTO " + table + " SELECT * FROM shop.orders");
    }

    static void ddl(String label, String sql) {
        long t0 = System.nanoTime();
        try {
            LAB.execute(sql);
            System.out.printf("  %-50s %,7.0f ms%n", label, (System.nanoTime() - t0) / 1e6);
        } catch (Exception e) {
            Throwable t = e; while (t.getCause() != null) t = t.getCause();
            System.out.printf("  %-50s ✗ %s%n", label, t.getMessage());
        }
    }

    @Test
    void onlineDdl() {
        copyOrders("c10_orders");
        System.out.printf("═══ 2.9.6 在 %,d 張訂單上改 schema（c10_orders = shop.orders 的複本，含 6 個 CHECK）═══%n",
                LAB.queryForObject("SELECT COUNT(*) FROM c10_orders", Long.class));
        ddl("① 加一個可為 NULL 的欄位，INSTANT", "ALTER TABLE c10_orders ADD COLUMN note VARCHAR(200) NULL, ALGORITHM=INSTANT");
        ddl("② 加一個索引，INPLACE + LOCK=NONE", "ALTER TABLE c10_orders ADD INDEX idx_c10_paid (paid_at), ALGORITHM=INPLACE, LOCK=NONE");
        ddl("③ order_no VARCHAR(15) → (16)，INPLACE + LOCK=NONE", "ALTER TABLE c10_orders MODIFY COLUMN order_no VARCHAR(16) NOT NULL, ALGORITHM=INPLACE, LOCK=NONE");
        ddl("③ 同上，COPY + LOCK=NONE", "ALTER TABLE c10_orders MODIFY COLUMN order_no VARCHAR(16) NOT NULL, ALGORITHM=COPY, LOCK=NONE");
        ddl("③ 同上，COPY（寫入被擋住，LOCK=SHARED）", "ALTER TABLE c10_orders MODIFY COLUMN order_no VARCHAR(16) NOT NULL, ALGORITHM=COPY, LOCK=SHARED");
        ddl("④ total_amount DECIMAL(12,2) → (14,2)，INPLACE", "ALTER TABLE c10_orders MODIFY COLUMN total_amount DECIMAL(14,2) NOT NULL, ALGORITHM=INPLACE, LOCK=NONE");
        ddl("④ 同上，COPY", "ALTER TABLE c10_orders MODIFY COLUMN total_amount DECIMAL(14,2) NOT NULL, ALGORITHM=COPY");
        ddl("⑤ 加一個 CHECK", "ALTER TABLE c10_orders ADD CONSTRAINT ck_c10_note CHECK (CHAR_LENGTH(note) <= 200)");

        copyOrders("c10_orders_b");
        System.out.println("── 對照：同一份複本，拿掉 ck_orders_paid 與 ck_orders_shipment 這兩個 CHECK ──");
        for (String name : LAB.queryForList("""
                SELECT cc.constraint_name FROM information_schema.check_constraints cc
                  JOIN information_schema.table_constraints tc ON tc.constraint_name = cc.constraint_name AND tc.constraint_schema = cc.constraint_schema
                 WHERE tc.table_schema = 'shop_lab' AND tc.table_name = 'c10_orders_b'
                   AND (cc.check_clause LIKE '%paid_at%' OR cc.check_clause LIKE '%shipped_at%')""", String.class)) {
            LAB.execute("ALTER TABLE c10_orders_b DROP CHECK " + name);
        }
        ddl("③' order_no VARCHAR(15) → (16)，INPLACE + LOCK=NONE", "ALTER TABLE c10_orders_b MODIFY COLUMN order_no VARCHAR(16) NOT NULL, ALGORITHM=INPLACE, LOCK=NONE");
    }
}
```

```
═══ 2.9.6 在 100,000 張訂單上改 schema（c10_orders = shop.orders 的複本，含 6 個 CHECK）═══
  ① 加一個可為 NULL 的欄位，INSTANT                         31 ms
  ② 加一個索引，INPLACE + LOCK=NONE                        134 ms
  ③ order_no VARCHAR(15) → (16)，INPLACE + LOCK=NONE       ✗ ALGORITHM=INPLACE is not supported for this operation. Try ALGORITHM=COPY.
  ③ 同上，COPY + LOCK=NONE                                 ✗ LOCK=NONE is not supported. Reason: COPY algorithm requires a lock. Try LOCK=SHARED.
  ③ 同上，COPY（寫入被擋住，LOCK=SHARED）                  1,398 ms
  ④ total_amount DECIMAL(12,2) → (14,2)，INPLACE          ✗ ALGORITHM=INPLACE is not supported for this operation. Try ALGORITHM=COPY.
  ④ 同上，COPY                                           1,514 ms
  ⑤ 加一個 CHECK                                         1,411 ms
── 對照：同一份複本，拿掉 ck_orders_paid 與 ck_orders_shipment 這兩個 CHECK ──
  ③' order_no VARCHAR(15) → (16)，INPLACE + LOCK=NONE       23 ms
```

**三種演算法，三種代價**（[07-mysql/06](../07-mysql/06-schema-migration-flyway.md) 講過原理，這裡是本專題的實測）：

| 演算法 | 做什麼 | 寫入會被擋住嗎 | 10 萬列 | 放大到 550 萬列（三年，0.6.1） |
|---|---|---|---|---|
| **INSTANT** | 只改中繼資料 | 不會 | 31 ms | 一樣 31 ms 左右 |
| **INPLACE** | 在原表上重建索引 / 資料，允許並行寫入 | 不會（`LOCK=NONE`） | 134 ms | 約 7 秒，寫入照常 |
| **COPY** | 建一張新表、把資料全部複製過去、再換名 | **會**（`LOCK=SHARED`：可以讀、不能寫） | 1.4～1.5 秒 | 約 80 秒**不能下單** |

**③ 是本節最意外的一行。** 把 `order_no` 從 `VARCHAR(15)` 加長到 `VARCHAR(16)`，照 MySQL 文件應該是 INPLACE（加長 VARCHAR，而且長度前綴仍然是 1 byte）。
**但在 `orders` 上被拒絕了。** 一個一個拿掉 CHECK 之後發現：只要表上有 `ck_orders_paid` 或 `ck_orders_shipment` 其中之一，**連一個它們完全沒有引用的欄位**的加長都會變成 COPY；拿掉這兩個，同一句 23 ms 完成（③'）。
兩個約束的共同點是都引用了一個可為 `NULL` 的 `DATETIME` 欄位與 `status`；**我們沒有找到說明這個行為的官方文件**。

所以本專題的規則是：**正式環境的每一句 DDL，都要明寫 `ALGORITHM` 與 `LOCK`**：

```sql
ALTER TABLE orders ADD COLUMN note VARCHAR(200) NULL, ALGORITHM=INSTANT;
```

做不到的時候，MySQL 會**直接拒絕**（像 ③ 那樣）—— 而不是默默改用 COPY、在正式環境鎖表 80 秒。
**你在本機的種子資料上就會知道這句 DDL 要不要排維護時段**，而不是在上線當下才知道。

**⑥ 滾動部署：expand / contract**

滾動部署時，新舊兩版程式會同時跑一段時間。所以每一個 schema 變更都要讓**舊版程式也能正常運作**：

| 變更 | 一次做完會怎樣 | 拆成幾次上線 |
|---|---|---|
| 加一個 `NULL` 欄位 | ✅ 沒問題（舊版不知道它，不讀也不寫） | 1 次 |
| 加一個 `NOT NULL` 欄位 | ❌ 舊版的 INSERT 沒有給這個欄位 → `Field 'x' doesn't have a default value`（2.9.3 的 `PlaceOrderService` 就是這樣死的） | ① 加成 `NULL` → ② 新版程式開始寫它 → ③ 回填舊資料 → ④ 改成 `NOT NULL` |
| 刪一個欄位 | ❌ 舊版還在讀它 → `Unknown column` | ① 新版程式不再讀寫它 → ② 下一次上線才 `DROP` |
| 改欄位名 | ❌ 同時是「加一個」與「刪一個」 | 加新欄位 → 雙寫 → 回填 → 改讀新欄位 → 刪舊欄位（4～5 次上線） |

**這就是為什麼本專題沒有 undo migration**（Flyway 的 `U__` 檔是付費版功能，而且在 MySQL 上 DDL 不能回滾，undo 也只是另一組 DDL）：
**回滾程式的時候，schema 不回滾** —— 舊版程式要能在新版 schema 上跑（2.9.5 的 `*:future` 就是為此設計）。發現 migration 本身有問題時，寫一個新的 migration 往前修。

### 2.9.7 `EntityTableOwnershipTest`：`@Table` 也要守邊界

1.6.4 的限制表寫著：「JPA 的表名在 `@Table(name = "...")` 裡，`TableOwnershipTest` 看不到」，第 01 章的練習八要你補上它。本章有了 Entity，正式補上：

```java
package com.example.shop.architecture;

import com.tngtech.archunit.core.domain.JavaClass;
import com.tngtech.archunit.core.importer.ImportOption;
import com.tngtech.archunit.junit.AnalyzeClasses;
import com.tngtech.archunit.junit.ArchTest;
import com.tngtech.archunit.lang.ArchCondition;
import com.tngtech.archunit.lang.ArchRule;
import com.tngtech.archunit.lang.ConditionEvents;
import com.tngtech.archunit.lang.SimpleConditionEvent;
import jakarta.persistence.Entity;
import jakarta.persistence.Table;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.classes;

/**
 * 1.6.4 的限制表說過：JPA 的表名寫在 @Table 裡，TableOwnershipTest 讀 SQL 字串看不到它。
 * 這條規則補上：@Entity 的 @Table(name) 必須是它所在模組擁有的表。
 */
@AnalyzeClasses(packages = "com.example.shop", importOptions = ImportOption.DoNotIncludeTests.class)
class EntityTableOwnershipTest {

    @ArchTest
    static final ArchRule entities_map_only_their_own_tables = classes()
            .that().areAnnotatedWith(Entity.class)
            .should(new ArchCondition<>("對應到自己模組擁有的表") {
                @Override
                public void check(JavaClass c, ConditionEvents events) {
                    String module = NotTouchOtherModulesInternals.moduleOf(c.getPackageName()).orElse("?");
                    if (!c.isAnnotatedWith(Table.class)) {
                        events.add(SimpleConditionEvent.violated(c, c.getName() + " 沒有 @Table：表名會變成類別名，請明寫"));
                        return;
                    }
                    String table = c.getAnnotationOfType(Table.class).name();
                    String owner = TableOwnershipTest.OWNER.get(table);
                    if (owner == null || !owner.equals(module)) {
                        events.add(SimpleConditionEvent.violated(c, "%s（%s 模組）對應到表 `%s`，它的主人是 %s"
                                .formatted(c.getSimpleName(), module, table, owner == null ? "（不在 OWNER 表裡）" : owner)));
                    }
                }
            });
}
```

故意在 `catalog` 模組放一個對應 `inventory` 表的 Entity：

```java
package com.example.shop.catalog.internal;

import jakarta.persistence.*;

/** 「商品頁要顯示庫存，直接對應 inventory 表最快」 */
@Entity
@Table(name = "inventory")
class StockView {
    @Id Long productId;
    int onHand;
    int reserved;
}
```

```
Architecture Violation [Priority: MEDIUM] - Rule 'classes that are annotated with @Entity should 對應到自己模組擁有的表' was violated (1 times):
StockView（catalog 模組）對應到表 `inventory`，它的主人是 inventory
```

這個 `StockView` 在 ArchUnit 的 6 條規則面前是全綠的（它沒有 import 任何 `inventory` 的類別），在 `TableOwnershipTest` 面前也是全綠的（它沒有 SQL 字串）。
**它是 1.2.1 那個「繞過庫存模組」的 JPA 版本** —— 只是這次連一行 SQL 都不用寫，JPA 的髒檢查就會把對 `onHand` 的任何修改寫回 `inventory` 表。

現在，表的歸屬有了**四個**守門員，各自看不同的地方：

| 守門員 | 看的是 | 章節 |
|---|---|---|
| `ModuleBoundaryTest`（ArchUnit） | 類別之間的依賴 | 1.6.2 |
| `TableOwnershipTest` | Java 程式碼與 mapper XML 裡的 SQL 字串 | 1.6.4 |
| `MigrationOwnershipTest` | migration 檔 | 2.9.4 |
| `EntityTableOwnershipTest` | `@Table` 註解 | 2.9.7 |


---

## 2.10 驗收 Q6：從空資料庫到最新版

0.12.1 的 Q6：「**空資料庫啟動：Flyway 由 V1 跑到最新版，schema 與 entity 一致（`ddl-auto=validate` 通過）**」。

把 `CapstoneAcceptanceTest` 裡的 `@Disabled("ch02：Flyway")` 拿掉，換成真正的測試：

```java
    @Test
    @DisplayName("Q6 空資料庫啟動：Flyway 由 V1 跑到最新版，schema 與 entity 一致（ddl-auto=validate 通過）")
    void q6_migrationFromScratch() throws Exception {
        JdbcTemplate admin = new JdbcTemplate(new DriverManagerDataSource(
                "jdbc:mysql://localhost:3306/?useSSL=false&allowPublicKeyRetrieval=true", "shop", "shop"));
        admin.execute("DROP DATABASE IF EXISTS shop_q6");
        admin.execute("CREATE DATABASE shop_q6");

        int latestOnDisk;
        try (Stream<Path> s = Files.list(Path.of("src/main/resources/db/migration"))) {
            latestOnDisk = s.map(p -> p.getFileName().toString())
                    .map(n -> Integer.parseInt(n.substring(1, n.indexOf("__")))).max(Integer::compare).orElseThrow();
        }

        // 用正式的 ShopApplication 啟動：Flyway 先跑，然後 Hibernate 用 ddl-auto=validate 檢查每一個 Entity
        try (var ctx = new SpringApplicationBuilder(ShopApplication.class).web(WebApplicationType.NONE)
                .run("--spring.datasource.url=jdbc:mysql://localhost:3306/shop_q6?useSSL=false&allowPublicKeyRetrieval=true&connectionTimeZone=UTC",
                     "--spring.main.banner-mode=off", "--logging.level.root=WARN")) {
            Flyway flyway = ctx.getBean(Flyway.class);
            MigrationInfo[] applied = flyway.info().applied();
            assertThat(applied).hasSize(latestOnDisk);
            assertThat(flyway.info().pending()).isEmpty();
            assertThat(flyway.info().current().getVersion().getVersion()).isEqualTo(String.valueOf(latestOnDisk));

            JdbcTemplate q6 = ctx.getBean(JdbcTemplate.class);
            // validate 看不到約束與索引（2.4.2），所以再確認一次：migration 裡宣告的每一個 CHECK 與索引，都真的建出來了
            Set<String> declaredChecks = new TreeSet<>(), declaredIndexes = new TreeSet<>();
            try (Stream<Path> s = Files.list(Path.of("src/main/resources/db/migration"))) {
                for (Path p : s.toList()) {
                    String sql = Files.readString(p);
                    Matcher c = Pattern.compile("CONSTRAINT\\s+(ck_\\w+)\\s+CHECK").matcher(sql);
                    while (c.find()) declaredChecks.add(c.group(1));
                    Matcher i = Pattern.compile("(?:\\bKEY|INDEX)\\s+((?:uk|idx)_\\w+)").matcher(sql);
                    while (i.find()) declaredIndexes.add(i.group(1));
                }
            }
            List<String> checks = q6.queryForList(
                    "SELECT constraint_name FROM information_schema.check_constraints WHERE constraint_schema = 'shop_q6'", String.class);
            List<String> indexes = q6.queryForList(
                    "SELECT DISTINCT index_name FROM information_schema.statistics WHERE table_schema = 'shop_q6'", String.class);
            Integer tables = q6.queryForObject(
                    "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'shop_q6'", Integer.class);
            System.out.printf("Q6：從空資料庫套用 %d 個 migration → %d 張表（含 flyway_schema_history）、CHECK %d / %d、具名索引 %d / %d；validate 通過%n",
                    applied.length, tables, checks.size(), declaredChecks.size(),
                    indexes.stream().filter(declaredIndexes::contains).count(), declaredIndexes.size());
            assertThat(checks).containsAll(declaredChecks);
            assertThat(indexes).containsAll(declaredIndexes);
        }
    }
```

這個方法用到的類別比第 00 章的空殼多很多。`CapstoneAcceptanceTest` 檔案開頭的 import 換成這一份：

```java
import com.example.shop.ShopApplication;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;
```

**三層檢查**：

1. **用正式的 `ShopApplication` 啟動**，指向一個剛建好的空資料庫 `shop_q6`。啟動成功本身就證明了兩件事：Flyway 從 V1 跑到最後一版沒有失敗、Hibernate 的 `validate` 通過。
2. **套用的 migration 數量 = 磁碟上的最新版本號**。這一條會抓到 2.2.2 坑三（版本號重複 → 啟動失敗）與 2.9.5（`target/classes` 裡多一個已刪除的檔 → 數量對不上）。
3. **migration 裡宣告的每一個 CHECK 與具名索引，都真的存在**。這是 2.4.2 那張表的右半邊 —— `validate` 看不到約束與索引，所以用 `information_schema` 逐一核對。

```
Q6：從空資料庫套用 10 個 migration → 20 張表（含 flyway_schema_history）、CHECK 24 / 24、具名索引 31 / 31；validate 通過
[WARNING] Tests run: 11, Failures: 0, Errors: 0, Skipped: 10, Time elapsed: 1.259 s -- in com.example.shop.acceptance.CapstoneAcceptanceTest
```

**`Skipped: 10`** —— 0.12.1 的進度表上，ch02 這一格達成了。

> 📌 **為什麼不直接比對「`shop_q6` 的 schema」與「`shop` 的 schema」？** 那會抓到本機的漂移（例如 2.9.5 留下的外鍵），看起來很有用。
> 但它的前提是「`shop` 是對的」—— 而本機的 `shop` 恰好是**最常被手動改壞**的那一個。Q6 比對的是「**migration 檔案說了什麼**」與「**從零執行它們之後得到什麼**」，兩邊都來自 repo。
> 第 08 章改用 Testcontainers 之後，`shop_q6` 會換成一個每次都是全新的容器，這個測試的內容不用改。

> 📌 **`shop_q6` 的 `DROP DATABASE` / `CREATE DATABASE` 是用 `shop` 帳號做的** —— 2.2.0 的 `GRANT ALL PRIVILEGES ON shop_q6.*` 讓它可以。
> 這個帳號只對 `shop`、`shop_lab`、`shop_c2`、`shop_q6` 這四個名字有權限（它可以 `DROP` 其中任何一個 —— C2 與 Q6 就是這樣用的），碰不到 `mysql`、`sys` 或其他任何資料庫。測試用的權限也要最小化。

---

## 2.11 本章完成後的專案

```
shop/
├── compose.yaml                                 ← + mysql-init 掛載
├── docker/mysql-init/01-databases.sql            ← 新增：shop_lab、shop_c2、shop_q6
├── pom.xml                                       ← + data-jpa、flyway-core、flyway-mysql；surefire 分組；experiments / seed 兩個 profile
└── src/
    ├── main/
    │   ├── java/com/example/shop/
    │   │   ├── catalog/ProductStatus.java                     ← 新增
    │   │   ├── catalog/internal/{Category,Product}.java       ← 新增
    │   │   ├── inventory/internal/{Inventory,Reservation,ReservationStatus}.java  ← 新增
    │   │   ├── ordering/OrderStatus.java                      ← 新增
    │   │   ├── ordering/internal/{Order,OrderItem}.java       ← 新增
    │   │   ├── ordering/internal/PlaceOrderService.java       ← 刪除（2.9.3）
    │   │   └── ...（其餘同第 01 章）
    │   └── resources/
    │       ├── application.yml                        ← + jpa（validate、open-in-view: false）、flyway
    │       └── db/migration/V1～V10                    ← 新增
    └── test/
        ├── java/com/example/
        │   ├── lab/ch02/…                              ← 實驗用的 Entity（不在 com.example.shop 底下，2.2.0）
        │   └── shop/
        │       ├── acceptance/CapstoneAcceptanceTest   ← Q6 變綠
        │       ├── architecture/
        │       │   ├── MigrationOwnershipTest          ← 新增（2.9.4）
        │       │   ├── EntityTableOwnershipTest        ← 新增（2.9.7）
        │       │   └── ...（第 01 章的四個）
        │       ├── schema/                             ← 新增：跑在真 schema 上的守門員
        │       │   ├── SchemaConstraintTest            （2.5.2）
        │       │   ├── EntitySchemaDriftTest           （2.4.2）
        │       │   └── InvariantReconciliationTest     （2.5.5）
        │       ├── tools/SeedData                      ← 新增（2.8）
        │       ├── ch00/、ch01/                         ← 全部 + @Tag("experiment")；B1、B3 + @ActiveProfiles({"local","lab"})；A3 改連 shop_lab（2.9.3 的表）
        │       └── ch02/C1～C10                         ← 本章的實驗
        └── resources/
            ├── application-lab.yml                     ← 新增（2.9.3）
            └── ch01-schema.sql                         ← 只在 shop_lab 裡用
```

### 2.11.1 `pom.xml`：把實驗和守門員分開

第 00 章練習八、第 01 章練習一都提過「把量測跟測試分開」。本章正式做：

```xml
  <properties>
    <java.version>21</java.version>
    <!-- 預設的 mvn test 只跑守門員與驗收測試；實驗、量測、種子資料要用 profile 明確要求 -->
    <test.groups></test.groups>
    <test.excluded>experiment,seed</test.excluded>
  </properties>

  ...
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-surefire-plugin</artifactId>
        <configuration>
          <groups>${test.groups}</groups>
          <excludedGroups>${test.excluded}</excludedGroups>
        </configuration>
      </plugin>
  ...

  <profiles>
    <!-- mvn test -Pexperiments -Dtest=C3CrossModuleForeignKeyTest -->
    <profile>
      <id>experiments</id>
      <properties><test.groups>experiment</test.groups><test.excluded>none</test.excluded></properties>
    </profile>
    <!-- mvn test -Pseed -Dtest=SeedData -->
    <profile>
      <id>seed</id>
      <properties><test.groups>seed</test.groups><test.excluded>none</test.excluded></properties>
    </profile>
  </profiles>
```

> ⚠️ **為什麼不直接 `mvn test -Dgroups=experiment`？** 因為 `<excludedGroups>` 寫死在設定裡時，`-Dgroups` 和它**同時生效**：
> 「只跑 experiment」且「排除 experiment」= 什麼都不跑，而且 `BUILD SUCCESS`。
> 用 profile 同時改兩個屬性（`test.excluded=none` 是一個不存在的 tag），才是「換一組測試」。

**`mvn test` 現在跑什麼：**

```bash
docker compose up -d --wait
mvn clean test
```

```
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 3.556 s -- in com.example.shop.schema.SchemaConstraintTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.023 s -- in com.example.shop.schema.EntitySchemaDriftTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 3.524 s -- in com.example.shop.schema.InvariantReconciliationTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.025 s -- in com.example.shop.architecture.TableOwnershipTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.011 s -- in com.example.shop.architecture.MigrationOwnershipTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.039 s -- in com.example.shop.architecture.ConfigKeyGuardTest
Q6：從空資料庫套用 10 個 migration → 20 張表（含 flyway_schema_history）、CHECK 24 / 24、具名索引 31 / 31；validate 通過
[WARNING] Tests run: 11, Failures: 0, Errors: 0, Skipped: 10, Time elapsed: 1.259 s -- in com.example.shop.acceptance.CapstoneAcceptanceTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.765 s -- in com.example.shop.architecture.EntityTableOwnershipTest
[INFO] Tests run: 6, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.071 s -- in com.example.shop.architecture.ModuleBoundaryTest
[WARNING] Tests run: 24, Failures: 0, Errors: 0, Skipped: 10
[INFO] BUILD SUCCESS
[INFO] Total time:  12.601 s
```

> 📌 **`mvn clean verify`。** 在本章結束時的程式碼上、用一套全新的 compose（空的資料庫，Flyway 從第一個 migration 開始）跑 `mvn clean verify`：

```bash
mvn clean verify
```

```
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 3.716 s -- in com.example.shop.schema.SchemaConstraintTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.020 s -- in com.example.shop.schema.EntitySchemaDriftTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.018 s -- in com.example.shop.schema.InvariantReconciliationTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.014 s -- in com.example.shop.architecture.TableOwnershipTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.007 s -- in com.example.shop.architecture.MigrationOwnershipTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.031 s -- in com.example.shop.architecture.ConfigKeyGuardTest
[WARNING] Tests run: 11, Failures: 0, Errors: 0, Skipped: 10, Time elapsed: 0.826 s -- in com.example.shop.acceptance.CapstoneAcceptanceTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.597 s -- in com.example.shop.architecture.EntityTableOwnershipTest
[INFO] Tests run: 6, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.043 s -- in com.example.shop.architecture.ModuleBoundaryTest
[WARNING] Tests run: 24, Failures: 0, Errors: 0, Skipped: 10
[INFO] ...
[INFO] Building jar: …/target/shop-0.0.1-SNAPSHOT.jar
[INFO] ...
[INFO] BUILD SUCCESS
[INFO] ...
[INFO] Total time:  8.765 s
```

24 個測試、跳過 10 個 —— 跟上面一樣。`verify` 比 `test` 多做的是打包 jar（`spring-boot:repackage`）；覆蓋率門檻要到第 08 章才有。

**24 個測試、`Skipped: 10`、12.6 秒。** 第 01 章結束時是 2 分 15 秒，其中 117 秒是實驗 —— 現在實驗全部移到 `-Pexperiments`，每次 `mvn test` 只跑守門員。

`InvariantReconciliationTest` 花了 3.5 秒：它跑在**你本機現在的 `shop` 資料上**。跑過種子資料就是 10 萬張訂單的對帳；沒跑過就是空表、瞬間通過。
兩種情況都必須是 0 差異 —— **本機資料壞了，這個測試會第一個告訴你**。

### 2.11.2 追溯表更新（0.12.2）

| 需求 | 驗證方式 | 狀態 |
|---|---|---|
| INV-1、INV-4 | `SchemaConstraintTest`（直接寫非法資料） | ✅ 02 |
| 0.6.7 schema 只由 Flyway 管理 | 驗收 Q6 + `MigrationOwnershipTest` | ✅ 02（**Q6**） |
| 0.6.7 金額、時間的型別 | 2.4.1、`EntitySchemaDriftTest` | ✅ 02 |
| 0.6.8 模組邊界（表的歸屬） | + `MigrationOwnershipTest`、`EntityTableOwnershipTest` | ✅ 01 → 02 補強 |
| RPT-1 AC-4 | 10 萬張訂單的種子資料 | 資料 ✅ 02；計時在 03 |
| INV-2、INV-3 | 對帳 SQL（`InvariantReconciliationTest`） | SQL ✅ 02；排程在 07 |

### 2.11.3 本章其餘檔案的完整內容

正文只給了片段、或只提到名字的檔案，這裡逐檔貼出本章參考專案的完整內容。
其中 `AssignedOrder` 的 `import org.springframework.data.domain.Persistable;` 沒有被用到，照原樣保留（`spring-boot-starter-data-jpa` 會帶進 Spring Data，所以編譯得過）。

#### `src/main/java/com/example/shop/catalog/ProductStatus.java`（2.4.2）

```java
package com.example.shop.catalog;

/** US-PRD-1、US-PRD-4 */
public enum ProductStatus { DRAFT, ON_SALE, OFF_SHELF }
```

#### `src/main/java/com/example/shop/catalog/internal/Category.java`（2.4.2）

```java
package com.example.shop.catalog.internal;

import jakarta.persistence.*;

@Entity
@Table(name = "categories")
class Category {

    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "parent_id")
    private Category parent;                       // 同一個模組內：可以用關聯

    @Column(nullable = false, length = 50)
    private String name;

    @Column(nullable = false)
    private int sortOrder;

    protected Category() {}

    Long getId() { return id; }
    String getName() { return name; }
    Category getParent() { return parent; }
}
```

#### `src/main/java/com/example/shop/inventory/internal/Inventory.java`（2.4.2）

```java
package com.example.shop.inventory.internal;

import jakarta.persistence.*;

import java.time.Instant;

@Entity
@Table(name = "inventory")
class Inventory {

    @Id
    private Long productId;                        // 主鍵就是商品 id：一個商品一列庫存

    @Column(nullable = false)
    private int onHand;

    @Column(nullable = false)
    private int reserved;

    @Column(nullable = false)
    private Instant updatedAt;

    protected Inventory() {}

    Long getProductId() { return productId; }
    int getOnHand() { return onHand; }
    int getReserved() { return reserved; }
    int available() { return onHand - reserved; }  // 0.3.5：可售庫存永遠用算的
}
```

#### `src/main/java/com/example/shop/inventory/internal/Reservation.java`（2.4.2）

```java
package com.example.shop.inventory.internal;

import jakarta.persistence.*;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;

@Entity
@Table(name = "inventory_reservations")
class Reservation {

    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private long orderId;                          // 跨模組：只存 id

    @Column(nullable = false)
    private long productId;

    @Column(nullable = false)
    private int quantity;

    @Enumerated(EnumType.STRING)
    @JdbcTypeCode(SqlTypes.VARCHAR)
    @Column(nullable = false, length = 20)
    private ReservationStatus status;

    @Column(nullable = false, updatable = false)
    private Instant createdAt;

    @Column(nullable = false)
    private Instant updatedAt;

    protected Reservation() {}

    Long getId() { return id; }
    long getOrderId() { return orderId; }
    long getProductId() { return productId; }
    int getQuantity() { return quantity; }
    ReservationStatus getStatus() { return status; }
}
```

#### `src/main/java/com/example/shop/inventory/internal/ReservationStatus.java`（2.4.2）

```java
package com.example.shop.inventory.internal;

/** 0.3.5：HELD → CONFIRMED → CONSUMED，或 → RELEASED */
enum ReservationStatus { HELD, CONFIRMED, CONSUMED, RELEASED }
```

#### `src/main/java/com/example/shop/ordering/OrderStatus.java`（2.4.2）

```java
package com.example.shop.ordering;

/** 0.5.1 的六個狀態 */
public enum OrderStatus { PENDING_PAYMENT, PAID, PICKING, SHIPPED, COMPLETED, CANCELLED }
```

#### `src/main/java/com/example/shop/ordering/internal/OrderItem.java`（2.4.2）

```java
package com.example.shop.ordering.internal;

import jakarta.persistence.*;

import java.math.BigDecimal;

@Entity
@Table(name = "order_items")
class OrderItem {

    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "order_id")
    private Order order;

    @Column(nullable = false)
    private long productId;                        // 跨模組：只存 id（1.5.5）

    @Column(nullable = false, length = 200)
    private String productName;                    // 快照

    @Column(nullable = false, precision = 12, scale = 2)
    private BigDecimal unitPrice;                  // 快照

    @Column(nullable = false)
    private int quantity;

    @Column(precision = 12, scale = 2, insertable = false, updatable = false)
    private BigDecimal lineAmount;                 // 資料庫的產生欄位（unit_price * quantity），唯讀

    protected OrderItem() {}

    Long getId() { return id; }
    long getProductId() { return productId; }
    String getProductName() { return productName; }
    BigDecimal getUnitPrice() { return unitPrice; }
    int getQuantity() { return quantity; }
    BigDecimal getLineAmount() { return lineAmount; }
}
```

#### `src/test/java/com/example/lab/ch02/seed/SeedOrderItem.java`（2.2.4）

```java
package com.example.lab.ch02.seed;

import jakarta.persistence.*;

import java.math.BigDecimal;

@Entity
@Table(name = "c4_order_items")
public class SeedOrderItem {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    Long id;
    @ManyToOne(fetch = FetchType.LAZY) @JoinColumn(name = "order_id")
    SeedOrder order;
    long productId;
    BigDecimal unitPrice;
    int quantity;

    protected SeedOrderItem() {}
    SeedOrderItem(SeedOrder o, long productId, BigDecimal unitPrice, int quantity) {
        this.order = o; this.productId = productId; this.unitPrice = unitPrice; this.quantity = quantity;
    }
}
```

#### `src/test/java/com/example/lab/ch02/seed/AssignedOrder.java`（2.2.4）

```java
package com.example.lab.ch02.seed;

import jakarta.persistence.*;
import org.springframework.data.domain.Persistable;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/** 同一張表，但主鍵由程式指定 —— Hibernate 才能做 JDBC 批次 */
@Entity
@Table(name = "c4_orders")
public class AssignedOrder {
    @Id Long id;
    long buyerId;
    BigDecimal totalAmount;
    Instant createdAt;
    @OneToMany(mappedBy = "order", cascade = CascadeType.PERSIST)
    List<AssignedOrderItem> items = new ArrayList<>();

    protected AssignedOrder() {}
    public AssignedOrder(long id, long buyerId, Instant createdAt) { this.id = id; this.buyerId = buyerId; this.createdAt = createdAt; this.totalAmount = BigDecimal.ZERO; }
    public void add(long itemId, long productId, BigDecimal price, int qty) {
        items.add(new AssignedOrderItem(itemId, this, productId, price, qty));
        totalAmount = totalAmount.add(price.multiply(BigDecimal.valueOf(qty)));
    }
}
```

#### `src/test/java/com/example/lab/ch02/seed/AssignedOrderItem.java`（2.2.4）

```java
package com.example.lab.ch02.seed;

import jakarta.persistence.*;

import java.math.BigDecimal;

@Entity
@Table(name = "c4_order_items")
public class AssignedOrderItem {
    @Id Long id;
    @ManyToOne(fetch = FetchType.LAZY) @JoinColumn(name = "order_id")
    AssignedOrder order;
    long productId;
    BigDecimal unitPrice;
    int quantity;

    protected AssignedOrderItem() {}
    AssignedOrderItem(long id, AssignedOrder o, long productId, BigDecimal unitPrice, int quantity) {
        this.id = id; this.order = o; this.productId = productId; this.unitPrice = unitPrice; this.quantity = quantity;
    }
}
```

#### `src/test/java/com/example/shop/ch02/C5WhatTheDatabaseCannotStopTest.java`（2.4.3、2.5.4）

```java
package com.example.shop.ch02;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.Instant;
import java.util.TimeZone;

/** 2.5.4 資料庫擋不住的規則，以及 2.4.3 時區。在 shop_lab 裡跑。 */
@Tag("experiment")
class C5WhatTheDatabaseCannotStopTest {

    static final String URL = "jdbc:mysql://localhost:3306/shop_lab?useSSL=false&allowPublicKeyRetrieval=true";
    static final JdbcTemplate JDBC = new JdbcTemplate(new org.springframework.jdbc.datasource.SingleConnectionDataSource(URL + "&connectionTimeZone=UTC", "shop", "shop", true));

    static void attempt(String label, String sql) {
        try {
            JDBC.execute(sql);
            System.out.printf("  %-40s → 成功執行%n", label);
        } catch (Exception e) {
            Throwable t = e; while (t.getCause() != null) t = t.getCause();
            System.out.printf("  %-40s → %s%n", label, t.getMessage());
        }
    }

    @Test
    void whatTheDatabaseCannotStop() {
        System.out.println("═══ 2.5.4 資料庫擋不住的規則 ═══");
        JDBC.execute("DROP TABLE IF EXISTS c5_products");
        JDBC.execute("DROP TABLE IF EXISTS c5_categories");
        JDBC.execute("CREATE TABLE c5_products (id INT PRIMARY KEY, price DECIMAL(12,2) NOT NULL, CHECK (price > 0))");
        attempt("① 價格 99.999（小數 3 位）", "INSERT INTO c5_products VALUES (1, 99.999)");
        System.out.println("      存進去的值：" + JDBC.queryForObject("SELECT price FROM c5_products WHERE id = 1", String.class));
        JDBC.execute("CREATE TABLE c5_categories (id INT PRIMARY KEY, parent_id INT NULL, name VARCHAR(50) NOT NULL, UNIQUE KEY uk (parent_id, name))");
        attempt("② 第一個頂層分類「服飾」", "INSERT INTO c5_categories VALUES (1, NULL, '服飾')");
        attempt("   第二個頂層分類「服飾」", "INSERT INTO c5_categories VALUES (2, NULL, '服飾')");
        attempt("   子分類「男裝」×2（parent 相同）", "INSERT INTO c5_categories VALUES (3, 1, '男裝'), (4, 1, '男裝')");
        System.out.println("      頂層的「服飾」有幾個：" + JDBC.queryForObject("SELECT COUNT(*) FROM c5_categories WHERE parent_id IS NULL AND name = '服飾'", Integer.class));
        JDBC.execute("DELETE FROM c5_categories WHERE id = 2");
        attempt("②' 改用函式索引（MySQL 8.0.13+）", "CREATE UNIQUE INDEX uk_top_name ON c5_categories ((IF(parent_id IS NULL, name, NULL)))");
        attempt("   再建一個頂層「服飾」", "INSERT INTO c5_categories VALUES (2, NULL, '服飾')");
        attempt("   「男裝」底下的「服飾」", "INSERT INTO c5_categories VALUES (5, 3, '服飾')");
        attempt("③ CHECK 裡用子查詢（INV-2）", """
                ALTER TABLE c5_products ADD CONSTRAINT ck_inv2
                  CHECK (price <= (SELECT MAX(price) FROM c5_products))""");
        attempt("④ CHECK 裡用 NOW()（付款期限在未來）", """
                ALTER TABLE c5_products ADD COLUMN deadline DATETIME(3) NULL,
                  ADD CONSTRAINT ck_future CHECK (deadline > NOW())""");
        attempt("⑤ UNIQUE 帶 WHERE（部分索引）", "CREATE UNIQUE INDEX uk_partial ON c5_categories (name) WHERE parent_id IS NULL");
    }

    @Test
    void timeZone() throws Exception {
        System.out.println("═══ 2.4.3 同一個 Instant，兩種連線設定 ═══");
        TimeZone.setDefault(TimeZone.getTimeZone("Asia/Taipei"));         // 你的筆電
        Instant t = Instant.parse("2026-09-23T16:30:00Z");                // UTC 16:30 = 台北 00:30（隔天）
        try (Connection c = DriverManager.getConnection(URL, "shop", "shop"); Statement st = c.createStatement()) {
            st.execute("DROP TABLE IF EXISTS c5_times");
            st.execute("CREATE TABLE c5_times (label VARCHAR(40), at DATETIME(3))");
        }
        for (String opt : new String[]{"", "&connectionTimeZone=UTC"}) {
            try (Connection c = DriverManager.getConnection(URL + opt, "shop", "shop");
                 PreparedStatement ps = c.prepareStatement("INSERT INTO c5_times VALUES (?, ?)")) {
                ps.setString(1, opt.isEmpty() ? "沒設 connectionTimeZone" : "connectionTimeZone=UTC");
                ps.setObject(2, t);
                ps.executeUpdate();
            }
        }
        try (Connection c = DriverManager.getConnection(URL + "&connectionTimeZone=UTC", "shop", "shop");
             ResultSet rs = c.createStatement().executeQuery(
                     "SELECT label, DATE_FORMAT(at, '%Y-%m-%d %H:%i:%s') AS raw, DATE(at) AS utc_day FROM c5_times")) {
            System.out.println("  寫入的 Instant：" + t + "（台北時間 2026-09-24 00:30）");
            while (rs.next()) System.out.printf("  %-24s → 資料庫裡的值 %s   DATE() = %s%n", rs.getString(1), rs.getString(2), rs.getString(3));
        }
    }
}
```

#### `src/test/java/com/example/shop/ch02/C6LockSideEffectsTest.java`（2.4.4、2.6.2）

```java
package com.example.shop.ch02;

import com.zaxxer.hikari.HikariDataSource;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.dao.PessimisticLockingFailureException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 2.6 schema 決定了鎖：
 *  (a) 同模組外鍵：先 INSERT 子表、再 UPDATE 父表 → 死鎖
 *  (b) 訂單編號：每日流水號（一列計數器） vs 隨機號碼 + UNIQUE
 */
@Tag("experiment")
class C6LockSideEffectsTest {

    static final int THREADS = 16;
    static HikariDataSource ds;
    static JdbcTemplate jdbc;
    static TransactionTemplate tx;

    @BeforeAll
    static void setUp() {
        ds = new HikariDataSource();
        ds.setJdbcUrl("jdbc:mysql://localhost:3306/shop_lab?useSSL=false&allowPublicKeyRetrieval=true&connectionTimeZone=UTC");
        ds.setUsername("shop");
        ds.setPassword("shop");
        ds.setMaximumPoolSize(THREADS + 2);
        jdbc = new JdbcTemplate(ds);
        tx = new TransactionTemplate(new DataSourceTransactionManager(ds));
    }

    @AfterAll
    static void tearDown() { ds.close(); }

    interface Op { void run(ThreadLocalRandom r) throws Exception; }

    record Stat(int ok, int deadlocks, int dup, double tps, double p99) {}

    static Stat measure(int seconds, Op op) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(THREADS);
        AtomicBoolean stop = new AtomicBoolean();
        AtomicInteger ok = new AtomicInteger(), dead = new AtomicInteger(), dup = new AtomicInteger();
        List<Future<List<Long>>> fs = new ArrayList<>();
        for (int i = 0; i < THREADS; i++) fs.add(pool.submit(() -> {
            List<Long> lat = new ArrayList<>();
            while (!stop.get()) {
                long s = System.nanoTime();
                try { op.run(ThreadLocalRandom.current()); ok.incrementAndGet(); lat.add(System.nanoTime() - s); }
                catch (PessimisticLockingFailureException e) { dead.incrementAndGet(); }
                catch (DuplicateKeyException e) { dup.incrementAndGet(); }
            }
            return lat;
        }));
        Thread.sleep(seconds * 1000L);
        stop.set(true);
        List<Long> all = new ArrayList<>();
        for (Future<List<Long>> f : fs) all.addAll(f.get());
        pool.shutdown();
        long[] a = all.stream().mapToLong(Long::longValue).sorted().toArray();
        return new Stat(ok.get(), dead.get(), dup.get(), ok.get() / (double) seconds, a.length == 0 ? 0 : a[(int) (a.length * 0.99)] / 1e6);
    }

    @Test
    void foreignKeyStatementOrder() throws Exception {
        jdbc.execute("DROP TABLE IF EXISTS c6_ledger");
        jdbc.execute("DROP TABLE IF EXISTS c6_inventory");
        jdbc.execute("CREATE TABLE c6_inventory (product_id BIGINT PRIMARY KEY, on_hand INT NOT NULL)");
        jdbc.execute("""
            CREATE TABLE c6_ledger (id BIGINT AUTO_INCREMENT PRIMARY KEY, product_id BIGINT NOT NULL, delta INT NOT NULL,
              CONSTRAINT fk_c6 FOREIGN KEY (product_id) REFERENCES c6_inventory (product_id))""");
        jdbc.update("INSERT INTO c6_inventory VALUES (1, 0)");
        System.out.println("═══ 2.6.2 同模組外鍵：補貨（同一個商品），兩種語句順序，16 條執行緒各 5 秒 ═══");
        measure(3, r -> jdbc.update("UPDATE c6_inventory SET on_hand = on_hand WHERE product_id = 1"));   // 暖機
        Stat wrong = measure(5, r -> tx.executeWithoutResult(s -> {
            jdbc.update("INSERT INTO c6_ledger (product_id, delta) VALUES (1, 1)");        // 子表先：對父列加 S 鎖
            jdbc.update("UPDATE c6_inventory SET on_hand = on_hand + 1 WHERE product_id = 1"); // 再升級成 X 鎖
        }));
        Stat right = measure(5, r -> tx.executeWithoutResult(s -> {
            jdbc.update("UPDATE c6_inventory SET on_hand = on_hand + 1 WHERE product_id = 1"); // 父表先：直接拿 X 鎖
            jdbc.update("INSERT INTO c6_ledger (product_id, delta) VALUES (1, 1)");
        }));
        System.out.printf("  先 INSERT 帳、再 UPDATE 庫存 : 成功 %,6d 筆（%,5.0f 筆/秒）  死鎖 %,5d 次  p99 %6.2f ms%n", wrong.ok, wrong.tps, wrong.deadlocks, wrong.p99);
        System.out.printf("  先 UPDATE 庫存、再 INSERT 帳 : 成功 %,6d 筆（%,5.0f 筆/秒）  死鎖 %,5d 次  p99 %6.2f ms%n", right.ok, right.tps, right.deadlocks, right.p99);
        System.out.println("  對帳：on_hand = " + jdbc.queryForObject("SELECT on_hand FROM c6_inventory", Integer.class)
                + "，Σ ledger = " + jdbc.queryForObject("SELECT SUM(delta) FROM c6_ledger", Integer.class));
    }

    @Test
    void orderNumberStrategies() throws Exception {
        jdbc.execute("DROP TABLE IF EXISTS c6_orders");
        jdbc.execute("DROP TABLE IF EXISTS c6_order_no_seq");
        jdbc.execute("""
            CREATE TABLE c6_orders (id BIGINT AUTO_INCREMENT PRIMARY KEY, order_no VARCHAR(15) NULL, buyer_id BIGINT NOT NULL,
              UNIQUE KEY uk_c6_order_no (order_no))""");
        jdbc.execute("CREATE TABLE c6_order_no_seq (day CHAR(8) PRIMARY KEY, last_no INT NOT NULL)");
        jdbc.update("INSERT INTO c6_order_no_seq VALUES ('20260929', 0)");
        System.out.println("═══ 2.4.4 訂單編號怎麼產生：16 條執行緒下單（分散在不同商品），各 5 秒 ═══");
        measure(3, r -> tx.executeWithoutResult(s ->                      // 暖機 3 秒（JIT、連線池、buffer pool）
                jdbc.update("INSERT INTO c6_orders (buyer_id) VALUES (?)", r.nextLong(1, 100_000))));
        jdbc.update("TRUNCATE c6_orders");
        Stat none = measure(5, r -> tx.executeWithoutResult(s ->
                jdbc.update("INSERT INTO c6_orders (buyer_id) VALUES (?)", r.nextLong(1, 100_000))));
        Stat seq = measure(5, r -> tx.executeWithoutResult(s -> {
            jdbc.update("UPDATE c6_order_no_seq SET last_no = LAST_INSERT_ID(last_no + 1) WHERE day = '20260929'");
            long n = jdbc.queryForObject("SELECT LAST_INSERT_ID()", Long.class);
            jdbc.update("INSERT INTO c6_orders (order_no, buyer_id) VALUES (?, ?)", "20260929-%06d".formatted(n), r.nextLong(1, 100_000));
        }));
        jdbc.update("TRUNCATE c6_orders");
        Stat random = measure(5, r -> tx.executeWithoutResult(s ->
                jdbc.update("INSERT INTO c6_orders (order_no, buyer_id) VALUES (?, ?)",
                        "20260929-%06d".formatted(r.nextInt(1_000_000)), r.nextLong(1, 100_000))));
        System.out.printf("  不產生編號（基準）          : %,6.0f 筆/秒  p99 %6.2f ms%n", none.tps, none.p99);
        System.out.printf("  每日流水號（一列計數器）     : %,6.0f 筆/秒  p99 %6.2f ms%n", seq.tps, seq.p99);
        System.out.printf("  隨機 6 碼 + UNIQUE          : %,6.0f 筆/秒  p99 %6.2f ms  撞號 %d 次（共 %,d 筆）%n", random.tps, random.p99, random.dup, random.ok);
    }
}
```

---

## 2.12 常見誤區

**① 「開發時用 `ddl-auto=update` 比較方便，上線前再換」**

2.2.1：第二版 enum 多一個值 → `Data truncated for column 'status'`。`update` 只會新增表與欄位，**不改任何已存在的東西**。
而「上線前再換」的那一刻，你手上沒有任何一個 migration 能重現開發環境的 schema。**第一天就用 Flyway。**

**② 「`ddl-auto=validate` 通過，schema 就是對的」**

2.4.2：12 種不一致，它只抓到 7 種。**精度、長度、NOT NULL、多出來的欄位、約束與索引** —— 全部看不到。
`EntitySchemaDriftTest` 與 Q6 補上前三類與最後一類；「多出來的 NOT NULL 欄位」是練習七。

**③ 「外鍵越多越安全」**

2.2.3：跨模組的外鍵讓賣家的一次批次改價，讓全部下單執行緒卡住 1.25 秒。**同模組要、跨模組不要**（2.6.1）。

**④ 「p99 沒變，就沒事」**

2.2.3：有外鍵的那一次，p99 是 14.76 ms —— 比沒有外鍵還低。被卡住的 16 個請求只佔 0.3%。
**「少數請求等很久」要看最大值、看時間軸上的 0、看連線池等待數**。

**⑤ 「設了 `hibernate.jdbc.batch_size` 就是批次寫入」**

2.2.4：主鍵是 `IDENTITY` 時，Hibernate 悄悄停用 batch —— 40,000 句 INSERT。**大量寫入用 `JdbcTemplate.batchUpdate` + `rewriteBatchedStatements=true`**：20 句。

**⑥ 「Flyway 失敗了，照訊息執行 `repair` 就好」**

2.2.2：checksum 不符時 `repair` 會把錯的變成「對的」；DDL 做到一半時 `repair` 之後再跑 → `Duplicate column`。
**`repair` 只修 `flyway_schema_history`，不修 schema。** 先弄清楚資料庫現在的狀態，再決定。

**⑦ 「`Found non-empty schema` 就開 `baselineOnMigrate`」**

2.9.3：它把現有的資料庫當成 V1 —— **V1 被跳過，`users` 表永遠不會被建立**。本機的正解是清掉資料庫；`baselineOnMigrate` 是給「接手一個從沒用過 Flyway 的正式資料庫」用的。

**⑧ 「MySQL 8 的 CHECK 會擋下所有不合法的資料」**

2.5.4：`99.999` 默默存成 `100.00`；`NULL` 參與的 UNIQUE 不擋重複；CHECK 不能跨表、不能用 `NOW()`。
**CHECK 只能守「同一列」的規則**，其他的要交給 Bean Validation、Service 層、對帳或權限。

**⑨ 「刪掉 migration 檔，它就不存在了」**

2.9.5：`target/classes` 裡的舊檔繼續被 Flyway 執行；`mvn clean` 之後，資料庫的歷史比程式碼新，Flyway 只給一行 WARN。**刪或改名 migration 之後 `mvn clean`，並清掉本機資料庫裡它留下的東西。**

**⑩ 「訂單編號用每日流水號，簡單又好讀」**

2.4.4：一列計數器 = 全站的熱點行，下單被壓到 500～600 筆/秒；而且它洩漏每天的訂單量。**隨機碼 + UNIQUE + 撞號重試**，撞號次數可以用 n²/2m 算出來。

**⑪ 「加長一個 VARCHAR 是線上操作，隨時可以做」**

2.9.6：在 `orders` 上，`VARCHAR(15) → (16)` 被拒絕 INPLACE，只能 COPY（寫入被擋住）。**每一句正式環境的 DDL 都明寫 `ALGORITHM` 與 `LOCK`**，讓做不到的時候直接失敗，並在種子資料上先跑一次。

**⑫ 「種子資料隨便塞一點就好」**

2.7.3：「每位買家隨機 5 張訂單」的種子資料，測不出重度買家的 20 ms 全表掃描。
**種子資料的分布決定了你的效能測試能發現什麼**：要有尾巴（重度使用者、熱門賣家）、要有邊界（台北凌晨的訂單）、要滿足所有約束。

---

## 2.13 本章小結

**這一章建立了五件事**：

1. **一個原則**（2.2.1、2.9）：**schema 只能透過 Flyway 改變**，而 Flyway 在 MySQL 上有四條硬規則 —— 不改已執行的檔、一個檔一句 DDL、撞號改名、刪檔要 clean。
2. **一份有理由的 schema**（2.3、2.4）：19 張表、10 條同模組外鍵、15 條跨模組參照（0 個外鍵）；每一個欄位型別、每一個長度都指得回一條需求。
3. **約束即不變量**（2.5）：24 個 CHECK、UNIQUE 與外鍵，22 種非法資料全部被擋下；擋不住的四類規則各有主人；對帳 SQL 在 10 萬張訂單上全部 0 差異。
4. **有數字的取捨**（2.2.3、2.4.4、2.6.2、2.7）：跨模組外鍵 → 1.25 秒的 0；流水號 → 600 筆/秒以下；語句順序 → 9,062 次死鎖；複合索引 → 3,000 列變 20 列；5 個索引 → 寫入 −41%。
5. **一組守門員**（2.4.2、2.9.4、2.9.7、2.10）：`EntitySchemaDriftTest`、`MigrationOwnershipTest`、`EntityTableOwnershipTest`、`SchemaConstraintTest`、`InvariantReconciliationTest`，以及變綠的 **Q6**。

**如果這一章只能記一句話**：

> **schema 的每一條規則，都要有一個會失敗的東西守著：約束、測試、或對帳。三者都守不住的規則，就要寫下來它由誰負責。**

### 2.13.1 驗收清單

做得到才往下走：

- [ ] `docker compose exec -T mysql mysql -uroot -proot < docker/mysql-init/01-databases.sql` 執行過，`shop_lab` 存在。
- [ ] 跑完 2.2.1，說出 `ddl-auto=update` 會做與不會做的事，以及 `Data truncated for column 'status'` 的真正意思。
- [ ] 說出為什麼每個 enum 欄位都要 `@JdbcTypeCode(SqlTypes.VARCHAR)`，並說出沒加時的錯誤訊息長什麼樣子。
- [ ] 說出 `validate` 抓不到的五種不一致，以及本專題用哪兩個測試補上。
- [ ] 跑完 2.2.2，說出「一個檔兩句 DDL」失敗後的三次部署分別發生什麼事，以及為什麼 PostgreSQL 上不會這樣。
- [ ] 跑完 2.2.3，看到時間軸上的 0，並解釋為什麼 p99 反而沒有變差。
- [ ] 說出 JPA `IDENTITY` 主鍵為什麼讓 `batch_size` 失效。
- [ ] 跑完 2.4.3，說出少了 `connectionTimeZone=UTC` 會差幾小時、以及為什麼那個錯誤「一半的資料對、一半的錯」。
- [ ] 用 n²/2m 估算：一天 2 萬張訂單、6 碼隨機編號，會撞幾次？
- [ ] 說出 CHECK 遇到 `NULL` 的規則，並舉出一個「剛好是我們要的」與一個「會變成洞」的例子。
- [ ] 說出 MySQL 沒有部分索引時，`uk_categories_top_level_name` 用什麼做到同樣的效果。
- [ ] 跑完 2.6.2，說出「先 INSERT 子表、再 UPDATE 父表」為什麼會死鎖。
- [ ] 讀懂 2.7.2 的 `EXPLAIN ANALYZE`，說出單欄索引與複合索引「實際讀了幾列」的差別。
- [ ] 用 invisible index 把 `idx_orders_buyer_created` 關掉、量一次、再打開，並確認 `is_visible = 'NO'` 的查詢回傳 0 列。
- [ ] `mvn test -Pseed -Dtest=SeedData` 在 40 秒內完成，`InvariantReconciliationTest` 全部 0 差異。
- [ ] 說出 `baselineOnMigrate` 是給什麼情境用的、在本機用它會發生什麼事。
- [ ] 說出「加一個 NOT NULL 欄位」在滾動部署下要拆成幾次上線、每一次做什麼。
- [ ] `mvn clean verify` 顯示 `Tests run: 24, Failures: 0, Errors: 0, Skipped: 10`。

### 2.13.2 本章練習

**練習一（15 分鐘）：外鍵的代價跟誰成正比？**

把 2.2.3 賣家交易裡的 `Thread.sleep(2)` 拿掉（整個改價交易只剩 500 句 UPDATE）。時間軸上還有 0 嗎？最慢的一筆變成多少？
再把它改成 `Thread.sleep(10)`。**寫下「最慢一筆」與「賣家交易長度」的關係**，並回答：如果賣家的交易裡呼叫了一個 3 秒逾時的外部 API 呢？

**練習二（15 分鐘）：INV-4 的另一種寫法**

本專題用 `UNIQUE (order_id, product_id)` 表達 INV-4，比 0.4.6 的原文（「最多一筆**非 `RELEASED`** 的預留」）更嚴格。
用 2.5.4 的函式索引技巧，寫出**完全照原文**的版本（提示：`IF(status <> 'RELEASED', ..., NULL)`；函式索引可以有多個欄位嗎？）。
**然後回答**：什麼樣的需求變更會讓你需要換成這個版本？（提示：同一張訂單「釋放後重新預留」—— 0.5 的狀態機允許嗎？）

**練習三（30 分鐘）：expand / contract**

需求：訂單要有 `note VARCHAR(200) NOT NULL DEFAULT ''`。照 2.9.6 的表，拆成三個 migration：
V11（加成 `NULL`，`ALGORITHM=INSTANT`）、V12（`UPDATE orders SET note = '' WHERE note IS NULL`）、V13（改成 `NOT NULL`）。
每一個都跑一次 `mvn test`（`MigrationOwnershipTest`、Q6、`EntitySchemaDriftTest` —— 記得改 `Order` Entity）。
**在 10 萬張訂單的種子資料上量 V13 花多久、用哪一種演算法**。放大到 550 萬張時，它需要維護時段嗎？

**練習四（20 分鐘）：賣家訂單列表要不要多一個索引？**

`GET /api/seller/orders?status=PICKING`：賣家 2 有 10,928 張訂單，其中 `PICKING` 的很少。
用 2.7.2 的方法，比較 `(seller_id, created_at)` 與新建的 `(seller_id, status, created_at)` 的 `EXPLAIN ANALYZE`（實際讀了幾列）。
**先把新索引設成 invisible 建立、再打開**，並用 2.7.4 的方法估算它的寫入代價。**寫下你的決定與理由。**

**練習五（10 分鐘）：弄壞種子資料**

把 `SeedData.writeOrders()` 裡的 `shipped ? "黑貓宅急便" : null` 改成 `null`，跑 `mvn test -Pseed -Dtest=SeedData`：
第一批 INSERT 會停在 `Check constraint 'ck_orders_shipment' is violated.`。改回來之後，再試一次：把 `decideLifecycle()` 裡的 `o.paidAt = ...` 那一行拿掉。
**這次是哪一個約束擋下的？還是 Java 先炸了？**（提示：看看 `writeOrders()` 裡哪些地方用到了 `paidAt`。）

**練習六（20 分鐘）：對帳全綠，但每一張訂單都錯了**

把 `application-local.yml` 的 JDBC URL 拿掉 `connectionTimeZone=UTC`，重跑種子資料。
然後跑 `InvariantReconciliationTest`：**全部 0 差異**。再查 `SELECT MIN(created_at), MAX(created_at) FROM orders`，跟 `SEED_NOW` 比。
**寫下結論**：對帳能抓到什麼、抓不到什麼？什麼樣的測試才抓得到這個錯誤？（第 03 章的日報表會正面處理這個問題。記得改回來、再重跑一次種子資料。）

**練習七（進階，30 分鐘）：補上 `validate` 的第 ⑪ 種盲點**

擴充 `EntitySchemaDriftTest`：列出每張表裡「**`NOT NULL`、沒有預設值、不是產生欄位**」的欄位，檢查它們**全部**都被 Entity 對應到。
然後在 V11 裡給 `products` 加一個 `sku VARCHAR(40) NOT NULL`（不加預設值、不改 Entity），確認你的測試會紅、`validate` 不會。

**練習八（進階，40 分鐘）：找出 2.9.6 的真正條件**

2.9.6 發現 `ck_orders_paid` 或 `ck_orders_shipment` 讓無關欄位的 VARCHAR 加長變成 COPY，但我們沒有找到條件。
在 `shop_lab` 裡建最小的表，一個一個加欄位與約束，找出**最小的重現條件**（提示：單獨 `CHECK (d IS NOT NULL)` 在只有一個 `DATETIME` 欄位的表上是 INPLACE；加上一個 `VARCHAR` 的 `status` 欄位之後呢？）。
**然後回答**：知道了條件之後，你會改寫這兩個約束嗎？還是保留它們、接受加長欄位要 COPY？寫下取捨。

---

## 2.14 下一章預告

下一章（03）回答一個問題：**有了 schema 與 Entity，要怎麼把它們「安全地」暴露成 API？**

本章的 Entity 全部是 package-private、沒有 setter、放在 `internal` 裡 —— 它們**不會**直接變成 JSON。
下一章要蓋的是 Entity 與 HTTP 之間的那一層：商品的 CRUD 與搜尋、購物車、訂單查詢、以及用 MyBatis 寫的賣家日報表。

這一章會回答四個問題：

- **為什麼 `open-in-view: false`？** 如果 Controller 直接回傳 Entity，關掉它會怎樣、開著它又會怎樣？
  「訂單列表一頁 20 筆」到底執行了幾句 SQL —— 這就是**驗收 Q4**，而下一章會用 Hibernate 的 `Statistics` 把那個數字變成一個斷言。
- **錯誤回應要長什麼樣子？** 0.4.1 的 12 種 Problem Details `type`，要怎麼讓每一個模組的例外都對應到其中一種，而且 **`shared` 不依賴任何模組**（1.5.7）？
  以及一個常見的「好心」寫法：把例外的 `getMessage()` 放進錯誤回應 —— 它會把什麼東西送到使用者的瀏覽器裡？
- **搜尋框輸入一個 `%` 會怎樣？** US-PRD-2 AC-4 要求 `LIKE` 跳脫；在 1 萬個商品上不跳脫會發生什麼事？
- **「9 月 1 日的營收」是哪 24 小時？** 本章的種子資料刻意在台北凌晨 0～8 點放了訂單 —— 用 `DATE(created_at)` 切日的報表，會把它們算到哪一天？而改成正確的寫法之後，90 天的報表還能在 1 秒內跑完嗎（US-RPT-1 AC-4）？

地基灌好了。下一章開門窗。
