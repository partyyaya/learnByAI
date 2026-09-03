# 11 — 訊息佇列：RabbitMQ 與 Kafka

> [05-service/06](../05-service/06-async-and-external-api-calls.md) 的第一個事故是「一次例行部署，3,000 封確認信消失了」——
> 那是**把佇列放在記憶體裡**的必然結局。這一站要把佇列搬出行程之外。
>
> 兩個主角是**兩種模型，不是兩個品牌**：RabbitMQ 是**訊息代理**（訊息投遞給消費者、消費完就沒了、路由很聰明），
> Kafka 是**分散式日誌**（訊息寫進去就留著、消費者自己記位置、可以重讀）。
> 這一站兩個都學，重點不在「哪個比較好」，而在**你要能講出為什麼這個功能用這個**。

> 沿用 [08-jpa-mybatis](../08-jpa-mybatis/) 的教法：先把**兩者共通的難題**（可靠投遞、Outbox、冪等消費）講透，
> 再分別進兩套實作，最後合回選型。前四章是共通基礎，跳過的話後面兩邊都會走味。

---

## 學完你可以

- 說明「加上 MQ」到底解決了什麼、又新增了哪些問題（順序、重複、延遲、除錯困難）。
- 指出一則訊息從生產者到消費者之間的**三個遺失點**，並說出各段的防守手段與代價。
- 解釋為什麼「先寫資料庫、再送訊息」與「先送訊息、再寫資料庫」兩種寫法都會出錯，並用 **Outbox 模式**解決。
- 說明 `AFTER_COMMIT` 事件為什麼不等於可靠投遞（接 [05-service/06](../05-service/06-async-and-external-api-calls.md) 6.3.5）。
- 設計冪等消費：訊息 ID 去重、業務層天然冪等、以及兩者各自的失效情境。
- 用 Spring AMQP 建出正確的 exchange / queue 拓撲，設定 publisher confirm、手動 ack 與 prefetch，並用 DLX 做重試與死信。
- 用 Spring for Apache Kafka 設定 producer 與 consumer group，說明 partition 決定了什麼、rebalance 何時發生、offset 該什麼時候提交。
- 說清楚「至少一次 / 最多一次 / 精確一次」在兩個系統上分別怎麼達成、代價是什麼。
- 讓 `traceId` 跨越 MQ，並監控 consumer lag 與死信堆積。
- 面對一個新需求，做出有理由的選型，而不是「公司在用哪個就用哪個」。

## 前置知識

[05-service/02](../05-service/02-transaction-management-in-depth.md)（交易傳播）、[05-service/06](../05-service/06-async-and-external-api-calls.md)（`@Async`、`AFTER_COMMIT`、逾時與重試）、
[10-redis/05](../10-redis/)（冪等鍵，第 03 章的去重會用到）、[02-spring-boot/06](../02-spring-boot/06-scheduling-async-and-events.md)（應用事件）。

---

## 章節目錄

### 共通基礎（兩邊都要）

| 章節 | 檔案 | 主題 | 重點 |
|------|------|------|------|
| 00 | `00-course-map-why-message-queue.md` | 課程地圖 | 記憶體佇列的三個死法、MQ 解決什麼、**broker 模型 vs log 模型**、加上 MQ 之後多出來的四個問題、Docker 起 RabbitMQ 與 Kafka |
| 01 | `01-reliable-delivery-three-hops.md` | 可靠投遞的三段（核心章） | 生產者 → broker → 消費者，每一段的遺失情境與實測、同步 vs 非同步確認的吞吐代價、持久化不等於不會掉、「不重不漏」為什麼做不到 |
| 02 | `02-outbox-and-transactional-consistency.md` | Outbox 與交易一致性（核心章） | 雙寫問題的兩種寫法都會錯、Outbox 表設計、輪詢 vs CDC、`AFTER_COMMIT` 的極限、訊息去重與 Outbox 清理、與 [05-service/02](../05-service/02-transaction-management-in-depth.md) 的交易邊界對照 |
| 03 | `03-idempotent-consumer.md` | 冪等消費（核心章） | 重複投遞為什麼是常態、訊息 ID 去重表 vs Redis、去重與業務交易的原子性、天然冪等的業務設計、狀態機擋重複、「處理到一半掛掉」的三種收尾 |

### RabbitMQ

| 章節 | 檔案 | 主題 | 重點 |
|------|------|------|------|
| 04 | `04-rabbitmq-basics-and-topology.md` | 拓撲與 Spring AMQP | exchange / queue / binding、四種 exchange 與路由鍵、`@RabbitListener`、訊息轉換器與 JSON、拓撲宣告該寫在哪、多環境命名 |
| 05 | `05-rabbitmq-reliability.md` | 可靠性設定 | publisher confirm 與 return callback、手動 ack 與 `nack` / `requeue`、**prefetch 決定了什麼**（設 1 與設 250 的實測差異）、持久化與 lazy queue、消費者掛掉時訊息去哪 |
| 06 | `06-rabbitmq-retry-delay-and-cluster.md` | 重試、延遲與叢集 | DLX 死信交換器、重試退避的兩種做法（本地重試 vs 死信回送）、⚠️ `requeue=true` 的無窮迴圈、TTL 延遲佇列與 delayed-message 外掛、優先級佇列、classic vs quorum queue、鏡像佇列的歷史包袱 |

### Kafka

| 章節 | 檔案 | 主題 | 重點 |
|------|------|------|------|
| 07 | `07-kafka-basics-and-producer.md` | 模型與生產者 | topic / partition / offset / replica、**key 決定分區、分區決定順序**、`acks` 三個值的取捨、`min.insync.replicas` 與遺失情境、批次與壓縮、Spring `KafkaTemplate` |
| 08 | `08-kafka-consumer-group-and-offset.md` | 消費者與位移（核心章） | consumer group 與分區分配、**rebalance 何時發生與它造成的重複**、自動 vs 手動提交、`max.poll.interval.ms` 踢人事件、`@KafkaListener` 併發模型、從頭重讀與位移重設 |
| 09 | `09-kafka-exactly-once-and-retention.md` | 交易與保留 | 冪等 producer、Kafka 交易與 `read_committed`、「精確一次」到底保證了什麼（以及它保證不到你的資料庫）、保留策略與 log compaction、把 Kafka 當事件來源的取捨 |

### 收尾

| 章節 | 檔案 | 主題 | 重點 |
|------|------|------|------|
| 10 | `10-error-handling-and-observability.md` | 錯誤處理與可觀測性 | 毒藥訊息與死信主題、重試主題階梯、`traceId` 跨 MQ 傳遞（[05-service/06](../05-service/06-async-and-external-api-calls.md) 的攔截器延伸）、consumer lag 監控與告警線、訊息重放的 SOP、Testcontainers 整合測試 |
| 11 | `11-choosing-and-mixing.md` | 選型與混用 | 逐項決策表（順序 / 吞吐 / 路由 / 重讀 / 延遲 / 維運成本）、什麼場景 RabbitMQ 明顯省事、什麼場景非 Kafka 不可、同專案共存的架構、從 RabbitMQ 遷到 Kafka 的成本、什麼時候**不該**用 MQ |

---

## 常見誤區（課程會逐一破解）

- 在交易還沒提交時就送出訊息，消費者立刻回頭查資料庫 —— 查不到。
- 用 `AFTER_COMMIT` 送訊息就以為安全了，結果送出前那一瞬間服務被重啟。
- 訊息送出去了但資料庫回滾，通知信寄出去、訂單不存在。
- 以為「訊息設了 persistent 就不會掉」，忽略 broker 收下但還沒落盤的那段。
- 消費失敗直接 `requeue=true`，同一則訊息以每秒數千次的速度在佇列裡繞圈，把 broker 打爛。
- Kafka 想要全域順序，於是開了一個 partition，吞吐鎖死在單一消費者。
- 消費邏輯跑 6 分鐘，`max.poll.interval.ms` 是 5 分鐘 —— 消費者被踢出 group、訊息重來、再跑 6 分鐘，永遠跑不完。
- 用了 Kafka 的「精確一次」，以為連自己寫資料庫那段也一起精確了。
- 沒有做冪等消費，靠「應該不會重複吧」上線。
- 出事時完全不知道訊息卡在哪 —— 沒有 traceId、沒有 lag 監控、死信佇列沒有人看。

## 產出

把訂單系統的三條流程改成事件驅動，並附**故障演練報告**：

1. **下單 → 扣庫存 → 通知**：用 Outbox 模式實作一次，附「服務在送出訊息前被 `kill -9`」的重現與恢復驗證。
2. **同一組流程做兩個版本**：RabbitMQ 版與 Kafka 版各一，附兩者的設定對照、吞吐壓測與**同一則訊息重複投遞 10 次**的冪等驗證。
3. 一份消費者故障演練：毒藥訊息進死信、consumer lag 從 0 衝到 50 萬再追平的過程紀錄。
4. 一份選型文件：這個專案為什麼選了其中一個，換成另一個要付出什麼。
