這個目錄驗證本次 `java/12-capstone` 修訂的七項問題。`prepare.py` 每次從目前的 Markdown 擷取完整程式、SQL 與 Prometheus 規則，避免只測一份另外修好的副本。

需要 Java 21、Maven、Python 3 與本機 Docker：

```bash
python3 java/12-capstone/verification/run.py
# Maven 相依套件已下載時，可完全使用快取：
python3 java/12-capstone/verification/run.py --offline
```

工具啟動獨立的 MySQL 8.0、Redis 7.2、RabbitMQ 3.13 容器，使用隨機 localhost 埠；只建立自己的測試資料庫。成功或失敗都會移除這次建立的容器。不要直接對既有資料庫執行 `target/schema.sql`。

驗證涵蓋：

| 修正 | 驗證方式 |
|---|---|
| 庫存預留改主鍵逐筆鎖定 | 真實 MySQL、預設 REPEATABLE READ，控制取消／新訂單交錯；另一個交易保留舊快照時，鎖定讀仍看到最新 RELEASED |
| 下單鎖衝突有限重試 | 從課文擷取原本的重試迴圈，驗證失敗交易 rollback、最多三次；MockMvc 驗證耗盡後 503、Retry-After 與 Problem Details |
| retry queue 安全 dead-lettering | 宣告課文的實際拓撲；publish confirm 成功後讓 TTL 到期但缺少回送 binding，修復後仍收到原訊息 |
| 修復標記世代 | Mockito 與 latch 固定「舊 DEL 完成前又有新寫入失敗」的順序，新標記必須保留到下一輪修復 |
| 快取期限與重啟 | 真實 Redis 驗證 TTL、重建快取實例、慢 loader 與延後 afterCommit 不可重新延長舊快照；另測晚 miss 再查快取及等待者例外傳遞 |
| 通知認領 | 真實 MySQL、模擬 mailer，驗證並行投遞、寄送失敗後重試、租約過期接手、舊 token 不可清除／完成新認領 |
| 不透明識別碼 | 真實 MySQL 驗證大小寫、重音不同的鍵能分別保存；Flyway 9.22.3 從全新／舊版／只含 claimed_until 三種起點套用 V26～V28，保留既有資料 |
| 低流量告警 | promtool 檢查完整 20 條規則與原有案例，另測少量 ready、只有 unacked、空佇列及持續 ACK；真實 RabbitMQ 3.13 抓取 ACK counter，核對 vhost／queue 標籤 |

本次結果（2026-11-13）：21 個 JUnit 測試通過，0 failures／errors／skipped；promtool 確認 20 條規則，原有案例與新增停滯案例全部通過。

`target/verification.log`、`target/surefire-reports/`、`target/summary.json` 保留當次測試結果。原始碼與 YAML 產生在 `target/`，不應手動修改。Maven POM 由第 00 章起始 POM 加上後續章節使用的 JPA、Validation、Flyway 模組產生。

庫存的兩個 `held()` 方法與下單重試迴圈以最小外殼編譯：只補 JdbcTemplate、TransactionTemplate 與業務 callback，不替換 SQL、鎖定邏輯或重試分支。其餘選定類別使用課文完整程式；EventHandler 摘要只補 package 與 import。這是局部回歸驗證，**沒有重建並重跑課文原先的完整 235 個測試、負載測試、正式部署或真實 SMTP**。

商品快取改為最長 1 秒 TTL 會增加 DB 重載頻率；課文原有 10 分鐘快取的壓測數字不能當作本版效能結果。新停滯告警約需 1～2 分鐘加抓取延遲，也不能取代逐事件 60 秒 SLO。通知租約不提供 SMTP exactly-once；認領過期或寄出後崩潰仍可能重寄。

本次本機使用 Java 21.0.5、Maven 3.9.16、Spring Boot 3.2.5、Flyway 9.22.3 與 promtool 3.5.0。RabbitMQ 測試只在獨立容器縮短 `dead_letter_worker_publisher_confirm_timeout`，方便驗證 binding 修復；課文正式預設不變。

RabbitMQ 3.13 的 ACK family／指標名稱依據[官方 3.13.7 collector 原始碼](https://github.com/rabbitmq/rabbitmq-server/blob/v3.13.7/deps/rabbitmq_prometheus/src/collectors/prometheus_rabbitmq_core_metrics_collector.erl)，安全 dead-lettering 設定見[官方 quorum queue 說明](https://www.rabbitmq.com/docs/3.13/quorum-queues#dead-lettering)。
