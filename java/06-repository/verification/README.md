# Repository 課程修正回歸

驗證 `java/06-repository` 審閱後修正的 18 項問題。`prepare.py` 每次從目前 Markdown 抽取 Java、DDL、查詢與最終 YAML，不依賴先前審閱時的暫存檔。

## 執行

需要 Python 3、Docker。從專案根目錄執行：

```bash
bash java/06-repository/verification/run.sh
```

腳本建立獨立 MySQL 容器，不映射主機連接埠，資料放在容器 tmpfs；Maven 容器共用其網路。結束時清理該 MySQL 容器。第一次會下載 Docker 映像及 Maven 依賴，Maven 快取位於本目錄的 `target/m2`。

已有完整 Maven 快取時，可唯讀掛載並離線執行：

```bash
MAVEN_CACHE_DIR="$HOME/.m2/repository" bash java/06-repository/verification/run.sh
```

不要在另一個尚未結束的驗證執行期間重跑，因為共用 `target`。不使用 Docker 時，也可自行準備專用測試資料庫，再執行：

```bash
cd java/06-repository/verification
python3 prepare.py
MYSQL_URL='jdbc:mysql://127.0.0.1:3306/review?sslMode=DISABLED&allowPublicKeyRetrieval=true&connectionTimeZone=UTC&forceConnectionTimeZoneToSession=true' mvn test
```

自行準備的資料庫必須可拋棄：測試會在 `review` schema 建立及刪除訂單、客戶與探針資料表。帳密固定為容器測試用的 `root`／`review-only`。沒有資料庫時直接失敗，不會以 skip 掩蓋未執行的 MySQL 測試。

## 覆蓋範圍

| 審閱項目 | 回歸內容 |
|---|---|
| R01 | 解析教材最終 YAML，使用其中 URL 參數連線並往返中文／emoji；測試環境只替換端點與 TLS 設定 |
| R02 | 奈秒往返、同毫秒不同微秒、相同 timestamp 不同 id，H2／MySQL 逐頁走完無重複或遺漏 |
| R03 | H2／MySQL 明細更新推進父版本、過期聚合拒絕保存、連續更新、flush 後回滾；MySQL 兩個已載入快照競爭只有一個提交 |
| R04 | 付款預期版本不符時，狀態／版本與庫存呼叫不變；正確版本可成功 |
| R05 | 實際 Spring proxy 建立每批唯讀交易；匯出／flush 在交易外；外層交易被拒絕；join SQL 不截斷同張訂單明細 |
| R06 | Connector/J 實際結果集分別為 Static、Cursor、Streaming，確認設定生效，不以 callback 推論驅動緩衝 |
| R07 | JDBC／JPA 保存並重載後連續更新、回傳新版本、舊物件仍拒絕保存；交易回滾丟棄新版本；實際 proxy 拒絕交易外 helper 呼叫 |
| R08 | 完整共用 DDL 在 H2／MySQL 執行，另執行完整 MySQL DDL，資料庫拒絕負總額 |
| R09 | H2／MySQL 執行上限 COUNT，1005 筆回傳 1001 |
| R10 | MySQL INSERT 與版本 UPDATE 的真實 batch counts；抽取實際 saveAll 驗混合新舊單與 stale batch 回滾；-2／-3／意外列數拒絕分類 |
| R11 | MySQL 的 JpaTransactionManager 唯讀交易確實準備 JDBC connection readOnly |
| R12 | 固定 40 筆、回傳 5／20 筆並消耗欄位；projection 固定句數，真正 LAZY N+1 必須讓守門斷言失敗 |
| R13 | 首頁空、首頁不足、非首頁非空不足、非首頁全空及滿頁的 COUNT 矩陣 |
| R14 | Java 21 JavaCompiler 編譯教材 keyset 迴圈，驗證 effectively-final 捕捉 |
| R15 | MySQL RR 先建立舊快照，再由第二條連線插入，current read 正確分類 id 衝突；H2／MySQL email 衝突及註冊交易回滾 |
| R16–R17 | 新單負總額／空明細拒絕，逐一驗證所有訂單狀態的取消白名單 |
| R18 | MockMvc：壞 cursor／sort 回 400，不回顯任意原文；內部 IllegalArgumentException 仍回 500；合法白名單回 200 |

## 驗證邊界

這是針對修正的可執行回歸，不是整份教學網站或完整 shop-service 的建置。JDBC 使用 02 章完成類別，套入 05 章 batch 方法及 helper；付款、註冊、JPA save、匯出 reader／exporter 的方法內容直接抽取。必要 package、import、依賴注入與未提供的周邊型別由 fixture 補足。

JPA Entity 使用相同的父 `@Version`、`mappedBy`、cascade、orphanRemoval 與複合明細主鍵，驗證教材實際 save 方法；未宣稱完整原始 Entity 專案已建置。Fixture 沒有實作的授權／排程 API 會直接拋 UnsupportedOperationException。

MVC 抽取 `04-controller` 的真實 ErrorCode、BusinessException、FieldViolation、InvalidCursorException，使用最小 Controller／Advice 驗證邊界翻譯及 catch-all 500；未啟動前站完整 Web 應用。ETag 僅驗證新版本可供產生標頭，完整 If-Match HTTP 流程不在此專案。

未重新量測大量資料的堆積上界、實際網路 round trip、時區差異或執行計畫。匯出 checkpoint 與 socket 並非原子提交，仍可能重複輸出。fake／JdbcClient 的完整契約套件也沒有在此重建。

## 本次結果

2026-11-10：Java 21、Spring Boot 3.2.5、Hibernate 6.4.4、H2 2.2.224、Connector/J 8.3.0、MySQL 8.0.46（`mysql:8.0`）。測試報告產生於 `target/surefire-reports/`。

重跑腳本端到端驗證：**41 tests，0 failures、0 errors、0 skipped**。N+1 探針的 projection 為 1／1 句，LAZY 違規負例為 6／21 句（5／20 筆內容）。
