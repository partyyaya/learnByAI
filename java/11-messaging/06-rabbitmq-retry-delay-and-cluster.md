# 第 06 章：RabbitMQ 重試、延遲與叢集

> [00 章 0.5.2](./00-course-map-why-message-queue.md) 留下了本站最誇張的一組數字。
> **一則**處理不了的訊息，在三秒內：
>
> ```
>   投遞次數 : 11,191 次（約 3,730 次/秒）
>   日誌行數 : 335,755 行
>   日誌大小 : 45 MB   → 推算一小時 54 GB
>   佇列積壓 : 0 則  ← 監控上看起來「很正常」
> ```
>
> 當時的結論是「06 章 6.2 會解掉它」。**現在解。**
>
> 6.2.1 跑的是**同一支測試、同一則毒藥訊息、同一個 `acknowledge-mode`**，
> 只加了兩行設定（`default-requeue-rejected=false` + 一個死信交換器）：
>
> ```
>   投遞次數 : 1 次
>   日誌行數 : 64 行
>   日誌大小 : 8 KB
>   死信佇列 : 1 則  ← 你的告警就靠這個數字
> ```
>
> **從 11,191 降到 1。從 45 MB 降到 8 KB。**
>
> ---
>
> 這一章還要處理三件 [00 章](./00-course-map-why-message-queue.md) 與
> [01 章](./01-reliable-delivery-three-hops.md) 欠下的帳：
>
> **一、「延遲 30 分鐘檢查未付款訂單，RabbitMQ 一行設定」**（[00 章 0.4.4](./00-course-map-why-message-queue.md) 這樣宣稱過）。
> 6.4.1 會兌現它，**也會證明那「一行設定」有一個足以讓它在正式環境出事的缺陷**：
> 實測送出「延遲 8 秒」與「延遲 1 秒」兩則訊息，
> **那則 1 秒的，在 8,044 ms 才到。** 它被排在前面的 8 秒訊息**卡住了**。
>
> **二、重試退避有兩種做法，而它們的差別不是風格問題。**
> 6.3 實測：1 則毒藥訊息 + 20 則正常訊息、退避 1s → 2s → 4s。
> **本地重試**讓那 20 則正常訊息整整等了 **7,045 ms**；
> **死信回送**讓它們在 **45 ms** 就處理完了。
>
> **三、quorum queue**（[01 章 1.3.8 與 1.4.5](./01-reliable-delivery-three-hops.md) 兩處都指向這裡）。
> 6.6.2 實測它內建的 `x-delivery-limit`：
> **用的是會造成風暴的那個 `default-requeue-rejected=true`，總投遞次數還是只有 4 次。**
> 它讓 6.2 那套設定可以少寫一半。

---

## 6.1 學習目標

完成本章後，你應該可以：

- 設定死信交換器（DLX），並說出它把 [00 章 0.5.2](./00-course-map-why-message-queue.md)
  那個故障的三個數字各自變成什麼（6.2.1）。
- 列出訊息進入 DLX 的**四種原因**，並從 `x-death` header 讀出「它為什麼死、死了幾次」（6.2.2、6.2.3）。
- 說出 DLX 的三個坑（死信的死信、routing key 的覆寫、無限循環），並各給一個防法（6.2.5）。
- 實作**兩種**重試退避，並說出其中一種**會卡住消費者執行緒**的量級（6.3）。
- 判斷你的流程該用哪一種重試，並寫出退避階梯（6.3.3）。
- 用 TTL + DLX 做延遲佇列，**並說出它的 head-of-line blocking 缺陷與兩種繞法**（6.4）。
- 說出 delayed-message 外掛解決了什麼、又帶來什麼新問題（6.4.3）。
- 設定優先級佇列，並說出它**超不了**什麼（6.5）。
- 說出 classic 與 quorum queue 的吞吐差異、功能差異，以及該怎麼選（6.6）。
- 用 quorum 的 `x-delivery-limit` 取代一半的 DLX 設定（6.6.2）。
- 說出鏡像佇列（`ha-mode`）為什麼不該再用，並從 broker 上驗證它的淘汰狀態（6.7）。
- 用 `rabbitmq-diagnostics` 的四個指令做基本健檢（6.8）。

---

## 6.2 死信交換器：解掉那場風暴 ★★★

### 6.2.1 實測：同一則毒藥訊息，這次加了 DLX

```java
package com.example.lab11.ch06;

/** 跟 00 章 0.5.2 的 A4RequeueStormTest 同一個實驗，只改兩件事 */
@SpringBootTest(properties = {
        "spring.rabbitmq.listener.simple.default-requeue-rejected=false",   // ← 改動 ①
        "spring.rabbitmq.listener.simple.acknowledge-mode=auto"             // ← 跟 00 章一樣
})
class H1DlxFixesStormTest {

    @TestConfiguration
    static class Cfg {
        @Bean FanoutExchange stormDlx() { return new FanoutExchange(DLX, true, false); }
        @Bean Queue stormDlq() { return QueueBuilder.durable(DLQ).build(); }
        @Bean Binding stormDlqBinding() { return BindingBuilder.bind(stormDlq()).to(stormDlx()); }

        @Bean Queue stormQ() {
            return QueueBuilder.durable(Q)
                    .deadLetterExchange(DLX)        // ← 改動 ②，就這一行
                    .build();
        }
    }

    @Component
    static class Handler {
        @RabbitListener(queues = Q)
        void onMessage(String body) {
            if (!armed) return;
            deliveries.incrementAndGet();
            throw new RuntimeException("下游的收款服務現在 500");    // 跟 00 章一字不差
        }
    }
}
```

**輸出**：

```
═══ 6.2.1 同一則毒藥訊息，這次加了 DLX ═══
  第 1 秒：這「一則」訊息累計被投遞 1 次
  第 2 秒：這「一則」訊息累計被投遞 1 次
  第 3 秒：這「一則」訊息累計被投遞 1 次

  送進佇列的訊息數 : 1 則
  三秒內的投遞次數 : 1 次
  原佇列積壓        : 0 則
  死信佇列積壓      : 1 則  ← 告警就靠這個數字
```

同一次執行，量一下日誌：

```bash
mvn -q -Dtest=H1DlxFixesStormTest test > /tmp/h1-full.out 2>&1
grep -c "下游的收款服務現在 500" /tmp/h1-full.out
wc -l < /tmp/h1-full.out
du -h /tmp/h1-full.out
```

```
1
      64
8.0K	/tmp/h1-full.out
```

📌 **把兩章的數字擺在一起**：

| | [00 章 0.5.2](./00-course-map-why-message-queue.md) | **6.2.1（加了 DLX）** |
|---|---|---|
| 三秒內的投遞次數 | **11,191** | **1** |
| 例外次數 | 11,191 | **1** |
| 日誌行數 | 335,755 | **64** |
| 日誌大小 | 45 MB（推算一小時 54 GB） | **8 KB** |
| 佇列積壓 | 0 ← **看不出有問題** | 0 |
| **死信佇列積壓** | **沒有死信佇列** | **1** ← **看得出有問題** |

⚠️ **最後兩列才是重點。**

「佇列積壓 0」在兩邊都一樣 —— 差別是**現在有第二個數字可以看**。
你的告警規則變成一行：

```
  死信佇列深度 > 0  →  告警
```

📌 **而且那則訊息還在。** 你可以把它撈出來看、修好程式之後再放回主佇列重跑
（6.2.4 的重放 SOP）。00 章那個版本裡，它只是在無限地燒 CPU 跟磁碟。

### 6.2.2 訊息什麼時候會進 DLX

📌 **四種原因，每一種對應 `x-death` 裡的一個 `reason`**：

| `reason` | 觸發條件 | 你在哪一章看過 |
|---|---|---|
| `rejected` | 消費者 `basicNack` / `basicReject` 且 **`requeue=false`** | [05 章 5.3.4](./05-rabbitmq-reliability.md) |
| `expired` | 訊息的 TTL 到了（`x-message-ttl` 或每則的 `expiration`） | **6.4 的延遲佇列就是用這個** |
| `maxlen` | 佇列長度超過 `x-max-length`，而且 `x-overflow` 是預設的 `drop-head` | [05 章 5.2.3](./05-rabbitmq-reliability.md) |
| `delivery_limit` | quorum queue 的 `x-delivery-limit` 用完了 | **6.6.2** |

⚠️ **看第三列，它值得單獨量一次。**
[05 章 5.2.3](./05-rabbitmq-reliability.md) 說 `drop-head` 會「無聲丟掉最舊的」——
**那句話只有在「沒設 DLX」時才成立**：

```java
// A：x-max-length=5 + DLX
admin.declareQueue(QueueBuilder.durable(qa).maxLength(5L).deadLetterExchange(dlx).build());
// B：x-max-length=5，沒有 DLX（05 章 5.2.3 那個）
admin.declareQueue(QueueBuilder.durable(qb).maxLength(5L).build());
// 各送 20 則
```

```
═══ 6.2.2b 被 x-max-length 擠掉的訊息，設了 DLX 會去哪 ═══

  A：x-max-length=5 + DLX，送 20 則
     主佇列積壓 : 5 則
     死信佇列   : 15 則  ← 被擠掉的 15 則全部接住了
     死信上的 reason : maxlen

  B：x-max-length=5，沒有 DLX，送 20 則
     主佇列積壓 : 5 則
     死信佇列   : 0 則  ← 那 15 則真的消失了
```

📌 **同一個 `x-max-length`，差一個 DLX，「無聲遺失 15 則」變成「死信佇列 15 則」。**
這是「`x-max-length` + DLX」這個組合最被低估的價值 ——
⚠️ 而 [05 章 5.2.3](./05-rabbitmq-reliability.md) 建議的 `reject-publish` 是**另一種**選擇：

| 佇列滿了 | 生產者收到 | 舊訊息 | 適合 |
|---|---|---|---|
| `drop-head`（預設）+ **沒有** DLX | `ack` | ❌ **無聲消失** | 沒有 |
| `drop-head` + **有** DLX | `ack` | ✅ 進死信 | 「舊的可以晚點再處理」 |
| `reject-publish` | **`nack`** | ✅ 留在佇列 | 「不能丟，寧可讓上游知道」 |

📌 **選哪一個取決於「你想讓誰承擔背壓」**：
`reject-publish` 把壓力推回生產者（[02 章的 Outbox](./02-outbox-and-transactional-consistency.md) 會重送），
`drop-head + DLX` 讓生產者照常跑、把舊訊息移到旁邊。

### 6.2.3 `x-death`：訊息身上的驗屍報告

6.2.1 把死信撈出來看：

```java
Message dead = rabbit.receive(DLQ, 2000);
System.out.println(dead.getMessageProperties().getHeader("x-death"));
System.out.println(dead.getMessageProperties().getHeaders().keySet());
```

```
     body        : order-9527
     x-death     : [{reason=rejected, count=1, exchange=, time=Mon Sep 21 18:35:25 CST 2026,
                     routing-keys=[ch06.storm.q], queue=ch06.storm.q}]
     其他 header : [x-first-death-exchange, x-last-death-reason, x-death,
                    x-first-death-reason, x-first-death-queue, x-last-death-queue,
                    x-last-death-exchange]
```

📌 **`x-death` 是一個陣列，每個元素代表「在某個佇列上死過幾次」**：

| 欄位 | 意思 | 用途 |
|---|---|---|
| `reason` | 6.2.2 那四種之一 | **分類告警**：`rejected` 要人看，`expired` 是延遲佇列的正常運作 |
| **`count`** | **在這個佇列上死過幾次** | ⚠️ **這就是重試計數器**（6.3.2 用它做退避階梯） |
| `queue` / `exchange` / `routing-keys` | 它原本在哪 | **重放時要靠這個知道放回哪裡** |
| `time` | ⚠️ **第一次**死掉的時間（見下方實測） | 排查時間線 |

⚠️ **`count` 是「同一個佇列」的累計，不是「總共死幾次」。**
訊息在 A 佇列死 2 次、在 B 佇列死 3 次，`x-death` 會有**兩個元素**，
`count` 分別是 2 與 3。做重試計數時要**取對的那一個**（6.9.2 會量這件事）。

⚠️ **而 `time` 不會跟著 `count` 一起更新。** 讓同一則訊息在同一個階梯上繞三圈：

```
═══ 6.2.3b x-death 的 time 是第一次還是最後一次 ═══
  第 1 次 nack 之後：
     {queue=ch06.dt.retry.q    reason=expired   count=1 time=Tue Sep 22 11:29:47 CST 2026}
     {queue=ch06.dt.main.q     reason=rejected  count=1 time=Tue Sep 22 11:29:45 CST 2026}
  第 2 次 nack 之後：
     {queue=ch06.dt.retry.q    reason=expired   count=2 time=Tue Sep 22 11:29:47 CST 2026}
     {queue=ch06.dt.main.q     reason=rejected  count=2 time=Tue Sep 22 11:29:45 CST 2026}
  第 3 次 nack 之後：
     {queue=ch06.dt.retry.q    reason=expired   count=3 time=Tue Sep 22 11:29:47 CST 2026}
     {queue=ch06.dt.main.q     reason=rejected  count=3 time=Tue Sep 22 11:29:45 CST 2026}
```

📌 **`count` 1 → 2 → 3，`time` 完全沒動。**
`time` 是**第一次**在那個佇列上死掉的時間。

⚠️ **所以不要用 `x-death` 的 `time` 回答「它最近一次失敗是什麼時候」** ——
那個問題只能靠你自己在訊息 header 上蓋時間戳，或看消費者的日誌。
📌 **但它剛好適合回答另一個問題：「這則訊息卡了多久了？」**
`now - x-death[].time` 就是它在這個階梯裡繞了多久 ——
**那是死信告警裡最該顯示的數字。**

**Spring 這一側，還有六個平鋪的 header 比較好用**（連同 `x-death` 本身共 7 個）：

```
  完整 header 清單 : [x-death,
                     x-first-death-exchange, x-first-death-queue, x-first-death-reason,
                     x-last-death-exchange,  x-last-death-queue,  x-last-death-reason]
  header 個數      : 7
```


```java
@RabbitListener(queues = DLQ)
void onDeadLetter(Message m,
        @Header(name = "x-last-death-reason", required = false) String reason,
        @Header(name = "x-first-death-queue", required = false) String originQueue) {
    // reason = "rejected" / "expired" / "maxlen" / "delivery_limit"
    // originQueue = 它原本在哪個佇列
}
```

⚠️ **這四個 `x-first-death-*` / `x-last-death-*` 是 RabbitMQ 3.10 之後才有的。**
舊版只有 `x-death`，而解析那個巢狀結構在 Java 裡很難看
（`List<Map<String, Object>>`，6.3.2 那段 `deathCount()` 就是）。

### 6.2.4 死信佇列該怎麼經營

⚠️ **建了死信佇列但沒有人看，等於沒建。**
[00 章的誤區清單](./00-course-map-why-message-queue.md)最後一條就是「死信佇列沒有人看」。

📌 **一個可以上線的死信佇列有四件事**：

**① 它自己要有長度上限與告警。**

```java
@Bean Queue confirmMailDlq() {
    return QueueBuilder.durable("order.confirm-mail.dlq")
            .maxLength(100_000L)
            .overflow(QueueBuilder.Overflow.rejectPublish)   // 05 章 5.2.3
            .build();
}
```

⚠️ **死信佇列本身沒有 DLX** —— 它是最後一站。
所以它滿了的話，**訊息真的會消失**，這也是為什麼要 `reject-publish` 而不是預設的 `drop-head`。

**② 告警規則要分兩層**：

| 規則 | 意思 |
|---|---|
| `死信佇列深度 > 0` 持續 5 分鐘 | 有訊息處理不了 → 要有人看 |
| **`死信佇列深度增加速率 > X/分鐘`** | ⚠️ **下游整個掛了**，不是單一則毒藥訊息 |

**③ 要有一支「看死信」的工具**，而不是每次都用 `rabbitmqadmin get` 手動翻：

```bash
# 看前 10 則死信（ackmode=ack_requeue_true：看完放回去，不要弄掉它）
docker exec rabbit-lab rabbitmqadmin -u lab -p lab \
  get queue=order.confirm-mail.dlq count=10 ackmode=ack_requeue_true
```

**④ 要有重放 SOP。** 修好程式之後，把死信放回主佇列：

```java
/** 把死信佇列裡的訊息放回它原本的佇列。⚠️ 修好程式之後才跑，而且要限量 */
public int replay(int max) {
    int moved = 0;
    for (int i = 0; i < max; i++) {
        Message m = rabbit.receive("order.confirm-mail.dlq", 500);
        if (m == null) break;
        String originQueue = (String) m.getMessageProperties().getHeader("x-first-death-queue");
        // ⚠️ 把 x-death 相關 header 清掉，否則下次死掉時 count 會接著算
        m.getMessageProperties().getHeaders().keySet()
                .removeIf(k -> k.startsWith("x-death") || k.startsWith("x-first-death")
                            || k.startsWith("x-last-death"));
        rabbit.send("", originQueue, m);
        moved++;
    }
    return moved;
}
```

⚠️ **重放有三個規矩**：

1. **限量。** 一次放 100 則，確認處理成功再放下一批。
   ⚠️ 一次把 50 萬則倒回去，如果程式沒真的修好，你會得到第二次事故。
2. **要冪等。** 那些訊息**可能已經被處理過一部分**（[03 章](./03-idempotent-consumer.md)）。
3. **要清掉 `x-death`**，否則重試計數會接著舊的算，訊息一進去就又被判定「重試超過上限」。

### 6.2.5 ⚠️ DLX 的三個坑

**坑一：死信的 routing key 會被保留，而那通常不是你要的。**

訊息死掉時，**它原本的 routing key 會被原封不動地帶到 DLX 上**。

```
訊息 routing key = "order.created.vip"
   → 主佇列處理失敗
   → 送到 DLX，routing key 還是 "order.created.vip"
   → ⚠️ 如果你的 DLX 是 topic 型，而死信佇列綁的是 "dead.#" → 路由不到 → 訊息消失
```

**量一次**（DLX 上放兩個佇列，一個綁 `dead.#`、一個綁 `order.created.vip`）：

```
═══ 6.2.5 死信帶著哪一個 routing key ═══

  A（只設 x-dead-letter-exchange）
     綁 dead.# 的死信佇列          : 0 則
     綁 order.created.vip 的佇列   : 1 則  ← 帶著原本的 routing key

  B（另外設了 x-dead-letter-routing-key = dead.b）
     綁 dead.# 的死信佇列          : 1 則  ← routing key 被覆寫成 dead.b
     綁 order.created.vip 的佇列   : 0 則
     被覆寫之後，原本的 key 還查得到嗎 : x-death.routing-keys = [order.created.vip]
```

⚠️ **A 那一列就是這個坑**：死信**沒有**進「你為死信準備的那個佇列」，
而是照原本的 routing key 又路由了一次。
**如果 DLX 上剛好沒有任何 binding 匹配 `order.created.vip`，那則訊息就第二次消失了。**

📌 **最後一行是好消息**：即使用了 B（覆寫 routing key），
**原本的 key 還留在 `x-death` 的 `routing-keys` 裡** ——
重放時要靠它知道放回哪裡（6.2.4 的 SOP）。

📌 **兩個防法**：

```java
// 防法 A：DLX 用 fanout —— 不管 routing key 是什麼都收得到（本章實驗用的）
@Bean FanoutExchange orderDlx() { return new FanoutExchange("order.dlx", true, false); }

// 防法 B：明確指定死信的 routing key
@Bean Queue mailQueue() {
    return QueueBuilder.durable("order.confirm-mail.q")
            .deadLetterExchange("order.dlx")
            .deadLetterRoutingKey("dead.confirm-mail")   // ← 覆寫掉原本的
            .build();
}
```

⚠️ **防法 B 有個副作用**：原本的 routing key **就查不到了**（只剩 `x-death` 裡的 `routing-keys` 欄位）。
重放時記得從那裡讀。

**坑二：死信佇列沒有綁到 DLX，訊息一樣消失。**

`x-dead-letter-exchange` 只是說「送到這個 exchange」。
[04 章 4.2.2](./04-rabbitmq-basics-and-topology.md)：**exchange 不存訊息，路由不到就丟掉。**
所以「設了 DLX 但沒建死信佇列 / 沒綁 binding」= **訊息還是消失了，而且你以為自己有保護**。

📌 **一定要驗**：故意讓一則訊息失敗，確認它真的出現在死信佇列裡。
本章的 6.2.1 就是這個驗證。

**坑三：無限循環。**

```
      主佇列  ──失敗──▶  DLX  ──▶  死信佇列
        ▲                                │
        └────────── 有人把死信佇列的 DLX 設回主佇列 ─┘
```

⚠️ **這比 00 章那個 `requeue=true` 更難查**，因為它會繞得比較慢（要過 broker 兩次），
看起來像是「訊息偶爾重複」。

📌 **防法：死信佇列不要有 DLX**，而 6.3.2 那種「retry 佇列繞回主佇列」的設計
**一定要有次數上限**（用 `x-death` 的 `count`）。

---

## 6.3 重試退避的兩種做法 ★★

6.2 讓失敗的訊息有地方去了。但**大多數失敗是暫時性的** ——
下游服務重啟中、資料庫連線池滿了、第三方 API 限流。
**這些你想重試，不想直接丟進死信。**

RabbitMQ 世界裡有兩種做法，而它們的差別**不是風格問題**。

### 6.3.1 本地重試：退避階梯，以及它卡住了誰

Spring AMQP 內建一個重試攔截器：

```yaml
spring:
  rabbitmq:
    listener:
      simple:
        retry:
          enabled: true
          max-attempts: 4
          initial-interval: 1s
          multiplier: 2
          max-interval: 10s
```

```java
package com.example.lab11.ch06;

@SpringBootTest
class H2RetryStrategiesTest {

    @Test
    void localRetryBlocksTheConsumerThread() {
        // 1 則毒藥訊息 + 20 則正常訊息，consumer concurrency = 1
        rabbit.convertAndSend("", Q, "POISON");
        for (int i = 0; i < 20; i++) rabbit.convertAndSend("", Q, "good-" + i);

        var backoff = new ExponentialBackOffPolicy();
        backoff.setInitialInterval(1000);
        backoff.setMultiplier(2.0);

        SimpleMessageListenerContainer c = new SimpleMessageListenerContainer(cf);
        c.setPrefetchCount(1);
        c.setConcurrentConsumers(1);
        c.setDefaultRequeueRejected(false);
        c.setAdviceChain(RetryInterceptorBuilder.stateless()
                .maxAttempts(4)
                .backOffPolicy(backoff)
                .recoverer(new RejectAndDontRequeueRecoverer())   // 重試用完 → 進死信
                .build());
        // ... 記錄每一次嘗試的時間點，以及那 20 則正常訊息什麼時候被處理
    }
}
```

**輸出**：

```
═══ 6.3.1 本地重試：退避階梯，以及它卡住了誰 ═══
  1 則毒藥訊息 + 20 則正常訊息，consumer concurrency = 1
  重試設定：最多 4 次、初始 1 秒、乘數 2（1s → 2s → 4s）

  ── 毒藥訊息的重試時間點（毫秒，從開始算）──
     第 1 次嘗試 :     23 ms
     第 2 次嘗試 :  1,028 ms   （距上一次 1,005 ms）
     第 3 次嘗試 :  3,033 ms   （距上一次 2,005 ms）
     第 4 次嘗試 :  7,037 ms   （距上一次 4,004 ms）

  ── 那 20 則「正常」訊息呢 ──
     第 1 則正常訊息被處理的時間 : 7,045 ms
     最後 1 則                  : 7,056 ms
     ⚠️ 一則壞訊息，讓 20 則好訊息整整等了 7,045 ms
     死信佇列 : 1 則
```

📌 **退避階梯是準的**：1,005 ms → 2,005 ms → 4,004 ms，完全符合 `initial=1s, multiplier=2`。

⚠️ **但看下面那三行。**

**那 20 則完全正常的訊息，第一則在 7,045 ms 才被處理。**

**原因**：`spring.rabbitmq.listener.simple.retry` 是**本地**重試 ——
它用 `Thread.sleep` 把**消費者執行緒**停住，訊息從頭到尾沒有回到 broker。

```
  消費者執行緒（只有一條）
    │
    ├─ 拿到 POISON → 失敗 → sleep(1s) → 再試 → 失敗 → sleep(2s) → 再試 → 失敗 → sleep(4s) → 放棄
    │                └──────────────── 這 7 秒裡，它什麼別的事都沒做 ────────────────┘
    │
    └─ 現在才開始處理 good-0 …
```

📌 **算一下正式環境的代價**：
退避設到 `max-interval: 5min`、`max-attempts: 6`，那是**最多 15 分鐘**。
一個 `concurrency: 4` 的服務遇到 4 則毒藥訊息 → **整個服務停擺 15 分鐘**，
而監控上看到的是「積壓一直漲、消費者還在、沒有錯誤率暴增」。

⚠️ **還有一個更隱蔽的問題**：那 7 秒裡，`unacked` 一直是 1
（[05 章 5.3.2](./05-rabbitmq-reliability.md) 那個「卡住」的指紋）。
如果退避超過 `consumer_timeout`（本站 30 分鐘，
[01 章 1.5.1](./01-reliable-delivery-three-hops.md)），**channel 會被 broker 砍掉**。

### 6.3.2 死信回送：同樣的退避，但不卡住消費者

把「等待」交給 broker：訊息失敗 → 死信到一個**有 TTL 的重試佇列** →
TTL 到了 → 從重試佇列死信**回主佇列**。

```
   ┌──────────────┐  失敗(nack requeue=false)  ┌──────────────┐
   │   main.q     │ ─────────────────────────▶ │   retry.x    │
   │              │                            └──────┬───────┘
   │              │                                   ▼
   │              │                            ┌──────────────┐
   │              │                            │  retry.q     │ TTL = 1s
   │              │                            │ （沒有消費者）│ 訊息在這裡躺著
   │              │      TTL 到期 → 死信        └──────┬───────┘
   │              │ ◀─────────────────────────────────┘
   └──────────────┘
```

```java
    @Test
    void deadLetterRoundTripDoesNotBlock() {
        // 主佇列：失敗 → 死信到 retry.x
        admin.declareQueue(QueueBuilder.durable(mainQ)
                .deadLetterExchange(retryX).deadLetterRoutingKey("retry").build());
        // 重試佇列：躺 1 秒，過期之後死信「回主 exchange」
        admin.declareQueue(QueueBuilder.durable(retryQ)
                .ttl(1000)
                .deadLetterExchange(mainX).deadLetterRoutingKey("main")
                .build());

        c.setDefaultRequeueRejected(false);
        c.setMessageListener(m -> {
            if (body.equals("POISON")) {
                int deaths = deathCount(m);                 // ← 從 x-death 讀重試次數
                if (deaths >= 3) {                          // 重試夠了 → 送去停放區
                    rabbit.convertAndSend(parkX, "", m);
                    return;                                  // 正常回傳 = ack，不再重試
                }
                throw new RuntimeException("下游 500");
            }
            // 正常訊息
        });
    }
```

**輸出**：

```
═══ 6.3.2 死信回送：同樣的退避，但不卡住消費者 ═══

  ── 毒藥訊息 ──
     第 1 次投遞 @ 34 ms（x-death count=0）
     第 2 次投遞 @ 1,049 ms（x-death count=1）
     第 3 次投遞 @ 2,058 ms（x-death count=2）
     第 4 次投遞 @ 3,069 ms（x-death count=3）

  ── 那 20 則「正常」訊息呢 ──
     第 1 則正常訊息被處理的時間 : 45 ms
     最後 1 則                  : 57 ms
     ✅ 正常訊息完全沒有被毒藥訊息卡住
     停放佇列 : 1 則
```

📌 **`45 ms` vs `7,045 ms`。同樣的退避階梯，差了 156 倍。**

📌 **而 `x-death count` 就是你的重試計數器**：0 → 1 → 2 → 3。
[01 章 1.5.1 ③](./01-reliable-delivery-three-hops.md) 說
「`redelivered` 旗標與重試計數，06 章會用到」—— 就是這裡。

⚠️ **這裡的 `deathCount()` 讀的是 `x-death[0].count`，而它在這個設計下是對的** ——
因為只有**一個** retry 佇列，所以 `x-death` 永遠只有兩個元素、`count` 一起往上加。
📌 **一旦你把它擴成「每一級一個佇列」（6.3.3 那張階梯表），這個讀法就會壞掉。**
👉 **6.9.2 會把兩種寫法的差別量出來**，並給出通用的讀法。

⚠️ **注意 `redelivered` 跟 `x-death count` 不是同一件事**：

| | 是什麼 | 能不能當重試次數 |
|---|---|---|
| `redelivered` | **布林值**：這則訊息是不是重送的 | ❌ **不能**。它只有 true/false，重送 1 次跟 500 次都一樣 |
| `x-death` 的 `count` | **整數**：在某個佇列上死過幾次 | ✅ 可以，但**只有走過 DLX 的訊息才有** |

📌 **所以「重試三次就放棄」這件事，靠 `redelivered` 是做不到的。**
你需要 ① 走 DLX 拿 `x-death.count`、
② 或用 quorum queue 的 `x-delivery-limit`（6.6.2，最省事）、
③ 或自己在訊息 header 上放一個計數器（⚠️ 要記得每次重送都要加）。

### 6.3.3 兩種做法怎麼選

| | **本地重試**（`listener.simple.retry`） | **死信回送**（retry 佇列 + TTL） |
|---|---|---|
| 設定複雜度 | **五行 YAML** | 三個 exchange、三個佇列、一段計數邏輯 |
| 會卡住消費者嗎 | ⚠️ **會**（實測 7,045 ms） | ✅ 不會（實測 45 ms） |
| 重試期間訊息在哪 | **消費者的記憶體裡**（`unacked`） | broker 的 retry 佇列（看得到、數得出來） |
| 服務重啟會怎樣 | ⚠️ **重試進度全部歸零** | ✅ 訊息在 broker 上，不受影響 |
| 退避可以多長 | ⚠️ 受 `consumer_timeout` 限制（本站 30 分鐘） | **可以到幾小時**（TTL 沒有這個限制） |
| 退避階梯的彈性 | 一條公式（指數退避） | **每一級一個佇列，可以任意設**（6.4.2） |
| 觀測性 | ⚠️ 看不到「有幾則在重試中」 | ✅ **retry 佇列的深度就是答案** |

📌 **本站的建議**：

> **退避總長 < 30 秒，而且你的消費者有餘裕 → 本地重試。**
> 它的設定成本是五行，而五行能解決的事不要用六個元件去解決。
>
> **退避總長 > 30 秒，或流量大到「停 7 秒」就會積壓 → 死信回送。**
>
> ⚠️ **「總長」要算 `initial × (1 + m + m² + …)`，不是 `max-interval`。**
> `initial=1s, multiplier=2, max-attempts=6` 的總長是
> `1+2+4+8+16 = 31 秒` —— 已經超線了。

**一個常見的退避階梯**（死信回送版，三級）：

| 級數 | retry 佇列的 TTL | 累計延遲 | 適合擋什麼 |
|---|---|---|---|
| 1 | 5 秒 | 5 秒 | 瞬間的連線抖動、鎖競爭 |
| 2 | 1 分鐘 | 約 1 分鐘 | 下游滾動更新中 |
| 3 | 10 分鐘 | 約 11 分鐘 | 下游整個掛了、在等人處理 |
| 用完 | —— | —— | **進死信佇列（停放區），等人看** |

⚠️ **不要設超過 4 級。** 超過那個之後，「自動重試」跟「放著等人看」的差別已經不大了，
而你多了三個佇列要維護。

### 6.3.4 ⚠️ `requeue=true` 的無窮迴圈，最後講一次

[00 章 0.5.2](./00-course-map-why-message-queue.md) 那個 11,191 次，
根源是 Spring AMQP 的預設 `default-requeue-rejected=true`：

```
  消費者丟例外 → Spring nack(requeue=true) → broker 把訊息放回佇列「最前面」
              → 立刻又送給同一個消費者 → 又丟例外 → …
              └─── 這個迴圈裡沒有任何一個 sleep ───┘
```

📌 **它跟 6.3.1 的本地重試的差別，就是那個「沒有 sleep」。**

| | 有退避嗎 | 有次數上限嗎 | 結果 |
|---|---|---|---|
| `requeue=true`（預設） | ❌ | ❌ | **每秒 3,730 次，永遠** |
| 本地重試 | ✅ | ✅ | 卡住消費者 7 秒，然後進死信 |
| 死信回送 | ✅ | ✅（`x-death.count`） | 不卡住任何人 |
| quorum + `x-delivery-limit` | ⚠️ 沒有退避 | ✅ | **4 次就進死信**（6.6.2） |

⚠️ **`requeue=true` 唯一合理的用法**：

```java
catch (TransientException e) {
    channel.basicNack(tag, false, true);    // 只有這一種，而且要有別的機制擋次數
}
```

**「只有確定是暫時性、而且有別的東西擋住次數」才可以。**
在其他任何情況下，`default-requeue-rejected` 都應該是 `false`。

📌 **本站的預設立場**：

```yaml
spring:
  rabbitmq:
    listener:
      simple:
        default-requeue-rejected: false     # ⚠️ 必須配 DLX，否則失敗的訊息直接消失
```

---

## 6.4 延遲佇列 ★★

[00 章 0.4.4](./00-course-map-why-message-queue.md) 那張表有一列：

| 需求 | 選哪個 | 為什麼 |
|---|---|---|
| 「延遲 30 分鐘後檢查未付款訂單」 | **RabbitMQ** | TTL + DLX 或延遲外掛，**一行設定**（06 章）。Kafka 要自己做時間輪 |

**這一節兌現它，也要把那「一行設定」的代價講清楚。**

### 6.4.1 ⚠️ TTL + DLX 的致命缺陷：head-of-line blocking

**原理**（6.3.2 已經用過同一招）：
做一個**沒有消費者**的「等待佇列」，訊息在裡面躺到 TTL 到期，
過期之後死信到目標 exchange —— **對下游來說就是「延遲送達」**。

```java
package com.example.lab11.ch06;

@SpringBootTest
class H3DelayTest {

    @Test
    void perMessageTtlHasHeadOfLineBlocking() {
        // 等待佇列：沒有消費者，訊息過期就死信到 targetX
        admin.declareQueue(QueueBuilder.durable(delayQ).deadLetterExchange(targetX).build());

        // 先送「延遲 8 秒」，再送「延遲 1 秒」
        rabbit.convertAndSend("", delayQ, "A-延遲8秒", m -> {
            m.getMessageProperties().setExpiration("8000"); return m; });
        rabbit.convertAndSend("", delayQ, "B-延遲1秒", m -> {
            m.getMessageProperties().setExpiration("1000"); return m; });
        // ... 記錄兩則訊息各自在幾毫秒抵達目標佇列
    }
}
```

**輸出**：

```
═══ 6.4.1 TTL + DLX 做延遲佇列 —— 以及它的致命缺陷 ═══
  送出順序：A（延遲 8 秒）→ B（延遲 1 秒）
  期望：B 在 1 秒後到，A 在 8 秒後到

     A-延遲8秒 在 8,032 ms 到達
     B-延遲1秒 在 8,044 ms 到達
```

⚠️ **B 應該在 1 秒後到，實際上等到 8,044 ms。**

**原因**：**佇列是 FIFO 的，broker 只看隊首那一則有沒有過期。**

```
   等待佇列（FIFO）
   ┌──────────────┬──────────────┐
   │  A (TTL 8s)  │  B (TTL 1s)  │
   └──────┬───────┴──────────────┘
          │
   broker 只檢查隊首：A 還沒過期 → 什麼都不做
                     └─ B 早就過期了，但它不在隊首，broker 看不到
```

📌 **所以「每則訊息自己設 TTL」這個用法，只有在「所有訊息的 TTL 相同」時才正確。**

⚠️ **這個 bug 在測試時幾乎抓不到**，因為測試通常只送一則訊息、或送一堆相同延遲的訊息。
它在正式環境的形狀是：**「延遲任務有時候準，有時候晚了好幾十分鐘」**。

### 6.4.2 繞法一：每一級延遲一個佇列

**把「每則訊息的 TTL」換成「佇列的 TTL」** —— 同一個佇列裡的訊息 TTL 都一樣，FIFO 就不會互卡。

```java
    @Test
    void queueLevelTtlIsSafeButFixed() {
        int[] levels = {1000, 3000, 6000};
        for (int lv : levels)
            admin.declareQueue(QueueBuilder.durable("ch06.lad.wait." + lv + ".q")
                    .ttl(lv)                      // ← 佇列層級的 TTL
                    .deadLetterExchange(targetX).build());

        // 故意「大的先送」，看會不會互卡
        rabbit.convertAndSend("", "ch06.lad.wait.6000.q", "C-第三級6秒");
        rabbit.convertAndSend("", "ch06.lad.wait.3000.q", "B-第二級3秒");
        rabbit.convertAndSend("", "ch06.lad.wait.1000.q", "A-第一級1秒");
    }
```

**輸出**：

```
═══ 6.4.2 佇列層級 TTL：每一級一個佇列 ═══
  三個等待佇列（TTL 1s / 3s / 6s），送出順序：6s → 3s → 1s

     A-第一級1秒 在 1,008 ms 到達
     B-第二級3秒 在 3,008 ms 到達
     C-第三級6秒 在 6,007 ms 到達
```

✅ **三則都準時，而且送出順序完全不影響。**

📌 **這就是 6.3.3 那個「退避階梯」為什麼要「每一級一個佇列」** ——
不是為了好看，是因為**混在同一個佇列裡會互卡**。

⚠️ **它的限制**：**延遲的級數是固定的**。
你只能提供 5 秒 / 1 分 / 10 分 / 30 分這幾種，
沒辦法做到「這一則延遲 7 分 23 秒」。

📌 **但實務上這幾乎不是問題** —— 業務需求通常是「30 分鐘後檢查未付款」，
不是「7 分 23 秒後」。**先問清楚需求，再決定要不要裝外掛。**

### 6.4.3 繞法二：delayed-message 外掛

如果真的需要任意延遲，有一個由 RabbitMQ 團隊維護、但**沒有內建在映像裡**的外掛：

```bash
# 它不在映像裡，要自己下載（GitHub release）並放進 plugins 目錄
curl -L -o rabbitmq_delayed_message_exchange.ez \
  https://github.com/rabbitmq/rabbitmq-delayed-message-exchange/releases/download/v3.13.0/rabbitmq_delayed_message_exchange-3.13.0.ez
docker cp rabbitmq_delayed_message_exchange.ez rabbit-lab:/opt/rabbitmq/plugins/
docker exec rabbit-lab rabbitmq-plugins enable rabbitmq_delayed_message_exchange
```

```
The following plugins have been enabled:
  rabbitmq_delayed_message_exchange
started 1 plugins.
```

⚠️ **本節跑完記得關掉它**（跟 [01 章 1.9.2 練習四](./01-reliable-delivery-three-hops.md)
提醒你把 `consumer_timeout` 刪掉是同一個理由：**不要讓一個實驗的環境改動留給下一個實驗**）：

```bash
docker exec rabbit-lab rabbitmq-plugins disable rabbitmq_delayed_message_exchange
```

⚠️ **關掉之前，先確認沒有佇列還綁在 `x-delayed-message` 型的 exchange 上** ——
外掛一關，那種 exchange 就變成「未知型別」，**對它 publish 會讓 channel 被關掉**。

```java
    @Test
    void delayedMessagePluginHasNoHeadOfLineBlocking() {
        // 一種新的 exchange 型別：x-delayed-message
        Map<String, Object> args = Map.of("x-delayed-type", "direct");
        admin.declareExchange(new CustomExchange("ch06.dmx", "x-delayed-message", true, false, args));

        rabbit.convertAndSend("ch06.dmx", "go", "A-延遲8秒", m -> {
            m.getMessageProperties().setHeader("x-delay", 8000); return m; });
        rabbit.convertAndSend("ch06.dmx", "go", "B-延遲1秒", m -> {
            m.getMessageProperties().setHeader("x-delay", 1000); return m; });
    }
```

**輸出**：

```
═══ 6.4.3 delayed-message 外掛：同樣的兩則訊息 ═══
  送出順序：A（x-delay=8000）→ B（x-delay=1000）

     B-延遲1秒 在 1,010 ms 到達
     A-延遲8秒 在 8,010 ms 到達

  ── 延遲中的訊息，在管理介面上看得到嗎 ──
     送了一則延遲 30 秒的訊息之後，佇列 ch06.dmx.q 的積壓 = 0
     ⚠️ 它在 exchange 裡，不在任何佇列裡 —— 你看不到、也撈不出來
```

✅ **B 在 1,010 ms、A 在 8,010 ms。head-of-line blocking 沒有了。**

⚠️ **但看最後兩行，那是它的代價。**

📌 **delayed-message 外掛的四個代價，每一個都值得知道**：

| 代價 | 說明 |
|---|---|
| **① 訊息在 exchange 裡，不在佇列裡** | 「還有多少延遲任務待觸發」這個問題**答不出來**。積壓永遠是 0 |
| **② 撈不出來、取消不了** | 「這張訂單已經付款了，取消那個 30 分鐘後的檢查」—— **做不到**。只能讓它觸發，然後在消費端判斷 |
| **③ 不是 broker 核心的一部分** | 它單獨發版，**升級 broker 大版本時要確認它有對應版本**。託管服務（CloudAMQP 之類）不一定給你裝 |
| **④ 延遲的訊息存在 Mnesia 裡** | 大量長延遲的訊息會**吃 broker 的記憶體與磁碟**，而且那部分不受佇列的長度上限保護 |

### 6.4.4 三種做法的對照，與「30 分鐘檢查未付款訂單」的落地

| | 每則 TTL + DLX | **佇列 TTL 階梯 + DLX** | delayed-message 外掛 |
|---|---|---|---|
| 延遲的精細度 | 任意 | **固定幾級** | 任意 |
| head-of-line blocking | ⚠️ **有**（實測 8,044 ms） | ✅ 沒有 | ✅ 沒有 |
| 看得到「有多少在等」 | ✅ 等待佇列的深度 | ✅ | ❌ **看不到** |
| 可以取消 / 撈出來嗎 | ⚠️ **理論上可以**（訊息在等待佇列裡），但要找出**特定一則**得把整個佇列翻過一遍 | ⚠️ 同左 | ❌ **完全不行**（訊息在 exchange 裡） |
| 需要裝外掛 | ❌ | ❌ | ✅ |
| 託管服務支援 | ✅ 一定有 | ✅ 一定有 | ⚠️ 不一定 |

📌 **本站的建議：預設用「佇列 TTL 階梯」。**
它不需要外掛、**看得到**（等待佇列的深度就是「有多少在等」），
而**「固定幾級」在絕大多數業務需求下都夠用**。

⚠️ **「看得到」這一欄比看起來重要**：
延遲佇列出事的時候（例如 TTL 設錯、DLX 綁錯），
**你要能回答「現在有多少任務在等、最舊的那則等多久了」** ——
TTL 版本一個 `list_queues` 就有答案，外掛版本**完全問不到**。

**兌現 [00 章 0.4.4](./00-course-map-why-message-queue.md) 那個承諾**：

```java
@Configuration
public class PaymentCheckTopology {

    /** 訂單成立時送進這裡，30 分鐘後自動流到 order.payment-check.q */
    @Bean Queue paymentCheckWait() {
        return QueueBuilder.durable("order.payment-check.wait.q")
                .quorum()                                      // 6.6.4
                .ttl(30 * 60 * 1000)                           // ← 30 分鐘
                .deadLetterExchange("order.payment-check.x")   // ← 時間到就流到這裡
                // ⚠️ 等待佇列會長到「30 分鐘的下單量」那麼大，一定要設上限
                .maxLength(500_000L)
                .overflow(QueueBuilder.Overflow.rejectPublish) // 05 章 5.2.3
                .build();
    }

    @Bean FanoutExchange paymentCheckX() {
        return new FanoutExchange("order.payment-check.x", true, false);
    }

    @Bean Queue paymentCheckQ() { return QueueBuilder.durable("order.payment-check.q").build(); }

    @Bean Binding paymentCheckBinding() {
        return BindingBuilder.bind(paymentCheckQ()).to(paymentCheckX());
    }
}
```

```java
// 下單時
rabbit.convertAndSend("", "order.payment-check.wait.q", new PaymentCheck(orderId));

// 30 分鐘後
@RabbitListener(queues = "order.payment-check.q")
public void checkPayment(PaymentCheck cmd) {
    Order order = orders.findById(cmd.orderId()).orElse(null);
    if (order == null) return;                       // 訂單被刪了
    if (order.getStatus() != Status.PENDING) return; // ⚠️ 已經付款了 → 什麼都不做
    orderService.cancelUnpaid(order);
}
```

⚠️ **那個 `if (order.getStatus() != PENDING) return;` 不是防禦性程式碼，是必要的設計。**

**因為延遲訊息一旦送出去就取消不了**（外掛版取消不了，TTL 版理論上可以撈但沒人會這樣做）。
📌 **所以延遲訊息的正確語意是「到時候去檢查一下」，不是「到時候去取消訂單」** ——
**判斷要在消費端做，不是在送出端做。**

⚠️ **這跟 [03 章](./03-idempotent-consumer.md) 的冪等是同一個形狀**：
那個 `if` 讓「這則訊息跑一次跟跑十次結果一樣」。

---

## 6.5 優先級佇列

### 6.5.1 訊息還在佇列裡的時候，優先級是有效的

```java
package com.example.lab11.ch06;

@SpringBootTest
class H4PriorityTest {

    void fill() {
        admin.declareQueue(QueueBuilder.durable(Q).maxPriority(10).build());   // ← 宣告時就要設
        for (int i = 0; i < 100; i++)
            rabbit.convertAndSend("", Q, "LOW-" + i, m -> { m.getMessageProperties().setPriority(1); return m; });
        for (int i = 0; i < 10; i++)
            rabbit.convertAndSend("", Q, "HIGH-" + i, m -> { m.getMessageProperties().setPriority(9); return m; });
    }
}
```

**輸出**：

```
═══ 6.5.1 優先級佇列：訊息還在佇列裡的時候 ═══
  先送 100 則 priority=1，再送 10 則 priority=9，然後才接上消費者

  ── prefetch = 1 ──
     前 12 則處理的是 : HIGH-0, HIGH-1, ..., HIGH-9, LOW-0, LOW-1
     10 則 HIGH 的名次 : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]   ✅ 優先級有效

  ── prefetch = 250 ──
     前 12 則處理的是 : HIGH-0, HIGH-1, ..., HIGH-9, LOW-0, LOW-1
     10 則 HIGH 的名次 : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]   ✅ 優先級有效
```

📌 **後送的 10 則高優先級訊息，全部插到 100 則前面。而且 prefetch 不影響這個結果。**

### 6.5.2 ⚠️ 但它超不了「已經送出去的」那些

把場景換成現實的樣子：**消費者早就連上了，而高優先級的訊息是後來才進來的。**

```java
    @Test
    void priorityCannotJumpMessagesAlreadyDelivered() {
        // 先灌 300 則 LOW，先接上消費者（每則 20 ms），讓它跑 1.5 秒
        c.start();
        sleep(1500);
        // 現在才送高優先級的
        rabbit.convertAndSend("", Q, "URGENT", m -> { m.getMessageProperties().setPriority(9); return m; });
    }
```

**輸出**：

```
═══ 6.5.2 優先級超不了「已經送出去的」那些 ═══
  這次先接消費者（每則 20 ms），讓它先拿走一批 LOW，然後才送 HIGH

  ── prefetch = 1 ──
     送 URGENT 的時候，已經處理了 59 則
     URGENT 排在第 61 名
     → 它在送出之後，又等了 1 則 LOW 才被處理   ✅

  ── prefetch = 250 ──
     送 URGENT 的時候，已經處理了 64 則
     URGENT 排在第 301 名
     → 它在送出之後，又等了 236 則 LOW 才被處理   ❌ 先送出去的那批 LOW 超不了
```

⚠️ **`prefetch=250` 讓「緊急」訊息排在 236 則普通訊息後面。**

**原因**：優先級是**佇列內的排序**。
一旦訊息被送給消費者（進入 `unacked`），**它就不在佇列裡了**，
新來的高優先級訊息**沒有任何辦法插到它前面**。

📌 **所以「優先級佇列」跟 [05 章 5.4](./05-rabbitmq-reliability.md) 的 prefetch 是綁在一起的**：

> **優先級佇列要有效，prefetch 必須小。**
> `prefetch=1` → 緊急訊息最多等 1 則。
> `prefetch=250` → 緊急訊息最多等 250 則。

⚠️ 而 Boot 的預設是 250 —— **所以「設了優先級佇列但完全沒感覺」是很常見的狀況**。

### 6.5.3 優先級的三個限制

```
═══ 6.5.3 優先級的三個限制 ═══
  ① 佇列沒有宣告 x-max-priority，但訊息帶了 priority=9
     第一則被讀到的是 : LOW-0   ← priority 被完全忽略

  ② 佇列 x-max-priority=5，但訊息送 priority=99
     有丟例外嗎    : 沒有
     第一則被讀到的 : P99   ← 被夾到上限 5，仍然最優先

  ③ quorum queue 可以設 x-max-priority 嗎
     ❌ PRECONDITION_FAILED - invalid arg 'x-max-priority' for queue
        'ch06.prio.quorum.q' in vhost '/' of queue type rabbit_quorum_queue
```

📌 **三件事**：

| | 結論 |
|---|---|
| **① `x-max-priority` 是宣告時的參數** | 佇列沒設，訊息上的 `priority` 就是一個**被忽略的裝飾**，而且沒有任何警告。⚠️ 而它是[不可變參數](./04-rabbitmq-basics-and-topology.md)（04 章 4.6.5），要加只能走雙綁遷移 |
| **② 超過上限的值會被夾住，不會報錯** | 送 `priority=99` 到 `x-max-priority=5` 的佇列 → 當成 5 |
| **③ quorum queue 不支援優先級** | 6.6.3 有完整清單。⚠️ 這是選型時的硬限制 |

⚠️ **還有一個沒有出現在輸出裡的限制**：RabbitMQ 是**每一個優先級各維護一個子佇列**來實作它的，
所以 `x-max-priority` 設多少就有多少個子佇列，記憶體與 CPU 都會跟著上去。
**官方文件建議設個位數（1～5），不要設到協定允許的上限 255。**
⚠️ **本站沒有量這個成本**（單節點、訊息量小的環境量不出有意義的差別），
📌 **但你也不需要量** —— 因為**實務上兩級就夠了**（`0` = 一般、`1` = 緊急），
而且**兩級的語意比十級清楚太多**：沒有人分得出「優先級 6」跟「優先級 7」該給誰。

⚠️ **最後一個提醒：優先級不解決容量問題。**
如果你的消費者處理不完，高優先級訊息只是「比較快被處理不完」。
**優先級是用來處理「短暫的尖峰裡，哪些事不能等」，不是用來當作擴容的替代品。**

---

## 6.6 classic vs quorum queue ★★

[01 章 1.3.8 與 1.4.5](./01-reliable-delivery-three-hops.md) 兩張防守表上，
RabbitMQ 那一欄各有一格寫著「磁碟壞掉 → quorum queue，06 章」。**現在講它。**

**一句話的差別**：

| | **classic queue** | **quorum queue** |
|---|---|---|
| 資料放哪 | **一個節點**（除非用鏡像，而鏡像已淘汰，見 6.7） | **多個節點，用 Raft 共識** |
| 一台機器掛掉 | ⚠️ 那個佇列的訊息**不可用**（甚至遺失） | ✅ 其他節點接手，多數派還在就正常運作 |
| 從什麼版本開始有 | 一直都有 | 3.8（2019），**3.13 是預設建議** |

⚠️ **本站是單節點**（[00 章 0.9.3](./00-course-map-why-message-queue.md) 明確說了不教叢集架設），
所以下面量的是**單節點上的行為**，**不是**副本同步的成本。

### 6.6.1 實測：吞吐

```java
package com.example.lab11.ch06;

@SpringBootTest
class H5QuorumTest {

    @Test
    void classicVsQuorumThroughput() {
        admin.declareQueue(QueueBuilder.durable(q).quorum().build());   // ← 只差這個 .quorum()
        // ... 灌 20,000 則 × 200 bytes，再全部讀出來
    }
}
```

**輸出**：

```
═══ 6.6.1 classic vs quorum：吞吐與磁碟 ═══
  20,000 則 × 200 bytes，單節點

  佇列                     寫入耗時         吞吐（則/秒）        讀完耗時
  ch06.qq.classic.q           657 ms      30,441          498 ms
  ch06.qq.quorum.q            356 ms      56,180          364 ms

  ── broker 怎麼看這兩種佇列 ──
  name	type	durable	messages
  ch06.qq.classic.q	classic	true	0
  ch06.qq.quorum.q	quorum	true	0
```

⚠️ **quorum 比 classic 快。這跟大多數人的預期相反。**

📌 **但這個數字要小心解讀，它有一個很大的但書**：

> **這是單節點。** quorum queue 的「共識」在單節點上只需要它自己同意，
> 所以你量到的是**它的儲存引擎（Raft log，順序寫）比 classic 的訊息儲存更有效率**，
> **完全沒有量到副本同步的網路成本**。
>
> ⚠️ **三節點叢集上，quorum 的寫入一定比單節點 classic 慢** ——
> 因為每一則都要等多數派確認。
> **本站量不到那個數字**（不架叢集），所以不要拿這張表去論證「quorum 比較快」。

📌 **這張表能證明的只有一件事，但它很有用**：
**在單節點上把 classic 換成 quorum，吞吐不會變差。**
所以「怕慢」不是不用 quorum 的理由。

### 6.6.2 quorum 內建的毒藥訊息處理：`x-delivery-limit`

**這是本節最實用的東西。**

```java
    @Test
    void quorumHasBuiltInPoisonHandling() {
        admin.declareQueue(QueueBuilder.durable(q).quorum()
                .deliveryLimit(3)                 // ← 次數用完就自動進死信（實測是投遞 4 次，見下方）
                .deadLetterExchange(dlx)
                .build());

        c.setDefaultRequeueRejected(true);        // ⚠️ 故意用 00 章那個會造成風暴的設定
        c.setMessageListener(m -> {
            deliveries.incrementAndGet();
            throw new RuntimeException("下游 500");
        });
    }
```

**輸出**：

```
═══ 6.6.2 quorum queue 內建的 x-delivery-limit ═══
  第 1 秒：累計投遞 4 次
  第 2 秒：累計投遞 4 次
  第 3 秒：累計投遞 4 次

  ⚠️ 注意：這次用的是 default-requeue-rejected = TRUE
     （00 章 0.5.2 用同一個設定跑出 11,191 次）

  總投遞次數    : 4 次  ← x-delivery-limit 擋住了
  原佇列積壓     : 0 則
  死信佇列積壓   : 1 則
  死信上的 x-last-death-reason : delivery_limit
  x-delivery-count            : null
```

📌 **停下來看那個「注意」。**

**這一次用的是 `default-requeue-rejected = true`** ——
也就是 [00 章 0.5.2](./00-course-map-why-message-queue.md) 跑出 11,191 次的那個設定。
**在 quorum queue 上，同樣的設定只投遞了 4 次。**

| | classic + `requeue=true` | classic + `requeue=false` + DLX | **quorum + `x-delivery-limit=3`** |
|---|---|---|---|
| 投遞次數 | **11,191**（[00 章](./00-course-map-why-message-queue.md)） | **1**（6.2.1） | **4** |
| 需要設定什麼 | —— | `default-requeue-rejected: false` + DLX | **DLX + 一個數字** |
| 「重試 N 次才放棄」 | ❌ 做不到 | ⚠️ 要自己用 `x-death.count` 算（6.3.2） | ✅ **broker 幫你算** |

📌 **這就是 quorum queue 最值得的一點**：
**它把「重試次數」變成佇列的一個屬性，而不是你要寫的程式碼。**

6.3.2 那段 `deathCount(m)` 加上 `if (deaths >= 3)` 的邏輯，
在 quorum queue 上**可以整段刪掉**。

⚠️ **但要注意三件事**：

1. ⚠️ **`deliveryLimit(3)` 實測是投遞 4 次，不是 3 次。**
   📌 **設定值不等於投遞次數，請以你自己環境量到的為準** ——
   如果你的重試上限有合規或成本上的意義（例如「最多打第三方 API 三次」），
   **設下去之後一定要像這一節一樣量一次**。

2. **`x-delivery-limit` 沒有退避。** 那 4 次是**連續的**（三秒內就用完了）。
   📌 **它取代的是「次數上限」，不是「退避階梯」** ——
   如果你需要「等 1 分鐘再試」，還是要 6.3.2 那套 retry 佇列。
3. **死信上的 `x-delivery-count` 是 `null`**（實測）。
   計數在 broker 內部，**沒有寫到死信訊息的 header 上**。
   你只能從 `x-last-death-reason = delivery_limit` 知道「它是被次數上限踢出來的」。

### 6.6.3 quorum queue 不支援什麼

```java
    @Test
    void whatQuorumCannotDo() {
        // 一個一個試著宣告，記錄哪些被拒絕
    }
```

**輸出**：

```
═══ 6.6.3 quorum queue 不支援什麼 ═══
  x-max-priority=10            ❌ PRECONDITION_FAILED - invalid arg 'x-max-priority' for
                                  queue 'ch06.qq.f1.q' in vhost '/' of queue type rabbit_quorum_queue
  x-message-ttl=60000          ✅ 可以
  x-max-length=1000            ✅ 可以
  x-queue-mode=lazy            ❌ PRECONDITION_FAILED - invalid arg 'x-queue-mode' for
                                  queue 'ch06.qq.f4.q' in vhost '/' of queue type rabbit_quorum_queue
  x-single-active-consumer     ✅ 可以
  exclusive（非 durable）         ❌ PRECONDITION_FAILED - invalid property 'exclusive-owner'
                                  for queue 'ch06.qq.f6.q' in vhost '/'
  x-expires=600000             ✅ 可以
```

📌 **整理成一張決策表**：

| 功能 | quorum | 影響 |
|---|---|---|
| 死信交換器（6.2） | ✅ | —— |
| 訊息 TTL（6.4） | ✅ | **延遲佇列可以用 quorum** |
| 長度上限（[05 章 5.2.3](./05-rabbitmq-reliability.md)） | ✅ | —— |
| 單一活躍消費者（[05 章 5.5.5](./05-rabbitmq-reliability.md)） | ✅ | **順序敏感的佇列可以用 quorum** |
| 佇列閒置自動刪除（`x-expires`） | ✅ | —— |
| **`x-delivery-limit`** | ✅ **只有 quorum 有** | 6.6.2 |
| **優先級佇列（6.5）** | ❌ | ⚠️ **要優先級就只能用 classic** |
| **lazy mode** | ❌ | 沒差（[05 章 5.6.1](./05-rabbitmq-reliability.md)：lazy 在 3.13 上本來就沒作用） |
| **非持久化 / exclusive 佇列** | ❌ | quorum **一定是 durable 的**。臨時佇列（RPC 回覆用）只能 classic |

### 6.6.4 所以該用哪一種

📌 **RabbitMQ 官方從 3.8 開始的立場、也是本站的立場**：

> **預設用 quorum queue。**
> 只有在「需要優先級」或「需要臨時／非持久化佇列」時才用 classic。

| 你的佇列 | 用 | 理由 |
|---|---|---|
| 一般的業務佇列（訂單、通知、扣庫存） | **quorum** | 6.6.2 的 `x-delivery-limit` 本身就值得，而且單節點吞吐不吃虧 |
| 死信佇列 | **quorum** | 它裝的是你最不想弄丟的東西 |
| 延遲／retry 佇列（6.3、6.4） | **quorum** | TTL 支援 |
| **需要優先級的佇列** | **classic** | quorum 不支援（6.6.3） |
| RPC 回覆佇列、臨時佇列 | **classic**（`exclusive` + `autoDelete`） | quorum 不支援 |
| 「掉了也無所謂」的高頻資料 | **classic**（甚至 `durable=false`） | ⚠️ 但 `transient_nonexcl_queues` 已被標為淘汰（6.7） |

```java
@Bean Queue orderMailQueue() {
    return QueueBuilder.durable("order.confirm-mail.q")
            .quorum()                                       // ← 本站的預設
            .deliveryLimit(5)                               // ← 6.6.2，取代一半的重試程式碼
            .deadLetterExchange("order.dlx")                // ← 6.2
            .maxLength(1_000_000L)
            .overflow(QueueBuilder.Overflow.rejectPublish)  // ← 05 章 5.2.3
            .build();
}
```

⚠️ **`x-queue-type` 是不可變參數**（[04 章 4.6.5](./04-rabbitmq-basics-and-topology.md)）。
**既有的 classic 佇列換成 quorum，必須走 [04 章 4.6.4](./04-rabbitmq-basics-and-topology.md)
那個「新名字 → 雙綁 → 排乾 → 刪」的六步流程**，而它的前提是消費者已經冪等。

---

## 6.7 鏡像佇列：一個你不該碰的歷史包袱

**在 quorum queue 出現之前**（RabbitMQ 3.8，2019 年），
classic queue 要做高可用只有一個辦法：**鏡像佇列（classic queue mirroring）**，
用一條 policy 打開：

```bash
docker exec rabbit-lab rabbitmqctl set_policy ha-all "^ch06\.mirror\." \
  '{"ha-mode":"all"}' --apply-to queues
```

**broker 收下了這條 policy，但同時在日誌裡寫了這個**：

```
[warning] Deprecated features: `classic_queue_mirroring`: Classic mirrored queues are deprecated.
[warning] To continue using classic mirrored queues when they are not permitted by default,
[warning] set the following parameter in your configuration:
[warning]     "deprecated_features.permit.classic_queue_mirroring = true"
```

**而且它在淘汰清單上**（[05 章 5.6.1](./05-rabbitmq-reliability.md) 那張表）：

```bash
docker exec rabbit-lab rabbitmq-diagnostics -q list_deprecated_features
```

```
name	deprecation_phase
classic_queue_mirroring	permitted_by_default      ← 現在還能用，但已經在淘汰流程上
global_qos	permitted_by_default
management_metrics_collection	permitted_by_default
ram_node_type	permitted_by_default
transient_nonexcl_queues	permitted_by_default
```

📌 **`permitted_by_default` 的意思是「現在預設還允許，但下一階段會變成預設禁止」。**
**RabbitMQ 4.0 已經把它移除了。**

⚠️ **鏡像佇列被淘汰的原因不是「有更好的東西」，是它本身的設計有問題**：

| 問題 | 說明 |
|---|---|
| **腦裂時會丟訊息** | 網路分區之後兩邊各自接受寫入，合併時**其中一邊的訊息直接丟掉**（`ha-sync-mode` 那一堆設定都是在繞這件事） |
| **同步是「全有全無」的** | 新增一個鏡像節點時要把**整個佇列**複製過去，期間**佇列不可用**。一個 500 萬則的佇列可以卡好幾分鐘 |
| **沒有共識演算法** | 「誰是主」是靠選舉 + Mnesia，沒有 Raft 那種嚴謹的保證 |

📌 **quorum queue 就是為了修掉這三件事而生的**，它用 Raft：
寫入要多數派確認、節點加入是增量同步、主節點選舉有嚴格的安全性保證。

⚠️ **你會遇到它的唯一場景**：接手一個 2019 年之前建的系統，
看到一條 `ha-mode: all` 的 policy。

📌 **那時候該做的事**：

1. `rabbitmq-diagnostics list_deprecated_features --used` 確認它真的在用。
2. 把那些佇列走 [04 章 4.6.4](./04-rabbitmq-basics-and-topology.md) 的流程遷成 quorum。
3. 清掉那條 policy：`rabbitmqctl clear_policy ha-all`。

⚠️ **不要只是「刪掉 policy」**。那會讓那些佇列從「有鏡像」變成「單節點、沒有任何副本」，
**可用性反而更差**。要先遷到 quorum，再清 policy。

---

## 6.8 維運：四個該記住的診斷指令

[00 章 0.6.1](./00-course-map-why-message-queue.md) 說過「06 章會用到
`rabbitmq-diagnostics check_running`、`check_port_connectivity`、`memory_breakdown`」。

```bash
docker exec rabbit-lab rabbitmq-diagnostics -q check_running
```

```
RabbitMQ on node rabbit@61f378798135 is fully booted and running
```

📌 **這是 readiness probe 該用的指令**，而不是「port 5672 通不通」——
broker 在啟動期間 port 是開的但還不能服務。

```bash
docker exec rabbit-lab rabbitmq-diagnostics -q check_port_connectivity
```

```
Will connect to 61f378798135:15672
Will connect to 61f378798135:15692
Will connect to 61f378798135:25672
Will connect to 61f378798135:5672
Successfully connected to ports 5672, 15672, 15692, 25672 on node rabbit@61f378798135
```

📌 **它會把所有監聽的 port 都測一次**（AMQP 5672、管理介面 15672、
Prometheus 15692、叢集用的 25672）。
⚠️ **`25672` 那個是節點之間通訊用的** —— 叢集問題有一半是它被防火牆擋住。

```bash
docker exec rabbit-lab rabbitmq-diagnostics -q check_local_alarms
```

```
Node rabbit@61f378798135 reported no local alarms
```

⚠️ **這是最該監控的一個。** RabbitMQ 的「alarm」是它的**流控機制**：
記憶體或磁碟超過門檻時，broker 會**擋住所有生產者**（`connection.blocked`）。
📌 **症狀是「生產者全部卡住，但 broker 是活著的」** ——
如果你沒查過 alarm，這個故障會非常難懂。

```bash
docker exec rabbit-lab rabbitmq-diagnostics -q memory_breakdown
```

```
reserved_unallocated: 0.1453 gb (53.33%)
code: 0.0359 gb (13.16%)
quorum_ets: 0.0272 gb (9.97%)
other_system: 0.0266 gb (9.76%)
other_proc: 0.0192 gb (7.06%)
binary: 0.0116 gb (4.26%)
other_ets: 0.003 gb (1.08%)
plugins: 0.0019 gb (0.69%)
...
queue_procs: 0.0001 gb (0.03%)
connection_readers: 0.0 gb (0.0%)
```

📌 **記憶體告警響的時候，這個指令直接告訴你是誰吃掉的**：

| 項目 | 代表什麼 | 大的時候該做什麼 |
|---|---|---|
| `queue_procs` | 佇列裡的訊息 | 積壓太多 → 擴消費者、加長度上限（[05 章 5.6.2](./05-rabbitmq-reliability.md)） |
| `binary` | 訊息內容本身 | 訊息太大 → 考慮只送 ID，內容放物件儲存 |
| `connection_readers` / `connection_writers` | 連線 | **連線太多** → ⚠️ 通常是有人每送一則訊息就開一條新連線 |
| `quorum_ets` | quorum queue 的索引 | quorum 佇列很多或很長 |
| `mgmt_db` | 管理介面的統計資料 | ⚠️ **大量短命佇列**會把它撐爆（`management_metrics_collection` 在淘汰清單上就是這個原因） |
| `reserved_unallocated` | Erlang 配置器保留但沒用的 | **不是洩漏**，正常現象 |

⚠️ **`connection_readers` 那一列值得特別提**：
RabbitMQ 的連線很貴（每條一組 Erlang 行程 + TCP buffer）。
**「每送一則訊息開一條連線」是最常見的效能事故**，
而 Spring 的 `CachingConnectionFactory` 預設就會幫你重用，
📌 **除非有人自己 `new ConnectionFactory()`（就像本站所有實驗那樣 —— 那是為了控制連線何時斷，不要照抄到正式程式）。**

---

## 6.9 落地：RabbitMQ 三章的完整拓撲

**把 04、05、06 三章的結論合成一份可以直接用的設定。**

```java
@Configuration
public class OrderTopology {

    public static final String X       = "order.x";
    public static final String DLX     = "order.dlx";
    public static final String RETRY_X = "order.retry.x";

    // ── exchange（04 章 4.3：事件用 topic）──
    @Bean TopicExchange orderExchange()  { return ExchangeBuilder.topicExchange(X).durable(true).build(); }
    @Bean FanoutExchange orderDlx()      { return new FanoutExchange(DLX, true, false); }   // 6.2.5 坑一
    @Bean DirectExchange orderRetryX()   { return ExchangeBuilder.directExchange(RETRY_X).durable(true).build(); }

    // ── 業務佇列 ──
    @Bean Queue mailQueue() {
        return QueueBuilder.durable("order.confirm-mail.q")
                .quorum()                                        // 6.6.4
                .deliveryLimit(5)                                // 6.6.2：取代重試計數的程式碼
                .deadLetterExchange(RETRY_X)                     // 失敗 → 進退避階梯
                .deadLetterRoutingKey("retry.5s")
                .maxLength(1_000_000L)
                .overflow(QueueBuilder.Overflow.rejectPublish)   // 05 章 5.2.3
                .build();
    }

    @Bean Binding mailBinding() {
        return BindingBuilder.bind(mailQueue()).to(orderExchange()).with("order.created.#");
    }

    // ── 退避階梯（6.3.3、6.4.2：每一級一個佇列）──
    @Bean Queue retry5s()  { return retryQueue("order.retry.5s.q",  5_000); }
    @Bean Queue retry1m()  { return retryQueue("order.retry.1m.q",  60_000); }
    @Bean Queue retry10m() { return retryQueue("order.retry.10m.q", 600_000); }

    private Queue retryQueue(String name, int ttlMs) {
        return QueueBuilder.durable(name)
                .quorum()
                .ttl(ttlMs)                     // 躺這麼久
                .deadLetterExchange(X)          // 時間到就回主 exchange
                .deadLetterRoutingKey("order.created.retry")
                .build();
    }

    @Bean Binding retry5sBinding()  { return BindingBuilder.bind(retry5s()).to(orderRetryX()).with("retry.5s"); }
    @Bean Binding retry1mBinding()  { return BindingBuilder.bind(retry1m()).to(orderRetryX()).with("retry.1m"); }
    @Bean Binding retry10mBinding() { return BindingBuilder.bind(retry10m()).to(orderRetryX()).with("retry.10m"); }

    // ── 停放區：重試用完的訊息最後停在這裡（6.2.4）──
    @Bean Queue parkingQueue() {
        return QueueBuilder.durable("order.confirm-mail.dlq")
                .quorum()
                .maxLength(100_000L)
                .overflow(QueueBuilder.Overflow.rejectPublish)   // ⚠️ 它沒有 DLX，滿了就真的掉了
                .build();
    }
    @Bean Binding parkingBinding() { return BindingBuilder.bind(parkingQueue()).to(orderDlx()); }

    // ── 04 章 4.5：JSON，而且多一個欄位不會炸 ──
    @Bean MessageConverter jsonMessageConverter() {
        ObjectMapper om = JsonMapper.builder()
                .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .build();
        return new Jackson2JsonMessageConverter(om);
    }
}
```

```yaml
spring:
  rabbitmq:
    virtual-host: ${RABBIT_VHOST:/}       # 04 章 4.7
    publisher-confirm-type: correlated    # 05 章 5.2
    publisher-returns: true
    template:
      mandatory: true
    requested-heartbeat: 20s              # 05 章 5.7.2
    listener:
      simple:
        acknowledge-mode: auto
        default-requeue-rejected: false   # 06 章 6.3.4（配上面的 DLX 才安全）
        prefetch: 10                      # 05 章 5.4.6
        concurrency: 2
        max-concurrency: 8
        retry:
          enabled: false                  # 06 章 6.3.3：退避交給 retry 佇列，不要卡住消費者
```

**消費者的樣子**：

```java
@Component
public class ConfirmMailConsumer {

    @RabbitListener(queues = "order.confirm-mail.q")
    public void onOrderCreated(OrderCreated event, Message raw) {
        // ① 03 章：冪等。重複投遞是必然的（05 章 5.4.4 實測一次故障 249 則）
        if (!dedup.firstTime(event.eventId(), "confirm-mail")) return;

        try {
            mailService.sendConfirm(event);
        } catch (TransientException e) {
            // ② 6.3：往退避階梯的下一級送
            escalate(raw, e);
        }
        // ③ 其他例外 → 丟出去 → default-requeue-rejected=false → 進 RETRY_X
    }

    /** 從 x-death 讀出死過幾次，決定下一級退避。⚠️ 讀法見 6.9.2 */
    private void escalate(Message raw, Exception e) {
        int deaths = totalDeaths(raw);              // ⚠️ 不是 x-death[0].count，理由在 6.9.2
        String next = switch (deaths) {
            case 0, 1 -> "retry.5s";
            case 2, 3 -> "retry.1m";
            case 4, 5 -> "retry.10m";
            default   -> null;                       // 用完了 → 停放區
        };
        if (next == null) rabbit.convertAndSend(OrderTopology.DLX, "", raw);
        else              rabbit.convertAndSend(OrderTopology.RETRY_X, next, raw);
    }
}
```

📌 **這份拓撲一共有 5 個佇列、3 個 exchange，處理一個「寄確認信」的需求。**

⚠️ **它看起來很多，但每一個都是前面章節某一個實測數字的直接結果**：

| 元件 | 沒有它會怎樣 | 出處 |
|---|---|---|
| topic exchange | 加第二個消費者要改生產者 | [04 章 4.2.3](./04-rabbitmq-basics-and-topology.md) |
| JSON converter | 上游改套件名 → 消費者全炸 | [04 章 4.5.2](./04-rabbitmq-basics-and-topology.md) |
| confirm + return | routing key 打錯 → **500 則無聲消失** | [01 章 1.3.1](./01-reliable-delivery-three-hops.md) |
| `prefetch: 10` | 一次故障 **249 則**要重做 | [05 章 5.4.4](./05-rabbitmq-reliability.md) |
| `overflow: reject-publish` | 佇列滿了 → **15 則無聲丟掉** | [05 章 5.2.3](./05-rabbitmq-reliability.md) |
| DLX + `requeue: false` | 一則毒藥訊息 → **三秒 45 MB 日誌** | [00 章 0.5.2](./00-course-map-why-message-queue.md) / 6.2.1 |
| retry 佇列階梯 | 本地重試 → **20 則好訊息等 7 秒** | 6.3.1 |
| `deliveryLimit(5)` | 要自己寫 `x-death.count` 的計數邏輯 | 6.6.2 |
| 停放區 `maxLength` | 死信佇列滿了 → 真的消失 | 6.2.4 |
| 冪等 | 一次故障 249 則重複 → 249 封重複的信 | [03 章](./03-idempotent-consumer.md) |

📌 **如果你覺得「這對我的專案太複雜了」，那是一個合理的判斷** ——
但請**逐列**看上面那張表，決定你願意接受哪幾個風險，
而不是「先簡單做，出事再說」。
⚠️ **這十列裡面有四列的症狀是「無聲遺失」，而那些出事之後你連查都查不到。**

### 6.9.1 驗證：它真的宣告得起來，而且訊息走對路

⚠️ **一份拓撲設定寫得出來，不代表它建得起來、也不代表訊息會照你畫的路徑走。**
所以把上面那份原封不動丟進一個 `@TestConfiguration` 跑一次：

```java
package com.example.lab11.ch06;

@SpringBootTest
class H6FinalTopologyTest {

    @TestConfiguration
    static class OrderTopology { /* 6.9 那份設定，一字不改 */ }

    @Test
    void theWholeTopologyDeclaresAndRoutes() {
        // ① 送一則進主 exchange
        rabbit.convertAndSend(X, "order.created.vip", "E-1");
        // ② 消費者 nack(requeue=false)
        reject("order.confirm-mail.q");
        // ③ 等 5 秒 TTL，看它有沒有自己回到主佇列
    }
}
```

**輸出**：

```
═══ 6.9.1 完整拓撲：宣告得起來嗎、訊息走對路嗎 ═══

  ── 五個佇列都建起來了嗎 ──
     order.confirm-mail.q       ✅ 存在
     order.retry.5s.q           ✅ 存在
     order.retry.1m.q           ✅ 存在
     order.retry.10m.q          ✅ 存在
     order.confirm-mail.dlq     ✅ 存在

  ── broker 怎麼看它們 ──
  name	type	messages	arguments
  order.confirm-mail.q	quorum	0	[{"x-dead-letter-exchange","order.retry.x"},{"x-overflow","reject-publish"},
                                     {"x-delivery-limit",5},{"x-max-length",1000000},
                                     {"x-dead-letter-routing-key","retry.5s"},{"x-queue-type","quorum"}]
  order.retry.5s.q	quorum	0	[{"x-message-ttl",5000},{"x-dead-letter-exchange","order.x"},
                                     {"x-dead-letter-routing-key","order.created.retry"},{"x-queue-type","quorum"}]
  order.confirm-mail.dlq	quorum	0	[{"x-overflow","reject-publish"},{"x-queue-type","quorum"},{"x-max-length",100000}]

  ① 送 order.created.vip → 主佇列積壓 = 1
  ② 消費者 nack(requeue=false) → order.retry.5s.q 積壓 = 1
  ③ 等 5 秒 TTL …
     → 主佇列積壓 = 1、retry.5s.q 積壓 = 0
```

✅ **訊息走完了一整圈**：主佇列 → 失敗 → retry.5s.q → 躺 5 秒 → 自己回到主佇列。

**而回來那則訊息身上的 `x-death`，正好是 6.2.3 那一節的活教材**：

```
[{reason=expired,  count=1, exchange=order.retry.x, routing-keys=[retry.5s],
                            queue=order.retry.5s.q, time=Tue Sep 22 10:24:36 CST 2026},
 {reason=rejected, count=1, exchange=order.x,       routing-keys=[order.created.vip],
                            queue=order.confirm-mail.q, time=Tue Sep 22 10:24:31 CST 2026}]
```

📌 **兩個元素，對應它死過的兩個佇列**：

| 順序 | `queue` | `reason` | 意思 |
|---|---|---|---|
| **第一個**（最新） | `order.retry.5s.q` | `expired` | TTL 到期，**這是退避機制在正常運作** |
| 第二個 | `order.confirm-mail.q` | `rejected` | 消費者拒絕，**這才是真正的失敗** |

⚠️ **這就是 6.2.3 說的「`count` 是同一個佇列的累計」。**
而它帶出一個很容易寫錯的問題：**「這則訊息重試幾次了」到底該讀哪個數字？**

### 6.9.2 ⚠️ 「重試幾次了」該讀哪個數字：兩種退避寫法，答案不一樣

把退避階梯的 TTL 縮短（2 秒 / 3 秒）方便觀察，跑兩種寫法：

```java
package com.example.lab11.ch06;

@SpringBootTest
class H7DeathCountTest {

    /** 讀法一：x-death 的第一個元素 */
    static int firstCount(Message m) { ... }

    /** 讀法二：找出「主佇列 + rejected」那個元素 */
    static int rejectedCount(Message m, String mainQueue) {
        for (Object o : (List<?>) m.getMessageProperties().getHeader("x-death")) {
            if (o instanceof Map<?, ?> d
                    && mainQueue.equals(d.get("queue"))
                    && "rejected".equals(d.get("reason")))
                return ((Number) d.get("count")).intValue();
        }
        return 0;
    }

    /** 讀法三：所有 count 的總和 */
    static int totalDeaths(Message m) { ... }
}
```

**輸出**：

```
═══ 6.9.2 走完兩級退避之後，x-death 長什麼樣 ═══
  退避階梯用短一點的 TTL 方便觀察：第一級 2 秒、第二級 3 秒

  ── A：每一次都用 nack（主佇列固定死信到第一級）──
     第 1 次 nack 之後：x-death =
        {queue=ch06.dc.retry.1.q, reason=expired, count=1}
        {queue=ch06.dc.main.q, reason=rejected, count=1}
        x-death[0].count = 1   rejectedCount(MAIN) = 1   totalDeaths = 2
     第 2 次 nack 之後：x-death =
        {queue=ch06.dc.retry.1.q, reason=expired, count=2}
        {queue=ch06.dc.main.q, reason=rejected, count=2}
        x-death[0].count = 2   rejectedCount(MAIN) = 2   totalDeaths = 4
     第 3 次 nack 之後：x-death =
        {queue=ch06.dc.retry.1.q, reason=expired, count=3}
        {queue=ch06.dc.main.q, reason=rejected, count=3}
        x-death[0].count = 3   rejectedCount(MAIN) = 3   totalDeaths = 6

  ── B：escalate（6.9 那個寫法：重送到不同的 retry 佇列）──
     第 1 次（nack）：x-death =
        {queue=ch06.dc.retry.1.q, reason=expired, count=1}
        {queue=ch06.dc.main.q, reason=rejected, count=1}
        x-death[0].count = 1   rejectedCount(MAIN) = 1   totalDeaths = 2

     第 2 次（escalate）：x-death =
        {queue=ch06.dc.retry.2.q, reason=expired, count=1}
        {queue=ch06.dc.retry.1.q, reason=expired, count=1}
        {queue=ch06.dc.main.q, reason=rejected, count=1}
        ❌ x-death[0].count    = 1
        ❌ rejectedCount(MAIN) = 1   ← 沒有增加
        ✅ totalDeaths()       = 3   ← 這個才跟得上
```

📌 **兩種寫法，正確的讀法不一樣**：

| 退避寫法 | 每一級的樣子 | 該讀哪個 |
|---|---|---|
| **A：單一 retry 佇列**（主佇列固定死信到它） | `x-death` 永遠只有 **2 個元素**，`count` 一起往上加 | 三種讀法**都對** |
| **B：escalate 到不同的 retry 佇列**（6.9 那份拓撲） | `x-death` **每多一級就多一個元素**，每個 `count` 都停在 1 | ⚠️ **只有 `totalDeaths()` 是對的** |

⚠️ **B 那一組的 `rejectedCount(MAIN) = 1` 是本節的陷阱。**

**原因**：主佇列的 `rejected` 只有在**真的被 nack** 時才增加。
`escalate()` 是用 `convertAndSend` **重送**到另一個 retry 佇列的 ——
那不是一次「拒絕」，所以主佇列的計數不動。

📌 **結果就是**：如果你在 6.9 那份拓撲裡用 `rejectedCount` 當重試上限，
**那個數字永遠是 1，上限永遠不會觸發** —— 訊息會在階梯裡繞到天荒地老。

**所以 6.9 那個 `escalate()` 要這樣寫**：

```java
private void escalate(Message raw) {
    int deaths = totalDeaths(raw);                 // ⚠️ 用總和，不是 x-death[0].count
    String next = switch (deaths) {
        case 0, 1 -> "retry.5s";
        case 2, 3 -> "retry.1m";
        case 4, 5 -> "retry.10m";
        default   -> null;                          // 用完了 → 停放區
    };
    if (next == null) rabbit.convertAndSend(OrderTopology.DLX, "", raw);
    else              rabbit.convertAndSend(OrderTopology.RETRY_X, next, raw);
}
```

⚠️ **注意那個 `case 0, 1` 是刻意的** ——
每繞一圈 `totalDeaths` 會加 1 或 2（看它有沒有真的被 nack），
**所以階梯的判斷條件要用區間，不能用等號。**

📌 **然後看一眼 6.6.2，你會發現這一整節都可以不用存在**：

```java
@Bean Queue mailQueue() {
    return QueueBuilder.durable("order.confirm-mail.q")
            .quorum()
            .deliveryLimit(5)        // ← broker 幫你算，不用碰 x-death
            .deadLetterExchange(DLX)
            .build();
}
```

**quorum queue 的 `x-delivery-limit` 把「數到 5」這件事變成一個數字，
而這一整節在講的是「如果你不用它，你要自己數，而且很容易數錯」。**

⚠️ **唯一還需要自己數的情況：你需要「退避階梯」而不只是「次數上限」**
（6.6.2 的第 1 點：`x-delivery-limit` 沒有退避）。
📌 **那時候就用 `totalDeaths()`，並且寫一個測試驗證它真的會在第 N 次進停放區** ——
這一節就是那個測試。

---

## 6.10 常見誤區

**① 「訊息處理失敗會自動重試，不用設定」**

會，而且[00 章 0.5.2](./00-course-map-why-message-queue.md) 實測是
**每秒 3,730 次、永遠不停**。Spring AMQP 的預設 `default-requeue-rejected=true` 就是這個。

**①b 「`x-max-length` 一定會無聲丟訊息」**

6.2.2b 實測：**看有沒有設 DLX。**
有 DLX → 被擠掉的 15 則全部進死信佇列（`reason=maxlen`）；
沒 DLX → 那 15 則真的消失。

**② 「設了 `x-dead-letter-exchange` 就安全了」**

⚠️ 6.2.5 坑二：DLX 只是一個 exchange，**沒有佇列綁上去的話，訊息一樣被丟掉**
（[04 章 4.2.2](./04-rabbitmq-basics-and-topology.md)：exchange 不存訊息）。
📌 **一定要故意弄壞一則訊息，驗證它真的出現在死信佇列裡。**

**③ 「死信的 routing key 是我設的那個」**

6.2.5 坑一：**預設會帶著原本的 routing key**。
DLX 如果是 topic 型而 binding 對不上，**死信會第二次消失**。
📌 用 fanout，或明確設 `deadLetterRoutingKey`。

**④ 「`redelivered` 可以拿來數重試次數」**

6.3.2：`redelivered` 是**布林值**。重送 1 次跟 500 次都是 `true`。
要次數只有三條路：`x-death.count`、quorum 的 `x-delivery-limit`、或自己在 header 上算。

**⑤ 「`spring.rabbitmq.listener.simple.retry` 就是重試，設一設就好」**

6.3.1 實測：它用 `Thread.sleep` 卡住**消費者執行緒** ——
一則毒藥訊息讓 20 則正常訊息**等了 7,045 ms**。
📌 退避總長超過 30 秒就不要用它。

**⑥ 「每則訊息設 TTL 就能做延遲佇列」**

6.4.1 實測：**先送延遲 8 秒、再送延遲 1 秒 → 那則 1 秒的在 8,044 ms 才到。**
佇列是 FIFO，broker 只檢查隊首。
📌 正解是**每一級延遲一個佇列**（6.4.2）。

**⑦ 「裝了 delayed-message 外掛就沒問題了」**

6.4.3 實測：延遲中的訊息**在 exchange 裡，佇列積壓顯示 0**。
你**看不到有多少在等、也撈不出來、更取消不了**。
📌 而且它要另外安裝，託管服務不一定給你裝。

**⑧ 「延遲訊息送出去之後可以取消」**

不能。📌 **延遲訊息的正確語意是「到時候去檢查一下」** ——
判斷寫在消費端（6.4.4 那個 `if (order.getStatus() != PENDING) return;`）。

**⑨ 「設了優先級佇列，緊急的訊息就會先處理」**

6.5.2 實測：`prefetch=250` 時，緊急訊息排在 **236 則普通訊息後面**。
📌 **優先級只排「還在佇列裡」的訊息**，已經送給消費者的它超不了。
要有效就得把 prefetch 調小（[05 章 5.4](./05-rabbitmq-reliability.md)）。

**⑩ 「訊息上設了 priority 就有優先級」**

6.5.3 ①：佇列沒有宣告 `x-max-priority` 的話，**`priority` 被完全忽略，沒有任何警告**。
⚠️ 而它是[不可變參數](./04-rabbitmq-basics-and-topology.md)，事後要加只能走雙綁遷移。

**⑪ 「quorum queue 比較慢，所以先用 classic」**

6.6.1 實測（單節點）：quorum **56,180 則/秒 vs classic 30,441 則/秒**。
⚠️ 但這個數字**沒有量到副本同步的成本**（本站是單節點）。
📌 它能證明的是「單節點上換過去不會變慢」，所以「怕慢」不是不用的理由。

**⑫ 「鏡像佇列（`ha-mode`）是 RabbitMQ 的高可用方案」**

6.7：它已經在淘汰清單上（`classic_queue_mirroring`），4.0 已移除，
而且**腦裂時會丟訊息**。📌 高可用的答案是 quorum queue。
⚠️ 但也**不要只是刪掉那條 policy** —— 要先遷到 quorum 再刪。

**⑬ 「readiness probe 檢查 port 5672 通不通就好」**

6.8：broker 啟動期間 port 是開的但還不能服務。
📌 用 `rabbitmq-diagnostics check_running`。

**⑭ 「生產者全部卡住，一定是網路問題」**

6.8：先查 `check_local_alarms`。RabbitMQ 的記憶體／磁碟 alarm
會**擋住所有生產者**，而 broker 本身是活著的。

---

## 6.11 本章小結

**這一章證明了六件事**：

1. **DLX 把那場風暴變成一個數字**（6.2）：
   投遞 11,191 → **1**、日誌 45 MB → **8 KB**，而且**多了一個看得見的告警指標**。
   代價是**改兩行設定 + 多一個 exchange、一個佇列、一條 binding**。
   ⚠️ 而且同一個 DLX 還順手接住了另一種遺失：6.2.2b 實測
   **`x-max-length` 擠掉的 15 則，有 DLX 就全部進死信、沒有就真的消失**。
2. **`x-death` 是訊息的驗屍報告**（6.2.3、6.9.2）：`reason` 告訴你為什麼死，
   `count` 是重試計數的來源（`redelivered` 不是）——
   ⚠️ **但它是「每個佇列一個」的陣列，escalate 型的退避階梯只有「總和」讀得對**。
3. **兩種重試退避，差別是「會不會卡住消費者」**（6.3）：
   本地重試讓 20 則好訊息等 **7,045 ms**，死信回送是 **45 ms**。
4. **TTL 延遲佇列有 head-of-line blocking**（6.4）：
   延遲 1 秒的訊息實測在 **8,044 ms** 才到。
   正解是「每一級一個佇列」，外掛版沒有這個問題但**看不到也撈不出來**。
5. **優先級超不了「已經送出去的」**（6.5）：`prefetch=250` 時緊急訊息排第 301 名。
   而且 quorum queue 不支援優先級。
6. **quorum queue 應該是預設**（6.6）：單節點吞吐不吃虧，
   而 `x-delivery-limit` 讓「重試 N 次就放棄」變成佇列的一個屬性
   —— **在 `requeue=true` 這個最糟的設定下，投遞次數也只有 4 次**。

📌 **RabbitMQ 三章走完，回頭看 [01 章 1.7](./01-reliable-delivery-three-hops.md) 那張三段總表**，
RabbitMQ 那一欄現在每一格都有具體的設定與實測數字：

```
   ① 生產者 → broker     confirm + return + mandatory        （05 章 5.2）
   ② broker 自己         durable + persistent + 長度上限      （01 章 1.4、05 章 5.6）
   ③ broker → 消費者     ack 模式 + prefetch + 順序 + 心跳     （05 章 5.3～5.7）
   ────────────────────────────────────────────────────────
   失敗之後              DLX + 退避階梯 + 停放區               （06 章 6.2、6.3）
   時間                  TTL 階梯 / 延遲外掛                   （06 章 6.4）
   高可用                quorum queue                         （06 章 6.6）
```

### 6.11.1 驗收清單

做得到才往下走：

- [ ] 說出 6.2.1 相對於 [00 章 0.5.2](./00-course-map-why-message-queue.md) 改了哪兩件事，以及四個數字各變成什麼。
- [ ] 列出訊息進 DLX 的四種 `reason`，並各舉一個會觸發它的設定。
- [ ] 說出「`x-max-length` + DLX」、「只有 `x-max-length`」、「`reject-publish`」三者的差別，
      以及各自把背壓推給誰。
- [ ] 說出 `x-death` 的 `time` 是第一次還是最後一次，以及它適合回答哪個問題。
- [ ] 從 `x-death` 讀出三件事：為什麼死、死了幾次、原本在哪個佇列。
- [ ] 說出 `x-death` 的 `count` 是「哪個範圍」的累計。
- [ ] 說出兩種退避寫法（單一 retry 佇列 vs escalate）下，「重試幾次了」該讀哪個數字，
      以及讀錯會發生什麼（6.9.2）。
- [ ] 說出死信佇列上線前要做的四件事。
- [ ] 說出重放死信的三個規矩，以及為什麼要清掉 `x-death`。
- [ ] 說出 DLX 的三個坑各自的症狀與防法。
- [ ] 說出本地重試與死信回送在**六個面向**上的差別，並說出你的專案該用哪一種。
- [ ] 算出 `initial=1s, multiplier=2, max-attempts=6` 的退避總長。
- [ ] 說出 `redelivered` 為什麼不能當重試計數器，以及三個可以的替代方案。
- [ ] 解釋 6.4.1 那個「延遲 1 秒的訊息在 8,044 ms 才到」的機制。
- [ ] 說出「每一級延遲一個佇列」解決了什麼、放棄了什麼。
- [ ] 說出 delayed-message 外掛的四個代價。
- [ ] 寫出「30 分鐘後檢查未付款訂單」的完整拓撲，並說明消費端那個 `if` 為什麼是必要的。
- [ ] 說出優先級佇列在什麼情況下有效、什麼情況下無效。
- [ ] 說出 `x-max-priority` 建議設多少、為什麼不要設 255，以及「兩級就夠」的實務理由。
- [ ] 說出 quorum queue **不支援**的三件事。
- [ ] 說出 `x-delivery-limit` 取代了什麼、**沒有**取代什麼，
      以及 `deliveryLimit(3)` 實測投遞了幾次。
- [ ] 說出 6.6.1 那組吞吐數字**不能**用來論證什麼。
- [ ] 說出鏡像佇列被淘汰的三個技術原因，以及接手舊系統時的三個步驟。
- [ ] 說出 `check_running`、`check_port_connectivity`、`check_local_alarms`、`memory_breakdown` 各自什麼時候用。
- [ ] 看到 `memory_breakdown` 裡 `connection_readers` 很大，說出最可能的原因。

### 6.11.2 本章練習

**練習一（20 分鐘）**：把 6.2.1 的 DLX 拿掉（只留 `default-requeue-rejected=false`），重跑。
**記錄：投遞次數、原佇列積壓、那則訊息最後在哪裡。**
然後回答：這個設定跟 00 章那個「requeue 風暴」相比，**哪一個比較危險？為什麼？**
（提示：一個很吵，一個很安靜。）

**練習二（25 分鐘）**：做一個「死信檢視器」：
一支程式，把死信佇列裡的訊息**逐則印出來**，格式包含
`x-last-death-reason`、`x-first-death-queue`、`x-death` 的 `count`、以及 payload 前 100 字。
⚠️ **用 `ackmode=ack_requeue_true` 的語意**（看完放回去，不要弄掉它）。
然後在死信佇列裡塞三種不同 `reason` 的訊息（`rejected` / `expired` / `maxlen`），
**驗證你的檢視器都認得出來。**

**練習三（25 分鐘）**：重跑 6.3.1，把 `max-attempts` 改成 6、`multiplier` 改成 3。
**記錄那 20 則正常訊息的等待時間。**
然後把 `concurrency` 從 1 改成 4，再跑一次 ——
**記錄「幾則毒藥訊息可以讓整個服務停擺」。**

**練習四（30 分鐘）**：把 6.3.2 的死信回送做成**三級退避階梯**（5s / 15s / 45s），
並在消費端用 `x-death` 的 `count` 決定下一級。
送 1 則永遠失敗的訊息，**記錄它在每一級停留的時間，以及最後幾秒鐘進停放區。**
然後在它跑到第二級的時候 `docker restart rabbit-lab` ——
**驗證重啟之後它還在，而且進度沒有歸零。**
（這就是 6.3.3 那張表「服務重啟會怎樣」那一列。）

**練習五（25 分鐘）**：重現 6.4.1 的 head-of-line blocking，但這次送 **100 則**訊息，
TTL 從 100 ms 到 10,000 ms 隨機。
**記錄每一則的實際延遲與設定延遲的差距，畫出分布。**
然後回答：最糟的那一則差了多少？**你的業務能接受嗎？**

**練習六（30 分鐘）**：實作 6.4.4 那個「30 分鐘檢查未付款訂單」，但把 TTL 改成 10 秒方便測試。
造三種情況：① 一直沒付款、② 在第 5 秒付款了、③ 訂單在第 3 秒被刪掉。
**驗證三種情況下的最終結果都是對的，而且沒有任何例外。**
然後**把消費端那個 `if` 拿掉**，重跑情況 ② ——
**記錄發生了什麼**（一張已付款的訂單被取消了）。

**練習七（進階，35 分鐘）**：把 6.9 那份拓撲完整建起來，然後做一次故障演練：

1. 送 1,000 則訊息，其中 50 則會讓消費者丟 `TransientException`、10 則丟 `RuntimeException`。
2. **記錄**：主佇列、三個 retry 佇列、停放區在**每 10 秒**的深度變化。
3. **驗證**：那 50 則暫時性失敗的最後有沒有成功（如果你讓它們在第 2 次成功的話）。
4. **驗證**：那 10 則永久失敗的全部在停放區，而且 `x-death` 的 `count` 是 3。
5. 畫一張「訊息在五個佇列之間流動」的時間序列圖。

**練習八（進階，30 分鐘）**：把 6.9 的佇列全部改成 classic，重跑練習七。
**記錄**：① 你需要多寫幾行程式碼？② 吞吐差多少？③ 有哪些設定變得不能用？
然後寫一份 200 字的「為什麼我們要／不要遷到 quorum」給你的團隊。

**練習九（綜合，60 分鐘）**：**RabbitMQ 三章的總驗收。**
把 [02 章的 Outbox](./02-outbox-and-transactional-consistency.md)、
[03 章的冪等](./03-idempotent-consumer.md)、04～06 章的拓撲全部接起來：

1. `placeOrder()` 在同一個交易裡寫 `orders` 與 `outbox`。
2. 輪詢器用 `SKIP LOCKED` 撈出來送，confirm 回來才 `markSent`。
3. 消費者去重之後處理，失敗走退避階梯，重試用完進停放區。
4. **演練四種故障**，每一種都記錄「最終資料對不對」：
   - 輪詢器在 `markSent` 之前被 `kill -9`
   - broker 在消費到一半被 `docker restart`
   - 消費者被 `kill -STOP`（[05 章 5.7](./05-rabbitmq-reliability.md)）
   - 下游服務回 500 持續 3 分鐘之後恢復
5. **最終驗收**：1,000 張訂單、1,000 封信（不多不少）、停放區 0 則。

**這一題做完，你就有 [11-messaging README](./README.md) 那份「產出」的第 1 與第 3 項了。**

---

## 6.12 下一章預告

**RabbitMQ 三章結束了。** 你現在會：

- 設計拓撲、選 exchange 型別、安全地改拓撲（04 章）。
- confirm / ack / prefetch / 順序 / 心跳（05 章）。
- DLX / 退避 / 延遲 / 優先級 / quorum（06 章）。

**而這六章裡有一個問題，RabbitMQ 從頭到尾都沒有好的答案**：

> **「同一個 orderId 的事件要有序，但不同訂單之間可以並行。」**
>
> [05 章 5.5.3](./05-rabbitmq-reliability.md) 給的三條路都很貴：
> 單一活躍消費者 → **吞吐鎖死在一條執行緒**；
> 業務層版本號 → **每個消費者都要自己寫，而且擋不住副作用**；
> `x-consistent-hash` 分片 → **要裝外掛、要自己做部署規劃、擴容時 13% 的 key 會搬家**
> —— 而那其實就是「自己做一個陽春版的 Kafka」。

**下一章（07）開始的 Kafka，對這個問題有一個原生的答案，叫做 partition。**

而 Kafka 的整個模型跟 RabbitMQ **不是同一件事的兩種實作**，
是[00 章 0.4](./00-course-map-why-message-queue.md) 講的**兩種模型**：

| | RabbitMQ（你剛學完的） | Kafka |
|---|---|---|
| 訊息讀完之後 | **消失** | **還在**，可以重讀 |
| 「進度」記在哪 | broker（`unacked`） | **消費者自己**（offset） |
| 路由 | exchange + binding，**很聰明** | ⚠️ **沒有路由**。只有 topic 與 partition |
| 順序 | 只有「一個消費者」時 | **同一個 partition 內保證有序** |
| 積壓 | 佇列深度（待辦量） | **lag**（我落後多少） |
| 加一個新消費者 | 只能收到**之後**的訊息 | ✅ **可以從頭重讀** |

⚠️ **最後一列是 07～09 章最大的思維轉換**，
而它會讓你重新看待「重放」這件事 —— 在 RabbitMQ 裡那是 6.2.4 那段小心翼翼的重放程式碼，
在 Kafka 裡它只是**把 offset 設回去**。

**07 章會量四件事**：

- **key 決定分區、分區決定順序**：同一個 `orderId` 的六個事件，
  [00 章 0.5.1](./00-course-map-why-message-queue.md) 已經證明「不給 key 就會亂」，
  07 章要把「給了 key 之後可以並行到什麼程度」量出來。
- **`acks` 三個值**：[01 章 1.3.5 與 1.3.6](./01-reliable-delivery-three-hops.md) 已經用兩台 broker 實測過
  （`acks=1` 回報成功但沒人讀得到），07 章把它接回 producer 的完整設定。
- **批次與壓縮**：Kafka 的吞吐不是憑空來的，
  `batch.size` / `linger.ms` / `compression.type` 三個參數決定了它 ——
  ⚠️ 而 [00 章 0.5.1](./00-course-map-why-message-queue.md) 那個實驗三證明了
  **`batch.size` 也會影響順序**。
- **⚠️ 一個 RabbitMQ 沒有、而你一定會踩的東西**：
  **分區數是一個幾乎改不回去的決定。**
  它同時決定了你的最大併發度、順序保證的粒度、與 rebalance 的成本，
  而**加分區會讓既有 key 的路由全部跑掉**。
