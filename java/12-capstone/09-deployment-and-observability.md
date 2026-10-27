# 第 09 章：部署與可觀測性：映像檔、完整的 compose、traceId 跨過 broker、指標與告警、INV-5、增量對帳

> 第 08 章結束時，`mvn clean verify` 是 188 個綠燈、跳過 1 個（Q7）、3 分 45 秒，而且只需要 Docker。但「只需要 Docker」說的是**測試**。應用程式本身還是在 IDE 或 `java -jar` 裡跑，日誌是一行一行的文字；compose 那台資料庫裡，第 02 章就建好的兩個 `trace_id` 欄位，**outbox 的 86,947 列、稽核的 2 列，全部是 NULL**。應用程式的資料庫帳號對 `shop` 有 `ALL PRIVILEGES`，連 `DROP TABLE` 都可以。第 05 到 08 章累積了一串「第 09 章接告警」的數字，沒有任何一個有人接。
>
> **這一章把應用程式裝進容器、放進 compose，然後問：它出事的時候，我們看得到嗎？看到的是對的嗎？** 先把第 08 章被覆蓋掉的那份日誌留下來重跑一次，看它說了什麼；再讓一個請求的 traceId 走過 HTTP、資料庫、broker、消費者；把 0.6.6 的告警寫成規則、寫成測試、拿真的停機去觸發它；最後把應用程式的資料庫帳號收到「只能新增帳」，並把每小時一次的全表對帳改成增量的。
>
> 這一章結束時，你手上會有：
>
> - **一個映像檔**（9.3）：多階段建置、分層、非 root、exec form。改一行程式重建 9.5 秒，變的只有 1.59 MB 的那一層（第一版是整個 75.4 MB 的 jar）。
> - **一個命令起完整的系統**（9.4）：`docker compose --profile app up -d --wait`。migration 是一個一次性的步驟（`shop_migrator`），應用程式等它成功才起；Prometheus、Alertmanager、MySQL 的 exporter 一起。七個服務 17.2 秒（加了 Alertmanager 之後是九個）。
> - **traceId 跨過 broker**（9.8）：驗收 Q7 綠了 —— **`Skipped` 第一次是 0**。外面帶進來的 `traceparent` 不收。
> - **19 條告警規則，跟程式碼一起測**（9.10）：`promtool` 的單元測試、一個「規則用到的指標啟動時就要存在」的測試；拿真的停機觸發：停掉 RabbitMQ 之後 **87.5 秒**，通知送到收件人。
> - **INV-5**（9.11）：應用程式的帳號只拿一個角色，`inventory_ledger` 與 `audit_logs` 只能 SELECT、INSERT；稽核的一年保留期由一個預存程序做。
> - **增量對帳**（9.12）：2,000 萬列的帳本，每小時那一次 18～30 ms（全掃是 122～130 秒）；每週一次全掃校正。
> - **一份會自己跑的上線檢查清單**（9.13），以及 **201 個測試、0 個失敗、0 個跳過、4 分 07 秒**的 `mvn clean verify`（9.15）；一個空的容器裡 4 分 45 秒。

## 9.1 學習目標

完成本章後，你應該可以：

- 用一次「把日誌留下來重跑」取代「我覺得是 Redis」的推測，並說出一個在每一次建置裡都出現、卻沒有人看的 ERROR 是怎麼活過三章的（9.2.1）。
- 寫一個多階段、分層、非 root、exec form 的 Dockerfile，量出每一個選擇的代價：映像檔大小、重建時間、變動的層（9.3）。
- 說出 `docker stop` 的寬限、PID 1、SIGTERM、`server.shutdown=graceful` 各自管什麼，並用「停機期間持續下單」量出每一種組合的後果（9.2.2、9.5）。
- 把 migration 從「應用程式啟動的一部分」變成「部署的一個步驟」，讓應用程式不再持有 DDL 的帳號（9.4、9.11）。
- 在正式環境可能給的資源上量 SLO：CPU、記憶體上限、JVM 的 heap、新實例的第一輪（9.6）。
- 讓一個 traceId 走過 HTTP、資料庫、broker、消費者、排程，並決定要不要收外面帶進來的那一個（9.8）。
- 寫告警規則、寫它們的單元測試、拿真的停機觸發它們，量出「出事 → 有人收到」要多久，以及哪些規則在事後才響、哪些永遠不會響（9.10）。
- 用資料庫權限守住「只能新增」的不變量，並處理它跟資料保留期的衝突（9.11）。
- 把全表對帳改成增量的，並說出水位線為什麼不能越過還沒 commit 的那一列（9.12）。

---

## 9.2 先看見痛：出事的時候，看得到嗎

### 9.2.0 實驗環境

先在第 08 章的程式碼上重跑一次建置：

```
TEST_INFRA testcontainers 啟動 11,683 ms：mysql jdbc:mysql://localhost:56079/shop、redis localhost:56070、rabbitmq localhost:56075
[WARNING] Tests run: 188, Failures: 0, Errors: 0, Skipped: 1
[INFO] All coverage checks have been met.   （四行）
[INFO] BUILD SUCCESS
[INFO] Total time:  03:31 min
```

跟第 08 章結束時一樣：188 個、跳過 1 個（Q7）。

機器還是同一台：8 核、16 GB，Docker Desktop 的 VM 分到 8 核、7.65 GB，Docker Engine 29.1.3。compose 的那一組 MySQL、Redis、RabbitMQ 還開著，裡面是第 02 章的 10 萬張種子訂單、60 萬 9,905 列庫存帳，以及第 02～08 章每一個實驗留下來的東西。

本章的實驗命名接著第 08 章的 I1～I12：J1～J15。照舊**一次只跑一個實驗**、延遲的比較**交錯執行**、每一段輸出旁邊記 load average。

| 實驗 | 用什麼 | 量什麼 |
|---|---|---|
| J1 留下日誌重跑 8.6.5 | `scripts/j1-busy-h6.sh`、`j1c-rabbit-start.sh` | 忙的 RabbitMQ 停機演練的完整日誌；`docker start` 之後多久接受連線 |
| J2 停機 | `scripts/j2-stop.sh`、`j2b-stop-under-load.sh`、`loadtest/StopDuringLoad` | `docker stop` 的時間與結束碼；停機期間每秒 50 張的下單怎麼了 |
| J3 映像檔 | 三版 Dockerfile | 大小、冷建置、改一行的重建、變了哪幾層；容器裡的 heap 上限 |
| J4 規格 | `scripts/j4-*.sh` | 三種資源上限下的熱點 p99、記憶體、CPU；主機 vs 容器；唯讀暖機 |
| J5 traceId | 驗收 Q7、`JobTraceTest`、curl | 每一段有沒有 traceId；外面帶進來的收不收 |
| J6 日誌 | `JsonLogFormatTest`、掃描測試報告 | JSON 的欄位與遮罩；一次完整建置的日誌裡有沒有個資 |
| J7 指標 | 管理埠、`ch09/J7CardinalityTest` | 誰抓得到 `/actuator/prometheus`；productId 當 tag 的代價 |
| J8 告警 | `promtool`、`scripts/j8b-alert-drill.sh`、Alertmanager | 規則的單元測試；停機之後多久 pending、firing、送到 |
| J9 INV-5 | SQL、`AppGrantsTest` | 應用程式的帳號能做什麼；改了之後誰壞掉 |
| J10 compose | `docker compose --profile app` | 一個命令起得來嗎；起來的東西對不對 |
| J11 增量對帳 | `scripts/j11a-full-scan.sh`、`IncrementalReconciliationTest`、三個 MySQL 連線 | 全掃 vs 帳本大小；增量的成本；水位線與還沒 commit 的那一列 |
| J12 上線檢查清單 | `scripts/j12-checklist.sh` | 對著 compose 跑一次，哪幾項過不了 |
| J13 設定 | `--debug`、prod profile | 環境變數的寫法；少了一個秘密會怎樣 |
| J14、J15 最後的建置 | `mvn clean verify`、空的容器 | 測試、覆蓋率、MySQL 的連線高峰 |

### 9.2.1 事故一：第一次把日誌留下來 ★★★

第 08 章 8.6.5 留了兩個問題沒有答案，都是因為同一件事：「那一次應用程式的日誌被下一次演練覆蓋掉了」。

- 機器很忙、RabbitMQ 恢復的那一刻，Redis 失敗 4 次、跳開 1 次，熱點下單 503 五秒 —— **是哪一個 Redis 呼叫失敗？**
- 同一次，RabbitMQ 回來之後 20 秒，outbox 還在長 —— **relay 在做什麼？**

所以這一章做的第一件事很簡單：用第 08 章的程式碼、同一個演練（H6 的流量、6 個 `yes`、第 20 秒 `docker stop shop-rabbitmq-1`、第 80 秒 `start`），**把日誌留下來**：

```bash
scripts/j1-busy-h6.sh ../j1-logs J1a-ch08      # 第一個參數：日誌放哪個目錄
```

```
### 忙：H6 stop（J1a-ch08）load { 4.71 4.32 4.47 }
  秒      依賴 │ MySQL 句/秒 │ 詳情 p99    狀態                  │ 熱點下單 p99  狀態              │ 一般下單 p99  狀態          │ … │ outbox 未送出 │ 等連線（最多）│ Redis 失敗／跳開
   15-20  正常   │      845   │    54.7  {200=250}             │   247.0  {201=50}           │   261.9  {201=50}       │ … │        2      │      0       │ 0／0
   20-25  停了   │      500   │   101.7  {200=250}             │   405.3  {201=50}           │   507.6  {201=51}       │ … │        4      │      0       │ 0／0
   ……
   75-80  停了   │      567   │    38.3  {200=250}             │   154.5  {201=50}           │   163.0  {201=49}       │ … │     1096      │      0       │ 0／0
   80-85  正常   │      547   │    48.9  {200=250}             │   242.4  {201=49}           │   201.0  {201=50}       │ … │     1195      │      0       │ 0／0
   85-90  正常   │      551   │    49.6  {200=250}             │   336.3  {201=50}           │   285.1  {201=50}       │ … │     1293      │      0       │ 0／0
   90-95  正常   │      543   │   100.9  {200=250}             │   309.2  {201=50}           │   330.7  {201=50}       │ … │     1393      │      0       │ 0／0
   95-100 正常   │      547   │    88.6  {200=250}             │   355.7  {201=50}           │   387.5  {201=50}       │ … │     1494      │      0       │ 0／0
  停機期間（20～80 秒）：{一般下單={201=596}, 熱點下單={201=598}, 詳情={200=3000}}
  恢復之後（80～100 秒）：{一般下單={201=200}, 熱點下單={201=199}, 詳情={200=1000}}
### done load { 15.95 9.58 6.62 }；應用程式日誌     3449 行
```

這一次**沒有熱點 503** —— 開始時 load 只有 4.7，`yes` 還沒把 load 推上去（結束時是 16）。但第二個問題重現了：恢復之後 20 秒，outbox 從 1,195 長到 1,494。日誌有 3,449 行。依訊息的種類數一數：

```
 1300  WARN … o.s.amqp.rabbit.core.RabbitTemplate : Returned message but no callback available
  386  WARN … c.r.c.impl.ForgivingExceptionHandler : An unexpected connection driver error occurred (Exception message: Connection reset)
  110  WARN … o.s.a.r.l.SimpleMessageListenerContainer : Consumer raised exception, processing can restart …
 1300 ERROR … c.e.s.s.m.internal.RabbitOutboxRelay : OUTBOX_UNROUTABLE eventId=… type=order.completed：沒有佇列綁定這個 routing key
```

（`OUTBOX_UNROUTABLE` 那 1,300 行是 100 個不同的 eventId、各 13 次，上面依 eventId 分開的 100 列合在一起寫。）

**最多的不是 Redis，是 1,300 行 ERROR。**

先回答原本的問題。依時間排，RabbitMQ 在 11:44:19.8 停、11:45:19.8 起，**之後到演練結束的 21 秒，日誌只有一種訊息**：對 `127.0.0.1:5672` 與 `[::1]:5672` 的每一次連線都被 `Connection reset`，`OUTBOX_RELAY_RECOVERED` 一次都沒有出現。RabbitMQ 還沒準備好，relay 根本連不上 —— outbox 當然在長。

`docker start` 之後多久才真的接受 AMQP？TCP 的 `connect` 一定成功（Docker Desktop 的轉送層在聽），要看的是 broker 有沒有回 Connection.Start。J1c 用 `nc` 送 AMQP 的協定標頭，每 0.2 秒一次：

```
### 閒 load { 3.80 4.47 5.10 }
  docker start 花了   0.2 秒 │ TCP 接受   0.2 秒 │ AMQP 回 Connection.Start   4.8 秒
  docker start 花了   0.1 秒 │ TCP 接受   0.2 秒 │ AMQP 回 Connection.Start   4.9 秒
  docker start 花了   0.1 秒 │ TCP 接受   0.2 秒 │ AMQP 回 Connection.Start   4.6 秒
### 忙（6 個 yes）load { 6.07 4.93 5.23 }
  docker start 花了   0.4 秒 │ TCP 接受   0.5 秒 │ AMQP 回 Connection.Start  11.8 秒
  docker start 花了   0.4 秒 │ TCP 接受   0.6 秒 │ AMQP 回 Connection.Start  12.0 秒
  docker start 花了   0.4 秒 │ TCP 接受   0.5 秒 │ AMQP 回 Connection.Start  13.7 秒
```

**閒的時候 4.6～4.9 秒，忙的時候 11.8～13.7 秒。** 8.6.5 推測「broker 開機要重新載入佇列，機器又很忙」—— 方向對了。但 J1a 那一次是**至少 21 秒**，比這裡最慢的 13.7 秒還長；那一次 load 更高，而且應用程式一直在重連。是哪一個讓它更慢，我沒有分開量。（8.6.5 的另一個問題「哪一個 Redis 呼叫失敗」，這一次沒有重現 503；9.6.3 的另一次演練裡碰巧留下了答案。）

然後是那 1,300 行。100 個不同的 `order.completed` 事件，每一個在 3.4 秒內被送了 13 次（11:43:51～11:43:54，應用程式剛啟動），直到演練的客戶端把舊的未送出事件標成已送出，才停下來。

`order.completed` 為什麼沒有佇列收？第 07 章 7.3.1 的表上寫著：「`order.completed` ｜ `ordering`：`SHIPPED → COMPLETED` ｜ （目前沒有人，0.5.4 寫的是「——」）」。**沒有任何消費者訂閱它。** 而 relay 是這樣處理「被退回」的：

```java
else if (cd.getReturned() != null) {                                                  // confirm 是 ack，但沒有任何佇列收下它
    log.error("OUTBOX_UNROUTABLE eventId={} type={}：沒有佇列綁定這個 routing key", r.eventId(), r.eventType());
    failed.add(r.id());                                                               // → release：馬上放回去
```

送不出去的列馬上放回去，下一輪（100 ms 後）再被認領 —— 而認領是 `ORDER BY id LIMIT 100`。**只要最前面累積了 100 筆沒有人訂閱的事件，relay 就永遠在送同樣那 100 筆，後面的事件一筆都送不出去。** 正式環境裡，`order.completed` 來自買家確認收貨與 7 天自動完成（US-ORD-6）；一天 5,000 張訂單（0.6.1），第一批 100 張完成之後，relay 就停了。

這是推論。先寫一個會紅的測試，放在 `EventFlowTest`：用正式的服務把 120 張訂單一路走到確認收貨（下單 → 付款 → 撿貨 → 出貨 → 確認收貨），然後下一張新的訂單，等它的「訂單成立」通知：

```java
@Test @DisplayName("9.2.1 沒有人訂閱的事件（order.completed）不能卡住 relay：120 張訂單確認收貨之後，新的一張照樣收到「訂單成立」")
void unsubscribedEventsDoNotBlockRelay() {
    ……
    for (int i = 0; i < 120; i++) {                                     // 上線第 7 天：第一批訂單走到 COMPLETED（US-ORD-6）
        var o = place(BUYER, BULK);
        pay(BUYER, o.orderNo());
        commands.startPicking(SELLER, o.orderNo());
        commands.ship(SELLER, o.orderNo(), "黑貓", "T-" + i);
        commands.confirmReceipt(BUYER, o.orderNo());
    }
    var fresh = place(BUYER + 1, NORMAL);
    await().atMost(Duration.ofSeconds(30)).until(() -> sentTypes(BUYER + 1, fresh.orderNo()).contains("ORDER_PLACED"));
```

（`……` 省略的是準備資料：一個一般商品 `BULK`（9_900_713，庫存 200）。`setUp` 的清理也多了兩件事：把這些買家還沒送出的 outbox 列刪掉 —— 沒有人訂閱的 `order.completed` 不能留給下一個打開 relay 的測試；以及帳改用 `TestInfra.adminJdbc()` 刪（9.11.3）。這兩個新測試與 `setUp` 的改動在 9.15.1。）

```
9.2.1 120 張訂單走到 COMPLETED：7,005 ms
9.2.1 新訂單 20261006-752025：30,050 ms 之後，outbox 還沒送出的 [{event_type=order.completed, n=120}, {event_type=order.placed, n=21}, {event_type=order.paid, n=20}, {event_type=order.shipped, n=20}]
[ERROR] … unsubscribedEventsDoNotBlockRelay … ConditionTimeout … was not fulfilled within 30 seconds.
```

紅了，而且比我預期的嚴重：**還沒走完 120 張，relay 就已經卡住了** —— 第 100 張之後的訂單，它們的 `order.placed`、`order.paid`、`order.shipped` 也全部卡在後面。這 30 多秒裡，`OUTBOX_UNROUTABLE` 印了 **24,831 行**（100 個不同的事件），broker 收到同樣多則沒有人要的訊息。

**為什麼從第 07 章到現在，沒有任何一個測試看到它？** 三個原因，每一個都是測試的設計：

1. 測試環境預設關掉 relay（7.12.1）。
2. 許多測試一開始就 `InlineEvents.skipBacklog(ctx)` —— 把 outbox 裡所有未送出的事件標成已送出。
3. **測試拿來代替 relay 的 `InlineEvents.deliver`，遇到沒有訂閱者的事件時，直接標成已送出**；真的 relay 是一直重送。**替身跟本尊，在這一件事上行為不一樣。**

而那一行 ERROR 一直都在。J0 那一次基準建置的報告裡，`DeadLetterReplayTest` 那一份就有一行 `OUTBOX_UNROUTABLE … type=order.completed`。每一次建置都有，沒有人看。

修法分兩部分：

```java
// 9.2.1：沒有任何消費者訂閱的類型（例如 order.completed，7.3.1「目前沒有人」）不送 —— 送了也只會被退回。
// 第一版把「退回」一律當成失敗、馬上放回去重送：完成的訂單一多，relay 就永遠卡在最前面那 100 筆上
List<OutboxStore.Row> toSend = new ArrayList<>(rows.size());
for (OutboxStore.Row r : rows) {
    if (subscribed.contains(r.eventType())) { toSend.add(r); continue; }
    confirmed.add(r.id());
    Counter.builder("shop.outbox.unsubscribed").tag("type", r.eventType()).…register(meters).increment();
    if (warnedUnsubscribed.add(r.eventType()))
        log.warn("OUTBOX_UNSUBSCRIBED type={}：這個應用程式裡沒有消費者訂閱它，標成已送出、不送（每一種只記這一次）", r.eventType());
}
```

- **A：沒有人訂閱的類型，不送。** `subscribed` 是這個應用程式裡每一個 `EventHandler` 的 `eventTypes()` —— 宣告佇列與綁定的 `RabbitTopology` 用的也是同一份清單。每一種類型只寫一次 WARN，並記一個計數器。
- **B：真的送不出去的（nack、有人訂閱卻被退回、等不到 confirm），晚 5 秒再試，不是馬上放回去。** `OutboxStore.retryLater` 把那幾列的租約延到 5 秒之後，這段時間裡認領會跳過它們、後面的事件先走。7.5.4 說過，五個消費者都不依賴順序，所以讓一筆延後不會弄壞任何東西。另外加一個計數器 `shop.outbox.rejected{reason}` —— `reason=unroutable` 代表「有人訂閱、卻沒有佇列綁定它」，那是拓撲壞了，9.10 會為它接告警。

（5 秒是 `shop.messaging` 底下新的設定 `relayRetryBackoff`，預設 `5s`；`subscribed` 來自 relay 建構子多注入的 `List<EventHandler>`。有一處容易漏：送出途中丟例外的那條路徑，也要先把已經放進 `confirmed` 的「沒有人訂閱」那幾列標成已送出，再 release 其餘的。`RabbitOutboxRelay`、`OutboxStore.retryLater`、`ShopProperties` 的全文在 9.15.1。）

```
9.2.1 120 張訂單走到 COMPLETED：5,914 ms
9.2.1 新訂單 20261006-659948：210 ms 之後，outbox 還沒送出的 []
[INFO] Tests run: 7, Failures: 0, Errors: 0, Skipped: 0 -- in com.example.shop.ordering.internal.EventFlowTest
```

新訂單 210 ms 收到通知；`OUTBOX_UNROUTABLE` 0 行，`OUTBOX_UNSUBSCRIBED` 1 行。

B 也要有一個測試。只「把 `refund.requested` 的綁定拿掉，等那一列的 `claimed_until` 在 3 秒以上之後」是不夠的 —— 用突變驗證它（把 `retryLater` 換回 `release`）：**突變存活了**。認領本身就會蓋上 30 秒的租約，那個條件在送出的途中本來就成立；而且綁定拿掉的那幾百毫秒裡，`release` 版本也只重送了一次。所以測試讓綁定消失整整 2 秒，數 `shop.outbox.rejected{reason=unroutable}`：

```
修正：9.2.1 拓撲壞了 2 秒多：refund.requested 被 broker 退回 1 次；下一張訂單照樣通知
突變：9.2.1 拓撲壞了 2 秒多：refund.requested 被 broker 退回 17 次；下一張訂單照樣通知   → FAILURE
```

加了這個測試之後，另一個測試紅了：第 08 章 8.7.5 加的 `refundResponseLostOnce`，「金流被呼叫 2 次」變成 3 次。我的第一個猜測是 8.8.2 那一種 —— 我的新測試有一則訊息漏到了下一個測試。二分之後：只有跟 `brokenBindingBacksOff` 一起跑時紅，單獨跑、跟另一個新測試一起跑都綠。原因不是非同步：

```java
public void reset() { failNext.set(0); loseResponseNext.set(0); down = false; latencyMs = 20; }   // ← calls 沒有歸零
```

`refundResponseLostOnce` 斷言「被呼叫 2 次」，**它只在「它是這個 context 裡第一個呼叫金流的測試」時成立** —— JUnit 的方法順序原本剛好讓它排在 `cancelPaidRefunds` 前面。我加了一個測試，順序變了。`reset()` 加一個 `calls.set(0)`，`EventFlowTest` 8 個全綠。

> 📌 **這一節原本要找的是 Redis，找到的是一個從第 07 章就在的 relay 卡死。** 它在每一次建置的日誌裡都有一行 ERROR —— 沒有人會去讀一個綠燈的日誌。日誌只有在「有人在看、或有東西在數」的時候才是可觀測性；否則它只是一個檔案。這一章接下來做的事，大部分是在讓「有東西在數」：`OUTBOX_UNROUTABLE` 這種事，9.10 有一條告警。
> 另一件事：**測試的替身（`InlineEvents`）跟本尊（relay）在邊角的行為不一樣，那個邊角就是測試永遠看不到的地方。** 寫替身的時候，要寫下它在哪裡跟本尊不同。

### 9.2.2 事故二：docker stop 的那 1 秒 ★★

把應用程式裝進容器，最常見的第一版長這樣（`Dockerfile.v1`）：

```dockerfile
FROM eclipse-temurin:21-jre
COPY target/shop-0.0.1-SNAPSHOT.jar /app.jar
EXPOSE 8080
ENTRYPOINT java -jar /app.jar
```

630 MB，建置 3.9 秒。連上 compose 的那一組（同一個 Docker 網路），起來、量 PID 1 是誰、`docker stop` 要多久，三次：

```
  第 1 次 │ ready   6.7 秒（Started ShopApplication in 5.642 seconds）│ 行程：sh java │ docker stop   1.3 秒，結束碼 137
  第 2 次 │ ready   5.9 秒（Started ShopApplication in 4.939 seconds）│ 行程：sh java │ docker stop   1.3 秒，結束碼 137
  第 3 次 │ ready   6.0 秒（Started ShopApplication in 5.053 seconds）│ 行程：sh java │ docker stop   1.3 秒，結束碼 137
```

PID 1 是 `sh`（基礎映像檔是 Ubuntu 26.04，`/bin/sh` 是 dash）—— shell form 的 `ENTRYPOINT` 是 `/bin/sh -c "java -jar /app.jar"`，SIGTERM 送到 `sh`，`sh` 不轉送。這是課本上的那一個坑，我預期 `docker stop` 會等滿 10 秒、然後 SIGKILL。

**可是它只花了 1.3 秒。** 結束碼 137（128 + 9，被 SIGKILL），日誌的最後一行是一封 `MAIL_SENT` —— 一行關機訊息都沒有。拿兩個最簡單的容器確認：

```
[sh -c 'sleep 1000'] stop 1.2s exit 137 StopTimeout=1
[sleep 1000] stop 1.2s exit 137 StopTimeout=1
```

**這台機器上新建的容器，`Config.StopTimeout` 都是 1。** 不帶參數直接打 Docker 的 API 建一個，也是 1；compose 的 MySQL、Redis、RabbitMQ，以及機器上另一個專案的容器，全部是 1。Docker 的文件寫的預設是 10 秒。Docker Desktop 的 VM 裡，`/run/config/docker/daemon.json` 只有一個 `"shutdown-timeout": 2`（那是 daemon 自己關機用的）。**`StopTimeout=1` 是從哪裡來的，我沒有找到。**

那 1 秒的影響有多大？第 06～08 章的每一次 `docker stop shop-rabbitmq-1`，實際上都是「SIGTERM，1 秒後 SIGKILL」。RabbitMQ 好好關機要多久（J1d，閒的時候各三次）：

| | `docker stop` 花了 | 結束碼 | 之後多久接受 AMQP |
|---|---|---|---|
| 預設（1 秒） | 1.4 秒 | **137** | 4.4、5.2、5.0 秒 |
| `-t 30` | 1.4 秒 | **0** | 4.5、5.0、4.9 秒 |

RabbitMQ 好好關機要 1.4 秒 —— 比 1 秒多一點點，所以每一次都被 KILL。重啟的時間兩者一樣，所以前幾章的演練結論不受影響（它們本來就在模擬「行程死掉」）。

應用程式就不一樣了。把 `ENTRYPOINT` 換成 exec form（`["java", "-jar", "/app.jar"]`，`Dockerfile.v2`），PID 1 是 `java`，SIGTERM 會送到 JVM —— 但 Spring 的關機要先停 relay（最多等 `confirmTimeout` + 1 秒）、再停消費者、再關 Tomcat、JPA、連線池，**2 秒以上**。在 1 秒的寬限下，exec form 一樣被 KILL。

使用者感受得到的是什麼？J2b 的客戶端（`loadtest/StopDuringLoad`）每秒 50 張下單，每一張一位新買家、一個新的 `Idempotency-Key`，第 6 秒 `docker stop`。每一個請求的結果分四種；「送出去了、沒有回應」與「逾時」的那幾張，**回資料庫查冪等鍵：訂單其實成立了嗎？**

| 組合 | `docker stop` 花了 | 結束碼 | 201 | 送出去了、沒有回應 | 逾時（5 秒） | 連不上 | 沒回應的裡面，訂單其實成立了 |
|---|---|---|---|---|---|---|---|
| v1 shell form，預設 | 1.2 秒 | 137 | 352 | 6 | 3 | 439 | **0** |
| v2 exec form，預設 | 1.3 秒 | 137 | 352 | 7 | 4 | 437 | **0** |
| v2，`-t 30` | 2.1 秒 | 143 | 388 | 14 | 3 | 395 | **0** |
| v2，`-t 30` ＋ `server.shutdown=graceful` | 3.0 秒 | 143 | 435 | 13 | 4 | 348 | **0** |

（load 5～9。）

三件事：

- **四種組合裡，「沒有拿到回應」的訂單，一張都沒有成立。** 它們全部是「伺服器沒有處理」的那一種 —— 用同一個 `Idempotency-Key` 重送是安全的（US-ORD-1a）。第 04 章的冪等鍵，在部署的這一刻派上了用場。
- **只有給足寬限（`-t 30`）時，JVM 才自己結束**（143 = 128 + 15，SIGTERM）。
- **graceful 沒有讓「送出去了、沒有回應」變少**（13 vs 14）。印出例外訊息重跑一次：17 個全部是 `IOException: HTTP/1.1 header parser received no bytes` —— 請求送上一條 keep-alive 的舊連線，伺服器那一端已經關了。graceful 保護的是「處理到一半」的請求，而每秒 50 張、每張 20 ms 左右，同時在處理的只有一兩張；Tomcat 的 graceful 從開始到結束 53 ms。**在這個專題的請求長度下，graceful 的好處量不出來**；我沒有量長的請求（例如 90 天的日報表）。

> 📌 **「容器的寬限是 10 秒」是一個沒有人會去檢查的假設。** 在這台機器上它是 1 秒，而一個 Spring Boot 應用程式好好關機要 2 秒以上。寬限要寫在部署的設定裡（9.4 的 `stop_grace_period: 30s`），並且用 `docker inspect` 確認 —— 不要看文件。
> 寫在 compose 裡之後（9.5）：`StopTimeout=30`，`docker compose stop app` **4.4 秒、結束碼 143**，日誌依序是消費者停下、Tomcat graceful（4 ms）、JPA、連線池關閉。

### 9.2.3 事故三：應用程式的帳號可以改寫歷史 ★★

0.4.6 的 INV-5：「`inventory_ledger` 只能新增，不能修改、不能刪除」。第 02 章 2.5 把它標成「不是約束，是權限（第 09 章）」。現在應用程式的帳號是這樣：

```
GRANT USAGE ON *.* TO `shop`@`%`
GRANT ALL PRIVILEGES ON `shop`.* TO `shop`@`%`
```

`ALL PRIVILEGES`。用它，在 compose 的資料庫上拿一個自己建的商品（9930001，庫存 10）示範：

| 步驟（全部用應用程式的帳號 `shop`） | `on_hand` | 帳的加總 | INV-3 |
|---|---|---|---|
| ① 正常：出貨 3 件（記一筆 SHIP −3） | 7 | 7 | 差異 0 |
| ② 刪掉出貨那一筆帳 | 7 | 10 | **差異 1** |
| ③ 再把 `on_hand` 改回 10 | 10 | 10 | **差異 0** |
| ④ `CREATE TABLE j9_scratch`、`DROP TABLE j9_scratch` | 成功 | | |

**③ 之後，3 件貨不見了，帳也沒了，對帳說 0。** 第 07、08 章花了很大的力氣讓對帳「抓得到東西」（8.7.3：故意弄壞一筆，它說 1）—— 但它只抓得到**改得不一致**。一個改得一致的人（一個 bug、一個手滑的維運、一個拿到應用程式帳密的攻擊者），對帳看不見；能擋住他的只有權限。

最直覺的寫法是「給整個資料庫的四種權限，再對那兩張表收回 UPDATE、DELETE」：

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON shop.* TO j9_probe@'%';
REVOKE UPDATE, DELETE ON shop.inventory_ledger FROM j9_probe@'%';
```

```
ERROR 1147 (42000) at line 4: There is no such grant defined for user 'j9_probe' on host '%' on table 'inventory_ledger'
```

**MySQL 不能從資料庫層級的權限裡扣掉一張表** —— 表層級的 REVOKE 只能收回表層級的 GRANT（`partial_revokes` 是 OFF；它管的是「全域權限裡排除某個資料庫」，我沒有打開它試）。所以權限只能一張表一張表給，而**以後每一張新的表，都要有人記得授權**。9.11 會把「有人記得」變成一個測試。

> 📌 **對帳回答的是「數字對不對得上」，權限回答的是「誰能讓數字對得上」。** 兩件事都要有：對帳抓 bug，權限擋住「改得很仔細」的那一種。

---

## 9.3 映像檔

### 9.3.1 第一版少了什麼

9.2.2 的第一版有四個問題，每一個都量得到：

| | 第一版 | 後果 |
|---|---|---|
| `ENTRYPOINT` | shell form | PID 1 是 `sh`，SIGTERM 到不了 JVM（9.2.2） |
| 執行身分 | root（`uid=0`） | 容器裡的行程被打穿，拿到的是 root |
| 內容 | 一整個 75.4 MB 的 jar | 改一行程式，推一次 75.4 MB |
| `ENTRYPOINT` 蓋掉了什麼 | 基礎映像檔原本的 `/__cacert_entrypoint.sh` | 那是 Temurin 用來載入自訂 CA 憑證的；這個專題沒用到，但第一版在不知情的情況下拿掉了它（9.3.2 的版本一樣寫 `ENTRYPOINT ["java", …]`，一樣不經過它 —— 這一次是知道的；需要自訂 CA 時，改成 `ENTRYPOINT ["/__cacert_entrypoint.sh", "java", …]`，它最後會 exec 後面的命令） |

還有一個前提：第一版要先在主機上 `mvn package`。0.6.8 的「新人上手」要的是 clone 之後就跑得起來 —— 主機上有沒有 JDK、Maven 是哪一版，不應該是前提。

### 9.3.2 多階段、分層

Spring Boot 3.2 的 jar 可以用 layertools 拆成四層。這個專題拆出來是：

```
71M	dependencies
576K	spring-boot-loader
0B	snapshot-dependencies
1.3M	application          ← 我們自己的程式碼（246 個檔）
```

**98% 是依賴，我們自己的程式碼 1.3 MB。** 依「多久變一次」排序放進映像檔，改一行程式就只會動最後一層：

```dockerfile
# syntax=docker/dockerfile:1
# 第 09 章（9.3）：應用程式的映像檔。
#   docker build -t shop .
# 測試不在這裡跑：mvn verify（含 Testcontainers）是 CI 的事（8.8），映像檔只負責「把通過的那一份包起來」。

# ── 第一階段：編譯、打包、拆層 ──────────────────────────────────────────
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /src
COPY pom.xml .
COPY src src
# --mount=type=cache：~/.m2 留在 BuildKit 的快取裡，改一行程式不用重新下載所有依賴（9.3.2）
RUN --mount=type=cache,target=/root/.m2 mvn -B -ntp -q -DskipTests package \
 && java -Djarmode=layertools -jar target/shop-0.0.1-SNAPSHOT.jar extract --destination /layers

# ── 第二階段：只有 JRE 與四層 ──────────────────────────────────────────
FROM eclipse-temurin:21-jre
RUN groupadd --system shop && useradd --system --gid shop --no-create-home shop
WORKDIR /app
# 9.3.2：依「多久變一次」排序。改一行程式只動最後一層（約 1.3 MB），第一版每次是整個 jar（75.4 MB）
COPY --from=build /layers/dependencies/ ./
COPY --from=build /layers/spring-boot-loader/ ./
COPY --from=build /layers/snapshot-dependencies/ ./
COPY --from=build /layers/application/ ./
USER shop
EXPOSE 8080
# 9.5：exec form —— java 是 PID 1，docker stop 的 SIGTERM 直接送到 JVM（shell form 的 PID 1 是 sh，它不轉送）
# 9.6：容器的記憶體上限的 75% 給 heap（預設是 25%）。直接寫在這裡，不用 JDK_JAVA_OPTIONS 環境變數 ——
# java 啟動器讀到它會在 stderr 印一行「NOTE: Picked up JDK_JAVA_OPTIONS…」，「一行一個 JSON」的日誌就多了一行不是 JSON 的（9.13）
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75", "-XX:+ExitOnOutOfMemoryError", "org.springframework.boot.loader.launch.JarLauncher"]
```

```
# .dockerignore —— 建置的 context 只要 pom.xml 與 src/
.git
target
scripts
*.log
```

**`-DskipTests` 是刻意的。** 測試要 Testcontainers，在 `docker build` 裡起不了容器；而且測試已經在 CI 的 `mvn verify` 跑過（8.8）。映像檔的工作是「把通過的那一份包起來」，不是再驗證一次。

量三件事：

| | 時間 | 映像檔 | 變了的層 |
|---|---|---|---|
| 第一版（`COPY jar`，主機先打包） | 3.9 秒（不含主機上的 `mvn package`） | 630 MB | 每次一個 75.4 MB 的層 |
| 多階段，冷建置（BuildKit 的快取清空，所有依賴重新下載） | 64.3 秒 | 632 MB | —— |
| 多階段，改一行程式（`PingController` 的一個字串）之後重建 | **9.5 秒**（其中 `mvn package` 6.5 秒） | 632 MB | **1 層，1.59 MB** |

映像檔的大小幾乎一樣（JRE 本身就佔了 490 MB 左右）；差別在**每一次部署要搬動的東西**：75.4 MB → 1.59 MB。

### 9.3.3 映像檔裡有什麼、沒有什麼

基礎映像檔裡有 `curl`、`wget`、`bash`，沒有 `nc`。9.4 的健康檢查用 `curl`。執行身分是 `shop`（uid 999）—— 9.13 的檢查清單會確認。

---

## 9.4 完整的 compose：migration 是一個步驟

### 9.4.1 應用程式不拿 DDL 的帳號

> ⚠️ **前置：這一節用到的 `shop_migrator` 帳號與 `shop_app` 角色，是 9.11 才建立的。** 課文照「先看見問題、再講設計」的順序寫，實際動手時請先做完 9.11.1 的 `docker/mysql-init/00-users.sql` 與 V15～V22、9.11.4 的 V23，再回來做這一節 —— 否則 `migrate` 會用一個不存在的帳號連 MySQL。手上是第 08 章 compose volume 的人，`00-users.sql` 不會自動執行，要照 9.11.3 手動跑一次。9.4.3 的輸出是「23 個 migration」，就是這個原因。

第 00 章的 `compose.yaml` 只有三個依賴；應用程式在 IDE 或 `mvn spring-boot:run` 裡跑，啟動時自己跑 Flyway。9.11 會把應用程式的資料庫帳號收到「只有一個角色」—— 它連 `CREATE TABLE` 都不能做了。那 migration 誰跑？

**部署的一個步驟。** compose 裡一個一次性的服務 `migrate`，用 Flyway 官方的映像檔（版本對應 Boot 3.2.5 管理的 `flyway-core` 9.22.3）、`shop_migrator` 這個帳號；應用程式等它成功之後才啟動，自己的 Flyway 關掉（`application-prod.yml`：`spring.flyway.enabled: false`）。測試與本機開發照舊由應用程式跑 Flyway，只是換成 `shop_migrator` 的帳密（`spring.flyway.user`）—— 9.11.3。

新加的服務放在 compose 的 `app` profile 裡。預設的 `docker compose up` 照舊只起三個依賴，第 00～08 章的開發方式不變：

```yaml
  # ───── 第 09 章：應用程式與監控（docker compose --profile app up -d --wait）─────
  migrate:                          # 9.4：migration 是一個一次性的步驟，跑完才起應用程式；DDL 的帳號只在這裡（INV-5，9.11）
    image: flyway/flyway:9.22.3     # 跟 Boot 3.2.5 管理的 flyway-core 同一個版本
    profiles: [app]
    # list 形式：第一版寫成一個字串，compose 依 shell 的規則切開，URL 裡的 & 被當成命令分隔 ——
    # Flyway 只收到 -url，印出使用說明、結束碼 0，service_completed_successfully 照樣放行了應用程式（9.4）
    command: ["-url=jdbc:mysql://mysql:3306/shop?allowPublicKeyRetrieval=true&useSSL=false", "-user=shop_migrator", "-password=shop_migrator", "-connectRetries=10", "migrate"]
    volumes: [./src/main/resources/db/migration:/flyway/sql:ro]
    depends_on:
      mysql: {condition: service_healthy}

  app:
    build: .
    image: shop:local
    profiles: [app]
    environment:
      SPRING_PROFILES_ACTIVE: prod
      # 本機的值。正式環境的秘密不在 repo 裡（0.6.5），由部署平台注入同樣名字的環境變數
      SHOP_DB_HOST: mysql
      SHOP_DB_USER: shop
      SHOP_DB_PASSWORD: shop
      ……（Redis、RabbitMQ、JWT、金流回呼、第一位管理員）
    ports: ["${SHOP_HTTP_PORT:-8080}:8080"]   # 8081（actuator）不對外
    healthcheck:
      test: ["CMD", "curl", "-fs", "localhost:8081/actuator/health/readiness"]
      ……
    stop_grace_period: 30s          # 9.5：這台機器上容器的預設是 1 秒（Config.StopTimeout=1）—— 不寫的話，關機到一半就被 KILL
    deploy:
      resources:
        limits: {cpus: "4", memory: 1g}   # 9.6：2 顆 CPU 的時候熱點 p99 秒級；記憶體最高 640～670 MiB
    depends_on:
      migrate: {condition: service_completed_successfully}
      redis: {condition: service_healthy}
      rabbitmq: {condition: service_healthy}
```

（另外還有 `prometheus`、`mysqld-exporter`、`alertmanager`、`alert-sink`，9.10 說。上面的 `……` 省略了幾行，`compose.yaml` 的全文在 9.15.1。app 的 `environment` 每一個都要給：例如 `application-prod.yml` 的 `${SHOP_REDIS_PASSWORD}` 沒有預設值，compose 的 Redis 沒有密碼，也要明寫 `SHOP_REDIS_PASSWORD: ""`。）

`application-prod.yml` 在第 01 章就有了：每一個連線、帳密、秘密都是 `${SHOP_…}`。這一章加的是：

```yaml
spring:
  main:
    banner-mode: off               # 9.7：banner 直接寫 stdout、不經過 Logback —— 「一行一個 JSON」會多出 7 行不是 JSON 的
  flyway:
    enabled: false                 # 9.4：migration 是部署的一個步驟
  lifecycle:
    timeout-per-shutdown-phase: 20s   # 9.5：compose 的 stop_grace_period 是 30 秒；要比它短
springdoc:                         # 9.13：API 文件不對外
  api-docs: {enabled: false}
  swagger-ui: {enabled: false}
logging:
  config: classpath:logback-json.xml   # 9.7
server:
  shutdown: graceful               # 9.5
management:
  server:
    port: 8081                     # 9.9：actuator 只在這個埠；它不對外
```

（這是要**合併**進既有檔案的鍵，不是貼在檔尾的另一段：`spring:`、`management:` 第 01 章就有了 —— `main`、`flyway`、`lifecycle` 放進既有的 `spring:` 底下，`server.port: 8081` 放進既有的 `management:` 底下。同一個 YAML 檔裡重複的頂層鍵，Spring Boot 會拒絕載入。合併後的全文在 9.15.1。）

### 9.4.2 第一次：三個錯

這台機器的 8080 被另一個專案的容器佔著（8.8.3），所以用 `SHOP_HTTP_PORT=18090`：

```bash
SHOP_HTTP_PORT=18090 docker compose --profile app up -d --wait
```

（也可以寫進 repo 根目錄的 `.env`：`SHOP_HTTP_PORT=18090`，compose 會自己讀；`.env` 是每個人自己機器上的設定，這一章把它加進了 `.gitignore`。）

```
 Container shop-migrate-1 Exited
 ……
container shop-app-1 exited (1)
```

27.5 秒，結束碼 1。三件事：

**① `shop-mysql-1` 被重建了**（`Up 9 seconds`）。repo 換過位置，`./docker/mysql-init` 這個 bind mount 的絕對路徑變了，compose 判定 MySQL 的設定不同。資料在具名的 volume 裡，沒事 —— 但如果它是正式環境的資料庫、而 volume 是匿名的，這一次重建就是一次資料遺失。

**② `migrate` 印出了 Flyway 的使用說明。** 看 compose 實際傳給容器的參數：

```
["-url=jdbc:mysql://mysql:3306/shop?allowPublicKeyRetrieval=true"]
```

我把 `command` 寫成一個字串，compose 依 shell 的規則切開，**URL 裡的 `&` 被當成命令分隔**，後面的 `useSSL=false -user=… migrate` 全部不見了。Flyway 收到一個參數、沒有命令，印出說明、**結束碼 0** —— 所以 `service_completed_successfully` 成立，應用程式照樣被啟動了。一個 migration 根本沒跑的部署，看起來每一步都成功。改成 list 形式。

**③ 應用程式起不來：**

```
Binding to target … ShopProperties failed:
    Property: shop.flyway.enabled
    Value: "false"
    Origin: class path resource [application-prod.yml] - 28:14
    Reason: The elements [shop.flyway.enabled] were left unbound.
```

我把 `flyway.enabled` 插到了 `shop:` 底下。第 01 章給 `ShopProperties` 設的 `ignoreUnknownFields = false` 當場擋下 —— 不然這一行會被默默忽略，應用程式會在啟動時用 `shop`（沒有 DDL 權限）去跑 Flyway。

### 9.4.3 第二次：一個命令

```
exit 0 ；17.2 秒（load { 3.84 4.90 4.76 }）
shop-app-1 Up 5 seconds (healthy)
shop-migrate-1 Exited (0) 6 seconds ago
……
migrate-1  | Successfully validated 23 migrations (execution time 00:00.020s)
migrate-1  | Schema `shop` is up to date. No migration necessary.
```

**17.2 秒，一個命令**（基礎設施已經在跑、映像檔有快取；冷的機器我沒有量）。逐項驗證起來的東西：

```
18090/api/ping                → 200
18090/api/products/3          → 200
18090/actuator/health         → 404      ← actuator 不在對外的埠
18090/actuator/prometheus     → 401
容器裡 8081/actuator/prometheus → 200
  PID USER     COMMAND
    1 shop     java org.springframework.boot.loader.launch.JarLauncher
```

`application-prod.yml` 從第 01 章起就寫著 `sslMode=REQUIRED`。compose 的 MySQL 8 自己產生了憑證，所以它是不是真的加密，看資料庫這一邊：

```
user	ssl_version	ssl_cipher	connections
shop	TLSv1.3	TLS_AES_256_GCM_SHA384	20
```

應用程式的 20 條連線全部是 TLS 1.3。但 `REQUIRED` 只要求加密、**不驗證憑證** —— 一個冒充 MySQL 的中間人照樣連得上。正式環境要用 `VERIFY_IDENTITY` 加上真的 CA；這一條進上線檢查清單（9.13）。

後來加了 V24、V25（9.12）之後再部署一次，`migrate` 在 10 萬張訂單的那台資料庫上：

```
migrate-1  | Migrating schema `shop` to version "24 - inventory ledger checkpoints"
migrate-1  | Migrating schema `shop` to version "25 - inventory ledger watermark"
migrate-1  | Successfully applied 2 migrations to schema `shop`, now at version v25 (execution time 00:00.050s)
```

> 📌 **「每一步都回 0」不等於「每一步都做了該做的事」。** `migrate` 印出使用說明、結束碼 0，compose 的依賴條件只看結束碼。部署的每一個步驟，要用它的輸出確認（`Successfully applied` / `up to date`），不要只看綠燈。
> 0.6.8 的「新人上手」從「兩個命令（前提是 8080 是空的）」變成「一個命令」—— 前提一樣要寫出來：8080（或 `SHOP_HTTP_PORT`）、3306、6379、5672、15672、9090、9093 都空著。

---

## 9.5 關機：SIGTERM、寬限、graceful

9.2.2 量的是「寬限只有 1 秒」的後果。這裡把三件事分開：

| 誰負責 | 設定 | 管什麼 | 這個專題 |
|---|---|---|---|
| Docker | `stop_grace_period`（compose）、`--stop-timeout` | SIGTERM 之後等多久才 SIGKILL | 30 秒（這台機器的預設是 1 秒） |
| 映像檔 | `ENTRYPOINT` 的寫法 | SIGTERM 到不到得了 JVM | exec form：`java` 是 PID 1 |
| Spring | `server.shutdown: graceful`、`spring.lifecycle.timeout-per-shutdown-phase` | Tomcat 先停止接新的請求、等手上的做完；每一個階段最多等多久 | graceful、20 秒（比 30 秒短） |

順序很重要。Spring 依 `SmartLifecycle` 的 phase 由大到小停：relay（`Integer.MAX_VALUE - 100`）先停、消費者（`- 200`）其次，兩者都比 Tomcat 的 graceful（`- 1024`）**更早**停。所以 9.2.2 J2b 裡，SIGTERM 之後大約 2 秒，Tomcat 才開始關 —— 這 2 秒裡進來的下單照樣 201，它們的事件留在 outbox，等下一個實例的 relay 送（第 07 章的 outbox 在這裡又派上用場）。

compose 裡加上 `stop_grace_period: 30s` 之後：

```
StopTimeout=30
 Container shop-app-1 Stopped
stop 花了 4.4 秒；結束碼 143
06:14:51.571 SpringApplicationShutd Successfully waited for workers to finish.
……（消費者一個一個停下來）
06:14:53.699 SpringApplicationShutd Commencing graceful shutdown. Waiting for active requests to complete
06:14:53.703 tomcat-shutdown        Graceful shutdown complete
06:14:53.872 SpringApplicationShutd Closing JPA EntityManagerFactory for persistence unit 'default'
06:14:53.878 SpringApplicationShutd HikariPool-1 - Shutdown initiated...
06:14:53.891 SpringApplicationShutd HikariPool-1 - Shutdown completed.
```

4.4 秒、自己結束、每一個資源都關了。對照預設的 1 秒：137、一行都沒有。

`timeout-per-shutdown-phase: 20s` 有一點要注意：它是**每一個 phase** 的上限，不是整個關機的上限。relay、消費者、Tomcat 的 graceful 各在不同的 phase，最壞的情況是一段一段累加，可以超過 compose 的 30 秒；而且它只限制「非同步停止」的那一種 —— relay 的 `stop()` 是同步的 `awaitTermination`（最多 `confirmTimeout` + 1 秒，也就是 6 秒），不受它管。這個專題實測 4.4 秒，離 30 秒很遠；但如果以後有某一個 phase 真的會等很久（例如長的請求），寬限要用「每一段的上限加起來」來估，不是只跟 20 秒比。

還有一件 J2b 量到、但這一章沒有解決的：**停機的那一刻，送上 keep-alive 舊連線的請求拿不到回應**（`header parser received no bytes`），不管有沒有 graceful。前面有負載平衡器的時候，它會先把這個實例摘掉、再送 SIGTERM（Kubernetes 的 preStop），這一段才會消失；compose 沒有負載平衡器，我沒有量。能確定的是：那些請求伺服器都沒有處理（0 張成立），帶同一個 `Idempotency-Key` 重送是安全的。

---

## 9.6 正式環境的規格：CPU、記憶體、暖機

第 08 章 8.6.2 的結論是：「暖機之後、機器沒有被佔滿時，熱點 p99 < 500 ms；要知道正式環境的那一台會不會被佔滿，要在正式環境的規格上量 —— 那是第 09 章的部署環境的事。」

這個專題沒有正式環境。能做的是**把應用程式限制在一個正式環境可能給的大小**，在同一台機器上量 —— 它回答的是「給它幾顆 CPU、多少記憶體夠」，不是「正式環境的那一台會怎樣」。

### 9.6.1 JVM 在容器裡看到多少記憶體

JVM 依容器的記憶體上限決定 heap 的上限（預設 25%）。`-XX:+PrintFlagsFinal` 看 `MaxHeapSize`：

| 容器的記憶體上限 | JVM 的設定 | heap 上限 |
|---|---|---|
| 不限 | `MaxRAMPercentage=75` | **5,880 MB**（Docker VM 的 7.65 GB 的 75%） |
| 1 GB | `MaxRAMPercentage=75` | 768 MB |
| 1 GB | 預設（25%） | 256 MB |
| 1 GB | `-Xmx512m`（0.6.2 的量測環境） | 512 MB |
| 512 MB | `MaxRAMPercentage=75` | 384 MB |
| 512 MB | 預設 | 128 MB |

**不設上限的容器，JVM 以為整台 VM 都是它的。** 跟 MySQL、Redis、RabbitMQ 放在同一台機器上時，那是一個會被 OOM killer 收掉的假設。（一個小坑：`-e JDK_JAVA_OPTIONS=`（空字串）會蓋掉映像檔裡的 `ENV`，回到預設的 25%。這也是後來把參數搬進 `ENTRYPOINT` 的另一個理由。）

### 9.6.2 三種規格

8.6.2 的搶購（2,000 個買家、500 件、每秒 200 個、503 用同一個鍵重送），應用程式在容器裡（`MaxRAMPercentage=75`），三種規格交錯兩次，每次開始前等 load 降到 8 以下；同時每秒取一次 `docker stats`：

| 規格 | 第一輪（新實例）p99 | 量的那 4 輪 p99（ms） | 記憶體最高 | CPU 最高 |
|---|---|---|---|---|
| 不限 | 1,490、1,895 | 88、130、124、135 | 637、666 MiB | 581%、557% |
| 4 CPU、1 GB | 2,623、2,904 | 94、53、205、63 | 660、651 MiB | 483%、389% |
| 2 CPU、1 GB | **7,191（59 個 503）、6,732（56 個 503）** | **3,176**（2 個 503）、**1,325**、**1,888**、214 | 665、649 MiB | 222%、210% |

（load 3.9～6.5。每一輪都是 `reserved=500 明細=500 RESERVE 帳=500`。）

- **2 顆 CPU 不夠。** 量的那 4 輪裡 3 輪超過 500 ms；新實例的第一輪 7 秒、五十幾個 503。
- **4 顆 CPU：4 輪都在 500 ms 以下。**
- **記憶體在三種規格下都是 640～670 MiB**，1 GB 的上限、768 MB 的 heap 沒有被 OOM（`OOMKilled=false`）。

所以 compose 給應用程式 `cpus: "4"`、`memory: 1g`。

### 9.6.3 我的一個推測，被推翻

「不限」那一行，量的那 4 輪是 88～135 ms —— 比第 08 章在主機上用 `java -jar` 量的 108～331 ms 還低。我的推測是：容器跟 MySQL、Redis 在同一個 Docker VM 裡直接連線，主機上的 `java -jar` 每一次查詢都要經過 Docker Desktop 的轉送層。

交錯量之前，這只是推測。J4b 把「主機 `java -jar`」與「容器、不限」交錯兩次：

| | 量的那 4 輪 p99（ms） |
|---|---|
| 主機 `java -jar` | 96、181、280、161 |
| 容器、不限 | **1,080**、266、103、**1,054**（第二次的最後一輪有 584 個 503） |

**推翻了。** 範圍重疊，容器那邊還有兩輪秒級。上一組的「比較快」只是那幾輪剛好比較好 —— 這就是為什麼延遲的比較一律交錯執行。

而那 584 個 503，日誌只有一行：

```
WARN 1 --- [shop] [o-8080-exec-130] c.example.shop.shared.redis.RedisGuard : REDIS_DEGRADED ratelimit 失敗（1 秒內第 3 次），5 秒內所有 Redis 呼叫改走降級路徑：Redis command timed out
```

**這就是 8.6.5 想知道、卻因為日誌被覆蓋而看不到的那一行：是哪一個呼叫。** 這一次是限流（`ratelimit`）的 Redis 指令在 1 秒內逾時 3 次，`RedisGuard` 跳開，熱點下單照 0.6.3 回 503 五秒、重送也是 503。為什麼逾時 —— 這一次 CPU 最高 588%，不限 CPU 的應用程式跟 Redis 擠在同一台 VM 上，是可能的原因，但我沒有量；而且這是另一次演練，不能說 8.6.5 那一次也是同一個呼叫。

### 9.6.4 新實例的第一輪

每一組的第一輪都是秒級：4 顆 CPU 時 2.6～2.9 秒。8.6.2 說「新啟動的實例，第一個 10 秒是另一個系統」，第 08 章的練習四建議「readiness 之前先自己打一輪暖機的請求」。在動手之前，先量暖機的成本在哪裡：**先送 40 秒唯讀的流量**（`GET /api/orders` 每秒 100 次，會走過 JWT、Spring Security、JPA、Jackson、Tomcat 的執行緒，不寫任何資料），再開始搶購。4 顆 CPU，交錯兩次：

| 4 CPU、1 GB | 搶購第一輪 p99 | 之後兩輪 |
|---|---|---|
| 沒有暖機 | 3,221（6 個 503）、3,242 | 551、65／76、70 |
| 先送 40 秒唯讀流量 | **817、679** | 70、260／99、282 |

（腳本裡的標籤寫成「30 秒」—— `orders` 模式其實跑了 4 輪，是 40 秒。）

**唯讀的暖機把第一輪降到原來的四分之一左右，但還是超過 500 ms。** 大部分的暖機成本在共用的路徑上；剩下的 0.7 秒左右是下單專屬的那一段（熱點的 Lua、交易、outbox），唯讀的請求暖不到它。要暖那一段，就要真的下單 —— 一個會寫資料的暖機。這一章沒有實作，留在練習。

ORD-1b AC-2 這一章記成：**4 顆 CPU 時，暖機之後達成（J4、J4c 合計 12 輪裡 11 輪 < 500 ms：94、53、205、63、551、65、76、70、70、260、99、282）；2 顆 CPU 時沒有；新實例的第一輪沒有（0.7～3.2 秒）。** 還是「部分」，但「部分」的邊界比第 08 章清楚了：缺的是暖機，不是 CPU。

> 📌 **「在正式環境的規格上量」，在沒有正式環境的時候，可以先變成「它要什麼規格」。** 2 顆 CPU 與 4 顆 CPU 的差別是秒級與百毫秒級；記憶體 650 MiB 左右、1 GB 的上限夠。這些數字寫進 compose 的 `limits`，就是一份可以拿去跟維運談的規格 —— 每一個數字都有一次量測在後面。

---

## 9.7 日誌：一行一個 JSON、UTC、遮罩

### 9.7.1 為什麼要 JSON

0.6.6：「日誌：JSON 格式，每一行都有 `traceId`；業務日誌帶 `userId`、`orderNo`（有的話）」。文字格式給人讀，JSON 給機器查 —— 9.2.1 那 3,449 行，我用 `awk`、`sed`、`uniq` 才數出種類；如果每一行都是 JSON、有 `level` 與 `logger_name` 欄位，那是一句查詢。

Spring Boot 3.2 還沒有內建的結構化日誌（3.4 才有），所以用 logstash-logback-encoder（7.4，對應 Boot 3.2 的 Logback 1.4）。設定檔只在正式環境用（`application-prod.yml` 的 `logging.config`）；本機與測試照舊是文字：

```xml
<appender name="JSON" class="ch.qos.logback.core.ConsoleAppender">
  <encoder class="net.logstash.logback.encoder.LogstashEncoder">
    <timeZone>UTC</timeZone>
    <customFields>{"service":"shop"}</customFields>
    <fieldNames>
      <version>[ignore]</version>
      <levelValue>[ignore]</levelValue>
    </fieldNames>
    <includeMdcKeyName>traceId</includeMdcKeyName>
    <includeMdcKeyName>spanId</includeMdcKeyName>
    <includeMdcKeyName>userId</includeMdcKeyName>
    <includeMdcKeyName>orderNo</includeMdcKeyName>
    <throwableConverter class="net.logstash.logback.stacktrace.ShortenedThrowableConverter">
      <maxDepthPerThrowable>20</maxDepthPerThrowable>
      <rootCauseFirst>true</rootCauseFirst>
      <exclude>^(org\.springframework\.(web\.filter|security\.web)|org\.apache\.(catalina|coyote|tomcat)|jakarta\.servlet)\.</exclude>
    </throwableConverter>
    <jsonGeneratorDecorator class="net.logstash.logback.mask.MaskingJsonGeneratorDecorator">
      <valueMask>
        <value>([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})</value>
        <mask>$1***@$2</mask>
      </valueMask>
      <valueMask>
        <value>eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}</value>
        <mask>[JWT]</mask>
      </valueMask>
    </jsonGeneratorDecorator>
  </encoder>
</appender>
```

（這裡只列出 appender。檔案外層還要有 `<configuration>`，最後要把這個 appender 掛到 root logger 上：`<root level="INFO"><appender-ref ref="JSON"/></root>` —— 少了它，正式環境一行日誌都不會輸出，`JsonLogFormatTest` 也拿不到這個 appender。全文在 9.15.1。）

三個決定：

- **只帶列出來的 MDC。** MDC 裡什麼都有可能被放進去（某一個函式庫放的、某一個工程師為了除錯放的）；列出來的才會出現在日誌裡。
- **時間一律 UTC。** 0.10.4 說「第 09 章會把日誌也統一成 UTC」。容器裡的 JVM 本來就是 UTC（容器沒有設時區）—— 9.2.2 的第一版容器日誌就是 `04:13:04.577Z`，主機上是 `+08:00`。寫在設定裡，不靠容器剛好沒設。
- **在編碼的最後一步再遮一次個資。** 0.6.5 要求 email 遮罩、不記 token。程式碼裡已經用 `Email.mask()`（第 05 章）；這一層是給「某一行忘了遮」的，例如一個把 SQL 錯誤訊息整個印出來的例外。

`JsonLogFormatTest` 用正式的那一份設定檔編碼三行：

```
9.7 {"@timestamp":"2026-10-06T04:56:08.123Z","message":"ORDER_PLACED orderNo=20261006-000001 buyerId=1001","logger_name":"com.example.shop.Demo","thread_name":"main","level":"WARN","spanId":"e0dd11d168dd9a64","traceId":"6ac47feb3eb3c9f6e0dd11d168dd9a64","orderNo":"20261006-000001","userId":"1001","service":"shop"}（312 bytes）
9.7 {"@timestamp":"2026-10-06T04:56:08.123Z","message":"註冊失敗 g***@example.com Authorization: Bearer [JWT]",…}（203 bytes）
9.7 {…,"stack_trace":"java.sql.SQLException: Duplicate entry 'x***@example.com'\n\t... 70 common frames omitted\nWrapped by: java.lang.IllegalStateException: 外層\n…"}
```

`$1`、`$2` 的群組參照可以用；堆疊從根本原因開始印，連例外訊息裡的 email 也遮了。

### 9.7.2 現在的日誌裡有沒有個資

遮罩是最後一道防線。那第一道（程式碼本身）漏了多少？把 J0 那一次完整建置的 36 份測試報告（裡面是 188 個測試的完整日誌）用正規表示式掃一遍：

```
email（完整）: 1 次，1 個測試類別：{'schema.SchemaConstraintTest': 1}
JWT（eyJ…）: 0 次
Bearer: 0 次
password=: 0 次
```

唯一的一次是 `SchemaConstraintTest` 自己印的 `Duplicate entry 'gary@example.com' for key 'users.uk_users_email'` —— 測試的輸出，不是應用程式的日誌。我原本擔心的那一種（4.4.4 看過：Hibernate 的 `SqlExceptionHelper` 會在例外往上丟之前，用 ERROR 把 MySQL 的錯誤訊息印出來，重複註冊的時候那裡面就是 email）沒有發生 —— 註冊走的是 JDBC，接的是 `DuplicateKeyException`，Hibernate 不在那條路上。**這是「測試走得到的地方沒有」，不是「不會有」**，所以遮罩那一層還是留著。

### 9.7.3 兩行不是 JSON 的

「一行一個 JSON」要真的每一行都是。9.13 的上線檢查清單抓到兩次例外：

- **Spring Boot 的 banner**：7 行。日誌系統其實在 banner 之前就依 `logging.config` 初始化好了，但 banner 預設（`banner-mode: console`）直接寫 `System.out`、不經過 Logback，所以不會被編成 JSON。`spring.main.banner-mode: off`（設成 `log` 則會讓它經過 Logback，變成一行 JSON）。
- **`NOTE: Picked up JDK_JAVA_OPTIONS: -XX:MaxRAMPercentage=75 -XX:+ExitOnOutOfMemoryError`**：java 啟動器讀到這個環境變數時，自己在 stderr 印的（`JAVA_TOOL_OPTIONS` 也會）。把 JVM 參數搬進 `ENTRYPOINT`。

收日誌的系統遇到不是 JSON 的行，通常是解析失敗、丟掉或另外存；一行兩行看起來無所謂，但「每一行都是 JSON」是寫查詢、寫告警的前提。

---

## 9.8 traceId：驗收 Q7

### 9.8.1 先寫測試

0.12.1 的 Q7：「任一請求的日誌都帶 traceId，且能以 traceId 串起 HTTP → DB → MQ 消費端」。照第 00 章 0.13.3 的規矩，先把它從 `@Disabled` 改成一個真的測試，看它紅在哪裡。

它起一個打開 relay 與消費者的應用程式，在 Logback 的 root logger 上掛一個 appender（`support.CapturedLogs`），直接讀每一行日誌當下的 MDC，分五段斷言（Q7 與 `CapturedLogs` 的全文在 9.15.1）：

1. **HTTP**：下單的回應帶著 `X-Trace-Id`；這個請求的執行緒寫的每一行日誌，traceId 都是它。
2. **DB**：這張訂單的 `outbox_events.trace_id` 是它；另一位買家越權讀這張訂單（404）—— `audit_logs.trace_id` 是那一個請求的 traceId，並且 404 的回應裡也有它。
3. **MQ**：消費者寄出「訂單成立」的那一行，traceId 跟下單的 HTTP 請求一樣；消費者的每一行都帶 traceId。
4. **任一請求**：再下 20 張（20 位買家），20 個不同的 traceId，outbox 每一列都有。
5. 外面帶進來的 traceId 不收（9.8.4）。

一個 Logback 的細節：`LoggingEvent` 的 MDC 是**用到的時候才去讀「目前這條執行緒」的** —— appender 收到事件的當下不呼叫 `prepareForDeferredProcessing()`，之後在測試的執行緒上讀，拿到的是測試執行緒的 MDC。

什麼都還沒做的時候：

```
Q7 ① HTTP 下單：X-Trace-Id=null；請求執行緒的日誌 0 行，帶 traceId 0 行
Q7 ② DB：outbox_events.trace_id=null；越權 404、X-Trace-Id=null → audit_logs.trace_id=null
Q7 ③ MQ：消費者的日誌 21 行，帶 traceId 0 行；寄出「訂單成立」那一行的 traceId=null
Q7 ④ 再下 20 張：回應的 traceId 不同的有 0 個；outbox 的 order.placed 21 列，trace_id 有值 0 列
```

每一格都是 null 或 0。還有一件我沒想到的：**一張成功的訂單，在請求的執行緒上一行日誌都沒有。** 出事的時候，「這張訂單是哪一個請求建的」只能從別的地方往回找。

（④ 用 20 位買家：同一位買家連下 21 張的話，0.6.5 的「每位使用者每分鐘 10 張」從第 11 張起就擋掉了。）

### 9.8.2 一個依賴，修好兩格

只加一個依賴，其他什麼都不改：

```xml
<!-- 第 09 章（9.8）：traceId。Micrometer Tracing 的 Brave 實作，版本由 Boot 管理；沒有送去任何地方（沒有 Zipkin），只要 traceId 進 MDC -->
<dependency><groupId>io.micrometer</groupId><artifactId>micrometer-tracing-bridge-brave</artifactId></dependency>
```

```
Q7 ② DB：outbox_events.trace_id=6ac47f688251c03e65e739c0b03ca7c7；越權 404、X-Trace-Id=null → audit_logs.trace_id=6ac47f680a2ed79a87cadc2308d89b8f
Q7 ④ 再下 20 張：……；outbox 的 order.placed 21 列，trace_id 有值 21 列
```

**outbox 的 21 列、稽核那一列，全部有 traceId 了。** `JdbcOutbox`（7.4.1）與 `JdbcAuditLog`（5.9）從第 05、07 章起就寫著 `MDC.get("traceId")`，註解是「第 09 章才有人放進 MDC」—— Micrometer Tracing 的 HTTP 觀測（`ServerHttpObservationFilter`）一開，那個值就有了。

兩個值得記下來的觀察：

- **抽樣（`management.tracing.sampling.probability`）的預設是 0.1，但 21 個請求全部有 traceId。** 抽樣決定的是「要不要把這個 span 送出去」（這個專題沒有送去任何地方），不是「MDC 裡有沒有 traceId」。
- 兩個不同請求的 traceId，前 8 個字元一樣（`6ac47f68…`）。Brave 的 128 位元 traceId，前 32 位元是時間戳（秒）—— 同一秒附近的 trace 開頭會相同，在日誌裡用 traceId 搜尋時，要用完整的 32 個字元。

### 9.8.3 剩下的三格：消費者、回應、請求的日誌

**消費者。** relay 送出的訊息早就帶著 `traceId` 這個 header（7.4.2，從 outbox 的那一欄來），可是消費者的執行緒上沒有人讀它。`shared.observability.Traces` 在同一個 trace 底下開一個新的 span：

```java
/** ① 接著別人的 traceId 做事。traceId 是 null 或格式不對（舊的事件、別的系統送來的）→ 開一個新的 trace */
public <T> T continueTrace(String traceId, String name, Supplier<T> work) {
    Span span;
    if (traceId != null && TRACE_ID.matcher(traceId).matches()) {
        TraceContext parent = tracer.traceContextBuilder().traceId(traceId)
                .spanId(String.format("%016x", ThreadLocalRandom.current().nextLong(1, Long.MAX_VALUE))).build();
        span = tracer.spanBuilder().setParent(parent).name(name).start();
    } else {
        span = tracer.nextSpan().name(name).start();
    }
    return inScope(span, work);
}
```

（`Traces` 的全文 —— 包括排程用的 `newTrace` 與上面用到的 `inScope` —— 在 9.15.1。）

```java
/**
 * 9.8：接著下單那個請求的 traceId 處理（relay 把 outbox_events.trace_id 放在 header traceId，7.4）。
 * 第 07 章到第 08 章，header 一直都在，但沒有人讀它 —— 消費者的每一行日誌都沒有 traceId（驗收 Q7 的第 ③ 段）
 */
void onMessage(EventHandler h, Message m, Channel ch) throws IOException {
    Object traceId = m.getMessageProperties().getHeaders().get("traceId");
    try {
        traces.continueTrace(traceId == null ? null : traceId.toString(), "consume " + h.consumer(), () -> {
            try { handle(h, m, ch); } catch (IOException e) { throw new java.io.UncheckedIOException(e); }
            return null;
        });
    } catch (java.io.UncheckedIOException e) {
        throw e.getCause();
    }
}
```

消費者處理時又寫進 outbox 的下一個事件（例如落帳失敗 → 取消 → `order.cancelled`），因為 MDC 裡的 traceId 還是同一個，下一段也接得上。重試、死信的那一份訊息會複製原本所有的 header（7.5.3 的 `copy()`），traceId 跟著走。事件 payload 裡如果有 `orderNo`，同時放進 MDC（0.6.6：業務日誌帶 orderNo）。

**回應。** 一個 filter 在 Micrometer 的觀測 filter（`HIGHEST_PRECEDENCE + 1`）之後、把 `X-Trace-Id` 放進回應的 header；錯誤回應的 ProblemDetail 也加一個 `traceId` 欄位（`GlobalExceptionHandler` 建 ProblemDetail 的地方多兩行：`String traceId = MDC.get("traceId"); if (traceId != null) pd.setProperty("traceId", traceId);`）。這是第 03 章練習七的那個「`errorId`」—— 客服拿著它就能在日誌裡找到那一行，而且它不是另外產生的一個 id，是整條鏈上同一個。另一個 filter 在 Spring Security 之後，把 JWT 的 subject 放進 MDC 的 `userId`。這兩個 filter 與 9.8.4 的那一個都在 `shared.web.TraceFilters`，全文在 9.15.1。

**請求的日誌。** 下單成功時寫一行 `ORDER_PLACED orderNo=… buyerId=… lines=… hot=…`。

```
Q7 ① HTTP 下單：X-Trace-Id=6ac47feb3eb3c9f6e0dd11d168dd9a64；請求執行緒的日誌 21 行，帶 traceId 21 行
Q7 ② DB：outbox_events.trace_id=6ac47feb3eb3c9f6e0dd11d168dd9a64；越權 404、X-Trace-Id=6ac47feced537c36f4186257605c0591 → audit_logs.trace_id=6ac47feced537c36f4186257605c0591
Q7 ③ MQ：消費者的日誌 21 行，帶 traceId 21 行；寄出「訂單成立」那一行的 traceId=6ac47feb3eb3c9f6e0dd11d168dd9a64
Q7 ④ 再下 20 張：回應的 traceId 不同的有 20 個；outbox 的 order.placed 21 列，trace_id 有值 21 列
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0 -- in com.example.shop.acceptance.CapstoneAcceptanceTest
```

**Q7 綠了。** `6ac47feb…` 出現在回應的 header、請求執行緒的日誌、outbox 那一列、消費者寄信的那一行。

**排程。** Q7 問的是「請求」；但付款逾時、自動完成、對帳這些排程也會寫事件。它們沒有 HTTP 請求，沒有 traceId。直覺的做法是在 Spring 的那一個 `ThreadPoolTaskScheduler` 上掛一個 `TaskDecorator` —— **編譯不過：Spring 6.1.6 的 `ThreadPoolTaskScheduler` 沒有 `setTaskDecorator`**（6.2 才有）。改成用 Boot 的 `ThreadPoolTaskSchedulerBuilder` 設定一個自己的子類別，覆寫那幾個 `schedule*` 方法：每一次執行開一個新的 trace。一個地方涵蓋 `OrderJobs`、`InventoryJobs`、`OutboxMaintenance` 與這一章新加的排程，以後新加的也一樣（`shared.observability.TracedJobs`，全文在 9.15.1）：

```
9.8 排程：下單（直接呼叫 Service，沒有 HTTP）trace_id=null；付款逾時取消 trace_id=6ac480bbf818ad73a5e741e53efa3632
```

（`JobTraceTest` 是 `@SpringBootTest`。我原本擔心 Boot 在測試裡會把 tracing 關掉 —— 它沒有，traceId 照樣產生。）

### 9.8.4 ⚠️ 外面帶進來的 traceId

Brave 預設會「接著」請求裡的 trace：W3C 的 `traceparent`，以及 B3 的 `b3`、`X-B3-*`。這是分散式追蹤的本意（上游的服務把 traceId 傳下來），但這個專題的應用程式**就是最外層**，前面沒有 gateway。

測試的時候要確認 header 真的送出去了：在 zsh 裡，`${h:+-H "$h"}` 不會被拆成兩個參數，curl 收到的 header 名稱前面多了一個空白，伺服器根本不認得它 —— 每一個請求的 traceId 都是新的，看起來像「不收」。直接寫死 header、用 `curl -v` 看實際送出去的東西：

```
> traceparent: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01
< X-Trace-Id: 0af7651916cd43dd8448eb211c80319c
< X-Trace-Id: 0af7651916cd43dd8448eb211c80319c            （/api/products/3）
< X-Trace-Id: 1234567890abcdef1234567890abcdef            （X-B3-TraceId）
< X-Trace-Id: 1234567890abcdef1234567890abcdef            （b3）
```

**全部照收。** 網路上任何一個人都可以替自己的請求指定 traceId：讓一千個請求共用同一個 traceId，或拿一個從錯誤畫面上看到的、別人的 traceId 來混淆調查。稽核表（`audit_logs.trace_id`）裡的那個值，也會是他決定的。

在所有 filter 的最前面（`HIGHEST_PRECEDENCE`，比觀測的 filter 早一步）把這幾個 header 藏起來：

```
< X-Trace-Id: 6ac4811d88b5d0dfee0a88f4d643020f
< X-Trace-Id: 6ac4811de4dfbad6d6a6b781ec47a9c6
< X-Trace-Id: 6ac4811dc8edf6db7186f26b532c6a90
```

Q7 多了第 ⑤ 段：

```
Q7 ⑤ 自己帶 traceparent（0af7651916cd43dd8448eb211c80319c）→ X-Trace-Id=6ac48146813b5958845295aac308c85c
```

（以後這個應用程式前面如果有了一個 gateway 或另一個內部服務會呼叫它，這個 filter 就要改成「只信任內部來的」—— 5.6.4 的 `X-Forwarded-For` 是同一個問題：**header 說的話，要看是誰說的。**）

### 9.8.5 一個連鎖反應：「存在但不屬於你」的 404，不再逐字相同

加了 traceId 之後跑一次完整的建置，三個第 05 章的測試紅了：`q5_idorReturns404`、`IdorMatrixTest.everyCellIs404AndAudited`、`AuthApiTest.noAccountEnumeration`。它們斷言「存在但不屬於你」與「不存在」的回應**內容一模一樣**（5.8.3：不能讓攻擊者從回應分辨出來），登入失敗也一樣。現在每一個錯誤回應都帶著自己的 traceId，兩個 body 差了那一個欄位。

traceId 是每個請求各自隨機產生的，跟資料存不存在無關，所以不會洩漏任何東西。這三個測試比較之前，先把 traceId 換成同一個佔位符 —— **並且先斷言兩邊都有一個**，免得哪天真的出現一個差異時，這個正規化把它藏起來：

```java
public static String normalized(String problemJson) {
    assertThat(FIELD.matcher(problemJson).results().count()).as("錯誤回應帶著一個 traceId：" + problemJson).isEqualTo(1);
    return FIELD.matcher(problemJson).replaceAll("\"traceId\":\"…\"");
}
```

```
  GET    /api/orders/{orderNo}                         別人的 404 │ 不存在的 404 │ body 相同 true  │ ACCESS_DENIED +1
  ……（12 格全部 true）
```

> 📌 **traceId 的價值不在於「有」，在於「同一個」**：同一個值出現在回應、日誌、outbox、稽核、消費者 —— 任何一處拿到它，就能找到其他每一處。這一章的 Q7 是一個測試，不是一個設定：它斷言的是「同一個」，而不是「有值」。
> 而它的代價是：它出現在每一個錯誤回應裡，所以它不能洩漏任何東西（它是隨機的），也不能由外面決定（9.8.4）。

---

## 9.9 指標

### 9.9.1 誰抓得到 `/actuator/prometheus`

0.6.6：「指標（Micrometer → `/actuator/prometheus`）」。加上 `micrometer-registry-prometheus`、把 `prometheus` 加進 actuator 的 exposure。第一個問題：它不能對外 —— 指標裡有訂單量、錯誤率、每一個 URI，那是給自己人看的。

最常見的做法是管理埠分開（`management.server.port`），那個埠只在內部網路。實測（`java -jar`，應用程式 18082、管理埠 18083）：

| | 只有一個埠 | 管理埠分開 |
|---|---|---|
| 應用程式埠 `/actuator/prometheus` | 401 | 401 |
| 應用程式埠 `/actuator/health/readiness` | 200 | **404** |
| 管理埠 `/actuator/prometheus` | —— | **401** |
| 管理埠 `/actuator/health/readiness` | —— | 200 |
| 管理埠 `/api/ping` | —— | 404 |

兩件事：

- **管理埠分開之後，健康檢查也搬家了。** 負載平衡器、compose 的 `healthcheck`、Kubernetes 的 probe 都要改指管理埠（9.4 的 `curl -fs localhost:8081/actuator/health/readiness`）。測試沒有設 `management.server.port`，所以第 00、08 章的 `HealthProbeTest` 與 Q8 不受影響。
- **Spring Security 也管管理埠。** `SecurityConfig` 的 `anyRequest().denyAll()` 在兩個埠上都擋了 `/actuator/prometheus`。

所以要放行它 —— 但只在管理埠上：

```java
// 9.9：/actuator/prometheus 只在「從管理埠進來」的時候放行。管理埠（正式環境 8081）只在內部網路，Prometheus 從那裡抓。
// 忘了設 management.server.port（或測試）→ 這條永遠不成立 → 照舊 denyAll（401）：指標不會因為少了一行設定就變成公開的
RequestMatcher scrape = req -> managementPort > 0 && req.getLocalPort() == managementPort
        && "GET".equals(req.getMethod()) && "/actuator/prometheus".equals(req.getRequestURI());
```

（`managementPort` 是 `shopSecurity(...)` 多的一個參數：`@Value("${management.server.port:-1}") int managementPort`；放行寫在 `/actuator/health` 那一行之後：`.requestMatchers(scrape).permitAll()`。`SecurityConfig` 的全文在 9.15.1。）

```
== （管理埠 = 應用程式的埠）
  18082/actuator/prometheus          401
== --management.server.port=18083
  18082/actuator/prometheus          401
  18083/actuator/prometheus          200 38161B 0.020443s
  序列 214 條；shop_ 開頭 16；http_server_requests 9
```

**失敗的時候是關的。** 正式環境少了 `management.server.port` 這一行，結果是「Prometheus 抓不到」（9.10 的 `ShopDown` 會響），而不是「指標公開在網路上」。

### 9.9.2 0.6.6 的表，還缺幾個

0.6.6 列了十種指標。第 05～07 章已經有的：outbox 的兩個、對帳的差異、Redis 的失敗與跳開、`hikaricp.connections.pending`（Hikari 自己的）。第 08 章之前**沒有人做**的：

| 指標 | 這一章怎麼做 | 為什麼這樣 |
|---|---|---|
| `shop.orders.placed` | 下單成功、不是重送 | —— |
| `shop.orders.cancelled{reason}` | 交易 **commit 之後**才 +1 | 回滾的取消不算；0.6.6：「逾時取消率異常上升 = 金流出問題」 |
| `shop.orders.state_conflict{from,event}` | 條件式 UPDATE 影響 0 列的那一刻（0.5.5） | —— |
| `shop.inventory.insufficient` | 在 `placeOrder` 的最外層接，連熱點閘門的 409 也算到 | **不帶 productId**（下面） |
| `shop.orders.number_collisions` | 訂單編號撞號、重試的那一次 | 4.4.4 說「日誌照實記錄，另外用指標數撞號次數」—— 那個計數器一直沒有人加 |
| `shop.payment.callback.rejected{reason}` | 簽章錯誤、金額不符 | 0.6.6「簽章錯誤任何一次就告警」—— 原本只有一行 WARN 與一筆稽核 |
| `shop.audit.denied_suspects` | 每 5 分鐘跑一次 5.8 的那一句 SQL | 下面 |

0.6.6 寫的是「`shop.inventory.insufficient`（依 productId **前 N 名**）」。如果直接把 productId 當成 tag，每一個賣完過的商品就是一條序列，而且在 JVM 活著的期間永遠不會消失。量（J7，Boot 用的那一個 `PrometheusMeterRegistry`，一個計數器）：

```
═══ 9.9 一個計數器、productId 當 tag：scrape 多大、多久 ═══
      10 個商品 │ scrape       692 bytes │ 每次   0.08 ms │ 序列 10 條
     100 個商品 │ scrape     6,092 bytes │ 每次   0.17 ms │ 序列 100 條
   1,000 個商品 │ scrape    60,092 bytes │ 每次   1.05 ms │ 序列 1,000 條
  10,000 個商品 │ scrape   600,092 bytes │ 每次   4.68 ms │ 序列 10,000 條
```

1 萬個商品（0.6.1）：一個計數器 600 KB，是整個應用程式閒置時全部指標（38 KB）的 15 倍，每 15 秒被抓一次、每一台機器各一份，存在 Prometheus 裡。4.68 ms 不算慢 —— 問題不在 scrape，在**序列的數量**。所以計數器不帶 productId；每一次庫存不足寫一行 `INSUFFICIENT_STOCK productId=… buyerId=…` 的 INFO（JSON），「前 N 名」從日誌查。`userId` 也是一樣的道理 —— US-ORD-5 AC-4（越權嘗試的告警）要的是「哪一位使用者」，所以 `shop.audit.denied_suspects` 只放「有幾位」，是哪幾位寫進日誌（`AUDIT_DENIED_SUSPECTS`）。時間窗照 5.8.4 的結論用一小時。

### 9.9.3 讓「下單 p99」算得出來

0.6.6 的告警「下單 p99 > 500 ms，持續 5 分鐘」需要延遲的分布。Micrometer 預設的 `http.server.requests` 只有 count、sum、max。把 0.6.2 的那幾個門檻當成 histogram 的桶：

```yaml
management:
  metrics:
    distribution:
      slo:
        # 9.9：0.6.2 的門檻當成 histogram 的桶 —— 告警算「超過 500 ms 的比例」，不是估 p99（9.10）
        # （我原本以為 key 要寫成 "[http.server.requests]"，兩種寫法量過：一樣是這 9 個桶）
        http.server.requests: 50ms,100ms,150ms,200ms,250ms,300ms,500ms,1s,2s
```

序列從 214 變成 247。

> ⚠️ **多出來的 33 條，是桶的只有 20 條。** 在本章結束時的程式碼上，同一個 jar、同一組請求，只差這一行設定開或關（`--management.metrics.distribution.slo.http.server.requests=` 把它清空），交錯量兩輪：
>
> ```
> == with-slo     序列 276 條；shop_ 開頭 58；http_server_requests 29
> == no-slo       序列 256 條；shop_ 開頭 58；http_server_requests 9
> == with-slo-2   序列 276 條；shop_ 開頭 58；http_server_requests 29
> == no-slo-2     序列 256 條；shop_ 開頭 58；http_server_requests 9
> ```
>
> 依名稱比對，兩邊只差 20 條 `http_server_requests_seconds_bucket`：`/api/ping` 200 與 `UNKNOWN` 401（管理埠之外打 `/actuator/prometheus` 被擋的那一次）兩組標籤，各 10 個桶（9 個門檻加 `+Inf`）。214 → 247 的另外 13 條，來自那兩次量測之間的其他改動（214 那一次 `shop_` 開頭的只有 16 條），不是桶；是哪幾條，沒有逐名的清單。（276 跟上面的 214、247 不能直接比：那是本章最後的程式碼，指標比那兩次多。）

### 9.9.4 不是應用程式的指標

- **RabbitMQ**：映像檔裡 `rabbitmq_prometheus` 外掛本來就開著（15692）。但預設的 `/metrics` 是**所有佇列加總**（`rabbitmq_queue_messages 3`）；死信佇列的深度要每一個佇列一條，得抓 `/metrics/detailed?family=queue_coarse_metrics`（20 個佇列）。
- **MySQL**：`mysqld-exporter`（0.17.2），一個唯讀、最多 3 條連線的 `exporter` 帳號。第 02 章 2.2.3 說要把 `Innodb_row_lock_waits` 加進告警。

---

## 9.10 告警

### 9.10.1 規則

0.6.6 列了七條告警，第 02、04、05、06、07、08 章又各留下幾個「第 09 章接告警」。全部寫成 Prometheus 的規則（`docker/prometheus/alerts.yml`），五組、19 條。每一條的 `annotations.why` 寫「為什麼是這個門檻、從哪一章來」；門檻是判斷的，就寫明是判斷：

| 組 | 告警 | 條件 | 來自 |
|---|---|---|---|
| SLO | `ShopHigh5xxRatio` | 5xx > 1%（5 分鐘且 1 分鐘），持續 5 分鐘 | 0.6.6 |
| | `ShopPlaceOrderSlow` | 下單超過 500 ms 的比例 > 1%（同上） | 0.6.6、0.6.2 |
| 事件流 | `ShopOutboxBacklog` | `shop_outbox_oldest_age_seconds` > 60 | 0.6.6、0.6.4 |
| | `ShopOutboxUnroutable` | `shop_outbox_rejected_total{reason="unroutable"}` 增加 | 9.2.1 |
| | `ShopConsumerLag` | 消費者 p99 延遲 > 60 秒，持續 1 分鐘 | 0.6.4 |
| | `ShopConsumerQueueBacklog` | 主佇列 ready > 1,000，持續 5 分鐘（判斷） | 0.6.6「消費端是否跟上」 |
| | `ShopDeadLetters` | 任何一個 DLQ > 0 | 0.6.6、7.5.5 |
| | `ShopUncountedReservationsOld` | 未計入的熱點預留 > 60 秒 | 7.10 |
| | `ShopRefundFailed` | `shop_refunds_failed_total` 增加 | 0.5.4、7.8.1 |
| 數字 | `ShopReconciliationDiff` | 對帳差異 > 0 | 0.6.6、7.10 |
| | `ShopHotStockShortage` | 熱點：回了 201、落帳才發現不夠 | 7.6.3 |
| | `ShopHotStockDrift` | 熱點對帳修正了差異 | 6.6 |
| | `ShopAuditDropped` | 稽核沒寫進去 | 5.9.2 |
| 安全 | `ShopPaymentCallbackRejected` | 任何一次（依 reason） | 0.6.6、US-ORD-2 AC-4 |
| | `ShopAccessDeniedSuspects` | 過去一小時越權 > 50 次的使用者 > 0 | US-ORD-5 AC-4、5.8.4 |
| | `ShopLoginLockoutDegraded` | 登入鎖定暫停中 | 0.6.3、5.6.4 |
| 依賴 | `ShopDown` | `up == 0`，持續 1 分鐘 | —— |
| | `ShopRedisDegraded` | `RedisGuard` 跳開過 | 6.4.5、8.6.5、9.6.3 |
| | `ShopMysqlRowLockWaits` | 列鎖等待 5 分鐘平均每秒 > 10，持續 10 分鐘（判斷：一次搶購約每秒 95 次、只有 10 秒） | 2.2.3 |

（表格是摘要。`alerts.yml` 與 9.10.2 的 `alerts_test.yml` 的全文在 9.15.1 —— `promtool` 的測試逐字比對 annotations，`AlertMetricsTest` 從 `alerts.yml` 裡找指標名，改規則時兩邊要一起改。）

0.6.6 原本的「下單 p99」寫成**比例**而不是 p99 —— 「p99 > 500 ms」等價於「超過 500 ms 的請求 > 1%」，用 9.9.3 的桶直接算，不必估一個 p99：

```yaml
- alert: ShopPlaceOrderSlow
  expr: |
    ((
      sum(rate(http_server_requests_seconds_count{job="shop",uri="/api/orders",method="POST"}[5m]))
      - sum(rate(http_server_requests_seconds_bucket{job="shop",uri="/api/orders",method="POST",le="0.5"}[5m]))
    ) / sum(rate(http_server_requests_seconds_count{job="shop",uri="/api/orders",method="POST"}[5m])) > 0.01)
    and
    ((……同一句，[1m]……) > 0.01)
```

（為什麼有第二個 1 分鐘的窗，9.10.5。）

第 04 章 4.4.4 留下的那一個呢？「告警規則如果寫『任何 ERROR 就告警』，撞號那一行每天會叫醒人 12 次」。這一章的選擇是：**不拿 ERROR 的行數告警**。每一件值得叫醒人的事，都有一個名字明確的指標；ERROR 照實記錄，留給查問題的人（`shop.orders.number_collisions` 讓撞號有了自己的計數器）。

### 9.10.2 ⚠️ 規則也要測：「任何一次」的第一次不會響

規則是程式碼，就要有測試。`promtool test rules` 讀一份「假的時間序列」，斷言某個時間點哪些告警在響。`docker/prometheus/test.sh` 只要 Docker（記得 `chmod +x`；開頭的 `cd` 讓它從任何目錄呼叫都掛得到 `alerts.yml` —— CI 是從 repo 的根目錄呼叫它）：

```bash
#!/usr/bin/env bash
# 9.10：檢查與測試告警規則（只要 Docker）
cd "$(dirname "$0")"
docker run --rm -v "$PWD":/rules -w /rules --entrypoint promtool prom/prometheus:v3.5.0 check rules alerts.yml && \
docker run --rm -v "$PWD":/rules -w /rules --entrypoint promtool prom/prometheus:v3.5.0 test rules alerts_test.yml
```

測試裡有一組，是我寫規則時就懷疑的：「任何一次就告警」的規則用的是 `increase(x[5m]) > 0`。可是這個專題有好幾個計數器是**第一次用到才註冊**的（`shop.payment.callback.rejected` 在第一次簽章錯誤時才被 `meters.counter(...)` 建出來）。那一條序列在 Prometheus 裡一出現，值就是 1：

```yaml
# ④ 計數器在第一次發生時才註冊：序列一出現就是 1
- interval: 15s
  input_series:
    - series: 'shop_payment_callback_rejected_total{job="shop",reason="signature"}'
      values: '_ _ _ _ 1 1 1 1 1 1'
  alert_rule_test: ……            # eval_time: 90s
# ④' 同一件事，計數器在啟動時就先註冊成 0 —— 另一個 test group（同一條序列不能在同一組裡出現兩次）
- interval: 15s
  input_series:
    - series: 'shop_payment_callback_rejected_total{job="shop",reason="signature"}'
      values: '0 0 0 0 1 1 1 1 1 1'
  alert_rule_test: ……            # eval_time: 90s
```

```
  FAILED:
    alertname: ShopPaymentCallbackRejected, time: 1m30s,
        exp:[ 0: Labels:{alertname="ShopPaymentCallbackRejected", reason="signature", severity="page"} ],
        got:[]                                    ← ④：沒有響
    alertname: ShopPaymentCallbackRejected, time: 1m30s,
        got:[ 0: Labels:{alertname="ShopPaymentCallbackRejected", reason="signature", severity="page"} … ]   ← ④'：響了
```

（節錄、排版過：`promtool` 的原始輸出每一個欄位各一行。）

**④ 沒有響。** `increase()` 需要兩個點才算得出增加了多少；序列的第一個點就是 1，它沒有「之前」可以比。一個攻擊者送的第一個偽造回呼，不會讓任何人知道 —— 要等第二個。

（期望值要寫 annotations：`promtool` 比對的是整份 annotations，沒寫就等於期望沒有，一樣算失敗。9.15.1 的 `alerts_test.yml` 裡，④ 是一個「描述陷阱」的測試：期望它不響，註解寫清楚為什麼。）

修法在程式碼裡：被「任何一次」型告警用到的計數器，**在啟動時就先註冊成 0**（`shop.payment.callback.rejected` 的兩個 reason、`shop.outbox.rejected` 的四個 reason、每一個消費者的 `shop.events.lag`）。然後寫一個測試把這件事守住 —— 以後有人加了一條告警、卻忘了先註冊，或者名字打錯了：

```java
/**
 * 9.10：docker/prometheus/alerts.yml 用到的每一個 shop_ 指標，應用程式一啟動就要在 /actuator/prometheus 裡（值是 0 也要在）。
 * 不在的兩種後果：increase() 型的告警第一次不會響（promtool ④）；名字打錯，告警永遠不會響、也不會有人知道
 */
```

```
9.10 alerts.yml 用到的 shop_ 指標（啟動之後的序列數）：{shop_audit_denied_suspects=1, shop_audit_dropped_total=1, shop_events_lag_seconds=10, shop_inventory_hot_drift_total=1, shop_inventory_hot_shortage_total=1, shop_inventory_uncounted_oldest_age_seconds=1, shop_login_lockout_degraded_total=1, shop_outbox_oldest_age_seconds=1, shop_outbox_rejected_total=4, shop_payment_callback_rejected_total=2, shop_reconciliation_diff=3, shop_redis_trips_total=1, shop_refunds_failed_total=1}
```

13 個全部在。拿掉 `JdbcPaymentService` 啟動時先註冊的那兩行（突變），它紅：`shop_payment_callback_rejected_total`。

### 9.10.3 compose 裡真的 Prometheus

compose 的 `app` profile 加上 Prometheus（v3.5.0）：抓應用程式的管理埠、RabbitMQ 的 detailed 端點、mysqld-exporter；載入 `alerts.yml`（`prometheus.yml` 與 compose 的這幾個服務，全文在 9.15.1）。起來之後：

```
  target mysql up  35 ms
  target rabbitmq up  10 ms
  target shop up  29 ms
  規則 19 條
```

### 9.10.4 監控打開的第一分鐘

```
  告警 1 個
    ShopDeadLetters firing {'queue': 'shop.payment.refunds.dlq'} shop.payment.refunds.dlq 有 3 則死信
```

**一打開就響了一個，而且是真的。** 用 RabbitMQ 的管理 API 看那 3 則（看完放回去）：

```
2026-10-02T10:50:24Z {'shop-attempt': '6', 'shop-error': 'org.springframework.dao.EmptyResultDataAccessException: Incorrect result size: expected 1, actual 0', 'shop-target': 'shop.payment.refunds', … 'x-first-death-queue': 'shop.retry.100ms', … 'x-last-death-queue': 'shop.retry.1600ms' …}
2026-10-02T10:58:21Z {……同樣的錯……}
2026-10-05T02:58:07Z {……同樣的錯……}
```

三則 `refund.requested`，同一位買家 990501（`OrderRaceRegressionTest`、`AuditPlacementTest` 用的那一位）。重試階梯是 100 ms～1.6 秒 —— 測試的設定。發生的事是：某一個在 compose 上打開了消費者的測試，建了一筆退款、清掉了自己的資料；消費者在那之後才處理到這則訊息，找不到退款單，重試 6 次，送進死信。**最舊的一則在那裡躺了 4 天**，第 07 章 7.5.5 說「每一則死信都要有人看」—— 在有告警之前，沒有人知道它們在那裡。

它們是實驗的垃圾，不是錯帳（訂單與退款單都已經被清掉）。清掉之後，告警解除。

### 9.10.5 演練：停機之後多久響、恢復之後多久安靜

告警的價值在「出事的時候響」。用真的停機觸發它：`scripts/j8b-alert-drill.sh` 在背景每秒送 5 張下單，按時間表停、起一個容器，每 5 秒問一次 Prometheus。（下單的位址在腳本裡寫死成 `http://localhost:18090` —— 9.4.2 的 `SHOP_HTTP_PORT=18090`；用別的埠要改腳本裡那一行。流量來自測試程式碼裡的 `loadtest/StopDuringLoad`，所以要先 `mvn test-compile`。腳本全文在 9.15.1。）

**RabbitMQ：第 31 秒停、第 151 秒起**（1,350 張下單全部 201 —— 0.6.3「RabbitMQ 掛了照樣下單」）：

```
  ── 第 31 秒 docker stop shop-rabbitmq-1
    37 秒 │ 3.5          │ —
    53 秒 │ 18.7         │ —
    ……
    99 秒 │ 63.9         │ —
   109 秒 │ 63.9         │ ShopOutboxBacklog(firing)
   ……
  ── 第 151 秒 docker start shop-rabbitmq-1
   166 秒 │ 124.2        │ ShopOutboxBacklog(firing)
   171 秒 │ 0.0          │ ShopOutboxBacklog(firing)
   187 秒 │ 0.0          │ ShopConsumerLag(pending) ShopConsumerLag(pending)
   ……
   228 秒 │ 0.1          │ ShopConsumerLag(pending) ShopConsumerLag(pending)
   233 秒 │ 0.0          │ —
```

（第二欄是 `max(shop_outbox_oldest_age_seconds)`。）

- **停機之後 78 秒 firing。** 門檻是 60 秒，再加上應用程式每 5 秒算一次、Prometheus 每 15 秒抓一次、每 15 秒評估一次。
- 恢復之後 20 秒 outbox 清空、36 秒告警解除。
- **`ShopConsumerLag` 一直沒有 firing。** 停機的那 2 分鐘裡它完全沒有聲音 —— 消費者手上沒有事件，沒有新的延遲樣本。恢復之後，晚了 120 秒的那一批被處理，p99 跳到 60 秒以上、進入 pending；但 Micrometer 的 percentile 只看一個會滾動的時間窗，45 秒後那一批就滾出去了，`for: 1m` 一直沒有成立。**這次停機，是 outbox 的告警抓到的；消費者延遲那一條，對「停住」是瞎的** —— 所以它旁邊要有 `ShopConsumerQueueBacklog`（佇列的深度不會因為沒有新的樣本就歸零）。

**Redis：第 31 秒停、第 93 秒起**（900 張全部 201）：

```
  ── 第 31 秒 docker stop shop-redis-1
    36 秒 │ 2.0          │ ShopRedisDegraded(firing)
    57 秒 │ 6.2          │ ShopPlaceOrderSlow(pending) ShopRedisDegraded(firing)
  ── 第 93 秒 docker start shop-redis-1
   ……
   176 秒 │ 22.6         │ ShopPlaceOrderSlow(pending) ShopRedisDegraded(firing)
```

- **`ShopRedisDegraded` 停機之後 5 秒就 firing** —— 它直接看「跳開」這個事件，沒有門檻時間。
- 一般下單全部 201，但有超過 1% 慢於 500 ms，**`ShopPlaceOrderSlow` 從第 57 秒開始 pending —— Redis 第 93 秒就恢復了，它到演練結束都還在 pending。**

它什麼時候會 firing？拉長到 600 秒、流量一直不停再跑一次（先等 5 分鐘，讓前一次的資料滑出窗外）：

| 時間 | 慢於 500 ms 的比例（5 分鐘窗） | `ShopPlaceOrderSlow` |
|---|---|---|
| 第 31 秒 | —— | Redis 停 |
| 第 57 秒 | 4.7% | pending |
| 第 93 秒 | —— | **Redis 恢復** |
| 第 104 秒 | **10.6%**（最高） | pending |
| 第 351 秒 | 2.3% | pending |
| **第 356 秒** | 2.3% | **firing —— Redis 恢復之後 4 分 23 秒** |
| 第 387 秒 | 0.8% | 解除（響了 31 秒） |

（3,000 張下單全部 201。）

**一個「下單變慢」的告警，在問題結束 4 分多鐘之後才叫醒人，響了半分鐘就自己好了。** 被它叫醒的人打開系統，什麼都看不到。原因是：5 分鐘窗裡還留著停機那一段的慢請求，`for: 5m` 從第 57 秒開始算 —— 它衡量的是「過去 5 分鐘」，不是「現在」。

修法是多加一個 1 分鐘的窗：兩個窗都超過 1% 才算（5xx 那一條一樣）。問題一結束，1 分鐘的窗很快就降下來，pending 就斷了。用 `promtool` 把這個形狀寫成測試（2 分鐘正常、1 分鐘 10.7% 很慢、之後恢復）。檢查的時間點要挑在舊規則 firing 的那一段裡：照時間算，舊的規則只在 7m15～7m45 之間 firing，挑 7 分、9 分的話，**新舊規則都通過**。挑 7m30s：

```
== 第一版（只有 5 分鐘窗）：
  FAILED:
    alertname: ShopPlaceOrderSlow, time: 7m30s,
        exp:[],
        got:[ … Annotations:{summary="下單超過 500 ms 的比例 6.386%（> 1% = p99 > 500 ms），持續 5 分鐘" …} ]
== 加了 1 分鐘窗：
  SUCCESS
```

### 9.10.6 告警響了，送到哪裡

上線檢查清單（9.13）第一次跑的時候，這一項是 ❌：

```
  ❌ 沒有 Alertmanager：告警響了，沒有人會收到
```

Prometheus 只負責判斷「現在是不是在響」，誰會收到是 Alertmanager 的事。compose 加上 Alertmanager（v0.28.1）與一個本機的「收件人」—— 一支用官方 Python 映像檔跑的小程式，把收到的 webhook 一行一則印出來（正式環境換成值班系統、聊天室，依 `severity` 分）：

```yaml
route:
  receiver: local-sink
  group_by: [alertname]
  group_wait: 10s          # 預設 30 秒：同一組的告警先等這麼久、湊在一起送
  group_interval: 1m
  repeat_interval: 4h
```

（節錄。`route` 指向的 `local-sink` 要在 `receivers` 裡定義：一個 webhook，送到 `http://alert-sink:8080/alerts`、`send_resolved: true` —— 少了它，Alertmanager 的設定不成立。`alertmanager.yml`、`sink.py` 與 compose 裡這兩個服務的全文在 9.15.1。）

（改了 `prometheus.yml` 之後，`docker compose up` 沒有讓 Prometheus 重讀它 —— 容器沒有被重建，而 Prometheus 只在啟動時讀設定。重啟之後才接上。）

再停一次 RabbitMQ，量**從停機到收件人收到**：

| 時間（UTC） | 事件 |
|---|---|
| 06:53:01 | `docker stop shop-rabbitmq-1` |
| 06:54:18.5 | 告警開始（`startsAt`）—— 停機後 77.5 秒 |
| **06:54:28.5** | **收件人收到 firing —— 停機後 87.5 秒**（多出來的 10 秒是 `group_wait`） |
| 06:55:00 | `docker start` |
| 06:56:28.5 | 收件人收到 resolved —— 恢復後 88.5 秒 |

```
{"received": "2026-10-06T06:54:28.536+00:00", "status": "firing", "alertname": "ShopOutboxBacklog", "severity": "page", "summary": "最舊的未送出事件已經 1m 2s", …}
{"received": "2026-10-06T06:56:28.537+00:00", "status": "resolved", "alertname": "ShopOutboxBacklog", "severity": "page", "summary": "最舊的未送出事件已經 2m 2s", …}
```

兩件事：resolved 晚到，是因為 Alertmanager 依 `group_interval`（1 分鐘）的節奏送；**resolved 那一則的摘要寫著「最舊的未送出事件已經 2m 2s」** —— 它帶的是最後一次 firing 時的 annotation。收到的人要看 `status`，不能看摘要。

> 📌 **一條告警要過四關：規則寫對（promtool）、指標存在而且第一次就算得到（啟動時註冊、`AlertMetricsTest`）、在對的時間響（演練：不太晚、不在事後）、有人收到（Alertmanager）。** 這一節每一關都至少壞過一次。0.6.6 那張表上的每一條告警，在這一章之前只過了零關。

---

## 9.11 INV-5 與稽核表：權限

### 9.11.1 一個角色，每個模組替自己的表授權

9.2.3 的結論：權限只能一張表一張表給。設計是：

- **一個 MySQL 角色 `shop_app`**。應用程式的帳號 `shop` 只拿這個角色（`SET DEFAULT ROLE`），在 `shop` 庫上沒有任何直接的權限。
- **`shop_migrator`**：DDL 與授權（`WITH GRANT OPTION`、`CREATE ROLE`）。只有 migration 的步驟拿它（9.4）。
- **每個模組在自己的 migration 裡替自己的表授權**（V15～V22）。第 02 章 2.9.4 的 `MigrationOwnershipTest` 規定「一個 migration 只能動它所屬模組的表」—— 它會把 `GRANT … ON orders` 算成「動了」，所以一個 shared 的 migration 不能替所有的表授權。這條規則在這裡是對的：表是誰的，誰決定應用程式能對它做什麼。

```sql
-- V15__shared_app_role.sql
-- 第 09 章（9.11）INV-5：應用程式的資料庫帳號只拿這個角色。DDL 是 shop_migrator 的事（docker/mysql-init/00-users.sql）。
-- 權限只能一張表一張表給：MySQL 沒辦法「先給整個資料庫、再對 inventory_ledger 收回 UPDATE」（REVOKE 回 ERROR 1147，9.2.3）。
-- 每個模組在自己的 migration 裡替自己的表授權（V15～V22，2.9.4 的邊界）；新的表忘了授權，應用程式就讀不到它（AppGrantsTest）
CREATE ROLE IF NOT EXISTS shop_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON outbox_events TO shop_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON processed_messages TO shop_app;
-- 5.9、0.6.5：稽核只能新增
GRANT SELECT, INSERT ON audit_logs TO shop_app;
```

```sql
-- V18__inventory_app_grants.sql
-- 9.11 INV-5：inventory 模組的表。0.4.6 INV-5：inventory_ledger 只能新增 —— 不能修改、不能刪除
GRANT SELECT, INSERT, UPDATE, DELETE ON inventory TO shop_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON inventory_reservations TO shop_app;
GRANT SELECT, INSERT ON inventory_ledger TO shop_app;
```

（V16 account、V17 catalog、V19 cart、V20 ordering、V21 payment、V22 notification 一樣，全文在 9.15.1。GRANT 不是規則 ③ 那種「一個檔案只能一句」的 DDL —— 規則 ③ 防的是 MySQL 的 DDL 不在交易裡、跑到一半失敗留下半套；GRANT 也會隱含 commit，但它是冪等的，修好重跑不會出事。）

環境這一端（compose、Testcontainers 用同一份）：

```sql
-- docker/mysql-init/00-users.sql
CREATE ROLE IF NOT EXISTS shop_app;
CREATE USER IF NOT EXISTS 'shop_migrator'@'%' IDENTIFIED BY 'shop_migrator';
GRANT ALL PRIVILEGES ON `shop`.* TO 'shop_migrator'@'%' WITH GRANT OPTION;
GRANT CREATE ROLE ON *.* TO 'shop_migrator'@'%';
CREATE USER IF NOT EXISTS 'shop'@'%' IDENTIFIED BY 'shop';
REVOKE IF EXISTS ALL PRIVILEGES ON `shop`.* FROM 'shop'@'%';
GRANT shop_app TO 'shop'@'%';
SET DEFAULT ROLE shop_app TO 'shop'@'%';
FLUSH PRIVILEGES;
-- 9.10 mysqld-exporter（Prometheus）：唯讀、最多 3 條連線
CREATE USER IF NOT EXISTS 'exporter'@'%' IDENTIFIED BY 'exporter' WITH MAX_USER_CONNECTIONS 3;
GRANT PROCESS, REPLICATION CLIENT, SELECT ON *.* TO 'exporter'@'%';
FLUSH PRIVILEGES;
```

（最後那一段是 9.9.4 的 `mysqld-exporter` 用的帳號；少了它，exporter 連不上 MySQL，`ShopMysqlRowLockWaits` 要的指標就不會有。開頭註解寫著已經有 volume 的人怎麼手動執行，全文在 9.15.1。）

### 9.11.2 測試它

`AppGrantsTest` 兩個測試：

```
9.11 INV-5：INSERT 帳 1 列；被拒絕的（MySQL 錯誤碼）{UPDATE inventory_ledger SET delta_on_han…=1142, DELETE FROM inventory_ledger WHERE produ…=1142, UPDATE audit_logs SET action = 'X' WHERE…=1142, DELETE FROM audit_logs WHERE id = 0=1142, CREATE TABLE inv5_probe (id INT)=1142, DROP TABLE orders=1142}；目前的角色 `shop_app`@`%`
9.11 19 張表授權給 shop_app；不對的：{}
```

- 應用程式的連線：新增一筆帳可以；改帳、刪帳、改稽核、刪稽核、`CREATE TABLE`、`DROP TABLE orders` —— 六個全部 1142（command denied）。0.12.2 的追溯表那一列「INV-5 ｜ 用應用程式帳號執行 `UPDATE inventory_ledger`，預期被拒 ｜ 09」，這是它。
- 每一張表（`flyway_schema_history` 除外）都授權給了 `shop_app`：帳與稽核只有 SELECT、INSERT，其他的四種都有（9.12 加的水位線表是例外：SELECT、UPDATE）。**以後有人加了一張新的表、忘了在 migration 裡授權，這個測試會紅** —— 在那之前，應用程式會在正式環境的第一個請求才發現它讀不到那張表。

### 9.11.3 ⚠️ 誰壞了

**測試的清理。** 第 05 章 5.9 寫過：「第 09 章會讓應用程式的資料庫帳號沒有 `audit_logs` 的 UPDATE / DELETE。到那時，這些測試的清理要換一個帳號。」數一數：**41 個檔、68 句**（`DELETE FROM inventory_ledger …`、`DELETE FROM audit_logs …`、`DELETE a FROM audit_logs a JOIN …`）。它們全部改成 `TestInfra.adminJdbc()` —— root、`shop` 這個資料庫。壓測工具清自己的帳，改用一條 root 的連線。

**Testcontainers 起不來。** `MySQLContainer` 起好容器之後，會用設定的帳號連那個資料庫，確認它準備好了 —— 它用的是 `shop`：

```
Caused by: java.sql.SQLSyntaxErrorException: Access denied for user 'shop'@'%' to database 'shop'
```

**INV-5 之後，應用程式的帳號在 migration 跑完之前，連不進資料庫** —— `shop_app` 這個角色的每一個權限，都是 V15～V22 給的。改成用 root 起容器（`withUsername("root")`），`shop` 由初始化腳本建立（`TestInfra` 這一章的改動：用 root 起容器、把 `00-users.sql` 也複製進容器的 `/docker-entrypoint-initdb.d/`、Flyway 用 `spring.flyway.user=shop_migrator`、新增 `adminJdbc()`，以及 9.14.2 的連線高峰；全文在 9.15.1）。然後容器自己 `exit 1`：

```
ERROR 1141 (42000) at line 10: There is no such grant defined for user 'shop' on host '%'
```

compose 的 `shop` 是 `MYSQL_USER` 建的、先有了整個庫的權限，所以 `REVOKE ALL` 收得回來；Testcontainers 用 root 起的時候，`shop` 是腳本剛建的、本來就沒有任何權限，MySQL 收回不存在的權限會報錯。`REVOKE IF EXISTS`（8.0.30 起）兩種情況都過；腳本改名 `00-users.sql`（`01-databases.sql` 會 GRANT 給 `shop`，`shop` 要先存在）。

**驗收 Q6。** 完整的建置，196 個裡紅了 1 個：

```
Access denied for user 'shop_migrator'@'%' to database 'shop_q6'
```

Q6 的 Flyway 也換成了 `shop_migrator`，它沒有 `shop_q6` 的權限。Q6 要驗證的是「正式環境的空資料庫，從 V1 跑到最新版」，而正式環境跑 migration 的就是 `shop_migrator` —— 該補的是權限，不是讓 Q6 改用 root：

```
Q6：從空資料庫套用 22 個 migration → 20 張表（含 flyway_schema_history）、CHECK 25 / 25、具名索引 32 / 32；validate 通過
```

**compose 那台已經有資料的 MySQL**：初始化腳本只在空的 volume 時執行，所以 `00-users.sql` 要手動跑一次（在 repo 的根目錄，compose 的 MySQL 開著）：

```bash
docker compose exec -T mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD"' < docker/mysql-init/00-users.sql
```

`01-databases.sql` 這一章多的那一行（`shop_migrator` 對 `shop_q6` 的權限，上面的驗收 Q6）一樣不會自動補上。舊的 volume 在 `00-users.sql` **之後**（`shop_migrator` 要先存在）把整個檔案重跑一次 —— 裡面只有 `CREATE DATABASE IF NOT EXISTS` 與 GRANT，重跑不會出事：

```bash
docker compose exec -T mysql mysql -uroot -proot < docker/mysql-init/01-databases.sql
```

然後讓 Flyway 套用 V15～V23：

```
… Migrating schema `shop` to version …   （9 個）
… Successfully applied 9 migrations     13:44:37.805 → 13:44:37.964
```

9 個 migration 159 ms —— GRANT 只動中繼資料，跟表裡有 10 萬列還是 1 千萬列無關。

### 9.11.4 一個衝突：稽核保留一年

0.6.7：「`audit_logs` 1 年」，0.6.7 也寫著「定期清理的排程在第 07、09 章」。第 07 章做了 outbox 與 `processed_messages` 的清理；稽核的那一個沒有人做 —— 而現在，**應用程式不能刪稽核了**。

做法：一個 `SQL SECURITY DEFINER` 的預存程序，由 `shop_migrator` 建立，`shop_app` 只有 EXECUTE。程序用建立者的權限刪，**「一年」寫死在程序裡**，呼叫的人不能指定時間 —— 所以應用程式刪得掉的只有一年以前的稽核，刪不掉昨天的那一筆：

```sql
-- V23__shared_audit_retention.sql
DELIMITER $$
CREATE PROCEDURE purge_audit_logs(IN batch INT)
  SQL SECURITY DEFINER
  MODIFIES SQL DATA
BEGIN
  DELETE FROM audit_logs WHERE created_at < NOW(3) - INTERVAL 1 YEAR ORDER BY id LIMIT batch;
  SELECT ROW_COUNT() AS deleted;
END$$
DELIMITER ;
GRANT EXECUTE ON PROCEDURE purge_audit_logs TO shop_app;
```

如果用一個 OUT 參數回傳刪了幾列，程序建得起來，應用程式一呼叫：

```
Caused by: java.sql.SQLException: Parameter number 2 is not an OUT parameter
```

Connector/J 要先讀程序的定義，才知道哪一個參數是 OUT；而 `shop_app` 只有 EXECUTE，讀不到定義，就把每一個參數都當成 IN。**權限收緊之後，連驅動程式的行為都變了。** 改成回傳一個結果集。

應用程式每天呼叫一次，一次 1,000 列、刪到沒有為止（7.4.4 的寫法）。`AuditRetentionTest`：

```
9.11 稽核保留：程序刪了 2 列；這位使用者剩 1 列（昨天那一筆）
```

（400 天、366 天、1 天前各一筆；應用程式自己 `DELETE` 照樣被拒絕。）`idempotency_keys` 的 24 小時清理（0.6.7、US-ORD-1a AC-6）也是同一次補的：`expires_at` 有索引，每小時一次、1,000 列一批。

還有一個這一章沒有處理的：應用程式可以 INSERT 稽核 —— 也就可以自己填 `created_at`，寫一筆「一年前的」稽核。欄位層級的 INSERT 權限（不給 `created_at`）可以擋住它；留在練習。

> 📌 **「只能新增」與「保留期限」天生衝突**：保留期限就是一種刪除。解法不是放寬權限，而是**把刪除變成一個有條件的操作**，條件寫在資料庫裡，而不是寫在應用程式的 `WHERE` 裡。
> 收緊權限的那一天，壞掉的不只是那兩張表的 UPDATE：41 個測試檔、Testcontainers 的啟動、驗收 Q6、驅動程式讀不到 OUT 參數 —— 每一個都是「之前有 ALL 權限，所以沒有人注意到它依賴什麼」。

> ⚠️ **還有兩個收緊權限之後壞掉、建置看不到的。** 在本章結束時的程式碼上、一個**全新的**資料庫裡重跑第 02 章的工具與實驗：
> - **`SeedData`（2.8.3）第一句就失敗**：`DROP command denied to user 'shop'` —— `TRUNCATE` 要 DROP 權限，`shop_app` 沒有。compose 那台資料庫的種子資料是第 02 章灌的，之後不會再跑它；`mvn test` 用的 Testcontainers 也不灌種子資料，所以整套建置都是綠的。
> - **`C7IndexPlanningTest`（2.7.2）**：開關索引（`ALTER INDEX … INVISIBLE`、`CREATE INDEX`）是 DDL，一樣被拒。
>
> 兩個都改成用測試清理那一個管理帳號（`TestInfra.adminJdbc()`，root）執行 DDL，查詢與寫入照舊用 `shop`。參考實作的 `ch09` 分支上還是改之前的寫法。第 02～07 章其他做 DDL 的實驗沒有逐一檢查（有些用自己的 lab 資料庫或 root 連線，不會受影響）：它們是那一章的實驗，該在那一章的程式碼上跑；在這一章之後的程式碼上跑，用應用程式帳號做 DDL 的那幾個會撞到同一面牆。**「之前有 ALL 權限」藏住的依賴，最晚會在第一次換一個新環境時出現。**

---

## 9.12 對帳改成增量的

### 9.12.1 全掃的成本

第 07 章 7.10：「一秒多的全表掃描，每小時一次可以接受……3 年 5,000 萬筆庫存帳時，這句要改成增量的，那是第 09 章的事。」先量全掃到底多貴。在 `shop_lab` 裡建兩張跟正式結構一樣的表，1 萬個商品（0.6.1），帳本依序長到 60 萬、500 萬、2,000 萬列；用正式的 INV-3 那一句，每個大小跑兩次（compose 的 MySQL，buffer pool 是預設的 128 MB）：

| 帳本 | 第一次 | 第二次 |
|---|---|---|
| 60 萬列 | 387 ms | 370 ms |
| 500 萬列 | **35,082 ms** | **39,859 ms** |
| 2,000 萬列（資料 1,228 MB、索引 767 MB） | **130,634 ms** | **122,073 ms** |

（load 3.5～4.9。）

60 萬 → 500 萬，資料 8 倍，時間 **100 倍**。buffer pool 只有 128 MB，500 萬列放不下。照 500 萬 → 2,000 萬的比例推，5,000 萬列一次 INV-3 大約 5 分鐘；INV-3' 是另一次全掃 —— 每小時 10 分鐘左右的全表掃描（外推，沒有量）。

### 9.12.2 ⚠️ 那一句選錯了執行計畫

要做增量，第一次一定要把整本帳加總一次（建立起點）。在同一張 2,000 萬列的表上量：

```
第一次建立累計（等於一次全掃）：12,278 ms
```

**12 秒。可是正式的 INV-3 那一句，同一張表、同樣是依商品加總整本帳，要 122～130 秒。** 差 10 倍。`EXPLAIN`：

```
-- 正式的 INV-3
-> Nested loop left join
    -> Table scan on i
    -> Index lookup on l using <auto_key0> (product_id=i.product_id)
        -> Materialize
            -> Group aggregate: sum(j11_ledger.delta_on_hand)
                -> Index scan on j11_ledger using idx_ledger_product  (rows=19.9e+6)

-- 建立累計（WHERE id <= ? GROUP BY product_id）
-> Aggregate using temporary table
    -> Index range scan on j11_ledger using PRIMARY over (id <= 99999999999)
```

優化器為了省掉暫存表，選了依 `idx_ledger_product`（`product_id, id`）的順序加總 —— 可是那個索引沒有 `delta_on_hand`，**每一列都要回主鍵讀一次**：兩千萬次隨機讀。另一句走主鍵的範圍掃描，循序讀。加一個 hint：

```
INV-3 全掃、IGNORE INDEX (idx_ledger_product)：差異 0 │ 5,677 ms
INV-3 全掃、IGNORE INDEX (idx_ledger_product)：差異 0 │ 5,583 ms
```

**130 秒 → 5.6 秒。** compose 那台真的資料（60 萬 9,905 列）交錯兩次：

```
shop（609,905 列）INV-3 原本：差異 0 │ 1,369 ms
shop（609,905 列）INV-3 IGNORE INDEX：差異 0 │ 154 ms
shop（609,905 列）INV-3 原本：差異 0 │ 1,228 ms
shop（609,905 列）INV-3 IGNORE INDEX：差異 0 │ 155 ms
```

**第 07 章 7.10 量到的 1,418 ms，就是那個慢的計畫。** 一句「一秒多，每小時一次可以接受」，背後是一個在 60 萬列時慢 8 倍、在 2,000 萬列時慢 23 倍的計畫。INV-3、INV-3' 的全掃都加上 `IGNORE INDEX`（另一個做法是把 `delta_on_hand`、`delta_reserved` 加進索引，讓它變成涵蓋索引 —— 那會讓每一次寫帳多維護兩欄，2.7 量過那種代價；hint 不用付）。

### 9.12.3 增量：累計、水位線，與還沒 commit 的那一列

就算全掃只要 5.6 秒，每小時掃一次 2,000 萬列還是「為了看系統健不健康而給系統增加負擔」（7.4.4）。增量的做法：

- **`inventory_ledger_checkpoints`**：每個商品「到水位線為止」的帳的加總（V24）。
- **`inventory_ledger_watermark`**：一列，「id 小於等於它的帳，已經加進累計」（V25；`shop_app` 只有 SELECT、UPDATE —— 9.11.2 的 `AppGrantsTest` 要為它開一個例外，不然「其他的四種都有」那一條會紅）。
- **每小時一次**，在同一個 REPEATABLE READ 的快照裡：拿快照裡的庫存，跟「累計 ＋ 水位線之後的帳」比；再把夠舊的帳併進累計、移動水位線。
- **每週一次全掃**；兩條都是 0，就用同一個快照重建累計 —— 萬一累計漂移了，在這一步被拉回來。

```java
Map<String, Long> checkIncremental(java.time.Duration margin) {
    Map<String, Long> out = new LinkedHashMap<>();
    out.put("INV-2", jdbc.queryForObject(CHECKS.get("INV-2"), Long.class));
    snapshot.executeWithoutResult(s -> {
        // FOR UPDATE：兩台機器同一時間跑，第二台在這裡等（不會把同一段帳加兩次）。鎖定讀不建立快照，下一句才建立
        long w = jdbc.queryForObject("SELECT upto_id FROM inventory_ledger_watermark WHERE id = 1 FOR UPDATE", Long.class);
        jdbc.query(INCREMENTAL, rs -> { out.put("INV-3", rs.getLong(1)); out.put("INV-3'", rs.getLong(2)); }, w);
        long cutoff = jdbc.queryForObject("SELECT COALESCE(MAX(id), ?) FROM inventory_ledger WHERE id > ? AND created_at < NOW(3) - INTERVAL ? MICROSECOND",
                Long.class, w, w, margin.toNanos() / 1000);
        if (cutoff > w) {
            fold(jdbc.query("SELECT product_id, SUM(delta_on_hand), SUM(delta_reserved) FROM inventory_ledger WHERE id > ? AND id <= ? GROUP BY product_id",
                    (rs, i) -> new Object[]{rs.getLong(1), rs.getLong(2), rs.getLong(3)}, w, cutoff));
            jdbc.update("UPDATE inventory_ledger_watermark SET upto_id = ? WHERE id = 1", cutoff);
        }
    });
    publish(out);
    return out;
}
```

（INV-2 照舊全掃：它比的是預留表的**現在**，預留表不是只增不減的帳。`INCREMENTAL` 那一句、`fold()`、每週的 `checkFullAndRebaseline()`、`snapshot`（REPEATABLE READ 的 `TransactionTemplate`）、V24、V25，以及 `InventoryJobs` 加的每週排程，全文在 9.15.1。）

在那張 2,000 萬列的表上，水位線之後 2,000 列（0.6.1 的一般流量下大約一小時的帳）：

```
增量（水位線之後 2,000 列）：INV-3 差異 0、INV-3' 差異 0 │ 29.6 ms
增量（再一次）：18.2 ms
把這 2,000 列併進累計：13.6 ms
```

**122～130 秒 → 18～30 ms，跟帳本多大無關。**

那個 `margin` 是做什麼的？`created_at < NOW(3) - margin` —— **水位線只前進到「夠舊」的帳。** 一個交易可能先插了一筆帳、還沒 commit；另一個交易比它晚插、先 commit 了，id 比它大。如果水位線前進到「現在看得到的最大 id」，就越過了那一筆還沒 commit 的；它 commit 之後，id 在水位線之下，永遠不會被加進累計 —— **一個永遠存在的假差異，每小時都會響。**

這是推論。`IncrementalReconciliationTest` 把它做出來：交易 A 插了商品 X 的一筆帳、先不 commit；交易 B 插了商品 Y 的一筆、commit；這時對帳一次；A commit；再對帳兩次。margin 0（天真的版本）與 margin 2 秒各一次。

**如果「併進累計」是一句 `INSERT … SELECT`，margin 0 那一個不會紅** —— A commit 之後，差異還是 0。而且那個測試類別會多花 10 秒，剛好是交易 A 的 `release.await(10, SECONDS)`。

在 InnoDB 裡，**`INSERT … SELECT` 的 SELECT 是鎖定讀**，不是快照讀：它碰到 A 那一列還沒 commit 的帳，就停下來等；10 秒後 A 等不到放行、自己 commit 了，它才繼續，讀到的是已經 commit 的那一列 —— 所以累計是對的。**`INSERT … SELECT` 不會漏帳，因為它會等。**

那「會等」有沒有代價？三個 MySQL 連線（J11e）：S1 插一筆帳、8 秒後才 commit；S2 是對帳的 `INSERT … SELECT`、拿到鎖之後再拿 5 秒；S3、S4 是新的下單，各插一筆帳：

```
  S3（新的帳，S2 還在等 S1 的時候）插入花了 0.0 秒，id=5
  S1 插了 id=4，8 秒後才 commit
  [  8.2 秒] S1 commit
  S2（對帳的 INSERT … SELECT）等了 7.0 秒；累計 product 1 = 11；接著再拿著鎖 5 秒
  S4（新的帳，S2 拿到鎖之後）插入花了 3.0 秒，id=6
  [ 13.2 秒] S2 commit
```

**S2 拿到鎖之後、commit 之前，新的帳一筆都寫不進去（S4 等了 3.0 秒）。** 我的解釋是：鎖定讀掃到最後一列，連「最後一列之後」的間隙也鎖了，而新的帳都插在那裡（REPEATABLE READ 的 next-key lock）—— 我沒有查 `performance_schema.data_locks` 確認。每小時那一次很短（2,000 列約 14 ms），但第一次建立累計要 12 秒；如果它等的那個交易拖得很久，它拿到鎖之後的那一段也跟著拖長 —— **對帳卡住下單。**

改成快照讀：加總用普通的 SELECT（REPEATABLE READ 的快照），再從 Java 批次寫入累計。帳本上一個鎖都不拿；代價是看不到還沒 commit 的那幾列 —— **這時候，水位線的陷阱才真的會發生**，`margin` 才真的有意義：

```
9.12 J11b margin 0（多出來的差異）：{A 還沒 commit 時對帳=0, 水位線=4, A commit 之後對帳=1, 再過 margin 之後對帳=1, 水位線（之後）=4, A、B 的 id=[3, 4], 全掃 INV-3=0, 全掃重建累計之後的增量=0}
9.12 J11b margin 2 秒（多出來的差異）：{A 還沒 commit 時對帳=0, 水位線=0, A commit 之後對帳=0, 再過 margin 之後對帳=0, 水位線（之後）=8, A、B 的 id=[7, 8], 全掃 INV-3=0, 全掃重建累計之後的增量=0}
```

- **margin 0**：水位線跳到 B 的 4，A 的 3 被跳過。A commit 之後差異是 1，而且一直是 1；全掃說 0（真相）；每週的全掃重建累計之後，增量回到 0。
- **margin 2 秒**：A 還沒 commit 時，水位線停在 0；等 margin 過了才前進到 8。全程沒有假差異。

正式的 margin 是 **5 分鐘**：一個交易插了帳之後，還可能等別的鎖，最多 `innodb_lock_wait_timeout`（50 秒）。5 分鐘之內沒有 commit 的交易，這個假設就破了 —— 那時候增量會報一個假差異（告警會響），每週的全掃會把它拉回來。

> 📌 **增量最難的不是加總，是「加到哪裡為止」。** 自動遞增的 id 是在 INSERT 的那一刻分配的，commit 的順序可以跟它不一樣（不管 `innodb_autoinc_lock_mode` 是哪一種都一樣：它決定的是 INSERT 期間怎麼分配 id，跟 commit 的先後無關）。水位線要嘛等（鎖定讀：正確，但卡住寫入），要嘛留一段 margin（快照讀：不卡，但要一個關於交易長度的假設）。這一章選了後者，並且每週用一次全掃檢查那個假設。

---

## 9.13 上線檢查清單

### 9.13.1 一份會自己跑的清單

第 02 章 2.7 說「每一次實驗之後、以及第 09 章的上線檢查清單裡，都有這一句」（invisible 的索引）；0.7 第 11 項說「第 09 章上線檢查清單會列出來，但不實作」（備份、高可用）。一份寫在文件裡的清單，上線前會被跳過；所以它是一支腳本（`scripts/j12-checklist.sh`，全文在 9.15.1），對著 compose 的 `app` profile 跑，每一項印出 ✅、❌ 或 ⚠️ 與證據。正式環境換成對應的位址與帳號。

第一次：

```
── 對外
  ✅ /actuator/health → 404（actuator 不在對外的埠）
  ✅ /actuator/prometheus → 401（actuator 不在對外的埠）
  ❌ /v3/api-docs → 200（API 文件對外公開）
  ❌ /swagger-ui.html → 200 或 302（API 文件對外公開）
  ✅ 管理埠的 /actuator/health 沒有登入只看到 {"status":"UP","groups":["liveness","readiness"]}
── 容器
  ✅ 執行身分 shop
  ✅ PID 1 是 java
  ✅ StopTimeout 30 秒
  ✅ 記憶體上限 1024 MiB
  ✅ CPU 上限 4
── 日誌
  ❌ 最後 52 行裡 51 行是 JSON
  ✅ 時間是 UTC
── 資料庫
  ✅ shop 在 shop 庫上沒有直接的權限（只有 shop_app 角色）
  ⚠️  應用程式的 20 條連線都是 TLS —— 但 sslMode=REQUIRED 不驗證憑證（正式環境用 VERIFY_IDENTITY 與真的 CA）
  ✅ invisible 的索引 0 個（2.7）
  ✅ outbox 未送出 0
  ✅ INV-3 全掃差異 0
── 訊息
  ✅ 死信 0
── 監控
  ✅ Prometheus targets up：3 3
  ✅ 告警規則 19 條
  ✅ 現在 firing 的告警：沒有
  ❌ 沒有 Alertmanager：告警響了，沒有人會收到
── 秘密
  ✅ yml 裡沒有不是本機用的秘密（application-prod.yml 全部是 ${…}）
── 沒有做的（0.7 第 11 項、這一章的範圍外）
  ⚠️  資料庫的備份與還原、高可用：沒有實作
  ⚠️  負載平衡器之後的 X-Forwarded-For（5.6.4）：compose 沒有負載平衡器；正式環境要設 server.forward-headers-strategy 並確定應用程式的埠只有負載平衡器連得到
```

（這是重排過的版本：腳本第一次印出來的時候，`$c（` 又踩到了 macOS 的 bash 3.2 遇到全形字的老問題，有狀態碼的那幾行是亂碼。actuator 的 404／401 是 9.4.3 用 curl 量過的；腳本只在 200 時印「`/v3/api-docs` ❌」、在 200 或 302 時印「`/swagger-ui.html` ❌」—— 後者是哪一個，亂碼吃掉了。修好之後兩者都是 404。）

三個 ❌：

- **API 文件在正式環境的設定下對外公開。** 第 03 章練習六問的就是這一件：「在正式環境要不要讓它看得到？」—— 不要。`application-prod.yml` 關掉 springdoc。
- **最後 52 行裡有 1 行不是 JSON**：`NOTE: Picked up JDK_JAVA_OPTIONS: …`（9.7.3）。JVM 參數搬進 `ENTRYPOINT`。
- **沒有 Alertmanager**（9.10.6）。

修好、重新部署之後：

```
  ✅ /v3/api-docs → 404
  ✅ /swagger-ui.html → 404
  ✅ 最後 50 行全部是 JSON
  ✅ 時間是 UTC（2026-10-06T06:51:23.57164118Z）
  ……
  ✅ Alertmanager 1 個
```

（Alertmanager 那一項第二次還是 ❌：Prometheus 的容器沒有被重建，舊的設定還在用 —— 9.10.6。）

### 9.13.2 設定：兩個我以為的事

**環境變數怎麼寫。** 9.2.2 J2 的容器用 `SHOP_ORDER_JOBS_ENABLED=false` 關排程。我以為這是錯的、正確是 `SHOP_ORDER_JOBSENABLED` —— 那是我記得的 relaxed binding 規則，沒有量。用 `--debug` 的條件報告直接看 `OrderJobs` 這個排程有沒有被建立：

```
SHOP_ORDER_JOBS_ENABLED=false    → OrderJobs:  Did not match
SHOP_ORDER_JOBSENABLED=false     → OrderJobs:  Did not match
（沒有設）                         → OrderJobs matched
```

**兩種都可以**（Spring Boot 也接受把 `-` 寫成 `_` 的舊寫法）。

**少了一個秘密。** `prod` profile、給了其他所有環境變數、就是沒有 `SHOP_JWT_SECRET`：

```
結束碼 1 ；3.1 秒
Binding to target com.example.shop.shared.config.ShopProperties failed:
    Property: shop.security.jwtSecret
    Value: "${SHOP_JWT_SECRET}"
    Origin: class path resource [application-prod.yml] from shop-0.0.1-SNAPSHOT.jar - 24:17
    Reason: JWT 金鑰至少 32 bytes（256 bits，0.6.5）
```

3 秒內失敗、退出 —— 結果是對的。但訊息會讓人以為是「金鑰太短」：沒有解開的佔位符被當成字面值 `${SHOP_JWT_SECRET}` 綁了進去，再被長度驗證擋下。第 01 章有一個 `UnresolvedPlaceholderCheck` 專門抓這件事，這一次它沒有機會跑 —— Tomcat 啟動時要建 `RateLimitFilter`，就先把 `ShopProperties` 綁了。（這一次的日誌，32 行裡 25 行是 JSON，另外 7 行是 banner，9.7.3。）

### 9.13.3 清單本身

| 類別 | 項目 | 這一章 |
|---|---|---|
| 對外 | 只有 8080 經過負載平衡器對外；actuator、API 文件不對外 | ✅（清單檢查） |
| | 管理埠 `/actuator/health` 不帶細節（`show-details: when-authorized`，0.10.4） | ✅ |
| | `X-Forwarded-For`：`server.forward-headers-strategy`，且應用程式的埠只有負載平衡器連得到（5.6.4） | ⚠️ 沒有負載平衡器可以測 |
| 容器 | 非 root、PID 1 是 java、寬限 ≥ 20 秒、CPU 4／記憶體 1 GB 的上限 | ✅ |
| 日誌 | 每一行 JSON、UTC、traceId；email、JWT 遮罩 | ✅ |
| 資料庫 | 應用程式只有 `shop_app` 角色（INV-5）；migration 用 `shop_migrator`、是部署的一個步驟 | ✅ |
| | TLS：`VERIFY_IDENTITY` 與真的 CA | ⚠️ 只有 REQUIRED |
| | invisible 的索引 0 個（2.7） | ✅ |
| | 備份與還原、高可用（0.7 第 11 項） | ⚠️ 不做，列出 |
| 資料 | outbox 未送出 0、死信 0、INV-3 全掃差異 0 | ✅ |
| 監控 | Prometheus 抓得到三個目標、19 條規則載入、Alertmanager 接上、現在沒有 firing | ✅（收件人只有本機） |
| 秘密 | repo 裡沒有正式環境的秘密；每一個都是 `${…}`；少了一個 → 啟動失敗 | ✅（訊息會誤導） |
| 規格 | 熱點下單：新實例要先暖機（9.6.4） | ⚠️ 沒有實作 |

---

## 9.14 流程測試與追溯表

### 9.14.1 這一章新增與改了的測試

| 測試 | 幾個 | 守什麼 |
|---|---|---|
| 驗收 Q7 | 從跳過變成 1 | HTTP → DB → MQ 消費端，同一個 traceId；外面帶進來的不收（9.8） |
| `EventFlowTest.unsubscribedEventsDoNotBlockRelay` | ＋1 | 沒有人訂閱的事件不能卡住 relay（9.2.1） |
| `EventFlowTest.brokenBindingBacksOff` | ＋1 | 拓撲壞了：那一筆延後 5 秒、不擋後面的；突變（馬上放回）17 次 vs 1 次（9.2.1） |
| `JobTraceTest` | ＋2 | 排程的每一輪一個 traceId；冪等鍵 24 小時的清理（9.8.3、9.11.4） |
| `JsonLogFormatTest` | ＋3 | 正式的 JSON 格式：欄位、UTC、遮罩、堆疊（9.7） |
| `AppGrantsTest` | ＋2 | INV-5：六種被拒絕；每一張表都授權了（9.11） |
| `AuditRetentionTest` | ＋1 | 稽核一年：程序刪得掉一年以前的、刪不掉別的（9.11.4） |
| `IncrementalReconciliationTest` | ＋2 | 水位線不越過還沒 commit 的那一列；天真的版本會留下假差異（9.12） |
| `AlertMetricsTest` | ＋1 | `alerts.yml` 用到的每一個指標，啟動時就存在（9.10.2） |
| `docker/prometheus/alerts_test.yml` | 7 組（不在 `mvn` 裡） | 19 條規則；晚註冊的計數器、5 分鐘窗的事後告警（9.10） |
| `refundResponseLostOnce` | 改 | 模擬金流的 `reset()` 把呼叫次數歸零（9.2.1） |
| `q5_idorReturns404`、`IdorMatrixTest`、`AuthApiTest.noAccountEnumeration` | 改 | 比較 body 之前把各自的 traceId 換成佔位符，並先確認兩邊都有（9.8.5） |
| 41 個測試檔、68 句 | 改 | 清理帳與稽核改用 `TestInfra.adminJdbc()`（9.11.3） |
| 驗收 Q6 | 改（權限） | migration 由 `shop_migrator` 跑（9.11.3） |

上面新的測試，全文在 9.15.1（`IncrementalReconciliationTest`、`AuditRetentionTest`、`JobTraceTest` 都是 `@DirtiesContext(classMode = AFTER_CLASS)`，9.14.2）。

實驗：`ch09/J7CardinalityTest`、`loadtest/StopDuringLoad`；J1～J13 是腳本（`scripts/j*.sh`）。CI 的流程多了兩步：`docker/prometheus/test.sh`（`promtool`）與 `docker build`（GitHub 上仍然沒有跑過）。

### 9.14.2 ⚠️ 測試的連線數，第一次撞到 151

這一章快結束時的一次完整建置：

```
[ERROR] Tests run: 200, Failures: 0, Errors: 11, Skipped: 0
Caused by: org.flywaydb.core.internal.exception.FlywaySqlException: Unable to obtain connection from database: Too many connections
```

`CatalogCartApiTest`、`OpenApiContractTest`、`DeadLetterReplayTest` 的 context 起不來。Testcontainers 的 MySQL，`max_connections` 是預設的 151；Spring 的測試會快取每一種不同設定的 context，**每一個都留著一個固定 20 條的 Hikari 連線池**（Hikari 預設 `minimum-idle` 等於上限）。這一章多了兩種新的 context 設定（`IncrementalReconciliationTest`、`AuditRetentionTest`），我的推測是總數第一次超過了 151。

讓建置自己說出來：`TestInfra` 在 JUnit 結束的那一刻（`launcherSessionClosed`）印出 MySQL 的 `Max_used_connections`。（放在 JVM 的 shutdown hook 的話，一行都印不出來 —— 那時 Testcontainers 自己的 hook 可能已經把容器收了。）

| 這一次建置 | 結果 | 連線的高峰 |
|---|---|---|
| 兩個新測試沒有 `@DirtiesContext` | Too many connections | **152**（151 ＋ 保留給管理員的 1 條） |
| 加上 `@DirtiesContext`（用完就關） | 200 / 0 / 0 / 0 | **152** |
| ＋ 測試的連線池閒置下限 2、閒置 10 秒收掉 | 200 / 0 / 0 / 0 | **24** |

推測成立。但第二列說明了一件事：**加了 `@DirtiesContext` 之後全綠，高峰還是 152 —— 只是這一次剛好沒有任何一個 context 在那一刻要連線。** 如果我只看綠燈，會以為修好了。真正的修法在第三列：只在測試的設定裡讓閒置的連線收掉（上限照舊 20，並發的測試量的還是同一個池；正式環境照舊是固定 20 條）。（`idle-timeout` 不能寫成 `10s` —— `hikari.*` 直接綁到 `HikariConfig` 的 `long`，只吃毫秒；寫成 `10s`，110 個測試的 context 起不來、39 秒就結束。）

> 📌 **一個「剛好沒出錯」的綠燈，跟一個紅燈一樣需要解釋。** 這一節如果沒有那一行「最多同時 152 條連線」，第二次建置的全綠就會被當成修好了；下一個加了一個 context 的人，會在一個毫不相干的測試上看到 `Too many connections`。

### 9.14.3 追溯表更新

| 需求 | 驗證方式 | 狀態 |
|---|---|---|
| **Q7**（0.6.6 traceId） | 驗收 Q7（9.8）；`JobTraceTest` | ✅ 09 |
| 0.6.6 日誌：JSON、traceId、userId、orderNo | `JsonLogFormatTest`、Q7 | ✅ 09 |
| 0.6.5 日誌遮罩：email、不記 token | `JsonLogFormatTest`；J0 的 188 個測試日誌掃描（9.7.2） | ✅ 05、09 |
| 0.6.6 指標 → `/actuator/prometheus` | 管理埠（9.9.1）；`AlertMetricsTest` | ✅ 09 |
| 0.6.6 告警（七條＋各章留下的） | `alerts.yml` 19 條、`promtool` 7 組、三次演練、Alertmanager（9.10） | ✅ 09（收件人只有本機） |
| US-ORD-5 AC-4 越權告警 | `shop.audit.denied_suspects`、`ShopAccessDeniedSuspects` | ✅ 09（排程沒有測試：5 分鐘才第一次） |
| **INV-5** | `AppGrantsTest`（9.11） | ✅ 09 |
| 0.6.7 保留：稽核 1 年、冪等鍵 24 小時 | `AuditRetentionTest`、`JobTraceTest.purgesExpiredIdempotencyKeys` | ✅ 07、09 |
| 0.6.5 秘密 | 上線檢查清單（9.13）；少了一個 → 啟動失敗 | ✅ 01、09 |
| 0.6.3 readiness / liveness | 管理埠；compose 的 healthcheck；`HealthProbeTest` | ✅ 00、08、09 |
| 0.6.4 對帳（每小時，差異必須為 0） | 增量 `IncrementalReconciliationTest`；每週全掃 | ✅ 07、09 |
| 0.6.8 建置 < 5 分鐘 | 本機 4:07、乾淨的容器 4:45（9.15） | ✅ 08、09 |
| 0.6.8 覆蓋率 | 92.6%；`ordering` 96.6%、`inventory` 94.7%、`payment` 93.3% | ✅ 08、09 |
| 0.6.8 新人上手 | `docker compose --profile app up -d --wait`，一個命令（9.4） | ✅ 09（前提：那幾個埠都空著） |
| 0.6.2 熱點下單、ORD-1b AC-2 | J4、J4c：4 CPU 時暖機之後 12 輪裡 11 輪；2 CPU、新實例的第一輪沒有 | **部分**（缺暖機） |
| 0.6.2 商品詳情 p99 50 ms | 這一章沒有重量 | **部分**（08） |
| 0.7 第 11 項 備份、高可用 | 上線檢查清單列出 | 不做 |
| CI | `.github/workflows/ci.yml`（＋ promtool、docker build）；乾淨的容器 | 部分（GitHub 上沒有跑過） |
| Q1～Q11 | 驗收 | **✅ 全部**（`Skipped: 0`） |

---

## 9.15 本章完成後的專案

```
shop/
├── Dockerfile                                           ← 新增：多階段、分層、非 root、exec form（9.3）
├── .dockerignore                                        ← 新增
├── compose.yaml                                         ← + app profile：migrate、app、prometheus、mysqld-exporter、alertmanager、alert-sink（9.4、9.10）
├── .github/workflows/ci.yml                             ← + promtool、docker build
├── pom.xml                                              ← + micrometer-tracing-bridge-brave、logstash-logback-encoder 7.4、micrometer-registry-prometheus
├── docker/
│   ├── mysql-init/00-users.sql                          ← 新增：shop_app 角色、shop_migrator、shop、exporter（9.11）
│   ├── mysql-init/01-databases.sql                      ← + shop_migrator 對 shop_q6
│   ├── prometheus/{prometheus.yml,alerts.yml,alerts_test.yml,test.sh}   ← 新增（9.10）
│   └── alertmanager/{alertmanager.yml,sink.py}          ← 新增（9.10.6）
├── scripts/j*.sh                                        ← 新增：這一章的實驗、j12-checklist.sh（上線檢查清單）
└── src/
    ├── main/java/com/example/shop/
    │   ├── shared/
    │   │   ├── observability/{Traces,TracedJobs}.java   ← 新增：消費者接著事件的 trace、排程每一輪一個 trace（9.8）
    │   │   ├── web/TraceFilters.java                    ← 新增：不收外面的 trace header、X-Trace-Id、MDC 的 userId（9.8）
    │   │   ├── web/GlobalExceptionHandler.java          ← ProblemDetail 帶 traceId
    │   │   ├── security/SecurityConfig.java             ← /actuator/prometheus 只在管理埠放行（9.9）
    │   │   ├── messaging/internal/RabbitOutboxRelay.java    ← 沒有人訂閱的不送；送不出去的延後再試；shop.outbox.rejected（9.2.1）
    │   │   ├── messaging/internal/RabbitConsumers.java      ← 接著 header 的 traceId；orderNo 進 MDC（9.8）
    │   │   ├── events/internal/OutboxStore.java         ← + retryLater
    │   │   └── audit/internal/{AuditRetention,DeniedSuspects}.java   ← 新增（9.11.4、9.9.2）
    │   ├── inventory/internal/InventoryReconciliation.java   ← 增量（累計＋水位線）、每週全掃、IGNORE INDEX（9.12）
    │   ├── ordering/internal/{PlaceOrderService,OrderTransitionService,OrderJobs}.java   ← 指標、ORDER_PLACED 日誌、冪等鍵清理
    │   └── payment/internal/JdbcPaymentService.java     ← shop.payment.callback.rejected（啟動時註冊）
    ├── main/resources/
    │   ├── application-prod.yml                         ← 管理埠 8081、JSON 日誌、graceful、flyway 關、springdoc 關、banner 關
    │   ├── application.yml                              ← prometheus、SLO 桶
    │   ├── logback-json.xml                             ← 新增（9.7）
    │   └── db/migration/V15～V25                        ← 新增：角色與每個模組的授權、稽核保留、對帳的累計與水位線
    └── test/
        ├── support/{CapturedLogs,TraceIds}.java         ← 新增；TestInfra：root 起容器、adminJdbc()、連線高峰
        ├── resources/config/application.yml             ← 測試的連線池閒置下限 2（9.14.2）
        └── ……（9.14.1 的那些）
```

**11 個新的 migration（V15～V25），只有 2 張新的表**（對帳的累計與水位線）；其他 9 個是授權與一個預存程序。正式程式碼改了 33 個檔案；`git diff --stat ch08..ch09`：111 個檔案，+2,344／−110 行，17 個 commit（下面那一次建置在第 16 個；第 17 個只改了一條告警的說明文字，`promtool` 重跑過）。

```bash
mvn clean verify
```

```
TEST_INFRA testcontainers 啟動 9,028 ms：mysql jdbc:mysql://localhost:52760/shop、redis localhost:52750、rabbitmq localhost:52757
TEST_INFRA MySQL 最多同時 25 條連線（max_connections 151）
[INFO] Results:
[INFO]
[INFO] Tests run: 201, Failures: 0, Errors: 0, Skipped: 0
[INFO]
……
[INFO] --- jacoco:0.8.15:check (coverage-overall) @ shop ---
[INFO] All coverage checks have been met.
[INFO] --- jacoco:0.8.15:check (coverage-ordering) @ shop ---
[INFO] All coverage checks have been met.
[INFO] --- jacoco:0.8.15:check (coverage-inventory) @ shop ---
[INFO] All coverage checks have been met.
[INFO] --- jacoco:0.8.15:check (coverage-payment) @ shop ---
[INFO] All coverage checks have been met.
[INFO] BUILD SUCCESS
[INFO] Total time:  04:07 min
```

**201 個測試、0 個失敗、0 個跳過。** 0.12.1 寫的「專題的『完成』定義就是：這個類別裡沒有任何一個 `@Disabled`，而且全部綠燈」—— 從第 00 章的 `Skipped: 11` 一路到這裡：

```
ch00 結束：Skipped 11
ch02 結束：Skipped 10   （Q6）
ch03 結束：Skipped  9   （Q4）
ch04 結束：Skipped  6   （Q1、Q2、Q3）
ch05 結束：Skipped  5   （Q5）
ch06 結束：Skipped  4   （Q8）
ch07 結束：Skipped  1   （Q9、Q10、Q11）
ch09 結束：Skipped  0   （Q7）
```

同一個 commit，在一個空的容器裡（沒有 compose、沒有 `~/.m2`、UTC、Linux）：

```
### 乾淨的機器 bab3268 start 2026-10-06 15:58:54 load { 6.07 6.43 5.82 }
TEST_INFRA testcontainers 啟動 8,765 ms：mysql jdbc:mysql://host.docker.internal:54136/shop、……
TEST_INFRA MySQL 最多同時 25 條連線（max_connections 151）
[INFO] Tests run: 201, Failures: 0, Errors: 0, Skipped: 0
[INFO] All coverage checks have been met.   （四行）
[INFO] BUILD SUCCESS
[INFO] Total time:  04:45 min
```

覆蓋率：

```
  模組                          行      行覆蓋             分支     分支覆蓋
  account           225 / 238       94.5%      73 / 98       74.5%
  cart               56 / 62        90.3%      18 / 26       69.2%
  catalog           200 / 215       93.0%      60 / 86       69.8%
  inventory         302 / 319       94.7%      89 / 114      78.1%
  notification       58 / 62        93.5%      19 / 22       86.4%
  ordering          505 / 523       96.6%     179 / 217      82.5%
  payment           125 / 134       93.3%      27 / 38       71.1%
  reporting          53 / 53       100.0%      17 / 20       85.0%
  shared            816 / 919       88.8%     193 / 280      68.9%
  ＝ 全部             2341 / 2528      92.6%     675 / 901      74.9%
```

| | 第 08 章 | 第 09 章 |
|---|---|---|
| 測試 | 188（跳過 1） | 201（**跳過 0**） |
| 應用程式怎麼跑 | IDE、`java -jar` | 映像檔；`docker compose --profile app up -d --wait` |
| 日誌 | 文字、`+08:00`、沒有 traceId | JSON、UTC、traceId、遮罩 |
| outbox、稽核的 `trace_id` | 86,947 列、2 列，全部 NULL | 每一列 |
| 告警 | 0 條 | 19 條，有測試、有收件人 |
| 應用程式的資料庫權限 | `ALL PRIVILEGES` | 一個角色；帳與稽核只能新增 |
| 每小時的對帳（2,000 萬列） | 122～130 秒（全掃，錯的計畫） | 18～30 ms（增量）；每週全掃 5.6 秒 |
| `mvn clean verify` | 3:45 | 4:07（乾淨的容器 4:45） |

> 📌 **這一章的程式碼上還有幾個修正，各自寫在發現它的那一章。** 參考實作的 `ch09` 分支上還是改之前的寫法。
>
> | 改了什麼 | 寫在 |
> |---|---|
> | 付款回呼的金額三位小數：500 → 400 | 4.6.3 |
> | 熱點商品一單買多件、落帳不夠時 Redis 偏低：只加回真的存在的那一部分 | 6.5.3 |
> | US-RPT-2 AC-1（銷售排行）、US-RPT-3（全站報表）：三支新的 API，沒有新的 migration | 3.7.1 |
> | Hikari 的 `validation-timeout: 1000`（MySQL 卡住時 readiness 5 秒 → 3 秒） | 8.9.1 |
> | `SeedData`、C7 在 INV-5 之後跑不起來 | 9.11.4、2.7.2 與 2.8.2 |
> | C7 的報表查詢用 `SEED_NOW`、`SeedData.truncate()` 在同一條連線上、I1 的「預設」組自己綁 `::` | 2.7.2、2.8.2、8.2.2 |
> | 程式碼註解裡指錯的節號（四十一行） | 各章附錄的說明 |
>
> 上面這幾個改完之後的 `mvn clean verify`：
>
> ```
> TEST_INFRA MySQL 最多同時 24 條連線（max_connections 151）
> [INFO] Tests run: 226, Failures: 0, Errors: 0, Skipped: 0
> [INFO] All coverage checks have been met.   （四行）
> [INFO] BUILD SUCCESS
> [INFO] Total time:  04:02 min
> ```
>
> 201 → 226：CART-1 的 50 種上限 1 個（3.6.1）、回呼三位小數 3 個、熱點落帳 1 個、兩張報表 20 個。這一章正文、驗收清單裡的「201」是改之前的數字。
>
> 另外還有七個修正，也各自寫在那一節：取消時少退一筆錢（4.6.2）、排程一張失敗整批停下（4.7.1）、`perIpLimit` 撞到整分鐘（5.6.4）、兩台同時第一次啟動搶著建管理員（5.10）、single-flight 讀了兩次（6.4.3）、通知的認領（7.7.2）、死信的測試讀得太早（7.7.3）。這七個也改完之後，整套 `mvn clean verify` 是 235 個測試、全綠（4 分 17 秒）。

### 9.15.1 本章其餘檔案的完整內容

正文為了把每一個決定講清楚，大部分檔案只貼了片段。下面是 ch09 結束時（第 17 個 commit）這些檔案的完整內容；大檔案裡只改了幾行的，給的是 `git diff ch08 ch09` 的改動。從第 08 章的專案出發，加上正文與這一節，就是這一章結束時的專案。（例外：`compose.yaml` 的記憶體註解「640～670 MiB」、`application-prod.yml` 的 banner 註解，這裡已經依 9.6.2、9.7 的正文更正；參考實作的 ch09 分支裡仍是舊的寫法「650～690 MiB」與「banner 在日誌設定生效之前印到 stdout」。另外，Alertmanager 相關三個檔案的「9.13」、`RabbitOutboxRelay` 的「9.9 的告警」，以及從第 07、08 章帶過來的幾行註解節號，這裡也已依課文更正為 9.10.6、9.10、7.10、8.4.4。）動手時先做第一組（帳號與 migration，9.11），再做其他；`docker compose --profile app up` 要等這一節的檔案都到位再跑 —— compose 會掛載 `docker/prometheus`、`docker/alertmanager` 底下的設定。

#### 帳號、權限與 migration（9.11、9.12）

**`docker/mysql-init/00-users.sql`**

```sql
-- 第 09 章（9.11）INV-5：兩個帳號。只在空 volume 第一次啟動時自動執行（檔名 00：01-databases.sql 會 GRANT 給 shop，shop 要先存在 —— Testcontainers 用 root 起容器時，沒有人替它建 shop）；
-- 已經有 volume 的人手動跑一次：docker compose exec -T mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD"' < docker/mysql-init/00-users.sql
--   shop_migrator：Flyway 用，DDL 與授權（V15 建角色、V15～V22 授權）
--   shop（應用程式）：只有 shop_app 這個角色 —— compose 的 MYSQL_USER 會先給它整個 shop 的 ALL，這裡收回
CREATE ROLE IF NOT EXISTS shop_app;
CREATE USER IF NOT EXISTS 'shop_migrator'@'%' IDENTIFIED BY 'shop_migrator';
GRANT ALL PRIVILEGES ON `shop`.* TO 'shop_migrator'@'%' WITH GRANT OPTION;
GRANT CREATE ROLE ON *.* TO 'shop_migrator'@'%';
CREATE USER IF NOT EXISTS 'shop'@'%' IDENTIFIED BY 'shop';
REVOKE IF EXISTS ALL PRIVILEGES ON `shop`.* FROM 'shop'@'%';   -- IF EXISTS（8.0.30）：Testcontainers 用 root 起的時候，這個 shop 是剛建的、本來就沒有（ERROR 1141）
GRANT shop_app TO 'shop'@'%';
SET DEFAULT ROLE shop_app TO 'shop'@'%';
FLUSH PRIVILEGES;
-- 9.10 mysqld-exporter（Prometheus）：唯讀、最多 3 條連線
CREATE USER IF NOT EXISTS 'exporter'@'%' IDENTIFIED BY 'exporter' WITH MAX_USER_CONNECTIONS 3;
GRANT PROCESS, REPLICATION CLIENT, SELECT ON *.* TO 'exporter'@'%';
FLUSH PRIVILEGES;
```

**`docker/mysql-init/01-databases.sql`**

```sql
-- 實驗與驗收測試用的資料庫。只在空 volume 第一次啟動時自動執行；
-- 已經有 volume 的人手動跑一次：docker compose exec -T mysql mysql -uroot -proot < docker/mysql-init/01-databases.sql
CREATE DATABASE IF NOT EXISTS shop_lab;
GRANT ALL PRIVILEGES ON `shop_lab`.* TO 'shop'@'%';   -- 第 00～02 章的實驗
GRANT ALL PRIVILEGES ON `shop_c2`.*  TO 'shop'@'%';   -- 2.2.2 Flyway 實驗（測試自己建、自己刪）
GRANT ALL PRIVILEGES ON `shop_q6`.*  TO 'shop'@'%';   -- 驗收 Q6：每次從空資料庫開始
GRANT ALL PRIVILEGES ON `shop_q6`.*  TO 'shop_migrator'@'%' WITH GRANT OPTION;   -- 9.11：Q6 的 migration 跟正式環境一樣由 shop_migrator 跑（00-users.sql 建的）
FLUSH PRIVILEGES;
```

**`src/main/resources/db/migration/V16__account_app_grants.sql`**

```sql
-- 9.11 INV-5：account 模組的表
GRANT SELECT, INSERT, UPDATE, DELETE ON users TO shop_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_roles TO shop_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON refresh_tokens TO shop_app;
```

**`src/main/resources/db/migration/V17__catalog_app_grants.sql`**

```sql
-- 9.11 INV-5：catalog 模組的表
GRANT SELECT, INSERT, UPDATE, DELETE ON products TO shop_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON categories TO shop_app;
```

**`src/main/resources/db/migration/V19__cart_app_grants.sql`**

```sql
-- 9.11 INV-5：cart 模組的表
GRANT SELECT, INSERT, UPDATE, DELETE ON cart_items TO shop_app;
```

**`src/main/resources/db/migration/V20__ordering_app_grants.sql`**

```sql
-- 9.11 INV-5：ordering 模組的表
GRANT SELECT, INSERT, UPDATE, DELETE ON orders TO shop_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON order_items TO shop_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON order_status_history TO shop_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_keys TO shop_app;
```

**`src/main/resources/db/migration/V21__payment_app_grants.sql`**

```sql
-- 9.11 INV-5：payment 模組的表
GRANT SELECT, INSERT, UPDATE, DELETE ON payments TO shop_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON refunds TO shop_app;
```

**`src/main/resources/db/migration/V22__notification_app_grants.sql`**

```sql
-- 9.11 INV-5：notification 模組的表
GRANT SELECT, INSERT, UPDATE, DELETE ON notifications TO shop_app;
```

**`src/main/resources/db/migration/V24__inventory_ledger_checkpoints.sql`**

```sql
-- 第 09 章（9.12）對帳改成增量的：每個商品「到水位線為止」的帳的加總。
-- 0.6.1：3 年 5,000 萬筆庫存帳 —— 每小時全掃一次不是辦法（9.12 的 J11a）；每小時只看水位線之後的帳，加上這裡的累計
CREATE TABLE inventory_ledger_checkpoints (
  product_id    BIGINT  NOT NULL,
  sum_on_hand   BIGINT  NOT NULL,
  sum_reserved  BIGINT  NOT NULL,
  PRIMARY KEY (product_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON inventory_ledger_checkpoints TO shop_app;
```

**`src/main/resources/db/migration/V25__inventory_ledger_watermark.sql`**

```sql
-- 9.12 水位線：inventory_ledger 裡 id 小於等於它的，已經加進 inventory_ledger_checkpoints。只有一列（id = 1）。
-- 只會前進到「夠舊」的帳（created_at 早於 5 分鐘前）：還沒 commit 的交易手上的那一列，id 可能比已經 commit 的小（9.12 的 J11b）
CREATE TABLE inventory_ledger_watermark (
  id          TINYINT      NOT NULL,
  upto_id     BIGINT       NOT NULL,
  updated_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT ck_ledger_watermark_one_row CHECK (id = 1)
);
INSERT INTO inventory_ledger_watermark (id, upto_id) VALUES (1, 0);
GRANT SELECT, UPDATE ON inventory_ledger_watermark TO shop_app;
```

**`src/main/java/com/example/shop/shared/audit/internal/AuditRetention.java`**

```java
package com.example.shop.shared.audit.internal;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.SchedulingConfigurer;
import org.springframework.scheduling.config.FixedDelayTask;
import org.springframework.scheduling.config.ScheduledTaskRegistrar;

import java.time.Duration;

/**
 * 9.11 0.6.7：稽核保留 1 年。應用程式沒有 audit_logs 的 DELETE（INV-5 的同一條線，V15）——
 * 每天呼叫一次 V23 的 purge_audit_logs：一次 1,000 列，刪到沒有為止（7.4.4 的寫法：一句 DELETE 刪太多會鎖住一大段）
 */
@Configuration(proxyBeanMethods = false)
@EnableScheduling
@ConditionalOnProperty(name = "shop.order.jobs-enabled", havingValue = "true", matchIfMissing = true)
class AuditRetention implements SchedulingConfigurer {

    private static final Logger log = LoggerFactory.getLogger(AuditRetention.class);
    static final int BATCH = 1_000;
    static final Duration EVERY = Duration.ofDays(1);

    private final JdbcTemplate jdbc;

    AuditRetention(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    @Override
    public void configureTasks(ScheduledTaskRegistrar registrar) {
        registrar.addFixedDelayTask(new FixedDelayTask(this::purge, EVERY, Duration.ofMinutes(10)));
    }

    int purge() {
        int total = 0, n;
        do {
            n = jdbc.queryForObject("CALL purge_audit_logs(?)", Integer.class, BATCH);
            total += n;
        } while (n == BATCH);
        if (total > 0) log.info("AUDIT_RETENTION 刪掉 {} 列一年以前的稽核", total);
        return total;
    }
}
```

**`src/main/java/com/example/shop/shared/audit/internal/DeniedSuspects.java`**

```java
package com.example.shop.shared.audit.internal;

import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.SchedulingConfigurer;
import org.springframework.scheduling.config.FixedDelayTask;
import org.springframework.scheduling.config.ScheduledTaskRegistrar;

import java.time.Duration;
import java.util.List;

/**
 * 9.10 US-ORD-5 AC-4 的告警：「同一位使用者越權嘗試太多次」。
 * 5.8 的結論：時間窗要一小時以上（攻擊者每分鐘 19 次，一分鐘 20 次的門檻永遠不會響），資料直接來自 audit_logs。
 * userId 不能當指標的 tag（9.9 J7：每一個使用者一條永遠不會消失的序列）—— 所以這裡每 5 分鐘跑一次 5.8 的那一句，
 * 指標只放「有幾位」；是哪幾位寫進日誌（AUDIT_DENIED_SUSPECTS），告警響了去那裡看
 */
@Configuration(proxyBeanMethods = false)
@EnableScheduling
class DeniedSuspects implements SchedulingConfigurer {

    private static final Logger log = LoggerFactory.getLogger(DeniedSuspects.class);
    static final int THRESHOLD = 50;
    static final Duration EVERY = Duration.ofMinutes(5);

    private final JdbcTemplate jdbc;
    private volatile int suspects;

    DeniedSuspects(JdbcTemplate jdbc, MeterRegistry meters) {
        this.jdbc = jdbc;
        Gauge.builder("shop.audit.denied_suspects", () -> suspects)
                .description("過去一小時 ACCESS_DENIED 超過 50 次的使用者有幾位（US-ORD-5 AC-4）").register(meters);
    }

    @Override
    public void configureTasks(ScheduledTaskRegistrar registrar) {
        registrar.addFixedDelayTask(new FixedDelayTask(this::check, EVERY, EVERY));   // 啟動之後 5 分鐘才第一次（測試的應用程式活不到那麼久）
    }

    int check() {
        List<Long> who = jdbc.queryForList("""
                SELECT actor_id FROM audit_logs
                 WHERE action = 'ACCESS_DENIED' AND created_at >= NOW(3) - INTERVAL 1 HOUR
                 GROUP BY actor_id HAVING COUNT(*) > ?""", Long.class, THRESHOLD);
        suspects = who.size();
        if (!who.isEmpty()) log.warn("AUDIT_DENIED_SUSPECTS 過去一小時越權超過 {} 次的使用者：{}", THRESHOLD, who);
        return suspects;
    }
}
```

**`src/test/java/com/example/shop/architecture/TableOwnershipTest.java`**（這一章的改動，`git diff ch08 ch09`）

```diff
diff --git a/src/test/java/com/example/shop/architecture/TableOwnershipTest.java b/src/test/java/com/example/shop/architecture/TableOwnershipTest.java
index e6d8c50..4cf5041 100644
--- a/src/test/java/com/example/shop/architecture/TableOwnershipTest.java
+++ b/src/test/java/com/example/shop/architecture/TableOwnershipTest.java
@@ -18,6 +18,7 @@ class TableOwnershipTest {
             Map.entry("users", "account"), Map.entry("user_roles", "account"), Map.entry("refresh_tokens", "account"),
             Map.entry("products", "catalog"), Map.entry("categories", "catalog"),
             Map.entry("inventory", "inventory"), Map.entry("inventory_reservations", "inventory"), Map.entry("inventory_ledger", "inventory"),
+            Map.entry("inventory_ledger_checkpoints", "inventory"), Map.entry("inventory_ledger_watermark", "inventory"),
             Map.entry("cart_items", "cart"),
             Map.entry("orders", "ordering"), Map.entry("order_items", "ordering"),
             Map.entry("order_status_history", "ordering"), Map.entry("idempotency_keys", "ordering"),
```

#### 部署與設定（9.3～9.5）

**`.gitignore`**

```text
target/
full-test.log

# 9.4：本機覆寫（例如 SHOP_HTTP_PORT），不進 repo
.env
```

**`compose.yaml`**

```yaml
name: shop

services:
  mysql:
    image: mysql:8.0
    environment:
      MYSQL_ROOT_PASSWORD: root
      MYSQL_DATABASE: shop
      MYSQL_USER: shop
      MYSQL_PASSWORD: shop
      TZ: UTC
    command:
      - --character-set-server=utf8mb4
      - --collation-server=utf8mb4_0900_ai_ci
      - --default-time-zone=+00:00
      - --transaction-isolation=REPEATABLE-READ
    ports: ["3306:3306"]
    volumes:
      - mysql-data:/var/lib/mysql
      - ./docker/mysql-init:/docker-entrypoint-initdb.d:ro   # 第 02 章：shop_lab、shop_c2、shop_q6
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1", "-uroot", "-proot"]
      interval: 5s
      timeout: 3s
      retries: 20
      start_period: 20s

  redis:
    image: redis:7.2
    command: ["redis-server", "--appendonly", "yes", "--maxmemory", "256mb", "--maxmemory-policy", "noeviction"]
    ports: ["6379:6379"]
    volumes: [redis-data:/data]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 20

  rabbitmq:
    image: rabbitmq:3.13-management
    hostname: rabbit-shop
    environment:
      RABBITMQ_DEFAULT_USER: shop
      RABBITMQ_DEFAULT_PASS: shop
    ports: ["5672:5672", "15672:15672"]
    volumes: [rabbit-data:/var/lib/rabbitmq]
    healthcheck:
      test: ["CMD", "rabbitmq-diagnostics", "-q", "ping"]
      interval: 10s
      timeout: 5s
      retries: 20
      start_period: 20s

  # ───── 第 09 章：應用程式與監控（docker compose --profile app up -d --wait）─────
  # 預設的 docker compose up 照舊只起上面三個（第 00～08 章：應用程式在 IDE 或 mvn spring-boot:run 裡跑）
  migrate:                          # 9.4：migration 是一個一次性的步驟，跑完才起應用程式；DDL 的帳號只在這裡（INV-5，9.11）
    image: flyway/flyway:9.22.3     # 跟 Boot 3.2.5 管理的 flyway-core 同一個版本
    profiles: [app]
    # list 形式：第一版寫成一個字串，compose 依 shell 的規則切開，URL 裡的 & 被當成命令分隔 ——
    # Flyway 只收到 -url，印出使用說明、結束碼 0，service_completed_successfully 照樣放行了應用程式（9.4）
    command: ["-url=jdbc:mysql://mysql:3306/shop?allowPublicKeyRetrieval=true&useSSL=false", "-user=shop_migrator", "-password=shop_migrator", "-connectRetries=10", "migrate"]
    volumes: [./src/main/resources/db/migration:/flyway/sql:ro]
    depends_on:
      mysql: {condition: service_healthy}

  app:
    build: .
    image: shop:local
    profiles: [app]
    environment:
      SPRING_PROFILES_ACTIVE: prod
      # 本機的值。正式環境的秘密不在 repo 裡（0.6.5），由部署平台注入同樣名字的環境變數
      SHOP_DB_HOST: mysql
      SHOP_DB_USER: shop
      SHOP_DB_PASSWORD: shop
      SHOP_REDIS_HOST: redis
      SHOP_REDIS_PASSWORD: ""
      SHOP_RABBIT_HOST: rabbitmq
      SHOP_RABBIT_USER: shop
      SHOP_RABBIT_PASSWORD: shop
      SHOP_JWT_SECRET: compose-local-only-jwt-secret-0123456789abcdef
      SHOP_PAYMENT_CALLBACK_SECRET: compose-local-only-payment-callback-secret-0123
      SHOP_BOOTSTRAP_ADMIN_EMAIL: admin@example.com
      SHOP_BOOTSTRAP_ADMIN_PASSWORD: compose-local-only-admin-password
    ports: ["${SHOP_HTTP_PORT:-8080}:8080"]   # 8081（actuator）不對外
    healthcheck:
      test: ["CMD", "curl", "-fs", "localhost:8081/actuator/health/readiness"]
      interval: 5s
      timeout: 3s
      retries: 30
      start_period: 20s
    stop_grace_period: 30s          # 9.5：這台機器上容器的預設是 1 秒（Config.StopTimeout=1）—— 不寫的話，關機到一半就被 KILL
    deploy:
      resources:
        limits: {cpus: "4", memory: 1g}   # 9.6：2 顆 CPU 的時候熱點 p99 秒級；記憶體最高 640～670 MiB
    depends_on:
      migrate: {condition: service_completed_successfully}
      redis: {condition: service_healthy}
      rabbitmq: {condition: service_healthy}

  prometheus:
    image: prom/prometheus:v3.5.0
    profiles: [app]
    command: ["--config.file=/etc/prometheus/prometheus.yml", "--storage.tsdb.retention.time=7d"]
    volumes: [./docker/prometheus:/etc/prometheus:ro]
    ports: ["${SHOP_PROMETHEUS_PORT:-9090}:9090"]
    depends_on: [app, alertmanager]

  alertmanager:                     # 9.10.6：沒有它，Prometheus 的告警只會出現在 Prometheus 的網頁上 —— 沒有人會收到
    image: prom/alertmanager:v0.28.1
    profiles: [app]
    volumes: [./docker/alertmanager:/etc/alertmanager:ro]
    ports: ["${SHOP_ALERTMANAGER_PORT:-9093}:9093"]

  alert-sink:                       # 本機用的「收件人」：把 Alertmanager 送來的 webhook 印出來。正式環境換成值班系統、聊天室
    image: python:3.12-alpine
    profiles: [app]
    command: ["python", "/sink/sink.py"]
    volumes: [./docker/alertmanager/sink.py:/sink/sink.py:ro]

  mysqld-exporter:
    image: prom/mysqld-exporter:v0.17.2
    profiles: [app]
    command: ["--mysqld.address=mysql:3306", "--mysqld.username=exporter"]
    environment:
      MYSQLD_EXPORTER_PASSWORD: exporter
    depends_on:
      mysql: {condition: service_healthy}

volumes:
  mysql-data:
  redis-data:
  rabbit-data:
```

**`src/main/resources/application-prod.yml`**

```yaml
spring:
  main:
    banner-mode: off               # 9.7：banner 直接寫 stdout、不經過 Logback —— 「一行一個 JSON」會多出 7 行不是 JSON 的
  flyway:
    enabled: false                 # 9.4：migration 是部署的一個步驟（compose 的 migrate、shop_migrator），不是應用程式啟動的一部分 —— 應用程式不拿 DDL 的帳號
  lifecycle:
    timeout-per-shutdown-phase: 20s   # 9.5：compose 的 stop_grace_period 是 30 秒；要比它短
  datasource:
    url: jdbc:mysql://${SHOP_DB_HOST}:${SHOP_DB_PORT:3306}/${SHOP_DB_NAME:shop}?sslMode=REQUIRED&connectionTimeZone=UTC&rewriteBatchedStatements=true
    username: ${SHOP_DB_USER}
    password: ${SHOP_DB_PASSWORD}
  data:
    redis:
      host: ${SHOP_REDIS_HOST}
      port: ${SHOP_REDIS_PORT:6379}
      password: ${SHOP_REDIS_PASSWORD}
  rabbitmq:
    host: ${SHOP_RABBIT_HOST}
    username: ${SHOP_RABBIT_USER}
    password: ${SHOP_RABBIT_PASSWORD}

shop:
  payment:
    callback-secret: ${SHOP_PAYMENT_CALLBACK_SECRET}
  security:
    jwt-secret: ${SHOP_JWT_SECRET}
    bootstrap-admin:               # 第一次部署時提供；之後可以拿掉（已經有管理員就不會再讀）
      email: ${SHOP_BOOTSTRAP_ADMIN_EMAIL:}
      password: ${SHOP_BOOTSTRAP_ADMIN_PASSWORD:}


springdoc:                         # 9.13：API 文件不對外（第 03 章練習六）—— 上線檢查清單抓到 /v3/api-docs、/swagger-ui.html 在正式設定下是 200
  api-docs:
    enabled: false
  swagger-ui:
    enabled: false

logging:
  config: classpath:logback-json.xml   # 9.7：一行一個 JSON、UTC、traceId

server:
  shutdown: graceful               # 9.5

management:
  server:
    port: 8081                     # 9.9：actuator（health、prometheus）只在這個埠；它不對外，負載平衡器與 Prometheus 從內部網路來
  endpoint:
    health:
      show-details: when-authorized
```

**`src/main/resources/application-local.yml`**

```yaml
spring:
  datasource:
    url: jdbc:mysql://localhost:3306/shop?useSSL=false&allowPublicKeyRetrieval=true&connectionTimeZone=UTC&rewriteBatchedStatements=true
    username: shop
    password: shop
  flyway:                          # 9.11 INV-5：Flyway（DDL、授權）用另一個帳號；應用程式的 shop 只有 shop_app 這個角色
    user: shop_migrator
    password: shop_migrator
  data:
    redis:
      host: localhost
      port: 6379
  rabbitmq:
    host: localhost
    port: 5672
    username: shop
    password: shop

shop:
  payment:
    callback-secret: local-dev-only-payment-callback-secret-0123
  security:
    jwt-secret: local-dev-only-secret-0123456789abcdef
    bootstrap-admin:               # 只在「一個管理員都沒有」時使用（空的資料庫，例如驗收 Q6 的 shop_q6）
      email: admin@example.com
      password: local-dev-only-admin-password

management:
  endpoint:
    health:
      show-details: always
```

**`src/main/resources/application.yml`**（這一章的改動，`git diff ch08 ch09`）

```diff
diff --git a/src/main/resources/application.yml b/src/main/resources/application.yml
index 73749d8..868519e 100644
--- a/src/main/resources/application.yml
+++ b/src/main/resources/application.yml
@@ -39,10 +39,16 @@ shop:
     timeout-scan-interval: 30s
 
 management:
+  metrics:
+    distribution:
+      slo:
+        # 9.9：0.6.2 的門檻當成 histogram 的桶 —— 告警算「超過 500 ms 的比例」，不是估 p99（9.10）
+        # （我原本以為 key 要寫成 "[http.server.requests]"，兩種寫法量過：一樣是這 9 個桶）
+        http.server.requests: 50ms,100ms,150ms,200ms,250ms,300ms,500ms,1s,2s
   endpoints:
     web:
       exposure:
-        include: health,info
+        include: health,info,prometheus   # 9.9：prometheus 只在管理埠上（正式環境的 management.server.port，不對外）
   endpoint:
     health:
       probes:
```

**`src/test/resources/config/application.yml`**（這一章的改動，`git diff ch08 ch09`）

```diff
diff --git a/src/test/resources/config/application.yml b/src/test/resources/config/application.yml
index 4935d09..b4eacdc 100644
--- a/src/test/resources/config/application.yml
+++ b/src/test/resources/config/application.yml
@@ -7,6 +7,15 @@
 server:
   address: 127.0.0.1
 
+# 第 09 章（9.14）：測試會快取每一種設定的 Spring context，每一個都留著自己的連線池。Hikari 預設是固定大小（minimum-idle = 20）——
+# context 多到 8 個左右，MySQL 的 151 條就滿了（Max_used_connections 152、Too many connections）。
+# 測試裡讓閒置的連線 10 秒後收掉、只留 2 條；上限照舊 20（並發的測試量的還是同一個池）。正式環境不改：固定 20 條（0.6.2）
+spring:
+  datasource:
+    hikari:
+      minimum-idle: 2
+      idle-timeout: 10000            # 毫秒：hikari.* 直接綁到 HikariConfig 的 long，寫 10s 是 NumberFormatException（第一版就是這樣，110 個 context 起不來）
+
 shop:
   rate-limit:
     requests-per-ip-per-second: 1000000
```

**`pom.xml`**（這一章的改動，`git diff ch08 ch09`）

```diff
diff --git a/pom.xml b/pom.xml
index 7cb2047..e2d9cff 100644
--- a/pom.xml
+++ b/pom.xml
@@ -26,6 +26,12 @@
   <dependencies>
     <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
     <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-actuator</artifactId></dependency>
+    <!-- 第 09 章（9.8）：traceId。Micrometer Tracing 的 Brave 實作，版本由 Boot 管理；沒有送去任何地方（沒有 Zipkin），只要 traceId 進 MDC -->
+    <dependency><groupId>io.micrometer</groupId><artifactId>micrometer-tracing-bridge-brave</artifactId></dependency>
+    <!-- 9.7：JSON 日誌。Boot 3.2 還沒有內建的結構化日誌（3.4 才有）；這個版本對應 Boot 3.2 的 Logback 1.4 -->
+    <dependency><groupId>net.logstash.logback</groupId><artifactId>logstash-logback-encoder</artifactId><version>7.4</version></dependency>
+    <!-- 9.9：/actuator/prometheus（0.6.6：Micrometer → Prometheus）。版本由 Boot 管理 -->
+    <dependency><groupId>io.micrometer</groupId><artifactId>micrometer-registry-prometheus</artifactId><scope>runtime</scope></dependency>
     <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-jdbc</artifactId></dependency>
     <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-data-redis</artifactId></dependency>
     <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-amqp</artifactId></dependency>
```

**`src/main/java/com/example/shop/shared/config/ShopProperties.java`**

```java
package com.example.shop.shared.config;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import org.hibernate.validator.constraints.time.DurationMax;
import org.hibernate.validator.constraints.time.DurationMin;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.validation.annotation.Validated;

import java.time.Duration;

@Validated
@ConfigurationProperties(prefix = "shop", ignoreUnknownFields = false)
public record ShopProperties(@Valid @NotNull Order order, @Valid @NotNull Security security, @Valid @NotNull Payment payment,
                             @Valid @NotNull @DefaultValue Inventory inventory, @Valid @NotNull @DefaultValue RateLimit rateLimit,
                             @Valid @NotNull @DefaultValue Messaging messaging) {

    /**
     * 第 07 章：Outbox 與消費者（7.4、7.5）。
     * retryDelays：NTF-1 AC-4「重試 5 次（指數退避）後進死信」—— 幾個數字就是幾次重試，每一個是一級 retry 佇列的 TTL。
     */
    public record Messaging(
            @NotNull @DefaultValue("100ms") @DurationMin(millis = 10) Duration relayInterval,
            @DefaultValue("100") @Min(1) int relayBatch,
            @NotNull @DefaultValue("5s") @DurationMin(millis = 100) Duration confirmTimeout,
            /** 9.2.1：送了、broker 沒收下的那一筆，多久之後再試（這段時間裡後面的事件先走） */
            @NotNull @DefaultValue("5s") @DurationMin(millis = 100) Duration relayRetryBackoff,
            /** relay 與消費者各自可以關掉：實驗與驗收 Q9 要「只有寫入、沒有送出」的那一段 */
            @DefaultValue("true") boolean relayEnabled,
            @DefaultValue("true") boolean consumersEnabled,
            @NotNull @DefaultValue({"1s", "2s", "4s", "8s", "16s"}) java.util.List<Duration> retryDelays,
            /** 0.6.7：已送出的 outbox 保留 3 天、processed_messages 保留 7 天 */
            @NotNull @DefaultValue("3d") Duration outboxRetention,
            @NotNull @DefaultValue("7d") Duration processedRetention) {}


    /** 第 06 章：熱點庫存的對帳（0.6.4）。jobsEnabled=false 給需要可重現資料的實驗用（同 order.jobsEnabled） */
    public record Inventory(
            @NotNull @DefaultValue("1m") @DurationMin(seconds = 5) Duration hotReconcileInterval,
            @DefaultValue("true") boolean jobsEnabled,
            /** 第 07 章（7.10）：INV-2、INV-3 的對帳（0.4.6：每小時） */
            @NotNull @DefaultValue("1h") @DurationMin(minutes = 1) Duration invariantCheckInterval) {}

    /** 第 06 章：0.6.5 的三條限流。數字是需求，不是調校參數 —— 改它要改 0.6.5 */
    public record RateLimit(
            @DefaultValue("10") @Min(1) int ordersPerBuyerPerMinute,     // US-ORD-1 AC-8
            @DefaultValue("50") @Min(1) int requestsPerIpPerSecond,      // 0.6.5 全域
            @DefaultValue("true") boolean enabled) {}

    /** US-ORD-3：付款期限 */
    public record Order(
            @NotNull @DurationMin(minutes = 1, message = "付款期限至少 1 分鐘")
            @DurationMax(minutes = 60, message = "付款期限不可超過 60 分鐘（US-ORD-3）") Duration paymentTimeout,
            @NotNull @DurationMin(seconds = 10, message = "逾時掃描間隔至少 10 秒") Duration timeoutScanInterval,
            /** 逾時取消與自動完成的排程（4.7）。實驗需要可重現的資料時關掉它 */
            @DefaultValue("true") boolean jobsEnabled) {}

    /** US-ORD-2 AC-3：金流回呼的 HMAC-SHA256 金鑰 */
    public record Payment(
            @NotBlank @Size(min = 32, message = "金流回呼金鑰至少 32 bytes") String callbackSecret) {}

    /** 0.6.5、US-ACC-2、US-ACC-3（第 05 章） */
    public record Security(
            /** HS256 的金鑰至少 256 bits（0.6.5）。@Size 數的是字元；UTF-8 下 32 個字元至少 32 bytes */
            @NotBlank @Size(min = 32, message = "JWT 金鑰至少 32 bytes（256 bits，0.6.5）") String jwtSecret,
            /** US-ACC-2 AC-1：access token 15 分鐘。它也是 AC-6「停權最遲多久生效」的上限 */
            @NotNull @DefaultValue("15m") @DurationMin(minutes = 1) @DurationMax(minutes = 60, message = "access token 不可超過 60 分鐘（AC-6 的停權空窗）")
            Duration accessTokenTtl,
            /** US-ACC-2 AC-1：refresh token 7 天 */
            @NotNull @DefaultValue("7d") @DurationMin(hours = 1) @DurationMax(days = 30) Duration refreshTokenTtl,
            @Valid @NotNull @DefaultValue Login login,
            @Valid @NotNull @DefaultValue BootstrapAdmin bootstrapAdmin) {}

    /** US-ACC-2 AC-3：15 分鐘內連續失敗 5 次 → 鎖定；0.6.5：每 IP 每分鐘 20 次 */
    public record Login(
            @DefaultValue("5") @Min(1) int maxFailures,
            @NotNull @DefaultValue("15m") @DurationMin(minutes = 1) Duration lockWindow,
            @DefaultValue("20") @Min(1) int perIpPerMinute) {}

    /**
     * US-ACC-3 AC-3：資料庫裡一個管理員都沒有時，用這組帳密建立第一個。沒有預設值 —— 正式環境由環境變數提供。
     * enabled=false 只給 lab profile 用（shop_lab 沒有 Flyway 管理的 users 表）
     */
    public record BootstrapAdmin(@DefaultValue("true") boolean enabled, String email, String password) {}
}
```

**`.github/workflows/ci.yml`**

```yaml
# 第 08 章（8.8）：每一次 push、每一個 PR，都從一台什麼都沒有的機器開始。
# 這台機器上沒有 docker compose、沒有種子資料、沒有任何人的 ~/.m2 —— 測試要的 MySQL、Redis、RabbitMQ 由 Testcontainers 自己起（8.4）。
# mvn verify 包含：單元與整合測試、驗收題、OpenAPI 快照（3.8.2）、ArchUnit（第 01 章）、覆蓋率門檻（8.7.4）。
name: ci

on:
  push:
    branches: [master]
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 20            # 筆電上 3～4 分鐘；超過 20 分鐘多半是某個測試在等一個不會來的東西（7.9.4）
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '21'
          cache: maven             # ~/.m2 的快取：只省下載的時間，不影響測試（每一次的容器都是新的）
      - name: mvn verify
        run: mvn -B -ntp verify
      # 第 09 章（9.10、9.3）：告警規則跟程式碼一起測（promtool），映像檔做得出來。兩步都只要 Docker
      - name: 告警規則（promtool check / test rules）
        run: docker/prometheus/test.sh
      - name: 映像檔
        run: docker build -t shop:ci .
      - name: 測試與覆蓋率報告
        if: always()               # 紅了更要看
        uses: actions/upload-artifact@v4
        with:
          name: reports
          path: |
            target/surefire-reports/
            target/site/jacoco/
            target/q9-child.log
```

#### 日誌、traceId、指標（9.7～9.9）

**`src/main/resources/logback-json.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!--
  第 09 章（9.7）：正式環境的日誌。application-prod.yml 的 logging.config 指到這裡；本機與測試照舊用 Boot 預設的文字格式。
  一行一個 JSON：@timestamp 一律 UTC（0.10.4：「第 09 章會把日誌也統一成 UTC」）、traceId / spanId（9.8）、userId、orderNo（0.6.6）。
  0.6.5：email、JWT 在編碼的最後一步再遮一次 —— 程式碼裡已經用 Email.mask()，這一層是給「某一行忘了遮」的
-->
<configuration>
  <appender name="JSON" class="ch.qos.logback.core.ConsoleAppender">
    <encoder class="net.logstash.logback.encoder.LogstashEncoder">
      <timeZone>UTC</timeZone>
      <customFields>{"service":"shop"}</customFields>
      <fieldNames>
        <version>[ignore]</version>
        <levelValue>[ignore]</levelValue>
      </fieldNames>
      <includeMdcKeyName>traceId</includeMdcKeyName>
      <includeMdcKeyName>spanId</includeMdcKeyName>
      <includeMdcKeyName>userId</includeMdcKeyName>
      <includeMdcKeyName>orderNo</includeMdcKeyName>
      <throwableConverter class="net.logstash.logback.stacktrace.ShortenedThrowableConverter">
        <maxDepthPerThrowable>20</maxDepthPerThrowable>
        <rootCauseFirst>true</rootCauseFirst>
        <exclude>^(org\.springframework\.(web\.filter|security\.web)|org\.apache\.(catalina|coyote|tomcat)|jakarta\.servlet)\.</exclude>
      </throwableConverter>
      <jsonGeneratorDecorator class="net.logstash.logback.mask.MaskingJsonGeneratorDecorator">
        <valueMask>
          <value>([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})</value>
          <mask>$1***@$2</mask>
        </valueMask>
        <valueMask>
          <value>eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}</value>
          <mask>[JWT]</mask>
        </valueMask>
      </jsonGeneratorDecorator>
    </encoder>
  </appender>
  <root level="INFO">
    <appender-ref ref="JSON"/>
  </root>
</configuration>
```

**`src/main/java/com/example/shop/shared/observability/Traces.java`**

```java
package com.example.shop.shared.observability;

import io.micrometer.tracing.Span;
import io.micrometer.tracing.TraceContext;
import io.micrometer.tracing.Tracer;
import org.springframework.stereotype.Component;

import java.util.concurrent.ThreadLocalRandom;
import java.util.function.Supplier;
import java.util.regex.Pattern;

/**
 * 第 09 章（9.8）：HTTP 以外的入口，自己開 trace。
 *
 * HTTP 請求的 traceId 由 Micrometer Tracing 自動放進 MDC（ServerHttpObservationFilter）。下面兩種入口它看不到：
 *   ① 消費者：訊息從 outbox 送出時帶著下單那個請求的 traceId（outbox_events.trace_id → header traceId，7.4），
 *      這裡接在同一個 trace 底下開一個新的 span —— 消費者的日誌、它寫的下一個事件，traceId 都跟原本的請求一樣
 *   ② 排程：付款逾時、自動完成、對帳……沒有請求，每一輪一個新的 trace
 * MDC 的 traceId / spanId 由 Brave 在 withSpan 的時候放、結束的時候拿掉。
 */
@Component
public class Traces {

    /** W3C trace-context：32 個十六進位字元（Brave 的 128 位元）或 16 個（64 位元） */
    private static final Pattern TRACE_ID = Pattern.compile("[0-9a-f]{16}|[0-9a-f]{32}");

    private final Tracer tracer;

    Traces(Tracer tracer) { this.tracer = tracer; }

    /** ① 接著別人的 traceId 做事。traceId 是 null 或格式不對（舊的事件、別的系統送來的）→ 開一個新的 trace */
    public <T> T continueTrace(String traceId, String name, Supplier<T> work) {
        Span span;
        if (traceId != null && TRACE_ID.matcher(traceId).matches()) {
            TraceContext parent = tracer.traceContextBuilder().traceId(traceId)
                    .spanId(String.format("%016x", ThreadLocalRandom.current().nextLong(1, Long.MAX_VALUE))).build();
            span = tracer.spanBuilder().setParent(parent).name(name).start();
        } else {
            span = tracer.nextSpan().name(name).start();
        }
        return inScope(span, work);
    }

    /** ② 排程的一輪：一個新的 trace */
    public void newTrace(String name, Runnable work) {
        inScope(tracer.nextSpan().name(name).start(), () -> { work.run(); return null; });
    }

    private <T> T inScope(Span span, Supplier<T> work) {
        try (Tracer.SpanInScope ignored = tracer.withSpan(span)) {
            return work.get();
        } finally {
            span.end();
        }
    }
}
```

**`src/main/java/com/example/shop/shared/observability/TracedJobs.java`**

```java
package com.example.shop.shared.observability;

import org.springframework.boot.task.ThreadPoolTaskSchedulerBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.Trigger;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.ScheduledFuture;

/**
 * 9.8 排程（付款逾時、自動完成、對帳、outbox 清理、熱點對帳）：每一輪一個新的 trace。
 * 它們都是 SchedulingConfigurer 註冊在 Spring 的那一個 TaskScheduler 上（OrderJobs、InventoryJobs、OutboxMaintenance）——
 * 換掉那一個 scheduler，一個地方就涵蓋全部，以後新加的排程也一樣。
 * 第一版想用 ThreadPoolTaskScheduler.setTaskDecorator：Spring 6.1.6 沒有這個方法（6.2 才有），編譯不過。
 * 改成 Boot 的 builder 設定一個自己的子類別（Boot 只在沒有 TaskScheduler 這個 bean 時才建它自己的）
 */
@Configuration(proxyBeanMethods = false)
class TracedJobs {

    @Bean
    ThreadPoolTaskScheduler taskScheduler(ThreadPoolTaskSchedulerBuilder builder, Traces traces) {
        return builder.configure(new TracingScheduler(traces));
    }

    static class TracingScheduler extends ThreadPoolTaskScheduler {
        private final transient Traces traces;

        TracingScheduler(Traces traces) { this.traces = traces; }

        private Runnable traced(Runnable task) { return () -> traces.newTrace("scheduled", task); }

        @Override public ScheduledFuture<?> schedule(Runnable task, Trigger trigger) { return super.schedule(traced(task), trigger); }
        @Override public ScheduledFuture<?> schedule(Runnable task, Instant startTime) { return super.schedule(traced(task), startTime); }
        @Override public ScheduledFuture<?> scheduleAtFixedRate(Runnable task, Instant startTime, Duration period) { return super.scheduleAtFixedRate(traced(task), startTime, period); }
        @Override public ScheduledFuture<?> scheduleAtFixedRate(Runnable task, Duration period) { return super.scheduleAtFixedRate(traced(task), period); }
        @Override public ScheduledFuture<?> scheduleWithFixedDelay(Runnable task, Instant startTime, Duration delay) { return super.scheduleWithFixedDelay(traced(task), startTime, delay); }
        @Override public ScheduledFuture<?> scheduleWithFixedDelay(Runnable task, Duration delay) { return super.scheduleWithFixedDelay(traced(task), delay); }
    }
}
```

**`src/main/java/com/example/shop/shared/web/TraceFilters.java`**

```java
package com.example.shop.shared.web;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.MDC;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * 第 09 章（9.8）：
 *  ① X-Trace-Id：每一個回應都帶著這個請求的 traceId。使用者回報「出錯了」的時候，客服拿它在日誌裡找那一行（第 03 章練習七的 errorId）。
 *     放在 Micrometer 的 ServerHttpObservationFilter（HIGHEST_PRECEDENCE + 1）之後：那時 MDC 裡已經有 traceId
 *  ② MDC 的 userId：Spring Security 的 filter chain（-100）之後才知道是誰（0.6.6：業務日誌帶 userId）
 */
@Configuration(proxyBeanMethods = false)
class TraceFilters {

    static final String HEADER = "X-Trace-Id";
    /** W3C（traceparent、tracestate）與 B3（單一 header、多個 header）：Boot 3.2 的 Brave 預設全部都收 */
    static final java.util.Set<String> INCOMING = java.util.Set.of("traceparent", "tracestate", "b3",
            "x-b3-traceid", "x-b3-spanid", "x-b3-parentspanid", "x-b3-sampled", "x-b3-flags");

    /**
     * ⓪ 外面帶進來的 trace header 一律不收（9.8）：這個應用程式前面沒有 gateway，traceparent 是網路上任何人都可以寫的。
     * 實測：不擋的話，帶 traceparent: 00-0af7…-…-01 的請求，回應的 X-Trace-Id 就是 0af7…（b3、X-B3-TraceId 也一樣）——
     * 攻擊者可以讓一千個請求共用一個 traceId、或拿別人的 traceId 混淆調查；稽核表的 trace_id 也會是他決定的。
     * 要放在 Micrometer 的 ServerHttpObservationFilter（HIGHEST_PRECEDENCE + 1）之前：它在那裡讀這些 header
     */
    @Bean
    FilterRegistrationBean<OncePerRequestFilter> dropIncomingTraceHeaders() {
        FilterRegistrationBean<OncePerRequestFilter> reg = new FilterRegistrationBean<>(new OncePerRequestFilter() {
            @Override
            protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
                chain.doFilter(new jakarta.servlet.http.HttpServletRequestWrapper(req) {
                    @Override public String getHeader(String name) { return INCOMING.contains(name.toLowerCase(java.util.Locale.ROOT)) ? null : super.getHeader(name); }
                    @Override public java.util.Enumeration<String> getHeaders(String name) {
                        return INCOMING.contains(name.toLowerCase(java.util.Locale.ROOT)) ? java.util.Collections.emptyEnumeration() : super.getHeaders(name);
                    }
                    @Override public java.util.Enumeration<String> getHeaderNames() {
                        return java.util.Collections.enumeration(java.util.Collections.list(super.getHeaderNames()).stream()
                                .filter(h -> !INCOMING.contains(h.toLowerCase(java.util.Locale.ROOT))).toList());
                    }
                }, res);
            }
        });
        reg.setOrder(Ordered.HIGHEST_PRECEDENCE);
        return reg;
    }

    @Bean
    FilterRegistrationBean<OncePerRequestFilter> traceIdHeader() {
        FilterRegistrationBean<OncePerRequestFilter> reg = new FilterRegistrationBean<>(new OncePerRequestFilter() {
            @Override
            protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
                String traceId = MDC.get("traceId");
                if (traceId != null) res.setHeader(HEADER, traceId);        // 在 chain 之前：回應被 commit 之後就加不上去了
                chain.doFilter(req, res);
            }
        });
        reg.setOrder(Ordered.HIGHEST_PRECEDENCE + 2);
        return reg;
    }

    @Bean
    FilterRegistrationBean<OncePerRequestFilter> userIdInMdc() {
        FilterRegistrationBean<OncePerRequestFilter> reg = new FilterRegistrationBean<>(new OncePerRequestFilter() {
            @Override
            protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
                Authentication a = SecurityContextHolder.getContext().getAuthentication();
                if (!(a instanceof JwtAuthenticationToken jwt)) { chain.doFilter(req, res); return; }
                try (MDC.MDCCloseable ignored = MDC.putCloseable("userId", jwt.getName())) {
                    chain.doFilter(req, res);
                }
            }
        });
        reg.setOrder(-99);                                                  // Spring Security 的 filter chain 是 -100
        return reg;
    }
}
```

**`src/main/java/com/example/shop/shared/web/GlobalExceptionHandler.java`**（這一章的改動，`git diff ch08 ch09`）

```diff
diff --git a/src/main/java/com/example/shop/shared/web/GlobalExceptionHandler.java b/src/main/java/com/example/shop/shared/web/GlobalExceptionHandler.java
index 3b8d28c..ff7d916 100644
--- a/src/main/java/com/example/shop/shared/web/GlobalExceptionHandler.java
+++ b/src/main/java/com/example/shop/shared/web/GlobalExceptionHandler.java
@@ -36,6 +36,8 @@ class GlobalExceptionHandler extends ResponseEntityExceptionHandler {
         ProblemDetail pd = ProblemDetail.forStatusAndDetail(type.status(), detail);
         pd.setType(type.type());
         pd.setTitle(type.title());
+        String traceId = org.slf4j.MDC.get("traceId");                    // 9.8：客服拿它在日誌裡找那一行（回應的 X-Trace-Id 也是它）
+        if (traceId != null) pd.setProperty("traceId", traceId);
         return pd;
     }
 
```

**`src/main/java/com/example/shop/shared/security/SecurityConfig.java`**

```java
package com.example.shop.shared.security;

import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.web.ProblemWriter;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtIssuerValidator;
import org.springframework.security.oauth2.jwt.JwtTimestampValidator;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.oauth2.server.resource.InvalidBearerTokenException;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationConverter;
import org.springframework.security.oauth2.server.resource.authentication.JwtGrantedAuthoritiesConverter;
import org.springframework.security.web.AuthenticationEntryPoint;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.access.AccessDeniedHandler;

import java.time.Clock;
import java.time.Duration;

/**
 * 5.5 本專題唯一的 SecurityFilterChain。
 *
 * 三條規則：
 *  ① 0.8 的「路徑前綴 → 角色」表原封不動搬進來（第 03 章在 interceptor，3.4.4）；表上沒有的路徑一律 denyAll（3.3.4 的 fail closed）
 *  ② 401 / 403 也是 Problem Details（5.2.1 B'）
 *  ③ 沒有 session、沒有 CSRF：身分只在 Authorization header 裡，瀏覽器不會自動帶上它（5.5.2）
 */
@Configuration(proxyBeanMethods = false)
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)   // 非 Web 的 context（OrderFlowTest、驗收 Q6）沒有 HttpSecurity
class SecurityConfig {

    /** 5.5.4：預設 60 秒的時鐘誤差會讓「15 分鐘」變成 16 分鐘。簽發與驗證都是同一群機器（NTP 同步），5 秒就夠 */
    static final Duration CLOCK_SKEW = Duration.ofSeconds(5);

    @Bean
    SecurityFilterChain shopSecurity(HttpSecurity http, ProblemWriter problems,
                                     @org.springframework.beans.factory.annotation.Value("${management.server.port:-1}") int managementPort) throws Exception {
        // 9.9：/actuator/prometheus 只在「從管理埠進來」的時候放行。管理埠（正式環境 8081）只在內部網路，Prometheus 從那裡抓。
        // 忘了設 management.server.port（或測試）→ 這條永遠不成立 → 照舊 denyAll（401）：指標不會因為少了一行設定就變成公開的
        org.springframework.security.web.util.matcher.RequestMatcher scrape = req -> managementPort > 0 && req.getLocalPort() == managementPort
                && "GET".equals(req.getMethod()) && "/actuator/prometheus".equals(req.getRequestURI());
        AuthenticationEntryPoint unauthenticated = (req, res, ex) -> {
            boolean badToken = ex instanceof InvalidBearerTokenException;
            res.setHeader("WWW-Authenticate", badToken ? "Bearer error=\"invalid_token\"" : "Bearer");   // RFC 6750：讓客戶端知道該去 refresh
            problems.write(req, res, ProblemType.UNAUTHENTICATED, badToken ? "token 無效或已過期" : "需要登入");
        };
        AccessDeniedHandler forbidden = (req, res, ex) -> problems.write(req, res, ProblemType.FORBIDDEN, "沒有權限");

        http.csrf(AbstractHttpConfigurer::disable)
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .httpBasic(AbstractHttpConfigurer::disable)
            .formLogin(AbstractHttpConfigurer::disable)
            .logout(AbstractHttpConfigurer::disable)
            .requestCache(AbstractHttpConfigurer::disable)
            .authorizeHttpRequests(a -> a
                    // ── 公開（0.8）──
                    .requestMatchers(HttpMethod.POST, "/api/auth/register", "/api/auth/login", "/api/auth/refresh").permitAll()
                    .requestMatchers(HttpMethod.GET, "/api/products", "/api/products/**").permitAll()
                    .requestMatchers(HttpMethod.POST, "/api/payments/callback").permitAll()          // 身分 = HMAC 簽章（US-ORD-2 AC-3）
                    .requestMatchers(HttpMethod.GET, "/api/ping").permitAll()
                    .requestMatchers(HttpMethod.GET, "/actuator/health", "/actuator/health/**", "/actuator/info").permitAll()   // 5.2.1 B：readiness 401
                    .requestMatchers(scrape).permitAll()                                                // 9.9：只有管理埠
                    .requestMatchers(HttpMethod.GET, "/v3/api-docs", "/v3/api-docs/**", "/swagger-ui.html", "/swagger-ui/**").permitAll()
                    .requestMatchers("/error").permitAll()                                           // 5.2.1 B'：不然真正的錯誤會被蓋成 401
                    // ── 依角色（0.8 的前綴；第 03 章的 interceptor 表）──
                    .requestMatchers("/api/seller/**").hasRole("SELLER")
                    .requestMatchers("/api/admin/**").hasRole("ADMIN")
                    .requestMatchers("/api/cart", "/api/cart/**", "/api/orders", "/api/orders/**").hasRole("BUYER")
                    .requestMatchers(HttpMethod.GET, "/api/me").authenticated()
                    // ── 其他：拒絕。新增一支 API 卻忘了加規則 → 403，而不是「意外公開」──
                    .anyRequest().denyAll())
            .oauth2ResourceServer(o -> o
                    .jwt(j -> j.jwtAuthenticationConverter(rolesFromClaim()))
                    .authenticationEntryPoint(unauthenticated)
                    .accessDeniedHandler(forbidden))
            .exceptionHandling(e -> e.authenticationEntryPoint(unauthenticated).accessDeniedHandler(forbidden));
        return http.build();
    }

    @Bean
    JwtDecoder jwtDecoder(ShopProperties props, Clock clock) {
        NimbusJwtDecoder decoder = NimbusJwtDecoder.withSecretKey(AccessTokens.key(props)).macAlgorithm(MacAlgorithm.HS256).build();
        JwtTimestampValidator expiry = new JwtTimestampValidator(CLOCK_SKEW);
        expiry.setClock(clock);
        decoder.setJwtValidator(new DelegatingOAuth2TokenValidator<>(expiry, new JwtIssuerValidator(AccessTokens.ISSUER)));
        return decoder;
    }

    /** roles: ["BUYER","SELLER"] → ROLE_BUYER、ROLE_SELLER（hasRole 會自己加 ROLE_ 前綴） */
    static JwtAuthenticationConverter rolesFromClaim() {
        JwtGrantedAuthoritiesConverter roles = new JwtGrantedAuthoritiesConverter();
        roles.setAuthoritiesClaimName(AccessTokens.ROLES);
        roles.setAuthorityPrefix("ROLE_");
        JwtAuthenticationConverter c = new JwtAuthenticationConverter();
        c.setJwtGrantedAuthoritiesConverter(roles);
        return c;
    }
}
```

**`src/main/java/com/example/shop/shared/messaging/internal/RabbitConsumers.java`**（這一章的改動，`git diff ch08 ch09`）

```diff
diff --git a/src/main/java/com/example/shop/shared/messaging/internal/RabbitConsumers.java b/src/main/java/com/example/shop/shared/messaging/internal/RabbitConsumers.java
index 957af1d..f197062 100644
--- a/src/main/java/com/example/shop/shared/messaging/internal/RabbitConsumers.java
+++ b/src/main/java/com/example/shop/shared/messaging/internal/RabbitConsumers.java
@@ -60,11 +60,12 @@ class RabbitConsumers implements SmartLifecycle {
     private final Duration confirmTimeout;
     private final Clock clock;
     private final MeterRegistry meters;
+    private final com.example.shop.shared.observability.Traces traces;
     private final List<SimpleMessageListenerContainer> containers = new CopyOnWriteArrayList<>();
     private volatile Thread starter;
 
     RabbitConsumers(List<EventHandler> handlers, ConnectionFactory cf, RabbitTemplate rabbit, EventDispatcher dispatcher,
-                    ObjectMapper json, ShopProperties props, Clock clock, MeterRegistry meters) {
+                    ObjectMapper json, ShopProperties props, Clock clock, MeterRegistry meters, com.example.shop.shared.observability.Traces traces) {
         this.handlers = handlers;
         this.cf = cf;
         this.rabbit = rabbit;
@@ -74,9 +75,33 @@ class RabbitConsumers implements SmartLifecycle {
         this.confirmTimeout = props.messaging().confirmTimeout();
         this.clock = clock;
         this.meters = meters;
+        this.traces = traces;
+        // 9.10：每一個消費者的延遲在啟動時就有一條序列（ShopConsumerLag）—— 不然在第一則訊息之前，「這個消費者」在 Prometheus 裡不存在
+        for (EventHandler h : handlers) lag(h);
     }
 
+    private Timer lag(EventHandler h) {
+        return Timer.builder("shop.events.lag").tag("consumer", h.consumer()).description("事件從 commit 到處理完，經過多久（0.6.4）")
+                .publishPercentiles(0.5, 0.99).register(meters);
+    }
+
+    /**
+     * 9.8：接著下單那個請求的 traceId 處理（relay 把 outbox_events.trace_id 放在 header traceId，7.4）。
+     * 第 07 章到第 08 章，header 一直都在，但沒有人讀它 —— 消費者的每一行日誌都沒有 traceId（驗收 Q7 的第 ③ 段）
+     */
     void onMessage(EventHandler h, Message m, Channel ch) throws IOException {
+        Object traceId = m.getMessageProperties().getHeaders().get("traceId");
+        try {
+            traces.continueTrace(traceId == null ? null : traceId.toString(), "consume " + h.consumer(), () -> {
+                try { handle(h, m, ch); } catch (IOException e) { throw new java.io.UncheckedIOException(e); }
+                return null;
+            });
+        } catch (java.io.UncheckedIOException e) {
+            throw e.getCause();
+        }
+    }
+
+    private void handle(EventHandler h, Message m, Channel ch) throws IOException {
         long tag = m.getMessageProperties().getDeliveryTag();
         Event e;
         try {
@@ -86,6 +111,14 @@ class RabbitConsumers implements SmartLifecycle {
             settle(ch, tag, () -> deadLetter(h, m, 1, bad));
             return;
         }
+        String orderNo = e.payload() != null && e.payload().hasNonNull("orderNo") ? e.payload().get("orderNo").asText() : null;
+        try (org.slf4j.MDC.MDCCloseable ignored = orderNo == null ? null : org.slf4j.MDC.putCloseable("orderNo", orderNo)) {
+            dispatch(h, m, ch, e);
+        }
+    }
+
+    private void dispatch(EventHandler h, Message m, Channel ch, Event e) throws IOException {
+        long tag = m.getMessageProperties().getDeliveryTag();
         if (!h.eventTypes().contains(e.type())) {
             // 7.5.3：拓撲出錯（第一版的重試把訊息送回了每一個佇列）時的最後一道防線 —— 不要讓一個路由的 bug 變成一個業務動作
             // （ordering.stock-shortage 收到 order.placed，就會把一張好好的訂單取消掉）。正確的佇列有它自己的那一份
@@ -96,8 +129,7 @@ class RabbitConsumers implements SmartLifecycle {
         }
         try {
             if (dispatcher.dispatch(h, e) == EventDispatcher.Outcome.PROCESSED)
-                Timer.builder("shop.events.lag").tag("consumer", h.consumer()).description("事件從 commit 到處理完，經過多久（0.6.4）")
-                        .publishPercentiles(0.5, 0.99).register(meters).record(Duration.between(e.occurredAt(), clock.instant()));
+                lag(h).record(Duration.between(e.occurredAt(), clock.instant()));
             ch.basicAck(tag, false);
         } catch (Exception ex) {
             if (e.attempt() <= delays.size()) {
```

**`src/main/java/com/example/shop/ordering/internal/PlaceOrderService.java`**（這一章的改動，`git diff ch08 ch09`）

```diff
diff --git a/src/main/java/com/example/shop/ordering/internal/PlaceOrderService.java b/src/main/java/com/example/shop/ordering/internal/PlaceOrderService.java
index 32e7b18..7acb075 100644
--- a/src/main/java/com/example/shop/ordering/internal/PlaceOrderService.java
+++ b/src/main/java/com/example/shop/ordering/internal/PlaceOrderService.java
@@ -37,6 +37,8 @@ import java.util.*;
 @Service
 class PlaceOrderService implements OrderingApi {
 
+    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(PlaceOrderService.class);
+
     static final int MAX_LINES = 50;
     static final int ORDER_NO_ATTEMPTS = 3;
 
@@ -52,7 +54,8 @@ class PlaceOrderService implements OrderingApi {
     private final Duration paymentTimeout;
 
     PlaceOrderService(CatalogApi catalog, InventoryApi inventory, CartApi cart, OrderRepository orders, OrderHistory history,
-                      IdempotencyKeys keys, Outbox outbox, PlatformTransactionManager tm, Clock clock, ShopProperties props) {
+                      IdempotencyKeys keys, Outbox outbox, PlatformTransactionManager tm, Clock clock, ShopProperties props,
+                      io.micrometer.core.instrument.MeterRegistry meters) {
         this.catalog = catalog;
         this.inventory = inventory;
         this.cart = cart;
@@ -63,21 +66,41 @@ class PlaceOrderService implements OrderingApi {
         this.tx = new TransactionTemplate(tm);
         this.clock = clock;
         this.paymentTimeout = props.order().paymentTimeout();
+        this.placed = meters.counter("shop.orders.placed");
+        this.insufficient = meters.counter("shop.inventory.insufficient");
+        this.collisions = meters.counter("shop.orders.number_collisions");
     }
 
+    private final io.micrometer.core.instrument.Counter placed, insufficient, collisions;
+
     /**
      * 6.5.2 熱點商品的品項先過 Redis 的閘門 —— 在冪等鍵與下單交易「之前」：搶不到的人（2,000 人裡的 1,500 人）完全不碰 MySQL。
      * 閘門過了之後，任何一條失敗的路徑都要把減掉的加回去（6.2.4：漏了一條 = 少賣）。
      */
     @Override
     public PlacedOrder placeOrder(long buyerId, String idempotencyKey, List<OrderLine> lines) {
+        try {
+            return placeOrderGated(buyerId, idempotencyKey, lines);
+        } catch (InsufficientStockException e) {
+            // 9.9：0.6.6「依 productId 前 N 名」。productId 不當指標的 tag（J7：1 萬個商品 = 1 萬條序列、每次 scrape 600 KB），寫進日誌，前 N 名從日誌查
+            insufficient.increment();
+            log.info("INSUFFICIENT_STOCK productId={} buyerId={}", e.productId(), buyerId);
+            throw e;
+        }
+    }
+
+    private PlacedOrder placeOrderGated(long buyerId, String idempotencyKey, List<OrderLine> lines) {
         validate(lines);
         Set<Long> hotIds = catalog.hotProducts(lines.stream().map(OrderLine::productId).toList());
         List<ReserveLine> hot = lines.stream().filter(l -> hotIds.contains(l.productId()))
                 .map(l -> new ReserveLine(l.productId(), l.quantity())).toList();
         inventory.gateHot(hot);                                             // 不夠 → 409；Redis 不能用 → 503
         try {
-            return placeGated(buyerId, idempotencyKey, lines, hot);
+            PlacedOrder placed = placeGated(buyerId, idempotencyKey, lines, hot);
+            // 9.8：第一版成功的下單一行日誌都沒有 —— 出事的時候，「這張訂單是哪一個請求建的」只能從 traceId 往回找
+            if (!placed.replayed()) this.placed.increment();
+            if (!placed.replayed()) log.info("ORDER_PLACED orderNo={} buyerId={} lines={} hot={}", placed.orderNo(), buyerId, lines.size(), hot.size());
+            return placed;
         } catch (InsufficientStockException e) {
             // Redis 說有、MySQL 說沒有：Redis 的數字偏高了（6.5.3）。那一個品項不加回去 —— 剛剛減掉的那一件本來就不存在
             inventory.returnHot(hot.stream().filter(l -> l.productId() != e.productId()).toList());
@@ -104,6 +127,7 @@ class PlaceOrderService implements OrderingApi {
                 } catch (DataIntegrityViolationException e) {
                     // 2.4.4：訂單編號撞號（一天約 12 次）。整個交易已經 rollback，換一個號碼重來
                     if (attempt >= ORDER_NO_ATTEMPTS || !ConstraintViolations.isViolationOf(e, "uk_orders_order_no")) throw e;
+                    collisions.increment();                                 // 9.10：4.4.4「日誌照實記錄，另外用指標數撞號次數」—— 那一行 ERROR 不拿來告警
                 }
             }
         } catch (RuntimeException e) {
```

**`src/main/java/com/example/shop/ordering/internal/OrderTransitionService.java`**（這一章的改動，`git diff ch08 ch09`）

```diff
diff --git a/src/main/java/com/example/shop/ordering/internal/OrderTransitionService.java b/src/main/java/com/example/shop/ordering/internal/OrderTransitionService.java
index 6084cce..0dead12 100644
--- a/src/main/java/com/example/shop/ordering/internal/OrderTransitionService.java
+++ b/src/main/java/com/example/shop/ordering/internal/OrderTransitionService.java
@@ -47,14 +47,17 @@ class OrderTransitionService {
     private final OrderHistory history;
     private final Outbox outbox;
     private final Clock clock;
+    private final io.micrometer.core.instrument.MeterRegistry meters;
 
-    OrderTransitionService(JdbcTemplate jdbc, InventoryApi inventory, PaymentApi payments, OrderHistory history, Outbox outbox, Clock clock) {
+    OrderTransitionService(JdbcTemplate jdbc, InventoryApi inventory, PaymentApi payments, OrderHistory history, Outbox outbox, Clock clock,
+                           io.micrometer.core.instrument.MeterRegistry meters) {
         this.jdbc = jdbc;
         this.inventory = inventory;
         this.payments = payments;
         this.history = history;
         this.outbox = outbox;
         this.clock = clock;
+        this.meters = meters;
     }
 
     @Transactional
@@ -84,15 +87,27 @@ class OrderTransitionService {
                         boolean refunded = sideEffects(orderId, cur, d, event);
                         history.record(orderId, cur.status(), d.to(), event.name(), actor, now);
                         publish(orderId, cur, d.to(), event, data, refunded);
+                        if (d.to() == OrderStatus.CANCELLED) afterCommit(() -> meters.counter("shop.orders.cancelled", "reason", cancelReason(event, data)).increment());
                         return d.to();
                     }
                     // 0 列：在我們讀取之後、更新之前，別人改了狀態（排程 vs 回呼，4.2.5）。重讀、重新決定
+                    // 9.9：0.6.6 的 shop.orders.state_conflict（0.5.5 的條件式更新影響 0 列的次數）
+                    meters.counter("shop.orders.state_conflict", "from", cur.status().name(), "event", event.name()).increment();
                 }
             }
         }
         throw new ShopException(ProblemType.INVALID_STATE, "訂單狀態正在變動，請稍後再試");
     }
 
+    /** 9.9：commit 之後才算（回滾的取消不算）。0.6.6：逾時取消率異常上升 = 金流出問題 */
+    private static void afterCommit(Runnable r) {
+        if (!org.springframework.transaction.support.TransactionSynchronizationManager.isSynchronizationActive()) { r.run(); return; }
+        org.springframework.transaction.support.TransactionSynchronizationManager.registerSynchronization(
+                new org.springframework.transaction.support.TransactionSynchronization() {
+                    @Override public void afterCommit() { r.run(); }
+                });
+    }
+
     Current current(long orderId) { return read(orderId, ""); }
 
     private Current currentForUpdate(long orderId) { return read(orderId, " FOR UPDATE"); }
```

**`src/main/java/com/example/shop/ordering/internal/OrderJobs.java`**（這一章的改動，`git diff ch08 ch09`）

```diff
diff --git a/src/main/java/com/example/shop/ordering/internal/OrderJobs.java b/src/main/java/com/example/shop/ordering/internal/OrderJobs.java
index 276c8d5..7e8727e 100644
--- a/src/main/java/com/example/shop/ordering/internal/OrderJobs.java
+++ b/src/main/java/com/example/shop/ordering/internal/OrderJobs.java
@@ -46,6 +46,7 @@ class OrderJobs implements SchedulingConfigurer {
     public void configureTasks(ScheduledTaskRegistrar registrar) {
         registrar.addFixedDelayTask(this::cancelExpired, interval);
         registrar.addFixedDelayTask(this::autoComplete, interval);
+        registrar.addFixedDelayTask(new org.springframework.scheduling.config.FixedDelayTask(this::purgeIdempotencyKeys, Duration.ofHours(1), Duration.ofMinutes(10)));
     }
 
     /** 走 idx_orders_status_deadline（2.7.2：covering index range scan） */
@@ -56,6 +57,17 @@ class OrderJobs implements SchedulingConfigurer {
         return applyEach(ids, OrderEvent.PAYMENT_TIMEOUT);
     }
 
+    /** 9.11 0.6.7：冪等鍵保留 24 小時（expires_at，US-ORD-1a AC-6）。一次 1,000 列，刪到沒有為止（7.4.4） */
+    int purgeIdempotencyKeys() {
+        int total = 0, n;
+        do {
+            n = jdbc.update("DELETE FROM idempotency_keys WHERE expires_at < ? ORDER BY expires_at LIMIT 1000", Timestamp.from(clock.instant()));
+            total += n;
+        } while (n == 1000);
+        if (total > 0) log.info("IDEMPOTENCY_KEYS_PURGED {} 列", total);
+        return total;
+    }
+
     int autoComplete() {
         List<Long> ids = jdbc.queryForList("""
                 SELECT id FROM orders WHERE status = 'SHIPPED' AND shipped_at < ?
```

**`src/main/java/com/example/shop/payment/internal/JdbcPaymentService.java`**（這一章的改動，`git diff ch08 ch09`）

```diff
diff --git a/src/main/java/com/example/shop/payment/internal/JdbcPaymentService.java b/src/main/java/com/example/shop/payment/internal/JdbcPaymentService.java
index eb27ff3..4cbc1b8 100644
--- a/src/main/java/com/example/shop/payment/internal/JdbcPaymentService.java
+++ b/src/main/java/com/example/shop/payment/internal/JdbcPaymentService.java
@@ -36,7 +36,12 @@ class JdbcPaymentService implements PaymentApi {
     private final AuditLog audit;
     private final Outbox outbox;
 
-    JdbcPaymentService(JdbcTemplate jdbc, ShopProperties props, AuditLog audit, Outbox outbox) {
+    private final io.micrometer.core.instrument.MeterRegistry meters;
+
+    JdbcPaymentService(JdbcTemplate jdbc, ShopProperties props, AuditLog audit, Outbox outbox, io.micrometer.core.instrument.MeterRegistry meters) {
+        this.meters = meters;
+        // 9.10：先註冊成 0。第一次發生才註冊的話，序列一出現就是 1，increase() 算不出來 —— 「任何一次就告警」的第一次不會響（promtool ④）
+        for (String reason : java.util.List.of("signature", "amount")) meters.counter("shop.payment.callback.rejected", "reason", reason);
         this.jdbc = jdbc;
         this.secret = props.payment().callbackSecret();
         this.audit = audit;
@@ -65,6 +70,7 @@ class JdbcPaymentService implements PaymentApi {
         String expected = CallbackSignature.sign(secret, CallbackSignature.canonical(cb.paymentId(), cb.providerTxnId(), cb.amount(), cb.succeeded()));
         if (!CallbackSignature.matches(expected, cb.signature())) {
             log.warn("PAYMENT_SIGNATURE_INVALID paymentId={}", cb.paymentId());
+            meters.counter("shop.payment.callback.rejected", "reason", "signature").increment();   // 9.10：0.6.6「任何一次就告警」
             // 接下來的 401 會讓回呼的交易 rollback：稽核要在自己的交易裡（5.2.5）
             audit.recordRejection(AuditEntry.of(AuditAction.PAYMENT_SIGNATURE_INVALID, null, "PAYMENT_PROVIDER", "PAYMENT", cb.paymentId(),
                     Map.of("providerTxnId", cb.providerTxnId())));
@@ -77,6 +83,7 @@ class JdbcPaymentService implements PaymentApi {
         long orderId = ((Number) p.get("order_id")).longValue();
         if (((BigDecimal) p.get("amount")).compareTo(cb.amount()) != 0) {
             log.error("PAYMENT_AMOUNT_MISMATCH paymentId={} expected={} actual={}", cb.paymentId(), p.get("amount"), cb.amount());   // AC-4：告警
+            meters.counter("shop.payment.callback.rejected", "reason", "amount").increment();
             audit.recordRejection(AuditEntry.of(AuditAction.PAYMENT_AMOUNT_MISMATCH, null, "PAYMENT_PROVIDER", "PAYMENT", cb.paymentId(),
                     Map.of("expected", p.get("amount"), "actual", cb.amount(), "providerTxnId", cb.providerTxnId())));
             throw new ShopException(ProblemType.VALIDATION, "金額與付款不符");
```

#### relay（9.2.1）

**`src/main/java/com/example/shop/shared/events/internal/OutboxStore.java`**

```java
package com.example.shop.shared.events.internal;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.Collections;
import java.util.List;

/**
 * 7.4.2 outbox_events 的讀取端：給 relay 用（relay 在 shared.messaging，它負責 broker；這裡只負責 SQL）。
 * 換一個 broker，這個類別不用改（驗收 Q11）。
 */
@Component
public class OutboxStore {

    public record Row(long id, String eventId, String aggregateType, long aggregateId, String eventType, String payload,
                      Instant createdAt, String traceId) {}

    public record Backlog(long pending, double oldestAgeSeconds) {}

    private final JdbcTemplate jdbc;

    OutboxStore(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    /**
     * 7.9.2 認領還沒送出、也沒有人認領（或租約過期）的事件，蓋上租約，在呼叫端的交易裡（短交易，claim 完就 commit）。
     * 第一版是「claim、送出、等 confirm、標記」全部在同一個交易裡：broker 卡住（docker pause）時，relay 在交易裡等 broker，
     * 它的 FOR UPDATE 擋住了每一張訂單的 outbox INSERT —— 那些訂單手上還拿著 inventory 的列鎖 —— 連線池被用光、整站 503（7.9.2）。
     * 現在：認領（短交易）→ 送出（沒有交易、沒有鎖）→ 標記（短交易）。
     * 呼叫端用 READ COMMITTED：FOR UPDATE 只鎖住找到的那幾列，不鎖間隙（REPEATABLE READ 的間隙鎖會擋住新的 INSERT，H5b 量到過）。
     * SKIP LOCKED：另一台機器正在認領的那幾列直接跳過（11-messaging/02 的 2.5）。
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public List<Row> claim(int batch, java.time.Duration lease) {
        List<Row> rows = jdbc.query("""
                SELECT id, event_id, aggregate_type, aggregate_id, event_type, payload, created_at, trace_id
                  FROM outbox_events
                 WHERE published_at IS NULL AND (claimed_until IS NULL OR claimed_until < CURRENT_TIMESTAMP(3))
                 ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED""",
                (rs, i) -> new Row(rs.getLong(1), rs.getString(2), rs.getString(3), rs.getLong(4), rs.getString(5),
                        rs.getString(6), rs.getTimestamp(7).toInstant(), rs.getString(8)), batch);
        if (rows.isEmpty()) return rows;
        String in = String.join(",", Collections.nCopies(rows.size(), "?"));
        List<Object> args = new java.util.ArrayList<>();
        args.add(lease.toMillis() * 1000);
        rows.forEach(r -> args.add(r.id()));
        jdbc.update("UPDATE outbox_events SET claimed_until = CURRENT_TIMESTAMP(3) + INTERVAL ? MICROSECOND WHERE id IN (" + in + ")", args.toArray());
        return rows;
    }

    /** 送不出去的那幾列：放掉租約，下一輪就可以再認領（不用等租約過期） */
    @Transactional(propagation = Propagation.MANDATORY)
    public void release(List<Long> ids) {
        if (ids.isEmpty()) return;
        String in = String.join(",", Collections.nCopies(ids.size(), "?"));
        jdbc.update("UPDATE outbox_events SET claimed_until = NULL WHERE published_at IS NULL AND id IN (" + in + ")", ids.toArray());
    }

    /**
     * 9.2.1 這幾筆送了、但 broker 沒有收下（nack、退回、等不到 confirm）：租約延長到 backoff 之後，這段時間裡認領會跳過它們，後面的事件先走。
     * 第一版是 release（馬上放回去）—— 認領是 ORDER BY id LIMIT 100，最前面有 100 筆永遠送不出去的，relay 就永遠在送同樣那 100 筆
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public void retryLater(List<Long> ids, java.time.Duration backoff) {
        if (ids.isEmpty()) return;
        String in = String.join(",", Collections.nCopies(ids.size(), "?"));
        List<Object> args = new java.util.ArrayList<>();
        args.add(backoff.toMillis() * 1000);
        args.addAll(ids);
        jdbc.update("UPDATE outbox_events SET claimed_until = CURRENT_TIMESTAMP(3) + INTERVAL ? MICROSECOND WHERE published_at IS NULL AND id IN (" + in + ")", args.toArray());
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public void markPublished(List<Long> ids) {
        if (ids.isEmpty()) return;
        String in = String.join(",", Collections.nCopies(ids.size(), "?"));
        jdbc.update("UPDATE outbox_events SET published_at = CURRENT_TIMESTAMP(3) WHERE id IN (" + in + ")", ids.toArray());
    }

    /** 0.6.6 的 shop.outbox.pending、shop.outbox.oldest_age_seconds（告警：> 60 秒） */
    public Backlog backlog() {
        return jdbc.queryForObject("""
                SELECT COUNT(*), COALESCE(TIMESTAMPDIFF(MICROSECOND, MIN(created_at), CURRENT_TIMESTAMP(3)), 0) / 1e6
                  FROM outbox_events WHERE published_at IS NULL""",
                (rs, i) -> new Backlog(rs.getLong(1), rs.getDouble(2)));
    }

    /** 0.6.7：已送出的保留 3 天。一次刪一批，避免一句 DELETE 鎖住一大段（11-messaging/02 的 2.6.2） */
    public int deletePublishedBefore(Instant before, int limit) {
        return jdbc.update("DELETE FROM outbox_events WHERE published_at < ? ORDER BY published_at LIMIT ?",
                Timestamp.from(before), limit);
    }

    /** 0.6.7：processed_messages 保留 7 天 */
    public int deleteProcessedBefore(Instant before, int limit) {
        return jdbc.update("DELETE FROM processed_messages WHERE processed_at < ? ORDER BY processed_at LIMIT ?",
                Timestamp.from(before), limit);
    }
}
```

**`src/main/java/com/example/shop/shared/messaging/internal/RabbitOutboxRelay.java`**

```java
package com.example.shop.shared.messaging.internal;

import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.events.internal.OutboxStore;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.core.MessageDeliveryMode;
import org.springframework.amqp.core.MessageProperties;
import org.springframework.amqp.rabbit.connection.CorrelationData;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.concurrent.*;

/**
 * 7.4.2 relay：把 outbox_events 裡還沒送出的事件送到 RabbitMQ。每 100 ms 一輪，一輪最多 100 筆，滿了就馬上再一輪。
 *
 * 一輪（7.9.2 之後的版本）：
 *   ① 認領：短交易，SELECT … FOR UPDATE SKIP LOCKED（READ COMMITTED），蓋租約，COMMIT
 *   ② 每一筆 send（mandatory）—— 沒有交易、沒有鎖
 *   ③ 等 publisher confirm，而且沒有被退回（return）
 *   ④ 短交易：確認了的標成已送出，其他的放掉租約
 * 第一版是 ①～④ 同一個交易：broker 卡住的時候，那個交易跟著卡住，它的鎖讓整站 503（7.9.2）。
 *
 * 保證是 at-least-once，不是 exactly-once：② 送出、broker 也收到了，③ 之前行程死掉 → 重啟之後再送一次（7.2.2 實測）。
 * 「只送一次」的那一半，是消費端的事（EventDispatcher）。
 */
@Component
@ConditionalOnProperty(name = "shop.messaging.relay-enabled", havingValue = "true", matchIfMissing = true)
class RabbitOutboxRelay implements SmartLifecycle {

    private static final Logger log = LoggerFactory.getLogger(RabbitOutboxRelay.class);

    private final OutboxStore store;
    private final RabbitTemplate rabbit;
    /** 認領與標記用的短交易：READ COMMITTED（7.9.2：不要間隙鎖） */
    private final TransactionTemplate claimTx;
    /** 認領的租約：送出加上等 confirm 的上限的幾倍。過期還沒送出 → 別人（或下一輪）可以再認領 */
    private final Duration lease;
    private final ObjectMapper json;
    private final ShopProperties.Messaging props;
    private final Clock clock;
    private final Counter published, failures;
    private final Timer delay;
    /** 9.2.1：這個應用程式裡有人訂閱的事件類型（每一個 EventHandler 的 eventTypes()）。拓撲也是從同一份清單宣告的（RabbitTopology） */
    private final java.util.Set<String> subscribed;
    private final MeterRegistry meters;
    private final java.util.Set<String> warnedUnsubscribed = ConcurrentHashMap.newKeySet();
    private ScheduledExecutorService exec;
    private volatile boolean failing;

    RabbitOutboxRelay(OutboxStore store, RabbitTemplate rabbit, PlatformTransactionManager tm, ObjectMapper json,
                      ShopProperties props, Clock clock, MeterRegistry meters, List<com.example.shop.shared.events.EventHandler> handlers) {
        this.store = store;
        this.rabbit = rabbit;
        this.claimTx = new TransactionTemplate(tm);
        this.claimTx.setIsolationLevel(org.springframework.transaction.TransactionDefinition.ISOLATION_READ_COMMITTED);
        this.lease = props.messaging().confirmTimeout().multipliedBy(6);
        this.json = json;
        this.props = props.messaging();
        this.clock = clock;
        this.published = Counter.builder("shop.outbox.published").description("relay 送出、broker 確認的事件數").register(meters);
        this.failures = Counter.builder("shop.outbox.publish_failures").description("relay 送出失敗（broker 連不上、卡住）的次數").register(meters);
        this.delay = Timer.builder("shop.outbox.publish_delay").description("事件從 commit 到 broker 確認，經過多久")
                .publishPercentiles(0.5, 0.99).register(meters);
        this.subscribed = handlers.stream().flatMap(h -> h.eventTypes().stream()).collect(java.util.stream.Collectors.toUnmodifiableSet());
        this.meters = meters;
        // 9.10：先註冊成 0（promtool ④：第一次發生才註冊的計數器，告警的第一次不會響）
        for (String reason : List.of("nack", "unroutable", "confirm_timeout", "confirm_failed"))
            Counter.builder("shop.outbox.rejected").tag("reason", reason).description("relay 送出、broker 沒有收下的次數（9.2.1）").register(meters);
    }

    /**
     * 一輪。回傳這一輪確認了幾筆。
     * 7.9.2：三段，只有第一段與第三段有交易，而且都是短的。**送出與等 confirm 的時候，手上沒有任何資料庫的連線與鎖。**
     */
    int relayOnce() {
        List<OutboxStore.Row> rows = claimTx.execute(s -> store.claim(props.relayBatch(), lease));      // ① 認領：短交易、READ COMMITTED
        if (rows == null || rows.isEmpty()) return 0;
        List<Long> confirmed = new ArrayList<>(rows.size()), failed = new ArrayList<>(), rejected = new ArrayList<>();
        // 9.2.1：沒有任何消費者訂閱的類型（例如 order.completed，7.3.1「目前沒有人」）不送 —— 送了也只會被退回。
        // 第一版把「退回」一律當成失敗、馬上放回去重送：完成的訂單一多，relay 就永遠卡在最前面那 100 筆上
        List<OutboxStore.Row> toSend = new ArrayList<>(rows.size());
        for (OutboxStore.Row r : rows) {
            if (subscribed.contains(r.eventType())) { toSend.add(r); continue; }
            confirmed.add(r.id());
            Counter.builder("shop.outbox.unsubscribed").tag("type", r.eventType()).description("沒有人訂閱、所以沒有送出的事件（9.2.1）").register(meters).increment();
            if (warnedUnsubscribed.add(r.eventType()))
                log.warn("OUTBOX_UNSUBSCRIBED type={}：這個應用程式裡沒有消費者訂閱它，標成已送出、不送（每一種只記這一次）", r.eventType());
        }
        List<CorrelationData> sent = new ArrayList<>(toSend.size());
        try {
            for (OutboxStore.Row r : toSend) {                                                        // ② 送出（沒有交易）
                CorrelationData cd = new CorrelationData(r.eventId());
                rabbit.send(RabbitTopology.EVENTS, r.eventType(), message(r), cd);
                sent.add(cd);
            }
        } catch (RuntimeException e) {
            for (int i = sent.size(); i < toSend.size(); i++) failed.add(toSend.get(i).id());          // 沒送出去的：馬上放回去
            failures.increment();
            if (sent.isEmpty()) {
                claimTx.executeWithoutResult(s -> { store.markPublished(confirmed); store.release(failed); });
                throw e;
            }
        }
        long deadline = System.nanoTime() + props.confirmTimeout().toNanos();
        for (int i = 0; i < sent.size(); i++) {                                                      // ③ 一筆一筆等 confirm
            CorrelationData cd = sent.get(i);
            OutboxStore.Row r = toSend.get(i);
            try {
                CorrelationData.Confirm c = cd.getFuture().get(Math.max(0, deadline - System.nanoTime()), TimeUnit.NANOSECONDS);
                if (!c.isAck()) { log.warn("OUTBOX_NACK eventId={} type={} reason={}", r.eventId(), r.eventType(), c.getReason()); reject(rejected, r, "nack"); }
                else if (cd.getReturned() != null) {                                                  // 有人訂閱、卻沒有佇列收下：拓撲壞了（不是「沒有人要」）
                    log.error("OUTBOX_UNROUTABLE eventId={} type={}：有消費者訂閱這個類型，但沒有佇列綁定它", r.eventId(), r.eventType());
                    reject(rejected, r, "unroutable");
                } else {
                    confirmed.add(r.id());
                    delay.record(Duration.between(r.createdAt(), clock.instant()));
                }
            } catch (TimeoutException e) {
                log.warn("OUTBOX_CONFIRM_TIMEOUT eventId={}（{} 內沒有收到 confirm；下一輪再送 —— broker 可能其實收到了，會重複）",
                        r.eventId(), props.confirmTimeout());
                reject(rejected, r, "confirm_timeout");
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException(e);
            } catch (ExecutionException e) {
                log.warn("OUTBOX_CONFIRM_FAILED eventId={}：{}", r.eventId(), e.getCause().toString());
                reject(rejected, r, "confirm_failed");
            }
        }
        claimTx.executeWithoutResult(s -> {                                                          // ④ 標記：短交易
            store.markPublished(confirmed);
            store.release(failed);
            store.retryLater(rejected, props.relayRetryBackoff());                                  // 9.2.1：晚一點再試，後面的先走
        });
        published.increment(confirmed.size() - (rows.size() - toSend.size()));   // 沒有送的（沒有人訂閱）不算「送出」
        return confirmed.size();
    }

    Message message(OutboxStore.Row r) {
        ObjectNode env = json.createObjectNode();
        env.put("eventId", r.eventId());
        env.put("type", r.eventType());
        env.put("aggregateType", r.aggregateType());
        env.put("aggregateId", r.aggregateId());
        env.put("occurredAt", r.createdAt().toString());
        try {
            env.set("payload", json.readTree(r.payload()));
        } catch (Exception e) {
            throw new IllegalStateException("outbox 第 " + r.id() + " 列的 payload 不是 JSON", e);
        }
        MessageProperties p = new MessageProperties();
        p.setMessageId(r.eventId());
        p.setType(r.eventType());
        p.setContentType(MessageProperties.CONTENT_TYPE_JSON);
        p.setContentEncoding("UTF-8");
        p.setDeliveryMode(MessageDeliveryMode.PERSISTENT);
        p.setTimestamp(Date.from(r.createdAt()));
        if (r.traceId() != null) p.setHeader("traceId", r.traceId());
        return new Message(env.toString().getBytes(StandardCharsets.UTF_8), p);
    }

    /** 9.2.1：送了、broker 沒收下。reason=unroutable 代表拓撲壞了（有人訂閱、卻沒有佇列綁定）—— 9.10 的告警 */
    private void reject(List<Long> rejected, OutboxStore.Row r, String reason) {
        rejected.add(r.id());
        Counter.builder("shop.outbox.rejected").tag("reason", reason).description("relay 送出、broker 沒有收下的次數（9.2.1）").register(meters).increment();
    }

    private void loop() {
        try {
            int n;
            do { n = relayOnce(); } while (n == props.relayBatch());
            if (failing) {
                failing = false;
                log.info("OUTBOX_RELAY_RECOVERED 恢復送出");
            }
        } catch (RuntimeException e) {
            failures.increment();
            if (!failing) {                                                 // 狀態改變時記一次：broker 停 60 秒，不要每 100 ms 一行
                failing = true;
                log.warn("OUTBOX_RELAY_FAILING 送不出去，事件會留在 outbox_events 裡，恢復之後補送：{}", e.toString());
            }
        }
    }

    @Override
    public void start() {
        exec = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "outbox-relay");
            t.setDaemon(true);
            return t;
        });
        exec.scheduleWithFixedDelay(this::loop, 0, props.relayInterval().toMillis(), TimeUnit.MILLISECONDS);
    }

    @Override
    public void stop() {
        if (exec == null) return;
        exec.shutdown();
        try { exec.awaitTermination(props.confirmTimeout().toMillis() + 1000, TimeUnit.MILLISECONDS); }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        exec = null;
    }

    @Override
    public boolean isRunning() { return exec != null; }

    /** 比消費者晚啟動、早停止：消費者先準備好（宣告佇列），relay 才開始送 */
    @Override
    public int getPhase() { return Integer.MAX_VALUE - 100; }
}
```

#### 增量對帳（9.12）

**`src/main/java/com/example/shop/inventory/internal/InventoryReconciliation.java`**

```java
package com.example.shop.inventory.internal;

import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 7.10 0.4.6 的 INV-2、INV-3：CHECK 寫不出來的不變量，用對帳 SQL 檢查（2.5.4 寫好、InvariantReconciliationTest 用過的同一組）。
 * 每小時一次（0.4.6）；差異不是 0 → ERROR 日誌 + 指標 shop.reconciliation.diff{check=…}，第 09 章接告警。
 *
 * 加一個第 07 章才有的：熱點預留「還沒計入」放了多久（0.6.4：庫存帳落帳，最終一致，60 秒）。
 * 它不算錯（落帳本來就在 commit 之後），但放太久代表 relay 或 inventory.hot-settlement 卡住了。
 */
@Component
class InventoryReconciliation {

    private static final Logger log = LoggerFactory.getLogger(InventoryReconciliation.class);

    static final Map<String, String> CHECKS = new LinkedHashMap<>();
    static {
        CHECKS.put("INV-2", """
                SELECT COUNT(*) FROM inventory i
                  LEFT JOIN (SELECT product_id, SUM(quantity) AS q FROM inventory_reservations
                              WHERE status IN ('HELD', 'CONFIRMED') AND counted GROUP BY product_id) r ON r.product_id = i.product_id
                 WHERE i.reserved <> COALESCE(r.q, 0)""");
        // 9.12 J11d：IGNORE INDEX —— 不加的話，MySQL 依 idx_ledger_product 的順序加總（省掉暫存表），可是那個索引沒有 delta_on_hand，
        // 每一列都回主鍵讀一次：shop（60 萬列）1,369 ms → 154 ms；2,000 萬列 130 秒 → 5.6 秒
        CHECKS.put("INV-3", """
                SELECT COUNT(*) FROM inventory i
                  LEFT JOIN (SELECT product_id, SUM(delta_on_hand) AS s FROM inventory_ledger IGNORE INDEX (idx_ledger_product)
                              GROUP BY product_id) l ON l.product_id = i.product_id
                 WHERE i.on_hand <> COALESCE(l.s, 0)""");
        // 8.7：2.5.5 的對帳 SQL 有這一條（reserved 的第二個獨立驗證：跟帳比），第 07 章搬進排程時漏了 ——
        // InvariantReconciliationTest 一直在檢查它，排程從來沒有。測試現在直接呼叫這個類別，不再自己留一份 SQL
        CHECKS.put("INV-3'", """
                SELECT COUNT(*) FROM inventory i
                  LEFT JOIN (SELECT product_id, SUM(delta_reserved) AS s FROM inventory_ledger IGNORE INDEX (idx_ledger_product)
                              GROUP BY product_id) l ON l.product_id = i.product_id
                 WHERE i.reserved <> COALESCE(l.s, 0)""");
    }

    /**
     * 9.12 INV-3 與 INV-3' 的增量版：快照裡的庫存，跟「累計（水位線以前）＋ 水位線之後的帳」比。
     * 只掃 id > 水位線的那一段（主鍵的範圍掃描）、inventory 與累計各 1 萬列 —— 跟帳本多大無關
     */
    static final String INCREMENTAL = """
            SELECT COALESCE(SUM(i.on_hand <> COALESCE(c.sum_on_hand, 0) + COALESCE(d.s, 0)), 0),
                   COALESCE(SUM(i.reserved <> COALESCE(c.sum_reserved, 0) + COALESCE(d.r, 0)), 0)
              FROM inventory i
              LEFT JOIN inventory_ledger_checkpoints c ON c.product_id = i.product_id
              LEFT JOIN (SELECT product_id, SUM(delta_on_hand) AS s, SUM(delta_reserved) AS r
                           FROM inventory_ledger WHERE id > ? GROUP BY product_id) d ON d.product_id = i.product_id""";

    /**
     * 9.12 水位線只前進到「夠舊」的帳。一個交易可能先插了帳、再等別的鎖（innodb_lock_wait_timeout 50 秒）才 commit ——
     * 它手上那一列的 id，可能比已經 commit 的更小。水位線越過它，它 commit 之後就永遠不會被加進累計：一個永遠存在的假差異（J11b）
     */
    static final java.time.Duration SAFE_MARGIN = java.time.Duration.ofMinutes(5);

    private final JdbcTemplate jdbc;
    private final org.springframework.transaction.support.TransactionTemplate snapshot;
    private final Map<String, Long> diffs = new ConcurrentHashMap<>();
    private volatile double uncountedOldestSeconds;
    private volatile long uncounted;

    InventoryReconciliation(JdbcTemplate jdbc, MeterRegistry meters, org.springframework.transaction.PlatformTransactionManager tm) {
        this.jdbc = jdbc;
        this.snapshot = new org.springframework.transaction.support.TransactionTemplate(tm);
        this.snapshot.setIsolationLevel(org.springframework.transaction.TransactionDefinition.ISOLATION_REPEATABLE_READ);   // 庫存與帳在同一個快照
        for (String check : CHECKS.keySet()) {
            diffs.put(check, 0L);
            Gauge.builder("shop.reconciliation.diff", () -> diffs.get(check)).tag("check", check)
                    .description("對帳差異（商品數）：不是 0 就要有人看").register(meters);
        }
        Gauge.builder("shop.inventory.uncounted", () -> uncounted).description("還沒計入 reserved 的熱點預留（7.6）").register(meters);
        Gauge.builder("shop.inventory.uncounted_oldest_age_seconds", () -> uncountedOldestSeconds)
                .description("最舊的未計入熱點預留放了幾秒（0.6.4：> 60 告警）").register(meters);
    }

    /** 每小時：INV-2 全掃（它是狀態表，不是只增不減的帳）；INV-3、INV-3' 增量（9.12） */
    Map<String, Long> checkInvariants() { return checkIncremental(SAFE_MARGIN); }

    Map<String, Long> checkIncremental(java.time.Duration margin) {
        Map<String, Long> out = new LinkedHashMap<>();
        out.put("INV-2", jdbc.queryForObject(CHECKS.get("INV-2"), Long.class));
        snapshot.executeWithoutResult(s -> {
            // FOR UPDATE：兩台機器同一時間跑，第二台在這裡等（不會把同一段帳加兩次）。鎖定讀不建立快照，下一句才建立
            long w = jdbc.queryForObject("SELECT upto_id FROM inventory_ledger_watermark WHERE id = 1 FOR UPDATE", Long.class);
            jdbc.query(INCREMENTAL, rs -> { out.put("INV-3", rs.getLong(1)); out.put("INV-3'", rs.getLong(2)); }, w);
            long cutoff = jdbc.queryForObject("SELECT COALESCE(MAX(id), ?) FROM inventory_ledger WHERE id > ? AND created_at < NOW(3) - INTERVAL ? MICROSECOND",
                    Long.class, w, w, margin.toNanos() / 1000);
            if (cutoff > w) {
                fold(jdbc.query("SELECT product_id, SUM(delta_on_hand), SUM(delta_reserved) FROM inventory_ledger WHERE id > ? AND id <= ? GROUP BY product_id",
                        (rs, i) -> new Object[]{rs.getLong(1), rs.getLong(2), rs.getLong(3)}, w, cutoff));
                jdbc.update("UPDATE inventory_ledger_watermark SET upto_id = ? WHERE id = 1", cutoff);
            }
        });
        publish(out);
        return out;
    }

    /**
     * 每週：INV-3、INV-3' 全掃一次（7.10 的那兩句）。都是 0 → 用同一個快照重建累計與水位線：
     * 增量的累計萬一漂移了（例如有人用別的帳號改了帳），會在這一步被拉回來
     */
    Map<String, Long> checkFullAndRebaseline() {
        Map<String, Long> out = new LinkedHashMap<>();
        snapshot.executeWithoutResult(s -> {
            jdbc.queryForObject("SELECT upto_id FROM inventory_ledger_watermark WHERE id = 1 FOR UPDATE", Long.class);
            CHECKS.forEach((name, sql) -> out.put(name, jdbc.queryForObject(sql, Long.class)));
            if (out.values().stream().allMatch(d -> d == 0)) {
                long cutoff = jdbc.queryForObject("SELECT COALESCE(MAX(id), 0) FROM inventory_ledger WHERE created_at < NOW(3) - INTERVAL ? MICROSECOND",
                        Long.class, SAFE_MARGIN.toNanos() / 1000);
                List<Object[]> sums = jdbc.query("""
                        SELECT product_id, SUM(delta_on_hand), SUM(delta_reserved) FROM inventory_ledger IGNORE INDEX (idx_ledger_product)
                         WHERE id <= ? GROUP BY product_id""", (rs, i) -> new Object[]{rs.getLong(1), rs.getLong(2), rs.getLong(3)}, cutoff);
                jdbc.update("DELETE FROM inventory_ledger_checkpoints");
                fold(sums);
                jdbc.update("UPDATE inventory_ledger_watermark SET upto_id = ? WHERE id = 1", cutoff);
            }
        });
        publish(out);
        return out;
    }

    /**
     * 9.12 J11e：加總用快照讀（上面的 SELECT），寫入在這裡 —— 第一版是一句 INSERT … SELECT：那是「鎖定讀」，
     * 它會等還沒 commit 的那一列（正確），可是拿到鎖之後、commit 之前，新的帳一筆都寫不進去（S4 等了 3.0 秒）。
     * 快照讀不拿 inventory_ledger 的任何鎖；代價是看不到還沒 commit 的那幾列 —— 所以水位線要留 SAFE_MARGIN
     */
    private void fold(List<Object[]> sums) {
        jdbc.batchUpdate("""
                INSERT INTO inventory_ledger_checkpoints (product_id, sum_on_hand, sum_reserved) VALUES (?, ?, ?)
                ON DUPLICATE KEY UPDATE sum_on_hand = sum_on_hand + VALUES(sum_on_hand), sum_reserved = sum_reserved + VALUES(sum_reserved)""", sums);
    }

    private void publish(Map<String, Long> out) {
        out.forEach((name, diff) -> {
            diffs.put(name, diff);
            if (diff != 0) log.error("RECONCILIATION_DIFF {}：{} 個商品對不上（0.4.6）", name, diff);
        });
    }

    /** 每 30 秒：未計入的熱點預留 */
    void checkUncounted() {
        jdbc.query("""
                SELECT COUNT(*), COALESCE(TIMESTAMPDIFF(MICROSECOND, MIN(created_at), CURRENT_TIMESTAMP(3)), 0) / 1e6
                  FROM inventory_reservations WHERE counted = FALSE AND status IN ('HELD', 'CONFIRMED')""", rs -> {
            uncounted = rs.getLong(1);
            uncountedOldestSeconds = rs.getDouble(2);
        });
        if (uncountedOldestSeconds > 60) log.warn("HOT_SETTLEMENT_LAGGING {} 筆熱點預留還沒計入，最舊的已經 {} 秒（0.6.4：60 秒）", uncounted, (long) uncountedOldestSeconds);
    }
}
```

**`src/main/java/com/example/shop/inventory/internal/InventoryJobs.java`**

```java
package com.example.shop.inventory.internal;

import com.example.shop.shared.config.ShopProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.SchedulingConfigurer;
import org.springframework.scheduling.config.ScheduledTaskRegistrar;

/**
 * 6.6 熱點庫存的對帳排程（0.6.4：Redis 預扣 ⇄ MySQL，對帳差異必須為 0）。
 * 多台機器同時跑不需要分散式鎖（4.7.2 的同一個理由）：每一個 key 的修正都是 CAS，兩台同時改，只有一台會成功。
 */
@Configuration(proxyBeanMethods = false)
@EnableScheduling
@ConditionalOnProperty(name = "shop.inventory.jobs-enabled", havingValue = "true", matchIfMissing = true)
class InventoryJobs implements SchedulingConfigurer {

    private static final Logger log = LoggerFactory.getLogger(InventoryJobs.class);

    private final HotStock hot;
    private final InventoryReconciliation reconciliation;
    private final ShopProperties props;

    InventoryJobs(HotStock hot, InventoryReconciliation reconciliation, ShopProperties props) {
        this.hot = hot;
        this.reconciliation = reconciliation;
        this.props = props;
    }

    @Override
    public void configureTasks(ScheduledTaskRegistrar registrar) {
        registrar.addFixedDelayTask(() -> {
            int fixed = hot.reconcile();
            if (fixed > 0) log.warn("熱點庫存對帳：修正了 {} 個商品", fixed);
        }, props.inventory().hotReconcileInterval());
        // 7.10：不在啟動的那一刻跑（對帳要掃整張 inventory_ledger，不要跟啟動搶資源）—— 第一次在一個間隔之後
        var every = props.inventory().invariantCheckInterval();
        registrar.addFixedDelayTask(new org.springframework.scheduling.config.FixedDelayTask(reconciliation::checkInvariants, every, every));
        var week = java.time.Duration.ofDays(7);                           // 9.12：增量的累計每週用全掃校正一次
        registrar.addFixedDelayTask(new org.springframework.scheduling.config.FixedDelayTask(reconciliation::checkFullAndRebaseline, week, week));
        var thirty = java.time.Duration.ofSeconds(30);
        registrar.addFixedDelayTask(new org.springframework.scheduling.config.FixedDelayTask(reconciliation::checkUncounted, thirty, thirty));
    }
}
```

#### Prometheus、告警、Alertmanager（9.10）

**`docker/prometheus/prometheus.yml`**

```yaml
# 第 09 章（9.10）：compose 的 app profile 裡的 Prometheus
global:
  scrape_interval: 15s
  evaluation_interval: 15s
rule_files: [alerts.yml]
alerting:
  alertmanagers: [{static_configs: [{targets: ["alertmanager:9093"]}]}]
scrape_configs:
  - job_name: shop
    metrics_path: /actuator/prometheus
    static_configs: [{targets: ["app:8081"]}]        # 管理埠（9.9）：只有從這裡進來才放行
  - job_name: rabbitmq
    metrics_path: /metrics/detailed                    # 每一個佇列一條（/metrics 只有加總，9.9）
    params: {family: [queue_coarse_metrics]}
    static_configs: [{targets: ["rabbitmq:15692"]}]
  - job_name: mysql
    static_configs: [{targets: ["mysqld-exporter:9104"]}]
```

**`docker/prometheus/alerts.yml`**

```yaml
# 第 09 章（9.10）：告警規則。0.6.6 的七條，加上各章留給第 09 章的那幾個數字。
# 每一條的 annotations.why 寫「為什麼是這個門檻、從哪一章來」；門檻是判斷的，寫明是判斷。
# promtool test rules alerts_test.yml 會跑這些規則（docker/prometheus/test.sh）
groups:
  - name: shop-slo                      # 0.6.6 的前兩條：使用者感受得到的
    rules:
      - alert: ShopHigh5xxRatio
        # 9.10 J8d：只看 5 分鐘窗的話，一次 60 秒的停機在恢復之後 4 分多鐘才響、響半分鐘自己好 —— 加一個 1 分鐘窗：現在還在發生才響
        expr: |
          (sum(rate(http_server_requests_seconds_count{job="shop",status=~"5.."}[5m]))
             / sum(rate(http_server_requests_seconds_count{job="shop"}[5m])) > 0.01)
          and
          (sum(rate(http_server_requests_seconds_count{job="shop",status=~"5.."}[1m]))
             / sum(rate(http_server_requests_seconds_count{job="shop"}[1m])) > 0.01)
        for: 5m
        labels: {severity: page}
        annotations:
          summary: "5xx 超過 1%（{{ $value | humanizePercentage }}），持續 5 分鐘"
          why: "0.6.6。Redis 掛了的時候熱點下單照設計回 503（0.6.3），這條也會響 —— 那是一次事故，該響"
      - alert: ShopPlaceOrderSlow
        # p99 > 500 ms ⇔ 超過 500 ms 的請求 > 1%。用 SLO 的桶算比例，不估 p99（application.yml 的 slo）
        # 9.10 J8d：第一版只有 5 分鐘窗 —— Redis 停 60 秒，恢復之後 4 分 23 秒才 firing、31 秒後自己解除。加 1 分鐘窗
        expr: |
          ((
            sum(rate(http_server_requests_seconds_count{job="shop",uri="/api/orders",method="POST"}[5m]))
            - sum(rate(http_server_requests_seconds_bucket{job="shop",uri="/api/orders",method="POST",le="0.5"}[5m]))
          ) / sum(rate(http_server_requests_seconds_count{job="shop",uri="/api/orders",method="POST"}[5m])) > 0.01)
          and
          ((
            sum(rate(http_server_requests_seconds_count{job="shop",uri="/api/orders",method="POST"}[1m]))
            - sum(rate(http_server_requests_seconds_bucket{job="shop",uri="/api/orders",method="POST",le="0.5"}[1m]))
          ) / sum(rate(http_server_requests_seconds_count{job="shop",uri="/api/orders",method="POST"}[1m])) > 0.01)
        for: 5m
        labels: {severity: page}
        annotations:
          summary: "下單超過 500 ms 的比例 {{ $value | humanizePercentage }}（> 1% = p99 > 500 ms），持續 5 分鐘"
          why: "0.6.6、0.6.2（熱點下單 p99 500 ms）"

  - name: shop-flow                     # 事件流：0.6.4 的「最終一致」有多久
    rules:
      - alert: ShopOutboxBacklog
        expr: max(shop_outbox_oldest_age_seconds{job="shop"}) > 60
        labels: {severity: page}
        annotations:
          summary: "最舊的未送出事件已經 {{ $value | humanizeDuration }}"
          why: "0.6.6、0.6.4（落帳、通知 60 秒）。9.2.1 那一種（relay 被卡住）就是靠它看見的"
      - alert: ShopOutboxUnroutable
        expr: sum(increase(shop_outbox_rejected_total{job="shop",reason="unroutable"}[5m])) > 0
        labels: {severity: page}
        annotations:
          summary: "有人訂閱的事件被 broker 退回：拓撲壞了"
          why: "9.2.1。沒有人訂閱的類型不送（shop_outbox_unsubscribed_total），這裡只剩「綁定不見了」"
      - alert: ShopConsumerLag
        expr: max by (consumer) (shop_events_lag_seconds{job="shop",quantile="0.99"}) > 60
        for: 1m
        labels: {severity: page}
        annotations:
          summary: "{{ $labels.consumer }} 的事件 p99 延遲 {{ $value | humanizeDuration }}"
          why: "0.6.4：落帳、通知 60 秒。⚠️ 消費者完全停住時沒有新的樣本，這個數字會掉回 0 —— 要跟下一條一起看（9.10.5）"
      - alert: ShopConsumerQueueBacklog
        expr: max by (queue) (rabbitmq_detailed_queue_messages_ready{queue=~"shop\\.[a-z-]+\\.[a-z-]+"}) > 1000
        for: 5m
        labels: {severity: page}
        annotations:
          summary: "{{ $labels.queue }} 積了 {{ $value }} 則"
          why: "消費者停住時，延遲（上一條）看不到，佇列深度看得到。1000 / 5 分鐘是判斷：一次搶購 500 張落帳、幾秒內消化完"
      - alert: ShopDeadLetters
        expr: max by (queue) (rabbitmq_detailed_queue_messages{queue=~"shop\\..+\\.dlq"}) > 0
        labels: {severity: ticket}
        annotations:
          summary: "{{ $labels.queue }} 有 {{ $value }} 則死信"
          why: "0.6.6：每一則死信都要有人看（7.5.5 的重放）"
      - alert: ShopUncountedReservationsOld
        expr: max(shop_inventory_uncounted_oldest_age_seconds{job="shop"}) > 60
        labels: {severity: page}
        annotations:
          summary: "熱點預留 {{ $value | humanizeDuration }} 還沒落帳"
          why: "7.10：0.6.4 的 60 秒"
      - alert: ShopRefundFailed
        expr: sum(increase(shop_refunds_failed_total{job="shop"}[15m])) > 0
        labels: {severity: page}
        annotations:
          summary: "退款重試用完仍然失敗"
          why: "0.5.4、7.8.1：錢要退，要有人處理"

  - name: shop-integrity                # 數字不對：每一個都應該永遠是 0
    rules:
      - alert: ShopReconciliationDiff
        expr: max by (check) (shop_reconciliation_diff{job="shop"}) > 0
        labels: {severity: page}
        annotations:
          summary: "對帳 {{ $labels.check }} 差 {{ $value }} 筆"
          why: "0.6.6、7.10；8.7.3 證明它會變成 1"
      - alert: ShopHotStockShortage
        expr: sum(increase(shop_inventory_hot_shortage_total{job="shop"}[15m])) > 0
        labels: {severity: page}
        annotations:
          summary: "熱點商品：回了 201、落帳時才發現不夠"
          why: "7.6.3：有人被答應了又反悔"
      - alert: ShopHotStockDrift
        expr: sum(increase(shop_inventory_hot_drift_total{job="shop"}[15m])) > 0
        labels: {severity: ticket}
        annotations:
          summary: "熱點對帳修正了 Redis 與 MySQL 的差異"
          why: "6.6：正常的系統這個計數器永遠是 0"
      - alert: ShopAuditDropped
        expr: sum(increase(shop_audit_dropped_total{job="shop"}[5m])) > 0
        labels: {severity: page}
        annotations:
          summary: "有稽核沒有寫進 audit_logs"
          why: "5.9.2：佇列滿了丟掉的稽核"

  - name: shop-security
    rules:
      - alert: ShopPaymentCallbackRejected
        expr: sum by (reason) (increase(shop_payment_callback_rejected_total{job="shop"}[5m])) > 0
        labels: {severity: page}
        annotations:
          summary: "付款回呼被拒絕（{{ $labels.reason }}）"
          why: "0.6.6：簽章錯誤任何一次就告警（可能是攻擊）；US-ORD-2 AC-4 金額不符"
      - alert: ShopAccessDeniedSuspects
        expr: max(shop_audit_denied_suspects{job="shop"}) > 0
        labels: {severity: page}
        annotations:
          summary: "{{ $value }} 位使用者過去一小時越權超過 50 次（是誰：日誌的 AUDIT_DENIED_SUSPECTS）"
          why: "US-ORD-5 AC-4；5.8.4：時間窗一小時"
      - alert: ShopLoginLockoutDegraded
        expr: sum(increase(shop_login_lockout_degraded_total{job="shop"}[5m])) > 0
        labels: {severity: page}
        annotations:
          summary: "Redis 不能用：登入失敗鎖定暫停中（fail-open）"
          why: "0.6.3、5.6.4：暴力破解在這段時間不會被擋"

  - name: shop-dependencies
    rules:
      - alert: ShopDown
        expr: up{job="shop"} == 0
        for: 1m
        labels: {severity: page}
        annotations:
          summary: "Prometheus 抓不到 {{ $labels.instance }}"
          why: "連指標都抓不到"
      - alert: ShopRedisDegraded
        expr: sum(increase(shop_redis_trips_total{job="shop"}[5m])) > 0
        labels: {severity: warning}
        annotations:
          summary: "RedisGuard 跳開過：熱點下單 503、排行降級"
          why: "6.4.5、8.6.5、9.6（J4b 的 ratelimit 逾時）"
      - alert: ShopMysqlRowLockWaits
        expr: rate(mysql_global_status_innodb_row_lock_waits[5m]) > 10
        for: 10m
        labels: {severity: warning}
        annotations:
          summary: "MySQL 列鎖等待每秒 {{ $value | humanize }} 次，持續 10 分鐘"
          why: "2.2.3、0.6.6。一次搶購約每秒 95 次、只有 10 秒；平常接近 0。「5 分鐘平均每秒 > 10、持續 10 分鐘」是判斷"
```

**`docker/prometheus/alerts_test.yml`**

```yaml
# 9.10：告警規則的單元測試。docker/prometheus/test.sh（promtool test rules）
rule_files: [alerts.yml]
evaluation_interval: 15s
tests:
  # ① 5xx 2%：for 5m —— 4 分鐘時還沒響，6 分鐘時響了
  - interval: 15s
    input_series:
      - series: 'http_server_requests_seconds_count{job="shop",status="200",uri="/api/products/{id}"}'
        values: '0+980x60'
      - series: 'http_server_requests_seconds_count{job="shop",status="503",uri="/api/orders"}'
        values: '0+20x60'
    alert_rule_test:
      - {eval_time: 4m, alertname: ShopHigh5xxRatio, exp_alerts: []}
      - eval_time: 6m
        alertname: ShopHigh5xxRatio
        exp_alerts:
          - exp_labels: {severity: page}
            exp_annotations:
              summary: "5xx 超過 1%（2%），持續 5 分鐘"
              why: "0.6.6。Redis 掛了的時候熱點下單照設計回 503（0.6.3），這條也會響 —— 那是一次事故，該響"
  # ② 下單：每 15 秒 100 個，其中 2 個超過 500 ms（2% > 1%）
  - interval: 15s
    input_series:
      - series: 'http_server_requests_seconds_count{job="shop",uri="/api/orders",method="POST",status="201"}'
        values: '0+100x60'
      - series: 'http_server_requests_seconds_bucket{job="shop",uri="/api/orders",method="POST",status="201",le="0.5"}'
        values: '0+98x60'
    alert_rule_test:
      - eval_time: 6m
        alertname: ShopPlaceOrderSlow
        exp_alerts:
          - exp_labels: {severity: page}
            exp_annotations: {summary: "下單超過 500 ms 的比例 2%（> 1% = p99 > 500 ms），持續 5 分鐘", why: "0.6.6、0.6.2（熱點下單 p99 500 ms）"}
  # ②' 只有 0.5% 超過：不響
  - interval: 15s
    input_series:
      - series: 'http_server_requests_seconds_count{job="shop",uri="/api/orders",method="POST",status="201"}'
        values: '0+200x60'
      - series: 'http_server_requests_seconds_bucket{job="shop",uri="/api/orders",method="POST",status="201",le="0.5"}'
        values: '0+199x60'
    alert_rule_test:
      - {eval_time: 10m, alertname: ShopPlaceOrderSlow, exp_alerts: []}
  # ②'' J8d 的形狀：前 2 分鐘正常，接著 1 分鐘 10% 很慢（Redis 停了），之後恢復。只有 5 分鐘窗的第一版：恢復之後 4 分多鐘才 firing。
  #     加了 1 分鐘窗：恢復之後 1 分鐘內就不成立，pending 等不到 5 分鐘 —— 不響
  - interval: 15s
    input_series:
      - series: 'http_server_requests_seconds_count{job="shop",uri="/api/orders",method="POST",status="201"}'
        values: '0+75x40'
      - series: 'http_server_requests_seconds_bucket{job="shop",uri="/api/orders",method="POST",status="201",le="0.5"}'
        values: '0+75x8 600+67x4 868+75x28'
    alert_rule_test:
      - {eval_time: 7m30s, alertname: ShopPlaceOrderSlow, exp_alerts: []}
      - {eval_time: 9m, alertname: ShopPlaceOrderSlow, exp_alerts: []}
  # ③ outbox：最舊的事件 45 秒 → 不響；75 秒 → 響（沒有 for）
  - interval: 15s
    input_series:
      - series: 'shop_outbox_oldest_age_seconds{job="shop"}'
        values: '0 15 30 45 60 75'
    alert_rule_test:
      - {eval_time: 45s, alertname: ShopOutboxBacklog, exp_alerts: []}
      - eval_time: 75s
        alertname: ShopOutboxBacklog
        exp_alerts:
          - exp_labels: {severity: page}
            exp_annotations: {summary: "最舊的未送出事件已經 1m 15s", why: "0.6.6、0.6.4（落帳、通知 60 秒）。9.2.1 那一種（relay 被卡住）就是靠它看見的"}
  # ④ ⚠️ 陷阱（這一個測試描述的是「不會響」）：計數器在第一次發生時才註冊 —— 序列一出現就是 1，
  #    increase() 沒有前一個點可以比，算出來是 0。「任何一次就告警」的第一次永遠不會響。所以計數器要在啟動時先註冊成 0（④'）
  - interval: 15s
    input_series:
      - series: 'shop_payment_callback_rejected_total{job="shop",reason="signature"}'
        values: '_ _ _ _ 1 1 1 1 1 1'
    alert_rule_test:
      - {eval_time: 90s, alertname: ShopPaymentCallbackRejected, exp_alerts: []}
  # ④' 同一件事，計數器在啟動時就先註冊成 0
  - interval: 15s
    input_series:
      - series: 'shop_payment_callback_rejected_total{job="shop",reason="signature"}'
        values: '0 0 0 0 1 1 1 1 1 1'
    alert_rule_test:
      - eval_time: 90s
        alertname: ShopPaymentCallbackRejected
        exp_alerts:
          - exp_labels: {severity: page, reason: signature}
            exp_annotations: {summary: "付款回呼被拒絕（signature）", why: "0.6.6：簽章錯誤任何一次就告警（可能是攻擊）；US-ORD-2 AC-4 金額不符"}
```

**`docker/prometheus/test.sh`**（`chmod +x`）

```bash
#!/usr/bin/env bash
# 9.10：檢查與測試告警規則（只要 Docker）
cd "$(dirname "$0")"
docker run --rm -v "$PWD":/rules -w /rules --entrypoint promtool prom/prometheus:v3.5.0 check rules alerts.yml && \
docker run --rm -v "$PWD":/rules -w /rules --entrypoint promtool prom/prometheus:v3.5.0 test rules alerts_test.yml
```

**`docker/alertmanager/alertmanager.yml`**

```yaml
# 第 09 章（9.10.6）：告警送到哪裡。本機只有一個收件人（alert-sink，印出來）；正式環境依 severity 分：page → 值班、ticket → 工單、warning → 聊天室
route:
  receiver: local-sink
  group_by: [alertname]
  group_wait: 10s          # 預設 30 秒：同一組的告警先等這麼久、湊在一起送（J8f 量的是這一段加上 Prometheus 自己的延遲）
  group_interval: 1m
  repeat_interval: 4h
receivers:
  - name: local-sink
    webhook_configs:
      - url: http://alert-sink:8080/alerts
        send_resolved: true
```

**`docker/alertmanager/sink.py`**

```python
# 9.10.6 本機的告警收件人：Alertmanager 的 webhook → 一行一則印出來（時間、狀態、告警名稱、摘要）
import json, datetime
from http.server import BaseHTTPRequestHandler, HTTPServer

class Sink(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds')
        for a in body.get('alerts', []):
            print(json.dumps({'received': now, 'status': a['status'], 'alertname': a['labels'].get('alertname'),
                              'severity': a['labels'].get('severity'), 'summary': a['annotations'].get('summary'),
                              'startsAt': a.get('startsAt')}, ensure_ascii=False), flush=True)
        self.send_response(200); self.end_headers()
    def log_message(self, *args): pass

HTTPServer(('', 8080), Sink).serve_forever()
```

#### 測試（9.14）

其餘改過的舊測試檔只是把清理帳與稽核的那幾句換成 `TestInfra.adminJdbc()`（9.11.3 的 41 個檔；壓測工具改用一條 root 的連線），以及三個比較錯誤回應的測試改用 `TraceIds.normalized`（9.8.5），這裡不重貼。

**`src/test/java/com/example/shop/support/TestInfra.java`**

```java
package com.example.shop.support;

import com.github.dockerjava.api.model.ExposedPort;
import com.github.dockerjava.api.model.PortBinding;
import com.github.dockerjava.api.model.Ports;
import org.junit.platform.launcher.LauncherSession;
import org.junit.platform.launcher.LauncherSessionListener;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.env.EnvironmentPostProcessor;
import org.springframework.core.env.ConfigurableEnvironment;
import org.testcontainers.utility.MountableFile;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.MySQLContainer;
import org.testcontainers.containers.RabbitMQContainer;
import org.testcontainers.lifecycle.Startables;
import org.testcontainers.utility.DockerImageName;

import javax.sql.DataSource;
import java.net.ServerSocket;
import java.util.ArrayList;
import java.util.List;

/**
 * 第 08 章：每一次建置自己起一台 MySQL、Redis、RabbitMQ（0.6.8、7.16）。
 *
 * 一個 JVM（一次 mvn test）只起一組，所有測試共用；在這個 JVM 裡「第一個 Spring Boot 應用程式啟動的時候」才起（EnvironmentPostProcessor），
 * 把連線資訊寫成 System properties —— @SpringBootTest 與 new SpringApplicationBuilder(...).run() 都讀得到（System properties 比 application.yml 優先）。
 * 只有 JUnit 的那個 JVM 會起（LauncherSessionListener 標記）：子行程（驗收 Q9、實驗 H2）不會自己再起一組，它們用 childArgs() 連同一組（8.2.1）。
 * 純單元測試（狀態機、ArchUnit）一個容器都不起（8.4.2：第一版在 JUnit 一開始就起，單獨跑一個 0.8 秒的單元測試要 15 秒）。
 *
 * -Dshop.test.infra=compose：不起容器，照舊連 docker compose 的那一組。實驗（-Pexperiments）用這個：
 * 它們要 10 萬張訂單的種子資料、要跟第 06 章的 worktree 交錯量測，量的是同一個資料庫。
 */
public class TestInfra implements LauncherSessionListener, EnvironmentPostProcessor {

    public static final String MODE = System.getProperty("shop.test.infra", "testcontainers");

    static MySQLContainer<?> mysql;
    static GenericContainer<?> redis;
    static RabbitMQContainer rabbit;

    static volatile boolean junit;

    /**
     * 9.14：這一次建置 MySQL 最多同時被用了幾條連線（max_connections 是預設的 151）。每一個不同設定的 @SpringBootTest context
     * 都被快取、各留著一個 20 條的連線池 —— 第 09 章多了兩種，第一次撞到 Too many connections。
     * 第一版放在 JVM 的 shutdown hook：一行都沒印出來（那時 Testcontainers 自己的 hook 可能已經把容器收了）—— 改在 JUnit 結束的這一刻
     */
    @Override
    public void launcherSessionClosed(LauncherSession session) {
        if (mysql == null) return;
        try (var c = java.sql.DriverManager.getConnection(jdbcUrl("shop"), "root", mysql.getPassword()); var st = c.createStatement();
             var rs = st.executeQuery("SELECT (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Max_used_connections'), @@max_connections")) {
            rs.next();
            System.out.printf("TEST_INFRA MySQL 最多同時 %s 條連線（max_connections %s）%n", rs.getString(1), rs.getString(2));
        } catch (Exception e) {
            System.out.println("TEST_INFRA ⚠️ 讀不到 Max_used_connections：" + e);
        }
    }

    /** JUnit 的 JVM：記下來就好，容器等到真的有人要的時候才起 */
    @Override
    public void launcherSessionOpened(LauncherSession session) {
        junit = true;
    }

    /** 這個 JVM 裡每一個 Spring Boot 應用程式啟動時都會經過這裡；第一個經過的負責起容器 */
    @Override
    public void postProcessEnvironment(ConfigurableEnvironment environment, SpringApplication application) {
        if (junit && containers()) start();
    }

    static synchronized void start() {
        if (mysql != null) return;
        long t0 = System.nanoTime();
        // 跟 compose.yaml 同一個映像檔、同一組伺服器參數：測試量到的行為要跟本機開發、正式環境的 MySQL 一樣
        // 9.11：用 root 起容器 —— MySQLContainer 用這個帳號連 shop 來確認它起好了，而 INV-5 之後的 shop 在 migration 跑完之前連不進 shop
        //（它只有 shop_app 這個角色，角色的權限是 V15～V22 給的）。shop 由 00-users.sql 建立
        mysql = new MySQLContainer<>(DockerImageName.parse("mysql:8.0"))
                .withDatabaseName("shop").withUsername("root").withPassword("shop")
                .withCommand("--character-set-server=utf8mb4", "--collation-server=utf8mb4_0900_ai_ci",
                        "--default-time-zone=+00:00", "--transaction-isolation=REPEATABLE-READ")
                // 跟 compose 同一份初始化腳本：shop_lab、shop_c2、shop_q6 的權限（8.2.1：少了它，驗收 Q6 的 shop 帳號建不了 shop_q6 的表）
                // 9.11 INV-5：跟 compose 同一份 —— 應用程式的 shop 只拿 shop_app 這個角色，DDL 是 shop_migrator 的事
                .withCopyFileToContainer(MountableFile.forHostPath("docker/mysql-init/00-users.sql"), "/docker-entrypoint-initdb.d/00-users.sql")
                .withCopyFileToContainer(MountableFile.forHostPath("docker/mysql-init/01-databases.sql"), "/docker-entrypoint-initdb.d/01-databases.sql");
        // 8.4.4：驗收 Q8 要 docker stop / start 這個 Redis。隨機的對外埠每次 start 都會換一個（I3），應用程式就再也連不回來 ——
        // 所以在啟動時挑一個空的埠、固定綁上去。綁在所有介面（跟 compose 一樣）：第一版綁 127.0.0.1，docker stop 之後
        // 已經連著的 Lettuce 收不到 reset，每一個指令等滿 500 ms —— stop 變成了 pause（I3LettuceStopTest）
        int redisPort = freePort();
        redis = new GenericContainer<>(DockerImageName.parse("redis:7.2")).withExposedPorts(6379)
                .withCommand("redis-server", "--maxmemory", "256mb", "--maxmemory-policy", "noeviction")
                .withCreateContainerCmdModifier(cmd -> cmd.getHostConfig()
                        .withPortBindings(new PortBinding(Ports.Binding.bindPort(redisPort), ExposedPort.tcp(6379))));
        rabbit = new RabbitMQContainer(DockerImageName.parse("rabbitmq:3.13-management"));
        Startables.deepStart(mysql, redis, rabbit).join();                  // 三個一起起：總時間 ≈ 最慢的那一個
        for (String[] p : properties()) System.setProperty(p[0], p[1]);
        System.out.printf("TEST_INFRA testcontainers 啟動 %,d ms：mysql %s、redis %s:%d、rabbitmq %s:%d%n", (System.nanoTime() - t0) / 1_000_000,
                mysql.getJdbcUrl(), redis.getHost(), redis.getMappedPort(6379), rabbit.getHost(), rabbit.getAmqpPort());
    }

    public static boolean containers() {
        return MODE.equals("testcontainers");
    }

    static List<String[]> properties() {
        List<String[]> p = new ArrayList<>();
        p.add(new String[]{"spring.datasource.url", jdbcUrl("shop")});
        p.add(new String[]{"spring.datasource.username", "shop"});
        p.add(new String[]{"spring.datasource.password", "shop"});
        p.add(new String[]{"spring.flyway.user", "shop_migrator"});          // 9.11：DDL 與授權用另一個帳號
        p.add(new String[]{"spring.flyway.password", "shop_migrator"});
        p.add(new String[]{"spring.data.redis.host", redis.getHost()});
        p.add(new String[]{"spring.data.redis.port", String.valueOf(redis.getMappedPort(6379))});
        p.add(new String[]{"spring.rabbitmq.host", rabbit.getHost()});
        p.add(new String[]{"spring.rabbitmq.port", String.valueOf(rabbit.getAmqpPort())});
        p.add(new String[]{"spring.rabbitmq.username", rabbit.getAdminUsername()});
        p.add(new String[]{"spring.rabbitmq.password", rabbit.getAdminPassword()});
        return p;
    }

    /** 某一個資料庫的 JDBC URL（應用程式的參數照 application-local.yml） */
    public static String jdbcUrl(String database) {
        if (containers()) start();
        String hostPort = containers() ? mysql.getHost() + ":" + mysql.getMappedPort(3306) : "localhost:3306";
        return "jdbc:mysql://" + hostPort + "/" + database + "?useSSL=false&allowPublicKeyRetrieval=true&connectionTimeZone=UTC&rewriteBatchedStatements=true";
    }

    /**
     * 可以建資料庫的帳號（驗收 Q6）：root。
     * 9.11：compose 裡原本是 shop（docker/mysql-init 給了它 shop_q6 的權限）—— INV-5 之後它在 shop 只剩 shop_app 這個角色，
     * 跑不了 V15 的 CREATE ROLE 與授權
     */
    public static DataSource adminDataSource() {
        if (containers()) start();
        return new DriverManagerDataSource(jdbcUrl(""), "root", containers() ? mysql.getPassword() : "root");
    }

    private static volatile org.springframework.jdbc.core.JdbcTemplate admin;

    /**
     * 9.11 INV-5：應用程式的帳號沒有 inventory_ledger、audit_logs 的 UPDATE / DELETE 了。
     * 測試清理自己留下的帳與稽核，用這一個（root、shop 這個資料庫）—— 第 05 章 5.9：「到那時，這些測試的清理要換一個帳號」
     */
    public static org.springframework.jdbc.core.JdbcTemplate adminJdbc() {
        if (admin == null) {
            if (containers()) start();
            admin = new org.springframework.jdbc.core.JdbcTemplate(new DriverManagerDataSource(jdbcUrl("shop"), "root", containers() ? mysql.getPassword() : "root"));
        }
        return admin;
    }

    /** 驗收 Q9 的子行程：同一組容器 */
    public static List<String> childArgs() {
        if (!containers()) return List.of();
        start();
        return properties().stream().map(p -> "--" + p[0] + "=" + p[1]).toList();
    }

    /** 驗收 Q8 要停掉的那一個 Redis 容器 */
    public static String redisContainer() {
        if (containers()) start();
        return containers() ? redis.getContainerId() : "shop-redis-1";
    }

    /** 停掉 MySQL 用的：容器 id（compose 模式是 shop-mysql-1） */
    public static String mysqlContainer() {
        if (containers()) start();
        return containers() ? mysql.getContainerId() : "shop-mysql-1";
    }

    /**
     * docker stop / start / pause / unpause 一個容器（驗收 Q8、HealthProbeTest）。
     * 8.8：第一版是 new ProcessBuilder("docker", ...) —— CI 的映像檔（maven:3.9-eclipse-temurin-21）裡沒有 docker 這個程式，
     * 只有掛進來的 socket。Testcontainers 本來就有一個跟 daemon 講話的用戶端，用它（compose 模式下一樣可以用容器名稱）
     */
    public static void docker(String action, String container) {
        var client = org.testcontainers.DockerClientFactory.instance().client();
        try {
            switch (action) {
                case "stop" -> client.stopContainerCmd(container).exec();
                case "start" -> client.startContainerCmd(container).exec();
                case "pause" -> client.pauseContainerCmd(container).exec();
                case "unpause" -> client.unpauseContainerCmd(container).exec();
                default -> throw new IllegalArgumentException(action);
            }
        } catch (com.github.dockerjava.api.exception.NotModifiedException | com.github.dockerjava.api.exception.ConflictException already) {
            // 已經是那個狀態了（Q8 的 finally 會再 start 一次）：docker 的命令列在這種情況下什麼都不說，這裡也一樣
        }
    }

    static int freePort() {
        try (ServerSocket s = new ServerSocket(0)) {
            return s.getLocalPort();
        } catch (java.io.IOException e) {
            throw new IllegalStateException(e);
        }
    }
}
```

**`src/test/java/com/example/shop/support/CapturedLogs.java`**

```java
package com.example.shop.support;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.AppenderBase;
import org.slf4j.LoggerFactory;

import java.util.List;
import java.util.concurrent.ConcurrentLinkedQueue;

/**
 * 第 09 章（驗收 Q7）：把這個 JVM 的每一行日誌連同它當下的 MDC 收起來。
 * ⚠️ LoggingEvent 的 MDC 是用到時才讀「目前這條執行緒」的 —— 不在 append 的當下 prepareForDeferredProcessing()，
 * 之後在測試的執行緒上讀，拿到的是測試執行緒的 MDC
 */
public final class CapturedLogs extends AppenderBase<ILoggingEvent> implements AutoCloseable {

    private final ConcurrentLinkedQueue<ILoggingEvent> events = new ConcurrentLinkedQueue<>();

    public static CapturedLogs attach() {
        CapturedLogs c = new CapturedLogs();
        c.setContext((ch.qos.logback.classic.LoggerContext) LoggerFactory.getILoggerFactory());
        c.start();
        root().addAppender(c);
        return c;
    }

    static Logger root() { return (Logger) LoggerFactory.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME); }

    @Override
    protected void append(ILoggingEvent e) {
        e.prepareForDeferredProcessing();
        events.add(e);
    }

    public List<ILoggingEvent> events() { return List.copyOf(events); }

    @Override
    public void close() {
        root().detachAppender(this);
        stop();
    }
}
```

**`src/test/java/com/example/shop/support/TraceIds.java`**

```java
package com.example.shop.support;

import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 9.8 之後，每一個錯誤回應都帶著這個請求自己的 traceId。5.8.3 的「存在但不屬於你」與「不存在」要一模一樣 ——
 * traceId 是每個請求各自隨機產生的，跟資料存不存在無關；比較之前把它換成同一個佔位符，並且先確認兩邊都有（不能拿它來藏差異）
 */
public final class TraceIds {
    private TraceIds() {}

    static final Pattern FIELD = Pattern.compile("\"traceId\":\"[0-9a-f]{16,32}\"");

    public static String normalized(String problemJson) {
        assertThat(FIELD.matcher(problemJson).results().count()).as("錯誤回應帶著一個 traceId：" + problemJson).isEqualTo(1);
        return FIELD.matcher(problemJson).replaceAll("\"traceId\":\"…\"");
    }
}
```

**`src/test/java/com/example/shop/acceptance/CapstoneAcceptanceTest.java`**（Q7；原本是 `@Disabled("ch09：可觀測性")` 的空方法）

```java
    @Test
    @DisplayName("Q7 任一請求的日誌都帶 traceId，且能以 traceId 串起 HTTP → DB → MQ 消費端")
    void q7_traceIdEverywhere() throws Exception {
        long product = 9_900_771, buyerA = 9_900_771, buyerB = 9_900_772;
        List<Long> more = java.util.stream.LongStream.rangeClosed(9_900_773, 9_900_792).boxed().toList();   // 0.6.5：同一位買家每分鐘最多下 10 張
        List<Long> buyers = java.util.stream.Stream.concat(Stream.of(buyerA, buyerB), more.stream()).toList();
        try (var ctx = new SpringApplicationBuilder(ShopApplication.class).run("--server.port=0", "--shop.order.jobs-enabled=false",
                "--shop.inventory.jobs-enabled=false", "--shop.messaging.relay-enabled=true", "--shop.messaging.consumers-enabled=true",
                "--spring.main.banner-mode=off", "--logging.level.root=WARN", "--logging.level.com.example.shop=INFO");
             var logs = com.example.shop.support.CapturedLogs.attach()) {
            tokens = ctx.getBean(AccessTokens.class);
            redis = ctx.getBean(org.springframework.data.redis.core.StringRedisTemplate.class);
            JdbcTemplate jdbc = ctx.getBean(JdbcTemplate.class);
            int port = ((WebServerApplicationContext) ctx).getWebServer().getPort();
            Runnable cleanup = () -> {
                cleanupEvents(jdbc, buyers);
                jdbc.update("DELETE x FROM outbox_events x JOIN orders o ON o.id = x.aggregate_id AND x.aggregate_type = 'ORDER' WHERE o.buyer_id BETWEEN ? AND ?", 9_900_771, 9_900_792);
                com.example.shop.support.TestInfra.adminJdbc().update("DELETE FROM audit_logs WHERE actor_id IN (?, ?)", buyerA, buyerB);
                cleanupBuyersAndProducts(jdbc, buyers, List.of(product));
            };
            cleanup.run();
            try {
                product(jdbc, product, 100);
                // ① HTTP：下單的回應帶著 traceId
                HttpResponse<String> placed = HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/orders"))
                        .header("Authorization", TestTokens.bearer(tokens, buyerA)).header("Content-Type", "application/json").header("Idempotency-Key", "q7-1")
                        .POST(HttpRequest.BodyPublishers.ofString("{\"items\": [{\"productId\": %d, \"quantity\": 1, \"unitPrice\": 100}]}".formatted(product))).build(),
                        HttpResponse.BodyHandlers.ofString());
                String trace = placed.headers().firstValue("X-Trace-Id").orElse(null);
                String orderNo = new Http(placed.statusCode(), placed.body(), null).orderNo();
                long orderId = jdbc.queryForObject("SELECT id FROM orders WHERE order_no = ?", Long.class, orderNo);
                // ③ MQ：消費者寄出「訂單成立」
                await().atMost(java.time.Duration.ofSeconds(20)).until(() -> logs.events().stream()
                        .anyMatch(e -> e.getFormattedMessage().startsWith("MAIL_SENT user=" + buyerA)));
                // ② DB：outbox 的那一列；越權讀別人的訂單 → 稽核那一列
                String outboxTrace = jdbc.queryForObject("SELECT trace_id FROM outbox_events WHERE aggregate_id = ? AND event_type = 'order.placed'", String.class, orderId);
                HttpResponse<String> denied = http(port, "GET", "/api/orders/" + orderNo, TestTokens.bearer(tokens, buyerB), null);
                String deniedTrace = denied.headers().firstValue("X-Trace-Id").orElse(null);
                await().atMost(java.time.Duration.ofSeconds(5)).until(() -> jdbc.queryForObject(
                        "SELECT COUNT(*) FROM audit_logs WHERE actor_id = ? AND action = 'ACCESS_DENIED'", Integer.class, buyerB) == 1);
                String auditTrace = jdbc.queryForObject("SELECT trace_id FROM audit_logs WHERE actor_id = ? AND action = 'ACCESS_DENIED'", String.class, buyerB);
                // ④ 任一請求：再下 20 張，每一張一個 traceId，outbox 每一列都有
                List<String> traces = new java.util.ArrayList<>();
                for (int i = 0; i < 20; i++) {
                    HttpResponse<String> r = HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/orders"))
                            .header("Authorization", TestTokens.bearer(tokens, more.get(i))).header("Content-Type", "application/json").header("Idempotency-Key", "q7-more-" + i)
                            .POST(HttpRequest.BodyPublishers.ofString("{\"items\": [{\"productId\": %d, \"quantity\": 1, \"unitPrice\": 100}]}".formatted(product))).build(),
                            HttpResponse.BodyHandlers.ofString());
                    traces.add(r.headers().firstValue("X-Trace-Id").orElse(null));
                }
                List<String> outboxTraces = jdbc.queryForList("""
                        SELECT x.trace_id FROM outbox_events x JOIN orders o ON o.id = x.aggregate_id AND x.aggregate_type = 'ORDER'
                         WHERE o.buyer_id BETWEEN ? AND ? AND x.event_type = 'order.placed'""", String.class, 9_900_771, 9_900_792);
                await().atMost(java.time.Duration.ofSeconds(20)).until(() -> logs.events().stream()
                        .filter(e -> e.getFormattedMessage().startsWith("MAIL_SENT user=99007") && e.getFormattedMessage().contains("ORDER_PLACED")).count() >= 21);

                // ⑤ 外面帶進來的 traceparent 不收（9.8：這個應用程式前面沒有 gateway，traceparent 是任何人都可以寫的）
                String forged = "0af7651916cd43dd8448eb211c80319c";
                String echoed = HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/ping"))
                        .header("traceparent", "00-" + forged + "-b7ad6b7169203331-01").build(), HttpResponse.BodyHandlers.discarding())
                        .headers().firstValue("X-Trace-Id").orElse(null);

                List<ch.qos.logback.classic.spi.ILoggingEvent> all = logs.events();
                java.util.function.Function<String, List<ch.qos.logback.classic.spi.ILoggingEvent>> thread = prefix ->
                        all.stream().filter(e -> e.getThreadName().startsWith(prefix)).toList();
                java.util.function.ToLongFunction<List<ch.qos.logback.classic.spi.ILoggingEvent>> withTrace = l ->
                        l.stream().filter(e -> e.getMDCPropertyMap().get("traceId") != null).count();
                List<ch.qos.logback.classic.spi.ILoggingEvent> httpLogs = thread.apply("http-nio"), consumerLogs = all.stream()
                        .filter(e -> e.getThreadName().contains("Spring.bean")).toList();
                String mailTrace = all.stream().filter(e -> e.getFormattedMessage().startsWith("MAIL_SENT user=" + buyerA) && e.getFormattedMessage().contains(orderNo))
                        .findFirst().map(e -> e.getMDCPropertyMap().get("traceId")).orElse(null);
                System.out.printf("""
                        Q7 ① HTTP 下單：X-Trace-Id=%s；請求執行緒的日誌 %d 行，帶 traceId %d 行
                        Q7 ② DB：outbox_events.trace_id=%s；越權 %d、X-Trace-Id=%s → audit_logs.trace_id=%s
                        Q7 ③ MQ：消費者的日誌 %d 行，帶 traceId %d 行；寄出「訂單成立」那一行的 traceId=%s
                        Q7 ④ 再下 20 張：回應的 traceId 不同的有 %d 個；outbox 的 order.placed %d 列，trace_id 有值 %d 列
                        Q7 ⑤ 自己帶 traceparent（%s）→ X-Trace-Id=%s
                        """, trace, httpLogs.size(), withTrace.applyAsLong(httpLogs), outboxTrace, denied.statusCode(), deniedTrace, auditTrace,
                        consumerLogs.size(), withTrace.applyAsLong(consumerLogs), mailTrace,
                        traces.stream().filter(java.util.Objects::nonNull).distinct().count(), outboxTraces.size(), outboxTraces.stream().filter(java.util.Objects::nonNull).count(), forged, echoed);

                assertThat(trace).as("① 回應帶著 traceId").isNotBlank();
                assertThat(httpLogs).as("① 請求執行緒有寫日誌").isNotEmpty();
                assertThat(withTrace.applyAsLong(httpLogs)).as("① 請求執行緒的每一行都帶 traceId").isEqualTo(httpLogs.size());
                assertThat(outboxTrace).as("② HTTP → DB").isEqualTo(trace);
                assertThat(auditTrace).as("② 稽核").isEqualTo(deniedTrace).isNotEqualTo(trace);
                assertThat(denied.body()).as("② 錯誤回應也帶著 traceId（客服拿它找日誌）").contains(deniedTrace);
                assertThat(withTrace.applyAsLong(consumerLogs)).as("③ 消費者的每一行都帶 traceId").isEqualTo(consumerLogs.size());
                assertThat(mailTrace).as("③ DB → MQ 消費端").isEqualTo(trace);
                assertThat(traces).as("④ 每一個請求一個").doesNotContainNull().doesNotHaveDuplicates();
                assertThat(outboxTraces).as("④ 沒有被抽樣漏掉的").hasSize(21).doesNotContainNull().containsAll(traces);
                assertThat(echoed).as("⑤ 不收外面帶進來的 traceId").isNotNull().isNotEqualTo(forged);
            } finally {
                cleanup.run();
            }
        }
    }
```

**`src/test/java/com/example/shop/ordering/internal/EventFlowTest.java`**（9.2.1 的兩個新測試；`setUp` 的改動在下面的 diff）

```java
    @Test @DisplayName("9.2.1 沒有人訂閱的事件（order.completed）不能卡住 relay：120 張訂單確認收貨之後，新的一張照樣收到「訂單成立」")
    void unsubscribedEventsDoNotBlockRelay() {
        jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, ?, 11, '事件大量', 100.00, 'ON_SALE', FALSE)", BULK, SELLER);
        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 200, 0)", BULK);
        long t0 = System.nanoTime();
        for (int i = 0; i < 120; i++) {                                     // 上線第 7 天：第一批訂單走到 COMPLETED（US-ORD-6）
            var o = place(BUYER, BULK);
            pay(BUYER, o.orderNo());
            commands.startPicking(SELLER, o.orderNo());
            commands.ship(SELLER, o.orderNo(), "黑貓", "T-" + i);
            commands.confirmReceipt(BUYER, o.orderNo());
        }
        System.out.printf("9.2.1 120 張訂單走到 COMPLETED：%,d ms%n", (System.nanoTime() - t0) / 1_000_000);
        var fresh = place(BUYER + 1, NORMAL);
        long t1 = System.nanoTime();
        try {
            await().atMost(Duration.ofSeconds(30)).until(() -> sentTypes(BUYER + 1, fresh.orderNo()).contains("ORDER_PLACED"));
        } finally {
            System.out.printf("9.2.1 新訂單 %s：%,d ms 之後，outbox 還沒送出的 %s%n", fresh.orderNo(), (System.nanoTime() - t1) / 1_000_000,
                    jdbc.queryForList("SELECT event_type, COUNT(*) AS n FROM outbox_events WHERE published_at IS NULL GROUP BY event_type"));
        }
    }

    @Test @DisplayName("9.2.1 有人訂閱、拓撲卻壞了（綁定被拿掉 2 秒）：那一筆延後再試、不是每 100 ms 重送；後面的照樣送；綁定回來之後送到")
    void brokenBindingBacksOff() throws InterruptedException {
        Binding refunds = new Binding("shop.payment.refunds", Binding.DestinationType.QUEUE, "shop.events", "refund.requested", null);
        var paid = place(BUYER, NORMAL);
        long pid = pay(BUYER, paid.orderNo());
        double before = rejected();
        admin.removeBinding(refunds);
        try {
            commands.cancelByBuyer(BUYER, paid.orderNo());                  // → refund.requested：沒有佇列收
            var next = place(BUYER + 2, NORMAL);                            // 後面的事件不受影響
            await().atMost(Duration.ofSeconds(3)).until(() -> sentTypes(BUYER + 2, next.orderNo()).contains("ORDER_PLACED"));
            Thread.sleep(2000);                                             // 綁定壞著的 2 秒：relay 每 100 ms 一輪
        } finally {
            admin.declareBinding(refunds);
        }
        double times = rejected() - before;
        System.out.printf("9.2.1 拓撲壞了 2 秒多：refund.requested 被 broker 退回 %.0f 次；下一張訂單照樣通知%n", times);
        assertThat(times).as("延後 5 秒再試：這段時間裡最多一次").isBetween(1.0, 1.0);
        await().atMost(WAIT).until(() -> jdbc.queryForList("SELECT status FROM refunds WHERE order_id = ?", String.class, paid.orderId()).contains("SUCCEEDED"));
        await().atMost(WAIT).until(() -> sentTypes(BUYER, null).contains("REFUND_SUCCEEDED"));   // 8.8：等自己的信寄完才結束
        assertThat(gateway.moneyOutFor(pid)).isEqualTo(1);
    }

    double rejected() {
        var c = meters.find("shop.outbox.rejected").tag("reason", "unroutable").counter();
        return c == null ? 0 : c.count();
    }

    static long o(OrderingApi.PlacedOrder p) { return p.orderId(); }
```

**`src/test/java/com/example/shop/ordering/internal/EventFlowTest.java`**（`setUp` 與欄位的改動，`git diff ch08 ch09`）

```diff
diff --git a/src/test/java/com/example/shop/ordering/internal/EventFlowTest.java b/src/test/java/com/example/shop/ordering/internal/EventFlowTest.java
index cc91f1f..605ef47 100644
--- a/src/test/java/com/example/shop/ordering/internal/EventFlowTest.java
+++ b/src/test/java/com/example/shop/ordering/internal/EventFlowTest.java
@@ -10,6 +10,7 @@ import com.example.shop.support.InlineEvents;
 import com.example.shop.support.TestRedis;
 import org.junit.jupiter.api.*;
 import org.springframework.amqp.core.AmqpAdmin;
+import org.springframework.amqp.core.Binding;
 import org.springframework.beans.factory.annotation.Autowired;
 import org.springframework.boot.test.context.SpringBootTest;
 import org.springframework.context.ApplicationContext;
@@ -35,7 +36,7 @@ import static org.awaitility.Awaitility.await;
 @DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
 class EventFlowTest {
 
-    static final long BUYER = 990_711, SELLER = 2, NORMAL = 9_900_711, HOT = 9_900_712;
+    static final long BUYER = 990_711, SELLER = 2, NORMAL = 9_900_711, HOT = 9_900_712, BULK = 9_900_713;
     static final Duration WAIT = Duration.ofSeconds(20);
 
     @Autowired OrderingApi ordering;
@@ -48,6 +49,7 @@ class EventFlowTest {
     @Autowired SimulatedRefundGateway gateway;
     @Autowired AmqpAdmin admin;
     @Autowired ApplicationContext ctx;
+    @Autowired io.micrometer.core.instrument.MeterRegistry meters;
 
     @BeforeEach
     void setUp() {
@@ -71,10 +73,12 @@ class EventFlowTest {
         for (String t : List.of("refunds", "payments", "order_status_history", "order_items"))
             jdbc.update("DELETE x FROM " + t + " x JOIN orders o ON o.id = x.order_id WHERE o.buyer_id BETWEEN ? AND ?", BUYER, BUYER + 99);
         jdbc.update("DELETE FROM idempotency_keys WHERE buyer_id BETWEEN ? AND ?", BUYER, BUYER + 99);
+        // 9.2.1：沒有送出去的（沒有人訂閱的 order.completed）不能留給下一個打開 relay 的測試
+        jdbc.update("DELETE x FROM outbox_events x JOIN orders o ON o.id = x.aggregate_id AND x.aggregate_type = 'ORDER' WHERE o.buyer_id BETWEEN ? AND ? AND x.published_at IS NULL", BUYER, BUYER + 99);
         jdbc.update("DELETE FROM orders WHERE buyer_id BETWEEN ? AND ?", BUYER, BUYER + 99);
-        for (long p : List.of(NORMAL, HOT)) {
+        for (long p : List.of(NORMAL, HOT, BULK)) {
             jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", p);
-            jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", p);
+            com.example.shop.support.TestInfra.adminJdbc().update("DELETE FROM inventory_ledger WHERE product_id = ?", p);
             jdbc.update("DELETE FROM inventory WHERE product_id = ?", p);
             jdbc.update("DELETE FROM products WHERE id = ?", p);
         }
@@ -192,4 +196,57 @@ class EventFlowTest {
         assertThat(((Number) q.get("QUEUE_MESSAGE_COUNT")).intValue()).isEqualTo(1);
         admin.purgeQueue("shop.notification.order-events.dlq", false);
     }
+
+    @Test @DisplayName("9.2.1 沒有人訂閱的事件（order.completed）不能卡住 relay：120 張訂單確認收貨之後，新的一張照樣收到「訂單成立」")
+    void unsubscribedEventsDoNotBlockRelay() {
+        jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, ?, 11, '事件大量', 100.00, 'ON_SALE', FALSE)", BULK, SELLER);
+        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 200, 0)", BULK);
+        long t0 = System.nanoTime();
+        for (int i = 0; i < 120; i++) {                                     // 上線第 7 天：第一批訂單走到 COMPLETED（US-ORD-6）
+            var o = place(BUYER, BULK);
+            pay(BUYER, o.orderNo());
+            commands.startPicking(SELLER, o.orderNo());
+            commands.ship(SELLER, o.orderNo(), "黑貓", "T-" + i);
+            commands.confirmReceipt(BUYER, o.orderNo());
+        }
+        System.out.printf("9.2.1 120 張訂單走到 COMPLETED：%,d ms%n", (System.nanoTime() - t0) / 1_000_000);
+        var fresh = place(BUYER + 1, NORMAL);
+        long t1 = System.nanoTime();
+        try {
+            await().atMost(Duration.ofSeconds(30)).until(() -> sentTypes(BUYER + 1, fresh.orderNo()).contains("ORDER_PLACED"));
+        } finally {
+            System.out.printf("9.2.1 新訂單 %s：%,d ms 之後，outbox 還沒送出的 %s%n", fresh.orderNo(), (System.nanoTime() - t1) / 1_000_000,
+                    jdbc.queryForList("SELECT event_type, COUNT(*) AS n FROM outbox_events WHERE published_at IS NULL GROUP BY event_type"));
+        }
+    }
+
+    @Test @DisplayName("9.2.1 有人訂閱、拓撲卻壞了（綁定被拿掉 2 秒）：那一筆延後再試、不是每 100 ms 重送；後面的照樣送；綁定回來之後送到")
+    void brokenBindingBacksOff() throws InterruptedException {
+        Binding refunds = new Binding("shop.payment.refunds", Binding.DestinationType.QUEUE, "shop.events", "refund.requested", null);
+        var paid = place(BUYER, NORMAL);
+        long pid = pay(BUYER, paid.orderNo());
+        double before = rejected();
+        admin.removeBinding(refunds);
+        try {
+            commands.cancelByBuyer(BUYER, paid.orderNo());                  // → refund.requested：沒有佇列收
+            var next = place(BUYER + 2, NORMAL);                            // 後面的事件不受影響
+            await().atMost(Duration.ofSeconds(3)).until(() -> sentTypes(BUYER + 2, next.orderNo()).contains("ORDER_PLACED"));
+            Thread.sleep(2000);                                             // 綁定壞著的 2 秒：relay 每 100 ms 一輪
+        } finally {
+            admin.declareBinding(refunds);
+        }
+        double times = rejected() - before;
+        System.out.printf("9.2.1 拓撲壞了 2 秒多：refund.requested 被 broker 退回 %.0f 次；下一張訂單照樣通知%n", times);
+        assertThat(times).as("延後 5 秒再試：這段時間裡最多一次").isBetween(1.0, 1.0);
+        await().atMost(WAIT).until(() -> jdbc.queryForList("SELECT status FROM refunds WHERE order_id = ?", String.class, paid.orderId()).contains("SUCCEEDED"));
+        await().atMost(WAIT).until(() -> sentTypes(BUYER, null).contains("REFUND_SUCCEEDED"));   // 8.8：等自己的信寄完才結束
+        assertThat(gateway.moneyOutFor(pid)).isEqualTo(1);
+    }
+
+    double rejected() {
+        var c = meters.find("shop.outbox.rejected").tag("reason", "unroutable").counter();
+        return c == null ? 0 : c.count();
+    }
+
+    static long o(OrderingApi.PlacedOrder p) { return p.orderId(); }
 }
```

**`src/test/java/com/example/shop/schema/AppGrantsTest.java`**

```java
package com.example.shop.schema;

import com.example.shop.support.TestInfra;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;

import java.sql.SQLException;
import java.util.*;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowableOfType;

/**
 * 9.11 INV-5（0.4.6）：inventory_ledger 只能新增 —— 不是約束，是權限（2.5、0.12.2 的追溯表那一列「用應用程式帳號執行 UPDATE inventory_ledger，預期被拒」）。
 * 稽核也一樣（5.9）。以及：每一張表都要有人授權，新的表忘了授權，應用程式就讀不到它
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE)
class AppGrantsTest {

    static final long PRODUCT = 9_930_002;
    static final Set<String> APPEND_ONLY = Set.of("inventory_ledger", "audit_logs");
    static final Set<String> CRUD = Set.of("SELECT", "INSERT", "UPDATE", "DELETE");

    @Autowired JdbcTemplate jdbc;                                           // 應用程式的連線（shop）

    static int mysqlError(DataAccessException e) {
        Throwable t = e;
        while (t != null && !(t instanceof SQLException)) t = t.getCause();
        return t == null ? -1 : ((SQLException) t).getErrorCode();
    }

    @Test @DisplayName("INV-5：應用程式的帳號可以新增庫存帳，不能修改、不能刪除；稽核也是；也不能 DDL")
    void appendOnly() {
        JdbcTemplate admin = TestInfra.adminJdbc();
        admin.update("DELETE FROM inventory_ledger WHERE product_id = ?", PRODUCT);
        admin.update("DELETE FROM inventory WHERE product_id = ?", PRODUCT);
        admin.update("DELETE FROM products WHERE id = ?", PRODUCT);
        try {
            jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, 2, 11, 'INV-5', 100.00, 'ON_SALE')", PRODUCT);
            jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 10, 0)", PRODUCT);
            int inserted = jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 10, 0, 'INITIAL', 'inv5')", PRODUCT);
            Map<String, Integer> denied = new LinkedHashMap<>();
            for (String sql : List.of("UPDATE inventory_ledger SET delta_on_hand = 7 WHERE product_id = " + PRODUCT,
                    "DELETE FROM inventory_ledger WHERE product_id = " + PRODUCT,
                    "UPDATE audit_logs SET action = 'X' WHERE id = 0",
                    "DELETE FROM audit_logs WHERE id = 0",
                    "CREATE TABLE inv5_probe (id INT)",
                    "DROP TABLE orders")) {
                DataAccessException e = catchThrowableOfType(() -> jdbc.update(sql), DataAccessException.class);
                denied.put(sql.length() > 40 ? sql.substring(0, 40) + "…" : sql, e == null ? 0 : mysqlError(e));
            }
            System.out.println("9.11 INV-5：INSERT 帳 " + inserted + " 列；被拒絕的（MySQL 錯誤碼）" + denied
                    + "；目前的角色 " + jdbc.queryForObject("SELECT CURRENT_ROLE()", String.class));
            assertThat(inserted).isEqualTo(1);
            assertThat(denied.values()).as("1142 = command denied").containsOnly(1142);
            assertThat(jdbc.queryForObject("SELECT CURRENT_ROLE()", String.class)).isEqualTo("`shop_app`@`%`");
        } finally {
            admin.update("DELETE FROM inventory_ledger WHERE product_id = ?", PRODUCT);
            admin.update("DELETE FROM inventory WHERE product_id = ?", PRODUCT);
            admin.update("DELETE FROM products WHERE id = ?", PRODUCT);
        }
    }

    @Test @DisplayName("每一張表都授權給 shop_app：帳與稽核只有 SELECT、INSERT，其他四種都有（V15～V22）")
    void everyTableGranted() {
        JdbcTemplate admin = TestInfra.adminJdbc();
        List<String> tables = admin.queryForList("""
                SELECT table_name FROM information_schema.tables WHERE table_schema = 'shop' AND table_name <> 'flyway_schema_history' ORDER BY 1""", String.class);
        Map<String, Set<String>> granted = new TreeMap<>();
        admin.query("SELECT table_name, privilege_type FROM information_schema.table_privileges WHERE table_schema = 'shop' AND grantee = \"'shop_app'@'%'\"",
                rs -> { granted.computeIfAbsent(rs.getString(1), k -> new TreeSet<>()).add(rs.getString(2)); });
        Map<String, String> wrong = new TreeMap<>();
        for (String t : tables) {
            Set<String> want = APPEND_ONLY.contains(t) ? Set.of("SELECT", "INSERT")
                    : t.equals("inventory_ledger_watermark") ? Set.of("SELECT", "UPDATE") : CRUD;            // 9.12：只有一列，只會被更新
            Set<String> got = granted.getOrDefault(t, Set.of());
            if (!got.equals(want)) wrong.put(t, "應該 " + new TreeSet<>(want) + "，實際 " + got);
        }
        System.out.printf("9.11 %d 張表授權給 shop_app；不對的：%s%n", tables.size(), wrong);
        assertThat(wrong).isEmpty();
    }
}
```

**`src/test/java/com/example/shop/inventory/internal/IncrementalReconciliationTest.java`**

```java
package com.example.shop.inventory.internal;

import com.example.shop.support.TestInfra;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 9.12 J11b：增量對帳的水位線不能越過「已經拿到 id、還沒 commit」的那一列。
 * 交易 A 插了 X 的帳、還沒 commit；交易 B 插了 Y 的帳、commit 了（B 的 id 比 A 大）；這時對帳一次；A commit；再對帳兩次。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = {"shop.inventory.jobs-enabled=false", "shop.order.jobs-enabled=false"})
@org.springframework.test.annotation.DirtiesContext(classMode = org.springframework.test.annotation.DirtiesContext.ClassMode.AFTER_CLASS)   // 9.14：設定跟別人都不一樣，用完就關，不留一個 20 條的連線池
class IncrementalReconciliationTest {

    static final long X = 9_930_201, Y = 9_930_202;

    @Autowired InventoryReconciliation reconciliation;
    @Autowired JdbcTemplate jdbc;
    @Autowired PlatformTransactionManager tm;

    @BeforeEach @AfterEach
    void cleanup() {
        JdbcTemplate admin = TestInfra.adminJdbc();
        for (long p : new long[]{X, Y}) {
            admin.update("DELETE FROM inventory_ledger WHERE product_id = ?", p);
            admin.update("DELETE FROM inventory WHERE product_id = ?", p);
            admin.update("DELETE FROM products WHERE id = ?", p);
        }
        // 別的測試要的是「增量 = 全掃」：累計清空、水位線回到 0
        admin.update("DELETE FROM inventory_ledger_checkpoints");
        admin.update("UPDATE inventory_ledger_watermark SET upto_id = 0 WHERE id = 1");
    }

    Map<String, Object> scenario(Duration margin) throws Exception {
        for (long p : new long[]{X, Y}) {
            jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, 2, 11, '增量對帳', 100.00, 'ON_SALE')", p);
            jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 10, 0)", p);
            jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 10, 0, 'INITIAL', 'j11b')", p);
        }
        long before = reconciliation.checkIncremental(margin).get("INV-3");
        CountDownLatch inserted = new CountDownLatch(1), release = new CountDownLatch(1);
        TransactionTemplate tx = new TransactionTemplate(tm);
        Thread a = new Thread(() -> tx.executeWithoutResult(s -> {
            jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 1, 0, 'RESTOCK', 'j11b-A')", X);
            jdbc.update("UPDATE inventory SET on_hand = on_hand + 1 WHERE product_id = ?", X);
            inserted.countDown();
            try { release.await(10, TimeUnit.SECONDS); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        }), "j11b-A");
        a.start();
        assertThat(inserted.await(5, TimeUnit.SECONDS)).isTrue();
        tx.executeWithoutResult(s -> {                                      // B：比 A 晚插、先 commit —— id 比 A 大
            jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 1, 0, 'RESTOCK', 'j11b-B')", Y);
            jdbc.update("UPDATE inventory SET on_hand = on_hand + 1 WHERE product_id = ?", Y);
        });
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("A 還沒 commit 時對帳", reconciliation.checkIncremental(margin).get("INV-3") - before);
        r.put("水位線", watermark());
        release.countDown();
        a.join(5_000);
        r.put("A commit 之後對帳", reconciliation.checkIncremental(margin).get("INV-3") - before);
        Thread.sleep(margin.toMillis() + 500);
        r.put("再過 margin 之後對帳", reconciliation.checkIncremental(margin).get("INV-3") - before);
        r.put("水位線（之後）", watermark());
        r.put("A、B 的 id", jdbc.queryForList("SELECT id FROM inventory_ledger WHERE ref IN ('j11b-A', 'j11b-B') ORDER BY ref", Long.class));
        r.put("全掃 INV-3", reconciliation.checkFullAndRebaseline().get("INV-3"));
        r.put("全掃重建累計之後的增量", reconciliation.checkIncremental(margin).get("INV-3") - before);   // 每週那一次把漂移拉回來
        return r;
    }

    long watermark() { return jdbc.queryForObject("SELECT upto_id FROM inventory_ledger_watermark WHERE id = 1", Long.class); }

    @Test @DisplayName("⚠️ margin 0（水位線 = 看得到的最大 id）：A commit 之後的差異永遠在（全掃說 1）")
    void naiveWatermarkSkipsInFlightRow() throws Exception {
        Map<String, Object> r = scenario(Duration.ZERO);
        System.out.println("9.12 J11b margin 0（多出來的差異）：" + r);
        assertThat(r.get("A commit 之後對帳")).isEqualTo(1L);
        assertThat(r.get("再過 margin 之後對帳")).isEqualTo(1L);
        assertThat(r.get("全掃 INV-3")).as("真相").isEqualTo(0L);
        assertThat(r.get("全掃重建累計之後的增量")).isEqualTo(0L);
    }

    @Test @DisplayName("margin 2 秒：水位線不越過還沒 commit 的那一列；全程沒有假差異，過了 margin 才前進")
    void safeWatermark() throws Exception {
        Map<String, Object> r = scenario(Duration.ofSeconds(2));
        System.out.println("9.12 J11b margin 2 秒（多出來的差異）：" + r);
        assertThat(r.get("A 還沒 commit 時對帳")).isEqualTo(0L);
        assertThat(r.get("A commit 之後對帳")).isEqualTo(0L);
        assertThat(r.get("再過 margin 之後對帳")).isEqualTo(0L);
        assertThat(r.get("全掃 INV-3")).isEqualTo(0L);
    }
}
```

**`src/test/java/com/example/shop/shared/observability/JsonLogFormatTest.java`**

```java
package com.example.shop.shared.observability;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.LoggerContext;
import ch.qos.logback.classic.joran.JoranConfigurator;
import ch.qos.logback.classic.spi.LoggingEvent;
import ch.qos.logback.core.ConsoleAppender;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/** 9.7 正式環境的日誌格式（logback-json.xml）：用正式的那一份設定檔編碼幾行，看出來的 JSON */
class JsonLogFormatTest {

    @SuppressWarnings("unchecked")
    static JsonNode encode(String message, Map<String, String> mdc, Throwable t) throws Exception {
        LoggerContext ctx = new LoggerContext();
        JoranConfigurator c = new JoranConfigurator();
        c.setContext(ctx);
        c.doConfigure(JsonLogFormatTest.class.getResource("/logback-json.xml"));
        var appender = (ConsoleAppender<ch.qos.logback.classic.spi.ILoggingEvent>) ctx.getLogger("ROOT").getAppender("JSON");
        LoggingEvent e = new LoggingEvent("x", ctx.getLogger("com.example.shop.Demo"), Level.WARN, message, t, null);
        e.setMDCPropertyMap(mdc);
        e.setTimeStamp(1_791_262_568_123L);                                 // 2026-10-06T04:56:08.123Z（台北 12:56）
        String line = new String(appender.getEncoder().encode(e), StandardCharsets.UTF_8);
        System.out.println("9.7 " + line.strip() + "（" + line.getBytes(StandardCharsets.UTF_8).length + " bytes）");
        return new ObjectMapper().readTree(line);
    }

    @Test @DisplayName("9.7 一行一個 JSON：UTC、service、traceId、userId、orderNo")
    void fields() throws Exception {
        JsonNode j = encode("ORDER_PLACED orderNo=20261006-000001 buyerId=1001", Map.of("traceId", "6ac47feb3eb3c9f6e0dd11d168dd9a64",
                "spanId", "e0dd11d168dd9a64", "userId", "1001", "orderNo", "20261006-000001", "other", "不要"), null);
        assertThat(j.get("@timestamp").asText()).isEqualTo("2026-10-06T04:56:08.123Z");
        assertThat(j.get("service").asText()).isEqualTo("shop");
        assertThat(j.get("traceId").asText()).isEqualTo("6ac47feb3eb3c9f6e0dd11d168dd9a64");
        assertThat(j.get("userId").asText()).isEqualTo("1001");
        assertThat(j.get("orderNo").asText()).isEqualTo("20261006-000001");
        assertThat(j.has("other")).as("只帶列出來的 MDC").isFalse();
        assertThat(j.has("@version")).isFalse();
    }

    @Test @DisplayName("9.7 0.6.5 最後一道：忘了遮的 email、JWT 在編碼時遮掉")
    void masks() throws Exception {
        JsonNode j = encode("註冊失敗 gary.cai@example.com Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMDAxIn0.abcdefghijk", Map.of(), null);
        assertThat(j.get("message").asText()).doesNotContain("gary.cai@").doesNotContain("eyJhbGci")
                .contains("g***@example.com").contains("[JWT]");
    }

    @Test @DisplayName("9.7 例外：根本原因在前、框架的那幾層省略")
    void stackTrace() throws Exception {
        JsonNode j = encode("未預期的例外", Map.of(), new IllegalStateException("外層", new java.sql.SQLException("Duplicate entry 'x@example.com'")));
        String st = j.get("stack_trace").asText();
        assertThat(st).startsWith("java.sql.SQLException").contains("x***@example.com").doesNotContain("'x@example.com'");
    }
}
```

**`src/test/java/com/example/shop/shared/audit/internal/AuditRetentionTest.java`**

```java
package com.example.shop.shared.audit.internal;

import com.example.shop.support.TestInfra;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** 9.11 0.6.7：稽核保留 1 年 —— 應用程式刪得掉一年以前的（經過 V23 的程序），刪不掉別的 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = "shop.order.jobs-enabled=true")
@org.springframework.test.annotation.DirtiesContext(classMode = org.springframework.test.annotation.DirtiesContext.ClassMode.AFTER_CLASS)   // 9.14：設定跟別人都不一樣，用完就關，不留一個 20 條的連線池
class AuditRetentionTest {

    static final long ACTOR = 9_930_101;

    @Autowired AuditRetention retention;
    @Autowired JdbcTemplate jdbc;

    @Test @DisplayName("一年以前的兩筆被刪，昨天的那一筆留著；應用程式自己 DELETE 照樣被拒絕")
    void purgesOnlyOlderThanOneYear() {
        JdbcTemplate admin = TestInfra.adminJdbc();
        admin.update("DELETE FROM audit_logs WHERE actor_id = ?", ACTOR);
        try {
            for (String age : new String[]{"400 DAY", "366 DAY", "1 DAY"})
                admin.update("INSERT INTO audit_logs (actor_id, actor_role, action, target_type, target_id, created_at) VALUES (?, 'BUYER', 'ACCESS_DENIED', 'ORDER', 'x', NOW(3) - INTERVAL " + age + ")", ACTOR);
            int purged = retention.purge();
            long left = jdbc.queryForObject("SELECT COUNT(*) FROM audit_logs WHERE actor_id = ?", Long.class, ACTOR);
            System.out.println("9.11 稽核保留：程序刪了 " + purged + " 列；這位使用者剩 " + left + " 列（昨天那一筆）");
            assertThat(purged).isGreaterThanOrEqualTo(2);
            assertThat(left).isEqualTo(1);
            assertThatThrownBy(() -> jdbc.update("DELETE FROM audit_logs WHERE actor_id = ?", ACTOR)).isInstanceOf(DataAccessException.class);
        } finally {
            admin.update("DELETE FROM audit_logs WHERE actor_id = ?", ACTOR);
        }
    }
}
```

**`src/test/java/com/example/shop/ordering/internal/JobTraceTest.java`**

```java
package com.example.shop.ordering.internal;

import com.example.shop.ordering.OrderingApi;
import com.example.shop.support.InlineEvents;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.DirtiesContext;

import java.math.BigDecimal;
import java.time.Duration;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/** 9.8 排程也有 traceId：付款逾時取消 → order.cancelled 的 outbox 那一列帶著那一輪排程的 traceId */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = {"shop.order.jobs-enabled=true", "shop.order.timeout-scan-interval=10s",
        "shop.inventory.jobs-enabled=false"})
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class JobTraceTest {

    static final long BUYER = 990_901, PRODUCT = 9_900_901;

    @Autowired OrderingApi ordering;
    @Autowired JdbcTemplate jdbc;
    @Autowired ApplicationContext ctx;
    @Autowired OrderJobs jobs;

    @AfterEach
    void cleanup() {
        jdbc.update("DELETE x FROM outbox_events x JOIN orders o ON o.id = x.aggregate_id AND x.aggregate_type = 'ORDER' WHERE o.buyer_id = ?", BUYER);
        for (String t : List.of("order_status_history", "order_items"))
            jdbc.update("DELETE x FROM " + t + " x JOIN orders o ON o.id = x.order_id WHERE o.buyer_id = ?", BUYER);
        jdbc.update("DELETE FROM idempotency_keys WHERE buyer_id = ?", BUYER);
        jdbc.update("DELETE FROM orders WHERE buyer_id = ?", BUYER);
        jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", PRODUCT);
        com.example.shop.support.TestInfra.adminJdbc().update("DELETE FROM inventory_ledger WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM inventory WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM products WHERE id = ?", PRODUCT);
    }

    @Test @DisplayName("9.8 付款逾時的排程：order.cancelled 帶著一個 traceId（每一輪一個新的）")
    void timeoutCancelHasTrace() {
        cleanup();
        InlineEvents.skipBacklog(ctx);
        jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, 2, 11, '排程追蹤', 100.00, 'ON_SALE')", PRODUCT);
        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 10, 0)", PRODUCT);
        var o = ordering.placeOrder(BUYER, "job-trace", List.of(new OrderingApi.OrderLine(PRODUCT, 1, new BigDecimal("100"))));
        String placedTrace = jdbc.queryForObject("SELECT trace_id FROM outbox_events WHERE aggregate_id = ? AND event_type = 'order.placed'", String.class, o.orderId());
        jdbc.update("UPDATE orders SET payment_deadline = CURRENT_TIMESTAMP(3) - INTERVAL 1 SECOND WHERE id = ?", o.orderId());
        await().atMost(Duration.ofSeconds(25)).until(() -> "CANCELLED".equals(jdbc.queryForObject("SELECT status FROM orders WHERE id = ?", String.class, o.orderId())));
        String cancelTrace = jdbc.queryForObject("SELECT trace_id FROM outbox_events WHERE aggregate_id = ? AND event_type = 'order.cancelled'", String.class, o.orderId());
        System.out.println("9.8 排程：下單（直接呼叫 Service，沒有 HTTP）trace_id=" + placedTrace + "；付款逾時取消 trace_id=" + cancelTrace);
        assertThat(cancelTrace).isNotNull().isNotEqualTo(placedTrace);
    }
    @Test @DisplayName("9.11 0.6.7：冪等鍵保留 24 小時 —— 過期的刪掉、還沒過期的留著")
    void purgesExpiredIdempotencyKeys() {
        jdbc.update("DELETE FROM idempotency_keys WHERE buyer_id = ?", BUYER);
        jdbc.update("INSERT INTO idempotency_keys (buyer_id, idem_key, request_hash, expires_at) VALUES (?, 'old-1', 'h', CURRENT_TIMESTAMP(3) - INTERVAL 1 HOUR), (?, 'old-2', 'h', CURRENT_TIMESTAMP(3) - INTERVAL 1 MINUTE), (?, 'fresh', 'h', CURRENT_TIMESTAMP(3) + INTERVAL 23 HOUR)",
                BUYER, BUYER, BUYER);
        int purged = jobs.purgeIdempotencyKeys();
        java.util.List<String> left = jdbc.queryForList("SELECT idem_key FROM idempotency_keys WHERE buyer_id = ?", String.class, BUYER);
        System.out.println("9.11 冪等鍵清理：刪了 " + purged + " 列；這位買家剩 " + left);
        assertThat(purged).isGreaterThanOrEqualTo(2);
        assertThat(left).containsExactly("fresh");
    }
}
```

**`src/test/java/com/example/shop/acceptance/AlertMetricsTest.java`**

```java
package com.example.shop.acceptance;

import com.example.shop.ShopApplication;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.boot.builder.SpringApplicationBuilder;

import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 9.10：docker/prometheus/alerts.yml 用到的每一個 shop_ 指標，應用程式一啟動就要在 /actuator/prometheus 裡（值是 0 也要在）。
 * 不在的兩種後果：increase() 型的告警第一次不會響（promtool ④）；名字打錯，告警永遠不會響、也不會有人知道
 */
class AlertMetricsTest {

    static final Pattern METRIC = Pattern.compile("\\b(shop_[a-z_]+?)(?:_bucket|_count|_sum)?\\{");

    @Test @DisplayName("alerts.yml 裡的每一個 shop_ 指標，啟動之後就存在（從管理埠抓）")
    void everyAlertedMetricExistsAtStartup() throws Exception {
        Set<String> wanted = new TreeSet<>();
        Matcher m = METRIC.matcher(Files.readString(Path.of("docker/prometheus/alerts.yml")));
        while (m.find()) wanted.add(m.group(1));
        int mgmt;
        try (ServerSocket s = new ServerSocket(0)) { mgmt = s.getLocalPort(); }
        try (var ctx = new SpringApplicationBuilder(ShopApplication.class).run("--server.port=0", "--management.server.port=" + mgmt,
                "--shop.order.jobs-enabled=false", "--shop.inventory.jobs-enabled=true", "--shop.messaging.relay-enabled=true",
                "--shop.messaging.consumers-enabled=true", "--spring.main.banner-mode=off", "--logging.level.root=WARN")) {
            String body = HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create("http://localhost:" + mgmt + "/actuator/prometheus")).build(),
                    HttpResponse.BodyHandlers.ofString()).body();
            TreeMap<String, Long> found = new TreeMap<>();
            for (String w : wanted) found.put(w, body.lines().filter(l -> l.startsWith(w + "{") || l.startsWith(w + " ") || l.startsWith(w + "_total")).count());
            System.out.println("9.10 alerts.yml 用到的 shop_ 指標（啟動之後的序列數）：" + found);
            assertThat(found).as("每一個都要有至少一條序列").allSatisfy((k, v) -> assertThat(v).as(k).isPositive());
        }
    }
}
```

#### 腳本

下面兩支是正文的驗收清單會用到的（都要 `chmod +x`）。`j8b-alert-drill.sh` 的流量寫死打 `http://localhost:18090`，它用的客戶端是測試程式碼裡的 `loadtest/StopDuringLoad`，一併附上。

**`scripts/j12-checklist.sh`**

```bash
#!/usr/bin/env bash
# 9.13 上線檢查清單（對著 compose 的 app profile 跑；正式環境換成對應的位址與帳號）
cd "$(dirname "$0")/.."
P=${SHOP_HTTP_PORT:-8080}
ok() { printf '  ✅ %s\n' "$*"; }; bad() { printf '  ❌ %s\n' "$*"; }; warn() { printf '  ⚠️  %s\n' "$*"; }
sql() { docker exec shop-mysql-1 sh -c "mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" shop -N -e \"$1\"" 2>/dev/null; }
code() { curl -s -o /dev/null -w '%{http_code}' "$1"; }
echo "── 對外"
for path in /actuator/health /actuator/prometheus /v3/api-docs /swagger-ui.html; do
  c=$(code localhost:$P$path); case "$path:$c" in /actuator/*:404|/actuator/*:401) ok "${path} → ${c}（actuator 不在對外的埠）";; /v3/*:200|/swagger*:200|/swagger*:302) bad "${path} → ${c}（API 文件對外公開）";; *) ok "${path} → ${c}";; esac
done
d=$(docker exec shop-app-1 curl -s localhost:8081/actuator/health)
case "$d" in *components*) bad "管理埠的 /actuator/health 沒有登入也看得到細節：${d:0:80}";; *) ok "管理埠的 /actuator/health 沒有登入只看到 $d";; esac
echo "── 容器"
u=$(docker exec shop-app-1 id -un); [ "$u" != root ] && ok "執行身分 $u" || bad "執行身分 root"
pid1=$(docker top shop-app-1 -o pid,comm | awk 'NR==2{print $2}'); [ "$pid1" = java ] && ok "PID 1 是 java" || bad "PID 1 是 $pid1"
st=$(docker inspect -f '{{.Config.StopTimeout}}' shop-app-1); [ "${st:-0}" -ge 20 ] && ok "StopTimeout $st 秒" || bad "StopTimeout $st 秒"
mem=$(docker inspect -f '{{.HostConfig.Memory}}' shop-app-1); [ "$mem" -gt 0 ] && ok "記憶體上限 $((mem/1024/1024)) MiB" || bad "沒有記憶體上限"
cpu=$(docker inspect -f '{{.HostConfig.NanoCpus}}' shop-app-1); [ "$cpu" -gt 0 ] && ok "CPU 上限 $((cpu/1000000000))" || bad "沒有 CPU 上限"
echo "── 日誌"
n=$(docker logs --tail 200 shop-app-1 2>&1 | grep -c .); j=$(docker logs --tail 200 shop-app-1 2>&1 | python3 -c "import sys,json; c=0
for l in sys.stdin:
    try: json.loads(l); c+=1
    except Exception: pass
print(c)"); [ "$n" = "$j" ] && ok "最後 $n 行全部是 JSON" || bad "最後 $n 行裡 $j 行是 JSON"
z=$(docker logs --tail 1 shop-app-1 2>&1 | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['@timestamp'])"); case "$z" in *Z) ok "時間是 UTC（${z}）";; *) bad "時間 $z";; esac
echo "── 資料庫"
g=$(sql "SHOW GRANTS FOR shop" | grep -c "ON \`shop\`"); [ "$g" = 0 ] && ok "shop 在 shop 庫上沒有直接的權限（只有 shop_app 角色）" || bad "shop 在 shop 庫上有 $g 條直接權限"
tls=$(sql "SELECT COUNT(*) FROM sys.session_ssl_status x JOIN performance_schema.threads t ON t.thread_id = x.thread_id WHERE t.processlist_user = 'shop' AND x.ssl_version <> ''")
all=$(sql "SELECT COUNT(*) FROM performance_schema.threads WHERE processlist_user = 'shop'")
[ "$tls" = "$all" ] && warn "應用程式的 $all 條連線都是 TLS —— 但 sslMode=REQUIRED 不驗證憑證（正式環境用 VERIFY_IDENTITY 與真的 CA）" || bad "TLS $tls / $all"
inv=$(sql "SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = 'shop' AND is_visible = 'NO'"); [ "$inv" = 0 ] && ok "invisible 的索引 0 個（2.7）" || bad "invisible 的索引 $inv 個"
pend=$(sql "SELECT COUNT(*) FROM outbox_events WHERE published_at IS NULL"); [ "$pend" = 0 ] && ok "outbox 未送出 0" || warn "outbox 未送出 $pend"
r3=$(sql "SELECT COUNT(*) FROM inventory i LEFT JOIN (SELECT product_id, SUM(delta_on_hand) s FROM inventory_ledger IGNORE INDEX (idx_ledger_product) GROUP BY product_id) l ON l.product_id = i.product_id WHERE i.on_hand <> COALESCE(l.s, 0)")
[ "$r3" = 0 ] && ok "INV-3 全掃差異 0" || bad "INV-3 全掃差異 $r3"
echo "── 訊息"
dlq=$(docker exec shop-rabbitmq-1 rabbitmqctl list_queues -q name messages 2>/dev/null | awk '$1 ~ /\.dlq$/ {s+=$2} END {print s+0}'); [ "$dlq" = 0 ] && ok "死信 0" || bad "死信 $dlq 則"
echo "── 監控"
up=$(curl -s localhost:9090/api/v1/targets | python3 -c "import sys,json; t=json.load(sys.stdin)['data']['activeTargets']; print(sum(x['health']=='up' for x in t), len(t))"); ok "Prometheus targets up：$up"
rules=$(curl -s localhost:9090/api/v1/rules | python3 -c "import sys,json; print(sum(len(g['rules']) for g in json.load(sys.stdin)['data']['groups']))"); ok "告警規則 $rules 條"
firing=$(curl -s localhost:9090/api/v1/alerts | python3 -c "import sys,json; a=[x['labels']['alertname'] for x in json.load(sys.stdin)['data']['alerts'] if x['state']=='firing']; print(', '.join(a) or '沒有')"); [ "$firing" = 沒有 ] && ok "現在 firing 的告警：$firing" || bad "現在 firing 的告警：$firing"
am=$(curl -s localhost:9090/api/v1/alertmanagers | python3 -c "import sys,json; print(len(json.load(sys.stdin)['data']['activeAlertmanagers']))"); [ "$am" -gt 0 ] && ok "Alertmanager $am 個" || bad "沒有 Alertmanager：告警響了，沒有人會收到"
echo "── 秘密"
leaks=$(git grep -nE '(secret|password)[A-Za-z_-]*:\s*[^$ {]' -- '*.yml' '*.yaml' | grep -vE 'local-dev-only|compose-local-only|: shop$|: shop_migrator$|: exporter$|: root$' | wc -l | tr -d ' ')
[ "$leaks" = 0 ] && ok "yml 裡沒有不是本機用的秘密（application-prod.yml 全部是 \${…}）" || bad "可疑的秘密 $leaks 處"
echo "── 沒有做的（0.7 第 11 項、這一章的範圍外）"
warn "資料庫的備份與還原、高可用：沒有實作（07-mysql 第 07 章）"
warn "負載平衡器之後的 X-Forwarded-For（5.6）：compose 沒有負載平衡器；正式環境要設 server.forward-headers-strategy 並確定應用程式的埠只有負載平衡器連得到"
```

**`scripts/j8b-alert-drill.sh`**

```bash
#!/usr/bin/env bash
# 9.10 告警的實地演練（compose 的 app profile 要開著）：每秒 5 張訂單；第 STOP 秒 docker stop <目標>、第 START 秒 docker start；
# 每 5 秒問一次 Prometheus：哪些告警 pending / firing、指定的指標是多少
# 用法：scripts/j8b-alert-drill.sh <容器> <STOP> <START> <總秒數> '<PromQL>'
cd "$(dirname "$0")/.."
target=$1; stop=$2; startAt=$3; total=$4; q=$5
[ -f target/test-classpath.txt ] || mvn -q dependency:build-classpath -Dmdep.outputFile=target/test-classpath.txt -Dmdep.includeScope=test
java -cp "target/test-classes:target/classes:$(cat target/test-classpath.txt)" com.example.shop.loadtest.StopDuringLoad base=http://localhost:18090 \
  rps=5 seconds="$total" stopAt=0 jwt-secret=compose-local-only-jwt-secret-0123456789abcdef > target/j8b-traffic.log 2>&1 &
traffic=$!
trap 'kill $traffic 2>/dev/null; docker start "$target" >/dev/null 2>&1' EXIT
t0=$(date +%s)
echo "### ${target}：第 ${stop} 秒 stop、第 ${startAt} 秒 start；load $(sysctl -n vm.loadavg)"
while :; do
  t=$(( $(date +%s) - t0 ))
  [ $t -ge "$total" ] && break
  [ $t -ge "$stop" ] && [ -z "${stopped:-}" ] && { docker stop "$target" >/dev/null; stopped=$t; echo "  ── 第 ${t} 秒（$(date -u +%H:%M:%S) UTC）docker stop ${target}"; }
  [ $t -ge "$startAt" ] && [ -z "${started:-}" ] && { docker start "$target" >/dev/null; started=$t; echo "  ── 第 ${t} 秒（$(date -u +%H:%M:%S) UTC）docker start ${target}"; }
  alerts=$(curl -s localhost:9090/api/v1/alerts | python3 -c "import sys,json; a=json.load(sys.stdin)['data']['alerts']; print(' '.join(sorted(x['labels']['alertname']+'('+x['state']+')' for x in a)) or '—')")
  val=$(curl -s --data-urlencode "query=$q" localhost:9090/api/v1/query | python3 -c "import sys,json; r=json.load(sys.stdin)['data']['result']; print(', '.join(f\"{float(x['value'][1]):.1f}\" for x in r) or '（沒有序列）')")
  printf '  %4d 秒 │ %-12s │ %s\n' "$t" "$val" "$alerts"
  sleep 5
done
wait $traffic 2>/dev/null
echo "  流量：$(grep '合計' target/j8b-traffic.log)"
echo "### done load $(sysctl -n vm.loadavg)"
```

**`src/test/java/com/example/shop/loadtest/StopDuringLoad.java`**

```java
package com.example.shop.loadtest;

import com.example.shop.shared.security.LoadTestTokens;

import java.io.IOException;
import java.net.ConnectException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;

/**
 * 9.5 容器被 docker stop 的那幾秒，正在送的下單請求怎麼了？
 * 每秒 rps 個 POST /api/orders（每一個一位新買家、一個新的 Idempotency-Key），第 stopAt 秒在另一條執行緒 docker stop。
 * 每一個請求的結果分四種：HTTP 狀態碼／連不上（沒送出去）／送出去了、沒有回應（連線斷了）／逾時。
 * 後兩種回資料庫查：這一張訂單其實成立了嗎？—— 那是使用者「按了送出、畫面說失敗、錢卻要付」的那一種。
 *
 *   java … StopDuringLoad container=j2 base=http://localhost:18081 rps=50 seconds=16 stopAt=6 stop="-t 30"
 */
public final class StopDuringLoad {

    record Result(long buyer, long dueNanos, String outcome) {}

    static final long FIRST_PRODUCT = 9_920_001, FIRST_BUYER = 3_200_000;
    static final int PRODUCTS = 100;

    public static void main(String[] args) throws Exception {
        Map<String, String> opt = new HashMap<>();
        for (String a : args) { String[] kv = a.split("=", 2); opt.put(kv[0], kv.length > 1 ? kv[1] : "true"); }
        String base = opt.getOrDefault("base", "http://localhost:18081"), container = opt.getOrDefault("container", "j2");
        int rps = Integer.parseInt(opt.getOrDefault("rps", "50")), seconds = Integer.parseInt(opt.getOrDefault("seconds", "16"));
        int stopAt = Integer.parseInt(opt.getOrDefault("stopAt", "6"));
        String stopArgs = opt.getOrDefault("stop", "");
        LoadTestTokens tokens = new LoadTestTokens(opt.getOrDefault("jwt-secret", "local-dev-only-secret-0123456789abcdef"));
        long lo = FIRST_BUYER, hi = FIRST_BUYER + 100_000;
        try (Connection c = DriverManager.getConnection(ExternalLoad.SHOP_JDBC, "shop", "shop")) {
            cleanup(c, lo, hi);
            for (int i = 0; i < PRODUCTS; i++) {
                long id = FIRST_PRODUCT + i;
                ExternalLoad.exec(c, "INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, 2, 11, ?, 100.00, 'ON_SALE')", id, "停機演練 " + i);
                ExternalLoad.exec(c, "INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 100000, 0)", id);
                ExternalLoad.exec(c, "INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 100000, 0, 'INITIAL', 'stop-drill')", id);
            }
            HttpClient http = HttpClient.newBuilder().executor(Executors.newFixedThreadPool(100)).connectTimeout(Duration.ofSeconds(2)).build();
            Random r = new Random(9);
            ConcurrentLinkedQueue<Result> results = new ConcurrentLinkedQueue<>();
            List<CompletableFuture<?>> fs = new ArrayList<>();
            long start = System.nanoTime() + 200_000_000L;
            long[] stopWindow = new long[2];
            Thread stopper = new Thread(() -> {
                try {
                    long w = start + stopAt * 1_000_000_000L - System.nanoTime();
                    if (w > 0) TimeUnit.NANOSECONDS.sleep(w);
                    stopWindow[0] = System.nanoTime();
                    List<String> cmd = new ArrayList<>(List.of("docker", "stop"));
                    if (!stopArgs.isBlank()) cmd.addAll(List.of(stopArgs.trim().split("\\s+")));
                    cmd.add(container);
                    new ProcessBuilder(cmd).redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.DISCARD).start().waitFor();
                    stopWindow[1] = System.nanoTime();
                } catch (Exception e) {
                    throw new IllegalStateException(e);
                }
            }, "docker-stop");
            if (stopAt > 0) stopper.start();                              // stopAt=0：只送流量（9.10 的告警演練）
            int n = rps * seconds;
            for (int i = 0; i < n; i++) {
                long due = start + i * (1_000_000_000L / rps);
                long w = due - System.nanoTime();
                if (w > 0) TimeUnit.NANOSECONDS.sleep(w);
                long b = lo + i;
                HttpRequest req = HttpRequest.newBuilder(URI.create(base + "/api/orders")).timeout(Duration.ofSeconds(5))
                        .header("Authorization", tokens.bearer(b)).header("Idempotency-Key", "stop-" + b).header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString("{\"items\":[{\"productId\":" + (FIRST_PRODUCT + r.nextInt(PRODUCTS)) + ",\"quantity\":1,\"unitPrice\":100}]}")).build();
                fs.add(http.sendAsync(req, HttpResponse.BodyHandlers.discarding()).handle((x, e) -> {
                    results.add(new Result(b, due, e == null ? "HTTP " + x.statusCode() : classify(e)));
                    return null;
                }));
            }
            CompletableFuture.allOf(fs.toArray(CompletableFuture[]::new)).join();
            if (stopAt > 0) stopper.join();

            // 沒有拿到回應的：訂單其實成立了嗎？（冪等鍵那一列有 order_id = 成立了）
            Map<String, int[]> unknown = new TreeMap<>();
            try (PreparedStatement ps = c.prepareStatement("SELECT order_id FROM idempotency_keys WHERE buyer_id = ? AND idem_key = ?")) {
                for (Result x : results) {
                    if (x.outcome().startsWith("HTTP") || x.outcome().startsWith("連不上")) continue;
                    ps.setLong(1, x.buyer());
                    ps.setString(2, "stop-" + x.buyer());
                    try (ResultSet rs = ps.executeQuery()) {
                        boolean placed = rs.next() && rs.getObject(1) != null;
                        unknown.computeIfAbsent(x.outcome(), k -> new int[2])[placed ? 0 : 1]++;
                    }
                }
            }
            Map<Long, Map<String, Integer>> perSecond = new TreeMap<>();
            for (Result x : results)
                perSecond.computeIfAbsent((x.dueNanos() - start) / 1_000_000_000L, k -> new TreeMap<>()).merge(x.outcome(), 1, Integer::sum);
            if (stopAt > 0) System.out.printf("  docker stop %s：第 %.1f 秒送出，%.1f 秒後回來%n", stopArgs.isBlank() ? "（預設）" : stopArgs,
                    (stopWindow[0] - start) / 1e9, (stopWindow[1] - stopWindow[0]) / 1e9);
            perSecond.forEach((s, m) -> System.out.printf("   %2d 秒 │ %s%n", s, m));
            Map<String, Integer> total = new TreeMap<>();
            results.forEach(x -> total.merge(x.outcome(), 1, Integer::sum));
            System.out.println("  合計：" + total);
            unknown.forEach((k, v) -> System.out.printf("  「%s」的 %d 個：訂單其實成立了 %d 個、沒有成立 %d 個%n", k, v[0] + v[1], v[0], v[1]));
            cleanup(c, lo, hi);
        }
        System.exit(0);                                                     // HttpClient 的 executor 不是 daemon：不 exit 的話這個 JVM 不會結束
    }

    static String classify(Throwable e) {
        Throwable t = e instanceof CompletionException && e.getCause() != null ? e.getCause() : e;
        if (t instanceof HttpTimeoutException) return "逾時（5 秒沒有回應）";
        if (t instanceof ConnectException || (t.getCause() instanceof ConnectException)) return "連不上（沒送出去）";
        if (t instanceof IOException) return "送出去了、沒有回應（" + t.getClass().getSimpleName() + ": " + String.valueOf(t.getMessage()).replaceAll("\\s+", " ") + "）";
        return "其他（" + t.getClass().getSimpleName() + "）";
    }

    static void cleanup(Connection c, long lo, long hi) throws Exception {
        ExternalLoad.exec(c, "DELETE n FROM notifications n JOIN orders o ON o.id = n.payload->>'$.aggregateId' WHERE o.buyer_id >= ? AND o.buyer_id < ?", lo, hi);
        ExternalLoad.exec(c, "DELETE FROM notifications WHERE user_id >= ? AND user_id < ?", lo, hi);
        for (String t : List.of("refunds", "payments", "order_status_history", "order_items"))
            ExternalLoad.exec(c, "DELETE x FROM " + t + " x JOIN orders o ON o.id = x.order_id WHERE o.buyer_id >= ? AND o.buyer_id < ?", lo, hi);
        ExternalLoad.exec(c, "DELETE FROM idempotency_keys WHERE buyer_id >= ? AND buyer_id < ?", lo, hi);
        ExternalLoad.exec(c, "DELETE x FROM outbox_events x JOIN orders o ON o.id = x.aggregate_id AND x.aggregate_type = 'ORDER' WHERE o.buyer_id >= ? AND o.buyer_id < ?", lo, hi);
        ExternalLoad.exec(c, "DELETE FROM orders WHERE buyer_id >= ? AND buyer_id < ?", lo, hi);
        long p0 = FIRST_PRODUCT, p1 = FIRST_PRODUCT + PRODUCTS;
        ExternalLoad.exec(c, "DELETE FROM inventory_reservations WHERE product_id >= ? AND product_id < ?", p0, p1);
        ExternalLoad.exec(ExternalLoad.root(), "DELETE FROM inventory_ledger WHERE product_id >= ? AND product_id < ?", p0, p1);
        ExternalLoad.exec(c, "DELETE FROM inventory WHERE product_id >= ? AND product_id < ?", p0, p1);
        ExternalLoad.exec(c, "DELETE FROM products WHERE id >= ? AND id < ?", p0, p1);
    }
}
```

**`src/test/java/com/example/shop/loadtest/ExternalLoad.java`、`ExternalDrill.java`**（`StopDuringLoad` 用到的 `ExternalLoad.root()`，`git diff ch08 ch09`）

```diff
diff --git a/src/test/java/com/example/shop/loadtest/ExternalDrill.java b/src/test/java/com/example/shop/loadtest/ExternalDrill.java
index a860747..0421ba5 100644
--- a/src/test/java/com/example/shop/loadtest/ExternalDrill.java
+++ b/src/test/java/com/example/shop/loadtest/ExternalDrill.java
@@ -166,7 +166,7 @@ public final class ExternalDrill {
         ExternalLoad.exec(c, "DELETE FROM orders WHERE buyer_id >= ? AND buyer_id < ?", lo, hi);
         for (long id : new long[]{HOT, NORMAL}) {
             ExternalLoad.exec(c, "DELETE FROM inventory_reservations WHERE product_id = ?", id);
-            ExternalLoad.exec(c, "DELETE FROM inventory_ledger WHERE product_id = ?", id);
+            ExternalLoad.exec(ExternalLoad.root(), "DELETE FROM inventory_ledger WHERE product_id = ?", id);
             ExternalLoad.exec(c, "DELETE FROM inventory WHERE product_id = ?", id);
             ExternalLoad.exec(c, "DELETE FROM products WHERE id = ?", id);
         }
diff --git a/src/test/java/com/example/shop/loadtest/ExternalLoad.java b/src/test/java/com/example/shop/loadtest/ExternalLoad.java
index d279be6..d0e29af 100644
--- a/src/test/java/com/example/shop/loadtest/ExternalLoad.java
+++ b/src/test/java/com/example/shop/loadtest/ExternalLoad.java
@@ -64,6 +64,14 @@ public final class ExternalLoad {
         }
     }
 
+    private static Connection root;
+
+    /** 9.11 INV-5：應用程式的帳號（shop）不能刪 inventory_ledger、audit_logs 了 —— 壓測工具清自己的帳用 root（compose 的 root/root） */
+    static synchronized Connection root() throws Exception {
+        if (root == null || root.isClosed()) root = DriverManager.getConnection(SHOP_JDBC, "root", "root");
+        return root;
+    }
+
     static long[] lockWaits(Connection root) throws Exception {
         long[] r = new long[2];
         try (Statement s = root.createStatement(); ResultSet rs = s.executeQuery("SHOW GLOBAL STATUS WHERE Variable_name IN ('Innodb_row_lock_waits', 'Innodb_row_lock_time')")) {
@@ -133,7 +141,7 @@ public final class ExternalLoad {
         exec(c, "DELETE FROM idempotency_keys WHERE buyer_id >= ? AND buyer_id < ?", FIRST_BUYER, FIRST_BUYER + BUYERS);
         exec(c, "DELETE FROM orders WHERE buyer_id >= ? AND buyer_id < ?", FIRST_BUYER, FIRST_BUYER + BUYERS);
         exec(c, "DELETE FROM inventory_reservations WHERE product_id = ?", HOT);
-        exec(c, "DELETE FROM inventory_ledger WHERE product_id = ?", HOT);
+        exec(ExternalLoad.root(), "DELETE FROM inventory_ledger WHERE product_id = ?", HOT);
         exec(c, "DELETE FROM inventory WHERE product_id = ?", HOT);
         exec(c, "DELETE FROM products WHERE id = ?", HOT);
         redis.sync().del("product:v1:" + HOT, "stock:" + HOT, "available:" + HOT, "trending:24h:top10");   // TestRedis.forgetProducts
@@ -319,7 +327,7 @@ public final class ExternalLoad {
         exec(c, "DELETE FROM orders WHERE buyer_id >= ? AND buyer_id < ?", lo, hi);
         long p0 = PLACE_FIRST_PRODUCT, p1 = PLACE_FIRST_PRODUCT + PLACE_PRODUCTS;
         exec(c, "DELETE FROM inventory_reservations WHERE product_id >= ? AND product_id < ?", p0, p1);
-        exec(c, "DELETE FROM inventory_ledger WHERE product_id >= ? AND product_id < ?", p0, p1);
+        exec(ExternalLoad.root(), "DELETE FROM inventory_ledger WHERE product_id >= ? AND product_id < ?", p0, p1);
         exec(c, "DELETE FROM inventory WHERE product_id >= ? AND product_id < ?", p0, p1);
         exec(c, "DELETE FROM products WHERE id >= ? AND id < ?", p0, p1);
         List<String> keys = new ArrayList<>();
```

其餘的是這一章的實驗腳本，重現正文的數字才需要，這裡只列用途：

| 腳本 | 用途 |
|---|---|
| `scripts/j1-busy-h6.sh` | 9.2.1 J1a：機器忙（6 個 `yes`）、H6 的 RabbitMQ 停機演練，把應用程式的日誌留下來 |
| `scripts/j1c-rabbit-start.sh` | 9.2.1 J1c、9.2.2 J1d：`docker start` 之後多久回 AMQP 的 Connection.Start |
| `scripts/j2-stop.sh` | 9.2.2 J2：一個映像檔的 PID 1、`docker stop` 的時間與結束碼 |
| `scripts/j2b-stop-under-load.sh` | 9.2.2 J2b：停機期間每秒 50 張下單的結果（客戶端是 `loadtest/StopDuringLoad`） |
| `scripts/j4-container-flash.sh` | 9.6：容器裡的搶購與 `docker stats` |
| `scripts/j4-spec-matrix.sh` | 9.6.2：三種規格交錯兩次 |
| `scripts/j4b-host-vs-container.sh` | 9.6.3：主機 `java -jar` 與容器交錯 |
| `scripts/j4c-prewarm.sh` | 9.6.4：唯讀暖機 |
| `scripts/j11a-full-scan.sh` | 9.12.1：INV-3 全掃的成本 vs 帳本大小 |
| `scripts/j11e-insert-select-locks.sh` | 9.12.3：`INSERT … SELECT` 的鎖 |

---

## 9.16 常見誤區

**① 「錯誤都在日誌裡了，出事的時候去查就好」**

9.2.1：一行 `OUTBOX_UNROUTABLE` 的 ERROR，從第 07 章起在每一次建置的日誌裡，relay 因此可以永遠卡住，沒有人看到。日誌只有在「有人在看、或有東西在數」的時候才算數。

**② 「測試的替身跟真的一樣」**

`InlineEvents.deliver` 遇到沒有人訂閱的事件，直接標成已送出；真的 relay 一直重送（9.2.1）。替身與本尊不一樣的那個邊角，就是測試永遠看不到的地方。

**③ 「`docker stop` 會等 10 秒」**

這台機器上是 1 秒（9.2.2），來源沒有找到。寬限要寫在部署的設定裡、用 `docker inspect` 確認。在 1 秒的寬限下，shell form 與 exec form 一樣被 KILL。

**④ 「graceful shutdown 讓停機不會掉請求」**

它保護的是處理到一半的請求。送上 keep-alive 舊連線的那幾個，照樣拿不到回應（9.2.2）；讓它們安全的是冪等鍵 —— 那 17 個請求，伺服器一個都沒處理。

**⑤ 「compose 的依賴條件說成功了，就是成功了」**

`migrate` 的命令被 shell 的規則切開，Flyway 印出說明、結束碼 0，應用程式照樣被啟動（9.4.2）。部署的每一步要看它的輸出。

**⑥ 「容器裡的 JVM 會自己決定好 heap」**

不設上限的容器，JVM 以為整台 VM（7.65 GB）都是它的，heap 上限 5.9 GB；設了 1 GB 的上限，預設只給 heap 256 MB（9.6.1）。兩個預設都不是你要的。

**⑦ 「抽樣 10% 表示 90% 的請求沒有 traceId」**

21 個請求、21 個都有（9.8.2）。抽樣決定的是要不要送出 span，不是 MDC 裡有沒有 traceId。

**⑧ 「traceparent 是給內部服務用的，外面的人不會送」**

Boot 3.2 的 Brave 預設照收 `traceparent`、`b3`、`X-B3-*`（9.8.4）。一個在最外層的應用程式，要決定收不收。

**⑨ 「productId 當 tag，就能查前 N 名」**

1 萬個商品就是 1 萬條永遠不會消失的序列，一個計數器 600 KB（9.9.2）。高基數的東西放日誌，指標只放「有幾個」。

**⑩ 「`increase(x[5m]) > 0` 就是『任何一次』」**

第一次發生才註冊的計數器，序列一出現就是 1，`increase()` 算不出來 —— 第一次不會響（9.10.2）。計數器要在啟動時就註冊成 0。

**⑪ 「告警響了，就是出事了」**

只看 5 分鐘窗的「下單變慢」，在 Redis 恢復之後 4 分 23 秒才響、響 31 秒（9.10.5）；消費者延遲的告警，對「消費者停住」是瞎的。每一條告警要拿一次真的事故演練過：它什麼時候響、什麼時候安靜。

**⑫ 「告警規則寫好了，就有人會知道」**

沒有 Alertmanager，告警只出現在 Prometheus 的網頁上（9.10.6）。

**⑬ 「對帳說 0，帳就是對的」**

改得一致的人，對帳看不見（9.2.3）。對帳抓 bug，權限擋住「改得很仔細」的那一種。

**⑭ 「權限可以先給整個資料庫，再扣掉幾張表」**

MySQL 不行（`ERROR 1147`，9.2.3）。只能一張表一張表給，並且用一個測試確認每一張新的表都有人授權（9.11.2）。

**⑮ 「`INSERT … SELECT` 跟 `SELECT` 一樣只是讀」**

它是鎖定讀：會等還沒 commit 的那一列，拿到鎖之後，新的寫入進不來（9.12.3）。

**⑯ 「一秒多的查詢，每小時一次可以接受」**

那一句在 60 萬列時慢 8 倍、在 2,000 萬列時慢 23 倍 —— 它選錯了執行計畫（9.12.2）。「可以接受」之前，先看它在你預期的資料量下是哪一個計畫。

**⑰ 「加了 `@DirtiesContext` 之後全綠，就修好了」**

高峰還是 152 條連線，只是那一次剛好沒出錯（9.14.2）。

---

## 9.17 本章小結

**這一章建立了六件事**：

1. **一個可以部署的東西**（9.3～9.6）：映像檔（分層，改一行搬 1.59 MB）、一個命令起完整的系統、migration 是部署的一個步驟、30 秒的寬限與 graceful、一份有量測在後面的規格（4 CPU、1 GB）。
2. **一個請求，從頭到尾同一個 traceId**（9.8）：HTTP、資料庫、broker、消費者、排程；回應與錯誤回應裡都有；外面帶進來的不收。**Q7 綠了，`Skipped: 0`。**
3. **看得到**（9.7、9.9）：一行一個 JSON 的日誌、管理埠上的指標、0.6.6 缺的那幾個指標。
4. **被叫醒**（9.10）：19 條告警，有單元測試、有「指標存在」的測試、拿真的停機演練過、有人收到（停機之後 87.5 秒）。
5. **改不了歷史**（9.11）：INV-5、稽核只能新增、保留期限變成一個有條件的刪除。
6. **對帳跟得上帳本的大小**（9.12）：增量、水位線留 5 分鐘、每週全掃校正；以及一個慢了 23 倍的執行計畫。

**以及這一章找到的、前幾章留下來的**：relay 被沒有人訂閱的事件永遠卡住（第 07 章起）；一個依賴方法順序的測試（第 08 章）；退款的死信佇列裡躺了 4 天的 3 則；第 07 章 7.10 的「一秒多」是一個錯的執行計畫；第 03 章練習六的 API 文件在正式設定下是公開的。

**第 08 章留下的「沒找到原因」**，這一章回答了一部分：RabbitMQ 恢復之後 outbox 一直長，是 broker 還沒接受連線（閒 4.6～4.9 秒、忙 11.8～13.7 秒；J1a 那一次 ≥ 21 秒，多出來的部分沒有拆開）；「哪一個 Redis 呼叫失敗」，在另一次演練裡留下了一個答案（`ratelimit`，9.6.3）。虛擬執行緒的 13 條連線、完整的 health 10 秒不回答、6.9.2 那 48 個逾時，這一章沒有碰。

**如果這一章只能記一句話**：

> **可觀測性不是「有日誌、有指標」，是「出事的時候，有人在對的時間收到一句對的話」。每一段都要量一次：規則對不對、指標在不在、什麼時候響、誰收到。**

### 9.17.1 驗收清單

做得到才算結束：

- [ ] `git stash` 掉 9.2.1 的 relay 修正（或把 `subscribed.contains` 那一段拿掉），跑 `EventFlowTest#unsubscribedEventsDoNotBlockRelay`，看它紅；說出那 24,831 行 ERROR 是怎麼來的，以及為什麼 `InlineEvents` 看不到它。
- [ ] `docker run --rm eclipse-temurin:21-jre sleep 1000` 起一個容器，`docker inspect -f '{{.Config.StopTimeout}}'`：你的機器上是幾秒？
- [ ] `docker build -t shop .`，改一行程式再建一次，用 `docker history` 指出變了哪一層、多大。
- [ ] `docker compose --profile app up -d --wait`（8080 被佔著就設 `SHOP_HTTP_PORT`），用 `docker compose logs migrate` 確認 migration 真的跑了或「up to date」。
- [ ] 打 `POST /api/orders`，拿回應的 `X-Trace-Id`，在 `docker compose logs app` 裡找到它出現在幾條執行緒上；在資料庫裡找到它在哪一列。
- [ ] 帶一個自己的 `traceparent` 打一次，確認回應的 traceId 不是你給的。
- [ ] `docker/prometheus/test.sh`；把 `alerts_test.yml` 的 ④ 改成期望會響，看它紅，說出為什麼。
- [ ] （compose 要用 `SHOP_HTTP_PORT=18090` 起：腳本的流量寫死打 `localhost:18090`）`scripts/j8b-alert-drill.sh shop-rabbitmq-1 30 150 270 'max(shop_outbox_oldest_age_seconds)'`，記下停機之後第幾秒 firing；`docker compose logs alert-sink` 看收件人什麼時候收到。
- [ ] 用 `shop` 帳號連資料庫，`UPDATE inventory_ledger SET delta_on_hand = 0 LIMIT 1`，看 `ERROR 1142`。
- [ ] `EXPLAIN` 第 07 章那一句 INV-3，指出 `idx_ledger_product`；加上 `IGNORE INDEX` 再 `EXPLAIN` 一次。
- [ ] `SHOP_HTTP_PORT=… scripts/j12-checklist.sh`，每一個 ❌ 與 ⚠️ 說得出原因。
- [ ] `mvn clean verify` 顯示 `Tests run: 201, Failures: 0, Errors: 0, Skipped: 0`、四行 `All coverage checks have been met.`，以及 `TEST_INFRA MySQL 最多同時 … 條連線`。

### 9.17.2 本章練習

**練習一（40 分鐘）：會寫資料的暖機**

9.6.4：唯讀的暖機把新實例的第一輪從 3.2 秒降到 0.7 秒，剩下的是下單專屬的路徑。寫一個在 readiness 之前真的下單的暖機：用一個專用的商品與買家、一個不會被出貨的狀態，暖完之後把它們清掉。它會寫進 outbox、帳、稽核嗎？那些列怎麼處理（INV-5：帳不能刪）？量第一輪的 p99。

**練習二（20 分鐘）：稽核的時間由資料庫決定**

9.11.4：應用程式可以 INSERT 稽核，也就可以自己填 `created_at`。用欄位層級的 INSERT 權限（`GRANT INSERT (actor_id, …) ON audit_logs`）讓它不能填；`AppGrantsTest` 的「每一張表都授權了」要怎麼改（`information_schema.column_privileges`）？`inventory_ledger` 要不要一樣？

**練習三（30 分鐘）：消費者停住的告警**

9.10.5：`ShopConsumerLag` 對「消費者停住」是瞎的。找一個讓消費者停住、但 broker 照常的方法（例如讓某一個消費者的處理卡在一個鎖上），量 `ShopConsumerQueueBacklog` 多久響；1,000 則、5 分鐘的門檻合不合理？

**練習四（30 分鐘）：告警之間的關係**

Redis 停機的時候，`ShopRedisDegraded`、`ShopPlaceOrderSlow`、`ShopHigh5xxRatio`、`ShopLoginLockoutDegraded` 可能一起響。用 Alertmanager 的 `inhibit_rules` 讓「原因」的那一條壓住「症狀」的那幾條，演練一次，看收件人收到幾則。

**練習五（30 分鐘）：MySQL 的 TLS 要驗證**

9.4.3：20 條連線都是 TLS，但 `sslMode=REQUIRED` 不驗證憑證。自己做一個 CA、簽 MySQL 的伺服器憑證，應用程式改成 `VERIFY_IDENTITY`；用一個沒有被那個 CA 簽的伺服器確認它連不上。

**練習六（20 分鐘）：少了秘密時，說對的話**

9.13.2：少了 `SHOP_JWT_SECRET`，訊息是「JWT 金鑰至少 32 bytes」。讓 `UnresolvedPlaceholderCheck` 在任何 `@ConfigurationProperties` 綁定之前執行（例如一個 `EnvironmentPostProcessor`），讓訊息變成「少了環境變數 SHOP_JWT_SECRET」。

**練習七（40 分鐘）：長的請求、graceful 的差別**

9.2.2：每張 20 ms 的下單，量不出 graceful 的好處。改用 90 天的賣家日報表（或一個 365 天的），每秒 20 個，在停機期間比較有沒有 graceful：「處理到一半就斷掉」的有幾個？

**練習八（進階，60 分鐘）：RabbitMQ 恢復的那 21 秒**

9.2.1：忙的時候 `docker start` 之後 11.8～13.7 秒才接受連線，J1a 那一次至少 21 秒。把兩個變數拆開：一樣忙、應用程式不重連（應用程式停著）；不忙、應用程式重連。是哪一個？

**練習九（20 分鐘）：`StopTimeout=1` 是從哪裡來的**

9.2.2：這台機器上每一個新建的容器都是 1 秒，Docker Desktop VM 的 `daemon.json` 裡沒有。找出來（提示：Docker Desktop 的設定、Engine 的版本差異、compose 的預設）。你的機器上是幾秒？

---

## 9.18 專題的終點，與下一站

README 的「驗收標準」第 7 題：「服務半夜掛了，你從哪裡開始查？」這一章之前，答案是「SSH 進去看日誌」—— 而那份日誌裡沒有 traceId、會被下一次部署覆蓋、一個每次都在的 ERROR 沒有人看。現在的答案是：

1. **Alertmanager 叫醒你的那一則**，說的是哪一條規則、從什麼時候開始（`startsAt`）—— 例如 `ShopOutboxBacklog`，最舊的未送出事件已經 1 分 2 秒。
2. **Prometheus**：同一段時間還有哪些告警在響（`ShopRedisDegraded` 先響，就先看 Redis），依賴的三個目標還在不在。
3. **日誌**：使用者回報的錯誤畫面上有 `traceId`，或者從告警的時間窗裡找 ERROR —— 一句查詢找到那一個請求在 HTTP、資料庫、broker、消費者上的每一行。
4. **資料**：對帳的差異、死信佇列、outbox 的積壓 —— 每一個都有一個應該是 0 的數字。

十一題驗收，全部綠燈。這個專題從第 00 章的一份需求文件與 11 個 `@Disabled` 開始，到這裡是一個 201 個測試、一個命令就能起來、出事會叫醒人的模組化單體。

它沒有做的事，第 00 章 0.7 列過，這一章的上線檢查清單又列了一次：備份與高可用、真的金流、多倉庫、部分出貨……以及一件 0.7 第 10 項刻意排除的事：**拆成微服務**。

README 的最後一段寫著：「專題做出來的是一個模組化單體 —— 這對絕大多數團隊來說就是終點，不是中繼站。」如果你想知道把它拆開會發生什麼事，下一站是 13-distributed-systems（選修）：它直接拿這個專案當教材 —— 把庫存切出去、資料庫分家，然後面對拆分之後才會出現的問題。這一章做的事會在那裡變得更重要：一個 traceId 要跨過的不再是一個 broker，而是好幾個服務；9.8.4 那個「外面帶進來的 traceparent 要不要收」，會變成「哪些服務是自己人」。

這一章讓紅燈在正式環境裡被看見。下一站問的是：當系統不只一個行程的時候，「看見」還意味著什麼。
