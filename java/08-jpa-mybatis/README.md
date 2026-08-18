# 08 — JPA / Hibernate 與 MyBatis

> 同一件事的兩種哲學：**JPA 幫你把物件映射成資料庫、MyBatis 讓你自己掌控 SQL**。
> 這一站兩個都學，重點不在「哪個比較好」，而在**你要能講出為什麼這個專案選這個**。
> JPA 的部分會花最多篇幅在持久化情境（Persistence Context）與 N+1 —— 這是絕大多數效能災難的來源。

---

## 學完你可以

- 說明 ORM 與 SQL Mapper 的根本差異，並依專案特性做出選擇。
- 正確映射 Entity 與關聯，避免雙向關聯造成的無限遞迴與意外刪除。
- 解釋持久化情境、一級快取、髒檢查與 flush 時機 —— 知道「我沒呼叫 save 為什麼資料變了」。
- 診斷並解決 N+1 查詢與 `LazyInitializationException`。
- 用 JPQL、Criteria、QueryDSL 或原生 SQL 寫複雜查詢，並知道各自的時機。
- 用 MyBatis 寫動態 SQL 與 `resultMap`，處理複雜報表查詢。
- 在同一個專案裡合理混用兩者。

## 前置知識

[06-repository/](../06-repository/) 全部、[07-mysql/](../07-mysql/) 01～04 章。

---

## 章節目錄

| 章節 | 檔案 | 主題 | 重點 |
|------|------|------|------|
| 00 | `00-course-map-orm-vs-sql-mapper.md` | 課程地圖與技術選型 | JPA / Hibernate / Spring Data JPA 三者關係、MyBatis 定位、選型決策表 |
| 01 | `01-jpa-entity-mapping.md` | Entity 映射基礎 | `@Entity` / `@Table` / `@Column`、主鍵生成策略比較、列舉與時間、`@Embedded`、審計欄位 |
| 02 | `02-jpa-relationships.md` | 關聯映射 | `@OneToMany` / `@ManyToOne` / `@ManyToMany`、擁有方、雙向關聯、`cascade`、`orphanRemoval`、JSON 遞迴 |
| 03 | `03-persistence-context-and-lifecycle.md` | 持久化情境（核心章） | 實體四種狀態、一級快取、髒檢查、flush 時機、`merge` vs `persist`、`EntityManager` 生命週期 |
| 04 | `04-lazy-loading-and-n-plus-1.md` | 延遲載入與 N+1（核心章） | fetch 策略、`LazyInitializationException` 三種解法、`JOIN FETCH`、`@EntityGraph`、`@BatchSize`、分頁 + fetch 的陷阱 |
| 05 | `05-jpql-criteria-and-querydsl.md` | 查詢技術 | JPQL 語法、Criteria API、QueryDSL 型別安全查詢、原生 SQL 與 DTO 投影 |
| 06 | `06-jpa-performance-and-locking.md` | 效能與並行控制 | 批次插入設定、`saveAll` 的真相、二級快取、樂觀鎖 `@Version`、悲觀鎖、統計 SQL 數量 |
| 07 | `07-mybatis-basics-and-mapper.md` | MyBatis 基礎 | Spring Boot 整合、Mapper 介面、XML vs 註解、參數與結果映射、`#{}` 與 `${}` 的安全差異 |
| 08 | `08-mybatis-dynamic-sql-and-advanced.md` | MyBatis 進階 | `<if>` / `<foreach>` / `<choose>`、`resultMap` 關聯與巢狀、PageHelper 分頁、批次、快取設定 |
| 09 | `09-choosing-and-mixing-in-practice.md` | 實務選型與混用 | 什麼場景 JPA 快、什麼場景 MyBatis 省事、同專案共存的架構、遷移成本評估 |

---

## 常見誤區（課程會逐一破解）

- 迴圈裡取關聯物件，一支 API 打出 501 次 SQL 卻毫無自覺。
- `FetchType.EAGER` 到處設，一撈訂單順便把全世界關聯拉出來。
- 雙向關聯直接回傳給前端，Jackson 無限遞迴堆疊溢位。
- `saveAll()` 以為是批次，實際上一筆一筆 INSERT。
- MyBatis 用 `${}` 拼參數，SQL Injection 直接成立。
- 誤以為「用了 ORM 就不用懂 SQL」—— 出事時完全束手無策。

## 產出

用 **JPA 版**與 **MyBatis 版**各實作一次 06-repository 的同一組介面，
附上兩者的 SQL 執行紀錄與效能對照，並完成一份 N+1 問題的偵測 / 修復實驗報告。
