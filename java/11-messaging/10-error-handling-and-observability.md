# 第 10 章：錯誤處理與可觀測性

> **前面十章教你把訊息「送對、收對、不漏、不重」。**
> **這一章教你在它還是出事的時候，找得到它在哪裡。**
>
> 三件事被刻意留到這裡，因為它們都要等兩邊都學完才講得清楚：
>
> **一、毒藥訊息，Kafka 沒有內建的答案。**
> [06 章 6.2](./06-rabbitmq-retry-delay-and-cluster.md) 的 DLX 是一行設定
> （把 [00 章](./00-course-map-why-message-queue.md) 那場風暴從 **11,191 次 / 45 MB** 變成 **1 次 / 8 KB**）。
> Kafka 這一側，[08 章 8.4.3](./08-kafka-consumer-group-and-offset.md) 已經證明
> 「位移是一個數字，不是一份清單」—— 你只有兩個爛選擇。
> **10.2.1 會量出 Spring 預設幫你選了哪一個**：那一則訊息被投遞 **10 次**，
> 然後**位移越過去、訊息永遠消失、沒有任何地方記得它**。
>
> **二、`traceId` 到 `send()` 就斷了。**
> [00 章 0.5.5](./00-course-map-why-message-queue.md) 說「你唯一的窗口是積壓與 lag」，
> 而 10.3.1 把那條斷掉的鏈接回去：同一個請求的五行日誌，
> 修之前 `grep` 只撈得到 **3 / 5 行**，修之後 **5 / 5 行**。
>
> **三、lag 這個數字比你以為的難用。**
> ⚠️ **10.4.2 是本章最反直覺的一節**：在一個積壓正在成長的系統上，
> 消費者自己的 `records-lag-max` 一路顯示 **0**，而外部算出來的 lag 已經 **2,066**。
> 不是 bug —— 是**它量的根本不是你以為的那個東西**。
>
> ---
>
> 另外三筆帳也在這一章還：
>
> - ⚠️ **反序列化失敗不走重試階梯。** 10.2.6 實測：一則格式壞掉的訊息讓消費者
>   **每秒失敗 15,114 次**、後面的訊息永遠等不到 —— 這是 [00 章 0.5.2](./00-course-map-why-message-queue.md)
>   那場 requeue 風暴的 Kafka 版，而且更快。
> - ⚠️ **[08 章 8.8.5](./08-kafka-consumer-group-and-offset.md) 說「rebalance 次數比 lag 更值得告警」。**
>   10.4.3 把它證明了：兩台消費者、**一樣的 lag 曲線**，
>   一台做了 100 次工推進 **100 則**，另一台做了 100 次工只推進 **29 則**。
>   **只有 `rebalance-total` 分得出這兩件事。**
> - **前十章的每一個實驗都靠手動起的 Docker 容器。** 10.6 把它換成 Testcontainers。

---

## 10.1 學習目標

完成本章後，你應該可以：

- 說出 Spring for Apache Kafka **預設**會把一則毒藥訊息投遞幾次、退避多久、最後放到哪裡（10.2.0、10.2.1）。
- 用 `DefaultErrorHandler` + `DeadLetterPublishingRecoverer` 做出死信主題，並讀懂死信上的每一個 header（10.2.2）。
- 用 `@RetryableTopic` 做出重試主題階梯，並說出它相對於「本地重試」買到了什麼、付出了什麼（10.2.4、10.2.5）。
- ⚠️ 說出「一次失敗」在 Kafka 上的固定成本，以及一千則同時失敗要排多久（10.2.5 ④）。
- ⚠️ 說出 `ExponentialBackOff` 與 `ExponentialBackOffWithMaxRetries` 差在哪、各自在哪個 package（10.2.7）。
- 解釋為什麼反序列化失敗**碰不到**重試階梯，以及 `ErrorHandlingDeserializer` 要包在哪一層（10.2.6）。
- 說出 Kafka 的 DLT 與 RabbitMQ 的 DLX **形狀**差在哪裡（誰的功能、換語言還在不在、重試次數記在哪）（10.2.8）。
- 讓 `traceId` 跨過 RabbitMQ 與 Kafka，並說出**三個**會把它弄丟的地方（10.3）。
- 說出 `records-lag-max` 到底量的是什麼，以及它為什麼不能拿來告警（10.4.2）。
- 說出 lag 的**五種假象**，並各舉一個本站量過的例子（10.4.4）。
- 把 lag 從「幾則」換算成「落後幾秒 / 用掉 retention 的百分之幾」（10.4.5）。
- 列出 RabbitMQ 這一側要看的四個數字，並說出哪一個才看得出「消費者卡死」（10.4.6）。
- 寫出一份死信重放 SOP，並說出不加防護時它會變成什麼（10.5）。
- 用 Testcontainers 把前十章的手動容器變成可重現的整合測試，並說出它的四個坑與它不該取代什麼（10.6）。

---

## 10.2 毒藥訊息：Kafka 沒有 DLX，要自己做 ★★★

[06 章 6.2](./06-rabbitmq-retry-delay-and-cluster.md) 的 RabbitMQ 版本是**一行**：

```java
QueueBuilder.durable(Q).deadLetterExchange(DLX).build()
```

Kafka 沒有這一行。**這一節從「什麼都不做會怎樣」開始。**

### 10.2.0 先把預設值印出來

跟 [00 章 0.8.3](./00-course-map-why-message-queue.md) 一樣的規矩：**預設值不憑印象**。

```java
package com.example.lab11.ch10;

/** 10.2：把「錯誤處理」這一側的預設值全部印出來（不憑印象） */
class L0DefaultsTest {

    static String describe(BackOff bo) {
        StringBuilder sb = new StringBuilder(bo.getClass().getSimpleName()).append(" → 間隔序列 ");
        BackOffExecution ex = bo.start();
        int n = 0; long v;
        while ((v = ex.nextBackOff()) != BackOffExecution.STOP && n < 15) { sb.append(v).append(' '); n++; }
        return sb.append("(共 ").append(n).append(" 次重試)").toString();
    }

    @Test
    void printDefaults() throws Exception {
        // dig(...) 是一個小的反射工具，逐層取 private 欄位
        Object bo = dig(new DefaultErrorHandler(), "failureTracker", "backOff");
        Object classified = dig(new DefaultErrorHandler(), "classifier", "classified");
        // ... 完整檔案見實驗專案
    }
}
```

**輸出**：

```
═══ 10.2.0 錯誤處理這一側的預設值 ═══
  spring-kafka                          : 3.1.4
  SeekUtils.DEFAULT_MAX_FAILURES        : 10
  SeekUtils.DEFAULT_BACK_OFF            : FixedBackOff → 間隔序列 0 0 0 0 0 0 0 0 0 (共 9 次重試)
  new DefaultErrorHandler() 用的 BackOff : FixedBackOff → 間隔序列 0 0 0 0 0 0 0 0 0 (共 9 次重試)
  FixedBackOff.DEFAULT_INTERVAL         : 5000 ms
  FixedBackOff.UNLIMITED_ATTEMPTS       : 9223372036854775807
  DefaultErrorHandler.seekAfterError    : true
  預設就「不重試、直接放棄」的例外      :
      java.lang.ClassCastException
      java.lang.NoSuchMethodException
      org.springframework.kafka.support.converter.ConversionException
      org.springframework.kafka.support.serializer.DeserializationException
      org.springframework.messaging.converter.MessageConversionException
      org.springframework.messaging.handler.invocation.MethodArgumentResolutionException
```

📌 **四件事現在是確定的，不是「應該是」**：

| | 值 | 意思 |
|---|---|---|
| 總投遞次數 | **10**（1 次原始 + 9 次重試） | 不是 3 次，也不是無限次 |
| 退避間隔 | **全部是 0** | ⚠️ `FixedBackOff.DEFAULT_INTERVAL` 是 5000，但 `SeekUtils` **沒有用它** |
| `seekAfterError` | `true` | 重試的做法是「把位移 seek 回去，下一輪 poll 再拿一次」 |
| 不重試的例外 | 上面六個 | **10.2.6 那個 `DeserializationException` 就在這份清單上** |

⚠️ **「退避是 0」不等於「重試不花時間」** —— 每一次重試都是一輪完整的
「seek 回去 → 再 poll 一次 → 再送進 listener」，下一節會量出它到底花多久。

### 10.2.1 實測：一則毒藥訊息，Spring 預設會怎麼處理 ★★★

場景跟 [08 章 8.4.3](./08-kafka-consumer-group-and-offset.md) **一字不差**：
`msg-0` ~ `msg-9`，其中 `msg-3` 處理不了。

```java
package com.example.lab11.ch10;

/** 10.2：Kafka 上的毒藥訊息 —— Spring 預設會怎麼處理 */
@SpringBootTest
class L1PoisonDefaultTest {

    /** errorHandler = null → 用容器自己的預設 */
    Run scenario(CommonErrorHandler errorHandler) throws Exception {
        ContainerProperties props = new ContainerProperties(T);
        props.setGroupId(G);
        props.setMessageListener((MessageListener<String, String>) rec -> {
            long now = System.currentTimeMillis();
            deliveries.merge(rec.value(), 1, Integer::sum);
            firstEvent.compareAndSet(0, now);
            lastEvent.set(now);
            if ("msg-3".equals(rec.value())) {
                poisonFirst.compareAndSet(0, now);
                throw new IllegalStateException("這一則的金額欄位是 null");
            }
            if ("msg-4".equals(rec.value())) nextOk.compareAndSet(0, now);
            done.add(rec.value());
        });

        var container = new KafkaMessageListenerContainer<>(cf(G), props);
        if (errorHandler != null) container.setCommonErrorHandler(errorHandler);
        container.start();
        // 等到「連續 4 秒沒有任何新的投遞」才收工
        while (System.currentTimeMillis() - lastEvent.get() < 4000
                && System.currentTimeMillis() - t0 < 120_000) sleep(100);
        container.stop();
        return new Run(deliveries, attempts.get(), lastEvent.get() - firstEvent.get(),
                       committed(T, G), done.size(), nextOk.get() - poisonFirst.get());
    }
}
```

**輸出**：

```
═══ 10.2.1 一則毒藥訊息，Spring 預設會怎麼處理 ═══
  場景與 08 章 8.4.3 相同：msg-0 ~ msg-9，msg-3 處理不了

  送進 topic  : 10 則

  ── ① 完全不設 error handler（容器自己的預設）──
     毒藥訊息 msg-3 被投遞 : 10 次
     全部投遞次數          : 19 次（10 則正常投遞 + 重試）
     整批 10 則跑完花了    : 5,076 ms（從第一則投遞算起）
     msg-4 被卡住           : 5,076 ms（msg-3 第一次投遞 → msg-4 被處理）
     處理成功的相異訊息    : 9 則（msg-3 以外全部）
     最後的 committed 位移 : 10 ← 跟 end offset 一樣，消費者「追平了」
     msg-3 現在在哪裡      : 沒有任何地方。位移越過去了，也沒有死信 topic

     每一則的投遞次數：
     msg-0=1 msg-1=1 msg-2=1 msg-3=10 msg-4=1 msg-5=1 msg-6=1 msg-7=1 msg-8=1 msg-9=1 

  ── ② DefaultErrorHandler(FixedBackOff(2000 ms, 4 次))──
     毒藥訊息 msg-3 被投遞 : 5 次
     整批 10 則跑完花了    : 8,839 ms（從第一則投遞算起）
     msg-4 被卡住           : 8,839 ms ← msg-4 ~ msg-9 陪著毒藥訊息一起等
     處理成功的相異訊息    : 9 則
     最後的 committed 位移 : 10
     ⚠️ msg-3 一樣消失了 —— 退避只改變「等多久才放棄」，不改變「放棄之後去哪」
```

📌 **三個一定要看懂的數字**：

**① `10 次`** —— 就是 10.2.0 印出來的 `DEFAULT_MAX_FAILURES`。

**② `5,076 ms`，而退避是 0。**
9 次重試花了五秒 —— 那是**九輪「seek 回去 + 重新 poll」的來回**。
⚠️ 這也是為什麼「把重試次數調大」在 Kafka 上比你想的貴：
它不是在記憶體裡重跑，是**每一次都走一遍 broker**。

**③ `committed 位移 = 10`，而 `msg-3` 不見了。**

這是 [08 章 8.4.3](./08-kafka-consumer-group-and-offset.md) 說的**選擇二**：

```
  ── 選擇二：跳過毒藥訊息（提交 offset 10）──
     ⚠️ msg-3 從此不存在於任何人的待辦清單上 —— 沒有死信、沒有紀錄
```

> ⚠️ **Spring 的預設值幫你做了這個選擇，而且它不會問你。**
>
> 更糟的是**監控看不出來**：`lag = 0`、`committed offset` 追平了、
> 消費者健康、沒有積壓。從 [00 章 0.5.5](./00-course-map-why-message-queue.md)
> 那張「你唯一的窗口」的表來看，**一切正常**。
>
> 而 [00 章 0.5.2](./00-course-map-why-message-queue.md) 那場 RabbitMQ 的風暴至少**很吵**。
> 這一種是**安靜的**。

**④ 不過它並不是完全無聲 —— 有一行日誌。**

同一次執行，把日誌撈出來：

```
═══ 10.2.1 放棄的時候 Spring 會印什麼 ═══
  $ grep "exhausted" 這一次跑的日誌
ERROR o.s.kafka.listener.DefaultErrorHandler   : Backoff FixedBackOff{interval=0, currentAttempts=10, maxAttempts=9} exhausted for ch10.poison.v1-0@3
ERROR o.s.kafka.listener.DefaultErrorHandler   : Backoff FixedBackOff{interval=2000, currentAttempts=5, maxAttempts=4} exhausted for ch10.poison.v1-0@3
```

📌 **`exhausted for ch10.poison.v1-0@3` —— topic、分區、位移都在裡面。**
這是你唯一的線索，而且它**只存在於日誌裡**：

| | 有沒有動 |
|---|---|
| `lag` | ❌ 不動（追平了） |
| 消費者的 metric | ❌ 不動 |
| 死信 topic | ❌ 不存在 |
| **ERROR 日誌** | ✅ **一則訊息一行** |

⚠️ **所以「沒設 recoverer」不是完全查不到，是「只有日誌查得到」** ——
而如果你的告警是建在 metric 上（大部分人都是），**它就是無聲的**。
📌 **最低限度的補救**：對 `DefaultErrorHandler` 的 `exhausted` 這個字串設一條日誌告警。

### 10.2.2 實測：加上 `DeadLetterPublishingRecoverer`

一個 `recoverer` 就補上了缺的那一半：**重試次數用完之後，把它送到別的地方去。**

```java
var recoverer = new DeadLetterPublishingRecoverer(kafka);
Run r = consume(new DefaultErrorHandler(recoverer, new FixedBackOff(0L, 2L)));
```

**輸出**：

```
═══ 10.2.2 加上 DeadLetterPublishingRecoverer ═══
  實驗開始前 ch10.dlt.v1.DLT 存在嗎 : 否

  毒藥訊息 msg-3 被投遞 : 3 次（FixedBackOff(0, 2) = 1 次 + 2 次重試）
  msg-4 被卡住           : 1,657 ms
  處理成功的相異訊息    : 9 則
  原 topic 的 committed  : 10 / 10
  ch10.dlt.v1.DLT 是自動建出來的嗎 : 是，分區數 = 1
  ch10.dlt.v1.DLT 積壓     : 1 則

  ── 死信訊息長什麼樣 ──
     key / value : ORD-1 / msg-3
     header 清單 :
       kafka_dlt-exception-cause-fqcn         java.lang.IllegalStateException
       kafka_dlt-exception-fqcn               org.springframework.kafka.listener.ListenerExecutionFailed…
       kafka_dlt-exception-message            Listener failed; 這一則的金額欄位是 null
       kafka_dlt-exception-stacktrace         org.springframework.kafka.listener.ListenerExecutionFailed…
       kafka_dlt-original-consumer-group      ch10.dlt.g
       kafka_dlt-original-offset              3
       kafka_dlt-original-partition           0
       kafka_dlt-original-timestamp           2026-09-22T09:40:23.808Z（8 bytes 的 long）
       kafka_dlt-original-timestamp-type      CreateTime
       kafka_dlt-original-topic               ch10.dlt.v1
```

**這份 header 就是 Kafka 版的 `x-death`**（[06 章 6.2.3](./06-rabbitmq-retry-delay-and-cluster.md) 的驗屍報告）。
兩邊並排：

| 你想知道 | RabbitMQ 的 `x-death` | Kafka 的 DLT header |
|---|---|---|
| 從哪裡來的 | `queue` / `exchange` | `kafka_dlt-original-topic` / `-partition` |
| 什麼時候 | `time` | `kafka_dlt-original-timestamp` |
| 為什麼死 | `reason`（`rejected` / `expired` / `maxlen`） | `kafka_dlt-exception-fqcn` / `-cause-fqcn` / `-message` |
| 死幾次了 | `count`（**累加**） | ⚠️ **這條路徑沒有**（`@RetryableTopic` 那條有，見 10.2.5 ⑤） |
| 完整堆疊 | ❌ 沒有 | ✅ `kafka_dlt-exception-stacktrace` |
| 是誰處理失敗的 | ❌ 沒有 | ✅ `kafka_dlt-original-consumer-group` |

📌 **Kafka 這一側資訊多很多**（有完整堆疊、有 group 名稱），
**但少了 `count`** —— 而 `count` 正是 [06 章 6.9.2](./06-rabbitmq-retry-delay-and-cluster.md)
教你判斷「重試幾次了」的那個數字。10.5.2 會說明為什麼這件事很重要。

⚠️ **注意「這條路徑」四個字**：上面這份 header 是
`DefaultErrorHandler` + `DeadLetterPublishingRecoverer` 走出來的。
**`@RetryableTopic` 走的是另一套 header，而且它有 `retry_topic-attempts`** ——
10.2.5 ⑤ 會把兩套並排。

⚠️ **另外注意這一行**：

```
  ch10.dlt.v1.DLT 是自動建出來的嗎 : 是，分區數 = 1
```

**沒有人宣告過這個 topic。** 它是 [07 章 7.8.1](./07-kafka-basics-and-producer.md)
那個 `auto.create.topics.enable` 幫你建的 —— **1 個分區、RF=1、用 broker 的預設 retention**。
[09 章 9.5.3](./09-kafka-exactly-once-and-retention.md) 提醒過這件事：
**你認真建的 topic 可能設了 30 天，自動建出來的那個只有 7 天。**
死信是你最不想弄丟的東西，而它躺在一個沒有人設計過的 topic 上。

### 10.2.3 ⚠️ DLT 的分區數比原 topic 少

`DeadLetterPublishingRecoverer` 預設的目的地解析器是：

```java
(record, exception) -> new TopicPartition(record.topic() + ".DLT", record.partition())
```

**分區號原封不動搬過去。** 那如果 DLT 的分區比較少呢？

```java
/** 10.2：DLT 的分區數比原 topic 少的時候會怎樣 */
class L2bPartitionMismatchTest {
    // ① 正常路徑：真的有一個消費者，DefaultErrorHandler 幫你呼叫 recoverer
    // ② 自己呼叫兩個參數的 accept(record, exception)
}
```

**輸出**：

```
═══ 10.2.3 ⚠️ DLT 的分區數比原 topic 少 ═══
  DeadLetterPublishingRecoverer 預設把死信送到「跟來源相同的分區號」
  原 topic 6 分區、壞掉的那一則在 p5、DLT 只有 1 分區

  ── ① 正常路徑（真的有消費者在跑）──
     listener 被呼叫 : 2 次
     DLT 上          : 1 則（p0=1）
     → checkPartition() 拿消費者問了一次分區清單，發現沒有 p5，
       就把 partition 改成 -1，讓 partitioner 自己挑

  ── ② 自己呼叫 recoverer.accept(record, exception)（沒有傳 consumer）──
     結果   : ❌ KafkaException: Dead-letter publication to ch10.pm72645b.v1.DLT failed for: ch10.pm72645b.v1-5@42
     DLT 上 : 0 則（p0=0）
     ⚠️ 注意例外訊息說的是「topic not present in metadata」——
        topic 明明在，不在的是 p5
```

📌 **正常路徑是安全的。** spring-kafka 3.1.4 的 `DeadLetterPublishingRecoverer`
預設 `verifyPartition = true`，它會拿消費者去查一次分區清單：

```java
private TopicPartition checkPartition(TopicPartition tp, Consumer<?, ?> consumer) {
    if (tp.partition() < 0) return tp;
    List<PartitionInfo> partitions = consumer.partitionsFor(tp.topic(), this.partitionInfoTimeout);
    if (partitions == null) return tp;
    if (partitions.stream().noneMatch(pi -> pi.partition() == tp.partition())) {
        this.logger.warn(() -> "Destination resolver returned non-existent partition " + tp
                + ", KafkaProducer will determine partition to use for this topic");
        return new TopicPartition(tp.topic(), -1);       // ← 交給 partitioner
    }
    return tp;
}
```

⚠️ **但看清楚它的參數：`Consumer<?, ?> consumer`。**
這個檢查**只在有消費者的路徑上發生**。你如果自己寫一支重放工具、
直接呼叫兩個參數的 `accept(record, exception)`，**檢查整個被跳過**，
然後你會拿到一個**完全誤導人的錯誤訊息**：

```
TimeoutException: Topic ch10.pm72645b.v1.DLT not present in metadata after 10000 ms.
```

**topic 明明在。** producer 卡住的是「等 p5 出現」，
而它報出來的是「topic 不在」。這是 Kafka 客戶端最容易讓人查錯方向的訊息之一。

> 📌 **兩個結論**：
> **①** DLT 的分區數**建得跟原 topic 一樣**，不要靠自動建立。
> **②** 自己寫的重建 / 重放工具要傳 consumer 進去，或者自己
> `setPartitionResolver((rec, ex) -> null)` 明確放棄分區對應。

### 10.2.4 `@RetryableTopic`：重試主題階梯 ★★★

10.2.1 的 ② 暴露了一個更根本的問題：

```
     msg-4 被卡住           : 8,839 ms ← msg-4 ~ msg-9 陪著毒藥訊息一起等
```

**這正是 [06 章 6.3.1](./06-rabbitmq-retry-delay-and-cluster.md) 量過的那件事**
（本地重試把消費者卡住 **7,045 ms**）。
RabbitMQ 那一章的解法是 6.3.2 的「死信回送」——**訊息離開消費者，去別的佇列等**。

**Kafka 這一側的對應物叫重試主題（retry topic）**，Spring 用一個註解就給你：

```java
package com.example.lab11.ch10;

/** 10.2：@RetryableTopic —— 重試主題階梯 */
@SpringBootTest
class L3RetryTopicTest {

    static class Listener {

        @RetryableTopic(
                attempts = "4",                                            // 1 次原始 + 3 次重試
                backoff = @Backoff(delay = 1000, multiplier = 2.0),        // 1s → 2s → 4s
                autoCreateTopics = "true")
        @KafkaListener(topics = T, groupId = G)
        void onMessage(ConsumerRecord<String, String> rec) {
            TIMELINE.add(new Hit(now - T0.get(), rec.topic(), rec.value()));
            if ("msg-3".equals(rec.value())) throw new IllegalStateException("這一則的金額欄位是 null");
        }

        @DltHandler
        void dead(ConsumerRecord<String, String> rec) {
            TIMELINE.add(new Hit(now - T0.get(), rec.topic(), rec.value() + "  ← @DltHandler 收到它"));
        }
    }
}
```

**輸出**：

```
═══ 10.2.4 @RetryableTopic：重試主題階梯 ═══
  @RetryableTopic 自動建出來的 topic：
     ch10.retry.v1                分區=1 RF=1 訊息數=0
     ch10.retry.v1-dlt            分區=1 RF=1 訊息數=0
     ch10.retry.v1-retry-1000     分區=1 RF=1 訊息數=0
     ch10.retry.v1-retry-2000     分區=1 RF=1 訊息數=0
     ch10.retry.v1-retry-4000     分區=1 RF=1 訊息數=0

  ── 投遞時間軸（同一個 key = ORD-1，msg-3 壞掉）──
     時刻        落在哪個 topic                     訊息
           0 ms ch10.retry.v1                  msg-0
           1 ms ch10.retry.v1                  msg-1
           2 ms ch10.retry.v1                  msg-2
           2 ms ch10.retry.v1                  msg-3
          12 ms ch10.retry.v1                  msg-4
          12 ms ch10.retry.v1                  msg-5
       1,018 ms ch10.retry.v1-retry-1000       msg-3
       3,029 ms ch10.retry.v1-retry-2000       msg-3
       7,043 ms ch10.retry.v1-retry-4000       msg-3
       7,557 ms ch10.retry.v1-dlt              msg-3  ← @DltHandler 收到它

     msg-3 第一次失敗 : 2 ms
     msg-4 被處理     : 12 ms
     主 topic 被卡住   : 10 ms  ← 對照 06 章 6.3.1 的本地重試

  ── 一個 @KafkaListener 換來幾個 consumer group ──
     ch10.retry.g
     ch10.retry.g-dlt
     ch10.retry.g-retry-1000
     ch10.retry.g-retry-2000
     ch10.retry.g-retry-4000
     共 5 個 group、5 個 listener container
```

📌 **這張時間軸請逐行看，它是本節的全部**：

**① 六則訊息在 12 ms 內全部處理完。** `msg-3` 失敗了，但 `msg-4`、`msg-5` 沒有等它。

**② `msg-3` 自己在三個 topic 上跳，間隔 1s → 2s → 4s。**
退避階梯完全成立，而**主 topic 的消費者從頭到尾沒有停下來**。

**③ 四個並排**：

| 做法 | 主 topic 被卡住 | 出處 |
|---|---|---|
| 本地重試（RabbitMQ） | **7,045 ms** | [06 章 6.3.1](./06-rabbitmq-retry-delay-and-cluster.md) |
| 死信回送（RabbitMQ） | **45 ms** | [06 章 6.3.2](./06-rabbitmq-retry-delay-and-cluster.md) |
| `DefaultErrorHandler` + 2 秒退避（Kafka） | **8,839 ms** | 10.2.1 ② |
| **`@RetryableTopic`（Kafka）** | **10 ms**（另一次 16 ms） | 10.2.4 |

**④ 重試主題的名字帶著延遲毫秒數**：`-retry-1000` / `-retry-2000` / `-retry-4000`。
⚠️ 這是**指數退避**才有的形狀 —— 一級一個 topic。
**固定間隔的退避只會有一個**（10.2.5 ④ 實測）。

**⑤ 最後那一段是這一節的價碼**：**一個 `@KafkaListener` 換來 5 個 topic、5 個 consumer group、5 個 listener container。**

### 10.2.5 重試主題的五個代價

**① ⚠️ 順序沒了。**

回頭看時間軸：`msg-0` → `msg-1` → `msg-2` → `msg-4` → `msg-5` → …7.5 秒後… → `msg-3`。
**六則訊息是同一個 key（`ORD-1`）。**

[07 章 7.3](./07-kafka-basics-and-producer.md) 花了一整節證明
「同一個 key 進同一個分區、所以有序」—— **重試主題把這件事拆掉了**。

> 📌 **判斷準則**：
> 如果你的消費者是**狀態機**（[03 章 3.7.2](./03-idempotent-consumer.md) 的那種），
> **不要用重試主題**。`3-STOCK_RESERVED` 晚 7 秒到，狀態機就炸了。
> 重試主題適合的是**彼此獨立的工作**：寄信、產 PDF、打外部 API。

**② 資源乘以 N。** 5 個 group 代表 5 份 `__consumer_offsets` 紀錄、
5 組 rebalance、5 份監控。[08 章 8.8](./08-kafka-consumer-group-and-offset.md) 教你看的每一個數字都要乘以 5。

**③ 那些 topic 是 Spring 自己建的，而它的預設就是 1 分區。**

把這個註解的預設值印出來：

```
═══ 10.2.5 @RetryableTopic 的預設值 ═══
  attempts()           預設 "3"
  autoCreateTopics()   預設 "true"
  numPartitions()      預設 "1"
  replicationFactor()  預設 "-1"
  concurrency()        預設 ""
```

⚠️ **`numPartitions()` 預設 `"1"`** —— 這不是 broker 的預設，是**這個註解自己的預設**。
主 topic 6 分區、重試 topic 1 分區，而一個 1 分區的 topic 在一個 group 裡
**最多只有一個消費者在做事**
（[08 章 8.2.1](./08-kafka-consumer-group-and-offset.md) 實測過多出來的那個拿到 `[]`）。
**你的重試路徑是一條單線道** —— 下一段會量出那條單線道一秒只搬得動 2 則。

⚠️ **`concurrency()` 預設是空字串**（跟著容器工廠走），
所以**只把分區數調大是不夠的**，兩個要一起調。正式環境自己宣告：

```java
@Bean
public RetryTopicConfiguration retryTopics(KafkaTemplate<String, Object> template) {
    return RetryTopicConfigurationBuilder.newInstance()
            .exponentialBackoff(1000, 2, 8000)
            .maxAttempts(4)
            .autoCreateTopicsWith(6, (short) 3)      // ← 分區數跟主 topic 對齊
            .concurrency(6)                          // ← ⚠️ 這一行不能少，理由見上面
            .includeTopic("order.created.v1")
            .create(template);
}
```

**④ 延遲是「等在重試 topic 上」，不是 `sleep()`。**

這件事值得量一次，因為它決定了「重試會不會拖垮重試路徑」。
用**固定間隔**的退避（`attempts=2`、`delay=3000`），一次丟 5 則都會失敗的訊息：

```java
/** ⚠️ 固定間隔（沒有 multiplier）—— 對照 10.2.4 的指數退避 */
@RetryableTopic(attempts = "2", backoff = @Backoff(delay = DELAY_MS), autoCreateTopics = "true")
@KafkaListener(topics = T, groupId = G)
void onMessage(ConsumerRecord<String, String> rec) {
    TIMELINE.add(new Hit(now - T0.get(), rec.topic(), rec.value()));
    throw new IllegalStateException("這一則的金額欄位是 null");
}
```

**輸出**：

```
═══ 10.2.5 固定間隔的退避：一個 topic，而且不是「每則睡一次」═══
  attempts=2、固定間隔 3,000 ms、同時丟 5 則都會失敗的訊息

  ── ① 自動建出來的 topic ──
     ch10.retry2.v1
     ch10.retry2.v1-dlt
     ch10.retry2.v1-retry-3000
     → 指數退避是一級一個 topic（10.2.4），固定間隔只有一個

  ── ② 投遞時間軸 ──
           0 ms ch10.retry2.v1                 msg-0
           9 ms ch10.retry2.v1                 msg-1
          15 ms ch10.retry2.v1                 msg-2
         533 ms ch10.retry2.v1                 msg-3
       1,041 ms ch10.retry2.v1                 msg-4
       3,013 ms ch10.retry2.v1-retry-3000      msg-0
       3,525 ms ch10.retry2.v1-dlt             msg-0
       3,528 ms ch10.retry2.v1-retry-3000      msg-1
       4,035 ms ch10.retry2.v1-dlt             msg-1
       4,036 ms ch10.retry2.v1-retry-3000      msg-2
       4,542 ms ch10.retry2.v1-dlt             msg-2
       4,544 ms ch10.retry2.v1-retry-3000      msg-3
       5,053 ms ch10.retry2.v1-dlt             msg-3
       5,055 ms ch10.retry2.v1-retry-3000      msg-4
       5,560 ms ch10.retry2.v1-dlt             msg-4

     5 則的重試：第一則在 3,013 ms、最後一則在 5,055 ms，跨度 2,042 ms
     如果是「每一則各睡 3,000 ms」，跨度會是 12,000 ms
     實測跨度 2,042 ms → 不是睡的：它暫停分區，到期之後一次全部繼續

  ── ③ 重試 topic 的最大併行度 ──
     ch10.retry2.v1                 分區=1 → 這個 topic 上最多 1 個消費者在做事
     ch10.retry2.v1-dlt             分區=1 → 這個 topic 上最多 1 個消費者在做事
     ch10.retry2.v1-retry-3000      分區=1 → 這個 topic 上最多 1 個消費者在做事
```

📌 **三件事被這張時間軸釘死了**：

**（a）固定間隔只有一個重試 topic**，名字一樣帶著延遲毫秒數（`-retry-3000`）。
對照 10.2.4 的指數退避 —— 那裡是三個（`-retry-1000` / `-2000` / `-4000`）。

**（b）它不是「每一則各睡一次」。**
五則的重試跨度是 **2,042 ms**；如果消費者對每一則都 `sleep(3000)`，
跨度會是 **12,000 ms**。
📌 **實際機制是：消費者看到一則還沒到期的訊息就把分區暫停掉，時間到了再 resume。**

**（c）⚠️ 但每一則要排隊。**
`msg-2` 在 15 ms 進來，退避是 3,000 ms，所以它「應該」3,015 ms 到期，
**實際上 4,036 ms 才被重試**。差的那一秒是排在它前面的 `msg-0`、`msg-1` 佔掉的。

**這個排隊成本值得單獨量一次，因為它決定了「一次大量失敗會塞多久」。**

**重試路徑一秒搬得動幾則**

一次丟 **20 則**都會失敗的訊息，固定退避 **1,000 ms**：

**輸出**：

```
═══ 10.2.5 重試路徑一秒搬得動幾則 ═══
  attempts=2、固定間隔 1,000 ms、一次丟 20 則都會失敗的訊息

  ── 三段各自的時間 ──
     主 topic  : 20 則， 9,733 ms →       2 則/秒
     重試 topic: 20 則， 9,721 ms →     2.1 則/秒
     死信 topic: 20 則，10,213 ms
     全部走完共 11,256 ms

  ── 重試 topic 上前 8 則的間隔 ──
     msg-0    在  1,030 ms
     msg-1    在  1,545 ms（距上一則 515 ms）
     msg-2    在  2,064 ms（距上一則 519 ms）
     msg-3    在  2,579 ms（距上一則 515 ms）
     msg-4    在  3,088 ms（距上一則 509 ms）
     msg-5    在  3,603 ms（距上一則 515 ms）
     msg-6    在  4,110 ms（距上一則 507 ms）
     msg-7    在  4,621 ms（距上一則 511 ms）
     ⚠️ 退避只有 1,000 ms，但最後一則要等到 10,751 ms —— 差額全是排隊
```

📌 **`2 則/秒`。這是本章最該記住的一個數字之一。**

**每一則失敗的訊息，從「失敗」到「送去下一站」，固定要 ~515 ms。**
不是退避（退避是 1,000 ms，而間隔只有 515 ms），
也不是網路（本機 broker），**是「失敗 → 處理 → 提交 → 繼續」這一輪的成本**。

⚠️ **回頭看 10.2.1 就對得起來了**：那裡 9 次重試花了 **5,076 ms** ——
每次 **564 ms**，同一個數量級。
📌 **在 Kafka 上，「一次失敗」的固定成本大約是半秒**，
而 RabbitMQ 那一側是 [06 章 6.3.2](./06-rabbitmq-retry-delay-and-cluster.md) 的 **45 ms**。

**這代表什麼**：

| 失敗量 | 重試路徑要多久排完（單分區、每則 0.5 秒） |
|---|---|
| 20 則 | 約 10 秒 |
| 1,000 則 | **約 8 分鐘** |
| 100,000 則 | **約 14 小時** |

⚠️ **下游掛掉的時候，失敗的不是 20 則，是全部。**
📌 **所以重試 topic 的分區數與 `concurrency` 都要跟主 topic 對齊**（10.2.5 ③）——
不是為了「順序」（重試主題本來就沒有順序），是為了**排隊速度**。

**⑤ ⚠️ 它的死信 header 跟 10.2.2 那一套完全不一樣。**

同一次執行，把 DLT 上那一則的 header 全部列出來：

```
  ── @RetryableTopic 的死信上有什麼 header ──
     kafka_dlt-original-consumer-group      ch10.audit2.g
     kafka_exception-cause-fqcn             java.lang.IllegalStateException
     kafka_exception-fqcn                   org.springframework.kafka.listener.ListenerExecu…
     kafka_exception-message                Listener failed; 這一則的金額欄位是 null
     kafka_exception-stacktrace             org.springframework.kafka.listener.ListenerExecu…
     kafka_original-offset                  0
     kafka_original-partition               0（4 bytes 的 int）
     kafka_original-timestamp               2026-09-23T04:02:54.027Z（8 bytes 的 long）
     kafka_original-timestamp-type          CreateTime
     kafka_original-topic                   ch10.audit2.v1
     retry_topic-attempts                   2（4 bytes 的 int）
     retry_topic-attempts                   3（4 bytes 的 int）
     retry_topic-backoff-timestamp          (6 bytes: 01a0cc6e49cc) ← Spring 內部用的二進位
     retry_topic-backoff-timestamp          (6 bytes: 01a0cc6e49ea) ← Spring 內部用的二進位
     retry_topic-original-timestamp         (6 bytes: 01a0cc6e45cb) ← Spring 內部用的二進位
     retry_topic-original-timestamp         (6 bytes: 01a0cc6e45cb) ← Spring 內部用的二進位
     ── 出現超過一次的 header（每跳一站累積一份）──
     retry_topic-attempts                   × 2
     retry_topic-backoff-timestamp          × 2
     retry_topic-original-timestamp         × 2
```

⚠️ **跟 10.2.2 那一份逐字比對，三件事不一樣**：

| | `DeadLetterPublishingRecoverer`（10.2.2） | **`@RetryableTopic`（這裡）** |
|---|---|---|
| 來源 topic | `kafka_dlt-original-topic` | **`kafka_original-topic`**（沒有 `dlt-`） |
| 例外 | `kafka_dlt-exception-fqcn` | **`kafka_exception-fqcn`**（沒有 `dlt-`） |
| group | `kafka_dlt-original-consumer-group` | `kafka_dlt-original-consumer-group`（⚠️ **只有這個有 `dlt-`**） |
| **重試幾次了** | ❌ 沒有 | ✅ **`retry_topic-attempts`** |

📌 **兩個結論**：

**①「Kafka 的死信沒有 `x-death.count`」這句話只對一半。**
`@RetryableTopic` 有 `retry_topic-attempts`，而且**每跳一站就多累積一份**
（上面 `× 2`：一份是 `2`、一份是 `3`）。
⚠️ **但 `DefaultErrorHandler` + `DeadLetterPublishingRecoverer` 那條路真的沒有** ——
那條路要自己塞（10.5.2 ②）。

**②「寫一支通吃兩種死信的工具」會踩到 header 名稱不一致。**
⚠️ 少一個 `dlt-` 前綴，你的重放工具就讀不到來源 topic，
而且**不會報錯，只會讀到 `null`**。

📌 **所以指數退避才要一級一個 topic**：
**同一個 topic 上只放同一種延遲，到期順序才會跟進入順序一致，排隊才只是「排隊」而不是「愈積愈久」。**

### 10.2.6 ⚠️ 反序列化失敗：重試階梯完全碰不到它 ★★★

**這是本節最重要的一個實驗。**

前面所有的機制 —— `DefaultErrorHandler`、`DeadLetterPublishingRecoverer`、
`@RetryableTopic` —— 都在 listener **被呼叫之後**才有機會介入。

**而反序列化失敗發生在 `poll()` 裡面。** listener 從來沒有被呼叫過。

```java
/** 10.2：反序列化失敗 —— Kafka 這一側的 requeue 風暴（對照 00 章 0.5.2） */
@SpringBootTest
class L4DeserializationTest {

    void resetAndFill() throws Exception {
        kafka.send(T, "ORD-1", "{\"orderId\":\"ORD-1\",\"amount\":100}").get();
        kafka.send(T, "ORD-2", "{\"orderId\":\"ORD-2\",\"amount\":200}").get();
        kafka.send(T, "ORD-3", "上游某個服務直接把純文字丟了進來").get();     // ← 毒藥
        kafka.send(T, "ORD-4", "{\"orderId\":\"ORD-4\",\"amount\":400}").get();
        kafka.send(T, "ORD-5", "{\"orderId\":\"ORD-5\",\"amount\":500}").get();
    }

    /** poll 階段的失敗會走 handleOtherException，listener 階段的走 handleOne —— 兩邊都數 */
    static class Counting implements CommonErrorHandler {
        @Override public void handleOtherException(Exception ex, Consumer<?, ?> c,
                                                   MessageListenerContainer m, boolean b) {
            pollFailures.incrementAndGet();
            delegate.handleOtherException(ex, c, m, b);
        }
        // handleOne / handleRemaining / handleBatch 都原樣轉給 DefaultErrorHandler
    }
}
```

**輸出**：

```
═══ 10.2.6 反序列化失敗：重試階梯完全碰不到它 ═══
  topic 上 5 則：ORD-1 / ORD-2 是好的 JSON，ORD-3 是純文字，ORD-4 / ORD-5 是好的
  每一種寫法都觀察 20 秒

  ── ① 直接用 JsonDeserializer（大多數人的寫法）──
     listener 收到的訊息 : 2 則  ← 只有 ORD-1 / ORD-2
     poll 失敗次數        : 302,275 次 = 15,114 次/秒
     committed 位移       : 2 / 5  ← 卡在 offset 2 原地打轉
     例外                 : JsonParseException: Invalid UTF-8 start byte 0xb8 at [Source: (byte[])"上游某個服務直接把純文字丟了進來"; line: 1, column: 3…
     ⚠️ ORD-4 / ORD-5 永遠等不到。這是 00 章 0.5.2 那場風暴的 Kafka 版

  ── ② 包一層 ErrorHandlingDeserializer，但沒有 recoverer ──
     listener 收到的訊息 : 4 則  ← ORD-1/2/4/5
     poll 失敗次數        : 0 次
     committed 位移       : 5 / 5  ← 越過去了
     ⚠️ 但 ORD-3 那一則從此不存在 —— 換來的是 08 章 8.4.3 的「選擇二」

  ── ③ 再加上 DeadLetterPublishingRecoverer(那顆 KafkaTemplate<String,String>) ──
     listener 收到的訊息 : 2 則
     recoverer 被呼叫    : 193 次 = 9.7 次/秒
     其中送死信失敗      : 193 次
     committed 位移       : 2 / 5
     ch10.deser.v1.DLT 上有 : 0 則
     死信送不出去的原因  : KafkaException: Dead-letter publication to ch10.deser.v1.DLT failed for: ch10.deser.v1-0@2
     ⚠️ 又一個迴圈 —— 只是這次是「死信寫不進去」造成的

  ── ④ 正解：再給 recoverer 一顆「送 byte[]」的 template ──
     listener 收到的訊息 : 4 則  ← ORD-1/2/4/5
     recoverer 被呼叫    : 1 次
     其中送死信失敗      : 0 次
     committed 位移       : 5 / 5
     ch10.deser.v1.DLT 上有 : 1 則

     ── 死信上的那一則 ──
        key   : ORD-3
        value : 上游某個服務直接把純文字丟了進來  ← 原封不動的原始 bytes
        header: [kafka_dlt-exception-cause-fqcn, kafka_dlt-exception-fqcn, kafka_dlt-exception-message, kafka_dlt-exception-stacktrace, kafka_dlt-original-consumer-group, kafka_dlt-original-offset, kafka_dlt-original-partition, kafka_dlt-original-timestamp, kafka_dlt-original-timestamp-type, kafka_dlt-original-topic]
     ⚠️ 它只被送了一次就進 DLT，沒有重試三次 ——
        因為 DeserializationException 在 10.2.0 那份「預設不重試」的清單上
```

**逐階段看**：

**① `15,114 次/秒`。**

把它跟 [00 章 0.5.2](./00-course-map-why-message-queue.md) 那場 RabbitMQ 的
requeue 風暴放在一起：

| | RabbitMQ 的 requeue 風暴 | **Kafka 的反序列化迴圈** |
|---|---|---|
| 速率 | 11,191 次 / 3 秒 ≈ **3,730 次/秒** | **15,114 次/秒** |
| 後面的訊息 | 一起被拖住 | **永遠等不到** |
| 積壓 / lag | 0 ← 看不出有問題 | **一路漲** ← 看得出來 |
| 怎麼修 | `default-requeue-rejected: false` + DLX | `ErrorHandlingDeserializer` |

⚠️ **這一種比 RabbitMQ 那一種更快，但至少 lag 會漲** —— 你的監控看得見。

**② `ErrorHandlingDeserializer` 做了什麼。**

它把真正的 deserializer 包起來，失敗時**不丟例外**，而是把 value 設成 `null`、
再加一個 header 把原始 bytes 與例外裝進去。**那個 header 的名字是常數**：

```
  SerializationUtils.VALUE_DESERIALIZER_EXCEPTION_HEADER = springDeserializerExceptionValue
  SerializationUtils.KEY_DESERIALIZER_EXCEPTION_HEADER   = springDeserializerExceptionKey
```

⚠️ **但那一則還是不會進到你的 `@KafkaListener` 方法** ——
容器在呼叫 listener 之前就會檢查這個 header，發現有就**直接交給 error handler**。
📌 **所以「重試階梯碰得到它」的意思是「error handler 碰得到它」，不是「你的程式碼碰得到它」。**
（對照 10.2.6 ①：不包這一層的時候，失敗發生在更前面的 `poll()` 裡，
連 error handler 都只拿得到一個 `RecordDeserializationException`，拿不到那一則 record。）

**③ ⚠️ 然後你會踩到第二個坑：死信自己寫不進去。**

`ErrorHandlingDeserializer` 交給 recoverer 的 value 是**原始的 `byte[]`**，
而本站那顆 `KafkaTemplate<String, String>` 用的是 `StringSerializer`：

```
SerializationException: Can't convert value of class [B to class
    org.apache.kafka.common.serialization.StringSerializer specified in value.serializer
Caused by: ClassCastException: class [B cannot be cast to class java.lang.String
```

死信送不出去 → 位移不能前進 → **又一個迴圈，這次是每秒 9.7 次**。
比 ① 慢了 1,500 倍，但一樣永遠不會結束。

**④ 正解**：給 recoverer 一份「依 value 型別挑 template」的對照表。

```java
@Bean
public DeadLetterPublishingRecoverer recoverer(KafkaTemplate<String, String> text,
                                               KafkaTemplate<Object, Object> bytes) {
    return new DeadLetterPublishingRecoverer(Map.of(
            byte[].class, bytes,       // ← 反序列化失敗時走這一顆
            String.class, text));
}
```

`bytes` 那一顆的 `value.serializer` 是 `ByteArraySerializer`。
⚠️ **兩顆 template 都要有**，因為「listener 丟例外」與「反序列化失敗」
兩條路徑上的 value 型別不一樣。

**⑤ 最後一行是回到 10.2.0 的閉環**：

```
     ⚠️ 它只被送了一次就進 DLT，沒有重試三次 ——
        因為 DeserializationException 在 10.2.0 那份「預設不重試」的清單上
```

**這是對的行為。** 同一串 bytes 重試 10 次還是會失敗 10 次 ——
`FixedBackOff(0, 2)` 在這裡被**正確地忽略**了。

### 10.2.7 哪些例外不該重試

10.2.0 那份預設清單只涵蓋「框架層面一定不會好」的六種。
**業務上還有一整類**：

```java
@Bean
DefaultErrorHandler errorHandler(DeadLetterPublishingRecoverer recoverer) {
    // ⚠️ 不要寫 new ExponentialBackOff(1000, 2.0) —— 理由見下面那個實驗
    var backOff = new ExponentialBackOffWithMaxRetries(3);   // org.springframework.kafka.support
    backOff.setInitialInterval(1000);
    backOff.setMultiplier(2.0);
    var handler = new DefaultErrorHandler(recoverer, backOff);
    handler.addNotRetryableExceptions(
            IllegalArgumentException.class,      // 參數就是錯的，重試沒用
            OrderNotFoundException.class,        // 訂單不存在，重試沒用
            InsufficientStockException.class);   // 庫存不夠，重試也不會變多
    return handler;
}
```

> ⚠️ **這一段有一個大部分人會踩的地雷，值得單獨量一次。**
>
> `org.springframework.util.backoff.ExponentialBackOff` **沒有次數上限**。
> 它會一直退避下去，只是間隔被 `maxInterval` 封在 30 秒 ——
> **訊息永遠進不了死信，位移也永遠不會前進。**
>
> **輸出**：
>
> ```
> ═══ 10.2.7 ⚠️ ExponentialBackOff 沒有上限 ═══
>
>   ── 先把兩種退避的間隔序列印出來 ──
>      new ExponentialBackOff(1000, 2.0)          1000 2000 4000 8000 16000 30000 30000 30000 30000 30000 30000 30000 …（印了 12 次還沒停）
>      new ExponentialBackOffWithMaxRetries(3)    1000 2000 4000 → STOP（共 3 次重試）
>
>      ExponentialBackOff(1000, 2.0)          毒藥被投遞 5 次、DLT 上 0 則、committed 1 / 3
>
>      ExponentialBackOffWithMaxRetries(3)    毒藥被投遞 4 次、DLT 上 1 則、committed 3 / 3
>      ⚠️ 上面那一行就是差別：沒有上限的那個 25 秒之後還在重試，
>         訊息進不了 DLT、位移也不會前進
> ```
>
> 📌 **`committed 1 / 3` 對 `committed 3 / 3`** ——
> 無上限的那個把**整個分區**卡在 offset 1 上，後面的訊息一則都進不來。
> 這跟 10.2.6 ① 是同一種病，只是慢了一萬倍。
>
> ⚠️ **而且兩個類別在不同的 package**，很容易 import 錯：
>
> | 類別 | package | 有次數上限嗎 |
> |---|---|---|
> | `ExponentialBackOff` | `org.springframework.util.backoff`（Spring Framework） | ❌ **沒有** |
> | `FixedBackOff` | `org.springframework.util.backoff`（Spring Framework） | ✅ 建構子第二個參數 |
> | **`ExponentialBackOffWithMaxRetries`** | **`org.springframework.kafka.support`**（spring-kafka） | ✅ **建構子就是次數** |
>
> 📌 **IDE 的自動 import 只會找到前兩個** —— 第三個要自己記得它在 spring-kafka 裡。

📌 **判斷準則只有一句**：

> **「等一下再試會不會變好？」**
>
> 會 → 重試（連線逾時、下游 503、資料庫死鎖、樂觀鎖衝突）。
> 不會 → 直接進死信（格式錯、欄位缺、業務規則不允許、找不到的實體）。

⚠️ **這件事的成本不對稱**：
把「不該重試的」拿去重試，你付的是 10.2.1 那個 **5,076 ms**（乘以每一則壞訊息）；
把「該重試的」直接丟進死信，你付的是**一筆本來會成功的業務**。
**兩邊都會痛，但第二種更貴** —— 不確定的時候，重試。

### 10.2.8 並排：RabbitMQ 的 DLX 與 Kafka 的 DLT

| | RabbitMQ（[06 章](./06-rabbitmq-retry-delay-and-cluster.md)） | Kafka（本章） |
|---|---|---|
| 是誰的功能 | **broker 的**。宣告佇列時一行參數 | **客戶端的**。broker 完全不知情 |
| 怎麼開 | `.deadLetterExchange(DLX)` | `DefaultErrorHandler` + `DeadLetterPublishingRecoverer` |
| 換一套客戶端還在嗎 | ✅ 在。Go / Python 的消費者一樣會進 DLX | ❌ **不在**。每一種語言都要自己實作一次 |
| 重試退避 | DLX + TTL 階梯（6.3.2） | 重試主題階梯（10.2.4） |
| 重試時主線被卡住 | 45 ms（死信回送） | **10 ms**（重試主題） |
| 重試次數記在哪 | `x-death.count`（broker 維護） | ⚠️ **沒有**。要自己塞 header |
| 死信上有堆疊嗎 | ❌ 沒有 | ✅ 有 |
| 順序 | DLX 本來就沒有順序保證 | ⚠️ **會打破 key 的順序**（10.2.5 ①） |
| 反序列化失敗 | [04 章 4.5.4](./04-rabbitmq-basics-and-topology.md)：`@RabbitListener` 免疫 | ⚠️ **10.2.6：會炸，而且是 15,114 次/秒** |
| 一個佇列 / topic 的成本 | 1 個 DLQ | **N 個 topic + N 個 group** |

⚠️ **第三列是本章最該記住的一句話**：

> **RabbitMQ 的死信是 broker 的行為，Kafka 的死信是你的程式碼的行為。**
>
> 這代表在 Kafka 上，**一個忘了設 error handler 的消費者就會靜靜地把訊息丟掉**
> （10.2.1），而 broker 那邊完全看不出來。

### 10.2.9 本節建議的設定

```java
@Configuration
class KafkaErrorHandling {

    /** 送 byte[] 的 template：給反序列化失敗那條路徑用（10.2.6 ④） */
    @Bean
    KafkaTemplate<Object, Object> bytesKafkaTemplate(KafkaProperties props) {
        Map<String, Object> cfg = new HashMap<>(props.buildProducerProperties(null));
        cfg.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, ByteArraySerializer.class);
        return new KafkaTemplate<>(new DefaultKafkaProducerFactory<>(cfg));
    }

    @Bean
    DeadLetterPublishingRecoverer recoverer(KafkaTemplate<String, String> text,
                                            KafkaTemplate<Object, Object> bytes) {
        return new DeadLetterPublishingRecoverer(Map.of(byte[].class, bytes, String.class, text));
    }

    @Bean
    DefaultErrorHandler errorHandler(DeadLetterPublishingRecoverer recoverer) {
        // ⚠️ 預設是 FixedBackOff(0, 9)（10.2.0）—— 明確寫出來
        // ⚠️ 這個類別在 org.springframework.kafka.support，不是 util.backoff（10.2.7）
        var backOff = new ExponentialBackOffWithMaxRetries(3);
        backOff.setInitialInterval(1000);
        backOff.setMultiplier(2.0);
        backOff.setMaxInterval(8000);
        var handler = new DefaultErrorHandler(recoverer, backOff);
        handler.addNotRetryableExceptions(IllegalArgumentException.class);
        return handler;
    }
}
```

```yaml
spring:
  kafka:
    consumer:
      # ⚠️ 一定要包這一層，理由見 10.2.6
      value-deserializer: org.springframework.kafka.support.serializer.ErrorHandlingDeserializer
      properties:
        spring.deserializer.value.delegate.class: org.springframework.kafka.support.serializer.JsonDeserializer
        spring.json.trusted.packages: com.example.events
```

📌 **`@RetryableTopic` 與 `DefaultErrorHandler` 兩者只挑一個**：

| 你的消費者 | 用哪個 | 為什麼 |
|---|---|---|
| **有順序要求**（狀態機、同一個 `orderId` 的一串事件） | `DefaultErrorHandler` + 短退避 + DLT | 重試主題會打破順序（10.2.5 ①） |
| **彼此獨立**（寄信、產 PDF、打外部 API） | `@RetryableTopic` | 不卡主線，退避可以拉長 |
| **量很大、失敗率很低** | `DefaultErrorHandler` | 省掉 N 個 group 的維運成本 |

---

## 10.3 讓 `traceId` 跨過 broker ★★★

[00 章 0.5.5](./00-course-map-why-message-queue.md) 那張表上有一格欠了很久：

| 工具 | 在哪一章 | 解決什麼 |
|---|---|---|
| traceId 跨 MQ 傳遞 | **10 章 10.3** | 把斷掉的那條鏈接回去：生產者把 traceId 塞進 header，消費者取出來放進 MDC |

**這一節把它做出來，然後量出三個會把它弄丟的地方。**

### 10.3.1 實測：一個請求跨過兩台 broker，日誌長什麼樣

場景是本站最常見的那一條鏈：

```
   POST /orders  →  RabbitMQ（扣庫存）  →  Kafka（寄通知信）
```

```java
package com.example.lab11.ch10;

/** 10.3：讓 traceId 跨過 broker —— 兩邊各做一次 */
@SpringBootTest
class M1TraceTest {

    static final String TRACE = "traceId";
    static final String HDR   = "X-Trace-Id";

    /** 模擬 logback pattern "%d{HH:mm:ss.SSS} [%thread] [%X{traceId:--}] %msg" 印出來的那一行 */
    static void log(String msg) {
        String t = Thread.currentThread().getName();
        if (t.length() > 18) t = t.substring(t.length() - 18);
        LINES.add(String.format("%s [%-18s] [%-10s] %s",
                LocalTime.now().format(HMS), t,
                MDC.get(TRACE) == null ? "-" : MDC.get(TRACE), msg));
    }
}
```

> 📌 **這裡用一個小 helper 把 `%X{traceId}` 那一欄印出來，是為了讓輸出乾淨。**
> 正式環境不需要寫這個 —— 那是 logback 的 pattern 做的事：
>
> ```xml
> <pattern>%d{HH:mm:ss.SSS} [%thread] [%X{traceId:--}] %-5level %logger{36} - %msg%n</pattern>
> ```
>
> `%X{traceId:--}` 的意思是「印 MDC 裡的 `traceId`，沒有的話印 `-`」。

**輸出**：

```
═══ 10.3.1 一個請求跨過兩台 broker，日誌長什麼樣 ═══

  ── ① 什麼都不做（大多數人的起點）──
     17:34:26.485 [main              ] [t-3ac802  ] [HTTP] POST /orders 進來了
     17:34:26.486 [main              ] [t-3ac802  ] [HTTP] 訂單寫入資料庫 ORD-9527
     17:34:26.502 [main              ] [t-3ac802  ] [HTTP] 回 202 Accepted
     17:34:26.509 [stock-1           ] [-         ] [消費者①/Rabbit] 扣庫存 ORD-9527
     17:34:26.514 [notify-C-1        ] [-         ] [消費者②/Kafka] 寄出通知信 notify:ORD-9527
     grep 't-3ac802' 撈得到 : 3 / 5 行

  ── ② 生產端把 traceId 放進 header、消費端取出來放回 MDC ──
     17:34:29.259 [main              ] [t-7b41e9  ] [HTTP] POST /orders 進來了
     17:34:29.259 [main              ] [t-7b41e9  ] [HTTP] 訂單寫入資料庫 ORD-9527
     17:34:29.263 [main              ] [t-7b41e9  ] [HTTP] 回 202 Accepted
     17:34:29.267 [stock-1           ] [t-7b41e9  ] [消費者①/Rabbit] 扣庫存 ORD-9527
     17:34:29.271 [notify-C-1        ] [t-7b41e9  ] [消費者②/Kafka] 寄出通知信 notify:ORD-9527
     grep 't-7b41e9' 撈得到 : 5 / 5 行
```

📌 **`3 / 5` 對 `5 / 5`。**

看起來是小事，但請注意 ① 的第四、五行**除了時間戳之外沒有任何東西連得回前三行**：
不同的執行緒、不同的類別、沒有共同的欄位。
使用者說「我的訂單沒收到信」，你手上只有一個訂單編號，
而 **`ORD-9527` 剛好出現在每一行裡是因為這是教學範例** ——
正式環境的通知服務日誌裡通常只有 `messageId` 與收件地址。

⚠️ **而且 ① 的三行 `main` 執行緒有 traceId，是因為那是同一條執行緒。**
一旦 [05-service/06](../05-service/06-async-and-external-api-calls.md) 的 `@Async`
或 [02 章](./02-outbox-and-transactional-consistency.md) 的輪詢器介入，**連那三行都會斷**（10.3.5）。

### 10.3.2 RabbitMQ 這一側怎麼接

**生產端**：`convertAndSend` 的最後一個參數就是 `MessagePostProcessor`。

```java
rabbit.convertAndSend("", Q, "ORD-9527", m -> {
    m.getMessageProperties().setHeader(HDR, MDC.get(TRACE));
    return m;
});
```

正式環境不要每個呼叫點都寫一次 —— **掛在 template 上**：

```java
@Bean
RabbitTemplate tracedRabbitTemplate(ConnectionFactory cf) {
    RabbitTemplate t = new RabbitTemplate(cf);
    t.setBeforePublishPostProcessors(m -> {
        String id = MDC.get(TRACE);
        if (id != null) m.getMessageProperties().setHeader(HDR, id);
        return m;
    });
    return t;
}
```

**消費端**：掛一個 advice 在容器上。

```java
rc.setAdviceChain((MethodInterceptor) invocation -> {
    Message m = null;
    for (Object a : invocation.getArguments()) if (a instanceof Message mm) m = mm;
    Object id = m == null ? null : m.getMessageProperties().getHeader(HDR);
    if (id != null) MDC.put(TRACE, String.valueOf(id));
    try { return invocation.proceed(); } finally { MDC.remove(TRACE); }
});
```

⚠️ **`finally` 裡的 `MDC.remove` 不是可選的** —— 10.3.4 會量給你看。

正式環境掛在 listener container factory 上，所有 `@RabbitListener` 就都有了：

```java
@Bean
SimpleRabbitListenerContainerFactory rabbitListenerContainerFactory(
        SimpleRabbitListenerContainerFactoryConfigurer configurer, ConnectionFactory cf) {
    var factory = new SimpleRabbitListenerContainerFactory();
    configurer.configure(factory, cf);
    factory.setAdviceChain(traceAdvice());
    return factory;
}
```

### 10.3.3 Kafka 這一側怎麼接

**生產端**：`ProducerRecord` 上就有 `headers()`。

```java
var record = new ProducerRecord<>(T, "ORD-9527", "notify:ORD-9527");
if (MDC.get(TRACE) != null)
    record.headers().add(HDR, MDC.get(TRACE).getBytes(StandardCharsets.UTF_8));
kafka.send(record);
```

⚠️ **Kafka 的 header value 是 `byte[]`，不是 `String`** —— 兩邊都要自己編解碼。
正式環境用 `ProducerInterceptor`，它會蓋住**所有**用這顆 producer 送出去的訊息，
不用在每個呼叫點寫一次：

```java
public class TraceProducerInterceptor implements ProducerInterceptor<Object, Object> {
    @Override public ProducerRecord<Object, Object> onSend(ProducerRecord<Object, Object> r) {
        String id = MDC.get("traceId");
        if (id != null && r.headers().lastHeader("X-Trace-Id") == null)
            r.headers().add("X-Trace-Id", id.getBytes(StandardCharsets.UTF_8));
        return r;
    }
    @Override public void onAcknowledgement(RecordMetadata m, Exception e) { }
    @Override public void close() { }
    @Override public void configure(Map<String, ?> configs) { }
}
```

```yaml
spring:
  kafka:
    producer:
      properties:
        interceptor.classes: com.example.lab11.TraceProducerInterceptor
```

⚠️ **但它只解決「每個呼叫點都要寫一次」，不解決「MDC 是空的」。**
`onSend()` 跑在**呼叫 `send()` 的那條執行緒**上 ——
[02 章](./02-outbox-and-transactional-consistency.md) 的輪詢器執行緒上 MDC 本來就是空的，
攔截器也變不出 traceId 來。
📌 **那一段要靠 10.3.5：輪詢器自己從表裡讀出 traceId 放進 MDC**，
然後這個攔截器才接得上。

**消費端**：`RecordInterceptor`。

```java
kc.setRecordInterceptor(new RecordInterceptor<String, String>() {
    @Override
    public ConsumerRecord<String, String> intercept(ConsumerRecord<String, String> rec,
                                                    Consumer<String, String> c) {
        Header h = rec.headers().lastHeader(HDR);
        if (h != null) MDC.put(TRACE, new String(h.value(), StandardCharsets.UTF_8));
        return rec;
    }
    @Override
    public void afterRecord(ConsumerRecord<String, String> rec, Consumer<String, String> c) {
        MDC.remove(TRACE);          // ⚠️ 這一行不能少，理由見 10.3.4
    }
});
```

📌 **兩邊的對照**：

| | RabbitMQ | Kafka |
|---|---|---|
| header 的型別 | `Object`（AMQP 有型別系統） | **`byte[]`** |
| 生產端掛在哪 | `RabbitTemplate.setBeforePublishPostProcessors` | `ProducerInterceptor`（客戶端層級） |
| 消費端掛在哪 | 容器的 `adviceChain`（AOP） | 容器的 `RecordInterceptor` |
| 清 MDC 的時機 | `finally` | **`afterRecord()`** |
| 死信會不會保留 | ✅ 會（10.3.6） | ✅ 會（10.3.6） |

### 10.3.4 ⚠️ 忘了清 MDC：下一則訊息帶著上一則的 `traceId`

**這是本節唯一一個「不做會出事而且你不會發現」的地方。**

消費者容器是**執行緒重用**的：同一條 `notify-C-1` 執行緒處理完這一則就處理下一則。
`MDC` 是 `ThreadLocal`。**你 `put` 進去沒有 `remove`，它就會留在那條執行緒上。**

```java
kc.setRecordInterceptor(new RecordInterceptor<String, String>() {
    @Override public ConsumerRecord<String, String> intercept(...) {
        Header h = r.headers().lastHeader(HDR);
        if (h != null) MDC.put(TRACE, new String(h.value(), StandardCharsets.UTF_8));
        return r;
    }
    @Override public void afterRecord(...) {
        if (clear) MDC.remove(TRACE);      // ← 實驗的兩個版本差這一行
    }
});
```

送三則：**第一則帶 `traceId`，後兩則沒有**（例如來自排程、或別的系統寫進來的）。

**輸出**：

```
═══ 10.3.4 ⚠️ 忘了清 MDC：下一則訊息帶著上一則的 traceId ═══

  ── ① 只有 intercept() 裡 MDC.put(...)，沒有清 ──
     17:34:14.518 [notify-C-1        ] [t-aaaa11  ] 處理 ORD-A（帶 traceId）
     17:34:14.518 [notify-C-1        ] [t-aaaa11  ] 處理 ORD-B（沒有 traceId）
     17:34:14.518 [notify-C-1        ] [t-aaaa11  ] 處理 ORD-C（沒有 traceId）
     ⚠️ 被冠上別人 traceId 的行數 : 2

  ── ② afterRecord 裡 MDC.remove("traceId") ──
     17:34:19.464 [notify-C-1        ] [t-aaaa11  ] 處理 ORD-A（帶 traceId）
     17:34:19.464 [notify-C-1        ] [-         ] 處理 ORD-B（沒有 traceId）
     17:34:19.464 [notify-C-1        ] [-         ] 處理 ORD-C（沒有 traceId）
     ⚠️ 被冠上別人 traceId 的行數 : 0
```

⚠️ **這比「沒有 traceId」更糟。**

沒有 traceId，你只是查不到；
**掛著別人的 traceId，你會查到錯的東西** —— `grep t-aaaa11` 撈出三筆訂單，
其中兩筆跟那個請求毫無關係。出事的時候，這會讓你往完全錯誤的方向查半小時。

📌 **三個一定要清的地方**：

```java
// ① 消費者（RecordInterceptor.afterRecord / advice 的 finally）
// ② HTTP filter 的 finally
// ③ 任何你自己開的執行緒池 —— 而且是「拿到任務前先清」比「做完再清」安全
```

### 10.3.5 Outbox 的輪詢器是第三個斷點

[02 章](./02-outbox-and-transactional-consistency.md) 的輪詢器**跑在自己的執行緒上**。
HTTP 執行緒的 MDC 到不了那裡 —— `ThreadLocal` 就是這個意思。

```java
// ── HTTP 執行緒：交易裡寫訂單 + 寫 outbox ──
MDC.put("traceId", traceId);
st.execute("INSERT INTO ch10_outbox (id, payload, trace_id, status) VALUES (...)");
MDC.remove("traceId");

// ── 輪詢器執行緒：讀出來送 ──
Thread poller = new Thread(() -> {
    ResultSet rs = st.executeQuery("SELECT id, payload, trace_id FROM ch10_outbox WHERE status='PENDING'");
    while (rs.next()) {
        var rec = new ProducerRecord<>(T, "ORD-9527", rs.getString("payload"));
        String tid = rs.getString("trace_id");
        if (tid != null) rec.headers().add(HDR, tid.getBytes(StandardCharsets.UTF_8));
        kafka.send(rec);
    }
}, "outbox-poller");
```

**輸出**：

```
═══ 10.3.5 Outbox 的輪詢器是第三個斷點 ═══
  02 章的輪詢器跑在自己的執行緒上 —— HTTP 執行緒的 MDC 到不了那裡

  ── ① outbox 表沒有存 traceId ──
     HTTP 執行緒上的 traceId : t-cc3302
     消費端拿到的 X-Trace-Id   : （沒有）

  ── ② outbox 表多一欄 trace_id，輪詢器讀出來塞 header ──
     HTTP 執行緒上的 traceId : t-bb2201
     消費端拿到的 X-Trace-Id   : t-bb2201
```

📌 **所以 [02 章 2.4.2](./02-outbox-and-transactional-consistency.md) 的 outbox 表要多一欄**：

```sql
ALTER TABLE outbox ADD COLUMN trace_id VARCHAR(64) NULL;
```

⚠️ **這一欄不是為了「以後可能有用」，是為了讓那條鏈接得起來。**
Outbox 的訊息本來就是「延遲送出」的 —— 出事的時候你最需要知道
「這則訊息是哪一個請求產生的」，而那個請求可能是三分鐘前的事。

> 📌 **同樣的道理適用於任何「把工作存起來稍後做」的地方**：
> 排程表、重試佇列、批次檔。
> **只要送出訊息的執行緒不是收到請求的那一條，traceId 就必須跟著資料走，不能跟著執行緒走。**

### 10.3.6 死信帶不帶 `traceId`

死信是你最需要 traceId 的地方 —— 那一則訊息就是出事的那一則。

**輸出**：

```
═══ 10.3.6 死信帶不帶 traceId ═══

  ── Kafka：DLT 上的那一則 ──
     X-Trace-Id             : t-dd4403
     kafka_dlt-original-topic : ch10.trace2.v1
     → 原本的 header 原封不動搬過去了

  ── RabbitMQ：DLQ 上的那一則 ──
     X-Trace-Id             : t-ee5504
     x-death 在不在            : 在
```

✅ **兩邊都會保留。**

- Kafka：`DeadLetterPublishingRecoverer` 是用 `new RecordHeaders(record.headers().toArray())`
  複製一份，再**加上** `kafka_dlt-*`。
- RabbitMQ：DLX 是 broker 做的搬移，原 header 原封不動，**加上** `x-death`。

📌 **所以死信佇列的告警訊息裡應該直接帶上 traceId**：

```
  [ALERT] order.created.v1.DLT 積壓 3 則
          最舊的一則 traceId=t-dd4403，錯誤=IllegalStateException: 金額是 null
```

拿著那個 traceId 去 `grep`，你會一路撈到那個 HTTP 請求。

### 10.3.7 `traceId` 該怎麼設計

| 問題 | 建議 | 為什麼 |
|---|---|---|
| header 叫什麼 | 跟著你的追蹤系統走（W3C 的 `traceparent`、B3 的 `X-B3-TraceId`），**不要自己發明** | 換 APM 的時候不用改所有服務 |
| 誰產生 | **最外層的入口**（gateway 或第一個 HTTP filter）。沒有就補一個 | 補在中間的話前半段就斷了 |
| 消費者要不要產生新的 | **不要換 traceId，可以加 spanId** | traceId 是「同一件事」，spanId 是「這一段」 |
| 訊息重放的時候 | ⚠️ **保留原 traceId，另外加一個 `X-Replay-Id`** | 不然重放出來的日誌會跟原始那次混在一起 |
| 要不要進 payload | **不要。放 header** | payload 是業務契約，traceId 是傳輸細節（[04 章 4.5.6](./04-rabbitmq-basics-and-topology.md) 的相容性規則） |

> 📌 **這一節做的是「窮人版的分散式追蹤」。**
> 正式環境如果已經有 Micrometer Tracing / OpenTelemetry，
> **spring-kafka 與 spring-rabbit 的 `observationEnabled` 打開就自動做完這一切**。
>
> ⚠️ **看起來應該長這樣 —— 但先別複製，下面會證明它有一半是假的**：
>
> ```yaml
> spring:
>   kafka:
>     listener.observation-enabled: true
>     template.observation-enabled: true
>   rabbitmq:
>     listener.simple.observation-enabled: true     # ❌ 這一行不存在
>     template.observation-enabled: true            # ❌ 這一行也不存在
> ```
>
> **但你還是要懂這一節**，因為 ① 10.3.5 那個 Outbox 斷點沒有任何框架會幫你補、
> ② 出事的時候你要知道那個 header 長什麼樣、③ 跨團隊 / 跨語言的時候要對規格。

⚠️ **上面那段 YAML 有一半是假的，這件事本身就值得記一下。**

把 Boot 3.2.5 的 `spring-configuration-metadata.json` 撈出來查：

```
═══ 10.3.7 observation-enabled 這四個設定項存不存在（Boot 3.2.5）═══
  spring.kafka.listener.observation-enabled            ✅ 存在，預設 False
  spring.kafka.template.observation-enabled            ✅ 存在，預設 False
  spring.rabbitmq.listener.simple.observation-enabled  ❌ 不存在
  spring.rabbitmq.template.observation-enabled         ❌ 不存在
```

**Kafka 那兩個有，RabbitMQ 那兩個沒有。** RabbitMQ 這一側要用程式開：

```
═══ 10.3.7 RabbitMQ 這一側要用程式開 ═══
  ✅ 有 RabbitTemplate.setObservationEnabled(boolean)
  ✅ 有 AbstractRabbitListenerContainerFactory.setObservationEnabled(boolean)
  ✅ 有 AbstractMessageListenerContainer.setObservationEnabled(boolean)
  ✅ 有 KafkaTemplate.setObservationEnabled(boolean)
  ✅ 有 ContainerProperties.setObservationEnabled(boolean)
```

```yaml
spring:
  kafka:
    listener.observation-enabled: true     # ✅ 這兩個是真的
    template.observation-enabled: true
```

```java
// ⚠️ RabbitMQ 這一側沒有對應的設定項，要用程式
@Bean RabbitTemplate rabbitTemplate(ConnectionFactory cf) {
    var t = new RabbitTemplate(cf);
    t.setObservationEnabled(true);
    return t;
}

@Bean SimpleRabbitListenerContainerFactory rabbitListenerContainerFactory(
        SimpleRabbitListenerContainerFactoryConfigurer cfg, ConnectionFactory cf) {
    var f = new SimpleRabbitListenerContainerFactory();
    cfg.configure(f, cf);
    f.setObservationEnabled(true);
    return f;
}
```

> ⚠️ **這就是本站一直在講的那種坑**：
> **打錯 / 不存在的設定項，Spring Boot 不會報錯，它只是什麼都不做。**
> 跟 [04 章 4.7.2](./04-rabbitmq-basics-and-topology.md) 的「打錯一個字：一個立刻炸、一個無聲丟棄」
> 是同一種形狀。
> 📌 **驗證方法**：`spring-configuration-metadata.json` 裡找得到才是真的
> （IDE 的自動完成就是讀這個檔）。

⚠️ **而這件事本身就是「為什麼要自己查 metadata」最好的例子 —— 因為它後來變了。**

同一支查詢跑在 **Boot 3.5.0** 的 metadata 上：

```
═══ 10.3.7b 同樣四個設定項，換成 Boot 3.5.0 ═══
  spring.kafka.listener.observation-enabled              ✅ 存在，預設 False
  spring.kafka.template.observation-enabled              ✅ 存在，預設 False
  spring.rabbitmq.template.observation-enabled           ✅ 存在，預設 False   ← 3.2.5 沒有
  spring.rabbitmq.listener.simple.observation-enabled    ✅ 存在，預設 False   ← 3.2.5 沒有
  spring.rabbitmq.listener.direct.observation-enabled    ✅ 存在，預設 False
  spring.rabbitmq.listener.stream.observation-enabled    ✅ 存在，預設 False
```

📌 **所以上面那段「RabbitMQ 要用程式開」只適用於 Boot 3.2 那一代。**
Boot 3.5 之後那四個（其實是六個）設定項都有了，YAML 就寫得出來。

> ⚠️ **這一段才是這一節真正的教訓**：
> **「這個設定項存不存在」是一個跟版本綁死的事實，不是一個可以背起來的知識。**
> 課文寫的是 3.2.5 的答案；**你的專案是哪個版本，就用那個版本的 metadata 查一次**：
>
> ```bash
> unzip -p ~/.m2/repository/org/springframework/boot/spring-boot-autoconfigure/<版本>/\
> spring-boot-autoconfigure-<版本>.jar META-INF/spring-configuration-metadata.json \
>   | python3 -c "import json,sys; [print(p['name']) for p in json.load(sys.stdin)['properties'] if 'observation' in p['name']]"
> ```

---

## 10.4 consumer lag 監控與告警線 ★★★

[00 章 0.5.5](./00-course-map-why-message-queue.md) 說：

> **你唯一的窗口是「積壓」與「lag」這兩個數字**，而 0.5.2 已經證明它們**可以完全正常但系統正在死**。

[08 章 8.8.5](./08-kafka-consumer-group-and-offset.md) 又說：

> 📌 **本站用的 `MsgProbe.lag(topic, group)` 是「臨時查一下」的等級**，不要照抄進正式環境 ——
> 正式環境的 lag 監控要用常駐的 exporter（10 章會講）。

**這一節解釋「為什麼要常駐的 exporter」—— 而理由比「臨時查一下不方便」嚴重得多。**

### 10.4.1 先講清楚 lag 是哪個減哪個

```
                           ┌─ end offset = 6（下一則會寫在這裡）
                           ▼
   ┌───┬───┬───┬───┬───┬───┐
   │ 0 │ 1 │ 2 │ 3 │ 4 │ 5 │   分區 p0：六則都已經寫進來了
   └───┴───┴───┴───┴───┴───┘
         ▲       ▲
         │       └─ fetch position = 3（客戶端抓進記憶體了，還沒處理完）
         └───────── committed offset = 1（真的處理完並記下來了）

   外部工具算的 lag  = end offset − committed offset  = 6 − 1 = 5
   records-lag-max  = high watermark − fetch position = 6 − 3 = 3
```

⚠️ **這兩個數字不一樣，而且差距可以是全部。**

### 10.4.2 ⚠️ 實測：`records-lag-max` 量的不是你以為的那個 lag ★★★

```java
/** 10.4：consumer lag 要從哪裡拿 —— 客戶端 metric 與外部 AdminClient 是兩件事 */
@SpringBootTest
class N1LagTest {

    /** 外部工具（exporter）算 lag 的方法：end offset 減 committed offset */
    static long adminLag() {
        try (AdminClient ac = admin()) {
            var committed = ac.listConsumerGroupOffsets(G).partitionsToOffsetAndMetadata().get();
            // ... 逐分區 end − committed
        }
    }

    /** 消費者自己的 metric */
    static String clientLagMax(KafkaMessageListenerContainer<?, ?> c) {
        for (var per : c.metrics().values())
            for (var e : per.entrySet())
                if ("records-lag-max".equals(e.getKey().name())
                        && !e.getKey().tags().containsKey("topic"))      // 只取彙總的那一顆
                    // ...
    }
}
```

**輸出**：

```
═══ 10.4.2 ⚠️ records-lag-max 量的不是你以為的那個 lag ═══

  ── A：5,000 則先躺在 broker 上，消費者每則 20 ms ──
     時刻       已處理        records-lag-max        AdminClient 的 lag
       2.5 秒 107        1,070                  5,000         
       5.0 秒 216        1,070                  5,000         
       7.5 秒 324        1,070                  5,000         
      10.1 秒 432        1,070                  5,000         
      12.6 秒 540        1,070                  4,500         

  ── B：生產 200 則/秒、消費 50 則/秒（積壓一路長）──
     時刻       已生產        已處理        records-lag-max        AdminClient 的 lag
       2.5 秒 408        106        0                      366           
       5.0 秒 826        216        0                      646           
       7.5 秒 1,238      325        0                      1,058         
      10.1 秒 1,650      433        0                      1,237         
      12.6 秒 2,065      542        0                      1,653         
      15.1 秒 2,478      651        0                      2,066         

     消費者 stop() 之後：records-lag-max = 0、AdminClient 的 lag = 1,786
     （停之前的最後一筆：0 / 2,066）

  📌 records-lag-max 是「fetcher 的位置」離 high watermark 多遠，
     不是「你處理到哪」離 high watermark 多遠。
     B 的積壓全部躺在消費者自己的記憶體緩衝區裡 —— broker 看起來一點都不落後。
```

📌 **B 那一欄是本章最該記住的東西**：

> **`records-lag-max` 一路是 `0`，而真正的 lag 已經 `2,066` 並且還在漲。**

**為什麼**：Kafka 客戶端的 fetcher 是**貪心預抓**的。
生產速率 200 則/秒對 fetcher 來說毫無壓力 —— 它一抓就抓一大批進記憶體。
於是：

```
   broker 上還沒被「抓走」的     → 幾乎是 0   ← records-lag-max 量這個
   抓走了但還躺在客戶端緩衝區裡  → 一路成長    ← 沒有任何 metric 量這個
   真正處理完並提交的            → 落後 2,066  ← AdminClient 量這個
```

**A 的情況也沒有比較好**：5,000 則預先躺著，`records-lag-max` 顯示 **1,070**，
真正的 lag 是 **5,000**。⚠️ **它不是錯的，它是在回答另一個問題。**

⚠️ **最後那一句也很重要**：消費者 `stop()` 之後，`records-lag-max` 還是 `0`。
在同一個 JVM 裡它是**過期的舊值**；而如果整個行程死了，**這個 metric 連同它的 exporter 一起消失**
—— 你的儀表板上那條線不是往上衝，是**斷掉**。很多告警規則對「沒有資料」是不觸發的。

> 📌 **這就是「要用常駐的外部 exporter」的真正理由**：
>
> | | 消費者自己的 metric | 外部 exporter（AdminClient） |
> |---|---|---|
> | 量的是什麼 | fetcher 落後多少 | **committed offset 落後多少** ← 你要的 |
> | 消費者掛掉時 | **跟著消失 / 停在舊值** | 照常運作，而且數字繼續漲 |
> | group 整組死光時 | 沒有任何資料 | **看得到 lag 一路漲** |
> | 要不要改應用程式 | 要 | **不用** |
> | 額外的 broker 負載 | 無 | 每次輪詢兩個 API 呼叫 |
>
> 常見的實作是 `kafka-exporter` / `kafka-lag-exporter` / Burrow，
> 它們做的事就是本節那支 `adminLag()`：`listConsumerGroupOffsets` + `listOffsets`。

⚠️ **那 `records-lag-max` 就沒用了嗎？** 有用，但它回答的是另一個問題：
**「我的 fetcher 跟得上嗎」** —— 它變大代表**網路或 broker 是瓶頸**，
而不是你的業務邏輯慢。**兩個都要看，但告警要用外部那個。**

### 10.4.3 實測：rebalance 次數是因，lag 是果

[08 章 8.8.5](./08-kafka-consumer-group-and-offset.md) 主張：

> ⚠️ **「rebalance 次數」是這一章最值得加的一個告警**，因為它是**因**，
> 而 lag 只是**果**。

**這一節把兩條線並排。** 兩個場景完全一樣（生產 100 則/秒、每則處理 300 ms、一批 20 則），
只差一個設定：`max.poll.interval.ms`。
一批要 `20 × 300 = 6,000 ms`，所以 `4,000` 那一組**每一批都會被踢出 group**
（[08 章 8.5.3](./08-kafka-consumer-group-and-offset.md) 的那個「永遠跑不完的迴圈」）。

**輸出**：

```
═══ 10.4.3 rebalance 次數是因，lag 是果 ═══
  08 章 8.8.5 主張「rebalance 次數比 lag 更值得告警」—— 這一節把兩條線並排

  ── max.poll.interval.ms = 300,000（一批 20 則 × 每則 300 ms = 6,000 ms）──
     時刻       已生產        做過幾次工      相異則數       rebalance-total  lag         
       5.0 秒 415        17         17         1                416         
      10.1 秒 839        33         33         1                820         
      15.1 秒 1,264      50         50         1                1,224       
      20.1 秒 1,688      67         67         1                1,628       
      25.2 秒 2,110      83         83         1                2,031       
      30.2 秒 2,536      100        100        1                2,456       
     總結：做了 100 次工，其中只有 100 則是「新的」——重複率 0%

  ── max.poll.interval.ms = 4,000（一批 20 則 × 每則 300 ms = 6,000 ms）──
     時刻       已生產        做過幾次工      相異則數       rebalance-total  lag         
       5.0 秒 423        17         17         1                423         
      10.0 秒 846        33         22         2                846         
      15.1 秒 1,268      50         29         3                1,268       
      20.1 秒 1,693      67         29         4                1,692       
      25.1 秒 2,118      83         29         5                2,118       
      30.1 秒 2,543      100        29         5                2,542       
     總結：做了 100 次工，其中只有 29 則是「新的」——重複率 71%
```

📌 **把四個數字擺在一起看**：

| | 健康的那台 | 反覆 rebalance 的那台 |
|---|---|---|
| **lag（30 秒後）** | **2,456** | **2,542** ← 幾乎一樣 |
| CPU（做過幾次工） | 100 | **100** ← 一模一樣 |
| **真正的進度（相異則數）** | **100** | **29** |
| `rebalance-total` | **1** | **5** |

⚠️ **前兩列一模一樣。**

如果你的儀表板上只有 lag 跟 CPU，**這兩台機器長得一模一樣** ——
你會得到「消費者太慢，加機器吧」這個結論，然後加了機器**問題完全沒有改善**
（因為每一台都會被踢出去）。

**而 `相異則數` 從第 15 秒起就凍在 29** —— 那台機器從第 15 秒開始，
**做的每一件事都是白做的**。唯一分得出這件事的數字是 `rebalance-total`。

> 📌 **這一節證明了 08 章 8.8.5 那句話，而且比它說的更強**：
> **rebalance 次數不只是「比 lag 早」，它是「lag 完全看不到」的一個維度。**

⚠️ **一個實務上的細節**：`failed-rebalance-total` 在**健康的那台上也是 1**
（第一次入團就算一次）。**不要對「> 0」告警**，要對「持續成長」告警。

### 10.4.4 lag 的五種假象

本站到這裡一共量到五種「lag 騙了你」的情況。**這一節把它們收齊**：

| # | 假象 | 實測 | 在哪一章 |
|---|---|---|---|
| **①** | **lag = 0 但訊息沒被處理** | 自動提交把沒處理的也提交了 → **250/300 則遺失而 lag = 0** | [01 章 1.5.2](./01-reliable-delivery-three-hops.md) |
| **②** | **lag = 0 但訊息被丟掉了** | 毒藥訊息重試 10 次後被跳過 → **committed 追平、訊息消失** | 本章 10.2.1 |
| **③** | **lag 在漲但消費者是閒的** | 開著沒 commit 的交易把 `read_committed` 擋在 LSO → **讀到 0 則、LAG = 10** | [09 章 9.3.2](./09-kafka-exactly-once-and-retention.md) |
| **④** | **lag 從 500 萬瞬間變 0，而那 500 萬則從來沒被處理** | 落後超過 retention + `auto.offset.reset = latest` | [09 章 9.5.3](./09-kafka-exactly-once-and-retention.md) |
| **⑤** | **客戶端 metric 顯示 0，真正的 lag 是 2,066** | `records-lag-max` 量的是 fetcher，不是你處理到哪 | 本章 10.4.2 |

⚠️ **所以「lag = 0」這件事本身什麼都不保證。**
真正能保證「事情做完了」的只有**業務層的數字**：
今天成立 1,043 張訂單、寄出 1,043 封信。
📌 **每一個消費者都應該輸出一個「我處理成功了幾則」的計數器** ——
它跟 lag 一起看才有意義。

### 10.4.5 實測：lag 要換算成「落後幾秒」才有意義

[09 章 9.5.3](./09-kafka-exactly-once-and-retention.md) 給了三個防法，第三個是：

> | **③ 告警 lag「佔 retention 的比例」** | 比絕對值有意義：lag 對應的時間跨度接近 retention 就該告警 |

**這一節把它算出來。** 做法是：拿 committed offset 那一則的 `timestamp`，
跟現在比。

```java
try (AdminClient ac = admin(); KafkaConsumer<String, String> kc = new KafkaConsumer<>(c)) {
    var committed = ac.listConsumerGroupOffsets(G).partitionsToOffsetAndMetadata().get();
    for (int p = 0; p < PARTS; p++) {
        var tp = new TopicPartition(T, p);
        var om = committed.get(tp);
        if (om == null) continue;
        kc.assign(List.of(tp));
        kc.seek(tp, om.offset());               // ← 跳到「下一則要處理的」
        var recs = kc.poll(Duration.ofSeconds(5)).records(tp);
        if (!recs.isEmpty()) oldest = Math.min(oldest, recs.get(0).timestamp());
    }
}
long behindMs = System.currentTimeMillis() - oldest;
```

**輸出**：

```
═══ 10.4.5 lag 要換算成「落後幾秒」才有意義 ═══
  09 章 9.5.3 說「告警 lag 佔 retention 的比例」—— 這一節把它算出來

  共寫進 1,200 則，其中後 600 則是分散在 14,030 ms 裡寫進去的
  消費者處理掉 600 則之後就停了

  ① 傳統的 lag（則數）     : 600 則
  ② 下一則要處理的那筆寫入時間 : 2026-09-22T09:48:16.272Z
  ③ 換算成時間的 lag        : 16,107 ms
  ④ 如果 retention 是 7 天  : 用掉 0.0027%
  ⑤ 如果 retention 是 1 小時 : 用掉 0.45%  ← 同樣的 lag，兩個結論

  📌 「幾則」不能告警，「用掉 retention 的百分之幾」可以
```

📌 **「600 則」這個數字本身沒有意義**：

- 一個每秒 10 則的 topic 上，600 則 = 落後一分鐘 → 沒事。
- 一個每秒 50,000 則的 topic 上，600 則 = 落後 12 毫秒 → 完全健康。
- 一個每天才 100 則的 topic 上，600 則 = **落後六天** → 快撞上 retention 了。

⚠️ **而 ④ 跟 ⑤ 是同一個 lag 的兩個結論** —— 差別只在 retention 設多少。
`0.0027%` 可以睡覺，`0.45%` 也還好，但如果這個數字是 **80%**，
你剩下的時間只夠開一次會。

> 📌 **建議的告警規則**（兩條都要）：
>
> ```
>   ① lag 的時間跨度 > retention × 20%      → warning
>   ② lag 的時間跨度 > retention × 50%      → critical，而且要叫人起床
> ```
>
> **理由**：`auto.offset.reset = latest`（預設）撞上 retention 的結果是
> [09 章 9.5.3](./09-kafka-exactly-once-and-retention.md) 那個
> **「lag 從 500 萬瞬間變 0、監控圖上看起來修好了、而那 500 萬則從來沒被處理」**。
> **那是無聲的，所以警報一定要在它發生之前響。**

### 10.4.6 實測：RabbitMQ 這一側要看的四個數字

RabbitMQ 沒有 lag，它有**佇列深度**。但只看深度會漏掉最惡毒的一種故障。

```java
/** ⚠️ 四個數字：messages 是前兩個的總和，單看它分不出 ② 跟 ③ */
String[] qstat(String name) {
    String raw = sh("docker", "exec", "rabbit-lab", "rabbitmqctl", "-q", "list_queues",
            "name", "messages_ready", "messages_unacknowledged", "consumers", "messages");
    // ...
}
```

四種狀態各量一次：

**輸出**：

```
═══ 10.4.6 RabbitMQ 這一側要看的四個數字 ═══

  狀態                             ready    unacked   consumers  messages   DLQ     
  ① 正常（跟得上）                      0        0         1          0          0       
  ② 消費者全部下線                      200      0         0          200        0       
  ③ 消費者卡死（不 ack）                 150      50        1          200        0       
  ④ 全部進死信                        0        0         1          0          200     

  ⚠️ ③ 是最惡毒的一種：ready 在下降、消費者數 = 1 ——
     只有 unacked 這一個數字說得出「它們卡住了」
  ⚠️ 而 messages 這一欄（= ready + unacked）在 ② 跟 ③ 上一模一樣 —— 單看它分不出來
```

📌 **③ 那一列請看仔細**：

```
  ready = 150（正在下降）   consumers = 1（活著）   DLQ = 0（沒有錯誤）
```

**如果你的告警只有「佇列深度」，這一格看起來比 ② 健康** ——
深度從 200 掉到 150，「消費者正在處理」。
**實際上那 50 則卡在 `prefetch` 裡，一則都沒有被處理，而且永遠不會。**

這正是 [05 章 5.7](./05-rabbitmq-reliability.md) 那個
「消費者凍住要 180 秒才回收」的故障形狀 —— 而在那 180 秒裡，
**`unacked` 是唯一會動的數字**。

📌 **RabbitMQ 的告警清單**：

| 數字 | 怎麼拿 | 告警條件 | 抓得到什麼 |
|---|---|---|---|
| `messages_ready` | `list_queues` / HTTP API | 持續成長 | 消費不過來、消費者掛光（②） |
| **`messages_unacknowledged`** | 同上 | **持續 > prefetch × 消費者數 × 80%，而且不動** | **消費者卡死（③）** ⭐ |
| `consumers` | 同上 | **= 0** | 部署炸了、連線斷了（②） |
| **DLQ 的 `messages`** | 同上 | **> 0** | 毒藥訊息（④），[06 章 6.2.1](./06-rabbitmq-retry-delay-and-cluster.md) |
| `consumer_utilisation` | HTTP API | ⚠️ **不要拿來調 prefetch** | [05 章 5.4.7](./05-rabbitmq-reliability.md) 實測過它會誤導 |

⚠️ **`messages` 這個欄位是 `ready + unacked` 的總和，而它是管理介面最顯眼的那一欄** ——
輸出的第五欄就是證據：**② 跟 ③ 都是 `200`**。
一個是「沒有人在消費」、一個是「有人在消費但全部卡住」，**這個數字分不出來。**

### 10.4.7 兩邊的告警清單

| 你想抓到 | RabbitMQ | Kafka |
|---|---|---|
| 消費不過來 | `messages_ready` 持續成長 | **外部 exporter 的 lag**（不是 `records-lag-max`，10.4.2） |
| 快撞上保留期限 | ❌ 不適用（訊息讀完就沒了） | **lag 的時間跨度 / retention**（10.4.5） |
| 消費者掛光 | `consumers = 0` | `--describe` 的 `CONSUMER-ID` 變 `-`，或 group 狀態 `Empty` |
| 消費者卡死但連線還在 | **`messages_unacknowledged` 不動**（10.4.6 ③） | ⚠️ **`rebalance-total` 持續成長**（10.4.3） |
| 毒藥訊息 | **DLQ 深度 > 0**（[06 章 6.2.1](./06-rabbitmq-retry-delay-and-cluster.md)） | **DLT 的 end offset 成長** |
| 位移自己過期 | ❌ 不適用 | ⚠️ **group 從 `--list` 消失**（[08 章 8.8.4](./08-kafka-consumer-group-and-offset.md)：`offsets.retention.minutes` 預設 7 天） |
| 開著沒關的交易 | ❌ 不適用 | **lag 在漲但消費者是閒的**（[09 章 9.3.2](./09-kafka-exactly-once-and-retention.md) 的 LSO） |
| 「事情到底有沒有做完」 | **業務計數器** | **業務計數器**（10.4.4） |

📌 **最後一列是唯一不會騙你的**。前面每一個數字都有它的假象。

---

## 10.5 死信的經營與重放 SOP

[06 章 6.2.4](./06-rabbitmq-retry-delay-and-cluster.md) 說過「死信佇列該怎麼經營」。
**這一節補上 Kafka 這一側，並且量出一個大家都會犯的錯。**

### 10.5.1 死信沒有人看，等於沒有死信

```
  死信佇列 / 死信主題的積壓 > 0  →  告警
```

這一行是 [06 章 6.2.1](./06-rabbitmq-retry-delay-and-cluster.md) 的結論。
**但告警只是第一步**，死信要能被「處理掉」，而處理掉只有三條路：

| 路 | 什麼時候用 | 做什麼 |
|---|---|---|
| **① 修好程式，重放** | bug 造成的（欄位沒處理、下游 schema 改了） | 10.5.2 的 SOP |
| **② 修好資料，重放** | 上游送錯（金額是 null、幣別打錯） | 改完 payload 再送回去 |
| **③ 決定不處理，歸檔** | 業務上本來就該失敗（訂單已取消、帳號已停用） | **搬到另一個 topic / 表，不要刪掉** |

⚠️ **③ 不要直接刪。** 死信是你唯一的證據 ——
半年後有人問「為什麼這張訂單沒出貨」，你要拿得出那一則訊息與它的例外。

### 10.5.2 實測：把死信放回原 topic —— 然後你做了一個很慢的無窮迴圈

```java
/** 重放一輪：把 DLT 上現有的訊息搬回原 topic。limit<0 表示不設上限 */
ReplayRound replayOnce(int limit, String toolGroup) {
    try (KafkaConsumer<String, String> kc = new KafkaConsumer<>(cfg(toolGroup))) {
        kc.subscribe(List.of(DLT));
        for (var r : kc.poll(Duration.ofMillis(500))) {
            int n = replayCountOf(r) + 1;
            if (limit >= 0 && n > limit) { refused++; continue; }
            var out = new ProducerRecord<>(T, r.key(), r.value());
            out.headers().add(REPLAY, String.valueOf(n).getBytes(StandardCharsets.UTF_8));
            kafka.send(out);
            moved++;
        }
        kc.commitSync();
    }
}
```

**輸出**：

```
═══ 10.5.2 把死信放回原 topic —— 然後你做了一個很慢的無窮迴圈 ═══

  原 topic 5 則、DLT 1 則、msg-2 試了 2 次

  ── ① bug 還沒修好就重放（不設上限，同一個重放工具，每輪只搬新的）──
     第 1 輪：搬回原 topic 1 則 → 原 topic 共 6 則、DLT 共 2 則、msg-2 累計試了 4 次
     第 2 輪：搬回原 topic 1 則 → 原 topic 共 7 則、DLT 共 3 則、msg-2 累計試了 6 次
     第 3 輪：搬回原 topic 1 則 → 原 topic 共 8 則、DLT 共 4 則、msg-2 累計試了 8 次
     ⚠️ 每一輪都：DLT → 原 topic → 再失敗 → 再回 DLT。永遠不會停

  ── ② 換一個工具，把整個 DLT 從頭重放一次，但帶 X-Replay-Count、上限 3 ──
     DLT 上原本 4 則 → 搬回 3 則、擋下 1 則
     重放之後 DLT 共 7 則、msg-2 累計試了 14 次

  ── ③ 正確的順序：先修好，再重放 ──
     DLT 上 7 則 → 全部搬回原 topic
     msg-2 這次處理成功了嗎 : ✅ 是
     ⚠️ 但它被處理了 7 次 —— DLT 上那 7 份全部重放回來了
        沒有 03 章的冪等消費，這裡就是重複扣款
     重放之後 DLT 又長到 7 則了嗎 : 否（bug 修好了）

  ── ④ 但是順序 ──
     同一個 key（ORD-1）的處理順序：
     msg-0 → msg-1 → msg-3 → msg-4 → msg-2
     ⚠️ msg-2 排到最後了 —— 重放一定會打亂順序，這是它的價碼
```

📌 **四個結論，每一個都是實務上會踩的**：

**① bug 還沒修好就重放 = 一個很慢的無窮迴圈。**

`DLT → 原 topic → 再失敗 → 再回 DLT`。每一輪都在原 topic 上**多留一則垃圾**
（5 → 6 → 7 → 8），在 DLT 上**多留一份**（1 → 2 → 3 → 4）。
⚠️ 它比 [00 章 0.5.2](./00-course-map-why-message-queue.md) 那場風暴慢了幾千倍，
所以**不會有人注意到** —— 直到某天有人發現 DLT 上有一萬份同一則訊息。

**② `X-Replay-Count` header 是最小的防護。**

每次重放 `+1`，超過上限就不再搬。⚠️ **注意這是「你自己做的」** ——
[06 章 6.2.3](./06-rabbitmq-retry-delay-and-cluster.md) 的 RabbitMQ 有 `x-death.count`，
而 Kafka 這一側**只有 `@RetryableTopic` 那條路有 `retry_topic-attempts`**（10.2.5 ⑤）；
`DeadLetterPublishingRecoverer` 那條路沒有。
📌 **而且就算有，那也是「重試幾次」不是「重放幾次」** ——
重放是你按下去的，次數要你自己數。

**③ ⚠️ 重放放大了重複。**

DLT 上累積了 7 份同一則訊息，修好之後全部重放回來 → **那一則被處理 7 次**。
如果它是「扣款」，你就扣了七次。

> 📌 **這是 [03 章](./03-idempotent-consumer.md) 在整站最後一次出現，而且是最強的一次論證**：
> **冪等消費不是為了防 broker 的重投，是為了防你自己的重放。**
> broker 的重複是偶爾一則，重放的重複是**一次七則**，而且是你自己按下去的。

**④ 重放一定會打亂順序。**

`msg-0 → msg-1 → msg-3 → msg-4 → msg-2` ——
同一個 key（`ORD-1`）的五則訊息，`msg-2` 排到最後。
這跟 10.2.5 ① 是同一件事，只是更嚴重（重放可能是幾小時之後）。

### 10.5.3 重放 SOP

[08 章 8.7.4](./08-kafka-consumer-group-and-offset.md) 給的是「位移重設」的 SOP
（把整個 group 倒回去）。**死信重放是另一件事** —— 只搬特定的幾則。
兩者的檢查清單有重疊，但不一樣：

```
  ── 重放之前（四個問題，任何一個答不出來就不要按）──
  ① bug 修好了嗎？部署上去了嗎？          ← 10.5.2 ① 的教訓
     驗證方法：拿 DLT 上的一則，在測試環境跑一次
  ② 消費者是冪等的嗎？                     ← 10.5.2 ③ 的教訓
     不是的話，先做去重（03 章），再重放
  ③ 順序重要嗎？                           ← 10.5.2 ④ 的教訓
     重要的話：重放之前先暫停生產者，或改走「人工補單」
  ④ 這些訊息現在還有意義嗎？
     ⚠️ 三天前的「庫存預扣」重放回去可能是災難

  ── 重放的時候 ──
  ⑤ 先在測試環境把整份 DLT 重放一次
  ⑥ 正式環境先重放「一則」，確認它進得去也做得完
  ⑦ 分批重放，不要一次全送（下游可能撐不住 —— 00 章 0.3.2 的削峰是反過來的）
  ⑧ 每一則都帶 X-Replay-Count 與原本的 traceId（10.3.7）

  ── 重放之後 ──
  ⑨ 確認 DLT 沒有再長（長了就是 bug 沒修好，立刻停手）
  ⑩ 確認業務數字對得上（10.4.4 的最後一列）
```

### 10.5.4 兩邊的重放對照

| | RabbitMQ | Kafka |
|---|---|---|
| 死信在哪 | DLQ（一個真的佇列） | DLT（一個真的 topic） |
| 怎麼看內容 | `rabbitmqadmin get` 或管理介面 ⚠️ **會把它拿走** | `kafka-console-consumer` **讀了還在** |
| 重放怎麼做 | [06 章 6.2.4](./06-rabbitmq-retry-delay-and-cluster.md) 那段小心翼翼的程式碼：`receive` → 改 → `send` → `ack` | 10.5.2 的 `poll` → `send` → `commitSync` |
| 重放到一半掛掉 | ⚠️ **拿走了還沒送出去的那幾則會消失** | ✅ **沒 commit 就重來，訊息還在 DLT 上** |
| 想「先看看不要真的重放」 | ❌ 做不到（看就是拿走） | ✅ **開一個影子 group 讀，什麼都不影響**（[08 章 8.7](./08-kafka-consumer-group-and-offset.md)） |
| 重放次數 | `x-death.count`（broker 給） | ⚠️ **自己塞 header** |
| 全部重做一次 | ❌ 沒有這個概念 | ✅ `--reset-offsets --to-earliest` |

⚠️ **第四、五列是這一站最後一次看到「broker 模型 vs log 模型」的差別**
（[00 章 0.4](./00-course-map-why-message-queue.md)）：

> **RabbitMQ 的重放是「把訊息搬來搬去」，搬的過程中它可能消失。**
> **Kafka 的重放是「把一個數字改回去」，原始資料從頭到尾沒有動過。**

---

## 10.6 Testcontainers：把手動起的容器變成可重現的測試

### 10.6.1 目前的問題

**前十章的每一個實驗都靠[本站 README](./README.md) 那張表上的容器**：
`rabbit-lab`、`kafka-lab`、`mysql-lab`、`kafka1`/`kafka2`/`kafka3`、`pg-lab`。
它們是**手動 `docker run` 起來的，而且要一直開著**。

這在學習時很好（你看得到、摸得到、可以 `docker exec` 進去），**但當成專案的測試就不行了**：

| 問題 | 具體長什麼樣 |
|---|---|
| 新人跑不起來 | `git clone` → `mvn test` → 全紅。要先讀 README 起六個容器 |
| CI 跑不起來 | CI 機器上沒有你那六個容器 |
| 測試之間會互相污染 | [04 章 4.6.1](./04-rabbitmq-basics-and-topology.md) 那個「改一個佇列參數 → 整批宣告一起死」就是這樣來的 |
| 埠會撞 | 所以本站刻意用 5673 / 19092 / 13306 而不是預設埠（[00 章 0.6.1](./00-course-map-why-message-queue.md)） |
| 版本會飄 | 你的機器是 3.13.7，同事的是 3.12 |

**Testcontainers 把「起容器」變成測試程式碼的一部分。**

### 10.6.2 實測：兩台 broker 自己起來

```xml
<!-- 四個依賴（加在 pom.xml） -->
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-testcontainers</artifactId>
  <scope>test</scope>
</dependency>
<dependency>
  <groupId>org.testcontainers</groupId>
  <artifactId>junit-jupiter</artifactId>
  <scope>test</scope>
</dependency>
<dependency>
  <groupId>org.testcontainers</groupId>
  <artifactId>kafka</artifactId>
  <scope>test</scope>
</dependency>
<dependency>
  <groupId>org.testcontainers</groupId>
  <artifactId>rabbitmq</artifactId>
  <scope>test</scope>
</dependency>
```

```java
package com.example.lab11.ch10;

/**
 * 10.6：把「手動起的 Docker」換成 Testcontainers。
 * ⚠️ 兩個容器都是 static + @ServiceConnection：
 *    static 讓整個測試 JVM 只起一次，@ServiceConnection 讓 Boot 自己接上去。
 */
@SpringBootTest
@Testcontainers
class Q1TestcontainersTest {

    @Container
    @ServiceConnection
    static final KafkaContainer KAFKA =
            new KafkaContainer(DockerImageName.parse("confluentinc/cp-kafka:7.6.1"));

    @Container
    @ServiceConnection
    static final RabbitMQContainer RABBIT =
            new RabbitMQContainer(DockerImageName.parse("rabbitmq:3.13-management"));

    @Autowired KafkaTemplate<String, String> kafka;
    @Autowired RabbitTemplate rabbit;
}
```

⚠️ **`application.yml` 一個字都不用改。**
`@ServiceConnection` 會在 Spring 起來之前把 `spring.kafka.bootstrap-servers`
與 `spring.rabbitmq.host/port` 覆寫成容器的隨機埠。

**輸出**：

```
═══ 10.6.2 Testcontainers：兩台 broker 自己起來 ═══

  Kafka  映像       : confluentinc/cp-kafka:7.6.1
  Kafka  bootstrap  : PLAINTEXT://localhost:57509  ← 埠是隨機的，不會跟你機器上的撞
  Rabbit 映像       : rabbitmq:3.13-management
  Rabbit amqp       : amqp://localhost:57504
  Spring 連到的 Kafka : [PLAINTEXT://localhost:57509]
  Spring 連到的 Rabbit: localhost:57504

  Kafka  收到       : hello-from-testcontainers（✅）
  Rabbit 收到       : hello-rabbit

  ⏱ 從測試類別被載入到這裡 : 19,475 ms（含兩台容器冷啟動）
  對照：手動起好的容器是 0 ms —— 這就是 Testcontainers 的價碼
```

📌 **`19,475 ms`（另一次 15,927 ms）就是它的價碼**，而且那還是**映像已經在本機**的情況。
第一次要先下載 `confluentinc/cp-kafka:7.6.1`（約 450 MB）。

### 10.6.3 ⚠️ 四個坑

**① 「Could not find a valid Docker environment」，而 `docker ps` 明明是好的。**

錯誤長這樣：

```
═══ 10.6.3 為什麼 Testcontainers 說「找不到 Docker」═══
  $ docker version --format "{{.Server.Version}} (API {{.Server.APIVersion}})"
  29.1.3 (API 1.52)

  $ curl -s --unix-socket /var/run/docker.sock http://localhost/v1.32/info
  {"ID":"","Containers":0,"ContainersRunning":0,"ContainersPaused":0,"ContainersStopped":0,"Images…

  $ curl -s --unix-socket /var/run/docker.sock http://localhost/v1.44/info
  {"ID":"e2b1315e-3d5d-436b-88fb-20bb0f6a14db","Containers":8,"ContainersRunning":3,"ContainersPau…
```

**socket 是通的，權限是對的** —— 壞的是 **API 版本**。
Docker 29 對 `v1.32` 回 `400` 加一份全是零的 JSON，對 `v1.44` 正常回應。
而 Testcontainers 用的 docker-java 預設談的就是舊版本。

```bash
# 解法：明確指定 API 版本
mvn -Dtest=Q1TestcontainersTest -DargLine="-Dapi.version=1.44" test
```

⚠️ **不用升級 Testcontainers**。本站用 Boot 3.2.5 管的 **1.19.7**
與較新的 1.20.6 各跑過一次 —— **兩個版本都要加上這個參數才連得上**，
加了之後**兩個版本都正常**。
📌 **升版不會解決這件事，不要往那個方向查。**

⚠️ **那份「全是零」的回應是這個坑最難查的地方** ——
它不是連線錯誤、不是權限錯誤，是一份**看起來像成功但什麼都沒有**的回應，
而 Testcontainers 只會告訴你「找不到 Docker」。

📌 **判斷方法就是上面那兩行 `curl`**：兩個版本各打一次，就知道是不是 API 版本的問題。

**② `static` 不是可選的。**

```java
@Container static final KafkaContainer KAFKA = ...;   // ✅ 整個 JVM 起一次
@Container        KafkaContainer kafka      = ...;    // ❌ 每個 @Test 起一次
```

⚠️ **非 static 的 `@Container` 是「每個測試方法一台」** ——
十幾秒 × 每一個測試方法。一個 20 個測試的類別就是好幾分鐘。

**③ 多個測試類別會各起一組。**

`static` 只保證「同一個類別」共用。三個測試類別各自宣告 `static KafkaContainer` = **三台 Kafka**。
解法是把容器抽到一個共用的基底類別（或用 Testcontainers 的 singleton 模式）：

```java
abstract class AbstractBrokerTest {
    static final KafkaContainer KAFKA = new KafkaContainer(...);
    static { KAFKA.start(); }          // ⚠️ 不要 @Container，讓它跟著 JVM 活
}
```

⚠️ **這樣就不要用 `@Testcontainers` 的自動生命週期管理了** ——
容器會活到 JVM 結束，由 Testcontainers 的 Ryuk 容器負責清掉。

**④ 它不是「本地開發環境」的替代品。**

Testcontainers 的容器**跑完就沒了**。
你沒辦法 `docker exec rabbit-lab rabbitmqctl list_queues` 進去看 ——
而本站十章有一半的觀測是靠那個。

### 10.6.4 所以什麼時候用、什麼時候不用

| | 手動 `docker run`（本站前十章） | Testcontainers |
|---|---|---|
| **學習 / 探索** | ✅ 看得到、進得去、可以慢慢玩 | ❌ 跑完就沒了 |
| **CI** | ❌ CI 機器上沒有 | ✅ 唯一的答案 |
| **新人第一天** | ❌ 要先讀 README 起六個容器 | ✅ `mvn test` |
| **測試之間的隔離** | ❌ 會互相污染 | ✅ 每一輪都是乾淨的 |
| **單一測試的速度** | 0 ms | **約 15～20 秒**（冷啟動） |
| **需要叢集**（[07 章 7.5](./07-kafka-basics-and-producer.md) 的三台 broker） | ✅ 起三台就好 | ⚠️ 做得到但很慢 |
| **需要「拔網路線」這種故障演練** | ✅ `docker stop` | ⚠️ 要用 `ToxiProxy`，複雜度高 |

> 📌 **本站的建議**：
> **兩個都要，而且分開放。**
>
> ```
>   src/test/java/.../unit/          ← 不碰 broker，毫秒級
>   src/test/java/.../it/            ← Testcontainers，CI 跑這個
>   src/test/java/.../chaos/         ← 手動容器 + docker stop，@Disabled，人工跑
> ```
>
> ⚠️ **本站前十章的實驗全部屬於第三類** ——
> 它們是**故障演練**，不是回歸測試。
> 「拔掉一台 broker 看 `acks=1` 會不會掉資料」這種事，
> 用 Testcontainers 寫得出來，但它會讓你的 CI 從 3 分鐘變成 40 分鐘。

---

## 10.7 落地：訂單流程的完整錯誤處理設定

把 10.2 ~ 10.5 合起來，這是本站建議的一組設定。

### 10.7.1 Kafka 這一側

```java
@Configuration
class KafkaReliabilityConfig {

    /** ① 送 byte[] 的 template：給反序列化失敗那條路徑用（10.2.6 ④） */
    @Bean
    KafkaTemplate<Object, Object> bytesKafkaTemplate(KafkaProperties props) {
        Map<String, Object> cfg = new HashMap<>(props.buildProducerProperties(null));
        cfg.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, ByteArraySerializer.class);
        return new KafkaTemplate<>(new DefaultKafkaProducerFactory<>(cfg));
    }

    /** ② 死信：兩種 value 型別各一顆 template */
    @Bean
    DeadLetterPublishingRecoverer recoverer(KafkaTemplate<String, String> text,
                                            KafkaTemplate<Object, Object> bytes) {
        var r = new DeadLetterPublishingRecoverer(Map.of(byte[].class, bytes, String.class, text));
        r.setHeadersFunction((rec, ex) -> {          // ③ 死信上多帶一個「第幾次」
            Headers h = new RecordHeaders(rec.headers().toArray());
            h.add("X-Replay-Count", "0".getBytes(UTF_8));
            return h;
        });
        return r;
    }

    /** ④ 退避：預設是 FixedBackOff(0, 9)（10.2.0），明確覆寫掉 */
    @Bean
    DefaultErrorHandler errorHandler(DeadLetterPublishingRecoverer recoverer) {
        var backOff = new ExponentialBackOffWithMaxRetries(3);
        backOff.setInitialInterval(1000);
        backOff.setMultiplier(2.0);
        backOff.setMaxInterval(8000);
        var handler = new DefaultErrorHandler(recoverer, backOff);
        handler.addNotRetryableExceptions(          // ⑤ 重試不會變好的，直接進死信
                IllegalArgumentException.class,
                OrderNotFoundException.class);
        return handler;
    }

    /** ⑥ traceId：進來的時候放進 MDC，做完一定要清（10.3.4） */
    @Bean
    RecordInterceptor<String, String> traceInterceptor() {
        return new RecordInterceptor<>() {
            @Override public ConsumerRecord<String, String> intercept(
                    ConsumerRecord<String, String> r, Consumer<String, String> c) {
                Header h = r.headers().lastHeader("X-Trace-Id");
                MDC.put("traceId", h == null ? "mq-" + UUID.randomUUID() : new String(h.value(), UTF_8));
                return r;
            }
            @Override public void afterRecord(ConsumerRecord<String, String> r, Consumer<String, String> c) {
                MDC.remove("traceId");
            }
        };
    }
}
```

```yaml
spring:
  kafka:
    consumer:
      enable-auto-commit: false          # 08 章 8.4.4
      auto-offset-reset: earliest        # 08 章 8.7.4
      max-poll-records: 50               # 最糟重複量的上限（08 章 8.3.2）
      # ⚠️ 一定要包這一層，理由見 10.2.6
      value-deserializer: org.springframework.kafka.support.serializer.ErrorHandlingDeserializer
      properties:
        spring.deserializer.value.delegate.class: org.springframework.kafka.support.serializer.JsonDeserializer
        spring.json.trusted.packages: com.example.events
        max.poll.interval.ms: 300000     # 08 章 8.5.3
        session.timeout.ms: 45000
        partition.assignment.strategy: >-
          org.apache.kafka.clients.consumer.CooperativeStickyAssignor
    listener:
      ack-mode: BATCH
      missing-topics-fatal: true         # 07 章 7.8
```

⚠️ **另外三件事寫不進設定檔，要自己做**：

```
  ① DLT 要自己宣告（分區數、RF、retention 跟主 topic 對齊）—— 10.2.2
  ② outbox 表要多一欄 trace_id                              —— 10.3.5
  ③ 外部 lag exporter 要部署起來                            —— 10.4.2
```

### 10.7.2 RabbitMQ 這一側

```java
@Configuration
class RabbitReliabilityConfig {

    /** ① 生產端：每一則都帶 traceId（10.3.2） */
    @Bean
    RabbitTemplate rabbitTemplate(ConnectionFactory cf, MessageConverter converter) {
        RabbitTemplate t = new RabbitTemplate(cf);
        t.setMessageConverter(converter);
        t.setBeforePublishPostProcessors(m -> {
            String id = MDC.get("traceId");
            if (id != null) m.getMessageProperties().setHeader("X-Trace-Id", id);
            return m;
        });
        return t;
    }

    /** ② 消費端：traceId 進 MDC，finally 一定要清（10.3.4） */
    @Bean
    SimpleRabbitListenerContainerFactory rabbitListenerContainerFactory(
            SimpleRabbitListenerContainerFactoryConfigurer configurer, ConnectionFactory cf) {
        var factory = new SimpleRabbitListenerContainerFactory();
        configurer.configure(factory, cf);
        factory.setAdviceChain((MethodInterceptor) inv -> {
            Message m = null;
            for (Object a : inv.getArguments()) if (a instanceof Message mm) m = mm;
            Object id = m == null ? null : m.getMessageProperties().getHeader("X-Trace-Id");
            MDC.put("traceId", id == null ? "mq-" + UUID.randomUUID() : String.valueOf(id));
            try { return inv.proceed(); } finally { MDC.remove("traceId"); }
        });
        return factory;
    }
}
```

```yaml
spring:
  rabbitmq:
    publisher-confirm-type: correlated    # 01 章 1.3.3
    publisher-returns: true
    listener:
      simple:
        acknowledge-mode: auto            # 05 章 5.3.1
        default-requeue-rejected: false   # ⚠️ 06 章 6.2.1 —— 沒有這一行就是那場風暴
        prefetch: 20                      # 05 章 5.4.6
        concurrency: 1                    # ⚠️ > 1 會破壞順序（05 章 5.5.2）
```

拓撲的部分沿用 [06 章 6.9](./06-rabbitmq-retry-delay-and-cluster.md) 的完整版（DLX + 退避階梯 + quorum）。

### 10.7.3 告警規則

```yaml
# ── 兩邊共通 ──
- alert: 死信堆積
  expr: dlq_messages > 0 or dlt_end_offset_increase > 0
  for: 1m
  severity: warning                       # 06 章 6.2.1 / 本章 10.2.2

- alert: 業務數字對不上
  expr: orders_created_total - notifications_sent_total > 10
  for: 15m
  severity: critical                      # 10.4.4：唯一不會騙你的數字

# ── Kafka ──
- alert: 消費者落後的時間跨度接近 retention
  expr: kafka_consumergroup_lag_seconds / kafka_topic_retention_seconds > 0.2
  for: 5m
  severity: warning                       # 10.4.5，防的是 09 章 9.5.3 的無聲遺失

- alert: rebalance 一直發生
  expr: increase(kafka_consumer_coordinator_rebalance_total[10m]) > 3
  for: 0m
  severity: critical                      # 10.4.3 —— lag 看不到這件事

- alert: consumer group 不見了
  expr: absent(kafka_consumergroup_current_offset{group="order-notify"})
  for: 5m
  severity: critical                      # 08 章 8.8.4：offsets.retention.minutes

# ── RabbitMQ ──
- alert: 消費者卡死
  expr: rabbitmq_queue_messages_unacked > 0 and rate(rabbitmq_queue_messages_delivered_total[5m]) == 0
  for: 3m
  severity: critical                      # 10.4.6 ③ —— 深度看起來還在下降

- alert: 沒有消費者
  expr: rabbitmq_queue_consumers == 0
  for: 2m
  severity: critical                      # 10.4.6 ②
```

⚠️ **這裡的 metric 名稱依你用的 exporter 而定**（`kafka-exporter` / `rabbitmq_exporter` /
RabbitMQ 3.8+ 內建的 Prometheus 外掛都不一樣）。**重點是那六個「要抓什麼」，不是名字。**

---

## 10.8 常見誤區

**① 「Spring 會幫我處理失敗的訊息」**

⚠️ **會，但它的預設處理方式是「丟掉」。**
10.2.1 實測：投遞 10 次、退避 0、然後 **committed 位移越過去、訊息永遠消失**。
⚠️ **它會印一行 `... exhausted for ch10.poison.v1-0@3` 的 ERROR**，
但 `lag`、消費者 metric、死信 topic **三個都不動** ——
**如果你的告警建在 metric 上，這件事就是無聲的**（10.2.1 ④）。

**② 「我設了重試次數，所以壞訊息不會卡住別人」**

⚠️ **`DefaultErrorHandler` 的重試是「把整個分區停在那裡重做」。**
10.2.1 ② 實測：`FixedBackOff(2000, 4)` 讓後面六則訊息陪等 **8,839 ms**。
不想卡住別人要用重試主題（10.2.4：**10 ms**），而它的代價是順序（10.2.5 ①）。

**③ 「`@RetryableTopic` 就是比較好的那個」**

⚠️ **不是。它會打破 key 的順序。**
10.2.4 的時間軸裡，同一個 `ORD-1` 的 `msg-3` 在其他五則都處理完之後 **7.5 秒**才輪到。
[07 章 7.3](./07-kafka-basics-and-producer.md) 花一整節買來的順序保證，在這裡被退掉了。
**狀態機型的消費者不要用。**

**④ 「反序列化失敗會進死信」**

⚠️ **不會 —— 它連 listener 都沒進到。**
10.2.6 實測：不包 `ErrorHandlingDeserializer` 的消費者，
**每秒失敗 15,114 次，後面的訊息永遠等不到**。
而且包了之後還有第二關：死信本身可能因為 `byte[]` 送不出去（又一個迴圈，每秒 9.7 次）。

**⑤ 「DLT 讓 Kafka 也有了 RabbitMQ 的 DLX」**

⚠️ **形狀差很多。**
RabbitMQ 的 DLX 是 **broker 的行為**（換一套客戶端、換一種語言都還在），
Kafka 的 DLT 是**你的程式碼的行為**（忘了設就靜靜地丟掉，而 broker 完全不知情）。
⚠️ **而且 Kafka 這一側有「兩套」死信 header**（10.2.5 ⑤ 實測）：
`DeadLetterPublishingRecoverer` 走 `kafka_dlt-*` 且**沒有重試次數**，
`@RetryableTopic` 走 `kafka_*` 且**有 `retry_topic-attempts`**。
**寫重放工具的時候兩套都要處理，少一個 `dlt-` 前綴就讀到 `null` 而且不會報錯。**

**⑥ 「traceId 塞進 header 就搞定了」**

⚠️ **三個地方會斷**：
消費者忘了清 MDC（10.3.4：**下一則帶著上一則的 traceId，比沒有更糟**）、
Outbox 的輪詢器在別的執行緒上（10.3.5）、
自己開的執行緒池。

**⑦ 「`records-lag-max` 就是 lag」**

⚠️ **10.4.2 實測：積壓漲到 2,066 的時候，它一路顯示 `0`。**
它量的是 **fetcher 的位置**，不是你處理到哪。
**告警要用外部 exporter 算的 `end offset − committed offset`。**

**⑧ 「lag 是 0 就是健康」**

⚠️ **10.4.4 列了五種假象**，其中三種的 lag 都是 0：
自動提交提交了沒處理的（[01 章 1.5.2](./01-reliable-delivery-three-hops.md)）、
毒藥訊息被跳過（10.2.1）、
落後超過 retention 之後 `latest` 重設（[09 章 9.5.3](./09-kafka-exactly-once-and-retention.md)）。

**⑨ 「佇列深度在下降，所以消費者在工作」**

⚠️ **10.4.6 ③ 實測：`ready` 從 200 掉到 150、`consumers = 1`，
而那 50 則一個都沒被處理，卡在 `prefetch` 裡。**
只有 `messages_unacknowledged` 說得出這件事。

**⑩ 「死信修好之後重放回去就好」**

⚠️ **三件事會咬你**：
bug 沒修好就重放 = 無窮迴圈（10.5.2 ①）、
DLT 上累積的份數會**一次全部重放回來**（10.5.2 ③：一則被處理 **7 次**）、
順序被打亂（10.5.2 ④）。
📌 **重放之前一定要先回答 10.5.3 那四個問題。**

**⑪ 「加了 Testcontainers 就可以把手動容器都關掉」**

⚠️ **兩者的用途不一樣。** Testcontainers 的容器跑完就沒了 ——
你沒辦法 `docker exec` 進去看、沒辦法 `docker stop` 做故障演練。
**本站前十章的實驗全部屬於「故障演練」，不屬於回歸測試**（10.6.4）。

---

## 10.9 本章小結

**這一章的核心是一句話**：

> **前十章讓訊息不漏不重，這一章讓「它還是出事了」變成一件看得見、找得到、修得好的事。**

三個主題各自的一句話：

| 主題 | 一句話 |
|---|---|
| **毒藥訊息**（10.2） | **Kafka 的死信是你的程式碼，不是 broker 的功能** —— 沒寫就是靜靜地丟掉 |
| **traceId**（10.3） | **traceId 要跟著資料走，不能跟著執行緒走** |
| **監控**（10.4） | **每一個現成的數字都有它的假象，只有業務計數器不會騙你** |

### 10.9.1 驗收清單

- [ ] 說得出 Spring 預設會把一則毒藥訊息投遞幾次、退避多久、最後放到哪裡（10.2.0、10.2.1）。
- [ ] 說得出為什麼「退避是 0」還是花了 5,076 ms（10.2.1 ②）。
- [ ] 設得出 `DefaultErrorHandler` + `DeadLetterPublishingRecoverer`，並讀得懂死信上每一個 header（10.2.2）。
- [ ] 說得出 Kafka 的 DLT header 比 `x-death` 多了什麼、少了什麼（10.2.2）。
- [ ] 說得出 `@RetryableTopic` 買到什麼（主 topic 只卡 10 ms）、付出什麼（順序、5 個 group）（10.2.4、10.2.5）。
- [ ] 說得出重試路徑的吞吐是多少、為什麼是那個數字，以及 1,000 則同時失敗要排多久（10.2.5 ④）。
- [ ] 說得出 `@RetryableTopic` 的死信 header 跟 `DeadLetterPublishingRecoverer` 差在哪三處（10.2.5 ⑤）。
- [ ] 說得出 `new ExponentialBackOff(1000, 2.0)` 當退避策略會發生什麼事（10.2.7）。
- [ ] 解釋得出為什麼反序列化失敗碰不到重試階梯，以及 `ErrorHandlingDeserializer` 要包在哪一層（10.2.6）。
- [ ] 說得出 `DeadLetterPublishingRecoverer` 為什麼需要**兩顆** `KafkaTemplate`（10.2.6 ④）。
- [ ] 說得出「這個例外該不該重試」的判斷準則，以及兩種判斷錯誤的成本（10.2.7）。
- [ ] 在兩邊都做得出 traceId 傳遞，並說得出**三個**會弄丟它的地方（10.3）。
- [ ] 說得出「忘了清 MDC」為什麼比「沒有 traceId」更糟（10.3.4）。
- [ ] 說得出為什麼 outbox 表要多一欄 `trace_id`，以及 `ProducerInterceptor` 為什麼補不了這一段（10.3.3、10.3.5）。
- [ ] 說得出為什麼「打開 RabbitMQ 的 observation」不能靠 `application.yml`（10.3.7）。
- [ ] 說得出 `records-lag-max` 量的是什麼，以及它為什麼會在積壓成長時顯示 0（10.4.2）。
- [ ] 說得出為什麼 `rebalance-total` 是 lag 完全看不到的一個維度（10.4.3）。
- [ ] 列得出 lag 的**五種假象**，並各舉一個本站量過的例子（10.4.4）。
- [ ] 算得出「lag 佔 retention 的百分之幾」，並說得出為什麼要用這個告警（10.4.5）。
- [ ] 列得出 RabbitMQ 的四個數字，並說得出哪一個才看得出「消費者卡死」、哪一個分不出來（10.4.6）。
- [ ] 寫得出死信重放的 SOP，並說得出不做防護時它會變成什麼（10.5）。
- [ ] 說得出為什麼「重放」是冪等消費最強的論證（10.5.2 ③）。
- [ ] 用 Testcontainers 起得出兩台 broker，並說得出它跟手動容器各自適合什麼（10.6）。

### 10.9.2 本章練習

**① 把 10.2.1 重跑一次，但把 `max.poll.records` 改成 1。**
毒藥訊息還是投遞 10 次嗎？後面那幾則被卡住多久？
（提示：想一想 `seekAfterError` 是 seek 回哪裡。）

**② 讓死信自己失敗。**
把 DLT 的 `min.insync.replicas` 設成 2（單節點 broker 上一定寫不進去），
然後送一則毒藥訊息。量三件事：消費者的 committed offset、迴圈的速率、
以及**你的監控上哪一個數字會動**。

**③ 把 10.3 的 traceId 接到 `@Async` 上。**
[05-service/06](../05-service/06-async-and-external-api-calls.md) 的 `@Async` 方法會拿到 traceId 嗎？
沒有的話，用 `TaskDecorator` 補起來，並且驗證「執行緒被重用時不會串到別人」。

**④ 寫一支最小的 lag exporter。**
用 `AdminClient` 每 30 秒輸出一次：每個 group 的 `lag（則數）`、`lag（秒）`、
以及 `lag(秒) / retention`。跑起來之後把消費者關掉，確認三個數字都還在動。

**⑤ 做一次完整的死信演練。**
送 1,000 則，其中 50 則是毒藥。跑完之後回答：
DLT 上有幾則、原 topic 的 committed offset 是多少、
修好 bug 之後重放，有幾則被處理了兩次、順序亂了幾則。

**⑥ 把 10.6 的 Testcontainers 測試變成「三個測試類別共用一組容器」。**
量一下：分開起跟共用起，整組測試各花多久。

**⑦ 把重試路徑的吞吐調上去。**
重跑 10.2.5 ④，但把重試 topic 的分區數與 `concurrency` 都改成 6。
20 則全部走完要多久？**是不是剛好快 6 倍？不是的話，瓶頸在哪裡？**

---

## 10.10 下一章預告

**到這裡，兩套系統你都會用了，也都會修了。**

**最後一章要回答的是第一章就該問、但那時候還答不了的問題**：

> **「這個新需求，我該用哪一個？」**

[00 章 0.4.4](./00-course-map-why-message-queue.md) 給過一張很小的表，並且說：

> 📌 **這張表在 11 章會擴充成完整的決策表**（加上維運成本、團隊熟悉度、既有系統）。

**而這十章下來，你手上已經有一整套實測數字可以拿來做決定**，例如：

| 面向 | RabbitMQ | Kafka |
|---|---|---|
| 併發下的順序 | ⚠️ **49% 訂單最終狀態錯**（[05 章 5.5.2](./05-rabbitmq-reliability.md)） | **0 / 200 錯**（[07 章 7.3.2](./07-kafka-basics-and-producer.md)） |
| 擴容 | 加消費者 **14 倍**（[05 章 5.4](./05-rabbitmq-reliability.md)） | ⚠️ **卡在分區數**（[07 章 7.3.2](./07-kafka-basics-and-producer.md)） |
| 毒藥訊息 | DLX，**一行**（[06 章 6.2](./06-rabbitmq-retry-delay-and-cluster.md)） | ⚠️ **本章那一整節** |
| 延遲訊息 | TTL + DLX（[06 章 6.4](./06-rabbitmq-retry-delay-and-cluster.md)） | ❌ 要自己做時間輪 |
| 重放 | 小心翼翼地搬（[06 章 6.2.4](./06-rabbitmq-retry-delay-and-cluster.md)） | **改一個數字**（[08 章 8.7](./08-kafka-consumer-group-and-offset.md)） |

⚠️ **但 11 章不會只是把這張表變長。** 它要處理三件更難的事：

**一、同一個專案裡兩個都用，架構要怎麼切。**

**二、已經在 RabbitMQ 上了，遷到 Kafka 要付多少錢。**
[05 章 5.5.6](./05-rabbitmq-reliability.md) 說過一句很重的話：
**「在 RabbitMQ 上認真做分片佇列 = 你要的東西是 Kafka」**。11 章要把它變成一個可以算的成本。

**三、⚠️ 什麼時候兩個都不要用。**
[00 章 0.5.6](./00-course-map-why-message-queue.md) 說「如果一張表加一個輪詢能解決，就用那個」——
**11 章要把那句話的邊界量出來：那個「一張表 + 一個輪詢」到底能撐到多少。**

📌 **一句話預告 11 章**：

> **前十一章教你怎麼用。最後一章教你怎麼決定用不用、用哪一個。**
