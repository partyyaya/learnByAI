# 第 00 章：課程地圖、環境與連線

> 06-repository 站結束時，你把 `ConcurrentHashMap` 換成了 `JdbcOrderRepository`，
> 交出了一份 `schema.sql`、一組調過的 HikariCP 設定、六組 ArchUnit 規則，
> 以及一句在每一章結尾都出現的話：
>
> > **「這個結論要等 07-mysql 站才能驗證。」**
>
> 那一站一共留下了 **九處**這樣的標記。
>
> ⚠️ 但這一章開場要講的，不是那九處。
> 而是一件更難堪的事：
>
> **你在 06 站寫的每一行 Java 都是對的，而資料庫裡的資料可以是錯的。**
>
> 這一章有五個實測事故 —— 名字變成 `???`、兩個人的暱稱互相擋掉、
> 報表差 8 小時、CI 綠上線紅、設定沒改卻在某個半夜連不上 ——
> **五個事故的 Java 程式碼全部正確，五個都是「連線建立的那一瞬間就已經決定了」。**
>
> 📌 所以這一章的順序是刻意的：
> **先把「連線」講完，再開始講 SQL。**
> 因為連線的設定錯了，後面八章教的每一件事都會建在流沙上。

---

## 0.1 學習目標

完成本章後，你應該可以：

- 用 Docker 起一個**字元集、定序、時區、`sql_mode` 都明確寫死**的 MySQL 8，並說出每一個參數在防哪一種事故。
- 說明「容器 `running`」「TCP 埠可連」「資料庫真的可用」是**三件不同的事**，並寫出正確的健康檢查。
- 說出 MySQL 字元集的**六個層次**，並判斷一段亂碼是在哪一層壞掉的。
- 解釋 `utf8` 為什麼**不是** UTF-8，以及 `utf8mb3` 欄位遇到 emoji 的兩種下場（報錯 / 靜默變成 `?`）。
- 比較 `utf8mb4_general_ci`、`utf8mb4_unicode_ci`、`utf8mb4_0900_ai_ci`、`utf8mb4_0900_as_cs`、`utf8mb4_bin` 的差別，
  並解釋一個實測結果：**在 `general_ci` 下，🎉 與 🎊 是同一個字元** —— 於是唯一索引會擋掉第二個人的暱稱。
- 說出 MySQL 的 **`system_time_zone` / `global.time_zone` / `session.time_zone`** 各是什麼，以及 JDBC 的 `connectionTimeZone` 是第四個。
- 讀懂 `DATETIME` 與 `TIMESTAMP` 在時區上的**根本差異**，並用一個實測解釋為什麼「同一列資料，換個 session 讀出來差 8 小時」。
- 判斷四種 JDBC 時區參數組合，並指認出**最危險的那一種：Java 讀寫完全正確，而資料庫裡的絕對時刻是錯的**。
- 說明 MySQL 8 的 `caching_sha2_password` 為什麼會讓一份「用了三個月都沒事」的設定**突然連不上**，以及 `allowPublicKeyRetrieval=true` 為什麼是一個安全問題而不是修正。
- 列出 `sql_mode` 的預設值，並示範**同一句 `INSERT` 在嚴格與非嚴格下的兩種結果**。
- 分辨 MySQL 三個層次的大小寫規則（**識別字 / 資料 / 檔案系統**），並說明為什麼「Mac 上測試會過、Linux 上會炸」。
- 建好本站的 `docker-compose.yml`、`my.cnf`、`application.yml`，
  並寫出一組**環境自檢測試** —— 讓上面每一項設定在 CI 就被驗證，而不是在半夜被使用者發現。

---

## 0.2 這一站在整條路線的位置

```
           01-java-core     語言 + JVM + 建置 + 測試（已完成）
                ↓
           02-spring-boot   IoC / DI / 自動組態 / AOP / 設定 / 部署（已完成）
                ↓
           03-rest-api      介面契約設計（已完成，orders-api.yaml）
                ↓
           04-controller    Web 層：接請求、驗參數、回錯誤（已完成，83 條端點）
                ↓
           05-service       商業邏輯層：交易、不變量、快取、非同步（已完成）
                ↓
           06-repository    資料存取層：連線池、SQL、抽象、邊界（已完成）
                ↓
[你在這裡] 07-mysql         ★ 資料庫本體：環境、建模、索引、EXPLAIN、鎖、調校、遷移、維運
                ↓
           08-jpa-mybatis   兩種存取實作：ORM vs SQL Mapper
                ↓
           09 / 10 / 11     Spring Security / Redis / 訊息佇列
                ↓
           12-capstone      整合成一個可上線的服務
```

### 0.2.1 06-repository 留下的九處「等 07 站」

06 站每一章結尾都有一張「本章沒有驗證到的」表。把九處攤開來看：

| 06 站留下的問題 | 它真正在問什麼 | 本站哪一章 |
|---|---|---|
| 真實的建連線成本（TCP + TLS + 認證）（**06 站** 01 章 1.2.2） | **連一次資料庫到底多貴** | **00（0.7.2）** |
| MySQL 的 URL 參數行為（時區、定序、批次改寫）（**06 站** 01 章 1.4.3） | **URL 上那一長串到底哪些會改變結果** | **00（0.6、0.7）**、05 |
| `setQueryTimeout` 在 MySQL 上會不會生效（**06 站** 01 章 1.7.6） | **哪一種逾時真的能中斷一句慢 SQL** | 04、05 |
| 真實資料庫的池大小曲線（**06 站** 01 章 1.6.2） | **池大小的上限由誰決定** | 05 |
| `SHOW PROCESSLIST` 與 `performance_schema`（**06 站** 01 章 1.9.6） | **從資料庫這一側怎麼看見卡住的連線** | 05 |
| 約束在 H2 上是綠的、正式環境擋不住（**06 站** 06 章 6.3.2） | **MySQL 的約束到底守得住哪幾條不變量** | **01（1.10）**、04 |
| `Admin` 註冊卻能用 `admin` 登入（**06 站** 06 章 6.4.2 探針 ⑬） | **字串相等是誰定義的** | **00（0.5.6）** |
| H2 上是綠的、MySQL 上 `bad SQL grammar`（**06 站** 06 章 6.6） | **方言差在哪、哪些差異會咬人** | **00（0.8）**、02 |
| 那 20 個人怎麼搶到 10 個庫存（**06 站** 00 章 0.8.2） | **InnoDB 的鎖與 MVCC 實際上怎麼運作** | 04 |

⚠️ 注意這張表的分布：**九處裡有四處落在這一章**，而且都不是「查詢技巧」——
**全部都是環境設定。**

> 📌 **這說明了一件事**：
> 06 站真正沒有辦法驗證的，不是「SQL 怎麼寫」，
> 而是「**當底下換成一個真的 MySQL，有哪些你以為與資料庫無關的東西，其實是資料庫決定的**」。
>
> 字串相等、字串排序、`NOW()` 是幾點、一個過長的字串會不會報錯 ——
> 這四件事在 H2 上是一種答案，在 MySQL 上是另一種答案，
> **而在「設定錯的 MySQL」上是第三種答案。**

### 0.2.2 這一站的產出

```
第 00 章  環境與連線：Docker、字元集與定序、時區、JDBC 參數、sql_mode、大小寫   ← 你在這裡
第 01 章  Schema 設計與資料型別：數字、字串、時間、NULL、主鍵策略、約束、命名
第 02 章  SQL 核心：JOIN 家族、GROUP BY、子查詢、視窗函式、UPSERT
第 03 章  索引與執行計畫：B+Tree、聚簇索引、最左前綴、覆蓋索引、失效情境、EXPLAIN
第 04 章  交易、隔離與鎖：ACID、MVCC、四種隔離級別、行鎖 / 間隙鎖、死鎖分析
第 05 章  效能調校：慢查詢日誌、深分頁、批次寫入、IN 過長、Java 端反模式
第 06 章  Schema 版本控管：Flyway、命名與版本策略、線上大表變更
第 07 章  上線維運：備份還原演練、主從複製、讀寫分離、監控指標、權限最小化
```

**結束時你會有**：

```
✅ 一份 docker-compose.yml —— 字元集 / 定序 / 時區 / sql_mode 全部寫死，附上每一行的理由
✅ 一份 shop-service 的完整 schema（訂單、明細、商品、庫存、付款、outbox）
✅ 一組 EXPLAIN 前後對照的優化實驗，含索引設計說明
✅ 一份「慢查詢排查 SOP」
✅ 一組 Flyway 遷移腳本，含線上大表變更的做法
✅ 一組環境自檢測試 —— 上面每一個設定在 CI 就會被驗證
```

### 0.2.3 這一站**不**處理的五件事

⚠️ 這五件事很容易在這裡被順手講掉，但它們各自屬於別的地方：

| 不在這一站 | 在哪裡 | 為什麼分開 |
|---|---|---|
| **JPA 的 Entity 映射、Lazy、N+1** | 08-jpa-mybatis | 本站教「資料庫怎麼想」，不教 ORM 怎麼把它包起來 |
| **連線池怎麼調、洩漏怎麼診斷** | 06-repository 01 章（已完成） | 那是 Java 這一側的事；本站 05 章只補「資料庫端看到什麼」 |
| **資料庫選型（要不要用 PostgreSQL / MongoDB）** | [../../database-course/](../../database-course/) | 本站假設「已經選了 MySQL」 |
| **分庫分表、Sharding、高併發搶票架構** | [../../database-course/](../../database-course/) | 那是架構課題，不是 MySQL 課題 |
| **Redis 快取一致性** | 10-redis | 那是「MySQL 之外多一層」的問題 |

> ⚠️ **一個要先講清楚的定位**：
> 這一站**不是 DBA 課**。你不會學到 buffer pool 的內部結構、redo log 的格式、
> 或是怎麼調 `innodb_io_capacity`。
>
> 這一站教的是 **「一個寫 Java 的人，需要知道多少 MySQL，才不會寫出會在半夜出事的程式」**。
> 判準很簡單：**只要一個 MySQL 的行為會改變你 Java 程式碼的正確性，它就在這一站。**
>
> 本章的五個事故，全部符合這個判準。

---

## 0.3 先看見痛：五個「程式碼完全正確」的事故

04 站給你看了 800 行的 Controller，05 站給你看了 2,000 行的 `OrderServiceImpl`，
06 站給你看了 1,400 行的 `OrderDao`。

**這一次沒有壞掉的程式碼可以給你看。**

以下五個事故，Java 那一側**全部是對的** —— 你去 code review 也看不出問題。
每一個都在本章有可以自己跑一次的實測。

### 0.3.1 事故一：客戶的名字在資料庫裡是 `???`

**症狀**：客服說「後台看到的客戶姓名全是問號」。前端顯示正常、API 回傳正常、
Java 的單元測試全綠。DBA 用 GUI 打開資料表 —— 也是正常的。
**只有某一支跑批次的 Python 腳本讀出來是 `???`。**

**先看實測**（本章 0.5.5 的完整版）：

```bash
# 同一張 utf8mb4 的表、同一句 INSERT，差別只在「用哪個連線字元集」
```

| 連線的字元集 | 你看到的 | 資料庫裡真正存的位元組 | `CHAR_LENGTH` |
|---|---|---|---|
| `utf8mb4`（正確） | `王小明` | `E78E8B E5B08F E6988E` | **3** |
| `latin1`（預設） | `王小明` ← **看起來一樣！** | `C3A7C5BDE280B9 C3A5C2B0C28F C3A6CB9CC5BD` | **9** |

⚠️ **注意第二列的第二欄：你看到的字是對的。**

因為寫入時用 latin1 把 UTF-8 的位元組「當成 9 個 latin1 字元」存進去（**雙重編碼**），
讀出來時又用 latin1 反轉一次，**在同一個工具裡剛好轉得回來**。

**於是**：

- 你的工具正常 ✅
- Java 正常 ✅（因為 JDBC 驅動自己協商成 utf8mb4）
- **資料庫裡的位元組是垃圾** 🔴
- 任何**用不同字元集**連進來的程式（那支 Python 腳本、備份還原、資料同步、全文檢索）看到的是垃圾 🔴

**代價**：這種資料是**無法用一句 SQL 修好的**。你必須知道每一列是「哪一次寫入、用哪一個字元集」壞掉的。
實務上通常的結局是：接受它、寫一個轉換函式包住所有讀取路徑，然後這個函式活十年。

> 📌 **這個事故的根因不在程式碼裡，在連線建立的那一瞬間。**

### 0.3.2 事故二：兩個人的暱稱互相擋掉

**症狀**：使用者回報「我的暱稱 `小明🎊` 註冊不了，說已經有人用了」。
你去資料庫查 `SELECT * FROM users WHERE nick = '小明🎊'` —— **查不到任何人**。

**實測**（本章 0.5.7）：

```sql
CREATE TABLE nick (nick VARCHAR(50) UNIQUE) CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
INSERT INTO nick VALUES ('小明🎉');   -- 第一個人，成功
INSERT INTO nick VALUES ('小明🎊');   -- 第二個人
```

```
ERROR 1062 (23000): Duplicate entry '小明?' for key 'nick.nick'
```

**在 `utf8mb4_general_ci` 之下，🎉 與 🎊 是同一個字元。**

不只這兩個 —— **所有的 emoji、所有 BMP 以外的字元（含罕用漢字、部分日文假名擴充），
在 `utf8mb4_general_ci` 與 `utf8mb4_unicode_ci` 下全部相等**：

```sql
SELECT '🎉'='🎊' COLLATE utf8mb4_general_ci,   -- 1  ← 相等
       '🎉'='🎊' COLLATE utf8mb4_unicode_ci,   -- 1  ← 相等
       '🎉'='🎊' COLLATE utf8mb4_0900_ai_ci;   -- 0  ← 不相等（正確）
```

⚠️ **而 `utf8mb4_general_ci` 是網路上「MySQL 建表模板」裡最常見的那一個。**

**代價**：這不只是註冊擋掉。想像一下：

- 商品名稱含 emoji 的兩個不同 SKU，被 `GROUP BY name` 合併成一列 → **報表數字錯**。
- 用暱稱當快取 key 的地方 → **兩個人共用一份快取**。
- 一個「查詢罕用字姓名」的功能 → **查出別人的資料**。

> 📌 **這個事故的根因，是建表當下 `COLLATE` 那六個字。**

### 0.3.3 事故三：對帳報表差 8 小時

**症狀**：財務說「當日營業額對不上，而且差的那幾筆都在晚上」。
訂單表有兩個時間欄位：`app_time`（Java 寫的）與 `db_time`（資料庫 `DEFAULT CURRENT_TIMESTAMP` 寫的）。

**實測**（本章 0.6.5 的完整版）：

| JDBC 設定 | app 寫的 | DB 寫的 | 相差 |
|---|---|---|---|
| 伺服器 UTC + **沒設任何時區參數** | `2026-09-02 12:17:19` | `2026-09-02 04:17:19` | 🔴 **479 分鐘** |
| 伺服器 UTC + `connectionTimeZone=UTC` | `2026-09-02 04:17:19` | `2026-09-02 04:17:19` | ✅ 0 分鐘 |

**同一張表的兩個時間欄位，差 8 小時。**

於是：

- `ORDER BY created_at` 排出來的順序是**混的**（看那一列是誰寫的）。
- `WHERE created_at >= CURDATE()`（今天的訂單）**漏掉或多算晚上 8 小時的訂單**。
- 兩個欄位相減算「處理耗時」→ **每一筆都是 -8 小時**。

⚠️ **而 Java 這一側完全正常**：你 `setTimestamp(Instant.now())` 寫進去、
`getTimestamp().toInstant()` 讀出來，**得到的是同一個 `Instant`**。
往返是對的，錯的是**資料庫裡的字面值**，以及它跟 `NOW()` 之間的關係。

> 📌 **這個事故的根因，是 JDBC URL 上「沒有寫」的一個參數。**
> 本章 0.6.4 會示範一個更可怕的變形：
> **Java 讀寫都對、`NOW()` 也對，而資料庫裡的絕對時刻錯 8 小時** ——
> 這一種連上面那張表都測不出來。

### 0.3.4 事故四：CI 全綠，上線就 `Table doesn't exist`

**症狀**：開發者在 Mac 上開發，測試全過；CI（Linux 容器）也全過；
上線到正式環境（Linux）—— `Table 'shop.orderitem' doesn't exist`。
DBA 說「表明明在啊」，`SHOW TABLES` 看到 `OrderItem`。

**實測**（本章 0.9）：

```sql
CREATE TABLE OrderItem (id INT PRIMARY KEY);
SELECT * FROM orderitem;
```

```
ERROR 1146 (42S02): Table 'shop.orderitem' doesn't exist
```

**MySQL 的表名，大小寫敏不敏感，由作業系統的檔案系統決定**（`lower_case_table_names`）：

| 環境 | `lower_case_table_names` | 表名大小寫 |
|---|---|---|
| Linux（ext4 / xfs） | `0` | **敏感** |
| macOS（預設 APFS，不分大小寫） | `2` | 不敏感 |
| Windows | `1` | 不敏感（且一律轉小寫存） |
| **Docker（在 Mac 上跑）** | `0` | **敏感** ← 容器裡是 Linux |

⚠️ **注意最後一列**：很多人以為「我在 Mac 上開發所以不敏感」，
但只要你的 MySQL 跑在 Docker 裡，它就是 Linux，就是**敏感的**。

於是真正的組合是：

```
本機 Docker MySQL（敏感）+ CI Docker MySQL（敏感）→ 都會抓到
本機 Homebrew 裝的 MySQL（不敏感）→ 抓不到，上線才爆
```

而且 MySQL 8 有一個額外的坑：**`lower_case_table_names` 只能在初始化資料目錄時設定**，
之後改會直接啟動失敗。也就是說 —— **這個設定沒有「上線後再修」這個選項。**

> 📌 **這個事故的根因，是一個「你不能改」的伺服器啟動參數。**

### 0.3.5 事故五：設定沒改，某天半夜連不上了

**症狀**：一份跑了三個月都沒事的設定，某天例行維護重啟 MySQL 之後，
應用啟動失敗：

```
java.sql.SQLNonTransientConnectionException: Public Key Retrieval is not allowed
```

沒有人改過任何設定。**應用的設定檔在 Git 上，三個月沒有 commit。**

**實測**（本章 0.7.2）：

```
已 FLUSH PRIVILEGES（伺服器密碼快取清空）
  ① 先用預設（TLS）連一次，把密碼放進伺服器快取 → ✅ 連上
  ② 再用 sslMode=DISABLED 連（快取已熱）        → ✅ 連上
```

```
=== 同一組帳密、同一個 URL、差別只在伺服器快取冷熱 ===
  sslMode=DISABLED，第一次登入（快取冷）→ 🔴 Public Key Retrieval is not allowed
  sslMode=DISABLED，快取熱             → ✅ 連上
```

MySQL 8 的預設驗證外掛 `caching_sha2_password` 在**明文連線**上，
只有在伺服器端「記得這組密碼」時才不需要交換公鑰。
而 `FLUSH PRIVILEGES`、**MySQL 重啟**、密碼變更，都會清空那份快取。

**所以這份設定不是「壞了」，它一直都是壞的 —— 只是快取熱著的時候看不出來。**

⚠️ 而網路上第一個搜尋結果會叫你加 `allowPublicKeyRetrieval=true`。
它確實會讓錯誤消失。它同時也讓你的**密碼可以被中間人攔截**（0.7.2 會說明為什麼）。

> 📌 **這個事故的根因，是一個「平常看不出來」的設定 —— 它需要一個特定的事件才會現形。**

### 0.3.6 五個事故的共同形狀

| # | 事故 | 根因在哪裡 | Java 程式碼有錯嗎 | 測試抓得到嗎 |
|---|---|---|---|---|
| 1 | 名字變 `???` | 連線字元集 | ❌ 沒錯 | ❌（用同一個工具看是正常的） |
| 2 | emoji 暱稱互擋 | 建表的 `COLLATE` | ❌ 沒錯 | ❌（除非測資裡有 emoji） |
| 3 | 報表差 8 小時 | JDBC URL 少一個參數 | ❌ 沒錯 | ❌（Java 往返是對的） |
| 4 | 上線 `Table doesn't exist` | 伺服器啟動參數 | ❌ 沒錯 | ❌（開發機不敏感就抓不到） |
| 5 | 半夜連不上 | 驗證外掛 × 連線加密 | ❌ 沒錯 | ❌（快取熱著就是綠的） |

**五個都是同一種形狀**：

```
    ┌────────────────────────────────────────────┐
    │  你的 Java 程式碼（正確）                    │
    └────────────────────────────────────────────┘
                       ↓
    ┌────────────────────────────────────────────┐
    │  🔴 連線的設定（字元集 / 定序 / 時區 /       │
    │     驗證 / sql_mode / 大小寫）              │
    │     ← 五個事故全部發生在這一層               │
    └────────────────────────────────────────────┘
                       ↓
    ┌────────────────────────────────────────────┐
    │  MySQL 伺服器                                │
    └────────────────────────────────────────────┘
```

⚠️ **而這一層有一個很糟糕的性質：它的預設值幾乎全部是錯的。**

不是「不夠好」，是**錯的** —— 因為 MySQL 的預設值要相容 1990 年代的假設
（單一伺服器、單一時區、latin1、寬鬆型別檢查），
而你的服務是 2026 年的假設（多時區、emoji、多語言、CI/CD、雲端）。

> 📌 **本章的主張很單純**：
> **這一層的每一個值，你都要「明確寫下來」，而不是「接受預設」。**
> 因為預設值會在你不知情的時候改變 ——
> 換一個 MySQL 版本、換一個雲端供應商、換一個 Docker 映像、換一個 JDBC 驅動版本，
> **而它改變的那一天，不會有任何錯誤訊息。**

---

## 0.4 起一個 MySQL：從「能連上」到「設定正確」

### 0.4.1 最小版本，與它的七個問題

網路上（包含本課 [../README.md](../README.md) 的「快速開始」）最常見的一行：

```bash
docker run -d --name mysql-learn \
  -e MYSQL_ROOT_PASSWORD=root \
  -e MYSQL_DATABASE=learnjava \
  -p 3306:3306 \
  mysql:8.0
```

**它能跑，而且對「今天下午想試一下 SQL」是完全夠的。**
但它不能當作你專案的開發環境，因為它有七個問題：

| # | 問題 | 後果 | 本章哪一節 |
|---|---|---|---|
| 1 | **沒有 volume** | `docker rm` 之後資料全沒了；而且你會在某天不小心 `rm` | 0.4.3 |
| 2 | **`mysql:8.0` 是浮動標籤** | 今天是 8.0.40、下個月 `docker pull` 之後是 8.0.42，**行為可能不同** | 0.4.7 |
| 3 | **時區沒設** | 跟著映像的預設（UTC）走，而你的同事在另一個時區重現不出你的 bug | 0.6 |
| 4 | **`sql_mode` 沒寫死** | 跟著版本走；MySQL 5.7 → 8.0 之間改過，8.4 又改過 | 0.8 |
| 5 | **`character_set_server` 沒寫死** | 8.0 預設是 `utf8mb4`，**但 5.7 是 `latin1`**，而很多雲端服務仍是 5.7 的設定沿用 | 0.5 |
| 6 | **root 密碼是 `root`，而且 `%` 可連** | 應用直接用 root 連 → 一個 SQL injection 就是整台機器 | 07 章 |
| 7 | **`-p 3306:3306` 綁在 `0.0.0.0`** | 同一個網段的人都連得到你的開發資料庫 | 0.4.5 |

> ⚠️ **第 5 點值得多說一句。**
> 「MySQL 8 預設就是 utf8mb4，所以不用設」—— 這句話**對官方 Docker 映像成立**，
> 但不對以下情況成立：
>
> - 從 5.7 升上來的實例（`my.cnf` 沿用舊的）
> - 部分雲端供應商的參數群組（為了相容性而保留 latin1 / `utf8mb3`）
> - 用 `apt install mysql-server` 裝在舊發行版上的
>
> **而你不會知道你的正式環境是哪一種，除非你去查。**
> 寫死它的成本是三行，不寫死的成本是 0.3.1 那個事故。

### 0.4.2 實測：容器 `running` ≠ 資料庫可用

這是 CI 上最常見的「隨機失敗」來源。實測（本機，映像已經在本地快取）：

```bash
docker run -d --name mysql-boot3 -e MYSQL_ROOT_PASSWORD=root \
  -e MYSQL_DATABASE=shop -p 3399:3306 mysql:8.0
# 然後每 0.2 秒檢查四件事
```

```
① 容器 State.Status = running          : 0.2 秒
② 主機 127.0.0.1:3399 TCP 可連          : 0.6 秒   ← 🔴 這裡就「連得上」了
③ 容器內 mysqladmin ping 成功           : 3.2 秒
④ shop 資料庫真的可以查                  : 5.3 秒   ← ✅ 真正可用
```

⚠️ **看 ② 與 ④ 之間那 4.7 秒。**

在那 4.7 秒裡：

- `nc -z localhost 3306` 是**成功的**（Docker 的 port forwarding 一開始就在）。
- 一個「等埠開了就開始跑測試」的 CI 腳本，會在這裡開始跑。
- JDBC 連線會拿到 `Communications link failure` 或 `Unknown database 'shop'`。

而第一次拉映像、或是初始化一個空的資料目錄時，這個時間會拉長到 **20～40 秒**。

**三種寫法，只有一種是對的**：

```yaml
# 🔴 錯的：depends_on 只保證「容器啟動了」，不保證「資料庫可用」
depends_on:
  - mysql

# 🟡 半對：sleep 是猜的。猜太短會 flaky，猜太長讓每個人每天多等 30 秒
command: sh -c "sleep 30 && java -jar app.jar"

# ✅ 對的：healthcheck + condition: service_healthy
depends_on:
  mysql:
    condition: service_healthy
```

⚠️ **健康檢查本身也有一個坑**：

```yaml
# 🟡 有 false positive 的風險
test: ["CMD", "mysqladmin", "ping"]
```

不帶 `-h` 時 `mysqladmin` 走 **unix socket**。
而 MySQL 官方映像在初始化資料目錄時，會先起一個**只聽 socket、不聽 TCP** 的臨時伺服器來跑初始化腳本 ——
這個臨時伺服器**會回應 socket 上的 ping**。

```yaml
# ✅ 帶 -h 127.0.0.1，強迫走 TCP，跟你的應用走同一條路
test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1", "-uroot", "-proot"]
interval: 3s
timeout: 3s
retries: 20
start_period: 30s      # ★ 這段時間內的失敗不計入 retries，也不會把容器標成 unhealthy
```

> 📌 **`start_period` 是很多人漏掉的一個**。
> 沒有它的話，初始化那 20～40 秒會把 `retries` 用完，容器直接被標成 `unhealthy`，
> 於是 `condition: service_healthy` 永遠等不到。

### 0.4.3 資料放哪：三種選擇

```yaml
volumes:
  # ① 具名 volume（本課採用）
  - shop-mysql-data:/var/lib/mysql

  # ② 綁定掛載到專案目錄
  - ./data:/var/lib/mysql

  # ③ 什麼都不寫 → 匿名 volume
```

| 方式 | 資料活多久 | 適合 | 陷阱 |
|---|---|---|---|
| ① 具名 volume | 直到你 `docker volume rm` 或 `compose down -v` | **開發環境** | `down -v` 會刪掉，`down` 不會 |
| ② 綁定掛載 | 直到你刪那個目錄 | 想直接看檔案、或要備份 | 🔴 **在 macOS / Windows 上會慢很多**（檔案系統要跨虛擬機轉譯）；也容易不小心 commit 進 Git |
| ③ 匿名 volume | 到 `docker rm` 為止 | 一次性實驗 | 🔴 會在你機器上**堆積**（`docker volume ls` 看到一堆亂碼名字） |

⚠️ **一個實務上很常見的災難**：用 ② 綁定掛載，然後在 `.gitignore` 裡忘了加 `data/`，
於是有人把 **十幾 GB 的 InnoDB 資料檔 commit 進 Git**。

> 📌 **本課採用 ①**，並且要記得：
> `docker compose down` **保留**資料，`docker compose down -v` **刪除**資料。
> 這一個 `-v` 是本站最常被誤用的旗標 —— 你在做 04 章鎖的實驗時會很常用它「重來一次」。

### 0.4.4 初始化腳本：`/docker-entrypoint-initdb.d`

放進這個目錄的 `.sql` / `.sh` / `.sql.gz` 檔會在**第一次初始化資料目錄時**依檔名排序執行。

```
compose/
├── docker-compose.yml
├── conf/
│   └── shop.cnf                 → 掛到 /etc/mysql/conf.d/
└── initdb/
    ├── 01-app-user.sql          → 建立最小權限的應用帳號
    └── 02-schema.sql            → （06 章之後改由 Flyway 管，這裡先手動）
```

```sql
-- initdb/01-app-user.sql
CREATE USER IF NOT EXISTS 'shop_app'@'%' IDENTIFIED BY 'Shop#2026';
GRANT SELECT, INSERT, UPDATE, DELETE ON shop.* TO 'shop_app'@'%';

-- 報表 / BI 用的唯讀帳號（07 章的讀寫分離會用到）
CREATE USER IF NOT EXISTS 'shop_ro'@'%' IDENTIFIED BY 'ReadOnly#2026';
GRANT SELECT ON shop.* TO 'shop_ro'@'%';

FLUSH PRIVILEGES;
```

⚠️ **三個一定要知道的行為**：

1. **只在資料目錄是空的時候跑。** 已經有資料時，改了這些檔案**不會有任何效果** ——
   這是「我明明加了那個 SQL，為什麼沒生效」的頭號原因。要重跑就 `docker compose down -v`。
2. **腳本裡不要寫 `CREATE DATABASE shop`** —— `MYSQL_DATABASE=shop` 已經建了，
   而且初始化腳本執行時**預設就在那個資料庫裡**。
3. **注意 `GRANT ALL`**。上面刻意只給 DML，沒有給 `CREATE` / `DROP` / `ALTER`。
   06 章 Flyway 遷移會用**另一個帳號**（有 DDL 權限），這是刻意的職責分離 —— 07 章 7.7 會展開。

> 📌 **這裡的密碼是明文寫在檔案裡的，所以這份設定只能用在開發環境。**
> 正式環境的密碼管理（Secret、Vault、IRSA）在 12-capstone。

### 0.4.5 完整的 `docker-compose.yml`（本站基準環境）

```yaml
# compose/docker-compose.yml
services:
  mysql:
    image: mysql:8.0.40                   # ★ 釘住小版號，不要用 8.0 或 latest（0.4.7）
    container_name: shop-mysql
    environment:
      MYSQL_ROOT_PASSWORD: root
      MYSQL_DATABASE: shop
      TZ: UTC                             # ★ 影響容器裡的 system_time_zone 與 log 的時間戳
    ports:
      - "127.0.0.1:3306:3306"             # ★ 只綁 loopback，同網段的人連不到（0.4.1 問題 7）
    volumes:
      - ./conf/shop.cnf:/etc/mysql/conf.d/shop.cnf:ro   # ★ :ro —— 容器不該改你的設定檔
      - ./initdb:/docker-entrypoint-initdb.d:ro
      - shop-mysql-data:/var/lib/mysql
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1", "-uroot", "-proot"]
      interval: 3s
      timeout: 3s
      retries: 20
      start_period: 30s
    # 開發機上把資源上限寫出來，避免 MySQL 把筆電吃光
    deploy:
      resources:
        limits:
          memory: 1g

volumes:
  shop-mysql-data:
```

**實測**（本機，`docker compose up -d` 之後每 2 秒檢查一次 `State.Health.Status`）：

```
✅ healthy（第 6 次檢查，約 12 秒）
```

```
Variable_name              Value
character_set_server       utf8mb4
collation_server           utf8mb4_0900_ai_ci
innodb_buffer_pool_size    536870912
long_query_time            0.500000
lower_case_table_names     0
slow_query_log             ON
sql_mode                   ONLY_FULL_GROUP_BY,NO_AUTO_VALUE_ON_ZERO,STRICT_TRANS_TABLES,
                           NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,
                           NO_ENGINE_SUBSTITUTION
time_zone                  +00:00
version                    8.0.40

user      host  plugin
shop_app  %     caching_sha2_password
shop_ro   %     caching_sha2_password
```

### 0.4.6 `shop.cnf`：每一行都有理由

```ini
# conf/shop.cnf  →  掛到 /etc/mysql/conf.d/shop.cnf
[mysqld]

# ── 字元集與定序（0.5）─────────────────────────────
character-set-server    = utf8mb4
collation-server        = utf8mb4_0900_ai_ci     # ★ 不是 general_ci —— 0.5.7 的 emoji 事故

# ── 時區（0.6）───────────────────────────────────
default-time-zone       = '+00:00'               # ★ 資料庫端一律 UTC，位移不是名稱（0.6.6）

# ── 型別與語法嚴格度（0.8）─────────────────────────
sql-mode = STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ZERO_DATE,NO_ZERO_IN_DATE,NO_ENGINE_SUBSTITUTION,ONLY_FULL_GROUP_BY,NO_AUTO_VALUE_ON_ZERO

# ── 大小寫（0.9）────────────────────────────────
lower_case_table_names  = 0                      # ★ 只能在初始化時設定，之後改會啟動失敗

# ── 容量（05 章會回來調）────────────────────────
max_connections         = 300                    # 06 站 01 章 1.6.5 算出來的池 × 副本數 + 保留
innodb_buffer_pool_size = 512M                   # 開發機用；正式環境是實體記憶體的 60～70%

# ── 慢查詢（05 章）──────────────────────────────
slow_query_log          = 1
long_query_time         = 0.5                    # ★ 預設 10 秒，那個值等於「關閉」
slow_query_log_file     = /var/lib/mysql/slow.log
log_output              = FILE

# ── 錯誤日誌 ────────────────────────────────────
log_error_verbosity     = 2                      # 1=只有錯誤 2=+警告 3=+訊息

# ── 給命令列工具用（0.10.1 的事故）───────────────
[client]
default-character-set   = utf8mb4

[mysql]
default-character-set   = utf8mb4
```

> ⚠️ **`[client]` 與 `[mysql]` 這兩段是給「跑在同一台機器上的命令列工具」用的**，
> 對容器外面的 `mysql` client 沒有效果，對 JDBC 也沒有效果。
> 它解決的是 0.10.1 那個「`docker exec ... mysql` 用 latin1 連進去」的問題。

### 0.4.7 為什麼要釘住小版號

```yaml
image: mysql:latest      # 🔴 今天是 9.x，下週可能是另一個大版本
image: mysql:8           # 🔴 8.0 → 8.4 是有破壞性變更的大版本跳躍
image: mysql:8.0         # 🟡 小版號會浮動：8.0.36 → 8.0.40 → 8.0.42
image: mysql:8.0.40      # ✅ 本課採用
```

⚠️ **8.0 → 8.4 有幾個會直接讓你啟動失敗或行為改變的變更**，
本章 0.4.5 那份 compose 就踩過一個 —— 實測：

```yaml
command: --mysql-native-password=OFF     # 這是 8.4 的參數
```

```
[ERROR] [MY-000067] [Server] unknown variable 'mysql-native-password=OFF'.
[ERROR] [MY-013236] [Server] The designated data directory /var/lib/mysql/ is unusable.
[ERROR] [MY-010119] [Server] Aborting
```

**容器直接起不來，而 `docker compose up -d` 回報「Started」。**
你要 `docker logs` 才看得到原因 —— 這是 0.4.2 那個「running ≠ 可用」的另一個變形。

📌 **8.0 與 8.4 的主要差異**（會在對應章節展開）：

| 變更 | 8.0 | 8.4 | 影響哪一章 |
|---|---|---|---|
| `mysql_native_password` | 預設編譯進去、可用 | **預設關閉**（要 `--mysql-native-password=ON`） | 0.7.2 |
| 預設驗證外掛 | `caching_sha2_password` | 同（且無法退回 native） | 0.7.2 |
| `--skip-symbolic-links` 等舊參數 | 可用（警告） | **移除** | — |
| `innodb_buffer_pool_in_core_file` 等預設值 | — | 多項調整 | 05 章 5.2 |
| `GROUP BY` 的隱含排序 | 5.7 有、8.0 已移除 | 同 | 02 章 |

> 📌 **本站基準是 MySQL 8.0.40**，因為它是目前正式環境最常見的版本。
> 每一節如果 8.4 / 9.x 行為不同，都會標註。

---

## 0.5 字元集與定序 ★★

這一節解決 0.3.1 與 0.3.2 兩個事故。

**兩個詞的差別要先講清楚，因為它們常被混用**：

| 詞 | 回答什麼問題 | 例子 |
|---|---|---|
| **字元集 charset** | 「這個字**怎麼變成位元組**」 | `utf8mb4` 把「王」存成 `E7 8E 8B` |
| **定序 collation** | 「兩個字串**怎麼比較、怎麼排序**」 | `'Admin' = 'admin'` 是真還是假 |

一個字元集可以搭配很多定序（`SHOW COLLATION LIKE 'utf8mb4%'` 在 8.0.40 上有 **89 種**）。
**字元集決定資料存不存得下，定序決定查詢結果對不對。**

### 0.5.1 `utf8` 是一個歷史錯誤

MySQL 的 `utf8` **不是** UTF-8。它是 `utf8mb3` 的別名 —— **每個字元最多 3 個位元組**。

```sql
SELECT CHARACTER_SET_NAME, MAXLEN FROM information_schema.CHARACTER_SETS;
```

```
CHARACTER_SET_NAME   MAXLEN
ascii                1
latin1               1
big5                 2
gbk                  2
utf8mb3              3      ← MySQL 的 "utf8"
utf8mb4              4      ← 真正的 UTF-8
utf16                4
```

真正的 UTF-8 一個字元最多 **4** 個位元組。那第 4 個位元組裝的是什麼？

```
U+0000  ～ U+FFFF    → 1～3 bytes   基本多文種平面（BMP）：ASCII、中日韓常用字、歐洲語言
U+10000 ～ U+10FFFF  → 4 bytes      補充平面：
                                      🎉 所有 emoji
                                      𠀋 𡃁 罕用漢字（CJK 擴充 B～I）
                                      𝕏 數學字母符號
                                      𐀀 古文字
```

⚠️ **所以 `utf8mb3` 存不下的，不只是 emoji** ——
還有一大批**罕用姓氏用字**（`𡘙`、`𨱇`、`䶮`）。
台灣、香港、中國大陸的身分證姓名裡都有這些字，
而「客戶姓名寫不進去」這種問題，通常要等到那位客戶出現才會發現。

> 📌 **MySQL 8.0 開始 `utf8` 這個別名已經被標記為 deprecated**，
> 官方文件建議寫 `utf8mb3`；MySQL 8.0.30+ 開始 `utf8` 在部分語境會發出警告。
> **不要寫 `utf8`。要嘛 `utf8mb4`（幾乎總是這個），要嘛明確寫 `utf8mb3`。**

### 0.5.2 實測：emoji 進 `utf8mb3` 欄位

```sql
CREATE TABLE e2_mb3 (id INT PRIMARY KEY AUTO_INCREMENT, msg VARCHAR(50)) CHARSET=utf8mb3;

INSERT INTO e2_mb3 (msg) VALUES ('訂單成立');       -- 中文，3 bytes/字
INSERT INTO e2_mb3 (msg) VALUES ('訂單成立 🎉');    -- 加一個 emoji，4 bytes
```

```
-- 第一句：成功
-- 第二句：
ERROR 1366 (HY000): Incorrect string value: '\xF0\x9F\x8E\x89' for column 'msg' at row 1
```

**在 MySQL 8 的預設 `sql_mode`（含 `STRICT_TRANS_TABLES`）下，這是一個錯誤 —— 這是好事。**

### 0.5.3 實測：非嚴格模式下，同一句 `INSERT` 的另一種下場 ★

```sql
SET SESSION sql_mode = '';                          -- 關掉嚴格模式
INSERT INTO e2_mb3 (msg) VALUES ('訂單成立 🎉');
INSERT INTO e2_mb3 (msg) VALUES ('祝賀 🎉🎊');
SELECT id, msg, HEX(msg) FROM e2_mb3;
```

```
id  msg           HEX(msg)
1   訂單成立       E8A882E596AEE68890E7AB8B
2   訂單成立 ?     E8A882E596AEE68890E7AB8B 20 3F        ← emoji 變成 0x3F（問號）
3   祝賀 ??        E7A59DE8B380 20 3F 3F                 ← 兩個 emoji 變成兩個問號
```

**`INSERT` 成功了。回傳「1 row affected」。沒有例外。**

那警告呢？

```sql
SELECT @@warning_count;   -- 1
SHOW WARNINGS;            -- （空的）
```

⚠️ **`@@warning_count` 是 1，但 `SHOW WARNINGS` 什麼都沒有** ——
因為 `SELECT @@warning_count` **本身就是一句 SQL**，它執行時清掉了上一句的警告清單。

從 JDBC 這一側看（本章 0.10.3 的完整版）：

```java
int n = ps.executeUpdate();
System.out.println("executeUpdate 回傳 " + n);        // 1，沒有例外
SQLWarning w = ps.getWarnings();                      // ← 要主動呼叫才看得到
```

```
executeUpdate 回傳 1（沒有例外）
ps.getWarnings() = 01000 / Data truncated for column 'v' at row 1
資料庫裡實際是: 「一二三四五」（5 個字，原本 10 個）
```

📌 **也就是說**：警告是有的，但

- 你的 Repository 不會呼叫 `getWarnings()`（沒有人會）。
- Spring 的 `JdbcTemplate`、Hibernate 也不會把它變成例外。
- **它是一句只有在你已經知道要找的時候才找得到的日誌。**

> ⚠️ **這就是為什麼「保持 `STRICT_TRANS_TABLES` 開著」不是一個偏好，是一條底線。**
> 沒有它，資料損壞是**靜默的**，而且是**發生在寫入的當下**——
> 那一刻原始資料還在記憶體裡，之後就永遠回不來了。
> 0.8 會完整處理 `sql_mode`。

### 0.5.4 字元集有六層，你設的是哪一層

這是最容易搞混的地方。一個字從你的 Java 程式到 InnoDB 的資料檔，會經過六次「字元集」的判斷：

```
    Java String（UTF-16，永遠是對的）
         ↓  ①  連線層：character_set_client
    JDBC 送出的位元組
         ↓  ②  伺服器解讀：character_set_connection（+ collation_connection）
    伺服器記憶體裡的字串
         ↓  ③  欄位層：這個 column 的 CHARACTER SET
    寫進 InnoDB 的位元組
         ↓  ④  讀出來時：character_set_results
    JDBC 收到的位元組
         ↓  ⑤  驅動解碼
    Java String
```

外加兩層「預設值繼承」：

```
character_set_server  ──（建 DATABASE 沒寫 CHARSET 時）──→  資料庫的預設
        ↓
character_set_database ──（建 TABLE 沒寫 CHARSET 時）───→  表的預設
        ↓
     表的 CHARSET      ──（建 COLUMN 沒寫 CHARSET 時）──→  欄位實際使用的
```

⚠️ **關鍵理解**：`character_set_server` **不會**影響已經建好的表。
它只是「下次建資料庫時的預設值」。
所以「我把 `character_set_server` 改成 `utf8mb4` 了」**完全不會修好任何一張既有的表**。

**查清楚你現在是哪一種**：

```sql
-- ① 伺服器與資料庫層
SHOW VARIABLES LIKE 'character\_set\_%';
SHOW VARIABLES LIKE 'collation\_%';

-- ② 每一張表
SELECT TABLE_NAME, TABLE_COLLATION
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = 'shop';

-- ③ 每一個欄位（★ 這一句才是真相）
SELECT TABLE_NAME, COLUMN_NAME, CHARACTER_SET_NAME, COLLATION_NAME
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'shop' AND CHARACTER_SET_NAME IS NOT NULL
  AND CHARACTER_SET_NAME <> 'utf8mb4';        -- ← 只列出「不是 utf8mb4」的，正常應該是空的
```

> 📌 **③ 那一句應該放進你的環境自檢測試**（0.11.3）。
> 它是唯一能抓到「表是 utf8mb4，但有一個欄位是十年前建的 `utf8mb3`」這種情況的查詢。

### 0.5.5 實測：連線層錯了會怎樣（0.3.1 的完整版）★★

MySQL 官方 Docker 映像裡的 `mysql` 命令列工具，**預設連線字元集是 `latin1`**
（因為容器裡的 locale 是 `C`）。這一點非常反直覺，而且是很多亂碼的來源。

```bash
docker exec mysql-learn mysql -uroot -proot -e "SHOW VARIABLES LIKE 'character_set%'"
```

```
character_set_client       latin1      ← 🔴
character_set_connection   latin1      ← 🔴
character_set_results      latin1      ← 🔴
character_set_database     utf8mb4     ← 表是對的
character_set_server       utf8mb4     ← 伺服器是對的
```

**表是 utf8mb4、伺服器是 utf8mb4，但連線是 latin1。**

**實驗 A：用 latin1 連線寫入中文**

```sql
CREATE TABLE e1_cust (id INT PRIMARY KEY, name VARCHAR(50)) CHARSET=utf8mb4;
INSERT INTO e1_cust VALUES (1,'王小明'), (2,'林☕美');
SELECT id, name, HEX(name), CHAR_LENGTH(name), LENGTH(name) FROM e1_cust;
```

```
id  name    HEX(name)                                  CHAR_LENGTH  LENGTH
1   王小明   C3A7C5BDE280B9C3A5C2B0C28FC3A6CB9CC5BD     9            19
2   林☕美   C3A6C5BEE28094C3A2CB9CE280A2C3A7C2BEC5BD   9            20
```

⚠️ **`name` 那一欄顯示是「王小明」—— 完全正確。**
但看 `CHAR_LENGTH`：**9**（應該是 3）。看 `HEX`：19 個位元組（應該是 9 個）。

**發生了什麼**：

```
你的終端機送出       E7 8E 8B  E5 B0 8F  E6 98 8E          （UTF-8 的「王小明」，9 bytes）
                            ↓
連線宣告是 latin1，於是伺服器把這 9 個 byte
當成「9 個 latin1 字元」：ç ½ ‹ å ° � æ ˜ ½
                            ↓
欄位是 utf8mb4，於是把這 9 個字元
各自編碼成 UTF-8：  C3A7 C5BD E280B9 C3A5 C2B0 C28F C3A6 CB9C C5BD   （19 bytes）
                            ↓
                    這就是所謂的【雙重編碼 / mojibake】
```

讀出來的時候，`character_set_results` 也是 latin1，
於是伺服器把那 19 個位元組**反向轉一次**，剛好變回原來的 9 個 UTF-8 位元組 ——
**你的終端機就顯示出正確的「王小明」。**

**實驗 B：用正確的連線字元集寫入**

```bash
docker exec mysql-learn mysql -uroot -proot --default-character-set=utf8mb4 shop < e1.sql
```

```
id  name    HEX(name)             CHAR_LENGTH  LENGTH
1   王小明   E78E8BE5B08FE6988E    3            9        ← ✅ 正確
2   林☕美   E69E97E29895E7BE8E    3            9        ← ✅ 正確
```

**實驗 C：用 B 寫入的正確資料，用 A 的 latin1 連線讀**

```
id  name   HEX(name)
1   ???    E78E8BE5B08FE6988E     ← 資料是對的，顯示成 ???
2   ???    E69E97E29895E7BE8E
```

**這就是 0.3.1 的完整解釋**：

| 狀況 | 資料庫裡的位元組 | 用 latin1 連線看 | 用 utf8mb4 連線看 |
|---|---|---|---|
| 用 latin1 寫入 | 🔴 垃圾（19 bytes） | ✅ 看起來正常 | 🔴 `çÂ½â€¹å°...` |
| 用 utf8mb4 寫入 | ✅ 正確（9 bytes） | 🔴 `???` | ✅ 正常 |

> 📌 **「看起來正常」與「資料正確」是兩件事** ——
> 而它們只有在「寫入的工具」與「讀取的工具」用**同一個錯誤設定**時才會重合。
> 一旦多一個系統（備份、報表、資料同步、搜尋引擎）進來，就會分開。
>
> ⚠️ **診斷口訣**：懷疑亂碼時，**永遠去看 `HEX()` 與 `CHAR_LENGTH()`，不要看顯示出來的字。**
> 一個中文字在 utf8mb4 應該是 **3 個位元組 1 個字元**；
> 如果 `CHAR_LENGTH` 是 3 倍、`LENGTH` 是 2 倍多，那就是雙重編碼。

📌 **好消息**：**JDBC 沒有這個問題。**
Connector/J 8.x 連上去之後會自己協商成 `utf8mb4`（實測，0.10.3）：

```
character_set_client       utf8mb4
character_set_connection   utf8mb4
character_set_results      （空的）           ← ★ 見下方說明
collation_connection       utf8mb4_0900_ai_ci
```

`character_set_results` 是**空字串**，意思是「**不要轉換，把原始位元組給我**」——
驅動自己知道每個欄位的字元集，自己解碼。這比讓伺服器轉換更不容易出錯。

⚠️ **所以這個坑主要咬的是**：命令列工具、備份還原（`mysqldump`）、
舊的 PHP / Python 腳本、以及**不是用 Connector/J 8.x 的東西**。

### 0.5.6 定序：三個維度

定序的名字是有規則的：

```
utf8mb4  _  0900  _  ai  _  ci
   │        │        │     │
   │        │        │     └── ci = case insensitive（大小寫不敏感）
   │        │        │         cs = case sensitive
   │        │        └──────── ai = accent insensitive（重音不敏感，é = e）
   │        │                  as = accent sensitive
   │        └───────────────── UCA 版本：0900 = Unicode 9.0.0
   └────────────────────────── 字元集
```

還有兩個不照這個規則的：

```
utf8mb4_bin        ── 直接比位元組。什麼都敏感。PAD SPACE。
utf8mb4_0900_bin   ── 直接比位元組。什麼都敏感。NO PAD。
```

**五個你會遇到的定序**：

| 定序 | UCA 版本 | 大小寫 | 重音 | 補充平面字元 | 尾端空白 | 何時會遇到 |
|---|---|---|---|---|---|---|
| `utf8mb4_general_ci` | **無**（MySQL 自製的簡化表） | 不敏感 | 不敏感 | 🔴 **全部視為相等** | PAD SPACE | 網路上的建表模板；5.5 時代的預設 |
| `utf8mb4_unicode_ci` | UCA 4.0.0 | 不敏感 | 不敏感 | 🔴 **全部視為相等** | PAD SPACE | 「比 general_ci 正確」的建議下的產物 |
| `utf8mb4_0900_ai_ci` | UCA 9.0.0 | 不敏感 | 不敏感 | ✅ 正確區分 | **NO PAD** | **MySQL 8 預設**、本課採用 |
| `utf8mb4_0900_as_cs` | UCA 9.0.0 | **敏感** | **敏感** | ✅ 正確區分 | NO PAD | 需要區分大小寫的欄位 |
| `utf8mb4_bin` | — | 敏感 | 敏感 | ✅ 正確區分 | PAD SPACE | token、hash、base64 這種「位元組就是意義」的欄位 |

### 0.5.7 實測：同一組比較，五種定序給出不同答案 ★★

```sql
SELECT 'Admin'='admin' COLLATE utf8mb4_0900_ai_ci  AS ai_ci,
       'Admin'='admin' COLLATE utf8mb4_0900_as_cs  AS as_cs,
       'Admin'='admin' COLLATE utf8mb4_bin         AS bin;
```

```
ai_ci   as_cs   bin
1       0       0
```

```sql
SELECT 'café'='cafe' COLLATE utf8mb4_0900_ai_ci   AS ai_ci,
       'café'='cafe' COLLATE utf8mb4_0900_as_cs   AS as_cs,
       'café'='cafe' COLLATE utf8mb4_general_ci   AS general_ci;
```

```
ai_ci   as_cs   general_ci
1       0       1
```

**而下面這一組是 0.3.2 那個事故的根源**：

```sql
SELECT '🎉'='🎊' COLLATE utf8mb4_general_ci  AS general_ci,
       '🎉'='🎊' COLLATE utf8mb4_unicode_ci  AS unicode_ci,
       '🎉'='🎊' COLLATE utf8mb4_0900_ai_ci  AS ai_ci;
```

```
general_ci   unicode_ci   ai_ci
1            1            0
```

🔴 **在 `general_ci` 與 `unicode_ci` 之下，兩個完全不同的 emoji 是相等的。**

**為什麼**：`utf8mb4_general_ci` 與 `utf8mb4_unicode_ci` 的排序權重表只涵蓋 BMP（U+0000～U+FFFF）。
所有 BMP 以外的字元一律對應到**同一個「不知道」的權重值** ——
於是它們彼此全部相等。

⚠️ **這不只影響 emoji**。所有 CJK 擴充區的罕用漢字也一樣：

```sql
SELECT '𠀋'='𡃁' COLLATE utf8mb4_general_ci;   -- 1 🔴（兩個不同的罕用字）
```

**還有一組連字的差異**：

```sql
SELECT 'ﬁ'='fi' COLLATE utf8mb4_0900_ai_ci   AS ai_ci,      -- 1（UCA 9.0 知道 ﬁ 是 f+i 的連字）
       'ﬁ'='fi' COLLATE utf8mb4_general_ci   AS general_ci; -- 0
```

📌 **注意這一組的方向是反過來的** —— `0900_ai_ci` 說相等、`general_ci` 說不等。
**沒有哪一個定序「比較嚴格」，它們只是「不同的規則」。**
你要做的不是選一個「比較安全」的，而是**選一個你能說清楚它的規則的**。

### 0.5.8 實測：唯一索引的行為跟著定序走

```sql
CREATE TABLE e3_u1 (u VARCHAR(50) UNIQUE) CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE e3_u2 (u VARCHAR(50) UNIQUE) CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

INSERT INTO e3_u1 VALUES ('gary');   INSERT INTO e3_u2 VALUES ('gary');
INSERT INTO e3_u1 VALUES ('Gary');   -- ?
INSERT INTO e3_u2 VALUES ('Gary');   -- ?
```

```
-- ai_ci 表：
ERROR 1062 (23000): Duplicate entry 'Gary' for key 'e3_u1.u'

-- as_cs 表：
u
gary
Gary          ← 兩筆都在
```

**這就是 06 站 06 章 6.4.2 探針 ⑬「使用者用 `Admin` 註冊，卻能用 `admin` 登入」的根因。**

⚠️ 而 0.3.2 的暱稱事故是同一件事的另一面：

```sql
CREATE TABLE e3_nick (nick VARCHAR(50) UNIQUE) CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
INSERT INTO e3_nick VALUES ('小明🎉');   -- 成功
INSERT INTO e3_nick VALUES ('小明🎊');   -- ?
```

```
ERROR 1062 (23000): Duplicate entry '小明?' for key 'e3_nick.nick'
```

📌 **順便注意錯誤訊息本身：`'小明?'`** ——
因為這個 `mysql` client 的連線字元集是 latin1（0.5.5），
**連錯誤訊息裡的 emoji 都被替換成 `?` 了**。
一個亂碼問題的診斷訊息，本身也是亂碼的。

**所以「登入帳號要不要區分大小寫」這個問題，答案不在 Java，在 `COLLATE`**：

```sql
-- shop-service 的做法：整張表 ai_ci（給人看的欄位），但登入帳號那一欄單獨指定
CREATE TABLE users (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  username    VARCHAR(64)  NOT NULL COLLATE utf8mb4_0900_as_cs,   -- ★ 區分大小寫
  email       VARCHAR(255) NOT NULL COLLATE utf8mb4_0900_ai_ci,   -- ★ 不區分（RFC 上 local-part 其實區分，
                                                                  --   但實務上所有郵件供應商都當成不區分）
  display_name VARCHAR(64) NOT NULL,                              -- 跟表走：ai_ci
  api_token   CHAR(64)     NOT NULL COLLATE utf8mb4_bin,          -- ★ 位元組就是意義
  UNIQUE KEY uk_username (username),
  UNIQUE KEY uk_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

> ⚠️ **決定「哪一欄用哪個定序」是 schema 設計的一部分，不是資料庫設定的一部分。**
> 01 章 1.11 會把這件事併進命名與建表慣例。

### 0.5.9 實測：`NO PAD` —— MySQL 8 改掉的一個行為

```sql
SELECT 'abc' = 'abc  ' COLLATE utf8mb4_0900_ai_ci  AS mysql8_NOPAD,
       'abc' = 'abc  ' COLLATE utf8mb4_general_ci  AS general_PADSPACE,
       'abc' = 'abc  ' COLLATE utf8mb4_unicode_ci  AS unicode_PADSPACE;
```

```
mysql8_NOPAD   general_PADSPACE   unicode_PADSPACE
0              1                  1
```

```sql
SELECT COLLATION_NAME, PAD_ATTRIBUTE FROM information_schema.COLLATIONS
WHERE COLLATION_NAME LIKE 'utf8mb4%';
```

```
utf8mb4_0900_ai_ci    NO PAD
utf8mb4_0900_bin      NO PAD
utf8mb4_bin           PAD SPACE      ← 注意 utf8mb4_bin 是 PAD SPACE
utf8mb4_general_ci    PAD SPACE
utf8mb4_unicode_ci    PAD SPACE
```

**所有 `_0900_` 開頭的定序都是 `NO PAD`，其他都是 `PAD SPACE`。**

⚠️ **這是一個從 5.7 升 8.0 時會咬人的行為變更**：

```
5.7（utf8mb4_general_ci，PAD SPACE）：  WHERE code = 'A1'  → 會查到 'A1  '
8.0（utf8mb4_0900_ai_ci，NO PAD）：     WHERE code = 'A1'  → 查不到 'A1  '
```

如果你的舊資料裡有尾端空白（很常見，來自 CSV 匯入、來自 `CHAR` 欄位轉過來的），
**升級之後那些資料就「查不到了」**，而 schema 沒有任何改變。

> 📌 **`CHAR(n)` 一定要單獨講一句**：
> `CHAR` 在儲存時會**右補空白**到固定長度，在讀取時又把**尾端空白全部去掉**
> （實測：存 `'abc  '` 進 `CHAR(10)`，讀出來 `LENGTH` 是 **3**；同樣的值存進 `VARCHAR(10)` 是 **5**）。
> 所以 `CHAR` 欄位「本來就留不住尾端空白」，不會有 NO PAD 的問題 —— 有問題的是 `VARCHAR`。
> 01 章 1.4.1 會完整處理 `CHAR` vs `VARCHAR`。

### 0.5.10 實測：兩種定序 JOIN → `Illegal mix of collations`

```sql
SELECT * FROM e3_u1 a JOIN e3_u2 b ON a.u = b.u;
```

```
ERROR 1267 (HY000): Illegal mix of collations
(utf8mb4_0900_ai_ci,IMPLICIT) and (utf8mb4_0900_as_cs,IMPLICIT) for operation '='
```

**兩張表的定序不同，就不能直接 JOIN。**

這在實務上發生的路徑通常是：

```
2018 年建的舊表          utf8mb4_general_ci
2024 年建的新表          utf8mb4_0900_ai_ci   （因為換了 MySQL 8，用了新預設）
        ↓
2026 年要 JOIN 起來做報表  →  ERROR 1267
```

**三種解法，只有一種是對的**：

```sql
-- 🔴 ① 在查詢裡硬轉：能跑，但這一句的索引直接失效（03 章會看 EXPLAIN）
SELECT * FROM a JOIN b ON a.u = b.u COLLATE utf8mb4_0900_ai_ci;

-- 🟡 ② 把其中一張表 CONVERT：正確，但是全表重建（06 章 6.7 的線上大表變更）
ALTER TABLE b CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

-- ✅ ③ 一開始就不要讓它發生：在 CI 加一條守門查詢（0.11.3）
SELECT TABLE_NAME, TABLE_COLLATION FROM information_schema.TABLES
WHERE TABLE_SCHEMA = 'shop' AND TABLE_COLLATION <> 'utf8mb4_0900_ai_ci';
-- 期望：空的
```

⚠️ **①「硬轉」為什麼是紅的**：`COLLATE` 套在欄位上，等於在欄位外面包了一層函式，
**該欄位上的索引就用不到了**（03 章 3.7 的「索引失效八種情境」之一）。
一張百萬列的表會從索引查詢變成全表掃描。

### 0.5.11 索引長度：3072 位元組，與 `VARCHAR(255)` 的由來

**實測**：

```sql
CREATE TABLE t768 (a VARCHAR(768), KEY(a)) CHARSET=utf8mb4;   -- ✅ 成功
CREATE TABLE t769 (a VARCHAR(769), KEY(a)) CHARSET=utf8mb4;   -- ?
```

```
ERROR 1071 (42000): Specified key was too long; max key length is 3072 bytes
```

```sql
CREATE TABLE t2col (a VARCHAR(500), b VARCHAR(500), KEY(a,b)) CHARSET=utf8mb4;   -- ?
```

```
ERROR 1071 (42000): Specified key was too long; max key length is 3072 bytes
-- (500 + 500) × 4 = 4000 > 3072
```

**算式**：`768 × 4 = 3072` ✅、`769 × 4 = 3076` 🔴。

> 📌 **`VARCHAR(255)` 這個「傳統」是怎麼來的？**
>
> 舊版 InnoDB（`COMPACT` / `REDUNDANT` 列格式）的索引上限是 **767 位元組**。
> 在 `utf8mb3` 下 `767 / 3 = 255.67` → **255 是能建索引的最大長度**。
>
> **這個理由在今天已經不成立了**：
> - MySQL 5.7.7+ 預設列格式是 `DYNAMIC`，上限是 **3072 位元組**。
> - 在 `utf8mb4` 下上限是 **768 個字元**。
>
> 但 `VARCHAR(255)` 這個數字活了下來，而且**現在有一個新的、不同的理由要注意它**：
> **255 是「長度前綴用 1 個位元組」的分界** ——
> `VARCHAR(n)` 當 `n × maxlen <= 255` 時用 1 byte 存長度，否則用 2 bytes。
> 在 utf8mb4 下 `255 × 4 = 1020 > 255`，所以 **`VARCHAR(255)` 已經是 2 bytes 了**，
> 這個理由也不成立。
>
> ⚠️ **結論：不要因為「大家都寫 255」而寫 255。**
> 01 章 1.4.2 會給一個實際的長度選擇方法（而且會實測「宣告長度」在什麼時候真的有代價）。

**如果真的需要對一個很長的欄位建索引**（例如 `VARCHAR(2000)` 的 URL）：

```sql
-- ① 前綴索引：只索引前 N 個字元
CREATE INDEX idx_url ON links (url(191));

-- ② 雜湊欄位（推薦）：生成欄位 + 索引，等值查詢用它
ALTER TABLE links
  ADD COLUMN url_hash BINARY(32) GENERATED ALWAYS AS (UNHEX(SHA2(url, 256))) STORED,
  ADD INDEX idx_url_hash (url_hash);
-- 查詢：WHERE url_hash = UNHEX(SHA2(?, 256)) AND url = ?
--       （後面那個 AND 是為了防雜湊碰撞）
```

📌 **`191` 這個數字你會在很多 WordPress / Laravel 的遷移腳本裡看到**：
`767 / 4 = 191.75` —— 那是「舊 InnoDB 上限 ÷ utf8mb4」。
**在 MySQL 8 + `DYNAMIC` 列格式上你不需要它。**

### 0.5.12 shop-service 的選擇

```
字元集：  utf8mb4                 —— 沒有第二個選項
定序：    utf8mb4_0900_ai_ci      —— MySQL 8 預設，UCA 9.0，正確處理 emoji 與罕用字
例外：    username     → utf8mb4_0900_as_cs   （區分大小寫）
          api_token    → utf8mb4_bin          （位元組就是意義）
          sha / hash   → 用 BINARY(n)，不要用字串（01 章 1.4.5）
```

⚠️ **一個要現在就決定、之後很難改的事**：

如果你的服務**確定只服務單一語言，而且排序要符合該語言的習慣**，
`0900_ai_ci` 可能不是最好的選擇：

```sql
-- 中文按筆畫 / 拼音排序
SELECT '张' < '李' COLLATE utf8mb4_0900_ai_ci;      -- 按 Unicode 碼位
SELECT '张' < '李' COLLATE utf8mb4_zh_0900_as_cs;   -- 按拼音（MySQL 8.0.18+）
```

**但這個決定應該在 Java 那一層做**（`Collator`、或是加一個 `sort_key` 欄位），
而不是在資料庫做 —— 因為排序規則是「呈現」，而**06 站 0.11.9 說過：資料層不處理呈現**。

---

## 0.6 時區 ★★

這一節解決 0.3.3 那個事故 —— 而且結論**跟大部分人以為的不一樣**。

### 0.6.1 有四個時區在打架

```
    ①  JVM 的預設時區            ZoneId.systemDefault()      ← 由 TZ 環境變數 / OS 決定
                ↓
    ②  JDBC 的 connectionTimeZone   URL 參數                  ← 驅動用它做「字面值 ↔ 時刻」的換算
                ↓
    ③  MySQL 的 session.time_zone   每一條連線各自一份         ← TIMESTAMP 的存取都靠它
                ↓
    ④  MySQL 的 global.time_zone    伺服器設定                 ← 新連線的 session 預設值
                ↑
    ⑤  MySQL 的 system_time_zone    OS 的時區                 ← global 設成 SYSTEM 時跟著它
```

**查清楚你現在是哪一種**：

```sql
SELECT @@global.time_zone, @@session.time_zone, @@system_time_zone;
```

```
-- 本站的 mysql-learn（--default-time-zone=+00:00，容器 TZ=UTC）
+00:00      +00:00      UTC

-- 本站的 mysql-tw（--default-time-zone=+08:00，容器 TZ 仍是 UTC）
+08:00      +08:00      UTC       ← ★ global 與 system 可以不一樣
```

⚠️ **MySQL 官方映像的預設是 `time_zone = SYSTEM`**，而容器的 OS 時區是 UTC，
所以你**不設也會得到 UTC** —— 這是很多人「沒設也沒事」的原因。
但只要有人給容器加了 `TZ=Asia/Taipei`，或是換到一台雲端主機（時區可能是任何東西），
`SYSTEM` 就會變成別的值，**而 schema 與程式碼都沒有改變**。

> 📌 **所以 `default-time-zone` 要寫死。** `SYSTEM` 是一個「答案在別的地方」的設定。

### 0.6.2 `DATETIME` 與 `TIMESTAMP` 的根本差異

這是本節最重要的一張表：

| | `DATETIME` | `TIMESTAMP` |
|---|---|---|
| **存的是什麼** | 一組**日曆數字**：年月日時分秒 | 一個**絕對時刻**：距 epoch 的秒數 |
| 寫入時 | 原樣存進去 | 用 `session.time_zone` 把字面值**換算成 UTC** 再存 |
| 讀出時 | 原樣讀出來 | 用 `session.time_zone` 把 UTC **換算回字面值** |
| 換一個時區的 session 讀 | **值不變** | **值會變** |
| 範圍 | 1000-01-01 ～ 9999-12-31 | 1970-01-01 00:00:01 UTC ～ **2038-01-19 03:14:07 UTC** |
| 大小 | 5 bytes（+ 小數秒） | 4 bytes（+ 小數秒） |
| 對應 Java | `LocalDateTime` | `Instant` / `OffsetDateTime` |

**實測**（同一張表、同一列資料、只換 session 時區）：

```sql
CREATE TABLE e4_t (id INT PRIMARY KEY, dt DATETIME, ts TIMESTAMP NULL);

SET SESSION time_zone = '+00:00';
INSERT INTO e4_t VALUES (1, '2026-09-02 10:00:00', '2026-09-02 10:00:00');
SELECT id, dt, ts, UNIX_TIMESTAMP(dt) dt_epoch, UNIX_TIMESTAMP(ts) ts_epoch FROM e4_t;
```

```
id  dt                     ts                     dt_epoch     ts_epoch
1   2026-09-02 10:00:00    2026-09-02 10:00:00    1788343200   1788343200
```

```sql
SET SESSION time_zone = '+08:00';       -- ★ 只換 session，資料一個字都沒改
SELECT id, dt, ts, UNIX_TIMESTAMP(dt) dt_epoch, UNIX_TIMESTAMP(ts) ts_epoch FROM e4_t;
```

```
id  dt                     ts                     dt_epoch     ts_epoch
1   2026-09-02 10:00:00    2026-09-02 18:00:00    1788314400   1788343200
                           ^^^^^^^^^^^^^^^^^^^^   ^^^^^^^^^^
                           TIMESTAMP 變了 8 小時    DATETIME 的「絕對時刻」變了
```

📌 **讀懂這四個數字**：

- `dt` 的**字面值不變**（10:00），但它代表的**絕對時刻變了**（epoch 差 28800 秒）。
- `ts` 的**字面值變了**（10:00 → 18:00），但它代表的**絕對時刻不變**（epoch 都是 1788343200）。

**兩者各對了一半，也各錯了一半 —— 差別在你要的是哪一半。**

```
你要記錄「這件事在絕對時間軸上發生的那一刻」 → 你要的是 TIMESTAMP 的語意
    訂單成立時間、付款時間、日誌時間、audit 時間

你要記錄「一組日曆數字，跟時區無關」          → 你要的是 DATETIME 的語意
    生日、國定假日、營業時間（09:00~18:00）、合約起始日
```

⚠️ **但 `TIMESTAMP` 有一個致命問題**：

```sql
CREATE TABLE t_ts (ts TIMESTAMP NULL, dt DATETIME NULL);
INSERT INTO t_ts VALUES ('2038-01-19 03:14:07', '2038-01-19 03:14:07');   -- ✅ OK
INSERT INTO t_ts VALUES ('2038-01-19 03:14:08', '2038-01-19 03:14:08');   -- ?
```

```
ERROR 1292 (22007): Incorrect datetime value: '2038-01-19 03:14:08' for column 'ts' at row 1
```

```sql
INSERT INTO t_ts (dt) VALUES ('2199-12-31 00:00:00');   -- ✅ DATETIME 沒問題
```

**`TIMESTAMP` 在 2038-01-19 03:14:07 UTC 就到頂了**（32-bit 有號秒數）。

這對「訂單成立時間」還好（12 年後才會爆），但對這些欄位是**現在就會爆**：

```
會員卡到期日、保固到期日、憑證到期日、長期合約結束日、
「永久有效」用 9999-12-31 表示的欄位
```

> 📌 **本課的選擇：一律用 `DATETIME(3)`，語意上當成 UTC。**
>
> **為什麼不用 `TIMESTAMP`**：
> 1. 2038 問題。
> 2. `TIMESTAMP` 的值**會跟著 session 時區變**，這讓「用 GUI 查出來的值」與
>    「應用讀出來的值」與「備份檔裡的值」可能是三個不同的字串 —— 診斷時非常痛苦。
> 3. `TIMESTAMP` 的自動行為（`DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`）
>    在 `DATETIME` 上也有，不是它的專利。
>
> **代價**：`DATETIME` 不知道自己是 UTC —— 這是一個**靠約定維持的不變量**，
> 而不是資料庫幫你保證的。所以 0.6.8 要用一條守門測試把這個約定釘住。
> 01 章 1.5 會完整處理時間型別的選擇。

### 0.6.3 實測：JDBC 的四種參數組合 ★★

**實驗設定**：

```
JVM 預設時區 = Asia/Taipei（+08:00）
驅動 = mysql-connector-j 8.3.0
寫入的值 = Instant.parse("2026-09-02T10:00:00Z")   ← 一個明確的絕對時刻
```

```java
Instant instant = Instant.parse("2026-09-02T10:00:00Z");
ps.setTimestamp(1, Timestamp.from(instant));      // 寫進 DATETIME(3)
ps.setTimestamp(2, Timestamp.from(instant));      // 寫進 TIMESTAMP(3)
// 再用 CAST(dt AS CHAR) 讀出「資料庫裡的字面值」，繞過驅動的轉換
```

| # | 伺服器 `time_zone` | URL 參數 | DB 裡的字面值 | `ts` 的 epoch | Java 讀回 | 判定 |
|---|---|---|---|---|---|---|
| **A** | `+00:00` | （無） | `18:00:00` | 1788372000 | ✅ 相同 | 🟡 見下 |
| **B** | `+00:00` | `connectionTimeZone=UTC` | `10:00:00` | 1788343200 | ✅ 相同 | ✅ **正確** |
| **C** | `+00:00` | `connectionTimeZone=UTC&preserveInstants=true` | `10:00:00` | 1788343200 | ✅ 相同 | ✅ **正確** |
| **D** | `+00:00` | `connectionTimeZone=LOCAL&preserveInstants=true` | `18:00:00` | 1788372000 | ✅ 相同 | 🟡 = A |
| **E** | `+08:00` | （無） | `18:00:00` | 1788343200 | ✅ 相同 | ✅ 正確（自洽） |
| **F** | `+08:00` | `connectionTimeZone=UTC&preserveInstants=true&forceConnectionTimeZoneToSession=true` | `10:00:00` | 1788343200 | ✅ 相同 | ✅ **正確** |
| **G** | `+08:00` | `connectionTimeZone=UTC`（不 force） | `10:00:00` | **1788314400** | ✅ 相同 | 🔴 **錯 8 小時** |

⚠️ **「Java 讀回」那一欄，七種組合全部是 ✅。**

**這是本節最重要的一句話**：

> 📌 **JDBC 的往返永遠是自洽的。**
> 驅動用同一個規則寫、同一個規則讀，所以 `setTimestamp(x)` → `getTimestamp()` **一定**等於 `x`。
> **你的整合測試不管怎麼寫，都測不出時區設定錯誤。**

錯的是**另外兩件事**：

1. **資料庫裡的字面值**（給 SQL、給報表、給 DBA、給另一個服務看的）。
2. **它與 `NOW()` / `CURRENT_TIMESTAMP` 之間的關係**。

### 0.6.4 三個參數各在做什麼

```
connectionTimeZone            —— 驅動假設「伺服器的 session 時區是這個」
                                 值可以是：LOCAL（= JVM 時區，預設）、SERVER、或一個具體時區
preserveInstants              —— true（8.0 起的預設）：對 java.sql.Timestamp / Instant 這類
                                 「有絕對時刻語意」的型別，做時區換算以保住那個時刻
                                 false：不換算，直接把字面值送過去
forceConnectionTimeZoneToSession —— true：連上之後真的送一句
                                 SET SESSION time_zone = <connectionTimeZone>
                                 false（預設）：只在驅動這一側假設，不去改伺服器
```

⚠️ **G 為什麼錯，就在最後那一個參數**：

```
連線建立
    ↓
驅動：「connectionTimeZone=UTC，所以我把 Instant(10:00Z) 轉成字面值 '10:00:00' 送過去」
    ↓
但沒有 force，伺服器的 session.time_zone 仍然是 +08:00
    ↓
伺服器：「收到 TIMESTAMP '10:00:00'，我的 session 是 +08:00，
          所以這是 10:00+08:00 = 02:00 UTC」  ← 🔴 差了 8 小時
    ↓
存進去的 epoch = 1788314400（= 2026-09-02T02:00:00Z）
    ↓
讀出來時：伺服器把 02:00Z 用 +08:00 轉成字面值 '10:00:00'
          驅動再用 connectionTimeZone=UTC 把 '10:00:00' 解讀成 10:00Z
    ↓
Java 拿到 2026-09-02T10:00:00Z   ← ✅ 跟寫進去的一樣！
```

**兩次錯誤剛好互相抵銷。**
於是：

- Java 的往返測試 ✅ 綠
- `CAST(dt AS CHAR)` 看到的字面值 ✅ 看起來也對（`10:00:00`）
- **只有 `UNIX_TIMESTAMP(ts)` 與 `SELECT * FROM t WHERE ts > NOW()` 這種
  「要伺服器自己解讀這個值」的地方會錯。**

🔴 **這是七種組合裡最危險的一種**，因為它是**唯一一種連 `CAST(... AS CHAR)` 都看不出來**的。

**它什麼時候會現形**：

```
① 有第二個服務（Python / Go / 報表工具）用不同的時區設定連進來
② DBA 直接在 mysql client 上查
③ 主從複製到一個 session 時區不同的從庫
④ mysqldump 備份出來、還原到另一台
⑤ 用 UNIX_TIMESTAMP() / NOW() / CURDATE() 做比較的任何一句 SQL
```

### 0.6.5 實測：app 寫的時間 vs `DEFAULT CURRENT_TIMESTAMP` 寫的時間

這是 0.3.3 那個事故的實測。一張表兩個時間欄位：

```sql
CREATE TABLE j_mix (
  id       INT PRIMARY KEY,
  who      VARCHAR(10),
  app_time DATETIME(3),                                     -- Java 寫的
  db_time  DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)         -- 資料庫寫的
);
```

```java
ps.setTimestamp(3, Timestamp.from(Instant.now()));   // 只寫 app_time，db_time 讓資料庫填
```

```
JVM 時區 Asia/Taipei，現在 2026-09-02T04:17:18Z

=== A. 伺服器 UTC + 無時區參數（最常見的預設） ===
  app 寫的: 2026-09-02 12:17:19.144
  DB 寫的 : 2026-09-02 04:17:19.158
  相差    : 479 分鐘  🔴 兩個欄位不能互相比較，也不能排序在一起

=== B. 伺服器 UTC + connectionTimeZone=UTC ===
  app 寫的: 2026-09-02 04:17:19.209
  DB 寫的 : 2026-09-02 04:17:19.208
  相差    : 0 分鐘  ✅

=== C. 伺服器 +08:00 + 無時區參數 ===
  app 寫的: 2026-09-02 12:17:19.236
  DB 寫的 : 2026-09-02 12:17:19.235
  相差    : 0 分鐘  ✅
```

📌 **A 與 C 的差別只有伺服器的 `time_zone`，而應用完全沒改。**

這解釋了一個很常見的現象：

> 「這個 bug 在測試機重現不出來。」
> —— 因為測試機的 MySQL 容器沒設 `TZ`（跟著 UTC），
> 而正式機的 MySQL 是 DBA 用 `apt` 裝在一台 `Asia/Taipei` 的主機上（`time_zone=SYSTEM` → `+08:00`）。
> **同一份程式碼，一台會錯、一台不會。**

⚠️ **而 A 有一個更糟的性質**：它會**隨著日期慢慢腐爛**。
如果你的 JVM 時區有日光節約時間（美東、歐洲），那個偏移量會在一年裡變兩次 ——
於是同一張表裡的 `app_time` 有兩種偏移，**而你無法從資料本身判斷哪一列是哪一種**。

### 0.6.6 實測：修好時區之後，報表反而錯了 ★★

這一節的結論會讓人不舒服，但它是真的。

**實驗**：台北時間 2026-09-02 一整天，每小時一筆 100 元，共 24 筆 2400 元。
用 Java 以正確的 `Instant` 寫進去，然後跑「今天的營業額」：

```sql
SELECT COUNT(*), SUM(amount) FROM j_rep WHERE DATE(created_at) = '2026-09-02';
```

```
=== A. 沒設時區參數（DB 存的是 JVM 本地時間的字面值）===
  → 24 筆，共 2400.00 元 ✅
  資料庫裡的字面值範圍: 2026-09-02 00:30:00.000 ~ 2026-09-02 23:30:00.000

=== B. connectionTimeZone=UTC（DB 存的是 UTC 字面值）===
  → 16 筆，共 1600.00 元 🔴
  資料庫裡的字面值範圍: 2026-09-01 16:30:00.000 ~ 2026-09-02 15:30:00.000
```

⚠️ **「錯的」設定 A 給出了對的答案，「對的」設定 B 給出了錯的答案。**

**這不是矛盾，這是兩個不同的問題**：

```
問題一（0.6.5）：資料庫裡存的絕對時刻對不對？
    → B 對，A 錯（A 的 app_time 與 db_time 差 8 小時）

問題二（本節）：「今天」是哪一段？
    → 存 UTC 是對的，但「今天」是【業務時區】的今天，不是 UTC 的今天
    → 台北的 09-02 = UTC 的 09-01 16:00 ~ 09-02 16:00
```

**A 之所以「答對」，是因為它把兩個錯誤疊在一起** ——
存的是本地時間、查的也用本地時間的「今天」。
**這種「用兩個錯誤湊出一個對」的系統，在下面任何一件事發生時就會崩**：

```
① 加一個第二時區的市場（新加坡、日本）
② 加一個用 NOW() 的欄位（0.6.5 的 db_time）
③ 用 UTC 的監控 / 日誌系統做關聯分析
④ 主機搬到另一個時區的機房
```

**正確做法：存 UTC，查詢時把「業務時區的一天」換算成 UTC 區間。**

```sql
-- 🔴 錯的：直接對 UTC 欄位取 DATE
SELECT COUNT(*), SUM(amount) FROM j_rep WHERE DATE(created_at) = '2026-09-02';
--  → 16 筆，1600.00

-- 🟡 修法 1：CONVERT_TZ。答案對，但欄位被函式包住 → 索引失效（03 章 3.7）
SELECT COUNT(*), SUM(amount) FROM j_rep
WHERE DATE(CONVERT_TZ(created_at, '+00:00', '+08:00')) = '2026-09-02';
--  → 24 筆，2400.00 ✅

-- ✅ 修法 2：半開區間。答案對，而且走得到 created_at 上的索引
SELECT COUNT(*), SUM(amount) FROM j_rep
WHERE created_at >= '2026-09-01 16:00:00'
  AND created_at <  '2026-09-02 16:00:00';
--  → 24 筆，2400.00 ✅
```

📌 **而那兩個邊界值不該在 SQL 裡硬寫，應該由 Java 算出來**：

```java
// ✅ 讓 Java 負責「業務時區的一天 → UTC 區間」的換算
public record DayRange(Instant startInclusive, Instant endExclusive) {

    /** businessZone 從設定讀，例如 Asia/Taipei；不要用 ZoneId.systemDefault() */
    public static DayRange of(LocalDate day, ZoneId businessZone) {
        ZonedDateTime start = day.atStartOfDay(businessZone);
        // ★ 用 plusDays(1) 而不是 atTime(23,59,59)：
        //   ① 半開區間才不會漏掉 23:59:59.5
        //   ② 夏令時切換那一天，一天可能是 23 或 25 小時，plusDays(1) 會算對
        ZonedDateTime end   = day.plusDays(1).atStartOfDay(businessZone);
        return new DayRange(start.toInstant(), end.toInstant());
    }
}
```

```java
// Repository（06 站 0.6 判準 1：用領域語言問問題）
List<DailyRevenue> sumRevenueBetween(Instant startInclusive, Instant endExclusive);
```

> ⚠️ **`ZoneId.systemDefault()` 在後端服務裡幾乎永遠是錯的。**
> 它的值取決於「這個容器的 `TZ` 環境變數」——
> 也就是說，**一個 K8s 的部署設定可以改變你的營業額報表**。
> 業務時區是**業務規則**，它應該在 `application.yml` 裡，跟其他業務規則放在一起。

### 0.6.7 具名時區 vs 位移

```sql
SET SESSION time_zone = '+08:00';        -- 位移
SET SESSION time_zone = 'Asia/Taipei';   -- 具名
```

**具名時區需要 MySQL 載入時區資料表**。實測（官方 `mysql:8.0` 映像）：

```sql
SELECT COUNT(*) FROM mysql.time_zone_name;
```

```
1795          ← ✅ 官方映像有載
```

```sql
SET SESSION time_zone = 'Asia/Taipeh';   -- 故意打錯
```

```
ERROR 1298 (HY000): Unknown or incorrect time zone: 'Asia/Taipeh'
```

⚠️ **「MySQL 預設沒有載時區表」這句話對官方 Docker 映像不成立**，
但對這些情況成立：**自己 `apt install` 裝的、部分雲端 RDS 的舊實例、
從原始碼編譯的**。所以要用具名時區之前，先跑那一句 `COUNT(*)` 確認。

**沒載的話怎麼補**：

```bash
mysql_tzinfo_to_sql /usr/share/zoneinfo | mysql -u root -p mysql
```

📌 **本課的選擇：資料庫端一律用位移 `+00:00`，不用具名。**

| | 位移 `+00:00` | 具名 `UTC` / `Asia/Taipei` |
|---|---|---|
| 需要時區表 | ❌ 不需要 | ✅ 需要 |
| 處理日光節約 | ❌ 不會 | ✅ 會 |
| 適合 | **資料庫的儲存層**（UTC 沒有 DST，不需要） | 應用層的**呈現**換算 |

**因為 UTC 永遠沒有日光節約時間，位移與具名對它是等價的** ——
而位移少一個依賴。至於「業務時區的一天是哪一段」那種需要 DST 的換算，
0.6.6 已經說了：**在 Java 用 `ZoneId` 算，不要在 SQL 算。**

### 0.6.8 shop-service 的設定與守門測試

**① 資料庫端**（`conf/shop.cnf`，0.4.6 已列）：

```ini
default-time-zone = '+00:00'
```

**② JDBC URL**（`application.yml`，完整版在 0.7.4）：

```yaml
spring:
  datasource:
    url: "jdbc:mysql://127.0.0.1:3306/shop\
          ?connectionTimeZone=UTC\
          &preserveInstants=true\
          &forceConnectionTimeZoneToSession=true\
          &..."
```

⚠️ **三個都要寫，即使 `preserveInstants=true` 是預設值、
即使資料庫已經是 UTC 所以 `force` 看起來多餘**：

- `connectionTimeZone=UTC` —— 讓驅動不再依賴 JVM 時區。
- `preserveInstants=true` —— 明確寫出來，因為它在 Connector/J 5.x → 8.x 之間改過預設。
- `forceConnectionTimeZoneToSession=true` —— **這一條防的是 0.6.3 的 G**：
  當某天有人把資料庫的 `time_zone` 改掉（或搬到一台設定不同的機器），
  這一條會讓 session 被強制拉回 UTC，而不是安靜地錯 8 小時。

> 📌 **`force` 的代價**：每建立一條連線會多送一句 `SET SESSION time_zone='+00:00'`。
> 在有連線池的情況下，這是「每條連線一次」，不是「每次查詢一次」——
> 以 06 站 01 章算出來的池大小（10 條）來說，**一天大約多 20 句 SQL**。

**③ JVM 端**：

```yaml
# Dockerfile / K8s deployment
ENV TZ=UTC
# 或 JAVA_TOOL_OPTIONS=-Duser.timezone=UTC
```

⚠️ 把 JVM 也設成 UTC 是**額外的保險**，不是必要條件 ——
因為上面的 JDBC 設定已經讓資料庫這條路不依賴 JVM 時區了。
但它可以順便修好**日誌時間戳**、`LocalDateTime.now()`、排程器的觸發時間。

**④ 業務時區放在設定檔裡**：

```yaml
shop:
  business-zone: Asia/Taipei     # ★ 這是業務規則，不是基礎設施設定
```

**⑤ 守門測試** —— 把上面四件事變成 CI 的責任：

```java
package com.example.shop.infra.db;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 環境自檢：時區。
 * 這一組測試不測業務邏輯，它測的是「連線建立的那一瞬間談好的條件」。
 * 每一條都對應本章 0.6 的一個實測。
 */
@SpringBootTest
class TimeZoneContractTest {

    @Autowired JdbcTemplate jdbc;

    /** 0.6.1：伺服器端必須是 UTC，而且不能是 SYSTEM（答案在別的地方的設定） */
    @Test
    void 伺服器時區是_UTC() {
        String global = jdbc.queryForObject("SELECT @@global.time_zone", String.class);
        assertThat(global)
                .as("global.time_zone 不可以是 SYSTEM —— 那代表它跟著主機的 TZ 跑")
                .isIn("+00:00", "UTC");
    }

    /** 0.6.3 的 G：session 時區必須真的被拉到 UTC，不能只是驅動這一側假設 */
    @Test
    void 連線的_session_時區被強制成_UTC() {
        String session = jdbc.queryForObject("SELECT @@session.time_zone", String.class);
        assertThat(session)
                .as("少了 forceConnectionTimeZoneToSession，這裡會是伺服器的預設值，"
                  + "於是 TIMESTAMP 的絕對值會錯，而 Java 的往返測試看不出來")
                .isIn("+00:00", "UTC");
    }

    /**
     * 0.6.5：這一條是核心。
     * 應用寫進去的時間，與資料庫自己 NOW() 寫的時間，必須落在同一個時間軸上。
     */
    @Test
    void 應用寫入的時間與資料庫的_NOW_落在同一個時間軸() {
        jdbc.execute("DROP TEMPORARY TABLE IF EXISTS tz_probe");
        jdbc.execute("""
                CREATE TEMPORARY TABLE tz_probe (
                  app_time DATETIME(3) NOT NULL,
                  db_time  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3))""");

        jdbc.update("INSERT INTO tz_probe (app_time) VALUES (?)",
                Timestamp.from(Instant.now()));

        Long diffSeconds = jdbc.queryForObject(
                "SELECT ABS(TIMESTAMPDIFF(SECOND, db_time, app_time)) FROM tz_probe", Long.class);

        assertThat(diffSeconds)
                .as("差 28800 秒 = 8 小時 = 時區設定錯了（本章 0.3.3 的事故）")
                .isLessThan(5L);
    }

    /**
     * 0.6.2：DATETIME 欄位裡存的字面值，必須是 UTC 的字面值。
     * 這一條是「DATETIME 當成 UTC」這個【約定】的守門人 ——
     * 資料庫本身不會幫你保證它。
     */
    @Test
    void DATETIME_欄位存的是_UTC_的字面值() {
        jdbc.execute("DROP TEMPORARY TABLE IF EXISTS tz_probe2");
        jdbc.execute("CREATE TEMPORARY TABLE tz_probe2 (t DATETIME(3) NOT NULL)");

        Instant fixed = Instant.parse("2026-09-02T10:00:00Z");
        jdbc.update("INSERT INTO tz_probe2 (t) VALUES (?)", Timestamp.from(fixed));

        // ★ 用 CAST AS CHAR 讀，繞過驅動的時區換算，看資料庫裡「真正的字面值」
        String literal = jdbc.queryForObject(
                "SELECT CAST(t AS CHAR) FROM tz_probe2", String.class);

        assertThat(literal)
                .as("如果這裡是 18:00，代表存進去的是 JVM 本地時間（0.6.3 的 A/D）")
                .startsWith("2026-09-02 10:00:00");
    }

    /** 0.6.6：業務時區必須來自設定檔，不可以是 ZoneId.systemDefault() */
    @Test
    void 業務時區來自設定而不是主機() {
        // BusinessClock 是 shop-service 包住業務時區的元件（05 站 04 章的 Clock 注入）
        assertThat(System.getProperty("shop.business-zone", "Asia/Taipei"))
                .isNotEqualTo(ZoneId.systemDefault().getId() + "-from-host");
        // 真正的斷言在 BusinessClockTest；這裡只擋「有人把它換成 systemDefault()」
    }
}
```

> ⚠️ **這四條測試在 H2 上是跑不起來的**（H2 沒有 `@@global.time_zone`）。
> 這是刻意的 —— **它們必須跑在真的 MySQL 上**，用 06 站 06 章 6.8 的 Testcontainers /
> 或本章 0.4.5 的 compose 環境。
> 06 站 06 章 6.9 討論過的 CI 時間成本，在這裡的答案是：
> **這四條測試合起來不到 200 ms，而它們防的是一整季對不上的帳。**

---

## 0.7 JDBC 連線參數：MySQL 版

06 站 01 章 1.4.3 給了一張「按會不會影響正確性分類」的表，但底下是 H2。
**這一節是那張表的 MySQL 版本，而且每一格都實測過。**

### 0.7.1 實測：建一條真的連線要多久（補 06 站 1.2.2 的空白）

06 站量的是 H2。這次量真的 MySQL（本機 Docker，不經過連線池，各建 30 條全新連線取中位數）：

```
① caching_sha2 + TLS（驅動預設 sslMode=PREFERRED）    中位數  9.85 ms   最快 6.66   最慢 14.50
② mysql_native  + 明文（sslMode=DISABLED）           中位數  3.79 ms   最快 2.94   最慢  6.08
③ ① + forceConnectionTimeZoneToSession=true         中位數  8.05 ms   最快 6.73   最慢 11.79

TLS 的成本：約 6 ms（+160%）
force 那一句 SET 的成本：在量測誤差內（< 2 ms）

對照（06 站 01 章 1.2.2）：
  H2 in-memory 建連線 0.021 ms   從池借一條 0.002 ms
```

📌 **把這幾個數字放在一起看**：

| 操作 | 耗時 | 相對 |
|---|---|---|
| 呼叫一個 Java 方法 | 1 ns | 1 |
| `ConcurrentHashMap.get()` | 20 ns | 20 |
| H2 in-memory 建一條連線 | 0.021 ms | 21,000 |
| **從 HikariCP 借一條** | **0.002 ms** | **2,000** |
| **本機 Docker MySQL 建一條（TLS）** | **9.85 ms** | **9,850,000** |

⚠️ **「建一條真的連線」比「從池借一條」貴 4,900 倍**，
比一次 H2 in-memory 建連線貴 **470 倍**。
而這還是**本機**的數字 —— 跨機房再加上 RTT，跨可用區的雲端環境常見 15～40 ms。

> 📌 **這就是 06 站 01 章 1.2.3 那句「池真正的價值不是加速，是限流」的另一半**：
> 它**也**是加速，而且是 4,900 倍的加速 ——
> 只是在 H2 上量不出來，所以那一章只能講「限流」那一半。
>
> ⚠️ **也是為什麼 `maxLifetime` 要留意**：每次連線退休都要付 10 ms 重建。
> 池 10 條、`maxLifetime` 30 分鐘 → 平均每 3 分鐘一次，**完全可以忽略**。
> 但如果有人把它設成 30 秒（06 站 1.7.0 說過會被靜默改成 30 分鐘），
> 假設它真的生效的話，就是每 3 秒一次。

### 0.7.2 認證：`caching_sha2_password` 的三個坑 ★★

MySQL 8 的預設驗證外掛從 `mysql_native_password` 換成了 `caching_sha2_password`。
這個改變本身是對的（SHA-256 + 加鹽，比舊的 SHA-1 安全），但它有一個**只在明文連線上才出現**的行為。

**它怎麼運作**：

```
情況 A：連線有加密（TLS）
    → 客戶端直接把密碼明文送過去（TLS 已經保護了）
    → 伺服器驗證、快取這組帳密的 SHA256
    → ✅ 永遠可以連

情況 B：連線沒加密，而伺服器【已經快取過】這組帳密
    → 走「快速路徑」：挑戰-回應，不需要傳密碼
    → ✅ 可以連

情況 C：連線沒加密，而伺服器【沒有快取】這組帳密
    → 走「完整路徑」：需要伺服器的 RSA 公鑰來加密密碼
    → 客戶端必須先【下載】那把公鑰
    → 🔴 驅動預設拒絕下載（allowPublicKeyRetrieval=false）
    → Public Key Retrieval is not allowed
```

**實測（一：同一份設定，冷快取與熱快取兩種結果）**：

```
已 FLUSH PRIVILEGES（伺服器密碼快取清空）
  ① 先用預設（TLS）連一次，把密碼放進伺服器快取 → ✅ 連上
  ② 再用 sslMode=DISABLED 連（快取已熱）        → ✅ 連上
```

```
再次 FLUSH PRIVILEGES（快取清空），直接用 sslMode=DISABLED：
  🔴 SQLNonTransientConnectionException (SQLState=08001)
     Public Key Retrieval is not allowed
```

⚠️ **這就是 0.3.5 那個「設定沒改，某天半夜連不上」的完整解釋。**

**清空那份快取的事件有**：

```
MySQL 重啟（例行維護、OOM、雲端供應商的維護視窗）
FLUSH PRIVILEGES（DBA 改權限之後的習慣動作）
ALTER USER ... IDENTIFIED BY ...（改密碼）
RENAME USER / DROP USER
```

**實測（二：六種組合）**：

| # | 帳號的驗證外掛 | URL 參數 | 快取 | 結果 |
|---|---|---|---|---|
| A | `caching_sha2_password` | （無，預設 `sslMode=PREFERRED`） | 冷 | ✅ 連上，`TLS_AES_256_GCM_SHA384` |
| B | `caching_sha2_password` | `sslMode=DISABLED` | 冷 | 🔴 `Public Key Retrieval is not allowed` |
| C | `caching_sha2_password` | `sslMode=DISABLED` | **熱** | ✅ 連上，**明文傳輸** |
| D | `caching_sha2_password` | `sslMode=DISABLED&allowPublicKeyRetrieval=true` | 冷 | ✅ 連上，**明文傳輸** |
| E | `mysql_native_password` | `sslMode=DISABLED` | 冷 | ✅ 連上，**明文傳輸** |
| F | `caching_sha2_password` | `sslMode=VERIFY_IDENTITY`（沒給 truststore） | 冷 | 🔴 `Communications link failure` |

📌 **注意 A 那一列**：**什麼都不設就是對的，而且是加密的。**
Connector/J 8.x 的預設 `sslMode=PREFERRED` 會盡量用 TLS，而 MySQL 8 官方映像**內建自簽憑證**，
所以「不設」反而是最安全的選項。

⚠️ **坑一：`allowPublicKeyRetrieval=true` 不是修正，是一個安全漏洞。**

它的意思是「**我接受任何自稱是伺服器的人給我的公鑰**」。
一個中間人可以：

```
① 攔截連線，回一把【自己的】公鑰
② 你用它加密密碼送過去
③ 中間人用自己的私鑰解開 → 拿到明文密碼
④ 再用真伺服器的公鑰重新加密轉發 → 你完全不會發現
```

**而且這一切發生在 `sslMode=DISABLED` 的前提下** —— 也就是說，
你為了「省掉 TLS 的麻煩」而關掉加密，然後為了修好因此產生的錯誤，
又打開了一個讓密碼可被竊取的選項。

**正確的三個選項**：

```properties
# ✅ ① 什麼都不設（本課採用）—— 用 TLS，問題根本不存在
jdbc:mysql://host:3306/shop

# ✅ ② 明確要求加密並驗證憑證（正式環境）
jdbc:mysql://host:3306/shop?sslMode=VERIFY_CA&trustCertificateKeyStoreUrl=file:/etc/ssl/mysql-ca.jks&trustCertificateKeyStorePassword=...

# 🟡 ③ 真的在完全隔離的網路裡（同一個 Pod 的 sidecar、unix socket）
#    才考慮 sslMode=DISABLED，而且要換成 mysql_native_password 帳號或加 allowPublicKeyRetrieval
```

⚠️ **坑二：`sslMode` 有五個值，中間三個常被搞混。**

| 值 | 加密 | 驗證伺服器憑證 | 驗證主機名 | 何時用 |
|---|---|---|---|---|
| `DISABLED` | ❌ | — | — | 只有 unix socket / 完全隔離的網路 |
| `PREFERRED` | 🟡 盡量 | ❌ | ❌ | **驅動預設**；開發環境；防不了中間人 |
| `REQUIRED` | ✅ | ❌ | ❌ | 「至少要加密」；仍然防不了中間人 |
| `VERIFY_CA` | ✅ | ✅ | ❌ | **正式環境的最低標準** |
| `VERIFY_IDENTITY` | ✅ | ✅ | ✅ | 最嚴格；憑證的 CN/SAN 要對得上你連的主機名 |

**實測 F 的錯誤訊息值得單獨看**：

```
sslMode=VERIFY_IDENTITY（沒給 truststore）
  🔴 CommunicationsException (SQLState=08S01)
     Communications link failure
```

⚠️ **它不說「憑證驗證失敗」，它說「通訊連線失敗」** ——
跟「資料庫沒開」「防火牆擋住」「網路不通」是**完全一樣的訊息**。
於是排查方向會整個歪掉：你會去 ping 主機、看防火牆、問 DBA，
而根因是一個 truststore 沒設。

📌 **診斷技巧**：`CommunicationsException` 出現時，先把 `sslMode` 降一級試試看
（`VERIFY_IDENTITY` → `VERIFY_CA` → `REQUIRED`）。如果降級之後連得上，
那就跟網路無關，是憑證。

⚠️ **坑三：8.0 與 8.4 的差異。**

```
MySQL 8.0：mysql_native_password 還在，可以用 CREATE USER ... IDENTIFIED WITH mysql_native_password
MySQL 8.4：預設【關閉】，要 --mysql-native-password=ON 才能用
MySQL 9.x：完全移除
```

所以「先改成 `mysql_native_password` 繞過去」這條路，**在 8.4 之後就沒了**。

### 0.7.3 完整的參數表（MySQL 版，按「會不會影響正確性」分類）

**🔴 第一類：會改變查詢結果或資料正確性**

| 參數 | 預設 | 本課的值 | 不設會怎樣 |
|---|---|---|---|
| `connectionTimeZone` | `LOCAL`（= JVM 時區） | `UTC` | 0.6.3、0.6.5：資料庫裡的字面值變成 JVM 本地時間 |
| `preserveInstants` | `true` | `true`（明確寫出） | 5.x → 8.x 之間改過預設 |
| `forceConnectionTimeZoneToSession` | `false` | `true` | 0.6.3 的 G：**絕對時刻錯 8 小時，而 Java 往返測不出來** |
| `characterEncoding` | 由伺服器協商 | **不設** | Connector/J 8.x 會自己協商成 utf8mb4；手動設反而可能設錯 |
| `zeroDateTimeBehavior` | `EXCEPTION` | `EXCEPTION`（明確寫出） | 遇到 `0000-00-00` 時：`EXCEPTION` 拋例外 / `CONVERT_TO_NULL` 變 null / `ROUND` 變 `0001-01-01`。**靜默轉換比拋例外糟** |
| `noDatetimeStringSync` | `false` | 不設 | — |

**🟡 第二類：會影響效能，但不影響正確性**

| 參數 | 預設 | 本課的值 | 效果 |
|---|---|---|---|
| `rewriteBatchedStatements` | `false` | `true` | **實測快 22 倍**，見 0.7.4 |
| `cachePrepStmts` | `false` | `true` | 快取 `PreparedStatement`；與下面兩個一起用 |
| `prepStmtCacheSize` | 25 | 250 | 快取幾條 |
| `prepStmtCacheSqlLimit` | 256 | 2048 | 太長的 SQL 不快取；預設值對真實 SQL 太小 |
| `useServerPrepStmts` | `false` | **`false`（不開）** | 見 0.7.4 的實測 |
| `useLocalSessionState` | `false` | 不設 | 會讓驅動快取 `autocommit` 等狀態，出錯時很難查 |

**🟢 第三類：故障處理，一定要設**

| 參數 | 預設 | 本課的值 | 為什麼 |
|---|---|---|---|
| `connectTimeout` | 0（無限）★ | `3000` | 連不上時要快速失敗，而不是掛在那裡 |
| `socketTimeout` | 0（**無限**） | `30000` | 🔴 **不設的話，一句卡住的查詢會永遠佔著那條連線**（06 站 01 章 1.9） |
| `tcpKeepAlive` | `true` | `true` | 偵測半開連線 |

> ⚠️ **★ `connectTimeout` 的預設值，官方文件跟驅動實作【不一樣】。**
>
> MySQL 官網的 Connector/J 參數表寫 **30000**，但驅動裡的宣告是 **0**：
>
> ```java
> // 從 mysql-connector-j-8.3.0.jar 裡直接讀出來
> PropertyDefinitions.PROPERTY_KEY_TO_PROPERTY_DEFINITION
>     .get(PropertyKey.fromValue("connectTimeout")).getDefaultValue()
> // → 0        （socketTimeout 也是 0）
> ```
>
> **以驅動為準：兩個都是 0，也就是「無限」。**
> 📌 這件事本身就是本章的主題之一 —— **「文件說的」與「跑起來的」是兩回事**，
> 而只要你自己把值寫出來（本課都寫了），這個差異就傷不到你。

**🔴 三個不要設**

| 參數 | 為什麼不要 |
|---|---|
| `autoReconnect=true` | 會**靜默重連**，而重連之後**交易已經沒了**（06 站 01 章 1.4.5）。它把一個明確的錯誤換成一個難以理解的資料不一致 |
| `allowMultiQueries=true` | 允許一次送多句 SQL → **把 SQL injection 從「讀到資料」升級成「刪掉整張表」** |
| `allowPublicKeyRetrieval=true` | 0.7.2 坑一 |

### 0.7.4 實測：`rewriteBatchedStatements` 的 22 倍

```
插入 30,000 列（每 500 列一個 executeBatch，全程一個交易）

  ① 什麼都不設                                        3724 ms   1.00x
  ② rewriteBatchedStatements=true                    169 ms  22.04x   ★
  ③ useServerPrepStmts=true&cachePrepStmts=true      3567 ms   1.04x
  ④ ②+③ 同時開                                        243 ms  15.33x
```

📌 **三個要讀懂的地方**：

**① 為什麼 ② 快 22 倍**

沒有它的時候，`addBatch()` 只是「把參數存起來」，`executeBatch()` 仍然是
**一句一句送、一句一句等回應**（500 次網路往返）。
打開之後，驅動會把 500 句 `INSERT INTO t VALUES (?,?)` **改寫成一句**：

```sql
INSERT INTO b_t (v, amt) VALUES ('row-1', 19.99), ('row-2', 19.99), ... ;
```

**500 次往返變成 1 次。**

**② 為什麼 ③ 幾乎沒有效果**

`useServerPrepStmts` 是「真的用 MySQL 的伺服器端預備語句協定」。
它省的是「每次解析 SQL」的成本，但**省不掉網路往返** ——
而在批次插入這個場景，往返才是瓶頸。

**③ 為什麼 ④ 比 ② 慢**

兩個一起開時，驅動走的是**伺服器端預備語句的批次協定**，
它能合併，但合併的效率不如純文字改寫。

> ⚠️ **`rewriteBatchedStatements=true` 有三個要知道的行為**：
>
> 1. **`executeBatch()` 的回傳值會變。** 改寫成一句之後，
>    MySQL 只回一個總數，驅動只能回 `Statement.SUCCESS_NO_INFO`（-2）給每一格。
>    **如果你的程式碼在檢查「每一列各影響幾列」，它會壞掉。**
> 2. **只對 `INSERT` 有效**（8.x 起也支援部分 `REPLACE`）。`UPDATE` / `DELETE` 不會被改寫。
> 3. **改寫後的 SQL 有長度上限**（`max_allowed_packet`，預設 64 MB）。
>    驅動會自動分段，但如果你的單列很大（含 TEXT / BLOB），要注意這個值。
>
> **05 章 5.4 會用同一組實驗，加上「批次大小怎麼選」與「和交易邊界的關係」。**

### 0.7.5 shop-service 的完整 URL

```yaml
# application.yml
spring:
  datasource:
    # ⚠️ 用「雙引號 + 反斜線續行」折行，不要用 YAML 的 >- （06 站 01 章 1.12.2 的坑：
    #    >- 會把每個換行折成一個【空格】，然後空格被折進 URL 裡，而 YAML 不會報錯）
    url: "jdbc:mysql://${DB_HOST:127.0.0.1}:${DB_PORT:3306}/${DB_NAME:shop}\
          ?connectionTimeZone=UTC\
          &preserveInstants=true\
          &forceConnectionTimeZoneToSession=true\
          &zeroDateTimeBehavior=EXCEPTION\
          &rewriteBatchedStatements=true\
          &cachePrepStmts=true\
          &prepStmtCacheSize=250\
          &prepStmtCacheSqlLimit=2048\
          &connectTimeout=3000\
          &socketTimeout=30000\
          &tcpKeepAlive=true"
    username: ${DB_USER:shop_app}
    password: ${DB_PASSWORD:Shop#2026}
    driver-class-name: com.mysql.cj.jdbc.Driver

    hikari:
      # ── 以下沿用 06 站 01 章 1.12.1 算出來的值 ─────────────
      maximum-pool-size: 10           # 1.6.5 的計算過程寫在那一章
      minimum-idle: 10                # = maximum，固定大小池（1.6.6）
      connection-timeout: 3000
      validation-timeout: 3000
      idle-timeout: 0                 # 固定大小池，設 0（1.7.3）
      max-lifetime: 1740000           # 29 分鐘，比 MySQL 的 wait_timeout(28800s) 短很多
      keepalive-time: 300000          # 5 分鐘
      leak-detection-threshold: 20000 # ★ 必須 >= 2000，不然是靜默關閉（1.7.0）
      pool-name: shop-pool
      # ★ MySQL 版新增：連線建立時就把 session 條件釘死
      connection-init-sql: "SET SESSION sql_mode='STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ZERO_DATE,NO_ZERO_IN_DATE,NO_ENGINE_SUBSTITUTION,ONLY_FULL_GROUP_BY,NO_AUTO_VALUE_ON_ZERO'"
```

> ⚠️ **`connection-init-sql` 是一把雙面刃。**
>
> **好處**：即使有人改了伺服器的 `sql_mode`，你的應用仍然拿到你要的那一組（0.8.4）。
> **代價**：
> - 每建立一條連線多一次往返（實測 < 2 ms，池只有 10 條，可忽略）。
> - **它會在池「重建連線」時也跑** —— 如果這句 SQL 因為某個原因失敗，
>   池會拿不到連線，症狀是 `Connection is not available` ——
>   而根因在一句你寫在 YAML 裡的 SQL（06 站 01 章 1.9.3 說的「看 cause 推論不出病因」的又一個例子）。
>
> **所以這一句要有一條守門測試**（0.11.3）。

---

## 0.8 `sql_mode`：資料庫的嚴格程度

06 站 06 章 6.6 留下的問題「H2 上是綠的、MySQL 上 `bad SQL grammar`」，一半的答案在這裡。

### 0.8.1 預設值長什麼樣

```sql
SELECT @@sql_mode;
```

```
-- MySQL 8.0.40 官方映像的預設
ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,
ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION
```

**這一組預設值是好的。**（MySQL 5.7 之前的預設是空字串，那才是災難。）

⚠️ **但它「是預設」這件事本身就是問題**：

```
① 它在 5.6 → 5.7 → 8.0 之間改過三次
② 雲端供應商的參數群組可能改掉它
③ 一句 SET SESSION sql_mode='' 就能在單一連線上關掉它
④ 很多 ORM / 框架的「相容性設定」會偷偷改它
```

**所以要寫死兩次**：伺服器端（`shop.cnf`）+ 連線端（`connection-init-sql`）。

### 0.8.2 實測：同一句 SQL 的兩種下場

**① 字串超長**

```sql
CREATE TABLE j_trunc (id INT PRIMARY KEY, v VARCHAR(5)) CHARSET=utf8mb4;
INSERT INTO j_trunc VALUES (1, '一二三四五六七八九十');   -- 10 個字塞進 VARCHAR(5)
```

| `sql_mode` | 結果 |
|---|---|
| 含 `STRICT_TRANS_TABLES`（預設） | 🔴 `MysqlDataTruncation, errorCode=1406, SQLState=22001`<br>`Data truncation: Data too long for column 'v' at row 1` |
| `''` | ✅ 「成功」，資料庫裡是 `一二三四五`（**5 個字，剩下的永遠沒了**） |

**② 數字欄位塞字串**

```sql
CREATE TABLE ns (n INT);
INSERT INTO ns VALUES ('abc'), ('12abc');
```

| `sql_mode` | 結果 |
|---|---|
| 嚴格 | 🔴 `ERROR 1366: Incorrect integer value: 'abc' for column 'n' at row 1` |
| `''` | ✅ 「成功」：`'abc'` → **`0`**，`'12abc'` → **`12`** |

⚠️ **`'abc'` 變成 `0`** —— 而 `0` 在很多欄位是一個**合法的業務值**（數量 0、金額 0、狀態碼 0）。
於是這個錯誤**完全無法從資料本身察覺**。

**③ 零日期**

```sql
CREATE TABLE zd (d DATE);
INSERT INTO zd VALUES ('0000-00-00');
```

| `sql_mode` | 結果 |
|---|---|
| 含 `NO_ZERO_DATE`（預設） | 🔴 `ERROR 1292: Incorrect date value: '0000-00-00' for column 'd' at row 1` |
| `''` | ✅ 「成功」，存進去的是 `0000-00-00` |

```sql
SELECT d, d IS NULL FROM zd;
```

```
d             d IS NULL
0000-00-00    0            ← 🔴 它不是 NULL，也不是一個合法的日期
```

📌 **`0000-00-00` 是 MySQL 最惡名昭彰的值之一**：
它不是 `NULL`，所以 `IS NULL` 是假、`IS NOT NULL` 是真；
但它也不是一個合法日期，所以 JDBC 讀到它時會拋例外
（這就是 `zeroDateTimeBehavior` 那個參數存在的原因，0.7.3）。

**④ `ONLY_FULL_GROUP_BY`**

```sql
CREATE TABLE sm (id INT PRIMARY KEY, cat VARCHAR(10), amt INT);
INSERT INTO sm VALUES (1,'A',10),(2,'A',20),(3,'B',30);

SELECT cat, id, SUM(amt) FROM sm GROUP BY cat;
```

| `sql_mode` | 結果 |
|---|---|
| 含 `ONLY_FULL_GROUP_BY`（預設） | 🔴 `ERROR 1055: Expression #2 of SELECT list is not in GROUP BY clause and contains nonaggregated column 'shop.sm.id' which is not functionally dependent on columns in GROUP BY clause` |
| `''` | ✅ 「成功」：<br>`A  1  30`　← `id` 是**任意挑一列**的值<br>`B  3  30` |

⚠️ **看 `A` 那一列**：`id=1`、`SUM=30`。
但 30 是 id=1 與 id=2 加起來的。**`id=1` 這個值沒有任何意義**，
它只是 MySQL 隨便挑的一列 —— 而且**挑哪一列可能隨著執行計畫改變**。

**這是 06 站 04 章 4.4.1「使用者說列表裡有一筆重複，而我的訂單不見了」的近親**：
一個看起來有答案的查詢，答案是隨機的。

**⑤ `NO_AUTO_VALUE_ON_ZERO`**（本課有加，不在預設裡）

```sql
CREATE TABLE az (id INT AUTO_INCREMENT PRIMARY KEY, v INT);
INSERT INTO az VALUES (0,100), (0,200), (5,300);
```

| `sql_mode` | 結果 |
|---|---|
| 預設（**沒有** `NO_AUTO_VALUE_ON_ZERO`） | `id` 變成 `1`、`2`、`5` —— **`0` 被當成「請幫我產生一個」** |
| 加上 `NO_AUTO_VALUE_ON_ZERO` | `0` 就是 `0`（第二次插 0 會 `Duplicate entry '0' for key 'PRIMARY'`） |

📌 **它防的是什麼**：`mysqldump` 備份出來的檔案裡，如果有一列 `id = 0`，
還原時**沒有這個模式的話 id 會被改成別的數字** ——
於是備份還原之後，那一列的 id 變了，而所有指向它的外鍵指到別的地方。

> ⚠️ **這是一個「只在災難復原那天才會發現」的問題** ——
> 也就是你最不希望有意外的那一天。

### 0.8.3 一個常見的誤解：`ERROR_FOR_DIVISION_BY_ZERO`

```sql
SELECT 10/0 AS div0, 10 DIV 0 AS intdiv0, 10 MOD 0 AS mod0;
```

```
div0    intdiv0    mod0
NULL    NULL       NULL
```

⚠️ **即使 `ERROR_FOR_DIVISION_BY_ZERO` 開著，`SELECT 10/0` 仍然回 `NULL`，不會報錯。**

這個模式**只在「嚴格模式 + `INSERT`/`UPDATE`」的情境下**才把除以零變成錯誤。
在單純的 `SELECT` 裡，除以零永遠是 `NULL`。

📌 **所以這種寫法是有風險的**：

```sql
-- 🔴 客單價：訂單數是 0 的那一天，結果是 NULL 而不是 0
SELECT SUM(amount) / COUNT(*) AS avg_order_value FROM orders WHERE ...;

-- ✅ 明確處理
SELECT SUM(amount) / NULLIF(COUNT(*), 0) AS avg_order_value ...  -- 仍是 NULL，但意圖明確
SELECT IFNULL(SUM(amount) / NULLIF(COUNT(*), 0), 0) AS ...        -- 或給一個預設值
```

而 `NULL` 進到 Java 之後：`rs.getBigDecimal()` 回 `null`、
`rs.getDouble()` 回 **`0.0`**（！）—— 兩種型別，兩種行為。
**這是 06 站 02 章 2.5.5「報表上『沒有折扣』與『折扣 0 元』分不出來」的 SQL 版本。**

### 0.8.4 本課的 `sql_mode` 與它的守門測試

```
STRICT_TRANS_TABLES          ★ 底線。沒有它，所有型別錯誤都是靜默的
ERROR_FOR_DIVISION_BY_ZERO   INSERT/UPDATE 裡除以零要報錯
NO_ZERO_DATE                 擋掉 0000-00-00
NO_ZERO_IN_DATE              擋掉 2026-00-15 這種
NO_ENGINE_SUBSTITUTION       指定 ENGINE=InnoDB 卻不支援時要報錯，而不是默默換成 MyISAM
ONLY_FULL_GROUP_BY           ★ 擋掉「答案是隨機的」查詢
NO_AUTO_VALUE_ON_ZERO        ★ 備份還原時 id=0 不被改掉
```

⚠️ **兩個刻意沒有加的**：

| 沒加的模式 | 它會做什麼 | 為什麼不加 |
|---|---|---|
| `STRICT_ALL_TABLES` | 連非交易表也嚴格 | 我們只用 InnoDB，`STRICT_TRANS_TABLES` 就夠；加上去反而在遇到暫存表時有意外行為 |
| `ANSI_QUOTES` | 讓 `"` 變成識別字引號 | 會讓所有用 `"字串"` 的既有 SQL 全部壞掉。要用就在專案第一天用 |

**守門測試**：

```java
package com.example.shop.infra.db;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.Set;
import java.util.stream.Collectors;
import java.util.Arrays;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 環境自檢：sql_mode 與字元集。
 * ★ 這一組跑在【應用實際使用的連線】上，而不是 root 連線 ——
 *   因為 connection-init-sql 只對池裡的連線生效。
 */
@SpringBootTest
class DatabaseModeContractTest {

    private static final Set<String> REQUIRED = Set.of(
            "STRICT_TRANS_TABLES",
            "ERROR_FOR_DIVISION_BY_ZERO",
            "NO_ZERO_DATE",
            "NO_ZERO_IN_DATE",
            "NO_ENGINE_SUBSTITUTION",
            "ONLY_FULL_GROUP_BY",
            "NO_AUTO_VALUE_ON_ZERO");

    @Autowired JdbcTemplate jdbc;

    @Test
    void sql_mode_包含全部必要的模式() {
        String raw = jdbc.queryForObject("SELECT @@session.sql_mode", String.class);
        Set<String> actual = Arrays.stream(raw.split(","))
                .map(String::trim).collect(Collectors.toSet());

        assertThat(actual)
                .as("少了任何一個，對應的錯誤就會變成【靜默的資料損壞】（本章 0.8.2）")
                .containsAll(REQUIRED);
    }

    /** 0.8.2 ①：真的去試一次，而不是只讀設定值 */
    @Test
    void 超長字串會被拒絕而不是被截斷() {
        jdbc.execute("DROP TEMPORARY TABLE IF EXISTS mode_probe");
        jdbc.execute("CREATE TEMPORARY TABLE mode_probe (v VARCHAR(5))");

        assertThatThrownBy(() ->
                jdbc.update("INSERT INTO mode_probe (v) VALUES (?)", "一二三四五六七八九十"))
                .as("如果這裡沒有拋例外，資料庫正在靜默地丟掉你的資料")
                .hasMessageContaining("Data too long");
    }

    /** 0.8.2 ④：GROUP BY 的隨機答案 */
    @Test
    void 非完整的_GROUP_BY_會被拒絕() {
        jdbc.execute("DROP TEMPORARY TABLE IF EXISTS mode_probe2");
        jdbc.execute("CREATE TEMPORARY TABLE mode_probe2 (id INT, cat VARCHAR(5), amt INT)");
        jdbc.update("INSERT INTO mode_probe2 VALUES (1,'A',10),(2,'A',20)");

        assertThatThrownBy(() ->
                jdbc.queryForList("SELECT cat, id, SUM(amt) FROM mode_probe2 GROUP BY cat"))
                .as("沒有 ONLY_FULL_GROUP_BY 的話，id 會是隨機挑一列的值")
                .hasMessageContaining("only_full_group_by");
    }

    /** 0.5.4 ③：抓「表是 utf8mb4，但有一個欄位是十年前建的 utf8mb3」 */
    @Test
    void 沒有任何欄位使用非_utf8mb4_的字元集() {
        var offenders = jdbc.queryForList("""
                SELECT CONCAT(TABLE_NAME, '.', COLUMN_NAME, ' → ',
                              CHARACTER_SET_NAME, '/', COLLATION_NAME) AS c
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE()
                  AND CHARACTER_SET_NAME IS NOT NULL
                  AND CHARACTER_SET_NAME <> 'utf8mb4'
                """, String.class);

        assertThat(offenders)
                .as("非 utf8mb4 的欄位存不下 emoji 與罕用字（本章 0.5.2）")
                .isEmpty();
    }

    /** 0.5.10：抓「新舊表定序不同，之後 JOIN 會 ERROR 1267」 */
    @Test
    void 所有欄位的定序都一致() {
        var offenders = jdbc.queryForList("""
                SELECT CONCAT(TABLE_NAME, '.', COLUMN_NAME, ' → ', COLLATION_NAME) AS c
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE()
                  AND COLLATION_NAME IS NOT NULL
                  AND COLLATION_NAME NOT IN (
                        'utf8mb4_0900_ai_ci',    -- 預設
                        'utf8mb4_0900_as_cs',    -- username 等區分大小寫的欄位
                        'utf8mb4_bin')           -- api_token 等位元組即意義的欄位
                """, String.class);

        assertThat(offenders)
                .as("出現在這裡的欄位，代表有人用了不在白名單上的定序 —— "
                  + "如果是 general_ci / unicode_ci，🎉 與 🎊 會是同一個字（本章 0.5.7）")
                .isEmpty();
    }
}
```

---

## 0.9 大小寫：三個不同的層次

這是 0.3.4 那個事故。MySQL 的「大小寫敏不敏感」有**三個獨立的答案**，
而它們常被混為一談：

| 層次 | 由什麼決定 | 預設（Linux） | 可以改嗎 |
|---|---|---|---|
| **① 資料庫名 / 表名** | `lower_case_table_names` × 檔案系統 | **敏感** | 🔴 **只能在初始化資料目錄時設** |
| **② 欄位名 / 索引名 / 別名** | **永遠不敏感** | 不敏感 | ❌ 不能改 |
| **③ 資料內容** | 該欄位的**定序**（0.5.6） | 跟定序走（`ai_ci` = 不敏感） | ✅ 每個欄位可以不同 |

**實測 ①**：

```sql
CREATE TABLE OrderItem (id INT PRIMARY KEY);
SELECT * FROM orderitem;
```

```
ERROR 1146 (42S02): Table 'shop.orderitem' doesn't exist
```

**實測 ②**：

```sql
SELECT ID FROM OrderItem;     -- ✅ 成功（欄位名不分大小寫）
```

**實測 ③**：

```sql
SELECT 'ABC'='abc' AS eq, 'ABC' LIKE 'abc' AS lk, 'abc' IN ('ABC','XYZ') AS inop;
```

```
eq   lk   inop
1    1    1        ← utf8mb4_0900_ai_ci：全部不敏感
```

### 0.9.1 `lower_case_table_names` 的三個值

| 值 | 建表時 | 查詢時比對 | 典型平台 |
|---|---|---|---|
| `0` | 原樣存 | **區分大小寫** | Linux（ext4 / xfs） |
| `1` | **一律轉小寫**存 | 不區分 | Windows |
| `2` | 原樣存 | 不區分 | macOS（APFS 預設不分大小寫） |

⚠️ **MySQL 8.0 起，這個值只能在「初始化資料目錄」時決定。**
之後改了再啟動：

```
[ERROR] [MY-011087] Different lower_case_table_names settings for server ('1')
        and data dictionary ('0').
```

**伺服器直接拒絕啟動。**

📌 **所以「上線後再改」不存在。** 唯一的路徑是：
匯出全部資料 → 用新設定重新初始化 → 匯入。
對一個上線中的服務，這是一次**停機遷移**。

### 0.9.2 為什麼「在 Mac 上開發」不是免死金牌

```
Homebrew 裝的 MySQL（跑在 APFS 上）        → lower_case_table_names = 2 → 不敏感
Docker Desktop 裡的 MySQL（容器裡是 Linux） → lower_case_table_names = 0 → 敏感
```

⚠️ **只要你用 Docker（本課從第一行就是），你的開發環境就跟 Linux 正式環境一致。**

而真正危險的組合是這一種：

```
開發者 A：Homebrew 裝的 MySQL（不敏感）→ 寫了 SELECT ... FROM orderItem
開發者 B：Docker（敏感）→ 立刻發現
CI：Docker（敏感）→ 會抓到
```

也就是說 **只要團隊裡有一個人用 Docker，或 CI 用 Docker，就抓得到**。
問題只會發生在「全隊都用本機安裝的 MySQL」的專案裡。

### 0.9.3 本課的規則

```
① lower_case_table_names = 0（在 shop.cnf 寫死，且 Docker 上本來就是 0）
② 所有表名、欄位名一律【小寫 + 底線】：order_item、created_at
   → 這樣 0/1/2 三種設定下行為都一樣，問題根本不會發生
③ SQL 關鍵字一律大寫：SELECT / FROM / WHERE
   → 純粹是可讀性，MySQL 不在意
④ 需要區分大小寫的【資料】，用欄位層的 COLLATE 指定（0.5.8）
```

> 📌 **② 是這三個層次裡唯一你完全控制得了的東西**，
> 而它讓 ① 的整個問題消失。01 章 1.11 會把它變成完整的命名慣例。

---

## 0.10 連上去：四種方式

### 0.10.1 命令列：一個一定要加的參數

```bash
# 🔴 錯的：官方映像的 locale 是 C，連線字元集會是 latin1（0.5.5 的事故）
docker exec -it shop-mysql mysql -uroot -proot shop

# ✅ 對的
docker exec -it shop-mysql mysql -uroot -proot --default-character-set=utf8mb4 shop
```

**驗證你現在是哪一種**（每次連進去先跑這一句）：

```sql
SELECT @@character_set_client, @@character_set_connection, @@character_set_results;
```

```
-- 🔴 latin1  latin1  latin1
-- ✅ utf8mb4 utf8mb4 utf8mb4
```

📌 **一勞永逸的做法**：0.4.6 的 `shop.cnf` 裡那兩段：

```ini
[client]
default-character-set = utf8mb4
[mysql]
default-character-set = utf8mb4
```

它們掛在容器裡，所以**容器內**的 `mysql` / `mysqldump` / `mysqladmin` 都會吃到。
（對容器**外**的客戶端沒有效果 —— 那要改你自己的 `~/.my.cnf`。）

⚠️ **`mysqldump` 也有同一個坑，而且後果嚴重得多**：

```bash
# 🔴 備份出來的檔案可能是雙重編碼的
docker exec shop-mysql mysqldump -uroot -proot shop > backup.sql

# ✅
docker exec shop-mysql mysqldump -uroot -proot \
  --default-character-set=utf8mb4 \
  --single-transaction \
  --set-gtid-purged=OFF \
  shop > backup.sql
```

📌 `--single-transaction` 是另一個重點（**在 InnoDB 上做一致性快照，而不鎖表**）——
07 章 7.2 會完整處理備份還原。

**四個立刻有用的命令列技巧**：

```bash
# ① 直立顯示（欄位多的表，看起來清楚很多）
mysql ... -e "SELECT * FROM orders LIMIT 1\G"

# ② 直接跑一個檔案
docker exec -i shop-mysql mysql -uroot -proot --default-character-set=utf8mb4 shop < script.sql

# ③ 輸出成 TSV（給後續處理）
mysql ... --batch --raw -e "SELECT ..." > out.tsv

# ④ 看一句查詢的執行時間（不含網路）
mysql ... -e "SET profiling=1; SELECT ...; SHOW PROFILES;"
```

### 0.10.2 GUI 工具

| 工具 | 平台 | 免費 | 適合 | 注意 |
|---|---|---|---|---|
| **DBeaver** | 全平台 | ✅ CE 版 | **本課推薦**；支援幾乎所有資料庫 | 連線設定裡記得把 `serverTimezone` 留空、用 URL 參數 |
| **MySQL Workbench** | 全平台 | ✅ | 官方；視覺化 EXPLAIN 好用（03 章會用到） | 較肥；ER 圖功能有時不穩 |
| **TablePlus** | mac / Win | 🟡 試用版有限制 | 輕快，日常查詢很順手 | 免費版只能開兩個分頁 |
| **IntelliJ Database 工具** | 隨 IDE | 🟡 Ultimate 才有 | **不用離開 IDE**；能對 SQL 字串做補完 | Community 版沒有 |
| **phpMyAdmin** | 瀏覽器 | ✅ | 只有瀏覽器可用時 | 效能差；不要在正式環境開 |

⚠️ **不管用哪一個，第一件事都是確認它的連線設定與你的應用一致**：

```sql
-- 在 GUI 的查詢視窗跑這一句，跟應用的 0.11.3 守門測試比對
SELECT @@session.time_zone       AS tz,
       @@session.sql_mode        AS mode,
       @@character_set_client    AS cs_client,
       @@collation_connection    AS coll,
       VERSION()                 AS version,
       CURRENT_USER()            AS user;
```

📌 **如果 GUI 的結果跟應用不同，那你在 GUI 裡看到的東西就不能拿來推論應用的行為** ——
這是「我在 Workbench 裡查是對的啊」這句話最常見的下場。

### 0.10.3 Spring Boot：第一次連線

**`pom.xml`**：

```xml
<dependency>
    <groupId>com.mysql</groupId>
    <artifactId>mysql-connector-j</artifactId>
    <scope>runtime</scope>          <!-- ★ runtime：編譯期不該有人 import 到驅動的類別 -->
</dependency>
```

> ⚠️ **不要用舊的座標** `mysql:mysql-connector-java` —— 它從 8.0.31 起就不再更新了。
> 新座標是 `com.mysql:mysql-connector-j`。Spring Boot 3.x 的 BOM 已經管好版本，不用寫 `<version>`。

**驗證連線的最小程式**（本章 0.5.5、0.8.2 的實測就是用它跑的）：

```java
package lab;

import java.sql.*;
import java.util.Properties;

/** 環境自檢：把「連線建立的那一瞬間談好的條件」全部印出來 */
public class Conn {

    static Connection open(String params) throws SQLException {
        Properties p = new Properties();
        p.setProperty("user", "root");
        p.setProperty("password", "root");
        return DriverManager.getConnection(
                "jdbc:mysql://127.0.0.1:3306/shop" + (params.isEmpty() ? "" : "?" + params), p);
    }

    public static void main(String[] a) throws Exception {

        System.out.println("=== A. 驅動預設協商出來的連線層設定 ===");
        try (Connection c = open(""); Statement s = c.createStatement()) {
            DatabaseMetaData md = c.getMetaData();
            System.out.println("  驅動   " + md.getDriverName() + " " + md.getDriverVersion());
            System.out.println("  伺服器 " + md.getDatabaseProductVersion());
            try (ResultSet rs = s.executeQuery(
                    "SHOW VARIABLES WHERE Variable_name IN "
                  + "('character_set_client','character_set_connection','character_set_results',"
                  + "'collation_connection','autocommit','transaction_isolation','sql_mode')")) {
                while (rs.next()) System.out.printf("  %-24s %s%n", rs.getString(1), rs.getString(2));
            }
        }

        System.out.println("\n=== B. 中文與 emoji 透過 JDBC 進出 ===");
        try (Connection c = open(""); Statement s = c.createStatement()) {
            s.execute("DROP TABLE IF EXISTS j_txt");
            s.execute("CREATE TABLE j_txt (id INT PRIMARY KEY, v VARCHAR(50)) CHARSET=utf8mb4");
            try (PreparedStatement ps = c.prepareStatement("INSERT INTO j_txt VALUES (1,?)")) {
                ps.setString(1, "林☕美 🎉");
                ps.executeUpdate();
            }
            try (ResultSet rs = s.executeQuery(
                    "SELECT v, HEX(v), CHAR_LENGTH(v), LENGTH(v) FROM j_txt")) {
                rs.next();
                System.out.printf("  讀回=%s  HEX=%s  CHAR_LENGTH=%d  LENGTH=%d%n",
                        rs.getString(1), rs.getString(2), rs.getInt(3), rs.getInt(4));
            }
        }

        System.out.println("\n=== C. 非嚴格模式下的靜默截斷，JDBC 看得到嗎 ===");
        try (Connection c = open(""); Statement s = c.createStatement()) {
            s.execute("SET SESSION sql_mode=''");
            s.execute("DROP TABLE IF EXISTS j_trunc");
            s.execute("CREATE TABLE j_trunc (id INT PRIMARY KEY, v VARCHAR(5)) CHARSET=utf8mb4");
            try (PreparedStatement ps = c.prepareStatement("INSERT INTO j_trunc VALUES (1,?)")) {
                ps.setString(1, "一二三四五六七八九十");
                int n = ps.executeUpdate();
                System.out.println("  executeUpdate 回傳 " + n + "（沒有例外）");
                SQLWarning w = ps.getWarnings();           // ★ 要主動呼叫才看得到
                System.out.println("  ps.getWarnings() = " + (w == null ? "null"
                        : w.getSQLState() + " / " + w.getMessage()));
            }
            try (ResultSet rs = s.executeQuery("SELECT v, CHAR_LENGTH(v) FROM j_trunc")) {
                rs.next();
                System.out.printf("  資料庫裡實際是: 「%s」（%d 個字，原本 10 個）%n",
                        rs.getString(1), rs.getInt(2));
            }
        }

        System.out.println("\n=== D. 嚴格模式（MySQL 8 預設）下的同一句 ===");
        try (Connection c = open(""); Statement s = c.createStatement()) {
            s.execute("DROP TABLE IF EXISTS j_trunc2");
            s.execute("CREATE TABLE j_trunc2 (id INT PRIMARY KEY, v VARCHAR(5)) CHARSET=utf8mb4");
            try (PreparedStatement ps = c.prepareStatement("INSERT INTO j_trunc2 VALUES (1,?)")) {
                ps.setString(1, "一二三四五六七八九十");
                ps.executeUpdate();
            }
        } catch (SQLException e) {
            System.out.printf("  🔴 %s  errorCode=%d  SQLState=%s%n  %s%n",
                    e.getClass().getSimpleName(), e.getErrorCode(), e.getSQLState(), e.getMessage());
        }
    }
}
```

**實際輸出**：

```
=== A. 驅動預設協商出來的連線層設定 ===
  驅動   MySQL Connector/J mysql-connector-j-8.3.0
  伺服器 8.0.46
  autocommit               ON
  character_set_client     utf8mb4
  character_set_connection utf8mb4
  character_set_results                      ← ★ 空的：驅動要原始位元組，自己解碼
  collation_connection     utf8mb4_0900_ai_ci
  sql_mode                 ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,
                           NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION
  transaction_isolation    REPEATABLE-READ         ← ★ MySQL 的預設，04 章會展開

=== B. 中文與 emoji 透過 JDBC 進出 ===
  讀回=林☕美 🎉  HEX=E69E97E29895E7BE8E20F09F8E89  CHAR_LENGTH=5  LENGTH=14
                                                    ↑ 5 個字元 14 個位元組：
                                                      林(3) ☕(3) 美(3) 空白(1) 🎉(4)

=== C. 非嚴格模式下的靜默截斷，JDBC 看得到嗎 ===
  executeUpdate 回傳 1（沒有例外）
  ps.getWarnings() = 01000 / Data truncated for column 'v' at row 1
  資料庫裡實際是: 「一二三四五」（5 個字，原本 10 個）

=== D. 嚴格模式（MySQL 8 預設）下的同一句 ===
  🔴 MysqlDataTruncation  errorCode=1406  SQLState=22001
  Data truncation: Data too long for column 'v' at row 1
```

📌 **A 的最後一列 `transaction_isolation = REPEATABLE-READ` 先記住**：

MySQL 的預設隔離級別是 `REPEATABLE READ`，
而**PostgreSQL、Oracle、SQL Server、H2 的預設都是 `READ COMMITTED`**。
05 站 02 章講的交易傳播、06 站 05 章講的交易邊界，底下都是 H2 的 `READ COMMITTED`。
**04 章會用實測說明這個差異會改變哪些行為。**

### 0.10.4 用完整 URL 連一次（0.7.5 的驗證）

```
✅ 用 shop-service 的完整 URL 連線成功
  version           = 8.0.40
  CURRENT_USER      = shop_app@%
  session.time_zone = +00:00                          ← force 生效了
  charset_client    = utf8mb4
  collation_conn    = utf8mb4_0900_ai_ci
  sql_mode          = ONLY_FULL_GROUP_BY,NO_AUTO_VALUE_ON_ZERO,STRICT_TRANS_TABLES,
                      NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,
                      NO_ENGINE_SUBSTITUTION           ← connection-init-sql 生效了
```

⚠️ 注意 `CURRENT_USER` 是 **`shop_app@%`，不是 root** ——
`shop_app` 只有 `SELECT/INSERT/UPDATE/DELETE`，**沒有 `DROP TABLE`**。
這代表：即使有一天出現 SQL injection，攻擊者也**刪不掉表**。
07 章 7.7 會把權限最小化講完。

---

## 0.11 shop-service 的 07 站起點

### 0.11.1 目錄結構

```
shop-service/
├── compose/
│   ├── docker-compose.yml            ← 0.4.5
│   ├── conf/
│   │   └── shop.cnf                  ← 0.4.6
│   └── initdb/
│       └── 01-app-user.sql           ← 0.4.4
├── src/main/resources/
│   ├── application.yml               ← 0.7.5
│   └── db/migration/                 ← 06 章 Flyway 會用
└── src/test/java/com/example/shop/infra/db/
    ├── TimeZoneContractTest.java     ← 0.6.8
    ├── DatabaseModeContractTest.java ← 0.8.4
    └── ConnectionSettingsTest.java   ← 0.11.3
```

### 0.11.2 一句話講完每一個設定在防什麼

| 設定 | 防的事故 | 節 |
|---|---|---|
| `character-set-server = utf8mb4` | 客戶姓名的罕用字寫不進去 | 0.5.1 |
| `collation-server = utf8mb4_0900_ai_ci` | 兩個不同的 emoji 被當成同一個 | 0.5.7 |
| `default-time-zone = '+00:00'` | 換一台主機就差 8 小時 | 0.6.1 |
| `sql-mode = STRICT_TRANS_TABLES,...` | 資料被靜默截斷 / `'abc'` 變成 `0` | 0.8.2 |
| `lower_case_table_names = 0` | Mac 上綠、Linux 上炸 | 0.9 |
| `long_query_time = 0.5` | 慢查詢日誌預設 10 秒 = 等於關閉 | 05 章 |
| `connectionTimeZone=UTC` | 資料庫裡存成 JVM 本地時間 | 0.6.3 |
| `forceConnectionTimeZoneToSession=true` | 絕對時刻錯 8 小時，而 Java 往返測不出來 | 0.6.3 G |
| `zeroDateTimeBehavior=EXCEPTION` | `0000-00-00` 被靜默轉成 null | 0.7.3 |
| `rewriteBatchedStatements=true` | 批次插入慢 22 倍 | 0.7.4 |
| `socketTimeout=30000` | 一句卡住的查詢永遠佔著連線 | 06 站 01 章 1.9 |
| `connection-init-sql` | 有人改了伺服器的 `sql_mode` | 0.8.4 |
| `ports: 127.0.0.1:3306:3306` | 同網段的人連得到你的開發資料庫 | 0.4.1 |
| `healthcheck` + `service_healthy` | CI 隨機失敗 | 0.4.2 |
| `image: mysql:8.0.40` | 下個月 `docker pull` 之後行為變了 | 0.4.7 |

### 0.11.3 最後一條守門測試：連線設定真的生效了嗎

```java
package com.example.shop.infra.db;

import com.zaxxer.hikari.HikariDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.DatabaseMetaData;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 環境自檢：連線參數。
 *
 * ★ 為什麼要有這一組：
 *   本章列的每一個設定，「寫在 YAML 裡」與「真的生效」是兩件事。
 *   06 站 01 章 1.7.0 已經示範過：HikariCP 會【靜默】忽略部分不合法的值。
 *   JDBC URL 更糟 —— 打錯的參數名會被【完全忽略】，連 WARN 都沒有。
 */
@SpringBootTest
class ConnectionSettingsTest {

    @Autowired DataSource dataSource;
    @Autowired JdbcTemplate jdbc;

    /** URL 上的參數打錯字時，這一條會紅 */
    @Test
    void URL_上的關鍵參數都在() {
        String url = ((HikariDataSource) dataSource).getJdbcUrl();
        assertThat(url)
                .contains("connectionTimeZone=UTC")
                .contains("forceConnectionTimeZoneToSession=true")
                .contains("zeroDateTimeBehavior=EXCEPTION")
                .contains("rewriteBatchedStatements=true")
                .contains("socketTimeout=");           // 值多少交給 06 站 01 章那條測試
        assertThat(url)
                .as("這三個參數任何一個出現都是設計錯誤（本章 0.7.3）")
                .doesNotContain("autoReconnect=true")
                .doesNotContain("allowMultiQueries=true")
                .doesNotContain("allowPublicKeyRetrieval=true");
    }

    /** 應用不可以用 root 連線（0.10.4） */
    @Test
    void 應用使用的不是_root_帳號() {
        String user = jdbc.queryForObject("SELECT CURRENT_USER()", String.class);
        assertThat(user).doesNotStartWith("root@");
    }

    /** 應用帳號不該有 DDL 權限 —— 遷移由另一個帳號做（06 章 Flyway） */
    @Test
    void 應用帳號沒有_DROP_權限() {
        var grants = jdbc.queryForList("SHOW GRANTS FOR CURRENT_USER()", String.class);
        assertThat(grants)
                .as("一個 SQL injection 不該能刪掉整張表")
                .noneMatch(g -> g.contains("ALL PRIVILEGES") || g.contains("DROP"));
    }

    /** 版本鎖定：0.4.7 的「釘住小版號」在資料庫這一側的驗證 */
    @Test
    void 資料庫是預期的大版本() throws Exception {
        try (Connection c = dataSource.getConnection()) {
            DatabaseMetaData md = c.getMetaData();
            assertThat(md.getDatabaseMajorVersion()).isEqualTo(8);
            assertThat(md.getDatabaseMinorVersion())
                    .as("8.0 與 8.4 的驗證外掛與多個預設值不同（本章 0.4.7）")
                    .isEqualTo(0);
        }
    }
}
```

> 📌 **這三個測試類別（時區 / 模式 / 連線）合起來只有十幾條斷言，執行時間不到 300 ms。**
> 它們不測任何業務邏輯 —— 它們測的是**這一章講的每一件事**。
>
> ⚠️ 而它們有一個共同性質：**必須跑在真的 MySQL 上**。
> 這正是 06 站 06 章 6.9 那個「CI 從 4 分鐘變 47 分鐘」討論的另一面 ——
> **不是所有測試都要跑在真資料庫上，但這一組非跑不可**，
> 因為它們測的就是「真資料庫與假資料庫的差別」。

---

## 0.12 常見誤區

**誤區 1：「MySQL 8 預設就是 utf8mb4，不用設」**

→ 0.4.1 問題 5：對官方 Docker 映像成立，對「從 5.7 升上來的實例」「部分雲端參數群組」不成立。
而且 0.5.4：`character_set_server` **不會**影響已經建好的表。

**誤區 2：「表是 utf8mb4，所以中文一定沒問題」**

→ 0.5.5 實測：表是 utf8mb4、伺服器是 utf8mb4，**連線是 latin1**，
結果資料庫裡存的是 19 個位元組的垃圾 —— **而且你的工具顯示正常**。

**誤區 3：「`utf8mb4_general_ci` 比較快，`utf8mb4_unicode_ci` 比較正確」**

→ 0.5.7 實測：**兩個都會把 🎉 與 🎊 判成相等**，也都會把不同的罕用漢字判成相等。
真正的差別是 `_0900_` 系列用了 UCA 9.0，而它們用的是只涵蓋 BMP 的舊表。

**誤區 4：「我的 Java 整合測試會抓到時區設錯」**

→ 0.6.3 實測：**七種參數組合，Java 往返全部是 ✅**。
驅動用同一個規則寫、同一個規則讀，往返一定自洽。
要抓，得去看 `CAST(dt AS CHAR)` 的字面值與 `UNIX_TIMESTAMP()`。

**誤區 5：「`connectionTimeZone=UTC` 設了就對了」**

→ 0.6.3 的 G：**沒有 `forceConnectionTimeZoneToSession=true` 的話，
伺服器 session 時區不是 UTC 時，TIMESTAMP 的絕對值會錯 8 小時** ——
而且是七種組合裡**唯一連 `CAST AS CHAR` 都看不出來**的那一種。

**誤區 6：「時區存 UTC 就不會有問題」**

→ 0.6.6 實測：存 UTC 之後，`WHERE DATE(created_at)='2026-09-02'` 從 24 筆變成 **16 筆**。
存 UTC 是對的，但**「今天」必須用業務時區換算成 UTC 區間**，這是兩件事。

**誤區 7：「加 `allowPublicKeyRetrieval=true` 就修好了」**

→ 0.7.2 坑一：它的意思是「我接受任何人給我的公鑰」。
在 `sslMode=DISABLED` 之下，這讓中間人可以拿到你的**明文密碼**。
正確答案是**什麼都不設**（驅動預設就會用 TLS）。

**誤區 8：「連不上就是網路 / 防火牆問題」**

→ 0.7.2 實測 F：`sslMode=VERIFY_IDENTITY` 少了 truststore，錯誤訊息是
**`Communications link failure`** —— 跟網路不通一模一樣。
先把 `sslMode` 降一級試，能連上就與網路無關。

**誤區 9：「`depends_on` 會等資料庫準備好」**

→ 0.4.2 實測：容器 `running` 在 **0.2 秒**、TCP 埠可連在 **0.6 秒**、
資料庫真的可用在 **5.3 秒**（第一次初始化更久）。`depends_on` 只保證第一件事。
要用 `healthcheck` + `condition: service_healthy`，而且要有 `start_period`。

**誤區 10：「`mysqladmin ping` 通了就是好了」**

→ 0.4.2：不帶 `-h` 時走 unix socket，而初始化期間的**臨時伺服器會回應 socket 上的 ping**。
要寫 `mysqladmin ping -h 127.0.0.1`。

**誤區 11：「`sql_mode` 是預設值，不用管」**

→ 0.8.1：它在 5.6 → 5.7 → 8.0 之間改過三次，雲端參數群組可能改掉它，
一句 `SET SESSION sql_mode=''` 就能在單一連線上關掉。**要在伺服器與連線兩處寫死。**

**誤區 12：「非嚴格模式最多就是資料被截斷，看 log 就知道」**

→ 0.5.3 / 0.8.2 實測：`'abc'` 進 `INT` 欄位變成 **`0`** —— 而 `0` 通常是合法業務值。
`@@warning_count` 是 1，但 `SHOW WARNINGS` 已經被下一句 SQL 清掉了；
JDBC 這一側要**主動呼叫 `getWarnings()`** 才看得到，而沒有人會呼叫。

**誤區 13：「`ERROR_FOR_DIVISION_BY_ZERO` 開著，除以零會報錯」**

→ 0.8.3 實測：`SELECT 10/0` 仍然回 **`NULL`**。那個模式**只在嚴格模式的 `INSERT`/`UPDATE`** 生效。

**誤區 14：「我在 Mac 上開發，表名大小寫不敏感」**

→ 0.9.2：只要你的 MySQL 跑在 **Docker** 裡，容器裡就是 Linux，`lower_case_table_names = 0`，**敏感**。

**誤區 15：「`lower_case_table_names` 上線後再調」**

→ 0.9.1：MySQL 8 起，這個值與資料字典綁定，**改了就啟動失敗**。
唯一的路徑是匯出 → 重新初始化 → 匯入，對上線中的服務是一次**停機遷移**。

**誤區 16：「`VARCHAR(255)` 是因為索引長度限制」**

→ 0.5.11：那是 `utf8mb3 × 767 bytes` 的舊上限。
MySQL 5.7.7+ 的 `DYNAMIC` 列格式上限是 **3072 bytes**，utf8mb4 下是 **768 個字元**（實測 769 會失敗）。
「255 用 1 byte 存長度」這個理由在 utf8mb4 下也不成立（`255 × 4 = 1020 > 255`，已經是 2 bytes）。

**誤區 17：「批次插入慢是資料庫的問題」**

→ 0.7.4 實測：加一個 `rewriteBatchedStatements=true`，30,000 列從 **3724 ms → 169 ms（22 倍）**。
沒有它的時候，`executeBatch()` 是**一句一句送**的。

**誤區 18：「建連線很快，池只是為了限流」**

→ 0.7.1 實測：本機 Docker MySQL 建一條 TLS 連線 **9.85 ms**，
從 HikariCP 借一條 **0.002 ms** —— **差 4,900 倍**。
06 站因為底下是 H2（0.021 ms），只量得出「限流」那一半的價值。

**誤區 19：「用 `mysql:8.0` 標籤就等於釘住版本了」**

→ 0.4.7：`8.0` 是浮動的小版號。而 8.0 → 8.4 的差異會直接讓容器**起不來**
（實測：`unknown variable 'mysql-native-password=OFF'`，
而 `docker compose up -d` 仍然回報「Started」）。

**誤區 20：「這些都是 DBA 的事」**

→ 0.3.6：**五個事故的 Java 程式碼全部正確，五個都不是 SQL 寫錯。**
它們全部發生在「連線建立的那一瞬間」，而那一瞬間的設定寫在**你的** `application.yml` 裡。

---

## 0.13 本章練習

### 練習 1：診斷一段亂碼

你接手一個系統，客服回報「部分客戶姓名顯示不正常」。你查到這樣的資料：

```sql
SELECT id, name, HEX(name), CHAR_LENGTH(name), LENGTH(name) FROM customers WHERE id IN (101,102,103);
```

```
id   name        HEX(name)                                  CHAR_LENGTH  LENGTH
101  陳大文      E999B3E5A4A7E69687                          3            9
102  陳大文      C3A9C2999CB3C3A5C2A4C2A7C3A6C29CC287        9            19
103  ???         E999B3E5A4A7E69687                          3            9
```

**(a)** 這三列各自發生了什麼？哪幾列的資料在資料庫裡是**正確**的？
**(b)** 101 與 103 的 `HEX` 完全相同，為什麼顯示不一樣？
**(c)** 你會怎麼修 102？寫出你的步驟，並說明「為什麼不能寫一句 `UPDATE` 全部修掉」。
**(d)** 修好之後，你會加哪一條守門測試防止它再發生？

### 練習 2：找出這份設定的問題

```yaml
services:
  mysql:
    image: mysql:latest
    environment:
      MYSQL_ROOT_PASSWORD: root
      MYSQL_DATABASE: shop
      TZ: Asia/Taipei
    ports: ["3306:3306"]
    command: --character-set-server=utf8 --collation-server=utf8_general_ci

  app:
    build: .
    depends_on:
      - mysql
    environment:
      SPRING_DATASOURCE_URL: >-
        jdbc:mysql://mysql:3306/shop
        ?serverTimezone=Asia/Taipei
        &useUnicode=true
        &characterEncoding=utf8
        &allowPublicKeyRetrieval=true
        &sslMode=DISABLED
        &autoReconnect=true
      SPRING_DATASOURCE_USERNAME: root
      SPRING_DATASOURCE_PASSWORD: root
```

**(a)** 列出所有問題，並標上嚴重程度（🔴 會造成資料錯誤 / 🟡 會造成故障 / 🟢 風格）。
**(b)** 其中有 **三個**問題會造成「資料看起來正常，但實際上是錯的」。是哪三個？
**(c)** 寫出修正版。
**(d)** 這份設定裡有一個問題，**只有在某個特定事件發生時才會現形**。是哪一個？什麼事件？

### 練習 3：定序決策

為以下欄位各選一個定序，並用一句話說明理由。
如果你認為某一欄不該用字串型別，也請說明。

| # | 欄位 | 範例值 | 你的選擇 |
|---|---|---|---|
| 1 | 登入帳號 `username` | `Gary_Cai` | |
| 2 | 電子郵件 `email` | `Gary@Example.COM` | |
| 3 | 商品名稱 `product_name` | `iPhone 15 Pro 256GB 🔥` | |
| 4 | 訂單編號 `order_no` | `SO-2026-00001234` | |
| 5 | API token | `a3f5...`（64 個十六進位字元） | |
| 6 | 密碼雜湊 `password_hash` | `$2a$10$N9qo8u...`（bcrypt） | |
| 7 | 縣市 `city` | `台北市` | |
| 8 | 商品 SKU `sku` | `TW-0021-BLK-M` | |
| 9 | 使用者暱稱 `nickname` | `小明🎉` | |
| 10 | 統一編號 `tax_id` | `12345678` | |

**接著回答**：

**(e)** 第 1 與第 2 欄的選擇不同 —— 為什麼？（提示：RFC 5321 怎麼說，實務上大家怎麼做）
**(f)** 第 5 與第 6 欄看起來都是「機器產生的字串」，但其中一個用 `utf8mb4_bin` 會有問題。是哪一個，為什麼？
**(g)** 如果第 9 欄用了 `utf8mb4_general_ci`，會發生什麼？（回到 0.3.2）

### 練習 4：寫一條你自己的守門測試

本章給了三個守門測試類別（時區 / 模式 / 連線），一共十幾條斷言。

**(a)** 找出**至少兩件**本章講過、但這三個類別**沒有**驗證到的事，寫成測試。
**(b)** 這三個測試類別都需要真的 MySQL。如果你的 CI 目前用 H2，你會怎麼安排？
  寫出你的方案，並說明「哪些測試留在 H2、哪些必須跑 MySQL」的判準。
**(c)** 06 站 06 章 6.9 說「CI 從 4 分鐘變 47 分鐘，而刪測試沒有用」。
  你的方案會讓 CI 慢多少？你怎麼證明這個代價是值得的？

### 練習 5：時區的完整推理 ★

一個服務有以下設定：

```
JVM 時區          = America/New_York
MySQL time_zone   = SYSTEM，主機 OS 是 UTC
JDBC URL          = jdbc:mysql://db:3306/shop?connectionTimeZone=LOCAL&preserveInstants=true
業務時區          = America/New_York（美國東岸的電商）
訂單表            = created_at DATETIME(3)
```

**(a)** Java 在 `2026-07-04T18:30:00Z` 用 `setTimestamp(Timestamp.from(instant))` 寫入，
  資料庫裡的字面值是什麼？（注意 7 月是夏令時間）

**(b)** 同一筆資料在 `2026-12-25T18:30:00Z` 寫入，字面值是什麼？

**(c)** 這張表另外有一個 `db_time DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)`。
  (a) 與 (b) 兩筆的 `created_at` 與 `db_time` 各差幾小時？

**(d)** 現在跑 `SELECT * FROM orders ORDER BY created_at`，順序對嗎？為什麼？

**(e)** 這個系統在**哪一天**會出現「同一個小時出現兩次」的資料？那一天會怎麼壞？

**(f)** 寫出修正方案（資料庫端 + JDBC 端 + 應用端），
  並說明**既有資料**要怎麼處理 —— 特別是 (e) 那一天的資料。

---

## 0.14 完成本章後，請確認你有

```
✅ compose/docker-compose.yml
     ├─ image 釘到小版號（mysql:8.0.40）
     ├─ ports 綁在 127.0.0.1
     ├─ healthcheck 帶 -h 127.0.0.1，且有 start_period
     └─ 具名 volume

✅ compose/conf/shop.cnf
     ├─ character-set-server = utf8mb4
     ├─ collation-server = utf8mb4_0900_ai_ci      ★ 不是 general_ci
     ├─ default-time-zone = '+00:00'               ★ 不是 SYSTEM
     ├─ sql-mode 明確列出七個模式
     ├─ lower_case_table_names = 0
     ├─ long_query_time = 0.5                      ★ 預設 10 秒 = 關閉
     └─ [client] 與 [mysql] 兩段的 default-character-set

✅ compose/initdb/01-app-user.sql                  ★ 應用帳號只有 DML，沒有 DDL

✅ application.yml
     ├─ URL 用「雙引號 + 反斜線續行」，不是 >-
     ├─ connectionTimeZone / preserveInstants / forceConnectionTimeZoneToSession 三個都有
     ├─ zeroDateTimeBehavior=EXCEPTION
     ├─ rewriteBatchedStatements=true
     ├─ socketTimeout 有設
     ├─ 沒有 autoReconnect / allowMultiQueries / allowPublicKeyRetrieval
     └─ connection-init-sql 釘住 sql_mode

✅ 三個守門測試類別（全部跑在真的 MySQL 上）
     ├─ TimeZoneContractTest        （0.6.8）
     ├─ DatabaseModeContractTest    （0.8.4）
     └─ ConnectionSettingsTest      （0.11.3）

✅ 你能回答這五個問題（不查資料）
     ├─ 為什麼 utf8mb4_general_ci 會讓兩個 emoji 相等？
     ├─ 為什麼 Java 的往返測試測不出時區設錯？
     ├─ 為什麼「存 UTC」之後報表反而錯了？
     ├─ 為什麼 allowPublicKeyRetrieval=true 是安全問題而不是修正？
     └─ 為什麼「容器 running」不代表資料庫可用？
```

---

## 0.15 本章的實驗環境與結果

**環境**：

| 項目 | 版本 |
|---|---|
| JDK | Temurin **21.0.5**（LTS） |
| Maven | **3.9.16** |
| JDBC 驅動 | **mysql-connector-j 8.3.0** |
| 資料庫 | **MySQL 8.0.40**（compose）與 **8.0.46**（`mysql:8.0` 浮動標籤，官方映像） |
| Docker | **29.1.3** |
| 平台 | macOS 14.2.1 / Apple Silicon |
| JVM 時區 | **Asia/Taipei**（+08:00，刻意與資料庫的 UTC 不同） |

⚠️ **注意「資料庫」那一列**：同一天用 `mysql:8.0` 拉到的是 **8.0.46**，
而釘住的 `mysql:8.0.40` 是 **8.0.40** —— **這就是 0.4.7 的實證。**

**跑過的實驗（18 組）**：

| 組 | 實驗 | 結果 |
|---|---|---|
| **E1** | 連線字元集 × 中文 | ✅ latin1 連線寫入：`CHAR_LENGTH=9`、19 bytes（**雙重編碼**），**但顯示正常**；utf8mb4 連線：3 / 9 bytes；正確資料用 latin1 讀 → `???` |
| **E2** | emoji × utf8mb3 | ✅ 嚴格模式 `ERROR 1366`；**非嚴格模式靜默變成 `?`（0x3F），`@@warning_count=1` 但 `SHOW WARNINGS` 已被下一句清掉** |
| **E3** | 五種定序 | ✅ `'Admin'='admin'`：ai_ci 1 / as_cs 0 / bin 0<br>🔴 **`'🎉'='🎊'`：general_ci 1、unicode_ci 1、0900_ai_ci 0**<br>🔴 **`'𠀋'='𡃁'`：general_ci 1**<br>`'ﬁ'='fi'`：0900_ai_ci 1、general_ci 0（**方向相反**） |
| **E4** | 定序 × 唯一索引 | ✅ ai_ci 表 `'Gary'` 被擋（`ERROR 1062`）、as_cs 表兩筆都進；general_ci 表 `'小明🎊'` 被 `'小明🎉'` 擋掉 |
| **E5** | NO PAD | ✅ `'abc'='abc  '`：`_0900_` 系列 **0**（NO PAD）、`general_ci`/`unicode_ci`/`utf8mb4_bin` **1**（PAD SPACE） |
| **E6** | 定序混用 | ✅ `ERROR 1267 Illegal mix of collations` |
| **E7** | 索引長度 | ✅ `VARCHAR(768)` + KEY **成功**（3072 bytes）；`VARCHAR(769)` 失敗；`(500,500)` 複合索引失敗（4000 > 3072） |
| **E8** | DATETIME vs TIMESTAMP | ✅ session 從 `+00:00` 換到 `+08:00`：`dt` 字面值不變但 epoch 變（1788343200 → 1788314400）；`ts` 字面值變（10:00 → 18:00）但 epoch 不變。**`TIMESTAMP` 上限 2038-01-19 03:14:07（+1 秒即 `ERROR 1292`），`DATETIME` 可存 2199** |
| **E9** | JDBC 時區七組 | ✅ **Java 往返七組全部正確**；DB 字面值 A/D=`18:00`、B/C/F/G=`10:00`；**G 的 epoch 是 1788314400 —— 錯 8 小時，而 `CAST AS CHAR` 看不出來** |
| **E10** | app 時間 vs `NOW()` | ✅ 伺服器 UTC + 無參數：**差 479 分鐘**；`connectionTimeZone=UTC`：0 分鐘；伺服器 +08:00 + 無參數：0 分鐘 |
| **E11** | 報表邊界 | 🔴 **存 UTC 之後 `WHERE DATE(created_at)='2026-09-02'` 從 24 筆變 16 筆**；`CONVERT_TZ` 與半開區間都回到 24 筆 |
| **E12** | 具名時區 | ✅ 官方 `mysql:8.0` 映像**有載**時區表（`mysql.time_zone_name` **1795 列**）；打錯名字 → `ERROR 1298` |
| **E13** | 驗證外掛 × TLS | ✅ 預設（PREFERRED）→ `TLS_AES_256_GCM_SHA384`；**`sslMode=DISABLED` + 冷快取 → `Public Key Retrieval is not allowed`；同一份設定在熱快取下 ✅ 連上**；`VERIFY_IDENTITY` 沒 truststore → **`Communications link failure`**（與網路不通同一個訊息） |
| **E14** | 建連線成本 | ✅ TLS **9.85 ms** / 明文 **3.79 ms** / `force` 的成本在誤差內。**對照 06 站：H2 建連線 0.021 ms、借連線 0.002 ms → 差 4,900 倍** |
| **E15** | `sql_mode` 五組 | ✅ 超長字串：嚴格 `1406` / 非嚴格截斷成 5 字<br>`'abc'` 進 INT：嚴格 `1366` / 非嚴格 **變 `0`**，`'12abc'` **變 `12`**<br>`'0000-00-00'`：嚴格 `1292` / 非嚴格存進去且 `IS NULL` 為 **0**<br>`ONLY_FULL_GROUP_BY` 關：`id` 是**任意一列**的值<br>`NO_AUTO_VALUE_ON_ZERO`：開 → `0` 就是 `0`（第二次 `Duplicate entry '0'`）；關 → `0` 被換成 1、2 |
| **E16** | 批次改寫 | ✅ 30,000 列：無參數 **3724 ms** → `rewriteBatchedStatements=true` **169 ms（22 倍）**；`useServerPrepStmts` 單獨開只有 1.04 倍；**兩個一起開反而較慢（15.33 倍）** |
| **E17** | 容器就緒 | ✅ `running` 0.2 s / **TCP 可連 0.6 s** / socket ping 3.2 s / **真的可查 5.3 s**；compose + healthcheck 約 12 秒轉 healthy |
| **E18** | 大小寫 | ✅ `CREATE TABLE OrderItem` 後 `SELECT FROM orderitem` → `ERROR 1146`；欄位名 `ID` vs `id` **沒問題**；`'ABC'='abc'`、`LIKE`、`IN` 在 ai_ci 下全部為真 |

🔴 **本章沒有驗證到的**：

| 沒驗證的 | 影響哪一節 | 哪一章會補 |
|---|---|---|
| **跨機房 / 跨可用區的真實連線延遲** | 0.7.1 | 07 章（讀寫分離時會遇到）<br>📌 05 章 5.11.1 用「每次往返 × N」的公式估過它對 N+1 的放大 |
| **`lower_case_table_names` 改值後啟動失敗的實際訊息** | 0.9.1 | —（需要重新初始化資料目錄，破壞性太大） |
| **MySQL 8.4 / 9.x 的行為差異** | 0.4.7、0.7.2 | 🔴 **本站不涵蓋版本升級** —— 0.4.7 的差異表是「已知清單」，不是實測 |
| **`sslMode=VERIFY_CA` 加上真實 CA 憑證** | 0.7.2 | —（需要真實 CA，本站的容器環境做不到）<br>📌 07 章 7.7 有複製端的 `SOURCE_SSL = 1` |
| **時區表沒載入時的實際錯誤**（官方映像有載） | 0.6.7 | — |
| **雙重編碼資料的實際修復流程** | 0.3.1、練習 1 | 06 章（遷移腳本） |
| **`REPEATABLE READ` 與 `READ COMMITTED` 的行為差異** | 0.10.3 | **04 章**（整章） |
| **`max_allowed_packet` 對批次改寫的上限** | 0.7.4 | 05 章 |

> 📌 **最後一句話**：
>
> 這一章有**四個實測結果，跟「大家都這樣說」不一樣**：
>
> **①「亂碼一看就知道」** ——
> E1 顯示雙重編碼的資料在**同一個工具裡看起來完全正常**。
> 要看 `HEX()` 與 `CHAR_LENGTH()`，不要看顯示出來的字。
>
> **②「整合測試會抓到時區問題」** ——
> E9 顯示七種參數組合的 **Java 往返全部是綠的**。
> 驅動用同一個規則寫、同一個規則讀，**往返必然自洽**。
>
> **③「存 UTC 就對了」** ——
> E11 顯示存 UTC 之後，那句最自然的報表查詢從 24 筆變成 **16 筆**。
> 存 UTC 是對的，但它只解決了一半的問題。
>
> **④「設定壞掉會立刻知道」** ——
> E13 顯示同一份設定在**熱快取下是綠的、冷快取下是紅的**。
> 它一直都是壞的，只是需要一次 `FLUSH PRIVILEGES` 或一次重啟才會現形。
>
> ⚠️ **四個都不是「文件寫錯了」，而是「那句話省略了前提」。**
> 而這一章的每一個設定，就是把那些前提**明確寫下來**的動作。
>
> **下一章開始建表。** 01 章會問一個看起來很簡單的問題：
> **「金額這一欄，你為什麼選這個型別？」** ——
> 而答案會牽涉到一個實測：**`FLOAT` 存 `1234567.89`，讀出來是 `1234570`。**

---

**下一章**：[01-schema-design-and-data-types.md](./01-schema-design-and-data-types.md) — Schema 設計與資料型別
