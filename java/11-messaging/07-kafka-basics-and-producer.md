# 第 07 章：Kafka 模型與生產者

> [06 章 6.12](./06-rabbitmq-retry-delay-and-cluster.md) 留下一個 RabbitMQ 三章都答不好的問題：
>
> > **「同一個 orderId 的事件要有序，但不同訂單之間可以並行。」**
>
> RabbitMQ 給的三條路都很貴：單一活躍消費者（吞吐鎖死在一條執行緒）、
> 業務層版本號（每個消費者自己寫）、`x-consistent-hash` 分片（裝外掛 + 擴容時 13% 的 key 搬家）。
> [05 章 5.5.6](./05-rabbitmq-reliability.md) 當時說：**「那其實就是自己做一個陽春版的 Kafka。」**
>
> **這一章把那句話兌現。** 7.3.2 用跟 [05 章 5.5.2](./05-rabbitmq-reliability.md)
> **完全相同的場景**（200 張訂單 × 3 個事件、每則處理 1～20 ms）在 Kafka 上跑一次：
>
> ```
>   消費者  1 個  →   79 則/秒   最終狀態錯掉的訂單 0 / 200
>   消費者  2 個  →  156 則/秒   最終狀態錯掉的訂單 0 / 200   （1.97x）
>   消費者  4 個  →  239 則/秒   最終狀態錯掉的訂單 0 / 200   （3.00x）
>   消費者  6 個  →  428 則/秒   最終狀態錯掉的訂單 0 / 200   （5.38x）
>   消費者  8 個  →  402 則/秒   最終狀態錯掉的訂單 0 / 200   （5.05x ← 沒有變快）
> ```
>
> **同一個場景，RabbitMQ 在 `concurrency=4` 時有 49% 的訂單最終狀態是錯的。**
> Kafka 在 6 個消費者、5.38 倍吞吐下，**錯 0 張**。
> 這不是因為 Kafka 比較高級，是因為**它把「順序的單位」變成一個你可以選的東西**：key。
>
> ---
>
> 但這一章要講的不只是好消息。它還要量四件**代價**：
>
> **一、最後那一列 `8 個消費者 = 5.05x`，不是量測誤差。**
> topic 只有 6 個分區，第 7、8 個消費者**完全沒有分到東西**。
> 7.4 會把這件事推到極端：**同樣 6 台機器，分區數從 6 改成 1，吞吐從 387 則/秒掉到 78 則/秒**
> —— 這就是[00 章 0.11.2](./00-course-map-why-message-queue.md) 要你先自己想的那個代價：**5 倍**。
>
> **二、`linger.ms=100` 這一行設定，可以讓你的吞吐從 3,795 則/秒變成 9 則/秒。**
> 7.6 實測，而且**同一個參數在另一種寫法下完全無害**。
> [00 章 0.11.2](./00-course-map-why-message-queue.md) 說「你要親眼看到延遲與吞吐是同一個旋鈕的兩端」—— 7.6 就是那張表。
>
> **三、`min.insync.replicas=2` 這個設定，在 RF=3 與 RF=2 上是兩件完全不同的事。**
> 7.5.3 實測：**同樣掉一台 broker，RF=3 的照常寫入，RF=2 的 100% 被拒絕。**
> 而 [01 章 1.3.7](./01-reliable-delivery-three-hops.md) 已經證明過 RF=1 的那一種更糟 —— 它假裝沒事。
>
> **四、分區數是一個幾乎改不回去的決定。**
> 7.7 實測：3 個分區加到 6 個，**12 個 key 裡有 8 個換了分區（67%）**，
> 而且**已經在跑的 producer 還會用舊的分區數繼續送 5 分鐘**。
> 分區只能加不能減 —— `InvalidPartitionsException`，這是實際的錯誤訊息。

---

## 7.1 學習目標

完成本章後，你應該可以：

- 說出 topic / partition / offset / replica 各自是什麼，並解釋「位移是每個分區各自的」有什麼後果（7.2）。
- 讀懂 `kafka-topics --describe` 的 `Leader` / `Replicas` / `Isr` 三欄，以及 console consumer 的每一個欄位（7.2）。
- 手算一個 key 會落在哪個分區，並驗證它跟 broker 算的一樣（7.3.1）。
- 說出「key 決定分區、分區決定順序」的完整推論鏈，以及**並行度的上限是什麼**（7.3、7.4）。
- 說出「不給 key」的**兩個**代價（不只是順序）（7.3.3）。
- 量化「把分區數設成 1 來保證全域順序」的吞吐代價（7.4）。
- 說出 `acks` 三個值各自的承諾、各自的吞吐代價，以及 `acks=all` 到底在等誰（7.5）。
- 解釋 `min.insync.replicas` 的語意，並算出 RF 與它的組合各自能容忍幾台機器掛掉（7.5.3）。
- 說出 ISR 收縮的兩個時間尺度，以及「關機」與「當機」為什麼不一樣（7.5.2）。
- 用 `batch.size` / `linger.ms` / `compression.type` 調出你要的延遲與吞吐，並說出**同一個參數在同步送與非同步送下方向相反**（7.6）。
- 說出「訊息太大」時 producer / broker / consumer 三端各自的上限，以及只改一端會怎樣（7.6.7）。
- 說出「加分區」會破壞什麼、什麼時候可以做、要怎麼做（7.7）。
- 說出 `auto.create.topics.enable=true` 的三個具體危害，以及為什麼它**不能動態關掉**（7.8）。
- 用 `KafkaTemplate` 寫出一個**知道自己失敗了**的生產者（7.9）。

---

## 7.2 四個名詞

Kafka 的模型只有四個名詞，但**每一個都跟 RabbitMQ 的對應物不太一樣**，
所以先花一節把它們釘死。

| 名詞 | 一句話 | RabbitMQ 裡最接近的東西 | 但不一樣的地方 |
|---|---|---|---|
| **topic** | 一個具名的事件流 | queue（勉強） | topic **不是**一個佇列，它是一群分區的集合 |
| **partition** | 一個**有序、只能往後append** 的檔案 | ⚠️ **沒有對應物** | 這是 Kafka 獨有的層級，也是這一章的重點 |
| **offset** | 一則訊息在**它那個分區裡**的行號 | `delivery_tag`（勉強） | offset **永遠不變**，而且不會因為被讀走而消失 |
| **replica** | 同一個分區在另一台 broker 上的副本 | quorum queue 的成員 | Kafka 的副本是**分區層級**的，不是佇列層級 |

📌 **一句話版本**：
**topic 是名字，partition 是真正存東西的地方，offset 是行號，replica 是備份。**

### 7.2.1 一則訊息落在哪裡

先把「送一則訊息」這件事完整攤開。建一個三分區的 topic，送六則、三個不同的 key：

```java
package com.example.lab11.ch07;

import com.example.lab11.MsgProbe;
import org.apache.kafka.common.utils.Utils;
// ... 其餘 import 見完整檔案

@SpringBootTest
class I1AnatomyTest {

    @Autowired MsgProbe probe;
    @Autowired KafkaAdmin kafkaAdmin;
    @Autowired KafkaTemplate<String, String> kafka;

    static final String T = "ch07.anatomy.v1";

    @Test
    void anatomy() throws Exception {
        cleanup(T);
        kafkaAdmin.createOrModifyTopics(TopicBuilder.name(T).partitions(3).replicas(1).build());
        Thread.sleep(500);

        System.out.println("═══ 7.2.1 一則訊息落在哪裡：key → 分區 → 位移 ═══");
        String[] keys = {"ORD-1001", "ORD-1002", "ORD-1003", "ORD-1001", "ORD-1002", "ORD-1001"};
        for (int i = 0; i < keys.length; i++) {
            var md = kafka.send(T, keys[i], "event-" + (i + 1)).get().getRecordMetadata();
            // 自己用 Kafka 的分區公式算一次，跟 broker 回報的比對
            int hand = Utils.toPositive(Utils.murmur2(keys[i].getBytes())) % 3;
            System.out.printf("  送 %-10s value=event-%-2d → 分區 p%d  位移 off%d   （手算 murmur2 %% 3 = %d %s）%n",
                    keys[i], i + 1, md.partition(), md.offset(), hand, hand == md.partition() ? "✅" : "❌");
        }
        probe.topicShape(T);
    }
}
```

**輸出**：

```
═══ 7.2.1 一則訊息落在哪裡：key → 分區 → 位移 ═══
  送 ORD-1001   value=event-1  → 分區 p1  位移 off0   （手算 murmur2 % 3 = 1 ✅）
  送 ORD-1002   value=event-2  → 分區 p0  位移 off0   （手算 murmur2 % 3 = 0 ✅）
  送 ORD-1003   value=event-3  → 分區 p2  位移 off0   （手算 murmur2 % 3 = 2 ✅）
  送 ORD-1001   value=event-4  → 分區 p1  位移 off1   （手算 murmur2 % 3 = 1 ✅）
  送 ORD-1002   value=event-5  → 分區 p0  位移 off1   （手算 murmur2 % 3 = 0 ✅）
  送 ORD-1001   value=event-6  → 分區 p1  位移 off2   （手算 murmur2 % 3 = 1 ✅）
  [kafka ] ch07.anatomy.v1    分區=3   總訊息數=6        p0=2 p1=3 p2=1
```

📌 **六個 `✅` 的意思是：分區不是 broker 挑的，是 producer 在你的行程裡算出來的。**

```
partition = murmur2(key 的 bytes) 取正數 % 分區數
```

**這件事有三個後果，而它們是後面所有內容的基礎**：

1. **同一個 key 永遠進同一個分區** —— 不管哪一台機器送、不管什麼時候送。
2. **broker 完全沒有參與這個決定。** 所以你不需要問 broker「這個 key 該去哪」，
   producer 拿到 metadata（有幾個分區）之後自己就能算。
3. ⚠️ **分區數是公式的一部分。** 分區數一變，同一個 key 的答案就變了 —— **這就是 7.7 整節在講的事。**

### 7.2.2 位移是「每個分區各自」的

```java
    // 同一支測試的第二段：把剛剛那六則讀回來
    try (KafkaConsumer<String, String> c = new KafkaConsumer<>(cfg)) {
        c.subscribe(List.of(T));
        // ... poll 到六則為止，格式化成 "p? off? key=? value=? ts=?"
    }
```

**輸出**（依 `分區, 位移` 排序）：

```
═══ 7.2.2 位移是「每個分區各自」的，不是 topic 全域的 ═══
  p0  off0    key=ORD-1002   value=event-2    ts=08:12:43.604
  p0  off1    key=ORD-1002   value=event-5    ts=08:12:43.608
  p1  off0    key=ORD-1001   value=event-1    ts=08:12:43.580
  p1  off1    key=ORD-1001   value=event-4    ts=08:12:43.607
  p1  off2    key=ORD-1001   value=event-6    ts=08:12:43.609
  p2  off0    key=ORD-1003   value=event-3    ts=08:12:43.606

  ↑ p0 / p1 / p2 各自都有一個 off0 —— 位移在 topic 這個層級沒有意義
```

⚠️ **「這個 topic 的第 0 則訊息」這句話沒有意義。** 有三個 offset 0，它們是三則不同的訊息。

📌 **所以「Kafka 保證順序」這句話的完整版是**：

> **Kafka 保證「同一個分區內」的訊息，寫進去的順序就是讀出來的順序。**
> **跨分區之間，沒有任何順序保證。**

回頭看上面的輸出：`event-1`（p1 off0）、`event-2`（p0 off0）、`event-3`（p2 off0）
是照這個順序送出去的，但它們在三個不同的分區上 —— **Kafka 不記得誰先送**，
而且**沒有任何機制可以讓你把它們排回去**（時間戳只是一個資料欄位，不是排序依據）。

### 7.2.3 console consumer 的每一個欄位

[00 章 0.7.2](./00-course-map-why-message-queue.md) 當時說「先認四個欄位，07 章會全部展開」。現在展開：

```bash
docker exec kafka-lab /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:29092 --topic ch07.anatomy.v1 --from-beginning \
  --timeout-ms 4000 \
  --property print.timestamp=true \
  --property print.partition=true \
  --property print.offset=true \
  --property print.key=true \
  --property print.headers=true
```

```
CreateTime:1790049493140	Partition:2	Offset:0	NO_HEADERS	ORD-1003	event-3
CreateTime:1790049493138	Partition:0	Offset:0	NO_HEADERS	ORD-1002	event-2
CreateTime:1790049493142	Partition:0	Offset:1	NO_HEADERS	ORD-1002	event-5
CreateTime:1790049493115	Partition:1	Offset:0	NO_HEADERS	ORD-1001	event-1
CreateTime:1790049493141	Partition:1	Offset:1	NO_HEADERS	ORD-1001	event-4
CreateTime:1790049493143	Partition:1	Offset:2	NO_HEADERS	ORD-1001	event-6
[2026-09-22 03:58:27,190] ERROR Error processing message, terminating consumer process:
org.apache.kafka.common.errors.TimeoutException
```

| 欄位 | 是什麼 | 你會用它來做什麼 |
|---|---|---|
| `CreateTime` | 訊息的時間戳（預設是 **producer 送出時**填的） | `--reset-offsets --to-datetime` 用的就是它（08 章 8.7） |
| `Partition` | 落在哪個分區 | 排查「同一個 key 怎麼會亂序」的第一個欄位 |
| `Offset` | 在**那個分區**裡的行號 | 重放的座標 |
| `NO_HEADERS` | 訊息 header（這裡是空的） | `traceId` 就放在這裡（10 章） |
| `ORD-1003` | **key** | 決定分區的那個東西 |
| `event-3` | value | 你真正的 payload |

⚠️ **最後那兩行 `ERROR ... TimeoutException` 不是錯誤。**
那是 `--timeout-ms 4000` 到期時 console consumer 的正常退出方式 ——
它等了 4 秒沒有新訊息就放棄。**本站所有 CLI 輸出都會有這兩行，請忽略它。**

⚠️ **注意輸出順序**：`Partition:2` 排在最前面，而它是第三則送出去的。
console consumer 是**依分區輪流拉**的，它的輸出順序**不代表任何東西**。

### 7.2.4 一個分區在磁碟上是什麼

```bash
docker exec kafka-lab ls -la /tmp/kafka-logs/ | grep ch07.anatomy
```

```
drwxr-xr-x  2 appuser appuser 4096 Sep 22 03:58 ch07.anatomy.v1-0
drwxr-xr-x  2 appuser appuser 4096 Sep 22 03:58 ch07.anatomy.v1-1
drwxr-xr-x  2 appuser appuser 4096 Sep 22 03:58 ch07.anatomy.v1-2
```

📌 **一個分區 = 一個目錄**，名字是 `<topic>-<分區號>`。裡面：

```bash
docker exec kafka-lab ls -la /tmp/kafka-logs/ch07.anatomy.v1-1/
```

```
-rw-r--r--  1 appuser appuser 10485760 00000000000000000000.index
-rw-r--r--  1 appuser appuser      249 00000000000000000000.log
-rw-r--r--  1 appuser appuser 10485756 00000000000000000000.timeindex
-rw-r--r--  1 appuser appuser        8 leader-epoch-checkpoint
-rw-r--r--  1 appuser appuser       43 partition.metadata
```

| 檔案 | 是什麼 |
|---|---|
| `.log` | **真正的訊息**。檔名 `00000000000000000000` 是這個 segment 的第一個 offset |
| `.index` | offset → 檔案位置的索引（預設預先配置 10 MB） |
| `.timeindex` | 時間戳 → offset 的索引。`--to-datetime` 靠它 |
| `leader-epoch-checkpoint` | leader 換過幾次、各自從哪個 offset 開始 |

⚠️ **`.index` 與 `.timeindex` 一開就是 10 MB**，裡面幾乎全是空的。
所以一個「空的」topic 每個分區也會佔掉 20 MB 的檔案空間（稀疏檔，實際磁碟用量小得多）。
**這是「分區開太多」的成本之一**，7.7.4 會再回來算這筆帳。

**把 `.log` dump 出來看**：

```bash
docker exec kafka-lab /opt/kafka/bin/kafka-dump-log.sh \
  --files /tmp/kafka-logs/ch07.anatomy.v1-1/00000000000000000000.log --print-data-log
```

```
Dumping /tmp/kafka-logs/ch07.anatomy.v1-1/00000000000000000000.log
Log starting offset: 0
baseOffset: 0 lastOffset: 0 count: 1 baseSequence: 0 lastSequence: 0 producerId: 19 producerEpoch: 0 partitionLeaderEpoch: 0 isTransactional: false isControl: false ... size: 83 magic: 2 compresscodec: none crc: 4048587080 isvalid: true
| offset: 0 CreateTime: 1790049493115 keySize: 8 valueSize: 7 sequence: 0 headerKeys: [] key: ORD-1001 payload: event-1
baseOffset: 1 lastOffset: 1 count: 1 baseSequence: 1 lastSequence: 1 producerId: 19 producerEpoch: 0 ... size: 83 ...
| offset: 1 CreateTime: 1790049493141 keySize: 8 valueSize: 7 sequence: 1 headerKeys: [] key: ORD-1001 payload: event-4
baseOffset: 2 lastOffset: 2 count: 1 baseSequence: 2 lastSequence: 2 producerId: 19 producerEpoch: 0 ... size: 83 ...
| offset: 2 CreateTime: 1790049493143 keySize: 8 valueSize: 7 sequence: 2 headerKeys: [] key: ORD-1001 payload: event-6
```

**這裡有三個欄位先記住，09 章整章都在用它們**：

- **`producerId: 19` 與 `sequence: 0/1/2`** —— 這是**冪等 producer** 留下的指紋。
  Spring 的 `KafkaTemplate` 預設就開著它（[01 章 1.3.5](./01-reliable-delivery-three-hops.md)）。
  對照 [01 章 1.3.6](./01-reliable-delivery-three-hops.md) 那個 dump，
  那裡的 `sequence: -1` 就是「冪等被關掉了」的樣子。**09 章 9.2 會講它防的是什麼。**
- **`isTransactional: false`** —— 09 章 9.3 的 Kafka 交易會把它變成 `true`。
- **`compresscodec: none`** —— 7.6.4 會把它變成 `zstd`。

### 7.2.5 `--describe` 的三欄

```bash
docker exec kafka-lab /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:29092 --describe --topic ch07.anatomy.v1
```

```
Topic: ch07.anatomy.v1	TopicId: Dnshcf0nQ2iYGoB37sOGVQ	PartitionCount: 3	ReplicationFactor: 1	Configs:
	Topic: ch07.anatomy.v1	Partition: 0	Leader: 1	Replicas: 1	Isr: 1	Elr: 	LastKnownElr:
	Topic: ch07.anatomy.v1	Partition: 1	Leader: 1	Replicas: 1	Isr: 1	Elr: 	LastKnownElr:
	Topic: ch07.anatomy.v1	Partition: 2	Leader: 1	Replicas: 1	Isr: 1	Elr: 	LastKnownElr:
```

| 欄位 | 意思 | 不對勁的樣子 |
|---|---|---|
| `Leader` | 這個分區的**讀寫都只走這一台**。副本只是跟著抄 | `Leader: none` → 這個分區現在完全不能用 |
| `Replicas` | 這個分區「應該」在哪幾台上，**照順序**（第一個是偏好的 leader） | —— |
| `Isr` | **in-sync replicas**：目前真的跟上進度的有哪幾台 | ⚠️ **`Isr` 比 `Replicas` 短，就是有副本掉隊了** |
| `Elr` / `LastKnownElr` | Kafka 3.7+ 的 Eligible Leader Replicas（KIP-966），本站用不到 | —— |

📌 **`Replicas` 與 `Isr` 這兩欄的差，就是 7.5 整節的主題。**
`ReplicationFactor: 1` 代表這個 topic **完全沒有副本** ——
[01 章 1.3.7](./01-reliable-delivery-three-hops.md) 已經證明過，在這種 topic 上 `acks=all` 等於 `acks=1`。

---

## 7.3 key 決定分區、分區決定順序 ★★★

[00 章 0.5.1](./00-course-map-why-message-queue.md) 已經證明了**不給 key 會亂**（三個實驗、兩個 ❌）。
這一節要回答它沒回答的那一半：**給了 key 之後，可以並行到什麼程度。**

### 7.3.1 key 怎麼變成分區號

分區公式不是黑盒子，**它是兩行純算數**，而且 7.2.1 已經驗證過它跟 broker 的答案一致：

```java
int partition = Utils.toPositive(Utils.murmur2(keyBytes)) % numPartitions;
```

**所以「key 分布得均不均勻」是一個可以在不碰 broker 的情況下算出來的問題**：

```java
    @Test
    void keyDistribution() {
        for (int n : new int[]{3, 6, 12}) {
            int[] c = new int[n];
            for (int i = 0; i < 1000; i++) {
                String key = "ORD-" + (100000 + i);
                c[Utils.toPositive(Utils.murmur2(key.getBytes())) % n]++;
            }
            // ... 印出分布、最少、最多、理想值
        }
    }
```

**輸出**：

```
═══ 7.3.1 1,000 個 orderId 灑進 N 個分區，分布有多均勻 ═══

   3 個分區： [316, 359, 325]
            最少 316、最多 359、理想值 333  → 最忙的分區比理想值高 7.7%

   6 個分區： [161, 197, 145, 155, 162, 180]
            最少 145、最多 197、理想值 166  → 最忙的分區比理想值高 18.2%

  12 個分區： [73, 102, 80, 75, 78, 91, 88, 95, 65, 80, 84, 89]
            最少 65、最多 102、理想值 83  → 最忙的分區比理想值高 22.4%
```

📌 **分區越多，分布越不均勻。** 這是統計的必然（每個分區的樣本數變少，相對變異變大），
不是 Kafka 的缺陷。實務上的意義是：

> **「我開 12 個分區，所以每個分區承擔 1/12 的流量」是錯的。**
> 最忙的那個實際承擔 **1/12 × 1.22**。你的容量規劃要用**最忙的那一個**算。

**而如果 key 選錯了，上面這整套就是裝飾品**：

```
═══ 7.3.1b key 選錯了，分區就是裝飾品 ═══
  情境：用 tenantId 當 key，而 3 個租戶裡有一個佔了 80% 的流量
    tenant-A （800 則）→ p5
    tenant-B （100 則）→ p4
    tenant-C （100 則）→ p2
    6 個分區的實際分布：[0, 0, 100, 0, 100, 800]
    ⚠️ 最忙的分區吃掉 80% 的流量，3 個分區完全是空的
```

⚠️ **這是真實世界最常見的 Kafka 效能問題，而且它在測試環境一定量不到** ——
測試資料裡每個租戶的量都差不多。

📌 **選 key 的第一個檢查是「這個 key 有幾種不同的值、分布均不均勻」**，
不是「這個欄位看起來像不像一個 ID」。

### 7.3.2 給了 key 之後，可以並行到什麼程度

**這是 [06 章 6.12](./06-rabbitmq-retry-delay-and-cluster.md) 承諾要量的東西。**

場景**刻意跟 [05 章 5.5.2](./05-rabbitmq-reliability.md) 一模一樣**：
200 張訂單，每張送 `CREATED → PAID → SHIPPED` 三個事件，消費者用「最後收到的」當最終狀態。
正確答案是 200 張都 `SHIPPED`。

**差別只有三個**：topic 有 6 個分區、key 是 `orderId`、消費者是同一個 consumer group 裡的 N 個成員。

```java
    /**
     * 先把 concurrency 個消費者跑起來並等到分區都分配好，再開始送訊息、才開始計時。
     * 這樣量到的是「處理」，不是「入團」。
     */
    Round runRound(String topic, String group, int concurrency, boolean withKey) throws Exception {
        // ... concurrency 條執行緒，每條一顆 KafkaConsumer，同一個 group.id
        //     每則 sleep(1 + rnd.nextInt(20)) 模擬業務處理
        //     finalState.put(orderId, status)   ← 「最後收到的就是最終狀態」

        // 等到 6 個分區全部被認領，才開始送訊息
        long dl = System.currentTimeMillis() + 60000;
        while (System.currentTimeMillis() < dl) {
            Set<String> ps = new HashSet<>();
            for (String a : assigned.values())
                if (!a.startsWith("（")) ps.addAll(Arrays.asList(a.split(",")));
            if (ps.size() >= PARTITIONS && assigned.size() == concurrency) break;
            sleep(200);
        }
        sleep(1500);   // 讓分配穩定下來

        for (int i = 0; i < ORDERS; i++)
            for (String f : FLOW)
                kafka.send(topic, withKey ? "ORD-" + i : null, "ORD-" + i + ":" + f);
        kafka.flush();
        long t0 = System.currentTimeMillis();
        done.await(180, TimeUnit.SECONDS);
        // ...
    }
```

⚠️ **那個「等到分區都分配好才開始計時」不是潔癖。**
消費者剛啟動時要入團、要等分配，這段時間有好幾百毫秒。
如果把它算進去，**消費者越多這段越長**，你會量到「加消費者反而變慢」的假結論。

**輸出**：

```
═══ 7.3.2 給了 key 之後，可以並行到什麼程度（6 個分區） ═══
  200 張訂單 × 3 個事件 = 600 則，key = orderId，每則處理 1～20 ms
  消費者直接用「最後收到的」當最終狀態，正確答案是 200 張都 SHIPPED

  ── 消費者 1 個 ──
     分區分配 : p0,p1,p2,p3,p4,p5
     600 則耗時 : 7,608 ms   （  78 則/秒，相對 1 個消費者 1.00x）
     真的有在做事的消費者 : 1 / 1
     最終狀態錯掉的訂單   : 0 / 200

  ── 消費者 2 個 ──
     分區分配 : p0,p1,p2 | p3,p4,p5
     600 則耗時 : 3,801 ms   （ 157 則/秒，相對 1 個消費者 2.00x）
     真的有在做事的消費者 : 2 / 2
     最終狀態錯掉的訂單   : 0 / 200

  ── 消費者 4 個 ──
     分區分配 : p0,p1 | p5 | p2,p3 | p4
     600 則耗時 : 2,489 ms   （ 241 則/秒，相對 1 個消費者 3.06x）
     真的有在做事的消費者 : 4 / 4
     最終狀態錯掉的訂單   : 0 / 200

  ── 消費者 6 個 ──
     分區分配 : p1 | p0 | p2 | p3 | p4 | p5
     600 則耗時 : 1,532 ms   （ 391 則/秒，相對 1 個消費者 4.97x）
     真的有在做事的消費者 : 6 / 6
     最終狀態錯掉的訂單   : 0 / 200

  ── 消費者 8 個 ──
     分區分配 : p0 | p3 | p1 | p2 | p4 | p5 | （沒分到） | （沒分到）
     600 則耗時 : 1,520 ms   （ 394 則/秒，相對 1 個消費者 5.01x）
     真的有在做事的消費者 : 6 / 8
     最終狀態錯掉的訂單   : 0 / 200
```

📌 **這支測試跑過兩次，另一次是 `79 / 156 / 239 / 428 / 402 則/秒`
（`1.00x / 1.97x / 3.00x / 5.38x / 5.05x`）** ——
**形狀完全一樣，而「6 個消費者」那一格在兩次之間是 4.97x～5.38x。**
⚠️ **所以「大約 5 倍」可以寫進報告，「5.38 倍」不行。**

**四件事值得停下來看**：

**① 「最終狀態錯掉的訂單」那一欄，五組全部是 0。**

直接跟 [05 章 5.5.2](./05-rabbitmq-reliability.md) 對照：

| | RabbitMQ（5.5.2） | Kafka（7.3.2） |
|---|---|---|
| 一個消費者 | 0 / 200 錯 | 0 / 200 錯 |
| 四個消費者 | ⚠️ **98 / 200 錯（49%）** | **0 / 200 錯** |
| 怎麼修 | 單一活躍消費者、版本號、或分片外掛 | **不用修。key 就是答案** |

📌 **這就是 partition 這個層級存在的全部理由。**
RabbitMQ 的併發單位是「消費者」，Kafka 的併發單位是「分區」——
而**一個分區永遠只會被同一個 group 裡的一個消費者處理**，
所以「同一個 key 的訊息不會被兩條執行緒同時處理」是**模型本身保證的**，
不是你寫對了才有的。

**② `4 個消費者 = 3.00x`，不是 4x。**

看分區分配：`p0,p1 | p2,p3 | p4 | p5`。
**6 個分區分給 4 個消費者，一定有人拿兩個。**
拿兩個的那個要處理大約 2/6 的訊息，所以整體耗時由它決定 → 6/2 = 3x。

📌 **所以消費者數量最好是分區數的因數**（1、2、3、6），否則你付了機器錢卻買不到對應的吞吐。

**③ `6 個消費者 = 5.38x`，也不是 6x。**

分區之間的訊息量本來就不均勻（7.3.1 量過，6 個分區偏差 18%），
再加上每則處理時間是隨機的 1～20 ms。**最慢的那個分區決定總時間。**

📌 **這是分散式系統的一般現象，不是 Kafka 的問題**：
並行度的上限是「最慢的那一份工作」，不是「工作總量 ÷ 人數」。

**④ `8 個消費者` 比 `6 個` 慢。**

`（沒分到）| （沒分到）` —— **第 7、8 個消費者連一個分區都沒有。**
它們在那裡 poll、心跳、什麼事都不做。

> ⚠️ **這是 Kafka 跟 RabbitMQ 最大的維運差異之一。**
>
> RabbitMQ：佇列積壓了 → 加消費者 → 一定會變快（[05 章 5.4](./05-rabbitmq-reliability.md) 量過 14 倍）。
> Kafka：lag 大了 → 加消費者 → **如果已經等於分區數，一點用都沒有**。
>
> **Kafka 的擴容上限，在你建 topic 的那一刻就決定了。**

### 7.3.3 不給 key 的第二個代價

[00 章 0.5.1](./00-course-map-why-message-queue.md) 講了不給 key 的第一個代價：順序會亂。
**但還有第二個，而且它更常發生。**

同樣 600 則、同樣 6 個分區，只把 key 拿掉：

```
═══ 7.3.3 同樣的 600 則、同樣的 6 個分區，只是不給 key ═══

  ── 消費者 1 個 ──
     訊息實際分布 : p0=0 p1=0 p2=600 p3=0 p4=0 p5=0
     600 則耗時   : 7,611 ms   （  78 則/秒）
     真的有在做事的消費者 : 1 / 1
     最終狀態錯掉的訂單   : 0 / 200

  ── 消費者 4 個 ──
     訊息實際分布 : p0=0 p1=0 p2=150 p3=450 p4=0 p5=0
     600 則耗時   : 7,587 ms   （  79 則/秒）
     真的有在做事的消費者 : 1 / 4
     最終狀態錯掉的訂單   : 0 / 200
```

⚠️ **`p2=150 p3=450`：六百則只用到 2 個分區，而且那兩個分區都分給了同一個消費者
—— 4 個消費者裡只有 1 個在做事，吞吐跟單一消費者一模一樣（79 vs 78 則/秒）。**

**⚠️ 但這一節最重要的事，是我重跑一次之後才發現的。**
同一支測試、同一台機器、同樣的 600 則：

```
═══ 7.3.3 同樣的 600 則、同樣的 6 個分區，只是不給 key ═══

  ── 消費者 1 個 ──
     訊息實際分布 : p0=0 p1=0 p2=0 p3=0 p4=600 p5=0
     600 則耗時   : 7,592 ms   （  79 則/秒）
     真的有在做事的消費者 : 1 / 1
     最終狀態錯掉的訂單   : 0 / 200

  ── 消費者 4 個 ──
     訊息實際分布 : p0=0 p1=0 p2=0 p3=324 p4=276 p5=0
     600 則耗時   : 4,166 ms   （ 144 則/秒）
     真的有在做事的消費者 : 2 / 4
     最終狀態錯掉的訂單   : 0 / 200
```

📌 **兩次跑，落點不一樣（`p2,p3` vs `p3,p4`）、有效並行度不一樣（1 vs 2），
吞吐從 79 變成 144。**

> ⚠️ **這才是「不給 key」真正的問題：它不是「比較慢」，是「不確定」。**
>
> 同一份程式碼、同一批資料、同一台機器，
> **你連「會用到幾個分區」都預測不了** —— 更不用說「哪些訊息會落在一起」。
> 📌 **而這正是 [00 章 0.5.1](./00-course-map-why-message-queue.md) 那三個實驗的本質**：
> ①②③ 的差別不在程式碼，在**流量與時機**。

**兩次都一樣的是：順序碰巧「是對的」（0/200 錯），而吞吐遠遠用不到 6 個分區的並行度。**

📌 **原因就是 [00 章 0.5.1](./00-course-map-why-message-queue.md) 講過的 sticky partitioner**：
沒給 key 的時候，producer 會「黏」在一個分區上，
**直到為那個分區累積的位元組數超過 `batch.size`（預設 16384）才換一個**。
600 則 × 約 20 bytes = 12 KB，**還沒填滿一個 batch**。

**所以這個實驗跟 [00 章 0.5.1](./00-course-map-why-message-queue.md) 實驗①是同一個機制**，
只是換一個角度看它：

| | 00 章 0.5.1 實驗① 的角度 | 7.3.3 的角度 |
|---|---|---|
| 看的是 | 順序 | 吞吐 |
| 結論 | 「順序意外地對了」→ **測試會騙你** | 「四台機器只有一台在做事」→ **錢白花了** |
| 什麼時候翻車 | 量變大、機器變多 → **順序亂掉** | 量變大 → 開始分散 → **順序亂掉** |

⚠️ **兩個角度的結局是同一個**：這個系統在小量時看起來完全正常，
上線後訊息量一大，**順序與吞吐會同時開始出問題，而且是漸進的**
（一開始只有偶爾幾則跑到別的分區）。

📌 **所以「不給 key」不是一個「比較簡單的選擇」，它是一個定時炸彈。**

### 7.3.4 所以 key 要怎麼選

選 key 就是回答一個問題：

> **「哪些訊息之間的順序，我非要不可？」**

| 場景 | key | 為什麼 |
|---|---|---|
| 訂單狀態事件 | `orderId` | 同一張訂單的事件要有序，不同訂單之間不用 |
| 使用者行為 / 操作紀錄 | `userId` | 同一個人的動作要有序 |
| 帳務流水 | `accountId` | 同一個帳戶的進出要有序（餘額算錯就完了） |
| 資料庫 CDC | **主鍵** | 同一列的 INSERT → UPDATE → DELETE 要有序 |
| 點擊事件、APM 指標 | **不給 key** ✅ | 真的不在乎順序，讓它均勻分散最好 |
| 全部事件 | ❌ 固定常數 | 等於只有一個分區（7.4 會量這個代價） |
| 隨便一個唯一值（`UUID`） | ❌ | 等於不給 key，而且連 sticky 的批次效益都沒了 |

📌 **[02 章 2.8.2](./02-outbox-and-transactional-consistency.md) 說「Kafka 用 `aggregate_id` 當 key」**
—— 現在你知道為什麼了：Outbox 表裡的 `aggregate_id` 就是「這一串事件屬於哪一個東西」，
而那正好就是「哪些訊息之間要有序」的答案。

⚠️ **三個實務上的補充**：

1. **key 不必出現在 value 裡，但通常會。** 消費端拿得到 `record.key()`，
   不過很多消費者只反序列化 value，所以把 `orderId` 也寫進 payload 比較省事。
2. **key 是 `null` 跟 key 是 `""` 不一樣。** 實測：

   ```
   ═══ 稽核 A：key = null 與 key = "" 的差別 ═══
     手算 murmur2("") % 6 = 3
     key = null   → 60 則用到的分區 = [5]
     key = 空字串    → 60 則用到的分區 = [3]
   ```

   **兩個看起來一樣（都只用到一個分區），但成因完全不同**：
   `null` 是 sticky partitioner **碰巧**黏在 p5（7.3.3 證明過它會變）；
   `""` 是一個**合法的 key**，`murmur2("") % 6 = 3` 是**固定答案** ——
   **這個 topic 上所有空字串 key 的訊息，永遠都進 p3。**
   ⚠️ 這是一個真的會發生的 bug：`event.getOrderId()` 回傳 `""` 而不是 `null`，
   於是**整個 topic 的流量塞進一個分區**，而且**永遠不會自己好**。
3. **key 會進 log compaction 的去重邏輯**（09 章 9.6）。
   如果你未來可能把 topic 改成 compacted，key 的選擇要更小心。

---

## 7.4 「分區數設成 1 來保證順序」的代價 ★★★

[00 章 0.11.2](./00-course-map-why-message-queue.md) 的練習留了一題：

> 「把分區數設成 1 來保證順序」這個做法的代價是什麼？（07 章 7.4 會量給你看，先自己想。）

**現在量。**

### 7.4.1 消費端：六台機器，只有一台在做事

**條件刻意設計成「你已經付了六台機器的錢」**：消費者固定 6 個，只改 topic 的分區數。

```java
    /** 固定 6 個消費者，只改 topic 的分區數 */
    long[] round(int partitions, int consumers) throws Exception {
        // ⚠️ 每一輪用不同的 topic 名字：共用的 KafkaTemplate 會快取 topic 的分區數
        //    （metadata.max.age.ms 預設 300000），同名 topic 改分區數它不會知道
        final String T = I3PartitionCostTest.T + ".p" + partitions;
        drop(T); dropGroup(G);
        kafkaAdmin.createOrModifyTopics(TopicBuilder.name(T).partitions(partitions).replicas(1).build());
        // ... 其餘跟 7.3.2 一樣
    }
```

⚠️ **那三行註解是一個會踩到的坑。**
每一輪如果用同一個 topic 名字，分區 3、6、12 三組全部量到「1 個消費者在做事、吞吐跟單分區一樣」——
因為**共用的 `KafkaTemplate` 快取了第一輪（1 個分區）的 metadata**，
之後每一輪都還是往 `p0` 送。**7.7.2 會把這個坑量出來。**

**輸出**：

```
═══ 7.4.1 消費者永遠是 6 個，只改分區數 ═══
  600 則、key = orderId、每則處理 1～20 ms
  分區  1  →   7,624 ms  (  78 則/秒)   有在做事的消費者 1/6   相對單分區 1.00x
  分區  2  →   3,713 ms  ( 161 則/秒)   有在做事的消費者 2/6   相對單分區 2.05x
  分區  3  →   2,856 ms  ( 210 則/秒)   有在做事的消費者 3/6   相對單分區 2.67x
  分區  6  →   1,550 ms  ( 387 則/秒)   有在做事的消費者 6/6   相對單分區 4.92x
  分區 12  →   1,404 ms  ( 427 則/秒)   有在做事的消費者 6/6   相對單分區 5.43x
```

📌 **「全域順序」的價碼：78 則/秒，而不是 387 則/秒。**

**而且請注意「有在做事的消費者」那一欄**：

```
  分區 1  →  1/6      ← 你買了六台機器，五台在睡覺
  分區 2  →  2/6
  分區 3  →  3/6
  分區 6  →  6/6      ← 這裡才開始物盡其用
  分區 12 →  6/6      ← 分區比消費者多，多出來的分區由同一批消費者兼著處理
```

> **消費者的有效數量 = min(消費者數, 分區數)。**
> 這是一個硬上限，沒有任何設定可以繞過去。

⚠️ **`分區 12 → 6/6` 這一列要特別看**：分區比消費者多是**沒問題的**
（每個消費者拿 2 個分區，照樣處理完），而且它比 `分區 6` 還快一點點（5.43x vs 4.92x）——
**因為分區多了，「最慢的那個分區」的訊息量變少，長尾變短。**
📌 **所以「分區數 > 消費者數」是正常且建議的設計**，它留了擴容空間（7.7.4）。

### 7.4.2 生產端：分區數也會影響寫入

順序的代價不只在消費端。同樣 50,000 則、每則 200 bytes，只改分區數，**每一輪用新的 producer**：

```java
    @Test
    void producerSideCost() throws Exception {
        for (int p : new int[]{1, 3, 6, 12}) {
            drop(pt);
            kafkaAdmin.createOrModifyTopics(TopicBuilder.name(pt).partitions(p).replicas(1).build());
            try (KafkaProducer<String, String> prod = new KafkaProducer<>(cfg)) {
                prod.send(new ProducerRecord<>(pt, "warm", body)).get();  // 暖機：建連線、抓 metadata
                long t0 = System.currentTimeMillis();
                for (int i = 0; i < 50000; i++)
                    prod.send(new ProducerRecord<>(pt, "K-" + i, body + i));
                prod.flush();
            }
            // ...
        }
    }
```

**輸出**：

```
═══ 7.4.2 生產端：50,000 則、200 bytes，只改分區數 ═══
  分區  1  →     190 ms  (263,157 則/秒)   相對單分區 1.00x
  分區  3  →     112 ms  (446,428 則/秒)   相對單分區 1.70x
  分區  6  →     100 ms  (500,000 則/秒)   相對單分區 1.90x
  分區 12  →      98 ms  (510,204 則/秒)   相對單分區 1.94x
```

📌 **生產端的代價比消費端小，但不是零。**
（另一次跑是 `1.00x / 2.28x / 2.50x / 2.56x` —— **倍數不穩，但「多分區比較快」的方向兩次都一樣。**
⚠️ 整段只花 100～200 ms，本來就在雜訊區，所以**只讀方向、不讀倍數**。）
一個分區 = 一個 leader = 一個 append-only 檔案 = 一條寫入路徑。
分區多了，producer 可以同時對多個分區發批次請求。

⚠️ **這組數字只能證明「在這台機器、這個訊息大小下」的相對關係。**
絕對值毫無參考價值（單機、無副本、page cache 全中）——
它證明的是**方向**：分區數是吞吐的分母，兩端都是。

### 7.4.3 所以「全域順序」要多少錢

把兩邊加起來：

| 你要的 | 分區數 | 消費端吞吐 | 生產端吞吐 | 擴容方式 |
|---|---|---|---|---|
| **全域順序** | 1 | 78 則/秒 | 263,157 則/秒 | ❌ **沒有**。加機器完全無效 |
| **同一個 key 有序** | 6 | 387 則/秒 | 500,000 則/秒 | ✅ 加消費者到 6 個 |
| **完全不要順序** | 12+ | 427 則/秒 | 510,204 則/秒 | ✅ 加消費者到 12 個 |

📌 **「全域順序」在 Kafka 上要付的不是 5 倍吞吐，是「失去水平擴充的能力」。**
前者是錢的問題，後者是架構的問題 —— 你的系統有一個**永遠打不破的天花板**，
而那個天花板等於「一台機器、一條執行緒」。

⚠️ **而且這還不是全部。** 單分區還讓你失去：

- **故障隔離**：那一個分區的 leader 掛掉，整個 topic 停擺（多分區時只停一部分）。
- **滾動部署的平順度**：唯一的那個消費者重啟時，**沒有人在消費**。
- **重放的粒度**：只能整個 topic 重放，不能只重放某幾個分區（08 章 8.7）。

**所以，什麼時候真的需要全域順序？**

> 📌 **幾乎不需要。**
>
> 「所有事件都要有序」通常是**需求沒有被問清楚**的結果。
> 真正的需求幾乎都是「**同一個 X** 的事件要有序」——
> 同一張訂單、同一個帳戶、同一個裝置。那就是 key。
>
> 如果真的需要（例如一個必須嚴格線性化的總帳），
> **請把它做成一個獨立的 topic**，不要讓它拖累其他事件流。

---

## 7.5 `acks`、ISR 與 `min.insync.replicas` ★★★

[00 章 0.9.3](./00-course-map-why-message-queue.md) 把「分區與 ISR」列為
**「不懂就一定會寫錯」的兩件事之一**。分區講完了，現在講 ISR。

[01 章 1.3.5 與 1.3.6](./01-reliable-delivery-three-hops.md) 已經用兩台 broker 實測過
`acks` 三個值的行為（`acks=1` 回報成功、給你一個 offset、但沒有人讀得到）。
**這一節不重複那個實驗**，而是補上它欠的三件事：**代價多少、ISR 什麼時候變、RF 該設多少。**

### 7.5.0 先起三台 broker

⚠️ **[01 章 1.3.7](./01-reliable-delivery-three-hops.md) 已經證明：單節點量不出任何副本相關的行為。**
`kafka-lab` 那台做不了這一節。

[01 章 1.3.6](./01-reliable-delivery-three-hops.md) 建了 `kafka1` / `kafka2`。**本節再加一台**：

```bash
docker start kafka1 kafka2        # 01 章建過的兩台

docker run -d --name kafka3 --network mq-lab -p 19103:9092 \
  -e CLUSTER_ID=5L6g3nShT-eMCtK--X86sw -e KAFKA_NODE_ID=3 \
  -e KAFKA_PROCESS_ROLES=broker \
  -e KAFKA_LISTENERS=HOST://:9092,INTERNAL://:29092 \
  -e KAFKA_ADVERTISED_LISTENERS=HOST://localhost:19103,INTERNAL://kafka3:29092 \
  -e KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=CONTROLLER:PLAINTEXT,HOST:PLAINTEXT,INTERNAL:PLAINTEXT \
  -e KAFKA_INTER_BROKER_LISTENER_NAME=INTERNAL \
  -e KAFKA_CONTROLLER_QUORUM_VOTERS=1@kafka1:9093 \
  -e KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER \
  -e KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=2 \
  -e KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=2 \
  -e KAFKA_TRANSACTION_STATE_LOG_MIN_ISR=1 \
  -e KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS=0 \
  -e KAFKA_NUM_PARTITIONS=1 apache/kafka:3.8.0

sleep 12
docker exec kafka1 /opt/kafka/bin/kafka-broker-api-versions.sh \
  --bootstrap-server kafka1:29092 2>/dev/null | grep "id:" | sed 's/ (.*//'
```

```
kafka3:29092
kafka2:29092
kafka1:29092
```

⚠️ **`KAFKA_PROCESS_ROLES=broker`（不含 controller）是刻意的**，
理由見 [01 章 1.3.6](./01-reliable-delivery-three-hops.md)：**KRaft 的 controller 需要過半數**，
所以 controller 只留 kafka1 一台，這樣停掉 kafka2 或 kafka3 都不會讓叢集停擺。

📌 **本節跑完，`kafka3` 可以 `docker rm -f kafka3` 移掉**（09 章用不到它）。

### 7.5.1 `acks` 的吞吐代價

這是 [01 章 1.3.5](./01-reliable-delivery-three-hops.md) 那張表欠的「代價」欄。
三台 broker、RF=3、`min.insync.replicas=2`、200,000 則 × 200 bytes：

```java
    String[][] cases = {
            {"0",   "false", "acks=0"},
            {"1",   "false", "acks=1"},
            {"all", "false", "acks=all（冪等關）"},
            {"all", "true",  "acks=all + 冪等 producer"},
    };
    // 冪等關掉的那幾組要一起設 retries=0，否則 ConfigException（01 章 1.3.5 那張表）
```

**跑了三次，因為第一次的數字不穩**：

```
═══ 7.5.1 acks 的吞吐代價（三台 broker、RF=3、min.insync.replicas=2、200,000 則 × 200 bytes） ═══
  設定                                耗時 ms          則/秒  相對 acks=0
  acks=0                            924      216,450      1.00x
  acks=1                            907      220,507      0.98x
  acks=all（冪等關）                   1,044      191,570      1.13x
  acks=all + 冪等 producer          1,166      171,526      1.26x
```

**再跑一次**：

```
═══ 7.5.1 acks 的吞吐代價（三台 broker、RF=3、min.insync.replicas=2、200,000 則 × 200 bytes） ═══
  設定                                耗時 ms          則/秒  相對 acks=0
  acks=0                          1,141      175,284      1.00x
  acks=1                          1,283      155,884      1.12x
  acks=all（冪等關）                   1,554      128,700      1.36x
  acks=all + 冪等 producer          1,291      154,918      1.13x
```

📌 **這支測試一共跑了四次（另外兩次是 `1.00/1.13/1.55/1.32` 與 `1.00/1.17/1.62/1.82`）。
可以寫進報告的結論只有兩條**：

1. **`acks=all` 比 `acks=0` 大約慢 1.1～1.6 倍**，而 `acks=1` 夾在中間、有時候量不出差別。
2. **冪等 producer 在 `acks=all` 之上的額外成本，在這個環境量不出來** ——
   四次分別是 1.32x / 1.82x / 1.26x / 1.13x，**有兩次還比「關掉冪等」快**。
   📌 **那是雜訊，不是訊號。**

⚠️ **最早我只跑 20,000 則，結果是「冪等 producer 比較快」**，
看起來像一個很有趣的發現。**加到 200,000 則、重跑四次之後它就消失了** ——
20,000 則在這台機器上只要 100～300 ms，**整個測量都在雜訊裡**。

> 📌 **這是本站所有效能數字的共同規矩**：
> **一次跑不算數。** 如果第二次跑出相反的結論，那就是沒有結論。

**跟 RabbitMQ 對照**：[01 章 1.3.4](./01-reliable-delivery-three-hops.md) 量到
RabbitMQ 開 publisher confirm 的代價是 **47,619 → 8,000 則/秒（約 6 倍）**。
Kafka 開 `acks=all` 的代價是 **1.1～1.6 倍**。

📌 **這個差距是設計取捨的直接結果**（[01 章 1.4.4](./01-reliable-delivery-three-hops.md) 講過）：
RabbitMQ 的 confirm 要等 **fsync**，Kafka 的 `acks=all` 只要等 **副本收到**（在它們的 page cache 裡）。
**Kafka 用「機器數量」換掉了「磁碟等待」。**

### 7.5.2 ISR 什麼時候收縮 —— 「關機」跟「當機」是兩個答案

`Isr` 那一欄不是即時的。**broker 掛掉之後，它要過一段時間才會從 ISR 裡消失**，
而這段時間裡 `acks=all` 的行為是「正常」的。

```java
    @Test
    void isrTiming() throws Exception {
        for (String how : new String[]{"stop", "kill"}) {
            makeTopic(t, 3, 2);            // RF=3, min.insync.replicas=2
            trySend(t, "all");
            long t0 = System.currentTimeMillis();
            docker(how, "kafka3");          // docker stop / docker kill
            int size;
            do { sleep(200); size = isrSize(t); } while (size == 3 && System.currentTimeMillis() - t0 < 120000);
            // ... 印出收縮花了多久
            t0 = System.currentTimeMillis();
            docker("start", "kafka3");
            do { sleep(200); size = isrSize(t); } while (size < 3 && ...);
            // ... 印出恢復花了多久
        }
    }
```

**輸出**：

```
═══ 7.5.2 ISR 收縮與恢復各要多久（RF=3） ═══

  ── docker stop kafka3（SIGTERM，broker 會做 controlled shutdown）──
     動手前 : Leader=3 Replicas=[1, 2, 3] Isr=[1, 2, 3]
     ISR 從 3 收縮到 2，花了 1,517 ms
     現在   : Leader=1 Replicas=[1, 2, 3] Isr=[1, 2]
     docker start 之後，ISR 回到 3，花了 8,381 ms

  ── docker kill kafka3（SIGKILL，當場斷電）──
     動手前 : Leader=3 Replicas=[1, 2, 3] Isr=[1, 2, 3]
     ISR 從 3 收縮到 2，花了 8,924 ms
     現在   : Leader=1 Replicas=[1, 2, 3] Isr=[1, 2]
     docker start 之後，ISR 回到 3，花了 2,098 ms
```

**`1,517 ms` vs `8,924 ms` —— 差了 5.9 倍。** 為什麼？

📌 **因為「關機」會道別，「當機」不會。**

| | `docker stop`（SIGTERM） | `docker kill`（SIGKILL） |
|---|---|---|
| broker 做了什麼 | **controlled shutdown**：主動通知 controller「我要下線了」 | 什麼都沒做，行程直接消失 |
| controller 怎麼知道 | **它被告知了** | 它要**等心跳超時** |
| 花多久 | 通知的來回時間（約 1.5 秒） | `broker.session.timeout.ms` |
| leader 轉移 | 下線前就換好了 | 超時之後才換 |

**把那個超時值印出來驗證**：

```bash
docker exec kafka1 /opt/kafka/bin/kafka-configs.sh --bootstrap-server kafka1:29092 \
  --describe --entity-type brokers --entity-name 1 --all | grep -E 'broker.session|broker.heartbeat'
```

```
broker.heartbeat.interval.ms=2000 sensitive=false synonyms={DEFAULT_CONFIG:broker.heartbeat.interval.ms=2000}
broker.session.timeout.ms=9000 sensitive=false synonyms={DEFAULT_CONFIG:broker.session.timeout.ms=9000}
```

📌 **`broker.session.timeout.ms = 9000`，實測 8,924 ms。對上了。**

⚠️ **這個 9 秒有實際後果**：

```
  0.0s   kafka3 被 kill
  0.0s ~ 8.9s   controller 還以為 kafka3 活著
                ├─ kafka3 上當 leader 的分區：寫入全部逾時（沒有 leader 回應）
                └─ acks=all 的請求：卡住，等 delivery.timeout.ms
  8.9s   ISR 收縮、leader 轉移
  8.9s+  恢復正常
```

**所以一台 broker 當機，你的 producer 會有「大約 9 秒的寫入中斷」**，
而不是「立刻切到副本」。這段時間的長度由 `broker.session.timeout.ms` 決定。

⚠️ **不要為了「切得快」把它調小。** 調小 = 網路抖一下就誤判 broker 死掉 → 不必要的 leader 選舉 → 更多中斷。
📌 **正確的做法是讓 producer 撐過這 9 秒**：`retries` 夠大、`delivery.timeout.ms` 夠長
（預設 120000，遠大於 9 秒 → 預設值是對的）。**7.9 會講這組設定。**

⚠️ **另外注意 `replica.lag.time.max.ms`（7.5.4 印出來是 30000）不是這個場景的值。**
它管的是「副本還活著，但抄得太慢」——
broker 整台掛掉走的是 `broker.session.timeout.ms`，**兩個是不同的判定路徑**。

⚠️ **`docker start` 之後的恢復時間（8,381 ms 與 2,098 ms）差很多，那是容器啟動本身的變異，不要拿它下結論。**
可以說的只有：**幾秒鐘的量級**。

### 7.5.3 `min.insync.replicas=2` 在 RF=3 與 RF=2 上是兩件事 ★★★

**這是本節最重要的一個實驗**，也是 [00 章 0.9.3](./00-course-map-why-message-queue.md)
承諾要講的「`min.insync.replicas` 的語意」。

建**兩個** topic，`min.insync.replicas` 都設 2，只有 RF 不同。然後掉一台 broker：

```java
    @Test
    void minIsrArithmetic() throws Exception {
        makeTopic(t3, 3, 2);      // RF=3, min.insync.replicas=2
        makeTopic(t2, 2, 2);      // RF=2, min.insync.replicas=2
        // ... 三台都活著時各送一則
        docker("stop", "kafka3");
        // ... 等 ISR 收縮，再各送一則
        docker("start", "kafka3");
        // ... 等 ISR 回滿，再各送一則
    }
```

**輸出**：

```
═══ 7.5.3 「min.insync.replicas=2」在 RF=3 與 RF=2 上是兩件事 ═══
  RF=3, min.isr=2 : Leader=1 Replicas=[1, 2, 3] Isr=[1, 2, 3]
  RF=2, min.isr=2 : Leader=2 Replicas=[2, 3] Isr=[2, 3]

  ── 三台都活著 ──
    RF=3  acks=all → ✅ 成功 off=0
    RF=2  acks=all → ✅ 成功 off=0

  ── docker stop kafka3（掉一台） ──
    RF=3 現在 : Leader=1 Replicas=[1, 2, 3] Isr=[1, 2]
    RF=2 現在 : Leader=2 Replicas=[2, 3] Isr=[2]
    RF=3  acks=all → ✅ 成功 off=1
    RF=2  acks=all → ❌ NotEnoughReplicasException

  ── docker start kafka3（補回來） ──
    RF=3 現在 : Leader=1 Replicas=[1, 2, 3] Isr=[1, 2, 3]
    RF=3  acks=all → ✅ 成功 off=2
    RF=2  acks=all → ✅ 成功 off=1
```

⚠️ **同一個 `min.insync.replicas=2`、同樣掉一台機器：一個照常寫入，一個 100% 被拒絕。**

📌 **語意只有一句話**：

> **`acks=all` 成功的條件是「ISR 的大小 >= `min.insync.replicas`」。**
> 沒有別的。它跟 RF 沒有直接關係 —— **RF 只決定 ISR 最大能長到多少。**

**所以能容忍幾台機器掛掉，是一個減法**：

| RF | `min.insync.replicas` | ISR 滿的時候 | 能掉幾台還能寫 | 評語 |
|---|---|---|---|---|
| 1 | 2（或任何值） | 1 | **0** | ⚠️ **假的**。被夾成 1（[01 章 1.3.7](./01-reliable-delivery-three-hops.md)），`acks=all` = `acks=1` |
| 2 | 2 | 2 | **0** | ⚠️ **零容錯**。掉任何一台，寫入全停（本節實測） |
| 2 | 1 | 2 | 1 | 能寫，但 `acks=all` 只保證 1 份 → 等於 `acks=1` |
| **3** | **2** | **3** | **1** | ✅ **正式環境的標準答案** |
| 3 | 3 | 3 | **0** | ⚠️ 零容錯。7.9.1 用它來製造「必定失敗」 |
| 5 | 3 | 5 | 2 | 跨三個 AZ 時用 |

📌 **公式：能掉的台數 = RF − `min.insync.replicas`。**

⚠️ **`RF=2 + min.isr=2` 是最常見的設定錯誤，因為它看起來很合理**
（「兩份副本，兩份都要寫到」）。
**它的實際效果是：你把可用性降到比單機還低** ——
單機掛掉會停，兩台裡任何一台掛掉也會停，而你有兩倍的機器會掛。

⚠️ **而 `RF=1` 那一列最惡毒**：它不報錯、`--describe` 上還看得到 `min.insync.replicas=2`，
但那個設定被夾成 1，完全沒有作用。
📌 **查法（[01 章 1.3.7](./01-reliable-delivery-three-hops.md) 給過）**：

```bash
# 找出所有 RF=1 的 topic —— 這些 topic 上的 acks=all 是假的
docker exec kafka-lab /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:29092 --describe | grep "ReplicationFactor: 1"
```

### 7.5.4 broker 端的預設值

**不要憑印象。** 直接問 broker：

```java
    try (AdminClient ac = admin()) {
        var cr = new ConfigResource(ConfigResource.Type.BROKER, "1");
        var cfg = ac.describeConfigs(List.of(cr)).all().get().get(cr);
        for (String k : new String[]{"min.insync.replicas", "default.replication.factor", ...}) {
            var e = cfg.get(k);
            System.out.printf("  %-45s = %s%n", k, e == null ? "(無此項)" : e.value());
        }
    }
```

**輸出**（本站 `apache/kafka:3.8.0` 的 `kafka1`）：

```
═══ 7.5.4 跟副本有關的 broker 預設值（kafka1 實際值） ═══
  min.insync.replicas                           = 1
  default.replication.factor                    = 1
  replica.lag.time.max.ms                       = 30000
  unclean.leader.election.enable                = false
  num.partitions                                = 1
  auto.create.topics.enable                     = true
  log.retention.ms                              = null
  log.retention.hours                           = 168
  log.retention.bytes                           = -1
  log.segment.bytes                             = 1073741824
  log.retention.check.interval.ms               = 300000
  log.cleanup.policy                            = delete
  offsets.topic.replication.factor              = 2
  transaction.state.log.replication.factor      = 2
  transaction.max.timeout.ms                    = 900000
  log.flush.interval.messages                   = 9223372036854775807
  log.flush.interval.ms                         = null
  group.initial.rebalance.delay.ms              = 0
  message.max.bytes                             = 1048588
```

**這裡有五個值要現在就看懂**：

| 值 | 為什麼重要 |
|---|---|
| `min.insync.replicas = 1` | ⚠️ **預設不保護你。** 你必須在 topic 上或 broker 上明確設成 2 |
| `default.replication.factor = 1` | ⚠️ **自動建出來的 topic 沒有副本**（7.8 的主題） |
| `unclean.leader.election.enable = false` | ✅ 預設是對的：**寧可分區不能用，也不讓落後的副本當 leader**（開了就會丟訊息） |
| `log.flush.interval.messages = Long.MAX_VALUE` | [01 章 1.4.4](./01-reliable-delivery-three-hops.md) 講過：**Kafka 不主動 fsync** |
| `log.retention.hours = 168` | 預設留 7 天 —— **09 章 9.5 的主題** |

⚠️ **`offsets.topic.replication.factor = 2` 與 `transaction.state.log.replication.factor = 2`
是本站環境刻意設的**（[00 章 0.6.2](./00-course-map-why-message-queue.md) 在 `kafka-lab` 上設成 1，
因為單節點放不下更多副本）。

📌 **正式環境這兩個要設成 3**，理由跟業務 topic 完全一樣：
`__consumer_offsets` 這個內部 topic 裝的是**所有 consumer group 的進度**，
它要是掉了，全部的消費者都會退回 `auto.offset.reset`（08 章 8.7 會看到這個後果）。
**位移本身也需要副本保護。**

### 7.5.5 所以 producer 這邊該怎麼設

把 [01 章 1.3.5](./01-reliable-delivery-three-hops.md) 那張「你以為你只調了 `acks`」的表接回來：

```yaml
spring:
  kafka:
    producer:
      acks: all                                  # ← 明確寫出來（雖然 3.0 之後這就是預設）
      retries: 2147483647                        # ← 明確寫出來
      properties:
        enable.idempotence: true                 # ← 明確寫出來（09 章 9.2）
        max.in.flight.requests.per.connection: 5 # ← 明確寫出來（冪等 producer 的上限就是 5）
        delivery.timeout.ms: 120000              # ← 這是真正的「我放棄」界線
```

📌 **四個都寫出來的理由，[01 章 1.3.5](./01-reliable-delivery-three-hops.md) 已經證明過**：
只要你沒有明確寫 `enable.idempotence`，改 `acks` 或 `retries` 會**安靜地把它關掉**；
而明確寫了之後，設錯就是**啟動時 `ConfigException`**，不是上線後掉訊息。

**topic 這邊**：

```bash
docker exec kafka-lab /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:29092 \
  --create --topic order.created.v1 --partitions 6 \
  --replication-factor 3 --config min.insync.replicas=2
```

⚠️ **`--replication-factor 3` 不是「三台 broker」就夠了，還要是「三台真的獨立的機器」。**
[01 章 1.4.4](./01-reliable-delivery-three-hops.md) 講過：三個 broker 跑在同一台實體機上，副本是假的。
正式環境要用 `broker.rack` 讓副本跨 AZ 分布。

---

## 7.6 批次與壓縮：延遲與吞吐是同一個旋鈕的兩端 ★★

[00 章 0.11.2](./00-course-map-why-message-queue.md) 的練習說：

> 你要親眼看到「延遲與吞吐是同一個旋鈕的兩端」——07 章 7.6 會用到這張表。

**這一節就是那張表。** 而它比「一個旋鈕」還麻煩一點：

📌 **同一個 `linger.ms`，在非同步送與同步送之下，效果相差四百倍以上，而且方向相反。**

先講機制。Kafka 的 producer **不是「一則一則送」的**：

```
   你的執行緒                  producer 內部的 RecordAccumulator          Sender 執行緒
   ───────────                ─────────────────────────────────         ─────────────
   send(record)  ──────────▶  放進 p0 的批次
   send(record)  ──────────▶  放進 p0 的批次
   send(record)  ──────────▶  放進 p0 的批次   ┐
                                              │ 滿足以下任一條件就送出：
                                              │  ① 這個批次累積到 batch.size (16384 bytes)
                                              │  ② 這個批次等了 linger.ms
                                              └──────────────────────▶  一次網路請求
```

**所以 `batch.size` 與 `linger.ms` 是「或」的關係，不是「且」。**
誰先滿足就誰送 —— 這句話是理解下面四個實驗的鑰匙。

### 7.6.1 真實速率下的 `linger.ms`：它就是延遲

⚠️ **這個實驗的設計要先說清楚，因為很容易做錯。**

用「20,000 則能送多快送多快」來量，四組 `linger.ms` 的吞吐是
`327K / 444K / 327K / 444K / 540K` —— **完全沒有規律**。
原因：那個速率下，批次**永遠是被 `batch.size` 填滿的**（`批次平均 = 16,063 bytes`，
而 `batch.size = 16384`），`linger.ms` 根本沒有機會生效。

📌 **所以要量 `linger.ms`，就要用一個「批次填不滿」的速率** ——
而那正好是絕大多數業務系統的實際情況：**一個服務每秒送幾十到幾百則事件**。

```java
    /** 每 gapMs 毫秒送一則，量每一則的 send → ack 延遲 */
    Result runRateLimited(String topic, int linger, int n, int gapMs) throws Exception {
        cfg.put(ProducerConfig.LINGER_MS_CONFIG, linger);
        try (KafkaProducer<String, String> p = new KafkaProducer<>(cfg)) {
            p.send(new ProducerRecord<>(topic, "warm", payload(0))).get();
            for (int i = 0; i < n; i++) {
                long s = System.nanoTime();
                p.send(new ProducerRecord<>(topic, "ORD-" + i, payload(i)),
                       (m, e) -> lat.add(System.nanoTime() - s));
                sleep(gapMs);                     // ← 每 10 ms 一則 = 每秒 100 則
            }
            p.flush();
        }
        // ... 另外從 p.metrics() 讀出 batch-size-avg 與 records-per-request-avg
    }
```

**輸出**（每則約 234 bytes 的訂單 JSON）：

```
═══ 7.6.1 每秒 100 則的真實速率下，linger.ms 純粹是延遲（600 則） ═══
  linger.ms        延遲 p50       延遲 p99       延遲 max         批次平均 B        每請求筆數
  0               1.57 ms      6.79 ms     11.31 ms            320          1.0
  5               7.07 ms     11.00 ms     16.57 ms            320          1.0
  20             14.92 ms     24.57 ms     39.60 ms            374          2.0
  100            56.00 ms    105.28 ms    106.99 ms            843          8.8
```

**兩欄一起看，這張表就講完了整件事**：

| `linger.ms` | 你**付出**的（p50 延遲） | 你**買到**的（每請求筆數） |
|---|---|---|
| 0 | 1.57 ms | 1.0 則 |
| 5 | 7.07 ms（**×4.5**） | 1.0 則（**什麼都沒買到**） |
| 20 | 14.92 ms（**×9.5**） | 2.0 則 |
| 100 | 56.00 ms（**×35.7**） | 8.8 則 |

📌 **`linger.ms=5` 那一列是重點**：延遲變成 4.5 倍，而 `每請求筆數` 還是 **1.0**。
**你付了錢，一則訊息都沒有多批到。**

⚠️ 為什麼 p50 大約是 `linger/2`？因為每則訊息「運氣」不同 ——
剛好在批次開始時進來的要等滿 `linger.ms`，剛好在批次結束前進來的幾乎不用等。
平均下來就是一半。

📌 **所以在「每秒幾百則」這個量級，`linger.ms` 的正確值是 0（預設值）。**
`linger.ms` 只有在**你的送出速率已經高到批次會自然形成**的時候才有意義，
而那時候它也不太重要了 —— 因為 `batch.size` 會先滿。

**把那個「爆量」的情況量出來當對照**：

```
═══ 7.6.1b 同樣四個 linger.ms，改成「能送多快送多快」（200,000 則） ═══
  linger.ms       耗時 ms          則/秒       延遲 p99         批次平均 B        每請求筆數
  0                 698      286,532    455.28 ms          16167        180.3
  5                 328      609,756    109.03 ms          16216        180.8
  20                398      502,512    107.71 ms          16216        180.8
  100               322      621,118    107.71 ms          16216        180.8
```

⚠️ **吞吐那一欄完全是雜訊，不要拿它下結論**（另一次跑是 `711,743 / 699,300 / 554,016 / 724,637`，
連大小順序都跟這次不一樣）。
**真正的證據是 `批次平均 B` 那一欄：四組全部是 16,2xx，貼著 `batch.size = 16384`。**
📌 **爆量時批次是被 `batch.size` 填滿的，`linger.ms` 連生效的機會都沒有。**

### 7.6.2 同一個旋鈕，同步送的時候方向相反 ★★★

把寫法從 `send(record, callback)` 換成 `send(record).get()`，其他完全不動：

```
═══ 7.6.2 同一個 linger.ms，改成同步送（send().get()，2,000 則） ═══
  linger.ms       耗時 ms        則/秒       延遲 p50       延遲 p99
  0                 527      3,795       0.22 ms      1.01 ms
  5              13,807        144       6.81 ms     10.18 ms
  20             45,330         44      22.57 ms     25.68 ms
  100           206,740          9     103.32 ms    107.64 ms
```

⚠️ **3,795 則/秒 → 9 則/秒。422 倍。**
（另一次跑是 `4,219 → 9`，469 倍 —— **兩次都是四百倍以上的量級。**）

📌 **機制是一行話**：`send().get()` 會等這一則的 ack 回來才送下一則。
**所以每個批次永遠只有一則訊息**，而那一則**一定要等滿 `linger.ms`** 才會被送出去
（因為永遠沒有第二則來填滿 `batch.size`）。

```
   非同步送（7.6.1）：  send send send send ... ──▶ 批次裡有 8.8 則 ──▶ 一次請求
                        linger.ms 是「多等一下，湊多一點」

   同步送（7.6.2）：    send ──▶ 等滿 linger.ms ──▶ 送 1 則 ──▶ 等 ack ──▶ 下一則
                        linger.ms 是「每一則都多等 100 ms」，而且什麼都沒湊到
```

> ⚠️ **這是 Kafka 設定裡最容易踩的一個坑，因為它的症狀是「效能莫名其妙很爛」，
> 而不是任何形式的錯誤。**
>
> 常見的觸發組合：有人看文章說「調大 `linger.ms` 可以提升吞吐」，
> 就在 `application.yml` 裡加了 `linger.ms: 100`；
> 而程式碼裡寫的是 `kafkaTemplate.send(...).get()`（為了「確定送出去了」）。
> **結果是整個服務的吞吐掉到 9 則/秒。**

📌 **決策規則**：

| 你的程式碼長怎樣 | `linger.ms` 該設多少 |
|---|---|
| `send(...).get()`（同步等） | **一定要 0** |
| `send(...)` + `whenComplete`（非同步） | 0（預設）就好；**除非**你的量大到批次會自然形成 |
| 批次匯入（一次塞幾十萬則，不在乎單則延遲） | 5～50 可以考慮，**但先量 7.6.3 的 `batch.size`** |

### 7.6.3 `batch.size`：真正的吞吐旋鈕

```
═══ 7.6.3 batch.size（linger.ms=5、非同步、200,000 則 JSON） ═══
  batch.size        耗時 ms        則/秒       延遲 p99       批次平均 B        每請求筆數
  1                 6,825     29,304   3456.86 ms          325          3.0
  1024              2,516     79,491   1252.27 ms          854          8.9
  16384               347    576,368     91.14 ms        16192        180.8
  65536               273    732,600     96.58 ms        65162        724.6
  262144              313    638,977     76.95 ms       258748       2857.2
```

**這張表有兩個結論，第二個跟大部分人的直覺相反**：

**① `batch.size` 是真正的吞吐旋鈕：從 29,304 到 732,600，差 25 倍。**

**② ⚠️ 「小批次 = 低延遲」是錯的。`batch.size=1` 的 p99 是 3,456 ms —— 全場最差，差了 30 倍以上。**

📌 **為什麼？** 因為延遲不只是「等批次」的時間，還有「排隊」的時間。
`batch.size=1` 時每個請求只帶 3 則訊息（`每請求筆數 3.0`），
200,000 則就是約 67,000 次網路來回。**後面的訊息在 producer 的緩衝區裡排了三秒半的隊。**

```
  batch.size = 1        →  每請求 3.0 則    →  請求次數爆炸  →  排隊延遲 3,456 ms
  batch.size = 16384    →  每請求 181 則    →  請求次數 1/60  →  排隊延遲 91 ms
  batch.size = 262144   →  每請求 2,857 則  →  請求次數更少   →  77 ms
```

⚠️ **但「16384 / 65536 / 262144 這三個誰的 p99 最好」不要當結論。**
這一次是 `91.14 / 96.58 / 76.95 ms`，另一次跑是 `7.40 / 33.57 / 95.38 ms` ——
**三者之間的排名兩次完全相反。**

📌 **兩次都成立的只有一件事：`batch.size` 太小（1 或 1024）時，
吞吐與延遲「同時」壞掉一個數量級。**
**而預設值 16384 在兩次裡都落在「好的那一群」** —— 在改它之前，先確定你量過。

⚠️ **`batch.size` 是「每個分區」的上限，不是全域的。**
producer 的總緩衝是 `buffer.memory`（實測預設 **33,554,432** = 32 MB）。
所以 `batch.size=262144` × 12 個分區 = 3 MB，還在預算內；
但如果你有 100 個分區，就會開始碰到 `buffer.memory` 的天花板
（症狀是 `send()` 開始阻塞，最後丟 `TimeoutException: Expiring N record(s)`）。

### 7.6.4 壓縮：兩個方向同時變好

```java
    for (String c : new String[]{"none", "gzip", "snappy", "lz4", "zstd"}) {
        Result r = run(t, Map.of(ProducerConfig.COMPRESSION_TYPE_CONFIG, c,
                ProducerConfig.LINGER_MS_CONFIG, 5), false, 200000, true);
        long size = logSize(t);   // AdminClient.describeLogDirs() 讀出這個 topic 在磁碟上多大
    }
```

⚠️ **payload 用的是一張看起來像真的訂單 JSON**，不是亂數 ——
**亂數不會壓縮，用亂數量壓縮率會得到「壓縮沒用」的假結論**：

```java
    static String payload(int i) {
        return "{\"eventId\":\"evt-" + i + "\",\"aggregateId\":\"ORD-" + (i % 5000)
                + "\",\"type\":\"OrderCreated\",\"occurredAt\":\"2026-09-22T11:30:0" + (i % 10)
                + "Z\",\"customerId\":\"CUST-" + (i % 800) + "\",\"amount\":" + (1000 + i % 9000)
                + ",\"currency\":\"TWD\",\"items\":[{\"sku\":\"SKU-" + (i % 300) + "\",\"qty\":"
                + (1 + i % 5) + ",\"price\":" + (100 + i % 900) + "}],\"channel\":\"WEB\""
                + ",\"traceId\":\"trace-" + (i % 4000) + "\"}";
    }
```

**輸出**：

```
═══ 7.6.4 compression.type（linger.ms=5、非同步、200,000 則 JSON，每則約 234 bytes） ═══
  壓縮              耗時 ms        則/秒       延遲 p99      磁碟上 bytes        壓縮比
  none              416    480,769     92.05 ms     53,043,498      1.00x
  gzip              605    330,578      9.80 ms      5,851,324      9.07x
  snappy            232    862,068      7.86 ms      9,826,641      5.40x
  lz4               157  1,273,885     11.48 ms     11,214,409      4.73x
  zstd              193  1,036,269      8.51 ms      3,731,907     14.21x
```

⚠️ **`none` 是全場最慢的一個（除了 gzip）。**

📌 **壓縮在 Kafka 上通常是「兩個方向同時變好」，這跟直覺相反。**
原因：壓縮花的是 **CPU**，省的是 **網路傳輸量 + 磁碟寫入量 + 磁碟讀取量**。
在 Kafka 這種 I/O 密集的場景，**後者遠大於前者**。

**而且省的不只是 producer 端**：

```
  producer 壓縮一次 ──▶ broker 直接存壓縮後的位元組（不解壓）
                     ──▶ 副本同步傳的也是壓縮後的
                     ──▶ consumer 收到壓縮後的，自己解壓
```

📌 **一次壓縮，四個地方受益**：producer 出網、broker 磁碟、副本同步流量、consumer 入網。

**四種演算法怎麼選**：

| 演算法 | 壓縮比 | 吞吐 | 什麼時候選它 |
|---|---|---|---|
| `zstd` | **14.21x** 🏆 | 1,036,269 | ✅ **預設首選**。壓縮比最好，吞吐是 `none` 的 2 倍以上 |
| `lz4` | 4.73x | **1,273,885** 🏆 | CPU 很吃緊、或訊息本來就不太能壓 |
| `snappy` | 5.40x | 862,068 | 跟 `lz4` 很接近，看你的生態系哪個支援得好 |
| `gzip` | 9.07x | **330,578** ⚠️ | ❌ **不要用**。比不壓縮還慢，壓縮比又輸 `zstd` |
| `none` | 1.00x | 480,769 | 訊息已經是壓縮格式（圖片、protobuf + 已壓縮）時 |

⚠️ **`zstd` 需要 Kafka 2.1+ 的 broker 與客戶端**（本站 3.8.0 / 3.6.2，沒問題）。
如果你的叢集裡有很舊的消費者，**它們會解不開** —— 這是唯一要檢查的相容性。

⚠️ **壓縮比高度依賴你的 payload。** 這裡的 14.2x 是因為：
訂單 JSON 有大量重複的欄位名（`"eventId"`、`"aggregateId"`…），而且批次裡有 179 則一起壓。
**你自己的訊息請自己量** —— 把 `payload()` 換成你的真實資料，重跑這支測試。

📌 **`compression.type` 也可以設在 topic 上**（`--config compression.type=zstd`）。
差別：設在 producer 上是「我送出去的是壓縮的」，設在 topic 上是
「broker 收到之後如果格式不符就重新壓一次」（會多花 broker 的 CPU）。
**建議設在 producer 端**，topic 上留 `producer`（預設值，意思是「照 producer 送來的格式存」）。

### 7.6.5 ⚠️ `batch.size` 也會影響順序

[00 章 0.5.1](./00-course-map-why-message-queue.md) 的實驗三已經證明過這件事，
但它出現在「順序」那一章，很容易被當成一個孤立的現象。**現在把它接回來**：

```
00 章 0.5.1 實驗三：batch.size=1、不給 key、六則訊息 → 順序 ❌ 錯
```

📌 **機制**：不給 key 時，producer 的 `BuiltInPartitioner` 會「黏」在一個分區上，
**直到為那個分區累積的位元組超過 `batch.size` 才換一個**。
所以 **`batch.size` 同時是三個東西的旋鈕**：

```
   batch.size ┬──▶ 吞吐（7.6.3：29 倍）
              ├──▶ 延遲（7.6.3：p99 從 3,456 ms 掉到 100 ms 以內）
              └──▶ ⚠️ 不給 key 時的分區切換頻率（00 章 0.5.1 實驗三：順序會亂）
```

⚠️ **所以「為了降延遲把 `batch.size` 調小」這個動作，可能會順便把你的順序弄壞** ——
如果你的 topic 有訊息是不給 key 送的。

📌 **防法只有一個，而且你已經知道了：給 key。**
**給了 key 之後，`batch.size` 就跟分區選擇完全無關了** ——
分區由 `murmur2(key) % n` 決定，跟批次狀態無關。

### 7.6.6 四個參數怎麼配

| 場景 | `batch.size` | `linger.ms` | `compression.type` | 送法 |
|---|---|---|---|---|
| **一般業務事件**（每秒幾十～幾百則） | 16384（預設） | **0**（預設） | `zstd` | 非同步 + callback |
| **高吞吐事件流**（每秒幾萬則以上） | 65536 | 5～20 | `zstd` 或 `lz4` | 非同步 + callback |
| **批次匯入 / 補資料** | 262144 | 50 | `zstd` | 非同步 + 最後 `flush()` |
| **低延遲、量小**（例如同步 API 後面掛的通知） | 預設 | **0** | `lz4` 或 `none` | ⚠️ 同步 `.get()` 的話 `linger` **必須**是 0 |

⚠️ **改之前先量。** 這張表是起點，不是答案 ——
`batch.size` 的最佳值取決於你的訊息大小，而 7.6.3 已經證明**預設值兩次都落在「好的那一群」**。

---

### 7.6.7 ⚠️ 順帶把「訊息太大」的三個上限一次講完

`batch.size` 講完了，但**真正會在正式環境炸給你看的是另外三個值**，而且它們必須一起看：

```
═══ 稽核 B：課文引用但沒印過的客戶端預設值 ═══
  producer buffer.memory          = 33,554,432
  producer max.block.ms           = 60,000
  producer compression.type       = none
  producer max.request.size       = 1,048,576
```

```
（broker 端，7.5.4 印過）
  message.max.bytes                             = 1048588
```

| 設定 | 在哪一端 | 預設 | 超過會怎樣 |
|---|---|---|---|
| `max.request.size` | **producer** | **1,048,576** | `RecordTooLargeException`，**在你的行程裡就擋掉了** |
| `message.max.bytes` | **broker**（可以設在 topic 上） | **1,048,588** | broker 拒收，producer 收到 `RecordTooLargeException` |
| `max.partition.fetch.bytes` | **consumer** | 1,048,576（[08 章 8.5.1](./08-kafka-consumer-group-and-offset.md)） | ⚠️ 見下方 |

⚠️ **三個要一起改，只改一個是最糟的情況**：

```
   只調大 producer 的 max.request.size
      → 訊息送到 broker 才被拒 → 浪費一次網路來回，而且錯誤發生得比較晚

   只調大 producer + broker，忘了 consumer 的 max.partition.fetch.bytes
      → ⚠️ 訊息**寫進去了**，但消費者永遠拉不出來
      → 消費者卡在那一則上，lag 不動，而且它不是毒藥訊息（處理邏輯根本沒被呼叫到）
```

📌 **`message.max.bytes` 的 `1048588` 比 `1048576` 多 12 bytes**，
那是訊息標頭的空間 —— **所以「1 MB」這個數字在兩端不是同一個意思**，
設定時請留餘裕，不要剛好卡在邊界。

📌 **更好的做法：不要用 MQ 傳大東西。**
把檔案放物件儲存，訊息裡只放 URL —— 這也是 [05 章 5.6](./05-rabbitmq-reliability.md)
在 RabbitMQ 那一側的結論。

---

## 7.7 分區數是一個幾乎改不回去的決定 ★★

[06 章 6.12](./06-rabbitmq-retry-delay-and-cluster.md) 預告過這件事。現在量它。

### 7.7.1 加分區 → 既有 key 的路由跑掉

```java
    @Test
    void addingPartitionsBreaksKeyRouting() throws Exception {
        kafkaAdmin.createOrModifyTopics(TopicBuilder.name(t).partitions(3).replicas(1).build());
        // 12 個 key 各送一則，記下落點
        try (var p = prod()) {
            for (String k : keys) before.put(k, p.send(new ProducerRecord<>(t, k, k + ":BEFORE")).get().partition());
        }
        // 加到 6 個分區
        try (AdminClient ac = admin()) {
            ac.createPartitions(Map.of(t, NewPartitions.increaseTo(6))).all().get();
        }
        // ⚠️ 用「新的」producer 再送一次，才不會拿到快取的舊 metadata（理由見 7.7.2）
        try (var p = prod()) {
            for (String k : keys) after.put(k, p.send(new ProducerRecord<>(t, k, k + ":AFTER")).get().partition());
        }
    }
```

**輸出**：

```
═══ 7.7.1 3 個分區 → 6 個分區，既有 key 的路由怎麼跑掉 ═══
  key          3 分區時      6 分區時
  ORD-2001     p1           p4           ← 搬家了
  ORD-2002     p2           p5           ← 搬家了
  ORD-2003     p1           p1
  ORD-2004     p0           p3           ← 搬家了
  ORD-2005     p1           p4           ← 搬家了
  ORD-2006     p1           p1
  ORD-2007     p1           p1
  ORD-2008     p0           p3           ← 搬家了
  ORD-2009     p2           p5           ← 搬家了
  ORD-2010     p1           p1
  ORD-2011     p0           p3           ← 搬家了
  ORD-2012     p2           p5           ← 搬家了

  12 個 key 裡有 8 個換了分區（67%）

  ── ORD-2001 的事件現在分散在兩個分區上 ──
    p4 off0   ORD-2001:AFTER
    p1 off0   ORD-2001:BEFORE
  ⚠️ 兩則事件在不同分區上 → 由不同的消費者處理 → 它們之間沒有任何順序保證
```

⚠️ **`ORD-2001` 的 `BEFORE` 在 p1、`AFTER` 在 p4。**

**具體到業務上是什麼樣子**：

```
   改分區之前：ORD-2001 的 CREATED、PAID 寫在 p1
   改分區之後：ORD-2001 的 SHIPPED、DELIVERED 寫在 p4

   消費者 A 讀 p1，消費者 B 讀 p4 —— 兩條執行緒、兩個速度。
   → SHIPPED 可能在 PAID 之前被處理
   → 而這只發生在「改分區那一瞬間前後有事件的那些訂單」上
   → 所以你會看到「極少數訂單狀態錯亂」，而且重現不了
```

📌 **這是「順序保證從此有一個斷點」，不是「順序永久壞掉」。**
改完之後的新事件仍然是同 key 同分區，只是**跨越那個時間點的那一批訂單**受害。

### 7.7.2 ⚠️ 而且正在跑的 producer 還不知道

**這是我自己在做 7.4.1 的時候踩到的坑**（7.4.1 那三行註解就是為了它）：

```java
    @Test
    void producerMetadataCache() throws Exception {
        // topic 先建成 3 個分區
        try (var p = prod()) {
            for (int i = 0; i < 60; i++) seen.add(p.send(new ProducerRecord<>(t, "K-" + i, "v")).get().partition());
            // ... 印出「改之前」用到的分區

            try (AdminClient ac = admin()) {
                ac.createPartitions(Map.of(t, NewPartitions.increaseTo(6))).all().get();
            }
            sleep(3000);
            // 同一顆 producer 繼續送
            seen.clear();
            for (int i = 0; i < 60; i++) seen.add(p.send(new ProducerRecord<>(t, "K-" + i, "v")).get().partition());
        }
        // 再換一顆全新的 producer 送
    }
```

**輸出**：

```
═══ 7.7.2 分區加好了，但正在跑的 producer 還不知道 ═══
  metadata.max.age.ms 預設 = 300000 ms
  改之前：60 個 key 用到的分區 = [0, 1, 2]
  broker 上現在的分區數 = 6
  改之後（同一顆 producer 繼續送）：用到的分區 = [0, 1, 2]
  換一顆新的 producer：用到的分區 = [0, 1, 2, 3, 4, 5]
```

⚠️ **`broker 上現在的分區數 = 6`，但同一顆 producer 還在往 `[0, 1, 2]` 送。**

📌 **原因是 `metadata.max.age.ms = 300000`** —— producer 快取 topic 的 metadata **五分鐘**才刷新一次。

**所以「加分區」這個操作的實際時間線是**：

```
   T+0      kafka-topics --alter --partitions 6  執行完成
   T+0      broker 上 6 個分區立刻存在
   T+0      消費者：rebalance，有人分到 p3/p4/p5（但那三個分區是空的）
   T+0 ~ T+5min   ⚠️ 不同的 producer 實例，各自在不同的時間點發現這件事
                     → 同一個 key，在 A 機器上還進 p1，在 B 機器上已經進 p4
   T+5min   所有 producer 都刷新完 metadata
```

⚠️ **在那五分鐘裡，同一個 key 會同時往兩個分區寫。**
這比 7.7.1 的「一個斷點」更糟 —— 它是一段**五分鐘的混亂期**。

### 7.7.3 到底幾成的 key 會搬家

```
═══ 7.7.3 10,000 個 key，分區數從 N 改成 M，幾成會搬家 ═══
  改法               搬家比例
   3 → 6           50.0%   （剛好翻倍也一樣會搬）
   6 → 12          49.3%   （剛好翻倍也一樣會搬）
   3 → 4           74.4%
   4 → 8           50.3%   （剛好翻倍也一樣會搬）
   6 → 7           85.5%
  12 → 24          50.1%   （剛好翻倍也一樣會搬）
```

📌 **兩個結論**：

1. **「翻倍比較安全」是半個迷思。** 翻倍確實是最好的情況，但還是有 **50%** 會搬家 ——
   因為 `h % 6` 與 `h % 12` 只有在 `h % 12 < 6` 時才相等，機率剛好一半。
2. **`6 → 7` 這種「加一個」最糟：85.5%。** 想加分區的話，**至少翻倍**。

⚠️ **對照 [05 章 5.5.6](./05-rabbitmq-reliability.md) 的 `x-consistent-hash`**：
那裡量到「擴容時 13% 的 key 會搬家」。
📌 **一致性雜湊就是為了把這個 50%～85% 壓到個位數而發明的** ——
而 **Kafka 的分區用的是最樸素的取模，不是一致性雜湊**。
這是 Kafka 刻意的取捨：取模可以讓 producer **不需要跟 broker 協調**就算出分區
（7.2.1 的手算驗證），代價就是擴容很痛。

### 7.7.4 所以分區數該怎麼決定

**先看不能做的事**：

```
  ── 分區數只能加，不能減 ──
    改回 2 個分區：❌ InvalidPartitionsException: The topic ch07.repart.v1 currently has
                     6 partition(s); 2 would not be an increase.
```

📌 **沒有「減少分區」這個操作。** 唯一的路是：建一個新 topic、把資料搬過去、切換所有生產者與消費者。

**決定分區數的四個約束**：

| 約束 | 怎麼算 | 本章的證據 |
|---|---|---|
| **① 消費者並行度上限** | 分區數 >= 你未來可能的最大消費者數 | 7.3.2：8 個消費者 / 6 個分區 → 2 個閒置 |
| **② 目標吞吐** | 分區數 >= 目標吞吐 ÷ 單分區吞吐 | 7.4.1：單分區 78 則/秒（這個數字**你要自己量**） |
| **③ 每個分區的固定成本** | 檔案控制代碼、`.index`+`.timeindex` 各 10 MB、controller 的 metadata | 7.2.4 |
| **④ rebalance 成本** | 分區越多，rebalance 要重新分配的東西越多 | 08 章 8.3 |

📌 **一個實務上的起手式**：

> **分區數 = 預期峰值消費者數 × 2，且至少 6。**
>
> × 2 是留給「以後要加機器」的空間 —— 因為加分區很貴（7.7.1、7.7.2），
> **而分區比消費者多是免費的**（7.4.1 實測：12 分區 / 6 消費者，比 6/6 還快一點）。

⚠️ **但也不要開一萬個。** 約束 ③ 與 ④ 是真的：
每個分區在每台 broker 上都是一個目錄、幾個檔案控制代碼、一份 controller metadata。
**單一叢集幾萬個分區開始就要認真規劃了。**

**真的非加不可的時候，安全的做法**：

1. **停掉生產者**（或讓它們寫進 Outbox 暫存，[02 章](./02-outbox-and-transactional-consistency.md)）。
2. **等消費者把 lag 清到 0** —— 這樣舊分區裡沒有「還沒處理的舊事件」。
3. `--alter --partitions N`。
4. **重啟所有 producer**（不要等那 5 分鐘的 `metadata.max.age.ms`）。
5. 恢復生產。

📌 **步驟 2 是關鍵**：lag 清到 0 之後才改，就不會出現「同一個 key 的舊事件還在 p1 排隊、新事件已經進 p4」的情況。

**或者，換一個 topic**（更安全，但要改設定）：

```
   order.created.v1  （6 分區，只讀不寫）   ← 消費者繼續讀到 lag=0
   order.created.v2  （24 分區，新的寫入）  ← 生產者切過來
```

⚠️ **這個做法要求消費者同時訂閱兩個 topic 一段時間**，
而且 ⚠️ **同一個 key 的事件會跨 topic** —— 順序保證一樣有斷點。
**沒有無痛的做法，只有「痛在哪裡」的選擇。**

---

## 7.8 `auto.create.topics.enable` 與命名慣例

[00 章 0.6.2](./00-course-map-why-message-queue.md) 起 `kafka-lab` 的時候設了
`KAFKA_AUTO_CREATE_TOPICS_ENABLE=true`，並且說「⚠️ **正式環境務必設 false**（07 章 7.8）」。
**這一節兌現它**，順便兌現 [00 章 0.7.1](./00-course-map-why-message-queue.md) 的「命名慣例在 07 章 7.8 會有一節」。

### 7.8.1 打錯一個字，多一個 topic

先認真建一個 topic（12 個分區），然後往一個**少一個字母**的名字送：

```java
    static final String GOOD = "ch07.order.created.v1";
    static final String TYPO = "ch07.oder.created.v1";        // ← 少一個 r
    static final String CONSUMER_TYPO = "ch07.order.creatd.v1";
```

**輸出**：

```
═══ 7.8.1 打錯一個字，多一個 topic —— 而且沒有任何錯誤 ═══
  認真建的      ch07.order.created.v1      → 存在，分區 12、RF 1
  打錯字的      ch07.oder.created.v1       → 不存在

  ── 送一則到打錯字的那個名字 ──
    kafka.send() 回傳 : ✅ 成功 partition=0 offset=0（沒有例外、沒有警告）
    現在 ch07.oder.created.v1       → 存在，分區 1、RF 1

  ── 消費者訂閱一個不存在的 topic 也會建出來 ──
    客戶端 allow.auto.create.topics 預設 = true
    訂閱前 ch07.order.creatd.v1       → 不存在
    訂閱後 ch07.order.creatd.v1       → 存在，分區 1、RF 1

  ── 消費端把它關掉：allow.auto.create.topics=false ──
    訂閱後 ch07.order.creatd.v1       → 不存在

  ── 現在叢集上有幾個 ch07.o* 開頭的 topic ──
    ch07.oder.created.v1         存在，分區 1、RF 1
    ch07.order.created.v1        存在，分區 12、RF 1
```

⚠️ **三件事，每一件都是一個正式環境事故**：

**① 打錯字的 topic 被建出來了，而且是用 broker 預設值建的：1 個分區、RF=1。**

對照 7.4 與 7.5 你就知道這有多糟：

| | 你認真建的 | 打錯字自動建的 |
|---|---|---|
| 分區 | 12 | **1** → 消費者並行度上限 = 1（7.4.1：78 則/秒） |
| RF | （正式環境應該是 3） | **1** → `acks=all` 完全失效（[01 章 1.3.7](./01-reliable-delivery-three-hops.md)） |
| `min.insync.replicas` | 2 | broker 預設 **1**（7.5.4） |
| retention | 你設的 | broker 預設 **7 天**（7.5.4） |

📌 **「自動建出來的 topic」= 「所有保護都關掉的 topic」。**

**② 沒有任何錯誤。** `kafka.send()` 回傳 `✅ 成功 partition=0 offset=0`。
**訊息真的寫進去了** —— 只是寫進一個沒有人在讀的 topic。

> ⚠️ **這是 [01 章 1.3.1](./01-reliable-delivery-three-hops.md) 那個
> 「routing key 少一個字母，500 則無聲消失」的 Kafka 版本。**
>
> 兩邊的差別很有意思：
>
> | | RabbitMQ（1.3.1） | Kafka（7.8.1） |
> |---|---|---|
> | 打錯名字的結果 | 訊息**被丟掉** | 訊息**被存起來**，在一個新 topic 裡 |
> | 怎麼發現 | `publisher-returns` + `mandatory`（要自己開） | ⚠️ **沒有任何機制**。只能靠「topic 列表怎麼多了一個」 |
> | 事後救得回來嗎 | ❌ 訊息沒了 | ✅ **救得回來**，訊息還在那個 topic 裡 |
>
> 📌 **Kafka 這邊「救得回來」是唯一的好消息** —— log 模型的副作用。

**③ 消費者訂閱一個不存在的 topic，也會把它建出來。**

這更隱蔽，因為**消費端通常沒有人在檢查**。
而且它會造成一個很迷惑的症狀：**「消費者跑得好好的，就是收不到訊息，lag 永遠是 0」**
—— 因為它訂閱的是一個空的、自己建出來的 topic。

✅ **消費端有一個客戶端設定可以擋**：`allow.auto.create.topics: false`（實測有效，上面第四段）。

### 7.8.2 ⚠️ 它不能動態關掉

```java
    String[] cmd = {"docker", "exec", "kafka-lab", "/opt/kafka/bin/kafka-configs.sh",
            "--bootstrap-server", "localhost:29092", "--alter",
            "--entity-type", "brokers", "--entity-name", "1",
            "--add-config", "auto.create.topics.enable=false"};
```

**輸出**：

```
═══ 7.8.2 能不能不重啟 broker 就把它關掉 ═══
  $ kafka-configs.sh --alter --entity-type brokers --entity-name 1 \
      --add-config auto.create.topics.enable=false

  Error while executing config command with args '--bootstrap-server localhost:29092 --alter --entity-type brokers --entity-name 1 --add-config auto.create.topics.enable=false'
  java.util.concurrent.ExecutionException: org.apache.kafka.common.errors.InvalidRequestException: Cannot update these configs dynamically: Set(auto.create.topics.enable)
```

📌 **`Cannot update these configs dynamically`** ——
`auto.create.topics.enable` 是 **read-only** 設定，**必須重啟 broker 才能改**。

⚠️ **所以這件事要在「建叢集的那一天」就決定。**
如果你接手的是一個已經開著它的叢集，關掉它需要一次滾動重啟（而且要先確認
沒有服務正在依賴自動建 topic —— 關掉之後那些服務會開始報錯）。

**本站的 `kafka-lab` 刻意開著它**，因為教學時常要快速建拋棄式 topic。
**正式環境的建法**：

```bash
docker run -d --name kafka-prod ... \
  -e KAFKA_AUTO_CREATE_TOPICS_ENABLE=false \
  ...
```

### 7.8.3 三道防線

因為 broker 端關不掉（或還沒關），**你需要縱深防禦**：

| 防線 | 做法 | 擋得住什麼 |
|---|---|---|
| **① broker** | `auto.create.topics.enable=false`（要重啟） | ✅ 全部。但改不動的時候就只能往下看 |
| **② 消費端** | `allow.auto.create.topics: false` | 消費者打錯字（7.8.1 實測有效） |
| **③ 生產端** | ⚠️ **沒有對應的客戶端設定**。要用 topic 常數 + 啟動時檢查 | 生產者打錯字 |

**③ 的具體寫法** —— 把 topic 名字集中管理，並在啟動時跟 broker 對一次：

```java
package com.example.lab11.shop;

public final class Topics {
    public static final String ORDER_CREATED = "order.created.v1";
    public static final String ORDER_PAID    = "order.paid.v1";
    public static final String MAIL_OUTBOX   = "mail.requested.v1";

    public static final List<String> ALL = List.of(ORDER_CREATED, ORDER_PAID, MAIL_OUTBOX);

    private Topics() { }
}

@Component
class TopicGuard {
    private final KafkaAdmin admin;

    TopicGuard(KafkaAdmin admin) { this.admin = admin; }

    /** 啟動時檢查：每個 topic 都要存在，而且分區數與 RF 符合預期 */
    @EventListener(ApplicationReadyEvent.class)
    void verify() throws Exception {
        try (AdminClient ac = AdminClient.create(admin.getConfigurationProperties())) {
            var desc = ac.describeTopics(Topics.ALL).allTopicNames().get();
            for (var e : desc.entrySet()) {
                int parts = e.getValue().partitions().size();
                int rf = e.getValue().partitions().get(0).replicas().size();
                if (parts < 6 || rf < 3)
                    throw new IllegalStateException(
                            "topic " + e.getKey() + " 只有 " + parts + " 個分區、RF=" + rf
                          + " —— 這看起來是自動建出來的，不是我們建的");
            }
        }
    }
}
```

📌 **這個檢查抓的正是 7.8.1 那個症狀**：`分區 1、RF 1` 就是「自動建出來的」的指紋。

⚠️ **一定要用 `describeTopics` 去探，不能用 `send()`** —— `send()` 本身就會把 topic 建出來（7.8.1）。
`describeTopics` 則是安全的，實測：

```
═══ 斷言③ describeTopics 探一個不存在的 topic，會不會把它建出來 ═══
  describeTopics → UnknownTopicOrPartitionException
  探完之後 ch07claim.probe.only 存在？ false
```

### 7.8.4 命名慣例

[00 章 0.8.7](./00-course-map-why-message-queue.md) 立過規矩，這裡把理由補上：

```
   Kafka topic          <領域>.<事件>.v<版本>        order.created.v1
   consumer group       <服務名>.<用途>              mail-service.confirm
   拋棄式 topic          demo.<主題>.<時間戳>          demo.sticky.a.1789965910126
```

**每一段都有理由**：

| 規則 | 為什麼 |
|---|---|
| **整個專案只用一種分隔符號** | ⚠️ Kafka 認為 `.` 與 `_` 是**同一個字元**（因為 metric 名稱會把兩者轉成一樣的東西）。實測見下方：**第二個 topic 根本建不起來** |
| **全小寫** | topic 名稱**區分大小寫**，`Order.Created.v1` 跟 `order.created.v1` 是兩個 topic |
| **`<領域>` 開頭** | 一個叢集上幾百個 topic 的時候，`kafka-topics --list \| grep order.` 要撈得出來 |
| **事件名用過去式**（`created` 不是 `create`） | topic 裡放的是**已經發生的事實**，不是命令。這個區別會影響消費者怎麼寫 |
| **`.v1` 結尾** | ⚠️ **這是最重要的一條**，見下方 |
| **consumer group 用 `<服務名>.<用途>`** | 出事時 `--describe --group` 的輸出要能直接對應到人 |

⚠️ **「`.` 與 `_` 算同一個字元」不是風格建議，是 broker 的硬規則。** 實測：

```java
    kafkaAdmin.createOrModifyTopics(TopicBuilder.name("ch07claim.order.created")...);
    // 接著建一個只差分隔符號的
    kafkaAdmin.createOrModifyTopics(TopicBuilder.name("ch07claim_order_created")...);
```

```
═══ 斷言① topic 名稱 '.' 與 '_' 撞 metric 名稱 ═══
  建了 ch07claim.order.created，接著建 ch07claim_order_created（只差分隔符號）——

ERROR o.springframework.kafka.core.KafkaAdmin : Failed to create topics
org.apache.kafka.common.errors.InvalidTopicException: Topic 'ch07claim_order_created' collides with existing topic: ch07claim.order.created
```

📌 **`collides with existing topic`** —— broker **直接拒絕**，不是警告。
⚠️ **所以混用的後果不是「metric 撞在一起」，是「第二個 topic 建不出來」。**
如果你的團隊一半用 `.` 一半用 `_`，總有一天會有人建 topic 建到一半失敗，
而錯誤訊息裡講的是一個**看起來完全不相干**的 topic 名字。

⚠️ **`.v1` 為什麼非要不可**：

訊息的 schema 一定會變。而 Kafka 的 topic **留著舊訊息**（retention 內）——
所以「改 schema」意味著同一個 topic 裡同時有新舊兩種格式。

```
   沒有版本號：order.created
   → 上游改了欄位 → 舊消費者炸掉 → 而 topic 裡還有三天份的舊訊息
   → 你不能回滾（新訊息已經進去了），也不能前進（舊消費者掛著）

   有版本號：order.created.v1 → order.created.v2
   → 上游同時寫 v1 與 v2（雙寫期）
   → 消費者一個一個搬到 v2
   → v1 的 lag 清零之後停掉雙寫
```

📌 **這跟 [04 章 4.6.3](./04-rabbitmq-basics-and-topology.md) 的「雙綁遷移 SOP」是同一個思路**，
只是在 Kafka 上你換的是 topic，在 RabbitMQ 上換的是 binding。

⚠️ **不要用 `.v1` 來表示「業務版本」**（例如「第一版的訂單流程」）。
**它只表示訊息格式的版本。** 混用會讓你在真的要改格式的時候沒有版本號可用。

**最後：拋棄式 topic 加時間戳，而且要記得刪。**

```java
    String t = "demo.sticky.a." + System.currentTimeMillis();
```

📌 **本站每一支測試都自我清理**（`drop(t)`），理由不只是整潔：
`auto.create.topics.enable=true` + 測試之間共用名字 = **上一支測試的殘留訊息污染下一支**。
⚠️ **而且因為打錯字的 topic 會被靜默建出來，你不會發現自己在讀一個錯的 topic。**

---

## 7.9 落地：`KafkaTemplate` 的三種送法

### 7.9.1 broker 收不下的時候，三種送法各自「知道」多少 ★★★

**這是 [01 章 1.3.1](./01-reliable-delivery-three-hops.md) 那個實驗的 Kafka 版本。**

製造一個「必定失敗」的環境：RF=3 + `min.insync.replicas=3` 的 topic，然後停掉一台 broker
（7.5.3 那張表的最後一列：容錯能力 = 3 − 3 = **0**）。

**先量一件事：完全用預設設定，一則 `send().get()` 要卡多久才知道失敗？**

```java
        long dt0 = System.currentTimeMillis();
        try (var tpl = new AutoCloseableTemplate(template(false))) {   // false = 完全用客戶端預設
            tpl.t.send(T, "k", "default-settings").get();
        } catch (Exception e) { /* ... */ }
        System.out.printf("     結果 %s，呼叫端被卡了 %,d ms%n", err, System.currentTimeMillis() - dt0);
```

```
  ── 用客戶端預設設定，送「一則」並 .get() ──
     結果 ❌ TimeoutException，呼叫端被卡了 120,145 ms
     （delivery.timeout.ms 預設 120000、retries 預設 2147483647，
       而 NOT_ENOUGH_REPLICAS 是「可重試」的錯誤）
```

⚠️ **一則訊息，呼叫端的執行緒被佔用了 120 秒。**

📌 **機制**：`NOT_ENOUGH_REPLICAS` 是**可重試**的錯誤（因為副本有可能回來），
而 `retries` 預設是 `2147483647`，所以 producer 會**一直重試到 `delivery.timeout.ms` 為止**。

> ⚠️ **這是一個真實的事故模式，而且很難診斷**：
>
> ```
>   一台 broker 掛了
>   → 你的 HTTP 請求執行緒在 kafkaTemplate.send(...).get() 上卡住
>   → Tomcat 的 200 條執行緒在兩分鐘內全部卡光
>   → 整個服務對所有請求都沒有回應（包含健康檢查）
>   → 監控說「服務掛了」，但 CPU 是 0%
> ```
>
> **而這只需要一台 broker 掛掉。**

📌 **防法有三層**：

1. **不要在請求執行緒上 `.get()`。** 用非同步 + callback（寫法 C）。
2. **如果非同步做不到，把 `delivery.timeout.ms` 調到你的請求逾時之內**（例如 3000）。
3. **根本解：[02 章的 Outbox](./02-outbox-and-transactional-consistency.md)** ——
   請求執行緒只寫資料庫，送訊息交給背景輪詢器。**它卡多久都不影響使用者。**

**接著比較三種送法。** 為了讓失敗立刻回來，這三組都改成 `retries=0` + `delivery.timeout.ms=3000`：

```java
        // ── 寫法 A：送出去就不管了
        for (int i = 0; i < N; i++) {
            try { tpl.t.send(T, "k" + i, "A-" + i); }
            catch (Exception e) { caughtA.incrementAndGet(); }
        }
        tpl.t.flush();

        // ── 寫法 B：.get() 同步等
        for (int i = 0; i < N; i++) {
            try { tpl.t.send(T, "k" + i, "B-" + i).get(); }
            catch (Exception e) { caughtB.incrementAndGet(); }
        }

        // ── 寫法 C：非同步 callback
        for (int i = 0; i < N; i++)
            tpl.t.send(T, "k" + i, "C-" + i).whenComplete((r, e) -> {
                if (e == null) okC.incrementAndGet(); else failC.incrementAndGet();
            });
        tpl.t.flush();
```

**輸出**：

```
═══ 7.9.1 broker 收不下的時候，三種送法各自「知道」多少 ═══
  topic：RF=3、min.insync.replicas=3，然後停掉一台 broker → acks=all 必定失敗
  停掉之後 ISR 已經不足，目前 topic 裡有 0 則

  ── 以下三種送法都改成 retries=0 + delivery.timeout.ms=3000，讓失敗立刻回來 ──

  ── 寫法 A：kafka.send(...)，回傳的 Future 丟掉 ──
     送出 200 則   呼叫端接到的例外 0 個   broker 上多了 0 則

  ── 寫法 B：kafka.send(...).get() ──
     送出 200 則   呼叫端接到的例外 200 個   broker 上多了 0 則

  ── 寫法 C：kafka.send(...).whenComplete(...) ──
     送出 200 則   callback 回報成功 0 / 失敗 200   broker 上多了 0 則
```

⚠️ **寫法 A：200 則全部失敗，呼叫端接到 0 個例外。**

📌 **`kafkaTemplate.send()` 是非阻塞的，它回傳一個 `CompletableFuture`。**
不去碰那個 Future，就等於**你放棄了知道結果的權利**。
`try/catch` 包住 `send()` 完全沒有用 —— 失敗發生在**另一條執行緒**上（`kafka-producer-network-thread`）。

> 📌 **這跟 [05 章 5.2](./05-rabbitmq-reliability.md) 的「confirm callback 在另一條執行緒上」
> 是同一個形狀的坑**，兩個 broker 都有。

**⚠️ 但是 —— 這裡有一個 RabbitMQ 沒有的好消息。**

雖然呼叫端什麼都沒接到，**Spring 的預設 `ProducerListener` 有把它記下來**：

```
12:31:50.011 [kafka-producer-network-thread | producer-2] ERROR
  org.springframework.kafka.support.LoggingProducerListener --
  Exception thrown when sending a message with key='k0' and payload='A-0' to topic ch07.send.guard:
org.apache.kafka.common.errors.NotEnoughReplicasException: Messages are rejected since there are
  fewer in-sync replicas than required.
```

**實測：寫法 A 的 200 則，日誌裡有 200 行這樣的 `ERROR`。**

| | RabbitMQ（[01 章 1.3.1](./01-reliable-delivery-three-hops.md)） | Kafka（7.9.1 寫法 A） |
|---|---|---|
| 呼叫端 | 0 個例外 | 0 個例外 |
| 日誌 | ⚠️ **0 行**（要自己開 `publisher-returns`） | ✅ **200 行 ERROR**（`LoggingProducerListener` 預設就在） |
| 你的業務邏輯知道嗎 | ❌ 不知道 | ❌ **一樣不知道** |

📌 **所以 Kafka 的「無聲」比 RabbitMQ 好一點點：它至少會吵。**
但 ⚠️ **「日誌裡有 ERROR」不等於「你的程式知道」** ——
訂單還是會被標記成「已通知」，信還是不會寄出去。

**三種送法的完整對照**：

| | 寫法 A `send()` | 寫法 B `.get()` | 寫法 C `.whenComplete()` |
|---|---|---|---|
| 呼叫端知道失敗嗎 | ❌ | ✅ | ✅ |
| 阻塞呼叫端嗎 | 否 | ⚠️ **是**（預設最久 120 秒） | 否 |
| 吞吐 | 最高 | ⚠️ 最低（7.6.2：`linger.ms` 一設就崩） | 高 |
| 保證順序嗎 | ✅（同一個 key） | ✅ | ✅ |
| 適合 | ❌ 幾乎沒有場景 | 批次工具、測試 | ✅ **業務程式碼** |

📌 **本站的建議：寫法 C + [Outbox](./02-outbox-and-transactional-consistency.md)。**
callback 負責「知道這一則成不成功」，Outbox 負責「行程在知道之前就掛掉」那個縫
（[01 章 1.3.8](./01-reliable-delivery-three-hops.md) 那張表的倒數第二列）。

### 7.9.2 ⚠️ `ProducerListener` 是「一顆 template 一個」

[05 章 5.2](./05-rabbitmq-reliability.md) 踩過「一顆 `RabbitTemplate` 只能掛一個 `ConfirmCallback`」。
**Kafka 這邊一模一樣**：

```java
        var f = KafkaTemplate.class.getDeclaredField("producerListener");
        f.setAccessible(true);
        System.out.println("  預設掛的是 : " + f.get(tpl).getClass().getName());

        tpl.setProducerListener(/* 第一個 listener，計數到 a */);
        tpl.setProducerListener(/* 第二個 listener，計數到 b */);
        for (int i = 0; i < 10; i++) tpl.send(t, "k", "v" + i).get();
```

```
═══ 7.9.2 ProducerListener 是「一顆 template 一個」 ═══
  預設掛的是 : org.springframework.kafka.support.LoggingProducerListener
  掛了兩個 listener，送 10 則之後：第一個收到 0 次、第二個收到 10 次
  ⚠️ setProducerListener() 是覆寫，不是疊加
```

⚠️ **兩個後果**：

1. **你自己掛一個 `ProducerListener`，就把 `LoggingProducerListener` 換掉了** ——
   7.9.1 那 200 行 ERROR 日誌會消失。**要保留的話自己記得 log。**
2. **兩個模組各自 `setProducerListener`，後面那個贏，而且沒有任何警告。**
   要多個關注點的話，自己寫一個會分派的 composite listener。

### 7.9.3 本章建議的設定

```yaml
spring:
  kafka:
    bootstrap-servers: kafka1:9092,kafka2:9092,kafka3:9092   # 多寫幾台，任一台可用即可
    producer:
      # ── 可靠性（7.5） ──
      acks: all
      retries: 2147483647
      properties:
        enable.idempotence: true
        max.in.flight.requests.per.connection: 5
        delivery.timeout.ms: 120000          # ⚠️ 若在請求執行緒上 .get()，改成 3000（7.9.1）
        request.timeout.ms: 30000
        # ── 吞吐與延遲（7.6） ──
        linger.ms: 0                         # ⚠️ 同步送的話「必須」是 0
        compression.type: zstd
        # batch.size 留預設 16384，量過再改（7.6.3 實測預設的 p99 最好）
        max.block.ms: 60000                  # buffer 滿了 / metadata 抓不到時，send() 最多卡多久
      key-serializer: org.apache.kafka.common.serialization.StringSerializer
      value-serializer: org.springframework.kafka.support.serializer.JsonSerializer
```

**topic 這邊**（用程式建，不要靠 auto-create —— 7.8）：

```java
@Configuration
class KafkaTopics {

    @Bean
    NewTopic orderCreated() {
        return TopicBuilder.name(Topics.ORDER_CREATED)
                .partitions(6)                          // 7.7.4：預期峰值消費者數 × 2
                .replicas(3)                            // 7.5.3
                .config("min.insync.replicas", "2")     // 7.5.3：RF 3 − minISR 2 = 容忍 1 台掛掉
                .config("retention.ms", "604800000")    // 7 天，09 章 9.5 會講怎麼決定
                .build();
    }
}
```

⚠️ **`KafkaAdmin` 對「已經存在的 topic」的行為，跟大部分人想的不一樣。** 實測：

```
═══ 斷言② KafkaAdmin.createOrModifyTopics 對既有 topic 做得到什麼 ═══
  建立時 : 分區=2  retention.ms=604800000

  ── 同一支程式改成 partitions(4) + retention.ms=60000，再呼叫一次 ──
  之後   : 分區=4  retention.ms=604800000
```

| 你改了什麼 | `createOrModifyTopics` 的行為 |
|---|---|
| `partitions(2)` → `partitions(4)` | ⚠️ **真的幫你加上去了**（2 → 4） |
| `retention.ms` 604800000 → 60000 | ❌ **完全沒動**，而且**不報錯** |

⚠️ **第一列是一顆地雷。** 有人把 `NewTopic` 的 `partitions()` 從 6 改成 12 然後部署 ——
**7.7.1 那個「67% 的 key 搬家」就會在服務啟動的那一刻自動發生**，沒有任何人按下確認。

📌 **建議**：把 `NewTopic` Bean 當成「第一次建立用」，
**分區數要改的時候走 7.7.4 那個有停機步驟的 SOP，不要靠改程式碼。**
而改 retention 之類的設定要用 CLI：

```bash
docker exec kafka-lab /opt/kafka/bin/kafka-configs.sh --bootstrap-server localhost:29092 \
  --alter --entity-type topics --entity-name order.created.v1 \
  --add-config retention.ms=259200000
```

**送訊息的那一段**：

```java
@Service
public class OrderEventPublisher {

    private final KafkaTemplate<String, OrderEvent> kafka;

    public OrderEventPublisher(KafkaTemplate<String, OrderEvent> kafka) { this.kafka = kafka; }

    public void publish(OrderEvent event) {
        kafka.send(Topics.ORDER_CREATED, event.orderId(), event)    // ← key = aggregateId（7.3.4）
             .whenComplete((result, ex) -> {
                 if (ex != null) {
                     // ⚠️ 這裡是另一條執行緒，不要在這裡丟例外 —— 沒有人會接
                     log.error("送出失敗 orderId={} : {}", event.orderId(), ex.toString());
                     outbox.markFailed(event.eventId(), ex);        // 02 章的 Outbox
                 } else {
                     outbox.markSent(event.eventId());
                 }
             });
    }
}
```

📌 **三個重點**：
① key 是 `orderId`（7.3.4）；
② 用 `whenComplete` 而不是 `.get()`（7.9.1）；
③ ⚠️ **callback 裡丟例外沒有意義** —— 那條執行緒是 producer 的網路執行緒，
沒有人會接住它，而且丟了會影響後續訊息的處理。

---

## 7.10 常見誤區

**① 「Kafka 保證訊息順序」**

⚠️ **它保證的是「同一個分區內」有序。** 7.2.2 實測：三個分區各自都有一個 `off0`，
而「哪一則先送」這件事 Kafka 根本沒有記錄。
**不給 key 就沒有順序保證**（[00 章 0.5.1](./00-course-map-why-message-queue.md) 三個實驗、兩個 ❌）。

**② 「分區開多一點，以後比較好擴」**

✅ **這句話是對的**，但要對得有理由。7.4.1 實測 12 分區 / 6 消費者比 6/6 還快一點（5.43x vs 4.92x），
而 7.7 證明了事後加分區的代價（67% 的 key 搬家 + 5 分鐘的 metadata 混亂期）。
⚠️ **但「多一點」不是「一萬個」** —— 7.2.4 量過，每個分區至少兩個 10 MB 的索引檔，
再加上檔案控制代碼與 controller metadata。**起手式是「峰值消費者數 × 2，至少 6」**（7.7.4）。

**③ 「加消費者就會變快」**

⚠️ **超過分區數之後完全無效。** 7.3.2 實測：8 個消費者 / 6 個分區，
**兩個消費者「（沒分到）」，吞吐比 6 個消費者還低一點**。
📌 **這是 Kafka 跟 RabbitMQ 最大的維運差異**：
RabbitMQ 加消費者一定有效（[05 章 5.4](./05-rabbitmq-reliability.md) 量過 14 倍），Kafka 有硬上限。

**④ 「`acks=all` 保證訊息一定寫進去了」**

⚠️ **它保證的是「ISR 的大小 >= `min.insync.replicas`」，而 ISR 可能只有 1。**
7.5.3 那張表：`RF=1` 時 `acks=all` 完全等於 `acks=1`（[01 章 1.3.7](./01-reliable-delivery-three-hops.md) 的夾擠），
而 `--describe` 上還看得到 `min.insync.replicas=2`。
📌 **查法：找 `ReplicationFactor: 1`，不是找 `min.insync.replicas`。**

**⑤ 「`min.insync.replicas` 設越高越安全」**

⚠️ **它換的是可用性，不是安全性。** 7.5.3 實測：
`RF=2 + min.isr=2` 掉一台 broker → **100% 的 `acks=all` 被拒絕**。
📌 **公式是 `能掉的台數 = RF − min.insync.replicas`。**
`RF=3 + min.isr=2` 才是正式環境的標準答案。

**⑥ 「調大 `linger.ms` 可以提升吞吐」**

⚠️ **要看你怎麼送。** 7.6.2 實測，在 `send().get()` 的寫法下，
`linger.ms=100` 讓吞吐從 **約 4,000 則/秒掉到 9 則/秒**（兩次跑分別是 422 與 469 倍）。
而在「每秒 100 則」的真實速率下（7.6.1），`linger.ms=5` 讓 p50 延遲變 5 倍，
**`每請求筆數` 還是 1.0 —— 什麼都沒買到。**
📌 **`linger.ms` 的正確預設值是 0，除非你量過。**

**⑦ 「小批次 = 低延遲」**

⚠️ **反了。** 7.6.3 實測 `batch.size=1` 的 p99 是 **3,456 ms**，全場最差；
而 `16384` 以上的三檔都在 **100 ms 以內**。
📌 **小批次讓請求次數爆炸，排隊延遲遠大於你省下的批次等待時間。**

**⑧ 「壓縮會犧牲效能」**

⚠️ **在 Kafka 上通常相反。** 7.6.4 實測 `zstd` 的吞吐是 `none` 的 **2 倍以上**，
而且磁碟省了 **14.2 倍**（⚠️ 吞吐是雜訊，但**磁碟數字兩次跑幾乎一模一樣**）。
📌 **壓縮花 CPU、省 I/O，而 Kafka 是 I/O 密集的。**
唯一的例外是 `gzip`（330,578 則/秒，比不壓縮的 480,769 還慢）—— **不要用它**。

**⑨ 「`kafkaTemplate.send()` 沒丟例外就是送成功了」**

⚠️ **7.9.1 實測：200 則全部失敗，呼叫端接到 0 個例外。**
`send()` 是非同步的，失敗發生在另一條執行緒上。
📌 好消息是 Spring 預設的 `LoggingProducerListener` **會在日誌裡留 200 行 ERROR** ——
但 ⚠️ **你的業務邏輯還是不知道**，訂單照樣被標記成「已通知」。

**⑩ 「用 `.get()` 就安全了」**

⚠️ **安全，但你不知道自己會被卡多久。** 7.9.1 實測：
一台 broker 掛掉、完全用預設設定，**一則 `send().get()` 卡了 120,145 ms**
（`delivery.timeout.ms` 預設 120000）。
📌 **在 HTTP 請求執行緒上這樣寫，一台 broker 掛掉就能讓整個服務沒有回應。**

**⑪ 「topic 打錯字會報錯」**

⚠️ **7.8.1 實測：它會被靜默建出來，而且是 1 個分區、RF=1、所有保護都關掉的版本。**
連**消費者訂閱**一個不存在的 topic 都會把它建出來。
📌 broker 端 `auto.create.topics.enable=false` **要重啟才能改**（7.8.2 的實際錯誤訊息），
所以還要加上消費端的 `allow.auto.create.topics: false` 與生產端的啟動檢查。

**⑫ 「把 `NewTopic` 的 `partitions()` 改大再部署就好了」**

⚠️ **這等於在沒有任何人確認的情況下執行了 7.7.1 那個實驗。**
斷言②實測：`createOrModifyTopics` **真的會幫你把 2 個分區加成 4 個**（但不會改 retention）。
📌 **分區數要改，走 7.7.4 的 SOP（停生產者 → lag 清零 → alter → 重啟 producer）。**

---

## 7.11 本章小結

**這一章量了七件事**：

1. **key 決定分區，而那是一行純算數**（7.2.1、7.3.1）：
   `murmur2(key) % 分區數`，手算跟 broker 的答案**六則全對**。
   📌 **後果：分區數一改，同一個 key 的答案就變了**（7.7）。
2. **給了 key，就可以並行到「分區數」為止，而且順序完全不會壞**（7.3.2）：
   1 → 2 → 4 → 6 → 8 個消費者：**79 → 156 → 239 → 428 → 402 則/秒**
   （重跑一次是 78 → 157 → 241 → 391 → 394，**上限大約 5 倍**），
   **最終狀態錯掉的訂單全部是 0 / 200**。
   對照 [05 章 5.5.2](./05-rabbitmq-reliability.md) 的 RabbitMQ：`concurrency=4` 時 **49% 是錯的**。
3. **不給 key 的代價不只是順序，而且它「不確定」**（7.3.3）：
   一次跑出 `p2=150 p3=450`（**4 個消費者只有 1 個在做事，79 則/秒**），
   另一次是 `p3=324 p4=276`（**2 / 4 個在做事，144 則/秒**）。
   ⚠️ **同一份程式碼、同一台機器，連「哪些訊息會落在一起」都預測不了。**
4. **「全域順序」的價碼是 5 倍吞吐，外加失去水平擴充的能力**（7.4）：
   六台消費者不變，分區 1 → 6，**78 → 387 則/秒**，有在做事的消費者 **1/6 → 6/6**。
5. **`min.insync.replicas=2` 在 RF=3 與 RF=2 上是兩件事**（7.5.3）：
   同樣掉一台，RF=3 照常寫入、**RF=2 的 100% `NotEnoughReplicasException`**。
   📌 **能掉的台數 = RF − `min.insync.replicas`。**
   而 ISR 收縮的時間，**關機是 1,517 ms、當機是 8,924 ms**（= `broker.session.timeout.ms` 9000）。
6. **延遲與吞吐真的是同一個旋鈕，而且它在兩種寫法下方向相反**（7.6）：
   - 非同步、每秒 100 則：`linger.ms` 0 → 100，p50 **1.57 → 56.00 ms**，而每請求筆數只從 1.0 變 8.8。
   - 同步 `.get()`：`linger.ms` 0 → 100，吞吐 **3,795 → 9 則/秒**（四百倍以上）。
   - `batch.size` 才是真正的吞吐旋鈕（**29,304 → 732,600**），而 ⚠️ **太小的時候吞吐與 p99 會同時壞掉一個數量級**。
   - 壓縮是**兩邊同時變好**：`zstd` 吞吐是不壓縮的 2 倍以上、磁碟 **14.2 倍**。
7. **分區數幾乎改不回去**（7.7）：3 → 6 分區，**12 個 key 有 8 個搬家（67%）**；
   翻倍也還是 50%；`6 → 7` 是 85.5%。
   而且 ⚠️ **正在跑的 producer 還會用舊分區數送 5 分鐘**（`metadata.max.age.ms=300000`）。
   分區**只能加不能減**（`InvalidPartitionsException`）。

📌 **把 [01 章 1.7](./01-reliable-delivery-three-hops.md) 那張三段總表的 Kafka 第一段填滿**：

```
   ① 生產者 → broker   acks=all + RF≥3 + min.insync.replicas=2   （7.5）
                        key = aggregateId                          （7.3.4）
                        enable.idempotence=true                    （09 章 9.2）
                        whenComplete 接住失敗                       （7.9.1）
   ────────────────────────────────────────────────────────────
   吞吐 / 延遲          batch.size + linger.ms + compression.type  （7.6）
   建 topic             分區數 = 峰值消費者 × 2、RF=3、min.isr=2    （7.7.4、7.9.3）
   防打錯字             auto.create.topics.enable=false + 啟動檢查  （7.8）
```

### 7.11.1 驗收清單

做得到才往下走：

- [ ] 說出 topic / partition / offset / replica 各自是什麼，以及 partition 為什麼在 RabbitMQ 裡沒有對應物。
- [ ] 手算 `murmur2("ORD-1001") % 3`，並說出為什麼 producer 不用問 broker 就知道分區。
- [ ] 解釋「這個 topic 的第 0 則訊息」為什麼是一句沒有意義的話。
- [ ] 讀出 `--describe` 的 `Leader` / `Replicas` / `Isr` 三欄，並說出「`Isr` 比 `Replicas` 短」代表什麼。
- [ ] 說出 console consumer 六個 `print.*` 欄位各自是什麼，以及為什麼它的輸出順序不代表任何東西。
- [ ] 說出一個分區在磁碟上有哪四個檔案，以及 `.index` 為什麼一開就是 10 MB。
- [ ] 從 `kafka-dump-log` 的輸出裡指出 `producerId` / `sequence` / `isTransactional` / `compresscodec` 四個欄位。
- [ ] 解釋 7.3.2 裡「4 個消費者只有 3.00x」與「8 個消費者比 6 個慢」各自的原因。
- [ ] 說出 7.3.3 那個 `p3=600` 的成因，以及它跟 [00 章 0.5.1](./00-course-map-why-message-queue.md) 實驗①是不是同一件事。
- [ ] 說出 key 選 `tenantId` 為什麼可能讓 6 個分區裡有 3 個是空的。
- [ ] 說出「key 是 `null`」與「key 是 `""`」的差別。
- [ ] 量化「分區數 = 1」的代價，並說出它除了吞吐之外還讓你失去哪三樣東西。
- [ ] 說出「消費者的有效數量」的公式。
- [ ] 說出 `acks=all` 成功的**確切**條件（一句話），以及它跟 RF 的關係。
- [ ] 說出 7.5.1 跑了四次之後，哪一條結論站得住、哪一條不行。
- [ ] 算出 `RF=5, min.insync.replicas=3` 能容忍幾台機器掛掉。
- [ ] 說出 `RF=2 + min.isr=2` 為什麼比單機還糟。
- [ ] 說出 `docker stop` 與 `docker kill` 一台 broker，ISR 收縮時間為什麼差 5.9 倍，以及那個 9 秒是哪個設定。
- [ ] 說出 `replica.lag.time.max.ms` 管的是什麼，以及它為什麼不是 7.5.2 那個場景的答案。
- [ ] 說出為什麼 `acks` / `retries` / `enable.idempotence` / `max.in.flight` 四個都要明確寫出來。
- [ ] 解釋 `batch.size` 與 `linger.ms` 是「或」的關係，並說出它對 7.6.1 與 7.6.1b 兩組數字的解釋力。
- [ ] 說出 `linger.ms=100` 在非同步與同步兩種寫法下的效果，以及倍數。
- [ ] 說出 `batch.size=1` 的 p99 為什麼是全場最差。
- [ ] 選一個 `compression.type` 並說出理由，以及為什麼 `gzip` 不該用。
- [ ] 說出 `batch.size` 除了吞吐與延遲之外，還會影響什麼（以及什麼情況下不會）。
- [ ] 說出「訊息太大」相關的三個設定各自在哪一端，以及「只改 producer 與 broker、忘了 consumer」的症狀。
- [ ] 說出 `key=null` 與 `key=""` 各自為什麼只用到一個分區，以及哪一個「永遠不會自己好」。
- [ ] 說出 3 → 6 分區時會搬家的 key 比例，以及為什麼「翻倍比較安全」只對了一半。
- [ ] 說出「加分區」之後那 5 分鐘裡會發生什麼，以及為什麼它比 7.7.1 的斷點更糟。
- [ ] 寫出安全加分區的五個步驟，並說出第 2 步為什麼是關鍵。
- [ ] 說出 `auto.create.topics.enable=true` 的三個具體危害，以及為什麼它不能動態關掉。
- [ ] 說出防止「打錯字」的三道防線，以及第三道為什麼只能自己寫。
- [ ] 說出 topic 命名為什麼不能 `.` 與 `_` 混用，以及混用時的實際錯誤訊息。
- [ ] 說出 `.v1` 解決的是哪一個具體問題。
- [ ] 說出寫法 A / B / C 三種 `send` 各自的「知不知道失敗」與「阻不阻塞」，並選一個給業務程式碼用。
- [ ] 說出「一則 `send().get()` 卡 120 秒」的完整成因鏈，以及三層防法。
- [ ] 說出 `createOrModifyTopics` 對既有 topic 會改什麼、不會改什麼，以及為什麼那是一顆地雷。

### 7.11.2 本章練習

**練習一（20 分鐘）**：把 7.2.1 的 topic 改成 **7 個分區**，重跑。
**記錄**：六則訊息各自落在哪個分區、手算的結果對不對。
然後把 key 換成你自己系統的真實 ID 格式（例如 `2026092200001`），
**回答**：這種「連號」的 key，在 7 個分區上分布均勻嗎？在 8 個分區上呢？
（提示：先想想 `murmur2` 跟「連號」有沒有關係，再實際跑。）

**練習二（30 分鐘）**：重跑 7.3.2，但把消費者固定在 **3 個**，只改分區數（3、6、9、12）。
**記錄每一組的吞吐與「有在做事的消費者」。**
然後回答：**分區數超過消費者數之後，為什麼還會繼續變快一點點？什麼時候會停止變快？**

**練習三（25 分鐘）**：用 7.3.1b 的程式，把租戶權重改成你自己系統的真實分布
（如果不知道，就用 80/15/5）。
**記錄**：6 / 12 / 24 個分區時，最忙的分區各自吃掉多少百分比。
然後回答：**加分區能解決 hot key 嗎？如果不能，該怎麼辦？**
（提示：想想 key 可不可以是 `tenantId + ":" + (orderId.hashCode() % 10)`，以及這樣做**放棄了什麼**。）

**練習四（30 分鐘）**：重跑 7.6.1，但把送出速率改成**每秒 1,000 則**（`gapMs=1`）。
**記錄四組 `linger.ms` 的 p50 / p99 與「每請求筆數」。**
然後回答：**在什麼速率下，`linger.ms=5` 開始「買到東西」？**
把那個速率跟你自己系統的實際流量比一比。

**練習五（25 分鐘）**：把 7.6.4 的 `payload()` 換成**你自己系統的真實訊息**（至少 5 個不同樣本輪流用）。
**記錄五種 `compression.type` 的吞吐與磁碟大小。**
然後回答：你的訊息的最佳選擇跟本章的 `zstd` 一樣嗎？**差多少？**

**練習六（進階，35 分鐘）**：完整重現 7.5.3，但這次建 **四個** topic：
`RF=3/minISR=1`、`RF=3/minISR=2`、`RF=3/minISR=3`、`RF=2/minISR=1`。
然後**依序停掉 kafka3、kafka2**，每停一台就對四個 topic 各送一則 `acks=all`。
**畫一張「幾台活著 × 四種設定」的 2×4 表格，每格填 ✅ 或 ❌。**
然後回答：哪一組設定在「掉一台」與「掉兩台」之間的行為最讓你意外？

**練習七（進階，30 分鐘）**：做一次「加分區」的完整演練：
1. 建一個 3 分區的 topic，送 1,000 則（key 是 `ORD-0` 到 `ORD-199`）。
2. 起一個消費者，**不要**讓它追到 lag=0（故意讓它慢）。
3. 在 lag 還有幾百則的時候 `--alter --partitions 6`。
4. 繼續送 1,000 則。
5. **記錄**：有幾個 `orderId` 的事件跨在兩個分區上、它們被處理的先後順序對不對。
6. 然後照 7.7.4 的 SOP **重做一次**（先停生產者、等 lag 清零再 alter）。
   **記錄這次有幾個 orderId 出問題。**

**練習八（進階，30 分鐘）**：把 7.8.3 的 `TopicGuard` 實作出來，並造三種情況驗證它：
① topic 完全不存在、② topic 是自動建出來的（1 分區 RF=1）、③ topic 是對的。
**驗證三種情況下服務的啟動行為都符合預期。**
然後回答：**這個檢查該放在 `ApplicationReadyEvent` 還是更早？放太早會有什麼問題？**

**練習九（綜合，50 分鐘）**：把 [02 章的 Outbox](./02-outbox-and-transactional-consistency.md)
接到 Kafka 上，完整走一次：
1. `placeOrder()` 在同一個交易裡寫 `orders` 與 `outbox`，`outbox.aggregate_id = orderId`。
2. 輪詢器用 `SKIP LOCKED` 撈出來，用 **7.9.3 的寫法 C** 送出去，callback 回來才 `markSent`。
3. **key 用 `aggregate_id`**（7.3.4 與 [02 章 2.8.2](./02-outbox-and-transactional-consistency.md)）。
4. **演練三種故障**，每一種都記錄「最終資料對不對」以及「Outbox 表裡剩下什麼」：
   - 輪詢器在 callback 回來之前被 `kill -9`
   - `docker stop kafka2`（ISR 收縮，但 RF=3/minISR=2 應該還能寫）
   - `docker stop kafka2 kafka3`（ISR 不足，`acks=all` 全部失敗）
5. **最終驗收**：1,000 張訂單、topic 上 1,000 則（不多不少）、Outbox 表裡 0 則未送。

**這一題做完，你就有 [11-messaging README](./README.md) 那份「產出」第 2 項的 Kafka 版本了。**

---

## 7.12 下一章預告

**生產者這一側講完了。** 你現在會：

- 選 key、選分區數、算出並行度上限（7.3、7.4、7.7）。
- 設對 `acks` / RF / `min.insync.replicas`，並知道它們各自的代價（7.5）。
- 用 `batch.size` / `linger.ms` / `compression.type` 調出你要的延遲與吞吐（7.6）。
- 寫出一個**知道自己失敗了**的生產者（7.9）。

**但這一章從頭到尾，消費者那一側都是黑盒子。** 本章的實驗裡有三件事被我刻意跳過了：

**一、7.3.2 那個「分區分配」是誰決定的？**

```
  ── 消費者 4 個 ──
     分區分配 : p0,p1 | p2,p3 | p4 | p5
```

這四行不是我指定的，是 Kafka 自己分的。**08 章 8.2 會講它怎麼分、有四種分法。**

**二、7.3.2 的程式裡有一行很可疑的註解**：

```java
        // 等到 6 個分區全部被認領，才開始送訊息 —— 這樣量到的是「處理」，不是「入團」
```

「入團」要花時間，而且**每次有人加入或離開，所有人都要重新來一次**。
⚠️ **那個過程叫 rebalance，而它會造成重複處理。**
**08 章 8.3 會實測它** —— [00 章 0.5.2](./00-course-map-why-message-queue.md) 與
[03 章 3.2](./03-idempotent-consumer.md) 的表格都指向那裡。

**三、7.3.2 的消費者從頭到尾沒有提交過位移。**

因為那個實驗不在乎。但 [01 章 1.5.2](./01-reliable-delivery-three-hops.md) 已經證明過
提交位移有多容易搞砸：**自動提交讓 300 則裡的 250 則永遠沒有人處理，而 `lag = 0`。**
**08 章會把正確的提交方式落地**，並把 Spring 的五種 `ack-mode` 各自的故障模式量出來。

**08 章還會兌現兩件欠很久的事**：

- **[00 章 0.4.3](./00-course-map-why-message-queue.md) 說的「08 章 8.7 會把線上出事之後怎麼安全重放寫成 SOP」。**
- **[01 章 1.5.4](./01-reliable-delivery-three-hops.md) 那張表裡的「監控 `max.poll.interval.ms` 踢人事件」** ——
  而那個踢人事件會造成一個很惡毒的迴圈：訊息重來 → 又跑太久 → 又被踢 → **永遠跑不完**。

📌 **一句話預告 08 章**：

> **07 章決定了「訊息長什麼樣、在哪裡」，08 章決定「誰來讀、讀到哪、出事怎麼回頭」。**
> 而 Kafka 的消費端只有一個狀態：**一個數字**（offset）。
> **這一章所有的坑，都來自「那個數字什麼時候被寫下來」。**
