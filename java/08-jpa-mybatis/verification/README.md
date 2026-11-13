# JPA／MyBatis 課程回歸驗證

每次從目前 Markdown 抽取 Java／SQL，編譯後連接獨立的 Docker MySQL 驗證。測試不依賴先前審閱的 `/tmp` 檔案，也不是以舊問題仍存在作為通過條件。

## 執行

從儲存庫根目錄執行，需要 Docker、Bash、Python 3；Java／Maven 在容器內執行：

```bash
bash java/08-jpa-mybatis/verification/run.sh
```

預設映像為 `mysql:8.0.46`、`maven:3.9-eclipse-temurin-21`，首次執行需能取得映像與 Maven 依賴。可指定本機 Maven 快取，唯讀掛載並離線執行：

```bash
MAVEN_CACHE_DIR="$HOME/.m2/repository" \
  bash java/08-jpa-mybatis/verification/run.sh
```

本次實測使用本機 `mysql:8.0`，其實際版本為 8.0.46：

```bash
MYSQL_IMAGE=mysql:8.0 MAVEN_CACHE_DIR="$HOME/.m2/repository" \
  bash java/08-jpa-mybatis/verification/run.sh
```

`mysql:8.0` 是浮動標籤，應確認執行輸出的版本。未指定快取時，依賴下載到 `target/m2`。腳本使用可拋棄資料庫、不映射主機埠；Maven 共用該 MySQL 的容器網路。成功或失敗退出時會移除本次資料庫容器。整合測試的 `MYSQL_TEST_URL` 由腳本傳入，沒有主機資料庫的預設 URL。

僅跑離線 SQL 契約時，主機有 JDK 21／Maven 即可，不需要啟動 Spring 或資料庫：

```bash
python3 java/08-jpa-mybatis/verification/prepare.py
mvn -f java/08-jpa-mybatis/verification/pom.xml \
  -Dtest=OfflineContractTest test
```

## 實測結果

2026-11-11：**42 項 JUnit 測試通過，0 failure／error／skip**。其中 4 項是離線契約；另在未設定 MYSQL_TEST_URL、沒有測試資料庫容器的環境，單獨執行這 4 項通過，不重複加算為 46 項。

| 元件 | 基線 |
|---|---|
| Java | 21 |
| Spring Boot／Spring ORM | 3.2.5／6.1.6 |
| Hibernate | 6.4.4.Final |
| MyBatis／mybatis-spring／starter | 3.5.14／3.0.3／3.0.3 |
| Connector/J／MySQL | 8.3.0／8.0.46，UTC |
| PageHelper／JSqlParser | 6.0.0／4.5 |

`target/` 忽略版控，包含抽取程式與 SQL、編譯產物及 `target/surefire-reports/`。只跑離線選項時只會更新該測試類別的報告；全套結果以完整執行日誌為準。

## 12 項修正的驗證對照

| 問題 | 修正與回歸重點 |
|---|---|
| R01 手動 session 的交易邊界 | 抽取 KeyBatchService：REQUIRED 加入外層並隨其回滾；REQUIRES_NEW 明確獨立；前批已 flush、後批錯誤仍全部回滾；同 factory 已有 SIMPLE session 時不可靜默切換 BATCH。 |
| R02 INSERT 重複值 padding | 尾批保留實際筆數：53 筆批次與另 3 筆多值 INSERT 恰好新增 56 列，沒有複製尾列。 |
| R03 庫存生命週期 | place／addItem／removeItem／cancel 都維持預扣；多商品取消只釋放一次；後一商品釋放失敗時，先前釋放與訂單狀態一起回滾；匯入新 PENDING 訂單也同交易預扣。 |
| R04 總量與預扣模型 | 直接使用教材 schema 的 CHECK。qty=10／reserved=8 時需求 3 回業務不足、需求 2 成功；20 個併發請求只有 2 個成功；總量一直維持 10。領域方法與原子 JPQL 語意一致。 |
| R05 折扣不變量 | 已付款不可改折扣／直接取消；移除明細會使折扣超過剩餘總額時，先拒絕且不釋放庫存。先調整折扣再移除則正常完成。 |
| R06 映射與 DB 精度 | 沒標 scale／標 scale=2 對實際 DECIMAL(19,4) 都保存 100.1234；五位小數則由 DB 捨入為四位。 |
| R07 BigDecimal 髒檢查 | 100.0000 換成 100 不產生 UPDATE，並檢查 Hibernate 統計與 SqlSpy。 |
| R08 nullable | 最小 POM 沒有 Validator，nullable=false 會在 INSERT 前拒絕 null；同一個允許 NULL 的實際 DB 欄位可接受旁路 SQL 的 NULL，區別兩層檢查。 |
| R09 PageHelper 清理 | 抽取 SafePages：正常查詢、查詢前例外、實際 SQL 錯誤都清理 ThreadLocal；分頁後的下一次查詢不受污染。 |
| R10 CI 只有列印 | 查詢側誤放 UPDATE 會拋 AssertionError；版本守門會拒絕缺案例、沒有匹配任何 UPDATE、缺真正 version 增量與動態壞分支；實際訂單匯入的 batch 次數與資料量都有斷言。 |
| R11 形狀上界無法抓漏條件 | 當前 32 組搜尋逐一驗證 predicate；直接刪除 XML 的 from 條件時守門失敗。隔離主查詢驗證舊版 16 種／修正版 32 種，證明 <=32 會讓舊版通過。 |
| R12 .id 子字串不代表唯一 | AST 守門接受成品的根訂單唯一鍵與已知 to-one JOIN，拒絕 c.id、o.identity、id 運算式、to-many／未知 JOIN。重複時間戳的實際分頁不漏不重複。 |

搜尋整合測試也以獨立的記憶體 oracle 比較 JPA／MyBatis 的結果與總數，包含只有起日、只有迄日、金額剛好等於門檻，以及 `%`／`_`／`!` 字面值。

## 範圍與限制

- `prepare.py` 抽取成品 Entity、Service、Repository、Mapper、SQL 守門與相關工具；fixture 補啟動設定、資料、PageHelper 攔截器及金額探針。查詢側只准 SELECT 的方法原碼直接抽取，僅改可見性供測試呼叫。
- 01–05 章是加入庫存前的歷史階段；本回歸使用 06 章庫存、08 章完整 OrderService 與 09 章 Specification／投影搜尋的組合。舊 Specification 僅改類別名稱作為負例。
- 批次服務、庫存與訂單交易使用真實 MySQL；SQL 靜態守門另可離線跑。VersionWriteGuard 只驗證版本維護，不證明所有並行語意；OptionalPredicateContract 不代替結果邊界；OrderPageContract 只支援已明列的一列一訂單查詢與 to-one 邊。
- JSqlParser 4.5 對未加括號的 LIKE／ESCAPE 組合可能產生誤導 AST，因此教材將該子句加括號，並拒絕複合 escape AST，另有故障案例。
- 沒有啟動完整 Web 應用或付款／退款／出貨流程。簡化取消政策為 PENDING 可取消、CANCELLED 重複呼叫不再釋放；已付款另走退款流程。
- 沒有重測所有歷史效能數字、每章所有實驗變體、QueryDSL／jOOQ 或完整二級快取矩陣；現有歷史耗時不當作本次回歸的效能基線。42 項不代表全部教材程式皆已建置／執行。
