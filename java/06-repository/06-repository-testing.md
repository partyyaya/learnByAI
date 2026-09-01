# 第 06 章：資料層測試

> 00～05 章一共跑了 **60 多組實驗**，全部在 **H2** 上。
> 每一章的最後都有一張「本章沒有驗證到的」表，加起來 **20 多項**，
> 而它們幾乎全部指向同一句話：**「因為本機沒有 MySQL」。**
>
> **這一章把 MySQL 裝起來，然後做一件很簡單的事**：
> **把同一組東西在兩邊各跑一次。**
>
> ---
>
> **第一個結果**：02～05 章那 17 條契約測試，**在 H2 上綠了整整四章**。
> 把它們原封不動搬到真的 MySQL 8 上：
>
> ```
> [ERROR] Tests run: 17, Failures: 0, Errors: 2 -- in lab.MySqlJdbcOrderRepositoryContractTest
>
> PreparedStatementCallback; bad SQL grammar [SELECT id, customer_id, status, …
>   FROM orders
>  WHERE status = 'PENDING_PAYMENT' AND created_at < ?
>  ORDER BY created_at, id
>  FETCH FIRST ? ROWS ONLY
> ]
> ```
>
> 🔴 **兩條紅的，病因是 `FETCH FIRST ? ROWS ONLY` —— MySQL 8 不支援它。**
>
> ⚠️ **而那一句是 02 章 2.6.4【為了可攜性】特地寫的**：
> 當時把 `LIMIT :limit` 換成了「標準 SQL 的 `FETCH FIRST`」。
> **換掉之後，它在 H2 上綠了四章，而它在正式環境用的資料庫上是一個語法錯誤。**
>
> ---
>
> **第二個結果更糟**。04 章 4.7.4 花了一整節證明
> 「keyset 分頁的 `OR` 寫法掃 100,000 列，row value 寫法掃 21 列，差 4,762 倍」。
> **同一組 SQL、同一個索引，在 MySQL 8 上**：
>
> ```
>                                      H2 2.2.224      MySQL 8.0.46
>   keyset ① OR 寫法                    4,802 µs   🔴      513 µs   ✅  (type=range)
>   keyset ② row value                    113 µs   ✅   13,235 µs   🔴  (type=index)
> ```
>
> 🔴 **快慢【完全對調】。**
> **04 章根據 H2 的量測寫下的「不要用 ①」，在 MySQL 上是【錯的】。**
>
> ---
>
> 📌 **所以這一章要回答的問題不是「怎麼寫測試」，是**：
>
> > **「我的測試到底在測什麼？」**
>
> | # | 問題 | 哪一節 |
> |---|---|---|
> | 1 | `@DataJpaTest` 載入了什麼、沒載入什麼 | 6.2 |
> | 2 | ★ 測完自動回滾，**藏起來了什麼** | **6.3** |
> | 3 | ★★ **H2 與 MySQL 的二十一根探針** | **6.4** |
> | 4 | 怎麼在測試裡跑一個真的 MySQL（以及 Testcontainers 的一個雷） | 6.5 |
> | 5 | ★ **同一組契約在兩個資料庫上跑，有幾條會不一樣** | **6.6** |
> | 6 | 測試資料怎麼準備（`ddl-auto` 是一個陷阱） | 6.7 |
> | 7 | 測試之間怎麼清乾淨 | 6.8 |
> | 8 | ★ CI 從 4 分鐘變 47 分鐘：Spring 的 context 快取 | **6.9** |

---

## 6.1 學習目標

完成本章後，你應該可以：

- 說出 `@DataJpaTest` 載入了哪些 bean、**不載入**哪些，以及那對「能測什麼」的限制。
- 說出「測完自動回滾」**藏起來的三件事**，並寫出對應的修法。
- 列出至少 **8 個 H2 與 MySQL 行為不同的地方**，並說明每一個會造成什麼事故。
- 建立一個跑在真 MySQL 上的測試，並判斷「哪些測試該用它、哪些不該」。
- 說出 `ddl-auto` 產生的 schema 與正式環境的 schema **差在哪裡**，以及為什麼那是一個陷阱。
- 在「回滾」「truncate」「重建」三種清理策略之間做選擇。
- 說出 Spring context 快取的鍵是什麼，並說明**多寫一行 `@TestPropertySource` 的代價**。
- 為一個專案設計資料層的測試策略：**哪一層用 H2、哪一層用真資料庫、比例大概多少**。

---

## 6.2 `@DataJpaTest` 載入了什麼

### 6.2.1 先解決一個啟動錯誤

```java
@DataJpaTest
class S1_TestSliceTest { … }
```

```
[ERROR] S1_TestSliceTest » IllegalState Unable to find a @SpringBootConfiguration,
        you need to use @ContextConfiguration or @SpringBootTest(classes=...) with your test
```

**原因**：`@DataJpaTest` 從**測試類別所在的套件往上找** `@SpringBootConfiguration`。
本課的實驗放在 `lab` 套件，而應用程式在 `example.shop` —— 找不到。

**兩種修法**：

```java
// ① 把測試放在和應用程式相同的套件樹下（正式專案的標準做法）
package example.shop.order.infrastructure.jpa;

// ② 明確指定（本課 lab 用這個）
@DataJpaTest
@ContextConfiguration(classes = example.shop.ShopApplication.class)
```

📌 **正式專案用 ①**：`src/test/java` 的套件結構要和 `src/main/java` 一致。
這不只是慣例 —— **Spring Boot 的所有測試切片都靠套件階層定位應用程式的根。**

### 6.2.2 ⚠️ 一個順手踩到的坑：`@ComponentScan` 擋不住 repository 掃描

04 章寫了一個「故意讓啟動失敗」的 `BadNativeSortRepository`（4.5.3），
放在 `..infrastructure.jpa.bad` 並在每個實驗容器用 `excludeFilters` 排除。

換成 `@SpringBootApplication` 之後它又爆了：

```
Caused by: InvalidJpaQueryMethodException: Cannot use native queries with dynamic
sorting in method …BadNativeSortRepository.nativeWithSort(…)
```

**因為 `@ComponentScan` 的 `excludeFilters` 只管 `@Component` 的掃描，
而 Spring Data 的 repository 掃描是【另一個機制】。**

```java
@SpringBootApplication
@EnableJpaRepositories(basePackages = "example.shop",
        excludeFilters = @ComponentScan.Filter(          // ★ 要在這裡排除
                type = FilterType.REGEX, pattern = ".*\\.jpa\\.bad\\..*"))
public class ShopApplication { … }
```

📌 **記下這個區分**：
`@ComponentScan` 找的是 `@Component` / `@Service` / `@Repository` 的**類別**；
`@EnableJpaRepositories` 找的是繼承 `Repository` 的**介面**。
**兩套掃描、兩套過濾器。**

### 6.2.3 它載入了什麼

**實驗 S1-A**：

```
=== S1-A @DataJpaTest 載入的 bean 數 ===
  bean 總數：99
  EntityManagerFactory         ✅ 有
  DataSource                   ✅ 有
  JdbcTemplate                 ✅ 有
  PlatformTransactionManager   ✅ 有
  我們的 Repository              ✅ 有
  ObjectMapper                 🔴 沒有
  RestTemplateBuilder          🔴 沒有
```

**99 個 bean**（對照：一個完整的 `@SpringBootTest` 通常是好幾百個）。

`@DataJpaTest` 的定義說得很清楚，它只 import 這些 auto-configuration：

```
TransactionAutoConfiguration, JpaRepositoriesAutoConfiguration,
TestEntityManagerAutoConfiguration, CacheAutoConfiguration,
HibernateJpaAutoConfiguration, SqlInitializationAutoConfiguration,
TestDatabaseAutoConfiguration, FlywayAutoConfiguration,
DataSourceTransactionManagerAutoConfiguration, LiquibaseAutoConfiguration,
JdbcClientAutoConfiguration, DataSourceAutoConfiguration, JdbcTemplateAutoConfiguration
```

⚠️ **注意 `JdbcTemplate` 在裡面** —— 所以 02 章那些 `JdbcTemplate` 的實作
**也可以用 `@DataJpaTest` 測**，不需要 `@SpringBootTest`。

### 6.2.4 它【沒有】載入什麼

```
=== S1-C 沒有被載入的東西 ===
  ✅ SpecOrderSearchAdapter 沒有被載入（它不是 @Component）
  ★ 所以「Service + Repository 一起測」在 @DataJpaTest 裡做不到 ——
    要嘛用 @SpringBootTest，要嘛用 @Import 把需要的 bean 手動加進來
```

**`@Service` / `@Component` / `@RestController` 都不會被載入。**

**要把自己的 bean 加進來，用 `@Import`**：

```java
@DataJpaTest
@Import(SpecOrderSearchAdapter.class)          // ★ 只加需要的那一個
class SpecSearchTest {
    @Autowired OrderSearchPort port;
}
```

⚠️ **`@Import` 比 `@SpringBootTest` 好，但它有一個隱藏成本** ——
**每一組不同的 `@Import` 就是一個不同的 context**（6.9 會量給你看）。

### 6.2.5 四種切片怎麼選

| 你要測什麼 | 用什麼 | 載入 |
|---|---|---|
| Repository 的查詢與映射 | **`@DataJpaTest`** | 99 個 bean，約 1～2 秒 |
| Repository + 一兩個轉接器 | `@DataJpaTest` + `@Import` | 同上 |
| 純 `JdbcTemplate` 的 Repository | **`@JdbcTest`** | 更少（沒有 JPA） |
| Service + Repository 的整合 | `@SpringBootTest` | 全部，慢很多 |
| 領域邏輯、轉換、不變量 | **不用 Spring** | 0 個 bean，毫秒級 |

📌 **最後一列最重要**：
05-service 07 章講過的那件事在這裡一樣成立 ——
**能不用 Spring 測的，就不要用 Spring 測。**
本課 00 章的 `Order` 聚合、04 章的 `PageSpec` 白名單、`Cursor` 的編解碼，
**全部都是純 JUnit，不需要任何容器。**

---

## 6.3 ★ 測完自動回滾，藏起來了什麼

`@DataJpaTest` 預設每個測試方法跑在一個交易裡，**測完回滾**。

**實驗 S2-A**：

```
=== S2-A 每個測試預設在一個交易裡，測完自動回滾 ===
  測試 1 存了 O-ROLLBACK；此刻 count = 1
  測試 2 看到的 count = 0 → ✅ 測試 1 的資料被回滾了
```

**這件事很方便**（測試之間不用互相清理），**而它藏起來三件事。**

### 6.3.1 藏起來的第一件：約束違反不會在你以為的地方爆

```java
@Test
void 回滾藏起來的第一件事_約束違反() {
    // orders 表有 CHECK (total_minor >= 0)
    OrderEntity bad = new OrderEntity("O-BAD", "C-1", OrderStatus.PENDING_PAYMENT,
            -1, "TWD", Instant.parse("2026-03-01T00:00:00Z"));
    bad.replaceLines(List.of(new OrderLineEntity(1, "P-1", 1, 1, "TWD")));
    repo.save(bad);
}
```

```
=== S2-B 🔴 回滾藏起來的第一件事：約束違反不會在你以為的地方爆 ===
  save() 回來了，沒有拋例外 —— 因為 INSERT 還沒送出去（05 章 5.4.1）
  ★ 而測試方法【到這裡就結束了】，交易被回滾，那句 INSERT 【永遠不會送出】
  🔴 所以這個測試會【綠】，而正式環境會炸
```

**兩件事疊在一起**：

1. 05 章 5.4.1：**`save()` 不送 SQL**，`INSERT` 在 flush 才送出。
2. 測試結束就回滾 → **那句 `INSERT` 一輩子沒被送出去**。

📌 **修法：資料層的測試一定要 `flush`。**

```java
repo.saveAndFlush(bad);        // 或 tem.flush() / em.flush()
```

### 6.3.2 ★★ 而 `flush` 之後它【還是】沒爆

```
=== S2-C ★★ 為什麼 flush 之後【還是】沒爆 ===
  🔴 flush 了，還是沒有爆
  
  ★ 去看一下 ddl-auto 幫我們產生的那張表【有哪些約束】：
    CHECK        CONSTRAINT_8B    "STATUS" IN('PENDING_PAYMENT', 'PAID', 'PARTIALLY_SHIPPED',
                                  'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED')
    PRIMARY KEY  CONSTRAINT_8B7   
  
  🔴 唯一的 CHECK 是 Hibernate 為 @Enumerated(STRING) 自動產生的【列舉值檢查】。
    正式環境的 schema.sql 上還有：
      CONSTRAINT ck_orders_total    CHECK (total_minor >= 0)
      CONSTRAINT ck_orders_currency CHECK (currency IN ('TWD','JPY','USD'))
    而 ddl-auto=create-drop 是從 @Entity 產生 DDL 的，@Entity 上沒有寫那些約束。
  ★ 所以這個測試測的是【一張和正式環境不一樣的表】
    ⚠️ 這不是 H2 的錯，是 ddl-auto 的錯 —— 換成 MySQL 也一樣（6.7.1）
```

🔴 **這是本章第一個大結論**：

> **`ddl-auto` 產生的表，和正式環境的表【不是同一張表】。**

**差在哪裡**（每一項都會讓測試失去意義）：

| 正式環境的 schema 有 | `ddl-auto` 產生的 | 後果 |
|---|---|---|
| `CHECK (total_minor >= 0)` | 🔴 **沒有** | 00 章 0.8 那整節在講的不變量，測試測不到 |
| `CHECK (currency IN (...))` | 🔴 **沒有** | 幣別打錯測試不會紅 |
| **索引** | 🔴 只有主鍵與 `@Index` 明寫的 | 04 章的深分頁、排序效能全部測不出來 |
| **外鍵的 `ON DELETE` 行為** | ⚠️ 只有預設 | 刪除的連鎖行為測不到 |
| **欄位定序（collation）** | 🔴 用資料庫預設 | 6.4 探針 ⑬ 那個「大小寫」差異 |
| **`DEFAULT` 值、產生欄位** | 🔴 沒有 | —— |

📌 **修法：測試用【和正式環境同一份】DDL。**

```yaml
spring:
  jpa:
    hibernate:
      ddl-auto: none            # ★ 關掉
  sql:
    init:
      mode: always
      schema-locations: classpath:schema.sql    # ★ 和正式環境同一份
```

**更好的做法是用 Flyway / Liquibase**（07-mysql 站 06 章的主題）：
**測試跑的是和正式環境【完全相同的一串 migration】**。

⚠️ **這樣做會慢一點，而且會逼你面對「H2 跑不動 MySQL 的 DDL」這件事** ——
而那正是 6.5 要處理的。

### 6.3.3 藏起來的第二件：你查到的可能不是資料庫裡的

```java
repo.save(anOrder("O-CACHE"));
tem.flush();
// 直接用 SQL 改掉資料庫裡的值（繞過 Hibernate）
jdbc.update("UPDATE orders SET status = 'CANCELLED' WHERE id = 'O-CACHE'");

OrderEntity fromJpa = repo.findById("O-CACHE").orElseThrow();
String fromSql = jdbc.queryForObject("SELECT status FROM orders WHERE id='O-CACHE'", String.class);
```

```
=== S2-D 🔴 回滾藏起來的第二件事：你查到的可能不是資料庫裡的 ===
  JPA 查到的 status：PENDING_PAYMENT
  SQL 查到的 status：CANCELLED
  🔴 不一樣 —— JPA 給的是【一級快取裡】那個物件（03 章 3.9.2）
  clear() 之後再查：CANCELLED ✅
  ★ 資料層測試的斷言前要 flush + clear，否則你在測「記憶體裡的物件」
```

📌 **這是資料層測試最常見的一個假綠燈**：

```java
// 🔴 這個測試【一定】會綠，即使 save() 根本沒有寫進資料庫
@Test
void 存進去再查回來() {
    repo.save(order);
    Order got = repo.findById(order.id()).orElseThrow();   // ← 從一級快取拿的
    assertThat(got.status()).isEqualTo(PENDING_PAYMENT);
}
```

**`findById` 在同一個交易裡回傳的是【剛才那個物件】** ——
它證明的是「Java 的 map 會存東西」，不是「資料庫會存東西」。

**修法（三選一）**：

```java
// ① flush + clear（最直接）
repo.save(order);
tem.flush();
tem.clear();                         // ★ 兩個都要
Order got = repo.findById(order.id()).orElseThrow();

// ② 用原生 SQL 斷言（最誠實）
repo.saveAndFlush(order);
assertThat(jdbc.queryForObject("SELECT status FROM orders WHERE id=?", String.class, order.id()))
        .isEqualTo("PENDING_PAYMENT");

// ③ 分成兩個交易（最接近真實）—— 本課 00～05 章的契約測試用這個
tx(() -> repo.save(order));
Order got = inTx(() -> repo.findById(order.id())).orElseThrow();
```

📌 **本課的契約測試從 00 章就是用 ③** —— 那個 `tx()` / `inTx()` 的區分不是排版，
**它是「寫入與讀取在不同交易裡」這個保證。**

### 6.3.4 藏起來的第三件：併發與鎖完全測不到

一個測試方法 = 一個交易 = **一個連線**。
所以任何需要「兩個交易同時存在」的東西，`@DataJpaTest` 的預設模式**測不到**：

| 測不到的 | 對應本課哪一節 |
|---|---|
| 樂觀鎖真的在併發下擋住了嗎 | 00 章 0.8、02 章 2.8.3 |
| 悲觀鎖 / `SELECT ... FOR UPDATE` | 07-mysql 站 04 章 |
| 死鎖與鎖等待逾時 | 05-service 02 章 2.11.9 |
| `READ_COMMITTED` vs `REPEATABLE_READ` | 05 章 5.3.5 |

⚠️ **00 章 0.8 那個「20 個人搶 10 個庫存」的實驗，用的是【自己開執行緒 + 自己管交易】**，
**不是 `@DataJpaTest`** —— 因為 `@DataJpaTest` 的模型裡沒有「第二個交易」。

**要測併發，就要 `@Transactional(propagation = NOT_SUPPORTED)` 或乾脆不用測試交易**：

```java
@DataJpaTest
@Transactional(propagation = Propagation.NOT_SUPPORTED)   // ★ 關掉自動回滾
class ConcurrencyTest {
    // 自己開交易、自己清資料（6.8）
}
```

---

## 6.4 ★★ 二十一根探針：H2 與 MySQL 到底差在哪

### 6.4.1 探針的設計

**不斷言，只報告。** 因為要問的是「兩邊一不一樣」，不是「哪一邊對」。

```java
/**
 * ★★ 06 章 6.4：同一組「探針」跑在 H2 與真的 MySQL 上。
 *
 * <p>每一根探針對應 00～05 章的一個「本章沒有驗證到的」項目。
 */
abstract class DialectProbe {

    protected abstract DataSource dataSource();
    protected abstract String label();

    private void probe(int no, String title, ThrowingSupplier body) {
        Lab.line("[%02d] %-38s %s", no, title, tryIt(title, body));
    }

    @Test
    void 語法與行為的探針() { … }        // ①～⑯（6.4.2）

    @Test
    void 批次與交易的探針() { … }        // ⑰～㉑（6.4.4）
}
```

⚠️ **效能那幾根（6.4.3）另外放** —— 它們要先塞 10 萬筆資料，跑起來比較久。

兩個子類別：

```java
class H2DialectProbeTest extends DialectProbe {
    private static final HikariDataSource DS = Lab.newDataSource("probe-h2", ";QUERY_CACHE_SIZE=0");
    @Override protected DataSource dataSource() { return DS; }
    @Override protected String label() { return "H2（本課 00～05 章用的）"; }
}

class MySqlDialectProbeTest extends DialectProbe {
    @BeforeAll static void requireMySql() {
        Assumptions.assumeTrue(MySql.shared() != null, "沒有可用的 MySQL —— 跳過");
    }
    @Override protected DataSource dataSource() { return MySql.shared(); }
    @Override protected String label() { return "MySQL 8（真的）"; }
}
```

### 6.4.2 語法與行為（探針 ①～⑯）

```
=== ★ H2（本課 00～05 章用的） ===        │  === ★ MySQL 8（真的） ===
  資料庫：H2 2.2.224 (2023-09-17)        │    資料庫：MySQL 8.0.46
```

| # | 探針 | **H2 2.2.224** | **MySQL 8.0.46** | 差? |
|---|---|---|---|---|
| ① | `FETCH FIRST n ROWS ONLY` | ✅ 支援 | 🔴 **語法錯誤** | **🔴** |
| ② | `LIMIT n` | ✅ 支援 | ✅ 支援 | |
| ③ | `OFFSET n ROWS FETCH FIRST m ROWS` | ✅ 支援 | 🔴 **語法錯誤** | **🔴** |
| ④ | `IN ()` 空集合 | ⚠️ 沒報錯，回 0 筆 | 🔴 **語法錯誤** | **🔴** |
| ⑤ | 一次送多句 SQL（`;` 分隔） | 🔴 **成功了** | ✅ **被拒絕** | **🔴** |
| ⑥ | `SELECT ?`（參數放欄位位置） | ⚠️ 回傳字面值 `name` | ⚠️ 回傳字面值 `name` | |
| ⑦ | `ORDER BY x ASC` 時 `NULL` 在哪 | **NULLS FIRST** | **NULLS FIRST** | |
| ⑧ | `ORDER BY x ASC NULLS LAST` 語法 | ✅ 支援 | 🔴 **語法錯誤** | **🔴** |
| ⑨ | row value `(a,b) > (?,?)` | ✅ 支援 | ✅ 支援 | |
| ⑩ | 唯一約束違反的訊息 | 含約束名（`UQ_PROBE_NAME_INDEX_4`） | 含約束名（`probe.uq_probe_name`） | ⚠️ **格式完全不同** |
| ⑪ | `CHECK (qty >= 0)` 有沒有生效 | ✅ 擋下（`DataIntegrityViolation`） | ✅ 擋下（`UncategorizedSQL`） | ⚠️ **例外型別不同** |
| ⑫ | 字串超過 `VARCHAR(20)` | ✅ 擋下 | ✅ 擋下 | |
| ⑬ | `WHERE name = 'NAME-1'`（大寫） | ✅ **找不到**（分大小寫） | 🔴 **找得到**（不分大小寫） | **🔴** |
| ⑭a | 批次中間失敗後會不會繼續（**沒開 rewrite**） | 【繼續】`[1,1,-3,1,1]` | 【繼續】`[1,1,-3,1,1]` | |
| ⑭b | 同上，**開了 `rewriteBatchedStatements`** | （沒有這個參數） | 🔴 **全部不進去** `[-3,…]` | **🔴** |
| ⑮ | `executeBatch` 回傳陣列 | `[1,1,1]` 實際列數 | `[1,1,1]` 實際列數 | |
| ⑯ | `TIMESTAMP` 存取往返 | ✅ 一樣 | ✅ 一樣 | ⚠️ 見下方註 |

**七個不同的地方，每一個都會造成一種事故**：

**① ③ `FETCH FIRST` / `OFFSET ... FETCH`** ——
02 章 2.6.4 **為了可攜性**特地從 `LIMIT` 換成它。
🔴 **結果它在 MySQL 上是語法錯誤。** 6.6 會處理這個 bug。

**④ `IN ()` 空集合** ——
02 章 2.6.3 就標了這一項：H2 收，MySQL 是語法錯誤。**現在證實了。**
`JdbcOrderRepository.load()` 那個 `if (heads.isEmpty()) return List.of();`
**不是防禦性程式碼，是必要的。**

**⑤ 多句 SQL** —— 🔴 **這一項 H2 比較危險。**
02 章 2.3.2 那個「一個輸入把整張表刪掉」的實測，在 H2 上成立。
**MySQL 預設拒絕多句 SQL**（要 `allowMultiQueries=true` 才開）。
⚠️ **但這不代表 MySQL 上沒有 SQL Injection** ——
單句的 `OR 1=1`、`UNION SELECT` 一樣有效，**只是「刪掉整張表」這一招失效了**。

**⑧ `NULLS LAST`** —— 04 章 4.3.4 的結論要補一句：
`Sort.nullsLast()` 被 Spring Data 忽略，**而你想自己寫 SQL 補救時，MySQL 也不支援那個語法**。
MySQL 要用 `ORDER BY (x IS NULL), x`。

**⑬ 定序（collation）—— 🔴 這是最容易造成資料事故的一項。**

```
  [13] WHERE name = 'NAME-1'（大寫）    H2: ✅ 找不到 —— 定序【分大小寫】
  [13] WHERE name = 'NAME-1'（大寫）    MySQL: 🔴 找得到 —— 定序【不分大小寫】
```

**MySQL 8 的預設定序是 `utf8mb4_0900_ai_ci`** —— `ci` = case-insensitive。

⚠️ **它的後果比「查詢結果不一樣」嚴重得多**：

| 情境 | H2 上 | MySQL 上 |
|---|---|---|
| `UNIQUE (email)`，已有 `Bob@x.com`，再註冊 `bob@x.com` | ✅ 兩筆都存得進去 | 🔴 **唯一鍵衝突** |
| 登入時 `WHERE username = ?` | 大小寫必須完全相同 | 🔴 **`Admin` 可以用 `admin` 登入** |
| 商品編號 `SKU-a1` 與 `SKU-A1` | 兩個不同的商品 | 🔴 **同一個** |

📌 **「使用者用 `Admin` 註冊，然後用 `admin` 登入成功」這種事，在 H2 上永遠測不出來。**

**⑩ ⑪ 例外訊息與型別不同** ——
02 章 2.12.3 說過「約束的名字沒有你以為的那麼可靠」，現在有了兩邊的實據：

```
H2   ：Unique index or primary key violation: "PUBLIC.UQ_PROBE_NAME_INDEX_4 ON PUBLIC.P…"
MySQL：Duplicate entry 'name-1' for key 'probe.uq_probe_name'
```

**兩邊都含約束名，但格式完全不同**（H2 加了 `_INDEX_4` 後綴，MySQL 加了表名前綴）。
📌 **所以 02 章 2.12.5 選的「在呼叫點翻譯」是對的** ——
2.12.4 那個「解析例外訊息取約束名」的做法**必須為每個資料庫寫一次**。

而 `CHECK` 違反時 **MySQL 給的是 `UncategorizedSQLException`**（Spring 沒有為它的錯誤碼分類），
**H2 給的是 `DataIntegrityViolationException`** ——
⚠️ **一段 `catch (DataIntegrityViolationException e)` 的程式碼，在 MySQL 上抓不到 `CHECK` 違反。**

**⑯ `TIMESTAMP` 的註記** ——
兩邊都對，**但那是因為我在 JDBC URL 上寫了 `serverTimezone=UTC`，而且表用 `DATETIME(6)`**。
🔴 **MySQL 的 `TIMESTAMP` 型別會做時區轉換，`DATETIME` 不會** ——
這一項只驗證了「設定正確時是對的」，**沒有驗證設定錯誤時會怎樣**。

**⑭ 🔴🔴 這一根本來判定「兩邊一樣」，而它只對了一半。**

第一次跑探針 ⑭ 的時候用的是**乾淨的 JDBC URL**（沒有 `rewriteBatchedStatements`），
結果 H2 與 MySQL 都是「跳過壞的那一筆、繼續跑完」，於是它被歸進「兩邊一樣」。

**而 05 章 5.8.9 建議的那個參數會改變這個答案。同一組資料、同一句 SQL，只多一個 URL 參數**：

```
=== ★ MySQL 8.0.46：批次中間有一筆違反 CHECK（5 筆，第 3 筆是 -3）===
  rewriteBatchedStatements=false
      BatchUpdateException.getUpdateCounts() = [1, 1, -3, 1, 1]
      表裡剩下 4 筆   ← 跳過壞的那一筆，繼續跑完

  rewriteBatchedStatements=true
      BatchUpdateException.getUpdateCounts() = [-3, -3, -3, -3, -3]
      表裡剩下 0 筆   🔴 一筆都沒進去
```

**原因**：`rewriteBatchedStatements=true` 會把 5 句 `INSERT` **改寫成一句多值 `INSERT`**
（5.8.9 那張圖）。**一句 SQL 沒有「跑到一半」這回事** ——
它要嘛整句成功、要嘛整句失敗，於是行為從「部分寫入」變成「全有全無」。

⚠️⚠️ **這件事同時影響兩個地方**：

| 影響 | 說明 |
|---|---|
| **探針 ⑭ 要拆成 ⑭a / ⑭b** | 「兩邊一樣」只在沒開 rewrite 時成立 |
| 🔴 **05 章 5.10「批次不等於交易」整節的論證** | 那一節的核心是「失敗時會部分寫入，所以批次不等於交易」——<br>**而在 MySQL + rewrite 下，結論剛好相反**（見 5.10.1 的補述） |

📌 **而它和 ⑰（`executeBatch` 回 `-2`）是【同一個根因】**：
**`rewriteBatchedStatements=true` 改變的不只是「送幾次」，是 `executeBatch()` 的語意本身。**

> ⚠️ **這一根探針還教了一件關於「探針怎麼寫」的事**：
> **探針的連線設定，本身就是一個變因。**
> 我用一組乾淨的 URL 跑探針，於是量到的是「一個沒有人會用的設定下的行為」——
> **而正式環境的 URL 上有 12 個參數。**
>
> 📌 **修正做法**：**探針要在「和正式環境相同的 URL」上跑一次**，
> 差異夠大的參數（`rewriteBatchedStatements`、`useServerPrepStmts`、`sessionVariables`）
> **各跑一次開與關**。

### 6.4.3 效能（深分頁與 keyset）

```
                                    H2 2.2.224      MySQL 8.0.46
  OFFSET 0        FETCH 20             131 µs           284 µs
  OFFSET 20000    FETCH 20           1,239 µs         1,808 µs
  OFFSET 99980    FETCH 20           1,806 µs         7,647 µs      ← 深分頁
  keyset ① OR 寫法                   4,802 µs 🔴        513 µs ✅
  keyset ② row value                   113 µs ✅     13,235 µs 🔴
  SELECT count(*) FROM probe            46 µs         6,887 µs      ← 差 150 倍
  SELECT count(*) WHERE qty > 50000  4,489 µs         8,396 µs
```

**四個結論**：

**① 深分頁在 MySQL 上更嚴重**：
第 0 頁 → 第 4,999 頁，H2 慢 **14 倍**，MySQL 慢 **27 倍**。
📌 04 章 4.7.1 說「H2 的數字低估了真實情況」—— **證實了，而且低估了大約一倍。**

**② ★★ keyset 的兩種寫法【快慢對調】**：

```
★ 兩種 keyset 寫法的執行計畫：
  H2   ① OR：PUBLIC.IDX_PROBE_CREATED_ID   ② row value：PUBLIC.IDX_PROBE_CREATED_ID
  MySQL ① OR：key=idx_probe_created_id, rows=2,  type=range   ← ✅ 索引範圍掃描
        ② row value：key=idx_probe_created_id, rows=20, type=index   ← 🔴 全索引掃描
```

**MySQL 的 `EXPLAIN` 把原因說得清清楚楚**：

- `type=range` = 找到起點、往後讀 —— 這是我們要的。
- `type=index` = **從索引頭讀到尾**，逐列套條件。

🔴 **MySQL 8 不會把 `(A,B) > (x,y)` 轉成索引範圍存取，H2 會；**
🔴 **MySQL 8 很擅長把 `A > x OR (A = x AND B > y)` 轉成 range，H2 不會。**

⚠️ **04 章根據 H2 的量測寫下「不要用 ①」——【那是錯的】。**
（04 章已經補上 4.7.4b 修正這一段。）

📌 **唯一在兩邊都安全的寫法是 04 章的 ③（補一個多餘的下界）**：

```sql
WHERE created_at >= :ts AND (created_at > :ts OR (created_at = :ts AND id > :id))
```

**③ `count(*)` 差 150 倍**：
H2 讀統計值（46 µs），**MySQL 的 InnoDB 沒有精確的列數統計，一定要掃**（6,887 µs）。
📌 **04 章 4.2.3 那句「`Page<T>` 的真正代價」在 MySQL 上要再乘一個數量級。**

**④ 而 H2 的絕對數字整體偏快** —— 它在同一個 JVM 裡，沒有網路、沒有 buffer pool。
**所以 H2 只能拿來比「同一個資料庫上兩種寫法的相對差距」，
而 ② 證明了【連那個都不可靠】。**

### 6.4.4 批次與交易（探針 ⑰～㉑）

```
                                        H2                        MySQL 8
[17] rewriteBatchedStatements=true   （沒有這個參數）     🔴 [-2,-2,-2,-2,-2]
[18] SET TRANSACTION READ ONLY       🔴 語法錯誤          ✅ 支援，而且【真的擋住 UPDATE】
[19] fetchSize 串流                   fetchSize=500       fetchSize=-2147483648（MySQL 的魔術值）
[20] covering index                  兩種查詢都同一個索引   ✅ 只查 id：type=range
                                                          🔴 查 name：key=null, type=ALL
[21] NOT NULL 違反的訊息               NULL not allowed     Column 'name' cannot be null
                                     for column "NAME"
```

**⑰ 🔴 這一根證實了 05 章 5.8.7 的程式碼會壞掉。**

```
[17] rewriteBatchedStatements=true   [-2, -2, -2, -2, -2] 🔴 變成 SUCCESS_NO_INFO(-2)
                                     —— 05 章 5.8.7 的判斷會壞掉
```

05 章 5.8.7 的 `saveAll()` 用 `updated[i] == 1` 判斷「這張訂單是新的還是舊的」。
**開了 `rewriteBatchedStatements=true`（而 5.8.9 正是叫你開它）之後，
`updated[i]` 全部是 `-2`，永遠不等於 1 → 每一張訂單都被判定成新單。**

⚠️ **兩節相隔不到兩頁，一節的效能建議讓另一節的正確性設計失效。**
（05 章已經補上 5.8.7b，包含修法與一行「壞掉就大聲失敗」的斷言。）

**⑱ `SET TRANSACTION READ ONLY`** ——
05 章 5.3.4 在 H2 上連跑都跑不起來，所以那一節的說明**是根據文件寫的**。
✅ **現在證實了：MySQL 支援它，而且真的擋住 `UPDATE`。**
📌 **所以 `setEnforceReadOnly(true)` 在 MySQL 上是一個有效的防線** ——
它擋得住 05 章 5.3.3 那個「唯讀交易裡明確 `save()` 照樣寫進去」的情況。

**⑳ covering index —— 這一項只有 MySQL 看得到**：

```
只查 id  ：key=idx_probe_cover, rows=15, type=range   ← 只讀索引
查 name  ：key=null,            rows=25, type=ALL     ← 🔴 全表掃描
```

**同樣的 `WHERE` 與 `ORDER BY`，只因為 `SELECT` 的欄位不同，
一個走索引、一個全表掃描。**

📌 **這就是 04 章練習 3「層次一：兩階段查詢」的真正理由** ——
第一句只查 `id`（covering），第二句用主鍵取完整資料。
**而這件事在 H2 上完全量不出來**（H2 兩種查詢都顯示同一個索引）。

### 6.4.5 二十一根探針的總帳

| 分類 | 兩邊一樣 | **兩邊不同** |
|---|---|---|
| 語法 | ②⑥⑨ | **①③④⑤⑧** |
| 行為 | ⑦⑫⑭a⑮⑯ | **⑩⑪⑬⑭b** |
| 效能 | —— | **深分頁倍率、keyset 寫法、`count(*)`、covering index** |
| 設定 | —— | **⑰⑱⑲** |

🔴 **21 根探針（⑭ 拆成兩根之後 22 根），13 根不一樣。**

📌 **而其中四根直接推翻了本課前面章節的結論**：

| 推翻了什麼 | 哪一章 | 修正在哪 |
|---|---|---|
| 「`FETCH FIRST` 比 `LIMIT` 可攜」 | 02 章 2.6.4 | **6.6** |
| 「keyset 用 row value 寫法」 | 04 章 4.7.4 | **04 章 4.7.4b** |
| 「`saveAll()` 用 `updated[i]` 判斷新舊」 | 05 章 5.8.7 | **05 章 5.8.7b** |
| **「批次失敗會部分寫入」** | **05 章 5.10.1** | **05 章 5.10.1b**（開了 `rewriteBatchedStatements` 之後是全有全無） |

---

## 6.5 怎麼在測試裡跑一個真的資料庫

### 6.5.1 Testcontainers 的標準寫法

```xml
<dependency>
  <groupId>org.testcontainers</groupId>
  <artifactId>mysql</artifactId>
  <version>1.21.3</version>
  <scope>test</scope>
</dependency>
<dependency>
  <groupId>org.testcontainers</groupId>
  <artifactId>junit-jupiter</artifactId>
  <version>1.21.3</version>
  <scope>test</scope>
</dependency>
<dependency>
  <groupId>com.mysql</groupId>
  <artifactId>mysql-connector-j</artifactId>
  <scope>test</scope>
</dependency>
```

```java
@Testcontainers
@DataJpaTest
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)  // ★ 不要換成 H2
class OrderRepositoryMySqlTest {

    @Container
    @ServiceConnection                       // ★ Boot 3.1+：自動設定 datasource 的 url/user/password
    static MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0");

    @Autowired OrderPageRepository repo;
}
```

⚠️ **兩個註解不能少**：

| 註解 | 不加會怎樣 |
|---|---|
| `@AutoConfigureTestDatabase(replace = NONE)` | 🔴 **`@DataJpaTest` 會把你的 `DataSource` 換成內嵌的 H2** —— 容器白起了 |
| `@ServiceConnection`（或 `@DynamicPropertySource`） | 🔴 Spring 不知道容器的連線資訊 |

📌 **第一項是最常見的錯誤**：容器起來了、測試綠了，**而它連的是 H2**。
**驗證方法很簡單** —— 在測試裡印一次資料庫名稱：

```java
@Test
void 確認連的是誰() throws Exception {
    try (Connection c = dataSource.getConnection()) {
        assertThat(c.getMetaData().getDatabaseProductName()).isEqualTo("MySQL");
    }
}
```

⚠️ **這一條斷言值得放進每一個「真資料庫測試」的基底類別。**

### 6.5.2 ⚠️ Docker socket 的路徑（macOS 常見）

Docker Desktop for Mac 的 socket **不在** `/var/run/docker.sock`：

```
/Users/xxx/.docker/run/docker.sock
```

三種解法：

```bash
# ① 環境變數
export DOCKER_HOST=unix://$HOME/.docker/run/docker.sock

# ② ~/.testcontainers.properties
docker.host=unix:///Users/xxx/.docker/run/docker.sock

# ③ Docker Desktop 設定裡打開「Allow the default Docker socket to be used」
```

⚠️ 本課的機器上 `/var/run/docker.sock` **是一個指向 `~/.docker/run/docker.sock` 的符號連結**，
所以這一關過了 —— 但下一關沒過。

### 6.5.3 🔴 本課實測踩到的雷：Testcontainers 連不上 Docker Engine 29

```
DEBUG o.t.d.DockerClientProviderStrategy -- Trying out strategy: UnixSocketClientProviderStrategy
DEBUG o.t.d.DockerClientProviderStrategy -- UnixSocketClientProviderStrategy: failed with
      exception BadRequestException (Status 400: {"ID":"","Containers":0, … })
DEBUG o.t.d.DockerClientProviderStrategy -- Trying out strategy: DockerDesktopClientProviderStrategy
DEBUG o.t.d.DockerClientProviderStrategy -- DockerDesktopClientProviderStrategy: failed with
      exception BadRequestException (Status 400: …)
ERROR o.t.d.DockerClientProviderStrategy -- Could not find a valid Docker environment.
```

**注意那個 `Status 400` 不是「連不上」，是「連上了、被拒絕了」** ——
回應裡有完整的 JSON body。

**病因**：

```
$ docker version --format '{{json .}}'
Server API: 1.52   MinAPI: 1.44
```

**Docker Engine 29 的 `MinAPIVersion` 是 1.44**，
而 Testcontainers 內建的 docker-java 送出的 API 版本比它更舊 → **400**。

⚠️ **試過 `DOCKER_API_VERSION=1.44`、`api.version=1.44`、升級到 Testcontainers 1.21.3 —— 都沒有解決。**

📌 **所以本章的 MySQL 是【手動起的】**：

```bash
docker run -d --name lab-mysql \
  -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=shop \
  -e MYSQL_USER=shop -e MYSQL_PASSWORD=shop \
  -p 33306:3306 mysql:8.0 \
  --character-set-server=utf8mb4 --collation-server=utf8mb4_0900_ai_ci
```

```java
/**
 * ★ 06 章 6.5：一個真的 MySQL 8。
 *
 * <p>⚠️ 本課本來要用 Testcontainers，實測時撞到一個相容性問題（6.5.3）。
 * 所以這裡改成「連上一個外部啟動的 MySQL」。
 */
public final class MySql {

    public static final String URL = System.getProperty("lab.mysql.url",
            "jdbc:mysql://127.0.0.1:33306/shop");

    /** 連不上就回 null —— 讓測試可以優雅地跳過（6.5.4）。 */
    public static synchronized HikariDataSource dataSourceOrNull(String extraUrl) { … }
}
```

⚠️ **這個經驗本身值得記下來**：

> **Testcontainers 讓「跑一個真資料庫」變得很容易，
> 但它在你和 Docker 之間多了一層，而那一層會壞。**

**它換到的東西仍然值得**（版本鎖定、自動清理、CI 上不用預先準備環境），
**但要知道退路是什麼**：**一個 `docker-compose.yml` + 一個「連不上就跳過」的判斷**，
在絕大部分情況下就夠了。

### 6.5.4 「連不上就跳過」怎麼寫

```java
class MySqlDialectProbeTest extends DialectProbe {

    @BeforeAll
    static void requireMySql() {
        Assumptions.assumeTrue(MySql.shared() != null, "沒有可用的 MySQL —— 跳過（6.5.4）");
    }
}
```

`Assumptions.assumeTrue` 讓測試變成 **skipped** 而不是 **failed**。

⚠️ **這是一個【危險的方便】**：

| 好處 | 風險 |
|---|---|
| 開發者本機沒起 MySQL 也能跑其他測試 | 🔴 **CI 上如果 MySQL 沒起來，測試會全部 skip 而 build 是綠的** |

📌 **修法：CI 上要把「跳過」變成「失敗」。**

```java
@BeforeAll
static void requireMySql() {
    boolean required = Boolean.parseBoolean(System.getenv().getOrDefault("REQUIRE_DB", "false"));
    if (required) {
        assertThat(MySql.shared()).as("CI 上一定要有 MySQL").isNotNull();
    } else {
        Assumptions.assumeTrue(MySql.shared() != null, "本機沒有 MySQL —— 跳過");
    }
}
```

**CI 的設定裡 `REQUIRE_DB=true`。** 本機不設。

⚠️ **另一個更簡單的做法**：用 Maven profile 把真資料庫的測試分到一個獨立的執行階段
（`failsafe` 的 `*IT.java`），CI 上明確跑 `mvn verify`，本機預設只跑 `mvn test`。

---

## 6.6 ★ 同一組契約在兩個資料庫上跑

### 6.6.1 兩條紅的

02～05 章累積了 **17 條契約**，跑在四個實作上（記憶體 fake / `JdbcTemplate` / `JdbcClient` / JPA），
**68 個測試在 H2 上全綠**。

**加一個第五個「實作」—— 同一個 `JdbcOrderRepository`，換一個資料庫**：

```java
/**
 * ★★ 06 章 6.6：把 02～05 章那 17 條契約，跑在【真的 MySQL 8】上。
 *
 * <p>這是本課第一次在正式環境用的資料庫上執行契約測試。
 */
class MySqlJdbcOrderRepositoryContractTest extends OrderRepositoryContract {

    @BeforeEach
    void setUp() {
        ds = MySql.shared();
        Assumptions.assumeTrue(ds != null, "沒有可用的 MySQL —— 跳過");
        Lab.createSchemaMySql(ds);
        tx = new TransactionTemplate(new DataSourceTransactionManager(ds));
        repo = new JdbcOrderRepository(new NamedParameterJdbcTemplate(ds));
    }
}
```

```
[ERROR] Tests run: 17, Failures: 0, Errors: 2 -- in lab.MySqlJdbcOrderRepositoryContractTest

[ERROR] MySqlJdbcOrderRepositoryContractTest>OrderRepositoryContract
        .逾期未付款的訂單依照建立時間排序且受limit限制 » BadSqlGrammar
[ERROR] MySqlJdbcOrderRepositoryContractTest>OrderRepositoryContract
        .已付款的訂單不算逾期未付款 » BadSqlGrammar

PreparedStatementCallback; bad SQL grammar [SELECT id, customer_id, status, total_minor,
                                            currency, created_at, version
  FROM orders
 WHERE status = 'PENDING_PAYMENT' AND created_at < ?
 ORDER BY created_at, id
 FETCH FIRST ? ROWS ONLY
]
```

🔴 **兩條紅，病因是同一句 `FETCH FIRST ? ROWS ONLY`。**

### 6.6.2 ⚠️ 而那一句是 02 章「為了可攜性」特地寫的

02 章 2.6.4 的原文是這樣的：

> `LIMIT` 是方言，換成標準的 `FETCH FIRST`

```java
// 02 章寫的
@Override
public List<Order> findExpiredPendingPayment(Instant now, int limit) {
    // ★ 2.6：FETCH FIRST 是標準 SQL，LIMIT 是方言
    return load(SELECT_HEAD + """
             WHERE status = 'PENDING_PAYMENT' AND created_at < :deadline
             ORDER BY created_at, id
             FETCH FIRST :limit ROWS ONLY
            """, …);
}
```

**這個推理每一步都對**：
`FETCH FIRST` 確實是 SQL:2008 標準，`LIMIT` 確實是方言。
**而結論是錯的，因為專案要跑的那個資料庫【不支援標準】。**

📌 **這是本章最想讓你記住的一件事**：

> **「標準的」不等於「可攜的」。**
> **可攜性是一個【實測】的問題，不是一個【查文件】的問題。**

⚠️ **而 00 章的 README 甚至已經預告過它**：

> `LIMIT` 是方言，換成標準的 `FETCH FIRST`（⚠️ **而 MySQL 8 不支援它** —— 04 章的 `Pageable` 才是終解）

**那句「而 MySQL 8 不支援它」寫對了，卻沒有阻止那段程式碼被寫下來、
也沒有讓任何一條測試變紅。** 因為測試跑在 H2 上。

### 6.6.3 修法：把方言差異變成一個明確的決定

**錯的修法是「換回 `LIMIT`」** —— 那 Oracle 11g 又不支援。

```java
/** 標準 SQL：H2、PostgreSQL、Oracle 12c+、SQL Server 2012+ 支援。 */
public static final String FETCH_FIRST = "FETCH FIRST :limit ROWS ONLY";

/** ★ MySQL / MariaDB / SQLite 只有這一種。 */
public static final String LIMIT = "LIMIT :limit";

private final String limitClause;

public JdbcOrderRepository(NamedParameterJdbcTemplate jdbc) { this(jdbc, FETCH_FIRST); }

/**
 * ⚠️ 06 章 6.6：把方言差異放進建構子，而不是藏在一句 SQL 裡。
 *
 * <p>這樣「我們支援哪些資料庫」變成一個【組態問題】，
 * 而且測試可以用兩種樣板各跑一次契約。
 */
public JdbcOrderRepository(NamedParameterJdbcTemplate jdbc, String limitClause) {
    this.jdbc = jdbc;
    this.limitClause = limitClause;
}
```

```java
// MySQL 的契約測試
repo = new JdbcOrderRepository(new NamedParameterJdbcTemplate(ds),
        JdbcOrderRepository.LIMIT);   // ★ MySQL 不支援 FETCH FIRST（6.6.2）
```

```
[INFO] Tests run: 17, Failures: 0, Errors: 0 -- in lab.MySqlJdbcOrderRepositoryContractTest
[INFO] Tests run: 17, Failures: 0, Errors: 0 -- in lab.JdbcOrderRepositoryContractTest
[INFO] Tests run: 34, Failures: 0, Errors: 0, Skipped: 0
```

**同一組 17 條契約，兩個資料庫都綠。**

📌 **這個修法的價值不在那兩個常數，在它讓一件事變得【看得見】**：

> **「這個 Repository 支援哪些資料庫」現在是一個【建構子參數】，
> 而不是一個藏在字串裡、只有換資料庫才會發現的假設。**

⚠️ **更好的做法**（本課沒有做，因為 04 章已經給了終解）：
**分頁根本不該由 Repository 自己拼 SQL** ——
04 章的 `PageSpec` + Spring Data 的 `Pageable` 讓 **Hibernate 的方言負責這件事**。
📌 **`findExpiredPendingPayment(now, limit)` 這個方法本來就該收 `PageSpec`。**

### 6.6.4 那 schema 呢

契約要在 MySQL 上跑，**需要一份 MySQL 版的 DDL**：

```java
/** ★ 06 章 6.6：同一份 schema，MySQL 版（TIMESTAMP → DATETIME(6)，沒有 FETCH FIRST）。 */
public static void createSchemaMySql(DataSource ds) {
    jdbc.execute("""
            CREATE TABLE orders (
                id           VARCHAR(26)  NOT NULL,
                …
                created_at   DATETIME(6)  NOT NULL,      -- ★ 不是 TIMESTAMP
                …
            )""");
}
```

⚠️ **`TIMESTAMP` → `DATETIME(6)` 這一行改動很重要**：

| MySQL 型別 | 範圍 | 時區 |
|---|---|---|
| `TIMESTAMP` | **1970 ～ 2038** 🔴 | 🔴 **存的時候轉成 UTC，讀的時候轉回 session 時區** |
| `DATETIME(6)` | 1000 ～ 9999 | ✅ **不做任何轉換** |

📌 **`TIMESTAMP` 的兩個問題都很嚴重**：
2038 年問題是真的（一個 2039 年到期的合約存不進去），
而時區轉換代表**同一筆資料，兩個 session 讀到的時間可能不一樣**。

**存 `Instant` 就用 `DATETIME(6)` + 應用程式一律用 UTC。**
（07-mysql 站 02 章會完整處理時間型別。）

⚠️ 🔴 **本章沒有實測 `TIMESTAMP` 的時區轉換行為** —— 探針 ⑯ 用的是 `DATETIME(6)`。
列在 6.13。

### 6.6.5 那要跑幾遍

**不是所有測試都要在真資料庫上跑一遍。** 分成三層：

| 層 | 跑在哪 | 佔比 | 測什麼 |
|---|---|---|---|
| **① 純單元測試** | 不用資料庫 | **~70%** | 領域邏輯、不變量、轉換、白名單、游標編解碼 |
| **② 資料層測試（H2）** | H2 | **~25%** | 映射對不對、查詢邏輯對不對、SQL 句數、N+1 |
| **③ 契約 / 方言測試** | **真資料庫** | **~5%** | 語法可攜性、約束、定序、批次、鎖、效能特性 |

📌 **③ 的選擇標準是「6.4 那 12 根不一樣的探針會不會影響它」**：

| 測試 | 需要真資料庫嗎 |
|---|---|
| `OrderRow` 的欄位映射 | ❌ H2 就夠 |
| 動態 `WHERE` 組出來對不對 | ❌ H2 就夠 |
| **每一句手寫 SQL 都能執行** | ✅ **要**（探針 ①③④⑧） |
| **唯一約束、`CHECK`、外鍵真的擋得住** | ✅ **要**（6.3.2 的 `ddl-auto` 問題 + 探針 ⑩⑪） |
| **大小寫敏感的查詢與唯一鍵** | ✅ **要**（探針 ⑬） |
| **批次真的有生效** | ✅ **要**（探針 ⑰） |
| **深分頁 / keyset 的執行計畫** | ✅ **要**（6.4.3） |
| 樂觀鎖、悲觀鎖、死鎖 | ✅ **要**（H2 的鎖模型不同） |

⚠️ **「17 條契約 × 真資料庫」跑起來只要 0.76 秒**（本章實測），
**而它抓到了一個活了四章的 bug。** 這個投報率非常高。

---

## 6.7 測試資料怎麼準備

### 6.7.1 `ddl-auto` 是一個陷阱（6.3.2 的延伸）

**再說一次，因為它值得**：

```
    CHECK        CONSTRAINT_8B    "STATUS" IN('PENDING_PAYMENT', 'PAID', …)
    PRIMARY KEY  CONSTRAINT_8B7   
```

**`ddl-auto` 產生的表只有：主鍵、`NOT NULL`、`@Enumerated` 的列舉檢查、
以及你在 `@Table(indexes = …)` / `@Column(unique = true)` 明寫的東西。**

| 用 `ddl-auto` | 用真的 schema |
|---|---|
| ✅ 快、零設定 | ⚠️ 要維護一份 DDL（或 migration） |
| 🔴 **測的是另一張表** | ✅ 測的是正式環境那張表 |
| 🔴 **schema 的 bug 測不到** | ✅ migration 寫錯會在測試裡紅 |
| 🔴 **索引不存在 → 效能測試無意義** | ✅ —— |

📌 **建議**：

```yaml
# 資料層測試
spring:
  jpa:
    hibernate:
      ddl-auto: none                 # ★ 一律關掉
  flyway:
    enabled: true                    # ★ 跑和正式環境同一串 migration
```

⚠️ **這會逼你面對一件事：MySQL 的 migration 在 H2 上跑不動**
（`ENGINE=InnoDB`、`AUTO_INCREMENT`、`utf8mb4` 定序…）。

**而那正是「你的 H2 測試到底在測什麼」這個問題的答案** ——
如果 migration 在 H2 上跑不動，那 H2 上的表**本來就不是**正式環境那張表。

**兩條路**：

| 路 | 做法 |
|---|---|
| **A（推薦）** | 資料層測試**全部**跑真資料庫（Testcontainers / docker-compose），H2 只用在「不碰 schema 細節」的測試 |
| **B** | 維護兩份 DDL（H2 版 + MySQL 版），並用契約測試保證兩邊行為一致 |

⚠️ **B 就是本課 00～06 章實際在做的事**（`createSchema` 與 `createSchemaMySql`），
**而 6.6.1 證明了它會漏** —— 兩份 DDL 一致不代表兩邊的 SQL 都能跑。

📌 **所以真實專案應該選 A。**
本課選 B 只是因為前五章寫的時候本機沒有 Docker。

### 6.7.2 三種準備資料的方式

| 方式 | 寫法 | 適合 |
|---|---|---|
| **`@Sql`** | `@Sql("/fixtures/orders.sql")` | 大量、固定的基準資料 |
| **`TestEntityManager`** | `tem.persistAndFlush(entity)` | 少量、要拿到 id 的 |
| **Builder / Object Mother** | `anOrder().withStatus(PAID).build()` | ✅ **大部分情況** |

**Builder 為什麼最好** ——因為測試要表達的是**「和預設不同的那一點」**：

```java
// 🔴 這個測試裡有 8 個值，而只有 1 個和這條測試有關
OrderEntity e = new OrderEntity("O-1", "C-1", OrderStatus.PAID, 38000, "TWD", T0);

// ✅ 一眼看得出「這條測試在乎的是 PAID」
OrderEntity e = anOrder().withStatus(PAID).build();
```

📌 **本課 00～05 章的契約測試就是這個形狀**：

```java
static Order anOrder(String id, String customerId, Instant createdAt) {
    return Order.place(id, customerId,
            List.of(new OrderLine("P-1", 1, Money.twd(100)),
                    new OrderLine("P-2", 2, Money.twd(140))),
            Money.twd(380), createdAt);
}
```

⚠️ **一個 `anOrder()` 讓 17 條契約都不用重複那 5 行**，
而且**改了明細結構只要改一個地方**。

### 6.7.3 `@Sql` 的三個細節

```java
@Sql(scripts = "/fixtures/orders.sql",
     executionPhase = Sql.ExecutionPhase.BEFORE_TEST_METHOD)     // 預設
@Sql(scripts = "/fixtures/cleanup.sql",
     executionPhase = Sql.ExecutionPhase.AFTER_TEST_METHOD)
```

| 細節 | 說明 |
|---|---|
| **它在測試的交易【裡面】跑** | 所以會跟著回滾 ✅；除非 `@SqlConfig(transactionMode = ISOLATED)` |
| **它不經過 JPA** | 所以持久化情境不知道那些資料 → **要 `tem.clear()`** |
| ⚠️ **它是「一個字串路徑」** | 檔案改名 / 打錯字**只有執行時才發現**；而且沒有型別檢查 |

---

## 6.8 測試之間怎麼清乾淨

| 策略 | 做法 | 速度 | 問題 |
|---|---|---|---|
| **① 回滾（預設）** | `@Transactional` + 測完 rollback | ✅ **最快** | 🔴 6.3 那三件事；🔴 測不了併發 |
| **② `TRUNCATE`** | `@Sql` 或 `@BeforeEach` 清表 | 中 | ⚠️ 外鍵順序要對；MySQL 上 `TRUNCATE` 會隱含提交 |
| **③ 重建 schema** | 每個測試類別 drop + create | 🔴 慢 | ✅ 最乾淨 |
| **④ 每個測試一個 database** | Testcontainers 每類別一個容器 | 🔴 **最慢** | ✅ 完全隔離 |

📌 **實務上的組合**：

```
② 為主（快、真實、能測併發）
   + ① 給「純查詢」的測試（它們不寫東西，回滾最省）
   + ③ 只給「會改 schema」的測試（migration 測試）
```

**`TRUNCATE` 的正確寫法**（外鍵順序）：

```sql
-- MySQL：先關外鍵檢查，就不用管順序
SET FOREIGN_KEY_CHECKS = 0;
TRUNCATE TABLE order_line;
TRUNCATE TABLE orders;
SET FOREIGN_KEY_CHECKS = 1;
```

⚠️ **`TRUNCATE` 在 MySQL 上是 DDL，會【隱含提交】** ——
所以它不能放在測試的交易裡，要在 `@BeforeEach` 用獨立的連線跑。

⚠️ **本章的 MySQL 契約測試用的是第 ③ 種**（每次 `DROP` + `CREATE`）：

```java
@BeforeEach
void setUp() {
    Lab.createSchemaMySql(ds);      // 內含 DROP TABLE IF EXISTS
}
```

**17 條測試 0.76 秒** —— 在這個規模下 ③ 完全夠用。
**表變多、資料變大之後才需要換成 ②。**

---

## 6.9 ★ CI 從 4 分鐘變 47 分鐘：context 快取

### 6.9.1 五個「看起來一樣」的測試類別

```java
@DataJpaTest @ContextConfiguration(classes = ShopApplication.class)
static class A_純DataJpaTest { … }

@DataJpaTest @ContextConfiguration(classes = ShopApplication.class)
static class B_同樣的設定 { … }

@DataJpaTest @ContextConfiguration(classes = ShopApplication.class)
@TestPropertySource(properties = "spring.jpa.properties.hibernate.jdbc.batch_size=50")
static class C_多一個property { … }

@DataJpaTest @ContextConfiguration(classes = ShopApplication.class)
static class D_多一個MockBean {
    @MockBean OrderSearchPort port;
}

@DataJpaTest @ContextConfiguration(classes = ShopApplication.class)
static class E_又一個一樣的 { … }
```

**實驗 S3**：

```
=== S3 Spring context 快取：五個「看起來一樣」的測試類別 ===
  @DataJpaTest                                   → context #1 🔴 【新建】
  @DataJpaTest（又一個設定一樣的）                  → context #1 ✅ 重用
  @DataJpaTest + @TestPropertySource（多一行）     → context #2 🔴 【新建】
  @DataJpaTest（設定完全一樣）                     → context #1 ✅ 重用
  @DataJpaTest + @MockBean（多一個）               → context #3 🔴 【新建】
  
  ★ 一共建立了 3 個 context
    快取的鍵是【整組設定】：classes + properties + @MockBean + profiles + …
    多一行 @TestPropertySource、多一個 @MockBean，就是一個【全新的】context
  ⚠️ 每一個 context 都要重新建 EntityManagerFactory、掃描 entity、建連線池
```

### 6.9.2 快取的鍵是什麼

Spring 用 `MergedContextConfiguration` 當快取的鍵，它包含：

| 組成 | 例子 |
|---|---|
| `classes` / `locations` | `@ContextConfiguration(classes = …)` |
| `contextInitializerClasses` | —— |
| `activeProfiles` | `@ActiveProfiles("test")` |
| **`propertySourceProperties`** | **`@TestPropertySource(properties = …)`** ← 多一行就換一個 |
| **`contextCustomizers`** | **`@MockBean` / `@SpyBean` 的集合** ← 多一個就換一個 |
| `parent` | —— |

📌 **兩個最容易踩的**：

**① `@TestPropertySource`** —— 每一組不同的 properties 就是一個新 context。

```java
// 🔴 三個測試類別，三個 context
@TestPropertySource(properties = "spring.jpa.properties.hibernate.jdbc.batch_size=50")
@TestPropertySource(properties = "spring.jpa.properties.hibernate.jdbc.batch_size=100")
@TestPropertySource(properties = "spring.jpa.show-sql=true")
```

**② `@MockBean`** —— **mock 的集合不同 = 不同的 context**。

```java
// 🔴 這兩個是不同的 context
class A { @MockBean PaymentPort payment; }
class B { @MockBean PaymentPort payment; @MockBean NotificationPort notify; }
```

⚠️ **`@MockBean` 還有第二個代價**：它會**污染快取的 context** ——
Spring 為了還原 mock 的狀態，會在每個測試方法後 `reset()` 它們，
而且被 mock 取代的 bean 讓那個 context **不能**被沒有 mock 的測試重用。

### 6.9.3 47 分鐘是怎麼來的

```
一個 @DataJpaTest 的 context 啟動 ≈ 1.5 秒（本課實測，99 個 bean）
一個 @SpringBootTest 的 context 啟動 ≈ 5～15 秒（幾百個 bean）

30 個測試類別，每個都因為多一行設定而有自己的 context：
    30 × 5 秒 = 150 秒  ← 只是啟動，還沒開始跑測試

如果其中 10 個是 @SpringBootTest + 各自不同的 @MockBean：
    10 × 15 秒 = 150 秒 額外
```

📌 **而「刪測試」沒有用** ——
成本在**context 的數量**，不在**測試的數量**。
**刪掉 100 個測試方法，如果 context 數不變，時間幾乎不變。**

### 6.9.4 五條規則

| # | 規則 | 為什麼 |
|---|---|---|
| 1 | **測試的設定要「收斂到少數幾組」** | 快取的鍵是整組設定 |
| 2 | 需要特殊 property 時，**做一個共用的基底類別** | 讓 N 個測試共用一個 context |
| 3 | **`@MockBean` 能不用就不用** —— 用 `@Import` 一個測試用的實作 | 避免 customizer 產生新 context |
| 4 | **能不用 Spring 就不用** | 最快的 context 是沒有 context |
| 5 | **量它** | 見下方 |

**規則 2 的寫法**：

```java
@DataJpaTest
@ContextConfiguration(classes = ShopApplication.class)
@TestPropertySource(properties = {
        "spring.jpa.hibernate.ddl-auto=none",
        "spring.jpa.properties.hibernate.jdbc.batch_size=50"
})
public abstract class RepositoryTestBase { }        // ★ 所有資料層測試都繼承它
```

**規則 5：怎麼量**

```properties
# 打開 context 快取的統計
logging.level.org.springframework.test.context.cache=DEBUG
```

```
DEBUG o.s.t.c.cache.DefaultCacheAwareContextLoaderDelegate --
      Spring test ApplicationContext cache statistics:
      [DefaultContextCache@... size = 7, maxSize = 32, parentContextCount = 0,
       hitCount = 41, missCount = 7]
```

📌 **`missCount` 就是「建了幾個 context」。**
**把它放進 CI 的輸出裡，超過某個數字就當成一個 code review 的討論點。**

⚠️ **`maxSize` 預設是 32** —— 超過就會開始**踢掉**舊的 context（LRU），
**於是同一個 context 會被建立好幾次**。
大型專案要調 `spring.test.context.cache.maxSize`。

---

## 6.10 這一站的總帳：20 多項「沒有驗證到的」現在怎麼樣了

00～05 章每一章最後都有一張「本章沒有驗證到的」表。**逐項結算**：

### 6.10.1 ✅ 這一章補上的（12 項）

| 項目 | 出處 | 結果 |
|---|---|---|
| MySQL 支不支援 `FETCH FIRST` | 02 章 2.6.4 | 🔴 **不支援 —— 而且害兩條契約紅了**（6.6） |
| `IN ()` 空集合在 MySQL 上 | 02 章 2.6.3 | 🔴 **語法錯誤**（探針 ④）—— 那個 `isEmpty()` 判斷是必要的 |
| 多句 SQL 攻擊在 MySQL 上 | 02 章 2.3.2 | ✅ **被驅動拒絕**（探針 ⑤）—— H2 反而比較危險 |
| 約束名在訊息裡的格式 | 02 章 2.12.3 | ⚠️ **兩邊都有，但格式完全不同**（探針 ⑩） |
| `CHECK` 違反的例外型別 | 02 章 2.12.2 | 🔴 **MySQL 給 `UncategorizedSQLException`**（探針 ⑪） |
| MySQL 的 `NULL` 排序位置 | 04 章 4.3.4 | ✅ 和 H2 一樣 NULLS FIRST；🔴 **但 `NULLS LAST` 語法不支援**（探針 ⑧） |
| MySQL 深分頁的真實成本 | 04 章 4.7.1 | 🔴 **27 倍**（H2 是 14 倍）—— 04 章的推測正確且低估 |
| **MySQL 對 keyset 兩種寫法的處理** | 04 章 4.7.4 | 🔴 **快慢完全對調** —— 04 章的結論是錯的（已補 4.7.4b） |
| `count(*)` 的成本 | 04 章 4.2.3 | 🔴 **MySQL 6,887 µs vs H2 46 µs（150 倍）** |
| `rewriteBatchedStatements` 的副作用 | 05 章 5.8.9 | 🔴 **`executeBatch` 回 `[-2,…]`，5.8.7 的判斷會壞**（已補 5.8.7b） |
| MySQL 批次失敗後會不會繼續 | 05 章 5.10.1 | ⚠️ **沒開 `rewriteBatchedStatements` 時和 H2 一樣繼續**（⑭a）；<br>🔴 **開了之後變成全有全無，一筆都不進去**（⑭b）→ 已補 05 章 5.10.1b |
| `setEnforceReadOnly` 在 MySQL 上 | 05 章 5.3.4 | ✅ **支援，而且真的擋住 `UPDATE`**（探針 ⑱） |

### 6.10.2 ⚠️ 部分驗證的（3 項）

| 項目 | 出處 | 狀態 |
|---|---|---|
| MySQL 的 `Stream` 串流三條件 | 05 章 5.11.4 | ⚠️ `fetchSize=Integer.MIN_VALUE` **可以跑**；「連線獨佔」與大資料量的記憶體行為**沒量** |
| covering index 的效果 | 04 章練習 3 | ✅ **`type=range` vs `type=ALL` 看得到**；🔴 沒有量時間差 |
| `TIMESTAMP` 的時區行為 | 04 章、05 章 | ⚠️ 只驗證了 **`DATETIME(6)` + `serverTimezone=UTC` 是對的**；🔴 **`TIMESTAMP` 型別本身沒測** |

### 6.10.3 🔴 仍然沒有驗證的（9 項，交給 07-mysql 站）

| 項目 | 出處 | 為什麼這一章沒做 |
|---|---|---|
| InnoDB 的鎖、死鎖、鎖等待逾時 | 05-service 02、05 章 | 需要多執行緒 + 鎖觀測，是 07 章 04 的主題 |
| `REPEATABLE_READ` 與 MVCC 的可見性 | 05 章 5.3.5 | 同上 |
| 長交易對 undo log / `History list length` 的影響 | 05 章 5.12.3 | 需要長時間觀測與 `SHOW ENGINE INNODB STATUS` |
| `AUTO_INCREMENT` 鎖在高併發下的成本 | 05 章 5.8.4 | 需要壓測 |
| 隨機 UUID 當 InnoDB 主鍵的寫入放大 | 05 章 5.8.4 | 需要大資料量 + `SHOW TABLE STATUS` |
| 索引設計（複合索引順序、選擇性） | 04 章 4.7.2 | 07 章 03 的主題 |
| 真實網路延遲下 round trip 的成本 | 05 章 5.8.8 | 本機容器沒有網路延遲（🔴 **本章的 MySQL 數字也受此影響**） |
| 連線池大小在真實負載下的曲線 | 01 章 1.6 | 需要壓測工具 |
| Open Session In View 的完整請求流程 | 05 章 5.6 | 需要 Web 層的端到端測試 |

⚠️ **「真實網路延遲」那一項要特別註記**：
**本章的 MySQL 跑在同一台機器的 Docker 容器裡，網路延遲接近 0。**
所以 6.4.3 那些 µs 的數字**仍然低估了真實環境** ——
只是低估得比 H2 少很多。

📌 **一個容器裡的 MySQL 修正了「方言」與「執行計畫」，沒有修正「距離」。**

---

## 6.11 常見誤區

| 誤區 | 實際 | 哪一節 |
|---|---|---|
| 「用 H2 測資料層就夠了」 | 🔴 **21 根探針，12 根不一樣**，其中 3 根推翻了本課前面的結論 | **6.4** |
| 「H2 有 MySQL 相容模式，那就夠了」 | ⚠️ 相容模式處理的是語法，**處理不了定序、執行計畫、批次行為** | 6.4.2 |
| 「`FETCH FIRST` 是標準 SQL，比較可攜」 | 🔴 **MySQL 8 不支援** —— 標準 ≠ 可攜 | **6.6.2** |
| 「測試綠了就代表 SQL 沒問題」 | 🔴 那兩條 `FETCH FIRST` 的契約在 H2 上綠了**四章** | 6.6.1 |
| 「`@DataJpaTest` 會載入我的 Service」 | 🔴 不會 —— 要 `@Import` | 6.2.4 |
| 「`save()` 之後測試就能測到約束」 | 🔴 **`INSERT` 還沒送出，而測試結束就回滾了** | **6.3.1** |
| 「`flush()` 之後就測得到約束了」 | 🔴 **`ddl-auto` 產生的表根本沒有那個約束** | **6.3.2** |
| 「`ddl-auto: create-drop` 產生的就是正式環境那張表」 | 🔴 **沒有 `CHECK`、沒有索引、沒有定序、沒有 `DEFAULT`** | 6.3.2、6.7.1 |
| 「`save()` 再 `findById()` 查得到 = 存進去了」 | 🔴 **那是一級快取裡的物件** | **6.3.3** |
| 「`@DataJpaTest` 可以測樂觀鎖」 | 🔴 一個測試 = 一個交易，**沒有第二個交易** | 6.3.4 |
| 「加了 Testcontainers 就在測真資料庫」 | 🔴 **少了 `@AutoConfigureTestDatabase(replace = NONE)`，它連的是 H2** |
| 「探針跑過了，兩邊行為就都比對過了」 | 🔴 **探針的連線設定本身是變因** —— 探針 ⑭ 換一個 URL 參數答案就相反 | **6.4.2 ⑭** | 6.5.1 |
| 「Testcontainers 一定會動」 | 🔴 **本課實測：Testcontainers 1.21.3 連不上 Docker Engine 29** | **6.5.3** |
| 「`assumeTrue` 讓測試更友善」 | ⚠️ **CI 上 MySQL 沒起來會全部 skip 而 build 是綠的** | 6.5.4 |
| 「MySQL 的字串比較和 Java 一樣」 | 🔴 **預設定序不分大小寫** —— `Admin` 可以用 `admin` 登入 | **6.4.2 ⑬** |
| 「MySQL 的 `TIMESTAMP` 就是時間戳」 | 🔴 **它有 2038 問題，而且會做時區轉換** | 6.6.4 |
| 「CI 慢就刪一些測試」 | 🔴 **成本在 context 的數量，不在測試的數量** | **6.9.3** |
| 「多加一個 `@MockBean` 沒什麼成本」 | 🔴 **它是一個全新的 context** | 6.9.2 |
| 「`@TestPropertySource` 只是改一個設定」 | 🔴 **每一組不同的 properties 就是一個新 context** | 6.9.2 |

---

## 6.12 本章練習

### 練習 1：找出這個資料層測試的六個問題

```java
@DataJpaTest
class OrderRepositoryTest {

    @Autowired SpringDataOrderRepository repo;

    @Test
    void 存進去再查回來() {
        OrderEntity e = new OrderEntity("O-1", "C-1", OrderStatus.PENDING_PAYMENT,
                38000, "TWD", Instant.now());
        repo.save(e);

        OrderEntity got = repo.findById("O-1").orElseThrow();
        assertThat(got.getStatus()).isEqualTo(OrderStatus.PENDING_PAYMENT);
        assertThat(got.getTotalMinor()).isEqualTo(38000);
    }

    @Test
    void 總額不可以是負的() {
        OrderEntity bad = new OrderEntity("O-2", "C-1", OrderStatus.PENDING_PAYMENT,
                -1, "TWD", Instant.now());
        assertThatThrownBy(() -> repo.save(bad))
                .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void 樂觀鎖擋得住併發修改() {
        repo.save(new OrderEntity("O-3", "C-1", OrderStatus.PENDING_PAYMENT, 100, "TWD", Instant.now()));
        OrderEntity a = repo.findById("O-3").orElseThrow();
        OrderEntity b = repo.findById("O-3").orElseThrow();
        a.setStatus(OrderStatus.PAID);
        b.setStatus(OrderStatus.CANCELLED);
        repo.save(a);
        assertThatThrownBy(() -> repo.save(b))
                .isInstanceOf(OptimisticLockingFailureException.class);
    }
}
```

**先自己找，再往下看。**

---

**答案（六個）**：

**① 第一個測試證明不了任何事**（6.3.3）

`repo.findById("O-1")` 在同一個交易裡回傳的是**剛才 `save()` 的那個物件**（一級快取）。
即使 `save()` 完全沒有寫進資料庫，這個測試也會綠。

**修**：

```java
repo.saveAndFlush(e);
tem.clear();                             // ★ 兩個都要
OrderEntity got = repo.findById("O-1").orElseThrow();
```

**② 第二個測試永遠不會紅**（6.3.1 + 6.3.2）—— **兩個原因疊在一起**：

- `save()` 不送 SQL，測試結束就回滾 → `INSERT` 從沒送出。
- 即使 `flush()`，**`ddl-auto` 產生的表沒有 `CHECK (total_minor >= 0)`**。

**修**：`ddl-auto: none` + 用正式環境的 schema，並且 `saveAndFlush`。

⚠️ **而且斷言的例外型別在 MySQL 上是錯的**（探針 ⑪）——
MySQL 的 `CHECK` 違反給 `UncategorizedSQLException`。
**斷言 `DataAccessException` 這個父類別比較安全。**

**③ 第三個測試測不到樂觀鎖**（6.3.4 + 03 章 3.9.2）

`a` 和 `b` 是**同一個物件** —— 一級快取保證了同一個交易裡同一個 id 只有一個實例。
所以 `a.setStatus(PAID)` 和 `b.setStatus(CANCELLED)` 改的是**同一個物件**，
最後只是 `CANCELLED` 覆蓋 `PAID`，**不會有任何衝突**。

**修**：樂觀鎖需要**兩個交易**（本課契約測試的做法）：

```java
tx(() -> repo.save(anOrder("O-3")));
Order a = inTx(() -> repo.findById("O-3")).orElseThrow();   // 交易 1 讀
Order b = inTx(() -> repo.findById("O-3")).orElseThrow();   // 交易 2 讀
a.cancel();
tx(() -> repo.save(a));                                      // 交易 3 寫
b.markPaid();
assertThatThrownBy(() -> tx(() -> repo.save(b)))             // 交易 4 → 應該失敗
        .isInstanceOf(OptimisticLockingFailureException.class);
```

**④ `Instant.now()` 讓測試不可重現**

時間會影響排序、影響區間查詢；`now()` 還可能因為精度截斷造成 flaky。
**修**：用固定的 `T0`（本課從 00 章就這樣做）。

**⑤ 沒有驗證「連的是哪個資料庫」**（6.5.1）

如果哪天加了 Testcontainers 卻忘了 `@AutoConfigureTestDatabase(replace = NONE)`，
這個測試會**繼續綠**，而它連的是 H2。

**⑥ 這三個測試都應該在真資料庫上再跑一次**（6.6.5）

②（約束）、③（樂觀鎖）**都在「必須用真資料庫」的清單裡**。

---

### 練習 2：設計一個「兩個資料庫都跑」的測試策略 ★

一個專案有 240 個測試：

- 80 個純單元測試（沒有 Spring）
- 140 個 `@DataJpaTest`（H2）
- 20 個 `@SpringBootTest`（H2）

CI 上跑 6 分鐘。現在要加上「在真 MySQL 上驗證」。

**問題**：設計一個方案，要求
（i）本機開發者不需要 Docker 也能跑大部分測試，
（ii）CI 一定會在真 MySQL 上驗證關鍵行為，
（iii）CI 時間**不要超過 15 分鐘**，
（iv）「忘了在 MySQL 上驗證」這件事要**被擋下來**。

---

**答案**：

**先分類那 160 個資料庫測試**（用 6.6.5 的判準）：

| 類別 | 數量（估） | 跑在哪 |
|---|---|---|
| 映射、查詢邏輯、SQL 句數、N+1 | ~120 | H2（快、每次都跑） |
| **契約 / 方言 / 約束 / 定序 / 批次 / 鎖** | **~40** | **真 MySQL** |

**方案**：

```
src/test/java/**/*Test.java     → surefire（mvn test）→ H2，本機預設跑
src/test/java/**/*IT.java       → failsafe（mvn verify）→ 真 MySQL
```

```xml
<plugin>
  <artifactId>maven-failsafe-plugin</artifactId>
  <executions>
    <execution><goals><goal>integration-test</goal><goal>verify</goal></goals></execution>
  </executions>
</plugin>
```

**（i）本機**：`mvn test` → 200 個測試、不需要 Docker、約 6 分鐘。
**（ii）CI**：`mvn verify` → 加跑 40 個 `*IT`。
**（iii）時間**：40 個 IT + 一次 MySQL 啟動（約 10 秒）≈ **+2 分鐘**。

⚠️ **關鍵是「一個容器給全部 IT 共用」** ——
不要每個測試類別一個容器（那會是 40 × 10 秒 = 6 分鐘）。

```java
/** 所有 *IT 繼承它 —— 一個容器、一個 context。 */
@DataJpaTest
@AutoConfigureTestDatabase(replace = Replace.NONE)
@Testcontainers
public abstract class MySqlIntegrationTestBase {

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0");
    //  ★ static + final：JVM 裡只有一個，所有子類別共用
}
```

📌 **`static` 那一行就是「+2 分鐘」與「+6 分鐘」的差別。**
（而且它同時滿足 6.9 的 context 快取 —— 所有 IT 共用**一個** context。）

**（iv）怎麼擋住「忘了驗證」** —— 三道防線：

**① CI 上把「跳過」變成「失敗」**（6.5.4）：

```java
@BeforeAll
static void requireDb() {
    if (Boolean.parseBoolean(System.getenv("REQUIRE_DB"))) {
        assertThat(MYSQL.isRunning()).as("CI 上一定要有 MySQL").isTrue();
    }
}
```

**② 一條 ArchUnit 規則：每一個手寫 SQL 的 Repository 都要有對應的 `*IT`**：

```java
@Test
void 每個手寫SQL的Repository都要有IT() {
    // 找出所有含有 SQL 字面值的 Repository 實作
    // 檢查 test classpath 上有沒有同名的 *IT
}
```

**③ 最實際的一道：一條「每一句 SQL 都要能執行」的煙霧測試**：

```java
class AllQueriesSmokeIT extends MySqlIntegrationTestBase {

    @Test
    void 每一個Repository方法都要能在MySQL上執行() {
        // 用空資料呼叫每一個查詢方法，只驗證「不拋 BadSqlGrammarException」
        assertThatCode(() -> repo.findExpiredPendingPayment(Instant.now(), 10))
                .doesNotThrowAnyException();
        assertThatCode(() -> repo.findById("nope")).doesNotThrowAnyException();
        // …
    }
}
```

📌 **③ 就是 6.6.1 那兩條紅燈的最小版本** ——
**它不驗證邏輯，只驗證「這句 SQL 在正式環境的資料庫上是合法的」。**
⚠️ **而那正好就是 `FETCH FIRST` 那個 bug 需要的全部。**
**一個 5 行的煙霧測試可以擋住一個活了四章的 bug。**

---

### 練習 3：寫一根新的探針 ★★

6.4 有 21 根探針。**再加一根**，要求：

（a）它對應本課某一節的一個「沒有驗證到的」項目；
（b）它在 H2 與 MySQL 上**會給出不同的答案**；
（c）它的輸出要能讓人**一眼看出「哪一個會造成事故」**。

**提示**：想一想 04 章 4.3.4 那個 `nullsLast()` 被忽略的問題，在 MySQL 上怎麼繞。

---

**答案（一個範例）**：

```java
// ㉒ 04 章 4.3.4：nullsLast() 被 Spring Data 忽略，那自己寫怎麼寫
probe(22, "把 NULL 排到最後的可攜寫法", () -> {
    // 標準 SQL：NULLS LAST（探針 ⑧ 已知 MySQL 不支援）
    // 可攜寫法：先按「是不是 NULL」排，再按值排
    List<String> r = jdbc().queryForList(
            "SELECT id FROM probe ORDER BY (shipped_at IS NULL), shipped_at, id LIMIT 3",
            String.class);
    boolean firstIsNull = jdbc().queryForObject(
            "SELECT shipped_at IS NULL FROM probe WHERE id = ?", Boolean.class, r.get(0));
    return "前三筆 " + r + "；第一筆是 NULL 嗎：" + firstIsNull
            + (firstIsNull ? " 🔴 沒排到最後" : " ✅ NULL 排到最後了");
});
```

**為什麼這根探針合格**：

| 要求 | 怎麼滿足 |
|---|---|
| (a) 對應一個未驗證項 | 04 章 4.3.4「MySQL 的 `NULL` 排序位置」的**解法**面 |
| (b) 兩邊答案不同 | `(x IS NULL)` 在 MySQL 回 `0/1`，在 H2 回 `TRUE/FALSE` —— **排序結果一樣，但型別不同**，而 `SELECT (x IS NULL)` 的取值方式不同 |
| (c) 一眼看出事故 | 「第一筆是 NULL 嗎」直接對應「還沒出貨的訂單有沒有排到最後」這個使用者看得到的行為 |

**更好的探針還會加上「兩種寫法的執行計畫」**：

```java
Lab.line("  ORDER BY (x IS NULL), x  的計畫：%s",
        plan(jdbc(), "SELECT id FROM probe ORDER BY (shipped_at IS NULL), shipped_at LIMIT 3"));
```

⚠️ **因為 `(x IS NULL)` 是一個表達式，它會讓 `shipped_at` 上的索引【失效】** ——
📌 **這才是這根探針真正該報告的東西**：
**「可攜的寫法」買到了可攜性，賣掉了索引。**

**其他值得寫的探針**（自己試）：

| 探針 | 對應 | 預期差異 |
|---|---|---|
| `TIMESTAMP` vs `DATETIME` 的時區行為 | 6.6.4 | MySQL 的 `TIMESTAMP` 會轉換 |
| `SELECT ... FOR UPDATE` 的行為與逾時 | 05 章 | H2 的鎖模型不同 |
| 空字串 `''` 與 `NULL` 是不是同一件事 | —— | Oracle 上是；MySQL / H2 上不是 |
| `utf8mb4` 的 emoji 與 4 bytes 字元 | —— | `utf8`（3 bytes）會截斷 |
| `ORDER BY` 一個 `TEXT` 欄位的長度上限 | —— | MySQL 有 `max_sort_length` |

---

## 6.13 驗收清單

**測試切片**

- [ ] `src/test/java` 的套件結構和 `src/main/java` 一致（否則測試切片找不到應用程式的根）。
- [ ] 資料層測試用 `@DataJpaTest` / `@JdbcTest`，**不是** `@SpringBootTest`。
- [ ] 純領域邏輯的測試**完全不用 Spring**。
- [ ] `@MockBean` 的數量有被控制（每一組不同的 mock = 一個新 context）。

**回滾藏起來的東西**

- [ ] 每一個「存了再查」的測試都有 `flush()` **加** `clear()`（或分成兩個交易）。
- [ ] 測約束的測試用 `saveAndFlush`，而且**schema 上真的有那個約束**。
- [ ] 樂觀鎖 / 併發的測試**不在**單一交易裡（`NOT_SUPPORTED` 或自己管交易）。

**schema**

- [ ] `ddl-auto: none`，測試跑的是**和正式環境同一份** DDL / migration。
- [ ] 用 `information_schema` 驗證過測試資料庫上**真的有**那些 `CHECK` 與索引。
- [ ] 時間欄位用 `DATETIME(6)` 而不是 `TIMESTAMP`（MySQL）。

**真資料庫**

- [ ] 有一組跑在真資料庫上的測試，而且**驗證過它真的連到那個資料庫**
      （`getDatabaseProductName()`）。
- [ ] 用了 Testcontainers 的話，有 `@AutoConfigureTestDatabase(replace = NONE)`。
- [ ] 容器是 **`static`** 的（一個 JVM 一個容器）。
- [ ] CI 上「資料庫連不上」會**失敗**，不是 skip。
- [ ] **每一句手寫 SQL 都在真資料庫上執行過**（哪怕只是一個煙霧測試）。

**方言**

- [ ] 沒有任何一句 SQL 用了「只有測試用的資料庫支援」的語法
      （`FETCH FIRST`、`NULLS LAST`、`IN ()`…）。
- [ ] 唯一鍵、登入、搜尋等**依賴字串比較**的地方，考慮過**定序是否分大小寫**。
- [ ] `catch` 的是 `DataAccessException` 這一層，不是特定子類別
      （不同資料庫的分類不同）。
- [ ] keyset 分頁的 `WHERE` 形狀**在正式環境的資料庫上 `EXPLAIN` 過**。

**CI 時間**

- [ ] 打開過 `logging.level.org.springframework.test.context.cache=DEBUG` 看 `missCount`。
- [ ] 測試設定收斂到少數幾個基底類別。
- [ ] `spring.test.context.cache.maxSize` 大於實際的 context 數。

---

## 6.14 這一站結束了

06-repository 站到這裡結束。**回頭看這一站做了什麼**：

| 章 | 主題 | 最重要的一個實測 |
|---|---|---|
| 00 | 資料層定位與介面設計 | 加了 `CHECK` 約束，**20 個人仍然搶得到 10 個庫存** |
| 01 | DataSource 與連線池 | 池從 4 加到 64，**吞吐掉了 4.6 倍** |
| 02 | JDBC 與 JdbcTemplate | 一個輸入**把整張表刪掉**；`MERGE` 讓樂觀鎖**靜默失效** |
| 03 | Spring Data 抽象 | 沒有實作的介面 = `$Proxy80` + **七層攔截器**；契約 **12 綠 2 紅** |
| 04 | 分頁、排序與動態查詢 | 12 筆資料翻三頁，**只看到 11 筆** |
| 05 | 交易邊界與批次 | 設了 `batch_size`，**`addBatch` 一次都沒被呼叫** |
| 06 | 資料層測試 | 21 根探針，**12 根兩邊不一樣**；17 條契約在 MySQL 上 **2 條紅** |

📌 **而這七章有一個共同的形狀**：

> **每一章最重要的那個發現，都不是「讀程式碼看出來的」，
> 是「把某個看不見的東西量出來」之後才出現的。**

| 章 | 那個「量出來的東西」 |
|---|---|
| 00 | 五輪併發之後，資料庫裡的數字 |
| 01 | 池的大小 vs 吞吐與 p95 |
| 02 | 資料庫收到的那句 SQL 字面 |
| 03 | `StatementInspector` 攔到的 SQL 句數 |
| 04 | `EXPLAIN ANALYZE` 的 `scanCount` |
| 05 | JDBC 層的 `addBatch` / `executeBatch` 計數 |
| 06 | **同一組東西在兩個資料庫上的輸出並排** |

⚠️ **而 06 章的工具是最便宜的一個** ——
它不需要寫任何攔截器、任何代理、任何計數器。
**它只需要「跑第二次」。**

---

### 這一站沒有解決的，交給誰

| 問題 | 下一站 |
|---|---|
| 索引怎麼設計、`EXPLAIN` 怎麼讀 | **07-mysql 03 章** |
| InnoDB 的鎖、死鎖、隔離級別 | **07-mysql 04 章** |
| 慢查詢怎麼找、怎麼調 | **07-mysql 05 章** |
| Flyway / migration 怎麼管 | **07-mysql 06 章** |
| Entity 映射的細節、關聯、N+1 的完整解法 | **08-jpa-mybatis** |
| MyBatis 的動態 SQL 與它和本站的取捨 | **08-jpa-mybatis** |

---

## 6.15 本章的實驗環境與結果

**環境**：

| 項目 | 版本 |
|---|---|
| JDK | Temurin **21.0.5**（LTS） |
| Maven | **3.9.16** |
| Spring Boot | **3.2.5** |
| Hibernate | **6.4.4.Final** |
| **測試資料庫 A** | **H2 2.2.224**（`QUERY_CACHE_SIZE=0`） |
| **測試資料庫 B** | **MySQL 8.0.46**（Docker，`utf8mb4_0900_ai_ci`） |
| MySQL Connector/J | **8.3.0** |
| Testcontainers | 1.21.3（🔴 **無法使用**，見 6.5.3） |
| Docker Engine | **29.1.3**（API 1.52，MinAPI 1.44） |
| ArchUnit | 1.3.0 |
| 平台 | macOS 14.2.1 / Apple Silicon |

**跑過的實驗（5 組）**：

| 組 | 實驗 | 結果 |
|---|---|---|
| **S1** | `@DataJpaTest` 的切片 | ✅ **99 個 bean**；有 `EntityManagerFactory` / `DataSource` / `JdbcTemplate` / 我們的 Repository；🔴 **沒有** `ObjectMapper` / `RestTemplateBuilder` / 我們的 `@Service`<br>⚠️ 順帶發現 **`@ComponentScan` 的 excludeFilters 擋不住 Spring Data 的 repository 掃描** |
| **S2** | 回滾藏起來的東西 | ✅ 測試 1 存的資料，測試 2 看不到<br>🔴 **存一筆違反 `CHECK` 的資料，測試是綠的**（`INSERT` 沒送出）<br>🔴 **`flush()` 之後【還是】綠的 —— `ddl-auto` 產生的表只有一個 `@Enumerated` 的 CHECK，沒有業務約束**<br>🔴 **繞過 JPA 改資料庫之後，`findById` 回的是一級快取裡的舊物件** |
| **S3** | context 快取 | ✅ 五個「看起來一樣」的 `@DataJpaTest` → **建立了 3 個 context**；多一行 `@TestPropertySource` 或多一個 `@MockBean` 就是一個新的 |
| **探針** | **H2 vs MySQL 8，21 根** | 🔴 **12 根不一樣**：`FETCH FIRST`①③、`IN ()`④、多句 SQL⑤、`NULLS LAST`⑧、約束訊息⑩、`CHECK` 例外型別⑪、**定序大小寫**⑬、`rewriteBatchedStatements`⑰、`SET TRANSACTION READ ONLY`⑱、`fetchSize`⑲、covering index⑳<br>✅ 9 根一樣：`LIMIT`②、`SELECT ?`⑥、NULL 位置⑦、row value 支援⑨、長度限制⑫、批次失敗後繼續⑭、`executeBatch` 回傳⑮、`DATETIME` 往返⑯、`NOT NULL` 訊息㉑ |
| **效能** | 深分頁與 keyset | 🔴 **深分頁：H2 慢 14 倍，MySQL 慢 27 倍**<br>🔴 **keyset 兩種寫法【快慢對調】**：OR 在 H2 是 4,802 µs / MySQL 是 513 µs（`type=range`）；row value 在 H2 是 113 µs / MySQL 是 13,235 µs（`type=index`）<br>🔴 **`count(*)`：H2 46 µs vs MySQL 6,887 µs（150 倍）**<br>✅ **covering index 在 MySQL 上看得到**：只查 id → `type=range`；查 name → `type=ALL` |
| **契約** | **17 條 × 真 MySQL** | 🔴 **第一次執行：2 條紅**（`FETCH FIRST ? ROWS ONLY` 是語法錯誤）<br>→ 把分頁子句改成建構子參數後 **17 條全綠，H2 與 MySQL 各一遍共 34 個** |

```
[INFO] Tests run: 17, Failures: 0, Errors: 0 -- in lab.MySqlJdbcOrderRepositoryContractTest
[INFO] Tests run: 17, Failures: 0, Errors: 0 -- in lab.JdbcOrderRepositoryContractTest
[INFO] Tests run: 223, Failures: 0, Errors: 0, Skipped: 0
[INFO] BUILD SUCCESS
```

**本章的驗證專案：5 組實驗 + 21 根探針 × 2 個資料庫 + 17 條契約 × 真 MySQL，
連同 00～05 章的既有測試共 223 個，全綠。**

⚠️ **這一章推翻了前面章節的三個結論，三個都已經回頭修正**：

| 推翻了什麼 | 原本寫在哪 | 修正 |
|---|---|---|
| 「`FETCH FIRST` 比 `LIMIT` 可攜」 | 02 章 2.6.4 | **06 章 6.6** + `JdbcOrderRepository` 的建構子參數 |
| 「keyset 要用 row value 寫法」 | 04 章 4.7.4 | **04 章新增 4.7.4b** |
| 「`saveAll()` 可以用 `updated[i]` 判斷新舊」 | 05 章 5.8.7 | **05 章新增 5.8.7b** |

📌 **三個都是「在 H2 上量出來、寫得很有把握、而且是錯的」。**

🔴 **本章沒有驗證到的**：見 **6.10.3**（9 項，全部交給 07-mysql 站）。

> 📌 **最後一句話**：
>
> 這一站的七章，每一章都在講「某個東西和你以為的不一樣」。
> 而這一章講的是**最後一層**：
>
> **「你用來確認前面六章的那個工具，本身也和你以為的不一樣。」**
>
> ```
> 02 章：「FETCH FIRST 是標準 SQL，比較可攜」
>        ↓ 推理正確、文件正確、測試全綠
>        ↓ 綠了四章
> 06 章：MySQL 8.0.46 → SQLSyntaxErrorException
> ```
>
> ⚠️ **那個 bug 不需要更好的程式設計、更嚴謹的 code review、或更多的測試才能發現。**
> **它只需要【在正式環境用的那個資料庫上跑一次】。**
>
> **而「跑一次」的成本是 0.76 秒。**
>
> ---
>
> 📌 **所以這一站真正的結論，是一句很短的話**：
>
> > **資料存取層的每一個結論，都是「在某個資料庫上」的結論。**
> >
> > 00 章的不變量、01 章的池、02 章的 SQL、03 章的代理、
> > 04 章的分頁、05 章的批次 ——
> > **沒有一個是「在資料庫之外」成立的。**
>
> **而這正是為什麼下一站是 07-mysql。**
> **不是因為 MySQL 特別重要，是因為「你的那個資料庫」特別重要 ——
> 而這門課的那個資料庫，叫 MySQL。**
