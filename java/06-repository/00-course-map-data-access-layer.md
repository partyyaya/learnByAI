# 第 00 章：課程地圖與資料存取層定位

> 05-service 站結束時，你交出了一個**完整的商業邏輯層**：
> 11 條不變量、41 個業務例外、七個快取、outbox、約 475 條測試。
>
> 而它底下躺著這個東西：
>
> ```java
> public class InMemoryOrderRepository implements OrderRepository {
>     private final Map<String, Order> store = new ConcurrentHashMap<>();
>     …
> }
> ```
>
> **一個 `ConcurrentHashMap`。**
>
> 這一站要把它換掉。而換掉它會**同時破壞三件你以為已經做對的事**：
>
> 1. 05 站 0.8 那份不變量清單裡，有四條的守法在真的資料庫上**不成立**。
> 2. 07 章的契約測試會發現：`InMemoryOrderRepository` 與真的實作**回傳不同的東西**。
> 3. 02 章那些「已經驗證過」的交易行為，有一部分是**因為底下是 Map 才成立的**。
>
> ⚠️ **所以這一章不是「開始寫 SQL」。**
> 它是先問清楚一個問題：
>
> > **當「存資料的地方」從一個 Map 變成一個【在另一台機器上、
> > 有自己的併發控制、會拒絕你、會變慢、會斷線】的系統時，
> > 你的分層裡有哪些假設會塌掉？**

---

## 0.1 學習目標

完成本章後，你應該可以：

- 說出資料存取層的**四個職責**（翻譯、隔離、原子性的工具箱、效能邊界），以及哪些事**不屬於**它。
- 分辨 **Repository 與 DAO**，並說出 shop-service 為什麼**兩個都有**。
- 列出 Repository 抽象**一定會洩漏的十一件事**，並說出「承認洩漏」為什麼比「假裝沒有」安全。
- 用**七個判準**評審一個資料存取介面的方法簽章，並說出每一個判準在防哪一種事故。
- 說明為什麼**寫路徑要聚合、讀路徑要投影**，以及一個介面同時做兩件事會付出什麼代價。
- 說出 05 站 0.8.3 那**四個守不變量的位置**，在真的資料庫上各自的可靠度 ——
  並解釋一個實測結果：**加了 `CHECK (qty >= 0)` 之後，20 個人仍然搶到了 10 個庫存，而約束一次都沒有觸發**。
- 判斷一條不變量該用**資料庫約束**、**原子 UPDATE**、**唯一索引**還是**應用層檢查**來守。
- 說明交易邊界**為什麼不能放在 Repository**，並讀懂 `Propagation.MANDATORY` 這個守門人的兩個前提。
- 規劃「記憶體假實作 → 真實作」的**六步搬遷路徑**，並用契約測試守住兩者的行為一致。
- 說出資料存取層**不該做的九件事**，每一條都對應一個具體事故。
- 建好 shop-service 的資料層套件結構，並用 **ArchUnit 六組規則**讓分層在 CI 就紅燈。

---

## 0.2 這一站在整條路線的位置

```
           01-java-core     語言 + JVM + 建置 + 測試（已完成）
                ↓
           02-spring-boot   IoC / DI / 自動組態 / AOP / 設定 / 部署（已完成）
                ↓
           03-rest-api      介面契約設計（已完成，產出 orders-api.yaml）
                ↓
           04-controller    Web 層：接請求、驗參數、回錯誤（已完成，70 條端點）
                ↓
           05-service       商業邏輯層：交易、不變量、快取、非同步（已完成，八章）
                ↓
[你在這裡] 06-repository    資料存取層：連線池、SQL、抽象、邊界 ← 把 Map 換成資料庫
                ↓
           07-mysql         資料庫本體：建模、索引、EXPLAIN、InnoDB 的鎖
                ↓
           08-jpa-mybatis   兩種存取實作：ORM vs SQL Mapper
                ↓
           09 / 10          Spring Security / 期末專題
```

### 0.2.1 05-service 站留下的六個問題

05 站每一章的「已知缺口」，攤開來看是同一件事的六個切面：

| 05 站留下的問題 | 它真正在問什麼 | 本站哪一章 |
|---|---|---|
| 「所有併發實驗都在 H2 上」（**05 站** 07 章 7.22） | **測試環境與正式環境的行為差多少** | 00（0.5.4）、06 |
| 「`OrderRepository` 真的實作起來長什麼樣」（**05 站** 07 章結尾） | **介面該怎麼設計，才不會被實作綁架** | **00（0.6）**、02、03 |
| 「交易長度 × 連線池 = TPS 上限」（**05 站** 02 章 2.9.3） | **連線是什麼、為什麼會用完** | 00（0.9.1）、**01** |
| 「`tryReserve` 的原子 UPDATE 到底怎麼寫」（**05 站** 02 章 2.11.8） | **不變量在資料庫這一層怎麼守** | **00（0.8）**、02 |
| 「`InMemoryOrderRepository` 不支援 `search()`」（**05 站** 07 章 7.8.4） | **列表查詢與聚合查詢是不是同一件事** | **00（0.7）**、04 |
| 「`open-in-view` 的四個問題」（**05 站** 03 章 3.9.4） | **物件與資料列的邊界在哪裡結束** | 00（0.4.4）、03、05 |

它們有一個共同點，也正好是 Service 層完全沒有碰到的：

> **Service 層的世界是【你的 JVM 之內】** —— 物件在你手上，
> 你改它就是改了，`ConcurrentHashMap` 幫你處理併發。
> **資料存取層的世界不是** —— 資料在**另一個行程、通常在另一台機器**上，
> 而你與它之間隔著：一條 TCP 連線、一個連線池、一份 SQL 方言、
> 一套與你的 `synchronized` 完全無關的鎖，以及一個**會拒絕你**的伺服器。

⚠️ **這個差異會改變「一個方法要花多久」的量級。**

| 操作 | 大約耗時 | 相對倍數 |
|---|---|---|
| 呼叫一個 Java 方法 | 約 1 ns | 1 |
| `ConcurrentHashMap.get()` | 約 20 ns | 20 |
| **本機 H2 in-memory 的一次查詢**（本章實測） | **約 17,000 ns（0.017 ms）** | **17,000** |
| 同機房 MySQL 的一次簡單查詢 | 約 300,000～1,000,000 ns | **300,000～1,000,000** |

> 📌 **記住最後一列。**
> 05 站的所有設計討論裡，「多呼叫一次 Repository」的成本是 0。
> **這一站開始，它是六個數量級。**
> 本章 0.6 的七個判準裡，有**三個**只是這一列的推論。

### 0.2.2 這一站的產出

```
第 00 章  資料層的職責、抽象洩漏、介面設計判準、不變量的第四個位置、搬遷路徑
第 01 章  DataSource 與連線池：JDBC URL、HikariCP、池大小怎麼算、連線洩漏診斷
第 02 章  JDBC 與 JdbcTemplate：PreparedStatement、RowMapper、具名參數、批次、JdbcClient
第 03 章  Spring Data 抽象：Repository 家族、方法命名查詢、@Query、投影、動態代理原理
第 04 章  分頁、排序與動態查詢：Page / Slice、Sort、Specification、深分頁
第 05 章  交易邊界與批次：唯讀交易、flush 時機、批次寫入、大量資料串流
第 06 章  資料層測試：@DataJpaTest、H2 會騙你、Testcontainers、測試資料的準備與清理
```

**結束時你會有**：

```
✅ 一個真的 JdbcOrderRepository（取代 InMemoryOrderRepository）
✅ 一份 schema.sql，含 CHECK、唯一索引、外鍵 —— 不變量的第四道防線
✅ 一組調過的 HikariCP 設定，以及「為什麼是這些數字」的計算過程
✅ 一個 OrderQueryDao：列表與報表走的另一條路
✅ 一組契約測試：同一份契約跑在 fake 與真實作上
✅ 六組 ArchUnit 守門規則
```

### 0.2.3 這一站**不**處理的四件事

⚠️ 這四件事很容易在這裡被順手講掉，但它們各自屬於後面的站：

| 不在這一站 | 在哪一站 | 為什麼分開 |
|---|---|---|
| **索引怎麼設計、`EXPLAIN` 怎麼讀** | 07-mysql 03 章 | 那是「資料庫怎麼執行查詢」，與 Java 無關 |
| **InnoDB 的鎖、間隙鎖、隔離級別的實測** | 07-mysql 04 章 | 05 站 02 章已講「概念」，07 站補「MySQL 的實際行為」 |
| **JPA 的 Entity 映射、關聯、Lazy、N+1** | 08-jpa-mybatis | 本站的 Spring Data 只講「抽象怎麼運作」，不講 ORM |
| **schema 遷移（Flyway）** | 07-mysql 08 章 | 本站的 `schema.sql` 只求能跑，遷移是另一個主題 |

> ⚠️ **一個刻意的順序決定**：這一站在 07-mysql **之前**。
>
> **為什麼不先學資料庫？** 因為這一站要教的是**邊界**，而邊界的問題與 MySQL 的細節無關 ——
> 「交易邊界該放哪」「介面該回什麼」「fake 與真實作差在哪」，
> 換成 PostgreSQL 或 SQL Server 答案都一樣。
>
> ⚠️ **代價是**：這一站有一部分結論**必須等 07 站才能驗證**。
> 本章會明確標出每一個「等 07 站」的地方 —— 一共有九處。

---

## 0.3 先看見痛：一個 1,400 行的 `OrderDao`

04-controller 站的 0.3 給你看了 800 行的 Controller。
05-service 站的 0.3 給你看了 2,000 行的 `OrderServiceImpl`。

**這一次是最下面那一層。**

以下是一個真實專案的 `OrderDao`（去識別化，從 1,400 行壓縮到 160 行，
但每一種問題都保留）。它的上面**已經有一個乾淨的 Service** ——
所以這不是「沒有分層」的問題，而是**「分了層，但最下面那層什麼都做」**。

```java
@Repository
public class OrderDao {

    @Autowired private JdbcTemplate jdbc;
    @Autowired private DataSource dataSource;
    @Autowired private StockDao stockDao;                    // 🔴 ① DAO 呼叫 DAO
    @Autowired private NotificationService notificationService;  // 🔴 ② DAO 呼叫 Service

    /** 建立訂單 */
    @Transactional                                            // 🔴 ③ 交易邊界在這裡
    public Map<String, Object> createOrder(Map<String, Object> params) {   // 🔴 ④ Map 進 Map 出

        String customerId = (String) params.get("customerId");
        List<Map<String, Object>> items = (List<Map<String, Object>>) params.get("items");

        // 🔴 ⑤ 業務判斷寫在 DAO
        if (items == null || items.isEmpty()) {
            Map<String, Object> err = new HashMap<>();
            err.put("code", "EMPTY_ITEMS");
            err.put("msg", "訂單不可為空");
            return err;                                       // 🔴 ⑥ 用回傳值表達失敗
        }

        // 🔴 ⑦ 迴圈裡查資料庫：N+1
        BigDecimal total = BigDecimal.ZERO;
        for (Map<String, Object> item : items) {
            Map<String, Object> product = jdbc.queryForMap(
                    "select * from product where id = '" + item.get("productId") + "'");  // 🔴 ⑧ 拼字串
            BigDecimal price = (BigDecimal) product.get("price");
            int qty = (int) item.get("qty");

            // 🔴 ⑨ 先查再寫：檢查與寫入之間有縫
            Integer stock = jdbc.queryForObject(
                    "select qty from stock where product_id = ?", Integer.class, item.get("productId"));
            if (stock < qty) {
                throw new RuntimeException("庫存不足");        // 🔴 ⑩ 用 RuntimeException 表達業務失敗
            }
            jdbc.update("update stock set qty = ? where product_id = ?",
                    stock - qty, item.get("productId"));     // 🔴 ⑪ 寫回絕對值 → lost update

            total = total.add(price.multiply(new BigDecimal(qty)));
        }

        // 🔴 ⑫ 折扣規則寫在 DAO
        if (total.compareTo(new BigDecimal("2000")) > 0) {
            total = total.multiply(new BigDecimal("0.95"));
        }
        String vip = jdbc.queryForObject(
                "select level from customer where id = ?", String.class, customerId);
        if ("GOLD".equals(vip)) {
            total = total.multiply(new BigDecimal("0.9"));
        }

        String orderId = "O" + System.currentTimeMillis();    // 🔴 ⑬ 併發下會撞號
        jdbc.update("insert into orders(id, customer_id, amount, status, created_at) values (?,?,?,?,?)",
                orderId, customerId, total, "PENDING", new Date());   // 🔴 ⑭ java.util.Date

        for (Map<String, Object> item : items) {              // 🔴 ⑮ 又一個迴圈寫入
            jdbc.update("insert into order_line(order_id, product_id, qty) values (?,?,?)",
                    orderId, item.get("productId"), item.get("qty"));
        }

        // 🔴 ⑯ 在交易裡寄信
        notificationService.sendOrderCreated(customerId, orderId);

        Map<String, Object> result = new HashMap<>();
        result.put("orderId", orderId);
        result.put("amount", total);
        return result;
    }

    /** 查詢訂單列表 */
    public List<Map<String, Object>> findOrders(String customerId, String status,
                                                String keyword, String sort) {
        // 🔴 ⑰ 動態 SQL 用字串拼，而且 sort 直接來自 query string
        StringBuilder sql = new StringBuilder("select * from orders where 1=1");
        if (customerId != null) sql.append(" and customer_id = '").append(customerId).append("'");
        if (status != null)     sql.append(" and status = '").append(status).append("'");
        if (keyword != null)    sql.append(" and remark like '%").append(keyword).append("%'");
        if (sort != null)       sql.append(" order by ").append(sort);
        return jdbc.queryForList(sql.toString());             // 🔴 ⑱ 沒有 LIMIT
    }

    /** 匯出報表 */
    public List<Map<String, Object>> exportAll() {
        return jdbc.queryForList("select * from orders");     // 🔴 ⑲ 全表進記憶體
    }

    /** 更新狀態 */
    public void updateStatus(String orderId, String status) {
        jdbc.update("update orders set status = ? where id = ?", status, orderId);
        // 🔴 ⑳ 沒有任何狀態機檢查：CANCELLED 可以被改回 PENDING
    }

    /** 取消訂單（客服用） */
    public void cancelByStaff(String orderId, String staffId) {
        Connection con = null;
        try {
            con = dataSource.getConnection();                 // 🔴 ㉑ 自己借連線
            PreparedStatement ps = con.prepareStatement(
                    "update orders set status = 'CANCELLED' where id = ?");
            ps.setString(1, orderId);
            ps.executeUpdate();
            stockDao.restoreByOrder(orderId);                 // 🔴 ㉒ 這一行在【另一個連線】上
        } catch (SQLException e) {
            e.printStackTrace();                              // 🔴 ㉓ 吞掉例外
        }
        // 🔴 ㉔ 沒有 finally，連線永遠不還
    }
}
```

### 0.3.1 它做了幾件事？

把上面那 160 行按「這是哪一層的工作」分類：

| 工作 | 出現的地方 | 應該在哪一層 |
|---|---|---|
| 參數驗證（items 不可為空） | ⑤ | **Web 層**（04-controller 02 章） |
| 折扣規則、VIP 等級 | ⑫ | **Domain 層**（05-service 00 章 0.5） |
| 庫存檢查 | ⑨ | **不變量**，該用原子 UPDATE（本章 0.8） |
| 編排（建單 → 扣庫存 → 寄信） | 整個方法 | **Application Service**（05-service 00 章 0.9.4） |
| 交易邊界 | ③ | **Application Service**（本章 0.9） |
| 副作用（寄信） | ⑯ | **`AFTER_COMMIT`**（05-service 06 章） |
| ID 產生 | ⑬ | 埠（本章 0.6.2 ⑯） |
| **SQL、連線、映射** | ⑧⑭⑮⑰ | **✅ 這一層** |

> 🔴 **八項工作裡，只有一項真的屬於這一層。**

⚠️ **而它與 05 站那個 2,000 行的 `OrderServiceImpl` 有一個關鍵差別：**

> **`OrderServiceImpl` 的問題是「做太多」。**
> **`OrderDao` 的問題是「做太多，而且它做的每一件事都會被【併發】與【故障】放大」** ——
> 因為它是唯一真的碰到共享狀態的一層。

### 0.3.2 六個具體事故（每一個都在本章有實測）

#### 事故 1：一個客戶看到了全站的訂單

**觸發**：⑰ 那段動態 SQL。客服後台的搜尋框輸入 `C-1' OR '1'='1`。

**本章實測（E8-A，H2 2.2.224）**：

```
=== E8-A 拼字串 vs 具名參數 ===
  拼字串，輸入 "C-1' OR '1'='1" → 查回 [O-1, O-2, O-3]（共 3 筆，這個客戶只有 1 筆）
  PreparedStatement 同樣輸入 → 查回 []（0 筆）
```

⚠️ **注意第二行的結果是「0 筆」而不是「錯誤」**。
`PreparedStatement` 不會「擋下攻擊」——它只是**把那串字當成一個普通的字串值去比對**，
而剛好沒有客戶的 id 長那樣。

> 📌 **這是理解參數化查詢最重要的一句話**：
> **它不是在過濾危險字元，它是在「讓資料永遠不會被當成程式碼」。**
> 因此它對「還沒被人想到的攻擊字串」也有效 —— 而黑名單過濾沒有這個性質。

#### 事故 2：半夜 02:14，整站停止回應，資料庫 CPU 只有 4%

**觸發**：㉑ 與 ㉔ —— `cancelByStaff` 自己借連線、而且不還。
客服一天用個幾次，池子 10 條連線大約兩週漏光。

**症狀的形狀很特別**：

- 應用程式**沒有錯誤日誌**（例外被 ㉓ 吞了）。
- 資料庫**很閒**（沒有慢查詢，CPU 4%）。
- 所有 HTTP 請求**都在等**，Thread dump 顯示卡在 `HikariPool.getConnection`。

**本章實測（E1-B）**：池 2 條、`connection-timeout: 1000`、4 個併發：

```
=== E1-B 池滿的例外 ===
  org.springframework.jdbc.CannotGetJdbcConnectionException
  Failed to obtain JDBC Connection
  cause: java.sql.SQLTransientConnectionException / pool-e1b - Connection is not available, request timed out after 1006ms.
  失敗數=2 / 4
```

> 📌 **背下這一行訊息**：`Connection is not available, request timed out after …ms`。
> **它是 Java 後端最常見的「整站掛掉」訊息**，而它有兩個完全不同的成因
> （漏連線 vs 交易太長），診斷方式在 01 章 1.9。

#### 事故 3：付款成功，但訂單查不到

**觸發**：㉒。`cancelByStaff` 在自己借的連線上改了訂單，
而 `stockDao.restoreByOrder()` 用的是 `JdbcTemplate` —— **另一條連線、另一個交易**。
前者成功、後者失敗時，資料就對不起來了。

**本章實測（E2-B）**：把「建訂單」與「扣庫存」放在兩個交易 vs 一個交易：

```
=== E2-B 交易邊界的位置 ===
  第二步失敗：DataIntegrityViolationException
  ① Repository 各自開交易 → 訂單筆數=1（期望 0，實際留下孤兒訂單）
  第二步失敗：DataIntegrityViolationException
  ② Service 開一個交易   → 訂單筆數=0（期望 0）
```

⚠️ **這正是 04-controller 站 7.18 留下的第五個問題**
（「合併訂單的過程中資料庫斷線，會留下半張訂單嗎？」）
**的資料層版本**。答案是：**會 —— 如果交易邊界放錯層。**

#### 事故 4：匯出報表讓整個服務 OOM

**觸發**：⑲ `exportAll()`。

**本章實測（E6-B，`-Xmx96m`、30 萬筆、每筆約 260 字元）**：

```
=== E6-B 最大堆 96 MB，表 300000 筆（每筆約 260 字元）===
  ① query() 回 List：🔴 java.lang.OutOfMemoryError / Java heap space
  ② RowCallbackHandler 逐列：✅ 跑完，sum=45000150000
```

⚠️⚠️ **這個實驗第一次跑的時候【沒有】OOM。**

原因是：測試資料的 `note` 欄位**每一列都是同一個字串**（`REPEAT('x', 250)`），
JVM 與 H2 之間有字串共用，30 萬列只佔了 11 MB。
把資料改成**每列不同**之後才 OOM。

> 📌 **這件事本身就是一課，而且它會在 06 章再出現一次**：
> **用「每一列都一樣」的測試資料量記憶體，量到的數字沒有意義。**

#### 事故 5：促銷第一分鐘，資料庫 CPU 100%，而每一句 SQL 都很快

**觸發**：⑦ 迴圈裡查商品。

**本章實測（E5，一張訂單 200 個明細）**：

```
=== E5 N+1（一張訂單 200 個明細）===
  ① 迴圈裡查：201 次查詢，  3.4 ms，取得 200 個商品
  ② 批次查  ：  2 次查詢，  2.6 ms，取得 200 個商品
```

⚠️ **在 H2 in-memory 上，兩者幾乎一樣快（3.4 ms vs 2.6 ms）。**
**這正是 N+1 難以在測試環境被發現的原因。**

把「每次查詢要跨一次網路」加回去（模擬 0.4 ms 的來回）：

```
=== E5-B N+1 ×【0.4 ms 網路來回】===
  ① 200 次查詢： 128.0 ms
  ② 1 次批次  ：   2.5 ms   → 差 51 倍
```

> 📌 **N+1 不是效能問題，是分層問題。**
> 它的成因永遠是：**上層用「一次拿一個」的方式向下層要資料**，
> 而下層每一次都要付一次網路來回。
> 本章 0.6 的判準 2 與判準 6 就是在防這件事 ——
> **在介面上防，而不是在 code review 上防。**

#### 事故 6：同一筆付款回呼進來兩次，建了兩張訂單

**觸發**：⑬ 與「先查再寫」。金流商的回呼會重送，
而 `createOrder` 用「先查有沒有這個冪等鍵、沒有才建」來擋。

**本章實測（E8-C，20 個併發帶同一個冪等鍵）**：

```
=== E8-C 20 個併發的同一個冪等鍵 ===
  只有應用層 if：建立 2 重用18 其他失敗 0 → 資料庫裡有 2 筆訂單 🔴 重複下單
  有唯一索引  ：建立 1 重用19 其他失敗 0 → 資料庫裡有 1 筆訂單 ✅
```

⚠️ **注意「建立 2」這個數字**：20 個併發只漏了 2 個。
**這就是它難以在測試中被發現的原因** —— 它需要「剛好同時」，
而在低流量下可能三個月才發生一次。

### 0.3.3 把成本算成錢

| 事故 | 發現方式 | 修復時間 | 直接成本 |
|---|---|---|---|
| ① SQL Injection | 資安通報 | 2 天（改 47 處） | 個資外洩通報、主管機關 |
| ② 連線洩漏 | 半夜整站停 | 4 小時（找不到原因，先重啟） | 停機 4 小時 |
| ③ 跨連線不一致 | 客服回報對不上 | 3 天 | 人工對帳 200 筆 |
| ④ 匯出 OOM | 服務重啟 | 1 天 | 停機 20 分鐘 × 3 次 |
| ⑤ N+1 | 促銷時 DB 打滿 | 半天 | 促銷首 5 分鐘全站慢 |
| ⑥ 重複下單 | 對帳差異 | 1 天 + 退款 | 重複出貨 18 筆 |

> 📌 **六個事故有一個共同點**：
> **沒有一個是在寫程式的當下發現的，也沒有一個是在 code review 抓到的。**
> 它們全部是**上線之後、在真的流量下**才出現。
>
> ⚠️ 而這一站的核心主張就是這一句：
> **資料層的錯誤有一種特殊的性質 —— 它們在單機、低流量、小資料量下【都是對的】。**
> 因此它們必須靠**設計**（介面的形狀、約束、邊界）擋掉，
> 而不能靠**測試**發現。

### 0.3.4 六個事故的共同形狀

把六個事故的根因寫在一起，會看到同一句話：

> 🔴 **它們都來自「把資料庫當成一個【會回答問題的 Map】」。**

| 你以為 | 實際上 |
|---|---|
| `dao.find(id)` 是一次記憶體存取 | 是一次**跨行程的往返**（0.2.1 的表） |
| 查出來的東西是「現在的值」 | 是**你讀到的那一刻的值**，下一奈秒可能就不是了（事故 6） |
| `if (stock >= 1) update(...)` 是一個動作 | 是**兩個動作**，中間有縫（事故 6、0.8.1） |
| 存進去就存進去了 | 要等到**commit**（事故 3） |
| 拿多少資料都一樣 | 全部進**你的堆積**（事故 4） |
| 一個一個拿 vs 一次拿 | 差**一個數量級**（事故 5） |

⚠️ **這一站的所有內容都可以看成「拆掉左邊那一欄」。**

---

## 0.4 資料存取層到底在做什麼

### 0.4.1 四個職責

05-service 站 0.4.1 說 Service 層有三個職責（編排、交易邊界、守護不變量）。
資料存取層有**四個**：

```
┌──────────────────────────────────────────────────────────────┐
│ 職責 ①  翻譯：資料列 ↔ 領域物件                                │
│         「三個 ResultSet」→「一個 Order 聚合」                  │
│         「Money(380, TWD)」→「total_minor=38000, currency='TWD'」│
├──────────────────────────────────────────────────────────────┤
│ 職責 ②  隔離：把「用哪一種持久化技術」關在這一層               │
│         換 JDBC → JPA → MyBatis，上面一行都不用改               │
│         （★ 這句話有前提，見 0.5 —— 它比你想的更難成立）        │
├──────────────────────────────────────────────────────────────┤
│ 職責 ③  提供原子性的工具：讓 Service 守得住不變量               │
│         原子 UPDATE、唯一索引、樂觀鎖、悲觀鎖、批次              │
│         ★ 這是最常被漏掉的一個職責（0.8）                       │
├──────────────────────────────────────────────────────────────┤
│ 職責 ④  控制效能邊界：一次來回拿多少、拿多少進記憶體             │
│         批次 vs 迴圈、投影 vs 整列、串流 vs List                │
└──────────────────────────────────────────────────────────────┘
```

**四個職責的一句話版本**：

> **翻譯**（讓上面看得懂）、**隔離**（讓上面不用知道）、
> **給工具**（讓上面守得住規則）、**守邊界**（讓上面不會炸掉）。

⚠️ **職責 ③ 值得特別說明，因為它與直覺相反**：

很多人以為資料層是「被動的」——Service 決定要做什麼，Repository 照做。
**不是。** 因為**併發控制的能力只存在於資料庫**，
所以「Service 有沒有辦法守住某一條不變量」，
**取決於 Repository 有沒有提供正確形狀的方法**。

```java
// 🔴 Repository 只提供這兩個方法 → Service 【無法】守住 stock >= 0
public interface StockPort {
    Optional<Stock> findByProductId(String productId);
    void save(Stock stock);
}
// Service 只能這樣寫，而它在併發下必定失效（0.8.1 實測）
Stock stock = stockPort.findByProductId(pid).orElseThrow();
if (stock.available() >= qty) { stock.deduct(qty); stockPort.save(stock); }

// ✅ Repository 提供這個方法 → Service 守得住
public interface StockPort {
    boolean tryReserve(String productId, int quantity);   // 原子的檢查 + 扣減
}
```

> 📌 **這就是 05 站 0.12 ⑩ 為什麼在 `StockPort` 上寫「刻意沒有 `findByProductId`」**。
> 現在你看得到那個決定的完整理由了：
> **不是「那個方法沒用」，而是「它的存在會讓錯誤的寫法變得方便」。**

### 0.4.2 它不是「SQL 的存放處」

一個常見的誤解是：

> 🔴 「Repository 就是把 SQL 集中放的地方，這樣要改的時候好找。」

**如果只是這樣，那它沒有存在的價值** —— 用 `grep` 也可以「集中找」。

**真正的價值在「它定義了上層能問什麼問題」**：

```java
// 🔴 這個介面把「能問什麼」開放給呼叫端 → 它沒有隔離任何東西
public interface OrderDao {
    List<Map<String, Object>> query(String sql, Object... args);
}

// ⚠️ 這個好一點，但仍然洩漏：呼叫端要自己組條件，授權規則散在各處
public interface OrderDao {
    List<Order> findByCustomerIdAndStatus(String customerId, String status);
}

// ✅ 這個定義了「這個系統會問訂單什麼問題」
public interface OrderRepository {
    Optional<Order> findByIdVisibleTo(String orderId, Actor actor);
    List<Order> findExpiredPendingPayment(Instant now, int limit);
}
```

**三者的差別，用一個問題就分得出來**：

> **「如果我要把儲存體換成一個 HTTP 服務，哪一個介面不用改？」**

| 介面 | 換成 HTTP 服務 | 換成 MyBatis | 加一條授權規則 |
|---|---|---|---|
| `query(String sql, …)` | 🔴 全部要改 | 🔴 全部要改 | 🔴 每個呼叫端都要改 |
| `findByCustomerIdAndStatus` | ⚠️ 介面不用改，但語意變了 | ✅ 不用改 | 🔴 每個呼叫端都要改 |
| `findByIdVisibleTo(id, actor)` | ✅ 不用改 | ✅ 不用改 | ✅ **改一個地方** |

### 0.4.3 Repository 與 DAO：差別、以及 shop-service 為什麼兩個都有

這兩個詞在實務上被混用到幾乎沒有差別。但**在這門課裡它們是兩個東西**，
因為它們解決的問題不同：

| | **DAO**（Data Access Object） | **Repository** |
|---|---|---|
| 出處 | J2EE 核心模式（2001） | DDD（Evans, 2003） |
| 心智模型 | **一張表的存取器** | **一個聚合的集合** |
| 單位 | 資料表 / 資料列 | **聚合根** |
| 典型方法 | `insert` / `update` / `deleteById` / `selectByExample` | `save` / `findById` / `remove` |
| 回傳 | 資料列的形狀（DTO、Map、Row） | **領域物件** |
| 部分更新 | ✅ 天經地義（`updateStatus`） | 🔴 **不合模型**（聚合是整體存取的） |
| JOIN 多表 | ✅ 常見 | ⚠️ 只在「重建一個聚合」時 |
| 誰用它 | 任何人 | **只有 Application Service** |

⚠️ **關鍵差別不是命名，是「部分更新」這一列。**

```java
// DAO 的世界：更新一個欄位是自然的
orderDao.updateStatus(orderId, "CANCELLED");

// Repository 的世界：沒有這種方法
Order order = orders.findById(orderId).orElseThrow();
order.cancel();                    // ★ 狀態機、不變量在這裡被檢查
orders.save(order);
```

> 🔴 **`orderDao.updateStatus(id, "CANCELLED")` 的問題不是「不夠 OO」。**
> **它的問題是：這行程式碼繞過了 `Order.cancel()` 裡的每一條規則。**
> 05 站 0.9.3 那個狀態機、那些守衛，全部沒有被執行。
>
> ⚠️ **而更糟的是它會擴散**：一旦這個方法存在，
> 第二個人會加 `updateAmount`、第三個人加 `updateAddress` ——
> 三個月後，`Order` 的狀態機還在，但**沒有人走那條路**。

**shop-service 的做法：兩個都有，各自負責一半**

```
寫路徑（命令）           讀路徑（查詢）
─────────────────       ─────────────────────────
OrderRepository         OrderQueryDao
  ↓                       ↓
回傳 Order（聚合）        回傳 OrderSummary / OrderDetailView（投影）
不變量由聚合守            沒有不變量要守（只是讀）
一次一張訂單              一次一頁 20 筆
save() 是整體             沒有 save()
```

**理由在 0.7 完整展開**，這裡先給結論：

> 📌 **「所有存取都走 Repository」是一個做不下去的原則。**
> 一個訂單列表要顯示「客戶名稱、商品縮圖、物流狀態」——
> 這三個欄位分別來自三個聚合。
> 用 Repository 做就是 **1 + 20 + 20 + 20 次查詢**（事故 5 的形狀）；
> 用一句 JOIN 做是 **1 次**。
>
> ⚠️ **而「一句 JOIN」不會破壞任何不變量 —— 因為它只是讀。**

### 0.4.4 「集合的錯覺」：Repository 假裝自己是一個 Collection，而它不是

Repository 模式最初的比喻是：

> 「把它當成一個**在記憶體裡的物件集合**，你不需要知道它背後是資料庫。」

**這個比喻在四個地方是錯的，而每一個都會咬你**：

| 集合的性質 | Repository 的真相 | 後果 |
|---|---|---|
| `set.add(x)` 之後 `set.contains(x)` 是 true | **要等 commit**，而且別的交易看不到 | 05 站 06 章「`AFTER_COMMIT` 讀不到」的事故 |
| 取出來的是**同一個物件** | 每次查都是**新物件**（本章 E4 實測） | 改了不 save 就沒發生（0.10.3） |
| 遍歷集合是 O(n) 的記憶體操作 | 遍歷是**把 n 筆搬進你的堆積** | 事故 4 的 OOM |
| 集合不會拒絕你 | 資料庫會：**約束、鎖、逾時、斷線** | 例外處理變成必要的（0.11.5） |

**第二列的實測（E4）**——同一組契約跑在三個實作上：

```
=== E4 契約測試：fake 與真實作的行為差異 ===
  ① 天真 fake（Map 存物件本身）  ①存了查得到 ✅  ②不存在回empty ✅  ③改了不影響已存 🔴（變成 CANCELLED）   [兩次查同一實例=true]
  ② 深拷貝 fake                 ①存了查得到 ✅  ②不存在回empty ✅  ③改了不影響已存 ✅   [兩次查同一實例=false]
  ③ JDBC 實作                   ①存了查得到 ✅  ②不存在回empty ✅  ③改了不影響已存 ✅   [兩次查同一實例=false]
```

⚠️⚠️ **第一列的 🔴 是這一站最重要的實測之一**，因為它的方向是**危險的那一邊**：

> **在 fake 上，「改了物件但忘了 `save()`」的程式碼【會通過測試】。**
> **在真的資料庫上，它【什麼都不會發生】。**
>
> 也就是說：**你的單元測試會告訴你「這段程式碼是對的」，而它在生產環境是壞的。**

> 📌 這正是 05 站 07 章 7.8.4 說「契約測試抓到的第一個 bug 通常是共用參照」的意思 ——
> 而現在你看到那個 bug 真的被抓到了。
> **0.10.2 會把這組契約測試補完。**

⚠️ **注意 JPA 會把這件事再翻轉一次**：
在同一個持久化情境裡，JPA 的 `find()` **真的會回傳同一個實例**，
而且**改了不 `save()` 也會被寫回**（dirty checking）。
**於是三種實作有三種不同的行為** —— 08 站 03 章會處理，
而本章 0.10.2 的契約測試就是為了讓那一次切換不會靜默出錯。

---

## 0.5 抽象洩漏清單 ★

0.4.1 的職責 ② 說「換實作，上面不用改」。

**這句話是這一站最需要被誠實檢視的一句話。**

### 0.5.1 十一件一定會漏出來的事

| # | 洩漏的東西 | 它怎麼漏出來 | 本站哪一章 |
|---|---|---|---|
| ① | **交易** | `@Transactional` 在 Service 上，但它的語意由下面的 `PlatformTransactionManager` 決定 | 05 |
| ② | **鎖** | 「悲觀鎖」這個概念沒辦法用「集合」表達；介面上一定要有 `findByIdForUpdate` 這種方法 | 05 |
| ③ | **批次** | `saveAll(list)` 在 JDBC 是一次來回，在天真的實作是 N 次 —— 呼叫端**必須知道差別** | 02、05 |
| ④ | **分頁語意** | `Page` 要 count 全表，`Slice` 不用；「第 5,000 頁」在 SQL 與在 Map 上是兩種成本 | 04 |
| ⑤ | **排序穩定性** | `ORDER BY created_at` 在有並列值時，**兩次查詢可能給不同順序** | 04 |
| ⑥ | **NULL 的排序位置** | MySQL 把 NULL 排最前，PostgreSQL 排最後（`NULLS LAST` 才一致） | 04 |
| ⑦ | **大小寫與定序** | MySQL 預設 `utf8mb4_0900_ai_ci` **不分大小寫**，H2 分 —— 同一個 `WHERE email = ?` 兩種結果 | 06 |
| ⑧ | **時區** | `TIMESTAMP` 在 MySQL 會做時區轉換，`DATETIME` 不會；JDBC 驅動還有自己的 `serverTimezone` | 01、07 站 |
| ⑨ | **數值精度** | `BigDecimal(19,4)` vs `DECIMAL(10,2)`：**捨入發生在資料庫，而你的測試在 Java 端捨入** | 02 |
| ⑩ | **生成鍵** | `AUTO_INCREMENT` 要等 INSERT 之後才知道 id；UUID 在應用端就知道 —— **這會改變聚合的建構方式** | 02、0.6.2 ⑯ |
| ⑪ | **樂觀鎖的 `version`** | 它是**純粹的持久化概念**，卻不得不出現在領域物件上（0.14.1） | 05 |

⚠️ **第 ⑤ 條最容易被當成「靈異事件」**，所以本章的 `OrderRepository` 直接把它寫進契約：

```java
/**
 * 給排程用：逾期未付款的訂單。
 *
 * <p>⚠️ 排序是<b>契約的一部分</b>（{@code created_at, id} 遞增）——
 * 沒有第二個排序鍵時，「每次跑都拿到同一批」不成立。
 */
List<Order> findExpiredPendingPayment(Instant now, int limit);
```

**本章 E9 實測（同一個查詢跑兩次）**：

```
  ⑤ 排程查兩次：[O-10, O-11, O-12] / [O-10, O-11, O-12] → 一致=true
```

⚠️ 這個「一致=true」**只證明加了第二個排序鍵之後是穩定的**，
**不證明**沒有第二個排序鍵時會不穩定 —— 那要看資料庫的執行計畫，
而在 H2 in-memory 上通常剛好也是穩定的。**這是 04 章要在 MySQL 上驗的事。**

### 0.5.2 洩漏不是設計失敗，**隱藏**洩漏才是

一個常見的反應是：「那我把這十一件事也封裝掉。」

**做不到，而且不該做。** 理由：

```java
// 🔴 嘗試把「鎖」也藏起來
public interface OrderRepository {
    Optional<Order> findById(String id);      // 內部「自動」決定要不要加鎖
}
```

**這個介面的問題**：呼叫端**沒有辦法表達意圖**。
「我只是要顯示」與「我要讀出來改了再寫回去」是兩種完全不同的需求，
而它們需要不同的鎖策略。把差別藏起來的結果是：
**要嘛全部加鎖（吞吐崩掉），要嘛全部不加（寫偏斜）。**

```java
// ✅ 承認洩漏：讓意圖出現在方法名上
public interface OrderRepository {
    Optional<Order> findById(String id);                 // 讀
    Optional<Order> findByIdForUpdate(String id);        // 讀了要改（05 章）
}
```

> 📌 **一條實務原則**：
> **抽象的價值不是「隱藏所有細節」，而是「讓呼叫端只需要知道【它需要決定的】細節」。**
>
> ⚠️ 判斷方式：問「這個細節會不會影響呼叫端的正確性？」
> - 會 → **必須**出現在介面上（鎖、批次、分頁語意、排序）
> - 不會 → 可以藏（連線池大小、SQL 長什麼樣、用哪個驅動）

### 0.5.3 三種處理洩漏的方式

| 方式 | 做法 | 什麼時候用 | 代價 |
|---|---|---|---|
| **A 承認它** | 讓它出現在方法名或參數上（`findByIdForUpdate`） | 影響正確性的洩漏（①②③④⑤） | 介面變大 |
| **B 釘住它** | 寫一個「特性測試」把行為釘住，換實作時它會紅 | 環境相關的洩漏（⑥⑦⑧⑨） | 要維護測試 |
| **C 放棄抽象** | 這一段直接寫原生 SQL，不假裝可以換 | 報表、批次、大量匯出 | 換資料庫時要重寫 |

**方式 B 的例子**（06 章會完整寫）：

```java
/**
 * ★ 特性測試（characterization test）：它不是在測「我們的程式碼對不對」，
 * 而是在<b>記錄「這個環境的行為是什麼」</b>。
 *
 * <p>⚠️ 它的價值在<b>換版本、換資料庫、換驅動時會紅</b>。
 * 05-service 站 02 章練習 3 與 03 章練習 3 是同一個手法。
 */
@Test
void 這個資料庫的字串比對分不分大小寫() {
    jdbc.update("INSERT INTO customer(id, email) VALUES ('C-1', 'Alice@Example.com')");
    int found = jdbc.queryForObject(
            "SELECT COUNT(*) FROM customer WHERE email = 'alice@example.com'", Integer.class);

    // ⚠️ 這裡故意不寫 assertThat(found).isOne() ——
    //    我們不是在主張哪一種是對的，而是在【記錄現況】
    assertThat(found)
            .describedAs("""
                    這個環境的字串比對是%s大小寫的。
                    ⚠️ 如果這條測試紅了，代表定序（collation）變了，
                       請檢查所有用 email / 帳號做等值比對的查詢。
                    """, found == 1 ? "不分" : "分")
            .isEqualTo(EXPECTED_CASE_SENSITIVITY);
}
```

### 0.5.4 實測：你的抽象在測試環境是對的 ★

**這是本章最需要你記住的實驗之一。**

「深分頁很慢」是後端常識：`LIMIT 20 OFFSET 990000` 要先掃過 99 萬列才丟掉。
**那麼，在 H2 上量得出來嗎？**

```
=== E7 分頁：1,000,000 筆，每頁 20 ===
  OFFSET 0       →    0.1 ms
  OFFSET 1000    →    0.1 ms
  OFFSET 100000  →    0.1 ms
  OFFSET 500000  →    0.1 ms
  OFFSET 990000  →    0.1 ms
  keyset（第 49,500 頁的同一個位置）→    0.1 ms
```

🔴 **量不出來。** 100 萬筆的表，翻到第 49,500 頁與第 1 頁**一樣快**。

**那 H2 是不是真的跳過了那 99 萬列？** 問它自己：

```
  plan: SELECT "ID" FROM "PUBLIC"."ORDERS"
            /* PUBLIC.IDX_CREATED */
            /* scanCount: 990020 */
        ORDER BY "CREATED_AT", 1
        OFFSET 990000 ROWS FETCH NEXT 20 ROWS ONLY
        /* index sorted */
```

**`scanCount: 990020`** —— 它**真的掃了 99 萬列**，只是在 in-memory 的索引上，
掃 99 萬個項目快到量不出來。

**而換一個沒有索引的欄位排序，成本立刻顯形**：

```
  沒有索引的欄位排序 OFFSET 990000 → 77.8 ms
```

> 🔴🔴 **這個實驗要教的不是「深分頁的成本」，而是這句話**：
>
> **你在 H2 上做的效能測試，結論不能搬到 MySQL。**
> **而糟糕的是：它不會報錯，它會給你一個【好看的數字】。**
>
> ⚠️ 這也是 05 站 07 章 7.22 那個「🔴 所有併發實驗都在 H2 上」的完整版本。
> **06 章會用 Testcontainers 處理它，07-mysql 站會給真的數字。**

**三個「在 H2 上會給錯誤結論」的清單**（本站會逐一標記）：

| 主題 | H2 上的結論 | 為什麼不能信 | 哪一章處理 |
|---|---|---|---|
| 深分頁成本 | 「幾乎免費」 | in-memory 掃描 vs 磁碟 I/O | 04、07 站 |
| N+1 的代價 | 「差 1.3 倍」（E5） | 沒有網路來回 | 02、04 |
| 鎖與死鎖 | 「不會死鎖」 | H2 的鎖模型與 InnoDB 不同 | 05、07 站 |

---

## 0.6 介面該長什麼樣：七個判準 ★

05-service 站 0.7 給了「邏輯該放哪一層」的七個判準。
這一節給的是**另一組七個判準**：**一個資料存取方法的簽章對不對。**

⚠️ **為什麼值得花一整節講方法簽章？**

> 因為**介面決定了呼叫端能寫出什麼樣的程式碼**。
> 0.3.2 的六個事故裡，**有四個的根因是「介面提供了一個方便的錯誤做法」**：
> `findByProductId` 讓「先查再寫」變得自然，
> `findAll` 讓「全撈」變得自然，
> `findById` 讓「在迴圈裡查」變得自然。
>
> **你沒辦法用 code review 擋住一個「用起來很自然」的方法。**

---

### 判準 1：它是在用**領域的語言**問問題，還是在用 SQL 的語言？

```java
// 🔴 SQL 的語言：呼叫端要自己知道「可見性 = customer_id 相符 或 是客服」
Optional<Order> findByIdAndCustomerId(String orderId, String customerId);

// ✅ 領域的語言
Optional<Order> findByIdVisibleTo(String orderId, Actor actor);
```

**差別不是命名風格，是「規則放在哪裡」**：

| | `findByIdAndCustomerId` | `findByIdVisibleTo` |
|---|---|---|
| 可見性規則寫在 | **每一個呼叫端** | **一個地方** |
| 新增「客服看得到全部」時 | 🔴 找出所有呼叫端 | ✅ 改一個方法 |
| 新增「代理商看得到轄下客戶」時 | 🔴 每個呼叫端加一個 if | ✅ 改一個方法 |
| 漏改一個呼叫端的後果 | 🔴 **越權存取**（04-controller 07 章的授權矩陣測試就是在抓這個） | — |

> ⚠️ **這條判準有一個邊界**：`findByIdVisibleTo` 把**授權**放進了資料層，
> 而 0.11.8 會說「資料層不該認識權限規則」。**這兩句話矛盾嗎？**
> 不矛盾，但差別很細 —— **0.11.8 會完整處理它**，這裡先記住結論：
> **「哪些資料看得到」可以進查詢；「這個人能不能做這個動作」不行。**

---

### 判準 2：這個方法一次處理幾筆？它會不會被放進迴圈？

```java
// 🔴 這個方法的存在，就是在邀請別人寫出 N+1
Optional<Product> findById(String productId);

// ✅ 批次版本：呼叫端拿不到「一次一個」的選項
List<Product> findAllById(Collection<String> productIds);
```

⚠️ **「那我兩個都提供，讓呼叫端自己選」——這是最常見的錯誤決定。**

**理由**：`findById` 用起來比較短、比較直覺，
所以**在時間壓力下，人一定會選它**。
而 N+1 在開發環境（小資料、本機 DB）**看不出來**（E5 實測：3.4 ms vs 2.6 ms）。

**shop-service 的做法**：

```java
public interface ProductRepository {
    /** ★ 只有批次版 —— 理由見 06 站 00 章判準 2。 */
    List<Product> findAllById(Collection<String> productIds);
}
```

**呼叫端被迫先收集 id**：

```java
// ✅ 被介面逼出來的正確寫法
List<String> productIds = command.lines().stream().map(LineCommand::productId).toList();
Map<String, Product> products = products.findAllById(productIds).stream()
        .collect(toMap(Product::id, identity()));
for (LineCommand line : command.lines()) {
    Product product = products.get(line.productId());   // ★ 記憶體查表，不是資料庫
    …
}
```

> 📌 **這一段程式碼比 N+1 版本長 3 行，而它快 51 倍**（E5-B 實測）。
> **這 3 行就是這條判準的全部成本。**

---

### 判準 3：它回傳什麼？聚合、投影，還是資料列？

| 回傳 | 用在 | 為什麼 |
|---|---|---|
| **聚合**（`Order`） | 要**改**它 | 改之前必須先檢查不變量，而那是聚合的工作 |
| **投影**（`OrderSummary`） | 只是**顯示** | 不需要 lines、不需要狀態機，少撈 90% 的資料 |
| **原始資料列**（`Map`、`Row`） | ❌ 幾乎不該外流 | 它是這一層的內部細節（0.11.3） |

**一個實際的體積差別**：

```java
// 訂單列表要顯示的：id、狀態、金額、建立時間、第一項商品名稱
record OrderSummary(String id, OrderStatus status, Money total,
                    Instant createdAt, String firstProductName) {}

// vs 一個完整的 Order 聚合：頭 + N 筆明細 + 付款紀錄 + 收件資訊 + 優惠券
```

**20 筆列表的差別**：

| | 查詢次數 | 傳輸的資料列 |
|---|---|---|
| `List<Order>`（聚合） | 1（頭）+ 1（明細 IN）+ 1（付款 IN）+ … | 20 + 約 60 + 約 25 |
| `List<OrderSummary>`（投影） | **1**（一句 JOIN） | **20** |

> ⚠️ **而更重要的差別不是效能，是【意圖】**：
> 一個回傳 `List<Order>` 的列表方法，
> 會讓下一個人以為「我可以在這裡改它們然後 save」——
> 而那會產生 20 次 UPDATE。**投影讓那件事在型別上做不到。**

---

### 判準 4：誰決定「找不到」是不是錯誤？

```java
// ✅ 資料層：回 Optional（它不知道「找不到」的意義）
Optional<Order> findById(String orderId);

// 🔴 資料層自己拋業務例外
Order findById(String orderId);   // 找不到就 throw OrderNotFoundException
```

**為什麼資料層不該決定**：同一個「找不到」，在不同情境的意義不同。

| 呼叫情境 | 「找不到」的意義 | 該做什麼 |
|---|---|---|
| `GET /orders/{id}` | 訂單不存在 | 404 |
| 建單前檢查冪等鍵 | **正常**，代表可以建 | 繼續 |
| 排程重試付款 | 訂單被刪了 | 記 log，跳過 |
| 對帳 | **資料不一致** | 告警 |

> 📌 **05 站 01 章 1.8.3 已經給過這個分工，這裡是它在資料層的版本**：
>
> ```
> Repository / 埠      → 回 Optional（它不知道「找不到」是不是錯）
> Application Service → 拋例外（它知道語意）
> ```

⚠️ **一個例外**：`save()` 的樂觀鎖衝突**應該**由資料層拋例外，
因為「version 對不上」在**任何情境下都是錯的**，沒有第二種解讀。
本章 E9 實測：

```
  ③ 用過期的 version 存 → ✅ OptimisticLockingFailureException
```

---

### 判準 5：授權要不要進查詢條件？

**要，而且理由是效能與安全各一半。**

```java
// 🔴 查出來再判斷
Order order = orders.findById(id).orElseThrow(...);
if (!actor.isStaff() && !order.customerId().equals(actor.userId())) {
    throw new AccessDeniedException();
}

// ✅ 授權寫進 WHERE
Order order = orders.findByIdVisibleTo(id, actor).orElseThrow(...);
```

| | 查完再判斷 | 進查詢條件 |
|---|---|---|
| 忘記寫 if 的後果 | 🔴 **越權讀取** | ✅ 不可能忘（沒有另一個方法） |
| 「不存在」與「沒權限」的區分 | 🔴 容易寫成 403，**洩漏 id 存在** | ✅ 天然合併成「找不到」 |
| 列表查詢 | 🔴 撈 100 筆再濾掉 97 筆 | ✅ 資料庫直接濾 |
| 分頁 | 🔴 **總數是錯的**（濾掉之後才知道） | ✅ 正確 |

⚠️ **第三、四列在列表查詢上是致命的**：
「查 20 筆再濾掉 17 筆」會讓分頁完全壞掉 —— 使用者看到「共 5 頁」，
但第 2 頁只有 3 筆、第 3 頁是空的。

**本章 E9 實測**：

```
  ④ 別的客戶看不到=true，客服看得到=true
```

---

### 判準 6：這個方法會不會**邀請**別人寫出錯的程式碼？

**這是七個判準裡最抽象、也最有用的一個。** 判斷方式：

> **「一個趕時間的工程師，看到這個方法名，最可能寫出什麼？」**

| 方法 | 它邀請的寫法 | 後果 |
|---|---|---|
| `findAll()` | `for (Order o : orders.findAll())` | 事故 4（OOM） |
| `findByProductId()` | `if (stock.qty() >= n) { … save }` | 事故 6（超賣） |
| `findById()`（沒有批次版） | 迴圈裡呼叫 | 事故 5（N+1） |
| `update(sql, args)` | 拼字串 | 事故 1（Injection） |
| `getConnection()` | 忘記 close | 事故 2（連線洩漏） |
| **`save(order)`** | ✅ 讀出來、改、存回去 | 正確 |
| **`tryReserve(pid, n)`** | ✅ 檢查回傳值 | 正確 |

> 📌 **一個介面設計的心法**：
> **不要提供「用起來很方便但幾乎總是錯的」方法。**
> 如果某個罕見情境真的需要它，讓那個情境**寫起來麻煩一點**
> （例如 `findAllForBatchExport(Consumer<Order> handler)` ——
> 名字長、要傳 callback、擋住了「先收成 List」這條路）。

---

### 判準 7：換一個實作時，這個方法要不要改？

**這是判斷「它是不是一個真的埠」的最後一關。**

```java
// 🔴 它綁死了 Spring Data
Page<Order> findAll(Specification<Order> spec, Pageable pageable);

// 🔴 它綁死了 SQL
List<Order> findByNativeQuery(String sql);

// 🔴 它綁死了 JPA 的生命週期
Order merge(Order order);

// ✅ 三種實作都答得出來
List<Order> findExpiredPendingPayment(Instant now, int limit);
```

⚠️ **這條判準要小心「為了純潔而純潔」**：

> **`Pageable` 與 `Page` 值不值得換掉？**
> **通常不值得。** 它們是 `spring-data-commons` 的型別，
> 但那個套件**沒有帶進任何持久化技術** —— 用 JDBC、MyBatis、甚至 HTTP 都可以實作。
> **04 章 4.2 會完整處理這個取捨**（含一個「自己寫 `PageRequest` 的成本估算」）。
>
> 📌 **判準 7 真正要擋的是「把實作的【生命週期模型】洩漏出去」** ——
> `merge`、`flush`、`detach`、`EntityManager`、`Session` 這些。

---

### 0.6.1 決策流程圖

```
                       ┌──────────────────────────────┐
                       │ 我要加一個資料存取方法        │
                       └──────────────┬───────────────┘
                                      ↓
                    ┌─────────────────────────────────────┐
                    │ Q1: 呼叫端要【改】這份資料嗎？        │
                    └───────┬─────────────────┬───────────┘
                         是 │                 │ 否（只顯示 / 統計）
                            ↓                 ↓
              ┌──────────────────────┐  ┌──────────────────────────┐
              │ 走 Repository        │  │ 走 QueryDao（0.7）        │
              │ 回傳【聚合】          │  │ 回傳【投影】              │
              └──────────┬───────────┘  └────────────┬─────────────┘
                         ↓                            ↓
     ┌────────────────────────────────┐   ┌───────────────────────────┐
     │ Q2: 這次修改要守什麼不變量？     │   │ Q3: 一次會回幾筆？          │
     └───────┬────────────────────────┘   └──────┬────────────────────┘
             ↓                                    ↓
   ┌───────────────────────────┐      ┌──────────────────────────────┐
   │ 只看單一聚合的狀態         │      │ 有上限（分頁）→ 回 List/Page  │
   │   → 聚合自己守，save() 即可 │      │ 無上限（匯出）→ 回 callback   │
   ├───────────────────────────┤      │              或 Stream        │
   │ 跨聚合 / 有計數上限        │      └──────────────────────────────┘
   │   → ★ 需要【原子方法】     │
   │     tryReserve / tryConsume│
   ├───────────────────────────┤
   │ 「讀出來、算一下、再寫回」  │
   │   → ★ 需要 ForUpdate 或    │
   │     樂觀鎖（version）      │
   └───────────────────────────┘
             ↓
   ┌──────────────────────────────────────────────────────────┐
   │ Q4: 一次一筆還是一批？                                     │
   │   會被放進迴圈 → ★ 只提供批次版（判準 2）                   │
   ├──────────────────────────────────────────────────────────┤
   │ Q5: 這個查詢有沒有「誰能看到什麼」的規則？                  │
   │   有 → ★ 進 WHERE，不要查完再濾（判準 5）                   │
   └──────────────────────────────────────────────────────────┘
```

### 0.6.2 20 個方法簽章的評審

**每一個都標「進 / 不進 / 改成什麼」，以及理由對應哪一條判準。**

| # | 簽章 | 判決 | 理由 |
|---|---|---|---|
| ① | `Optional<Order> findById(String id)` | ✅ 進 | 寫路徑的入口 |
| ② | `List<Order> findAll()` | 🔴 不進 | 判準 6：邀請 OOM。要全表就用 ⑳ |
| ③ | `Order getOne(String id)` | 🔴 改 | 判準 4：`get` 開頭暗示「一定有」，改回 `findById` + `Optional` |
| ④ | `void updateStatus(String id, String status)` | 🔴 不進 | 0.4.3：繞過狀態機 |
| ⑤ | `void save(Order order)` | ✅ 進 | 聚合整體存取 |
| ⑥ | `void saveAll(Collection<Order> orders)` | ✅ 進 | 排程與匯入需要（但**實作要真的批次**，洩漏 ③） |
| ⑦ | `List<Order> findByCustomerId(String cid)` | 🔴 改 | 判準 6：沒有上限。改成 `findByCustomerId(cid, int limit)` 或走 QueryDao |
| ⑧ | `long countByCustomerId(String cid)` | ✅ 進 | 「一天最多 N 張」這條不變量要用（05 站 0.8.2） |
| ⑨ | `Optional<Order> findByIdVisibleTo(String id, Actor a)` | ✅ 進 | 判準 1、5 |
| ⑩ | `List<Order> findExpiredPendingPayment(Instant now, int limit)` | ✅ 進 | 判準 1；`limit` 是必要的（判準 6） |
| ⑪ | `Optional<Product> findById(String pid)` | 🔴 不進 | 判準 2：一定會進迴圈 |
| ⑫ | `List<Product> findAllById(Collection<String> ids)` | ✅ 進 | 判準 2 |
| ⑬ | `boolean tryReserve(String pid, int qty)` | ✅ 進 | Q2：跨聚合不變量需要原子方法（0.8.3） |
| ⑭ | `Optional<Stock> findByProductId(String pid)` | 🔴 不進 | 判準 6：邀請「先查再寫」（事故 6） |
| ⑮ | `Optional<StockSnapshot> snapshot(String pid)` | ✅ 進 | 只給**錯誤訊息**用，名字說明它不精確 |
| ⑯ | `String nextId()` | ✅ 進 | 洩漏 ⑩：id 由誰產生是設計決定，見下方說明 |
| ⑰ | `Page<OrderSummary> search(Criteria c, Pageable p)` | ✅ 進，但**在 QueryDao** | 判準 3、0.7 |
| ⑱ | `List<Map<String,Object>> query(String sql, Object... args)` | 🔴 不進 | 判準 6、7：什麼都沒有隔離 |
| ⑲ | `Optional<Order> findByIdForUpdate(String id)` | ✅ 進（05 章補） | 洩漏 ②：鎖必須是顯式的 |
| ⑳ | `void streamAllForExport(Consumer<Order> handler)` | ✅ 進（05 章補） | 判準 6：擋住「先收成 List」 |

**⑯ `nextId()` 值得單獨說明** —— 它是一個「不明顯但影響很大」的決定：

```java
public interface OrderRepository {
    /** ★ id 由應用端產生，而不是資料庫的 AUTO_INCREMENT。 */
    String nextId();
}
```

| | 資料庫產生（`AUTO_INCREMENT`） | 應用端產生（UUID / ULID） |
|---|---|---|
| 什麼時候知道 id | **INSERT 之後** | **建立物件時** |
| 聚合怎麼建 | 🔴 要嘛先存再補 id，要嘛 id 可為 null | ✅ `Order.place(id, …)` 一次到位 |
| 05 站的 `Order` 能不能用 | 🔴 **不能**（它的 id 是 `final`，建構時就要有） | ✅ 可以 |
| 批次寫入 | ⚠️ 要拿 generated keys，比較麻煩 | ✅ 單純 |
| 對外洩漏資訊 | 🔴 `/orders/1234` 讓人猜得到總量 | ✅ 不會 |
| 索引效率 | ✅ 遞增，B+ 樹友善 | ⚠️ 隨機 UUID 會讓寫入分散（**ULID / UUIDv7 可解**） |

> 📌 **shop-service 選應用端產生**，主要理由是第三列：
> **05 站的 `Order` 聚合是不可變 id 的設計，資料庫產生 id 會反過來逼領域模型改形狀。**
> ⚠️ 而最後一列的代價是真的 —— **07-mysql 站 03 章會實測 UUID 主鍵對 InnoDB 的影響**，
> 並給出 ULID / UUIDv7 的做法。

---

## 0.7 命令與查詢：一個介面撐不住兩種需求 ★

### 0.7.1 兩種需求的形狀完全不同

| | **命令**（改資料） | **查詢**（顯示） |
|---|---|---|
| 單位 | 一個聚合 | 一頁、一份報表 |
| 一次幾筆 | 1 | 20 / 1,000 / 全部 |
| 要不要完整 | ✅ **必須完整**（不變量要檢查） | ❌ 只要畫面上那幾欄 |
| 跨聚合 | ❌ 不可以 | ✅ **本來就要**（JOIN 三張表） |
| 需要交易嗎 | ✅ 要 | ⚠️ 唯讀交易，或不要 |
| 需要鎖嗎 | 有時候 | ❌ 幾乎不要 |
| 回傳型別 | `Order` | `OrderSummary` |
| 誰呼叫 | `OrderApplicationService` | `OrderQueryService` |

⚠️ **硬要用一個介面做兩件事，會得到這樣的東西**：

```java
// 🔴 一個介面撐兩種需求的下場
public interface OrderRepository {
    Optional<Order> findById(String id);
    Page<Order> search(Criteria c, Pageable p);          // ← 為了列表，回聚合
    List<Order> findAllWithCustomerName(…);              // ← 列表要客戶名，但那不在 Order 裡
    List<Object[]> findIdAndStatusAndCustomerName(…);    // ← 於是開始回 Object[]
}
```

**第二行的代價**：列表要 20 個完整聚合 → 每個要 lines、payments → **變成 0.6.2 ③ 的體積問題**。
**第三行的代價**：`customerName` 塞不進 `Order`（它屬於另一個聚合）→ 於是有人在 `Order` 上加了一個 `transient` 欄位。
**第四行**：放棄了型別。

### 0.7.2 shop-service 的切法

```
example.shop.order
├── domain/                       ← 聚合、值物件、狀態機（05 站）
│   ├── Order.java
│   └── OrderStatus.java
├── application/
│   ├── OrderApplicationService.java     ← 命令：建單、取消、出貨
│   ├── OrderQueryService.java           ← 查詢：詳情、列表、匯出
│   └── port/
│       ├── OrderRepository.java         ★ 命令用：回 Order
│       └── OrderQueryDao.java           ★ 查詢用：回投影
└── infrastructure/persistence/
    ├── JdbcOrderRepository.java
    ├── JdbcOrderQueryDao.java
    └── OrderRowMapper.java
```

```java
package example.shop.order.application.port;

/**
 * 訂單的<b>讀路徑</b>。
 *
 * <p>★ 它與 {@link OrderRepository} 的三個差別：
 * <ol>
 *   <li>回傳<b>投影</b>而不是聚合 —— 因此拿到的東西<b>不能改</b>（沒有 save）。</li>
 *   <li>可以<b>跨聚合 JOIN</b> —— 因為只是讀，不會破壞任何不變量。</li>
 *   <li>它<b>允許</b>被 SQL 綁得比較緊（0.5.3 的方式 C）。</li>
 * </ol>
 */
public interface OrderQueryDao {

    Optional<OrderDetailView> findDetail(String orderId, Actor actor);

    Page<OrderSummary> search(OrderSearchCriteria criteria, Pageable pageable);

    /** ★ 匯出：不回 List（判準 6）。 */
    void streamForExport(OrderSearchCriteria criteria, Consumer<OrderExportRow> handler);

    /** 報表：直接回聚合過的數字，不回明細。 */
    List<DailySalesRow> dailySales(LocalDate from, LocalDate to);
}
```

⚠️⚠️ **這個介面現在【通不過】0.12.5 的 ArchUnit 規則 6。**

規則 6 禁止 `..application.port..` 依賴 `org.springframework.data..`，
而 `Page` 與 `Pageable` 正是那個套件的型別。

**這是刻意留下的衝突，而處理方式有三個選項**（04 章 4.2 會定案）：

| 選項 | 做法 | 代價 |
|---|---|---|
| A. **自己定義** `Page` / `PageRequest` | 埠完全乾淨 | 多寫兩個型別 + 每個實作都要轉換 |
| B. **在規則裡開一個具名例外** | 只允許 `org.springframework.data.domain..` | 要寫下理由，且要防止它擴散 |
| C. 拿掉規則 6 | — | 🔴 **不行** —— 那等於放棄整條界線 |

> 📌 **在 04 章之前，本站的程式碼採用選項 B 的「暫時版」**：
> `OrderQueryDao` 先用 Spring Data 的分頁型別，
> **而規則 6 對它保持紅燈** —— 因為**一條「已知會紅」的規則，比一條被刪掉的規則誠實**。
> ⚠️ **但紅燈不能長期存在**（沒有人會理會一個永遠紅的 CI），所以 04 章一定要定案。

### 0.7.3 為什麼不叫它 CQRS

**CQRS 通常指的是「讀寫用不同的儲存體、靠事件同步」** ——
那是一個大得多的決定（最終一致、投影重建、事件版本）。

**這裡做的只有一件事：讀寫用不同的【介面】，但同一個資料庫。**

| | 本站的做法 | 完整 CQRS |
|---|---|---|
| 介面分開 | ✅ | ✅ |
| **資料庫分開** | ❌ 同一個 | ✅ 讀庫、寫庫 |
| 一致性 | ✅ **強一致**（同一個交易） | ⚠️ 最終一致 |
| 複雜度 | 低（多一個介面） | 高（同步機制、重建、監控） |

> 📌 **給它一個名字**：**「讀寫分離的介面」**，不是 CQRS。
> ⚠️ 這個區分不是名詞潔癖 —— 在設計評審上說「我們要做 CQRS」，
> 會讓別人以為你要引入事件同步與最終一致，那是完全不同量級的討論。
>
> **而真正的讀寫分離（讀庫 / 寫庫、`@Transactional(readOnly = true)` 路由到 replica）
> 在 05 章 5.7 實作** —— 05 站 02 章 2.5.2 已經預告過。

### 0.7.4 一條界線：查詢可以有多聰明？

**查詢端「允許」被 SQL 綁緊，那它可以聰明到什麼程度？**

| 做法 | 可以嗎 | 理由 |
|---|---|---|
| JOIN 三張表 | ✅ | 只是讀 |
| 用資料庫的 `SUM` / `GROUP BY` 算報表 | ✅ | 比撈回來在 Java 算快幾個數量級 |
| 用 `CASE WHEN` 算「顯示用的狀態標籤」 | ⚠️ **不行** | 那是 Domain 的規則（05 站 0.10.9），會有兩份真相 |
| 用 SQL 判斷「這張單能不能取消」 | 🔴 **不行** | 那是狀態機，複製到 SQL 就一定會不同步 |
| 用資料庫的 window function 做排名 | ✅ | 是查詢，不是規則 |

> ⚠️ **判準**：
> **「這個計算的結果，會不會被拿來做決定？」**
> - 會（能不能取消、要不要收運費）→ 🔴 **必須在 Domain**
> - 不會（顯示、統計、排序）→ ✅ 可以在 SQL

---

## 0.8 不變量的第四個位置：資料庫 ★★

05-service 站 0.8.3 給了那張「四個位置」的表：

| 位置 | 可靠度 | 併發下有效？ | 錯誤訊息品質 |
|---|---|---|---|
| ① **Web 層驗證** | ⭐ | ❌ | ⭐⭐⭐⭐⭐ |
| ② **Domain 物件** | ⭐⭐⭐ | ❌（單一聚合內有效） | ⭐⭐⭐⭐ |
| ③ **原子 SQL / 鎖** | ⭐⭐⭐⭐ | ✅ | ⭐⭐⭐ |
| ④ **資料庫約束** | ⭐⭐⭐⭐⭐ | ✅ | ⭐ |

**當時那張表是【推論】的。這一節要把它【量出來】。**

而量出來的結果，會讓你想修改其中一格。

### 0.8.1 實測：應用層的 `if`，在 20 個併發下

**實驗設計**（E3）：庫存 10 個，20 個執行緒同時搶 1 個，跑 5 輪。
每個執行緒的邏輯是最自然的那一種：

```java
Integer qty = jdbc.queryForObject("SELECT qty FROM stock WHERE pid='P-1'", Integer.class);
if (qty >= 1) {                                            // 🔴 檢查
    jdbc.update("UPDATE stock SET qty = ? WHERE pid='P-1'", qty - 1);   // 🔴 與寫入之間有縫
    success.incrementAndGet();
} else {
    rejected.incrementAndGet();
}
```

**結果（H2 2.2.224，預設 READ_COMMITTED，每一輪都是新的表）**：

```
  第 1 輪 ①應用層if   成功15 拒絕 5 錯誤 0 剩餘  0
  第 2 輪 ①應用層if   成功17 拒絕 3 錯誤 0 剩餘  0
  第 3 輪 ①應用層if   成功18 拒絕 2 錯誤 0 剩餘  0
  第 4 輪 ①應用層if   成功17 拒絕 3 錯誤 0 剩餘  0
  第 5 輪 ①應用層if   成功17 拒絕 3 錯誤 0 剩餘  0
```

> 🔴 **庫存 10 個，賣出去 15～18 個。5 輪，5 輪都錯。**

⚠️⚠️ **而現在請看「剩餘」那一欄：`0`。**

**資料庫裡的數字是 0 —— 它看起來完全正常。**

> 🔴🔴 **這是這個實驗最重要的發現，而它比「超賣」本身更可怕**：
>
> **lost update 不會留下痕跡。**
> 你不會看到 `qty = -8`。你會看到 `qty = 0` ——
> 一個**完全合法、看不出任何問題**的值。
>
> **於是這個 bug 的發現方式只有一種：倉庫說「沒貨了，但系統還有 8 張單」。**

**為什麼會這樣**：

```
時間 →
執行緒 A：  讀到 qty=10 ──────────────→ 寫入 qty=9
執行緒 B：       讀到 qty=10 ─────────────────→ 寫入 qty=9   ← A 的扣減被覆蓋掉了
執行緒 C：            讀到 qty=10 ──────────────────→ 寫入 qty=9
                                                        ↑
                        三個人都成功了，而 qty 只少了 1
```

**每一次寫入的都是「絕對值」（`qty - 1`），而不是「相對變化」（`qty = qty - 1`）。**

### 0.8.2 實測：那加上 `CHECK (qty >= 0)` 呢？★★

這是最自然的下一個念頭：「資料庫約束是最後防線，加上去就安全了。」

**同一個實驗，只多加一行 DDL**：

```sql
CREATE TABLE stock(pid VARCHAR(10) PRIMARY KEY, qty INT NOT NULL CHECK (qty >= 0));
```

**結果**：

```
  第 1 輪 ②應用層if+CHECK約束  成功14 拒絕 6 錯誤 0 剩餘  0
  第 2 輪 ②應用層if+CHECK約束  成功19 拒絕 1 錯誤 0 剩餘  0
  第 3 輪 ②應用層if+CHECK約束  成功17 拒絕 3 錯誤 0 剩餘  0
  第 4 輪 ②應用層if+CHECK約束  成功17 拒絕 3 錯誤 0 剩餘  0
  第 5 輪 ②應用層if+CHECK約束  成功18 拒絕 2 錯誤 0 剩餘  0
```

> 🔴🔴🔴 **「錯誤 0」——`CHECK` 約束在 5 輪裡【一次都沒有觸發】。**
> **而 14～19 個人，搶到了 10 個庫存。**

**為什麼約束沒有救你**：

> **`CHECK (qty >= 0)` 檢查的是「寫進去的那個值」。**
> 而 lost update 寫進去的每一個值都是 `9`、`9`、`9`…… ——
> **每一個都 `>= 0`，每一個都合法。**
>
> 🔴 **約束擋得住「壞的值」，擋不住「壞的過程」。**

⚠️ **這一格要改寫 05 站 0.8.3 的那張表**：

| 位置 | 原本寫的 | **應該寫成** |
|---|---|---|
| ④ 資料庫約束 | 可靠度 ⭐⭐⭐⭐⭐，併發下 ✅ | **可靠度 ⭐⭐⭐⭐⭐（對於「值」）；
對於「過程」（lost update、寫偏斜）**❌ 無效** |

> 📌 **修正後的一句話**：
> **資料庫約束是「狀態」的守門人，不是「轉移」的守門人。**
> 它保證「資料庫裡不會出現不合法的值」，
> **但它不保證「這個值是經由合法的過程產生的」。**

### 0.8.3 實測：原子 UPDATE

**同一個實驗，把「讀 → 判斷 → 寫」換成一句 SQL**：

```java
int rows = jdbc.update("UPDATE stock SET qty = qty - 1 WHERE pid = 'P-1' AND qty >= 1");
if (rows == 1) success.incrementAndGet();   // ★ 用「影響筆數」判斷成功與否
else           rejected.incrementAndGet();
```

**結果**：

```
  第 1 輪 ③原子UPDATE  成功10 拒絕10 錯誤 0 剩餘  0
  第 2 輪 ③原子UPDATE  成功10 拒絕10 錯誤 0 剩餘  0
  第 3 輪 ③原子UPDATE  成功10 拒絕10 錯誤 0 剩餘  0
  第 4 輪 ③原子UPDATE  成功10 拒絕10 錯誤 0 剩餘  0
  第 5 輪 ③原子UPDATE  成功10 拒絕10 錯誤 0 剩餘  0
```

> ✅ **5 輪，5 輪都是 10 / 10。**

**它為什麼對，兩個關鍵**：

| 關鍵 | 說明 |
|---|---|
| **`qty = qty - 1`（相對值）** | 資料庫在**它自己持有的鎖之下**讀取當前值再計算 —— 沒有縫 |
| **`AND qty >= 1`（條件在 WHERE 裡）** | 檢查與寫入是**同一個語句**，資料庫保證它是原子的 |

⚠️ **第三個關鍵，最容易被漏掉**：

```java
int rows = jdbc.update(...);
// 🔴 忘記檢查 rows → 「庫存不足」變成靜默成功
```

> 📌 **原子 UPDATE 的完整形狀是「一句 SQL + 一個 `rows == 1` 的判斷」。**
> 少了後半，它與沒寫是一樣的。
> **這也是 05 站 `StockPort.tryReserve` 回 `boolean` 而不是 `void` 的理由。**

### 0.8.4 實測：唯一索引 —— 這一次資料庫真的救了你

0.8.2 說「約束擋不住壞的過程」。**那什麼時候約束有用？**

**當「不合法」這件事可以用【一列資料存不存在】來表達的時候。**

**實驗（E8-C）**：I9「一個 `idempotencyKey` 最多對應一張訂單」。
20 個併發帶同一個冪等鍵：

```java
// ① 只有應用層檢查
Integer n = jdbc.queryForObject("SELECT COUNT(*) FROM orders WHERE idem_key = 'K-1'", Integer.class);
if (n == 0) { jdbc.update("INSERT INTO orders VALUES (?, 'K-1')", "O-" + idx); created++; }
else        { reused++; }

// ② 同樣的程式碼，但表上有 CREATE UNIQUE INDEX ux_idem ON orders(idem_key)
//    → INSERT 撞到唯一索引時拋 DuplicateKeyException，接住它當成「已經有人建了」
```

**結果**：

```
=== E8-C 20 個併發的同一個冪等鍵 ===
  只有應用層 if：建立 2 重用18 其他失敗 0 → 資料庫裡有 2 筆訂單 🔴 重複下單
  有唯一索引  ：建立 1 重用19 其他失敗 0 → 資料庫裡有 1 筆訂單 ✅
```

> ✅ **這一次，資料庫約束是有效的。**

**為什麼這次有效、上次無效**：

| | I1 庫存 `>= 0` | I9 冪等鍵唯一 |
|---|---|---|
| 不合法的形狀 | **一個值太小** | **兩列資料同時存在** |
| lost update 能繞過嗎 | ✅ 能（寫合法的絕對值） | ❌ **不能**（兩列就是兩列） |
| 約束檢查的時機 | 寫入時看那個值 | 寫入時看**整張表** |
| 結論 | 約束是**輔助**，正確性靠原子 UPDATE | **約束就是正確性本身** |

> 📌 **判準**：
> **能用「唯一 / 外鍵 / NOT NULL」表達的不變量，資料庫守得住。
> 需要「讀出來、算一下、再寫回去」的不變量，資料庫守不住 —— 那要靠 ③。**

### 0.8.5 四個位置的修正版

**把 0.8.1～0.8.4 的實測結果，寫回 05 站那張表**：

| 位置 | 可靠度 | lost update 擋得住？ | 併發下有效？ | 錯誤訊息 | 適用的不變量形狀 |
|---|---|---|---|---|---|
| ① Web 層驗證 | ⭐ | ❌ | ❌ | ⭐⭐⭐⭐⭐ | 「這個輸入本身不合法」 |
| ② Domain 物件 | ⭐⭐⭐ | ❌ | ❌（單一聚合內 ✅） | ⭐⭐⭐⭐ | 「這個聚合的內部狀態」 |
| ③ **原子 SQL** | ⭐⭐⭐⭐ | ✅ | ✅ | ⭐⭐⭐ | **「有競爭的計數 / 扣減」** |
| ④a 資料庫約束（**值**：CHECK、NOT NULL） | ⭐⭐⭐ | ❌ **（本章 0.8.2 實測）** | ⚠️ 部分 | ⭐ | 「這一列的值不合法」 |
| ④b 資料庫約束（**存在性**：UNIQUE、FK） | ⭐⭐⭐⭐⭐ | ✅ | ✅ | ⭐ | **「不該同時存在的兩列」** |

⚠️ **④ 被拆成 ④a 與 ④b，是這一章對 05 站的第一個修正。**
原本那一格「可靠度 ⭐⭐⭐⭐⭐」對 CHECK 來說**太樂觀了**。

**那 CHECK 還要不要寫？要，但理由變了**：

| CHECK 的真正價值 | 說明 |
|---|---|
| ✅ **抓 bug，不是抓併發** | 「哪一段程式碼寫了 -100 進去」——它會立刻炸，而不是三個月後對帳發現 |
| ✅ **擋住繞過應用程式的寫入** | 手動 SQL、資料修復腳本、匯入工具、DBA 的 `UPDATE` |
| ✅ **當成可執行的文件** | `CHECK (currency IN ('TWD','JPY','USD'))` 比註解可靠 |
| 🔴 **不是**併發安全的保證 | 0.8.2 實測 |

**本章 E9 實測（`schema.sql` 的兩條 CHECK）**：

```
  ⑥ 塞一筆 total_minor=-100 → ✅ 被 ck_orders_total 擋下
  ⑥ 塞一筆 quantity=0 的明細 → ✅ 被 ck_order_line_qty 擋下
```

### 0.8.6 約束的四個代價

**「那就全部加上去」——先看代價**：

| 代價 | 具體症狀 | 緩解 |
|---|---|---|
| **錯誤訊息很差** | `Unique index or primary key violation: "PUBLIC.UX_IDEM ON PUBLIC.ORDERS(IDEM_KEY)"` | 在資料層把它翻譯成業務例外（0.11.5） |
| **遷移變難** | 加一條 CHECK 到有髒資料的表上 → DDL 直接失敗 | 先清資料，或 `NOT ENFORCED` 過渡（07 站 08 章） |
| **批次匯入變慢 / 全有全無** | 匯入 10 萬筆，第 99,999 筆違反約束 → 整批 rollback | 分批、或先進暫存表 |
| **測試資料難建** | 外鍵讓「只建一張訂單」變成「要先建客戶、商品、地址」 | Object Mother（05 站 07 章 7.16）、**06 章 6.7.2** |

⚠️ **第一個代價是實務上最常見的抱怨**，而它有一個標準解法：

```java
/**
 * ★ 把資料庫的約束違反，翻譯成業務例外。
 *
 * <p>⚠️ 注意它<b>依賴約束的名稱</b> —— 所以 schema.sql 裡的每一條約束
 * 都必須<b>有名字</b>（{@code CONSTRAINT ux_orders_idem UNIQUE …}），
 * 不能讓資料庫自動命名。
 */
try {
    jdbc.update(INSERT_ORDER, params);
} catch (DuplicateKeyException e) {
    if (e.getMessage() != null && e.getMessage().contains("UX_ORDERS_IDEM")) {
        throw new DuplicateOrderException(idempotencyKey);   // 04 章的 41 個例外之一
    }
    throw e;
}
```

> ⚠️ **這段程式碼有一個明顯的醜點：`contains("UX_ORDERS_IDEM")` 在比對字串。**
> 而它是**目前為止最務實的做法** ——
> JDBC 沒有標準的「是哪一條約束」API，各家驅動的訊息格式也不同。
> **02 章 2.12 會給一個更完整的版本**，而 **2.12.7 就是那條「這個字串比對如果失效，測試會紅」的守門測試**。

### 0.8.7 11 條不變量 × 守在哪一層（完整版）

**這是 05 站 0.8.2 那張表的資料層版本 —— 多了最後兩欄。**

| # | 不變量 | ② Domain | ③ 原子 SQL | ④ 資料庫約束 | **本站哪一章實作** |
|---|---|---|---|---|---|
| I1 | 庫存 `>= 0` | 訊息 | ✅ **`tryReserve`** | CHECK（抓 bug） | 02 |
| I2 | 券使用次數 `<=` 總數 | 訊息 | ✅ **`tryConsume`** | CHECK | 02 |
| I3 | 訂單總額 `>= 0` 且 = 小計-折扣+運費 | ✅ **主場** | — | CHECK `total_minor >= 0` | 00（`schema.sql`） |
| I4 | 總額 = 明細之和 | ✅ **主場** | — | ❌ 表達不了 | — |
| I5 | 狀態機 | ✅ **主場** | ⚠️ 見下方 | ❌ 表達不了 | 05 |
| I6 | 已取消必有 cancellation | ✅ **主場** | — | ⚠️ 可用 NOT NULL + 分表 | 03 |
| I7 | 已付款必有 payment | ✅ | — | FK + 應用檢查 | 03 |
| I8 | 退款總額 `<=` 付款總額 | 訊息 | ✅ **原子 UPDATE** | ⚠️ 需要觸發器 | 02 |
| I9 | idempotencyKey 唯一 | ❌ | — | ✅ **UNIQUE**（0.8.4 實測） | 00（`schema.sql`） |
| I10 | 明細幣別一致 | ✅ **主場** | — | ⚠️ 需要觸發器 | — |
| I11 | 出貨數量 `<=` 訂購數量 | ✅ | ✅ 原子 UPDATE | CHECK（單列） | 05 |

⚠️ **I5（狀態機）那一列的「⚠️ 見下方」值得展開**，因為它是**最容易寫錯的一種**：

```java
// 🔴 讀出來、檢查、寫回去 —— 與 0.8.1 是同一個形狀的 bug
Order order = orders.findById(id).orElseThrow();
order.cancel();              // ② Domain 檢查狀態機 ✅
orders.save(order);          // 🔴 但兩個客服同時操作時，第二個人的檢查看到的是舊狀態
```

**兩種正確的做法**：

```java
// ✅ A：樂觀鎖（本章的 JdbcOrderRepository 已經是這一版）
UPDATE orders SET status = :status, version = version + 1
 WHERE id = :id AND version = :version          -- ★ 影響 0 列 → 有人改過了

// ✅ B：把狀態當成條件（適合「只有這一個轉移」的簡單情境）
UPDATE orders SET status = 'CANCELLED'
 WHERE id = :id AND status IN ('PENDING_PAYMENT', 'PAID', 'PARTIALLY_SHIPPED')
```

| | A 樂觀鎖 | B 狀態當條件 |
|---|---|---|
| 保護範圍 | **整張訂單的所有欄位** | 只有 status |
| 需要 Domain 參與嗎 | ✅ 走完整的 `Order.cancel()` | ❌ 繞過聚合 |
| 失敗訊息 | 「有人同時改了這張訂單」 | 「狀態不允許」（**但可能其實是併發**） |
| 適合 | shop-service 的主要路徑 | 高頻、單欄位的狀態翻轉 |

> 📌 **shop-service 選 A**，理由是第二列：**B 繞過了 `Order.cancel()` 裡的其他規則**
> （7 天內、客服要填原因、已付款要建退款單）。
> **05 章 5.5 會處理 A 的一個麻煩**：`save()` 之後，
> 記憶體裡那個 `Order` 的 `version` 已經過期了。

---

## 0.9 交易邊界：為什麼不在 Repository ★

### 0.9.1 實測：一個交易 = 一直佔著一條連線

**這是理解「交易邊界」的物理基礎**（E2-A）：

```
=== E2-A 交易 = 一直佔著一條連線 ===
  無交易，兩次查詢【之間】 active=0  綁在執行緒上嗎=false
  有交易，兩次查詢【之間】 active=1  綁在執行緒上嗎=true
  有交易，sleep 200ms 之後  active=1
  交易結束後             active=0
```

**三個觀察**：

| 觀察 | 意義 |
|---|---|
| 無交易時，兩次查詢之間 `active=0` | 連線是**借了就還**的 —— 一個沒有交易的方法，即使跑 10 秒也不佔連線 |
| 有交易時，兩次查詢之間 `active=1` | 連線被**綁在執行緒上**（`TransactionSynchronizationManager`），整段交易都握著 |
| **sleep 200 ms 之後仍然 `active=1`** | ⚠️ **交易裡的每一毫秒都在佔用連線 —— 包括你在等外部 API 的那 3 秒** |

> 📌 **05 站 02 章 2.9.3 的「交易長度 × 連線池 = TPS 上限」，這裡是它的直接證據。**
>
> **公式**：`最大 TPS ≈ 連線池大小 ÷ 平均交易長度（秒）`
> 池 10、交易 200 ms → 約 50 TPS。
> **交易裡多呼叫一個 300 ms 的外部 API → 掉到 20 TPS。**

**而池的大小不是「越大越好」**（E1-A，30 個各佔用 100 ms 的請求）：

```
  maximumPoolSize=1   總耗時=3116 ms  （理論下限 3000 ms）
  maximumPoolSize=2   總耗時=1552 ms  （理論下限 1500 ms）
  maximumPoolSize=5   總耗時= 658 ms  （理論下限 600 ms）
  maximumPoolSize=10  總耗時= 407 ms  （理論下限 300 ms）
  maximumPoolSize=20  總耗時= 314 ms  （理論下限 200 ms）
```

⚠️ **這組數字有一個重要的但書**：
底下是 **H2 in-memory**，它幾乎沒有 I/O 競爭，所以「池越大越快」在這裡成立。
**在真的資料庫上不成立** —— 超過某個點之後，
更多連線只會讓資料庫的 CPU 花在 context switch 上，**總吞吐反而下降**。
**01 章 1.6 會給那條曲線，以及池大小的計算公式。**

### 0.9.2 實測：交易邊界放在 Repository 的下場

**這是 0.3.2 事故 3 的實驗版（E2-B）**：

```java
// ① 每個 Repository 方法自己開交易（各自 commit）
tt.execute(st -> { jdbc.update("INSERT INTO orders VALUES ('O-1','PENDING')"); return null; });
tt.execute(st -> { jdbc.update("UPDATE stock SET qty = qty - 5 WHERE pid='P-1'"); return null; });  // 失敗

// ② 一個外層交易包住兩步
tt.execute(st -> {
    jdbc.update("INSERT INTO orders VALUES ('O-2','PENDING')");
    jdbc.update("UPDATE stock SET qty = qty - 5 WHERE pid='P-1'");                                  // 失敗
    return null;
});
```

```
  ① Repository 各自開交易 → 訂單筆數=1（期望 0，實際留下孤兒訂單）
  ② Service 開一個交易   → 訂單筆數=0（期望 0）
```

> 🔴 **「孤兒訂單」的具體形狀**：資料庫裡有一張 `PENDING` 的訂單，
> 但庫存沒扣、客戶沒收到通知、金流沒有對應紀錄。
> **它會在對帳時出現，而查不出是怎麼來的。**

**為什麼「交易邊界屬於 Service」——三個理由**：

| 理由 | 說明 |
|---|---|
| **只有 Service 知道「一個業務動作」包含哪幾步** | Repository 只看得到自己那一步 |
| **交易邊界 = 回滾邊界** | 「付款失敗要不要還庫存」是業務決定，不是資料存取決定 |
| **巢狀交易的語意很難懂** | 讓每一層都開交易，會需要理解 7 種傳播行為的組合（05 站 02 章 2.5） |

### 0.9.3 `Propagation.MANDATORY`：一個會說話的守門人

**光靠約定（「大家記得不要在 Repository 加 `@Transactional`」）是守不住的。**
所以 shop-service 反過來做：

```java
@Repository
@Transactional(propagation = Propagation.MANDATORY)   // ★★ 沒有外層交易就直接失敗
public class JdbcOrderRepository implements OrderRepository { … }
```

**`MANDATORY` 的語意**：「**必須**在別人開好的交易裡跑；沒有就拋例外。」

**本章實測（E10，Spring 容器 + `@EnableTransactionManagement`）**：

```
=== E10 MANDATORY ===
  bean 的實際類別：jdk.proxy2.$Proxy26
  ① 沒有外層交易就 save() → ✅ IllegalTransactionStateException
     No existing transaction found for transaction marked with propagation 'mandatory'
  ② 有外層交易就 save() → ✅ 成功，findById=true
```

⚠️⚠️ **但它有兩個前提，而少了任何一個它就完全沒有作用。**

**前提 1：這個物件必須是 Spring 管理的 bean。**

**同一份程式碼，改成自己 `new`（E9 實測）**：

```
  ① 直接 new 的物件：@Transactional 完全沒有作用（沒有代理）→ 存進去了
```

> 🔴 **這是 05 站 02 章 2.7「五種交易失效情境」的第三種，在資料層再出現一次。**
> **而它在測試裡特別容易發生** ——
> `new JdbcOrderRepository(new NamedParameterJdbcTemplate(ds))` 是寫整合測試最直覺的方式，
> **而那樣寫的話，`MANDATORY` 這個守門人在測試裡是關掉的。**
> **06 章 6.2 會處理這件事**（測試切片、`@DataJpaTest` 與那個守門人）。

**前提 2：方法上不能有另一個 `@Transactional` 蓋掉它。**

```java
@Repository
@Transactional(propagation = Propagation.MANDATORY)
public class JdbcOrderRepository implements OrderRepository {

    @Override
    @Transactional(propagation = Propagation.REQUIRES_NEW)   // 🔴 類別上的守門被蓋掉了
    public void save(Order order) { … }
}
```

**這一點靠 ArchUnit 守**（0.12.5 規則 5，本章實測會紅）：

```
Architecture Violation … Rule 'classes that reside in a package '..infrastructure.persistence..'
and have simple name ending with 'Repository' should 標 @Transactional(propagation = MANDATORY),
because 交易邊界屬於 Service；Repository 只能參加別人開好的交易' was violated (1 times)
```

⚠️ **注意 E10 那一行 `bean 的實際類別：jdk.proxy2.$Proxy26`**：
因為 `JdbcOrderRepository` 實作了介面，Spring 用的是 **JDK 動態代理**（不是 CGLIB）。
這代表**只有介面上宣告的方法會被代理** ——
如果你在實作類別上加了一個介面沒有的 public 方法，
**從外面（用介面型別）根本呼叫不到它**，而**自呼叫也不會經過代理**。
（01-java-core 站 13 章講過動態代理的原理；05 站 02 章 2.7 講過自呼叫。）

### 0.9.4 那「唯讀查詢」也要外層交易嗎？

**不需要，而且不應該。**

```java
@Override
@Transactional(propagation = Propagation.MANDATORY, readOnly = true)
public long countByCustomerId(String customerId) { … }
```

⚠️ 上面這個簽章是本章骨架的寫法，而它其實**太嚴格了**：
一個純粹的計數查詢，被迫要有外層交易，會讓「只是查一下」的呼叫端也要開交易。

**shop-service 的最終規則（05 章 5.3 會定案）**：

| 方法性質 | 傳播行為 | 理由 |
|---|---|---|
| 寫入（`save`、`saveAll`、原子 UPDATE） | `MANDATORY` | 一定是某個業務動作的一部分 |
| 聚合的讀取（`findById`，要拿去改的） | `MANDATORY` | 讀出來要改，必須與寫在同一個交易 |
| 純查詢（`countBy…`、QueryDao） | `SUPPORTS` + `readOnly` | 有交易就參加，沒有也能跑 |

⚠️⚠️ **這張表與 0.12.5 的 ArchUnit 規則 5 會衝突，而現在就要說清楚**：

規則 5 要求「Repository 實作的每個 public 方法，傳播行為都必須是 `MANDATORY`」。
**一旦有一個方法改成 `SUPPORTS`，那條規則就會紅。**

📌 **這是刻意的順序**：
**00 章先用最嚴格的版本**（全部 `MANDATORY`），
**等真的需要放寬時，再在規則裡開一個【具名的、寫了理由的】例外** ——
就像 0.12.5 規則 6 與判準 7 的那個衝突一樣。

⚠️ **而那一刻比預期的早**：**03 章 3.10.4** 就會為了 `nextId()` 放寬它
（`nextId()` 一行 SQL 都沒有，卻被 `MANDATORY` 逼著要外層交易）。
**規則 5 的具名例外版本寫在 03 章 3.10.5** —— 那一節同時示範了
「具名例外」與「把例外寫成條件」的差別，後者等於把規則關掉。

🔴 **不可以做的**：因為規則擋路就把它刪掉，或改成 `allowEmptyShould(true)`。
**例外要具名、要有理由、要能被搜尋到**（05-service 站 00 章 0.11.2）。

> ⚠️ **`readOnly = true` 不是「唯讀保證」** ——
> 它是給底層的**提示**（JPA 會跳過 dirty checking、
> 某些驅動會把它送給資料庫、讀寫分離會用它決定路由）。
> **它不會阻止你在裡面寫入。** 05 站 02 章 2.5.2 講過，05 章 5.7 會再用到它。

### 0.9.5 例外：真的需要獨立交易的兩個地方

**「Repository 不開交易」有兩個實務上的例外**，兩個都不在主要業務路徑上：

| 情境 | 為什麼要獨立交易 | 怎麼做 |
|---|---|---|
| **outbox 搶單**（05 站 06 章） | 一批訊息裡有一封寄失敗，不該讓其他 9 封回滾 | 每一封各開 `REQUIRES_NEW` |
| **稽核 / 失敗紀錄** | 主交易 rollback 時，**這筆紀錄要留下來** | `REQUIRES_NEW`（05 站 02 章 2.12） |

⚠️ **兩個例外都有一個共同的形狀**：
**它們寫的是「與業務資料無關的旁路資料」。**
**只要是業務資料，就不該有例外。**

---

## 0.10 從假實作到真實作：搬遷路徑 ★

### 0.10.1 05 站交出來的東西

```java
// 05-service 站 07 章 7.8.4
public class InMemoryOrderRepository implements OrderRepository {

    private final Map<String, Order> store = new ConcurrentHashMap<>();

    @Override public void save(Order order)             { store.put(order.id(), order); }
    @Override public Optional<Order> findById(String id) { return Optional.ofNullable(store.get(id)); }

    @Override
    public Page<OrderSummary> search(OrderSearchCriteria criteria, Pageable pageable) {
        throw new UnsupportedOperationException("InMemoryOrderRepository 不支援 search()：…");
    }
}
```

**它有兩個問題，而 05 站當時只點出了第二個**：

| 問題 | 05 站有沒有處理 |
|---|---|
| ① `store.put(order.id(), order)` 存的是**呼叫端手上那個物件** | ⚠️ 07 章 7.8.4 提到了風險，但沒有修 |
| ② `search()` 的語意與 SQL 不同 | ✅ 用 `UnsupportedOperationException` 大聲失敗 |

**問題 ① 的後果，本章 E4 已經量出來了**：

```
  ① 天真 fake（Map 存物件本身）  ③改了不影響已存 🔴（變成 CANCELLED）   [兩次查同一實例=true]
  ③ JDBC 實作                   ③改了不影響已存 ✅                     [兩次查同一實例=false]
```

### 0.10.2 契約測試：把「行為一致」變成 CI 的責任

**完整的契約測試**（本章實測：跑在 fake 與 JDBC 實作上，**9 條 × 2 = 18 個測試全綠**）：

```java
package example.shop.order;

/**
 * ★★ OrderRepository 的契約：同一組測試，跑在【fake】與【真實作】上。
 *
 * <p>它保證 fake 沒有偷偷變成「一個與現實不同的世界」。
 */
public abstract class OrderRepositoryContractTest {

    /** 子類別提供一個【乾淨的】 Repository。 */
    protected abstract OrderRepository repository();

    /**
     * ★ 子類別決定「怎麼在交易裡執行」——
     * JDBC 版要包 TransactionTemplate（MANDATORY 的前提，0.9.3），記憶體版直接跑。
     */
    protected <T> T inTx(Supplier<T> action) { return action.get(); }

    protected void tx(Runnable action) { inTx(() -> { action.run(); return null; }); }

    protected static final Instant T0 = Instant.parse("2026-08-28T10:00:00Z");

    protected static Order anOrder(String id, String customerId, Instant createdAt) {
        return Order.place(id, customerId,
                List.of(new OrderLine("P-1", 2, Money.twd(150)), new OrderLine("P-2", 1, Money.twd(80))),
                Money.twd(380), createdAt);
    }

    // ── 契約 1：基本往返 ───────────────────────────────────────────
    @Test
    void 存了之後查得到而且欄位一致() {
        OrderRepository repo = repository();
        tx(() -> repo.save(anOrder("O-1", "C-1", T0)));

        Order got = inTx(() -> repo.findById("O-1")).orElseThrow();
        assertThat(got.id()).isEqualTo("O-1");
        assertThat(got.customerId()).isEqualTo("C-1");
        assertThat(got.status()).isEqualTo(OrderStatus.PENDING_PAYMENT);
        assertThat(got.total()).isEqualTo(Money.twd(380));
        assertThat(got.lines()).hasSize(2);
        assertThat(got.createdAt()).isEqualTo(T0);          // ★ 時間往返（洩漏 ⑧）
    }

    @Test
    void 查不存在的id回empty() {
        assertThat(inTx(() -> repository().findById("O-NOPE"))).isEmpty();
    }

    // ── 契約 2：★ 查出來的是新物件（0.10.3）────────────────────────
    @Test
    void 查出來的訂單改了不影響已存的() {
        OrderRepository repo = repository();
        tx(() -> repo.save(anOrder("O-1", "C-1", T0)));

        Order first = inTx(() -> repo.findById("O-1")).orElseThrow();
        first.cancel();                                    // ★ 只改手上這一份，沒有 save

        Order again = inTx(() -> repo.findById("O-1")).orElseThrow();
        assertThat(again.status())
                .describedAs("沒有 save() 的修改不該被看見 —— fake 若共用參照，這裡會是 CANCELLED")
                .isEqualTo(OrderStatus.PENDING_PAYMENT);
    }

    @Test
    void 兩次查詢回傳不同的物件實例() {
        OrderRepository repo = repository();
        tx(() -> repo.save(anOrder("O-1", "C-1", T0)));
        Order a = inTx(() -> repo.findById("O-1")).orElseThrow();
        Order b = inTx(() -> repo.findById("O-1")).orElseThrow();
        assertThat(a).isNotSameAs(b);
    }

    // ── 契約 3：樂觀鎖 ────────────────────────────────────────────
    @Test
    void 用過期的version存會失敗() {
        OrderRepository repo = repository();
        tx(() -> repo.save(anOrder("O-1", "C-1", T0)));
        Order stale = inTx(() -> repo.findById("O-1")).orElseThrow();

        tx(() -> {                                            // 別人先改了
            Order fresh = repo.findById("O-1").orElseThrow();
            fresh.markPaid();
            repo.save(fresh);
        });

        assertThatThrownBy(() -> tx(() -> repo.save(stale)))
                .isInstanceOf(OptimisticLockingFailureException.class);
    }

    // ── 契約 4：授權內建在查詢（判準 5）───────────────────────────
    @Test
    void 客戶只看得到自己的訂單而客服看得到全部() {
        OrderRepository repo = repository();
        tx(() -> repo.save(anOrder("O-1", "C-1", T0)));

        assertThat(inTx(() -> repo.findByIdVisibleTo("O-1", new Actor("C-1", Actor.Role.CUSTOMER)))).isPresent();
        assertThat(inTx(() -> repo.findByIdVisibleTo("O-1", new Actor("C-9", Actor.Role.CUSTOMER)))).isEmpty();
        assertThat(inTx(() -> repo.findByIdVisibleTo("O-1", new Actor("S-1", Actor.Role.SUPPORT)))).isPresent();
    }

    // ── 契約 5：排程查詢的排序與上限（洩漏 ⑤）─────────────────────
    @Test
    void 逾期查詢有穩定的排序與筆數上限() {
        OrderRepository repo = repository();
        tx(() -> {
            for (int i = 0; i < 5; i++) repo.save(anOrder("O-" + i, "C-2", T0.minus(i + 1, ChronoUnit.HOURS)));
        });

        List<String> first  = inTx(() -> repo.findExpiredPendingPayment(T0, 3)).stream().map(Order::id).toList();
        List<String> second = inTx(() -> repo.findExpiredPendingPayment(T0, 3)).stream().map(Order::id).toList();

        assertThat(first).hasSize(3).isEqualTo(second);
        assertThat(first).describedAs("最舊的先出").containsExactly("O-4", "O-3", "O-2");
    }

    @Test
    void countByCustomerId只算這個客戶的() {
        OrderRepository repo = repository();
        tx(() -> {
            repo.save(anOrder("O-1", "C-1", T0));
            repo.save(anOrder("O-2", "C-1", T0));
            repo.save(anOrder("O-3", "C-2", T0));
        });
        assertThat(inTx(() -> repo.countByCustomerId("C-1"))).isEqualTo(2);
        assertThat(inTx(() -> repo.countByCustomerId("C-9"))).isZero();
    }

    @Test
    void nextId每次都不同() {
        OrderRepository repo = repository();
        assertThat(repo.nextId()).isNotEqualTo(repo.nextId());
    }
}
```

**兩個子類別**：

```java
class InMemoryOrderRepositoryTest extends OrderRepositoryContractTest {
    private final OrderRepository repo = new InMemoryOrderRepository();
    @Override protected OrderRepository repository() { return repo; }
}
```

```java
class JdbcOrderRepositoryContractTest extends OrderRepositoryContractTest {

    private HikariDataSource ds;
    private OrderRepository repo;
    private TransactionTemplate tt;

    @BeforeEach
    void setUp() throws Exception {
        ds = testDataSource();
        JdbcTemplate jdbc = new JdbcTemplate(ds);
        for (String stmt : Files.readString(Path.of("src/main/resources/schema.sql")).split(";"))
            if (!stmt.isBlank()) jdbc.execute(stmt);
        repo = new JdbcOrderRepository(new NamedParameterJdbcTemplate(ds));
        tt = new TransactionTemplate(new DataSourceTransactionManager(ds));
    }

    @AfterEach void tearDown() { ds.close(); }

    @Override protected OrderRepository repository() { return repo; }

    /** ★ JDBC 版：每個操作都要在交易裡（MANDATORY 的前提，0.9.3）。 */
    @Override protected <T> T inTx(Supplier<T> action) { return tt.execute(st -> action.get()); }
}
```

**它抓得到東西嗎？把 fake 改回「天真版」（`copyOf` 直接 `return o;`）**：

```
[ERROR] Tests run: 9, Failures: 2 -- in InMemoryOrderRepositoryTest
[ERROR]   兩次查詢回傳不同的物件實例:83
[ERROR]   查出來的訂單改了不影響已存的:74
          [沒有 save() 的修改不該被看見 —— fake 若共用參照，這裡會是 CANCELLED]
          expected: PENDING_PAYMENT
```

> ✅ **兩條紅燈，訊息直接說明了原因。**
> 這就是 05 站 07 章 7.17「探針不是測試 —— 一條從來沒紅過的守門測試等於沒有」的實踐：
> **每一條守門測試，都應該有一個「我讓它紅過」的紀錄。**

⚠️ **注意 `JdbcOrderRepositoryContractTest` 用的是 `new JdbcOrderRepository(...)`** ——
如 0.9.3 所說，**這樣寫的話 `MANDATORY` 沒有作用**（沒有 Spring 代理）。
所以這組測試用 `TransactionTemplate` **手動**包住每個操作。
**06 章 6.2 會給另一個版本**（用 Spring 的測試切片，讓代理與守門人都在）。

### 0.10.3 「兩次查回來是不是同一個物件」——四個會壞掉的地方

**這個差異看起來很小，但它會讓四類程式碼在 fake 與真實作之間行為不同**：

| # | 程式碼 | 在 fake 上 | 在 JDBC 上 | 在 JPA 上 |
|---|---|---|---|---|
| ① | 改了物件但**忘記 `save()`** | 🔴 **生效**（測試綠） | ✅ 不生效 | ⚠️ **生效**（dirty checking） |
| ② | `findById(x) == findById(x)` | 🔴 true | ✅ false | ⚠️ **true**（同一個持久化情境內） |
| ③ | 兩個 Service 各自 `findById` 同一張單，各自改 | 🔴 **互相看得見**（同一個物件） | ✅ 各改各的，`save` 時樂觀鎖擋 | ⚠️ 同 fake |
| ④ | 把查出來的物件放進快取 | 🔴 快取到 Map 裡那一個，被別人改到 | ✅ 安全 | 🔴 危險 |

> ⚠️⚠️ **注意 ① 這一列的三個答案是「生效 / 不生效 / 生效」。**
>
> **也就是說：從 fake 換到 JDBC，這類 bug 會【暴露】；
> 從 JDBC 換到 JPA，它又會【消失】。**
>
> 🔴 **而「消失」比「暴露」危險** —— 因為它會讓「忘記 save」的程式碼看起來是對的，
> 直到有一天那個方法被搬到交易外面。
> **08 站 03 章會處理這件事**，而本章的契約測試是那一次切換的安全網。

### 0.10.4 搬遷的六個步驟

**不要一次換掉。** 這是一個有順序的過程：

```
① 先寫 schema.sql（0.12.3）
   └─→ 此時什麼都還沒改，但 CHECK 與 UNIQUE 讓「什麼是合法資料」有了正式定義

② 補齊契約測試，跑在【現有的 fake】上（0.10.2）
   └─→ ⚠️ 這一步會先讓 fake 紅 —— 那就是它的價值（本章實測：紅 2 條）

③ 修好 fake，讓契約全綠
   └─→ 現在「正確的行為」有了可執行的定義

④ 寫 JdbcOrderRepository，讓同一組契約也綠（0.12.2）
   └─→ ★ 這一步會逼出「聚合怎麼從兩個 ResultSet 重建」的設計

⑤ 換掉 Spring 的 bean 註冊，讓正式路徑用 JDBC 版
   └─→ 05 站的 475 條測試現在會跑在真的 SQL 上 —— ⚠️ 預期會紅幾條，那些就是收穫

⑥ fake 留著，但只給【單元測試】用
   └─→ 0.10.5
```

⚠️ **第 ④ 步「逼出設計」的具體樣子**：

```java
/** ★ 兩個 ResultSet 拼成聚合：先查頭，再用 IN 一次撈所有明細（不是每張訂單各查一次）。 */
private List<Order> load(String headSql, SqlParameterSource params) {
    List<OrderRow> heads = jdbc.query(headSql, params, OrderRow.mapper());
    if (heads.isEmpty()) return List.of();

    Map<String, List<OrderLineRow>> linesByOrder = jdbc.query(
                    "SELECT * FROM order_line WHERE order_id IN (:ids) ORDER BY order_id, line_no",
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
```

**這段程式碼有三個「只有寫真實作才會遇到」的設計決定**：

| 決定 | 為什麼 |
|---|---|
| **`OrderRow` 是一個 record，不是直接 `new Order`** | 一張訂單來自兩個 ResultSet，要等兩邊到齊 |
| **明細用 `IN (:ids)` 一次撈** | 判準 2：不然這裡自己就是 N+1 |
| **用 `Order.rehydrate` 而不是 `Order.place`** | 見下方 |

```java
/** 新單：走完整的業務驗證。 */
public static Order place(String id, String customerId, List<OrderLine> lines, Money total, Instant now) {
    if (lines.isEmpty()) throw new IllegalArgumentException("訂單至少要有一筆明細");
    return new Order(id, customerId, OrderStatus.PENDING_PAYMENT, lines, total, now, 0L);
}

/**
 * ★ 從資料庫重建。
 *
 * <p>⚠️ 它與 {@link #place} 的差別：
 * <b>重建不做業務驗證</b>（資料庫裡的資料已經發生過了，你不能拒絕它），
 * 但<b>要做不變量檢查</b>（讀到壞資料要立刻知道，而不是讓它繼續傳播）。
 */
public static Order rehydrate(String id, String customerId, OrderStatus status,
                              List<OrderLine> lines, Money total, Instant createdAt, long version) {
    Order order = new Order(id, customerId, status, lines, total, createdAt, version);
    order.assertInvariants();
    return order;
}
```

> 📌 **`place` 與 `rehydrate` 的區分，是「有了真的資料庫之後才需要的」設計。**
> 05 站的聚合只有 `place` —— 因為 fake 存的就是物件本身，根本沒有「重建」這件事。
>
> ⚠️ **兩者的差別用一句話說**：
> **`place` 回答「這個新訂單可以成立嗎」；`rehydrate` 回答「這筆資料還是一張合法的訂單嗎」。**
> 前者失敗是 **4xx**，後者失敗是 **500 + 告警**（資料已經壞了）。

### 0.10.5 fake 應該什麼時候退休？

**不退休。** 它換一個角色：

| 測試種類 | 用哪個 Repository | 為什麼 |
|---|---|---|
| Domain 單元測試 | **不用 Repository** | 聚合不該認識它 |
| Application Service 單元測試（約 300 條） | ✅ **fake** | 快（本章實測 9 條 0.010 s vs JDBC 0.276 s，**27 倍**） |
| Repository 整合測試 | ✅ **真實作** | 那正是要測的東西 |
| 端到端測試（少數） | ✅ 真實作 | 要驗證整條路徑 |

⚠️ **而 fake 有一個必要條件才能留下**：**它必須被契約測試綁著。**
沒有契約測試的 fake，會在半年後變成「一個與現實不同的世界」——
而那時候你的 300 條單元測試，測的是那個世界。

---

## 0.11 資料存取層不該做的九件事

### 0.11.1 不該做：自己開交易

**已在 0.9 完整說明。** 一句話版本：

> **Repository 的每一個方法，都應該是「別人正在做的一件事」的一部分。**
> 它不知道那件事是什麼，所以它沒有資格決定回滾邊界。

**守門**：`@Transactional(propagation = MANDATORY)` + ArchUnit 規則 5。

### 0.11.2 不該做：做業務判斷

```java
// 🔴 判斷寫在 Repository
public void deductStock(String productId, int qty) {
    Integer current = jdbc.queryForObject("SELECT qty FROM stock WHERE pid = ?", Integer.class, productId);
    if (current < qty) {
        throw new InsufficientStockException(productId, qty, current);   // 🔴 業務例外
    }
    jdbc.update("UPDATE stock SET qty = ? WHERE pid = ?", current - qty, productId);
}

// ✅ Repository 只提供「原子的能力」，判斷留給 Service
public boolean tryReserve(String productId, int qty) {
    return jdbc.update("UPDATE stock SET qty = qty - ? WHERE pid = ? AND qty >= ?",
                       qty, productId, qty) == 1;
}
```

**三個理由**：

| 理由 | 說明 |
|---|---|
| ① 上面那個寫法**本身就是錯的** | 0.8.1 實測：先查再寫在併發下必失效 |
| ② 業務例外屬於 Service | 04 章的 41 個例外對應 98 個 `ErrorCode`，資料層不該認識它們 |
| ③ **同一個能力有不同的業務意義** | 「扣庫存失敗」在下單是 409，在補貨對帳是「記 log 繼續」 |

### 0.11.3 不該做：讓實作細節外流

**四種洩漏，由重到輕**：

```java
// 🔴🔴 最嚴重：把 Connection / ResultSet 交出去（誰負責關？）
ResultSet findOrdersRaw(String sql);

// 🔴 把資料列的形狀交出去
List<Map<String, Object>> findOrders(String customerId);

// 🔴 把 ORM 的型別交出去
EntityManager entityManager();
Order merge(Order order);

// ⚠️ 邊界案例：把 Spring Data 的分頁型別交出去
Page<OrderSummary> search(Criteria c, Pageable p);   // ← 通常可以接受（判準 7）
```

**shop-service 的做法**：`OrderRow` / `OrderLineRow` 兩個 record 都是 **package-private**：

```java
/** ⚠️ 兩個 record 都是 package-private —— 它們是這個套件的內部細節。 */
record OrderRow(String id, String customerId, OrderStatus status,
                long totalMinor, String currency, Instant createdAt, long version) { … }
```

> 📌 **一個好用的檢查**：
> **「這個型別的名字裡有沒有 `Row`、`Entity`、`PO`、`DO`？如果有，它應該離不開這個套件。」**

### 0.11.4 不該做：拼字串組 SQL

**已在 0.3.2 事故 1 實測。** 補充**兩個「看起來安全但不是」的情況**：

```java
// 🔴 ① 「我有做白名單啊」——但 sort 是使用者傳的
String sort = request.getParameter("sort");
sql += " ORDER BY " + sort;          // ⚠️ 欄位名不能用 PreparedStatement 參數！

// ✅ 正解：對照表，不是字串檢查
private static final Map<String, String> SORTABLE = Map.of(
        "createdAt", "created_at",
        "amount",    "total_minor",
        "status",    "status");
String column = SORTABLE.get(sort);
if (column == null) throw new InvalidSortFieldException(sort);   // ★ 白名單「翻譯」而不是「驗證」
sql += " ORDER BY " + column + ", id";                            // ★ 加第二排序鍵（洩漏 ⑤）
```

```java
// 🔴 ② IN 條件用拼的
String in = ids.stream().map(id -> "'" + id + "'").collect(joining(","));
jdbc.query("SELECT * FROM orders WHERE id IN (" + in + ")", …);

// ✅ 具名參數的集合展開（02 章 2.6）
jdbc.query("SELECT * FROM orders WHERE id IN (:ids)",
           new MapSqlParameterSource("ids", ids), mapper);
```

⚠️ **第 ① 個情況是實務上最常見的殘留洞**，因為「欄位名不能參數化」是真的 ——
所以很多人就直接拼了。**對照表是唯一正確的解法**（04 章 4.5 會再處理一次）。

### 0.11.5 不該做：吞例外、回 null

```java
// 🔴 0.3 那個 OrderDao 的寫法
try {
    …
} catch (SQLException e) {
    e.printStackTrace();     // 🔴 例外消失，呼叫端以為成功了
}
```

**資料層的例外處理，只有三種合法的做法**：

| 做法 | 什麼時候 | 例子 |
|---|---|---|
| **① 讓它往上拋**（預設） | 絕大多數情況 | 連線失敗、逾時、語法錯 |
| **② 翻譯成有意義的例外** | 這個失敗有明確的業務意義 | 唯一索引違反 → `DuplicateOrderException`（0.8.6） |
| **③ 轉成回傳值** | 這個失敗是**預期內的正常結果** | `tryReserve` 回 `false` |

⚠️ **Spring 已經幫你做了一半的 ①**：`JdbcTemplate` 會把 `SQLException`（checked）
翻譯成 `DataAccessException` 家族（unchecked）。**本章實測（E8-B）**：

```
=== E8-B 例外翻譯 ===
  原生 JDBC：org.h2.jdbc.JdbcSQLIntegrityConstraintViolationException  errorCode=23505  sqlState=23505
            訊息第一行：Unique index or primary key violation: "PUBLIC.PRIMARY_KEY_5 ON PUBLIC.T(ID) VALUES ( /* 1 */ 'A' )"
  JdbcTemplate：org.springframework.dao.DuplicateKeyException （繼承自 DataIntegrityViolationException，unchecked）
```

> 📌 **注意左邊那個 `errorCode=23505`**：
> 在 MySQL 上，同一件事的錯誤碼是 **1062**，例外類別是 `SQLIntegrityConstraintViolationException`。
> **`DuplicateKeyException` 是兩邊共同的名字** —— 這就是「翻譯」這個職責的具體價值（0.4.1 職責 ①）。
>
> ⚠️ 而它的**極限**在 0.8.6 已經看到了：
> **「是哪一條約束」仍然要靠比對訊息字串。**

### 0.11.6 不該做：在迴圈裡查詢

**已在 0.3.2 事故 5 與判準 2 說明。** 補一個**最難發現的變形**：

```java
// 🔴 N+1 藏在 stream 裡，看起來很優雅
List<OrderView> views = orders.stream()
        .map(o -> new OrderView(o, customerRepository.findById(o.customerId())))   // ← 每一筆一次查詢
        .toList();

// ✅ 先批次撈，再組裝
Map<String, Customer> customers = customerRepository
        .findAllById(orders.stream().map(Order::customerId).distinct().toList())
        .stream().collect(toMap(Customer::id, identity()));
List<OrderView> views = orders.stream()
        .map(o -> new OrderView(o, customers.get(o.customerId())))
        .toList();
```

> ⚠️ **`.stream().map(x -> repository.findXxx(...))` 是 N+1 最常見的偽裝。**
> **04 章 4.9 會給一個守門測試**：用一個計數的 `DataSource` 包裝，
> 讓「一個請求的查詢次數超過 N」直接讓測試紅。

### 0.11.7 不該做：一次撈全部

**已在 0.3.2 事故 4 實測（`-Xmx96m` 下 `OutOfMemoryError`）。** 三個正確做法：

```java
// ✅ ① 有上限的查詢
List<Order> findExpiredPendingPayment(Instant now, int limit);

// ✅ ② 分頁
Page<OrderSummary> search(Criteria c, Pageable p);

// ✅ ③ 串流：逐列處理，不進記憶體（05 章 5.9）
void streamForExport(Criteria c, Consumer<OrderExportRow> handler);
```

**③ 的效果（E6 實測，30 萬筆）**：

```
  ① query() 回 List：300000 筆，heap 增加 11.3 MB
  ② RowCallbackHandler 逐列：sum=45000150000，heap 增加 0.0 MB
```

⚠️ **注意 ① 只有 11.3 MB** —— 那是因為測試資料每列都一樣（0.3.2 事故 4 的但書）。
**換成每列不同的資料，同一段程式碼在 96 MB 的堆上直接 OOM。**

### 0.11.8 不該做：認識「權限規則」——但**可以**認識「可見範圍」

**這是 0.6 判準 1 與判準 5 留下來的那個邊界，現在把它劃清楚。**

```java
// ✅ 可以：把「這個 actor 看得到哪些資料」變成查詢條件
Optional<Order> findByIdVisibleTo(String orderId, Actor actor);
List<Order> findByCustomerVisibleTo(Actor actor, int limit);

// 🔴 不可以：判斷「這個 actor 能不能做這個動作」
boolean canCancel(String orderId, Actor actor);         // ← 這是業務規則
void cancelIfAllowed(String orderId, Actor actor);      // ← 這是業務動作

// 🔴 不可以：認識角色的「意義」
if (actor.role() == Role.SUPPORT && order.amount() > 10000) { … }   // ← 金額門檻是業務規則
```

**判準**：

| 問題 | 屬於 | 為什麼 |
|---|---|---|
| 「這個人**看得到哪些列**？」 | ✅ 可以進查詢 | 它是**資料的範圍**，寫在 WHERE 裡才正確且有效率 |
| 「這個人**能不能做這件事**？」 | 🔴 Service / Domain | 它是**動作的規則**，與資料範圍無關 |
| 「這個人**看得到哪些欄位**？」 | ⚠️ 兩邊都不是 | 那是**輸出的塑形**，屬於 mapper（05 站 03 章 3.7） |

> 📌 **一句話**：
> **資料層可以知道「你是誰」，不可以知道「你被允許做什麼」。**

### 0.11.9 不該做：在資料層處理「顯示」

```java
// 🔴 在 RowMapper 裡做格式化
new OrderView(rs.getString("id"),
              new SimpleDateFormat("yyyy/MM/dd").format(rs.getTimestamp("created_at")),  // 🔴
              "NT$ " + rs.getBigDecimal("amount"),                                        // 🔴
              statusLabel(rs.getString("status")));                                       // 🔴 中文標籤
```

**三個都錯，理由各不同**：

| 問題 | 為什麼錯 | 該在哪 |
|---|---|---|
| 日期格式化 | 格式屬於**呈現**，而且與時區、語系有關 | Web 層的序列化（04-controller 06 章） |
| 幣別符號 | `Money` 已經帶著幣別，加符號是呈現 | Web 層 |
| **狀態的中文標籤** | 🔴 **最嚴重** —— 那是 Domain 的規則，會有兩份真相 | `StatusLabelResolver`（05 站 00 章 0.14.5） |

### 0.11.10 九件事的總表

| # | 不該做 | 對應事故 | 守門方式 |
|---|---|---|---|
| ① | 自己開交易 | 事故 3（孤兒訂單） | `MANDATORY` + ArchUnit 規則 5 |
| ② | 做業務判斷 | 事故 6（超賣） | Code review + 介面形狀（判準 6） |
| ③ | 讓實作細節外流 | — | ArchUnit 規則 3、6 + package-private |
| ④ | 拼字串組 SQL | 事故 1（Injection） | ArchUnit（02 章 2.4）+ 靜態掃描 |
| ⑤ | 吞例外、回 null | 事故 2（連線洩漏無日誌） | Code review |
| ⑥ | 在迴圈裡查詢 | 事故 5（N+1） | 介面只給批次版 + 查詢次數守門測試（04 章） |
| ⑦ | 一次撈全部 | 事故 4（OOM） | 介面不提供 `findAll()` |
| ⑧ | 認識權限規則 | — | ArchUnit：persistence 不可依賴 `..security..`（**02 章 2.12.8 規則 B**） |
| ⑨ | 處理顯示 | — | ArchUnit：persistence 不可依賴 `java.text..`、`..i18n..`（**02 章 2.12.8 規則 C**） |

---

## 0.12 shop-service 的資料層骨架

⚠️ **本節的每一段程式碼都在本機編譯並執行過**（Java 21 / Spring Boot 3.2.5 / H2 2.2.224），
測試結果在 0.19。

### 0.12.1 套件結構

```
example.shop
├── common/
│   └── money/Money.java                       ← 05 站的值物件（本站要決定它怎麼落地）
├── order/
│   ├── domain/                                ← 05 站，這一站【一行都不改】
│   │   ├── Order.java                         ★ 但要新增 rehydrate()（0.10.4）
│   │   ├── OrderLine.java
│   │   └── OrderStatus.java
│   ├── application/
│   │   ├── OrderApplicationService.java       ← 05 站，交易邊界在這裡
│   │   ├── OrderQueryService.java
│   │   └── port/
│   │       ├── Actor.java
│   │       ├── OrderRepository.java           ★ 命令埠（0.12.2）
│   │       └── OrderQueryDao.java             ★ 查詢埠（0.7.2）
│   └── infrastructure/
│       ├── persistence/                       ★ 唯一可以碰 JDBC 的套件
│       │   ├── JdbcOrderRepository.java
│       │   ├── JdbcOrderQueryDao.java         （04 章）
│       │   └── OrderRowMapper.java            （package-private 的 row record）
│       └── memory/
│           └── InMemoryOrderRepository.java   ★ 測試用的 fake（0.10.5）
├── stock/
│   ├── application/port/StockPort.java
│   └── infrastructure/persistence/JdbcStockPort.java     （02 章）
└── architecture/
    └── DataAccessArchitectureTest.java        ★ 六組守門規則（0.12.5）
```

⚠️ **`infrastructure/memory/` 放在 `src/main` 而不是 `src/test`**，
理由是它會被**多個模組的測試**用到；如果只放 `src/test`，
其他模組的測試就拿不到它（Maven 的 test 範圍預設不會傳遞）。
**代價是：它會被打包進正式的 jar。**（另一個選項是 `test-jar`。）

### 0.12.2 `OrderRepository`：命令埠

```java
package example.shop.order.application.port;

import example.shop.order.domain.Order;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;

/**
 * 訂單的持久化埠（05-service 00 章 0.12 ⑩ 的版本，本站補上四個方法）。
 *
 * <p>★ 它只負責<b>寫路徑</b>：以「聚合」為單位存與取。
 * 列表、搜尋、報表走另一個介面（{@code OrderQueryDao}，見 0.7）。
 */
public interface OrderRepository {

    /** ★ 06 站新增：id 由誰產生（0.6.2 ⑯）。 */
    String nextId();

    /**
     * 新增或更新一張訂單。
     *
     * @throws org.springframework.dao.OptimisticLockingFailureException
     *         version 對不上（有人在你讀出來之後改過它）
     */
    void save(Order order);

    /** ★ 06 站新增：批次存，給排程與匯入用（0.6.2 ⑫）。 */
    void saveAll(Collection<Order> orders);

    Optional<Order> findById(String orderId);

    /** ★ 授權內建在查詢條件裡 —— 理由見 0.11.8。 */
    Optional<Order> findByIdVisibleTo(String orderId, Actor actor);

    /**
     * 給排程用：逾期未付款的訂單。
     *
     * <p>⚠️ 排序是<b>契約的一部分</b>（{@code created_at, id} 遞增）——
     * 沒有第二個排序鍵時，「每次跑都拿到同一批」不成立（0.5.1 ⑤）。
     */
    List<Order> findExpiredPendingPayment(Instant now, int limit);

    long countByCustomerId(String customerId);
}
```

⚠️ **一個容易被質疑的地方：埠的 javadoc 提到了
`org.springframework.dao.OptimisticLockingFailureException`，這算不算洩漏？**

**算，而且是刻意接受的。** 理由有三個：

| 理由 | 說明 |
|---|---|
| `org.springframework.dao` **不帶任何持久化技術** | 它是一組純粹的例外型別，JDBC / JPA / MyBatis / MongoDB 都用它 |
| **「樂觀鎖衝突」需要一個共同的名字** | 不然每個實作會拋自己的例外，呼叫端要 catch 三種 |
| 自己定義一個 `ConcurrentModificationException` 的話 | 每個實作都要多一層轉換，而語意完全一樣 |

> 📌 **判準**（0.5.2 的同一條）：
> **「這個型別會不會綁死實作技術？」** ——
> `DataAccessException` 家族不會，`EntityManager` 會。
>
> ⚠️ 但這個決定要**寫下來**，不然下一個人會順手把
> `org.springframework.jdbc.BadSqlGrammarException` 也放進埠的簽章裡 ——
> **那個就真的綁死 JDBC 了**（而且 0.12.5 的規則 6 會擋住它）。

**`Actor`（05 站的型別，這裡列出以便自足）**：

```java
package example.shop.order.application.port;

/** 04-controller 站傳下來的「誰在操作」。 */
public record Actor(String userId, Role role) {
    public enum Role { CUSTOMER, SUPPORT, ADMIN }
    public boolean isStaff() { return role != Role.CUSTOMER; }
}
```

**`Order` 聚合（本站使用的版本 —— 05 站 0.9.2 的精簡版，加上 `rehydrate`）**：

```java
package example.shop.order.domain;

import example.shop.common.money.Money;

import java.time.Instant;
import java.util.List;
import java.util.Objects;

/**
 * 訂單聚合。
 *
 * <p>⚠️ 注意它<b>沒有</b>任何 {@code java.sql}、{@code jakarta.persistence} 或
 * Spring 的 import —— 這一點由 0.12.5 的 ArchUnit 規則 1 守著。
 */
public final class Order {

    private final String id;
    private final String customerId;
    private OrderStatus status;
    /**
     * ⚠️ 這一個<b>不是</b> {@code final}：本章練習 3 的 {@code removeLine()} 要換掉整份明細。
     * 內容本身仍然是不可變的（{@code List.copyOf}），所以外面拿到的清單改不動。
     */
    private List<OrderLine> lines;
    private final Money total;
    private final Instant createdAt;
    private final long version;

    private Order(String id, String customerId, OrderStatus status,
                  List<OrderLine> lines, Money total, Instant createdAt, long version) {
        this.id = Objects.requireNonNull(id);
        this.customerId = Objects.requireNonNull(customerId);
        this.status = Objects.requireNonNull(status);
        this.lines = List.copyOf(lines);
        this.total = Objects.requireNonNull(total);
        this.createdAt = Objects.requireNonNull(createdAt);
        this.version = version;
    }

    /** 新單：版本從 0 開始，走完整的業務驗證。 */
    public static Order place(String id, String customerId, List<OrderLine> lines, Money total, Instant now) {
        if (lines.isEmpty()) throw new IllegalArgumentException("訂單至少要有一筆明細");
        return new Order(id, customerId, OrderStatus.PENDING_PAYMENT, lines, total, now, 0L);
    }

    /** ★ 從資料庫重建：不做業務驗證，但做不變量檢查（0.10.4）。 */
    public static Order rehydrate(String id, String customerId, OrderStatus status,
                                  List<OrderLine> lines, Money total, Instant createdAt, long version) {
        Order order = new Order(id, customerId, status, lines, total, createdAt, version);
        order.assertInvariants();
        return order;
    }

    public void cancel() {
        if (status.isTerminal()) throw new IllegalStateException("已結束的訂單不能取消：" + status);
        status = OrderStatus.CANCELLED;
    }

    public void markPaid() {
        if (status != OrderStatus.PENDING_PAYMENT) throw new IllegalStateException("只有待付款可以標記已付款：" + status);
        status = OrderStatus.PAID;
    }

    private void assertInvariants() {
        if (lines.isEmpty()) throw new IllegalStateException("不變量被破壞：訂單沒有明細 " + id);
        if (total.isNegative()) throw new IllegalStateException("不變量被破壞：總額為負 " + id);
    }

    public String id() { return id; }
    public String customerId() { return customerId; }
    public OrderStatus status() { return status; }
    public List<OrderLine> lines() { return lines; }
    public Money total() { return total; }
    public Instant createdAt() { return createdAt; }
    public long version() { return version; }
}
```

```java
package example.shop.order.domain;

public enum OrderStatus {
    PENDING_PAYMENT, PAID, PARTIALLY_SHIPPED, SHIPPED, DELIVERED, CANCELLED, REFUNDED;

    public boolean isTerminal() { return this == DELIVERED || this == CANCELLED || this == REFUNDED; }
}
```

```java
package example.shop.order.domain;

import example.shop.common.money.Money;

public record OrderLine(String productId, int quantity, Money unitPrice) {
    public OrderLine {
        if (quantity <= 0) throw new IllegalArgumentException("數量必須大於 0");
    }
}
```

**`Money`：這一站要為它做一個決定 ——「金額怎麼落地」**

```java
package example.shop.common.money;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.Currency;
import java.util.Objects;

/** 05-service 00 章 0.5.3 的值物件（本站只用到其中一部分，並補上落地用的兩個方法）。 */
public record Money(BigDecimal amount, Currency currency) implements Comparable<Money> {

    public static final Currency TWD = Currency.getInstance("TWD");

    public Money {
        Objects.requireNonNull(amount, "amount");
        Objects.requireNonNull(currency, "currency");
        amount = amount.setScale(currency.getDefaultFractionDigits(), RoundingMode.HALF_UP);
    }

    public static Money twd(long amount) { return new Money(BigDecimal.valueOf(amount), TWD); }

    public Money plus(Money other)  { requireSameCurrency(other); return new Money(amount.add(other.amount), currency); }
    public Money minus(Money other) { requireSameCurrency(other); return new Money(amount.subtract(other.amount), currency); }
    public boolean isNegative()     { return amount.signum() < 0; }

    /** ★ 資料庫存的是「最小單位的整數 + 幣別」兩欄 —— 理由見下方。 */
    public long minorUnits() {
        return amount.movePointRight(currency.getDefaultFractionDigits()).longValueExact();
    }

    public static Money ofMinorUnits(long minor, String currencyCode) {
        Currency c = Currency.getInstance(currencyCode);
        return new Money(BigDecimal.valueOf(minor, c.getDefaultFractionDigits()), c);
    }

    private void requireSameCurrency(Money other) {
        if (!currency.equals(other.currency))
            throw new IllegalArgumentException("幣別不同：" + currency + " vs " + other.currency);
    }

    @Override public int compareTo(Money o) { requireSameCurrency(o); return amount.compareTo(o.amount); }
}
```

**「金額用什麼欄位型別」是這一站的第一個落地決定**：

| 方案 | 欄位 | 優點 | 缺點 |
|---|---|---|---|
| `DOUBLE` | 🔴 **絕不** | — | 二進位浮點無法精確表示 0.1 |
| `DECIMAL(19,4)` | `total DECIMAL(19,4)` + `currency CHAR(3)` | 直覺、資料庫可以 SUM | ⚠️ **scale 固定** —— 而各幣別的小數位數不同（見下表） |
| **`BIGINT` 最小單位** ✅ | `total_minor BIGINT` + `currency CHAR(3)` | **精度由幣別決定，永不捨入** | 讀 SQL 時要心算（38000 = NT$380） |

⚠️ **「各幣別小數位數不同」這件事，一定要用程式碼確認過再寫死** ——
本章實測 `Currency.getInstance(x).getDefaultFractionDigits()`（JDK 21）：

| 幣別 | Java 認為的小數位數 |
|---|---|
| **TWD** | **2** ⚠️ |
| JPY | 0 |
| USD | 2 |
| KWD | 3 |
| EUR | 2 |

> 🔴 **TWD 是 2 而不是 0，這一點很反直覺** ——
> 台灣的實務上金額幾乎都是整數元，發票也沒有角分。
> **但 ISO 4217 給 TWD 的小數位數是 2，Java 照著它走。**
>
> **後果**：`Money.twd(380).minorUnits()` 得到的是 **38000**，不是 380。
> 資料庫裡看到 `total_minor = 38000` 代表 **NT$380**。
>
> ⚠️ **如果你決定「TWD 就是整數元」**，那就不能用 `getDefaultFractionDigits()`，
> 而要自己維護一張幣別 → 小數位數的對照表，**並在 `Money` 的測試裡把它釘住**。
> 🔴 **兩種做法都可以，不能兩種混用** ——
> 混用的症狀是「同一筆錢在兩個地方差 100 倍」。

> 📌 **shop-service 選第三種**，主要理由是 05 站 0.5.3 的 `Money.allocate()`：
> **分帳與折扣分攤需要「不遺失任何一分錢」**，而那件事在整數上是可證明的，
> 在 `DECIMAL(19,4)` 上要處理 scale 不一致。
>
> ⚠️ **代價是真的**：報表查詢要寫 `SUM(total_minor) / 100`，
> 而**除數與幣別有關** —— 所以報表**必須**按幣別分組。
> **04 章 4.11 會給一個 `SUM` 的正確寫法。**

### 0.12.3 `schema.sql`

```sql
-- shop-service 的訂單資料表
-- ⚠️ 這份 DDL 同時要能跑在 H2 與 MySQL 8 上，所以刻意避開兩邊不同的語法。

CREATE TABLE IF NOT EXISTS orders (
    id           VARCHAR(26)  NOT NULL,
    customer_id  VARCHAR(26)  NOT NULL,
    status       VARCHAR(20)  NOT NULL,
    total_minor  BIGINT       NOT NULL,
    currency     CHAR(3)      NOT NULL,
    created_at   TIMESTAMP    NOT NULL,
    version      BIGINT       NOT NULL,
    CONSTRAINT pk_orders PRIMARY KEY (id),
    -- ★ 不變量 I3 的第四道防線（0.8）——「抓 bug」，不是「擋併發」
    CONSTRAINT ck_orders_total CHECK (total_minor >= 0),
    -- ★ 可執行的文件：幣別只有這三種
    CONSTRAINT ck_orders_currency CHECK (currency IN ('TWD', 'JPY', 'USD'))
);

-- ★ findExpiredPendingPayment 的索引：欄位順序就是查詢條件的順序（07-mysql 站 03 章）
CREATE INDEX IF NOT EXISTS ix_orders_pending  ON orders (status, created_at, id);
CREATE INDEX IF NOT EXISTS ix_orders_customer ON orders (customer_id, created_at, id);

CREATE TABLE IF NOT EXISTS order_line (
    order_id         VARCHAR(26) NOT NULL,
    line_no          INT         NOT NULL,
    product_id       VARCHAR(26) NOT NULL,
    quantity         INT         NOT NULL,
    unit_price_minor BIGINT      NOT NULL,
    currency         CHAR(3)     NOT NULL,
    CONSTRAINT pk_order_line PRIMARY KEY (order_id, line_no),
    CONSTRAINT fk_order_line_order FOREIGN KEY (order_id) REFERENCES orders (id),
    -- ★ 不變量：明細數量必須大於 0
    CONSTRAINT ck_order_line_qty CHECK (quantity > 0)
);
```

**六個設計決定，每一個都有理由**：

| 決定 | 理由 | 反對意見 |
|---|---|---|
| **每一條約束都有名字** | 0.8.6 要靠名字翻譯例外 | 名字要維護 |
| `total_minor BIGINT` + `currency CHAR(3)` | 0.12.2 的表 | 報表要除 |
| `version BIGINT` | 樂觀鎖（0.8.7 做法 A） | 每次 UPDATE 都要帶 |
| **`line_no` 進主鍵** | 明細沒有自然的 id，而 `(order_id, line_no)` 是穩定的 | 中間插入要重排 |
| **外鍵 `fk_order_line_order`** | 孤兒明細是真的會發生的（事故 3） | ⚠️ 高併發寫入時外鍵有鎖成本（07 站 04 章） |
| `TIMESTAMP` 而不是 `DATETIME` | — | ⚠️ **這一格是錯的，見下方** |

⚠️ **最後一列是一個刻意留下的坑，07-mysql 站 02 章會處理它**：

> **MySQL 的 `TIMESTAMP` 會做時區轉換**（存進去轉成 UTC、讀出來轉回連線時區），
> 而 `DATETIME` 不會。
> 這代表**同一份資料，在不同時區的連線上讀出來是不同的值**。
> **而 H2 上看不出差別** —— 又一個 0.5.4 的例子。
>
> 📌 **shop-service 的最終決定**（07 站 02 章）：
> **用 `DATETIME(6)` + 全部存 UTC + 應用端負責轉換**，
> 並在 JDBC URL 上釘住 `connectionTimeZone=UTC`（01 章 1.4）。

### 0.12.4 `JdbcOrderRepository`：骨架

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
import java.util.*;
import java.util.stream.Collectors;

/**
 * {@link OrderRepository} 的 JDBC 實作骨架。
 *
 * <p>⚠️ 這一版<b>刻意只做到「能跑」</b>：
 * 真正的批次、串流、動態條件、樂觀鎖的回寫，分別在 02～05 章補上。
 * 這裡要先把<b>形狀</b>釘住 —— 尤其是 {@code @Transactional(MANDATORY)}（0.9.3）。
 */
@Repository
@Transactional(propagation = Propagation.MANDATORY)   // ★★ 沒有外層交易就直接失敗
public class JdbcOrderRepository implements OrderRepository {

    private final NamedParameterJdbcTemplate jdbc;

    public JdbcOrderRepository(NamedParameterJdbcTemplate jdbc) { this.jdbc = jdbc; }

    @Override
    public String nextId() {
        // ★ 不用資料庫的 AUTO_INCREMENT —— 理由見 0.6.2 ⑯
        return "O-" + UUID.randomUUID().toString().replace("-", "").substring(0, 20);
    }

    @Override
    public void save(Order order) {
        int updated = jdbc.update("""
                UPDATE orders
                   SET status = :status, total_minor = :totalMinor, currency = :currency,
                       version = version + 1
                 WHERE id = :id AND version = :version
                """, params(order));
        if (updated == 0) {
            Integer rows = jdbc.queryForObject("SELECT COUNT(*) FROM orders WHERE id = :id",
                    new MapSqlParameterSource("id", order.id()), Integer.class);
            if (rows != null && rows > 0) {
                // ⚠️ 有這一列、但 version 對不上 → 有人在你讀出來之後改過它
                throw new OptimisticLockingFailureException(
                        "訂單 " + order.id() + " 已被其他交易修改（預期 version=" + order.version() + "）");
            }
            insert(order);
        }
    }

    private void insert(Order order) {
        jdbc.update("""
                INSERT INTO orders (id, customer_id, status, total_minor, currency, created_at, version)
                VALUES (:id, :customerId, :status, :totalMinor, :currency, :createdAt, :version)
                """, params(order));

        List<SqlParameterSource> lines = new ArrayList<>();
        for (int i = 0; i < order.lines().size(); i++) {
            OrderLine line = order.lines().get(i);
            lines.add(new MapSqlParameterSource()
                    .addValue("orderId", order.id())
                    .addValue("lineNo", i + 1)
                    .addValue("productId", line.productId())
                    .addValue("quantity", line.quantity())
                    .addValue("unitPriceMinor", line.unitPrice().minorUnits())
                    .addValue("currency", line.unitPrice().currency().getCurrencyCode()));
        }
        jdbc.batchUpdate("""
                INSERT INTO order_line (order_id, line_no, product_id, quantity, unit_price_minor, currency)
                VALUES (:orderId, :lineNo, :productId, :quantity, :unitPriceMinor, :currency)
                """, lines.toArray(SqlParameterSource[]::new));
    }

    @Override
    public void saveAll(Collection<Order> orders) {
        orders.forEach(this::save);   // ⚠️ 05 章 5.8 會換成真的批次（這裡先是 N 次來回）
    }

    @Override
    public Optional<Order> findById(String orderId) {
        return load("SELECT * FROM orders WHERE id = :id",
                    new MapSqlParameterSource("id", orderId)).stream().findFirst();
    }

    @Override
    public Optional<Order> findByIdVisibleTo(String orderId, Actor actor) {
        // ★ 授權寫進 WHERE，而不是查出來再 if（0.11.8）
        String sql = actor.isStaff()
                ? "SELECT * FROM orders WHERE id = :id"
                : "SELECT * FROM orders WHERE id = :id AND customer_id = :customerId";
        return load(sql, new MapSqlParameterSource("id", orderId)
                .addValue("customerId", actor.userId())).stream().findFirst();
    }

    @Override
    public List<Order> findExpiredPendingPayment(Instant now, int limit) {
        return load("""
                SELECT * FROM orders
                 WHERE status = 'PENDING_PAYMENT' AND created_at < :deadline
                 ORDER BY created_at, id
                 LIMIT :limit
                """, new MapSqlParameterSource("deadline", Timestamp.from(now)).addValue("limit", limit));
    }

    @Override
    @Transactional(propagation = Propagation.MANDATORY, readOnly = true)
    public long countByCustomerId(String customerId) {
        Long n = jdbc.queryForObject("SELECT COUNT(*) FROM orders WHERE customer_id = :cid",
                new MapSqlParameterSource("cid", customerId), Long.class);
        return n == null ? 0L : n;
    }

    /** ★ 兩個 ResultSet 拼成聚合：先查頭，再用 IN 一次撈所有明細（不是每張訂單各查一次）。 */
    private List<Order> load(String headSql, SqlParameterSource params) {
        List<OrderRow> heads = jdbc.query(headSql, params, OrderRow.mapper());
        if (heads.isEmpty()) return List.of();

        Map<String, List<OrderLineRow>> linesByOrder = jdbc.query(
                        "SELECT * FROM order_line WHERE order_id IN (:ids) ORDER BY order_id, line_no",
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

    private SqlParameterSource params(Order order) {
        return new MapSqlParameterSource()
                .addValue("id", order.id())
                .addValue("customerId", order.customerId())
                .addValue("status", order.status().name())
                .addValue("totalMinor", order.total().minorUnits())
                .addValue("currency", order.total().currency().getCurrencyCode())
                .addValue("createdAt", Timestamp.from(order.createdAt()))
                .addValue("version", order.version());
    }
}
```

**這個骨架刻意留下的五個問題（分別在後面的章節處理）**：

| # | 問題 | 哪一章 |
|---|---|---|
| ① | `save()` 先 UPDATE 再判斷 —— 新單一定會多一次無效的 UPDATE | 02 章 2.8（`INSERT … ON DUPLICATE KEY` / MERGE 的取捨） |
| ② | `saveAll()` 是 N 次來回，不是批次 | 05 章 5.8 |
| ③ | `save()` 之後，記憶體裡的 `Order.version` 已經過期 | 05 章 5.5 |
| ④ | `LIMIT :limit` 的具名參數在某些資料庫上不支援 | 02 章 2.6 |
| ⑤ | 明細是「全刪重插」還是「逐筆比對」——目前**兩者都不是**（只在 insert 時寫） | 03 章 3.7 |

⚠️ **⑤ 是一個真的 bug，而它現在【沒有】被契約測試抓到** ——
因為契約測試裡沒有「改了明細再 save」的案例。**這是本章練習 3 的題目。**

**`OrderRow` / `OrderLineRow`（package-private，0.11.3）**：

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
 * <p>理由（0.10.4 第 ④ 步）：一張訂單來自<b>兩個 ResultSet</b>
 * （orders + order_line），聚合要等兩邊都到齊才能重建。
 */
record OrderRow(String id, String customerId, OrderStatus status,
                long totalMinor, String currency, Instant createdAt, long version) {

    Money total() { return Money.ofMinorUnits(totalMinor, currency); }

    static RowMapper<OrderRow> mapper() {
        return (ResultSet rs, int rowNum) -> new OrderRow(
                rs.getString("id"),
                rs.getString("customer_id"),
                OrderStatus.valueOf(rs.getString("status")),
                rs.getLong("total_minor"),
                rs.getString("currency"),
                rs.getTimestamp("created_at").toInstant(),
                rs.getLong("version"));
    }
}

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

⚠️ **`OrderStatus.valueOf(rs.getString("status"))` 有一個已知的脆弱點**：
資料庫裡如果有一個程式碼裡不存在的狀態（例如舊版留下的 `COMPLETED`），
它會拋 `IllegalArgumentException`，而訊息是 `No enum constant …`——
**看起來像程式 bug，其實是資料問題**。**02 章 2.9 會給一個更好的 `RowMapper`。**

### 0.12.5 六組 ArchUnit 守門規則

```java
package example.shop.architecture;

import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.core.domain.JavaMethod;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.core.importer.ImportOption;
import com.tngtech.archunit.lang.ArchCondition;
import com.tngtech.archunit.lang.ConditionEvents;
import com.tngtech.archunit.lang.SimpleConditionEvent;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.classes;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;

class DataAccessArchitectureTest {

    static JavaClasses classes;

    @BeforeAll
    static void importClasses() {
        classes = new ClassFileImporter()
                .withImportOption(ImportOption.Predefined.DO_NOT_INCLUDE_TESTS)
                .importPackages("example.shop");
    }

    @Test
    void 規則1_domain不可認識任何持久化技術() {
        noClasses().that().resideInAPackage("..order.domain..")
                .should().dependOnClassesThat().resideInAnyPackage(
                        "java.sql..", "javax.sql..", "org.springframework.jdbc..",
                        "jakarta.persistence..", "org.hibernate..")
                .because("領域物件要能在沒有資料庫的情況下被測試（05-service 00 章 0.11.2 的同一條規則）")
                .check(classes);
    }

    @Test
    void 規則2_application不可依賴infrastructure() {
        noClasses().that().resideInAPackage("..order.application..")
                .should().dependOnClassesThat().resideInAPackage("..order.infrastructure..")
                .because("依賴方向永遠是 infrastructure → application，反過來就是把埠與轉接器接反了")
                .check(classes);
    }

    @Test
    void 規則3_只有persistence套件可以碰JDBC() {
        noClasses().that().resideOutsideOfPackage("..infrastructure.persistence..")
                .should().dependOnClassesThat().resideInAnyPackage(
                        "org.springframework.jdbc..", "java.sql..", "javax.sql..")
                .because("SQL 一旦洩漏到 application 或 web，換實作就不再是換一個類別的事")
                .check(classes);
    }

    @Test
    void 規則4_沒有人可以自己開連線() {
        noClasses().should().callMethodWhere(
                        com.tngtech.archunit.core.domain.JavaCall.Predicates.target(
                                com.tngtech.archunit.core.domain.properties.HasOwner.Predicates.With.owner(
                                        com.tngtech.archunit.base.DescribedPredicate.describe(
                                                "java.sql.DriverManager",
                                                c -> c.getName().equals("java.sql.DriverManager")))))
                .because("繞過連線池的連線不會被監控、不會被限流、也不會被歸還（01 章）")
                .check(classes);
    }

    @Test
    void 規則5_Repository實作的每個public方法都要求外層交易() {
        classes().that().resideInAPackage("..infrastructure.persistence..")
                .and().haveSimpleNameEndingWith("Repository")
                .should(new ArchCondition<>("標 @Transactional(propagation = MANDATORY)") {
                    @Override
                    public void check(com.tngtech.archunit.core.domain.JavaClass item, ConditionEvents events) {
                        Transactional onClass = item.reflect().getAnnotation(Transactional.class);
                        boolean classOk = onClass != null && onClass.propagation() == Propagation.MANDATORY;
                        if (!classOk) {
                            events.add(SimpleConditionEvent.violated(item,
                                    item.getName() + " 沒有 @Transactional(propagation = MANDATORY)"));
                            return;
                        }
                        for (JavaMethod m : item.getMethods()) {
                            if (!m.getModifiers().contains(
                                    com.tngtech.archunit.core.domain.JavaModifier.PUBLIC)) continue;
                            Transactional onMethod = m.reflect().getAnnotation(Transactional.class);
                            if (onMethod != null && onMethod.propagation() != Propagation.MANDATORY) {
                                events.add(SimpleConditionEvent.violated(m,
                                        m.getFullName() + " 用了 " + onMethod.propagation()
                                                + "，會自己開一個交易（0.9.3）"));
                            }
                        }
                    }
                })
                .because("交易邊界屬於 Service；Repository 只能參加別人開好的交易")
                .check(classes);
    }

    @Test
    void 規則6_埠的簽章不可洩漏持久化型別() {
        noClasses().that().resideInAPackage("..application.port..")
                .should().dependOnClassesThat().resideInAnyPackage(
                        "java.sql..", "org.springframework.jdbc..", "org.springframework.data..")
                .because("埠是 application 對外提的問題，換成 MyBatis 或 HTTP 都不該改它")
                .check(classes);
    }
}
```

**每一條規則在防什麼**：

| 規則 | 防的事故 | 沒有它會怎樣 |
|---|---|---|
| 1 domain 不碰持久化 | — | 領域測試需要資料庫，跑一次 30 秒 |
| 2 application 不依賴 infrastructure | — | 埠與轉接器接反，換實作要改 Service |
| 3 只有 persistence 碰 JDBC | 事故 1、2 | Controller 裡出現 `jdbcTemplate.query(...)` |
| 4 沒有人自己開連線 | **事故 2** | 連線洩漏 |
| 5 Repository 都是 MANDATORY | **事故 3** | 孤兒訂單 |
| 6 埠不洩漏持久化型別 | — | 08 站換 JPA 時要改 Service |

⚠️ **規則 6 有一個要注意的地方**：它禁止 `org.springframework.data..`，
**而 0.7.2 的 `OrderQueryDao` 用了 `Page` 與 `Pageable`** ——
也就是說，**只要你把 `OrderQueryDao` 加進專案，這條規則就會紅**
（0.6 判準 7 也說過「`Pageable` 通常可以接受」）。

> 📌 **這是一個刻意的、暫時的嚴格**：
> **00 章先禁止，等 04 章討論完分頁的取捨之後，
> 再決定要不要在規則裡開一個具名的例外**（並在 `because` 裡寫下理由）。
> 三個選項與代價見 **0.7.2 的表**。
>
> ⚠️ **不要用 `allowEmptyShould(true)` 或直接刪規則來「解決」衝突** ——
> 05 站 00 章 0.11.2 已經講過那個反模式：
> **例外要具名、要有理由、要能被搜尋到。**

### 0.12.6 這六條規則真的會紅嗎？

**05 站 07 章 7.17 的原則：「一條從來沒紅過的守門測試等於沒有。」**

**本章刻意植入三個違規（它們會踩到四條規則），實測結果**：

| 植入的違規 | 結果 |
|---|---|
| 在 `Order` 加一個回傳 `java.sql.Timestamp` 的方法 | 🔴 **規則 1 紅**（違規 2 次）、**規則 3 紅** |
| 把 `JdbcOrderRepository` 改成 `Propagation.REQUIRED` | 🔴 **規則 5 紅** |
| 在 `nextId()` 裡呼叫 `DriverManager.getLoginTimeout()` | 🔴 **規則 4 紅** |

```
[ERROR] Tests run: 6, Failures: 4, Errors: 0
Architecture Violation [Priority: MEDIUM] - Rule 'no classes that reside in a package '..order.domain..'
should depend on classes that reside in any package ['java.sql..', …],
because 領域物件要能在沒有資料庫的情況下被測試…' was violated (2 times)

Architecture Violation [Priority: MEDIUM] - Rule 'classes that reside in a package
'..infrastructure.persistence..' and have simple name ending with 'Repository' should
標 @Transactional(propagation = MANDATORY), because 交易邊界屬於 Service…' was violated (1 times)
```

**移除違規後**：

```
[INFO] Tests run: 6, Failures: 0, Errors: 0 -- in DataAccessArchitectureTest
```

⚠️ **一個誠實的但書：這次驗證跑的是【00 章的程式碼】** ——
`OrderRepository`、`Order`、`Money`、`JdbcOrderRepository`、`InMemoryOrderRepository`。
**`OrderQueryDao`（0.7.2）還沒有加進去**，因為它的內容屬於 04 章。
**加進去之後規則 6 會紅**，理由與三個選項見 0.7.2。

### 0.12.7 `application.yml`（資料層相關）

```yaml
spring:
  datasource:
    url: jdbc:mysql://localhost:3306/shop?useSSL=false&characterEncoding=utf8mb4&connectionTimeZone=UTC&rewriteBatchedStatements=true
    username: ${DB_USER}
    password: ${DB_PASSWORD}
    hikari:
      # ⚠️ 這些數字在 01 章會有完整的計算過程，這裡先給「有理由的預設值」
      maximum-pool-size: 10        # ★ 不是越大越好（0.9.1 的但書、01 章 1.6）
      minimum-idle: 10             # ★ 與 max 相同 —— 固定大小的池比較好推理
      connection-timeout: 3000     # 等不到連線就失敗（≠ 查詢逾時）
      validation-timeout: 1000
      idle-timeout: 0              # minimum-idle == maximum-pool-size 時無作用
      max-lifetime: 1740000        # 29 分鐘：★ 必須小於資料庫的 wait_timeout
      leak-detection-threshold: 20000   # ★ 借出超過 20 秒沒還 → 印出借用者的堆疊
      pool-name: shop-pool

  jpa:
    open-in-view: false            # ★ 05 站 03 章 3.9.4 的四個理由

  sql:
    init:
      mode: always                 # ⚠️ 只給開發與測試；正式環境用 Flyway（07 站 08 章）
      schema-locations: classpath:schema.sql

logging:
  level:
    org.springframework.jdbc.core.JdbcTemplate: DEBUG          # 看 SQL
    org.springframework.jdbc.core.StatementCreatorUtils: TRACE  # 看參數值
```

⚠️ **四個「現在先照抄、後面會解釋」的設定**：

| 設定 | 為什麼現在就要有 | 哪一章解釋 |
|---|---|---|
| `leak-detection-threshold: 20000` | **它會直接印出「誰借了沒還」的堆疊** —— 事故 2 的診斷工具 | 01 章 1.9 |
| `max-lifetime` < 資料庫 `wait_timeout` | 不然池裡會有「已經被伺服器關掉」的死連線 | 01 章 1.7 |
| `rewriteBatchedStatements=true` | MySQL 驅動預設**不會**真的批次 —— 沒有它，`batchUpdate` 仍然是 N 次來回 | 05 章 5.8 |
| `minimum-idle` == `maximum-pool-size` | 固定大小的池，行為好預測、也不會在流量尖峰時才去建連線 | 01 章 1.6 |

---

## 0.13 這一站的七章地圖

| 章 | 主題 | 核心問題 | 產出 |
|---|---|---|---|
| **00**（本章） | 資料層定位 | **邊界在哪、介面該長什麼樣** | 埠、`schema.sql`、骨架、契約測試、六組 ArchUnit |
| **01** | DataSource 與連線池 | **連線用完了怎麼辦** | JDBC URL 的 12 個參數、HikariCP 完整設定、池大小公式、洩漏診斷 |
| **02** ★ | JDBC 與 JdbcTemplate | **SQL 怎麼寫才安全又不重複** | `RowMapper`、具名參數、`JdbcClient`、例外翻譯、原子 UPDATE 的完整實作 |
| **03** | Spring Data 抽象 | **那些沒有實作的介面是怎麼跑起來的** | `Repository` 家族、命名查詢規則、`@Query`、投影、動態代理的原理 |
| **04** | 分頁、排序與動態查詢 | **翻到第 5,000 頁為什麼會慢** | `Page` / `Slice`、`Sort` 白名單、`Specification`、keyset 分頁、查詢次數守門測試 |
| **05** ★ | 交易邊界與批次 | **一次寫 10 萬筆要怎麼寫** | 傳播的實務組合、`readOnly` 路由、批次、串流、樂觀鎖回寫 |
| **06** | 資料層測試 | **H2 上綠燈可以信嗎** | `@DataJpaTest`、H2 vs MySQL 的差異清單、Testcontainers、測試資料的準備與清理 |

**依賴關係**：

```
00（觀念、埠、schema、骨架）
 ├─→ 01（連線池：所有查詢的前提）
 │    └─→ 02 ★ JdbcTemplate（實作的主體）
 │         ├─→ 03 Spring Data（另一種寫法，對照 02）
 │         │    └─→ 04 分頁與動態查詢
 │         └─→ 05 ★ 交易邊界與批次
 └─→ 06 測試（讀完 02 與 05 再讀效果最好）
```

⚠️ **如果你時間有限**：
**02 是實作的核心，05 是最容易出事的一章。**
**01 是唯一「上線後半夜會叫你起床」的一章** —— 它的內容最少，但故障率最高。

---

## 0.14 回頭修正 05-service 的六處

04-controller 與 05-service 站的做法是「後面的章節修正前面的，每一處標理由」。這一站沿用。

### 0.14.1 `Order` 需要 `version` 與 `rehydrate()`

**位置**：05-service 00 章 0.9.2

```java
// ── 修正前（05-service 站）────────────────────────────────
public final class Order {
    private final String id;
    private final String customerId;
    private OrderStatus status;
    // …沒有 version

    public static Order place(String id, String customerId, …) { … }
    // …只有 place()
}
```

```java
// ── 修正後（06 站 00 章 0.12.2）────────────────────────────
public final class Order {
    private final String id;
    private final String customerId;
    private OrderStatus status;
    private final long version;                     // ★ 新增

    public static Order place(…, Instant now) { … }             // 新單，version = 0

    /** ★ 新增：從資料庫重建 —— 不做業務驗證，但做不變量檢查。 */
    public static Order rehydrate(String id, String customerId, OrderStatus status,
                                  List<OrderLine> lines, Money total,
                                  Instant createdAt, long version) { … }
}
```

**理由**：

| 為什麼 05 站沒有 | 為什麼 06 站需要 |
|---|---|
| fake 存的就是物件本身，沒有「重建」這件事 | JDBC 一定要從兩個 ResultSet 重建（0.10.4） |
| 沒有真的併發，樂觀鎖沒有意義 | I5 狀態機的併發保護需要它（0.8.7 做法 A） |

> ⚠️ **`version` 進入 `Order` 是一個有爭議的決定** ——
> 它是**持久化的概念**，出現在領域物件上等於一個洩漏（0.5.1 的第 11 個）。
> **另一個選項**是把它包在 `Persisted<Order>` 之類的包裝型別裡。
> **shop-service 選擇讓它進來**，理由是包裝型別會讓每一個呼叫端都多一層解包，
> **而代價（一個 `long` 欄位）比那個成本小**。
> **05 章 5.5 會重新評估這個決定。**

### 0.14.2 `OrderRepository` 需要 `nextId()`

**位置**：05-service 00 章 0.12 ⑩

05 站的 `OrderApplicationService.create()` 裡有一行：

```java
// ── 修正前 ────────────────────────────────────────────
String orderId = idGenerator.newOrderId();          // ★ 一個獨立的 IdGenerator 埠
```

```java
// ── 修正後 ────────────────────────────────────────────
String orderId = orders.nextId();                   // ★ 併進 OrderRepository
```

**理由**：**id 的產生方式與儲存方式是綁在一起的決定**（0.6.2 ⑯ 的表）。
分成兩個埠，會讓「改用資料庫序號」變成要同時改兩個地方，
而且**沒有任何一個地方寫著「這兩個決定必須一致」**。

⚠️ **但 05 站 01 章 1.4.6「把不確定性注入進來」的原則仍然成立** ——
`nextId()` 在測試裡仍然是可控的（fake 回 `O-MEM-1`、`O-MEM-2`…）。

### 0.14.3 `InMemoryOrderRepository` 必須深拷貝

**位置**：05-service 07 章 7.8.4

```java
// ── 修正前 ────────────────────────────────────────────
@Override public void save(Order order)             { store.put(order.id(), order); }
@Override public Optional<Order> findById(String id) { return Optional.ofNullable(store.get(id)); }
```

```java
// ── 修正後（0.10.2 的契約測試逼出來的）────────────────────
@Override
public synchronized void save(Order order) {
    Snapshot existing = store.get(order.id());
    if (existing != null && existing.version() != order.version()) {
        throw new OptimisticLockingFailureException(…);      // ★ 連樂觀鎖都要模擬
    }
    long next = existing == null ? order.version() : existing.version() + 1;
    store.put(order.id(), new Snapshot(copyOf(order, next), next));
}

@Override
public Optional<Order> findById(String orderId) {
    return Optional.ofNullable(store.get(orderId)).map(s -> copyOf(s.order(), s.version()));
}
```

**理由**：E4 實測 —— 不深拷貝的 fake 會讓「忘記 `save()`」的程式碼**通過測試**。

⚠️ **注意連 `OptimisticLockingFailureException` 都要模擬。**
**這是「fake 的成本」的具體樣子**：
fake 越像真的，它抓得到的 bug 越多，維護成本也越高。
**判準是 0.10.2 的契約 —— 契約要求的，fake 就要有；契約沒要求的，不用。**

### 0.14.4 `OrderRepository.search()` 搬到 `OrderQueryDao`

**位置**：05-service 07 章 7.8.4

05 站的 fake 對 `search()` 拋 `UnsupportedOperationException`，並註解說
「它的排序與分頁語意與 SQL 不同」。

> 📌 **那個 `UnsupportedOperationException` 是一個【設計訊號】，而 05 站當時只當成一個限制。**
> **一個 fake 做不到的方法，通常代表它不屬於這個介面。**

```java
// ── 修正後 ────────────────────────────────────────────
// OrderRepository：拿掉 search()
// OrderQueryDao（新的埠，0.7.2）：
Page<OrderSummary> search(OrderSearchCriteria criteria, Pageable pageable);
```

**連帶的三個好處**：

1. `InMemoryOrderRepository` **不再需要那個 `UnsupportedOperationException`** —— 它現在是完整的。
2. `search` 回**投影**而不是聚合（判準 3）。
3. 列表的測試改用真的資料庫（因為分頁與排序的語意就是資料庫的語意）。

### 0.14.5 不變量表的 ④ 要拆成 ④a / ④b

**位置**：05-service 00 章 0.8.3

**理由**：0.8.2 的實測 —— `CHECK` 約束在 lost update 下**一次都沒有觸發**。

**修正後的表在 0.8.5。**

### 0.14.6 `StockPort.tryReserve` 的回傳語意要寫進 javadoc

**位置**：05-service 00 章 0.12 ⑩

```java
// ── 修正後 ────────────────────────────────────────────
public interface StockPort {

    /**
     * 原子的「檢查 + 扣減」。
     *
     * <p>★★ 實作<b>必須</b>是單一語句的條件式 UPDATE：
     * <pre>{@code
     * UPDATE stock SET qty = qty - :qty WHERE pid = :pid AND qty >= :qty
     * }</pre>
     * 並以<b>影響筆數</b>作為回傳值（{@code rows == 1}）。
     *
     * <p>⚠️ <b>不可以</b>實作成「先 SELECT 再 UPDATE」——
     * 06 站 00 章 0.8.1 的實測顯示那樣在 20 個併發下會賣出 15～18 個庫存（總量 10），
     * <b>而且資料庫裡的數字看起來完全正常</b>。
     *
     * @return false = 庫存不足（<b>不是</b>「商品不存在」——那也回 false，
     *         因為呼叫端在這一步不需要區分；要區分請用 {@link #snapshot}）
     */
    boolean tryReserve(String productId, int quantity);
}
```

**理由**：05 站寫了「原子的檢查 + 扣減」，但**沒有寫下「怎樣算實作正確」**。
而 0.8.1 的實測顯示：**錯誤的實作不會有任何症狀**，
所以這個要求必須寫成**實作者看得到的契約**，並配一個併發測試（02 章 2.11）。

---

## 0.15 常見誤區

**誤區 1：「Repository 就是把 SQL 集中放的地方」**

→ 0.4.2。真正的價值是**定義上層能問什麼問題**。
一個 `query(String sql, Object... args)` 方法什麼都沒有隔離。

**誤區 2：「加了資料庫約束就安全了」**

→ 0.8.2 實測：`CHECK (qty >= 0)` 在 5 輪 20 併發裡**一次都沒有觸發**，
而 14～19 個人搶到了 10 個庫存。
**約束是「值」的守門人，不是「過程」的守門人。**

**誤區 3：「H2 測過就等於 MySQL 會過」**

→ 0.5.4：深分頁在 H2 上量不出成本；N+1 在 H2 上只差 1.3 倍。
**H2 上的效能結論不能搬，行為結論要逐條驗**（06 章有完整清單）。

**誤區 4：「`@Transactional` 加在 Repository 上比較保險」**

→ 0.9.2 實測：那會讓「建單 + 扣庫存」變成兩個交易，失敗時留下孤兒訂單。
**保險的做法是 `MANDATORY`：沒有外層交易就直接失敗。**

**誤區 5：「Repository 回傳 Entity，Service 再轉 DTO 就好」**

→ 對「寫路徑」是對的（要拿聚合去改）。
**對「讀路徑」是錯的**（0.7）—— 列表要 20 個完整聚合，
會變成 1 + 20 + 20 次查詢，而且列表要顯示的欄位有一半不在聚合裡。

**誤區 6：「fake 太簡單了，不如直接用真的資料庫測」**

→ 0.10.5 實測：同一組 9 條契約，fake 跑 **0.010 秒**，JDBC 跑 **0.276 秒**（27 倍）。
在 300 條 Service 單元測試上，那是 **3 秒 vs 83 秒**。
**兩者都要有 —— fake 給速度，契約測試給正確性。**

**誤區 7：「`findAll()` 只是個方便的方法，資料量小的時候沒差」**

→ 0.11.7。問題不是「今天的資料量」，是**它會被留在程式碼裡**。
三年後那張表有 3,000 萬筆，而那行程式碼還在。

**誤區 8：「用了 `PreparedStatement` 就不會被 SQL Injection」**

→ 0.11.4：**欄位名與排序方向不能參數化**。
`ORDER BY " + sort` 是實務上最常見的殘留洞，解法是**對照表**而不是字串檢查。

**誤區 9：「JPA 會幫我處理這些，所以這一站可以跳過」**

→ 0.10.3 的表：JPA 會讓「忘記 `save()`」這類 bug **消失**（dirty checking），
而那讓你更難察覺它。**JPA 改變的是症狀，不是問題。**
而 08 站要處理的問題（N+1、Lazy、持久化情境）**都建立在這一站的概念上**。

**誤區 10：「先寫好、之後再調效能」**

→ 0.3.4：資料層的錯誤在**單機、低流量、小資料量下都是對的**。
「之後再調」的前提是「之後看得出來」，而 N+1、lost update、連線洩漏
**在開發環境全部看不出來**。

**誤區 11：「交易越長越安全，包大一點總沒錯」**

→ 0.9.1 實測：交易期間連線 `active=1` 是**整段時間**，包括你 sleep 的 200 ms。
`最大 TPS ≈ 池大小 ÷ 交易長度`，交易裡多一個 300 ms 的外部呼叫，吞吐直接腰斬。

**誤區 12：「這個查詢只有我用，直接寫在 Service 裡就好」**

→ ArchUnit 規則 3 會紅。而理由不是潔癖：
**那行 `jdbcTemplate.query(...)` 會讓那個 Service 從此需要資料庫才能測**，
而它的 20 條單元測試會從 0.5 秒變成 15 秒。

---

## 0.16 本章練習

### 練習 1：評審 12 個方法簽章

**下面每一個方法都是真實專案裡出現過的。**
用 0.6 的七個判準判斷：**進 / 不進 / 改成什麼**，並說出**它會邀請什麼樣的錯誤寫法**。

```java
public interface CustomerRepository {
    ① List<Customer> findAll();
    ② Customer findByEmail(String email);
    ③ List<Customer> findByLevel(String level);
    ④ void updateLevel(String customerId, String level);
    ⑤ boolean existsByEmail(String email);
    ⑥ List<Customer> search(String keyword);
}

public interface CouponRepository {
    ⑦ Optional<Coupon> findByCode(String code);
    ⑧ void incrementUsedCount(String code);
    ⑨ int getUsedCount(String code);
    ⑩ List<Coupon> findAvailableFor(String customerId, BigDecimal orderAmount);
    ⑪ void save(Coupon coupon);
    ⑫ List<Coupon> findByExpiresAtBefore(Instant deadline);
}
```

<details>
<summary>參考答案</summary>

| # | 判決 | 理由（判準） | 它邀請的錯誤寫法 |
|---|---|---|---|
| ① | 🔴 不進 | 判準 6 | `for (Customer c : findAll())` → OOM（事故 4） |
| ② | 🔴 改 | 判準 4：回 `Optional<Customer>` | `findByEmail(e).getName()` → NPE |
| ③ | 🔴 改 | 判準 6：沒有上限。改 `findByLevel(String level, int limit)`，或走 QueryDao | 「金卡會員只有幾百人」→ 三年後有 40 萬 |
| ④ | 🔴 不進 | 0.4.3：繞過聚合的規則（升等要記錄時間、要發通知） | `updateLevel(id, "GOLD")` 直接改，稽核查不到誰改的 |
| ⑤ | ⚠️ 可進，但**不可用來擋重複註冊** | 0.8.4：`exists` + `insert` 是「先查再寫」 | 併發下兩個人同時註冊同一個 email → 要靠 UNIQUE |
| ⑥ | 🔴 改 | 判準 3、6：搜尋回投影、要分頁 → `Page<CustomerSummary> search(Criteria, Pageable)`，且**在 QueryDao** | 搜尋「a」回傳 40 萬個完整聚合 |
| ⑦ | ✅ 進 | 判準 4 | — |
| ⑧ | 🔴 **改成 `boolean tryConsume(String code)`** | 0.8.3：`incrementUsedCount` 沒有上限檢查，**而檢查一定會被寫在呼叫端** → I2 被破壞 | `if (getUsedCount(c) < total) incrementUsedCount(c)` → 超發 |
| ⑨ | 🔴 不進 | 判準 6：它存在的唯一用途就是 ⑧ 那個錯誤寫法 | 同上 |
| ⑩ | ⚠️ **看情況** | 「哪些券可用」是**業務規則**（0.11.2）。若規則是「未過期、未用完、金額門檻」→ 可以進（都是資料條件）；若含「這個客戶的等級、這個活動的排他性」→ 🔴 應該在 Domain | 折扣規則悄悄分成兩份（SQL 一份、Java 一份） |
| ⑪ | ✅ 進 | — | — |
| ⑫ | 🔴 改 | 判準 6：沒有上限、沒有排序 → `findExpiring(Instant deadline, int limit)` 且 `ORDER BY expires_at, code`（洩漏 ⑤） | 排程每次跑都拿到不同的一批，有些券永遠處理不到 |

**⑤ 值得特別注意**：它本身是一個合理的方法（註冊表單即時檢查「這個 email 已被使用」），
**但它不能當成正確性的保證**。
📌 **一個好用的說法**：**`exists…` 這種方法的答案，在你讀到它的下一奈秒就可能過期。**
它適合「給使用者友善提示」，不適合「決定要不要寫入」。

</details>

---

### 練習 2：找出這段 Repository 的 11 個問題

```java
@Repository
public class ProductRepository {

    @Autowired private JdbcTemplate jdbc;

    @Transactional
    public List<Product> findByCategory(String category, String sort) {
        String sql = "select * from product where category = '" + category + "'";
        if (sort != null) {
            sql += " order by " + sort;
        }
        return jdbc.query(sql, (rs, i) -> {
            Product p = new Product();
            p.setId(rs.getString("id"));
            p.setName(rs.getString("name"));
            p.setPrice(rs.getDouble("price"));
            p.setStock(rs.getInt("stock"));
            return p;
        });
    }

    public void deductStock(String productId, int qty) {
        Integer stock = jdbc.queryForObject(
                "select stock from product where id = ?", Integer.class, productId);
        if (stock == null || stock < qty) {
            throw new RuntimeException("庫存不足：" + productId);
        }
        jdbc.update("update product set stock = ? where id = ?", stock - qty, productId);
    }

    public Product findById(String id) {
        try {
            return jdbc.queryForObject("select * from product where id = ?",
                    (rs, i) -> { … }, id);
        } catch (Exception e) {
            return null;
        }
    }

    public List<Product> findAllForExport() {
        return jdbc.query("select * from product", mapper);
    }
}
```

<details>
<summary>參考答案（11 個）</summary>

| # | 問題 | 對應小節 | 後果 |
|---|---|---|---|
| 1 | `category` 拼進 SQL | 0.11.4 | SQL Injection（事故 1） |
| 2 | `sort` 直接拼進 `ORDER BY` | 0.11.4 | 同上，而且**是最常被漏掉的那個洞** |
| 3 | `sort` 沒有第二排序鍵 | 0.5.1 ⑤ | 分頁時同一筆出現兩次或消失 |
| 4 | `@Transactional` 在 Repository 上 | 0.9 | 各自開交易 → 沒有原子性（事故 3） |
| 5 | `findByCategory` 沒有筆數上限 | 0.11.7 | 熱門分類 30 萬筆 → OOM |
| 6 | `price` 用 `double` | 0.12.2 | 金額精度錯誤，對帳差幾分錢 |
| 7 | `Product` 有 setter（貧血 + 可變） | 05 站 00 章 0.5 | 任何人可以繞過規則改價格 |
| 8 | `deductStock` 先查再寫 | **0.8.1** | 併發下超賣，而**資料庫的數字看起來正常** |
| 9 | `deductStock` 拋 `RuntimeException` | 0.11.5、05 站 04 章 | Controller 對不到狀態碼 → 500 → 前端盲重試 |
| 10 | `findById` 用 `catch (Exception) { return null; }` | 0.11.5 | **連線失敗與「查無資料」變成同一個結果** —— 最危險的一種吞例外 |
| 11 | `findAllForExport` 回 `List` | 0.11.7 | OOM（事故 4）。應改成 `Consumer<Product>` 串流 |

**加分題：第 10 個問題為什麼比第 9 個嚴重？**

> 因為它讓**基礎設施的故障**偽裝成**業務上的正常結果**。
> 資料庫斷線時，`findById` 回 `null` → 上層以為「這個商品不存在」→
> 可能去建立一筆新的、或者把訂單標記為無效。
> **而錯誤日誌裡什麼都沒有。**

</details>

---

### 練習 3：找出 0.12.4 骨架裡的靜默 bug ★

**0.12.4 的 `JdbcOrderRepository` 有一個 bug，而 0.10.2 的九條契約測試【全部是綠的】。**

**(a)** 找出它。
**(b)** 寫一條會抓到它的契約測試。
**(c)** 這條測試在 **fake** 上是紅的還是綠的？為什麼？這件事說明了什麼？
**(d)** 修好它，並說出你選的做法有什麼代價。

<details>
<summary>參考答案</summary>

**(a)** `save()` 在「這張訂單已經存在」的路徑上，**只 UPDATE 了 `orders` 這張表**，
**完全沒有碰 `order_line`**。明細只在 `insert()` 裡被寫入一次。

> 🔴 **後果**：任何「修改明細」的操作（刪一筆、改數量）都會**靜默地不生效** ——
> 沒有例外、沒有日誌，`save()` 回傳正常。

**(b)** 加一條契約（需要 `Order` 有一個修改明細的操作）：

```java
// Order 新增（本練習用）：
public void removeLine(String productId) {
    if (status != OrderStatus.PENDING_PAYMENT) throw new IllegalStateException("只有待付款可以改明細");
    List<OrderLine> kept = lines.stream().filter(l -> !l.productId().equals(productId)).toList();
    if (kept.isEmpty()) throw new IllegalStateException("訂單至少要有一筆明細");
    lines = kept;
}

// 契約測試新增：
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
}
```

**(c)** ⚠️⚠️ **在 fake 上是【綠】的，在 JDBC 上是【紅】的。**（本章實測）

```
[INFO] Tests run: 10, Failures: 0 -- in InMemoryOrderRepositoryTest
[ERROR] Tests run: 10, Failures: 1 -- in JdbcOrderRepositoryContractTest
[ERROR]   改了明細再存回去查出來是新的明細:154 [刪掉的明細不該還在]
          Expected size: 1 but was: 2
```

**因為 fake 存的是整個 `Order` 物件的快照** —— 明細跟著一起存了。
**而 JDBC 實作是「一張訂單 = 兩張表」，兩張表要分別維護。**

> 📌 **這說明了三件事**：
> 1. **fake 會隱藏一整類 bug** —— 凡是「聚合對應多張表」造成的 bug，fake 都看不到。
> 2. **契約測試的價值正是在這裡** —— 同一條測試跑在兩個實作上，**差異立刻顯形**。
> 3. ⚠️ **而如果只跑 fake，你會以為這段程式碼是對的。**
>    這是 0.10.3 那張表的第 ① 列在真實世界的樣子。

**(d)** 修法（本章實測：改完之後 fake 與 JDBC **都是 10/10 綠**）：

```java
public void save(Order order) {
    int updated = jdbc.update(""" UPDATE orders … WHERE id = :id AND version = :version """, params(order));
    if (updated == 0) {
        Integer rows = jdbc.queryForObject("SELECT COUNT(*) FROM orders WHERE id = :id", …, Integer.class);
        if (rows != null && rows > 0) throw new OptimisticLockingFailureException(…);
        insert(order);
    } else {
        // ★ 明細「全刪重插」
        jdbc.update("DELETE FROM order_line WHERE order_id = :id",
                new MapSqlParameterSource("id", order.id()));
        insertLines(order);
    }
}
```

**「全刪重插」的四個代價**：

| 代價 | 說明 |
|---|---|
| **寫入放大** | 明細沒變也會重寫 —— 20 筆明細的訂單，改個狀態就寫 21 列 |
| **鎖的範圍變大** | `DELETE` + `INSERT` 會鎖住那些列，併發改同一張單時更容易衝突 |
| **外鍵 / 稽核的連鎖** | 如果有別的表參照 `order_line`（例如出貨明細），全刪會違反外鍵 |
| **失去「哪一筆變了」的資訊** | 稽核日誌只能說「明細變了」，不能說「刪了 P-2」 |

**另一種做法是「逐筆比對（diff）」**：算出新增 / 修改 / 刪除三組，各自下語句。
**代價是複雜度**，而且要處理「怎麼判斷兩筆明細是同一筆」（`line_no` 還是 `product_id`？）。

> 📌 **03 章 3.7 會完整比較這兩種做法**，並給一個判準：
> **明細數量少（<50）且沒有別的表參照它 → 全刪重插；否則 diff。**

</details>

---

### 練習 4：為這六條不變量選守法

**針對每一條，回答三個問題**：
(a) 它是「值」的不變量還是「過程」的不變量？
(b) 該用 ①Web 驗證 / ②Domain / ③原子 SQL / ④a CHECK / ④b UNIQUE·FK 的哪幾個？
(c) 如果只用 ④a（CHECK），會發生什麼？

| # | 不變量 |
|---|---|
| A | 一個帳號的 email 全站唯一 |
| B | 使用者的錢包餘額 `>= 0` |
| C | 一張訂單的明細數量 `<= 50` |
| D | 一個活動的報名人數 `<=` 名額 |
| E | 已出貨的訂單一定有物流單號 |
| F | 折價券的面額 `>` 0 且 `<=` 5000 |

<details>
<summary>參考答案</summary>

| # | (a) 形狀 | (b) 守法 | (c) 只用 CHECK 會怎樣 |
|---|---|---|---|
| **A** | **存在性** | **④b UNIQUE**（必要）+ ⑤ `existsByEmail` 給友善提示 | CHECK 表達不了「跨列唯一」——**根本寫不出來** |
| **B** | **過程**（讀出來、算、寫回） | **③ 原子 UPDATE**（`SET balance = balance - :amt WHERE id = :id AND balance >= :amt`）+ ④a CHECK 抓 bug + ② Domain 給訊息 | 🔴 **0.8.2 的重演**：lost update 寫的每個絕對值都 `>= 0`，CHECK 不觸發，餘額卻少扣了 |
| **C** | **值**（單一聚合內） | ① Web `@Size(max=50)` + **② Domain（主場）** + ④a CHECK 需要觸發器或計數欄位 | 表達不了（CHECK 看不到「這張訂單有幾列明細」）—— 除非在 `orders` 上冗餘一個 `line_count` |
| **D** | **過程 + 有競爭** | **③ 原子 UPDATE**（`SET taken = taken + 1 WHERE id = :id AND taken < quota`）+ ④a CHECK `taken <= quota` | 🔴 同 B。而且這是**最常見的超賣變形**（活動報名、限量商品） |
| **E** | **值 + 跨欄位** | **② Domain（主場）** + ④a CHECK `(status <> 'SHIPPED' OR tracking_no IS NOT NULL)` | ✅ **這一條 CHECK 真的有效** —— 因為它檢查的是「同一列的兩個欄位」，不涉及過程 |
| **F** | **值** | ① Web + ② Domain + **④a CHECK `amount > 0 AND amount <= 500000`** | ✅ **有效** —— 純粹的值域檢查，正是 CHECK 的主場 |

**歸納出一條判準**：

> 📌 **CHECK 有效 ⟺ 這條規則只看「同一列的欄位」，而且不需要「先讀再寫」。**
>
> - E、F 符合 → CHECK 是真的守門人。
> - B、D 不符合（需要先讀） → **CHECK 只能抓 bug，不能保證正確**。
> - A 不符合（跨列） → 要用 UNIQUE。
> - C 不符合（跨表） → 只能靠 Domain，或冗餘一個計數欄位。

**加分題：D 如果活動名額是 10,000，而報名瞬間有 5,000 人併發，原子 UPDATE 會不會變成瓶頸？**

> ✅ **會。** 所有人都在搶同一列的鎖，變成**序列化**。
> 這是「熱點列」問題，標準解法有三種：
> **分片計數**（把 10,000 拆成 10 個各 1,000 的桶，隨機挑一個）、
> **預先發號**（先產生 10,000 張票，搶票 = `UPDATE … WHERE id = ? AND owner IS NULL`）、
> **佇列化**（把請求排隊，序列處理）。
> **07-mysql 站 04 章會實測熱點列的吞吐上限**，而本站 02 章會給分片計數的實作。

</details>

---

## 0.17 驗收清單

讀完本章，你應該能回答：

**觀念**

- [ ] 資料存取層的四個職責是什麼？哪一個最常被忽略？
- [ ] 「職責 ③ 提供原子性的工具」為什麼與直覺相反？舉一個「Repository 的介面決定了 Service 守不守得住規則」的例子。
- [ ] Repository 與 DAO 的心智模型差在哪？「部分更新」為什麼是分界線？
- [ ] shop-service 為什麼兩個都有？讀路徑與寫路徑的七個差別？
- [ ] 「Repository 是一個集合」這個比喻在哪四個地方是錯的？
- [ ] 抽象洩漏的十一件事各是什麼？為什麼「隱藏洩漏」比「洩漏」更危險？
- [ ] 處理洩漏的三種方式，各自適合哪一類洩漏？

**判斷**

- [ ] 七個判準各自在防哪一種事故？
- [ ] 為什麼「兩個都提供，讓呼叫端自己選」是最常見的錯誤決定？
- [ ] 什麼時候回聚合、什麼時候回投影？判準是什麼？
- [ ] 「找不到」該由誰決定是不是錯誤？有沒有例外？
- [ ] 授權為什麼要進查詢條件？「查完再濾」在分頁上會壞成什麼樣子？
- [ ] **判準 6「這個方法會邀請什麼錯誤寫法」——舉出三個例子。**
- [ ] `nextId()` 為什麼在 Repository 上？資料庫產生 id 會反過來影響什麼？

**不變量（最重要）**

- [ ] **為什麼加了 `CHECK (qty >= 0)` 之後，20 個人仍然搶到了 10 個庫存，而約束一次都沒有觸發？**
- [ ] 「剩餘 0」為什麼比「剩餘 -8」更難發現？
- [ ] 原子 UPDATE 的三個關鍵是什麼？少了第三個會怎樣？
- [ ] 為什麼唯一索引擋得住重複下單，而 CHECK 擋不住超賣？
- [ ] ④a 與 ④b 的差別是什麼？判準是什麼？
- [ ] CHECK 既然擋不住併發，為什麼還要寫？（三個理由）
- [ ] 約束的四個代價分別是什麼？
- [ ] I5（狀態機）的兩種併發保護做法，shop-service 選哪一個、為什麼？

**交易**

- [ ] 「交易 = 一直佔著一條連線」的實測長什麼樣？它推出什麼公式？
- [ ] 為什麼交易邊界不能在 Repository？三個理由。
- [ ] `Propagation.MANDATORY` 的兩個前提是什麼？少了任一個會怎樣？
- [ ] **為什麼 `new JdbcOrderRepository(...)` 寫的整合測試，`MANDATORY` 是關掉的？**
- [ ] 唯讀查詢該用什麼傳播行為？`readOnly = true` 到底保證了什麼？
- [ ] 哪兩種情況真的需要 `REQUIRES_NEW`？它們的共同形狀是什麼？

**搬遷**

- [ ] 契約測試的九條各自在守什麼？
- [ ] **「兩次查回來是不是同一個物件」在 fake / JDBC / JPA 上的三種答案，各會讓什麼樣的 bug 出現或消失？**
- [ ] `place()` 與 `rehydrate()` 的差別？兩者失敗時的狀態碼為什麼不同？
- [ ] 搬遷的六個步驟，為什麼「先寫 schema」而不是「先寫 Repository」？
- [ ] fake 什麼時候退休？它留下來的必要條件是什麼？

**實作與環境**

- [ ] 金額為什麼用 `BIGINT` 最小單位而不是 `DECIMAL(19,4)`？代價是什麼？
- [ ] `schema.sql` 的六個設計決定各自的理由與反對意見？
- [ ] **為什麼「每一條約束都要有名字」？**
- [ ] `TIMESTAMP` 與 `DATETIME` 的差別為什麼在 H2 上看不出來？
- [ ] 六組 ArchUnit 規則各自防什麼事故？哪四條本章實測過會紅？
- [ ] 規則 6 與判準 7 的衝突該怎麼處理？為什麼不能用 `allowEmptyShould(true)`？
- [ ] `leak-detection-threshold` 為什麼是事故 2 的診斷工具？
- [ ] `rewriteBatchedStatements=true` 沒有設會發生什麼？
- [ ] 骨架刻意留下的五個問題各是什麼？

**如果有任何一題答不出來，回去讀對應的小節**：

| 題目範圍 | 小節 |
|---|---|
| 六個事故與它們的共同形狀 | 0.3 |
| 四個職責、Repository vs DAO、集合的錯覺 | 0.4 |
| 抽象洩漏、H2 會騙你 | 0.5 |
| 七個判準、20 個簽章 | **0.6** |
| 讀寫分離的介面 | 0.7 |
| **不變量的第四個位置（最重要）** | **0.8** |
| 交易邊界、MANDATORY | 0.9 |
| 契約測試、搬遷路徑 | 0.10 |
| 不該做的九件事 | 0.11 |
| 骨架、schema、ArchUnit、設定 | 0.12 |

---

## 0.18 下一章預告

這一章決定了「**邊界在哪、介面長什麼樣**」。
下一章（01）處理一個更基礎、也更容易在半夜叫醒你的問題：

> **`maximum-pool-size: 10` 這個 10 是怎麼來的？**

0.12.7 那份 `application.yml` 裡有九個設定，而本章只解釋了四個。
下一章要把它們全部展開：

| 問題 | 01 章哪一節 |
|---|---|
| JDBC URL 那一長串參數，哪些會影響正確性？ | 1.4 |
| 池大小該設多少？「越大越快」在什麼時候不成立？ | **1.6 ★** |
| `connection-timeout`、`validation-timeout`、`idle-timeout`、`max-lifetime` 分別在管什麼？ | 1.7 |
| **為什麼 `max-lifetime` 一定要小於資料庫的 `wait_timeout`？** | **1.7 ★** |
| 「`Connection is not available` 但資料庫很閒」——怎麼在 5 分鐘內找出兇手？ | **1.9 ★** |
| 池的指標要看哪幾個？什麼樣的曲線代表要出事了？ | 1.10 |
| 一個應用要不要有兩個池（讀 / 寫、線上 / 批次）？ | 1.11 |

⚠️ **1.6 與 1.9 是全站最實用的兩節**：
前者讓你能回答「這個數字為什麼是這個數字」，
**後者是唯一一節，你可能會在某個半夜真的用到。**

⚠️ **而 1.7 那條「`max-lifetime` < `wait_timeout`」是最常見的生產環境地雷** ——
它的症狀是「每天早上第一個請求會失敗，之後就正常了」，
而那個症狀在測試環境**永遠不會出現**。

---

**完成本章後**，請確認你的專案有：

```
✅ order/application/port/OrderRepository.java          ★ 七個方法，每一個都通過七個判準
✅ order/application/port/OrderQueryDao.java            ★ 讀路徑的埠（0.7.2）
✅ order/domain/Order.java                              ★ 新增 version 與 rehydrate()
✅ common/money/Money.java                              ★ 新增 minorUnits() / ofMinorUnits()
✅ order/infrastructure/persistence/JdbcOrderRepository.java   ★ @Transactional(MANDATORY)
✅ order/infrastructure/persistence/OrderRowMapper.java        ★ package-private 的 row record
✅ order/infrastructure/memory/InMemoryOrderRepository.java    ★ 深拷貝 + 樂觀鎖模擬
✅ resources/schema.sql                                 ★ 兩張表、四條具名約束、兩個索引
✅ order/OrderRepositoryContractTest.java               ★ 九條契約 × 兩個實作 = 18 個測試
   （練習 3 會補到十條；02 章 2.15.2 再補到 14 條，屆時跑在四個實作上）
✅ architecture/DataAccessArchitectureTest.java         ★ 六組規則全綠（且四條實測過會紅）
```

---

## 0.19 本章的實驗環境與結果

⚠️ **這一站延續 05-service 站後半的做法：先做實驗，再寫章節。**

**環境**：

| 項目 | 版本 |
|---|---|
| JDK | Temurin **21.0.5**（LTS） |
| Maven | **3.9.16** |
| Spring Boot | **3.2.5**（Spring Framework 6.1.6） |
| 資料庫 | **H2 2.2.224**（in-memory 與 file 兩種模式） |
| 連線池 | **HikariCP 5.0.1** |
| ArchUnit | **1.3.0** |
| 平台 | macOS 14.2.1 / Apple Silicon |

**跑過的實驗（44 個測試方法，全綠 —— 含 10 條契約 × 2 個實作、6 組 ArchUnit）**：

| 組 | 實驗 | 結果 |
|---|---|---|
| **E1** | 連線池大小 × 併發 | ✅ 池 1→20：3116 ms → 314 ms；池滿時 `SQLTransientConnectionException`「Connection is not available, request timed out after 1006ms」 |
| **E2** | 交易與連線 | ✅ 交易中 `active=1` 且綁在 ThreadLocal；**Repository 各自開交易 → 留下孤兒訂單** |
| **E3** | `stock >= 0` 的四種守法 × 5 輪 | ✅ **應用層 if：5/5 輪錯（賣出 15～18 個，庫存 10）**；**加 CHECK：5/5 輪錯且約束 0 次觸發**；原子 UPDATE：**5/5 輪正確** |
| **E4** | fake vs 真實作的契約 | ✅ 天真 fake「改了不影響已存」🔴；深拷貝 fake 與 JDBC ✅ |
| **E5** | N+1 | ✅ H2 上 201 次查詢 3.4 ms vs 批次 2.6 ms；**加 0.4 ms 網路來回後差 51 倍** |
| **E6** | 全撈 vs 逐列 | ✅ `-Xmx96m` + 每列不同的資料 → **`OutOfMemoryError`**；`RowCallbackHandler` 跑完 |
| **E7** | 深分頁 | ✅ H2 上 OFFSET 0 與 990,000 **一樣快（0.1 ms）**，但 `EXPLAIN` 顯示 `scanCount: 990020` |
| **E8** | Injection / 例外翻譯 / 冪等鍵 | ✅ 拼字串洩漏全表；`DuplicateKeyException`；**應用層 if 建了 2 筆、唯一索引建了 1 筆** |
| **E9** | 骨架的六個行為 | ✅ 往返、樂觀鎖、授權、排序穩定、兩條 CHECK 都擋下；**直接 `new` 的物件 `MANDATORY` 無效** |
| **E10** | MANDATORY（Spring 代理） | ✅ `IllegalTransactionStateException: No existing transaction found for transaction marked with propagation 'mandatory'`；bean 是 `jdk.proxy2.$Proxy26` |
| **契約** | 9 條 × fake / JDBC | ✅ 18 個全綠；**天真 fake 紅 2 條**；**練習 3 的第 10 條：fake 綠、JDBC 紅，修好後 20 個全綠** |
| **Arch** | 六組 ArchUnit | ✅ 全綠；**植入三個違規後紅 4 條規則**（規則 1、3、4、5） |

🔴 **本章沒有驗證到的（全部需要真的 MySQL）**：

> ⚠️ **寫這一章的時候本機還沒有裝 MySQL 與 Docker，所以下表全部標「沒驗證」。**
> **06 章把 MySQL 8.0.46 裝起來了**，下表有一半在那裡結案 —— 見 6.10。

| 沒驗證的 | 影響哪一節 | 哪一站會補 |
|---|---|---|
| **真的 MySQL 的深分頁成本** | 0.5.4 | 04 章、07-mysql 03 章 |
| **InnoDB 的鎖、死鎖、間隙鎖** | 0.8.7、0.9 | 07-mysql 04 章 |
| **`TIMESTAMP` 的時區轉換行為** | 0.12.3 | 07-mysql 02 章 |
| **MySQL 的定序（大小寫）** | 0.5.1 ⑦ | 06 章 |
| **`rewriteBatchedStatements` 的實際效果** | 0.12.7 | 05 章 |
| **連線池大小的真實曲線**（H2 沒有 I/O 競爭） | 0.9.1 | 01 章 |
| Testcontainers | 0.5.4、0.10 | 06 章 |
| 真實流量下的連線洩漏診斷 | 0.3.2 事故 2 | 01 章 1.9 |

> 📌 **最後一句話**：
>
> 這一章有**兩個實驗推翻了一個「大家都這樣說」的說法**：
>
> **① 「加了 `CHECK (qty >= 0)` 就不會超賣」** —— 5 輪實測，約束一次都沒觸發。
> **② 「深分頁很慢」** —— 在 H2 上完全量不出來，而 `scanCount` 說它掃了 99 萬列。
>
> ⚠️ **兩個發現的方向剛好相反**：
> 第一個是「你以為有防護，其實沒有」；
> 第二個是「你以為測過了，其實沒測到」。
>
> **而它們都不是靠讀文件得到的。**
> **這一站會一直用同一個方法：先做一個十行的實驗，再決定要相信什麼。**
