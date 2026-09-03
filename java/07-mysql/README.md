# 07 — MySQL 實戰

> 後端服務的效能瓶頸，八成在資料庫。
> 這一站從 Java 專案的角度看 MySQL：schema 怎麼設計、索引為什麼沒用到、交易與鎖何時互卡、慢查詢怎麼抓。

> 想看資料庫**選型與通論**（PostgreSQL、MongoDB、Redis、分片、高併發搶票），
> 請搭配 [../../database-course/](../../database-course/)；本站專注 MySQL 與 Java 應用的交界。

---

## 學完你可以

- 用 Docker 起一個字元集、時區、大小寫設定都正確的 MySQL。
- 設計符合需求的 schema：選對資料型別、主鍵策略與索引。
- 讀懂 `EXPLAIN`，判斷查詢有沒有走索引、走了哪一條。
- 說明 InnoDB 的 MVCC、四種隔離級別、行鎖與間隙鎖，並排查死鎖。
- 抓出慢查詢並優化，包含深分頁與大量寫入。
- 用 Flyway 管理 schema 版本，讓資料庫變更跟著程式碼一起進版控。
- 在**不停機**的前提下改一張千萬列的大表，並說得出為什麼選那個 `ALGORITHM`。
- 用 `--exclude-gtids` 做**點時間復原**，只跳過誤刪的那一個交易。
- 建一組 GTID 主從複製，量出**真實的**複製延遲，並做出安全的讀寫分離。

## 前置知識

基本 SQL（`SELECT` / `INSERT` / `UPDATE` / `DELETE`）。

---

## 章節目錄

| 章節 | 檔案 | 主題 | 重點 |
|------|------|------|------|
| 00 | [`00-course-map-install-and-connect.md`](./00-course-map-install-and-connect.md) ✅ | 課程地圖、環境與連線 | Docker 起一個設定正確的 MySQL 8、字元集與**定序**（emoji 事故）、時區的四個層次與 JDBC 參數、`caching_sha2_password`、`sql_mode`、大小寫、三組守門測試 |
| 01 | [`01-schema-design-and-data-types.md`](./01-schema-design-and-data-types.md) ✅ | Schema 設計與資料型別 | `ALTER` 的三種演算法、金額為什麼不能用 float/double、字串與**宣告長度的真實代價**、`DATETIME(3)`、NULL 的三值邏輯、**四種主鍵實測**、約束與**軟刪除唯一索引的陷阱**、完整 schema |
| 02 | [`02-sql-crud-join-and-aggregate.md`](./02-sql-crud-join-and-aggregate.md) ✅ | SQL 核心：JOIN 與聚合 | 邏輯執行順序、**`ON` vs `WHERE`**、**一對多 JOIN 的列數膨脹**、函式依賴與 `GROUP BY`、`GROUP_CONCAT` 的靜默截斷、**`NOT IN` 的兩側 NULL**、CTE 與遞迴、視窗函式與**它的框架陷阱**、UPSERT 三種寫法、**隱式轉型** |
| 03 | [`03-index-and-explain.md`](./03-index-and-explain.md) ✅ | 索引與執行計畫（核心章） | B+Tree 與樹高、聚簇索引與**回表成本**、`EXPLAIN` 十二欄與 **`key_len` 算術**、四種工具（含 `EXPLAIN ANALYZE` / `optimizer_trace`）、最左前綴與 **skip scan**、排序消除、覆蓋索引、**索引失效八情境與三個反例**、複合 vs 單欄、前綴/函式/不可見索引、**深分頁**、統計與**直方圖** |
| 04 | [`04-transaction-isolation-and-lock.md`](./04-transaction-isolation-and-lock.md) ✅ | 交易、隔離與鎖（核心章） | ACID **四個字母各自由誰負責**、**語句失敗 ≠ 交易回滾**、隱式提交、MVCC **版本鏈與 ReadView**、**長交易讓查詢慢 20 倍**、五種異常 × 四種級別（含 **RR 擋不住的寫偏斜**）、**七組加鎖範圍實測**、**無索引 = 鎖全表（併發差 10.8 倍）**、**鎖跟著優化器選的索引走**、MDL 三層阻塞、**五種死鎖模式**、**`1205` vs `1213`**、**`@Transactional` 八個坑**、**20 人搶 10 庫存六種寫法** |
| 05 | [`05-query-performance-tuning.md`](./05-query-performance-tuning.md) ✅ | 效能調校 | **buffer pool 與熱資料集**（本機量不到的那一半）、慢查詢日誌與 **digest 表**、**鎖等待長什麼樣子**、批次寫入 **22.6 倍**、**hash join vs nested loop 的交叉點**、**`IN` 的 200 懸崖**、`Sort_merge_passes` 與**暫存表落地**、深分頁與 **JDBC 串流**、**分批 DELETE 與空間回收**、**連線數曲線**、Java 端**八個反模式** |
| 06 | [`06-schema-migration-flyway.md`](./06-schema-migration-flyway.md) ✅ | Schema 版本控管與線上變更（核心章） | **`ddl-auto=update` 做了什麼／不做什麼**、`validate` **9 種漂移只抓到 2 種**、`flyway_schema_history` 十欄、**版本排序與撞版本**、**checksum 對行尾空白敏感**、**placeholder 同 checksum 不同 schema**、🔴 **MySQL 沒有 DDL 交易**（三種失敗形態）、**`repair` 的真相**、**8 個 Pod 同時啟動的鎖**、**19 種 `ALTER` × 3 種 `ALGORITHM` 實測矩陣**、**`INSTANT` 的 64 次上限**、**MDL 讓 89 ms 的 DDL 卡住全站 11 秒**、**原生 vs `COPY` vs `pt-osc` 三方對照**、**分區 `DROP` vs `DELETE`**、**expand-contract 六次部署**、黃金 schema 守門 |
| 07 | [`07-backup-replication-and-production.md`](./07-backup-replication-and-production.md) ✅ | 備份、複製與上線維運（核心章） | **備份 1.6 秒／還原 27 秒**、**`mysqldump` 四種鎖模式**（一致性 vs 阻塞）、🔴 **一句 DDL 讓備份留下 194 MB 的壞檔案**、備份腳本六個檢查、**PITR 用 `--exclude-gtids` 只跳過誤刪那一句**、**`STATEMENT` 格式讓主從資料分岔**、GTID 複製、🔴 **`Seconds_Behind_Source` 的三個問題**、**心跳表**、🔴 **`read_only` 擋不住 `root`**、🔴 **讀己之寫 100% 失敗 → GTID 等待 0%**、**Spring 讀寫分離完整實作**、**六種讀取不能走從庫**、**半同步的靜默降級**、四類監控指標、五個最小權限帳號 |

---

## 常見誤區（課程會逐一破解）

- 金額用 `FLOAT`，對帳永遠差幾分錢。
- 每個欄位都建索引，寫入變慢、查詢還是不走索引。
- `WHERE DATE(created_at) = '2026-08-17'` — 函式包住欄位，索引直接失效。
- `LIMIT 100000, 20` 越翻越慢，以為是資料庫爛。
- 交易開得太大（裡面還呼叫外部 API），鎖住整張表拖垮全站。
- 「在我機器上測起來很快」—— 而正式環境的資料放不進 buffer pool，同一句慢一個數量級。
- 用了 `addBatch()` 就以為批次化了，其實少了 `rewriteBatchedStatements=true`，跟逐筆一樣慢。
- 資料庫變更手動在正式機下 SQL，沒有版本紀錄、無法重現。
- 以為遷移腳本失敗了「所以什麼都沒改」—— 而第一句 `ALTER` 已經生效了。
- `ALGORITHM=INSTANT` 號稱零成本，卻被一個只讀了一列的未提交交易卡住 11 秒。
- 每個遷移都附一個「回滾腳本」—— 而它只回滾 schema，不回滾資料。
- 「我們每天都有備份」—— 但沒有人量過還原要多久，也沒有人還原過一次。
- 從庫設了 `read_only`，以為它不會被寫到 —— 而應用程式連的是 `root`。
- 從庫延遲只有 1 毫秒，以為讀寫分離很安全 —— 而「寫完立刻讀」的失敗率是 100%。

## 產出

一份訂單系統的**完整 MySQL schema + Flyway 遷移腳本**，
含索引設計說明、`EXPLAIN` 前後對照的優化實驗、一份「慢查詢排查 SOP」，
以及一份**演練過的災難復原文件**（含實測的 RTO）與讀寫分離的實作。
