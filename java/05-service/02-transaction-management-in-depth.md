# 第 02 章：交易管理

> 這是整站的核心章，也是唯一不能跳的一章。
>
> 前兩章反覆說「交易邊界在 Application Service」，但沒有回答：
> **`@Transactional` 到底做了什麼？**
>
> 而更重要的是另一個問題 —— 它是這一章真正的主題：
>
> **`@Transactional` 在什麼時候「完全沒有作用」，而你不會收到任何警告？**
>
> 我看過一個上線兩年的訂單系統，`OrderServiceImpl` 上有 14 個 `@Transactional`。
> 其中 **5 個從來沒有生效過**。
> 系統「能動」，因為單筆寫入本來就是原子的；
> 問題只在「一個方法寫兩張表而中間失敗」時才顯現 —— 大約每個月三次，
> 而每次都被歸類成「偶發的資料異常」。
>
> ⚠️ **這一章會破例用真的 MySQL**（Testcontainers）。
> 理由在 2.2.5：**交易與併發沒有辦法用記憶體假實作學。**

---

## 2.1 學習目標

完成本章後，你應該可以：

- 說出一個 `@Transactional` 方法從進入到離開，Spring 實際做了哪些事（14 步）。
- 說明交易、連線、`ThreadLocal` 三者的關係，以及為什麼「換執行緒 = 換交易」。
- 完整說出 **7 種傳播行為**，以及「A 在 B 裡面」的 7×2 組合各自會發生什麼。
- 說出 `REQUIRES_NEW` 的三個代價，以及它為什麼是「連線池耗盡」的常見來源。
- 說出四種隔離級別與三種讀異常，並解釋 **MySQL 的 `REPEATABLE READ` 為什麼不完全等於標準定義**。
- 說出 `@Transactional` 每一個參數的真實語意 —— 特別是 **`timeout` 不是「方法逾時」**。
- 解釋為什麼 checked exception 預設**不會**觸發 rollback，以及那個預設的歷史與現在的理由。
- 診斷**五種**交易失效情境，每一種都能寫出一個會紅燈的測試。
- 讀懂 `UnexpectedRollbackException`，並說出為什麼 `REQUIRES_NEW` 是常見但通常錯誤的解法。
- 說出「交易裡不可以做的六件事」，並用一條算式估出交易長度對吞吐量的影響。
- 在悲觀鎖、樂觀鎖、原子 UPDATE 三者之間做出有理由的選擇。
- 處理死鎖：說出它為什麼發生、怎麼降低機率、以及重試該怎麼寫。
- 說出 `@TransactionalEventListener` 的四個 phase，以及 `AFTER_COMMIT` 的三個陷阱。
- 證明「這個方法真的在交易裡」—— 而不是「看起來像」。

## 前置知識

[00 章](./00-course-map-business-layer-role.md)（尤其 0.8 不變量）、
[01 章](./01-service-design-and-dependency.md)（尤其 1.3 代理與 1.6 循環依賴），
[02-spring-boot/](../02-spring-boot/) 04 章（AOP 與代理機制）。

---

## 2.2 交易是什麼，以及這一章為什麼要用真的資料庫

### 2.2.1 ACID 的四個字母，各自由誰保證

大部分教材把 ACID 當成一個整體。**但在 Spring 專案裡，四個字母是由四個不同的東西保證的**，
而搞不清楚誰負責什麼，就會把問題找錯地方。

| 字母 | 意思 | **由誰保證** | 你可以做錯什麼 |
|---|---|---|---|
| **A**tomicity（原子性） | 全部成功或全部失敗 | **資料庫的 undo log** + Spring 決定「邊界在哪」 | 🔴 邊界畫錯（2.9）、`@Transactional` 沒生效（2.7） |
| **C**onsistency（一致性） | 交易前後資料都滿足約束 | ⚠️ **你自己**（約束 + 不變量，00 章 0.8） | 🔴 只在 Java 裡檢查（0.8.4） |
| **I**solation（隔離性） | 併發交易互不干擾 | **資料庫的鎖與 MVCC** | 🔴 以為「有交易就不會有 race」（2.11.2） |
| **D**urability（持久性） | commit 之後不會消失 | **資料庫的 redo log + fsync** | ⚠️ `innodb_flush_log_at_trx_commit=2` 換效能換掉它 |

⚠️ **最容易誤解的是 C。**

很多人以為「開了交易，資料就會是一致的」。
**不是。** 交易保證的是「**你的那些寫入要嘛全發生要嘛全不發生**」——
至於那些寫入合不合理，交易一點意見都沒有。

```java
@Transactional
public void transfer(String from, String to, Money amount) {
    accounts.debit(from, amount);      // A -100
    accounts.credit(to, amount);       // B +100
}
// ✅ 原子性：兩行一起成功或一起失敗
// ❌ 一致性：如果 A 的餘額只有 50，交易照樣 commit —— 除非你自己檢查，
//    或資料庫上有 CHECK (balance >= 0)
```

> 📌 **00 章 0.8 那整節（不變量守在四個位置）講的就是 C。
> 這一章講的是 A 與 I。**

⚠️ **而 I 是最反直覺的一個** ——
「隔離」不代表「序列化」。除非你用 `SERIALIZABLE`（幾乎沒有人用），
**兩個交易仍然可以同時通過同一個 `if`**（2.11.2）。

### 2.2.2 一個 `@Transactional` 方法實際發生了什麼

先建立一個心理模型。當你呼叫：

```java
orderService.create(cmd);        // orderService 是一個 CGLIB 代理
```

**Spring 依序做了這 15 件事**：

```
① 代理攔截 → TransactionInterceptor.invoke()
      │
② 讀取這個方法的交易屬性（TransactionAttributeSource）
      │   · propagation、isolation、timeout、readOnly、rollbackFor
      │   · ⚠️ 讀不到（非 public / 沒註解）→ 直接呼叫目標方法，「沒有交易」
      │
③ 決定用哪一個 PlatformTransactionManager（transactionManager 屬性 / 唯一的那個）
      │
④ 問 TransactionSynchronizationManager：現在這條執行緒上有交易嗎？
      │   · ⚠️⚠️ 「這條執行緒」—— 換執行緒就換一個世界（2.7.4）
      │
⑤ 依 propagation 決定：加入 / 開新的 / 掛起 / 拋例外 / 不用交易（2.3）
      │
⑥ 若要開新交易 → DataSource.getConnection()  ★ 一條連線從這裡被獨佔
      │
⑦ connection.setAutoCommit(false)             ★ 交易「真的」從這裡開始
      │   · readOnly=true → connection.setReadOnly(true)
      │   · isolation ≠ DEFAULT → connection.setTransactionIsolation(...)
      │
⑧ 把 (DataSource → ConnectionHolder) 綁到 ThreadLocal
      │   · 之後 JdbcTemplate / Hibernate 都從這裡拿「同一條連線」
      │
⑨ ── 執行你的方法 ──────────────────────────────
      │
⑩ 方法正常返回 → 檢查 rollback-only 標記（2.8）
      │   方法拋例外   → 依 rollbackFor 規則決定 commit 還是 rollback（2.6）
      │
⑪ triggerBeforeCommit → @TransactionalEventListener(BEFORE_COMMIT)
      │   ★ 這時候還在交易裡，寫入會一起 commit
      │
⑫ connection.commit() / rollback()            ★ 交易在這裡真正結束
      │
⑬ triggerAfterCommit → @TransactionalEventListener(AFTER_COMMIT)
      │   ⚠️⚠️ 資源「還綁在 ThreadLocal 上」，但「不會再有 commit」
      │        → 這是 2.12.3 那個坑的根源
      │
⑭ triggerAfterCompletion → @TransactionalEventListener(AFTER_COMPLETION)
      │   ⚠️ 同步器在呼叫前已被清除；例外在這裡會被 catch 並記 log
      │
⑮ cleanupAfterCompletion
        · TransactionSynchronizationManager.clear()  ← actualTransactionActive 到這裡才變 false
        · 解除 DataSource 綁定 → connection 歸還池子
```

⚠️⚠️ **⑬～⑮ 的順序是本章最容易搞錯的一段，而它有實際後果**：

> **在 `AFTER_COMMIT` 裡，`isActualTransactionActive()` 仍然回傳 `true`，
> 而且 `JdbcTemplate` 仍然會拿到「原本那條連線」——
> 但那條連線上「不會再有任何 commit」。**
>
> 👉 Spring 自己在 `TransactionSynchronization.afterCommit` 的 javadoc 寫得很白：
> *「交易已經 commit 了，但交易資源可能仍然活著且可存取……
> 因此：從這裡呼叫的任何交易操作都要用 `PROPAGATION_REQUIRES_NEW`。」*
>
> ⚠️ **所以「`AFTER_COMMIT` 裡沒有交易」是一個常見但錯誤的說法** ——
> 正確的說法是「**有一個已經 commit 的交易還綁著，而它不會再 commit 一次**」。
> 2.12.3 會展開它的後果。

**這張圖是本章其他每一節的地基。** 之後每講一個問題，我都會指回其中一步：

| 問題 | 出在哪一步 |
|---|---|
| `@Transactional` 沒生效 | ① 或 ②（代理攔不到 / 讀不到屬性） |
| 傳播行為 | ⑤ |
| 交易佔著連線 | ⑥ ～ ⑬ 之間的全部時間 |
| 換執行緒就沒交易 | ④（ThreadLocal） |
| `UnexpectedRollbackException` | ⑩ |
| checked exception 沒 rollback | ⑩ |
| `AFTER_COMMIT` 裡的寫入永遠不會被 commit | ⑬ 在 ⑫ 之後、⑮ 之前 |

### 2.2.3 `PlatformTransactionManager`：三個你會遇到的實作

```java
public interface PlatformTransactionManager extends TransactionManager {
    TransactionStatus getTransaction(TransactionDefinition definition);
    void commit(TransactionStatus status);
    void rollback(TransactionStatus status);
}
```

**只有三個方法。** 而 `@Transactional` 做的事，就是在你的方法前後呼叫它們。

| 實作 | 什麼時候被 Boot 自動裝配 | 交易的「真身」 |
|---|---|---|
| `DataSourceTransactionManager` | 有 `DataSource`、**沒有** JPA | JDBC `Connection` 的 autoCommit |
| `JpaTransactionManager` | 有 `spring-boot-starter-data-jpa` | Hibernate `Session` + 底層的 `Connection` |
| `JtaTransactionManager` | 有 JTA（多資料源的分散式交易） | ⚠️ 幾乎不要用，見下方 |

⚠️ **06 站（Repository）用 `JdbcTemplate` → `DataSourceTransactionManager`；
08 站（JPA）會換成 `JpaTransactionManager`。**

**這一章大部分的行為兩者相同**，但有三個地方不同，我會逐一標註：

| 差異 | `DataSourceTransactionManager` | `JpaTransactionManager` |
|---|---|---|
| `NESTED` 支援 | ✅ 建構子就開啟 savepoint | ⚠️ 預設**不支援**（2.3.5） |
| `readOnly` 的效果 | `Connection.setReadOnly(true)` | ➕ Hibernate `FlushMode.MANUAL`（2.5.2） |
| 何時真的送出 SQL | 呼叫 `JdbcTemplate` 的當下 | ⚠️ **flush 時**（08 站的大坑） |

⚠️ **關於 JTA / 分散式交易，這一站的立場很明確**：

> **不要用。**
>
> 兩階段提交（2PC）在「協調者掛掉」時會讓資源被鎖到有人手動介入，
> 而它解決的問題（跨資料庫的原子性）幾乎總是有更好的解法：
> **把它們合併成一個資料庫**，或**接受最終一致並用 outbox / Saga**（06 章 6.9）。
>
> 👉 「我需要 JTA」通常是「我的服務邊界切錯了」的症狀。

### 2.2.4 交易、連線、ThreadLocal

**這是本章最重要的一個機制**，而它解釋了一半以上的「交易失效」。

```
                    TransactionSynchronizationManager
                    （一堆 static 的 ThreadLocal）
┌──────────────────────────────────────────────────────────┐
│ ThreadLocal<Map<Object, Object>> resources                │
│    DataSource ──→ ConnectionHolder（那條被獨佔的連線）      │
│                                                          │
│ ThreadLocal<Set<TransactionSynchronization>> synchronizations
│    ← @TransactionalEventListener 註冊在這裡               │
│                                                          │
│ ThreadLocal<String>  currentTransactionName               │
│ ThreadLocal<Boolean> currentTransactionReadOnly           │
│ ThreadLocal<Integer> currentTransactionIsolationLevel     │
│ ThreadLocal<Boolean> actualTransactionActive              │
└──────────────────────────────────────────────────────────┘
```

**三個直接的推論：**

> **① 「同一個交易」= 「同一條執行緒上綁著同一個 `ConnectionHolder`」。**
>
> **② 換執行緒 = 完全沒有交易**（`@Async`、`CompletableFuture`、
> `parallelStream()`、新 `Thread`）—— 2.7.4。
>
> **③ `JdbcTemplate` 怎麼知道要用「交易裡的那條連線」？**
> 它不是自己 `dataSource.getConnection()`，而是
> `DataSourceUtils.getConnection(dataSource)` ——
> **先問 ThreadLocal，有就用那條，沒有才向池子要。**

⚠️ **推論 ③ 有一個很實際的意義**：

```java
@Transactional
public void doIt() {
    jdbcTemplate.update("INSERT ...");          // ✅ 用交易裡的連線
    dataSource.getConnection().createStatement()// 🔴 自己要一條「新的」連線
        .execute("INSERT ...");                 //    → 它不在這個交易裡！
}
```

**第二行的寫入不會被 rollback。** 而這種程式碼在「為了跑一段特殊 SQL」時很常出現。

👉 **正解**：一律用 `JdbcTemplate` / `NamedParameterJdbcTemplate`，
真的需要原生 `Connection` 時用 `DataSourceUtils.getConnection(dataSource)`，
並用 `DataSourceUtils.releaseConnection(...)` 歸還（**不是** `close()`）。

**驗證這件事的一行程式碼：**

```java
import org.springframework.transaction.support.TransactionSynchronizationManager;

log.info("在交易裡？{}，名稱={}，唯讀={}",
         TransactionSynchronizationManager.isActualTransactionActive(),
         TransactionSynchronizationManager.getCurrentTransactionName(),
         TransactionSynchronizationManager.isCurrentTransactionReadOnly());
```

⚠️ **`isActualTransactionActive()` 與 `isSynchronizationActive()` 不一樣**：
後者在 `readOnly` 的「同步但沒有實際交易」情況下也是 `true`。
**要判斷「真的有交易」一律用前者。** 2.13.1 會做成一個工具。

### 2.2.5 為什麼這一章要用真的 MySQL ★

00 章 0.2.2 說「Repository 先用記憶體假實作」，而這一章**破例**。

**因為這一章要學的東西，記憶體假實作全部沒有：**

| 這一章的主題 | 記憶體假實作有嗎 |
|---|---|
| rollback 真的把寫入撤銷 | ❌ 沒有（`Map.put` 撤不回來） |
| 傳播行為（掛起、savepoint） | ❌ 沒有 |
| 隔離級別與 MVCC | ❌ 沒有 |
| 行鎖、間隙鎖 | ❌ 沒有 |
| `SELECT ... FOR UPDATE` | ❌ 沒有 |
| 死鎖偵測 | ❌ 沒有 |
| 樂觀鎖衝突 | ⚠️ 可以模擬，但模擬的是你以為的行為 |
| **連線池耗盡** | ❌ 沒有 |

> ⚠️ **最後一項值得強調**：00 章 0.3.2 事故 1（ERP 逾時拖垮全站）
> **在記憶體假實作上永遠不會重現**，因為根本沒有連線池。
> 而它是這一站損失最大的一個事故。

**基底類別**（04-controller 7.11.6 已建立，這裡補上交易相關的設定）：

```java
package example.shop.support;

import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.MySQLContainer;
import org.testcontainers.junit.jupiter.Testcontainers;

/**
 * 需要真資料庫的測試的基底。
 *
 * <h2>★★ 三個刻意的設定</h2>
 *
 * <p><b>① 容器是 static，整個測試 JVM 共用一個。</b>
 * 每個測試類別起一個容器的話，40 個類別 = 40 × 8 秒 = 5 分鐘。
 * ⚠️ 而 Testcontainers 的 reuse 模式（{@code withReuse(true)}）在 CI 上
 * 通常<b>不要開</b> —— 它會讓「上一次跑剩下的資料」影響這一次。
 *
 * <p><b>② 連線池刻意設得很小（5）。</b>
 * 這不是為了省資源 —— 是為了讓
 * <b>「交易佔著連線太久」這個問題在測試裡就會浮現</b>（2.9.3）。
 * 生產環境 20 條連線 × 200 個請求才會爆，測試環境 5 條 × 6 個請求就爆了。
 *
 * <p><b>③ 明確關掉 open-in-view 與 auto-commit。</b>
 * 讓測試環境的行為與生產一致 —— 否則你會在測試裡看到
 * 「沒有交易也能寫入」而以為交易生效了。
 */
@SpringBootTest
@Testcontainers
public abstract class MySqlIntegrationTestBase {

    // ★ static：整個 JVM 一個容器
    @org.testcontainers.junit.jupiter.Container
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("shop")
            .withUsername("shop")
            .withPassword("shop")
            // ★★ 這三個參數讓容器的行為與生產一致
            .withCommand(
                    "--character-set-server=utf8mb4",
                    "--collation-server=utf8mb4_0900_ai_ci",
                    // ⚠️ 嚴格模式 —— 否則「欄位溢位」會被靜默截斷而不是報錯
                    //    （00 章 0.8.3 的 UNSIGNED 陷阱）
                    "--sql-mode=STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION",
                    // ★ 把鎖等待縮短到 5 秒 —— 測死鎖與鎖等待時不用等 50 秒
                    "--innodb-lock-wait-timeout=5");

    @DynamicPropertySource
    static void datasource(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", MYSQL::getJdbcUrl);
        registry.add("spring.datasource.username", MYSQL::getUsername);
        registry.add("spring.datasource.password", MYSQL::getPassword);

        // ★★ 見 javadoc ②
        registry.add("spring.datasource.hikari.maximum-pool-size", () -> 5);
        registry.add("spring.datasource.hikari.connection-timeout", () -> 2000);

        registry.add("spring.jpa.open-in-view", () -> false);
        registry.add("spring.jpa.hibernate.ddl-auto", () -> "validate");
        // ★★ schema 由 Flyway 管，測試走「與生產同一份」migration
        //    ⚠️ 這一章是整站第一次需要真的 schema —— 前兩章的 Repository 是記憶體假實作。
        //       所以 src/main/resources/db/migration/ 的第一批 SQL 就在這裡出現：
        //         V1__orders.sql、V2__stock.sql、V3__coupon.sql、
        //         V4__order_number_sequence.sql、V5__coupon_usage.sql、
        //         V6__address_change_log.sql、V7__propagation_probe.sql（測試用）
        //    👉 完整的 schema 設計（索引、型別、字元集）是 07-mysql 的主題；
        //       這裡只建「這一章的測試跑得起來」所需的最小版本。
        registry.add("spring.flyway.enabled", () -> true);
    }
}
```

⚠️ **`ddl-auto=validate` 而不是 `create-drop`**，理由很重要：

> **測試要跑在「與生產同一份 schema」上。**
> `create-drop` 用的是 Hibernate 從 Entity 推出來的 schema ——
> 那份 schema **沒有你的 `CHECK` 約束、沒有你的複合索引、
> 沒有你的 `UNIQUE`**。
>
> 而 00 章 0.8.3 說「不變量的最後防線是資料庫約束」——
> 用 `create-drop` 測，那道防線在測試裡**根本不存在**。

**再加一個「每個測試之間清資料」的機制：**

```java
/**
 * ★★ <b>不要用 {@code @Transactional} 讓測試自動 rollback。</b>
 *
 * <p>那是最常見的做法，也是這一章最不能用的做法 —— 三個理由：
 * <ol>
 *   <li>被測的 Service 自己有 {@code @Transactional}，
 *       它會<b>加入測試的交易</b>（{@code REQUIRED}）→
 *       <b>你測不到「它自己的交易到底有沒有 commit」</b>。</li>
 *   <li>{@code REQUIRES_NEW}、{@code AFTER_COMMIT} 的行為完全不同。</li>
 *   <li>併發測試需要「另一條執行緒看得到已 commit 的資料」——
 *       測試的交易沒 commit，另一條執行緒什麼都看不到。</li>
 * </ol>
 *
 * <p>👉 改成「每個測試之後截斷所有表」。慢一點（約 15ms），但它是<b>對的</b>。
 */
@Component
public class DatabaseCleaner {

    private final JdbcTemplate jdbc;
    private final List<String> tables;

    public DatabaseCleaner(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
        // ★ 從 information_schema 讀，新增表不用改這裡
        this.tables = jdbc.queryForList("""
                SELECT table_name FROM information_schema.tables
                 WHERE table_schema = DATABASE()
                   AND table_type = 'BASE TABLE'
                   AND table_name NOT IN ('flyway_schema_history')
                """, String.class);
    }

    public void clean() {
        jdbc.execute("SET FOREIGN_KEY_CHECKS = 0");
        try {
            tables.forEach(t -> jdbc.execute("TRUNCATE TABLE " + t));
        } finally {
            jdbc.execute("SET FOREIGN_KEY_CHECKS = 1");
        }
    }
}
```

⚠️ **`TRUNCATE` 而不是 `DELETE`**：前者也重置 `AUTO_INCREMENT`，
於是「第一筆的 id 是 1」這種假設在每個測試裡都成立。

> 📌 **這一節的結論，是這一章唯一的「環境要求」**：
> **測 Service 的商業規則 → 不要碰資料庫（00 章 0.9.5 第一層）。
> 測交易與併發 → 一定要真的資料庫，而且不可以用 `@Transactional` 自動 rollback。**

---
## 2.3 傳播行為 ★★

### 2.3.1 七種傳播行為

**傳播行為回答的問題只有一個**：

> **「呼叫這個方法時，如果**已經**有一個交易在跑，怎麼辦？」**

```java
public enum Propagation {
    REQUIRED,        // 有就加入，沒有就開一個            ← 預設
    SUPPORTS,        // 有就加入，沒有就「不用交易」跑
    MANDATORY,       // 有就加入，沒有就拋例外
    REQUIRES_NEW,    // 永遠開新的（把外面的掛起）
    NOT_SUPPORTED,   // 永遠不用交易（把外面的掛起）
    NEVER,           // 有就拋例外，沒有就不用交易跑
    NESTED           // 有就開 savepoint，沒有就等同 REQUIRED
}
```

**用一張圖記住它們的關係：**

```
                    「外面有交易嗎？」
                    ┌────────────┴────────────┐
                    │ 有                       │ 沒有
                    ▼                          ▼
  REQUIRED       加入它                     開一個新的
  SUPPORTS       加入它                     不用交易
  MANDATORY      加入它                     🔴 IllegalTransactionStateException
  REQUIRES_NEW   掛起它，開新的              開一個新的
  NOT_SUPPORTED  掛起它，不用交易             不用交易
  NEVER          🔴 IllegalTransactionStateException   不用交易
  NESTED         開一個 savepoint            開一個新的（等同 REQUIRED）
```

### 2.3.2 完整矩陣

**這張表是本節的核心。** 情境：`outer()` 呼叫 `inner()`（**經過代理**）。

| `inner` 的傳播 | `outer` 有交易 | `inner` 拋例外時，`outer` 的資料 | `outer` 拋例外時，`inner` 的資料 |
|---|---|---|---|
| **`REQUIRED`** | 加入同一個交易 | 🔴 **一起 rollback**（即使 outer catch 掉，見 2.8） | 🔴 一起 rollback |
| **`REQUIRES_NEW`** | **掛起** outer，開新交易 | ✅ outer 可以 catch 並繼續 commit | 🔴 **inner 已經 commit，不會回滾** |
| **`NESTED`** | 建立 **savepoint** | ✅ outer catch 後只回到 savepoint | 🔴 一起 rollback |
| **`SUPPORTS`** | 加入同一個交易 | 同 `REQUIRED` | 同 `REQUIRED` |
| **`MANDATORY`** | 加入同一個交易 | 同 `REQUIRED` | 同 `REQUIRED` |
| **`NOT_SUPPORTED`** | 掛起 outer，**不用交易** | ⚠️ inner 的寫入**已經生效**（autoCommit） | ⚠️ 同左，不會回滾 |
| **`NEVER`** | 🔴 直接拋例外 | — | — |

**三個必須記住的行**：

> **① `REQUIRES_NEW` 的兩個方向不對稱。**
> inner 失敗 outer 可以救；**outer 失敗 inner 救不回來。**
> 這正是「已經退款但訂單沒取消」這類事故的形狀。
>
> **② `NESTED` 兩個方向都跟著 outer。**
> savepoint 只是「部分回滾」的能力，它仍然在 outer 的交易裡。
>
> **③ `REQUIRED` 的 inner 失敗，即使 outer `catch` 了也救不回來**（2.8）。

### 2.3.3 `REQUIRED`：預設值，以及它真正的意思

```java
@Transactional                                  // = REQUIRED
public Order create(CreateOrderCommand cmd) {
    var ctx = loader.load(cmd);                 // loader 沒有 @Transactional
    orders.save(order);
    audit.record(...);                          // audit 有 @Transactional（REQUIRED）
}
```

⚠️ **`audit.record()` 上的 `@Transactional` 在這裡「什麼都沒做」。**

它加入了外面的交易 —— 不開新連線、不 setAutoCommit、不 commit。
`TransactionInterceptor` 只是包了一層，然後直接呼叫目標方法。

**這是對的，而且它是 `REQUIRED` 存在的全部理由：**

> **同一段程式碼，被「有交易的地方」呼叫時加入那個交易，
> 被「沒有交易的地方」呼叫時自己開一個。**

```java
// 入口 1：從 create() 呼叫 → 加入 create 的交易 → 訂單回滾時稽核也回滾 ✅
// 入口 2：從一個排程直接呼叫 audit.record(...) → 自己開一個交易 ✅
```

⚠️ **但它有一個很容易踩的陷阱**（01 章 1.2.5 提過一次）：

```java
// 🔴 中間層加了 @Transactional，但它是「被呼叫的」而不是「入口」
@Component
public class OrderDataLoader {
    @Transactional                 // ← 加了它，看起來很「安全」
    public OrderContext load(CreateOrderCommand cmd) { … }
}
```

**四個具體壞處：**

| 壞處 | 說明 |
|---|---|
| **交易邊界變得不可見** | 讀 `create()` 看不出「交易從哪裡開始」——可能是 `create` 也可能是 `load` |
| **它會被誤用成「入口」** | 有人直接呼叫 `loader.load(...)` 而不知道那不是一個 use case |
| **ArchUnit 規則被破壞** | 00 章 0.11.2 的 `transactional只在application層` 只允許 application 套件 |
| ⚠️ **它讓「內層失敗污染外層」變得更難追** | 2.8 |

> 📌 **shop-service 的規則**（01 章 1.5.3 的另一半）：
> **`@Transactional` 只加在「一個 use case 的入口」上。
> 被編排的元件（loader、factory、calculator、mapper）一律不加。**

### 2.3.4 `REQUIRES_NEW`：獨立交易與它的三個代價

```java
@Transactional(propagation = Propagation.REQUIRES_NEW)
public void cancelInNewTransaction(String orderId, Instant now) { … }
```

**它的正當用途只有三種：**

| 用途 | 例子 |
|---|---|
| **① 「不管主流程成不成功，這件事都要留下來」** | 稽核失敗紀錄、金流嘗試紀錄（00 章練習 4 的第 ① 步） |
| **② 批次裡「一筆一個交易」** | `OrderExpirationJob`（01 章 1.9.3）—— 一筆失敗不影響其他筆 |
| **③ `AFTER_COMMIT` 的 listener 要寫資料庫** | 2.12.3 —— 那時候已經沒有交易可以加入 |

**而它的三個代價，每一個都是真實的事故來源：**

**代價 ①：同時佔用兩條連線 🔴🔴**

```
outer 交易   ─────────────────────────────────────────  連線 A（被掛起，但沒歸還！）
                    inner 交易  ──────────                連線 B
```

⚠️ **「掛起」不等於「歸還」。** 外層的 `ConnectionHolder` 只是從 ThreadLocal 被移到
`SuspendedResourcesHolder`，**那條連線仍然被獨佔**。

**所以：**

> **每一層 `REQUIRES_NEW` 都讓「一個請求佔用的連線數 +1」。**

**這會造成一種特別難查的死結：**

```
連線池大小 = 10
10 個請求同時進入 outer（各佔 1 條）→ 池子空了
10 個請求同時要進入 inner（REQUIRES_NEW，需要第 11 條）→ 全部等待
→ 30 秒後全部 connection-timeout
→ 而監控上看到的是「資料庫很閒，但應用完全卡住」
```

⚠️ **這是一個「自己把自己鎖死」的死結** —— 沒有任何外部因素，
只要併發量剛好等於連線池大小就會發生。

> 📌 **實務規則**：
> **連線池大小要 ≥ `最大併發請求數 × (1 + REQUIRES_NEW 的巢狀層數)`。**
> 而更好的做法是**讓那個層數是 0 或 1**。

**代價 ②：兩個交易看不到彼此未 commit 的資料**

```java
@Transactional
public void outer() {
    orders.save(order);                      // 還沒 commit
    inner.doSomething(order.id());           // REQUIRES_NEW
}

@Transactional(propagation = REQUIRES_NEW)
public void doSomething(String orderId) {
    Order o = orders.findById(orderId)       // 🔴 找不到！
            .orElseThrow(...);               //    外層還沒 commit
}
```

⚠️ **這在 `READ_COMMITTED` 與 `REPEATABLE_READ` 下都會發生。**
症狀是「明明剛存進去卻查不到」，而且**只在走 `REQUIRES_NEW` 那條路徑時發生**。

👉 **正解**：把需要的資料**當參數傳進去**，不要讓內層自己查。
（這與 00 章 0.5.5「把物件當協作者傳進去」是同一件事。）

**代價 ③：更容易死鎖**

外層鎖了 `order` 那一列，內層 `REQUIRES_NEW` 也要鎖同一列 →
**內層等外層，而外層在等內層返回** → **自己等自己**，直到 `innodb_lock_wait_timeout`。

⚠️ **注意 MySQL 的死鎖偵測救不了這一種** ——
因為在資料庫看來這是兩個獨立的交易，只是其中一個一直不動作。
它只會在 50 秒後回 `Lock wait timeout exceeded`。

```java
// 🔴 這段程式碼會卡 50 秒然後失敗，而且原因非常難看出來
@Transactional
public void outer(String orderId) {
    Order o = orders.findByIdForUpdate(orderId);   // ★ 鎖住這一列
    inner.audit(orderId);                          // REQUIRES_NEW
}

@Transactional(propagation = REQUIRES_NEW)
public void audit(String orderId) {
    orders.findByIdForUpdate(orderId);             // 🔴 等外層釋放鎖 → 永遠等不到
}
```

### 2.3.5 `NESTED`：savepoint

```java
@Transactional
public void outer() {
    orders.save(a);
    try {
        inner.risky();          // NESTED
    } catch (Exception e) {
        // ✅ 只回到 savepoint，a 還在，交易繼續
        log.warn("risky 失敗，略過", e);
    }
    orders.save(b);
}                                // ← a 與 b 一起 commit
```

**它看起來是 `REQUIRES_NEW` 的完美替代品**（不用第二條連線、看得到外層的資料）。

⚠️ **但有四個「但是」：**

| 但是 | 說明 |
|---|---|
| **`JpaTransactionManager` 預設不支援** | `AbstractPlatformTransactionManager.nestedTransactionAllowed` 預設 `false`，而 `DataSourceTransactionManager` 在建構子開啟它、`JpaTransactionManager` **沒有** → 拋 `NestedTransactionNotSupportedException` |
| **savepoint 不會釋放鎖** | 回到 savepoint 之後，那些列**仍然被鎖著**直到外層 commit |
| **它不是「獨立交易」** | 外層 rollback 時，inner 已經做的事一樣消失 —— 所以它**不能**取代用途 ①（一定要留下來的紀錄） |
| **很少人懂它** | ⚠️ 這是一個真實的維護成本：一段用了 `NESTED` 的程式碼，下一個人會不敢改 |

> 📌 **shop-service 的立場**：
> **不用 `NESTED`。**
> 需要「部分失敗可以繼續」時，把那件事**移出交易**（事件）或**移到迴圈外**
> （2.9.5 的長交易拆法）。
>
> ⚠️ 而如果你真的要用它，**先寫一個測試證明你的 transaction manager 支援它** ——
> 因為 08 站換成 JPA 時它會突然開始拋例外。

```java
@Test
void 這個環境支援NESTED嗎() {
    // ★ 一個「知識驗證」測試 —— 它記錄的是「我們對環境的假設」
    assertThatCode(() -> nestedService.outerWithNestedInner())
            .as("換成 JpaTransactionManager 之後這個測試會失敗，那正是重點")
            .doesNotThrowAnyException();
}
```

### 2.3.6 另外四種

**`SUPPORTS`：有就用，沒有就算了**

```java
@Transactional(propagation = Propagation.SUPPORTS, readOnly = true)
public OrderDetailView findById(String orderId) { … }
```

⚠️ **它的實際效果比你想的弱**：沒有外層交易時，它**不會**開交易，
於是「同一個方法裡的三次查詢」可能讀到三個不同的快照。

👉 **shop-service 不用它。** 讀取一律用 `@Transactional(readOnly = true)`（`REQUIRED`）——
理由是 2.5.2 的「讀寫分離路由」需要一個真的交易才能判斷。

**`MANDATORY`：宣告「我必須被包在交易裡」★**

```java
/**
 * ★★ 這是 MANDATORY 最好的用途：<b>讓「忘記包交易」在執行期立刻失敗</b>。
 *
 * <p>{@code StockPort.tryReserve} 的原子性依賴「它與訂單寫入在同一個交易裡」——
 * 沒有交易的話，扣了庫存但訂單建立失敗，庫存<b>不會</b>還回去。
 *
 * <p>⚠️ 而那個失敗是<b>靜默的</b>：程式跑完，資料錯了，沒有例外。
 * 加上 {@code MANDATORY} 之後，它變成一個立刻可見的
 * {@code IllegalTransactionStateException}。
 */
@Transactional(propagation = Propagation.MANDATORY)
public boolean tryReserve(String productId, int quantity) { … }
```

> 📌 **`MANDATORY` 是這七個裡面最被低估的一個。**
> 它把「這段程式碼有一個隱含的前置條件」變成**可執行的宣告**。
> shop-service 把它加在 `StockPort` 與 `CouponRepository.tryConsume` 的實作上。

⚠️ **但它有一個代價**：那些方法**再也不能單獨被呼叫**（例如在一個修資料的腳本裡）。
如果那是一個真實需求，就要提供一個 `REQUIRED` 的包裝方法。

**`NOT_SUPPORTED`：掛起交易**

⚠️ **幾乎不要用。** 它的寫入會直接 autoCommit 生效，
而「一半在交易裡一半不在」是最難推理的狀態。

唯一合理的用途：**在一個長交易裡讀一份不需要一致性的參考資料**，
而那通常代表交易太長（2.9.5）。

**`NEVER`：宣告「我不可以在交易裡」**

⚠️ 用途很窄，但有一個真實的：**呼叫外部 API 的那個方法**。

```java
/**
 * ★ 用 NEVER 讓 00 章 0.3.2 事故 1 在<b>開發時</b>就爆炸。
 *
 * <p>「在交易裡呼叫金流」是一個一定要避免的錯，
 * 而 {@code NEVER} 讓它從「上線後拖垮全站」變成「本機跑測試就紅燈」。
 *
 * <p>⚠️ 代價：它會讓「我只是想在交易裡順手打一下 API」變得不可能 ——
 * <b>而那正是重點。</b>
 */
@Transactional(propagation = Propagation.NEVER)
public ChargeResult charge(ChargeRequest request) { … }
```

> ⚠️ **但要注意 `NEVER` 只擋得住「Spring 管理的交易」。**
> 如果有人自己 `dataSource.getConnection()` 開交易，它看不到。
> 2.13 會給一個更強的檢查。

### 2.3.7 shop-service 的傳播行為總表

| 方法 | 傳播 | 理由 |
|---|---|---|
| `OrderApplicationService.create` | `REQUIRED`（預設） | use case 入口 |
| `OrderApplicationService.cancel` | `REQUIRED` | 同上 |
| `OrderQueryService.*` | `REQUIRED` + `readOnly` | 讀寫分離路由需要真交易（2.5.2） |
| `OrderDataLoader.load` | **無註解** | 它是被編排的元件（2.3.3） |
| `OrderFactory.create` | **無註解** | 純運算 |
| `OrderCancellationExecutor.cancelInNewTransaction` | **`REQUIRES_NEW`** | 用途 ②：批次一筆一個交易 |
| `OrderPaymentService.recordAttempt` | **`REQUIRES_NEW`** | 用途 ①：不管付款成不成功都要留紀錄 |
| `StockPort.tryReserve`（實作） | **`MANDATORY`** | 它的原子性依賴外層交易 |
| `CouponRepository.tryConsume`（實作） | **`MANDATORY`** | 同上 |
| `PaymentGateway.charge`（實作） | **`NEVER`** | 交易裡不可以呼叫外部系統 |
| `*NotificationListener.on*`（`AFTER_COMMIT`） | **`REQUIRES_NEW`** | 用途 ③（2.12.3） |

⚠️ **注意這張表裡「無註解」的兩列。**
它們不是漏了 —— **「不標註」本身就是一個決定**，
而 2.3.3 解釋了為什麼那個決定是對的。

### 2.3.8 一個可執行的傳播行為實驗 ★

**讀十遍不如跑一次。** 這組測試把 2.3.2 的矩陣變成可執行的。

```java
package example.shop.transaction;

/**
 * 傳播行為的行為驗證。
 *
 * <p>★★ 它不是「測試 Spring」—— 它是<b>把我們對 Spring 的假設寫下來</b>。
 * 升級版本、換 transaction manager 時，這組測試會告訴你哪些假設變了。
 */
class PropagationBehaviorTest extends MySqlIntegrationTestBase {

    @Autowired PropagationFixture fixture;      // ★ 見下方
    @Autowired JdbcTemplate jdbc;
    @Autowired DatabaseCleaner cleaner;

    @AfterEach void clean() { cleaner.clean(); }

    private long rows(String tag) {
        return jdbc.queryForObject(
                "SELECT COUNT(*) FROM propagation_probe WHERE tag = ?", Long.class, tag);
    }

    // ── REQUIRED ────────────────────────────────────────

    @Test
    void REQUIRED_內層失敗_外層一起回滾() {
        assertThatThrownBy(() -> fixture.outerRequired_innerRequiredThrows("t1"))
                .isInstanceOf(IllegalStateException.class);

        assertThat(rows("t1")).as("外層寫的那一筆也不見了").isZero();
    }

    @Test
    void REQUIRED_內層失敗但外層catch住_整個交易仍然回滾() {
        // ★★ 這是本節最重要的一個測試 —— 它證明「catch 救不了」（2.8）
        assertThatThrownBy(() -> fixture.outerRequired_catchesInnerRequired("t2"))
                .isInstanceOf(UnexpectedRollbackException.class)
                .hasMessageContaining("marked as rollback-only");

        assertThat(rows("t2")).isZero();
    }

    // ── REQUIRES_NEW ────────────────────────────────────

    @Test
    void REQUIRES_NEW_內層失敗_外層catch住之後可以繼續commit() {
        fixture.outerRequired_catchesInnerRequiresNew("t3");

        assertThat(rows("t3"))
                .as("外層那一筆留下來了，內層那一筆沒有")
                .isEqualTo(1);
    }

    @Test
    void REQUIRES_NEW_外層失敗_內層已經commit的資料留下來() {
        // ★★ 這是 REQUIRES_NEW 最危險的一面（2.3.2 觀察 ①）
        assertThatThrownBy(() -> fixture.outerRequiredThrows_afterInnerRequiresNew("t4"))
                .isInstanceOf(IllegalStateException.class);

        assertThat(rows("t4"))
                .as("內層的資料回不來 —— 這正是「退款成功但訂單沒取消」的形狀")
                .isEqualTo(1);
    }

    @Test
    void REQUIRES_NEW_看不到外層還沒commit的資料() {
        // ★ 2.3.4 代價 ②
        assertThat(fixture.outerWritesThenInnerRequiresNewReads("t5"))
                .as("內層讀不到外層剛寫的那一筆")
                .isZero();
    }

    // ── MANDATORY / NEVER ───────────────────────────────

    @Test
    void MANDATORY_沒有外層交易時立刻失敗() {
        assertThatThrownBy(() -> fixture.mandatoryAlone("t6"))
                .isInstanceOf(IllegalTransactionStateException.class)
                .hasMessageContaining("no existing transaction found");
    }

    @Test
    void NEVER_在交易裡呼叫時立刻失敗() {
        assertThatThrownBy(() -> fixture.outerRequired_innerNever("t7"))
                .isInstanceOf(IllegalTransactionStateException.class)
                .hasMessageContaining("existing transaction found");
    }

    // ── 連線佔用 ────────────────────────────────────────

    @Test
    void REQUIRES_NEW_同時佔用兩條連線() {
        // ★★ 2.3.4 代價 ① —— 池子只有 5 條（MySqlIntegrationTestBase）
        int active = fixture.activeConnectionsInsideRequiresNew("t8");
        assertThat(active)
                .as("外層 1 條 + 內層 1 條")
                .isEqualTo(2);
    }
}
```

**對應的 fixture**（每個方法都是「一個矩陣格子」）：

```java
package example.shop.transaction;

/**
 * ★ 它必須是一個獨立的 bean，而且外層與內層必須是<b>兩個</b> bean ——
 * 否則自呼叫會繞過代理（2.7.1），整組測試會測到錯的東西。
 *
 * <p>⚠️ 這一點本身就是一個教訓：<b>連「測試傳播行為」都會踩到自呼叫。</b>
 */
@Component
public class PropagationFixture {

    private final PropagationInner inner;
    private final JdbcTemplate jdbc;
    private final HikariDataSource dataSource;

    // 建構子略

    private void write(String tag, String who) {
        jdbc.update("INSERT INTO propagation_probe(tag, who) VALUES (?, ?)", tag, who);
    }

    @Transactional
    public void outerRequired_innerRequiredThrows(String tag) {
        write(tag, "outer");
        inner.requiredThrows(tag);
    }

    @Transactional
    public void outerRequired_catchesInnerRequired(String tag) {
        write(tag, "outer");
        try {
            inner.requiredThrows(tag);
        } catch (IllegalStateException e) {
            // ⚠️ catch 了，但交易已經被標記 rollback-only（2.8）
        }
    }

    @Transactional
    public void outerRequired_catchesInnerRequiresNew(String tag) {
        write(tag, "outer");
        try {
            inner.requiresNewThrows(tag);
        } catch (IllegalStateException e) {
            // ✅ 這一次 catch 有效
        }
    }

    @Transactional
    public void outerRequiredThrows_afterInnerRequiresNew(String tag) {
        inner.requiresNewSucceeds(tag);      // ★ 它自己 commit 了
        throw new IllegalStateException("外層失敗");
    }

    @Transactional
    public long outerWritesThenInnerRequiresNewReads(String tag) {
        write(tag, "outer");                 // 還沒 commit
        return inner.requiresNewCount(tag);
    }

    public void mandatoryAlone(String tag) {  // ★ 沒有 @Transactional
        inner.mandatory(tag);
    }

    @Transactional
    public void outerRequired_innerNever(String tag) {
        inner.never(tag);
    }

    @Transactional
    public int activeConnectionsInsideRequiresNew(String tag) {
        write(tag, "outer");
        return inner.requiresNewActiveConnections();
    }
}
```

```java
@Component
public class PropagationInner {

    private final JdbcTemplate jdbc;
    private final HikariDataSource dataSource;

    @Transactional
    public void requiredThrows(String tag) {
        jdbc.update("INSERT INTO propagation_probe(tag, who) VALUES (?, 'inner')", tag);
        throw new IllegalStateException("inner 失敗");
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void requiresNewThrows(String tag) {
        jdbc.update("INSERT INTO propagation_probe(tag, who) VALUES (?, 'inner')", tag);
        throw new IllegalStateException("inner 失敗");
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void requiresNewSucceeds(String tag) {
        jdbc.update("INSERT INTO propagation_probe(tag, who) VALUES (?, 'inner')", tag);
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public long requiresNewCount(String tag) {
        return jdbc.queryForObject(
                "SELECT COUNT(*) FROM propagation_probe WHERE tag = ?", Long.class, tag);
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public void mandatory(String tag) { /* 走不到 */ }

    @Transactional(propagation = Propagation.NEVER)
    public void never(String tag) { /* 走不到 */ }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public int requiresNewActiveConnections() {
        // ★ HikariCP 的 MXBean 直接告訴你「現在有幾條連線被借走」
        return dataSource.getHikariPoolMXBean().getActiveConnections();
    }
}
```

⚠️ **`requiresNewCount` 這個方法值得單獨看一眼。**
它是一個**唯讀**操作，卻用了 `REQUIRES_NEW` ——
在正式程式碼裡那是錯的（浪費一條連線），
但在這裡它是**唯一能證明「內層看不到外層」的方法**。

> 📌 **測試程式碼可以做正式碼不該做的事，前提是「它證明的東西值得」。**
> 而這個測試證明的是 2.3.4 代價 ②，那是一個真實的事故來源。

---
## 2.4 隔離級別

### 2.4.1 三種讀異常

**先講問題，再講級別。**

| 異常 | 意思 | 一句話的例子 |
|---|---|---|
| **髒讀**（dirty read） | 讀到別人**還沒 commit** 的資料 | 你看到餘額 -500，但那個交易接著 rollback 了 |
| **不可重複讀**（non-repeatable read） | 同一筆資料，讀兩次結果不同 | 你算折扣時讀到單價 100，算運費時再讀變成 90 |
| **幻讀**（phantom read） | 同一個**條件**查兩次，筆數不同 | 你確認「這個客戶今天沒有訂單」，寫入時卻撞上 UNIQUE |

⚠️ **不可重複讀 vs 幻讀的差別，是「同一列變了」與「多了/少了一列」。**
這個差別在 MySQL 上很重要，因為兩者用完全不同的機制解決（2.4.3）。

### 2.4.2 四種隔離級別

| 級別 | 髒讀 | 不可重複讀 | 幻讀 | 代價 |
|---|---|---|---|---|
| `READ_UNCOMMITTED` | ⚠️ 可能 | ⚠️ 可能 | ⚠️ 可能 | 最快，但幾乎沒有正確性保證 |
| **`READ_COMMITTED`** | ✅ 防 | ⚠️ 可能 | ⚠️ 可能 | PostgreSQL / Oracle / SQL Server 的預設 |
| **`REPEATABLE_READ`** | ✅ | ✅ | ⚠️ 標準說可能，**MySQL 大致上防住了**（2.4.3） | **MySQL 的預設** |
| `SERIALIZABLE` | ✅ | ✅ | ✅ | 大量鎖 / 序列化，吞吐量崩掉 |

```java
@Transactional(isolation = Isolation.READ_COMMITTED)
public void doIt() { … }
```

⚠️ **`Isolation.DEFAULT`（預設值）的意思是「用資料庫的預設」** ——
所以在 MySQL 上，你的每一個 `@Transactional` 實際上都是 `REPEATABLE_READ`。

### 2.4.3 MySQL 的 `REPEATABLE READ` 為什麼不完全等於標準定義 ★

**這是很多人（包括寫過幾年 Java 的）沒搞清楚的一段。**

MySQL InnoDB 用**兩套機制**，而它們對「同一個 SELECT」的行為不同：

```
① 快照讀（consistent read）—— 普通的 SELECT
   讀的是「這個交易第一次 SELECT 時的快照」（MVCC，走 undo log）
   ✅ 不加任何鎖
   ✅ 因此不可重複讀 與 幻讀 都不會發生
   ⚠️ 但它讀到的可能是「舊的」資料

② 當前讀（locking read）—— SELECT ... FOR UPDATE / LOCK IN SHARE MODE
                          以及所有 UPDATE / DELETE / INSERT
   讀的是「最新已 commit 的資料」，並加鎖
   ✅ 用 next-key lock（行鎖 + 間隙鎖）防止範圍內插入 → 防幻讀
```

⚠️ **所以「MySQL 的 RR 有沒有幻讀」這個問題的答案是：**

> **快照讀不會有；當前讀靠間隙鎖擋住了大部分；
> 但「快照讀 + 當前寫」混用時仍然會出現一種很奇怪的情況。**

**那個情況長這樣**（值得知道，因為它會讓你懷疑人生）：

```
交易 A                                   交易 B
────────────────────────────────────────────────────────────────
SELECT * FROM orders WHERE id = 1;
→ 空（快照讀，什麼都沒有）
                                         INSERT INTO orders(id) VALUES (1);
                                         COMMIT;
SELECT * FROM orders WHERE id = 1;
→ 仍然是空 ✅（快照沒變，符合 RR）

UPDATE orders SET note = 'x' WHERE id = 1;
→ 🔴 影響 1 列！（當前讀，看得到 B 的資料）

SELECT * FROM orders WHERE id = 1;
→ 🔴 現在有資料了（自己改過的列會出現在快照裡）
```

**同一個交易裡，「查不到」與「改到了」同時成立。**

> 📌 **實務上的意義**：
> **不要用「SELECT 查不到」來推論「可以安全 INSERT」。**
> 那正是 00 章 0.8.4 的結論在隔離級別上的版本 ——
> **唯一可靠的做法是 UNIQUE 約束或當前讀（`FOR UPDATE`）。**

**另一個 MySQL 特有的行為，會讓人以為「RR 壞掉了」：**

```
UPDATE stock SET available = available - 1 WHERE product_id = 'P-1' AND available >= 1;
```

在 RR 下，這個 UPDATE 是**當前讀** —— 它讀到的是**最新**的 `available`，
而不是交易開始時的快照。

⚠️ **這是件好事，也是 00 章 0.8.3 那個原子 SQL 能work 的原因。**
如果它讀快照，兩個交易就會同時看到 `available = 1` 而都成功。

> **記住這條規則就夠了**：
> **`UPDATE ... WHERE` 的條件永遠用最新資料判斷，不用快照。**

### 2.4.4 打開交易日誌：怎麼讀 TRACE 輸出 ★

00 章 0.11.3 給了兩行設定，這裡示範怎麼讀它們的輸出。

```yaml
logging:
  level:
    org.springframework.transaction.interceptor: TRACE
    org.springframework.jdbc.datasource.DataSourceTransactionManager: DEBUG
    # ★ JPA 時改成這個
    org.springframework.orm.jpa.JpaTransactionManager: DEBUG
    # ★ 想看實際 SQL 再加這個（⚠️ 生產環境不要開）
    org.springframework.jdbc.core.JdbcTemplate: DEBUG
```

**一個正常的 `create()` 會印出：**

```
TRACE ...TransactionInterceptor  : Getting transaction for
                                   [example.shop.order.application.OrderApplicationService.create]
DEBUG ...DataSourceTransactionManager : Creating new transaction with name
                                   [...OrderApplicationService.create]:
                                   PROPAGATION_REQUIRED,ISOLATION_DEFAULT      ← ①
DEBUG ...DataSourceTransactionManager : Acquired Connection
                                   [HikariProxyConnection@123 wrapping com.mysql...]
                                   for JDBC transaction                        ← ②
DEBUG ...DataSourceTransactionManager : Switching JDBC Connection
                                   [...] to manual commit                      ← ③
DEBUG ...JdbcTemplate            : Executing prepared SQL update
TRACE ...TransactionInterceptor  : Completing transaction for [...create]      ← ④
DEBUG ...DataSourceTransactionManager : Initiating transaction commit          ← ⑤
DEBUG ...DataSourceTransactionManager : Releasing JDBC Connection [...] after transaction ← ⑥
```

**六個關鍵字，各自對應 2.2.2 的哪一步：**

| 日誌 | 2.2.2 的步驟 | 沒看到它代表什麼 |
|---|---|---|
| ① `Creating new transaction` | ⑤⑥ | 🔴 **交易根本沒開**（2.7 的失效） |
| ② `Acquired Connection` | ⑥ | 同上 |
| ③ `Switching ... to manual commit` | ⑦ | 同上 |
| ④ `Completing transaction` | ⑩ | — |
| ⑤ `Initiating transaction commit` | ⑫ | 看到 `rollback` 就是回滾了 |
| ⑥ `Releasing JDBC Connection` | ⑬ | 🔴 沒看到 = **連線洩漏** |

**四種「不正常」的輸出，各自的意思：**

```
① 完全沒有 TransactionInterceptor 的日誌
   → 🔴 代理沒攔到（2.7.1 自呼叫 / 2.7.3 new 出來的物件）

② TRACE ...TransactionInterceptor : No need to create transaction for [...]
   → ⚠️ 讀到的交易屬性是 null → 沒有 @Transactional，或方法不是 public（2.7.2）

③ DEBUG ...: Participating in existing transaction
   → ✅ 這是 REQUIRED 加入外層（2.3.3）—— 正常

④ DEBUG ...: Suspending current transaction, creating new transaction with name [...]
   → ⚠️ REQUIRES_NEW —— 確認這是你要的，並記得它佔第二條連線（2.3.4）

⑤ DEBUG ...: Participating transaction failed - marking existing transaction as rollback-only
   → 🔴🔴 2.8 的那個問題，接下來一定會 UnexpectedRollbackException
```

⚠️ **② 那一行是最有價值的一行。**
`No need to create transaction for [...]` 明確告訴你
「**Spring 看過這個方法，決定不開交易**」——
而那幾乎總是 2.7.2 的三個修飾詞問題。

### 2.4.5 什麼時候該調隔離級別

**幾乎不該。**

| 想解決的問題 | 調隔離級別？ | 正確做法 |
|---|---|---|
| 超賣 | ❌ 調到 `SERIALIZABLE` 也很慢 | 原子 UPDATE（2.11.7） |
| 讀到舊資料 | ❌ | 需要最新資料就用 `FOR UPDATE`（2.11.3） |
| 報表跑到一半資料變了 | ⚠️ **這是唯一合理的一種** | 但更好的做法是查 replica 或用時間點快照 |
| 「保險起見調高一點」 | 🔴 **最糟的理由** | — |

⚠️ **調低（`READ_COMMITTED`）反而比調高常見**，因為它在 MySQL 上：

| 好處 | 說明 |
|---|---|
| **鎖範圍小很多** | RR 的間隙鎖會鎖住「不存在的列」，在高併發插入時死鎖率明顯較高 |
| 與 PostgreSQL / Oracle 一致 | 團隊同時維護多種資料庫時少一個心智負擔 |
| binlog 的 `ROW` 格式下是安全的 | ⚠️ 早期 `STATEMENT` 格式下 RC 會有複製不一致的問題，那是 RR 成為預設的歷史原因 |

> 📌 **shop-service 的決定**：**維持 MySQL 預設的 `REPEATABLE_READ`，
> 但所有需要「最新資料」的地方明確用當前讀（`FOR UPDATE` 或原子 UPDATE）。**
>
> 理由：**「隔離級別」是一個全域的鈍器，「當前讀」是一個局部的、看得見的宣告。**
> 而看得見的東西比較不會出錯。

---

## 2.5 `@Transactional` 的全部參數

```java
@Transactional(
    transactionManager = "orderTransactionManager",   // 多資料源時（2.5.4）
    propagation        = Propagation.REQUIRED,        // 2.3
    isolation          = Isolation.DEFAULT,           // 2.4
    timeout            = 10,                          // 秒。⚠️ 語意見 2.5.3
    timeoutString      = "${shop.tx.timeout:10}",     // ★ Spring 5.3+，可用 SpEL
    readOnly           = false,                       // 2.5.2
    rollbackFor        = { },                         // 2.6
    rollbackForClassName = { },
    noRollbackFor      = { },
    noRollbackForClassName = { },
    label              = { "slow" }                   // ★ Spring 6.0+，見下方
)
```

⚠️ **`label` 是 Spring 6.0 新增而幾乎沒有人用的一個**：
它讓自訂的 `TransactionAttribute` 消費者可以依標籤做事
（例如「標了 `slow` 的交易路由到另一個資料源」）。
**shop-service 不用它**，但知道它存在能省下「自己發明一個註解」的時間。

### 2.5.1 參數的優先順序

**方法上的註解 > 類別上的註解 > 介面 / 父類別上的註解。**

⚠️ **而「介面上的 `@Transactional`」有一個真實的陷阱**：

```java
public interface OrderService {
    @Transactional                 // ← 加在介面上
    Order create(CreateOrderCommand cmd);
}
```

> **它在 CGLIB 代理下「不保證」生效。**
>
> Spring 官方文件明確建議「只把 `@Transactional` 加在具體類別與其方法上」——
> 因為以類別為基礎的代理只認得類別上的註解，
> 而介面上的註解要靠 `AnnotationTransactionAttributeSource` 沿著型別階層找。
> 它**通常**找得到，但一旦加上其他 AOP 或某些 proxy 設定就會失效。

👉 **shop-service 的規則**：`@Transactional` **只加在實作類別的 public 方法上**。
01 章 1.3.5 決定保留 `OrderService` 介面，**而那個介面上一個 `@Transactional` 都沒有**。

### 2.5.2 `readOnly = true` 的三個非效能作用 + 量化 ★

00 章 0.10.8 列了三個作用，這裡把機制與數字補上。

**作用 ①：告訴驅動與資料庫**

```java
// DataSourceTransactionManager.doBegin()
if (definition.isReadOnly()) {
    con.setReadOnly(true);
}
```

MySQL Connector/J 收到之後會送 `SET SESSION TRANSACTION READ ONLY`
（`readOnlyPropagatesToServer` 預設為 true）。

**InnoDB 對唯讀交易的最佳化**：不配置交易 ID、不進 `trx_sys` 清單。
在高併發的純讀工作負載上，這個最佳化是**可量測的**，但幅度取決於工作負載
—— 別期待「加了就快兩倍」。

**作用 ②：Hibernate 的 `FlushMode.MANUAL`（只有 JPA 才有）**

```java
// JpaTransactionManager.doBegin() 的效果
session.setHibernateFlushMode(FlushMode.MANUAL);
```

**這個作用比 ① 大得多**：

| | `readOnly = false` | `readOnly = true` |
|---|---|---|
| 查出 1,000 個 Entity | 全部進 persistence context | 一樣 |
| commit 時 | 🔴 **對 1,000 個 Entity 逐一做 dirty checking**（比對每個欄位的快照） | ✅ 不 flush，直接結束 |
| 「不小心改了一個欄位」 | 🔴 **會被寫回資料庫** | ✅ 不會（⚠️ 但**靜默**，見下方警告） |

⚠️⚠️ **不要把「唯讀交易保護我不會誤寫」當成安全機制。**

```java
@Transactional(readOnly = true)
public OrderDetailView findById(String id) {
    Order order = orders.findById(id).orElseThrow();
    order.markDelivered(Instant.now());     // 🔴 改了，但不會被寫回
    return mapper.toView(order);            //    也不會有任何錯誤
}
```

**這是最糟的一種 bug**：程式碼「看起來做了事」，實際上什麼都沒發生，
而且**沒有任何訊號**。

👉 真正的保護是 00 章 0.9.2 的「**Domain 沒有 public setter**」與
`OrderQueryService` **根本不回傳聚合**（回傳投影，01 章 1.2.3）。

**作用 ③：讀寫分離的路由依據**

```java
/**
 * ★ 依「當前交易是不是唯讀」決定連 primary 還是 replica。
 *
 * <p>⚠️ 它必須搭配 {@code LazyConnectionDataSourceProxy}：
 * 因為 {@code AbstractRoutingDataSource} 的
 * {@code determineCurrentLookupKey()} 是在<b>取得連線的當下</b>被呼叫的，
 * 而 {@code DataSourceTransactionManager} 是
 * <b>先取連線、再設 readOnly</b>（2.2.2 的 ⑥ 在 ⑦ 之前）——
 * <b>所以不包 Lazy proxy 的話，路由永遠讀到 {@code false}，全部打到 primary。</b>
 *
 * <p>👉 這是讀寫分離最經典的一個坑，而它的症狀是
 * 「設定看起來完全正確，但 replica 的 QPS 是 0」。
 */
public class ReadWriteRoutingDataSource extends AbstractRoutingDataSource {

    @Override
    protected Object determineCurrentLookupKey() {
        return TransactionSynchronizationManager.isCurrentTransactionReadOnly()
                ? "replica" : "primary";
    }
}

@Bean
@Primary
public DataSource dataSource(ReadWriteRoutingDataSource routing) {
    // ★★ 這一層不可以省
    return new LazyConnectionDataSourceProxy(routing);
}
```

> 📌 **06 站（Repository）會完整實作讀寫分離。**
> 這裡先講，是因為**它是「為什麼查詢方法一定要標 `readOnly`」最實際的理由** ——
> 沒有標的話，那個查詢永遠打 primary，而讀寫分離就白做了。

### 2.5.3 `timeout` 不是「方法逾時」★

**這是本節最容易誤解的一個。**

```java
@Transactional(timeout = 5)
public void slow() {
    heavyComputationTakingTenSeconds();     // ⚠️ 不會被中斷
    jdbc.update("UPDATE ...");              // ← 到這裡才拋 TransactionTimedOutException
}
```

**機制**：Spring 把剩餘秒數透過 `DataSourceUtils.applyTimeout(...)`
設到每一個 `Statement.setQueryTimeout(...)` 上，
並在**取得連線 / 準備 statement 時**檢查是否已經超時。

**三個推論：**

| 推論 | 說明 |
|---|---|
| **純 Java 的運算不會被中斷** | 它只在「下一次碰資料庫」時才生效 |
| **一個很慢的 SQL 會被中斷** | ✅ `setQueryTimeout` 會讓驅動送 `KILL QUERY` |
| ⚠️ **交易裡的外部 API 呼叫完全不受它管** | 00 章 0.3.2 事故 1 的 30 秒**不會**被 `timeout = 10` 救到 |

> 📌 **所以 `timeout` 的正確定位是**：
> **「防止一個交易永遠佔著連線」的最後防線**，不是「效能保證」。
> 而 00 章 0.11.3 的 `spring.transaction.default-timeout: 10s`
> 給的正是這個防線。

⚠️ **它與 `leak-detection-threshold` 的關係**（00 章 0.11.3 的三個數字）：

```
transaction default-timeout   10s   ← 交易自己會失敗
leak-detection-threshold      15s   ← 15 秒還沒歸還 → 印 stack trace（但不中斷）
innodb_lock_wait_timeout      50s   ← 等鎖的上限（生產預設）

必須滿足：default-timeout < leak-detection < 「你能忍受的最長卡住時間」
```

⚠️ **而 `innodb_lock_wait_timeout` 比前兩個都大是刻意的**：
等鎖時 SQL 還沒開始執行，`setQueryTimeout` 對它**無效**——
所以「等鎖」這條路徑只能靠資料庫自己的逾時。

> 👉 **這代表 `default-timeout: 10s` 擋不住「等鎖 50 秒」。**
> 如果你的系統有長時間等鎖的風險，**要把 `innodb_lock_wait_timeout` 調小**
> （shop-service 的測試環境設 5 秒，生產建議 10～15 秒）。

### 2.5.4 多資料源與 `transactionManager`

```java
@Transactional(transactionManager = "reportingTransactionManager", readOnly = true)
public ReportData heavyReport(ReportQuery q) { … }
```

⚠️ **有兩個以上的 `PlatformTransactionManager` 時，一定要有一個 `@Primary`**，
否則所有沒指名的 `@Transactional` 會在啟動時失敗
（`NoUniqueBeanDefinitionException`）。

**而更重要的一件事：**

> 🔴 **兩個不同的 `transactionManager` 之間「沒有原子性」。**
>
> ```java
> @Transactional("mainTx")
> public void doIt() {
>     mainRepo.save(a);
>     reporting.save(b);      // ← 用另一個 DataSource → 不在這個交易裡
> }
> ```
> `a` 回滾時 `b` **不會**回滾。而這件事**沒有任何編譯期或執行期的警告**。

👉 **shop-service 只有一個資料源**（讀寫分離用的是同一個
`LazyConnectionDataSourceProxy` 底下的路由，仍然是一個 `DataSource` bean）。
需要跨資料源原子性時的正解在 06 章 6.9（outbox / Saga），不是 JTA（2.2.3）。

---
## 2.6 rollback 規則

### 2.6.1 預設規則

```
拋出 RuntimeException 或 Error   → rollback
拋出 checked Exception          → ⚠️ COMMIT（不是 rollback！）
正常返回                        → commit（除非被標記 rollback-only，2.8）
```

```java
@Transactional
public void doIt() throws IOException {
    orders.save(order);
    throw new IOException("寫檔失敗");    // 🔴 訂單被 commit 了
}
```

⚠️ **這是 Java 後端最常見的資料一致性事故來源之一**，
而它的可怕之處在於：**程式碼看起來完全正確**。

### 2.6.2 為什麼是這個預設

**歷史原因**：這條規則直接繼承自 EJB 的 CMT（容器管理交易）規範，
而 Spring 為了讓 EJB 的程式碼能平移過來保留了它。

**但它也有一個站得住腳的理由**，值得理解：

> **在 EJB 的世界觀裡，checked exception 代表「一個預期中的、
> 呼叫端應該處理的業務結果」，而 unchecked 代表「系統壞了」。**
>
> 「餘額不足」是一個預期中的結果 → 你可能想
> **保留已經寫入的「嘗試紀錄」然後回一個錯誤給使用者**。
> 「NPE」是系統壞了 → 什麼都不要留。

⚠️ **這個世界觀在現代 Java 已經站不住腳了**，因為：

| 理由 | 說明 |
|---|---|
| 幾乎所有人用 unchecked 表達業務錯誤 | 04-controller 3.5.2 的 `BusinessException extends RuntimeException` |
| checked exception 大多來自 **I/O 與函式庫**，而不是業務 | `IOException`、`SQLException`、`InterruptedException` |
| **Lambda 與 Stream 不接受 checked exception** | 於是它們被大量包成 unchecked |

> 📌 **所以現在這條規則的實際效果是**：
> **「函式庫拋出的 I/O 錯誤不會 rollback」** —— 而那幾乎總是錯的。

### 2.6.3 `rollbackFor` / `noRollbackFor`

```java
@Transactional(rollbackFor = Exception.class)          // ★ 全部都 rollback
@Transactional(noRollbackFor = InsufficientStockException.class)
```

**優先順序的規則（`RuleBasedTransactionAttribute`）：**

> **不是「先寫的贏」，而是「繼承階層上最接近的那一條贏」。**

```java
@Transactional(
    rollbackFor   = Exception.class,               // 深度：很遠
    noRollbackFor = BusinessException.class        // 深度：較近
)
public void doIt() {
    throw new InsufficientStockException(...);     // extends BusinessException
}
// → noRollbackFor 贏（BusinessException 離它比較近）→ commit
```

⚠️ **而「兩條規則距離相同」時的行為是未定義的** ——
不要寫出那種設定。

**一個實務上很有用的組合：**

```java
/**
 * ★ 「業務例外不 rollback」的正當用途：<b>把失敗也記下來</b>。
 *
 * <p>⚠️ 但它<b>非常危險</b>，因為「已經做了一半的寫入」會留下來。
 * 只有在「這個方法只寫一張紀錄表」時才可以這樣用。
 */
@Transactional(noRollbackFor = PaymentDeclinedException.class)
public void recordAndCharge(ChargeCommand cmd) {
    attempts.record(cmd);                      // ★ 這一筆要留下來
    ChargeResult r = gateway.charge(...);      // 🔴 而且這裡違反了 0.10.1
    if (r instanceof Declined d) {
        throw new PaymentDeclinedException(d.reason());
    }
}
```

⚠️ **上面這段是反例。** 正確做法是 `REQUIRES_NEW` 的兩段式（00 章練習 4 的答案）——
因為 `noRollbackFor` 讓「哪些寫入會留下」取決於**程式碼的執行順序**，
而那是最難維護的一種依賴。

> 📌 **判準**：
> **`noRollbackFor` 只在「這個交易裡只有一次寫入」時可以用。
> 有兩次以上就改用 `REQUIRES_NEW` 把它們分開。**

### 2.6.4 shop-service 的政策 ★

```
① 所有業務例外繼承 BusinessException extends RuntimeException
   → 預設規則就是對的，不需要 rollbackFor

② 需要包裝 checked exception 時，一律包成 unchecked 並帶 cause
   → catch (IOException e) { throw new UncheckedIOException(e); }

③ ⚠️ 唯一需要 rollbackFor 的情況：
   方法簽章上有 checked exception 而它代表「這件事失敗了」
   → 那時候先問「為什麼它是 checked 的」，通常答案是「不該是」
```

**用一個守門測試把政策釘住：**

```java
/**
 * ★★ 沒有任何 {@code @Transactional} 方法宣告 checked exception。
 *
 * <p>它抓的是 2.6.1 那個「靜默 commit」——
 * 而抓的方式是<b>讓那種簽章根本不存在</b>，
 * 而不是「記得每個都加 rollbackFor」。
 */
@ArchTest
static final ArchRule transactional方法不可宣告checked例外 =
        methods().that().areAnnotatedWith(Transactional.class)
                 .should(new ArchCondition<JavaMethod>("不宣告 checked exception") {
                     @Override
                     public void check(JavaMethod m, ConditionEvents events) {
                         m.getExceptionTypes().stream()
                          .filter(t -> !t.isAssignableTo(RuntimeException.class)
                                    && !t.isAssignableTo(Error.class))
                          .forEach(t -> events.add(SimpleConditionEvent.violated(m,
                                  "%s 宣告了 checked exception %s —— 預設規則下它「不會」rollback（2.6.1）"
                                          .formatted(m.getFullName(), t.getName()))));
                     }
                 });
```

⚠️ **這條規則比「每個 `@Transactional` 都加 `rollbackFor = Exception.class`」好**，
理由是：

> **加 `rollbackFor` 是「記得做一件事」，而這條規則是「讓那件事不需要做」。**
> 前者會漏，後者不會。

**而如果團隊決定「全部都加 `rollbackFor`」，正確做法是用一個自訂註解，不是複製貼上：**

```java
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
@Transactional(rollbackFor = Throwable.class)      // ★ 只有這一個地方
public @interface TransactionalAlwaysRollback { }
```

> ⚠️ 但要注意：**這個自訂註解在 CGLIB 代理下是可以被找到的**
> （`AnnotationTransactionAttributeSource` 支援 meta-annotation），
> 而它在**介面**上一樣有 2.5.1 的問題。

---

## 2.7 五種交易失效情境 ★★

**這是全章最重要的一節。**
每一種都有一個共同特徵：**沒有任何警告，程式照跑，資料悄悄錯掉。**

### 2.7.1 情境一：自呼叫

```java
@Service
public class OrderBatchService {

    public void processAll(List<String> ids) {
        for (String id : ids) {
            this.processOne(id);          // 🔴 this = 目標物件，不是代理
        }
    }

    @Transactional
    public void processOne(String id) { … }   // ← 完全沒有交易
}
```

**機制**（回到 2.2.2 的 ①）：

```
呼叫端 ──→ [CGLIB 代理] ──→ TransactionInterceptor ──→ 目標物件.processAll()
                                                            │
                                        this.processOne() ──┘
                                        ★ this 是「目標物件」，
                                          呼叫不會再經過代理
```

**四種解法，以及各自的代價：**

| 解法 | 程式碼 | 代價 |
|---|---|---|
| **① 拆成兩個 bean** ★ 推薦 | `OrderBatchService` → `OrderProcessor.processOne()` | 多一個類別 |
| **② 自我注入** | `public OrderBatchService(@Lazy OrderBatchService self)` | ⚠️ 01 章 1.6.4 的所有 `@Lazy` 問題 |
| **③ `AopContext.currentProxy()`** | `((OrderBatchService) AopContext.currentProxy()).processOne(id)` | ⚠️ 需要 `exposeProxy = true`，而且醜 |
| **④ `TransactionTemplate`** ★ | `tx.executeWithoutResult(s -> processOne(id))` | ⚠️ 不能用註解宣告傳播行為（2.10） |

```java
// ── ③ 的完整寫法（含必要的設定）─────────────────────
@SpringBootApplication
@EnableAspectJAutoProxy(exposeProxy = true)      // ⚠️ 少了它會拋 IllegalStateException
public class ShopServiceApplication { }

public void processAll(List<String> ids) {
    OrderBatchService self = (OrderBatchService) AopContext.currentProxy();
    ids.forEach(self::processOne);
}
```

⚠️ **`AopContext.currentProxy()` 的隱藏成本**：
`exposeProxy = true` 讓**每一個** AOP 呼叫都多一次 `ThreadLocal` 的 set/reset。
影響很小，但它是一個**全域**設定 —— 為了一個方法而開全域設定不划算。

> 📌 **shop-service 用 ①**（01 章 1.9.3 的 `OrderCancellationExecutor` 就是它），
> 而 2.10.2 會說明什麼時候 ④ 更好。

**一個會紅燈的守門測試：**

```java
/**
 * ★★ 自呼叫抓不到，但「它的後果」抓得到。
 *
 * <p>思路：讓內層方法失敗，看外層已經寫的資料有沒有被回滾。
 * 沒有回滾 = 交易沒生效。
 */
@Test
void 批次的每一筆都真的在自己的交易裡() {
    orders.insertFixtures("ok-1", "ok-2", "BOOM", "ok-3");

    batchService.processAll(List.of("ok-1", "ok-2", "BOOM", "ok-3"));

    // ★ 3 筆成功、1 筆失敗且它的部分寫入被回滾
    assertThat(probe.countProcessed()).isEqualTo(3);
    assertThat(probe.partialWritesOf("BOOM"))
            .as("如果 @Transactional 沒生效，這裡會有半筆資料")
            .isZero();
}
```

### 2.7.2 情境二：非 public / final / static

01 章 1.3.1 列了 CGLIB 的限制，這裡補完整的機制。

**它其實有兩道獨立的關卡**，而它們的原因不同：

```
關卡 ① ── AnnotationTransactionAttributeSource ─────────────
   publicMethodsOnly = true（Spring 的代理模式下的預設）
   → private / protected / package-private 方法的 @Transactional
     在「讀取屬性」這一步就被忽略了（2.2.2 的 ②）
   → 日誌會印 "No need to create transaction for [...]"

關卡 ② ── CGLIB 產生子類別 ───────────────────────────────
   final 方法無法被覆寫
   static 方法不是實例方法，代理攔不到
   → 就算屬性讀得到，代理也沒有機會插入 interceptor
```

| 修飾詞 | 卡在哪 | 症狀 |
|---|---|---|
| `private` | ① | 靜默無交易 |
| `protected` / package-private | ① | 靜默無交易 |
| `final` | ② | 靜默無交易 |
| `static` | ② | 靜默無交易 |
| **`final` class** | ② | 🔴 **啟動失敗**（`AopConfigException`）—— 這一個反而好，因為看得見 |

⚠️ **注意 `private` 有一個額外的陷阱**：
即使你把它改成 `public`，**如果它是被同類別的方法呼叫的，仍然是自呼叫**（2.7.1）。
**兩個問題常常同時存在**，而只修一個不會有任何改善 —— 這讓除錯特別困擾。

**00 章 0.11.2 的兩條 ArchUnit 規則加上這一條，才涵蓋全部：**

```java
@ArchTest
static final ArchRule transactional方法必須是public =
        methods().that().areAnnotatedWith(Transactional.class).should().bePublic();

@ArchTest
static final ArchRule transactional方法不可為final =
        methods().that().areAnnotatedWith(Transactional.class).should().notBeFinal();

// ★ 本章新增
@ArchTest
static final ArchRule transactional方法不可為static =
        methods().that().areAnnotatedWith(Transactional.class).should().notBeStatic();

@ArchTest
static final ArchRule 有Transactional方法的類別不可為final =
        classes().that().containAnyMethodsThat(
                        com.tngtech.archunit.core.domain.properties.HasName.Predicates
                                .nameMatching(".*")
                        .and(DescribedPredicate.describe("標了 @Transactional",
                                (JavaMethod m) -> m.isAnnotatedWith(Transactional.class))))
                 .should().notBeFinal()
                 .because("CGLIB 無法為 final 類別產生子類別 → 啟動時 AopConfigException");
```

### 2.7.3 情境三：不是 Spring 管理的物件

```java
// 🔴 自己 new 出來的 —— 沒有代理，@Transactional 是一段註解文字
OrderApplicationService service = new OrderApplicationService(repo, loader, …);
service.create(cmd);
```

**這在正式碼裡很少見，但在兩個地方非常常見：**

| 地方 | 說明 |
|---|---|
| **測試** | `new OrderApplicationService(...)`（01 章 1.4.1 推薦的做法！）→ ⚠️ 那種測試**測不到交易** |
| **`@Configuration` 裡手動建立 bean** | `@Bean public Foo foo() { return new Foo(); }` —— ✅ 這個**有**代理（Spring 會後處理它） |

⚠️ **第一列是一個重要的提醒**：

> **01 章 1.4.1 說「建構子注入讓你可以不靠 Spring 建立物件」，
> 那是為了測「編排邏輯」。
> 但那種測試裡的 `@Transactional` 完全沒有作用 ——
> 所以它測不到 rollback、測不到傳播行為、測不到鎖。**
>
> 👉 **這正是 2.2.5 說「交易與併發一定要 `@SpringBootTest` + 真資料庫」的原因。**

### 2.7.4 情境四：換了執行緒 ★

**這是五種裡面最隱蔽的一種**，因為它「有代理、有交易」——
只是交易在**另一條**執行緒上。

```java
@Transactional
public void doIt(List<String> ids) {
    orders.save(a);

    ids.parallelStream()                        // 🔴 ForkJoinPool 的其他執行緒
       .forEach(id -> orders.updateSomething(id));   //    完全沒有交易

    CompletableFuture.runAsync(() -> orders.save(b)); // 🔴 同上
    asyncService.doAsync();                          // 🔴 @Async，同上
}
```

**回到 2.2.4**：交易綁在 `ThreadLocal` 上。
換執行緒 → 拿不到 `ConnectionHolder` → `DataSourceUtils` 向池子要一條**新的**連線
→ 那條連線是 `autoCommit = true` → **每一句 SQL 自己就是一個交易**。

**三個後果：**

| 後果 | 說明 |
|---|---|
| 那些寫入**不會**被回滾 | 主交易 rollback 時它們留在資料庫 |
| **可能死鎖** | 主交易鎖了某一列，子執行緒也要鎖它 → 互等（2.3.4 代價 ③ 的變體） |
| **連線數暴增** | `parallelStream` 用 `ForkJoinPool.commonPool()`，每條執行緒一條連線 |

⚠️ **`parallelStream()` 特別危險**，因為：
① 它看起來只是「加了兩個字」；
② 它用的是**全 JVM 共用**的 `commonPool`，大小是 `CPU 核心數 - 1`
—— 在一台 32 核的機器上，一個 `parallelStream` 可能瞬間要 31 條連線。

> 📌 **規則**：
> **`@Transactional` 方法裡不可以出現 `parallelStream()`、`CompletableFuture`、
> `new Thread`、`@Async` 呼叫。**
> 需要平行處理時，把它移到交易**外面**（2.9.5）。

**一條 ArchUnit 抓不到它（它是方法呼叫層級），但一個執行期檢查可以：**

```java
/**
 * ★ 在非同步執行緒上偵測「不小心繼承來的交易期待」。
 *
 * <p>它不能阻止 2.7.4，但它能<b>讓那件事被看見</b>：
 * 一個 {@code @Async} 方法如果碰了資料庫卻沒有自己的交易，
 * 通常是設計問題。
 */
@Aspect
@Component
public class AsyncTransactionGuard {

    @Before("@annotation(org.springframework.scheduling.annotation.Async)")
    public void warnIfExpectingTransaction(JoinPoint jp) {
        if (!TransactionSynchronizationManager.isActualTransactionActive()) {
            // ★ 只在 dev / test profile 啟用，生產環境用 metric 取代
            log.debug("@Async 方法 {} 在沒有交易的執行緒上 —— "
                    + "如果它會寫資料庫，記得自己標 @Transactional", jp.getSignature());
        }
    }
}
```

### 2.7.5 情境五：例外被 catch 掉

```java
@Transactional
public void doIt() {
    orders.save(a);
    try {
        orders.save(b);                 // 拋 DataIntegrityViolationException
    } catch (Exception e) {
        log.error("忽略", e);            // 🔴 交易不會 rollback
    }
    orders.save(c);
}
```

**這一種與前四種不同**：交易**有**生效，只是它沒有理由 rollback。

⚠️ **而它有兩種完全不同的結局，取決於失敗的是哪一層**：

| 情況 | 結局 |
|---|---|
| `orders.save(b)` 是**同一個交易**裡的一次 `JdbcTemplate` 呼叫 | a 與 c 被 commit，b 沒有 → **資料不一致但沒有例外** |
| `orders.save(b)` 是一個 **`REQUIRED` 的內層 `@Transactional` 方法** | 🔴 交易被標記 rollback-only → **commit 時拋 `UnexpectedRollbackException`**（2.8） |

> 📌 **第二種比第一種好**，因為它至少會爆炸。
> **而這正是「內層也標 `@Transactional`」的唯一好處** ——
> 但它不足以抵消 2.3.3 列的四個壞處。

### 2.7.6 診斷流程圖

```
                 「我的 @Transactional 好像沒生效」
                              │
                              ▼
              ┌────────────────────────────────────┐
              │ 打開 TRACE 日誌（2.4.4）             │
              │ 有 "Creating new transaction" 嗎？   │
              └───┬────────────────────────────┬───┘
                有 │                            │ 沒有
                   ▼                            ▼
    ┌──────────────────────────┐   ┌────────────────────────────────┐
    │ 交易有開 → 問題在別的地方   │   │ 有 "No need to create           │
    │  · 例外被 catch 了（2.7.5）│   │  transaction for [...]" 嗎？     │
    │  · checked exception（2.6）│   └──┬──────────────────────┬──────┘
    │  · 換了執行緒（2.7.4）      │    有 │                      │ 沒有
    │  · 寫入沒走 JdbcTemplate   │       ▼                      ▼
    │    （2.2.4 推論 ③）        │  ┌──────────────┐   ┌──────────────────┐
    └──────────────────────────┘  │ 屬性讀不到    │   │ 代理根本沒攔到     │
                                   │ → 方法不是    │   │ → 自呼叫（2.7.1）  │
                                   │   public      │   │ → new 出來（2.7.3）│
                                   │   （2.7.2 ①）│   │ → final/static     │
                                   └──────────────┘   │   （2.7.2 ②）      │
                                                      └──────────────────┘
```

⚠️ **一個 30 秒的判斷法**（不用開日誌）：

```java
// 在那個方法的第一行加上：
System.out.println("tx=" + TransactionSynchronizationManager.isActualTransactionActive()
                 + " name=" + TransactionSynchronizationManager.getCurrentTransactionName());
```

`tx=false` → 前四種之一。
`tx=true` 但名稱是**別人的方法** → `REQUIRED` 加入了外層（可能是對的，也可能是 2.3.3 的問題）。

---
## 2.8 `UnexpectedRollbackException`

### 2.8.1 rollback-only 標記的機制

**症狀**：方法看起來成功了（沒有任何業務例外），
最後拋出一個 stack trace **完全不指向真正原因**的例外：

```
org.springframework.transaction.UnexpectedRollbackException:
    Transaction silently rolled back because it has been marked as rollback-only
        at org.springframework.jdbc.datasource.DataSourceTransactionManager...
        at org.springframework.transaction.interceptor.TransactionAspectSupport...
        at example.shop.order.application.OrderApplicationService$$SpringCGLIB$$0.create(<generated>)
        ...
    ⚠️ 沒有一行指向「真正失敗的那個內層方法」
```

**機制**（`AbstractPlatformTransactionManager`）：

```
① 內層 REQUIRED 方法拋例外
      │
② TransactionInterceptor 依 rollback 規則決定要 rollback
      │
③ 但它「不是」真正的交易擁有者（它只是 participating）
      │   → 不能真的 rollback，因為外層還沒結束
      │
④ 於是它設定 status.setRollbackOnly()
      │   （globalRollbackOnParticipationFailure = true，預設）
      │   → 日誌：「Participating transaction failed -
      │            marking existing transaction as rollback-only」
      │
⑤ 外層 catch 掉了例外，繼續執行，正常返回
      │
⑥ 外層要 commit → 發現 rollbackOnly = true
      │   → 執行 rollback，然後拋 UnexpectedRollbackException
```

> 📌 **這個例外的意思是**：
> **「你以為你 commit 了，但我幫你 rollback 了 —— 我必須讓你知道。」**
>
> ⚠️ 它是一個**好**的設計。真正糟糕的替代方案是「靜默 rollback」——
> 那樣呼叫端會回 200 給使用者，而資料什麼都沒存。

### 2.8.2 一個完整的重現

```java
@Service
public class OrderApplicationService {

    @Transactional
    public Order create(CreateOrderCommand cmd) {
        Order order = ...;
        orders.save(order);

        try {
            audit.record(AuditEvent.orderPlaced(order, cmd.actor(), now));
        } catch (Exception e) {
            // ⚠️ 「稽核失敗不該讓下單失敗」—— 這個想法是對的，
            //    但這個實作是錯的
            log.warn("稽核寫入失敗", e);
        }

        return order;                     // 🔴 這裡之後會拋 UnexpectedRollbackException
    }
}

@Component
public class AuditRecorderImpl implements AuditRecorder {

    @Transactional                        // ← REQUIRED，加入了 create 的交易
    public void record(AuditEvent event) {
        jdbc.update("INSERT INTO audit_log ...");   // 假設這裡因為欄位太長而失敗
    }
}
```

### 2.8.3 三種解法

**解法 ① 讓內層不要有 `@Transactional`（★ 最好）**

```java
@Component
public class AuditRecorderImpl implements AuditRecorder {
    // ★ 拿掉 @Transactional —— 它在呼叫端的交易裡執行（2.3.3）
    public void record(AuditEvent event) { … }
}
```

**現在 `catch` 真的有效了嗎？**

⚠️ **仍然沒有。** 因為 `DataIntegrityViolationException` 之後，
那個 JDBC 連線上的交易在 MySQL 那一側**通常仍可繼續**
（不像 PostgreSQL 會進入 `aborted` 狀態），
但**你已經有一次失敗的寫入被吞掉了**。

> **所以問題其實不在 `@Transactional`，在「稽核失敗到底該不該讓下單失敗」。**

**解法 ② 決定「稽核必須成功」→ 不要 catch（★ shop-service 的選擇）**

00 章判準 3 已經做過這個決定：**稽核與訂單同交易**。

```java
@Transactional
public Order create(CreateOrderCommand cmd) {
    orders.save(order);
    audit.record(...);          // ★ 失敗就整個失敗，這是刻意的
    return order;
}
```

**理由**：稽核紀錄的目的是「事後查得到當時發生什麼」。
一個**允許遺失**的稽核，在最需要它的那次事故裡就是不可信的。

**解法 ③ 決定「稽核可以稍後」→ `REQUIRES_NEW` 或事件**

```java
// 如果團隊的決定是「稽核不可以擋下單」
@Transactional(propagation = Propagation.REQUIRES_NEW)
public void record(AuditEvent event) { … }
```

⚠️ **但要接受 `REQUIRES_NEW` 的三個代價**（2.3.4），
特別是「**外層 rollback 時稽核留下來了**」——
於是稽核裡會有「不存在的訂單的建立紀錄」。

> 📌 **這一節真正的教訓不是技術**：
> **`UnexpectedRollbackException` 幾乎總是「一個沒有被想清楚的決定」的症狀** ——
> 有人寫了 `try-catch` 表示「這件事失敗沒關係」，
> 但沒有人問「那它為什麼在同一個交易裡」。

### 2.8.4 為什麼 `REQUIRES_NEW` 是常見但通常錯誤的解法

搜尋這個例外，最常看到的答案是「把內層改成 `REQUIRES_NEW`」。

**它會讓例外消失。而那正是問題**：

| 你以為 | 實際上 |
|---|---|
| 「修好了」 | 只是把「大聲失敗」換成「靜默的資料不一致」 |
| 「內層獨立了」 | ➕ 多佔一條連線（2.3.4 ①）<br>➕ 看不到外層的資料（②）<br>➕ 更容易死鎖（③） |

> 📌 **正確的流程**：
> **看到 `UnexpectedRollbackException` 時，先找出「內層到底為什麼失敗」，
> 再問「那個失敗該不該讓整件事失敗」。**
> 改傳播行為是**最後**一步，不是第一步。

---

## 2.9 交易的邊界與長度

### 2.9.1 一條連線的生命週期

```
請求進來
   │
   ├─ Tomcat 執行緒被佔用 ──────────────────────────────────────┐
   │                                                            │
   │   Filter / Interceptor / 參數綁定 / 驗證   ← 不佔連線        │
   │                                                            │
   │   @Transactional 開始 ─┐                                   │
   │                        │ ★★ 連線被獨佔                      │
   │     查商品、扣庫存、     │                                   │
   │     算價、存訂單、稽核    │                                   │
   │                        │                                   │
   │   @Transactional 結束 ─┘                                   │
   │                                                            │
   │   轉 DTO / 序列化 / 寫回應                ← 不佔連線          │
   │                                                            │
   └────────────────────────────────────────────────────────────┘
```

**兩個獨立的資源，兩條獨立的上限：**

| 資源 | 預設 | 被佔用的時間 |
|---|---|---|
| Tomcat 執行緒 | 200 | **整個請求** |
| **資料庫連線** | 10（Hikari 預設）/ shop-service 20 | **只有交易期間** |

⚠️ **這個差距（200 vs 20）是刻意的，而且它有一個重要的含意**：

> **系統設計上假設「大部分請求的大部分時間不在交易裡」。**
> 一旦交易變長（或更糟：交易裡有網路呼叫），
> **那個假設就破了，而連線池變成整個系統的瓶頸。**

### 2.9.2 交易裡不可以做的六件事

00 章 0.10.1 列了「外部系統」，這裡給完整的六件：

| # | 不可以做 | 為什麼 | 正解 |
|---|---|---|---|
| 1 | **呼叫外部 API** | 逾時 30 秒 = 佔連線 30 秒 | 移到交易外 / 事件（06 章） |
| 2 | **寄信、發簡訊、推播** | 同上，而且回不來（0.3.2 事故 2） | `AFTER_COMMIT`（2.12） |
| 3 | **讀寫檔案 / 物件儲存** | 上傳 5MB = 2 秒 | 先傳好再開交易 |
| 4 | **`Thread.sleep` / 等待鎖 / 等 future** | 純浪費 | 重新設計 |
| 5 | **大量運算**（排序 10 萬筆、產生 PDF） | 佔連線做 CPU 工作 | 交易只取資料，運算在外面 |
| 6 | ⚠️ **等使用者輸入 / 等另一個請求** | 「長交易」的極端形式 | 樂觀鎖 + 版本號（2.11.6） |

⚠️ **第 6 條值得展開**，因為它是一個很經典的錯誤設計：

```
🔴 錯誤：「編輯訂單」時開一個交易鎖住它，等使用者按儲存
   → 使用者去吃午餐 → 那一列被鎖 90 分鐘 → 所有人都改不了

✅ 正確：讀出來（不鎖），使用者編輯，儲存時用「版本號」檢查有沒有被別人改過
   → 這叫「離線樂觀鎖」，2.11.6
```

### 2.9.3 量化：交易長度 × 連線池 = 吞吐量上限

**一條可以直接套用的算式：**

```
最大交易吞吐量（TPS） = 連線池大小 ÷ 平均交易時間（秒）
```

| 情境 | 連線池 | 平均交易時間 | **上限 TPS** |
|---|---|---|---|
| 健康 | 20 | 8 ms | **2,500** |
| 交易裡多一次 Redis（正常） | 20 | 10 ms | 2,000 |
| ⚠️ 交易裡多一次內部 API（50 ms） | 20 | 58 ms | **345** |
| 🔴 交易裡呼叫 ERP（P99 = 3 秒） | 20 | 3,008 ms | **6.6** |
| 🔴🔴 ERP 掛掉（30 秒逾時） | 20 | 30,008 ms | **0.67** |

> **從 2,500 掉到 0.67 —— 而程式碼只多了一行。**
> 這就是 00 章 0.3.2 事故 1 的數學。

⚠️ **注意 `0.67 TPS` 的意思不是「變慢」，是「整個服務停止回應」** ——
因為請求以 200 TPS 進來，而系統每秒只能處理 0.67 個。
佇列在 3 秒內就長到讓所有請求 connection-timeout。

**把這條算式做成一個可執行的檢查：**

```java
/**
 * ★ 交易長度的煙霧偵測器。
 *
 * <p>它不阻止任何事，但它讓「交易變長」在<b>上線前</b>就被看見。
 * ⚠️ 用 {@code TransactionSynchronization} 而不是 AOP，
 * 因為它量到的是「真正的交易期間」而不是「方法執行時間」。
 */
@Component
public class SlowTransactionDetector implements TransactionSynchronization {

    private static final long WARN_MILLIS = 200;

    // ★ 用 ThreadLocal 記開始時間 —— 每條執行緒一個交易
    private static final ThreadLocal<Long> START = new ThreadLocal<>();

    public static void register(Clock clock) {
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            START.set(clock.millis());
            TransactionSynchronizationManager.registerSynchronization(
                    new SlowTransactionDetector());
        }
    }

    @Override
    public void afterCompletion(int status) {
        Long start = START.get();
        START.remove();                       // ⚠️ 一定要清，否則執行緒重用時洩漏
        if (start == null) return;

        long elapsed = System.currentTimeMillis() - start;
        if (elapsed > WARN_MILLIS) {
            log.warn("[SLOW-TX] {} 花了 {} ms（門檻 {} ms）—— 2.9.2 的六件事檢查一下",
                     TransactionSynchronizationManager.getCurrentTransactionName(),
                     elapsed, WARN_MILLIS);
        }
    }
}
```

⚠️ **`afterCompletion` 而不是 `afterCommit`**：
前者在 commit **與** rollback 都會呼叫，
而「慢交易最後 rollback 了」正是最需要知道的情況。

### 2.9.4 一個更強的守門人：連線洩漏偵測

```yaml
spring:
  datasource:
    hikari:
      leak-detection-threshold: 15000
```

**它印出的東西長這樣：**

```
WARN  com.zaxxer.hikari.pool.ProxyLeakTask :
      Connection leak detection triggered for
      com.mysql.cj.jdbc.ConnectionImpl@1a2b3c on thread http-nio-8080-exec-7,
      stack trace follows
java.lang.Exception: Apparent connection leak detected
    at ...DataSourceUtils.doGetConnection(DataSourceUtils.java:117)
    at ...DataSourceTransactionManager.doBegin(...)
    at example.shop.order.application.OrderApplicationService.create(...)  ← ★ 這一行
```

> 📌 **`leak-detection-threshold` 的價值不是「偵測洩漏」**（Spring 管理的交易很少真的洩漏），
> **而是「它印出了那條連線是在哪裡被借走的」** ——
> 那正是慢交易的入口。
>
> ⚠️ 而它是一個**警告**不是**中斷**：連線沒有被強制回收。

### 2.9.5 長交易的三種拆法

**當一個交易真的很長時（批次、匯入、報表）：**

**拆法 ① 一批一個交易**

```java
// ★ 01 章 1.9.3 的 OrderExpirationJob 用的就是這一種
for (List<String> batch : Lists.partition(allIds, 200)) {
    executor.processInNewTransaction(batch);      // REQUIRES_NEW，一批一個
}
```

⚠️ **批次大小的取捨**：

| 太小（1） | 太大（10,000） |
|---|---|
| 交易開銷佔比高 | 鎖持有時間長、undo log 大、rollback 貴 |
| ✅ 失敗的影響最小 | 🔴 一筆失敗整批重做 |

**shop-service 用 200**，理由是「一個交易大約 50～100 ms」——
剛好在 2.9.3 的健康區間。

**拆法 ② 交易外做重活，交易內只寫**

```java
// ✅ 昂貴的運算在交易外
List<ReportRow> rows = heavyComputation(rawData);   // 3 秒，不佔連線

// ✅ 交易只做寫入
@Transactional
public void save(List<ReportRow> rows) {
    jdbc.batchUpdate("INSERT ...", rows);           // 40 ms
}
```

**拆法 ③ 用 cursor / keyset 分頁串流**

```java
/**
 * ★ 處理 41 萬筆訂單而不開一個 41 萬筆的交易。
 *
 * <p>⚠️ 關鍵是<b>用 keyset 而不是 offset</b>：
 * {@code OFFSET 400000} 會讓資料庫掃過前 40 萬列（04-controller 1.9.4 的游標分頁）。
 */
public void processAll() {
    String cursor = null;
    while (true) {
        List<String> batch = orders.idsAfter(cursor, 200);   // ← 交易外的查詢
        if (batch.isEmpty()) break;
        executor.processInNewTransaction(batch);             // ← 一批一個交易
        cursor = batch.get(batch.size() - 1);
    }
}
```

⚠️ **這種寫法有一個必須承認的性質**：
**它不是原子的**。跑到一半掛掉，前面處理過的留下來。

👉 **所以它需要「可重入」**：每一筆的處理必須是**冪等**的
（`Order.cancel()` 對已取消的訂單拋例外 → 排程 catch 並跳過，01 章 1.9.3）。

> 📌 **這是一個普遍的取捨**：
> **「原子性」與「交易長度」不可兼得。
> 而放棄原子性的代價是「你必須自己保證冪等」。**

---

## 2.10 程式式交易

### 2.10.1 `TransactionTemplate`

```java
@Component
public class OrderBatchProcessor {

    private final TransactionTemplate tx;

    public OrderBatchProcessor(PlatformTransactionManager txManager) {
        this.tx = new TransactionTemplate(txManager);
        // ★ 每一個 TransactionTemplate 攜帶它自己的交易屬性
        this.tx.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        this.tx.setTimeout(10);
    }

    public void processAll(List<String> ids) {
        for (String id : ids) {
            tx.executeWithoutResult(status -> processOne(id));    // ★ Spring 5.2+
        }
    }

    // ★ 沒有 @Transactional —— 交易由上面那一行提供
    private void processOne(String id) { … }
}
```

⚠️ **注意 `processOne` 是 `private` 而這完全沒問題** ——
因為交易不是靠代理提供的（2.7.2 的限制對程式式交易不適用）。

**這是程式式交易最被低估的好處**：

> **它讓「交易邊界」與「方法可見性」脫鉤。**
> 用註解時，「要有交易」強迫你把方法變成 `public`，
> 而那會擴大類別的 API 表面。

### 2.10.2 什麼時候比註解好

| 情況 | 為什麼 |
|---|---|
| **① 迴圈裡每一筆一個交易** | 註解版需要拆出另一個 bean（2.7.1 解法 ①）；`TransactionTemplate` 不用 |
| **② 交易屬性要在執行期決定** | `tx.setTimeout(isBigBatch ? 60 : 5)` —— 註解是編譯期常數 |
| **③ 交易邊界比方法邊界小** ★ | 見 2.10.3 |
| **④ 想明確地標記 rollback** | `status.setRollbackOnly()` 比「拋一個例外只為了 rollback」清楚 |

**而註解在其他所有情況都比較好**，理由只有一個但很強：

> **註解讓「這是一個交易邊界」在 IDE、code review、ArchUnit 裡都看得見。
> `TransactionTemplate` 是一個普通的方法呼叫，藏在 50 行程式碼中間。**

👉 **shop-service 的比例大約是 95% 註解、5% `TransactionTemplate`**，
而那 5% 全部是 ① 與 ③。

### 2.10.3 交易邊界比方法邊界小：減少鎖持有時間 ★

**這是 `TransactionTemplate` 最有價值的用途。**

```java
// 🔴 註解版：整個方法都在交易裡
@Transactional
public ShipmentResult ship(ShipCommand cmd) {
    Order order = orders.findByIdForUpdate(cmd.orderId());   // ★ 鎖住這一列
    ShippingLabel label = labelPrinter.render(order);        // 🔴 200 ms 的排版運算
    Shipment s = order.ship(cmd.lines(), label.trackingNo(), cmd.carrier(), now);
    orders.save(order);
    return new ShipmentResult(s, label);
}
// → 那一列被鎖 200+ ms。同一張訂單的其他操作全部排隊。
```

```java
// ✅ 程式式版：交易只包住「真的需要鎖」的部分
public ShipmentResult ship(ShipCommand cmd) {
    // ── 交易外：讀取（不鎖）與運算 ──────────────
    Order snapshot = queryService.findById(cmd.orderId());
    ShippingLabel label = labelPrinter.render(snapshot);      // 200 ms，沒有鎖

    // ── 交易內：只做「鎖 → 驗證 → 寫」 ──────────
    Shipment s = tx.execute(status -> {
        Order order = orders.findByIdForUpdate(cmd.orderId());  // ★ 鎖從這裡開始
        // ⚠️ 一定要重新驗證 —— 交易外讀的那份可能已經過期
        if (!order.status().isShippable()) {
            throw new OrderNotShippableException(order.id(), order.status());
        }
        Shipment shipment = order.ship(cmd.lines(), label.trackingNo(), cmd.carrier(), now);
        orders.save(order);
        return shipment;                                        // ★ 鎖到這裡結束（約 5 ms）
    });

    return new ShipmentResult(s, label);
}
```

**鎖持有時間從 200 ms 降到 5 ms —— 同一張訂單的併發能力提升 40 倍。**

⚠️⚠️ **但注意那個「一定要重新驗證」的註解 —— 它不可以省。**

交易外讀的 `snapshot` 是**過期的**。
如果不重新驗證，一張在那 200 ms 之間被取消的訂單仍然會被出貨。

> 📌 **這是一個通用的模式，值得記住名字**：
> **「樂觀地在外面準備，悲觀地在裡面確認」。**
> 它在 2.11.6 的樂觀鎖裡會再出現一次。

### 2.10.4 `status.setRollbackOnly()`

```java
tx.executeWithoutResult(status -> {
    orders.save(order);
    if (somethingIsWrong()) {
        status.setRollbackOnly();      // ★ 明確標記，不用拋例外
        return;
    }
    audit.record(...);
});
```

⚠️ **它與「拋例外」的差別**：

| | 拋例外 | `setRollbackOnly()` |
|---|---|---|
| 交易 | rollback | rollback |
| 呼叫端 | 收到例外 | ✅ **正常返回** |
| 適合 | 真的是錯誤 | ⚠️ 「這次不做，但不是錯誤」 |

**而它幾乎沒有正當用途**，因為「回滾了但呼叫端不知道」是一個很糟的介面。

👉 **唯一的例外**：測試裡用它來確保測試資料不留下
（⚠️ 但 2.2.5 已經說了這一章不用那種做法）。

---
## 2.11 併發控制 ★★

**00 章 0.8 說「不變量要守在資料所在的地方」。這一節講怎麼守。**

### 2.11.1 三種競爭與它們的症狀

| 競爭 | 形狀 | 症狀 |
|---|---|---|
| **① 檢查與寫入之間的縫**（TOCTOU） | `SELECT` 判斷 → `UPDATE` 寫入 | 超賣、優惠券超發、次數上限被突破 |
| **② 遺失更新**（lost update） | 兩個人各自讀出來、各自改、各自存 | 「我剛改的備註不見了」 |
| **③ 寫偏斜**（write skew） | 兩個交易各自檢查**不同的列**，合起來破壞了一條規則 | 「兩個值班醫師同時請假」型的問題 |

⚠️ **③ 最少見但最難察覺**，而且**它在 `REPEATABLE READ` 下仍然會發生**。

**shop-service 裡的一個真實例子：**

```
規則：一張訂單最多同時有一筆「處理中」的付款（PAYMENT_ALREADY_IN_PROGRESS）

交易 A（使用者按下「付款」）        交易 B（使用者在另一個分頁也按了）
─────────────────────────────────────────────────────────────────
SELECT COUNT(*) FROM payment
 WHERE order_id=1 AND status='PENDING'   → 0
                                       SELECT COUNT(*) ... → 0（快照讀，看不到 A）
0 == 0 ✅ 通過
                                       0 == 0 ✅ 通過
INSERT payment(PENDING)
                                       INSERT payment(PENDING)
COMMIT                                 COMMIT
─────────────────────────────────────────────────────────────────
結果：兩筆進行中的付款 → 使用者被扣兩次錢
```

⚠️ **注意這裡「兩個交易寫的是不同的列」（各自 INSERT 一筆新的）**——
所以行鎖幫不上忙，`SELECT ... FOR UPDATE` 也鎖不到「還不存在的列」。

**這正是「寫偏斜」，而它的解法只有三種**（2.11.5 會展開）。

### 2.11.2 檢查與寫入之間的縫

00 章 0.3.2 事故 3 的完整版。**先確認一件事：**

> ⚠️ **「開了交易」對這個問題完全沒有幫助。**

```java
@Transactional                              // ← 有交易
public void reserve(String productId, int qty) {
    Stock s = stock.findByProductId(productId);   // 快照讀，不加鎖
    if (s.available() < qty) throw ...;           // ← 縫在這裡
    stock.update(productId, s.available() - qty);
}
```

**兩個交易都會通過那個 `if`**，因為：
- `READ_COMMITTED`：各自讀到 commit 前的值。
- `REPEATABLE_READ`：各自讀到自己交易開始時的快照。

**唯一有幫助的是「讓讀取本身帶鎖」或「讓寫入本身帶條件」。**

### 2.11.3 悲觀鎖：`SELECT ... FOR UPDATE`

```sql
SELECT available FROM stock WHERE product_id = ? FOR UPDATE;
```

**它做兩件事**：讀到**最新**已 commit 的值（當前讀，2.4.3），並**鎖住那一列**
直到交易結束。

```java
public interface StockPort {
    /**
     * ★ 悲觀鎖版本：鎖住那一列並回傳最新的庫存。
     *
     * <p>⚠️ 呼叫它<b>必須</b>在交易裡 —— 沒有交易的話鎖在下一句 SQL 就釋放了，
     * 而那等於沒有鎖。所以實作標 {@code @Transactional(MANDATORY)}（2.3.6）。
     */
    Optional<Stock> findByProductIdForUpdate(String productId);
}
```

```java
@Repository
public class JdbcStockRepository implements StockPort {

    @Override
    @Transactional(propagation = Propagation.MANDATORY)      // ★ 見上方 javadoc
    public Optional<Stock> findByProductIdForUpdate(String productId) {
        return jdbc.query("""
                SELECT product_id, available, reserved
                  FROM stock
                 WHERE product_id = ?
                 FOR UPDATE
                """, STOCK_ROW_MAPPER, productId).stream().findFirst();
    }
}
```

**Spring Data JPA 的等價寫法**（08 站）：

```java
@Lock(LockModeType.PESSIMISTIC_WRITE)
@QueryHints(@QueryHint(name = "jakarta.persistence.lock.timeout", value = "3000"))
@Query("select s from Stock s where s.productId = :id")
Optional<Stock> findByProductIdForUpdate(@Param("id") String id);
```

**悲觀鎖的四個代價：**

| 代價 | 說明 |
|---|---|
| **序列化** | 同一列的所有操作排隊。熱門商品的下單吞吐量 = `1 ÷ 交易長度` |
| **等鎖不受 `@Transactional(timeout)` 管** | 只有 `innodb_lock_wait_timeout` 管得到（2.5.3） |
| **死鎖風險** | 兩個交易以不同順序鎖多列（2.11.9） |
| ⚠️ **`FOR UPDATE` 找不到列時不會鎖任何東西** | 「先查再插入」的 race 擋不住（2.11.1 的 ③） |

⚠️ **最後一條特別重要**，因為它是一個很常見的誤用：

```java
// 🔴 以為 FOR UPDATE 可以擋住「重複建立」
if (idempotency.findForUpdate(key).isEmpty()) {     // 找不到 → 沒鎖住任何東西
    idempotency.insert(key, orderId);               // 🔴 兩個交易都會走到這裡
}
```

⚠️ 在 `REPEATABLE READ` 下，MySQL 的 next-key lock **會**鎖住「間隙」，
所以上面那段**有時候**會被擋住（一個交易拿到間隙鎖，另一個等待）。
**但那是「有時候」** —— 取決於索引、取決於隔離級別、取決於 MySQL 版本。

> 📌 **依賴間隙鎖是一個壞主意。**
> 「同一個冪等鍵只能有一筆」的正解是 **UNIQUE 約束**（00 章 0.12 ⑩），
> 而 catch `DuplicateKeyException` 是那個約束的正確用法。

**用 `FOR UPDATE` 的正確版本（用於「已存在的列」）：**

```java
@Transactional
public void adjustStock(String productId, int delta, Actor actor) {
    // ★ 鎖住 → 此時只有這個交易能改這一列
    Stock stock = stockPort.findByProductIdForUpdate(productId)
            .orElseThrow(() -> new ResourceNotFoundException("Stock", productId));

    // ★ 現在可以安全地做「複雜的判斷」——這是悲觀鎖相對原子 UPDATE 的唯一優勢
    if (delta < 0 && !stock.canReserve(-delta)) {
        throw new InsufficientStockException(productId, ..., -delta, stock.available());
    }
    if (delta > 0 && stock.available() + delta > MAX_STOCK_PER_SKU) {
        throw new StockCapacityExceededException(productId, MAX_STOCK_PER_SKU);
    }

    stock.adjust(delta);
    stockPort.save(stock);
    audit.record(AuditEvent.stockAdjusted(productId, delta, actor, clock.instant()));
}
```

> 📌 **悲觀鎖的判準**：
> **「我需要在讀與寫之間做一段『不只是加減』的判斷」時用它。**
> 只是加減 → 用原子 UPDATE（2.11.7），它快得多。

### 2.11.4 序號產生器：一個必須用悲觀鎖的例子 ★

00 章 0.12 的 `OrderNumberGenerator` 留了一個 TODO，這裡實作它。

**需求**：`ORD-20260315-0001`，同一個營業日內序號連續且不重複。

```sql
CREATE TABLE order_number_sequence (
    business_date DATE    NOT NULL PRIMARY KEY,
    next_seq      INT     NOT NULL,
    updated_at    DATETIME(6) NOT NULL
);
```

**三種實作，只有一種是對的：**

```java
// 🔴 做法 A：SELECT MAX + 1
int next = jdbc.queryForObject(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM orders WHERE business_date = ?",
        Integer.class, date);
// → 兩個請求同時讀到同一個值 → 重複編號
// ⚠️ 而且它會掃描當天的所有訂單，越到晚上越慢
```

```java
// ⚠️ 做法 B：悲觀鎖（正確，但要注意兩件事）
@Transactional(propagation = Propagation.MANDATORY)
public OrderNumber next(Instant now) {
    LocalDate date = LocalDate.ofInstant(now, BUSINESS_ZONE);

    // ★★ 一句話完成「不存在就建立、存在就 +1」，而且是原子的
    jdbc.update("""
            INSERT INTO order_number_sequence(business_date, next_seq, updated_at)
            VALUES (?, 2, ?) AS new
            ON DUPLICATE KEY UPDATE next_seq = next_seq + 1, updated_at = new.updated_at
            """, date, Timestamp.from(now));

    // ⚠️ 「AS new」的列別名需要 MySQL 8.0.20+；舊版寫 VALUES(updated_at)
    //    （後者從 8.0.20 起會發出 deprecation warning）
    // ⚠️ 但 ON DUPLICATE KEY UPDATE 不會告訴你「更新後的值」——
    //    所以還是要讀一次。而這一次讀必須在同一個交易裡（那一列已經被上面的
    //    UPDATE 鎖住，所以不需要額外的 FOR UPDATE）
    int seq = jdbc.queryForObject(
            "SELECT next_seq FROM order_number_sequence WHERE business_date = ?",
            Integer.class, date) - 1;

    return OrderNumber.of(now, seq);
}
```

⚠️ **做法 B 的兩個「要注意」：**

| 注意 | 說明 |
|---|---|
| **它把整個下單流程序列化了** | 所有訂單搶同一列 → 上限 TPS = `1 ÷ 交易長度`。8 ms 的交易 → 125 TPS |
| **交易越長，序號越是瓶頸** | 而序號是下單流程的**第一步**（00 章 0.9.4 的 `OrderFactory`）→ 它鎖住那一列直到整個交易結束 |

```java
// ✅ 做法 C：把序號放進「自己的短交易」——shop-service 的選擇
@Component
public class SequenceOrderNumberGenerator implements OrderNumberGenerator {

    private final TransactionTemplate shortTx;      // ★ REQUIRES_NEW + timeout=2
    private final JdbcTemplate jdbc;

    /**
     * ★★ 用一個<b>獨立的短交易</b>取號。
     *
     * <p>好處：那一列只被鎖住 1～2 ms，而不是整個下單交易的 8～50 ms
     * → 上限從 125 TPS 提高到約 1,000 TPS。
     *
     * <p>⚠️⚠️ 代價（<b>必須明確承認</b>）：
     * <b>下單交易 rollback 時，這個序號不會還回去</b> ——
     * 於是訂單編號會有「洞」（0001、0003、0004…）。
     *
     * <p>👉 <b>而那完全可以接受</b>，因為訂單編號的需求是
     * 「唯一、遞增、給人唸」，<b>不是「連續」</b>。
     * ⚠️ 但如果你的需求真的是「連續」（例如發票號碼，那是法規要求），
     * 就<b>不能</b>用這個做法 —— 必須用做法 B 並接受它的 TPS 上限。
     */
    @Override
    public OrderNumber next(Instant now) {
        LocalDate date = LocalDate.ofInstant(now, BUSINESS_ZONE);
        Integer seq = shortTx.execute(status -> {
            jdbc.update("""
                    INSERT INTO order_number_sequence(business_date, next_seq, updated_at)
                    VALUES (?, 2, ?) AS new
                    ON DUPLICATE KEY UPDATE next_seq = next_seq + 1, updated_at = new.updated_at
                    """, date, Timestamp.from(now));
            return jdbc.queryForObject(
                    "SELECT next_seq FROM order_number_sequence WHERE business_date = ?",
                    Integer.class, date) - 1;
        });
        return OrderNumber.of(now, seq);
    }
}
```

> 📌 **這一節示範的取捨是本章反覆出現的那一個**：
> **「原子性」與「併發能力」互相交換，而你必須知道自己換了什麼。**
>
> ⚠️ 而「訂單編號可以有洞、發票號碼不可以」這種**業務層面的差別**，
> 決定了技術選擇 —— 不是反過來。

### 2.11.5 「一天最多改 3 次地址」的正確做法

04-controller 0.14 練習 4 留下的併發問題，這裡解掉。

**先確認它是哪一種競爭**：兩個客服各自查到「今天已改 2 次」→ 都通過 → 變成 4 次。
**兩個交易寫的是不同的列**（各自 INSERT 一筆變更紀錄）→ **這是寫偏斜**（2.11.1 的 ③）。

**三種解法：**

**解法 A：鎖住「父列」（把寫偏斜變成行鎖競爭）★ 最直接**

```java
@Transactional
public AddressChangeResult changeShippingAddress(ChangeAddressCommand cmd) {
    // ★★ 鎖住訂單那一列 —— 於是「同一張訂單的地址變更」被序列化
    Order order = orders.findByIdForUpdate(cmd.orderId())
            .orElseThrow(() -> new ResourceNotFoundException("Order", cmd.orderId()));

    LocalDate today = LocalDate.ofInstant(clock.instant(), BUSINESS_ZONE);
    int used = addressChanges.countByOrderAndDate(cmd.orderId(), today);
    if (used >= MAX_CHANGES_PER_DAY) {
        throw new AddressChangeLimitExceededException(
                cmd.orderId(), MAX_CHANGES_PER_DAY, used, today.plusDays(1).atStartOfDay());
    }

    order.changeShippingAddress(cmd.patch(), cmd.actor(), clock.instant());
    orders.save(order);
    addressChanges.record(cmd.orderId(), today, cmd.actor(), clock.instant());
    return ...;
}
```

⚠️ **為什麼鎖 `order` 就夠了**：因為那個計數**只跟這一張訂單有關**。
把「不存在的列的競爭」轉換成「一個已存在的列的競爭」是處理寫偏斜的標準手法。

**解法 B：UNIQUE 約束當最後防線（★ 一定要有）**

```sql
CREATE TABLE address_change_log (
    order_id      VARCHAR(32) NOT NULL,
    business_date DATE        NOT NULL,
    seq           TINYINT     NOT NULL,       -- 1, 2, 3
    actor_id      VARCHAR(32) NOT NULL,
    changed_at    DATETIME(6) NOT NULL,
    -- ★★ 這條約束讓「一天超過 3 次」在資料庫層不可能
    PRIMARY KEY (order_id, business_date, seq),
    CONSTRAINT chk_seq_range CHECK (seq BETWEEN 1 AND 3)
);
```

```java
// ★ 應用層算出 seq，資料庫保證它不重複也不超過 3
int seq = used + 1;
try {
    addressChanges.insert(cmd.orderId(), today, seq, cmd.actor(), now);
} catch (DuplicateKeyException e) {
    // ⚠️ 走到這裡代表解法 A 的鎖沒生效 —— 記 WARN 並回一個明確的錯誤
    log.warn("[RACE] 地址變更的序號衝突：order={} seq={}", cmd.orderId(), seq);
    throw new AddressChangeLimitExceededException(...);
} catch (DataIntegrityViolationException e) {
    // CHECK 擋下 seq > 3
    throw new AddressChangeLimitExceededException(...);
}
```

> 📌 **A + B 一起用**，這是 00 章 0.8.3 「四層都放」的實際樣子：
> **A 給好的錯誤訊息與正常的併發行為，B 保證資料一定是對的。**

**解法 C：把計數放進訂單那一列（反正規化）**

```sql
ALTER TABLE orders ADD COLUMN address_changes_today TINYINT NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN address_changes_date  DATE NULL;
```

```sql
-- ★ 一句話完成「檢查 + 計數」，而且是原子的
UPDATE orders
   SET address_changes_today = CASE WHEN address_changes_date = ?
                                    THEN address_changes_today + 1 ELSE 1 END,
       address_changes_date  = ?
 WHERE id = ?
   AND (address_changes_date <> ? OR address_changes_today < 3);
-- 回傳 0 → 已達上限
```

⚠️ **它最快（沒有額外查詢、沒有鎖等待），但它把「歷史」丟掉了** ——
而稽核需要「誰在什麼時候改成什麼」。

👉 **shop-service 選 A + B**：稽核紀錄是必要的，而地址變更不是熱路徑。

### 2.11.6 樂觀鎖

**適用**：衝突**不頻繁**，而且「衝突時重試或告訴使用者」是可接受的。

```sql
ALTER TABLE orders ADD COLUMN version BIGINT NOT NULL DEFAULT 0;
```

```java
// ── JdbcTemplate 版本 ────────────────────────────
@Override
public void save(Order order) {
    int updated = jdbc.update("""
            UPDATE orders
               SET status = ?, version = version + 1, updated_at = ?
             WHERE id = ? AND version = ?
            """, order.status().name(), Timestamp.from(clock.instant()),
                 order.id(), order.version());

    if (updated == 0) {
        // ⚠️ 兩種可能：被別人改過了，或這一列根本不存在
        //    ★ 要分辨，否則「訂單不存在」會被誤報成「版本衝突」
        boolean exists = jdbc.queryForObject(
                "SELECT COUNT(*) FROM orders WHERE id = ?", Long.class, order.id()) > 0;
        if (!exists) throw new ResourceNotFoundException("Order", order.id());
        throw new OptimisticLockConflictException("Order", order.id(), order.version());
    }
    order.markVersionIncremented();      // ★ 記憶體裡的版本也要 +1
}
```

```java
// ── JPA 版本（08 站）──────────────────────────────
@Entity
public class Order {
    @Version
    private long version;               // ★ Hibernate 自動處理，衝突時拋
}                                       //   ObjectOptimisticLockingFailureException
```

⚠️ **樂觀鎖的三個實務細節：**

**① 「離線樂觀鎖」是它最有價值的用途**（2.9.2 第 6 條）

```
① GET /orders/{id}  → 回應帶 ETag（= version）      ← 04-controller 6.8
② 使用者編輯 30 分鐘（沒有任何鎖）
③ PATCH /orders/{id}  If-Match: "<version>"
      → 版本不符 → 412 Precondition Failed
```

**這讓「使用者去吃午餐」不再是一個技術問題。**

**② 重試只能在「操作可以安全重做」時**

```java
/**
 * ★ 樂觀鎖衝突的重試。
 *
 * <p>⚠️⚠️ 它有一個<b>硬性前提</b>：
 * <b>被重試的方法必須從頭重新讀取資料</b>。
 * 重試一個「拿著舊資料重算」的方法，只會再衝突一次。
 *
 * <p>⚠️ 而 {@code @Retryable} 與 {@code @Transactional} 的順序很重要：
 * <b>重試必須在交易外面</b>（每次重試一個新交易），
 * 所以 {@code @Retryable} 要在<b>呼叫端</b>的 bean 上，
 * 而不是與 {@code @Transactional} 標在同一個方法上。
 */
@Component
public class OrderUpdateRetrier {

    private final OrderApplicationService service;   // ★ 它的方法有 @Transactional

    @Retryable(
            retryFor = { OptimisticLockConflictException.class,
                         ObjectOptimisticLockingFailureException.class },
            maxAttempts = 3,
            backoff = @Backoff(delay = 50, multiplier = 2, random = true))
    public Order updateWithRetry(UpdateOrderCommand cmd) {
        return service.update(cmd);       // ★ 每次呼叫 = 一個全新的交易
    }

    @Recover
    public Order giveUp(OptimisticLockConflictException e, UpdateOrderCommand cmd) {
        // ⚠️ 重試 3 次還衝突 → 這張訂單是熱點，告訴使用者而不是無限重試
        throw new ConcurrentModificationConflictException(cmd.orderId(), e);
    }
}
```

⚠️ **`random = true` 不可以省** —— 沒有抖動的話，
兩個衝突的請求會在同一時間點重試，然後再次衝突。

**③ 樂觀鎖不保護「你沒有讀出來的東西」**

```java
// 🔴 version 保護的是「orders 這一列」
order.setStatus(SHIPPED);
orders.save(order);                    // ✅ 版本檢查

stock.decrease(productId, qty);        // 🔴 stock 那一列沒有任何保護
```

> 📌 **樂觀鎖是「一列」的保護，不是「一個操作」的保護。**

### 2.11.7 原子 UPDATE

**最快、最簡單，適用於「條件 + 加減」可以寫進一句 SQL 的情況。**

```sql
UPDATE stock SET available = available - ?, reserved = reserved + ?
 WHERE product_id = ? AND available >= ?;
```

**它為什麼是原子的**：`UPDATE` 是當前讀（2.4.3），
InnoDB 對匹配的列加行鎖，**條件判斷與寫入在同一個鎖的保護下發生**。

⚠️ **三個限制：**

| 限制 | 說明 |
|---|---|
| 判斷必須寫得進 `WHERE` | 「庫存足夠**且**商品未下架**且**客戶等級是 VIP」勉強可以，再複雜就不行 |
| **拿不到「為什麼失敗」** | 回傳 0 只代表「沒有列符合」——是庫存不足還是商品不存在？（00 章 0.8.3 的 `snapshot()` 就是為了回答它） |
| 熱點列仍然序列化 | 所有人搶同一列 → 行鎖排隊。⚠️ **但它比悲觀鎖快得多**，因為鎖只持續一句 SQL 的時間 |

### 2.11.8 三者的決策表 ★

```
                  ┌──────────────────────────────────────┐
                  │ 這個併發問題是哪一種？                  │
                  └──────┬───────────────────────────┬───┘
          「檢查+加減」    │                           │ 「讀出來 → 使用者編輯 → 存回去」
                          ▼                           ▼
        ┌────────────────────────────┐     ┌──────────────────────────┐
        │ 判斷寫得進 WHERE 嗎？        │     │ ✅ 樂觀鎖（version/ETag）  │
        └──┬─────────────────────┬───┘     │    2.11.6 的「離線」用法    │
       可以 │                     │ 不可以   └──────────────────────────┘
            ▼                     ▼
  ┌──────────────────┐  ┌────────────────────────┐
  │ ✅ 原子 UPDATE     │  │ ✅ 悲觀鎖 FOR UPDATE    │
  │    2.11.7 最快     │  │    2.11.3              │
  │ ⚠️ 錯誤訊息要另查   │  │ ⚠️ 交易要短（2.10.3）   │
  └──────────────────┘  └────────────────────────┘

        「兩個交易寫不同的列，合起來破壞一條規則」（寫偏斜）
                          │
                          ▼
        ┌────────────────────────────────────────┐
        │ ✅ 鎖住「父列」把它變成行鎖競爭（2.11.5 A）│
        │ ➕ UNIQUE / CHECK 當最後防線（2.11.5 B）  │
        └────────────────────────────────────────┘
```

**shop-service 的實際選擇：**

| 場景 | 用什麼 | 理由 |
|---|---|---|
| 扣庫存 | **原子 UPDATE** | 判斷簡單、極熱、要最快 |
| 扣優惠券總量 | **原子 UPDATE** | 同上 |
| 每人使用券次數 | **UNIQUE (code, customer, order)** | 寫偏斜，靠約束（01 章練習 2） |
| 盤點調整庫存 | **悲觀鎖** | 判斷複雜（上下限、原因碼），且低頻 |
| 訂單編號 | **悲觀鎖 + 短交易** | 必須遞增，2.11.4 |
| 改地址次數 | **鎖父列 + UNIQUE** | 寫偏斜，2.11.5 |
| 客服編輯訂單 | **樂觀鎖 + ETag** | 離線編輯，2.11.6 |
| 冪等鍵 | **UNIQUE** | 不變量 I9 |

### 2.11.9 死鎖

**MySQL InnoDB 會自動偵測死鎖**，並回滾其中一個交易：

```
ERROR 1213 (40001): Deadlock found when trying to get lock; try restarting transaction
```

Spring 把它翻譯成 `DeadlockLoserDataAccessException`（`ConcurrencyFailureException` 的子類）。

⚠️ **不要與「鎖等待逾時」搞混：**

| | 死鎖 | 鎖等待逾時 |
|---|---|---|
| MySQL 錯誤碼 | 1213 | 1205 |
| Spring 例外 | `DeadlockLoserDataAccessException` | `CannotAcquireLockException` |
| 發生時間 | **立刻**（偵測到就回滾） | `innodb_lock_wait_timeout` 之後（預設 50 秒） |
| 意思 | 兩個交易互等 | 一個交易等太久（對方可能只是很慢） |

**最常見的死鎖形狀：以不同順序鎖多列**

```
交易 A：鎖 product P-1 → 鎖 product P-2
交易 B：鎖 product P-2 → 鎖 product P-1
                      ↑ 互等 → 死鎖
```

**而它在 shop-service 裡真的會發生**：
兩張訂單各含 `P-1` 與 `P-2`，而 `create()` 的第 ③ 步是**依 `cmd.lines()` 的順序**扣庫存
—— 使用者加入購物車的順序不同，鎖的順序就不同。

**解法：永遠以固定順序鎖**

```java
// ✅ 依 productId 排序之後再扣 —— 所有交易的鎖順序一致 → 不可能死鎖
List<CreateOrderCommand.Line> sorted = cmd.lines().stream()
        .sorted(Comparator.comparing(CreateOrderCommand.Line::productId))
        .toList();

for (int i = 0; i < sorted.size(); i++) {
    var line = sorted.get(i);
    if (!stock.tryReserve(line.productId(), line.quantity())) {
        throw insufficientStock(cmd, ctx, line);
    }
}
```

⚠️ **這一行 `sorted(...)` 是 00 章 0.9.4 / 01 章 1.2.5 那段程式碼的一個缺口**，
👉 **本章補上它**（2.14 的政策表有記錄）。

⚠️ **但排序之後 `itemIndex` 就不對了**（00 章複查修過的那個 bug 的變體）：

```java
// ✅ 排序時保留原始索引
record IndexedLine(int originalIndex, CreateOrderCommand.Line line) {}

List<IndexedLine> sorted = IntStream.range(0, cmd.lines().size())
        .mapToObj(i -> new IndexedLine(i, cmd.lines().get(i)))
        .sorted(Comparator.comparing(il -> il.line().productId()))
        .toList();

for (IndexedLine il : sorted) {
    if (!stock.tryReserve(il.line().productId(), il.line().quantity())) {
        throw insufficientStock(cmd, ctx, il.line(), il.originalIndex());   // ★ 原始索引
    }
}
```

> 📌 **「錯誤訊息裡的索引要對得上使用者送來的順序」是一個容易被犧牲的細節** ——
> 而它決定了前端能不能把錯誤標在正確的那一列上。

**死鎖的重試：**

```java
@Retryable(
        retryFor = { DeadlockLoserDataAccessException.class,
                     CannotAcquireLockException.class },
        maxAttempts = 3,
        backoff = @Backoff(delay = 100, multiplier = 3, random = true))
public Order createWithRetry(CreateOrderCommand cmd) {
    return service.create(cmd);
}
```

⚠️ **重試死鎖是安全的嗎？**

> **是** —— 死鎖的那個交易**已經被完整回滾**，重做一次不會有副作用。
> ⚠️ **但前提是「交易裡沒有交易外的副作用」**（2.9.2 的六件事）。
> 如果交易裡寄了信，重試就會寄第二封。
>
> 👉 **這是「交易裡不可以做副作用」的另一個理由** —— 它讓重試變得安全。

**三個降低死鎖率的做法：**

| 做法 | 說明 |
|---|---|
| **① 固定鎖順序** | 上面那個 `sorted(...)` |
| **② 縮短交易** | 2.10.3 —— 鎖持有時間越短，交叉的機率越低 |
| **③ 用原子 UPDATE 取代「查了再改」** | 一句 SQL 的鎖持有時間是微秒級 |

**怎麼查上一次死鎖：**

```sql
SHOW ENGINE INNODB STATUS\G
-- 看 "LATEST DETECTED DEADLOCK" 那一段：
--   它會印出兩個交易各自「持有什麼鎖」與「在等什麼鎖」，以及當時的 SQL
```

> ⚠️ **它只保留「最近一次」**。生產環境要打開
> `innodb_print_all_deadlocks = ON` 讓每一次都進 error log
> —— 否則你只會在事故發生後才想到要看，而那時候它已經被覆蓋了。

---
## 2.12 事件與交易

### 2.12.1 `@TransactionalEventListener` 的四個 phase

```java
public enum TransactionPhase {
    BEFORE_COMMIT,        // commit 之前
    AFTER_COMMIT,         // ★ 預設值，commit 成功之後
    AFTER_ROLLBACK,       // rollback 之後
    AFTER_COMPLETION      // commit 或 rollback 都會
}
```

**對照 2.2.2 的步驟：**

```
⑩ 決定 commit / rollback
⑪ ── BEFORE_COMMIT ──────────  ★ 還在交易裡，寫入會一起 commit
⑫ connection.commit()          ← 交易在這裡結束
⑬ ── AFTER_COMMIT ───────────  ⚠️ 資源還綁著，但「不會再 commit」
⑭ ── AFTER_COMPLETION ───────  ⚠️ 例外會被 catch 並記 log
⑮ 解除綁定 → connection 歸還池子
```

| Phase | 寫入會被 commit 嗎？ | listener 拋例外會怎樣 | 用途 |
|---|---|---|---|
| `BEFORE_COMMIT` | ✅ **會**（還在交易裡） | 🔴 **整個交易 rollback** | commit 前的最後檢查、寫衍生資料 |
| **`AFTER_COMMIT`** | 🔴 **不會**（除非 `REQUIRES_NEW`） | ⚠️ **傳到呼叫端**（2.12.2 陷阱 ②） | **通知、推 ERP、清快取**（絕大多數） |
| `AFTER_ROLLBACK` | 同上 | 同上 | 補償、告警 |
| `AFTER_COMPLETION` | 同上 | ✅ 被 catch 並記 log | 清理（無論成敗） |

⚠️ **`BEFORE_COMMIT` 那一列的「拋例外 = 整個交易 rollback」值得注意**：

它讓 `BEFORE_COMMIT` 變成一個**很強的守門點**（「commit 前最後檢查不變量」），
但也讓它變成一個**危險的地方** —— 一個寫得不好的 listener
可以讓所有交易失敗，而失敗的堆疊指向 `TransactionInterceptor` 而不是它自己。

### 2.12.2 `AFTER_COMMIT` 的三個陷阱

**陷阱 ①：沒有交易時，listener 根本不會執行 🔴**

```java
public void doSomethingWithoutTransaction() {      // ← 沒有 @Transactional
    events.publish(new OrderPlacedEvent(...));     // ⚠️ 事件被「丟掉」了
}
```

**機制**：`@TransactionalEventListener` 把自己註冊成一個
`TransactionSynchronization`（2.2.4 的第二個 ThreadLocal）。
**沒有交易 → 沒有同步器 → 沒有人會呼叫它。**

⚠️ **而它是完全靜默的** —— 不會有例外，不會有 log。

**兩種處理：**

```java
// 解法 A：明確允許「沒有交易時也執行」
@TransactionalEventListener(
        phase = TransactionPhase.AFTER_COMMIT,
        fallbackExecution = true)          // ★ 沒有交易 → 立刻同步執行
public void onOrderPlaced(OrderPlacedEvent event) { … }
```

```java
// 解法 B（★ shop-service 的選擇）：加一個開發期的守門
@Component
public class EventPublisherWithTransactionCheck implements DomainEventPublisher {

    private final ApplicationEventPublisher delegate;
    private final boolean strict;          // dev/test = true，prod = false

    @Override
    public void publish(DomainEvent event) {
        // ★★ 兩個條件都要 —— 這正是 TransactionalApplicationListenerMethodAdapter
        //    決定「要不要註冊成同步器」時檢查的條件。少檢查一個就會漏掉一半的情況。
        boolean willBeDelivered =
                TransactionSynchronizationManager.isSynchronizationActive()
             && TransactionSynchronizationManager.isActualTransactionActive();

        if (!willBeDelivered) {
            String msg = "在沒有交易的情況下發佈了 %s —— "
                       + "AFTER_COMMIT 的 listener 不會執行（2.12.2 陷阱 ①）";
            if (strict) {
                throw new IllegalStateException(msg.formatted(event.getClass().getSimpleName()));
            }
            log.error("[EVENT-LOST] " + msg, event.getClass().getSimpleName());
        }
        delegate.publishEvent(event);
    }
}
```

⚠️ **為什麼 shop-service 不用 `fallbackExecution = true`**：
因為「沒有交易時同步執行」會讓行為**依情境而異** ——
同一個 listener 有時在 commit 之後跑、有時立刻跑。
**讓它明確失敗，比讓它「有時候對」好。**

**陷阱 ②：`AFTER_COMMIT` 的例外會傳回呼叫端，但不會 rollback ★**

```java
@TransactionalEventListener        // 預設 AFTER_COMMIT，且沒有 @Async
public void onOrderPlaced(OrderPlacedEvent event) {
    throw new RuntimeException("寄信失敗");
}
```

**發生什麼**：交易**已經 commit 了**（步驟 ⑫），
而 `triggerAfterCommit`（步驟 ⑭）沒有包 try-catch
→ 例外沿著呼叫堆疊往上拋 → **Controller 收到 500**。

> 🔴 **結果：訂單建立成功，但使用者看到 500，然後按了重試。**

⚠️ 這是一個很糟的組合，而**兩種修法都必要**：

```java
// ① 用 @Async 把它推到另一條執行緒（例外留在那條執行緒上）
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
@Async("notificationExecutor")
public void onOrderPlaced(OrderPlacedEvent event) { … }

// ② 而且 listener 自己要 catch —— 因為 @Async 的例外會靜默消失，
//    除非設定了 AsyncUncaughtExceptionHandler
@Async("notificationExecutor")
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
public void onOrderPlaced(OrderPlacedEvent event) {
    try {
        email.send(OrderConfirmationMail.from(event));
    } catch (Exception e) {
        // ⚠️ 通知失敗屬於「可以遺失」那一類（00 章 0.3.1）→ warn 就好
        log.warn("訂單確認信寄送失敗：order={}", event.orderId(), e);
    }
}
```

⚠️ **但要注意 `AFTER_COMPLETION` 的行為不同**：
它被 `TransactionSynchronizationUtils.invokeAfterCompletion` 包在 try-catch 裡並記 log
→ **例外不會傳出去**。

> 📌 **這個差別（`AFTER_COMMIT` 會拋、`AFTER_COMPLETION` 不會）
> 沒有寫在大部分文件裡，而它決定了「一個失敗的 listener 會不會讓使用者看到 500」。**
> ⚠️ **請在你的環境實測驗證** —— 2.16 練習 3 就是這件事。

**陷阱 ③：`@Async` + `AFTER_COMMIT` 的執行緒池滿了**

```yaml
shop:
  async:
    notification:
      queue-capacity: 500
      rejection-policy: CALLER_RUNS      # ★ 00 章 0.11.3 的選擇
```

⚠️ **`CALLER_RUNS` 的意思是「佇列滿時，由呼叫端的執行緒執行」** ——
而 `AFTER_COMMIT` 的「呼叫端」是**那個剛 commit 完的 Tomcat 執行緒**。

**於是通知的壓力會回壓到請求執行緒上** —— 請求變慢，但不會遺失通知。

> 📌 **那是刻意的**（00 章 0.11.3 已說明）：
> **讓壓力可見，而不是靜默丟棄。**
> ⚠️ 但要知道它的極端情況：通知系統掛掉時，下單的 P99 會被拖慢。
> **如果「下單絕不能被通知拖慢」是硬需求，就要用 `ABORT` + outbox**（06 章 6.9）。

### 2.12.3 為什麼 `AFTER_COMMIT` 裡的寫入需要 `REQUIRES_NEW`

01 章 1.5.4 的 `PointGrantListener` 用了 `REQUIRES_NEW`，這裡解釋為什麼。

```java
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
public void onOrderPlaced(OrderPlacedEvent event) {
    points.grant(event.customerId(), 100);      // 🔴 這個寫入在哪個交易裡？
}
```

**回到 2.2.2**：`AFTER_COMMIT`（⑬）在 `doCommit()`（⑫）之後、
`cleanupAfterCompletion`（⑮）之前。

**所以此時的狀態是「介於兩者之間」的**：

| 狀態 | 值 | 後果 |
|---|---|---|
| `isActualTransactionActive()` | ⚠️ **仍然 `true`** | 所以「檢查有沒有交易」的守門在這裡**看不出問題** |
| `ConnectionHolder` 綁在 ThreadLocal 上 | ⚠️ **仍然綁著** | `JdbcTemplate` 會拿到**原本那條連線** |
| 那條連線的 `autoCommit` | `false` | 寫入不會自動生效 |
| **還會不會再 commit** | 🔴 **不會** | ⑫ 已經 commit 過了，之後只有 cleanup |

⚠️⚠️ **後果**：`points.grant()` 如果沒有自己的交易，
它的 INSERT 會**送進那條已經 commit 過的連線**，然後：

| 情況 | 結果 |
|---|---|
| 一般情況 | 🔴 **靜默地不生效**，或在 `cleanup` 把 `autoCommit` 設回 `true` 時被**意外**帶著 commit —— **行為取決於驅動** |
| JPA（`JpaTransactionManager`） | ⚠️ 可能拋 `TransactionRequiredException` |

> 🔴 **「行為取決於驅動」是這裡最糟的一點。**
> 它代表同一段程式碼在 MySQL 與 PostgreSQL 上可能不一樣，
> 在升級驅動之後也可能不一樣。
>
> 👉 Spring 自己的 javadoc 就是為此寫的：
> *「Use PROPAGATION_REQUIRES_NEW for any transactional operation that is called from here.」*

```java
// ✅ 正確
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
@Transactional(propagation = Propagation.REQUIRES_NEW)      // ★ 開一個全新的交易
@Async("notificationExecutor")
public void onOrderPlaced(OrderPlacedEvent event) { … }
```

⚠️ **為什麼是 `REQUIRES_NEW` 而不是 `REQUIRED`？**

**因為 `REQUIRED` 在這裡是「最糟的選項」**：

`isActualTransactionActive()` 仍然是 `true`（見上表）
→ `REQUIRED` 認為「已經有交易了，我加入它」
→ **加入了一個已經 commit 完、不會再 commit 的交易**
→ 🔴 **寫入靜默消失。**

`REQUIRES_NEW` 明確地說「我要一個全新的交易」——
它會掛起那個殘存的綁定、向池子要一條新連線、自己 commit。

> 📌 **一句話**：
> **`AFTER_COMMIT` + 寫資料庫 = 一定要 `REQUIRES_NEW`。這條沒有例外。**

### 2.12.4 事件會遺失

**這一節必須誠實：`@TransactionalEventListener` 不是可靠的訊息傳遞。**

**三種遺失的方式：**

| 遺失方式 | 說明 |
|---|---|
| **commit 之後、listener 執行之前，程序掛掉** | 事件只存在於記憶體 |
| `@Async` 的佇列被 `ABORT` 策略拒絕 | 直接丟掉 |
| listener 拋例外且被 catch | 沒有重試機制 |

**所以 00 章 0.3.1 的三分類必須嚴格遵守：**

```
必須原子     → 同一個交易裡（庫存、券、稽核）
不能遺失     → ⚠️ 事件不夠 → outbox 模式（06 章 6.9）
可以遺失     → ✅ 事件就夠（通知、清快取）
```

⚠️ **而「加點數」屬於中間那一類** —— 01 章 1.5.4 的
`PointGrantListener` 用了事件，**那是一個已知的簡化**，
它的 javadoc 明確寫了「06 章 6.9 的 outbox 才是正解」。

> 📌 **outbox 的核心想法一句話**：
> **把「要發的事件」與業務資料寫在同一個交易裡（同一張資料庫的 outbox 表），
> 再由一個獨立的輪詢器把它們送出去。**
> 於是「事件遺失」變成「事件延遲」。

---

## 2.13 診斷

### 2.13.1 證明「這個方法真的在交易裡」

**不要靠讀程式碼判斷。** 三種由弱到強的證明：

**證明 ① 執行期斷言（最快，開發時用）**

```java
package example.shop.common.tx;

/**
 * 交易狀態的檢查工具。
 *
 * <p>⚠️ 注意 {@code isActualTransactionActive()} 與
 * {@code isSynchronizationActive()} 的差別（2.2.4）——
 * 只有前者代表「真的有一個交易」。
 */
public final class Tx {

    public static String describe() {
        return "active=%s, name=%s, readOnly=%s, isolation=%s, sync=%s".formatted(
                TransactionSynchronizationManager.isActualTransactionActive(),
                TransactionSynchronizationManager.getCurrentTransactionName(),
                TransactionSynchronizationManager.isCurrentTransactionReadOnly(),
                TransactionSynchronizationManager.getCurrentTransactionIsolationLevel(),
                TransactionSynchronizationManager.isSynchronizationActive());
    }

    /** ★ 在「必須有交易」的地方呼叫它。比 MANDATORY 更精確的錯誤訊息。 */
    public static void requireActive(String what) {
        if (!TransactionSynchronizationManager.isActualTransactionActive()) {
            throw new IllegalStateException(
                    "%s 必須在交易裡執行，但現在沒有交易。%s".formatted(what, describe()));
        }
    }

    /** ★ 在「絕不可以有交易」的地方呼叫它（例如呼叫外部 API 之前）。 */
    public static void requireNoTransaction(String what) {
        if (TransactionSynchronizationManager.isActualTransactionActive()) {
            throw new IllegalStateException(
                    "%s 不可以在交易裡執行（00 章 0.10.1）。%s".formatted(what, describe()));
        }
    }

    private Tx() {}
}
```

**證明 ② 一個會紅燈的測試（★ 最可靠）**

```java
/**
 * ★★ 「交易健檢」：對每一個宣稱有交易的 use case，
 * 證明「中途失敗時前面的寫入真的不見了」。
 *
 * <p>它比「檢查 isActualTransactionActive」強，
 * 因為它測的是<b>結果</b>而不是<b>狀態</b>。
 */
class TransactionRollbackIntegrationTest extends MySqlIntegrationTestBase {

    @Autowired OrderApplicationService service;
    @Autowired JdbcTemplate jdbc;
    @Autowired DatabaseCleaner cleaner;
    @MockitoBean CouponRepository coupons;      // ⚠️ Boot 3.2/3.3 請改成 @MockBean

    @AfterEach void clean() { cleaner.clean(); }

    @Test
    void 券已用完時_訂單與庫存都回滾() {
        seedProduct("P-1", 10);
        given(coupons.findByCode("SPRING10")).willReturn(Optional.of(Coupons.valid()));
        given(coupons.tryConsume("SPRING10")).willReturn(false);       // ★ 最後一步失敗

        assertThatThrownBy(() -> service.create(
                        Commands.createOrder("P-1", 3).couponCode("SPRING10").build()))
                .isInstanceOf(CouponExhaustedException.class);

        // ★★ 三個斷言缺一不可
        assertThat(count("orders")).as("訂單沒有留下").isZero();
        assertThat(count("order_line")).as("明細沒有留下").isZero();
        assertThat(availableOf("P-1")).as("庫存被還回去了").isEqualTo(10);
        assertThat(count("audit_log")).as("稽核也回滾了（00 章判準 3 的決定）").isZero();
    }

    @Test
    void 冪等紀錄與訂單一起回滾() {
        // ⚠️ 這一個特別重要：如果冪等紀錄留下來而訂單沒有，
        //    使用者重試時會拿到「冪等紀錄指向不存在的訂單」→ 500，而且永遠卡住
        seedProduct("P-1", 10);
        given(coupons.tryConsume(any())).willThrow(new RuntimeException("boom"));

        assertThatThrownBy(() -> service.create(...)).isInstanceOf(RuntimeException.class);

        assertThat(count("order_idempotency")).isZero();
    }
}
```

⚠️ **第二個測試抓的是一個真實而且很惡劣的 bug**：
冪等紀錄留下但訂單沒有 → 使用者用同一個 key 重試 →
`orders.findById(existing)` 找不到 → `IllegalStateException` → **500，而且永遠是 500**。

**證明 ③ 從 MySQL 那一側看**

```sql
-- 現在有哪些交易在跑，各自跑多久、鎖了什麼
SELECT trx_id, trx_state,
       TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS seconds,
       trx_rows_locked, trx_rows_modified,
       LEFT(trx_query, 120) AS query
  FROM information_schema.innodb_trx
 ORDER BY trx_started;
```

```sql
-- MySQL 8.0.1+：誰在等誰
SELECT waiting_pid, waiting_query, blocking_pid, blocking_query, wait_age
  FROM sys.innodb_lock_waits;
```

> 📌 **`innodb_trx` 的 `seconds` 欄位是排查「連線池耗盡」的第一站**：
> 如果有一堆交易跑了 30 秒以上，答案就在那裡（2.9.2 的六件事）。

### 2.13.2 一組「交易政策」的守門測試

**把這一章的規則變成 CI 的一部分：**

```java
@AnalyzeClasses(packages = "example.shop", importOptions = ImportOption.DoNotIncludeTests.class)
class TransactionPolicyTest {

    // ── 2.7.2 的四個修飾詞 ──────────────────────────
    @ArchTest static final ArchRule 必須public =
            methods().that().areAnnotatedWith(Transactional.class).should().bePublic();
    @ArchTest static final ArchRule 不可final =
            methods().that().areAnnotatedWith(Transactional.class).should().notBeFinal();
    @ArchTest static final ArchRule 不可static =
            methods().that().areAnnotatedWith(Transactional.class).should().notBeStatic();

    // ── 2.6.4 的 checked exception 政策 ─────────────
    @ArchTest static final ArchRule 不宣告checked例外 = /* 2.6.4 的規則 */ null;

    // ── 2.3.3 的「只在 application 層」──────────────
    @ArchTest static final ArchRule 只在application層 =
            methods().that().areAnnotatedWith(Transactional.class)
                     .should().beDeclaredInClassesThat().resideInAnyPackage("..application..");

    /**
     * ★★ 2.9.2 的第 1 條：交易方法不可以（直接）呼叫外部埠。
     *
     * <p>⚠️ 它只抓得到「直接呼叫」——
     * {@code create() → helper() → gateway.charge()} 這種間接呼叫抓不到。
     * <b>所以它必須搭配 {@code PaymentGateway} 實作上的
     * {@code @Transactional(NEVER)}（2.3.6）</b>，那一層是執行期的、抓得到全部。
     */
    @ArchTest
    static final ArchRule 交易方法不可直接呼叫外部埠 =
            noMethods().that().areAnnotatedWith(Transactional.class)
                       .should().callMethodWhere(
                               JavaCall.Predicates.target(
                                       owner(resideInAPackage("..application.port.."))
                                       .and(HasName.Predicates.nameMatching(
                                               "charge|refund|push|send"))))
                       .because("交易裡不可以呼叫外部系統（00 章 0.10.1、2.9.2）");
}
```

⚠️ **注意那條 javadoc 說的「靜態規則抓不到間接呼叫」。**

> 📌 **這是 ArchUnit 的一般限制，而正確的回應是「兩層都放」**：
> **靜態規則抓明顯的、執行期的 `NEVER` 抓全部。**
> 這與 00 章 0.8.3「不變量守在四個位置」是同一個思路。

### 2.13.3 生產環境的三個指標

| 指標 | 從哪來 | 警戒值 |
|---|---|---|
| `hikaricp.connections.pending` | Micrometer（Actuator 自動提供） | **> 0 持續 10 秒** = 池子不夠或交易太長 |
| `hikaricp.connections.usage`（P99） | 同上 | > 交易 timeout 的一半 |
| 鎖等待次數 | `SHOW GLOBAL STATUS LIKE 'Innodb_row_lock_waits'` 的差值 | 任何明顯的成長都值得看 |
| 平均鎖等待時間 | `Innodb_row_lock_time_avg` | > 100 ms |

⚠️ **死鎖次數沒有標準的狀態變數。**
`Innodb_deadlocks` 是 **Percona Server / MariaDB** 才有的；
原生 MySQL 8.0 要靠 `innodb_print_all_deadlocks = ON` 把每一次死鎖寫進 error log，
再由 log 收集器算次數。

> 📌 **這種「以為有、其實沒有」的指標很常見**，
> 而它的症狀是「監控儀表板上那一格永遠是 0」——
> **看起來像「沒有死鎖」，實際上是「沒有在量」。**

⚠️ **`connections.pending` 是最有價值的一個** ——
它直接回答「有沒有請求在排隊等連線」，
而那正是 00 章 0.3.2 事故 1 在爆發**之前**的訊號。

```yaml
management:
  endpoints.web.exposure.include: health,metrics,prometheus
  metrics.tags.application: shop-service
```

---
## 2.14 shop-service 的交易政策（總表）

**這張表是整章的產出，也是最常被回頭查的東西。**

| # | 政策 | 出自 | 守門人 |
|---|---|---|---|
| 1 | `@Transactional` 只加在 `..application..` 的 **public、非 final、非 static** 方法上 | 2.3.3、2.7.2 | ArchUnit ×4 |
| 2 | **`@Transactional` 不加在介面上** | 2.5.1 | code review |
| 3 | 被編排的元件（loader / factory / calculator / mapper）**不標交易** | 2.3.3 | ArchUnit（政策 1 的副作用） |
| 4 | 查詢方法一律 `readOnly = true` | 2.5.2 | ⚠️ 沒有自動守門 —— 靠 code review 與讀寫分離的 metric |
| 5 | 所有業務例外繼承 `RuntimeException`；**`@Transactional` 方法不宣告 checked exception** | 2.6.4 | ArchUnit |
| 6 | 交易裡**不**呼叫外部系統：埠的實作標 `@Transactional(NEVER)` | 2.3.6、2.9.2 | 執行期 + ArchUnit |
| 7 | 依賴外層交易的原子操作標 `@Transactional(MANDATORY)`（`tryReserve`、`tryConsume`、`findByIdForUpdate`） | 2.3.6 | 執行期 |
| 8 | `REQUIRES_NEW` 只用於三種情況（獨立紀錄 / 批次一筆一交易 / `AFTER_COMMIT` 寫入） | 2.3.4 | code review + 2.3.7 的表 |
| 9 | **不用 `NESTED`** | 2.3.5 | code review |
| 10 | 隔離級別一律用資料庫預設；需要最新資料時用**當前讀** | 2.4.5 | code review |
| 11 | `spring.transaction.default-timeout: 10s`；`leak-detection-threshold: 15s` | 2.5.3 | 設定檔 |
| 12 | **多個商品扣庫存前先依 `productId` 排序**（固定鎖順序） | **2.11.9** | ⚠️ **本章新增，見下方** |
| 13 | `AFTER_COMMIT` + 寫資料庫 = **一定** `REQUIRES_NEW` + `@Async` + 自己 catch | 2.12.3 | code review |
| 14 | 發佈事件前必須有交易（`EventPublisherWithTransactionCheck`） | 2.12.2 | 執行期（dev/test 嚴格） |
| 15 | 交易測試**不用** `@Transactional` 自動 rollback，改用 `DatabaseCleaner` | 2.2.5 | ⚠️ 靠約定 |

### 2.14.1 本章回頭修正 00／01 章的三處

沿用「後面的章節修正前面的，每一處標理由」的做法。

**① `create()` 扣庫存前要先排序（政策 12）★**

**位置**：00 章 0.9.4 第 ④ 步、01 章 1.2.5 第 ③ 步

```java
// ── 修正前 ────────────────────────────────
for (int i = 0; i < cmd.lines().size(); i++) {
    var line = cmd.lines().get(i);
    if (!stock.tryReserve(line.productId(), line.quantity())) { … }
}
```

```java
// ── 修正後 ────────────────────────────────
// ★★ 依 productId 排序 —— 所有交易的鎖順序一致 → 死鎖不可能發生（2.11.9）
//    ⚠️ 但要保留原始索引，否則錯誤訊息的 items[i] 會指向錯的那一列
record IndexedLine(int originalIndex, CreateOrderCommand.Line line) {}

List<IndexedLine> ordered = IntStream.range(0, cmd.lines().size())
        .mapToObj(i -> new IndexedLine(i, cmd.lines().get(i)))
        .sorted(Comparator.comparing(il -> il.line().productId()))
        .toList();

for (IndexedLine il : ordered) {
    if (!stock.tryReserve(il.line().productId(), il.line().quantity())) {
        throw insufficientStock(cmd, ctx, il.line(), il.originalIndex());
    }
}
```

⚠️ **為什麼 00 章沒有寫這一段**：因為那時候還沒有講鎖。
**而這正是「交易與併發要放在同一章」的理由** ——
00 章可以講「原子 UPDATE 解決超賣」，
但「多個原子 UPDATE 之間會互相死鎖」需要先理解行鎖。

**② `OrderNumberGenerator` 的實作（2.11.4）**

00 章 0.12 ⑩ 的 javadoc 說「02 章 2.11.4 會實作它」——
本章給了三種做法並選了 C（獨立短交易），
**同時明確承認它的代價：訂單編號會有洞**。

👉 **而那個代價要寫進 `OrderNumber` 的 javadoc**，否則
下一個人會把「編號不連續」當成 bug 來修：

```java
/**
 * 訂單編號，格式 {@code ORD-yyyyMMdd-NNNN}。
 *
 * <p>⚠️⚠️ <b>序號會有洞。</b>下單失敗時取到的號不會還回去（02 章 2.11.4 做法 C）。
 * 這是刻意用「連續性」換「併發能力」的結果 ——
 * <b>不要把它當 bug 修</b>。
 * 需要連續的場景（發票號碼）必須用另一套機制。
 */
public record OrderNumber(String value) { … }
```

**③ `StockPort` 補上 `findByProductIdForUpdate`**

00 章 0.12 ⑩ 的 `StockPort` 刻意只有 `tryReserve` / `release` / `snapshot`
（「不提供 `findByProductId` 是為了讓錯誤的用法不方便」）。

⚠️ **但 2.11.3 的「盤點調整」真的需要悲觀鎖**，所以補上它 ——
**而它的 javadoc 必須說清楚「什麼時候可以用」**：

```java
public interface StockPort {

    boolean tryReserve(String productId, int quantity);
    void release(String productId, int quantity);
    Optional<StockSnapshot> snapshot(String productId);

    /**
     * ★ 悲觀鎖：鎖住那一列並回傳最新的庫存。
     *
     * <p>⚠️⚠️ <b>下單路徑不可以用它</b> —— 用 {@link #tryReserve}。
     * 它序列化了同一個商品的所有操作（2.11.3），
     * 在熱門商品上會讓下單吞吐量降到 {@code 1 ÷ 交易長度}。
     *
     * <p>👉 它只給「需要在讀與寫之間做複雜判斷」的<b>低頻</b>路徑用：
     * 盤點調整、退貨入庫、人工修正。
     *
     * <p>⚠️ 呼叫它必須在交易裡 —— 實作標了 {@code @Transactional(MANDATORY)}。
     */
    Optional<Stock> findByProductIdForUpdate(String productId);
}
```

> 📌 **注意這裡的手法**：00 章說「介面的設計可以讓錯誤的用法不方便」，
> 而現在我們**必須**加一個「危險的」方法。
> **正確的做法不是不加，而是讓它的名字與 javadoc 說清楚代價。**

**④ `Order` 補上 `version`（樂觀鎖，2.11.6）**

```java
// 加在 order/domain/Order.java

/**
 * ★ 樂觀鎖的版本號。
 *
 * <p>⚠️⚠️ 它是一個<b>持久化的細節洩漏到 Domain</b> —— 而這是一個刻意的妥協。
 *
 * <p>三個選項與代價：
 * <table>
 *   <tr><th>做法</th><th>代價</th></tr>
 *   <tr><td>放在 {@code Order} 上（現在的做法）</td>
 *       <td>⚠️ Domain 認識了一個純技術概念</td></tr>
 *   <tr><td>放在 Repository 的一個 {@code Map&lt;id, version&gt;} 裡</td>
 *       <td>🔴 「同一個聚合被讀兩次」時版本會錯亂</td></tr>
 *   <tr><td>包一層 {@code Versioned&lt;Order&gt;}</td>
 *       <td>⚠️ 每一個呼叫點都多一層 {@code .value()}</td></tr>
 * </table>
 *
 * <p>👉 選第一個，因為<b>它同時是一個領域概念</b>：
 * 04-controller 6.8 的 {@code ETag} 就是它 ——
 * 而「客戶端拿著舊版本來改」是一個要回 <b>412</b> 的業務結果，不只是技術細節。
 */
private long version;

public long version() { return version; }

/**
 * ★ Repository 成功寫入之後呼叫，讓記憶體裡的版本跟上資料庫。
 *
 * <p>⚠️ 它是 package-private —— 只有同套件的 Repository 實作可以呼叫。
 * <b>不可以是 public</b>：那會讓任何人都能偽造版本號，
 * 而樂觀鎖的保證就沒了。
 *
 * <p>⚠️⚠️ 而它是 {@code Order} 上<b>唯一</b>一個「不表達業務意圖」的方法 ——
 * 這件事本身就是「version 是一個妥協」的證據。
 */
void markVersionIncremented() { this.version++; }
```

⚠️ **`markVersionIncremented()` 是 package-private，但 `JdbcOrderRepository` 在
`order.infrastructure` 套件** —— 不同套件，**呼叫不到**。

**三個選項：**

| 選項 | 代價 |
|---|---|
| 把 Repository 實作搬到 `order.domain` | 🔴 違反 00 章 0.11.2 的分層規則 |
| 讓 `markVersionIncremented()` 是 `public` | ⚠️ 可以被偽造，但實際風險很低 |
| **在 `order.domain` 放一個 package-private 的「回寫器」** | ⚠️ 多一個類別，但邊界清楚 |

👉 **shop-service 選第二個並在 javadoc 明說**：
「這個方法只給 Repository 呼叫，呼叫它不會做任何驗證」——
**因為第三個選項的複雜度換來的安全性，在這個規模上不划算**。

⚠️ **而這是一個「Java 的套件可見性不夠用」的真實例子**。
Java 9 的 module system 可以表達它（`exports ... to ...`），
但一個單體應用引入 JPMS 的成本遠高於這個問題。

**⑤ 本章用到、但定義在後面章節的兩個方法**

| 方法 | 用在哪 | 定義在 |
|---|---|---|
| `Order.changeShippingAddress(patch, actor, now)` | 2.11.5 | 04-controller 0.14 練習 4 的規格；聚合方法在 **本站 04 章**。⚠️ **簽章在 03 章 3.6.6 ④ 被改掉了**：地址必填（I2）→ 不需要三態，而且改地址要同時換 `ShippingSnapshot` → 收 `ShippingAddress` 而不是 `patch` |
| `Payment.prepareRefund(id, amount, reason, actor, now)` | 2.16 練習 2 | **04 章**（與 `markRefunded` 一起，見 00 章 0.9.5 那個紅燈測試） |

⚠️ **它們與 00 章 0.9.5 的
`狀態機的每一條邊都有對應的操作` 是同一個缺口** ——
退貨/退款那一整條路徑要到 04 章才補齊。

---

## 2.15 常見誤區

**誤區 1：「加了 `@Transactional` 就有交易」**

2.7 的五種情境。而其中四種**完全沒有警告**。

👉 **判斷法**（2.7.6）：`TransactionSynchronizationManager.isActualTransactionActive()`。

---

**誤區 2：「有交易就不會有併發問題」**

2.11.2。交易保證的是 **A**（原子性），不是「序列化」。
**兩個交易仍然可以同時通過同一個 `if`。**

---

**誤區 3：「`timeout = 5` 保證這個方法 5 秒內結束」**

2.5.3。它只在「下一次碰資料庫」時檢查。
純運算與外部 API 呼叫**完全不受它管**。

---

**誤區 4：「checked exception 也會 rollback」**

2.6.1。**不會。** 而這是最貴的一個誤會，因為它靜默地 commit 一半的資料。

👉 shop-service 的解法不是「每個都加 `rollbackFor`」，
而是「**讓 `@Transactional` 方法不宣告 checked exception**」（2.6.4）。

---

**誤區 5：「看到 `UnexpectedRollbackException` 就把內層改成 `REQUIRES_NEW`」**

2.8.4。那會讓例外消失，但把「大聲失敗」換成「靜默的資料不一致」。

---

**誤區 6：「`readOnly = true` 只是效能優化」**

2.5.2。它還是**讀寫分離的路由依據** ——
沒標的話那個查詢永遠打 primary。

⚠️ 而它**不是**安全機制：唯讀交易裡改了 Entity 是靜默失敗。

---

**誤區 7：「`REQUIRES_NEW` 就是獨立的，很安全」**

2.3.4 的三個代價。特別是**它同時佔用兩條連線** ——
連線池 = 10 而併發 = 10 時，系統會**把自己鎖死**。

---

**誤區 8：「`SELECT ... FOR UPDATE` 可以防止重複插入」**

2.11.3。**找不到列時它不鎖任何東西。**
「同一個鍵只能有一筆」的正解是 **UNIQUE 約束**。

---

**誤區 9：「MySQL 的 RR 完全沒有幻讀」**

2.4.3。快照讀沒有，當前讀靠間隙鎖擋住大部分，
但「快照讀 + 當前寫」混用時會出現
「SELECT 查不到卻 UPDATE 改到了」這種情況。

---

**誤區 10：「死鎖是資料庫的問題」**

2.11.9。**死鎖幾乎總是「應用以不同順序鎖同一組列」造成的**，
而解法（固定鎖順序）在應用這一側。

---

**誤區 11：「事件是可靠的」**

2.12.4。`@TransactionalEventListener` 是**記憶體裡的**機制。
程序掛掉、佇列滿、listener 拋例外 —— 事件就沒了。

👉 「不能遺失」的東西要用 outbox（06 章 6.9）。

---

**誤區 12：「測試加 `@Transactional` 自動 rollback 很方便」**

2.2.5。⚠️ **在這一章它是有害的**：
被測的 Service 會**加入**測試的交易，
於是你測不到「它自己的交易到底有沒有 commit」。

---

**誤區 13：「把隔離級別調高比較安全」**

2.4.5。調高不能解決 TOCTOU（除了 `SERIALIZABLE`，而它會讓吞吐量崩掉），
只會增加鎖與死鎖。

👉 **正確做法是在需要的地方用當前讀，而不是全域調高。**

---

**誤區 14：「`@Async` 的方法會繼承呼叫端的交易」**

2.7.4。**不會。** 交易綁在 `ThreadLocal` 上，換執行緒等於換一個世界。

---
## 2.16 本章練習

### 練習 1：預測這 12 段程式碼的結果

**每一題都問同一件事：資料庫最後長什麼樣？** 先自己回答再看答案。

```java
// ① ────────────────────────────────────────────
@Transactional
public void a() {
    jdbc.update("INSERT INTO t(k) VALUES ('a1')");
    throw new IOException("boom");        // checked
}

// ② ────────────────────────────────────────────
@Transactional
public void b() {
    jdbc.update("INSERT INTO t(k) VALUES ('b1')");
    this.bInner();                        // 同類別
}
@Transactional(propagation = REQUIRES_NEW)
public void bInner() {
    jdbc.update("INSERT INTO t(k) VALUES ('b2')");
    throw new IllegalStateException();
}

// ③ ────────────────────────────────────────────
@Transactional
public void c() {
    jdbc.update("INSERT INTO t(k) VALUES ('c1')");
    try { inner.requiredThrows("c2"); }   // 別的 bean，REQUIRED
    catch (Exception e) { }
}

// ④ ────────────────────────────────────────────
@Transactional
public void d() {
    jdbc.update("INSERT INTO t(k) VALUES ('d1')");
    try { inner.requiresNewThrows("d2"); }
    catch (Exception e) { }
}

// ⑤ ────────────────────────────────────────────
@Transactional(readOnly = true)
public void e() {
    jdbc.update("INSERT INTO t(k) VALUES ('e1')");   // JdbcTemplate，不是 JPA
}

// ⑥ ────────────────────────────────────────────
@Transactional
public void f() {
    jdbc.update("INSERT INTO t(k) VALUES ('f1')");
    List.of("f2", "f3").parallelStream()
        .forEach(k -> jdbc.update("INSERT INTO t(k) VALUES (?)", k));
    throw new IllegalStateException();
}

// ⑦ ────────────────────────────────────────────
@Transactional
private void g() {                        // private
    jdbc.update("INSERT INTO t(k) VALUES ('g1')");
    throw new IllegalStateException();
}

// ⑧ ────────────────────────────────────────────
public void h() {                         // 沒有 @Transactional
    events.publish(new SomethingHappened("h1"));
}
@TransactionalEventListener                // AFTER_COMMIT
public void onH(SomethingHappened e) {
    jdbc.update("INSERT INTO t(k) VALUES ('h2')");
}

// ⑨ ────────────────────────────────────────────
@Transactional
public void i() {
    jdbc.update("INSERT INTO t(k) VALUES ('i1')");
    events.publish(new SomethingHappened("i2"));
    throw new IllegalStateException();
}
@TransactionalEventListener                // AFTER_COMMIT
public void onI(SomethingHappened e) {
    jdbc.update("INSERT INTO t(k) VALUES ('i2')");
}

// ⑩ ────────────────────────────────────────────
@Transactional
public void j() {
    jdbc.update("INSERT INTO t(k) VALUES ('j1')");
    dataSource.getConnection().createStatement()
              .execute("INSERT INTO t(k) VALUES ('j2')");
    throw new IllegalStateException();
}

// ⑪ ────────────────────────────────────────────
@Transactional(noRollbackFor = IllegalStateException.class)
public void k() {
    jdbc.update("INSERT INTO t(k) VALUES ('k1')");
    inner.requiredThrows("k2");           // 別的 bean，REQUIRED，拋 IllegalStateException
}

// ⑫ ────────────────────────────────────────────
@Transactional(timeout = 1)
public void l() throws InterruptedException {
    jdbc.update("INSERT INTO t(k) VALUES ('l1')");
    Thread.sleep(3000);
    jdbc.update("INSERT INTO t(k) VALUES ('l2')");
}
```

<details>
<summary>答案</summary>

| # | 結果 | 為什麼 |
|---|---|---|
| ① | **`a1` 留下** | 2.6.1：checked exception 預設 commit 🔴 |
| ② | **`b1` 留下，`b2` 不見** | ⚠️ **陷阱題**：`this.bInner()` 是自呼叫（2.7.1）→ `REQUIRES_NEW` **沒生效** → `bInner` 在同一個交易裡 → 例外傳出 `b()` → **全部回滾**。<br>👉 **正確答案是「兩筆都不見」** |
| ③ | **全部不見**，而且拋 `UnexpectedRollbackException` | 2.8：內層 `REQUIRED` 失敗 → 標記 rollback-only → catch 無效 |
| ④ | **`d1` 留下，`d2` 不見** | 2.3.2：`REQUIRES_NEW` 的 inner 失敗，outer 可以 catch 並 commit ✅ |
| ⑤ | **`e1` 留下** | ⚠️ `readOnly` 對 `JdbcTemplate` **不阻止寫入**（2.5.2）——它只設 `Connection.setReadOnly(true)`，而 MySQL 在唯讀交易裡執行 DML 會拋錯。<br>👉 **實際結果取決於驅動與版本**：Connector/J 送了 `SET SESSION TRANSACTION READ ONLY` 的話會拋 `SQLException`；沒送的話會成功。**這一題請務必實測**（2.16 練習 4） |
| ⑥ | **`f1` 不見；`f2`、`f3` 留下** 🔴 | 2.7.4：`parallelStream` 換執行緒 → 沒有交易 → autoCommit |
| ⑦ | **`g1` 留下**（而且交易根本沒開） | 2.7.2：private → 屬性讀不到 → autoCommit → 例外傳出但資料已寫入 |
| ⑧ | **`h2` 不見**（listener 根本沒執行）🔴 | 2.12.2 陷阱 ①：沒有交易 → 沒有同步器 → 靜默丟棄 |
| ⑨ | **`i1` 不見；`i2` 也不見** | `AFTER_COMMIT` 只在 commit 成功時觸發；這裡 rollback 了 |
| ⑩ | **`j1` 不見；`j2` 留下** 🔴 | 2.2.4 推論 ③：`dataSource.getConnection()` 拿到的是**另一條**連線，不在交易裡。<br>⚠️ **而且那條連線沒有 close → 連線洩漏** |
| ⑪ | **`k1` 留下？** ⚠️ **不是** —— 仍然拋 `UnexpectedRollbackException` | ★ **這是最有價值的一題**：`noRollbackFor` 只影響「**外層**要不要因為這個例外而 rollback」，但**內層 `REQUIRED` 已經把交易標記成 rollback-only 了**（2.8.1 的步驟 ④）。<br>👉 **`noRollbackFor` 救不了「內層標記的 rollback-only」** |
| ⑫ | **`l1` 不見** —— 第二個 `update` 拋 `TransactionTimedOutException` | 2.5.3：`Thread.sleep` 不會被中斷，但**下一次碰資料庫**時檢查逾時 → 整個交易回滾 |

⚠️ **② 與 ⑪ 是這一題組的重點**，它們示範了同一件事：

> **「我設定了 X」不等於「X 生效了」。**
> ② 的 `REQUIRES_NEW` 被自呼叫吃掉，
> ⑪ 的 `noRollbackFor` 被內層的 rollback-only 蓋過。

</details>

---

### 練習 2：修好這段程式碼的 9 個交易問題

```java
@Service
@Transactional
public class RefundServiceImpl implements RefundService {

    @Autowired private OrderRepository orderRepository;
    @Autowired private RefundRepository refundRepository;
    @Autowired private PaymentGateway gateway;
    @Autowired private JavaMailSender mailSender;
    @Autowired private StringRedisTemplate redis;

    public RefundResult refund(String orderId, BigDecimal amount, String reason)
            throws RefundException {

        Order order = orderRepository.findById(orderId).get();

        // 已退款總額
        BigDecimal refunded = refundRepository.sumByOrderId(orderId);
        if (refunded.add(amount).compareTo(order.getTotal()) > 0) {
            throw new RefundException("退款超過付款金額");
        }

        Refund refund = new Refund();
        refund.setOrderId(orderId);
        refund.setAmount(amount);
        refund.setStatus("PROCESSING");
        refundRepository.save(refund);

        // 呼叫金流
        GatewayRefundResponse resp = gateway.refund(order.getPaymentId(), amount);

        if (resp.isSuccess()) {
            refund.setStatus("SUCCESS");
            refundRepository.save(refund);
            order.setStatus("REFUNDED");
            orderRepository.save(order);
        } else {
            refund.setStatus("FAILED");
            refundRepository.save(refund);
        }

        redis.delete("order:" + orderId);
        mailSender.send(buildRefundMail(order, refund));

        this.recordAudit(orderId, amount, reason);

        return new RefundResult(resp.isSuccess(), refund.getId());
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    private void recordAudit(String orderId, BigDecimal amount, String reason) {
        auditRepository.save(new AuditLog("REFUND", orderId, amount + "/" + reason));
    }
}
```

<details>
<summary>答案</summary>

| # | 問題 | 節次 | 嚴重度 |
|---|---|---|---|
| 1 | **在交易裡呼叫金流** | 2.9.2 | 🔴🔴 逾時 30 秒 = 佔連線 30 秒（0.3.2 事故 1） |
| 2 | **「退款超過付款」的檢查有 TOCTOU** | 2.11.2 | 🔴🔴 兩個客服同時退 → 突破上限 → **直接資金損失**（不變量 I8） |
| 3 | **`throws RefundException`（checked）→ 不會 rollback** | 2.6.1 | 🔴 已寫入的 `PROCESSING` 紀錄留下來 |
| 4 | **`recordAudit` 是 private + 自呼叫** | 2.7.1、2.7.2 | 🔴 `REQUIRES_NEW` **完全沒生效**（雙重失效） |
| 5 | **`redis.delete` 在交易裡且在 commit 之前** | 2.9.2、2.12 | 🔴 交易回滾但快取已清；而且 Redis 逾時會佔連線 |
| 6 | **寄信在交易裡** | 2.9.2 | 🔴 回滾了信也寄出去了（0.3.2 事故 2） |
| 7 | **類別層 `@Transactional`** | 2.5.2 | ⚠️ 查詢方法也開可寫交易 |
| 8 | **`findById(...).get()`** | 01 章 1.8.3 | ⚠️ 不存在 → 500 而不是 404 |
| 9 | **「金流結果未知」完全沒處理** | 2.9.2、01 章 1.7.2 | 🔴🔴 `gateway.refund` 逾時拋例外 → 交易回滾 → **但錢可能已經退了，而我們沒有任何紀錄** |

**⑩ 額外**：字串狀態、`BigDecimal` 沒有幣別、稽核的 `detail` 用字串串接。

**重構後的形狀（三段式，00 章練習 4 的答案的變體）：**

```java
@Service
public class RefundApplicationService {

    private final RefundAttemptRecorder attempts;   // ★ REQUIRES_NEW 的獨立 bean
    private final RefundCompletionService completion;
    private final RefundPort refundPort;            // ★ 實作標 @Transactional(NEVER)
    private final DomainEventPublisher events;
    private final Clock clock;

    /**
     * 退款。
     *
     * <p>★★ 三段式，而<b>中間那一段不在交易裡</b>：
     * <ol>
     *   <li>{@code REQUIRES_NEW} 交易：檢查不變量 I8（帶鎖）+ 寫一筆 PROCESSING → commit</li>
     *   <li><b>交易外</b>：呼叫金流</li>
     *   <li>{@code REQUIRES_NEW} 交易：依結果更新狀態 + 發事件</li>
     * </ol>
     *
     * <p>⚠️ 第 ① 步先 commit 的理由：<b>讓「我們嘗試過退款」在資料庫留下痕跡</b>。
     * 沒有它的話，第 ② 步逾時（結果未知）時我們什麼都不知道。
     *
     * @throws RefundExceedsPaymentException 超過可退金額（不變量 I8）
     */
    public RefundResult refund(RefundCommand cmd) {
        Instant now = clock.instant();

        // ── ① 獨立交易：檢查 + 記錄 ──────────────────
        Refund refund = attempts.startAttempt(cmd, now);

        // ── ② 交易外：呼叫金流 ──────────────────────
        RefundAcceptance acceptance;
        try {
            acceptance = refundPort.refund(toRequest(refund, cmd));
        } catch (RefundGatewayTimeoutException e) {
            // ★★ 結果未知 → 什麼都不改，交給對帳排程（01 章 1.7.2）
            //    ⚠️ 絕對不可以標記成 FAILED
            log.error("[RECONCILE] 退款結果未知，等待對帳：refund={}", refund.id(), e);
            return RefundResult.outcomeUnknown(refund);
        }

        // ── ③ 獨立交易：依結果更新 ──────────────────
        return completion.complete(refund.id(), acceptance, now);
    }
}
```

```java
@Component
public class RefundAttemptRecorder {

    /**
     * ★ 不變量 I8 的守法：<b>鎖住 payment 那一列</b>再算。
     *
     * <p>⚠️ 光是 {@code SUM} 再 {@code if} 是不夠的（2.11.2）——
     * 兩個客服同時退款會各自算到同一個總額。
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW, timeout = 5)
    public Refund startAttempt(RefundCommand cmd, Instant now) {
        // ★ 悲觀鎖：同一筆付款的退款操作被序列化
        Payment payment = payments.findByIdForUpdate(cmd.paymentId())
                .orElseThrow(() -> new ResourceNotFoundException("Payment", cmd.paymentId()));

        // ★ 規則在 domain（00 章 0.12 ④ 的 Payment.refund）
        Refund refund = payment.prepareRefund(
                ids.newRefundId(), cmd.amount(), cmd.reason(), cmd.actor(), now);

        payments.save(payment);
        refunds.save(refund);
        return refund;
    }
}
```

⚠️ **注意 `startAttempt` 用了 `REQUIRES_NEW` 而它是整個流程的第一步** ——
外面**沒有**交易，所以它實際上等同 `REQUIRED`。

**那為什麼要標 `REQUIRES_NEW`？**

> 因為它宣告了一個**不變條件**：
> **「這一段永遠是一個獨立的、會自己 commit 的交易」** ——
> 即使將來有人把 `refund()` 包進另一個交易裡。
>
> ⚠️ 而如果沒標，那個「將來」會讓第 ① 步的 commit 被延後到外層結束
> —— 於是「先留痕跡」這個設計目的就消失了，**而且沒有任何警告**。

</details>

---

### 練習 3：寫三個「證明框架行為」的測試

**任務**：本章有三個「請在你的環境實測」的斷言。把它們寫成測試。

1. `AFTER_COMMIT` 的 listener 拋例外時，例外會不會傳到呼叫端？（2.12.2 陷阱 ②）
2. `AFTER_COMPLETION` 的 listener 拋例外時呢？
3. `@Transactional(readOnly = true)` 裡用 `JdbcTemplate` 寫入會怎樣？（練習 1 ⑤）

<details>
<summary>答案</summary>

```java
class FrameworkBehaviourProbeTest extends MySqlIntegrationTestBase {

    @Autowired ProbeService probe;
    @Autowired JdbcTemplate jdbc;
    @Autowired DatabaseCleaner cleaner;

    @AfterEach void clean() { cleaner.clean(); }

    /**
     * ★★ 1 —— 這個測試的價值不在「哪個答案是對的」，
     * 而在<b>把答案釘住</b>：升級 Spring 版本時它會告訴你行為變了。
     */
    @Test
    void AFTER_COMMIT的listener拋例外時_例外傳到呼叫端而且資料已commit() {
        assertThatThrownBy(() -> probe.publishAndFailInAfterCommit("x1"))
                .as("如果這裡沒有拋例外，代表 Spring 把它吞了 —— 更新 2.12.2")
                .isInstanceOf(RuntimeException.class)
                .hasMessageContaining("listener 失敗");

        // ★★ 這一行才是重點：交易「已經 commit 了」
        assertThat(count("x1"))
                .as("使用者看到 500，但資料其實存進去了 —— 這正是 2.12.2 的危險")
                .isEqualTo(1);
    }

    @Test
    void AFTER_COMPLETION的listener拋例外時_例外被吞掉() {
        assertThatCode(() -> probe.publishAndFailInAfterCompletion("x2"))
                .as("TransactionSynchronizationUtils 會 catch 並記 log")
                .doesNotThrowAnyException();

        assertThat(count("x2")).isEqualTo(1);
    }

    /**
     * ★ 3 —— 這一題的答案取決於驅動設定，所以測試要「記錄實際行為」而不是「假設」。
     */
    @Test
    void readOnly交易裡用JdbcTemplate寫入() {
        // ⚠️ 兩種可能的結果都寫下來，讓測試明確地選一個
        assertThatThrownBy(() -> probe.writeInReadOnlyTransaction("x3"))
                .as("""
                    Connector/J 的 readOnlyPropagatesToServer 預設 true
                    → 送 SET SESSION TRANSACTION READ ONLY
                    → MySQL 對 DML 回 ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION (1792)
                    ⚠️ 如果這個測試失敗（沒有拋例外），代表你的驅動設定不同 ——
                       那 2.5.2 的「唯讀不是安全機制」就更成立了""")
                .isInstanceOf(org.springframework.dao.DataAccessException.class);

        assertThat(count("x3")).isZero();
    }
}
```

```java
@Component
public class ProbeService {

    @Transactional
    public void publishAndFailInAfterCommit(String key) {
        jdbc.update("INSERT INTO t(k) VALUES (?)", key);
        events.publishEvent(new ProbeEvent(key, Phase.AFTER_COMMIT));
    }

    @Transactional
    public void publishAndFailInAfterCompletion(String key) {
        jdbc.update("INSERT INTO t(k) VALUES (?)", key);
        events.publishEvent(new ProbeEvent(key, Phase.AFTER_COMPLETION));
    }

    @Transactional(readOnly = true)
    public void writeInReadOnlyTransaction(String key) {
        jdbc.update("INSERT INTO t(k) VALUES (?)", key);
    }
}

@Component
public class ProbeListener {

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onAfterCommit(ProbeEvent e) {
        if (e.phase() == Phase.AFTER_COMMIT) throw new RuntimeException("listener 失敗");
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMPLETION)
    public void onAfterCompletion(ProbeEvent e) {
        if (e.phase() == Phase.AFTER_COMPLETION) throw new RuntimeException("listener 失敗");
    }
}
```

> 📌 **這一類測試有一個名字：「特性測試」（characterization test）。**
> 它不斷言「應該怎樣」，它斷言「**現在就是這樣**」——
> 於是行為改變時你會知道。
>
> ⚠️ **而課程裡每一個「請以你的環境實測為準」的地方，都該有一個這種測試。**

</details>

---

### 練習 4：設計「一張優惠券每人限用 2 次」的併發防護

**需求**：
- 一張券全站限量 10,000 張（已有 `coupon.used_count` 的原子 UPDATE）。
- **新需求**：同一個客戶最多用 2 次。
- 下單量尖峰 800 TPS，其中約 15% 使用優惠券。

**任務**：
1. 判斷這是哪一種競爭。
2. 給出至少兩種做法並比較。
3. 寫出你選的那一種的 schema、程式碼與併發測試。

<details>
<summary>答案</summary>

**1. 競爭的種類**

兩個交易各自 INSERT **一筆新的**使用紀錄 → **寫偏斜**（2.11.1 ③）。

⚠️ 注意它與「全站限量」不同：後者是同一列的加減（原子 UPDATE 就夠），
前者是「不存在的列」的競爭。

**2. 三種做法**

| 做法 | 機制 | 800 TPS 下的表現 | 缺點 |
|---|---|---|---|
| **A. 鎖客戶那一列** | `SELECT ... FOR UPDATE customers WHERE id = ?` | ⚠️ 把**同一個客戶的所有下單**序列化 —— 而那本來就很少併發，所以**可以接受** | 🔴 但它讓「下單」依賴 customer 表的鎖，多一個耦合 |
| **B. UNIQUE 約束 + 應用算序號** ★ | `PRIMARY KEY (coupon_code, customer_id, seq)`，`seq ∈ {1,2}` | ✅ 沒有鎖等待，衝突時 `DuplicateKeyException` | ⚠️ 需要處理重複鍵例外，而且 `seq` 要正確地算 |
| **C. 原子 UPDATE 到一張計數表** | `INSERT ... ON DUPLICATE KEY UPDATE used = used + 1` + `CHECK (used <= 2)` | ✅ 一句 SQL，最快 | ⚠️ MySQL 的 `CHECK` 在 `ON DUPLICATE KEY UPDATE` 下會擋，但**錯誤訊息很難看**；而且丟掉了「哪一張訂單用的」 |

**選 B**，理由：

> 它同時滿足三件事：**併發正確**（約束）、**保留稽核**（每一次使用是一列）、
> **沒有鎖等待**（15% × 800 = 120 TPS 打在同一張券上，用鎖會排隊）。
>
> ⚠️ 而 A 的「把同一個客戶的下單序列化」聽起來可以接受，
> 但它會與 2.11.9 的鎖順序問題交互 ——
> 下單已經鎖了 stock，再加一個 customer 鎖就是「兩組鎖」，死鎖風險上升。

**3. 實作**

```sql
CREATE TABLE coupon_usage (
    coupon_code VARCHAR(32)  NOT NULL,
    customer_id VARCHAR(32)  NOT NULL,
    seq         TINYINT      NOT NULL,
    order_id    VARCHAR(32)  NOT NULL,
    used_at     DATETIME(6)  NOT NULL,

    -- ★★ 這條主鍵保證「同一個客戶、同一張券、同一個序號」只有一筆
    PRIMARY KEY (coupon_code, customer_id, seq),
    -- ★ 上限寫進約束（MySQL 8.0.16+）
    CONSTRAINT chk_usage_seq CHECK (seq BETWEEN 1 AND 2),
    -- ★ 同一張訂單不可以重複記錄（冪等）
    UNIQUE KEY uk_usage_order (coupon_code, customer_id, order_id)
);
```

⚠️ **`chk_usage_seq CHECK (seq BETWEEN 1 AND 2)` 把「2」寫死了。**

如果上限要可設定，就不能用 `CHECK`，而要靠應用層算 `seq` +
主鍵保證不重複 —— **那時候上限的保證變成「應用層 + 主鍵」的組合**，
而不是純粹的資料庫約束。

> 📌 **這是一個真實的取捨**：**「可設定」與「資料庫層的硬保證」互斥。**
> shop-service 選「寫死」，因為「每人限用 N 次」的 N 從來沒有改過。

```java
@Repository
public class JdbcCouponUsageRepository implements CouponUsageRepository {

    private static final int MAX_PER_CUSTOMER = 2;

    /**
     * ★★ 記錄一次使用。
     *
     * <p>作法：先數已用幾次 → 算出 {@code seq} → INSERT。
     * <b>「數」這一步不精確沒關係</b>，因為主鍵會擋住重複的 {@code seq}。
     *
     * <p>⚠️ 這是「樂觀」的做法：<b>先假設沒有衝突，衝突時靠約束擋下</b>。
     * 它在「衝突很少」時比鎖快得多，而優惠券的每人次數正是這種情況
     * （同一個客戶同時下兩單的機率很低）。
     *
     * @return true = 記錄成功；false = 已達上限
     */
    @Override
    @Transactional(propagation = Propagation.MANDATORY)      // ★ 2.3.6
    public boolean tryRecordUsage(String code, String customerId,
                                  String orderId, Instant at) {
        int used = jdbc.queryForObject("""
                SELECT COUNT(*) FROM coupon_usage
                 WHERE coupon_code = ? AND customer_id = ?
                """, Integer.class, code, customerId);

        if (used >= MAX_PER_CUSTOMER) return false;          // ★ 快速路徑

        try {
            jdbc.update("""
                    INSERT INTO coupon_usage(coupon_code, customer_id, seq, order_id, used_at)
                    VALUES (?, ?, ?, ?, ?)
                    """, code, customerId, used + 1, orderId, Timestamp.from(at));
            return true;

        } catch (DuplicateKeyException e) {
            // ⚠️ 兩種可能，要分辨：
            //    ① uk_usage_order 衝突 → 同一張訂單重複記錄 → 冪等，回 true
            //    ② PRIMARY KEY 衝突   → 有人搶先用掉了這個 seq → 競爭，回 false
            if (e.getMessage() != null && e.getMessage().contains("uk_usage_order")) {
                return true;                                  // ★ 冪等
            }
            log.info("[RACE] 優惠券每人次數的併發衝突：code={} customer={}", code, customerId);
            return false;

        } catch (DataIntegrityViolationException e) {
            // CHECK 擋下 seq > 2（理論上前面的 if 已經擋了，這是最後防線）
            return false;
        }
    }
}
```

⚠️ **`e.getMessage().contains("uk_usage_order")` 這種寫法很脆弱**
（訊息格式隨 MySQL 版本變）。

👉 **更好的做法**：分成兩個方法 / 先查冪等再插入，
或用 `INSERT ... ON DUPLICATE KEY UPDATE` 讓冪等那一路不拋例外。
**這裡保留脆弱的版本，是為了讓你看見這個問題** ——
而 2.16 練習 4 的延伸題就是把它改好。

**併發測試（0.8.5 的手法）：**

```java
@Test
@RepeatedTest(5)                       // ★ race 是機率性的
void 同一個客戶的十個併發請求_只有兩個成功() throws Exception {
    coupons.insert("SPRING10", 10_000);

    int threads = 10;
    var barrier = new CyclicBarrier(threads);
    var successes = new AtomicInteger();
    var pool = Executors.newFixedThreadPool(threads);

    var futures = IntStream.range(0, threads)
            .mapToObj(i -> pool.submit(() -> {
                barrier.await();
                // ★ 每個請求一個獨立的訂單 ID → uk_usage_order 不會誤判成冪等
                if (usageTx.recordInNewTransaction("SPRING10", "cus_1", "ord_" + i)) {
                    successes.incrementAndGet();
                }
                return null;
            }))
            .toList();
    for (var f : futures) f.get();
    pool.shutdown();

    assertThat(successes.get()).isEqualTo(2);
    assertThat(countUsage("SPRING10", "cus_1")).isEqualTo(2);
}

@Test
void 同一張訂單重複記錄是冪等的() {
    assertThat(usageTx.recordInNewTransaction("SPRING10", "cus_1", "ord_1")).isTrue();
    assertThat(usageTx.recordInNewTransaction("SPRING10", "cus_1", "ord_1"))
            .as("同一張訂單重送 → 冪等，不消耗第二次額度")
            .isTrue();
    assertThat(countUsage("SPRING10", "cus_1")).isEqualTo(1);
}
```

⚠️ **第二個測試很重要**：如果沒有 `uk_usage_order`，
金流回呼重送就會讓同一張訂單消耗兩次額度。

</details>

---
## 2.17 驗收清單

**機制**

- [ ] 一個 `@Transactional` 方法的 15 個步驟，各自做什麼？
- [ ] **`AFTER_COMMIT` 執行時，連線歸還了嗎？`isActualTransactionActive()` 回傳什麼？**
- [ ] ACID 的四個字母各自由誰保證？哪一個**不是**交易保證的？
- [ ] 交易、連線、`ThreadLocal` 三者的關係是什麼？
- [ ] `JdbcTemplate` 怎麼知道要用「交易裡的那條連線」？自己 `dataSource.getConnection()` 會怎樣？
- [ ] `isActualTransactionActive()` 與 `isSynchronizationActive()` 的差別？

**傳播行為**

- [ ] 七種傳播行為，「外面有交易」與「沒有」各自的行為？
- [ ] `REQUIRES_NEW` 的兩個方向為什麼不對稱？
- [ ] `REQUIRES_NEW` 的三個代價？哪一個會讓系統「把自己鎖死」？
- [ ] 為什麼被編排的元件（loader / factory）**不**標 `@Transactional`？
- [ ] `NESTED` 的四個「但是」？shop-service 為什麼不用它？
- [ ] `MANDATORY` 為什麼是最被低估的一個？shop-service 把它加在哪三個地方？
- [ ] `NEVER` 能擋住什麼、擋不住什麼？

**隔離級別**

- [ ] 三種讀異常，以及「不可重複讀」與「幻讀」的差別？
- [ ] MySQL 的快照讀與當前讀，各自什麼時候發生？
- [ ] 為什麼「SELECT 查不到」不能用來推論「可以安全 INSERT」？
- [ ] `UPDATE ... WHERE available >= ?` 讀的是快照還是最新值？為什麼這很重要？
- [ ] 交易日誌裡的六個關鍵字各自對應哪一步？看到 `No need to create transaction` 代表什麼？

**參數**

- [ ] `readOnly = true` 的三個作用？哪一個最大？
- [ ] 為什麼「唯讀交易保護我不會誤寫」是錯的？
- [ ] 讀寫分離為什麼需要 `LazyConnectionDataSourceProxy`？
- [ ] `timeout` 的真實語意？它擋得住外部 API 呼叫嗎？
- [ ] `default-timeout` / `leak-detection-threshold` / `innodb_lock_wait_timeout` 三個數字的關係？
- [ ] 為什麼 `@Transactional` 不該加在介面上？

**rollback**

- [ ] 預設的 rollback 規則？它的歷史來源與現在的實際效果？
- [ ] `rollbackFor` 與 `noRollbackFor` 的優先順序怎麼決定？
- [ ] shop-service 為什麼不「每個都加 `rollbackFor = Exception.class`」？
- [ ] `noRollbackFor` 救得了「內層標記的 rollback-only」嗎？

**失效**

- [ ] 五種失效情境，各自的機制？哪四種完全沒有警告？
- [ ] 自呼叫的四種解法與各自的代價？
- [ ] `private` 與 `final` 卡在哪一道關卡？兩者有什麼不同？
- [ ] 為什麼「把 private 改成 public」常常沒有任何改善？
- [ ] `parallelStream()` 為什麼特別危險？
- [ ] 30 秒的判斷法是什麼？

**`UnexpectedRollbackException`**

- [ ] 它的六步機制？
- [ ] 為什麼它是一個「好」的設計？
- [ ] 三種解法？為什麼 `REQUIRES_NEW` 通常是錯的？

**交易長度**

- [ ] Tomcat 執行緒 200 vs 連線池 20 的差距，背後的假設是什麼？
- [ ] 交易裡不可以做的六件事？
- [ ] 交易吞吐量的算式？交易裡多一次 3 秒的 API 呼叫，TPS 從多少掉到多少？
- [ ] 長交易的三種拆法？拆了之後失去什麼、必須自己保證什麼？
- [ ] 為什麼 `SlowTransactionDetector` 用 `afterCompletion` 而不是 `afterCommit`？

**併發**

- [ ] 三種競爭的形狀與症狀？哪一種在 `REPEATABLE READ` 下仍然會發生？
- [ ] 「開了交易」對 TOCTOU 有幫助嗎？
- [ ] 悲觀鎖的四個代價？`FOR UPDATE` 對「不存在的列」有效嗎？
- [ ] 訂單編號的三種做法？shop-service 選哪一種、代價是什麼？
- [ ] 「一天最多改 3 次」是哪一種競爭？三種解法？
- [ ] 樂觀鎖的三個實務細節？`@Retryable` 為什麼要標在呼叫端的 bean 上？
- [ ] `random = true` 為什麼不能省？
- [ ] 悲觀鎖 / 樂觀鎖 / 原子 UPDATE 的決策表？
- [ ] 死鎖與鎖等待逾時的四個差別？
- [ ] 最常見的死鎖形狀？shop-service 的 `create()` 為什麼會遇到它？
- [ ] 重試死鎖是安全的嗎？前提是什麼？

**事件**

- [ ] 四個 phase 各自在 14 步的哪一步？哪一個還在交易裡？
- [ ] 沒有交易時發佈事件會怎樣？兩種處理，shop-service 選哪一個、為什麼？
- [ ] `AFTER_COMMIT` 與 `AFTER_COMPLETION` 對「listener 拋例外」的處理有什麼不同？
- [ ] 為什麼 `AFTER_COMMIT` + 寫資料庫 = 一定要 `REQUIRES_NEW`？
- [ ] 事件會遺失的三種方式？哪一類資料不可以只靠事件？

**診斷**

- [ ] 三種「證明有交易」的方法，各自的強度？
- [ ] `information_schema.innodb_trx` 的哪一個欄位是排查連線池耗盡的第一站？
- [ ] ArchUnit 抓不到「間接呼叫外部埠」，正確的回應是什麼？
- [ ] `hikaricp.connections.pending` 為什麼是最有價值的指標？

**如果有任何一題答不出來，回去讀對應的小節**：

| 題目範圍 | 小節 |
|---|---|
| 機制與環境 | 2.2 |
| 傳播行為 | **2.3** |
| 隔離級別 | 2.4 |
| 參數 | 2.5 |
| rollback 規則 | 2.6 |
| 五種失效 | **2.7** |
| `UnexpectedRollbackException` | 2.8 |
| 交易長度 | 2.9 |
| 程式式交易 | 2.10 |
| 併發控制 | **2.11** |
| 事件 | 2.12 |
| 診斷 | 2.13 |

---

## 2.18 下一章預告

這一章把「交易邊界」與「併發」處理完了。
而它一路上留下了一個沒有回答的問題：

> **`Order` 這個聚合，到底怎麼變成 API 回應的 JSON？**

00 章 0.10.3 說「Service 回傳 Domain 物件，Web 層負責轉 DTO」，
並且**誠實承認了那個決定的代價**：

```java
// 04-controller 0.10.2 的 Controller
var order = orderService.create(...);        // ← 這時候交易已經結束了
var body  = mapper.toCreateResponse(order);  // ← 存取 order 的欄位
```

⚠️ **用 JPA 時，如果 `order.lines()` 是延遲載入的，
上面第二行會拋 `LazyInitializationException`** ——
因為交易（與 Hibernate Session）在第一行結束時就關掉了。

**03 章要處理的就是這條邊界上的所有問題：**

| 03 章的節 | 主題 |
|---|---|
| 3.2 | 為什麼不回傳 Entity：**五個具體的洩漏與破壞** |
| 3.3 | 三種轉換策略：Service 回 Domain / Service 回 DTO / 讀取模型直接查投影 |
| 3.4 | 手寫 mapper vs MapStruct：**「漏映射一個欄位」為什麼是靜默的** |
| 3.5 | 巢狀轉換與集合：`List.copyOf` 的邊界在哪 |
| 3.6 ★ | **PATCH 的三態語意**：`JsonNullable` 到了 Service 層長什麼樣 |
| 3.7 | 依角色決定欄位可見性：`OrderDetail` vs `OrderDetailForSupport` |
| 3.8 | 轉換的測試：**掃描測試比逐欄位斷言有效** |
| 3.9 | `LazyInitializationException` 的三種解法（08 站的預習） |

⚠️ **而 03 章會回頭修正一件事**：
00 章 0.14.1 改了 `OrderWebMapper` 的簽章
（加了 `actor`、`now`、`locale` 三個參數），
**那讓它從「純函式」變成「需要三個上下文」的東西** ——
03 章 3.3 會重新檢視那個決定是不是最好的。

---

**完成本章後**，請確認你的專案有：

```
✅ support/MySqlIntegrationTestBase.java        ★ 池子只有 5 條、嚴格模式、lock timeout 5s
✅ support/DatabaseCleaner.java                 ★ TRUNCATE，不用 @Transactional rollback
✅ transaction/PropagationBehaviorTest.java     ★ 2.3.2 的矩陣，8 個測試
✅ transaction/TransactionRollbackIntegrationTest.java  ★ 含「冪等紀錄一起回滾」
✅ transaction/FrameworkBehaviourProbeTest.java ★ 三個特性測試（練習 3）
✅ architecture/TransactionPolicyTest.java      ★ 六條 ArchUnit 規則
✅ common/tx/Tx.java                            requireActive / requireNoTransaction
✅ common/tx/SlowTransactionDetector.java       afterCompletion，200ms 門檻
✅ common/event/EventPublisherWithTransactionCheck.java  ★ 2.12.2 陷阱 ① 的守門
✅ order/application/SequenceOrderNumberGenerator.java   ★ 獨立短交易
✅ order/application/OrderApplicationService.java        ★ 扣庫存前依 productId 排序
✅ StockPort.findByProductIdForUpdate + @Transactional(MANDATORY)
✅ PaymentGateway 實作標 @Transactional(NEVER)
✅ CouponUsageRepository + coupon_usage 表（練習 4）
```

⚠️ 課程中的程式碼、YAML 與設定均經逐行檢閱，但**尚未在本機編譯執行驗證**
（這台機器上沒有安裝 JDK 與 Maven）。基準版本延續 04-controller：
**Java 21 / Spring Boot 3.2.5 / Spring Framework 6.1 / MySQL 8.0 / Testcontainers 1.19**。

⚠️⚠️ **而這一章比前兩章更需要你實測** ——
它斷言了大量「框架與資料庫的具體行為」，
而那些行為會隨版本、驅動設定、`sql_mode` 而變。
**練習 3 的三個特性測試就是為此存在的：把行為釘住，而不是相信文件。**

下一章：[03-dto-entity-mapping.md](./03-dto-entity-mapping.md)
