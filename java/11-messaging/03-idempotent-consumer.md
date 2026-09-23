# 第 03 章：冪等消費

> [01 章](./01-reliable-delivery-three-hops.md) 的結論：**「不重不漏」做不到，唯一實務路線是 at-least-once + 冪等消費。**
> [02 章](./02-outbox-and-transactional-consistency.md) 的結論：**Outbox 給你 at-least-once ——「一定會送出」，但不保證「只送一次」。**
>
> **所以重複是確定會發生的。這一章處理它。**
>
> 但在寫任何去重程式碼之前，這一章要先讓你看三件事：
>
> **一、重複到底有多常。** 大部分人覺得「重複是罕見的邊界情況」。
> 3.2.1 的實測是一個「入帳 100 元」的消費者，100 則訊息、30% 的機率在 ack 之前掛掉：
> **實際處理了 144 次，一則訊息最多被處理 6 次，帳戶多入帳 4,400 元（超額 44%）。**
>
> **二、你憑直覺寫的去重，有 bug。** 幾乎所有人的第一版都是這樣：
> `if (已處理過) return; 處理業務; 記錄已處理;`
> 3.3.1 實測：四個消費者同時拿到同一則訊息，**去重表裡只有 1 列，但業務生效了 4 次、帳戶進了 400 元。**
> 這一章會給正確的寫法，以及一個**看起來對但會害你無限重投**的變體
> （資料是對的，但你會拿到三個 `UnexpectedRollbackException`）。
>
> **三、把去重表放 Redis，會讓訊息「永久消失」。** 3.5.1 實測 Redis 快 9.4 倍，很誘人。
> 3.5.2 實測它的失效：**業務交易回滾了，Redis 的去重鍵卻留下來** ——
> 這則訊息從此被判定為「已處理」，錢永遠不會入帳，**而且沒有任何紀錄**。
> ⚠️ 這比「重複處理」嚴重得多：重複可以對帳找出來，這個連痕跡都沒有。
>
> 最後 3.4 會給你**最好的解法：根本不要去重**。
> 有一整類業務操作跑一次跟跑一百次的結果一樣，而且**連「扣庫存」都可以改寫成那種形式**。

---

## 3.1 學習目標

完成本章後，你應該可以：

- 列出**五種**會造成重複投遞的情境，並說出哪幾種「沒有任何程式寫法可以避免」（3.2）。
- 量出重複造成的業務損害（3.2.1：超額入帳 44%、一則訊息被處理 6 次）。
- 說明「先查去重表、再處理業務」為什麼有競態，並說出它的失敗量級（3.3.1：生效 4 次）。
- 寫出正確的去重：**去重列與業務變更在同一個交易**，並解釋為什麼衝突要在交易**外面** catch（3.3.2）。
- 說出「在交易裡面 catch `DataIntegrityViolationException`」會發生什麼，
  以及為什麼那個 bug **從資料上看不出來**（3.3.3）。
- 分辨四種操作的冪等性（3.4.1），並把「扣庫存」改寫成冪等的形式（兩種方法）。
- 說出**天然冪等 / 業務唯一約束為什麼比訊息去重表更好**的三個理由（3.4.3、3.5.4）。
- 說出去重表放 Redis 的**效能收益**（9.4 倍）與**它會讓訊息永久消失**的機制（3.5）。
- 設計去重表的清理策略，並說出保留期該怎麼決定（3.5.4）。
- 說出「處理到一半掛掉」的**三種收尾方式**，並判斷哪一種適用於你的流程（3.6）。
- 說出冪等**做不到**的兩件事（3.7）。

---

## 3.2 重複是常態，不是例外

### 3.2.1 實測：一則入帳訊息，帳戶多了 44%

場景：一個「入帳」消費者。每則訊息代表「給 alice 加 100 元」，共 100 則。
消費者用手動 ack（01 章 1.5.1 證明這是對的做法），
**但有 30% 的機率在「業務做完」與「送出 ack」之間掛掉**。

```java
package com.example.lab11.ch03;

@SpringBootTest
class E1DuplicateRateTest {

    @Test
    void howOftenDoesItActuallyDuplicate() throws Exception {
        // 送 100 則「入帳 100 元」
        int N = 100;
        for (int i = 0; i < N; i++) rabbit.convertAndSend("", Q, "credit:" + i + ":100");

        ConnectionFactory cf = new ConnectionFactory();
        cf.setHost("localhost"); cf.setPort(5673); cf.setUsername("lab"); cf.setPassword("lab");

        Map<String, Integer> seen = new HashMap<>();
        int processedCount = 0, crashedAfterWork = 0, round = 0;

        while (admin.getQueueInfo(Q).getMessageCount() > 0 && round < 40) {
            round++;
            Connection conn = cf.newConnection();
            var ch = conn.createChannel();
            ch.basicQos(10);
            for (int i = 0; i < 10; i++) {
                GetResponse r = ch.basicGet(Q, false);            // 手動 ack
                if (r == null) break;
                String body = new String(r.getBody());

                // ── 這裡是「業務處理」：真的入帳 ──
                tx.executeWithoutResult(s -> {
                    Account a = accounts.findById("alice").orElseThrow();
                    a.add(100);
                    accounts.save(a);
                });
                processedCount++;
                seen.merge(body, 1, Integer::sum);

                // ── 業務做完了，現在要 ack ──
                if (Math.random() < 0.3) {
                    crashedAfterWork++;            // 💥 就在這裡掛掉：事情做了、ack 沒送出去
                } else {
                    ch.basicAck(r.getEnvelope().getDeliveryTag(), false);
                }
            }
            conn.close();      // 連線斷掉 → 沒 ack 的回到佇列（01 章 1.5.1 ③）
        }
        // ... 印出統計
    }
}
```

**輸出**：

```
═══ 3.2.1 「處理完了但 ack 沒送出去」到底會造成多少重複 ═══
  送出 100 則「入帳 100 元」，佇列積壓 = 100
  預期最終餘額 = 10,000 元

  不同的訊息數           : 100 則
  實際處理次數           : 144 次
  其中「做完但沒 ack」   : 44 次
  被處理超過一次的訊息   : 33 則（最多被處理 6 次）

  預期餘額 : 10,000 元
  實際餘額 : 14,400 元
  多入帳   : 4,400 元（44%）
```

⚠️ **停下來看三個數字**：

| 數字 | 意思 |
|---|---|
| **144 次處理 / 100 則訊息** | 平均每則被處理 1.44 次 |
| **一則最多被處理 6 次** | 它連續六次都在 ack 之前掛掉。**重複不是均勻分布的，它會集中在某幾則上** |
| **多入帳 4,400 元（44%）** | 這不是「帳差了一點」，這是**帳完全不能用** |

📌 **「最多被處理 6 次」這一項特別重要。**
如果你的重試上限是 3 次（很常見的設定），那這則訊息**永遠處理不完**，
它會一直在「處理 → 沒 ack → 回佇列」的迴圈裡繞，每一圈都真的入帳一次 ——
這是 00 章 0.5.2 那個風暴的**有副作用版本**。

### 3.2.2 五種造成重複的情境

| # | 情境 | 能不能靠寫程式避免 |
|---|---|---|
| ① | 消費者處理完了，**ack 送出前**行程掛掉 | ❌ **不能**。3.2.1 就是這個 |
| ② | 消費者處理完了、ack 送出了，**ack 在網路上丟了** | ❌ **不能** |
| ③ | 生產者送出了、confirm 在網路上丟了，生產者**重送** | ❌ 不能（Kafka 的冪等 producer 只能防單一 session，09 章） |
| ④ | Outbox 輪詢器在「confirm 回來」與「`markSent`」之間掛掉（02 章 2.8.1） | ❌ 不能 |
| ⑤ | Kafka 消費者處理完了、**offset 還沒提交就 rebalance** | ❌ 不能（08 章會實測） |
| — | 你自己的程式碼寫錯（同一則訊息處理兩次） | ✅ 能（但這不是本章的問題） |

📌 **前五種全部是 ❌。** 它們的共同形狀都一樣：

> **「做完事」與「記錄做完了」是兩個動作，中間有一個縫。**

而這正是 02 章雙寫問題的鏡像 —— 只是這次兩邊換了位置：

```
  02 章：  [寫資料庫]  ←縫→  [送訊息]
  03 章：  [處理業務]  ←縫→  [ack / 提交 offset]
```

⚠️ **所以 03 章的答案跟 02 章一樣：把兩件事塞進同一個交易。**
但這次有一個問題 —— **ack 不能放進資料庫交易裡**（它在 broker 上）。
所以我們退一步：**把「我處理過這則訊息了」這件事寫進資料庫，跟業務放同一個交易。**

```
                 broker 那一側（管不到）        資料庫這一側（管得到）
                ┌──────────────────┐       ┌────────────────────────────┐
  一則訊息 ───▶ │ deliver → ack     │       │ 業務變更 + 去重列（一個交易）│
                └──────────────────┘       └────────────────────────────┘
                      ↑ 這裡可能重複             ↑ 但這裡只會生效一次
```

📌 **這就是冪等消費的全部想法**：
**不要試圖讓「訊息只送一次」，而是讓「訊息生效只有一次」。**

---

## 3.3 去重表：正確的寫法與兩個錯誤的寫法

### 3.3.0 去重表長什麼樣子

```sql
CREATE TABLE processed_message (
  message_id    VARCHAR(64) PRIMARY KEY,   -- ← 全部的關鍵就是這個主鍵
  consumer      VARCHAR(64) NOT NULL,      -- 哪一個消費者處理的
  processed_at  DATETIME(6) NOT NULL
) ENGINE=InnoDB;
```

```java
@Entity
@Table(name = "processed_message")
public class ProcessedMessage {
    @Id @Column(length = 64) private String messageId;
    private String consumer;
    private Instant processedAt = Instant.now();

    protected ProcessedMessage() {}
    public ProcessedMessage(String messageId, String consumer) {
        this.messageId = messageId; this.consumer = consumer;
    }
}
```

⚠️ **`consumer` 欄位不是可選的。** 一則訊息常常有多個消費者
（00 章 0.3.2 的「扇出」：寄信、倉儲、分析各一個）。
如果主鍵只有 `message_id`，那**第一個處理完的消費者會把其他消費者全部擋掉**。

📌 **正確的主鍵應該是 `(message_id, consumer)` 複合鍵**：

```sql
CREATE TABLE processed_message (
  message_id    VARCHAR(64) NOT NULL,
  consumer      VARCHAR(64) NOT NULL,
  processed_at  DATETIME(6) NOT NULL,
  PRIMARY KEY (message_id, consumer)
) ENGINE=InnoDB;
```

（本章的實驗為了程式碼簡短用單一主鍵 + `consumer` 欄位，
**但你的正式環境請用複合主鍵**。）

**`message_id` 從哪裡來？**
📌 **02 章 2.4.2 那張 outbox 表的 `id` 欄位。** 它會跟著訊息一起送出去：

```java
// 生產端（Outbox 輪詢器）
MessagePostProcessor withId = m -> {
    m.getMessageProperties().setMessageId(outboxRow.getId());   // ← 這裡
    return m;
};
rabbit.convertAndSend(exchange, routingKey, payload, withId, correlationData);
```

```java
// 消費端
@RabbitListener(queues = "order.confirm-mail.q")
public void onMessage(String payload, @Header(AmqpHeaders.MESSAGE_ID) String messageId) { ... }
```

⚠️ **不要用「broker 給的 delivery tag」當去重鍵** ——
每次重投遞的 tag 都不一樣。去重鍵必須是**生產端決定的、跨重投遞不變的**。
Kafka 那一側可以用 `topic-partition-offset` 當鍵（因為 offset 固定），
但**用生產端的訊息 ID 更好** —— 因為它在「生產端重送」（3.2.2 的情境 ③）時也管得到。

### 3.3.1 ❌ 寫法一：先查、再處理、最後寫去重表

**這是 90% 的人的第一版。**

```java
    /** ❌ 寫法一：查 → 處理 → 寫去重表，三個獨立交易 */
    public String checkThenAct(String msgId) {
        if (w.isProcessed(msgId)) return "SKIPPED";     // ① 查
        w.credit(100);                                  // ② 處理（獨立交易）
        w.saveDedup(msgId);                             // ③ 寫去重表（獨立交易）
        return "DONE";
    }
```

**實測：四個消費者同時拿到同一則訊息**（例如 `prefetch` 大、`concurrency=4`，
或者 broker 在網路抖動後重投遞了三次）：

```
═══ 3.3.1 「先查去重表、再處理」的競態 ═══
  【① 查 → 處理 → 寫去重表（三個獨立交易）】4 個消費者同時拿到同一則訊息
    各自的結果 : {DONE=2, DONE(dedup conflict)=2}
    去重表列數 : 1
    帳戶餘額   : 400 元（正確答案是 100）
    結論       : ❌ 生效了 4 次
```

⚠️ **看那兩行的矛盾**：

```
  去重表列數 : 1          ← 去重表「看起來」是對的
  帳戶餘額   : 400 元      ← 但業務生效了 4 次
```

**這個 bug 最惡毒的地方就在這裡**：
去重表沒有重複、沒有髒資料、`SELECT count(*)` 是 1。
**你去查去重表，會得出「去重機制運作正常」的結論。**

**為什麼會這樣？** 因為①②③是三個獨立交易，中間有兩個縫：

```
  消費者 A    ① 查（沒有）──┐
  消費者 B    ① 查（沒有）──┤
  消費者 C    ① 查（沒有）──┤  四個都在①看到「沒處理過」
  消費者 D    ① 查（沒有）──┘
                             │
                             ▼
  A  ② 入帳 100  →  ③ 寫去重表 ✅
  B  ② 入帳 100  →  ③ 寫去重表 ❌ 主鍵衝突（但錢已經入了）
  C  ② 入帳 100  →  ③ 寫去重表 ❌ 主鍵衝突（但錢已經入了）
  D  ② 入帳 100  →  ③ 寫去重表 ❌ 主鍵衝突（但錢已經入了）
```

📌 **這是典型的 check-then-act 競態。** 「查」和「做」之間的任何空隙，
都足以讓另一個執行緒插隊。

⚠️ **順便注意 `{DONE=2, DONE(dedup conflict)=2}` 這個結果：
四個消費者裡有兩個回報「DONE」、兩個回報「DONE(dedup conflict)」——
沒有一個回報「SKIPPED」。**
也就是說，**從消費者的角度看，去重完全沒有發生作用。**

### 3.3.2 ✅ 寫法二：插入去重列 + 業務，同一個交易

**把「查」換成「插入」，靠資料庫的主鍵去擋。**

```java
    /** 交易邊界都在這一顆 bean 上 */
    @Service
    static class Worker {
        @Autowired ProcessedMessageRepository dedup;
        @Autowired AccountRepository accounts;

        /** 去重列 + 業務變更在同一個交易 */
        @Transactional(propagation = Propagation.REQUIRES_NEW)
        public boolean insertThenAct(String msgId, long n) {
            dedup.saveAndFlush(new ProcessedMessage(msgId, "credit"));   // ① 先插入，flush 讓衝突立刻發生
            accounts.increment("alice", n);                              // ② 同一個交易裡處理業務
            return true;
        }
    }

    @Service
    static class Caller {
        @Autowired Worker w;

        /** ✅ 衝突在交易「外面」catch */
        public String insertThenAct(String msgId) {
            try {
                w.insertThenAct(msgId, 100);
                return "DONE";
            } catch (DataIntegrityViolationException e) {
                return "SKIPPED";                 // 主鍵衝突 = 別人處理過了
            }
        }
    }
```

**實測**：

```
  【② 插入去重列 + 業務同一交易，外面 catch】4 個消費者同時拿到同一則訊息
    各自的結果 : {DONE=1, SKIPPED=3}
    去重表列數 : 1
    帳戶餘額   : 100 元（正確答案是 100）
    結論       : ✅ 只生效一次
```

✅ **`{DONE=1, SKIPPED=3}`、餘額 100 元。**

**三個關鍵設計，每一個都不能少**：

| 設計 | 為什麼 |
|---|---|
| **先插入，不是先查** | 插入是**原子的**（資料庫的主鍵約束由資料庫保證），查詢不是 |
| **`saveAndFlush`** 而不是 `save` | ⚠️ `save()` 只把 entity 放進 persistence context，**SQL 要等到 flush 才送出去** —— 那通常是交易提交的時候。那時候業務已經做完了 |
| **去重列與業務在同一個交易** | 業務失敗回滾 → 去重列也回滾 → 訊息重送時會**重新處理**（這是對的） |

📌 **另一種等價寫法：`INSERT ... ON DUPLICATE KEY UPDATE`（MySQL）或
`INSERT ... ON CONFLICT DO NOTHING`（PostgreSQL）**，看影響列數：

```java
    @Modifying
    @Query(value = """
           INSERT INTO processed_message(message_id, consumer, processed_at)
           VALUES (:id, :consumer, NOW(6))
           ON DUPLICATE KEY UPDATE message_id = message_id
           """, nativeQuery = true)
    int claim(@Param("id") String id, @Param("consumer") String consumer);

    // 回傳 1 = 新插入的（要處理）；0 = 已經有了（跳過）
```

⚠️ **這個寫法比 try-catch 好，因為它不需要靠例外控制流程** ——
例外在 JVM 裡不便宜，而且它會汙染你的錯誤日誌與 APM 的錯誤率。
📌 **但要小心 MySQL 的 `ON DUPLICATE KEY UPDATE` 在「值沒變」時回傳 0，
在「有更新」時回傳 2**（不是 1）—— 所以判斷條件要寫 `== 1` 而不是 `> 0`。

### 3.3.3 ⚠️ 寫法三：對的想法，錯的位置

**這個寫法看起來只是把 try-catch 搬進去，而且資料是正確的** ——
但它會讓你的消費者無限重投。

```java
        /** ❌ 在交易「裡面」catch 衝突 */
        @Transactional(propagation = Propagation.REQUIRES_NEW)
        public boolean catchInsideTransaction(String msgId, long n) {
            try {
                dedup.saveAndFlush(new ProcessedMessage(msgId, "credit"));
            } catch (DataIntegrityViolationException e) {
                return false;                     // 看起來很合理…
            }
            accounts.increment("alice", n);
            return true;
        }
```

**實測**：

```
  【③ 同一交易，但在交易「裡面」catch】4 個消費者同時拿到同一則訊息
    各自的結果 : {DONE=1, UnexpectedRollbackException=3}
    去重表列數 : 1
    帳戶餘額   : 100 元（正確答案是 100）
    結論       : ✅ 只生效一次
```

⚠️ **餘額是對的（100 元），但那三個消費者拿到了 `UnexpectedRollbackException`。**

**為什麼？**

```
  1. saveAndFlush() 撞到主鍵衝突 → Hibernate 丟例外
  2. Spring 的交易管理器看到這個例外 → 把交易標記為 rollback-only
  3. 你 catch 掉了例外、return false —— 但交易已經是「只能回滾」了
  4. 方法結束、Spring 要提交交易 → 發現它是 rollback-only
  5. → 丟 UnexpectedRollbackException
     "Transaction silently rolled back because it has been marked as rollback-only"
```

📌 **關鍵觀念：`@Transactional` 方法裡的資料庫例外，會「毒化」整個交易。**
你 catch 得掉那個例外，但 catch 不掉「交易已經死了」這個狀態。

**這個 bug 為什麼特別難查**：

| 你看到的 | 實際情況 |
|---|---|
| 資料完全正確（餘額 100 元） | ✅ 是的，去重確實生效了 |
| 但消費者丟例外 | → `@RabbitListener` 的 `auto` ack 模式會 **nack + requeue** |
| → 訊息回到佇列 → 再投遞 | → 再撞一次主鍵衝突 → 再丟 `UnexpectedRollbackException` |
| **→ 00 章 0.5.2 的風暴** | 積壓顯示 0、CPU 滿載、日誌一秒幾千行、**而資料是對的** |

⚠️ **所以這個 bug 的症狀是「資料完全正確，但服務在燒」** ——
你去查資料，一切正常；你去查日誌，一秒幾千個 `UnexpectedRollbackException`。

📌 **正確做法（3.3.2）：讓交易死掉，在交易外面 catch。**
或者用 `ON DUPLICATE KEY` 那個不靠例外的寫法 —— **那個寫法根本不會產生例外，最乾淨。**

### 3.3.4 三種寫法的總表

| 寫法 | 業務生效次數 | 去重表 | 消費者看到 | 換 DB / 換 ORM 還安全嗎 | 可以上線嗎 |
|---|---|---|---|---|---|
| ① 查 → 處理 → 寫去重表 | ❌ **4 次** | 1 列（看起來正常） | `DONE` × 2、`DONE(conflict)` × 2 | —— | ❌ |
| ② 插入 + 業務同一交易，**外面** catch | ✅ 1 次 | 1 列 | `DONE` × 1、`SKIPPED` × 3 | ✅ 都安全 | ✅ |
| ③ 同一交易，**裡面** catch | ✅ 1 次 | 1 列 | `DONE` × 1、**`UnexpectedRollbackException` × 3** | ❌ 看 DB / ORM（3.4.3） | ❌ 資料對但會無限重投 |
| ④ `INSERT ... ON DUPLICATE KEY`（不靠例外） | ✅ 1 次 | 1 列 | `DONE` × 1、`SKIPPED` × 3 | ✅ 都安全 | ✅ **最推薦** |

📌 **②④ 之所以推薦，不只是因為「這次能動」，而是因為它們的正確性不依賴
「你用哪個資料庫、哪個 ORM、哪個版本」** —— 3.4.3 會把那張相依矩陣攤開給你看。

---

## 3.4 更好的答案：根本不需要去重

去重表有成本：一張會無限長的表（3.5.4）、每則訊息多一次寫入、
以及 3.3 那些很容易寫錯的細節。

📌 **而有一整類操作，跑一次跟跑一百次的結果完全一樣 —— 那些操作不需要去重。**

### 3.4.1 實測：四種操作跑三次

```java
@SpringBootTest
class E3NaturalIdempotenceTest {

    @Test
    void whichOperationsSurviveBeingRunTwice() {
        // ① 設成絕對值
        // ② 相對變化
        // ③ 加一張「做過了」的表
        // ④ 狀態機 CAS
    }
}
```

**輸出**：

```
═══ 3.4.1 同一個操作跑三次，結果一樣嗎 ═══

  ① UPDATE orders SET status='PAID' WHERE id='ORD-1'   （設成絕對值）
     第 1 次：影響 1 列，status = PAID
     第 2 次：影響 1 列，status = PAID
     第 3 次：影響 1 列，status = PAID
     ✅ 天然冪等：跑幾次都一樣

  ② UPDATE stock SET qty = qty - 1 WHERE sku='SKU-1' AND qty >= 1   （相對變化）
     第 1 次：影響 1 列，qty = 99
     第 2 次：影響 1 列，qty = 98
     第 3 次：影響 1 列，qty = 97
     ❌ 不冪等：扣了 3 次。⚠️ 注意 `AND qty >= 1` 完全沒有幫助

  ③ 加一張「這張訂單扣過了」的表，用主鍵擋（同一個交易）
     第 1 次：扣了（影響 1 列）                          qty = 99
     第 2 次：跳過（DuplicateKeyException：這張訂單扣過了）  qty = 99
     第 3 次：跳過（DuplicateKeyException：這張訂單扣過了）  qty = 99
     ✅ 變成冪等了：訂單 ID 當主鍵，第二次插入就被資料庫擋掉

  ④ 不用額外的表：把「扣掉多少」記在訂單上，用 WHERE 擋
     第 1 次：狀態機推進 1 列 → qty = 99，status = STOCK_RESERVED
     第 2 次：狀態機推進 0 列 → qty = 99，status = STOCK_RESERVED
     第 3 次：狀態機推進 0 列 → qty = 99，status = STOCK_RESERVED
     ✅ 也冪等了：狀態機只能往前走一次（CAS：compare-and-set）
```

### 3.4.2 判斷準則：絕對值 vs 相對變化

📌 **一條規則就可以判斷大部分情況**：

> **「設成什麼」是冪等的（absolute）。「加減什麼」不是（relative）。**

| 操作 | 冪等？ | 為什麼 |
|---|---|---|
| `SET status = 'PAID'` | ✅ | 設成絕對值 |
| `SET balance = 5000` | ✅ | 同上 |
| `SET updated_at = '2026-09-21 10:00:00'`（用事件裡的時間） | ✅ | 同上 |
| `SET updated_at = NOW()` | ⚠️ 資料會變，但**業務上通常無害** | 半冪等 |
| `SET qty = qty - 1` | ❌ | 相對變化 |
| `SET balance = balance + 100` | ❌ | 同上 |
| `INSERT INTO log(...)` | ❌ | 每次都多一列 |
| `INSERT ... (主鍵是業務 ID)` | ✅ | 第二次被主鍵擋掉 |
| 寄一封信 / 呼叫別人的 API | ❌ | **而且沒辦法回滾** |
| `DELETE FROM x WHERE id = ?` | ✅ | 刪不存在的東西不是錯誤 |

⚠️ **實測 ② 裡那個 `AND qty >= 1` 值得特別提。**
很多人會覺得「我加了條件判斷，所以安全了」——
**那個條件防的是「賣超」，不是「重複」**。
`qty=100` 的時候跑三次，三次都滿足 `qty >= 1`，三次都扣。

### 3.4.3 把不冪等的操作改寫成冪等的

**⚠️ 這一節是本章最實用的部分。**

**方法一：加一張「做過了」的表，鍵用業務 ID**（實測 ③）

```java
@Transactional
public void reserveStock(String orderId, String sku, int qty) {
    try {
        // order_id 是主鍵 —— 同一張訂單只能扣一次
        jdbc.update("INSERT INTO stock_reservation(order_id, sku, qty) VALUES (?,?,?)",
                    orderId, sku, qty);
    } catch (DuplicateKeyException e) {
        return;                            // 這張訂單扣過了
    }
    int n = jdbc.update("UPDATE stock SET qty = qty - ? WHERE sku = ? AND qty >= ?", qty, sku, qty);
    if (n == 0) throw new OutOfStockException(sku);      // 這才是真的沒貨
}
```

⚠️⚠️ **等一下 —— 這不是 3.3.3 說「絕對不能做」的事嗎？**

**在交易裡面 `catch` 主鍵衝突然後 `return`** —— 3.3.3 的實測明明說那會得到 `UnexpectedRollbackException`。
**但這一節的實測（3.4.1 ③）卻是正常的。** 兩個結論都是真的，差別在**兩個變因**。

先看實測：同樣的寫法（`@Transactional` + 在裡面 catch），改用 `JdbcTemplate` + MySQL：

```
═══ JdbcTemplate 在交易裡面 catch（MySQL）═══
  第 1 次：DONE                              qty = 99
  第 2 次：SKIPPED（這張訂單扣過了）              qty = 99
  第 3 次：SKIPPED（這張訂單扣過了）              qty = 99
```

✅ **可以。** 那 3.3.3 為什麼不行？因為那裡用的是 **JPA 的 `saveAndFlush()`**。

📌 **變因一：JPA vs JdbcTemplate**

| | 交易裡撞到主鍵衝突之後 |
|---|---|
| **JPA / Hibernate**（`save`、`saveAndFlush`、`persist`） | Hibernate 把 `EntityManager` 標成**不可用**、交易標成 **rollback-only**。你 catch 得掉例外，但交易已經死了 → `UnexpectedRollbackException` |
| **`JdbcTemplate` / 原生 SQL** | Spring 只是把 SQL 例外翻譯成 `DuplicateKeyException`，**不會**標記 rollback-only。交易還活著 |

📌 **變因二：MySQL vs PostgreSQL —— 這個更重要，因為它會讓你換資料庫時整套壞掉**

把同一組 SQL 在兩邊各跑一次：

```sql
BEGIN;
INSERT INTO t(id) VALUES ('a');
INSERT INTO t(id) VALUES ('a');   -- 主鍵衝突
SELECT 'still alive?' AS probe;   -- 衝突之後還能查嗎？
INSERT INTO t(id) VALUES ('b');
COMMIT;
SELECT count(*) FROM t;
```

**MySQL 8.0**：

```
ERROR 1062 (23000): Duplicate entry 'a' for key 't.PRIMARY'
probe
still alive?                      ← 交易還活著
rows_after
2                                 ← 'a' 跟 'b' 都在，COMMIT 成功了
```

**PostgreSQL 16**：

```
INSERT 0 1
ERROR:  duplicate key value violates unique constraint "t_pkey"
ERROR:  current transaction is aborted, commands ignored until end of transaction block
ROLLBACK                          ← COMMIT 變成了 ROLLBACK
 rows_after
          0                       ← 一列都沒有
```

⚠️ **PostgreSQL 在交易裡發生任何 SQL 錯誤之後，整個交易就被中止了** ——
後續所有命令被忽略，`COMMIT` 自動變成 `ROLLBACK`。
**所以「在交易裡面 catch 然後繼續」這個寫法在 PostgreSQL 上根本不成立**
（除非你用 `SAVEPOINT`，也就是 Spring 的 `Propagation.NESTED`）。

📌 **把兩個變因合成一張表 —— 這是本節最該記住的東西**：

| 存取方式 | MySQL | PostgreSQL |
|---|---|---|
| `JdbcTemplate` + 交易裡 catch | ✅ 可以 | ❌ 交易已中止 |
| JPA `saveAndFlush` + 交易裡 catch | ❌ `UnexpectedRollbackException` | ❌ 兩個原因都成立 |
| **交易「外面」catch**（3.3.2 的寫法） | ✅ | ✅ |
| **`INSERT ... ON DUPLICATE KEY` / `ON CONFLICT DO NOTHING`**（不產生例外） | ✅ | ✅ |

👉 **所以本站的建議是後兩種**：
**要嘛在交易外面 catch，要嘛用「根本不會產生例外」的 SQL。**
這兩種寫法**跟資料庫與 ORM 都無關**，換什麼都不會壞。

上面那段 `reserveStock` 改成不靠例外的版本：

```java
@Transactional
public void reserveStock(String orderId, String sku, int qty) {
    // MySQL 用 ON DUPLICATE KEY UPDATE；PostgreSQL 用 ON CONFLICT DO NOTHING
    int claimed = jdbc.update(
            "INSERT INTO stock_reservation(order_id, sku, qty) VALUES (?,?,?) "
          + "ON DUPLICATE KEY UPDATE order_id = order_id",
            orderId, sku, qty);
    if (claimed != 1) return;                           // 0 = 這張訂單扣過了

    int n = jdbc.update("UPDATE stock SET qty = qty - ? WHERE sku = ? AND qty >= ?", qty, sku, qty);
    if (n == 0) throw new OutOfStockException(sku);      // 這才是真的沒貨
}
```

📌 **注意這跟 3.3.2 的去重表長得一樣，但它們是兩件不同的事**：

| | 去重表（3.3） | 業務唯一約束（這裡） |
|---|---|---|
| 鍵是什麼 | **訊息 ID**（傳輸層的概念） | **訂單 ID**（業務層的概念） |
| 它保護的 | 「這則訊息處理過了」 | 「這張訂單扣過庫存了」 |
| 訊息重送 | 擋得住 | 擋得住 |
| **使用者按了兩次送出，產生兩則不同的訊息** | ⚠️ **擋不住**（訊息 ID 不同） | ✅ **擋得住** |
| 上游改用 Kafka / 改成 HTTP 呼叫 | 要重寫 | **不用改** |

⚠️ **最後兩列是關鍵。** 業務唯一約束比訊息去重**強壯得多**，
因為它防的是「這件業務事實只能發生一次」，而不是「這則訊息只能處理一次」。

📌 **所以本站的建議順序是**：
**① 先看能不能天然冪等（3.4.2）→ ② 再看能不能加業務唯一約束 → ③ 最後才用訊息去重表。**

**方法二：狀態機 + CAS**（實測 ④）

```java
@Transactional
public void reserveStock(String orderId, String sku, int qty) {
    // 只有「還在 CREATED」的訂單才推得動，而且只有一個人推得動
    int advanced = jdbc.update(
        "UPDATE orders SET status = 'STOCK_RESERVED' WHERE id = ? AND status = 'CREATED'", orderId);
    if (advanced == 0) return;             // 別人已經推過了，或者狀態不對

    int n = jdbc.update("UPDATE stock SET qty = qty - ? WHERE sku = ? AND qty >= ?", qty, sku, qty);
    if (n == 0) throw new OutOfStockException(sku);
}
```

**這個寫法的好處**：

- **不用多一張表。** 狀態本來就在訂單上。
- **順便解決了順序問題**（02 章 2.8.2）：
  一個 `PAID` 事件比 `CREATED` 事件先到？`WHERE status = 'CREATED'` 會擋掉它。
  📌 **狀態機天生就會忽略「不該現在發生」的事件。**
- **它同時是一把鎖。** `UPDATE ... WHERE status = ?` 是原子的，
  所以兩個消費者同時來，只有一個的 `advanced` 會是 1。

⚠️ **它的限制**：狀態機只能**往前走**。
如果你的業務有「回退」（訂單從 `SHIPPED` 退回 `PAID`），
那 `WHERE status = ?` 就要小心寫，否則重複的事件會在狀態之間來回彈。
**通常的解法是加一個單調遞增的 `version` 或 `event_seq`**：

```sql
UPDATE orders SET status = ?, event_seq = ?
WHERE id = ? AND event_seq < ?        -- 只接受比目前更新的事件
```

📌 **這個 `event_seq` 由生產端決定**（例如 outbox 表的自增 ID，或事件裡的邏輯時鐘）。
它讓消費者**完全不需要順序保證** —— 舊事件到了就自己忽略。
**這是 02 章 2.8.2 說的「最務實的第 3 個選項」的具體寫法。**

### 3.4.4 三種手段的選擇順序

```
                  這個操作跑兩次結果一樣嗎？
                            │
             ┌──────────────┴──────────────┐
            是                             否
             │                              │
      ✅ 什麼都不用做          能不能加一個「業務 ID 唯一」的約束？
        （3.4.2 的 ①）                      │
                             ┌──────────────┴──────────────┐
                            能                             不能
                             │                              │
              ✅ 業務唯一約束 / 狀態機          有外部副作用（寄信、呼叫 API）？
                （3.4.3 方法一、二）                        │
                                             ┌──────────────┴──────────────┐
                                            有                             沒有
                                             │                              │
                              ⚠️ 訊息去重表 + 3.6 的收尾        ✅ 訊息去重表
                                                                  （3.3.2）
```

---

## 3.5 去重表放哪裡：資料庫 vs Redis

### 3.5.1 實測：Redis 快 9.4 倍

```java
    @Test
    void throughput() {
        int N = 2000;
        // 熱身…
        long s = System.nanoTime();
        for (int i = 0; i < N; i++) dedup.save(new ProcessedMessage("db-" + i, "c"));
        long dbMs = (System.nanoTime() - s) / 1_000_000;

        s = System.nanoTime();
        for (int i = 0; i < N; i++) redis.opsForValue().setIfAbsent("bench:r:" + i, "1", Duration.ofHours(24));
        long rdMs = (System.nanoTime() - s) / 1_000_000;
        // …
    }
```

**輸出**：

```
═══ 3.5.1 去重表放哪：資料庫 vs Redis ═══
  MySQL  INSERT processed_message x 2,000 : 3,388 ms →     590 次/秒
  Redis  SET NX EX x 2,000                :   362 ms →   5,524 次/秒
  Redis 快 9.4 倍
```

**很誘人**：590 次/秒 vs 5,524 次/秒，而且 Redis 的 `SET NX EX` 自帶過期時間 ——
連 3.5.4 那個清理問題都順便解決了。

⚠️ **但下一節會讓你不敢用它。**

### 3.5.2 ⚠️ Redis 去重會讓訊息永久消失 ★★★

```java
    @Service
    static class RedisDedupService {
        @Autowired StringRedisTemplate redis;
        @Autowired AccountRepository accounts;

        /** ❌ Redis 去重 + 資料庫業務：兩個系統，又是一次雙寫 */
        @Transactional(propagation = Propagation.REQUIRES_NEW)
        public boolean handle(String msgId, boolean businessWillFail) {
            Boolean first = redis.opsForValue().setIfAbsent("dedup:" + msgId, "1", Duration.ofHours(24));
            if (!Boolean.TRUE.equals(first)) return false;      // 已經處理過
            accounts.increment("alice", 100);
            if (businessWillFail) throw new IllegalStateException("下游的帳務系統 500");
            return true;
        }
    }
```

**實測**：

```
═══ 3.5.2 ⚠️ Redis 去重的致命失效：訊息永久消失 ═══
  情境：業務處理失敗了（下游 500），所以交易回滾、訊息會被重送
    第 1 次：業務丟例外 IllegalStateException → 交易回滾
    交易回滾後餘額 = 0 元（正確，沒有入帳）
    但 Redis 的去重鍵還在嗎 = true

  broker 把這則訊息重送過來（因為消費者丟了例外，沒 ack）：
    第 2 次：去重判定 = ❌ 已處理過，跳過
    最終餘額 = 0 元（應該是 100）

  ── 同一個情境，改用資料庫去重表 ──
    第 1 次：業務丟例外 → 交易回滾
    去重表裡有這則嗎 = false  ← 跟著交易一起回滾了
    第 2 次：去重判定 = ✅ 要處理
    最終餘額 = 100 元
```

⚠️⚠️ **`最終餘額 = 0 元`。那筆錢永遠不會入帳。**

**為什麼？** 又是雙寫問題（02 章），只是這次的兩邊是 **Redis 與 MySQL**：

```
  @Transactional {
      redis.setIfAbsent("dedup:M-1", ...)     ← ⚠️ Redis 不在資料庫交易裡
      accounts.increment(...)                 ← 這個在
      throw new Exception()                   ← MySQL 回滾了，Redis 沒有
  }
```

**結果**：

| | Redis 去重 | 資料庫去重表 |
|---|---|---|
| 業務成功 | ✅ 正確 | ✅ 正確 |
| **業務失敗回滾** | ❌ **去重鍵留下 → 訊息永久被跳過** | ✅ 去重列一起回滾 → 重送時重新處理 |
| 事後查得出來嗎 | ❌ **完全沒有痕跡** | ✅ 去重表就是紀錄 |
| 效能 | 5,524 次/秒 | 590 次/秒 |

📌 **「訊息永久消失」比「重複處理」嚴重得多**：

- **重複**：可以對帳找出來（餘額多了 4,400 元，一查就知道）、可以事後沖正。
- **永久跳過**：帳沒動、去重鍵過期後就連 Redis 裡也沒了、
  broker 上的訊息已經 nack 進死信或被丟掉。
  **你沒有任何一個地方可以查出「這筆漏了」。**

⚠️ **而且這個 bug 在測試環境幾乎不會出現** ——
因為測試時業務邏輯不會失敗。它只在正式環境下游出問題時才發作，
**而那正好是你最需要重試機制正常運作的時候。**

### 3.5.3 那 Redis 完全不能用嗎？

**可以用，但要換一個用法：把它當「快取」，不當「真相」。**

```java
@Transactional
public void handle(String msgId, Payload p) {
    // ① 先問 Redis：只有「確定處理過」的答案可以信
    if (Boolean.TRUE.equals(redis.hasKey("dedup:" + msgId))) return;    // 快速路徑

    // ② Redis 說沒有 → 還是要問資料庫（真相在這裡）
    try {
        dedupRepo.saveAndFlush(new ProcessedMessage(msgId, "credit"));
    } catch (DataIntegrityViolationException e) {
        throw new AlreadyProcessedException();       // 交易外面 catch（3.3.2）
    }
    accounts.increment("alice", 100);

    // ③ 交易提交成功之後才寫 Redis —— 這樣就不會有 3.5.2 的問題
    TransactionSynchronizationManager.registerSynchronization(
        new TransactionSynchronization() {
            @Override public void afterCommit() {
                redis.opsForValue().set("dedup:" + msgId, "1", Duration.ofHours(24));
            }
        });
}
```

**這個寫法的性質**：

| | 說明 |
|---|---|
| Redis 說「處理過」 | 一定是真的（只在 `afterCommit` 寫入）→ **可以直接跳過** |
| Redis 說「沒處理過」 | **可能是錯的**（鍵過期了、Redis 重啟了、還沒寫進去）→ **要問資料庫** |
| Redis 掛掉 | 全部退化成問資料庫 → **慢，但正確** |
| 效能 | 重複的訊息走快速路徑（Redis）；正常訊息還是要寫資料庫 |

⚠️ **要看清楚它省了什麼**：它省的是「**重複**訊息的資料庫查詢」。
正常訊息還是要寫一次資料庫（因為那是真相）。
📌 **所以只有在「重複率很高」的場合才值得加這一層**
（例如上游在瘋狂重送、或者你剛做完一次大重放）。
**一般情況下，直接用資料庫去重表就好 —— 590 次/秒對絕大多數系統夠用。**

### 3.5.4 去重表要清

跟 02 章的 outbox 一樣，這張表會無限長。**但清理策略完全不同**：

⚠️ **關鍵問題：保留多久？**

```
  保留期太短 → 一則超過保留期才重送的訊息，會被重新處理一次（去重失效）
  保留期太長 → 表無限長（02 章 2.6.1 的問題）
```

📌 **保留期的下限，是「一則訊息最久可能多晚才重送」**：

| 來源 | 最久可能多晚 |
|---|---|
| RabbitMQ 的 `unacked` 回到佇列 | 消費者連線斷掉的那一刻（秒級） |
| 死信佇列被人工重放（10 章） | **幾天**（等有人上班處理） |
| Kafka 的 offset 重設重放（00 章 0.4.3） | **retention 的長度**（預設 7 天） |
| Outbox 輪詢器重送（02 章 2.8.1） | 退避上限（分鐘級） |
| 上游系統整批重送（對帳補單） | **可能一個月** |

⚠️ **所以「保留 24 小時」對很多系統是不夠的** ——
如果你有「死信重放」或「Kafka 重讀」的流程，保留期必須 **>= 那個流程的最大延遲**。

```java
@Component
public class DedupCleaner {
    /** 每天凌晨 4 點清掉保留期之外的 */
    @Scheduled(cron = "0 0 4 * * *")
    public void clean() {
        int batch;
        do {
            batch = jdbc.update("""
                DELETE FROM processed_message
                WHERE processed_at < ?
                ORDER BY processed_at
                LIMIT 5000
                """, Instant.now().minus(30, ChronoUnit.DAYS));   // ← 跟你的重放窗口對齊
            sleepQuietly(100);
        } while (batch > 0);
    }
}
```

⚠️ 跟 02 章 2.6.2 一樣，`DELETE ... ORDER BY ... LIMIT` **是 MySQL 專用的**；
PostgreSQL 要改成 `DELETE ... WHERE message_id IN (SELECT ... ORDER BY ... LIMIT 5000)`。

📌 **如果你用的是 3.4.3 的「業務唯一約束」，這整節都不需要** ——
因為 `stock_reservation` 那張表的生命週期跟訂單一樣長，**它本來就該留著**。
**這是天然冪等 / 業務約束比訊息去重好的第三個理由。**

---

## 3.6 處理到一半掛掉

去重解決了「同一則訊息生效兩次」。**但如果第一次只做了一半呢？**

場景：`① 扣 1 件庫存 → ② 寄信 → ③ 標記完成`，
第一次在「寄信之前」掛掉 —— **庫存已經扣了**。訊息重送之後會怎樣？

### 3.6.1 實測：三種寫法

```java
@SpringBootTest
class E5PartialFailureTest {

    @Service
    static class Steps {
        /** ❌ 寫法一：三個步驟、沒有狀態、整段重跑 */
        public void naive(String orderId, int crashAtStep) {
            jdbc.update("UPDATE stock SET qty = qty - 1 WHERE sku='SKU-1' AND qty >= 1");   // ①
            if (crashAtStep == 2) throw new RuntimeException("💥 step2");
            mailsSent.incrementAndGet();                                                     // ②
            jdbc.update("UPDATE orders SET status='DONE' WHERE id=?", orderId);              // ③
        }

        /** ✅ 寫法二：整段一個交易 + 狀態機 CAS */
        @Transactional(propagation = Propagation.REQUIRES_NEW)
        public void stateMachine(String orderId, int crashAtStep) { /* … */ }

        /** ✅ 寫法三：每一步自己一個交易（因為「寄信」沒辦法回滾） */
        public void stepwise(String orderId, int crashAtStep) {
            String st = currentStatus(orderId);
            if ("CREATED".equals(st)) {
                reserveStock(orderId);                                  // 交易 1：提交了就不會回頭
                if (crashAtStep == 2) throw new RuntimeException("💥 step2");
                st = "STOCK_RESERVED";
            }
            if ("STOCK_RESERVED".equals(st)) {
                sendMailAndMark(orderId);                                // 交易 2
                st = "MAIL_SENT";
            }
            if ("MAIL_SENT".equals(st)) finish(orderId);                 // 交易 3
        }
    }
}
```

**輸出**：

```
═══ 3.6.1 處理到一半掛掉，訊息重送之後會怎樣 ═══
  流程：① 扣 1 件庫存 → ② 寄信 → ③ 標記完成
  情境：第一次在「寄信之前」掛掉（庫存已扣），然後訊息被重送

  【無狀態】第 1 次：💥 step2
    此時 qty=99、信寄了 0 封、status=CREATED
  【無狀態】第 2 次（重送）：完成
    最終 qty=98（應該是 99）、信寄了 1 封（應該是 1）、status=DONE
    結論：❌ 庫存多扣了 1 件

  【狀態機】第 1 次：💥 step2
    此時 qty=100、信寄了 0 封、status=CREATED
  【狀態機】第 2 次（重送）：完成
    最終 qty=99（應該是 99）、信寄了 1 封（應該是 1）、status=DONE
    結論：✅ 正確 —— 但注意：第 1 次連庫存都沒扣（整個交易回滾了）

  【步驟各自一個交易】第 1 次：💥 step2
    此時 qty=99、信寄了 0 封、status=STOCK_RESERVED  ← 庫存真的扣掉了，回不去
  【步驟各自一個交易】第 2 次（重送）：完成
    最終 qty=99（應該是 99）、信寄了 1 封（應該是 1）、status=DONE
    結論：✅ 從斷點接下去：庫存沒有再扣、信只寄一次
```

**三種寫法的性質完全不同，請仔細看中間那兩行差異**：

| | 無狀態 | 整段一個交易 | 步驟各自一個交易 |
|---|---|---|---|
| 第 1 次掛掉後 `qty` | **99**（扣了，回不去） | **100**（整段回滾） | **99**（扣了，回不去） |
| 第 1 次掛掉後 `status` | `CREATED` | `CREATED` | **`STOCK_RESERVED`** ← 記住了進度 |
| 重送之後 | ❌ 從頭跑 → 多扣 1 件 | ✅ 從頭跑（但第一次什麼都沒做） | ✅ **從斷點接下去** |
| 適用條件 | —— | **所有步驟都在同一個資料庫、都能回滾** | 有**不能回滾的步驟**（寄信、呼叫 API） |

### 3.6.2 三種收尾方式，怎麼選

**① 整段一個交易（`@Transactional` 包住全部）**

```java
@Transactional
public void handle(Event e) {
    dedup.saveAndFlush(...);            // 去重
    orders.updateStatus(...);           // 業務 1
    stock.deduct(...);                  // 業務 2
    ledger.insert(...);                 // 業務 3
}
```

| | |
|---|---|
| **適用** | 所有步驟都是**同一個資料庫**的寫入 |
| **好處** | 最簡單、最強的保證（全有或全無）、**連去重表都可以一起回滾** |
| **限制** | ⚠️ 一旦有任何一步是「寄信」、「呼叫別人的 API」、「寫 Redis」，這個方案就破了 |
| **另一個限制** | 交易開太久 → 鎖持有太久 → 影響線上（06-repository 那一類問題） |

📌 **這是首選。** 如果你的消費者只寫自己的資料庫，**不要想太多，包一個交易就結束了。**

**② 步驟各自一個交易 + 狀態機**（實測寫法三）

| | |
|---|---|
| **適用** | 有不能回滾的副作用（寄信、第三方 API、推播） |
| **好處** | 重送時**從斷點接下去**，不重複執行已完成的步驟 |
| **代價** | 每一步都要**自己是冪等的**，而且要有一個地方記進度（狀態欄位） |
| **⚠️ 注意** | 「記進度」與「做那一步」也是一次雙寫！實測寫法三把它們放進同一個交易（`sendMailAndMark`）—— 但**寄信本身在交易外**，所以還是有縫 |

⚠️ **關於那個縫，講清楚一點**：

```java
@Transactional
public void sendMailAndMark(String orderId) {
    if (jdbc.update("UPDATE orders SET status='MAIL_SENT' WHERE id=? AND status='STOCK_RESERVED'", orderId) == 1)
        mailService.send(orderId);       // ← 如果這裡失敗，狀態會回滾（好）
                                         // ← 如果這裡成功但交易提交失敗，信寄了兩次（壞）
}
```

**兩種順序、兩種偏差**：

| 順序 | 失敗時的偏差 |
|---|---|
| 先改狀態、再寄信 | 狀態說寄了、信可能沒寄（**漏信**） |
| 先寄信、再改狀態 | 信寄了、狀態沒記（**重送時會再寄一次**） |

📌 **選哪個取決於「漏」跟「重」哪一個比較能接受**。
寄確認信 → 選「先寄信」（重複寄一封信，使用者覺得煩，但不會出錯）。
扣款 → 選「先改狀態」，然後**用對帳補漏**。
**這是同一個取捨在更小的尺度上再出現一次**（01 章 1.6）。

**③ 補償（Saga）**

已經做了的步驟**主動做反向操作**：扣了庫存 → 加回去；寄了信 → 寄一封「取消」的信。

| | |
|---|---|
| **適用** | 跨服務、跨系統，而且步驟之間相隔很久（幾分鐘到幾天） |
| **好處** | 不需要長交易、不需要分散式鎖 |
| **代價** | **每一個步驟都要寫一個反向操作**，而且反向操作**自己也要冪等** |
| **本站範圍** | ⚠️ 不展開。Saga 是一個架構層級的主題，牽涉到跨服務的一致性設計 —— 不在本課範圍 |

📌 **在單一服務裡，你幾乎不需要 Saga。**
①（整段一個交易）能解決 80% 的情況，②（狀態機）解決剩下的大部分。

---

## 3.7 冪等做不到的兩件事

### 3.7.1 它擋不住「業務上的重複」

```
  使用者按下「送出訂單」按鈕
  網路慢 → 使用者又按了一次
  → 產生兩張不同的訂單（ORD-1、ORD-2）
  → 產生兩則不同的訊息（不同的 message_id）
  → 去重表完全擋不住（兩則訊息都是「第一次」）
```

📌 **訊息去重防的是「傳輸層的重複」，不是「業務上的重複」。**

**業務重複要在更上游擋**：

| 手段 | 說明 |
|---|---|
| 前端按鈕 disable | 擋掉 90%，但擋不住重新整理、擋不住 API 直接打 |
| **API 層的冪等鍵**（`Idempotency-Key` header） | 客戶端產生一個 UUID，同一個鍵的請求只處理一次。**這是正解** |
| 業務唯一約束 | 例如「同一個使用者、同一個商品、5 分鐘內只能下一張訂單」 |

⚠️ **這一層跟訊息去重是**兩層獨立的防守**，缺一層就有一類重複擋不住。**
📌 API 層的冪等設計不在本章範圍（那是 03-rest-api 那一站的主題），
但你要知道**它的存在，以及它跟這一章的分工**：

```
   使用者 ──① API 冪等鍵──▶ 你的服務 ──② Outbox（02章）──▶ broker ──③ 訊息去重（本章）──▶ 業務生效
             擋「重複請求」                  防「訊息漏送」                擋「重複投遞」
```

### 3.7.2 它擋不住「順序錯亂造成的錯誤結果」

```
  事件 A：訂單狀態 → PAID      （offset 5）
  事件 B：訂單狀態 → SHIPPED   （offset 6）

  兩則都只處理一次（冪等完美運作）
  但 B 比 A 先到 → 先變 SHIPPED、再變 PAID
  → 最終狀態是 PAID —— 一張已經出貨的訂單顯示「已付款待出貨」
```

📌 **冪等保證「每則訊息生效一次」，不保證「最終狀態是對的」。**

**解法就是 3.4.3 那個 `event_seq`**：

```sql
UPDATE orders SET status = ?, event_seq = ?
WHERE id = ? AND event_seq < ?        -- 舊事件自己被擋掉
```

⚠️ **注意這個寫法同時解決了冪等與順序**：
同一則訊息重送 → `event_seq` 不小於自己 → 擋掉（冪等）；
舊事件晚到 → `event_seq` 更小 → 擋掉（順序）。
📌 **所以如果你的消費者是「更新狀態」這一類，`event_seq` 通常是最划算的一個設計** ——
一個欄位、一個 `WHERE`，同時買到兩個保證，而且**連去重表都不用**。

---

## 3.8 常見誤區

**① 「重複是罕見的邊界情況」**

3.2.1 實測：100 則訊息被處理 **144 次**，一則最多被處理 **6 次**，帳戶超額 **44%**。
📌 **在 at-least-once 系統裡，重複是設計的一部分，不是故障。**

**② 「我用 `if (已處理過) return;` 就好了」**

3.3.1 實測：四個消費者同時來，**去重表 1 列、業務生效 4 次、餘額 400 元**。
而且**去重表看起來完全正常** —— 你去查它會得出「去重運作正常」的結論。

**③ 「去重表用 `save()` 就好」**

⚠️ `save()` 只把 entity 放進 persistence context，**SQL 要等 flush 才送出去**。
等到 flush（通常是提交時）的時候，業務已經做完了。
📌 **一定要 `saveAndFlush()`**，或者用 `INSERT ... ON DUPLICATE KEY` 的原生 SQL。

**④ 「在交易裡面 catch `DataIntegrityViolationException` 然後 return」**

3.3.3 實測（JPA `saveAndFlush` + MySQL）：**資料是對的（餘額 100 元），
但拿到三個 `UnexpectedRollbackException`。**
交易被標記成 rollback-only 了，你 catch 掉例外也救不回來。
→ 消費者丟例外 → nack requeue → **00 章 0.5.2 的風暴，而且資料完全正常**。

⚠️ **這件事的「會不會壞」取決於兩個變因**（3.4.3 有完整矩陣與實測）：
`JdbcTemplate` + MySQL **不會壞**、JPA **一定壞**、**PostgreSQL 一定壞**（交易被中止）。
📌 **所以不要記「哪一種可以」，記「交易外面 catch」或「用不產生例外的 SQL」——
那兩種寫法跟資料庫、ORM 都無關。**

**⑤ 「去重表放 Redis，快 10 倍又自動過期」**

3.5.2 實測：業務交易回滾了、Redis 的去重鍵留下來 →
**這則訊息永久被跳過、錢永遠不入帳、沒有任何痕跡。**
📌 Redis 只能當**快取層**（3.5.3），真相必須在資料庫。

**⑥ 「`AND qty >= 1` 這個條件可以防重複」**

3.4.1 實測 ②：`qty=100` 的時候跑三次，三次都滿足條件，**三次都扣**。
那個條件防的是「賣超」，不是「重複」。

**⑦ 「天然冪等聽起來很理想，但我的業務做不到」**

3.4.3 兩個方法：**業務唯一約束**（`order_id` 當主鍵）與**狀態機 CAS**。
實測 ③④ 把「扣庫存」這個最典型的不冪等操作改寫成冪等 —— 各只多了一行 SQL。
📌 **先想這兩個，再想去重表。**

**⑧ 「訊息去重表跟業務唯一約束是同一件事」**

3.4.3 的表：去重表的鍵是**訊息 ID**、業務約束的鍵是**業務 ID**。
**使用者按兩次送出產生兩則不同訊息時，去重表完全擋不住，業務約束擋得住。**

**⑨ 「去重表保留 24 小時就夠了」**

3.5.4：如果你有「死信重放」（可能隔幾天）或「Kafka offset 重設」（retention 7 天）流程，
保留期必須 **>= 那個流程的最大延遲**。保留期太短 = 去重靜默失效。

**⑩ 「做完冪等就安全了」**

3.7：冪等擋不住**業務上的重複**（使用者按兩次）與**順序錯亂**。
前者要靠 API 層的冪等鍵，後者要靠 `event_seq`。

---

## 3.9 本章小結

**這一章證明了四件事**：

1. **重複是常態**（3.2）：實測 144 次處理 / 100 則訊息、超額入帳 **44%**、一則最多 6 次。
   五種造成重複的情境裡，**五種都沒有辦法靠寫程式避免**。
2. **憑直覺寫的去重有 bug**（3.3）：
   `check-then-act` → **業務生效 4 次而去重表看起來正常**；
   在交易裡面 catch → **資料正確但無限重投**。
   正解是**「插入去重列 + 業務」同一個交易，衝突在交易外面處理**。
3. **最好的去重是不需要去重**（3.4）：
   絕對值賦值天然冪等；**業務唯一約束與狀態機 CAS 可以把「扣庫存」改寫成冪等**，
   而且比訊息去重更強壯（擋得住使用者按兩次、換掉 MQ 也不用改）。
4. **Redis 不能當去重的真相**（3.5）：快 9.4 倍，但**業務回滾時它會讓訊息永久消失** ——
   而且完全沒有痕跡。它只能當快取層，寫入要放在 `afterCommit`。

📌 **三章合起來，才是一條完整的路徑**：

```
  [你的交易]              [broker]                    [消費者]
       │                      │                           │
  02 章 Outbox           01 章 三段防守              03 章 冪等消費
  「一定會送出」        「每一段都不漏」            「生效只有一次」
       └──────────── at-least-once ─────────────┘        │
                                                          ▼
                                            效果上的 exactly-once
```

### 3.9.1 驗收清單

做得到才往下走：

- [ ] 列出五種造成重複的情境，並說出它們的**共同形狀**（提示：跟 02 章的雙寫是鏡像）。
- [ ] 說出 3.2.1 的三個數字（144 次、6 次、44%），並解釋「一則被處理 6 次」為什麼危險。
- [ ] 說出 `check-then-act` 為什麼會讓業務生效 4 次，**而去重表只有 1 列**。
- [ ] 說出 `save()` 與 `saveAndFlush()` 在去重場景的差別。
- [ ] 解釋「在交易裡面 catch `DataIntegrityViolationException`」會怎樣，
      以及這個 bug 的症狀為什麼是「資料完全正確，但服務在燒」。
- [ ] 寫出 `INSERT ... ON DUPLICATE KEY UPDATE` 版本的去重，並說出它比 try-catch 好在哪。
- [ ] 說出為什麼去重表的主鍵應該是 `(message_id, consumer)` 而不只是 `message_id`。
- [ ] 判斷五個操作的冪等性（`SET status=`、`SET qty=qty-1`、`INSERT log`、`DELETE`、寄信）。
- [ ] 用**兩種方法**把「扣庫存」改寫成冪等，並說出它們的差別。
- [ ] 說出「訊息去重表」與「業務唯一約束」的四個差異，以及為什麼後者更強壯。
- [ ] 說出 Redis 去重的效能收益與**它讓訊息永久消失的機制**。
- [ ] 寫出「Redis 當快取、資料庫當真相」的正確寫法（關鍵：`afterCommit`）。
- [ ] 說出去重表的保留期該怎麼決定（提示：看你最慢的重放流程）。
- [ ] 說出「處理到一半掛掉」的三種收尾方式，以及各自的適用條件。
- [ ] 說出 `event_seq` 那個 `WHERE` 同時買到了哪兩個保證。

### 3.9.2 本章練習

**練習一（15 分鐘）**：把 3.2.1 的「30% 機率掛掉」改成 10%、50%、70% 各跑一次。
**記錄「實際處理次數」與「最終餘額」。**
畫成一張表，然後回答：失敗率跟超額比例是線性關係嗎？
（提示：想一想「被處理 6 次」那一則是怎麼來的。）

**練習二（20 分鐘）**：把 3.3.2 的 `saveAndFlush` 改成 `save`，重跑 3.3.1 的實驗。
**記錄餘額。** 然後打開 `spring.jpa.show-sql=true`，
**找出那個 `INSERT` 是在哪一行送出去的。**

**練習三（20 分鐘）**：實作 3.3.2 的 `INSERT ... ON DUPLICATE KEY UPDATE` 版本，
用 4 個執行緒跑 3.3.1 的實驗。
**驗證：0 個例外、餘額 100 元。**
然後把 `== 1` 改成 `> 0`，再跑一次 —— **解釋為什麼結果變了**
（提示：MySQL 的 `ON DUPLICATE KEY UPDATE` 在「有更新」時回傳 2）。

**練習四（25 分鐘）**：實作 3.4.3 的 `event_seq` 版本：
給 `orders` 加一個 `event_seq BIGINT`，然後送四則事件
`(seq=1, CREATED)`、`(seq=2, PAID)`、`(seq=3, SHIPPED)`、`(seq=2, PAID)` ——
**故意把第 4 則設成重複的舊事件，而且順序打亂**（先送 seq=3）。
**驗證最終狀態是 `SHIPPED`，而且中間沒有回退。**

**練習五（進階，30 分鐘）**：把 3.5.3 那個「Redis 當快取」的寫法實作出來，
然後在跑到一半的時候 `docker restart redis-lab`。
**記錄：Redis 掛掉期間的吞吐、以及有沒有任何一則訊息被錯誤跳過。**
（正確的答案是「吞吐掉到資料庫的水準、0 則被錯誤跳過」。）

**練習六（進階，40 分鐘）**：把 3.6.1 的寫法三加上「寄信」這個真正不能回滾的副作用：
在 `sendMailAndMark` 裡先改狀態、再「寄信」（用一個 `AtomicInteger` 模擬），
然後讓「寄信」有 50% 的機率失敗。
**跑 200 則，記錄：狀態說寄了的有幾筆、實際寄出的有幾封。**
兩個數字會不一樣 —— 那個差額就是你要用對帳去補的量。
**然後把順序反過來（先寄信、再改狀態）再跑一次，記錄差額的方向變了。**

**練習七（綜合，60 分鐘）**：把 02 章的 Outbox 與這一章的去重接起來，
做一個端到端的驗證：

1. Outbox 輪詢器送出 1,000 則訊息，其中 20% 在 `markSent` 之前「掛掉」（→ 會重送）。
2. 消費者用 3.3.2 的去重寫法處理，每則入帳 100 元。
3. **驗證：不管重送了幾次，最終餘額一定是 100,000 元。**
4. 記錄：broker 上實際收到幾則（>1000）、去重表擋掉幾則。

**這一題做完，你就有了本站的第一個「完整可靠鏈路」。**

---

## 3.10 下一章預告

**共通基礎三章結束了。** 你現在知道：

- 訊息會在**三個地方**掉，每一段的防守手段與價格（01 章）。
- 「資料庫改了、訊息沒送」只能用 **Outbox** 解（02 章）。
- 「訊息一定會重複」只能用**冪等消費**解（03 章）。

⚠️ **而這三章刻意迴避了一件事：broker 上面的東西長什麼樣子。**

前三章的實驗都在用最簡單的形式：一個佇列、預設 exchange、`convertAndSend(queueName, body)`。
**那不是真實專案的樣子。** 下一章（04）開始進 RabbitMQ 的本體，
而第一個要打掉的迷思就是：

> **「我一直在用 `convertAndSend("order.q", body)` 送訊息，所以我沒有用 exchange。」**
> ⚠️ **錯。你一直在用一個 exchange，只是它的名字是空字串。**

04 章會回答：

- **exchange / queue / binding 三個東西各自負責什麼**，
  以及為什麼「生產者只認 exchange、消費者只認 queue」是這個設計的全部價值。
- **四種 exchange（direct / topic / fanout / headers）**，
  以及一個實測：同一則訊息送進四種 exchange，分別落在哪幾個佇列。
- **`order.*` 與 `order.#` 差在哪** —— 實測：送 `order.created.vip`，
  一個收得到、一個收不到。
- **訊息轉換器**：`convertAndSend` 送一個 Java 物件進去，
  ⚠️ **預設會用 Java 序列化** —— 實測那串 `\xac\xed\x00\x05`，
  以及「改個套件名之後消費者全部炸掉」。
- **拓撲宣告該寫在哪**：`@Bean` 宣告、`@RabbitListener` 自動宣告、還是完全不讓應用程式碰？
  這是一個會影響你部署流程的決定，而且 01 章 1.4.1 那個 `PRECONDITION_FAILED` 會在這裡回來咬人。
- **多環境命名**：`dev` / `staging` / `prod` 共用一台 broker 的時候怎麼不打到對方。
