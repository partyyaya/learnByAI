# 第 08 章：Kafka 消費者與位移

> [07 章](./07-kafka-basics-and-producer.md) 把生產者那一側講完了，但它從頭到尾都在迴避一件事：
> **那些消費者是怎麼知道「自己該讀哪些分區、讀到哪裡」的。**
>
> Kafka 的消費端只有**一個狀態**：一個叫 offset 的數字。
> **這一章所有的坑，都來自「那個數字什麼時候被寫下來」。**
>
> ---
>
> **一、8.3 實測 rebalance 造成的重複**
> （[00 章 0.5.2](./00-course-map-why-message-queue.md) 與
> [03 章 3.2](./03-idempotent-consumer.md) 的表格都指向這裡）：
>
> ```
>   當掉時「已處理但還沒提交」的則數 : 26
>   broker 上總共有 728 則，全部都有被處理到 : ✅ 是（沒有遺失）
>   處理次數合計 754 次 → 多做了 26 次工
>   被處理超過一次的訊息 : 26 則
> ```
>
> **26 出現了三次，而它們是同一個 26。** 這不是巧合，這就是機制本身。
> ⚠️ 而這個實驗**很容易做錯** —— 8.3.0 會講三種錯的做法，
> **每一種都是一個獨立的教訓**（其中一種量到的根本不是重複，是遺失）。
>
> **二、8.5.3 實測 `max.poll.interval.ms` 的踢人迴圈**
> （[01 章 1.5.4](./01-reliable-delivery-three-hops.md) 的表格指向這裡）：
>
> ```
>   + 0.0s  拿到 job-0 (off0)，開始處理 15 秒
>   +15.0s  job-0 處理完，commitSync() ❌ CommitFailedException
>   +15.1s  拿到 job-0 (off0)，開始處理 15 秒
>   ...（省略）
>   +75.2s  job-0 處理完，commitSync() ❌ CommitFailedException
>
>   job-0 被處理了 5 次
>   已提交的位移 : （沒有任何提交）
> ```
>
> **75 秒、做了 5 次工、進度是 0。`job-1` 與 `job-2` 從來沒有被碰過。**
> 這就是 [11-messaging README](./README.md) 那條誤區「永遠跑不完」的樣子。
>
> **三、而 8.5.2 證明了一個反直覺的事實**：
> 同一個 listener 卡 **30 秒**，`session.timeout.ms` 只有 **6 秒** —— **它不會被踢。**
> 📌 **「處理太久」跟 `session.timeout.ms` 完全無關。**
> 兩個逾時管的是兩件不同的事，而**調錯那一個是這一章最常見的誤區**。
>
> **四、8.6 把 [05 章 5.5.2](./05-rabbitmq-reliability.md) 那個 49% 的事故，換到 Kafka 上重跑一次**：
> 同樣 200 張訂單、同樣把 `concurrency` 開到 8 ——
> **最終狀態錯掉的訂單：0 / 200，吞吐 5.23 倍。**
>
> **五、8.7 是 [00 章 0.4.3](./00-course-map-why-message-queue.md) 欠的那份「線上重放 SOP」。**
> ⚠️ 而 8.7.2 會示範一個**不會報錯但會讓你跳過所有訊息**的失敗：
> `--to-datetime` 給錯時區 → `Falling back to latest known offset`。

---

## 8.1 學習目標

完成本章後，你應該可以：

- 說出 consumer group 怎麼把分區分給消費者，以及「消費者比分區多」會怎樣（8.2）。
- 說出四種 `partition.assignment.strategy` 的差別，並解釋 `RangeAssignor` 在多 topic 下為什麼會偏心（8.2.2）。
- 分辨 `subscribe()` 與 `assign()`，並說出後者放棄了什麼（8.2.3）。
- 說出「換 assignor 要分兩次部署」的理由（8.2.4）。
- 解釋 rebalance 造成重複的完整機制，並說出「重複的上限」由哪個設定決定（8.3）。
- 列出 rebalance 的七種觸發原因，並指出哪一種是你**每週都會遇到**的（8.3.3）。
- 說出 `ConsumerRebalanceListener` 救得了什麼、救不了什麼（8.3.4）。
- 說出 Spring 七種 `AckMode` 各自的提交時機與最糟重複量，並選對一個（8.4.1）。
- 量化「每一則都提交」的代價，並說出 `commitAsync` 的兩個風險（8.4.2）。
- 解釋「位移是一個數字，不是一份清單」造成的兩難，以及 Kafka 的死信為什麼要自己寫（8.4.3）。
- 分辨 `session.timeout.ms` 與 `max.poll.interval.ms` 各自管什麼，並知道「處理太久」該調哪一個（8.5）。
- 認出 `consumer poll timeout has expired` 這行日誌，並說出四種修法（8.5.3）。
- 說出消費者「優雅關閉」與「當掉」在 group 上的時間差，以及它為什麼跟 [07 章 7.5.2](./07-kafka-basics-and-producer.md) 同形（8.5.4）。
- 設定 `concurrency`，並說出它跟 RabbitMQ 的同名參數差在哪（8.6）。
- 執行一次安全的線上重放，並說出五種重設目標各自的陷阱（8.7）。
- 讀懂 `kafka-consumer-groups --describe` 的每一欄，並判斷「這個 group 現在健不健康」（8.8）。
- 說出 consumer group 的已提交位移**自己會過期**，以及它對低頻消費者的後果（8.8.4）。

---

## 8.2 consumer group：分區怎麼分給消費者

### 8.2.1 一個 topic、三個分區，消費者從一個加到四個

```java
    /** 起 n 個消費者，回傳每個消費者拿到的分區 */
    Map<Integer, String> assignOf(List<String> topics, String group, int n, Class<?> assignor) throws Exception {
        // ... n 條執行緒，每條一顆 KafkaConsumer，同一個 group.id
        //     每次 poll 之後記錄 c.assignment()
        sleep(8000);                       // 等分配穩定
        // ...
    }
```

**輸出**：

```
═══ 8.2.1 一個 topic、3 個分區，消費者從 1 個加到 4 個 ═══
  partition.assignment.strategy 預設 = [class org.apache.kafka.clients.consumer.RangeAssignor,
                                        class org.apache.kafka.clients.consumer.CooperativeStickyAssignor]

  ── 1 個消費者 ──
     消費者 0 : [a-0, a-1, a-2]

  ── 2 個消費者 ──
     消費者 0 : [a-2]
     消費者 1 : [a-0, a-1]

  ── 3 個消費者 ──
     消費者 0 : [a-0]
     消費者 1 : [a-1]
     消費者 2 : [a-2]

  ── 4 個消費者 ──
     消費者 0 : [a-2]
     消費者 1 : [a-1]
     消費者 2 : []          ← 什麼都沒有
     消費者 3 : [a-0]
```

📌 **四件事**：

1. **一個分區只會分給 group 裡的一個消費者。** 這是整個模型的基石 ——
   [07 章 7.3.2](./07-kafka-basics-and-producer.md) 那個「200 張訂單全對」就是它換來的。
2. **一個消費者可以拿多個分區。** 1 個消費者時它拿走全部三個。
3. **消費者比分區多的時候，多出來的就是 `[]`。**
   [07 章 7.3.2](./07-kafka-basics-and-producer.md) 已經量過它的後果：8 個消費者 / 6 個分區，吞吐比 6 個消費者還低。
4. **分配是 Kafka 決定的，你不能指定**（除非改用 `assign()`，見 8.2.3）。

⚠️ **注意預設的 `partition.assignment.strategy` 是一個「清單」**：
`[RangeAssignor, CooperativeStickyAssignor]`。
**清單的意思是「我兩種都支援，大家投票選一個共同支援的」** ——
所以 group 裡所有成員都必須支援同一種，才能達成協議。
📌 **這就是為什麼「滾動升級消費者時改 assignor」要分兩次部署**（8.2.4）。

### 8.2.2 四種分配策略，以及 `RangeAssignor` 的偏心 ★★

上面只有一個 topic，看不出四種策略的差別。**換成兩個 topic 各 3 個分區、2 個消費者**：

```java
    for (Class<?> as : new Class<?>[]{RangeAssignor.class, RoundRobinAssignor.class,
            StickyAssignor.class, CooperativeStickyAssignor.class}) {
        // ... 兩個 topic（orders / payments）各 3 個分區，2 個消費者
    }
```

**輸出**：

```
═══ 8.2.2 四種分配策略（兩個 topic 各 3 個分區、2 個消費者） ═══

  ── RangeAssignor ──
     消費者 0 : [orders-0, orders-1, payments-0, payments-1]      ← 4 個
     消費者 1 : [orders-2, payments-2]                            ← 2 個

  ── RoundRobinAssignor ──
     消費者 0 : [orders-1, payments-0, payments-2]                ← 3 個
     消費者 1 : [orders-0, orders-2, payments-1]                  ← 3 個

  ── StickyAssignor ──
     消費者 0 : [orders-1, payments-0, payments-2]
     消費者 1 : [orders-0, orders-2, payments-1]

  ── CooperativeStickyAssignor ──
     消費者 0 : [orders-1, payments-0, payments-2]
     消費者 1 : [orders-0, orders-2, payments-1]
```

⚠️ **`RangeAssignor` 分成 4:2，其他三個都是 3:3。**

📌 **原因：`RangeAssignor` 是「每個 topic 各自分」的。**

```
   orders   有 3 個分區、2 個消費者  →  消費者 0 拿 2 個、消費者 1 拿 1 個
   payments 有 3 個分區、2 個消費者  →  消費者 0 拿 2 個、消費者 1 拿 1 個
                                        ────────────────────────────────
                                        消費者 0 總共 4 個、消費者 1 總共 2 個
```

**「多出來的那一個」永遠給排在前面的消費者** —— 而且**每個 topic 都這樣**，所以偏心會累加。

> ⚠️ **這是一個真實而且很難發現的容量問題**：
> 一個服務訂閱 5 個 topic，每個 topic 都是 3 分區、跑 2 個消費者實例。
> **其中一個實例拿 10 個分區、另一個拿 5 個** —— CPU 曲線一高一低，
> 而你在任何一個 topic 的 `--describe` 上都看不出不對勁（每個 topic 都是 2:1，很合理）。

**而 `RangeAssignor` 是預設清單裡的第一個**（8.2.1 那行輸出）。

📌 **四種策略的完整對照**：

| 策略 | 怎麼分 | rebalance 時 | 什麼時候用 |
|---|---|---|---|
| `RangeAssignor` | **每個 topic 各自**切成連續區段 | eager（全部收回再重分） | ⚠️ 只訂閱一個 topic 時才沒問題。**但它是預設** |
| `RoundRobinAssignor` | 把所有 topic 的分區**攤平**再輪流發 | eager | 多 topic 時比 Range 平均 |
| `StickyAssignor` | 盡量平均，**而且盡量維持原本的分配** | eager | 比 RoundRobin 好，rebalance 後搬動最少 |
| `CooperativeStickyAssignor` | 同 Sticky，但**不需要全部收回** | **cooperative**（漸進式） | ✅ **新專案的建議值**（8.3.2） |

⚠️ **「Sticky」跟「Cooperative」是兩件不同的事，很容易搞混**：

- **Sticky** 講的是**結果**：重新分配之後，盡量讓每個人拿到跟原本一樣的分區。
- **Cooperative** 講的是**過程**：不需要「所有人先把全部分區交出來」再重分。

`StickyAssignor` 是 sticky 但 **eager**；`CooperativeStickyAssignor` 兩者都是。

### 8.2.3 `subscribe()` 與 `assign()`

上面講的全部是 `subscribe()`。**還有另一條路：`assign()`**。

```java
    // 路線一：subscribe —— 加入 group，分區由 Kafka 分配
    consumer.subscribe(List.of("order.created.v1"));

    // 路線二：assign —— 自己指定分區，不加入任何 group
    consumer.assign(List.of(new TopicPartition("order.created.v1", 3)));
```

| | `subscribe()` | `assign()` |
|---|---|---|
| 加入 consumer group | ✅ | ❌ **完全不加入** |
| 分區誰決定 | Kafka（8.2.1、8.2.2） | **你** |
| 有 rebalance 嗎 | ✅ 有（8.3） | ❌ **沒有** |
| 可以提交位移嗎 | ✅ | ✅ 可以（只要有設 `group.id`），但沒有人會因為你掛掉而接手 |
| 掛掉之後誰接手 | group 裡的其他人 | ⚠️ **沒有人** |
| 適合 | ✅ 絕大多數服務 | 一次性的工具、只讀特定分區的除錯程式 |

⚠️ **`assign()` 最大的陷阱是「它看起來很單純，而且真的能動」** ——
直到你的那個行程掛掉為止。**沒有 rebalance 就代表沒有故障轉移。**

📌 **本站 8.7 的重放工具會用到 `assign()`**，因為重放時我們**就是要**精確控制讀哪些分區、從哪裡開始。

### 8.2.4 換 assignor 要分兩次部署

因為 group 的所有成員必須協議出一個**大家都支援**的策略：

```
   ❌ 一次到位（會失敗）
      全部實例從 [RangeAssignor] 直接改成 [CooperativeStickyAssignor]
      → 滾動部署期間，group 裡一半是舊的、一半是新的
      → 找不到交集 → rebalance 失敗

   ✅ 兩次部署
      第一次：[RangeAssignor, CooperativeStickyAssignor]   ← 兩種都支援
              （滾動部署完成之後，全部成員都支援兩種，協議結果仍是 Range）
      第二次：[CooperativeStickyAssignor]                   ← 拿掉舊的
              （這時協議結果切換成 Cooperative）
```

📌 **這跟 [04 章 4.6.3](./04-rabbitmq-basics-and-topology.md) 的「雙綁遷移」是同一個模式**：
**先讓新舊並存，再拿掉舊的。** 兩邊的 MQ 都一樣。

---

## 8.3 rebalance 造成的重複 ★★★

[00 章 0.5.2](./00-course-map-why-message-queue.md) 的表格與
[03 章 3.2](./03-idempotent-consumer.md) 的表格第⑤列，都指向這一節：

> 「Kafka 消費者處理完了、offset 還沒提交就 rebalance → 新的消費者從舊 offset 開始 → 重讀（08 章 8.3 會實測）」

**現在實測。**

### 8.3.0 ⚠️ 先講這個實驗做錯了三次

**三次失敗各自是一個獨立的教訓**，所以先講。

**第一次：量到 0 則重複。**
設計是「生產者每 20 ms 送一則、消費者每則處理 5 ms」——
消費者**永遠是追平的**，每次 poll 只拿到 0～1 則，處理完馬上提交。
**當掉的那一刻根本沒有「已處理但還沒提交」的東西**，自然沒有重複。

> 📌 **教訓：rebalance 造成重複的前提是「有積壓」。**
> 一個永遠追得上的消費者，rebalance 幾乎不會讓它重做事。
> 這跟 [05 章 5.4.3](./05-rabbitmq-reliability.md) 的 prefetch 公平性實驗是同一個陷阱：
> **實驗條件不貼近真實場景，就會量到相反的結論。**

**第二次：讓消費者追不上了（每則處理 30 ms），還是 0 則重複。**
因為「當掉」的判斷寫在 `while` 迴圈的開頭：

```java
    while (alive[me].get()) {            // ← 只在這裡檢查
        var rs = c.poll(...);
        for (var r : rs) { 處理(r); }
        commitSync();                     // ← 所以這一行永遠會執行完
    }
```

**行程只會在「一批處理完而且提交完」之後才停下來** —— 那不是當掉，那是優雅關閉。

**第三次：改成在 for 迴圈裡面檢查，量到 0 則重複，而且開始掉訊息。**

```java
    for (var r : rs) {
        if (!alive[me].get()) break;     // ← break 只跳出 for
        處理(r);
    }
    commitSync();                         // ⚠️ 還是會執行到！
```

⚠️ **`break` 跳出 for 之後，程式繼續往下執行那行 `commitSync()`** ——
結果是**把「還沒處理的那些」也一起提交了**。
**這不是重複，這是遺失** —— 而且它正好是 [01 章 1.5.2](./01-reliable-delivery-three-hops.md)
那個「自動提交把沒處理的也提交了」的手寫版本。

**正確的寫法是 `break outer`**：

```java
    outer:
    while (alive[me].get()) {
        var rs = c.poll(Duration.ofMillis(200));
        for (var r : rs) {
            if (!alive[me].get()) break outer;    // ← 跳出整個迴圈，不執行 commitSync
            sleep(WORK_MS);
            seen.computeIfAbsent(r.value(), k -> new AtomicInteger()).incrementAndGet();
            if ("record".equals(commitEvery)) c.commitSync();
        }
        if ("batch".equals(commitEvery) && !rs.isEmpty()) c.commitSync();
    }
```

> 📌 **這三次失敗留下一句話，值得寫在牆上**：
>
> **「消費者當掉」在程式裡不是一個布林值，是一個「發生在哪一行」的問題。**
> 而 Kafka 的重複與遺失，差別就在那一行是在 `commitSync()` 之前還是之後。

### 8.3.1 26 則未提交 → 26 則重複

**最終的實驗條件**（每一個都是為了貼近真實場景）：

| 條件 | 值 | 為什麼 |
|---|---|---|
| 分區 | 6 | 兩個消費者各 3 個 |
| 生產速率 | 每 8 ms 一則（125 則/秒） | **持續進來**，不是預先灌好 |
| 處理速度 | 每則 25 ms（兩個合計 80 則/秒） | ⚠️ **刻意比生產慢** → 一直有積壓 |
| `max.poll.records` | 50 | 一批 50 則，處理完要 1.25 秒 |
| 當掉時機 | **等到消費者 0 處理到一批的第 25 則以上才動手** | 否則每次量到的數字都是運氣 |
| 當掉方式 | `break outer` + `close(Duration.ZERO)`，**不提交** | 模擬 `kill -9` |

```java
        // ⚠️ 等到消費者 0 真的「處理到一批的中途」才動手，否則每次量到的重複數量都是運氣
        long dl = System.currentTimeMillis() + 90000;
        while (System.currentTimeMillis() < dl) {
            if (inBatchOf.get() >= MAX_POLL / 2 && doneInBatch.get() >= MAX_POLL / 2) break;
            sleep(50);
        }
        alive[0].set(false);                    // ← 消費者 0 在一批的中途當掉
```

**輸出**：

```
═══ 8.3.1 兩個消費者、訊息持續進來，其中一個在「處理到一半」時當掉 ═══
  6 個分區、每 8 ms 送一則（125 則/秒）、每則處理 25 ms（兩個消費者合計 80 則/秒）
  → 消費者追不上，一直有積壓。max.poll.records = 50

  ── 提交時機：整批 poll 處理完才提交（Spring 的 BATCH，預設） ──
     當掉時「已處理但還沒提交」的則數 : 26
     broker 上總共有 728 則，全部都有被處理到 : ✅ 是（沒有遺失）
     處理次數合計 754 次 → 多做了 26 次工
     被處理超過一次的訊息 : 26 則

  ── 提交時機：每一則處理完就提交（Spring 的 RECORD） ──
     當掉時「已處理但還沒提交」的則數 : 0
     broker 上總共有 560 則，全部都有被處理到 : ✅ 是（沒有遺失）
     被處理超過一次的訊息 : 0 則
```

📌 **`26` 出現了三次，而且它們是同一個 26**：

```
   當掉時已處理但還沒提交的則數     26
   多做的工                        26 次
   被處理超過一次的訊息            26 則
```

**這不是巧合，這就是機制本身**：

```
   消費者 0 拿到一批 50 則（p0/p1/p2 的 offset 100~149）
      ├─ 處理第 1 則 … 第 26 則     ← 業務副作用已經發生了 26 次
      ╳  行程被 kill，commitSync() 沒跑到
      │
      │  broker 上的已提交位移還停在 100
      ▼
   session.timeout.ms 到期 → rebalance → 消費者 1 接手 p0/p1/p2
      └─ 它從「已提交位移 100」開始讀
         → offset 100~125 那 26 則被**第二次**處理
```

⚠️ **而且「沒有遺失」那一行同樣重要**：`broker 上 728 則，全部都有被處理到 ✅`。

📌 **這就是 [01 章 1.6.1](./01-reliable-delivery-three-hops.md) 的 at-least-once**：
**不漏，但會重複。** Kafka 選的就是這一邊。

**跑了四次，未提交則數分別是 27、26、26、27 —— 重複數每一次都完全等於它。**

### 8.3.2 `RECORD` 把重複壓到 0，但它不是免費的

上面 `RECORD` 那一組是 `0 則重複`。**那為什麼 Spring 的預設不是 `RECORD`？**

因為提交本身要錢 —— 8.4.2 會量。**先記住取捨的形狀**：

```
   每一則都提交（RECORD）      重複 ≈ 0        提交次數 = 訊息數
   一批才提交（BATCH，預設）    重複 ≤ 一批     提交次數 = 批數
```

📌 **「重複的上限 = 一批的大小」，所以 `max.poll.records` 也是一個可靠性旋鈕。**
把它從 500（預設）調成 50，最糟情況的重複量就少了 10 倍 ——
代價是 poll 次數變多。

⚠️ **但不管調到多少，重複都不會是 0**（`RECORD` 也一樣：
提交送出去、broker 收到了、回應在網路上丟了 → 下次還是從舊位移開始）。
📌 **所以 [03 章的冪等消費](./03-idempotent-consumer.md) 不是「保險」，是必要條件。**

### 8.3.3 rebalance 什麼時候會發生

上面那個實驗只觸發了其中一種。**完整清單**：

| 觸發原因 | 什麼時候 | 你控制得了嗎 |
|---|---|---|
| **消費者加入** | 擴容、**滾動部署時新實例起來** | ⚠️ 每次部署都會發生 |
| **消費者離開（優雅）** | `consumer.close()` → 送 `LeaveGroup` | ✅ 可控，而且很快（8.5.4） |
| **消費者離開（當掉）** | 等 `session.timeout.ms` 到期 | ❌ 只能等（8.5.4） |
| **消費者「假死」** | 超過 `max.poll.interval.ms` 沒有再 poll | ⚠️ **這是最惡毒的一種**（8.5.3） |
| **分區數變多** | `--alter --partitions`（[07 章 7.7](./07-kafka-basics-and-producer.md)） | ✅ 可控 |
| **訂閱的 topic 集合改變** | 用 pattern 訂閱、而新 topic 出現時 | ⚠️ 配合 auto-create 會很意外（[07 章 7.8](./07-kafka-basics-and-producer.md)） |
| **group coordinator 換人** | broker 重啟 / 故障 | ❌（8.8.3） |

⚠️ **「滾動部署」那一列要特別注意**：一次部署 3 個實例，就是 **3 次以上**的 rebalance
（每個實例停 1 次、起 1 次）。**而每一次都可能製造 8.3.1 那種重複。**

📌 **這正是「Kafka 消費者一定要冪等」最實際的理由** ——
不是因為 broker 不可靠，是因為**你每個禮拜都會部署**。

### 8.3.4 `ConsumerRebalanceListener`：rebalance 的兩個掛鉤

想在 rebalance 前後做事（例如「被收回之前先把位移提交掉」），用這個：

```java
    consumer.subscribe(List.of(topic), new ConsumerRebalanceListener() {
        @Override
        public void onPartitionsRevoked(Collection<TopicPartition> partitions) {
            // ⚠️ 這是你「最後的機會」—— 分區即將被收回
            //    把已經處理完、但還沒提交的位移提交掉，就能把 8.3.1 那 26 則壓成 0
            consumer.commitSync(currentOffsets);
        }

        @Override
        public void onPartitionsAssigned(Collection<TopicPartition> partitions) {
            // 拿到（可能是新的）分區。要從特定位置開始讀的話在這裡 seek()
        }
    });
```

⚠️ **但它救不了 8.3.1 那個實驗，而理由很重要**：

```
   優雅關閉（SIGTERM → consumer.close()）  → onPartitionsRevoked 會被呼叫 ✅
   當掉（SIGKILL / 主機斷電）              → ❌ 行程已經不存在了，沒有任何 callback 會跑
```

📌 **所以 `onPartitionsRevoked` 的價值是「讓正常的部署不要製造重複」**，
而不是「讓當掉不製造重複」。**後者做不到，只能靠冪等。**

⚠️ **另外注意這個介面有第三個方法**：`onPartitionsLost()`。
它在「分區被收回而且來不及善後」時呼叫（例如超過 `max.poll.interval.ms` 被踢）。
**而它是唯一一個有預設實作的** —— 實測：

```
═══ 稽核 E：Spring 與客戶端的介面語意 ═══
  ConsumerRebalanceListener 的方法：
    onPartitionsLost           default=true abstract=false
    onPartitionsRevoked        default=false abstract=true
    onPartitionsAssigned       default=false abstract=true

  只覆寫 Revoked/Assigned，然後呼叫 onPartitionsLost(2 個分區) → 實際被呼叫的是：
    [onPartitionsRevoked(2)]
```

⚠️ **`onPartitionsLost` 的預設實作會直接轉呼叫 `onPartitionsRevoked`。**

📌 **所以如果你在 `onPartitionsRevoked` 裡提交位移**（上面那段程式碼就是），
**那個提交在「被踢掉」的情況下一定會失敗** —— 你已經不是那些分區的擁有者了，
會丟 `CommitFailedException`（8.5.3 看過它）。

📌 **正確做法是自己覆寫 `onPartitionsLost`**，讓它**什麼都不提交、只記一筆告警**：

```java
        @Override
        public void onPartitionsLost(Collection<TopicPartition> partitions) {
            // ⚠️ 刻意不呼叫 super（預設會轉去 onPartitionsRevoked 並嘗試提交，那一定會失敗）
            log.warn("分區被強制收回（很可能是超過 max.poll.interval.ms）: {}", partitions);
        }
```

---

## 8.4 位移什麼時候被寫下來

[01 章 1.5.2](./01-reliable-delivery-three-hops.md) 已經證明了**寫錯的後果**：
自動提交讓 300 則裡的 250 則永遠沒有人處理，**而 `lag = 0`**。
這一節把**正確的做法**落地，並量出它的價錢。

### 8.4.1 Spring 的七種 `AckMode`

```java
    System.out.println("  預設 : " + new ContainerProperties("t").getAckMode());
    System.out.println("  全部 : " + Arrays.toString(ContainerProperties.AckMode.values()));
```

```
═══ 8.4.1 Spring 的 ContainerProperties.AckMode ═══
  預設 : BATCH
  全部 : [RECORD, BATCH, TIME, COUNT, COUNT_TIME, MANUAL, MANUAL_IMMEDIATE]
```

| `AckMode` | 什麼時候提交 | 最糟情況的重複量 | 風險 |
|---|---|---|---|
| `RECORD` | 每一則 listener 正常回傳後 | **1 則** | 慢（8.4.2 量了） |
| **`BATCH`（預設）** | 一整批 `poll()` 都處理完之後 | **一批**（≤ `max.poll.records`） | ✅ 合理的預設 |
| `TIME` | 每隔 `ackTime` 毫秒 | 那段時間內處理的量 | ⚠️ 跟自動提交同一類問題 |
| `COUNT` | 每 `ackCount` 則 | `ackCount` 則 | ⚠️ 同上 |
| `COUNT_TIME` | 兩者任一先到 | 同上 | ⚠️ 同上 |
| `MANUAL` | 你呼叫 `ack.acknowledge()`，**但排進佇列、等這批結束才送** | 看你怎麼寫 | 需要注入 `Acknowledgment` |
| `MANUAL_IMMEDIATE` | 你呼叫 `ack.acknowledge()`，**立刻送出** | 看你怎麼寫 | 同上 |

⚠️ **`MANUAL` 與 `MANUAL_IMMEDIATE` 的差別常被忽略**：
`MANUAL` 呼叫 `acknowledge()` **不會立刻提交**，它只是把這個位移排進佇列，
等**這一批處理完**才真的送出去。
📌 **要「處理完這一則就馬上落到 broker」，必須用 `MANUAL_IMMEDIATE`。**

⚠️ **`TIME` / `COUNT` / `COUNT_TIME` 這三個看起來像是「折衷」，實際上它們把
[01 章 1.5.2](./01-reliable-delivery-three-hops.md) 那個故障搬回來了** ——
提交時機跟「處理到哪」脫鉤，所以**可能提交到還沒處理完的位置**。
📌 **除非你非常清楚自己在做什麼，否則不要用。**

### 8.4.2 提交要多少錢 ★★

**條件**：50,000 則、3 個分區、**消費者不做任何業務處理**（所以量到的全部是提交本身的成本）。

```java
        for (var r : rs) {
            got++;
            if (m[0].equals("record")) c.commitSync();        // 每一則
        }
        if (m[0].equals("batch")) c.commitSync();             // 每一批
        if (m[0].equals("batchAsync")) c.commitAsync();       // 每一批，非同步
```

**輸出**：

```
═══ 8.4.2 提交位移的吞吐代價（50,000 則、消費者不做任何業務處理） ═══
  提交方式                                    耗時 ms          則/秒      相對不提交
  完全不提交（不可用，只當基準）                          38    1,315,789      1.00x
  每一批 poll 提交一次（Spring BATCH）              83      602,409      2.18x
  每一批 poll 用 commitAsync                   29    1,724,137      0.76x
  每一則提交一次（Spring RECORD）               10,409        4,803    273.92x
```

⚠️ **`RECORD` 慢了 274 倍。**

📌 **跑了兩次，先把「哪些數字可以信」講清楚**：

| | 第一次 | 第二次 | 可以下的結論 |
|---|---|---|---|
| 不提交 | 36 ms | 38 ms | 基準 |
| `BATCH` | 62 ms（1.72x） | 83 ms（2.18x） | **大約 1.7～2.2 倍** |
| `commitAsync` | 35 ms（0.97x） | 29 ms（0.76x） | ⚠️ **量不出成本**（比基準還快是雜訊） |
| `RECORD` | 10,208 ms（283.56x） | 10,409 ms（273.92x） | ✅ **兩位數以上的穩定差距** |

⚠️ **前三列都在 30～80 ms 的範圍，那是雜訊區**（[07 章 7.5.1](./07-kafka-basics-and-producer.md) 踩過同一個坑）。
**唯一穩的是最後一列 —— 而它剛好就是重點。**

📌 **原因：`commitSync()` 是一次同步的網路來回。**
每一則提交一次 = 每一則多一次 round trip。
50,000 次 round trip ≈ 10.2 秒，換算下來**一次提交約 0.2 ms** ——
這個數字本身很小，但**乘以訊息數就是災難**。

**這就是 8.3.2 那個問題的答案：Spring 的預設為什麼不是 `RECORD`。**

| | 重複的上限 | 吞吐 | 用在哪 |
|---|---|---|---|
| `RECORD` | 1 則 | **約 4,800～4,900 則/秒** | 每一則的副作用都很貴、而且不可逆（扣款、發實體券） |
| `BATCH`（預設） | 一批 | **60 萬～80 萬則/秒** | ✅ 絕大多數情況 |

⚠️ **`commitAsync` 那一列（0.97x / 0.76x）不要誤讀。**
它「免費」是因為**它不等回應** —— 送出去就繼續。
這代表：

- **提交失敗你不會當場知道**（要自己在 callback 裡處理）。
- ⚠️ **提交可能亂序**：先送的 offset 100 比後送的 offset 200 晚到 broker → 位移倒退。
  （客戶端有做保護，但**混用 `commitAsync` 與 `commitSync` 時要特別小心順序**。）

📌 **實務上的標準寫法是「平常 async、關閉時 sync」**：

```java
    try {
        while (running) {
            var records = consumer.poll(Duration.ofMillis(200));
            process(records);
            consumer.commitAsync();              // 平常：不等，換吞吐
        }
    } finally {
        try {
            consumer.commitSync();               // 關閉時：一定要等它成功
        } finally {
            consumer.close();
        }
    }
```

⚠️ **用 `@KafkaListener` 的話，這件事 Spring 已經幫你做了** ——
`ack-mode: BATCH` 的容器在關閉時會做一次同步提交。
**上面那段是「自己寫 `KafkaConsumer`」時的範本**（例如 8.7 的重放工具）。

### 8.4.3 「不能跳著提交」到底是什麼意思 ★★

[01 章 1.5.3](./01-reliable-delivery-three-hops.md) 那張表說「Kafka 不能跳著確認」。
**這一節把它變成一個具體的兩難。**

場景：一批 10 則（`msg-0` ~ `msg-9`），其中 **`msg-3` 處理不了**（毒藥訊息）。

```java
        // 選擇一：停在毒藥訊息前面
        c.commitSync(Map.of(new TopicPartition(t, 0), new OffsetAndMetadata(3)));

        // 選擇二：跳過毒藥訊息
        c.commitSync(Map.of(new TopicPartition(t, 0), new OffsetAndMetadata(10)));
```

**輸出**：

```
═══ 8.4.3 一批 10 則，第 3 則是毒藥訊息 —— 你只有兩個選擇 ═══
  情境：msg-0 ~ msg-9，其中 msg-3 處理不了

  ── 選擇一：停在毒藥訊息前面（提交 offset 3）──
     一次拿到 10 則
     commitSync(offset=3)  ← 宣稱 msg-0/1/2 做完了
     已提交位移 : 3
     ⚠️ msg-4 ~ msg-9 你「已經處理過了」，但位移說你沒有 → 重啟就會全部重做

  ── 選擇二：跳過毒藥訊息（提交 offset 10）──
     commitSync(offset=10) ← 宣稱 msg-0 ~ msg-9 全部做完了
     已提交位移 : 10
     ⚠️ msg-3 從此不存在於任何人的待辦清單上 —— 沒有死信、沒有紀錄

  ── 有沒有「只留 msg-3、其他都確認」這個選項 ──
     沒有。位移是一個數字，不是一份清單。
     RabbitMQ 可以（每一則有自己的 delivery_tag，見 01 章 1.5.3）。
```

📌 **「位移是一個數字，不是一份清單」是 Kafka 消費端所有限制的根源。**

`offset = 10` 的意思是「0 到 9 我全部處理完了」。
**你沒有辦法表達「我做完了 0,1,2,4,5,6,7,8,9，但 3 還沒」** —— 那需要一份清單，而 Kafka 只給你一個整數。

**對照 RabbitMQ**：

| | RabbitMQ | Kafka |
|---|---|---|
| 確認的單位 | 一則（`delivery_tag`） | 一個位置（offset） |
| 「只留第 3 則」 | ✅ `basicAck(3, false)` 之外的都 ack | ❌ **做不到** |
| 毒藥訊息的處理 | `basicNack` → DLX（[06 章 6.2](./06-rabbitmq-retry-delay-and-cluster.md)） | ⚠️ **沒有內建機制** |

⚠️ **所以「Kafka 的死信」不是一個 broker 功能，是一個你要自己寫的模式**：

```
   拿到 msg-3 → 處理失敗 → 你自己把它送到 order.created.v1.DLT
                          → 然後提交 offset 4，繼續往前
```

📌 **這就是 [01 章 1.5.4](./01-reliable-delivery-three-hops.md) 那張表說的「重試主題 + 死信主題」**，
**10 章會把它完整做出來**（Spring 的 `DeadLetterPublishingRecoverer` + `DefaultErrorHandler`）。

### 8.4.4 本章建議的提交設定

```yaml
spring:
  kafka:
    consumer:
      enable-auto-commit: false      # ⚠️ 明確寫出來，理由見 01 章 1.5.2
      auto-offset-reset: earliest    # ⚠️ 明確寫出來，理由見 8.7.4
      max-poll-records: 50           # 預設 500。這同時是「最糟重複量」的上限（8.3.2）
      properties:
        max.poll.interval.ms: 300000 # 要 >= 一批的處理時間（8.5.3）
        session.timeout.ms: 45000
        heartbeat.interval.ms: 3000
        partition.assignment.strategy: >-
          org.apache.kafka.clients.consumer.CooperativeStickyAssignor
    listener:
      ack-mode: BATCH                # 預設值，明確寫出來
      missing-topics-fatal: true     # 訂閱的 topic 不存在就啟動失敗（配合 07 章 7.8）
```

⚠️ **`enable-auto-commit: false` 一定要寫出來，即使它「本來就是」**。
[01 章 1.5.2](./01-reliable-delivery-three-hops.md) 實測過：
`@KafkaListener` 的容器會幫你覆寫成 `false`，
但**你自己 `consumerFactory.createConsumer()` 時沒有人會覆寫** —— 那條路徑的預設是 `true`。
**明確寫出來能讓兩條路徑一致。**

---

## 8.5 兩個逾時：`session.timeout.ms` 與 `max.poll.interval.ms` ★★★

[01 章 1.5.4](./01-reliable-delivery-three-hops.md) 那張表留了兩筆帳：
「等 `session.timeout.ms` 觸發 rebalance（08 章）」與
「監控 `max.poll.interval.ms` 踢人事件（08 章）」。**一起還。**

📌 **這兩個逾時最常被搞混，所以先把它們的分工講清楚**：

```
   session.timeout.ms       ── 管「這個行程還活著嗎」
                               由背景的心跳執行緒負責，跟你的業務程式碼無關

   max.poll.interval.ms     ── 管「這個行程還在做事嗎」
                               由你多久呼叫一次 poll() 決定，⚠️ 完全取決於你的業務程式碼
```

### 8.5.1 四個相關的預設值

```
═══ 8.5.1 消費者端四個相關的預設值 ═══
  session.timeout.ms                     = 45000
  heartbeat.interval.ms                  = 3000
  max.poll.interval.ms                   = 300000
  max.poll.records                       = 500
  auto.offset.reset                      = latest
  fetch.min.bytes                        = 1
  fetch.max.wait.ms                      = 500
  max.partition.fetch.bytes              = 1048576
```

⚠️ **`auto.offset.reset = latest` 這個預設值要特別記住** —— 8.7.4 會講它為什麼危險。

📌 **`session.timeout.ms` 與 `heartbeat.interval.ms` 的關係**：
心跳每 3 秒一次，45 秒沒收到才判定死亡 → **要連續漏掉 15 次心跳。**
（官方建議 `heartbeat.interval.ms` 不要超過 `session.timeout.ms` 的 1/3。）

### 8.5.2 listener 卡 30 秒，`session.timeout.ms` 只有 6 秒 —— 不會被踢

```java
    try (KafkaConsumer<String, String> c = new KafkaConsumer<>(cfg(g, 6000, 300000, 1))) {
        c.subscribe(List.of(t));
        var rs = c.poll(Duration.ofSeconds(10));
        // ── 現在「處理」30 秒（session.timeout 的 5 倍）──
        sleep(30000);
        c.commitSync();          // 還提交得了嗎？
    }
```

**輸出**：

```
═══ 8.5.2 listener 卡 30 秒，session.timeout.ms=6000 —— 會被踢嗎 ═══
  拿到 1 則，分區 [ch08.timeout.session-0]
  ── 現在「處理」30 秒（session.timeout 的 5 倍）──
  睡了 30,002 ms，醒來
  commitSync() → ✅ 成功。**沒有被踢**
  還持有的分區 : [ch08.timeout.session-0]
```

📌 **沒有被踢。** 因為 **Kafka 0.10.1 之後，心跳跑在一條獨立的背景執行緒上**。

```
   你的執行緒          ├─ poll() ─┤   （處理 30 秒，完全卡住）
   心跳執行緒          ♥  ♥  ♥  ♥  ♥  ♥  ♥  ♥  ♥  ♥   （每 3 秒一次，照常送）
                                                     broker：「它還活著」✅
```

⚠️ **所以「我的消費者處理很久，是不是要把 `session.timeout.ms` 調大」這個直覺是錯的。**
處理很久**不會**觸發 session timeout。**該調的是 `max.poll.interval.ms`。**

### 8.5.3 同一件事，換成 `max.poll.interval.ms` —— 永遠跑不完的迴圈 ★★★

**條件**：topic 裡有 3 則（`job-0` / `job-1` / `job-2`），
`max.poll.records=1`、**每則處理 15 秒**，而 **`max.poll.interval.ms = 8000`**。

```java
        while (System.currentTimeMillis() - t0 < 75000) {
            var rs = c.poll(Duration.ofMillis(500));
            for (var r : rs) {
                // 拿到、開始處理 15 秒
                sleep(15000);
                try { c.commitSync(); /* ✅ */ }
                catch (Exception e) { /* ❌ 記下例外型別 */ }
            }
        }
```

**輸出**：

```
═══ 8.5.3 每則處理 15 秒，而 max.poll.interval.ms = 8000 ═══
  topic 裡有 3 則（job-0 / job-1 / job-2），跑 75 秒看它處理了什麼
    + 0.0s  拿到 job-0 (off0)，開始處理 15 秒
    +15.0s  job-0 處理完，commitSync() ❌ CommitFailedException
    +15.1s  拿到 job-0 (off0)，開始處理 15 秒
    +30.1s  job-0 處理完，commitSync() ❌ CommitFailedException
    +30.1s  拿到 job-0 (off0)，開始處理 15 秒
    +45.1s  job-0 處理完，commitSync() ❌ CommitFailedException
    +45.1s  拿到 job-0 (off0)，開始處理 15 秒
    +60.1s  job-0 處理完，commitSync() ❌ CommitFailedException
    +60.2s  拿到 job-0 (off0)，開始處理 15 秒
    +75.2s  job-0 處理完，commitSync() ❌ CommitFailedException
  ── 75 秒之後的統計 ──
     job-0 被處理了 5 次
     已提交的位移 : （沒有任何提交）
```

⚠️ **75 秒、做了 5 次工、進度是 0。`job-1` 與 `job-2` 從來沒有被碰過。**

📌 **這是一個真正的無窮迴圈，而且它不會自己停**：

```
   poll() 拿到 job-0
      ├─ 處理 15 秒
      │     ⏰ 第 8 秒：超過 max.poll.interval.ms
      │        → broker 認定「這個成員沒在做事」→ 把它踢出 group → rebalance
      │        → 但你的執行緒還在睡，完全不知道
      ├─ 15 秒後醒來，commitSync()
      │     ❌ CommitFailedException：你已經不是這個分區的擁有者了
      ├─ 下一次 poll()：重新入團、重新拿到分區
      └─ 從「上次成功提交的位移」開始 → 又是 job-0
   ↺ 永遠循環
```

**Kafka 自己的日誌會明確講出來**（本站 `logging.level.root=WARN` 也看得到）：

```
WARN o.a.k.c.c.internals.ConsumerCoordinator : [Consumer clientId=consumer-ch08.timeout.poll.g-3,
groupId=ch08.timeout.poll.g] consumer poll timeout has expired. This means the time between
subsequent calls to poll() was longer than the configured max.poll.interval.ms, which typically
implies that the poll loop is spending too much time processing messages. You can address this
either by increasing max.poll.interval.ms or by reducing the maximum size of batches returned
in poll() with max.poll.records.
```

📌 **`consumer poll timeout has expired` 這一行，就是
[01 章 1.5.4](./01-reliable-delivery-three-hops.md) 說的「要監控的踢人事件」。**
⚠️ **它是 `WARN` 等級，所以在多數專案的日誌設定裡看得到，但沒有人在看。**

**[11-messaging README](./README.md) 的誤區清單裡那一條，現在有數字了**：

> 「消費邏輯跑 6 分鐘，`max.poll.interval.ms` 是 5 分鐘 —— 消費者被踢出 group、訊息重來、
> 再跑 6 分鐘，永遠跑不完。」

**怎麼修 —— 錯誤訊息自己給了兩條路，但實際上有四條**：

| 做法 | 怎麼做 | 什麼時候用 |
|---|---|---|
| ① **調大 `max.poll.interval.ms`** | 設成「一批的最長處理時間」× 2 | 處理時間可預測、而且有上限 |
| ② **調小 `max.poll.records`** | 一批少一點，整批就處理得完 | ✅ 通常比 ① 好，而且順便縮小重複半徑（8.3.2） |
| ③ **把慢工作丟出去** | listener 只做「收下 + 寫任務表」，真正的工作交給別的執行緒池 | 處理時間**不可預測**（呼叫外部 API） |
| ④ **`pause()` / `resume()`** | 處理期間暫停該分區，但**繼續 poll**（poll 會回傳空的） | 要精準控制、而且不想改批次大小 |

⚠️ **①要算清楚**：`max.poll.interval.ms` 要 >= `max.poll.records` × 每則最長處理時間。
預設值 `500 × 處理時間` —— **每則只要超過 600 ms，預設的 300 秒就不夠了。**

📌 **③ 是最常見的正解**，因為「呼叫外部 API」的耗時你控制不了。
但 ⚠️ **它把問題搬到另一個地方**：listener 一回傳就提交位移，
所以**任務還在你的執行緒池裡排隊時，Kafka 已經認為它做完了** ——
行程掛掉那些任務就消失了。
👉 **這正是 [02 章 Outbox](./02-outbox-and-transactional-consistency.md) 的鏡像問題**，
解法也一樣：**任務要先落到資料庫，再交給執行緒池。**

### 8.5.4 消費者行程消失之後，group 多久才發現

用一個**真的外部 Java 行程**（`StandaloneKafkaConsumer`），這樣才能真的 `kill -9`：

```java
        ProcessBuilder pb = new ProcessBuilder("java", "-cp", System.getProperty("java.class.path"),
                "com.example.lab11.ch08.tools.StandaloneKafkaConsumer", t, g, "10000", "3000");
        // ... 等它印出 READY，記下 pid
        long t0 = System.currentTimeMillis();
        new ProcessBuilder("kill", "-" + how, String.valueOf(pid)).start().waitFor(10, TimeUnit.SECONDS);
        int m;
        do { sleep(200); m = members(g); } while (m > 0 && System.currentTimeMillis() - t0 < 60000);
```

⚠️ **`session.timeout.ms` 在這個實驗裡刻意設成 10000（預設是 45000）**，
不然每一輪都要等 45 秒。**下面的數字要照這個值來讀。**

**輸出**：

```
═══ 8.5.4 消費者行程消失之後，group 要多久才把它移出去 ═══

  ── 外部消費者已入團（session.timeout.ms=10000）──
     READY pid=36546 assignment=[ch08.timeout.kill-0, ch08.timeout.kill-1]
     動手前 group 成員數 = 1
     kill -TERM 36546
     成員數變成 0，花了 242 ms   （優雅關閉：consumer.close() 送了 LeaveGroup）

  ── 外部消費者已入團（session.timeout.ms=10000）──
     READY pid=36681 assignment=[ch08.timeout.kill-0, ch08.timeout.kill-1]
     動手前 group 成員數 = 1
     kill -KILL 36681
     成員數變成 0，花了 8,134 ms   （當掉：只能等 session.timeout.ms）
```

⚠️ **242 ms vs 8,134 ms —— 差 34 倍。**

📌 **跟 [07 章 7.5.2](./07-kafka-basics-and-producer.md) 的 broker 版本是完全一樣的形狀**：

| | broker 掛掉（7.5.2） | 消費者掛掉（8.5.4） |
|---|---|---|
| 優雅關閉（SIGTERM） | **1,517 ms**（controlled shutdown） | **242 ms**（`LeaveGroup`） |
| 當掉（SIGKILL） | **8,924 ms**（`broker.session.timeout.ms=9000`） | **8,134 ms**（`session.timeout.ms=10000`） |
| 差別在哪 | 「有沒有機會道別」 | 「有沒有機會道別」 |

⚠️ **實務上的三個後果**：

1. **用預設的 `session.timeout.ms=45000`，一個當掉的消費者會讓它的分區停擺 45 秒。**
   那段時間 lag 一路往上，而 `--describe` 上那個成員**看起來還活著**。
2. **優雅關閉值得認真做。** Spring Boot 的 `server.shutdown: graceful` +
   容器的 `stop()` 會走到 `consumer.close()` → 242 ms 就交棒完成。
   ⚠️ **但 Kubernetes 的 `terminationGracePeriodSeconds` 太短會讓它來不及** ——
   那就退化成 8 秒那一列。
3. ⚠️ **不要為了「切得快」把 `session.timeout.ms` 調到很小。**
   跟 [07 章 7.5.2](./07-kafka-basics-and-producer.md) 一樣的理由：
   網路抖一下就誤判 → 不必要的 rebalance → 8.3.1 那 26 則重複。

📌 **如果 shutdown hook 只呼叫 `c.wakeup()`，兩種訊號量到的是 7,971 ms 與 8,064 ms —— 幾乎一樣。**
原因在 `StandaloneKafkaConsumer` 的 shutdown hook：

```java
        // ⚠️ hook 只呼叫 wakeup() 是不夠的 —— hook 一回來 JVM 就結束了，
        //    close() 常常來不及把 LeaveGroup 送出去，量到的結果會跟 SIGKILL 一樣
        CountDownLatch closed = new CountDownLatch(1);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            c.wakeup();
            try { closed.await(10, TimeUnit.SECONDS); } catch (InterruptedException ignored) { }
        }));
```

⚠️ **這不只是實驗的瑕疵，它就是後果 2 的具體樣貌** ——
**「有寫優雅關閉」跟「優雅關閉真的跑完了」是兩件事。**

---

## 8.6 `@KafkaListener` 的併發模型

### 8.6.1 `concurrency` 是「幾個消費者」，不是「幾條工作執行緒」

⚠️ **這是 Kafka 與 RabbitMQ 最容易搞混的一個對應關係。**

| | RabbitMQ 的 `concurrency`（[05 章 5.5](./05-rabbitmq-reliability.md)） | Kafka 的 `concurrency` |
|---|---|---|
| 它建出幾個什麼 | N 個消費者，**全部吃同一個佇列** | N 個 `KafkaConsumer`，**各自分到不同的分區** |
| 順序會怎樣 | ⚠️ **壞掉**（5.5.2 實測 49% 訂單最終狀態錯） | ✅ **同一個 key 還是有序** |
| 上限 | 沒有（加多少都有效） | ⚠️ **分區數** |

**用跟 [07 章 7.3.2](./07-kafka-basics-and-producer.md) 完全相同的場景**
（200 張訂單 × 3 個事件、6 個分區、每則 1～20 ms），這次改用 Spring 的容器：

```java
            ContainerProperties props = new ContainerProperties(t);
            props.setGroupId(g);
            props.setAckMode(ContainerProperties.AckMode.RECORD);
            props.setMessageListener((MessageListener<String, String>) rec -> {
                // ⚠️ 不能用共用的 Random 並 synchronized 起來 —— 那會讓所有執行緒排隊睡覺，
                //    量出來的結果是「concurrency 完全沒有效果」
                sleep(1 + ThreadLocalRandom.current().nextInt(20));
                String[] p = rec.value().split(":");
                finalState.put(p[0], p[1]);
                // ...
            });
            var container = new ConcurrentMessageListenerContainer<>(
                    new DefaultKafkaConsumerFactory<String, String>(cfg), props);
            container.setConcurrency(conc);
            container.start();
```

⚠️ **那兩行註解是一個會踩到的坑**：
如果用一顆共用的 `Random` 並 `synchronized` 起來，**而且把 `sleep()` 放在鎖裡面** ——
所有執行緒排隊睡覺，量到的是
`1.00x / 1.16x / 1.15x / 1.15x / 1.14x`，也就是「`concurrency` 完全沒用」。
📌 **量併行的實驗，先確認你的「工作」真的可以併行。**

**輸出**：

```
═══ 8.6.1 @KafkaListener 的 concurrency（6 個分區、600 則、每則 1～20 ms） ═══
  200 張訂單 × 3 個事件，key = orderId，消費端用「最後收到的」當最終狀態

  ── concurrency = 1 ──
     真的有在收訊息的執行緒 : 1 / 1
     600 則耗時 : 8,318 ms  （  72 則/秒，相對 concurrency=1 1.00x）
     最終狀態錯掉的訂單 : 0 / 200

  ── concurrency = 2 ──
     真的有在收訊息的執行緒 : 2 / 2
     600 則耗時 : 4,348 ms  （ 137 則/秒，相對 concurrency=1 1.91x）
     最終狀態錯掉的訂單 : 0 / 200

  ── concurrency = 3 ──
     真的有在收訊息的執行緒 : 3 / 3
     600 則耗時 : 3,174 ms  （ 189 則/秒，相對 concurrency=1 2.62x）
     最終狀態錯掉的訂單 : 0 / 200

  ── concurrency = 6 ──
     真的有在收訊息的執行緒 : 6 / 6
     600 則耗時 : 1,684 ms  （ 356 則/秒，相對 concurrency=1 4.94x）
     最終狀態錯掉的訂單 : 0 / 200

  ── concurrency = 8 ──
     真的有在收訊息的執行緒 : 6 / 8
     600 則耗時 : 1,590 ms  （ 377 則/秒，相對 concurrency=1 5.23x）
     最終狀態錯掉的訂單 : 0 / 200
```

**兩件事**：

**① 「最終狀態錯掉的訂單」全部是 0，包含 `concurrency = 8`。**

📌 **對照 [05 章 5.5.2](./05-rabbitmq-reliability.md) 的 RabbitMQ：`concurrency=4` 時 98/200 是錯的（49%）。**
差別不在 Spring，在模型：**Kafka 的每一條執行緒拿到的是「不同的分區」，
而同一個 key 永遠在同一個分區。**

**② `concurrency=8` 的 `6 / 8`。**

多出來的兩條執行緒**各自建了一個 `KafkaConsumer`、加入了 group、在發心跳**，
然後什麼都沒收到。
⚠️ **它們不是閒置的執行緒池執行緒，是實實在在的 consumer 成員** ——
**每一個都會參與 rebalance**，讓 rebalance 變慢，而且沒有任何回報。

📌 **所以 `concurrency` 的正確設法**：

```yaml
spring:
  kafka:
    listener:
      concurrency: 3        # ← 每個實例 3 條；跑 2 個實例剛好吃滿 6 個分區
```

> **總併發度 = 實例數 × `concurrency`，而它應該 <= 分區數。**
>
> ⚠️ 這也代表：**滾動部署時（新舊實例並存）總併發度會短暫超過分區數**，
> 那一瞬間有成員拿不到分區 —— 這是正常的，rebalance 完就好。

### 8.6.2 ⚠️ `concurrency` 跟「工作執行緒池」不是同一件事

一個很常見的誤解是「`concurrency=10` 就是 10 條執行緒在跑我的業務邏輯」。
**是，但它同時也是 10 個 `KafkaConsumer`**，而那有三個成本：

| 成本 | 說明 |
|---|---|
| **10 個 group 成員** | rebalance 要協調 10 個成員，每次部署都要來一次 |
| **10 條 TCP 連線 + 10 份 fetch 緩衝** | `max.partition.fetch.bytes` 預設 1 MB，記憶體是乘上去的 |
| **超過分區數的部分完全浪費** | 8.6.1 的 `6 / 8` |

📌 **如果你要的只是「業務邏輯多執行緒跑」，而且不在乎順序**，
那應該用 8.5.3 表格裡的做法 ③（listener 收下就丟進自己的執行緒池），
**而不是把 `concurrency` 開大** ——
⚠️ 但那會放棄 Kafka 的順序保證，而且有「位移提交得太早」的問題（8.5.3 有講）。

**決策**：

```
   要順序（同一個 key）      →  用 concurrency，上限是分區數
   不要順序、只要吞吐        →  一樣先用 concurrency（簡單、安全）
                               真的不夠了才考慮「加分區」（07 章 7.7）
   單則處理很慢且不可預測    →  ③ 丟進執行緒池 + 任務落庫（02 章 Outbox 的鏡像）
```

---

## 8.7 重放：位移重設的 SOP ★★

[00 章 0.4.3](./00-course-map-why-message-queue.md) 說：

> 08 章 8.7 會把「線上出事之後怎麼安全重放」寫成 SOP。

**這一節就是那份 SOP。** 先把工具的每一個行為量清楚，再寫步驟。

### 8.7.0 本節的場景

```java
        // 30 則訊息，前 15 則送完之後停 6 秒，這樣時間戳分成前後兩群
        for (int i = 0; i < 30; i++) {
            if (i == 15) { firstHalfEnd = System.currentTimeMillis(); sleep(6000); }
            kafka.send(T, "ORD-" + i, "event-" + i).get();
        }
```

```
═══ 8.7.0 建一個可以重放的場景 ═══
  前 15 則送完，時間戳到 2026-09-22T15:35:30.554，停 6 秒
  後 15 則送完，時間戳到 2026-09-22T15:35:36.589
  📌 分界時間（前 15 則之後、後 15 則之前）: 2026-09-22T15:35:33.554
  消費者讀完 30 則並提交，現在 group 已經追平
```

```bash
docker exec kafka-lab /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server localhost:29092 --describe --group ch08.replay.g
```

```
GROUP           TOPIC           PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG  CONSUMER-ID  HOST  CLIENT-ID
ch08.replay.g   ch08.replay.v1  2          16              16              0    -            -     -
ch08.replay.g   ch08.replay.v1  1          10              10              0    -            -     -
ch08.replay.g   ch08.replay.v1  0          4               4               0    -            -     -
```

📌 **`4 + 10 + 16 = 30`。** `CURRENT-OFFSET` 與 `LOG-END-OFFSET` 一致 → `LAG = 0` → 追平了。
⚠️ 注意 `CONSUMER-ID / HOST / CLIENT-ID` 是 `-` —— **代表這個 group 現在沒有活躍成員**。
**那不是壞掉，那是 8.7.1 的前提。**

### 8.7.1 前提：group 不能有活躍成員

```java
        consumer.start();      // 起一個消費者掛著
        sleep(6000);
        // 然後執行 --reset-offsets --to-earliest --execute
```

**輸出**：

```
═══ 8.7.1 消費者還在跑的時候執行 --reset-offsets ═══

  ── 消費者掛著，執行 --reset-offsets --to-earliest --execute ──
    Error: Assignments can only be reset if the group 'ch08.replay.g' is inactive,
           but the current state is Stable.
    GROUP                          TOPIC                          PARTITION  NEW-OFFSET

  ── 消費者停掉之後，同一個指令再執行一次 ──
    GROUP           TOPIC           PARTITION  NEW-OFFSET
    ch08.replay.g   ch08.replay.v1  2          0
    ch08.replay.g   ch08.replay.v1  1          0
    ch08.replay.g   ch08.replay.v1  0          0
```

📌 **`the current state is Stable`** —— `Stable` 就是「有活躍成員、而且分配已經穩定」。
⚠️ **這是一個保護，不是一個限制**：
如果允許在消費者跑著的時候改位移，**那個消費者手上還有一批沒處理完的訊息**，
它處理完之後會把自己的位移提交上去 —— **你剛改的東西就被覆蓋掉了。**

📌 **所以 SOP 的第一步永遠是「把消費者停乾淨」，而 `--describe` 的
`CONSUMER-ID` 欄位就是你的驗證工具。**

### 8.7.2 五種重設目標

用 8.7.0 那個場景（p0 有 4 則、p1 有 10 則、p2 有 16 則），**每一種都先 `--dry-run`**：

**① `--to-earliest`：全部回到最開頭**

```bash
docker exec kafka-lab /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server localhost:29092 --group ch08.replay.g --topic ch08.replay.v1 \
  --reset-offsets --to-earliest --dry-run
```

⚠️ **先講一件會讓你以為自己看錯的事**：`--reset-offsets` 的輸出**沒有換行**，
所有列會擠成一行（`--describe` 則是正常換行的）。實際長這樣：

```
GROUP                          TOPIC                          PARTITION  NEW-OFFSET     ch08.replay.g                  ch08.replay.v1                 2          0              ch08.replay.g                  ch08.replay.v1                 1          0              ch08.replay.g                  ch08.replay.v1                 0          0
```

📌 **下面幾段為了好讀，我把它斷成一列一行** —— 欄位與數值都是原樣：

```
GROUP           TOPIC           PARTITION  NEW-OFFSET
ch08.replay.g   ch08.replay.v1  2          0
ch08.replay.g   ch08.replay.v1  1          0
ch08.replay.g   ch08.replay.v1  0          0
```

**② `--shift-by -5`：每個分區各往回 5 則**

```
[2026-09-22 07:36:14,748] WARN New offset (-1) is lower than earliest offset for topic partition
ch08.replay.v1-0. Value will be set to 0 (org.apache.kafka.tools.consumer.group.ConsumerGroupCommand)

GROUP           TOPIC           PARTITION  NEW-OFFSET
ch08.replay.g   ch08.replay.v1  2          11
ch08.replay.g   ch08.replay.v1  1          5
ch08.replay.g   ch08.replay.v1  0          0
```

📌 **`16 → 11`、`10 → 5`、`4 → -1` 被夾成 `0`，而且有 WARN。**
⚠️ **`--shift-by` 是「每個分區各自」移動的**，所以「往回 5 則」= 往回 `5 × 分區數` 則。
**要往回總共 N 則的話，要自己除以分區數。**

**③ `--to-offset 2`：把每個分區都設成同一個數字**

```
GROUP           TOPIC           PARTITION  NEW-OFFSET
ch08.replay.g   ch08.replay.v1  2          2
ch08.replay.g   ch08.replay.v1  1          2
ch08.replay.g   ch08.replay.v1  0          2
```

⚠️ **`--to-offset` 幾乎永遠不是你要的。** 它把**每一個分區**都設成同一個數字，
而不同分區的 offset 之間**毫無關係**（[07 章 7.2.2](./07-kafka-basics-and-producer.md)）。
📌 **只有在「我要重放某一個特定分區的某一段」時才用它，而且要搭配 `--topic 名字:分區號`**：

```bash
  --topic ch08.replay.v1:2 --reset-offsets --to-offset 10
```

**④ `--to-datetime`：回到某個時間點 —— ⚠️ 這裡有一個時區陷阱**

先用**主機上**看到的分界時間 `2026-09-22T15:35:33.554`：

```
Warn: Partition 2 from topic ch08.replay.v1 is empty. Falling back to latest known offset.
Warn: Partition 1 from topic ch08.replay.v1 is empty. Falling back to latest known offset.
Warn: Partition 0 from topic ch08.replay.v1 is empty. Falling back to latest known offset.
```

⚠️ **`is empty`？分區裡明明有 30 則訊息。**

```bash
echo "容器: $(docker exec kafka-lab date -u '+%Y-%m-%dT%H:%M:%S')  主機: $(date '+%Y-%m-%dT%H:%M:%S')"
```

```
容器: 2026-09-22T07:36:39  主機: 2026-09-22T15:36:39
```

📌 **容器是 UTC、主機是 UTC+8。**
`--to-datetime` 沒有時區後綴時，用的是**執行它的那個 JVM 的時區**（容器裡 = UTC）。
所以我給的 `15:35:33` 被當成 UTC，那是**八小時之後** ——
**沒有任何訊息的時間戳在那之後**，於是「fall back to latest known offset」。

⚠️ **這個失敗模式非常危險**：它**不會報錯**，它會把位移設到**最新**。
**你以為自己要重放，實際上是把整個 group 往前跳到最尾端 —— 中間的全部跳過。**

**換成 UTC 時間**：

```bash
docker exec kafka-lab /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server localhost:29092 --group ch08.replay.g --topic ch08.replay.v1 \
  --reset-offsets --to-datetime 2026-09-22T07:35:33.554 --dry-run
```

```
GROUP           TOPIC           PARTITION  NEW-OFFSET
ch08.replay.g   ch08.replay.v1  2          10
ch08.replay.g   ch08.replay.v1  1          4
ch08.replay.g   ch08.replay.v1  0          1
```

📌 **`10 + 4 + 1 = 15` —— 正好是「前 15 則」的分界。對上了。**

**⑤ `--to-latest`：跳到最尾端（放棄所有還沒處理的）**

```
GROUP           TOPIC           PARTITION  NEW-OFFSET
ch08.replay.g   ch08.replay.v1  2          16
ch08.replay.g   ch08.replay.v1  1          10
ch08.replay.g   ch08.replay.v1  0          4
```

⚠️ **這是「止血」用的，不是重放。**
場景：消費者因為某個 bug 卡在一則毒藥訊息上，積壓 50 萬則，而那 50 萬則已經沒有價值了。
**`--to-latest` 讓它立刻回到線上，代價是那 50 萬則永遠不會被處理。**
📌 **執行前一定要先把它們備份出來**（見 8.7.4 的步驟 3）。

**完整對照**：

| 目標 | 語意 | 什麼時候用 | 陷阱 |
|---|---|---|---|
| `--to-earliest` | 全部從頭 | 新的下游要補跑全部歷史 | 量可能非常大 |
| `--to-latest` | 跳到尾端 | **止血**：放棄積壓、立刻恢復 | ⚠️ 積壓的訊息永遠不會被處理 |
| `--to-datetime` | 回到某個時刻 | ✅ **事故重放最常用**（「從昨天 14:00 重跑」） | ⚠️ **時區**；找不到訊息會 fall back to latest |
| `--shift-by N` | 每個分區各移 N | 「往回一點點」 | ⚠️ 是**每個分區**各 N |
| `--to-offset N` | 指定位移 | 只重放某一個分區的某一段 | ⚠️ 會把所有分區設成同一個數字 |

📌 **還有兩個範圍參數**：`--all-topics`（這個 group 訂閱的全部）
與 `--topic <名字>:<分區號>,<分區號>`（只動特定分區）。
⚠️ **正式環境請永遠明確寫 `--topic`，不要用 `--all-topics`。**

### 8.7.3 ⚠️ 重放不是「把位移倒回去」那麼簡單

在寫 SOP 之前，先想清楚**重放會發生什麼**：

| 問題 | 說明 |
|---|---|
| **重複處理** | 那些訊息會被**再做一次**。扣款、寄信、發券 —— 全部再來一次 |
| **下游的下游** | 你的消費者處理完會產生新事件 → **下游也會收到重複** |
| **順序** | 重放期間，舊事件與**正在進來的新事件**會混在一起 |
| **時效性** | 三天前的「庫存不足」事件，今天重跑還對嗎？ |
| **吞吐** | 突然多 50 萬則要處理，下游的資料庫撐得住嗎 |

📌 **[06 章 6.2.4](./06-rabbitmq-retry-delay-and-cluster.md) 講過「重放死信的三個規矩」，
在 Kafka 上完全一樣，而且多一條**：

1. **消費者必須是冪等的**（[03 章](./03-idempotent-consumer.md)）。**這是前提，不是建議。**
2. **先在非正式環境重放一次**，確認結果符合預期。
3. **限速。** 重放不要用全速。
4. ⚠️ **（Kafka 獨有）先用「影子 group」試跑。**
   因為 Kafka 的訊息還在，你可以**用一個全新的 `group.id` 把同一段讀一遍**
   ——`--to-datetime` 到同一個點，跑一個**只印出來、不做事**的消費者，
   **先確認「這一段裡到底有什麼」**。
   **這一步在 RabbitMQ 上做不到**（訊息讀走就沒了），是 log 模型白送你的。

### 8.7.4 SOP

> **線上出事了，要把某一段重放一次。**

**階段一：不要碰位移，先搞清楚狀況**

```bash
# 1. 現在讀到哪、落後多少
docker exec kafka-lab /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server localhost:29092 --describe --group <group>

# 2. group 的狀態（Stable / Empty / PreparingRebalance…）與成員
docker exec kafka-lab /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server localhost:29092 --describe --group <group> --state
docker exec kafka-lab /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server localhost:29092 --describe --group <group> --members
```

**階段二：用影子 group 先看那一段有什麼（8.7.3 第 4 條）**

```bash
# 3. 用一個全新的 group.id 把那一段讀出來看 —— 完全不影響正式的 group
docker exec kafka-lab /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:29092 --topic <topic> \
  --group shadow.$(date +%s) \
  --from-beginning --max-messages 200 --timeout-ms 10000 \
  --property print.partition=true --property print.offset=true \
  --property print.key=true --property print.timestamp=true \
  > /tmp/replay-preview.txt
```

⚠️ **這一步同時也是「備份」** —— 如果你接下來要 `--to-latest` 放棄積壓，
**這個檔案就是那些訊息唯一的紀錄。**

**階段三：停消費者，並且確認真的停了**

```bash
# 4. 停掉所有消費者實例（kubectl scale --replicas=0 / docker stop / …）
# 5. ⚠️ 確認 group 已經是 Empty —— 這是 8.7.1 的硬前提
docker exec kafka-lab /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server localhost:29092 --describe --group <group> --state
```

**看到 `Empty` 才往下走。** 看到 `Stable` 代表還有實例活著。

**階段四：dry-run，看清楚每一個分區會變成什麼**

```bash
# 6. ⚠️ 永遠先 --dry-run
docker exec kafka-lab /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server localhost:29092 --group <group> --topic <topic> \
  --reset-offsets --to-datetime 2026-09-22T07:35:33.554 --dry-run
```

⚠️ **看到 `Falling back to latest known offset` 就停下來** —— 那是 8.7.2 那個時區陷阱。
⚠️ **時間請用「broker 容器的時區」**，或直接加時區後綴避免歧義。

**階段五：執行、恢復、盯著**

```bash
# 7. 把 --dry-run 換成 --execute
#    （⚠️ 建議先把 dry-run 的輸出存檔，這是你的回滾依據）
docker exec kafka-lab /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server localhost:29092 --group <group> --topic <topic> \
  --reset-offsets --to-datetime 2026-09-22T07:35:33.554 --execute

# 8. 確認改成功了
docker exec kafka-lab /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server localhost:29092 --describe --group <group>

# 9. 先只起「一個」消費者實例，看它處理得對不對
# 10. 確認無誤，再恢復到正常實例數
# 11. 盯著 LAG 下降，以及下游的錯誤率
```

📌 **步驟 9 是整份 SOP 最容易被跳過、但最值得做的一步。**
先起一個實例、限速跑一小段，**確認「重放出來的結果是對的」再放全速**。

⚠️ **回滾怎麼做？** 你在步驟 6 存下來的 dry-run 輸出裡有「舊的 `CURRENT-OFFSET`」嗎？
**沒有** —— dry-run 只印 `NEW-OFFSET`。
📌 **所以步驟 1 的 `--describe` 輸出一定要存檔**，那才是你的回滾依據：

```bash
docker exec kafka-lab /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server localhost:29092 --describe --group <group> \
  > /tmp/offsets-before-$(date +%s).txt
```

### 8.7.5 用程式重放：`assign()` + `seek()`

CLI 適合一次性的事故處理。**要做成一個可重複使用的工具，用 `assign()`**（8.2.3）：

```java
/** 把某個 topic 在某個時間點之後的訊息，重新丟進另一個 topic（或直接處理） */
public class Replayer {

    public void replay(String topic, long fromEpochMs, long untilEpochMs) {
        Map<String, Object> cfg = new HashMap<>();
        cfg.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:19092");
        cfg.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
        cfg.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
        // ⚠️ 不設 group.id：用 assign() 就不需要加入 group，也就不會動到正式 group 的位移

        try (KafkaConsumer<String, String> c = new KafkaConsumer<>(cfg)) {
            List<TopicPartition> tps = c.partitionsFor(topic).stream()
                    .map(p -> new TopicPartition(topic, p.partition())).toList();
            c.assign(tps);

            // 用時間戳找出每個分區的起點
            Map<TopicPartition, Long> query = tps.stream()
                    .collect(Collectors.toMap(tp -> tp, tp -> fromEpochMs));
            c.offsetsForTimes(query).forEach((tp, ot) -> {
                if (ot == null) c.seekToEnd(List.of(tp));   // ⚠️ 這個分區沒有那麼新的訊息
                else c.seek(tp, ot.offset());
            });

            while (true) {
                var rs = c.poll(Duration.ofMillis(500));
                if (rs.isEmpty()) break;
                for (var r : rs) {
                    if (r.timestamp() > untilEpochMs) return;   // 超過終點就停
                    handle(r);
                    throttle();                                  // ⚠️ 限速（8.7.3 第 3 條）
                }
            }
        }
    }
}
```

📌 **這個寫法比 CLI 好在三件事**：

1. **不動正式 group 的位移** —— 正式的消費者可以繼續跑，完全不用停機。
2. **有終點**（`untilEpochMs`）—— CLI 只能設起點，重放會一路跑到現在。
3. **可以限速、可以過濾**（例如「只重放 `orderId` 在這份清單裡的」）。

⚠️ **`offsetsForTimes` 回傳 `null` 代表「這個分區沒有時間戳 >= 你給的值的訊息」** ——
**就是 8.7.2 那個 `is empty` 的程式版本。** 一定要處理這個分支，不要讓它 NPE。

**兩種會回 `null` 的情況，實測**：

```
═══ 稽核 F：offsetsForTimes 的三種情況 ═══
  topic 有 2 個分區，只有 p0 有 4 則訊息，p1 是空的
  查「10 分鐘前」 p0=(timestamp=1790066321596, leaderEpoch=0, offset=0)   p1(空分區)=null
  查「10 分鐘後」 p0=null   p1(空分區)=null
```

| 情況 | 回傳 | 你該怎麼辦 |
|---|---|---|
| 有符合的訊息 | `OffsetAndTimestamp`（含 offset 與該則的時間戳） | `seek()` 過去 |
| **分區是空的** | `null` | `seekToEnd()`（沒東西可重放） |
| **時間點在「最後一則之後」** | `null` | ⚠️ **要當成錯誤處理**：通常代表你的時間給錯了（8.7.2 的時區陷阱） |

⚠️ **後兩種在程式裡長得一模一樣，但意義完全不同。**
📌 **穩健的寫法是：先比對 `endOffsets()`，確認這個分區到底是「空的」還是「你的時間點太新」。**

---

## 8.8 維運：怎麼看一個 consumer group 健不健康

### 8.8.1 `--describe` 的每一欄

```bash
docker exec kafka-lab /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server localhost:29092 --describe --group ch08.replay.g
```

```
GROUP           TOPIC           PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG  CONSUMER-ID  HOST  CLIENT-ID
ch08.replay.g   ch08.replay.v1  2          16              16              0    -            -     -
ch08.replay.g   ch08.replay.v1  1          10              10              0    -            -     -
ch08.replay.g   ch08.replay.v1  0          4               4               0    -            -     -
```

| 欄位 | 是什麼 | 不對勁的樣子 |
|---|---|---|
| `CURRENT-OFFSET` | **已提交**的位移（不是「讀到哪」） | `-` 代表這個分區從來沒有提交過 |
| `LOG-END-OFFSET` | 這個分區最後一則的下一個位移 | 一直不動 → 上游停了 |
| `LAG` | `LOG-END-OFFSET − CURRENT-OFFSET` | ⚠️ 持續成長 → 追不上；⚠️ 一直是 0 但業務沒動 → [01 章 1.5.2](./01-reliable-delivery-three-hops.md) 那個故障 |
| `CONSUMER-ID` | 目前持有這個分區的成員 | ⚠️ **`-` 代表沒有人在消費這個分區** |
| `HOST` | 那個成員的來源 IP | 用來對應到機器 / Pod |
| `CLIENT-ID` | 客戶端自己報的名字 | 📌 **設好它，出事時你會感謝自己** |

⚠️ **`LAG` 有兩種「看起來正常」的假象，兩種都已經在前面實測過**：

1. **`LAG = 0` 但沒有人在處理**（[01 章 1.5.2](./01-reliable-delivery-three-hops.md)）：
   自動提交把沒處理的也提交了 → **250/300 則永遠沒人處理，而 lag 是一條完美的零線。**
2. **`LAG = 0` 但訊息根本讀不到**（[01 章 1.3.6](./01-reliable-delivery-three-hops.md)）：
   `acks=1` + ISR 不足時，`LOG-END-OFFSET` 回的是 **high watermark**，
   那三則寫在 leader 上但對監控不存在。

📌 **所以 lag 不能單獨當健康指標。** 至少要再看兩個：
**`CONSUMER-ID` 是不是 `-`**，以及**你的業務指標有沒有在動**。

### 8.8.2 另外兩個 `--describe` 選項

```bash
# group 的狀態與成員數
docker exec kafka-lab /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server localhost:29092 --describe --group <group> --state

# 每一個成員持有哪些分區
docker exec kafka-lab /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server localhost:29092 --describe --group <group> --members --verbose
```

**`--state` 的五種值，這是你排查時第一個要看的東西**：

| 狀態 | 意思 | 看到它要想什麼 |
|---|---|---|
| `Stable` | 有成員、分配完成、一切正常 | ✅ |
| `Empty` | **沒有任何成員** | ⚠️ 服務掛了？還是 8.7 的 SOP 停了它？ |
| `PreparingRebalance` | 正在等成員回報 | ⚠️ **卡在這裡很久** = 有成員沒有回應（8.5.3 那種假死） |
| `CompletingRebalance` | 正在分配 | 短暫出現是正常的 |
| `Dead` | group 不存在或已被刪除 | 名字打錯了？ |

📌 **`PreparingRebalance` 卡住是最值得學會認的一個。**
它代表「有人不回應，大家都在等他」——
而 8.5.3 那個被 `max.poll.interval.ms` 踢掉的消費者，就會讓整個 group 反覆進出這個狀態。

### 8.8.3 消費到一半，broker 被重啟 ★★

[00 章 0.6.4](./00-course-map-why-message-queue.md) 說過「你會在 06、08 章刻意把 broker 打壞來看它怎麼恢復」。**現在打。**

```java
        prod.start(); cons.start();      // 生產者每 20 ms 一則、消費者做完一批就 commitSync
        sleep(8000);
        new ProcessBuilder("docker", "restart", "kafka-lab")
                .redirectErrorStream(true).start().waitFor(120, TimeUnit.SECONDS);
        // ... 量「消費者從停頓到再次處理訊息」中斷了多久
        // ... 最後比對：broker 上有幾則 vs 消費者處理了幾則、重複幾則
```

**輸出**：

```
═══ 8.8.3 消費到一半 docker restart kafka-lab ═══
  生產者每 20 ms 送一則、消費者做完一批就 commitSync

  ── 重啟前（跑了 8 秒）──
     送出成功 337 則、處理 337 則

  ── docker restart kafka-lab ──
     docker restart 回來，花了 1,262 ms
     消費者從停頓到再次處理訊息，中斷了 16,923 ms

  ── 全部結束 ──
     producer 回報成功 1406 則、失敗 0 則
     broker 上實際有 1406 則
     消費者處理 1406 次、不重複 1406 則
     遺失 : 0 則 ✅
     重複 : 0 則
  ── 過程中出現的例外（前 12 種）──
     （沒有任何例外）
```

📌 **`遺失 0`、`重複 0`、`例外 0`。客戶端自己把整件事吸收掉了。**

**為什麼能做到**：

| 誰 | 怎麼撐過去 |
|---|---|
| producer | `retries` 預設 `2147483647` + `delivery.timeout.ms` 120 秒 → 重連之後把緩衝區裡的送出去（[07 章 7.9.1](./07-kafka-basics-and-producer.md)） |
| consumer | `poll()` 內部會重連、重新找 group coordinator、重新取得分配 |
| 位移 | 存在 broker 的 `__consumer_offsets` 裡，**跟著 broker 一起重啟回來** |

⚠️ **但 `16,923 ms` 這個數字要記住。**
`docker restart` 只花 1.3 秒，**消費者卻停了將近 17 秒**。那 17 秒裡發生了：

```
   broker 停止 → 連線斷開
   broker 啟動 → 載入 log segments、重建索引
   consumer 重連 → 重新找 group coordinator（它也在這台 broker 上）
   coordinator 恢復 → 重新走一次 JoinGroup / SyncGroup
   consumer 拿回分區 → 繼續 poll
```

📌 **「單節點 Kafka 重啟 = 十幾秒的完全停擺」** ——
而這還是一台**沒有多少資料**的 broker。正式環境資料多，啟動時間會更長。
**這就是 RF ≥ 3 的另一個理由**（[07 章 7.5.3](./07-kafka-basics-and-producer.md)）：
多節點時重啟一台，其他兩台還在服務，停擺的只有那台上的 leader 分區，而且會立刻換人。

⚠️ **另外注意「0 重複」是這個場景的結果，不是通則。**
這裡沒有重複，是因為 `docker restart` 是**優雅關閉**（SIGTERM → controlled shutdown），
消費者在重連之後從自己最後提交的位移繼續。
**如果重啟發生在「處理完一批但還沒 commitSync」的那一瞬間，就會變成 8.3.1 那 26 則。**

### 8.8.4 ⚠️ 一個沒有人告訴你的過期時間：group 的位移自己會消失 ★★

**前面所有內容都假設「已提交的位移會一直在」。** 它不會。

```java
        for (String k : new String[]{..., "offsets.retention.minutes", ...}) {
            var e = cfg.get(k);
            System.out.printf("  %-42s = %s%n", k, e == null ? "(無此項)" : e.value());
        }
```

```
═══ 稽核 C：broker 端的 compaction / retention 預設值 ═══
  offsets.topic.num.partitions               = 50
  offsets.retention.minutes                  = 10080
  group.min.session.timeout.ms               = 6000
  group.max.session.timeout.ms               = 1800000
```

📌 **`offsets.retention.minutes = 10080` = 7 天。**

**語意是**：一個 consumer group **變成 `Empty`（沒有任何成員）之後**，
它的已提交位移會在 **7 天後被刪掉**，整個 group 就消失了。

⚠️ **這會製造一個跟 [09 章 9.5.3](./09-kafka-exactly-once-and-retention.md) 一模一樣的無聲故障**：

```
   一個「每月跑一次」的對帳消費者
      第 1 天  跑完，提交位移，服務關掉 → group 變成 Empty
      第 8 天  ⚠️ 位移被刪掉了（但 topic 上的訊息還在，retention 是 30 天）
      第 30 天 服務啟動 → 找不到已提交位移 → 套用 auto.offset.reset
                latest（預設）→ ⚠️ 這 30 天的資料全部跳過，而且 lag 是 0
                earliest      → ⚠️ 把 30 天的資料全部重跑一次
```

📌 **兩種預設值都是錯的答案，而且都不會報錯。**

**三個防法**：

| 防法 | 做什麼 |
|---|---|
| **① 讓消費者不要停** | 最簡單。低頻工作也讓它常駐 poll（沒訊息時 `poll()` 只是回空的） |
| **② 調大 `offsets.retention.minutes`** | broker 層級設定，要能改 broker 才行 |
| **③ 自己存位移** | 不要靠 `__consumer_offsets`，把位移寫進你自己的資料庫，啟動時 `seek()` 回去 |

⚠️ **`--describe --group` 對一個「位移已經過期」的 group 會回什麼？**
它會說 `Consumer group '...' does not exist.` ——
📌 **看到這句話的時候，先想「是名字打錯了」還是「它過期了」**，這兩個的處置完全不同。

📌 **順帶把這一節用到的另外兩個值記起來**：
`group.min.session.timeout.ms = 6000` 與 `group.max.session.timeout.ms = 1800000` ——
**8.5.2 把 `session.timeout.ms` 設成 6000 是貼著下限在跑**，再小就會被 broker 拒絕。

### 8.8.5 程式裡怎麼監控

CLI 適合排查，**告警要從消費者自己的 metric 拿**：

```java
@Component
class ConsumerLagReporter {

    private final KafkaListenerEndpointRegistry registry;

    /** records-lag-max：這個消費者目前最落後的那個分區落後幾則 */
    @Scheduled(fixedDelay = 30_000)
    void report() {
        registry.getListenerContainers().forEach(container ->
            container.metrics().forEach((clientId, metrics) ->
                metrics.forEach((name, metric) -> {
                    if ("records-lag-max".equals(name.name()))
                        log.info("consumer {} records-lag-max = {}", clientId, metric.metricValue());
                })));
    }
}
```

📌 **三個該設告警的指標**：

| 指標 | 從哪拿 | 告警條件 |
|---|---|---|
| `records-lag-max` | 消費者自己的 metric | 持續 N 分鐘高於門檻，**而且還在成長** |
| **rebalance 次數** | `rebalance-total`（`consumer-coordinator-metrics`） | ⚠️ 平常應該幾乎不動。一直跳 = 8.5.3 那個迴圈 |
| `commit-latency-avg` | 消費者 metric | 突然變高 = broker 有壓力 |

⚠️ **「rebalance 次數」是這一章最值得加的一個告警**，因為它是**因**，
而 lag 只是**果**。等到 lag 告警響，通常已經反覆 rebalance 很久了。

📌 **本站用的 `MsgProbe.lag(topic, group)`（[00 章 0.8.5](./00-course-map-why-message-queue.md)）
是「臨時查一下」的等級**，不要照抄進正式環境 ——
正式環境的 lag 監控要用常駐的 exporter（10 章會講）。

---

## 8.9 常見誤區

**① 「加消費者就會變快」**

⚠️ **超過分區數之後完全無效。** 8.2.1 實測 4 個消費者 / 3 個分區，**有一個拿到 `[]`**；
8.6.1 實測 `concurrency=8` / 6 個分區，**6 / 8 條執行緒在做事**。
📌 **而且多出來的成員不是「閒置執行緒」，它們是真的 group 成員，每次 rebalance 都要等它們。**

**② 「用預設的 assignor 就好」**

⚠️ **預設是 `[RangeAssignor, CooperativeStickyAssignor]`，協議結果是 `RangeAssignor`。**
8.2.2 實測：兩個 topic 各 3 分區、2 個消費者 → **4:2**，而其他三種都是 3:3。
📌 **訂閱多個 topic 的服務，請明確改成 `CooperativeStickyAssignor`（而且要分兩次部署）。**

**③ 「我的消費者處理很久，把 `session.timeout.ms` 調大」**

⚠️ **調錯了。** 8.5.2 實測：listener 卡 **30 秒**、`session.timeout.ms` 只有 **6 秒** —— **沒有被踢**。
心跳從 0.10.1 之後跑在**背景執行緒**上，跟你的業務程式碼無關。
📌 **該調的是 `max.poll.interval.ms`，或更好的做法是調小 `max.poll.records`。**

**④ 「`lag = 0` 就代表一切正常」**

⚠️ **兩種假象都已經實測過**：
[01 章 1.5.2](./01-reliable-delivery-three-hops.md) 的「250/300 則沒人處理而 lag=0」、
[01 章 1.3.6](./01-reliable-delivery-three-hops.md) 的「訊息在 leader 上但 HW 沒動，監控看不到」。
📌 **至少要再看 `CONSUMER-ID` 是不是 `-`，以及你的業務指標有沒有在動。**

**⑤ 「rebalance 是異常狀況」**

⚠️ **不是。你每次部署都會觸發好幾次**（8.3.3）。
📌 **所以「消費者必須冪等」的理由不是 broker 不可靠，是你每個禮拜都會部署。**

**⑥ 「把 `ack-mode` 改成 `RECORD` 就不會重複了」**

⚠️ **重複會變少，但不會是 0**（提交送出去、broker 收到了、回應在網路上丟了），
而且 8.4.2 實測它慢 **274～284 倍**。
📌 **比較划算的做法是調小 `max.poll.records`** —— 它同時縮小了「最糟重複量」（8.3.2）。

**⑦ 「`MANUAL` 的 `ack.acknowledge()` 會立刻提交」**

⚠️ **不會。** `MANUAL` 只是把位移排進佇列，**等這一批結束才送**。
📌 **要立刻送出必須用 `MANUAL_IMMEDIATE`。**

**⑧ 「一批裡有一則壞掉，就只確認其他那些」**

⚠️ **做不到。** 8.4.3 實測：位移是**一個數字**，不是一份清單。
你只有兩個選擇：停在它前面（後面已經做完的會重做），或跳過它（**它永遠消失，沒有死信**）。
📌 **Kafka 的死信是一個你要自己寫的模式，不是 broker 功能**（10 章）。

**⑨ 「`--reset-offsets` 隨時可以執行」**

⚠️ **group 有活躍成員時會直接拒絕**：
`Assignments can only be reset if the group is inactive, but the current state is Stable.`
📌 **SOP 的第一步永遠是把消費者停乾淨，並用 `--state` 確認看到 `Empty`。**

**⑩ 「`--to-datetime` 給錯時間頂多是重放錯一段」**

⚠️ **更糟。** 8.7.2 實測：給了主機時區的時間（而容器是 UTC），
輸出是 `Falling back to latest known offset` —— **它把位移設到最新，中間全部跳過**，
而且**那只是一行 `Warn`，指令回傳成功。**

**⑪ 「重放前先在 staging 測一下就夠了」**

📌 **Kafka 還給你一個更好的工具：影子 group。**
用一個全新的 `group.id` 把同一段讀一遍，**先看清楚「那一段裡到底有什麼」**（8.7.3 第 4 條）。
⚠️ **這一步在 RabbitMQ 上做不到**（訊息讀走就沒了），是 log 模型白送你的。

**⑫ 「broker 重啟會掉訊息」**

⚠️ **8.8.3 實測：遺失 0、重複 0、例外 0。** 客戶端自己吸收掉了。
📌 **但要記住代價：`docker restart` 只花 1,262 ms，消費者卻停了 16,923 ms。**

---

## 8.10 本章小結

**這一章量了八件事**：

1. **一個分區只給 group 裡的一個消費者，多出來的消費者拿到 `[]`**（8.2.1）。
   而預設的 `RangeAssignor` 在多 topic 時會偏心：**兩個 topic 各 3 分區、2 個消費者 → 4:2**（8.2.2）。
2. **rebalance 造成的重複，數量精確等於「當掉時已處理但還沒提交的則數」**（8.3.1）：
   **26 → 26**，而且**沒有遺失**（728 則全部處理到）。四次重跑分別是 27 / 26 / 26 / 27。
   📌 **重複的上限 = `max.poll.records`**，所以它是一個可靠性旋鈕。
3. **提交要錢，而且差距是 274～284 倍**（8.4.2）：
   `BATCH` 每秒 60～80 萬則，**`RECORD` 只有 4,800～4,900 則**（兩次跑分別是 283.56x 與 273.92x）。
   `commitAsync` 量不出成本，但它**不等回應、而且可能亂序**。
4. **位移是一個數字，不是一份清單**（8.4.3）：一批裡壞掉一則，
   你只能「停在它前面」（後面重做）或「跳過它」（**永遠消失，沒有死信**）。
5. **兩個逾時管兩件事**（8.5）：
   - listener 卡 30 秒、`session.timeout.ms=6000` → **不會被踢**（心跳在背景執行緒上）。
   - 每則 15 秒、`max.poll.interval.ms=8000` → **75 秒做了 5 次工、進度 0**。
   - 消費者消失後 group 多久發現：**優雅關閉 242 ms vs 當掉 8,134 ms**（34 倍），
     跟 [07 章 7.5.2](./07-kafka-basics-and-producer.md) 的 broker 版本同形。
6. **`concurrency` 在 Kafka 上不會破壞順序**（8.6.1）：
   1 → 2 → 3 → 6 → 8 條：**72 → 137 → 189 → 356 → 377 則/秒**，
   **最終狀態錯掉的訂單全部是 0 / 200**。
   對照 [05 章 5.5.2](./05-rabbitmq-reliability.md) 的 RabbitMQ：`concurrency=4` 時 **49% 是錯的**。
7. **broker 重啟：遺失 0、重複 0、例外 0，但消費者停了 16,923 ms**（8.8.3）。
8. ⚠️ **consumer group 的已提交位移自己會過期**（8.8.4）：
   `offsets.retention.minutes = 10080`（**7 天**）——
   一個 `Empty` 的 group 放著 7 天，位移就沒了，
   然後 `auto.offset.reset` 會無聲地決定它要「跳過全部」還是「重跑全部」。

📌 **把 [01 章 1.7](./01-reliable-delivery-three-hops.md) 那張三段總表的 Kafka 第三段填滿**：

```
   ③ broker → 消費者    enable-auto-commit=false + ack-mode BATCH   （8.4）
                         max.poll.records 決定「最糟重複量」          （8.3.2）
                         max.poll.interval.ms >= 一批的處理時間       （8.5.3）
                         CooperativeStickyAssignor                   （8.2.2）
   ────────────────────────────────────────────────────────────
   併發                  concurrency <= 分區數                        （8.6）
   出事之後              --reset-offsets 的 SOP + 影子 group          （8.7）
   監控                  lag + CONSUMER-ID + rebalance 次數           （8.8）
   仍然防不住            重複 → 冪等消費                              （03 章）
```

### 8.10.1 驗收清單

做得到才往下走：

- [ ] 說出「一個分區只給一個消費者」這件事保證了什麼，以及它跟 [07 章 7.3.2](./07-kafka-basics-and-producer.md) 那個 0/200 的關係。
- [ ] 說出 4 個消費者 / 3 個分區時，第四個消費者在做什麼。
- [ ] 解釋 `RangeAssignor` 在「5 個 topic 各 3 分區、2 個實例」下會分成幾比幾。
- [ ] 說出 `Sticky` 與 `Cooperative` 各自講的是「結果」還是「過程」。
- [ ] 說出 `subscribe()` 與 `assign()` 的五個差別，以及 `assign()` 放棄了什麼。
- [ ] 寫出「把 assignor 換成 `CooperativeStickyAssignor`」的兩次部署內容。
- [ ] 畫出 8.3.1 那個「26 → 26」的時間線，並指出 `commitSync()` 沒跑到的那一刻。
- [ ] 說出 8.3.0 三次失敗各自錯在哪，以及第三次為什麼量到的是「遺失」而不是「重複」。
- [ ] 說出「最糟重複量」由哪個設定決定，以及把它調小的代價。
- [ ] 列出 rebalance 的七種觸發原因，並指出哪一種每週都會發生。
- [ ] 說出 `onPartitionsRevoked` 在「優雅關閉」與「當掉」兩種情況下的差別。
- [ ] 說出 `onPartitionsLost` 為什麼通常要自己覆寫。
- [ ] 列出 Spring 七種 `AckMode`，並說出 `MANUAL` 與 `MANUAL_IMMEDIATE` 的差別。
- [ ] 說出 `TIME` / `COUNT` 為什麼把 [01 章 1.5.2](./01-reliable-delivery-three-hops.md) 那個故障搬了回來。
- [ ] 量化 `RECORD` 相對 `BATCH` 的吞吐代價，並算出「一次提交」大約要多久。
- [ ] 說出 8.4.2 那張表裡哪三列是雜訊、哪一列可以下結論，以及判斷的依據。
- [ ] 說出 `commitAsync` 的兩個風險，並寫出「平常 async、關閉時 sync」的範本。
- [ ] 解釋「位移是一個數字，不是一份清單」造成的兩難，並說出 RabbitMQ 為什麼沒有這個問題。
- [ ] 說出 `session.timeout.ms` 與 `max.poll.interval.ms` 各自由誰觸發。
- [ ] 解釋 8.5.2 為什麼「卡 30 秒也不會被踢」。
- [ ] 畫出 8.5.3 那個無窮迴圈，並指出 `CommitFailedException` 為什麼一定會發生。
- [ ] 說出修 `max.poll.interval.ms` 問題的四種做法，以及第三種把問題搬到哪裡去了。
- [ ] 算出「`max.poll.records=500`、每則處理 600 ms」需要多大的 `max.poll.interval.ms`。
- [ ] 說出消費者「優雅關閉」與「當掉」的時間差，以及 `terminationGracePeriodSeconds` 太短會怎樣。
- [ ] 說出 Kafka 的 `concurrency` 跟 RabbitMQ 的同名參數在「順序」與「上限」上的差別。
- [ ] 算出「6 個分區、要跑 2 個實例」時 `concurrency` 該設多少。
- [ ] 說出 `--reset-offsets` 的硬前提，以及怎麼驗證它成立。
- [ ] 說出五種重設目標各自的語意與陷阱。
- [ ] 解釋 `--shift-by -5` 在 3 個分區上實際往回幾則。
- [ ] 說出 `Falling back to latest known offset` 代表什麼、為什麼危險。
- [ ] 說出「影子 group」是什麼、它在 RabbitMQ 上為什麼做不到。
- [ ] 背出 8.7.4 SOP 的五個階段，並說出哪一步是你的回滾依據。
- [ ] 說出 `offsetsForTimes` 回傳 `null` 代表什麼。
- [ ] 讀出 `--describe` 的六欄，並說出 `CONSUMER-ID` 是 `-` 代表什麼。
- [ ] 說出 `--state` 的五種值，以及 `PreparingRebalance` 卡住代表什麼。
- [ ] 說出為什麼「rebalance 次數」比 lag 更值得告警。
- [ ] 說出 `offsets.retention.minutes` 的預設值與語意，以及它對「每月跑一次的批次消費者」的後果。
- [ ] 看到 `Consumer group '...' does not exist.`，說出兩種可能的原因與各自的處置。
- [ ] 說出 `onPartitionsLost` 的預設實作做了什麼，以及為什麼通常要覆寫它。
- [ ] 說出 `offsetsForTimes` 回傳 `null` 的兩種情況，以及怎麼分辨它們。

### 8.10.2 本章練習

**練習一（20 分鐘）**：重跑 8.2.2，但改成**三個** topic（各 3 個分區）、**2 個**消費者。
**記錄四種 assignor 各自的分配。**
然後回答：`RangeAssignor` 的偏心程度隨 topic 數量怎麼變化？**寫出一個公式。**

**練習二（30 分鐘）**：重跑 8.3.1，但把 `max.poll.records` 從 50 改成 **5** 與 **500**。
**記錄三組的「當掉時未提交則數」與「重複則數」。**
然後回答：這兩個數字的關係是什麼？**你的系統可以接受的重複上限是多少？**

**練習三（25 分鐘）**：在 8.3.1 的消費者上加一個 `ConsumerRebalanceListener`，
在 `onPartitionsRevoked` 裡提交位移。
然後做**兩種**結束方式：① 優雅關閉（`consumer.close()`）、② 直接 `kill -9` JVM。
**記錄兩種情況下的重複則數**，並解釋差別。

**練習四（30 分鐘）**：重現 8.5.3，然後用 8.5.3 表格裡的**四種修法各修一次**。
**記錄每一種修法下「75 秒內處理了幾則、進度到哪」。**
然後回答：做法 ③（丟進執行緒池）有什麼新問題？**你要怎麼補？**

**練習五（25 分鐘）**：量出你自己專案的「安全 `max.poll.interval.ms`」：
① 量單則處理時間的 p99；② 乘上 `max.poll.records`；③ 再乘 2。
然後**故意**把它設成 p99 × `max.poll.records` × 0.5，送 100 則進去，
**記錄 `rebalance-total` 這個 metric 在 5 分鐘內跳了幾次。**

**練習六（進階，35 分鐘）**：完整執行一次 8.7.4 的 SOP：
1. 建一個 topic、送 1,000 則（時間戳橫跨 3 個明顯的時段）。
2. 用一個會「把 `amount` 乘 2」的**有 bug 的**消費者跑完全部。
3. 修掉 bug，然後**只重放第二個時段**。
4. **驗證**：第一與第三時段的資料沒有被動到、第二時段的資料是對的。
5. **記錄**：你在哪一步發現自己需要「影子 group」？

**練習七（進階，30 分鐘）**：重現 8.7.2 那個時區陷阱：
① 用主機時區的時間執行 `--to-datetime --dry-run`，記錄輸出；
② 用 UTC 時間執行，記錄輸出；
③ **然後把 ① 的版本真的 `--execute` 下去**，看 `--describe` 變成什麼。
**寫一句話**給你的團隊，說明這個指令該怎麼寫才安全。

**練習八（進階，30 分鐘）**：重現 8.8.3，但這次在**「消費者剛處理完一批、還沒 commitSync」**
的那一瞬間重啟 broker（提示：在 `commitSync()` 前面加一個 `sleep`，用那個窗口動手）。
**記錄遺失與重複的則數**，並跟 8.8.3 的「0 / 0」對照。

**練習九（綜合，60 分鐘）**：**Kafka 消費端的總驗收。**
把 [03 章的冪等消費](./03-idempotent-consumer.md) 接到 Kafka 上：
1. 6 個分區、key = `orderId`、`concurrency=3` × 2 個實例。
2. 消費者用去重表做冪等，`ack-mode: BATCH`、`max-poll-records: 50`。
3. **演練四種故障**，每一種都記錄「最終資料對不對」與「去重表擋掉幾則」：
   - 其中一個實例 `kill -9`（8.3.1）
   - 滾動重啟兩個實例（8.3.3）
   - 一則訊息讓處理時間超過 `max.poll.interval.ms`（8.5.3）
   - `docker restart kafka-lab`（8.8.3）
4. **最終驗收**：1,000 張訂單、業務結果 1,000 筆（不多不少）、去重表擋掉的次數 > 0。

📌 **第 4 點那個「去重表擋掉的次數 > 0」是重點** ——
它證明**重複真的發生過**，而你的系統擋住了。**如果它是 0，代表你的故障演練不夠狠。**

---

## 8.11 下一章預告

**消費端講完了。** 你現在會：

- 讀懂分區分配、選對 assignor（8.2）。
- 解釋並量化 rebalance 造成的重複（8.3）。
- 選對提交時機，並知道它的價錢（8.4）。
- 分辨兩個逾時、修掉踢人迴圈（8.5）。
- 設對 `concurrency`（8.6）。
- 安全地重放（8.7）、看懂一個 group 健不健康（8.8）。

**但這兩章加起來，有一個問題一直被推遲**：

> **「至少一次」是這兩章所有設定的上限。到底有沒有辦法做到「精確一次」？**

[01 章 1.6.2](./01-reliable-delivery-three-hops.md) 已經給了半個答案：

```
✅ Kafka → Kafka：可以精確一次（09 章的交易 + read_committed）
❌ Kafka → 你的 MySQL：做不到
❌ Kafka → 寄一封信：做不到
❌ Kafka → 呼叫別人的 API：做不到
```

**09 章會把這四行講透**，而且會證明第一行的「✅」比你想的窄很多。

**09 章還要還三筆帳**：

- **冪等 producer**：[01 章 1.3.5](./01-reliable-delivery-three-hops.md) 說「它會強制 `acks=all`」、
  「有人為了效能把 `acks` 改成 1，他同時失去了冪等 producer」。
  ⚠️ **而 [01 章 1.3.8](./01-reliable-delivery-three-hops.md) 與
  [03 章 3.2](./03-idempotent-consumer.md) 都強調過：它只保證單一 producer session 內。**
  09 章會把那個邊界量出來。
- **保留策略**：[00 章 0.4.2](./00-course-map-why-message-queue.md) 說
  「刪除只由 retention 決定 —— 09 章會講怎麼設」。
  ⚠️ 而 8.7 整節的前提是「訊息還在」—— **retention 設太短，重放就是一句空話。**
- **log compaction**：`__consumer_offsets`（這一章從頭用到尾的那個 topic）本身就是 compacted 的。

📌 **一句話預告 09 章**：

> **07 章與 08 章讓你的系統「不漏」，09 章要回答「能不能不重」。**
> 答案是：**在 Kafka 內部可以，一跨出去就不行** ——
> 而 9.4 會用一個實驗證明「跨出去」比你以為的容易得多。
