# 第 09 章：Kafka 交易與保留

> [07 章](./07-kafka-basics-and-producer.md) 讓你的生產者不漏，[08 章](./08-kafka-consumer-group-and-offset.md) 讓你的消費者不漏。
> **這一章回答最後一個問題：能不能不重？**
>
> [01 章 1.6.2](./01-reliable-delivery-three-hops.md) 已經給了半個答案：
>
> ```
> ✅ Kafka → Kafka：可以精確一次（09 章的交易 + read_committed）
> ❌ Kafka → 你的 MySQL：做不到
> ❌ Kafka → 寄一封信：做不到
> ❌ Kafka → 呼叫別人的 API：做不到
> ```
>
> **9.4.2 把第二行量出來。** 300 則入帳事件、每則 10 元，正確答案是 300 列、3,000 元。
> 在「寫完一邊、還沒寫另一邊」的時候當掉兩次：
>
> ```
>   寫法 A：先寫資料庫、再提交位移    → 340 列、3,400 元   ❌ 重複入帳 400 元
>   寫法 B：先提交位移、再寫資料庫    → 260 列、2,600 元   ❌ 漏掉     400 元
>   寫法 C：先寫資料庫（冪等）、再提交 → 300 列、3,000 元   ✅ 正確
> ```
>
> **A 重複、B 遺失，只有 C 是對的** —— 而 C 靠的不是 Kafka 的任何功能，
> 是 [03 章的冪等消費](./03-idempotent-consumer.md)。
>
> ---
>
> 這一章還要還四筆帳：
>
> **一、冪等 producer 到底防什麼。**
> [01 章 1.3.5](./01-reliable-delivery-three-hops.md) 說「有人為了效能把 `acks` 改成 1 ——
> 他同時失去了冪等 producer，09 章會講它防的是什麼」。
> 9.2.1 會把它在磁碟上的指紋挖出來（`producerId` 與 `sequence`），
> 而 9.2.4 會量出 [01 章 1.3.8](./01-reliable-delivery-three-hops.md) 與
> [03 章 3.2](./03-idempotent-consumer.md) 都強調過的那個邊界：
> **一模一樣的訊息、換一個 producer session 送 —— broker 上就是兩份。**
>
> **二、⚠️ `isolation.level` 的預設值是 `read_uncommitted`。**
> 9.3.2 實測：一個被 `abortTransaction()` 掉的交易，
> **用預設設定的消費者「看得到」那三則被回滾的訊息。**
>
> **三、交易要多少錢。** 9.3.4：每 100 則 commit 一次 → **吞吐掉到 1/28**。
>
> **四、`retention.ms` 設了卻什麼都沒被刪。**
> 9.5.1 實測：設成 10 秒，然後**整整 270 秒完全沒有任何動靜**，
> 第 300 秒一次全部刪光 —— 因為 `log.retention.check.interval.ms` 的預設值是 **300000**。
> ⚠️ 而 [08 章 8.7](./08-kafka-consumer-group-and-offset.md) 那整份重放 SOP 的前提是「訊息還在」。

---

## 9.1 學習目標

完成本章後，你應該可以：

- 從 `kafka-dump-log` 的輸出判斷一則訊息是不是由冪等 producer 寫的（9.2.1）。
- 說出冪等 producer 防的是哪一種重複、**不防**哪一種，並解釋那個邊界為什麼存在（9.2）。
- 說出 `enable.idempotence=true` 會強制哪三個設定（9.2.5）。
- 用 Kafka 交易做 consume-transform-produce，並說出 `sendOffsetsToTransaction` 那一行的意義（9.3.3）。
- 說出 `isolation.level` 的預設值，以及用預設值讀一個交易型 topic 會看到什麼（9.3.2）。
- 從 log dump 裡認出 `endTxnMarker`，並解釋「end offset 比訊息數多」的原因（9.3.2）。
- 量化交易的吞吐代價，並說出它跟「多久 commit 一次」的關係（9.3.4）。
- 解釋「精確一次」在 Kafka 內部成立、跨出去就不成立的**確切理由**（9.4）。
- 說出 `retention.ms` / `retention.bytes` / `segment.bytes` / `log.retention.check.interval.ms` 各自管什麼（9.5）。
- 解釋「我設了 `retention.ms=1000` 但什麼都沒被刪」的兩個可能原因（9.5.1）。
- 算出一個 topic 的磁碟上限，並說出 `retention.bytes` 是「每個什麼」的（9.5.2）。
- 說出「消費者落後 + retention 到期」會發生什麼，以及它為什麼是無聲的（9.5.3）。
- 設定 log compaction，並說出它跟 `delete` 的差別（包含**兩者是不同的執行緒與節奏**）、以及 tombstone 的作用（9.6）。
- 說出 `__consumer_offsets` 為什麼是 compacted 的（9.6.3）。

---

## 9.2 冪等 producer ★★★

### 9.2.1 它在磁碟上留下什麼

[07 章 7.2.4](./07-kafka-basics-and-producer.md) dump log 的時候，有三個欄位我說「09 章會講」。現在講。

同樣送三則，只改 `enable.idempotence`：

```java
        for (boolean idem : new boolean[]{true, false}) {
            cfg.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, idem);
            // ⚠️ 關掉冪等時一定要一起設 acks=1 與 retries=0，否則 ConfigException
            //    （01 章 1.3.5 那張衝突表）
            if (!idem) { cfg.put(ProducerConfig.ACKS_CONFIG, "1"); cfg.put(ProducerConfig.RETRIES_CONFIG, 0); }
            // ... 送三則，然後 kafka-dump-log.sh
        }
```

**輸出**：

```
═══ 9.2.1 冪等 producer 在 log 上留下什麼 ═══

  ── enable.idempotence = true ──
    baseOffset: 0 lastOffset: 0 count: 1 baseSequence: 0 lastSequence: 0 producerId: 1006 producerEpoch: 0
    | offset: 0 CreateTime: ... sequence: 0 headerKeys: [] key: ORD-1 payload: e0
    baseOffset: 1 lastOffset: 1 count: 1 baseSequence: 1 lastSequence: 1 producerId: 1006 producerEpoch: 0
    | offset: 1 CreateTime: ... sequence: 1 headerKeys: [] key: ORD-1 payload: e1
    baseOffset: 2 lastOffset: 2 count: 1 baseSequence: 2 lastSequence: 2 producerId: 1006 producerEpoch: 0
    | offset: 2 CreateTime: ... sequence: 2 headerKeys: [] key: ORD-1 payload: e2

  ── enable.idempotence = false ──
    baseOffset: 0 lastOffset: 0 count: 1 baseSequence: -1 lastSequence: -1 producerId: -1 producerEpoch: -1
    | offset: 0 CreateTime: ... sequence: -1 headerKeys: [] key: ORD-1 payload: e0
    baseOffset: 1 lastOffset: 1 count: 1 baseSequence: -1 lastSequence: -1 producerId: -1 producerEpoch: -1
    | offset: 1 CreateTime: ... sequence: -1 headerKeys: [] key: ORD-1 payload: e1
    baseOffset: 2 lastOffset: 2 count: 1 baseSequence: -1 lastSequence: -1 producerId: -1 producerEpoch: -1
    | offset: 2 CreateTime: ... sequence: -1 headerKeys: [] key: ORD-1 payload: e2
```

📌 **差別只有兩個欄位，但它們就是整個機制**：

| | `producerId` | `sequence` |
|---|---|---|
| 冪等**開** | `1006`（broker 發給這個 producer session 的編號） | `0, 1, 2 …` **單調遞增** |
| 冪等**關** | `-1`（沒有身分） | `-1`（沒有編號） |

**機制是一句話**：

> **broker 為每個 `(producerId, partition)` 記住「我收到的最後一個 sequence 是幾」。**
> 收到一個「已經看過或更舊」的 sequence，就**直接丟掉並回報成功**。

📌 **所以它防的是這一件事，而且只有這一件事**：

```
   producer 送出 sequence=5
   broker 收到、寫進 log、回應
       ╳  回應在網路上不見了
   producer 沒收到回應 → 重送 sequence=5
   broker：「我看過 5 了」→ 丟掉，回報成功
   ────────────────────────────────────────
   結果：log 裡只有一份 ✅
```

⚠️ **對照 [01 章 1.3.6](./01-reliable-delivery-three-hops.md) 那個 dump**：
那裡的 console producer 寫進去的是 `sequence: 0`（有冪等），
而用 `acks=0/1` + `retries=0` 送的那兩則是 `sequence: -1`（冪等被關掉了）。
📌 **現在你知道那個 `-1` 代表什麼了。**

### 9.2.2 實測：逼 producer 重送，看 broker 上會有幾份 ★★★

上面講的是機制。**現在真的把它逼出來。**

做法：把 `request.timeout.ms` 調到比 broker 的回應時間還短 ——
producer 等不到回應就會**認定失敗並重送**，但 broker 其實已經寫進去了。

```java
        int N = 4000;    // 4,000 則 × 約 1 KB
        cfg.put(ProducerConfig.ACKS_CONFIG, "all");
        cfg.put(ProducerConfig.RETRIES_CONFIG, Integer.MAX_VALUE);
        cfg.put(ProducerConfig.REQUEST_TIMEOUT_MS_CONFIG, rt);        // ← 1 / 5 / 15
        cfg.put(ProducerConfig.DELIVERY_TIMEOUT_MS_CONFIG, 120000);
        cfg.put(ProducerConfig.BATCH_SIZE_CONFIG, 1048576);
        // ... 送完之後比對「producer 說送出幾則」與「broker 上實際有幾則」
```

**輸出**：

```
═══ 9.2.2 producer 逾時重送：broker 上會不會出現兩份 ═══
  送 4,000 則 × 約 1 KB，request.timeout.ms 刻意調很短逼它重送

  request.timeout  enable.idempotence        送出    broker 上      多出來
  1                false                        0       27131   ⚠️ 27131
  1                true                         0        1034   ⚠️ 1034
  5                false                     4000       29694   ⚠️ 25694
  5                true                      4000        4000          0
  15               false                     4000        4000          0
  15               true                      4000        4000          0
```

⚠️ **看 `request.timeout.ms = 5` 那兩列 —— 這就是整節的答案**：

```
   冪等關 →  送 4,000 則，broker 上 29,694 則     （每一則平均被寫了 7.4 次）
   冪等開 →  送 4,000 則，broker 上  4,000 則     （0 份多的）
```

📌 **同樣的重送次數、同樣的網路行為，差別只在 broker 願不願意用 `sequence` 去重。**

**`request.timeout.ms = 15` 那兩列同樣重要**：broker 來得及回應 → 沒有重送 → 兩種設定都是 4,000。
⚠️ **也就是說：冪等 producer 平常完全不做事，它只在「真的發生重送」的那一刻才有價值** ——
**而那一刻你無法預測，也無法在測試環境重現。**

⚠️ **`request.timeout.ms = 1` 那兩列有一個額外的教訓**：
`送出 = 0` 代表**每一則的 `Future` 都回報失敗**，但 broker 上有 27,131 / 1,034 則。

> 📌 **「producer 回報失敗」不等於「broker 沒收到」。**
> 這是 [01 章 1.3.6](./01-reliable-delivery-three-hops.md) 那個
> 「`acks=1` 回報成功但沒人讀得到」的**反面**：
> 這次是**回報失敗，但東西其實寫進去了**。
>
> ⚠️ **所以「送失敗就重送」這個看似安全的補償邏輯，本身就是重複的來源** ——
> 而這正是 [03 章的冪等消費](./03-idempotent-consumer.md)存在的理由。

### 9.2.3 它還順便保證了「順序」

一個常被忽略的副作用：**冪等 producer 同時修好了「重試造成的亂序」。**

```
   沒有冪等（max.in.flight=5）：
      送 batch1（seq 無）→ 失敗，排隊重試
      送 batch2（seq 無）→ 成功，寫進 log
      重送 batch1        → 成功，寫進 log
      ────────────────────────────────────
      log 裡的順序：batch2, batch1   ⚠️ 亂了

   有冪等（max.in.flight <= 5）：
      broker 發現 batch2 的 sequence 比「期待的下一個」大
      → 回 OutOfOrderSequenceException，要 producer 重來
      → log 裡的順序永遠等於 send() 的順序 ✅
```

📌 **這就是為什麼 `enable.idempotence=true` 會強制 `max.in.flight.requests.per.connection <= 5`**
（[01 章 1.3.5](./01-reliable-delivery-three-hops.md) 那張表的最後一列，
超過 5 就 `ConfigException`）—— **broker 端只追蹤最近 5 個批次的 sequence。**

⚠️ **也就是說：[07 章 7.3](./07-kafka-basics-and-producer.md) 講的「同一個 key 同一個分區、
所以有序」，在「關掉冪等 + 有重試」的情況下是不成立的。**
**key 只保證「進同一個分區」，冪等 producer 才保證「進去的順序不變」。**

### 9.2.4 ⚠️ 它只保證「單一 producer session 內」

**這是 [01 章 1.3.8](./01-reliable-delivery-three-hops.md) 與
[03 章 3.2](./03-idempotent-consumer.md) 兩處都強調過、但一直沒有量過的邊界。**

```java
        out.append("\n  ── session A：送一則「扣款 ORD-9527 / 1000 元」──\n");
        try (KafkaProducer<String, String> p = new KafkaProducer<>(cfg)) {
            var md = p.send(new ProducerRecord<>(t, "ORD-9527", "PAY:1000")).get();
        }
        // producer 關掉了

        out.append("\n  ── session B：一模一樣的內容，再送一次 ──\n");
        try (KafkaProducer<String, String> p = new KafkaProducer<>(cfg)) {
            var md = p.send(new ProducerRecord<>(t, "ORD-9527", "PAY:1000")).get();
        }
```

**輸出**：

```
═══ 9.2.4 冪等 producer 只保證「單一 session 內」 ═══

  ── session A：送一則「扣款 ORD-9527 / 1000 元」──
     ✅ off=0，broker 上 1 則
     （producer 關掉了 —— 例如服務重啟、或 Outbox 輪詢器被 kill -9 之後重來）

  ── session B：一模一樣的內容，再送一次 ──
     ✅ off=1，broker 上 2 則  ⚠️ 兩份

  ── 磁碟上長這樣 ──
    baseOffset: 0 lastOffset: 0 count: 1 baseSequence: 0 lastSequence: 0 producerId: 1004 producerEpoch: 0
    | offset: 0 ... key: ORD-9527 payload: PAY:1000
    baseOffset: 1 lastOffset: 1 count: 1 baseSequence: 0 lastSequence: 0 producerId: 1005 producerEpoch: 0
    | offset: 1 ... key: ORD-9527 payload: PAY:1000
```

⚠️ **`producerId: 1004` 與 `producerId: 1005`，兩個都是 `sequence: 0`。**

📌 **broker 沒有任何理由認為它們是同一則訊息。**
它去重的鍵是 `(producerId, partition, sequence)` ——
**換一個 producer session 就換一個 `producerId`，去重表也就重新開始。**

> ⚠️ **這個邊界為什麼重要，看它對應到什麼真實情境**：
>
> ```
>   [02 章的 Outbox 輪詢器](./02-outbox-and-transactional-consistency.md)
>      撈出 outbox 列 → kafka.send() → 送成功了
>      ╳ 在 markSent() 之前被 kill -9
>      服務重啟 → 新的 producer session → 又撈到同一列 → 又送一次
>      ────────────────────────────────────────────────
>      broker 上兩份。冪等 producer 完全幫不上忙。
> ```
>
> 📌 **這正是 [01 章 1.3.8](./01-reliable-delivery-three-hops.md) 那張表倒數第二列
> 「送出之後、確認之前行程掛掉 → confirm 救不了、acks 救不了」的延伸** ——
> **冪等 producer 也救不了。**

**那有什麼救得了？**

| 方法 | 做得到嗎 | 代價 |
|---|---|---|
| 冪等 producer | ❌ 只在單一 session 內 | 免費（預設就開） |
| **交易 + 固定的 `transactional.id`** | ✅ **跨 session**（9.3.5） | 9.3.4：commit 密集時掉一個數量級 |
| **消費端冪等**（[03 章](./03-idempotent-consumer.md)） | ✅ | 一張去重表 |

📌 **`transactional.id` 是唯一能跨 session 的機制** ——
因為它讓新的 producer 在 `initTransactions()` 時
**認領同一個身分、並把上一個 session 沒完成的交易處理掉**（fence 掉舊的 epoch）。
9.3.5 會講。

⚠️ **但即使如此，絕大多數系統的答案仍然是「消費端冪等」** ——
因為交易只在 Kafka 內部有效（9.4）。

### 9.2.5 `enable.idempotence=true` 強制了什麼

[01 章 1.3.5](./01-reliable-delivery-three-hops.md) 已經實測過那張衝突表，這裡只把結論接回來：

| 設定 | 被強制成 | 違反時 |
|---|---|---|
| `acks` | **必須 `all`** | `ConfigException: Must set acks to all in order to use the idempotent producer.` |
| `retries` | **必須 > 0** | `ConfigException: Must set retries to non-zero when using the idempotent producer.` |
| `max.in.flight.requests.per.connection` | **必須 <= 5** | `ConfigException: Must set max.in.flight... to at most 5` |

⚠️ **而如果你沒有「明確寫出」`enable.idempotence`，Kafka 會安靜地把它關掉**，
日誌裡一行都不會提。📌 **所以 [07 章 7.9.3](./07-kafka-basics-and-producer.md) 的設定把四個都寫出來。**

**吞吐代價**：[07 章 7.5.1](./07-kafka-basics-and-producer.md) 量過 ——
**在 `acks=all` 之上，冪等 producer 的額外成本量不出來**（兩次跑出相反的結果，那是雜訊）。
📌 **所以它是本站唯一一個「幾乎免費的可靠性設定」，沒有理由關掉它。**

---

## 9.3 Kafka 交易與 `read_committed` ★★

### 9.3.1 三個預設值

```
═══ 9.3.1 消費者端跟交易有關的預設值 ═══
  isolation.level          = read_uncommitted
  transactional.id         = null
  transaction.timeout.ms   = 60000
```

⚠️ **`isolation.level = read_uncommitted` 是這一節最重要的一行。**
**預設的消費者看得到「還沒提交」與「已經回滾」的訊息。** 9.3.2 證明。

📌 **`transactional.id = null` 代表「交易預設是關的」** ——
你必須明確設一個 id 才能用 `beginTransaction()`。

### 9.3.2 被 abort 掉的訊息，誰看得到 ★★★

```java
        try (var p = txProducer("ch09-tx-1")) {
            p.beginTransaction();
            for (int i = 0; i < 3; i++) p.send(new ProducerRecord<>(t, "k", "COMMITTED-" + i));
            p.commitTransaction();

            p.beginTransaction();
            for (int i = 0; i < 3; i++) p.send(new ProducerRecord<>(t, "k", "ABORTED-" + i));
            // ⚠️ 一定要 flush()：不 flush 的話這 3 則還在 producer 的緩衝區裡，
            //    abortTransaction() 會直接在客戶端把它們丟掉 —— broker 上根本沒有東西，
            //    那就量不到「read_uncommitted 看得到、read_committed 看不到」的差別
            p.flush();
            p.abortTransaction();
        }
```

⚠️ **那三行註解是一個會踩到的坑。**
沒有 `flush()` 的話，兩種 `isolation.level` 讀到的東西**一模一樣**
（都只有 3 則 COMMITTED），因為被 abort 的訊息**根本沒有離開 producer**。

**輸出**：

```
═══ 9.3.2 一個 commit 的交易 + 一個 abort 的交易 ═══
  交易 A：送 3 則 COMMITTED-* 然後 commitTransaction()
  交易 B：送 3 則 ABORTED-* 並 flush()，broker end offset = 7
          然後 abortTransaction()

  broker 回報的 end offset = 8  （只送了 6 則業務訊息）

  ── isolation.level = read_uncommitted（⚠️ 這是預設值）──
     COMMITTED-0@off0
     COMMITTED-1@off1
     COMMITTED-2@off2
     ABORTED-0@off4          ← ⚠️ 被回滾的訊息
     ABORTED-1@off5          ← ⚠️
     ABORTED-2@off6          ← ⚠️

  ── isolation.level = read_committed ──
     COMMITTED-0@off0
     COMMITTED-1@off1
     COMMITTED-2@off2
```

⚠️ **用預設設定的消費者，讀到了三則「已經被回滾」的訊息。**

> **想像這是什麼**：一個「扣款」交易因為下游失敗而 `abortTransaction()`，
> 但下游的下游用預設設定讀了這個 topic —— **它以為錢扣掉了。**

**磁碟上實際的樣子，把整件事講清楚**：

```
  ── 磁碟上實際有什麼 ──
    baseOffset: 0 lastOffset: 2 count: 3 ... producerId: 1007 producerEpoch: 1 isTransactional: true isControl: false
    | offset: 0 ... payload: COMMITTED-0
    | offset: 1 ... payload: COMMITTED-1
    | offset: 2 ... payload: COMMITTED-2
    baseOffset: 3 lastOffset: 3 count: 1 ... isTransactional: true isControl: true
    | offset: 3 ... endTxnMarker: COMMIT coordinatorEpoch: 0
    baseOffset: 4 lastOffset: 6 count: 3 ... isTransactional: true isControl: false
    | offset: 4 ... payload: ABORTED-0
    | offset: 5 ... payload: ABORTED-1
    | offset: 6 ... payload: ABORTED-2
    baseOffset: 7 lastOffset: 7 count: 1 ... isTransactional: true isControl: true
    | offset: 7 ... endTxnMarker: ABORT coordinatorEpoch: 0
```

📌 **三個關鍵**：

1. **「回滾」不會刪掉任何東西。** `ABORTED-0/1/2` 就躺在 offset 4、5、6 上。
   **Kafka 的 log 是 append-only —— 它沒有「刪除」這個動作**（[00 章 0.4.2](./00-course-map-why-message-queue.md)）。
2. **`endTxnMarker: ABORT` 是一筆「控制訊息」**（`isControl: true`），佔掉 offset 7。
   `read_committed` 的消費者讀到它，**才回頭知道 offset 4~6 要跳過**。
3. **`end offset = 8`，但業務訊息只有 6 則。** 多出來的兩個是 COMMIT 與 ABORT 標記。

⚠️ **第 3 點看起來會有一個維運後果，實測不是那樣** ——
這裡要花一點篇幅講清楚。

**直覺的推論**是：「控制訊息也佔 offset，所以一個追平的 group，lag 不會是 0」。
**實測推翻了它**：

```
═══ 稽核 H：交易型 topic 上，追平的 group 的 LAG 是 0 嗎 ═══
  送了 3 個交易 × 2 則 = 6 則業務訊息（外加 3 個 COMMIT 標記）
  read_committed 讀到 6 則業務訊息，consumer.position() = 9
  LOG-END-OFFSET = 9、CURRENT-OFFSET = 9 → LAG = 0

  ── kafka-consumer-groups --describe 怎麼說 ──
    GROUP           TOPIC           PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG
    zaudit.txlag.g  zaudit.txlag    0          9               9               0
```

📌 **`LAG = 0`。** 消費者只「讀到」6 則，但它的 `position` 會**跳過控制訊息**推進到 9 ——
所以提交上去的位移也是 9，lag 正常歸零。

**但交易型 topic 真的有一個 lag 的特殊行為，只是不是上面那個。** 再量一次：

```
═══ 稽核 I：交易「開著還沒 commit」時，read_committed 的消費者會怎樣 ═══
  ── 交易一：4 則，已 commit ──
     read_committed     讀到 4 則  position=5  LOG-END-OFFSET=5  LAG=0
     read_uncommitted   讀到 4 則  position=5  LOG-END-OFFSET=5  LAG=0

  ── 交易二：10 則已經到 broker 了，但交易「還開著」──
     read_committed     讀到 0 則  position=5  LOG-END-OFFSET=15  LAG=10
     read_uncommitted   讀到 10 則  position=15  LOG-END-OFFSET=15  LAG=0
     📌 這就是 LSO（last stable offset）：read_committed 被擋在開著的交易前面

  ── 交易二 commit 之後 ──
     read_committed     讀到 10 則  position=16  LOG-END-OFFSET=16  LAG=0
     read_uncommitted   讀到 0 則  position=16  LOG-END-OFFSET=16  LAG=0
```

⚠️ **`read_committed` 讀到 0 則、position 卡在 5、而 LAG = 10。**

📌 **這叫 LSO（last stable offset）**：`read_committed` 的消費者**最多只能讀到
「第一個還沒結束的交易」之前**。那 10 則已經在 broker 的磁碟上了，
但只要交易沒 commit，它就**一則都拿不到**。

> ⚠️ **所以交易型 topic 的 lag 告警有一個獨特的失效模式**：
>
> ```
>   一個 producer 開了交易、送了東西、然後卡住（或當掉）
>   → 下游所有 read_committed 的消費者全部停在 LSO
>   → lag 一路往上，但消費者「沒有慢」、CPU 是 0%、也沒有任何例外
>   → 要等 transaction.timeout.ms（預設 60 秒）coordinator 才會強制 abort
> ```
>
> 📌 **看到「lag 在漲但消費者很閒」，交易型 topic 要先懷疑這個**，
> 而不是去調 `max.poll.records`。
> ⚠️ 而這也是 9.3.4 說「commit 間隔 = 端到端延遲的下限」的實際樣貌。

### 9.3.3 consume → transform → produce

**這就是 [01 章 1.6.2](./01-reliable-delivery-three-hops.md) 說的「Kafka → Kafka 可以精確一次」。**

```java
        try (KafkaConsumer<String, String> c = new KafkaConsumer<>(ccfg);
             var p = txProducer("ch09-tx-ctp")) {
            c.subscribe(List.of(in));
            while (handled < 6 && ...) {
                var rs = c.poll(Duration.ofMillis(400));
                if (rs.isEmpty()) continue;
                p.beginTransaction();
                Map<TopicPartition, OffsetAndMetadata> offsets = new HashMap<>();
                for (var r : rs) {
                    p.send(new ProducerRecord<>(outT, r.key(), "processed(" + r.value() + ")"));
                    offsets.put(new TopicPartition(r.topic(), r.partition()),
                                new OffsetAndMetadata(r.offset() + 1));
                }
                // 📌 關鍵的一行：把「位移提交」也放進同一個交易
                p.sendOffsetsToTransaction(offsets, c.groupMetadata());
                p.commitTransaction();
            }
        }
```

⚠️ **消費端有兩個設定是必要的**：

```java
        ccfg.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, false);   // ⚠️ 交易模式下一定要關
        ccfg.put(ConsumerConfig.ISOLATION_LEVEL_CONFIG, "read_committed");
```

**輸出**：

```
═══ 9.3.3 consume → transform → produce 是一個原子操作 ═══
  輸入 topic 準備了 6 則
  處理了 6 則

  輸出 topic 的 end offset = 7（6 則業務訊息 + 交易標記）

  ── read_committed 讀輸出 topic ──
     processed(raw-0)@off0
     processed(raw-1)@off1
     processed(raw-2)@off2
     processed(raw-3)@off3
     processed(raw-4)@off4
     processed(raw-5)@off5

  輸入 topic 的已提交位移 = {ch09.tx.in2-0=OffsetAndMetadata{offset=6, ...}}
  📌 這個位移是被 sendOffsetsToTransaction 寫進去的，跟輸出訊息在同一個交易裡
```

📌 **`sendOffsetsToTransaction` 那一行是整個「精確一次」的全部。**

**為什麼它做得到，而 9.4 的資料庫版本做不到**：

```
   消費位移存在哪？  →  __consumer_offsets，一個 Kafka topic
   輸出訊息存在哪？  →  order.processed.v1，一個 Kafka topic
   ──────────────────────────────────────────────────────
   兩個都在 Kafka 裡 → 一個 Kafka 交易就能一起提交或一起回滾
```

⚠️ **「精確一次」的準確說法是**：

> **「輸出訊息」與「輸入位移」這兩件事是原子的。**
> **不是「你的處理函式只會被執行一次」** ——
> 處理函式還是可能跑兩次（交易 abort 之後重來），
> **只是第一次的輸出不會被任何 `read_committed` 的消費者看到。**

📌 **所以如果你的處理函式有 Kafka 以外的副作用（寫資料庫、呼叫 API、寄信），
那個副作用會發生兩次 —— 這就是 9.4。**

### 9.3.4 交易要多少錢

```
═══ 9.3.4 交易的吞吐代價（50,000 則 × 200 bytes） ═══
  寫法                                          耗時 ms          則/秒         相對
  不用交易（冪等 producer，預設）                        151      331,125      1.00x
  交易，每 50,000 則 commit 一次                     138      362,318      0.91x
  交易，每 1,000 則 commit 一次                      874       57,208      5.79x
  交易，每 100 則 commit 一次                      2,379       21,017     15.75x
```

📌 **跑了兩次，兩次的「形狀」一樣，但「倍數」差很多**：

| commit 頻率 | 第一次 | 第二次 | 可以下的結論 |
|---|---|---|---|
| 不用交易 | 1.00x | 1.00x | 基準 |
| 整段只 commit 1 次 | 1.11x | **0.91x** | ⚠️ **交易本身量不出成本** |
| 每 1,000 則 | 4.37x | 5.79x | **4～6 倍** |
| 每 100 則 | 28.10x | 15.75x | ⚠️ **一個數量級，但別引用單一數字** |

⚠️ **「每 100 則」那一格兩次差了將近一倍（28.10x vs 15.75x）** ——
可以寫進報告的是「**commit 越頻繁越貴，密集 commit 會讓吞吐掉一個數量級**」，
**不能寫「交易讓吞吐變成 1/28」。**

📌 **交易本身很便宜，貴的是 `commitTransaction()`。**

每一次 commit 都要：
① 跟 transaction coordinator 來回、
② 寫一筆 `__transaction_state`、
③ 往每一個涉及的分區寫一個控制訊息。

**所以代價 ∝ commit 的次數，而不是訊息數。**

⚠️ **但你不能把 commit 間隔拉到無限大**，因為：

- **commit 間隔 = 你的重複處理半徑。** 交易中途失敗，整批都要重來。
- **`read_committed` 的消費者在你 commit 之前看不到任何東西** →
  **commit 間隔 = 端到端延遲的下限。** 每 1,000 則 commit 一次 = 下游最少延遲 1,000 則的產生時間。
- **`transaction.timeout.ms` 預設 60 秒**，超過就被 coordinator 強制 abort。

📌 **實務上的起手式：每一批 `poll()` 一個交易**（就像 9.3.3 那樣）——
它讓「交易邊界」與「批次邊界」重合，最好理解也最好除錯。

### 9.3.5 `transactional.id`：跨 session 的那把鑰匙

9.2.4 說「`transactional.id` 是唯一能跨 session 的機制」。**理由在 `initTransactions()`**：

```java
        cfg.put(ProducerConfig.TRANSACTIONAL_ID_CONFIG, "order-processor-1");
        KafkaProducer<String, String> p = new KafkaProducer<>(cfg);
        p.initTransactions();       // ← 這一行做了三件事
```

`initTransactions()` 會：

1. 跟 coordinator **認領 `transactional.id` 這個身分**，拿到一個 `producerEpoch`。
2. **把舊的 epoch fence 掉** —— 上一個 session 如果還活著，它接下來的寫入全部會被拒絕
   （`ProducerFencedException`）。
3. **把上一個 session 沒結束的交易處理掉**（commit 或 abort）。

📌 **第 2 點解決了「殭屍實例」問題**：
一個被認為已經死掉、但其實還活著的舊實例，**不可能再寫進任何東西**。

⚠️ **而它的代價是「`transactional.id` 必須是穩定且唯一的」**：

| 怎麼取 | 結果 |
|---|---|
| 每次啟動隨機產生 | ❌ 等於沒有跨 session 保護，而且會在 coordinator 上堆積一堆 id |
| 全部實例共用同一個 | ❌ 它們會互相 fence，**只有最後啟動的那個能寫** |
| **`<服務名>-<實例序號>`**（例如 StatefulSet 的序號） | ✅ 正解 |
| **`<服務名>-<分區號>`** | ✅ consume-transform-produce 的標準做法 |

📌 **所以在 Kubernetes 上用交易，通常要用 StatefulSet 而不是 Deployment** ——
你需要一個**穩定的實例身分**。

**Spring 的寫法**：

```yaml
spring:
  kafka:
    producer:
      transaction-id-prefix: order-processor-   # ← Spring 會自動接上一個後綴
    consumer:
      isolation-level: read_committed           # ⚠️ 一定要改，預設是 read_uncommitted
      enable-auto-commit: false
```

```java
@Service
public class OrderProcessor {

    private final KafkaTemplate<String, String> kafka;

    /** 有 transaction-id-prefix 之後，@Transactional 會啟動一個 Kafka 交易 */
    @Transactional("kafkaTransactionManager")
    @KafkaListener(topics = "order.created.v1", groupId = "order-processor")
    public void handle(ConsumerRecord<String, String> record) {
        kafka.send("order.processed.v1", record.key(), transform(record.value()));
        // 位移由容器在交易裡一起提交（Spring 幫你呼叫 sendOffsetsToTransaction）
    }
}
```

⚠️ **`@Transactional("kafkaTransactionManager")` 那個限定名稱不能省** ——
如果你的專案同時有 `DataSourceTransactionManager`，不寫就會挑錯一個。
**而「兩個都要」正是 9.4 要講的那件做不到的事。**

---

## 9.4 「精確一次」保證不到你的資料庫 ★★★

### 9.4.1 先說清楚 9.3 到底保證了什麼

```
   ┌─────────────────────────────────────────────────┐
   │  Kafka 的世界                                    │
   │                                                 │
   │   order.created.v1  ──┐                         │
   │                       ├─▶ 你的處理 ──┬─▶ order.processed.v1
   │   __consumer_offsets ─┘              │          │
   │            ▲                          │          │
   │            └──────────────────────────┘          │
   │              sendOffsetsToTransaction            │
   │              （這兩個寫入是原子的）                 │
   └─────────────────────────────────────────────────┘
                              │
                              │  ⚠️ 一跨出這個框，交易就結束了
                              ▼
                   ┌──────────┬──────────┬──────────┐
                   │  MySQL   │  寄信     │ 別人的 API │
                   └──────────┴──────────┴──────────┘
```

📌 **Kafka 交易能做到原子，只因為「位移」跟「輸出訊息」**都是 Kafka 裡的 topic**。
**它沒有任何辦法把你的 `INSERT` 納進同一個提交。**

### 9.4.2 實測：Kafka → MySQL

**場景**：300 則入帳事件、每則 10 元。正確答案是 **300 列、合計 3,000 元**。
一批 20 則，**在第 3 與第 7 批「寫完一邊、還沒寫另一邊」的時候當掉**。

```java
                    if (order.equals("offset-first")) {
                        c.commitSync(Map.of(tp, new OffsetAndMetadata(maxOff + 1)));
                        if (crash) { crashes++; break; }   // ⚠️ 位移提交了，資料庫還沒寫 → 崩潰
                        writeAll(ids, idem);
                    } else {
                        writeAll(ids, idem);
                        if (crash) { crashes++; break; }   // ⚠️ 資料庫寫了，位移還沒提交 → 崩潰
                        c.commitSync(Map.of(tp, new OffsetAndMetadata(maxOff + 1)));
                    }
```

**三種寫法，`writeAll` 的差別只有一行 SQL**：

```java
            if (idem) st.execute("INSERT INTO ch09_ledger_idem (event_id, amount) VALUES ('" + id
                    + "', 10) ON DUPLICATE KEY UPDATE amount = VALUES(amount)");   // 天然冪等
            else st.execute("INSERT INTO ch09_ledger (event_id, amount) VALUES ('" + id + "', 10)");
```

**輸出**：

```
═══ 9.4.2 Kafka → MySQL：兩件事不可能一起成功或一起失敗 ═══
  300 則入帳事件、每則 10 元，正確答案是 300 列、合計 3000 元
  一批 20 則，在第 3 與第 7 批「寫完一邊、還沒寫另一邊」的時候當掉

  ── 寫法 A：先寫資料庫、再提交位移（at-least-once）──
     當掉 2 次   資料庫 340 列、合計 3400 元   ❌ 多了 40 列（重複入帳 400 元）

  ── 寫法 B：先提交位移、再寫資料庫（at-most-once）──
     當掉 2 次   資料庫 260 列、合計 2600 元   ❌ 少了 40 列（漏掉 400 元）

  ── 寫法 C：先寫資料庫（而且寫入是冪等的）、再提交位移 ──
     當掉 2 次   資料庫 300 列、合計 3000 元   ✅ 正確

  📌 A 會重複、B 會遺失，只有 C 是對的 —— 而 C 靠的不是 Kafka，是 03 章的冪等消費。
```

📌 **數字非常乾淨：2 次當掉 × 每批 20 則 = 40 則，剛好是兩個方向的誤差量。**

⚠️ **這跟 [01 章 1.6.1](./01-reliable-delivery-three-hops.md) 那兩行程式碼是同一件事**：

```java
// at-most-once：先 ack，再做事
channel.basicAck(tag, false);
mailService.sendConfirm(event);        // ← 這裡掛掉：訊息沒了、信沒寄

// at-least-once：先做事，再 ack
mailService.sendConfirm(event);
channel.basicAck(tag, false);          // ← 這裡掛掉：信寄了、訊息回到佇列 → 再寄一次
```

**換成 Kafka、換成資料庫、加上交易與冪等 producer —— 那個縫還在原地。**

### 9.4.3 為什麼「用 `ChainedTransactionManager` 把兩個湊起來」不算答案

一個很自然的想法：Spring 有 `ChainedTransactionManager`，把
`KafkaTransactionManager` 與 `DataSourceTransactionManager` 串起來不就好了？

```java
// ⚠️ 這個類別在 Spring 5.3 已經 @Deprecated，理由就是下面這件事
new ChainedTransactionManager(kafkaTxManager, dataSourceTxManager);
```

**它做的事是「依序提交」**：

```
   commit 資料庫  ✅
   commit Kafka   ╳ ← 這裡失敗（或這一瞬間行程掛掉）
   ────────────────────────────────────────
   資料庫已經提交了，而且回不去了
```

📌 **「依序提交兩個東西」不等於「原子提交」。** 它只是把 9.4.2 那個縫**變窄**，沒有消滅它。
⚠️ **而變窄的縫更危險** —— 它讓你在測試環境永遠測不到，然後在正式環境用很低的機率出事。

**真正的分散式交易（2PC / XA）呢？**
[01 章 1.6.2](./01-reliable-delivery-three-hops.md) 講過：**Kafka 不支援 XA。**
它的交易只在 Kafka 內部，沒有對外的 prepare / commit 協定。

### 9.4.4 所以實務上的三條路

| 路線 | 做法 | 保證 | 代價 |
|---|---|---|---|
| **① at-least-once + 冪等消費** ✅ | 先寫資料庫（冪等）、再提交位移 | **效果上的 exactly-once** | 一張去重表（[03 章](./03-idempotent-consumer.md)） |
| **② Kafka 交易** | 只在 Kafka → Kafka 的環節用 | 那一段真的 exactly-once | commit 越密集越貴，可能掉一個數量級（9.3.4） |
| **③ Outbox**（反方向） | 資料庫 → Kafka 時用（[02 章](./02-outbox-and-transactional-consistency.md)） | 不漏（但可能重複） | 一張 outbox 表 + 輪詢器 |

📌 **一個完整的系統通常三條都要，因為它們解的是不同方向的問題**：

```
   你的服務 ─── 寫資料庫 + 送訊息 ──▶  Kafka        ③ Outbox（02 章）
   Kafka   ─── 讀訊息 + 產生新訊息 ──▶ Kafka        ② Kafka 交易（9.3）
   Kafka   ─── 讀訊息 + 寫資料庫 ────▶ MySQL        ① 冪等消費（03 章）
```

⚠️ **而 ① 是唯一「非有不可」的那一個。**
②、③ 都可以用別的方式繞過去，**但只要你的消費者有 Kafka 以外的副作用，① 就沒得選。**

> 📌 **這一站走到這裡，[01 章 1.6.3](./01-reliable-delivery-three-hops.md) 那句結論可以收尾了**：
>
> **at-least-once + 冪等消費 = 效果上的 exactly-once。**
>
> 而 9.4.2 證明了：**這不是「退而求其次」，這是唯一正確的做法。**
> Kafka 的「精確一次」不是它的替代品，是它在 Kafka 內部那一段的補強。

---

## 9.5 保留策略

[00 章 0.4.2](./00-course-map-why-message-queue.md) 說「刪除只由 retention（時間 / 大小）決定 —— 09 章會講怎麼設」。

⚠️ **而這件事跟 [08 章 8.7](./08-kafka-consumer-group-and-offset.md) 直接相關**：
那整份重放 SOP 的前提是「訊息還在」。**retention 設太短，重放就是一句空話。**

### 9.5.1 ⚠️ 「我設了 `retention.ms` 但什麼都沒被刪」★★

**兩個 topic，`retention.ms` 都設 10 秒（10000），差別只有 `segment.bytes`**：

```java
        // ① 預設的 segment 大小（1 GB）
        mk(big, 1, Map.of("retention.ms", "10000"));
        // ② 很小的 segment：會滾動出很多「封存」的 segment
        mk(small, 1, Map.of("retention.ms", "10000", "segment.bytes", "1024"));
        // 各送 200 則 × 約 200 bytes，然後每 30 秒看一次
```

**輸出**：

```
═══ 9.5.1 兩個 topic 都設 retention.ms=10000（10 秒） ═══
  差別只有一個：segment.bytes（一個用預設 1 GB、一個設 1024 bytes）

  送完 200 則（每則約 200 bytes）
    ch09.ret.bigseg      earliest=0  latest=200  磁碟 54,690 bytes  segments: 00000000000000000000.log
    ch09.ret.smallseg    earliest=0  latest=200  磁碟 54,690 bytes  segments: 00000000000000000000.log …（每 3 則一個，一路到 00000000000000000198.log，共 67 個）

  ── 等 retention.ms 過去，每 30 秒看一次 ──
    + 30s  bigseg earliest=0    磁碟 54,690   |  smallseg earliest=0    磁碟 54,690
    + 60s  bigseg earliest=0    磁碟 54,690   |  smallseg earliest=0    磁碟 54,690
    + 90s  bigseg earliest=0    磁碟 54,690   |  smallseg earliest=0    磁碟 54,690
    +120s  bigseg earliest=0    磁碟 54,690   |  smallseg earliest=0    磁碟 54,690
    +150s  bigseg earliest=0    磁碟 54,690   |  smallseg earliest=0    磁碟 54,690
    +180s  bigseg earliest=0    磁碟 54,690   |  smallseg earliest=0    磁碟 54,690
    +210s  bigseg earliest=0    磁碟 54,690   |  smallseg earliest=0    磁碟 54,690
    +240s  bigseg earliest=0    磁碟 54,690   |  smallseg earliest=0    磁碟 54,690
    +270s  bigseg earliest=0    磁碟 54,690   |  smallseg earliest=0    磁碟 54,690
    +300s  bigseg earliest=200  磁碟      0   |  smallseg earliest=200  磁碟      0   ← 一次全刪
    +330s  bigseg earliest=200  磁碟      0   |  smallseg earliest=200  磁碟      0
    +391s  bigseg earliest=200  磁碟      0   |  smallseg earliest=200  磁碟      0

  最後的 segment 檔案：
    ch09.ret.bigseg      00000000000000000200.log
    ch09.ret.smallseg    00000000000000000200.log
```

⚠️ **`retention.ms` 是 10 秒，但整整 270 秒什麼事都沒發生。**

📌 **原因是 `log.retention.check.interval.ms`，[07 章 7.5.4](./07-kafka-basics-and-producer.md) 印出來過**：

```
  log.retention.check.interval.ms               = 300000
```

**清理執行緒每 5 分鐘才醒來一次。** `retention.ms` 說的是「可以刪了」，
**不是「立刻刪」** —— 兩者之間最多差一個檢查間隔。

> 📌 **這解釋了一個非常常見的困惑**：
> 「我在測試環境把 `retention.ms` 設成 1000，送了訊息，等了 30 秒，它還在！」
> **對，它會在那裡待最多 5 分鐘。**

⚠️ **這個實驗還推翻了一個常見的以為。**
直覺是「`segment.bytes` 用預設值時，資料全部在**使用中的 segment** 裡，而使用中的 segment 不會被刪」——
**實測不是這樣**：兩個 topic 都被清光了，而且都留下一個全新的 `00000000000000000200.log`。
📌 **`delete` 策略下，Kafka 會先把使用中的 segment「滾掉」（開一個新的），再刪掉舊的。**
（⚠️ **但「使用中的 segment 不會被處理」這句話對 compaction 是成立的** —— 9.6.2 會看到。）

**那 `segment.bytes` 到底影響什麼？影響「刪除的顆粒度」**：

```
   segment.bytes 大  →  一個 segment 裝很多訊息  →  ⚠️ 要「整段都過期」才能刪
   segment.bytes 小  →  一個 segment 裝很少訊息  →  可以細細地刪，但檔案數量爆炸（這裡 67 個）
```

⚠️ **上面那個實驗看不出顆粒度的差別，因為 200 則訊息是「同一秒送的、同時過期的」。**
**要看到差別，訊息的時間戳必須分散** —— 9.5.2 的 `retention.bytes` 實驗會示範這件事。

📌 **所以「訊息什麼時候真的消失」取決於三個東西，不是一個**：

```
   retention.ms                      ← 「可以刪了」
   log.retention.check.interval.ms   ← 「多久檢查一次」（預設 5 分鐘）
   segment.bytes / segment.ms        ← 「刪除的最小單位」
```

⚠️ **`segment.ms` 容易被忘掉。把一個「什麼都沒設」的 topic 印出來看**：

```
═══ 稽核 D：一個什麼都沒設的 topic，實際生效的設定 ═══
  cleanup.policy                 = delete
  retention.ms                   = 604800000
  retention.bytes                = -1
  segment.bytes                  = 1073741824
  segment.ms                     = 604800000
  min.insync.replicas            = 1
  compression.type               = producer
  delete.retention.ms            = 86400000
  min.cleanable.dirty.ratio      = 0.5
  min.compaction.lag.ms          = 0
  max.message.bytes              = 1048588
  message.timestamp.type         = CreateTime
```

📌 **`segment.bytes = 1 GB` 而 `segment.ms = 604800000`（7 天）—— 兩個是「或」的關係**：
**寫滿 1 GB 或者過了 7 天，segment 就滾一次。**

⚠️ **所以一個低流量的 topic（一天寫不到 1 GB），它的 segment 是「每 7 天滾一次」的** ——
而 `retention.ms` 預設也是 7 天。**兩個 7 天疊起來，實際留存時間會明顯超過你設的值。**
📌 **要精準控制留存時間，`segment.ms` 要設得比 `retention.ms` 小**（常見是 1/4 到 1/10）。

### 9.5.2 `retention.bytes` 是「每個分區」的

```java
        mk(t, 3, Map.of("retention.bytes", "20480", "segment.bytes", "4096"));   // 3 個分區
        for (int i = 0; i < 1500; i++) kafka.send(t, "k" + i, new String(pad)).get();
```

**輸出**：

```
═══ 9.5.2 retention.bytes=20480（20 KB）、3 個分區 ═══
  送完 1,500 則（約 345,000 bytes 的資料量）
  現在磁碟上：411,390 bytes

  ── 等清理執行緒跑（log.retention.check.interval.ms = 300000）──
    + 30s  磁碟   411,390 bytes   p0 earliest=0     p1 earliest=0     p2 earliest=0
    ...
    +150s  磁碟   411,390 bytes   p0 earliest=0     p1 earliest=0     p2 earliest=0
    +180s  磁碟    68,475 bytes   p0 earliest=449   p1 earliest=408   p2 earliest=394
    +210s  磁碟    68,475 bytes   p0 earliest=449   p1 earliest=408   p2 earliest=394
    ...
    +330s  磁碟    68,475 bytes   p0 earliest=449   p1 earliest=408   p2 earliest=394

  📌 設定值 20,480 bytes × 3 個分區 = 61,440 bytes（上限）
     實際 68,475 bytes
```

📌 **三件事**：

1. **`411,390 → 68,475`**，而不是降到 20,480。
   **因為 `retention.bytes` 是「每個分區」的上限** —— 3 個分區 = 3 × 20,480 = 61,440。
2. **`earliest` 從 0 變成 449 / 408 / 394** —— 舊的被刪了、新的留著。
   **這就是 9.5.1 看不到的「顆粒度」**：不是全刪，是刪掉最舊的那幾個 segment。
3. **實際 68,475 比上限 61,440 多一點**，因為**刪除的單位是整個 segment**
   （`segment.bytes=4096`）—— Kafka 不會為了湊到精確的位元組數而切半個檔案。

⚠️ **所以算一個 topic 的磁碟用量，公式是**：

```
   磁碟用量 ≈ retention.bytes × 分區數 × 副本數  + 一個 segment 的餘裕
```

📌 **`replication.factor=3` 的話要再乘 3。**
一個「20 GB」的 topic 設定，在 12 分區 × RF 3 下**實際會吃掉 720 GB**。
⚠️ **這是最常見的容量誤算**。

**兩個保留條件是「或」的關係**：

```
   retention.ms   到期     ┐
                           ├─ 任一成立就刪
   retention.bytes 超過    ┘
```

📌 **正式環境建議兩個都設**：`retention.ms` 決定「業務上要留多久」，
`retention.bytes` 是**磁碟的保險絲** —— 流量暴增時它先動手，免得撐爆磁碟。

### 9.5.3 ⚠️ 消費者落後 + retention 到期 = 無聲的資料遺失

**這是 retention 最危險的一種用法錯誤，而且它跟 [08 章 8.5.1](./08-kafka-consumer-group-and-offset.md)
那個 `auto.offset.reset = latest` 的預設值組合起來特別惡毒。**

```
   T+0     消費者因為某個 bug 卡住，lag 開始成長
   T+3h    lag 到 500 萬，但還在 retention 內 —— 資料都在，修好就能追
   T+8h    ⚠️ 最舊的那些訊息超過 retention，被刪掉了
           而消費者的 committed offset 還停在那些被刪掉的位置上
   T+8h    消費者恢復 → 它要求的 offset 已經不存在
           → OffsetOutOfRangeException
           → 客戶端按照 auto.offset.reset 自動處理：
                latest（預設）  → 跳到最尾端，⚠️ 中間全部跳過，而且 lag 瞬間變 0
                earliest       → 跳到最開頭，⚠️ 把還留著的全部重做一次
                none           → 丟例外，消費者起不來（至少你會知道）
```

⚠️ **用預設的 `latest`，結果是：lag 從 500 萬瞬間變成 0，監控圖上看起來「修好了」** ——
**而那 500 萬則訊息從來沒有被處理，也沒有任何一行日誌提到這件事。**

📌 **這是 [08 章 8.8.1](./08-kafka-consumer-group-and-offset.md) 說的「lag 的第三種假象」。**

**三個防法**：

| 防法 | 做什麼 |
|---|---|
| **① `auto.offset.reset: none`** | 讓它**起不來**，而不是無聲跳過。⚠️ 但新 group 第一次啟動也會失敗，要另外處理 |
| **② retention 要大於「你能容忍的最長故障時間」** | 一個週末沒人值班 = 至少 72 小時。**預設的 7 天是合理的起點** |
| **③ 告警 lag「佔 retention 的比例」** | 比絕對值有意義：lag 對應的時間跨度接近 retention 就該告警 |

⚠️ **②要小心一個陷阱**：`log.retention.hours = 168`（7 天）是 **broker 層級的預設**
（[07 章 7.5.4](./07-kafka-basics-and-producer.md) 印出來過），
**而 [07 章 7.8.1](./07-kafka-basics-and-producer.md) 那個「打錯字自動建出來的 topic」用的就是這個預設。**
你認真建的 topic 可能設了 30 天，自動建出來的那個只有 7 天。

### 9.5.4 怎麼決定 retention

| 問題 | 答案決定什麼 |
|---|---|
| **下游最長可能掛多久？** | retention 的下限（② 的那個數字） |
| **要不要支援「新的消費者補跑歷史」？** | 要的話，retention = 你想補多久 |
| **要不要支援「事故重放」？**（[08 章 8.7](./08-kafka-consumer-group-and-offset.md)） | 要的話，retention >= 你的事故發現週期 × 2 |
| **磁碟有多少？** | `retention.bytes` 的保險絲 |
| **有沒有個資 / 合規要求？** | ⚠️ retention 可能有**上限**，而不只是下限 |

📌 **本站的建議起手式**：

```bash
docker exec kafka-lab /opt/kafka/bin/kafka-configs.sh --bootstrap-server localhost:29092 \
  --alter --entity-type topics --entity-name order.created.v1 \
  --add-config retention.ms=604800000,retention.bytes=10737418240
#                             7 天              每個分區 10 GB（保險絲）
```

⚠️ **改 retention 是 `kafka-configs --alter`，不是改 `NewTopic` 再部署** ——
[07 章 7.9.3](./07-kafka-basics-and-producer.md) 實測過：
`createOrModifyTopics` **不會**改既有 topic 的 retention（但**會**偷偷加分區）。

---

## 9.6 log compaction

### 9.6.1 同一個 key 只留最後一筆

`cleanup.policy` 有兩個值（可以同時用）：

| 值 | 語意 |
|---|---|
| `delete`（預設） | 依時間 / 大小刪掉**最舊的** —— 9.5 講的那個 |
| `compact` | 依 **key** 去重：同一個 key 只留**最後一筆** |
| `compact,delete` | 兩個都做 |

```java
            ac.createTopics(List.of(new NewTopic(T, 1, (short) 1).configs(Map.of(
                    "cleanup.policy", "compact",
                    "segment.bytes", "1024",              // 很小，這樣 segment 會一直滾
                    "min.cleanable.dirty.ratio", "0.01",  // 預設 0.5，調小讓 cleaner 早點動
                    "min.compaction.lag.ms", "0",
                    "delete.retention.ms", "100",
                    "segment.ms", "1000")))).all().get();

        // ORD-A 改 5 次、ORD-B 改 3 次、ORD-C 改 1 次
        for (int i = 1; i <= 5; i++) kafka.send(T, "ORD-A", "state-v" + i).get();
        for (int i = 1; i <= 3; i++) kafka.send(T, "ORD-B", "state-v" + i).get();
        kafka.send(T, "ORD-C", "state-v1").get();
        kafka.send(T, "ORD-B", null).get();     // ← tombstone：ORD-B 被刪掉
        // 再塞 40 則 FILLER 把 segment 推滾（使用中的 segment 不會被壓縮）
```

**輸出**：

```
═══ 9.6.1 log compaction：同一個 key 只留最後一筆 ═══

  ── 壓縮之前（end offset = 50）──
    off0   ORD-A  = state-v1
    off1   ORD-A  = state-v2
    off2   ORD-A  = state-v3
    off3   ORD-A  = state-v4
    off4   ORD-A  = state-v5
    off5   ORD-B  = state-v1
    off6   ORD-B  = state-v2
    off7   ORD-B  = state-v3
    off8   ORD-C  = state-v1
    off9   ORD-B  = (null ← tombstone)
    ...（後面是 40 則 FILLER）

  ── 等 log cleaner 跑過（每 30 秒看一次）──
    + 38s  end offset=50    讀到 43 列，其中 ORD-A 有 1 列

  ── 壓縮之後，把 ORD-* 的部分讀出來 ──
    off4   ORD-A  = state-v5
    off8   ORD-C  = state-v1
    off9   ORD-B  = (null ← tombstone)

    end offset 還是 50 —— ⚠️ 位移不會因為壓縮而變小
```

📌 **先說那個「38 秒」：它不是 `log.retention.check.interval.ms`（5 分鐘）。**
compaction 走的是另一條路，另一組設定：

```
  log.cleaner.enable                         = true
  log.cleaner.backoff.ms                     = 15000
  log.cleaner.min.cleanable.ratio            = 0.5
  log.cleaner.delete.retention.ms            = 86400000
  log.cleaner.min.compaction.lag.ms          = 0
```

⚠️ **`delete` 與 `compact` 是兩個不同的背景執行緒、兩組不同的設定、兩個不同的節奏**
（15 秒 vs 5 分鐘）。**不要把 9.5 學到的時間感套到這一節。**

📌 **四件事**：

1. **`ORD-A` 的 5 個版本變成 1 個**，留下的是**最後那一筆**（`state-v5`）。
2. **留下來的 offset 是 `4`，不是 `0`。** 壓縮**保留原本的 offset**，所以壓縮後的 log
   **offset 是不連續的**（4, 8, 9, 10, 11 …）。
   ⚠️ **消費者必須能接受「offset 有洞」** —— 正常的消費者本來就可以，
   但如果你自己寫了「offset 應該連續」的檢查邏輯，它會在這裡爆炸。
3. **`end offset` 還是 50。** 壓縮不會讓位移倒退 —— [00 章 0.4.2](./00-course-map-why-message-queue.md)
   那句「offset 是固定的、單調遞增的、永遠不變的」仍然成立。
4. **`ORD-B` 剩下一個 `null`** —— 那是 **tombstone**（墓碑）。

### 9.6.2 tombstone 與兩個「不會被壓縮」的東西

📌 **tombstone = value 是 `null` 的訊息**，意思是「這個 key 被刪除了」。

```java
        kafka.send(T, "ORD-B", null).get();     // ← 刪掉 ORD-B
```

壓縮時，tombstone 會**吃掉這個 key 之前的所有版本**，
然後**它自己再留一段時間**（`delete.retention.ms`，預設 86400000 = 1 天）才消失。

⚠️ **那一天的緩衝期是必要的**，理由很實際：

```
   一個落後的消費者，如果在 tombstone 被刪掉之後才讀到這一段，
   它會完全不知道 ORD-B 被刪過 —— 它的本地快取裡會永遠留著一筆已刪除的資料。
   delete.retention.ms 就是「保證落後的消費者也看得到刪除事件」的時間窗。
```

📌 **所以 `delete.retention.ms` 的正確值是「你的消費者最久可能落後多少」** ——
跟 9.5.3 的 retention 是同一個思考。

**兩個「不會被壓縮」的東西**：

| 不會被壓縮的 | 為什麼 |
|---|---|
| **使用中的 segment**（active segment） | 它還在被寫入。⚠️ **這就是為什麼 9.6.1 要多送 40 則 FILLER 把它推滾** |
| **`min.compaction.lag.ms` 之內的訊息** | 預設 0，但設了之後可以保證「最近 N 分鐘的訊息一定讀得到完整版本」 |

⚠️ **第一列值得單獨證明一次**，因為它是「compacted topic 看起來壞掉了」最常見的原因。
把 `segment.bytes` 設成 1 GB（**保證不會滾**），其他跟 9.6.1 一樣：

```
═══ 稽核 G：segment 大到不會滾的 compacted topic，還會被壓縮嗎 ═══
  cleanup.policy=compact，但 segment.bytes=1 GB → 所有訊息都在「使用中的 segment」裡

  送了 ORD-A 的 8 個版本，立刻讀：8 列
    + 38s  讀到 8 列
    + 76s  讀到 8 列
    +114s  讀到 8 列
    +152s  讀到 8 列
    +190s  讀到 8 列
    +228s  讀到 8 列

  📌 對照 9.6.1（segment.bytes=1024，有滾動）：那裡 38 秒就壓成 1 列
```

📌 **228 秒，一則都沒有被壓縮。**
同樣的 `cleanup.policy=compact`、同樣的 `min.cleanable.dirty.ratio=0.01` ——
**差別只有 segment 有沒有滾。**

> ⚠️ **所以「我開了 compact，但同一個 key 還是有好幾筆」的第一個檢查動作是**：
> **你的 segment 滾了嗎？**
>
> ```bash
> docker exec kafka-lab sh -c 'ls /tmp/kafka-logs/<topic>-0/*.log'
> ```
>
> **只有一個 `.log` 檔 = 只有使用中的 segment = 永遠不會被壓縮。**
> 📌 **低流量的 compacted topic 一定要把 `segment.ms` 設小**（例如 1 小時），
> 否則它要等預設的 **7 天**才滾一次。

⚠️ **另外，`min.cleanable.dirty.ratio` 預設是 `0.5`** ——
意思是「**髒的部分要超過一半**，cleaner 才願意動」。
📌 **所以一個「更新很少」的 compacted topic，可能很久都不會被壓縮** ——
那不是壞掉，那是設計。9.6.1 把它調成 `0.01` 就是為了讓實驗跑得完。

### 9.6.3 `__consumer_offsets` 就是一個 compacted topic

[08 章](./08-kafka-consumer-group-and-offset.md) 從頭到尾都在用它。**看看它自己的設定**：

```
═══ 9.6.3 __consumer_offsets 自己的設定 ═══
  cleanup.policy               = compact
  segment.bytes                = 104857600
  retention.ms                 = 604800000
  min.cleanable.dirty.ratio    = 0.5
  compression.type             = producer
  分區數                       = 50
```

📌 **這是 compaction 最好的範例**：

```
   key   = (group.id, topic, partition)
   value = 已提交的位移
   ────────────────────────────────────────
   一個 consumer group 每秒提交好幾次 → 同一個 key 有幾百萬筆
   但你只需要「最後一筆」 → 完美符合 compaction
```

⚠️ **`分區數 = 50` 是 `offsets.topic.num.partitions` 的預設值**，
而**一個 group 的位移全部落在同一個分區上**（用 `group.id` 雜湊）——
那個分區的 leader 就是這個 group 的 **coordinator**。
📌 **這解釋了 [08 章 8.8.3](./08-kafka-consumer-group-and-offset.md) 那個 16,923 ms**：
broker 重啟時，coordinator 也要跟著重新選出來、重新載入位移。

### 9.6.4 什麼時候用 compaction

| 適合 | 不適合 |
|---|---|
| **最新狀態的快照**（每個 orderId 的目前狀態） | ⚠️ **事件流**（你需要「發生過什麼」，不只是「現在是什麼」） |
| 設定檔 / 特徵值 / 使用者資料的複寫 | 稽核紀錄（⚠️ 舊版本會被吃掉） |
| 「新的消費者啟動時要建一份完整快取」 | 純粹的度量 / 日誌 |

⚠️ **三個使用前提**：

1. **訊息一定要有 key。** 沒有 key 的訊息在 compacted topic 上**不會被壓縮**，
   而且它讓整個設計失去意義。
2. **消費者要能接受 offset 不連續**（9.6.1 第 2 點）。
3. **「重讀全部」得到的是「現在的狀態」，不是「歷史」** ——
   如果你的重放邏輯需要按順序重播每一次變更，**compaction 會毀掉它**。

📌 **可以兩個一起用**：`cleanup.policy=compact,delete` ——
「同一個 key 只留最新的，**而且**超過 30 天的連最新的也刪掉」。
適合「狀態快照 + 有生命週期的實體」（例如已完成三個月的訂單）。

---

## 9.7 把 Kafka 當事件來源

[00 章 0.9.3](./00-course-map-why-message-queue.md) 說「本站只把 Kafka 當**訊息傳輸**用，
09 章會提一句『把 Kafka 當事件來源』的取捨，然後就停在那裡」。**這就是那一句。**

**Event Sourcing** 的意思是：**不存「現在的狀態」，只存「發生過的每一件事」**，
狀態是把事件重播一遍算出來的。Kafka 看起來天生適合它（不可變、append-only、可重讀）。

⚠️ **但這一章已經給了三個理由說明它不是一個現成的 event store**：

| Kafka 的東西 | event store 需要的 | 衝突 |
|---|---|---|
| retention（9.5） | **永久保存** | 預設 7 天就刪光了。要永久保存得關掉 retention，而那是一個很大的維運承諾 |
| compaction（9.6） | 保留**每一次**變更 | compaction 會吃掉歷史版本 —— **兩者互斥** |
| 分區內有序（[07 章 7.3](./07-kafka-basics-and-producer.md)） | 依 **aggregate** 讀取全部事件 | 只能讀整個分區再自己過濾，**沒有「讀某個 aggregate 的事件」這種查詢** |

📌 **一句話**：
**Kafka 是很好的事件「傳輸」層，但它不是事件「儲存」層。**
真的要做 event sourcing，業界的做法是用專門的 event store（或一張資料庫表）當真相來源，
**再把事件發到 Kafka 給別人消費** —— 那正好就是 [02 章的 Outbox](./02-outbox-and-transactional-consistency.md)。

**就停在這裡。** 這個題目要講完需要另一站的篇幅，不在本課範圍。

---

## 9.8 常見誤區

**① 「冪等 producer 保證同一則訊息只會進去一次」**

⚠️ **它保證的是「同一個 producer session 內的重送」只會進去一次。**
9.2.4 實測：關掉 producer、開一個新的、送一模一樣的內容 → **broker 上兩份**
（`producerId` 1004 與 1005，兩個都是 `sequence: 0`）。

**② 「冪等 producer 沒什麼用，反正我沒看過重送」**

⚠️ **9.2.2 實測：`request.timeout.ms=5` 時，送 4,000 則變成 broker 上 29,694 則。**
關掉冪等 = 每一則平均被寫 7.4 次。
📌 **它平常完全不做事，只在真的發生重送的那一刻有價值 —— 而那一刻你無法預測。**

**③ 「`enable.idempotence` 不用設，反正 3.0 之後預設是 true」**

⚠️ **只要你動了 `acks` 或 `retries` 而沒有明確寫它，Kafka 會安靜地把它關掉**
（[01 章 1.3.5](./01-reliable-delivery-three-hops.md) 那張表，日誌裡一行都沒有）。

**④ 「用了 Kafka 交易就是 exactly-once 了」**

⚠️ **只有「Kafka → Kafka」那一段是。** 9.4.2 實測 Kafka → MySQL：
**A 重複 400 元、B 漏掉 400 元**，只有「冪等寫入」是對的。
📌 **而「你的處理函式只會跑一次」從來就不成立** —— 交易保證的是「輸出不會被看到」，不是「不會執行」。

**⑤ 「消費者用預設設定讀交易型 topic 沒問題」**

⚠️ **`isolation.level` 的預設是 `read_uncommitted`。**
9.3.2 實測：一個被 `abortTransaction()` 的交易，**預設設定的消費者看得到那三則被回滾的訊息**。

**⑥ 「abort 之後那些訊息就不見了」**

⚠️ **它們還躺在 log 上**（9.3.2 的 dump：offset 4、5、6）。
Kafka 的 log 是 append-only，**「回滾」只是多寫一個 `endTxnMarker: ABORT`**。

**⑦ 「交易型 topic 上，lag 漲了就是消費者跟不上」**

⚠️ **不一定。** 9.3.2 實測：一個**還沒 commit 的交易**會把 `read_committed` 的消費者
擋在 LSO 前面 —— **讀到 0 則、LAG=10，而消費者完全是閒的。**
📌 **（順帶一提：控制訊息雖然佔 offset，但消費者的 position 會跳過它們，
所以追平時 lag 仍然是 0。）**

**⑧ 「交易很貴，所以不要用」/「交易很便宜，所以隨便用」**

⚠️ **兩句都錯，因為代價不在交易本身，在 commit 的頻率。**
9.3.4 實測：整段只 commit 一次 → **量不出成本**；每 1,000 則 → **4～6 倍**；
每 100 則 → **掉一個數量級**。

**⑨ 「`ChainedTransactionManager` 可以把 Kafka 跟資料庫湊成一個交易」**

⚠️ **它做的是「依序提交」，不是「原子提交」。**
它把 9.4.2 那個縫**變窄**，沒有消滅它 —— 而更窄的縫更難在測試環境發現。
（它在 Spring 5.3 已經 `@Deprecated`。）

**⑩ 「我設了 `retention.ms=1000`，訊息應該馬上就會消失」**

⚠️ **9.5.1 實測：整整 270 秒什麼都沒發生，第 300 秒一次全刪。**
`log.retention.check.interval.ms` 的預設值是 **300000**。

**⑪ 「`retention.bytes=20GB` 就是這個 topic 最多佔 20 GB」**

⚠️ **它是「每個分區」的。** 9.5.2 實測：設 20,480、3 個分區 → 實際 68,475 bytes。
📌 **公式是 `retention.bytes × 分區數 × 副本數`** ——
12 分區 × RF 3 的話，「20 GB」實際是 **720 GB**。

**⑫ 「消費者落後沒關係，修好就會自己追上」**

⚠️ **超過 retention 就追不回來了，而且是無聲的。**
配上 `auto.offset.reset` 的預設值 `latest`，結果是
**lag 從 500 萬瞬間變成 0，而那些訊息從來沒有被處理過**（9.5.3）。

**⑬ 「compaction 可以拿來省磁碟」**

⚠️ **它會吃掉歷史版本。** 如果你需要的是「發生過什麼」而不只是「現在是什麼」，
compaction 會**毀掉你的資料**，而且救不回來。
📌 **要省磁碟請用 `retention.bytes`。**

**⑭ 「compacted topic 上同一個 key 永遠只有一筆」**

⚠️ **不一定。** 使用中的 segment 不會被壓縮、`min.cleanable.dirty.ratio`（預設 **0.5**）
沒達標也不會壓縮。📌 **消費者必須能處理「同一個 key 讀到多筆」。**

---

## 9.9 本章小結

**這一章量了六件事**：

1. **冪等 producer 的指紋是 `producerId` + `sequence`**（9.2.1）：
   開著是 `1006 / 0,1,2`，關掉是 `-1 / -1`。
2. **它真的擋得住重送，而且量級很大**（9.2.2）：
   `request.timeout.ms=5` 時，送 4,000 則 →
   **關掉冪等 broker 上 29,694 則、開著 4,000 則**。
   ⚠️ **但它只保證單一 session**（9.2.4）：換一個 producer 送同樣的內容 → **兩份**。
3. **`isolation.level` 的預設是 `read_uncommitted`**（9.3.2）：
   被 `abortTransaction()` 的三則訊息，**預設設定的消費者看得到**。
   而它們**就躺在 log 的 offset 4、5、6 上** —— 回滾不刪任何東西，只多寫一個 `ABORT` 標記。
   ⚠️ 而一個**還開著**的交易會把 `read_committed` 擋在 LSO 前面：
   **讀到 0 則、LAG=10，消費者卻完全是閒的。**
4. **交易的代價在 commit 的頻率**（9.3.4）：
   整段只 commit 一次**量不出成本**、每 1,000 則 **4～6 倍**、
   每 100 則 **掉一個數量級**（兩次分別是 28.10x 與 15.75x —— ⚠️ 只能引用量級，不能引用單一數字）。
5. **「精確一次」跨不出 Kafka**（9.4.2）：
   300 則入帳事件、當掉 2 次 →
   **先寫庫後提交位移 = 3,400 元（多 400）**、
   **先提交位移後寫庫 = 2,600 元（少 400）**、
   **冪等寫入 = 3,000 元 ✅**。
6. **retention 不是「到期就刪」**（9.5）：
   設 10 秒，**270 秒毫無動靜、第 300 秒一次全刪**（`log.retention.check.interval.ms=300000`）。
   而 `retention.bytes` 是**每個分區**的：設 20,480 × 3 分區 → 實際 68,475 bytes。

📌 **[01 章 1.6](./01-reliable-delivery-three-hops.md) 那個問題，到這裡完整收尾**：

```
   at-most-once     先確認再處理          → 9.4.2 寫法 B：漏掉 400 元
   at-least-once    先處理再確認          → 9.4.2 寫法 A：重複 400 元
   exactly-once     Kafka → Kafka 可以    → 9.3.3（sendOffsetsToTransaction）
                    跨出去就不行          → 9.4.2、9.4.3
   ──────────────────────────────────────────────────────────────
   唯一可行的路線   at-least-once + 冪等消費 → 9.4.2 寫法 C ✅
```

📌 **Kafka 三章（07～09）的設定總表**：

```
   生產者   acks=all + RF≥3 + min.insync.replicas=2 + enable.idempotence   （7.5、9.2）
            key = aggregateId、whenComplete 接住失敗                        （7.3、7.9）
   消費者   enable-auto-commit=false + ack-mode BATCH                       （8.4）
            max.poll.records 決定重複半徑、max.poll.interval.ms 要夠大       （8.3、8.5）
            isolation.level=read_committed（讀交易型 topic 時）               （9.3）
   topic    分區數 = 峰值消費者 × 2、retention.ms + retention.bytes 都設      （7.7、9.5）
   仍然防不住  重複 → 冪等消費（03 章）、送出前掛掉 → Outbox（02 章）
```

### 9.9.1 驗收清單

做得到才往下走：

- [ ] 從 `kafka-dump-log` 的輸出判斷一則訊息有沒有冪等保護，並指出是哪兩個欄位。
- [ ] 說出 broker 去重時用的鍵是什麼（三個部分）。
- [ ] 解釋 9.2.2 裡「`request.timeout.ms=15` 時兩種設定都是 4,000」代表什麼。
- [ ] 解釋 9.2.2 裡「`送出 = 0` 但 broker 上有 27,131 則」是怎麼回事。
- [ ] 說出冪等 producer 為什麼會強制 `max.in.flight <= 5`。
- [ ] 說出「key 保證什麼、冪等 producer 保證什麼」在順序這件事上的分工。
- [ ] 說出冪等 producer 的邊界，並舉一個 [02 章](./02-outbox-and-transactional-consistency.md) 裡會撞到它的具體場景。
- [ ] 列出 `enable.idempotence=true` 強制的三個設定與各自的錯誤訊息。
- [ ] 說出 `isolation.level` 的預設值，以及用預設值讀交易型 topic 的後果。
- [ ] 解釋為什麼 9.3.2 的實驗一定要 `flush()` 才量得到差別。
- [ ] 從 log dump 指出 `endTxnMarker`，並說出「6 則訊息 end offset = 8」的原因。
- [ ] 說出「一個還沒 commit 的交易」會對下游的 `read_committed` 消費者做什麼，以及它在監控上長什麼樣。
- [ ] 說出為什麼「控制訊息佔了 offset」**不會**讓追平的 group 的 lag 大於 0。
- [ ] 說出 `sendOffsetsToTransaction` 做了什麼，以及它為什麼只能在 Kafka 內部成立。
- [ ] 解釋「exactly-once 不代表你的處理函式只會跑一次」。
- [ ] 說出交易的代價跟什麼成正比，並說出「commit 間隔」同時決定的另外兩件事。
- [ ] 說出 9.3.4 那張表為什麼**不能**引用「28 倍」這個單一數字。
- [ ] 說出 `transactional.id` 該怎麼取，以及為什麼在 K8s 上通常要用 StatefulSet。
- [ ] 說出 `initTransactions()` 做的三件事。
- [ ] 畫出 9.4.2 三種寫法的時間線，並指出當掉的那一刻各自留下什麼。
- [ ] 說出 `ChainedTransactionManager` 為什麼不算答案。
- [ ] 說出一個完整系統的三條路線各自解決哪個方向的問題，以及哪一條非有不可。
- [ ] 說出「訊息什麼時候真的消失」取決於哪三個設定。
- [ ] 解釋 9.5.1 那個「270 秒沒動靜、第 300 秒全刪」。
- [ ] 說出 `segment.bytes` 在 `delete` 策略下實際影響什麼。
- [ ] 算出「`retention.bytes=20GB`、12 分區、RF=3」實際會用掉多少磁碟。
- [ ] 說出 `retention.ms` 與 `retention.bytes` 是「且」還是「或」的關係。
- [ ] 描述「消費者落後超過 retention」在 `auto.offset.reset` 三種值下各自的結果。
- [ ] 說出為什麼那個故障是無聲的，以及三個防法。
- [ ] 說出 compaction 之後 offset 為什麼會不連續，以及什麼樣的程式會因此爆炸。
- [ ] 說出 tombstone 是什麼，以及 `delete.retention.ms` 那段緩衝期在保護誰。
- [ ] 說出兩個「不會被壓縮」的東西，並說出「compacted topic 沒被壓縮」的第一個檢查動作。
- [ ] 說出 `segment.ms` 的預設值，以及它為什麼會讓實際留存時間超過 `retention.ms`。
- [ ] 說出 `delete` 與 `compact` 兩條清理路徑各自的節奏（哪個 15 秒、哪個 5 分鐘）。
- [ ] 說出 `min.cleanable.dirty.ratio` 的預設值，以及它造成的常見困惑。
- [ ] 說出 `__consumer_offsets` 為什麼適合 compaction，以及它的分區數跟 coordinator 的關係。
- [ ] 說出 compaction 的三個使用前提。
- [ ] 說出把 Kafka 當 event store 的三個衝突。

### 9.9.2 本章練習

**練習一（25 分鐘）**：重跑 9.2.2，但把 `request.timeout.ms` 掃過 `2 / 3 / 8 / 10 / 20`。
**記錄每一組的「broker 上有幾則」。**
然後回答：在你這台機器上，**重送開始發生的門檻是幾毫秒**？
把它跟你正式環境的網路延遲比一比 —— **那個門檻在正式環境是多少？**

**練習二（20 分鐘）**：重現 9.2.4，但這次用 `transactional.id`（固定同一個值）。
兩個 session 各送一則一模一樣的訊息，**記錄 broker 上有幾則**。
然後回答：交易解決了這個問題嗎？**如果沒有，為什麼？**
（提示：想想「一模一樣的內容」跟「同一筆交易」是不是同一件事。）

**練習三（25 分鐘）**：重跑 9.3.2，但在 `abortTransaction()` 之後**再開一個交易並 commit**。
用 `read_committed` 讀，**記錄你看到哪些 offset**。
然後回答：`read_committed` 的消費者要怎麼知道 offset 4~6 該跳過？
**它是在讀到那些訊息之前就知道，還是之後？** 這對延遲有什麼影響？

**練習四（30 分鐘）**：把 9.3.3 的 consume-transform-produce 改成
**每 10 則 commit 一次**，然後在第 3 次交易的**中途** `kill -9`。
重啟之後，**記錄**：① 輸出 topic 有幾則、② 輸入 topic 的已提交位移、
③ 用 `read_committed` 讀輸出 topic 看到幾則。
**驗證「沒有任何一則被 read_committed 的消費者看到兩次」。**

**練習五（30 分鐘）**：重跑 9.4.2，但把當掉的批次改成 **5 次**，每批改成 **50 則**。
**記錄三種寫法的誤差量**，並驗證它等於「當掉次數 × 每批則數」。
然後把寫法 C 的 `ON DUPLICATE KEY` 換成 [03 章的去重表](./03-idempotent-consumer.md)做法，
**驗證結果一樣正確**，並比較兩者的效能。

**練習六（進階，40 分鐘）**：重跑 9.5.1，但這次**讓訊息的時間戳分散**：
送 100 則、每則間隔 2 秒（總共約 3.5 分鐘），`retention.ms` 設 60000。
**記錄 `earliest` 每 30 秒的變化。**
然後回答：這次看得到「顆粒度」的差別了嗎？**`segment.bytes` 大小造成什麼差異？**

**練習七（進階，30 分鐘）**：重現 9.5.3 那個無聲遺失：
1. 建一個 `retention.ms=60000` 的 topic，持續送訊息。
2. 起一個消費者讀一小段，然後**停掉它**。
3. 繼續送 2 分鐘，讓消費者的已提交位移「過期」。
4. 用 `auto.offset.reset` 的三種值各起一次消費者，
   **記錄三種情況下的 lag、日誌、以及「它從哪裡開始讀」。**
5. **寫一句話**說明為什麼 `latest` 是最危險的。

**練習八（進階，30 分鐘）**：把 9.6.1 的 topic 改成 `cleanup.policy=compact,delete`
並加上 `retention.ms=120000`。送同樣的資料，等 10 分鐘。
**記錄**：`ORD-A` 的最新版本還在嗎？**為什麼？**
然後回答：什麼樣的業務適合這個組合？

**練習九（綜合，90 分鐘）**：**Kafka 三章的總驗收，也是
[11-messaging README](./README.md) 那份「產出」第 2 項的 Kafka 版本。**

把 [02 章的 Outbox](./02-outbox-and-transactional-consistency.md)、
[03 章的冪等](./03-idempotent-consumer.md)、07～09 章的設定全部接起來：

1. `placeOrder()` 在同一個交易裡寫 `orders` 與 `outbox`。
2. 輪詢器用 `SKIP LOCKED` 撈出來，**key = `aggregate_id`**，用 `whenComplete` 接住結果。
3. topic：6 分區、RF=3、`min.insync.replicas=2`、`retention.ms=7天`、`retention.bytes` 保險絲。
4. 消費者：`concurrency=3` × 2 個實例、`ack-mode BATCH`、`max-poll-records=50`、**冪等寫入 MySQL**。
5. **演練六種故障**，每一種都記錄「最終資料對不對」：
   - 輪詢器在 callback 回來之前 `kill -9`（9.2.4 的邊界）
   - `docker stop kafka2`（RF=3/minISR=2 應該還能寫，7.5.3）
   - `docker stop kafka2 kafka3`（ISR 不足，7.9.1）
   - 一個消費者實例在處理一批的中途 `kill -9`（8.3.1）
   - 一則訊息讓處理超過 `max.poll.interval.ms`（8.5.3）
   - `docker restart kafka-lab`（8.8.3）
6. **最終驗收**：1,000 張訂單 → topic 上 >= 1,000 則、資料庫 **正好 1,000 列**、
   去重表擋掉的次數 **> 0**。

📌 **第 6 點那個「topic 上 >= 1,000 則」不是打錯字** ——
**傳輸層本來就會重複**（9.2.4、8.3.1），而你的系統應該擋住它。
**「資料庫正好 1,000 列」才是驗收標準。**

---

## 9.10 下一章預告

**Kafka 三章結束了。** 你現在會：

- topic / partition / offset / replica、key 與順序、`acks` 與 ISR、批次與壓縮（07 章）。
- consumer group、rebalance、提交時機、兩個逾時、併發、重放（08 章）。
- 冪等 producer、交易與 `read_committed`、exactly-once 的邊界、retention 與 compaction（09 章）。

**但這六章（04～09）裡，有三件事兩邊都刻意留到最後**：

**一、毒藥訊息。**
RabbitMQ 有 DLX（[06 章 6.2](./06-rabbitmq-retry-delay-and-cluster.md)：
把那場風暴從 11,191 次變成 1 次）。
**Kafka 沒有** —— [08 章 8.4.3](./08-kafka-consumer-group-and-offset.md) 實測過：
位移是一個數字，你只能「停在它前面」或「跳過它」。
📌 **10 章會把「重試主題階梯 + 死信主題」完整做出來**，
那是 Kafka 這一側對 [06 章 6.3](./06-rabbitmq-retry-delay-and-cluster.md) 退避階梯的回答。

**二、`traceId` 跨 MQ。**
這六章的每一個實驗，出事時你都是靠「印出來的數字」在追。
**正式環境沒有那些 `System.out.printf`。**
📌 **10 章會把 `traceId` 塞進訊息 header，讓一個請求的鏈條跨過 broker 接回去。**

**三、監控。**
[08 章 8.8](./08-kafka-consumer-group-and-offset.md) 給的是 CLI 與「臨時查一下」等級的工具，
並且說了「正式環境的 lag 監控要用常駐的 exporter，10 章會講」。
⚠️ **而這一章又多了一個要監控的東西**：9.5.3 那個「lag 對應的時間跨度接近 retention」。

📌 **一句話預告 10 章**：

> **04～09 章教你把訊息「送對、收對、不漏、不重」。**
> **10 章教你在它還是出事的時候，找得到它在哪裡。**
