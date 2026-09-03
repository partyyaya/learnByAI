# 第 01 章：DataSource 與連線池

> 00 章 0.3.2 的事故 2 長這樣：
>
> ```
> 02:14  監控告警：所有 API 的 p99 從 80 ms 變成 30,000 ms
> 02:16  值班的人上線看：CPU 5%、記憶體正常、GC 正常
> 02:18  資料庫呢？CPU 4%、連線數 10、沒有慢查詢、沒有鎖等待
> 02:21  應用程式的錯誤日誌：⚠️ 空的
> 02:35  重啟服務 → 一切正常
> 03:40  又壞了一次
> ```
>
> **每一個「你會去看的地方」都是正常的。**
> 而那個唯一不正常的東西，藏在一個大部分人從來沒有看過的地方：
>
> ```
> HikariPool-1 - Pool stats (total=10, active=10, idle=0, waiting=847)
> ```
>
> ⚠️ **這一章要教的，就是怎麼在 5 分鐘內找到這一行，以及怎麼讓它一開始就不會發生。**
>
> **這是全站內容最少、但故障率最高的一章。**
> 00 章的東西寫錯了，你會在三個月後的對帳發現；
> **這一章的東西設錯了，你會在某個半夜被叫起來。**

---

## 1.1 學習目標

完成本章後，你應該可以：

- 說出「建立一條連線」到底做了哪五件事，以及為什麼它比一次查詢貴。
- 說明連線池**真正的價值是「限流」而不是「加速」**，並解釋這個觀念翻轉會改變什麼決定。
- 讀懂 Spring Boot 的 `DataSource` 自動組態順序，以及 `DataSource` 外面那三層包裝各自在做什麼。
- 逐條解釋 JDBC URL 上的參數，並分辨哪些影響**正確性**、哪些只影響效能 ——
  以及**用一個實測證明「一個 URL 參數會改變查詢結果」**。
- 描述一條連線的一生：借出、驗證、使用、歸還（**被重置了什麼**）、退休。
- **算出**一個服務該用多大的池，並解釋為什麼「池從 4 加到 64，吞吐掉了 4.6 倍」。
- 說出 `connectionTimeout` / `validationTimeout` / `idleTimeout` / `maxLifetime` / `keepaliveTime`
  各自管什麼，以及**哪三個你寫的值會被 HikariCP 靜默改掉**。
- 分辨 `connectionTimeout`、`Statement.setQueryTimeout`、交易 `timeout` 三者管的是三件不同的事。
- 用一套**五分鐘流程**診斷「`Connection is not available`」，並說出兩種病因怎麼分辨、
  以及**為什麼「看 cause」這個常見說法只對一半**。
- 列出池的五個關鍵指標，說出什麼樣的曲線代表「還有 20 分鐘就要出事了」。
- 判斷一個服務要不要**兩個池**，並用實測數字支持這個決定。

---

## 1.2 為什麼需要池

### 1.2.1 「建立一條連線」到底做了什麼

```
應用程式                                          資料庫伺服器
   │                                                   │
   │  ① TCP 三次握手                                    │
   │ ────────────── SYN ──────────────────────────────→ │
   │ ←───────────── SYN+ACK ────────────────────────── │
   │ ────────────── ACK ──────────────────────────────→ │
   │                                                   │
   │  ② TLS 握手（TLS 1.2 兩個來回、TLS 1.3 一個）        │
   │ ←────────────────────────────────────────────────→ │
   │                                                   │
   │  ③ 通訊協定交握 + 認證                              │
   │ ←──── 伺服器版本、能力、salt ──────────────────────  │
   │ ──── 帳號、密碼雜湊、要用的資料庫 ─────────────────→  │
   │                                                   │
   │  ④ session 初始化                                  │
   │ ──── SET NAMES utf8mb4, time_zone, sql_mode … ───→ │
   │                                                   │
   │  ⑤ 伺服器端配置資源                                 │
   │       （MySQL：一個執行緒 + 一組 session buffer）     │
   │                                                   │
   ▼                                                   ▼
 可以下第一句 SQL 了
```

⚠️ **第 ⑤ 步是最容易被忽略、但最重要的一步**：

> **一條連線在伺服器端不是「一個 socket」，而是「一組資源」。**
> MySQL 的每一條連線會配一個執行緒與數個 buffer
> （`sort_buffer_size`、`join_buffer_size`、`read_buffer_size`…）。
> **這就是為什麼資料庫的 `max_connections` 不能設很大** ——
> 它不是網路限制，是記憶體與排程的限制。
>
> 📌 **這一點會直接推出 1.6 的結論：池不是越大越好。**

### 1.2.2 實測：借一條 vs 建一條

**實驗（F1）**：2,000 次「取得連線 + 一句 `SELECT 1`」。

```
=== F1 2000 次「連線 + 一句查詢」===
  ① 每次 DriverManager.getConnection：   42.2 ms（每次 0.021 ms）
  ② 從 HikariCP 借還                ：    5.0 ms（每次 0.002 ms）
  ③ 檔案型 H2，每次重新連線        ：每次 0.226 ms
```

**池比每次新建快 10 倍。**

⚠️⚠️ **但這個數字會嚴重誤導你，原因有兩個**：

| 誤導 | 真相 |
|---|---|
| **H2 是 in-process 的** —— 沒有 TCP、沒有 TLS、沒有認證 | 上面圖裡的 ①②③④ **一步都沒有發生** |
| 0.021 ms 看起來「其實也不慢」 | 真的資料庫是**跨網路**的，①～④ 每一步都要來回 |

> 🔴 **寫這一章時本機還沒有 MySQL / Docker，所以真實的建連線成本【本章無法實測】。**
> （06 章裝了 MySQL 8，但那時量的是**同一台機器上的容器** —— 網路延遲接近 0，
> 所以「跨網路的建連線成本」這一項到 07-mysql 站才會有真數字。）
> 業界常見的量級是：**同機房不加密約 1～3 ms、加 TLS 約 5～15 ms、跨區域可到 50 ms 以上。**
> **請以你自己環境的實測為準**（07-mysql 站會給一組真實數字）。
>
> **而重點不是那個數字本身，是它與「一句查詢」的比例**：
> 建一條連線的成本，通常是**一句簡單查詢的 5～50 倍**。

### 1.2.3 ★ 池真正的價值不是「加速」，是「限流」

**這是這一章最重要的觀念翻轉，而它與大部分人的直覺相反。**

如果池只是為了省下「建連線」的成本，那麼：

```java
// 🔴 這個「無上限的池」應該是最好的：永遠不用等，也不用重建
maximumPoolSize = Integer.MAX_VALUE;
```

**而它是災難。** 理由在 1.2.1 的第 ⑤ 步：**連線在伺服器端是有成本的**。
一個無上限的池，會把「應用程式端的排隊」變成「資料庫端的過載」——
而**資料庫過載沒有排隊，只有全部一起變慢**。

> 📌 **正確的心智模型**：
>
> **連線池 = 一個【號碼牌機器】。**
> 它的價值有兩個，而第二個比第一個重要：
> 1. 省下重複建立連線的成本（**次要**）。
> 2. **保證「同時打進資料庫的請求數」有一個上限**（**主要**）。
>
> ⚠️ **當請求超過上限時，池讓它們【在應用程式這邊排隊】。**
> 這是一件好事 —— 因為在這邊排隊是可觀測、可設逾時、可以快速失敗的；
> 在資料庫那邊排隊只會讓所有人一起慢。

**這個觀念翻轉會改變三個決定**：

| 決定 | 「池 = 加速」的想法 | 「池 = 限流」的想法 |
|---|---|---|
| 池要多大 | 越大越好 | **剛好能餵飽資料庫**（1.6） |
| 等不到連線時 | 多等一下沒關係 | **快速失敗**，把壓力擋在外面（1.7.1） |
| 批次任務要不要共用池 | 共用比較省 | 🔴 **不共用** —— 它會吃掉線上請求的額度（1.11） |

---

## 1.3 DataSource：介面與實作

### 1.3.1 三個介面，三種用途

```java
javax.sql.DataSource               // ★ 你 99% 的時間只會用到這個
javax.sql.ConnectionPoolDataSource // 給「池的實作者」用的，你不會直接碰
javax.sql.XADataSource             // 分散式交易（兩階段提交）用
```

```java
public interface DataSource extends CommonDataSource, Wrapper {
    Connection getConnection() throws SQLException;
    Connection getConnection(String username, String password) throws SQLException;
}
```

⚠️ **注意這個介面有多小：兩個方法。**

> 📌 **`DataSource` **沒有**「歸還連線」這個方法** ——
> 歸還是靠 `Connection.close()`。
>
> **而這正是連線洩漏的根源**：
> `close()` 這個名字讓人以為「關掉就沒了」，
> 但在池的世界裡它的意思是**「還回去」**。
> 忘記呼叫它，不會有任何錯誤 —— 只會少一條連線。
> **00 章事故 2 就是這麼來的。**

### 1.3.2 Spring Boot 怎麼決定用哪一個實作

`DataSourceAutoConfiguration` 的選擇順序（Spring Boot 3.2）：

```
① classpath 上有 com.zaxxer.hikari.HikariDataSource？        → 用 HikariCP   ★ 預設
② 有 org.apache.tomcat.jdbc.pool.DataSource？                → 用 Tomcat JDBC
③ 有 org.apache.commons.dbcp2.BasicDataSource？              → 用 DBCP2
④ 有 oracle.ucp.jdbc.PoolDataSource？                        → 用 Oracle UCP
⑤ Generic：用 spring.datasource.type 指定的類別（⚠️ 沒指定就沒有這個 bean）
```

⚠️ **第 ⑤ 項常被寫成「都沒有就用 `SimpleDriverDataSource`」，那是不對的。**
`DataSourceConfiguration.Generic` 是靠 `spring.datasource.type` 決定要建哪一個類別；
**沒有指定就不會有 `DataSource` bean，啟動時會失敗。**

**真正會給你 `SimpleDriverDataSource` 的是另一條路**：
classpath 上有內嵌資料庫（H2 / HSQLDB / Derby）而且**沒有設 `spring.datasource.url`** 時，
走的是 `EmbeddedDataSourceConfiguration` —— 它建的是一個內嵌資料庫，**沒有池**。

> 📌 **這條路徑就是「為什麼加了 H2 依賴之後，什麼都不設也跑得起來」的原因** ——
> 而它也解釋了一個常見的困惑：
> **測試裡的 `DataSource` 有時候不是 `HikariDataSource`**，於是 1.12.3 那條守門測試會紅。

> ⚠️ 上面這個順序是用 `spring-boot-autoconfigure-3.2.5.jar` 裡
> `DataSourceAutoConfiguration$PooledDataSourceConfiguration` 的 `@Import` 內容核對過的
> —— **不同版本可能不同，請以你的版本為準。**

**`spring-boot-starter-jdbc` 與 `spring-boot-starter-data-jpa` 都直接依賴 HikariCP**，
所以你什麼都不做就會拿到它。

**想換掉的話**：

```xml
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-jdbc</artifactId>
  <exclusions>
    <exclusion>
      <groupId>com.zaxxer</groupId><artifactId>HikariCP</artifactId>
    </exclusion>
  </exclusions>
</dependency>
```

```yaml
spring:
  datasource:
    type: org.apache.commons.dbcp2.BasicDataSource   # ★ 明確指定
```

> ⚠️ **除非有具體理由，不要換。** HikariCP 是目前預設而且維護良好的選擇。
> **而「具體理由」通常只有一種**：某個舊系統依賴 DBCP 的特定行為
> （例如 `removeAbandoned` 這種「自動回收洩漏的連線」的功能 —— HikariCP **刻意沒有**，
> 理由是「自動回收會讓你永遠找不到那個 bug」，見 1.9.4）。

### 1.3.3 為什麼 HikariCP 快

三個設計決定，你不需要背，但知道它們會幫你看懂日誌與行為：

| 設計 | 做法 | 影響到你的地方 |
|---|---|---|
| **`ConcurrentBag`** | 執行緒優先拿「自己上次用的那條」，減少競爭 | 你會發現同一個執行緒常常拿到同一條連線 |
| **無鎖的 handoff** | 歸還時如果有人在等，**直接交給他**，不放回集合 | `waiting` 這個指標的下降會很快 |
| **不做 `removeAbandoned`** | 洩漏只**告警**，不自動回收 | 🔴 **洩漏不會自己好** —— 但你會拿到那段堆疊（1.9.4） |

### 1.3.4 你的 `DataSource` 外面其實包了三層

**這是很多人第一次 debug 資料層時的困惑來源**：

```
你的 Repository 拿到的 DataSource
   └─ ① TransactionAwareDataSourceProxy（選用）
        └─ ② LazyConnectionDataSourceProxy（選用，讀寫分離常用）
             └─ ③ HikariDataSource                   ← 真正的池
                  └─ ④ com.mysql.cj.jdbc.Driver      ← 真正建連線的人
```

| 層 | 它做什麼 | 什麼時候會出現 |
|---|---|---|
| ① `TransactionAwareDataSourceProxy` | 讓「直接用 `dataSource.getConnection()`」也能參加 Spring 交易 | 混用舊程式碼時 |
| ② `LazyConnectionDataSourceProxy` | **開交易時不立刻借連線**，等到第一句 SQL 才借 | **讀寫分離必備**（05 章 5.7） |
| ③ `HikariDataSource` | 池 | 一定有 |
| ④ `Driver` | 真的建連線 | 一定有 |

⚠️ **② 的存在理由值得記住**，因為它解決一個真實問題：

```java
@Transactional(readOnly = true)        // ★ 想路由到 replica
public OrderView detail(String id) {
    // 🔴 沒有 LazyConnectionDataSourceProxy 的話：
    //    交易一開始就借了連線，而那時候「要路由到哪裡」的判斷還沒發生
    …
}
```

> 📌 **`LazyConnectionDataSourceProxy` 還有一個附帶好處**：
> 一個標了 `@Transactional` 但**完全沒碰資料庫**的方法（例如條件不成立就直接回傳），
> **根本不會借連線** —— 直接省掉 1.8 那個「交易長度佔用連線」的成本。

---

## 1.4 JDBC URL ★

### 1.4.1 URL 的結構

```
jdbc:mysql://db-primary.internal:3306/shop?useSSL=true&connectionTimeZone=UTC&rewriteBatchedStatements=true
└──┬─┘ └─┬─┘  └───────┬──────────┘ └─┬┘ └─┬┘ └──────────────┬──────────────────────────────┘
  協定  子協定       主機            埠  資料庫              參數（★ 這一段是本節的主題）
```

### 1.4.2 實測：一個參數改變**查詢結果**

**這一節的重點不是「參數很多」，是「其中有些會改變正確性」。**

**實驗（F11）**：同一句 SQL、同一份資料，只差一個 URL 參數。

```java
jdbc.execute("CREATE TABLE customer(id VARCHAR(10) PRIMARY KEY, email VARCHAR(100))");
jdbc.update("INSERT INTO customer VALUES ('C-1', 'Alice@Example.com')");

String sql = "SELECT COUNT(*) FROM customer WHERE email = 'alice@example.com'";
```

```
=== F11 同一句 SQL，兩個 URL，兩種結果 ===
  ...:f11a                       → 查到 0 筆（分大小寫）
  ...:f11b;IGNORECASE=TRUE       → 查到 1 筆（不分大小寫）
  👉 「這個 email 已經被註冊了嗎」的答案，取決於 URL 上的一個參數
```

> 🔴 **把這件事翻譯成業務語言**：
> **「這個 email 已經被註冊了嗎」的答案，取決於一行設定檔。**
>
> 而更糟的是：**MySQL 的預設定序 `utf8mb4_0900_ai_ci` 是【不分大小寫】的，
> 而 H2 的預設是【分】的。**
> 於是你的測試（H2）說「可以註冊」，正式環境（MySQL）說「這個 email 已存在」——
> **兩邊都沒有錯，只是行為不同。**
>
> ⚠️ **這是 00 章 0.5.1 洩漏清單第 ⑦ 條的實測版本**，
> 而 06 章會給一份完整的「H2 與 MySQL 行為差異」清單與對應的特性測試。

### 1.4.3 MySQL 的參數：按「會不會影響正確性」分類

⚠️ **以下這張表基於 MySQL Connector/J 8.x 的文件與慣例；
本機沒有 MySQL，所以【本章沒有實測這些參數】** ——
07-mysql 站 02 章會逐一驗證。

**A. 影響【正確性】的（設錯 = 資料錯）**

| 參數 | 建議值 | 設錯的後果 |
|---|---|---|
| `connectionTimeZone` | `UTC`（8.0.23+；舊版叫 `serverTimezone`） | ⚠️ **時間差 8 小時**，而且是靜默的 |
| `forceConnectionTimeZoneToSession` | `true` | 連線的 session 時區與你想的不一致 |
| `characterEncoding` | `utf8mb4`（或用 `connectionCollation`） | emoji、罕見字變成 `?` |
| `preserveInstants` | `true` | `Instant` 往返之後不相等 |
| `zeroDateTimeBehavior` | `CONVERT_TO_NULL` | 遇到 `0000-00-00` 直接拋例外 |
| `sessionVariables=sql_mode='STRICT_TRANS_TABLES,…'` | 明確指定 | 🔴 **非嚴格模式會把超長字串「截斷」而不是報錯** |

**B. 影響【效能】的**

| 參數 | 建議值 | 不設的後果 |
|---|---|---|
| `rewriteBatchedStatements` | `true` | 🔴 **`batchUpdate` 仍然是 N 次來回**（05 章 5.8 實測） |
| `cachePrepStmts` + `prepStmtCacheSize` + `prepStmtCacheSqlLimit` | `true` / `250` / `2048` | 每次都重新解析 SQL |
| `useServerPrepStmts` | `true` | 用不到伺服器端的預備語句 |
| `useLocalSessionState` | `true` | 每次 `setAutoCommit` 都送一次往返 |
| `maintainTimeStats` | `false` | 小幅的統計開銷 |

**C. 影響【診斷】與【韌性】的**

| 參數 | 建議值 | 說明 |
|---|---|---|
| `connectTimeout` | `3000` | ⚠️ **驅動層的建連線逾時**，與 Hikari 的 `connectionTimeout` **是兩件事**（1.7.1） |
| `socketTimeout` | 依最慢的查詢而定 | 🔴 **不設的話，網路斷掉時執行緒會永遠卡住** |
| `tcpKeepAlive` | `true` | 偵測對端消失 |
| `useSSL` / `sslMode` | `REQUIRED`（正式環境） | — |
| `allowPublicKeyRetrieval` | ⚠️ **不要開** | 開了等於接受中間人 |
| `logger` / `profileSQL` | 只在除錯時開 | — |

> ⚠️⚠️ **`socketTimeout` 是這張表裡最容易被漏掉、後果最嚴重的一個。**
>
> **情境**：資料庫所在的機器整台掛掉（不是拒絕連線，是**沒有回應**）。
> 沒有 `socketTimeout` 的話，已經送出去的查詢會**永遠等下去**，
> 而那條連線**不會回到池裡**。
> **結果就是 00 章事故 2 的形狀 —— 但這一次連重啟資料庫都救不回來，
> 因為卡住的是應用程式這一端。**

### 1.4.4 shop-service 的 URL

```
jdbc:mysql://db-primary.internal:3306/shop
  ?connectionTimeZone=UTC                       # A：全站存 UTC（00 章 0.12.3）
  &forceConnectionTimeZoneToSession=true        # A
  &preserveInstants=true                        # A
  &characterEncoding=utf8mb4                    # A
  &zeroDateTimeBehavior=CONVERT_TO_NULL         # A：遇到髒資料不要整個炸掉
  &sessionVariables=sql_mode='STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION'   # A ★
  &rewriteBatchedStatements=true                # B（05 章）
  &cachePrepStmts=true&prepStmtCacheSize=250&prepStmtCacheSqlLimit=2048     # B
  &useServerPrepStmts=true                      # B
  &useLocalSessionState=true                    # B
  &connectTimeout=3000                          # C
  &socketTimeout=30000                          # C ★★ 一定要設
  &tcpKeepAlive=true                            # C
  &sslMode=REQUIRED                             # C
```

⚠️ **`sessionVariables=sql_mode=…` 那一行值得特別說明**：

> **它把「這個連線的嚴格模式」寫死在應用程式這一邊，而不是靠伺服器的設定。**
>
> **為什麼**：`sql_mode` 是伺服器層級的設定，而它會被
> DBA 改、被雲端供應商的預設值改、被不同環境的參數群組改。
> **一旦某個環境不是嚴格模式，「插入超長字串」會變成【靜默截斷】而不是錯誤** ——
> 這是 00 章 0.3.4 那張表的完美例子：**「存進去就存進去了」的假設又一次不成立。**

### 1.4.5 三個「一定要設」與三個「不要設」

**一定要設**：

1. **`socketTimeout`** —— 沒有它，網路故障會變成永久卡住。
2. **`connectionTimeZone=UTC`** —— 時區問題是最難查的一類 bug。
3. **`sessionVariables=sql_mode='STRICT_TRANS_TABLES,…'`** —— 讓「壞資料」變成錯誤。

**不要設**：

1. 🔴 **`autoReconnect=true`** —— 它會在連線斷掉後**靜默重連**，
   而**重連之後交易已經沒了**、暫存表沒了、session 變數沒了。
   **它把「一個明確的錯誤」換成「一個難以理解的資料不一致」。**
2. 🔴 **`allowMultiQueries=true`** —— 允許一次送多句 SQL，
   **等於把 SQL Injection 的破壞力從「讀」升級成「刪」**。
3. ⚠️ **`allowPublicKeyRetrieval=true`** —— 只在本機開發時可接受。

---

## 1.5 一條連線的一生

### 1.5.1 全景圖

```
                       ┌──────────────────────────────────────┐
   ① 池啟動            │ 建 minimumIdle 條連線（非同步）        │
                       └──────────────────┬───────────────────┘
                                          ↓
   ② getConnection()   ┌──────────────────────────────────────┐
                       │ 有閒置的？ ── 有 ──→ ③ 驗證           │
                       │      │                                │
                       │      └─ 沒有 ─→ 還沒到 max？ 建一條    │
                       │                  已到 max？ ★ 排隊     │
                       │                    └─ 等超過           │
                       │                       connectionTimeout│
                       │                       → 拋例外（1.9）  │
                       └──────────────────┬───────────────────┘
                                          ↓
   ③ 借出前驗證        ┌──────────────────────────────────────┐
                       │ 距離上次使用 > 500 ms（aliveBypassWindow）│
                       │   → isValid() 或 connectionTestQuery   │
                       │ 驗證失敗 → 丟掉，換一條（F4-A 實測）    │
                       └──────────────────┬───────────────────┘
                                          ↓
   ④ 使用中            ★ 這段時間它【不能給別人用】（1.8）
                                          ↓
   ⑤ close() = 歸還     ┌──────────────────────────────────────┐
                       │ rollback 未提交的交易                   │
                       │ 重置 autoCommit / isolation / readOnly  │
                       │ 有人在等？ → 直接交給他（handoff）       │
                       └──────────────────┬───────────────────┘
                                          ↓
   ⑥ 退休（三種原因）   ┌──────────────────────────────────────┐
                       │ a. 閒置超過 idleTimeout（且 > minIdle） │
                       │ b. 活超過 maxLifetime                  │
                       │ c. 驗證失敗 / 用的時候拋例外            │
                       └──────────────────────────────────────┘
```

### 1.5.2 實測：歸還時池幫你做了什麼

**很多人不知道池會做這些清理**（F12）：

```java
try (Connection c = ds.getConnection()) {
    c.setAutoCommit(false);
    c.setTransactionIsolation(Connection.TRANSACTION_SERIALIZABLE);
    st.executeUpdate("INSERT INTO t VALUES (1)");     // ★ 沒有 commit
}   // ← close() = 還回池裡

// 再借一次（池只有一條連線 → 一定是同一條實體連線）
```

```
=== F12 連線歸還時，池做了什麼 ===
  借出時：autoCommit=true isolation=2 readOnly=false
  借出中：寫了一筆但【沒有 commit】，然後直接還回去
  再借出：autoCommit=true isolation=2 readOnly=false   ★ 全部被重置回預設
  表裡有 0 筆   ★ 沒有 commit 的寫入被 rollback 掉了
```

**三個結論**：

| 觀察 | 意義 |
|---|---|
| 未提交的寫入被 **rollback** | ✅ 忘記 commit 不會污染下一個使用者 |
| `autoCommit`、`isolation`、`readOnly` 被**重置** | ✅ 上一個人的設定不會漏給你 |
| ⚠️ **但「session 層級的東西」不一定會被重置** | 🔴 見下方 |

> ⚠️⚠️ **池重置的是 JDBC 層面的屬性，不是資料庫 session 的一切。**
>
> **它不會重置的東西**（各家資料庫不同）：
> - `SET @user_variable = …`（MySQL 的使用者變數）
> - 暫存表（`CREATE TEMPORARY TABLE`）
> - `SET SESSION sql_mode = …`（如果你在程式裡改過）
> - 預備語句的快取狀態
>
> 📌 **所以有一條實務規則**：
> **不要在借來的連線上做「會留下痕跡」的 session 操作。**
> 如果非做不可（例如某些報表要調 `sort_buffer_size`），
> **必須在 `finally` 裡改回來** —— 因為那條連線接下來會給別人用。

### 1.5.3 實測：連線死掉的時候

**MySQL 的 `wait_timeout` 預設是 8 小時：閒置超過就把連線關掉。**
**而池不知道這件事。** 那會怎樣？

**實驗（F4）**：用一個 `DyingDataSource` 模擬「伺服器關掉閒置連線」。

```
=== F4-A 連線在池裡閒置時被伺服器關掉 ===
  一開始建立了 1 條實體連線
  ✅ 呼叫端完全沒有感覺 —— 池換了一條新的（累計建立 3 條）

=== F4-B 連線借出去之後才死掉 ===
  🔴 呼叫端收到例外：SQLException / 伺服器已關閉這條連線（模擬 wait_timeout）
  👉 池只在【借出的那一刻】驗證，借出之後發生的事它管不到
```

> 📌 **這組實測修正了一個流傳很廣的說法。**
>
> **常見說法**：「`max-lifetime` 沒設好，早上第一個請求就會失敗。」
> **實測顯示**：HikariCP **會在借出時驗證**（`isValid()`），
> 發現死連線就丟掉換一條 —— **呼叫端完全沒有感覺**（F4-A）。
>
> ⚠️ **那 `maxLifetime` 還有什麼用？三個真正的理由**：
> 1. **避免驗證的成本**：每次借出都驗證失敗 → 重建，這是延遲尖峰。
> 2. **讓連線能跟著基礎設施輪替**：資料庫做了 failover、負載平衡器換了後端、
>    憑證換了 —— **舊連線不會自己知道**，靠 `maxLifetime` 定期換掉。
> 3. **F4-B 才是真正會咬人的情況**：連線在**已經借出去之後**死掉。
>    這時候池救不了你 —— 而**交易越長，落在這個視窗裡的機率越高**（1.8）。

**而「資料庫完全連不上」的樣子（F4-C）**：

```
=== F4-C 資料庫連不上 ===
  等了 2009 ms 之後：java.sql.SQLTransientConnectionException
  訊息：f4c - Connection is not available, request timed out after 2006ms.
  cause: JdbcSQLNonTransientConnectionException / Connection is broken: "java.net.ConnectException: Connection refused: 127.0.0.1:19999"
  cause: ConnectException / Connection refused
```

⚠️ **注意第一行訊息**：`Connection is not available, request timed out` ——
**與「池被佔滿」是同一句話**。**1.9.3 會處理這個歧義。**

---

## 1.6 池要多大 ★★

### 1.6.1 三個都錯的直覺

| 直覺 | 為什麼錯 |
|---|---|
| 「我們有 200 個 Tomcat 執行緒，所以池要 200」 | 那是**同時可以有 200 個請求**，不是「同時有 200 個請求在用資料庫」 |
| 「池越大越好，反正閒著也不佔什麼」 | 🔴 佔資料庫的執行緒與記憶體（1.2.1 第 ⑤ 步），而且**吞吐會下降**（1.6.2） |
| 「先設 100，之後再調」 | ⚠️ **「之後」通常是某次促銷把資料庫打垮的時候** |

### 1.6.2 實測：池大小的曲線

**實驗（F2）**：一個**被模擬的資料庫**（4 個核心、每句查詢 2 ms、
每多一個排隊者所有人 +0.15 ms），固定 64 個併發客戶端、640 個請求、每請求 4 句查詢。
**池的借還是真的 HikariCP，只有資料庫那一端是模擬的。**

```
=== F2 池大小曲線（模擬的資料庫：4 個核心、每查詢 2 ms、每個排隊者 +0.15 ms）===
    固定 64 個併發客戶端、640 個請求、每請求 4 句查詢

  池大小    吞吐(req/s)   平均(ms)    p95(ms)    p99(ms)
  1              125      488.4     4554.7     4952.0
  2              249      244.1     2412.7     2541.0
  4              494      123.3     1227.7     1280.2      ← ★ 最高點
  8              383      159.6     1592.2     1655.5
  16             270      227.7     2250.8     2367.0
  32             174      355.5     1936.5     3670.6
  64             107      585.6      705.7     1354.8      ← 🔴 比池=4 慢 4.6 倍
```

> 🔴 **池從 4 加到 64，吞吐從 494 掉到 107 —— 慢了 4.6 倍。**
>
> ⚠️ 而如果你只看「池大小」與「有沒有報錯」，
> **這兩個設定看起來完全一樣** —— 都沒有錯誤、都跑完了。

**為什麼會下降？三個原因，而它們在真實資料庫上都存在**：

| 原因 | 在模擬裡的樣子 | 在真實 MySQL 上的樣子 |
|---|---|---|
| ① **CPU 只有那麼多核心** | `Semaphore(4)` | 超過核心數的查詢只能排隊 |
| ② **併發越高，每個都變慢** | `+0.15 ms × 排隊人數` | context switch、L3 快取失效、記憶體頻寬 |
| ③ **鎖競爭放大** | （沒有模擬） | 🔴 **真實系統會更糟** —— 更多交易同時搶同一批列 |

> 📌 **一句話**：
> **排隊是一定會發生的，你只能選擇「在哪裡排」。**
> **在池外面排** → 資料庫維持在最高效率，隊伍前進得快。
> **在資料庫裡面排** → 所有人一起慢，隊伍前進得更慢。

### 1.6.3 ★ p95 那一欄的陷阱

**看一下 F2 表格的 p95 欄位**：

```
  池大小=4   p95 = 1227.7 ms
  池大小=64  p95 =  705.7 ms      ← ⚠️ 「延遲變好了」？
```

**如果你只看 p95，會得到「池 64 比較好」的結論 —— 而那是錯的。**

**為什麼會這樣**：這是一個**封閉式負載**（640 個請求一次全部發出）。

| 池 = 4 | 池 = 64 |
|---|---|
| 4 個人在跑，60 個在排隊 | 64 個人**同時在跑**，沒有人排隊 |
| 排在後面的人**等很久**（p95 高） | 每個人都**同時開始、同時慢**（p95 低但平均高） |
| **總時間短**（1.3 秒跑完 640 個） | **總時間長**（6 秒跑完 640 個） |

> ⚠️⚠️ **這是效能測試最常見的誤讀，值得記下來**：
>
> **在封閉式負載（固定併發數）下，「延遲百分位」會騙你。**
> 把池加大，等待從「排隊時間」變成「執行時間」——
> **數字搬家了，但總量沒有變少，甚至變多。**
>
> 📌 **正確的看法**：
> - **封閉式負載**（壓測工具固定 N 個執行緒）→ **看吞吐（req/s）**。
> - **開放式負載**（真實流量，請求以固定速率進來）→ **看延遲百分位**。
>
> **而生產環境是開放式的** —— 所以在生產環境，池太大的症狀是
> **「延遲全面上升」而不是「有些人特別慢」**。

### 1.6.4 公式

**公式 A：Little's Law（上限）**

```
最大吞吐（req/s） = 池大小 ÷ 每個請求佔用連線的時間（秒）
```

**實驗（F10）驗證這個公式**（池固定 10）：

```
=== F10 池固定 10，交易長度不同時的最大吞吐 ===
  交易長度          公式 池/長度      實測 req/s      誤差
  10 ms                 1000            647       -35%
  50 ms                  200            146       -27%
  200 ms                  50             43       -14%
  500 ms                  20             19        -7%
```

> 📌 **公式是【上限】，不是預測值。**
> 交易越短，固定開銷（借還、排程、context switch）佔比越大，誤差越大。
> **交易長度到 500 ms 時誤差只剩 7%** —— 這時候公式已經很準了。
>
> ⚠️ **用法**：拿它來回答「**這個池最多能撐多少 TPS**」，
> 而不是「我會有多少 TPS」。

**公式 B：反過來算池大小**

```
池大小 = 目標 TPS × 每個請求佔用連線的時間（秒）
```

**公式 C：PostgreSQL 社群的經驗公式**（HikariCP 的 wiki 也引用它）

```
連線數 = (核心數 × 2) + 有效磁碟數
```

⚠️ **這個公式的適用範圍很窄**，用之前要知道它的假設：
它假設**工作負載是 CPU 與磁碟受限的 OLTP**，
而且算的是**整個資料庫的總連線數**，不是單一應用的池。

> 🔴 **本章沒有真的資料庫，所以公式 C 無法驗證。**
> **07-mysql 站會在真的 MySQL 上量一次那條曲線。**

### 1.6.5 shop-service 的計算過程

**這一節示範「怎麼從需求算到那個數字」，而不是直接給答案。**

**已知**：

| 項目 | 數字 | 來源 |
|---|---|---|
| 尖峰 TPS（下單 + 查詢） | 400 | 產品需求 |
| 應用程式副本數 | 4 個 Pod | K8s 設定 |
| 資料庫 `max_connections` | 500 | DBA 給的 |
| 平均「佔用連線的時間」 | 25 ms | ⚠️ **這是關鍵，見下方** |
| 資料庫 CPU 核心數 | 8 | 規格 |

**步驟 1：算「每個請求佔用連線多久」**

⚠️ **這不是「SQL 執行時間」，而是「從借到還」的整段時間**：

```
一個 POST /orders 的交易裡：
  SELECT 商品（批次）      3 ms
  SELECT 客戶             1 ms
  UPDATE 庫存（原子）      4 ms
  INSERT 訂單             2 ms
  INSERT 明細（批次）      3 ms
  ─────────────────────────
  SQL 合計               13 ms
  + 交易的開始與提交       ~4 ms
  + Java 端的邏輯（在交易裡）~8 ms   ← ★ 這一段最容易被忘記
  ─────────────────────────
  佔用連線               ~25 ms
```

**步驟 2：用公式 B**

```
單一 Pod 要撐的 TPS = 400 ÷ 4 = 100
池大小 = 100 × 0.025 = 2.5
```

**步驟 3：加上安全係數**

| 考量 | 加多少 | 理由 |
|---|---|---|
| 流量不是平均分布的 | ×2 | 尖峰的那一秒可能是平均的兩倍 |
| 交易偶爾會變慢 | ×1.5 | 一個慢查詢會拖長佔用時間 |
| 排程與非同步任務 | +2 | 它們也要連線 —— ⚠️ **但這是一個過渡做法**，見下方 |

```
池大小 ≈ 2.5 × 2 × 1.5 + 2 ≈ 10
```

⚠️ **最後那個 `+2` 是這個計算裡唯一有爭議的一項。**

**它把「排程與非同步任務」算進線上池，等於讓兩種完全不同的流量共用同一個額度** ——
而 1.11.1 的實測顯示，那會讓線上請求的 p95 慢 20 倍。

> 📌 **正確的做法是把它們拆出去**（1.11.4 的兩個池），
> **那時候線上池的計算就不該有 `+2`**。
> **本章保留 `+2`，是因為「先用一個池、之後再拆」是大多數專案真實的演進路徑** ——
> 而知道那個 `+2` 是什麼，你才會知道什麼時候該拆。
>
> ⚠️ **本章練習 1 用的是【已經拆好】的版本，所以那裡沒有 `+2`。**

**步驟 4：檢查總量不會打爆資料庫**

```
4 個 Pod × 10 = 40 條連線
+ 批次任務的池     4 × 2 = 8
+ 排程服務          5
+ 監控 / DBA / 備份  10
────────────────────────
合計約 63 < max_connections 500      ✅ 有很大的餘裕
```

⚠️ **這一步在 K8s 上特別容易出事**：

> 🔴 **`replicas` 從 4 調到 40 的時候，沒有人會想到資料庫的連線數。**
> **40 × 10 = 400**，加上其他就接近 500 了。
> **而「調 replicas」通常是為了應付流量、在很趕的時候做的。**
>
> 📌 **對策**：把這個計算寫成註解放在 `application.yml` 旁邊（1.12），
> 並在監控上加一條告警：**「資料庫總連線數 > max_connections × 60%」**。

### 1.6.6 `minimumIdle` 該不該等於 `maximumPoolSize`

**HikariCP 官方建議：讓它們相等**（固定大小的池）。**為什麼？**

**實驗（F9）**：模擬「建立一條連線要 30 ms」，突發 20 個請求（每個佔用 50 ms）。

```
=== F9 突發 20 個請求（每個佔用 50 ms），建立一條連線要 30 ms ===
  minimumIdle=10  maximumPoolSize=10  → 總耗時  171.7 ms，第一個  70.3 ms，最慢  170.3 ms
  minimumIdle=1   maximumPoolSize=10  → 總耗時  320.6 ms，第一個  60.2 ms，最慢  320.2 ms
  minimumIdle=2   maximumPoolSize=10  → 總耗時  280.0 ms，第一個  57.1 ms，最慢  280.0 ms
```

> 📌 **冷池比熱池慢 1.9 倍，而且慢的正好是「流量剛上來」的那一刻。**
>
> ⚠️ **這個成本的分布很惡劣**：它**只在尖峰發生**。
> 平常沒事、一有流量就慢 —— 而那正是你最不希望它慢的時候。

**兩個例外，這時候 `minimumIdle < maximumPoolSize` 是對的**：

| 情況 | 理由 |
|---|---|
| **很多個小服務共用一個資料庫** | 每個服務都固定佔著 10 條，資料庫會先被佔滿 |
| **明顯的離峰**（例如夜間幾乎沒流量） | 讓連線退休可以省下資料庫端的資源 |

⚠️ **而選了它就要接受**：離峰之後的第一波流量會比較慢
（可以用 `keepaliveTime` 減輕，見 1.7.5）。

### 1.6.7 一個常被問的問題：Tomcat 執行緒數與池大小的關係

```
Tomcat 執行緒 200  →  池大小要 200 嗎？
```

**不用，而且不該。** 兩個數字量的是不同的東西：

```
200 個 Tomcat 執行緒 = 同時可以【處理】200 個 HTTP 請求
10 條連線            = 同時可以有 10 個請求【正在用資料庫】
```

**一個請求的生命週期裡，只有一小段在用資料庫**：

```
|← 反序列化 →|← 驗證 →|←── 用資料庫 ──→|← 組回應 →|← 序列化 →|
     2 ms      1 ms        25 ms          3 ms      2 ms
                      └─ 只有這 25/33 需要連線 ─┘
```

> ⚠️ **但有一個例外要小心**：
> 如果你的請求在**交易裡**呼叫外部 API（05-service 站 00 章 0.10.1 說「不該做」），
> 那「佔用連線的時間」會暴增到 300 ms 以上，
> **這時候池大小的需求也會跟著暴增** —— 而正確的解法是**把外部呼叫移出交易**，
> 不是把池加大。

### 1.6.8 ★ 虛擬執行緒（Java 21）之後，這一切有沒有改變？

**Spring Boot 3.2 + Java 21 可以用一行設定打開虛擬執行緒**：

```yaml
spring:
  threads:
    virtual:
      enabled: true        # ★ 每個請求一個虛擬執行緒，不再受執行緒池大小限制
```

**於是 1.6.7 那個「Tomcat 200 個執行緒」的上限消失了** ——
可以同時有幾萬個請求在處理。**那連線池呢？**

**實驗（F15）**：2,000 個虛擬執行緒打一個大小 10 的池，每個請求佔用連線 50 ms。

```
=== F15 2000 個虛擬執行緒 × 池 10（每個請求佔用 50 ms）===
  執行緒實作：java.lang.VirtualThread
  connectionTimeout=30000  → 耗時  10.7 s，成功 2000，失敗    0，吞吐   187 req/s
  connectionTimeout=1000   → 耗時   1.1 s，成功  190，失敗 1810，吞吐   174 req/s
```

**兩個結論，而第二個比第一個重要**：

| 觀察 | 意義 |
|---|---|
| **兩種設定的吞吐幾乎一樣（187 vs 174 req/s）** | ★ **池才是真正的上限，虛擬執行緒沒有讓資料庫變快** |
| 逾時 30 秒 → 2,000 個全部成功，但**每個人平均等了 10 秒** | 「不失敗」是假的成功 —— 使用者早就走了 |
| 逾時 1 秒 → **1,810 個快速失敗**，190 個正常完成 | ✅ **這才是你要的行為**（1.2.3 的限流觀念） |

> 🔴 **虛擬執行緒把「排隊」從執行緒池搬到了連線池門口。**
>
> **在傳統執行緒模型下**，Tomcat 的 200 個執行緒本身就是一道限流閘門 ——
> 第 201 個請求根本進不來。
> **打開虛擬執行緒之後那道閘門沒有了**，
> **於是連線池的 `connectionTimeout` 變成了唯一的限流機制。**
>
> 📌 **實務結論**：
> **打開虛擬執行緒之後，`connectionTimeout` 比以前更重要，而且應該設得更短。**
> 30 秒的預設值在這裡是災難 —— 它會讓幾千個虛擬執行緒一起卡 30 秒。

⚠️ **兩個要注意的地方**：

| 注意 | 說明 |
|---|---|
| **池大小不需要因為虛擬執行緒而變大** | 資料庫的處理能力沒有改變（1.6.2 的曲線一模一樣） |
| **`synchronized` 會釘住載體執行緒**（Java 21） | JDBC 驅動內部若有 `synchronized` 區塊，虛擬執行緒的優勢會打折；Java 24 之後改善 |

> 🔴 **本章沒有驗證的**：真實 JDBC 驅動（MySQL Connector/J）在虛擬執行緒下的 pinning 行為。
> H2 是 in-process 的，量不到這件事。**要在你自己的環境上用 `-Djdk.tracePinnedThreads=full` 實測。**

---

## 1.7 五個逾時

### 1.7.0 實測：你寫的值，不一定是生效的值 ★

**先看這個，因為它會讓你重新檢查自己專案的設定。**

**實驗（F3）**：故意寫一些「太小」的值，看 HikariCP 怎麼處理。

```
=== F3 HikariCP 對設定值的下限與修正 ===
  寫下 connectionTimeout=100        → 🔴 直接拋例外：connectionTimeout cannot be less than 250ms
  寫下 validationTimeout=100        → 🔴 直接拋例外：validationTimeout cannot be less than 250ms

  WARN HikariConfig -- idleTimeout is less than 10000ms, setting to default 600000ms.
  寫下 idleTimeout=5000             → 實際 idleTimeout=600000      ⚠️ 差 120 倍
                                      （★ 這一條有前提，見下方的追加實驗 F3-B）

  WARN HikariConfig -- maxLifetime is less than 30000ms, setting to default 1800000ms.
  寫下 maxLifetime=10000            → 實際 maxLifetime=1800000     ⚠️ 差 180 倍

  WARN HikariConfig -- leakDetectionThreshold is less than 2000ms or more than maxLifetime, disabling it.
  寫下 leakDetectionThreshold=500   → 實際 leakDetectionThreshold=0  🔴 直接【關掉】

  WARN HikariConfig -- keepaliveTime is less than 30000ms, disabling it.
  寫下 keepaliveTime=10000          → 實際 keepaliveTime=0          🔴 直接【關掉】
```

> 🔴🔴 **`leakDetectionThreshold=500` 的結果是「洩漏偵測被關掉」。**
>
> **你以為你開了它，其實你關了它。**
> **而唯一的線索是一行 WARN 日誌** —— 在一個啟動時會印幾百行日誌的服務裡，
> 那一行不會有人看到。

**這張表值得貼在專案的 wiki 上**：

| 設定 | 下限 | 低於下限時 | 預設值（HikariCP 5.0.1 實測） |
|---|---|---|---|
| `connectionTimeout` | 250 ms | 🔴 **拋例外**（啟動失敗） | 30,000 ms |
| `validationTimeout` | 250 ms | 🔴 **拋例外** | 5,000 ms |
| `idleTimeout` | 10,000 ms | ⚠️ 靜默改成預設 600,000（**★ 只在可伸縮池上**，見 F3-B） | 600,000 ms |
| `maxLifetime` | 30,000 ms | ⚠️ 靜默改成預設 1,800,000 | 1,800,000 ms |
| `keepaliveTime` | 30,000 ms | 🔴 **靜默關閉** | 0（關閉） |
| `leakDetectionThreshold` | 2,000 ms | 🔴 **靜默關閉** | 0（關閉） |

**其他預設值**（同樣是 F3 實測）：

```
maximumPoolSize=10  minimumIdle=10  autoCommit=true  isolateInternalQueries=false  readOnly=false
```

⚠️ **`minimumIdle` 的預設值等於 `maximumPoolSize`** ——
也就是說**預設就是固定大小的池**（1.6.6 建議的那一種）。
**只有當你明確設定 `minimumIdle` 時，池才會變成可伸縮的。**

**★ 追加實驗 F3-B：`idleTimeout` 那一列有一個前提**

上面那一列是在**可伸縮池**（`minimumIdle < maximumPoolSize`）上量到的。
把池換成**固定大小**（也就是預設、也是 1.6.6 建議的那一種）再跑一次：

```
=== F3-B 同樣寫 idleTimeout=5000，兩種池 ===
  minimumIdle 沒設（= maximumPoolSize = 10，固定大小池）
      WARN HikariConfig -- idleTimeout has been set but has no effect
                           because the pool is operating as a fixed size pool.
      → 實際 idleTimeout = 5000      ★ 值【沒有】被改掉

  minimumIdle=2、maximumPoolSize=10（可伸縮池）
      WARN HikariConfig -- idleTimeout is less than 10000ms, setting to default 600000ms.
      → 實際 idleTimeout = 600000    ★ 被改掉了
```

📌 **兩種情況、兩行不同的 WARN、兩個不同的結果**：

| 池的型態 | 寫 `idleTimeout=5000` 的下場 |
|---|---|
| **固定大小**（`minIdle == maxPool`） | 值**保留**，但**完全無效**（1.7.3 說的就是這件事） |
| **可伸縮**（`minIdle < maxPool`） | 值被**靜默改成 600,000** |

⚠️ **所以「`idleTimeout` 會被改掉」與「`idleTimeout` 沒有作用」是兩件不同的事，
而它們取決於一個你可能沒設過的參數（`minimumIdle`）。**

> 📌 **這比原本那一列更值得記住**：
> **同一個「不合法的值」，在兩種設定下有兩種完全不同的處理方式** ——
> 而你唯一能分辨的方法，是**去讀那一行 WARN 到底寫了什麼**，
> 或者**把值讀回來比對**（1.12.3 那條守門測試做的就是後者）。

### 1.7.1 `connectionTimeout`：等連線等多久

```yaml
connection-timeout: 3000    # 等不到連線就失敗
```

**它管的是「從呼叫 `getConnection()` 到拿到連線」這一段，不管之後的事。**

**實測（F8）**：

```
  ① connectionTimeout=1s，跑一句 2 秒的查詢 → 2020 ms，沒有逾時
     👉 connectionTimeout 只管『等連線』，連線到手之後它就不管了
```

**該設多少？** 一個實用的推理：

| 想法 | 值 |
|---|---|
| 「等久一點比較不會失敗」 | 🔴 **30 秒（預設）** —— 過載時 847 個請求全部卡 30 秒，執行緒池先爆 |
| **「快速失敗，把壓力擋在外面」** ✅ | **2～3 秒** |
| 判準 | **比你的 HTTP 逾時短** —— 不然使用者早就走了，你還在等 |

> 📌 **這是 1.2.3「池是限流器」那個觀念的直接應用**：
> **等不到連線 = 系統已經滿了 = 應該立刻告訴上游，而不是讓它一起卡住。**
> 05-service 站 06 章的熔斷器、04-controller 站的 503 回應，都接在這個決定後面。

⚠️ **注意它與 JDBC URL 上的 `connectTimeout` 是兩件事**：

| | Hikari 的 `connectionTimeout` | URL 的 `connectTimeout` |
|---|---|---|
| 管什麼 | **等池給我一條連線** | **建立 TCP 連線 + 認證** |
| 超時的意思 | 池滿了，或連不上資料庫 | 資料庫沒回應 |
| 誰在等 | 你的業務執行緒 | 池的建連線執行緒 |

### 1.7.2 `validationTimeout`：驗證要等多久

```yaml
validation-timeout: 1000    # 必須小於 connection-timeout
```

**借出前那次 `isValid()` 的逾時**（1.5.1 的第 ③ 步）。

⚠️ **兩個實務要點**：

1. **HikariCP 預設用 JDBC 4 的 `Connection.isValid()`**，不需要 `connectionTestQuery`。
   **只有在驅動不支援時**才設 `connection-test-query: SELECT 1`
   —— 設了它反而**多一次真的往返**。
2. **有一個 500 ms 的「免驗證窗口」（`aliveBypassWindow`）**：
   距離上次使用不到 500 ms 的連線**不會被驗證**。
   **這是效能與安全的取捨** —— 而它也解釋了 F4-B 為什麼救不了。

### 1.7.3 `idleTimeout`：閒置多久之後退休

```yaml
idle-timeout: 600000       # 10 分鐘（預設）
```

**⚠️ 只有在 `minimumIdle < maximumPoolSize` 時才有作用。**
固定大小的池（1.6.6 建議的做法）裡，這個值**完全無效**。

### 1.7.4 `maxLifetime`：一條連線最多活多久 ★

```yaml
max-lifetime: 1740000      # 29 分鐘
```

**這是這五個裡最需要「跟別人對齊」的一個**：

```
maxLifetime  <  資料庫的 wait_timeout
maxLifetime  <  負載平衡器 / proxy 的閒置逾時
maxLifetime  <  雲端 NAT gateway 的閒置逾時（AWS 是 350 秒！）
```

> 📌 **實務上的建議值**：**取上面三個裡最小的那一個，再減 30～60 秒。**
>
> **為什麼要減**：避免「你正要用它的那一刻，對方正好關掉它」——
> 也就是 F4-B 那個池救不了的情況。

⚠️ **HikariCP 會對每條連線的 `maxLifetime` 加一個小的隨機變異**，
**避免所有連線在同一秒一起退休** —— 那會造成一個延遲尖峰。

**具體是多少？** 本章直接反編譯 `HikariCP-5.0.1.jar` 的 `HikariPool.createPoolEntry()` 核對過：

```java
final long variance = maxLifetime > 10_000 ? ThreadLocalRandom.current().nextLong(maxLifetime / 40) : 0;
//                                                                                 ^^^^^^^^^^^^^^^ 最多 2.5%
```

**所以每條連線真正的壽命是 `maxLifetime - [0, maxLifetime/40)`** ——
29 分鐘的設定，實際落在 **28 分 16 秒 ～ 29 分**之間。
⚠️ 而 `maxLifetime <= 10 秒` 時完全沒有變異（不過那個值本來就會被改成預設，1.7.0）。
**這是「雪崩」在連線池上的版本**（05-service 站 05 章 5.7.2 講過快取雪崩，同一個模式）。

**AWS 那個 350 秒特別值得注意**：

> 🔴 **NAT Gateway 會在閒置 350 秒後【靜默丟棄】連線** ——
> 不送 RST、不通知任何一端。
> 於是應用程式這邊的連線看起來還活著，
> 直到你用它的時候卡住（然後靠 `socketTimeout` 才失敗，1.4.3）。
>
> **對策**：`maxLifetime` 設成 5 分鐘以下，或用 `keepaliveTime`。

### 1.7.5 `keepaliveTime`：閒置時定期戳一下

```yaml
keepalive-time: 120000     # 2 分鐘（預設 0 = 關閉）
```

**對閒置在池裡的連線定期做一次驗證，讓它在網路設備眼中「不是閒置的」。**

| 什麼時候需要 | 理由 |
|---|---|
| 中間有 NAT / LB / proxy 會砍閒置連線 | 讓連線保持活躍 |
| `minimumIdle < maximumPoolSize` 且離峰很長 | 避免離峰後第一波請求慢（1.6.6） |
| 一般情況 | ⚠️ 不需要 —— 借出時的驗證已經夠了 |

### 1.7.6 ★ 三種「逾時」管的是三件不同的事

**這是實務上最常混淆的一組概念。實驗（F8）把三者放在一起**：

```
=== F8 connectionTimeout / queryTimeout / 交易 timeout ===
  ① connectionTimeout=1s，跑一句 2 秒的查詢 → 2020 ms，沒有逾時
     👉 connectionTimeout 只管『等連線』，連線到手之後它就不管了

  ② setQueryTimeout(1)，跑一句 3 秒的查詢 → 3011 ms，🔴 沒有被中斷

  ③ 交易 timeout=1s：Java 睡了 2 秒之後【還沒有】被打斷（2044 ms）
  ③ ✅ 第二句 SQL 才炸：TransactionTimedOutException
     訊息：Transaction timed out: deadline was Mon Aug 31 11:01:01 CST 2026
     👉 交易 timeout 不是『方法逾時』——中間沒有 SQL 就沒有檢查點
```

**三者的分工表**：

| 逾時 | 管什麼 | 誰執行它 | 逾時後 |
|---|---|---|---|
| `connectionTimeout` | 等池給連線 | **池** | `SQLTransientConnectionException` |
| `Statement.setQueryTimeout` | **一句 SQL 跑多久** | **資料庫 / 驅動** | `SQLTimeoutException`（各家不同） |
| `@Transactional(timeout=n)` | 整個交易的**期限** | **Spring** | `TransactionTimedOutException` |

⚠️⚠️ **② 那個 🔴 值得解釋**：`setQueryTimeout(1)` 沒有中斷那句 3 秒的查詢。

> **原因**：`setQueryTimeout` 是**由資料庫或驅動實作的**，不是 Java 幫你算的。
> 這個實驗裡跑的是 H2 的一個 Java 函式別名，**H2 沒有辦法中斷它**。
>
> 🔴 **在 MySQL 上的行為不同**（Connector/J 會另開一個連線送 `KILL QUERY`），
> **而本章沒有 MySQL 可以驗證這件事。**
> 📌 **實務結論**：**不要假設 `setQueryTimeout` 一定有效** ——
> 在你的環境上實測一次。**07-mysql 站 04 章會做這個實測。**

⚠️ **③ 是 05-service 站 02 章 2.5.3「`timeout` 不是方法逾時」的實測版本**：

> **Spring 的交易 `timeout` 只在「下一次要跟資料庫講話」時被檢查。**
> 中間那 2 秒的 Java 運算（或外部 API 呼叫）**完全不會被打斷**。
>
> **所以它擋不住「在交易裡呼叫慢的外部 API」這個問題** ——
> 那件事只能靠「不要在交易裡呼叫外部 API」來解決。

---

## 1.8 讓「佔用時間」變短，比把池加大有用

1.6.4 的公式有兩個變數，而**大部分人只想著調右邊那個**：

```
最大吞吐 = 池大小 ÷ 佔用時間
              ↑          ↑
        大家都調這個   ★ 但這個的槓桿大得多
```

**理由**：池大小加倍，吞吐**最多**加倍（而且 1.6.2 顯示通常更少）。
**佔用時間減半，吞吐直接加倍，而且資料庫的負載沒有增加。**

### 1.8.1 佔用時間都花在哪裡：一張檢查表

| 花在哪 | 典型時間 | 怎麼縮短 | 哪一章 |
|---|---|---|---|
| **在交易裡呼叫外部 API** | 🔴 **50～3000 ms** | 移出交易（`AFTER_COMMIT`） | 05-service 06 章 |
| **N+1 查詢** | 🔴 200 句 × 0.4 ms | 批次查詢 | 00 章 0.6 判準 2、04 章 |
| 交易開得太早（方法一進去就開） | 10～50 ms | 縮小 `@Transactional` 範圍 / `TransactionTemplate` | 05-service 02 章 2.10 |
| **唯讀查詢也開了寫入交易** | — | `readOnly = true` + 路由到 replica | 05 章 5.7 |
| 在交易裡做複雜的 Java 計算 | 5～100 ms | 算完再開交易 | — |
| 在交易裡寄信 / 推播 / 寫檔 | 🔴 100 ms+ | 移出交易 | 05-service 06 章 |
| 真正的 SQL 執行 | 5～20 ms | 索引、批次 | 07-mysql 03 章 |

> 🔴 **第一列是壓倒性的第一名。**
> 一個 300 ms 的外部 API 呼叫，會讓「佔用時間」從 25 ms 變成 325 ms ——
> **同一個池的最大吞吐從 400 掉到 30。**
>
> ⚠️ **而症狀是「資料庫很閒但服務停止回應」** —— 正好是 00 章事故 2 的形狀。
> **這也是為什麼那個事故的診斷這麼困難：兇手根本不在資料庫這邊。**

### 1.8.2 一個省事的技巧：`LazyConnectionDataSourceProxy`

```java
@Bean
DataSource dataSource(HikariDataSource realDataSource) {
    // ★ 交易開始時【不】借連線，等到第一句 SQL 才借
    return new LazyConnectionDataSourceProxy(realDataSource);
}
```

**它解決兩個具體問題**：

| 問題 | 沒有它 | 有它 |
|---|---|---|
| `@Transactional` 的方法**提早回傳**（例如快取命中） | 借了一條連線又立刻還 | **完全不借** |
| 交易一開始先做 200 ms 的 Java 計算才下第一句 SQL | 那 200 ms 一直佔著連線 | **那 200 ms 不佔連線** |

⚠️ **代價**：`Connection` 的取得被延後，所以
**「連不上資料庫」這件事會在第一句 SQL 時才爆**，而不是在交易開始時。
**這通常是好事**（錯誤發生在更接近原因的地方），但它會改變你熟悉的堆疊長相。

---

## 1.9 診斷：`Connection is not available` ★★

### 1.9.1 症狀

```
org.springframework.jdbc.CannotGetJdbcConnectionException: Failed to obtain JDBC Connection
    ...
Caused by: java.sql.SQLTransientConnectionException:
    shop-pool - Connection is not available, request timed out after 3002ms.
```

**它幾乎總是伴隨這三個現象**：

```
✅ 應用程式 CPU 正常、記憶體正常、GC 正常
✅ 資料庫 CPU 低、沒有慢查詢
🔴 所有 API 的延遲一起爆炸
```

### 1.9.2 五分鐘診斷流程

```
                    ┌──────────────────────────────────────────┐
                    │ 看池的指標（1.10）：active / idle / waiting │
                    └────────────────┬─────────────────────────┘
                                     ↓
            ┌────────────────────────┴───────────────────────────┐
            │ total 遠小於 minimumIdle（常常是 0）？                 │
            └──────┬──────────────────────────────┬───────────────┘
                是 │（池連建都建不起來，F16）       │ 否（池是滿的）
                   ↓                                ↓
   ┌───────────────────────────────┐  ┌──────────────────────────────────┐
   │ ★ 病因 A：連不上資料庫          │  │ active == total 且 waiting > 0    │
   │  - 網路 / DNS / 防火牆          │  │  → ★ 連線全部借出去了              │
   │  - 帳密錯 / 權限錯              │  └───────────────┬──────────────────┘
   │  - 資料庫的 max_connections 滿了 │                  ↓
   │  → 看日誌裡的 cause（1.9.3）    │  ┌──────────────────────────────────┐
   └───────────────────────────────┘  │ 資料庫端在做什麼？（SHOW PROCESSLIST）│
                                       └──────┬─────────────────┬─────────┘
                                       都在跑 │                 │ 都在 Sleep
                                              ↓                 ↓
                            ┌─────────────────────────┐ ┌────────────────────────┐
                            │ ★ 病因 B：查詢太慢/太多   │ │ ★ 病因 C：連線被借走沒還  │
                            │  → 慢查詢日誌、EXPLAIN    │ │   或交易裡在等別的東西    │
                            │  → 07-mysql 站 03/05 章  │ │  → leakDetection（1.9.4）│
                            └─────────────────────────┘ │  → thread dump（1.9.5）  │
                                                        └────────────────────────┘
```

**三種病因的快速對照**：

| | A 連不上 | B 查詢太慢 | C 借走沒還 |
|---|---|---|---|
| `total` | **常常是 0**（F16） | = max | = max |
| `active` | 0 | = max | = max |
| 資料庫的連線狀態 | 沒有連線 | **`Query` / `Sending data`** | **`Sleep`** ★ |
| 資料庫 CPU | 低 | **高** | **低** ★ |
| 重啟服務有沒有效 | ❌ 沒效 | ⚠️ 短暫 | ✅ **有效**（但會再犯）★ |

> 📌 **最後一列是最快的分類器**：
> **「重啟就好、過幾天又犯」= 幾乎確定是 C（洩漏）。**
> 00 章事故 2 正是這個形狀。

### 1.9.3 ⚠️ 「看 cause 就知道是哪一種」——這個說法只對一半

**很多文章會告訴你**：「例外有 cause 就是連不上，沒有 cause 就是池滿了。」

**實驗（F5-A）測了這件事**：

```
=== F5-A 兩種「Connection is not available」===
  [① 池被佔滿]
    java.sql.SQLTransientConnectionException
    訊息：f5-busy - Connection is not available, request timed out after 1009ms.
    cause：（沒有）

  [② 資料庫連不上（connectionTimeout=1000）]
    java.sql.SQLTransientConnectionException
    訊息：f5-down-1000 - Connection is not available, request timed out after 1002ms.
    cause：（沒有）        ← 🔴 這裡應該要有 cause 才對

  [② 資料庫連不上（connectionTimeout=3000）]
    java.sql.SQLTransientConnectionException
    訊息：f5-down-3000 - Connection is not available, request timed out after 3007ms.
    cause：JdbcSQLNonTransientConnectionException / Connection is broken:
           "java.net.ConnectException: Connection refused: 127.0.0.1:19999"
    cause：ConnectException / Connection refused
```

> 🔴 **同一種病因（連不上），逾時 1 秒時「沒有 cause」，逾時 3 秒時「有 cause」。**

**原因**：HikariCP 只有在「**最近一次建立連線的嘗試失敗了**」時才會把它掛成 cause。
逾時只有 1 秒時，那次嘗試還沒有失敗完 —— **於是它沒有東西可以掛**。

> 📌 **修正後的說法**：
> - **有 cause** → ✅ 幾乎可以確定是病因 A（連不上 / 認證失敗），而且 cause 直接告訴你原因。
> - **沒有 cause** → ⚠️ **不能推論任何事**。可能是 A（逾時太短），也可能是 B 或 C。
>
> **可靠的分類器只有兩個：池的指標（1.10）與資料庫端的連線狀態。**

### 1.9.4 `leakDetectionThreshold`：把兇手的堆疊印出來

**這是診斷病因 C 最直接的工具。**

```yaml
leak-detection-threshold: 20000    # 借出超過 20 秒沒還 → 印出借用者的堆疊
```

**實驗（F5-B）**：故意寫一個借了不還的方法。

```java
private Connection leakIt(HikariDataSource ds) throws Exception {
    Connection con = ds.getConnection();
    try (Statement st = con.createStatement()) { st.executeQuery("SELECT 1").close(); }
    return con;                                       // 🔴 沒有 close
}
```

**輸出**：

```
WARN com.zaxxer.hikari.pool.ProxyLeakTask -- Connection leak detection triggered for
     conn0: url=jdbc:h2:mem:f5b user=SA on thread main, stack trace follows
java.lang.Exception: Apparent connection leak detected
    at com.zaxxer.hikari.HikariDataSource.getConnection(HikariDataSource.java:100)
    at lab01.F5DiagnosisTest.leakIt(F5DiagnosisTest.java:83)        ← ★ 兇手在這裡
    at lab01.F5DiagnosisTest.連線洩漏的偵測訊息(F5DiagnosisTest.java:70)
    ...
```

```
  此刻 active=1 idle=2
  歸還之後 active=0
```

> ✅ **它直接指出了「是哪一行程式碼借走了這條連線」。**
> **這是 00 章事故 2 那 4 小時可以縮短成 5 分鐘的原因。**

⚠️ **四個使用要點**：

| 要點 | 說明 |
|---|---|
| **它只告警，不回收** | HikariCP **刻意**沒有 DBCP 的 `removeAbandoned` —— 自動回收會讓 bug 永遠存在 |
| **值要大於最慢的正常操作** | 設 20 秒的話，一個正常跑 25 秒的批次也會被告警（吵） |
| **值必須 ≥ 2000 ms**，否則**被靜默關閉** | F3 實測（1.7.0） |
| ✅ **正式環境可以一直開著** | 開銷只有「每條借出的連線多一個排程任務」 |

### 1.9.5 Thread dump 怎麼看

**當你連 leak detection 都沒開的時候，thread dump 是最後的辦法**：

```bash
jcmd <pid> Thread.print > dump.txt
# 或
jstack <pid> > dump.txt
```

**要找的三種樣子**：

```
① 大家都在等連線 → 病因是 B 或 C（池滿了）
"http-nio-8080-exec-42" ... waiting on condition
    at jdk.internal.misc.Unsafe.park(Native Method)
    at java.util.concurrent.SynchronousQueue$TransferStack.awaitFulfill(...)
    at com.zaxxer.hikari.util.ConcurrentBag.borrow(ConcurrentBag.java:151)      ← ★
    at com.zaxxer.hikari.pool.HikariPool.getConnection(HikariPool.java:180)
    at com.example.shop.order.OrderApplicationService.create(...)
```

```
② 有人拿著連線在等【別的東西】 → 病因 C 的一種：交易裡呼叫外部 API
"http-nio-8080-exec-7" ... runnable
    at java.net.SocketInputStream.socketRead0(Native Method)                     ← ★ 在等網路
    at okhttp3.internal.http2.Http2Stream.waitForIo(...)
    at com.example.shop.payment.PaymentGateway.charge(...)
    at com.example.shop.order.OrderApplicationService.create(...)                ← ★ 在交易裡
```

```
③ 有人拿著連線在等資料庫 → 病因 B
"http-nio-8080-exec-3" ... runnable
    at java.net.SocketInputStream.socketRead0(Native Method)
    at com.mysql.cj.protocol.a.SimplePacketReader.readHeader(...)               ← ★ 在等 SQL 回來
```

> 📌 **一個很省時間的技巧**：
> ```bash
> grep -c "ConcurrentBag.borrow" dump.txt     # 有多少人在等連線
> grep -B5 "PaymentGateway" dump.txt          # 有沒有人在交易裡呼叫外部 API
> ```
> **第一個數字如果是幾百，那就是池滿了；第二個如果有東西，兇手就找到了。**

### 1.9.6 資料庫端怎麼看

⚠️ **本機沒有 MySQL，以下指令【本章沒有實測】，07-mysql 站 05 章會完整處理。**

```sql
-- 誰連著、在做什麼
SHOW PROCESSLIST;
SELECT * FROM performance_schema.processlist WHERE command != 'Sleep' ORDER BY time DESC;

-- 連線數 vs 上限
SHOW STATUS LIKE 'Threads_connected';
SHOW VARIABLES LIKE 'max_connections';

-- 歷史最高（用來判斷「是不是快滿了」）
SHOW STATUS LIKE 'Max_used_connections';

-- 有沒有人被鎖住
SELECT * FROM performance_schema.data_locks;
```

**`Command` 欄位的三種值對應 1.9.2 的三種病因**：

| `Command` | 意義 | 病因 |
|---|---|---|
| `Sleep` | **連著但沒在做事** | **C**（借走沒還，或交易裡在等別的東西） |
| `Query` / `Execute` | 正在跑 SQL | B |
| （沒有連線） | — | A |

### 1.9.7 三個真實案例

| 症狀 | 指標 | 根因 | 修法 |
|---|---|---|---|
| 每兩週半夜掛一次，重啟就好 | `active` 慢慢爬升不會降 | **連線洩漏**（00 章事故 2） | 找出那段 `getConnection()` 沒有 try-with-resources |
| 每天早上 09:00 卡三分鐘 | `waiting` 尖峰，`active` 滿 | 開盤流量 + **冷池**（`minimumIdle` 太小） | `minimumIdle = maximumPoolSize`（1.6.6） |
| 促銷開始 30 秒後全站慢 | `active` 滿，資料庫 CPU 低，狀態全是 `Sleep` | **交易裡呼叫金流 API**（1.8.1 第一列） | 把外部呼叫移出交易 |

> 📌 **三個案例的共同點**：
> **沒有一個是「資料庫不夠力」，也沒有一個靠加大池解決。**
> **加大池對第 1 和第 3 個只會讓症狀更晚出現、更難查。**

---

## 1.10 監控：五個指標

### 1.10.1 要看哪五個

| 指標（Micrometer 名稱） | 型別 | 意義 | 正常 | 該告警 |
|---|---|---|---|---|
| `hikaricp.connections.active` | gauge | 借出去的 | < 70% of max | **持續 = max** |
| `hikaricp.connections.idle` | gauge | 閒著的 | > 0 | **長期 = 0** |
| `hikaricp.connections.pending` | gauge | **在排隊的執行緒數** | **0** | **> 0 持續超過 1 分鐘** ★ |
| `hikaricp.connections.timeout` | **counter** | **借連線逾時的累計次數** | **不增加** | **只要開始增加** ★★ |
| `hikaricp.connections.usage` | summary | 一條連線被借走多久 | 接近你的交易長度 | **max > 1 秒** |
| `hikaricp.connections.acquire` | summary | 借一條要等多久 | **< 1 ms** | **max > 100 ms** ★ |

⚠️ **`hikaricp.connections.timeout` 是這張表裡最直接的一個，卻最常被漏掉**：
**它就是「有多少個請求因為等不到連線而失敗」的計數器** ——
不需要推論，它直接等於 1.9.1 那個例外被拋出的次數。

**完整的清單**（本章 F14 實測，Spring Boot 3.2.5 + Micrometer 1.12）：

```
hikaricp.connections            hikaricp.connections.acquire     hikaricp.connections.active
hikaricp.connections.creation   hikaricp.connections.idle        hikaricp.connections.max
hikaricp.connections.min        hikaricp.connections.pending     hikaricp.connections.timeout
hikaricp.connections.usage
```

> 📌 **如果只能看一個，看 `pending`（`ThreadsAwaitingConnection`）。**
> **它是唯一一個「正常值就是 0」的指標** —— 只要它不是 0，就代表已經有人在等了。
>
> **而它也是最好的早期預警**：
> 在 `active` 撞到上限之前，`pending` 就會開始偶爾冒出 1、2。

### 1.10.2 實測：過載時的指標時間軸

**實驗（F6）**：40 個併發打進一個大小 5 的池，每個請求佔用 200 ms。

```
=== F6 40 個併發打進一個大小 5 的池（每個請求佔用 200 ms）===
  時間        total   active    idle  waiting
  0.2s            5        5       0       33   ← 有人在排隊
  0.4s            5        5       0       28   ← 有人在排隊
  0.6s            5        5       0       22   ← 有人在排隊
  0.8s            5        5       0       17   ← 有人在排隊
  1.1s            5        5       0       12   ← 有人在排隊
  1.3s            5        5       0        7   ← 有人在排隊
  1.5s            5        5       0        1   ← 有人在排隊
  1.7s            5        1       4        0
  1.9s            5        0       5        0
  結束            5        0       5        0   ← 全部做完
```

**這就是「池滿了」的標準長相**：`active = total`、`idle = 0`、`waiting > 0`。

⚠️ **注意 `total` 從頭到尾都是 5** ——
**池不會因為有人在等就多建連線**（它已經到 `maximumPoolSize` 了）。
**這是 1.2.3「池是限流器」的具體樣子。**

### 1.10.3 HikariCP 自己的日誌

**把這個 logger 開到 DEBUG，池每 30 秒會自己報告一次**：

```yaml
logging:
  level:
    com.zaxxer.hikari.pool.HikariPool: DEBUG
```

**實測輸出（F6）**：

```
DEBUG c.z.h.pool.HikariPool -- f6 - Pool stats (total=5, active=5, idle=0, waiting=35)
DEBUG c.z.h.pool.HikariPool -- f6 - Fill pool skipped, pool has sufficient level or currently being filled (queueDepth=0).
DEBUG c.z.h.pool.HikariPool -- f6 - Added connection conn1: url=jdbc:h2:mem:f6 user=SA
```

> 📌 **`Pool stats` 這一行就是 00 章開場那一行。**
> ⚠️ **正式環境開 DEBUG 會很吵**（每 30 秒一行 × 每個池）。
> **建議**：平常關著，出事時用 Actuator 的 `/actuator/loggers` **動態打開**
> —— 不用重啟服務（02-spring-boot 站 05 章「日誌與 Actuator」講過）。

### 1.10.4 接上 Actuator 與 Prometheus

```xml
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-actuator</artifactId>
</dependency>
<dependency>
  <groupId>io.micrometer</groupId>
  <artifactId>micrometer-registry-prometheus</artifactId>
</dependency>
```

```yaml
spring:
  datasource:
    hikari:
      register-mbeans: true          # ★ 讓 JMX 也看得到
management:
  endpoints:
    web:
      exposure:
        include: health,metrics,prometheus,loggers
  metrics:
    tags:
      application: shop-service
```

**三條建議的告警規則**：

```
# ① 有人在排隊 —— 最早的預警
hikaricp_connections_pending > 0 for 1m
    → warning：「池開始不夠用了」

# ② 已經有請求拿不到連線 —— 最直接的一條
rate(hikaricp_connections_timeout_total[5m]) > 0
    → critical：「有請求因為等不到連線而失敗」

# ③ 借連線變慢 —— 已經在痛了
hikaricp_connections_acquire_seconds_max > 0.1 for 2m
    → critical：「借一條連線最久要 100 ms 以上」

# ④ 連線一直借出去不還 —— 洩漏的形狀
min_over_time(hikaricp_connections_idle[30m]) == 0 and hikaricp_connections_active >= max
    → critical：「30 分鐘內沒有任何一刻是閒的」
```

⚠️⚠️ **③ 為什麼不用 `histogram_quantile(0.99, …_bucket)`？**

**因為預設沒有 `_bucket`。** 本章 F14 直接抓 `/actuator/prometheus` 的內容核對過：

```
# TYPE hikaricp_connections_acquire_seconds summary        ← ★ 是 summary，不是 histogram
# TYPE hikaricp_connections_acquire_seconds_max gauge
```

**summary 只會給你 `_count`、`_sum` 與 `_max`，沒有 bucket，`histogram_quantile` 算不出東西。**

**想要真的 p99，必須明確打開**：

```yaml
management:
  metrics:
    distribution:
      percentiles-histogram:
        hikaricp.connections.acquire: true      # ★ 打開之後才會有 _bucket
```

**打開之後（F14 實測）**：型別從 `summary` 變成 `histogram`，
`/actuator/prometheus` 上出現 **69 行** `hikaricp_connections_acquire_seconds_bucket`。

> ⚠️ **代價**：bucket 會讓時間序列的數量暴增（每個 bucket 一條）。
> **只對真正需要百分位的指標打開**，不要整包開。

> ⚠️ **④ 那條特別有用**，因為它抓的是「**趨勢**」而不是「瞬間值」。
> **連線洩漏的特徵就是「`idle` 單調遞減、永遠不回來」** ——
> 而任何一個瞬間看起來都像「流量比較大」。

---

## 1.11 要不要兩個池

### 1.11.1 實測：一個批次任務會不會餓死線上請求

**實驗（F7）**：線上請求每 5 ms 進來一個、每個佔用連線 20 ms；
批次任務有 8 個 worker，每個佔用連線 800 ms。

```
=== F7 批次任務 × 線上請求 ===
  ① 只有線上請求（池 10）          p50= 27.2 ms  p95=  30.0 ms  max=   31.8 ms  失敗=0
  ② 共用一個池 10 + 批次 8 執行緒   p50=211.1 ms  p95= 605.9 ms  max=  792.9 ms  失敗=0
  ③ 線上池 8 + 批次池 2            p50= 27.8 ms  p95=  30.1 ms  max=   37.8 ms  失敗=0
```

> 🔴 **共用一個池：p50 慢 7.8 倍，p95 慢 20 倍。**
> ✅ **拆成兩個池（而且線上池還變小了，從 10 變 8）：幾乎完全恢復。**

⚠️ **注意 ③ 的線上池比 ① 還小（8 < 10），延遲卻幾乎一樣。**

> 📌 **這就是隔艙（bulkhead）模式的核心價值**：
> **重要的不是「你有多少資源」，而是「別人搶不搶得走」。**
> （05-service 站 06 章 6.7.4 講過執行緒池的隔艙，這是它在連線池上的版本。）

### 1.11.2 什麼時候該分池

| 情境 | 分不分 | 怎麼分 |
|---|---|---|
| **批次 / 排程 / 匯出** | ✅ **分** | 獨立的小池（2～4） |
| **讀寫分離**（primary / replica） | ✅ **分** | 兩個 `DataSource` + 路由（05 章 5.7） |
| **多租戶，要隔離大客戶** | ⚠️ 看情況 | 通常用限流比較好，不是分池 |
| 一般的 CRUD API | 🔴 **不分** | 一個池就好 —— 分池會讓總連線數難以掌握 |

### 1.11.3 分池的三個代價

| 代價 | 說明 |
|---|---|
| **總連線數變難算** | 1.6.5 步驟 4 的加總要把每個池都算進去 |
| **交易不能跨池** | ⚠️ 兩個池 = 兩個 `PlatformTransactionManager` = **兩個交易** |
| **設定與監控翻倍** | 每個池都要有自己的告警 |

⚠️ **第二點最容易出事**：

```java
@Transactional                                  // ★ 用的是哪一個交易管理員？
public void doSomething() {
    onlineRepository.save(x);                   // 池 A
    batchRepository.save(y);                    // 池 B ← 🔴 不在同一個交易裡
}
```

> 🔴 **這會回到 00 章 0.9.2 的孤兒訂單問題** —— 兩個池就是兩個交易。
> **對策**：**分池的邊界必須與「業務動作」的邊界一致** ——
> 也就是說，**批次池只給批次用，線上流程一行都不准碰它**。
> **05 章 5.7 會給一條 ArchUnit 規則守這件事。**

### 1.11.4 兩個池的設定長什麼樣

```java
@Configuration
public class DataSourceConfig {

    @Bean
    @Primary                                            // ★ 線上池是預設的
    @ConfigurationProperties("app.datasource.online")
    public HikariDataSource onlineDataSource() {
        return new HikariDataSource();
    }

    @Bean
    @ConfigurationProperties("app.datasource.batch")
    public HikariDataSource batchDataSource() {
        return new HikariDataSource();
    }

    @Bean @Primary
    public PlatformTransactionManager transactionManager(
            @Qualifier("onlineDataSource") DataSource ds) {
        return new DataSourceTransactionManager(ds);
    }

    /** ⚠️ 批次的交易管理員要明確指名使用（1.11.3 第二點）。 */
    @Bean
    public PlatformTransactionManager batchTransactionManager(
            @Qualifier("batchDataSource") DataSource ds) {
        return new DataSourceTransactionManager(ds);
    }
}
```

```java
@Transactional("batchTransactionManager")       // ★ 批次一定要指名
public void nightlySettlement() { … }
```

```yaml
app:
  datasource:
    online:
      jdbc-url: jdbc:mysql://db-primary.internal:3306/shop?...
      username: ${DB_USER}
      password: ${DB_PASSWORD}
      maximum-pool-size: 10
      minimum-idle: 10
      connection-timeout: 3000
      pool-name: shop-online
    batch:
      jdbc-url: jdbc:mysql://db-primary.internal:3306/shop?...
      username: ${DB_USER}
      password: ${DB_PASSWORD}
      maximum-pool-size: 3        # ★ 刻意小
      minimum-idle: 1             # ★ 批次不常跑，不需要一直暖著
      connection-timeout: 30000   # ★ 批次可以等久一點（與線上相反）
      pool-name: shop-batch
```

> 📌 **注意兩個池的 `connection-timeout` 是相反的**：
> **線上要「快速失敗」（3 秒），批次要「慢慢等」（30 秒）。**
> **這正是「同一個參數，在不同用途下有相反的最佳值」的好例子** ——
> 也是為什麼它們該分開。

---

## 1.12 shop-service 的最終設定

### 1.12.1 `application.yml`

```yaml
spring:
  datasource:
    # ── URL：每一個參數的理由見 1.4.4 ──────────────────────────────
    # ⚠️ 見下方「一個 YAML 的坑」——這裡【不能】用 > 或 >- 折行
    url: "jdbc:mysql://${DB_HOST:db-primary.internal}:3306/shop\
      ?connectionTimeZone=UTC&forceConnectionTimeZoneToSession=true&preserveInstants=true\
      &characterEncoding=utf8mb4&zeroDateTimeBehavior=CONVERT_TO_NULL\
      &sessionVariables=sql_mode='STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION'\
      &rewriteBatchedStatements=true\
      &cachePrepStmts=true&prepStmtCacheSize=250&prepStmtCacheSqlLimit=2048\
      &useServerPrepStmts=true&useLocalSessionState=true\
      &connectTimeout=3000&socketTimeout=30000&tcpKeepAlive=true\
      &sslMode=REQUIRED"
    username: ${DB_USER}
    password: ${DB_PASSWORD}

    hikari:
      # ── 池大小：計算過程見 1.6.5 ────────────────────────────────
      #   尖峰 400 TPS ÷ 4 個 Pod = 100 TPS/Pod
      #   佔用連線 25 ms → 100 × 0.025 = 2.5
      #   × 2（流量不平均）× 1.5（交易偶爾變慢）+ 2（排程）≈ 10
      #   ⚠️ 改 replicas 時要回來檢查：replicas × 10 + 其他 < max_connections(500)
      maximum-pool-size: 10
      minimum-idle: 10              # ★ 與 max 相同 = 固定大小的池（1.6.6，F9 實測冷池慢 1.9 倍）

      # ── 逾時：語意見 1.7 ───────────────────────────────────────
      connection-timeout: 3000      # ★ 快速失敗，比 HTTP 逾時短（1.7.1）
      validation-timeout: 1000      # 必須 < connection-timeout
      idle-timeout: 0               # minimum-idle == maximum-pool-size 時無作用（1.7.3）
      max-lifetime: 1740000         # 29 分：★ 必須 < MySQL wait_timeout(28800s) 與 LB 閒置逾時
      keepalive-time: 0             # 沒有會砍閒置連線的中間設備 → 不需要（1.7.5）

      # ── 診斷 ─────────────────────────────────────────────────
      leak-detection-threshold: 20000   # ★★ 借出 20 秒沒還就印堆疊（1.9.4）
                                        # ⚠️ 必須 >= 2000，否則被【靜默關閉】（F3 實測）
      register-mbeans: true             # 讓 JMX / Actuator 看得到（1.10.4）
      pool-name: shop-online            # ★ 日誌與指標都會帶這個名字

  jpa:
    open-in-view: false             # 05-service 站 03 章 3.9.4

management:
  endpoints:
    web:
      exposure:
        include: health,metrics,prometheus,loggers
  endpoint:
    health:
      probes:
        enabled: true               # ★ 沒有它就沒有 /actuator/health/liveness|readiness
      show-details: when-authorized
  health:
    db:
      enabled: true                 # ⚠️ 見 1.12.4

logging:
  level:
    com.zaxxer.hikari.pool.HikariPool: INFO   # 出事時用 /actuator/loggers 動態改成 DEBUG（1.10.3）
```

### 1.12.2 ⚠️ 一個 YAML 的坑：折行會把空格折進 URL 裡

那一長串 URL 很難讀，所以**幾乎每個人第一次都會想把它折行**。
而 YAML 最直覺的折行寫法 `>-`（folded scalar）在這裡是**錯的**：

```yaml
# 🔴 錯的：>- 會把每一個換行折成一個【空格】
url: >-
  jdbc:mysql://db-primary.internal:3306/shop
  ?connectionTimeZone=UTC&preserveInstants=true
  &characterEncoding=utf8mb4
```

**實際解析出來的字串**：

```
jdbc:mysql://db-primary.internal:3306/shop ?connectionTimeZone=UTC&preserveInstants=true &characterEncoding=utf8mb4
                                          ↑ 空格                                        ↑ 空格
```

🔴 **URL 裡多了兩個空格，驅動解析不了 —— 應用程式直接啟動失敗。**

**三種正確的寫法**：

```yaml
# ✅ ① 雙引號 + 反斜線續行（本節採用）—— 反斜線【吃掉】換行與後續縮排
url: "jdbc:mysql://db-primary.internal:3306/shop\
  ?connectionTimeZone=UTC&preserveInstants=true\
  &characterEncoding=utf8mb4"

# ✅ ② 就寫一行，不折（最不會出錯，代價是很長）
url: jdbc:mysql://db-primary.internal:3306/shop?connectionTimeZone=UTC&preserveInstants=true&characterEncoding=utf8mb4

# ✅ ③ 把參數拆成一個可讀的變數，再組起來
app:
  db:
    params: connectionTimeZone=UTC&preserveInstants=true&characterEncoding=utf8mb4
spring:
  datasource:
    url: jdbc:mysql://${DB_HOST}:3306/shop?${app.db.params}
```

⚠️ **`|`（literal scalar）更糟** —— 它保留換行字元，URL 裡會出現真的 `\n`。

> 📌 **這個坑的形狀和本站其他的坑一模一樣**：
> **它不會在 YAML 解析時報錯**（那是一個合法的 YAML 字串），
> 錯誤發生在三層之外的 JDBC 驅動裡，訊息是一句看不出原因的
> `No suitable driver` 或 `Malformed database URL`。
>
> ⚠️ **而它在「用 H2 的本機測試」上永遠不會出現** ——
> 因為測試用的是另一組 `spring.datasource.url`。

### 1.12.3 一條守門測試：確認設定「真的生效」

**F3 的實測顯示，你寫的值可能被靜默改掉。** 所以這一章的產出裡有一條守門測試：

```java
/**
 * ★ 守門測試：「我寫的設定，真的生效了嗎」。
 *
 * <p>它存在的理由是 1.7.0 的實測：HikariCP 會把不合法的值<b>靜默改掉</b>，
 * 而唯一的線索是一行沒有人會看到的 WARN。
 */
@SpringBootTest
class DataSourceConfigTest {

    @Autowired DataSource dataSource;

    @Test
    void 連線池的設定必須真的生效() {
        assertThat(dataSource).isInstanceOf(HikariDataSource.class);
        HikariDataSource ds = (HikariDataSource) dataSource;

        assertThat(ds.getPoolName()).isEqualTo("shop-online");
        assertThat(ds.getMaximumPoolSize()).isEqualTo(10);

        // ★ 固定大小的池（1.6.6）
        assertThat(ds.getMinimumIdle())
                .describedAs("minimumIdle 必須等於 maximumPoolSize —— 冷池在尖峰會慢 1.9 倍")
                .isEqualTo(ds.getMaximumPoolSize());

        // ★ 快速失敗（1.7.1）
        assertThat(ds.getConnectionTimeout())
                .describedAs("connectionTimeout 不可以用 30 秒的預設值")
                .isLessThanOrEqualTo(5_000);

        // ★★ 這一條是 1.7.0 那個陷阱的守門人
        assertThat(ds.getLeakDetectionThreshold())
                .describedAs("leakDetectionThreshold 被 HikariCP 靜默關掉了（值 < 2000ms 會變成 0）")
                .isGreaterThan(0);

        // ★ maxLifetime 要小於資料庫的 wait_timeout（1.7.4）
        assertThat(ds.getMaxLifetime())
                .describedAs("maxLifetime 必須小於資料庫 wait_timeout 與 LB 的閒置逾時")
                .isLessThan(1_800_000L);
    }
}
```

**它會紅嗎？把 `leak-detection-threshold` 改成 500 再跑一次（本章實測）**：

```
[ERROR] Tests run: 1, Failures: 1
[ERROR]   DataSourceConfigTest.連線池的設定必須真的生效:59
          [leakDetectionThreshold 被 HikariCP 靜默關掉了（值 < 2000ms 會變成 0）]
```

> ✅ **紅了，而且訊息直接說明了原因。**
> 這是 05-service 站 07 章 7.17 的原則：**一條從來沒紅過的守門測試等於沒有。**

### 1.12.4 ⚠️ 一個關於健康檢查的陷阱

```yaml
management:
  health:
    db:
      enabled: true
```

**Spring Boot 的 `DataSourceHealthIndicator` 會借一條連線跑 `SELECT 1`。**

> 🔴 **這代表：池滿了的時候，健康檢查也會失敗。**
>
> **在 K8s 上的後果**：
> `readinessProbe` 失敗 → Pod 被移出負載平衡 → 流量集中到其他 Pod
> → **其他 Pod 的池也滿了** → 全部被移出 → **服務完全不可用**。
>
> 📌 **這是「級聯故障」的教科書案例，而它的根因是「健康檢查與業務流量共用同一個池」。**

**三個對策**：

| 對策 | 做法 | 代價 |
|---|---|---|
| **A. liveness 不查資料庫** ✅ | `livenessProbe` 只看行程活著；`readinessProbe` 才查 DB | 需要分開設定兩個 probe |
| **B. 健康檢查用獨立的連線** | 給健康檢查一個 `maximumPoolSize: 1` 的小池 | 多一條連線、多一份設定 |
| **C. 關掉 DB 健康檢查** | `management.health.db.enabled: false` | ⚠️ 資料庫真的掛了時不會被發現 |

> **shop-service 選 A**：`livenessProbe` 打 `/actuator/health/liveness`（不含 DB），
> `readinessProbe` 打 `/actuator/health/readiness`（含 DB），
> **而且 readiness 的 `failureThreshold` 設得比較寬鬆**，避免瞬間尖峰造成連鎖移除。

---

## 1.13 常見誤區

**誤區 1：「池越大越快」**

→ 1.6.2 實測：池從 4 加到 64，吞吐從 494 掉到 107 req/s（**慢 4.6 倍**）。
排隊是一定會發生的，你只能選擇在哪裡排。

**誤區 2：「壓測時 p95 變好了，所以這個設定比較好」**

→ 1.6.3：在**封閉式負載**下，把池加大只是把「排隊時間」搬成「執行時間」。
**看吞吐，不要看百分位** —— 除非你的壓測是開放式（固定速率）的。

**誤區 3：「例外沒有 cause，所以是池滿了」**

→ 1.9.3 實測：同一種病因（連不上資料庫），
`connectionTimeout=1000` 時**沒有** cause、`=3000` 時**有** cause。
**沒有 cause 不能推論任何事。**

**誤區 4：「`leak-detection-threshold` 我設了 500ms，很敏感」**

→ 1.7.0 實測：**小於 2000ms 會被靜默關閉**，你設的是「關閉」。
**去跑一次 1.12.3 那條守門測試。**

**誤區 5：「`maxLifetime` 設 10 秒，連線很新鮮」**

→ 同上：**小於 30 秒會被靜默改成 30 分鐘（預設值）**，差 180 倍。

**誤區 6：「連線斷掉會自動重連，設 `autoReconnect=true` 就好」**

→ 1.4.5：`autoReconnect` 會**靜默重連**，而重連之後**交易已經沒了**。
它把「一個明確的錯誤」換成「一個難以理解的資料不一致」。

**誤區 7：「Tomcat 有 200 個執行緒，池就要 200」**

→ 1.6.7：一個請求只有一小段在用資料庫。兩個數字量的是不同的東西。

**誤區 8：「`@Transactional(timeout = 5)` 可以擋住慢的外部 API」**

→ 1.7.6 實測：交易 timeout **只在下一次跟資料庫講話時被檢查**。
中間那段純 Java 的等待**完全不會被打斷**。

**誤區 9：「批次跟線上共用一個池比較省」**

→ 1.11.1 實測：共用時線上請求的 p95 慢 **20 倍**。
分池之後即使線上池變小（10 → 8），延遲也幾乎完全恢復。

**誤區 10：「連線池會幫我清乾淨，我在連線上設什麼都沒關係」**

→ 1.5.2 實測：池會 rollback 未提交的交易、重置 `autoCommit` / `isolation` / `readOnly`，
**但不會重置 session 變數、暫存表、`sql_mode`**。

**誤區 11：「`Connection is not available` 就是資料庫的問題」**

→ 1.9.7 三個案例，**沒有一個的根因在資料庫**。
最常見的兇手是「連線洩漏」與「交易裡呼叫外部 API」。

**誤區 12：「那一長串 URL 太長了，用 YAML 的 `>-` 折行比較好讀」**

→ 1.12.2：`>-` 會把每一個換行折成一個**空格**，
於是 URL 變成 `…/shop ?connectionTimeZone=UTC…&preserveInstants=true &characterEncoding=…`。
**YAML 解析不會報錯**，錯誤發生在三層之外的 JDBC 驅動裡。
要折行就用**雙引號 + 反斜線續行**。

**誤區 13：「`idle-timeout` 設太小會被改成 10 分鐘」**

→ 1.7.0 的 F3-B：**只有在可伸縮池（`minimumIdle < maximumPoolSize`）上才會**。
固定大小的池上它**保留你寫的值，但完全無效**，而且 WARN 的內容是另一句話。
**「被改掉」與「沒有作用」是兩件事。**

**誤區 14：「Grafana 上用 `histogram_quantile` 算借連線的 p99」**

→ 1.10.4 實測：`hikaricp_connections_acquire_seconds` 預設是 **summary，沒有 `_bucket`**。
那條 PromQL 不會報錯，**它會安靜地什麼都不回傳** —— 於是你的告警永遠不會觸發。

**誤區 15：「打開虛擬執行緒之後，池可以設小一點／不用管了」**

→ 1.6.8 實測：吞吐完全由池決定（187 vs 174 req/s），
**而失去了執行緒池這道閘門之後，`connectionTimeout` 變成唯一的限流機制** ——
它比以前更重要，不是更不重要。

**誤區 16：「先設 100，之後有問題再調」**

→ 「之後」通常是某次促銷把資料庫打垮的時候。
而且 1.6.2 顯示：**池太大不會報錯，只會讓所有人一起慢** ——
它不會提醒你去調它。

---

## 1.14 本章練習

### 練習 1：算池大小

**已知一個服務的資料**：

```
尖峰 TPS：          1,200
應用副本數：        6 個 Pod
平均 SQL 時間：     18 ms
交易裡的 Java 邏輯： 7 ms
交易開始與提交：     5 ms
資料庫 max_connections： 300
其他佔用連線的東西： 排程服務 20、監控 5、DBA 10
```

**(a)** 算出單一 Pod 的池大小（含安全係數，說明你選的係數與理由）。
**(b)** 檢查總連線數是否安全。
**(c)** 產品說「下一季要成長到 3,000 TPS」，你會先做什麼？
**(d)** 有人提議「把 `maximum-pool-size` 直接設成 50，反正閒著也不佔」。用一個數字反駁他。

<details>
<summary>參考答案</summary>

**(a)**

```
佔用連線時間 = 18 + 7 + 5 = 30 ms
單一 Pod 的 TPS = 1200 ÷ 6 = 200
基準池大小 = 200 × 0.030 = 6

安全係數：
  × 2    尖峰不平均（那一秒可能是平均的兩倍）
  × 1.5  交易偶爾變慢（一個慢查詢會拖長佔用時間）
  = 18

⚠️ 排程不加在這裡 —— 它應該用自己的池（1.11）
池大小 ≈ 18，取整數 20
```

**(b)**

```
6 個 Pod × 20 = 120
+ 排程服務 20 + 監控 5 + DBA 10 = 155
155 ÷ 300 = 52%   ✅ 安全（建議保持在 60% 以下）
```

**(c)** ⚠️ **不是先加池，也不是先加 Pod。**

**先量「佔用連線的 30 ms 花在哪裡」**（1.8.1 的檢查表）。

理由：3,000 TPS 需要的池大小 = 20 × 2.5 = 50 條/Pod × 6 = 300 條，
**剛好等於 `max_connections`** —— 這條路走不通。

**而如果能把佔用時間從 30 ms 降到 15 ms，池大小就不用變。**
📌 **這就是 1.8 那句話：縮短佔用時間的槓桿，比加大池大得多。**

**(d)**

```
50 × 6 = 300 = max_connections 的 100%
```

**資料庫會拒絕新連線**，而且**監控、DBA、排程全部連不上** ——
包括「你要進去查為什麼掛掉」的那條連線。

（進階答案）就算資料庫連得上，1.6.2 的曲線顯示
**池遠大於資料庫的處理能力時，吞吐會下降** ——
所以這個設定會**同時**讓資料庫更危險、讓吞吐更差。

</details>

---

### 練習 2：這份設定有幾個問題？

```yaml
spring:
  datasource:
    url: jdbc:mysql://db.internal:3306/shop?autoReconnect=true&allowMultiQueries=true
    username: root
    password: root
    hikari:
      maximum-pool-size: 200
      minimum-idle: 5
      connection-timeout: 60000
      idle-timeout: 5000
      max-lifetime: 10000
      leak-detection-threshold: 1000
      connection-test-query: SELECT 1
```

<details>
<summary>參考答案（11 個）</summary>

| # | 問題 | 小節 | 後果 |
|---|---|---|---|
| 1 | `autoReconnect=true` | 1.4.5 | 靜默重連，交易消失，資料不一致 |
| 2 | `allowMultiQueries=true` | 1.4.5 | SQL Injection 從「讀」升級成「刪」 |
| 3 | **沒有 `socketTimeout`** | 1.4.3 | 🔴 網路故障時執行緒**永遠**卡住 |
| 4 | 沒有 `connectionTimeZone` | 1.4.3 | 時間差 8 小時，靜默 |
| 5 | 沒有 `characterEncoding=utf8mb4` | 1.4.3 | emoji 變 `?` |
| 6 | 用 `root` 帳號 | — | 權限過大；應用只需要 DML |
| 7 | 密碼寫在設定檔 | — | 應該用環境變數 / Secret |
| 8 | `maximum-pool-size: 200` | 1.6 | 吞吐下降 + 資料庫連線數危險 |
| 9 | `minimum-idle: 5` 與 max 差距 40 倍 | 1.6.6 | 尖峰的第一批請求要付建連線的錢 |
| 10 | `connection-timeout: 60000` | 1.7.1 | 過載時所有執行緒卡 60 秒 → 執行緒池先爆 |
| 11 | `idle-timeout: 5000` / `max-lifetime: 10000` / `leak-detection-threshold: 1000` | **1.7.0** | 🔴 **三個全部低於下限**：前兩個被改成預設值（差 120 倍、180 倍），第三個**被靜默關閉** |

**加分題：`connection-test-query: SELECT 1` 有什麼問題？**

> 它本身不是錯的，但**在支援 JDBC 4 的驅動上是多餘的**（MySQL Connector/J 8 支援）。
> HikariCP 預設用 `Connection.isValid()`，那**不需要一次真的查詢往返**。
> 設了它等於**每次驗證多一次來回**。
> 📌 只有在驅動不支援 `isValid()` 時才需要它，而 HikariCP 啟動時會警告你這件事。

**加分題 2：如果只能先修三個，你修哪三個？**

1. **`socketTimeout`**（第 3 個）—— 它會造成「永久卡住」，是唯一「沒有自我恢復能力」的問題。
2. **`autoReconnect`**（第 1 個）—— 它造成的是**資料錯誤**，比效能問題貴。
3. **`leak-detection-threshold`**（第 11 個的一部分）—— 因為修好它，其他問題你才查得到。

</details>

---

### 練習 3：診斷 ★

**三個情境，各給你一組指標。判斷病因，並說出你的下一步。**

**情境 A**

```
hikaricp_connections_total   = 10   (max=10)
hikaricp_connections_active  = 10
hikaricp_connections_idle    = 0
hikaricp_connections_pending = 143
資料庫：Threads_connected=12, CPU 8%, 慢查詢 0
資料庫 SHOW PROCESSLIST：12 條連線，Command 全部是 Sleep，Time 從 40 秒到 900 秒
```

**情境 B**

```
hikaricp_connections_total   = 0    (max=10, min-idle=10)
hikaricp_connections_active  = 0
hikaricp_connections_idle    = 0
hikaricp_connections_pending = 20
hikaricp_connections_timeout_total 持續上升
應用日誌：Connection is not available, request timed out after 3001ms.（沒有 cause）
```

**情境 C**

```
hikaricp_connections_active  = 10（滿）
hikaricp_connections_pending = 0～3 之間跳動
hikaricp_connections_acquire p99 = 4 ms
資料庫：CPU 95%，慢查詢日誌一分鐘 300 筆
```

<details>
<summary>參考答案</summary>

**情境 A → 病因 C（連線被借走沒還，或交易裡在等別的東西）**

**關鍵證據**：
- `active` 滿、`pending` 143 → 池滿了。
- 資料庫 CPU 8%、**`Command` 全是 `Sleep`** → **資料庫根本沒在做事**。
- `Time` 高達 900 秒 → 有連線被握著 15 分鐘。

**下一步**：
1. 看 `leak-detection-threshold` 的 WARN 日誌 —— **它會直接告訴你是哪一行**（1.9.4）。
2. 沒開的話，抓 thread dump，`grep -c "ConcurrentBag.borrow"` 與「有沒有人在 `socketRead0`」（1.9.5）。
3. ⚠️ **`Time` 900 秒這個數字暗示「不是洩漏，而是超長交易」** ——
   純粹的洩漏通常是「借了之後那個執行緒早就做別的事了」；
   而 900 秒的 `Sleep` 比較像「交易開著、在等一個沒有逾時的外部呼叫」（1.8.1 第一列）。

**情境 B → 病因 A（連不上資料庫）**

**關鍵證據**：
- **`total = 0`，而 `min-idle = 10`** ← ★ 這是最重要的一條：**池連一條都建不起來**。
- `active = 0`、`idle = 0`、`pending = 20` → **有人在等，但池是空的**。

**這組數字是實測出來的**（F16：把 URL 指向一個沒有人在聽的埠）：

```
=== F16 資料庫連不上時的池指標 ===
  時間        total   active     idle  waiting
  600ms           0        0        0       20
  1200ms          0        0        0       20
  1800ms          0        0        0       20
  2400ms          0        0        0       20
  3000ms          0        0        0        0     ← connectionTimeout 到了，全部失敗
  結果：成功 0，失敗 20
```

> 📌 **`total = 0` 而 `pending > 0` 是病因 A 最乾淨的指紋。**
> ⚠️ 而 `idle > 0` 且 `pending > 0` **在物理上不會持續存在** ——
> 池只要有閒置連線就會立刻交給等待者（1.3.3 的 handoff）。
> **如果你真的看到那個組合，那是取樣的時間差，不是狀態。**

⚠️ **「沒有 cause」不是證據**（1.9.3）——
**把 `connection-timeout` 暫時調大到 10 秒再看一次，cause 就會出現。**

**下一步**：
1. 資料庫的 `Threads_connected` 是不是撞到 `max_connections`。
2. 從那台機器 `telnet db.internal 3306` / 檢查 DNS、安全群組。
3. 帳密與權限（雲端資料庫的密碼輪替常是兇手）。

**情境 C → 病因 B（查詢太慢 / 太多）**

**關鍵證據**：
- 資料庫 **CPU 95% + 大量慢查詢** → 兇手在資料庫這邊。
- `pending` 只有 0～3、`acquire p99 = 4 ms` → **池其實還撐得住**。

**下一步**：
1. 慢查詢日誌 → `EXPLAIN`（07-mysql 站 03、05 章）。
2. ⚠️ **不要加大池** —— 資料庫已經 95% CPU，加大池只會讓 1.6.2 那條曲線往右掉。
3. 短期可以**降低池大小**來保護資料庫（把排隊移回應用端）。

📌 **三個情境的共同教訓**：
**「池滿了」只是症狀。`total` 是不是等於 `max`、資料庫在 `Sleep` 還是 `Query`
—— 這兩個問題就能把三種病因分開。**

</details>

---

### 練習 4：設計一個「連線洩漏」的守門測試

**目標**：讓「有人借了連線沒還」在 **CI 就紅**，而不是在生產環境半夜爆。

**(a)** 為什麼「用 `leakDetectionThreshold` + 看日誌」在 CI 裡不夠？
**(b)** 寫一個測試，讓它在「某段業務程式碼洩漏連線」時失敗。
**(c)** 這個測試有什麼**限制**？

<details>
<summary>參考答案</summary>

**(a)** 三個理由：

1. **日誌不會讓測試失敗** —— CI 是綠的，沒有人會去看日誌。
2. **時間門檻**：`leakDetectionThreshold` 最小 2 秒（1.7.0），
   而單元測試通常在 2 秒內就結束了 —— **告警來不及觸發**。
3. 它偵測的是「借太久」，不是「沒有還」。

**(b)** 直接檢查指標：

```java
/**
 * ★ 守門測試：跑完一段業務流程之後，池應該回到「全部閒置」。
 *
 * <p>⚠️ 它必須跑在【單執行緒】、【專屬的 DataSource】上，
 * 否則別的測試借的連線會讓它誤判。
 */
@Test
void 業務流程跑完之後不可以有連線還被借著() {
    HikariPoolMXBean pool = hikariDataSource.getHikariPoolMXBean();
    assertThat(pool.getActiveConnections())
            .describedAs("測試開始前池應該是乾淨的").isZero();

    orderApplicationService.create(aCreateOrderCommand(), anActor());   // ← 受測的業務流程

    assertThat(pool.getActiveConnections())
            .describedAs("""
                    流程結束後仍有 %d 條連線被借走 —— 有人 getConnection() 之後沒有 close()。
                    👉 把 leak-detection-threshold 調到 2000 再跑一次，日誌會印出是哪一行。
                    """, pool.getActiveConnections())
            .isZero();
}
```

**更進一步：用 `@AfterEach` 讓所有測試都被守著**

```java
@AfterEach
void 每個測試結束都要檢查連線有還回去() {
    await().atMost(Duration.ofSeconds(2))          // ★ 給非同步的歸還一點時間
           .untilAsserted(() -> assertThat(
                   hikariDataSource.getHikariPoolMXBean().getActiveConnections()).isZero());
}
```

**(c)** 四個限制：

| 限制 | 說明 |
|---|---|
| **只抓得到「測試有覆蓋到的路徑」** | 洩漏最常發生在**例外路徑**上，而那些路徑通常沒有測試 |
| **平行測試會誤判** | 別的測試借走的連線會被算進來 → 必須單執行緒或用專屬 DataSource |
| **非同步歸還有時間差** | 要用 `await()` 而不是直接斷言 |
| 🔴 **它證明不了「沒有洩漏」** | 只能證明「這條路徑沒有洩漏」 |

📌 **所以正確的做法是兩層**：
**CI 用這個測試擋住已知路徑**，**正式環境用 `leakDetectionThreshold` 抓漏網的**。
**兩者都要有。**

⚠️ **而最有效的一層其實在更前面**：
**用 `JdbcTemplate` / `JdbcClient` 就不會有這個問題** ——
因為它們負責借與還，你根本拿不到 `Connection`。
**00 章 0.12.5 的 ArchUnit 規則 4（「沒有人可以自己開連線」）就是在守這一層。**

</details>

---

## 1.15 驗收清單

讀完本章，你應該能回答：

**觀念**

- [ ] 建立一條連線做了哪五件事？哪一件解釋了「為什麼 `max_connections` 不能設很大」？
- [ ] **連線池真正的價值是什麼？** 這個觀念翻轉會改變哪三個決定？
- [ ] `DataSource` 介面為什麼沒有「歸還」方法？這件事跟連線洩漏有什麼關係？
- [ ] Spring Boot 選 `DataSource` 實作的順序是什麼？
- [ ] `LazyConnectionDataSourceProxy` 解決哪兩個具體問題？

**URL**

- [ ] 哪三個 URL 參數會影響**正確性**？設錯各會發生什麼？
- [ ] **為什麼「這個 email 已經註冊了嗎」的答案取決於一個 URL 參數？**
- [ ] `socketTimeout` 不設會發生什麼？為什麼它是最容易被漏掉、後果最嚴重的一個？
- [ ] `autoReconnect=true` 為什麼不能設？
- [ ] Hikari 的 `connectionTimeout` 與 URL 的 `connectTimeout` 差在哪？

**池大小**

- [ ] **為什麼池從 4 加到 64，吞吐掉了 4.6 倍？三個原因。**
- [ ] **為什麼 p95 在池 64 時「看起來變好」？這個誤讀怎麼避免？**
- [ ] `最大吞吐 = 池大小 ÷ 佔用時間` 這個公式是上限還是預測？實測誤差多少？
- [ ] 從「尖峰 TPS」算到「池大小」的四個步驟是什麼？
- [ ] `minimumIdle` 為什麼建議等於 `maximumPoolSize`？兩個例外是什麼？
- [ ] Tomcat 執行緒數與池大小為什麼不是同一個東西？什麼情況下這個推論會失效？
- [ ] **打開虛擬執行緒之後，池大小要不要跟著變大？`connectionTimeout` 為什麼變得更重要？**

**逾時**

- [ ] **哪兩個設定值會讓 HikariCP 直接拋例外？哪些會被靜默改掉／靜默關閉？**
- [ ] `leakDetectionThreshold: 500` 的實際效果是什麼？
- [ ] **`idleTimeout: 5000` 在固定大小池與可伸縮池上，結果為什麼不一樣？**
- [ ] `maxLifetime` 要與哪三個外部設定對齊？為什麼還要再減 30～60 秒？
- [ ] AWS NAT Gateway 的 350 秒為什麼危險？
- [ ] **`connectionTimeout`、`setQueryTimeout`、交易 `timeout` 各自管什麼？誰執行它們？**
- [ ] 為什麼交易 `timeout` 擋不住「在交易裡呼叫慢的外部 API」？

**診斷**

- [ ] 五分鐘診斷流程的第一個分岔點是什麼？（提示：`total` 與 `max` 的關係）
- [ ] 三種病因在「資料庫的連線狀態」上分別長什麼樣？
- [ ] **「有 cause 就是連不上」這個說法哪裡只對一半？**
- [ ] 「重啟就好、過幾天又犯」通常是哪一種病因？
- [ ] `leakDetectionThreshold` 為什麼只告警不回收？
- [ ] thread dump 裡要找的三種樣子分別是什麼？兩個 `grep` 指令是什麼？

**監控與設定**

- [ ] 五個指標裡，如果只能看一個要看哪個？為什麼？
- [ ] **`hikaricp.connections.timeout` 是什麼？它為什麼比其他指標都直接？**
- [ ] **為什麼 `histogram_quantile(0.99, hikaricp_connections_acquire_seconds_bucket)` 預設算不出東西？要怎麼修？**
- [ ] 哪一條告警規則抓的是「趨勢」而不是「瞬間值」？它抓的是什麼病因？
- [ ] **健康檢查為什麼會造成級聯故障？三個對策是什麼？**
- [ ] 分池的三個代價是什麼？哪一個最容易出事？
- [ ] 為什麼線上池與批次池的 `connection-timeout` 是相反的？
- [ ] 1.12.3 那條守門測試在守什麼？把哪個值改掉它會紅？

**如果有任何一題答不出來，回去讀對應的小節**：

| 題目範圍 | 小節 |
|---|---|
| 為什麼需要池、池是限流器 | **1.2.3** |
| DataSource 家族與包裝 | 1.3 |
| JDBC URL | **1.4** |
| 一條連線的一生、歸還時的重置 | 1.5 |
| **池大小（最重要）** | **1.6** |
| 五個逾時、被靜默改掉的值 | **1.7** |
| 縮短佔用時間 | 1.8 |
| **診斷** | **1.9** |
| 監控指標與告警 | 1.10 |
| 分池 | 1.11 |
| 最終設定、YAML 的坑、守門測試 | 1.12 |

---

## 1.16 下一章預告

這一章解決的是「**連線從哪裡來**」。
下一章（02）開始寫**真的 SQL**：

> **00 章 0.12.4 那個 `JdbcOrderRepository` 骨架，有五個刻意留下的問題。
> 02 章要解決其中三個。**

| 問題 | 02 章哪一節 |
|---|---|
| `PreparedStatement` 到底怎麼擋住 Injection？欄位名為什麼不能參數化？ | 2.3 |
| `RowMapper`、`ResultSetExtractor`、`RowCallbackHandler` 三個怎麼選？ | 2.5 |
| 具名參數（`NamedParameterJdbcTemplate`）與 `IN (:ids)` 的展開 | 2.6 |
| **`save()` 那個「先 UPDATE 再判斷」要怎麼寫才對？** | **2.8 ★** |
| `OrderStatus.valueOf()` 遇到資料庫裡的未知狀態會怎樣？ | 2.9 |
| **約束違反怎麼翻譯成 41 個業務例外？「比對訊息字串」有沒有更好的做法？** | **2.12 ★** |
| Spring Boot 3.2 的新玩意 `JdbcClient` 值不值得換？ | 2.14 |

⚠️ **2.8 與 2.12 是最實用的兩節**：
前者處理「新增與更新是同一個方法」這個每個專案都會遇到的問題，
後者處理「資料庫的錯誤訊息怎麼變成使用者看得懂的話」。

---

**完成本章後**，請確認你的專案有：

```
✅ application.yml 的 datasource 段            ★ 每個值都有一行註解說明理由
✅ 池大小的【計算過程】寫在註解裡              ★ 讓下一個人知道「10」是怎麼來的
✅ leak-detection-threshold: 20000            ★ 而且 >= 2000（不然是關閉的）
✅ URL 上有 socketTimeout 與 connectionTimeZone
✅ URL 沒有用 YAML 的 `>-` 折行                ★ 1.12.2：會把空格折進 URL 裡
✅ DataSourceConfigTest.java                  ★ 守門測試，且實測過會紅
✅ Actuator + Micrometer，四條告警規則（含 `connections.timeout` 那一條）
✅ livenessProbe 不查資料庫（1.12.4）
```

---

## 1.17 本章的實驗環境與結果

**環境**（與 00 章相同）：

| 項目 | 版本 |
|---|---|
| JDK | Temurin **21.0.5**（LTS） |
| Maven | **3.9.16** |
| Spring Boot | **3.2.5** |
| 連線池 | **HikariCP 5.0.1** |
| 資料庫 | **H2 2.2.224** |
| 平台 | macOS 14.2.1 / Apple Silicon |

**跑過的實驗（16 組，22 個測試方法，全綠；加上 00 章的 44 個，這個驗證專案目前 66 個測試全綠）**：

| 組 | 實驗 | 結果 |
|---|---|---|
| **F1** | 建連線 vs 借連線 | ✅ in-memory：0.021 ms vs 0.002 ms（**10 倍**）；檔案型 0.226 ms |
| **F2** | 池大小曲線 | ✅ **池 4 是最高點 494 req/s；池 64 掉到 107（慢 4.6 倍）**；p95 反而「變好」 |
| **F3** | 設定值的下限 | ✅ **connectionTimeout / validationTimeout < 250ms 直接拋例外**；**maxLifetime 靜默改成預設**；**keepaliveTime / leakDetectionThreshold 靜默關閉**<br>⚠️ **F3-B：`idleTimeout` 只在【可伸縮池】上會被改成 600,000；固定大小池上保留原值但完全無效**（兩行不同的 WARN） |
| **F4** | 死連線 | ✅ **閒置中死掉：呼叫端無感**（池換一條）；**借出後死掉：呼叫端直接收到例外**；連不上時 cause 顯示 `Connection refused` |
| **F5** | 診斷 | ✅ **同一種病因，逾時 1 秒沒有 cause、3 秒有 cause**；leak detection 印出兇手的堆疊 |
| **F6** | 過載時的指標 | ✅ `total=5 active=5 idle=0 waiting=33→0`；Hikari 的 `Pool stats` DEBUG 行 |
| **F7** | 分池（隔艙） | ✅ **共用池：p50 慢 7.8 倍、p95 慢 20 倍**；分池後幾乎完全恢復 |
| **F8** | 三種逾時 | ✅ connectionTimeout 不管查詢；**setQueryTimeout 在 H2 上沒有中斷查詢**；**交易 timeout 只在下一句 SQL 才檢查** |
| **F9** | 冷池 vs 熱池 | ✅ 冷池（minIdle=1）比熱池慢 **1.9 倍** |
| **F10** | TPS 公式 | ✅ 公式是上限；交易 10 ms 時誤差 −35%，500 ms 時只剩 **−7%** |
| **F11** | URL 參數 | ✅ **同一句 SQL，`IGNORECASE=TRUE` 查到 1 筆、預設查到 0 筆** |
| **F12** | 歸還時的重置 | ✅ 未提交的寫入被 rollback；`autoCommit` / `isolation` / `readOnly` 都被重置 |
| **F13** | 設定守門測試 | ✅ 全綠；把 `leak-detection-threshold` 改成 500 之後**實測會紅** |
| **F14** | 指標名稱與 `aliveBypassWindow` | ✅ 十個 `hikaricp.*` 指標；**`acquire` 預設是 summary（沒有 `_bucket`）**，打開 `percentiles-histogram` 後出現 **69 行 bucket**；`aliveBypassWindowMs` 預設 **500 ms**（反射讀出） |
| **F15** | 虛擬執行緒 × 池 | ✅ 2,000 個虛擬執行緒 × 池 10：**吞吐與逾時設定無關（187 vs 174 req/s）**；逾時 1 秒時 **1,810 個快速失敗** |
| **F16** | 資料庫掛掉時的指標 | ✅ **`total=0 active=0 idle=0 waiting=20`** —— 病因 A 的指紋（練習 3 情境 B） |

🔴 **本章沒有驗證到的（都需要真的 MySQL 或雲端環境）**：

| 沒驗證的 | 影響哪一節 | 哪一站會補 |
|---|---|---|
| **真實的建連線成本**（TCP + TLS + 認證） | 1.2.2 | 07-mysql 站 |
| **MySQL 的 URL 參數行為**（時區、定序、`rewriteBatchedStatements`） | 1.4.3 | 07-mysql 02 章、本站 05 章 |
| **`setQueryTimeout` 在 MySQL 上會不會生效** | 1.7.6 | 07-mysql 04 章 |
| **真實資料庫的池大小曲線**（F2 的資料庫是模擬的） | 1.6.2 | 07-mysql 站 |
| `SHOW PROCESSLIST` 與 `performance_schema` | 1.9.6 | 07-mysql 05 章 |
| AWS NAT Gateway 的 350 秒 | 1.7.4 | — |
| **真實 JDBC 驅動在虛擬執行緒下的 pinning** | 1.6.8 | 07-mysql 站 |
| K8s 的健康檢查級聯故障 | 1.12.4 | 12-capstone |

> 📌 **最後一句話**：
>
> 這一章有**三個實測結果，與「大家都這樣說」不一樣**：
>
> **① 「`max-lifetime` 沒設好，早上第一個請求會失敗」** ——
> 實測顯示 HikariCP 的借出驗證會擋掉它（F4-A），
> **真正危險的是「連線在借出去之後才死掉」（F4-B）。**
>
> **② 「例外沒有 cause 就是池滿了」** ——
> 實測顯示同一種病因會因為逾時長短而有不同的 cause（F5-A）。
>
> **③ 「壓測的 p95 變好了，所以設定變好了」** ——
> 實測顯示池加大 16 倍時 p95「變好」，而吞吐掉了 4.6 倍（F2）。
>
> ⚠️ **三個都不是「文件寫錯了」，而是「那句話省略了前提」。**
> **而省略前提的說法，在你需要它的那個半夜，就是錯的。**
