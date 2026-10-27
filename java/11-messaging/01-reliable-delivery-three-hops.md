# 第 01 章：可靠投遞的三段

> [00 章](./00-course-map-why-message-queue.md) 的結論是「佇列要活得比行程久」。
> 這一章要回答的是：**那個承諾，在哪裡會破掉？**
>
> 答案是**三個地方**，而且每一段的防守手段、以及那個防守手段的價格，都不一樣。
>
> 這一章有五個實測事故，我要先講最反直覺的三個：
>
> - **broker 活著、連線正常、程式沒例外、日誌乾淨 —— 500 則訊息全部消失。**
>   （1.3.1）原因只是 routing key 少打一個字母。
>   `convertAndSend()` **回傳了 500 次成功、丟出 0 個例外**。
>
> - **`acks=1` 回報「成功，offset 3」，訊息也真的寫在 leader 的磁碟上 ——
>   但沒有任何消費者讀得到它，而且 consumer lag 顯示 0。**
>   （1.3.6）這是在兩台 broker、拔掉一台的情況下量到的。
>   更詭異的是後續：**把那台 broker 插回去之後，那些訊息突然全部出現了** ——
>   帶著幾分鐘前的時間戳。
>
> - **Kafka 消費者一次 `poll()` 拿到 300 則、只處理完 50 則就被 kill，
>   位移卻提交到 300 —— 250 則永遠不會有人處理，而 `lag = 0`。**
>   （1.5.2）你的監控看板上，這個 consumer group「完全跟上」。
>
> 這一章結束時你會有一張**「三段 × 兩個 broker × 防守手段與代價」**的總表（1.7）——
> 那張表是 04～09 章所有設定項的索引。
>
> ⚠️ 但這一章**不會**給你「設定成這樣就不會掉」的答案。
> 因為那個答案不存在 —— 1.7 會把「不重不漏」講成一個**必須選邊的取捨**：
> 選了「不漏」就要接受重複（→ 03 章），選了「不重」就要接受遺失。

---

## 1.1 學習目標

完成本章後，你應該可以：

- 畫出一則訊息從生產者到消費者的**三段**，並說出每一段的「確認」分別叫什麼（1.2）。
- 重現「routing key 打錯 → 500 則無聲消失」，並說出為什麼 `convertAndSend()` 不會丟例外（1.3.1）。
- 說明 **publisher confirm 與 publisher returns 回答的是兩個不同的問題**，
  以及只開一個會漏掉哪一類遺失（1.3.3）。
- 說出開 confirm 的吞吐代價（1.3.4：`47,619 → 8,000 → 1,359` 則/秒），
  並說明為什麼「批次收 confirm」幾乎不用付這個代價。
- 說明 `acks=0` / `acks=1` / `acks=all` 的差別，並說出 `acks=1` 在什麼情況下會騙你（1.3.5、1.3.6）。
- 說明為什麼**單節點 broker 量不出 `acks=all` 的價值**，以及 `min.insync.replicas` 被夾住這個坑（1.3.7）。
- 說出 RabbitMQ「佇列持久化 × 訊息持久化」四種組合過一次重啟的結果（1.4.1），
  並指出**只有一種組合是安全的**。
- 說明為什麼「訊息設了 persistent」**還是不等於**「斷電不會掉」（1.4.2）。
- 說出一則 RabbitMQ 訊息的**三種狀態**（`ready` / `unacked` / 消失），
  並說明手動 ack 的全部價值是什麼（1.5.1）。
- 重現「Kafka 自動提交把沒處理的也提交了」，並說出為什麼 `lag = 0` 在這時候是騙人的（1.5.2）。
- 說明 at-most-once / at-least-once / exactly-once 三者的取捨，
  以及為什麼**跨系統的 exactly-once 不存在**（1.6）。

## 1.2 三段在哪裡

### 1.2.1 一張圖

```
   你的程式                    broker                     消費者
      │                          │                          │
      │  ①  send()               │                          │
      ├─────────────────────────▶│                          │
      │  ◀───── confirm / ack ───┤                          │
      │                          │                          │
      │                     ②  落盤 / 複製                   │
      │                          │  ├── 記憶體？             │
      │                          │  ├── OS page cache？      │
      │                          │  └── 磁碟？副本？          │
      │                          │                          │
      │                          │  ③  deliver / poll        │
      │                          ├─────────────────────────▶│
      │                          │  ◀──── ack / commit ─────┤
      │                          │                          │
      ▼                          ▼                          ▼
   第一段                     第二段                      第三段
「我送出去了，              「你收下了，              「你收到了，
  它到了嗎？」                它還在嗎？」                你做完了嗎？」
```

**三段各自的失敗長什麼樣子**：

| | 失敗時發生什麼 | 你這一側看到什麼 |
|---|---|---|
| **第一段** | 訊息沒進到 broker（或進了 broker 但沒進佇列） | 可能什麼都看不到（1.3.1），也可能是一個例外（1.3.2） |
| **第二段** | 訊息進了 broker，但 broker 重啟 / 斷電 / 掛掉之後它不在了 | **什麼都看不到。** 你已經收到 ack 了 |
| **第三段** | 消費者拿到了，但事情沒做完（或做完了但 broker 不知道） | 沒做完的那一側：什麼都看不到；做完的那一側：訊息重複 |

📌 **這三段是「乘法」不是「加法」**：
三段各自 99.9% 可靠，串起來是 99.7%。
一天 10 萬則訊息，那是**每天 300 則**出問題。

### 1.2.2 每一段的「確認」叫什麼

這一章最容易搞混的就是一堆長得很像的名詞。先把它們釘死：

| 段 | RabbitMQ 的名字 | Kafka 的名字 | 它回答什麼 |
|---|---|---|---|
| ① | **publisher confirm** | **acks** | 「broker 收到了嗎」 |
| ① 的補充 | **publisher return**（`mandatory`） | （沒有對應物） | 「訊息有進到某個佇列嗎」 |
| ② | `durable` 佇列 + `delivery_mode=2` | `replication.factor` + `min.insync.replicas` | 「broker 重啟 / 掛掉之後它還在嗎」 |
| ③ | **consumer ack**（`basicAck`） | **offset commit** | 「消費者做完了嗎」 |

⚠️ **最容易搞混的兩組**：

- **publisher confirm ≠ consumer ack。** 兩個都叫「ack」，但一個是 broker 回答生產者，
  一個是消費者回答 broker。它們在訊息生命週期的兩端。
- **Kafka 的 `acks` ≠ Kafka 的 offset commit。**
  `acks` 是第一段（producer 等 broker），offset commit 是第三段（consumer 告訴 broker）。
  **兩個設定都叫「確認」，但改錯一個不會影響另一個。**

---

## 1.3 第一段：生產者 → broker

### 1.3.1 事故：routing key 少一個字母，500 則無聲消失 ★★★

**這一節是整章最重要的一節**，因為它的失敗模式是「完全沒有失敗的樣子」。

```java
package com.example.lab11.ch01;

import com.example.lab11.MsgProbe;
import org.junit.jupiter.api.Test;
import org.springframework.amqp.core.Queue;
import org.springframework.amqp.rabbit.core.RabbitAdmin;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import java.util.concurrent.atomic.AtomicInteger;

@SpringBootTest        // ⚠️ 注意：完全沒有任何 confirm 設定，就是 Boot 的預設
class B2UnroutableTest {

    @Autowired RabbitTemplate rabbit;
    @Autowired RabbitAdmin admin;
    @Autowired MsgProbe probe;

    static final String Q = "ch01.route.q";

    static void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); } }

    @Test
    void typoInRoutingKeyIsSilent() {
        System.out.println("═══ 1.3.1 broker 好好的、程式也沒例外，訊息還是消失了 ═══");
        admin.deleteQueue(Q);
        admin.declareQueue(new Queue(Q, true, false, false));

        AtomicInteger ok = new AtomicInteger(), ex = new AtomicInteger();

        // 正確的 routing key
        for (int i = 0; i < 500; i++) {
            try { rabbit.convertAndSend(Q, "good-" + i); ok.incrementAndGet(); }
            catch (Exception e) { ex.incrementAndGet(); }
        }
        sleep(600);
        System.out.printf("  ① routing key = \"%s\"（正確）%n", Q);
        System.out.printf("     送 500 則 → 回傳成功 %d、例外 %d → 佇列積壓 = %d%n", ok.get(), ex.get(), probe.depth(Q));

        // 打錯一個字
        ok.set(0); ex.set(0);
        String typo = "ch01.rout.q";      // route → rout，少一個 e
        for (int i = 0; i < 500; i++) {
            try { rabbit.convertAndSend(typo, "typo-" + i); ok.incrementAndGet(); }
            catch (Exception e) { ex.incrementAndGet(); }
        }
        sleep(600);
        System.out.printf("%n  ② routing key = \"%s\"（少打一個 e）%n", typo);
        System.out.printf("     送 500 則 → 回傳成功 %d、例外 %d%n", ok.get(), ex.get());
        System.out.printf("     佇列 %s 積壓 = %d（沒變）%n", Q, probe.depth(Q));
        System.out.printf("     佇列 %s 存在嗎 = %s%n", typo, probe.depth(typo) < 0 ? "不存在" : "存在");
    }
}
```

**輸出**：

```
═══ 1.3.1 broker 好好的、程式也沒例外，訊息還是消失了 ═══
  ① routing key = "ch01.route.q"（正確）
     送 500 則 → 回傳成功 500、例外 0 → 佇列積壓 = 500

  ② routing key = "ch01.rout.q"（少打一個 e）
     送 500 則 → 回傳成功 500、例外 0
     佇列 ch01.route.q 積壓 = 500（沒變）
     佇列 ch01.rout.q 存在嗎 = 不存在
```

⚠️ **500 則訊息進了 broker、被 broker 丟掉、沒有任何錯誤。**

**盤點一下你手上有的線索**：

| 你會去看的地方 | 它說什麼 |
|---|---|
| `convertAndSend()` 的回傳 | 它是 `void` —— **它沒有回傳值可以看** |
| 例外 | 0 個 |
| 應用日誌 | 乾淨的 |
| broker 是否活著 | 活著 |
| 連線 | 正常 |
| 佇列積壓 | 0（因為訊息從來沒進去） |
| 消費者錯誤率 | 0（沒有訊息給它） |
| APM / trace | 顯示 `send()` 成功，耗時 0.02 ms |

**你唯一的線索是「使用者說沒收到信」。**

**為什麼會這樣？** 因為 AMQP 協定裡，`basic.publish` **是一個沒有回應的命令**：

```
你的程式 ──── basic.publish(exchange="", routing_key="ch01.rout.q", body=...) ───▶ broker
                                                                                    │
                       （協定上沒有任何回應）                                         │
                                                                                    ▼
                                                              broker：「這個 routing key
                                                               沒有對應的佇列 → 丟掉」
```

📌 **這是刻意的設計，不是 bug。**
AMQP 的 publish 沒有回應，是為了讓吞吐能衝到 00 章那個 47,619 則/秒 ——
**每一則都等一次往返，吞吐會掉一個數量級**（1.3.4 會量給你看）。
`publisher confirm` 是一個**額外的、要自己打開的**擴充。

⚠️ **這個 bug 在真實專案裡長什麼樣子**：

```java
// 常數在這裡
public static final String QUEUE_ORDER_MAIL = "order.confirm-mail.q";

// 有人在別的地方手打了字串（因為 import 常數比較麻煩）
rabbitTemplate.convertAndSend("order.confirm_mail.q", event);   // ← 底線 vs 連字號
```

**跑起來完全正常。測試也會過** —— 因為單元測試通常 mock 掉 `RabbitTemplate`，
而整合測試如果只驗證「`convertAndSend` 被呼叫了」，那它驗證的是你打錯的那個字串。

### 1.3.2 反直覺：broker 完全停掉的時候，反而是安全的

**很多人會以為「broker 掛掉」是第一段最危險的情況。實測相反**：

```java
        System.out.println("\n  ② 把 broker 停掉（docker stop rabbit-lab）");
        sh("docker", "stop", "rabbit-lab");
        sleep(1000);

        AtomicInteger ok = new AtomicInteger(), ex = new AtomicInteger();
        for (int i = 0; i < 1000; i++) {
            try { rabbit.convertAndSend(Q, "during-" + i); ok.incrementAndGet(); }
            catch (Exception e) { ex.incrementAndGet(); /* 記下第一個 */ }
        }
```

**輸出**：

```
═══ 1.3.2 沒開 confirm：broker 停掉時 convertAndSend() 會怎樣 ═══
  ① broker 正常，送 100 則 → 佇列積壓 = 100

  ② 把 broker 停掉（docker stop rabbit-lab）
     rabbit-lab

  ③ broker 是停著的，再送 1,000 則：
     convertAndSend() 回傳成功 : 0 則
     丟出例外                  : 1,000 則
     第一個例外                : AmqpConnectException: java.net.ConnectException: Connection refused

  ④ 把 broker 開回來
     rabbit-lab

  ⑤ 佇列積壓 = 100
     應該有 1,100 則（100 + 1000），實際 100 則
     👉 掉了 1000 則，而生產者這一側「0 則回傳成功、1000 個例外」
```

**訊息一樣掉了 1,000 則，但這次你有 1,000 個例外。**

| | 1.3.1（routing key 打錯） | 1.3.2（broker 停掉） |
|---|---|---|
| 掉了幾則 | 500 | 1,000 |
| 你收到幾個例外 | **0** | **1,000** |
| 你會不會發現 | **不會** | 會（除非你 `catch (Exception e) {}`） |
| 你能不能補救 | 沒有訊息可以補，連清單都沒有 | 可以：例外裡有那則訊息，寫進 DB 或重試 |
| 危險程度 | **★★★** | ★ |

📌 **這一節的結論**：
**「有例外」是好事。真正危險的是「沒有例外的遺失」。**

這也是為什麼 1.3.3 那兩個設定**一定要開** —— 它們的作用就是
**把「沒有例外的遺失」轉換成「有例外的遺失」**。

⚠️ 順便：`connection refused` 在 Spring AMQP 這一側是 `AmqpConnectException`（`AmqpException` 的子類，`RuntimeException`）。
如果你的 `placeOrder()` 有 `@Transactional`，**這個例外會把訂單交易一起回滾** ——
和 00 章 0.2.2 死法二一模一樣的問題。02 章會處理它。

### 1.3.3 publisher confirm 與 publisher returns：兩個都要開

打開兩個設定：

```yaml
spring:
  rabbitmq:
    publisher-confirm-type: correlated    # 開 publisher confirm，並帶 CorrelationData
    publisher-returns: true               # 開 publisher return
    template:
      mandatory: true                     # ⚠️ 少了這個，publisher-returns 不會生效
```

⚠️ **`mandatory: true` 很容易漏。** `publisher-returns: true` 只是「準備好接收 return」，
真正讓 broker 回傳「這則路由不到」的是**每一則訊息上的 `mandatory` 旗標**。
`spring.rabbitmq.template.mandatory` 把 `RabbitTemplate` 送出的每一則都標上它。

```java
@SpringBootTest(properties = {
        "spring.rabbitmq.publisher-confirm-type=correlated",
        "spring.rabbitmq.publisher-returns=true",
        "spring.rabbitmq.template.mandatory=true"
})
class B3ConfirmAndReturnTest {

    @Test
    void confirmAndReturnCatchIt() throws Exception {
        admin.deleteQueue(Q);
        admin.declareQueue(new Queue(Q, true, false, false));

        AtomicInteger acked = new AtomicInteger(), nacked = new AtomicInteger(), returned = new AtomicInteger();
        StringBuilder firstReturn = new StringBuilder();

        rabbit.setConfirmCallback((corr, ack, cause) -> {
            if (ack) acked.incrementAndGet(); else nacked.incrementAndGet();
        });
        rabbit.setReturnsCallback(ret -> {
            returned.incrementAndGet();
            if (firstReturn.isEmpty())
                firstReturn.append(String.format("replyCode=%d replyText=%s routingKey=%s",
                        ret.getReplyCode(), ret.getReplyText(), ret.getRoutingKey()));
        });

        // ① 正確的 key
        for (int i = 0; i < 200; i++)
            rabbit.convertAndSend("", Q, "good-" + i, new CorrelationData("g" + i));
        sleep(1200);
        // ② 打錯的 key
        for (int i = 0; i < 200; i++)
            rabbit.convertAndSend("", "ch01.confir.q", "typo-" + i, new CorrelationData("t" + i));
        sleep(1500);
        // ... 印出統計
    }
}
```

**輸出**：

```
═══ 1.3.3 打開 confirm 與 return 之後，同樣的錯打不進去了 ═══
  ① 正確的 routing key，送 200 則
     ack = 200  nack = 0    returned = 0     佇列積壓 = 200

  ② 打錯的 routing key，送 200 則
     ack = 200  nack = 0    returned = 200
     第一個 return : replyCode=312 replyText=NO_ROUTE routingKey=ch01.confir.q
```

⚠️ **停下來看 ② 那一行的 `ack = 200`。**

**打錯 routing key 的那 200 則，broker 還是回了 `ack`。**

這是整章最容易搞錯的一件事，所以講清楚：

```
你的程式 ──── basic.publish(routing_key="ch01.confir.q") ───▶ broker
                                                                │
                                                                ├─ 「我收到這則訊息了」
                                                     ◀──────────┤   → basic.ack     ✅
                                                                │
                                                                ├─ 「但它路由不到任何佇列」
                                                     ◀──────────┤   → basic.return  ❌
                                                                │      (312 NO_ROUTE)
                                                                └─ 丟掉
```

| | 回答的問題 | 它**不**回答 |
|---|---|---|
| **confirm**（ack / nack） | 「broker **收到**這則訊息了嗎？」 | 它有沒有進到佇列 |
| **return** | 「這則訊息**進到佇列**了嗎？」 | broker 有沒有收到（收不到就不會有 return） |

📌 **所以兩個都要開，少一個就有一類遺失抓不到**：

| 情境 | 只開 confirm | 只開 return | 兩個都開 |
|---|---|---|---|
| broker 沒收到（磁碟滿、連線斷） | ✅ 抓到（nack / 逾時） | ❌ 抓不到 | ✅ |
| routing key 打錯 | ❌ **抓不到**（會收到 ack） | ✅ 抓到（NO_ROUTE） | ✅ |
| exchange 不存在 | ⚠️ channel 會被 broker 關掉（抓得到，但形式很醜） | ❌ | ✅ |

**正確的 callback 該做什麼**（本站建議的樣子）：

```java
@Component
public class ReliablePublisher {

    private final RabbitTemplate rabbit;
    private final OutboxRepository outbox;     // 02 章會做這張表

    @PostConstruct
    void wire() {
        rabbit.setConfirmCallback((corr, ack, cause) -> {
            if (ack) {
                outbox.markSent(corr.getId());                    // 確認送到了 → 標記完成
            } else {
                log.error("broker nack, id={} cause={}", corr.getId(), cause);
                outbox.markFailed(corr.getId(), cause);           // ← 留下可以重來的憑據
            }
        });
        rabbit.setReturnsCallback(ret -> {
            // ⚠️ 這裡幾乎一定是程式 bug（routing key / exchange 錯了），不是暫時性故障
            log.error("NO_ROUTE! exchange={} routingKey={} replyText={} body={}",
                    ret.getExchange(), ret.getRoutingKey(), ret.getReplyText(),
                    new String(ret.getMessage().getBody()));
            alerting.pageOncall("訊息路由不到，這是設定錯誤");    // ← 要吵醒人
        });
    }
}
```

⚠️ **兩個 callback 的語意完全不同，處理方式也該不同**：

- **nack / 逾時** → 暫時性故障（broker 忙、磁碟滿）→ **重試**。
- **return（NO_ROUTE）** → 幾乎一定是**設定或程式錯誤** → 重試一萬次也一樣 →
  **要告警、要有人去改程式**。把它當暫時性故障重試，只會變成 00 章 0.5.2 那種風暴。

📌 **confirm callback 是在另一條執行緒上跑的。**
它**不是**在你 `convertAndSend()` 的那條執行緒上。
所以：① 不要在 callback 裡用 `@Transactional`（沒有交易上下文）、
② 不要在 callback 裡做慢的事（會卡住整個 confirm 的處理）、
③ `ThreadLocal`（含 MDC 裡的 traceId）**在這裡是空的** —— 10 章會處理這件事。

### 1.3.4 confirm 的吞吐代價：47,619 → 8,000 → 1,359

confirm 不是免費的。這一節量三種用法。

**先量一個乾淨的基準**（`publisher-confirm-type` 是預設的 `none`）：

```java
/** 跟 B4ConfirmCostTest 唯一的差別：publisher-confirm-type 是預設的 none */
@SpringBootTest
class B4bBaselineTest {
    @Test
    void baselineNoConfirmMode() {
        admin.deleteQueue(Q);
        admin.declareQueue(new Queue(Q, true, false, false));
        int N = 2000;
        for (int i = 0; i < 200; i++) rabbit.convertAndSend("", Q, "warm");   // 熱身 + 建連線
        long s = System.nanoTime();
        for (int i = 0; i < N; i++) rabbit.convertAndSend("", Q, "fire-" + i);
        long ms = (System.nanoTime() - s) / 1_000_000;
        System.out.printf("  ⓪ publisher-confirm-type=none，送 %,d 則 : %,5d ms → %,8d 則/秒%n",
                N, ms, N * 1000L / Math.max(1, ms));
    }
}
```

```
═══ 1.3.4 基準：channel 完全沒進 confirm 模式 ═══
  ⓪ publisher-confirm-type=none，送 2,000 則 :    42 ms →   47,619 則/秒
```

**然後在 `publisher-confirm-type=correlated` 的 context 裡量三種用法**：

```java
@SpringBootTest(properties = {
        "spring.rabbitmq.publisher-confirm-type=correlated",
        "spring.rabbitmq.template.mandatory=true"
})
class B4ConfirmCostTest {

    @Test
    void theCostOfWaiting() throws Exception {
        int N = 2000;

        // ① 開了 confirm，但完全不理 callback
        long s = System.nanoTime();
        for (int i = 0; i < N; i++) rabbit.convertAndSend("", Q, "fire-" + i);
        long a = (System.nanoTime() - s) / 1_000_000;

        // ② 開了 confirm，全部送完再一起收
        s = System.nanoTime();
        List<CorrelationData> all = new ArrayList<>(N);
        for (int i = 0; i < N; i++) {
            CorrelationData cd = new CorrelationData("b" + i);
            all.add(cd);
            rabbit.convertAndSend("", Q, "batch-" + i, cd);
        }
        long bSend = (System.nanoTime() - s) / 1_000_000;
        int acked = 0;
        for (CorrelationData cd : all) if (cd.getFuture().get(10, TimeUnit.SECONDS).isAck()) acked++;
        long bAll = (System.nanoTime() - s) / 1_000_000;

        // ③ 每一則都等自己的 confirm
        s = System.nanoTime();
        for (int i = 0; i < N; i++) {
            CorrelationData cd = new CorrelationData("s" + i);
            rabbit.convertAndSend("", Q, "sync-" + i, cd);
            cd.getFuture().get(10, TimeUnit.SECONDS);
        }
        long c = (System.nanoTime() - s) / 1_000_000;
        // ... 印出
    }
}
```

**輸出**：

```
═══ 1.3.4 同步等 confirm 的代價 ═══
  ① 開 confirm，但完全不理 callback  :   250 ms →    8,000 則/秒
  ② 開 confirm，全部送完再一起收     :   202 ms →    9,900 則/秒  （送出只花 200 ms，2000 則 ack）
  ③ 每一則都等自己的 confirm         : 1,471 ms →    1,359 則/秒

  ③ 比 ① 慢 5.9 倍，比 ② 慢 7.3 倍
```

📌 **把基準跟這三個放在一起，才看得出真正的故事**：

| 用法 | 吞吐 | 相對基準 | 你得到什麼 |
|---|---|---|---|
| ⓪ `confirm-type: none` | **47,619 則/秒** | 1× | 什麼都不知道（1.3.1） |
| ① `correlated` 但不理 callback | 8,000 則/秒 | **1/6** | 什麼都不知道（callback 沒接） |
| ② `correlated` + 批次收 | 9,900 則/秒 | 1/4.8 | **每一則的成敗都知道** |
| ③ `correlated` + 每則同步等 | 1,359 則/秒 | **1/35** | 同上，但你多付了 7 倍 |

**三個結論**：

1. ⚠️ **光是「把 channel 切到 confirm 模式」就掉了 6 倍**（47,619 → 8,000），
   **而且這 6 倍在 ① 那種寫法裡是白付的** —— 你開了 confirm 卻沒接 callback，
   付了效能卻什麼都沒得到。**這是真實專案裡最常見的狀態。**
2. **② 幾乎不用額外付錢。** 送出只花 200 ms（跟 ① 一樣），
   收 2,000 個 confirm 只多花 2 ms。
   👉 **這才是 confirm 的正確用法**：非同步送、非同步收、用 callback 或 future 收尾。
3. **③ 慢 7 倍，因為每一則都是一次完整的網路往返。**
   1,471 ms / 2,000 則 = **0.74 ms/則** —— 這正好是 00 章 0.5.3 量到的 RabbitMQ 往返延遲量級。

⚠️ **③ 不是「錯的做法」，它是「你需要當場知道結果」時的唯一做法。**
例如 02 章的 Outbox 輪詢器：它要在「訊息確認送出」之後才能把 outbox 那一列標記成已送，
如果它用 ② 的批次做法，就要自己管一份 in-flight 清單。
**1,359 則/秒對一個 outbox 輪詢器綽綽有餘** —— 你的訂單量不會是每秒 1,359 筆。

### 1.3.5 Kafka 這一側：`acks` 三個值

Kafka 的第一段只有一個旋鈕，但它有三段：

| `acks` | producer 等到什麼才算成功 | 遺失情境 |
|---|---|---|
| `0` | **什麼都不等。** 寫進本機的 socket 就回來了 | broker 沒收到、broker 拒絕、leader 換人 —— **全部不知道** |
| `1` | **leader 把訊息寫進自己的 log** 就算成功 | leader 寫了、副本還沒跟上、然後 leader 掛了 → **訊息不存在，而你收到成功** |
| `all`（= `-1`） | **ISR 裡的副本數 >= `min.insync.replicas`** 都寫了才算成功 | ISR 湊不齊時**當場拒絕**你（不是偷偷丟掉） |

```java
    private KafkaProducer<String, String> producer(String acks) {
        Map<String, Object> cfg = new HashMap<>();
        cfg.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, BOOTSTRAP);
        cfg.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        cfg.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        cfg.put(ProducerConfig.ACKS_CONFIG, acks);
        cfg.put(ProducerConfig.DELIVERY_TIMEOUT_MS_CONFIG, 8000);
        cfg.put(ProducerConfig.REQUEST_TIMEOUT_MS_CONFIG, 4000);
        cfg.put(ProducerConfig.RETRIES_CONFIG, 0);       // 先關掉重試，這樣才看得清楚
        return new KafkaProducer<>(cfg);
    }
```

在 Spring 裡是這樣設：

```yaml
spring:
  kafka:
    producer:
      acks: all
      retries: 3
      properties:
        delivery.timeout.ms: 30000
        max.in.flight.requests.per.connection: 5
        enable.idempotence: true      # ⚠️ 09 章會講，它會強制 acks=all
```

📌 **先把預設值搞清楚 —— 這裡有一個很多教學文章都寫錯的地方。**

`kafka-clients` **3.0 之前**的預設是 `acks=1`，網路上絕大多數文章講的是那個版本。
**3.0（KIP-679）之後預設變了**，把本站環境的實際值印出來：

```java
var pc = new ProducerConfig(Map.of(
        ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:19092",
        ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class.getName(),
        ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class.getName()));
System.out.println(pc.getString(ProducerConfig.ACKS_CONFIG));
System.out.println(pc.getBoolean(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG));
// ...
```

```
  kafka-clients 版本              : 3.6.2   （Boot 3.2.5 帶的）
  acks 預設                       : -1      （-1 就是 all）
  enable.idempotence 預設         : true
  retries 預設                    : 2147483647
  delivery.timeout.ms 預設        : 120000
  max.in.flight.requests 預設     : 5
  batch.size 預設                 : 16384
  linger.ms 預設                  : 0

  Spring Boot 有幫你設 acks 嗎    : 沒有（所以就是上面這個客戶端預設）
```

⚠️ **所以在 Boot 3.2.5 上，你什麼都不設就已經是 `acks=all` + 冪等 producer 了。**
這是好事 —— 但它同時製造了一個很隱蔽的陷阱：

**⚠️ 你以為你只調了 `acks`，其實你順便把冪等 producer 關掉了**

| 你寫了什麼 | 解析後的 `acks` | 解析後的 `enable.idempotence` | 結果 |
|---|---|---|---|
| 什麼都不設 | `-1`（all） | **`true`** | ✅ 最安全 |
| 只設 `acks=1` | `1` | **`false`** ← **被靜默關掉** | ⚠️ 沒有任何警告 |
| 只設 `acks=0` | `0` | **`false`** ← 同上 | ⚠️ |
| 只設 `retries=0` | `-1` | **`false`** ← 同上 | ⚠️ |
| `enable.idempotence=true` + `acks=1` | —— | —— | ❌ `ConfigException`，**啟動失敗** |
| `enable.idempotence=true` + `retries=0` | —— | —— | ❌ `ConfigException` |
| `enable.idempotence=true` + `max.in.flight=6` | —— | —— | ❌ `ConfigException` |

實測的錯誤訊息：

```
  什麼都不設（全預設）                    → acks=-1  idempotence(解析後)=true
  只設 acks=1                            → acks=1   idempotence(解析後)=false
  只設 acks=0                            → acks=0   idempotence(解析後)=false
  只設 retries=0                         → acks=-1  idempotence(解析後)=false
  明確 enable.idempotence=true + acks=1   → ❌ ConfigException: Must set acks to all in order to
                                              use the idempotent producer. Otherwise we cannot
                                              guarantee idempotence.
  明確 enable.idempotence=true + retries=0 → ❌ ConfigException: Must set retries to non-zero
                                              when using the idempotent producer.
  明確 enable.idempotence=true + max.in.flight=6 → ❌ ConfigException: Must set
                                              max.in.flight.requests.per.connection to at most 5
                                              to use the idempotent producer.
```

📌 **兩個可以直接用的結論**：

1. **只要你**沒有明確寫 `enable.idempotence`，Kafka 就會在發現衝突時**安靜地把它關掉**。
   有人為了效能把 `acks` 從預設改成 `1` —— 他同時失去了冪等 producer（09 章會講它防的是什麼），
   **而且日誌裡不會有任何一行提到這件事**。
2. **明確寫出來。** 把 `acks`、`retries`、`enable.idempotence`、`max.in.flight.requests.per.connection`
   四個都寫進 `application.yml`。
   這樣：設對了 → 一目了然；設錯了 → **啟動時就 `ConfigException`，而不是上線後掉訊息**。

⚠️ 順便解釋一下 1.3.6 那個實驗的設定：那裡寫了 `acks=0/1` 與 `retries=0`，
所以**冪等 producer 在那三次都是關著的** —— 這正是我要的（要看的是 `acks` 本身的行為）。

### 1.3.6 實測：兩台 broker、拔掉一台 ★★★

⚠️ **這個實驗需要第二台 broker**，`kafka-lab` 那台單節點做不到（理由見 1.3.7）。

**先起一座兩節點的叢集**（跟 `kafka-lab` 並存，不衝突）：

```bash
docker network create mq-lab
CID="5L6g3nShT-eMCtK--X86sw"          # 兩台要用同一個 cluster id

# kafka1：同時是 broker 與 controller
docker run -d --name kafka1 --network mq-lab -p 19101:9092 \
  -e CLUSTER_ID=$CID -e KAFKA_NODE_ID=1 \
  -e KAFKA_PROCESS_ROLES=broker,controller \
  -e KAFKA_LISTENERS=HOST://:9092,INTERNAL://:29092,CONTROLLER://:9093 \
  -e KAFKA_ADVERTISED_LISTENERS=HOST://localhost:19101,INTERNAL://kafka1:29092 \
  -e KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=CONTROLLER:PLAINTEXT,HOST:PLAINTEXT,INTERNAL:PLAINTEXT \
  -e KAFKA_INTER_BROKER_LISTENER_NAME=INTERNAL \
  -e KAFKA_CONTROLLER_QUORUM_VOTERS=1@kafka1:9093 \
  -e KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER \
  -e KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=2 \
  -e KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=2 \
  -e KAFKA_TRANSACTION_STATE_LOG_MIN_ISR=1 \
  -e KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS=0 \
  -e KAFKA_NUM_PARTITIONS=1 apache/kafka:3.8.0

sleep 5

# kafka2：只是 broker（這樣待會兒停掉它，controller 還活著）
docker run -d --name kafka2 --network mq-lab -p 19102:9092 \
  -e CLUSTER_ID=$CID -e KAFKA_NODE_ID=2 \
  -e KAFKA_PROCESS_ROLES=broker \
  -e KAFKA_LISTENERS=HOST://:9092,INTERNAL://:29092 \
  -e KAFKA_ADVERTISED_LISTENERS=HOST://localhost:19102,INTERNAL://kafka2:29092 \
  -e KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=CONTROLLER:PLAINTEXT,HOST:PLAINTEXT,INTERNAL:PLAINTEXT \
  -e KAFKA_INTER_BROKER_LISTENER_NAME=INTERNAL \
  -e KAFKA_CONTROLLER_QUORUM_VOTERS=1@kafka1:9093 \
  -e KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER \
  -e KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=2 \
  -e KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=2 \
  -e KAFKA_TRANSACTION_STATE_LOG_MIN_ISR=1 \
  -e KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS=0 \
  -e KAFKA_NUM_PARTITIONS=1 apache/kafka:3.8.0
```

⚠️ **`KAFKA_PROCESS_ROLES` 這兩行是這個實驗能不能做的關鍵。**
如果把兩台都設成 `broker,controller`、`CONTROLLER_QUORUM_VOTERS=1@kafka1:9093,2@kafka2:9093`，
停掉 kafka2 之後**整個叢集都不能用了**：

```
Error while executing topic command : ... TimeoutException: The request timed out.
```

**因為 KRaft 的 controller 需要「過半數」。** 兩個投票者的過半數是 2 ——
停掉一台就剩 1 台，永遠湊不到 2，controller 直接停擺。
📌 **所以 controller 的數量要是奇數（1、3、5）**，正式環境是 3 或 5。
這一節只要一個 controller 就夠了，所以讓 kafka1 兼任、kafka2 純 broker。

確認兩台都在：

```bash
docker exec kafka1 /opt/kafka/bin/kafka-broker-api-versions.sh \
  --bootstrap-server kafka1:29092 2>/dev/null | grep "id:" | sed 's/ (.*//'
```

```
kafka2:29092
kafka1:29092
```

**現在做實驗。步驟一：建一個 RF=2、`min.insync.replicas=2` 的 topic**

```bash
docker exec kafka1 /opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka1:29092 \
  --create --topic ch01.isr3 --partitions 1 --replication-factor 2 \
  --config min.insync.replicas=2

docker exec kafka1 /opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka1:29092 \
  --describe --topic ch01.isr3
```

```
Topic: ch01.isr3	Partition: 0	Leader: 1	Replicas: 1,2	Isr: 1,2	Elr: 	LastKnownElr:
```

**`Isr: 1,2`** —— 兩個副本都跟上了。用 `acks=all` 送一則，成功：

```bash
echo "m0" | docker exec -i kafka1 /opt/kafka/bin/kafka-console-producer.sh \
  --bootstrap-server kafka1:29092 --topic ch01.isr3 --request-required-acks -1

docker exec kafka1 /opt/kafka/bin/kafka-get-offsets.sh \
  --bootstrap-server kafka1:29092 --topic ch01.isr3 --time latest
```

```
ch01.isr3:0:1
```

**步驟二：把 kafka2 拔掉**

```bash
docker stop kafka2
sleep 15
docker exec kafka1 /opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka1:29092 \
  --describe --topic ch01.isr3
```

```
Topic: ch01.isr3	Partition: 0	Leader: 1	Replicas: 1,2	Isr: 1	Elr: 	LastKnownElr:
```

**`Isr: 1,2` → `Isr: 1`。** ISR 收縮了 —— 現在 `1 < min.insync.replicas(2)`。

**步驟三：用三個 `acks` 值各送一則，並且在送完之後檢查「訊息真的進去了嗎」**

```java
class B6bStepTest {
    static final String BS = "localhost:19101";
    static final String T = "ch01.isr3";

    long endOffset() throws Exception {
        try (AdminClient ac = AdminClient.create(Map.of("bootstrap.servers", BS))) {
            var tp = new TopicPartition(T, 0);
            return ac.listOffsets(Map.of(tp, OffsetSpec.latest())).partitionResult(tp).get().offset();
        }
    }

    void tryOne(String acks) throws Exception {
        long before = endOffset();
        String res;
        try (var p = producer(acks)) {
            var md = p.send(new ProducerRecord<>(T, "v-acks-" + acks)).get();
            res = "✅ 成功 off=" + md.offset();
        } catch (Exception e) {
            Throwable r = e; while (r.getCause() != null) r = r.getCause();
            res = "❌ " + r.getClass().getSimpleName() + ": " + r.getMessage();
        }
        Thread.sleep(500);
        long after = endOffset();
        System.out.printf("  acks=%-4s  %-90s  end offset %d → %d  %s%n",
                acks, res, before, after, after > before ? "(訊息真的進去了)" : "(⚠️ 訊息沒有進去)");
    }

    @Test
    void steps() throws Exception {
        System.out.println("═══ acks 在 ISR 不足的分區上（RF=2、min.insync.replicas=2、Isr=1）═══");
        tryOne("0");
        tryOne("1");
        tryOne("all");
    }
}
```

**輸出**：

```
═══ acks 在 ISR 不足的分區上（RF=2、min.insync.replicas=2、Isr=1）═══
  acks=0     ✅ 成功 off=-1        end offset 1 → 1  (⚠️ 訊息沒有進去)
  acks=1     ✅ 成功 off=3         end offset 1 → 1  (⚠️ 訊息沒有進去)
  acks=all   ❌ NotEnoughReplicasException: Messages are rejected since there are fewer
                in-sync replicas than required.   end offset 1 → 1  (⚠️ 訊息沒有進去)
```

**三行輸出，每一行都要停下來看**：

**① `acks=0` → 「成功」，`off=-1`**

`off=-1` 是「我不知道」的意思 —— **producer 從來沒問過 broker**。
它把訊息寫進 socket 就回來報喜了。`Future` 完成、`RecordMetadata` 有了、業務程式碼繼續往下走。

**② `acks=1` → 「成功」，`off=3` —— 但 end offset 沒有動 ★★★**

這一行是本章最值得記住的一行。它給了你**一個具體的 offset 3**，看起來鐵證如山。

**那則訊息到哪去了？** 直接把 broker 的 log 檔案 dump 出來看：

```bash
docker exec kafka1 /opt/kafka/bin/kafka-dump-log.sh \
  --files /tmp/kafka-logs/ch01.isr3-0/00000000000000000000.log --print-data-log \
  | grep -E "^\| offset"
```

```
| offset: 0 CreateTime: 1789967492200 keySize: -1 valueSize: 2 sequence: 0 headerKeys: [] payload: m0
| offset: 1 CreateTime: 1789967511915 keySize: -1 valueSize: 7 sequence: -1 headerKeys: [] payload: m-acks1
| offset: 2 CreateTime: 1789967547732 keySize: -1 valueSize: 8 sequence: -1 headerKeys: [] payload: v-acks-0
| offset: 3 CreateTime: 1789967548299 keySize: -1 valueSize: 8 sequence: -1 headerKeys: [] payload: v-acks-1
```

⚠️ **訊息真的在磁碟上。** offset 0 到 3，四筆，全部躺在 leader 的 log 檔案裡。
（`v-acks-0` 是 `acks=0` 那則、`v-acks-1` 是 `acks=1` 那則 —— **兩則都寫進去了**。）

**但消費者讀不到**：

```bash
docker exec kafka1 /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server kafka1:29092 --topic ch01.isr3 --from-beginning \
  --timeout-ms 4000 --property print.offset=true
```

```
Offset:0	m0
```

**只有 offset 0。** 那三則在磁碟上、在 leader 上、卻對整個世界不存在。

📌 **原因是 high watermark。**

```
                    leader 的 log            消費者看得到的界線
                  ┌────┬────┬────┬────┐
       offset:    │ 0  │ 1  │ 2  │ 3  │
                  └────┴────┴────┴────┘
                       ▲              ▲
                       │              │
              high watermark = 1     log end offset = 4
              「已經複製到足夠副本」  「leader 自己寫到哪」
                       │
                  消費者只能讀到這裡 ────┘
```

- **log end offset**：leader 本地寫到哪（4）。
- **high watermark（HW）**：**已經複製到足夠副本的位置**（1）。**消費者只能讀到 HW。**
- kafka2 死在 offset 1，之後就再也跟不上了 → **HW 永遠停在 1**。

⚠️ **而且 `kafka-get-offsets --time latest` 回的是 HW，不是 log end offset。**
所以你的 lag 監控也看不到這三則 —— 從監控的角度，**這個 topic 根本沒有新訊息**。

**③ `acks=all` → `NotEnoughReplicasException`**

```
Messages are rejected since there are fewer in-sync replicas than required.
```

**這是三個選項裡唯一誠實的一個。** 它寧可當場拒絕你，也不要給你一個假的成功。
你收到例外 → 你可以重試、可以寫進 outbox、可以告警。**你有得救。**

**步驟四：把 kafka2 插回去 —— 這一步比前面都精彩**

```bash
docker start kafka2
sleep 25
docker exec kafka1 /opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka1:29092 \
  --describe --topic ch01.isr3 | tail -1
docker exec kafka1 /opt/kafka/bin/kafka-get-offsets.sh \
  --bootstrap-server kafka1:29092 --topic ch01.isr3 --time latest
docker exec kafka1 /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server kafka1:29092 --topic ch01.isr3 --from-beginning \
  --timeout-ms 4000 --property print.offset=true
```

```
	Topic: ch01.isr3	Partition: 0	Leader: 1	Replicas: 1,2	Isr: 1,2	Elr: 	LastKnownElr:
ch01.isr3:0:4
Offset:0	m0
Offset:1	m-acks1
Offset:2	v-acks-0
Offset:3	v-acks-1
```

**`Isr: 1` → `Isr: 1,2`，HW 從 1 跳到 4，那三則訊息全部出現了。**

⚠️ **這比「訊息掉了」更難處理，而不是更好。**

| | 如果訊息直接掉了 | 實際發生的（訊息延遲出現） |
|---|---|---|
| 故障期間 | 你會發現有東西不對 | 你的監控**完全正常**（lag 0、無新訊息） |
| 恢復之後 | 沒有東西冒出來 | **三則訊息突然出現**，時間戳是幾分鐘前 |
| 消費者會怎麼反應 | —— | 它按正常流程處理它們 —— 但那已經是**過期的資訊**了 |

**具體一點**：假設那三則是「訂單 9527 已付款」。故障持續 8 分鐘。
這 8 分鐘裡，客服查不到付款、跟客戶說「您還沒付款」、客戶又刷了一次。
8 分鐘後訊息出現，系統處理了第一次付款 —— **現在有兩筆付款**。

**而如果 kafka1 在故障期間也掛掉了呢？** 那三則就真的永遠不見了，
而生產者早就收到「成功」並且把訂單標記成「已通知」。

📌 **所以 `acks=1` 的問題不是「會掉訊息」，而是「它給你的成功是沒有意義的」。**
`acks=1` 的承諾只有一句：**「有一台機器收下了」**。
那台機器掛了、那台機器跟不上、那台機器不再是 leader —— 承諾全部作廢，而你不會知道。

### 1.3.7 為什麼單節點量不出 `acks=all`：`min.insync.replicas` 會被夾住

**我一開始想省事，在 `kafka-lab`（單節點）上做 1.3.6 那個實驗**：
建一個 RF=1 的 topic，把 `min.insync.replicas` 設成 2（ISR 只有 1，應該湊不齊），
然後用 `acks=all` 送 —— 預期它會被拒絕。

```bash
docker exec kafka-lab /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:29092 \
  --create --topic ch01.isr.born --partitions 1 --replication-factor 1 \
  --config min.insync.replicas=2

docker exec kafka-lab /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:29092 \
  --describe --topic ch01.isr.born
```

```
Topic: ch01.isr.born	PartitionCount: 1	ReplicationFactor: 1	Configs: min.insync.replicas=2
	Topic: ch01.isr.born	Partition: 0	Leader: 1	Replicas: 1	Isr: 1	Elr: 	LastKnownElr:
```

設定確實生效了（`Configs: min.insync.replicas=2`），ISR 只有 1 個。用 `acks=all` 送：

```
RESULT: OK  p0 off0
```

**它成功了。** 等 20 秒再試（怕是設定傳播延遲）—— 還是成功。
把 `min.insync.replicas` 設成 3 —— 還是成功。

📌 **原因：Kafka 會把「有效的 `min.insync.replicas`」夾到分區的副本數。**

```
effectiveMinIsr = min(設定的 min.insync.replicas, 這個分區的副本數)
                = min(2, 1)
                = 1
```

ISR 大小是 1，`1 < 1` 不成立 → **不拒絕**。

⚠️ **這不是實驗環境的怪癖，這是一個真實的正式環境陷阱**：

```
情境：團隊在 broker 上設了 min.insync.replicas=2 當叢集預設（很合理）。
      某個服務用 auto-create 或手寫腳本建了一個 replication.factor=1 的 topic。
      程式碼寫了 acks=all（很負責）。
結果：這個 topic 的 acks=all 完全等於 acks=1。
      沒有錯誤、沒有警告、`--describe` 上還看得到 min.insync.replicas=2。
      團隊以為有兩副本的保護，實際上一個都沒有。
```

**怎麼查**：只看 `min.insync.replicas` 沒有用，**要看 `ReplicationFactor`**：

```bash
# 找出所有 RF=1 的 topic —— 這些 topic 上的 acks=all 是假的
docker exec kafka-lab /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:29092 --describe \
  | grep "ReplicationFactor: 1"
```

📌 **這一節真正的教訓，跟 00 章 0.5.1 是同一個**：
**你的可靠性設定，在單節點環境下量不出任何東西。**
`acks=all`、`min.insync.replicas`、`replication.factor` 這三個設定
**只有在「有副本、而且副本會掉」的時候才有行為**。
在你的開發機上，它們三個是裝飾品。

### 1.3.8 第一段的防守表

| 你要防的 | RabbitMQ | Kafka | 代價 |
|---|---|---|---|
| broker 沒收到 | `publisher-confirm-type: correlated` + 處理 nack | `acks=1` 以上 | confirm 模式本身 −6 倍吞吐（1.3.4） |
| 路由不到任何佇列 | `publisher-returns: true` + `template.mandatory: true` | （不適用，Kafka 沒有路由） | 幾乎免費 |
| 收到了但只在一台機器上 | （不適用，RabbitMQ 靠 quorum queue，06 章） | `acks=all` + **`replication.factor >= 3`** + `min.insync.replicas=2` | 寫入延遲增加；ISR 不足時**寫不進去** |
| 送出之後、確認之前行程掛掉 | **confirm 救不了** | **acks 救不了** | 👉 **這是 02 章 Outbox 的工作** |
| 網路斷了、重試造成同一則送兩次 | 無解，要靠消費端冪等 | `enable.idempotence: true`（只保證單一 producer session 內，09 章） | 👉 **這是 03 章的工作** |

⚠️ **請特別看倒數第二列。**
confirm 與 acks 都只能告訴你「這一則到了沒」——
**它們沒辦法處理「你的行程在收到答案之前就死了」。**
那一瞬間你既沒有「已送出」的紀錄，也沒有「送失敗」的紀錄。
**這個缺口只有 Outbox 能補**，所以 02 章是核心章。

---

## 1.4 第二段：broker 自己

第一段防住了：broker 說「我收到了」。**那它會不會弄丟？**

### 1.4.1 實測：四種持久化組合過一次重啟

RabbitMQ 這一段有**兩個**獨立的開關，很多人只知道一個：

| 開關 | 設在哪 | 意思 |
|---|---|---|
| **佇列的 `durable`** | 宣告佇列時 | broker 重啟之後，**這個佇列本身**還在不在 |
| **訊息的 `delivery_mode`** | 每一則訊息上 | `1` = transient（只在記憶體）、`2` = persistent（要寫磁碟） |

⚠️ **兩個都要對。** 只對一個等於沒有 —— 這一節把四種組合都跑一次：

```java
@SpringBootTest
class B7DurabilityTest {

    @Test
    void fourCombinationsAcrossRestart() {
        record Combo(String name, boolean durableQueue, MessageDeliveryMode mode) {}
        Combo[] combos = {
            new Combo("q1.transient-q.transient-m", false, MessageDeliveryMode.NON_PERSISTENT),
            new Combo("q2.transient-q.persistent-m", false, MessageDeliveryMode.PERSISTENT),
            new Combo("q3.durable-q.transient-m",    true,  MessageDeliveryMode.NON_PERSISTENT),
            new Combo("q4.durable-q.persistent-m",   true,  MessageDeliveryMode.PERSISTENT),
        };

        for (Combo c : combos) {
            admin.deleteQueue(c.name());
            admin.declareQueue(new Queue(c.name(), c.durableQueue(), false, false));
            for (int i = 0; i < 1000; i++) {
                final Combo cc = c;
                rabbit.convertAndSend("", c.name(), "m-" + i, m -> {
                    m.getMessageProperties().setDeliveryMode(cc.mode());
                    return m;
                });
            }
        }
        // ... 記錄重啟前的積壓
        sh("docker", "restart", "rabbit-lab");
        waitRabbit();
        // ... 記錄重啟後的積壓
    }
}
```

**輸出**：

```
═══ 1.4.1 佇列持久化 × 訊息持久化 —— 四種組合過一次重啟 ═══
  重啟前：
    q1.transient-q.transient-m     積壓=1,000
    q2.transient-q.persistent-m    積壓=1,000
    q3.durable-q.transient-m       積壓=1,000
    q4.durable-q.persistent-m      積壓=1,000

  重啟後：
    組合                             重啟前          重啟後          結果
    q1.transient-q.transient-m     1,000        (不存在)        ❌ 佇列本身不見了
    q2.transient-q.persistent-m    1,000        (不存在)        ❌ 佇列本身不見了
    q3.durable-q.transient-m       1,000        0            ❌ 掉了 1000 則
    q4.durable-q.persistent-m      1,000        1,000        ✅ 全部還在
```

📌 **四種組合，只有一種安全。整理成表**：

| 佇列 `durable` | 訊息 `delivery_mode` | 重啟後 | 說明 |
|---|---|---|---|
| ❌ | `1` transient | **佇列不見了** | 兩個都沒設 |
| ❌ | `2` persistent | **佇列不見了** | ⚠️ **最容易犯的錯**：訊息設了 persistent，但佇列沒 durable → 佇列都沒了，訊息躺在哪？ |
| ✅ | `1` transient | 佇列在，**訊息 0 則** | ⚠️ **第二容易犯的錯**：佇列 durable 了，但訊息是 transient → 佇列是空的 |
| ✅ | `2` persistent | ✅ **1,000 則全在** | **唯一安全的組合** |

**在 Spring 裡怎麼設**：

```java
@Configuration
public class RabbitTopology {

    @Bean
    Queue orderMailQueue() {
        // new Queue(name, durable, exclusive, autoDelete)
        return new Queue("order.confirm-mail.q", true, false, false);
        //                                      ^^^^ durable
        // 或者：QueueBuilder.durable("order.confirm-mail.q").build();
    }
}
```

```yaml
# 訊息的 delivery_mode：Spring AMQP 預設就是 PERSISTENT，通常不用改
# 但如果有人手動設成 NON_PERSISTENT 換效能，就會踩到上表第三列
```

📌 **好消息：Spring AMQP 的兩個預設都是對的**（`QueueBuilder.durable()` 要明寫，
但 `new Queue(name)` 的單參數版本 `durable` 預設是 `true`；訊息預設是 `PERSISTENT`）。
⚠️ **壞消息：有人會為了效能把它們關掉，而且那個 commit 的訊息通常寫「優化 MQ 效能」。**

⚠️ **`durable` 是佇列的不可變屬性。** 佇列一旦建立，`durable` 就不能改了。
你重新宣告一個同名但 `durable` 不同的佇列，會得到：

```
PRECONDITION_FAILED - inequivalent arg 'durable' for queue 'xxx'
```

而且這個錯誤會**把整條 channel 關掉**。要改只能先刪掉佇列（連同裡面的訊息）。
👉 **04 章 4.6 會講「拓撲宣告該寫在哪、怎麼安全地改」。**

### 1.4.2 ⚠️ 「persistent」不等於「已經在磁碟上」

上一節用的是 `docker restart` —— 那是 **`SIGTERM`，優雅關閉**。
RabbitMQ 收到 `SIGTERM` 會把記憶體裡的東西全部刷到磁碟再退出。

**真實的故障不會這麼客氣。** 機器斷電、OOM killer、`kill -9`、雲端主機被回收 ——
這些是 `SIGKILL`，行程**當場消失**，沒有任何收尾機會。

```java
@Test
void persistentIsNotFsync() {
    admin.declareQueue(new Queue(Q, true, false, false));     // durable queue

    int N = 50_000;
    long s = System.nanoTime();
    for (int i = 0; i < N; i++) {
        rabbit.convertAndSend("", Q, "payload-" + i, m -> {
            m.getMessageProperties().setDeliveryMode(MessageDeliveryMode.PERSISTENT);
            return m;
        });
    }
    long sendMs = (System.nanoTime() - s) / 1_000_000;

    // 不等、不 sleep，立刻 SIGKILL —— 這就是「機器斷電 / OOM killer / kill -9」
    sh("docker", "kill", "-s", "KILL", "rabbit-lab");
    sh("docker", "start", "rabbit-lab");
    waitRabbit();
    // ... 數還剩幾則
}
```

**輸出**：

```
═══ 1.4.2 「persistent」不等於「已經在磁碟上」 ═══
  送了 50,000 則 durable queue + persistent message，耗時 719 ms
  ⚡ 立刻 docker kill -s KILL rabbit-lab（不給它機會優雅關閉）

  送出         : 50,000 則（全部回傳成功、0 個例外）
  重啟後還在   : 49,154 則
  掉了         : 846 則（1.7%）
```

⚠️ **`durable` 佇列 + `persistent` 訊息，還是掉了 846 則。**

**為什麼？** 因為 `persistent` 的意思是「**請你**寫到磁碟」，不是「**已經**在磁碟上」：

```
convertAndSend() 回傳
        │
        ▼
  ┌──────────────────────────────────────────────────┐
  │ ① 訊息在你的 JVM 的 socket 緩衝區                 │  ← 沒開 confirm 的話，你只知道到這裡
  │ ② 訊息在網路上                                    │
  │ ③ 訊息在 broker 的記憶體                          │
  │ ④ 訊息在 broker 排隊等著寫磁碟                     │  ← SIGKILL 打在這裡 = 掉
  │ ⑤ 訊息交給 OS（write()，在 page cache 裡）        │  ← 主機斷電打在這裡 = 掉
  │ ⑥ 訊息真的在磁碟上（fsync 完成）                   │  ← 到這裡才真的安全
  └──────────────────────────────────────────────────┘
                     │
                     ▼
              broker 送出 confirm
```

**RabbitMQ 不會每一則都 fsync 一次** —— 它是批次落盤的。
理由很直接：1.4.3 會量給你看，**等到「真的安全了」才回報，送 50,000 則的時間從 719 ms 變成 4,660 ms
（69,500 → 10,700 則/秒）**。
那 846 則就是**死在 ④ / ⑤ 的那一批**。

⚠️ **這裡刻意不給「它每隔幾毫秒 fsync 一次」的數字** ——
那個行為跟版本、佇列型別（classic / quorum）、訊息大小、磁碟都有關，
背一個數字沒有意義。**你需要的是下一節那個可以自己量的分界線。**

### 1.4.3 那 confirm 呢？

**這才是 publisher confirm 真正的價值** —— 它不只是「broker 收到了」，
**它是「broker 保證這則訊息已經安全了」**。

同一個實驗，這次**等到所有 confirm 都回來之後才 kill**：

```java
@SpringBootTest(properties = {
        "spring.rabbitmq.publisher-confirm-type=correlated",
        "spring.rabbitmq.template.mandatory=true"
})
class C2FsyncWithConfirmTest {

    @Test
    void waitForConfirmThenKill() throws Exception {
        admin.declareQueue(new Queue(Q, true, false, false));

        int N = 50_000;
        List<CorrelationData> all = new ArrayList<>(N);
        long s = System.nanoTime();
        for (int i = 0; i < N; i++) {
            CorrelationData cd = new CorrelationData("c" + i);
            all.add(cd);
            rabbit.convertAndSend("", Q, "payload-" + i, m -> {
                m.getMessageProperties().setDeliveryMode(MessageDeliveryMode.PERSISTENT);
                return m;
            }, cd);
        }
        long sendMs = (System.nanoTime() - s) / 1_000_000;

        int acked = 0;
        for (CorrelationData cd : all)
            if (cd.getFuture().get(30, TimeUnit.SECONDS).isAck()) acked++;
        long allMs = (System.nanoTime() - s) / 1_000_000;

        sh("docker", "kill", "-s", "KILL", "rabbit-lab");     // 收完 ack 之後才殺
        sh("docker", "start", "rabbit-lab");
        waitRabbit();
        // ... 數還剩幾則
    }
}
```

**輸出**：

```
═══ 1.4.3 等到 confirm 才算數，再 kill 一次 ═══
  送出 50,000 則（4,660 ms），收到 50,000 個 ack（累計 4,663 ms）
  ⚡ 收完 ack 之後才 docker kill -s KILL

  收到 ack 的   : 50,000 則
  重啟後還在    : 50,000 則
  掉了          : 0 則（0.00%）
```

📌 **把 1.4.2 跟 1.4.3 擺在一起，這就是第二段的全部**：

| | 1.4.2 沒等 confirm | 1.4.3 等到 confirm |
|---|---|---|
| 送出 50,000 則的耗時 | **719 ms** | **4,660 ms**（慢 6.5 倍） |
| `SIGKILL` 之後還在 | 49,154 則 | **50,000 則** |
| 掉了 | 846 則（**1.7%**） | **0 則** |

**那 6.5 倍的價差，買到的就是那 1.7%。**

⚠️ **請注意這 1.7% 的性質**：它不是「平均每 59 則掉 1 則」，
它是「**最後那 846 則**一起掉」—— 是**尾端的一整段**。
所以「1.7% 感覺還好」是錯的直覺：如果那一秒剛好是雙十一零點，
那 846 則就是**連續 846 張訂單的通知**，而且它們的 ID 是連號的。

📌 **實務上怎麼選**：

| 訊息的性質 | 建議 |
|---|---|
| 掉了會少收錢 / 使用者會客訴（付款通知、訂單狀態） | **等 confirm**，而且要搭 Outbox（02 章） |
| 掉了會少一筆統計（點擊事件、瀏覽紀錄） | 不等 confirm，用批次收（1.3.4 的用法 ②） |
| 掉了完全無所謂（debug log） | 連 persistent 都不用開 |

### 1.4.4 Kafka 這一側：它根本不 fsync

⚠️ **Kafka 的預設是「完全不主動 fsync」。**

```properties
# Kafka broker 的預設值
log.flush.interval.messages = 9223372036854775807   # Long.MAX_VALUE = 永遠不因為訊息數而 flush
log.flush.interval.ms       = null                   # 也不因為時間而 flush
```

**它把落盤這件事完全交給 OS。** 訊息 `write()` 進 page cache 就算完成，
真正寫到磁碟是 OS 自己決定的（通常是幾十秒後）。

**那它憑什麼說自己可靠？**

📌 **Kafka 的答案是：不靠磁碟，靠副本。**

```
RabbitMQ 的思路：  「寫到磁碟上就安全了」   → 單機可靠 → fsync 是關鍵
Kafka 的思路：     「寫到 3 台機器就安全了」 → 分散可靠 → fsync 不是關鍵
```

「三台機器同時斷電」的機率，遠低於「一台機器斷電」。
所以 Kafka 用 `acks=all` + `replication.factor=3` + `min.insync.replicas=2`
換掉了 fsync 的成本 —— **這就是它吞吐比 RabbitMQ 高的原因之一**。

⚠️ **但這個設計有一個前提：那三台機器要是「真的不同的機器」。**

```
❌ 三個 broker 跑在同一台實體機（同一個電源、同一顆硬碟）→ 副本是假的
❌ 三個 broker 跑在同一個 AZ → 整個 AZ 掛掉就全沒了
✅ 三個 broker 跨三個 AZ（Kafka 的 rack awareness：broker.rack）
```

📌 **1.3.7 那個坑在這裡再出現一次，而且更嚴重**：
`replication.factor=1` 的 topic **在 Kafka 上完全沒有持久化保證** ——
既沒有 fsync，也沒有副本。broker 一掛，page cache 裡的東西就沒了。

### 1.4.5 第二段的防守表

| | RabbitMQ | Kafka |
|---|---|---|
| **基本盤** | 佇列 `durable=true` + 訊息 `delivery_mode=2` | `replication.factor >= 3` |
| **「已經安全了」的訊號** | publisher confirm 回來 | `acks=all` 的回應回來 |
| **它真的落盤了嗎** | 是（confirm 之後） | **不一定**，但它在 2 台以上機器的記憶體裡 |
| **代價** | 吞吐 ÷ 6.5（1.4.3） | 寫入延遲增加、磁碟用量 × 3 |
| **還是會掉的情況** | 磁碟壞掉（要靠 quorum queue，06 章） | ISR 裡的機器同時掛掉 |
| **最常見的設定錯誤** | 佇列忘了 `durable`（1.4.1 表第二列） | `replication.factor=1`（1.3.7） |

---

## 1.5 第三段：broker → 消費者

前兩段都防住了：訊息安穩地躺在 broker 上。**現在把它交出去。**

⚠️ **這一段是三段裡最容易出事的**，因為它同時有兩個方向的風險：
**確認太早**（事情沒做完就說做完了 → 遺失）、**確認太晚**（事情做完了但沒說 → 重複）。

### 1.5.1 一則訊息的三種狀態：`ready` / `unacked` / 消失 ★★

**很多人以為佇列裡的訊息只有「在」跟「不在」兩種狀態。實際上有三種。**

```java
@SpringBootTest
class B9ThreeStatesTest {

    static final String Q = "ch01.states.q";

    /** 直接用 rabbitmqctl 讀三個數字 */
    static void states(String label) {
        // docker exec rabbit-lab rabbitmqctl -q list_queues \
        //     name messages_ready messages_unacknowledged messages
        // ... 取出 ch01.states.q 那一行
    }

    @Test
    void threeStates() throws Exception {
        admin.declareQueue(new Queue(Q, true, false, false));
        for (int i = 0; i < 100; i++) rabbit.convertAndSend("", Q, "job-" + i);
        states("① 送了 100 則");

        // 用一條「自己管」的原生連線，才能明確控制它什麼時候斷
        ConnectionFactory cf = new ConnectionFactory();
        cf.setHost("localhost"); cf.setPort(5673); cf.setUsername("lab"); cf.setPassword("lab");
        Connection conn = cf.newConnection();
        var ch = conn.createChannel();

        int got = 0;
        for (int i = 0; i < 30; i++) if (ch.basicGet(Q, false) != null) got++;   // 不 ack
        states("② 拿了 " + got + " 則但不 ack");

        conn.close();          // 這就是「消費者行程掛掉」
        states("③ 連線斷掉之後");

        // 對照組：auto ack
        var conn2 = cf.newConnection();
        var ch2 = conn2.createChannel();
        int got2 = 0;
        for (int i = 0; i < 30; i++) if (ch2.basicGet(Q, true) != null) got2++;  // auto ack
        states("④ 換成 autoAck=true 拿 " + got2 + " 則");
        conn2.close();
        states("⑤ 連線斷掉之後");
    }
}
```

**輸出**：

```
═══ 1.5.1 一則訊息的三種狀態：ready / unacked / 消失 ═══
  ① 送了 100 則                         ready=100    unacked=0      total=100
  ② 拿了 30 則但不 ack                    ready=70     unacked=30     total=100
  ③ 連線斷掉之後                           ready=100    unacked=0      total=100
  ④ 換成 autoAck=true 拿 30 則           ready=70     unacked=0      total=70
  ⑤ 連線斷掉之後                           ready=70     unacked=0      total=70
```

**逐行解讀，這五行是第三段的全部**：

| | `ready` | `unacked` | `total` | 意思 |
|---|---|---|---|---|
| ① | 100 | 0 | 100 | 一百件待辦，沒人領 |
| ② | 70 | **30** | 100 | **30 件被領走了，但還沒交回來** ← 第三種狀態 |
| ③ | **100** | 0 | 100 | 領的人跑了 → **30 件全部回到待辦** ✅ |
| ④ | 70 | **0** | **70** | auto-ack：領走的同時就當作做完了 |
| ⑤ | 70 | 0 | 70 | 領的人跑了 → **那 30 件不會回來** ❌ |

📌 **`unacked` 是「broker 幫你記住的『這件事還沒做完』」。這就是手動 ack 的全部價值。**

⚠️ **關於 `unacked` 有三件事一定要知道**：

1. **它幾乎不會逾時 —— 但「幾乎」不是「不會」，而這個區別很重要。**

   RabbitMQ 有一個 `consumer_timeout`。先看本站這台的實際值：

   ```bash
   docker exec rabbit-lab rabbitmqctl -q eval \
     '{ok,V}=application:get_env(rabbit,consumer_timeout), V.'
   ```

   ```
   1800000
   ```

   **30 分鐘。** 超過就把你的 channel 砍掉。

   ⚠️ **這個值 3.8.15 之後才有預設，而且很多舊文章還在說「broker 會永遠等你」——
   那是錯的。**

   把它調小成 8 秒（寫進 `/etc/rabbitmq/rabbitmq.conf` 再重啟）來看真正的行為：

   ```
   ── A：basic.get（拉模式），拿 5 則不 ack ──
     拿完立刻        : ready=5 unacked=5
     過了  5 秒      : ready=5 unacked=5
     過了 10 秒      : ready=5 unacked=5
     channel 還開著嗎 : true                  ← 完全不受影響

   ── B：basic.consume（推模式）+ prefetch=5，收到不 ack ──
     訂閱後立刻      : ready=5 unacked=5
     過了  10 秒     : ready=5 unacked=5   channel 開著=true
     過了  20 秒     : ready=5 unacked=5   channel 開著=true
     ...
     過了  50 秒     : ready=5 unacked=5   channel 開著=true
     過了  60 秒     : ready=10 unacked=0  channel 開著=false     ← 被砍了
     channel 關閉原因 : PRECONDITION_FAILED - delivery acknowledgement on channel 1
                       timed out. Timeout value used: 8000 ms.
   ```

   📌 **三件事要記住**：

   | | |
   |---|---|
   | **`basic.get`（拉模式）完全不受 `consumer_timeout` 管** | 本節①～③那個實驗用的就是 `basicGet`，所以它真的可以放到永遠 |
   | **`basic.consume`（推模式）會被砍** —— 而 `@RabbitListener` 用的就是推模式 | 你正式環境的消費者全部屬於這一類 |
   | ⚠️ **觸發時間比設定值粗糙很多**：設 8 秒，實際在約 60 秒才砍 | broker 是**週期性**檢查的，所以不要把 `consumer_timeout` 當精準的逾時控制 |

   **被砍之後發生什麼**：channel 關閉、`unacked` 的 5 則**全部回到 `ready`**（`ready=10`）——
   訊息沒掉，但那 5 則會**重新被處理一次**（→ 03 章的冪等又要上場了）。

   ⚠️ **這件事在實務上最常以這個形狀出現**：
   某個消費者處理一則訊息要跑 40 分鐘（大批次報表、呼叫很慢的第三方）。
   30 分鐘到 → channel 被砍 → 訊息回到佇列 → 重新處理 → 又跑 30 分鐘被砍 →
   **永遠跑不完，而且每一輪都做了一半的副作用。**
   📌 **解法不是把 `consumer_timeout` 調大**，是把長工作拆小或改成「收到訊息 → 記一筆任務 → 立刻 ack」。

   **而在那 30 分鐘之內，`unacked` 就是一個黑洞**：
   一個卡死（但 TCP 還連著）的消費者，可以讓幾千則訊息停在 `unacked` 長達半小時。
   **監控上這些訊息不在 `ready` 裡，所以「積壓」看起來很健康。**
   👉 **`messages_unacknowledged` 是第二個一定要監控的數字**（第一個是 `ready`）。

2. **它的上限由 prefetch 決定。** 一個消費者最多能同時有幾則 `unacked`，
   就是 `prefetch`（`spring.rabbitmq.listener.simple.prefetch`，Boot 預設 250）。
   👉 **05 章整節在講這個數字，它同時影響吞吐、公平性、與故障時的損失範圍。**

3. **`unacked` 的訊息回到佇列時，位置在前面（`ready` 從 70 變回 100）**，
   而且 `redelivered` 旗標會變成 `True`。
   👉 03 章的去重、06 章的重試計數都要用到它。

**在 Spring 裡怎麼設手動 ack**：

```yaml
spring:
  rabbitmq:
    listener:
      simple:
        acknowledge-mode: manual      # 預設是 auto
```

```java
@RabbitListener(queues = "order.confirm-mail.q")
public void onMessage(OrderCreated event, Channel channel,
                      @Header(AmqpHeaders.DELIVERY_TAG) long tag) throws IOException {
    try {
        mailService.sendConfirm(event);              // 先做事
        channel.basicAck(tag, false);                // 做完才 ack
    } catch (TransientException e) {
        channel.basicNack(tag, false, true);         // 暫時性失敗 → 放回佇列
    } catch (Exception e) {
        channel.basicNack(tag, false, false);        // ⚠️ requeue=false → 進死信（06 章）
    }
}
```

⚠️ **`acknowledge-mode` 的三個值，差別比名字看起來大**：

| 值 | 行為 | 什麼時候用 |
|---|---|---|
| `none` | **等於 auto-ack**，broker 送出去就當完成 | 只有「掉了無所謂」的資料 |
| `auto`（Boot 預設） | Spring 幫你 ack：方法正常回傳 → ack、丟例外 → nack**並 requeue** | ⚠️ 這個預設就是 00 章 0.5.2 那個風暴的來源 |
| `manual` | 你自己呼叫 `basicAck` / `basicNack` | 需要精確控制重試與死信時 |

📌 **`auto` 這個名字很誤導。** 它**不是** auto-ack（`none` 才是）。
它是「Spring 根據你的方法有沒有丟例外幫你決定」。
**它其實是安全的**（事情做完才 ack），問題只在失敗時的預設 `requeue=true`。
👉 大多數專案用 `auto` + `default-requeue-rejected: false` + DLX 就夠了（06 章）。

### 1.5.2 Kafka：自動提交把沒處理的也提交了，而 `lag = 0` ★★★

Kafka 這一段的機制完全不同：**沒有「一則一則 ack」，只有「我讀到第幾行了」。**

```java
@Test
void kafkaAutoCommitLosesIt() throws Exception {
    String t = "ch01.autocommit." + System.currentTimeMillis();
    String g = "autocommit-g";
    kafkaAdmin.createOrModifyTopics(TopicBuilder.name(t).partitions(1).replicas(1).build());
    for (int i = 0; i < 300; i++) kafka.send(t, "job-" + i).get();

    Map<String, Object> cfg = new HashMap<>();
    // ... bootstrap / deserializer / group
    cfg.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
    cfg.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, true);        // ← 原生 Kafka 的預設
    cfg.put(ConsumerConfig.AUTO_COMMIT_INTERVAL_MS_CONFIG, 200);
    cfg.put(ConsumerConfig.MAX_POLL_RECORDS_CONFIG, 300);

    int processed = 0;
    try (KafkaConsumer<String, String> c = new KafkaConsumer<>(cfg)) {
        c.subscribe(List.of(t));
        ConsumerRecords<String, String> rs;
        do { rs = c.poll(Duration.ofMillis(500)); } while (rs.isEmpty() && ...);
        System.out.printf("  一次 poll 拿到 %d 則%n", rs.count());

        for (var r : rs) {
            if (processed >= 50) break;         // 處理 50 則之後「行程掛掉」
            processed++;
            if (processed == 50) sleep(400);    // 這 400ms 裡，背景的自動提交跑了
        }
    }
    probe.lag(t, g);

    // 新的消費者接手，從已提交的位移開始
    // ...
}
```

**輸出**：

```
═══ 1.5.2 Kafka：自動提交位移，把「還沒處理」的也一起提交了 ═══
  [kafka ] ch01.autocommit.1789967762197 分區=1   總訊息數=300      p0=300
  一次 poll 拿到 300 則
  真正處理完 50 則，然後行程被 kill
  [kafka ] ch01.autocommit.1789967762197 group=autocommit-g   lag=0       p0: 300/300

  ── 新的消費者接手，從已提交的位移開始 ──
  新消費者收到 0 則

  總共 300 則：處理了 50 則、接手處理 0 則 → 250 則永遠沒有人處理
```

⚠️ **250 則訊息永遠不會有人處理，而 `lag = 0`。**

**為什麼？** 因為 `enable.auto.commit=true` 的提交時機是**「下一次 `poll()` 的時候，
把上一次 `poll()` 回傳的最後位移提交掉」** —— 它完全不管你處理到哪裡。

```
  poll() 回傳 300 則  ─────────────────────────────────▶ offset 0..299
       │
       ├─ 你處理第 1 則
       ├─ 你處理第 2 則
       │   ...
       ├─ 你處理第 50 則
       │
       │   （背景執行緒：時間到了，提交 offset 300）  ← ⚠️ 就在這裡
       │
       ╳  行程被 kill
                                    ↓
                       下一個消費者從 offset 300 開始
                       offset 50..299 這 250 則：沒有人處理過，也沒有人會處理
```

📌 **這個故障最惡毒的地方是 `lag = 0`。**

`p0: 300/300` 的意思是「已提交位移 300 / 分區最後位移 300」。
**從 Kafka 的角度，這個 consumer group 完美跟上了。**
你的 Grafana 上那條 lag 曲線是一條完美的零線。

**正確的做法**：

```yaml
spring:
  kafka:
    consumer:
      enable-auto-commit: false      # 明確寫出來（理由見下方）
    listener:
      ack-mode: record               # 或 batch（Spring 預設）
```

📌 **好消息：用 `@KafkaListener` 的話，Spring 的預設是安全的。**
但**它安全的方式跟你想的不一樣**，這個細節值得花三十秒看清楚：

```java
// 印出 ConsumerFactory 裡有什麼
cf.getConfigurationProperties().get(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG)
```

```
  ConsumerFactory 裡的 enable.auto.commit : (沒設 → 客戶端預設 true)
```

⚠️ **`ConsumerFactory` 根本沒設它。** 那為什麼是安全的？
把 Kafka 客戶端自己印的設定抓出來看：

```
2026-09-21T16:55:11.542+08:00  INFO  o.a.k.clients.consumer.ConsumerConfig : ConsumerConfig values:
	auto.commit.interval.ms = 5000
	enable.auto.commit = false           ← 被改掉了
```

📌 **是 `KafkaMessageListenerContainer` 在建立 consumer 的那一刻把它覆寫成 `false` 的**
（條件是：你自己沒有明確設過它）。
然後改由容器在**你的 listener 方法正常回傳之後**才提交。

⚠️ **這個區別有實際後果**：

| 你怎麼拿 consumer | `enable.auto.commit` 實際是 | 安全嗎 |
|---|---|---|
| `@KafkaListener`（容器幫你建） | **`false`**（容器覆寫） | ✅ |
| `consumerFactory.createConsumer()`（自己建、自己 `poll()`） | **`true`**（沒人覆寫） | ❌ **就是 1.5.2 那個實驗** |
| `new KafkaConsumer<>(props)`（完全自己來） | **`true`** | ❌ |

👉 **所以「Spring 幫我處理好了」只在你用 `@KafkaListener` 的時候成立。**
一旦你為了寫一支批次工具而自己 `createConsumer()`，防護就沒了 —— 而且**沒有任何警告**。
📌 **這就是為什麼上面那段 yaml 還是要把 `enable-auto-commit: false` 明確寫出來**：
它讓兩條路徑的行為一致。

| `ack-mode` | 什麼時候提交 | 遺失風險 | 重複風險 |
|---|---|---|---|
| `RECORD` | 每一則處理完就提交 | 最低 | 有（提交前掛掉 → 這一則重來） |
| `BATCH`（Spring 預設） | 一整批 `poll()` 都處理完才提交 | 低 | 有（整批重來） |
| `MANUAL` / `MANUAL_IMMEDIATE` | 你自己呼叫 `ack.acknowledge()` | 看你怎麼寫 | 看你怎麼寫 |
| `TIME` / `COUNT` | 每隔 N 毫秒 / N 則 | ⚠️ **有**（跟自動提交同一類問題） | 有 |

⚠️ **但 `enable.auto.commit=true` 還是很容易出現在真實專案裡**，三個來源：

1. **不是用 `@KafkaListener`，而是自己寫 `KafkaConsumer`**（例如寫在 `@Scheduled` 裡的批次工具）。
   原生客戶端的預設就是 `true`。
2. **有人為了「效能」手動打開它。**
3. **從別的框架 / 別的語言的範例複製過來的設定。**

👉 **08 章整章在講這件事**：提交時機、rebalance 造成的重複、`max.poll.interval.ms` 踢人。

### 1.5.3 兩邊的第三段對照

| | RabbitMQ | Kafka |
|---|---|---|
| 確認的單位 | **一則**（`delivery_tag`） | **一個位置**（offset） |
| 能不能跳著確認 | 可以（第 5 則 ack、第 3 則還在 unacked） | **不行**。提交 offset 100 = 宣稱 0..99 全部做完了 |
| 「處理中」有沒有狀態 | 有（`unacked`） | **沒有**。offset 之後的全部算「還沒做」 |
| 消費者掛掉之後 | `unacked` 的立刻回到 `ready` | 等 `session.timeout.ms` 觸發 rebalance（08 章） |
| 失敗的那一則怎麼辦 | `basicNack` → requeue 或死信 | ⚠️ **沒有內建機制**。你只能：跳過、無限重試、或自己送進死信 topic（10 章） |

⚠️ **「不能跳著確認」是 Kafka 第三段最大的限制。**
一批 100 則裡第 50 則是毒藥訊息，你不能「確認其他 99 則、只留這一則」——
你只能停在 offset 49（整批重來）或跳過它（那一則就沒了）。
👉 **10 章的「重試主題階梯」就是為了解決這件事。**

### 1.5.4 第三段的防守表

| 你要防的 | RabbitMQ | Kafka |
|---|---|---|
| 拿到了但沒做完就掛掉 | `acknowledge-mode: manual`（或 `auto`），**做完才 ack** | `enable-auto-commit: false`（Spring 預設），**做完才提交** |
| 做完了但 ack 丟了 → 重複 | **無解** → 冪等消費（03 章） | **無解** → 冪等消費（03 章） |
| 一直失敗的毒藥訊息 | `default-requeue-rejected: false` + DLX（06 章） | 重試主題 + 死信主題（10 章） |
| 消費者卡死但連線還在 | 監控 `messages_unacknowledged` | 監控 `max.poll.interval.ms` 踢人事件（08 章） |
| 一批裡只有一則壞掉 | 分開 ack，沒問題 | ⚠️ **做不到**，要靠重試主題 |

---

## 1.6 「不重不漏」為什麼做不到

三段都防住了，那可以「不重不漏」了嗎？**不行。** 這一節解釋為什麼。

### 1.6.1 三種投遞語意

| 語意 | 保證 | 怎麼做到 | 代價 |
|---|---|---|---|
| **at-most-once**（最多一次） | 不會重複，**可能會漏** | 先確認、再處理 | 漏掉的沒有任何紀錄 |
| **at-least-once**（至少一次） | 不會漏，**可能會重複** | 先處理、再確認 | 重複要靠消費端處理（03 章） |
| **exactly-once**（精確一次） | 不重不漏 | —— | 見 1.6.2 |

**前兩個的差別只有一行程式碼的順序**：

```java
// at-most-once：先 ack，再做事
channel.basicAck(tag, false);
mailService.sendConfirm(event);        // ← 這裡掛掉：訊息沒了、信沒寄

// at-least-once：先做事，再 ack
mailService.sendConfirm(event);
channel.basicAck(tag, false);          // ← 這裡掛掉：信寄了、訊息回到佇列 → 再寄一次
```

📌 **兩行程式碼中間那個縫，就是整個問題的所在。**
不管你把 ack 放在前面還是後面，**那一瞬間的崩潰都會造成不一致** ——
差別只在於「不一致的方向」。

### 1.6.2 為什麼 exactly-once 在跨系統時不存在

「精確一次」需要**「處理業務」與「確認訊息」是同一個原子操作**。

```
        你的資料庫                        broker
        ┌──────────┐                   ┌──────────┐
        │ 寄信紀錄  │                   │ ack 訊息  │
        └──────────┘                   └──────────┘
             ▲                              ▲
             └────────── 這兩件事 ────────────┘
                     必須「一起成功或一起失敗」
```

**這是分散式交易。** 要做到它，你需要：

- **兩階段提交（2PC）**：需要 broker 支援 XA。⚠️ **兩個都沒有** ——
  RabbitMQ 的 `tx.select` / `tx.commit` 是**單一 channel 的本地交易**，不是 XA
  （Spring 的 `RabbitTransactionManager` 文件也明講它無法提供 XA）；
  Kafka 的交易則只在 Kafka 內部（09 章 9.3）。
- **或者：把兩件事放進同一個儲存體。**
  👉 這正是 **Kafka 交易**做到的事（09 章）：
  「消費 topic A → 處理 → 寫入 topic B → 提交 offset」可以是一個原子操作 ——
  **因為 offset 本身就存在 Kafka 裡的一個 topic**。

⚠️ **所以 Kafka 的「精確一次」有一個大家常常忽略的邊界**：

```
✅ Kafka → Kafka：可以精確一次（09 章的交易 + read_committed）
❌ Kafka → 你的 MySQL：做不到
❌ Kafka → 寄一封信：做不到（信寄出去了就收不回來）
❌ Kafka → 呼叫別人的 API：做不到
```

📌 **而後面三種，正好是你 99% 的消費者在做的事。**

**唯一實務上可行的路線**：

> **at-least-once + 冪等消費 = 效果上的 exactly-once**

- **傳輸層**：保證不漏（先處理再確認）→ 接受重複。
- **業務層**：讓「處理兩次」跟「處理一次」的結果一樣 → 重複變得無害。

👉 **03 章整章在做這件事。**

### 1.6.3 所以你該選哪一個

| 訊息的性質 | 選哪個 | 怎麼做 |
|---|---|---|
| 扣款、發券、扣庫存、寄信 | **at-least-once + 冪等** | 三段全防 + 03 章的去重 |
| 訂單狀態同步、資料複寫 | **at-least-once + 冪等** | 同上；而且通常天然冪等（`UPDATE ... SET status = 'PAID'`） |
| 點擊事件、瀏覽紀錄、APM 指標 | **at-most-once** 也可以 | 不開 confirm、auto-ack，換吞吐 |
| 心跳、即時看板的數字 | **at-most-once** | 掉了下一秒就補上了 |

⚠️ **最後提醒一次**：這張表選的是**預設立場**，不是全有全無。
同一個系統裡不同的 topic 可以有不同的語意 ——
`order.paid.v1` 用最嚴的設定、`user.pageview.v1` 用最鬆的。
**把所有東西都調到最嚴，你付的是 1.4.3 那 6.5 倍的價錢，而且是對全部訊息付。**

---

## 1.7 三段 × 兩個 broker 的總表

📌 **這是本章的產出。後面 04～09 章的每一個設定項，都可以在這張表上找到位置。**

| 段 | 問題 | RabbitMQ 的手段 | Kafka 的手段 | 代價（實測） | 在哪一章展開 |
|---|---|---|---|---|---|
| **①** | broker 沒收到 | `publisher-confirm-type: correlated` | `acks=1` 以上 | 吞吐 47,619 → 8,000（1.3.4） | 05 / 07 |
| **①** | 路由不到佇列 | `publisher-returns` + `mandatory` | （不適用） | 幾乎免費 | 04 / 05 |
| **①** | 只寫進一台機器 | （見 quorum queue） | `acks=all` + RF≥3 + `min.insync.replicas=2` | ISR 不足時**寫不進去**（1.3.6） | 06 / 07 |
| **①** | 送出前行程掛掉 | ❌ 防不住 | ❌ 防不住 | —— | **02（Outbox）** |
| **①** | 重試造成重送 | ❌ 防不住 | `enable.idempotence`（僅限單 session） | —— | **03 / 09** |
| **②** | broker 重啟 | 佇列 `durable` + 訊息 `delivery_mode=2` | RF ≥ 3 | 1.4.1：四種組合只有一種安全 | 05 / 07 |
| **②** | broker 被 `kill -9` | **等 confirm 才算數** | `acks=all` | 719 ms → 4,660 ms（1.4.3） | 05 / 07 |
| **②** | 磁碟壞掉 | quorum queue | RF ≥ 3 跨 AZ | 寫入延遲、磁碟 ×3 | 06 / 07 |
| **③** | 拿了但沒做完 | `acknowledge-mode: manual`，做完才 ack | `enable-auto-commit: false`（Spring 預設） | 1.5.2：250/300 則無聲遺失 | 05 / 08 |
| **③** | 做完了但 ack 丟了 | ❌ 防不住 | ❌ 防不住 | —— | **03（冪等）** |
| **③** | 毒藥訊息 | `default-requeue-rejected: false` + DLX | 重試主題 + 死信主題 | 06 章的退避階梯 | 06 / 10 |
| **③** | 消費者卡死 | 監控 `messages_unacknowledged` | `max.poll.interval.ms` | 08 章的踢人事件 | 05 / 08 |

**讀這張表的方式**：

- **有 ❌ 的那四列，是這一章防不住的。** 它們各自有一整章：02（Outbox）、03（冪等）。
- **「代價」那一欄要記住。** 每一個防守都有價格，而且價格差很多（從「免費」到「÷6.5」）。
- **最右欄是你的索引。** 之後讀 05 章讀到 `prefetch` 的時候，回來看這張表的第三段。

---

## 1.8 常見誤區

**① 「`convertAndSend()` 沒丟例外，就是送成功了」**

1.3.1 實測：routing key 少一個字母，**500 則回傳成功、0 個例外、訊息全部被丟掉**。
`convertAndSend()` 是 `void`，AMQP 的 `basic.publish` **協定上就沒有回應**。
📌 **沒開 confirm 的話，你手上沒有任何「送成功」的證據。**

**② 「開了 publisher confirm 就萬無一失」**

1.3.3 實測：routing key 打錯的那 200 則，**confirm 回的是 `ack`**。
confirm 回答「broker 收到了嗎」，**return 才回答「有進到佇列嗎」**。
兩個都要開，而且 `publisher-returns: true` 還要配 `template.mandatory: true`。

**③ 「訊息設了 persistent 就不會掉」**

1.4.2 實測：`durable` 佇列 + `persistent` 訊息，`SIGKILL` 之後掉了 **846 / 50,000（1.7%）**。
`persistent` 是「請你寫磁碟」，不是「已經在磁碟上」。
📌 **真正的分界線是 confirm 回來了沒**（1.4.3：等 confirm 之後掉 0 則）。

**④ 「佇列 durable 就好，訊息的 delivery_mode 是細節」**

1.4.1 實測第三列：`durable` 佇列 + `transient` 訊息，重啟後**佇列在、訊息 0 則**。
兩個開關**都要對**，只對一個等於沒有。

**⑤ 「`acks=1` 夠了，`acks=all` 太慢」**

1.3.6 實測：ISR 縮到 1 的時候，`acks=1` 回報「成功，offset 3」，
訊息也真的在 leader 的磁碟上 —— **但沒有任何消費者讀得到它，而且 lag 顯示 0**。
📌 `acks=1` 的承諾只有「有一台機器收下了」。那台機器掛了，承諾就作廢，**而你不會知道**。

**⑥ 「我在開發機上驗過 `acks=all` 了」**

1.3.7：單節點上 `acks=all` 等於 `acks=1`，而且 `min.insync.replicas` **會被夾到副本數**
（`min(2, 1) = 1`），所以連報錯都不會有。
📌 **`replication.factor=1` 的 topic 上，`acks=all` 是裝飾品。**

**⑦ 「Kafka 會 fsync，所以比較安全」**

反了。1.4.4：**Kafka 預設完全不主動 fsync**（`log.flush.interval.messages = Long.MAX_VALUE`）。
它的可靠性來自**副本**，不是磁碟。
👉 所以 `replication.factor=1` 在 Kafka 上是**沒有任何持久化保證**的。

**⑧ 「積壓是 0、lag 是 0，表示都處理完了」**

1.5.1：積壓 0 但 `unacked` 可能有幾千則（被領走、永遠沒交回來）。
1.5.2：`lag = 0` 但 250 則從來沒有人處理過。
📌 **`ready` / `unacked` / lag 這三個數字，任何一個單獨看都會騙你。**

**⑨ 「訊息只要不 ack，就會一直留在 broker 上等我」**

1.5.1 實測：`consumer_timeout` 預設 **30 分鐘**，超過就把 channel 砍掉、
`unacked` 全部退回 `ready`。
⚠️ **而且它只管 `basic.consume`（推模式，也就是 `@RabbitListener`），不管 `basic.get`。**
一個要跑 40 分鐘的消費者，會**每 30 分鐘被砍一次、永遠跑不完**。

**⑩ 「`acknowledge-mode: auto` 就是 auto-ack，很危險」**

⚠️ 剛好相反。`auto` 是「Spring 幫你判斷」（做完才 ack），**它是安全的**；
真正的 auto-ack 叫 `none`。`auto` 的問題只在**失敗時預設 `requeue=true`**（00 章 0.5.2）。

**⑪ 「開 exactly-once 就不用做冪等了」**

1.6.2：Kafka 的精確一次只在 **Kafka → Kafka** 成立。
你的消費者要寫 MySQL、要寄信、要呼叫別人的 API —— **這三種全部不在保護範圍內**。
📌 **唯一實務路線：at-least-once + 冪等消費。**

---

## 1.9 本章小結

**這一章建立了三件事**：

1. **一張地圖**（1.2）：三段、每一段的「確認」叫什麼、每一段的失敗長什麼樣子。
2. **每一段的實測**：
   - 第一段：routing key 打錯 → **500 則、0 個例外**（1.3.1）；
     `acks=1` 在 ISR 不足時**回報成功但沒人讀得到**（1.3.6）。
   - 第二段：四種持久化組合**只有一種安全**（1.4.1）；
     `persistent` + `SIGKILL` → **掉 1.7%**，等 confirm → **掉 0%**，代價 6.5 倍（1.4.2、1.4.3）。
   - 第三段：`ready` / `unacked` / 消失**三種狀態**（1.5.1）；
     Kafka 自動提交 → **250/300 則無聲遺失、lag = 0**（1.5.2）。
3. **一個結論**（1.6）：**「不重不漏」做不到。**
   唯一實務路線是 **at-least-once + 冪等消費**。

📌 **而且這一章留下了兩個它防不住的缺口**：

- **「送出前行程掛掉」** —— confirm 與 acks 都救不了 → **02 章 Outbox**。
- **「做完了但確認丟了」** —— 沒有任何設定救得了 → **03 章冪等消費**。

### 1.9.1 驗收清單

做得到才往下走：

- [ ] 說出 publisher **confirm** 與 publisher **return** 各自回答什麼問題，
      以及只開 confirm 時**哪一類遺失抓不到**。
- [ ] 說出 `publisher-returns: true` 為什麼還要配 `template.mandatory: true`。
- [ ] 重現 1.3.1，並說明為什麼 `convertAndSend()` 不會丟例外。
- [ ] 不看課文，畫出 1.3.4 那四個數字的量級（基準 / confirm 不理 / 批次收 / 每則等），
      並說出**哪一種是白付錢的**。
- [ ] 說出 `acks=1` 在 1.3.6 那個實驗裡「成功」的意思是什麼，以及它為什麼沒有價值。
- [ ] 解釋 **high watermark** 與 **log end offset** 的差別，
      並說明為什麼「訊息在磁碟上」跟「消費者讀得到」是兩件事。
- [ ] 說出 `min.insync.replicas` 被夾住的公式，以及怎麼在一個叢集裡找出受影響的 topic。
- [ ] 背出 1.4.1 那張四種組合的表，並指出**兩個最常犯的錯**。
- [ ] 說出 `persistent` 跟「已落盤」的差別，以及 1.4.2 / 1.4.3 兩個數字（1.7% 對 0%、6.5 倍）。
- [ ] 說出 RabbitMQ 訊息的三種狀態，以及 `messages_unacknowledged` 為什麼一定要監控。
- [ ] 說出 `consumer_timeout` 的預設值、**它管不到哪一種取訊息方式**，
      以及一個要跑 40 分鐘的消費者為什麼會「永遠跑不完」。
- [ ] 說出 `acknowledge-mode` 的 `none` / `auto` / `manual` 差在哪（注意 `auto` **不是** auto-ack）。
- [ ] 解釋 1.5.2 那個 `lag = 0` 為什麼是騙人的。
- [ ] 說出「Kafka 的 exactly-once」保證不到哪三種目的地。

### 1.9.2 本章練習

**練習一（15 分鐘）**：把 1.3.1 的實驗改成用 **topic exchange**：
宣告一個 `order.x`、把 `ch01.route.q` 綁上 `order.created.#`，
然後送到 `order.create`（少一個 `d`）。
**確認同樣的無聲遺失會發生**，然後打開 `publisher-returns` 再跑一次，
記錄 `replyCode` 與 `replyText`。
（04 章會講四種 exchange，這題先讓你踩一次。）

**練習二（20 分鐘）**：重跑 1.3.4，但把 ② 改成「每 100 則收一次 confirm」
（送 100 則 → 等這 100 個 future → 再送下 100 則）。
**量它的吞吐，並跟 ②（全部送完再收）與 ③（每則都等）比較。**
這個「批次窗口」的大小是一個真實的調校旋鈕 —— 02 章的 Outbox 輪詢器會用到它。

**練習三（25 分鐘）**：重跑 1.4.2，但把 `N` 從 50,000 改成 1,000、10,000、100,000 各跑一次。
**記錄每一次掉了幾則。** 掉的數量跟 `N` 成正比嗎？
（提示：它比較接近「固定的一段尾巴」而不是「固定的比例」——
想清楚這件事，你才會知道 1.7% 這個數字在你的流量下代表什麼。）

**練習四（25 分鐘）**：把 1.5.1 那個 `consumer_timeout` 實驗自己跑一次，
但這次把值設成 **20 秒**（寫進 `/etc/rabbitmq/rabbitmq.conf` 後 `docker restart`），
並且**同時開著管理介面**（<http://localhost:15673> → Queues）。

記錄三件事：

1. **推模式**真正被砍是在第幾秒？（課文設 8 秒、實際約 60 秒 —— 你的呢？）
2. 被砍的那一瞬間，管理介面上 `Unacked` 與 `Ready` 兩條線的形狀。
3. **把 `prefetch` 從 5 改成 250**（Boot 預設）再跑一次 ——
   被砍的時候有幾則訊息回到佇列？

⚠️ 第 3 點的答案會讓你對 05 章的 `prefetch` 有完全不同的感覺：
**它同時決定了「一次故障會牽連多少訊息」。**

跑完記得把 `consumer_timeout` 那一行從設定檔刪掉並重啟，否則後面幾章的實驗會被它干擾。

**練習五（進階，40 分鐘）**：重做 1.3.6 的實驗，但這次在**拔掉 kafka2 的期間**
啟動一個消費者掛在那個 topic 上，並且持續印出它收到的訊息與當下的 lag。
然後把 kafka2 插回去。
**記錄：消費者在故障期間看到什麼、恢復的那一瞬間看到什麼。**
這個時間序列就是你之後寫事故報告時需要的東西。

**練習六（進階，30 分鐘）**：用 1.3.7 的方法，寫一支腳本掃出你（或課程環境）
所有 `ReplicationFactor: 1` 的 topic，並列出它們的 `min.insync.replicas`。
**輸出一張表：topic / RF / minISR / 有效 minISR（`min(兩者)`）/ acks=all 是否有意義。**
這張表在真實工作裡叫「可靠性稽核」，而且通常一做就會找到東西。

---

## 1.10 下一章預告

這一章的表格裡有一列寫著 ❌：

| 段 | 問題 | RabbitMQ | Kafka |
|---|---|---|---|
| ① | **送出前行程掛掉** | ❌ 防不住 | ❌ 防不住 |

下一章（02）專門處理它，而且它比看起來難很多。

問題的形狀是這樣的 —— **你有兩件事要做，而且必須一起成功**：

```java
@Transactional
public Order placeOrder(cmd) {
    Order order = orderRepository.save(Order.of(cmd));   // ① 寫資料庫
    rabbit.convertAndSend("order.x", "order.created", event);   // ② 送訊息
    return order;
}
```

**這段程式碼有 bug，而且兩種寫法都有 bug**：

- **先寫資料庫、再送訊息**（上面這樣）：訊息在**交易還沒提交**時就送出去了。
  消費者可能**比你的 `COMMIT` 更快**到達，回頭查資料庫 —— **查不到那張訂單**。
  實測：這個競態在本機就會發生，而且機率比你想的高。
- **先送訊息、再寫資料庫**：資料庫回滾了，但**通知信已經寄出去了**。
  使用者收到「您的訂單已成立」，然後在訂單列表裡找不到它。

**「那我用 `AFTER_COMMIT` 事件呢？」**
[05-service/06](../05-service/06-async-and-external-api-calls.md) 6.3.5 已經講了一半：
它解決了「消費者比 COMMIT 快」的問題，但**沒有解決「送出前掛掉」**。
02 章會把那個時間窗**量出來**，並回答「一天 10 萬筆訂單、一年重啟 300 次，這個窗會吃掉幾筆」。

02 章的答案是 **Outbox 模式**，而這一章會把它做到能上線的程度：

- Outbox 表怎麼設計（欄位、索引、以及那個**一定會被忽略的 `next_retry_at`**）。
- 輪詢器怎麼寫，以及**多台機器同時輪詢時怎麼不互搶** —— 這就是 00 章 0.6.3
  堅持要裝真 MySQL 的原因：`SELECT ... FOR UPDATE SKIP LOCKED`。
- **輪詢 vs CDC（Debezium）** 的取捨：什麼時候輪詢就夠了、什麼時候非 CDC 不可。
- Outbox 表怎麼清，以及不清會發生什麼（實測：一張三千萬列的 outbox 表，
  那個 `WHERE status = 'PENDING'` 的查詢會變成什麼樣子）。
- **Outbox 沒有解決的那一半**：它保證「訊息一定會送出」，
  但它**保證不了「只送一次」** —— 所以 03 章接著來。
