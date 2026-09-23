# 11 — 訊息佇列：RabbitMQ 與 Kafka

> [05-service/06](../05-service/06-async-and-external-api-calls.md) 的第一個事故是「一次例行部署，3,000 封確認信消失了」——
> 那是**把佇列放在記憶體裡**的必然結局。這一站要把佇列搬出行程之外。
>
> 兩個主角是**兩種模型，不是兩個品牌**：
> RabbitMQ 是**訊息代理**（訊息投遞給消費者、消費完就沒了、路由很聰明），
> Kafka 是**分散式日誌**（訊息寫進去就留著、消費者自己記位置、可以重讀）。
>
> 兩個都學，重點不在「哪個比較好」，而在**你要能講出為什麼這個功能用這個**。

---

## 學完你可以

- 說明「加上 MQ」到底解決了什麼、又新增了哪些問題（順序、重複、延遲、除錯困難）。
- 指出一則訊息從生產者到消費者之間的**三個遺失點**，並說出各段的防守手段與代價。
- 解釋為什麼「先寫資料庫、再送訊息」與「先送訊息、再寫資料庫」兩種寫法都會出錯，並用 **Outbox 模式**解決。
- 設計冪等消費：訊息 ID 去重、業務層天然冪等，以及兩者各自的失效情境。
- 用 Spring AMQP 建出正確的 exchange / queue 拓撲，設定 publisher confirm、手動 ack 與 prefetch，並用 DLX 做重試與死信。
- 用 Spring for Apache Kafka 設定 producer 與 consumer group，說明 partition 決定了什麼、rebalance 何時發生、offset 該什麼時候提交。
- 說清楚「至少一次 / 最多一次 / 精確一次」在兩個系統上分別怎麼達成、代價是什麼。
- 讓 `traceId` 跨越 MQ，並監控 consumer lag 與死信堆積。
- 面對一個新需求，做出有理由的選型 —— 包括**判斷它該不該用 MQ**。

## 前置知識

| 你需要先會 | 在哪裡 |
|---|---|
| 交易傳播 | [05-service/02](../05-service/02-transaction-management-in-depth.md) |
| `@Async`、`AFTER_COMMIT`、逾時與重試 | [05-service/06](../05-service/06-async-and-external-api-calls.md) |
| 冪等鍵（03 章的去重會用到） | [10-redis/10](../10-redis/10-rate-limit-and-idempotency.md) |
| 應用事件、`@Scheduled` | [02-spring-boot/06](../02-spring-boot/06-scheduling-async-and-events.md) |

---

## 怎麼讀這一站

```
共通基礎（跟品牌無關，跳過的話後面兩邊都會走味）
  00 → 01 ★ → 02 ★ → 03 ★
      ↓
RabbitMQ（broker 模型）            Kafka（log 模型）
  04 → 05 ★ → 06                    07 → 08 ★ → 09
      └──────────────┬──────────────┘
                     ↓
              10（錯誤處理與可觀測性）→ 11（選型）
```

- **★ 是核心章**（01、02、03、05、08）。時間不夠就先讀這五章加 00。
- **04～06 與 07～09 可以對調順序**，兩套實作彼此獨立。
- **10、11 一定要等兩套都讀完**，它們整章都在對照兩邊。

> 📌 **已經在用 MQ、只想補洞的人**：從 **02（Outbox）**與 **03（冪等消費）**開始。
> 這兩章最常被跳過，也最常出事 —— 而且它們跟你用哪一套 MQ 完全無關。

---

## 章節目錄

### 共通基礎（兩邊都要）

| 章節 | 主題 | 一句話 |
|------|------|--------|
| [00](./00-course-map-why-message-queue.md) | 課程地圖與為什麼需要 MQ | 記憶體佇列的三個死法、broker 模型 vs log 模型、加上 MQ 之後多出來的四個問題，以及環境怎麼起 |
| [01](./01-reliable-delivery-three-hops.md) ★ | 可靠投遞的三段 | 訊息會在**三個地方**掉，每一段的防守手段與它的價錢 |
| [02](./02-outbox-and-transactional-consistency.md) ★ | Outbox 與交易一致性 | 「資料庫改了」與「訊息送了」怎麼一起成功 —— 而 `AFTER_COMMIT` 只解決一半 |
| [03](./03-idempotent-consumer.md) ★ | 冪等消費 | 重複是必然的，所以要讓「處理兩次」跟「處理一次」結果一樣 |

### RabbitMQ

| 章節 | 主題 | 一句話 |
|------|------|--------|
| [04](./04-rabbitmq-basics-and-topology.md) | 拓撲與 Spring AMQP | exchange / queue / binding、四種 exchange、訊息轉換器的兩顆地雷、怎麼**安全地改**拓撲 |
| [05](./05-rabbitmq-reliability.md) ★ | 可靠性設定 | confirm / return、手動 ack、`prefetch`（**一個參數決定三件互相衝突的事**）、多消費者對順序的破壞 |
| [06](./06-rabbitmq-retry-delay-and-cluster.md) | 重試、延遲與叢集 | DLX、兩種退避做法、延遲佇列的坑、優先級的限制、classic vs quorum |

### Kafka

| 章節 | 主題 | 一句話 |
|------|------|--------|
| [07](./07-kafka-basics-and-producer.md) | 模型與生產者 | key 決定分區、分區決定順序，`acks` 與 ISR，批次與壓縮，以及**分區數為什麼改不回去** |
| [08](./08-kafka-consumer-group-and-offset.md) ★ | 消費者與位移 | consumer group 與 rebalance、提交時機、兩個逾時、線上重放 SOP |
| [09](./09-kafka-exactly-once-and-retention.md) | 交易與保留 | 冪等 producer 的邊界、Kafka 交易與 `read_committed`、**精確一次為什麼到不了你的資料庫**、retention 與 compaction |

### 收尾

| 章節 | 主題 | 一句話 |
|------|------|--------|
| [10](./10-error-handling-and-observability.md) | 錯誤處理與可觀測性 | Kafka 的死信要自己做、`traceId` 怎麼跨過 broker、lag 的五種假象、死信重放 SOP |
| [11](./11-choosing-and-mixing.md) | 選型與混用 | 完整決策表、共存架構與遷移成本，以及**什麼時候兩個都不要用** |

> 📌 **每一章的數字都是實際跑出來的**，不是憑印象寫的。
> 課文裡每一段輸出的標頭就是節號（`═══ 5.4.1 ... ═══`），可以直接對回內文。

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

---

## 環境

### 容器

| 容器 | 映像 | 本機埠 | 什麼時候要 |
|---|---|---|---|
| `rabbit-lab` | `rabbitmq:3.13-management` | 5673（AMQP）、15673（管理介面） | **00 章起，全站** |
| `kafka-lab` | `apache/kafka:3.8.0`（KRaft 單節點） | 19092 | **00 章起，全站** |
| `mysql-lab` | `mysql:8.0` | 13306 | 02、03、09、10、11 章 |
| `kafka1` / `kafka2` / `kafka3` | `apache/kafka:3.8.0`（三節點） | 19101 / 19102 / 19103 | 只有副本相關的實驗要（[01 章 1.3.6](./01-reliable-delivery-three-hops.md)、[07 章 7.5](./07-kafka-basics-and-producer.md)） |
| `pg-lab` | `postgres:16` | 15432 | 只有 [03 章 3.4.3](./03-idempotent-consumer.md) 的可攜性對照要 |

**起法**：前三台見 [00 章 0.6](./00-course-map-why-message-queue.md)，三節點叢集見 [01 章 1.3.6](./01-reliable-delivery-three-hops.md)。

⚠️ **單節點量不出任何副本相關的行為**（[01 章 1.3.7](./01-reliable-delivery-three-hops.md)）——
`acks=all`、`min.insync.replicas`、`replication.factor` 在一台 broker 上是裝飾品。
📌 `kafka3` 只有 07 章用得到，跑完可以 `docker rm -f kafka3`。

### 做到那一節再準備的東西

| 要什麼 | 哪一節 | 備註 |
|---|---|---|
| `staging` vhost | [04 章 4.7.1](./04-rabbitmq-basics-and-topology.md) | `rabbitmqctl add_vhost staging` |
| `rabbitmq_consistent_hash_exchange` | [05 章 5.5.6](./05-rabbitmq-reliability.md) | **內建在映像裡**，只要 enable |
| `rabbitmq_delayed_message_exchange` | [06 章 6.4.3](./06-rabbitmq-retry-delay-and-cluster.md) | ⚠️ **不在映像裡**，要自己下載 `.ez` |
| 耐心 | [09 章 9.5](./09-kafka-exactly-once-and-retention.md) | ⚠️ `log.retention.check.interval.ms` 預設 **300000** —— 保留策略的實驗**一輪就要 5～7 分鐘** |
| Testcontainers 四個依賴 + `confluentinc/cp-kafka:7.6.1` | [10 章 10.6.2](./10-error-handling-and-observability.md) | 第一次要下載約 450 MB |
| ⚠️ `-Dapi.version=1.44` | [10 章 10.6.3](./10-error-handling-and-observability.md) | **Docker 29 對舊的 API 版本回 400**，Testcontainers 會說「找不到 Docker」 |

📌 **兩個外掛在各自的節跑完之後都該 disable 回去** —— 不要讓一個實驗的環境改動留給下一個實驗。

### 版本基準

本站所有數字都跑在 **JDK 21 / Maven 3.9 / Spring Boot 3.2.5** 上，
對應的客戶端版本是 `spring-rabbit 3.1.4`、`spring-kafka 3.1.4`、`kafka-clients 3.6.2`、`amqp-client 5.19.0`。

⚠️ **換了版本請自己重跑 [00 章 0.8.3](./00-course-map-why-message-queue.md) 的 `DefaultsTest`。**
它會把本站引用到的每一個預設值一次列出來 ——
Kafka 3.0 就改過一次 producer 的預設值，而網路上多數文章還在講舊的
（[01 章 1.3.5](./01-reliable-delivery-three-hops.md) 有這個坑的完整實測）。

---

## 產出

把訂單系統的三條流程改成事件驅動，並附**故障演練報告**：

1. **下單 → 扣庫存 → 通知**：用 Outbox 模式實作一次，附「服務在送出訊息前被 `kill -9`」的重現與恢復驗證。
2. **同一組流程做兩個版本**：RabbitMQ 版與 Kafka 版各一，附兩者的設定對照、吞吐壓測與**同一則訊息重複投遞 10 次**的冪等驗證。
3. 一份消費者故障演練：毒藥訊息進死信、consumer lag 從 0 衝到 50 萬再追平的過程紀錄。
4. 一份選型文件：這個專案為什麼選了其中一個，換成另一個要付出什麼。

> 📌 第 1、3 項的完整題目在 [06 章練習九](./06-rabbitmq-retry-delay-and-cluster.md)，
> 第 2 項的兩個版本分別在 [06 章練習九](./06-rabbitmq-retry-delay-and-cluster.md)
> 與 [09 章練習九](./09-kafka-exactly-once-and-retention.md)，
> 第 4 項的格式在 [11 章 11.2.6](./11-choosing-and-mixing.md)。
