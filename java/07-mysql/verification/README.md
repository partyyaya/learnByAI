# MySQL 課程回歸驗證

從目前 Markdown 抽取 Java、SQL 與 shell 範例，再連接可拋棄的 Docker MySQL 執行。測試不依賴先前審閱留下的 `/tmp` 檔案。

## 執行

在儲存庫根目錄執行，需要 Docker、Bash、Python 3 與可取得 Maven 依賴的網路：

```bash
bash java/07-mysql/verification/run.sh
```

預設使用 `mysql:8.0.46` 與 `maven:3.9-eclipse-temurin-21`。有本機 Maven 快取時可離線執行，快取以唯讀方式掛載：

```bash
MAVEN_CACHE_DIR="$HOME/.m2/repository" \
  bash java/07-mysql/verification/run.sh
```

若本機只有 `mysql:8.0`，可設定 `MYSQL_IMAGE=mysql:8.0`；應先確認該映像實際版本為 8.0.46，避免浮動標籤改變測試基線。未指定快取時，依賴下載至 `target/m2`。

腳本建立主庫與從庫，兩者共用隔離的容器網路，以 3306／3307 區分，沒有映射主機埠。還原演練另建隔離容器；正常完成或失敗退出時會移除所建立的資料庫容器。`target/` 是忽略版控的產物，包含抽取程式、腳本、資料與 Surefire 報告。

## 實測結果與版本

2026-11-10 執行結果：**36 項 JUnit 測試與 12 項 Python 維運測試全部通過，無跳過案例**。其中一項維運測試分別變更 view、routine、trigger、event，確認各自的定義差異都會保留。

| 元件 | 本次基線 |
|---|---|
| MySQL server／client | 8.0.46（本機 `mysql:8.0` 映像；執行時使用 `MYSQL_IMAGE=mysql:8.0`） |
| Java | 21 |
| Spring Boot auto-configuration | 3.2.5 |
| Spring Framework 執行主模組 | 6.1.14；測試工具 spring-test 使用 Boot 管理的 6.1.6 |
| Connector/J | 8.3.0 |
| Flyway | 10.20.1，含 flyway-mysql |
| Testcontainers API | 1.20.4；此重跑腳本以外部 Docker 端點管理生命週期 |

此版本組合用來驗證本次修正；沒有把結果延伸宣稱為教材所有歷史實驗的版本或效能結果。

## 修正與案例對照

| 問題 | 修正／驗證 |
|---|---|
| R01 從庫監控注入錯誤 | 抽取完整路由組態，確認 monitor 使用原生從庫池；兩個實際端點設不同心跳，驗證延遲超標退回主庫、健康時讀從庫。 |
| R02 第二個 Flyway 讓主庫自動遷移消失 | 抽取雙 Flyway 組態，在 Boot auto-configuration 下驗證兩庫皆遷移，並保留各 EntityManagerFactory 的初始化依賴。 |
| R03 正常單庫 GTID 備份被判失敗 | 執行原備份腳本與實際 mysqldump：獨立還原用途明確 OFF，仍保留 binlog 座標；另注入未知 stderr 警告，確認仍拒絕成功。 |
| R04 GTID 逾時仍讀從庫 | 執行抽取的完整讀己之寫範例：正常複製成功；暫停從庫 SQL thread 後逾時並改讀主庫，仍取回剛寫入資料。 |
| R05 Outbox 狀態與 CHECK 不符 | 使用 01 章完整 schema，實際領取 PENDING 事件並更新 PUBLISHED／published_at。 |
| R06 batch 回傳值與版本衝突 | 實際版本 UPDATE batch 含一筆 0，必須丟出衝突並回滾整批；全部為 1 才提交，未知 -2、失敗 -3、意外多列與長度不符皆拒絕。 |
| R07 遷移測試無跨 schema 管理權限 | 管理連線建立 schema，專用 migration_test 執行遷移與比對；教材四條 MigrationTest 邏輯全部執行。 |
| R08 還原驗證失敗卻成功退出 | 驗證數量／最新安裝版本／金額和／缺明細／schema；實際執行一次正常備份還原與一次錯誤資料還原，只有前者報成功。 |
| R09 指紋漏 CHECK／FK | 同構 schema 指紋一致；單獨移除 CHECK、移除 FK（保留索引）、變更 ON DELETE 都產生差異。 |
| R10 黃金檔刪除可執行 DDL | 四種物件分別變更均可偵測；DML／GTID 進度不污染 schema，排除 history 與 GTID 執行狀態。 |
| R11 守門漏算反向掃描 | 實際消耗查詢結果；近千次反向存取超過 100 門檻，選擇性索引通過；已知三句 SELECT 的 Questions 校正為 3。 |
| R12 UNIQUE 被判冗餘 | UNIQUE 與 PRIMARY 不列為可移除候選；普通前綴能抓出，方向／前綴長度／可見性不同不誤判；唯一約束仍拒絕重複。 |
| R13 回填未使用上界 | 抽取實際 SQL 與完整迴圈；首批上界內沒有待填列時不越界更新，後續批次仍完成待填列。 |
| R14 暫存表權限與連線 | 專用 shop_probe 僅授予 schema 內 DML／暫存表權限；執行教材四條資料庫時區測試，同一 ConnectionCallback 建表、使用、清理。 |
| R15 NULL 生成欄位索引的說明 | 已刪除列仍可透過索引取回；允許重複歷史 email，同時拒絕重複 active email。 |
| R16 PITR 續行產生空白檔名 | 抽取實際命令列檢查 argv，確認沒有空白或空字串檔名；複製種子與 pt-online-schema-change 命令的同類續行問題一併修正，另以無副作用 argv 檢查確認。 |
| R17 庫存忽略 reserved_qty | canonical schema 中 qty=10／reserved=8，需求 3 回傳 0、需求 2 成功；20 個併發預扣只有 10 個成功。 |
| R18 CHECK 3819 翻譯類型 | 在明列基線下，預設 JdbcTemplate 丟出 UncategorizedSQLException，底層為 3819／HY000。 |

實際路由測試另抓到 AOP 參數綁定錯誤，已把 DbRoleAspect 排在 ExposeInvocationInterceptor 之後、預設交易攔截器之前，並明列 pointcut 的 argNames。

## 驗證邊界

- `prepare.py` 每次重新抽取教材，fixture 只補端點、生命週期、資料及必要周邊。MigrationTest 保留四條測試邏輯，替換 Testcontainers 啟停；雙 Flyway 的 EntityManagerFactory 使用依賴順序 fixture，沒有啟動完整 JPA 應用。
- 主從複製只傳遞 shop 表，ops 心跳另設兩端受控值；這是故障測試拓撲，不是正式複製初始化流程。GTID 檢查使用實際複製與 SQL thread 暫停，不以兩個無複製端點取代。
- 庫存、Outbox 與 batch 案例驗證實際 SQL／交易契約，沒有實作或測量完整 shop-service、外部事件投遞或付款流程。時區測試只抽取四條資料庫測試，不包含 BusinessClock 的示意 assertion。
- 備份測試透過 transport wrapper 在容器內執行真實 mysqldump，沒有偽造 dump；未知警告案例只額外寫入 stderr。實際還原使用小型 fixture，不代表大型資料集或正式環境 RTO。
- PITR 此處只驗證命令參數，沒有實際重放 binlog 或驗證跨表交易相依。效能守門測的是 session 邏輯計數，沒有重跑教材整套效能基準。
