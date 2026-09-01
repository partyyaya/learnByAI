# 第 02 章：JDBC 與 JdbcTemplate

> 00 章 0.12.4 交出了一個 `JdbcOrderRepository` 的**骨架**，
> 並且老實說了：「這一版刻意只做到能跑」。
>
> 骨架裡有一個 bug，長這樣：
>
> ```java
> public void save(Order order) {
>     int updated = jdbc.update("UPDATE orders SET status = :status, … WHERE id = :id", params(order));
>     if (updated == 0) {
>         …
>         insert(order);        // ← 新單走這裡，明細在這裡被寫進去
>     }
>     // ⚠️ updated == 1 的時候呢？什麼都沒做。
> }
> ```
>
> **後果**：使用者在購物車裡刪掉一筆商品、按下儲存、畫面顯示「已更新」、
> 重新整理之後那筆商品**又回來了**。
>
> 沒有例外、沒有日誌、`save()` 回傳正常。
> 00 章的**九條契約測試全部是綠的**，因為沒有一條測試改過明細。
>
> ⚠️ **這一章要做三件事**：
>
> 1. 把 SQL 寫**安全**（2.3：一個輸入刪掉整張表的實測）
> 2. 把 `ResultSet` 變成物件而**不掉東西**（2.5：一個 `NULL` 讓「沒有折扣」變成「折扣 0 元」）
> 3. 把上面那個 `save()` **寫對**（2.8）
>
> **這是實作的主體章節。** 讀完之後，00 章那個骨架會變成一個**通過 14 條契約測試**的實作。

---

## 2.1 學習目標

完成本章後，你應該可以：

- 說出一段「正確的」純 JDBC 有哪五個必須做對的地方，以及 `JdbcTemplate` 幫你做掉了哪七件事。
- **示範**字串拼接的 SQL 怎麼被打穿 —— 包含一個**在 H2 上真的把整張表刪掉**的實測。
- 解釋參數化**不是「跳脫」**，而是「SQL 與資料分兩次送」，並說出這個差別為什麼決定了它擋得住什麼。
- 說出**哪些位置可以放 `?`、哪些不行**，以及為什麼 `SELECT ? FROM orders` 這種寫法
  **不會報錯，但會靜默回傳錯的東西**。
- 為排序欄位寫出白名單，並解釋為什麼 `LIKE` 的參數化**擋得住 injection、擋不住萬用字元**。
- 在 `RowMapper` / `ResultSetExtractor` / `RowCallbackHandler` 之間做出選擇，並說出判準。
- 說出 `rs.getLong()` 讀到 `NULL` 時回傳什麼，以及 `rs.wasNull()` 有一個
  **與 Java 求值順序有關、看起來完全正確的錯誤寫法**。
- 說明 `IN (:ids)` 的展開機制，並知道**空集合展開出來的 SQL 在 H2 上合法、在 MySQL 上是語法錯誤**。
- 在四種 upsert 寫法之間做選擇，並解釋**為什麼要樂觀鎖就不能用單句 `MERGE`**。
- 把「約束違反」翻譯成使用者看得懂的話，並說出**為什麼比對訊息字串是最差的一種做法**、
  以及 shop-service 為什麼選了另一種。
- 判斷 `JdbcClient`（Spring Boot 3.2）值不值得換。

---

## 2.2 從 30 行樣板開始

### 2.2.1 一段「正確的」純 JDBC 有多長

先看一段**沒有用任何框架**的查詢。目標很簡單：查出某個客戶的訂單 id。

```java
package example.shop.order.infrastructure.persistence;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;

public class PlainJdbcExample {

    record Row(String id, String customerId) {}

    private final DataSource dataSource;

    public PlainJdbcExample(DataSource dataSource) { this.dataSource = dataSource; }

    public List<Row> findByCustomer(String customerId) throws SQLException {
        List<Row> result = new ArrayList<>();
        String sql = "SELECT id, customer_id FROM orders WHERE customer_id = ?";

        try (Connection conn = dataSource.getConnection();          // ① 一定要關
             PreparedStatement ps = conn.prepareStatement(sql)) {   // ② 一定要關
            ps.setString(1, customerId);                            // ③ 索引從 1 開始
            try (ResultSet rs = ps.executeQuery()) {                // ④ 一定要關
                while (rs.next()) {
                    result.add(new Row(rs.getString("id"), rs.getString("customer_id")));
                }
            }
        }
        return result;                                              // ⑤ SQLException 是 checked
    }
}
```

**五個「必須做對」的地方**：

| # | 事情 | 做錯的下場 |
|---|---|---|
| ① | `Connection` 要關 | **連線洩漏** —— 池被吃光（01 章整章在講這件事） |
| ② | `PreparedStatement` 要關 | 資料庫端的 cursor / 游標洩漏 |
| ③ | 參數索引**從 1 開始**，不是 0 | `setString(0, …)` 直接拋例外 |
| ④ | `ResultSet` 要關 | 同 ② |
| ⑤ | `SQLException` 是 **checked** 的 | 每一層都要 `throws` 或 `try/catch` —— 而它往上傳到 Service 層就變成洩漏（00 章 0.11.3） |

⚠️ **關閉的順序很重要**：`ResultSet` → `Statement` → `Connection`。
`try-with-resources` 會**反著宣告順序**關閉，所以上面那段的順序是對的。
**但這只在你用巢狀 try-with-resources 時成立** ——
如果三個都寫在同一個 `try (...)` 裡，順序也對；**如果你自己寫 `finally`，就很容易寫錯。**

### 2.2.2 實測：忘了關會怎樣

**實驗 G1-B**：池設成 3，故意借 5 次而且不還。

```java
// 池 = 3
ds.setMaximumPoolSize(3);
// 想把 30 秒的預設縮短，好讓實驗跑得快一點：
ds.getHikariConfigMXBean().setConnectionTimeout(3000);
Lab.line("設定之後讀回來的 connectionTimeout = %d ms", ds.getConnectionTimeout());

List<Connection> leaked = new ArrayList<>();
for (int i = 0; i < 5; i++) {
    Connection c = ds.getConnection();              // ⚠️ 沒有 try-with-resources
    try (PreparedStatement ps = c.prepareStatement("SELECT 1");
         ResultSet rs = ps.executeQuery()) {
        rs.next();
    }
    leaked.add(c);                                  // 連線一直握在手上
}
```

```
  設定之後讀回來的 connectionTimeout = 3000 ms

=== G1-B 忘了 close（池 = 3，借 5 次） ===
  成功借到：3 次
  第 4 次的下場：SQLTransientConnectionException: Connection is not available, request timed out after…
  卡了：30035 ms
```

**兩件事同時發生了，第二件是意外收穫**：

🔴 **① 池被吃光了，而且第四個請求「卡住」而不是「立刻失敗」。**

> **洩漏的第一個症狀不是「錯誤」，是「慢」。**
> 前三個請求正常、第四個請求**卡滿 `connectionTimeout` 才失敗**。
> 這就是 01 章開頭那個「p99 從 80 ms 變成 30,000 ms」的來源。

🔴🔴 **② `connectionTimeout` 設成 3000，讀回來也是 3000，實際上卻等了 30 秒。**

我原本只是想讓實驗跑快一點，結果撞到 01 章 1.7.0 的同一個家族的問題。
**追加一組對照實驗（G1-B2）：改成在建構 `HikariConfig` 的時候就設定。**

```java
HikariConfig cfg = new HikariConfig();
cfg.setJdbcUrl("jdbc:h2:mem:g1b2;DB_CLOSE_DELAY=-1");
cfg.setUsername("sa");
cfg.setMaximumPoolSize(2);
cfg.setConnectionTimeout(3000);          // ★ 建構時就設
try (HikariDataSource ds = new HikariDataSource(cfg)) { … }
```

```
=== G1-B2 建構時設 connectionTimeout=3000 ===
  第 3 次借連線：SQLTransientConnectionException，卡了 3005 ms ← ✅ 建構時的設定有生效
```

**兩相對照，結論很明確**：

| 設定方式 | 讀回來的值 | 實際生效嗎 |
|---|---|---|
| 建構 `HikariConfig` 時 `setConnectionTimeout(3000)` | 3000 | ✅ **等了 3005 ms** |
| 池跑起來之後用 `HikariConfigMXBean` 改成 3000 | **3000** | 🔴 **等了 30035 ms** |

⚠️ **同一組實驗裡，`setMaximumPoolSize(3)` 在跑起來之後改是【有效】的**
（只借到 3 條就滿了）。**所以不是「執行期都不能改」，而是「有些能、有些不能」。**

> 📌 **這一格要記住的不是 HikariCP 的實作細節，而是那條方法論**（01 章 1.7.0 的同一條）：
>
> **「你寫的值」與「生效的值」是兩件事，而中間沒有人會警告你。**
> 唯一可靠的做法是**量它**：改設定之後，用一個實驗確認行為真的變了 ——
> **不要只確認「讀回來的值變了」，那個一定會變。**
>
> 🔴 **【本章未驗證】為什麼 HikariCP 的這兩個設定表現不一致**（沒有深入追原始碼）。
> **教學上的重點是那條方法論，不是這一個 API 的特例。**

### 2.2.3 實測：例外路徑上的連線會不會漏

這是**真正決定要不要用框架**的一個實驗。手寫 JDBC 最容易漏掉的不是正常路徑，
而是**查詢丟例外的那條路徑**。

**實驗 G1-C**：池設成 2，故意跑一句會失敗的 SQL 十次。

```java
JdbcTemplate jdbc = new JdbcTemplate(ds);   // 池 = 2
int failures = 0;
for (int i = 0; i < 10; i++) {
    try {
        jdbc.queryForObject("SELECT no_such_column FROM orders", String.class);
    } catch (RuntimeException e) {
        failures++;
    }
}
int active = ds.getHikariPoolMXBean().getActiveConnections();
```

```
=== G1-C 例外路徑下的連線歸還（池 = 2，故意失敗 10 次） ===
  失敗次數：10
  失敗之後 active connections = 0（沒有洩漏）
```

> 📌 **池只有 2，卻失敗了 10 次還沒卡住** —— 代表每一次失敗都把連線還回去了。
>
> ⚠️ **如果這段是手寫的 JDBC，而 `close()` 寫在 `try` 區塊的最後一行（不是 `finally`）**，
> 這個迴圈會在**第三次**就卡死。

### 2.2.4 `JdbcTemplate` 幫你做掉的七件事

```java
// 上面 20 行的等價寫法
List<Row> rows = jdbcTemplate.query(
        "SELECT id, customer_id FROM orders WHERE customer_id = ?",
        (rs, rowNum) -> new Row(rs.getString("id"), rs.getString("customer_id")),
        customerId);
```

**實驗 G1-A 確認過兩者結果完全相同**：

```
=== G1-A 純 JDBC vs JdbcTemplate ===
  純 JDBC 取得同樣結果：[Row[id=O-1, customerId=C-1]]
  JdbcTemplate 取得同樣結果：[Row[id=O-1, customerId=C-1]]
```

| # | JdbcTemplate 做的事 | 你不用再寫 |
|---|---|---|
| 1 | 取得與**歸還**連線（含例外路徑） | `try-with-resources` × 3 層 |
| 2 | 建立 `PreparedStatement`、設定參數 | `ps.setString(1, …)` 的索引管理 |
| 3 | 走訪 `ResultSet` 並呼叫你的 `RowMapper` | `while (rs.next())` |
| 4 | **把 `SQLException` 翻譯成 unchecked 的 `DataAccessException`** | 每一層的 `throws SQLException`（2.12） |
| 5 | 參與**外層交易**（拿到的是交易綁定的那條連線） | `TransactionSynchronizationManager` 的手動處理 |
| 6 | 套用 `queryTimeout`、`fetchSize` 等設定 | 每個 `Statement` 各設一次 |
| 7 | 具名參數的展開（`NamedParameterJdbcTemplate`，2.6） | 自己數 `?` 的位置 |

⚠️ **第 5 點是最容易被忽略、也最重要的一點**：

> `JdbcTemplate` 拿連線的方式不是 `dataSource.getConnection()`，
> 而是 **`DataSourceUtils.getConnection(dataSource)`** ——
> 它會先問「這個執行緒上有沒有正在進行的交易？」
> 有的話就**回傳那個交易的連線**，而且**不會**在用完之後把它還回去（交易還沒結束）。
>
> 📌 **這就是為什麼 `@Transactional` 加在 Service 上、Repository 什麼都不用做，
> 三次 `jdbc.update()` 就會落在同一個交易裡**（00 章 0.9）。
>
> 🔴 **如果你在 Repository 裡自己呼叫 `dataSource.getConnection()`，
> 你會拿到「另一條」連線 —— 你的寫入不在那個交易裡。**
> 這是手寫 JDBC 混進 Spring 專案時最常見的一種事故。

### 2.2.5 那為什麼不直接用 ORM？

**這一站的選擇是「兩個都學，先學 JDBC」**，理由有三個：

| 理由 | 說明 |
|---|---|
| **JDBC 是地板** | Spring Data JPA、MyBatis、Hibernate 最後都落到 `PreparedStatement`。地板漏水的時候，你要看得懂地板 |
| **JdbcTemplate 沒有魔法** | 你寫的 SQL 就是送出去的 SQL。03 章的 Spring Data 會出現「我沒寫 SQL，它怎麼知道要查什麼」的問題 |
| **有些事 ORM 做不好** | 報表、批次、原子 UPDATE、複雜的動態條件 —— shop-service 這幾處**永遠**是 JDBC |

> 📌 **03 章會用同一組介面寫第二個實作（Spring Data），然後讓 2.15 的契約測試同時跑在兩個上面。**
> **那時候你才能公平地比較它們。**

---

## 2.3 ★ PreparedStatement 與 SQL Injection

### 2.3.1 實測：字串拼接被打穿

**反面教材**（00 章 0.11.4 已經說過「不該做」，這裡要實際看它壞掉）：

```java
// 🔴 反面教材
private List<String> concatQuery(JdbcTemplate jdbc, String customerId) {
    String sql = "SELECT id FROM orders WHERE customer_id = '" + customerId + "'";
    return jdbc.queryForList(sql, String.class);
}

// ✅ 正確
private List<String> paramQuery(JdbcTemplate jdbc, String customerId) {
    return jdbc.queryForList("SELECT id FROM orders WHERE customer_id = ?", String.class, customerId);
}
```

資料表裡有三筆訂單：`O-1`（屬於 C-1）、`O-2` 與 `O-3`（屬於 C-2）。

**實驗 G2-A**：

```
=== G2-A 讀取：拼接 vs 參數化 ===
  輸入 「C-1」                                       拼接→[O-1]              參數化→[O-1]
  輸入 「C-1' OR '1'='1」                            拼接→[O-1, O-2, O-3]    參數化→[]
  輸入 「x' UNION SELECT currency FROM orders …」    拼接→[TWD]              參數化→[]
```

**三列各代表一種後果**：

| 輸入 | 後果 | 嚴重性 |
|---|---|---|
| 正常值 | 兩種寫法都對 —— **所以測試會過，code review 也看不出來** | — |
| `' OR '1'='1` | **拿到全部三筆** —— 別的客戶的訂單 | 🔴 資料外洩 |
| `' UNION SELECT …` | **拿到另一個欄位的內容**（`TWD`） | 🔴🔴 攻擊者可以逐欄撈出整個資料庫 |

⚠️ **第三列是最可怕的一種**：`UNION` 讓攻擊者**選擇要讀哪一欄**。
把 `currency` 換成 `password_hash`，這個查詢就變成了一台提款機。

### 2.3.2 實測：一個輸入把整張表刪掉

大家都聽過「`'; DROP TABLE` 攻擊」，但也常聽到一句安慰的話：
**「JDBC 一次只能送一句 SQL，所以多句攻擊沒用。」**

**這句話在 H2 上是錯的。**

**實驗 G3-A**：

```java
String evilInput = "x'; DELETE FROM orders WHERE '1'='1";
String sql = "SELECT id FROM orders WHERE customer_id = '" + evilInput + "'";
long before = jdbc.queryForObject("SELECT COUNT(*) FROM orders", Long.class);
jdbc.queryForList(sql, String.class);            // ← 只是一句「查詢」
long after  = jdbc.queryForObject("SELECT COUNT(*) FROM orders", Long.class);
```

```
=== G3-A 多句攻擊（'; DELETE …）在 H2 2.2.224 上 ===
  送出：SELECT id FROM orders WHERE customer_id = 'x'; DELETE FROM orders WHERE '1'='1'
  結果：沒有拋例外，查詢回傳 []
  攻擊前 3 筆 → 攻擊後 0 筆 → DELETE 🔴 生效了
  結論：H2 在 executeQuery 下🔴 會執行第二句。
```

🔴🔴 **一次「查詢」清空了整張表，而且沒有拋任何例外。**

> ⚠️ **這件事的教訓不是「H2 很爛」，而是**：
>
> **「一次只能送一句」是一個【驅動與設定相依】的行為，不是一條你可以依賴的安全保證。**
>
> | 資料庫 | 預設會不會執行多句 |
> |---|---|
> | **H2 2.2.224** | 🔴 **會**（本章實測） |
> | MySQL（JDBC 驅動） | 預設**不會**，除非 URL 加 `allowMultiQueries=true` 🔴 **而有人真的會為了效能加它** |
> | PostgreSQL | 簡單查詢協定下**會** |
>
> 🔴 **【本章未驗證】MySQL 與 PostgreSQL 的實際行為**（本機沒有這兩個資料庫）——
> 上表的後兩列是文件說法，**07-mysql 站會實測 MySQL 那一列**。
>
> 📌 **而不管答案是什麼，正確的做法都一樣：不要拼接。**
> 「這個資料庫剛好不執行第二句」是**運氣**，不是**設計**。

### 2.3.3 參數化不是「跳脫」，是「分兩次送」

一個常見的誤解是：「參數化就是幫我把單引號變成兩個單引號」。
**不是。** 如果只是跳脫，那它就只是一個字串處理函式，而字串處理函式會有漏洞
（多位元組編碼、跳脫字元本身、不同的 SQL 模式）。

**真正發生的事是**：

```
① 應用程式送出：SELECT id FROM orders WHERE customer_id = ?
                └─ 資料庫【現在就】解析它、決定執行計畫。此時它還不知道值是什麼。

② 應用程式送出：值 = "C-1' OR '1'='1"
                └─ 這是【資料】，走的是另一個欄位。
                   語法樹已經定案了，資料不可能再變成語法。
```

📌 **關鍵在於「語法樹在看到值之前就定案了」。**
攻擊者送什麼進來都只是「一個字串常數的內容」，
**它沒有機會變成一個 `OR`**。

**實驗 G2-C**：把攻擊字串原樣存進資料庫，再用同一個字串查回來。

```java
String payload = "C-3' OR '1'='1";
jdbc.update("INSERT INTO orders VALUES (?,?,?,?,?,CURRENT_TIMESTAMP,0)",
            "O-9", payload, "PAID", 100L, "TWD");

List<String> found = jdbc.queryForList(
        "SELECT id FROM orders WHERE customer_id = ?", String.class, payload);
```

```
=== G2-C 參數化：攻擊字串被當成一般資料 ===
  存進去的 customer_id：「C-3' OR '1'='1」
  用同一個字串查回來：[O-9]（找得到，因為它就只是一個值）
```

✅ **字串原封不動地存進去了，也原封不動地查得回來。**
它從頭到尾都只是一個值 —— **這才是「參數化」的意思**。

> 📌 **附帶的好處**：因為語法樹可以重用，資料庫能**快取執行計畫**。
> 拼接的 SQL 每一次都是一句「新的 SQL」，快取永遠打不中。
> **所以參數化不只比較安全，通常也比較快。**

### 2.3.4 ★ 哪些位置可以放 `?`

這是本節**最實用**的一張表，而其中有一列會讓人嚇一跳。

**實驗 G3-B**：

```
=== G3-B 哪些位置可以放 ? ===
  WHERE 的值       SELECT id FROM orders WHERE customer_id = ?      ✅ 可以，回傳 [O-1]
  ORDER BY 的欄位  SELECT id FROM orders ORDER BY ?                 ❌ DataIntegrityViolationException
  ORDER BY 的方向  SELECT id FROM orders ORDER BY id ?              ❌ BadSqlGrammarException
  表名            SELECT id FROM ?                                 ❌ BadSqlGrammarException
  欄位名           SELECT ? FROM orders                             ✅ 可以，回傳 [id, id, id]   ← ⚠️⚠️
  LIMIT 的筆數     SELECT id FROM orders ORDER BY id LIMIT ?        ✅ 可以，回傳 [O-1, O-2]
```

🔴🔴 **請盯著倒數第二列看**：

```java
List<String> r = jdbc.queryForList("SELECT ? FROM orders", String.class, "customer_id");
// 回傳：[customer_id, customer_id, customer_id]    ← 表裡有 3 列，就回 3 個
```

**它沒有報錯。它回傳了三列（表裡有幾列就幾列），每一列的內容都是字串 `"customer_id"`。**

> ⚠️ **因為 `?` 是一個【值】，而 `SELECT '一個字串常數' FROM orders`
> 的意思是「每一列都給我這個常數」。**
>
> 🔴 **這是本章最危險的一個陷阱**：
> 你以為你在動態選欄位，實際上你在**回傳欄位的名字**。
> 資料型別剛好是字串的時候，這個 bug 可以**跑上線、跑很久**。

**`ORDER BY ?` 的錯誤訊息也值得看**（實驗 G4-A）：

```
例外型別：org.springframework.dao.DataIntegrityViolationException
訊息：Data conversion error converting "customer_id"; SQL statement: SELECT id FROM orders ORDER BY ?
```

⚠️ **注意例外型別是 `DataIntegrityViolationException`（資料完整性）而不是語法錯誤** ——
因為 H2 把 `ORDER BY <值>` 解讀成「依照**第幾欄**排序」，
於是它試著把字串 `"customer_id"` 轉成數字，失敗了。

> 🔴 **更糟的情況**：如果使用者送進來的是 `"1"`，
> **`ORDER BY ?` 會變成「依照第 1 欄排序」而且不會報錯** ——
> 排序結果完全不是你要的，但沒有任何錯誤。

**歸納成一條規則**：

> 📌 **`?` 只能出現在「值」的位置。**
>
> **「值」＝ 執行計畫定案之後才需要知道的東西。**
> 表名、欄位名、`ORDER BY` 的欄位、`ASC`/`DESC`、`JOIN` 的對象 ——
> 這些是**語法結構**，資料庫必須在解析階段就知道，所以它們不可能是參數。

### 2.3.5 那動態排序怎麼寫：白名單

既然 `ORDER BY` 不能參數化，而前端**真的**需要「點欄位標題來排序」，唯一的正解是**白名單**。

```java
package example.shop.order.infrastructure.persistence;

import org.springframework.jdbc.core.JdbcTemplate;
import java.util.List;
import java.util.Map;
import java.util.Set;

public class OrderSortExample {

    /** ★ 前端送來的名字 → 真正的欄位名。白名單同時做了「授權」與「改名隔離」兩件事。 */
    private static final Map<String, String> SORTABLE = Map.of(
            "id",        "id",
            "createdAt", "created_at",
            "total",     "total_minor");

    private final JdbcTemplate jdbc;

    public OrderSortExample(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    public List<String> search(String sortKey, String direction) {
        String column = SORTABLE.get(sortKey);
        if (column == null) {
            throw new IllegalArgumentException(
                    "不支援的排序欄位：" + sortKey + "，可用的有 " + SORTABLE.keySet());
        }
        // ★ 方向也要白名單 —— 它同樣是語法，不是值
        String dir = "desc".equalsIgnoreCase(direction) ? "DESC" : "ASC";

        // ⚠️ 這裡的字串相加是安全的：column 與 dir 都【只能】是上面那幾個常數之一
        return jdbc.queryForList(
                "SELECT id FROM orders ORDER BY " + column + " " + dir + ", id",
                String.class);
    }
}
```

**實驗 G3-C**：

```
=== G3-C 排序欄位白名單 ===
  使用者送 「total_minor」            → ✅ 允許，查詢回傳 [O-2, O-1, O-3]
  使用者送 「customer_id」            → ❌ 拒絕（不在白名單）
  使用者送 「id; DROP TABLE orders」  → ❌ 拒絕（不在白名單）
  使用者送 「(SELECT 1)」             → ❌ 拒絕（不在白名單）
```

**白名單同時做了三件事，缺一不可**：

| 它做的事 | 為什麼重要 |
|---|---|
| **擋住 injection** | 不在清單裡就拒絕，攻擊字串沒有機會進到 SQL |
| **擋住「按未建索引的欄位排序」** | `customer_id` 被拒絕不只是安全問題 —— 它可能沒有索引，一排就全表掃描 |
| **隔離「API 名稱」與「欄位名稱」** | 前端送 `createdAt`，資料庫叫 `created_at`。改欄位名不用改 API |

⚠️ **注意最後那個 `, id`**：
排序**一定要有第二個排序鍵**，否則相同值的列順序是不保證的
（00 章 0.5.1 的第 ⑤ 條洩漏；04 章的分頁會再回來處理它）。

### 2.3.6 `LIKE`：參數化擋得住 injection，擋不住萬用字元

這是一個**參數化做對了、但事情還是壞了**的例子。

```java
// 看起來完全正確：用了參數化
String pattern = "%" + userInput + "%";
jdbc.queryForList("SELECT id FROM orders WHERE customer_id LIKE ?", String.class, pattern);
```

**問題**：使用者在搜尋框裡輸入一個 `%`。

**實驗 G3-D**（資料表裡有四筆，其中一筆的 `customer_id` 真的是 `C-100%OFF`）：

```
=== G3-D LIKE：參數化擋得住 injection，擋不住萬用字元 ===
  使用者輸入：「%」
  直接串進 LIKE 樣式：查到 4 筆 [O-1, O-2, O-3, O-A] ← 🔴 全表掃描 + 全部回傳
  跳脫後（ESCAPE '!'）：查到 1 筆 [O-A] ← ✅ 只找「真的含有 % 的資料」
```

**正解**：

```java
/** ★ % 與 _ 在 LIKE 裡是萬用字元 —— 它們是「樣式的語法」，參數化管不到。 */
private static String escapeLike(String input) {
    return input.replace("!", "!!")     // ⚠️ 跳脫字元本身要先跳脫，順序不能反
                .replace("%", "!%")
                .replace("_", "!_");
}

List<String> found = jdbc.queryForList(
        "SELECT id FROM orders WHERE customer_id LIKE ? ESCAPE '!'",
        String.class, "%" + escapeLike(userInput) + "%");
```

⚠️ **`.replace("!", "!!")` 一定要放在第一個**。
如果先跳脫 `%` 變成 `!%`，再跳脫 `!`，那個剛產生的 `!` 又會被跳脫成 `!!%` —— 樣式就壞了。

> 📌 **兩個後果，安全的那個反而比較不嚴重**：
>
> 1. **正確性**：使用者搜尋 `%` 卻拿到全部資料 —— 這是 bug。
> 2. 🔴 **可用性**：`LIKE '%%%'` 是**全表掃描**。
>    有人在搜尋框連按幾次 `%`，你的資料庫 CPU 就滿了 ——
>    **這是一種不需要任何技巧的 DoS。**

### 2.3.7 五個「以為安全、其實不安全」的寫法

| 寫法 | 為什麼不安全 |
|---|---|
| `"… WHERE id = '" + escapeQuote(id) + "'"` | 自己寫跳脫函式。**多位元組編碼**與資料庫的 `sql_mode` 會讓它失效 |
| `"… WHERE id IN (" + String.join(",", ids) + ")"` | `ids` 來自請求就是一扇門。正解是 `IN (:ids)`（2.6.3） |
| `"… ORDER BY " + sortColumn` **沒有白名單** | 2.3.5 |
| `"… LIMIT " + pageSize` | `pageSize` 若是字串型別就是門；就算轉成 `int` 也要**限制上限**（不然 `LIMIT 99999999`） |
| `"… WHERE name LIKE '%" + kw + "%'"` | **兩個問題**：injection ＋ 萬用字元（2.3.6） |

### 2.3.8 一條守門測試：把「不准拼接」變成 CI 的責任

規則寫在文件裡沒有用，要讓它**會紅**。

```java
package example.shop.architecture;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

class NoConcatenatedSqlTest {

    /** 找出「看起來像 SQL 的字串常數」後面接著 + 一個變數的地方。 */
    private static final Pattern SQL_CONCAT = Pattern.compile(
            "\"[^\"]*\\b(SELECT|INSERT|UPDATE|DELETE|WHERE|VALUES|ORDER BY|FROM)\\b[^\"]*\"\\s*\\+\\s*[A-Za-z_]",
            Pattern.CASE_INSENSITIVE);

    @Test
    void 沒有人用字串拼接組sql() throws IOException {
        List<String> offenders = new ArrayList<>();
        try (Stream<Path> files = Files.walk(Path.of("src/main/java"))) {
            for (Path f : files.filter(p -> p.toString().endsWith(".java")).toList()) {
                String[] lines = Files.readString(f, StandardCharsets.UTF_8).split("\n");
                for (int i = 0; i < lines.length; i++) {
                    if (SQL_CONCAT.matcher(lines[i]).find()) {
                        offenders.add(f + ":" + (i + 1) + "  " + lines[i].trim());
                    }
                }
            }
        }
        assertThat(offenders).describedAs("SQL 只能用 text block 與參數化").isEmpty();
    }
}
```

**實驗 G14-B：這條規則真的會紅嗎？** 我放了一個違規的 class 進去：

```java
// 故意違規
public List<String> find(String customerId) {
    return jdbc.queryForList("SELECT id FROM orders WHERE customer_id = '" + customerId + "'", String.class);
}
```

```
🔴 src/main/java/example/shop/bad/BadDao.java:11  return jdbc.queryForList("SELECT id FROM orders WHERE customer_id = '" + customerId + "'", String.class);
[ERROR] G14_GuardTest.沒有人用字串拼接組sql:103
```

✅ **會紅。** 拿掉違規檔案之後回綠（`掃到 0 處`）。

**這條規則會抓什麼、不會抓什麼（實驗 G16 逐條驗證）**：

```
=== G16-B 各種寫法會不會被抓 ===
  拼接使用者輸入            → 🔴 抓到（正確）
  SELECT_HEAD + " WHERE…"   → ✅ 沒抓（正確）
  參數化                    → ✅ 沒抓（正確）
  兩個字串常數相加           → ✅ 沒抓
  常數 + 具名常數            → ⚠️ 誤判（會抓到）
```

⚠️ **它有一個真的誤判**：`"SELECT id FROM orders " + WHERE_CLAUSE`
（字串常數接一個**具名常數**）會被抓 ——
因為文字掃描分不出 `WHERE_CLAUSE` 是一個 `static final String` 還是一個使用者輸入。

> 📌 **shop-service 的規定是「SQL 一律用 text block，需要組合就讓左邊那段是常數」**，
> 所以 `SELECT_HEAD + " WHERE id = :id"`（**常數在左、字面值在右**）不會誤判。
> **規則與規範是配套的，不能只抄規則。**
>
> ⚠️ **也要老實說這條規則的極限**：它是**文字掃描**，
> 擋得住「明目張膽的拼接」，擋不住「把 SQL 組在另一個方法裡再傳進來」。
> **它是一道防線，不是證明。**

---

## 2.4 `JdbcTemplate` 的三個方法族

### 2.4.1 全景

`JdbcTemplate` 的方法多得嚇人，但它們其實只有三族：

```
                    ┌────────────────────────────────────────────┐
                    │  execute(...)   ── 什麼都能做，回傳你決定    │
                    │      └─ DDL、預存程序、需要自己拿 Connection │
                    ├────────────────────────────────────────────┤
   會回傳結果集      │  query(...)     ── SELECT                   │
                    │      ├─ query(sql, RowMapper)      → List   │
                    │      ├─ query(sql, ResultSetExtractor) → T   │
                    │      ├─ query(sql, RowCallbackHandler) → void│
                    │      ├─ queryForObject(sql, Class)  → T ⚠️   │
                    │      ├─ queryForList(sql, Class)    → List   │
                    │      └─ queryForMap / queryForList  → Map ⚠️ │
                    ├────────────────────────────────────────────┤
   回傳影響列數      │  update(...)    ── INSERT / UPDATE / DELETE │
                    │      └─ batchUpdate(...)  → int[]（2.13）    │
                    └────────────────────────────────────────────┘
```

⚠️ **標了 ⚠️ 的三個是本節要處理的陷阱。**

### 2.4.2 `queryForObject` 的三個陷阱

`queryForObject` 是**最常被誤用的一個方法**，因為它的名字讓人以為它像 `Optional`。

**實驗 G4-B**：

```
=== G4-B queryForObject 的三個陷阱 ===
  ① 查不到 0 筆 → EmptyResultDataAccessException：Incorrect result size: expected 1, actual 0
  ② 查到 2 筆   → IncorrectResultSizeDataAccessException：Incorrect result size: expected 1, actual 2
  ③ 查到 1 筆但值是 NULL → 回傳 null（不拋例外）
     ⚠️ long n = queryForObject(...) 在 0 筆時 → EmptyResultDataAccessException
  ✅ 正解：用 query() + stream().findFirst() → Optional.empty
```

| 情況 | `queryForObject` 的行為 | 為什麼是陷阱 |
|---|---|---|
| **0 筆** | 拋 `EmptyResultDataAccessException` | 🔴 **「找不到」是很常見的正常情況，不該用例外表達**（00 章判準 4） |
| **2 筆以上** | 拋 `IncorrectResultSizeDataAccessException` | 這個**是**好事 —— 它抓到了「你以為唯一、其實不唯一」 |
| **1 筆但值是 `NULL`** | **回傳 `null`，不拋例外** | 🔴 與「0 筆」的表現完全不同，而呼叫端通常只處理其中一種 |

**所以 `findById` 絕對不能這樣寫**：

```java
// 🔴 錯：查不到就炸了
public Optional<Order> findById(String id) {
    return Optional.ofNullable(
            jdbc.queryForObject("SELECT * FROM orders WHERE id = ?", mapper, id));
}
```

```java
// ✅ 對：查不到就是空的
public Optional<Order> findById(String id) {
    return jdbc.query("SELECT * FROM orders WHERE id = ?", mapper, id)
               .stream().findFirst();
}
```

⚠️ **`.findFirst()` 有一個隱含的決定**：查到多筆時它**默默取第一筆**。
如果 `id` 是主鍵，這不可能發生；**如果不是主鍵，你應該讓它拋例外**：

```java
// 條件不保證唯一時，明確處理「多筆」
List<Order> found = jdbc.query(sql, mapper, args);
if (found.size() > 1) {
    throw new IllegalStateException("預期最多一筆，卻查到 " + found.size() + " 筆：" + sql);
}
return found.stream().findFirst();
```

### 2.4.3 聚合函數的 `null`

**實驗 G4-C**：

```
=== G4-C 聚合函數在「沒有符合的列」時 ===
  COUNT(*) → 0（安全，永遠有一列且不為 null）
  SUM(x)   → null ← ⚠️ 是 null，不是 0
  MAX(x)   → null ← ⚠️ 是 null
```

```java
// 🔴 NullPointerException：沒有訂單的客戶，SUM 回傳 null，拆箱時炸掉
long total = jdbc.queryForObject(
        "SELECT SUM(total_minor) FROM orders WHERE customer_id = ?", Long.class, customerId);

// ✅ 兩種寫法都可以
Long sum = jdbc.queryForObject("SELECT SUM(total_minor) FROM orders WHERE customer_id = ?",
                               Long.class, customerId);
long total = sum == null ? 0L : sum;

// ✅ 或讓資料庫處理
long total = jdbc.queryForObject(
        "SELECT COALESCE(SUM(total_minor), 0) FROM orders WHERE customer_id = ?",
        Long.class, customerId);
```

> 📌 **`COUNT(*)` 是唯一安全的聚合函數** —— 它永遠回傳一列，而且永遠不是 `NULL`。
> **其他每一個（`SUM`、`MAX`、`MIN`、`AVG`）在「沒有符合的列」時都回 `NULL`。**
>
> ⚠️ 這也是為什麼 `countByCustomerId` 在 00 章的骨架裡仍然寫了 `n == null ? 0L : n` ——
> **那一行嚴格說是多餘的，但它讓「這裡想過 null」這件事看得見。**

### 2.4.4 `queryForList` / `queryForMap`：能用，但不要外流

**實驗 G4-D**：

```
=== G4-D queryForList / queryForMap 回傳什麼 ===
  queryForList(sql) → [{ID=O-1, TOTAL_MINOR=38000}, {ID=O-2, TOTAL_MINOR=99900}]
    第一列 total_minor 的 Java 型別：java.lang.Long
  queryForMap(sql) 的 key：[ID, CUSTOMER_ID, STATUS, TOTAL_MINOR, CURRENCY, CREATED_AT, VERSION]
  ⚠️ key 的大小寫由資料庫決定 —— H2 給大寫，MySQL 給原樣
```

🔴 **`Map<String, Object>` 有三個問題，全部都是「編譯器幫不了你」**：

| 問題 | 症狀 |
|---|---|
| **key 的大小寫由資料庫決定** | H2 給 `ID`、MySQL 給 `id` —— **同一段程式碼換資料庫就壞** |
| **打錯 key 不會編譯錯誤** | `row.get("totl_minor")` 回傳 `null`，然後在很遠的地方 NPE |
| **型別是 `Object`** | 每次都要轉型，而**轉錯要到執行期才知道** |

> 📌 **判準**：`queryForList(Map)` 可以用在**「一次性的、不離開這個方法的」**地方
> —— 例如一個健康檢查、一個管理後台的除錯頁面。
>
> 🔴 **它絕對不可以出現在 Repository 的回傳型別上**（00 章 0.11.3：不讓實作細節外流）。
> 正確的做法是 2.5 的 `RowMapper` + 一個 record。

---

## 2.5 ★ 把 `ResultSet` 變成物件

### 2.5.1 三種回呼

**實驗 G5-A** 把三者放在一起對照：

```java
// ① RowMapper：一列 → 一個物件，框架幫你收成 List
RowMapper<String> rowMapper = (rs, rowNum) -> rs.getString("id") + "#" + rowNum;
List<String> a = jdbc.query("SELECT id FROM orders ORDER BY id", rowMapper);

// ② ResultSetExtractor：整個 ResultSet → 一個物件（你自己控制 next()）
ResultSetExtractor<Map<String, Long>> extractor = rs -> {
    Map<String, Long> byCustomer = new LinkedHashMap<>();
    while (rs.next()) {                     // ★ 自己走訪
        byCustomer.merge(rs.getString("customer_id"), rs.getLong("total_minor"), Long::sum);
    }
    return byCustomer;
};
Map<String, Long> b = jdbc.query("SELECT customer_id, total_minor FROM orders", extractor);

// ③ RowCallbackHandler：不回傳（只有副作用）
AtomicLong sum = new AtomicLong();
RowCallbackHandler handler = rs -> sum.addAndGet(rs.getLong("total_minor"));
jdbc.query("SELECT total_minor FROM orders", handler);
```

```
=== G5-A RowMapper / ResultSetExtractor / RowCallbackHandler ===
  RowMapper          → 一列一個物件，框架幫你收成 List：[O-1#0, O-2#1]
  ResultSetExtractor → 整個 ResultSet 一個物件：{C-1=137900}
  RowCallbackHandler → 不回傳（只有副作用），累加結果 = 137900
```

**選擇表**：

| 你要的東西 | 用哪一個 | 為什麼 |
|---|---|---|
| 每一列變成一個物件，全部收成 `List` | **`RowMapper`** ✅ 預設選這個 | 最單純，而且可以重用（同一個 mapper 給多個查詢） |
| **多列拼成一個**（1:N 的聚合、分組、統計） | **`ResultSetExtractor`** | 只有它能跨列累積狀態 |
| 資料量大到**不能收進記憶體** | **`RowCallbackHandler`** | 處理完一列就丟掉，不累積 |
| 只要一個純量（`COUNT`、`SUM`、單一欄位） | `queryForObject(sql, Class)` | 但要注意 2.4.2 的三個陷阱 |

⚠️ **`RowMapper` 的第二個參數 `rowNum` 從 0 開始**（上面的輸出是 `O-1#0`），
而 `ResultSet` 的欄位索引**從 1 開始**。**這兩個編號基準不同，而且都很容易記反。**

### 2.5.2 手寫 `RowMapper`

shop-service 的 `OrderRow` 就是一個手寫的例子（00 章 0.12.4 的版本，2.9 會再改進它）：

```java
package example.shop.order.infrastructure.persistence;

import example.shop.common.money.Money;
import example.shop.order.domain.OrderStatus;
import org.springframework.jdbc.core.RowMapper;

import java.sql.ResultSet;
import java.time.Instant;

/**
 * ★ 一列 = 一個 record，而<b>不是</b>直接 new 一個 Order。
 *
 * <p>理由：一張訂單來自兩個 ResultSet（orders + order_line），
 * 聚合要等兩邊都到齊才能重建（2.5.6）。
 */
record OrderRow(String id, String customerId, OrderStatus status,
                long totalMinor, String currency, Instant createdAt, long version) {

    Money total() { return Money.ofMinorUnits(totalMinor, currency); }

    static RowMapper<OrderRow> mapper() {
        return (ResultSet rs, int rowNum) -> new OrderRow(
                rs.getString("id"),
                rs.getString("customer_id"),
                OrderStatus.valueOf(rs.getString("status")),   // ⚠️ 2.9 會修這一行
                rs.getLong("total_minor"),
                rs.getString("currency"),
                rs.getTimestamp("created_at").toInstant(),
                rs.getLong("version"));
    }
}
```

**手寫的三個好處**：

1. **打錯欄位名會在執行測試時立刻爆炸**（`Column "XXX" not found`），不是靜默給 `null`。
2. **型別轉換寫在一個地方** —— `Money.ofMinorUnits`、`OrderStatus.valueOf`、`toInstant()`。
3. **它是 package-private 的** —— `OrderRow` 這個型別不會外流到 Service（00 章 0.11.3）。

### 2.5.3 自動對應：`DataClassRowMapper`

不想手寫的話，Spring 可以用建構子自動對應到 record。

**實驗 G5-C**：

```java
public record OrderDto(String id, String customerId, long totalMinor, long version) {}

List<OrderDto> ok = jdbc.query(
        "SELECT id, customer_id, total_minor, version FROM orders ORDER BY id",
        new DataClassRowMapper<>(OrderDto.class));
```

```
=== G5-C DataClassRowMapper + record ===
  snake_case 欄位自動對到 camelCase：OrderDto[id=O-1, customerId=C-1, totalMinor=38000, version=3]
  SELECT 少了兩欄：BadSqlGrammarException: bad SQL grammar [SELECT id, customer_id FROM orders ORDER BY id]
  用 AS 別名對應運算式：OrderDto[id=O-1, customerId=C-1, totalMinor=76000, version=3]
```

**三個行為值得記住**：

| 行為 | 說明 |
|---|---|
| `customer_id` → `customerId` | **snake_case 自動轉 camelCase**，不用設定 |
| **SELECT 少了欄位 → 拋例外** ✅ | 它需要建構子的**每一個**參數，少一個就 `BadSqlGrammarException` |
| 運算式用 `AS` 別名對應 | `total_minor * 2 AS total_minor` 就對得上 |

> 📌 **`DataClassRowMapper` 對 record 是「全有或全無」的，這是好事** ——
> 它把「漏掉一個欄位」變成一個**當場爆炸**的錯誤。
> 對照下一節的 `BeanPropertyRowMapper`，差別非常大。

### 2.5.4 ⚠️ `BeanPropertyRowMapper` 會靜默略過

**實驗 G5-D** 用的是一個有 setter 的傳統 bean：

```java
public static class OrderBean {
    private String id;
    private String customerId;
    private long totalMinor;
    private String notAColumn = "預設值";
    // …getter / setter…
}

BeanPropertyRowMapper<OrderBean> lenient = new BeanPropertyRowMapper<>(OrderBean.class);
List<OrderBean> beans = jdbc.query("SELECT id, total_minor FROM orders ORDER BY id", lenient);
```

```
=== G5-D BeanPropertyRowMapper 的靜默 ===
  SELECT 少了 customer_id：OrderBean[id=O-1, customerId=null, totalMinor=38000, notAColumn=預設值]
  ⚠️ customer_id = null，沒有任何警告 —— 打錯欄位名的下場長這樣
  SELECT 多了一個 bean 沒有的欄位：BadSqlGrammarException
```

🔴 **兩個方向的不一致，一個靜默、一個拋例外**：

| 情況 | `BeanPropertyRowMapper` | `DataClassRowMapper`（record） |
|---|---|---|
| **SELECT 少了 bean 需要的欄位** | 🔴 **靜默給 `null`** | ✅ 拋例外 |
| SELECT 多了 bean 沒有的欄位 | 拋例外 | 拋例外 |

> ⚠️ **「靜默給 null」是資料層最糟的一種失敗模式**：
> 你的 `Order` 少了 `customerId`，程式繼續跑，
> **錯誤在很遠的地方（可能是三個服務之外）才浮現。**
>
> 📌 **shop-service 的規定**：
> **只用 `record` + `DataClassRowMapper`，或手寫 `RowMapper`。
> 不使用 `BeanPropertyRowMapper`。**

### 2.5.5 ★★ `NULL`：一個看起來完全正確的錯誤寫法

這是本章**最值得停下來看**的一個實驗，因為它同時踩到 JDBC 的規則與 Java 的規則。

**背景**：`orders` 加了一個 `discount_minor BIGINT` 欄位，目前全部是 `NULL`。

**實驗 G5-E**：

```java
record Naive(String id, long discount) {}
record Safe(String id, Long discount) {}

// ① 直接 getLong
List<Naive> naive = jdbc.query("SELECT id, discount_minor FROM orders ORDER BY id",
        (rs, n) -> new Naive(rs.getString("id"), rs.getLong("discount_minor")));

// ② 用 wasNull()，但寫在引數列裡
List<Safe> buggy = jdbc.query("SELECT id, discount_minor FROM orders ORDER BY id",
        (rs, n) -> {
            long v = rs.getLong("discount_minor");
            return new Safe(rs.getString("id"), rs.wasNull() ? null : v);
        });

// ③ 用 wasNull()，緊接在那個 getter 之後
List<Safe> safe = jdbc.query("SELECT id, discount_minor FROM orders ORDER BY id",
        (rs, n) -> {
            String id = rs.getString("id");
            long v = rs.getLong("discount_minor");
            Long discount = rs.wasNull() ? null : v;
            return new Safe(id, discount);
        });

// ④ getObject
List<Safe> viaObject = jdbc.query("SELECT id, discount_minor FROM orders ORDER BY id",
        (rs, n) -> new Safe(rs.getString("id"), (Long) rs.getObject("discount_minor")));
```

```
=== G5-E NULL 欄位：rs.getLong 回什麼 ===
  rs.getLong                    → [Naive[id=O-1, discount=0], Naive[id=O-2, discount=0]]
    ↑ 🔴 NULL 變成 0，「沒有折扣」與「折扣 0 元」分不出來
  wasNull() 寫在引數列裡        → [Safe[id=O-1, discount=0], Safe[id=O-2, discount=0]]
    ↑ 🔴🔴 看起來對，實際上 wasNull() 問到的是 id 那一欄（引數由左到右求值）
  wasNull() 緊接在 getter 之後  → [Safe[id=O-1, discount=null], Safe[id=O-2, discount=null]] ← ✅
  rs.getObject(…)               → [Safe[id=O-1, discount=null], Safe[id=O-2, discount=null]] ← ✅ 更短
```

**兩個獨立的坑**：

🔴 **坑一：`rs.getLong()` 讀到 `NULL` 回傳 `0`，不是 `null`。**

> JDBC 的所有**原始型別** getter 都是這樣：
> `getInt`/`getLong` → `0`、`getDouble` → `0.0`、`getBoolean` → `false`。
>
> ⚠️ **後果的嚴重性取決於欄位的語意**：
> `discount_minor` 是 `NULL`（沒有套用折扣）與 `0`（折扣 0 元）在報表上是兩件事；
> 而如果那個欄位是 `balance`，**「沒有帳戶」會變成「餘額 0 元」**。

🔴🔴 **坑二：`wasNull()` 說的是「上一個從這個 `ResultSet` 讀出來的欄位」。**

```java
return new Safe(rs.getString("id"), rs.wasNull() ? null : v);
//                  ↑ 這個先執行        ↑ 所以這裡問的是 "id" 這一欄
```

> ⚠️ **Java 的方法引數是【由左到右】求值的**，
> 所以 `rs.getString("id")` 在 `rs.wasNull()` **之前**執行，
> `wasNull()` 於是回報 `id` 那一欄的狀態（不是 `NULL`）→ 走了 `: v` 那一邊 → 得到 `0`。
>
> 🔴 **這段程式碼看起來完全正確，通過 code review，而且測試如果只用「有值」的資料就是綠的。**

**兩條規則**：

> 📌 **規則一：`wasNull()` 一定要緊接在它要問的那個 getter 之後，中間不可以有任何其他的 `rs.getXxx()`。**
>
> 📌 **規則二：能用 `rs.getObject(col, Long.class)` 就用它** ——
> 它直接回 `null`，**完全不需要 `wasNull()`，也就沒有順序問題。**

⚠️ **`getObject` 也有一個要注意的地方**：
`(Long) rs.getObject("discount_minor")` 這種**直接轉型**依賴驅動回傳的具體型別
（H2 的 `BIGINT` 回 `Long`，但別的驅動可能回 `BigInteger`）。
**更保險的是兩個參數的版本**：

```java
Long discount = rs.getObject("discount_minor", Long.class);   // ✅ JDBC 4.1，由驅動負責轉換
```

### 2.5.6 `ResultSetExtractor`：把 1:N 攤平成聚合

一張訂單 = `orders` 一列 + `order_line` N 列。把它們變成一個 `Order` 物件有**兩種策略**。

**策略 A：一次 JOIN 查詢 + `ResultSetExtractor`**（實驗 G5-B）：

```java
record LineDto(String productId, int quantity) {}
record OrderAgg(String id, List<LineDto> lines) {}

ResultSetExtractor<List<OrderAgg>> extractor = rs -> {
    Map<String, List<LineDto>> lines = new LinkedHashMap<>();
    while (rs.next()) {
        lines.computeIfAbsent(rs.getString("id"), k -> new ArrayList<>())
             .add(new LineDto(rs.getString("product_id"), rs.getInt("quantity")));
    }
    return lines.entrySet().stream().map(e -> new OrderAgg(e.getKey(), e.getValue())).toList();
};

List<OrderAgg> aggs = jdbc.query("""
        SELECT o.id, l.product_id, l.quantity
          FROM orders o JOIN order_line l ON l.order_id = o.id
         ORDER BY o.id, l.line_no
        """, extractor);
```

```
=== G5-B 一次 JOIN 查詢 → 聚合（不是 N+1） ===
  O-1 → [LineDto[productId=P-1, quantity=2], LineDto[productId=P-2, quantity=1]]
  O-2 → [LineDto[productId=P-3, quantity=3]]
  查詢次數：1（骨架的 load() 是 2 次：先頭再 IN 明細）
```

**策略 B：兩次查詢（先查頭，再用 `IN` 一次撈所有明細）** —— 這是 shop-service 骨架的做法。

**兩者的取捨**：

| | 策略 A：一次 JOIN | 策略 B：兩次查詢 |
|---|---|---|
| 查詢次數 | **1** | 2 |
| **傳輸量** | 🔴 **訂單的頭部欄位被重複 N 次**（20 筆明細 = 頭部傳 20 遍） | ✅ 每個欄位各傳一次 |
| 程式碼複雜度 | 要自己處理「換了一張訂單」的邊界 | ✅ 兩個單純的 `RowMapper` |
| **`ORDER BY` 是必要的嗎** | 🔴 **是** —— 沒排序的話同一張訂單的列可能不連續 | 否（用 `groupingBy` 收） |
| 明細是空的時候 | 用 `JOIN` 會**整張訂單消失**（要改 `LEFT JOIN`） | ✅ 自然就是空 List |
| **分頁** | 🔴 **很難** —— `LIMIT 10` 限制的是「列」不是「訂單」 | ✅ 頭部查詢照常分頁 |

> 📌 **shop-service 選策略 B**，決定性的理由是**最後兩列**：
> `LEFT JOIN` 的陷阱與分頁。
> **04 章的分頁全部建立在「頭部查詢可以獨立分頁」這個前提上。**
>
> ⚠️ **兩種都不是「N+1」** —— N+1 是「查了 1 次頭，然後對每張訂單各查一次明細」。
> **策略 B 的第二次查詢是 `IN (:ids)`，一次撈完所有明細**（2.6.3）。

### 2.5.7 `RowCallbackHandler` 與大量資料

**實驗 G5-F**：一張 20 萬列、每列 200 字元的表。

```java
// ① 收成 List
List<String> all = jdbc.query("SELECT payload FROM big", (rs, n) -> rs.getString("payload"));

// ② 串流處理
AtomicLong chars = new AtomicLong();
jdbc.query("SELECT payload FROM big",
        (RowCallbackHandler) rs -> chars.addAndGet(rs.getString(1).length()));
```

```
=== G5-F 20 萬列：query(List) vs RowCallbackHandler ===
  query() 收成 List  ：堆疊增加約 16 MB
  RowCallbackHandler：堆疊增加約 1 MB（處理了 40,000,000 個字元）
  ⚠️ H2 是 in-process 的，真實 JDBC 驅動還要靠 fetchSize 才不會整批載入
```

⚠️ **最後那一行警告非常重要，不能跳過**：

> `RowCallbackHandler` 讓**你的程式碼**不累積物件，
> **但它管不到「驅動有沒有把整個結果集先抓回本地」。**
>
> | 資料庫 | 預設行為 | 要串流的話 |
> |---|---|---|
> | **H2**（in-process） | 沒有網路，不適用 | — |
> | MySQL | 🔴 **驅動預設把整個結果集抓回記憶體** | `setFetchSize(Integer.MIN_VALUE)` ⚠️ 是這個怪值，不是一個正數 |
> | PostgreSQL | 🔴 同上 | `setFetchSize(n)` **而且必須關掉 autoCommit** |
>
> 🔴 **【本章未驗證】MySQL 與 PostgreSQL 的串流行為**（本機沒有這兩個資料庫）——
> **05 章 5.11 與 06 章 6.4 會實測**（06 章探針 ⑲ 證實 MySQL 要 `fetchSize=Integer.MIN_VALUE`）。
>
> ⚠️ **所以「我用了 `RowCallbackHandler` 所以不會 OOM」是錯的** ——
> 在 MySQL 上，**沒設 `fetchSize` 的話，OOM 發生在驅動裡，你的 handler 一次都還沒被呼叫。**

---

## 2.6 ★ 具名參數

### 2.6.1 先看位置參數會出什麼事

**實驗 G6-D** 分兩種情況，而**第二種才是真正危險的那個**：

```java
String v3 = "SELECT id FROM orders WHERE customer_id = ? AND status = ?";
List<String> correct = jdbc.queryForList(v3, String.class, "C-1", "PENDING_PAYMENT");
List<String> swapped = jdbc.queryForList(v3, String.class, "PENDING_PAYMENT", "C-1");  // 寫反了
```

```
=== G6-D 位置參數 vs 具名參數：改需求的時候 ===
  v1（3 個 ?）：[O-3, O-5]
  v2-a 型別不相容：拋例外 DataIntegrityViolationException（型別不相容，運氣好）
  v2-b 兩個都是字串，值寫反了：
        正確順序 → [O-1, O-3, O-5]
        寫反了   → [] ← 🔴 沒有例外、沒有警告，只是「查不到資料」
        ⚠️ 這種 bug 會被當成「使用者沒有訂單」，可能幾個月都沒人發現
```

| 情況 | 下場 |
|---|---|
| 錯位的兩個參數**型別不相容** | ✅ 當場拋例外 —— **運氣好** |
| 錯位的兩個參數**都是字串** | 🔴 **靜默回傳空結果**，看起來像「這個使用者沒有訂單」 |

⚠️ **而參數會錯位的最常見原因不是打字錯誤，是「改需求」**：
有人在 `WHERE` 的**中間**插了一個新條件，`?` 的編號就全部往後移了一格。
**如果新的值被加在引數列的最後面，這段程式碼會編譯成功、測試可能還是綠的。**

### 2.6.2 具名參數展開成什麼

具名參數不是資料庫的功能 —— **是 Spring 在送出去之前做的字串處理**。

**實驗 G6-A** 直接呼叫 Spring 內部的 `NamedParameterUtils` 把過程印出來：

```java
ParsedSql parsed = NamedParameterUtils.parseSqlStatement(sql);
String expanded  = NamedParameterUtils.substituteNamedParameters(parsed, paramSource);
Object[] args    = NamedParameterUtils.buildValueArray(parsed, paramSource, null);
```

```
=== G6-A 具名參數 → 真正送給資料庫的 SQL ===
  原始：SELECT * FROM orders WHERE id = :id
    展開：SELECT * FROM orders WHERE id = ?
    參數：[O-1]（1 個）
  原始：SELECT * FROM orders WHERE id IN (:ids)
    展開：SELECT * FROM orders WHERE id IN (?, ?, ?)
    參數：[[O-1, O-2, O-3]]（1 個）
  原始：SELECT * FROM orders WHERE customer_id = :c AND status = :s AND :c IS NOT NULL
    展開：SELECT * FROM orders WHERE customer_id = ? AND status = ? AND ? IS NOT NULL
    參數：[C-1, PAID, C-1]（3 個）
```

**三件事**：

1. `:id` → `?`，**送給資料庫的仍然是位置參數**（所以安全性與效能完全一樣）。
2. **`IN (:ids)` 是 Spring 展開的**，展開成 `IN (?, ?, ?)` —— 不是資料庫功能。
3. **同一個名字用兩次會產生兩個 `?`**，值被填兩次（第三列的 `:c`）。

### 2.6.3 `IN (:ids)` 的三個邊界

**實驗 G6-B**：

```
=== G6-B IN (:ids) 的邊界 ===
  正常 2 個：[O-1, O-3]
  空集合  ：沒有拋例外，回傳 []
    空集合展開成：SELECT id FROM orders WHERE id IN () ← 🔴 是「IN ()」，H2 收，但 MySQL / PostgreSQL 是語法錯誤
  3000 個  ：成功，回傳 5 筆，耗時 27 ms
    ⚠️ Oracle 的 IN 上限是 1000；MySQL 受 max_allowed_packet 限制
  含 null ：[O-1] ← ⚠️ SQL 的 NULL 比不出相等，那個 null 等於白給
```

🔴🔴 **第二列是這一站「H2 會騙你」（00 章 0.5.4）的又一個標本**：

> 空的 `List` 被展開成 **`IN ()`**。
> **H2 接受它並回傳空結果，看起來完全正常。**
>
> ⚠️ **而 `IN ()` 在 MySQL 與 PostgreSQL 上是【語法錯誤】。**
> 🔴 **【本章未驗證】** 這兩個資料庫的實際錯誤（本機沒有它們），
> 但這是有文件依據的語法規則，**07-mysql 站會實測**。
>
> 📌 **所以「在 H2 上測過了」對這一行完全沒有保護作用** ——
> 上線之後，只要有一次「篩選之後剛好沒有 id」，那支 API 就 500。

**正解：在送出去之前就擋掉**：

```java
private List<Order> load(String headSql, SqlParameterSource params) {
    List<OrderRow> heads = jdbc.query(headSql, params, OrderRow.mapper());
    if (heads.isEmpty()) return List.of();      // ★ 空集合不能送進 IN ()

    Map<String, List<OrderLineRow>> linesByOrder = jdbc.query(
            "SELECT … FROM order_line WHERE order_id IN (:ids) ORDER BY order_id, line_no",
            new MapSqlParameterSource("ids", heads.stream().map(OrderRow::id).toList()),
            OrderLineRow.mapper())
        .stream().collect(Collectors.groupingBy(OrderLineRow::orderId));
    …
}
```

**另外兩個邊界**：

| 邊界 | 說明 |
|---|---|
| **數量上限** | Oracle 的 `IN` 硬性上限是 **1000**；MySQL 受 `max_allowed_packet` 限制；**而不管哪一種，幾千個 `?` 的執行計畫快取一定打不中** |
| **`null` 混在集合裡** | `IN (?, ?)` 其中一個是 `NULL` → **SQL 的 `NULL` 比不出相等**，那個位置形同浪費。要找 `NULL` 得寫 `OR col IS NULL` |

> 📌 **實務上的門檻**：`IN` 的元素超過**幾百個**就該換做法 ——
> 改成 `JOIN` 一張暫存表、或分批查詢。**04 章會處理它。**

### 2.6.4 `LIMIT :limit`（00 章骨架問題 ④）

00 章的骨架留了一個問題：`LIMIT :limit` 的具名參數在某些資料庫上不支援。

**實驗 G6-C**：

```
=== G6-C LIMIT :limit 在 H2 上 ===
  H2 2.2.224：✅ 可以，回傳 [O-1, O-2]
  標準 SQL 的 FETCH FIRST :limit ROWS ONLY：✅ [O-1, O-2]
  ⚠️ LIMIT 是方言；Oracle 11g 以前只有 ROWNUM。可攜的寫法是 FETCH FIRST
```

**兩種寫法在 H2 上都可以**，但它們的可攜性不同：

| 寫法 | 標準？ | 支援 |
|---|---|---|
| `LIMIT :limit` | ❌ 方言 | MySQL / PostgreSQL / H2 ✅，**Oracle 11g 以前沒有** |
| `FETCH FIRST :limit ROWS ONLY` | ✅ **SQL:2008 標準** | H2 / PostgreSQL / Oracle 12c+ / SQL Server 2012+，**MySQL 8.0 不支援** ⚠️ |

🔴 **注意：沒有一種寫法是「到處都能跑」的。**

> 📌 **shop-service 的決定：用 `FETCH FIRST … ROWS ONLY`。**
>
> ⚠️ **而這個決定有一個代價要說清楚**：
> **MySQL 8.0 不支援 `FETCH FIRST`**（它只認 `LIMIT`）——
> 🔴 **【本章未驗證】**，本機沒有 MySQL。
>
> **所以這裡真正的教訓不是「選哪一個」，而是**：
> **「分頁語法是方言」這件事本身就是抽象洩漏（00 章 0.5.1）。**
> 真正的解法是 04 章的 `Pageable` —— **讓框架去處理方言**，
> 而在那之前，**這一行要標記成「換資料庫時要改」**。
>
> ---
>
> 🔴 ★★ **06 章回頭補的結果：這個決定是【錯的】，而且它讓兩條契約在真 MySQL 上是紅的。**
>
> ```
> [ERROR] Tests run: 17, Failures: 0, Errors: 2 -- in lab.MySqlJdbcOrderRepositoryContractTest
> PreparedStatementCallback; bad SQL grammar [… ORDER BY created_at, id
>  FETCH FIRST ? ROWS ONLY]
> ```
>
> **上面那句「MySQL 8.0 不支援」寫對了 —— 而它沒有阻止這段程式碼被寫下來，
> 也沒有讓任何一條測試變紅，因為測試跑在 H2 上。這一行在 H2 上綠了整整四章。**
>
> 📌 **修正在 06 章 6.6.3**：把分頁子句變成建構子參數
> （`FETCH_FIRST` / `LIMIT` 兩個常數），讓「支援哪些資料庫」變成一個看得見的決定。
>
> ⚠️ **而這件事的教訓比「選哪一個」大得多**：
> **「標準的」不等於「可攜的」。可攜性是一個【實測】的問題，不是一個【查文件】的問題。**

### 2.6.5 三種 `SqlParameterSource`

```java
// ① MapSqlParameterSource：最常用，可以鏈式呼叫
SqlParameterSource p1 = new MapSqlParameterSource()
        .addValue("id", order.id())
        .addValue("status", order.status().name())
        .addValue("totalMinor", order.total().minorUnits());

// ② BeanPropertySqlParameterSource：從 bean / record 的屬性自動取
record NewOrder(String id, String customerId, long totalMinor) {}
SqlParameterSource p2 = new BeanPropertySqlParameterSource(new NewOrder("O-1", "C-1", 380));

// ③ 直接給 Map（最省事，但沒有型別提示）
Map<String, Object> p3 = Map.of("id", "O-1", "status", "PAID");
```

⚠️ **`BeanPropertySqlParameterSource` 有一個與 2.5.4 對稱的問題**：
`:notAColumn` 這種**打錯的參數名**會在執行期才發現。
**而它的好處在批次時很明顯**（2.13.3）。

### 2.6.6 型別：`Instant`、`enum`、`null`

**實驗 G6-E**：

```
=== G6-E Instant / enum / null 怎麼傳 ===
  Instant：✅ 直接丟 java.time.Instant 也可以（JDBC 4.2 的 setObject）
  Timestamp 存進去讀回來：2026-03-01 18:00:00.0（本機時區 Asia/Taipei）
    ⚠️ Timestamp.from(Instant) 用的是 JVM 預設時區 —— 01 章 1.4 的同一個坑
  enum：一定要自己 .name()，不要直接丟 enum 物件
    直接丟 enum 物件：🔴 DataIntegrityViolationException
  null：✅ 可以（Spring 用 setNull(Types.NULL)）
    保險寫法：addValue("note", null, Types.VARCHAR)
```

**三條規則**：

| 型別 | 規則 |
|---|---|
| **`enum`** | 🔴 **一定要 `.name()`** —— 直接丟 enum 物件會拋例外。<br>⚠️ 而且**不要用 `.ordinal()`** —— 在 enum 中間插一個常數，全部的舊資料就錯位了 |
| **時間** | 可以直接丟 `Instant`，但 `Timestamp.from()` **會用 JVM 預設時區**。<br>📌 shop-service 的規定：**全部存 UTC，URL 釘住 `connectionTimeZone=UTC`**（01 章 1.4） |
| **`null`** | `addValue("x", null)` 可以動，但**保險的寫法是帶型別**：`addValue("x", null, Types.VARCHAR)`。<br>⚠️ 有些驅動在 `setNull(Types.NULL)` 時會抱怨「不知道這是什麼型別」 |

---

## 2.7 SQL 放在哪裡

**三個選項，shop-service 選第二個**：

| 放法 | 優點 | 缺點 |
|---|---|---|
| 直接寫在方法裡 | 看得到 | 同一句 SQL 重複、長方法 |
| **`private static final String` + text block** ✅ | **SQL 集中在 class 頂端、可重用、守門測試好掃**（2.3.8） | 要在檔案裡上下跳 |
| 外部 `.sql` 檔 | DBA 可以直接看 | 🔴 **打錯檔名要到執行期才知道**；IDE 的 SQL 檢查失效 |

```java
public class JdbcOrderRepository implements OrderRepository {

    private static final String SELECT_HEAD = """
            SELECT id, customer_id, status, total_minor, currency, created_at, version
              FROM orders
            """;

    private static final String UPDATE_HEAD = """
            UPDATE orders
               SET status = :status, total_minor = :totalMinor, currency = :currency,
                   version = version + 1
             WHERE id = :id AND version = :version
            """;
    …
}
```

⚠️ **text block 的兩個陷阱**：

```java
// ① 縮排以「最靠左的那一行」為基準 —— 包含結尾的 """
String sql = """
        SELECT id FROM orders
        """;          // ← 這一行的位置決定了縮排基準

// ② 結尾自動有一個換行。要串接的時候會多一個空行（通常無害，但看 log 會困惑）
String combined = SELECT_HEAD + " WHERE id = :id";   // ✅ SELECT_HEAD 結尾有換行，所以安全
```

📌 **`SELECT_HEAD + " WHERE id = :id"` 這種串接是安全的** ——
因為**兩邊都是常數**，沒有任何變數進到 SQL 裡。
**這正是 2.3.8 守門測試的規則要配合「SQL 一律用 text block」的原因。**

---

## 2.8 ★★ `save()`：新增與更新是同一個方法

**這是每個專案都會遇到的問題**，而 00 章的骨架在這裡留了一個 bug 與一個效能問題。

`OrderRepository` 的介面只有一個 `save(Order)` —— 這是**刻意的**：
Service 不應該知道「這張訂單是新的還是舊的」，那是資料層的事（00 章判準 1）。

### 2.8.1 四種寫法

**實驗 G7-A** 測量「新增一張**新**訂單」各要幾次來回：

```
=== G7-A 四種寫法：新增一張【新】訂單各要幾次來回 ===
  ① 先 SELECT 再決定       ：2 次來回（而且 SELECT 與 INSERT 之間有競賽視窗）
  ② 先 UPDATE 再判斷（骨架）：3 次來回 ← 🔴 新單的常見路徑最貴
  ③ MERGE（標準 SQL）       ：1 次來回 ← ✅ 最少，但沒有樂觀鎖
  ④ MERGE … KEY（H2 方言）  ：1 次來回 ← ⚠️ 換 MySQL 要改寫成 ON DUPLICATE KEY UPDATE
```

**四種寫法的完整樣子**：

```java
// ① 先 SELECT 再決定
Long exists = jdbc.queryForObject("SELECT COUNT(*) FROM orders WHERE id = :id",
        new MapSqlParameterSource("id", order.id()), Long.class);
if (exists == 0) jdbc.update(INSERT_HEAD, params); else jdbc.update(UPDATE_HEAD, params);

// ② 先 UPDATE 再判斷（00 章骨架）
int updated = jdbc.update(UPDATE_HEAD, params);
if (updated == 0) {
    Long rows = jdbc.queryForObject("SELECT COUNT(*) FROM orders WHERE id = :id", …, Long.class);
    if (rows > 0) throw new OptimisticLockingFailureException(…);   // version 對不上
    jdbc.update(INSERT_HEAD, params);                               // 真的是新的
}

// ③ MERGE（SQL:2003 標準，H2 / Oracle / SQL Server 支援）
jdbc.update("""
        MERGE INTO orders t
        USING (SELECT CAST(:id AS VARCHAR(26)) AS id) s ON t.id = s.id
        WHEN MATCHED THEN UPDATE SET t.status = :status, t.total_minor = :totalMinor
        WHEN NOT MATCHED THEN
            INSERT (id, customer_id, status, total_minor, currency, created_at, version)
            VALUES (:id, :customerId, :status, :totalMinor, :currency, CURRENT_TIMESTAMP, :version)
        """, params);

// ④ 各家的簡寫方言
//   H2：        MERGE INTO orders (…) KEY (id) VALUES (…)
//   MySQL：     INSERT INTO orders (…) VALUES (…) ON DUPLICATE KEY UPDATE status = VALUES(status)
//   PostgreSQL：INSERT INTO orders (…) VALUES (…) ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status
```

### 2.8.2 「先 SELECT 再 INSERT」的競賽視窗

**實驗 G7-B**：8 個執行緒同時存同一個 id，中間隔 20 ms（模擬真實的網路來回與應用邏輯）。

```
=== G7-B 先 SELECT 再 INSERT：8 個執行緒同時存同一個 id（視窗中間 sleep 20ms） ===
  成功 INSERT：1 次
  撞主鍵    ：7 次 → DuplicateKeyException / cause=JdbcSQLIntegrityConstraintViolationException
  最後資料表裡有 1 筆（不管撞了幾次，資料是對的）
```

> 📌 **這是 00 章 0.8.1 的同一個形狀**：「先檢查、再動作」在併發下永遠有視窗。
>
> ✅ **但這一次結果是【對】的** —— 因為**主鍵**接住了它（00 章 0.8.4 的唯一索引）。
> **7 個執行緒拿到例外，資料庫裡仍然只有 1 筆。**
>
> ⚠️ **對照 00 章 0.8.2 的超賣實驗**：那裡的 `CHECK (qty >= 0)` **一次都沒有觸發**，
> 因為 lost update 寫進去的每一個絕對值都合法。
> **差別在於：主鍵約束檢查的是「這一列存不存在」（存在性），
> 而 `CHECK` 檢查的是「這個值合不合法」（值域）。**
> **存在性約束擋得住競賽，值域約束擋不住。**

### 2.8.3 ★ 要樂觀鎖，就不能用單句 upsert

**實驗 G7-C** 是本節最重要的一個結果。

```java
// 資料庫裡 O-1 的 version = 5。現在有人拿著過期的 version = 4 來存。
jdbc.update("""
        MERGE INTO orders (id, customer_id, status, total_minor, currency, created_at, version)
        KEY (id)
        VALUES (:id, :customerId, :status, :totalMinor, :currency, CURRENT_TIMESTAMP, :version)
        """, p("O-1", "CANCELLED", 999, 4));
```

```
=== G7-C MERGE vs 樂觀鎖 ===
  拿著過期的 version=3 做 MERGE → 資料變成 CANCELLED/4 ← 🔴 覆蓋成功，樂觀鎖形同虛設
  同樣拿著過期的 version=3 做帶條件 UPDATE → 影響 0 列 ← ✅ 擋下來了
```

🔴 **`MERGE` 直接覆蓋掉了別人的修改，而且完全沒有報錯。**

> 📌 **原因是語意衝突，不是實作缺陷**：
>
> | | `MERGE` / upsert | 帶 `version` 的 `UPDATE` |
> |---|---|---|
> | 語意 | **「不管現在是什麼，寫成這樣」** | 「**如果**現在還是我讀到的樣子，才寫」 |
> | 有條件嗎 | ❌ 沒有（只比對鍵） | ✅ `AND version = :version` |
>
> **兩者要的是相反的東西，所以不可能同時擁有。**

**這直接決定了 shop-service 的選擇**：

> ✅ **選 ②（先 UPDATE 再判斷）**，因為 `orders` **需要樂觀鎖**
> （00 章 0.8.7 的做法 A：訂單會被客服與客戶同時修改）。
>
> ⚠️ **代價是 2.8.5 量到的「新單多兩次來回」。**
> **這個代價是划算的**，理由在 2.8.6。

📌 **反過來說，什麼時候 upsert 是對的？**
**當那張表沒有「併發修改」的問題時** —— 例如：

- **統計快取表**（`daily_summary`）：本來就是「算出來覆蓋上去」
- **外部系統同步過來的資料**：來源是唯一的真相，沒有「兩個人同時改」
- **設定表**：最後寫的人贏，就是預期行為

### 2.8.4 ★ 骨架的靜默 bug 與修法

**實驗 G7-D** 重現了本章開頭那個 bug：

```
=== G7-D 只 UPDATE orders、不動 order_line ===
  save() 之後，資料庫裡的明細：[P-1, P-2] ← 🔴 P-2 還在，而且沒有任何錯誤
  改成「全刪重插」之後：[P-1] ← ✅
```

**修好的 `save()`**：

```java
@Override
public void save(Order order) {
    int updated = jdbc.update(UPDATE_HEAD, headParams(order));
    if (updated == 1) {
        // ★ 這一段就是骨架漏掉的：頭更新了，明細也要跟著維護
        jdbc.update("DELETE FROM order_line WHERE order_id = :id",
                new MapSqlParameterSource("id", order.id()));
        insertLines(order);
        return;
    }
    // 更新了 0 列，有兩種可能：這一列不存在（新單），或 version 對不上（有人改過）
    Long rows = jdbc.queryForObject("SELECT COUNT(*) FROM orders WHERE id = :id",
            new MapSqlParameterSource("id", order.id()), Long.class);
    if (rows != null && rows > 0) {
        throw new OptimisticLockingFailureException(
                "訂單 " + order.id() + " 已被其他交易修改（本次帶的 version=" + order.version() + "）");
    }
    jdbc.update(INSERT_HEAD, headParams(order));
    insertLines(order);
}
```

⚠️ **注意 `updated == 0` 之後那次 `SELECT COUNT(*)` 是必要的**：
「更新了 0 列」有**兩個**完全不同的原因，而 `update()` 的回傳值分不出來 ——
**這一列不存在（要 INSERT）**，還是**存在但 version 對不上（要拋樂觀鎖例外）**。

> 🔴 **如果省略這次查詢、直接 INSERT**，那麼「樂觀鎖衝突」會變成「主鍵重複」：
> 使用者看到的訊息從「這張單剛被別人改過，請重新整理」變成一個 500。

**「全刪重插」的四個代價**（00 章練習 3 的答案，這裡落地）：

| 代價 | 說明 |
|---|---|
| **寫入放大** | 明細沒變也重寫 —— 20 筆明細的訂單，改個狀態就寫 21 列 |
| **鎖的範圍變大** | `DELETE` + `INSERT` 會鎖住那些列，併發改同一張單更容易衝突 |
| **外鍵的連鎖** | 如果有別的表參照 `order_line`（例如出貨明細），全刪會違反外鍵 |
| **失去「哪一筆變了」** | 稽核日誌只能說「明細變了」，不能說「刪了 P-2」 |

> 📌 **判準（03 章 3.7 會完整比較）**：
> **明細數量少（< 50）且沒有別的表參照它 → 全刪重插；否則做 diff。**
> **shop-service 的訂單明細上限是 50 筆，所以選全刪重插。**

### 2.8.5 「先 UPDATE 再判斷」對新單的成本

**實驗 G7-E**：新增 2000 張**全新**的訂單。

```
=== G7-E 新增 2000 張【新】訂單 ===
  先 UPDATE 再判斷（3 次來回）：170 ms
  直接 INSERT（1 次來回）     ：35 ms
  倍數：4.9 倍
  ⚠️ H2 是 in-process 的，沒有網路來回 —— 真實資料庫上這個差距只會更大
```

⚠️ **這個 4.9 倍要小心解讀**：

> 它量的是「**全部都是新單**」的極端情況。
> 真實的 `save()` 呼叫裡，**更新遠多於新增**（一張訂單建立一次、被改很多次），
> 而**更新路徑只有 1～2 次來回**（UPDATE + 明細維護）。
>
> 📌 **如果你的場景真的是「大量新增」（匯入、批次建單）**，
> **正確的解法不是換 upsert，是換 `insertAll()`**（05 章 5.8 的批次）——
> **因為那個場景你【本來就知道】它們是新的。**

### 2.8.6 決策表

| 你的情況 | 選哪一種 | 理由 |
|---|---|---|
| **聚合會被併發修改**（訂單、帳戶、庫存） | **② 先 UPDATE 再判斷** | 只有它能做樂觀鎖（2.8.3） |
| 快取表、同步表、設定表 | **③/④ upsert** | 語意就是「覆蓋」，而且省來回 |
| **大量新增而且你知道它們是新的** | 批次 `INSERT`（05 章） | 不要用 `save()` 迴圈 |
| 「先 SELECT 再決定」 | 🔴 **不要** | 來回不比 ② 少，而且多一個競賽視窗 |

---

## 2.9 `RowMapper` 的健壯性：資料庫裡有你不認識的值

00 章指出了骨架的一個脆弱點：`OrderStatus.valueOf(rs.getString("status"))`。

**實驗 G10-A**：資料庫裡放一筆 `status = 'COMPLETED'`（舊版留下來的狀態，程式碼裡沒有這個常數）。

```
=== G10-A 資料庫裡有 'COMPLETED'，但 OrderStatus 沒有這個常數 ===
  ① 直接 valueOf → IllegalArgumentException: No enum constant example.shop.order.domain.OrderStatus.COMPLETED
     ⚠️ 看起來像程式 bug，其實是資料問題；而且訊息沒說是【哪一張訂單】
  ② 加上情境 → 訂單 O-2 的 status 是資料庫裡的「COMPLETED」，而程式碼認得的只有
     [PENDING_PAYMENT, PAID, PARTIALLY_SHIPPED, SHIPPED, DELIVERED, CANCELLED, REFUNDED]。
     這是資料問題，不是查詢問題。
  ③ 守門測試：資料庫裡出現過但程式碼不認得的狀態 = [COMPLETED]
```

**改進後的 `OrderRow`**：

```java
package example.shop.order.infrastructure.persistence;

import example.shop.common.money.Money;
import example.shop.order.domain.OrderStatus;
import org.springframework.jdbc.core.RowMapper;

import java.sql.ResultSet;
import java.time.Instant;
import java.util.List;

record OrderRow(String id, String customerId, OrderStatus status,
                long totalMinor, String currency, Instant createdAt, long version) {

    Money total() { return Money.ofMinorUnits(totalMinor, currency); }

    static RowMapper<OrderRow> mapper() {
        return (ResultSet rs, int rowNum) -> {
            String id = rs.getString("id");
            return new OrderRow(
                    id,
                    rs.getString("customer_id"),
                    parseStatus(id, rs.getString("status")),      // ★ 改這裡
                    rs.getLong("total_minor"),
                    rs.getString("currency"),
                    rs.getTimestamp("created_at").toInstant(),
                    rs.getLong("version"));
        };
    }

    /** ★ 未知狀態是「資料問題」，訊息要說得出是哪一筆、以及認得哪些值。 */
    private static OrderStatus parseStatus(String orderId, String raw) {
        try {
            return OrderStatus.valueOf(raw);
        } catch (IllegalArgumentException e) {
            throw new IllegalStateException(
                    "訂單 " + orderId + " 的 status 在資料庫裡是「" + raw
                            + "」，而程式碼認得的只有 " + List.of(OrderStatus.values())
                            + "。這是資料問題（可能是舊版遺留或遷移漏掉），不是查詢寫錯。", e);
        }
    }
}
```

**三個改進，每一個對應一個具體的處境**：

| 改進 | 半夜被叫起來的人因此少做什麼 |
|---|---|
| **說出是哪一張訂單** | 不用自己寫 SQL 去找「是哪一筆炸的」 |
| **列出程式碼認得的值** | 一眼看出是多了一個舊值，還是拼錯 |
| **說明「這是資料問題」** | 不會先去翻查詢的程式碼（那裡沒有問題） |

⚠️ **一個要抵抗的誘惑：「不認識的就給一個預設值」。**

```java
// 🔴 不要這樣
catch (IllegalArgumentException e) {
    return OrderStatus.PENDING_PAYMENT;      // 「先讓它跑起來」
}
```

> 🔴 **這會把一個「大聲的錯誤」變成一個「安靜的錯誤」**：
> 一張已完成的訂單變成「待付款」，然後**排程真的去催款**、
> 或是**取消它**（因為逾期未付款）。
> **資料問題會變成業務事故。**

**而更好的做法是讓它根本不會發生（③ 的守門測試）**：

```java
@Test
void 資料庫裡的status都是程式碼認得的值() {
    List<String> distinct = jdbc.queryForList("SELECT DISTINCT status FROM orders", String.class);
    List<String> known = Arrays.stream(OrderStatus.values()).map(Enum::name).toList();
    assertThat(distinct)
            .describedAs("資料庫裡出現了程式碼不認得的狀態 —— 檢查資料遷移")
            .allMatch(known::contains);
}
```

📌 **這條測試跑在「有真實資料的環境」上才有意義**（例如 staging 的資料快照）。
**在空的測試資料庫上它永遠是綠的。** 06 章會處理「測試資料要多真」這個問題。

---

## 2.10 `KeyHolder`：拿回自動產生的主鍵

shop-service **用不到**它（id 由 `nextId()` 產生），但你一定會在別的專案遇到。

**實驗 G10-B**：

```java
KeyHolder holder = new GeneratedKeyHolder();
jdbc.update(conn -> {
    PreparedStatement ps = conn.prepareStatement(
            "INSERT INTO audit_log (message, at) VALUES (?, CURRENT_TIMESTAMP)",
            new String[]{"id"});          // ★ 一定要指定要拿回哪一欄
    ps.setString(1, "訂單 O-1 已付款");
    return ps;
}, holder);
```

```
=== G10-B GeneratedKeyHolder ===
  holder.getKey()  = 1
  holder.getKeys() = {ID=1}
  沒有指定 new String[]{"id"} → key = null
  ⚠️ 各家驅動行為不同：H2 這裡回傳整列；MySQL 只回 auto_increment 那一欄
```

⚠️ **`new String[]{"id"}` 不能省** —— 省了就拿不到 key（而且**不會報錯**，只是 `null`）。

**實驗 G10-C**：批次插入拿不回 key。

```
=== G10-C 批次插入 + 自動主鍵 ===
  batchUpdate 回傳影響列數：[1, 1, 1]
  ⚠️ batchUpdate 沒有 KeyHolder 的多載 —— 拿不到那三筆的 id
  只能事後再查一次：[{ID=1, MESSAGE=a}, {ID=2, MESSAGE=b}, {ID=3, MESSAGE=c}]
```

> 📌 **這兩個實驗合起來，就是 shop-service 選擇「自己產生 id」的理由**（00 章 0.6.2 ⑯）：
>
> | 自動產生主鍵的代價 | 自己產生 id 之後 |
> |---|---|
> | id 要等 `INSERT` 之後才存在 | ✅ **聚合在交易開始前就是完整的** |
> | 批次寫入拿不回 id（G10-C） | ✅ 你本來就知道每一筆的 id |
> | 「先送事件再寫入」做不到（事件裡沒有 id） | ✅ 可以先送 |
> | 跨資料庫行為不一致 | ✅ 完全由應用程式控制 |
>
> ⚠️ **代價**：`BIGINT` 自增的索引比 `VARCHAR(26)` 小、也比較密集。
> **這個代價是真的**，07-mysql 站 03 章會量它。

---

## 2.11 原子 UPDATE 與熱點列

00 章 0.8.3 用實測證明了「原子 UPDATE」是擋住超賣的正解。這一節把它寫成程式碼。

### 2.11.1 `JdbcStockPort`

```java
package example.shop.stock.infrastructure.persistence;

import example.shop.stock.application.port.StockPort;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

@Repository
@Transactional(propagation = Propagation.MANDATORY)
public class JdbcStockPort implements StockPort {

    /**
     * ★ 條件寫在 WHERE 裡，讓資料庫在「同一個原子操作」中同時檢查與扣減。
     *
     * <p>對照 00 章 0.8.1 那個先讀出來、在 Java 裡 if、再寫回去的版本 ——
     * 那個版本在 20 併發下超賣了。
     */
    private static final String RESERVE = """
            UPDATE stock
               SET qty = qty - :qty
             WHERE product_id = :productId
               AND qty >= :qty
            """;

    private final NamedParameterJdbcTemplate jdbc;

    public JdbcStockPort(NamedParameterJdbcTemplate jdbc) { this.jdbc = jdbc; }

    /**
     * 嘗試預留庫存。
     *
     * @return {@code true} 代表這次預留成功。
     *         ⚠️ {@code false} 只代表「這次沒有預留成功」，
     *         <b>不保證</b>原因是庫存不足 —— 商品不存在也會回 {@code false}（見 2.11.2）。
     */
    @Override
    public boolean tryReserve(String productId, int qty) {
        if (qty <= 0) throw new IllegalArgumentException("預留數量必須大於 0：" + qty);
        int updated = jdbc.update(RESERVE, new MapSqlParameterSource()
                .addValue("productId", productId)
                .addValue("qty", qty));
        return updated == 1;
    }
}
```

**實驗 G11-A**：庫存 10，20 個執行緒同時搶。

```
=== G11-A 庫存 10，20 個人同時搶（原子 UPDATE） ===
  搶到：10 人，被擋：10 人
  剩餘庫存：0
  ★ 對照 00 章 0.8.1（應用層 if）與 0.8.2（只加 CHECK）——那兩種都超賣了
```

✅ **10 個成功、10 個被擋、庫存剛好歸零。** 這是 00 章那三組實驗裡**唯一正確**的一組。

### 2.11.2 ⚠️「更新了 0 列」有兩個原因

**實驗 G11-B**：

```
=== G11-B「更新了 0 列」有兩種可能的原因 ===
  庫存不足     → update() 回 0
  商品不存在   → update() 回 0 ← ⚠️ 兩者都是 0，分不出來
  要分辨就要多一次查詢：商品存在嗎 = false
```

> 📌 **這就是為什麼 `tryReserve` 的 javadoc 必須寫清楚回傳語意**（00 章 0.14.6）：
>
> **`false` = 「這次沒有預留成功」，而不是「庫存不足」。**
>
> ⚠️ **如果呼叫端把 `false` 直接翻譯成「庫存不足，請選其他商品」**，
> 那麼一個**打錯的商品編號**會顯示成「缺貨」——
> 使用者會等它補貨，而它永遠不會補。

**要分辨就要多一次查詢，而且只在失敗路徑上做**：

```java
if (!stockPort.tryReserve(productId, qty)) {
    // ★ 只有在失敗時才多付這一次查詢的成本
    if (!stockPort.exists(productId)) throw new ProductNotFoundException(productId);
    throw new InsufficientStockException(productId, qty);
}
```

### 2.11.3 熱點列與分片計數

00 章練習 4 的加分題問：「活動名額 10,000，5,000 人併發報名，原子 UPDATE 會不會變成瓶頸？」

**實驗 G11-C** 比較「所有人搶同一列」與「分成 16 片」：

```
=== G11-C 熱點列：32 執行緒 × 100 次報名 ===
  單一列（所有人搶同一列）：122 ms，taken = 3,200
  分成 16 片            ：108 ms，taken = 3,200
  倍數：1.13 倍
```

⚠️⚠️ **這個實驗【沒有】重現它想證明的問題，而這件事本身要說清楚**：

> **只快了 1.13 倍 —— 幾乎沒有差別。**
>
> **原因是 H2 in-memory 的鎖成本與 InnoDB 完全不同**：
> H2 這裡是行程內的記憶體操作，沒有磁碟、沒有 redo log、沒有網路來回，
> **所以「等鎖」的時間本來就短到量不出來。**
>
> 🔴 **【本章未驗證】熱點列在真實資料庫上的吞吐上限** —— **07-mysql 站 04 章會實測。**
>
> 📌 **老實說出「實驗沒有重現問題」比硬掰一個結論重要**：
> 如果我在這裡寫「分片快了 N 倍」，你會拿著一個 H2 的數字去說服你的團隊改架構，
> **而那個數字對 InnoDB 沒有任何預測力。**

**分片計數的寫法**（結構是對的，效益要在真資料庫上驗證）：

```java
private static final int SHARDS = 16;

/** 隨機挑一片來扣。分片是為了讓併發打散到不同的列上。 */
public boolean tryTakeSeat(String eventId) {
    int start = ThreadLocalRandom.current().nextInt(SHARDS);
    for (int i = 0; i < SHARDS; i++) {
        int shard = (start + i) % SHARDS;      // ★ 這一片滿了就換下一片
        int updated = jdbc.update("""
                UPDATE event_shard SET taken = taken + 1
                 WHERE id = :id AND shard = :shard AND taken < quota
                """, new MapSqlParameterSource()
                        .addValue("id", eventId).addValue("shard", shard));
        if (updated == 1) return true;
    }
    return false;                              // 每一片都滿了
}

/** ⚠️ 代價①：「還剩幾個名額」不再是一次查詢，而是一次聚合。 */
public int remaining(String eventId) {
    Integer n = jdbc.queryForObject(
            "SELECT SUM(quota - taken) FROM event_shard WHERE id = :id",
            new MapSqlParameterSource("id", eventId), Integer.class);
    return n == null ? 0 : n;
}
```

**分片的三個代價**：

| 代價 | 說明 |
|---|---|
| **「還剩幾個」要 SUM** | 從「讀一列」變成「讀 16 列再加總」——**而這個查詢通常很熱門**（頁面一直在顯示它） |
| **要重試別片** | 某一片滿了但別片還有 → 上面那個 `for` 迴圈。**最壞情況要試 16 次** |
| **名額不好平均分** | 10,000 / 16 = 625，餘數要處理；**而且熱門時段各片消耗速度不一樣** |

> 📌 **判準：不要預先分片。**
> 先用單列原子 UPDATE，**量到它真的是瓶頸**再分。
> 練習 4 提到的另外兩種做法（**預先發號**、**佇列化**）在很多情況下比分片更適合。

---

## 2.12 ★★ 例外翻譯：從約束違反到使用者看得懂的話

### 2.12.1 問題：五種業務錯誤，一個例外型別

**實驗 G8-A** 把 shop-service 的 `schema.sql` 上所有可能的違反跑一遍：

```
=== G8-A 約束違反 → Spring 例外型別 ===
  預設的 translator：org.springframework.jdbc.support.SQLExceptionSubclassTranslator
  主鍵重複         → DuplicateKeyException                  SQLState=23505 vendorCode=23505
  CHECK：金額為負  → DataIntegrityViolationException        SQLState=23513 vendorCode=23513
  CHECK：幣別不對  → DataIntegrityViolationException        SQLState=23513 vendorCode=23513
  外鍵：孤兒明細   → DataIntegrityViolationException        SQLState=23506 vendorCode=23506
  NOT NULL        → DataIntegrityViolationException        SQLState=23502 vendorCode=23502
  欄位太長         → DataIntegrityViolationException        SQLState=22001 vendorCode=22001
  語法錯誤         → BadSqlGrammarException                 SQLState=42S22 vendorCode=42122
```

🔴 **五種完全不同的業務問題，全部變成同一個 `DataIntegrityViolationException`**：

| 資料庫層面的事 | 使用者應該看到的話 |
|---|---|
| `ck_orders_total` 違反 | 「訂單金額不可以是負數」 |
| `ck_orders_currency` 違反 | 「我們目前只支援台幣、日圓與美金」 |
| `fk_order_line_order` 違反 | 🔴 **這是 bug，使用者不該看到任何東西** |
| `NOT NULL` 違反 | 🔴 **也是 bug** |
| 欄位太長 | 「商品名稱最多 20 個字」 |

⚠️ **注意這張表裡有兩列是「使用者不該看到」的** ——
**把所有 `DataIntegrityViolationException` 都翻譯成友善訊息是錯的**，
那會把 bug 偽裝成正常的業務規則。

### 2.12.2 Spring 的例外階層與 Boot 3 的預設值

**實驗 G8-E** 印出繼承鏈：

```
=== G8-E 例外階層 ===
  繼承鏈：DuplicateKeyException → DataIntegrityViolationException → NonTransientDataAccessException
          → DataAccessException → NestedRuntimeException → RuntimeException → Exception → Throwable
  是 RuntimeException 嗎：true
  cause 的型別：org.h2.jdbc.JdbcSQLIntegrityConstraintViolationException
```

**兩個重點**：

1. **`DataAccessException` 是 unchecked 的** —— 所以 Service 層不用 `throws`，
   也就不會為了「編譯過」而寫出 `catch (SQLException e) { return null; }`（00 章 0.11.5）。
2. **原始的 `SQLException` 還在 `cause` 裡** —— 需要細節時拿得到，
   但**它不在方法簽章上**，所以不算洩漏（00 章 0.5.2 的判準）。

**Boot 3 換了預設的 translator**（實驗 G8-A 第一行）：

| Spring 版本 | 預設 translator | 判斷依據 |
|---|---|---|
| Spring 5 / Boot 2 | `SQLErrorCodeSQLExceptionTranslator` | **各家資料庫的 vendor error code**（靠一份 `sql-error-codes.xml`） |
| **Spring 6.1 / Boot 3** | **`SQLExceptionSubclassTranslator`** | **JDBC 4 的 `SQLException` 子類別**（`SQLIntegrityConstraintViolationException` 等），對不到時退回 `SQLState` |

**實驗 G8-B** 讓三個 translator 判斷同一批例外：

```
=== G8-B 三種 SQLExceptionTranslator 對同一批例外的判斷 ===
  主鍵重複         DuplicateKeyException      DuplicateKeyException      DuplicateKeyException
  CHECK：金額為負  DataIntegrityViolation…    DataIntegrityViolation…    DataIntegrityViolation…
  外鍵：孤兒明細   DataIntegrityViolation…    DataIntegrityViolation…    DataIntegrityViolation…
  語法錯誤         BadSqlGrammarException     BadSqlGrammarException     BadSqlGrammarException
  欄位順序：SQLExceptionSubclassTranslator | SQLStateSQLExceptionTranslator | SQLErrorCodeSQLExceptionTranslator
```

**三個在 H2 上的判斷完全一致** ——
⚠️ **這不代表它們等價**，只代表 H2 的 `SQLState` 與例外子類別都很規矩。
🔴 **【本章未驗證】三者在 MySQL / Oracle 上的差異**（那才是它們分家的地方）。

### 2.12.3 ⚠️ 約束的名字沒有你以為的那麼可靠

00 章 0.12.3 的 `schema.sql` **每一條約束都取了名字**，理由就是「要靠名字翻譯例外」。
**這個策略成立嗎？實驗 G9-A 檢查了它。**

```sql
CREATE TABLE customer (
    id    VARCHAR(26) NOT NULL,
    email VARCHAR(100) NOT NULL,
    CONSTRAINT pk_customer PRIMARY KEY (id),
    CONSTRAINT uq_customer_email UNIQUE (email)
);
```

```
=== G9-A DDL 命名 vs 例外訊息裡的名字（H2 2.2.224） ===
  主鍵     DDL 取名「pk_customer」→ 訊息裡🔴 找不到！
        訊息：Unique index or primary key violation: "PUBLIC.PRIMARY_KEY_5 ON PUBLIC.CUSTOMER(ID) …"
  唯一鍵   DDL 取名「uq_customer_email」→ 訊息裡✅ 找得到
        訊息：Unique index or primary key violation: "PUBLIC.UQ_CUSTOMER_EMAIL_INDEX_5 ON PUBLIC.CUSTOMER(EMAIL …)"
  information_schema 裡的約束：[{CONSTRAINT_NAME=PK_CUSTOMER, …}, {CONSTRAINT_NAME=UQ_CUSTOMER_EMAIL, …}]
```

🔴 **三個發現，一個比一個麻煩**：

| 發現 | 影響 |
|---|---|
| **具名主鍵的名字在例外訊息裡不見了**（變成 `PRIMARY_KEY_5`） | 「靠名字翻譯」對**主鍵**直接失效 |
| **唯一鍵的名字在，但後面被加了 `_INDEX_5`** | 比對只能用「**開頭符合**」，不能用相等 |
| `information_schema` 裡兩個名字**都是對的** | **名字有存下來，只是例外訊息沒用它** |

⚠️ **而這只是 H2 一家的行為。** MySQL 的訊息格式是
`Duplicate entry 'x' for key 'customer.uq_customer_email'`，
PostgreSQL 是 `violates unique constraint "uq_customer_email"` ——
**三家三種格式。** 🔴 **【本章未驗證】後兩家**。

### 2.12.4 做法一：自訂 `SQLExceptionTranslator`（可行，但脆弱）

```java
package example.shop.common.persistence;

import org.springframework.dao.DataAccessException;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.support.SQLExceptionSubclassTranslator;
import org.springframework.jdbc.support.SQLExceptionTranslator;

import java.sql.SQLException;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** 把「約束名」翻譯成業務例外：SQLState 決定哪一類，約束名決定哪一條規則。 */
public class ConstraintNameTranslator implements SQLExceptionTranslator {

    private static final SQLExceptionTranslator DELEGATE = new SQLExceptionSubclassTranslator();

    /** 三家資料庫的訊息格式不同 —— 用一組樣式涵蓋。 */
    private static final List<Pattern> NAME_PATTERNS = List.of(
            // H2 CHECK：Check constraint violation: "CK_ORDERS_TOTAL: "
            Pattern.compile("constraint violation: \"([A-Z_0-9]+)", Pattern.CASE_INSENSITIVE),
            // H2 唯一鍵：… violation: "PUBLIC.UQ_CUSTOMER_EMAIL_INDEX_5 ON …"
            Pattern.compile("violation: \"(?:PUBLIC\\.)?([A-Z_0-9]+) ON ", Pattern.CASE_INSENSITIVE),
            // PostgreSQL：… violates unique constraint "uq_customer_email"
            Pattern.compile("constraint \"([^\"]+)\""),
            // MySQL：Duplicate entry 'x' for key 'customer.uq_customer_email'
            Pattern.compile("for key '([^']+)'"));

    public record BusinessRule(String code, String message) {}

    private final Map<String, BusinessRule> rules;

    public ConstraintNameTranslator(Map<String, BusinessRule> rules) { this.rules = rules; }

    public static Optional<String> constraintNameOf(SQLException e) {
        String msg = e.getMessage() == null ? "" : e.getMessage();
        for (Pattern p : NAME_PATTERNS) {
            Matcher m = p.matcher(msg);
            if (m.find()) {
                String raw = m.group(1).trim().toUpperCase();
                int dot = raw.lastIndexOf('.');           // MySQL 會帶 schema/table 前綴
                return Optional.of(dot >= 0 ? raw.substring(dot + 1) : raw);
            }
        }
        return Optional.empty();
    }

    /** ⚠️ H2 會在索引名後面加 _INDEX_n，所以只能用「開頭符合」。 */
    private Optional<BusinessRule> ruleFor(String constraintName) {
        return rules.entrySet().stream()
                .filter(en -> constraintName.startsWith(en.getKey()))
                .map(Map.Entry::getValue).findFirst();
    }

    @Override
    public DataAccessException translate(String task, String sql, SQLException ex) {
        DataAccessException base = DELEGATE.translate(task, sql, ex);
        if (base instanceof DataIntegrityViolationException) {
            Optional<BusinessRule> rule = constraintNameOf(ex).flatMap(this::ruleFor);
            if (rule.isPresent()) {
                return new DataIntegrityViolationException(rule.get().message(), ex);
            }
        }
        return base;   // ★ 沒有登記的原樣往上拋
    }
}
```

**掛上去**：

```java
JdbcTemplate jdbc = new JdbcTemplate(dataSource);
jdbc.setExceptionTranslator(new ConstraintNameTranslator(Map.of(
        "UQ_CUSTOMER_EMAIL",  new BusinessRule("EMAIL_TAKEN",  "這個 email 已經被註冊了"),
        "CK_ORDERS_CURRENCY", new BusinessRule("BAD_CURRENCY", "不支援的幣別"))));
```

**實驗 G9-B**：

```
=== G9-B 自訂 translator ===
  email 重複 → DataIntegrityViolationException：「這個 email 已經被註冊了」
    cause 的 code：EMAIL_TAKEN
  主鍵重複（沒有登記規則）→ DuplicateKeyException：StatementCallback…
  ★ 沒有登記的約束原樣往上拋 —— 不要把「未知」翻譯成「已知」

=== G9-B2 從訊息裡抽出來的約束名長什麼樣 ===
  VALUES ('C-2','a@example.com') → 抽出「UQ_CUSTOMER_EMAIL_INDEX_5」
  VALUES ('C-1','z@example.com') → 抽出「PRIMARY_KEY_5」
```

✅ **它能動。** 但請注意它建立在**四個正規表示式**上，而那四個樣式：

- 是**三家資料庫訊息格式**的逆向工程；
- 會**隨著資料庫版本改變**（訊息不是 API，沒有相容性承諾）；
- **「開頭符合」的比對規則**意味著 `CK_ORDERS_TOTAL` 與 `CK_ORDERS_TOTAL_V2` 會撞在一起。

### 2.12.5 ✅ 做法二：在呼叫點翻譯（shop-service 選這個）

**換一個角度想**：全域的 translator 之所以要解析訊息，
是因為它站在一個**什麼都不知道**的位置 —— 它不知道剛剛執行的是哪一句 SQL、要達成什麼。

**而寫下那句 `INSERT` 的地方【知道】。**

```java
/**
 * ★ 這一句 INSERT 只可能違反兩條約束：
 *    - pk_customer：id 是我方產生的，撞了代表 id 產生器有 bug
 *    - uq_customer_email：email 重複，這是正常的業務情況
 * 所以「DuplicateKeyException 且 id 沒被佔用」→ 一定是 email 撞了。
 */
public void register(String id, String email) {
    try {
        jdbc.update("INSERT INTO customer (id, email) VALUES (:id, :email)",
                new MapSqlParameterSource().addValue("id", id).addValue("email", email));
    } catch (DuplicateKeyException e) {
        // ⚠️ 只在【錯誤路徑】上多一次查詢 —— 正常路徑零成本
        Long idTaken = jdbc.queryForObject("SELECT COUNT(*) FROM customer WHERE id = :id",
                new MapSqlParameterSource("id", id), Long.class);
        if (idTaken != null && idTaken > 0) {
            throw new IllegalStateException("id 產生器產生了重複的 id：" + id, e);   // 這是 bug
        }
        throw new EmailAlreadyRegisteredException(email, e);                        // 這是業務情況
    }
}
```

**實驗 G9-D**：

```
=== G9-D 在呼叫點翻譯 ===
  攔在呼叫點：id 沒撞 → 一定是 email 撞了 → 「這個 email 已經被註冊了」
  ★ 代價：多一次查詢，而且只在【錯誤路徑】上發生（正常路徑零成本）
  ★ 好處：不依賴任何資料庫的訊息格式，換 MySQL 不用改
```

**三種做法的比較**：

| 做法 | 可攜性 | 成本 | 什麼時候用 |
|---|---|---|---|
| 🔴 **比對例外訊息字串** | **最差**（版本一升就壞） | 零 | **不要用** |
| **自訂 translator（比對約束名）** | 中（每家一組樣式） | 零 | 約束很多、而且散落在很多地方時 |
| ✅ **在呼叫點翻譯** | **最好**（不依賴訊息） | **只在錯誤路徑多一次查詢** | **shop-service 的預設做法** |

> 📌 **判準**：
> **「這句 SQL 可能違反幾條約束？」**
>
> - **一條** → 直接翻譯，連查詢都不用（`catch (DuplicateKeyException e) → 那條規則`）。
> - **兩三條** → 在呼叫點加一次判別查詢（上面的例子）。
> - **很多條、而且到處都在寫** → 才值得寫 translator。
>
> ⚠️ **而如果你發現「一句 INSERT 可能違反七條約束」**，
> 真正的問題可能是**這張表塞了太多責任**，不是例外翻譯不好寫。

### 2.12.6 應用層檢查與資料庫約束，兩個都要

一個常見的爭論：「都有唯一鍵了，還需要先查一次 email 有沒有人用嗎？」

**實驗 G9-C**：6 個執行緒同時註冊同一個 email，中間隔 20 ms。

```
=== G9-C 「先查 email 有沒有人用」擋得住嗎 ===
  6 個執行緒同時註冊同一個 email：
    應用層檢查擋掉：0 個
    唯一鍵擋掉    ：5 個 ← ★ 應用層漏掉的，資料庫接住了
    成功          ：1 個
  資料庫裡最後有 1 筆 → ✅ 不變量沒有被破壞
```

> 📌 **兩者的分工完全不同，所以不能互相取代**：
>
> | | 應用層的 `existsByEmail` | 資料庫的 `UNIQUE` |
> |---|---|---|
> | 目的 | **友善訊息**（在表單上標紅、不用送出就知道） | **正確性** |
> | 併發下 | 🔴 **完全擋不住**（本次實測 0 個） | ✅ 擋住 5 個 |
> | 少了它 | 使用者要送出才知道錯 | 🔴 **資料真的會重複** |
>
> **這正是 00 章 0.8.4 那條結論在應用層的樣子：
> 應用層負責「體驗」，資料庫負責「不變量」。**

### 2.12.7 ★ 一條守門測試：訊息格式變了要當場知道

2.12.4 的 translator 建立在**四個正規表示式**上，
而它們比對的是**資料庫的錯誤訊息** —— 一個**沒有相容性承諾**的東西。

> 📌 **00 章 0.8.6 承諾過這條測試**：
> 「這個字串比對如果失效，測試會紅」。

```java
package example.shop.common.persistence;

import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;

import java.sql.SQLException;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class ConstraintNameGuardTest {

    private record Case(String label, String sql, String expectedPrefix) {}

    /**
     * ★ 每一條「我們依賴它的名字」的約束，都要有一列在這裡。
     *
     * <p>資料庫升級之後訊息格式若改變，這條測試會【當場變紅】——
     * 而不是等到某個使用者看到英文的原始錯誤訊息。
     */
    private static final List<Case> CASES = List.of(
            new Case("CHECK：金額為負",
                    "INSERT INTO orders VALUES ('O-2','C-2','PAID',-1,'TWD',CURRENT_TIMESTAMP,0)",
                    "CK_ORDERS_TOTAL"),
            new Case("CHECK：幣別不對",
                    "INSERT INTO orders VALUES ('O-3','C-2','PAID',1,'EUR',CURRENT_TIMESTAMP,0)",
                    "CK_ORDERS_CURRENCY"),
            new Case("外鍵：孤兒明細",
                    "INSERT INTO order_line VALUES ('NO-SUCH',1,'P-1',1,100,'TWD')",
                    "FK_ORDER_LINE_ORDER"),
            new Case("CHECK：明細數量",
                    "INSERT INTO order_line VALUES ('O-1',1,'P-1',0,100,'TWD')",
                    "CK_ORDER_LINE_QTY"));

    @Test
    void 每一條我們依賴的約束名都還抽得出來() {
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        for (Case c : CASES) {
            SQLException sqlEx = null;
            try {
                jdbc.update(c.sql());
            } catch (DataAccessException e) {
                if (e.getMostSpecificCause() instanceof SQLException se) sqlEx = se;
            }
            assertThat((Object) sqlEx).describedAs("%s 應該要違反約束", c.label()).isNotNull();

            String extracted = ConstraintNameTranslator.constraintNameOf(sqlEx).orElse("（抽不出來）");
            assertThat(extracted)
                    .describedAs("""
                            約束名抽不出來了 —— 資料庫的錯誤訊息格式可能變了。
                            這代表 2.12.4 的 translator 已經失效，
                            使用者會看到原始的資料庫訊息而不是業務訊息。
                            請檢查 NAME_PATTERNS。實際訊息：%s""", sqlEx.getMessage())
                    .startsWith(c.expectedPrefix());
        }
    }

    /** ⚠️ 順帶釘住 2.12.3 的發現：具名主鍵的名字【抽不到】。 */
    @Test
    void 具名主鍵的名字在h2上抽不到() {
        // …略：對 orders 插入重複主鍵…
        assertThat(extracted)
                .describedAs("如果哪天 H2 開始回報 PK_ORDERS，這條會紅 —— 那是【好消息】，"
                        + "代表可以把主鍵也納入 translator")
                .doesNotStartWith("PK_ORDERS");
    }
}
```

**本章實測（實驗 R1）**：

```
=== R1 約束名擷取的守門測試 ===
  CHECK：金額為負       → 抽出「CK_ORDERS_TOTAL」 ✅
  CHECK：幣別不對       → 抽出「CK_ORDERS_CURRENCY」 ✅
  外鍵：孤兒明細         → 抽出「FK_ORDER_LINE_ORDER」 ✅
  CHECK：明細數量        → 抽出「CK_ORDER_LINE_QTY」 ✅

=== R1-B 具名主鍵 pk_orders ===
  DDL 取名 pk_orders → 抽出「PRIMARY_KEY_8」
  ⚠️ 釘住這個【已知的限制】：主鍵不能靠名字翻譯（2.12.3）
```

**它真的會紅嗎？** 把第一個樣式改壞（`constraint violation` → `XXconstraint violation`）：

```
[ERROR] ConstraintNameGuardTest.每一條我們依賴的約束名都還抽得出來:96
        [約束名抽不出來了 —— 資料庫的錯誤訊息格式可能變了。…]
```

✅ **會紅，而且訊息直接說出「translator 失效了」與實際的資料庫訊息。**

> 📌 **第二條測試（`doesNotStartWith("PK_ORDERS")`）是一個少見但有用的寫法**：
> **它釘住的是一個「已知的限制」，而不是一個「正確的行為」。**
> 哪天 H2 改成回報 `PK_ORDERS`，這條會紅 ——
> **而那次紅燈是在通知你「可以把主鍵也納入 translator 了」。**

### 2.12.8 三條 ArchUnit 規則

00 章 0.11.10 的表格裡，⑧ 與 ⑨ 兩列標的是「02 章補上這條規則」。**在這裡補上**：

```java
package example.shop.architecture;

import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.core.importer.ImportOption;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;

class PersistenceArchitectureTest {

    static JavaClasses classes;

    @BeforeAll
    static void importClasses() {
        classes = new ClassFileImporter()
                .withImportOption(ImportOption.Predefined.DO_NOT_INCLUDE_TESTS)
                .importPackages("example.shop");
    }

    /** 00 章 0.11.3：只有資料存取套件可以碰 JDBC。 */
    @Test
    void 規則A_只有資料存取套件可以碰jdbc() {
        noClasses().that().resideOutsideOfPackages(
                        "..infrastructure.persistence..", "..infrastructure.jpa..")
                .should().dependOnClassesThat().resideInAnyPackage(
                        "java.sql..", "javax.sql..", "org.springframework.jdbc..")
                .because("資料存取細節不可以外流（00 章 0.11.3）")
                .check(classes);
    }

    /** ★ 00 章 0.11.10 的 ⑧：資料層不該認識權限規則。 */
    @Test
    void 規則B_資料存取層不可認識權限規則() {
        noClasses().that().resideInAnyPackage(
                        "..infrastructure.persistence..", "..infrastructure.jpa..")
                .should().dependOnClassesThat().resideInAnyPackage(
                        "..security..", "org.springframework.security..")
                .because("""
                        資料層可以認識「可見範圍」（customer_id = ?），\
                        但不可以認識「權限規則」（這個角色能不能看）——00 章 0.11.8。\
                        授權決策屬於 application 層，資料層只收一個已經算好的 Actor。""")
                .check(classes);
    }

    /** ★ 00 章 0.11.10 的 ⑨：資料層不該處理「顯示」。 */
    @Test
    void 規則C_資料存取層不可處理顯示() {
        noClasses().that().resideInAnyPackage(
                        "..infrastructure.persistence..", "..infrastructure.jpa..")
                .should().dependOnClassesThat().resideInAnyPackage(
                        "java.text..", "..i18n..", "java.time.format..")
                .because("""
                        格式化、在地化、時區呈現都是「顯示」的事（00 章 0.11.9）。\
                        資料層只負責把值原樣搬進搬出 —— 一旦它開始格式化，\
                        同一筆資料在報表與 API 上就會長得不一樣。""")
                .check(classes);
    }
}
```

⚠️ **注意規則 A 的套件清單有【兩個】** —— `persistence` 與 `jpa`。
03 章會加上 Spring Data 的實作，那時候 `..infrastructure.jpa..` 也要能碰 JDBC 家族的型別。

**實驗 R2：三條都會紅嗎？** 放一個在資料層做格式化的 class 進去：

```java
package example.shop.order.infrastructure.persistence.bad;

import java.text.NumberFormat;
import java.util.Locale;

public class BadRepo {
    public String formatted(long minor) {
        return NumberFormat.getCurrencyInstance(Locale.TAIWAN).format(minor / 100.0);
    }
}
```

```
[ERROR] PersistenceArchitectureTest.規則C_資料存取層不可處理顯示:62
        Architecture Violation … ['java.text..', '..i18n..', 'java.time.format..'] … was violated (2 times)
```

✅ **會紅**（一個檔案觸發兩處違規：`NumberFormat` 與 `Locale` 的使用點），移除後三條回綠。

> 📌 **規則 C 看起來很挑剔，但它防的是一種真的會發生的事**：
> 有人為了「報表少寫一點程式碼」，在 `RowMapper` 裡把金額格式化成 `"NT$380"` 字串。
> **然後 API 回傳的是字串、報表加總不了、換語系要改資料層。**
>
> ⚠️ **而 `java.time.format..` 被放進清單，是因為它最容易被當成例外** ——
> 「我只是把 `Timestamp` 轉成 `yyyy-MM-dd`」正是同一個錯誤的開始（00 章 0.11.9）。

### 2.12.9 不該做的三件事

| 🔴 不該做 | 為什麼 |
|---|---|
| `catch (DataAccessException e) { return Optional.empty(); }` | 把「資料庫掛了」變成「查無資料」——00 章 0.11.5 |
| 把**所有** `DataIntegrityViolationException` 翻成友善訊息 | 外鍵違反與 `NOT NULL` 違反是 **bug**，翻成友善訊息會讓它們永遠不被修 |
| 在 Repository 裡 `catch` 之後**只記 log 不重拋** | 交易不會回滾（Spring 看不到例外），資料寫一半 |

---

## 2.13 批次操作入門

**完整的批次策略在 05 章 5.8**，這裡只建立三個基本認知。

### 2.13.1 逐筆 vs 批次

**實驗 G12-A**：寫入 20,000 筆。

```
=== G12-A 寫入 20,000 筆 ===
  逐筆 update()          ：349 ms
  batchUpdate()          ：174 ms（2.0 倍）
  batchUpdate() 分 500 一批：115 ms
  ⚠️ H2 是 in-process 的 —— 批次省下的是【網路來回】，這裡幾乎沒有網路
  ⚠️ MySQL 還需要 URL 加 rewriteBatchedStatements=true 才會真的合併成一句
```

⚠️ **這個 2 倍是「地板值」，不是「代表值」**：

> **批次省下的主要成本是「網路來回」**，而 H2 是 in-process 的 —— 沒有網路。
> 在真實資料庫上，一次來回是 **0.5～2 ms**，20,000 筆逐筆送就是 **10～40 秒**。
>
> 🔴 **【本章未驗證】真實資料庫的批次效益**，以及 MySQL 的 `rewriteBatchedStatements=true`
> （沒加的話，驅動仍然一句一句送，**批次幾乎沒有效果**）——
> **05 章 5.8 與 06 章 6.4 會實測**（🔴 06 章探針 ⑰ 發現 `rewriteBatchedStatements=true`
> 會讓 `executeBatch()` 回傳 `SUCCESS_NO_INFO`，反過來弄壞 05 章 5.8.7 的判斷邏輯）。

### 2.13.2 ⚠️ 批次不等於交易

**實驗 G12-B**：三筆資料，中間那筆違反 `CHECK`。

```
=== G12-B 批次裡有一筆壞掉（沒有交易） ===
  拋出：DataIntegrityViolationException
  資料庫裡剩下：[X-1, X-3]
  🔴 壞掉的 X-2 沒進去，但 X-1【和 X-3】都進去了
     → 驅動在遇到壞的那一筆之後，【繼續執行】了後面的語句
  ⚠️ JDBC 規格允許兩種行為（停下來、或跳過繼續），各家驅動不一樣
  🔴 不論哪一種，結果都是「部分寫入」—— 批次【不等於】交易
```

> 📌 **兩個獨立的教訓**：
>
> 1. **「批次」只是「少幾次來回」，它不提供任何原子性。**
>    要全成功或全失敗，靠的是**外層的 `@Transactional`**（00 章 0.9）。
> 2. ⚠️ **失敗之後「哪些進去了」是驅動相依的** ——
>    有的停在第一個錯誤，有的跳過繼續。**所以不要試圖從 `int[]` 推論資料庫的狀態**，
>    **正確的反應是回滾，然後重來。**

### 2.13.3 具名參數的批次

**實驗 G12-C**：

```java
record NewOrder(String id, String customerId, String status, long totalMinor, String currency) {}

List<NewOrder> orders = List.of(
        new NewOrder("N-1", "C-1", "PAID", 100, "TWD"),
        new NewOrder("N-2", "C-2", "PAID", 200, "TWD"));

// ★ record 的存取子名稱直接對到 :具名參數
SqlParameterSource[] batch = SqlParameterSourceUtils.createBatch(orders.toArray());
int[] r = jdbc.batchUpdate("""
        INSERT INTO orders (id, customer_id, status, total_minor, currency, created_at, version)
        VALUES (:id, :customerId, :status, :totalMinor, :currency, CURRENT_TIMESTAMP, 0)
        """, batch);
```

```
=== G12-C 具名參數的 batchUpdate ===
  SqlParameterSourceUtils.createBatch(record 陣列) → 影響列數 [1, 1]
  手寫 MapSqlParameterSource → [1, 1]
```

📌 **`SqlParameterSourceUtils.createBatch()` 是這裡少數「自動對應」值得用的地方** ——
因為批次的參數列很長，手寫 `MapSqlParameterSource` 又臭又長，
而**它對不到的時候會拋例外，不會靜默給 `null`**（對照 2.5.4）。

---

## 2.14 `JdbcClient`（Spring Framework 6.1 / Boot 3.2）

### 2.14.1 同一段查詢，三種寫法

**實驗 G13-A**：

```java
record OrderSummary(String id, String customerId, long totalMinor) {}

// ① JdbcTemplate（位置參數 + 手寫 RowMapper）
List<OrderSummary> a = plain.query(
        "SELECT id, customer_id, total_minor FROM orders WHERE customer_id = ? ORDER BY id",
        (rs, n) -> new OrderSummary(rs.getString("id"), rs.getString("customer_id"),
                rs.getLong("total_minor")), "C-1");

// ② NamedParameterJdbcTemplate
List<OrderSummary> b = named.query(
        "SELECT id, customer_id, total_minor FROM orders WHERE customer_id = :cid ORDER BY id",
        new MapSqlParameterSource("cid", "C-1"),
        (rs, n) -> new OrderSummary(rs.getString("id"), rs.getString("customer_id"),
                rs.getLong("total_minor")));

// ③ JdbcClient
List<OrderSummary> c = client
        .sql("SELECT id, customer_id, total_minor FROM orders WHERE customer_id = :cid ORDER BY id")
        .param("cid", "C-1")
        .query(OrderSummary.class)
        .list();
```

```
=== G13-A 同一個查詢，三種 API ===
  三者回傳完全相同的結果
  ★ JdbcClient 的 query(Class) 內建用 DataClassRowMapper —— record 直接對應
```

**`JdbcClient` 少了什麼**：SQL、參數、結果型別**依序**寫下來，
而且 `query(OrderSummary.class)` 省掉了手寫 `RowMapper`。

### 2.14.2 ⚠️ `single()` 與 `optional()`

**實驗 G13-B**：

```
=== G13-B 查不到一筆時：single() / optional() ===
  single()   → EmptyResultDataAccessException
  optional() → Optional.empty ← ✅ 這就是 findById 要的形狀
  optional() 但有 2 筆 → IncorrectResultSizeDataAccessException ← ⚠️ 仍然會拋，optional 只處理「0 筆」
```

| 方法 | 0 筆 | 1 筆 | 2 筆以上 |
|---|---|---|---|
| `.single()` | 🔴 拋例外 | 回傳 | 拋例外 |
| **`.optional()`** | ✅ **`Optional.empty()`** | `Optional.of(…)` | ⚠️ **仍然拋例外** |
| `.list()` | 空 `List` | 一個元素 | 全部 |

> 📌 **`.optional()` 是 `JdbcClient` 最實際的一個改進** ——
> 它讓 `findById` 不用再寫 `query(...).stream().findFirst()`。
>
> ⚠️ **但它的「2 筆以上仍然拋例外」是刻意的、而且是對的**：
> `Optional` 表達的是「0 或 1」，查到 2 筆代表**你的假設錯了**，那應該爆炸。

### 2.14.3 它是門面，不是新引擎

**實驗 G13-C**：

```java
JdbcTemplate template = new JdbcTemplate(ds);
template.setQueryTimeout(7);
JdbcClient client = JdbcClient.create(template);      // ★ 用既有的 JdbcTemplate 建
```

```
=== G13-C JdbcClient 是門面，不是新引擎 ===
  用既有的 JdbcTemplate 建 JdbcClient → 查詢正常：[O-1, O-2]
  ★ 所以 JdbcTemplate 上的設定（queryTimeout、fetchSize、exceptionTranslator）都還在
  ★ 可以逐步遷移：同一個 Repository 裡兩種寫法並存，共用同一組設定
  JdbcClient 也支援位置參數：[O-1, O-2]
  update() 回傳影響列數：1（單筆是 int，不是 int[]）
```

**要不要換？**

| 情況 | 建議 |
|---|---|
| **新專案 / 新的 Repository** | ✅ **用 `JdbcClient`** —— 更順、`optional()` 好用 |
| 既有的 `NamedParameterJdbcTemplate` 程式碼 | **不用急著換**。它沒有壞，而且 `JdbcClient` 底層就是它 |
| **需要 `ResultSetExtractor` 做 1:N 攤平** | ⚠️ 用 `JdbcTemplate` —— `JdbcClient` 的 API 在這裡沒有優勢 |
| 需要 `batchUpdate` 的完整控制 | ⚠️ 用 `JdbcTemplate` |
| 要在 Boot 3.1 以下執行 | 🔴 沒有 `JdbcClient`（6.1 才有） |

> 📌 **shop-service 的決定：`JdbcOrderRepository` 維持 `NamedParameterJdbcTemplate`。**
>
> **理由不是技術上的優劣，是【對照組】**：
> 03 章要寫 Spring Data 的第二個實作來對照，
> **如果這裡先換成 `JdbcClient`，比較的就變成三件事而不是兩件事。**
>
> ✅ **練習 4 會請你把它改寫成 `JdbcClient` 版本，並跑同一組契約測試。**

---

## 2.15 shop-service 的完整實作

**這是本章的成果**：00 章那個骨架，變成一個通過 **14 條契約測試**的實作。

### 2.15.1 `JdbcOrderRepository`

```java
package example.shop.order.infrastructure.persistence;

import example.shop.common.money.Money;
import example.shop.order.application.port.Actor;
import example.shop.order.application.port.OrderRepository;
import example.shop.order.domain.Order;
import example.shop.order.domain.OrderLine;
import org.springframework.dao.OptimisticLockingFailureException;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.core.namedparam.SqlParameterSource;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * {@link OrderRepository} 的 JDBC 實作（02 章的完成版）。
 *
 * <p>相對於 00 章 0.12.4 的骨架，這一版修掉了三件事：
 * <ul>
 *   <li>2.8：{@code save()} 在 UPDATE 成功的路徑上會維護明細（骨架的靜默 bug）</li>
 *   <li>2.6：{@code IN (:ids)} 的空集合，與 {@code LIMIT} 換成可攜的 {@code FETCH FIRST}</li>
 *   <li>2.9：未知的 status 會拋出說得清楚的訊息（見 {@link OrderRow}）</li>
 * </ul>
 *
 * <p>還沒修的（依 00 章 0.12.4 的表）：
 * ② {@code saveAll()} 仍是 N 次來回（05 章 5.8）、
 * ③ {@code save()} 之後記憶體裡的 version 已過期（05 章 5.5）。
 */
@Repository
@Transactional(propagation = Propagation.MANDATORY)   // ★★ 沒有外層交易就直接失敗（00 章 0.9.3）
public class JdbcOrderRepository implements OrderRepository {

    private static final String SELECT_HEAD = """
            SELECT id, customer_id, status, total_minor, currency, created_at, version
              FROM orders
            """;

    private static final String INSERT_HEAD = """
            INSERT INTO orders (id, customer_id, status, total_minor, currency, created_at, version)
            VALUES (:id, :customerId, :status, :totalMinor, :currency, :createdAt, :version)
            """;

    private static final String UPDATE_HEAD = """
            UPDATE orders
               SET status = :status, total_minor = :totalMinor, currency = :currency,
                   version = version + 1
             WHERE id = :id AND version = :version
            """;

    private static final String INSERT_LINE = """
            INSERT INTO order_line (order_id, line_no, product_id, quantity, unit_price_minor, currency)
            VALUES (:orderId, :lineNo, :productId, :quantity, :unitPriceMinor, :currency)
            """;

    private final NamedParameterJdbcTemplate jdbc;

    public JdbcOrderRepository(NamedParameterJdbcTemplate jdbc) { this.jdbc = jdbc; }

    @Override
    public String nextId() {
        // 不用資料庫的 AUTO_INCREMENT —— 理由見 2.10
        return "O-" + UUID.randomUUID().toString().replace("-", "").substring(0, 20);
    }

    @Override
    public void save(Order order) {
        int updated = jdbc.update(UPDATE_HEAD, headParams(order));
        if (updated == 1) {
            // ★ 2.8.4：明細「全刪重插」—— 骨架漏掉的就是這一段
            jdbc.update("DELETE FROM order_line WHERE order_id = :id",
                    new MapSqlParameterSource("id", order.id()));
            insertLines(order);
            return;
        }
        // 更新了 0 列，有兩種可能：這一列不存在（新單），或 version 對不上（有人改過）
        Long rows = jdbc.queryForObject("SELECT COUNT(*) FROM orders WHERE id = :id",
                new MapSqlParameterSource("id", order.id()), Long.class);
        if (rows != null && rows > 0) {
            throw new OptimisticLockingFailureException(
                    "訂單 " + order.id() + " 已被其他交易修改（本次帶的 version=" + order.version() + "）");
        }
        jdbc.update(INSERT_HEAD, headParams(order));
        insertLines(order);
    }

    @Override
    public void saveAll(Collection<Order> orders) {
        orders.forEach(this::save);   // ⚠️ 05 章 5.8 會換成真的批次
    }

    @Override
    public Optional<Order> findById(String orderId) {
        return load(SELECT_HEAD + " WHERE id = :id",
                new MapSqlParameterSource("id", orderId)).stream().findFirst();
    }

    @Override
    public Optional<Order> findByIdVisibleTo(String orderId, Actor actor) {
        // ★ 授權寫進 WHERE，而不是查出來再 if（00 章 0.11.8）
        String sql = actor.isStaff()
                ? SELECT_HEAD + " WHERE id = :id"
                : SELECT_HEAD + " WHERE id = :id AND customer_id = :customerId";
        return load(sql, new MapSqlParameterSource("id", orderId)
                .addValue("customerId", actor.userId())).stream().findFirst();
    }

    @Override
    public List<Order> findExpiredPendingPayment(Instant now, int limit) {
        // ★ 2.6.4：FETCH FIRST 是標準 SQL，LIMIT 是方言
        //   ⚠️ MySQL 8 不支援 FETCH FIRST —— 換資料庫時這一行要改（04 章的 Pageable 會處理）
        return load(SELECT_HEAD + """
                 WHERE status = 'PENDING_PAYMENT' AND created_at < :deadline
                 ORDER BY created_at, id
                 FETCH FIRST :limit ROWS ONLY
                """,
                new MapSqlParameterSource("deadline", Timestamp.from(now)).addValue("limit", limit));
    }

    @Override
    @Transactional(propagation = Propagation.MANDATORY, readOnly = true)
    public long countByCustomerId(String customerId) {
        Long n = jdbc.queryForObject("SELECT COUNT(*) FROM orders WHERE customer_id = :cid",
                new MapSqlParameterSource("cid", customerId), Long.class);
        return n == null ? 0L : n;   // 2.4.3：COUNT 不會是 null，但把「想過」留在程式碼裡
    }

    // ---------- 內部 ----------

    private void insertLines(Order order) {
        List<SqlParameterSource> lines = new ArrayList<>();
        for (int i = 0; i < order.lines().size(); i++) {
            OrderLine line = order.lines().get(i);
            lines.add(new MapSqlParameterSource()
                    .addValue("orderId", order.id())
                    .addValue("lineNo", i + 1)              // ★ line_no 從 1 開始
                    .addValue("productId", line.productId())
                    .addValue("quantity", line.quantity())
                    .addValue("unitPriceMinor", line.unitPrice().minorUnits())
                    .addValue("currency", line.unitPrice().currency().getCurrencyCode()));
        }
        jdbc.batchUpdate(INSERT_LINE, lines.toArray(SqlParameterSource[]::new));
    }

    /** 兩個 ResultSet 拼成聚合：先查頭，再用一次 IN 撈所有明細（2.5.6 的策略 B）。 */
    private List<Order> load(String headSql, SqlParameterSource params) {
        List<OrderRow> heads = jdbc.query(headSql, params, OrderRow.mapper());
        if (heads.isEmpty()) return List.of();   // ★ 2.6.3：空集合不能送進 IN ()

        Map<String, List<OrderLineRow>> linesByOrder = jdbc.query("""
                        SELECT order_id, product_id, quantity, unit_price_minor, currency
                          FROM order_line
                         WHERE order_id IN (:ids)
                         ORDER BY order_id, line_no
                        """,
                        new MapSqlParameterSource("ids", heads.stream().map(OrderRow::id).toList()),
                        OrderLineRow.mapper())
                .stream().collect(Collectors.groupingBy(OrderLineRow::orderId));

        return heads.stream().map(head -> {
            List<OrderLine> lines = linesByOrder.getOrDefault(head.id(), List.of()).stream()
                    .map(r -> new OrderLine(r.productId(), r.quantity(),
                            Money.ofMinorUnits(r.unitPriceMinor(), r.currency())))
                    .toList();
            return Order.rehydrate(head.id(), head.customerId(), head.status(),
                    lines, head.total(), head.createdAt(), head.version());
        }).toList();
    }

    private SqlParameterSource headParams(Order order) {
        return new MapSqlParameterSource()
                .addValue("id", order.id())
                .addValue("customerId", order.customerId())
                .addValue("status", order.status().name())          // 2.6.6：enum 要 .name()
                .addValue("totalMinor", order.total().minorUnits())
                .addValue("currency", order.total().currency().getCurrencyCode())
                .addValue("createdAt", Timestamp.from(order.createdAt()))
                .addValue("version", order.version());
    }
}
```

**`OrderLineRow`（與 `OrderRow` 同一個檔案，package-private）**：

```java
record OrderLineRow(String orderId, String productId, int quantity,
                    long unitPriceMinor, String currency) {

    static RowMapper<OrderLineRow> mapper() {
        return (ResultSet rs, int rowNum) -> new OrderLineRow(
                rs.getString("order_id"),
                rs.getString("product_id"),
                rs.getInt("quantity"),
                rs.getLong("unit_price_minor"),
                rs.getString("currency"));
    }
}
```

### 2.15.2 契約測試：兩個實作跑同一組測試

00 章 0.10.2 建立了契約測試的骨架（**九條**），00 章練習 3 補了第十條。
**本章再補四條，總共 14 條** —— 完整的清單與來源如下：

| # | 契約 | 來源 |
|---|---|---|
| 1 | 存進去再查回來是同一張訂單 | 00 章 0.10.2 |
| 2 | 查不到回傳空的 `Optional` 而不是 null 也不是例外 | 00 章 0.10.2 |
| 3 | **明細的順序與內容都要一樣** | ★ 本章 |
| 4 | **改了狀態再存回去查出來是新狀態** | ★ 本章 |
| 5 | **每次 `save` 之後 version 會遞增** | ★ 本章 |
| 6 | 拿著過期的 version 存回去會失敗 | 00 章 0.10.2 |
| 7 | 客戶只看得到自己的訂單而客服看得到全部 | 00 章 0.10.2 |
| 8 | 逾期未付款的訂單依照建立時間排序且受 limit 限制 | 00 章 0.10.2 |
| 9 | **已付款的訂單不算逾期未付款** | ★ 本章 |
| 10 | 依客戶計數 | 00 章 0.10.2 |
| 11 | 改了明細再存回去查出來是新的明細 | 00 章練習 3 |
| 12 | **查出來的物件改了但沒 `save` 就不算數** | ★ 本章 |
| 13 | 兩次查詢回傳不同的物件實例 | 00 章 0.10.2 |
| 14 | `nextId` 每次都不同 | 00 章 0.10.2 |

⚠️ **第 13 與第 14 條看起來最不起眼，卻是 03 章的關鍵** ——
**13 會在 ORM 上變成一個真的問題**（JPA 的一級快取讓同一個交易裡兩次查詢回傳**同一個**物件），
**而 14 會抓出一個「class 上的 `@Transactional` 套到了不該套的方法」的 bug**（見下方）。

**本章新增的四條裡，最重要的兩條**：

```java
package example.shop.order;

import example.shop.common.money.Money;
import example.shop.order.application.port.Actor;
import example.shop.order.application.port.OrderRepository;
import example.shop.order.domain.Order;
import example.shop.order.domain.OrderLine;
import example.shop.order.domain.OrderStatus;
import org.junit.jupiter.api.Test;
import org.springframework.dao.OptimisticLockingFailureException;

import java.time.Instant;
import java.util.List;
import java.util.function.Supplier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** ★ 同一組測試跑在 fake 與 JDBC 兩個實作上。 */
abstract class OrderRepositoryContract {

    static final Instant T0 = Instant.parse("2026-03-01T00:00:00Z");

    protected abstract OrderRepository repository();
    protected abstract void tx(Runnable work);
    protected abstract <T> T inTx(Supplier<T> work);

    static Order anOrder(String id, String customerId, Instant createdAt) {
        return Order.place(id, customerId,
                List.of(new OrderLine("P-1", 1, Money.twd(100)),
                        new OrderLine("P-2", 2, Money.twd(140))),
                Money.twd(380), createdAt);
    }

    // …第 1～10、13、14 條省略（來源見上表）…

    /** ★ 00 章練習 3：骨架在這一條上是紅的，02 章的版本要是綠的。 */
    @Test
    void 改了明細再存回去查出來是新的明細() {
        OrderRepository repo = repository();
        tx(() -> repo.save(anOrder("O-1", "C-1", T0)));

        tx(() -> {
            Order o = repo.findById("O-1").orElseThrow();
            o.removeLine("P-2");
            repo.save(o);
        });

        Order got = inTx(() -> repo.findById("O-1")).orElseThrow();
        assertThat(got.lines()).describedAs("刪掉的明細不該還在").hasSize(1);
        assertThat(got.lines().get(0).productId()).isEqualTo("P-1");
    }

    /** ★ 02 章新增：查出來的物件改了但沒 save，不應該生效。 */
    @Test
    void 查出來的物件改了但沒save就不算數() {
        OrderRepository repo = repository();
        tx(() -> repo.save(anOrder("O-1", "C-1", T0)));

        inTx(() -> {
            Order o = repo.findById("O-1").orElseThrow();
            o.cancel();          // 改了，但【沒有】save
            return null;
        });

        Order got = inTx(() -> repo.findById("O-1")).orElseThrow();
        assertThat(got.status()).isEqualTo(OrderStatus.PENDING_PAYMENT);
    }
}
```

**兩個子類別**：

```java
/** 契約測試 × JDBC 實作。 */
class JdbcOrderRepositoryContractTest extends OrderRepositoryContract {

    private JdbcOrderRepository repo;
    private TransactionTemplate txTemplate;

    @BeforeEach
    void setUp() {
        HikariDataSource ds = newDataSource();       // in-memory H2 + schema.sql
        repo = new JdbcOrderRepository(new NamedParameterJdbcTemplate(ds));
        txTemplate = new TransactionTemplate(new DataSourceTransactionManager(ds));
    }

    @Override protected OrderRepository repository() { return repo; }
    @Override protected void tx(Runnable work) { txTemplate.executeWithoutResult(s -> work.run()); }
    @Override protected <T> T inTx(Supplier<T> work) { return txTemplate.execute(s -> work.get()); }
}

/** 契約測試 × 記憶體假實作。 */
class InMemoryOrderRepositoryContractTest extends OrderRepositoryContract {

    private InMemoryOrderRepository repo;

    @BeforeEach void setUp() { repo = new InMemoryOrderRepository(); }

    @Override protected OrderRepository repository() { return repo; }
    @Override protected void tx(Runnable work) { work.run(); }
    @Override protected <T> T inTx(Supplier<T> work) { return work.get(); }
}
```

**本章的實測結果**：

```
[INFO] Tests run: 14, Failures: 0, Errors: 0 -- in InMemoryOrderRepositoryContractTest
[INFO] Tests run: 14, Failures: 0, Errors: 0 -- in JdbcOrderRepositoryContractTest
```

✅ **兩個實作、28 個測試、全綠。**

⚠️ **對照 00 章練習 3 的結果**（同一條測試跑在**骨架**上）：

```
[INFO]  Tests run: 10, Failures: 0 -- in InMemoryOrderRepositoryTest
[ERROR] Tests run: 10, Failures: 1 -- in JdbcOrderRepositoryContractTest
[ERROR]   改了明細再存回去查出來是新的明細:154 [刪掉的明細不該還在] Expected size: 1 but was: 2
```

> 📌 **這一組對照就是契約測試的全部價值**：
> **同一條測試，在 fake 上綠、在 JDBC 上紅** ——
> 而如果只跑 fake，你會以為那段程式碼是對的。

### 2.15.3 一條守門測試：`MANDATORY` 真的擋得住嗎

`@Transactional(propagation = MANDATORY)` 是**宣告**。要確認它**生效**，要有測試。

**實驗 G14-A**：

```java
@Configuration
@EnableTransactionManagement          // ★ 沒有這個，@Transactional 只是一個註解
static class TxConfig {
    @Bean DataSource dataSource() { … }
    @Bean NamedParameterJdbcTemplate jdbc(DataSource ds) { return new NamedParameterJdbcTemplate(ds); }
    @Bean PlatformTransactionManager txManager(DataSource ds) { return new DataSourceTransactionManager(ds); }
    @Bean OrderRepository orderRepository(NamedParameterJdbcTemplate jdbc) {
        return new JdbcOrderRepository(jdbc);
    }
}

@Test
void 沒有外層交易時save直接失敗() {
    try (var ctx = new AnnotationConfigApplicationContext(TxConfig.class)) {
        OrderRepository repo = ctx.getBean(OrderRepository.class);
        assertThatThrownBy(() -> repo.save(anOrder("O-1", "C-1", T0)))
                .isInstanceOf(IllegalTransactionStateException.class);
    }
}
```

```
=== G14-A @Transactional(MANDATORY) 真的擋得住嗎 ===
  注入進來的型別：jdk.proxy2.$Proxy25（是代理，不是原本的 class）
  ✅ 沒有外層交易 → IllegalTransactionStateException：
     No existing transaction found for transaction marked with propagation 'mandatory'
  ✅ 包在交易裡 → 存進去了：true
```

⚠️ **注意第一行印出來的型別是 `$Proxy25`**：

> **`@Transactional` 是靠 AOP 代理實作的**，所以它只在
> **「從外面呼叫這個 bean 的 public 方法」**時生效。
>
> 🔴 **兩個經典的失效情境**：
> 1. **自己呼叫自己**（`this.save(...)`）—— 不經過代理，註解完全不生效。
> 2. **`new JdbcOrderRepository(...)` 直接建**（本章的契約測試就是這樣做的）——
>    沒有代理，`MANDATORY` 不會被檢查。
>
> 📌 **所以契約測試裡的 `tx()` 用 `TransactionTemplate` 明確開交易，
> 而這一條守門測試才是真正在驗證 `MANDATORY`。**
> **兩者測的是不同的東西，缺一不可。**

---

## 2.16 常見誤區

| # | 誤區 | 真相 |
|---|---|---|
| 1 | 「用了 `PreparedStatement` 就安全了」 | ⚠️ 只有**值**的位置安全。`ORDER BY` 拼接照樣被打穿（2.3.4） |
| 2 | 「參數化就是幫我跳脫單引號」 | ❌ 是**SQL 與資料分兩次送**，語法樹在看到值之前就定案（2.3.3） |
| 3 | 「JDBC 一次只能送一句，所以 `'; DROP` 沒用」 | 🔴 **H2 實測會執行第二句，整張表被刪掉**（2.3.2） |
| 4 | 「`LIKE ?` 有參數化，安全了」 | ⚠️ 擋得住 injection，**擋不住 `%`** —— 而 `LIKE '%%%'` 是免費的 DoS（2.3.6） |
| 5 | 「`SELECT ? FROM t` 可以動態選欄位」 | 🔴 **它回傳的是欄位【名字】這個字串**，而且不會報錯（2.3.4） |
| 6 | 「`queryForObject` 查不到會回 `null`」 | ❌ 拋 `EmptyResultDataAccessException`。**但值是 `NULL` 時真的回 `null`**（2.4.2） |
| 7 | 「`SUM()` 沒有資料就是 0」 | ❌ 是 `NULL`。`long total = queryForObject(…)` 直接 NPE（2.4.3） |
| 8 | 「`rs.getLong()` 讀到 NULL 會給 null」 | ❌ 給 **0**。「沒有折扣」變成「折扣 0 元」（2.5.5） |
| 9 | 「用了 `wasNull()` 就對了」 | 🔴 **寫在引數列裡會問錯欄位**（Java 由左到右求值）（2.5.5） |
| 10 | 「`BeanPropertyRowMapper` 對不到會報錯」 | 🔴 **少了欄位是靜默給 `null`**；只有多欄位才報錯（2.5.4） |
| 11 | 「`RowCallbackHandler` 就不會 OOM」 | ⚠️ 你的程式碼不累積，**但 MySQL 驅動預設把整個結果集抓回記憶體**（2.5.7） |
| 12 | 「空的 `List` 傳給 `IN (:ids)` 沒關係」 | 🔴 展開成 `IN ()`，**H2 收、MySQL 是語法錯誤**（2.6.3） |
| 13 | 「`MERGE` 比較快，換掉那三次來回」 | 🔴 **upsert 與樂觀鎖語意衝突**，version 檢查會失效（2.8.3） |
| 14 | 「批次寫入是原子的」 | ❌ 批次只是少幾次來回。**失敗時部分寫入，而且哪些進去了是驅動相依的**（2.13.2） |
| 15 | 「每條約束都取名字，就能翻譯例外了」 | ⚠️ **H2 的具名主鍵在例外訊息裡不見了**，唯一鍵還被加了後綴（2.12.3） |
| 16 | 「`@Transactional` 加了就會生效」 | 🔴 **`this.save()` 與 `new` 出來的物件都不經過代理**（2.15.3） |

---

## 2.17 本章練習

### 練習 1：找出這段 Repository 的九個問題

```java
@Repository
public class ProductRepository {

    @Autowired private JdbcTemplate jdbc;

    public List<Map<String, Object>> search(String keyword, String sortBy, int page) {
        String sql = "SELECT * FROM product WHERE name LIKE '%" + keyword + "%'"
                   + " ORDER BY " + sortBy
                   + " LIMIT " + (page * 20) + ", 20";
        return jdbc.queryForList(sql);
    }

    @Transactional
    public Product findById(long id) {
        return jdbc.queryForObject("SELECT * FROM product WHERE id = ?",
                new BeanPropertyRowMapper<>(Product.class), id);
    }

    public long totalRevenue(String category) {
        return jdbc.queryForObject(
                "SELECT SUM(price) FROM product WHERE category = ?", Long.class, category);
    }

    public void deactivate(List<Long> ids) {
        for (Long id : ids) {
            jdbc.update("UPDATE product SET active = false WHERE id = ?", id);
        }
    }
}
```

<details>
<summary>參考答案</summary>

| # | 問題 | 節次 | 後果 |
|---|---|---|---|
| 1 | `LIKE '%" + keyword + "%'` **拼接** | 2.3.1 | SQL Injection |
| 2 | 就算改成參數化，**`%` 沒有跳脫** | 2.3.6 | 使用者輸入 `%` 就全表掃描 |
| 3 | `ORDER BY " + sortBy` **沒有白名單** | 2.3.5 | Injection ＋ 按未建索引的欄位排序 |
| 4 | `LIMIT " + (page * 20)` **沒有上限** | 2.3.7 | `page` 很大時 offset 巨大（04 章的深分頁） |
| 5 | 回傳 `List<Map<String, Object>>` | 2.4.4 | 實作細節外流；key 的大小寫跨資料庫不一致 |
| 6 | `findById` 用 `queryForObject` | 2.4.2 | 🔴 **查不到就拋例外**，而且回傳型別不是 `Optional` |
| 7 | `BeanPropertyRowMapper` | 2.5.4 | 少了欄位靜默給 `null` |
| 8 | `totalRevenue` 的 `SUM` 拆箱成 `long` | 2.4.3 | 🔴 **沒有商品的分類直接 NPE** |
| 9 | `deactivate` 在**迴圈裡下 update** | 2.13.1 | N 次來回；應該用 `IN (:ids)` 或 `batchUpdate` |

**加分題（三個結構性問題）**：

| # | 問題 | 說明 |
|---|---|---|
| A | `@Autowired` **欄位注入** | 不能寫成 `final`；測試時要靠反射塞值 |
| B | `@Transactional` 加在 **Repository 的 `findById` 上** | 🔴 00 章 0.9.2：每次呼叫各開一個交易，**組不成原子操作**。應該是 `MANDATORY` |
| C | `search()` 是**查詢**，卻和 `save` 路徑混在同一個 class | 00 章 0.7：查詢該走 `ProductQueryDao` |

</details>

---

### 練習 2：這段 `RowMapper` 有三個 bug

`orders` 表新增了兩個可為 `NULL` 的欄位：`discount_minor BIGINT` 與 `note VARCHAR(200)`。

```java
record OrderView(String id, Long discountMinor, String note, boolean isVip) {}

RowMapper<OrderView> mapper = (rs, n) -> new OrderView(
        rs.getString("id"),
        rs.wasNull() ? null : rs.getLong("discount_minor"),
        rs.getString("note"),
        rs.getBoolean("vip_flag"));
```

**(a)** 找出三個 bug。
**(b)** 寫出正確的版本。
**(c)** 哪一個 bug 用「只有正常資料」的測試抓不到？

<details>
<summary>參考答案</summary>

**(a)**

| # | bug | 說明 |
|---|---|---|
| 1 | **`wasNull()` 在 `getLong` 之【前】呼叫** | 🔴🔴 順序完全反了 —— 它問的是 `rs.getString("id")` 那一欄。而且就算順序對了，寫在引數列裡仍然會被 `getString("id")` 干擾（2.5.5） |
| 2 | **`vip_flag` 是 `NULL` 時 `getBoolean` 回 `false`** | 「沒有設定」變成「不是 VIP」（2.5.5 的同一族） |
| 3 | **`note` 沒有問題，但 `discountMinor` 永遠不會是 `null`** | 因為 bug 1，這個欄位的 `NULL` 語意完全遺失 |

**(b)**

```java
RowMapper<OrderView> mapper = (rs, n) -> {
    String id = rs.getString("id");
    Long discount = rs.getObject("discount_minor", Long.class);   // ✅ 直接回 null
    String note = rs.getString("note");                            // String 本來就回 null
    Boolean vip = rs.getObject("vip_flag", Boolean.class);         // ✅ 分得出 null
    return new OrderView(id, discount, note, vip != null && vip);
};
```

⚠️ **最後一行做了一個決定**：`NULL` 當成「不是 VIP」。
**這個決定本身沒有錯，錯的是「不知不覺地」做了它。**
如果 `NULL` 與 `false` 在業務上是兩件事，`OrderView` 的欄位型別就該是 `Boolean`。

**(c)** 🔴 **三個 bug 全部都抓不到。**

> 只要測試資料裡 `discount_minor` 與 `vip_flag` **都有值**，
> 這個 mapper 的行為就是完全正確的。
>
> 📌 **教訓**：**資料層的測試資料一定要包含 `NULL`。**
> 「每個可為 `NULL` 的欄位，至少要有一筆測試資料是 `NULL`」
> 應該是一條寫下來的規定（06 章會再談測試資料的準備）。

</details>

---

### 練習 3：這個 `save()` 為什麼會偶爾失敗 ★

某個團隊把 shop-service 的 `save()` 改成了單句 upsert，理由是「少兩次來回」：

```java
@Override
public void save(Order order) {
    jdbc.update("""
            MERGE INTO orders (id, customer_id, status, total_minor, currency, created_at, version)
            KEY (id)
            VALUES (:id, :customerId, :status, :totalMinor, :currency, :createdAt, :version)
            """, headParams(order));
    jdbc.update("DELETE FROM order_line WHERE order_id = :id",
            new MapSqlParameterSource("id", order.id()));
    insertLines(order);
}
```

上線之後：**契約測試全綠**、壓測正常、但客服每週會收到兩三件
「我明明取消了訂單，它卻出貨了」。

**(a)** 為什麼契約測試是綠的？
**(b)** 客訴的機制是什麼？請描述兩個使用者的操作順序。
**(c)** 如果不能改回三次來回，有沒有辦法在**單句** SQL 裡保住樂觀鎖？

<details>
<summary>參考答案</summary>

**(a)** **因為契約測試是【單執行緒】的。**

2.15.2 那條「拿著過期的 version 存回去會失敗」的測試，
流程是「讀出來 → 別人改 → 我再存」，**三個步驟依序發生**。
而 `MERGE` 的問題不在於它「察覺不到別人改過」——
**它根本不檢查**，所以在單執行緒下**每一步都成功**，測試看不出異常。

⚠️ **要抓到它，測試必須斷言「第二次 save 應該拋例外」** ——
而那條測試在 `MERGE` 版本上會紅（實驗 G7-C 就是這條）。

**(b)** 兩個使用者的交錯（實驗 G7-C 的真實版本）：

```
時間  客戶（手機 App）                客服（後台）
 T1   讀出訂單 O-1（version=5）
 T2                                 讀出訂單 O-1（version=5）
 T3   按下「取消訂單」
      → MERGE 寫入 CANCELLED
      → 資料庫：CANCELLED, version=6
 T4                                 按下「標記為已出貨」
                                    → MERGE 寫入 SHIPPED（帶著過期的 version=5）
                                    → 🔴 資料庫：SHIPPED, version=6
 T5   使用者看到「已取消」的確認信
 T6                                 🔴 出貨流程照常跑
```

📌 **關鍵是 T4**：客服的 `MERGE` **不檢查 version**，直接覆蓋。
**客戶的取消消失了，而且沒有任何錯誤。**

⚠️ **「每週兩三件」正是這種 bug 的典型頻率** ——
它需要兩個人在幾秒內操作同一張訂單，**不常見，但一定會發生**。

**(c)** ✅ **可以，把 version 條件寫進 `MERGE` 的 `WHEN MATCHED` 裡**：

```java
jdbc.update("""
        MERGE INTO orders t
        USING (SELECT CAST(:id AS VARCHAR(26)) AS id) s ON t.id = s.id
        WHEN MATCHED AND t.version = :version THEN
             UPDATE SET t.status = :status, t.version = t.version + 1
        WHEN NOT MATCHED THEN
             INSERT (id, customer_id, status, total_minor, currency, created_at, version)
             VALUES (:id, :customerId, :status, :totalMinor, :currency, CURRENT_TIMESTAMP, :version)
        """, headParams(order));
```

**實驗 G15 在 H2 上驗證了這個寫法**：

```
=== G15 帶 version 條件的 MERGE（練習 3 的 (c)） ===
  過期 version=3 → 影響 0 列，資料是 PENDING_PAYMENT/5 ← ✅ 擋下來了
  正確 version=5 → 影響 1 列，資料是 PAID/6
  全新的 id      → 影響 1 列
```

✅ **它真的擋住了過期的 version，而且新單仍然會被插入。**

🔴 **但這裡有一個陷阱**：`WHEN MATCHED AND t.version = :version` 不成立時，
`MERGE` **什麼都不做而且回傳 0** ——
**你仍然要檢查回傳值，並且分辨「version 不對」與「這一列不存在」。**
而上面的輸出裡，「過期 version」與「什麼都沒發生」**都是 0 列**。

> 📌 **所以「一句 SQL」這個目標其實沒有達成**：
> 你還是要多一次查詢來分辨那兩種情況。
> **這正是 2.8.1 的 ② 為什麼長那樣。**
>
> ⚠️ **而且 `WHEN MATCHED AND` 是 SQL:2003 的選用語法，各家支援程度不同** ——
> 🔴 **【本章只在 H2 上驗證過】**。
> 為了省一次來回而換來一句「不確定能不能跨資料庫」的 SQL，**通常不划算**。

**加分題：那要怎麼在 CI 上抓到這一類 bug？**

> 契約測試要加**併發**的案例。最小的形狀是：
>
> ```java
> @Test
> void 兩個交易同時改同一張訂單只有一個會成功() throws Exception {
>     tx(() -> repo.save(anOrder("O-1", "C-1", T0)));
>     Order a = inTx(() -> repo.findById("O-1")).orElseThrow();   // 兩邊都讀到 version=0
>     Order b = inTx(() -> repo.findById("O-1")).orElseThrow();
>
>     tx(() -> { a.markPaid(); repo.save(a); });                  // 先改的成功
>     assertThatThrownBy(() -> tx(() -> { b.cancel(); repo.save(b); }))
>             .describedAs("後改的必須失敗，不可以靜默覆蓋")
>             .isInstanceOf(OptimisticLockingFailureException.class);
> }
> ```
>
> ✅ **注意它不需要真的多執行緒** —— 只要**兩個物件拿著同一個 version**就夠了。
> **「併發 bug 一定要用併發測試抓」是一個常見的誤解**，
> 而樂觀鎖的契約剛好可以用單執行緒表達。

</details>

---

### 練習 4：把 `JdbcOrderRepository` 改寫成 `JdbcClient` 版本

**(a)** 用 `JdbcClient` 改寫 `findById`、`countByCustomerId` 與 `save`。
**(b)** 讓它通過**同一組**契約測試（2.15.2）。
**(c)** 哪一個方法**不建議**換？為什麼？

<details>
<summary>參考答案</summary>

**(a)**

```java
@Override
public Optional<Order> findById(String orderId) {
    // ⚠️ 不能直接用 .optional() —— 因為 load() 需要兩次查詢再拼聚合
    return load(SELECT_HEAD + " WHERE id = :id",
                new MapSqlParameterSource("id", orderId)).stream().findFirst();
}

@Override
public long countByCustomerId(String customerId) {
    return client.sql("SELECT COUNT(*) FROM orders WHERE customer_id = :cid")
                 .param("cid", customerId)
                 .query(Long.class)
                 .single();                 // ✅ COUNT 永遠有一列，用 single() 是對的（2.4.3）
}

@Override
public void save(Order order) {
    int updated = client.sql(UPDATE_HEAD).paramSource(headParams(order)).update();
    if (updated == 1) {
        client.sql("DELETE FROM order_line WHERE order_id = :id")
              .param("id", order.id()).update();
        insertLines(order);
        return;
    }
    long rows = client.sql("SELECT COUNT(*) FROM orders WHERE id = :id")
                      .param("id", order.id()).query(Long.class).single();
    if (rows > 0) throw new OptimisticLockingFailureException(…);
    client.sql(INSERT_HEAD).paramSource(headParams(order)).update();
    insertLines(order);
}
```

**(b)** 契約測試**一行都不用改** —— 加一個子類別就好：

```java
class JdbcClientOrderRepositoryContractTest extends OrderRepositoryContract {
    @BeforeEach void setUp() {
        HikariDataSource ds = newDataSource();
        repo = new JdbcClientOrderRepository(JdbcClient.create(ds));
        txTemplate = new TransactionTemplate(new DataSourceTransactionManager(ds));
    }
    …
}
```

**本章實測（三個實作跑同一組 14 條契約）**：

```
[INFO] Tests run: 14, Failures: 0 -- in lab.InMemoryOrderRepositoryContractTest
[INFO] Tests run: 14, Failures: 0 -- in lab.JdbcOrderRepositoryContractTest
[INFO] Tests run: 14, Failures: 0 -- in lab.JdbcClientOrderRepositoryContractTest
[INFO] Tests run: 42, Failures: 0, Errors: 0
```

> 📌 **這就是契約測試最大的報酬**：
> **換實作技術的成本從「重寫測試」降到「加一個子類別」。**
> 03 章的 Spring Data 實作會第四次用到同一組測試。

**(c)** 🔴 **`insertLines()` 不建議換**（批次），還有 `load()` 裡那次 1:N 的查詢。

| 方法 | 為什麼不換 |
|---|---|
| `insertLines()` | `JdbcClient` 的批次 API 沒有比 `batchUpdate(SqlParameterSource[])` 好用，而且 05 章要在這裡做批次調校 |
| `load()` 的明細查詢 | 需要 `groupingBy` 之後拼聚合，`query(Class).list()` 幫不上忙 |

⚠️ **而「一半 `JdbcClient`、一半 `JdbcTemplate`」是完全可以的**（實驗 G13-C）——
`JdbcClient.create(jdbcTemplate)` 讓兩者共用同一組設定與 exception translator。

</details>

---

## 2.18 驗收清單

讀完本章，你應該能回答：

**安全**

- [ ] 為什麼「參數化」不等於「跳脫」？這個差別決定了它擋得住什麼？
- [ ] `SELECT ? FROM orders` 會回傳什麼？為什麼它比「直接報錯」更危險？
- [ ] 使用者在搜尋框輸入 `%`，你的 `LIKE ?` 會發生什麼事？
- [ ] 「JDBC 一次只送一句，所以多句攻擊沒用」—— 這句話為什麼不能依賴？

**對應**

- [ ] `RowMapper` / `ResultSetExtractor` / `RowCallbackHandler` 各在什麼時候用？
- [ ] `rs.getLong()` 讀到 `NULL` 回傳什麼？`rs.wasNull()` 有什麼順序上的陷阱？
- [ ] `BeanPropertyRowMapper` 少了一個欄位會怎樣？`DataClassRowMapper` 呢？
- [ ] 一張訂單來自兩張表，用「一次 JOIN」與「兩次查詢」各有什麼代價？

**寫入**

- [ ] `save()` 的四種寫法各要幾次來回？shop-service 為什麼選最貴的那一種？
- [ ] 為什麼「要樂觀鎖就不能用單句 `MERGE`」？
- [ ] `update()` 回傳 0 有哪兩個原因？怎麼分辨？
- [ ] 批次寫入到一半失敗，資料庫是什麼狀態？

**例外**

- [ ] 五種約束違反在 Spring 裡是幾種例外型別？
- [ ] 「每條約束都取名字」這個策略在 H2 上有什麼限制？
- [ ] 三種例外翻譯的做法，shop-service 選哪一種？判準是什麼？
- [ ] 為什麼「應用層先檢查」與「資料庫唯一鍵」兩個都要？

**完成本章後**，請確認你的專案有：

```
✅ JdbcOrderRepository            ★ save() 會維護明細（不是只更新頭）
✅ OrderRow.parseStatus()         ★ 未知 status 的訊息說得出是哪一筆
✅ 契約測試 14 條 × 2 個實作       ★ 全綠，而且骨架版本實測會紅
✅ SELECT_HEAD 等 SQL 常數        ★ 全部 text block，沒有變數拼接
✅ NoConcatenatedSqlTest          ★ 守門測試，且實測過會紅
✅ ConstraintNameGuardTest        ★ 2.12.7，把樣式改壞會紅
✅ PersistenceArchitectureTest    ★ 2.12.8 的三條規則，都實測過會紅
✅ 一條 MANDATORY 的守門測試       ★ 用真的 Spring 代理，不是 new 出來的物件
✅ load() 的 heads.isEmpty() 早退  ★ 擋住 IN ()
```

---

## 2.19 下一章預告

這一章的 `JdbcOrderRepository` **每一句 SQL 都是你自己寫的**。
下一章要看的是**另一個極端**：

```java
public interface OrderRepository extends CrudRepository<OrderEntity, String> {

    List<OrderEntity> findByCustomerIdAndStatusOrderByCreatedAtDesc(String customerId, OrderStatus status);
    //                ↑ 這個方法【沒有實作】，而它會動。為什麼？
}
```

| 問題 | 03 章哪一節 |
|---|---|
| 沒有實作的介面是怎麼跑起來的？（動態代理的完整過程） | 3.2 |
| `Repository` / `CrudRepository` / `JpaRepository` 家族該選哪一個？ | 3.3 |
| 方法命名的規則到底有多少條？打錯名字什麼時候會發現？ | 3.4 |
| `@Query` 什麼時候該用？JPQL 與原生 SQL 的差別 | 3.6 |
| **明細「全刪重插」vs「逐筆 diff」的完整比較**（本章 2.8.4 欠的） | **3.7 ★** |
| 投影（Projection）：只查三個欄位要怎麼寫 | 3.8 |
| **同一組契約測試跑在 Spring Data 實作上，會不會綠？** | **3.10 ★** |

⚠️ **3.10 是整個 03 章的重點**：
**本章的 14 條契約測試，會有兩條在 Spring Data 的實作上是紅的** ——
而它紅的原因，和 2.8.3 那個 `MERGE` 讓樂觀鎖失效的原因**是同一個**，
只是這一次它躲在 ORM 後面，更難看見。

📌 **而更值得注意的是另外 12 條綠燈**：
**契約全綠，不代表兩個實作的行為一樣。**
3.9 會展示三件「契約測試完全看不到、但一定會咬你」的差異。

---

## 2.20 本章的實驗環境與結果

**環境**（與 00、01 章相同）：

| 項目 | 版本 |
|---|---|
| JDK | Temurin **21.0.5**（LTS） |
| Maven | **3.9.16** |
| Spring Boot | **3.2.5** |
| Spring Framework | **6.1.6**（`JdbcClient` 需要 6.1+） |
| 連線池 | **HikariCP 5.0.1** |
| 資料庫 | **H2 2.2.224** |
| ArchUnit | **1.3.0** |
| 平台 | macOS 14.2.1 / Apple Silicon |

**跑過的實驗（19 組）+ 契約測試（14 條 × 3 個實作 = 42 個），合計 95 個測試，全綠**：

| 組 | 實驗 | 結果 |
|---|---|---|
| **G1** | 純 JDBC 樣板 | ✅ 忘了 close：借 3 次就滿、第 4 次**卡 30 秒**；例外路徑下 JdbcTemplate **不洩漏**（active=0）<br>🔴 **意外發現：跑起來之後用 MXBean 改 `connectionTimeout` 讀得回 3000、實際仍等 30 秒；建構時設就生效** |
| **G2** | SQL Injection | ✅ 拼接被 `OR '1'='1` 打穿（3 筆全洩）、`UNION` 撈出另一個欄位；參數化把攻擊字串當成一般資料存取 |
| **G3** | 識別字與 LIKE | 🔴 **`'; DELETE` 在 H2 上真的執行了第二句，3 筆→0 筆**；`SELECT ? FROM t` **靜默回傳欄位名字串**；`LIKE '%'` 全表回傳，`ESCAPE` 後只回 1 筆 |
| **G4** | JdbcTemplate API | ✅ `queryForObject` 三個陷阱（0 筆拋、2 筆拋、值 NULL 回 null）；**`SUM`/`MAX` 無資料時回 `null`**；`ORDER BY ?` 拋的是 `DataIntegrityViolationException` |
| **G5** | 三種回呼與對應 | ✅ 三者行為對照；`DataClassRowMapper` 少欄位**拋例外**、`BeanPropertyRowMapper` 少欄位**靜默 null**<br>🔴 **`wasNull()` 寫在引數列裡會問錯欄位（由左到右求值）**；20 萬列 List 16 MB vs 串流 1 MB |
| **G6** | 具名參數 | ✅ `IN (:ids)` 展開成 N 個 `?`；🔴 **空集合展開成 `IN ()`（H2 收，MySQL 是語法錯誤）**；`LIMIT :limit` 與 `FETCH FIRST :limit` 在 H2 都可以；位置參數寫反**靜默回空結果** |
| **G7** | save 的四種寫法 | ✅ 來回次數 2/3/1/1；8 執行緒競賽**1 成功 7 撞主鍵**；🔴 **`MERGE` 讓過期 version 覆蓋成功**；只更新頭不動明細**靜默留下舊明細**；新單 3 次來回慢 **4.9 倍** |
| **G8** | 例外翻譯 | ✅ Boot 3.2 預設是 **`SQLExceptionSubclassTranslator`**；**五種違反塌縮成一個 `DataIntegrityViolationException`**；SQLState 23505/23513/23506/23502/22001 |
| **G9** | 約束名與自訂 translator | 🔴 **具名主鍵在 H2 例外訊息裡變成 `PRIMARY_KEY_5`（名字不見了）**；唯一鍵變成 `UQ_..._INDEX_5`（要用開頭比對）；自訂 translator 可行；呼叫點翻譯不依賴訊息格式；**6 執行緒註冊同一 email：應用層擋 0 個、唯一鍵擋 5 個** |
| **G10** | RowMapper 健壯性與 KeyHolder | ✅ 未知 enum 的三層改進；`GeneratedKeyHolder` 需要 `new String[]{"id"}`；**`batchUpdate` 拿不回自動主鍵** |
| **G11** | 原子 UPDATE | ✅ **庫存 10、20 併發 → 剛好 10 人搶到、庫存歸零**（對照 00 章兩組超賣實驗）；「更新 0 列」兩種原因分不出來<br>⚠️ **分片計數只快 1.13 倍 —— 本實驗【沒有】重現熱點列問題** |
| **G12** | 批次 | ✅ 2 萬筆逐筆 349 ms vs 批次 174 ms（**僅 2 倍，因為 H2 沒有網路**）；🔴 **批次失敗後 X-1 與 X-3 都寫進去了（驅動跳過錯誤繼續）** |
| **G13** | JdbcClient | ✅ 三種 API 結果相同；`single()` 0 筆拋例外、`optional()` 回 empty 但 **2 筆仍拋**；`JdbcClient.create(jdbcTemplate)` 沿用既有設定 |
| **R1** | 約束名擷取的守門測試（2.12.7） | ✅ 四條約束的名字全部抽得出來；**把樣式改壞實測會紅**，訊息直接說「translator 失效了」 |
| **R2** | 三條 ArchUnit 規則（2.12.8） | ✅ 只有資料層可碰 JDBC、不可認識 `..security..`、不可處理顯示；**放一個做格式化的 class 進去實測會紅** |
| **G14** | 守門測試 | ✅ `MANDATORY` 在真代理下拋 `IllegalTransactionStateException`（注入型別是 `$Proxy25`）；**SQL 拼接掃描與 ArchUnit 規則都實測過會紅、移除違規後回綠** |
| **G17** | `rs.getObject(欄位, Class)` | ✅ 兩參數版本在 H2 上對 `BIGINT`/`BOOLEAN` 的 NULL 都回 `null`（不是 0 / false），有值時回 `500` / `true` |
| **G16** | 章節 2.3.8 那條正規表示式 | ✅ 逐條驗證：抓得到真拼接、不誤判 `SELECT_HEAD + " WHERE…"` 與參數化；⚠️ **「常數 + 具名常數」會誤判**（文字掃描分不出常數與變數） |
| **G15** | 帶條件的 MERGE（練習 3） | ✅ `WHEN MATCHED AND t.version = :version` 在 H2 上**擋住了過期 version**（0 列）、正確 version 更新成功、新 id 仍會插入；⚠️ 但「擋下來」與「沒這一列」都是 0 列，仍要多一次查詢分辨 |

**契約測試**：

```
[INFO] Tests run: 14, Failures: 0, Errors: 0 -- in InMemoryOrderRepositoryContractTest
[INFO] Tests run: 14, Failures: 0, Errors: 0 -- in JdbcOrderRepositoryContractTest
[INFO] Tests run: 14, Failures: 0, Errors: 0 -- in JdbcClientOrderRepositoryContractTest   ← 練習 4
[INFO] Tests run: 95, Failures: 0, Errors: 0
[INFO] BUILD SUCCESS
```

**三個實作（記憶體 fake、`NamedParameterJdbcTemplate`、`JdbcClient`）跑同一組 14 條契約，全綠。**

🔴 **本章沒有驗證到的（都需要真的 MySQL / PostgreSQL / Oracle）**：

| 沒驗證的 | 影響哪一節 | 哪一站會補 |
|---|---|---|
| **MySQL / PostgreSQL 會不會執行多句 SQL** | 2.3.2 | 07-mysql 站 |
| **`IN ()` 在 MySQL 上的語法錯誤** | 2.6.3 | 07-mysql 站 |
| **MySQL 8 不支援 `FETCH FIRST`** | 2.6.4、2.15.1 | 04 章、07-mysql 站 |
| **MySQL / PostgreSQL 的串流（`fetchSize`）** | 2.5.7 | 05 章 5.11、**06 章 6.4（探針 ⑲，部分驗證）** |
| **`rewriteBatchedStatements=true` 的批次效益** | 2.13.1 | 05 章 5.8、07-mysql 站 |
| **MySQL / PostgreSQL 的約束名訊息格式** | 2.12.3 | 07-mysql 站 |
| **三個 translator 在 MySQL / Oracle 上的差異** | 2.12.2 | 07-mysql 站 |
| **熱點列的真實吞吐上限**（G11-C 沒有重現問題） | 2.11.3 | 07-mysql 站 04 章 |
| **`VARCHAR(26)` 主鍵 vs `BIGINT` 自增的索引成本** | 2.10 | 07-mysql 站 03 章 |

> 📌 **最後一句話**：
>
> 這一章有**四個實測結果與「大家都這樣說」不一樣**：
>
> **① 「JDBC 一次只能送一句，所以 `'; DROP` 沒用」** ——
> H2 實測**執行了第二句**，一次「查詢」把三筆資料清成零（G3-A）。
>
> **② 「用了 `wasNull()` 就處理好 NULL 了」** ——
> 寫在引數列裡的 `wasNull()` 問的是**別的欄位**，
> 而那段程式碼**看起來完全正確**（G5-E）。
>
> **③ 「每條約束都取名字，就能翻譯例外」** ——
> H2 把**具名主鍵的名字丟掉了**，唯一鍵的名字則被加了後綴（G9-A）。
>
> **④ 「`MERGE` 比較快，而且行為一樣」** ——
> 它讓樂觀鎖**靜默失效**，而單執行緒的契約測試**抓不到**（G7-C、練習 3）。
>
> ⚠️ **四個的共同形狀是同一個**：
> **它們在「正常資料、單執行緒、H2」這三個條件下都是對的。**
> 而**正式環境剛好一個條件都不滿足。**
>
> 📌 **所以這一章真正想教的不是 API，是一種習慣**：
> **每次你寫下「這樣應該沒問題」的時候，去量它。**
>
> ⚠️ **而「量它」有一個容易被跳過的部分**：
> **不要只確認「正常情況是對的」，要刻意去踩那三個條件的反面** ——
> 放一筆 `NULL` 進測試資料、讓兩個物件拿著同一個 version、
> 把空的 `List` 傳進 `IN`。
> **本章 16 個常見誤區裡，有一半以上在「正常資料 + 單執行緒 + H2」下完全看不出來。**
