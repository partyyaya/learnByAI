# Java 11 Messaging 回歸驗證

在專案根目錄執行：

```bash
python3 java/11-messaging/verification/run.py
```

需要 JDK 21、Maven 3.9、Python 3.9+、正在運作的 Docker。依賴已快取時可加 `--offline`。
Docker 首次執行會下載缺少的映像；使用 `mysql:8.0`、`rabbitmq:3.13-management`、
`apache/kafka:3.8.0`、`prom/prometheus:v3.5.0`。
腳本建立獨立容器、隨機 localhost 埠與測試資料庫，沒有掛載資料 volume。
完成或失敗都會清理本次建立的容器，不操作課文的 `mysql-lab`／`rabbit-lab`／`kafka-lab`。

`prepare.py` 從**目前 Markdown** 擷取 28 個 Java 類別、00 章 POM 與 10 章告警 YAML，
放到 `target/`。僅為省略的 import、getter 及 Account／Repository 等業務介面補 fixture，
不替換去重、Outbox、發送、重試、寄信或橋接的實作。選用 Redis starter 也加入驗證 POM。
測試報告在 `target/surefire-reports/`、`target/summary.json`，詳細執行輸出在 `target/verification.log`。
`target/` 不進版本控制；`pom.xml` 由 prepare 依課文重新產生。

## 本次結果

2026-11-12：JDK 21.0.5、Maven 3.9.16、Spring Boot 3.2.5，
MySQL 8.0.46、RabbitMQ 3.13.7、Kafka broker 3.8.0。
使用 Boot 管理的 spring-rabbit／spring-kafka 3.1.4、kafka-clients 3.6.2。

| 測試 | 項數 | 主要驗證 |
|---|---:|---|
| DatabaseTest | 17 | 訂單與 Outbox 同交易、JSON escaping、順序／併發去重、consumer 範圍、業務外鍵錯誤傳播、rollback 後可重試、upsert 兩種 JDBC 行數、第 5 次 FAILED、Pump 狀態、寄信與 Redis 降級 |
| RabbitTest | 12 | 真實 ACK+return、nack、raw JSON／messageId、拒絕停放、重試隔離、四次嘗試上限、轉送失敗保留原訊息、trace／TTL、橋接等待與失敗保留 |
| WiringTest | 9 | 真實 Boot 自動設定接線、單一 template／factory、bytes／DTO serializer、mandatory、trace 保留與清理、重放計數、DLT 失敗傳播、gauge 更新、同步 fixedRate 不重疊 |
| KafkaBehaviorTest | 4 | 相容 timeout 預算、固定 transactional.id 仍有兩次業務提交、不同實例 prefix 可同時提交、recoverer 失敗傳播 |
| AckModeTest | 1 | 在真實 broker 逐一驗證 TIME／COUNT／COUNT_TIME 不提交尚被 listener 阻塞的紀錄 |
| KafkaPipelineTest | 2 | 真實 broker 收到 DTO／bytes，以及反序列化失敗後原始 bytes 進入 DLT |
| 合計 | **45** | **0 failures、0 errors、0 skipped** |

`promtool check rules` 另外通過 **7 條規則**。這是語法檢查，實際 exporter 指標與告警閾值仍需部署時對應。

## 審閱問題與修正對照

| # | 原問題 | 修正位置與驗證 |
|---:|---|---|
| 1 | 指定 ID 的 saveAndFlush 走 merge，重複入帳 | 03.3.0–2 普通 INSERT；DatabaseTest 順序與併發 |
| 2 | MySQL no-op upsert 預設回傳 1 | 00 JDBC URL、03 upsert；兩種 useAffectedRows 實測 |
| 3 | catch 全部完整性錯誤導致誤判重複 | claim 專用例外；業務 FK 失敗向外拋且 rollback |
| 4 | return 後正向 confirm 又標記 SENT | 01／02／05 單一結果流程；真實 NO_ROUTE + Pump 狀態測試 |
| 5 | 寄信前就記已處理，失敗後永遠跳過 | 06 notification_job + 供應商 idempotency key；兩種失敗重試 |
| 6 | 重試／停放轉送未等確認就 ACK 來源 | ConfirmedRabbitSender；移除 retry binding 的真實容器測試 |
| 7 | Rabbit→Kafka 丟掉 future，提早 ACK | 11 有界等待；pending future、失敗停放測試 |
| 8 | 自訂 RabbitTemplate 遺失 Boot mandatory | 10 使用 RabbitTemplateConfigurer；實際自動設定測試 |
| 9 | Outbox JSON String 被 Jackson 再編碼 | 02 raw UTF-8 + 共用 DTO；真實 Rabbit typed conversion |
| 10 | 主佇列 DLX→retry→TTL 無限循環 | 06 主 DLX 改 parking；真實 nack 路徑與有限次數測試 |
| 11 | 寄信重試回共享 exchange 再廣播 | default exchange 精確回 mail queue；額外 warehouse binding 測試 |
| 12 | callback 沒交易卻呼叫 modifying repository | 01／02／05／07 狀態更新留在 Pump 的交易；DB Pump 測試 |
| 13 | CorrelationData 沒有設定 AMQP messageId | sender 明確設穩定 messageId；broker 讀回驗證 |
| 14 | bytes template 使 Boot 主 template 退開 | 10 單一 Object/Object template 與受管理 factory；接線及實送測試 |
| 15 | trace interceptor 泛型不被 Boot 自動採用 | 10 Object/Object；從實際建立的 container 檢查攔截器 |
| 16 | DLT 重設 X-Replay-Count=0 | 只在缺少時初始化，僅回傳新增 headers；保留 2 與 trace 測試 |
| 17 | 固定 transactional.id 被誤稱跨 session 業務去重 | 09 改為 fencing／交易恢復；真實兩次 commit 仍讀到兩則 |
| 18 | 多實例共用 transaction prefix 互相 fence | 09 使用 INSTANCE_ID，修正 EOS V2／StatefulSet 說明；雙 factory 提交 |
| 19 | delivery=3s、request=30s 無法建立 producer | 07 相容預算及 get／max.block 說明；producer 建立測試 |
| 20 | 誤稱 TIME／COUNT 會提交未處理 offset | 08 表格／驗收修正；真實 consumer 阻塞測試 |
| 21 | MySQL SET 先加 attempts，導致第 4 次 FAILED | 02 先判 status 再加 attempts；實際 JPQL 更新 1–5 次 |
| 22 | 反覆註冊 boxed Number gauge 不更新 | 02 AtomicLong 註冊一次；50→0、1→3 等讀值驗證 |
| 23 | 誤稱同步 fixedRate 會自行重疊 | 02 正文／總表修正；pool=4 的排程測試 |
| 24 | Redis 故障沒有實際降級 DB | 03 facade 讀寫例外處理；故障 mock 配合真實 MySQL worker |
| 25 | 缺少 MeterRegistry 與選用 Redis 依賴 | 00 加 Actuator，03 提供 Redis starter／容器；依課文 POM 編譯 |
| 26 | severity 不在 labels、不是完整規則檔 | 10 groups/rules/labels；promtool 驗證 7 條 |
| 27 | setPartitionResolver 不存在於 3.1.4 | 10 改 constructor destination resolver 與 TopicPartition(-1)；相同 API 在 recoverer 測試中編譯／執行 |

## 驗證界線

- 寄信以支援 idempotency key 的供應商 fixture 模擬。沒有連線真實郵件供應商，沒有宣稱普通 SMTP 可保證只寄一次。
- Redis 讀寫故障以 mock 注入，搭配真實 MySQL 交易驗證降級；此套回歸不啟動 Redis，也不測 Sentinel／叢集。
- Rabbit retry TTL 在測試縮成 100 ms；課文成品保留 5 秒／1 分鐘／10 分鐘。測試不宣稱每級實際延遲完全等於 TTL。
- Outbox Pump 的 broker 結果用 mock 注入；ConfirmedRabbitSender／重試拓撲另接真實 RabbitMQ，DB 交易另接真實 MySQL。沒有把這些測試稱為多節點 HA／故障復原壓測。
- Kafka template 與反序列化 DLT 使用真實 broker；橋接失敗用可控制 future 注入。並非對兩套 broker 做網路分區或斷電的完整演練。
- 單節點 Docker 無法驗證 quorum／ISR 多副本容錯；不重跑課文全部效能、retention、compaction、外掛與三節點實驗，也不保證舊量測數字適用修正版。

## 官方依據

- [Spring Data JPA：persist 與 merge 判斷](https://docs.spring.io/spring-data/jpa/reference/jpa/entity-persistence.html)
- [MySQL Connector/J：useAffectedRows](https://dev.mysql.com/doc/connector-j/en/connector-j-connp-props-connection.html)
- [Spring Kafka 3.1：serializer 與反序列化錯誤處理](https://docs.spring.io/spring-kafka/reference/3.1/kafka/serdes.html)
- [Spring Kafka 3.1：交易與 EOS](https://docs.spring.io/spring-kafka/reference/3.1/kafka/transactions.html)
- [RabbitMQ 3.13：quorum queue 與安全 dead lettering](https://www.rabbitmq.com/docs/3.13/quorum-queues)
- [Prometheus：告警規則格式](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/)
