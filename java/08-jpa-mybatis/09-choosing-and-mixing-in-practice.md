# 第 09 章：實務選型與混用 —— 這一站的結案

> 00 章 0.8.4 那個決定寫著：
>
> ```
> ✅ 主線用 JPA / Spring Data JPA
> ✅ 報表與列表查詢用 MyBatis
>       理由：0.7 實測（同一頁 3 ms vs 9 ms，而報表的資料量大得多）
> ```
>
> **這一章要問的是：那個「3 ms vs 9 ms」到底是什麼的 3 ms。**
>
> ---
>
> ```
> 07 章 7.15.3：同一頁，JPA 2699 µs、MyBatis 1188 µs
> 08 章 8.10.2：同一組五個條件，JPA 5958 µs、MyBatis 2801 µs
>                              ↓
> 兩次都是「兩倍多」。而兩次量的都是【一整條路】——
> 交易 + 動態條件的翻譯 + 查詢 + 建物件 + 組裝結果。
>                              ↓
> 09 章 9.4.1c 把那條路拆開，只留【同一句 SQL、同一個投影】：
>       JPA 480 µs、MyBatis 518 µs —— 0.93 倍。
> ```
>
> **那個兩倍不是「哪個框架比較快」。**
> **它是【交易】、【Criteria 的翻譯】、【建實體】三件事加起來。**
> **而這三件事，兩個都不是「JPA 的宿命」—— 它們都是你選的。**

---

這一章有 **28 組實測、73 個量到的數字**（31 個測試、14 個測試類別，全綠）。挑十二個先講結果：

- ★★ **同一句 SQL、同一個投影、同樣扣掉交易與快取：JPA 480 µs、MyBatis 518 µs**
  （1 列到 200 列的五個資料量上，比值都在 0.97～1.02 之間）—— 帳二在這裡結掉
- 🔴 **08 章 8.13 那句「那個 8 倍的等價寫法 JPA 那一側做不到」是錯的**：
  JPQL 寫得出 OR 展開形式（3557 → 930 µs、`Index range scan`），
  **而它也寫得出慢的那一種** —— `(a, b) < (?, ?)` JPQL 完全收得下，
  原封不動翻成列建構子比較 ★★
- 🔴 **00 章 0.8.1 場景 D「報表 → MyBatis」的理由不是「JPA 做不到」**：
  07 章那兩份報表（CTE + `RANK() OVER` + `SUM() OVER`、`DATE_FORMAT` + 樞紐）
  用 HQL 各寫一次，**兩邊的結果 `equals()` 完全相等**
- ★★ **第六把尺（配置了幾個位元組）給出一個反直覺的數字**：
  同一頁 20 筆，JPA 投影 **83 KB**、MyBatis **115 KB** ——
  **「0 個實體」不等於「配置比較少」**
- 🔴🔴 **同一個 `LocalDateTime`，Hibernate 的 native query 與 JdbcTemplate / MyBatis
  送到伺服器的值差 8 小時**（`2026-08-31 18:49` vs `2026-09-01 02:49`）——
  混用的第四號地雷：**型別轉換不是共用的**
- 🔴 **「flush 了 MyBatis 還是查不到」**：資料庫裡明明有 1 列，
  而 MyBatis 把上一次那個 `null` **快取起來了**（`clearCache()` 之後才看得到）★★
- **多一個框架的技術成本：啟動慢 4 ms、多 11 個 bean、heap 一樣**
  （17.7 MB 的 JPA 依賴 vs 1.8 MB 的 MyBatis 依賴）——
  **混用貴的地方不在這裡，在那四個地雷**
- 🔴 **把寫入路徑搬到 MyBatis：17 行變 63 行，而「六件要自己補回來的事」漏掉一件**
  → 20 個人同時付同一張訂單，**10 個人收到「付款成功」**
- 🔴 **8.9.1 那條斷言搬到 JPA 側：不能不執行**。
  `unwrap(Query).getQueryString()` 對 Criteria 回傳的是字串 **`"<criteria>"`**；
  等價的檢查要 281 ms + 一個資料庫 + 資料（MyBatis 側是 57 ms、什麼都不要）
- ★★ **09 章新加的那條契約測試，抓到一個從 05 章活到現在的 bug**：
  「只填結束時間」的搜尋，**JPA 那一側靜默忽略那個條件**，MyBatis 那一側會過濾
- 🔴 **而那個 bug 的指紋，一直印在 08 章 8.9.3 那條斷言上**：
  32 種條件組合在 JPA 側只產出 **28 種** SQL 形狀（修好之後是 56 種）
- **匯出 12500 列**：JPA 實體 133 ms / 47.9 MB、JPA 投影 62 ms / 15.7 MB、
  MyBatis 54 ms / 30.7 MB、**JdbcTemplate 40 ms / 7.6 MB** ——
  「兩個都不選」的空間在這裡

📌 **這一章的主線**：

> **前八章一直在量「兩個框架」。**
> **而 09 章的每一個實測都指向同一件事：**
> **那些差別，大部分不是【框架】的差別。**
>
> ```
> 是「有沒有交易」（0.5～1.5 ms，兩邊都付）
> 是「有沒有建實體」（90 個 vs 0 個，而 JPA 可以 0 個）
> 是「動態條件怎麼翻譯」（Criteria 1 ms 的 CPU，而 JPQL 沒有）
> 是「一句撈齊還是一列一句」（1541 µs vs 5475 µs，而兩個框架都會犯）
>                              ↓
> 選型的差別是常數倍，寫法的差別是量級 —— 00 章 0.8.3 那句話。
> 這一章是它的證明。
> ```

⚠️ **這一章有一件事跟前面八章不一樣，值得先說**：

```
前八章的實測都在回答「這個框架怎麼運作」。
09 章的實測在回答「我前面那八章講的，哪幾句要修」。

而它修掉的四句話裡，有三句是【我自己在 00 / 07 / 08 章寫的】：
   ① 08 章 8.13 「那個 8 倍 JPA 做不到」          → 做得到（9.3.1b）
   ② 00 章 0.8.1 「報表 → MyBatis」的【理由】      → 理由要換（9.3.3）
   ③ 00 章 0.6.6 「MyBatis 換資料庫要自己改 SQL」  → 六句裡要改【一個函式】（9.3.6）
   ④ 05 章 5.14   OrderSpecifications.of()       → 🔴 它從一開始就少一個條件（9.9.2）
```

---

## 9.1 學習目標

完成本章後，你應該可以：

- 把 00 章 0.6 那六條軸，用**九章的實測數字**各自填上結論（9.3）。
- 說出「MyBatis 比較快」這句話**在什麼條件下成立、在什麼條件下不成立**，
  並知道怎麼**拆開**一個效能數字（固定成本 / 每列成本 / 交易 / 建物件）（9.4）。
- 分辨「快」與「省事」是兩個問題，並各自有量法（9.5）。
- 在三種混用切法（依表 / 依用例 / 依讀寫）之間選擇，並說出各自的**第一號地雷**（9.6）。
- 估算遷移成本 —— 不是猜，而是**真的搬一次然後數**（9.7）。
- 說出這一站 24 條斷言裡，哪幾條**跟框架無關**、哪幾條**換框架就要換形式**（9.8）。
- 把「同一個功能兩個實作」收斂成一個，並用**契約測試**保護那個決定（9.9）。
- 回答「兩個都不選行不行」—— JdbcTemplate / jOOQ / 純 JDBC 在 2026 年的位置（9.10）。
- 對一個既有專案給出**有理由的**選型建議，而那個理由不是「我比較熟」。

---

## 9.2 這一章的量尺與模型

### 9.2.1 這一章不建新模型

09 章跑在 **`shop`** 這個庫上 —— 就是 01～08 章那五張表、那五個實體、那一個 `OrderService`。

```
customer / product / stock / orders / order_item     ← 07 站 1.12 的 schema
com.example.lab.shop                                 ← 01～06 章的成品
com.example.lab.shop.mybatis                         ← 07～08 章加的查詢側
```

**唯一的新表在 9.3.5**（軸五要一張「不是你設計的」老表），它們在另一個庫 `ch09`：

```sql
DROP DATABASE IF EXISTS ch09;
CREATE DATABASE ch09 DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE ch09;

-- ① 沒有主鍵的稽核表（十年老系統的典型）
CREATE TABLE legacy_log (
  ts       datetime     NOT NULL,
  actor    varchar(32)  NOT NULL,
  action   varchar(32)  NOT NULL,
  payload  text
) ENGINE=InnoDB;

-- ② 複合主鍵 + 縮寫欄位名 + Y/N 布林
CREATE TABLE legacy_code (
  cd_typ  char(4)     NOT NULL,
  cd_val  char(8)     NOT NULL,
  cd_nm   varchar(64) NOT NULL,
  use_yn  char(1)     NOT NULL DEFAULT 'Y',
  PRIMARY KEY (cd_typ, cd_val)
) ENGINE=InnoDB;

-- ③ 表名是 SQL 保留字
CREATE TABLE `order` (
  id   int          NOT NULL AUTO_INCREMENT,
  amt  varchar(20)  NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB;

-- ④ 一個欄位兩種語意：kind='N' → 數字；kind='D' → yyyyMMdd 的日期
CREATE TABLE legacy_flex (
  id    int         NOT NULL AUTO_INCREMENT,
  kind  char(1)     NOT NULL,
  val   varchar(40) NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB;

INSERT INTO legacy_log (ts, actor, action, payload) VALUES
  ('2026-09-01 08:00:00','u1','LOGIN','{}'),
  ('2026-09-01 08:00:00','u1','LOGIN','{}'),   -- ★ 完全重複的兩列（沒有主鍵擋得住）
  ('2026-09-01 09:30:00','u2','EXPORT','{"rows":120}');

INSERT INTO legacy_code (cd_typ, cd_val, cd_nm, use_yn) VALUES
  ('ORST','PENDING','待付款','Y'), ('ORST','PAID','已付款','Y'), ('ORST','OLD','舊狀態','N');

INSERT INTO `order` (amt) VALUES ('1200.50'), ('980');

INSERT INTO legacy_flex (kind, val) VALUES ('N','1200.50'), ('D','20260901'), ('N','0');
```

⚠️ **把這段 SQL 灌進容器的時候，client 的字元集要指定**：

```bash
# 🔴 這樣灌，'待付款' 會被存成雙重編碼（HEX 是 C3A8CB86… 而不是 E8888A…）
docker exec -i jpa-lab mysql -uroot -proot < ch09.sql

# ✅ 這樣才對
docker exec -i jpa-lab mysql -uroot -proot --default-character-set=utf8mb4 < ch09.sql
```

**這不是 MySQL 的錯，也不是這一章的重點**——
而它是**這一章第一個「兩個工具對同一份資料的解讀不一樣」的例子**，
而整個 9.6 就是這件事的放大版。

### 9.2.2 ★★ 第六把尺：配置了幾個位元組

08 章 8.12.3 那張表列了五把尺，而它們全部在數「幾次」：

| 尺 | 站在哪一層 | 數什麼 |
|---|---|---|
| `Dyn` | MyBatis 組完 SQL | 這組參數會產生什麼 SQL（不執行） |
| 攔截器 | `Executor` | statement 被呼叫幾次 |
| `SqlSpy` | JDBC | 應用程式呼叫了幾次 `execute()` |
| Hibernate `Statistics` | Hibernate 內部 | 建了幾個實體 |
| `MysqlStat` | 資料庫伺服器 | 伺服器剖析／執行了幾句 |

**而 05 章 5.8 那個「80 個實體 vs 0 個實體」，一直缺一個單位。**

```
「建了幾個實體」是 Hibernate 內部的計數器。
MyBatis 那一側永遠是 0 —— 而那不代表它沒有配置物件。
                              ↓
🔴 所以「實體數」這把尺【不能跨框架比較】。
   09 章要比較五種寫法，需要一把兩邊都適用、而且單位相同的尺。
```

**JVM 自己記著一個數字**：每一條執行緒從啟動到現在，在 heap 上配置過多少位元組。

```java
package com.example.lab.ch09;

import java.lang.management.ManagementFactory;

/**
 * ★★ 09 章的第六把尺：這段程式碼配置了幾個位元組。
 *
 * com.sun.management.ThreadMXBean.getThreadAllocatedBytes() 給的是
 * 【這條執行緒從啟動到現在，在 heap 上配置過的位元組總數】（不管有沒有被回收）。
 * 它是 JVM 自己記的累加值 —— 量它不需要 GC、不需要 profiler，誤差在幾百位元組。
 */
public final class Alloc {

    private static final com.sun.management.ThreadMXBean BEAN =
            (com.sun.management.ThreadMXBean) ManagementFactory.getThreadMXBean();

    private Alloc() {}

    public static boolean supported() { return BEAN.isThreadAllocatedMemorySupported(); }

    /** 這條執行緒到目前為止配置過的位元組總數。 */
    public static long now() { return BEAN.getCurrentThreadAllocatedBytes(); }

    /** 跑一次，回傳它配置了幾個位元組。 */
    public static long bytes(Runnable r) {
        long b0 = now();
        r.run();
        return now() - b0;
    }

    /** 暖機 warmup 次，再取 rounds 次裡的【最小值】（跟 bestMicros 同樣的取樣策略）。 */
    public static long bestBytes(Runnable r, int warmup, int rounds) {
        for (int i = 0; i < warmup; i++) r.run();
        long best = Long.MAX_VALUE;
        for (int i = 0; i < rounds; i++) best = Math.min(best, bytes(r));
        return best;
    }

    public static String kb(long bytes) { return String.format("%,.1f KB", bytes / 1024.0); }
    public static String mb(long bytes) { return String.format("%,.1f MB", bytes / (1024.0 * 1024.0)); }
}
```

⚠️ **三個使用注意**（它們每一個都在這一章咬過我一次）：

```
① 只量得到【呼叫它的那條執行緒】。
   → 連線池的背景執行緒、Hikari 的 housekeeper 都不算進來。
   → 9.4.2 的併發實測要自己把每一條執行緒的數字加起來（那一節沒有量配置，只量吞吐）。

② 第一次跑會把「類別載入 + 反射的 method handle + MyBatis 的 MappedStatement 快取」
   全部算進去 → 一定要暖機，而且暖機次數要夠。

③ 它量的是【配置】而不是【存活】。
   配置多不等於佔用多，而配置多一定會多花 GC 的成本 ——
   這在單執行緒的測試裡看不到，在有負載的機器上看得到。
```

📌 **這把尺回答的是一個 09 章才有意義的問題**：

> **「兩個框架跑同一頁，誰在記憶體上比較貴？」**
>
> 而它的答案（9.3.2）跟這一站前面八章給人的印象**相反**。

### 9.2.3 這一章的測試基底

```java
package com.example.lab.ch09;

import com.example.lab.SqlSpy;
import com.example.lab.Uuid7;
import com.example.lab.ch06.MysqlStat;
import jakarta.persistence.EntityManager;
import jakarta.persistence.EntityManagerFactory;
import org.hibernate.stat.Statistics;
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

/**
 * 09 章的測試基底。跑在 shop 這個庫上 —— 09 章不建新模型，
 * 它結的是 01～08 章那一組 shop-service 的帳。
 */
@SpringBootTest(properties = {
  "spring.datasource.url=jdbc:mysql://127.0.0.1:33306/shop?connectionTimeZone=UTC"
      + "&forceConnectionTimeZoneToSession=true&preserveInstants=true&characterEncoding=UTF-8",
  "spring.jpa.properties.hibernate.generate_statistics=true"
})
public abstract class Base09 {

    @Autowired protected EntityManager em;
    @Autowired protected EntityManagerFactory emf;
    @Autowired protected JdbcTemplate jdbc;
    @Autowired protected TransactionTemplate tx;
    @Autowired protected javax.sql.DataSource dataSource;

    protected MysqlStat stat;
    protected MysqlStat stat() { if (stat == null) stat = new MysqlStat(jdbc); return stat; }

    protected final List<UUID> customerIds = new ArrayList<>();
    protected final List<UUID> orderIds = new ArrayList<>();
    protected final List<UUID> productIds = new ArrayList<>();

    protected Statistics stats() { return emf.unwrap(org.hibernate.SessionFactory.class).getStatistics(); }

    /** 建了幾個實體（05 章 5.8 那把尺）。 */
    protected long entities(Runnable body) {
        Statistics s = stats();
        s.clear();
        body.run();
        return s.getEntityLoadCount();
    }

    protected void clean() {
        jdbc.update("DELETE FROM order_item");
        jdbc.update("DELETE FROM orders");
        jdbc.update("DELETE FROM stock");
        jdbc.update("DELETE FROM product");
        jdbc.update("DELETE FROM customer");
    }

    /**
     * 固定裝置：已經是這個大小就不重建，只把 id 讀回來。
     * ⚠️ 09 章有好幾個測試會【寫入】，所以每一個寫入型的測試要自己清掉它加的列。
     */
    protected void ensureSeed(int orderCount, int customerCount, int itemsPer) {
        Long n = jdbc.queryForObject("SELECT count(*) FROM orders", Long.class);
        if (n == null || n != (long) orderCount) { seed(orderCount, customerCount, itemsPer); return; }
        loadIds();
    }

    protected void loadIds() {
        customerIds.clear(); productIds.clear(); orderIds.clear();
        jdbc.query("SELECT id FROM customer ORDER BY email",
                rs -> { customerIds.add(Uuid7.fromBytes(rs.getBytes(1))); });
        jdbc.query("SELECT id FROM product ORDER BY sku",
                rs -> { productIds.add(Uuid7.fromBytes(rs.getBytes(1))); });
        jdbc.query("SELECT id FROM orders ORDER BY order_no",
                rs -> { orderIds.add(Uuid7.fromBytes(rs.getBytes(1))); });
    }

    /** 清掉某個 order_no 前綴的測試資料（連明細一起）。 */
    protected void dropOrders(String prefix) {
        jdbc.update("DELETE FROM order_item WHERE order_id IN"
                + " (SELECT id FROM orders WHERE order_no LIKE ?)", prefix + "%");
        jdbc.update("DELETE FROM orders WHERE order_no LIKE ?", prefix + "%");
    }

    /** 跟 08 章 N1Shop 同一份固定裝置：狀態四循環、每四張訂單換一個客戶。 */
    protected void seed(int orderCount, int customerCount, int itemsPer) {
        clean();
        customerIds.clear(); orderIds.clear(); productIds.clear();

        List<Object[]> cRows = new ArrayList<>();
        for (int i = 0; i < customerCount; i++) {
            UUID id = Uuid7.next(); customerIds.add(id);
            cRows.add(new Object[]{Uuid7.toBytes(id), "c" + i + "@x.com", "客戶" + i});
        }
        jdbc.batchUpdate("INSERT INTO customer (id,email,display_name) VALUES (?,?,?)", cRows);

        List<Object[]> pRows = new ArrayList<>(), sRows = new ArrayList<>();
        for (int i = 0; i < 3; i++) {
            UUID id = Uuid7.next(); productIds.add(id);
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
            UUID oid = Uuid7.next(); orderIds.add(oid);
            oRows.add(new Object[]{Uuid7.toBytes(oid), String.format("SO-%06d", i + 1),
                    Uuid7.toBytes(customerIds.get((i / 4) % customerCount)),
                    sts[i % 4], new BigDecimal((100 * Math.max(1, itemsPer) + i) + ".0000"),
                    java.sql.Timestamp.from(t0.plusSeconds(i * 60L))});
            for (int k = 0; k < itemsPer; k++)
                iRows.add(new Object[]{Uuid7.toBytes(Uuid7.next()), Uuid7.toBytes(oid),
                        Uuid7.toBytes(productIds.get((i + k) % 3)), "商品" + ((i + k) % 3),
                        new BigDecimal("100.0000"), 1, new BigDecimal("100.0000")});
        }
        jdbc.batchUpdate("INSERT INTO orders (id,order_no,customer_id,status,total_amount,placed_at)"
                + " VALUES (?,?,?,?,?,?)", oRows);
        if (!iRows.isEmpty())
            jdbc.batchUpdate("INSERT INTO order_item"
                    + " (id,order_id,product_id,product_name,unit_price,qty,line_amount)"
                    + " VALUES (?,?,?,?,?,?,?)", iRows);
    }

    protected void head(String t) { System.out.println("\n═══ " + t + " ═══"); }
    protected void sub(String t) { System.out.println("\n── " + t); }

    protected List<String> spy(Runnable body) {
        SqlSpy.start();
        try { body.run(); return SqlSpy.stop(); }
        catch (RuntimeException | Error e) { SqlSpy.stop(); throw e; }
    }

    protected void grouped(String title, List<String> sqls) {
        LinkedHashMap<String, Integer> m = new LinkedHashMap<>();
        for (String s : sqls) m.merge(s, 1, Integer::sum);
        System.out.println("── " + title + " → 共 " + sqls.size() + " 句，" + m.size() + " 種形狀");
        m.forEach((k, v) -> System.out.println("   ×" + v + "  " + cut(k, 150)));
    }

    protected static String cut(String s, int n) {
        String one = String.valueOf(s).replaceAll("\\s+", " ").trim();
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

    protected static Throwable root(Throwable t) {
        while (t != null && t.getCause() != null && t.getCause() != t) t = t.getCause();
        return t;
    }

    protected static String name(Throwable t) {
        if (t == null) return "沒有例外";
        Throwable r = root(t);
        return t.getClass().getSimpleName() + (r != t ? " ← " + r.getClass().getSimpleName() : "");
    }

    protected static String msg(Throwable t) {
        return t == null ? "（沒有例外）" : cut(String.valueOf(root(t).getMessage()), 160);
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

    protected long bestMs(Runnable r, int warmup, int rounds) {
        return bestMicros(r, warmup, rounds) / 1000;
    }
}
```

⚠️ **關於這一章所有的耗時數字，先講一件事**：

```
同一個測試在同一台機器上跑兩次，耗時可以差 1.5～2 倍
（本機 MySQL 的 buffer pool 狀態、JIT、其他程式在做什麼）。
                              ↓
所以這一章的數字：
   ① 全部來自【同一次完整執行】（out09/run-all.txt），內部一致
   ② 取的是 15 次裡的【最小值】（bestMicros）——
      最小值比平均值穩定，因為它濾掉了「剛好被打斷」的那幾次
   ③ 而【比值】比【絕對值】可信得多。
      這一章所有的結論都寫成比值或量級，沒有一句依賴「1572 µs」這個絕對數字。
```

---

### 9.2.4 這一章的混用 mapper

**9.4 之後的每一個實驗都要「同一件事、兩個框架各做一次」**，
所以 JPA 那一側用 `Ord9Repo`（9.3.1），MyBatis 那一側用下面這個 `Mix9Mapper`。

⚠️ **它刻意有寫入方法** —— 而 00 章 0.9 規則一說「一張表只讓一個框架寫」。
**這裡違反那條規則，是為了在 9.6.1 量出違反的後果。**

```java
package com.example.lab.ch09;

import com.example.lab.shop.OrderListRow;
import com.example.lab.shop.OrderStatus;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.session.ResultHandler;

import java.util.UUID;

/**
 * 09 章的混用實驗用 mapper。
 *
 * ⚠️ 它刻意【有寫入方法】—— 而 00 章 0.9 規則一說「一張表只讓一個框架寫」。
 *    這裡違反那條規則是為了量出違反的後果（9.6.4）。
 */
@Mapper
public interface Mix9Mapper {

    /** 9.4.4：一列一句查詢（「N+1 在 MyBatis 上長什麼樣」）。 */
    long countItems(@Param("orderId") UUID orderId);

    /** 9.6.2：MyBatis 這一側讀一列。 */
    OrderListRow oneRow(@Param("id") UUID id);

    String statusOf(@Param("id") UUID id);

    long versionOf(@Param("id") UUID id);

    /** 🔴 9.6.4 切法二的第一號地雷：旁路寫入，而且【不動 version】。 */
    int bypassStatus(@Param("id") UUID id, @Param("status") OrderStatus status);

    /** ✅ 修好的版本：自己維護 version（06 章 6.10.3 那條斷言要的東西）。 */
    int bypassStatusKeepingVersion(@Param("id") UUID id, @Param("status") OrderStatus status);

    /** 9.4.5：資料流式匯出（一列一列交給 handler，不整批進記憶體）。 */
    void streamRows(@Param("status") OrderStatus status, ResultHandler<OrderListRow> handler);

    /** 9.10.2：欄位名打錯 —— MyBatis 什麼時候告訴你。 */
    String badColumn();

    /**
     * 9.9.2 的對照組：「只改了一邊」的 searchRows。
     * 差別只有一個字：minAmount 用 &gt; 而不是 &gt;=。
     */
    java.util.List<OrderListRow> searchDrift(@Param("q") com.example.lab.shop.OrderSearchCriteria q,
                                             @Param("offset") int offset, @Param("size") int size);

    /** 9.6.5：同一個時間值，MyBatis 送到伺服器的是什麼。 */
    String fmtTime(@Param("t") Object t);

    /** 9.4.5：同一句，整批回傳（對照組）。 */
    java.util.List<OrderListRow> allRows(@Param("status") OrderStatus status);
}
```

**它的 XML（`src/main/resources/mapper/Mix9Mapper.xml`，整章共用）**：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN"
        "https://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="com.example.lab.ch09.Mix9Mapper">

  <select id="countItems" resultType="_long">
    SELECT count(*) FROM order_item WHERE order_id = #{orderId}
  </select>

  <select id="oneRow" resultMap="com.example.lab.shop.mybatis.OrderQueryMapper.listRowMap">
    SELECT o.id, o.order_no, c.display_name AS customer_name, o.status,
           o.total_amount, o.placed_at,
           (SELECT count(*) FROM order_item i WHERE i.order_id = o.id) AS item_count
      FROM orders o JOIN customer c ON c.id = o.customer_id
     WHERE o.id = #{id}
  </select>

  <select id="statusOf" resultType="string">
    SELECT status FROM orders WHERE id = #{id}
  </select>

  <select id="versionOf" resultType="_long">
    SELECT version FROM orders WHERE id = #{id}
  </select>

  <!-- 🔴 9.6.4：這一句是 00 章 0.3.5 那個事故的來源 -->
  <update id="bypassStatus">
    UPDATE orders SET status = #{status} WHERE id = #{id}
  </update>

  <!-- ✅ 修好的版本：把 version 的約定也遵守 -->
  <update id="bypassStatusKeepingVersion">
    UPDATE orders SET status = #{status}, version = version + 1 WHERE id = #{id}
  </update>

  <select id="badColumn" resultType="string">
    SELECT order_nu FROM orders LIMIT 1
  </select>

  <!-- 9.9.2：跟 OrderSearchMapper.search 只差一個字（&gt;= 變 &gt;） -->
  <select id="searchDrift" resultMap="com.example.lab.shop.mybatis.OrderQueryMapper.listRowMap">
    SELECT o.id, o.order_no, c.display_name AS customer_name, o.status,
           o.total_amount, o.placed_at,
           (SELECT count(*) FROM order_item i WHERE i.order_id = o.id) AS item_count
      FROM orders o JOIN customer c ON c.id = o.customer_id
    <where>
      <if test="q.status != null">          AND o.status = #{q.status}            </if>
      <if test="q.customerKeyword != null"> AND c.display_name LIKE #{q.likePattern} ESCAPE '!' </if>
      <if test="q.from != null">            AND o.placed_at &gt;= #{q.from}       </if>
      <if test="q.to != null">              AND o.placed_at &lt;= #{q.to}         </if>
      <if test="q.minAmount != null">       AND o.total_amount &gt; #{q.minAmount}</if>
    </where>
     ORDER BY o.placed_at DESC, o.id DESC
     LIMIT #{size} OFFSET #{offset}
  </select>

  <select id="fmtTime" resultType="string">
    SELECT date_format(#{t}, '%Y-%m-%d %H:%i:%s')
  </select>

  <select id="streamRows" resultMap="com.example.lab.shop.mybatis.OrderQueryMapper.listRowMap"
          fetchSize="-2147483648">
    SELECT o.id, o.order_no, c.display_name AS customer_name, o.status,
           o.total_amount, o.placed_at, 0 AS item_count
      FROM orders o JOIN customer c ON c.id = o.customer_id
     WHERE o.status = #{status}
     ORDER BY o.placed_at
  </select>

  <select id="allRows" resultMap="com.example.lab.shop.mybatis.OrderQueryMapper.listRowMap">
    SELECT o.id, o.order_no, c.display_name AS customer_name, o.status,
           o.total_amount, o.placed_at, 0 AS item_count
      FROM orders o JOIN customer c ON c.id = o.customer_id
     WHERE o.status = #{status}
     ORDER BY o.placed_at
  </select>
</mapper>
```

📌 **`resultMap` 直接引用 07 章那一份**（`com.example.lab.shop.mybatis.OrderQueryMapper.listRowMap`）——
`resultMap` 可以跨 namespace 引用，寫完整的 `namespace.id` 就行（08 章 8.7.3）。
**這一點是後面「兩個框架產出一字不差」的前提**：兩邊用的是同一份映射。

---

## 9.3 帳一：六條軸的結案 ★★

00 章 0.6.7 那張表是**這一站開始的時候**畫的：

| # | 軸 | JPA / Hibernate | MyBatis |
|---|---|---|---|
| 1 | 誰決定 SQL | 框架（你寫意圖） | **你** |
| 2 | 有沒有狀態 | **有** | 無 |
| 3 | 查詢的單位 | 實體 | 一句 SQL 的結果形狀 |
| 4 | 寫入時機 | flush 時 | 呼叫時 |
| 5 | 誰主導 schema | 可以 code first | 只能 database first |
| 6 | 換資料庫 | `Dialect` 自動處理 | 自己改 SQL |

**這一節把九章的實測填進去，而其中四格要改。**

### 9.3.1 軸一：「誰決定 SQL」不是 0 與 1，是三層

**08 章 8.6.8 那個 8 倍，是這一站最漂亮的一個實測**：
`(a, b) > (?, ?)` 在 MySQL 8.0.46 上是 `Filter`（掃 5000 列），
展開成 `a > ? OR (a = ? AND b > ?)` 才是 `Index range scan`（掃 19 列）。

**而 8.13 在給 09 章交待數字的時候，順手寫了一句**：

```
8.6.8  對最佳化器友善的等價寫法 → 2407 → 299 µs（8 倍，而 JPA 那一側做不到）
```

**這一節要驗證那句話。**

```java
package com.example.lab.ch09;

import com.example.lab.shop.Order;
import com.example.lab.shop.OrderListRow;
import com.example.lab.shop.OrderStatus;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * 09 章的實驗用 repository：跑在 shop 的 Order 實體上，
 * 但方法【只給 09 章的對照實驗用】—— 它不是 shop-service 的一部分。
 */
public interface Ord9Repo extends JpaRepository<Order, UUID> {

    /**
     * 9.3.1 ①：keyset 分頁的 OR 展開形式，用 JPQL 寫。
     * ★ 跟 08 章 8.10.4 那個 MyBatis 版【同一個語意、同一個投影】。
     */
    @Query("""
           select new com.example.lab.shop.OrderListRow(
                    o.id, o.orderNo, c.displayName, o.status, o.totalAmount, o.placedAt,
                    (select count(i) from OrderItem i where i.order = o))
             from Order o join o.customer c
            where o.status = :status
              and (o.placedAt < :lastAt
                   or (o.placedAt = :lastAt and o.id < :lastId))
            order by o.placedAt desc, o.id desc
           """)
    List<OrderListRow> keysetOr(@Param("status") OrderStatus status,
                                @Param("lastAt") Instant lastAt,
                                @Param("lastId") UUID lastId,
                                org.springframework.data.domain.Pageable page);

    /**
     * 9.3.1 ②：同一件事，寫成列建構子比較 —— JPQL 收不收？
     * ⚠️ 這個方法【預期在啟動時就爆】，所以它不能放在會被啟動的 repository 裡。
     *    改成在測試裡用 em.createQuery 現場問（P1Axis）。
     */

    /**
     * 9.3.1b：★★ 同一件事寫成【列建構子比較】—— JPQL 收得下，
     * 而 08 章 8.6.8 證明 MySQL 對它的處理慢 8 倍。
     */
    @Query("""
           select o.orderNo from Order o
            where o.status = :status
              and (o.placedAt, o.id) < (:lastAt, :lastId)
            order by o.placedAt desc, o.id desc
           """)
    List<String> keysetTuple(@Param("status") OrderStatus status,
                             @Param("lastAt") Instant lastAt,
                             @Param("lastId") UUID lastId,
                             org.springframework.data.domain.Pageable page);

    /** 9.3.1b：OR 展開形式，只回 orderNo（跟 keysetTuple 公平對照）。 */
    @Query("""
           select o.orderNo from Order o
            where o.status = :status
              and (o.placedAt < :lastAt or (o.placedAt = :lastAt and o.id < :lastId))
            order by o.placedAt desc, o.id desc
           """)
    List<String> keysetOrNo(@Param("status") OrderStatus status,
                            @Param("lastAt") Instant lastAt,
                            @Param("lastId") UUID lastId,
                            org.springframework.data.domain.Pageable page);

    /** 9.3.1 ③：原生 SQL 版 —— 想加 FORCE INDEX 只有這條路。 */
    @Query(nativeQuery = true, value = """
           SELECT o.order_no
             FROM orders o FORCE INDEX (idx_orders_status_placed)
            WHERE o.status = :status
              AND (o.placed_at < :lastAt
                   OR (o.placed_at = :lastAt AND o.id < :lastId))
            ORDER BY o.placed_at DESC, o.id DESC
            LIMIT :size
           """)
    List<String> keysetNative(@Param("status") String status,
                              @Param("lastAt") Instant lastAt,
                              @Param("lastId") byte[] lastId,
                              @Param("size") int size);

    @Query(nativeQuery = true, value = "SELECT o.order_no FROM orders o"
            + " WHERE o.status = :status ORDER BY o.placed_at DESC LIMIT :size")
    List<String> probeA(@Param("status") String status, @Param("size") int size);

    @Query(nativeQuery = true, value = "SELECT o.order_no FROM orders o"
            + " WHERE o.status = :status AND o.placed_at < :lastAt"
            + " ORDER BY o.placed_at DESC LIMIT :size")
    List<String> probeB(@Param("status") String status,
                        @Param("lastAt") java.time.LocalDateTime lastAt,
                        @Param("size") int size);

    @Query(nativeQuery = true, value = "SELECT o.order_no FROM orders o"
            + " WHERE o.status = :status AND o.placed_at < :lastAt"
            + " ORDER BY o.placed_at DESC LIMIT :size")
    List<String> probeB2(@Param("status") String status,
                         @Param("lastAt") Instant lastAt,
                         @Param("size") int size);

    @Query(nativeQuery = true, value = "SELECT o.order_no FROM orders o"
            + " WHERE o.status = :status AND o.placed_at < :lastAt"
            + " ORDER BY o.placed_at DESC LIMIT :size")
    List<String> probeB3(@Param("status") String status,
                         @Param("lastAt") java.sql.Timestamp lastAt,
                         @Param("size") int size);

    @Query(nativeQuery = true, value = "SELECT o.order_no FROM orders o"
            + " WHERE o.status = :status AND o.id < :lastId"
            + " ORDER BY o.placed_at DESC LIMIT :size")
    List<String> probeC(@Param("status") String status,
                        @Param("lastId") byte[] lastId,
                        @Param("size") int size);
}
```

```java
    @Test
    void a1_軸一_誰決定SQL_三層而不是兩層() {
        head("9.3.1 軸一：JPA 那一側「接管 SQL」有三層");

        var row = jdbc.queryForList("SELECT placed_at, id FROM orders WHERE status = 'PENDING'"
                + " ORDER BY placed_at DESC, id DESC LIMIT 1 OFFSET 30").get(0);
        LocalDateTime rawAt = (LocalDateTime) row.get("placed_at");
        byte[] rawId = (byte[]) row.get("id");
        Instant at = rawAt.toInstant(ZoneOffset.UTC);
        UUID id = Uuid7.fromBytes(rawId);

        sub("① 第一層：你寫意圖（JPQL），SQL 由 Hibernate 決定");
        var sqls = spy(() -> ord9.keysetOr(OrderStatus.PENDING, at, id, PageRequest.of(0, 5)));
        System.out.println("   JPQL 的 keyset 條件 → " + cut(sqls.get(0), 300));

        sub("★★ 08 章 8.13 說「那個 8 倍的等價寫法 JPA 那一側做不到」—— 對嗎");
        List<OrderListRow> jpaRows = ord9.keysetOr(OrderStatus.PENDING, at, id, PageRequest.of(0, 5));
        List<OrderListRow> myRows = search.pageAfter(OrderStatus.PENDING, at, id, 5);
        System.out.println("   JPQL    : " + jpaRows.stream().map(OrderListRow::orderNo).toList());
        System.out.println("   MyBatis : " + myRows.stream().map(OrderListRow::orderNo).toList());

        sub("② 第二層：想加索引提示 —— JPQL 收得下嗎");
        Throwable t1 = catchingTx(() -> em.createQuery(
                "select o.orderNo from Order o force index (idx_orders_status_placed)", String.class)
                .setMaxResults(1).getResultList());
        System.out.println("   JPQL 裡寫 force index → " + name(t1));

        sub("★ 而 JPQL 收下了列建構子比較 —— 它翻譯成什麼");
        tx.executeWithoutResult(s -> {
            var q = em.createQuery(
                    "select o.orderNo from Order o where o.status = :st"
                    + " and (o.placedAt, o.id) < (:a, :b) order by o.placedAt desc, o.id desc",
                    String.class)
                    .setParameter("st", OrderStatus.PENDING)
                    .setParameter("a", at).setParameter("b", id).setMaxResults(5);
            System.out.println("   " + cut(spy(q::getResultList).get(0), 260));
        });

        sub("③ Hibernate 的 addQueryHint —— 在 MySQL 上它是什麼");
        // …（兩次：一次傳最佳化器提示、一次傳索引名）

        sub("④ 第三層：原生 SQL —— FORCE INDEX 只有這條路");
        var nat = spy(() -> ord9.keysetNative("PENDING", at, rawId, 5));
        System.out.println("   " + cut(nat.get(0), 220));
    }
```

```
═══ 9.3.1 軸一：JPA 那一側「接管 SQL」有三層 ═══

── ① 第一層：你寫意圖（JPQL），SQL 由 Hibernate 決定
   JPQL 的 keyset 條件 → select o1_0.id,o1_0.order_no,c1_0.display_name,o1_0.status,
        o1_0.total_amount,o1_0.placed_at,(select count(oi1_0.id) from order_item oi1_0
        where oi1_0.order_id=o1_0.id) from orders o1_0 join customer c1_0
        on c1_0.id=o1_0.customer_id where o1_0.status=?
        and (o1_0.placed_at<? or (o1_0.placed_at=? and o…

── ★★ 08 章 8.13 說「那個 8 倍的等價寫法 JPA 那一側做不到」—— 對嗎
   JPQL    : [SO-000073, SO-000069, SO-000065, SO-000061, SO-000057]
   MyBatis : [SO-000073, SO-000069, SO-000065, SO-000061, SO-000057]
   JPQL    耗時 966 µs
   MyBatis 耗時 985 µs

── ② 第二層：想加索引提示 —— JPQL 收得下嗎
   JPQL 裡寫 force index → IllegalArgumentException ← SyntaxException
   At 1:30 and token 'force', mismatched input 'force', expecting one of the following
   tokens: <EOF>, ',', CROSS, FULL, GROUP, INNER, JOIN, LEFT, ORDER, OUTER, RIG…

── ★ 而 JPQL 收下了列建構子比較 —— 它翻譯成什麼
   select o1_0.order_no from orders o1_0 where o1_0.status=?
     and (o1_0.placed_at,o1_0.id)<(?,?) order by o1_0.placed_at desc,o1_0.id desc limit ?
   拿到 [SO-000073, SO-000069, SO-000065, SO-000061, SO-000057]（跟 ① 一樣嗎）

── ③ Hibernate 的 addQueryHint —— 在 MySQL 上它是什麼
   🔴 addQueryHint("MAX_EXECUTION_TIME(2000)") → SQLGrammarException ← SQLSyntaxErrorException
   You have an error in your SQL syntax; … near '(2000)) where o1_0.status='PENDING' limit 3'
   ✅ addQueryHint("idx_orders_status_placed") →
      select o1_0.order_no from orders o1_0 use index (idx_orders_status_placed)
       where o1_0.status=? limit ?

── ③b JPA 標準的 @QueryHint（org.hibernate.comment）加在哪裡
   select o1_0.order_no from orders o1_0 where o1_0.status=? limit ?

── ④ 第三層：原生 SQL —— FORCE INDEX 只有這條路
   SELECT o.order_no FROM orders o FORCE INDEX (idx_orders_status_placed)
    WHERE o.status = ? AND (o.placed_at < ? OR (o.placed_at = ? AND o.id < ?))
    ORDER BY o.placed_at DESC, o.id DESC LIMIT ?
   拿到 [SO-000073, SO-000069, SO-000065, SO-000061, SO-000057]
```

**五個發現，一個一個講**：

**① JPQL 寫得出那個 OR 形式，而且 SQL 一字不差。**

```
JPQL：  and (o.placedAt < :lastAt or (o.placedAt = :lastAt and o.id < :lastId))
SQL ：  and (o1_0.placed_at<?  or (o1_0.placed_at=?  and o1_0.id<?))
                              ↓
🔴 所以 08 章 8.13 那句「JPA 那一側做不到」是【錯的】。
   8.6.8 本文的說法（「得用 Criteria 手動組三層 Predicate，或者直接 nativeQuery」）
   也偏保守 —— 一個 @Query 字串就夠了。
```

**② ★ 而 JPQL 也寫得出【慢的那一種】—— 這比 ① 重要。**

```
「(o.placedAt, o.id) < (:a, :b)」
   → JPQL 完全收得下（Jakarta Persistence 3.1 的文法裡有 comparison_expression 的元組形式）
   → Hibernate 原封不動翻成 (o1_0.placed_at,o1_0.id)<(?,?)
   → 也就是 08 章 8.6.8 那個【慢 8 倍】的形狀
                              ↓
📌 危險是【對稱】的。
   「教科書上的 keyset 寫法」在 JPA 這一側一樣寫得出來、一樣慢，
   而 JPA 這一側【更難發現】—— 因為你看的是 JPQL，不是 SQL。
```

**③ 🔴 `addQueryHint` 在 MySQL 上不是「最佳化器提示」，是 `USE INDEX`。**

Hibernate 的 `Dialect.getQueryHintString()` 每一家資料庫實作不一樣：

```
Oracle       → /*+ hint */（真的最佳化器提示）
MySQLDialect → use index (…)          ← ★ 它把你傳的字串當【索引名】
                              ↓
所以 addQueryHint("MAX_EXECUTION_TIME(2000)") 產生
     select … from orders o1_0  use index (MAX_EXECUTION_TIME(2000)) where …
     → MySQL 語法錯誤 1064
而 addQueryHint("idx_orders_status_placed") 產生
     select … from orders o1_0 use index (idx_orders_status_placed) where …
     → ✅ 合法，而且它就是一個索引提示
```

⚠️ **`USE INDEX` 與 `FORCE INDEX` 不一樣**：
`USE INDEX` 是「建議」（最佳化器可以不聽，尤其是它覺得全表掃比較便宜的時候），
`FORCE INDEX` 是「除非不能用，否則一定用」。
**Hibernate 只給你前者。**

**④ 🔴 而 JPA 標準的 `@QueryHint("org.hibernate.comment")` 在這個組態下完全沒出現。**

```
setHint("org.hibernate.comment", "+ MAX_EXECUTION_TIME(2000)")
   → 產生的 SQL 裡【一個字都沒有】
                              ↓
理由：那個 hint 要 hibernate.use_sql_comments=true 才會被寫進 SQL。
      而它「沒生效」的時候【不報錯】—— 06 章 6.7.6 那個
      「timeout=3000 被靜默忽略」是同一個形狀。
      更何況它加在【整句的前面】（/* comment */ select …），
      而 MySQL 的最佳化器提示必須緊跟在 SELECT 後面 —— 位置不對，本來就不會生效。
```

**⑤ 所以軸一要改寫成三層**：

| 層 | JPA 這一側怎麼做 | 你放棄了什麼 | 什麼時候用 |
|---|---|---|---|
| **① 意圖** | JPQL / Criteria | SQL 的形狀由 Hibernate 決定 | 95% 的查詢 |
| **② 提示** | `unwrap(Query).addQueryHint("索引名")` → `USE INDEX` | 只有 `USE INDEX`，而且是 Hibernate 專屬 API | 最佳化器選錯索引 |
| **③ 接管** | `@Query(nativeQuery = true)` | 型別安全、`Dialect`、投影的便利 | 需要 `FORCE INDEX` / 廠商語法 |

📌 **而 MyBatis 只有一層 —— 第三層。**

```
這不是「MyBatis 比較差」，是【它就是那一層】。
軸一真正的差別不是「誰決定」，是：
                              ↓
   JPA   ：預設在第一層，而你【可以】往下走（代價是那一句失去型別安全）
   MyBatis：永遠在第三層，而你【不能】往上走（沒有「寫意圖」這個選項）
```

### 9.3.1b ★★ 實測：把 8.6.8 那個 8 倍在 JPA 側再做一次

9.3.1 用的是 200 張訂單的固定裝置，**兩種寫法都很快（966 / 985 µs）看不出差別**。
**8.6.8 那個 8 倍需要「游標在很深的地方」** —— 所以這一節重建 08 章那個資料量：
**20000 張訂單，其中 5000 張 `PENDING`，游標放在 DESC 方向的第 4981 筆。**

```java
package com.example.lab.ch09;

import com.example.lab.Uuid7;
import com.example.lab.shop.OrderStatus;
import com.example.lab.shop.mybatis.OrderSearchMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.PageRequest;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.UUID;

/**
 * 9.3.1b：把 08 章 8.6.8 那個 8 倍的實驗【在 JPA 那一側再做一次】。
 * 8.13 說「JPA 那一側做不到」—— 這一節要驗證那句話。
 * 資料量刻意跟 8.6.8 一樣（20000 張訂單，其中 5000 張 PENDING）。
 */
class P1bKeyset extends Base09 {

    @Autowired Ord9Repo ord9;
    @Autowired OrderSearchMapper search;

    @Test
    void a1b_兩種keyset寫法_兩個框架() {
        if (jdbc.queryForObject("SELECT count(*) FROM orders", Long.class) != 20000L) {
            System.out.println("（重建固定裝置：20000 張訂單、每張 1 筆明細）");
            seed(20000, 50, 1);
        }
        head("9.3.1b 08 章 8.6.8 的 8 倍，在 JPA 那一側");

        var row = jdbc.queryForList("SELECT placed_at, id FROM orders WHERE status = 'PENDING'"
                + " ORDER BY placed_at DESC, id DESC LIMIT 1 OFFSET 4980").get(0);
        LocalDateTime rawAt = (LocalDateTime) row.get("placed_at");
        byte[] rawId = (byte[]) row.get("id");
        Instant at = rawAt.toInstant(ZoneOffset.UTC);
        UUID id = Uuid7.fromBytes(rawId);
        System.out.println("  游標（DESC 方向的第 4981 筆，跟 8.6.8 同一個深度）= " + rawAt + " / " + id);
        System.out.println("  PENDING 共 " + jdbc.queryForObject(
                "SELECT count(*) FROM orders WHERE status = 'PENDING'", Long.class) + " 筆");

        sub("① JPQL + 列建構子比較 (a, b) < (?, ?)");
        System.out.println("   " + cut(spy(() -> ord9.keysetTuple(OrderStatus.PENDING, at, id,
                PageRequest.of(0, 20))).get(0), 200));
        System.out.printf("   耗時 %d µs、拿到 %d 筆%n",
                bestMicros(() -> ord9.keysetTuple(OrderStatus.PENDING, at, id, PageRequest.of(0, 20)), 3, 9),
                ord9.keysetTuple(OrderStatus.PENDING, at, id, PageRequest.of(0, 20)).size());

        sub("② JPQL + 展開成 OR");
        System.out.println("   " + cut(spy(() -> ord9.keysetOrNo(OrderStatus.PENDING, at, id,
                PageRequest.of(0, 20))).get(0), 200));
        System.out.printf("   耗時 %d µs、拿到 %d 筆%n",
                bestMicros(() -> ord9.keysetOrNo(OrderStatus.PENDING, at, id, PageRequest.of(0, 20)), 3, 9),
                ord9.keysetOrNo(OrderStatus.PENDING, at, id, PageRequest.of(0, 20)).size());

        sub("③ MyBatis 的正式版（08 章 8.10.4，OR 形式 + 投影）");
        System.out.printf("   耗時 %d µs、拿到 %d 筆%n",
                bestMicros(() -> search.pageAfter(OrderStatus.PENDING, at, id, 20), 3, 9),
                search.pageAfter(OrderStatus.PENDING, at, id, 20).size());

        sub("③b JPA 那一側的【同一個投影】（join + 子查詢，跟 MyBatis 公平對照）");
        System.out.printf("   耗時 %d µs、拿到 %d 筆%n",
                bestMicros(() -> ord9.keysetOr(OrderStatus.PENDING, at, id, PageRequest.of(0, 20)), 3, 9),
                ord9.keysetOr(OrderStatus.PENDING, at, id, PageRequest.of(0, 20)).size());
        System.out.println("   " + cut(spy(() -> ord9.keysetOr(OrderStatus.PENDING, at, id,
                PageRequest.of(0, 20))).get(0), 260));

        sub("③c 那 17 ms 是哪裡來的 —— 問 MySQL");
        plan("SELECT o.id, o.order_no, c.display_name, o.status, o.total_amount, o.placed_at,"
                + " (SELECT count(*) FROM order_item i WHERE i.order_id = o.id) AS item_count"
                + " FROM orders o JOIN customer c ON c.id = o.customer_id"
                + " WHERE o.status = 'PENDING' AND (o.placed_at < ?"
                + " OR (o.placed_at = ? AND o.id < ?))"
                + " ORDER BY o.placed_at DESC, o.id DESC LIMIT 20", rawAt, rawAt, rawId);

        sub("④ 三種寫法的結果一樣嗎");
        System.out.println("   ① " + ord9.keysetTuple(OrderStatus.PENDING, at, id, PageRequest.of(0, 5)));
        System.out.println("   ② " + ord9.keysetOrNo(OrderStatus.PENDING, at, id, PageRequest.of(0, 5)));
        System.out.println("   ③ " + search.pageAfter(OrderStatus.PENDING, at, id, 5)
                .stream().map(com.example.lab.shop.OrderListRow::orderNo).toList());

        sub("⑤ 問資料庫：JPQL 產出的那兩句，執行計畫是什麼");
        String tupleSql = "SELECT o.order_no FROM orders o WHERE o.status = 'PENDING'"
                + " AND (o.placed_at, o.id) < (?, ?) ORDER BY o.placed_at DESC, o.id DESC LIMIT 20";
        String orSql = "SELECT o.order_no FROM orders o WHERE o.status = 'PENDING'"
                + " AND (o.placed_at < ? OR (o.placed_at = ? AND o.id < ?))"
                + " ORDER BY o.placed_at DESC, o.id DESC LIMIT 20";
        System.out.println("   ① 列建構子：");
        plan(tupleSql, rawAt, rawId);
        System.out.println("   ② 展開成 OR：");
        plan(orSql, rawAt, rawAt, rawId);
    }

    private void plan(String sql, Object... args) {
        for (String line : jdbc.query("EXPLAIN ANALYZE " + sql, (rs, i) -> rs.getString(1), args))
            System.out.println("     " + line.replace("\n", "\n     "));
    }
}
```

Repository 那兩個方法（**除了條件的形狀，其他一模一樣**）：

```java
    /** 9.3.1b：★★ 同一件事寫成【列建構子比較】。 */
    @Query("""
           select o.orderNo from Order o
            where o.status = :status
              and (o.placedAt, o.id) < (:lastAt, :lastId)
            order by o.placedAt desc, o.id desc
           """)
    List<String> keysetTuple(@Param("status") OrderStatus status,
                             @Param("lastAt") Instant lastAt,
                             @Param("lastId") UUID lastId, Pageable page);

    /** 9.3.1b：OR 展開形式，只回 orderNo（跟 keysetTuple 公平對照）。 */
    @Query("""
           select o.orderNo from Order o
            where o.status = :status
              and (o.placedAt < :lastAt or (o.placedAt = :lastAt and o.id < :lastId))
            order by o.placedAt desc, o.id desc
           """)
    List<String> keysetOrNo(@Param("status") OrderStatus status,
                            @Param("lastAt") Instant lastAt,
                            @Param("lastId") UUID lastId, Pageable page);
```

```
═══ 9.3.1b 08 章 8.6.8 的 8 倍，在 JPA 那一側 ═══
  游標（DESC 方向的第 4981 筆，跟 8.6.8 同一個深度）= 2026-09-01T01:16 / 01a08436-652a-…
  PENDING 共 5000 筆

── ① JPQL + 列建構子比較 (a, b) < (?, ?)
   select o1_0.order_no from orders o1_0 where o1_0.status=?
     and (o1_0.placed_at,o1_0.id)<(?,?) order by o1_0.placed_at desc,o1_0.id desc limit ?,?
   耗時 3557 µs、拿到 19 筆

── ② JPQL + 展開成 OR
   select o1_0.order_no from orders o1_0 where o1_0.status=?
     and (o1_0.placed_at<? or (o1_0.placed_at=? and o1_0.id<?))
     order by o1_0.placed_at desc,o1_0.id desc limit ?,?
   耗時 930 µs、拿到 19 筆

── ③ MyBatis 的正式版（08 章 8.10.4，OR 形式 + 投影）
   耗時 3308 µs、拿到 19 筆

── ③b JPA 那一側的【同一個投影】（join + 子查詢，跟 MyBatis 公平對照）
   耗時 3054 µs、拿到 19 筆

── ③c 那 3 ms 是哪裡來的 —— 問 MySQL
     -> Limit: 20 row(s)  (actual time=2.04..2.04 rows=19 loops=1)
         -> Sort: o.placed_at DESC, o.id DESC, limit input to 20 row(s) per chunk
             -> Stream results  (cost=22.8 rows=2.5) (actual time=0.0709..2 rows=19 loops=1)
                 -> Nested loop inner join  (cost=22.8 rows=2.5)
                     -> Table scan on c  (cost=5.25 rows=50) (actual … rows=50 loops=1)
                     -> Filter: (o.`status` = 'PENDING')  (cost=0.25 rows=0.05)
                         -> Index lookup on o using idx_orders_customer_placed
                            (customer_id=c.id), with index condition: (…)
                            (actual time=0.0385..0.0387 rows=1.52 loops=50)

── ④ 三種寫法的結果一樣嗎
   ① [SO-000073, SO-000069, SO-000065, SO-000061, SO-000057]
   ② [SO-000073, SO-000069, SO-000065, SO-000061, SO-000057]
   ③ [SO-000073, SO-000069, SO-000065, SO-000061, SO-000057]

── ⑤ 問資料庫：JPQL 產出的那兩句，執行計畫是什麼
   ① 列建構子：
     -> Limit: 20 row(s)  (cost=1121 rows=20) (actual time=3.06..3.06 rows=19 loops=1)
         -> Filter: ((o.placed_at,o.id) < ('2026-09-01 01:16:00',0x01a08436652a…))
            (cost=1121 rows=9044) (actual time=3.06..3.06 rows=19 loops=1)
             -> Index lookup on o using idx_orders_status_placed (status='PENDING')
                (reverse) (actual time=0.223..2.8 rows=5000 loops=1)
   ② 展開成 OR：
     -> Limit: 20 row(s)  (cost=9.51 rows=20) (actual time=0.0147..0.0195 rows=19 loops=1)
         -> Index range scan on o using idx_orders_status_placed
            over (status = 'PENDING' AND placed_at < '2026-09-01 01:16:00.000')
              OR (status = 'PENDING' AND placed_at = '2026-09-01 01:16:00.000'
                  AND id < 0x01a08436652a…) (reverse), with index condition: (…)
            (cost=9.51 rows=20) (actual time=0.0143..0.0184 rows=19 loops=1)
```

★★ **結論一：08 章那個 8 倍，在 JPA 這一側是 3.8 倍，而機制完全一樣。**

| | JPQL 列建構子 | JPQL 展開成 OR |
|---|---|---|
| 執行計畫 | **`Filter`** | **`Index range scan`** |
| 實際讀了幾列 | **5000** | **20** |
| 耗時 | 3557 µs | **930 µs** |

```
📌 所以那句話要改成：
   🔴 舊：「對最佳化器友善的等價寫法，只有寫 SQL 的人做得到」
   ✅ 新：「對最佳化器友善的等價寫法，【兩邊都做得到】——
          而它需要的是【有人去看執行計畫】，不是某一個框架。」
```

★★ **結論二（這一節的意外收穫）：那個 join 把索引優勢吃掉了。**

```
① 單表、只取 order_no：       OR 形式 930 µs（Index range scan，20 列）
③ 加上 JOIN customer + 子查詢：JPA 3054 µs、MyBatis 3308 µs
                              ↓
③c 的執行計畫說了原因：
   MySQL 換計畫了 —— 它不再用 idx_orders_status_placed 做範圍掃描，
   改成【從 customer 全表掃 50 列，對每一列去 orders 查 idx_orders_customer_placed】，
   然後 Sort。
                              ↓
🔴 也就是說：08 章 8.10.4 那個「keyset 第 200 頁 1308 µs」的優勢，
   在客戶數變多、資料量變大之後【可能整個消失】，而它跟框架無關。
```

⚠️ **這件事的教訓不是「keyset 沒用」**，而是：

> **keyset 分頁的優勢在「單表的那一段」。**
> **一旦 JOIN 進來，最佳化器可能換一個完全不同的計畫 ——**
> **所以「keyset 比 offset 快」這句話，要在【你的資料量與你的 JOIN】上重新量一次。**

（想修好它有兩條路：把 keyset 的那一段做成子查詢先取 20 個 id、再 JOIN 回去撈欄位；
或者接受 3 ms。**而兩條路兩個框架都走得通。**）

### 9.3.2 ★★ 軸二：有沒有狀態 —— 第六把尺的第一次出場

**軸二是這一站最根本的一條**（00 章 0.6.7 說「如果只能記一件事，記②」）。
**而它一直缺一個共同的單位。**

```java
    @Test
    void a2_軸二_第六把尺_同一頁五種寫法() {
        head("9.3.2 軸二：同一頁五種寫法 —— 第六把尺（配置了幾個位元組）");
        System.out.println("  getThreadAllocatedBytes 支援 = " + Alloc.supported());

        record Way(String name, Supplier<List<OrderListRow>> run) {}
        List<Way> ways = List.of(
                new Way("JPA 實體 + DTO 轉換", () -> tx.execute(s ->
                        orders.listAsEntities(OrderStatus.PENDING, 0, 20)      // 04 章那一版
                                .stream().map(v -> new OrderListRow(v.id(), v.orderNo(),
                                        v.customerName(), v.status(), v.totalAmount(),
                                        v.placedAt(), v.lines().size())).toList())),
                new Way("JPA 投影（05 章 5.14）", () -> tx.execute(s ->
                        orders.list(OrderStatus.PENDING, 0, 20))),
                new Way("MyBatis（07 章 7.15）", () -> tx.execute(s ->
                        query.listRows(OrderStatus.PENDING, 0, 20))),
                new Way("JdbcTemplate", () -> jdbcRows.listRows(OrderStatus.PENDING, 0, 20)),
                new Way("純 JDBC", () -> plainRows.listRows(OrderStatus.PENDING, 0, 20)),
                new Way("jOOQ（無 codegen）", () -> jooq.listRows(OrderStatus.PENDING, 0, 20)));

        for (Way w : ways) {
            int sqlCount = spy(() -> w.run().get()).size();
            long ents = entities(() -> w.run().get());
            long us = bestMicros(() -> w.run().get(), 5, 15);
            long bytes = Alloc.bestBytes(() -> w.run().get(), 5, 15);
            System.out.printf("  %-24s %4d 句 %6d 個 %8d µs %12s%n",
                    w.name(), sqlCount, ents, us, Alloc.kb(bytes));
        }
    }
```

```
═══ 9.3.2 軸二：同一頁五種寫法 —— 第六把尺（配置了幾個位元組） ═══
  getThreadAllocatedBytes 支援 = true

  寫法                          SQL       實體         耗時           配置
  JPA 實體 + DTO 轉換             3 句     90 個     5859 µs     400.0 KB
  JPA 投影（05 章 5.14）           2 句      0 個     1598 µs      83.1 KB
  MyBatis（07 章 7.15）          1 句      0 個     1164 µs     115.0 KB
  JdbcTemplate                1 句      0 個      449 µs      40.2 KB
  純 JDBC                      1 句      0 個      451 µs      36.2 KB
  jOOQ（無 codegen）             1 句      0 個      713 µs     103.8 KB

── 六種寫法的第一列一樣嗎
  JPA 實體 + DTO 轉換          SO-000197 / 客戶9 / PENDING / 496.0000 / 3
  JPA 投影（05 章 5.14）        SO-000197 / 客戶9 / PENDING / 496.0000 / 3
  MyBatis（07 章 7.15）       SO-000197 / 客戶9 / PENDING / 496.0000 / 3
  JdbcTemplate             SO-000197 / 客戶9 / PENDING / 496.0000 / 3
  純 JDBC                   SO-000197 / 客戶9 / PENDING / 496.0000 / 3
  jOOQ（無 codegen）          SO-000197 / 客戶9 / PENDING / 496.0000 / 3
```

**三個發現**：

**① ★★「0 個實體」不等於「配置比較少」。**

```
JPA 投影   0 個實體、 83.1 KB
MyBatis   0 個實體、115.0 KB   ← 多 38%
                              ↓
🔴 這跟這一站前面八章給人的印象【相反】。
   05 章 5.8 那個「650 個實體 → 0 個」很容易被讀成
   「MyBatis 在記憶體上比較省」—— 而實測不是。
```

**為什麼 MyBatis 配置比較多？** 三件事加起來：

```
① 它一列一列走 ResultSetHandler，每一列都建一個 MetaObject / ResultLoaderMap 之類的中介物件
② record 的建構子是【反射】呼叫的（07 章 7.8.3 的 <constructor>）
③ 一級快取要把每一列的結果與 CacheKey 存起來（07 章 7.11）—— 而這一頁根本不會再讀
                              ↓
而 Hibernate 那一側，投影查詢走的是「編譯過的 row transformer」：
   它在第一次執行的時候把「這一列的七個欄位 → OrderListRow 的建構子」編譯成一個
   固定的取值序列，之後每一列只做那七次 getXxx。
```

**② 而「實體」的成本，第六把尺量出來的形狀跟句數不一樣。**

```
「幾句 SQL」：3 句 → 2 句 → 1 句     （04 → 05 → 07 章，一路往下）
「幾個實體」：90 個 → 0 個            （05 章那一刀）
「幾個位元組」：400 KB → 83 KB → 36 KB ← ★ 它一路降到「純 JDBC」才停
                              ↓
📌 前兩把尺在 MyBatis 那一格就到底了（1 句、0 個），
   而第六把尺告訴你【還有 3 倍的空間】，那就是 9.10 要處理的事。
```

**③ 90 個實體 = 400 KB，一個實體大約 4.4 KB。**

```
一頁 20 筆的列表頁，只顯示 6 個欄位：
   20 張訂單 + 10 個客戶 + 60 筆明細 = 90 個實體
   而它們加起來的【配置】是 400 KB —— 顯示出去的資料大概 3 KB。
                              ↓
📌 這就是 05 章 5.8 那一節的「換一個單位」的版本：
   「為了 6 個欄位建 90 個有狀態的物件」= 為了 3 KB 配置 400 KB。
```

⚠️ **這把尺的極限也要講清楚**：

```
它量【配置】，不量【存活】。
   400 KB 裡有多少在交易結束之後還活著？—— 這把尺答不出來。
   而那個問題（實體活多久）在 03 章已經有答案：活到持久化情境結束。
                              ↓
所以第六把尺的正確用法是：
   ✅「同一件事，兩種寫法，誰配置得多」（相對值）
   🔴「這支 API 會用多少記憶體」（絕對值 —— 那要 heap dump，不是這把尺）
```

### 9.3.3 🔴 軸三：報表真的只能 MyBatis 嗎

**00 章 0.8.1 那張表的場景 D 寫著**：

| 場景 | JPA | MyBatis | 誰佔優勢 |
|---|---|---|---|
| **D 報表**（`GROUP BY` + `HAVING` + 相關子查詢） | JPQL 做得到，但回 `Object[]` 或要寫 DTO 投影 | 1 句 SQL + 1 個 Row 類別，**形狀完全自由** | ✅ **MyBatis** |

**而 07 章 7.15.4 落地的那兩份報表，用的是 JPQL 規格裡沒有的東西**：

```
salesRanking：CTE（WITH）+ RANK() OVER + SUM() OVER + ROUND
statusPivot ：DATE_FORMAT + SUM(status = 'PAID') 這種布林算術
```

**05 章 5.4.8 已經量過「HQL 有這些東西」。這一節把兩份報表整份搬過去。**

```java
    @Test @Transactional
    void a3_軸三_報表可以用HQL寫嗎() {
        head("9.3.3 軸三：00 章 0.8.1 場景 D 說「報表 → MyBatis」。那 JPA 做不到嗎");

        Instant from = Instant.parse("2026-09-01T00:00:00Z");
        Instant to   = Instant.parse("2026-12-01T00:00:00Z");

        sub("① MyBatis 版（07 章 7.15.4）：CTE + RANK() OVER + SUM() OVER");
        List<CustomerSalesRow> mb = query.salesRanking(from, to);

        sub("② 同一份報表，用 HQL 寫");
        String hql = """
                with per_customer as (
                  select c.id as cid, c.displayName as cname,
                         count(o.id) as cnt, sum(o.totalAmount) as amt
                    from Order o join o.customer c
                   where o.placedAt >= :from and o.placedAt < :to
                     and o.status <> com.example.lab.shop.OrderStatus.CANCELLED
                   group by c.id, c.displayName
                )
                select new com.example.lab.shop.mybatis.CustomerSalesRow(
                         p.cid, p.cname, p.cnt, p.amt,
                         cast(rank() over (order by p.amt desc) as long),
                         cast(round(100 * p.amt / sum(p.amt) over (), 2) as big_decimal))
                  from per_customer p
                 order by p.amt desc
                """;
        List<CustomerSalesRow> jpa = em.createQuery(hql, CustomerSalesRow.class)
                .setParameter("from", from).setParameter("to", to).getResultList();
        System.out.println("   第一列一字不差嗎 = " + mb.get(0).equals(jpa.get(0)));
        System.out.println("   全部一字不差嗎   = " + mb.equals(jpa));

        sub("③ 樞紐表：DATE_FORMAT 與 SUM(status='PAID')");
        String pivotHql = """
                select new com.example.lab.shop.mybatis.StatusPivotRow(
                         format(o.placedAt as 'yyyy-MM'),
                         count(o.id) filter (where o.status = …OrderStatus.PENDING),
                         count(o.id) filter (where o.status = …OrderStatus.PAID),
                         count(o.id) filter (where o.status = …OrderStatus.CANCELLED),
                         coalesce(sum(case when o.status = …OrderStatus.PENDING
                                           then o.totalAmount end), 0),
                         coalesce(sum(case when o.status = …OrderStatus.PAID
                                           then o.totalAmount end), 0))
                  from Order o
                 group by format(o.placedAt as 'yyyy-MM')
                 order by format(o.placedAt as 'yyyy-MM')
                """;
        // …跟 MyBatis 版比 equals
    }
```

```
═══ 9.3.3 軸三：00 章 0.8.1 場景 D 說「報表 → MyBatis」。那 JPA 做不到嗎 ═══

── ① MyBatis 版（07 章 7.15.4）：CTE + RANK() OVER + SUM() OVER
   #1 客戶9 訂單 15 筆 金額 6255.0000 佔比 10.45%
   #2 客戶8 訂單 15 筆 金額 6195.0000 佔比 10.35%
   #3 客戶7 訂單 15 筆 金額 6135.0000 佔比 10.25%

── ② 同一份報表，用 HQL 寫（05 章 5.4.8 證明 over / with 都能跑）
   #1 客戶9 訂單 15 筆 金額 6255.0000 佔比 10.45%
   #2 客戶8 訂單 15 筆 金額 6195.0000 佔比 10.35%
   #3 客戶7 訂單 15 筆 金額 6135.0000 佔比 10.25%
   兩邊筆數 = 10 / 10
   第一列一字不差嗎 = true
   全部一字不差嗎   = true
   HQL 產生的 SQL：
      with per_customer (cid,cname,cnt,amt) as (
        select c1_0.id,c1_0.display_name,count(o1_0.id),sum(o1_0.total_amount)
          from orders o1_0 join customer c1_0 on c1_0.id=o1_0.customer_id
         where o1_0.placed_at>=? and o1_0.placed_at<? and o1_0.status<>'CANCELLED'
         group by c1_0.id,c1_0.display_name)
      select p1_0.cid,p1_0.cname,p1_0.cnt,p1_0.amt,
             cast(rank() over(order by p1_0.amt desc) as signed),
             cast(round(((100*p1_0.amt)/sum(p1_0.amt) over()),2) as decimal(38,2))
        from p…

── ③ 樞紐表（07 章 7.15.4 的第二個報表）：DATE_FORMAT 與 SUM(status='PAID')
   2026-09 pending=50 paid=50 cancelled=50
   2026-09 pending=50 paid=50 cancelled=50
   兩邊一字不差嗎 = true
   HQL 產生的 SQL：
      select date_format(o1_0.placed_at,'%Y-%m'),
             count(case when o1_0.status='PENDING' then o1_0.id else null end),
             count(case when o1_0.status='PAID' then o1_0.id else null end),
             count(case when o1_0.status='CANCELLED' then o1_0.id else null end),
             coalesce(sum(case when o1_0.status='PENDING' then o1_0.total_amount end),0),
             coalesce(sum(case when o1_0.status='PAID' then o1_0.total_amount end),0)
        from orders o1_0 group by date_…
```

🔴 **兩份報表，`List.equals()` 完全相等 —— 連 `RANK()` 的名次與百分比的四捨五入都一樣。**

**而三個細節值得看**：

```
① 「回 Object[]」那個抱怨不成立 ——
   HQL 的建構子運算式吃得下【同一個 record】（CustomerSalesRow），
   而那個 record 是 07 章為 MyBatis 寫的，一個字都沒改。

② format(o.placedAt as 'yyyy-MM') 被翻譯成 date_format(…, '%Y-%m')
   → 那是 Hibernate 的【可攜寫法】。9.3.6 會看到它在 H2 上變成什麼。

③ count(…) filter (where …) 被翻譯成 count(case when … then … else null end)
   → MySQL 沒有 SQL:2003 的 filter 子句，Hibernate 幫你改寫。
```

📌 **所以場景 D 那一格要改**：

| | 舊的說法 | 實測 |
|---|---|---|
| 「報表 JPA 做不到」 | 🔴 錯 | HQL 有 CTE、窗口函式、`filter`、`format`、`listagg`（05 章 5.4.8 八個全過） |
| 「報表回 `Object[]`」 | 🔴 錯 | 建構子運算式可以回任何 record |
| **「報表交給 MyBatis」** | ✅ **理由要換** | **見下面那三條** |

✅ **「報表用 MyBatis」的三個【還站得住】的理由**：

```
① 那不是 JPQL，是 HQL —— 而【團隊要知道自己在用擴充】（05 章 5.4.8 ③）。
   一份 40 行的 HQL 報表，維護的人要同時懂 SQL 與 HQL 的差異；
   一份 40 行的 SQL 報表，只要懂 SQL。

② SQL 在 XML 裡，可以【整段複製到 MySQL client 上跑】。
   HQL 不行 —— 你要先讓它執行一次才看得到 SQL（9.8.2 會證明這一點的代價）。

③ 報表常常要調整執行計畫（加 hint、改 join 順序、拆成暫存表）——
   那是軸一的第三層，而 HQL 在第一層。
                              ↓
📌 也就是說：「報表用 MyBatis」是一個【可維護性】的決定，不是【能力】的決定。
   而可維護性的決定，要看你的團隊 —— 這正是 00 章 0.8.2 判準 3 與 7 在講的事。
```

### 9.3.4 軸四：寫入時機 —— 這一格不用改，而它是三個地雷的來源

軸四（「JPA 在 flush 時寫、MyBatis 在呼叫時寫」）**在 03 章已經量透了**，
09 章沒有新的實測要做。

**而它是 9.6 那三個地雷的共同來源，所以先把因果鏈寫下來**：

```
軸四：JPA 的寫入延到 flush
   ├─→ 9.6.3 ①：em.persist 之後 MyBatis 查不到（因為 INSERT 還沒送出去）
   ├─→ 9.6.1 ②：交易 A 撈出來的實體，是【交易 B 改之前的狀態】，
   │            而 A 在 commit 的時候才用那個過時狀態去寫 → 樂觀鎖的整個意義
   └─→ 9.7.2：搬到 MyBatis 之後，「狀態機的檢查」與「寫入」之間有一個
              真實的時間差（loadState → updateStatus），
              而 JPA 那一側那個時間差【也在】—— 只是它藏在 flush 裡
```

📌 **一句話**：

> **軸四不是「誰比較快寫進去」，是【你的程式碼裡「現在」這個字指的是什麼時候】。**

### 9.3.5 軸五：schema 不是你的 —— 四張老表，兩個框架

00 章 0.8.2 判準 2 說：

> ⚠️ **判準 2 是實務上最常見的決定因素**：
> 「我們接手了一個十年的資料庫」這句話，基本上就等於選了 MyBatis。

**這一節把「一張設計不良的老表」變成四個具體的實測。**

⚠️ **這個測試不用 Spring，而那是刻意的**：

```
「映射不起來的實體會讓整個應用程式起不來」這件事，
在 Spring 的 context 裡量不到 —— context 起不來，測試根本不會跑。
所以這裡自己組 Hibernate 與 MyBatis，兩邊都用最小組態。
```

```java
package com.example.lab.ch09;

import com.example.legacy9.Legacy;
import com.example.legacy9.LegacyMapper;
import org.apache.ibatis.mapping.Environment;
import org.apache.ibatis.session.SqlSession;
import org.apache.ibatis.session.SqlSessionFactory;
import org.apache.ibatis.session.SqlSessionFactoryBuilder;
import org.apache.ibatis.transaction.jdbc.JdbcTransactionFactory;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

class P1cLegacy {

    static final String URL = "jdbc:mysql://127.0.0.1:33306/ch09?connectionTimeZone=UTC"
            + "&forceConnectionTimeZoneToSession=true&preserveInstants=true&characterEncoding=UTF-8";

    /** 自己組一個 Hibernate SessionFactory，只放進去指定的那幾個類別。 */
    private org.hibernate.SessionFactory boot(Class<?>... classes) {
        var cfg = new org.hibernate.cfg.Configuration();
        cfg.setProperty("hibernate.connection.url", URL);
        cfg.setProperty("hibernate.connection.username", "root");
        cfg.setProperty("hibernate.connection.password", "root");
        cfg.setProperty("hibernate.dialect", "org.hibernate.dialect.MySQLDialect");
        cfg.setProperty("hibernate.hbm2ddl.auto", "none");
        for (Class<?> c : classes) cfg.addAnnotatedClass(c);
        return cfg.buildSessionFactory();
    }

    /** MyBatis 那一側：一個 UnpooledDataSource + 一個 mapper 介面。 */
    private SqlSessionFactory mybatis() {
        var ds = new org.apache.ibatis.datasource.unpooled.UnpooledDataSource(
                "com.mysql.cj.jdbc.Driver", URL, "root", "root");
        var cfg = new org.apache.ibatis.session.Configuration(
                new Environment("ch09", new JdbcTransactionFactory(), ds));
        cfg.setMapUnderscoreToCamelCase(true);
        cfg.addMapper(LegacyMapper.class);
        return new SqlSessionFactoryBuilder().build(cfg);
    }
}
```

**兩邊的映射（JPA 那一側五個類別、MyBatis 那一側一個介面）**：

```java
package com.example.legacy9;

import jakarta.persistence.*;

import java.io.Serializable;
import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.Objects;

/**
 * ⚠️ 這些類別刻意放在 com.example.legacy9（不是 com.example.lab）——
 *    因為 @Entity 只要在 Spring Boot 的掃描範圍裡，
 *    「映射不起來的那一個」會讓【整個應用程式】啟動失敗。
 *    這件事本身就是軸五的答案的一部分：
 *    JPA 的映射錯誤是【全域的】，MyBatis 的映射錯誤是【那一句的】。
 */
public final class Legacy {

    private Legacy() {}

    // ① 沒有主鍵的表：直接映射
    @Entity(name = "LNoPk") @Table(name = "legacy_log")
    public static class NoPk {
        @Column(name = "ts") private LocalDateTime ts;
        @Column(name = "actor") private String actor;
        @Column(name = "action") private String action;
        public LocalDateTime getTs() { return ts; }
    }

    // ①b 沒有主鍵的表：把「所有欄位」當成複合主鍵（實務上最常見的將就法）
    @Entity(name = "LAllId") @Table(name = "legacy_log")
    @IdClass(LogKey.class)
    public static class AllId {
        @Id @Column(name = "ts") private LocalDateTime ts;
        @Id @Column(name = "actor") private String actor;
        @Id @Column(name = "action") private String action;
        @Column(name = "payload") private String payload;
        public LocalDateTime getTs() { return ts; }
        public String getActor() { return actor; }
        public String getAction() { return action; }
    }

    public static class LogKey implements Serializable {
        private LocalDateTime ts;
        private String actor;
        private String action;
        public LogKey() {}
        @Override public boolean equals(Object o) {
            if (!(o instanceof LogKey k)) return false;
            return Objects.equals(ts, k.ts) && Objects.equals(actor, k.actor)
                    && Objects.equals(action, k.action);
        }
        @Override public int hashCode() { return Objects.hash(ts, actor, action); }
    }

    // ② 複合主鍵 + 縮寫欄位名 + Y/N 布林
    @Entity(name = "LCode") @Table(name = "legacy_code")
    @IdClass(CodeKey.class)
    public static class Code {
        @Id @Column(name = "cd_typ") private String type;
        @Id @Column(name = "cd_val") private String value;
        @Column(name = "cd_nm") private String name;
        @Column(name = "use_yn") @Convert(converter = YnConverter.class) private boolean inUse;
        public String getType() { return type; }
        public String getValue() { return value; }
        public String getName() { return name; }
        public boolean isInUse() { return inUse; }
    }

    public static class CodeKey implements Serializable {
        private String type;
        private String value;
        public CodeKey() {}
        @Override public boolean equals(Object o) {
            if (!(o instanceof CodeKey k)) return false;
            return Objects.equals(type, k.type) && Objects.equals(value, k.value);
        }
        @Override public int hashCode() { return Objects.hash(type, value); }
    }

    @Converter
    public static class YnConverter implements AttributeConverter<Boolean, String> {
        @Override public String convertToDatabaseColumn(Boolean b) {
            return Boolean.TRUE.equals(b) ? "Y" : "N";
        }
        @Override public Boolean convertToEntityAttribute(String s) { return "Y".equals(s); }
    }

    // ③ 表名是 SQL 保留字
    @Entity(name = "LKw") @Table(name = "`order`")
    public static class Kw {
        @Id @GeneratedValue(strategy = GenerationType.IDENTITY) private Integer id;
        @Column(name = "amt") private String amt;
        public Integer getId() { return id; }
        public String getAmt() { return amt; }
    }

    // ③b 忘了反引號
    @Entity(name = "LKwBad") @Table(name = "order")
    public static class KwBad {
        @Id @GeneratedValue(strategy = GenerationType.IDENTITY) private Integer id;
        @Column(name = "amt") private String amt;
    }

    // ④ 一個欄位兩種語意：kind='N' → 數字、kind='D' → yyyyMMdd
    @Entity(name = "LFlex") @Table(name = "legacy_flex")
    @Inheritance(strategy = InheritanceType.SINGLE_TABLE)
    @DiscriminatorColumn(name = "kind", discriminatorType = DiscriminatorType.STRING)
    public abstract static class Flex {
        @Id @GeneratedValue(strategy = GenerationType.IDENTITY) private Integer id;
        public Integer getId() { return id; }
    }

    @Entity(name = "LFlexNum") @DiscriminatorValue("N")
    public static class FlexNum extends Flex {
        @Column(name = "val") private BigDecimal val;
        public BigDecimal getVal() { return val; }
    }

    @Entity(name = "LFlexDate") @DiscriminatorValue("D")
    public static class FlexDate extends Flex {
        // 🔴 同一個 val 欄位，在這個子類別要當成日期（而它在資料庫裡是 varchar(40)）
        @Column(name = "val") private String val;
        public String getVal() { return val; }
    }
}
```

```java
package com.example.legacy9;

import org.apache.ibatis.annotations.Select;

import java.util.List;
import java.util.Map;

/**
 * MyBatis 那一側對同樣四張老表要付什麼。
 * ★ 一個介面、四個 @Select、沒有主鍵的概念、沒有身分的概念。
 */
public interface LegacyMapper {

    @Select("SELECT ts, actor, action, payload FROM legacy_log ORDER BY ts, actor")
    List<Map<String, Object>> logs();

    @Select("SELECT cd_typ, cd_val, cd_nm, use_yn = 'Y' AS in_use FROM legacy_code"
            + " ORDER BY cd_typ, cd_val")
    List<Map<String, Object>> codes();

    @Select("SELECT id, amt FROM `order` ORDER BY id")
    List<Map<String, Object>> kwTable();

    @Select("""
            SELECT id, kind,
                   CASE WHEN kind = 'N' THEN CAST(val AS DECIMAL(19,4)) END AS num_val,
                   CASE WHEN kind = 'D' THEN STR_TO_DATE(val, '%Y%m%d') END AS date_val
              FROM legacy_flex ORDER BY id
            """)
    List<Map<String, Object>> flex();
}
```

```
═══ 9.3.5 軸五：四張「不是你設計的」表 ═══

── ① 沒有主鍵的表 —— JPA 直接映射
   AnnotationException
   Entity 'com.example.legacy9.Legacy$NoPk' has no identifier
   (every '@Entity' class must declare or inherit at least one '@Id' or '@EmbeddedId' property)

── ①b 將就法：把「所有欄位」當成複合主鍵 —— 起得來嗎
   ✅ 起得來，JPA 撈到 3 個【元素】
      2026-09-01T16:00 / u1 / LOGIN   物件 #1980783296
      2026-09-01T16:00 / u1 / LOGIN   物件 #1980783296
      2026-09-01T17:30 / u2 / EXPORT   物件 #146901982
   🔴 前兩個元素是同一個物件嗎 = true
   🔴 不同物件的個數 = 2

── ① / ①b 的同一張表，MyBatis 撈到幾列
   MyBatis 撈到 3 列
      2026-09-01T08:00 / u1 / LOGIN
      2026-09-01T08:00 / u1 / LOGIN
      2026-09-01T09:30 / u2 / EXPORT
   （資料庫裡實際有 3 列，其中兩列【一字不差】）

── ①c 順便量到的：同一欄 datetime，兩個框架讀出來差 8 小時
   JDBC 直接讀   → 2026-09-01T08:00
   Hibernate 讀  → 2026-09-01T16:00
   Hibernate + hibernate.jdbc.time_zone=UTC → 2026-09-01T16:00
   JVM 時區 = Asia/Taipei

── ② 複合主鍵 + 縮寫欄位名 + Y/N 布林 —— JPA 要幾個類別
      ORST/OLD 舊狀態 inUse=false
      ORST/PAID 已付款 inUse=true
      ORST/PENDING 待付款 inUse=true
   ✅ 可以，而它要三個類別：Code + CodeKey + YnConverter
      {cd_typ=ORST, in_use=0, cd_nm=舊狀態, cd_val=OLD}
      {cd_typ=ORST, in_use=1, cd_nm=已付款, cd_val=PAID}
      {cd_typ=ORST, in_use=1, cd_nm=待付款, cd_val=PENDING}
   MyBatis：一個 @Select，Y/N 在 SQL 裡就轉完了

── ③ 表名是保留字 order
   ✅ @Table(name = "`order`") → 撈到 2 列
   🔴 忘了反引號 → SQLGrammarException ← SQLSyntaxErrorException
   You have an error in your SQL syntax; … near 'order kb1_0' at line 1

── ④ 一個欄位兩種語意（kind='N' 是數字、'D' 是日期）
      FlexNum id=1 val=1200.5
      FlexDate id=2 val=20260901
      FlexNum id=3 val=0
   ✅ 繼承 + @DiscriminatorColumn 撈到 3 列
      {kind=N, num_val=1200.5000, id=1}
      {date_val=2026-09-01, kind=D, id=2}
      {kind=N, num_val=0.0000, id=3}
```

**四張表，四個不一樣的答案**：

**① 🔴 沒有主鍵 → JPA 起不來，而且是【全域】起不來。**

```
AnnotationException: Entity 'NoPk' has no identifier
                              ↓
⚠️ 這個例外發生在【建 SessionFactory 的時候】。
   也就是說：一張映射不起來的老表，會讓【整個應用程式】無法啟動 ——
   包含那些跟這張表無關的 99 個功能。
                              ↓
📌 而這正是「JPA 的錯誤大多在啟動時被擋下來」（07 章 7.4.5）的另一面：
   啟動時擋下來 = 快速失敗（好），也 = 全域失敗（在老 schema 上很痛）。
```

**①b 🔴🔴 而那個「將就法」比起不來更糟。**

```
把 (ts, actor, action) 當成複合主鍵 → 起得來，撈到「3 個元素」
                              ↓
而其中兩個元素是【同一個物件】（identityHashCode 一樣）：
   資料庫裡有 3 列
   list.size() == 3
   而不同物件只有 2 個
                              ↓
🔴 為什麼：那是【持久化情境的身分保證】（03 章 3.3.1）——
   「同一個 id 在同一個 PC 裡只有一個實例」。
   而這張表的「id」不是真的唯一，所以那個保證變成【資料損毀】：
      list.get(0).setActor("x") 會同時改到 list.get(1)。
```

⚠️ **這一格是整個軸五最重要的一格**：

> **JPA 對「沒有主鍵的表」的問題不是「不支援」，是【它的核心保證失去意義】。**
> **而失去意義的方式是靜默的 —— 三個元素、兩個物件，`size()` 還是 3。**
>
> **MyBatis 那一側撈到 3 列、3 個 Map，因為它【沒有身分這個概念】（00 章 0.5.2）。**

**①c 🔴🔴 同一欄 `datetime`，兩個框架讀出來差 8 小時。**

這是這一節的意外收穫，而它大到值得一個自己的實測（9.3.5b）。

**② ✅ 複合主鍵：JPA 做得到，代價是類別數。**

```
JPA    ：Code（實體）+ CodeKey（IdClass，要寫 equals/hashCode）+ YnConverter = 3 個類別
MyBatis：一個 @Select，Y/N 在 SQL 裡用 `use_yn = 'Y' AS in_use` 就轉完了
                              ↓
📌 而 3 個類別換到的是：那張碼表可以當成關聯的目標（@ManyToOne 指到它）、
   可以被快取（06 章 6.5）、有型別安全的 find(CodeKey)。
   如果你只是要「撈出來顯示」，那 3 個類別是純成本。
```

**③ 表名是保留字：兩邊一樣要處理，而 JPA 的錯誤訊息比較晚。**

```
@Table(name = "`order`") → ✅（Hibernate 直接把反引號當引號字元用）
@Table(name = "order")   → 🔴 SQLGrammarException，而它在【第一次查那張表】才發生
                              ↓
⚠️ 注意這個例外的時機：它【不是】啟動期。
   hbm2ddl.auto=none 的時候，Hibernate 不會去驗證表名 ——
   而 01 章 1.10 那個 validate 也只驗證「表存不存在」，
   它驗證的是 order 這個名字存不存在（而它存在！）。
```

**④ 一個欄位兩種語意：兩邊都做得到，而形狀完全不同。**

```
JPA    ：SINGLE_TABLE 繼承 + @DiscriminatorColumn("kind")
         → 撈出來是【三個不同的 Java 型別】（FlexNum / FlexDate / FlexNum）
         → 而 val 欄位在兩個子類別上映射成兩種型別（BigDecimal / String）—— 沒有報錯
MyBatis：一句 SQL 裡用 CASE WHEN 把它拆成兩個【欄位】（num_val / date_val）
         → 撈出來是一個 Map，該是 null 的就是 null
                              ↓
📌 兩者的差別不是「誰做得到」，是【型別在哪裡決定】：
   JPA 在【類別階層】上決定（所以你可以 instanceof、可以 pattern matching）
   MyBatis 在【SQL】裡決定（所以你可以隨時換一種解讀，不用改類別）
```

📌 **軸五的結論**：

| 老 schema 的特徵 | JPA | MyBatis | 這一章實測了嗎 |
|---|---|---|---|
| 沒有主鍵 | 🔴 起不來，或**靜默去重**（3 列 → 2 個物件） | ✅ 沒有這個概念 | ✅ 9.3.5 ① / ①b |
| 複合主鍵 | 🟡 可以，**+2 個類別** | ✅ 一句 SQL | ✅ 9.3.5 ② |
| 保留字 / 怪名字 | 🟡 可以，錯了**執行期**才知道 | 🟡 一樣 | ✅ 9.3.5 ③ |
| 一欄兩種語意 | 🟡 繼承階層（型別在類別上） | ✅ SQL 裡拆（型別在 SQL 上） | ✅ 9.3.5 ④ |
| `datetime` 存本地時間 | 🔴 **差 8 小時**，而組態改不掉 | ✅ 內建 handler 直送 | ✅ 9.3.5b |
| 關聯的目標**由另一個欄位決定**（多型外鍵） | 🔴 要 Hibernate 專屬的 `@Any`（JPA 規格沒有） | ✅ 一個 join + `<discriminator>` | 🔴 **沒有** |
| 一張表 300 欄 | 🟡 一個 300 個欄位的類別（可以拆 `@Embeddable`，而讀寫都是整列） | ✅ 每個用例撈自己要的欄位 | 🔴 **沒有** |

⚠️ **最後兩列沒有實測 —— 它們是這一節的【推論】，而推論要標記出來。**
（想自己驗的話：多型外鍵那一列，用 `legacy_flex` 加一個 `ref_id` 欄位就可以造出來。）

⚠️ **而判準 2 那句話要補一個限定**：

```
🔴 「接手十年的資料庫」= 選 MyBatis
✅ 「接手十年的資料庫」= 【那些表】選 MyBatis
                              ↓
實務上最常見的形狀是：
   老表（沒有主鍵、300 個欄位、外鍵靠約定） → MyBatis 讀，不寫
   新功能自己的表（你設計的）              → JPA
而那正好是 9.6.1 那個「依表切」—— 這一站的第三筆帳。
```

### 9.3.5b 🔴🔴 實測：同一欄 `datetime`，兩個框架差 8 小時

**9.3.5 ①c 那三行，值得單獨拆開來看**：

```
JDBC 直接讀   → 2026-09-01T08:00      ← 資料庫裡就是這個值
Hibernate 讀  → 2026-09-01T16:00      ← 🔴 +8 小時
```

```java
package com.example.lab.ch09;

import com.example.legacy9.Legacy;
import org.junit.jupiter.api.Test;

class P1dTimeZone {
    private org.hibernate.SessionFactory boot(String url, String... props) {
        var cfg = new org.hibernate.cfg.Configuration();
        cfg.setProperty("hibernate.connection.url", url);
        cfg.setProperty("hibernate.connection.username", "root");
        cfg.setProperty("hibernate.connection.password", "root");
        cfg.setProperty("hibernate.dialect", "org.hibernate.dialect.MySQLDialect");
        cfg.setProperty("hibernate.hbm2ddl.auto", "none");
        for (int i = 0; i < props.length; i += 2) cfg.setProperty(props[i], props[i + 1]);
        cfg.addAnnotatedClass(Legacy.AllId.class);
        return cfg.buildSessionFactory();
    }
    private void show(String label, String url, String... props) {
        try (var sf = boot(url, props)) {
            System.out.println("  " + label + " → " + sf.fromTransaction(s -> s.createQuery(
                    "select a.ts from LAllId a order by a.ts", java.time.LocalDateTime.class)
                    .setMaxResults(1).getSingleResult()));
        }
    }
    @Test void probe() {
        String base = "jdbc:mysql://127.0.0.1:33306/ch09?characterEncoding=UTF-8";
        String utc = base + "&connectionTimeZone=UTC&forceConnectionTimeZoneToSession=true&preserveInstants=true";
        show("URL 乾淨（沒有 connectionTimeZone）", base);
        show("URL 乾淨 + jdbc.time_zone=UTC", base, "hibernate.jdbc.time_zone", "UTC");
        show("課程用的 URL（preserveInstants=true）", utc);
        show("課程 URL + jdbc.time_zone=UTC", utc, "hibernate.jdbc.time_zone", "UTC");
        show("課程 URL 但 preserveInstants=false",
             base + "&connectionTimeZone=UTC&forceConnectionTimeZoneToSession=true&preserveInstants=false");
    }
}
```

```
  URL 乾淨（沒有 connectionTimeZone） → 2026-09-01T08:00
  URL 乾淨 + jdbc.time_zone=UTC → 2026-09-01T16:00
  課程用的 URL（preserveInstants=true） → 2026-09-01T16:00
  課程 URL + jdbc.time_zone=UTC → 2026-09-01T16:00
  課程 URL 但 preserveInstants=false → 2026-09-01T08:00
```

**機制**（`LocalDateTime` 被轉了**兩次**）：

```
資料庫裡：datetime(3) = '2026-09-01 08:00:00'（沒有時區資訊）

Hibernate 讀 LocalDateTime 的路徑是「先變成一個【瞬間】，再變回本地時間」：
   ① 驅動：connectionTimeZone=UTC + preserveInstants=true
      → 「這一欄的值是 UTC 的 08:00」→ 產生瞬間 2026-09-01T08:00Z
   ② Hibernate：把那個瞬間換算成 JVM 時區（Asia/Taipei）的本地時間
      → 16:00
                              ↓
而 JdbcTemplate 走的是 rs.getObject(i, LocalDateTime.class) ——
驅動直接把「欄位裡那 19 個字元」給你，【沒有經過瞬間】→ 08:00。
```

⚠️ **`hibernate.jdbc.time_zone=UTC` 不但沒修好它，還把乾淨的 URL 弄壞了**：

| URL | `hibernate.jdbc.time_zone` | 讀出來 |
|---|---|---|
| 乾淨 | 沒設 | ✅ 08:00 |
| 乾淨 | UTC | 🔴 16:00 |
| `preserveInstants=true` | 沒設 | 🔴 16:00 |
| `preserveInstants=true` | UTC | 🔴 16:00 |
| `preserveInstants=false` | 沒設 | ✅ 08:00 |

📌 **一句話**：

> **`LocalDateTime` + 一層時區設定 = 一次轉換（結果可能對）。**
> **`LocalDateTime` + 兩層時區設定 = 兩次轉換（結果一定錯）。**
>
> **這就是 01 章 1.7 那句「用 `Instant`」的最後一格 ——**
> **而老表的 `datetime` 欄位【沒有時區資訊】，你只能用 `LocalDateTime`。**

✅ **所以碰到老表的 `datetime` 欄位，兩個做法**：

```
① 讀那些表的連線，把 preserveInstants 關掉（而那會影響同一條連線上的所有查詢）
② 那張表的時間欄位映射成 String，在領域層自己 parse
   → 醜，而它是唯一「行為跟任何組態都無關」的做法
```

**而 9.6.4 會證明：這個問題在【混用】的時候會變成一個更難發現的形狀 ——
同一個值，兩個框架寫進去的不一樣。**

### 9.3.6 ★★ 軸六：換資料庫 —— 把 shop-service 整個搬到 H2

00 章 0.6.6 那一格說：

| 軸 | JPA | MyBatis |
|---|---|---|
| 換資料庫 | `Dialect` 自動處理 | **自己改 SQL** |

**而 00 章 0.8.3 又說「以後可能要換資料庫」是一個🔴不該當理由的理由。**
**兩句話都對，而它們合起來就是這一節要量的東西：那個「自己改 SQL」到底是多少工作？**

```java
package com.example.lab.ch09;

import com.example.lab.shop.Customer;
import com.example.lab.shop.Order;
import com.example.lab.shop.OrderItem;
import com.example.lab.shop.OrderListRow;
import com.example.lab.shop.OrderSearchCriteria;
import com.example.lab.shop.OrderStatus;
import com.example.lab.shop.Product;
import com.example.lab.shop.Stock;
import com.example.lab.shop.mybatis.OrderQueryMapper;
import com.example.lab.shop.mybatis.OrderSearchMapper;
import org.apache.ibatis.builder.xml.XMLMapperBuilder;
import org.apache.ibatis.io.Resources;
import org.apache.ibatis.mapping.Environment;
import org.apache.ibatis.session.SqlSession;
import org.apache.ibatis.session.SqlSessionFactory;
import org.apache.ibatis.session.SqlSessionFactoryBuilder;
import org.apache.ibatis.transaction.jdbc.JdbcTransactionFactory;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 9.3.6 軸六：換資料庫。
 * 把 shop-service 的兩側【原封不動搬到 H2】，然後數哪幾句活下來。
 */
class P1eH2 {

    static final String H2 = "jdbc:h2:mem:shop9;MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1";

    private final Map<String, String> jpaResult = new LinkedHashMap<>();
    private final Map<String, String> mybatisResult = new LinkedHashMap<>();

    private org.hibernate.SessionFactory bootH2(boolean createDdl) {
        var cfg = new org.hibernate.cfg.Configuration();
        cfg.setProperty("hibernate.connection.url", H2);
        cfg.setProperty("hibernate.connection.username", "sa");
        cfg.setProperty("hibernate.connection.password", "");
        cfg.setProperty("hibernate.hbm2ddl.auto", createDdl ? "create" : "none");
        cfg.setProperty("hibernate.show_sql", "false");
        for (Class<?> c : List.of(Customer.class, Product.class, Stock.class,
                Order.class, OrderItem.class)) cfg.addAnnotatedClass(c);
        return cfg.buildSessionFactory();
    }

    private SqlSessionFactory mybatisH2() throws Exception {
        var ds = new org.apache.ibatis.datasource.unpooled.UnpooledDataSource(
                "org.h2.Driver", H2, "sa", "");
        var cfg = new org.apache.ibatis.session.Configuration(
                new Environment("h2", new JdbcTransactionFactory(), ds));
        cfg.setMapUnderscoreToCamelCase(true);
        cfg.getTypeHandlerRegistry().register(new com.example.lab.ch07.UuidTypeHandler());
        cfg.getTypeHandlerRegistry().register(new com.example.lab.ch07.InstantTypeHandler());
        for (String res : List.of("mapper/OrderQueryMapper.xml", "mapper/OrderSearchMapper.xml")) {
            try (var in = Resources.getResourceAsStream(res)) {
                new XMLMapperBuilder(in, cfg, res, cfg.getSqlFragments()).parse();
            }
        }
        return new SqlSessionFactoryBuilder().build(cfg);
    }

    private static void head(String t) { System.out.println("\n═══ " + t + " ═══"); }
    private static void sub(String t) { System.out.println("\n── " + t); }

    private static String shortMsg(Throwable t) {
        Throwable r = t;
        while (r.getCause() != null && r.getCause() != r) r = r.getCause();
        String s = String.valueOf(r.getMessage()).replaceAll("\\s+", " ");
        return (r.getClass().getSimpleName() + ": " + s).substring(0,
                Math.min(150, r.getClass().getSimpleName().length() + s.length() + 2));
    }

    private void probe(Map<String, String> into, String label, Runnable body) {
        try { body.run(); into.put(label, "✅"); System.out.println("   ✅ " + label); }
        catch (Throwable t) {
            into.put(label, "🔴 " + shortMsg(t));
            System.out.println("   🔴 " + label);
            System.out.println("      " + shortMsg(t));
        }
    }

    @Test
    void a6_同一份程式碼搬到H2() throws Exception {
        head("9.3.6 軸六：shop-service 原封不動搬到 H2");

        sub("① JPA 幫你換 DDL —— 它在 H2 上把 UUID 存成什麼");
        var sf = bootH2(true);
        try (var cn = java.sql.DriverManager.getConnection(H2, "sa", "");
             var st = cn.createStatement()) {
            var rs = st.executeQuery("SELECT column_name, data_type, character_maximum_length"
                    + " FROM information_schema.columns WHERE lower(table_name) = 'orders'"
                    + " ORDER BY ordinal_position");
            while (rs.next()) System.out.printf("      %-16s %s%s%n", rs.getString(1),
                    rs.getString(2), rs.getObject(3) == null ? "" : "(" + rs.getObject(3) + ")");
        }
        System.out.println("   📌 MySQL 上這張表的 id 是 binary(16)（07 站 1.12 手寫的 DDL）");

        sub("② 塞資料（走 JPA 的寫入路徑）");
        List<UUID> pids = new ArrayList<>();
        sf.inTransaction(s -> {
            for (int i = 0; i < 3; i++) {
                Product p = new Product(com.example.lab.Uuid7.next(), "SKU-" + i, "商品" + i,
                        new BigDecimal((100 + 50 * i) + ".0000"));
                s.persist(p);
                s.persist(new Stock(p, 1_000_000));
                pids.add(p.getId());
            }
            for (int c = 0; c < 4; c++) {
                Customer cu = new Customer(com.example.lab.Uuid7.next(), "c" + c + "@x.com", "客戶" + c);
                s.persist(cu);
                for (int k = 0; k < 5; k++) {
                    Order o = new Order(com.example.lab.Uuid7.next(),
                            String.format("SO-%06d", c * 5 + k + 1), cu);
                    o.addItem(com.example.lab.Uuid7.next(),
                            s.getReference(Product.class, pids.get(k % 3)), 1 + k % 2);
                    s.persist(o);
                }
            }
        });
        long n = sf.fromTransaction(s -> s.createQuery("select count(o) from Order o", Long.class)
                .getSingleResult());
        System.out.println("   ✅ JPA 在 H2 上寫進 " + n + " 張訂單（一行程式碼都沒改）");

        sub("③ JPA 那一側的四個查詢，在 H2 上跑得過嗎");
        probe(jpaResult, "JPQL 投影列表（05 章 5.14）", () -> sf.inTransaction(s -> {
            var rows = s.createQuery("""
                    select new com.example.lab.shop.OrderListRow(
                             o.id, o.orderNo, c.displayName, o.status, o.totalAmount, o.placedAt,
                             (select count(i) from OrderItem i where i.order = o))
                      from Order o join o.customer c
                     where o.status = :st
                     order by o.placedAt desc
                    """, OrderListRow.class).setParameter("st", OrderStatus.PENDING)
                    .setMaxResults(5).getResultList();
            System.out.println("      " + rows.size() + " 筆，第一列 = "
                    + rows.get(0).orderNo() + " / " + rows.get(0).customerName());
        }));
        probe(jpaResult, "JOIN FETCH 明細頁（04 章 4.11）", () -> sf.inTransaction(s -> {
            var o = s.createQuery("select o from Order o join fetch o.customer"
                    + " join fetch o.items i join fetch i.product", Order.class)
                    .setMaxResults(1).getSingleResult();
            System.out.println("      " + o.getOrderNo() + " 明細 " + o.getItems().size() + " 筆");
        }));
        probe(jpaResult, "HQL 報表：CTE + rank() over + sum() over", () -> sf.inTransaction(s -> {
            var rows = s.createQuery("""
                    with per_customer as (
                      select c.id as cid, c.displayName as cname,
                             count(o.id) as cnt, sum(o.totalAmount) as amt
                        from Order o join o.customer c
                       group by c.id, c.displayName
                    )
                    select new com.example.lab.shop.mybatis.CustomerSalesRow(
                             p.cid, p.cname, p.cnt, p.amt,
                             cast(rank() over (order by p.amt desc) as long),
                             cast(round(100 * p.amt / sum(p.amt) over (), 2) as big_decimal))
                      from per_customer p order by p.amt desc
                    """, com.example.lab.shop.mybatis.CustomerSalesRow.class).getResultList();
            System.out.println("      " + rows.size() + " 列，第一名 = " + rows.get(0).customerName()
                    + " " + rows.get(0).totalAmount() + " 佔比 " + rows.get(0).pctOfTotal() + "%");
        }));
        probe(jpaResult, "HQL 樞紐表：format() + filter()", () -> sf.inTransaction(s -> {
            var rows = s.createQuery("""
                    select new com.example.lab.shop.mybatis.StatusPivotRow(
                             format(o.placedAt as 'yyyy-MM'),
                             count(o.id) filter (where o.status = com.example.lab.shop.OrderStatus.PENDING),
                             count(o.id) filter (where o.status = com.example.lab.shop.OrderStatus.PAID),
                             count(o.id) filter (where o.status = com.example.lab.shop.OrderStatus.CANCELLED),
                             coalesce(sum(case when o.status = com.example.lab.shop.OrderStatus.PENDING
                                               then o.totalAmount end), 0),
                             coalesce(sum(case when o.status = com.example.lab.shop.OrderStatus.PAID
                                               then o.totalAmount end), 0))
                      from Order o group by format(o.placedAt as 'yyyy-MM')
                    """, com.example.lab.shop.mybatis.StatusPivotRow.class).getResultList();
            System.out.println("      " + rows.get(0).ym() + " pending=" + rows.get(0).pending());
        }));

        sub("④ MyBatis 那一側的六個 statement，在 H2 上跑得過嗎");
        SqlSessionFactory msf = mybatisH2();
        try (SqlSession s = msf.openSession()) {
            OrderQueryMapper q = s.getMapper(OrderQueryMapper.class);
            OrderSearchMapper se = s.getMapper(OrderSearchMapper.class);
            probe(mybatisResult, "listRows（LIMIT ? OFFSET ?）", () -> {
                var rows = q.listRows(OrderStatus.PENDING, 0, 5);
                System.out.println("      " + rows.size() + " 筆，第一列 = "
                        + rows.get(0).orderNo() + " / " + rows.get(0).customerName());
            });
            probe(mybatisResult, "countByStatus", () ->
                    System.out.println("      " + q.countByStatus(OrderStatus.PENDING) + " 筆"));
            probe(mybatisResult, "salesRanking（CTE + RANK() OVER + ROUND）", () -> {
                var rows = q.salesRanking(Instant.parse("2020-01-01T00:00:00Z"),
                        Instant.parse("2030-01-01T00:00:00Z"));
                System.out.println("      " + rows.size() + " 列，第一名 " + rows.get(0).customerName());
            });
            probe(mybatisResult, "statusPivot（DATE_FORMAT + SUM(status='X')）", () -> {
                var rows = q.statusPivot();
                System.out.println("      " + rows.get(0).ym() + " pending=" + rows.get(0).pending());
            });
            probe(mybatisResult, "search（<if> + LIKE ESCAPE '!'）", () -> {
                var rows = se.search(new OrderSearchCriteria(OrderStatus.PENDING, "客戶",
                        null, null, null), 0, 5);
                System.out.println("      " + rows.size() + " 筆");
            });
            probe(mybatisResult, "pageAfter（keyset）", () -> {
                var rows = se.pageAfter(OrderStatus.PENDING, null, null, 5);
                System.out.println("      " + rows.size() + " 筆");
            });
        }

        sub("④b 那一句裡到底幾個地方不能用 —— 逐段問 H2");
        try (var cn = java.sql.DriverManager.getConnection(H2, "sa", "");
             var st = cn.createStatement()) {
            for (String frag : List.of(
                    "SELECT DATE_FORMAT(placed_at, '%Y-%m') FROM orders LIMIT 1",
                    "SELECT SUM(status = 'PENDING') FROM orders",
                    "SELECT FORMATDATETIME(placed_at, 'yyyy-MM') FROM orders LIMIT 1",
                    "SELECT COALESCE(SUM(CASE WHEN status = 'PENDING' THEN total_amount END), 0) FROM orders")) {
                try (var rs = st.executeQuery(frag)) {
                    rs.next();
                    System.out.println("      ✅ " + frag.substring(0, Math.min(60, frag.length()))
                            + " → " + rs.getObject(1));
                } catch (Exception e) {
                    System.out.println("      🔴 " + frag.substring(0, Math.min(60, frag.length()))
                            + " → " + shortMsg(e));
                }
            }
        }

        sub("⑤ 總結：同一份程式碼，換一個資料庫");
        System.out.println("   JPA 那一側");
        jpaResult.forEach((k, v) -> System.out.printf("      %-40s %s%n", k, v));
        System.out.println("   MyBatis 那一側");
        mybatisResult.forEach((k, v) -> System.out.printf("      %-40s %s%n", k, v));
        long jpaOk = jpaResult.values().stream().filter("✅"::equals).count();
        long mbOk = mybatisResult.values().stream().filter("✅"::equals).count();
        System.out.printf("%n   JPA     %d / %d 過%n   MyBatis %d / %d 過%n",
                jpaOk, jpaResult.size(), mbOk, mybatisResult.size());
        sf.close();
    }
}
```

```
═══ 9.3.6 軸六：shop-service 原封不動搬到 H2 ═══

── ① JPA 幫你換 DDL —— 它在 H2 上把 UUID 存成什麼
      currency         character(3)
      discount_amount  numeric
      total_amount     numeric
      created_at       timestamp with time zone
      paid_at          timestamp with time zone
      placed_at        timestamp with time zone
      updated_at       timestamp with time zone
      version          bigint
      customer_id      uuid
      id               uuid
      status           character varying(16)
      order_no         character varying(32)
   📌 MySQL 上這張表的 id 是 binary(16)（07 站 1.12 手寫的 DDL）

── ② 塞資料（走 JPA 的寫入路徑）
   ✅ JPA 在 H2 上寫進 20 張訂單（一行程式碼都沒改）

── ③ JPA 那一側的四個查詢，在 H2 上跑得過嗎
      5 筆，第一列 = SO-000020 / 客戶3
   ✅ JPQL 投影列表（05 章 5.14）
      SO-000001 明細 1 筆
   ✅ JOIN FETCH 明細頁（04 章 4.11）
      4 列，第一名 = 客戶0 950.0000 佔比 25.00%
   ✅ HQL 報表：CTE + rank() over + sum() over
      2026-09 pending=20
   ✅ HQL 樞紐表：format() + filter()

── ④ MyBatis 那一側的六個 statement，在 H2 上跑得過嗎
      5 筆，第一列 = SO-000020 / 客戶3
   ✅ listRows（LIMIT ? OFFSET ?）
      20 筆
   ✅ countByStatus
      4 列，第一名 客戶0
   ✅ salesRanking（CTE + RANK() OVER + ROUND）
   🔴 statusPivot（DATE_FORMAT + SUM(status='X')）
      JdbcSQLSyntaxErrorException: Function "date_format" not found; SQL statement:
      SELECT DATE_FORMAT(placed_at, '%Y-%m') AS ym, SUM(status = 'PENDING') AS
      5 筆
   ✅ search（<if> + LIKE ESCAPE '!'）
      5 筆
   ✅ pageAfter（keyset）

── ④b 那一句裡到底幾個地方不能用 —— 逐段問 H2
      🔴 SELECT DATE_FORMAT(placed_at, '%Y-%m') FROM orders LIMIT 1
         → JdbcSQLSyntaxErrorException: Function "date_format" not found
      ✅ SELECT SUM(status = 'PENDING') FROM orders → 20
      ✅ SELECT FORMATDATETIME(placed_at, 'yyyy-MM') FROM orders LIMI → 2026-09
      ✅ SELECT COALESCE(SUM(CASE WHEN status = 'PENDING' THEN total_ → 3800.0000

── ⑤ 總結：同一份程式碼，換一個資料庫
   JPA     4 / 4 過
   MyBatis 5 / 6 過
```

🔴 **這一節的結果跟「MyBatis 換資料庫要重寫」那個印象差很遠**：

```
MyBatis 那六句 SQL 搬到 H2：五句【一個字都不用改】。
壞掉的那一句，壞在【一個函式】：DATE_FORMAT。
   而它的替代品是 FORMATDATETIME（H2）/ TO_CHAR（PostgreSQL / Oracle）——
   也就是「一句 SQL 裡有一個地方要改」，不是「一句 SQL 要重寫」。
                              ↓
連 SUM(status = 'PENDING') 這種【布林算術】都過了
（H2 在 MODE=MySQL 下支援它）。
```

✅ **而 JPA 那一側 4/4 過，代價在 ① 那一格**：

```
同一份實體，在 MySQL 上與在 H2 上，Hibernate 產生的 DDL 【型別不一樣】：
   id          binary(16)        →  uuid
   placed_at   datetime(3)       →  timestamp with time zone
   total_amount decimal(19,4)    →  numeric
                              ↓
🔴 所以「JPA 換資料庫免費」的真正意思是：
   ✅ 你的【程式碼】不用改
   🔴 而你的【schema】變成另一個東西
```

⚠️ **這件事有一個非常實際的後果，而 06 站早就量過了**：

```
06 站 06 章那 21 根探針，有 12 根在 H2 與 MySQL 之間【行為不一樣】
（隔離等級、鎖的粒度、唯一鍵衝突的錯誤碼、字串比較的定序……）
                              ↓
所以「用 H2 跑測試、用 MySQL 上線」這件事，
   不是「JPA 幫你抽象掉了資料庫」，
   是【你在兩個不同的資料庫上跑同一份程式碼】。
   而那 12 根探針就是它的帳單。
```

📌 **軸六的結論，兩句話**：

> **JPA 那一格要加一個星號**：`Dialect` 換掉的是**語法與 DDL**，
> 不是**行為**。而換 schema 型別這件事，本身就是一個要驗證的變更。
>
> **MyBatis 那一格要改**：不是「自己改 SQL」，是
> **「自己改那幾個廠商特有的函式」—— 而實測是六句裡的一個函式**。
>
> ✅ **兩邊真正的差別是「你什麼時候發現」**：
> JPA 在**啟動時**（`Dialect` 不支援的東西會在 SessionFactory 建立時炸），
> MyBatis 在**執行到那一句時**（而如果那一句是月報，你會在月初發現）。

### 9.3.7 六條軸的最終總表

| # | 軸 | JPA / Hibernate | MyBatis | 09 章改了什麼 |
|---|---|---|---|---|
| 1 | **誰決定 SQL** | **三層**：意圖（JPQL）→ 提示（`USE INDEX`）→ 接管（native） | 只有第三層 | 🔴 **8.13 那句「JPA 做不到」錯了**；而 JPQL **也寫得出慢的那一種**（9.3.1） |
| 2 | **有沒有狀態** | **有**，而且它可以關掉（投影） | 無 | ★★ 第六把尺：**「0 個實體」不等於配置少**（JPA 投影 83 KB vs MyBatis 115 KB）（9.3.2） |
| 3 | **查詢的單位** | 實體，**而 HQL 的建構子運算式可以是任何 record** | 一句 SQL 的結果形狀 | 🔴 **報表兩邊產出 `equals()` 相等**；「報表用 MyBatis」是**可維護性**的理由（9.3.3） |
| 4 | **寫入時機** | flush 時（三個時機） | 呼叫時 | 不變 —— 而它是 9.6 那三個地雷的**共同來源**（9.3.4） |
| 5 | **誰主導 schema** | 老表的問題不是「不支援」，是**核心保證失去意義**（3 列 → 2 個物件） | 沒有身分的概念，所以沒有這個問題 | 🔴 判準 2 要改成「**那些表**選 MyBatis」（9.3.5） |
| 6 | **換資料庫** | 程式碼免費，**schema 型別會變**（`binary(16)` → `uuid`） | 六句裡要改**一個函式** | 🔴 兩格都要改；真正的差別是**你什麼時候發現**（9.3.6） |

📌 **而那張依賴圖（00 章 0.6.7）現在可以補一條線**：

```
        ② 有沒有狀態  ← 最根本
       ╱      │      ╲
      ↓       ↓        ↓
  ① 誰決定   ④ 寫入    ③ 查詢
     SQL      時機      單位
      ↓                 ↓
  ⑥ 換資料庫      ★ 09 章補的：③ 也指向 ②
                        （「查詢的單位是不是實體」是【你每一個查詢各自的選擇】，
                          而它決定了那個查詢有沒有狀態 —— 05 章那把刀）
```

> 📌 **如果只能從這一節記一件事**：
>
> **這六條軸沒有一條是「這個框架永遠這樣」。**
> **每一條都有一個「而你可以…」，而那個「可以」的代價，就是這一站在教的東西。**

---

## 9.4 帳二：「快兩倍」的結案 ★★

這一站量過三次「同一件事，兩個框架」：

```
00 章 0.7  ：同一頁 200 張訂單          JPA 9 ms   MyBatis 3 ms
07 章 7.15.3：同一頁列表（都是投影）      JPA 2699 µs  MyBatis 1188 µs
08 章 8.10.2：同一組五個動態條件         JPA 5958 µs  MyBatis 2801 µs
                              ↓
三次都是「兩倍多」。而 00 章 0.8.3 已經說了「不該拿這個當理由」——
這一節要說的是【為什麼】：因為那個兩倍量的不是你以為的東西。
```

### 9.4.1 先重量一次，加上第六把尺

```java
    @Test
    void b1_兩倍的絕對值() {
        head("9.4.1 08 章 8.10.2 那兩個數字，加上第六把尺");

        Runnable jpa = () -> tx.executeWithoutResult(s -> orders.search(FIVE, 0, 20));
        Runnable mb  = () -> tx.executeWithoutResult(s -> orders.searchRows(FIVE, 0, 20));
        // 兩條路都是 08 章結束時 shop-service 裡真實存在的方法
    }
```

```
═══ 9.4.1 08 章 8.10.2 那兩個數字，加上第六把尺 ═══

  同一組五個條件                         SQL       實體         耗時           配置
  JPA Specification + 投影介面        2 句     21 個     2076 µs     201.8 KB
  MyBatis <if> + record           2 句      0 個     1437 µs     213.5 KB

── 兩邊的結果一樣嗎
   JPA     5 筆，第一列 SO-000165 / 客戶1 / 464.0000
   MyBatis 5 筆（total=5），第一列 SO-000165 / 客戶1 / 464.0000
```

⚠️ **跟 08 章 8.10.2 的數字對照，兩個地方不一樣，兩個都要說明**：

```
① 08 章是 3 句 SQL、80 個實體；這裡是 2 句、21 個
   → 08 章那一組條件命中 23 筆，這裡命中 5 筆。
     命中 5 筆的時候 Spring Data 會【跳過 count 查詢】
     （PageableExecutionUtils：第一頁而且不滿一頁 → total 就是 content.size()）
   → 而實體數 21 = 5 張訂單 + 客戶 + 15 筆明細（OrderView 要 lines）

② 而【配置】那一格是新的，它說了一件跟 9.3.2 一樣的事：
   JPA 201.8 KB vs MyBatis 213.5 KB —— 兩邊【一樣】。
   那 21 個實體沒有讓 JPA 配置得比較多，因為 MyBatis 那一側也配置了同一個量級的中介物件。
```

📌 **所以「兩倍」剩下的差別是 639 µs，而它在哪裡？**

### 9.4.1b ★★ 實測：把那個兩倍拆成「固定成本」與「每列成本」

**如果那個差別來自「每一列的處理成本」，它應該隨筆數線性成長。**
**同一句 SQL、同一個投影，取 1 / 5 / 20 / 50 / 200 列各量一次。**

```java
    @Test
    void b1b_把兩倍拆成截距與斜率() {
        head("9.4.1b ★★ 那個「兩倍」是固定成本還是每列成本");

        String jpql = """
                select new com.example.lab.shop.OrderListRow(
                         o.id, o.orderNo, c.displayName, o.status, o.totalAmount, o.placedAt,
                         (select count(i) from OrderItem i where i.order = o))
                  from Order o join o.customer c
                 where o.status = :st
                 order by o.placedAt desc
                """;                                // ★ 跟 MyBatis 的 listRows 同一句 SQL

        long[] sizes = {1, 5, 20, 50, 200};
        for (int n : sizes) {
            long jpaUs = bestMicros(() -> tx.executeWithoutResult(s ->
                    em.createQuery(jpql, OrderListRow.class)
                            .setParameter("st", OrderStatus.PENDING)
                            .setMaxResults(n).getResultList()), 5, 15);
            long mbUs = bestMicros(() -> tx.executeWithoutResult(s ->
                    query.listRows(OrderStatus.PENDING, 0, n)), 5, 15);
            System.out.printf("  %8d %10d µs %10d µs %10.2f×%n", n, jpaUs, mbUs, jpaUs / (double) mbUs);
        }
    }
```

```
═══ 9.4.1b ★★ 那個「兩倍」是固定成本還是每列成本 ═══

       取幾列          JPA      MyBatis JPA / MyBatis
         1        805 µs        787 µs       1.02×
         5        787 µs        790 µs       1.00×
        20        824 µs        827 µs       1.00×
        50        831 µs        843 µs       0.99×
       200        827 µs        854 µs       0.97×

── 拆開來看（用 1 列與 200 列這兩個點）
   JPA     固定成本 ≈ 805 µs、每列 ≈ 0.1 µs
   MyBatis 固定成本 ≈ 787 µs、每列 ≈ 0.3 µs
```

★★ **同一句 SQL、同一個投影 → 五個資料量上比值都在 0.97～1.02。**

```
🔴 那個「兩倍」不見了。
   而它不見的原因是這一節【換掉了兩件事】：
      ① 不用 Specification，直接寫 JPQL（沒有 Criteria 的翻譯）
      ② 不回 OrderView（沒有實體、沒有 lines）
                              ↓
📌 也就是說：08 章 8.10.2 那個兩倍，是【那兩件事】的成本，
   而不是「Hibernate 比 MyBatis 慢」。
```

⚠️ **而這張表還有一件事更值得注意：斜率幾乎是 0。**

```
1 列 805 µs、200 列 827 µs → 多 199 列只多 22 µs
                              ↓
也就是說：這個量級的查詢，成本【幾乎全部是固定成本】。
而固定成本裡最大的一塊是什麼？—— 下一節。
```

### 9.4.1c ★★ 實測：那 800 µs 裡有多少是交易

```java
    /** 在【同一個交易裡】把同一句查詢跑 rounds 次，回傳最快的那一次（µs）。 */
    private long inTxBest(int rounds, IntConsumer body) {
        return tx.execute(s -> {
            for (int i = 0; i < 10; i++) body.accept(i);       // 暖機
            long best = Long.MAX_VALUE;
            for (int i = 0; i < rounds; i++) {
                long t0 = System.nanoTime();
                body.accept(i);
                best = Math.min(best, System.nanoTime() - t0);
            }
            return best / 1000;
        });
    }

    @Test
    void b1c_那一毫秒有多少是交易() {
        // ⚠️ 每一次都換 offset —— 否則 MyBatis 的一級快取（07 章 7.11.4）會讓它 0 句 SQL
        long jpaIn = inTxBest(200, i -> em.createQuery(jpql, OrderListRow.class)
                .setParameter("st", OrderStatus.PENDING)
                .setFirstResult(i % 20).setMaxResults(20).getResultList());
        long mbIn = inTxBest(200, i -> query.listRows(OrderStatus.PENDING, i % 20, 20));
        …
    }
```

```
═══ 9.4.1c 把交易成本扣掉 —— 兩個框架的【一句查詢】各要多久 ═══

                                            JPA    MyBatis
  一個交易一次查詢（含 begin/commit）               1085 µs     1251 µs
  同一個交易裡的一句查詢                             469 µs        8 µs
  → 交易本身                                  616 µs     1243 µs

  🔴 MyBatis 那個 8 µs 是【一級快取命中】—— 這把尺騙了我一次
   （同一個交易裡、同一個 statement、同一組參數 → 07 章 7.11.4）
```

🔴 **8 µs。而它是假的。**

```
我以為「每一次換 offset」就避開了快取，而 offset 只有 20 種：
   暖機 10 次 + 量 200 次，跑的是 i % 20 →
   前 20 次把 20 種參數組合【全部放進一級快取】，
   後面 190 次全部命中，min 當然是快取命中的那一次。
                              ↓
📌 這是這一章第一次「量尺騙人」，而它跟 08 章 8.12.3 那三次是同一個家族：
   ① Dyn.args 用 HashMap（8.3.11b）
   ② SqlSpy 與 Dyn 對 PageHelper 的看法不同（8.6.3）
   ③ 延遲載入的句數取決於交易裡之前查過什麼（8.5.9）
   ④ ★ 這一次：在同一個交易裡重複量，量到的是【快取】
```

✅ **修好的方法：暖機在【另一個交易】裡做，量的時候每一組參數只跑一次。**

```java
    /**
     * ★ 修好的版本：暖機在【另一個交易】裡做，量的時候每一組參數只跑一次。
     *   理由：MyBatis 的一級快取是【每個 SqlSession 一份】（07 章 7.11.4），
     *   而 Spring 的交易邊界就是 SqlSession 的邊界。
     */
    private long inTxBestFresh(int distinct, IntConsumer body) {
        tx.executeWithoutResult(s -> { for (int i = 0; i < 100; i++) body.accept(i % distinct); });
        return tx.execute(s -> {
            long best = Long.MAX_VALUE;
            for (int i = 0; i < distinct; i++) {
                long t0 = System.nanoTime();
                body.accept(i);
                best = Math.min(best, System.nanoTime() - t0);
            }
            return best / 1000;
        });
    }
```

```
── 修好：暖機在另一個交易裡做，量的時候每一組參數只跑一次
   JPA     一句查詢 480 µs
   MyBatis 一句查詢 518 µs
   📌 MyBatis / JPA = 0.93×
```

★★ **這是帳二的答案**：

```
同一句 SQL、同一個投影、同樣的交易條件、同樣避開快取：
   JPA 480 µs、MyBatis 518 µs —— JPA 還快一點（在誤差內）。
                              ↓
而「一個交易一次查詢」是 1085 / 1251 µs
   → 交易本身（begin / commit / 連線取得 / 歸還）花了 600～750 µs，
     也就是【比那句查詢本身還貴】。
```

📌 **那把 08 章 8.10.2 那兩條路擺回來，多做的事就很清楚了**：

```
── 而 08 章 8.10.2 量的那兩條路，多做了什麼（每一次都是新交易）
   Specification + 投影介面 + OrderView     2101 µs、2 句、21 個實體
   MyBatis <if> + record + PageResult      1538 µs、2 句、0 個實體
```

| 那 563 µs 的差別 | 來自 |
|---|---|
| `Specification` → Criteria → HQL → SQL 的**三層翻譯** | JPA 那一側，每一次呼叫都做 |
| Spring Data 的**動態投影代理**（`findBy(spec, q -> q.project(…))`） | JPA 那一側 |
| **建 21 個實體**（`OrderView.of` 要碰 `lines`） | JPA 那一側 |
| 而 MyBatis 那一側多做了一句 **count**（08 章 8.3.12 那個共用 `<sql>`） | MyBatis 那一側 |

⚠️ **而我試著「把交易扣掉再比這兩條路」，扣出來的是兩個框架各自的快取**：

```
── ⚠️ 我想把交易扣掉，而扣出來的是【兩個框架各自的快取】
   JPA 在同一個交易裡連續呼叫三次 search()：
      第 1 次 → 2 句 SQL
      第 2 次 → 1 句 SQL
      第 3 次 → 1 句 SQL
   MyBatis 在同一個交易裡連續呼叫三次 searchRows()：
      第 1 次 → 2 句 SQL
      第 2 次 → 0 句 SQL
      第 3 次 → 0 句 SQL
   📌 所以「交易內」那兩個數字【不能拿來比】——
      JPA 的持久化情境與 MyBatis 的一級快取，各自把第二次以後的查詢吃掉了。
      這兩條路只能在【真實的交易邊界】上比，而那個比較就是 8.10.2。
```

★★ **這六行是整章我最喜歡的一段，因為它把兩個框架的「狀態」放在同一個畫面上**：

```
JPA     第 2 次 → 1 句
   主查詢還是要跑（JPQL 不吃一級快取，03 章 3.3.4），
   而那 21 個實體已經在 PC 裡 → 明細的批次撈那一句不見了。

MyBatis 第 2 次 → 0 句
   整個 statement + 參數組合命中一級快取（07 章 7.11）→ 連主查詢都不跑。
                              ↓
📌 兩個框架都有「狀態」，而它們的粒度不一樣：
   JPA 快取【物件】（所以查詢還是會跑，只是不重建物件）
   MyBatis 快取【查詢結果】（所以查詢不跑）
                              ↓
而 00 章 0.6.7 軸二寫的是「JPA 有狀態、MyBatis 無」——
這一格是那句話唯一要補的地方：MyBatis 有【交易範圍內的查詢快取】，
它只是沒有【物件的身分】。
```

### 9.4.2 ★★ 實測：那個「兩倍」在有併發的時候是多少

**單執行緒的效能數字，最常被誤用的地方是「乘上 QPS」。**
**這一節直接量吞吐：1 / 2 / 4 / 8 / 16 條執行緒，各跑 1.2 秒，數完成幾次。**

```java
    @Test
    void b2_併發下的兩倍() throws Exception {
        head("9.4.2 ★★ 那個兩倍，在有併發的時候是多少");
        System.out.println("  連線池 maximum-pool-size = 10（application.yml）");

        for (int threads : new int[]{1, 2, 4, 8, 16}) {
            long jpaOps = throughput(threads, 1200,
                    () -> tx.execute(s -> orders.list(OrderStatus.PENDING, 0, 20)).size());
            long mbOps = throughput(threads, 1200,
                    () -> tx.execute(s -> query.listRows(OrderStatus.PENDING, 0, 20)).size());
            …
        }
    }

    /** 跑 millis 毫秒，回傳每秒完成幾次。 */
    private long throughput(int threads, long millis, Callable<Integer> task) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        AtomicLong done = new AtomicLong();
        for (int i = 0; i < 20; i++) task.call();              // 暖機
        long end = System.nanoTime() + millis * 1_000_000L;
        List<Future<?>> fs = new ArrayList<>();
        for (int t = 0; t < threads; t++)
            fs.add(pool.submit(() -> {
                while (System.nanoTime() < end) { task.call(); done.incrementAndGet(); }
            }));
        for (Future<?> f : fs) f.get();
        pool.shutdown();
        return done.get() * 1000 / millis;
    }
```

```
═══ 9.4.2 ★★ 那個兩倍，在有併發的時候是多少 ═══
  連線池 maximum-pool-size = 10（application.yml）
   1 條執行緒 │ JPA 投影    725 次/秒   MyBatis    912 次/秒   MyBatis / JPA = 1.26×
   2 條執行緒 │ JPA 投影   1458 次/秒   MyBatis   2109 次/秒   MyBatis / JPA = 1.45×
   4 條執行緒 │ JPA 投影   2331 次/秒   MyBatis   2483 次/秒   MyBatis / JPA = 1.07×
   8 條執行緒 │ JPA 投影   3108 次/秒   MyBatis   4292 次/秒   MyBatis / JPA = 1.38×
  16 條執行緒 │ JPA 投影   3672 次/秒   MyBatis   3668 次/秒   MyBatis / JPA = 1.00×
```

**三個觀察**：

**① 比值在 1.00～1.45 之間跳，而它【沒有趨勢】。**

```
1 條 1.26×、2 條 1.45×、4 條 1.07×、8 條 1.38×、16 條 1.00×
                              ↓
📌 這種「沒有趨勢的抖動」本身就是一個結論：
   在這個規模上，兩個框架的差別【小於量測噪音】。
   而噪音來自哪裡？—— 連線池的競爭、MySQL 的排程、JIT、GC。
```

**② 16 條執行緒的時候兩邊都停在 3670 次/秒。**

```
連線池只有 10 條連線 → 16 條執行緒有 6 條永遠在等連線。
                              ↓
瓶頸從【應用程式】搬到【連線池 + 資料庫】，
而那個瓶頸【兩個框架共用】。
                              ↓
📌 這就是「常數倍不重要」最直接的證據：
   當你的系統開始有負載，決定吞吐的是連線數與資料庫，
   不是「誰的每一列處理成本低 0.2 µs」。
```

**③ 而 8 條執行緒時吞吐只有 1 條的 4.3 倍（不是 8 倍）。**

```
725 → 3108（JPA）、912 → 4292（MyBatis）
                              ↓
本機的 MySQL 與 JVM 在同一台機器上搶 CPU。
📌 這一格提醒的是：這一章所有的效能數字都是【本機、單機、同一台】——
   而真實環境的網路往返（0.5～2 ms）會把「框架的差別」壓得更小。
```

### 9.4.3 實測：把那個差別放進一支真的 API

**一支列表 API 通常做四件事：查資料 → 轉 JSON → 呼叫一個外部服務 → 回應。**

```java
    @Test
    void b3_一支API裡那三毫秒佔多少() {
        long jpaDb = bestMicros(() -> tx.executeWithoutResult(s -> orders.search(FIVE, 0, 20)), 5, 15);
        long mbDb  = bestMicros(() -> tx.executeWithoutResult(s -> orders.searchRows(FIVE, 0, 20)), 5, 15);
        var rows = tx.execute(s -> orders.searchRows(FIVE, 0, 20)).content();
        long ser = bestMicros(() -> json.writeValueAsString(rows), 5, 15);
        long ext = bestMicros(() -> Thread.sleep(50), 1, 3);   // 一次外部呼叫
        …
    }
```

```
═══ 9.4.3 把那個差別放進一支【真的 API】 ═══

  查資料（JPA）          1572 µs
  查資料（MyBatis）      1080 µs
  轉 JSON（20 筆）         59 µs
  一次外部呼叫（50 ms） 51188 µs

  端到端：JPA 52819 µs、MyBatis 52327 µs → 差 492 µs（0.9%）
  而在【只有查資料】的那一段裡，差 492 µs（31%）
```

📌 **同一個 492 µs，兩個百分比**：

```
在「查資料」這一段裡：31%   ← 這是 07 / 08 章量到的那個世界
在整支 API 裡：       0.9%  ← 這是使用者感受到的那個世界
                              ↓
而那支 API 有一次 50 ms 的外部呼叫 —— 那是最保守的假設。
真實的列表 API 常常有：一次認證檢查、一次權限查詢、一次快取查詢、
一次稽核寫入，加上網路往返。
```

⚠️ **反過來說：如果一支 API【沒有】那 50 ms，那 31% 就是真的。**

```
✅ 那個 31% 真的重要的場景：
   ① 純資料層的批次作業（沒有網路、沒有外部呼叫、跑 8 小時）
   ② 一個請求打 20 次資料庫的 API（那 492 µs × 20 = 10 ms）
   ③ 極高 QPS 的內部服務（而那時候 9.4.2 說瓶頸在連線池）
                              ↓
📌 所以「效能」不是一個判準，「效能在哪一段」才是。
```

### 9.4.4 ★★ 實測：量級與常數倍 —— 同一個錯誤在兩個框架上都犯一次

**00 章 0.8.3 那句話**：

> **「選型的差別是常數倍，寫法的差別是量級。」**

**這一節在同一個固定裝置上，把「一列一句查詢」在兩個框架上各犯一次。**

```java
    @Test
    void b4_量級與常數倍() {
        head("9.4.4 同一頁，把「一列一句查詢」在【兩個框架】上都犯一次");

        Runnable jpaGood = () -> tx.executeWithoutResult(s -> orders.list(OrderStatus.PENDING, 0, 20));
        Runnable mbGood  = () -> tx.executeWithoutResult(s -> query.listRows(OrderStatus.PENDING, 0, 20));

        // ❌ 一列一句：兩個框架都會這樣寫
        Runnable jpaBad = () -> tx.executeWithoutResult(s -> {
            var rows = orders.list(OrderStatus.PENDING, 0, 20);
            for (OrderListRow r : rows)
                em.createQuery("select count(i) from OrderItem i where i.order.id = :id", Long.class)
                        .setParameter("id", r.id()).getSingleResult();
        });
        Runnable mbBad = () -> tx.executeWithoutResult(s -> {
            var rows = query.listRows(OrderStatus.PENDING, 0, 20);
            for (OrderListRow r : rows) mix.countItems(r.id());
        });
        …
    }
```

```
═══ 9.4.4 同一頁，把「一列一句查詢」在【兩個框架】上都犯一次 ═══

  寫法                                SQL         耗時           配置
  JPA 一句撈齊（05 章）                    2 句     1541 µs      80.0 KB
  MyBatis 一句撈齊（07 章）                1 句      954 µs      98.1 KB
  JPA + 一列一句                       22 句     5475 µs     350.8 KB
  MyBatis + 一列一句                   21 句     4328 µs     418.9 KB
```

★★ **把這四個數字排成一句話**：

```
選型的差別（同一種寫法，換框架）：1541 → 954 µs      = 1.6 倍
寫法的差別（同一個框架，換寫法）：954 → 4328 µs      = 4.5 倍
                              ↓
🔴 而最重要的那一格是【對角線】：
   MyBatis 寫錯（4328 µs）比 JPA 寫對（1541 µs）慢 2.8 倍。
                              ↓
📌 也就是說：選型帶來的優勢，【一個錯誤的寫法就吃掉了】。
   而這只是 20 筆的一頁 —— 04 章那個 251 句的版本是 66 ms（43 倍）。
```

⚠️ **而配置那一欄說了同一件事**：

```
80 KB → 350 KB（JPA）、98 KB → 418 KB（MyBatis）
                              ↓
「一列一句」在兩個框架上都是 4 倍多的配置。
而那 20 句多出來的查詢，每一句都要：組 SQL、拿連線（同一條）、
建 PreparedStatement、走一次網路、建結果物件。
                              ↓
📌 這一格也回答了「MyBatis 不會 N+1」這個常見的誤解 ——
   N+1 不是 ORM 的病，是【迴圈裡查詢】的病。
   MyBatis 只是不會【自動】幫你做（04 章 4.1），
   而它也不會阻止你手動做。
```

### 9.4.5 實測：那個常數倍什麼時候真的是理由 —— 匯出 12500 列

**9.4.1b 說「斜率幾乎是 0」，那是因為 200 列太少。**
**這一節把資料量拉到 12500 列（5 萬張訂單裡的 PENDING）。**

```java
package com.example.lab.ch09;

import com.example.lab.shop.Order;
import com.example.lab.shop.OrderListRow;
import com.example.lab.shop.OrderStatus;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import java.util.concurrent.atomic.AtomicLong;

/**
 * ⚠️ 這個類別自己一個 context（URL 多了 rewriteBatchedStatements）——
 *    因為它要塞 5 萬張訂單，而 06 章 6.3.6 證明沒有那個參數的批次是假的。
 */
@SpringBootTest(properties = {
  "spring.datasource.url=jdbc:mysql://127.0.0.1:33306/shop?connectionTimeZone=UTC"
      + "&forceConnectionTimeZoneToSession=true&preserveInstants=true&characterEncoding=UTF-8"
      + "&rewriteBatchedStatements=true",
  "spring.jpa.properties.hibernate.generate_statistics=true"
})
class P2bExport extends Base09 {

    @Autowired Mix9Mapper mix;
    @Autowired org.apache.ibatis.session.SqlSessionFactory ssf;

    static final int ORDERS = 50_000;

    @BeforeEach void setUp() {
        if (jdbc.queryForObject("SELECT count(*) FROM orders", Long.class) != (long) ORDERS) {
            System.out.println("（重建固定裝置：" + ORDERS + " 張訂單、沒有明細）");
            long t0 = System.currentTimeMillis();
            seed(ORDERS, 100, 0);
            System.out.println("（塞完，耗時 " + (System.currentTimeMillis() - t0) + " ms）");
        }
    }

    @Test
    void b5_匯出兩萬五千列() {
        long total = jdbc.queryForObject(
                "SELECT count(*) FROM orders WHERE status = 'PENDING'", Long.class);
        head("9.4.5 匯出 " + total + " 列 —— 那個常數倍變成什麼");

        // ① JPA：撈實體 + 每 1000 筆 clear（教科書寫法）
        Runnable jpaEntity = () -> tx.executeWithoutResult(s -> {
            AtomicLong sum = new AtomicLong();
            var it = em.createQuery("select o from Order o where o.status = :st", Order.class)
                    .setParameter("st", OrderStatus.PENDING)
                    .setHint("org.hibernate.fetchSize", Integer.MIN_VALUE)
                    .getResultStream().iterator();
            int n = 0;
            while (it.hasNext()) {
                Order o = it.next();
                sum.addAndGet(o.getOrderNo().length());
                if (++n % 1000 == 0) em.clear();
            }
        });

        // ② JPA：投影 + 資料流
        Runnable jpaRow = () -> tx.executeWithoutResult(s -> {
            AtomicLong sum = new AtomicLong();
            em.createQuery("""
                    select new com.example.lab.shop.OrderListRow(
                             o.id, o.orderNo, c.displayName, o.status, o.totalAmount, o.placedAt, 0L)
                      from Order o join o.customer c where o.status = :st order by o.placedAt
                    """, OrderListRow.class)
                    .setParameter("st", OrderStatus.PENDING)
                    .setHint("org.hibernate.fetchSize", Integer.MIN_VALUE)
                    .getResultStream().forEach(r -> sum.addAndGet(r.orderNo().length()));
        });

        // ③ MyBatis：ResultHandler（一列一列）
        Runnable mbStream = () -> tx.executeWithoutResult(s -> {
            AtomicLong sum = new AtomicLong();
            mix.streamRows(OrderStatus.PENDING, ctx -> sum.addAndGet(
                    ctx.getResultObject().orderNo().length()));
        });

        // ④ MyBatis：整批回傳（對照組）
        Runnable mbAll = () -> tx.executeWithoutResult(s -> {
            AtomicLong sum = new AtomicLong();
            for (OrderListRow r : mix.allRows(OrderStatus.PENDING)) sum.addAndGet(r.orderNo().length());
        });

        // ⑤ JdbcTemplate：RowCallbackHandler（基線）
        Runnable jt = () -> {
            AtomicLong sum = new AtomicLong();
            jdbc.setFetchSize(Integer.MIN_VALUE);
            // ★ 跟上面四個【選一樣的欄位、建一樣的 record】，否則這條基線不公平
            jdbc.query("SELECT o.id, o.order_no, c.display_name AS customer_name, o.status,"
                    + " o.total_amount, o.placed_at, 0 AS item_count"
                    + " FROM orders o JOIN customer c ON c.id = o.customer_id"
                    + " WHERE o.status = 'PENDING' ORDER BY o.placed_at",
                    rs -> {
                        OrderListRow r = new OrderListRow(
                                com.example.lab.Uuid7.fromBytes(rs.getBytes(1)),
                                rs.getString(2), rs.getString(3),
                                OrderStatus.valueOf(rs.getString(4)),
                                rs.getBigDecimal(5),
                                rs.getObject(6, java.time.LocalDateTime.class)
                                        .toInstant(java.time.ZoneOffset.UTC),
                                rs.getLong(7));
                        sum.addAndGet(r.orderNo().length());
                    });
            jdbc.setFetchSize(-1);
        };

        System.out.printf("%n  %-34s %10s %14s%n", "寫法", "耗時", "配置");
        for (var w : new Object[][]{
                {"JPA 實體 + 每 1000 筆 clear", jpaEntity},
                {"JPA 投影 + 資料流", jpaRow},
                {"MyBatis ResultHandler（資料流）", mbStream},
                {"MyBatis 整批 List", mbAll},
                {"JdbcTemplate RowCallbackHandler", jt}}) {
            String label = (String) w[0];
            Runnable r = (Runnable) w[1];
            long ms = bestMs(r, 1, 3);
            long bytes = Alloc.bestBytes(r, 1, 3);
            System.out.printf("  %-34s %8d ms %14s%n", label, ms, Alloc.mb(bytes));
        }

        sub("換算成「每一列的成本」");
        System.out.println("   （上面那幾個數字除以 " + total + "）");
    }
}
```

```
═══ 9.4.5 匯出 12500 列 —— 那個常數倍變成什麼 ═══

  寫法                                         耗時             配置
  JPA 實體 + 每 1000 筆 clear                 133 ms        47.9 MB
  JPA 投影 + 資料流                             62 ms        15.7 MB
  MyBatis ResultHandler（資料流）               54 ms        30.7 MB
  MyBatis 整批 List                          51 ms        35.7 MB
  JdbcTemplate RowCallbackHandler          40 ms         7.6 MB
```

**四個發現**：

**① JPA 投影（62 ms）與 MyBatis（51～54 ms）差 20% —— 不是兩倍。**

```
12500 列、七個欄位、同一句 SQL：
   JPA 投影 62 ms  ≈ 4.96 µs / 列
   MyBatis  51 ms  ≈ 4.08 µs / 列
                              ↓
📌 每一列的處理成本差 0.9 µs。
   而 9.4.1b 在 200 列上量到的斜率差是 0.2 µs —— 同一個量級。
```

**② 而「實體 vs 投影」是 2.1 倍（133 vs 62 ms）、3 倍的配置（47.9 vs 15.7 MB）。**

```
🔴 這就是帳二的最終答案：
   那個「兩倍」是【實體】的兩倍，不是【框架】的兩倍。
   而 MyBatis 之所以「看起來」快兩倍，是因為
   它【沒有辦法】建實體 —— 也就是它強迫你走那條快的路。
                              ↓
✅ 反過來說：JPA 走同一條路（投影），數字就一樣。
   而 05 章 5.8 那一節就是在教這件事。
```

**③ MyBatis 的資料流（`ResultHandler`）沒有比整批省記憶體。**

```
ResultHandler + fetchSize=Integer.MIN_VALUE  54 ms / 30.7 MB
整批 List                                     51 ms / 35.7 MB
                              ↓
只省了 14% 的【配置】。
為什麼？—— 資料流省的是「同時活著的物件數」（存活），
不是「總共建了幾個物件」（配置）。而第六把尺量的是後者（9.2.2 注意事項③）。
                              ↓
📌 所以「匯出大量資料要用 ResultHandler」這句話是對的，
   而它對的地方是【峰值記憶體】—— 那要用 heap dump 或 GC log 去看，不是這把尺。
```

**④ 而 JdbcTemplate 是 40 ms / 7.6 MB —— 兩個框架都有 25%～50% 的空間。**

```
40 ms  vs  51 ms（MyBatis）  vs  62 ms（JPA 投影）
7.6 MB vs 30.7 MB            vs 15.7 MB
                              ↓
⚠️ 配置那一欄要小心讀：JdbcTemplate 那一版沒有
   ① MyBatis 的一級快取（它把每一列都留了一份）
   ② Hibernate 的 SQM / 執行計畫快取
   而那兩件事在【一次性的匯出】裡是純成本，在【重複查詢的 API】裡是收益。
```

📌 **9.10 會回到這一格 —— 而它的結論是：**

> **「兩個都不選」在【匯出、批次、單一熱點查詢】上有 25%～50% 的空間。**
> **而在一支正常的 API 上（9.4.3），那個空間是 0.9%。**

### 9.4.6 帳二的結案

```
帳二：「快 2.3 倍」這種不該當理由的理由（00 章 0.8.3）
                              ↓
09 章把那個兩倍拆成四塊：

   ① 交易（begin / commit / 連線）      600～750 µs   ← 兩邊都付
   ② 一句查詢本身                        480 / 518 µs  ← 兩邊【一樣】（0.93×）
   ③ Criteria / Specification 的翻譯     ~300 µs        ← 只有 JPA 付，而【可以不付】（寫 JPQL）
   ④ 建實體（21 個 / 90 個）             ~260 µs / 400 KB ← 只有 JPA 付，而【可以不付】（投影）
                              ↓
📌 所以那個「兩倍」的正確說法是：
   「Spring Data 的 Specification + 實體投影」比
   「MyBatis 的 <if> + record」慢兩倍 ——
   而那是【兩個具體的技術選擇】的差別，不是兩個框架的差別。
```

**把這一節的六個數字排在一起**：

| 場景 | JPA | MyBatis | 比值 | 在哪一節 |
|---|---|---|---|---|
| 同一句 SQL、同一個投影（1～200 列） | 480 µs | 518 µs | **0.93×** | 9.4.1b / c |
| 08 章那兩條路（新交易、含翻譯與實體） | 2101 µs | 1538 µs | 1.37× | 9.4.1c |
| 併發 1～16 條執行緒的吞吐 | 725～3672/s | 912～4292/s | **1.00～1.45×** | 9.4.2 |
| 一支有 50 ms 外部呼叫的 API | 52819 µs | 52327 µs | **1.01×** | 9.4.3 |
| 匯出 12500 列（投影 vs record） | 62 ms | 51 ms | 1.22× | 9.4.5 |
| **同一個框架，一句撈齊 vs 一列一句** | **1541 → 5475 µs** | **954 → 4328 µs** | **3.6× / 4.5×** | 9.4.4 |

> 📌 **最後一列比前面五列加起來重要。**
>
> **而它是這一站從 00 章 0.3.2 那 251 句開始就在講的同一件事。**

---

## 9.5 「快」與「省事」是兩個問題

08 章 8.13 交待給 09 章的第二件事寫著：

> ② 「什麼場景 JPA 快、什麼場景 MyBatis 省事」—— 而「快」與「省事」是不同的問題

**9.4 已經把「快」處理完了：在這一站量得到的所有場景上，它是 1.0～1.4 倍。**
**這一節處理「省事」，而它需要三把不同的尺。**

### 9.5.1 「省事」的三個成分

```
① 寫的時候省事    → 幾行程式碼、幾個檔案（9.5.2 量）
② 改的時候省事    → 一個需求變更要動幾個地方（9.5.3 量）
③ 出事的時候省事  → 錯誤【什麼時候】被發現、訊息指到哪裡（9.5.4 量）
                              ↓
⚠️ 這三個常常【方向相反】，而那正是選型難的地方：
   MyBatis 在①上贏（查詢），在③上輸（全部推遲到執行期）
   JPA 在②上贏（改一個方法簽章），在①上輸（要先有映射）
```

### 9.5.2 實測：同一個查詢，五種寫法各幾行

**計算方式**：非空白、非註解的行數，用一個小腳本從**實際的檔案**數出來
（不是估的 —— 這些檔案都在 `lab08` 專案裡）。

```python
def clean(lines):        # 去掉空白行、// 註解、/* */ 區塊、XML 註解
    …
def cnt(path, start_pat, end_pat):
    src = open(path).read().split('\n')
    i = next(k for k, l in enumerate(src) if re.search(start_pat, l))
    j = next(k for k, l in enumerate(src[i:], i) if re.search(end_pat, l))
    return len(clean(src[i:j+1]))
```

**讀取側：那一頁「20 筆訂單列表」的五種寫法**

| 寫法 | 行數 | 內容 |
|---|---|---|
| **JPA**（`OrderRepository.listRows`） | **11** | 一個方法簽章 + 一段 JPQL 建構子運算式 |
| **MyBatis** | **25** | 介面方法 4 行 + XML（`<resultMap>` 12 行 + `<select>` 9 行） |
| **JdbcTemplate** | **24** | SQL 常數 10 行 + `RowMapper` 8 行 + 方法 6 行 |
| **純 JDBC** | **24** | 同上，而 `try-with-resources` 三層 + 例外轉換 |
| **jOOQ**（無 codegen） | **28** | 九個 `Field` 宣告 + 查詢建構 + `fetch` 的 lambda |

📌 **JPA 那 11 行，前提是「實體已經存在」**：

```
Order.java 135 行、OrderItem.java 50 行、Customer.java 35 行 = 220 行的映射
                              ↓
⚠️ 所以「11 行 vs 25 行」這個比較【只在實體已經存在的時候】成立。
✅ 而在 shop-service 上它成立 —— 那 220 行同時服務：
      寫入路徑（place / pay / cancel / addItem）
      明細頁（@EntityGraph）
      11 條不變量（01 章 1.13）
   也就是說那 220 行【不是為了這個列表頁寫的】。

🔴 反過來，如果你的專案【只有查詢】（報表系統、BI、資料匯出），
   那 220 行就是純成本 —— 而那正是 00 章 0.8.2 判準 1 在講的事。
```

**寫入側：`place()` + `pay()`（9.7.2 會詳細看這兩個方法）**

| 寫法 | 行數 | 內容 |
|---|---|---|
| **JPA**（`OrderService`） | **17** | 兩個方法，而狀態機在 `Order.pay()` 裡（01～06 章寫的） |
| **MyBatis** | **63** | Service 23 行 + mapper 介面 12 行 + XML 28 行 |

```
17 → 63 行 = 3.7 倍。
而那 46 行多出來的東西，9.7.2 會一件一件列出來（一共六件）。
                              ↓
📌 對照讀取側的 11 → 25 行（2.3 倍），形狀很清楚：
   ✅ 讀取側，MyBatis 的成本是「多寫一份映射」——【線性的】
   🔴 寫入側，MyBatis 的成本是「把框架幫你做的事自己做一遍」——
      而那些事有【正確性】，不只是行數（樂觀鎖、狀態機的位置、聚合的一致性）
```

### 9.5.3 「改的時候省事」：一個需求變更要動幾個地方

**需求**：列表頁要多顯示一個欄位（幣別 `currency`）。

| 步驟 | JPA 那一側 | MyBatis 那一側 |
|---|---|---|
| ① DTO 加一個元素 | `OrderListRow` +1 | **同一個檔案**（兩邊共用！） |
| ② 查詢 | JPQL 的建構子運算式 +1 個參數 | `<select>` 的欄位清單 +1 |
| ③ 映射 | **不用**（建構子運算式自己對應） | `<resultMap><constructor>` **+1 個 `<arg>`** |
| ④ 實體 | `Order.currency` **已經有了**（01 章的映射） | — |
| **改幾個地方** | **2** | **2** |
| **忘了改的下場** | 🔴 **啟動失敗**（`@Query` 的建構子參數對不上，05 章 5.13.1） | 🔴 **執行期**：`<arg>` 少一個 → 找不到對應的建構子 |

⚠️ **而這一格有一個 08 章沒講的陷阱：兩個框架共用同一個 `record`。**

```
07 章 7.15 刻意讓 MyBatis 回傳 05 章那個 OrderListRow（「同一個 DTO，兩個框架都填得出來」）
                              ↓
✅ 好處：兩邊的結果可以直接 equals()（8.10.2 / 9.9.2 的契約測試靠這個）
🔴 代價：那個 record 是【兩個實作的共同耦合點】——
        改它會同時打到兩邊，而「只有一邊被改對」的情況【編譯得過】
        （因為 MyBatis 那一側的映射在 XML 裡，編譯器看不到）
```

### 9.5.4 實測：「出事的時候省事」—— 欄位名打錯，誰什麼時候告訴你

⚠️ **這個實測的程式碼與輸出屬於 9.10（「兩個都不選」那一節）——
因為它一次量六種寫法，而其中三種要等到 9.10 才登場。
這裡先看結果，9.10.2 會補上 jOOQ 那兩格的細節。**

```java
    @Test
    void f1_同一頁六種寫法的錯誤什麼時候被發現() {
        head("9.10.2 欄位名打錯 —— 六種寫法各自什麼時候告訴你");

        sub("① JPA（JPQL 字串）：em.createQuery 裡把屬性名打錯");
        Throwable t1 = catchingTx(() -> em.createQuery(
                "select o.orderNu from Order o", String.class).setMaxResults(1).getResultList());

        sub("② MyBatis（XML）：SELECT order_nu");
        Throwable t2 = catchingTx(() -> mix.badColumn());

        sub("③ JdbcTemplate");
        Throwable t3 = catching(() -> jdbc.queryForList("SELECT order_nu FROM orders LIMIT 1"));

        sub("④ jOOQ（沒有 codegen）");
        Throwable t4 = catching(() -> jooq.badColumn());

        sub("⑤ jOOQ 的型別呢：把 decimal(19,4) 綁成 String");
        Object v = jooq.amountAsString();
        …
    }
```

```
═══ 9.10.2 欄位名打錯 —— 六種寫法各自什麼時候告訴你 ═══

── ① JPA（JPQL 字串）：em.createQuery 裡把屬性名打錯
   IllegalArgumentException ← PathElementException
   —— Could not resolve attribute 'orderNu' of 'com.example.lab.shop.Order'
   📌 而 @Query 註解上的同一個錯字是【啟動時】被擋下來的（05 章 5.13.1）

── ② MyBatis（XML）：SELECT order_nu
   BadSqlGrammarException ← SQLSyntaxErrorException
   —— Unknown column 'order_nu' in 'field list'

── ③ JdbcTemplate
   BadSqlGrammarException ← SQLSyntaxErrorException
   —— Unknown column 'order_nu' in 'field list'

── ④ jOOQ（沒有 codegen）
   DataAccessException ← SQLSyntaxErrorException
   —— Unknown column 'o.order_nu' in 'field list'
   📌 有 codegen 的 jOOQ 這一格是【編譯錯誤】—— 而那要在建置流程裡
      接一個「連資料庫產生 Java」的步驟

── ⑤ jOOQ 的型別呢：把 decimal(19,4) 綁成 String
   讀回來 = 300.0000（String）→ 🔴 它【靜默轉換】，不報錯
```

**六種寫法的「錯誤何時被發現」總表**：

| 錯誤 | JPA `@Query` | JPA `createQuery` | MyBatis | JdbcTemplate | jOOQ（無 codegen） | jOOQ（有 codegen） |
|---|---|---|---|---|---|---|
| **屬性 / 欄位名打錯** | **啟動期** | 執行期（那一句） | 執行期 | 執行期 | 執行期 | **編譯期** |
| SQL 語法錯 | 啟動期 | 執行期 | 執行期 | 執行期 | **不可能**（DSL 產生語法） | 不可能 |
| 參數少一個 | 啟動期 | 執行期 | 🔴 執行期，**而有時候不報**（08 章 8.3.11b） | 執行期 | 編譯期 | 編譯期 |
| **型別對不上** | 執行期 | 執行期 | 🔴 **靜默 null**（07 章 7.8.1） | 執行期 | 🔴 **靜默轉換**（本節 ⑤） | **編譯期** |
| 表改名了 | 啟動期（`validate`，01 章 1.10） | 同 | 執行期 | 執行期 | 執行期 | **編譯期** |

📌 **這張表是「省事」的第三個成分，而它的形狀很清楚**：

```
編譯期  ←──────────────────────────────────────→  執行期
jOOQ+codegen    JPA @Query        JdbcTemplate / MyBatis / jOOQ 無 codegen
（要 codegen）  （要啟動 + DB）    （要跑到那一句）
                              ↓
而每往左一格，你付的代價是【建置流程的複雜度】：
   JPA @Query 的啟動期檢查 → 要一個能啟動的 context（不用真的 DB，但要 metamodel）
   jOOQ 的編譯期檢查      → 要一個【建置時能連的資料庫】或一份 migration 腳本
```

### 9.5.5 六個場景的最終對照（00 章 0.8.1 的九章版）

| 場景 | 00 章當時的判斷 | 九章之後的實測 | 誰佔優勢 |
|---|---|---|---|
| **A 讀出聚合、改狀態、寫回** | ✅ JPA（3 句 vs「自己寫」） | `pay()` **兩邊都 2 句 SQL**（9.7.2）。而 JPA 的狀態機在**領域物件**裡、MyBatis 的在 **Service** 裡 —— 後者**繞得過**（9.7.2） | ✅ **JPA**（理由從「句數」換成「不變量的位置」） |
| **B 建立一個聚合** | 🟡 MyBatis 略勝（句數） | `place()` **兩邊都 4 句**（9.7.2）。JPA 17 行 vs MyBatis 63 行 | ✅ **JPA**（`Persistable` 之後句數也一樣） |
| **C 列表頁 + 關聯** | ✅ MyBatis（9 ms vs 3 ms） | **1.00×**（9.4.1b）。配置：JPA 83 KB vs MyBatis 115 KB（9.3.2） | 🟡 **平手** |
| **D 報表** | ✅ MyBatis（形狀自由） | **兩邊 `equals()` 完全相等**（9.3.3）。理由換成「SQL 可以整段貼到 client 上跑」 | 🟡 **MyBatis 略勝**（可維護性，不是能力） |
| **E 批次寫入 5 萬筆** | ✅ MyBatis（行為直接） | 06 章：JPA 要開 `batch_size` + `rewriteBatchedStatements`，**四件事會讓它靜默失效**；08 章 8.4.5：MyBatis 一句 1000 組 `VALUES` = 22 ms | ✅ **MyBatis**（**這一格沒有改**） |
| **F 條件式搜尋** | 🟡 平手 | 三個實作同一組結果（9.9.4）：Specification+實體 1642 µs / MyBatis 1028 µs / **Specification+投影 1362 µs** | 🟡 **平手**，而**收斂的方式**是 9.9 的主題 |

⚠️ **注意這張表的形狀怎麼變了**：

```
00 章：JPA 贏「寫入一個有結構的東西」、MyBatis 贏「讀出一個特定形狀的東西」
                              ↓
09 章：JPA 那一半【變強了】（B 從 🟡 變 ✅）
      MyBatis 那一半【變弱了】（C 從 ✅ 變 🟡、D 從「能力」變「可維護性」）
      而 E 完全沒有動 —— 批次寫入是 MyBatis 唯一【毫無爭議】的一格
                              ↓
📌 為什麼會這樣？因為 00 章那張表比的是「預設的用法」，
   而 01～08 章教的每一件事，都是在【把 JPA 的預設用法換掉】：
      Persistable（01 章）、@BatchSize（04 章）、投影（05 章）、
      批次組態（06 章）……
```

> 📌 **一句話**：
>
> **這張表在 00 章量的是「兩個框架」，在 09 章量的是「兩個框架 + 八章的知識」。**
> **而那八章的知識，大部分是加在 JPA 那一側的 ——**
> **因為 MyBatis 本來就沒有那麼多預設行為要你去改。**
>
> ✅ **這也是「省事」最誠實的說法**：
> **MyBatis 從第一天到第一百天都一樣費工；**
> **JPA 的前 80% 很省，而剩下 20% 的省事，要你付這八章的學費。**

---

## 9.6 混用的三種切法與失效模式 ★★

00 章 0.9 給了混用三條規則：

```
規則一：同一張表，只讓一個框架【寫】
規則二：JPA 寫完、MyBatis 讀之前，要 flush
規則三：讓「哪一邊管什麼」出現在套件結構上
```

**這一節做兩件事**：把那三條規則對應到**三種實際的切法**，
然後**把每一種切法的第一號地雷量出來**。

```
切法一：依【表】切     orders / order_item → JPA；legacy_* → MyBatis
切法二：依【用例】切   同一張表，A 用例走 JPA、B 用例走 MyBatis
切法三：依【讀寫】切   寫入一律 JPA、查詢一律 MyBatis（CQRS 的輕量版）
                              ↓
shop-service 用的是【切法三】（07 章 7.15：mybatis 套件裡只有讀）
而 08 章 8.10 開始有一點切法二的味道（search 與 searchRows 並存）
```

### 9.6.1 切法一（依表）：規則一的實測

```java
    @Test
    void c1_切法一依表_而有人越界() {
        head("9.6.1 切法一（依表）：規則是「一張表只讓一個框架寫」");
        UUID id = freshOrder();

        sub("① 遵守規則：JPA 寫、MyBatis 讀");
        orders.pay(id);
        System.out.println("   JPA     讀 status = " + repo.findById(id).orElseThrow().getStatus());
        System.out.println("   MyBatis 讀 status = " + mix.statusOf(id));

        sub("② 🔴 越界：MyBatis 也寫了那張表（而它不知道 version 這個約定）");
        UUID id2 = freshOrder();
        Throwable t = catching(() -> tx.executeWithoutResult(s -> {
            Order o = repo.findById(id2).orElseThrow();          // 交易 A 撈出來，version = 0
            newTx.executeWithoutResult(x -> {                    // 交易 B（REQUIRES_NEW）
                mix.bypassStatus(id2, OrderStatus.CANCELLED);    // 🔴 沒有動 version
            });
            o.pay();                                             // 交易 A 用【過時的狀態】做決定
        }));
        …
        sub("③ ✅ 修好：旁路寫入也維護 version（06 章 6.10.3 那條斷言）");
        // mix.bypassStatusKeepingVersion() —— 差別只有一句 SET version = version + 1
    }
```

那兩句 SQL（`Mix9Mapper.xml`，整份見 9.2.4）：

```xml
  <!-- 🔴 9.6.1 ②：這一句是 00 章 0.3.5 那個事故的來源 -->
  <update id="bypassStatus">
    UPDATE orders SET status = #{status} WHERE id = #{id}
  </update>

  <!-- ✅ 修好的版本：把 version 的約定也遵守 -->
  <update id="bypassStatusKeepingVersion">
    UPDATE orders SET status = #{status}, version = version + 1 WHERE id = #{id}
  </update>
```

```
═══ 9.6.1 切法一（依表）：規則是「一張表只讓一個框架寫」 ═══

── ① 遵守規則：JPA 寫、MyBatis 讀 —— 兩邊看到的一樣嗎
   JPA     讀 status = PAID
   MyBatis 讀 status = PAID
   version = 1

── ② 🔴 越界：MyBatis 也寫了那張表（而它不知道 version 這個約定）
   交易 A 撈到 status=PENDING
   交易 B（MyBatis）改成 CANCELLED、commit。資料庫 version = 0
   交易 A 呼叫 o.pay()（它以為 status 還是 PENDING）
   交易 A commit → 沒有例外
   最後資料庫裡是 status=PAID、version=1
   🔴 一張【已取消】的訂單變成 PAID，而沒有任何錯誤（00 章 0.3.5）

── ③ ✅ 修好：旁路寫入也維護 version（06 章 6.10.3 那條斷言）
   交易 B（MyBatis + version+1）→ version = 1
   交易 A commit → ObjectOptimisticLockingFailureException ← StaleObjectStateException
   最後資料庫裡是 status=CANCELLED
   ✅ 樂觀鎖擋下來了 —— 而它擋得住的前提是【那一行 version = version + 1】
```

**這是 00 章 0.3.5 那個事故的完整版，而 09 章補上了三件事**：

**① 事故的完整因果鏈（五步）**：

```
① 交易 A（JPA）撈出訂單 → 快照 status=PENDING、version=0
② 交易 B（MyBatis）UPDATE status='CANCELLED'，【沒有動 version】→ commit
③ 交易 A 呼叫 o.pay() —— 而 Order.pay() 檢查的是【記憶體裡那個 PENDING】
   （狀態機的規則沒有錯，錯的是它看的資料）
④ 交易 A commit → Hibernate 送出
   UPDATE orders SET status='PAID', … , version=1 WHERE id=? AND version=0
⑤ 資料庫裡的 version 還是 0 → 條件成立 → 影響 1 列 → 【沒有例外】
                              ↓
🔴 結果：一張使用者已經取消的訂單，變成「已付款」。
```

**② 修好它的那一行，就是 06 章 6.10.3 那條斷言在保護的東西**：

```
06 章 6.10.3「旁路 UPDATE 要維護 version」是一條【棘輪式】斷言
（掃所有 mapper 的 UPDATE，白名單以外的都要含 version = version + 1）
                              ↓
而 07 章 7.14.3 在 MyBatis 那一側也寫了同一條。
📌 這一節證明了它們為什麼要【兩邊都有】：
   那條斷言在 JPA 那一側叫「找出繞過 JPA 的寫入」，
   在 MyBatis 那一側叫「我自己就是那個繞過的人」。
```

**③ 而「修好」之後的行為要看清楚**：

```
交易 A commit → ObjectOptimisticLockingFailureException
最後資料庫裡是 status=CANCELLED（交易 B 的結果留下來了）
                              ↓
✅ 這才是正確的行為：後到的寫入被拒絕，而使用者會看到
   「這張訂單已經被修改過，請重新載入」——
   06 章 6.6.11 那個重試邏輯要處理的就是這一格。
```

### 9.6.2 🔴 切法二（依用例）：同一個交易裡的兩個世界

**切法二是最誘人的一種**：
「這個用例用 JPA 比較好寫、那個用例用 MyBatis 比較好寫，反正是同一張表。」

```java
    @Test
    void c2_切法二依用例_同一個交易裡的兩個世界() {
        head("9.6.2 切法二（依用例）：同一張表，A 用例走 JPA、B 用例走 MyBatis");
        UUID id = freshOrder();

        tx.executeWithoutResult(s -> {
            Order o = repo.findById(id).orElseThrow();
            System.out.println("  ① JPA 讀到 status = " + o.getStatus());

            var sqls = spy(() -> mix.bypassStatus(id, OrderStatus.CANCELLED));
            System.out.println("  ② MyBatis 在【同一個交易】裡改成 CANCELLED（" + sqls.size() + " 句）");
            System.out.println("     MyBatis 自己再讀一次 → " + mix.statusOf(id));

            System.out.println("  ③ JPA 再讀一次（同一個交易）：");
            int n = spy(() -> System.out.println("     em.find → "
                    + repo.findById(id).orElseThrow().getStatus())).size();

            System.out.println("  ④ 那用 JPQL 呢（它會 auto-flush，也會真的查資料庫）：");
            …
            System.out.println("  ⑤ em.refresh(o) 之後：");
            …
        });
    }
```

```
═══ 9.6.2 切法二（依用例）：同一張表，A 用例走 JPA、B 用例走 MyBatis ═══
  ① JPA 讀到 status = PENDING
  ② MyBatis 在【同一個交易】裡改成 CANCELLED（1 句）
     MyBatis 自己再讀一次 → CANCELLED
  ③ JPA 再讀一次（同一個交易）：
     em.find → PENDING
     🔴 0 句 SQL —— 一級快取（03 章 3.3.1）
  ④ 那用 JPQL 呢（它會 auto-flush，也會真的查資料庫）：
     JPQL 回傳的物件 status = PENDING
     1 句 SQL，而回傳的還是快取裡那一個物件（03 章 3.3.4 那個★★）
  ⑤ em.refresh(o) 之後：
     CANCELLED
```

🔴 **同一個交易、同一條連線、同一張表的同一列 —— 兩個框架看到兩個不同的值，而且維持了整個交易。**

**而第 ④ 步是這一格最狠的地方**：

```
JPQL 【真的】查了資料庫（1 句 SQL，SqlSpy 看得到）
   → 資料庫回傳的那一列是 status='CANCELLED'
   → 而 Hibernate 把那一列【丟掉】，回傳持久化情境裡那個 PENDING 的物件
                              ↓
📌 這就是 03 章 3.3.4 那個★★（「JPQL 查了資料庫、卻回傳快取裡的舊物件」）
   在混用情境下的樣子 —— 而它在 03 章是一個「你自己改了又查」的教學例子，
   在這裡是【另一個框架改的】，所以你完全沒有線索。
```

⚠️ **切法二的第一號地雷，一句話**：

> **JPA 的一級快取是「同一個交易裡的正確性保證」（03 章 3.3.1），**
> **而它的前提是【這個交易裡的所有寫入都經過 JPA】。**
> **切法二打破那個前提，於是那個保證變成了 bug。**

✅ **如果你真的要切法二，三個做法（由好到差）**：

```
① 讓 MyBatis 的寫入走在【另一個交易】裡（也就是退回切法一的紀律）
② 寫完立刻 em.clear()（丟掉整個持久化情境）——
   代價：這個交易裡其他實體的未 flush 修改也一起不見了（06 章 6.9.3 那個 🔴）
③ 對那一個實體 em.refresh()——
   代價：你要【記得】，而且要知道「哪些實體被別人改了」
                              ↓
🔴 而三個做法都沒有「編譯期擋下來」這個選項 ——
   這就是為什麼切法二在實務上通常是【不要】。
```

### 9.6.3 🔴🔴 切法三（依讀寫）：`flush` 之後還是查不到

**切法三是 shop-service 用的那一種，而 00 章規則二說「讀之前要 flush」。**
**這一節量它，而量出來的東西比規則二說的多一層。**

```java
    @Test
    void c3_切法三依讀寫_flush的三個位置() {
        head("9.6.3 切法三（依讀寫）：JPA 寫、MyBatis 讀 —— 那 flush 呢");

        sub("① 同一個交易：JPA 剛 persist 的訂單，MyBatis 查得到嗎");
        tx.executeWithoutResult(s -> {
            UUID id = Uuid7.next();
            Customer c = em.getReference(Customer.class, customerIds.get(0));
            em.persist(new Order(id, "SO-FLUSH-" + System.nanoTime(), c));

            System.out.println("   em.persist 之後，MyBatis 查 → "
                    + (mix.oneRow(id) == null ? "🔴 查不到（null）" : "找到了"));
            System.out.println("   em.flush() 之後，MyBatis 查 → "
                    + (flushThen(id) == null ? "🔴 還是查不到" : "✅ 找到了"));
            System.out.println("     資料真的進去了嗎（JdbcTemplate 問一次）→ "
                    + jdbc.queryForObject("SELECT count(*) FROM orders WHERE id = ?",
                            Long.class, Uuid7.toBytes(id)) + " 列");
            sessions.clearCache();                            // ★ SqlSessionTemplate
            System.out.println("   ★ clearCache() 之後 → "
                    + (mix.oneRow(id) == null ? "🔴 查不到" : "✅ 找到了"));
        });
    }
```

```
═══ 9.6.3 切法三（依讀寫）：JPA 寫、MyBatis 讀 —— 那 flush 呢 ═══

── ① 同一個交易：JPA 剛 persist 的訂單，MyBatis 查得到嗎
   em.persist 之後，MyBatis 查 → 🔴 查不到（null）
   而 JPA 自己查得到嗎 → ✅ 找得到（一級快取）
   em.flush() 之後，MyBatis 查 → 🔴 還是查不到
     資料真的進去了嗎（JdbcTemplate 問一次）→ 1 列
   ★ sqlSessionTemplate.clearCache() 之後 → ✅ 找到了
     🔴🔴 所以「flush 之後還是查不到」的原因是
        【MyBatis 把上一次那個 null 快取起來了】（07 章 7.11）

── ①b 對照：如果 MyBatis 的第一次查詢就發生在 flush 之後
   MyBatis 查 → ✅ 找到了（同一個交易、同一條連線）

── ② 而 JPQL 會 auto-flush、MyBatis 不會 —— 這就是規則二的來源（00 章 0.9）
   JPQL 觸發的 SQL：
      insert into orders (currency,customer_id,discount_amount,order_no,paid_at,
                          placed_at,status,total_amount,versio…
      select count(o1_0.id) from orders o1_0
   → 那句 insert 是 auto-flush 送出去的（03 章 3.6.2）
   MyBatis 現在查得到了嗎 → ✅ 找得到

── ③ 三個解法，各自的代價
   ⓐ 讀之前手動 em.flush()        → 要記得，而「忘了」不會報錯
   ⓑ 寫入與讀取分成兩個交易        → 語意最乾淨，而回應時間多一次 commit
   ⓒ 查詢側只讀「不是本交易寫的」   → 用 CQRS 的說法就是最終一致
```

🔴🔴 **「flush 了還是查不到」—— 而資料庫裡明明有 1 列。**

**這一格是【兩個快取疊起來】的第一個實測**：

```
第一層：JPA 的寫入延到 flush（軸四）
   → em.persist 之後，資料庫裡【真的沒有】那一列 → MyBatis 查到 null（合理）

第二層：MyBatis 的一級快取（07 章 7.11）
   → 它把那個 null 用「statement id + 參數」當 key 存起來
   → em.flush() 之後資料進去了，而 MyBatis【不會再問資料庫】
                              ↓
✅ 而 ①b 證明了機制：如果 MyBatis 的第一次查詢就發生在 flush 之後，它找得到。
   所以問題不是「MyBatis 看不到未提交的資料」（同一條連線，它看得到），
   問題是【它已經回答過這個問題了】。
```

⚠️ **所以 00 章規則二要補一句**：

```
🔴 舊：「JPA 寫完、MyBatis 讀之前，要 flush」
✅ 新：「JPA 寫完、MyBatis 讀之前，要 flush ——
       而如果 MyBatis 在 flush 之前【已經查過那一筆】，還要 clearCache()」
                              ↓
📌 而更好的說法是把它變成一條紀律：
   ✅ 「同一個交易裡，不要在【寫入之後】用另一個框架讀同一筆資料」
   —— 這條紀律不需要記住任何 API，而且它自然導向 ⓑ（分兩個交易）。
```

### 9.6.4 🔴🔴 第四號地雷：型別轉換不是共用的

**兩個框架共用 `DataSource`、共用交易管理器、共用連線。**
**而它們【不共用型別轉換】—— 這一格量出那件事的後果。**

```java
    @Test
    void c4_同一個時間值三個API送出三種東西() {
        head("9.6.4 🔴🔴 混用的第四號地雷：型別轉換【不是共用的】");
        var ldt = LocalDateTime.parse("2026-09-01T02:49:00");
        var ins = ldt.toInstant(ZoneOffset.UTC);

        tx.executeWithoutResult(s -> {
            // ① Hibernate 的 native query
            em.createNativeQuery("select date_format(:t, '%Y-%m-%d %H:%i:%s')", String.class)
                    .setParameter("t", ldt).getSingleResult();
            // ② 同一句，換成 Instant
            // ③ / ④ MyBatis（Mix9Mapper.fmtTime）
        });
        // ⑤ / ⑥ JdbcTemplate
    }
```

```
═══ 9.6.4 🔴🔴 混用的第四號地雷：型別轉換【不是共用的】 ═══
  JVM 時區 = Asia/Taipei
  連線 URL 有 connectionTimeZone=UTC & preserveInstants=true
  要送的值 = 2026-09-01T02:49（= 2026-09-01T02:49:00Z）

  ① Hibernate native + LocalDateTime       2026-08-31 18:49:00
  ② Hibernate native + Instant             2026-09-01 02:49:00
  ③ MyBatis + LocalDateTime                2026-09-01 02:49:00
  ④ MyBatis + Instant（有 TypeHandler）       2026-09-01 02:49:00
  ⑤ JdbcTemplate + LocalDateTime           2026-09-01 02:49:00
  ⑥ JdbcTemplate + Instant                 2026-09-01 02:49:00

  📌 三個 API、同一個 LocalDateTime、兩種結果 —— 差 8 小時，而且沒有任何警告
```

🔴🔴 **六格裡有一格不一樣，而那一格差 8 小時。**

```
Hibernate 的 native query 拿到 LocalDateTime 之後：
   → 把它當成「JVM 時區的一個瞬間」→ ps.setTimestamp(…)
   → 驅動（preserveInstants=true）再把那個瞬間換成 UTC
   → 02:49 - 8h = 18:49（前一天）
                              ↓
而 MyBatis 走的是它內建的 LocalDateTimeTypeHandler → ps.setObject(i, localDateTime)
   → 驅動直接送那 19 個字元，沒有經過瞬間 → 02:49 ✅
JdbcTemplate 走 StatementCreatorUtils → 一樣是 setObject → ✅
```

⚠️ **這個地雷的實際樣子（我在寫 9.3.1 的時候踩到的）**：

```java
    // 🔴 第一版：游標用 LocalDateTime
    @Query(nativeQuery = true, value = "… WHERE o.placed_at < :lastAt …")
    List<String> keysetNative(@Param("lastAt") LocalDateTime lastAt, …);
```

```
用 JdbcTemplate 跑同一句 SQL、同一個參數 → 回 5 筆 ✅
用 @Query(nativeQuery = true) 跑         → 回 0 筆 🔴
                              ↓
沒有例外、沒有警告、沒有 SQL 語法錯 —— 就是【0 筆】。
而它的原因是那個參數在送出去的路上被減了 8 小時，
變成「2026-08-31 18:49 之前的訂單」，而資料從 09-01 才開始。
```

📌 **所以混用的第四條規則**：

> **規則四：跨框架共用的參數與 DTO，型別要選【沒有時區歧義的那一種】。**
>
> ```
> ✅ Instant（六格全對）、UUID（兩邊都有 TypeHandler / 內建支援）、
>    BigDecimal、String、enum（而 07 章 7.5.3 說 MyBatis 要指定 name 或 ordinal）
> 🔴 LocalDateTime（本節）、java.util.Date、java.sql.Timestamp
>    （後兩個在【六格裡的四格】都會被當成瞬間再轉一次）
> ```
>
> **而這條規則有一個很便宜的執行方式**：
> **07 章 7.14 那組「接合檢查」加一條 —— mapper 介面與 native query 的參數型別，
> 不准出現 `LocalDateTime` / `Date` / `Timestamp`（ArchUnit 檢查得到方法簽章）。**

### 9.6.5 實測：多一個框架，具體貴多少

**「混用有成本」這句話，大家都同意。而它是多少？**

```java
package com.example.lab.ch09;

import org.junit.jupiter.api.Test;
import org.mybatis.spring.annotation.MapperScan;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.autoconfigure.domain.EntityScan;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.jpa.repository.config.EnableJpaRepositories;

import java.lang.management.ManagementFactory;

/**
 * 9.6.5：混用的成本，用一個可以量的東西表示 —— 啟動一個 context 要多久、要幾個 bean。
 *
 * ⚠️ 三個組態刻意都【只放 shop-service 需要的東西】：
 *    JPA 側 = 五個實體 + 三個 repository；MyBatis 側 = 兩個 mapper。
 */
class P4bCost {

    static final String[] PROPS = {
        "spring.datasource.url=jdbc:mysql://127.0.0.1:33306/shop?connectionTimeZone=UTC"
            + "&forceConnectionTimeZoneToSession=true&preserveInstants=true&characterEncoding=UTF-8",
        "spring.datasource.username=root", "spring.datasource.password=root",
        "spring.jpa.hibernate.ddl-auto=none", "spring.jpa.open-in-view=false",
        "mybatis.mapper-locations=classpath:mapper/*.xml",
        "mybatis.type-handlers-package=com.example.lab.ch07",
        "mybatis.configuration.map-underscore-to-camel-case=true",
        "logging.level.root=WARN",
    };

    static final String NO_MYBATIS = "spring.autoconfigure.exclude="
            + "org.mybatis.spring.boot.autoconfigure.MybatisAutoConfiguration,"
            + "org.mybatis.spring.boot.autoconfigure.MybatisLanguageDriverAutoConfiguration,"
            + "com.github.pagehelper.autoconfigure.PageHelperAutoConfiguration";

    static final String NO_JPA = "spring.autoconfigure.exclude="
            + "org.springframework.boot.autoconfigure.orm.jpa.HibernateJpaAutoConfiguration,"
            + "org.springframework.boot.autoconfigure.data.jpa.JpaRepositoriesAutoConfiguration";

    @Configuration @EnableAutoConfiguration
    @EntityScan("com.example.lab.shop")
    @EnableJpaRepositories("com.example.lab.shop")
    static class JpaOnly {}

    @Configuration @EnableAutoConfiguration
    @MapperScan("com.example.lab.shop.mybatis")
    static class MyBatisOnly {}

    @Configuration @EnableAutoConfiguration
    @EntityScan("com.example.lab.shop")
    @EnableJpaRepositories("com.example.lab.shop")
    @MapperScan("com.example.lab.shop.mybatis")
    static class Both {}

    private record Boot(long ms, int beans, long heapKb) {}

    private Boot boot(Class<?> cfg, String exclude) {
        String[] props = new String[PROPS.length + (exclude == null ? 0 : 1)];
        System.arraycopy(PROPS, 0, props, 0, PROPS.length);
        if (exclude != null) props[PROPS.length] = exclude;
        long t0 = System.nanoTime();
        try (ConfigurableApplicationContext ctx = new SpringApplicationBuilder(cfg)
                .web(WebApplicationType.NONE)
                .bannerMode(org.springframework.boot.Banner.Mode.OFF)
                .properties(props).run()) {
            long ms = (System.nanoTime() - t0) / 1_000_000;
            int beans = ctx.getBeanDefinitionCount();
            System.gc();
            long used = ManagementFactory.getMemoryMXBean().getHeapMemoryUsage().getUsed() / 1024;
            return new Boot(ms, beans, used);
        }
    }

    @Test
    void c5_多一個框架的成本() {
        System.out.println("\n═══ 9.6.5 多一個框架，具體貴多少 ═══");

        // 暖機：把兩邊的類別都載入，否則第一個跑的那一個會背下所有 class loading
        boot(Both.class, null);

        record Row(String name, Class<?> cfg, String exclude) {}
        var rows = new Row[]{
                new Row("只有 JPA（5 實體 + 3 repository）", JpaOnly.class, NO_MYBATIS),
                new Row("只有 MyBatis（2 mapper）", MyBatisOnly.class, NO_JPA),
                new Row("兩個都有", Both.class, null)};

        System.out.printf("%n  %-34s %10s %10s %12s%n", "組態", "啟動", "bean 數", "heap");
        for (Row r : rows) {
            Boot best = null;
            for (int i = 0; i < 3; i++) {
                Boot b = boot(r.cfg(), r.exclude());
                if (best == null || b.ms() < best.ms()) best = b;
            }
            System.out.printf("  %-34s %8d ms %8d 個 %10d KB%n",
                    r.name(), best.ms(), best.beans(), best.heapKb());
        }

        System.out.println("\n  ⚠️ heap 那一欄只能當【量級】看（同一個 JVM 裡量三次，GC 不受控）。");
    }
}
```

```
═══ 9.6.5 多一個框架，具體貴多少 ═══

  組態                                         啟動     bean 數         heap
  只有 JPA（5 實體 + 3 repository）             140 ms      169 個      68958 KB
  只有 MyBatis（2 mapper）                    125 ms      146 個      70051 KB
  兩個都有                                    156 ms      180 個      69696 KB

  ⚠️ heap 那一欄只能當【量級】看（同一個 JVM 裡量三次，GC 不受控）。
```

**加上依賴的大小（從 `~/.m2` 直接量 jar 的位元組數）**：

| 側 | jar 數 | 大小 | 最大的那一個 |
|---|---|---|---|
| **JPA**（Hibernate + Spring Data JPA） | **10** | **17.7 MB** | `hibernate-core` 11.3 MB、`byte-buddy` 4.1 MB |
| **MyBatis** | **4** | **1.8 MB** | `mybatis` 1.7 MB |
| PageHelper（08 章 8.6.2 加的） | 4 | 1.0 MB | `jsqlparser` 879 KB ← **就是那個撞壞 JPA 的** |

📌 **所以「多一個框架」的技術成本是**：

```
啟動慢 16 ms（140 → 156）、多 11 個 bean、heap 一樣、jar 多 1.8 MB
                              ↓
✅ 也就是【幾乎為零】。
```

⚠️ **而這正是混用最危險的地方**：

> **它的技術成本幾乎為零，所以「加一個框架」這個決定太容易做。**
> **而它真正的成本，是 9.6.1～9.6.4 那四個地雷 ——**
> **而那四個地雷【不會出現在任何一張架構評估表上】。**

**把成本寫成一張真正的清單**：

| 成本 | 具體是什麼 | 出處 |
|---|---|---|
| 技術 | 16 ms 啟動、11 個 bean、1.8 MB | 9.6.5 |
| 🔴 **兩個一級快取** | 同一個交易裡兩邊看到不同的值 | 9.6.2、9.6.3 |
| 🔴 **兩個二級快取** | 而且是**雙向**壞掉，兩邊都 0 句 SQL | 08 章 8.7.8 |
| 🔴 **樂觀鎖的約定只有一邊遵守** | `version = version + 1` 要自己寫 | 9.6.1 |
| 🔴 **型別轉換不共用** | 同一個 `LocalDateTime` 差 8 小時 | 9.6.4 |
| 🔴 **兩套斷言** | 08 章五條（MyBatis）+ 05／06 章五條（JPA） | 9.8 |
| 🔴 **兩套「怎麼查詢」的知識** | 新人要學兩套慣例、code review 要看兩種模式 | 9.5 |
| 🔴 **一個依賴撞壞另一邊** | PageHelper 的 jsqlparser 撞壞**所有** JPA repository | 08 章 8.6.2 |

### 9.6.6 三種切法的決策表

| 切法 | 什麼時候合理 | 第一號地雷 | 需要的紀律 |
|---|---|---|---|
| **依表** | 老 schema + 新功能並存（9.3.5 那種）；報表庫 / 唯讀複本 | 有人越界寫了對面的表 → **樂觀鎖靜默失效**（9.6.1） | 06 章 6.10.3 + 07 章 7.14.3 那兩條斷言（**兩邊都要**） |
| **依用例** | 🔴 **通常不要** | 同一個交易裡兩個框架看到兩個值，**維持整個交易**（9.6.2） | 沒有可靠的紀律 —— 只有「寫完就換交易」 |
| **依讀寫** | ✅ **shop-service 用的**；查詢側形狀自由、寫入側有不變量 | 寫入之後在同一個交易裡讀 → **flush 了還查不到**（9.6.3） | 「同一個交易裡不要寫完再用另一邊讀」+ 07 章 7.14.2 那條「查詢側只准 SELECT」 |

✅ **而三種切法共用一條規則，它比上面那些都重要**：

```
📌 讓「哪一邊管什麼」出現在【套件結構】上（00 章 0.9 規則三）。
   shop-service 的做法是：
      com.example.lab.shop            ← JPA：實體、repository、Service、領域規則
      com.example.lab.shop.mybatis    ← MyBatis：【只有讀】
                              ↓
   而它可以被一條 ArchUnit 規則執行（07 章 7.14.2）：
      「shop.mybatis 底下的 statement 只能是 SELECT」
                              ↓
✅ 這條規則的價值在於：它讓「越界」變成一個【建置失敗】，
   而不是一個「三個月後的資料不一致」。
```

---

## 9.7 遷移成本：實際搬一次

**「遷移成本」這種東西，估的都不準 —— 所以這一節真的搬一次然後數。**

```
搬什麼：shop-service 的【寫入路徑】（place / pay）
為什麼是寫入路徑：查詢側已經搬過三次了（07 章 7.15、08 章 8.10、9.9.4），
                而三次的結論都是「一字不差」——
                也就是說查詢側的遷移成本【已知且很低】。
                那寫入路徑呢？00 章 0.8.1 場景 A / B 說 JPA 佔優勢，
                而它的理由一直是「程式碼量」。這一節把它變成數字。
```

### 9.7.1 查詢側的遷移成本（已知的那一半）

| 從 | 到 | 動了什麼 | 結果 | 出處 |
|---|---|---|---|---|
| JPA 投影 | MyBatis | +1 個介面、+1 份 XML、`OrderListRow` **不動** | 兩邊第一列**一字不差**、都 0 個實體 | 07 章 7.15.2 |
| JPA `Specification` | MyBatis `<if>` | +5 個 `<if>`、+1 個 `likePattern()` | 五組條件**結果一樣** | 08 章 8.10.2 |
| MyBatis `<if>` | JPA Criteria 投影 | +1 個 `OrderSearchQuery`（40 行） | 十組條件**結果一樣**（9.9.2） | 9.9.4 |

📌 **查詢側的遷移成本公式**：

```
每一個查詢：一個方法簽章 + 一份映射（XML 的 <resultMap> 或 JPQL 的建構子運算式）
          + 【零】個共用型別的改動（如果 DTO 是 record）
                              ↓
✅ 所以查詢側是【線性的、可預估的、可以一個一個搬的】。
   而它最大的風險不是成本，是【搬到一半】—— 9.9 那一節在處理這個。
```

### 9.7.2 ★★ 實測：把 `place()` / `pay()` 搬到 MyBatis

**JPA 那一版（03 章 3.11 + 06 章 6.11 的成品）**：

```java
    /** ③ 新增：這是整個類別裡唯一呼叫 save 的地方，而它等價於 persist。 */
    @Transactional
    public UUID place(UUID orderId, String orderNo, UUID customerId,
                      UUID productId, int qty, UUID itemId) {
        Customer c = customers.getReferenceById(customerId);   // 不需要真的撈出來
        Product p = products.findById(productId)
                .orElseThrow(() -> new IllegalArgumentException("商品不存在：" + productId));
        Order o = new Order(orderId, orderNo, c);
        o.addItem(itemId, p, qty);                             // ★ 不變量在這裡
        orders.save(o);                                        // Persistable → 直接 persist
        stocks.reserve(productId, qty);                        // ★ 06 章 6.11：扣庫存
        return o.getId();
    }

    /** ② 改資料：撈出來、呼叫方法、結束。沒有 save。 */
    @Transactional
    public void pay(UUID orderId) {
        order(orderId).pay();
    }
```

**MyBatis 那一版（09 章新寫的）**：

```java
package com.example.lab.ch09;

import com.example.lab.shop.InsufficientStockException;
import com.example.lab.shop.OrderStatus;
import com.example.lab.shop.StockService;
import org.springframework.dao.OptimisticLockingFailureException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * 9.7.2：OrderService 的 MyBatis 版（只搬寫入路徑）。
 *
 * 🔴 下面每一段註解標了【自己補回來的第 N 件事】—— 一共六件。
 */
@Service
public class MyBatisOrderService {

    private final OrderWriteMapper write;
    private final StockService stocks;
    private final org.springframework.jdbc.core.JdbcTemplate jdbc;

    public MyBatisOrderService(OrderWriteMapper write, StockService stocks,
                               org.springframework.jdbc.core.JdbcTemplate jdbc) {
        this.write = write; this.stocks = stocks; this.jdbc = jdbc;
    }

    @Transactional
    public UUID place(UUID orderId, String orderNo, UUID customerId,
                      UUID productId, int qty, UUID itemId) {
        // 【第 1 件】商品的單價要自己撈（JPA 那一版是 products.findById(...)，一樣一句，
        //   差別在這裡拿到的是【一列資料】而不是一個可以呼叫方法的物件）
        var p = jdbc.queryForMap("SELECT name, unit_price FROM product WHERE id = ?",
                com.example.lab.Uuid7.toBytes(productId));
        String name = (String) p.get("name");
        BigDecimal unitPrice = (BigDecimal) p.get("unit_price");

        // 【第 2 件】金額的不變量：JPA 那一版寫在 Order.addItem() 裡（01 章 1.13 那 11 條），
        //   這裡要自己算，而且【沒有東西保證別的呼叫端也這樣算】
        BigDecimal lineAmount = unitPrice.multiply(BigDecimal.valueOf(qty));

        // 【第 3 件】JPA 那一版是 em.persist(order) 一行，cascade 幫你插明細
        write.insertOrder(orderId, orderNo, customerId, OrderStatus.PENDING,
                lineAmount, Instant.now());
        write.insertItems(orderId, List.of(new OrderWriteMapper.ItemToInsert(
                itemId, productId, name, unitPrice, qty, lineAmount)));

        stocks.reserve(productId, qty);            // ★ 這一段兩邊一樣（06 章 6.11：原子 UPDATE）
        return orderId;
    }

    @Transactional
    public void pay(UUID orderId) {
        // 【第 4 件】狀態機要先看現況（JPA 那一版現況就在持久化情境裡，0 句 SQL）
        var st = write.loadState(orderId);
        if (st == null) throw new IllegalArgumentException("訂單不存在：" + orderId);
        // 【第 5 件】狀態轉移規則：JPA 那一版在 Order.pay() 裡，是【領域物件的方法】；
        //   這裡在 Service 裡，而它只保護「經過這個 Service」的那條路
        if (st.status() != OrderStatus.PENDING)
            throw new IllegalStateException("只有 PENDING 可以付款，現在是 " + st.status());

        // 【第 6 件】樂觀鎖：條件要自己寫，回傳值要自己檢查，例外要自己拋
        int n = write.updateStatus(orderId, OrderStatus.PAID, st.version(), Instant.now());
        if (n != 1) throw new OptimisticLockingFailureException(
                "訂單 " + orderId + " 已經被別人改過了（version " + st.version() + "）");
    }

    /** 🔴 9.7.3 的對照組：一個「看起來一模一樣」的實作，少了第 6 件事。 */
    @Transactional
    public void payWithoutVersion(UUID orderId) {
        var st = write.loadState(orderId);
        if (st == null) throw new IllegalArgumentException("訂單不存在：" + orderId);
        if (st.status() != OrderStatus.PENDING)
            throw new IllegalStateException("只有 PENDING 可以付款，現在是 " + st.status());
        write.updateStatusNoVersion(orderId, OrderStatus.PAID);
    }

    /** 讓 9.7.2 的對照表有一格「庫存不足」—— 兩邊都靠 06 章那個原子 UPDATE。 */
    @Transactional
    public void placeExpectingStock(UUID orderId, String orderNo, UUID customerId,
                                    UUID productId, int qty, UUID itemId) {
        try { place(orderId, orderNo, customerId, productId, qty, itemId); }
        catch (InsufficientStockException e) { throw e; }
    }
}
```

**它用的那個 mapper 介面** —— **六件事裡的第 ⓐ～ⓓ 件，在這裡各對應一個方法**：

```java
package com.example.lab.ch09;

import com.example.lab.shop.OrderStatus;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * 9.7.2：把 shop-service 的<b>寫入側</b>搬到 MyBatis。
 *
 * ⚠️ 這是一個【實驗】，不是 shop-service 的一部分 ——
 *    00 章 0.9 規則一說「一張表只讓一個框架寫」，而 9.6.1 量出了違反它的後果。
 *    這裡的意義是：把「遷移成本」變成一個可以數的東西。
 */
@Mapper
public interface OrderWriteMapper {

    /** ⓐ JPA 那一側是 em.persist(order) 一行。 */
    int insertOrder(@Param("id") UUID id,
                    @Param("orderNo") String orderNo,
                    @Param("customerId") UUID customerId,
                    @Param("status") OrderStatus status,
                    @Param("totalAmount") BigDecimal totalAmount,
                    @Param("placedAt") Instant placedAt);

    /** ⓑ JPA 那一側是 cascade = PERSIST（02 章 2.4），這裡要自己來。 */
    int insertItems(@Param("orderId") UUID orderId, @Param("items") List<ItemToInsert> items);

    /** ⓒ 狀態機要先看現況 —— 而 JPA 那一側現況已經在持久化情境裡了。 */
    OrderState loadState(@Param("id") UUID id);

    /** ⓓ 樂觀鎖要自己寫在 WHERE 裡，而且要自己檢查影響列數。 */
    int updateStatus(@Param("id") UUID id,
                     @Param("status") OrderStatus status,
                     @Param("version") long version,
                     @Param("paidAt") Instant paidAt);

    /** 🔴 9.7.3 的對照組：忘了 version（也忘了檢查影響列數）。 */
    int updateStatusNoVersion(@Param("id") UUID id, @Param("status") OrderStatus status);

    int addTotal(@Param("id") UUID id, @Param("delta") BigDecimal delta,
                 @Param("version") long version);

    record ItemToInsert(UUID id, UUID productId, String productName,
                        BigDecimal unitPrice, int qty, BigDecimal lineAmount) {}

    record OrderState(UUID id, OrderStatus status, BigDecimal totalAmount, long version) {}
}
```

**而它的 XML**：

```xml
<mapper namespace="com.example.lab.ch09.OrderWriteMapper">

  <insert id="insertOrder">
    INSERT INTO orders (id, order_no, customer_id, status, total_amount, placed_at, version)
    VALUES (#{id}, #{orderNo}, #{customerId}, #{status}, #{totalAmount}, #{placedAt}, 0)
  </insert>

  <!-- ★ 一句多組 VALUES（08 章 8.4.5）—— cascade = PERSIST 的手工版 -->
  <insert id="insertItems">
    INSERT INTO order_item (id, order_id, product_id, product_name, unit_price, qty, line_amount)
    VALUES
    <foreach item="i" collection="items" separator=",">
      (#{i.id}, #{orderId}, #{i.productId}, #{i.productName},
       #{i.unitPrice}, #{i.qty}, #{i.lineAmount})
    </foreach>
  </insert>

  <select id="loadState" resultMap="stateMap">
    SELECT id, status, total_amount, version FROM orders WHERE id = #{id}
  </select>

  <!-- ✅ 樂觀鎖：條件寫在 WHERE 裡，而【呼叫端一定要檢查回傳值】 -->
  <update id="updateStatus">
    UPDATE orders
       SET status = #{status}, version = version + 1
           <if test="paidAt != null">, paid_at = #{paidAt}</if>
     WHERE id = #{id} AND version = #{version}
  </update>
</mapper>
```

```
═══ 9.7.2 同一個 place() / pay()，兩個框架各打幾句 SQL ═══

── place()：JPA 4 句、MyBatis 4 句
   JPA：
      select p1_0.id,p1_0.is_active,p1_0.name,p1_0.sku,p1_0.unit_price,p1_0.version
        from product p1_0 where p1_0.id=?
      insert into orders (currency,customer_id,discount_amount,order_no,paid_at,placed_at,
        status,total_amount,version,id) valu…
      insert into order_item (line_amount,order_id,product_id,product_name,qty,unit_price,id)
        values (?,?,?,?,?,?,?)
      update stock set qty=(qty-?),reserved_qty=(reserved_qty+?),version=(version+1)
       where product_id=? and qty>=?
   MyBatis：
      SELECT name, unit_price FROM product WHERE id = ?
      INSERT INTO orders (id, order_no, customer_id, status, total_amount, placed_at, version)
        VALUES (?, ?, ?, ?, ?, ?, 0)
      INSERT INTO order_item (id, order_id, product_id, product_name, unit_price, qty,
        line_amount) VALUES (?, ?, ?, ?, ?, ?, …
      update stock set qty=(qty-?),reserved_qty=(reserved_qty+?),version=(version+1)
       where product_id=? and qty>=?

── 兩邊寫進去的東西一樣嗎
   {order_no=SO-JPA-1, status=PENDING, total_amount=200.0000, version=0, items=1}
   {order_no=SO-MB-1, status=PENDING, total_amount=200.0000, version=0, items=1}

── pay()：JPA 2 句、MyBatis 2 句
   JPA：
      select o1_0.id,o1_0.created_at,o1_0.currency,o1_0.customer_id,o1_0.discount_amount,
             o1_0.order_no,o1_0.paid_at,o1_0.placed_at,o1_0.…
      update orders set currency=?,customer_id=?,discount_amount=?,order_no=?,paid_at=?,
             placed_at=?,status=?,total_amount=?,version=? wh…
   MyBatis：
      SELECT id, status, total_amount, version FROM orders WHERE id = ?
      UPDATE orders SET status = ?, version = version + 1 , paid_at = ? WHERE id = ? AND version = ?

── 狀態機還在嗎（付款兩次）
   JPA     第二次 pay() → IllegalStateException
   MyBatis 第二次 pay() → IllegalStateException

── 🔴 而狀態機的【位置】不一樣
   JPA     ：規則在 Order.pay() 裡 —— 任何拿到那個物件的人都繞不過
   MyBatis ：規則在 MyBatisOrderService.pay() 裡 ——
            任何人只要自己寫一句 UPDATE orders SET status = 'PAID' 就繞過了
   示範：直接呼叫 updateStatusNoVersion() → 影響 1 列，status 現在是 CANCELLED
```

**四個發現**：

**① SQL 句數【完全一樣】（4 句 / 2 句），而且寫進去的資料一字不差。**

```
📌 00 章 0.8.1 場景 A / B 那兩格的「句數」理由，到這裡已經沒有了：
   場景 B 說「JPA 7 句 vs MyBatis 4 句」——
   而 01 章 1.6.6 的 Persistable 之後，JPA 也是 4 句。
```

**② 而 SQL 的【形狀】不一樣，那一格值得看**：

```
JPA 的 UPDATE：update orders set currency=?,customer_id=?,discount_amount=?,order_no=?,
                                 paid_at=?,placed_at=?,status=?,total_amount=?,version=?
               → 【九個欄位全寫】（03 章 3.4.6：改一欄卻 UPDATE 八欄）
MyBatis 的：   UPDATE orders SET status = ?, version = version + 1, paid_at = ?
               → 【只寫要改的】
                              ↓
⚠️ 而 06 章 6.4 已經量過：@DynamicUpdate（讓 JPA 只寫改動的欄位）
   會讓它【變慢】（316 → 384 ms），因為它跟批次互斥、而且每次要組新的 SQL。
                              ↓
📌 所以這一格是「兩個框架的預設值反映了兩種假設」：
   JPA 假設「SQL 形狀固定比較好」（一種形狀、可以批次、計畫快取命中）
   MyBatis 假設「寫得少比較好」（你自己決定，而形狀數量是你的責任 —— 08 章 8.3.13）
```

**③ 行數：17 → 63 行（3.7 倍）。而那 46 行是【六件事】**：

| # | JPA 幫你做的 | 搬到 MyBatis 之後 | 風險 |
|---|---|---|---|
| 1 | `products.findById()` 回一個**有行為的物件** | 自己撈一列 `Map`，自己取欄位 | 🟡 型別轉換自己做 |
| 2 | `Order.addItem()` 維護**金額不變量** | 自己算 `lineAmount` | 🔴 **別的呼叫端可以算錯** |
| 3 | `cascade = PERSIST` 插明細 | 自己 `insertItems`（`<foreach>`） | 🟡 忘了插 = 一張沒有明細的訂單 |
| 4 | 現況**已經在持久化情境裡** | 多一句 `loadState` | 🟡 多一次往返 |
| 5 | 狀態機在**領域物件**上 | 搬到 **Service** | 🔴🔴 **繞得過**（見下面 ④） |
| 6 | `@Version` **自動**加一、自動拋例外 | 自己寫 `WHERE version = ?` + **自己檢查影響列數** | 🔴🔴 **漏掉就靜默錯**（9.7.3） |

**④ 🔴🔴 而第 5 件事的後果，最後那三行示範了**：

```
JPA     ：Order.pay() 是那個物件唯一改 status 的方法
          → 任何人要改 status，都必須拿到那個實體、都必須經過那個規則
MyBatis ：規則在 Service 裡，而資料庫沒有規則
          → 我直接呼叫 write.updateStatusNoVersion(jpaId, CANCELLED)
          → 影響 1 列。一張【已付款】的訂單變成 CANCELLED。
                              ↓
📌 這不是「MyBatis 的錯」—— 是【不變量的位置】的差別：
   ✅ JPA 的不變量在【物件】上，而物件是唯一的入口
   ✅ MyBatis 的不變量要放在【資料庫】（CHECK 約束、觸發器）或【一個所有人都必須走的 Service】
   🔴 而後者靠的是【紀律】，不是【機制】
```

⚠️ **這就是 01 章 1.13 那 11 條不變量的「新位置」問題的最終答案**：

| 不變量放哪裡 | 誰繞不過 | 代價 |
|---|---|---|
| 資料庫約束（`CHECK` / 唯一鍵 / 外鍵） | **所有人**（連 DBA 手動改都繞不過） | 錯誤訊息是廠商的、難測、改起來要 migration |
| 領域物件的方法（JPA） | 所有**經過 ORM** 的人 | 旁路 SQL 繞得過（9.6.1） |
| Service 的方法（MyBatis / 任何寫法） | 所有**經過那個 Service** 的人 | 另一個 mapper / 另一個服務 / 一個 SQL client 都繞得過 |

### 9.7.3 🔴 實測：那六件事漏掉一件會怎樣

**第 6 件事（樂觀鎖）是最容易漏的，因為【漏掉的版本看起來一模一樣】。**

```java
    /** 🔴 9.7.3 的對照組：一個「看起來一模一樣」的實作，少了第 6 件事。 */
    @Transactional
    public void payWithoutVersion(UUID orderId) {
        var st = write.loadState(orderId);
        if (st == null) throw new IllegalArgumentException("訂單不存在：" + orderId);
        if (st.status() != OrderStatus.PENDING)
            throw new IllegalStateException("只有 PENDING 可以付款，現在是 " + st.status());
        write.updateStatusNoVersion(orderId, OrderStatus.PAID);   // 🔴 少了 version 與檢查
    }
```

```java
    @Test
    void d2_搬完之後樂觀鎖漏了() throws Exception {
        head("9.7.3 🔴 那六件事漏掉一件會怎樣（20 個人同時付同一張訂單）");

        for (String mode : List.of("有 version + 檢查影響列數", "🔴 沒有 version")) {
            UUID id = Uuid7.next();
            mbSvc.place(id, "SO-MB-" + System.nanoTime(), …);

            int threads = 20;
            CountDownLatch go = new CountDownLatch(1);
            AtomicInteger ok = new AtomicInteger(), failed = new AtomicInteger();
            for (int i = 0; i < threads; i++)
                pool.submit(() -> {
                    go.await();
                    try {
                        if (mode.startsWith("有")) mbSvc.pay(id); else mbSvc.payWithoutVersion(id);
                        ok.incrementAndGet();
                    } catch (Exception e) { failed.incrementAndGet(); }
                });
            go.countDown();
            …
        }
    }
```

```
═══ 9.7.3 🔴 那六件事漏掉一件會怎樣（20 個人同時付同一張訂單） ═══
  有 version + 檢查影響列數           回報成功  1 次、失敗 19 次 → 資料庫 version = 1
  🔴 沒有 version                回報成功 10 次、失敗 10 次 → 資料庫 version = 0

  📌 兩種模式最後的 status 都是 PAID —— 差別在【有幾個人以為是自己付的】
     而這正是 06 章 6.6.3 那個「回報 20 成功、實際扣 2」的同一個形狀。
```

🔴 **10 個人收到「付款成功」。**

```
為什麼是 10 而不是 20？
   那 10 個失敗的執行緒，是【在第一個交易 commit 之後】才跑到 loadState 的
   → 它們看到 status='PAID' → 狀態機擋下來 → IllegalStateException ✅
而那 10 個成功的，是在同一個時間窗口裡都讀到 PENDING 的
   → 每一個都送出 UPDATE orders SET status='PAID' WHERE id=?
   → 每一句都影響 1 列（因為那一列真的存在）
   → 每一個都回報成功
                              ↓
📌 而「狀態機擋下了一半」這件事，讓這個 bug 更難發現：
   單機低併發的測試會看到「第二次呼叫拋 IllegalStateException」→ 看起來是對的。
   要 20 條執行緒同時打才看得到那 10 個。
```

✅ **而正確的那一版是 1 成功 / 19 失敗 —— 這就是 06 章那一整章的價值。**

⚠️ **這一格對「遷移」的意義**：

```
搬一個寫入路徑，最危險的不是「搬不動」，是【搬得動而少了一件事】。
   ① 少了不變量的檢查 → 資料會慢慢長出不合法的狀態
   ② 少了樂觀鎖       → 只在併發的時候錯，而測試通常不併發
   ③ 少了 cascade     → 一張沒有明細的訂單
                              ↓
📌 而三件事都【不會讓任何一個測試變紅】，除非你有：
   ✅ 06 章 6.10.2 那條「所有會被改的實體都要有 @Version」
   ✅ 06 章 6.10.3 / 07 章 7.14.3 那條「旁路寫入要維護 version」
   ✅ 一個【真的開 20 條執行緒】的測試（06 章 6.6.3 那種）
```

### 9.7.4 反方向：MyBatis → JPA 的四個硬牆

**前面三節都在講「JPA → MyBatis」。反過來呢？**

| # | 硬牆 | 實測 | 能不能繞過 |
|---|---|---|---|
| **1** | **沒有主鍵的表** | 🔴 `AnnotationException`，或把全欄位當主鍵 → **3 列變 2 個物件**（9.3.5） | 🔴 **不能**。那張表只能繼續用 MyBatis / JdbcTemplate 讀 |
| **2** | **`${}` 的動態表名 / 欄位名** | JPQL 沒有這個東西；`JpaSort.unsafe` 是注入點（05 章 5.7.6） | 🟡 用 Criteria 的白名單 `Map<String, Path>`，或那幾句留 native |
| **3** | **一句 SQL 組出巢狀集合** | 08 章 8.5.1：MyBatis 一個 `<collection>`、**0 行 Java 組裝**；JPA 要兩段式投影（05 章 5.8.8） | 🟡 能，而要多寫組裝程式碼 |
| **4** | ★ **「每次查詢都是新物件」這個假設** | 🔴 MyBatis 的程式碼可以放心改結果物件（沒人在看）；搬到 JPA 之後**改了就會被寫回去**（00 章 0.3.1 那個事故） | 🔴 **要逐一檢查所有查詢方法** |

**第 4 面牆值得多講一句，因為它是【最容易被低估的】**：

```
MyBatis 時代的程式碼常常長這樣：
   var rows = mapper.listRows(status, 0, 20);
   for (var r : rows) r.setDisplayName(mask(r.getDisplayName()));   // 遮蔽敏感資料
   return rows;
                              ↓
搬到 JPA 之後，如果 listRows 回傳的是【實體】：
   那個 setDisplayName 會在交易 commit 的時候【被 flush 進資料庫】。
   → 00 章 0.3.1 那個事故（「沒有呼叫 save()，資料卻改了」）
   → 而它會把整張表的客戶名字都遮蔽掉
                              ↓
✅ 唯一可靠的防線是 05 章 5.13.3 那條斷言：
   「唯讀的用例不准建實體」（entityLoad == 0）——
   它讓「查詢回傳實體」這件事變成一個【建置失敗】。
```

### 9.7.5 遷移成本的公式

**把前面四節收成一個可以拿去開會用的東西**：

```
遷移成本 =
   ① 每一個查詢：1 個方法簽章 + 1 份映射            ← 線性、可預估、風險低
   ② 每一個寫入路徑：1 份映射 + 六件事              ← 線性、而【每一件漏掉都是靜默的錯】
   ③ 每一張「不是你設計的表」：0 或 ∞               ← 9.3.5 那四種老表，第一種是 ∞
   ④ 一次「哪些查詢回傳實體」的全面盤點             ← 反方向才有，而它是最大的一筆
   ⑤ 兩套斷言中【只保留一套】的代價                 ← 9.8
                              ↓
📌 而 ① 與 ② 的比例，就是你的專案「查詢導向 / 寫入導向」的比例 ——
   也就是 00 章 0.8.2 判準 1。
   ✅ 所以那個判準不只決定「選哪個」，也決定「換過去要多久」。
```

⚠️ **而有一個成本【不在這個公式裡】，因為它不是遷移的成本**：

```
🔴 「兩個框架並存的那段時間」的成本。
   遷移不是一天做完的 —— 中間那三個月，你的專案就是 9.6 那三種切法的混合體，
   而那四個地雷【全部有效】。
                              ↓
✅ 所以遷移計畫的第一件事不是「先搬哪個」，是
   「這段時間裡，哪一張表由誰寫」—— 而那要寫下來、要有斷言。
```

---

## 9.8 這一站累積的斷言 —— 哪幾條跟框架無關

08 章 8.13 交待的第五件事：

> ⑤ 這一站累積的 21 條 CI 斷言，哪幾條是「不管你選哪個框架都要有」的

### 9.8.1 九章的斷言盤點

| # | 斷言 | 在哪 | 抓什麼 | 形狀 | 要 DB 嗎 | 哪一側 |
|---|---|---|---|---|---|---|
| 1 | `_at` 欄位一律 `Instant` | 01 章 1.9.4 | 時區 bug | ArchUnit | ❌ | JPA |
| 2 | 11 條不變量的新位置（三層檢查） | 01 章 1.13 | 資料長出不合法狀態 | 測試 + DDL | ✅ | **兩側** |
| 3 | 一個用例只 flush 一次 | 03 章 3.10.3 ① | 迴圈裡 flush | `PcSpy` | ✅ | JPA |
| 4 | 唯讀用例 `updates() == 0` | 03 章 3.10.3 ② | 查詢方法偷偷寫東西 | `PcSpy` | ✅ | **兩側** |
| 5 | 新增沒有 `SELECT` | 03 章 3.10.3 ③ | `Persistable` 被拿掉 | `PcSpy` | ✅ | JPA |
| 6 | `collectionLoads()` vs 筆數 | 03 章 3.10.3 ④ | **N+1** | `PcSpy` | ✅ | JPA |
| 7 | 交易結束時不該有髒實體 | 03 章 3.10.3 ⑤ | 「以為改了，其實是 detached」 | `PcSpy` | ✅ | JPA |
| 8 | `assertNoNPlus1()` | 04 章 4.10.5 ① | 多碰了一個沒 fetch 的關聯 | `NPlus1Spy` | ✅ | JPA |
| 9 | `assertAtMostExtraQueries(2)` | 04 章 4.10.5 ② | `@BatchSize` 被拿掉 | `NPlus1Spy` | ✅ | JPA |
| 10 | **分頁查詢的 SQL 必須有 `limit`** | 04 章 4.10.5 ③ | **記憶體分頁** | `SqlSpy` | ✅ | **兩側** |
| 11 | 所有查詢定義在啟動時被驗證 | 05 章 5.13.1 | `@Query` 的錯字 | 啟動 | 🟡 | JPA |
| 12 | 查詢不准寫在 Service 裡 | 05 章 5.13.2 | 查詢散落 | ArchUnit | ❌ | **兩側** |
| 13 | **唯讀用例不准建實體** | 05 章 5.13.3 | 有人把投影改回實體 | `ReadOnlySpy` | ✅ | JPA |
| 14 | 批次匯入 `execute` 是 `O(N/batch)` | 06 章 6.10.1 | 迴圈裡加了查詢 | `SqlSpy` | ✅ | **兩側** |
| 15 | 會被改的實體都要有 `@Version` | 06 章 6.10.2 | 沒想過並行 | 白名單 | ❌ | JPA |
| 16 | **旁路寫入要維護 `version`** | 06 章 6.10.3 | 繞過 JPA 的寫入 | 棘輪 | ❌ | **兩側** |
| 17 | 每個 mapper 方法都有 statement | 07 章 7.14.1 | XML 的 id 打錯 | 啟動 | ❌ | MyBatis |
| 18 | 查詢側只准 SELECT | 07 章 7.14.2 | 查詢側加了寫入 | ArchUnit | ❌ | **兩側** |
| 19 | 旁路寫入維護 `version`（MyBatis 側） | 07 章 7.14.3 | 同 16，換一側 | 掃 XML | ❌ | MyBatis |
| 20 | **每個查詢的每一欄都不是 null** | 07 章 7.14.4 | SQL 忘了別名、欄位改名 | 測試 | ✅ | **兩側** |
| 21 | 每一種條件組合都產生合法 SQL | 08 章 8.9.1 | `<if>` 拼出壞 SQL | `Dyn` | ❌ | MyBatis |
| 22 | 空集合不准壞掉也不准變成「全部」 | 08 章 8.9.2 | `<foreach>` 沒防護 | `Dyn` | ❌ | **兩側** |
| 23 | SQL 形狀數有上界 | 08 章 8.9.3 | 多加一個條件 / 忘了 pad | 棘輪 | ❌ | **兩側** |
| 24 | **有 `LIMIT` 就要有唯一的 `ORDER BY`** | 08 章 8.9.4 | 分頁會漏會重複 | `Dyn` | ❌ | **兩側** |
| 25 | 巢狀 `resultMap` 不准分頁 | 08 章 8.9.5 | 8.6.5 那個殘缺資料 | `Dyn` | ❌ | MyBatis |

**（08 章說「21 條」，實際數下來是 25 條 —— 因為 01 章那兩條與 03 章那五條沒有被算進去。）**

📌 **分佈**：

```
只在 JPA 側有意義      ：9 條（3、5、6、7、8、9、11、13、15 ── 全部跟【狀態】有關）
只在 MyBatis 側有意義  ：4 條（17、19、21、25 ── 全部跟【接合與組合】有關）
✅ 兩側都需要          ：12 條
                              ↓
而那 12 條，就是這一節要回答的問題的答案 —— 9.8.4 會把它們收成一張表。
```

### 9.8.2 ★★ 實測：8.9.1 那條斷言搬到 JPA 側要付什麼

**08 章 8.9 那五條斷言最漂亮的性質是「全部不需要資料庫」（214 ms）。**
**這一節問：JPA 那一側有沒有等價的東西？**

```java
    @Test
    void e1_把8_9_1那條斷言搬到JPA側() {
        head("9.8.2 ★★ 8.9.1 那條斷言搬到 JPA 側");
        var cs = combos();          // 05 章那五個條件的 2^5 = 32 種組合

        sub("① MyBatis 側（08 章 8.9.1）：不執行、不連線、不要資料");
        for (OrderSearchCriteria c : cs)
            for (String id : List.of(NS + "search", NS + "searchCount")) {
                String sql = dyn.sql(id, Dyn.args("q", c, "offset", 0, "size", 20));
                assertDoesNotThrow(() -> CCJSqlParserUtil.parse(sql));
            }

        sub("② JPA 側：能不能也「不執行就看到 SQL」");
        var cb = em.getCriteriaBuilder();
        var cq = cb.createQuery(Order.class);
        var root = cq.from(Order.class);
        cq.select(root).where(OrderSpecifications.of(cs.get(31)).toPredicate(root, cq, cb));
        var q = em.createQuery(cq);
        String s = q.unwrap(org.hibernate.query.Query.class).getQueryString();
        System.out.println("      " + s);

        sub("③ 所以 JPA 側的等價斷言只能【執行】—— 量一次");
        for (OrderSearchCriteria c : cs) {
            Specification<Order> spec = OrderSpecifications.of(c);
            var sqls = spy(() -> tx.executeWithoutResult(s2 ->
                    repo.findAll(spec, PageRequest.of(0, 20)).getContent().size()));
            jpaShapes.addAll(sqls);
        }
        …
    }
```

```
═══ 9.8.2 ★★ 8.9.1 那條斷言（每一種條件組合都要產生合法的 SQL）搬到 JPA 側 ═══

── ① MyBatis 側（08 章 8.9.1）：不執行、不連線、不要資料
   32 種組合 × 2 個 statement = 64 次檢查，59 ms，SQL 形狀 32 種
   需要資料庫嗎 → 不需要

── ② JPA 側：能不能也「不執行就看到 SQL」
   em.createQuery(criteriaQuery).unwrap(Query).getQueryString()：
      <criteria>
   📌 那是 HQL，不是 SQL —— 它還沒被翻譯（所以「SQL 合不合法」問不到）

── ③ 所以 JPA 側的等價斷言只能【執行】—— 量一次
   32 種組合，281 ms，SQL 形狀 56 種（含 count 那一句）
   需要資料庫嗎 → 需要，而且要有交易、要有資料
   📌 281 ms vs 59 ms = 5 倍

── ④ 而「形狀爆炸」是兩邊都有的
   JPA 跑完 32 種組合 → 伺服器端：select=56  commit=32  列.read=3040
   （08 章 8.3.13 在 MyBatis 側量到的是 Com_stmt_prepare 63 vs 1）
```

🔴 **`getQueryString()` 回傳的字串是 `"<criteria>"`。**

```
那不是 bug，是 Hibernate 的實作細節：
   Criteria 查詢在 Hibernate 6 裡是一棵 SQM 樹（Semantic Query Model），
   它【沒有對應的 HQL 文字】—— 所以 getQueryString() 回一個佔位字串。
                              ↓
🔴 也就是說：JPA 那一側【拿不到 SQL，也拿不到 HQL】，除非執行它。
（用 @Query 寫的 JPQL 那一側拿得到 HQL —— 因為那本來就是你寫的字串。
  而 HQL ≠ SQL，所以「SQL 合不合法」還是問不到。）
```

**兩邊的對照，四格**：

| | MyBatis（`Dyn.getBoundSql`） | JPA（Criteria / `Specification`） |
|---|---|---|
| 拿得到 **SQL** | ✅ 不執行、不連線 | 🔴 **只能執行**（`hibernate.show_sql` / `SqlSpy` 都要跑過） |
| 32 種組合的耗時 | **59 ms** | **281 ms**（5 倍） |
| 需要什麼 | 一個 `Configuration`（就是啟動時建好的那個） | 一個資料庫 + 一個交易 + **符合條件的資料** |
| 抓得到什麼 | 「這組參數會產生壞 SQL」 | 「這組參數會**在執行時**壞掉」 |

⚠️ **而那個「需要符合條件的資料」是最麻煩的一格**：

```
MyBatis 那條斷言：條件填什麼都可以（值不影響 SQL 是否合法）
JPA 那條斷言：如果某一組條件【沒有命中任何資料】，
             那句 SQL 還是跑了、還是驗證了 —— 這一格 JPA 其實沒有比較差。
                              ↓
🔴 而真正的差別在【壞掉的那一種】：
   MyBatis 的 <if> 可能拼出「語法錯」的 SQL（8.3.4 那個忘了 AND）
   → 那種錯誤【一定】會在執行時被資料庫擋下來，所以兩邊都抓得到。
   而 Criteria 【不可能】拼出語法錯的 SQL（它組的是語意樹，不是字串）。
                              ↓
📌 所以結論是一個交換，而不是一邊贏：
   ✅ JPA：不可能產生語法錯的 SQL → 這條斷言【幾乎不需要】
   ✅ MyBatis：可能產生語法錯的 SQL → 這條斷言【必要】，
              而它剛好【很便宜】（59 ms、不用 DB）
```

### 9.8.3 ★★ 實測：形狀爆炸兩邊都有，而 JPA 那一側的數字說出了一個 bug

**08 章 8.3.13 量到「64 種 SQL 形狀 vs 1 種形狀 × 64」在伺服器端的差別：
`Com_stmt_prepare` 63 vs 1、35.6 ms vs 15.6 ms。**

**JPA 那一側呢？** 9.8.2 ④ 那一行：

```
JPA 跑完 32 種組合 → 伺服器端：select=56  commit=32  列.read=3040
```

```
32 種條件組合 → 56 句 SELECT（32 句主查詢 + 24 句 count）
             → 而 SQL 形狀也是 56 種
                              ↓
📌 也就是說：Criteria 的形狀爆炸【跟 MyBatis 的 <if> 一模一樣】。
   兩邊都是「N 個可選條件 → 2^N 種 SQL」，
   而 08 章 8.3.13 量到的伺服器端代價（Com_stmt_prepare、計畫快取沒中）
   在 JPA 這一側【完全一樣】。
                              ↓
✅ 所以 08 章 8.9.3 那條「形狀數有上界」的棘輪式斷言，
   是這一站【最應該搬到 JPA 側】的一條。
```

★★ **而這一節有一個意外的收穫，它值得單獨講：那個形狀數，第一次量到的是 28。**

```
第一次跑（修 9.9.2 那個 bug 之前）：32 種組合 → 28 種 SQL 形狀
修好之後：                        32 種組合 → 56 種 SQL 形狀
                              ↓
🔴 28 < 32 是【不可能的】，除非有幾組條件產生了【一樣的 SQL】。
   而它們產生一樣的 SQL，只有一個原因：某個條件【沒有被翻譯進去】。
                              ↓
那個原因就是 9.9.2 要講的 bug：
   OrderSpecifications.of() 寫的是 if (from != null && to != null)，
   所以「只填 from」與「只填 to」這兩組，
   產生的 SQL 跟「兩個都沒填」【一模一樣】。
   32 種組合裡有 4 組退化成同一種形狀 → 28。
```

📌 **這件事的意義比那個 bug 本身大**：

> **一條「數 SQL 形狀」的斷言，同時也是一條「條件有沒有被翻譯進去」的斷言。**
>
> ```
> 期望的形狀數 = 2^N（N 個獨立的可選條件）
> 實際的形狀數 < 2^N  →  有條件被吃掉了，或者有條件是綁在一起的
> 實際的形狀數 > 2^N  →  有條件不只一種形狀（例如 in 子句沒有 pad，08 章 8.4.3）
>                              ↓
> ✅ 而它【不需要資料庫、不需要斷言結果正確、不需要邊界值】——
>    它只要數形狀。
> ```

### 9.8.4 實測：哪幾條斷言「不管你選哪個框架都要有」

```java
    @Test
    void e2_跟框架無關的那幾條斷言() {
        head("9.8.4 這一站的斷言裡，哪幾條【不管你選哪個框架都要有】");

        sub("斷言 A：分頁查詢的 SQL 一定要有 limit（04 章 4.10.5 ③ / 08 章 8.9.4）");
        var sqls = spy(() -> tx.executeWithoutResult(s ->
                repo.listRows(OrderStatus.PENDING, PageRequest.of(0, 20))));
        boolean hasLimit = sqls.stream().anyMatch(q -> q.toLowerCase().contains("limit"));

        sub("斷言 B：有 limit 的查詢一定要有【唯一的】order by（08 章 8.9.4）");
        String s0 = sqls.get(0).toLowerCase();
        int ob = s0.lastIndexOf("order by");
        System.out.println("   order by 那一段 = " + s0.substring(ob, ob + 60));

        sub("斷言 C：唯讀用例不准建實體（05 章 5.13.3）—— 兩個框架都適用嗎");
        long jpaEnt = entities(() -> tx.executeWithoutResult(s ->
                repo.listRows(OrderStatus.PENDING, PageRequest.of(0, 20))));
        …
    }
```

```
═══ 9.8.4 這一站的斷言裡，哪幾條【不管你選哪個框架都要有】 ═══

── 斷言 A：分頁查詢的 SQL 一定要有 limit（04 章 4.10.5 ③ / 08 章 8.9.4）
   JPA 那一句有 limit 嗎 → true
      select o1_0.id,o1_0.order_no,c1_0.display_name,o1_0.status,o1_0.total_amount,
             o1_0.placed_at,(select count(oi1_0.id) from order_item oi1_0 where oi1_0.…

── 斷言 B：有 limit 的查詢一定要有【唯一的】order by（08 章 8.9.4）
   order by 那一段 = order by o1_0.placed_at desc limit ?,?
   🔴 它只有 placed_at，沒有 tiebreaker —— 而 08 章 8.9.4 那條斷言
      是寫在 MyBatis 的 Configuration 上的，所以【看不到這一句】

── 斷言 C：唯讀用例不准建實體（05 章 5.13.3）—— 兩個框架都適用嗎
   JPA 投影 → 0 個實體
   MyBatis  → 永遠 0 個（它沒有持久化情境）
   📌 所以這條斷言在 MyBatis 側【恆真】—— 它不是不需要，是【換一種形式】：
      「唯讀路徑不准呼叫寫入 mapper」（07 章 7.14.2）
```

🔴 **斷言 B 抓到了一個真的問題，而它從 05 章就在那裡。**

```
05 章 5.14.2 寫的 listRows：
   order by o.placedAt desc          ← 只有一個欄位
                              ↓
而 placed_at 【不是唯一的】—— 兩張同一毫秒下單的訂單，
它們在兩次查詢之間的相對順序【由 MySQL 決定，而它可以不一樣】。
                              ↓
🔴 後果（08 章 8.6.7 已經講過機制）：
   第 1 頁最後一筆與第 2 頁第一筆可能是【同一張訂單】（重複），
   也可能【兩張都沒出現】（漏掉）。
                              ↓
✅ 而 08 章 8.9.4 那條斷言【本來就會抓到它】——
   它抓不到的唯一原因是：那條斷言掃的是 MyBatis 的 Configuration，
   而這一句是 JPA 的 @Query。
```

**修法（09 章對 `OrderRepository` 的唯一改動）**：

```java
    @Query("""
           select new com.example.lab.shop.OrderListRow(
                    o.id, o.orderNo, c.displayName, o.status, o.totalAmount, o.placedAt,
                    (select count(i) from OrderItem i where i.order = o))
             from Order o join o.customer c
            where o.status = :status
            order by o.placedAt desc, o.id desc        ← ★ 09 章 9.8.4：加 tiebreaker
           """)
    Page<OrderListRow> listRows(@Param("status") OrderStatus status, Pageable page);
```

### 9.8.4b 實測：而有一條斷言在 JPA 側是「白送的」

**08 章 8.9.2 那條斷言（「空集合不准壞掉，也不准變成回傳全部」）在 MyBatis 側是必要的**
——因為 `<foreach>` 展開空集合會產生 `in ()`（語法錯）或者把整個條件消掉（回傳全部）。

**JPA 那一側呢？**

```java
    @Test
    void 空的in子句在criteria上是什麼() {
        var cb = em.getCriteriaBuilder();
        var cq = cb.createQuery(Long.class);
        var root = cq.from(Order.class);
        cq.select(cb.count(root)).where(root.get("status").in(List.of()));   // ★ 空集合
        …
        em.createQuery("select count(o) from Order o where o.status in :ss", Long.class)
                .setParameter("ss", List.<OrderStatus>of())                  // ★ 空集合
        …
    }
```

```
═══ 查核：Criteria 的空 in 子句 ═══
   筆數 = 0
   SQL: select count(o1_0.id) from orders o1_0 where 1=0
═══ 查核：JPQL 的空 in 參數 ═══
   筆數 = 0
   SQL: select count(o1_0.id) from orders o1_0 where 1=0
```

✅ **Hibernate 6 兩種寫法都產出 `where 1=0` —— 跟 08 章 8.4.2 那個「正解」一字不差。**

```
📌 而這件事的意義是【那條斷言在 JPA 側恆真】：
   MyBatis：你要自己寫 <otherwise> AND 1 = 0 </otherwise>，
            而 8.9.2 那條斷言就是在檢查「你有沒有寫」
   JPA    ：框架幫你寫了，而且【選了同一個答案】
                              ↓
⚠️ 注意「同一個答案」這件事本身是一個決定：
   「空集合 = 什麼都不要」而不是「空集合 = 不過濾」。
   08 章 8.10.3 說過那個決定要寫在需求上 ——
   而在 JPA 這一側，那個決定是【框架幫你做的】，
   所以如果你的需求是「沒勾 = 全部」，你要自己在 Java 裡短路。
```

📌 **12 條「兩側都要」的斷言，按「它在另一側長什麼樣」分成三種**：

| 斷言 | 在 JPA 側 | 在 MyBatis 側 | 種類 |
|---|---|---|---|
| **10** 分頁要有 `limit` | 看 `SqlSpy` 的第一句 | 看 `Dyn` 的 SQL | ✅ **同一條，兩邊都能寫** |
| **24** 有 `limit` 要有唯一 `ORDER BY` | 🔴 **這一站沒寫**（9.8.4 抓到 bug） | 08 章 8.9.4 | ✅ **同一條，兩邊都能寫** |
| **23** SQL 形狀數有上界 | 執行 32 種組合、數 `SqlSpy` 的形狀 | `Dyn`，不用 DB | ✅ **同一條**（而 JPA 側貴 5 倍） |
| **22** 空集合不准變成「全部」 | ✅ **實測**：`root.get("status").in(List.of())` 與 `in :空集合` **兩種都產出 `where 1=0`** | 08 章 8.9.2（MyBatis 要**自己寫** `1 = 0`） | 🟡 **JPA 側恆真** |
| **14** 批次是 `O(N/batch)` | 06 章 6.10.1 | 08 章 8.4.5 的 `<foreach>` 分塊 | ✅ **同一條** |
| **16 / 19** 旁路寫入維護 `version` | 掃 native query 與 `@Modifying` | 掃 XML 的 `<update>` | ✅ **同一條，兩邊都要**（9.6.1 證明） |
| **20** 每一欄都不是 null | 投影的建構子參數型別**編譯期**就對上了 | 07 章 7.14.4（`<resultMap>` 對不上會**靜默 null**） | 🟡 **JPA 側比較不需要** |
| **18** 查詢側只准 SELECT | ArchUnit：`shop.mybatis` 不准有 `@Modifying` | ArchUnit：只准 `<select>` | ✅ **同一條** |
| **12** 查詢不准寫在 Service 裡 | ArchUnit | ArchUnit | ✅ **同一條** |
| **13** 唯讀用例不准建實體 | `ReadOnlySpy` | **恆真** | 🔴 **換形式**（→ 18） |
| **4** 唯讀用例 `updates() == 0` | `PcSpy` | 攔截器數 `update` 的呼叫（08 章 8.8.2） | 🟡 **換工具** |
| **2** 11 條不變量 | 領域方法 + 測試 | Service + 測試 + **DDL 約束** | 🔴 **換位置**（9.7.2 ④） |

### 9.8.5 那七條「不管你選什麼都要有」的核心

**把上面那張表收到最小 —— 如果你的專案只寫七條斷言，寫這七條**：

```
① 分頁查詢的 SQL 必須有 limit               ← 抓記憶體分頁（04 章 4.5.5、07 章 7.9.4）
② 有 limit 的查詢必須有【唯一的】order by    ← 抓分頁漏 / 重複（08 章 8.6.7、9.8.4）
③ 一個用例的 SQL 句數有上界（跟資料量無關）   ← 抓 N+1（04 章 4.10、9.4.4）
④ 動態查詢的 SQL 形狀數有上界（棘輪）        ← 抓形狀爆炸 + 條件被吃掉（08 章 8.3.13、9.8.3）
⑤ 旁路寫入必須維護 version（棘輪）           ← 抓樂觀鎖失效（06 章 6.10.3、9.6.1）
⑥ 查詢側只准 SELECT（ArchUnit）             ← 抓讀寫邊界被打破（07 章 7.14.2、9.6）
⑦ 批次操作的 execute 次數是 O(N / batch)     ← 抓批次靜默失效（06 章 6.10.1）
                              ↓
📌 這七條的共同性質：
   ① 每一條都對應這一站的一個【實測事故】
   ② 每一條都【跟框架無關】（換框架只換工具，不換規則）
   ③ 而它們全部都是「數一個數字，然後跟一個上界比」——
     沒有一條在檢查「結果對不對」（那是功能測試的事）
```

⚠️ **而剩下的 18 條裡，有 9 條只在 JPA 側有意義 —— 那不是「JPA 比較麻煩」**：

```
那 9 條全部在保護【持久化情境】這一個東西：
   flush 幾次、有沒有髒實體、有沒有 N+1、有沒有多建實體、@Version 有沒有…
                              ↓
📌 而那正是軸二（有沒有狀態）的帳單：
   JPA 給你「一個會記住東西的中間層」，
   而那 9 條斷言就是【維護那個中間層的正確性】的成本。
                              ↓
✅ 所以「選 MyBatis 少寫 9 條斷言」這句話是對的。
   而它換來的是：那 4 條 MyBatis 專屬的（接合與組合），
   加上 9.7.2 那六件「要自己補回來的事」——
   而後者【沒有斷言抓得到】（除了 version 那一條）。
```

---

## 9.9 收斂：把兩個實作變成一個 ★★

08 章 8.10.6 那張表最後兩行寫著：

```
📌 現在有兩個「動態搜尋」並存（search 與 searchRows），而那是刻意的 ——
   09 章要拿它們做最後的選型結論。

⚠️ 「同一個列表頁有兩個實作」在課程裡是為了對照，在真實專案裡是【技術債】：
      ① 加一個欄位要改兩個地方，而只改一個【不會有任何錯誤】
      ② 兩邊的 like 跳脫規則各寫一次 —— 它們現在一致，
         而沒有東西保證它們一直一致
```

**這一節把那筆債結掉，而過程中發現一件事：那兩個實作【從來就沒有一致過】。**

### 9.9.1 為什麼不是「刪掉一個」那麼簡單

```
兩個實作各自提供了一些【對面沒有的東西】：

JPA 的 search()（05 章 5.14）
   ✅ 條件是五個【可以單獨測試的函式】（05 章 5.9.6）
   ✅ 型別安全：root.get("status") 打錯 → 執行期，但參數型別對不上 → 編譯期
   ✅ 可以組合：of(criteria) 之外還可以 .and(別的 Specification)
   🔴 而它回傳實體（21～80 個）

MyBatis 的 searchRows()（08 章 8.10）
   ✅ 0 個實體
   ✅ count 與列表共用同一段 <sql>（8.3.12）→ 結構上不可能不一致
   ✅ 不執行也看得到 SQL（8.2.3）→ 那五條斷言很便宜
   🔴 而條件是【一段 XML】，不能單獨測試、不能組合
                              ↓
📌 所以「刪掉一個」= 放棄那一邊的優點。
   而 09 章的答案是【第三個實作】：留下 Specification，換掉回傳型別。
```

### 9.9.2 ★★ 實測：契約測試抓到一個從 05 章活到現在的 bug

**先寫那條契約測試 —— 十組條件、兩個實作、一組斷言。**

```java
    @Test
    void g1_一組條件兩個實作一組斷言() {
        head("9.9.2 契約測試：同一組條件，兩個實作【必須】回一樣的東西");

        // ★ 比【整組結果】而不是第一頁 —— 理由見這一節最後那一段
        BiFunction<OrderSearchCriteria, Integer, List<OrderListRow>> jpa =
                (c, size) -> tx.execute(s -> searchQuery.search(c, 0, size).content());
        BiFunction<OrderSearchCriteria, Integer, List<OrderListRow>> mb =
                (c, size) -> tx.execute(s -> searchMapper.search(c, 0, size));

        int bad = 0;
        for (OrderSearchCriteria c : cases()) {
            var a = jpa.apply(c, 500);
            var b = mb.apply(c, 500);
            boolean same = ids(a).equals(ids(b));      // ★ 比 order_no 的【順序】
            if (!same) bad++;
        }
        assertEquals(0, bad, "兩個實作對不上");
    }

    /** 08 章 8.10 那五個條件的十種代表性組合。 */
    private List<OrderSearchCriteria> cases() {
        Instant from = Instant.parse("2026-09-01T00:00:00Z");
        Instant to = Instant.parse("2026-12-01T00:00:00Z");
        return List.of(
                OrderSearchCriteria.empty(),
                new OrderSearchCriteria(OrderStatus.PENDING, null, null, null, null),
                new OrderSearchCriteria(null, "客戶1", null, null, null),
                new OrderSearchCriteria(OrderStatus.PENDING, "客戶1", null, null, null),
                new OrderSearchCriteria(null, null, from, to, null),
                new OrderSearchCriteria(null, null, null, null, new BigDecimal("250.0000")),
                new OrderSearchCriteria(OrderStatus.PAID, "客戶", from, to, new BigDecimal("150.0000")),
                new OrderSearchCriteria(OrderStatus.PENDING, "客戶1", from, to, new BigDecimal("100.0000")),
                // ★ 9.9.2b：這一組的 minAmount 【剛好等於某一列的 total_amount】
                new OrderSearchCriteria(null, null, null, null, new BigDecimal("400.0000")),
                // ★ 這一組【只填結束時間】
                new OrderSearchCriteria(null, null, null,
                        Instant.parse("2026-09-01T00:20:00Z"), null));
    }
```

**第一次跑（08 章結束時的程式碼）**：

```
  #   條件                                                  JPA  MyBatis     一致
  1   （全空）                                              200 筆    200 筆      ✅
  2   status=PENDING                                     50 筆     50 筆      ✅
  3   kw=客戶1                                             20 筆     20 筆      ✅
  4   status=PENDING kw=客戶1                               5 筆      5 筆      ✅
  5   from to                                           200 筆    200 筆      ✅
  6   min=250.0000                                      200 筆    200 筆      ✅
  7   status=PAID kw=客戶 from to min=150.0000             50 筆     50 筆      ✅
  8   status=PENDING kw=客戶1 from to min=100.0000          5 筆      5 筆      ✅
  9   min=400.0000                                      100 筆    100 筆      ✅
  10  to                                                 20 筆     21 筆     🔴
  → 不一致 1 組

org.opentest4j.AssertionFailedError: 兩個實作對不上 ==> expected: <0> but was: <1>
```

★★ **第 10 組：「只填結束時間」—— JPA 20 筆、MyBatis 21 筆。**

**原因在 05 章 5.14 寫的那個 `of()` 裡**：

```java
    public static Specification<Order> of(OrderSearchCriteria c) {
        List<Specification<Order>> parts = new ArrayList<>();
        if (c.status() != null)          parts.add(statusIs(c.status()));
        if (c.customerKeyword() != null) parts.add(customerLike(c.customerKeyword()));
        if (c.from() != null && c.to() != null) parts.add(placedBetween(c.from(), c.to()));
        //  ↑↑↑ 🔴 這裡
        if (c.minAmount() != null)       parts.add(amountAtLeast(c.minAmount()));
        …
    }
```

```
🔴 「只填了開始時間」或「只填了結束時間」→ 那個條件【被靜默忽略】。
✅ 而 MyBatis 那一側（08 章 8.10.1）是【兩個獨立的 <if>】：
      <if test="q.from != null"> AND o.placed_at >= #{q.from} </if>
      <if test="q.to != null">   AND o.placed_at <= #{q.to}   </if>
   → 它會過濾。
                              ↓
📌 兩個實作【從 08 章開始就不一致】，而 8.10.2 那五組測試
   剛好每一組都是「from 與 to 一起填」或「兩個都不填」——
   所以那個「五種條件組合、結果一字不差」是真的，
   而它【沒有覆蓋到那 4 種組合】（32 種裡的 4 種）。
```

**修法 —— `OrderSpecifications` 這一章結束時的完整版本**（新加的是 `placedFrom` / `placedTo`，以及 `of()` 裡那兩行）：

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

    /**
     * ★ 使用者輸入要跳脫 like 的萬用字元（05 章 5.4.2）。
     *   09 章 9.9.3：跳脫規則收成 {@link LikePattern} 一份，兩個框架共用。
     *   09 章 9.9.5：join 改成【點號】—— 理由是那一節量到的「兩個 join」。
     */
    public static Specification<Order> customerLike(String kw) {
        String p = LikePattern.contains(kw);
        return (root, q, cb) -> cb.like(root.get("customer").get("displayName"),
                p, LikePattern.ESCAPE);
    }

    /** 9.9.5 的對照組：用 root.join() 的那一版。 */
    public static Specification<Order> customerLikeJoin(String kw) {
        String p = LikePattern.contains(kw);
        return (root, q, cb) -> cb.like(root.join("customer").get("displayName"),
                p, LikePattern.ESCAPE);
    }

    public static Specification<Order> placedBetween(Instant from, Instant to) {
        return (root, q, cb) -> cb.between(root.get("placedAt"), from, to);
    }

    /**
     * 🔴 09 章 9.9.2：這兩個是【新加的】。
     *
     * 05 章 5.14 的 of() 寫的是 `if (from != null && to != null)` ——
     * 也就是「只填了開始時間」或「只填了結束時間」的時候，那個條件【被靜默忽略】。
     * 而 MyBatis 那一側（08 章 8.10.1）是兩個獨立的 <if>，它會過濾。
     *
     * 兩個實作從 08 章開始就不一致，而 8.10.2 那五組測試剛好都沒踩到 ——
     * 抓到它的是 9.9.2 那條契約測試的第 10 組。
     */
    public static Specification<Order> placedFrom(Instant from) {
        return (root, q, cb) -> cb.greaterThanOrEqualTo(root.get("placedAt"), from);
    }

    public static Specification<Order> placedTo(Instant to) {
        return (root, q, cb) -> cb.lessThanOrEqualTo(root.get("placedAt"), to);
    }

    public static Specification<Order> amountAtLeast(BigDecimal a) {
        return (root, q, cb) -> cb.greaterThanOrEqualTo(root.get("totalAmount"), a);
    }

    /**
     * ★ 沒有任何條件時回「永遠成立」，不是 null：
     *   findAll(Specification) 收得下 null，而 findBy(Specification, …) 會拋
     *   IllegalArgumentException: Specification must not be null（05 章 5.14.4）。
     */
    public static Specification<Order> of(OrderSearchCriteria c) { return of(c, false); }

    public static Specification<Order> of(OrderSearchCriteria c, boolean useJoin) {
        List<Specification<Order>> parts = new ArrayList<>();
        if (c.status() != null)          parts.add(statusIs(c.status()));
        if (c.customerKeyword() != null) parts.add(useJoin
                ? customerLikeJoin(c.customerKeyword()) : customerLike(c.customerKeyword()));
        if (c.from() != null) parts.add(placedFrom(c.from()));      // ★ 09 章 9.9.2：拆成兩個
        if (c.to() != null)   parts.add(placedTo(c.to()));
        if (c.minAmount() != null)       parts.add(amountAtLeast(c.minAmount()));
        Specification<Order> out = (root, q, cb) -> cb.conjunction();
        for (Specification<Order> p : parts) out = out.and(p);
        return out;
    }
}
```

**修好之後**：

```
  10  to                                                 21 筆     21 筆      ✅
  → 不一致 0 組
```

📌 **而這個 bug 有三個「本來應該抓到它」的地方，一個一個看為什麼沒抓到**：

```
① 08 章 8.10.2 的五組對照     → 🔴 沒踩到那 4 種組合（覆蓋率問題）
② 08 章 8.9.1 的 32 種組合斷言 → 🔴 它只檢查「SQL 合不合法」，不檢查語意
③ 08 章 8.9.3 的形狀數斷言     → ✅ 【本來會抓到】！
   32 種組合在 JPA 側只產出 28 種形狀（9.8.3）——
   而那條斷言掃的是 MyBatis 的 Configuration，所以它看不到 JPA 那一側。
                              ↓
📌 所以這個 bug 的正確教訓不是「要寫契約測試」，是：
   ✅ 【那三條斷言要在兩側都跑】。
   而 9.8.3 那個「28 vs 32」的指紋，比契約測試更早就印在那裡了。
```

### 9.9.2b ⚠️ 而契約測試本身有兩個陷阱

**陷阱一：邊界值。**

```
── 而「有人只改了一邊」長什麼樣（minAmount 的 >= 變成 >）
  資料裡的 total_amount 是 300.0000 ～ 499.0000（每一列差 1 元）
  🔴 min=400.0000                                   JPA 100 筆、漂移版 99 筆
  → 10 組裡有 1 組抓到了
  📌 而那個差別是【一個字元】，兩邊的測試各自都會通過。
  ⚠️ 前八組（08 章那些）一組都抓不到 ——
     因為 250 / 150 / 100 這些門檻【不等於任何一列的金額】。
     契約測試的價值不在「有幾組」，在【有沒有踩到邊界】。
```

（`Mix9Mapper.searchDrift` 是一個刻意「只改了一邊」的版本：`>=` 變成 `>`。）

```
八組條件、三個資料維度、五個可選欄位 —— 看起來很完整。
而 >= 變成 > 這個「一個字元的漂移」，八組【全部通過】。
                              ↓
✅ 因為那八組的門檻值（250 / 150 / 100）不等於任何一列的實際金額，
   所以「>= 400」與「> 400」在那些門檻上是同一件事。
                              ↓
📌 一條可以拿去用的規則：
   ✅ 每一個【比較型】的條件，測試資料裡要有一列【剛好等於門檻】。
   而最省事的做法是：門檻值直接從資料裡撈一個出來（`SELECT total_amount … LIMIT 1 OFFSET k`）。
```

**陷阱二：只比第一頁。**

```
── 而如果契約測試只比【第一頁】呢
  整組結果：JPA 100 筆、漂移版 99 筆 → 抓到
  只比第一頁：JPA 20 筆、漂移版 20 筆 → 🔴 抓不到
  📌 因為那一筆邊界資料排在第 5 頁。
```

```
🔴 「比第一頁」是最自然的寫法（因為 Service 的簽章就是分頁的），
   而它讓「差一筆」這種漂移【躲在後面的頁】。
                              ↓
✅ 契約測試要比【整組結果】：
   size 給一個大於資料量的數字，然後比 order_no 的完整清單（含順序）。
   而「順序」那一格也重要 —— 它順便驗證了兩邊的 ORDER BY 一致（9.8.4 斷言 B）。
```

### 9.9.3 實測：跳脫規則收成一份

**08 章結束時，那條 like 跳脫規則有兩份**：

```java
// 05 章 5.14 OrderSpecifications.customerLike
String p = "%" + kw.replace("!", "!!").replace("%", "!%").replace("_", "!_") + "%";

// 08 章 8.10.1 OrderSearchCriteria.likePattern
return "%" + customerKeyword.replace("!", "!!").replace("%", "!%").replace("_", "!_") + "%";
```

**09 章把它收成一個類別（`shop` 套件裡，兩邊共用）**：

```java
package com.example.lab.shop;

/**
 * 09 章 9.9.3：like 的萬用字元跳脫，整個專案只有這一份。
 *
 * 在這之前它有兩份（OrderSpecifications.customerLike 與 OrderSearchCriteria.likePattern）。
 * 兩份的內容一樣，而【沒有任何東西保證它們一直一樣】——
 * 而「一樣」正是 8.10.2 那個「兩個框架結果一字不差」的前提。
 *
 * ⚠️ 跳脫字元選 '!' 而不是 '\'：MySQL 的字串字面值本身也用反斜線跳脫，
 *    寫成 ESCAPE '\\' 在不同的組態下（NO_BACKSLASH_ESCAPES）行為不一樣。
 */
public final class LikePattern {

    public static final char ESCAPE = '!';

    private LikePattern() {}

    /** 使用者輸入 → 「包含」樣式。null 進、null 出（08 章 8.3.9 那個 NPE 的來源）。 */
    public static String contains(String userInput) {
        if (userInput == null) return null;
        return "%" + escape(userInput) + "%";
    }

    /** 只跳脫，不加 %。 */
    public static String escape(String s) {
        return s.replace("!", "!!").replace("%", "!%").replace("_", "!_");
    }
}
```

```
═══ 9.9.3 兩個框架共用同一份 like 跳脫 ═══
  "客戶1"        → %客戶1%                一致 ✅
  "50%"        → %50!%%               一致 ✅
  "a_b"        → %a!_b%               一致 ✅
  "!bang"      → %!!bang%             一致 ✅
  "100%_off!"  → %100!%!_off!!%       一致 ✅
  ""           → %%                   一致 ✅

── 而它真的有差嗎：關鍵字裡有 % 的時候
  跳脫後的樣式 = %!%%
  JPA     搜尋 "%" → 0 筆
  MyBatis 搜尋 "%" → 0 筆
  （沒有跳脫的話，這個查詢會回傳【全部 200 筆】）
```

📌 **注意 `"!bang"` 那一列的順序**：

```
先換 ! 再換 % 與 _ ：  "!bang" → "!!bang"  ✅
如果順序反過來：      "50%" → "50!%" → "50!!%"  🔴（把自己加的跳脫字元又跳脫了一次）
                              ↓
✅ 所以「先跳脫跳脫字元」是必要的 —— 而這種順序敏感的邏輯，
   正是「不能有兩份」的理由：兩份程式碼寫對的機率是 p²。
```

### 9.9.4 ★★ 三個實作放在同一張秤上，然後做決定

**第三個實作（09 章寫的）—— 留下 `Specification`，換掉回傳型別**：

```java
package com.example.lab.shop;

import jakarta.persistence.EntityManager;
import jakarta.persistence.criteria.CriteriaBuilder;
import jakarta.persistence.criteria.CriteriaQuery;
import jakarta.persistence.criteria.Root;
import jakarta.persistence.criteria.Subquery;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.stereotype.Repository;

import java.util.List;

/**
 * 09 章 9.9.4：動態搜尋的 JPA 收斂版。
 *
 * ★ 它同時要三件 08 章分別由兩個實作各自提供的東西：
 *   ① 條件可以單獨測試、型別安全  ← 沿用 05 章的 Specification
 *   ② 0 個實體                  ← 不用 findBy(...)，自己用 cb.construct 投影
 *   ③ count 與列表用【同一組條件】 ← 同一個 Specification 套兩次
 *
 * 🔴 為什麼不能用 Spring Data 的 findBy(spec, q -> q.as(...))：
 *    05 章 5.8.6 量過 —— 封閉式介面投影還是會建實體（一頁 20 筆 → 80 個）。
 *    「動態條件」與「0 個實體」在 Spring Data 3.2 上湊不到一起，要自己下一層到 Criteria。
 */
@Repository
public class OrderSearchQuery {

    private final EntityManager em;

    public OrderSearchQuery(EntityManager em) { this.em = em; }

    public PageResult<OrderListRow> search(OrderSearchCriteria criteria, int page, int size) {
        return search(criteria, page, size, false);
    }

    /** @param useJoin 9.9.5 的對照組：true = 用 root.join() 的那一版 Specification */
    public PageResult<OrderListRow> search(OrderSearchCriteria criteria, int page, int size,
                                           boolean useJoin) {
        Specification<Order> spec = OrderSpecifications.of(criteria, useJoin);
        CriteriaBuilder cb = em.getCriteriaBuilder();

        // ── 列表
        CriteriaQuery<OrderListRow> cq = cb.createQuery(OrderListRow.class);
        Root<Order> o = cq.from(Order.class);
        Subquery<Long> items = cq.subquery(Long.class);
        Root<OrderItem> i = items.from(OrderItem.class);
        items.select(cb.count(i)).where(cb.equal(i.get("order"), o));
        cq.select(cb.construct(OrderListRow.class,
                        o.get("id"), o.get("orderNo"),
                        o.get("customer").get("displayName"),      // ★ 點號 = inner join
                        o.get("status"), o.get("totalAmount"), o.get("placedAt"),
                        items.getSelection()))
                .where(spec.toPredicate(o, cq, cb))
                .orderBy(cb.desc(o.get("placedAt")), cb.desc(o.get("id")));   // ★ 唯一排序
        List<OrderListRow> rows = em.createQuery(cq)
                .setFirstResult(page * size).setMaxResults(size).getResultList();

        // ── count：同一個 Specification，所以【結構上不可能不一致】（對照 08 章 8.3.12）
        CriteriaQuery<Long> ccq = cb.createQuery(Long.class);
        Root<Order> co = ccq.from(Order.class);
        ccq.select(cb.count(co)).where(spec.toPredicate(co, ccq, cb));
        long total = em.createQuery(ccq).getSingleResult();

        return new PageResult<>(rows, total, page, size);
    }
}
```

```
═══ 9.9.4 三個實作放在同一張秤上 ═══

  實作                                          SQL       實體         耗時           配置
  05 章：Specification + findBy + OrderView     2 句     21 個     1642 µs     199.7 KB
  08 章：MyBatis <if> + record                  2 句      0 個     1028 µs     207.0 KB
  09 章：Specification + cb.construct           2 句      0 個     1362 µs     140.8 KB

── 三個實作的結果一樣嗎
  05 章：Specification + findBy + OrderView → [SO-000165, SO-000125, SO-000085, …]
  08 章：MyBatis <if> + record → [SO-000165, SO-000125, SO-000085, …]
  09 章：Specification + cb.construct → [SO-000165, SO-000125, SO-000085, …]
```

**三個實作的完整對照**：

| | 05 章（`findBy` + 實體） | 08 章（MyBatis） | **09 章（Criteria 投影）** |
|---|---|---|---|
| SQL | 2 句 | 2 句 | 2 句 |
| 實體 | 21 個 | **0 個** | **0 個** |
| 耗時 | 1642 µs | **1028 µs** | 1362 µs |
| **配置** | 199.7 KB | 207.0 KB | ✅ **140.8 KB**（最低） |
| 條件可單獨測試 | ✅ | 🔴 | ✅ |
| count 與列表共用條件 | 🟡 Spring Data 猜（05 章 5.7.4 猜錯過） | ✅ 同一段 `<sql>` | ✅ **同一個 `Specification`** |
| 不執行看得到 SQL | 🔴（9.8.2） | ✅ | 🔴 |
| 行數 | 8 行（Service）+ 5 個條件函式 | 25 行 XML + 4 行介面 | **40 行**（一個 Repository 類別） |

✅ **09 章的決定**：

```
shop-service 的動態搜尋，收斂到【09 章那一版】（Specification + cb.construct）。
   ① 刪掉 05 章那一版的【回傳型別】（OrderView → OrderListRow），
     而它的五個條件函式【留下來】—— 那是最有價值的部分
   ② MyBatis 的 searchRows() 【留在專案裡】，但它的角色從「另一個實作」
     變成「契約測試的對照組」（9.9.2 那條斷言要兩個實作才跑得起來）
                              ↓
📌 而這個決定的理由，一句話：
   「兩個實作的差別是 334 µs（1362 vs 1028），
     而它換到的是【條件可以單獨測試】與【少一個框架要維護的查詢路徑】。」
```

⚠️ **而這個決定【不是唯一正確的】。三個場景下答案會反過來**：

```
① 那個查詢需要【一句 SQL 組出巢狀集合】（08 章 8.5.1）
   → MyBatis，因為 JPA 要兩段式投影 + 手寫組裝

② 那個查詢需要【常常調整執行計畫】（加 hint、改 join 順序）
   → MyBatis，因為 Criteria 在軸一的第一層（9.3.1）

③ 團隊裡沒有人願意讀 40 行的 Criteria
   → MyBatis。而這【是一個正當理由】——
     08 章 8.3 那個 XML 雖然是字串，而它長得像 SQL，
     所以「三年後接手的人」看得懂（00 章 0.8.2 判準 7）
```

### 9.9.5 順便量到的兩件事

**① 我以為會有「兩個 join」，而 Hibernate 6 幫我合掉了。**

```
OrderSpecifications.customerLike 用的是 root.join("customer")
而 OrderSearchQuery 的投影用的是 o.get("customer").get("displayName")
                              ↓
我預期：一個顯式 join + 一個隱式 join = SQL 裡兩個 join customer
```

```
═══ 9.9.5 Specification 裡的 root.join() 碰上自己寫的投影查詢 ═══

── ① Specification 用 root.join("customer")
   select … from orders o1_0 join customer c1_0 on c1_0.id=o1_0.customer_id
     where 1=1 and o1_0.status=? and c1_0.display_name like ? escape '!' …
   join 幾次 = 1

── ② Specification 用 root.get("customer").get("displayName")（點號）
   select … from orders o1_0 join customer c1_0 on c1_0.id=o1_0.customer_id
     where 1=1 and o1_0.status=? and c1_0.display_name like ? escape '!' …
   join 幾次 = 1

── 兩者的結果一樣嗎
   ① [SO-000165, SO-000125, SO-000085, SO-000045, SO-000005]
   ② [SO-000165, SO-000125, SO-000085, SO-000045, SO-000005]
   ① 1274 µs   ② 1348 µs
```

```
✅ Hibernate 6 把「同一個屬性的隱式 join 與顯式 inner join」合成一個。
   （這件事在 Hibernate 5 上不成立 —— 那時候常見的做法是自己把 join 傳來傳去。）
                              ↓
📌 所以 09 章那一版兩種寫法都可以，而【點號那一版更好】——
   理由不是效能（1274 vs 1348 µs 在誤差內），是
   「它不需要知道別人有沒有 join 過」。
```

**② ★ 而 08 章嘲笑的那個 `where 1 = 1`，JPA 這一側自己產了一個。**

```
── ★ 而順便看到一件事：那個 where 1=1 是誰產的
   🔴 JPA 自己產了一個 where 1=1（來自 OrderSpecifications.of 那個 cb.conjunction()）
   📌 08 章 8.3.3 花了一節講「MyBatis 的 <where> 讓 where 1 = 1 的理由消失」，
      而 JPA 這一側用同一個手法（一個恆真條件）解同一個問題。
```

```
05 章 5.14 那個 of() 最後一段：
   Specification<Order> out = (root, q, cb) -> cb.conjunction();   // ★ 永遠成立
   for (Specification<Order> p : parts) out = out.and(p);
                              ↓
cb.conjunction() 翻譯出來就是 1=1。
                              ↓
📌 兩個框架、兩種語言、同一個問題（「零個條件的時候 WHERE 後面要放什麼」），
   而【解法一模一樣】。
   差別只是：MyBatis 的 <where> 幫你把它藏起來，Criteria 沒有。
                              ↓
⚠️ 而 08 章 8.3.3 說的那三個問題（可讀性、索引、以及「它讓你忘記真正的問題」），
   前兩個在這裡不成立（1=1 被最佳化器丟掉，EXPLAIN 裡看不到它），
   第三個成立 —— 而 9.9.2 那個 bug 就是「真正的問題」的一個例子。
```

### 9.9.6 08 章練習九的答案

08 章 8.12.5 練習九是這樣寫的：

> **練習九（把兩個實作收成一個）**
> 8.10.6 那張表有兩個「動態搜尋」。挑一個留下來，然後：
> ① 列出你刪掉的那一個提供了什麼（別忘了 05 章 5.9.6 的「條件可以單獨測試」）；
> ② 把 `OrderSpecifications.customerLike` 與 `OrderSearchCriteria.likePattern`
> 那條重複的跳脫規則**收成一份**，並寫一個測試證明它們一致；
> ③ **09 章會給它的答案 —— 先寫下你的，然後對照。**

**答案**：

```
① 兩邊各自提供什麼 → 9.9.1 那張清單（各三項）
   而正確的做法不是「挑一個」，是【挑一個 + 把對面的優點補進來】：
   09 章那一版留下 Specification（條件可單獨測試），
   換掉回傳型別（0 個實體），count 共用同一個 Specification（結構上一致）。

② 收成一份 → 9.9.3 的 LikePattern，六個輸入的一致性測試。
   ⚠️ 而「寫一個測試證明它們一致」這個要求，在收成一份【之後】就沒有意義了 ——
     它變成 assertEquals(x, x)。
     真正有意義的測試是 9.9.3 下半段那個：
     「關鍵字是 % 的時候，兩邊都回 0 筆（而不是 200 筆）」。

③ 而 09 章多給了一個練習沒問的東西：
   ★★ 那條契約測試（9.9.2）抓到兩個實作【從來就不一致】。
   → 所以「收斂」的第一步不是刪掉一個，是【先證明它們一樣】。
     而在 shop-service 上，那一步就失敗了。
```

📌 **一句話**：

> **「兩個實作」的真正成本，不是維護兩份程式碼 ——**
> **是【你以為它們一樣】。**

---

## 9.10 如果兩個都不選

08 章 8.13 交待的第六件事：

> ⑥ 🔴 而最後一節要回答一個這一站一直沒問的問題：
> 「如果兩個都不選呢？」—— JdbcTemplate / jOOQ / 純 JDBC 在 2026 年的位置

**這一站走了九章，一直在「JPA vs MyBatis」這個二選一裡。而那個二選一是假的。**

### 9.10.1 同一頁五種寫法

**那三個「不是框架」的實作（`ch09` 套件裡，都是真的可以跑的程式碼）**：

```java
package com.example.lab.ch09;

import com.example.lab.Uuid7;
import com.example.lab.shop.OrderListRow;
import com.example.lab.shop.OrderStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Component;

import java.time.ZoneOffset;
import java.util.List;

/**
 * 9.10：「兩個都不選」的第一個選項 —— JdbcTemplate。
 *
 * ★ 它跟 MyBatis 的差別只有兩件事：
 *   ① SQL 寫在 Java 字串裡（不是 XML），所以【沒有動態 SQL 的語法】
 *   ② 列 → 物件要自己寫一個 RowMapper（不是 resultMap）
 * 其餘全部一樣：沒有持久化情境、沒有髒檢查、沒有延遲載入。
 */
@Component
public class JdbcRows {

    /** ★ 跟 07 章 7.15 那份 XML 一字不差的同一句 SQL。 */
    static final String SQL = """
            SELECT o.id, o.order_no, c.display_name AS customer_name, o.status,
                   o.total_amount, o.placed_at,
                   (SELECT count(*) FROM order_item i WHERE i.order_id = o.id) AS item_count
              FROM orders o
              JOIN customer c ON c.id = o.customer_id
             WHERE o.status = ?
             ORDER BY o.placed_at DESC
             LIMIT ? OFFSET ?
            """;

    /**
     * ⚠️ 這個 RowMapper 就是「MyBatis 的 resultMap 幫你做的事」，逐欄手寫。
     *    七個欄位 → 七行，而且每一行都要自己知道
     *    「binary(16) 要轉 UUID」「varchar 要轉列舉」「datetime 要當成 UTC」——
     *    也就是 07 章 7.5 那三個 TypeHandler 的內容。
     */
    static final RowMapper<OrderListRow> MAPPER = (rs, i) -> new OrderListRow(
            Uuid7.fromBytes(rs.getBytes("id")),
            rs.getString("order_no"),
            rs.getString("customer_name"),
            OrderStatus.valueOf(rs.getString("status")),
            rs.getBigDecimal("total_amount"),
            rs.getObject("placed_at", java.time.LocalDateTime.class).toInstant(ZoneOffset.UTC),
            rs.getLong("item_count"));

    private final JdbcTemplate jdbc;

    public JdbcRows(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    public List<OrderListRow> listRows(OrderStatus status, int offset, int size) {
        return jdbc.query(SQL, MAPPER, status.name(), size, offset);
    }
}
```

```java
package com.example.lab.ch09;

import com.example.lab.Uuid7;
import com.example.lab.shop.OrderListRow;
import com.example.lab.shop.OrderStatus;
import org.jooq.DSLContext;
import org.jooq.Field;
import org.jooq.SQLDialect;
import org.jooq.Table;
import org.jooq.impl.DSL;

import javax.sql.DataSource;
import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.List;

import static org.jooq.impl.DSL.name;
import static org.jooq.impl.DSL.table;

/**
 * 9.10：「兩個都不選」的第三個選項 —— jOOQ。
 *
 * ⚠️ 這一版刻意【不做 codegen】，而那是它最重要的一件事：
 *   jOOQ 真正的賣點是「用產生出來的 schema 類別寫 SQL」——
 *   欄位名打錯是【編譯錯誤】，型別對不上是【編譯錯誤】。
 *   而 codegen 要在建置流程裡接一個「連到資料庫（或跑一次 migration）產生 Java」的步驟。
 *
 *   不做 codegen 的 jOOQ（就是下面這一段）只剩一半：
 *   ✅ SQL 的【結構】是型別安全的（select / from / where 接不對編譯不過）
 *   🔴 而【欄位名】還是字串 —— 跟 MyBatis 一樣是執行期才知道
 */
public class JooqRows {

    private final DSLContext dsl;

    /**
     * ⚠️ 要包一層 {@code TransactionAwareDataSourceProxy}，否則 jOOQ 會自己拿一條連線 ——
     *    也就是它【不在 Spring 的交易裡】。這是接 jOOQ 最常被忘記的一行。
     */
    public JooqRows(DataSource ds) {
        this.dsl = DSL.using(
                new org.springframework.jdbc.datasource.TransactionAwareDataSourceProxy(ds),
                SQLDialect.MYSQL);
    }

    private static final Table<?> O = table(name("orders")).as("o");
    private static final Table<?> C = table(name("customer")).as("c");
    private static final Table<?> I = table(name("order_item")).as("i");

    private static final Field<byte[]> O_ID    = DSL.field(name("o", "id"), byte[].class);
    private static final Field<String> O_NO    = DSL.field(name("o", "order_no"), String.class);
    private static final Field<byte[]> O_CUST  = DSL.field(name("o", "customer_id"), byte[].class);
    private static final Field<String> O_ST    = DSL.field(name("o", "status"), String.class);
    private static final Field<BigDecimal> O_AMT = DSL.field(name("o", "total_amount"), BigDecimal.class);
    private static final Field<LocalDateTime> O_AT = DSL.field(name("o", "placed_at"), LocalDateTime.class);
    private static final Field<byte[]> C_ID    = DSL.field(name("c", "id"), byte[].class);
    private static final Field<String> C_NAME  = DSL.field(name("c", "display_name"), String.class);
    private static final Field<byte[]> I_OID   = DSL.field(name("i", "order_id"), byte[].class);

    public List<OrderListRow> listRows(OrderStatus status, int offset, int size) {
        Field<Integer> itemCount = DSL.field(
                DSL.selectCount().from(I).where(I_OID.eq(O_ID))).as("item_count");

        return dsl.select(O_ID, O_NO, C_NAME.as("customer_name"), O_ST, O_AMT, O_AT, itemCount)
                .from(O).join(C).on(C_ID.eq(O_CUST))
                .where(O_ST.eq(status.name()))
                .orderBy(O_AT.desc())
                .limit(size).offset(offset)
                .fetch(r -> new OrderListRow(
                        Uuid7.fromBytes(r.get(O_ID)),
                        r.get(O_NO),
                        r.get(C_NAME.as("customer_name")),
                        OrderStatus.valueOf(r.get(O_ST)),
                        r.get(O_AMT),
                        r.get(O_AT).toInstant(ZoneOffset.UTC),
                        r.get(itemCount).longValue()));
    }

    /** 9.10.2：欄位名打錯，什麼時候告訴你。 */
    public Object badColumn() {
        return dsl.select(DSL.field(name("o", "order_nu"), String.class))
                .from(O).limit(1).fetchOne(0);
    }

    /** 9.10.2 ⑤：把 decimal(19,4) 宣告成 String —— jOOQ 會怎麼做。 */
    public Object amountAsString() {
        return dsl.select(DSL.field(name("o", "total_amount"), String.class))
                .from(O).limit(1).fetchOne(0);
    }

    /** 9.10.3：不執行也看得到 SQL —— 這一格是 jOOQ 跟 MyBatis 的 Dyn 對得上的地方。 */
    public String sqlOf(OrderStatus status, int offset, int size) {
        Field<Integer> itemCount = DSL.field(
                DSL.selectCount().from(I).where(I_OID.eq(O_ID))).as("item_count");
        return dsl.select(O_ID, O_NO, C_NAME.as("customer_name"), O_ST, O_AMT, O_AT, itemCount)
                .from(O).join(C).on(C_ID.eq(O_CUST))
                .where(O_ST.eq(status.name()))
                .orderBy(O_AT.desc())
                .limit(size).offset(offset)
                .getSQL();
    }
}
```

```
═══ 9.10.1 同一頁五種寫法：SQL / 實體 / 耗時 / 配置 ═══
  ★ 五個都包在【一個交易】裡（9.4.1c 量到交易本身要 0.4～1.5 ms）

  寫法                        SQL       實體         耗時           配置
  JPA 投影（JPQL）              1 句      0 個     3065 µs      70.2 KB
  MyBatis                   1 句      0 個     2505 µs     119.7 KB
  JdbcTemplate              1 句      0 個     1359 µs      57.3 KB
  jOOQ（無 codegen）           1 句      0 個     1876 µs     122.2 KB
  純 JDBC                    1 句      0 個     1166 µs      54.6 KB

── 五種寫法的第一列
  JPA 投影（JPQL）           SO-000197 / 客戶9 / PENDING / 496.0000 / 3
  MyBatis                SO-000197 / 客戶9 / PENDING / 496.0000 / 3
  JdbcTemplate           SO-000197 / 客戶9 / PENDING / 496.0000 / 3
  jOOQ（無 codegen）        SO-000197 / 客戶9 / PENDING / 496.0000 / 3
  純 JDBC                 SO-000197 / 客戶9 / PENDING / 496.0000 / 3
```

⚠️ **這張表要小心讀 —— 它跟 9.4.1b 那張「1.00×」看起來矛盾。**

```
9.4.1b：JPA 與 MyBatis 在【同一句查詢】上 0.97～1.02×
9.10.1：JPA 3065 µs、MyBatis 2505 µs、純 JDBC 1166 µs
                              ↓
差別在【量的方式】：
   9.4.1b 用 inTxBestFresh（暖機在另一個交易，每組參數只跑一次）
   9.10.1 用 bestMicros（每一次都開一個新交易）
                              ↓
📌 也就是說 9.10.1 這張表【包含交易成本】，而那 1.2～1.9 ms 的差別裡
   有很大一塊是「開交易 + 拿連線 + commit」——
   而 JdbcTemplate 與純 JDBC 那兩版在【同一個交易】裡是最便宜的，
   因為它們不用做 flush 檢查、不用管快取、不用建 SqlSession。
```

✅ **可以放心下的結論只有兩個**：

```
① 五種寫法的【結果一字不差】—— 同一句 SQL、同一個 record。
② 而「配置」那一欄跨過交易的雜訊：
      純 JDBC 54.6 KB < JdbcTemplate 57.3 KB < JPA 投影 70.2 KB
      < 純 JDBC 的兩倍：MyBatis 119.7 KB、jOOQ 122.2 KB
                              ↓
   而 9.4.5 那個 12500 列的匯出（沒有交易雜訊、資料量大）給了同一個排序：
      JdbcTemplate 7.6 MB < JPA 投影 15.7 MB < MyBatis 30.7 MB
```

### 9.10.2 四種選項的「錯誤何時被發現」

**9.5.4 那張表就是這一節的核心，這裡只補 jOOQ 的兩格**：

```
── ④ jOOQ（沒有 codegen）
   DataAccessException ← SQLSyntaxErrorException
   —— Unknown column 'o.order_nu' in 'field list'
   📌 有 codegen 的 jOOQ 這一格是【編譯錯誤】

── ⑤ jOOQ 的型別呢：把 decimal(19,4) 綁成 String
   讀回來 = 300.0000（String）→ 🔴 它【靜默轉換】，不報錯
```

🔴 **`DSL.field(name("o", "total_amount"), String.class)` 不報錯，它幫你轉成字串。**

```
jOOQ 的型別系統是【你宣告的那個】，不是【資料庫裡的那個】——
   除非你用 codegen（那時候型別是從 schema 產生的）。
                              ↓
📌 所以「不做 codegen 的 jOOQ」在型別安全這一格上，
   跟 MyBatis 的 resultType 對不上（07 章 7.8.1 那個靜默 null）是同一個等級：
      MyBatis：對不上 → 靜默 null
      jOOQ   ：對不上 → 靜默轉換
```

✅ **而 jOOQ 有一格是這五種寫法裡最強的**：

```
── ⑥ 不執行看得到 SQL 嗎（08 章 8.2.3 那把尺，其他寫法有沒有）
   MyBatis      ✅ MappedStatement.getBoundSql()
   jOOQ         ✅ query.getSQL()：
      select `o`.`id`, `o`.`order_no`, `c`.`display_name` as `customer_name`,
             `o`.`status`, `o`.`total_amount`, `o`.`placed_at`,
             (select count(*) from `order_item` as `i` where `i`.`order_id` = `o`.`id`) as…
   JPA Criteria 🔴 unwrap(Query).getQueryString() 回傳 "<criteria>"（9.8.2）
   JdbcTemplate ✅ SQL 就是那個字串常數（而它沒有動態組合）
```

```
📌 jOOQ 同時有兩件事，而那是它真正的賣點：
   ✅ 動態組合（跟 MyBatis 的 <if> 一樣，而它是 Java 的 if）
   ✅ 不執行看得到 SQL（跟 08 章 8.2.3 那把尺一樣）
                              ↓
也就是說 08 章 8.9 那五條斷言【在 jOOQ 上全部寫得出來】，
而且不需要 XML、不需要 OGNL、不需要 Dyn 那個工具類別。
```

### 9.10.3 五種選項在 2026 年的位置

| 選項 | 它是什麼 | 什麼時候選它 | 什麼時候不要 |
|---|---|---|---|
| **JPA / Hibernate** | 一個**有狀態的中間層** | 寫入導向、有聚合與不變量、schema 是你的 | 只有查詢、老 schema、團隊沒人懂它 |
| **MyBatis** | 一個 **SQL ↔ 物件的映射器** | 查詢導向、報表、老 schema、SQL 要能整段貼出去跑 | 有複雜的聚合寫入（9.7.2 那六件事） |
| **`JdbcTemplate`** | 一層**很薄的 JDBC 包裝**（例外轉換 + 樣板消除） | 只有幾十個查詢、不想多一個框架、批次 / 匯出 | 查詢多到需要「一個地方管所有 SQL」 |
| **jOOQ** | 一個**型別安全的 SQL 建構器**（+ codegen） | 查詢多而且動態、要編譯期檢查、團隊 SQL 強 | 不能在建置流程接 codegen（那就只剩一半） |
| **純 JDBC** | 基線 | 🔴 幾乎沒有 —— 除了寫框架、寫工具 | 應用程式程式碼 |

⚠️ **而 2026 年還有兩個選項，這一站沒有實測，但要知道它們存在**：

```
① Spring Data JDBC
   「有 repository、有聚合的概念，而【沒有持久化情境】」——
   它的模型是「一個聚合根一次整體讀寫」（沒有延遲載入、沒有髒檢查、沒有一級快取）。
   → 它解掉的正是這一站 03 / 04 章那兩章的問題（狀態與 N+1）
   → 而它的代價是：關聯只能有「聚合內」的，跨聚合只能存 id
   → 適合：DDD 風格的專案、聚合邊界清楚、不想要 ORM 的魔法

② R2DBC（響應式）
   如果你的服務是 WebFlux，JDBC 會擋住整個事件迴圈。
   → 而它跟這一站的每一個結論【都不一樣】（沒有 JPA、交易語意不同、
     連 @Transactional 都是另一套）—— 那是另一門課的範圍。
```

### 9.10.4 一個很實際的組合

**這一站的九章講完之後，最常見的「正確答案」其實是一個組合**：

```
✅ 寫入路徑（有不變量的那些）        → JPA（一個聚合一個 Service 方法）
✅ 列表與搜尋（唯讀、要分頁）        → JPA 的【投影】（9.9.4 那一版）
✅ 報表（窗口函式、樞紐、跨表統計）   → MyBatis 或 JdbcTemplate
✅ 匯出 / 批次（幾十萬列）           → JdbcTemplate 的 RowCallbackHandler（9.4.5 最省）
✅ 老 schema 的表（沒有主鍵那種）    → MyBatis 或 JdbcTemplate，【只讀】
                              ↓
📌 而這個組合的關鍵不是「用了幾個工具」，是：
   ✅ 每一張表【只有一個框架寫】（9.6.1）
   ✅ 那個界線出現在【套件結構】上（00 章 0.9 規則三）
   ✅ 而界線被打破的時候，是一個【建置失敗】（07 章 7.14.2 那條 ArchUnit）
```

⚠️ **而「工具的數量」有一個實際的上限，它跟技術無關**：

```
每多一個工具，就多一套：
   慣例（要寫進 code review 清單）
   斷言（9.8 那 25 條要各自對應）
   「新人要學的東西」
   「出事的時候要看的地方」
                              ↓
📌 9.6.5 量到「多一個框架的技術成本 ≈ 0」——
   而上面那四樣的成本【不是 0，而且它隨團隊人數成長】。
   所以「兩個」通常是合理的上限，而「三個」要有非常具體的理由。
```

---

## 9.11 shop-service 的最終樣子

### 9.11.1 09 章的七個改動

**這一章是「結案」，所以它對 shop-service 的改動很少 —— 而每一個都是實測逼出來的。**

| # | 改動 | 檔案 | 為什麼 |
|---|---|---|---|
| 1 | **新增 `LikePattern`** | `shop/LikePattern.java` | 跳脫規則有兩份（9.9.3） |
| 2 | `OrderSearchCriteria.likePattern()` 改用它 | `shop/OrderSearchCriteria.java` | 同上 |
| 3 | `OrderSpecifications.customerLike()` 改用它，`join` 換成**點號** | `shop/OrderSpecifications.java` | 同上 + 9.9.5 |
| 4 | 🔴 **新增 `placedFrom` / `placedTo`，`of()` 拆成兩個條件** | `shop/OrderSpecifications.java` | **從 05 章活到現在的 bug**（9.9.2） |
| 5 | 🔴 `listRows` 的 `order by` 加 `o.id desc` | `shop/OrderRepository.java` | **分頁會漏會重複**（9.8.4 斷言 B） |
| 6 | **新增 `OrderSearchQuery`**（Criteria + `cb.construct`） | `shop/OrderSearchQuery.java` | 收斂兩個實作（9.9.4） |
| 7 | **新增 `OrderService.searchPage()`** | `shop/OrderService.java` | 同上 |

```java
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
```

### 9.11.2 實測：每一個用例，最後量一次

```java
    @Test
    void g5_shop_service_最後的樣子() {
        head("9.11 shop-service 每一個用例，最後量一次");
        // 每一個用例都量：SQL 句數、建了幾個實體、耗時
    }
```

```
═══ 9.11 shop-service 每一個用例，最後量一次 ═══

  用例                         走哪一邊                    SQL       實體         耗時
  view() 明細頁                 JPA @EntityGraph        1 句      8 個     1203 µs
  list() 分頁列表                JPA 投影                  2 句      0 個     1216 µs
  searchPage() 動態搜尋          JPA Criteria 投影         2 句      0 個     1352 µs
  listAfter() 載入更多           MyBatis keyset          1 句      0 個      979 µs
  searchByStatuses()         MyBatis foreach         1 句      0 個     1104 µs

── 而 09 章 9.8.4 那條斷言（有 limit 就要有唯一 order by）現在過了嗎
   list()        → order by o1_0.placed_at desc,o1_0.id desc limit ?,
   searchPage()  → order by 6 desc,1 desc limit ?,?
```

⚠️ **`searchPage()` 那個 `order by 6 desc, 1 desc` 要解釋一下**：

```
Criteria 的 cb.construct 投影 + orderBy(o.get("placedAt")) →
   Hibernate 把排序翻譯成【select 清單的序號】：6 = placed_at、1 = id。
                              ↓
✅ 語意完全正確（SQL 標準允許 ORDER BY 序號），而它有兩個後果：
   🔴 08 章 8.9.4 那條斷言（正規表達式找 order by 後面的欄位名）在這一句上
      要改成「認得序號」，否則它會誤判成「沒有排序欄位」
   🟡 而人去看 general log 的時候，要自己數第 6 個欄位是誰
```

### 9.11.3 shop-service 最終的全貌

| 用例 | 走哪一邊 | SQL | 實體 | 最後改它的章節 |
|---|---|---|---|---|
| `place()` 新增訂單 | JPA | **4** | — | 06 章 6.11.2 |
| `addItem()` | JPA | 4 | — | 03 章 3.11.4 |
| `pay()` / `cancel()` | JPA | 2 | — | 03 章 3.11.4 |
| `view()` 明細頁 | JPA（`@EntityGraph`） | **1** | 8 | 04 章 4.11 |
| `list()` 分頁列表 | JPA（投影） | 2 | **0** | **09 章 9.8.4**（加 tiebreaker） |
| **`searchPage()` 動態搜尋** | **JPA（Criteria 投影）** | **2** | **0** | **09 章 9.9.4** |
| `searchRows()` 動態搜尋 | MyBatis `<if>` | 2 | 0 | 🟡 **降級為契約測試的對照組**（9.9.4） |
| `search()` 動態搜尋（回實體） | JPA `Specification` | 2 | 21 | 🟡 **保留做對照**（9.9.4） |
| `searchByStatuses()` | MyBatis `<foreach>` | 1 | 0 | 08 章 8.10.3 |
| `listAfter()` 載入更多 | MyBatis keyset | 1 | 0 | 08 章 8.10.4 |
| `listRows()` 列表 | MyBatis | 2 | 0 | 07 章 7.15.2 |
| `salesRanking()` 報表 | MyBatis（窗口函式） | 1 | 0 | 07 章 7.15.4 ⚠️ **而 HQL 也做得到**（9.3.3） |
| `statusPivot()` 樞紐表 | MyBatis | 1 | 0 | 07 章 7.15.4 ⚠️ 同上 |
| `OrderImportService` 匯入 | JPA 批次 | O(N/batch) | — | 06 章 6.11.4 |

📌 **而這張表最後的形狀，回答了 00 章 0.8.4 那個決定**（帳一）：

```
00 章的決定：「主線用 JPA，報表與列表查詢用 MyBatis」
                              ↓
09 章的結論：
   ✅ 「主線用 JPA」—— 完全成立，而且 09 章讓它【更強】
      （9.7.2 那六件事、9.3.5 那個身分保證、9.6.1 那個樂觀鎖）
   🟡 「列表查詢用 MyBatis」—— 理由不成立了（9.4.1b 的 1.00×），
      所以 09 章把它收斂回 JPA 的投影（9.9.4）
   ✅ 「報表用 MyBatis」—— 理由要換（不是「JPA 做不到」，是可維護性），
      而換過的理由【還站得住】（9.3.3）
                              ↓
📌 所以那個決定「哪一半是對的」：
   ✅ 對的那一半是【依讀寫切】這個結構（規則三：套件邊界）
   🔴 錯的那一半是【那個結構的理由】（「MyBatis 比較快」）
```

---

## 9.12 常見誤區

**① 「我們選 MyBatis，因為它比較快。」**

🔴 9.4.1b：同一句 SQL、同一個投影、五個資料量 → **0.97～1.02 倍**。
🔴 9.4.2：1～16 條執行緒的吞吐 → **1.00～1.45 倍**，而 16 條的時候是 1.00。
✅ 真正的說法是：**「Spring Data 的 `findBy` + 實體投影」比「MyBatis + record」慢兩倍**，
而那是兩個技術選擇的差別 —— **JPA 換成 JPQL 投影就一樣快**。

**② 「JPA 比較慢，因為它多了一層。」**

🔴 那一層的成本在 9.4.1c 量到了：**同一句查詢 480 vs 518 µs**。
✅ 貴的不是「那一層」，是**那一層做的事**：建實體（9.3.2：90 個 = 400 KB）、
維護持久化情境、Criteria 的翻譯。**而這三件事都可以不做。**

**③ 「報表只能用 MyBatis / 原生 SQL。」**

🔴 9.3.3：07 章那兩份報表（CTE + 窗口函式 + 樞紐）用 HQL 各寫一次，
**兩邊的 `List.equals()` 完全相等**。
✅ 「報表用 MyBatis」是**可維護性**的決定（SQL 可以整段貼到 client 上跑、
不需要懂 HQL 擴充），不是**能力**的決定。

**④ 「MyBatis 換資料庫要把 SQL 全部重寫。」**

🔴 9.3.6：shop-service 那六個 statement 搬到 H2，**五個一個字都沒改**，
壞掉的那一個壞在**一個函式**（`DATE_FORMAT`）。
✅ 而 JPA 那一側「4/4 過」的代價是：**它把 schema 換成另一個東西**
（`binary(16)` → `uuid`、`datetime(3)` → `timestamp with time zone`）。

**⑤ 「混用很貴。」**

🔴 9.6.5：多一個框架 = 啟動慢 16 ms、多 11 個 bean、jar 多 1.8 MB。**幾乎為零。**
✅ 貴的是那四個地雷：樂觀鎖靜默失效（9.6.1）、
同一個交易兩個值（9.6.2）、flush 了還查不到（9.6.3）、
同一個 `LocalDateTime` 差 8 小時（9.6.4）。
**而它們都不會出現在架構評估表上。**

**⑥ 「一張表兩個框架都寫沒關係，反正是同一個交易。」**

🔴 9.6.1：`UPDATE orders SET status='CANCELLED'`（不動 `version`）
→ 另一個交易的 JPA 用**過時的狀態**做決定 → 一張**已取消**的訂單變成 `PAID`，
**沒有任何錯誤**。
✅ 修好它的是**一行** `SET version = version + 1` ——
而讓它一直被寫對的，是 06 章 6.10.3 / 07 章 7.14.3 那兩條斷言。

**⑦ 「搬到 MyBatis 就是把 SQL 寫出來而已。」**

🔴 9.7.2：`place()` + `pay()` 從 17 行變 63 行，而那 46 行是**六件事**。
🔴 9.7.3：漏掉第 6 件（樂觀鎖）→ 20 個人同時付款，**10 個人收到「付款成功」**。
✅ 而最重要的一件是**不變量的位置**：JPA 在領域物件上（繞不過），
MyBatis 在 Service 上（**另一個 mapper 就繞過了**）。

**⑧ 「我們有兩個實作，兩邊都測過，所以它們一樣。」**

🔴 9.9.2：那兩個實作**從 08 章開始就不一致** ——
「只填結束時間」的搜尋，JPA 那一側**靜默忽略**那個條件。
而 08 章 8.10.2 那五組對照**剛好都沒踩到**。
✅ 契約測試要：比**整組結果**（不是第一頁）、
有**剛好等於門檻**的邊界資料、比**順序**。

**⑨ 「那條 CI 斷言是 MyBatis 專用的。」**

🔴 9.8.3：32 種條件組合在 JPA 那一側產出的形狀數是 **28**（不是 32）——
而那個 28 就是 ⑧ 那個 bug 的指紋。
✅ 25 條斷言裡有 **12 條兩側都要**，而其中 7 條是**核心**（9.8.5）。

**⑩ 「不執行也看得到 SQL 是 MyBatis 的特權。」**

🔴 9.10.2 ⑥：**jOOQ 的 `getSQL()` 也可以**，而且它同時有動態組合。
✅ 而 JPA 的 Criteria 是這五種寫法裡**唯一做不到**的
（`getQueryString()` 回傳字串 `"<criteria>"`）—— 代價是那條斷言貴 5 倍、還要一個資料庫。

**⑪ 「用 `LocalDateTime` 就好，反正資料庫也是 `datetime`。」**

🔴 9.3.5b / 9.6.4：同一個 `LocalDateTime`，
Hibernate 的 native query 送出去的值比 JdbcTemplate / MyBatis **少 8 小時**，
而它的症狀是**查詢回 0 筆**（不是例外）。
✅ 跨框架共用的參數與 DTO，型別要用 `Instant` / `UUID` / `BigDecimal` / `String`。

**⑫ 「這一站教完了，我應該選哪一個？」**

✅ **這一站沒有那個答案，而它有一個更有用的東西**：
**七個判準（00 章 0.8.2）+ 六條軸的實測（9.3）+ 一組斷言（9.8.5）。**
**選型是一個【可以推導的決定】，而推導的輸入是你的專案，不是別人的 benchmark。**

---

## 9.13 本章小結

**這一章講的是「把八章的量測變成一個決定」。**

```
帳一：00 章 0.8.4 那個選型決定（9.11.3）
   ✅ 結構對了（依讀寫切、套件邊界）
   🔴 而理由錯了（「MyBatis 比較快」）—— 9.4 把它拆成四塊

帳二：「快兩倍」（9.4.6）
   ✅ 同一句 SQL、同一個投影 → 0.93～1.02 倍
   ✅ 那個兩倍 = 交易 + Criteria 翻譯 + 建實體
   ✅ 而「一句撈齊 vs 一列一句」是 3.6～4.5 倍 —— 量級 > 常數倍

帳三：混用的成本（9.6）
   ✅ 技術成本 ≈ 0（16 ms、11 個 bean）
   🔴 而四個地雷全部是【靜默的】，三個要靠斷言、一個要靠型別紀律
```

### 9.13.1 這一章修正的五句話

| 說法 | 實測 | 節 |
|---|---|---|
| 08 章 8.13「那個 8 倍的等價寫法 JPA 那一側做不到」 | 🔴 **做得到**（3557 → 930 µs），**而 JPA 也寫得出慢的那一種** | 9.3.1 / 9.3.1b |
| 00 章 0.8.1 場景 D「報表 → MyBatis」（因為 JPA 做不到） | 🔴 **兩邊 `equals()` 相等**；理由要換成可維護性 | 9.3.3 |
| 00 章 0.6.6「MyBatis 換資料庫要自己改 SQL」 | 🔴 **六句裡壞一個函式**；而 JPA 那一側**換掉了 schema 型別** | 9.3.6 |
| 05 章 5.14「`OrderSpecifications.of()`」 | 🔴🔴 **它從一開始就漏掉「只填一邊的時間範圍」** | 9.9.2 |
| 「`addQueryHint` 是最佳化器提示」 | 🔴 在 MySQL 上它是 **`USE INDEX`**（傳最佳化器提示會語法錯） | 9.3.1 |

### 9.13.2 這一章回收的六個承諾

| 承諾 | 結果 |
|---|---|
| 08 章 8.13 ①「六條軸的最終對照表」 | ✅ 9.3.7（六格裡**四格要改**） |
| 08 章 8.13 ②「什麼場景快、什麼場景省事」 | ✅ 9.4（快）+ 9.5（省事，三個成分各自有量法） |
| 08 章 8.13 ③「同專案共存的三種切法」 | ✅ 9.6（三種切法 + 各自的第一號地雷 + 成本加總） |
| 08 章 8.13 ④「遷移成本評估」 | ✅ 9.7（真的搬一次：17 → 63 行、六件事、漏一件的後果） |
| 08 章 8.13 ⑤「21 條斷言哪幾條跨框架」 | ✅ 9.8（實際是 25 條，**12 條兩側都要、7 條是核心**） |
| 08 章 8.13 ⑥「如果兩個都不選」 | ✅ 9.10（五種寫法同一頁 + 錯誤何時被發現 + 2026 年的位置） |
| 08 章 8.12.5 練習九 | ✅ 9.9.6（而答案比題目多一項：**那兩個實作從來不一致**） |

### 9.13.3 六把尺（這一站的完整工具箱）

| 尺 | 站在哪一層 | 能回答什麼 | 誰能用 |
|---|---|---|---|
| `Dyn`（`getBoundSql`） | MyBatis 組完 SQL | 這組參數會產生什麼 SQL（**不執行**） | MyBatis、jOOQ |
| 攔截器 | `Executor` | statement 被呼叫幾次（含快取命中） | MyBatis |
| `SqlSpy` | JDBC | 應用程式呼叫了幾次 `execute()` | **全部** |
| Hibernate `Statistics` | Hibernate 內部 | 建了幾個實體、flush 幾次、N+1 分數 | JPA |
| `MysqlStat` | 資料庫伺服器 | 伺服器剖析／執行了幾句、掃了幾列 | **全部** |
| ★ **`Alloc`** | JVM | **配置了幾個位元組** | **全部** |

⚠️ **而這一站證明「量尺自己會騙人」五次**：

```
① Dyn.args 用 HashMap → 把「參數名打錯」量成「條件不成立」（08 章 8.3.11b）
② SqlSpy 與 Dyn 對 PageHelper 的看法完全不一樣（08 章 8.6.3）
③ 延遲載入的 SQL 句數取決於同一個交易裡之前查過什麼（08 章 8.5.9）
④ ★ 在同一個交易裡重複量同一句查詢 → 量到的是【一級快取】（9.4.1c）
⑤ ★ 「32 種組合只有 28 種形狀」→ 那不是量錯，那是【程式碼有 bug】（9.8.3）
                              ↓
📌 ④ 與 ⑤ 是同一件事的兩面：
   一個「看起來太好」的數字，要嘛是量錯，要嘛是【你量到了另一件事】。
   而後者常常比你原本想量的更有價值。
```

### 9.13.4 驗收清單

**六條軸**
- [ ] 「誰決定 SQL」的三層各是什麼？MyBatis 在哪一層？（9.3.1）
- [ ] `addQueryHint` 在 MySQL 上產生什麼？它跟 `FORCE INDEX` 差在哪？（9.3.1）
- [ ] keyset 分頁的兩種寫法，JPQL 各翻譯成什麼？哪一種快？為什麼？（9.3.1b）
- [ ] 「0 個實體」與「配置比較少」是同一件事嗎？（9.3.2）
- [ ] 報表用 MyBatis 的三個**還站得住**的理由？（9.3.3）
- [ ] 沒有主鍵的表，JPA 的兩種下場分別是什麼？（9.3.5）
- [ ] 同一欄 `datetime`，兩個框架差 8 小時的機制？兩個解法？（9.3.5b）
- [ ] shop-service 搬到 H2：兩邊各過幾個？JPA 那一側的代價在哪？（9.3.6）

**帳二（效能）**
- [ ] 08 章那個「兩倍」拆成哪四塊？哪兩塊可以不付？（9.4.1c、9.4.6）
- [ ] 為什麼「在同一個交易裡重複量」會量到假數字？兩個框架各自的原因？（9.4.1c）
- [ ] 16 條執行緒的時候兩邊的吞吐比值是多少？為什麼？（9.4.2）
- [ ] 同一個 492 µs，在「查資料」與「整支 API」裡各佔多少？（9.4.3）
- [ ] 「一句撈齊 vs 一列一句」是幾倍？跟選型的幾倍比？（9.4.4）
- [ ] 匯出 12500 列，五種寫法的排序？「實體 vs 投影」是幾倍？（9.4.5）

**省事**
- [ ] 「省事」的三個成分？它們為什麼常常方向相反？（9.5.1）
- [ ] 讀取側與寫入側的行數比，各是多少？（9.5.2）
- [ ] 五種寫法的「欄位名打錯何時被發現」？（9.5.4）
- [ ] 00 章 0.8.1 那六個場景，哪幾格變了？哪一格完全沒動？（9.5.5）

**混用**
- [ ] 三種切法各自什麼時候合理？第一號地雷是什麼？（9.6.6）
- [ ] 「一張表兩個框架都寫」的完整因果鏈（五步）？（9.6.1）
- [ ] 切法二為什麼通常是「不要」？三個補救各自的代價？（9.6.2）
- [ ] 「flush 了 MyBatis 還是查不到」的原因？兩層機制？（9.6.3）
- [ ] 混用的第四條規則是什麼？哪些型別不能跨框架共用？（9.6.4）
- [ ] 多一個框架的技術成本是多少？真正的成本清單有幾項？（9.6.5）

**遷移**
- [ ] 把寫入路徑搬到 MyBatis，要自己補回來的六件事？（9.7.2）
- [ ] 不變量的三個位置，各自誰繞不過？（9.7.2）
- [ ] 漏掉樂觀鎖，20 個人同時付款的結果？為什麼是 10 而不是 20？（9.7.3）
- [ ] MyBatis → JPA 的四面硬牆？哪一面最容易被低估？（9.7.4）

**斷言與收斂**
- [ ] 8.9.1 那條斷言搬到 JPA 側要付什麼？`getQueryString()` 回傳什麼？（9.8.2）
- [ ] 「32 種組合只有 28 種形狀」代表什麼？（9.8.3）
- [ ] 那七條「不管選什麼都要有」的斷言？（9.8.5）
- [ ] 契約測試的兩個陷阱？（9.9.2b）
- [ ] 三個動態搜尋實作的對照？09 章選哪一個？三個「答案會反過來」的場景？（9.9.4）

**兩個都不選**
- [ ] 五種寫法在「錯誤何時被發現」上的排序？（9.10.2）
- [ ] 不做 codegen 的 jOOQ 少了哪一半？（9.10.2）
- [ ] 那個「很實際的組合」是什麼？它的三個關鍵？（9.10.4）

### 9.13.5 本章練習

**練習一（把那七條斷言搬進你的專案）**
9.8.5 那七條，在**你自己的專案**上實作出來。要求：
① 每一條都要先**故意寫一個違反它的程式碼**，確認它會紅；
② 量每一條的耗時，把「不需要資料庫」的那幾條放進一個獨立的 test tag；
③ 對「有 `LIMIT` 就要有唯一 `ORDER BY`」那一條，說明你怎麼處理
`order by 6 desc, 1 desc` 這種序號排序（9.11.2）。

**練習二（形狀數的指紋）**
9.8.3 那個「28 vs 32」是一個 bug 的指紋。寫一個通用的工具：
① 輸入 N 個可選條件的 setter 清單，輸出「實際形狀數 vs 2^N」；
② 對**每一個**形狀數少於預期的情況，印出「哪兩組條件產生了同一種 SQL」；
③ 用它掃你專案裡所有的動態查詢，看有幾個 bug。

**練習三（第六把尺的極限）**
9.4.5 說「`ResultHandler` 只省 14% 的配置」，而它省的是**峰值記憶體**。
① 用 `-Xmx64m` 跑那五種匯出，看哪幾種 `OutOfMemoryError`；
② 用 GC log 或 `jcmd GC.heap_info` 量峰值；
③ 說明為什麼「配置」與「峰值」是兩把不同的尺，
以及**哪一把才決定你的服務會不會掛**。

**練習四（把 9.6.4 那條規則變成斷言）**
寫一條 ArchUnit 規則：**跨框架共用的參數與 DTO 型別，不准出現
`LocalDateTime` / `java.util.Date` / `java.sql.Timestamp`**。
要求：① 「跨框架共用」怎麼定義（提示：mapper 介面的參數 + native query 的參數
+ 兩邊都用的 record）；
② 對本章那個 `keysetNative` 的第一版跑一次，確認它抓到；
③ 說明這條規則的**兩個誤判來源**。

**練習五（依表切的邊界）**
9.6.6 說「依表切」需要 06 章 6.10.3 + 07 章 7.14.3 那兩條斷言。把它們合成一條：
① 從**兩邊**（JPA 的 native query / `@Modifying`、MyBatis 的 `<update>` / `<insert>`）
掃出「所有寫入哪些表的敘述」；
② 對每一張表，斷言「寫它的敘述全部來自同一側」（白名單式）；
③ 用它掃 `shop` 這個庫，確認它抓到 `Mix9Mapper.bypassStatus`（9.6.1 那個違規的）。

**練習六（jOOQ 的一半）**
9.10.2 說「不做 codegen 的 jOOQ 只剩一半」。把那一半補回來：
① 在建置流程接 jOOQ 的 codegen（連 `jpa-lab` 的 `shop` 庫，或用 DDL 腳本）；
② 把 `JooqRows` 改成用產生出來的類別，然後**故意把欄位名打錯**，確認是編譯錯誤；
③ 量那個 codegen 讓 `mvn clean install` 慢了多久；
④ 說明「建置要連資料庫」這件事在 CI 上的三個問題與各自的解法。

**練習七（選型報告）**
挑一個**你真的在維護的專案**，寫一份兩頁的選型報告：
① 00 章 0.8.2 那七個判準，各自的答案與證據；
② 9.3.7 那六條軸，哪幾條對你的專案有影響；
③ 如果要換框架，用 9.7.5 那個公式估成本（要真的去數查詢與寫入路徑的數量）；
④ **最後一段寫「不換」的理由** —— 而它必須跟前三段一樣具體。

**練習八（把這一站的實測跑在你的環境上）**
這一章所有的數字都來自「本機 MySQL 8.0.46 + JDK 21 + 同一台機器」。
① 把 9.4.1b / 9.4.2 / 9.4.5 那三個測試跑在**有網路延遲的資料庫**上
（另一台機器，或者用 `tc netem` 加 5 ms 延遲）；
② 說明哪些結論**變了**、哪些**沒變**；
③ 而如果有結論變了，說明它是**這一章的結論錯**，
還是**你的環境讓另一個因素變成瓶頸**。

---

## 9.14 這一站結束了

**這一站從 00 章那六個「程式碼看起來完全正確」的事故開始，走了十章。**

```
00 章  六個事故：沒 save() 卻寫入、251 句 SQL、save() 多一句 SELECT、
                LazyInitializationException、混用讓樂觀鎖失效、${} 讓 WHERE 消失
01 章  映射：五個硬性要求、五種主鍵策略、@Enumerated 的定時炸彈
02 章  關聯：擁有方、cascade、orphanRemoval、MultipleBagFetchException
03 章  持久化情境：一級快取、髒檢查、四種狀態、persist vs merge、flush（核心）
04 章  N+1：重現那 251 句、代理、五種解法有三種是錯的、@BatchSize（核心）
05 章  查詢：JPQL 不是 SQL、參數、批次 update、DTO 投影（核心）
06 章  效能與並行：三把尺、批次失效的四件事、二級快取、樂觀鎖與悲觀鎖（核心）
07 章  MyBatis 基礎：四層、TypeHandler、#{} 與 ${}、resultMap、一級快取
08 章  MyBatis 進階：動態 SQL、foreach、resultMap 深入、分頁、二級快取、攔截器
09 章  結案：六條軸、那個兩倍、混用的四個地雷、遷移的六件事、七條斷言
```

📌 **如果這一站只留一張圖，是這一張**：

```
                    你的程式碼
                        │
        ┌───────────────┴───────────────┐
        │                               │
   有狀態的那一層                  沒有狀態的那一層
   （持久化情境）                  （一句 SQL 一個結果）
        │                               │
   ✅ 它幫你：身分、髒檢查、          ✅ 它給你：形狀自由、
      cascade、樂觀鎖、               SQL 可控、沒有意外的寫入
      不變量的位置
        │                               │
   🔴 它的代價：N+1、LIE、           🔴 它的代價：接合錯誤（07 章）、
      merge 的陷阱、批次失效、          組合錯誤（08 章）、
      「沒 save 卻寫入」               不變量要自己守（9.7.2）
        │                               │
        └───────────────┬───────────────┘
                        │
              而【每一個查詢】都可以自己選一邊
                （05 章那把刀、9.9.4 那個收斂）
```

> 📌 **這一站真正教的東西，不是 JPA、也不是 MyBatis。**
>
> **是「把一個模糊的感覺變成一個可以量的數字」這件事**：
>
> ```
> 「這支 API 好像有點慢」        → 幾句 SQL？幾個實體？幾個位元組？
> 「聽說 MyBatis 比較快」        → 快在哪一段？固定成本還是每列成本？
> 「混用應該沒問題吧」           → 那四個地雷，你的專案有幾個？
> 「這兩個實作應該一樣」         → 十組條件跑一次，含邊界值。
> 「換框架大概要三個月」         → 幾個查詢 × 1 + 幾個寫入路徑 × 6 件事。
> ```
>
> **而那五個問句，換到 Redis、換到訊息佇列、換到任何一個新技術上，都還是有效的。**

### 下一站

**[09-spring-security/](../09-spring-security/)：認證與授權。**

```
這一站處理的是「資料進出資料庫」。
下一站處理的是「誰可以讓資料進出」——
   而它跟這一站有兩個直接的接點：

① 資料層的權限過濾（多租戶）
   08 章 8.8.4 那個「用攔截器自動加租戶條件」的四個地雷還在，
   而 09 站會給它正確的做法（Hibernate 的 @Filter / Spring Security 的
   方法層授權 / 或者「就是在 Service 裡多一個參數」）。

② 稽核欄位（created_by / updated_by）
   01 章 1.15 那兩種審計做法只填了時間，沒填「人」——
   因為「現在是誰」要等 SecurityContext。
```
