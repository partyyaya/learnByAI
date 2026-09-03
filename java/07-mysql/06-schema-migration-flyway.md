# 第 06 章：Schema 版本控管與線上變更

> 05 章結尾留了兩個問題：
>
> > **「`OPTIMIZE TABLE` 要鎖住整張表，那正式環境到底怎麼改 schema？」**
> > **「04 章 4.5.4 那個卡住全站的 `ALTER TABLE` —— `gh-ost` 到底做了什麼不一樣的事？」**
>
> 這一章要回答它們。而在回答之前，先看一句號稱「**零成本**」的 DDL。
>
> MySQL 8.0 的 `ALGORITHM=INSTANT` 只改中介資料、不碰資料檔。
> 在一張 100 萬列的表上單獨執行，實測是這樣：
>
> ```
> ALTER TABLE ord ADD COLUMN mdl_test INT NULL, ALGORITHM=INSTANT;
>   →  89 ms     （1,000,000 列，資料 135.7 MB）
> ```
>
> 現在把它放進一個**很平凡的正式環境**：某個地方有一個交易，
> 它只 `SELECT` 了**一列**，然後因為某個原因還沒 `commit`（報表、除錯中斷點、忘了關的連線）。
> 同一句 DDL，加上三個**在它之後**才進來的普通查詢：
>
> ```
> [t+  258 ms] A 長交易   SELECT 一列完成，交易【不提交】
> [t+ 1051 ms] B DDL      送出 ALTER ... ALGORITHM=INSTANT
> [t+ 2560 ms] C0 查詢    送出 SELECT COUNT(*) FROM ord WHERE id < 100
> [t+ 2764 ms] C1 查詢    送出（同一句）
> [t+ 2958 ms] C2 查詢    送出（同一句）
> [t+12269 ms] A 長交易   commit
> [t+12296 ms] C2 查詢    🔴 回來了，等了 9,335 ms
> [t+12296 ms] B DDL      完成，總共花了 11,241 ms
> [t+12296 ms] C1 查詢    🔴 回來了，等了 9,529 ms
> [t+12296 ms] C0 查詢    🔴 回來了，等了 9,733 ms
> ```
>
> 🔴 **那句「89 毫秒」的 DDL 花了 11.2 秒。
> 而三個跟 DDL 完全無關、只讀 100 列的查詢，各等了 9.3 ～ 9.7 秒。**
>
> 這三個查詢做錯了什麼？**什麼都沒有。**
> 它們只是**排在那句 DDL 後面**。（6.7.4 會用 `performance_schema.metadata_locks` 把整個隊伍印出來。）
>
> ---
>
> ⚠️ **這一章與前五章有一個關鍵差別**：
>
> ```
> 01 ~ 03 章的錯 → 是「寫錯了」          → 改對就好
> 04 章的錯      → 是「併發下才錯」      → 加鎖 / 改隔離級別就好
> 05 章的錯      → 是「量錯了東西」      → 改量計數就好
> 06 章的錯      → 【是「已經發生了」】  → 資料庫的狀態改不回去
> ```
>
> 前五章的問題，最壞的情況是「改程式、重新部署」。
> 這一章的問題不一樣 —— **它是一次性的、單向的、而且通常沒有 undo**：
>
> - 一個 `ALTER` 跑了 8 分鐘，中間你按了 Ctrl-C —— 現在表是什麼狀態？
> - 一個遷移腳本有三句 DDL，第二句失敗了 —— 第一句**留下來了**（6.5.1 實測）。
> - 一個欄位刪掉了，才發現舊版本的程式還在讀它。
> - 一個 `DECIMAL` 改成 `DOUBLE`，資料**已經**四捨五入過了。
>
> 📌 **所以這一章的主軸不是「怎麼用 Flyway」，而是**：
>
> > **怎麼讓資料庫的變更變成「可重現、可審查、可以只往前」的東西。**
>
> 而「只往前」這四個字是整章的核心 ——
> 因為 **`ALTER TABLE` 沒有 `git revert`**，
> 所以正確的做法不是「準備回滾腳本」，而是**把每一次變更都設計成不需要回滾**（6.8）。

---

## 6.1 學習目標

完成本章後，你應該可以：

- 說出「手動改正式機」的四個問題，以及為什麼「有 SQL 檔案存在 Git 裡」**還不算版本控管**。
- 用實測說明 `spring.jpa.hibernate.ddl-auto=update` **做了哪五件事、不做哪三件事**，
  以及它為什麼會**靜默地把 `nickname` 的資料留在原地**（改名 → 只加新欄位）。
- 用實測說明 `ddl-auto=validate` 為什麼**不能當 schema 漂移的守門**（9 種漂移只抓到 2 種）。
- 逐欄解釋 `flyway_schema_history` 的 **10 個欄位**，並看懂 `type=BASELINE` / `version=NULL` 的列。
- 說出 Flyway 的**版本比較規則**（實測：`V1.10` 排在 `V1.9` **後面**，但檔名字串排序是相反的），
  以及兩種**撞版本**的錯誤（`V2` vs `V2.0`、`V1_20` vs `V1.20`）。
- 說出 checksum **對什麼敏感、對什麼不敏感**（實測 8 種變動：行尾空白**會變**、CRLF 與 BOM **不會變**）。
- 🔴 說明 **placeholder 值不進 checksum** 的後果：**同一個 checksum，兩個環境不同的 schema**。
- 解釋 **MySQL 沒有 DDL 交易**造成的三種失敗形態，特別是最糟的那一種：
  **`UPDATE` → `ALTER`（隱式提交）→ 失敗**，實測餘額**留在改過的值上**。
- 說出 `flyway repair` **真正做了什麼**（實測：只對齊 checksum，**表結構還是錯的**）。
- 說出 8 個服務實例**同時啟動**時 Flyway 怎麼互斥（實測 `SELECT GET_LOCK('Flyway-...', 10)`），
  以及它的重試迴圈為什麼**沒有上限**、這在 Kubernetes 上意味著什麼。
- 說出 MySQL 8.0 **沒有** `ADD COLUMN IF NOT EXISTS`（實測 `ERROR 1064`），並寫出可用的替代寫法。
- 讀懂 **19 種 `ALTER` 操作 × 3 種 `ALGORITHM`** 的實測矩陣，並解釋 `ERROR 1845` 與 `1846` 的差別。
- 說出 `ALGORITHM=INSTANT` 的**三個限制**，包含它的**行版本上限**
  （實測：第 **65** 次 `INSTANT` 加欄位 → `ERROR 4092`，`TOTAL_ROW_VERSIONS = 64`）。
- 回答 04 章的問題：用 `performance_schema.metadata_locks` 說明**為什麼 89 ms 的 DDL 會卡住全站 11 秒**。
- 用 `lock_wait_timeout` 讓 DDL **自己快速失敗**（實測 `ERROR 1205` in 2,148 ms），而不是去堵住整個隊伍。
- 用實測比較三種線上大表變更（1M 列，加一欄 + 加一索引，**同時有寫入在跑**）：
  **原生 `INPLACE` 停頓 33 ms、原生 `COPY` 停頓 5,526 ms、`pt-osc` 停頓 52 ms**。
- 說出 `pt-online-schema-change` 的**完整機制**（3 個觸發器 + 影子表 + 分塊複製 + `RENAME`）與**五個代價**，
  以及 `gh-ost` 用 binlog 取代觸發器差在哪。
- 把大表回填做對（實測：一次全刷讓線上寫入停頓 **11,274 ms**，分批 1000 只停頓 **279 ms —— 40 倍**）。
- 用 **expand-contract** 把「改一個欄位名」拆成**六次部署**，並畫出新舊程式碼的相容矩陣。
- 說出 `DROP PARTITION` 為什麼是「刪一個月資料」的正解（實測 **132 ms** vs `DELETE` 712 ms，
  **而且檔案真的縮小 52 MB**），以及分區的**兩個硬限制**（`ERROR 1503` / `ERROR 1506`）。
- 建立一組遷移的 CI 守門：**黃金 schema diff** + 兩種必跑的遷移測試 + 腳本 lint 清單。
- 說出在 Kubernetes 上「應用內遷移 / initContainer / 獨立 Job」三種做法的取捨。

---

## 6.2 三種流派：手動 SQL、ddl-auto、遷移工具

### 6.2.1 「手動改正式機」到底錯在哪

很多團隊的資料庫變更流程是這樣的：

```
1. 開發在自己的 MySQL 上下 ALTER TABLE
2. 測試環境：登進去，貼上同一句
3. 上線當天：SSH 到正式機，貼上同一句
4. （腳本存在某個人的 Slack 訊息裡 / Confluence 頁面 / 桌面的 fix.sql）
```

這個流程有**四個**問題，而它們的嚴重程度是遞增的：

**問題 1：不可重現。**
新同事要建一個本機環境，得問「現在的 schema 是什麼」——
而答案在正式機裡，不在版控裡。

**問題 2：不知道差在哪。**
測試環境跟正式環境的 schema 何時分岔的？沒有人知道，
因為**沒有任何地方記錄「誰在什麼時候下了哪一句」**。

**問題 3：無法審查。**
一句 `ALTER TABLE ord MODIFY total_amount DOUBLE` 在 Slack 裡貼出來，
不會有人像審 code review 一樣問「你確定要把金額改成浮點數？」（01 章 1.4）。

**問題 4（最嚴重）：手動執行沒有「部分成功」的概念。**
你貼了三句，第二句失敗了，你按 Ctrl-C ——
第一句**已經生效**，而你的終端機捲軸已經滾過去了。

⚠️ **注意一件事**：把 SQL 檔案放進 Git，**只解決了問題 3**。

```
版控裡有 migration/2026-08-add-status.sql   ← 解決了「審查」
但沒有人知道正式機到底跑過哪幾個檔案       ← 問題 1、2、4 都還在
```

📌 **「schema 版本控管」的定義**，是這三件事同時成立：

```
① 變更以【檔案】的形式存在版控裡（可審查、可 diff）
② 【資料庫自己記得】它跑過哪些檔案（可重現、可比對）
③ 執行是【自動的、幂等的】—— 跑第二次不會出事
```

②是關鍵，而它就是 `flyway_schema_history` 這張表的全部意義（6.3.2）。

---

### 6.2.2 `ddl-auto=update` 實測：它做了什麼、不做什麼 ★★

Spring Boot 有一個看起來能解決全部問題的設定：

```properties
spring.jpa.hibernate.ddl-auto=update
```

「Entity 改了，資料庫自己跟上」—— 聽起來完美。
**我們來量它。**

**準備一個「已經上線」的表**（有一列資料）：

```sql
CREATE TABLE customer (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(60)  NOT NULL,
  email       VARCHAR(120) NULL,      -- 資料庫允許 NULL
  balance     DOUBLE       NULL,      -- 資料庫是 DOUBLE
  phone       VARCHAR(20)  NULL,
  legacy_note VARCHAR(50)  NULL       -- 舊系統的欄位
) ENGINE=InnoDB;

INSERT INTO customer (name, email, balance, phone, legacy_note)
VALUES ('Alice', 'a@b.c', 100.5, '0900000001', '舊系統的備註');
```

**再寫一個「跟它有七處不一樣」的 Entity**：

```java
package lab.ddlauto;

import jakarta.persistence.*;
import java.math.BigDecimal;

@Entity
@Table(name = "customer",
       indexes = @Index(name = "idx_nickname", columnList = "nickname"),
       uniqueConstraints = @UniqueConstraint(name = "uk_phone", columnNames = "phone"))
public class Customer {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    // ① 資料庫是 VARCHAR(60)，Entity 想要 120 —— 會加寬嗎？
    @Column(name = "name", length = 120, nullable = false)
    private String name;

    // ② 資料庫允許 NULL，Entity 宣告 nullable = false —— 會改嗎？
    @Column(name = "email", length = 120, nullable = false)
    private String email;

    // ③ 資料庫沒有這個欄位 —— 會加嗎？
    @Column(name = "nickname", length = 40)
    private String nickname;

    // ④ 資料庫沒有，且 NOT NULL，而表裡【已經有資料】—— 會怎樣？
    @Column(name = "level", nullable = false)
    private Integer level;

    // ⑤ 資料庫是 DOUBLE，Entity 是 BigDecimal(19,4) —— 會改型別嗎？
    @Column(name = "balance", precision = 19, scale = 4)
    private BigDecimal balance;

    // ⑥ 唯一約束 uk_phone —— 會建嗎？
    @Column(name = "phone", length = 20)
    private String phone;

    // ⑦ 資料庫有 legacy_note，Entity 【沒有】—— 會刪嗎？
}
```

**跑一次 `hbm2ddl.auto=update`，Hibernate 6.6.4 實際下的 SQL**：

```sql
alter table customer modify column balance decimal(19,4)
alter table customer add column level integer not null
alter table customer modify column name varchar(120) not null
alter table customer add column nickname varchar(40)
create index idx_nickname on customer (nickname)
alter table customer drop index uk_phone
alter table customer add constraint uk_phone unique (phone)
```

**結果的 schema 與資料**：

```
`id`          bigint NOT NULL AUTO_INCREMENT
`name`        varchar(120) NOT NULL          ← ① ✅ 加寬了
`email`       varchar(120) DEFAULT NULL      ← ② 🔴 【沒改成 NOT NULL】
`balance`     decimal(19,4) DEFAULT NULL     ← ⑤ ✅ 改了型別
`phone`       varchar(20) DEFAULT NULL
`legacy_note` varchar(50) DEFAULT NULL       ← ⑦ 🔴 【沒刪】
`level`       int NOT NULL                   ← ④ ✅ 加了
`nickname`    varchar(40) DEFAULT NULL       ← ③ ✅ 加了
UNIQUE KEY `uk_phone` (`phone`)              ← ⑥ ✅ 建了
KEY `idx_nickname` (`nickname`)              ← ③ ✅ 建了

id  name   email  balance   phone       legacy_note   level  nickname
1   Alice  a@b.c  100.5000  0900000001  舊系統的備註   0      NULL
                                                       ↑
                                            ④ 🔴 靜默填了 0
```

📌 **整理成表**：

| # | 差異 | `ddl-auto=update` 的行為 |
|---|---|---|
| ① | `VARCHAR(60)` → `VARCHAR(120)` | ✅ 會加寬 |
| ② | `NULL` → `NOT NULL` | 🔴 **不會改** |
| ③ | 缺欄位 | ✅ 會加 |
| ④ | 缺 `NOT NULL` 欄位、表已有資料 | ⚠️ 會加，並**靜默填 0** |
| ⑤ | `DOUBLE` → `DECIMAL(19,4)` | ⚠️ **會改**，而且**不問你** |
| ⑥ | 缺索引 / 唯一約束 | ✅ 會建 |
| ⑦ | 資料庫多了 Entity 沒有的欄位 | 🔴 **不會刪** |

⚠️ **⑤ 是最危險的那一個**。
`DOUBLE` → `DECIMAL(19,4)` 這次剛好沒事（`100.5` → `100.5000`），
但**反過來**（`DECIMAL(19,4)` → `DOUBLE`）也會被 `update` 執行 ——
而那是不可逆的精度損失（01 章 1.4）。
**它不會問你、不會警告、也不會留下紀錄。**

---

**還有一個更安靜的問題：改名。**

把 Entity 的 `nickname` 改名成 `display_name`（欄位裡有資料 `'小艾'`）：

```java
package lab.ddlauto;

import jakarta.persistence.*;

// 「把 nickname 改名成 display_name」—— ddl-auto 會怎麼做？
@Entity
@Table(name = "customer")
public class Cust2 {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    @Column(name = "name", length = 120, nullable = false)
    private String name;
    @Column(name = "display_name", length = 40)   // 原本叫 nickname
    private String displayName;
}
```

`ddl-auto=update` 下的 SQL：

```sql
alter table customer add column display_name varchar(40)
```

**就這一句。** 結果：

```
id  nickname  display_name
1   小艾       NULL
    ↑         ↑
    資料還在  程式讀到的是這一個
```

🔴 **對使用者來說，這就是「資料不見了」。**
資料還在資料庫裡，但程式永遠不會再讀到它，
而且**沒有任何 SQL、日誌或例外**告訴你發生過這件事。

---

📌 **所以 `ddl-auto=update` 真正的問題不是「它做得不夠」，而是三件事**：

```
① 它做的事你【事前不知道】—— 要跑起來才看得到 SQL
② 它不做的事你【事後也不知道】—— 沒有警告、沒有紀錄
③ 它【沒有版本概念】—— 資料庫裡沒有任何地方記著「這次改了什麼」
```

⚠️ 而 ③ 還有一個併發問題：
如果你有 8 個服務實例同時啟動，`ddl-auto=update` 會有 **8 個 Hibernate 同時下 `ALTER`**
（它沒有 Flyway 那種鎖，6.5.6）。

🔴 **結論：`ddl-auto` 只能用在兩個地方**：

```
✅ 本機開發：ddl-auto=update 或 create-drop（資料丟掉沒差）
✅ 單元測試：ddl-auto=create-drop（每次乾淨的 H2 / Testcontainers）
🔴 測試環境 / 正式環境：ddl-auto=none  ← 沒有例外
```

---

### 6.2.3 `ddl-auto=validate` 抓得到什麼（9 種漂移只抓到 2 種）★

既然 `update` 不能用，那 `validate` 呢？
`ddl-auto=validate` 只比對、不修改，聽起來是個完美的「schema 漂移守門」。

**實測**：先讓資料庫與 Entity 完全一致（對照組通過），
然後每次只製造**一種**漂移，看 `validate` 有沒有抓到。
（每一次都從乾淨的 schema 重來，避免上一個錯誤蓋住下一個。）

| 製造的漂移 | `validate` 的反應 |
|---|---|
| （完全一致，對照組） | ✅ 通過 |
| 少了一個欄位 `nickname` | ✅ `Schema-validation: missing column [nickname] in table [customer]` |
| `VARCHAR(120)` 被改成 `VARCHAR(20)` | 🔴 **通過，沒抓到** |
| `NOT NULL` 被改成 `NULL` | 🔴 **通過，沒抓到** |
| `DECIMAL(19,4)` 被改成 `DOUBLE` | ✅ `wrong column type encountered in column [balance]` |
| 少了一個索引 `idx_nickname` | 🔴 **通過，沒抓到** |
| 少了唯一約束 `uk_phone` | 🔴 **通過，沒抓到** |
| 資料庫多了 Entity 沒有的欄位 | 🔴 **通過，沒抓到** |
| `VARCHAR(120)` 被改成 `TEXT` | 🔴 **通過，沒抓到** |

🔴 **9 種漂移，只抓到 2 種。**

`validate` 比的是「**欄位存不存在**」加上「**JDBC 型別家族對不對**」
（`DECIMAL` 是 `Types#NUMERIC`、`DOUBLE` 是 `Types#DOUBLE`，家族不同所以抓到了）。
它**完全不看**長度、可空性、索引、唯一約束、以及資料庫多出來的東西。

⚠️ **`VARCHAR(120)` → `VARCHAR(20)` 通過**這一項尤其致命 ——
這正是「正式環境有人手動改過欄位長度」最典型的樣子，
而你的 CI 會綠燈通過，然後在正式環境炸 `Data too long for column`。

📌 **`validate` 該怎麼用**：

```
✅ 當「Entity 與資料庫【嚴重】不同步」的煙霧偵測器（少了整個欄位）
✅ 成本極低（啟動時多幾百毫秒），值得永遠開著
🔴 不能當【schema 漂移守門】——  它漏掉的比抓到的多
```

真正能當守門的做法在 **6.9.3（黃金 schema diff）** ——
把遷移跑完的 schema `mysqldump` 出來，跟版控裡的檔案逐字比。
那個做法抓得到上面**全部 9 種**，因為它比的是 DDL 本文。

---

### 6.2.4 為什麼需要遷移工具

把三種流派放在一起：

| | 手動 SQL | `ddl-auto=update` | 遷移工具（Flyway / Liquibase） |
|---|---|---|---|
| 變更在版控裡 | ⚠️ 看團隊 | 🔴 只有 Entity，沒有 SQL | ✅ |
| 可以 code review 那句 SQL | ⚠️ | 🔴 **看不到 SQL** | ✅ |
| 資料庫記得跑過什麼 | 🔴 | 🔴 | ✅ `flyway_schema_history` |
| 從零重建到最新 | 🔴 | ⚠️ 只能建出「現在」的樣子 | ✅ 一句 `migrate` |
| 資料遷移（DML） | ⚠️ 手動 | 🔴 **完全做不到** | ✅ |
| 多實例同時啟動 | N/A | 🔴 **8 個一起 ALTER** | ✅ 有鎖（6.5.6） |
| 指定 `ALGORITHM` / `LOCK` | ✅ | 🔴 **不能** | ✅ 你寫什麼就跑什麼 |
| 精度 / 型別變更 | ✅ 你自己控制 | 🔴 **靜默執行** | ✅ |

⚠️ **注意「指定 `ALGORITHM` / `LOCK`」這一列** ——
它在本章後半（6.7）會變成最重要的一列。
`ddl-auto` 產生的 `alter table customer add column level integer not null`
**沒有** `ALGORITHM=INSTANT`，所以在一張大表上它會走**預設**演算法 ——
而預設是「MySQL 自己選最快的」，在 6.7.2 的實測裡那可能是 **4 秒的表重建**，也可能是 89 ms。
**你不能控制，也不會知道。**

📌 **本章接下來用 Flyway。** 選它的理由很簡單：
遷移腳本就是**純 SQL 檔案**，你寫什麼它就跑什麼 ——
包含 `ALGORITHM=INPLACE, LOCK=NONE` 這種只有你才知道要加的東西。
（Liquibase 的取捨在 6.11。）

---

## 6.3 Flyway 的核心模型

### 6.3.1 一次 `migrate` 到底做了什麼

先把整個流程攤開。以下是一個空資料庫、三個遷移腳本，跑一次 `migrate` 的**真實日誌**
（Flyway 10.20.1 + MySQL 8.0.46）：

```
資訊: Database: jdbc:mysql://127.0.0.1:3340/shop (MySQL 8.0)
資訊: Schema history table `shop`.`flyway_schema_history` does not exist yet
資訊: Successfully validated 3 migrations (execution time 00:00.019s)
資訊: Creating Schema History table `shop`.`flyway_schema_history` ...
資訊: Current version of schema `shop`: << Empty Schema >>
資訊: Migrating schema `shop` to version "1 - create customer"
資訊: Migrating schema `shop` to version "2 - create ord"
資訊: Migrating schema `shop` to version "2.1 - seed customer"
資訊: Successfully applied 3 migrations to schema `shop`, now at version v2.1 (execution time 00:00.024s)
```

```
[migrate] initialSchemaVersion=null targetSchemaVersion=2.1 migrationsExecuted=3
   applied V1   create customer  type=SQL  11ms
   applied V2   create ord       type=SQL  11ms
   applied V2.1 seed customer    type=SQL   2ms
```

📌 **七個步驟，順序很重要**：

```
① 連上資料庫，判斷方言（MySQL / PostgreSQL / ...）
② 【取得互斥鎖】  ← MySQL 上是 SELECT GET_LOCK('Flyway-...', 10)（6.5.6）
③ 讀 flyway_schema_history（不存在就記著待建立）
④ 掃描 locations，解析出所有遷移腳本、算出各自的 checksum
⑤ 【validate】：比對「資料庫記得的」與「檔案裡有的」
      ├─ checksum 不一致          → 失敗（6.5.4）
      ├─ 有 success = 0 的舊紀錄  → 失敗（6.5.1）
      └─ 有版本比 current 小的新腳本 → 失敗（6.5.5）
⑥ 依【版本順序】逐一執行 pending 的腳本，每執行完一個就寫一列 history
⑦ 放掉鎖
```

⚠️ **⑤ 在 ⑥ 之前** —— 這是 Flyway 最重要的設計。
它寧可**完全不跑**、讓服務起不來，也不要在一個「跟預期不一樣」的資料庫上動手。

⚠️ **⑥ 是「逐一」，不是「一個交易」** ——
每個腳本各自執行、各自寫 history。
所以「跑到第 3 個失敗」的結果是「前 2 個已經生效」（6.5.1）。

---

### 6.3.2 `flyway_schema_history`：10 個欄位逐一解剖

這張表就是「資料庫記得自己跑過什麼」的全部。**它由 Flyway 自己建**：

```sql
CREATE TABLE `flyway_schema_history` (
  `installed_rank` int          NOT NULL,
  `version`        varchar(50)  DEFAULT NULL,
  `description`    varchar(200) NOT NULL,
  `type`           varchar(20)  NOT NULL,
  `script`         varchar(1000) NOT NULL,
  `checksum`       int          DEFAULT NULL,
  `installed_by`   varchar(100) NOT NULL,
  `installed_on`   timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `execution_time` int          NOT NULL,
  `success`        tinyint(1)   NOT NULL,
  PRIMARY KEY (`installed_rank`),
  KEY `flyway_schema_history_s_idx` (`success`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
```

**跑完上面三個腳本之後的內容**：

```
installed_rank: 1              installed_rank: 2            installed_rank: 3
       version: 1                     version: 2                   version: 2.1
   description: create customer   description: create ord      description: seed customer
          type: SQL                      type: SQL                    type: SQL
        script: V1__create_customer.sql  script: V2__create_ord.sql   script: V2.1__seed_customer.sql
      checksum: -244506040           checksum: -1656204420        checksum: -852388752
  installed_by: root              installed_by: root           installed_by: root
  installed_on: 2026-09-03 04:16:45  ...                          ...
execution_time: 11              execution_time: 11           execution_time: 2
       success: 1                     success: 1                   success: 1
```

| 欄位 | 意義 | 你要在什麼時候看它 |
|---|---|---|
| `installed_rank` | **執行順序**（主鍵，遞增） | 排查 `outOfOrder` 造成的順序錯亂（6.5.5） |
| `version` | 版本號（`R__` 是 `NULL`） | 判斷 current version |
| `description` | 檔名裡 `__` 之後的部分，`_` 換成空白 | 讀 log 用 |
| `type` | `SQL` / `JDBC` / `BASELINE` / `DELETE` | 認出 baseline 那一列（6.4） |
| `script` | 檔名（**含副檔名**） | 抓「檔案被改名」的問題 |
| `checksum` | 腳本內容的 CRC32（`BASELINE` 是 `NULL`） | 🔴 checksum mismatch（6.5.4） |
| `installed_by` | 執行的資料庫帳號 | 追「誰跑的」（配 6.10.2 的專用帳號） |
| `installed_on` | 執行時間 | 對照部署紀錄 |
| `execution_time` | 毫秒 | 🔴 **上線前預估正式環境要多久的唯一依據** |
| `success` | `1` 成功、`0` 失敗 | 🔴 有 `0` 就代表**服務起不來**（6.5.1） |

📌 **兩個實務用法**：

**① 用 `execution_time` 預估正式環境的停機時間。**
測試環境的資料量通常比正式環境小一到兩個數量級，
但這一欄至少讓你知道「這個腳本在 10 萬列上花了 4 秒」——
乘上資料量比例，就是正式環境的量級估計。

```sql
-- 上線前的例行檢查：哪些遷移是慢的
SELECT version, description, execution_time
FROM flyway_schema_history
WHERE execution_time > 1000
ORDER BY execution_time DESC;
```

**② 用 `success = 0` 當監控告警。**

```sql
-- 這一句回傳任何一列，都代表【有一個遷移失敗了，而且資料庫是半套用狀態】
SELECT * FROM flyway_schema_history WHERE success = 0;
```

⚠️ 這張表有一個 `KEY (success)` 索引，就是給這句查詢用的。

🔴 **絕對不要手改這張表** —— 除了兩個例外：
`flyway repair`（6.5.4）以及「刪掉那一列 `success = 0` 的紀錄」（6.5.1 會說什麼時候可以）。

---

### 6.3.3 三種遷移：`V` / `R` / `U`

```
V2__add_status.sql        版本化遷移（Versioned）—— 跑一次，永遠不再跑
R__v_paid_orders.sql      可重複遷移（Repeatable）—— checksum 變了就重跑
U2__undo_add_status.sql   撤銷遷移（Undo）—— 🔴 只有商業版有
```

**`V`（版本化）是主力**，本章 95% 的內容都在講它。

**`R`（可重複）的用途很窄，但很實用**：
它適合「內容就是最終狀態」的物件 —— **視圖、預存程序、函式、觸發器**。
因為這些東西可以 `CREATE OR REPLACE`，所以「每次內容變了就重跑一次」是對的語意。

**實測 `R__` 的行為**：

```sql
-- R__v_paid_orders.sql（第一版）
CREATE OR REPLACE VIEW v_paid_orders AS
  SELECT id, amount FROM ord WHERE status = 'PAID';
```

```
第 1 次 migrate ：applied V1 t   /  applied R v paid orders   → migrationsExecuted=2
第 2 次 migrate （檔案沒改）：                                 → migrationsExecuted=0  ✅
```

把內容改掉：

```sql
-- R__v_paid_orders.sql（第二版）
CREATE OR REPLACE VIEW v_paid_orders AS
  SELECT id, amount, status FROM ord WHERE status IN ('PAID', 'DELIVERED');
```

```
第 3 次 migrate ：applied R v paid orders                      → migrationsExecuted=1  ✅
```

**history 表變成**：

```
installed_rank  version  description       type  checksum
1               1        t                 SQL   -1330265172
2               NULL     v paid orders     SQL   -1049316595   ← 第一次
3               NULL     v paid orders     SQL    874078179    ← 第二次（同一個檔案）
```

📌 **三件事要記住**：

```
① R__ 的 version 是 NULL —— 它不參與版本排序
② R__ 每執行一次就【多一列】history —— 同一個 script 會出現多次
③ R__ 永遠在所有 V__ 【之後】才跑，且 R__ 之間依【描述字串】排序
```

⚠️ **③ 的後果**：兩個互相依賴的視圖不能靠 `R__` 保證順序，
除非你用檔名控制字串排序（`R__010_v_base.sql`、`R__020_v_derived.sql`）。

🔴 **`R__` 的腳本必須是幂等的** ——
`CREATE VIEW` 會在第二次執行時報 `ERROR 1050 (Table 'v_x' already exists)`。
一定要寫 `CREATE OR REPLACE VIEW`，或者 `DROP ... IF EXISTS` + `CREATE`。

**`U`（撤銷）**：社群版沒有。
但更重要的是 —— **6.8 會論證「就算有，你也不該用它」**。

---

### 6.3.4 命名與版本比較：實測排序 ★

檔名的格式是固定的：

```
V  2.1  __  seed_customer  .sql
↑   ↑   ↑        ↑          ↑
前綴 版本 分隔符  描述       副檔名
        （兩個底線！）
```

**版本號的比較不是字串比較。** 實測：把 11 個檔案丟進同一個目錄 ——

```
檔案清單（作業系統的字串排序）      Flyway 實際的執行順序
─────────────────────────────      ────────────────────────
V1.10__step.sql                    1
V1.11__step.sql                    1.1
V1.1__step.sql                     1.2
V1.2__step.sql                     1.9
V1.9__step.sql                     1.10
V10__step.sql                      1.11
V1_20__underscore_style.sql        1.20    ← 底線被當成小數點！
V1__step.sql                       2
V2.0.1__step.sql                   2.0.1
V20260903.1200__step.sql           10
V2__step.sql                       20260903.1200
```

📌 **三個結論**：

```
① 版本是【一段一段的數字比較】：1.9 < 1.10 < 1.11 < 1.20 < 2
   （字串排序會給你 1.1 < 1.10 < 1.11 < 1.2 < 1.9 —— 完全相反）
② 段數可以不一樣：2 < 2.0.1 < 10
③ 🔴 檔名裡的【底線也是分隔符】：V1_20__x.sql 的版本是 1.20，不是 「1_20」
```

⚠️ **③ 是一個實際踩過的坑**。有人習慣用日期當版本：

```
V2026_09_03__add_status.sql   → 版本是 2026.9.3
V20260903__add_status.sql     → 版本是 20260903
```

兩種都能用，但**不要混用** —— `2026.9.3` 與 `20260903` 是兩個完全不同的數字，
混用之後版本順序會變得無法預測。

---

**兩種撞版本，Flyway 都會直接拒絕啟動**：

```
# 情境：Alice 開了 V2，Bob 同時開了 V2.0（他以為那不一樣）
V2__alice_add_column.sql
V2.0__bob_add_index.sql
```

```
Exception in thread "main" org.flywaydb.core.api.FlywayException:
Found more than one migration with version 2
Offenders:
-> .../V2__alice_add_column.sql (SQL)
-> .../V2.0__bob_add_index.sql (SQL)
```

```
# 情境：底線與點混用
V1_20__alice.sql
V1.20__bob.sql
```

```
org.flywaydb.core.api.FlywayException: Found more than one migration with version 1.20
Offenders:
-> .../V1_20__alice.sql (SQL)
-> .../V1.20__bob.sql (SQL)
```

✅ **這是好事** —— 它在**啟動時**就爆，而不是「兩個腳本都跑了、順序隨機」。

📌 **團隊的版本命名策略，三種選一種、寫進 CONTRIBUTING**：

| 策略 | 範例 | 撞版本的機率 | 缺點 |
|---|---|---|---|
| **流水號** | `V1__`、`V2__`、`V3__` | 🔴 高（兩個 PR 同時開 `V15`） | 需要有人協調 |
| **時間戳** | `V20260903121500__` | ✅ 幾乎為零 | 版本號很長、看不出先後距離 |
| **版本 + 流水號** | `V1_3_0__`、`V1_3_1__` | ⚠️ 中 | 要跟著發布版本走 |

⚠️ **實務上：團隊超過 3 個人就用時間戳。**
「撞版本」的成本是「發現時要有人改檔名、重跑 CI」，
而它發生的頻率跟「同時開發的分支數」成正比。

**時間戳可以在 CI 裡自動檢查**：

```bash
#!/bin/bash
# ci/check-migration-naming.sh
# 遷移檔名必須是 V<14 位數字>__<描述>.sql
BAD=$(ls src/main/resources/db/migration/V*.sql \
      | grep -vE '/V[0-9]{14}__[a-z0-9_]+\.sql$')
if [ -n "$BAD" ]; then
  echo "🔴 檔名不符合規範（V + 14 位時間戳 + __ + 小寫描述）："
  echo "$BAD"
  exit 1
fi
```

---

### 6.3.5 checksum 對什麼敏感：8 種變動實測 ★★

checksum 是 Flyway 的**防手改機制**：
腳本上線之後被改了一個字，Flyway 就拒絕啟動（6.5.4）。

但它到底對什麼敏感？**實測 8 種變動**（下表第一列是基準，不算變動；基準腳本三行，LF 換行）：

```sql
CREATE TABLE t1 (
  id INT PRIMARY KEY
);
```

| 變動 | checksum | 變了嗎 |
|---|---|---|
| （原始，LF、無註解） | `-251176300` | — |
| **行尾加三個空白** | `1305258808` | 🔴 **變了** |
| 檔尾加兩個空行 | `-251176300` | ✅ 不變 |
| 換行改成 CRLF | `-251176300` | ✅ 不變 |
| 加 UTF-8 BOM | `-251176300` | ✅ 不變 |
| 加一行 `-- 註解` | `1079386854` | ⚠️ 變了（合理） |
| 縮排 2 空白改 4 空白 | `1200126804` | ⚠️ 變了（合理） |
| 移除檔尾換行 | `-251176300` | ✅ 不變 |
| 內容相同、檔名改成 `V1__tt.sql` | `-251176300` | ✅ 不變 |

📌 **兩個實務結論**：

**① CRLF / BOM / 檔尾空行不影響 —— 這解決了跨平台的老問題。**
Windows 的同事 checkout 出 CRLF、Mac 的同事是 LF，
Flyway 逐行算 CRC32 並忽略行尾的換行序列，所以兩邊 checksum 一致。
（很多人以為要在 `.gitattributes` 裡把 `*.sql` 設成 `text eol=lf` 才行 —— 對 Flyway 來說不必，但對 6.9.3 的黃金 schema diff 還是建議設。）

**② 🔴 行內的行尾空白【會】影響 —— 這是一個真實的地雷。**

```
你的編輯器設定：「儲存時移除行尾空白」（VS Code 的 files.trimTrailingWhitespace）
                            ↓
某天你打開一個【三個月前上線的】V12__xxx.sql 只想看一眼
                            ↓
編輯器自動存檔 / 你按了 Cmd-S
                            ↓
一個看不見的空白被移除了 → checksum 變了
                            ↓
git diff 看起來「什麼都沒改」（空白很難看出來）
                            ↓
CI 綠燈（因為 CI 用的是空資料庫，從頭跑，沒有 history 可以比對）
                            ↓
🔴 部署到測試環境 → 服務起不來
```

⚠️ **這個坑的可怕之處是「`git diff` 看起來沒事」。**
防法有三個，建議**全部都做**：

```bash
# ① .gitattributes —— 讓 git 自己抓行尾空白
src/main/resources/db/migration/*.sql  whitespace=trailing-space,space-before-tab
```

```yaml
# ② pre-commit hook：已上線的遷移不准改
#    （「已上線」的定義：不在這次 PR 新增的檔案清單裡）
- id: no-modify-applied-migrations
  entry: ci/check-migration-immutable.sh
```

```bash
#!/bin/bash
# ci/check-migration-immutable.sh
# 對照 master：db/migration 底下【被修改】（不是新增）的檔案一律拒絕
CHANGED=$(git diff --name-only --diff-filter=M origin/master...HEAD \
          -- src/main/resources/db/migration/)
if [ -n "$CHANGED" ]; then
  echo "🔴 已存在的遷移腳本不可修改（就算只是空白）："
  echo "$CHANGED"
  echo "   要改 schema，請【新增】一個遷移。"
  exit 1
fi
```

```json
// ③ .vscode/settings.json —— 對這個目錄關掉自動 trim
{
  "[sql]": { "files.trimTrailingWhitespace": false }
}
```

📌 **③ 只是保險。真正的守門是 ②** ——
因為「已上線的遷移腳本不可修改」這條規則，
比「小心不要動到空白」可靠得多，而且它連「有人真的想改一句 SQL」也一起擋住了。

---

### 6.3.6 placeholders：同一個 checksum、不同的 schema 🔴

Flyway 支援在腳本裡放佔位符：

```sql
-- V1__with_placeholder.sql
CREATE TABLE t (
  id     INT PRIMARY KEY,
  region VARCHAR(10) NOT NULL DEFAULT '${region}'
) ENGINE=InnoDB;
```

```java
Flyway.configure()
      .dataSource(url, "root", "root")
      .locations("filesystem:" + loc)
      .placeholders(Map.of("region", System.getProperty("region", "TW")))
      .load()
      .migrate();
```

```properties
# Spring Boot 的寫法
spring.flyway.placeholders.region=TW
```

**實測：換一個 placeholder 值，checksum 會變嗎？**

```
環境 A（region=TW）：checksum = 641203870
                     `region` varchar(10) NOT NULL DEFAULT 'TW'

環境 B（region=JP）：checksum = 641203870   ← 🔴 一模一樣
                     `region` varchar(10) NOT NULL DEFAULT 'JP'
```

🔴 **checksum 是對【代換前】的檔案算的。**

意思是：

```
兩個環境的 flyway_schema_history 一字不差
兩個環境的 schema 【不一樣】
Flyway 的 validate 【永遠不會告訴你】
```

⚠️ **這讓 placeholder 變成一個「合法的 schema 漂移製造機」。**
而且它比手改更難查 —— 因為 history 表看起來完全正常。

📌 **placeholders 的三條使用規則**：

```
✅ 可以用在【不影響 schema 結構】的地方
     └─ 例：GRANT 的帳號名、分區的保留天數、種子資料的環境標記
⚠️ 用在 schema 結構上時，必須同時做 6.9.3 的【黃金 schema diff】
     └─ 而且每個環境要有自己的黃金檔
🔴 絕對不要用 placeholder 控制「這個環境要不要建這張表」
     └─ 那不是版本控管，那是兩套 schema 假裝是一套
```

⚠️ 還有一個小陷阱：**`${...}` 在 SQL 裡是合法字元**。
如果你的腳本裡有 `INSERT INTO tpl VALUES ('Hello ${name}')` 這種**要真的存 `${name}` 字串**的資料，
Flyway 會嘗試代換它並在找不到時報錯。關掉的方法：

```properties
spring.flyway.placeholder-replacement=false
```

或改變分隔符：

```properties
spring.flyway.placeholder-prefix=@{
spring.flyway.placeholder-suffix=}
```

---

## 6.4 接上既有資料庫：baseline

前面的例子都是空資料庫。真實情況通常是：
**一個已經上線兩年、沒有版控的資料庫，現在要接上 Flyway。**

```sql
-- 現況：已經有表、有資料，但沒有 flyway_schema_history
CREATE TABLE customer (id BIGINT PRIMARY KEY, email VARCHAR(120));
CREATE TABLE ord (id BIGINT PRIMARY KEY, customer_id BIGINT);
INSERT INTO customer VALUES (1, 'a@b.c');
```

現在放一個新的遷移進去，然後 `migrate`：

```sql
-- V2__add_status.sql
ALTER TABLE ord ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'NEW';
```

```
org.flywaydb.core.api.FlywayException:
Found non-empty schema(s) `legacy` but no schema history table.
Use baseline() or set baselineOnMigrate to true to initialize the schema history table.
```

✅ **Flyway 拒絕動手** —— 它不知道這個資料庫已經到哪一版了，所以不敢跑任何東西。

**正確做法**：告訴它「現況等於版本 1」。

```java
Flyway.configure()
      .dataSource(url, "root", "root")
      .locations("filesystem:" + loc)
      .baselineOnMigrate(true)      // 遇到非空且無 history 的 schema，先 baseline
      .baselineVersion("1")         // 現況視為版本 1
      .load()
      .migrate();
```

```properties
spring.flyway.baseline-on-migrate=true
spring.flyway.baseline-version=1
```

**實測結果**：

```
資訊: Creating Schema History table `legacy`.`flyway_schema_history` with baseline ...
資訊: Successfully baselined schema with version: 1
[migrate] initialSchemaVersion=1 targetSchemaVersion=2 migrationsExecuted=1
   applied V2 add status  type=SQL  17ms
```

```
installed_rank  version  description             type      checksum  success
1               1        << Flyway Baseline >>   BASELINE  NULL      1
2               2        add status              SQL       -115168768  1
```

📌 **baseline 那一列的三個特徵**：

```
type     = BASELINE            ← 認得出它不是真的跑過腳本
checksum = NULL                ← 沒有對應的檔案，所以沒有 checksum
version  = 你設的 baselineVersion
```

⚠️ **baseline 的語意是「版本 ≤ 1 的遷移，一律視為已套用」。**
所以：

```
✅ 你【可以】把現況的 schema 寫成 V1__initial_schema.sql 放進版控
     （它永遠不會在這個資料庫上執行，但新環境會用它從零建起來）
🔴 你【不可以】期待 V1 之前或等於 V1 的任何腳本在這個資料庫上跑
```

**所以正確的接入流程是四步**：

```
① 從正式環境 dump 出目前的 schema（--no-data）
② 存成 V1__initial_schema.sql，放進版控
③ 正式環境：baselineOnMigrate=true + baselineVersion=1
     → 只會建 history 表 + 寫一列 BASELINE，【不會執行 V1】
④ 新環境（本機 / CI / 新的測試環境）：不設 baseline
     → 從空庫執行 V1（建出完整 schema）→ 再跑 V2、V3...
```

✅ **這樣「從零建起來」和「從現況往前走」兩條路，最後會到同一個 schema。**
而 6.9.3 的黃金 schema diff 就是用來**證明**這件事的。

⚠️ **`baselineOnMigrate=true` 上線之後要拿掉嗎？**

```
🟡 可以留著，但要知道它的風險：
     它的語意是「如果 schema 非空但沒有 history 表，就自動 baseline」。
     萬一有人不小心【刪掉了 history 表】，
     下一次啟動 Flyway 會【安靜地重建它並 baseline】——
     然後所有 V2 之後的遷移會【再跑一次】。
✅ 建議：正式環境 baseline 完成後改成 false，
     並讓「history 表不存在」變成一個【啟動失敗】而不是自動修復。
```

**Step ① 的正確 dump 指令**（也是 6.9.3 要用的）：

```bash
# 只要 schema，不要資料；把 AUTO_INCREMENT 的當前值等噪音去掉
mysqldump -h prod-host -u readonly -p \
  --no-data --skip-comments --skip-add-drop-table --skip-set-charset \
  --routines --triggers shop \
  | sed -E 's/ AUTO_INCREMENT=[0-9]+//' \
  | grep -v '^/\*!' \
  > src/main/resources/db/migration/V1__initial_schema.sql
```

⚠️ **dump 出來之後一定要人工看過一遍**，至少檢查三件事：

```
🔴 有沒有 DEFINER=`root`@`%` 的視圖 / 預存程序
     → 在別的環境會因為帳號不存在而失敗，要改成 DEFINER=CURRENT_USER
🔴 有沒有 flyway_schema_history 自己（如果之前試過）
     → 一定要刪掉
⚠️ 字元集與定序有沒有寫死成跟正式環境一樣（00 章 0.4）
```

---

## 6.5 會壞在哪裡（本章核心）

前面都是「順利的情況」。這一節是**不順利的情況** ——
而它們在真實專案裡出現的頻率，遠比你想像的高。

### 6.5.1 MySQL 沒有 DDL 交易：失敗的遷移長什麼樣子 ★★

這是整章**最重要的一節**。

PostgreSQL 的 DDL 是交易性的 —— 一個遷移腳本裡的 `CREATE TABLE`、`ALTER TABLE`
可以包在一個交易裡，失敗就全部回滾。**MySQL 不行。**

⚠️ MySQL 的每一句 DDL 都會**隱式提交**（04 章 4.2.3 講過隱式提交，這裡是它最貴的一次登場）。

**實驗**：一個腳本裡三句 DDL，故意讓第二句語法錯誤。

```sql
-- V1__base.sql（會成功，先建好環境）
CREATE TABLE acct (
  id  BIGINT AUTO_INCREMENT PRIMARY KEY,
  bal DECIMAL(19,4) NOT NULL
) ENGINE=InnoDB;
INSERT INTO acct (bal) VALUES (100), (200);
```

```sql
-- V2__two_ddl_second_fails.sql
-- 第 1 句：會成功
ALTER TABLE acct ADD COLUMN currency VARCHAR(3) NOT NULL DEFAULT 'TWD';
-- 第 2 句：故意打錯型別名稱（VARCHARR），會失敗
ALTER TABLE acct ADD COLUMN memo VARCHARR(50) NULL;
-- 第 3 句：永遠不會執行
ALTER TABLE acct ADD COLUMN version INT NOT NULL DEFAULT 0;
```

**Flyway 的輸出**：

```
嚴重: Migration of schema `failtest` to version "2 - two ddl second fails" failed!
      Please restore backups and roll back database and code!

org.flywaydb.core.internal.exception.FlywayMigrateException: Script V2__two_ddl_second_fails.sql failed
------------------------------------------
SQL State  : 42000
Error Code : 1064
Message    : You have an error in your SQL syntax; ... near 'VARCHARR(50) NULL' at line 2
Location   : .../V2__two_ddl_second_fails.sql
Line       : 4
```

📌 注意那句 **「Please restore backups and roll back database and code!」** ——
Flyway 在 MySQL 上真的只能這樣說，因為它**沒有辦法**回滾。

**失敗之後，資料庫留下了什麼**：

```sql
SHOW CREATE TABLE acct;
```

```
`id`       bigint NOT NULL AUTO_INCREMENT
`bal`      decimal(19,4) NOT NULL
`currency` varchar(3) NOT NULL DEFAULT 'TWD'   ← 🔴 第 1 句【留下來了】
PRIMARY KEY (`id`)
                                               ← memo、version 都沒有
```

```sql
SELECT installed_rank, version, description, type, execution_time, success
FROM flyway_schema_history;
```

```
installed_rank  version  description            type  execution_time  success
1               1        base                  SQL   10              1
2               2        two ddl second fails  SQL   28              0    ← 🔴
```

🔴 **資料庫現在處於「半套用」狀態：三句 DDL 裡有一句生效了，而 history 記著「失敗」。**

**服務重新啟動會怎樣？**

```
org.flywaydb.core.api.exception.FlywayValidateException: Validate failed: Migrations have failed validation
Detected failed migration to version 2 (two ddl second fails).
Please remove any half-completed changes then run repair to fix the schema history.
```

✅ **服務起不來。** 而這是**正確的行為** ——
Flyway 拒絕在一個「狀態不明」的資料庫上繼續。
`flyway info` 也會把它標出來：

```
1          base                         SQL        SUCCESS      checksum=740925920
2          two ddl second fails         SQL        FAILED       checksum=-252533494
```

---

**現在來看「修復」。**注意 Flyway 的訊息有兩個動作，而且**順序很重要**：

> **「Please remove any half-completed changes（先移除半完成的變更）**
> **then run repair（然後再 repair）」**

很多人只做後半。我們來看只做 `repair` 會怎樣：

```
資訊: Successfully repaired schema history table `failtest`.`flyway_schema_history`
[repair] [Removed failed migrations]
```

```
installed_rank  version  type  success
1               1        SQL   1        ← 🔴 那一列 success=0 被【刪掉】了
```

📌 **`repair` 對「失敗的遷移」做的事是：把那一列 history 刪掉。**
它**完全不碰資料庫的 schema**。所以現在的狀態是：

```
資料庫：acct 表【有】currency 欄位
history：完全不記得 V2 跑過
```

**於是下一次 `migrate` 會從 V2 的第一句重跑**：

```
Error Code : 1060
Message    : Duplicate column name 'currency'
```

🔴 **又失敗了，而且是同一個地方以外的新錯誤。**

---

📌 **正確的修復流程是三步，而且第一步永遠是「先看清楚現況」**：

```sql
-- 第 1 步：搞清楚腳本裡的哪幾句已經生效了
SHOW CREATE TABLE acct;                      -- 逐句比對
SELECT * FROM flyway_schema_history WHERE success = 0;
```

```sql
-- 第 2 步：把【已經生效的部分手動還原】，讓資料庫回到「V2 執行前」的狀態
ALTER TABLE acct DROP COLUMN currency;       -- 撤掉第 1 句
```

```bash
# 第 3 步：repair（刪掉 success=0 那列），修好腳本，重新 migrate
mvn flyway:repair
# → 修正 V2__two_ddl_second_fails.sql 裡的 VARCHARR
mvn flyway:migrate
```

⚠️ **第 2 步有時候做不到。** 例如腳本是這樣：

```sql
ALTER TABLE acct MODIFY bal DOUBLE;          -- 第 1 句：成功，精度已經丟了
UPDATE acct SET bal = bal / 100 WHERE xxx;   -- 第 2 句：失敗
```

第 1 句已經把 `DECIMAL(19,4)` 變成 `DOUBLE` ——
**你可以改回 `DECIMAL`，但小數點後被四捨五入掉的部分回不來。**
這時候唯一的選項就是 Flyway 說的那句：**restore backups**（07 章 7.2）。

🔴 **所以真正的解法不是「修得好」，是「一開始就不要寫成這樣」** ——
下一節（6.6.1）的規則是「**一個遷移腳本只做一件事**」，
它存在的唯一理由就是這一節。

---

### 6.5.2 對照組：純 DML 腳本【會】回滾

同樣的實驗，但腳本裡**只有 DML**：

```sql
-- V2__dml_only_second_fails.sql
-- 第 1 句：會成功
UPDATE acct SET bal = bal + 1 WHERE id = 1;
-- 第 2 句：主鍵重複，會失敗
INSERT INTO acct VALUES (1, 999);
-- 第 3 句：不會執行
UPDATE acct SET bal = bal + 1 WHERE id = 2;
```

```
Error Code : 1062
Message    : Duplicate entry '1' for key 'acct.PRIMARY'
```

**結果**：

```
id  bal
1   100.0000     ← ✅ 第 1 句的 +1 【被回滾了】
2   200.0000

installed_rank  version  success
1               1        1
2               2        0        ← history 還是記著失敗
```

✅ **純 DML 的腳本，Flyway 是包在一個交易裡跑的** —— 失敗會整個回滾。

⚠️ **但 `success = 0` 那一列還在**，所以服務還是起不來、還是要 `repair`。
差別在於：**這次 `repair` 之後直接重跑就對了**，
因為資料庫真的回到了執行前的狀態。

📌 **整理成一張表**：

| 腳本內容 | 失敗時會回滾嗎 | 修復難度 |
|---|---|---|
| 只有 DML（`INSERT` / `UPDATE` / `DELETE`） | ✅ 會 | 🟢 `repair` + 重跑 |
| 只有一句 DDL | N/A（沒有「部分」） | 🟢 `repair` + 重跑 |
| 多句 DDL | 🔴 **不會** | 🟡 要人工還原已生效的句子 |
| DDL 與 DML 混在一起 | 🔴 **不會，而且更糟** | 🔴 見下一節 |

---

### 6.5.3 最糟的情況：`UPDATE` → `ALTER`（隱式提交）→ 失敗 🔴

這是三種形態裡最陰險的一個，因為它**看起來只是一個 DML 腳本**。

```sql
-- V2__dml_then_ddl_then_fail.sql
-- 第 1 句：DML，成功
UPDATE acct SET bal = bal + 1 WHERE id = 1;
-- 第 2 句：DDL —— 這一句會【隱式提交】上面那個 UPDATE
ALTER TABLE acct ADD COLUMN currency VARCHAR(3) NOT NULL DEFAULT 'TWD';
-- 第 3 句：DML，失敗
INSERT INTO acct VALUES (1, 999, 'USD');
```

```
Error Code : 1062
Message    : Duplicate entry '1' for key 'acct.PRIMARY'
```

**執行前 `bal` 是 100，執行後呢？**

```
id  bal         currency
1   101.0000    TWD        ← 🔴 【101】—— 第 1 句被提交了
2   200.0000    TWD
```

🔴 **`bal` 從 100 變成了 101，而這個腳本「失敗了」。**

為什麼？因為第 2 句的 `ALTER TABLE` 觸發了**隱式提交**：

```
BEGIN                                    ← Flyway 開的交易
  UPDATE acct SET bal = bal + 1 ...      ← 在交易裡
  ALTER TABLE acct ADD COLUMN ...        ← 🔴 隱式 COMMIT！UPDATE 落地了
                                            然後 ALTER 自己也提交
  BEGIN（新的交易，Flyway 不知道）
  INSERT INTO acct VALUES (1, 999, ...)  ← 失敗
ROLLBACK                                 ← 只回滾了 INSERT（它本來也沒成功）
```

⚠️ **危險的地方在於「這件事沒有任何徵兆」**：

```
Flyway 的日誌只說「V2 failed」
錯誤訊息只提到第 3 句的 Duplicate entry
沒有任何地方告訴你「第 1 句已經提交了」
而你的第一反應會是「失敗了，所以什麼都沒改」
```

📌 **這就是「DDL 與 DML 不能放在同一個腳本」的真正原因** ——
不是「風格問題」，是**它會讓 DML 的交易邊界在你看不見的地方被切開**。

🔴 **鐵則（6.6.1 會再展開）**：

```
一個遷移腳本裡，DDL 與 DML 【不可以】混在一起。

要一起改的，拆成兩個版本：
    V12__add_currency_column.sql     ← 只有 DDL
    V13__backfill_currency.sql       ← 只有 DML
```

✅ **這樣拆之後，V13 失敗會完整回滾，`repair` + 重跑就好。**

---

### 6.5.4 checksum mismatch 與 `repair` 的真相

**情境**：`V1` 已經在測試環境跑過了。有人為了「順手修一下」，改了它一行。

```sql
-- 原本（已上線）
CREATE TABLE t (id INT PRIMARY KEY);

-- 改成
CREATE TABLE t (id INT PRIMARY KEY, name VARCHAR(10));
```

**下一次啟動**：

```
org.flywaydb.core.api.exception.FlywayValidateException: Validate failed: Migrations have failed validation
Migration checksum mismatch for migration version 1
-> Applied to database : 1766428737
-> Resolved locally    : 1788427993
Either revert the changes to the migration, or run repair to update the schema history.
```

✅ 訊息很清楚，而且給了兩個選項。**但這兩個選項的後果差很多。**

**選項 A：`revert the changes`（把檔案改回去）**

```bash
git checkout origin/master -- src/main/resources/db/migration/V1__create_t.sql
```

✅ **這是 99% 情況的正解。** 想改 schema 就新增 `V2`。

**選項 B：`run repair`**

```
資訊: Repairing Schema History table for version 1
      (Description: create t, Type: SQL, Checksum: 1788427993) ...
資訊: Successfully repaired schema history table `ck2`.`flyway_schema_history`
[repair] [Aligned applied migration checksums]
```

**repair 之後的狀態**：

```sql
SELECT version, checksum, success FROM flyway_schema_history;
```
```
version  checksum    success
1        1788427993  1          ← ✅ checksum 對上新檔案了
```

```sql
SHOW CREATE TABLE t;
```
```
`id` int NOT NULL
PRIMARY KEY (`id`)
                    ← 🔴 【沒有 name 欄位】
```

🔴 **`repair` 做的事只有一件：把 history 的 checksum 改成檔案現在的值。**
**它完全不執行任何 SQL。**

所以 `repair` 之後你得到的是：

```
✅ 服務可以啟動了
🔴 版控裡的 V1 說「有 name 欄位」
🔴 資料庫裡沒有 name 欄位
🔴 而且從今以後，【從零建起來的新環境會有 name 欄位】—— 兩邊永久分岔
```

⚠️ **這是本章最容易被誤用的指令。** 整理成一張表：

| `repair` 的情境 | 它做什麼 | 安全嗎 |
|---|---|---|
| checksum mismatch | 把 history 的 checksum 對齊檔案 | 🔴 **會製造永久漂移**，除非你確定 schema 已經一致 |
| 有 `success = 0` 的紀錄 | **刪掉那一列** | 🟡 必要，但**要先手動還原半完成的變更**（6.5.1） |
| 檔案被刪除 / 改名 | 標記為 missing / 刪除紀錄 | 🟡 看情況 |

📌 **`repair` 唯一真正無害的用法**：

```
「我【已經確認】資料庫的 schema 是對的，只是 history 的紀錄不對」
```

而唯一能「確認 schema 是對的」的方法，就是 6.9.3 的黃金 schema diff。

🔴 **所以正式環境的 `repair` 應該是一個【需要 code review 的動作】**：

```
❌ 不要在 CI/CD pipeline 裡自動跑 flyway:repair
❌ 不要在 Spring Boot 應用啟動時自動 repair（Flyway 沒有這個選項，很好）
✅ 要人工執行，並在執行前後各 dump 一次 schema 做 diff
```

---

### 6.5.5 out-of-order：同事的 `V2` 比你晚合併

**情境**（用流水號版本的團隊每兩週會遇到一次）：

```
你的分支  ：V1__t1.sql、V3__t3.sql      ← 先合併進 master、先部署到測試環境
同事的分支：V2__t2.sql                  ← 兩天後才合併
```

你的部署已經跑過了：

```
[migrate] initialSchemaVersion=null targetSchemaVersion=3 migrationsExecuted=2
   applied V1 t1  type=SQL  11ms
   applied V3 t3  type=SQL   8ms
```

同事的 `V2` 合併進來，下一次部署：

```
org.flywaydb.core.api.exception.FlywayValidateException: Validate failed: Migrations have failed validation
Detected resolved migration not applied to database: 2.
To ignore this migration, set -ignoreMigrationPatterns='*:ignored'.
To allow executing this migration, set -outOfOrder=true.
```

`flyway info` 把它標成 `IGNORED`：

```
1          t1        SQL        SUCCESS      checksum=-1637920622
3          t3        SQL        SUCCESS      checksum=1942586235
2          t2        SQL        IGNORED      checksum=-390436433
```

⚠️ 注意 `flyway info` **不會報錯**（它只是報告），但 `migrate` 會。

**打開 `outOfOrder`**：

```properties
spring.flyway.out-of-order=true
```

```
[migrate] initialSchemaVersion=3 targetSchemaVersion=2 migrationsExecuted=1
   applied V2 t2  type=SQL  20ms
```

**history 表**：

```
installed_rank  version  description  type
1               1        t1           SQL
2               3        t3           SQL
3               2        t2           SQL     ← 🔴 rank 3 的版本是 2
```

🔴 **`installed_rank` 與 `version` 不再一致 ——「執行順序」與「版本順序」永久分岔。**

**這件事的實際後果**：

```
測試環境的執行順序：V1 → V3 → V2
新環境的執行順序  ：V1 → V2 → V3      ← 從零建起來一定是版本序

如果 V2 與 V3 【互相有依賴】（例如 V3 用了 V2 建的欄位），
    → 測試環境跑得過（因為 V3 先跑，那時還沒有依賴）
    → 🔴 新環境跑不過
或者反過來，兩邊都跑得過但【最終 schema 不一樣】。
```

📌 **`outOfOrder` 的取捨**：

| | `outOfOrder=false`（預設） | `outOfOrder=true` |
|---|---|---|
| 遇到落後的版本 | 🔴 啟動失敗 | ✅ 補跑 |
| 執行順序 | ✅ 永遠 = 版本順序 | 🔴 可能分岔 |
| 適合的環境 | **正式環境** | 測試環境 / 開發環境 |

✅ **實務建議**：

```
本機 / 開發 / 測試環境 ：out-of-order = true      （方便，順序錯亂沒差）
預備（staging）/ 正式  ：out-of-order = false     （順序必須跟新環境一致）
```

⚠️ **但這個設定只是止血。** 真正的解法是**在合併時就不要製造落後的版本**：

```bash
#!/bin/bash
# ci/check-migration-version-monotonic.sh
# PR 新增的遷移，版本必須【大於】master 上的最大版本
MASTER_MAX=$(git ls-tree -r --name-only origin/master -- src/main/resources/db/migration/ \
             | grep -oE 'V[0-9]+' | tr -d 'V' | sort -n | tail -1)
NEW_MIN=$(git diff --name-only --diff-filter=A origin/master...HEAD \
          -- src/main/resources/db/migration/ \
          | grep -oE 'V[0-9]+' | tr -d 'V' | sort -n | head -1)
if [ -n "$NEW_MIN" ] && [ "$NEW_MIN" -le "$MASTER_MAX" ]; then
  echo "🔴 這個 PR 的遷移版本 V$NEW_MIN 不大於 master 上的 V$MASTER_MAX。"
  echo "   請把檔名改成比 V$MASTER_MAX 大的版本，然後重新確認腳本內容仍然正確。"
  exit 1
fi
```

📌 **而用時間戳當版本（6.3.4）可以讓這個問題發生的機率降到接近零** ——
因為時間戳天然遞增，「先合併的版本比較小」幾乎總是成立。

---

### 6.5.6 多實例同時啟動：Flyway 的鎖 ★★

**情境**：Kubernetes 一次拉起 8 個 Pod，8 個 Spring Boot 應用**同時**跑 `flyway.migrate()`。

**實驗**：8 個執行緒（各自獨立的 `Flyway` 實例與連線），同時 `migrate` 兩個遷移，
其中 `V1` 故意慢（`SELECT SLEEP(3)`）、`V2` 慢 2 秒。

```
實例 0：套用 0 個遷移，等待+執行 5544 ms（結束於 t+5858 ms）
實例 1：套用 0 個遷移，等待+執行 5552 ms（結束於 t+5866 ms）
實例 2：套用 0 個遷移，等待+執行 5538 ms（結束於 t+5852 ms）
實例 3：套用 0 個遷移，等待+執行 5538 ms（結束於 t+5852 ms）
實例 4：套用 1 個遷移，等待+執行 5560 ms（結束於 t+5874 ms）   ← 跑了 V1
實例 5：套用 0 個遷移，等待+執行 5548 ms（結束於 t+5862 ms）
實例 6：套用 1 個遷移，等待+執行 5562 ms（結束於 t+5877 ms）   ← 跑了 V2
實例 7：套用 0 個遷移，等待+執行 5555 ms（結束於 t+5870 ms）
總牆鐘 5877 ms
```

✅ **兩個遷移各只被套用一次**，8 個實例全部成功。

**資料庫端看到的是什麼？** 同時輪詢 `information_schema.processlist`：

```
2026-09-03 04:19:21.743   共 8 條連線在跑
  48/SELECT GET_LOCK('Flyway-1247173368',10)
  49/SELECT SLEEP(3)                            ← 拿到鎖的那一個，正在跑 V1
  50/SELECT GET_LOCK('Flyway-1247173368',10)
  51/SELECT GET_LOCK('Flyway-1247173368',10)
  52/SELECT GET_LOCK('Flyway-1247173368',10)
  45/SELECT GET_LOCK('Flyway-1247173368',10)
  46/SELECT GET_LOCK('Flyway-1247173368',10)
  47/SELECT GET_LOCK('Flyway-1247173368',10)

2026-09-03 04:19:25.065
  50/SELECT SLEEP(2)                            ← 換另一個實例拿到鎖，跑 V2
  （其餘七條仍在 GET_LOCK）
```

📌 **Flyway 在 MySQL 上用的是【具名建議鎖】`GET_LOCK`**，不是表鎖、不是行鎖：

```
SELECT GET_LOCK('Flyway-<schema 名的 hash>', 10)
                                            ↑
                                    單次嘗試的逾時：10 秒
```

**那如果一個遷移跑了超過 10 秒呢？** 實驗：`V1` 改成 `SELECT SLEEP(15)`，6 個實例。

```
實例 0：套用 1 個遷移，等待+執行 15432 ms
實例 1：套用 0 個遷移，等待+執行 15414 ms      ← 沒有失敗
實例 2：套用 0 個遷移，等待+執行 15414 ms
實例 3：套用 0 個遷移，等待+執行 15423 ms
實例 4：套用 0 個遷移，等待+執行 15419 ms
實例 5：套用 0 個遷移，等待+執行 15427 ms
```

✅ **沒有一個失敗。** 因為那個 `10` 只是**單次嘗試**的逾時 ——
`flyway-mysql` 的 `MySQLNamedLockTemplate` 是一個**重試迴圈**
（反編譯 `MySQLNamedLockTemplate.lock()` 的位元碼）：

```java
// 等價的原始碼
private void lock() throws SQLException {
    while (!tryLock()) {        // tryLock() = SELECT GET_LOCK(name, 10)
        Thread.sleep(100);
    }
}
```

🔴 **注意這個迴圈【沒有次數上限、沒有總逾時】** —— 它會一直等下去。

⚠️ **這在 Kubernetes 上有一個具體後果**：

```
情境：一個遷移在正式環境要跑 8 分鐘（大表加索引）

Pod 1  拿到鎖 → 開始跑 8 分鐘的遷移
Pod 2~8 進入 while(!tryLock()) sleep(100) → 一直等
                            ↓
Kubernetes 的 startupProbe / readinessProbe 逾時（預設常常是 30 ~ 60 秒）
                            ↓
🔴 Pod 2~8 被判定啟動失敗 → 被殺掉 → 重啟 → 再排隊 → 再被殺
                            ↓
🔴 CrashLoopBackOff。而【Pod 1 可能也在這波重啟裡被一起殺掉】
    —— 於是那個 8 分鐘的 ALTER 被中斷在一半（回到 6.5.1 的狀態）
```

📌 **三種做法，取捨在 6.10.3**：

```
① 應用內遷移（預設）
     ✅ 最簡單，開發期完全夠用
     🔴 遷移時間 > probe 逾時 就會出事
     → 必須把 startupProbe 的 failureThreshold × periodSeconds
       設成【大於最慢遷移的預估時間】

② initContainer 跑遷移
     ✅ 主容器的 probe 不會被遷移時間影響
     🔴 每個 Pod 的 initContainer 都會跑一次（還是要靠 Flyway 的鎖互斥）

③ 獨立的 Job / Helm hook，跑完才 rollout
     ✅ 遷移只跑一次、有自己的 timeout 與重試策略、失敗就不部署
     ✅ 正式環境的正解
     🔴 需要 CI/CD 支援「先跑 Job 再更新 Deployment」
```

⚠️ **還有一個容易忽略的事**：`GET_LOCK` 是**連線層級**的鎖。
如果 Pod 1 被 `SIGKILL`，它的連線斷掉 → **MySQL 會自動釋放那個鎖**。
✅ 這是好事（不會永久卡死），
🔴 但壞事是：**那個被中斷的 `ALTER` 沒有人幫你收尾**，
而下一個拿到鎖的 Pod 會看到 `success = 0` 然後啟動失敗。

📌 **對照：`ddl-auto=update` 完全沒有這個鎖。**
8 個 Hibernate 會同時下 `ALTER TABLE`，
結果是「其中幾個拿到 `ERROR 1060 Duplicate column name`」而**啟動失敗** ——
這是 6.2.2 沒說完的那個問題。

---

### 6.5.7 `clean` 與 `cleanDisabled`

Flyway 有一個 `clean` 指令：**刪掉 schema 裡的所有東西**。

```
Exception in thread "main" org.flywaydb.core.api.FlywayException:
Unable to execute clean as it has been disabled with the 'flyway.cleanDisabled' property.
```

✅ **Flyway 10 的 `cleanDisabled` 預設是 `true`** ——
這是 Flyway 9 之後改的預設值，因為有人真的在正式環境跑過 `clean`。

📌 **`clean` 的正當用途只有一個：本機/CI 的「從零重跑一次全部遷移」**（6.9.1）。

```properties
# application-local.properties / application-test.properties 【只在這裡】
spring.flyway.clean-disabled=false
```

🔴 **絕對不要**：

```
❌ 把 clean-disabled=false 寫在 application.properties（會被所有 profile 繼承）
❌ 用環境變數 FLYWAY_CLEAN_DISABLED=false 全域設定
❌ 在 CI 的部署階段（而不是測試階段）保留 clean 的能力
```

⚠️ **更好的做法：讓正式環境的資料庫帳號沒有 `DROP` 權限**（6.10.2）。
這樣就算設定寫錯了，`clean` 也跑不動 —— **權限比設定可靠**。

---

### 6.5.8 七種壞掉的方式，與對應的處理

把整節整理成一張排查表：

| 症狀（啟動時的錯誤） | 真正發生的事 | 處理 |
|---|---|---|
| `Found more than one migration with version X` | 兩個檔案的版本號解析結果相同（`V2` vs `V2.0`、`V1_20` vs `V1.20`） | 改檔名。**不需要動資料庫** |
| `Migration checksum mismatch for migration version X` | 已套用的腳本被改過（可能只是一個空白） | ✅ 先 `git checkout` 把檔案改回去。真的要改就新增一個版本 |
| `Detected failed migration to version X` | 上次有一個腳本執行到一半失敗（`success = 0`） | 🔴 **先人工還原半完成的變更**，再 `repair`，再修腳本重跑（6.5.1） |
| `Detected resolved migration not applied to database: X` | 有一個版本比 current 小的新腳本（分支合併順序） | 測試環境開 `outOfOrder`；正式環境改檔名（6.5.5） |
| `Found non-empty schema(s) X but no schema history table` | 既有資料庫第一次接 Flyway | `baselineOnMigrate` + `baselineVersion`（6.4） |
| `Schema X has version Y, but no migration could be resolved` | `locations` 設錯，或遷移檔沒被打包進 jar | 檢查 `spring.flyway.locations` 與 `src/main/resources` 路徑 |
| Pod 一直 `CrashLoopBackOff`，日誌停在啟動 | Flyway 在等 `GET_LOCK`，probe 先逾時了 | 調 `startupProbe`，或改用獨立 Job（6.5.6 / 6.10.3） |

📌 **一個實用的除錯起點** —— 這三句查詢比讀日誌快：

```sql
-- ① 有沒有失敗的遷移？
SELECT * FROM flyway_schema_history WHERE success = 0;

-- ② 現在到哪一版？
SELECT version, description, installed_on
FROM flyway_schema_history
WHERE success = 1 AND version IS NOT NULL
ORDER BY installed_rank DESC LIMIT 5;

-- ③ 有沒有人卡在 Flyway 的鎖上？
SELECT id, time, state, info
FROM information_schema.processlist
WHERE info LIKE '%GET_LOCK(''Flyway%';
```

---

## 6.6 遷移腳本怎麼寫

### 6.6.1 一個腳本只做一件事

這是 6.5.1 ～ 6.5.3 三個實驗的**唯一結論**：

```
🔴 一個遷移腳本裡，不要放【第二句會失敗的 DDL】
🔴 一個遷移腳本裡，DDL 與 DML 不可以混
```

因為 MySQL 沒有 DDL 交易，所以「腳本的粒度」就是**你唯一能控制的回滾粒度**。

⚠️ **這不代表「一個腳本只能有一句 SQL」。** 判斷標準是：

> **「如果這個腳本跑到一半失敗，我還原得回去嗎？」**

```sql
-- ✅ 可以：兩句 DDL，但第二句失敗時第一句【還原得回去】
--    V12__add_settlement_columns.sql
ALTER TABLE ord
  ADD COLUMN settled_at   DATETIME(3) NULL,
  ADD COLUMN settle_batch VARCHAR(32) NULL,
  ALGORITHM=INSTANT;
-- 📌 寫成【一句】ALTER 的多個子句 —— MySQL 會把它當一個原子操作
```

```sql
-- 🔴 不行：兩句獨立的 DDL
ALTER TABLE ord ADD COLUMN settled_at DATETIME(3) NULL, ALGORITHM=INSTANT;
ALTER TABLE settlement ADD COLUMN ord_id BIGINT NULL, ALGORITHM=INSTANT;
--    第二句失敗 → 第一句留下來了 → 6.5.1 的狀態
--    要拆成 V12 和 V13
```

📌 **一個很實用的技巧：把同一張表的多個變更合併成一句 `ALTER`。**
除了原子性，它還有效能上的好處 —— 6.7.2 的實測顯示，
一次表重建要 4 ～ 5 秒，**兩句獨立的 `ALTER` 就是兩次重建**。

```sql
-- 🔴 兩次重建（約 10 秒）
ALTER TABLE ord MODIFY customer_id BIGINT NOT NULL, ALGORITHM=COPY;
ALTER TABLE ord MODIFY placed_at DATETIME(6) NOT NULL, ALGORITHM=COPY;

-- ✅ 一次重建（約 5 秒），而且是原子的
ALTER TABLE ord
  MODIFY customer_id BIGINT NOT NULL,
  MODIFY placed_at   DATETIME(6) NOT NULL,
  ALGORITHM=COPY;
```

---

### 6.6.2 幂等：MySQL 8.0 的支援度比你以為的差

「腳本跑第二次不會出事」聽起來應該用 `IF NOT EXISTS` 解決。**實測 MySQL 8.0.46**：

| 語法 | 支援？ |
|---|---|
| `CREATE TABLE IF NOT EXISTS t (...)` | ✅ 可用 |
| `DROP TABLE IF EXISTS t` | ✅ 可用 |
| `CREATE DATABASE IF NOT EXISTS db` | ✅ 可用 |
| `CREATE OR REPLACE VIEW v AS ...` | ✅ 可用 |
| `ALTER TABLE t ADD COLUMN IF NOT EXISTS a INT` | 🔴 `ERROR 1064`（語法錯誤） |
| `ALTER TABLE t DROP COLUMN IF EXISTS a` | 🔴 `ERROR 1064` |
| `CREATE INDEX IF NOT EXISTS idx ON t(a)` | 🔴 `ERROR 1064` |
| `DROP INDEX IF EXISTS idx ON t` | 🔴 `ERROR 1064` |
| `ALTER TABLE t ADD INDEX IF NOT EXISTS idx (a)` | 🔴 `ERROR 1064` |

🔴 **MySQL 8.0 完全沒有欄位與索引的 `IF [NOT] EXISTS`。**
（MariaDB 有，這是常見的混淆來源。）

⚠️ **好消息是：大部分情況你【不需要】幂等。**
Flyway 的 `V__` 遷移本來就只跑一次，
而「跑第二次」只會在 6.5.1 的失敗修復流程裡發生 —— 那時候你本來就該人工介入。

📌 **需要幂等的只有三種情況**：

```
① R__ 可重複遷移（本來就會重跑）→ 用 CREATE OR REPLACE
② 你的團隊真的有「同一個腳本可能在不同環境跑過」的歷史包袱
③ 6.5.1 的修復流程你想要「重跑就好，不用手動還原」
```

**如果真的需要，可以用 `information_schema` 加預存程序。**
以下是實測可用的版本（而且**可以直接放進 Flyway 的 `.sql`** ——
Flyway 認得 `DELIMITER`）：

```sql
-- V2__migration_helpers.sql
DROP PROCEDURE IF EXISTS add_column_if_absent;
DROP PROCEDURE IF EXISTS add_index_if_absent;

DELIMITER $$

CREATE PROCEDURE add_column_if_absent(
  IN p_table VARCHAR(64), IN p_column VARCHAR(64), IN p_defn TEXT)
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = DATABASE()
                   AND table_name = p_table AND column_name = p_column) THEN
    SET @s = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN `', p_column, '` ', p_defn);
    PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
    SELECT CONCAT('已加上 ', p_table, '.', p_column) AS result;
  ELSE
    SELECT CONCAT('略過（已存在）', p_table, '.', p_column) AS result;
  END IF;
END$$

CREATE PROCEDURE add_index_if_absent(
  IN p_table VARCHAR(64), IN p_index VARCHAR(64), IN p_cols TEXT)
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.statistics
                 WHERE table_schema = DATABASE()
                   AND table_name = p_table AND index_name = p_index) THEN
    SET @s = CONCAT('ALTER TABLE `', p_table, '` ADD INDEX `', p_index, '` (', p_cols,
                    '), ALGORITHM=INPLACE, LOCK=NONE');
    PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
    SELECT CONCAT('已建立索引 ', p_index) AS result;
  ELSE
    SELECT CONCAT('略過（已存在）索引 ', p_index) AS result;
  END IF;
END$$

DELIMITER ;
```

```sql
-- V3__use_helper.sql
CALL add_column_if_absent('ord', 'memo', 'VARCHAR(50) NULL');
CALL add_index_if_absent('ord', 'idx_memo', '`memo`');
```

**實測輸出**：

```
第 1 次：已加上 ord.memo        /  已建立索引 idx_memo
第 2 次：略過（已存在）ord.memo /  略過（已存在）索引 idx_memo
```

⚠️ **三個注意事項**：

```
🔴 這個做法只檢查「存不存在」，【不檢查定義對不對】
     —— 欄位存在但型別不一樣時它會安靜略過
🔴 預存程序需要 CREATE ROUTINE 權限（6.10.2 的遷移帳號要有）
⚠️ 用 DATABASE() 所以只能改「當前 schema」的表 —— 通常正好是你要的
```

📌 **我的建議：不要一開始就導入這個。**
先做到「一個腳本只做一件事」+「已上線的腳本不可修改」（6.3.5），
真的被幂等問題咬到再加。

---

### 6.6.3 不要在遷移裡做的六件事

| # | 不要做 | 為什麼 | 該怎麼做 |
|---|---|---|---|
| 1 | 混 DDL 與 DML | 隱式提交切斷交易邊界（6.5.3） | 拆成兩個版本 |
| 2 | 不寫 `ALGORITHM` / `LOCK` | 你不知道 MySQL 會選什麼（6.7.2） | 明確寫出來，讓不支援時**直接失敗** |
| 3 | `SELECT` 撈資料回來再加工 | 遷移是 SQL 腳本，沒有應用邏輯的地方 | 純 SQL 做不到就寫 Java 遷移（`JdbcMigration`） |
| 4 | 依賴當前時間 / 隨機值 | 每個環境跑出不同結果，schema 與資料會分岔 | 用固定值，或把時間當 placeholder 傳入 |
| 5 | 依賴 Entity / 應用程式碼 | 遷移的生命週期比程式碼長，**Entity 兩年後長得不一樣了** | 遷移腳本裡的欄位清單要**寫死**，不要用 `SELECT *` |
| 6 | 一個腳本刷 500 萬列 | 一個交易鎖住整張表（6.6.5 實測停頓 11 秒） | 分批，或拆成獨立的批次作業 |

⚠️ **第 5 點最容易被忽略。** 問題出在 `SELECT *` 與 `CREATE TABLE ... LIKE`：

```sql
-- V20__copy_orders_to_archive.sql
CREATE TABLE ord_archive LIKE ord;
INSERT INTO ord_archive SELECT * FROM ord WHERE placed_at < '2025-01-01';
--                             ↑ 🔴
```

這兩句的結果**不是由腳本內容決定的，而是由「執行它的那一刻 `ord` 長什麼樣」決定的**。

而「那一刻 `ord` 長什麼樣」有兩個你控制不了的變數：

```
🔴 執行順序：6.5.5 的 outOfOrder 會讓 V20 在不同環境的不同時間點執行
     測試環境：V1 → V3 → V20 → V2       ← V20 執行時，ord 還沒有 V2 加的欄位
     新環境  ：V1 → V2 → V3 → V20       ← V20 執行時，ord 【有】那個欄位
     → 兩邊的 ord_archive 欄位數不一樣，而 history 表看起來完全相同

🔴 手動熱修：有人在正式環境手動加過一個欄位（6.2.1 的問題 1）
     → 正式環境的 ord_archive 多一個欄位，測試環境沒有
```

⚠️ **這一類 bug 的特徵是「checksum 一致、history 一致、schema 不一致」** ——
跟 6.3.6 的 placeholder 問題同一個家族，
而且 Flyway 的 `validate` 對它們**一樣沒有能力**。

✅ **把欄位寫死，這一整類問題就消失了** —— 腳本的結果只由腳本本身決定：

```sql
-- V20__copy_orders_to_archive.sql
CREATE TABLE ord_archive (
  id           BIGINT        NOT NULL PRIMARY KEY,
  order_no     VARCHAR(32)   NOT NULL,
  customer_id  INT           NOT NULL,
  total_amount DECIMAL(19,4) NOT NULL,
  placed_at    DATETIME(3)   NOT NULL
) ENGINE=InnoDB CHARSET=utf8mb4;

INSERT INTO ord_archive (id, order_no, customer_id, total_amount, placed_at)
SELECT                   id, order_no, customer_id, total_amount, placed_at
FROM ord
WHERE placed_at < '2025-01-01';
```

📌 **同一條規則也適用於 `INSERT INTO t VALUES (...)`（沒寫欄位名）**。
遷移腳本裡的每一句 `INSERT` 都應該有明確的欄位清單。

---

### 6.6.4 DML 遷移：資料修正怎麼寫

不是所有遷移都是 schema。「把 3,214 筆狀態錯誤的訂單改對」也是一次遷移，
而且它應該跟 schema 變更一樣進版控。

```sql
-- V21__fix_orphan_refund_status.sql
-- 背景：2026-08-17 的一個 bug 讓 4,127 筆已退款訂單的 status 停在 PAID。
-- 判定條件：有 refund 紀錄且金額對得上，但 ord.status = 'PAID'
-- 影響範圍：預期 4,127 列（上線前在正式環境的唯讀副本上驗證過）

UPDATE ord o
  JOIN (SELECT ord_id, SUM(amount) AS refunded
        FROM refund
        WHERE state = 'DONE'
        GROUP BY ord_id) r ON r.ord_id = o.id
SET o.status = 'REFUNDED'
WHERE o.status = 'PAID'
  AND r.refunded >= o.total_amount
  AND o.placed_at >= '2026-08-01'
  AND o.placed_at <  '2026-09-01';
```

📌 **DML 遷移的五條規則**：

```
① 註解裡寫【背景、判定條件、預期影響列數】
     —— 三年後有人看到這個腳本，只有註解能告訴他為什麼
② 一定要有 WHERE，而且範圍要收得比「理論上正確」更緊
     —— 加上時間範圍是最便宜的保險
③ 上線前先在唯讀副本上跑對應的 SELECT COUNT(*)，確認列數符合預期
④ 純 DML，不要摸 schema（6.5.3）
⑤ 大量更新要分批（6.6.5）
```

⚠️ **④ 有一個例外要注意**：如果修正需要**新的欄位或索引**才做得到，
那就是兩個遷移：

```
V21__add_index_for_fix.sql      ← DDL：加一個臨時索引讓 UPDATE 走得動
V22__fix_orphan_refund.sql      ← DML：真正的修正
V23__drop_temp_index.sql        ← DDL：拿掉臨時索引
```

📌 **「為了一次 DML 加一個臨時索引」是完全合理的做法** ——
一個沒有索引的 `UPDATE ... WHERE` 在 30 萬列的表上會鎖住整張表
（04 章實測併發差 10.8 倍、05 章 X1 在 buffer pool 不足時差 187 ～ 350 倍）。
加索引的 1.5 秒（6.7.2 實測）遠比那個便宜。

---

### 6.6.5 大表回填：分批 vs 一次（實測 40 倍差別）★

**情境**（expand-contract 的第三步，6.8.2）：
`ord` 表新增了 `note` 欄位，要把 100 萬列的 `remark` 複製過去。

**環境**：`ord` 1,021,472 列（`remark` 平均 57 字元），
同時有一個「線上服務」在跑（每 5 ms 一次 `INSERT` + 一次 `UPDATE`），
量它的**最長單次停頓**。

```java
// 一次全刷
UPDATE ord SET note = remark WHERE note IS NULL;
```

```java
// 分批（正確寫法，見下方三個陷阱）
// 每一輪：先算出這批的 id 上界，再用它當 WHERE
long lastId = 0;
var ps = c.prepareStatement(
    "UPDATE ord SET note = remark WHERE id > ? AND note IS NULL ORDER BY id LIMIT " + size);
var qs = c.prepareStatement(
    "SELECT MAX(id) FROM (SELECT id FROM ord WHERE id > ? ORDER BY id LIMIT " + size + ") x");
while (true) {
    qs.setLong(1, lastId);
    long next;
    try (var rs = qs.executeQuery()) {
        if (!rs.next()) break;
        next = rs.getLong(1);
        if (rs.wasNull()) break;
    }
    ps.setLong(1, lastId);
    ps.executeUpdate();
    lastId = next;
}
```

**實測結果**：

| 做法 | 總耗時 | 最長單輪 | 🔴 **線上寫入的最長停頓** |
|---|---|---|---|
| **一次全刷**（1,021,679 列） | 11,269 ms | — | 🔴 **11,274 ms** |
| 分批 1,000（1,027 輪） | 12,963 ms | 340 ms | ✅ **279 ms** |
| 分批 5,000（206 輪） | 11,306 ms | 577 ms | 537 ms |
| 分批 50,000（22 輪） | 9,950 ms | 853 ms | 434 ms |

📌 **兩個關鍵觀察**：

**① 總耗時幾乎一樣（9.9 ～ 13.0 秒）。**
分批**不會讓整件事變快** —— 分批 1,000 甚至比一次全刷慢了 15%（多 1,027 次往返）。

**② 線上寫入的停頓差 40 倍（11,274 ms → 279 ms）。**
🔴 一次全刷會讓線上服務**在它跑的整段時間裡都寫不進去** ——
注意 `11,274 ≈ 11,269`，也就是**停頓時間等於回填時間**。

> **所以「分批」的目的不是變快，是【讓別人插得進來】。**
> 這跟 05 章 5.9.1 的分批 `DELETE` 是同一件事的兩種說法。

⚠️ **批次大小的取捨**：

```
太小（1,000）  → 往返次數多、總耗時多 15%，但停頓最短（279 ms）
太大（50,000）→ 總耗時最短，但單輪停頓 853 ms —— 快回到一次全刷的問題
✅ 實務起點：1,000 ～ 5,000，然後【量你自己的停頓】再調
```

---

🔴 **分批的三個陷阱**（每一個我都見過真的踩下去）：

**陷阱 1：用 `LIMIT` 但沒有 `ORDER BY`。**

```sql
-- 🔴 錯：沒有 ORDER BY，MySQL 每次可能給你不同的 1000 列
UPDATE ord SET note = remark WHERE note IS NULL LIMIT 1000;
```

沒有 `ORDER BY` 的 `LIMIT` 順序**未定義**。
它通常「剛好」可以（因為 `note IS NULL` 的條件會讓改過的列自動排除），
但如果條件不是自排除的（例如 `SET status = 'X' WHERE status = 'Y'` 之後又有人改回 `'Y'`），
就會變成**永遠跑不完的迴圈**。

**陷阱 2：用 `OFFSET` 分頁。**

```sql
-- 🔴 錯：越跑越慢（05 章 5.8 的深分頁）
UPDATE ord SET note = remark ORDER BY id LIMIT 1000 OFFSET 500000;
```

而且更糟 —— **`UPDATE` 改變了資料，`OFFSET` 的基準會跟著飄**，會漏改或重複改。
✅ 正解永遠是**用主鍵當游標（seek 法）**，像上面的程式碼那樣。

**陷阱 3：沒有出口。**

```java
// 🔴 錯：一直跑到完，跑不完就一直跑
while (true) { ... }
```

正式環境的批次作業必須有三個出口：

```java
long deadline = System.currentTimeMillis() + Duration.ofMinutes(10).toMillis();
int rounds = 0;
while (true) {
    if (System.currentTimeMillis() > deadline) {         // ① 時間出口
        log.warn("回填時間到，已處理到 id={}，下次繼續", lastId);
        break;
    }
    if (++rounds > MAX_ROUNDS) {                          // ② 輪數出口（防無限迴圈）
        log.error("回填輪數超過上限 {}，停止", MAX_ROUNDS);
        break;
    }
    if (isHighLoad()) {                                   // ③ 負載出口
        log.info("資料庫負載過高，暫停 30 秒");
        Thread.sleep(30_000);
        continue;
    }
    // ... 做一批 ...
    Thread.sleep(50);                                     // 每批之間讓路
}
```

⚠️ **③ 的「負載」怎麼判斷？** 最簡單也最有效的一個指標：

```sql
-- Threads_running 就是「現在有幾個查詢正在執行」
-- 平常個位數；超過核心數就代表已經在排隊了（05 章 5.10.1）
SHOW GLOBAL STATUS LIKE 'Threads_running';
```

📌 **這正是 `pt-online-schema-change` 的 `--max-load Threads_running=50` 在做的事**（6.7.7）。

---

📌 **回填該放在哪裡？三種做法**：

| 做法 | 適合的規模 | 缺點 |
|---|---|---|
| **寫進 Flyway 的 `V__` 腳本** | < 10 萬列 | 🔴 卡住服務啟動；超時會變成 6.5.1 的狀態 |
| **獨立的批次作業 / Job**（推薦） | 任何規模 | 需要「回填完成」的判斷點才能進下一步 |
| **應用程式雙寫 + 讀時補寫** | 資料極大、可以慢慢收斂 | 邏輯複雜，要記得清掉 |

⚠️ **「寫進 Flyway 腳本」的界線在哪？**
一個可用的判斷：**這個腳本的 `execution_time` 會不會超過部署的健康檢查逾時**（6.5.6）。

```
Kubernetes startupProbe 給 60 秒
→ 遷移腳本的總時間必須 < 60 秒（而且要用【正式環境的資料量】估）
→ 6.3.2 的 execution_time 欄位就是拿來估這個的
```

---

## 6.7 線上大表變更（回答 04 / 05 章）★★

### 6.7.1 三個維度

改一張大表的 schema，你要同時想三件事：

```
① ALGORITHM ——「怎麼改」
     INSTANT   只改中介資料，不碰資料檔        （毫秒級）
     INPLACE   在原表上就地改（可能要重建）    （秒 ~ 小時）
     COPY      建一張新表、把資料搬過去、換名  （最慢）

② LOCK ——「改的期間別人能做什麼」
     NONE       可讀、可寫
     SHARED     可讀、不可寫
     EXCLUSIVE  不可讀、不可寫

③ MDL ——「改之前要先【拿到】表的排他中介資料鎖」
     🔴 這一項跟 ① ② 完全無關，也是最容易出事的一項（6.7.4）
```

⚠️ **①②③ 的關係常被誤解。** 正確的心智模型：

```
    ┌─────────────────────────────────────────────────────┐
    │ ③ 先拿 MDL 排他鎖   ← 要等所有【正在使用這張表的交易】結束
    │      （不管 ALGORITHM 是 INSTANT 還是 COPY，這一步都要）
    ├─────────────────────────────────────────────────────┤
    │ ① ② 執行真正的變更 ← LOCK=NONE 的話這段期間可以讀寫
    ├─────────────────────────────────────────────────────┤
    │ ③ 最後再拿一次 MDL 排他鎖   ← 提交中介資料的變更
    └─────────────────────────────────────────────────────┘
```

📌 **所以 `ALGORITHM=INSTANT` 保證的是「中間那一段是零成本」——
它【不保證】前後兩次拿 MDL 是零成本。** 這正是開場那 11.2 秒的來源。

---

### 6.7.2 19 種操作 × 3 種 ALGORITHM：完整實測矩陣 ★★

**環境**：`ord` 表 **1,000,000 列**，資料 **135.7 MB** + 索引 **85.2 MB**，
MySQL 8.0.46，`innodb_buffer_pool_size = 512M`。

每一個操作都試四次：`INSTANT` / `INPLACE + LOCK=NONE` / `INPLACE`（預設鎖）/ `COPY`。
成功就記耗時，失敗就記錯誤碼。

| 操作 | `INSTANT` | `INPLACE`+`LOCK=NONE` | `INPLACE`（預設鎖） | `COPY` |
|---|---|---|---|---|
| 加欄位（`DEFAULT`、放最後） | ✅ **204ms** | ✅ 3983ms | ✅ 4083ms | ✅ 4806ms |
| 加欄位（`AFTER id` 指定位置） | ✅ **94ms** | ✅ 4370ms | ✅ 4093ms | ✅ 4759ms |
| 加欄位（`NOT NULL` 無 `DEFAULT`） | ✅ **89ms** | ✅ 5027ms | ✅ 4174ms | ✅ 5290ms |
| 刪欄位 | ✅ **98ms** | ✅ 4648ms | ✅ 3980ms | ✅ 5311ms |
| 改欄位名 | ✅ **111ms** | ✅ 110ms | ✅ 111ms | ✅ 5071ms |
| `VARCHAR(16)`→`VARCHAR(32)` 加長 | ✗ `1845` | ✅ **104ms** | ✅ 106ms | ✅ 5517ms |
| `VARCHAR(200)`→`VARCHAR(300)` | ✗ `1845` | ✅ **95ms** | ✅ 94ms | ✅ 5293ms |
| `VARCHAR(32)`→`VARCHAR(16)` 縮短 | ✗ `1846` | ✗ `1846` | ✗ `1846` | ✅ **5168ms** |
| `INT`→`BIGINT` | ✗ `1846` | ✗ `1846` | ✗ `1846` | ✅ **5107ms** |
| `DATETIME(3)`→`DATETIME(6)` | ✗ `1846` | ✗ `1846` | ✗ `1846` | ✅ **4679ms** |
| `NULL`→`NOT NULL`（有 NULL 資料） | ✗ `1845` | ✗ `1138` | ✗ `1138` | ✗ `1265` |
| 加普通索引 | ✗ `1845` | ✅ **1433ms** | ✅ 1299ms | ✅ 5434ms |
| 加唯一索引 | ✗ `1845` | ✅ **1990ms** | ✅ 1873ms | ✅ 7555ms |
| 刪索引 | ✗ `1845` | ✅ **131ms** | ✅ 105ms | ✅ 3689ms |
| 加生成欄位 `VIRTUAL` | ✅ **141ms** | ✅ 94ms | ✅ 92ms | ✅ 4643ms |
| 加生成欄位 `STORED` | ✗ `1845` | ✗ `1845` | ✗ `1845` | ✅ **5131ms** |
| 改定序（`CONVERT TO`） | ✗ `1846` | ✗ `1846` | ✗ `1846` | ✅ **4472ms** |
| 改欄位註解 | ✅ **101ms** | ✅ 101ms | ✅ 103ms | ✅ 4953ms |
| 改表名 | ✅ **339ms** | ✗ `1845` | ✅ 90ms | ✅ 4846ms |

---

📌 **先把三個錯誤碼分清楚 —— 它們的意思完全不一樣**：

```
ERROR 1845 (0A000)
  ALGORITHM=INSTANT is not supported for this operation. Try ALGORITHM=COPY/INPLACE.
  → 這個操作【不支援你指定的演算法】，但支援別的。訊息會告訴你用哪個。

ERROR 1846 (0A000)
  ALGORITHM=INPLACE is not supported. Reason: Cannot change column type INPLACE.
  Try ALGORITHM=COPY.
  → 一樣是不支援，但【多告訴你原因】。1846 是「有 Reason」的版本。

ERROR 1221 (HY000)
  Incorrect usage of ALGORITHM=INSTANT and LOCK=NONE/SHARED/EXCLUSIVE
  → 🔴 這不是「不支援」，是【語法不能這樣寫】——
     ALGORITHM=INSTANT 不接受任何 LOCK 子句（它本來就不鎖）。
```

⚠️ **`ERROR 1221` 是矩陣裡沒有的一欄，但它會咬你**：
`ALTER TABLE ord ADD COLUMN x INT, ALGORITHM=INSTANT, LOCK=NONE` 會失敗。
**寫 `INSTANT` 的時候不要寫 `LOCK`。**

---

📌 **從矩陣裡讀出來的五條規則**：

**① `INSTANT` 能做的事，比大部分人以為的多。**

```
✅ 加欄位（含指定位置、含 NOT NULL 無 DEFAULT）
✅ 刪欄位
✅ 改欄位名
✅ 加 VIRTUAL 生成欄位
✅ 改欄位 / 表註解
✅ 改表名
```

而且**耗時與資料量無關** —— 89 ～ 339 ms，在 1 萬列和 1 億列的表上都一樣。

⚠️ **「加欄位可以指定位置」與「刪欄位」是 MySQL 8.0.29 才支援 `INSTANT` 的**
（8.0.12 ～ 8.0.28 只能加在最後、不能刪）。
🔴 **8.0.29 以下的版本，這兩項會退回 4 秒的表重建** ——
所以 6.7.9 的決策樹第一步永遠是「先確認 MySQL 的小版本」。

**② `INSTANT` 不能做的事，`INPLACE` 常常可以，而且也很快。**

```
索引的增刪、VARCHAR 的加長 —— INSTANT 不行，但 INPLACE 只要 95 ~ 1990 ms
```

🔴 **反過來要注意：「加欄位」用 `INPLACE` 是 4 秒（表重建），用 `INSTANT` 是 0.1 秒。**
差 **40 倍**。所以**指定演算法不只是防呆，也是效能決策**。

**③ 「改型別」幾乎一定要 `COPY`。**

```
VARCHAR 縮短、INT→BIGINT、DATETIME 精度、改定序、加 STORED 生成欄位
    → 全部 ERROR 1846，只剩 COPY
    → 4.5 ~ 5.2 秒 / 100 萬列，而且 COPY 不能 LOCK=NONE
      （6.7.6 實測：會堵住線上寫入 5.5 秒）
```

⚠️ 這一類是**唯一真的需要 `pt-osc` / `gh-ost` 的場合**（6.7.6）。

**④ `VARCHAR` 加長能不能 `INPLACE`，取決於【宣告位元組數會不會跨過 255】。**

這是矩陣裡最違反直覺的一項：`VARCHAR(200)`→`VARCHAR(300)` **可以** `INPLACE`（95 ms），
但 `VARCHAR(16)`→`VARCHAR(64)` **不行**。實測把邊界釘出來：

```
utf8mb4（每字元最多 4 bytes）
  VARCHAR(16) → VARCHAR(32)    宣告 128 bytes   ✅ INPLACE
  VARCHAR(16) → VARCHAR(63)    宣告 252 bytes   ✅ INPLACE
  VARCHAR(16) → VARCHAR(64)    宣告 256 bytes   🔴 ERROR 1846
  VARCHAR(16) → VARCHAR(100)   宣告 400 bytes   🔴 ERROR 1846

latin1（每字元 1 byte）
  VARCHAR(16) → VARCHAR(200)   宣告 200 bytes   ✅ INPLACE
  VARCHAR(16) → VARCHAR(255)   宣告 255 bytes   ✅ INPLACE
  VARCHAR(16) → VARCHAR(256)   宣告 256 bytes   🔴 ERROR 1846
```

📌 **邊界正好是 255 個【宣告位元組】。**
原因是 InnoDB 用「1 個位元組」記變長欄位的長度，最多表示 255；
超過就要用 2 個位元組 —— 而**這改變了列的實體格式，所以必須重建整張表**。

```
宣告位元組 = 宣告字元數 × 字元集的最大位元組數
             utf8mb4 → ×4      utf8mb3 → ×3      latin1 → ×1
```

🔴 **重點是「跨過」，不是「大小」**：

```
✅ VARCHAR(200) → VARCHAR(300)   兩邊都 ≥ 256（800 → 1200）   都是 2 bytes → INPLACE
✅ VARCHAR(16)  → VARCHAR(63)    兩邊都 ≤ 255（ 64 →  252）   都是 1 byte  → INPLACE
🔴 VARCHAR(16)  → VARCHAR(64)    從 ≤255 跨到 ≥256            1 → 2 bytes  → COPY
```

⚠️ **這給了 01 章「宣告長度的真實代價」一個新的理由**：
如果你預期一個 `utf8mb4` 的欄位以後可能要加長，
**一開始就宣告成 `VARCHAR(64)` 以上（≥ 256 bytes）**，
之後任何加長都是 `INPLACE` 的 95 毫秒，而不是 5 秒的表重建。

**⑤ 「改表名」有一個例外。**

```
ALTER TABLE ord RENAME TO ord_x, ALGORITHM=INPLACE, LOCK=NONE   → 🔴 ERROR 1845
ALTER TABLE ord RENAME TO ord_x, ALGORITHM=INPLACE              → ✅ 90ms
```

改名一定要短暫地拿到排他鎖（不然別人會用一個不存在的名字），所以它**不接受 `LOCK=NONE`**。
✅ 但它很快（90 ～ 339 ms），而這正是 `pt-osc` 最後那一步 `RENAME TABLE` 的成本（6.7.7）。

---

⚠️ **一件很重要的事：不寫 `ALGORITHM` 的時候，MySQL 選了什麼？**

實測（同一張 100 萬列的表，不指定演算法）：

| 操作 | 不指定的耗時 | 推斷 MySQL 選了 | 是不是最省的選項 |
|---|---|---|---|
| 加欄位（可空、放最後） | 307 ms | `INSTANT` | ✅ |
| 加欄位（指定位置） | 110 ms | `INSTANT` | ✅ |
| 加索引 | 1,467 ms | `INPLACE` | ✅ |
| `VARCHAR(16)`→`VARCHAR(64)` | 8,161 ms | `COPY` | ✅ 只剩這個能選 |
| `INT`→`BIGINT` | 7,649 ms | `COPY` | ✅ 只剩這個能選 |

✅ **MySQL 8.0 選得很準** —— 它總是選最省的可用演算法。

🔴 **那為什麼還要寫 `ALGORITHM`？三個理由**：

```
① 【防呆】：你以為是 INSTANT 的操作，其實會退回 COPY 的 5 秒
     —— 寫上 ALGORITHM=INSTANT，不支援時它會【直接失敗】而不是安靜地跑 5 秒
     這是 6.6.3 第 2 條規則的全部意義

② 【版本差異】：同一句 ALTER 在 8.0.28 是 COPY、在 8.0.29 是 INSTANT
     —— 寫上去，你的腳本才在所有環境有一致的行為

③ 【LOCK=NONE 是明確的意圖宣告】
     —— 不寫 LOCK 時 MySQL 選「最寬鬆的可用鎖」，但那不代表一定是 NONE
```

📌 **實務寫法：把「預期的演算法」寫進去，並在腳本註解裡寫上實測過的耗時。**

```sql
-- V31__add_settle_columns.sql
-- 實測（測試環境 100 萬列）：204 ms
-- 正式環境 ord 約 8,000 萬列 —— INSTANT 與列數無關，預估仍是毫秒級
SET SESSION lock_wait_timeout = 5;          -- 6.7.5

ALTER TABLE ord
  ADD COLUMN settled_at   DATETIME(3) NULL,
  ADD COLUMN settle_batch VARCHAR(32) NULL,
  ALGORITHM=INSTANT;
```

```sql
-- V32__add_settle_index.sql
-- 🔴 INSTANT 不支援加索引（ERROR 1845），用 INPLACE + LOCK=NONE
-- 實測（測試環境 100 萬列）：1,433 ms
-- 正式環境 8,000 萬列 —— 加索引大致線性，預估 2 ~ 5 分鐘
-- 🔴 超過 startupProbe 的 60 秒 → 這個腳本【不能】跟著應用啟動跑（6.10.3）
SET SESSION lock_wait_timeout = 5;

ALTER TABLE ord
  ADD INDEX idx_settle_batch (settle_batch, settled_at),
  ALGORITHM=INPLACE, LOCK=NONE;
```

---

### 6.7.3 `INSTANT` 的三個限制（含 64 次上限）★★

`INSTANT` 看起來是萬靈丹。它有三個限制，其中第三個幾乎沒有人知道。

**限制 1：不是所有操作都支援**（6.7.2 的矩陣）。

**限制 2：`INSTANT` 加的欄位有「行版本」的概念。**

`INSTANT` 之所以能不碰資料檔，是因為它只在中介資料裡記著
「這張表現在有 N 個欄位，而第 N 個欄位是在**版本 v** 加的，舊列讀到它時給預設值」。
所以每一次 `INSTANT` 加/刪欄位，都會讓這張表的**行版本 +1**。

**限制 3（🔴 上限是 64）：** 實測 —— 一張三列的小表，連續用 `INSTANT` 加欄位：

```
第  1 次 → OK
第  2 次 → OK
   ...
第 63 次 → OK
第 64 次 → OK
第 65 次 → 🔴 ERROR 4092 (HY000):
             Maximum row versions reached for table inst/t.
             No more columns can be added or dropped instantly. Please use COPY/INPLACE.
```

```sql
SELECT NAME, TOTAL_ROW_VERSIONS, INSTANT_COLS, N_COLS
FROM information_schema.INNODB_TABLES WHERE NAME LIKE 'inst/%';
```
```
NAME     TOTAL_ROW_VERSIONS  INSTANT_COLS  N_COLS
inst/t   64                  0             68
```

📌 **`TOTAL_ROW_VERSIONS` 到 64 就滿了。** 怎麼歸零？**重建整張表**：

```sql
OPTIMIZE TABLE t;
-- Table does not support optimize, doing recreate + analyze instead
```
```
NAME     TOTAL_ROW_VERSIONS  N_COLS
inst/t   0                   68        ← ✅ 歸零了

-- 之後再 INSTANT 加一個欄位
inst/t   1
```

⚠️ **這個限制在什麼時候會咬你？**

```
一個活躍的專案，一年加 20 個欄位 × 3 年 = 60 次 INSTANT
        ↓
第 65 次 ALTER 突然報 ERROR 4092
        ↓
🔴 而你的遷移腳本寫著 ALGORITHM=INSTANT，於是【它直接失敗】
   （這正是 6.6.3 第 2 條「明確寫出演算法」的好處 ——
     沒寫的話它會安靜地退回 COPY，然後在正式環境跑 5 分鐘）
        ↓
需要一次表重建 —— 而那是 05 章 5.9.2 量過的：
    348 MB 的表重建要 3.2 秒，而且最後會拿 MDL 排他鎖
    正式環境的 8,000 萬列表 → 分鐘級，且不能 LOCK=NONE
```

✅ **兩個實務動作**：

```sql
-- ① 加進資料庫巡檢（每月一次）
SELECT NAME, TOTAL_ROW_VERSIONS, N_COLS
FROM information_schema.INNODB_TABLES
WHERE TOTAL_ROW_VERSIONS > 40
ORDER BY TOTAL_ROW_VERSIONS DESC;
```

```
② 大表的例行維護窗口裡順手重建一次
   （或者用 6.7.6 的 pt-osc 重建 —— 它不需要維護窗口）
```

📌 **`INSTANT` 還有一個細節值得知道**：
它加的欄位在**實體上永遠在最後面**，即使你寫了 `AFTER id`。
`SELECT *` 的欄位順序（邏輯順序）會照你寫的來，
實體位置的差異不影響任何行為 —— 只影響 `TOTAL_ROW_VERSIONS` 會 +1。

---

### 6.7.4 MDL：為什麼 89 ms 的 DDL 會卡住全站 11 秒 ★★（回答 04 章）

這是開場那個實驗的完整版。04 章 4.5.4 講過 MDL 的三層，
這一節把**整個等待隊伍**印出來。

**實驗設計**：

```
A 長交易：SELECT 一列 → 【不 commit】→ sleep 12 秒
              ↓ 1 秒後
B  DDL  ：ALTER TABLE ord ADD COLUMN mdl_test INT NULL, ALGORITHM=INSTANT
              ↓ 1.5 秒後
C0 C1 C2：SELECT COUNT(*) FROM ord WHERE id < 100     ← 平常 1 ms
```

**時間軸**：

```
[t+  258 ms] A 長交易   SELECT 完成，交易【不提交】，持有 ord 的 MDL SHARED_READ
[t+ 1051 ms] B DDL      送出 ALTER ... ALGORITHM=INSTANT
[t+ 2560 ms] C0 查詢    送出 SELECT COUNT(*) FROM ord WHERE id < 100
[t+ 2764 ms] C1 查詢    送出（同一句）
[t+ 2958 ms] C2 查詢    送出（同一句）
[t+12269 ms] A 長交易   commit（放掉 MDL）
[t+12296 ms] C2 查詢    🔴 回來了，等了 9,335 ms
[t+12296 ms] C1 查詢    🔴 回來了，等了 9,529 ms
[t+12296 ms] B DDL      完成，總共花了 11,241 ms
[t+12296 ms] C0 查詢    🔴 回來了，等了 9,733 ms
```

**卡住的時候，`processlist` 長這樣**：

```
id   state                              query                                     time
420  Waiting for table metadata lock    ALTER TABLE ord ADD COLUMN mdl_test ...   4
421  Waiting for table metadata lock    SELECT COUNT(*) FROM ord WHERE id < 100   3
422  Waiting for table metadata lock    SELECT COUNT(*) FROM ord WHERE id < 100   2
423  Waiting for table metadata lock    SELECT COUNT(*) FROM ord WHERE id < 100   2
```

**而 `performance_schema.metadata_locks` 是完整的答案**：

```sql
SELECT OBJECT_NAME, LOCK_TYPE, LOCK_STATUS, OWNER_THREAD_ID
FROM performance_schema.metadata_locks
WHERE OBJECT_SCHEMA = 'ddl' AND OBJECT_NAME = 'ord';
```

```
OBJECT_NAME  LOCK_TYPE          LOCK_STATUS  OWNER_THREAD_ID
ord          SHARED_READ        GRANTED      596     ← A 長交易，持有共享讀鎖
ord          SHARED_UPGRADABLE  GRANTED      597     ← B DDL，先拿到「可升級」鎖
ord          EXCLUSIVE          PENDING      597     ← B DDL，等著升級成【排他】
ord          SHARED_READ        PENDING      598     ← C0 排在 B 後面
ord          SHARED_READ        PENDING      599     ← C1
ord          SHARED_READ        PENDING      600     ← C2
```

🔴 **這六列就是整個故事**：

```
① A 持有 SHARED_READ（因為交易還沒 commit）
② B 想要 EXCLUSIVE → 與 A 的 SHARED_READ 衝突 → PENDING
③ C0/C1/C2 想要 SHARED_READ —— 它跟 A 的 SHARED_READ 【完全不衝突】
   但 MDL 的隊伍是【先進先出】的，B 排在它們前面
   → 🔴 C 們被 B 卡住，而 B 被 A 卡住
```

📌 **這叫「隊頭阻塞」（head-of-line blocking）。**
它的三個特徵，每一個都很反直覺：

```
① 一個【只讀了一列】的未提交交易，可以讓一句 DDL 無限期等待
② 那句 DDL 是 ALGORITHM=INSTANT 也沒用 —— MDL 在演算法【之前】
③ 🔴 真正的傷害不是 DDL 慢，是【它後面所有人都跟著慢】
     —— 而那些查詢與 DDL、與長交易都毫無關係
```

⚠️ **為什麼這在正式環境特別容易變成事故？**

```
你的服務有 100 QPS 的讀取 → 每 10 ms 就有一個新的 SELECT 進來
        ↓
DDL 一旦開始 PENDING，10 ms 後就有第一個受害者
        ↓
30 秒之後，3,000 個查詢排在隊伍裡
        ↓
🔴 連線池滿了 → 應用端拿不到連線 → 整個服務 5xx
        ↓
🔴 而監控上看起來是「連線池耗盡」，不是「有人在改 schema」
```

**這就是「一個 `ALTER TABLE` 卡住全站」的完整機制**（04 章 4.5.4 欠的帳）。

---

📌 **排查用的三句查詢**（背下來，正式環境會用到）：

```sql
-- ① 誰在等 MDL？
SELECT id, user, state, LEFT(info, 60) AS query, time
FROM information_schema.processlist
WHERE state = 'Waiting for table metadata lock'
ORDER BY time DESC;
```

```sql
-- ② 誰是【源頭】的那個長交易？（不是等待者，是持有者）
SELECT trx_id, trx_state, trx_started,
       TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS secs,
       trx_mysql_thread_id, trx_query
FROM information_schema.innodb_trx
ORDER BY trx_started;
-- 🔴 注意 trx_query 常常是 NULL —— 因為那個交易【現在什麼都沒在跑】，
--    它只是還沒 commit。這正是最難查的情況。
```

```sql
-- ③ 完整的 MDL 隊伍
SELECT ml.OBJECT_SCHEMA, ml.OBJECT_NAME, ml.LOCK_TYPE, ml.LOCK_STATUS,
       t.PROCESSLIST_ID, t.PROCESSLIST_TIME, LEFT(t.PROCESSLIST_INFO, 50) AS q
FROM performance_schema.metadata_locks ml
JOIN performance_schema.threads t ON t.THREAD_ID = ml.OWNER_THREAD_ID
WHERE ml.OBJECT_TYPE = 'TABLE'
ORDER BY ml.OBJECT_NAME, ml.LOCK_STATUS DESC;
```

⚠️ **③ 需要 MDL 的 instrument 是開著的（MySQL 8.0 預設開，但值得確認）**：

```sql
SELECT NAME, ENABLED FROM performance_schema.setup_instruments
WHERE NAME = 'wait/lock/metadata/sql/mdl';

-- 沒開的話：
UPDATE performance_schema.setup_instruments
SET ENABLED = 'YES', TIMED = 'YES'
WHERE NAME = 'wait/lock/metadata/sql/mdl';
-- 🔴 這個 UPDATE 重啟後失效，要寫進 my.cnf：
--    performance-schema-instrument='wait/lock/metadata/sql/mdl=ON'
```

---

### 6.7.5 `lock_wait_timeout`：讓 DDL 自己失敗，而不是堵住隊伍

上一節的問題是「DDL 無限期等待，並拖住後面所有人」。
解法出乎意料地簡單：**讓 DDL 自己放棄**。

```sql
SELECT @@lock_wait_timeout;
```
```
31536000        ← 🔴 31,536,000 秒 = 365 天
```

📌 **`lock_wait_timeout` 的預設值是一年 —— 等於「永不逾時」。**

⚠️ **不要跟 `innodb_lock_wait_timeout` 搞混**（04 章講過後者）：

| 變數 | 管什麼 | 預設 |
|---|---|---|
| `lock_wait_timeout` | **MDL**（中介資料鎖，DDL 用的） | **31,536,000（一年）** |
| `innodb_lock_wait_timeout` | **行鎖**（InnoDB 的資料鎖） | 50 秒 |

**實測**：有一個長交易在跑，把 DDL 的 `lock_wait_timeout` 設成 2 秒。

```sql
SET SESSION lock_wait_timeout = 2;
ALTER TABLE ord ADD COLUMN mdl_test INT NULL, ALGORITHM=INSTANT;
```
```
ERROR 1205 (HY000): Lock wait timeout exceeded; try restarting transaction
耗時 2,148 ms
```

**DDL 失敗之後，後面的查詢還會被堵嗎？**

```sql
SELECT COUNT(*) FROM ord WHERE id < 100;    -- 長交易【還在跑】
```
```
99
查詢耗時 105 ms       ← ✅ 沒有被堵
```

✅ **DDL 自己放棄之後，隊伍立刻疏通了。**

📌 **所以正式環境的每一個 DDL 腳本，第一行都應該是這個**：

```sql
-- 🔴 拿不到 MDL 就【快速失敗】，不要拖住線上流量
SET SESSION lock_wait_timeout = 5;
```

⚠️ **`SET SESSION` 在 Flyway 裡有效嗎？** 有 ——
Flyway 用**同一條連線**執行一個腳本裡的所有語句，
所以 `SET SESSION` 對後面的語句生效。

✅ **但更可靠的做法是設在連線層級**，這樣每一個遷移都自動有保護：

```yaml
# application.yml
spring:
  flyway:
    # Flyway 專用的連線（跟應用的連線池分開，見 6.10.2）
    url: jdbc:mysql://db:3306/shop
    user: shop_migrate
    password: ${MIGRATE_PASSWORD}
    init-sqls:
      - SET SESSION lock_wait_timeout = 5
      - SET SESSION innodb_lock_wait_timeout = 5
```

🔴 **設成 5 秒之後，DDL 會「常常失敗」—— 這是預期行為，不是問題。**
你要做的是**讓失敗變得便宜**：

```
① 遷移用獨立的 Job（6.10.3），失敗就重試，不影響應用啟動
② 重試三次還是失敗 → 告警 → 人去查「誰有長交易」（6.7.4 的第 ② 句查詢）
③ 🔴 真正的修法是【消滅長交易】—— 那是 04 章的功課
```

📌 **一個常被忽略的長交易來源**：
只要有人在一個交易裡 `SELECT` 過一次而沒有 `commit`，那條連線就一直持有 MDL。
`@Transactional(readOnly = true)` 也一樣 —— **唯讀交易照樣持有 `SHARED_READ`**。

```sql
-- 巡檢：有沒有「開著但什麼都沒在做」的交易？
SELECT trx_id, TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS idle_secs,
       trx_mysql_thread_id, trx_query
FROM information_schema.innodb_trx
WHERE trx_query IS NULL                     -- 沒有正在執行的語句
  AND TIMESTAMPDIFF(SECOND, trx_started, NOW()) > 5
ORDER BY trx_started;
```

---

### 6.7.6 原生 `INPLACE` vs `COPY` vs `pt-osc`：三方實測 ★★

前面的矩陣量的是「DDL 自己花多久」。
但正式環境真正在意的是另一個數字：**線上服務被停頓多久**。

**實驗設計**：

```
表      ：ord，1,000,000 列，135.7 MB
變更    ：ADD COLUMN osc_col INT NULL, ADD INDEX idx_osc (status)
線上流量：一條連線持續跑「INSERT 一列 + UPDATE 一列」，每次之間 sleep 5 ms
量測    ：① DDL 總耗時  ② 🔴 線上寫入的【最長單次停頓】  ③ 寫入失敗次數
```

**三種做法的結果**：

| 做法 | DDL 總耗時 | 🔴 **線上寫入最長停頓** | 寫入失敗 |
|---|---|---|---|
| 原生 `ALTER`，`ALGORITHM=INPLACE, LOCK=NONE` | 6,414 ms | ✅ **33 ms** | 0 |
| 原生 `ALTER`，`ALGORITHM=COPY` | 5,621 ms | 🔴 **5,526 ms** | 0 |
| `pt-online-schema-change`（chunk 5000，不 sleep） | 10,221 ms | ✅ **122 ms** | 0 |
| `pt-online-schema-change`（chunk 2000，`--sleep 0.05`） | 36,000 ms | ✅ **52 ms** | 0 |

📌 **三個結論**：

**① `COPY` 的停頓 ≈ 它的總耗時（5,526 ≈ 5,621）。**
🔴 也就是說：**`ALGORITHM=COPY` 在它跑的整段時間裡，寫入是完全停住的。**

這解釋了為什麼 6.7.2 矩陣裡 `COPY` 那一欄**沒有 `LOCK=NONE` 的選項** ——
`COPY` 建一張新表、把資料一列一列搬過去，
搬的期間如果允許別人改原表，新表就永遠追不上。
所以 `COPY` 至少要 `LOCK=SHARED`（可讀不可寫）。

⚠️ **對照 MySQL 5.6 之前：所有 `ALTER` 都是 `COPY`。**
「改 schema 要停機維護」這個習慣就是從那個時代來的。

**② 原生 `INPLACE, LOCK=NONE` 是最好的選項 —— 只要它支援。**

```
6,414 ms 的 DDL，線上寫入只停頓 33 ms
    ↑ 那 33 ms 是 6.7.1 的「最後再拿一次 MDL 排他鎖」
```

✅ **它比 `pt-osc` 快 1.6 ～ 5.6 倍，而且停頓更短。**
📌 **所以決策樹的第一步永遠是「原生的 `INPLACE, LOCK=NONE` 支不支援？」**

**③ `pt-osc` 存在的唯一理由：`INPLACE` 不支援的那些操作。**

回頭看 6.7.2 的矩陣，`INPLACE` 不支援的有五類：

```
🔴 VARCHAR 縮短
🔴 INT → BIGINT（以及所有改型別）
🔴 DATETIME 精度變更
🔴 改字元集 / 定序（CONVERT TO）
🔴 加 STORED 生成欄位
```

**這五類原生只剩 `COPY`，也就是「線上寫入停 5.5 秒」（100 萬列）。**
換算到正式環境的 8,000 萬列 —— **大約 7 分鐘的寫入中斷**。

✅ **這時候 `pt-osc` 就值得那 1.6 倍的時間成本**：
它讓同一件事變成「總共跑 10 分鐘，但每次停頓只有 122 ms」。

---

### 6.7.7 `pt-online-schema-change` 的完整機制與五個代價

**先看它真的做了什麼。** 執行：

```bash
pt-online-schema-change \
  --alter "ADD COLUMN osc_col INT NULL, ADD INDEX idx_osc (status)" \
  --host 127.0.0.1 --port 3306 --user root --password root \
  D=ddl,t=ord \
  --chunk-size 2000 \
  --max-load Threads_running=50 \
  --execute
```

**它下的 SQL（`--print` 的完整輸出）**：

```sql
-- ① 建一張「影子表」，結構跟原表一樣
CREATE TABLE `ddl`.`_ord_new` LIKE `ddl`.`ord`;

-- ② 在影子表上做你要的變更（這時它是空的，所以【多久都不痛】）
ALTER TABLE `ddl`.`_ord_new` ADD COLUMN osc_col INT NULL, ADD INDEX idx_osc (status);

-- ③ 在原表上建三個觸發器，把之後的所有變更同步到影子表
CREATE TRIGGER `pt_osc_ddl_ord_ins` AFTER INSERT ON `ddl`.`ord` FOR EACH ROW
BEGIN
  DECLARE CONTINUE HANDLER FOR 1146 begin end;
  REPLACE INTO `ddl`.`_ord_new` (`id`, `order_no`, `customer_id`, `status`,
                                 `total_amount`, `placed_at`, `remark`)
  VALUES (NEW.`id`, NEW.`order_no`, NEW.`customer_id`, NEW.`status`,
          NEW.`total_amount`, NEW.`placed_at`, NEW.`remark`);
END

CREATE TRIGGER `pt_osc_ddl_ord_upd` AFTER UPDATE ON `ddl`.`ord` FOR EACH ROW
BEGIN
  DECLARE CONTINUE HANDLER FOR 1146 begin end;
  DELETE IGNORE FROM `ddl`.`_ord_new`
    WHERE !(OLD.`id` <=> NEW.`id`) AND `ddl`.`_ord_new`.`id` <=> OLD.`id`;
  REPLACE INTO `ddl`.`_ord_new` (...) VALUES (NEW....);
END

CREATE TRIGGER `pt_osc_ddl_ord_del` AFTER DELETE ON `ddl`.`ord` FOR EACH ROW
BEGIN
  DECLARE CONTINUE HANDLER FOR 1146 begin end;
  DELETE IGNORE FROM `ddl`.`_ord_new` WHERE `ddl`.`_ord_new`.`id` <=> OLD.`id`;
END

-- ④ 分塊把舊資料搬過去（每塊 2000 列，用主鍵當游標 —— 6.6.5 的 seek 法）
INSERT LOW_PRIORITY IGNORE INTO `ddl`.`_ord_new` (`id`, `order_no`, ...)
SELECT `id`, `order_no`, ... FROM `ddl`.`ord` FORCE INDEX(`PRIMARY`)
WHERE ((`id` >= ?)) AND ((`id` <= ?)) LOCK IN SHARE MODE
/*pt-online-schema-change 1 copy nibble*/

SELECT /*!40001 SQL_NO_CACHE */ `id` FROM `ddl`.`ord` FORCE INDEX(`PRIMARY`)
WHERE ((`id` >= ?)) ORDER BY `id` LIMIT ?, 2 /*next chunk boundary*/

-- ⑤ 原子換名（這一步是唯一的停頓，實測 90 ~ 339 ms —— 6.7.2 的「改表名」）
RENAME TABLE `ddl`.`ord` TO `ddl`.`_ord_old`, `ddl`.`_ord_new` TO `ddl`.`ord`;

-- ⑥ 收尾
DROP TABLE IF EXISTS `ddl`.`_ord_old`;
DROP TRIGGER IF EXISTS `ddl`.`pt_osc_ddl_ord_del`;
DROP TRIGGER IF EXISTS `ddl`.`pt_osc_ddl_ord_upd`;
DROP TRIGGER IF EXISTS `ddl`.`pt_osc_ddl_ord_ins`;
```

**進行中的資料庫狀態**（在 `pt-osc` 跑到一半時查）：

```sql
SELECT table_name, table_rows, ROUND(data_length/1024/1024,1) AS mb
FROM information_schema.tables WHERE table_schema = 'ddl';
```
```
TABLE_NAME  TABLE_ROWS  mb
_ord_new    994220      73.6      ← 🔴 影子表，正在長大
ord         991816      135.7     ← 原表，還在服務
seq         1000        0.0
```

```sql
SELECT trigger_name, event_manipulation FROM information_schema.triggers
WHERE trigger_schema = 'ddl';
```
```
TRIGGER_NAME              EVENT_MANIPULATION
pt_osc_ddl_ord_del        DELETE
pt_osc_ddl_ord_upd        UPDATE
pt_osc_ddl_ord_ins        INSERT
```

---

🔴 **五個代價，每一個都要在上線前算過**：

**代價 1：磁碟空間要兩倍。**

```
ord 135.7 MB + 索引 85.2 MB = 220.9 MB
影子表最終也是 ~220 MB
→ 🔴 整個過程需要【額外 220 MB】的可用空間
→ 正式環境的 8,000 萬列表：原表 20 GB → 需要 20 GB 空閒
```

⚠️ **`OPTIMIZE TABLE` 也有一樣的要求**（05 章 5.9.2）。
**上線前先看 `df -h`。**

**代價 2：所有寫入都變成兩倍的工作。**

每一個 `INSERT` 都會觸發 trigger 再 `REPLACE INTO` 影子表。
實測期間線上寫入沒有失敗，但吞吐量會下降 —— 而**下降多少取決於你的寫入量**。

⚠️ 更精確地說：`UPDATE` 的 trigger 是 `DELETE IGNORE` **加** `REPLACE INTO` ——
**一次 `UPDATE` 變成三個操作**。

**代價 3：原表不能已經有觸發器。**

MySQL 5.7 之前一張表的同一個事件只能有一個觸發器。
MySQL 8.0 可以有多個，但 `pt-osc` 預設仍會拒絕：

```
The table `ddl`.`ord` has triggers. This tool needs to create its own triggers,
so the table cannot already have triggers.
```

要強制的話有 `--preserve-triggers`，但**風險自負** ——
你自己的觸發器會在影子表上被重建，執行順序無法保證。

**代價 4：外鍵是一場惡夢。**

原表被 `RENAME` 掉之後，指向它的外鍵要怎麼辦？`pt-osc` 有兩個策略：

```
--alter-foreign-keys-method=rebuild_constraints
    → 對每一張【引用這張表的子表】下 ALTER TABLE 重建外鍵
    → 🔴 子表也要重建一次（子表很大的話，這是另一個 COPY）

--alter-foreign-keys-method=drop_swap
    → DROP 原表 + RENAME 影子表
    → 🔴 這中間有一段【表不存在】的時間，而且不是原子的
```

📌 **這是「正式環境要不要用外鍵」這個老問題的一個實際論點**
（大型 MySQL 系統常常在應用層做參照完整性，理由之一就是這個）。

**代價 5：它不知道你的業務語意。**

```
🔴 pt-osc 的 chunk 是按【主鍵範圍】切的
   → 主鍵不連續（大量刪除過、或用 UUID）時，chunk 大小會劇烈波動
   → --chunk-size 是「目標」，不是保證

🔴 --max-load 只看 SHOW GLOBAL STATUS 的計數器
   → 它不知道「現在是雙十一的尖峰」
   → 要自己配 --critical-load 與時間窗口
```

---

✅ **一組實務上可用的參數**：

```bash
pt-online-schema-change \
  --alter "MODIFY customer_id BIGINT NOT NULL" \
  --host $DB_HOST --port 3306 --user $MIGRATE_USER --ask-pass \
  D=shop,t=ord \
  \
  --chunk-size 1000 \                  `# 小一點，換更短的停頓（6.6.5 的結論）` \
  --chunk-time 0.5 \                   `# 或者讓它自己調整到每塊 0.5 秒` \
  --sleep 0.05 \                       `# 每塊之間讓路` \
  \
  --max-load "Threads_running=40" \    `# 超過就暫停（等於 6.6.5 的負載出口）` \
  --critical-load "Threads_running=100" \  `# 超過就【放棄】` \
  --max-lag 2 \                        `# 從庫延遲超過 2 秒就暫停（07 章）` \
  \
  --set-vars "lock_wait_timeout=5,innodb_lock_wait_timeout=5" \
  --no-drop-old-table \                `# 🔴 換名後【保留】舊表，確認沒事再手動刪` \
  \
  --dry-run                            `# 🔴 第一次永遠先 dry-run`
```

⚠️ **`--no-drop-old-table` 是我最推薦的一個參數。**
它讓 `_ord_old` 留下來 —— 於是**你有一個「換回去」的選項**：

```sql
-- 發現新表有問題（例如漏了一個索引）時的緊急回退
RENAME TABLE `shop`.`ord` TO `shop`.`_ord_bad`,
             `shop`.`_ord_old` TO `shop`.`ord`;
```

🔴 **但要注意：`_ord_old` 停在 `RENAME` 那一刻的狀態。**
換回去之後，`RENAME` 之後寫進新表的資料**會不見**。
所以這個回退只有在「換名後幾秒內立刻發現問題」時才可用 ——
而這正好是「上線後立刻做煙霧測試」的價值。

---

### 6.7.8 `gh-ost` 差在哪

`gh-ost`（GitHub 出的）解決的是 `pt-osc` 的**代價 2 與代價 3**：**它不用觸發器。**

```
pt-osc ：原表的每一次寫入 → 觸發器 → 同步寫影子表
             🔴 在【原表的交易裡】多做工作 → 直接影響線上寫入的延遲

gh-ost ：原表的每一次寫入 → 寫進 binlog（本來就會寫）
             → gh-ost 把自己【偽裝成一個從庫】，讀 binlog
             → 在【自己的行程裡】把變更套用到影子表
             ✅ 原表的交易完全不知道 gh-ost 存在
```

📌 **這個差別帶來三個實際的好處**：

```
✅ 線上寫入的延遲不受影響（不多做任何工作）
✅ 可以在【從庫】上做整個遷移，主庫完全不碰
     （--migrate-on-replica / --test-on-replica）
✅ 可以【暫停與恢復】—— 因為狀態在 gh-ost 自己手上
     （改一個檔案就暫停：--postpone-cut-over-flag-file）
     🔴 pt-osc 一旦中斷就要從頭開始
```

🔴 **代價是它的前置要求比較嚴**：

```
🔴 必須 binlog_format = ROW（pt-osc 不需要）
🔴 必須有 REPLICATION SLAVE 權限
🔴 不支援外鍵（完全不支援，不像 pt-osc 有兩個爛策略）
🔴 不支援原表已有觸發器
```

⚠️ **本章沒有實測 `gh-ost`** ——
它沒有官方的 Docker 映像，而在本機用單一 MySQL 容器跑
「偽裝成從庫讀 binlog」的完整路徑，量出來的數字對正式環境沒有參考價值
（05 章講過：本機的 SSD 與 localhost 是這類實測最大的敵人）。
**上面的機制描述來自它的文件與程式碼，不是本章的量測結果。**

📌 **實務選擇**：

| 情況 | 選什麼 |
|---|---|
| 原生 `INPLACE, LOCK=NONE` 支援 | ✅ **原生**（最快、停頓最短、不用裝東西） |
| 不支援，但表不大（< 100 萬列）且有維護窗口 | ✅ 原生 `COPY`（幾秒鐘的寫入停頓可接受） |
| 不支援，表很大，有外鍵 | 🟡 `pt-osc` + `rebuild_constraints`（`gh-ost` 不支援外鍵） |
| 不支援，表很大，沒有外鍵 | ✅ **`gh-ost`**（不影響線上寫入延遲，可暫停恢復） |
| 用雲端託管的 MySQL（RDS / Cloud SQL） | ⚠️ 先確認有沒有 `REPLICATION SLAVE` 權限；沒有就只能 `pt-osc` |

---

### 6.7.9 分區：另一條路（回答 05 章 5.9.2）

05 章 5.9.2 量到「刪掉 38.6% 的列之後，檔案 348 MB → 348 MB，完全沒變」，
並說「分區 `DROP` 是最好的選項，06 章會講」。**這一節就是那筆帳。**

**建一張按月分區的訂單表**：

```sql
CREATE TABLE ord_p (
  id        BIGINT AUTO_INCREMENT,
  order_no  VARCHAR(32)   NOT NULL,
  amount    DECIMAL(19,4) NOT NULL,
  placed_at DATETIME(3)   NOT NULL,
  remark    VARCHAR(200)  NULL,
  PRIMARY KEY (id, placed_at),          -- 🔴 分區鍵必須在主鍵裡（見下方限制 1）
  KEY idx_placed (placed_at)
) ENGINE=InnoDB
PARTITION BY RANGE COLUMNS(placed_at) (
  PARTITION p202601 VALUES LESS THAN ('2026-02-01'),
  PARTITION p202602 VALUES LESS THAN ('2026-03-01'),
  PARTITION p202603 VALUES LESS THAN ('2026-04-01'),
  PARTITION p202604 VALUES LESS THAN ('2026-05-01'),
  PARTITION pmax    VALUES LESS THAN (MAXVALUE)
);
```

```
PARTITION_NAME  TABLE_ROWS  mb
p202601         256158      32.6
p202602         231966      29.6
p202603         256536      32.6
p202604         247968      31.6
pmax            0           0.0
```

**實測：刪掉一整個月**

| 做法 | 列數 | 耗時 | 🔴 **實體檔案** |
|---|---|---|---|
| `ALTER TABLE ord_p DROP PARTITION p202601` | 256,158 | ✅ **132 ms** | ✅ **205 MB → 153 MB** |
| `DELETE FROM ord_p WHERE placed_at < '2026-03-01'` | 231,966 | 712 ms | 🔴 **153 MB → 153 MB** |

📌 **`DROP PARTITION` 有兩個 `DELETE` 給不了的東西**：

```
✅ 快 5.4 倍（132 ms vs 712 ms）—— 它只是刪掉一個檔案，不是刪 25 萬列
✅ 🔴 【空間真的回來了】—— 這是 05 章 5.9.2 那個問題的唯一乾淨解法
     （不需要 OPTIMIZE TABLE、不需要等量的臨時空間、不需要 MDL 排他鎖）
```

⚠️ **`DROP PARTITION` 的代價**：它會拿 MDL 排他鎖（132 ms），
所以還是要配 `lock_wait_timeout`（6.7.5）。但 132 ms 比 `OPTIMIZE TABLE` 的分鐘級好太多。

---

**分區裁剪：`EXPLAIN` 的 `partitions` 欄位**

```sql
EXPLAIN SELECT COUNT(*) FROM ord_c
WHERE placed_at >= '2026-03-01' AND placed_at < '2026-04-01';
```
```
partitions: p202603              ← ✅ 只掃一個分區
       key: idx_placed
      rows: 1
```

⚠️ **`RANGE (TO_DAYS(placed_at))` 的裁剪【不乾淨】。** 同一句查詢：

```
PARTITION BY RANGE (TO_DAYS(placed_at))     → partitions: p202602,p202603   🟡 多掃一個
PARTITION BY RANGE COLUMNS(placed_at)       → partitions: p202603           ✅ 精確
```

📌 **所以按時間分區，用 `RANGE COLUMNS(datetime_col)`，不要用 `RANGE(TO_DAYS(...))`。**
（`TO_DAYS()` 丟掉了時間部分，所以邊界判斷會保守地多納入一個分區。）

🔴 **而如果查詢條件不含分區鍵，就完全沒有裁剪**：

```sql
EXPLAIN SELECT COUNT(*) FROM ord_c WHERE order_no = 'NO000000123456';
```
```
partitions: p202601,p202602,p202603,p202604,pmax     ← 🔴 五個分區全掃
       key: NULL
```

---

🔴 **分區的兩個硬限制，決定了你能不能用它**：

**限制 1：所有唯一索引（含主鍵）都必須包含分區鍵。**

```sql
ALTER TABLE ord_c ADD UNIQUE KEY uk_order_no (order_no);
```
```
ERROR 1503 (HY000): A UNIQUE INDEX must include all columns in the table's
partitioning function (prefixed columns are not considered).
```

```sql
ALTER TABLE ord_c ADD UNIQUE KEY uk_order_no (order_no, placed_at);   -- ✅ 成功
```

⚠️ **這幾乎總是一個致命傷**，因為它改變了業務約束：

```
你想要的     ：order_no 全表唯一
你只能得到的 ：(order_no, placed_at) 唯一
             → 🔴 同一個 order_no 可以在【不同的 placed_at】出現兩次
             → 唯一性必須改到應用層保證（而那就不是資料庫的保證了）
```

**限制 2：分區表不能有外鍵。**

```sql
ALTER TABLE ord_c ADD CONSTRAINT fk_c FOREIGN KEY (cust_id) REFERENCES cust(id);
```
```
ERROR 1506 (HY000): Foreign keys are not yet supported in conjunction with partitioning
```

📌 **注意 `not yet` 這兩個字從 MySQL 5.1 就在那裡了。**

---

✅ **分區適合的場景，只有一個典型**：

```
「按時間寫入、按時間查詢、按時間刪除」的表

     ✅ 事件日誌、審計軌跡、指標樣本、通知紀錄
     ✅ 每天 / 每月一個分區，保留 N 期，用 DROP PARTITION 清舊資料
     ✅ 查詢一定帶時間範圍（所以裁剪有效）
     ✅ 沒有「跨期唯一」的業務約束（所以限制 1 不痛）
     ✅ 沒有外鍵（所以限制 2 不痛）
```

🔴 **不適合的場景（也就是大部分的業務主表）**：

```
🔴 訂單表：order_no 要全表唯一（限制 1）、要關聯客戶（限制 2）
🔴 使用者表：沒有天然的時間分區鍵
🔴 查詢五花八門、常常不帶分區鍵的表（沒有裁剪 = 分區只帶來管理成本）
```

📌 **分區的維護要自動化。** 一個常見的做法是每月一次的排程作業：

```sql
-- 加下個月的分區（要在 pmax 之前 REORGANIZE）
ALTER TABLE ord_p REORGANIZE PARTITION pmax INTO (
  PARTITION p202605 VALUES LESS THAN ('2026-06-01'),
  PARTITION pmax    VALUES LESS THAN (MAXVALUE)
);

-- 刪掉 13 個月前的分區
ALTER TABLE ord_p DROP PARTITION p202504;
```

⚠️ **`REORGANIZE PARTITION pmax` 會重建 `pmax` 這一個分區的資料。**
所以要保持 `pmax` 是空的 —— 也就是**分區要提前建好**，
不要等到有資料掉進 `pmax` 才補。

🔴 **這個排程作業【不該】放在 Flyway 裡** ——
它是週期性的維護動作，不是一次性的版本變更。
放進 Flyway 會變成「每個月新增一個 V 腳本」，而它們對新環境毫無意義。

---

### 6.7.10 一份「上線改 schema」的決策樹

把 6.7 整節收斂成一張圖：

```
                        我要改一張表的 schema
                                 │
                    ┌────────────┴────────────┐
                    │ 這張表有多少列？        │
                    └────────────┬────────────┘
                                 │
         ┌───────────────────────┼───────────────────────┐
         │ < 10 萬列              │ 10 萬 ~ 1000 萬        │ > 1000 萬
         ↓                       ↓                       ↓
   ✅ 直接 ALTER            繼續往下                繼續往下
   （最壞也是幾秒）         （但要寫 ALGORITHM）      （而且要準備 pt-osc/gh-ost）
                                 │
                    ┌────────────┴────────────┐
                    │ 先確認 MySQL 版本       │
                    │ SELECT VERSION();       │
                    │ < 8.0.29 → 刪欄位與指定 │
                    │ 位置加欄位不能 INSTANT  │
                    └────────────┬────────────┘
                                 │
        ┌────────────────────────┴────────────────────────┐
        │ 在【測試環境】用同樣的資料量試三次：            │
        │   ① ALGORITHM=INSTANT              → 成功就用它 │
        │   ② ALGORITHM=INPLACE, LOCK=NONE   → 成功就用它 │
        │   ③ 都 ERROR 1845 / 1846           → 往下       │
        └────────────────────────┬────────────────────────┘
                                 │
                    ┌────────────┴────────────┐
                    │ 只剩 COPY。可以接受     │
                    │「寫入停頓 ≈ ALTER 耗時」│
                    │ 嗎？（6.7.6 實測 5.5s   │
                    │  / 100 萬列）           │
                    └────────────┬────────────┘
                         ┌───────┴───────┐
                    可以 │               │ 不可以
                         ↓               ↓
              ✅ 維護窗口 + COPY    ┌──────────────────┐
                                    │ 有外鍵嗎？        │
                                    └────────┬─────────┘
                                     ┌───────┴───────┐
                                  有 │               │ 沒有
                                     ↓               ↓
                            🟡 pt-osc          ✅ gh-ost
                       (rebuild_constraints)   （或 pt-osc）
```

⚠️ **決策樹之外的四個「先問一下」**：

```
① 這個變更是【不可逆】的嗎？（改型別、縮短長度、刪欄位）
     → 是 → 走 6.8 的 expand-contract，不要一步到位

② 這張表可以【改成分區表】嗎？（6.7.9）
     → 如果變更的目的是「刪舊資料」，分區才是正解，不是 ALTER

③ 這個變更真的必要嗎？
     → 「加一個欄位存 JSON 的某個屬性」也許可以用生成欄位（VIRTUAL，141 ms）
       而不是加真欄位 + 回填（05 章 X3）

④ 🔴 這張表的 TOTAL_ROW_VERSIONS 是多少？（6.7.3）
     → 已經 60 幾了 → 這次的 INSTANT 會失敗，要先排一次表重建
```

---

## 6.8 不可回滾的變更：expand-contract ★★

### 6.8.1 為什麼「回滾腳本」是幻覺

很多團隊的規範是：**「每個遷移都要附一個回滾腳本」**。
這個規範聽起來很負責，實際上有三個問題。

**問題 1：一半的操作寫不出正確的回滾腳本。**

| 遷移 | 「回滾腳本」 | 它真的回滾了嗎 |
|---|---|---|
| `ADD COLUMN status` | `DROP COLUMN status` | ✅ 是 |
| `ADD INDEX idx_x` | `DROP INDEX idx_x` | ✅ 是 |
| `DROP COLUMN remark` | `ADD COLUMN remark VARCHAR(200)` | 🔴 **欄位回來了，資料沒有** |
| `MODIFY amount DOUBLE` | `MODIFY amount DECIMAL(19,4)` | 🔴 **型別回來了，精度沒有** |
| `MODIFY c VARCHAR(20)`（縮短） | `MODIFY c VARCHAR(120)` | 🔴 **長度回來了，被截斷的字沒有** |
| `UPDATE ord SET status = 'X' WHERE ...` | ？ | 🔴 **原值已經沒有地方記著了** |
| `DROP TABLE tmp_x` | `CREATE TABLE tmp_x (...)` | 🔴 **表回來了，資料沒有** |

🔴 **後五種的「回滾腳本」只回滾了 schema，沒有回滾資料。**
而在資料庫的世界裡，**schema 對了但資料沒了，比什麼都沒做更糟** ——
因為它看起來成功了。

**問題 2：回滾腳本從來沒有被測試過。**

```
遷移腳本  ：每次部署都跑一次，跑過幾百次
回滾腳本  ：🔴 只在「出事的那一天、半夜三點、大家很緊張」的時候第一次執行
```

**問題 3（最根本的）：真正的問題不是資料庫，是「新舊程式碼同時在跑」。**

```
滾動部署（rolling deployment）的中間狀態：

    Pod 1  舊版程式碼 v1.4  ┐
    Pod 2  舊版程式碼 v1.4  ├─→ 同一個資料庫
    Pod 3  新版程式碼 v1.5  ┘
                              ↑
              🔴 這個資料庫的 schema 必須【同時】讓 v1.4 和 v1.5 都能跑
```

**而這個狀態不是意外，是滾動部署的必然。**
它至少會持續幾分鐘（部署時間），而如果新版要回退，可能持續幾小時。

📌 **所以正確的目標不是「準備回滾」，而是**：

> **讓每一次 schema 變更都【向後相容】——
> 也就是「舊版程式碼在新 schema 上照樣能跑」。**

✅ **這樣就不需要回滾 schema 了** ——
出事的時候只要把**程式碼**滾回上一版（那是 `kubectl rollout undo`，幾秒鐘），
資料庫**維持在新狀態**。

**這個做法叫 expand-contract（擴張—收縮），或者 parallel change。**

---

### 6.8.2 先看兩個具體的相容性陷阱

在講流程之前，先看兩個**實測過的**破壞相容性的方式 ——
它們是整節規則的來源。

**陷阱 1：加一個 `NOT NULL` 且沒有 `DEFAULT` 的欄位。**

```sql
-- 這句 ALTER 【會成功】
ALTER TABLE ord ADD COLUMN note VARCHAR(200) NOT NULL, ALGORITHM=INSTANT;
```

已有的列會拿到「隱式預設值」（`VARCHAR` 是空字串）：

```
id  order_no  remark   note
1   A1        舊備註   （空字串）
```

**但舊版程式碼的 `INSERT` 立刻死掉**：

```sql
-- 舊版程式碼一直在下的這句（它不知道 note 存在）
INSERT INTO ord (order_no, remark) VALUES ('A2', 'x');
```
```
🔴 ERROR 1364 (HY000): Field 'note' doesn't have a default value
```

⚠️ **注意這個不對稱**：

```
ALTER  → ✅ 成功（舊列填隱式預設值）
INSERT → 🔴 失敗（嚴格模式下不接受「沒有 DEFAULT 又沒給值」）
```

📌 **所以這個變更的失敗時機是「部署完成之後的第一次寫入」** ——
遷移的日誌是綠色的，`flyway_schema_history` 是 `success = 1`，
然後三十秒後所有的下單 API 開始 500。

（這裡的行為取決於 `sql_mode` 含 `STRICT_TRANS_TABLES`，
而那是 MySQL 8.0 的預設值 —— 00 章 0.6 講過。）

✅ **修法是加 `DEFAULT`**：

```sql
ALTER TABLE ord ADD COLUMN note VARCHAR(200) NOT NULL DEFAULT '', ALGORITHM=INSTANT;
```
```sql
INSERT INTO ord (order_no, remark) VALUES ('A3', 'y');   -- ✅ 成功，note = ''
```

**陷阱 2：在中間插入欄位。**

```sql
ALTER TABLE ord ADD COLUMN inserted_mid VARCHAR(10) NULL AFTER order_no, ALGORITHM=INSTANT;
```
```
id  order_no  inserted_mid  remark   note
1   A1        NULL          舊備註
```

🔴 **舊版程式碼裡任何「按位置取值」的地方都錯位了**：

```java
// 舊版程式碼
var rs = st.executeQuery("SELECT * FROM ord WHERE id = ?");
rs.getString(3);       // 🔴 原本是 remark，現在是 inserted_mid
```

⚠️ **這不只影響手寫 JDBC**。同樣受影響的還有：

```
🔴 SELECT * 加上按位置對應的 RowMapper
🔴 INSERT INTO ord VALUES (?, ?, ?)（沒寫欄位清單）
🔴 mysqldump 出來的 INSERT（它會寫欄位清單，但只有加 --complete-insert 才會）
🔴 有些 CDC / binlog 消費端（07 章）
✅ Hibernate / MyBatis / JdbcTemplate 用【欄位名】對應的話沒事
```

📌 **兩條規則直接從這兩個陷阱推出來**：

```
① 新加的欄位一定要【可空】或【有 DEFAULT】
② 新加的欄位一律加在【最後面】，不要用 AFTER / FIRST
     （反正 6.7.3 說了，INSTANT 加的欄位實體上永遠在最後）
```

---

### 6.8.3 改一個欄位名：六次部署

**目標**：把 `ord.remark` 改名成 `ord.note`。

`ALTER TABLE ord RENAME COLUMN remark TO note` 只要 111 ms（6.7.2）——
**但這一句是不能用的**，因為它讓「舊版程式碼」在下一奈秒就開始 500。

**正確做法是六次部署。** 每一步都標出「這一刻的 schema 對新舊程式碼分別如何」：

```
                          舊版程式 (v1.4)   新版程式 (v1.5)
                          只知道 remark      只知道 note
┌────────────────────────────────────────────────────────────┐
│ 步驟 0：起點                                                │
│   schema：remark                    ✅ 可讀寫      —        │
├────────────────────────────────────────────────────────────┤
│ 步驟 1【DB 變更】加 note 欄位（可空）                       │
│   ALTER TABLE ord ADD COLUMN note VARCHAR(200) NULL,       │
│                  ALGORITHM=INSTANT;                        │
│   schema：remark + note             ✅ 可讀寫      ⚠️ 讀到 NULL│
│   📌 這一步【不部署程式碼】。舊版完全不受影響。             │
├────────────────────────────────────────────────────────────┤
│ 步驟 2【程式碼】部署「雙寫、讀舊」的版本 v1.45              │
│   寫：remark 和 note 都寫                                   │
│   讀：只讀 remark                                           │
│   schema：remark + note             ✅ 可讀寫      ✅        │
│   📌 滾動部署期間新舊混跑也沒事：                            │
│       舊版只寫 remark（note 留 NULL）                       │
│       新版兩個都寫                                          │
├────────────────────────────────────────────────────────────┤
│ 步驟 3【回填】把 remark 補到 note                           │
│   分批 UPDATE（6.6.5）—— 🔴 不要一次全刷                    │
│   完成的判定：SELECT COUNT(*) FROM ord                      │
│               WHERE note IS NULL AND remark IS NOT NULL = 0 │
│   schema：remark + note (已同步)     ✅          ✅         │
├────────────────────────────────────────────────────────────┤
│ 步驟 4【程式碼】部署「雙寫、讀新」的版本 v1.5               │
│   寫：remark 和 note 都寫（還在雙寫！）                     │
│   讀：只讀 note                                             │
│   schema：remark + note             ✅          ✅          │
│   🔴 這一步是【唯一可能出錯】的一步 ——                       │
│      如果回填漏了，這裡會讀到 NULL。                        │
│      ✅ 所以它可以【安全回退】到 v1.45（讀 remark）         │
├────────────────────────────────────────────────────────────┤
│ 步驟 5【程式碼】部署「只寫 note、只讀 note」的 v1.6         │
│   schema：remark（廢棄） + note      🔴 舊版不能再用！      │
│   📌 到這裡為止，remark 都還在 —— 所以隨時可以回退到 v1.5   │
│   ⚠️ 觀察期：至少一個完整的業務週期（含月結、批次作業）      │
├────────────────────────────────────────────────────────────┤
│ 步驟 6【DB 變更】刪掉 remark                                │
│   ALTER TABLE ord DROP COLUMN remark, ALGORITHM=INSTANT;    │
│   schema：note                                              │
│   🔴 這一步【不可逆】。做之前要確認 6.8.4 的四件事。         │
└────────────────────────────────────────────────────────────┘
```

📌 **對應的 Flyway 遷移只有兩個**（步驟 1 和步驟 6）：

```sql
-- V40__add_ord_note.sql
-- expand-contract 步驟 1：加新欄位（可空，向後相容）
-- 對應程式碼版本：v1.45 開始雙寫
-- 實測（測試環境 100 萬列）：204 ms
SET SESSION lock_wait_timeout = 5;

ALTER TABLE ord
  ADD COLUMN note VARCHAR(200) NULL,
  ALGORITHM=INSTANT;
```

```sql
-- V47__drop_ord_remark.sql
-- expand-contract 步驟 6：刪掉舊欄位
-- 🔴 前置條件（上線前逐一確認，見 6.8.4）：
--    ① v1.6 已在正式環境穩定運行 ≥ 14 天（含一次月結）
--    ② grep 全 repo：沒有任何地方還提到 remark
--    ③ 資料倉儲 / BI / 報表的 SQL 已確認不用 remark
--    ④ 已備份（07 章 7.2）—— 這一步不可逆
SET SESSION lock_wait_timeout = 5;

ALTER TABLE ord
  DROP COLUMN remark,
  ALGORITHM=INSTANT;
```

⚠️ **步驟 3 的回填【不要】放進 Flyway**（6.6.5 的結論）——
100 萬列要 10 ～ 13 秒，正式環境的 8,000 萬列會超過健康檢查的逾時。
它應該是一個獨立的批次作業，有自己的進度、可以中斷續跑。

---

📌 **「雙寫」在程式碼裡長什麼樣子？**

最乾淨的做法是**把它收在一個地方**，不要散在整個 repo：

```java
// v1.45 ~ v1.5 期間的過渡程式碼。
// 🔴 這個類別的生命週期是【暫時的】——
//    上面的註解要寫清楚它什麼時候該被刪掉。
@Component
public class OrdRemarkMigration {

    /** expand-contract 過渡期：寫入時同時寫 remark 與 note。
     *  刪除時機：V47（DROP COLUMN remark）上線後。 */
    public void applyRemark(Ord ord, String text) {
        ord.setRemark(text);   // 舊欄位 —— V47 之後刪掉這一行
        ord.setNote(text);     // 新欄位
    }

    /** 讀取：v1.45 讀 remark、v1.5 起讀 note。
     *  用一個開關切換，讓「改讀來源」不需要重新部署。 */
    public String readRemark(Ord ord) {
        return readFromNote ? ord.getNote() : ord.getRemark();
    }
}
```

✅ **把「讀哪一個」做成執行期開關（feature flag）的價值很大**：
步驟 4 就不是一次部署，而是**一次設定變更** ——
出問題時的回退是「把開關切回去」，秒級生效，不用等 rollout。

⚠️ **但雙寫有一個真實的風險要處理**：

```
🔴 雙寫【不是原子的】—— 如果 remark 寫成功、note 寫失敗會怎樣？
     ✅ 在同一個 UPDATE / 同一個交易裡寫兩個欄位 → 原子的，沒問題
     🔴 分成兩句 UPDATE、或者其中一個走不同的服務 → 會不一致
     ✅ 所以雙寫【一定要在同一句 SQL / 同一個交易裡】
```

```java
// ✅ 好：一句 UPDATE，兩個欄位，原子
@Modifying
@Query("UPDATE Ord o SET o.remark = :t, o.note = :t WHERE o.id = :id")
void updateRemarkBoth(@Param("id") Long id, @Param("t") String text);
```

📌 **一個檢查雙寫是否真的一致的查詢**（在步驟 4 之前每天跑一次）：

```sql
-- 應該永遠回傳 0
SELECT COUNT(*) FROM ord
WHERE placed_at >= CURDATE() - INTERVAL 1 DAY     -- 只看新資料（舊資料靠回填）
  AND NOT (note <=> remark);                       -- <=> 是 NULL 安全的比較（02 章）
```

⚠️ **用 `<=>` 而不是 `!=`** —— `NULL != NULL` 是 `NULL`（不是 `TRUE`），
所以 `WHERE note != remark` 會漏掉「一個是 NULL 一個不是」的情況。
這是 02 章三值邏輯那一節的直接應用。

---

### 6.8.4 刪欄位之前要確認的四件事

步驟 6 是整個流程唯一不可逆的一步。**四個檢查，全部要做**：

**① 程式碼裡真的沒有了嗎？**

```bash
# 不只找欄位名，也要找 SELECT * 與可能的動態 SQL
rg -i 'remark' --type java --type xml --type sql
rg -i 'select\s+\*' --type java --type xml    # 🔴 SELECT * 會把欄位帶回來
```

⚠️ **`SELECT *` 是刪欄位最大的隱形風險**。
它不會因為刪欄位而報錯，但如果有程式碼按位置取值（6.8.2 陷阱 2），
或者有 DTO 用「欄位數量」做驗證，就會靜默地錯。

**② 資料庫裡真的沒有依賴了嗎？**

```sql
-- 視圖 / 預存程序 / 觸發器 / 生成欄位裡有沒有用到它？
SELECT TABLE_SCHEMA, TABLE_NAME, VIEW_DEFINITION
FROM information_schema.views
WHERE VIEW_DEFINITION LIKE '%remark%';

SELECT ROUTINE_SCHEMA, ROUTINE_NAME
FROM information_schema.routines
WHERE ROUTINE_DEFINITION LIKE '%remark%';

SELECT TRIGGER_SCHEMA, TRIGGER_NAME
FROM information_schema.triggers
WHERE ACTION_STATEMENT LIKE '%remark%';

-- 🔴 最容易漏的：生成欄位與函式索引的定義
SELECT TABLE_NAME, COLUMN_NAME, GENERATION_EXPRESSION
FROM information_schema.columns
WHERE TABLE_SCHEMA = 'shop' AND GENERATION_EXPRESSION LIKE '%remark%';
```

⚠️ **如果有生成欄位依賴它，`DROP COLUMN` 會直接失敗** ——
那反而是好事（大聲失敗）。真正危險的是視圖：
`DROP COLUMN` 會成功，而**視圖會變成一個「查詢時才報錯」的壞視圖**。

**③ 資料庫之外的消費者呢？**

```
🔴 資料倉儲 / BI 工具的 SQL（它們常常不在你的 repo 裡）
🔴 報表工具的自訂查詢
🔴 CDC / binlog 消費端（Debezium 之類，07 章）
🔴 另一個團隊的服務直連了你的資料庫（如果有，那是另一個問題）
🔴 ETL 排程、每月的對帳批次（🔴 這是「觀察期要跨一個月結」的原因）
```

📌 **有一個技巧可以測出「還有誰在用」**：
在正式環境先把欄位**改名**成一個明顯的名字，而不是直接刪。

```sql
-- 步驟 5.5（可選）：改名成 remark_deprecated_20260903
-- 111 ms，INSTANT，而且【可以立刻改回來】
ALTER TABLE ord RENAME COLUMN remark TO remark_deprecated_20260903,
                ALGORITHM=INSTANT;
```

```
✅ 任何還在用它的程式碼會立刻報 ERROR 1054 Unknown column 'remark'
✅ 錯誤訊息很明確，而且能從日誌裡查到是誰
✅ 出事就改回來 —— 111 ms，資料完全沒動
⏳ 放兩週沒有任何錯誤 → 這時候刪掉就很安全了
```

⚠️ **這個技巧的前提是「你的錯誤有人在看」** ——
它把「靜默的資料錯誤」換成「大聲的 SQL 錯誤」，
而後者只有在**有監控**的時候才是進步。

**④ 備份確認過了嗎？**

```
🔴 「有備份」和「備份還原得回來」是兩件事 —— 07 章 7.2 會用實測講這件事
✅ 至少要：確認最近一次備份的時間戳、確認它包含這張表、確認還原演練做過
```

---

### 6.8.5 其他不可逆變更的 expand-contract 版本

**改型別（`INT` → `BIGINT`）**

⚠️ 這個變更看起來是「加寬，一定安全」。它有兩個坑：

```
🔴 原生只能 COPY（6.7.2）→ 100 萬列停頓 5.1 秒
🔴 如果這個欄位是外鍵的來源或目標，兩邊的型別必須一致 → 要一起改
```

```
步驟 1：加 customer_id_big BIGINT NULL（INSTANT，89 ms）
步驟 2：雙寫（同一句 UPDATE）
步驟 3：分批回填
步驟 4：切讀 → 觀察
步驟 5：DROP COLUMN customer_id、RENAME customer_id_big TO customer_id
        🔴 這一步是【兩個 INSTANT】，但不是原子的 ——
           要在極短的時間窗口內完成，或者接受幾毫秒的不一致
        ✅ 更好的做法是「新欄位就用最終名字」→ 見下方
```

📌 **一個更乾淨的變體：讓新欄位一開始就叫最終的名字。**

```
把「customer_id: INT」改成「customer_id: BIGINT」時，
不要用臨時名 customer_id_big，而是：
     ① 改名舊欄位：customer_id → customer_id_old   （INSTANT，111 ms）
     ② 加新欄位：  customer_id BIGINT NULL          （INSTANT，89 ms）
     🔴 ①② 必須寫在【同一句 ALTER】才是原子的：

ALTER TABLE ord
  RENAME COLUMN customer_id TO customer_id_old,
  ADD COLUMN customer_id BIGINT NULL,
  ALGORITHM=INSTANT;

     ③ 之後的雙寫、回填、切讀、刪舊都照 6.8.3
     ✅ 好處：程式碼從頭到尾都寫 customer_id，不需要改欄位名
     🔴 代價：步驟 ① 那一刻，【所有讀 customer_id 的舊程式碼會讀到 NULL】
              —— 所以這個變體要求「新舊程式碼都已經能處理 NULL」
```

⚠️ **兩個變體的取捨很清楚**：

```
臨時名變體（customer_id_big）：程式碼要改兩次，但【每一步都完全相容】
最終名變體（customer_id_old） ：程式碼只改一次，但【第一步有一個相容缺口】
✅ 正式環境選前者。後者適合可以短暫降級的內部服務。
```

**拆表（把 `ord.shipping_address` 拆到 `ord_shipping`）**

```
步驟 1：建新表 ord_shipping（CREATE TABLE，不影響任何人）
步驟 2：雙寫（🔴 跨表，所以【必須在同一個交易裡】）
步驟 3：回填（分批，按 ord.id 當游標）
步驟 4：切讀 → 觀察一個業務週期
步驟 5：DROP COLUMN ord.shipping_address
```

⚠️ **拆表的雙寫比改欄位名危險得多**，因為它跨兩張表：

```java
// ✅ 必須在同一個交易裡
@Transactional
public void updateShipping(Long ordId, Address addr) {
    ordRepo.updateShippingAddress(ordId, addr.toLegacyString());  // 舊：ord 的欄位
    shippingRepo.upsert(ordId, addr);                             // 新：ord_shipping
}
```

🔴 **而且要小心 04 章的鎖順序**：
兩張表的更新順序在所有程式路徑裡必須一致，否則就是一個死鎖模式。

**加唯一約束**

```
🔴 這是最容易出事的一種，因為它可能【一開始就失敗】：
   正式環境的資料裡本來就有重複值。

步驟 1：先【查】有沒有重複（不改任何東西）
    SELECT order_no, COUNT(*) c FROM ord GROUP BY order_no HAVING c > 1;
步驟 2：清理重複資料（DML 遷移，6.6.4）
步驟 3：程式碼先加上應用層的檢查（讓新的重複進不來）
步驟 4：再查一次確認是 0
步驟 5：加唯一索引（INPLACE + LOCK=NONE，實測 1,990 ms / 100 萬列）
```

⚠️ **步驟 3 不能省。** 步驟 2 清完到步驟 5 建好索引之間有一段時間，
如果那段時間又寫進了重複值，步驟 5 會失敗 ——
而它失敗的時候是在 Flyway 裡（6.5.1 的狀態）。

📌 **加唯一索引的失敗訊息**值得認一下：

```
ERROR 1062 (23000): Duplicate entry 'NO000000123456' for key 'ord.uk_order_no'
```

✅ **這個錯誤是「安全的失敗」** —— `ALTER` 整個回滾，什麼都沒改。
（`ADD INDEX` 是單一句 DDL，所以沒有 6.5.1 的部分套用問題。）

---

📌 **把整節收斂成一張「這個變更需要幾次部署」的表**：

| 變更 | 部署次數 | 為什麼 |
|---|---|---|
| 加欄位（可空 / 有 DEFAULT） | **1** | ✅ 向後相容，舊程式碼不受影響 |
| 加索引 | **1** | ✅ 完全透明 |
| 刪索引 | **1** | ⚠️ 除非有查詢靠它才不會超時（先確認 `EXPLAIN`） |
| 加欄位（`NOT NULL` 無 `DEFAULT`） | 🔴 **不要做** | 舊程式碼的 `INSERT` 立刻死（6.8.2） |
| 改欄位名 | **6** | 6.8.3 |
| 改型別 | **5 ~ 6** | 6.8.5 |
| 刪欄位 | **≥ 3** | 先確認沒人用（改名觀察）→ 再刪 |
| 拆表 | **5** | 6.8.5，且雙寫要跨表交易 |
| 加唯一約束 | **5** | 6.8.5，且要先清資料 |
| 加 `NOT NULL` 約束到既有欄位 | **4** | 先補值（DML）→ 再加約束（`COPY`） |

---

## 6.9 遷移的測試與 CI

### 6.9.1 兩種必跑的測試

📌 **遷移腳本有兩條路徑，而它們是【不同的程式】**：

```
路徑 A：從【空庫】跑完全部遷移
     → 新的本機環境、新的測試環境、CI、災難還原之後
     → 執行順序：V1 → V2 → V3 → ... → Vn（永遠是版本序）

路徑 B：從【上一個上線版本】增量跑到最新
     → 測試環境、預備環境、正式環境的每一次部署
     → 只執行 pending 的那幾個
```

🔴 **兩條路徑都會過，不代表結果一樣。** 導致它們分岔的原因至少有五個：

```
① outOfOrder（6.5.5）——  路徑 B 的執行順序可能不是版本序
② repair 對齊過 checksum（6.5.4）—— 路徑 B 少跑了某個腳本的實際內容
③ placeholder 值不同（6.3.6）
④ 腳本依賴外部狀態（SELECT * / CREATE TABLE LIKE，6.6.3）
⑤ 有人手改過正式環境（6.2.1）
```

**所以 CI 至少要有這兩個測試，而第三個測試是【比較它們的結果】。**

**實測驗證這個做法是有效的**（同一組三個遷移腳本）：

```
A：空庫 → migrate            → migrationsExecuted = 3（V1, V2, V3）
B：空庫 → migrate(target=2)  → migrationsExecuted = 2
   然後 → migrate            → migrationsExecuted = 1（只跑 V3）

diff A 的 schema  B 的 schema  →  ✅ 完全一致
```

**然後在 B 上手動加一個欄位（模擬「有人手改過正式機」）**：

```diff
   `placed_at` datetime(3) NOT NULL,
   `note` varchar(200) DEFAULT NULL,
+  `hotfix` varchar(10) DEFAULT NULL,
   PRIMARY KEY (`id`),
```

✅ **diff 立刻抓到。** 對照 6.2.3：`ddl-auto=validate` 對這個漂移**完全沒有反應**。

---

### 6.9.2 用 Testcontainers 跑真實的 MySQL

🔴 **不要用 H2 / HSQLDB 測遷移。** 理由很直接：

```
🔴 H2 不認得 ALGORITHM=INSTANT、LOCK=NONE  → 你的腳本在 H2 上跑不過
🔴 H2 的型別、定序、sql_mode 都跟 MySQL 不一樣
🔴 而遷移測試的【全部價值】就是「確認它在真的 MySQL 上跑得過」
```

✅ **Testcontainers 起一個真的 MySQL**：

```xml
<dependency>
  <groupId>org.testcontainers</groupId>
  <artifactId>mysql</artifactId>
  <version>1.20.4</version>
  <scope>test</scope>
</dependency>
```

```java
package com.example.shop.migration;

import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.*;
import org.testcontainers.containers.MySQLContainer;
import org.testcontainers.junit.jupiter.*;

import java.sql.*;
import java.util.*;

import static org.assertj.core.api.Assertions.assertThat;

@Testcontainers
class MigrationTest {

    // 🔴 版本要跟正式環境【完全一樣】（含小版本 —— 8.0.29 的 INSTANT 行為不同，6.7.2）
    @Container
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.46")
            .withDatabaseName("shop")
            .withCommand(
                    "--character-set-server=utf8mb4",
                    "--collation-server=utf8mb4_0900_ai_ci",
                    "--default-time-zone=+00:00",
                    // 🔴 sql_mode 要跟正式環境一樣，不然「嚴格模式」的錯抓不到（6.8.2）
                    "--sql-mode=ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE," +
                            "NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION");

    private Flyway flyway(String schema) {
        return Flyway.configure()
                .dataSource(MYSQL.getJdbcUrl().replace("/shop", "/" + schema),
                        MYSQL.getUsername(), MYSQL.getPassword())
                .locations("classpath:db/migration")
                .load();
    }

    private void createSchema(String name) throws SQLException {
        try (Connection c = DriverManager.getConnection(
                MYSQL.getJdbcUrl(), MYSQL.getUsername(), MYSQL.getPassword());
             Statement st = c.createStatement()) {
            st.execute("DROP DATABASE IF EXISTS " + name);
            st.execute("CREATE DATABASE " + name + " CHARACTER SET utf8mb4");
        }
    }

    @Test
    @DisplayName("路徑 A：從空庫跑完全部遷移")
    void migratesFromScratch() throws Exception {
        createSchema("from_scratch");
        var result = flyway("from_scratch").migrate();

        assertThat(result.success).isTrue();
        assertThat(result.migrationsExecuted).isGreaterThan(0);
    }

    @Test
    @DisplayName("路徑 A 之後 validate 必須通過（抓 checksum 與缺漏）")
    void validatesAfterMigrate() throws Exception {
        createSchema("validate_me");
        Flyway fw = flyway("validate_me");
        fw.migrate();

        var v = fw.validateWithResult();
        assertThat(v.validationSuccessful)
                .withFailMessage(() -> "validate 失敗：" + v.errorDetails.errorMessage)
                .isTrue();
    }

    @Test
    @DisplayName("每一個遷移都必須是【可執行】的（沒有 success=0）")
    void noFailedMigrations() throws Exception {
        createSchema("no_failures");
        flyway("no_failures").migrate();

        try (Connection c = DriverManager.getConnection(
                MYSQL.getJdbcUrl().replace("/shop", "/no_failures"),
                MYSQL.getUsername(), MYSQL.getPassword());
             var rs = c.createStatement().executeQuery(
                     "SELECT script FROM flyway_schema_history WHERE success = 0")) {
            var failed = new ArrayList<String>();
            while (rs.next()) failed.add(rs.getString(1));
            assertThat(failed).isEmpty();
        }
    }

    @Test
    @DisplayName("🔴 路徑 A 與路徑 B 的 schema 必須一模一樣")
    void scratchAndIncrementalProduceSameSchema() throws Exception {
        // 找出「上一個上線版本」—— 實務上從 CI 變數或 git tag 拿
        String previousVersion = System.getProperty("prevSchemaVersion", "2");

        createSchema("path_a");
        flyway("path_a").migrate();                              // 空庫 → 最新

        createSchema("path_b");
        Flyway.configure()
                .dataSource(MYSQL.getJdbcUrl().replace("/shop", "/path_b"),
                        MYSQL.getUsername(), MYSQL.getPassword())
                .locations("classpath:db/migration")
                .target(previousVersion)                          // 先到上一版
                .load().migrate();
        flyway("path_b").migrate();                              // 再增量到最新

        assertThat(dumpSchema("path_b"))
                .withFailMessage("增量遷移的結果與從零建立【不一致】")
                .isEqualTo(dumpSchema("path_a"));
    }

    /** 把一個 schema 的結構讀成可比較的字串（不靠 mysqldump，純 information_schema）。 */
    private String dumpSchema(String schema) throws SQLException {
        var sb = new StringBuilder();
        try (Connection c = DriverManager.getConnection(
                MYSQL.getJdbcUrl().replace("/shop", "/" + schema),
                MYSQL.getUsername(), MYSQL.getPassword());
             Statement st = c.createStatement()) {

            try (var rs = st.executeQuery("""
                    SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE,
                           COLUMN_DEFAULT, EXTRA, GENERATION_EXPRESSION, COLLATION_NAME
                    FROM information_schema.columns
                    WHERE TABLE_SCHEMA = DATABASE()
                      AND TABLE_NAME <> 'flyway_schema_history'
                    ORDER BY TABLE_NAME, COLUMN_NAME""")) {
                while (rs.next()) {
                    for (int i = 1; i <= 8; i++) sb.append(rs.getString(i)).append('|');
                    sb.append('\n');
                }
            }
            try (var rs = st.executeQuery("""
                    SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX,
                           COLUMN_NAME, SUB_PART, INDEX_TYPE
                    FROM information_schema.statistics
                    WHERE TABLE_SCHEMA = DATABASE()
                      AND TABLE_NAME <> 'flyway_schema_history'
                    ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX""")) {
                while (rs.next()) {
                    for (int i = 1; i <= 7; i++) sb.append(rs.getString(i)).append('|');
                    sb.append('\n');
                }
            }
        }
        return sb.toString();
    }
}
```

📌 **注意 `dumpSchema()` 比對的東西**，它正好補上了 6.2.3 裡 `validate` 漏掉的那七項：

```
COLUMN_TYPE           → 抓「VARCHAR(120) 變成 VARCHAR(20)」與「變成 TEXT」
IS_NULLABLE           → 抓「NOT NULL 變成 NULL」
COLUMN_DEFAULT        → 抓「DEFAULT 改了」
COLLATION_NAME        → 抓「定序漂移」（00 章的 emoji 事故）
GENERATION_EXPRESSION → 抓「生成欄位的定義改了」
statistics 那一段     → 抓「少了索引 / 少了唯一約束 / 索引欄位順序不同」
兩邊都掃              → 抓「資料庫多了 Entity 沒有的欄位」
```

⚠️ **本章的實測用的是手動起的 Docker 容器，不是 Testcontainers** ——
`docker run` 起一個 `mysql:8.0` 再連 `127.0.0.1:3340`，效果相同。
上面的 Testcontainers 版本是同一個流程的 JUnit 包裝。
（Testcontainers 對 Docker 版本比較敏感 —— 如果 `@Container` 起不來，
先確認 `DOCKER_HOST`，或者退回「CI 裡用 service container、測試只連 URL」的做法。）

---

### 6.9.3 黃金 schema：把結構放進版控

**測試證明了「兩條路徑一致」，但它沒有證明「這個 schema 是我們想要的」。**
黃金 schema 補上這一塊：**把遷移跑完的結構 dump 出來，當成一個檔案放進版控。**

```bash
#!/bin/bash
# ci/dump-golden-schema.sh —— 產生 / 更新黃金 schema
set -euo pipefail
CONTAINER=${1:?用法: dump-golden-schema.sh <容器名> <資料庫名>}
DB=${2:?}

docker exec "$CONTAINER" mysqldump -uroot -proot \
    --no-data --skip-comments --skip-add-drop-table --skip-set-charset \
    --routines --triggers "$DB" \
  | sed -E 's/ AUTO_INCREMENT=[0-9]+//' \
  | grep -v '^/\*!' \
  | grep -v 'flyway_schema_history'
```

📌 **三個正規化步驟，每一個都是必要的**：

```
sed 's/ AUTO_INCREMENT=[0-9]+//'   → 拿掉自增計數器的當前值（它每次都不一樣）
grep -v '^/\*!'                     → 拿掉版本相依的條件註解
grep -v 'flyway_schema_history'     → 拿掉 Flyway 自己的表
```

**CI 的守門**：

```bash
#!/bin/bash
# ci/check-golden-schema.sh
set -euo pipefail
GOLDEN=src/main/resources/db/golden-schema.sql
ACTUAL=$(mktemp)

# ① 起一個乾淨的 MySQL、跑完全部遷移
docker run -d --name ci-mysql -e MYSQL_ROOT_PASSWORD=root \
  -p 3399:3306 mysql:8.0.46 \
  --character-set-server=utf8mb4 --collation-server=utf8mb4_0900_ai_ci
trap 'docker rm -f ci-mysql >/dev/null 2>&1' EXIT

until docker exec ci-mysql mysqladmin -uroot -proot ping --silent 2>/dev/null; do sleep 1; done
docker exec ci-mysql mysql -uroot -proot -e 'CREATE DATABASE shop CHARACTER SET utf8mb4'
mvn -q flyway:migrate -Dflyway.url=jdbc:mysql://127.0.0.1:3399/shop \
                      -Dflyway.user=root -Dflyway.password=root

# ② dump 出來跟版控的黃金檔比
ci/dump-golden-schema.sh ci-mysql shop > "$ACTUAL"

if ! diff -u "$GOLDEN" "$ACTUAL"; then
  echo ""
  echo "🔴 遷移產生的 schema 與 golden-schema.sql 不一致。"
  echo "   如果這是【預期的】變更，請執行："
  echo "     ci/dump-golden-schema.sh ci-mysql shop > $GOLDEN"
  echo "   然後把它一起提交，讓 reviewer 看得到 schema 的 diff。"
  exit 1
fi
echo "✅ schema 與黃金檔一致"
```

✅ **黃金 schema 的真正價值是【讓 schema 變更出現在 code review 的 diff 裡】**：

```
沒有黃金檔：PR 的 diff 是「+ V47__drop_ord_remark.sql（3 行 SQL）」
            → reviewer 要自己在腦中執行才知道結果

有黃金檔  ：PR 的 diff 多了
            golden-schema.sql
            -  `remark` varchar(200) DEFAULT NULL,
            → 🔴 reviewer 一眼看到「這個 PR 會刪掉一個欄位」
```

📌 **這也是「正式環境的 schema 到底跟版控一不一致」的唯一可靠答案**：

```bash
# 每天一次的巡檢（用唯讀帳號連正式環境）
mysqldump -h prod-host -u readonly -p --no-data --skip-comments \
    --skip-add-drop-table --skip-set-charset --routines --triggers shop \
  | sed -E 's/ AUTO_INCREMENT=[0-9]+//' | grep -v '^/\*!' \
  | grep -v 'flyway_schema_history' \
  > /tmp/prod-schema.sql

diff -u src/main/resources/db/golden-schema.sql /tmp/prod-schema.sql \
  || echo "🔴 正式環境的 schema 與版控不一致，請查是誰手改了"
```

⚠️ **這個巡檢第一次跑的時候，幾乎一定會有 diff。** 那些 diff 就是你的技術債清單。

---

### 6.9.4 遷移腳本的 lint 清單

有些錯誤不需要跑起來就能抓。一個可以放進 CI 的靜態檢查：

```bash
#!/bin/bash
# ci/lint-migrations.sh
set -uo pipefail
DIR=src/main/resources/db/migration
FAIL=0
say() { echo "🔴 $1"; FAIL=1; }

for f in "$DIR"/V*.sql; do
  base=$(basename "$f")

  # ① 檔名格式（依團隊策略調整，這裡是 14 位時間戳）
  [[ "$base" =~ ^V[0-9]{14}__[a-z0-9_]+\.sql$ ]] \
    || say "$base：檔名不符合 V<14位時間戳>__<小寫描述>.sql"

  # ② 危險操作要有明確的批准註解
  if grep -qiE '^\s*(DROP\s+(TABLE|DATABASE)|TRUNCATE)' "$f"; then
    grep -qi '^-- APPROVED-DESTRUCTIVE:' "$f" \
      || say "$base：含 DROP TABLE / TRUNCATE，但沒有 '-- APPROVED-DESTRUCTIVE: <原因>' 註解"
  fi

  # ③ ALTER TABLE 必須明確寫 ALGORITHM（6.6.3 規則 2）
  if grep -qiE '^\s*ALTER\s+TABLE' "$f" && ! grep -qi 'ALGORITHM\s*=' "$f"; then
    say "$base：ALTER TABLE 沒有指定 ALGORITHM（見 6.7.2）"
  fi

  # ④ ALGORITHM=INSTANT 不能配 LOCK（ERROR 1221）
  grep -qiE 'ALGORITHM\s*=\s*INSTANT.*LOCK\s*=' "$f" \
    && say "$base：ALGORITHM=INSTANT 不能同時寫 LOCK（ERROR 1221）"

  # ⑤ DDL 與 DML 不可混（6.5.3）
  has_ddl=$(grep -ciE '^\s*(ALTER|CREATE|DROP|RENAME|TRUNCATE)\b' "$f")
  has_dml=$(grep -ciE '^\s*(INSERT|UPDATE|DELETE|REPLACE)\b' "$f")
  if [ "$has_ddl" -gt 0 ] && [ "$has_dml" -gt 0 ]; then
    say "$base：同一個腳本裡混了 DDL 與 DML（見 6.5.3 的隱式提交）"
  fi

  # ⑥ 沒有 WHERE 的 UPDATE / DELETE
  grep -qiE '^\s*(UPDATE|DELETE)\b' "$f" && ! grep -qi 'WHERE' "$f" \
    && say "$base：有 UPDATE / DELETE 但整個檔案找不到 WHERE"

  # ⑦ SELECT * 與沒寫欄位清單的 INSERT（6.6.3 規則 5）
  grep -qiE 'SELECT\s+\*' "$f" \
    && say "$base：使用了 SELECT *（結果會依賴執行當時的表結構）"
  grep -qiE 'INSERT\s+INTO\s+[`a-z_.]+\s+VALUES' "$f" \
    && say "$base：INSERT 沒有寫欄位清單"

  # ⑧ 行尾空白（會讓 checksum 對不上，6.3.5）
  grep -qE '[[:space:]]+$' "$f" \
    && say "$base：有行尾空白（checksum 對它敏感，見 6.3.5）"

  # ⑨ ALTER TABLE 沒有設 MDL 逾時（6.7.5）
  grep -qiE '^\s*ALTER\s+TABLE' "$f" && ! grep -qi 'lock_wait_timeout' "$f" \
    && echo "⚠️  $base：ALTER TABLE 前面沒有 SET SESSION lock_wait_timeout（建議加，見 6.7.5）"
done

# ⑩ 已上線的腳本不可修改（6.3.5）
CHANGED=$(git diff --name-only --diff-filter=M origin/master...HEAD -- "$DIR/" || true)
[ -n "$CHANGED" ] && say "已存在的遷移腳本被修改了（就算只是空白）：$CHANGED"

# ⑪ 新增的版本必須大於 master 的最大版本（6.5.5）
MASTER_MAX=$(git ls-tree -r --name-only origin/master -- "$DIR/" \
             | grep -oE 'V[0-9]+' | tr -d 'V' | sort -n | tail -1 || echo 0)
NEW_MIN=$(git diff --name-only --diff-filter=A origin/master...HEAD -- "$DIR/" \
          | grep -oE 'V[0-9]+' | tr -d 'V' | sort -n | head -1 || echo "")
if [ -n "$NEW_MIN" ] && [ "$NEW_MIN" -le "${MASTER_MAX:-0}" ]; then
  say "新遷移的版本 V$NEW_MIN 不大於 master 的 V$MASTER_MAX（會造成 out-of-order）"
fi

exit $FAIL
```

📌 **這份 lint 的每一條都對應本章的一個實驗。**
它不是「風格檢查」，是「把已經踩過的坑編碼成規則」。

⚠️ **③ 和 ⑨ 在你剛開始導入時會噴很多警告。**
建議的引入順序：**先做 ⑧ ⑩ ⑪（成本最低、價值最高），跑穩了再加其他的。**

---

## 6.10 在 Spring Boot 的整合細節

### 6.10.1 啟動順序：Flyway 一定在 JPA 之前

```yaml
spring:
  datasource:
    # ⚠️ 完整版（含連線池、逾時、時區的全部參數）見 00 章 0.7.5，這裡只列本節相關的。
    #    不要寫成 useSSL=false&serverTimezone=UTC —— 那兩個參數都是 legacy 別名，
    #    會分別踩到 0.3.5 的 Public Key Retrieval 事故與 0.6.3 的「組合 G」時區靜默錯誤。
    url: "jdbc:mysql://db:3306/shop\
          ?connectionTimeZone=UTC\
          &preserveInstants=true\
          &forceConnectionTimeZoneToSession=true\
          &rewriteBatchedStatements=true"
    username: shop_app
    password: ${APP_DB_PASSWORD}
  jpa:
    hibernate:
      ddl-auto: none          # 🔴 正式環境永遠是 none（6.2.2）
    open-in-view: false       # 04 章講過為什麼
  flyway:
    enabled: true
    locations: classpath:db/migration
    baseline-on-migrate: false
    out-of-order: false       # 🔴 正式環境（6.5.5）
    clean-disabled: true      # 🔴 預設就是 true，明確寫出來（6.5.7）
    validate-on-migrate: true
```

📌 **Spring Boot 的 auto-configuration 保證了 `Flyway` 在 `EntityManagerFactory` 之前初始化。**
（機制是 `FlywayMigrationInitializer` + `EntityManagerFactoryDependsOnPostProcessor`。）

⚠️ **但這個保證只涵蓋「Spring Boot 自己管的東西」。**
如果你有其他 bean 在啟動時就要讀資料庫，順序不一定對：

```java
// 🔴 這個 bean 可能在 Flyway 之前初始化
@Component
public class ConfigCache {
    @PostConstruct
    void load() {
        // 讀一張 V12 才建的表 → 可能拿到 Table 'config' doesn't exist
    }
}
```

```java
// ✅ 明確宣告依賴
@Component
@DependsOn("flywayInitializer")
public class ConfigCache { ... }
```

---

### 6.10.2 遷移帳號 ≠ 應用帳號

🔴 **這是本章最容易被跳過、但成本最低的一項安全措施。**

```
應用程式需要的權限     ：SELECT, INSERT, UPDATE, DELETE
遷移需要的權限         ：上面全部 + CREATE, ALTER, DROP, INDEX, REFERENCES, CREATE ROUTINE
```

**如果兩者共用一個帳號**，那麼任何一個 SQL 注入漏洞、任何一個寫錯的動態 SQL，
都可能執行 `DROP TABLE`。

```sql
-- ① 應用帳號：只能動資料，不能動結構
CREATE USER 'shop_app'@'%' IDENTIFIED BY '...';
GRANT SELECT, INSERT, UPDATE, DELETE ON shop.* TO 'shop_app'@'%';
-- 🔴 沒有 CREATE / ALTER / DROP / INDEX

-- ② 遷移帳號：可以動結構
CREATE USER 'shop_migrate'@'%' IDENTIFIED BY '...';
GRANT SELECT, INSERT, UPDATE, DELETE,
      CREATE, ALTER, DROP, INDEX, REFERENCES,
      CREATE ROUTINE, ALTER ROUTINE, EXECUTE,        -- 6.6.2 的預存程序
      CREATE VIEW, SHOW VIEW,                        -- 6.3.3 的 R__ 視圖
      TRIGGER                                        -- 如果有觸發器
  ON shop.* TO 'shop_migrate'@'%';
-- 🔴 注意：沒有 DROP DATABASE 的能力（那需要 schema 層級以上的權限）

-- ③ 巡檢用的唯讀帳號（6.9.3 的正式環境 diff）
CREATE USER 'shop_readonly'@'%' IDENTIFIED BY '...';
GRANT SELECT, SHOW VIEW ON shop.* TO 'shop_readonly'@'%';
GRANT PROCESS ON *.* TO 'shop_readonly'@'%';         -- 為了看 processlist（6.7.4）
```

**在 Spring Boot 裡讓 Flyway 用不同的帳號**：

```yaml
spring:
  datasource:                       # 應用的連線池
    url: jdbc:mysql://db:3306/shop
    username: shop_app
    password: ${APP_DB_PASSWORD}
  flyway:
    # 🔴 Flyway 有自己的 url/user/password —— 設了就不會用 spring.datasource
    url: jdbc:mysql://db:3306/shop
    user: shop_migrate
    password: ${MIGRATE_DB_PASSWORD}
    init-sqls:
      - SET SESSION lock_wait_timeout = 5           # 6.7.5
      - SET SESSION innodb_lock_wait_timeout = 5
```

✅ **這個設定還有一個副作用的好處**：
`flyway_schema_history.installed_by` 會記成 `shop_migrate` ——
**於是「是遷移改的」和「是應用改的」在資料庫層面就分得開**。

📌 **搭配 6.5.7：`clean` 需要 `DROP` 權限。**
如果你按上面設定，`shop_app` 連 `DROP TABLE` 都做不到 ——
**權限比設定可靠**，因為它擋得住「設定寫錯」和「有人用 CLI 亂跑」。

---

### 6.10.3 Kubernetes：三種做法

這是 6.5.6 那個 `CrashLoopBackOff` 問題的解法。

**做法 A：應用內遷移（Spring Boot 預設）**

```yaml
# 🔴 一定要把 startupProbe 調得比「最慢的遷移」寬鬆
startupProbe:
  httpGet: { path: /actuator/health/readiness, port: 8080 }
  periodSeconds: 10
  failureThreshold: 60        # 10 × 60 = 600 秒的啟動預算
readinessProbe:
  httpGet: { path: /actuator/health/readiness, port: 8080 }
  periodSeconds: 5
  failureThreshold: 3
livenessProbe:
  httpGet: { path: /actuator/health/liveness, port: 8080 }
  periodSeconds: 10
  failureThreshold: 3
```

⚠️ **關鍵是「`startupProbe` 存在的時候，`liveness` 與 `readiness` 不會啟動」** ——
所以 `startupProbe` 的總預算（`periodSeconds × failureThreshold`）
就是你的「遷移最長容忍時間」。

```
✅ 適合：小專案、遷移都是 INSTANT 等級（毫秒）
🔴 不適合：有大表加索引（分鐘級）的專案
🔴 最糟的情況：遷移跑了 8 分鐘，而 startupProbe 給了 60 秒
              → Pod 被殺 → 中斷的 ALTER 變成 6.5.1 的狀態
```

**做法 B：`initContainer`**

```yaml
spec:
  template:
    spec:
      initContainers:
        - name: flyway-migrate
          image: flyway/flyway:10.20.1
          args:
            - -url=jdbc:mysql://db:3306/shop
            - -user=shop_migrate
            - -password=$(MIGRATE_DB_PASSWORD)
            - -locations=filesystem:/flyway/sql
            - -connectRetries=10
            - migrate
          env:
            - name: MIGRATE_DB_PASSWORD
              valueFrom: { secretKeyRef: { name: db-secret, key: migrate-password } }
          volumeMounts:
            - { name: migrations, mountPath: /flyway/sql }
      containers:
        - name: app
          # 主容器的 probe 完全不受遷移時間影響
```

```
✅ 主容器的 probe 乾淨了
✅ 遷移失敗 → initContainer 失敗 → Pod 不會進到 Running
🔴 每個 Pod 的 initContainer 都會跑一次 —— 靠 Flyway 的 GET_LOCK 互斥（6.5.6）
🔴 所以 N 個 Pod 的第 2 ~ N 個還是在等鎖，只是等的地方變成 initContainer
   → initContainer 沒有 startupProbe，所以不會被殺 ✅
   → 但 Deployment 的 progressDeadlineSeconds（預設 600 秒）還是會踩到
```

**做法 C：獨立的 Job，跑完才 rollout（✅ 正式環境的正解）**

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: shop-migrate-{{ .Release.Revision }}     # 每次部署一個新的 Job
  annotations:
    "helm.sh/hook": pre-upgrade,pre-install      # 🔴 在更新 Deployment【之前】
    "helm.sh/hook-weight": "0"
    "helm.sh/hook-delete-policy": before-hook-creation
spec:
  backoffLimit: 3                # 失敗重試 3 次（配 6.7.5 的 lock_wait_timeout）
  activeDeadlineSeconds: 1800    # 🔴 30 分鐘還沒跑完就放棄（不要無限期卡住部署）
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: flyway
          image: my-registry/shop-migrations:{{ .Values.image.tag }}
          command: ["flyway", "migrate"]
          env:
            - name: FLYWAY_URL
              value: jdbc:mysql://db:3306/shop
            - name: FLYWAY_USER
              value: shop_migrate
            - name: FLYWAY_PASSWORD
              valueFrom: { secretKeyRef: { name: db-secret, key: migrate-password } }
            - name: FLYWAY_CONNECT_RETRIES
              value: "10"
```

```yaml
# 應用本身關掉 Flyway
spring:
  flyway:
    enabled: false
```

```
✅ 遷移只跑一次，有自己的逾時與重試
✅ 遷移失敗 → Helm 的 pre-upgrade hook 失敗 → 【新版程式碼根本不會部署】
     這一點很重要：它讓「schema 沒改好就不要上新程式碼」變成機制，不是紀律
✅ 遷移的日誌獨立，好查
🔴 需要 Helm hook 或等價的 CI/CD 支援
🔴 🔴 【遷移與程式碼分開部署之後，6.8 的向後相容變成【強制要求】】——
     因為遷移先跑完，而那一刻線上跑的還是【舊版程式碼】
```

⚠️ **最後那一點是做法 C 最重要的性質，也最容易被忽略**：

```
做法 C 的時間軸：
    t0  Job 跑遷移（schema 變成新的）
    t1  Job 成功
    t2  Deployment 開始 rollout
    t3  第一個新版 Pod ready
    ...
    tn  全部 Pod 都是新版

🔴 t1 ~ t3 之間：新 schema + 【100% 舊版程式碼】
    → 如果遷移不向後相容（例如刪了一個舊程式碼在讀的欄位），
      這段時間【整個服務都是壞的】
✅ 這正是 6.8 expand-contract 存在的理由
```

---

### 6.10.4 Callbacks

Flyway 可以在遷移的各個時點插入 SQL 或 Java 邏輯。
檔名就是掛載點：

```
src/main/resources/db/callback/
  beforeMigrate.sql        每次 migrate 之前（🔴 也會在「沒有 pending」時執行）
  beforeEachMigrate.sql    每一個腳本之前
  afterEachMigrate.sql     每一個腳本之後（成功）
  afterMigrateError.sql    遷移失敗之後
  afterMigrate.sql         全部完成之後
```

```yaml
spring:
  flyway:
    locations:
      - classpath:db/migration
      - classpath:db/callback
```

📌 **兩個真正有用的用法**：

**① 環境守門：設錯了就【在改任何東西之前】失敗。**

這比「跑到第 20 個腳本才發現定序不對」好太多（00 章的 emoji 事故）。
MySQL 沒有 `RAISE`，但有 `SIGNAL`：

```sql
-- db/callback/beforeMigrate.sql
DROP PROCEDURE IF EXISTS assert_environment;

DELIMITER $$
CREATE PROCEDURE assert_environment()
BEGIN
  IF @@character_set_database <> 'utf8mb4' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = '資料庫字元集不是 utf8mb4，拒絕遷移';
  END IF;
  IF @@sql_mode NOT LIKE '%STRICT_TRANS_TABLES%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'sql_mode 沒有 STRICT_TRANS_TABLES，拒絕遷移';
  END IF;
END$$
DELIMITER ;

CALL assert_environment();
DROP PROCEDURE assert_environment;
```

**實測**：把資料庫建成 `CHARACTER SET latin1`，然後 `migrate`：

```
SQL State  : 45000
Error Code : 1644
Message    : 資料庫字元集不是 utf8mb4，拒絕遷移
```

```sql
SHOW TABLES;
```
```
Tables_in_cb
flyway_schema_history        ← 只有這個
                             ← ✅ V1 要建的 t 表【沒有被建立】
```

改成 `utf8mb4` 之後：

```
[migrate] initialSchemaVersion=null targetSchemaVersion=1 migrationsExecuted=1
   applied V1 t  type=SQL  10ms
```

⚠️ **注意 `flyway_schema_history` 還是被建了** ——
`beforeMigrate` 在 history 表建立**之後**、第一個腳本執行**之前**跑。
所以它擋得住「任何 schema 變更」，但擋不住 history 表本身。

📌 **`SIGNAL` 的錯誤碼固定是 `1644`（`SQLSTATE 45000`）** ——
可以拿來在 CI 的日誌裡認出「這是我們自己的守門，不是遷移出錯」。

**② 更新統計資訊。**

```sql
-- db/callback/afterMigrate.sql
-- ② 更新統計資訊 —— 剛加完索引時，優化器的統計是空的（03 章 3.10）
ANALYZE TABLE ord;
ANALYZE TABLE customer;
```

⚠️ **`beforeMigrate` 每次啟動都會跑，包含「沒有任何 pending 遷移」的時候。**
所以它必須是**幂等且便宜的**（上面兩個都是）。
🔴 不要在 `afterMigrate` 裡 `ANALYZE` 一張 8,000 萬列的表 —— 那會拖慢每一次啟動。

---

### 6.10.5 多資料源與多租戶

**多資料源**：每個資料源一組 Flyway。Spring Boot 的 auto-config 只管一個，
所以第二個要手動配：

```java
package com.example.shop.config;

import org.flywaydb.core.Flyway;
import org.springframework.beans.factory.config.BeanFactoryPostProcessor;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import javax.sql.DataSource;

@Configuration
public class SecondaryFlywayConfig {

    @Bean(initMethod = "migrate")
    public Flyway reportFlyway(
            @Qualifier("reportDataSource") DataSource ds) {
        return Flyway.configure()
                .dataSource(ds)
                .locations("classpath:db/migration-report")   // 🔴 獨立的目錄
                .table("flyway_schema_history")                // 各自的 history 表
                .load();
    }

    // 🔴 讓第二個 EntityManagerFactory 等它
    @Bean
    static BeanFactoryPostProcessor reportEmfDependsOnFlyway() {
        return bf -> bf.getBeanDefinition("reportEntityManagerFactory")
                       .setDependsOn("reportFlyway");
    }
}
```

**多租戶（每個租戶一個 schema）**：迴圈跑，一個租戶一次。

```java
package com.example.shop.migration;

import org.flywaydb.core.Flyway;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.LinkedHashMap;
import java.util.List;

@Component
public class TenantMigrator {

    private static final Logger log = LoggerFactory.getLogger(TenantMigrator.class);

    /** 對每個租戶的 schema 各跑一次 migrate。
     *  🔴 一個失敗不要讓其他的也不跑 —— 收集錯誤，全部跑完再一起丟。 */
    public void migrateAll(List<String> schemas, String baseUrl,
                           String user, String password) {
        var failures = new LinkedHashMap<String, Exception>();

        for (String schema : schemas) {
            try {
                var result = Flyway.configure()
                        .dataSource(baseUrl + "/" + schema, user, password)
                        .locations("classpath:db/migration")
                        .schemas(schema)
                        .load()
                        .migrate();
                log.info("租戶 {} 遷移完成，套用 {} 個", schema, result.migrationsExecuted);
            } catch (Exception e) {
                log.error("🔴 租戶 {} 遷移失敗", schema, e);
                failures.put(schema, e);
            }
        }

        if (!failures.isEmpty()) {
            throw new IllegalStateException(
                    "以下租戶遷移失敗：" + failures.keySet(), failures.values().iterator().next());
        }
    }
}
```

⚠️ **多租戶遷移的三個實務問題**：

```
🔴 租戶多的時候會很慢（500 個租戶 × 每個 2 秒 = 17 分鐘）
     → 一定要用做法 C 的獨立 Job（6.10.3），不能跟著應用啟動
🔴 一個租戶失敗，其他的怎麼辦？
     → 上面的做法是「全部跑完再報錯」，讓部分成功可以下次續跑
     → 🔴 但這代表「有些租戶是新 schema、有些是舊的」
       → 所以多租戶【更加】需要 6.8 的向後相容
🔴 每個租戶一份 flyway_schema_history —— 要有一個彙總的視角
```

```sql
-- 彙總巡檢：哪些租戶落後了？
SELECT 'tenant_001' AS tenant, MAX(version) AS v
FROM tenant_001.flyway_schema_history WHERE success = 1
UNION ALL
SELECT 'tenant_002', MAX(version) FROM tenant_002.flyway_schema_history WHERE success = 1;
-- 📌 實務上用預存程序或應用程式動態組出這句
```

---

## 6.11 Liquibase 對照：什麼時候選它

| | Flyway | Liquibase |
|---|---|---|
| 遷移的寫法 | **純 SQL 檔案** | XML / YAML / JSON / SQL（有自己的 DSL） |
| 你能控制 `ALGORITHM=INPLACE, LOCK=NONE` 嗎 | ✅ 你寫什麼就跑什麼 | ⚠️ 用 DSL 時要靠 `<sql>` 標籤逃逸 |
| 跨資料庫（同一份腳本跑 MySQL 與 PostgreSQL） | 🔴 不行 | ✅ DSL 會轉譯 |
| 回滾（`rollback`） | 🔴 社群版沒有 | ✅ DSL 的變更集可以自動產生回滾 |
| 學習曲線 | ✅ 會 SQL 就會了 | ⚠️ 要學 changeset / changelog 的模型 |
| 「這個遷移到底會跑什麼 SQL」 | ✅ 打開檔案就是 | ⚠️ 要 `updateSQL` 才看得到 |

📌 **選 Liquibase 的兩個正當理由**：

```
✅ 你的產品要同時支援多種資料庫（客戶自架，有人用 MySQL 有人用 PostgreSQL）
✅ 你的團隊裡寫遷移的人不熟 SQL，需要 DSL 的抽象與檢查
```

🔴 **不要因為「它有 rollback」而選 Liquibase。**
6.8.1 論證過：`rollback` 對「刪欄位、改型別、改資料」這些操作**只回滾 schema，不回滾資料**。
Liquibase 的 `rollback` 也一樣 —— 它產生的是
`ALTER TABLE ord ADD COLUMN remark VARCHAR(200)`，而**資料回不來**。

⚠️ **而如果你只用 MySQL、而且會寫 SQL，Flyway 的「純 SQL」是一個優勢而不是缺點**：

```
本章 6.7 的所有內容 —— ALGORITHM、LOCK、lock_wait_timeout、
                        分區的 REORGANIZE、pt-osc 的參數 ——
全部都是「MySQL 特有的、必須明確寫出來的東西」。
任何抽象層在這裡都是障礙。
```

---

## 6.12 shop-service 的完整遷移腳本集

01 章 1.12 交出了一份完整的 `CREATE TABLE`，並留下一個問題：
**「這份 schema 要怎麼變成可重複執行的遷移腳本？」** 這一節就是答案。

**目錄結構**：

```
src/main/resources/db/
├── migration/
│   ├── V20260901120000__baseline_core_schema.sql        ← 01 章 1.12 的完整 schema
│   ├── V20260910093000__orders_add_settlement.sql       ← INSTANT 加欄位
│   ├── V20260910093100__orders_add_settle_index.sql     ← INPLACE 加索引
│   ├── V20260912140000__fix_paid_without_paid_at.sql    ← 純 DML 資料修正
│   ├── V20260915101000__customer_add_locale.sql         ← expand-contract 步驟 1
│   └── R__v_order_summary.sql                           ← 可重複遷移（視圖）
├── callback/
│   └── beforeMigrate.sql                                ← 環境守門
└── golden-schema.sql                                    ← 6.9.3 的黃金 schema
```

📌 **六個腳本，剛好對應本章的六種模式。** 逐一看。

---

**① 基準：`V20260901120000__baseline_core_schema.sql`**

內容就是 01 章 1.12 那份完整的 `CREATE TABLE`（七張表），前面加兩行：

```sql
-- =====================================================================
-- shop-service 初始 schema（01 章 1.12 的完整版）
-- 這個腳本【只會在新環境執行】——
-- 已上線的資料庫用 baselineVersion = 20260901120000 跳過它（6.4）
-- =====================================================================
SET SESSION lock_wait_timeout = 5;

CREATE TABLE customer      ( ... );   -- 01 章 1.12 的七張表，原封不動
CREATE TABLE product       ( ... );
CREATE TABLE stock         ( ... );
CREATE TABLE orders        ( ... );
CREATE TABLE order_item    ( ... );
CREATE TABLE outbox_message( ... );
CREATE TABLE address       ( ... );
```

**實測**：空庫執行 **74 ms**。

⚠️ **表的順序有依賴**（外鍵）：`customer` → `product` → `stock` → `orders` → `order_item`。
🔴 不要為了「一個腳本只做一件事」把它們拆成七個腳本 ——
基準腳本的語意是「整個 schema 的起點」，它是一個原子概念。
（而且拆開之後，跑到第 4 個失敗會變成 6.5.1 的狀態。）

---

**② `INSTANT` 加欄位：`V20260910093000__orders_add_settlement.sql`**

```sql
-- 需求：結算批次要能追溯每一筆訂單是哪一批結的
-- 型態：加欄位（可空）→ 向後相容，一次部署（6.8.5 的表）
-- 實測：測試環境 100 萬列 204 ms；INSTANT 與列數無關（6.7.2）
SET SESSION lock_wait_timeout = 5;

ALTER TABLE orders
  ADD COLUMN settled_at   DATETIME(3) NULL,
  ADD COLUMN settle_batch VARCHAR(32) NULL,
  ALGORITHM=INSTANT;
```

📌 **兩個欄位寫在【同一句】`ALTER` 裡** —— 6.6.1 的規則：
一句 `ALTER` 是原子的，而兩句獨立的 `ALTER` 不是。

---

**③ `INPLACE` 加索引：`V20260910093100__orders_add_settle_index.sql`**

```sql
-- 查詢路徑：「某一批結算的訂單，按結算時間」
-- 🔴 INSTANT 不支援加索引（ERROR 1845）→ INPLACE + LOCK=NONE（6.7.2）
-- 實測：測試環境 100 萬列 1,433 ms
-- ⚠️ 正式環境 orders 約 8,000 萬列，預估 2 ~ 5 分鐘
--    → 這個腳本必須用獨立的 Job 執行（6.10.3 做法 C），不能跟著應用啟動
SET SESSION lock_wait_timeout = 5;

ALTER TABLE orders
  ADD INDEX idx_orders_settle (settle_batch, settled_at),
  ALGORITHM=INPLACE, LOCK=NONE;
```

📌 **注意註解裡的三層資訊** —— 這是本章對「遷移腳本註解」的完整要求：

```
① 為什麼要這個變更（查詢路徑 / 需求）
② 為什麼用這個 ALGORITHM（並附上不支援的那個的錯誤碼）
③ 🔴 測試環境的實測耗時 + 正式環境的推估 + 【推估帶來的部署決策】
```

⚠️ **③ 為什麼重要？**
因為「加索引要跑 5 分鐘」這個事實**改變了部署方式** ——
它不是一個效能備註，是一個**部署決策的依據**（6.5.6 的 `CrashLoopBackOff`）。

---

**④ 純 DML 修正：`V20260912140000__fix_paid_without_paid_at.sql`**

```sql
-- 背景：2026-09-05 的一個 bug 讓部分訂單 status='PAID' 但 paid_at 是 NULL
-- 判定：status = 'PAID' AND paid_at IS NULL，且時間範圍收在事故窗口內
-- 預期影響：測試環境 0 列；正式環境上線前用唯讀副本確認為 312 列
-- 🔴 純 DML，不碰 schema（6.5.3）
SET SESSION innodb_lock_wait_timeout = 5;

UPDATE orders
SET paid_at = updated_at
WHERE status  = 'PAID'
  AND paid_at IS NULL
  AND placed_at >= '2026-09-05 00:00:00.000'
  AND placed_at <  '2026-09-06 00:00:00.000';
```

📌 **這個腳本示範了 6.6.4 的五條規則全部**：
註解有背景／判定／預期列數、有 `WHERE`、範圍收緊到事故窗口、純 DML、
影響列數小（312 列）所以不用分批。

⚠️ **這裡設的是 `innodb_lock_wait_timeout` 而不是 `lock_wait_timeout`** ——
DML 等的是**行鎖**，不是 MDL（6.7.5 的對照表）。

---

**⑤ expand-contract 步驟 1：`V20260915101000__customer_add_locale.sql`**

```sql
-- expand-contract 步驟 1（6.8.3）：加新欄位
-- 🔴 一定要有 DEFAULT —— 不然舊版程式碼的 INSERT 會炸 ERROR 1364（6.8.2）
-- 對應程式碼版本：v2.3 開始寫入；v2.4 開始讀取
SET SESSION lock_wait_timeout = 5;

ALTER TABLE customer
  ADD COLUMN locale VARCHAR(10) NOT NULL DEFAULT 'zh-TW',
  ALGORITHM=INSTANT;
```

📌 **「對應程式碼版本」這一行註解很重要。**
expand-contract 的每一步都跟一個程式碼版本綁在一起（6.8.3 的六步圖），
而三個月後排查問題的人，需要知道「這個欄位是哪一版開始用的」。

---

**⑥ 可重複遷移：`R__v_order_summary.sql`**

```sql
-- 可重複遷移（6.3.3）：內容改了就重跑
-- 🔴 一定要 CREATE OR REPLACE —— 純 CREATE VIEW 第二次會炸 ERROR 1050
CREATE OR REPLACE VIEW v_order_summary AS
SELECT o.id,
       o.order_no,
       o.customer_id,
       o.status,
       o.total_amount,
       o.placed_at,
       COUNT(oi.id)                     AS item_count,
       COALESCE(SUM(oi.line_amount), 0) AS item_total
FROM orders o
LEFT JOIN order_item oi ON oi.order_id = o.id
GROUP BY o.id, o.order_no, o.customer_id, o.status, o.total_amount, o.placed_at;
```

⚠️ **`GROUP BY` 列出了所有非聚合欄位** ——
因為 `sql_mode` 有 `ONLY_FULL_GROUP_BY`（02 章的函式依賴）。
`o.id` 是主鍵，理論上其他欄位都函式依賴於它，MySQL 8.0 認得這件事 ——
但**明確列出來讓這個視圖在任何 `sql_mode` 下都建得起來**。

---

**⑦ 環境守門：`db/callback/beforeMigrate.sql`**

內容就是 6.10.4 那個 `assert_environment` 預存程序（用 `SIGNAL` 拋錯）。

---

**完整執行結果**（一個空的 `utf8mb4` 資料庫）：

```
警告: DB: PROCEDURE shopmig.assert_environment does not exist (Error Code: 1305)
      ← ⚠️ 這是 beforeMigrate 裡的 DROP PROCEDURE IF EXISTS 產生的，無害

[migrate] initialSchemaVersion=null targetSchemaVersion=20260915101000 migrationsExecuted=6
   applied V20260901120000 baseline core schema        type=SQL  74ms
   applied V20260910093000 orders add settlement       type=SQL  17ms
   applied V20260910093100 orders add settle index     type=SQL  11ms
   applied V20260912140000 fix paid without paid at    type=SQL   2ms
   applied V20260915101000 customer add locale         type=SQL  11ms
   applied V              v order summary              type=SQL   4ms
```

```
installed_rank  version         description                type  execution_time  success
1               20260901120000  baseline core schema       SQL   74              1
2               20260910093000  orders add settlement      SQL   17              1
3               20260910093100  orders add settle index    SQL   11              1
4               20260912140000  fix paid without paid at   SQL    2              1
5               20260915101000  customer add locale        SQL   11              1
6               NULL            v order summary            SQL    4              1
```

📌 **注意第 6 列的 `version` 是 `NULL`** —— 那是 `R__`（6.3.3）。

**驗證**：

```sql
SELECT COUNT(*) FROM v_order_summary;       -- ✅ 視圖可用
SHOW CREATE TABLE orders;
```
```
  `settled_at` datetime(3) DEFAULT NULL,
  `settle_batch` varchar(32) DEFAULT NULL,
  KEY `idx_orders_settle` (`settle_batch`,`settled_at`),
```

---

**兩條路徑的等價性驗證**（6.9.1）：

```
路徑 A：空的 shop_a  → migrate 一次         → migrationsExecuted = 6
路徑 B：空的 shopmig → migrate（只有基準）  → migrationsExecuted = 1
                     → migrate（其餘全部）  → migrationsExecuted = 5

diff <路徑 A 的 schema>  <路徑 B 的 schema>
    →  ✅ 兩條路徑的 schema 完全一致
```

**黃金 schema 的樣子**（`golden-schema.sql`，共 150 行）：

```sql
CREATE TABLE `address` (
  `id` binary(16) NOT NULL,
  `customer_id` binary(16) NOT NULL,
  `recipient` varchar(64) NOT NULL,
  `phone` varchar(20) NOT NULL,
  `postal_code` varchar(10) NOT NULL,
  `line1` varchar(200) NOT NULL,
  `line2` varchar(200) DEFAULT NULL,
  `is_default` tinyint(1) NOT NULL DEFAULT '0',
  `default_marker` binary(16) GENERATED ALWAYS AS (if(`is_default`,`customer_id`,NULL)) VIRTUAL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_address_one_default` (`default_marker`),
  KEY `idx_address_customer` (`customer_id`),
  CONSTRAINT `fk_address_customer` FOREIGN KEY (`customer_id`) REFERENCES `customer` (`id`),
  CONSTRAINT `ck_address_is_default` CHECK ((`is_default` in (0,1)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='收件地址';
CREATE TABLE `customer` (
  `id` binary(16) NOT NULL COMMENT 'UUIDv7',
  `email` varchar(255) NOT NULL COMMENT 'RFC 5321 上限 254',
  `username` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  ...
  `version` bigint NOT NULL DEFAULT '0',
  `locale` varchar(10) NOT NULL DEFAULT 'zh-TW',      -- ← ⑤ 加的欄位在【最後】
  ...
```

📌 **三件只有從黃金 schema 才看得出來的事**：

```
① BOOLEAN 在 MySQL 裡真的是 tinyint(1)（01 章 1.6.1）
     → 所以 ck_address_is_default CHECK (is_default IN (0,1)) 是必要的
② username 的 as_cs 定序被【明確寫在欄位上】（00 章 0.5.8）
     → 如果哪天有人手動改掉，diff 立刻抓到
③ locale 出現在【最後】，不是宣告的位置
     → 6.7.3：INSTANT 加的欄位實體上永遠在最後
```

⚠️ **③ 有一個實務含意**：
如果你的黃金 schema 是從「舊環境增量遷移」dump 出來的，
而 CI 是從「空庫」dump 的 —— **欄位順序可能不同**，於是 diff 永遠是紅的。
✅ **所以黃金 schema 一定要從【空庫跑完全部遷移】的結果產生**
（6.9.3 的 CI 腳本就是這樣做的），而不是從正式環境 dump。

---

## 6.13 常見誤區

**誤區 1：「SQL 檔案放進 Git 就是版本控管了」**

→ 6.2.1：那只解決了「可審查」。剩下三個問題（不可重現、不知道差在哪、
沒有部分成功的概念）需要的是「**資料庫自己記得跑過什麼**」——
也就是 `flyway_schema_history` 這張表。

**誤區 2：「`ddl-auto=update` 可以當遷移工具」**

→ 6.2.2 實測：它**會**加欄位、加寬 `VARCHAR`、改型別（`DOUBLE`→`DECIMAL`）、建索引，
但**不會**把 `NULL` 改成 `NOT NULL`、**不會**刪多餘的欄位。
🔴 而「把 Entity 的欄位改名」它只下 `add column display_name` ——
舊資料**留在原欄位裡，程式永遠讀不到，沒有任何警告**。

**誤區 3：「`ddl-auto=validate` 可以當 schema 漂移的守門」**

→ 6.2.3 實測 9 種漂移，**只抓到 2 種**。
`VARCHAR(120)` 被改成 `VARCHAR(20)`、`NOT NULL` 變 `NULL`、
少了索引、少了唯一約束、多了欄位、`VARCHAR` 變 `TEXT` —— **全部通過**。
✅ 真正的守門是 6.9.3 的黃金 schema diff。

**誤區 4：「遷移腳本失敗了，所以什麼都沒改」**

→ 6.5.1 實測：三句 DDL 的腳本，第二句失敗 ——
**第一句加的欄位留下來了**，`history` 記 `success = 0`，服務起不來。
🔴 而 6.5.3 更糟：`UPDATE` → `ALTER`（隱式提交）→ 失敗，
餘額**從 100 變成 101**，而那個腳本「失敗了」。

**誤區 5：「`flyway repair` 會修好資料庫」**

→ 6.5.4 實測：`repair` 只做兩件事之一 ——
對齊 checksum，或**刪掉 `success = 0` 那一列**。
🔴 **它不執行任何 SQL、不碰 schema。**
實測：`repair` 之後直接 `migrate` → `ERROR 1060 Duplicate column name 'currency'`。
✅ 正確順序是 Flyway 訊息說的那樣：**先人工還原半完成的變更，再 `repair`。**

**誤區 6：「`git diff` 沒東西，所以腳本沒改」**

→ 6.3.5 實測：**行尾加三個空白，checksum 從 `-251176300` 變成 `1305258808`**。
而編輯器的「儲存時移除行尾空白」會**安靜地**做這件事，
`git diff` 幾乎看不出來，CI 也不會紅（CI 用空庫，沒有 history 可比）。
✅ 唯一可靠的防法：**已上線的遷移腳本不可修改**（pre-commit + CI 雙重擋）。
（好消息：CRLF、BOM、檔尾空行**都不影響** checksum。）

**誤區 7：「`V1.10` 排在 `V1.9` 前面」**

→ 6.3.4 實測：Flyway 是**數字比較**，順序是 `1.9 < 1.10 < 1.11 < 1.20 < 2`。
🔴 而檔名字串排序給你的是完全相反的 `1.1 < 1.10 < 1.11 < 1.2 < 1.9`。
另外：**`V1_20__x.sql` 的版本是 `1.20`** —— 底線也是分隔符，會跟 `V1.20__` 撞版本。

**誤區 8：「placeholder 讓同一份腳本能適應不同環境，很安全」**

→ 6.3.6 實測：`region=TW` 與 `region=JP` 的 **checksum 完全相同（`641203870`）**，
而兩個環境的 schema **不一樣**。
🔴 **Flyway 的 checksum 是對代換【前】的檔案算的** ——
這是一個「合法的、`validate` 永遠抓不到的」schema 漂移製造機。

**誤區 9：「8 個 Pod 同時啟動會互相打架」**

→ 6.5.6 實測：Flyway 用 `SELECT GET_LOCK('Flyway-<hash>', 10)` 互斥，
8 個實例只有 2 個各套用了 1 個遷移，全部成功。
而那個 `10` 只是單次嘗試的逾時 —— 它的重試迴圈是
`while (!tryLock()) Thread.sleep(100)`，**沒有上限**。
🔴 **所以真正的風險不是打架，是 `startupProbe` 先逾時把 Pod 殺掉**
（而 `ddl-auto=update` **完全沒有這個鎖**，8 個 Hibernate 會一起下 `ALTER`）。

**誤區 10：「`ALGORITHM=INSTANT` 是零成本，隨時可以跑」**

→ 6.7.4 實測：一個**只讀了一列**的未提交交易，
讓一句 89 ms 的 `INSTANT` DDL 花了 **11,241 ms**，
並且讓三個**在它之後才進來**的普通 `SELECT` 各等了 **9.3 ～ 9.7 秒**。
🔴 **MDL 在 `ALGORITHM` 之前，而 MDL 的隊伍是先進先出的。**

**誤區 11：「不寫 `ALGORITHM` 沒關係，MySQL 會選最好的」**

→ 6.7.2 實測：MySQL 8.0 **確實**選得很準（五種操作都選了最省的）。
但你還是要寫，理由是**防呆**：
你以為是 `INSTANT` 的操作（例如「加索引」）其實會安靜地跑 4 ～ 5 秒的表重建。
🔴 而 6.7.3 的 `ERROR 4092`（行版本滿了）也只有在**明確寫了 `INSTANT`** 時才會被抓到 ——
沒寫的話它會靜靜地退回 `COPY`，然後在正式環境跑 5 分鐘。

**誤區 12：「`ALGORITHM=INSTANT` 可以無限次用」**

→ 6.7.3 實測：**第 65 次就報 `ERROR 4092`**，
`information_schema.INNODB_TABLES.TOTAL_ROW_VERSIONS` 上限是 **64**。
✅ 要一次表重建才歸零。**把它加進月巡檢。**

**誤區 13：「`VARCHAR` 加長一定是 `INPLACE`（很快）」**

→ 6.7.2 實測：**看它會不會跨過 255 個宣告位元組**。
`VARCHAR(200)`→`VARCHAR(300)` 是 95 ms（`INPLACE`），
但 `VARCHAR(16)`→`VARCHAR(64)`（utf8mb4，64×4 = 256）是
**`ERROR 1846`，只剩 `COPY` 的 5.2 秒**。
✅ 實務結論：**utf8mb4 的欄位如果可能加長，一開始就宣告 `VARCHAR(64)` 以上。**

**誤區 14：「`lock_wait_timeout` 有預設值，所以 DDL 不會卡太久」**

→ 6.7.5 實測：預設是 **31,536,000 秒 = 365 天**（`innodb_lock_wait_timeout` 才是 50 秒）。
✅ 設成 5 秒之後，DDL 在 2,148 ms 就 `ERROR 1205` 放棄，
而後面的查詢立刻恢復到 105 ms。**DDL 快速失敗比慢慢成功好。**

**誤區 15：「線上改大表一定要用 `pt-osc` / `gh-ost`」**

→ 6.7.6 實測（100 萬列，同時有寫入）：
原生 `INPLACE, LOCK=NONE` 只讓線上寫入停頓 **33 ms**，
而 `pt-osc` 是 52 ～ 122 ms、**總耗時多 1.6 ～ 5.6 倍**。
✅ **原生支援的時候，原生就是最好的選項。**
🔴 `pt-osc` 存在的理由只有一個：`INPLACE` 給你 `ERROR 1846` 的那五類操作
（改型別、縮短長度、改定序、`DATETIME` 精度、`STORED` 生成欄位）——
那些原生只剩 `COPY`，而 `COPY` 的停頓 **≈ 它的總耗時（5,526 ms）**。

**誤區 16：「分批回填比較慢，所以一次刷完比較好」**

→ 6.6.5 實測：總耗時**幾乎一樣**（一次 11,269 ms、分批 1000 是 12,963 ms）。
🔴 但線上寫入的最長停頓是 **11,274 ms vs 279 ms —— 40 倍**。
**分批的目的不是變快，是讓別人插得進來。**

**誤區 17：「每個遷移都附一個回滾腳本，就安全了」**

→ 6.8.1：`DROP COLUMN` 的回滾腳本 `ADD COLUMN` **只把欄位加回來，資料回不來**。
`MODIFY amount DOUBLE` 的回滾**只把型別改回來，精度回不來**。
🔴 而且回滾腳本**從來沒有被測試過** —— 它只在半夜三點第一次執行。
✅ 正確的目標是 6.8 的 expand-contract：
**讓每一次變更都向後相容，於是不需要回滾 schema。**

**誤區 18：「加一個 `NOT NULL` 的欄位很安全，反正舊資料會填預設值」**

→ 6.8.2 實測的**不對稱**：
`ALTER TABLE ord ADD COLUMN note VARCHAR(200) NOT NULL`（無 `DEFAULT`）**會成功**，
舊列拿到隱式預設值（空字串）。
🔴 **但舊版程式碼的 `INSERT` 立刻死：`ERROR 1364 Field 'note' doesn't have a default value`。**
📌 **失敗時機是「部署成功之後的第一次寫入」** ——
遷移日誌是綠的、`success = 1`，然後三十秒後所有下單 API 開始 500。

**誤區 19：「用 `AFTER` 把欄位放在合理的位置比較整齊」**

→ 6.8.2 實測：在中間插欄位會讓所有「按位置取值」的舊程式碼錯位
（`rs.getString(3)` 從 `remark` 變成 `inserted_mid`）。
🔴 而 6.7.3：**`INSTANT` 加的欄位實體上永遠在最後**，`AFTER` 只改邏輯順序。
✅ 所以「整齊」是假的，「錯位」是真的。**新欄位一律加在最後。**

**誤區 20：「刪一個沒人用的欄位很安全」**

→ 6.8.4：`SELECT *`、視圖、生成欄位、資料倉儲、BI 報表、CDC、每月的對帳批次 ——
每一個都是「不在你的 repo 裡」的使用者。
✅ 用 6.8.4 的**改名觀察法**：先 `RENAME COLUMN remark TO remark_deprecated_20260903`
（111 ms、`INSTANT`、**隨時改回來**），
放兩週沒有 `ERROR 1054` 再刪。**把靜默的資料錯誤換成大聲的 SQL 錯誤。**

**誤區 21：「刪掉舊資料，磁碟就會釋放」**

→ 05 章 5.9.2 量到「刪 38.6% 的列，348 MB → 348 MB」。
6.7.9 實測：`DROP PARTITION` 刪 256,158 列只要 **132 ms**，
而且**檔案真的從 205 MB 縮到 153 MB**；
同一份資料用 `DELETE` 要 712 ms，**檔案一個位元組都沒少**。
✅ 「按時間刪舊資料」的正解是分區，不是 `DELETE` + `OPTIMIZE`。

**誤區 22：「分區表就是加一行 `PARTITION BY`，很簡單」**

→ 6.7.9 實測兩個硬限制：
🔴 `ERROR 1503`：**所有唯一索引都必須包含分區鍵** ——
於是 `order_no` 沒辦法全表唯一，只能 `(order_no, placed_at)` 唯一。
**這改變了業務約束。**
🔴 `ERROR 1506`：**分區表不能有外鍵**（訊息裡的 `not yet` 從 MySQL 5.1 就在那裡了）。
✅ 所以分區適合日誌型的表，**不適合大部分的業務主表**。

**誤區 23：「用 H2 跑遷移測試比較快」**

→ 6.9.2：H2 不認得 `ALGORITHM=INSTANT`、`LOCK=NONE`，
型別、定序、`sql_mode` 也都不同。
🔴 **而遷移測試的全部價值就是「確認它在真的 MySQL 上跑得過」** ——
用 H2 測，等於什麼都沒測。
✅ 用 Testcontainers 起真的 MySQL，**而且版本要跟正式環境一樣到小版本**
（8.0.28 與 8.0.29 的 `INSTANT` 支援範圍不同）。

**誤區 24：「CI 從空庫跑過遷移就夠了」**

→ 6.9.1：遷移有兩條路徑（空庫→最新、上一版→最新），而它們是**不同的程式**。
🔴 至少五個原因會讓兩條路徑分岔：`outOfOrder`、`repair` 過的 checksum、
placeholder、`SELECT *`／`CREATE TABLE LIKE`、有人手改過正式機。
✅ 第三個必要的測試是**比較兩條路徑的結果**（6.9.1 與 6.12 都實測驗證過這個做法有效）。

**誤區 25：「應用啟動時跑遷移最方便」**

→ 6.10.3：方便，但把「遷移時間」綁進了「健康檢查的逾時預算」。
🔴 一個 5 分鐘的加索引 + 60 秒的 `startupProbe` = `CrashLoopBackOff`，
而且**被殺掉的 Pod 可能正在跑那個 `ALTER`** → 回到 6.5.1 的半套用狀態。
✅ 正式環境用獨立的 Job（Helm `pre-upgrade` hook）——
它還帶來一個機制上的好處：**遷移失敗，新版程式碼根本不會部署**。
🔴 代價：遷移先跑完，那一刻線上跑的還是舊版程式碼 ——
**所以做法 C 讓 6.8 的向後相容從「好習慣」變成「強制要求」**。

**誤區 26：「遷移帳號跟應用帳號一樣就好，反正都是我們的服務」**

→ 6.10.2：應用帳號只需要 `SELECT/INSERT/UPDATE/DELETE`。
給它 `DROP` 權限的意思是「任何一個 SQL 注入漏洞都可以 `DROP TABLE`」。
✅ 分開之後還有兩個附加好處：
`flyway_schema_history.installed_by` 分得出「是遷移改的還是應用改的」，
以及 **6.5.7 的 `clean` 就算設定寫錯也跑不動 —— 權限比設定可靠。**

---

## 6.14 本章練習

### 練習 1：量出你自己專案的「ddl-auto 盲區」

拿你專案裡最複雜的一個 Entity，然後：

```
① 從正式環境（或它的唯讀副本）dump 出那張表的 SHOW CREATE TABLE
② 在本機起一個空的 MySQL，把那份 DDL 跑進去
③ 用 hbm2ddl.auto=update 跑你的 Entity，記下它下了哪些 SQL
④ 用 hbm2ddl.auto=validate 跑一次，記下它抓到什麼
```

**要回答的問題**：

```
① update 想改的那些東西，有幾個是你【真的想要】的？
② 有沒有出現 modify column（改型別）？那是不是不可逆的？
③ validate 通過了，但 ③ 的 diff 裡還有幾項它沒抓到？
```

📌 **這個練習的目的是讓你看到「你的 Entity 與資料庫已經分岔多少了」。**

---

### 練習 2：重現「行尾空白毀了一次部署」★

```
① 建一個空資料庫，跑一個只有 CREATE TABLE 的 V1，成功
② 記下 flyway_schema_history 的 checksum
③ 打開 V1，在最後一行的分號後面【加一個空白】，存檔
④ 再 migrate 一次
⑤ git diff 看看那個空白看不看得出來
```

**要回答的問題**：

```
① 錯誤訊息是什麼？它告訴你的兩個選項各有什麼後果？
② 如果你選 repair，資料庫的 schema 會變成正確的嗎？
③ 你的編輯器有開「儲存時移除行尾空白」嗎？（VS Code / IntelliJ 都要查）
④ 寫出一個 pre-commit hook，讓「已存在的遷移被修改」直接無法提交
```

---

### 練習 3：重現「89 毫秒的 DDL 卡住全站」★★

```
① 用一張至少 10 萬列的表
② 開一個 session：BEGIN; SELECT ... LIMIT 1;  （【不要 commit】）
③ 開第二個 session：ALTER TABLE ... ADD COLUMN x INT NULL, ALGORITHM=INSTANT;
④ 開第三、第四個 session：任何一句最簡單的 SELECT
⑤ 在第五個 session 裡跑 6.7.4 的三句排查查詢
```

**要回答的問題**：

```
① performance_schema.metadata_locks 裡有幾列？各是誰？
② SHARED_UPGRADABLE 與 EXCLUSIVE 為什麼是【同一個】OWNER_THREAD_ID？
③ ③ 的 SELECT 為什麼會被擋？它跟 ② 的長交易衝突嗎？
④ 把 ③ 的 session 加上 SET SESSION lock_wait_timeout = 2，重跑一次 ——
   ④ 的 SELECT 現在等多久？
```

---

### 練習 4：畫出你自己專案的 `ALTER` 矩陣 ★

在**跟正式環境同版本**的 MySQL 上，用**跟正式環境同量級**的資料，
把你**接下來三個月要做的 schema 變更**逐一試過：

```sql
-- 對每一個變更，依序試這四句，記下成功／錯誤碼與耗時
ALTER TABLE t <變更>, ALGORITHM=INSTANT;
ALTER TABLE t <變更>, ALGORITHM=INPLACE, LOCK=NONE;
ALTER TABLE t <變更>, ALGORITHM=INPLACE;
ALTER TABLE t <變更>, ALGORITHM=COPY;
```

**要回答的問題**：

```
① 有幾個變更只剩 COPY？它們是不是都在 6.7.2 的「改型別」那一類？
② 最慢的那個要多久？它超過你的 startupProbe 預算了嗎？
③ 有沒有任何一個報 ERROR 4092？（如果有，你已經欠一次表重建了）
④ 把每一個變更的實測耗時寫進遷移腳本的註解裡
```

---

### 練習 5：測出你的 `TOTAL_ROW_VERSIONS` ★

```sql
-- 對你正式環境（或它的副本）跑這一句
SELECT NAME, TOTAL_ROW_VERSIONS, N_COLS
FROM information_schema.INNODB_TABLES
WHERE NAME LIKE 'your_schema/%'
ORDER BY TOTAL_ROW_VERSIONS DESC;
```

**要回答的問題**：

```
① 最高的那張表是多少？離 64 還有多遠？
② 它是不是你最常改的那張表？（通常是）
③ 那張表重建一次要多久？（在副本上實測 OPTIMIZE TABLE）
④ 你要在什麼時候排這個維護？
```

---

### 練習 6：做一次完整的 expand-contract ★★

挑一個真實的需求：**把某個欄位改名，或改型別**。
然後**不要一步到位**，照 6.8.3 的六步做完，並且：

```
① 畫出你自己的相容矩陣（每一步 × 新舊程式碼）
② 找出「哪一步是唯一可能出錯的」，並寫下它的回退方式
③ 把回填寫成一個【可中斷續跑】的批次作業（6.6.5 的三個出口）
④ 在步驟 4 之前，跑那句 NOT (a <=> b) 的一致性檢查
```

**要回答的問題**：

```
① 總共花了幾次部署？中間有幾天？
② 步驟 3 的回填在正式環境跑了多久？線上寫入的最長停頓是多少？
③ 如果不做 expand-contract 而直接 RENAME COLUMN，
   你的滾動部署會有幾秒鐘的 500？（用 Pod 數 × rollout 間隔估）
```

---

### 練習 7：建立黃金 schema 守門 ★★

```
① 寫出 6.9.3 的 dump 腳本，產生第一份 golden-schema.sql
② 把它提交進版控
③ 🔴 用同一個腳本 dump 你的【正式環境】，跟 ② diff
```

**要回答的問題**：

```
① ③ 的 diff 有幾行？（第一次跑幾乎一定不是 0）
② 每一項差異的來源是什麼？（手改 / repair 過 / placeholder / 忘了部署？）
③ 這些差異裡，有幾項是 ddl-auto=validate 抓得到的？
④ 把 ① 的腳本接進 CI，讓它從今天起不會再變大
```

📌 **③ 的答案通常是「一兩項」—— 那就是 6.2.3 那個實驗的真實版本。**

---

### 練習 8：模擬 8 個 Pod 同時啟動 ★

```
① 寫一個遷移，內容是 CREATE TABLE + SELECT SLEEP(N)
② 用 8 個執行緒（各自獨立的 Flyway 實例）同時 migrate
③ 一邊跑一邊輪詢 information_schema.processlist
④ 把 N 調成 5、20、90，各跑一次
```

**要回答的問題**：

```
① processlist 裡看到的鎖是什麼？它的逾時參數是多少？
② N = 90 的時候有實例失敗嗎？為什麼？
③ 你的 startupProbe 預算是多少秒？N 要多大才會 CrashLoopBackOff？
④ 改成 6.10.3 做法 C（獨立 Job），②③ 的答案會怎麼變？
```

---

## 6.15 完成本章後，請確認你有

```
✅ 版控裡有一份【可以從零建出完整 schema】的遷移腳本集
     ├─ V1（或基準版本）= 目前正式環境的 schema
     ├─ ★ 正式環境用 baselineOnMigrate + baselineVersion 接上（6.4）
     ├─ 新環境不設 baseline，從零跑（6.4 的四步流程）
     └─ ★ 兩條路徑產出的 schema 已經 diff 過，確認一致（6.9.1）

✅ 所有環境的 ddl-auto 都是 none
     ├─ 本機 / 單元測試：update 或 create-drop（可以）
     ├─ ★ 測試 / 預備 / 正式：none（沒有例外）
     └─ validate 可以留著當煙霧偵測器，但【不是】守門（6.2.3）

✅ 團隊的版本命名策略寫進 CONTRIBUTING
     ├─ 超過 3 個人 → 時間戳（V20260903121500__）
     ├─ ★ CI 檢查檔名格式
     └─ ★ CI 檢查「新版本 > master 最大版本」（防 out-of-order，6.5.5）

✅ 🔴「已上線的遷移腳本不可修改」有機制擋著
     ├─ pre-commit hook
     ├─ CI 檢查 git diff --diff-filter=M
     └─ ★ 這一條比「小心不要動到空白」可靠得多（6.3.5）

✅ 每一個遷移腳本都符合這五條
     ├─ 一個腳本只做一件事（DDL 與 DML 絕不混，6.5.3）
     ├─ ★ ALTER TABLE 明確寫 ALGORITHM（防呆，不是效能建議）
     ├─ ★ ALTER TABLE 前面有 SET SESSION lock_wait_timeout = 5（6.7.5）
     ├─ 新欄位一律【可空或有 DEFAULT】、一律加在【最後】（6.8.2）
     └─ 註解寫了：為什麼要改 / 為什麼用這個演算法 / 實測耗時 + 正式環境推估

✅ 每一個 schema 變更都問過「這需要幾次部署？」（6.8.5 的表）
     ├─ 加欄位 / 加索引     → 1 次
     ├─ ★ 改欄位名          → 6 次
     ├─ ★ 改型別            → 5 ~ 6 次
     ├─ 刪欄位              → ≥ 3 次（含改名觀察期）
     └─ 🔴 加 NOT NULL 無 DEFAULT 的欄位 → 不要做

✅ 一組 CI 守門（6.9）
     ├─ 硬斷言：從空庫 migrate 成功
     ├─ 硬斷言：migrate 之後 validate 通過
     ├─ 硬斷言：沒有 success = 0 的紀錄
     ├─ ★ 硬斷言：路徑 A 與路徑 B 的 schema 一致
     ├─ ★ 硬斷言：黃金 schema diff 為空
     ├─ lint：檔名格式 / 危險操作要批准註解 / 行尾空白 / SELECT * / 混 DDL+DML
     └─ 🔴 測試用真的 MySQL（Testcontainers），版本對到小版本

✅ 遷移的執行方式已經按規模選過（6.10.3）
     ├─ 全部遷移都是毫秒級 → 應用內遷移可以
     ├─ ★ 有分鐘級的遷移   → 獨立 Job（Helm pre-upgrade hook）
     ├─ ★ startupProbe 的預算 > 最慢遷移的預估時間
     └─ 🔴 用獨立 Job 之後，expand-contract 是【強制的】，不是選項

✅ 資料庫帳號分開了（6.10.2）
     ├─ shop_app      ：SELECT / INSERT / UPDATE / DELETE
     ├─ shop_migrate  ：+ CREATE / ALTER / DROP / INDEX / REFERENCES / ROUTINE
     ├─ shop_readonly ：SELECT / SHOW VIEW / PROCESS（給巡檢用）
     └─ ★ 這讓 clean 就算設定寫錯也跑不動 —— 權限比設定可靠

✅ 大表變更的預備動作
     ├─ ★ 知道每張大表現在的 TOTAL_ROW_VERSIONS（離 64 多遠，6.7.3）
     ├─ 知道 pt-osc / gh-ost 哪一個適合你（有沒有外鍵、有沒有 REPLICATION 權限）
     ├─ ★ 確認過磁碟有【表大小 × 2】的空閒空間
     ├─ 大表回填一律分批（1000 ~ 5000），且有時間 / 輪數 / 負載三個出口
     └─ 「按時間刪舊資料」的表已經評估過分區（6.7.9 的兩個硬限制）

✅ 一份排查手冊（6.5.8）
     ├─ 七種啟動失敗的症狀 → 真正的原因 → 處理步驟
     ├─ 三句查詢：success=0 / current version / 誰卡在 GET_LOCK
     ├─ ★ 三句 MDL 排查：誰在等 / 誰是源頭長交易 / 完整隊伍（6.7.4）
     └─ 🔴 明確寫下「repair 不會執行任何 SQL」

✅ 你能回答這十個問題（不查資料）
     ├─ ddl-auto=update 會做什麼、不會做什麼？改欄位名會怎樣？
     ├─ 一個腳本三句 DDL，第二句失敗了 —— 資料庫現在是什麼狀態？怎麼修？
     ├─ UPDATE → ALTER → 失敗，那個 UPDATE 提交了嗎？為什麼？
     ├─ flyway repair 執行了什麼 SQL？
     ├─ 行尾加一個空白，checksum 會變嗎？CRLF 呢？
     ├─ 8 個 Pod 同時啟動，Flyway 怎麼互斥？它的重試有上限嗎？
     ├─ ALGORITHM=INSTANT 的 DDL 為什麼可能跑 11 秒？
     ├─ VARCHAR(16) → VARCHAR(64) 為什麼要 COPY，而 (200) → (300) 不用？
     ├─ 改一個欄位名要幾次部署？中間哪一步最危險？
     └─ 為什麼「準備回滾腳本」不是正確的目標？
```

---

## 6.16 本章的實驗環境與結果

**環境**：

| 項目 | 版本 / 規模 |
|---|---|
| 資料庫 | **MySQL 8.0.46**（Docker），`--log-bin` + `--binlog-format=ROW`、`innodb_buffer_pool_size=512M`、`log_slow_admin_statements=ON` |
| 遷移工具 | **Flyway 10.20.1**（`flyway-core` + `flyway-mysql`） |
| ORM | **Hibernate ORM 6.6.4.Final**（`hbm2ddl.auto` 的實驗） |
| 線上變更工具 | **pt-online-schema-change 3.7.1-4**（`percona/percona-toolkit` 映像） |
| 實驗表 `ord` | **1,000,000 列**，資料 **135.7 MB** + 索引 **85.2 MB** |
| 實驗表 `ord_p` | **1,000,000 列**，按月 `RANGE` 分區（5 個分區，各 ~30 MB） |
| 應用程式 | **JDK 21**、mysql-connector-j **8.3.0** |
| 平台 | macOS 14.2.1 / Apple Silicon，8 核心，NVMe SSD |

⚠️ **本章的「耗時」數字有兩類，要分開讀**：

```
✅ 與硬體【無關】的：錯誤碼、支援 / 不支援、TOTAL_ROW_VERSIONS 的 64、
                    checksum、版本排序、GET_LOCK 的行為、分區的裁剪結果
                    → 這些在任何機器上都一樣，可以直接照抄結論

🟡 與硬體【有關】的：所有 ms 數字（INSTANT 的 89 ms、COPY 的 5 秒、
                    pt-osc 的 10 秒、回填的 11 秒）
                    → 這些是【比例】有意義（INSTANT vs INPLACE 差 40 倍），
                      絕對值請在你自己的環境重量（練習 4）
```

**跑過的實驗（38 組）**：

| 組 | 實驗 | 結果 |
|---|---|---|
| **A1** | `ddl-auto=update` 對 7 種差異的行為 ★★ | ✅ 加欄位 / 加寬 `VARCHAR` / 改型別 / 建索引 / 建唯一約束 —— **都做**<br>🔴 `NULL`→`NOT NULL`**不改**；多餘欄位**不刪**<br>⚠️ `level INT NOT NULL` 加到有資料的表 → **靜默填 0** |
| **A2** | `ddl-auto=update` 遇到「欄位改名」★ | 🔴 只下 `add column display_name` —— 舊資料 `'小艾'` **留在 nickname，程式讀到 NULL** |
| **A3** | `ddl-auto=validate` 對 9 種漂移 ★★ | 🔴 **只抓到 2 種**（缺欄位、`DECIMAL`↔`DOUBLE`）<br>🔴 長度 / 可空性 / 索引 / 唯一約束 / 多餘欄位 / `VARCHAR`→`TEXT` **全部通過** |
| **F1** | `flyway_schema_history` 的結構與內容 | ✅ 10 個欄位；`BASELINE` 那列 `checksum = NULL` |
| **F2** | 版本排序（11 個檔案）★ | ✅ `1 < 1.1 < 1.2 < 1.9 < 1.10 < 1.11 < 1.20 < 2 < 2.0.1 < 10 < 20260903.1200`<br>🔴 檔名字串排序**完全相反**；`V1_20__` 被解析成版本 **1.20** |
| **F3** | 撞版本 | ✅ `V2` vs `V2.0` → `Found more than one migration with version 2`（啟動即失敗）<br>✅ `V1_20` vs `V1.20` → 同樣撞在版本 `1.20` |
| **F4** | checksum 對 8 種變動的敏感度 ★★ | 🔴 **行尾加三個空白 → 變了**（`-251176300` → `1305258808`）<br>✅ **CRLF / BOM / 檔尾空行 / 移除檔尾換行 / 改檔名 → 都不變**<br>⚠️ 加註解、改縮排 → 變（合理） |
| **F5** | placeholder 與 checksum ★★ | 🔴 `region=TW` 與 `region=JP` 的 checksum **都是 `641203870`**，而 schema **不同** |
| **F6** | 三句 DDL，第二句失敗 ★★ | 🔴 第一句的 `currency` 欄位**留下來了**；`success = 0`<br>🔴 重啟 → `FlywayValidateException: Detected failed migration to version 2` |
| **F7** | 純 DML 腳本，第二句失敗（對照組） | ✅ **完整回滾**（`bal` 留在 100）<br>⚠️ 但 `success = 0` 還在，還是要 `repair` |
| **F8** | `UPDATE` → `ALTER` → 失敗 ★★ | 🔴 `bal` **從 100 變成 101** —— `ALTER` 的隱式提交把 `UPDATE` 落地了 |
| **F9** | `repair` 對失敗遷移做什麼 ★★ | ✅ `[Removed failed migrations]` —— **刪掉那一列**<br>🔴 之後直接 `migrate` → `ERROR 1060 Duplicate column name 'currency'` |
| **F10** | `repair` 對 checksum mismatch 做什麼 ★ | ✅ `[Aligned applied migration checksums]`<br>🔴 **schema 完全沒變**（表裡沒有 `name` 欄位）→ 永久漂移 |
| **F11** | out-of-order | ✅ 預設 → `Detected resolved migration not applied to database: 2`；`info` 標 `IGNORED`<br>🔴 開了之後 `installed_rank 3` 的版本是 `2` —— 執行順序與版本順序分岔 |
| **F12** | 既有資料庫接 Flyway | ✅ 不設 baseline → `Found non-empty schema(s) but no schema history table`<br>✅ `baselineOnMigrate` + `baselineVersion=1` → 一列 `type=BASELINE`、`checksum=NULL` |
| **F13** | `R__` 可重複遷移 | ✅ 內容不變 → `migrationsExecuted = 0`；內容改了 → 重跑<br>📌 history **多一列**（`version = NULL`，checksum 不同） |
| **F14** | 8 個實例同時 `migrate` ★★ | ✅ `SELECT GET_LOCK('Flyway-1247173368', 10)`；只有 2 個實例各套用 1 個遷移<br>✅ 全部成功，總牆鐘 5,877 ms |
| **F15** | 遷移比鎖逾時還久（15 s / 75 s） | ✅ **沒有任何實例失敗**<br>📌 反編譯 `MySQLNamedLockTemplate.lock()`：`while (!tryLock()) sleep(100)` —— **無上限重試** |
| **F16** | `clean` 的預設值 | ✅ Flyway 10 預設 `cleanDisabled = true` → `Unable to execute clean as it has been disabled` |
| **F17** | `beforeMigrate` 用 `SIGNAL` 守門 ★ | ✅ `latin1` 的資料庫 → `SQLSTATE 45000` / `Error Code 1644` / 自訂訊息，**V1 的表沒有被建立**<br>⚠️ 但 `flyway_schema_history` 已經先建了 |
| **F18** | 幂等 DDL 的支援度 ★ | ✅ `CREATE/DROP TABLE IF [NOT] EXISTS`、`CREATE DATABASE IF NOT EXISTS`、`CREATE OR REPLACE VIEW`<br>🔴 `ADD COLUMN` / `DROP COLUMN` / `CREATE INDEX` / `DROP INDEX` / `ADD INDEX` 的 `IF [NOT] EXISTS` —— **全部 `ERROR 1064`** |
| **F19** | 預存程序版的幂等助手 | ✅ 第一次「已加上」、第二次「略過（已存在）」<br>✅ **Flyway 認得 `DELIMITER`**，可以直接放進 `.sql` |
| **D1** | 19 種操作 × 3 種 ALGORITHM ★★ | ✅ `INSTANT` 89 ～ 339 ms（**與列數無關**）<br>🔴 同樣的「加欄位」用 `INPLACE` 是 **3,983 ms（40 倍）**<br>🔴 改型別 / 縮短 / 改定序 / `STORED` 生成欄位 → **只剩 `COPY`（4.5 ～ 5.2 s）** |
| **D2** | 不指定 `ALGORITHM` 時 MySQL 選什麼 | ✅ 五種操作**都選了最省的**（加欄位 → `INSTANT` 307 ms；加索引 → `INPLACE` 1,467 ms；改型別 → `COPY` 7.6 ～ 8.2 s） |
| **D3** | `INSTANT` 的行版本上限 ★★ | 🔴 **第 65 次 → `ERROR 4092`**；`TOTAL_ROW_VERSIONS = 64`<br>✅ 表重建後歸零，再加一次變成 1 |
| **D4** | `VARCHAR` 加長的 `INPLACE` 邊界 ★★ | ✅ 邊界正好是 **255 個宣告位元組**<br>utf8mb4：`(16)→(63)` = 252 B ✅；`(16)→(64)` = 256 B 🔴 `ERROR 1846`<br>latin1：`(255)` ✅；`(256)` 🔴<br>📌 重點是**跨過**，不是大小 —— `(200)→(300)` 兩邊都 ≥256，所以 ✅ |
| **D5** | MDL 隊頭阻塞 ★★（回答 04 章） | 🔴 89 ms 的 `INSTANT` DDL 花了 **11,241 ms**<br>🔴 三個**後來才進來**的 `SELECT` 各等 **9,335 / 9,529 / 9,733 ms**<br>✅ `metadata_locks` 六列：`SHARED_READ` GRANTED → `SHARED_UPGRADABLE` GRANTED + `EXCLUSIVE` PENDING → 三個 `SHARED_READ` PENDING |
| **D6** | `lock_wait_timeout` ★ | 🔴 預設 **31,536,000 秒（365 天）**<br>✅ 設 2 → `ERROR 1205` in **2,148 ms**；之後的查詢 **105 ms（沒被堵）** |
| **D7** | 三方對照：線上寫入的停頓 ★★ | ✅ 原生 `INPLACE, LOCK=NONE`：6,414 ms / 停頓 **33 ms**<br>🔴 原生 `COPY`：5,621 ms / 停頓 **5,526 ms（≈ 全程）**<br>✅ `pt-osc`（chunk 5000）：10,221 ms / 停頓 **122 ms**<br>✅ `pt-osc`（chunk 2000 + sleep 0.05）：36,000 ms / 停頓 **52 ms**<br>📌 四種做法**寫入失敗次數都是 0** |
| **D8** | `pt-osc` 的完整機制 | ✅ 影子表 `_ord_new` + **3 個觸發器**（ins/upd/del）+ 分塊 `INSERT LOW_PRIORITY IGNORE ... LOCK IN SHARE MODE` + `RENAME TABLE` + 收尾<br>✅ 進行中同時觀察到 `_ord_new` 73.6 MB 與 `ord` 135.7 MB **並存** |
| **B1** | 大表回填：一次 vs 分批 ★★ | 🔴 一次全刷 1,021,679 列：11,269 ms / **線上寫入停頓 11,274 ms（≈ 全程）**<br>✅ 分批 1000（1,027 輪）：12,963 ms / **停頓 279 ms（40 倍）**<br>🟡 分批 5000：11,306 ms / 537 ms；分批 50000：9,950 ms / 434 ms<br>📌 **總耗時幾乎一樣 —— 分批換的是停頓，不是速度** |
| **P1** | `DROP PARTITION` vs `DELETE` ★（回答 05 章） | ✅ `DROP PARTITION` 刪 256,158 列：**132 ms**，檔案 **205 MB → 153 MB**<br>🔴 `DELETE` 刪 231,966 列：712 ms，檔案 **153 MB → 153 MB（沒變）** |
| **P2** | 分區裁剪 | ✅ `RANGE COLUMNS(placed_at)` → `partitions: p202603`（精確）<br>🟡 `RANGE (TO_DAYS(placed_at))` → `partitions: p202602,p202603`（多一個）<br>🔴 條件不含分區鍵 → **五個分區全掃**、`key: NULL` |
| **P3** | 分區的兩個硬限制 | 🔴 `ERROR 1503`：唯一索引**必須包含分區鍵**（`uk_order_no(order_no)` 建不起來）<br>🔴 `ERROR 1506`：分區表**不能有外鍵** |
| **C1** | CI：兩條路徑的等價性 ★★ | ✅ 空庫→最新（3 個遷移）與 上一版→最新（2 + 1）的 schema **完全一致**<br>✅ 在其中一邊手動 `ADD COLUMN hotfix` → **diff 立刻抓到**（而 `validate` 抓不到） |
| **C2** | shop-service 完整遷移集 ★ | ✅ 6 個腳本（基準 74 ms + `INSTANT` 17 ms + `INPLACE` 索引 11 ms + DML 2 ms + `INSTANT` 11 ms + `R__` 視圖 4 ms）全部 `success = 1`<br>✅ 兩條路徑的 schema 一致；黃金 schema 150 行 |
| **E1** | `NOT NULL` 無 `DEFAULT` 的不對稱 ★★ | ✅ `ALTER` **成功**（舊列拿到隱式預設值 `''`）<br>🔴 舊版程式碼的 `INSERT` → **`ERROR 1364 Field 'note' doesn't have a default value`** |
| **E2** | 在中間插欄位 | 🔴 `AFTER order_no` 讓後面所有欄位的**位置索引位移** —— `rs.getString(3)` 從 `remark` 變成 `inserted_mid` |

🔴 **本章沒有驗證到的**：

| 沒驗證的 | 影響哪一節 | 說明 |
|---|---|---|
| **`gh-ost`** 的實測數字 | 6.7.8 | 沒有官方 Docker 映像；而「偽裝成從庫讀 binlog」在單機容器裡量出來的數字對正式環境沒有參考價值。**6.7.8 的機制描述來自文件，不是本章量測** |
| **Testcontainers** 的實際執行 | 6.9.2 | 本章用手動 `docker run` 起容器，流程等價。Testcontainers 對 Docker 版本較敏感 |
| **千萬～億列規模**的 `ALTER` 耗時 | 6.7 全節 | 本章 100 萬列。`INSTANT` 與列數無關（可外推），`INPLACE`／`COPY` **不可線性外推**，請用練習 4 自己量 |
| **真正慢的磁碟**（雲端網路磁碟 / 機械硬碟）上的 `COPY` 成本 | 6.7.6 | 05 章 5.2 說明過為什麼本機 NVMe SSD 會把這一半藏起來 |
| **從庫延遲**對 `pt-osc --max-lag` 的實際影響 | 6.7.7 | 需要主從架構 → **07 章** |
| **`pt-osc` 的外鍵處理**（`rebuild_constraints` / `drop_swap`）實測 | 6.7.7 | 需要有外鍵的大表組合，本章只描述機制 |
| **Kubernetes 上的 `CrashLoopBackOff`** 實際重現 | 6.5.6、6.10.3 | 本章用 Flyway 的鎖行為 + probe 的算術推導，沒有真的起 k8s |
| **多租戶 500 個 schema** 的遷移耗時 | 6.10.5 | 只給了做法與巡檢查詢 |
| **Liquibase** 的實測對照 | 6.11 | 只做特性對照，沒有實跑 |
| **備份與還原**（Flyway 訊息裡那句 `restore backups`） | 6.5.1 | **07 章 7.2** |

> 📌 **最後一句話**：
>
> 這一章有**四個實測結果，跟「大家都這樣說」不一樣**：
>
> **①「遷移失敗了，所以什麼都沒改」** ——
> F6 顯示三句 DDL 的第一句**留下來了**；
> F8 顯示 `UPDATE` → `ALTER` → 失敗，餘額**留在改過的值上（101）**。
> 🔴 **MySQL 沒有 DDL 交易，所以「腳本的粒度」就是你唯一的回滾粒度。**
>
> **②「`repair` 會修好資料庫」** ——
> F9 顯示 `repair` 只是**刪掉那一列 history**，
> 然後下一次 `migrate` 撞上 `ERROR 1060 Duplicate column name`；
> F10 顯示 checksum 的 `repair` **一行 SQL 都不執行**，
> 留下一個「版控說有、資料庫說沒有」的永久分岔。
> 🔴 **`repair` 修的是紀錄，不是資料庫。**
>
> **③「`ALGORITHM=INSTANT` 是零成本」** ——
> D5 顯示一個**只讀了一列**的未提交交易，
> 讓 89 ms 的 DDL 變成 **11,241 ms**，
> 並讓三個**在它之後才進來**的普通 `SELECT` 各等 **9.3 ～ 9.7 秒**。
> 🔴 **MDL 在 `ALGORITHM` 之前，而 MDL 的隊伍是先進先出的 ——
> 所以「DDL 快不快」根本不是問題，「DDL 拿不到鎖時會擋住誰」才是。**
>
> **④「線上改大表要用 `pt-osc` / `gh-ost`」** ——
> D7 顯示原生 `INPLACE, LOCK=NONE` 讓線上寫入只停頓 **33 ms**，
> 比 `pt-osc` 的 52 ～ 122 ms **更短**，而且總耗時少 1.6 ～ 5.6 倍。
> ✅ **`pt-osc` 存在的理由只有 `ERROR 1846` 那五類操作** ——
> 它們原生只剩 `COPY`，而 `COPY` 的停頓 **≈ 它的全部耗時**。
>
> ⚠️ **這四個有一個共同點**：
>
> > **它們都不是「Flyway 怎麼用」的問題，是「資料庫的變更本質上是單向的」的問題。**
> > 01 ～ 03 章的錯，改對就好。
> > 04 章的錯，加鎖就好。05 章的錯，改量計數就好。
> > **這一章的錯，資料庫的狀態改不回去。**
>
> **所以本章唯一的方法論是這三句話**：
>
> > **不要準備回滾腳本，要讓每一次變更都不需要回滾（6.8）。**
> > **不要問「這個 `ALTER` 多快」，要問「它拿不到鎖的時候會擋住誰」（6.7.4）。**
> > **不要相信「跑過就一樣」，要 diff 兩條路徑的 schema（6.9.1）。**
>
> **下一章開始講上線維運。** 07 章要還兩筆帳：
> **6.5.1 那句 `Please restore backups` —— 你的備份真的還原得回來嗎？**
> 以及 **6.7.7 的 `pt-osc --max-lag 2` ——「從庫延遲」到底是什麼，
> 為什麼它會讓一個讀寫分離的服務讀到「還沒發生的過去」？**

---

**上一章**：[05-query-performance-tuning.md](./05-query-performance-tuning.md) — 效能調校
**下一章**：[07-backup-replication-and-production.md](./07-backup-replication-and-production.md) — 備份、複製與上線維運
