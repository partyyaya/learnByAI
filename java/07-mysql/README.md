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

## 前置知識

基本 SQL（`SELECT` / `INSERT` / `UPDATE` / `DELETE`）。

---

## 章節目錄

| 章節 | 檔案 | 主題 | 重點 |
|------|------|------|------|
| 00 | `00-course-map-install-and-connect.md` | 課程地圖與環境 | Docker 啟動 MySQL 8、`utf8mb4`、時區與 `serverTimezone`、JDBC 連線參數、GUI 工具 |
| 01 | `01-schema-design-and-data-types.md` | Schema 設計 | 型別選擇（金額別用 float）、`AUTO_INCREMENT` vs UUID、NULL 的代價、時間欄位、命名慣例 |
| 02 | `02-sql-crud-join-and-aggregate.md` | SQL 核心 | JOIN 種類、`GROUP BY` 與 `HAVING`、子查詢 vs JOIN、視窗函式、`UPSERT` |
| 03 | `03-index-and-explain.md` | 索引與執行計畫（核心章） | B+Tree 結構、聚簇索引、複合索引最左前綴、覆蓋索引、索引失效情境、讀懂 `EXPLAIN` |
| 04 | `04-transaction-isolation-and-lock.md` | 交易、隔離與鎖 | ACID、MVCC、四種隔離級別與異常現象、行鎖 / 間隙鎖 / 意向鎖、死鎖分析與避免 |
| 05 | `05-query-performance-tuning.md` | 效能調校 | 慢查詢日誌、深分頁優化、批次寫入、`IN` 過長、連線與逾時設定、Java 端常見反模式 |
| 06 | `06-schema-migration-flyway.md` | Schema 版本控管 | Flyway 遷移腳本、命名與版本策略、可回滾設計、線上大表變更（`ALTER` 的代價） |
| 07 | `07-backup-replication-and-production.md` | 上線維運 | 備份與還原演練、主從複製、讀寫分離在 Spring 的做法、監控指標、權限最小化 |

---

## 常見誤區（課程會逐一破解）

- 金額用 `FLOAT`，對帳永遠差幾分錢。
- 每個欄位都建索引，寫入變慢、查詢還是不走索引。
- `WHERE DATE(created_at) = '2026-08-17'` — 函式包住欄位，索引直接失效。
- `LIMIT 100000, 20` 越翻越慢，以為是資料庫爛。
- 交易開得太大（裡面還呼叫外部 API），鎖住整張表拖垮全站。
- 資料庫變更手動在正式機下 SQL，沒有版本紀錄、無法重現。

## 產出

一份訂單系統的**完整 MySQL schema + Flyway 遷移腳本**，
含索引設計說明、`EXPLAIN` 前後對照的優化實驗，以及一份「慢查詢排查 SOP」。
