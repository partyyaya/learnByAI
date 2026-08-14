# 第 08 章：Pub/Sub 與 Stream

> Redis 有三種做「訊息傳遞」的方式，而它們的可靠性差異巨大，卻常被混著用。
> Pub/Sub 是**即發即失**的：訂閱者不在線，訊息就永久消失，沒有任何補救機會。很多人拿它做訂單通知、發送郵件的觸發，然後在某次服務重啟後發現有一批訂單「沒有後續動作」，而且**完全無法追查**——因為那些訊息從來沒有被儲存過。
> Stream 是 Redis 5.0 為了補上這個缺口而設計的：它有持久化、有消費者群組、有確認機制、能重放。
> 這章要建立的判斷是：什麼時候可以用 Pub/Sub、什麼時候必須用 Stream、什麼時候該老實用 Kafka。

---

## 8.1 學習目標

完成本章後，你應該可以：

- 說明 Pub/Sub 的「即發即失」語意，以及它會在哪些情況下丟訊息。
- 說出訂閱狀態下客戶端的行為限制，以及訂閱者緩衝區的風險。
- 用 keyspace notification 做快取失效通知，並說明它為什麼不可靠。
- 說明 Cluster 模式下 Pub/Sub 的廣播問題，以及 7.0 的 sharded Pub/Sub。
- 用 Stream 的 `XADD` / `XREAD` 實作基本的訊息生產與消費。
- 用消費者群組實作多消費者的可靠消費，包含 `XACK`、`XPENDING`、`XAUTOCLAIM`。
- 設計死信處理與冪等消費。
- 說出 Stream 和 Kafka、RabbitMQ 的分界線在哪。

---

## 8.2 三種方案的定位

| | Pub/Sub | List | Stream |
|---|---------|------|--------|
| 訊息持久化 | **否** | 是 | 是 |
| 訂閱者離線時的訊息 | **永久遺失** | 保留在 List 裡 | 保留在 Stream 裡 |
| 多消費者 | 廣播（每人都收到） | 競爭（一人一條） | 兩者都支援 |
| 確認機制（ack） | 無 | 無 | **有** |
| 訊息重放 | 不可能 | 消費即消失 | **可以** |
| 消費進度追蹤 | 無 | 無 | **有** |
| 訊息 ID | 無 | 無 | 有（時間序） |
| 記憶體控制 | 不佔（不儲存） | 要自己 `LTRIM` | `MAXLEN` / `MINID` |
| 典型用途 | 通知、廣播 | 簡單任務佇列 | 可靠的事件流 |

**一句話的選擇規則：**

```text
訊息丟了完全沒關係（純通知，且有其他兜底機制）  -> Pub/Sub
訊息不能丟，但需求很簡單，能容忍偶爾重做        -> List（配合補償）
訊息不能丟，需要多消費者、確認、重試、追蹤      -> Stream
高吞吐、長期保存、需要重放歷史、多消費者組      -> Kafka
複雜路由、優先級、延遲隊列、成熟的死信機制      -> RabbitMQ
```

---

## 8.3 Pub/Sub：即發即失的廣播

### 基本用法

終端 A（訂閱者）：

```bash
SUBSCRIBE news:tech
# 1) "subscribe"
# 2) "news:tech"
# 3) (integer) 1
# 進入訂閱模式，持續等待訊息
```

終端 B（發布者）：

```bash
PUBLISH news:tech "Redis 8 released"
# (integer) 1        <- 回傳「收到這則訊息的訂閱者數量」
```

終端 A 會立刻看到：

```text
1) "message"
2) "news:tech"
3) "Redis 8 released"
```

### 模式訂閱

```bash
PSUBSCRIBE news:*          # 訂閱所有 news: 開頭的頻道
PSUBSCRIBE user:*:notify

PUBSUB CHANNELS            # 列出有訂閱者的頻道
PUBSUB CHANNELS "news:*"
PUBSUB NUMSUB news:tech    # 某頻道的訂閱者數
PUBSUB NUMPAT              # 模式訂閱的數量
```

### 它為什麼會丟訊息

**`PUBLISH` 的實作是：找出當前所有訂閱這個頻道的連線，把訊息寫進它們的輸出緩衝區，然後結束。**

訊息不會被儲存在任何地方。所以：

```text
情境 1：發布時沒有任何訂閱者
  -> PUBLISH 回傳 0，訊息直接消失
  -> 之後才上線的訂閱者永遠收不到

情境 2：訂閱者正在重啟 / 部署
  -> 這段時間的訊息全部遺失

情境 3：訂閱者的網路斷了幾秒
  -> 斷線期間的訊息遺失

情境 4：訂閱者處理不過來，輸出緩衝區超過限制
  -> Redis 直接斷開這個訂閱者（見下）
  -> 之後的訊息也收不到，直到它重連
```

**`PUBLISH` 的回傳值是唯一的線索**——它告訴你有幾個訂閱者收到了。如果是 0，你就知道這則訊息沒人收到。但 Redis 不會幫你做任何補救。

### 訂閱者緩衝區的風險

第 05 章提過的設定：

```bash
CONFIG GET client-output-buffer-limit
# "normal 0 0 0 slave 268435456 67108864 60 pubsub 33554432 8388608 60"
#                                            ^^^^^^ 訂閱者：硬限制 32MB，軟限制 8MB 持續 60 秒
```

**如果訂閱者消費得比發布速度慢，緩衝區會累積，超過限制時 Redis 會主動斷開它。**

這在實務上會造成很難察覺的問題：

```text
1. 訂閱者的處理邏輯裡有一個慢查詢
2. 訊息累積在 Redis 的輸出緩衝區
3. 超過 32MB，Redis 斷開連線
4. 客戶端庫自動重連（多數會這樣做）
5. 重連期間的訊息全部遺失
6. 因為自動重連了，監控上看起來一切正常
```

**排查方式：**

```bash
CLIENT LIST TYPE pubsub
# id=8 addr=... omem=25165824 ...      <- omem 是輸出緩衝區大小

INFO stats | grep pubsub
```

**設計原則：訂閱者的處理邏輯必須極快。** 收到訊息後應該立刻放進本地佇列，用另一個執行緒處理，不要在回呼裡做慢操作。

### 訂閱狀態的命令限制

用 RESP2 協定（多數客戶端的預設）時，**一個進入訂閱模式的連線只能執行少數命令**：

```bash
SUBSCRIBE news:tech
GET foo
# (error) ERR Can't execute 'get': only (P|S)SUBSCRIBE / (P|S)UNSUBSCRIBE / PING / QUIT / RESET are allowed in this context
```

**推論：訂閱要用獨立的連線。** 你不能用同一個連線既訂閱又執行普通命令。

多數客戶端庫會自動處理（例如 ioredis 建議 `redis.duplicate()` 開一個專用連線）：

```javascript
const subscriber = redis.duplicate();
await subscriber.subscribe('cache:invalidate');
subscriber.on('message', (channel, message) => {
  localCache.delete(message);      // 保持極快
});

// 主連線繼續做普通操作
await redis.get('foo');
```

RESP3 協定（Redis 6.0+）取消了這個限制，訂閱和普通命令可以共用連線。但要客戶端庫支援，而且用獨立連線在架構上更清楚，所以這個做法仍然值得保持。

### Cluster 模式的廣播問題

**在 Redis Cluster 裡，`PUBLISH` 會被廣播到叢集中的所有節點。**

原因是 Redis 無法知道訂閱者連在哪個節點上，所以只能全部轉發一份。後果是：

```text
一個 10 節點的 Cluster，發布一則 1KB 的訊息
=> 節點間產生 10 份轉發流量
=> 高頻發布時，Pub/Sub 的流量會佔滿叢集的內部網路
```

這是 Cluster 環境下 Pub/Sub 的重大限制。**Redis 7.0 引入了 sharded Pub/Sub 解決它：**

```bash
SSUBSCRIBE news:tech       # 分片訂閱
SPUBLISH news:tech "..."   # 分片發布
SUNSUBSCRIBE news:tech
```

Sharded Pub/Sub 用**頻道名稱計算 slot**，訊息只會發送到負責該 slot 的節點（及其從節點）。這消除了全叢集廣播。

代價是：訂閱者必須連到正確的節點（客戶端庫要支援路由）。**如果你在 Cluster 上有高頻 Pub/Sub 需求，一定要用 sharded 版本。**

### keyspace notification：監聽 key 的變化

Redis 可以在 key 發生變化時發布事件到特定頻道：

```bash
CONFIG SET notify-keyspace-events "KEA"    # 開啟所有事件
```

參數是一串旗標的組合：

| 旗標 | 意義 |
|------|------|
| `K` | keyspace 事件，頻道格式 `__keyspace@<db>__:<key>` |
| `E` | keyevent 事件，頻道格式 `__keyevent@<db>__:<event>` |
| `g` | 通用命令（DEL、EXPIRE、RENAME 等） |
| `$` | String 命令 |
| `l` `s` `h` `z` `x` `t` | List / Set / Hash / ZSet / Stream / Stream 相關 |
| `e` | 驅逐事件 |
| `x` | 過期事件 |
| `n` | 新 key 事件（7.0+） |
| `A` | `g$lshzxet` 的簡寫（不含 `n` 和 `m`） |

使用範例：

```bash
# 訂閱所有 key 的過期事件
PSUBSCRIBE "__keyevent@0__:expired"

# 訂閱特定 key 的所有事件
SUBSCRIBE "__keyspace@0__:user:1001"
```

**常見用途是「快取失效通知」**：

```javascript
const subscriber = redis.duplicate();
await subscriber.psubscribe('__keyevent@0__:del', '__keyevent@0__:expired');

subscriber.on('pmessage', (pattern, channel, key) => {
  localCache.delete(key);      // 有人刪了 Redis 的 key，同步清掉本地快取
});
```

**但這個機制有幾個重要限制，用之前必須知道：**

**限制 1：它是 Pub/Sub，所以不可靠。** 訂閱者離線期間的事件全部遺失。所以**不能用它做「必須執行的業務動作」**（例如「訂單 key 過期就取消訂單」——第 02 章練習提過，這種需求要用 ZSet 輪詢）。

**限制 2：過期事件的時機不準。** 第 01 章講過，key 過期不是準時刪除的。`expired` 事件是在「Redis 實際刪除這個 key 時」才發出，可能比 TTL 到期晚很多（惰性刪除的情況下，甚至要等到有人來讀它）。

**限制 3：有效能開銷。** 每個符合條件的操作都要發布一則訊息。開 `KEA`（所有事件）在高 QPS 下會產生大量 Pub/Sub 流量。**建議只開你真正需要的事件類型**：

```bash
CONFIG SET notify-keyspace-events "Egx"    # 只要 keyevent 的通用命令 + 過期事件
```

**限制 4：只通知 key 名稱，不含 value。** 你只會知道「`user:1001` 被刪了」，不知道它原本是什麼。

### Pub/Sub 的合適場景

```text
適合：
  快取失效通知（有 TTL 兜底，漏一次只是本地快取多留一會兒）
  設定變更廣播（有定期輪詢兜底）
  即時聊天（訊息另外存資料庫，Pub/Sub 只負責即時推送）
  監控事件、日誌廣播
  節點間的協調訊號

不適合：
  訂單狀態變更 -> 觸發後續業務流程
  發送郵件 / 推播的任務分發
  任何「漏掉一則就會出錯」的場景
```

**判斷準則：如果這則訊息漏掉了，會不會有人來投訴？** 會的話就不能用 Pub/Sub。

---

## 8.4 Stream：可靠的事件流

Stream 是一個**只能追加的有序訊息日誌**，每則訊息有唯一 ID 和多個 field-value。

### 訊息 ID 的結構

```text
1786000000123-0
^^^^^^^^^^^^^ ^
毫秒時間戳     同一毫秒內的序號
```

ID 是**單調遞增**的，這是 Stream 能做範圍查詢與斷點續傳的基礎。

### 基本操作

```bash
# 加入訊息，* 表示自動產生 ID
XADD orders:events "*" type "created" orderId "8888" amount "2990"
# "1786000000123-0"

XADD orders:events "*" type "paid" orderId "8888"
# "1786000000456-0"

XLEN orders:events
# (integer) 2

# 範圍查詢：- 是最小 ID，+ 是最大 ID
XRANGE orders:events - +
# 1) 1) "1786000000123-0"
#    2) 1) "type"
#       2) "created"
#       3) "orderId"
#       4) "8888"
#       5) "amount"
#       6) "2990"
# 2) ...

XRANGE orders:events - + COUNT 10           # 限制數量
XRANGE orders:events 1786000000123 +        # 從某個時間戳開始
XRANGE orders:events "(1786000000123-0" +   # 開區間，排除這一筆（6.2+）
XREVRANGE orders:events + - COUNT 5         # 反向（取最新 5 筆）
```

`XRANGE` 用時間戳當起點這件事很實用——**你可以直接查「昨天下午三點之後的所有事件」**，不需要額外的索引。

### `XREAD`：讀取新訊息

```bash
# 讀取 ID 大於指定值的訊息
XREAD COUNT 10 STREAMS orders:events 0
# 從頭開始讀（0 表示比任何 ID 都小）

# $ 表示「只要之後新進來的訊息」
XREAD BLOCK 5000 STREAMS orders:events "$"
# 阻塞最多 5 秒等新訊息，BLOCK 0 = 無限等

# 可以同時讀多個 stream
XREAD BLOCK 0 STREAMS stream1 stream2 "$" "$"
```

**`XREAD` 的重點是它不記錄消費進度**——你必須自己記住「上次讀到哪個 ID」，下次從那裡繼續：

```javascript
let lastId = '$';      // 從現在開始

while (running) {
  const result = await redis.xread('BLOCK', 5000, 'COUNT', 100,
    'STREAMS', 'orders:events', lastId);

  if (!result) continue;      // 超時，沒有新訊息

  for (const [stream, entries] of result) {
    for (const [id, fields] of entries) {
      await handle(id, fields);
      lastId = id;            // 更新進度，必須自己維護
    }
  }
}
```

**這個模式的問題：** 如果消費者崩潰，`lastId` 存在記憶體裡就沒了。重啟後要嘛從 `$` 開始（漏掉中間的訊息），要嘛從 `0` 開始（重複處理全部）。你得自己把進度存到某個地方。

**消費者群組就是為了解決這件事——讓 Redis 幫你記進度。**

### 記憶體控制：一定要設裁切

Stream 會一直成長，所以**必須有裁切策略**（第 04 章的 big key 教訓）：

```bash
# 寫入時就裁切：只保留最新 10000 筆
XADD orders:events MAXLEN 10000 "*" type "created" orderId "8888"

# 加上 ~ 表示「近似裁切」，效能好得多
XADD orders:events MAXLEN "~" 10000 "*" type "created" orderId "8888"

# 按 ID 裁切：刪除 ID 小於指定值的（適合「只保留最近 7 天」）
XADD orders:events MINID "~" 1785400000000 "*" type "created"

# 也可以單獨執行裁切
XTRIM orders:events MAXLEN "~" 10000
XTRIM orders:events MINID "~" 1785400000000
```

**`~` 的意義值得說清楚。** Stream 內部把訊息存在一連串的節點（listpack）裡。精確裁切（`=`，預設）可能需要拆開一個節點只刪掉其中幾筆；近似裁切（`~`）只在「整個節點都可以刪」時才刪，所以實際保留量會**稍多於**你指定的數字。

```text
MAXLEN 10000      -> 精確保留 10000 筆，可能需要拆節點，較慢
MAXLEN ~ 10000    -> 保留至少 10000 筆（可能是 10050），只刪整個節點，快
```

**生產環境幾乎都該用 `~`。** 多留幾十筆完全沒差，但效能差異在高頻寫入下很明顯。

`MINID` 的用法特別值得推薦：因為 Stream ID 的前半就是毫秒時間戳，所以「只保留最近 7 天」可以直接算出來：

```javascript
const sevenDaysAgo = Date.now() - 7 * 86400 * 1000;
await redis.xtrim('orders:events', 'MINID', '~', sevenDaysAgo);
```

**這比 `MAXLEN` 更符合業務語意**——你通常想的是「保留多久」而不是「保留幾筆」。

### `XDEL` 的限制

```bash
XDEL orders:events 1786000000123-0
# (integer) 1
```

**注意 `XDEL` 只是把訊息標記為刪除，不會立刻釋放記憶體**（要等整個節點都被刪除時才會）。而且**它不會影響已經在 pending 清單裡的記錄**——消費者群組仍然認為那則訊息待確認，只是讀不到內容了。

所以 `XDEL` 不是「撤回訊息」的可靠手段。實務上很少用到它。

---

## 8.5 消費者群組：可靠消費的核心

消費者群組（Consumer Group）讓多個消費者**分擔**同一個 Stream 的訊息，並由 Redis 追蹤每則訊息的處理狀態。

### 核心概念

```text
Stream: orders:events
  ├── 群組 A（例如「發送通知」服務）
  │     ├── consumer-1
  │     ├── consumer-2
  │     └── PEL（Pending Entries List：已投遞但未確認的訊息）
  │
  └── 群組 B（例如「更新統計」服務）
        ├── consumer-1
        └── PEL

同一則訊息會被「每個群組」各處理一次
但在同一個群組內，只會被「一個消費者」處理
```

**這個設計同時支援兩種模式：** 群組之間是廣播（每個群組都收到），群組內是競爭（一個消費者拿一條）。這正好對應「同一個事件要觸發多個不同的下游服務，每個服務內部又要水平擴展」的真實需求。

### 建立群組

```bash
# 從「現在」開始消費（$ = 只處理新訊息）
XGROUP CREATE orders:events notify-group "$"

# 從頭開始消費（0 = 處理所有歷史訊息）
XGROUP CREATE orders:events stats-group 0

# 如果 Stream 還不存在，用 MKSTREAM 一併建立
XGROUP CREATE orders:events notify-group "$" MKSTREAM
```

**`MKSTREAM` 很重要**：如果 Stream 不存在，`XGROUP CREATE` 會報錯。而在真實部署中，消費者服務常常比生產者先啟動——這時 Stream 還不存在。加上 `MKSTREAM` 可以避免啟動失敗。

```javascript
async function ensureGroup(stream, group) {
  try {
    await redis.xgroup('CREATE', stream, group, '$', 'MKSTREAM');
  } catch (err) {
    // BUSYGROUP 代表群組已存在，這是正常的
    if (!String(err.message).includes('BUSYGROUP')) throw err;
  }
}
```

### 讀取與確認

```bash
# > 表示「還沒有投遞給任何消費者的新訊息」
XREADGROUP GROUP notify-group consumer-1 COUNT 10 BLOCK 5000 STREAMS orders:events ">"

# 處理完成後確認
XACK orders:events notify-group 1786000000123-0
# (integer) 1
```

**`XREADGROUP` 的第二個 ID 選項有兩種完全不同的語意：**

| ID | 意義 |
|----|------|
| `>` | 取「從未投遞給任何消費者」的新訊息，並登記到這個消費者的 PEL |
| `0`（或任何具體 ID） | 取「這個消費者自己的 PEL 中，ID 大於此值」的訊息——也就是**它之前拿過但還沒 ack 的** |

第二種用法是崩潰恢復的關鍵：

```javascript
// 消費者啟動時，先處理自己上次沒 ack 完的訊息
const pending = await redis.xreadgroup(
  'GROUP', group, consumerName, 'COUNT', 100,
  'STREAMS', stream, '0'
);
// 處理完這些，再開始用 '>' 讀新訊息
```

### 完整的消費者實作

```javascript
async function runConsumer(stream, group, consumerName) {
  await ensureGroup(stream, group);

  // 階段 1：先清理自己的 PEL（上次崩潰前沒 ack 的）
  let cursor = '0';
  while (true) {
    const result = await redis.xreadgroup(
      'GROUP', group, consumerName, 'COUNT', 100,
      'STREAMS', stream, cursor
    );
    if (!result) break;
    const entries = result[0][1];
    if (entries.length === 0) break;

    for (const [id, fields] of entries) {
      await processMessage(stream, group, id, fields);
      cursor = id;
    }
  }

  // 階段 2：持續消費新訊息
  while (running) {
    let result;
    try {
      result = await redis.xreadgroup(
        'GROUP', group, consumerName, 'COUNT', 10, 'BLOCK', 5000,
        'STREAMS', stream, '>'
      );
    } catch (err) {
      logger.error({ err }, 'XREADGROUP 失敗');
      await sleep(1000);
      continue;
    }

    if (!result) continue;      // BLOCK 超時，正常

    for (const [, entries] of result) {
      for (const [id, fields] of entries) {
        await processMessage(stream, group, id, fields);
      }
    }
  }
}

async function processMessage(stream, group, id, fields) {
  const data = fieldsToObject(fields);
  try {
    await handleBusinessLogic(data);
    // 只有成功才 ack
    await redis.xack(stream, group, id);
  } catch (err) {
    logger.error({ err, id, data }, '處理失敗，保留在 PEL 等待重試');
    // 不 ack，訊息會留在 PEL，之後由 XAUTOCLAIM 重新分配
  }
}
```

**關鍵設計：處理失敗時「不要 ack」。** 訊息會留在 PEL 裡，之後可以被重新認領處理。這就是可靠消費的機制。

### `XPENDING`：查看待確認的訊息

```bash
# 摘要形式
XPENDING orders:events notify-group
# 1) (integer) 5                       <- PEL 裡有 5 則
# 2) "1786000000123-0"                 <- 最小 ID
# 3) "1786000000999-0"                 <- 最大 ID
# 4) 1) 1) "consumer-1"
#       2) "3"
#    2) 1) "consumer-2"
#       2) "2"

# 詳細形式
XPENDING orders:events notify-group - + 10
# 1) 1) "1786000000123-0"      <- 訊息 ID
#    2) "consumer-1"            <- 目前歸屬的消費者
#    3) (integer) 92000         <- 已閒置多久（毫秒）
#    4) (integer) 3             <- 已投遞次數

# 只看閒置超過 60 秒的
XPENDING orders:events notify-group IDLE 60000 - + 10

# 只看某個消費者的
XPENDING orders:events notify-group - + 10 consumer-1
```

**`XPENDING` 的摘要數字就是最重要的監控指標。** PEL 持續增長代表有訊息處理不了——可能是消費者掛了、或某些訊息會固定失敗（毒訊息）。

### `XAUTOCLAIM`：自動認領超時的訊息

如果一個消費者拿了訊息之後崩潰，那些訊息會永遠留在它的 PEL 裡。需要有機制把它們轉移給其他消費者。

```bash
# 認領閒置超過 60 秒的訊息（6.2+）
XAUTOCLAIM orders:events notify-group consumer-2 60000 0 COUNT 10
# 1) "0-0"                           <- 下一輪的游標（0-0 表示掃完一輪了）
# 2) 1) 1) "1786000000123-0"         <- 認領到的訊息
#       2) 1) "type"
#          2) "created"
# 3) (empty array)                   <- 已經不存在的訊息 ID（會自動從 PEL 移除）
```

舊版的 `XCLAIM` 需要你先用 `XPENDING` 查出 ID 再逐個認領，`XAUTOCLAIM` 一步完成，**優先用它**。

```javascript
// 獨立的認領任務，定期執行
async function claimStale(stream, group, consumerName, minIdleMs = 60000) {
  let cursor = '0-0';
  do {
    const [next, entries] = await redis.xautoclaim(
      stream, group, consumerName, minIdleMs, cursor, 'COUNT', 10
    );

    for (const [id, fields] of entries) {
      const info = await getDeliveryCount(stream, group, id);

      // 投遞次數過多，判定為毒訊息，送進死信
      if (info.deliveryCount > 5) {
        await moveToDeadLetter(stream, group, id, fields, info.deliveryCount);
        continue;
      }

      await processMessage(stream, group, id, fields);
    }

    cursor = next;
  } while (cursor !== '0-0');
}
```

### 死信處理

**投遞次數（delivery count）是判斷毒訊息的依據。** 如果一則訊息被投遞了五次都失敗，繼續重試只是浪費資源，應該移出主流程：

```javascript
async function moveToDeadLetter(stream, group, id, fields, deliveryCount) {
  const dlqStream = `${stream}:dlq`;

  // 1. 寫進死信 Stream，保留原始資訊與失敗原因
  await redis.xadd(dlqStream, 'MAXLEN', '~', 10000, '*',
    'originalId', id,
    'originalStream', stream,
    'group', group,
    'deliveryCount', String(deliveryCount),
    'failedAt', String(Date.now()),
    'payload', JSON.stringify(fieldsToObject(fields)),
  );

  // 2. 從原 PEL 移除，避免無限重試
  await redis.xack(stream, group, id);

  // 3. 一定要告警，死信必須有人看
  alert(`訊息進入死信：${stream}/${id}，已投遞 ${deliveryCount} 次`);
}
```

**三個設計要點：**

**要點一：死信 Stream 也要設 `MAXLEN`。** 否則它自己會變成 big key。

**要點二：必須告警。** 死信最常見的失敗模式是「訊息進去了但沒人知道」，累積幾個月後才發現有幾千筆訂單沒處理。

**要點三：要有重放機制。** 修好 bug 之後，要能把死信裡的訊息重新投回主 Stream：

```javascript
async function replayDeadLetter(stream, count = 100) {
  const entries = await redis.xrange(`${stream}:dlq`, '-', '+', 'COUNT', count);
  for (const [dlqId, fields] of entries) {
    const data = fieldsToObject(fields);
    await redis.xadd(stream, '*', ...objectToFields(JSON.parse(data.payload)));
    await redis.xdel(`${stream}:dlq`, dlqId);
  }
}
```

### 消費者的生命週期管理

消費者名稱是 Redis 在第一次 `XREADGROUP` 時自動建立的，但**不會自動清理**：

```bash
XINFO CONSUMERS orders:events notify-group
# 1) 1) "name"
#    2) "consumer-1"
#    3) "pending"
#    4) (integer) 3
#    5) "idle"
#    6) (integer) 1200000        <- 閒置 20 分鐘，可能已經死了
#    7) "inactive"
#    8) (integer) 1200000

# 刪除消費者（注意：它的 PEL 訊息會一併移除！）
XGROUP DELCONSUMER orders:events notify-group consumer-1
# (integer) 3        <- 回傳被移除的 pending 數量
```

**`XGROUP DELCONSUMER` 很危險：它會把該消費者 PEL 裡的訊息直接丟掉，那些訊息不會被任何人處理。**

正確順序是：**先用 `XAUTOCLAIM` 把它的訊息轉移出去，確認 pending 為 0，才刪除消費者。**

如果你的消費者名稱是隨機產生的（例如帶上主機名和行程 ID），那麼每次部署都會產生新的消費者，舊的殘留下來。**建議用穩定的消費者名稱**（例如 Kubernetes 的 StatefulSet 序號、或固定的 worker 編號），這樣重啟後能自動接手自己的 PEL。

### 其他管理命令

```bash
XINFO STREAM orders:events              # Stream 的整體資訊
XINFO STREAM orders:events FULL         # 含 PEL 的完整細節（除錯用）
XINFO GROUPS orders:events              # 所有群組的狀態
XINFO CONSUMERS orders:events notify-group

XGROUP SETID orders:events notify-group 0    # 重設群組的消費位置（可用來重放）
XGROUP DESTROY orders:events notify-group    # 刪除群組
XSETID orders:events 1786000000000-0         # 修改 Stream 的最後 ID（謹慎）
```

`XINFO GROUPS` 的輸出裡有兩個關鍵指標：

```bash
XINFO GROUPS orders:events
# 1)  1) "name"
#     2) "notify-group"
#     3) "consumers"
#     4) (integer) 3
#     5) "pending"
#     6) (integer) 152          <- PEL 大小，該監控
#     7) "last-delivered-id"
#     8) "1786000000999-0"
#     9) "entries-read"
#    10) (integer) 8421
#    11) "lag"
#    12) (integer) 45            <- 落後多少則訊息，該監控
```

**`lag` 是最重要的監控指標**（7.0+）：它告訴你這個群組還有多少訊息沒讀。持續增長就代表消費能力不足，要擴消費者。

---

## 8.6 冪等消費：必要的設計

**任何可靠訊息系統都只能保證「至少一次」投遞，不可能保證「恰好一次」。** 原因是：

```text
消費者處理成功了，但在 XACK 之前崩潰
=> 訊息還在 PEL 裡
=> 之後會被重新投遞
=> 同一則訊息被處理兩次
```

這個窗口無法消除（`XACK` 和業務處理不可能是一個原子操作，因為業務處理通常在 Redis 之外）。

**所以消費邏輯必須是冪等的。** 三種常見做法：

### 做法 1：用訊息 ID 去重

```javascript
async function processIdempotent(stream, group, id, fields) {
  const dedupKey = `processed:${group}:${id}`;

  // SET NX 保證只有第一次能成功
  const isFirst = await redis.set(dedupKey, '1', 'NX', 'EX', 86400);

  if (!isFirst) {
    // 已經處理過，直接 ack
    await redis.xack(stream, group, id);
    return;
  }

  try {
    await handleBusinessLogic(fieldsToObject(fields));
    await redis.xack(stream, group, id);
  } catch (err) {
    // 失敗要把去重標記刪掉，否則重試會被誤判為「已處理」
    await redis.del(dedupKey);
    throw err;
  }
}
```

**注意 catch 裡的 `del`。** 少了這行，一則處理失敗的訊息會被永久標記為「已處理」，重試時直接跳過——訊息實質上遺失了。這是這個模式最常見的 bug。

### 做法 2：業務層的唯一約束（最可靠）

```javascript
// 用資料庫的唯一索引擋住重複
await db.query(
  'INSERT INTO notifications (message_id, user_id, content) VALUES (?, ?, ?) ' +
  'ON DUPLICATE KEY UPDATE message_id = message_id',
  [messageId, userId, content]
);
```

**這是最可靠的方式**，因為約束由資料庫保證，不依賴 Redis 的狀態。如果你的處理邏輯本身就是寫資料庫，優先用這個。

### 做法 3：讓操作天然冪等

```javascript
// 非冪等：重複執行會加兩次
await redis.incrby('counter', 1);

// 冪等：重複執行結果相同
await redis.set('order:8888:status', 'paid');
await redis.zadd('rank', 'GT', score, member);
```

設計訊息內容時就用「最終狀態」而不是「增量」，能省掉很多去重邏輯。

```text
訊息內容設計：
  差：{ action: "add_points", delta: 50 }        -> 重複執行會多加
  好：{ action: "set_points", value: 1250 }      -> 重複執行結果相同
```

---

## 8.7 Stream 和 Kafka、RabbitMQ 的分界

**Stream 不是 Kafka 的替代品。** 明確的分界線：

| | Redis Stream | Kafka | RabbitMQ |
|---|-------------|-------|----------|
| 儲存位置 | **記憶體**（有持久化但受記憶體限制） | 磁碟 | 記憶體 + 磁碟 |
| 保留時間 | 受記憶體限制，通常小時到天 | 天到月，可 TB 級 | 通常短期 |
| 吞吐量 | 十萬級 msg/s | 百萬級 msg/s | 萬級 msg/s |
| 分區 / 並行 | 靠多個 Stream key 手工分片 | 原生 partition | 靠多 queue |
| 訊息重放 | 可以（在保留範圍內） | **強項**，可從任意 offset 重放 | 較弱 |
| 消費者組 rebalance | 手動（自己做認領） | 自動 | 不適用 |
| 複雜路由 | 無 | 無 | **強項**（exchange、routing key） |
| 延遲隊列 / 優先級 | 要自己用 ZSet 做 | 無原生支援 | **有** |
| 運維複雜度 | **最低**（可能你已經有 Redis 了） | 高（ZooKeeper/KRaft、分區管理） | 中 |
| 生態與工具 | 較少 | 豐富（Connect、Streams、CDC） | 成熟 |

### 選擇建議

**用 Redis Stream 的情況：**

```text
你已經在用 Redis，不想再引入一套系統
訊息量在十萬 msg/s 以內
保留需求是小時到幾天
需要的是「可靠的異步任務」而不是「事件流平台」
團隊沒有 Kafka 的維運能力
```

典型例子：訂單建立後觸發通知、圖片上傳後觸發轉檔、使用者行為的異步統計。

**換用 Kafka 的訊號：**

```text
訊息量超過 Redis 單實例能承受的範圍
需要保留數週或數月的資料（記憶體成本會爆）
需要從歷史任意位置重放（例如重算一個月的報表）
需要 CDC、資料湖、串流處理等生態能力
有多個團隊要消費同一份資料流
```

**換用 RabbitMQ 的訊號：**

```text
需要複雜的路由規則（topic exchange、header 路由）
需要原生的延遲隊列與優先級隊列
需要成熟的死信交換機與重試策略
訊息量不大但業務規則複雜
```

**一個實用的判斷：如果你發現自己在 Redis Stream 上手工實作分區、rebalance、offset 管理，那就是該換 Kafka 的訊號了。**

---

## 8.8 常見錯誤

### 錯誤 1：用 Pub/Sub 做不能丟訊息的業務

訂閱者離線期間的訊息永久消失，且無法追查。用 Stream。

### 錯誤 2：在 Pub/Sub 的回呼裡做慢操作

訊息會累積在輸出緩衝區，超過 32MB 時連線被斷開，斷線期間的訊息全部遺失。回呼要極快。

### 錯誤 3：用同一個連線訂閱又執行普通命令

RESP2 下會報錯。用獨立連線。

### 錯誤 4：在 Cluster 用高頻 Pub/Sub

會全叢集廣播，吃滿內部網路。7.0+ 用 sharded Pub/Sub（`SPUBLISH`/`SSUBSCRIBE`）。

### 錯誤 5：用 keyspace notification 的過期事件觸發業務動作

事件不可靠（Pub/Sub）且時機不準（惰性刪除）。用 ZSet 輪詢。

### 錯誤 6：Stream 沒設 `MAXLEN` 或 `MINID`

會無限成長變成 big key。而且 Stream 通常是高頻寫入，長得特別快。

### 錯誤 7：處理失敗時仍然 `XACK`

訊息就永久遺失了。失敗要保留在 PEL，靠 `XAUTOCLAIM` 重試。

### 錯誤 8：沒有處理 PEL，導致訊息永遠卡住

消費者崩潰後，它的 PEL 訊息不會自動轉移。必須有獨立的 `XAUTOCLAIM` 任務。

### 錯誤 9：沒有死信機制

一則永遠處理失敗的毒訊息會被無限重試，消耗資源並可能阻塞後續處理。

### 錯誤 10：假設訊息只會被處理一次

只有「至少一次」保證。消費邏輯必須冪等。

### 錯誤 11：去重鍵在處理失敗時沒有刪除

失敗的訊息被永久標記為已處理，重試時被跳過，訊息實質遺失。

### 錯誤 12：用 `XGROUP DELCONSUMER` 清理消費者但沒先轉移 PEL

那些訊息會直接消失。先 `XAUTOCLAIM` 轉移，確認 pending 為 0 再刪。

### 錯誤 13：消費者名稱每次啟動都不同

舊消費者的 PEL 沒人接手，會殘留大量無效消費者。用穩定的名稱。

---

## 8.9 本章練習

### 練習 1：判斷該用哪種方案

以下六個需求，各該用 Pub/Sub、List、Stream，還是 Kafka / RabbitMQ？

1. 多台應用伺服器的本地快取需要在資料更新時失效。
2. 使用者下單後，需要發送確認郵件、推播通知、更新統計，三個服務各自處理。
3. 直播間的即時彈幕推送給所有觀眾。
4. 需要重算過去三個月的使用者行為報表，資料量 5TB。
5. 圖片上傳後觸發縮圖處理，失敗要重試三次，仍失敗要人工介入。
6. 需要一個延遲 30 分鐘後執行的任務，且要能取消。

<details>
<summary>參考解答</summary>

**1. 本地快取失效 → Pub/Sub（合適的少數場景）**

這是 Pub/Sub 的經典用途，因為它符合「漏掉一次沒關係」：

```javascript
// 更新資料時廣播
await db.updateProduct(id, data);
await redis.del(`product:${id}`);
await redis.publish('cache:invalidate', `product:${id}`);

// 各台伺服器訂閱
subscriber.on('message', (ch, key) => localCache.delete(key));
```

**為什麼漏掉沒關係？** 因為本地快取有 TTL 兜底。漏掉一則通知的後果是「某台機器的本地快取多留了幾秒的舊資料」，不是資料錯誤。

**更好的方案是 Redis 6.0 的客戶端快取**（`CLIENT TRACKING`，第 04 章提過），它由 Redis 主動追蹤誰快取了什麼，失效通知更精確。但 Pub/Sub 版本簡單、跨版本相容，仍然常用。

**2. 下單觸發三個服務 → Stream + 三個消費者群組**

這正是消費者群組的設計目標：一則訊息被多個群組各處理一次，每個群組內部可以水平擴展。

```bash
XADD orders:events MAXLEN "~" 100000 "*" type "created" orderId "8888"

XGROUP CREATE orders:events email-group "$" MKSTREAM
XGROUP CREATE orders:events push-group "$" MKSTREAM
XGROUP CREATE orders:events stats-group "$" MKSTREAM
```

三個群組獨立消費、獨立追蹤進度、獨立處理失敗。郵件服務掛掉不影響推播服務，而且它恢復後能從 PEL 接著處理。

**絕對不能用 Pub/Sub**：郵件服務部署重啟的那 30 秒，所有訂單的確認郵件都會消失，而且你完全不知道漏了哪些。

**3. 直播彈幕 → Pub/Sub（推送）+ List（歷史）**

彈幕的特性是「即時性遠重於完整性」：

```javascript
// 即時推送給在線觀眾
await redis.publish(`room:${roomId}:danmaku`, JSON.stringify(msg));

// 同時存最近 200 條，供剛進房的人載入
const pipeline = redis.pipeline();
pipeline.lpush(`room:${roomId}:history`, JSON.stringify(msg));
pipeline.ltrim(`room:${roomId}:history`, 0, 199);
pipeline.expire(`room:${roomId}:history`, 3600);
await pipeline.exec();
```

漏掉一條彈幕沒人在意（觀眾根本不知道），但延遲高就很明顯。Pub/Sub 的即發即失在這裡反而是優點——不用維護任何狀態。

**如果是 Cluster 環境，記得用 `SPUBLISH`**，否則每條彈幕都會廣播到全叢集。

**4. 重算三個月、5TB 資料 → Kafka（或直接批次處理）**

5TB 完全超出 Redis 的記憶體範圍。而且「重算歷史」需要從任意位置重放，這是 Kafka 的核心能力。

實務上這個需求可能根本不需要訊息系統——直接從資料倉儲（Hive、BigQuery、ClickHouse）跑批次任務更合適。**訊息隊列適合處理「流」，不適合處理「大批歷史資料的重算」。**

**5. 圖片轉檔，重試三次後人工介入 → Stream + 消費者群組 + 死信**

需要的每一項能力 Stream 都有：

```javascript
async function processImage(stream, group, id, fields) {
  const pending = await redis.xpending(stream, group, '-', '+', 1, consumerName);
  const deliveryCount = pending[0]?.[3] ?? 1;

  if (deliveryCount > 3) {
    await moveToDeadLetter(stream, group, id, fields, deliveryCount);
    return;
  }

  try {
    await generateThumbnail(fieldsToObject(fields));
    await redis.xack(stream, group, id);
  } catch (err) {
    logger.error({ err, id, attempt: deliveryCount }, '轉檔失敗，將重試');
    // 不 ack，等 XAUTOCLAIM 重新投遞
  }
}
```

配上定期執行的 `XAUTOCLAIM`（例如每 30 秒認領閒置超過 60 秒的訊息），就有了完整的重試機制。死信 Stream 加上告警，就是「人工介入」的入口。

**6. 延遲 30 分鐘且可取消 → Sorted Set（不是訊息隊列）**

Stream 和 Kafka 都**沒有原生的延遲訊息**能力，也不能取消已發送的訊息。

用 ZSet 是標準做法（第 02 章練習提過）：

```javascript
// 排程
await redis.zadd('delay:tasks', Date.now() + 30 * 60 * 1000, JSON.stringify({ taskId, type }));

// 取消（這是 ZSet 相對訊息隊列的關鍵優勢）
await redis.zrem('delay:tasks', JSON.stringify({ taskId, type }));
```

工作者用 Lua 原子地「撈出到期的並移除」：

```lua
-- KEYS[1] = delay:tasks, ARGV[1] = 現在的時間戳, ARGV[2] = 每次取幾個
local tasks = redis.call('ZRANGE', KEYS[1], 0, ARGV[1], 'BYSCORE', 'LIMIT', 0, ARGV[2])
if #tasks > 0 then
  redis.call('ZREM', KEYS[1], unpack(tasks))
end
return tasks
```

**為什麼撈出和移除必須原子？** 否則多個工作者會同時撈到同一批任務，造成重複執行。

**組合方案更好：** ZSet 負責「延遲與取消」，到期後把任務 `XADD` 進 Stream，由 Stream 的消費者群組負責「可靠執行與重試」。各自做自己擅長的事。

如果你用 RabbitMQ，它有原生的延遲插件與 TTL + 死信交換機的組合可以做延遲隊列，但取消單一訊息仍然困難。

</details>

### 練習 2：實作完整的可靠消費者

實作一個訂單事件的消費者，要求：多消費者水平擴展、崩潰後不丟訊息、失敗自動重試、超過 3 次進死信、消費邏輯冪等。

<details>
<summary>參考解答</summary>

```javascript
const STREAM = 'orders:events';
const GROUP = 'notify-group';
const DLQ = `${STREAM}:dlq`;
const MAX_DELIVERY = 3;
const CLAIM_IDLE_MS = 60000;

// ---- 工具函式 ----

function fieldsToObject(fields) {
  const obj = {};
  for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
  return obj;
}

function objectToFields(obj) {
  return Object.entries(obj).flat().map(String);
}

async function ensureGroup() {
  try {
    await redis.xgroup('CREATE', STREAM, GROUP, '$', 'MKSTREAM');
  } catch (err) {
    if (!String(err.message).includes('BUSYGROUP')) throw err;
  }
}

// ---- 生產者 ----

async function publishOrderEvent(type, order) {
  return await redis.xadd(
    STREAM,
    'MAXLEN', '~', 100000,        // 必須有裁切
    '*',
    'type', type,
    'orderId', String(order.id),
    'userId', String(order.userId),
    'amount', String(order.amount),
    'ts', String(Date.now()),
  );
}

// ---- 消費者 ----

async function processMessage(id, fields, deliveryCount = 1) {
  const data = fieldsToObject(fields);

  // 超過重試上限，送死信
  if (deliveryCount > MAX_DELIVERY) {
    await moveToDeadLetter(id, fields, deliveryCount);
    return;
  }

  // 冪等：用訊息 ID 去重
  const dedupKey = `processed:${GROUP}:${id}`;
  const isFirst = await redis.set(dedupKey, '1', 'NX', 'EX', 86400);

  if (!isFirst) {
    logger.warn({ id }, '訊息已處理過，直接 ack');
    await redis.xack(STREAM, GROUP, id);
    return;
  }

  try {
    await sendNotification(data);
    await redis.xack(STREAM, GROUP, id);
  } catch (err) {
    // 關鍵：失敗要刪掉去重標記，否則重試會被誤判為已處理
    await redis.del(dedupKey);
    logger.error({ err, id, deliveryCount }, '處理失敗，保留在 PEL');
    // 不 ack
  }
}

async function moveToDeadLetter(id, fields, deliveryCount) {
  await redis.xadd(DLQ, 'MAXLEN', '~', 10000, '*',
    'originalId', id,
    'originalStream', STREAM,
    'group', GROUP,
    'deliveryCount', String(deliveryCount),
    'failedAt', String(Date.now()),
    'payload', JSON.stringify(fieldsToObject(fields)),
  );
  await redis.xack(STREAM, GROUP, id);
  alert(`訂單事件進入死信：${id}，已投遞 ${deliveryCount} 次`);
}

// 主消費迴圈
async function consume(consumerName) {
  await ensureGroup();

  // 階段 1：先處理自己上次沒 ack 完的
  let cursor = '0';
  while (true) {
    const res = await redis.xreadgroup(
      'GROUP', GROUP, consumerName, 'COUNT', 100,
      'STREAMS', STREAM, cursor
    );
    if (!res || res[0][1].length === 0) break;
    for (const [id, fields] of res[0][1]) {
      await processMessage(id, fields);
      cursor = id;
    }
  }

  logger.info({ consumerName }, 'PEL 清理完成，開始消費新訊息');

  // 階段 2：持續消費
  while (running) {
    try {
      const res = await redis.xreadgroup(
        'GROUP', GROUP, consumerName, 'COUNT', 10, 'BLOCK', 5000,
        'STREAMS', STREAM, '>'
      );
      if (!res) continue;
      for (const [id, fields] of res[0][1]) {
        await processMessage(id, fields);
      }
    } catch (err) {
      logger.error({ err }, 'XREADGROUP 失敗，稍後重試');
      await sleep(1000);
    }
  }
}

// ---- 認領任務（獨立跑，或由其中一個消費者兼任）----

async function claimStaleLoop(consumerName) {
  while (running) {
    try {
      let cursor = '0-0';
      do {
        const [next, entries] = await redis.xautoclaim(
          STREAM, GROUP, consumerName, CLAIM_IDLE_MS, cursor, 'COUNT', 10
        );

        for (const [id, fields] of entries) {
          // 查這則訊息的投遞次數
          const pending = await redis.xpending(STREAM, GROUP, '-', '+', 1);
          const entry = pending.find(p => p[0] === id);
          const deliveryCount = entry ? entry[3] : 1;

          await processMessage(id, fields, deliveryCount);
        }

        cursor = next;
      } while (cursor !== '0-0');
    } catch (err) {
      logger.error({ err }, 'XAUTOCLAIM 失敗');
    }
    await sleep(30000);
  }
}

// ---- 監控 ----

async function reportMetrics() {
  const groups = await redis.xinfo('GROUPS', STREAM);
  for (const g of groups) {
    const info = fieldsToObject(g);
    metrics.gauge('stream.pending', Number(info.pending), { group: info.name });
    metrics.gauge('stream.lag', Number(info.lag ?? 0), { group: info.name });
  }

  const dlqLen = await redis.xlen(DLQ).catch(() => 0);
  metrics.gauge('stream.dlq_size', dlqLen);

  // 檢查殘留的消費者
  const consumers = await redis.xinfo('CONSUMERS', STREAM, GROUP);
  for (const c of consumers) {
    const info = fieldsToObject(c);
    if (Number(info.idle) > 600000 && Number(info.pending) > 0) {
      alert(`消費者 ${info.name} 閒置超過 10 分鐘但還有 ${info.pending} 則未確認`);
    }
  }
}

// ---- 啟動 ----

// 消費者名稱要穩定，這裡用環境變數（Kubernetes StatefulSet 的 pod 序號很合適）
const consumerName = process.env.CONSUMER_NAME || `consumer-${os.hostname()}`;

consume(consumerName);
claimStaleLoop(`${consumerName}-claimer`);
setInterval(reportMetrics, 30000);

// 優雅關閉
process.on('SIGTERM', async () => {
  running = false;
  // 給正在處理的訊息一點時間完成
  await sleep(5000);
  process.exit(0);
});
```

**六個關鍵設計，逐一說明為什麼：**

**設計 1：消費者名稱必須穩定。** 用 `consumer-${randomUUID()}` 的話，每次重啟都是新消費者，舊消費者的 PEL 沒人接手（只能靠 `XAUTOCLAIM` 撿回來），而且 `XINFO CONSUMERS` 會累積大量殘留條目。用 Kubernetes StatefulSet 的序號（`worker-0`、`worker-1`）最理想——重啟後能自動接手自己的 PEL。

**設計 2：啟動時先處理 PEL（用 `'0'` 而非 `'>'`）。** 這是崩潰恢復的關鍵。如果直接用 `'>'` 開始，上次沒 ack 的訊息要等 `XAUTOCLAIM` 才會被處理，延遲高很多。

**設計 3：去重標記在失敗時必須刪除。** 這是最容易寫錯的地方。少了 `await redis.del(dedupKey)`，一則失敗的訊息會被永久標記為已處理，重試時直接跳過——訊息實質遺失，而且監控上看不出來（因為它被 ack 了）。

**設計 4：認領任務用不同的消費者名稱。** `${consumerName}-claimer` 避免和主消費迴圈的 PEL 混在一起，除錯時更清楚是誰在處理什麼。

**設計 5：`MAXLEN ~` 是必須的。** Stream 是高頻寫入，沒有裁切一天就能長到幾 GB。死信 Stream 也要設。

**設計 6：監控三個指標。** `pending`（處理不了的訊息）、`lag`（消費落後程度）、`dlq_size`（死信累積）。這三個任何一個持續增長都代表有問題。

**還有一個沒寫進程式碼但很重要的事：** `XAUTOCLAIM` 的 `min-idle-time`（這裡是 60 秒）必須**大於你的正常處理時間**。如果處理一則訊息平均要 90 秒，那 60 秒的閒置門檻會讓還在正常處理中的訊息被別人認領走，造成重複處理。設定值應該是「正常處理時間的 2-3 倍」。

</details>

### 練習 3：實測 Pub/Sub 的訊息遺失與 Stream 的可靠性

<details>
<summary>參考解答</summary>

**實驗 1：證明 Pub/Sub 會丟訊息**

```bash
docker compose exec redis sh
```

```sh
# 沒有訂閱者時發布
redis-cli -a mysecret PUBLISH test:channel "message-1"
# (integer) 0        <- 0 個訂閱者收到，這則訊息永久消失
```

開兩個終端。終端 A：

```sh
redis-cli -a mysecret SUBSCRIBE test:channel
```

終端 B：

```sh
redis-cli -a mysecret PUBLISH test:channel "message-2"
# (integer) 1        <- 有人收到了
```

終端 A 會顯示 `message-2`。**現在中斷終端 A（Ctrl+C），再發布：**

```sh
redis-cli -a mysecret PUBLISH test:channel "message-3"
# (integer) 0
```

重新訂閱：

```sh
redis-cli -a mysecret SUBSCRIBE test:channel
```

**`message-1` 和 `message-3` 永遠拿不到，而且 Redis 裡沒有任何痕跡可以查。** 這就是「即發即失」的實際後果——不只是丟了，是連「丟了什麼」都無法知道。

**實驗 2：對比 Stream 的行為**

```sh
redis-cli -a mysecret DEL test:stream

# 沒有任何消費者的情況下寫入
redis-cli -a mysecret XADD test:stream "*" msg "message-1"
redis-cli -a mysecret XADD test:stream "*" msg "message-2"

redis-cli -a mysecret XLEN test:stream
# (integer) 2        <- 訊息還在

# 現在才建立群組，從頭開始消費
redis-cli -a mysecret XGROUP CREATE test:stream g1 0

redis-cli -a mysecret XREADGROUP GROUP g1 c1 COUNT 10 STREAMS test:stream ">"
# 兩則訊息都拿到了
```

**訊息在消費者出現之前就已經安全保存。** 這是 Stream 和 Pub/Sub 最根本的差別。

**實驗 3：驗證未 ack 的訊息會留在 PEL**

```sh
redis-cli -a mysecret DEL test:stream2
redis-cli -a mysecret XADD test:stream2 "*" msg "a"
redis-cli -a mysecret XADD test:stream2 "*" msg "b"
redis-cli -a mysecret XADD test:stream2 "*" msg "c"
redis-cli -a mysecret XGROUP CREATE test:stream2 g1 0

# consumer-1 讀取但不 ack（模擬處理中崩潰）
redis-cli -a mysecret XREADGROUP GROUP g1 consumer-1 COUNT 3 STREAMS test:stream2 ">"

# 查 PEL
redis-cli -a mysecret XPENDING test:stream2 g1
# 1) (integer) 3
# 2) "1786...-0"
# 3) "1786...-0"
# 4) 1) 1) "consumer-1"
#       2) "3"

# consumer-1 再用 > 讀，會拿到什麼？
redis-cli -a mysecret XREADGROUP GROUP g1 consumer-1 COUNT 3 STREAMS test:stream2 ">"
# (nil)     <- 沒有新訊息了

# 但用 0 讀，可以拿回自己沒 ack 的
redis-cli -a mysecret XREADGROUP GROUP g1 consumer-1 COUNT 3 STREAMS test:stream2 "0"
# 三則訊息又回來了
```

**這驗證了 `>` 和 `0` 的語意差別**，也說明了為什麼消費者啟動時要先用 `0` 清理 PEL。

**實驗 4：驗證 `XAUTOCLAIM` 的接手機制**

```sh
# consumer-1 的三則訊息還在 PEL 裡，等它「閒置」一段時間
sleep 5

# consumer-2 認領閒置超過 3 秒的訊息
redis-cli -a mysecret XAUTOCLAIM test:stream2 g1 consumer-2 3000 0-0 COUNT 10
# 1) "0-0"
# 2) 三則訊息

redis-cli -a mysecret XPENDING test:stream2 g1
# 現在 consumer-2 持有這三則
# 4) 1) 1) "consumer-2"
#       2) "3"
```

**訊息成功從崩潰的 consumer-1 轉移到 consumer-2。** 這就是可靠消費的核心機制。

**實驗 5：觀察投遞次數的增長**

```sh
# 反覆認領同一批訊息，觀察投遞次數
for i in 1 2 3; do
  sleep 2
  redis-cli -a mysecret XAUTOCLAIM test:stream2 g1 consumer-3 1000 0-0 COUNT 10 JUSTID > /dev/null
  echo "--- 第 $i 次認領後 ---"
  redis-cli -a mysecret XPENDING test:stream2 g1 - + 3
done
```

你會看到第四個欄位（投遞次數）逐次遞增：`4`、`5`、`6`...

**這個數字就是判斷毒訊息的依據。** 超過閾值就該送死信，否則會無限重試。

`JUSTID` 選項讓 `XAUTOCLAIM` 只回傳 ID 不回傳內容，適合「只想轉移歸屬、不想立刻處理」的場景。**注意：用 `JUSTID` 時投遞次數不會增加**（因為訊息沒有真的被投遞），這在實作重試計數時要留意。

**實驗 6：驗證多群組的廣播行為**

```sh
redis-cli -a mysecret DEL test:stream3
redis-cli -a mysecret XADD test:stream3 "*" msg "broadcast-me"

redis-cli -a mysecret XGROUP CREATE test:stream3 email-group 0
redis-cli -a mysecret XGROUP CREATE test:stream3 push-group 0

# 兩個群組各自都能讀到同一則訊息
redis-cli -a mysecret XREADGROUP GROUP email-group c1 COUNT 1 STREAMS test:stream3 ">"
redis-cli -a mysecret XREADGROUP GROUP push-group c1 COUNT 1 STREAMS test:stream3 ">"
# 兩者都拿到 broadcast-me
```

**同一則訊息被兩個群組各處理一次，但在同一群組內只會被一個消費者處理。** 這個「群組間廣播、群組內競爭」的模型正好對應「一個事件觸發多個服務，每個服務內部水平擴展」的需求。

**實驗 7：驗證裁切**

```sh
redis-cli -a mysecret DEL test:trim
redis-cli -a mysecret EVAL "
for i=1,1000 do
  redis.call('XADD', KEYS[1], 'MAXLEN', '~', 100, '*', 'i', i)
end
return redis.call('XLEN', KEYS[1])" 1 test:trim
```

**回傳的數字通常不是 100，而是稍多（例如 130）。** 這就是 `~` 近似裁切的行為——它只刪除整個節點，所以會多留一些。

對比精確裁切：

```sh
redis-cli -a mysecret DEL test:trim2
redis-cli -a mysecret EVAL "
for i=1,1000 do
  redis.call('XADD', KEYS[1], 'MAXLEN', '=', 100, '*', 'i', i)
end
return redis.call('XLEN', KEYS[1])" 1 test:trim2
# (integer) 100      <- 精確
```

精確版本剛好 100，但在高頻寫入時效能較差。**生產環境用 `~`。**

**清理**

```sh
redis-cli -a mysecret DEL test:stream test:stream2 test:stream3 test:trim test:trim2
```

</details>

---

## 8.10 驗收清單

進入下一章前，確認你可以：

- [ ] 說明 Pub/Sub 的「即發即失」語意，並列出四種丟訊息的情境。
- [ ] 說明 `PUBLISH` 的回傳值意義，以及為什麼它是唯一的線索。
- [ ] 說出訂閱者輸出緩衝區的風險，以及為什麼回呼必須極快。
- [ ] 說明訂閱狀態的命令限制，以及為什麼要用獨立連線。
- [ ] 說明 Cluster 下 Pub/Sub 的廣播問題，以及 sharded Pub/Sub 的解法。
- [ ] 用 keyspace notification 做快取失效，並說出它的四個限制。
- [ ] 說明 Stream ID 的結構，以及為什麼能用時間戳做範圍查詢。
- [ ] 說明 `MAXLEN ~` 和 `MAXLEN =` 的差別，以及為什麼生產環境該用前者。
- [ ] 說明消費者群組的「群組間廣播、群組內競爭」模型。
- [ ] 區分 `XREADGROUP` 用 `>` 和用 `0` 的不同語意。
- [ ] 說明為什麼處理失敗時不能 `XACK`。
- [ ] 用 `XAUTOCLAIM` 處理崩潰消費者的 PEL，並說明 `min-idle-time` 該怎麼設。
- [ ] 設計死信機制，包含告警與重放。
- [ ] 寫出一個正確的冪等消費，包含「失敗時刪除去重標記」。
- [ ] 說出 Stream 和 Kafka、RabbitMQ 的分界線。

---

下一章回到最常見的應用場景：[09-caching-patterns-in-practice.md](./09-caching-patterns-in-practice.md)，我們會完整處理快取模式、一致性取捨，以及穿透、擊穿、雪崩的解法。
