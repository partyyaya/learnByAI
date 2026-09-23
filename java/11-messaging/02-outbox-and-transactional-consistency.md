# 第 02 章：Outbox 與交易一致性

> [01 章](./01-reliable-delivery-three-hops.md) 的總表裡有一列寫著 ❌ ❌：
>
> | 段 | 問題 | RabbitMQ | Kafka |
> |---|---|---|---|
> | ① | **送出前行程掛掉** | ❌ 防不住 | ❌ 防不住 |
>
> confirm 防不住它、`acks=all` 防不住它、持久化防不住它。
> **這一章專門處理這一列**，而且它比看起來難很多。
>
> 問題的形狀只有五行程式碼：
>
> ```java
> @Transactional
> public Order placeOrder(cmd) {
>     Order order = orderRepository.save(Order.of(cmd));            // ① 寫資料庫
>     rabbit.convertAndSend("order.x", "order.created", event);     // ② 送訊息
>     return order;
> }
> ```
>
> **這段程式碼有 bug。把①②對調 —— 還是有 bug。** 這一章會把兩種寫法都實測：
>
> - **寫法 A（上面這樣）**：訊息在 `COMMIT` 之前就送出去了。
>   實測：**200 筆訂單，消費者查得到 3 筆、查不到 197 筆 —— 失敗率 99%。**
>   而且交易後面只要再多做 5 毫秒的事，失敗率就變成 **100%**。
>   這不是罕見的競態，**這是常態**。
> - **寫法 B（先送訊息再寫 DB）**：實測 100 筆裡 50 筆交易回滾，
>   但**100 則訊息全部送出去了**，消費者一筆訂單都查不到。
>
> **「那我用 `AFTER_COMMIT`？」** 它確實解決了上面兩個問題（實測：50 送出、50 查得到、0 查不到）。
> 但它留下一個窗，而這一章會把那個窗**量出來並且打進去**：
>
> > **實測：100 次下單，`placeOrder()` 全部正常回傳、0 個例外，
> > 資料庫裡 100 筆訂單、佇列裡 0 則訊息。**
> > 因為 `@TransactionalEventListener(AFTER_COMMIT)` 裡丟出的例外，**會被完全吞掉**。
>
> 這一章的答案是 **Outbox 模式**，而且會做到能上線的程度：
> 表怎麼設計、輪詢器怎麼寫、**三台輪詢器同時跑怎麼不互搶**（實測：不加鎖會重送 100 則）、
> 表長到 130 萬列會發生什麼（實測：**少一個索引，查詢從 2 毫秒變成 492 毫秒**）。
>
> ⚠️ 但這一章也會誠實地說出 Outbox **沒有**解決的那一半：
> 它保證「訊息一定會送出」，但它**保證不了「只送一次」**——所以 03 章接著來。

---

## 2.1 學習目標

完成本章後，你應該可以：

- 說出「雙寫問題」的定義，以及為什麼它跟「有沒有用 MQ」無關（2.2）。
- 重現寫法 A 的競態，並說出為什麼失敗率是 **99%** 而不是「偶爾」（2.2.1）。
- 說出寫法 B 的失敗形狀（訂單不存在、通知已寄出），以及它為什麼**比寫法 A 更糟**（2.2.2）。
- 說明 `@TransactionalEventListener(AFTER_COMMIT)` 解決了什麼、**沒解決什麼**（2.2.3、2.3）。
- 量出 `AFTER_COMMIT` 那個窗的大小（2.3.1：p50 0.046 ms、max 4.99 ms），
  並說出**它在什麼情況下會從毫秒變成分鐘**。
- 說明為什麼 `AFTER_COMMIT` 監聽器裡的例外「被吞掉」是這個模式最危險的性質（2.3.2）。
- 設計一張 Outbox 表：說出每一個欄位存在的理由，特別是 **`next_retry_at`**（2.4.1）。
- 寫出一個輪詢器，並解釋 `SELECT ... FOR UPDATE SKIP LOCKED` 在做什麼（2.5）。
- 重現「三台輪詢器互搶」並說出不加鎖時的重送量（2.5.1：200 則變成 300 則）。
- 說出 Outbox 表不清理的三個後果，以及**哪一個是立刻致命的**（2.6）。
- 說明**輪詢 vs CDC** 的取捨，並判斷你的系統該用哪一個（2.7）。
- 說出 Outbox **保證不了什麼**，以及那一半由誰負責（2.8）。

---

## 2.2 雙寫問題：兩種寫法都會錯

### 2.2.0 先定義問題

**雙寫（dual write）**：一個操作要改動**兩個沒有共同交易的系統**。

```
       你的操作
          │
    ┌─────┴─────┐
    ▼           ▼
 MySQL       RabbitMQ      ← 兩個系統，沒有共同的交易
（可回滾）    （送出去就收不回來）
```

⚠️ **這個問題跟 MQ 無關。** 把 RabbitMQ 換成任何東西，問題一模一樣：

| 第二個系統 | 一樣有雙寫問題嗎 |
|---|---|
| RabbitMQ / Kafka | ✅ |
| 打別人的 HTTP API | ✅ |
| 寄一封信（SMTP） | ✅ |
| 寫 Redis | ✅ |
| 寫另一個資料庫 | ✅ |
| `@Async` 丟給執行緒池 | ✅（而且更糟，見 00 章 0.2） |

📌 **所以 Outbox 是一個「跨系統寫入」的通用解法**，不是「MQ 專用的技巧」。
即使你決定不用 MQ（00 章 0.5.6 那個判斷），這一章的內容你還是需要。

**本章共用的資料表**（用真 MySQL，理由見 00 章 0.6.3）：

```sql
CREATE TABLE orders (
  id          VARCHAR(64)  PRIMARY KEY,
  buyer       VARCHAR(64),
  amount      BIGINT,
  status      VARCHAR(32),
  created_at  DATETIME(6)
) ENGINE=InnoDB;
```

```java
@Entity
@Table(name = "orders")
public class Order {
    @Id private String id;
    private String buyer;
    private long amount;
    private String status;
    private Instant createdAt = Instant.now();

    protected Order() {}
    public Order(String id, String buyer, long amount) {
        this.id = id; this.buyer = buyer; this.amount = amount; this.status = "CREATED";
    }
    // getters...
}
```

### 2.2.1 寫法 A：交易還沒提交，消費者已經來了 ★★★

**這是 90% 的人的第一版寫法。**

```java
package com.example.lab11.ch02;

@SpringBootTest
class D1DualWriteTest {

    static final String Q = "ch02.dualwrite.q";
    static final AtomicInteger found = new AtomicInteger(), notFound = new AtomicInteger();

    /** 消費者：收到「訂單已成立」就回頭查資料庫 */
    @Component
    static class Consumer {
        @Autowired OrderRepository repo;

        @RabbitListener(queues = Q)
        void onOrderCreated(String orderId) {
            if (repo.findById(orderId).isPresent()) found.incrementAndGet();
            else notFound.incrementAndGet();
        }
    }

    /** ❌ 寫法 A：交易裡面先寫 DB、再送訊息 */
    @Service
    static class BadOrderService {
        @Autowired OrderRepository repo;
        @Autowired RabbitTemplate rabbit;

        @Transactional
        public void placeOrder(String id, long slowMs) {
            repo.save(new Order(id, "alice", 1000));          // ① 寫入（還沒 COMMIT）
            rabbit.convertAndSend("", Q, id);                 // ② 送訊息（立刻就出去了）
            try { Thread.sleep(slowMs); } catch (InterruptedException ignored) {}
        }                                                     // ③ 這裡才 COMMIT
    }

    @Test
    void consumerArrivesBeforeCommit() throws Exception {
        // ... 準備佇列、清空 orders、等 listener 接上
        for (long slow : new long[]{0, 5, 50}) {
            found.set(0); notFound.set(0);
            int N = 200;
            for (int i = 0; i < N; i++) bad.placeOrder("A" + slow + "-" + i, slow);
            Thread.sleep(2500);
            System.out.printf("  交易在送訊息之後還跑了 %3d ms → 消費者查得到 %3d 筆、查不到 %3d 筆（%.0f%% 失敗）%n",
                    slow, found.get(), notFound.get(), 100.0 * notFound.get() / N);
        }
    }
}
```

**輸出**：

```
═══ 2.2.1 寫法 A：交易還沒提交，消費者已經來了 ═══
  交易在送訊息之後還跑了   0 ms → 消費者查得到   3 筆、查不到 197 筆（99% 失敗）
  交易在送訊息之後還跑了   5 ms → 消費者查得到   0 筆、查不到 200 筆（100% 失敗）
  交易在送訊息之後還跑了  50 ms → 消費者查得到   0 筆、查不到 200 筆（100% 失敗）
```

⚠️ **失敗率 99%，不是「偶爾」。**

**這一點必須講清楚，因為它顛覆很多人的直覺**：

大部分人聽到「競態條件」會想成「機率很小、很難重現」。
**這個競態剛好相反：它幾乎必然發生。** 原因是時間尺度差太多：

```
  convertAndSend() 把訊息交給 broker ────────────── 約 0.02 ms
  broker 推給消費者、消費者查資料庫 ──────────────── 約 0.3 ms（00 章 0.5.3）
  ─────────────────────────────────────────────────────────────
  你的交易 COMMIT（寫 redo log、fsync、釋放鎖）───── 約 1～10 ms
         ＋ 交易裡剩下的業務邏輯 ───────────────────── 5～500 ms
```

**訊息跑完全程只要 0.3 毫秒，而 `COMMIT` 本身就要好幾毫秒。**
消費者不是「有時候比較快」，**它是穩定地快**。

📌 **那為什麼 `slow=0` 時還有 3 筆查得到？**
那 3 筆是「消費者剛好在 broker 的排程縫隙裡被延遲了」——
換句話說，**那 3 筆是僥倖，不是常態**。

⚠️ **這個 bug 的真實症狀有三種，而且都不會指向真正的原因**：

| 症狀 | 你會怎麼想 |
|---|---|
| 消費者拋 `EntityNotFoundException` | 「資料庫同步有問題？」「主從延遲？」 |
| 消費者用 `Optional.orElse(null)` 然後 NPE | 「這則訊息的資料是髒的」 |
| 消費者查不到就 `return`（安靜跳過） | **什麼都不會發生** —— 通知永遠不寄，沒有人知道 |

**最後一種最常見，也最可怕。** 因為「查不到就跳過」看起來是很防禦性的寫法。

📌 順便：**主從延遲（read replica lag）會讓這個問題再放大一層。**
消費者去讀從庫，就算主庫已經 `COMMIT` 了，從庫還要幾十到幾百毫秒。
本站不展開複寫架構，但你要知道：**這一節的失敗率在有從庫的環境下只會更高。**

### 2.2.2 寫法 B：先送訊息，然後交易回滾

「那我把順序反過來，先送訊息再寫資料庫？」

```java
    /** ❌ 寫法 B：先送訊息、再寫 DB */
    @Service
    static class SendFirstService {
        @Autowired OrderRepository repo;
        @Autowired RabbitTemplate rabbit;

        @Transactional
        public void placeOrder(String id, boolean willFail) {
            rabbit.convertAndSend("", Q, id);                 // ① 先送訊息（送出去就收不回來了）
            repo.save(new Order(id, "alice", 1000));          // ② 再寫 DB
            if (willFail) throw new IllegalStateException("風控判定這筆要退");   // ③ 回滾
        }
    }
```

**輸出**（100 筆，其中一半會被風控退掉）：

```
═══ 2.2.2 寫法 B：先送訊息，然後交易回滾 ═══
  送出 100 筆，其中 50 筆交易回滾了
  消費者收到 100 則，其中查得到訂單 0 筆、查不到 100 筆
  資料庫裡實際有 50 筆訂單
```

⚠️ **這個寫法同時有兩個 bug**：

1. **那 50 筆回滾的**：訊息已經送出去了，訂單不存在 —— **通知信寄給了一個不存在的訂單**。
2. **那 50 筆成功的**：訊息**還是**比 `COMMIT` 快（跟 2.2.1 同一個問題）—— 所以也查不到。

**所以 `查得到訂單 0 筆`。100 則訊息，100 則都是垃圾。**

📌 **寫法 B 比寫法 A 更糟，而且糟在一個關鍵的地方**：

| | 寫法 A | 寫法 B |
|---|---|---|
| 交易成功時 | 訊息早到（時序問題）→ **可以靠重試救**（等一下再查就有了） | 同樣早到 |
| 交易**回滾**時 | 訊息**也會回滾嗎**？⚠️ **不會**，但至少只在有例外時發生 | 訊息一定已經送出 |
| 補救 | 消費者重試幾次就好 | **補不回來**。信已經寄了、款可能已經扣了 |

⚠️ **很多人以為「訊息在 `@Transactional` 方法裡送，交易回滾訊息就不會送」。**
**不會。** `RabbitTemplate` / `KafkaTemplate` 預設**完全不參與 Spring 的交易** ——
`convertAndSend()` 一呼叫，訊息就在網路上了。

📌 **（小知識）RabbitMQ 其實有交易式 channel**（`rabbit.setChannelTransacted(true)`），
可以讓訊息跟資料庫交易「勉強」同步。**但它解決不了根本問題**：
兩個交易還是分別提交的，中間一樣有窗；而且它的吞吐非常差。
**實務上沒有人這樣用**，正確答案是 Outbox。

### 2.2.3 寫法 C：`AFTER_COMMIT` —— 解決了一半

Spring 內建的答案：**把「送訊息」推遲到交易提交之後**。

```java
    record OrderCreated(String orderId) {}

    /** ✅ 寫法 C：AFTER_COMMIT */
    @Service
    static class AfterCommitService {
        @Autowired OrderRepository repo;
        @Autowired ApplicationEventPublisher events;

        @Transactional
        public void placeOrder(String id, boolean willFail) {
            repo.save(new Order(id, "alice", 1000));
            events.publishEvent(new OrderCreated(id));        // 只是發一個應用事件，還沒送 MQ
            if (willFail) throw new IllegalStateException("風控判定這筆要退");
        }
    }

    @Component
    static class EventRelay {
        @Autowired RabbitTemplate rabbit;

        @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
        public void relay(OrderCreated e) {
            rabbit.convertAndSend("", Q, e.orderId());        // COMMIT 成功之後才送
        }
    }
```

**輸出**：

```
═══ 2.2.3 寫法 C：AFTER_COMMIT ═══
  送出 100 筆，其中 50 筆交易回滾了
  消費者收到 50 則，其中查得到訂單 50 筆、查不到 0 筆
  資料庫裡實際有 50 筆訂單
```

✅ **完美。** 回滾的 50 筆完全沒送訊息；成立的 50 筆消費者全部查得到。

**它解決了什麼**：

| 問題 | 解決了嗎 |
|---|---|
| 訊息比 `COMMIT` 快（2.2.1） | ✅ 解決了 |
| 交易回滾但訊息已送（2.2.2） | ✅ 解決了 |
| **送出前行程掛掉** | ❌ **沒有** ← 2.3 節 |

📌 **`@TransactionalEventListener` 的四個 phase，先認一下**：

| phase | 什麼時候跑 | 用途 |
|---|---|---|
| `BEFORE_COMMIT` | `COMMIT` 之前，**還在交易裡** | 最後的驗證；這裡丟例外**會讓交易回滾** |
| `AFTER_COMMIT`（預設） | `COMMIT` 成功之後 | **送訊息、寄信、清快取** |
| `AFTER_ROLLBACK` | 回滾之後 | 補償、告警 |
| `AFTER_COMPLETION` | 不管成功失敗都跑 | 清理資源 |

⚠️ **`@TransactionalEventListener` 有一個很常見的坑**：
**如果發事件時沒有活躍的交易，這個監聽器預設「完全不會被呼叫」**（事件被安靜丟棄）。
測試裡很容易踩到。要它在沒有交易時也跑，加 `fallbackExecution = true`。

---

## 2.3 `AFTER_COMMIT` 留下的那個窗

### 2.3.1 先量它有多大

```java
    @Component
    static class GapRelay {
        @Autowired RabbitTemplate rabbit;

        @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
        public void relay(OrderCreated e) {
            long t0 = System.nanoTime();
            rabbit.convertAndSend("", Q, e.orderId());
            // 記錄 COMMIT 完成 → convertAndSend() 回傳 的時間
            gapNs[idx.getAndIncrement()] = System.nanoTime() - t0;
        }
    }
```

**輸出**：

```
═══ 2.3.1 量一下那個「窗」有多大 ═══
  COMMIT 完成 → convertAndSend() 回傳，共 500 次取樣
    p50 = 0.046 ms    p99 = 0.138 ms    max = 4.990 ms
```

**p50 只有 46 微秒。** 看起來小到可以忽略，對吧？

📌 **先算一下期望值**：
一天 10 萬筆訂單，每筆有一個 46 微秒的窗 → 一天累積 4.6 秒的「危險時間」。
一年重啟 / 部署 300 次，每次落在那 4.6 秒 / 86400 秒的機率 → **一年大約 0.016 筆**。

**看起來完全可以接受。** 而這正是這一節要拆掉的想法。

### 2.3.2 ⚠️ 那個窗不是只有 46 微秒

上面的算法有一個致命的錯誤假設：**它假設「掛掉」是均勻隨機的**。

**真實世界的失敗不是隨機的，它是相關的**：

| 事件 | 窗有多大 |
|---|---|
| 行程剛好在那 46 µs 被 `kill -9` | 46 µs（罕見） |
| **broker 掛了 / 網路斷了 30 秒** | **30 秒裡的每一筆訂單，全部命中** |
| broker 在做維護、連線被拒 5 分鐘 | **5 分鐘裡的每一筆** |
| 連線池耗盡、`convertAndSend()` 逾時 | 從那一刻起，**每一筆** |
| 部署時 `SIGTERM` 到 `SIGKILL` 之間 | 那幾秒裡的每一筆 |

📌 **「窗」不是一個時間點，它是「送訊息這件事失敗」的整段期間。**
而在那段期間裡，**命中率是 100%，不是 0.016 筆/年。**

**把這件事實測出來**：讓 relay 丟例外（等價於「broker 連不上」或「就在這裡掛了」）：

```java
    @Component
    static class GapRelay {
        @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
        public void relay(OrderCreated e) {
            relayCalled.incrementAndGet();
            if (crashInRelay) {
                // 模擬「COMMIT 完成了，但送訊息之前行程死了 / broker 連不上」
                throw new RuntimeException("💥 就在這裡掛了");
            }
            rabbit.convertAndSend("", Q, e.orderId());
            relaySent.incrementAndGet();
        }
    }

    @Test
    void theWindowAndTheCrash() throws Exception {
        crashInRelay = true;
        int ok = 0, boom = 0;
        for (int i = 0; i < 100; i++) {
            try { svc.placeOrder("X-" + i); ok++; }
            catch (Exception e) { boom++; }
        }
        // ... 印出統計
    }
```

**輸出**：

```
═══ 2.3.2 就在那個窗裡掛掉 ═══
  呼叫 placeOrder() 100 次：正常回傳 100 次、丟例外 0 次
  relay 被呼叫 100 次、真的送出 0 則
  資料庫裡的訂單 : 100 筆
  佇列裡的訊息   : 0 則
```

⚠️⚠️ **停下來看第一行：`正常回傳 100 次、丟例外 0 次`。**

```
  呼叫 placeOrder()       : 100 次
  拿到例外                : 0 次        ← 呼叫端完全不知道出事了
  HTTP 200 回給使用者      : 100 次
  資料庫裡的訂單          : 100 筆      ← 訂單是對的
  佇列裡的訊息            : 0 則        ← 通知一則都沒送出
  可以重來的憑據          : 沒有        ← 你甚至不知道是哪 100 筆
```

📌 **`@TransactionalEventListener(AFTER_COMMIT)` 裡丟出的例外，會被 Spring 吞掉。**

這是刻意的設計，而且**它必須這樣**：交易已經提交了，這時候丟例外要怎麼辦？
回滾？回不了。往上丟？呼叫端會以為下單失敗，但訂單明明已經在資料庫裡了。
**所以 Spring 只能記一行日誌然後繼續。**

⚠️ **這個失敗形狀，跟 00 章 0.2.3 的「死法三」一模一樣**：
100 件事沒做、沒有例外、沒有清單、補不回來。
**繞了一圈，我們回到了原點。**

**有人會說「那我在 relay 裡 try-catch 然後寫進資料庫」** —— 很好，
**你已經在發明 Outbox 了**。下一節就是把這個想法做對。

### 2.3.3 所以四種寫法的總結

| 寫法 | 訊息早到 | 回滾卻送了 | 送出前掛掉 | 有可重來的憑據 |
|---|---|---|---|---|
| **A** 交易內先寫 DB 再送 | ❌ 99% 失敗 | ❌ | ❌ | ❌ |
| **B** 交易內先送再寫 DB | ❌ | ❌ 一定送出 | ❌ | ❌ |
| **C** `AFTER_COMMIT` | ✅ | ✅ | ❌ **無聲遺失** | ❌ |
| **D** Outbox | ✅ | ✅ | ✅ | ✅ |

📌 **C 不是沒有價值。** 對於「掉了無所謂」的訊息（點擊事件、統計），
`AFTER_COMMIT` 是**成本最低、程式碼最少**的正確做法 —— 它只花你三行。
**但只要那則訊息掉了會少收錢或會被客訴，你就需要 D。**

---

## 2.4 Outbox：把「要送訊息」變成一筆資料

### 2.4.1 核心想法

**既然跨兩個系統沒有共同交易，那就只寫一個系統。**

```
   之前（雙寫）                        Outbox
┌────────┐   ┌────────┐         ┌──────────────────────┐   ┌────────┐
│ MySQL  │   │ broker │         │       MySQL          │   │ broker │
│ orders │   │        │         │  orders   │  outbox  │   │        │
└────────┘   └────────┘         └──────────────────────┘   └────────┘
     ▲            ▲                        ▲                     ▲
     └── 一個交易 ─┘ ❌                     └─── 一個交易 ✅        │
        做不到                          （同一個資料庫、同一個交易）│
                                                 │                │
                                                 └── 輪詢器 ───────┘
                                                    （另一件事）
```

**兩個步驟，各自都是可靠的**：

1. **寫訂單 + 寫 outbox**：同一個資料庫、同一個交易 → **要嘛都成功、要嘛都回滾**。
   這不是「分散式交易」，這就是普通的資料庫交易。
2. **輪詢器讀 outbox → 送 MQ → 標記已送**：這一步失敗了**沒關係**，
   因為那一列還在 `PENDING`，下一輪會再試。

📌 **關鍵洞察**：Outbox 把「一個沒辦法保證的跨系統操作」，
換成了「**一個可以保證的資料庫交易** + **一個可以無限重試的背景工作**」。

### 2.4.2 表設計

```sql
CREATE TABLE outbox (
  id              VARCHAR(64)  PRIMARY KEY,   -- = 訊息 ID，消費端拿它去重（03 章）
  aggregate_type  VARCHAR(64)  NOT NULL,      -- 'Order'
  aggregate_id    VARCHAR(64)  NOT NULL,      -- 'ORD-1001'
  event_type      VARCHAR(64)  NOT NULL,      -- 'order.created'
  payload         TEXT         NOT NULL,      -- JSON
  status          VARCHAR(16)  NOT NULL,      -- PENDING / SENT / FAILED
  attempts        INT          NOT NULL DEFAULT 0,
  created_at      DATETIME(6)  NOT NULL,
  next_retry_at   DATETIME(6)  NOT NULL,      -- ⚠️ 見下方
  last_error      VARCHAR(500),
  KEY idx_outbox_pick (status, next_retry_at, id)
) ENGINE=InnoDB;
```

**每一個欄位存在的理由**：

| 欄位 | 為什麼 | 漏掉會怎樣 |
|---|---|---|
| `id` | **訊息的唯一 ID**，會跟著訊息一起送出去 | 消費端**沒辦法去重**（03 章整章靠它） |
| `aggregate_type` / `aggregate_id` | 這則訊息在講哪一個東西 | 出事時你沒辦法回答「訂單 9527 的訊息送了嗎」 |
| `event_type` | 決定送到哪個 exchange / topic | 輪詢器不知道要送去哪 |
| `payload` | 訊息本體（**快照，不是參考**） | 見下方 ⚠️ |
| `status` | 三態：待送 / 已送 / 放棄 | 分不出「還沒送」跟「送不出去」 |
| `attempts` | 已經試幾次了 | **無限重試**（00 章 0.5.2 那個風暴的資料庫版） |
| `created_at` | 排序用（先進先出） | 訊息順序會亂 |
| **`next_retry_at`** | **下次可以再試的時間** | ⚠️ **這是最常被漏掉的欄位**，見下方 |
| `last_error` | 上次為什麼失敗 | 你要從日誌裡撈，而日誌會輪替掉 |

⚠️ **`next_retry_at` 為什麼是最重要的欄位**：

沒有它的話，一則送不出去的訊息會是這樣：

```
輪詢器每 1 秒跑一次，每次撈 100 則 PENDING
  第 1 秒：撈到那則 → 失敗
  第 2 秒：撈到那則 → 失敗
  第 3 秒：撈到那則 → 失敗
  ...
  而且因為它 created_at 最早，它永遠排在最前面 ——
  ⚠️ 它會把整批 100 則的位置佔掉一格，而且永遠佔著
```

有了 `next_retry_at`，失敗時就可以做**指數退避**：

```java
// 第 n 次失敗 → 等 2^n 秒再試（上限 5 分鐘）
Instant next = Instant.now().plusSeconds(Math.min(300, 1L << attempts));
```

⚠️ **`payload` 必須是「快照」，不能是「等一下再去查」。**

```java
// ❌ 錯：只存 ID，輪詢器再去查
outbox.save(new OutboxMessage(msgId, "Order", orderId, "order.created", "{}"));
// 輪詢器：Order o = orderRepo.findById(orderId); 然後組訊息
//   → 如果這期間訂單被改了，你送出去的是「改過之後」的狀態
//   → 事件的意思是「當時發生了什麼」，不是「現在長怎樣」

// ✅ 對：在交易裡就把當下的狀態序列化好
String payload = objectMapper.writeValueAsString(OrderCreatedEvent.from(order));
outbox.save(new OutboxMessage(msgId, "Order", order.getId(), "order.created", payload));
```

**對應的 Entity**：

```java
@Entity
@Table(name = "outbox", indexes = {
    @Index(name = "idx_outbox_pick", columnList = "status,nextRetryAt,id")
})
public class OutboxMessage {
    @Id @Column(length = 64)
    private String id;
    @Column(length = 64, nullable = false) private String aggregateType;
    @Column(length = 64, nullable = false) private String aggregateId;
    @Column(length = 64, nullable = false) private String eventType;

    @Column(columnDefinition = "TEXT", nullable = false)      // ⚠️ 不要用 @Lob，見下方
    private String payload;

    @Column(length = 16, nullable = false) private String status;
    private int attempts;
    private Instant createdAt = Instant.now();
    private Instant nextRetryAt = Instant.now();
    @Column(length = 500) private String lastError;

    protected OutboxMessage() {}
    public OutboxMessage(String id, String aggregateType, String aggregateId,
                         String eventType, String payload) {
        this.id = id; this.aggregateType = aggregateType; this.aggregateId = aggregateId;
        this.eventType = eventType; this.payload = payload; this.status = "PENDING";
    }
    // getters...
}
```

⚠️⚠️ **`payload` 那一行的 `@Lob` 是一個會上線之後才爆的坑，我自己就先踩了一次。**

`@Lob private String payload` 看起來是最自然的寫法（「這是一段很長的文字」）。
但把 `ddl-auto: update` 建出來的欄位型別問出來看：

```java
jdbc.queryForObject(
    "SELECT COLUMN_TYPE FROM information_schema.columns " +
    "WHERE table_schema='lab11' AND table_name='outbox' AND column_name='payload'", String.class)
```

```
tinytext
```

**`tinytext` 的上限是 255 bytes。** 實測各種長度的 payload：

```
═══ @Lob String payload 在 MySQL 上實際能存多大 ═══
  Hibernate 建出來的欄位型別 : tinytext
  payload  200 字元 → ✅ 存進去了，長度 200
  payload  255 字元 → ✅ 存進去了，長度 255
  payload  256 字元 → ❌ MysqlDataTruncation: Data truncation: Data too long for column 'payload'
  payload  300 字元 → ❌ MysqlDataTruncation: Data too long for column 'payload'
  payload 1000 字元 → ❌ MysqlDataTruncation: Data too long for column 'payload'
```

⚠️ **256 字元就爆。** 一個真實的訂單事件 JSON（訂單號、買家、金額、三個品項、地址）
輕鬆超過 500 字元 —— **你的 Outbox 會在寫入的那一刻就丟例外，而那個例外會把訂單交易一起回滾**。
也就是說：**加了 Outbox 之後，訂單反而下不了。**

📌 **這個坑為什麼特別容易中**：
- 開發時用的測試資料很短（`{"orderId":"ORD-1"}` 只有 20 字元）→ **測試全過**。
- `@Lob` 這個註解的名字強烈暗示「很大的東西」，完全看不出它會變成 255 bytes。
- Hibernate 6 對 `@Lob String` 在 MySQL 方言上就是映射成 `tinytext`，**沒有任何警告**。

**修法：明確指定欄位型別，不要讓方言幫你決定。**

```java
@Column(columnDefinition = "TEXT", nullable = false)      // MySQL: 64 KB
private String payload;
```

驗證：

```
  Hibernate 建出來的欄位型別 : text
  payload  256 字元 → ✅ 存進去了，長度 256
  payload 1000 字元 → ✅ 存進去了，長度 1000
```

📌 **順便：其他欄位也都明確寫了 `length`。**
不寫的話 Hibernate 會給 `varchar(255)` —— 對 `status`（最長 7 個字元）是浪費，
對 `last_error`（堆疊訊息）則是**又一個會截斷的地方**。
**Outbox 是基礎設施，它的 DDL 值得手寫，不要靠 `ddl-auto` 猜。**

⚠️ **這也是為什麼正式環境不該用 `ddl-auto: update`** ——
你會拿到一張「能跑但型別是方言隨便給的」表，然後在資料變長的那一天出事。
本站為了省事用它，**但 2.4.2 那段 `CREATE TABLE` 才是你該放進版本控管的東西**。

### 2.4.3 寫入端：一個交易，兩張表

```java
    /** ✅ 寫法 D：訂單與 outbox 在同一個交易裡 */
    @Service
    static class OutboxOrderService {
        @Autowired OrderRepository orders;
        @Autowired OutboxRepository outbox;

        @Transactional
        public String placeOrder(String id) {
            orders.save(new Order(id, "alice", 1000));
            String msgId = UUID.randomUUID().toString();
            outbox.save(new OutboxMessage(msgId, "Order", id, "order.created",
                    "{\"orderId\":\"" + id + "\"}"));
            return msgId;                    // 兩張表、一個交易、一起成功或一起失敗
        }
    }
```

**驗證：交易回滾時，outbox 那一列也一起回滾**

```
═══ 2.4.3 交易回滾時，outbox 那一列也一起回滾 ═══
  成立 50 筆、回滾 50 筆
  orders 表 : 50 筆      outbox 表 : 50 列（PENDING 50）
```

✅ **50 筆訂單、50 列 outbox，一一對應。** 回滾的 50 筆兩張表都沒有。

📌 **這裡沒有任何魔法。** 它之所以正確，只是因為**兩張表在同一個資料庫、同一個交易裡** ——
這是資料庫本來就保證的事。**Outbox 的全部價值，就是把一個分散式問題退化成一個本地問題。**

### 2.4.4 讀出端：輪詢器

```java
    /** 輪詢器：把 outbox 裡的 PENDING 撈出來送 */
    @Service
    static class OutboxRelay {
        @Autowired OutboxRepository outbox;
        @Autowired RabbitTemplate rabbit;

        @Transactional(propagation = Propagation.REQUIRES_NEW)
        public int pump(int batchSize) {
            var batch = outbox.pickBatch(Instant.now(), PageRequest.of(0, batchSize));
            int sent = 0;
            for (OutboxMessage m : batch) {
                try {
                    rabbit.convertAndSend("", Q, m.getPayload());
                    outbox.markSent(m.getId());
                    sent++;
                } catch (Exception e) {
                    outbox.markRetry(m.getId(), Instant.now().plusSeconds(5), e.getMessage());
                }
            }
            return sent;
        }
    }
```

**驗證：broker 掛掉的時候，訊息不會消失**

```
═══ 2.4.4 broker 掛掉的時候，訊息不會消失 ═══
  broker 壞掉時輪詢一輪：送出 0 則
  outbox PENDING = 50、FAILED = 0、SENT = 0
  👉 訊息還在 outbox 表裡，一則都沒少。這就是「可以重來的憑據」。

═══ 2.4.4 broker 好了，輪詢器自己追上 ═══
  送出 50 則
  outbox PENDING = 0、SENT = 50
  佇列裡實際有 50 則
```

📌 **把這個結果跟 2.3.2 並排看，這就是整章的重點**：

| | `AFTER_COMMIT`（2.3.2） | Outbox（2.4.4） |
|---|---|---|
| broker 連不上時 | 100 筆訂單、**0 則訊息** | 50 筆訂單、**50 列 PENDING** |
| 呼叫端知道嗎 | ❌ 0 個例外 | ❌ 也是 0 個例外（**但不需要知道**） |
| 有清單嗎 | ❌ 沒有 | ✅ `SELECT * FROM outbox WHERE status='PENDING'` |
| broker 好了之後 | **什麼都不會發生** | ✅ **自動追上**，一則不少 |
| 需要人工介入嗎 | 需要（而且不知道要處理哪些） | 不需要 |

⚠️ **注意「呼叫端也是 0 個例外」這一列。**
Outbox **沒有**讓失敗變得可見 —— 它讓**失敗變得不重要**。
下單成功就是成功，訊息晚一點送出去是輪詢器的事。
📌 **這是這個模式在架構上的價值：它把「必須立刻成功」降級成「最終會成功」。**

---

## 2.5 多台輪詢器：`SKIP LOCKED`

2.4.4 那個輪詢器有一個致命問題：**它假設只有一台在跑。**

真實環境你有三台機器（或三個 Pod），每一台都跑著同樣的程式碼，
也就是**三個輪詢器同時去撈同一張表**。

### 2.5.1 不加鎖會怎樣

```java
    @Service
    static class Poller {
        @Autowired OutboxRepository outbox;

        /** 模擬一台輪詢器：挑一批、假裝送、標記 SENT */
        @Transactional(propagation = Propagation.REQUIRES_NEW)
        public List<String> pollOnce(String who, int batch, boolean useSkipLocked, long workMs) {
            var rows = useSkipLocked
                    ? outbox.pickBatch(Instant.now(), PageRequest.of(0, batch))
                    : outbox.pickBatchNoLock(Instant.now(), PageRequest.of(0, batch));
            List<String> ids = rows.stream().map(OutboxMessage::getId).toList();
            try { Thread.sleep(workMs); } catch (InterruptedException ignored) {}   // 「送訊息」的耗時
            for (String id : ids) outbox.markSent(id);
            return ids;
        }
    }

    @Test
    void withAndWithoutSkipLocked() throws Exception {
        System.out.println("═══ 2.5.1 三台輪詢器同時跑，會不會互搶 ═══");
        race("不加鎖（plain SELECT）", false);
        race("FOR UPDATE SKIP LOCKED", true);
    }
```

**輸出**（outbox 裡有 200 則 PENDING，三台各撈 100 則，每台「送訊息」花 300 ms）：

```
═══ 2.5.1 三台輪詢器同時跑，會不會互搶 ═══
  【不加鎖（plain SELECT）】
    三台輪詢器各拿到 : [100, 100, 100]
    總共處理         : 300 則（outbox 裡只有 200 則）
    被重複拿到的訊息 : 100 則
    耗時             : 542 ms
    這一輪之後還 PENDING : 100 則（下一輪會撿走）
    結論             : ❌ 同一則訊息被送了 200 次多餘的

  【FOR UPDATE SKIP LOCKED】
    三台輪詢器各拿到 : [88, 57, 55]
    總共處理         : 200 則（outbox 裡只有 200 則）
    被重複拿到的訊息 : 0 則
    耗時             : 376 ms
    這一輪之後還 PENDING : 0 則（下一輪會撿走）
    結論             : ✅ 沒有重複，三台分工
```

**逐項看**：

| | 不加鎖 | `SKIP LOCKED` |
|---|---|---|
| 三台各拿到 | `[100, 100, 100]` —— **全部撈到同一批** | `[88, 57, 55]` —— **自動分工** |
| 總共處理 | **300 則**（表裡只有 200 則） | **200 則**（剛好） |
| 重複送出 | **100 則被送了 2～3 次** | **0** |
| 耗時 | 542 ms（三台做重複的工） | **376 ms**（真的併行） |
| 一輪之後還剩 | **100 則 PENDING** ← 見下方 | 0 則 |

⚠️ **`[88, 57, 55]` 這個分配比例每次跑都不一樣**（同一支測試再跑一次拿到 `[64, 67, 69]`）——
`SKIP LOCKED` 只保證「不重複」，**不保證「平均分配」**。
誰先搶到鎖誰就多拿，而且有時候會有一台拿到 0 則。
📌 **所以不要用「各台處理量是否平均」來判斷輪詢器健不健康** ——
要看的是 `outbox.pending` 這個總量（2.5.3 的 gauge）。

⚠️ **「不加鎖」那一列的 `還 PENDING 100 則` 特別值得看。**
三台都撈到同一批 100 則、都送出去了、都去 `markSent`。
**結果只有 100 則被標記，另外 100 則連撈都沒被撈到** ——
三台機器花了 542 毫秒，做了 300 則的工，實際只推進了 100 則。
📌 **不加鎖不只造成重複，還讓吞吐變成 1/3。**

### 2.5.2 `SKIP LOCKED` 在做什麼

```sql
SELECT * FROM outbox
WHERE status = 'PENDING' AND next_retry_at <= NOW(6)
ORDER BY created_at
LIMIT 100
FOR UPDATE SKIP LOCKED;     -- ← 這一行
```

**三種鎖定行為的差別**：

| 寫法 | 遇到別人鎖住的列 | 結果 |
|---|---|---|
| （不加） | 照樣讀出來 | ❌ 三台撈到同一批 |
| `FOR UPDATE` | **等**，直到對方交易結束 | ⚠️ 三台變成排隊，完全沒有併行（而且會 lock wait timeout） |
| `FOR UPDATE SKIP LOCKED` | **跳過，去看下一列** | ✅ 三台自動分工 |

```
   三台輪詢器同時下 SELECT ... FOR UPDATE SKIP LOCKED LIMIT 100

   outbox 表（200 列 PENDING）
   ┌────────────────────────────────────────┐
   │ 列 1..88    ← poller-1 搶到，鎖住       │
   │ 列 89..145  ← poller-2 看到 1..88 被鎖， │
   │                跳過，從 89 開始搶       │
   │ 列 146..200 ← poller-3 跳過前面，搶剩下  │
   └────────────────────────────────────────┘
```

**在 Spring Data JPA 裡怎麼寫**：

```java
public interface OutboxRepository extends JpaRepository<OutboxMessage, String> {

    /**
     * 挑出一批待送的訊息並鎖住它們。
     * ⚠️ SKIP LOCKED 是關鍵：別台機器鎖住的列，這台直接跳過，不等。
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @QueryHints(@QueryHint(name = "jakarta.persistence.lock.timeout", value = "-2"))  // -2 = SKIP LOCKED
    @Query("""
           select m from OutboxMessage m
           where m.status = 'PENDING' and m.nextRetryAt <= :now
           order by m.createdAt
           """)
    List<OutboxMessage> pickBatch(@Param("now") Instant now, Pageable page);

    @Modifying
    @Query("update OutboxMessage m set m.status = 'SENT' where m.id = :id")
    void markSent(@Param("id") String id);

    @Modifying
    @Query("""
           update OutboxMessage m
           set m.attempts = m.attempts + 1, m.nextRetryAt = :next, m.lastError = :err,
               m.status = case when m.attempts + 1 >= 5 then 'FAILED' else 'PENDING' end
           where m.id = :id
           """)
    void markRetry(@Param("id") String id, @Param("next") Instant next, @Param("err") String err);

    long countByStatus(String status);
}
```

⚠️ **那個 `value = "-2"` 是 JPA 規格裡的魔術數字**：

| `jakarta.persistence.lock.timeout` | 對應的 SQL |
|---|---|
| （不設） | `FOR UPDATE`（會等） |
| `0` | `FOR UPDATE NOWAIT`（遇到鎖立刻報錯） |
| **`-2`** | **`FOR UPDATE SKIP LOCKED`** |

📌 **這個 `-2` 完全不直覺，而且寫錯不會報錯 —— 它只是安靜地變回 `FOR UPDATE`。**

**所以一定要驗證它真的生效了**。開一個測試把 SQL 印出來：

```java
@SpringBootTest(properties = {
        "spring.jpa.show-sql=true",
        "logging.level.org.hibernate.SQL=DEBUG"
})
class SkipLockedSqlTest {

    @Autowired OutboxRepository outbox;

    @Test
    @Transactional
    void doesItReallyEmitSkipLocked() {
        outbox.pickBatch(Instant.now(), PageRequest.of(0, 10));
        outbox.pickBatchNoLock(Instant.now(), PageRequest.of(0, 10));
    }
}
```

```
═══ 驗證 pickBatch 產生的 SQL ═══
Hibernate: select om1_0.id, ... from outbox om1_0
           where om1_0.status='PENDING' and om1_0.next_retry_at<=?
           order by om1_0.created_at limit ?,? for update skip locked
                                              ^^^^^^^^^^^^^^^^^^^^^^  ← 要看到這個

═══ 驗證 pickBatchNoLock 產生的 SQL ═══
Hibernate: select om1_0.id, ... from outbox om1_0
           where om1_0.status='PENDING' and om1_0.next_retry_at<=?
           order by om1_0.created_at limit ?,?
                                              ← 沒有 for update
```

⚠️ **這個測試值得長期留在你的專案裡**（斷言 SQL 含有 `skip locked`）。
理由：`-2` 這個魔術數字在**升級 Hibernate 版本、換資料庫方言、改 `@Query` 寫法**時
都可能安靜地失效，而失效的症狀是 2.5.1 那個「三台互搶」——
**在單機測試環境永遠不會出現。**

📌 順帶一提，那個 `-2` 不是憑空來的：

```java
System.out.println(org.hibernate.LockOptions.SKIP_LOCKED);    // -2
System.out.println(org.hibernate.LockOptions.NO_WAIT);        // 0
System.out.println(org.hibernate.LockOptions.WAIT_FOREVER);   // -1
```

⚠️ **`SKIP LOCKED` 是 MySQL 8.0 / PostgreSQL 9.5 之後才有的。**
MySQL 5.7 沒有 —— 這也是 00 章 0.6.3 堅持用 MySQL 8.0 的原因。
在沒有 `SKIP LOCKED` 的資料庫上，替代方案是「先 `UPDATE ... SET owner = ? WHERE status='PENDING' LIMIT 100`
再 `SELECT WHERE owner = ?`」（兩段式認領），但那要多一次寫入。

### 2.5.3 輪詢器的完整樣子

⚠️ **先講一個我差點寫錯的地方**，因為它是 Spring 最經典的陷阱之一。

**這個版本是錯的**：

```java
@Component
public class OutboxPoller {

    @Scheduled(fixedDelay = 500)
    public void poll() {
        int sent;
        do {
            sent = pumpOneBatch();      // ❌ 自我呼叫 —— @Transactional 不會生效
        } while (sent > 0);
    }

    @Transactional                      // ← 這個註解在這裡是裝飾品
    int pumpOneBatch() { ... }
}
```

實測（在 `pumpOneBatch()` 裡印 `TransactionSynchronizationManager.isActualTransactionActive()`）：

```
═══ 驗證輪詢器的寫法 ═══
  ① @Scheduled 方法裡自我呼叫 pumpOneBatch() : ❌ 沒有交易
  ② 從外面直接呼叫 helper.pumpOneBatch()      : 有交易
  ③ 呼叫另一顆 bean 的 pumpOneBatch()         : 有交易
```

📌 **原因**：`@Transactional` 是靠**動態代理**實作的。
外面的人呼叫 `poll()` 時走的是代理物件，但 `poll()` 裡面的 `pumpOneBatch()` 是
`this.pumpOneBatch()` —— **`this` 是原始物件，不是代理**，所以交易攔截器根本沒被觸發。

⚠️ **這個 bug 在 Outbox 上特別致命，因為它會安靜地拆掉 2.5.1 的全部保護**：

沒有交易 → JDBC 是 auto-commit → `SELECT ... FOR UPDATE SKIP LOCKED`
**在那一句 SQL 執行完的瞬間就把鎖放掉了**。
三台輪詢器於是全部撈到同一批 —— **退化成 2.5.1 那個「不加鎖」的結果：重送 100 則、吞吐 1/3**。

而且：**去重表看起來正常、日誌乾淨、測試會過**（單機測試只有一個輪詢器，看不出來）。

**正確的版本 —— 把交易方法放到另一顆 bean 上**：

```java
@Component
public class OutboxPoller {

    private static final Logger log = LoggerFactory.getLogger(OutboxPoller.class);
    private final OutboxPump pump;                    // ← 另一顆 bean

    /** 每 500 ms 跑一次；上一輪還沒跑完就不會重疊（fixedDelay 的語意） */
    @Scheduled(fixedDelay = 500)
    public void poll() {
        int sent;
        do {
            sent = pump.pumpOneBatch();               // ✅ 跨 bean 呼叫 → 走代理 → 有交易
        } while (sent > 0);
    }
}

@Component
public class OutboxPump {

    private static final Logger log = LoggerFactory.getLogger(OutboxPump.class);
    private final OutboxRepository outbox;
    private final RabbitTemplate rabbit;
    private final MeterRegistry meters;

    @Transactional
    public int pumpOneBatch() {                       // ⚠️ 必須是 public
        var batch = outbox.pickBatch(Instant.now(), PageRequest.of(0, 200));
        int sent = 0;
        for (OutboxMessage m : batch) {
            try {
                CorrelationData cd = new CorrelationData(m.getId());
                rabbit.convertAndSend(exchangeOf(m), m.getEventType(), m.getPayload(), cd);
                // ⚠️ 要等 confirm 才能標記 SENT —— 理由見 01 章 1.4.3
                if (!cd.getFuture().get(5, TimeUnit.SECONDS).isAck())
                    throw new IllegalStateException("broker nack");
                outbox.markSent(m.getId());
                sent++;
            } catch (Exception e) {
                // 指數退避：1, 2, 4, 8, 16... 秒，上限 5 分鐘
                long backoff = Math.min(300, 1L << Math.min(m.getAttempts(), 8));
                outbox.markRetry(m.getId(), Instant.now().plusSeconds(backoff), trim(e.getMessage()));
                log.warn("outbox send failed id={} attempts={} backoff={}s",
                        m.getId(), m.getAttempts() + 1, backoff, e);
            }
        }
        meters.gauge("outbox.pending", outbox.countByStatus("PENDING"));
        meters.gauge("outbox.failed",  outbox.countByStatus("FAILED"));
        return sent;
    }
}
```

⚠️ **還有兩件不能忘的事**：

```java
@SpringBootApplication
@EnableScheduling          // ← 沒有這一行，@Scheduled 完全不會跑，而且不會有任何錯誤
public class Lab11Application { ... }
```

- **`@EnableScheduling`**：漏了它，`@Scheduled` 方法**一次都不會被呼叫**，
  而且啟動日誌裡沒有任何提示。症狀是「outbox 一直長、訊息一則都沒送出去」。
- **`pumpOneBatch()` 必須是 `public`**：Spring Boot 3 用 CGLIB 代理，
  `private` 方法上的 `@Transactional` 一樣不生效（而且也一樣沒有錯誤）。

**這段程式碼裡有七個決定，每一個都有理由**：

| 決定 | 為什麼 |
|---|---|
| **交易方法放在另一顆 bean** | 見上方實測：自我呼叫 → **沒有交易 → `SKIP LOCKED` 的鎖立刻釋放 → 三台互搶** |
| `@Scheduled(fixedDelay = 500)` | ⚠️ **`fixedDelay` 不是 `fixedRate`。** `fixedRate` 會在上一輪還沒跑完時就啟動下一輪 → 同一個行程裡兩個輪詢器互搶 |
| `do { } while (sent > 0)` | **一輪撈到撈不到為止。** 只撈一批的話，尖峰時積壓永遠追不上（每 500 ms 只送 200 則 = 400 則/秒） |
| `batchSize = 200` | 太小追不上、太大會讓那個交易開太久（鎖住 200 列的期間別台都跳過它們） |
| **等 `confirm` 才 `markSent`** | 01 章 1.4.3：沒等 confirm 就標記 SENT，等於把「可能沒送到」記成「送到了」—— **Outbox 的價值瞬間歸零** |
| 指數退避 + `attempts >= 5` 轉 `FAILED` | 沒有退避 = 資料庫版的 00 章 0.5.2 風暴；沒有上限 = 毒藥訊息永遠佔著批次的位置 |
| `meters.gauge("outbox.pending")` | **這是你唯一的告警來源。** `PENDING` 持續上升 = 送不出去；`FAILED > 0` = 有人要去看 |

⚠️ **關於 `@Transactional` 開在 `pumpOneBatch()` 上的另一個重要細節**：
整批的 `SELECT ... FOR UPDATE` 與所有 `markSent` 在**同一個交易**裡。
這表示**這一批的鎖會持續到整批送完** ——
如果 broker 很慢（每則 5 ms × 200 則 = 1 秒），那就是**鎖住 200 列一整秒**。
其他輪詢器會 `SKIP LOCKED` 跳過它們（所以不會卡住），但這批的 `next_retry_at` 判斷會延遲。
📌 **實務上 batchSize 的上限就是這樣決定的：`batchSize × 單則耗時` 不要超過幾百毫秒。**

---

## 2.6 Outbox 表會長，而且長起來很快

一天 10 萬筆訂單、每筆 3 則事件 = 一天 **30 萬列**。一個月 900 萬列。
**這張表如果不清，會出三件事。**

### 2.6.1 實測：130 萬列的 outbox 表

```java
@SpringBootTest
class D6OutboxGrowthTest {

    @Autowired JdbcTemplate jdbc;

    static final String PICK = """
        SELECT * FROM outbox
        WHERE status='PENDING' AND next_retry_at <= NOW(6)
        ORDER BY created_at LIMIT 100
        """;

    @Test
    void growthHurts() {
        // ① 先灌 100 則 PENDING，量小表的耗時
        // ② 用「自我倍增」灌到 130 萬列 SENT，再量
        // ③ 把索引拿掉，再量
    }
}
```

**輸出**：

```
═══ 2.6.1 outbox 表不清理會怎樣 ═══
  ① 小表：資料 0.0 MB + 索引 0.0 MB（約 101 列）
     挑一批的耗時 : 1,680 µs

  ── 灌 100 萬列已送出（SENT）的歷史資料 ──
     灌完耗時 8,916 ms，總列數 = 1,327,392

  ② 大表（有索引）：資料 162.0 MB + 索引 87.0 MB（約 1283287 列）
     挑一批的耗時 : 1,977 µs
     EXPLAIN:
       type=range key=idx_outbox_pick rows=101 Extra=Using index condition; Using filesort

  ── 把索引拿掉（很多人的 outbox 表就是這樣）──
  ③ 大表（沒有索引）：資料 162.0 MB + 索引 87.0 MB（約 1283287 列）
     挑一批的耗時 : 491,684 µs
     EXPLAIN:
       type=ALL key=null rows=1283287 Extra=Using where; Using filesort
```

📌 **三個數字，一張表**：

| | 列數 | 索引 | 挑一批的耗時 | `EXPLAIN` |
|---|---|---|---|---|
| ① | 101 | 有 | **1,680 µs** | —— |
| ② | 130 萬 | 有 | **1,977 µs**（幾乎沒差） | `type=range`、`rows=101` |
| ③ | 130 萬 | **沒有** | **491,684 µs ≈ 492 ms**（慢 **293 倍**） | `type=ALL`、`rows=1283287` |

**第一個結論（反直覺的那個）**：
⚠️ **有索引的話，130 萬列幾乎不痛（1.68 ms → 1.98 ms，差在量測誤差範圍內）。**
真正的殺手不是「表很大」，是「**表很大而且沒有索引**」。
`type=ALL`、`rows=1283287` 就是全表掃描 —— 每 500 ms 跑一次的輪詢器，
**每一次都要掃 130 萬列、花將近半秒**。

📌 **492 毫秒 × 每秒 2 次 = CPU 有 98% 的時間在掃這張表。**
而且這是在「沒有其他負載」的情況下量的 —— 正式環境它會把資料庫的 buffer pool 汙染掉，
**讓所有其他查詢一起變慢**。這是 outbox 最經典的正式環境事故。

**第二個結論**：
`Extra` 裡那個 `Using filesort` 在 ② 是**便宜的** ——
因為 `rows=101`，它只排序 101 列。
⚠️ **但如果你的 `PENDING` 本身累積到幾十萬列**（broker 掛了一整天），
那個 filesort 就會變成真正的問題。**索引改成 `(status, next_retry_at, created_at)` 可以避開它** ——
把 `ORDER BY` 的欄位放進索引，讓 MySQL 直接照索引順序讀。

**第三個結論**：
**130 萬列 = 249 MB（162 資料 + 87 索引）。** 一個月 900 萬列 ≈ 1.7 GB。
這個大小本身不痛，但它會傳染到別的地方：

| 影響 | 說明 |
|---|---|
| 備份 / 還原時間 | 你的每日全量備份多了 1.7 GB，而**那 1.7 GB 全部是已經送出去的垃圾** |
| 主從複寫延遲 | 每一次 `INSERT` + `UPDATE status='SENT'` 都要走 binlog 到從庫 |
| `ALTER TABLE` | 哪天要加一個欄位，130 萬列的線上 DDL 就是一件要排程的事 |

### 2.6.2 怎麼清

```java
@Component
public class OutboxCleaner {

    /** 每天凌晨 3 點清掉三天前已送出的 */
    @Scheduled(cron = "0 0 3 * * *")
    public void clean() {
        int total = 0, batch;
        do {
            // ⚠️ 一定要分批。一次 DELETE 900 萬列會鎖到天亮
            batch = jdbc.update("""
                DELETE FROM outbox
                WHERE status = 'SENT' AND created_at < ?
                ORDER BY created_at
                LIMIT 5000
                """, Instant.now().minus(3, ChronoUnit.DAYS));
            total += batch;
            sleepQuietly(100);           // 讓出時間給正常流量
        } while (batch > 0);
        log.info("outbox cleaned {} rows", total);
    }
}
```

**四個要點**：

| 要點 | 為什麼 |
|---|---|
| **只刪 `SENT`** | `PENDING` 是還沒送的、`FAILED` 是要人看的 —— **兩個都不能刪** |
| **留幾天不要留幾小時** | 出事時你要能回答「訂單 9527 的訊息什麼時候送的」。留 3～7 天很划算 |
| **分批 + `LIMIT`** | 一次 `DELETE` 幾百萬列會產生巨大的 undo log、鎖住大量列、讓從庫延遲暴增 |
| **批次之間 `sleep`** | 清理是背景工作，不該影響線上 |

⚠️ **上面那段 SQL 是 MySQL 專用的。** `DELETE ... ORDER BY ... LIMIT` 是 MySQL 的擴充，
PostgreSQL 沒有：

```
ERROR:  syntax error at or near "ORDER"
LINE 3: DELETE FROM d1 WHERE t < now() ORDER BY t LIMIT 2;
                                       ^
```

**PostgreSQL 的等價寫法**（用子查詢挑出要刪的主鍵）：

```sql
DELETE FROM outbox
WHERE id IN (
  SELECT id FROM outbox
  WHERE status = 'SENT' AND created_at < ?
  ORDER BY created_at
  LIMIT 5000
);
```

⚠️ **但這個寫法在 MySQL 上跑不起來。** 實測（MySQL 8.0.46）：

```
ERROR 1235 (42000): This version of MySQL doesn't yet support
                    'LIMIT & IN/ALL/ANY/SOME subquery'
```

📌 **兩邊都通的寫法要多包一層 derived table**：

```sql
DELETE FROM outbox
WHERE id IN (
  SELECT id FROM (
    SELECT id FROM outbox
    WHERE status = 'SENT' AND created_at < ?
    ORDER BY created_at
    LIMIT 5000
  ) AS t                                -- ⚠️ MySQL 必須有這一層別名
);
```

⚠️ **那層 derived table 不只是為了繞過 `LIMIT` 的限制**，
它同時繞掉 MySQL 的另一條規則：**`DELETE` 的子查詢不能直接讀同一張表**
（`ERROR 1093: You can't specify target table ... for update in FROM clause`）。
📌 **實測這個版本在 MySQL 8.0.46 與 PostgreSQL 16 上都正常。**

📌 **另一個做法：分割表（partition by range on `created_at`）**，
每天一個 partition，清理變成 `ALTER TABLE outbox DROP PARTITION p20260918` ——
**瞬間完成、不產生 undo log**。
量大的時候（一天超過幾百萬列）這是唯一舒服的做法。

⚠️ **不要用 `TRUNCATE`。** 它會連 `PENDING` 一起清掉。

---

## 2.7 輪詢 vs CDC

輪詢器有一個內建的缺點：**延遲**。

`fixedDelay = 500` 表示訊息平均延遲 250 ms、最差 500 ms（加上 broker 的 0.3 ms）。
對「寄確認信」完全沒差，對「即時庫存同步」可能就不行了。

**另一條路：CDC（Change Data Capture）**——直接讀資料庫的 binlog。

```
   輪詢（polling）                        CDC（Debezium）
┌──────────┐                        ┌──────────┐
│  outbox  │                        │  outbox  │
└────┬─────┘                        └────┬─────┘
     │ 每 500 ms                          │ 寫入的那一刻
     │ SELECT ... FOR UPDATE              │ binlog 事件
     ▼                                    ▼
┌──────────┐                        ┌──────────────┐
│ 你的輪詢器 │                        │  Debezium    │  ← 另一個要維運的服務
└────┬─────┘                        │ (Kafka Connect)│
     │                              └──────┬───────┘
     ▼                                     ▼
  broker                                broker
```

📌 **逐項對照**：

| | 輪詢 | CDC（Debezium） |
|---|---|---|
| **延遲** | 平均 `fixedDelay / 2`（250 ms） | **毫秒級** |
| **資料庫負載** | 每 500 ms 一次查詢（有索引的話很便宜，2.6.1） | **零查詢**（讀 binlog，不碰表） |
| **程式碼量** | 約 50 行 | 0 行（但有一整套設定） |
| **要維運的東西** | 沒有（就在你的服務裡） | **Kafka Connect 叢集 + Debezium connector + 它自己的 offset 管理** |
| **需要的資料庫權限** | 普通的 `SELECT` / `UPDATE` | `REPLICATION SLAVE`、`REPLICATION CLIENT`、binlog 要開 `ROW` 格式 |
| **`status` 欄位** | 需要（`PENDING` → `SENT`） | ⚠️ **不需要**，甚至有害（見下方） |
| **需要清理嗎** | 需要（2.6） | 需要，而且**只能靠時間**（沒有 `SENT` 可以篩） |
| **失敗重試** | 你自己控制（`next_retry_at`、`attempts`） | Debezium 自己的重試機制，你控制不了細節 |
| **除錯** | `SELECT * FROM outbox WHERE ...` | 要看 connector 的狀態與它的 offset topic |
| **多台不互搶** | 靠 `SKIP LOCKED`（2.5） | 天生只有一個 connector 在讀 |

⚠️ **CDC 模式下 outbox 表的用法完全不同**：

```java
// CDC 模式：寫進去、然後立刻刪掉
@Transactional
public void placeOrder(cmd) {
    orders.save(order);
    OutboxMessage m = new OutboxMessage(...);
    outbox.save(m);
    outbox.delete(m);         // ← 對，馬上刪
}
```

**為什麼可以馬上刪？** 因為 Debezium 讀的是 **binlog**，
`INSERT` 已經寫進 binlog 了 —— **表裡有沒有那一列根本不重要**。
📌 這個「插入後立刻刪除」是 Debezium 官方文件推薦的 outbox 用法，
好處是**表永遠是空的**，2.6 那一整節的問題全部消失。

**那該選哪個？**

| 你的情況 | 建議 |
|---|---|
| 剛開始做、量不大、沒有專職 SRE | **輪詢。** 50 行程式碼、看得懂、查得動 |
| 需要「毫秒級」的事件延遲 | CDC |
| 已經有 Kafka Connect 叢集在跑（例如已經在做資料同步） | CDC（邊際成本低） |
| 一天超過幾千萬則事件，輪詢的查詢已經壓到資料庫 | CDC |
| 用的是雲端託管資料庫，不確定能不能開 binlog / 給複寫權限 | **輪詢**（先確認權限再說） |

📌 **本站的建議：從輪詢開始。**
它的缺點（250 ms 延遲）在絕大多數場景是無感的，
而它的優點（可觀測、可查詢、可手動介入）在出事的時候價值極高 ——
**你可以用一句 SQL 回答「訂單 9527 的訊息現在在哪」，CDC 做不到這件事。**

---

## 2.8 Outbox 沒有解決什麼

⚠️ **這一節很重要，因為很多人做完 Outbox 就以為安全了。**

### 2.8.1 它保證不了「只送一次」

**輪詢器自己有一個 2.3.2 的窗**：

```java
rabbit.convertAndSend(...);         // ① 訊息送出去了
cd.getFuture().get(...);            // ② confirm 回來了
                                    //    💥 就在這裡，行程被 kill
outbox.markSent(m.getId());         // ③ 還沒執行到
```

**結果**：訊息在 broker 上，但 outbox 那一列還是 `PENDING`。
輪詢器重啟之後 —— **它會再送一次**。

📌 **這個窗**不可能消除**，因為它又是一個雙寫問題**（broker + 資料庫）——
只是這次的兩邊換了位置。

**所以 Outbox 的保證是**：

> **at-least-once（至少一次）。不是 exactly-once。**

| Outbox 保證的 | Outbox 不保證的 |
|---|---|
| 交易提交了 → 訊息**最終一定會送出** | 訊息**只送一次** |
| 交易回滾了 → 訊息**一定不會送出** | 訊息**立刻**送出（有輪詢延遲） |
| 有一份完整的「送了沒」的紀錄 | 消費者**只處理一次** |

👉 **另外那一半是 03 章的工作**：消費端用訊息 ID 去重。
📌 **這就是 2.4.2 那個 `id` 欄位的用途** —— 它會跟著訊息一起送出去，
消費端拿它當去重的鍵。**兩章是一組的，缺一半就沒用。**

### 2.8.2 它保證不了順序

輪詢器 `ORDER BY created_at` 撈出來，看起來是有序的。**但**：

| 破壞順序的原因 | 說明 |
|---|---|
| **`SKIP LOCKED` 的分工** | 2.5.1 實測：三台各拿 `[88, 57, 55]`，**誰先送完不確定** |
| **失敗退避** | 訊息 A 失敗了退避 8 秒，這期間訊息 B、C、D 都送出去了 |
| **broker 那一端** | 00 章 0.5.1：Kafka 不給 key 就沒有順序；RabbitMQ 多消費者就沒有順序 |

📌 **所以如果你需要「同一張訂單的事件有序」**：

1. Outbox 這一端：`aggregate_id` 相同的訊息，**要嘛同一台輪詢器處理、要嘛不要並行**。
   （實務做法：`SKIP LOCKED` 改成按 `aggregate_id` 的 hash 分片，每台只處理自己那幾片。）
2. broker 這一端：Kafka 用 `aggregate_id` 當 key（07 章）。
3. **或者：放棄順序，用版本號讓消費者自己擋掉舊事件**（03 章的狀態機）。

⚠️ **第 3 個選項通常是最務實的。** 追求「端到端有序」的成本非常高，
而「消費者看到舊事件就忽略」只要一個 `WHERE version > ?`。

### 2.8.3 它沒有解決「消費者處理失敗」

Outbox 只管到「訊息進了 broker」。訊息進去之後：

- 消費者拿到了但處理失敗 → **01 章第三段** + 06 / 10 章的死信。
- 消費者處理了兩次 → **03 章的冪等**。
- 消費者根本沒上線 → 訊息在 broker 上積壓（RabbitMQ）或等著（Kafka）。

📌 **Outbox 的邊界很清楚：它只負責「第一段的最後一哩」。**

```
   [你的交易]  ──Outbox──▶  [broker]  ──01章第三段──▶  [消費者]  ──03章──▶ [業務完成]
       ▲                        ▲                         ▲
     2.4 節                  01 章 1.4                 01 章 1.5
```

---

## 2.9 常見誤區

**① 「訊息在 `@Transactional` 方法裡送，交易回滾訊息就不會送」**

2.2.2 實測：50 筆交易回滾，**100 則訊息全部送出去了**。
`RabbitTemplate` / `KafkaTemplate` **預設完全不參與 Spring 的交易**。

**② 「先寫資料庫、再送訊息，這樣順序就對了」**

2.2.1 實測：**99% 的消費者查不到那張訂單。**
不是「偶爾」，是「幾乎必然」—— 訊息跑完全程 0.3 ms，而 `COMMIT` 本身就要好幾毫秒。

**③ 「`AFTER_COMMIT` 就安全了」**

2.3.2 實測：100 筆訂單、**0 則訊息、0 個例外**。
`@TransactionalEventListener(AFTER_COMMIT)` 裡丟的例外**會被 Spring 吞掉** ——
這是刻意的（交易已經提交了，沒有別的選擇），但它讓失敗完全隱形。

**④ 「那個窗只有 46 微秒，機率可以忽略」**

2.3.2：**窗不是一個時間點，是「送訊息失敗」的整段期間。**
broker 掛 30 秒，那 30 秒裡的**每一筆**都命中，命中率 100%。

**⑤ 「Outbox 就是多一張表，很簡單」**

表是簡單的，**輪詢器不是**。少了 `SKIP LOCKED` → 2.5.1 的重送 100 則；
少了 `next_retry_at` → 毒藥訊息永遠佔著批次；
少了索引 → 2.6.1 的 492 毫秒全表掃描；
少了清理 → 一個月 1.7 GB 垃圾。

**⑥ 「輪詢器送出去就可以標記 SENT 了」**

⚠️ **不行。** 01 章 1.4.3：沒等 confirm 就 `markSent`，
等於把「可能沒送到」記成「送到了」—— **Outbox 的全部價值瞬間歸零**。
一定要 `cd.getFuture().get()` 確認 `isAck()`。

**⑦ 「`payload` 用 `@Lob String` 就對了，它是『大物件』」**

2.4.2 實測：Hibernate 6 在 MySQL 上把 `@Lob String` 映射成 **`tinytext`（上限 255 bytes）**，
**256 字元就 `Data too long`**。而那個例外會**把訂單交易一起回滾** ——
加了 Outbox 之後訂單反而下不了。
📌 明確寫 `@Column(columnDefinition = "TEXT")`，不要讓方言幫你決定。

**⑧ 「輪詢器就寫在一個 `@Component` 裡，`@Scheduled` 方法呼叫 `@Transactional` 方法」**

2.5.3 實測：自我呼叫 → **`@Transactional` 完全不生效**（`isActualTransactionActive()` 回 false）。
→ auto-commit → **`FOR UPDATE SKIP LOCKED` 的鎖在那一句 SQL 結束就放掉**
→ 退化成「不加鎖」→ 2.5.1 的重送 100 則。
⚠️ **而這個 bug 在單機測試上完全看不出來。**

**⑨ 「`@Scheduled(fixedRate = 500)` 跟 `fixedDelay = 500` 差不多」**

`fixedRate` 會在上一輪還沒跑完時就啟動下一輪 → **同一個行程裡兩個輪詢器互搶**。
`SKIP LOCKED` 會救你不重送，但你白白浪費一倍的資料庫連線。

**⑩ 「outbox 表的 `payload` 存 ID 就好，輪詢器再去查」**

2.4.2：那樣送出去的是「現在的狀態」，不是「當時發生了什麼」。
訂單在這 250 毫秒裡被改了，你的 `order.created` 事件裡就會是改過之後的資料。
📌 **事件要存快照。**

**⑪ 「做了 Outbox 就不用做冪等了」**

2.8.1：Outbox 的保證是 **at-least-once**。
輪詢器在「confirm 回來」與「`markSent`」之間掛掉 → **同一則會再送一次**。
**03 章不是選修。**

**⑫ 「Outbox 表要保證絕對即時，所以一定要用 CDC」**

2.7：輪詢的 250 ms 延遲在絕大多數場景是無感的，
而 CDC 的代價是「一整套 Kafka Connect + Debezium 要維運」+「出事時你沒辦法用 SQL 查」。
📌 **先用輪詢，痛了再換。**

---

## 2.10 本章小結

**這一章證明了四件事**：

1. **雙寫問題的兩種寫法都會錯**（2.2）：
   寫法 A **99% 失敗**、寫法 B **100 則訊息全是垃圾**。
2. **`AFTER_COMMIT` 解決了一半**（2.2.3、2.3）：
   它擋掉了「訊息早到」與「回滾卻送了」，但留下一個**完全隱形**的窗 ——
   實測 **100 筆訂單、0 則訊息、0 個例外**。
3. **Outbox 補上那一半**（2.4）：
   訂單與訊息**同一個交易**、broker 掛掉時訊息**留在表裡**、
   broker 好了**自動追上**，而且你有一句 SQL 可以查。
4. **Outbox 有它的工程細節，而且每一個都會咬人**（2.4、2.5、2.6）：
   `@Lob`（→ `tinytext`，256 字元就爆）、
   `@Scheduled` 自我呼叫（→ 交易失效 → `SKIP LOCKED` 保護消失）、
   `SKIP LOCKED`（不加 → 重送 100 則、吞吐掉到 1/3）、
   索引（不加 → 492 毫秒全表掃描，慢 293 倍）、
   清理（不清 → 一個月 1.7 GB）。

📌 **而它留下的那一半 —— at-least-once 的重複 —— 就是下一章。**

### 2.10.1 驗收清單

做得到才往下走：

- [ ] 用一句話定義雙寫問題，並說出三個「不是 MQ 也會遇到」的例子。
- [ ] 說出寫法 A 的失敗率為什麼是 99% 而不是「偶爾」（提示：比較兩個時間尺度）。
- [ ] 說出寫法 B 為什麼比寫法 A 更糟。
- [ ] 說出 `@TransactionalEventListener` 四個 phase 的差別，
      以及 **`AFTER_COMMIT` 裡丟例外會發生什麼**。
- [ ] 解釋「那個窗不是 46 微秒」這句話。
- [ ] 不看課文，寫出 outbox 表的欄位，並說出 `next_retry_at` 漏掉會怎樣。
- [ ] 說出 `@Lob String payload` 在 MySQL 上會變成什麼型別、上限多少，以及正確寫法。
- [ ] 說出「`@Scheduled` 方法自我呼叫 `@Transactional` 方法」會發生什麼，
      以及它為什麼會**安靜地**拆掉 `SKIP LOCKED` 的保護。
- [ ] 說出 `@EnableScheduling` 漏掉時的症狀。
- [ ] 說出 `payload` 為什麼要存快照而不是 ID。
- [ ] 說出 `FOR UPDATE` / `FOR UPDATE NOWAIT` / `FOR UPDATE SKIP LOCKED` 三者的差別，
      以及在 Spring Data JPA 裡怎麼寫出 `SKIP LOCKED`（那個 `-2`）。
- [ ] 說出 2.5.1 不加鎖時的三個後果（重送、吞吐 1/3、還剩 100 則 PENDING）。
- [ ] 說出 2.6.1 那三個數字（1,680 µs / 1,977 µs / 491,684 µs），
      並指出**真正的殺手是什麼**。
- [ ] 說出清理 outbox 的四個要點，以及為什麼不能 `TRUNCATE`。
- [ ] 說出輪詢 vs CDC 的三個關鍵差異，以及 CDC 模式下為什麼可以「插入後立刻刪除」。
- [ ] 說出 Outbox **保證**什麼、**不保證**什麼（三件事）。

### 2.10.2 本章練習

**練習一（15 分鐘）**：重跑 2.2.1，但把消費者改成「查不到就等 100 ms 再查一次，最多三次」。
**記錄失敗率。** 然後回答：這個「重試幾次」的做法，
在什麼情況下會失效？（提示：想 2.2.2 那 50 筆回滾的訂單。）

**練習二（20 分鐘）**：把 2.3.2 的 `crashInRelay` 改成「只有 10% 的機率丟例外」，
跑 1,000 筆，然後**用 SQL 找出「哪些訂單沒有對應的訊息」**。
你會發現：**你辦不到** —— 因為沒有任何地方記錄了「應該要送幾則」。
**這個練習的目的就是讓你親手撞到那面牆。**

**練習三（25 分鐘）**：把 2.5 的 `pickBatch` 裡的 `-2` 改成 `0`（`NOWAIT`），
三台輪詢器再跑一次。**記錄發生什麼。**
然後把 `@QueryHints` 整行刪掉（變成普通 `FOR UPDATE`），再跑一次。
**畫成一張表：三種鎖定模式 × (重複數 / 耗時 / 例外數)。**

**練習四（20 分鐘）**：重做 2.6.1，但這次在索引存在的情況下，
**把 `PENDING` 的數量從 100 改成 50 萬**（模擬 broker 掛了一整天）。
再量 `PICK` 的耗時，並看 `EXPLAIN` 的 `Extra`。
**那個 `Using filesort` 現在還便宜嗎？**
然後把索引改成 `(status, next_retry_at, created_at)` 再量一次。

**練習五（進階，40 分鐘）**：把 2.8.1 那個窗**實際打進去**：
在 `markSent()` 之前加一個「30% 機率丟例外」，跑 500 則，
然後數「佇列裡有幾則」與「outbox 裡 SENT 有幾列」。
**兩個數字會不一樣。** 記錄差額，並算出重複率。
這個數字就是 03 章要處理的量。

**練習六（進階，60 分鐘）**：把輪詢器改成**按 `aggregate_id` 分片**：
每台輪詢器只處理 `CRC32(aggregate_id) % 3 == myShard` 的訊息。
**驗證：同一張訂單的三個事件，一定由同一台輪詢器按順序送出。**
然後回答：這個做法在「一台輪詢器掛掉」時會發生什麼？
（提示：這就是 08 章 Kafka rebalance 要解決的同一個問題，只是換了場景。）

---

## 2.11 下一章預告

這一章的結論是：**Outbox 給你 at-least-once。**
上一章的結論是：**at-least-once 是唯一實務可行的選擇。**

**所以「重複」是確定會發生的，而下一章（03）就是處理它。**

03 章會先量「重複到底有多常」——**答案可能比你想的高很多**，
然後回答四個問題：

- **去重表要放哪？** 資料庫還是 Redis？
  實測：放 Redis 快 9.4 倍，但它會在一個你想不到的地方失效 ——
  **而且失效的時候你的去重完全靜默地不見了**。
- **「先查去重表、再處理業務」這個寫法有 bug 嗎？**
  有。實測：兩個消費者同時處理同一則重複訊息，**兩個都查到「沒處理過」**。
  這一章會把「去重與業務交易的原子性」講透 ——
  而答案跟 02 章一樣，是「把兩件事放進同一個交易」。
- **有哪些業務根本不需要去重？**
  `UPDATE orders SET status='PAID' WHERE id=?` 執行兩次跟一次一樣。
  這叫**天然冪等**，而且它比任何去重機制都可靠。
  03 章會給你一組判準，告訴你哪些操作可以改寫成天然冪等的形式 ——
  ⚠️ 包括那個看起來絕對不行的「扣庫存」。
- **處理到一半掛掉怎麼辦？**
  已經扣了庫存、還沒寄信，然後行程死了。重送之後：
  庫存會不會扣兩次？信會不會寄？
  這一章會給**三種收尾方式**，以及它們各自適用的場景。

03 章結束時，02 章那個 `outbox.id` 欄位終於會發揮作用 ——
**兩章合起來，才是一條完整的「不漏也不重複生效」的路徑。**
