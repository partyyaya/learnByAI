# 第 05 章：RabbitMQ 可靠性設定

> [01 章](./01-reliable-delivery-three-hops.md) 證明了訊息會在三個地方掉，也給了每一段的防守手段。
> [04 章](./04-rabbitmq-basics-and-topology.md) 把拓撲弄對了。
> **這一章把那些設定真的寫下去，然後量它們的代價。**
>
> 而這一章的主角只有一個參數：**`prefetch`**。
> [00 章 0.9.3](./00-course-map-why-message-queue.md) 說過 RabbitMQ 有兩個
> 「不懂就一定會寫錯」的東西，prefetch 是其中之一。
> 它看起來只是個「一次抓幾則」的效能旋鈕，實際上**它同時決定三件互相衝突的事**：
>
> **一、吞吐。** 5.4.1 實測，同樣 5,000 則訊息、同一個消費者：
> **`prefetch=1` 要 963 ms，`prefetch=250` 只要 69 ms —— 14 倍。**
>
> **二、公平性。** 5.4.3 實測，一快一慢兩個消費者、400 則訊息：
> **`prefetch=1` 時快的那個處理了 88%，全部跑完 2,646 ms；
> `prefetch=250` 時變成 50/50 平分，全部跑完 8,660 ms —— 慢了 3.3 倍。**
> ⚠️ 這跟第一點的結論**正好相反**。
>
> **三、一次故障會牽連多少則訊息。** 5.4.4 實測，消費者跑到一半斷線：
> **`prefetch=1` → 0 則要重做；`prefetch=250` → 249 則要重做。**
> 而 Spring Boot 的預設值就是 **250**。
>
> 還有一個大多數人不知道的設定：**`prefetch=0`（無上限）**。
> 5.4.5 實測，它是**兩邊最差的組合** ——
> broker 把整個佇列 9,614 則全部推給那一個消費者（`ready=0`），
> 而 Spring 這一側的吞吐**跟 `prefetch=1` 一樣慢**。5.4.2 會解釋為什麼。
>
> ---
>
> 這一章還要兌現 [00 章 0.5.1](./00-course-map-why-message-queue.md) 留下的那句話：
>
> > ⚠️ **RabbitMQ 也有順序問題，而且更隱蔽。**
>
> 5.5 實測：同一個佇列、同一份程式碼，只把 `concurrency` 從 1 改成 4 ——
> **200 張訂單裡有 138 張的事件處理順序是錯的，98 張的最終狀態是錯的（49%）。**
> 一張訂單的六個狀態事件變成
> `2-PAID → 4-SHIPPED → 3-STOCK_RESERVED → 1-CREATED → 6-CLOSED → 5-DELIVERED`。
> ⚠️ **而 RabbitMQ 的佇列沒有 Kafka 的 key 那一層可以救。**
> 5.5.3 給三條路，5.5.4～5.5.6 把三條都量過 —— **三條都有代價**。
>
> 最後 5.7 會回答一個你大概沒想過的問題：
> **消費者行程被砍掉，那些 `unacked` 的訊息要等多久才回到佇列？**
> 答案取決於**它是怎麼死的**：`kill -9` 是 **1 秒**，`kill -STOP`（凍住）是 **180 秒**，
> 差了 **180 倍** —— 而後者在監控上完全看不見。

---

## 5.1 學習目標

完成本章後，你應該可以：

- 寫出完整的 publisher confirm / return 設定，並說出 **callback 在哪一條執行緒上跑**、
  以及那件事帶來的三個限制（5.2.1）。
- 用 `CorrelationData.getFuture()` 把非同步的 confirm 變成可等待的（5.2.2）。
- 說出**什麼情況下 broker 才會真的回 nack**，並做一個會產生 nack 的佇列（5.2.3）。
- 說出 `x-overflow` 兩個值的差別，以及預設值為什麼會造成**無聲遺失**（5.2.3）。
- 分辨 `acknowledge-mode` 的 `none` / `auto` / `manual` 三個值在**消費者丟例外時**的行為（5.3.1）。
- 說出「manual 模式忘了 ack」的症狀，以及為什麼它**在日誌上完全看不出來**（5.3.2）。
- 正確使用 `basicAck` 的 `multiple` 參數，並說出**同一個 tag ack 兩次**會發生什麼（5.3.3）。
- 修掉 [00 章 0.4.1](./00-course-map-why-message-queue.md) 那個 `receiveAndConvert` 的遺失（5.3.4）。
- 說出 connection 與 channel 的關係、`concurrency: N` 會開幾條 channel，
  以及「channel 不是執行緒安全的」在什麼時候會咬到你（5.3.5）。
- 說出 `prefetch` **同時**決定的三件事，並在拿到一個新流程時挑出合適的值（5.4）。
- **從 5.4.1 的數字反推出你自己環境的「一次往返」時間**，並用它算 prefetch 的下限（5.4.6）。
- 說出 `consumer_utilisation` 真正的語意，以及為什麼它**不能**拿來調 prefetch（5.4.7）。
- 說出 `prefetch=0` 為什麼是最糟的選擇（5.4.2、5.4.5）。
- 說出 `concurrency > 1` 對順序的破壞有多嚴重（5.5.2 的兩個百分比），
  以及 RabbitMQ 僅有的兩種解法與各自的代價（5.5.3）。
- 說出 classic / lazy / v2 三種佇列在這個版本上實際的差別（5.6）。
- 說出消費者行程「消失」與「凍住」兩種死法的偵測時間差，
  並算出你自己環境的最壞值（5.7）。

---

## 5.2 publisher confirm 與 return：落地

[01 章 1.3.3](./01-reliable-delivery-three-hops.md) 已經證明了「兩個都要開」，
也給了 `replyCode=312 NO_ROUTE`。這一節處理**「然後呢」**。

```yaml
spring:
  rabbitmq:
    publisher-confirm-type: correlated    # 開 confirm，並帶 CorrelationData
    publisher-returns: true               # 開 return
    template:
      mandatory: true                     # ⚠️ 少了這個，publisher-returns 不會生效
```

### 5.2.1 ⚠️ confirm 是在另一條執行緒上回來的

```java
package com.example.lab11.ch05;

@SpringBootTest(properties = {
        "spring.rabbitmq.publisher-confirm-type=correlated",
        "spring.rabbitmq.publisher-returns=true",
        "spring.rabbitmq.template.mandatory=true"
})
class G1ConfirmLandingTest {

    @Test
    void confirmCallbackThreadAndFuture() throws Exception {
        System.out.println("呼叫端的執行緒 : " + Thread.currentThread().getName());
        rabbit.setConfirmCallback((corr, ack, cause) -> {
            System.out.println("callback 的執行緒 : " + Thread.currentThread().getName());
        });
        rabbit.convertAndSend("", Q, "x", new CorrelationData("c1"));
    }
}
```

**輸出**：

```
═══ 5.2.1 confirm 是在哪一條執行緒上回來的 ═══
  呼叫 convertAndSend 的執行緒 : main
  confirm callback 的執行緒     : rabbitConnectionFactory7
  兩者相同嗎                    : false
```

📌 **這一行決定了 callback 裡面能做什麼、不能做什麼**：

| 做不到的事 | 為什麼 |
|---|---|
| ❌ `@Transactional` | 這條執行緒上沒有交易上下文，標註等於沒寫 |
| ❌ 讀 `ThreadLocal`（含 MDC 裡的 `traceId`） | 那是呼叫端執行緒的東西，**這裡是空的**（10 章處理） |
| ❌ 讀 `RequestContextHolder` / `SecurityContextHolder` | 同上 |
| ⚠️ 做很慢的事（呼叫 API、寫一筆同步的 DB） | callback 跑在**連線的 I/O 執行緒**上（看那個執行緒名字），卡住它就會拖慢同一條連線上其他訊息的 confirm |

⚠️ **還有一個會讓你第一次就撞牆的限制：一顆 `RabbitTemplate` 只能掛一個 `ConfirmCallback`。**

```java
rabbit.setConfirmCallback(cb1);
rabbit.setConfirmCallback(cb2);   // ❌ IllegalStateException:
                                   //    Only one ConfirmCallback is supported by each RabbitTemplate
```

📌 **所以「每個功能各自註冊一個 callback」這種寫法行不通** ——
你只能有一個 callback，在裡面用 `CorrelationData` 的 id 分流；
或是**每個用途建一顆自己的 `RabbitTemplate`**（本章的測試就是這樣寫的，
否則兩支測試會互相踩到）。

📌 **callback 裡唯一該做的事是「記一筆」**：

```java
@Component
public class ReliablePublisher {

    private final RabbitTemplate rabbit;
    private final OutboxRepository outbox;          // 02 章那張表

    @PostConstruct
    void wire() {
        rabbit.setConfirmCallback((corr, ack, cause) -> {
            if (corr == null) return;                      // ⚠️ 沒帶 CorrelationData 的訊息，這裡是 null
            if (ack) {
                outbox.markSent(corr.getId());             // 一個 UPDATE，很快
            } else {
                outbox.markFailed(corr.getId(), cause);    // 留下可以重來的憑據
            }
        });
        rabbit.setReturnsCallback(ret -> {
            // NO_ROUTE 幾乎一定是設定/程式錯誤，不是暫時性故障 → 要吵醒人
            log.error("NO_ROUTE exchange={} rk={} replyText={}",
                    ret.getExchange(), ret.getRoutingKey(), ret.getReplyText());
            alerting.page("訊息路由不到，這是設定錯誤");
        });
    }
}
```

⚠️ **`corr == null` 那一行不要省。**
任何沒有帶 `CorrelationData` 的 `convertAndSend`（例如別人寫的程式、或框架內部送的訊息）
都會讓 callback 收到 `null`，然後 `corr.getId()` 丟 NPE ——
**而那個 NPE 在 confirm 的執行緒上，你的 `@ControllerAdvice` 看不到它。**

### 5.2.2 `CorrelationData.getFuture()`：把非同步變成可等的

Spring AMQP 提供了第二種寫法，比 callback 好用很多：

```java
CorrelationData ok = new CorrelationData("good-1");
rabbit.convertAndSend("", Q, "good", ok);
Confirm c = ok.getFuture().get(5, TimeUnit.SECONDS);       // 等這一則的 confirm
```

**輸出**：

```
═══ 5.2.2 CorrelationData 的 future：把 confirm 變成同步可等的 ═══
  ① routing key 正確
     confirm.ack   : true
     有 return 嗎  : 沒有
  ② routing key 打錯（少一個 m）
     confirm.ack   : true   ← ⚠️ 還是 true
     有 return 嗎  : 有
     return 內容   : replyCode=312 replyText=NO_ROUTE routingKey=ch05.confir.q
```

📌 **`CorrelationData` 同時帶著 confirm 與 return，所以一則訊息的完整結果在同一個物件上**：

```java
CorrelationData corr = new CorrelationData(outboxId);
rabbit.convertAndSend(X, rk, event, corr);

Confirm confirm = corr.getFuture().get(5, TimeUnit.SECONDS);
if (!confirm.isAck()) {
    throw new BrokerRejectedException(confirm.getReason());   // 暫時性 → 重試
}
if (corr.getReturned() != null) {
    throw new UnroutableException(corr.getReturned().getReplyText());  // 設定錯誤 → 告警
}
outbox.markSent(outboxId);
```

⚠️ **看 ② 那一行的 `ack : true`。**
[01 章 1.3.3](./01-reliable-delivery-three-hops.md) 已經講過一次，但它值得再講一次，
因為它是這個 API 最容易被誤用的地方：

> **`confirm.isAck() == true` 只表示「broker 收到了」，
> 不表示「它進到任何一個佇列」。**
> 你**必須**同時檢查 `getReturned()`，否則路由錯誤會被你當成成功。

⚠️ **而且順序很重要**：AMQP 保證 `basic.return` 會在 `basic.ack` **之前**送達，
所以「先 `get()` future、再看 `getReturned()`」是安全的。反過來寫就有競態。

### 5.2.3 什麼時候真的會收到 nack ★★

大多數人開了 confirm 之後**從來沒看過一個 nack**，於是那段 `else` 分支從來沒被測試過。
這一節做一個一定會產生 nack 的佇列：

```java
    @Test
    void whenDoesBrokerActuallyNack() throws Exception {
        // 一個「滿了就拒收」的佇列
        admin.declareQueue(QueueBuilder.durable("ch05.reject.q")
                .maxLength(5L)
                .overflow(QueueBuilder.Overflow.rejectPublish)     // ← 關鍵
                .build());
        for (int i = 0; i < 20; i++)
            rabbit.convertAndSend("", "ch05.reject.q", "m-" + i, new CorrelationData("r" + i));

        // 對照組：同樣上限 5，但用預設的 overflow
        admin.declareQueue(QueueBuilder.durable("ch05.drophead.q").maxLength(5L).build());
        // ... 同樣送 20 則
    }
```

**輸出**：

```
═══ 5.2.3 什麼時候真的會收到 nack ═══
  做一個「滿了就拒收」的佇列：x-max-length=5、x-overflow=reject-publish

  送出 20 則到一個上限 5 則的佇列
     ack   = 5
     nack  = 15   ← ⚠️ 這 15 則 broker 明確拒收了
     nack 的 cause : null
     佇列積壓 = 5

  對照組：同樣上限 5 則，但用預設的 x-overflow（drop-head）
     ack   = 20   ← ⚠️ 全部回報成功
     nack  = 0
     佇列積壓 = 5   → 另外 15 則被無聲丟掉了
```

⚠️ **這兩組數字的對比是本節的重點。**

| `x-overflow` | 佇列滿了的時候 | 生產者收到 | 你會知道嗎 |
|---|---|---|---|
| `drop-head`（**預設**） | 把**最舊的**訊息丟掉，騰位置給新的 | `ack` | ❌ **完全不會** |
| `reject-publish` | 拒收新訊息 | `nack` | ✅ 會 |
| `reject-publish-dlx` | 拒收，而且把被拒的送到 DLX | `nack` | ✅ 會（06 章） |

📌 **`x-max-length` 的預設行為是「丟掉最舊的」，而且不告訴任何人。**

這件事的嚴重性在於：`x-max-length` 是一個**大家都會加的保護**
（04 章 4.8.1 那個綁 `#` 的分析佇列就非加不可），
而**加上去的同時，你就默默買了一個無聲遺失的機制**。

> ⚠️ **這是本站第四次看到「無聲遺失」這個形狀**：
> [01 章 1.3.1](./01-reliable-delivery-three-hops.md) routing key 打錯、
> [01 章 1.5.2](./01-reliable-delivery-three-hops.md) Kafka 自動提交、
> [04 章 4.7.1](./04-rabbitmq-basics-and-topology.md) 前綴打錯、
> 以及這裡的 `drop-head`。
> **四次的共同點：broker 或框架做了一個「合理的」決定，而它沒有回報機制。**

📌 **所以只要你設了 `x-max-length`，就把 `x-overflow` 一起設成 `reject-publish`**
—— 除非你真的確定「舊的資料可以丟」（例如即時儀表板的最新報價）。

```java
@Bean Queue analyticsQueue() {
    return QueueBuilder.durable("order.analytics.q")
            .maxLength(1_000_000L)
            .overflow(QueueBuilder.Overflow.rejectPublish)     // ⚠️ 不要用預設
            .build();
}
```

⚠️ **另外注意那個 `nack 的 cause : null`。**
`reject-publish` 造成的 nack **沒有原因字串**。
所以你的告警不能只印 `cause`，要把 exchange、routing key、CorrelationData 的 id 一起印出來，
否則你會收到一堆「nack: null」，完全不知道是哪一則。

---

## 5.3 手動 ack

[01 章 1.5.1](./01-reliable-delivery-three-hops.md) 給了 `ready` / `unacked` / 消失 三種狀態，
也給了 `acknowledge-mode` 三個值的意思。這一節把它們**在同一個情境下跑一次**。

### 5.3.1 三種 `acknowledge-mode` × 消費者丟例外

```java
package com.example.lab11.ch05;

@SpringBootTest
class G2ManualAckTest {

    @Test
    void threeAckModesWhenTheConsumerThrows() {
        for (AcknowledgeMode mode : new AcknowledgeMode[]{NONE, AUTO, MANUAL}) {
            fill(10);                                   // 10 則訊息
            SimpleMessageListenerContainer c = new SimpleMessageListenerContainer(cf);
            c.setQueueNames(Q);
            c.setPrefetchCount(1);
            c.setAcknowledgeMode(mode);
            c.setDefaultRequeueRejected(true);          // Spring 的預設
            c.setMessageListener(m -> {
                deliveries.incrementAndGet();
                throw new RuntimeException("下游 500");   // 每一則都失敗
            });
            c.start(); sleep(2000); c.stop();
            // ... 印出投遞次數與 ready / unacked
        }
    }
}
```

**輸出**：

```
═══ 5.3.1 三種 acknowledge-mode × 消費者丟例外 ═══
  10 則訊息，消費者每一則都丟例外，讓它跑 2 秒

  ── acknowledge-mode = NONE ──
     兩秒內被投遞了      : 10 次
     消費中  ready=0     unacked=0
     停掉後  ready=0     unacked=0
     👉 10 則全部消失了（沒有人處理成功，也沒有留下任何一則）

  ── acknowledge-mode = AUTO ──
     兩秒內被投遞了      : 8,806 次
     消費中  ready=9     unacked=1
     停掉後  ready=10    unacked=0
     👉 10 則都還在佇列裡

  ── acknowledge-mode = MANUAL ──
     兩秒內被投遞了      : 1 次
     消費中  ready=9     unacked=1
     停掉後  ready=10    unacked=0
     👉 10 則都還在佇列裡
```

**三行數字，三個完全不同的故障模式**：

| 模式 | 投遞次數 | 訊息下場 | 這是什麼故障 |
|---|---|---|---|
| `NONE` | **10** | ❌ **全部消失** | **無聲遺失**。broker 送出去就當完成，你的例外它不知道 |
| `AUTO` | **8,806** | ✅ 都還在 | **風暴**。這就是 [00 章 0.5.2](./00-course-map-why-message-queue.md) 那個 11,191 次 |
| `MANUAL` | **1** | ✅ 都還在 | **卡住**。丟了例外又沒 ack/nack → 那一則永遠停在 `unacked` |

📌 **三個都是錯的，只是錯法不同。**

- `NONE` 換來的是「跑得最快」，代價是**任何失敗都等於資料消失**。
- `AUTO` 是安全的（事情做完才 ack），但它的失敗預設是 `requeue=true` → **風暴**。
- `MANUAL` 給了你控制權，**但你必須每一條路徑都處理** —— 下一節就是忘了處理的樣子。

📌 **注意 `AUTO` 那個 8,806 次。** 兩秒鐘、10 則訊息、8,806 次投遞。
每一次都會丟一個例外、印一份堆疊。
**這就是為什麼 06 章 6.2 是必修，不是選修。**

⚠️ **`MANUAL` 那個「1 次」也不是好消息。**
它看起來很安靜，但那是因為**那一則卡死了**，後面 9 則根本沒被送出來。
一個真實的系統會在這裡「積壓不動、消費者沒報錯、CPU 是 0」——
比風暴更難查，因為完全沒有訊號。

### 5.3.2 manual 模式忘了 ack，症狀是什麼

```java
    @Test
    void forgettingToAckIsSilentlyFatal() {
        fill(100);
        SimpleMessageListenerContainer c = new SimpleMessageListenerContainer(cf);
        c.setPrefetchCount(30);
        c.setAcknowledgeMode(AcknowledgeMode.MANUAL);
        c.setMessageListener((ChannelAwareMessageListener) (m, ch) -> {
            handled.incrementAndGet();      // 做了事……但沒有呼叫 ch.basicAck
        });
        c.start();
        // ... 每秒印一次 ready / unacked
    }
```

**輸出**：

```
═══ 5.3.2 manual 模式下「忘了 ack」會怎樣 ═══
     第 1 秒  ready=70    unacked=30     程式以為處理了 30 則
     第 2 秒  ready=70    unacked=30     程式以為處理了 30 則
     第 3 秒  ready=70    unacked=30     程式以為處理了 30 則
     ⚠️ 消費者沒有報錯、日誌乾淨、吞吐「看起來」是 0 —— 因為它卡在 prefetch 上限

     停掉消費者之後 ready=100 unacked=0（訊息沒掉，但也一則都沒完成）
```

📌 **這是一個「完美安靜」的故障**：

| 你會看到 | 實際上 |
|---|---|
| 沒有任何例外、日誌乾淨 | 消費者什麼都沒做錯（從它的角度） |
| 程式的計數器說「處理了 30 則」 | 業務邏輯**真的跑了** 30 次 |
| 積壓卡在 70 不動 | 剩下 70 則**永遠不會被送出來** |
| 消費者的 CPU 是 0 | 它在等下一則訊息，而 broker 不會再給 |
| **`unacked` 停在 30** | **← 這是唯一的訊號，而且它剛好等於 prefetch** |

⚠️ **「`unacked` 等於 prefetch 而且不動」是「忘了 ack」的指紋。**
👉 這也是 [01 章 1.5.1](./01-reliable-delivery-three-hops.md) 說
「`messages_unacknowledged` 是第二個一定要監控的數字」的原因。

📌 **所以 manual 模式的程式必須有一條「兜底」的路徑**：

```java
@RabbitListener(queues = "order.confirm-mail.q")
public void onMessage(OrderCreated event, Channel channel,
                      @Header(AmqpHeaders.DELIVERY_TAG) long tag) throws IOException {
    try {
        mailService.sendConfirm(event);
        channel.basicAck(tag, false);
    } catch (TransientException e) {
        channel.basicNack(tag, false, true);     // 暫時性 → 放回去
    } catch (Exception e) {                       // ⚠️ 一定要有這一段
        channel.basicNack(tag, false, false);     // 其他所有錯 → 進死信（06 章）
    }
}
```

⚠️ **`catch (Exception e)` 不能省，而且不能只 catch 你想得到的例外。**
`NullPointerException`、`OutOfMemoryError`（這個要 `Throwable`）、
甚至 `basicAck` 自己丟的 `IOException` ——
任何一條沒有 ack 也沒有 nack 的路徑，都會留下一則永遠卡住的 `unacked`。

📌 **這也是本站建議「大多數專案用 `auto` 而不是 `manual`」的原因**
（[01 章 1.5.1](./01-reliable-delivery-three-hops.md) 結尾那一句）：
`auto` + `default-requeue-rejected: false` + DLX（06 章）
**在行為上等於上面那段程式碼，但你不可能忘記寫。**

### 5.3.3 `basicAck` 的 `multiple` 參數

```java
        // 拿 50 則都不 ack，記下第 25 與第 50 個 deliveryTag
        ch.basicAck(tag25, false);      // multiple = false
        ch.basicAck(tag50, true);       // multiple = true
```

**輸出**：

```
═══ 5.3.3 basicAck 的 multiple 參數 ═══
  拿了 50 則都不 ack      : ready=0 unacked=50
  basicAck(tag=25, multiple=false) → ready=0 unacked=49   ← 只少了 1 則
  basicAck(tag=50, multiple=true)  → ready=0 unacked=0   ← 剩下的 49 則一次確認
```

📌 **`multiple=true` 的意思是「把 `deliveryTag <= N` 的全部一起確認」。**

**它的用途**：批次處理時省下 49 次網路往返。
**它的危險**：如果你的處理是**亂序完成**的（例如丟到執行緒池裡），
`multiple=true` 會**把還沒做完的也一起確認掉**。

⚠️ **判斷原則：只要你的處理不是嚴格照順序完成的，`multiple` 就必須是 `false`。**

**同一個 tag ack 兩次會怎樣**：

```
  ── 同一個 deliveryTag ack 兩次 ──
     客戶端有丟例外嗎 : 沒有（basic.ack 在協定上沒有回應）
     但 broker 把 channel 關了 : #method<channel.close>(reply-code=406,
        reply-text=PRECONDITION_FAILED - unknown delivery tag 50, class-id=60, method-id=80)
     結果：ready=49 unacked=0  ← ⚠️ channel 被關掉，未 ack 的全部回到佇列
```

⚠️ **這是 AMQP 的老規矩**（[04 章 4.6.1](./04-rabbitmq-basics-and-topology.md) 也踩過）：
**錯誤不是「這個操作失敗」，是「這條 channel 從此作廢」。**
一次重複的 ack，就讓那條 channel 上**其他 49 則正在處理的訊息全部回到佇列**。

📌 **兩個實務上的後果**：

1. **`deliveryTag` 是 channel 內的序號，不是訊息 ID。** 換一條 channel，同一則訊息的 tag 就變了。
   ⚠️ **所以絕對不能把 `deliveryTag` 存進資料庫、或傳給另一個執行緒之後延遲很久才用。**
2. **重複 ack 通常來自「重試邏輯」**：`basicAck` 丟了 `IOException`（連線斷了），
   有人寫了 `retry` 包住它 —— 而重試的那一次會撞上 `unknown delivery tag`。
   📌 **連線斷掉之後，那些 `deliveryTag` 全部作廢，不要重試 ack，重新消費就好。**

### 5.3.4 修掉 `receiveAndConvert` 的遺失

[00 章 0.4.1](./00-course-map-why-message-queue.md) 那個「讀走就沒了」的實驗，
用的是 `receiveAndConvert` —— 它是 **auto-ack**。

```java
    @Test
    void fixTheReceiveAndConvertLoss() throws Exception {
        // 寫法 A：receiveAndConvert（等於 auto-ack）
        for (int i = 0; i < 100; i++) {
            Object body = rabbit.receiveAndConvert(Q, 300);
            if (Math.random() < 0.3) { failedA++; continue; }   // 💥 失敗，但訊息已經 ack 掉了
            processedA++;
        }

        // 寫法 B：basicGet(autoAck=false) + 做完才 ack
        GetResponse r = ch.basicGet(Q, false);                   // ← autoAck = false
        long tag = r.getEnvelope().getDeliveryTag();
        if (Math.random() < 0.3) ch.basicNack(tag, false, false);
        else                     ch.basicAck(tag, false);
    }
```

**輸出**：

```
═══ 5.3.4 修掉 00 章 0.4.1 那個「讀走就沒了」═══
  100 則訊息，處理時有 30% 機率丟例外

  ── 寫法 A：receiveAndConvert（等於 auto-ack）──
     處理成功 72 則、處理失敗 28 則
     佇列 ready=0 unacked=0
     ❌ 那 28 則失敗的訊息 : 永久消失

  ── 寫法 B：basicGet(autoAck=false) + 做完才 ack ──
     處理成功 69 則、明確拒絕 31 則
     佇列 ready=0 unacked=0
     ✅ 那 31 則失敗的訊息 : broker 知道它們失敗了
        （requeue=false 而且還沒設死信 → 現在還是掉了，06 章 6.2 補上最後一塊）
```

⚠️ **老實說：兩邊的 `ready` 都是 0，那 31 則**現在**還是掉了。**

差別在於**「掉」這件事有沒有一個可以接住它的地方**：

```
寫法 A：處理失敗 → 訊息早就 ack 掉了 → 沒有任何機制可以補
寫法 B：處理失敗 → basicNack(requeue=false) → broker 會把它送到「死信交換器」
                                              └─ 現在沒設，所以丟掉
                                              └─ 06 章 6.2 設上去，就會進死信佇列
```

📌 **這一章的可靠性是「三塊拼圖」，現在有兩塊**：

| 拼圖 | 在哪 | 沒有它會怎樣 |
|---|---|---|
| ① 生產端知道訊息有沒有進佇列 | **5.2**（confirm + return） | [01 章 1.3.1](./01-reliable-delivery-three-hops.md)：500 則無聲消失 |
| ② 消費端「做完才確認」 | **5.3**（manual / auto ack） | [00 章 0.4.1](./00-course-map-why-message-queue.md)：失敗的訊息永久消失 |
| ③ **失敗的訊息有地方去** | **06 章 6.2**（DLX） | 現在：`requeue=true` → 風暴；`requeue=false` → 還是掉 |

⚠️ **只做 ①② 不做 ③，你只是把「無聲遺失」換成「有聲遺失」。**

### 5.3.5 channel：另一個「不懂就一定會寫錯」的東西

[00 章 0.9.3](./00-course-map-why-message-queue.md) 說 RabbitMQ 有**兩個**必須懂的內部概念：
**prefetch 與 channel**。prefetch 是 5.4 整節，channel 在這裡講完。

**一句話**：**channel 是一條 TCP 連線上的「虛擬連線」。**

```
   你的服務                                    broker
      │                                          │
      │  ══════ 一條 TCP 連線（很貴）═══════════  │
      │    ├─ channel 1  ← 一個消費者執行緒       │
      │    ├─ channel 2  ← 另一個消費者執行緒     │
      │    └─ channel 3  ← RabbitTemplate 送訊息  │
```

**Spring 幫你開了幾條？實測**：

```java
package com.example.lab11.ch05;

@SpringBootTest
class G8ChannelTest {
    @Test
    void connectionsVsChannels() {
        for (int conc : new int[]{1, 4, 8}) {
            SimpleMessageListenerContainer c = new SimpleMessageListenerContainer(cf);
            c.setPrefetchCount(10);
            c.setConcurrentConsumers(conc);
            c.start();
            // ... rabbitmqctl list_connections / list_channels 數一數
        }
    }
}
```

**輸出**：

```
═══ 5.3.5 connection 與 channel：Spring 幫你開了幾條 ═══

  基準（只有一個 RabbitTemplate）: 連線 1 條、channel 1 條
  concurrency = 1  → 連線 1 條、channel 1 條（比基準多 0 條 channel）
                    → 這個服務最多能扣住 1 × 10 = 10 則 unacked
  concurrency = 4  → 連線 1 條、channel 4 條（比基準多 3 條 channel）
                    → 這個服務最多能扣住 4 × 10 = 40 則 unacked
  concurrency = 8  → 連線 1 條、channel 8 條（比基準多 7 條 channel）
                    → 這個服務最多能扣住 8 × 10 = 80 則 unacked

  ── broker 看到的 channel 明細 ──
  number	prefetch_count	messages_unacknowledged	consumer_count
  12	10	0	1
  11	10	0	1
  13	10	0	1
```

📌 **四件事，每一件都會影響你怎麼寫程式**：

**① `concurrency: N` = N 條 channel，但只有 1 條 TCP 連線。**

連線很貴（broker 上一組 Erlang 行程 + TCP buffer），channel 很便宜。
Spring 的 `CachingConnectionFactory` 預設就是**共用一條連線、每個消費者一條 channel**。
⚠️ **所以千萬不要自己 `new ConnectionFactory()` 然後每送一則訊息開一次** ——
那是 [06 章 6.8](./06-rabbitmq-retry-delay-and-cluster.md) 的 `memory_breakdown` 裡
`connection_readers` 爆掉的典型原因。
📌（本站所有實驗都自己開連線，是為了控制它**什麼時候斷**，**不要照抄到正式程式**。）

**② `prefetch` 印在每一條 channel 上，所以上限要乘。**

那張 `list_channels` 的 `prefetch_count` 三條都是 10 ——
**這個服務的 `unacked` 上限是 `3 × 10 = 30`，不是 10。**
👉 5.4.6 那句「算故障半徑要乘上 `concurrency × pod 數`」就是這個意思。

**③ channel 不是執行緒安全的。**

```java
// ❌ 絕對不要：把一個 Channel 分給多條執行緒用
executor.submit(() -> channel.basicPublish(...));
executor.submit(() -> channel.basicPublish(...));
```

AMQP 的 frame 會交錯，**結果是連線層的錯誤，而且很難重現**。
📌 Spring 幫你處理了（每個消費者一條、`RabbitTemplate` 每次操作從池子拿），
**除非你自己拿了 `Channel`（`ChannelAwareMessageListener` 那個參數）再丟給別的執行緒。**

**④ 一個錯誤會關掉整條 channel，而不只是那個操作。**

這件事在本站已經出現三次了：

| 哪裡 | 什麼操作 | 後果 |
|---|---|---|
| [04 章 4.6.1](./04-rabbitmq-basics-and-topology.md) | 宣告一個屬性不一致的佇列 | **同一批後面的佇列全部沒建起來** |
| 5.3.3 | 同一個 `deliveryTag` ack 兩次 | **那條 channel 上未 ack 的 49 則全部回到佇列** |
| [04 章 4.2.1](./04-rabbitmq-basics-and-topology.md) | 對預設 exchange 做 `queueBind` | channel 直接被關 |

📌 **所以「channel 被關掉」這個日誌是一個要認真看的訊號** ——
它代表**同一條 channel 上所有正在處理的訊息都被退回去了**，
而那個數量就是 prefetch。

---

---

## 5.4 `prefetch`：一個參數，三個互相衝突的目標 ★★★

**先講它是什麼。**

```
broker                                    消費者
  │                                          │
  │  ─── deliver m1 ──────────────────────▶  │  處理中…
  │  ─── deliver m2 ──────────────────────▶  │  （在消費者的記憶體裡排隊）
  │  ─── deliver m3 ──────────────────────▶  │
  │                                          │
  │  ⏸ 已經送出 3 則還沒被 ack               │
  │     prefetch = 3 → 停止再送              │
  │                                          │
  │  ◀────────────────────── ack m1 ──────   │  做完一則
  │  ─── deliver m4 ──────────────────────▶  │  → broker 補一則
```

📌 **`prefetch` = 「一個 channel 上，最多可以有幾則 `unacked` 的訊息」。**
它就是 [01 章 1.5.1](./01-reliable-delivery-three-hops.md) 那個第三種狀態的上限。

```yaml
spring:
  rabbitmq:
    listener:
      simple:
        prefetch: 250        # Boot 的預設值
```

### 5.4.1 它決定吞吐

```java
package com.example.lab11.ch05;

@SpringBootTest
class G3PrefetchThroughputTest {

    /** 用一個 prefetch 消費 5,000 則，回傳耗時 */
    long run(int prefetch, long workMicros) throws Exception {
        // ... 先把 5,000 則灌進去
        SimpleMessageListenerContainer c = new SimpleMessageListenerContainer(cf);
        c.setQueueNames(Q);
        c.setPrefetchCount(prefetch);
        c.setConcurrentConsumers(1);
        c.setMessageListener(m -> { if (workMicros > 0) busy(workMicros); done.countDown(); });
        long t0 = System.nanoTime();
        c.start();
        done.await(180, TimeUnit.SECONDS);
        return (System.nanoTime() - t0) / 1_000_000;
    }
}
```

**輸出**：

```
═══ 5.4.1 prefetch 對吞吐的影響（單一消費者，5,000 則）═══

  ── 每則的處理時間 ≈ 0（什麼都不做） ──
     prefetch     耗時             吞吐（則/秒）
     1                 963 ms        5,192   ← 基準
     5                 280 ms       17,857   （3.4 倍）
     20                176 ms       28,409   （5.5 倍）
     50                 98 ms       51,020   （9.8 倍）
     250                69 ms       72,464   （14.0 倍）
     0（無上限）            813 ms        6,150   （1.2 倍）

  ── 每則的處理時間 ≈ 1 ms ──
     prefetch     耗時             吞吐（則/秒）
     1               8,595 ms          582   ← 基準
     5               5,095 ms          981   （1.7 倍）
     20              5,076 ms          985   （1.7 倍）
     50              5,093 ms          982   （1.7 倍）
     250             5,089 ms          983   （1.7 倍）
     0（無上限）          8,835 ms          566   （1.0 倍）
```

📌 **兩組數字要一起看，它們的形狀完全不同**：

**第一組（處理時間 = 0）**：prefetch 從 1 加到 250，吞吐 **14 倍**。
**第二組（處理時間 = 1 ms）**：prefetch 從 1 加到 5，吞吐 **1.7 倍**，然後**就飽和了**。

**為什麼？** 因為 prefetch 買到的東西只有一樣：**把「等 broker 送下一則」的時間藏起來。**

```
prefetch = 1：
  [處理 1ms] → [等 broker 送下一則 ~0.7ms] → [處理 1ms] → [等 0.7ms] → …
              └── 每一則都白等一次網路往返 ──┘

prefetch = 5：
  [處理 1ms][處理 1ms][處理 1ms]…      ← 下一則早就在消費者的記憶體裡了
```

📌 **所以 prefetch 該設多少，取決於一個比值**：

```
                你每則訊息的處理時間
    比值 = ─────────────────────────────
             broker 送一則的往返時間
```

| 你的處理時間 | 往返時間佔比 | prefetch 的價值 |
|---|---|---|
| 微秒級（純記憶體運算） | **幾乎 100%** | 極大（14 倍） |
| 1 ms（一次本機 DB 查詢） | 約 40% | 中等（1.7 倍），**超過 5 就沒用了** |
| 100 ms（呼叫外部 API） | 約 0.7% | **幾乎是 0** |

⚠️ **這張表推翻了一個很常見的做法：「把 prefetch 調大來提升吞吐」。**
如果你的消費者每則要跑 100 ms（絕大多數業務消費者都是這樣），
**prefetch 從 1 調到 250 對吞吐的幫助小於 1%** ——
但它會把「一次故障牽連的訊息數」從 1 變成 250（5.4.4）。

### 5.4.2 ⚠️ `prefetch = 0`（無上限）是最差的選擇

看 5.4.1 最後一列：**`prefetch=0` 的吞吐（6,150）跟 `prefetch=1`（5,192）幾乎一樣。**

「無上限」怎麼會跟「一次一則」一樣慢？把 Spring 拆開來看：

```java
    @Test
    void isPrefetchZeroSlowInSpringOrInTheBroker() throws Exception {
        // ① Spring 內部那條「broker → listener 執行緒」的交接佇列，容量是多少
        // ② 完全繞過 Spring，用原生 basicQos + basicConsume 再量一次
    }
```

**輸出**：

```
═══ 5.4.2 prefetch = 0（無上限）到底發生什麼 ═══
  SimpleMessageListenerContainer.setPrefetchCount(0) 之後，內部記的值 : 0

  ── Spring 內部交接佇列的容量 ──
     prefetchCount=0      → BlockingQueueConsumer 內部佇列容量 = 1
     prefetchCount=1      → BlockingQueueConsumer 內部佇列容量 = 1
     prefetchCount=250    → BlockingQueueConsumer 內部佇列容量 = 250

  ── 完全不經過 Spring：原生 basicQos + basicConsume ──
     basicQos       耗時           吞吐（則/秒）
     1                   889 ms       5,624
     50                   93 ms      53,763
     250                  67 ms      74,627
     0（無上限）               69 ms      72,464
```

📌 **兩行數字解開了謎題**：

| | broker 那一側 | Spring 這一側 |
|---|---|---|
| **原生客戶端 `basicQos(0)`** | 無上限，**72,464 則/秒** | —— |
| **Spring `setPrefetchCount(0)`** | 一樣無上限 | ⚠️ **內部交接佇列容量 = 1** |

`SimpleMessageListenerContainer` 內部是這樣運作的：
AMQP 客戶端的執行緒收到訊息 → 放進一個 `LinkedBlockingQueue` →
listener 執行緒從那裡取出來處理。
**那個 `LinkedBlockingQueue` 的容量就是 `prefetchCount`** ——
而 `LinkedBlockingQueue` 不接受容量 0，所以 Spring 把它變成 **1**。

**結果就是「兩邊最差」**：

```
broker  →  無上限地推   →  [容量 1 的交接佇列]  →  listener 執行緒
           ↑                      ↑
    消費者記憶體會爆         吞吐跟 prefetch=1 一樣
```

### 5.4.3 它決定公平性

前一節說「處理慢的話 prefetch 沒用」。這一節說**為什麼大的 prefetch 還有害**。

```java
package com.example.lab11.ch05;

@SpringBootTest
class G4PrefetchFairnessTest {

    @Test
    void slowConsumerHoardsWhenPrefetchIsBig() throws Exception {
        for (int p : new int[]{1, 250}) {
            Connection cb = attach(p, 40, b);       // 慢的先連上，每則 40 ms
            Connection ca = attach(p, 2, a);        // 快的後連上，每則 2 ms
            // 訊息持續進來：每 5 ms 送一則，共 400 則
            for (int i = 0; i < 400; i++) { rabbit.convertAndSend("", Q, "m-" + i); sleep(5); }
        }
    }
}
```

**輸出**：

```
═══ 5.4.3 prefetch 決定「訊息怎麼分給消費者」═══
  兩個消費者：慢的 B 先連上（每則 40 ms），快的 A 後連上（每則 2 ms）
  訊息是「持續進來」的：每 5 ms 送一則，送 400 則

  ── prefetch = 1 ──
     快的 A（2 ms/則） : 353 則  （88%）
     慢的 B（40 ms/則）:  47 則  （12%）
     400 則全部處理完耗時 : 2,646 ms
     結束時 ready=0 unacked=0

  ── prefetch = 250 ──
     快的 A（2 ms/則） : 200 則  （50%）
     慢的 B（40 ms/則）: 200 則  （50%）
     400 則全部處理完耗時 : 8,660 ms
     結束時 ready=0 unacked=0
```

⚠️ **`prefetch=250` 把 400 則「公平地」平分了，結果總時間慢了 3.3 倍。**

**為什麼**：

```
prefetch = 1（每人手上最多一則）
  broker：誰把手上那則做完了，下一則就給誰
  → 快的 A 一直在要，慢的 B 40 ms 才要一次
  → 自然按能力分配 ✅

prefetch = 250（每人手上最多 250 則）
  broker：輪流發，發滿 250 為止
  → B 一口氣拿走 200 則，然後用 40 ms/則慢慢磨
  → A 早就做完自己那 200 則，然後閒著
  → 總時間 = B 那 200 則的時間 = 200 × 40 ms = 8 秒 ❌
```

📌 **這是 prefetch 最違反直覺的一面**：

> **broker 的分配策略是「round-robin 發到 prefetch 滿為止」，
> 它完全不知道誰快誰慢。**
> prefetch 越大，「分配」這個決定就越早做、越難反悔 ——
> 而在訊息已經躺在慢消費者的記憶體裡之後，**沒有任何機制可以把它搶回來。**

⚠️ **「慢」不只是程式寫得慢。** 在正式環境裡，「慢」通常是：
某一台機器的 GC 卡住了、某一台的磁碟壞了在重試、某一台被排到吵鬧的鄰居旁邊。
**那種暫時性的慢，會因為大 prefetch 變成「這 250 則訊息全部陪它一起慢」。**

### 5.4.4 它決定一次故障牽連多少則訊息 ★★

```java
    @Test
    void prefetchDecidesBlastRadius() throws Exception {
        for (int p : new int[]{1, 20, 250}) {
            // 1,000 則訊息、消費者每則 30 ms
            Connection conn = attach(p, 30, done);
            sleep(3000);
            conn.abort();          // 💥 沒有優雅關閉，直接斷線（模擬 kill -9）
        }
    }
```

**輸出**：

```
═══ 5.4.4 prefetch 決定「一次故障牽連幾則訊息」═══
  1,000 則訊息、消費者每則 30 ms，跑到一半用 conn.abort() 模擬行程被 kill -9

  ── prefetch = 1 ──
     斷線前   ready=905   unacked=1       已 ack 95 則
     斷線後   ready=905   unacked=0
     ready 增加 0 則 ← 這就是「要重做一次」的量

  ── prefetch = 20 ──
     斷線前   ready=880   unacked=20      已 ack 100 則
     斷線後   ready=900   unacked=0
     ready 增加 20 則 ← 這就是「要重做一次」的量

  ── prefetch = 250 ──
     斷線前   ready=650   unacked=250     已 ack 101 則
     斷線後   ready=899   unacked=0
     ready 增加 249 則 ← 這就是「要重做一次」的量
```

📌 **「一次故障要重做幾則」 ≈ `prefetch × 消費者數量`。**

**這跟 [03 章](./03-idempotent-consumer.md) 直接相關**：那 249 則會被**重新處理一次**，
所以你的消費者**必須是冪等的**。而 249 則重複與 1 則重複，在對帳上是完全不同的量級。

⚠️ **這件事還有一個更難查的形式**：
[01 章 1.5.1](./01-reliable-delivery-three-hops.md) 的 `consumer_timeout`（本站是 30 分鐘）。
一個卡死的消費者，在被砍掉之前，會把 **250 則訊息扣在 `unacked` 長達半小時** ——
而且**那 250 則在監控的「積壓」上是看不到的**。

### 5.4.5 實測：`prefetch=0` 在 broker 上堆了多少

```java
    @Test
    void prefetchZeroIsTheWorstOfBothWorlds() throws Exception {
        for (int p : new int[]{250, 0}) {
            // 10,000 則訊息、消費者每則 5 ms
            Connection conn = attach(p, 5, done);
            sleep(2000);
            // ... 印出 ready / unacked
        }
    }
```

**輸出**：

```
═══ 5.4.5 prefetch=0（無上限）在 broker 上堆了多少 ═══
  10,000 則訊息、消費者每則 5 ms，連上之後看 unacked 衝到多少

  ── basicQos(250) ──
     兩秒後  ready=9361   unacked=250     （已 ack 393 則）

  ── basicQos(0 無上限) ──
     兩秒後  ready=0      unacked=9614    （已 ack 514 則）
```

⚠️ **`ready=0`、`unacked=9,614`。整個佇列被推進那一個消費者的記憶體裡。**

**三個後果**：

1. **消費者的記憶體。** 這裡每則 8 bytes，所以看不出來。
   換成每則 100 KB 的訊息，9,614 則 = **接近 1 GB**，直接 OOM。
2. **監控完全失真。** 積壓（`ready`）顯示 **0**，看起來「消費者完全跟得上」。
   實際上有 9,614 則還沒處理。
   👉 **這是 [00 章 0.5.2](./00-course-map-why-message-queue.md) 那個「積壓 0 但其實在燒」的第二種形式。**
3. **故障半徑 = 整個佇列。** 這個消費者一掛，9,614 則全部要重做。

### 5.4.6 所以 prefetch 該設多少

**不要用感覺，從 5.4.1 的數字反推。**

`prefetch=1` 的時候，每一則訊息的時間 = **處理時間 + 一次「ack → broker 送下一則」的往返**。
把 5.4.1 兩組的 `prefetch=1` 拿來算：

| 5.4.1 的組別 | `prefetch=1` 耗時 | 每則 | 減掉處理時間 = 往返 |
|---|---|---|---|
| 處理 0 ms | 963 ms / 5,000 則 | 0.19 ms | **≈ 0.19 ms** |
| 處理 1 ms | 8,595 ms / 5,000 則 | 1.72 ms | **≈ 0.72 ms** |

📌 **這台機器上，一次往返大約 0.2 ～ 0.7 ms。**
⚠️ **你的環境一定不一樣**（跨機房可以到 5 ms 以上），**所以這個數字要自己量** ——
跑一次 5.4.1 的 `prefetch=1` 就有了。

**有了往返時間，prefetch 的下限就只是一個除法**：

```
              一次往返的時間
    prefetch ≥ 1 + ───────────────────
                    每則的處理時間
```

**意思是「在我處理手上這則的時候，下一則要來得及送到」。**

**驗算 5.4.1 的第二組**（處理 1 ms、往返 0.72 ms）：
`1 + 0.72/1 ≈ 1.72` → 取 2。
**實測：`prefetch=2` 就已經到 976 則/秒，而 250 也只有 985。** ✅ 對上了。

| 你的消費者 | 算出來的下限 | 建議值（留 2～3 倍餘裕） | 對照 5.4.1 |
|---|---|---|---|
| 每則 0.01 ms（純記憶體轉換） | `1 + 0.7/0.01 ≈ 71` | **100 ～ 250** | 第一組：250 比 1 快 14 倍 |
| 每則 1 ms（一次本機 DB） | `1 + 0.7/1 ≈ 2` | **5 ～ 10** | 第二組：**2 就飽和了** |
| 每則 100 ms（呼叫外部 API、寄信） | `1 + 0.7/100 ≈ 1` | **1 ～ 5** | prefetch 對吞吐幾乎沒幫助 |

⚠️ **看最後一列**：絕大多數業務消費者都落在這一格，
**而 Boot 的預設是 250** —— 它買不到吞吐，卻把故障半徑放大到 250 則（5.4.4）。

**另外三種情況不看公式，直接決定**：

| 情況 | prefetch | 理由 |
|---|---|---|
| 處理時間**差異很大**（有的 5 ms 有的 5 秒） | **1** | 5.4.3：大 prefetch 會讓慢的那些把整批卡住 |
| 訊息很大（> 100 KB） | **算記憶體**：`prefetch × 訊息大小 × 消費者數 < 可用堆積的 1/4` | 5.4.5 |
| 需要順序 | **1**，而且 `concurrency` 與 `max-concurrency` 都要是 1 | 5.5、5.8.1 |

⚠️ **絕對不要設 0。** 5.4.2 與 5.4.5 證明它是兩邊最差的組合。

⚠️ **prefetch 是「每個 channel」的，不是「每個應用程式」的。**
`concurrency: 5` + `prefetch: 250` = **這個服務最多扣住 1,250 則**。
再乘上 4 個 pod，就是 **5,000 則**。
📌 **算故障半徑跟記憶體的時候，要乘上 `concurrency × pod 數`**（5.3.5 實測過 channel 數）。

### 5.4.7 ⚠️ `consumer_utilisation` 不是 prefetch 的調校訊號

管理介面跟 `list_queues` 都有一個 `consumer_utilisation`，
很多文章說它是「調 prefetch 的指標」。**量一次**：

```java
package com.example.lab11.ch05;

@SpringBootTest
class GBUtilisationTest {
    @Test
    void consumerUtilisationAsATuningSignal() {
        // 同一個消費者（每則 1 ms）、佇列一直是滿的，只改 prefetch
        // 再加一個對照組：消費者根本不是瓶頸
    }
}
```

**輸出**：

```
═══ 5.4.7 consumer_utilisation：什麼時候該調大 prefetch ═══
  同一個消費者（每則 1 ms）、佇列一直是滿的，只改 prefetch

  prefetch     consumer_utilisation   吞吐（則/秒）
  1            0.028380686341513594          568
  2            0.033152013657471904          976
  5            0.033516066093881185          981
  20           0.0357679028524695            985
  250          0.03826477974605107           985

  ── 對照組：消費者根本不是瓶頸（每秒只進 50 則、處理 0 ms）──
     prefetch=10  consumer_utilisation = 1.0
```

📌 **兩件事**：

**① 它的語意跟很多人以為的相反。**

| `consumer_utilisation` | 意思 |
|---|---|
| **接近 1.0** | **佇列想推的時候，消費者隨時都收得下** —— 消費者**游刃有餘**（對照組） |
| **明顯小於 1** | 佇列常常推不出去（消費者在忙、或卡在 prefetch 上限）—— **消費者是瓶頸** |

⚠️ **所以「utilisation 很低」不代表「消費者在閒著」，正好相反。**

**② 它幾乎不隨 prefetch 變動，所以拿它調 prefetch 是沒用的。**

prefetch 從 1 加到 250，**utilisation 只從 0.028 動到 0.038**，
而同一段時間**吞吐從 568 跳到 985（1.7 倍）**。

📌 **要調 prefetch，就直接量吞吐**（5.4.1 那支測試），別看 utilisation。
📌 **`consumer_utilisation` 真正有用的地方是回答另一個問題**：
「這個佇列積壓一直下不去，是消費者太慢，還是訊息根本沒進來？」
—— **接近 1 就是後者**。

---

## 5.5 ⚠️ 多消費者破壞順序 ★★★

[00 章 0.5.1](./00-course-map-why-message-queue.md) 用三個實驗證明了 Kafka 的順序問題，
然後留下這一句：

> ⚠️ **RabbitMQ 也有順序問題，而且更隱蔽**：單一佇列本身是 FIFO，
> 但只要你開了**第二個消費者**（或 `concurrency > 1`），兩個消費者處理速度不同，
> 順序立刻沒了 —— 而且 RabbitMQ **沒有 key 這種機制可以救**。

**現在兌現它。**

### 5.5.1 實測：一張訂單的六個狀態事件

```java
package com.example.lab11.ch05;

@SpringBootTest
class G5OrderingTest {

    static final String[] STEPS = {"1-CREATED", "2-PAID", "3-STOCK_RESERVED",
                                   "4-SHIPPED", "5-DELIVERED", "6-CLOSED"};

    @Test
    void concurrencyBreaksFifo() {
        for (int[] cfg : new int[][]{{1, 0}, {1, 20}, {4, 20}}) {   // {concurrency, 最大處理時間}
            reset();
            for (String s : STEPS) rabbit.convertAndSend("", Q, s);   // 照順序送進同一個佇列
            List<String> seen = consume(cfg[0], STEPS.length, cfg[1]);
            // ... 印出收到的順序
        }
    }
}
```

**輸出**：

```
═══ 5.5.1 單一佇列是 FIFO —— 但只在「一個消費者」的時候 ═══
  一張訂單的六個狀態事件，照順序送進同一個佇列

  ── concurrency = 1，每則處理 0 ms ──
     生產者送出 : 1-CREATED → 2-PAID → 3-STOCK_RESERVED → 4-SHIPPED → 5-DELIVERED → 6-CLOSED
     消費者收到 : 1-CREATED → 2-PAID → 3-STOCK_RESERVED → 4-SHIPPED → 5-DELIVERED → 6-CLOSED
     順序正確？ ✅ 是

  ── concurrency = 1，每則處理 1～20 ms（隨機） ──
     生產者送出 : 1-CREATED → 2-PAID → 3-STOCK_RESERVED → 4-SHIPPED → 5-DELIVERED → 6-CLOSED
     消費者收到 : 1-CREATED → 2-PAID → 3-STOCK_RESERVED → 4-SHIPPED → 5-DELIVERED → 6-CLOSED
     順序正確？ ✅ 是

  ── concurrency = 4，每則處理 1～20 ms（隨機） ──
     生產者送出 : 1-CREATED → 2-PAID → 3-STOCK_RESERVED → 4-SHIPPED → 5-DELIVERED → 6-CLOSED
     消費者收到 : 2-PAID → 4-SHIPPED → 3-STOCK_RESERVED → 1-CREATED → 6-CLOSED → 5-DELIVERED
     順序正確？ ❌ 否
```

**看最後那一行**：

```
  2-PAID → 4-SHIPPED → 3-STOCK_RESERVED → 1-CREATED → 6-CLOSED → 5-DELIVERED
  └─ 訂單還沒建立就付款了
            └─ 還沒備貨就出貨了
                                        └─ 訂單「建立」是第四個處理的
```

📌 **注意前兩組**：`concurrency = 1` 的時候，不管處理時間怎麼隨機，**順序都是對的**。
**FIFO 是佇列的性質，不是消費者的性質** —— 破壞它的是「同時有多個消費者」。

⚠️ **而且 `concurrency` 不是唯一的來源。下面三件事的效果完全一樣**：

| 你做了什麼 | 為什麼會破壞順序 |
|---|---|
| `concurrency: 4` | 四條 listener 執行緒同時處理 |
| **部署第二個 pod** | 兩個行程各自訂閱同一個佇列 —— ⚠️ **這是最常見的，而且沒有人覺得自己「改了設定」** |
| 消費者裡面 `@Async` / 丟進執行緒池 | 同上，只是換個地方並行 |

📌 **第二列是重點**：**「把服務從 1 個 pod 擴到 2 個 pod」在 RabbitMQ 上是一個會改變語意的操作。**
你的壓測（單 pod）會是對的，正式環境（多 pod）會是錯的。

### 5.5.2 規模化之後，錯得多嚴重

六則訊息看起來像是個玩具。換成 200 張訂單：

```java
    @Test
    void howBadIsItAtScale() {
        // 200 張訂單，每張送 CREATED → PAID → SHIPPED
        // 消費者直接用「最後收到的」當狀態 —— 沒有任何防護
        c.setMessageListener(m -> {
            String[] parts = new String(m.getBody()).split(":");
            sleep(rnd.nextInt(6));
            finalState.put(parts[0], parts[1]);      // ← 直接覆蓋
        });
    }
```

**輸出**：

```
═══ 5.5.2 200 張訂單 × 3 個事件，最終狀態錯幾張 ═══
  每張訂單送 CREATED → PAID → SHIPPED，消費者直接用「最後收到的」當狀態

  ── concurrency = 1 ──
     總共處理        : 600 則
     處理順序不對的訂單 : 0 / 200  （0.0%）
     ⚠️ 最終狀態錯的訂單 : 0 / 200  （0.0%）

  ── concurrency = 4 ──
     總共處理        : 600 則
     處理順序不對的訂單 : 138 / 200  （69.0%）
     ⚠️ 最終狀態錯的訂單 : 98 / 200  （49.0%）
     例子 : ORD-0 的處理順序 = [SHIPPED, PAID, CREATED]
```

⚠️ **200 張訂單，98 張的最終狀態是錯的。49%。**

📌 **兩個百分比要分開看，因為它們對應兩種不同的災難**：

| 指標 | 數字 | 意思 |
|---|---|---|
| **處理順序不對** | 138 / 200（69%） | 中間過程亂了 —— 有些流程可以容忍 |
| **最終狀態不對** | **98 / 200（49%）** | **資料是錯的，而且會永遠錯下去** |

「最終狀態是 `PAID`」的那 98 張訂單，**在資料庫裡就是已付款未出貨**。
沒有任何後續事件會來修正它，因為事件已經全部處理完了。
**要修只能對帳。**

⚠️ **而這件事在小量測試裡看不出來**（[00 章 0.5.1](./00-course-map-why-message-queue.md)
的第①個實驗是同樣的教訓）：
6 則訊息可能是對的，200 張訂單就有 49% 是錯的。

### 5.5.3 三條路，而且都有代價

⚠️ **RabbitMQ 的「佇列」本身沒有 key 的概念。** Kafka 可以說「同一個 `orderId` 進同一個分區」，
分區內天然有序而不同分區可以並行 —— **佇列沒有這個層級。**

| 解法 | 怎麼做 | 代價 |
|---|---|---|
| **① 單一消費者** | `concurrency: 1`、`max-concurrency: 1`，**且全站只有一個消費者** | ⚠️ **吞吐鎖死在一條執行緒**，而且**沒有備援**（那個 pod 掛了就停擺） |
| **② 業務層擋** | 每則事件帶版本號 / 序號，消費者只套用「比現在新」的 | 需要改資料模型與生產者（[03 章 3.4.3](./03-idempotent-consumer.md) 的 `event_seq`）；⚠️ **擋不住已經做出去的副作用** |
| **③ 分片佇列** | 用 `x-consistent-hash` exchange 按 key 分到 N 個佇列，**每個佇列一個消費者** | 要裝外掛；⚠️ **擴縮容時有一小批 key 會換佇列，那一瞬間順序會壞**（5.5.6 實測 13%） |

⚠️ **① 的「沒有備援」比想像中嚴重。**
在 Kubernetes 上，`replicas: 1` 表示滾動更新時會有一段時間**完全沒有消費者**，
而且節點被驅逐時你會停擺好幾分鐘。
📌 **實務上的折衷是：兩個 pod，但用「單一活躍消費者」（single active consumer）** ——
佇列宣告時加上 `x-single-active-consumer=true`，broker 保證同一時間只有一個消費者收得到，
另一個是熱備。**吞吐還是一條執行緒的，但至少有備援。**

```java
@Bean Queue orderStateQueue() {
    return QueueBuilder.durable("order.state.q")
            .singleActiveConsumer()      // ← x-single-active-consumer
            .build();
}
```

⚠️ **這也是一個宣告時的不可變參數**（[04 章 4.6.5](./04-rabbitmq-basics-and-topology.md)）——
要加上去，只能走 4.6.4 那個雙綁遷移流程。

### 5.5.4 實測：② 業務層擋，真的擋得住嗎

```java
    @Test
    void versionGuardSurvivesConcurrency() {
        // 同樣 200 張訂單 × 3 個事件、concurrency = 4，但這次帶 event_seq
        c.setMessageListener(m -> {
            String[] p = new String(m.getBody()).split(":");     // ORD-n : seq : STATE
            int s = Integer.parseInt(p[1]);
            // 03 章 3.4.3 的 event_seq：只有「比現在新」才套用
            seq.compute(p[0], (k, cur) -> {
                if (cur == null) { state.put(k, p[2]); return new int[]{s}; }
                synchronized (cur) {
                    if (s > cur[0]) { cur[0] = s; state.put(k, p[2]); }
                    else skipped.incrementAndGet();
                    return cur;
                }
            });
        });
    }
```

**輸出**：

```
═══ 5.5.4 唯一能保住併發的解法：業務層用版本號擋 ═══
  同樣 200 張訂單 × 3 個事件、concurrency = 4，但這次帶 event_seq

     總共處理          : 600 則
     被版本號擋掉的舊事件 : 168 則  ← 順序確實亂了
     ✅ 最終狀態錯的訂單 : 0 / 200
```

📌 **168 則被擋掉 —— 順序一樣是亂的，但結果是對的。**

這就是本站從 [03 章](./03-idempotent-consumer.md) 開始的同一個立場：

> **不要試圖讓「壞事不發生」，要讓「壞事發生了也沒關係」。**
>
> 重複會發生 → 冪等消費（03 章）。
> 亂序會發生 → **版本號擋**（這一節）。
> 兩者的形狀是一樣的：**把「順序 / 唯一性」的保證，從基礎設施搬到業務邏輯裡。**

⚠️ **但要誠實講清楚 ② 的三個限制**：

1. **它只保住「最終狀態」，不保住「中間的副作用」。**
   如果 `SHIPPED` 的處理裡面會寄一封「已出貨」的信，那封信**已經寄出去了** ——
   即使後來 `PAID` 被擋掉。（[03 章 3.6](./03-idempotent-consumer.md) 的「不能回滾的副作用」。）
2. **它需要生產者配合。** `event_seq` 必須是**生產端**產生的、對同一個實體單調遞增的號碼。
   用時間戳有風險（多台機器的時鐘），用資料庫序號比較穩。
3. **實務上要用資料庫的原子更新，不是上面那段記憶體程式碼**：

```sql
UPDATE orders
   SET status = :newStatus, event_seq = :seq
 WHERE order_id = :id
   AND event_seq < :seq        -- ← 這個 WHERE 同時買到「亂序防護」與「冪等」
```

📌 **[03 章 3.4.3](./03-idempotent-consumer.md) 的驗收清單有一題是
「說出 `event_seq` 那個 `WHERE` 同時買到了哪兩個保證」。答案就是這兩個。**

### 5.5.5 實測：`x-single-active-consumer`

5.5.3 說它是「①的實務折衷」。驗證它真的擋得住：

```java
package com.example.lab11.ch05;

@SpringBootTest
class G7SingleActiveConsumerTest {

    @Test
    void singleActiveConsumerKeepsOrderWithTwoPods() {
        admin.declareQueue(new Queue("ch05.sac.plain.q", true, false, false));
        admin.declareQueue(QueueBuilder.durable("ch05.sac.on.q").singleActiveConsumer().build());

        // 兩個佇列各自：送六個狀態事件，然後開「兩個 pod × concurrency 2」去搶
        for (int pod = 0; pod < 2; pod++) {
            SimpleMessageListenerContainer c = new SimpleMessageListenerContainer(cf);
            c.setQueueNames(q);
            c.setConcurrentConsumers(2);
            c.setMessageListener(m -> { sleep(1 + rnd.nextInt(20)); seen.add(new String(m.getBody())); });
            pods.add(c);
        }
    }
}
```

**輸出**：

```
═══ 5.5.5 x-single-active-consumer：兩個 pod、但只有一個在收 ═══

  ── 普通佇列 ──
     broker 上掛著的消費者數 : 4（兩個 pod × concurrency 2）
     收到的順序 : 2-PAID → 4-SHIPPED → 1-CREATED → 3-STOCK_RESERVED → 6-CLOSED → 5-DELIVERED
     順序正確？ ❌ 否

  ── x-single-active-consumer = true ──
     broker 上掛著的消費者數 : 4（兩個 pod × concurrency 2）
     收到的順序 : 1-CREATED → 2-PAID → 3-STOCK_RESERVED → 4-SHIPPED → 5-DELIVERED → 6-CLOSED
     順序正確？ ✅ 是
```

📌 **兩列的「消費者數」都是 4，但只有一個真的在收。**
另外三個是**熱備**：活躍的那個斷線時，broker 會立刻從剩下的挑一個接手。

**它跟「`concurrency: 1` + 單一 pod」的差別**：

| | `replicas: 1` + `concurrency: 1` | `x-single-active-consumer` |
|---|---|---|
| 順序 | ✅ | ✅ |
| 吞吐 | 一條執行緒 | **一樣是一條執行緒** |
| 滾動更新時 | ⚠️ **有一段完全沒有消費者** | ✅ 另一個 pod 立刻接手 |
| 節點被驅逐 | ⚠️ **停擺到 pod 重新排程完** | ✅ 秒級接手 |
| 設定在哪 | 部署設定（很容易被別人改掉） | **佇列宣告上**（broker 保證，改不掉） |

⚠️ **最後一列是它最大的價值**：
「不要把這個服務擴到兩個 pod」這件事，**寫在佇列上比寫在 README 上可靠得多**。

⚠️ **但它有一個代價要講清楚**：**接手的那一瞬間會有重複。**
活躍消費者斷線時，它手上 `unacked` 的訊息會回到佇列、由新的活躍消費者重做 ——
所以 **[03 章](./03-idempotent-consumer.md) 的冪等一樣是前提**。

---

### 5.5.6 實測：`x-consistent-hash` —— RabbitMQ 版的 partition

③ 那條路值得單獨看一次，因為它是**唯一能同時保住「順序」與「併發」的做法**。

RabbitMQ 內建（但預設沒啟用）一個外掛，它按 **routing key 的雜湊**決定訊息進哪個佇列：

```bash
docker exec rabbit-lab rabbitmq-plugins enable rabbitmq_consistent_hash_exchange
```

📌 **這個外掛是內建在映像裡的**（跟 [06 章 6.4.3](./06-rabbitmq-retry-delay-and-cluster.md)
那個要另外下載的延遲外掛不一樣），只是預設沒啟用。
⚠️ **本節跑完記得關掉**：`rabbitmq-plugins disable rabbitmq_consistent_hash_exchange`。

```java
package com.example.lab11.ch05;

@SpringBootTest
class GAConsistentHashTest {

    Map<String, String> route(int nQueues, List<String> orderIds) {
        admin.declareExchange(new CustomExchange(X, "x-consistent-hash", true, false, Map.of()));
        for (int i = 0; i < nQueues; i++) {
            admin.declareQueue(new Queue("ch05.hash." + i + ".q", true, false, false));
            // ⚠️ binding key 是「權重」，不是路由鍵
            admin.declareBinding(new Binding(q, QUEUE, X, "1", null));
        }
        // 用 orderId 當 routing key 送出去，記錄它落在哪個佇列
        rabbit.convertAndSend(X, orderId, "m");
    }
}
```

**輸出**：

```
═══ 5.5.6 consistent-hash exchange：RabbitMQ 版的 partition ═══

  ── 3 個佇列，每個 orderId 送 3 次，看是不是每次都落同一個 ──
     orderId      第1次      第2次      第3次      一致？
     ORD-1001     q1       q1       q1       ✅
     ORD-1002     q0       q0       q0       ✅
     ORD-1003     q1       q1       q1       ✅
     ORD-1004     q2       q2       q2       ✅
     ORD-1005     q2       q2       q2       ✅
     ORD-1006     q1       q1       q1       ✅
     ORD-1007     q1       q1       q1       ✅
     ORD-1008     q0       q0       q0       ✅

     全部一致？ ✅ 是 —— 同一個 key 永遠同一個佇列

  ── 現在加第 4 個佇列（= 擴容），看有幾個 orderId 換了家 ──
     orderId      3 個佇列時     4 個佇列時
     ORD-1005     q2         q3         ⚠️ 換了
     （其他 7 個都沒變）

     1 / 8 個 orderId 被重新分配了（13%）
```

📌 **這就是 Kafka 的 partition 在 RabbitMQ 上的樣子**：

```
                      ┌─▶ hash.0.q ─▶ 消費者 A（concurrency: 1）
  生產者 ─▶ x-consistent-hash ─▶ hash.1.q ─▶ 消費者 B（concurrency: 1）
       routing key = orderId  └─▶ hash.2.q ─▶ 消費者 C（concurrency: 1）
```

**同一張訂單的事件永遠進同一個佇列 → 那個佇列是 FIFO 且只有一個消費者 → 順序保住了。
不同訂單分散在三個佇列 → 併發是 3。**

⚠️ **「consistent」這個字是重點**：加第 4 個佇列只搬走了 **1/8（13%）** 的 key。
如果用簡單的 `hash % N`，**8 個裡面大概會搬走 6 個**。

⚠️ **但它有四個代價，每一個都要想清楚**：

| 代價 | 說明 |
|---|---|
| **① 擴縮容的那一瞬間，被搬走的 key 順序會壞** | 5.5.6 那 13% 的訂單，舊佇列裡還有沒處理完的事件，新事件卻已經進新佇列了 |
| **② 每個佇列只能有一個消費者** | 否則順序又沒了（5.5.1）。**所以「佇列數」就是你的併發上限，而它是宣告時決定的** |
| **③ binding key 是「權重」，不是路由鍵** | ⚠️ 這個 API 很反直覺。綁 `"1"` 表示權重 1，綁 `"2"` 表示這個佇列拿兩倍的量 |
| **④ 沒有 rebalance 機制** | Kafka 的 consumer group 會自動把分區分給活著的消費者。**這裡你得自己確保「每個佇列都有一個消費者、而且只有一個」** |

📌 **④ 是它跟 Kafka 最大的差距**，而且沒有辦法繞過去 ——
你得自己做部署規劃（N 個佇列 → N 個消費者），
或是搭配 `x-single-active-consumer`（5.5.5）讓每個佇列有熱備。

📌 **本站的建議**：

> **先問「這個流程真的需要順序嗎」。** 大多數人以為需要，實際上 ②（版本號）就夠了 ——
> 而且 ② 不需要外掛、不需要部署規劃、換掉 MQ 也不用重做。
>
> **只有當「順序」與「高吞吐」同時是硬需求時，才走 ③。**
> 而如果你發現自己在 RabbitMQ 上認真做 ③，
> **那通常是一個訊號：你要的東西是 Kafka**（07 章）。

---

---

## 5.6 佇列的記憶體：lazy queue 還需要嗎

**先講結論，因為它跟你在網路上查到的多數文章不一樣。**

⚠️ **在 RabbitMQ 3.12 之後，`x-queue-mode=lazy` 對 classic queue 已經沒有效果了** ——
不是因為它被移除，而是因為**預設的行為已經跟 lazy 一樣了**。

### 5.6.1 實測：四種佇列，50,000 則 × 1 KB

```java
package com.example.lab11.ch05;

@SpringBootTest
class G6LazyQueueTest {

    @Test
    void classicVsLazyVsV2() {
        cases.put("ch05.q.classic", Map.of());
        cases.put("ch05.q.lazy",    Map.of("x-queue-mode", "lazy"));
        cases.put("ch05.q.v1",      Map.of("x-queue-version", 1));
        cases.put("ch05.q.v2",      Map.of("x-queue-version", 2));
        // ... 每個灌 50,000 則 × 1 KB，然後讀 broker 的記憶體統計
    }
}
```

**輸出**：

```
═══ 5.6.1 classic / lazy / v2 三種佇列，50,000 則 × 1 KB ═══

  佇列                 寫入耗時         broker 記憶體     在記憶體的則數        訊息在記憶體佔
  ch05.q.classic        1,294 ms  160 KB         1              1 KB
  ch05.q.lazy             948 ms  160 KB         1              1 KB
  ch05.q.v1             1,545 ms  160 KB         1              1 KB
  ch05.q.v2               808 ms  674 KB         1              1 KB

  ── broker 對這四個佇列的完整描述 ──
  name	type	messages	memory	messages_ram	message_bytes_ram	arguments
  ch05.q.v2	classic	50000	690296	1	1024	[{"x-queue-version",2}]
  ch05.q.v1	classic	50000	164144	1	1024	[{"x-queue-version",1}]
  ch05.q.classic	classic	50000	164144	1	1024	[]
  ch05.q.lazy	classic	50000	164144	1	1024	[{"x-queue-mode","lazy"}]
```

📌 **看 `messages_ram` 那一欄：四個佇列都是 1。**

5 萬則訊息、50 MB 的資料，**broker 記憶體裡只放 1 則** ——
不管你有沒有設 lazy。**這個版本的 classic queue 本來就是這樣做的。**

**換成 transient（`delivery_mode=1`）的訊息再試一次，因為那才是 lazy 以前真正有差的地方**：

```
═══ 5.6.1b 換成 transient 訊息（delivery_mode=1）再比一次 ═══
  50,000 則 × 1 KB，訊息不持久化

  佇列                         訊息模式       寫入耗時         broker 記憶體     在記憶體的則數
  ch05.t.classic.persist     persistent    4,100 ms  160 KB         1
  ch05.t.classic.transient   transient       995 ms  160 KB         1
  ch05.t.lazy.transient      transient     1,164 ms  160 KB         1
  ch05.t.v2.transient        transient       822 ms  674 KB         1
```

**一樣，全部都是 1。**

📌 **所以在 RabbitMQ 3.13.7 上**：

| 說法 | 實測 |
|---|---|
| 「積壓很大的佇列要設 lazy，不然記憶體會爆」 | ❌ **過時了。** 預設就已經只留 1 則在記憶體 |
| 「lazy 會讓寫入變慢」 | ❌ 量不出差別（948 ms vs 1,294 ms，在誤差範圍內） |
| 「lazy 已經被移除了」 | ❌ 沒有。它還在，宣告不會報錯，只是沒有效果 |

**`rabbitmq-diagnostics list_deprecated_features` 的完整清單**（本站這台 3.13.7）：

```
name	deprecation_phase
classic_queue_mirroring	permitted_by_default
global_qos	permitted_by_default
management_metrics_collection	permitted_by_default
ram_node_type	permitted_by_default
transient_nonexcl_queues	permitted_by_default
```

📌 **`x-queue-mode` 不在這張表上，但 `transient_nonexcl_queues` 在** ——
也就是說，**這個版本正在淘汰的是「非持久化佇列」，不是 lazy**。
（`classic_queue_mirroring` 是 06 章 6.8 要講的那個歷史包袱。）

⚠️ **這一節真正的教訓不是「lazy 沒用」，是**：

> **RabbitMQ 3.12 / 3.13 改掉了很多預設行為，而網路上多數文章還在講 3.8 的世界。**
> 這跟 [01 章 1.3.5](./01-reliable-delivery-three-hops.md) 那個
> 「Kafka 3.0 改過 producer 預設值，而多數文章還在講舊的」是同一種坑。
>
> 📌 **上線前用 `rabbitmqctl list_queues ... messages_ram memory` 對你自己那台量一次。**
> 那比讀十篇文章可靠。

### 5.6.2 那積壓很大的時候，真正該做什麼

lazy 不用設了，但「佇列會無限長大」這個問題還在。**三個真正有效的手段**：

| 手段 | 怎麼設 | 注意 |
|---|---|---|
| **長度上限** | `x-max-length` / `x-max-length-bytes` | ⚠️ **一定要配 `x-overflow=reject-publish`**（5.2.3：預設會無聲丟掉最舊的） |
| **訊息 TTL** | `x-message-ttl` | 適合「過期就沒意義」的訊息（即時通知、報價） |
| **quorum queue** | `x-queue-type=quorum` | 它有內建的 `x-max-in-memory-length`，記憶體行為是可控的（06 章 6.7） |

```java
@Bean Queue analyticsQueue() {
    return QueueBuilder.durable("order.analytics.q")
            .maxLength(1_000_000L)
            .overflow(QueueBuilder.Overflow.rejectPublish)
            .build();
}
```

⚠️ **這三個全部都是宣告時的不可變參數**（[04 章 4.6.5](./04-rabbitmq-basics-and-topology.md)）。
**要在既有佇列上加，只能用 policy，或走 4.6.4 的雙綁遷移。**

---

## 5.7 消費者掛掉的時候，訊息要等多久才回來 ★★

[01 章 1.5.1](./01-reliable-delivery-three-hops.md) 證明了「連線斷掉 → `unacked` 回到 `ready`」。
**但它沒有回答「要等多久」，而那個答案差了三個數量級。**

### 5.7.1 實測：兩種死法

這個實驗需要一個**真正的外部行程**（在 JVM 裡面沒辦法 `kill -9` 自己）：

```java
package com.example.lab11.ch05.tools;

/** 拿走 prefetch 則訊息、全部不 ack，然後印出 READY 並永遠睡下去 */
public class StandaloneConsumer {
    public static void main(String[] args) throws Exception {
        ConnectionFactory cf = new ConnectionFactory();
        cf.setRequestedHeartbeat(Integer.parseInt(args[2]));
        Connection conn = cf.newConnection();
        Channel ch = conn.createChannel();
        ch.basicQos(Integer.parseInt(args[1]));
        ch.basicConsume(args[0], false, new DefaultConsumer(ch) {
            @Override public void handleDelivery(...) { /* 故意不 ack */ }
        });
        System.out.println("READY pid=" + ProcessHandle.current().pid()
                + " heartbeat=" + conn.getHeartbeat());
        Thread.sleep(Long.MAX_VALUE);
    }
}
```

```bash
# 起消費者 → 記下 pid → 送訊號 → 每秒查一次 unacked 什麼時候變 0
java -cp ... StandaloneConsumer ch05.crash.q 50 60 &
kill -9    $pid      # 行程立刻消失
kill -STOP $pid      # 行程凍住，但 socket 還開著
```

**輸出**：

```
═══ 5.7.1 消費者行程死掉之後，那些訊息要等多久才回到佇列 ═══
  200 則訊息、prefetch=50，消費者一則都不 ack

  ── kill -9（行程立刻消失，作業系統會關掉 socket）（協商後的 heartbeat = 60s）──
     殺掉之前   ready=150   unacked=50
     ready=200   unacked=0
     👉 broker 察覺到消費者不見了，訊息回到佇列：1 秒

  ── kill -STOP（行程凍住，socket 還開著）（協商後的 heartbeat = 60s）──
     殺掉之前   ready=150   unacked=50
     ready=200   unacked=0
     👉 broker 察覺到消費者不見了，訊息回到佇列：180 秒

  ── kill -STOP，但 heartbeat 設成 5 秒（協商後的 heartbeat = 5s）──
     殺掉之前   ready=150   unacked=50
     ready=200   unacked=0
     👉 broker 察覺到消費者不見了，訊息回到佇列：14 秒
```

📌 **1 秒 vs 180 秒。差了 180 倍，而程式碼完全一樣。**

**差別在於「作業系統有沒有幫你關掉 socket」**：

| 死法 | 作業系統做了什麼 | broker 怎麼發現 | 本站實測 |
|---|---|---|---|
| `kill -9`、行程 crash、容器被刪 | **關掉 socket，送出 FIN/RST** | TCP 層立刻知道 | **1 秒** |
| `kill -STOP`、行程凍住、GC 停很久 | ❌ **什麼都不做**，socket 還開著 | **只能靠 heartbeat 逾時** | **180 秒** |
| 機器斷電、網路線被拔、安全群組改了 | ❌ 什麼都不做 | 同上 | 同上 |

⚠️ **第二列與第三列在正式環境裡比第一列常見。**
`kill -9` 是你自己做的事；「機器沒回應」是別人幫你做的事。

### 5.7.2 那 180 秒是怎麼來的

```bash
docker exec rabbit-lab rabbitmqctl -q eval 'application:get_env(rabbit, heartbeat).'
```

```
{ok,60}
```

**broker 端的 heartbeat 是 60 秒**，客戶端連線時協商（兩邊取較小值，0 表示關閉）。
實測從凍住到回收是 **180 秒 ≈ 3 × 60**；把 heartbeat 改成 5 秒之後是 **14 秒 ≈ 3 × 5**。

📌 **所以最壞情況大約是 `heartbeat × 3`。**
⚠️ **不要把它當精確公式** —— 它跟 broker 的週期性檢查有關，
**請用上面那支測試量你自己那台**（正式環境的 broker 常常被調過 heartbeat）。

**在 Spring 裡怎麼調**：

```yaml
spring:
  rabbitmq:
    requested-heartbeat: 20s      # 兩邊取小值，所以這裡設 20 秒是有效的
```

⚠️ **調小 heartbeat 不是免費的**：

| 調小 heartbeat | 好處 | 代價 |
|---|---|---|
| 60s → 20s | 凍住的消費者 180 秒 → 約 60 秒被回收 | 心跳封包變密（可忽略） |
| 20s → 5s | 約 15 秒被回收 | ⚠️ **網路抖一下就會被誤判斷線** → 連線重建 → 那條 channel 上的訊息全部重送 |

📌 **本站建議 20～30 秒**：比預設快得多，又不會因為一次 GC 暫停就誤判。
⚠️ **絕對不要設 0（關掉 heartbeat）**。那表示凍住的消費者**永遠不會被回收**，
只能等 `consumer_timeout`（本站 30 分鐘，[01 章 1.5.1](./01-reliable-delivery-three-hops.md)）。

### 5.7.3 這 180 秒裡，你的監控看到什麼

⚠️ **這才是這一節真正要傳達的事。**

```
     殺掉之前   ready=150   unacked=50
     ─────────────────────────────────── 接下來 180 秒 ───────────────────────────────
                ready=150   unacked=50     ← 一直是這個樣子
```

| 指標 | 這 180 秒裡的值 | 它騙了你什麼 |
|---|---|---|
| **積壓（`ready`）** | 150，**沒有增加** | 看起來「消費跟得上」 |
| **`unacked`** | **50，卡住不動** | ← **唯一的訊號** |
| **消費者數量** | **1**（broker 還以為它活著） | 看起來「有人在處理」 |
| **`deliver` 速率** | **0** | 這其實是第二個訊號，但很多看板沒有畫它 |

📌 **所以 5.3.2 那個「`unacked` 不動」的指紋，在這裡再次出現。**

**兩個必要的告警**，現在可以定義得很具體：

```
① messages_unacknowledged > 0 且「持續 N 分鐘沒有變化」
     → 消費者卡住了（5.3.2 忘了 ack、或 5.7 行程凍住）
     ⚠️ N 要大於你最慢的一則訊息的處理時間

② consumers > 0 但 deliver_get 速率 = 0，持續 N 分鐘
     → broker 以為有消費者，但它沒在拿訊息
```

⚠️ **這兩個告警在「積壓」上完全看不出來** ——
跟 [00 章 0.5.2](./00-course-map-why-message-queue.md) 那個
「三秒 11,191 次投遞、積壓顯示 0」是同一類的盲點，只是方向相反。

### 5.7.4 三種「消費者不見了」的完整對照

| | 消費者做完了但 ack 丟了 | 消費者行程消失（`kill -9`） | 消費者凍住（`kill -STOP`） |
|---|---|---|---|
| **訊息會掉嗎** | ❌ 不會 | ❌ 不會 | ❌ 不會 |
| **訊息會重做嗎** | ✅ **會** | ✅ **會**（prefetch 則） | ✅ 會（prefetch 則） |
| **多久發現** | 立刻 | **1 秒** | **180 秒**（heartbeat × 3） |
| **監控看得到嗎** | 看不到 | 消費者數變 0 | ⚠️ **看不到**（消費者數還是 1） |
| **解法** | [03 章](./03-idempotent-consumer.md) 冪等 | 冪等 + 小一點的 prefetch | 冪等 + 小一點的 heartbeat + `unacked` 告警 |

📌 **三欄的最後一列都有「冪等」。**
這就是 [01 章 1.6](./01-reliable-delivery-three-hops.md) 那個結論的第三次出現：
**你能做的只有 at-least-once + 冪等消費，其他都是在調整「代價落在哪裡」。**

---

## 5.8 落地：本章的完整設定

```yaml
spring:
  rabbitmq:
    host: ${RABBIT_HOST}
    port: ${RABBIT_PORT}
    virtual-host: ${RABBIT_VHOST:/}        # 04 章 4.7
    username: ${RABBIT_USER}
    password: ${RABBIT_PASS}

    # ── 5.2 生產端 ──
    publisher-confirm-type: correlated
    publisher-returns: true
    template:
      mandatory: true                      # ⚠️ 少了它 publisher-returns 沒作用

    # ── 5.7 偵測凍住的連線 ──
    requested-heartbeat: 20s

    # ── 5.3 / 5.4 消費端 ──
    listener:
      simple:
        acknowledge-mode: auto             # 5.3.1：搭 6.2 的 DLX，等於 manual 但不會忘記寫
        default-requeue-rejected: false     # ⚠️ 06 章 6.2 才會真的生效（需要 DLX）
        prefetch: 10                       # ⚠️ 5.4.6：預設 250 對大多數業務消費者都太大
        concurrency: 2                     # 這個佇列不需要順序，所以可以併發
        max-concurrency: 8                 # ⚠️ 5.3.5：上限是 8 條 channel → unacked 上限 8 × 10 = 80
```

⚠️ **如果這個佇列「需要順序」，上面兩行要一起改成 1**：

```yaml
        concurrency: 1
        max-concurrency: 1     # ⚠️ 只設 concurrency: 1 沒有用，Spring 會自己長到 max
```

### 5.8.1 實測：`max-concurrency` 會讓 `concurrency: 1` 失效

上面那句「只設 `concurrency: 1` 沒有用」值得驗一次，因為它是一個**很容易漏掉的組合**：

```java
package com.example.lab11.ch05;

@SpringBootTest
class G9ScaleUpTest {
    @Test
    void concurrencyOneIsNotEnoughIfMaxIsHigher() {
        // 2,000 則訊息、每則 15 ms，看 broker 上的消費者數會不會自己長上去
        c.setConcurrentConsumers(1);
        if (max > 1) c.setMaxConcurrentConsumers(max);
    }
}
```

**輸出**：

```
═══ 5.8.1 concurrency: 1 + max-concurrency: 4 —— Spring 會自己長上去嗎 ═══

  ── concurrency=1, max-concurrency=（沒設） ──
     broker 上看到的消費者數，最高到過 : 1

  ── concurrency=1, max-concurrency=4 ──
     broker 上看到的消費者數，最高到過 : 3

  ── 那順序呢（concurrency=1, max-concurrency=4，訊息一直進來）──
     六個狀態事件收到的順序 : 1-CREATED → 2-PAID → 4-SHIPPED → 3-STOCK_RESERVED → 5-DELIVERED → 6-CLOSED
     順序正確？ ❌ 否
```

⚠️ **`concurrency: 1` 寫得好好的，broker 上卻長到 3 個消費者，順序也壞了。**

📌 **`SimpleMessageListenerContainer` 在積壓上升時會自己加消費者，上限是 `max-concurrency`。**
所以「要順序」這件事必須**兩行一起設成 1**，少一行等於沒設。

📌 **而且光這樣還不夠** —— 部署成兩個 pod 就破功了（5.5.1 那張表第二列）。
**要真的擋住，得把它寫在佇列上**（`x-single-active-consumer`，5.5.5）：
那是 broker 保證的，不是「希望大家不要改 YAML」。

⚠️ **這份設定裡有四個值是「你必須自己想過」的，不能照抄**：

| 設定 | 怎麼決定 |
|---|---|
| `prefetch` | 5.4.6 的公式：`1 + 一次往返時間 ÷ 每則處理時間`，再留 2～3 倍餘裕 |
| `concurrency` | **這個佇列需要順序嗎？** 需要 → 1 + `x-single-active-consumer`（5.5.5） |
| `requested-heartbeat` | 5.7.2：20～30 秒。**網路不穩的環境要往上調** |
| `default-requeue-rejected` | **必須搭配 DLX**，否則 `false` = 失敗的訊息直接丟掉（5.3.4） |

**生產端的完整樣子**（把 5.2 與 [02 章的 Outbox](./02-outbox-and-transactional-consistency.md) 接起來）：

```java
@Component
public class ReliablePublisher {

    private final RabbitTemplate rabbit;
    private final OutboxRepository outbox;

    /** 02 章的輪詢器呼叫這個 */
    public void publish(OutboxMessage msg) {
        CorrelationData corr = new CorrelationData(msg.getId().toString());
        rabbit.convertAndSend(msg.getExchange(), msg.getRoutingKey(), msg.getPayload(), corr);
        // 不在這裡等 —— 等的事情交給 callback，輪詢器可以繼續送下一批
    }

    @PostConstruct
    void wire() {
        rabbit.setConfirmCallback((corr, ack, cause) -> {
            if (corr == null) return;                        // ⚠️ 5.2.1
            if (ack) outbox.markSent(corr.getId());
            else     outbox.markFailed(corr.getId(), cause); // 會被輪詢器撿回來重送
        });
        rabbit.setReturnsCallback(ret -> {
            // ⚠️ NO_ROUTE 是設定錯誤，重試一萬次也一樣 → 標成「需要人介入」
            outbox.markUnroutable(extractId(ret), ret.getReplyText());
            alerting.page("訊息路由不到：" + ret.getExchange() + " / " + ret.getRoutingKey());
        });
    }
}
```

📌 **`markFailed` 與 `markUnroutable` 是兩張不同的臉**：

| | 下一步 | 為什麼 |
|---|---|---|
| `markFailed`（nack） | **等 `next_retry_at` 到了重送** | 暫時性故障（broker 忙、佇列滿） |
| `markUnroutable`（return） | **不要重送，叫人來看** | 設定錯誤，重送只會變成 [00 章 0.5.2](./00-course-map-why-message-queue.md) 的風暴 |

⚠️ **這份設定還缺最後一塊**：
`acknowledge-mode: auto` + `default-requeue-rejected: false` 目前的效果是
**「失敗的訊息直接被丟掉」**（5.3.4 那 31 則）。
👉 **06 章 6.2 補上 DLX，那 31 則才會有地方去。**

---

## 5.9 常見誤區

**① 「confirm 回 ack 就是送到了」**

5.2.2 實測：routing key 打錯的訊息**一樣拿到 `ack = true`**。
`ack` 只表示 broker 收到，`getReturned()` 才表示有沒有進佇列。
📌 **兩個都要檢查。**

**② 「開了 confirm，但那段 `else`（nack）從來沒被測過」**

5.2.3 給了一個一定會產生 nack 的方法：
`x-max-length` + `x-overflow=reject-publish` → 送 20 則到上限 5 的佇列 → **15 個 nack**。
⚠️ 而且那個 nack 的 `cause` 是 **`null`**，所以不要只印 cause。

**③ 「`x-max-length` 是個保護」**

5.2.3 實測：它的**預設** `x-overflow` 是 `drop-head` ——
送 20 則、`ack = 20`、**15 則被無聲丟掉**。
📌 **設 `x-max-length` 就要一起設 `x-overflow=reject-publish`。**

**④ 「`acknowledge-mode: auto` 是自動 ack」**

5.3.1 實測三個值在「消費者丟例外」時的行為：
`none` → **10 則全部消失**；`auto` → **兩秒 8,806 次投遞**；`manual` → **卡在第 1 則**。
📌 `auto` 是「Spring 幫你決定」，`none` 才是 auto-ack。

**⑤ 「manual 模式比較安全」**

5.3.2 實測：忘了一條 `basicAck` → `unacked` 停在 30（= prefetch）、
**沒有例外、日誌乾淨、CPU 是 0、積壓不動**。
📌 **它是本章最安靜的故障。** 除非你有 `messages_unacknowledged` 的告警，否則查不到。

**⑥ 「ack 失敗就重試一次」**

5.3.3 實測：同一個 `deliveryTag` ack 兩次 →
`PRECONDITION_FAILED - unknown delivery tag` → **channel 被關掉 → 那條 channel 上未 ack 的 49 則全部回到佇列**。
📌 連線斷掉之後 `deliveryTag` 全部作廢，**不要重試 ack**。

**⑦ 「prefetch 調大可以提升吞吐」**

5.4.1 實測：**看你的處理時間。**
處理 0 ms → 14 倍；處理 1 ms → **超過 5 就飽和**；處理 100 ms → **幾乎是 0**。
⚠️ 而它一定會把故障半徑放大到 250 則（5.4.4）。

**⑧ 「prefetch 設 0（無上限）最快」**

5.4.2 實測：Spring 的內部交接佇列會變成**容量 1**，吞吐**跟 `prefetch=1` 一樣慢**；
5.4.5 實測：broker 那一側卻是真的無上限，**整個佇列 9,614 則被推進消費者記憶體，`ready` 顯示 0**。
📌 **兩邊最差的組合。**

**⑨ 「prefetch 大一點，訊息分配比較平均」**

5.4.3 實測：平均**不是你要的**。
`prefetch=1` → 快的消費者拿 88%，2,646 ms 跑完；
`prefetch=250` → **50/50 平分，8,660 ms 跑完（慢 3.3 倍）**。

**⑩ 「單一佇列是 FIFO，所以順序沒問題」**

5.5.1 實測：`concurrency=4` → `2-PAID → 4-SHIPPED → 3-STOCK_RESERVED → 1-CREATED → …`。
5.5.2 實測：200 張訂單、**49% 的最終狀態是錯的**。
⚠️ **而且「把 pod 從 1 個擴到 2 個」就會觸發它**，那不是一個「改設定」的動作。

**⑪ 「RabbitMQ 可以像 Kafka 那樣用 key 保順序」**

不行。5.5.3：只有「單一活躍消費者」與「業務層版本號」兩條路，兩條都有代價。

**⑫ 「積壓很大要設 lazy queue」**

5.6.1 實測（RabbitMQ 3.13.7）：classic / lazy / v1 / v2 四種佇列、5 萬則 × 1 KB，
**`messages_ram` 全部都是 1**。設不設 lazy 沒有差別。
📌 **3.12 之後 classic queue 的預設行為已經跟 lazy 一樣了。**

**⑬ 「消費者掛掉，訊息馬上就回佇列了」**

5.7.1 實測：`kill -9` 是 **1 秒**，`kill -STOP`（凍住）是 **180 秒**。
⚠️ 而那 180 秒裡，**積壓正常、消費者數量正常，只有 `unacked` 卡著不動**。

---

## 5.10 本章小結

**這一章證明了六件事**：

1. **confirm 與 return 要一起看**（5.2）：`ack=true` 不代表進了佇列。
   而 `x-overflow` 的預設值 `drop-head` 是**本站第四個「無聲遺失」的來源**。
2. **三種 ack 模式對應三種故障**（5.3）：
   `none` → 全部消失、`auto` → 兩秒 8,806 次的風暴、`manual` → **完全安靜地卡死**。
   而「忘了 ack」的指紋是 **`unacked` 恰好等於 prefetch 且不動**。
3. **channel 是「一條連線上的虛擬連線」**（5.3.5）：`concurrency: 8` = **1 條連線、8 條 channel**，
   `unacked` 上限要乘、channel 不是執行緒安全的、
   而**一個錯誤會關掉整條 channel**（本站已經看過三次）。
4. **`prefetch` 同時決定三件互相衝突的事**（5.4）：
   吞吐（14 倍）、公平性（`250` 反而慢 3.3 倍）、故障半徑（249 則要重做）。
   **Boot 的預設 250 對大多數業務消費者都太大。**
   而 `prefetch=0` 是兩邊最差：Spring 端慢得像 1，broker 端卻推了 9,614 則。
   ⚠️ **而 `consumer_utilisation` 不是它的調校訊號**（5.4.7：prefetch 1→250，它只從 0.028 動到 0.038）。
5. **`concurrency > 1` 會破壞順序，代價是 49% 的訂單狀態錯誤**（5.5）。
   RabbitMQ 的佇列沒有 key，三條路各有代價：**單一活躍消費者**（實測有效）、
   **業務層版本號**（實測有效）、**`x-consistent-hash` 分片**（實測：同 key 同佇列，
   但擴容時 13% 的 key 會搬家）。
6. **「消費者掛掉」有兩種，差 180 倍**（5.7）：
   行程消失 1 秒、行程凍住 180 秒 —— 而後者在監控上**完全看不見**。

📌 **把這一章放回三段防守表**（[01 章 1.7](./01-reliable-delivery-three-hops.md)）：

| 段 | 這一章補上了什麼 | 還缺什麼 |
|---|---|---|
| ① 生產者 → broker | confirm + return 的完整落地（5.2） | ✅ |
| ② broker 自己 | 佇列長度與記憶體（5.6） | ✅ |
| ③ broker → 消費者 | ack 模式（5.3）、channel（5.3.5）、prefetch（5.4）、順序（5.5）、掛掉（5.7） | ⚠️ **「失敗的訊息要去哪裡」** → 06 章 |

### 5.10.1 驗收清單

做得到才往下走：

- [ ] 說出 confirm callback 跑在哪一條執行緒上，以及那件事造成的四個限制。
- [ ] 說出 `rabbit.setConfirmCallback` 裡那行 `if (corr == null) return;` 為什麼不能省。
- [ ] 用 `CorrelationData` 寫出「同時檢查 confirm 與 return」的正確順序，並說出為什麼是那個順序。
- [ ] 做出一個會讓 broker 回 nack 的佇列，並說出它的 `cause` 是什麼。
- [ ] 說出 `x-overflow` 兩個值的差別，以及為什麼預設值會造成無聲遺失。
- [ ] 說出 `none` / `auto` / `manual` 在「消費者丟例外」時各自的投遞次數與訊息下場。
- [ ] 說出「manual 忘了 ack」的四個症狀，以及**唯一**那個看得出來的指標。
- [ ] 說出 `basicAck(tag, true)` 做了什麼，以及什麼情況下不能用它。
- [ ] 說出同一個 `deliveryTag` ack 兩次會發生什麼，以及為什麼不該重試 ack。
- [ ] 說出 `concurrency: 4` + `prefetch: 10` 會開幾條連線、幾條 channel，`unacked` 上限是多少。
- [ ] 說出「一個錯誤關掉整條 channel」在本站出現過的三個場景。
- [ ] 說出 `prefetch` 同時決定的**三件事**，並指出哪兩件的方向是**相反**的。
- [ ] 說出怎麼從 `prefetch=1` 的耗時反推「一次往返」的時間。
- [ ] 用 5.4.6 的公式，算出一個「每則跑 200 ms」的消費者該設多少 prefetch（往返用 0.7 ms）。
- [ ] 說出 `consumer_utilisation` 接近 1 跟明顯小於 1 各代表什麼，以及它該拿來回答哪個問題。
- [ ] 說出 `prefetch=0` 在 Spring 端與 broker 端各自發生什麼。
- [ ] 說出 `prefetch` 是「每什麼」的，以及算故障半徑時要乘上哪兩個數字。
- [ ] 說出 5.5.2 的兩個百分比，並解釋為什麼「最終狀態錯」比「處理順序錯」嚴重。
- [ ] 說出三種會破壞順序的操作，並指出哪一種**不被當成「改設定」**。
- [ ] 說出 `x-single-active-consumer` 跟「`replicas: 1`」的四個差別。
- [ ] 說出 `x-consistent-hash` 怎麼同時買到順序與併發，以及它的四個代價。
- [ ] 說出為什麼「在 RabbitMQ 上認真做分片佇列」是一個選型訊號。
- [ ] 說出 `event_seq` 那個 `WHERE` 擋得住什麼、擋不住什麼。
- [ ] 說出在 RabbitMQ 3.13 上 lazy queue 的實際效果，以及你該怎麼驗證你自己那台。
- [ ] 說出兩種「消費者掛掉」的偵測時間，以及造成差距的原因。
- [ ] 說出那 180 秒裡，`ready` / `unacked` / `consumers` / `deliver` 四個指標分別長什麼樣。
- [ ] 寫出兩條「消費者卡住」的告警規則。

### 5.10.2 本章練習

**練習一（20 分鐘）**：重跑 5.4.1，但把「每則的處理時間」改成 **5 ms、50 ms、200 ms** 各一輪。
**畫出「處理時間 × prefetch → 吞吐」的完整表格。**
然後回答：從哪一個處理時間開始，`prefetch` 大於 5 就完全沒有意義了？

**練習二（25 分鐘）**：重跑 5.4.3，但把兩個消費者改成**三個**：
一個 2 ms、一個 40 ms、一個**中途才連上**（送到第 200 則時才 start）。
**記錄三個人各拿了幾則。**
然後把 `prefetch` 設成 1、5、50 各跑一次 —— **找出「開始變不公平」的那個值**。

**練習三（25 分鐘）**：5.3.2 的實驗，但把 `prefetch` 改成 1、10、250。
**記錄每一種情況下 `unacked` 停在哪個數字。**
然後寫一條 Prometheus / 管理介面的告警規則，
**要求它在三種 prefetch 設定下都能抓到這個故障**（提示：不能寫死數字）。

**練習四（30 分鐘）**：把 5.5.2 的實驗改成**用真的資料庫**：
`orders` 表加 `status` 與 `event_seq`，消費者用
`UPDATE orders SET status=?, event_seq=? WHERE order_id=? AND event_seq < ?`。
跑 `concurrency = 1 / 4 / 16` 各一次。
**記錄：最終狀態錯的訂單數、以及那個 `UPDATE` 回傳 0 的次數。**
第二個數字就是「被擋掉的亂序事件」。

**練習五（30 分鐘）**：把 5.5.5 的 `x-single-active-consumer` 實驗延長：
在消費到一半的時候**把活躍的那個 pod 停掉**。
**記錄三件事**：
① 接手花了多久？② 有幾則訊息被處理兩次？③ 順序有沒有壞掉？
（提示：第 ② 個答案跟 prefetch 有關。）

**練習六（進階，40 分鐘）**：跑一次 5.7.1，但把 `requested-heartbeat` 設成
**5 秒、20 秒、60 秒、0（關閉）** 各一次。
**記錄每一種的回收時間**（0 那一次請設一個 10 分鐘的上限，然後記錄「沒回來」）。
然後回答：你的正式環境該設多少？寫下你的理由與你願意接受的最壞情況。

**練習七（進階，40 分鐘）**：把 5.2 的 `ReliablePublisher` 接上
[02 章](./02-outbox-and-transactional-consistency.md) 的 Outbox，做一個端到端驗證：

1. 輪詢器送 1,000 則，其中 100 則的 routing key 是錯的。
2. **驗證**：`markSent` 900 筆、`markUnroutable` 100 筆、`markFailed` 0 筆。
3. 然後在送到一半時 `docker stop rabbit-lab`，10 秒後 `docker start`。
4. **記錄**：有幾則進了 `markFailed`、重送之後最終有幾則成功。
5. **最後對帳**：broker 上收到的總數 **≥ 900**，且資料庫裡 `PENDING` 的筆數是 **0**。

**練習八（綜合，60 分鐘）**：做一份「消費者健康檢查」腳本，
對每一個佇列輸出下面這張表，並標出有問題的列：

| 欄位 | 從哪來 | 紅線 |
|---|---|---|
| `messages_ready` | `list_queues` | 看你的業務 |
| `messages_unacknowledged` | `list_queues` | **等於 `prefetch × consumers` 且不動** → 卡住 |
| `consumers` | `list_queues` | 0 → 沒人在聽 |
| `consumer_utilisation` | `list_queues` | ⚠️ 明顯小於 1 → **消費者是瓶頸**（5.4.7：它不是 prefetch 的調校訊號） |
| 佇列的 `arguments` | `list_queues arguments` | 有 `x-max-length` 卻沒有 `x-overflow` → 無聲遺失 |

**跑在你自己的環境上，你大概會找到至少一個問題。**

---

## 5.11 下一章預告

這一章結束時，你的訊息鏈路上還剩一個洞，而且它在每一節都出現過：

```
  5.3.1  acknowledge-mode=auto  → 失敗時 requeue=true → 兩秒 8,806 次投遞
  5.3.4  requeue=false          → 失敗的訊息直接丟掉
  5.8    設定表的最後一列        → 「⚠️ 06 章 6.2 才會真的生效」
```

**兩個選項，一個是風暴，一個是遺失。** 06 章給第三個選項。

**06 章會做四件事**：

- ⚠️ **6.2：解掉 [00 章 0.5.2](./00-course-map-why-message-queue.md) 那個事故。**
  那一則訊息**三秒被投遞 11,191 次、噴出 335,755 行、45 MB 日誌，而佇列積壓顯示 0**。
  06 章會用 `default-requeue-rejected: false` + **死信交換器（DLX）** 重跑同一個實驗，
  並把兩組數字擺在一起。
- **重試退避的兩種做法**：本地重試（`spring.rabbitmq.listener.simple.retry.*`）
  與死信回送。它們的差別**不是風格問題** ——
  其中一種會**把你的消費者執行緒卡住**，而那件事可以量出來。
- **延遲佇列**：[00 章 0.4.4](./00-course-map-why-message-queue.md) 宣稱過
  「延遲 30 分鐘後檢查未付款訂單，RabbitMQ 一行設定」。
  06 章要兌現它，**而且要說清楚那「一行設定」的版本（TTL + DLX）有一個嚴重的坑** ——
  一則 30 分鐘的訊息會**把排在它後面的 1 分鐘訊息一起卡住**。
- **quorum queue**：[01 章 1.3.8 與 1.4.5](./01-reliable-delivery-three-hops.md) 兩處都寫著
  「磁碟壞掉要靠 quorum queue，06 章」。
  06 章會比較 classic 與 quorum 的吞吐、功能差異，
  以及 quorum 內建的那個**「重試幾次就自動進死信」**的參數 ——
  它讓 6.2 那套設定可以少寫一半。
  順帶清掉 `classic_queue_mirroring` 這個歷史包袱（5.6.1 那張淘汰清單的第一列）。
