# 06 — Repository（資料存取層）

> Repository 的價值在於**把「資料怎麼存」封裝起來**，讓 Service 不必知道背後是 MySQL、快取還是外部服務。
> 這一站先講清楚這層的抽象與邊界、連線池怎麼調、交易在哪裡開始結束；
> 至於 ORM 細節，留到 [08-jpa-mybatis/](../08-jpa-mybatis/) 深入。

---

## 學完你可以

- 說明 Repository 模式解決什麼問題，以及它與 DAO 的差異。
- 設定與調校 HikariCP 連線池，並判斷「連線池耗盡」的根因。
- 用 JdbcTemplate 寫出安全的原生 SQL（含具名參數與批次操作）。
- 使用 Spring Data 的方法命名查詢、`@Query` 與 Pageable，知道它們何時不夠用。
- 說明交易邊界為什麼要在 Service 而不是 Repository。
- 用 `@DataJpaTest` 與 Testcontainers 寫出貼近正式環境的資料層測試。

## 前置知識

[05-service/](../05-service/) 02 章（交易），以及基本 SQL。

---

## 章節目錄

| 章節 | 檔案 | 主題 | 重點 |
|------|------|------|------|
| 00 | `00-course-map-data-access-layer.md` | 課程地圖與資料層定位 | Repository vs DAO、抽象的價值與過度抽象的代價、介面設計原則 |
| 01 | `01-datasource-and-connection-pool.md` | 資料來源與連線池 | JDBC URL 參數、HikariCP 關鍵設定、池大小怎麼算、連線洩漏診斷 |
| 02 | `02-jdbc-and-jdbctemplate.md` | JDBC 與 JdbcTemplate | `PreparedStatement` 與 SQL Injection、`RowMapper`、具名參數、批次寫入、`JdbcClient` |
| 03 | `03-spring-data-repository-abstraction.md` | Spring Data 抽象 | `Repository` 家族階層、方法命名查詢規則、`@Query`、投影（Projection）、動態代理原理 |
| 04 | `04-pagination-sorting-and-dynamic-query.md` | 分頁、排序與動態查詢 | `Pageable` / `Slice` / `Page`、`Sort`、`Specification`、大量資料分頁的效能陷阱 |
| 05 | `05-transaction-boundary-and-batch.md` | 交易邊界與批次操作 | 為何邊界在 Service、唯讀交易、flush 時機、批次寫入、大量資料串流讀取 |
| 06 | `06-repository-testing.md` | 資料層測試 | `@DataJpaTest`、為什麼 H2 會騙你、Testcontainers 跑真 MySQL、測試資料準備與清理 |

---

## 常見誤區（課程會逐一破解）

- 連線池大小設成 100，以為越大越快，實際上資料庫先被打垮。
- 用字串拼接組 SQL，直接開一扇 SQL Injection 大門。
- 在 Repository 方法上加 `@Transactional`，導致每次呼叫各開一個交易，無法組成原子操作。
- 用 H2 測試通過，上線遇到 MySQL 的語法 / 排序規則差異才爆炸。
- 一次 `findAll()` 撈 50 萬筆進記憶體，直接 OOM。

## 產出

把 05-service 的記憶體假實作換成**真的資料存取層**：
先用 JdbcTemplate 實作一版，再用 Spring Data 實作第二版，同一組介面兩種實作互相對照，
並用 Testcontainers 跑真 MySQL 驗證兩者行為一致。
